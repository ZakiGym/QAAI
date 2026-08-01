/**
 * Build bisect — "which commit turned this test red?"
 *
 * A suite goes red and the only question anyone has is what did this. QAAI
 * already holds a result per test per run, and a run carries the commit it was
 * triggered for, so most of the time the answer is a query rather than an
 * experiment. That ordering is the whole design:
 *
 *   1. HISTORY FIRST. If the last green and the first red are already adjacent
 *      in the recorded timeline, the answer costs nothing and no browser starts.
 *   2. PROBES ONLY WHEN HISTORY IS SPARSE. Re-run the one failing test at
 *      intermediate commits, binary search, `ceil(log2(range))` steps, bounded
 *      hard and reported as a budget.
 *
 * ── The thing that makes this dangerous ─────────────────────────────────────
 * A flaky test cannot be bisected. One red probe might be noise, and a binary
 * search built on noise does not fail loudly — it converges, confidently, on an
 * innocent commit and puts that commit's author's name next to it. That is
 * strictly worse than saying nothing, because a wrong accusation is acted on and
 * a missing answer is not.
 *
 * So this module refuses. `analyzeHistory` measures how often the test has
 * disagreed with itself at a single commit, and if that rate is above the
 * threshold it returns REFUSED with the measurement attached, rather than a
 * suspect. Where the rate cannot be measured at all, the search does not get
 * cheaper — it gets more expensive, re-running each probe `probeRepeats` times,
 * and every report says which of the two happened.
 *
 * ── What "commit order" means here, and what it does not ────────────────────
 * QAAI is not a git client. It never sees a commit graph; `Run.commitSha` is an
 * opaque string CI handed it. The only ordering available is **the order QAAI
 * first ran each commit**, which is a good approximation of git's order and is
 * not the same thing. Two consequences are stated in every report rather than
 * hidden:
 *
 *   • A commit nobody ever ran is invisible. The suspect is therefore "the first
 *     commit QAAI SAW fail", and the change may sit in any unrun commit between
 *     it and the last green.
 *   • CI that re-runs an old commit puts it back on the timeline out of order.
 *     That is detected (`reordered`) and surfaced, not silently smoothed away.
 *
 * ── And what a "probe" can actually do ──────────────────────────────────────
 * QAAI runs tests against a deployed URL; it does not build commits. So a probe
 * at commit C is only possible when QAAI knows a URL that serves C and only C —
 * in practice a preview deploy, recorded as `Run.baseUrlOverride` by an earlier
 * run at that commit. A commit whose runs used the shared environment URL cannot
 * be probed: re-running it today would measure whatever is deployed now and
 * label the answer with an old commit's sha, which is precisely the confident
 * lie this file exists to avoid. Unprobeable commits stay in the range and are
 * reported as un-narrowed.
 *
 * Everything in this file is pure: no Prisma, no Express, no queue. The worker's
 * processor imports it for exactly that reason — the refusal threshold and the
 * search have to be the same code in both places, and a second copy of a
 * judgement call is a second answer waiting to happen.
 */

// ─── Contract with the queue ─────────────────────────────────────────────────

/**
 * The bisect queue.
 *
 * It is spelled here rather than in `QUEUE_NAMES` because that constant and
 * `JobPayloads` live in @qaai/shared, which this change does not own. Both the
 * API (producer) and the worker (consumer) import this, so there is still one
 * source of truth — but until the name moves to @qaai/shared, `queueDepths()`
 * in apps/api/src/lib/queues.ts will not report this queue's depth on
 * /health/ready. See the handover note at the bottom of routes/bisect.ts.
 */
export const BISECT_QUEUE = 'qaai.bisect';

/**
 * Job payload. Ids only, like every other payload: the worker re-reads.
 *
 * A bisect spends almost all of its life waiting for a probe run to finish, so
 * the processor does ONE step per job and re-enqueues itself with a delay rather
 * than sleeping. A sleeping job holds a worker slot for the whole investigation
 * and dies with the process; a delayed job sits in Redis, costs nothing, and
 * survives a restart. `step` is what makes that re-enqueue idempotent (it is
 * part of the BullMQ job id) and bounded (see MAX_BISECT_TICKS).
 */
