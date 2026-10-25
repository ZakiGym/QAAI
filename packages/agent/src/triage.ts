/**
 * Triage (§3.3) — classifies every failure CAUSE and explains itself.
 *
 * The product promise here is narrow and important: QAAI never silently
 * self-heals. Triage produces a verdict, a confidence score, and evidence a
 * human can check. What happens next — file a bug, approve a fix, quarantine —
 * is a decision the human makes from that verdict.
 *
 * The failure history matters as much as the failure. A test that has failed on
 * this step three times this week at the same time of day is a different
 * animal from one that has passed a hundred times and just broke.
 *
 * ─── What changed: once per CAUSE, not once per result ──────────────────────
 *
 * This module used to be called once per failing test result. A dependency
 * that takes out 200 tests therefore spent 200 model calls and produced 200
 * independently-worded verdicts for one cause — and 200 agreeing verdicts read
 * like 200 pieces of evidence when they are one, restated. The clusterer that
 * already knew they were one thing (apps/api/src/lib/cluster.ts) was read-only
 * and ran in the cockpit, after the money had been spent.
 *
 * Nothing about the classification changed. What changed is the UNIT: the
 * caller (apps/worker/src/processors/triage.ts) now clusters the run's failures
 * first and calls this once per cluster, passing `cluster` so the prompt knows
 * it is judging a cause with N members rather than one unlucky test. Cluster
 * size is real evidence — "twenty independent tests each got unlucky in the
 * same place in the same minute" stops being the simple explanation — and the
 * prompt is told to use it that way.
 *
 * ─── What the project's own corrections are allowed to do ───────────────────
 *
 * `TriageVerdict.overriddenTo` carries a comment saying the override "is what
 * gates and what trains prompts". Nothing read it, so every project re-made the
 * same wrong call forever. It is now read back as `corrections` and rendered as
 * EVIDENCE: "this project has overruled FLAKE to REAL_BUG 6 times on
 * /checkout". Three rules keep that from turning into a rule the model cannot
 * disagree with, because an override history is a PRIOR and not a verdict:
 *
 *   · It is rendered under a heading that says so, with an explicit instruction
 *     that the current evidence outranks it.
 *   · It is BOUNDED and RECENT (CORRECTION_HISTORY_DAYS /
 *     CORRECTION_HISTORY_MAX_ROWS). A project's whole audit log pasted into a
 *     prompt stops being a prior and becomes the prompt.
 *   · Below CORRECTION_HISTORY_MIN_REVIEWS it is omitted and SAID to be
 *     omitted. Three reviews is a mood, not a prior, and quoting it as one
 *     would launder a coincidence into a pattern.
 */

import { createHash } from 'node:crypto';
import { triageVerdictSchema, VERDICTS } from '@qaai/shared';
import type { StepResult, TestExecution, TriageVerdict, Verdict } from '@qaai/shared';
import type { CallContext, LlmService } from './llm.js';

