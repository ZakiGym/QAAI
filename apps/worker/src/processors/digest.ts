/**
 * The nightly digest (§7) — "here is what your suite did overnight".
 *
 * Schedules already decide when to run and integrations already decide where to
 * send, and between them there was nothing that summarised. A team with a
 * nightly suite therefore got one chat message per failing run, at 3am, with a
 * count in it — which is either ignored or, worse, skimmed. The thing a person
 * actually needs at 9am is one message that answers three questions in order:
 *
 *   what broke that was not broken yesterday   (new failures)
 *   what is unreliable                          (flakes)
 *   what got better                             (fixed)
 *
 * That order is the whole design. New failures first because they are the only
 * part that is news; fixed last because it is the part that is nice to know.
 *
 * ── A digest with nothing to say is not sent ────────────────────────────────
 *
 * A daily "all clear" is the fastest way to teach people that this channel can
 * be ignored, and once that is learned the message that matters is ignored too.
 * So silence is a feature — but silence is also how a broken pipeline hides, so
 * it is bounded very deliberately:
 *
 *   • Every decision to stay quiet is logged with the counts that produced it.
 *     A suppression nobody can audit is a suppression nobody should trust.
 *   • "No runs at all" is NOT nothing to say. If a schedule was due and the
 *     window contains no run, the digest says so — a suite that silently stopped
 *     running is the single most dangerous state this product has, because the
 *     dashboard stays green while nothing is being tested.
 *   • Anything unknown is reported rather than dropped. Where the history needed
 *     to call a failure "new" is missing, it is reported as new: the failure
 *     mode of this file must be saying too much, never too little.
 *
 * ── Delivery ────────────────────────────────────────────────────────────────
 *
 * Same destinations as `notify.ts`: the org's enabled chat integrations, one
 * POST each, one WebhookDelivery row per attempt so "why didn't I get the
 * digest" has an answer. Two deliberate differences from that processor, both
 * narrowing:
 *
 *   1. Every provider's host is PINNED (see `webhookHost`). An integration whose
 *      URL points somewhere else is skipped with a sentence saying so, rather
 *      than posting a summary of a customer's test suite to whatever host was in
 *      the config row.
 *   2. Generic WEBHOOK integrations are skipped, not signed and sent. Signing
 *      means unsealing a secret and posting to a host that cannot be pinned, and
 *      that is a security decision worth making on purpose rather than
 *      inheriting. The skip says what to do instead.
 */

import { CronExpressionParser } from 'cron-parser';
/*
 * The scope key and the ONE comparability predicate.
 *
 * `deltaIsMeaningful` is imported rather than written as
 * `comparability === 'COMPARABLE'` here for the reason the coverage block in
 * `renderDigest` gives: four surfaces print this delta and the first one that
 * answers the question for itself is the one that tells a whole team their
 * coverage fell when it was our own enumeration that moved.
 */
import {
  HEADLINE_SCOPE_KEY,
  UNATTRIBUTED_FEATURE,
  UNOWNED_TEAM,
  deltaIsMeaningful,
} from '@qaai/shared';
import type { SnapshotComparability } from '@qaai/shared';
/*
 * The ONE suppression summariser. This file's opening line is "a suppression
 * nobody can audit is a suppression nobody should trust", and a digest with its
 * own idea of how to phrase "47 failures by 3 known issues" would be the second
 * phrasing of the one sentence every surface is supposed to say identically.
 */
import { summariseSuppressions } from '@qaai/shared';
import type { SuppressionKind, SuppressionSummary } from '@qaai/shared';
import { logger, prisma } from '../context.js';
import { open as openSecret } from '../vault.js';
// Pure modules from the API workspace — types and functions, no Prisma and no
// Express — imported rather than copied for the same reason bisect.ts is. The
// alternative is a second implementation of "is this a real failure", and two
// answers to that question is how the gate and the digest come to disagree.
import { isRealFailure } from '../../../api/src/lib/run-selection.js';
/*
 * `OWNERSHIP_RULE_SELECT` and `ownerLabel` rather than a hand-written field
 * list and a hand-written `@${slug}`. This file had its own copy of both, and
 * both are the kind of copy that fails silently: a select that forgets
 * `position` resolves last-match-wins against a column that is always 0 (so
 * every failure routes to the FIRST matching rule instead of the last), and a
 * label spelled differently here than in the ticket reads as two owners to the
 * person skimming both.
 */
import { OWNERSHIP_RULE_SELECT, assignOwner, ownerLabel } from '../../../api/src/lib/ownership.js';
import type {
  OwnershipRuleInput,
  OwnershipState,
} from '../../../api/src/lib/ownership.js';
// Same rule for the chat credential envelope and the notification preference:
// the API seals and writes them, notify.ts and this file read them, and all
// three must agree on the shape.
import {
  decodeChatCredentials,
  integrationAad,
  parseChatConfig,
  webhookHostAllowed,
} from '../../../api/src/lib/chat-integrations.js';

/** How far back a first-ever digest looks, and the ceiling on catching up. */
const DEFAULT_WINDOW_MS = 24 * 60 * 60_000;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * Result rows read per digest.
 *
 * A cap rather than a full scan because one project's 4000-test nightly must not
 * hold the tick open for everyone else's. Hitting it is reported in the message
 * itself — a truncated digest that does not say it was truncated is a digest
 * that lies about a quiet suite.
 */
const MAX_RESULTS = 5_000;

/** Lines per section in the message. Past this it stops being readable. */
const MAX_LISTED = 8;

/** Chat platforms cap a message; stay well under the smallest of them. */
const MAX_MESSAGE_CHARS = 3_500;

const REQUEST_TIMEOUT_MS = 15_000;

// ─── What a digest contains ──────────────────────────────────────────────────