export interface BisectJob {
  orgId: string;
  projectId: string;
  testId: string;
  /** Stable id for the whole investigation — the one GET /bisect/:id takes. */
  bisectId: string;
  /** Optional window, oldest and newest run to consider. */
  fromRunId: string | null;
  toRunId: string | null;
  requestedBy: string | null;
  /** ISO. The deadline is measured from here, not from this tick. */
  requestedAt: string;
  /** 0 on the first enqueue, incremented on every self-re-enqueue. */
  step: number;
}

/**
 * `bisect:<testId>:<bisectId>` on `Run.triggeredBy`.
 *
 * The probe runs ARE the investigation's state. Tagging them means an
 * investigation survives a worker restart, is visible in the cockpit like any
 * other run, and can be re-adopted by a retried job instead of being duplicated.
 * Mirrors FLAKE_RUN_PREFIX in @qaai/shared, deliberately.
 */
export const BISECT_RUN_PREFIX = 'bisect:';

export function bisectTag(testId: string, bisectId: string): string {
  return `${BISECT_RUN_PREFIX}${testId}:${bisectId}`;
}

export function parseBisectTag(
  triggeredBy: string | null | undefined,
): { testId: string; bisectId: string } | null {
  if (typeof triggeredBy !== 'string' || !triggeredBy.startsWith(BISECT_RUN_PREFIX)) return null;
  const [testId, bisectId] = triggeredBy.slice(BISECT_RUN_PREFIX.length).split(':');
  if (!testId || !bisectId) return null;
  return { testId, bisectId };
}

/** Audit actions. The audit row is the durable record; the BullMQ job is not. */
export const BISECT_AUDIT_ACTIONS = {
  requested: 'bisect.requested',
  planned: 'bisect.planned',
  concluded: 'bisect.concluded',
} as const;

/** `targetType` on those rows. The target is the investigation, not the test. */
export const BISECT_AUDIT_TARGET = 'Bisect';

// ─── Bounds ──────────────────────────────────────────────────────────────────

/**
 * Above this measured self-disagreement rate, this refuses to bisect at all.
 *
 * 10% is not a tuned number — it is "one commit in ten gave both answers", which
 * is already enough for a three-step search to land on the wrong commit more
 * often than a coin flip. The threshold is configurable per request precisely
 * because it is a judgement, not a fact.
 */
export const DEFAULT_MAX_FLAKE_PERCENT = 10;

/**
 * How many commits must carry a repeat before the rate above counts as measured.
 *
 * Below this the answer is not "it is stable", it is "we do not know" — and the
 * response to not knowing is more probes per step, never fewer.
 */
export const MIN_REPEATED_COMMITS = 2;

/** Re-runs per probe when the flake rate is unmeasured or non-zero. */
export const DEFAULT_PROBE_REPEATS = 3;

/**
 * The ceiling on runs one bisect may create, across every step.
 *
 * A bisect is background work nobody is blocked on, and it holds a browser per
 * run. `ceil(log2(range)) × repeats` is small for any realistic range; this
 * exists so that a pathological range cannot turn into an afternoon of CI.
 */
export const MAX_PROBE_RUNS = 24;

/** Runs pulled into one timeline. A window guard, not an analysis limit. */
export const MAX_TIMELINE_RUNS = 500;

/** How far back the default window reaches when no run ids are given. */
export const DEFAULT_WINDOW_DAYS = 30;

/** Wall clock before an investigation gives up and reports what it has. */
export const DEFAULT_DEADLINE_MINUTES = 45;

/** Gap between ticks while a probe run is executing. */
export const BISECT_TICK_DELAY_MS = 15_000;

/**
 * Absolute ceiling on self-re-enqueues.
 *
 * The deadline above is the real bound; this one exists because a clock that
 * jumps backwards would make the deadline unreachable, and a job that re-enqueues
 * itself forever is the kind of bug that is only noticed on the Redis bill.
 */
export const MAX_BISECT_TICKS = 400;

// ─── The timeline ────────────────────────────────────────────────────────────

/** One run of the project, with the result it recorded for the test in question. */
export interface BisectRunRow {
  runId: string;
  commitSha: string | null;
  /** RunStatus. Only PASSED and FAILED mean the run reported. */
  runStatus: string;
  triggeredBy: string | null;
  queuedAt: Date;
  environmentId: string;
  /** Commit-pinned URL, when the run had one. This is what makes a probe possible. */
  baseUrlOverride: string | null;
  /** Null when this run recorded no result for the test. */
  result: { status: string; retriedAndPassed: boolean } | null;
}

export type CommitVerdict = 'GREEN' | 'RED' | 'MIXED' | 'UNUSABLE';