const SYSTEM = `You are the Triage agent inside QAAI, an AI QA engineer.

A test failed. Classify why, in exactly one of four ways:

  REAL_BUG         the application is wrong. A user hitting this path would be
                   harmed: wrong money, wrong data, a broken flow, a leak.
  INTENDED_CHANGE  the application changed on purpose and the test is now stale.
                   A renamed button, a moved element, a reworded label.
  FLAKE            the test is unreliable, not the app. Timing, ordering, shared
                   state, a race. Passing on retry is strong evidence for this.
  ENV_ISSUE        the environment failed. The app never loaded, DNS died, a
                   dependency was down, the test compiled wrong, auth expired.

How to decide, in priority order:

1. If the failure is an assertion about a *value* — a total, a count, a status,
   a permission — and the app produced a different value than the arithmetic or
   the rule requires, that is REAL_BUG. Wrong money is never a flake.
2. If the failure is "locator not found" or "expected text X, got Y" where Y is
   a plausible new copy for the same element, lean INTENDED_CHANGE.
3. If the test passed on retry, or the error mentions timeouts, detachment, or
   navigation races, lean FLAKE — but not if the underlying assertion was about
   a value that was simply wrong.
4. If the app returned 5xx, the page never loaded, or the spec failed to
   compile, that is ENV_ISSUE.

Confidence is a real number, not decoration. Use below 0.7 when the evidence
genuinely supports more than one verdict, and say so in the explanation. A
confidently wrong verdict costs a team more than an honest uncertain one.

Cite concrete evidence. Every evidence entry points at something in the input:
a step index, a network entry, a console line, a history fact, a diff hunk.
Do not assert anything the input does not show.

ONE CAUSE, MANY TESTS

You are sometimes shown a FAILURE CLUSTER: several tests whose failures
normalise to the same signature, which means the same thing broke. Your verdict
covers all of them, so judge the CAUSE and not the one sample test.

Cluster size is evidence a single test cannot give you, and it cuts one way:
twenty independent tests do not each get unlucky in the same place in the same
minute. A large cluster of timeouts or passing retries is a shared dependency
that stopped answering (ENV_ISSUE), not twenty flakes. A small cluster of the
same is still plausibly FLAKE. A wrong VALUE is a REAL_BUG at any size — rule 1
above is not weakened by how many tests saw it.

If the cluster's members would genuinely not share your verdict — the sample
looks like a real bug but you can see the signature would also catch a stale
selector — say so in the explanation and drop your confidence. A reviewer can
split a member out of a cluster, and your saying which member bothers you is
what tells them to.

WHAT THE PROJECT'S REVIEW HISTORY IS FOR

You may be shown how often humans have overruled verdicts like this one on this
project. That is a PRIOR, not an answer. It tells you which way this project's
failures have tended to break, and it is evidence about the project rather than
about this failure. Where the evidence in front of you points the other way,
follow the evidence and say that you are doing so. A history that cannot be
disagreed with is not evidence, it is an instruction, and you were not given
one.`;

export interface TriageInput {
  testName: string;
  testCode: string;
  execution: TestExecution;
  /** Flake radar context (§5). */
  history: {
    totalRuns: number;
    failures: number;
    flakeRatePercent: number;
    lastPassedAt: string | null;
    /** True when previous failures were on the same step index. */
    sameStepRepeatedly: boolean;
  };
  /** Present when the repo is connected. */
  recentCommits?: Array<{ sha: string; author: string; message: string; files: string[] }>;
  /** The app's own diff for the suspect range, when available. */
  diff?: string;
  /**
   * The cause this verdict will cover, when the caller triaged a CLUSTER rather
   * than a lone result. Absent means a genuine singleton — one failure, one
   * verdict — and the prompt then says nothing about clusters at all rather than
   * printing "1 test" and inviting the model to reason about a group of one.
   */
  cluster?: TriageClusterContext;
  /**
   * What this cause's identity already knows: when it was first seen, and
   * whether it is new in this build. Absent means the identity has not been
   * recorded yet, which is a different fact from "new" and is rendered as such.
   */
  cause?: TriageCauseContext;
  /**
   * The project's own correction history, already summarised and bounded by
   * `summariseCorrections`. A prior, never a rule — see the module header.
   */
  corrections?: CorrectionSummary;
}

/**
 * The cause, as the caller's clusterer sees it.
 *
 * `memberNames` is capped by the renderer rather than by the caller so there is
 * one place that decides how much of a 200-test outage reaches the prompt.
 */
export interface TriageClusterContext {
  clusterKey: string;
  /** `labelFor()`'s sentence — what a person would call this cause. */
  label: string;
  signature: string;
  /** Failing results in this run that share the signature. Includes the sample. */
  memberCount: number;
  memberNames: readonly string[];
  /** Members whose first attempt failed and whose retry passed (§5). */
  retriedAndPassed: number;
}

export interface TriageCauseContext {
  firstSeenAt: string;
  lastSeenAt: string;
  /** Distinct runs this cause has appeared in, including this one. */
  runsSeen: number;
  /**
   * True only when this run is the run that minted the identity. The caller
   * answers it from an equality (`FailureSignature.firstSeenRunId = runId`), so
   * it is a fact and not a window heuristic.
   */
  newInThisBuild: boolean;
}