export interface DigestItem {
  testId: string;
  name: string;
  filePath: string;
  /** The run this was last seen in, so the message can link to the evidence. */
  runId: string;
  /** Triage's call, when triage has spoken. Null is normal and says so. */
  verdict: string | null;
  /** "@payments", "Dana Klein", or null — an unowned test is a normal state. */
  owner: string | null;
  /**
   * WHICH KIND of nobody, when `owner` is null.
   *
   * `owner: null` alone cannot tell "ownership is not configured" (expected)
   * from "a rule that should have matched can no longer be evaluated, so
   * routing has silently stopped" (the dangerous one). The digest used to
   * simply omit the label for all of them, which made the two indistinguishable
   * on the one surface a human reads every morning.
   *
   * NULL means NOT RESOLVED — ownership was never asked about this item.
   * `fixed` items are in that state deliberately: resolving for a test that
   * went green is work nobody reads. It is not the same as NO_RULES.
   */
  ownerState: OwnershipState | null;
  /** Flakes only: how many times it needed a retry inside the window. */
  retries?: number;
}

export interface Digest {
  projectId: string;
  projectName: string;
  since: Date;
  until: Date;
  runs: { total: number; red: number };
  newFailures: DigestItem[];
  flakes: DigestItem[];
  fixed: DigestItem[];
  /** Failing before the window and still failing. A count, not a list — not news. */
  stillFailing: number;
  /** Schedules that were due inside the window and produced no run at all. */
  silentSchedules: string[];
  /** How many of the new failures reached nobody. */
  unowned: number;
  truncated: boolean;
  /**
   * THE COVERAGE LINE. Null means NOT MEASURED, and never 0%.
   *
   * `grep -n coverage` in this file returned nothing before this field, which
   * means the one sentence this company has was absent from the only message
   * most of a team ever reads about their test suite. A digest that reports
   * three new failures and says nothing about the 38% of the application
   * nothing has ever asserted anything about is a digest that makes the larger
   * fact invisible every morning.
   *
   * ── IT DOES NOT MAKE THE DIGEST SPEAK ──────────────────────────────────────
   *
   * Deliberately NOT part of `hasSomethingToSay`. A window full of passing runs
   * must stay quiet, and "your coverage is still 61%" is not news — it is the
   * same number as yesterday, and a daily message that always has something in
   * it is a daily message nobody opens. So coverage rides ALONG with a digest
   * that was already going to be sent, and the day nothing happened the
   * coverage line is not a reason to send one.
   */
  coverage: DigestCoverage | null;
  /**
   * WHAT WENT QUIET, AND WHY — counted, by kind, for the window.
   *
   * THE DEFECT THIS CLOSES: a digest listing three new failures while a known
   * issue silenced forty is a digest that makes the larger fact invisible every
   * morning, and this is the message most of a team ever reads about their
   * suite. "A suppression nobody can audit is a suppression nobody should
   * trust" is this file's own opening line; until this field existed the file
   * could not say the sentence.
   *
   * NEVER NULL, because `summariseSuppressions` reports zero OUT LOUD
   * ("Nothing was suppressed."). A surface that renders nothing when nothing
   * was suppressed is indistinguishable from one that forgot to ask.
   *
   * ── IT DOES NOT MAKE THE DIGEST SPEAK ─────────────────────────────────────
   *
   * Like `coverage`, and for a sharper reason: a mute that is working silences
   * failures every single day, so letting it into `hasSomethingToSay` would
   * turn a quiet window into a daily message about a decision somebody already
   * made — and a daily message that always has something in it is one nobody
   * opens. It rides along with a digest that was going to be sent anyway. The
   * EXPIRY is the part somebody must act on, and that is the expiry sweep's job
   * (it has an owner for every row); here it is reported, not alerted.
   */
  suppressions: SuppressionSummary;
}

/**
 * The coverage facts a digest states, and the comparability of its delta.
 *
 * The same four facts the check-run summary carries, for the same reason: a
 * figure, a rung, a delta that is NULL unless the two snapshots are comparable,
 * and the single most useful rollup. Not the same TYPE, because this file
 * cannot import from apps/api — and the duplication is named in this round's
 * handover rather than solved by reaching across a boundary that does not
 * exist.
 */
export interface DigestCoverage {
  /** The headline. NULL when there was nothing to divide. Never 0, never 100. */
  percent: number | null;
  denominator: number;
  /** The rung the figure is taken at, so it is comparable to anything at all. */
  tier: string;
  /** Change in percentage points, or NULL when the two are not comparable. */
  deltaPercent: number | null;
  comparability: string;
  comparabilityDetail: string | null;
  /** One rollup, not a table. A chat message has about four lines of attention. */
  rollup: { label: string; percent: number | null; denominator: number } | null;
}

/**
 * The suppression rule, in one function so it can be read and argued with.
 *
 * Note what is NOT here: the number of runs, and whether they were green. A
 * window full of passing runs is exactly the case that must stay quiet.
 */
export function hasSomethingToSay(digest: Digest): boolean {
  return (
    digest.newFailures.length > 0 ||
    digest.flakes.length > 0 ||
    digest.fixed.length > 0 ||
    digest.silentSchedules.length > 0
  );
}

// ─── Building one ────────────────────────────────────────────────────────────

interface ResultRow {
  runId: string;
  testId: string;
  status: string;
  retriedAndPassed: boolean;
  createdAt: Date;
  test: {
    id: string;
    name: string;
    filePath: string;
    suiteId: string | null;
    feature: string | null;
    quarantined: boolean;
  };
  verdict: { verdict: string; overriddenTo: string | null } | null;
}

function failed(row: ResultRow): boolean {
  return isRealFailure({
    status: row.status,
    retriedAndPassed: row.retriedAndPassed,
    quarantined: row.test.quarantined,
  });
}

function flaked(row: ResultRow): boolean {
  return row.status === 'FLAKY' || row.retriedAndPassed;
}

/** A clean pass: not a retry that happened to succeed (§5). */
function passed(row: ResultRow): boolean {
  return row.status === 'PASSED' && !row.retriedAndPassed;
}