export interface CommitNode {
  commitSha: string;
  /** Position on QAAI's timeline. 0 is the oldest commit in the window. */
  index: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  verdict: CommitVerdict;
  passed: number;
  failed: number;
  /** Samples that measured nothing: the run errored, was cancelled, or skipped. */
  discarded: number;
  /** The runs behind the usable samples. This is the evidence, by id. */
  runIds: string[];
  /**
   * A URL that serves this commit and nothing else, from an earlier run's
   * `baseUrlOverride`. Null means this commit cannot be probed.
   */
  pinnedBaseUrl: string | null;
  /** Environment the pinned URL was used with, so a probe reproduces the setup. */
  environmentId: string | null;
  /**
   * True when this commit's runs interleave in time with a neighbour's — CI
   * re-ran an old commit, or tested two commits at once. The timeline position
   * is then a guess, and any boundary touching it is reported as such.
   */
  reordered: boolean;
  /** True when a probe from this investigation contributed a sample. */
  probed: boolean;
}

export interface Timeline {
  commits: CommitNode[];
  /** Runs dropped because they carried no commit sha — they cannot be placed. */
  runsWithoutCommit: number;
  /** Runs considered in total, after the window was applied. */
  runsConsidered: number;
}

/** A sample measures something only if the run reported and the test executed. */
function usable(row: BisectRunRow): boolean {
  const reported = row.runStatus === 'PASSED' || row.runStatus === 'FAILED';
  const executed = row.result !== null && row.result.status !== 'SKIPPED';
  return reported && executed;
}

/**
 * A pass that only happened on retry is a failure.
 *
 * The same rule §5 encodes for the quality gate and the flake radar. Counting it
 * as a pass would let a flaky green mark a commit as the last good one, which is
 * how a bisect walks straight past the commit that actually broke the test.
 */
function failedSample(result: { status: string; retriedAndPassed: boolean }): boolean {
  return result.status !== 'PASSED' || result.retriedAndPassed;
}

export function classifyCommit(passed: number, failed: number): CommitVerdict {
  if (passed + failed === 0) return 'UNUSABLE';
  if (failed === 0) return 'GREEN';
  if (passed === 0) return 'RED';
  return 'MIXED';
}

/**
 * Group runs into commits, oldest first.
 *
 * Ordered by when each commit was FIRST run. A commit re-run later does not move
 * — it keeps its original position and gets flagged `reordered`, because moving
 * it would silently rewrite history to fit the answer.
 */
export function buildTimeline(rows: readonly BisectRunRow[], bisectId?: string): Timeline {
  const sorted = [...rows].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime());

  const byCommit = new Map<string, BisectRunRow[]>();
  let runsWithoutCommit = 0;
  for (const row of sorted) {
    if (!row.commitSha) {
      // A run with no commit cannot be placed on a commit timeline. Flake
      // confirmation runs are the common case; they are measurements of the
      // test, not of a commit, and including them would smear one commit's
      // evidence across the whole window.
      runsWithoutCommit += 1;
      continue;
    }
    const list = byCommit.get(row.commitSha);
    if (list) list.push(row);
    else byCommit.set(row.commitSha, [row]);
  }

  const commits: CommitNode[] = [];
  /** Parallel to `commits`: [first, last] organic run, for the ordering check. */
  const organicSpans: Array<[Date | null, Date | null]> = [];
  let index = 0;
  for (const [commitSha, group] of byCommit) {
    let passed = 0;
    let failed = 0;
    let discarded = 0;
    let pinnedBaseUrl: string | null = null;
    let environmentId: string | null = null;
    let probed = false;
    const runIds: string[] = [];
    // Timestamps of the runs CI produced, as opposed to the ones a bisect went
    // back and created. Only these can say anything about commit ordering.
    const organic: Date[] = [];

    for (const row of group) {
      // A pinned URL is worth having even from a run that measured nothing: a
      // run that ERRORED still proves where this commit was deployed.
      if (!pinnedBaseUrl && row.baseUrlOverride) {
        pinnedBaseUrl = row.baseUrlOverride;
        environmentId = row.environmentId;
      }
      const tag = parseBisectTag(row.triggeredBy);
      if (tag && (!bisectId || tag.bisectId === bisectId)) probed = true;
      if (!tag) organic.push(row.queuedAt);

      if (!usable(row)) {
        discarded += 1;
        continue;
      }
      runIds.push(row.runId);
      if (failedSample(row.result!)) failed += 1;
      else passed += 1;
    }

    // Fall back to any environment we saw, so an unprobeable commit still says
    // which environment its evidence came from.
    if (!environmentId && group[0]) environmentId = group[0].environmentId;

    commits.push({
      commitSha,
      index: index++,
      firstSeenAt: group[0]!.queuedAt,
      lastSeenAt: group[group.length - 1]!.queuedAt,
      verdict: classifyCommit(passed, failed),
      passed,
      failed,
      discarded,
      runIds,
      pinnedBaseUrl,
      environmentId,
      reordered: false,
      probed,
    });
    organicSpans.push(
      organic.length > 0 ? [organic[0]!, organic[organic.length - 1]!] : [null, null],
    );
  }

  /*
   * Interleaving check: a commit whose runs continue past the moment the next
   * commit started is not cleanly ordered against it. Both ends are flagged,
   * because neither one is more trustworthy than the other.
   *
   * Measured over CI's runs only. A bisect probe is BY DEFINITION a run of an
   * old commit happening now, so counting it here would make every commit a
   * bisect touched look reordered — and would put a caveat about untrustworthy
   * ordering on the very answer the probes were run to produce.
   */
  for (let i = 0; i + 1 < commits.length; i++) {
    const aEnd = organicSpans[i]?.[1];
    const bStart = organicSpans[i + 1]?.[0];
    if (aEnd && bStart && aEnd.getTime() > bStart.getTime()) {
      commits[i]!.reordered = true;
      commits[i + 1]!.reordered = true;
    }
  }

  return { commits, runsWithoutCommit, runsConsidered: sorted.length };
}