function renderSteps(steps: StepResult[]): string {
  if (steps.length === 0) return '  (the test recorded no steps)';
  return steps
    .map((step) => {
      const head = `  [${step.index}] ${step.status} (${step.durationMs}ms) ${step.title}`;
      if (!step.error) return head;
      return [
        head,
        `        error:    ${step.error.message.split('\n')[0]}`,
        step.error.expected ? `        expected: ${step.error.expected}` : null,
        step.error.actual ? `        actual:   ${step.error.actual}` : null,
        step.error.selector ? `        locator:  ${step.error.selector}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

// ─── The cause key ───────────────────────────────────────────────────────────

/**
 * The identity of a failure cause, from its signature. ONE implementation.
 *
 * `signatureOf()` in apps/api/src/lib/cluster.ts has always produced a stable,
 * legible signature for a cause, and the cockpit has always shown the first 12
 * hex of its sha1 as the cluster's id. That hash lived in a private helper, so
 * the moment anything else needed to store a cause — a persisted identity, a
 * mute, a per-run claim — it had to re-derive it, and two derivations of one
 * key drift the day somebody changes a slice length.
 *
 * So the hash is here, in the package both the worker and the API depend on,
 * and apps/api/src/routes/clusters.test.ts asserts this function against the
 * clusterer's own `cluster.id` over a corpus of real failure text. If the two
 * ever disagree, that test goes red instead of the cockpit quietly linking to a
 * cause that does not exist.
 *
 * sha1 and 12 hex because that is what the existing ids ARE; this function
 * cannot pick a better hash without orphaning every key already stored and
 * every link already shared. 48 bits of key is a birthday collision at roughly
 * 2e7 distinct causes in one project, which no suite reaches.
 *
 * Not in @qaai/shared deliberately: that package's barrel is consumed by the
 * web app's bundler, and `node:crypto` in it breaks the build. See the comment
 * at the top of packages/shared/src/index.ts.
 */
export function failureClusterKey(signature: string): string {
  return createHash('sha1').update(signature).digest('hex').slice(0, 12);
}

// ─── Mute policy ─────────────────────────────────────────────────────────────

/**
 * How long a mute may last, in days.
 *
 * MUTING FOREVER IS THE QUARANTINE MISTAKE. A suppression with no end date is a
 * deletion nobody signed: the person who set it has moved on, the reason has
 * rotted, and the only evidence it was ever a decision is a row no screen
 * shows. `Test.quarantineExpiresAt` exists because this product already made
 * that mistake once.
 *
 * Fourteen days, the same number as QUARANTINE_MAX_DAYS, and for the same
 * reason rather than for symmetry: a mute is the sentence "we know, and we are
 * not fixing it this sprint". A sprint is one to two weeks, so fourteen days
 * outlives the decision by at most one sprint boundary — long enough that
 * nobody is re-muting a known issue every morning, short enough that the
 * decision is re-made by the people who still remember making it.
 *
 * The expiry is not the only brake, and it is the weaker one. The strong brake
 * is that a mute is keyed on the SIGNATURE: change the cause and the signature
 * changes with it, so a mute cannot swallow a failure nobody has inspected.
 * Quarantine, keyed on a test, can and does.
 */
export const MUTE_MAX_DAYS = 14;

const DAY_MS = 86_400_000;

/**
 * The expiry to stamp on a mute, clamped. `days` is what the caller asked for;
 * anything above MUTE_MAX_DAYS is brought back to it and anything at or below
 * zero is refused by returning null, because "mute for -1 days" is a bug in the
 * caller and a mute stamped in the past is a mute that reads as expired the
 * instant it is written.
 */
export function muteExpiryFrom(now: Date, days: number): Date | null {
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(now.getTime() + Math.min(days, MUTE_MAX_DAYS) * DAY_MS);
}

/**
 * Is a suppression actually in force?
 *
 * Asked at exactly two sites — the worker before it mints a verdict and the API
 * before it reports a cause as muted — so that an expired mute cannot behave
 * like a live one at one of them. A null `mutedUntil` is NOT "muted forever":
 * it is "not muted", which is the only reading that keeps the forever case
 * unreachable by construction.
 */
export function muteInForce(
  signature: { mutedUntil: Date | null } | null | undefined,
  now: Date,
): boolean {
  if (!signature?.mutedUntil) return false;
  return signature.mutedUntil.getTime() > now.getTime();
}

// ─── The project's own corrections ───────────────────────────────────────────

/**
 * A verdict a human reviewed, in the shape the summary needs.
 *
 * `overriddenTo` is null for an ACCEPTED verdict, which is why both fields are
 * here: an acceptance is evidence the model was RIGHT, and a summary that
 * counted only the overrides would tell the model it is wrong 100% of the time
 * on every project that has ever corrected it once.
 */
export interface CorrectionRow {
  verdict: Verdict;
  overriddenTo: Verdict | null;
  reviewState: 'PENDING' | 'ACCEPTED' | 'OVERRIDDEN' | 'MUTED';
  reviewedAt: Date | null;
  /** Where it happened, for the "6 times on /checkout" half of the sentence. */
  where: string | null;
}

/** One from→to correction and how often this project has made it. */
export interface CorrectionPattern {
  from: Verdict;
  to: Verdict;
  count: number;
  /** Up to three distinct places, so the pattern is checkable rather than asserted. */
  where: string[];
}

export interface CorrectionSummary {
  /** Reviewed verdicts the summary was computed from. */
  reviewed: number;
  accepted: number;
  overridden: number;
  /** Null when `reviewed` is 0 — unmeasured, not 0%. */
  overrideRatePercent: number | null;
  patterns: CorrectionPattern[];
  /** The window, so the prompt can state what it is summarising. */
  sinceDays: number;
  /**
   * Set when there were too few reviews to be a prior. The renderer prints this
   * sentence INSTEAD of the numbers: a summary that quietly disappeared would
   * leave the reader unable to tell "no history" from "history withheld".
   */
  tooFew: string | null;
}

/**
 * Below this many reviewed verdicts, the history is not rendered as a prior.
 *
 * Three reviews is a mood. Quoting it as a pattern launders a coincidence into
 * evidence, and the model has no way to discount it — it cannot see the
 * denominator unless we print it, and if we print "overruled 2 of 3" it will
 * reasonably treat that as 67%.
 */
export const CORRECTION_HISTORY_MIN_REVIEWS = 8;

/** How many distinct from→to patterns reach the prompt, biggest first. */
export const CORRECTION_HISTORY_MAX_ROWS = 6;

/**
 * How far back corrections are read.
 *
 * Thirty days because a prior should describe the app as it is now. A project
 * that spent February overruling FLAKE on a flaky checkout, fixed it in March,
 * and still has that prior in April is being told something false about itself.
 */
export const CORRECTION_HISTORY_DAYS = 30;

/**
 * Turns raw reviewed verdicts into the bounded prior the prompt may see.
 *
 * Pure, and deliberately separate from the query that feeds it: the shape of
 * the prior is a product decision worth testing on its own, and the caller's
 * `where` clause is a database decision. PENDING rows are dropped — an
 * unreviewed verdict is not an opinion — and so is a MUTED one, because muting
 * says "do not page me about this", not "the verdict was wrong".
 */
export function summariseCorrections(
  rows: readonly CorrectionRow[],
  options: { sinceDays?: number } = {},
): CorrectionSummary {
  const sinceDays = options.sinceDays ?? CORRECTION_HISTORY_DAYS;
  const reviewed = rows.filter((r) => r.reviewState === 'ACCEPTED' || r.reviewState === 'OVERRIDDEN');
  const accepted = reviewed.filter((r) => r.reviewState === 'ACCEPTED').length;

  /*
   * An OVERRIDDEN row whose `overriddenTo` is null is a contradiction the
   * database permits (the column is nullable and the review endpoint nulls it
   * on every non-override action). It is counted in `overridden` — a human did
   * disagree — and excluded from the patterns, because "overruled FLAKE to
   * nothing" is not a sentence that helps anyone.
   */
  const corrections = reviewed.filter(
    (r): r is CorrectionRow & { overriddenTo: Verdict } =>
      r.reviewState === 'OVERRIDDEN' && r.overriddenTo !== null && r.overriddenTo !== r.verdict,
  );

  const byPair = new Map<string, CorrectionPattern>();
  for (const row of corrections) {
    const key = `${row.verdict}->${row.overriddenTo}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.count += 1;
      if (row.where && existing.where.length < 3 && !existing.where.includes(row.where)) {
        existing.where.push(row.where);
      }
      continue;
    }
    byPair.set(key, {
      from: row.verdict,
      to: row.overriddenTo,
      count: 1,
      where: row.where ? [row.where] : [],
    });
  }

  const patterns = [...byPair.values()]
    .sort((a, b) => b.count - a.count || `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`))
    .slice(0, CORRECTION_HISTORY_MAX_ROWS);

  const overridden = reviewed.length - accepted;
  const tooFew =
    reviewed.length >= CORRECTION_HISTORY_MIN_REVIEWS
      ? null
      : `${reviewed.length} reviewed verdict${reviewed.length === 1 ? '' : 's'} in the last ${sinceDays} days — too few to be a prior, so no history is quoted.`;

  return {
    reviewed: reviewed.length,
    accepted,
    overridden,
    overrideRatePercent: reviewed.length === 0 ? null : (overridden / reviewed.length) * 100,
    /*
     * BLANKED below the floor, in the DATA and not only in the renderer.
     * `tooFew` is a promise that no history is quoted, and a summary that kept
     * the patterns while setting that flag would be one careless consumer away
     * from breaking it — the counts stay, because they are the denominator that
     * justifies the refusal and nobody can mistake "2 reviewed" for a pattern.
     */
    patterns: tooFew ? [] : patterns,
    sinceDays,
    tooFew,
  };
}