export async function collectDigest(
  subscription: { orgId: string; projectId: string },
  since: Date,
  until: Date,
): Promise<Digest | null> {
  const { orgId, projectId } = subscription;

  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId },
    select: { id: true, name: true, archivedAt: true },
  });
  // An archived project has no news by definition, and a deleted one has no
  // subscription to honour.
  if (!project || project.archivedAt) return null;

  const runs = await prisma.run.findMany({
    where: { orgId, projectId, finishedAt: { gt: since, lte: until } },
    select: { id: true, status: true, finishedAt: true },
  });

  /*
   * ── THE SUPPRESSION LEDGER FOR THE WINDOW ─────────────────────────────────
   *
   * Scoped to THIS WINDOW'S RUNS and not to a date range on the ledger itself.
   * `SuppressionEvent.createdAt` is when the row was written, which is almost
   * always the same instant — but a finaliser that was redelivered the next
   * morning would file a row dated outside the window it belongs to, and the
   * digest would then attribute a suppression to the wrong day. The run ids are
   * the window.
   *
   * FOLDED HERE rather than by `groupBy`, for the reason the run finaliser
   * records: `suppressions` is DISTINCT suppressing rows, and a group-by with
   * `_count` would report three mutes as three when they silenced one cause
   * each and as one when one mute silenced three causes. The headline is "47
   * failures by 3 known issues", so the second number has to be distinct
   * `sourceId`s and Prisma cannot count distinct inside a group-by.
   */
  const ledger =
    runs.length === 0
      ? []
      : await prisma.suppressionEvent.findMany({
          where: { orgId, runId: { in: runs.map((run) => run.id) } },
          take: MAX_RESULTS,
          select: { kind: true, sourceId: true, suppressed: true, inForce: true },
        });
  /*
   * Keyed by the UNION and not by `string`, so no cast is needed below.
   * `SuppressionEvent.kind` is a Postgres enum and Prisma types it as the
   * union already; a `as SuppressionKind` on the way out of a string-keyed map
   * would be an unchecked claim at the one place a new kind should become a
   * compile error.
   */
  const byKind = new Map<
    SuppressionKind,
    { suppressed: number; live: Set<string>; dead: Set<string> }
  >();
  for (const row of ledger) {
    const tally = byKind.get(row.kind) ?? { suppressed: 0, live: new Set(), dead: new Set() };
    tally.suppressed += row.suppressed;
    // `sourceId` is nullable; a row with none still counts as ONE suppression
    // identified by nothing, rather than being dropped from the count.
    (row.inForce ? tally.live : tally.dead).add(row.sourceId ?? `<unidentified:${row.kind}>`);
    byKind.set(row.kind, tally);
  }
  const suppressions = summariseSuppressions(
    [...byKind.entries()].map(([kind, tally]) => ({
      kind,
      suppressions: tally.live.size,
      suppressed: tally.suppressed,
      expired: tally.dead.size,
    })),
  );

  const results = (await prisma.testResult.findMany({
    where: { orgId, runId: { in: runs.map((run) => run.id) } },
    orderBy: { createdAt: 'asc' },
    take: MAX_RESULTS,
    select: {
      runId: true,
      testId: true,
      status: true,
      retriedAndPassed: true,
      createdAt: true,
      test: {
        select: {
          id: true,
          name: true,
          filePath: true,
          suiteId: true,
          feature: true,
          quarantined: true,
        },
      },
      verdict: { select: { verdict: true, overriddenTo: true } },
    },
  })) as ResultRow[];

  // The last thing each test did in the window. Ordered ascending above, so the
  // last write wins — which is what "how did it end up" means.
  const latest = new Map<string, ResultRow>();
  const retriesByTest = new Map<string, number>();
  for (const row of results) {
    if (row.status !== 'SKIPPED') latest.set(row.testId, row);
    if (flaked(row)) retriesByTest.set(row.testId, (retriesByTest.get(row.testId) ?? 0) + 1);
  }

  const failingNow = [...latest.values()].filter(failed);
  const passingNow = [...latest.values()].filter(passed);

  const priors = await priorOutcomes(
    orgId,
    [...failingNow, ...passingNow].map((row) => row.testId),
    since,
  );

  /*
   * Was this failing before the window?
   *
   * `undefined` means the lookup could not see far enough back (see
   * `priorOutcomes`), and it is deliberately treated as "was not failing", which
   * files the test under NEW. That is the direction this whole file errs in: a
   * failure reported as newer than it is costs someone a second look, while one
   * quietly folded into a count nobody reads costs a release.
   */
  const wasFailing = (testId: string): boolean => priors.get(testId) === 'FAILED';

  const newFailures = failingNow.filter((row) => !wasFailing(row.testId));
  const stillFailing = failingNow.length - newFailures.length;
  const fixed = passingNow.filter((row) => wasFailing(row.testId));
  const flakes = [...latest.values()].filter(
    (row) => (retriesByTest.get(row.testId) ?? 0) > 0 && !failed(row),
  );

  const owners = await ownersFor(
    orgId,
    projectId,
    // Only what gets listed needs an owner; resolving for the whole suite would
    // be work nobody reads.
    [...newFailures, ...flakes].map((row) => row.test),
  );

  const item = (row: ResultRow): DigestItem => {
    const resolution = owners.get(row.testId);
    return {
      testId: row.testId,
      name: row.test.name,
      filePath: row.test.filePath,
      runId: row.runId,
      verdict: row.verdict?.overriddenTo ?? row.verdict?.verdict ?? null,
      owner: resolution?.label ?? null,
      // Absent from the map means ownership was not resolved for this item at
      // all — see `DigestItem.ownerState`. Not NO_RULES, which is a finding.
      ownerState: resolution?.state ?? null,
    };
  };

  return {
    projectId: project.id,
    projectName: project.name,
    since,
    until,
    runs: { total: runs.length, red: runs.filter((run) => run.status !== 'PASSED').length },
    suppressions,
    // Real bugs before environment noise, then alphabetical so two consecutive
    // digests list the same failure in the same place.
    newFailures: newFailures.sort(byVerdictThenName).map(item),
    flakes: flakes
      .sort((a, b) => (retriesByTest.get(b.testId) ?? 0) - (retriesByTest.get(a.testId) ?? 0))
      .map((row) => ({ ...item(row), retries: retriesByTest.get(row.testId) ?? 0 })),
    fixed: fixed.sort((a, b) => a.test.name.localeCompare(b.test.name)).map(item),
    stillFailing,
    silentSchedules: await silentSchedules(orgId, projectId, runs.length, until),
    unowned: newFailures.filter((row) => !owners.get(row.testId)?.label).length,
    truncated: results.length >= MAX_RESULTS,
    coverage: await digestCoverage(projectId),
  };
}