// ─── Is this test steady enough to bisect at all? ────────────────────────────

export interface FlakeEvidence {
  /** Commits with two or more usable samples — the only ones that can disagree. */
  repeatedCommits: number;
  /** Of those, the ones that produced both a pass and a failure. */
  disagreeingCommits: number;
  ratePercent: number;
  /** False when too few commits carry a repeat for this to be a measurement. */
  measured: boolean;
  usableSamples: number;
}

/**
 * How often has this test contradicted itself at a single commit?
 *
 * The code cannot change between two runs of the same commit, so a commit that
 * gave both answers is direct evidence of non-determinism — which is a far
 * better signal than `Test.flakeRate` for this purpose, because it is measured
 * against the exact axis a bisect searches along.
 *
 * A history where nothing was ever run twice yields `measured: false`. That is
 * not the same as zero, and is never allowed to read as zero.
 */
export function measureFlake(commits: readonly CommitNode[]): FlakeEvidence {
  let repeatedCommits = 0;
  let disagreeingCommits = 0;
  let usableSamples = 0;

  for (const commit of commits) {
    const samples = commit.passed + commit.failed;
    usableSamples += samples;
    if (samples < 2) continue;
    repeatedCommits += 1;
    if (commit.verdict === 'MIXED') disagreeingCommits += 1;
  }

  return {
    repeatedCommits,
    disagreeingCommits,
    ratePercent: repeatedCommits === 0 ? 0 : (disagreeingCommits / repeatedCommits) * 100,
    measured: repeatedCommits >= MIN_REPEATED_COMMITS,
    usableSamples,
  };
}

export function describeFlake(flake: FlakeEvidence): string {
  if (!flake.measured) {
    return flake.repeatedCommits === 0
      ? 'no commit in this window was run twice, so the test’s stability was never measured'
      : `only ${flake.repeatedCommits} commit in this window was run twice, too few to measure stability`;
  }
  return `it gave two different answers at ${flake.disagreeingCommits} of the ${flake.repeatedCommits} commits it ran more than once (${Math.round(flake.ratePercent)}%)`;
}

// ─── Where the red starts ────────────────────────────────────────────────────

export interface Boundary {
  /** Newest commit known green before the red streak. Null when there is none. */
  lastGreen: CommitNode | null;
  /** Oldest commit in the current red streak — the suspect, before probing. */
  firstRed: CommitNode | null;
  /** Commits between them QAAI has no usable result for. The search space. */
  unknown: CommitNode[];
  /** A commit inside the search window that gave both answers. Fatal to a bisect. */
  mixed: CommitNode | null;
  /** The newest commit with any verdict — what the test looks like right now. */
  head: CommitNode | null;
  /** Earlier green-after-red flips. Context, not a defect. */
  priorRegressions: number;
}