/**
 * The prior, as prose, under a heading that says what it is.
 *
 * Exported for its test: the one thing that must not regress here is the
 * framing. A future edit that drops the "evidence about the project, not about
 * this failure" line turns a prior into an instruction, and the only way to
 * notice is to assert on the rendered text.
 */
export function renderCorrectionHistory(summary: CorrectionSummary): string {
  if (summary.tooFew) {
    return `THIS PROJECT'S REVIEW HISTORY\n  ${summary.tooFew}`;
  }

  const rate = summary.overrideRatePercent;
  const lines = [
    "THIS PROJECT'S REVIEW HISTORY (evidence about the project, not about this failure)",
    `  Reviewed in the last ${summary.sinceDays} days: ${summary.reviewed}`,
    `  Accepted: ${summary.accepted}   Overruled: ${summary.overridden}${
      rate === null ? '' : ` (${rate.toFixed(0)}%)`
    }`,
  ];

  if (summary.patterns.length === 0) {
    lines.push('  No repeated correction — reviewers have agreed with the verdict so far.');
  } else {
    for (const p of summary.patterns) {
      const where = p.where.length ? ` (${p.where.join(', ')})` : '';
      lines.push(
        `  Overruled ${p.from} to ${p.to} ${p.count} time${p.count === 1 ? '' : 's'}${where}`,
      );
    }
  }

  lines.push(
    '  This is a prior. Where the evidence above points the other way, follow the',
    '  evidence and say in the explanation that you are disagreeing with the history.',
  );
  return lines.join('\n');
}