/**
 * The coverage line, from the stored snapshot and the stored history row.
 *
 * ── READ, NEVER COMPUTED ───────────────────────────────────────────────────
 *
 * Both the figure and the delta are read. Computing the figure here would mean
 * a second implementation of a percentage this product has exactly one of, and
 * computing the DELTA here would mean subtracting whichever two percentages are
 * closest to hand — which always succeeds, and is wrong whenever the crawl moved
 * between the two. `snapshotDelta` made that decision at write time against the
 * two snapshots' crawl fingerprints and denominator definitions, and this reads
 * its answer.
 *
 * ── NULL IS "NOT MEASURED", AND THAT IS THREE DIFFERENT FACTS ──────────────
 *
 * No snapshot, or a read that failed. Both render as the words "not measured"
 * with the reason, and neither renders as a number. They are collapsed to one
 * null here rather than kept apart, which is a deliberate limit: the digest has
 * one line for this and "nothing has been measured" is the sentence a reader
 * acts on either way. The AUTHENTICATED surfaces keep them apart —
 * `GET /badges/coverage/:projectId` has NOT_MEASURED and UNAVAILABLE as
 * separate states, because there the distinction changes whose problem it is.
 */
async function digestCoverage(projectId: string): Promise<DigestCoverage | null> {
  try {
    const snapshot = await prisma.coverageSnapshot.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, percent: true, denominator: true },
    });
    if (snapshot === null) return null;

    const [history, rollup] = await Promise.all([
      prisma.coverageHistory.findFirst({
        where: { projectId, scopeKey: HEADLINE_SCOPE_KEY },
        orderBy: { createdAt: 'desc' },
        select: { deltaPercent: true, comparability: true, comparabilityDetail: true },
      }),
      /*
       * THE SINGLE MOST USEFUL ROLLUP: the largest bucket that is NOT the
       * headline. One, not a table, because a chat message has about four lines
       * of attention and a fifteen-row breakdown in it is a breakdown nobody
       * reads. Largest by DENOMINATOR and not by percentage: a ranking by
       * percentage would put the smallest bucket first and read as "your worst
       * feature", which it is not.
       */
      prisma.coverageRollup.findFirst({
        where: { snapshotId: snapshot.id, scopeKey: { not: HEADLINE_SCOPE_KEY } },
        orderBy: [{ denominator: 'desc' }, { scopeKey: 'asc' }],
        select: { feature: true, teamId: true, percent: true, denominator: true },
      }),
    ]);

    return {
      percent: snapshot.percent,
      denominator: snapshot.denominator,
      tier: 'ASSERTED',
      deltaPercent: history?.deltaPercent ?? null,
      comparability: history?.comparability ?? 'NOT_COMPARED',
      comparabilityDetail: history?.comparabilityDetail ?? null,
      rollup:
        rollup === null
          ? null
          : {
              /*
               * The sentinels are spelled out as the FINDING they are.
               * "UNATTRIBUTED" in a chat message is jargon; "surface no feature
               * could be attributed to" is the sentence a reader acts on — and
               * an unowned or unattributed bucket being the LARGEST one is the
               * single most useful thing this line can say.
               */
              label:
                rollup.feature === UNATTRIBUTED_FEATURE
                  ? 'surface no feature could be attributed to'
                  : rollup.teamId === UNOWNED_TEAM
                    ? 'surface nobody owns'
                    : (rollup.feature ?? rollup.teamId ?? 'one scope'),
              percent: rollup.percent,
              denominator: rollup.denominator,
            },
    };
  } catch {
    /*
     * The tables do not exist on this deployment (the migration is written and
     * unapplied). NULL, which renders as "not measured" — never as a figure,
     * and never as a reason to send a digest that had nothing else to say.
     */
    return null;
  }
}

const VERDICT_ORDER: Record<string, number> = {
  REAL_BUG: 0,
  INTENDED_CHANGE: 1,
  FLAKE: 2,
  ENV_ISSUE: 3,
};

function byVerdictThenName(a: ResultRow, b: ResultRow): number {
  const rank = (row: ResultRow): number => {
    const verdict = row.verdict?.overriddenTo ?? row.verdict?.verdict;
    // An untriaged failure sorts with the real bugs, not after them. Nobody has
    // ruled it out yet, and burying it under four triaged ones is how the one
    // failure that needed a human ends up below the fold.
    return verdict ? (VERDICT_ORDER[verdict] ?? 4) : 0;
  };
  return rank(a) - rank(b) || a.test.name.localeCompare(b.test.name);
}

/**
 * What each test last did BEFORE the window.
 *
 * One query with a window of `tests × 4` rows rather than one query per test.
 * Results are written a whole run at a time, so walking back by `createdAt desc`
 * moves run by run and the window lands on roughly the last four runs — the same
 * approximation the shard packer makes, for the same reason (Prisma cannot limit
 * per group without raw SQL).
 *
 * Its failure mode is the reason it is safe: a test that has not run in those
 * four runs comes back `undefined`, and the caller reads `undefined` as "was not
 * failing", which lists the test as a NEW failure. The approximation can
 * therefore make the digest say more, never less.
 */
async function priorOutcomes(
  orgId: string,
  testIds: string[],
  before: Date,
): Promise<Map<string, 'FAILED' | 'PASSED'>> {
  const outcomes = new Map<string, 'FAILED' | 'PASSED'>();
  if (testIds.length === 0) return outcomes;

  const rows = (await prisma.testResult.findMany({
    where: {
      orgId,
      testId: { in: testIds },
      createdAt: { lt: before },
      // A placeholder row for a test that never executed says nothing about
      // whether it was passing.
      status: { not: 'SKIPPED' },
    },
    orderBy: { createdAt: 'desc' },
    take: testIds.length * 4,
    select: {
      testId: true,
      status: true,
      retriedAndPassed: true,
      test: { select: { quarantined: true } },
    },
  })) as Array<{
    testId: string;
    status: string;
    retriedAndPassed: boolean;
    test: { quarantined: boolean };
  }>;

  for (const row of rows) {
    // Descending, so the first row seen for a test is its most recent.
    if (outcomes.has(row.testId)) continue;
    outcomes.set(
      row.testId,
      isRealFailure({
        status: row.status,
        retriedAndPassed: row.retriedAndPassed,
        quarantined: row.test.quarantined,
      })
        ? 'FAILED'
        : 'PASSED',
    );
  }
  return outcomes;
}