/**
 * Walk back from the newest verdict to the last green.
 *
 * Anchored on the newest commit rather than the oldest, because the question is
 * always about the red the suite is showing NOW. A history that went red, was
 * fixed, and went red again has two regressions in it and only the latest one is
 * being asked about; the earlier flips are counted and reported as context.
 */
export function findBoundary(commits: readonly CommitNode[]): Boundary {
  const decided = commits.filter((c) => c.verdict !== 'UNUSABLE');
  const head = decided.length > 0 ? decided[decided.length - 1]! : null;

  let regressions = 0;
  for (let i = 1; i < decided.length; i++) {
    if (decided[i - 1]!.verdict === 'GREEN' && decided[i]!.verdict === 'RED') regressions += 1;
  }
  // The regression being asked about is not a "prior" one — but only when the
  // test is actually red now. If it is green, every flip in the window is history.
  const priorRegressions =
    head?.verdict === 'RED' && regressions > 0 ? regressions - 1 : regressions;

  const empty: Boundary = {
    lastGreen: null,
    firstRed: null,
    unknown: [],
    mixed: null,
    head,
    priorRegressions,
  };

  if (!head || head.verdict !== 'RED') return empty;

  let firstRed = head;
  let lastGreen: CommitNode | null = null;
  let mixed: CommitNode | null = null;

  for (let i = head.index - 1; i >= 0; i--) {
    const node = commits[i]!;
    if (node.verdict === 'RED') {
      firstRed = node;
      continue;
    }
    if (node.verdict === 'GREEN') {
      lastGreen = node;
      break;
    }
    if (node.verdict === 'MIXED') {
      // Stop here rather than treating it as green or red. A commit that passed
      // and failed on identical code is the one fact that invalidates the whole
      // search, and reading it either way would hide that.
      mixed = node;
      break;
    }
  }

  const greenIndex = lastGreen?.index;
  const unknown =
    greenIndex === undefined
      ? []
      : commits.filter((c) => c.index > greenIndex && c.index < firstRed.index);

  return { lastGreen, firstRed, unknown, mixed, head, priorRegressions };
}

// ─── The search ──────────────────────────────────────────────────────────────

/** `ceil(log2(candidates + 1))` — the classic bound, stated as a budget. */
export function probeBudget(candidateCount: number): number {
  if (candidateCount <= 0) return 0;
  return Math.ceil(Math.log2(candidateCount + 1));
}

export interface SearchState {
  /** Index into the candidate list known green. -1 means the `lastGreen` anchor. */
  greenAt: number;
  /** Index known red. `candidates.length` means the `firstRed` anchor. */
  redAt: number;
}

export type ProbeStep =
  | { kind: 'probe'; index: number }
  /** The range is one step wide: `redAt` is the answer. */
  | { kind: 'converged' }
  /** Candidates remain, but none of them can be reached. */
  | { kind: 'unprobeable' };

/**
 * The next commit to test, or why there isn't one.
 *
 * Midpoint first; when the midpoint cannot be probed (no commit-pinned URL) the
 * nearest probeable candidate is used instead. That costs the log2 guarantee a
 * little — an off-centre split is a worse split — and it is still bounded by the
 * budget, which is checked by the caller rather than here.
 */
export function nextProbe(state: SearchState, probeable: readonly boolean[]): ProbeStep {
  if (state.redAt - state.greenAt <= 1) return { kind: 'converged' };

  const mid = Math.floor((state.greenAt + state.redAt) / 2);
  if (probeable[mid]) return { kind: 'probe', index: mid };

  for (let offset = 1; offset < probeable.length; offset++) {
    const left = mid - offset;
    const right = mid + offset;
    if (left > state.greenAt && probeable[left]) return { kind: 'probe', index: left };
    if (right < state.redAt && probeable[right]) return { kind: 'probe', index: right };
    if (left <= state.greenAt && right >= state.redAt) break;
  }
  return { kind: 'unprobeable' };
}

/** Fold one probe result into the search. GREEN moves the floor, RED the ceiling. */
export function applyProbe(
  state: SearchState,
  index: number,
  verdict: 'GREEN' | 'RED',
): SearchState {
  return verdict === 'GREEN'
    ? { greenAt: Math.max(state.greenAt, index), redAt: state.redAt }
    : { greenAt: state.greenAt, redAt: Math.min(state.redAt, index) };
}