/** The cluster, as prose. Returns null for a singleton — see TriageInput. */
function renderCluster(cluster: TriageClusterContext | undefined): string | null {
  if (!cluster || cluster.memberCount <= 1) return null;
  const shown = cluster.memberNames.slice(0, 12);
  const rest = cluster.memberCount - shown.length;
  return [
    'FAILURE CLUSTER — your verdict covers every test below',
    `  cause:             ${cluster.label}`,
    `  tests sharing it:  ${cluster.memberCount}`,
    `  passed on retry:   ${cluster.retriedAndPassed} of ${cluster.memberCount}`,
    `  signature:         ${cluster.signature}`,
    ...shown.map((name) => `    - ${name}`),
    ...(rest > 0 ? [`    … and ${rest} more`] : []),
  ].join('\n');
}

/** What this cause's identity already knows. Null when nothing recorded it. */
function renderCause(cause: TriageCauseContext | undefined): string | null {
  if (!cause) return null;
  return [
    'THIS CAUSE',
    cause.newInThisBuild
      ? '  FIRST SEEN IN THIS BUILD. Nothing before this run produced this signature.'
      : `  Seen before: first on ${cause.firstSeenAt}, across ${cause.runsSeen} runs, most recently ${cause.lastSeenAt}.`,
  ].join('\n');
}

// ─── Attaching one verdict to a whole cluster ────────────────────────────────