/**
 * Which schedules were due in this window and produced nothing.
 *
 * This is the section that justifies waking people up. Everything else in the
 * digest is about tests failing; this one is about tests not running, which no
 * screen in the product shows and no alert fires on — a disabled worker, an
 * unparseable cron, a suite emptied by a bad selector all look like a quiet
 * night from every other angle.
 */
async function silentSchedules(
  orgId: string,
  projectId: string,
  runsInWindow: number,
  until: Date,
): Promise<string[]> {
  if (runsInWindow > 0) return [];

  const schedules = await prisma.schedule.findMany({
    where: { orgId, projectId, enabled: true },
    select: { name: true, nextRunAt: true, lastRunAt: true },
  });

  /*
   * `nextRunAt` in the past is the tell.
   *
   * The scheduler advances `nextRunAt` BEFORE it enqueues, so a schedule that
   * fired always points at a future time. One still pointing at a past time was
   * due and nothing picked it up — which, together with a window that contains
   * no runs at all, is a scheduler that has stopped. A schedule armed but not
   * yet due (future `nextRunAt`) is not silent, and is excluded.
   */
  return schedules
    .filter((schedule) => schedule.nextRunAt !== null && schedule.nextRunAt <= until)
    .map((schedule) => schedule.name);
}

/** What ownership resolved to for one test: the label, and which kind of nobody. */
export interface DigestOwner {
  label: string | null;
  state: OwnershipState;
}

/**
 * Who owns each listed test — a LABEL and a STATE, never a bare label.
 *
 * Two queries, never one per test. The state comes along because `null` on its
 * own is three different facts (nobody configured ownership / rules exist and
 * none match / a rule can no longer be evaluated and routing has stopped), and
 * the morning digest is the one surface where telling them apart changes what
 * somebody does next.
 *
 * `assignOwner` rather than `resolveOwnership` directly: it is the function
 * that refuses to return a bare null, and it is the same one the notify
 * processor and the filing endpoint route through, so the digest's answer and
 * the ticket's answer come from one place.
 */
async function ownersFor(
  orgId: string,
  projectId: string,
  tests: Array<{ id: string; filePath: string; suiteId: string | null; feature: string | null }>,
): Promise<Map<string, DigestOwner>> {
  const owners = new Map<string, DigestOwner>();
  if (tests.length === 0) return owners;

  const rules = (await prisma.ownershipRule.findMany({
    where: { orgId, projectId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    // The shared select. A copy that forgot `position` would resolve
    // last-match-wins against a column that is always 0.
    select: OWNERSHIP_RULE_SELECT,
  })) as OwnershipRuleInput[];

  const assignments = tests.map((test) => ({ test, assignment: assignOwner(test, rules) }));

  const userIds: string[] = [];
  const teamIds: string[] = [];
  for (const { assignment } of assignments) {
    const owner = assignment.owner;
    if (!owner) continue;
    if (owner.kind === 'USER') userIds.push(owner.userId);
    else teamIds.push(owner.teamId);
  }

  const [users, teams] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({
          where: { id: { in: [...new Set(userIds)] } },
          select: { id: true, name: true, email: true },
        })
      : Promise.resolve([]),
    teamIds.length
      ? prisma.team.findMany({
          where: { orgId, id: { in: [...new Set(teamIds)] } },
          select: { id: true, slug: true },
        })
      : Promise.resolve([]),
  ]);
  const directory = {
    users: new Map(users.map((user) => [user.id, user])),
    teams: new Map(teams.map((team) => [team.id, team])),
  };

  for (const { test, assignment } of assignments) {
    owners.set(test.id, {
      // `ownerLabel`, which is also what the chat alert and the ticket print.
      // A row whose user or team is gone used to produce NO label here while
      // the state still said OWNED — an owned failure rendering as unowned.
      label: assignment.owner ? ownerLabel(assignment.owner, directory) : null,
      state: assignment.state,
    });
  }

  // Rules that could not be evaluated are logged rather than dropped: routing
  // that has silently stopped looks exactly like a suite nobody has assigned.
  // Now also stated on the LINE, via RULES_UNUSABLE — see `unownedPhrase`.
  const broken = new Map<string, string>();
  for (const { assignment } of assignments) {
    for (const skipped of assignment.unusable) broken.set(skipped.ruleId, skipped.reason);
  }
  if (broken.size > 0) {
    logger.warn(
      { projectId, rules: [...broken.keys()] },
      'ownership rules could not be evaluated; those failures are being reported unowned',
    );
  }

  return owners;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * What an unowned item says about itself, per state — and the two deliberate
 * silences.
 *
 * NO_RULES is silent because ownership is opt-in: a line reading "nobody owns
 * this" under every failure in an install that never filled the table in is how
 * a digest gets filtered to a folder, and then the RULES_UNUSABLE line is
 * filtered with it. Not-resolved is silent for the same reason it exists —
 * nothing was asked, so nothing is claimed.
 *
 * RULES_UNUSABLE is the whole reason this map is not just `item.owner ?? ''`.
 * It was logged on the worker and NOWHERE a human looks: a team that believes
 * it is being paged and is not reads an identical digest to a team that never
 * configured anything.
 */
const UNOWNED_PHRASE: Record<OwnershipState, string | null> = {
  // Unreachable: `ownerLabel` always returns a string, down to "a deleted
  // team", so an OWNED item always has a label to print instead.
  OWNED: null,
  NO_RULES: null,
  NO_MATCH: 'nobody owns this',
  RULES_UNUSABLE: 'unowned — an ownership rule could not be evaluated, so routing may have stopped',
};

/** The owner clause on a digest line: a name, a named kind of nobody, or nothing. */
function ownerSuffix(item: DigestItem): string {
  if (item.owner) return ` — ${item.owner}`;
  const phrase = item.ownerState ? UNOWNED_PHRASE[item.ownerState] : null;
  return phrase ? ` — ${phrase}` : '';
}

/**
 * Plain text, and deliberately no bold.
 *
 * Slack wants `*bold*`, Discord and Teams want `**bold**`, and one message goes
 * to all three — so any emphasis syntax is guaranteed to render as literal
 * asterisks somewhere. Emoji, indentation and blank lines survive everywhere,
 * so those carry the structure instead.
 */