// ─── The report ──────────────────────────────────────────────────────────────

export type BisectStatus =
  /** A suspect commit, with the evidence for it. */
  | 'ANSWERED'
  /** Not attempted, and the reason is about the test or the data, not a failure. */
  | 'REFUSED'
  /** History is too sparse; probes are planned. */
  | 'NEEDS_PROBES'
  /** Probing started and could not finish. The range is narrowed, not resolved. */
  | 'INCONCLUSIVE';

export type BisectConfidence =
  /** Green either side of the boundary, measured stable, nothing ambiguous. */
  | 'confirmed'
  /** The boundary holds, but something about it is thinner than we would like. */
  | 'probable'
  /** No commit is being named. */
  | 'none';

export interface ProbePlan {
  /** The unknown commits between the last green and the first red, oldest first. */
  candidates: Array<{ commitSha: string; probeable: boolean }>;
  /** `ceil(log2(n+1))`, before the run ceiling is applied. */
  fullBudget: number;
  /** What the ceiling actually allows. Less than `fullBudget` means partial. */
  budget: number;
  repeats: number;
  /** Why `repeats` is what it is — printed in the report. */
  repeatsReason: string;
}

export interface BisectReport {
  bisectId: string;
  testId: string;
  status: BisectStatus;
  /** The accused commit. Null unless `status` is ANSWERED. */
  suspectCommit: string | null;
  /** Newest commit the test is known to have passed at. */
  lastGoodCommit: string | null;
  confidence: BisectConfidence;
  /** One paragraph, always. Says what was concluded and on what evidence. */
  summary: string;
  source: 'history' | 'history+probes';
  flake: FlakeEvidence;
  probes: {
    budget: number;
    used: number;
    repeats: number;
    /** Steps where the repeats disagreed with each other. */
    ambiguous: number;
    runIds: string[];
  };
  boundary: {
    lastGreen: string | null;
    firstRed: string | null;
    unknownBetween: number;
    priorRegressions: number;
  };
  /** Every commit considered, oldest first — the evidence, in full. */
  timeline: Array<{
    commitSha: string;
    verdict: CommitVerdict;
    passed: number;
    failed: number;
    discarded: number;
    runIds: string[];
    probeable: boolean;
    reordered: boolean;
    probed: boolean;
  }>;
  /** Everything that makes the answer weaker than it looks. Never empty. */
  caveats: string[];
}

export function timelineForReport(commits: readonly CommitNode[]): BisectReport['timeline'] {
  return commits.map((c) => ({
    commitSha: c.commitSha,
    verdict: c.verdict,
    passed: c.passed,
    failed: c.failed,
    discarded: c.discarded,
    runIds: c.runIds,
    probeable: c.pinnedBaseUrl !== null,
    reordered: c.reordered,
    probed: c.probed,
  }));
}

/** Short sha, for prose. Full shas stay in the structured fields. */
export function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

export interface AnalyzeOptions {
  maxFlakePercent?: number;
  probeRepeats?: number;
  maxProbeRuns?: number;
}

export interface HistoryAnalysis {
  timeline: Timeline;
  flake: FlakeEvidence;
  boundary: Boundary;
  status: BisectStatus;
  suspect: CommitNode | null;
  lastGood: CommitNode | null;
  confidence: BisectConfidence;
  summary: string;
  caveats: string[];
  /** Set only when `status` is NEEDS_PROBES. */
  plan: ProbePlan | null;
}

/**
 * The whole phase-1 judgement: refuse, answer, or plan probes.
 *
 * Every early return here is a refusal, and each one exists because the
 * alternative is naming a commit on evidence that does not support it. They are
 * checked before anything is measured further, in rough order of how badly the
 * question is broken.
 */