/**
 * The verdict to store on a member that did NOT pay for a model call.
 *
 * The classification is copied verbatim — that is the point, one answer per
 * cause — but two things are deliberately NOT copied as if they were
 * first-hand:
 *
 *  · `model` is prefixed `cluster:`. A reader, a cost ledger and an A/B on
 *    prompt changes all need to know this row is a copy; without the prefix the
 *    ledger would report 200 calls to the cheap model that never happened.
 *  · the evidence gains one entry naming the result the call actually examined.
 *    Every other evidence entry points at the OWNER's steps and network, and a
 *    reader following "step 3" into this member's trace would be looking at the
 *    wrong test. Saying so is cheaper than pretending otherwise.
 *
 * Confidence is copied unchanged. Inflating it because twenty tests agree would
 * be double-counting the cluster size the model was already shown, and
 * discounting it would be inventing a penalty no evidence supports.
 *
 * NO MEMBER COUNT IN THE SENTENCE, deliberately. A count written here is the
 * count at the instant this member attached, and the cluster keeps growing as
 * the run finishes — so the number would be stale on the row that quoted it and
 * different on the row beside it. The live count is
 * `RunFailureCluster.members`, which the cockpit reads.
 */
export function deriveClusterVerdict(
  owner: TriageVerdict,
  context: { clusterKey: string; label: string; ownerTestName: string },
): TriageVerdict {
  return {
    ...owner,
    model: owner.model.startsWith('cluster:') ? owner.model : `cluster:${owner.model}`,
    evidence: [
      ...owner.evidence,
      {
        kind: 'HISTORY' as const,
        ref: `cluster:${context.clusterKey}`,
        detail:
          `This verdict was reached once for the cause "${context.label}" and attached to every ` +
          'failure in this run that shares its signature. The evidence above was read from ' +
          `"${context.ownerTestName}", not from this test. If it does not fit this test, re-triage ` +
          'this result on its own to split it out of the cluster.',
      },
    ],
  };
}

// ─── The accuracy scorecard ──────────────────────────────────────────────────

/** One (verdict, reviewState) tally, as a groupBy returns it. */
export interface VerdictStateTally {
  verdict: Verdict;
  reviewState: 'PENDING' | 'ACCEPTED' | 'OVERRIDDEN' | 'MUTED';
  count: number;
}

/** One (verdict, overriddenTo) tally — what humans changed it TO. */
export interface VerdictCorrectionTally {
  verdict: Verdict;
  overriddenTo: Verdict | null;
  count: number;
}

export interface VerdictAccuracyRow {
  verdict: Verdict;
  /** Verdicts of this kind the model produced in the window. */
  minted: number;
  /** Of those, how many a human actually looked at. */
  reviewed: number;
  accepted: number;
  overridden: number;
  muted: number;
  pending: number;
  /**
   * NULL WHEN NOTHING WAS REVIEWED. Not 0 — "this verdict has never been wrong"
   * and "nobody has ever checked this verdict" are opposite facts, and a
   * scorecard that prints 0% for the second is the most expensive kind of
   * dishonest number: it reads as a pass.
   */
  overrideRatePercent: number | null;
  /** Where the overrides went, biggest first. */
  correctedTo: Array<{ to: Verdict; count: number }>;
  /** One sentence a person can read without the table. */
  sentence: string;
}

export interface TriageAccuracy {
  rows: VerdictAccuracyRow[];
  totals: {
    minted: number;
    reviewed: number;
    accepted: number;
    overridden: number;
    muted: number;
    pending: number;
    overrideRatePercent: number | null;
    /** The share of verdicts a human ever looked at — the honesty denominator. */
    reviewCoveragePercent: number | null;
  };
  /** What the numbers do and do not cover, in words, for the top of the screen. */
  caveat: string;
}

function pct(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : (numerator / denominator) * 100;
}

/**
 * How often humans overrule each kind of verdict.
 *
 * Pure arithmetic over two tallies, so the endpoint stays a query and this stays
 * testable. Every verdict kind appears in the output even when the project has
 * never produced one — a missing row reads as "fine" and an explicit zero reads
 * as what it is.
 *
 * The one number this must never fake is the rate. `overrideRatePercent` is
 * null whenever nothing was reviewed, and the sentence says "nobody has
 * reviewed one" rather than "0% overruled".
 */