export function renderDigest(digest: Digest, webUrl: string): string {
  const hours = Math.round((digest.until.getTime() - digest.since.getTime()) / 3_600_000);
  const lines: string[] = [
    `📋 QAAI digest — ${digest.projectName}`,
    `Last ${hours}h · ${digest.runs.total} run${digest.runs.total === 1 ? '' : 's'}, ${digest.runs.red} red`,
  ];

  if (digest.silentSchedules.length > 0) {
    lines.push(
      '',
      `⚠️ No runs at all in this window, and ${digest.silentSchedules.length} schedule(s) were due: ${digest.silentSchedules.join(', ')}.`,
      'Nothing has been tested since the last digest — the dashboard is green because it is empty.',
    );
  }

  const section = (icon: string, title: string, items: DigestItem[], detail: (i: DigestItem) => string) => {
    if (items.length === 0) return;
    lines.push('', `${icon} ${title} (${items.length})`);
    for (const item of items.slice(0, MAX_LISTED)) {
      lines.push(`  • ${item.name}${ownerSuffix(item)}`);
      lines.push(`    ${detail(item)}`);
    }
    if (items.length > MAX_LISTED) lines.push(`  …and ${items.length - MAX_LISTED} more`);
  };

  section('🔴', 'New failures', digest.newFailures, (item) =>
    [item.verdict ? VERDICT_PHRASE[item.verdict] ?? item.verdict : 'not triaged yet', item.filePath]
      .filter(Boolean)
      .join(' · '),
  );

  section('🎲', 'Flaky', digest.flakes, (item) =>
    `passed only on retry${item.retries && item.retries > 1 ? ` ×${item.retries}` : ''} · ${item.filePath}`,
  );

  section('✅', 'Fixed', digest.fixed, (item) => item.filePath);

  /*
   * ── THE COVERAGE LINE, ABOVE THE FOOTNOTES AND BELOW THE FAILURES ─────────
   *
   * Above the footnotes because it is a headline fact and not a caveat; below
   * the failures because a red test somebody can fix this morning outranks a
   * standing figure. The three states are three BRANCHES — "not measured", "no
   * comparable baseline", and the figure with its delta — because the first one
   * rendered as `0%` is this product's own lie arriving in a team's chat
   * channel every morning, where nobody re-reads it after the first time they
   * have believed it.
   */
  if (digest.coverage === null) {
    lines.push(
      '',
      '📐 Coverage: not measured. No snapshot has been stored for this project, so there is no ' +
        'figure — this is not 0%, and it is not a statement about your application.',
    );
  } else {
    const coverage = digest.coverage;
    const figure =
      coverage.percent === null
        ? 'not measured (the denominator was zero — nothing was enumerated to count)'
        : `${coverage.percent.toFixed(1)}% of ${coverage.denominator} surface item(s) at ${coverage.tier}`;
    /*
     * `deltaIsMeaningful` and not a string comparison: four surfaces print this
     * delta and the first one that decides for itself what counts as comparable
     * is the one that reports a regression nobody caused. Two snapshots taken
     * against different crawls measured different applications.
     */
    const change = deltaIsMeaningful(coverage.comparability as SnapshotComparability)
      ? coverage.deltaPercent === null
        ? ''
        : ` (${coverage.deltaPercent >= 0 ? '+' : ''}${coverage.deltaPercent.toFixed(1)} points)`
      : ` — no comparable baseline: ${coverage.comparabilityDetail ?? 'the two snapshots are not comparable'}`;
    lines.push('', `📐 Coverage: ${figure}${change}`);
    if (coverage.rollup) {
      lines.push(
        `  • ${coverage.rollup.label}: ${
          coverage.rollup.percent === null ? 'not measured' : `${coverage.rollup.percent.toFixed(1)}%`
        } of ${coverage.rollup.denominator}`,
      );
    }
  }

  const footnotes: string[] = [];
  if (digest.stillFailing > 0) {
    footnotes.push(
      `${digest.stillFailing} test(s) were already failing before this window and still are.`,
    );
  }
  if (digest.unowned > 0 && digest.newFailures.length > 0) {
    // Said plainly, because an unowned failure is the one that sits for a week.
    footnotes.push(`${digest.unowned} of the new failures have no owner.`);
  }
  /*
   * THE SENTENCE THAT KEEPS THIS HONEST: "47 failures by 3 known issues."
   *
   * Only when something was actually suppressed or has expired —
   * `summariseSuppressions` says "Nothing was suppressed." out loud and that
   * belongs in the API's own answer, where a reader can tell it apart from a
   * surface that forgot to ask. In a chat message that a team reads every
   * morning, a line saying nothing happened every morning is a line they stop
   * reading, which is how the ones that DO matter get skipped too.
   */
  if (digest.suppressions.suppressed > 0 || digest.suppressions.expired > 0) {
    footnotes.push(`Suppressed in this window: ${digest.suppressions.disclosure}`);
  }
  if (digest.truncated) {
    footnotes.push(
      `This window held more than ${MAX_RESULTS} results, so the digest read only the first ${MAX_RESULTS}.`,
    );
  }
  if (footnotes.length > 0) lines.push('', ...footnotes);

  lines.push('', `${webUrl}/projects/${digest.projectId}`);

  const text = lines.join('\n');
  return text.length <= MAX_MESSAGE_CHARS
    ? text
    : `${text.slice(0, MAX_MESSAGE_CHARS - 40)}\n…truncated by QAAI.`;
}

const VERDICT_PHRASE: Record<string, string> = {
  REAL_BUG: '🐞 likely a real bug',
  INTENDED_CHANGE: '🔁 an intended change',
  FLAKE: '🎲 a flake',
  ENV_ISSUE: '🌐 an environment issue',
};

// ─── Delivery ────────────────────────────────────────────────────────────────

/**
 * The host each provider's incoming webhooks actually live on.
 *
 * Pinned per provider, never read from the config row. The URL on an Integration
 * is editable by an org admin, and the body being posted here is a summary of a
 * customer's test suite — what broke, in which files. A config row must be able
 * to choose the PATH (that is the webhook token) and never the host.
 */
export function isPinnedHost(kind: string, hostname: string): boolean {
  // The list itself lives in @qaai/shared (notifications.ts) — ONE list for
  // the API's write-time validation, notify's send-time check and this one.
  // The name is kept exported here because this file is where the pinning
  // decision is explained.
  return webhookHostAllowed(kind, hostname);
}