export function analyzeHistory(
  rows: readonly BisectRunRow[],
  opts: AnalyzeOptions & { bisectId?: string } = {},
): HistoryAnalysis {
  const maxFlakePercent = opts.maxFlakePercent ?? DEFAULT_MAX_FLAKE_PERCENT;
  const maxProbeRuns = opts.maxProbeRuns ?? MAX_PROBE_RUNS;

  const timeline = buildTimeline(rows, opts.bisectId);
  const flake = measureFlake(timeline.commits);
  const boundary = findBoundary(timeline.commits);

  const base = (
    status: BisectStatus,
    summary: string,
    extra: Partial<HistoryAnalysis> = {},
  ): HistoryAnalysis => ({
    timeline,
    flake,
    boundary,
    status,
    suspect: null,
    lastGood: null,
    confidence: 'none',
    summary,
    caveats: standingCaveats(timeline, boundary, flake),
    plan: null,
    ...extra,
  });

  if (timeline.commits.length === 0) {
    return base(
      'REFUSED',
      'No run of this test in the window carried a commit sha, so there is no timeline to search. ' +
        'Bisect needs CI to send `commitSha` with the runs it triggers.',
    );
  }

  if (!boundary.head) {
    return base(
      'REFUSED',
      'Every run of this test in the window either did not report or did not execute it, so no ' +
        'commit has a verdict. There is nothing to bisect yet.',
    );
  }

  if (boundary.head.verdict === 'GREEN') {
    return base(
      'REFUSED',
      `The newest commit with a result, ${shortSha(boundary.head.commitSha)}, is GREEN — this test ` +
        'is passing. Nothing broke it, so there is nothing to find.',
      { lastGood: boundary.head },
    );
  }

  if (boundary.head.verdict === 'MIXED') {
    return base(
      'REFUSED',
      `At the newest commit, ${shortSha(boundary.head.commitSha)}, this test both passed and failed ` +
        `on identical code (${boundary.head.passed} passed, ${boundary.head.failed} failed). ` +
        'That is a flaky test, not a regression. A bisect over it would converge on a commit and ' +
        'name it confidently, which is worse than no answer — so nothing is named.',
    );
  }

  /*
   * The refusal the feature exists for. Checked before the boundary is used for
   * anything, because a rate this high means the boundary itself is noise.
   */
  if (flake.measured && flake.ratePercent > maxFlakePercent) {
    return base(
      'REFUSED',
      `Refusing to bisect: ${describeFlake(flake)}, above the ${maxFlakePercent}% this bisect ` +
        'allows. A search over a test that disagrees with itself converges on whichever commit ' +
        'happened to fail, not on the one that caused it. Stabilise the test, or quarantine it, ' +
        'and ask again.',
    );
  }

  if (boundary.mixed) {
    return base(
      'REFUSED',
      `Between the red streak and the last green sits ${shortSha(boundary.mixed.commitSha)}, where ` +
        `this test both passed and failed (${boundary.mixed.passed} passed, ${boundary.mixed.failed} ` +
        'failed) on identical code. The boundary runs straight through a commit that cannot be ' +
        'called either way, so no commit is accused.',
    );
  }

  if (!boundary.lastGreen || !boundary.firstRed) {
    const oldest = timeline.commits[0]!;
    return base(
      'REFUSED',
      `This test is red at every commit QAAI has a result for, back to ${shortSha(oldest.commitSha)}. ` +
        'There is no green side to search from — widen the window with `fromRunId`, or this test ' +
        'has never passed here.',
    );
  }

  /*
   * One run per probe is only ever earned. It requires a measurement — not the
   * absence of one — showing this test has never contradicted itself. Anything
   * less and each probe is repeated, because a single red probe on an unmeasured
   * test is exactly the noise that makes a bisect accuse the wrong commit.
   */
  const repeats =
    flake.measured && flake.ratePercent === 0 ? 1 : (opts.probeRepeats ?? DEFAULT_PROBE_REPEATS);
  const repeatsReason =
    repeats === 1
      ? `this test never disagreed with itself across ${flake.repeatedCommits} repeated commits, so one run per probe is enough`
      : flake.measured
        ? `${describeFlake(flake)} — under the refusal threshold but not zero, so each probe runs ${repeats} times and a probe whose runs disagree stops the search`
        : `${describeFlake(flake)}, so each probe runs ${repeats} times rather than trusting a single result`;

  // ── History alone answers it ──────────────────────────────────────────────
  if (boundary.unknown.length === 0) {
    const confirmed =
      !boundary.lastGreen.reordered && !boundary.firstRed.reordered && flake.measured;
    return base(
      'ANSWERED',
      `${shortSha(boundary.firstRed.commitSha)} is the first commit at which this test fails. It ` +
        `passed at ${shortSha(boundary.lastGreen.commitSha)}, the commit immediately before it on ` +
        'QAAI’s timeline, and has failed at every commit since. No re-runs were needed — the ' +
        'answer was already in the recorded results.',
      {
        suspect: boundary.firstRed,
        lastGood: boundary.lastGreen,
        confidence: confirmed ? 'confirmed' : 'probable',
      },
    );
  }

  // ── History is sparse; plan probes ────────────────────────────────────────
  const candidates = boundary.unknown.map((c) => ({
    commitSha: c.commitSha,
    probeable: c.pinnedBaseUrl !== null,
  }));
  const fullBudget = probeBudget(candidates.length);
  const budget = Math.max(0, Math.min(fullBudget, Math.floor(maxProbeRuns / repeats)));
  const probeableCount = candidates.filter((c) => c.probeable).length;

  if (probeableCount === 0 || budget === 0) {
    const why =
      probeableCount === 0
        ? `none of them was ever deployed to a URL QAAI recorded, so none can be re-run — a probe would test whatever is deployed now and label it with an old commit`
        : `the ${repeats}-runs-per-probe this test needs does not fit inside the ${maxProbeRuns}-run ceiling`;
    return base(
      'INCONCLUSIVE',
      `The break is somewhere in the ${candidates.length + 1} commits from ` +
        `${shortSha(boundary.unknown[0]!.commitSha)} through ${shortSha(boundary.firstRed.commitSha)}: ` +
        `this test passed at ${shortSha(boundary.lastGreen.commitSha)} and fails at ` +
        `${shortSha(boundary.firstRed.commitSha)}, and ${why}. The range is the answer; no single ` +
        'commit is accused.',
      { lastGood: boundary.lastGreen, confidence: 'none' },
    );
  }

  return base(
    'NEEDS_PROBES',
    `History narrows the break to ${candidates.length + 1} commits between ` +
      `${shortSha(boundary.lastGreen.commitSha)} (green) and ${shortSha(boundary.firstRed.commitSha)} ` +
      `(red), but ${candidates.length} of them have no result for this test. Re-running it at ` +
      `${budget} of them, binary search, ${repeats} run${repeats === 1 ? '' : 's'} each.`,
    {
      lastGood: boundary.lastGreen,
      plan: { candidates, fullBudget, budget, repeats, repeatsReason },
    },
  );
}