export function triageAccuracy(
  states: readonly VerdictStateTally[],
  corrections: readonly VerdictCorrectionTally[],
  options: { windowDays?: number } = {},
): TriageAccuracy {
  const rows: VerdictAccuracyRow[] = VERDICTS.map((verdict) => {
    const mine = states.filter((s) => s.verdict === verdict);
    const of = (state: VerdictStateTally['reviewState']): number =>
      mine.filter((s) => s.reviewState === state).reduce((sum, s) => sum + s.count, 0);

    const accepted = of('ACCEPTED');
    const overridden = of('OVERRIDDEN');
    const muted = of('MUTED');
    const pending = of('PENDING');
    const minted = accepted + overridden + muted + pending;
    /*
     * MUTED is not counted as a review. "Stop paging me about this" is a
     * statement about noise, not about whether the classification was right,
     * and folding it into `accepted` would let a team drive its apparent
     * accuracy up by muting everything.
     */
    const reviewed = accepted + overridden;

    const correctedTo = corrections
      .filter((c) => c.verdict === verdict && c.overriddenTo !== null && c.overriddenTo !== verdict)
      .map((c) => ({ to: c.overriddenTo as Verdict, count: c.count }))
      .sort((a, b) => b.count - a.count || a.to.localeCompare(b.to));

    const rate = pct(overridden, reviewed);
    const sentence =
      minted === 0
        ? `No ${verdict} verdict was reached in this window.`
        : reviewed === 0
          ? `${minted} ${verdict} verdict${minted === 1 ? '' : 's'}, and nobody has reviewed one — accuracy is unmeasured, not good.`
          : `Humans overruled ${overridden} of the ${reviewed} ${verdict} verdict${reviewed === 1 ? '' : 's'} they reviewed (${rate!.toFixed(0)}%)${
              correctedTo.length ? `, most often to ${correctedTo[0]!.to}` : ''
            }.`;

    return {
      verdict,
      minted,
      reviewed,
      accepted,
      overridden,
      muted,
      pending,
      overrideRatePercent: rate,
      correctedTo,
      sentence,
    };
  });

  const sum = (pick: (r: VerdictAccuracyRow) => number): number =>
    rows.reduce((total, row) => total + pick(row), 0);

  const minted = sum((r) => r.minted);
  const reviewed = sum((r) => r.reviewed);
  const overridden = sum((r) => r.overridden);

  return {
    rows,
    totals: {
      minted,
      reviewed,
      accepted: sum((r) => r.accepted),
      overridden,
      muted: sum((r) => r.muted),
      pending: sum((r) => r.pending),
      overrideRatePercent: pct(overridden, reviewed),
      reviewCoveragePercent: pct(reviewed, minted),
    },
    caveat:
      `Counted over ${options.windowDays ?? CORRECTION_HISTORY_DAYS} days. The rate is over verdicts a human REVIEWED, ` +
      'not over all of them, so a project that reviews little has a loud rate on a thin sample — ' +
      'reviewCoveragePercent is how thin. Muted verdicts are not counted as reviews: muting says ' +
      'do not page me, not the verdict was right.',
  };
}

/**
 * The cause columns on a verdict a model just produced, in the state they are
 * genuinely in at this point.
 *
 * `derivedFromId: null` is the one that matters and it is TRUE here: a model
 * read this result itself, so this verdict is first-hand evidence. A reader
 * who cannot tell a first-hand verdict from a copy reads 200 copies of one
 * model call as 200 pieces of evidence.
 *
 * `clusterKey` is null because the clusterer has not run — the WORKER assigns
 * it when it claims the cause — and inventing one here would be this function
 * naming a cause it cannot see. `revision: 1` is the first answer, never 0.
 * Nothing has been split out of anything.
 */
const FIRST_HAND = {
  clusterKey: null,
  derivedFromId: null,
  revision: 1,
  splitFromClusterKey: null,
} as const;