interface Destination {
  id: string;
  kind: string;
  url: string;
}

/** A destination that will not be used, and the sentence explaining why. */
interface SkippedDestination {
  id: string;
  kind: string;
  reason: string;
}

/**
 * One candidate destination, as `destinationsFor` prepares it: the URL already
 * unsealed from the vault (or the sentence saying why it could not be), and
 * the integration's own digest preference already read. This function stays
 * pure — decryption happens in the caller — so the decision table it encodes
 * is testable without key material.
 */
export interface DigestCandidate {
  id: string;
  kind: string;
  /** The unsealed webhook URL, or null when there is none to send to. */
  url: string | null;
  /** Why `url` is null, when the reason is worth a sentence of its own. */
  urlProblem?: string | null;
  /** The integration's `notify.digest` preference (§7). */
  digest: boolean;
}

export function partitionDestinations(candidates: DigestCandidate[]): {
  deliverable: Destination[];
  skipped: SkippedDestination[];
} {
  const deliverable: Destination[] = [];
  const skipped: SkippedDestination[] = [];

  for (const candidate of candidates) {
    /*
     * The org-scoped preference first: an integration whose `notify.digest` is
     * false asked not to hear this, and that outranks every question about
     * whether it COULD. Skipped loudly like everything else here — a
     * preference someone forgot they set looks exactly like a broken feature.
     */
    if (!candidate.digest) {
      skipped.push({
        id: candidate.id,
        kind: candidate.kind,
        reason:
          'This integration has opted out of the digest in its notification preference.',
      });
      continue;
    }

    if (candidate.kind === 'WEBHOOK') {
      /*
       * Deliberately not supported yet, and skipped loudly rather than silently.
       *
       * A generic webhook is signed with a secret from the vault and posted to a
       * host that by definition cannot be pinned. That is a security decision
       * worth making on purpose — with the SSRF guard in issues.ts around it —
       * rather than one this feature inherits by reusing a code path.
       */
      skipped.push({
        id: candidate.id,
        kind: candidate.kind,
        reason:
          'Generic webhooks do not receive the digest. Point the digest at a Slack, Teams or Discord integration.',
      });
      continue;
    }

    if (!candidate.url) {
      skipped.push({
        id: candidate.id,
        kind: candidate.kind,
        reason: candidate.urlProblem || 'This integration has no webhook URL configured.',
      });
      continue;
    }

    let url: URL;
    try {
      url = new URL(candidate.url);
    } catch {
      // Never echoes the URL: a webhook URL IS the credential, and this is
      // exactly where a malformed one carrying a token would be logged.
      skipped.push({
        id: candidate.id,
        kind: candidate.kind,
        reason: 'The webhook URL on this integration could not be parsed.',
      });
      continue;
    }

    if (url.protocol !== 'https:') {
      skipped.push({
        id: candidate.id,
        kind: candidate.kind,
        reason: 'The webhook URL must be https — the digest describes your test suite.',
      });
      continue;
    }
    if (!isPinnedHost(candidate.kind, url.hostname)) {
      skipped.push({
        id: candidate.id,
        kind: candidate.kind,
        reason: `${url.hostname.replace(/\.+$/, '')} is not a ${candidate.kind} webhook host, so nothing was sent to it. Re-copy the incoming-webhook URL from ${candidate.kind}.`,
      });
      continue;
    }

    deliverable.push({ id: candidate.id, kind: candidate.kind, url: candidate.url });
  }

  return { deliverable, skipped };
}

/**
 * Read the org's chat integrations into DigestCandidates: preference read,
 * URL unsealed. The unseal happens only for kinds the digest can actually use
 * — decrypting a WEBHOOK row's credentials just to skip it would be unsealing
 * a secret on a path that never sends, the exact move this file refuses.
 */
export function candidateFor(
  orgId: string,
  integration: { id: string; kind: string; config: unknown; configEnc: string | null },
): DigestCandidate {
  const config = parseChatConfig(integration.config);
  const base = {
    id: integration.id,
    kind: integration.kind,
    digest: config.notify.digest,
  };

  if (!config.notify.digest || integration.kind === 'WEBHOOK') return { ...base, url: null };
  if (!integration.configEnc) return { ...base, url: null };

  try {
    return {
      ...base,
      url: decodeChatCredentials(
        openSecret(integration.configEnc, config.keyVersion, orgId, integrationAad(integration.id)),
      ).url,
    };
  } catch {
    return {
      ...base,
      url: null,
      urlProblem:
        'The stored webhook URL could not be decrypted — re-enter it on the integration.',
    };
  }
}

/**
 * POST the digest to every usable destination. Returns how many accepted it.
 *
 * Every attempt becomes a WebhookDelivery row, successful or not — a
 * notification that silently failed is indistinguishable from one that was never
 * sent, and "why didn't I get the digest" deserves an answer that is not a
 * shrug. The same contract notify.ts holds itself to.
 */
async function deliver(
  orgId: string,
  destinations: Destination[],
  text: string,
): Promise<number> {
  let delivered = 0;

  for (const destination of destinations) {
    // Teams wants `text`, Discord wants `content`, Slack accepts `text`.
    const body =
      destination.kind === 'DISCORD' ? JSON.stringify({ content: text }) : JSON.stringify({ text });

    let status: number | null = null;
    let error: string | null = null;

    try {
      const response = await fetch(destination.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'qaai' },
        body,
        // A 3xx is an error, not a hop. Following one would re-post the body —
        // and the webhook token in the URL — to whatever Location named.
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = response.status;
      if (response.status >= 300 && response.status < 400) {
        error = 'redirected; not followed';
      } else if (!response.ok) {
        error = `HTTP ${response.status}`;
      } else {
        delivered += 1;
      }
    } catch (err) {
      error =
        err instanceof Error && err.name === 'TimeoutError'
          ? `no answer within ${REQUEST_TIMEOUT_MS / 1000}s`
          : 'delivery failed';
    }

    await prisma.webhookDelivery
      .create({
        data: {
          orgId,
          integrationId: destination.id,
          event: 'digest.daily',
          payload: { text },
          signature: '',
          // Decided in one attempt, never PENDING: the digest deliberately does
          // not retry per destination — its retry is the window staying open,
          // so tomorrow's digest carries today's news (see runDigest). A row
          // left on the column's PENDING default would read as "still in
          // flight" forever on the deliveries screen.
          status: error ? 'FAILED' : 'SENT',
          responseStatus: status,
          attempts: 1,
          deliveredAt: error ? null : new Date(),
          lastError: error,
        },
      })
      // A failure to RECORD the attempt must not lose the attempt itself.
      .catch((err) => logger.warn({ err }, 'could not record the digest delivery'));

    if (error) {
      logger.warn({ integrationId: destination.id, kind: destination.kind, error }, 'digest delivery failed');
    }
  }

  return delivered;
}