/**
 * The caveats that are true of every answer this module gives, plus the ones
 * this particular history earns. Never returns an empty list: an answer with no
 * stated limits reads as a certainty, and none of these answers is one.
 */
export function standingCaveats(
  timeline: Timeline,
  boundary: Boundary,
  flake: FlakeEvidence,
): string[] {
  const caveats: string[] = [
    'QAAI orders commits by when it first ran them, not by git parentage. A commit nobody ran ' +
      'is invisible here, so a named commit means "the first commit QAAI SAW fail" — the change ' +
      'itself may sit in any unrun commit between it and the last green.',
  ];

  if (timeline.runsWithoutCommit > 0) {
    caveats.push(
      `${timeline.runsWithoutCommit} run${timeline.runsWithoutCommit === 1 ? '' : 's'} in the ` +
        'window carried no commit sha and could not be placed on the timeline.',
    );
  }
  if (timeline.runsConsidered >= MAX_TIMELINE_RUNS) {
    caveats.push(
      `The window hit the ${MAX_TIMELINE_RUNS}-run ceiling, so the timeline may start later than ` +
        'the real last green. Narrow it with `fromRunId` if the boundary looks wrong.',
    );
  }
  if (!flake.measured) {
    caveats.push(
      `Stability was not measured: ${describeFlake(flake)}. The answer assumes each result is ` +
        'deterministic, and that assumption was never tested against this history.',
    );
  }
  if (boundary.lastGreen?.reordered || boundary.firstRed?.reordered) {
    caveats.push(
      'A commit at the boundary was run again out of order (its runs interleave with a ' +
        'neighbour’s), so its position on the timeline is inferred rather than observed.',
    );
  }
  if (boundary.priorRegressions > 0) {
    caveats.push(
      `This test went red and green again ${boundary.priorRegressions} other time` +
        `${boundary.priorRegressions === 1 ? '' : 's'} in the window. Only the most recent ` +
        'regression is being explained.',
    );
  }

  const unreached = boundary.unknown.filter((c) => c.pinnedBaseUrl === null).length;
  if (unreached > 0) {
    caveats.push(
      `${unreached} commit${unreached === 1 ? '' : 's'} inside the range cannot be re-run: no run ` +
        'at that commit recorded a commit-pinned URL (a preview deploy), and re-running against ' +
        'the shared environment URL would measure the current deploy, not that commit.',
    );
  }

  return caveats;
}