export async function triageFailure(
  llm: LlmService,
  ctx: CallContext,
  input: TriageInput,
): Promise<TriageVerdict> {
  const { execution, history } = input;

  const network = execution.network
    .filter((n) => n.status === null || n.status >= 400)
    .slice(0, 15)
    .map((n) => `  ${n.method} ${n.url} -> ${n.status ?? 'no response'} (${n.durationMs}ms)`)
    .join('\n');

  const consoleErrors = execution.console
    .filter((c) => c.level === 'error' || c.level === 'warn')
    .slice(0, 15)
    .map((c) => `  [${c.level}] ${c.text.slice(0, 300)}`)
    .join('\n');

  const commits = input.recentCommits
    ?.slice(0, 10)
    .map(
      (c) =>
        `  ${c.sha.slice(0, 8)} ${c.author}: ${c.message.split('\n')[0]}\n      ${c.files.slice(0, 8).join(', ')}`,
    )
    .join('\n');

  /*
   * The cause context goes ABOVE the sample failure, deliberately. What the
   * model is being asked to judge is the cluster; the sample is how it reads the
   * cluster. Putting "this covers 200 tests" after 6kB of one test's stack is
   * how a model ends up classifying the sample.
   */
  const clusterBlock = renderCluster(input.cluster);
  const causeBlock = renderCause(input.cause);
  const correctionsBlock = input.corrections
    ? renderCorrectionHistory(input.corrections)
    : null;

  const prompt = `${[clusterBlock, causeBlock].filter(Boolean).join('\n\n')}${
    clusterBlock || causeBlock ? '\n\n' : ''
  }${clusterBlock ? 'THE SAMPLE FAILURE' : 'FAILED TEST'}: ${input.testName}
  status:            ${execution.status}
  duration:          ${execution.durationMs}ms
  passed on retry:   ${execution.retriedAndPassed ? 'YES' : 'no'}
  top-level error:   ${execution.errorMessage ?? '(none — failure was inside a step)'}

STEPS
${renderSteps(execution.steps)}

FAILED NETWORK REQUESTS
${network || '  (none)'}

CONSOLE
${consoleErrors || '  (nothing at warn or above)'}

FINDINGS
${
  execution.findings.length
    ? execution.findings
        .slice(0, 10)
        .map((f) => `  [${f.severity}] ${f.kind} ${f.code}: ${f.message} @ ${f.location}`)
        .join('\n')
    : '  (none)'
}

HISTORY FOR THIS TEST
  runs:              ${history.totalRuns}
  failures:          ${history.failures}
  flake rate:        ${history.flakeRatePercent.toFixed(1)}%
  last passed:       ${history.lastPassedAt ?? 'never'}
  same step failing: ${history.sameStepRepeatedly ? 'yes' : 'no'}

${commits ? `RECENT COMMITS\n${commits}\n` : ''}${
    input.diff ? `DIFF\n${input.diff.slice(0, 6000)}\n` : ''
  }${correctionsBlock ? `${correctionsBlock}\n\n` : ''}
TEST SOURCE
${input.testCode.slice(0, 6000)}

Classify ${
    input.cluster && input.cluster.memberCount > 1
      ? `this cause. Your verdict will be attached to all ${input.cluster.memberCount} failures that share its signature`
      : 'this failure'
  }. If a commit above plausibly caused it, name it in suspectCommit; otherwise
set suspectCommit to null. Do not guess a commit just because one exists.`;

  // Cheap model first: most failures are unambiguous, and triage runs on every
  // failing test of every run. The escalation below catches the hard ones.
  const first = await llm.structured(ctx, {
    tier: 'cheap',
    effort: 'medium',
    system: SYSTEM,
    prompt,
    schema: triageVerdictSchema,
    schemaName: 'TriageVerdict',
    maxTokens: 4000,
    cacheSystem: true,
  });

  if (first.confidence >= 0.75) {
    return { ...FIRST_HAND, ...first, model: 'cheap' };
  }

  // Ambiguous: re-run on the strong model and keep whichever is more confident.
  // The spec routes ambiguous verdicts to the strong model precisely because a
  // wrong REAL_BUG wastes an engineer's morning.
  const second = await llm.structured(ctx, {
    tier: 'strong',
    effort: 'high',
    system: SYSTEM,
    prompt: `${prompt}

A first pass was uncertain (${first.verdict}, confidence ${first.confidence.toFixed(2)}):
${first.explanation}

Re-examine the evidence and give your own verdict. Disagreeing is fine.`,
    schema: triageVerdictSchema,
    schemaName: 'TriageVerdict',
    maxTokens: 6000,
    cacheSystem: true,
  });

  return { ...FIRST_HAND, ...second, model: 'strong' };
}