// ─── The tick ────────────────────────────────────────────────────────────────

interface Subscription {
  id: string;
  orgId: string;
  projectId: string;
  cron: string;
  timezone: string;
  notifyVia: string[];
  nextRunAt: Date | null;
  lastCoveredAt: Date | null;
}

function nextFireTime(cron: string, timezone: string, after: Date): Date | null {
  try {
    return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone }).next().toDate();
  } catch {
    return null;
  }
}

/**
 * Build and send one project's digest.
 *
 * Exported so a future "send me one now" endpoint has something to call, and so
 * the tick below stays a loop over subscriptions rather than a loop with the
 * whole feature inlined in it.
 */
export async function runDigest(subscription: Subscription, now: Date): Promise<void> {
  const since = new Date(
    Math.max(
      (subscription.lastCoveredAt ?? new Date(now.getTime() - DEFAULT_WINDOW_MS)).getTime(),
      now.getTime() - MAX_WINDOW_MS,
    ),
  );

  const digest = await collectDigest(subscription, since, now);
  if (!digest) return;

  if (!hasSomethingToSay(digest)) {
    /*
     * Silence, with the numbers that produced it.
     *
     * This is the one place the feature deliberately withholds a message, so it
     * is also the one place that must leave a trace: if someone later asks why
     * Tuesday's digest never arrived, this line answers it. The window closes,
     * because nothing was lost.
     */
    logger.info(
      {
        projectId: digest.projectId,
        since,
        until: now,
        runs: digest.runs.total,
        stillFailing: digest.stillFailing,
      },
      'digest had nothing to say; not sending',
    );
    await prisma.digestSubscription.update({
      where: { id: subscription.id },
      data: { lastCoveredAt: now },
    });
    return;
  }

  const integrations = await prisma.integration.findMany({
    where: {
      orgId: subscription.orgId,
      enabled: true,
      kind: { in: ['SLACK', 'MSTEAMS', 'DISCORD', 'WEBHOOK'] },
      // An empty notifyVia means "wherever the failures already go".
      ...(subscription.notifyVia.length > 0 ? { id: { in: subscription.notifyVia } } : {}),
    },
    select: { id: true, kind: true, config: true, configEnc: true },
  });

  const { deliverable, skipped } = partitionDestinations(
    integrations.map((integration) => candidateFor(subscription.orgId, integration)),
  );
  for (const destination of skipped) {
    // Every skip is actionable and says what to change. A destination that is
    // quietly dropped is how a team concludes the digest does not work.
    logger.warn(
      { projectId: digest.projectId, integrationId: destination.id, kind: destination.kind },
      destination.reason,
    );
  }

  if (deliverable.length === 0) {
    logger.error(
      { projectId: digest.projectId, considered: integrations.length },
      'digest has news but nowhere to send it; leaving the window open for the next one',
    );
    return;
  }

  const text = renderDigest(digest, process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000');
  const delivered = await deliver(subscription.orgId, deliverable, text);

  if (delivered === 0) {
    /*
     * Nothing got through. The window stays OPEN on purpose: tomorrow's digest
     * will cover today's news as well, because a reporting problem must never be
     * allowed to lose what it was reporting. `nextRunAt` has already advanced,
     * so this retries on the next cron slot rather than spinning.
     */
    logger.error(
      { projectId: digest.projectId, destinations: deliverable.length },
      'every digest delivery failed; the window stays open so nothing is lost',
    );
    return;
  }

  await prisma.digestSubscription.update({
    where: { id: subscription.id },
    data: { lastCoveredAt: now },
  });

  logger.info(
    {
      projectId: digest.projectId,
      delivered,
      newFailures: digest.newFailures.length,
      flakes: digest.flakes.length,
      fixed: digest.fixed.length,
    },
    'digest sent',
  );
}

/**
 * The sweep: every subscription that is due.
 *
 * Same shape as the scheduler tick, and idempotent for the same reason — the
 * next fire time is claimed BEFORE the digest is built, so a redelivered tick
 * cannot send the same summary twice. Losing one cycle is recoverable (the
 * window stays open); sending the same digest to a channel twice is not.
 */
export async function processDigestTick(): Promise<void> {
  const now = new Date();

  const due = await prisma.digestSubscription.findMany({
    where: { enabled: true, OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] },
    select: {
      id: true,
      orgId: true,
      projectId: true,
      cron: true,
      timezone: true,
      notifyVia: true,
      nextRunAt: true,
      lastCoveredAt: true,
    },
  });

  for (const subscription of due) {
    const next = nextFireTime(subscription.cron, subscription.timezone, now);
    if (!next) {
      // An unparseable cron would otherwise be retried on every tick forever.
      logger.warn(
        { digestId: subscription.id, cron: subscription.cron },
        'disabling a digest with an invalid cron expression',
      );
      await prisma.digestSubscription.update({
        where: { id: subscription.id },
        data: { enabled: false },
      });
      continue;
    }

    await prisma.digestSubscription.update({
      where: { id: subscription.id },
      data: { nextRunAt: next, lastRunAt: subscription.nextRunAt ? now : null },
    });

    // First sight only arms it. Creating a digest at 2pm must not immediately
    // send one covering an arbitrary window ending at 2pm.
    if (!subscription.nextRunAt) {
      logger.info({ digestId: subscription.id, next }, 'digest armed');
      continue;
    }

    // One project's digest failing must not cost every other project theirs.
    // The window stays open, so the next tick carries today's news too.
    await runDigest(subscription, now).catch((err) =>
      logger.error({ err, digestId: subscription.id }, 'could not build or send a digest'),
    );
  }
}
