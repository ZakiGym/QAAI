/**
 * Run selection — deciding what a run does NOT have to do.
 *
 * Three features share this file because they share one failure mode: each of
 * them makes a run cheaper by not executing something, and each of them is
 * therefore capable of turning a broken build green. Nothing here is allowed to
 * treat "cheaper" and "correct" as comparable goods.
 *
 *   impact selection  run only the tests the diff can reach (impact.ts reasons;
 *                     this wires that reasoning into run creation)
 *   result caching    reuse a recent clean pass for a test nothing has touched
 *   fail-fast         stop at the first real failure when the only question is
 *                     "is this PR safe"
 *
 * The rule every function below obeys: **any doubt means run it.** Missing
 * evidence, an unreadable timestamp, an unexpected status, a clock that went
 * backwards — all of them resolve to "execute the test", never to "assume it
 * would have passed". Skipping a test that would have caught a bug is the worst
 * outcome this product can produce; wasting a minute of CI is not in the same
 * category of mistake, and the code never trades one against the other.
 *
 * The second rule is that a selection has to be legible. Every decision here
 * carries a sentence a human can read, because a run that quietly executed 6 of
 * 200 tests and reported green is indistinguishable from a run that is lying,
 * and nobody can tell them apart without being told why.
 */

import { createHash } from 'node:crypto';
import { analyzeImpact } from './impact.js';
import type { Confidence, ImpactAnalysis, ImpactTestInput, TestDecision } from './impact.js';

/**
 * How many per-test decisions a run response carries. The full picture is what
 * POST /impact/analyze is for; a run response has to stay a response, and a
 * 2000-test project would otherwise put a megabyte of prose on every CI log.
 */
export const MAX_REPORTED_DECISIONS = 100;

// ─── Impact selection ────────────────────────────────────────────────────────

export interface SelectionInput {
  /** The diff, as the caller reported it. Empty means no selection is wanted. */
  changedPaths: string[];
  /** The tests this run would otherwise execute — the candidate set, not the project. */
  tests: ImpactTestInput[];
  /** Serialised FlowMap of the latest crawl, if the project has one. */
  flowMapGraph?: unknown;
}

export interface SelectionResult {
  analysis: ImpactAnalysis;
  /** Ids to run. Always a subset of the candidates that were handed in. */
  testIds: string[];
  /** Set when the analysis's answer was discarded for safety; null when it stood. */
  fallbackReason: string | null;
}

/**
 * Turn a diff into the ids a run should execute.
 *
 * The analysis is deliberately given the CANDIDATE set — the tests this run was
 * already going to execute — rather than every test in the project. That makes
 * this endpoint's answer slightly more conservative than POST /impact/analyze's
 * for the same diff, and conservative in the safe direction: impact.ts
 * corroborates a path's claims against what the suite it was shown knows about,
 * so a smaller suite corroborates less, attributes less, and runs more.
 */
export function selectTestsForRun(input: SelectionInput): SelectionResult {
  const analysis = analyzeImpact({
    changedPaths: input.changedPaths,
    tests: input.tests,
    flowMapGraph: input.flowMapGraph,
  });

  const candidates = new Set(input.tests.map((test) => test.id));
  const selected = analysis.testIds.filter((id) => candidates.has(id));

  /*
   * The analysis has its own last line of defence against selecting nothing, so
   * reaching this is not supposed to be possible. That is exactly why it is
   * checked: an empty selection reaches the user as a green run over zero tests,
   * which is the most convincing lie this system could tell. If the two layers
   * ever disagree, the one that runs everything wins.
   */
  if (selected.length === 0) {
    return {
      analysis,
      testIds: [...candidates],
      fallbackReason:
        'Impact analysis selected no test at all. That is far more likely to be a bug in the selection than a change that breaks nothing, so the whole set runs.',
    };
  }

  return { analysis, testIds: selected, fallbackReason: null };
}

export interface SkippedTestReport {
  testId: string;
  name: string;
  filePath: string;
  priority: TestDecision['priority'];
  reason: string;
  confidence: Confidence;
}

export interface SelectionReport {
  applied: boolean;
  strategy: ImpactAnalysis['strategy'];
  reason: string;
  confidence: Confidence;
  savedPercent: number;
  totals: ImpactAnalysis['totals'];
  flowMapVersion: number | null;
  /** Every test that will not run, and the sentence that explains each one. */
  skipped: SkippedTestReport[];
  /** How many skip decisions did not fit in `skipped`. */
  skippedTruncated: number;
  /** Set when the analysis was overridden and everything ran anyway. */
  fallbackReason: string | null;
}

/**
 * The part of the answer the caller sees.
 *
 * A selection nobody can audit is a selection nobody should trust, so this
 * carries the per-test reasons rather than a count. The list is capped, and says
 * so when it is — silently truncating the explanation of a skip would defeat the
 * purpose of having one.
 */
export function describeSelection(
  result: SelectionResult,
  flowMapVersion: number | null,
  limit = MAX_REPORTED_DECISIONS,
): SelectionReport {
  const { analysis } = result;
  const skipped = analysis.skip.map((decision) => ({
    testId: decision.testId,
    name: decision.name,
    filePath: decision.filePath,
    priority: decision.priority,
    reason: decision.reason,
    confidence: decision.confidence,
  }));

  return {
    applied: result.fallbackReason === null && analysis.skip.length > 0,
    strategy: analysis.strategy,
    reason: analysis.reason,
    confidence: analysis.confidence,
    savedPercent: result.fallbackReason === null ? analysis.savedPercent : 0,
    totals: analysis.totals,
    flowMapVersion,
    skipped: skipped.slice(0, limit),
    skippedTruncated: Math.max(0, skipped.length - limit),
    fallbackReason: result.fallbackReason,
  };
}

// ─── Result caching ──────────────────────────────────────────────────────────

/**
 * Bumped whenever anything about how a test EXECUTES changes in a way the key's
 * inputs cannot see — a runner upgrade, a plugin's default timeout, a change to
 * the determinism harness. Every previously cached pass stops matching, which
 * costs one full run and is the cheapest possible way to be wrong about this.
 */
export const RESULT_CACHE_VERSION = 'v1';

/** Default staleness window for a reusable pass. */
export const DEFAULT_CACHE_WINDOW_HOURS = 24;

/**
 * Ceiling on the configurable window. A month-old green says something about a
 * month-old application; the deployment it was collected from has since moved.
 */
export const MAX_CACHE_WINDOW_HOURS = 24 * 14;

/**
 * Past this many candidates the lookup stops being a query and starts being a
 * table scan with a wide `IN` list. The cache declines rather than degrades:
 * declining costs a run that was going to happen anyway.
 */
export const MAX_CACHE_CANDIDATES = 500;

export function cacheWindowMs(hours: number | null | undefined): number {
  const requested = hours ?? DEFAULT_CACHE_WINDOW_HOURS;
  const clamped = Math.min(Math.max(1, Math.floor(requested)), MAX_CACHE_WINDOW_HOURS);
  return clamped * 3_600_000;
}

export interface CacheKeyInput {
  /** The plugin that will execute this — an identical `spec` means different
   * things to the API plugin and the a11y one. */
  testType: string;
  code: string;
  spec: unknown;
  /** The URL the test will actually be pointed at, override included. */
  baseUrl: string;
}

/**
 * Stable JSON: object keys sorted, so two specs that differ only in the order
 * Postgres handed their keys back hash the same. Without this the cache would
 * miss constantly and — much worse — its hit rate would depend on the storage
 * layer's whims rather than on anything about the test.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      // NaN and Infinity have no JSON spelling; collapsing them to null keeps
      // the hash defined, and neither can appear in a Json column anyway.
      return Number.isFinite(value) ? String(value) : 'null';
    case 'bigint':
      return `"${value.toString()}"`;
    default:
      break;
  }

  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }

  // A function or a symbol cannot have come out of the database. Hashing it as
  // null would silently equate two different specs, so refuse instead.
  throw new TypeError(`cannot canonicalise a ${typeof value} for the result cache key`);
}

/**
 * `https://app.example.com/` and `https://app.example.com` are the same
 * deployment. Nothing else is normalised: a differing scheme, host, port or path
 * is a different deployment, and treating any of those as equal is how a pass
 * collected against staging gets reused for production.
 */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/**
 * What a result would have to match to be reusable: the test's own code, its
 * spec, the URL it ran against, and the plugin that ran it.
 *
 * Everything else about a test — its name, tags, priority, flake rate — changes
 * what we SAY about a result, not what the result would be, so none of it
 * belongs in the key.
 */
export function resultCacheKey(input: CacheKeyInput): string {
  const payload = canonicalJson({
    v: RESULT_CACHE_VERSION,
    type: input.testType,
    code: input.code,
    // `null` and `undefined` are the same statement — this test has no spec.
    spec: input.spec ?? null,
    baseUrl: normalizeBaseUrl(input.baseUrl),
  });
  return createHash('sha256').update(payload).digest('hex');
}

export interface CacheCandidate {
  testId: string;
  name: string;
  testType: string;
  code: string;
  spec: unknown;
  quarantined: boolean;
  /** What impact analysis decided. Reuse is only ever offered for a skip. */
  impactDecision: 'run' | 'skip';
  /**
   * When this test row was last edited, from TestVersion. Null means "no edit
   * recorded inside the window", which — since every candidate result is itself
   * inside the window — means no edit since the result.
   */
  lastEditedAt: Date | null;
}

export interface PriorPass {
  resultId: string;
  runId: string;
  testId: string;
  status: string;
  retriedAndPassed: boolean;
  durationMs: number;
  createdAt: Date;
  /** The run that produced it: only a run that reported is evidence. */
  runStatus: string;
  runFinishedAt: Date | null;
  environmentId: string;
  /** `run.baseUrlOverride ?? environment.baseUrl`, as that run actually ran. */
  effectiveBaseUrl: string;
  /**
   * The cache key stored with the result.
   *
   * Null today: TestResult has no such column, so the key cannot be compared
   * directly and the weaker reconstruction below is used instead. The moment the
   * column exists and the worker writes it, this becomes the authoritative
   * check and the reconstruction stops being consulted.
   */
  cacheKey: string | null;
}

export interface CacheContext {
  environmentId: string;
  effectiveBaseUrl: string;
  /**
   * When the environment row last changed. A baseUrl edit is invisible to the
   * reconstruction — the result carries no record of the URL it ran against — so
   * any environment edit after a result disqualifies it.
   */
  environmentUpdatedAt: Date | null;
  now: Date;
  windowMs: number;
}

export interface CacheDecision {
  testId: string;
  name: string;
  reuse: boolean;
  /** One sentence, readable by whoever is deciding whether to trust this. */
  reason: string;
  cacheKey: string;
  /** How we know the test is unchanged. Absent when nothing is reused. */
  evidence?: 'stored-key' | 'reconstructed';
  source?: { runId: string; resultId: string; at: string; durationMs: number };
}

/** Runs that reported a verdict. A cancelled or errored run is a partial one. */
const REPORTED_RUN_STATUSES = new Set(['PASSED', 'FAILED']);

function hours(ms: number): string {
  const h = ms / 3_600_000;
  return h >= 1 ? `${Math.round(h)}h` : `${Math.round(ms / 60_000)}m`;
}

/**
 * Why this specific past result cannot be reused, or null if it can be.
 *
 * Every check is stated as a rejection so that adding one can only ever make the
 * cache colder. There is no branch in here that turns "unknown" into "reuse".
 */
function rejectPrior(
  candidate: CacheCandidate,
  prior: PriorPass,
  ctx: CacheContext,
  currentKey: string,
): { reason: string } | { evidence: 'stored-key' | 'reconstructed' } {
  // Only a clean pass. A FAILED, FLAKY, SKIPPED or TIMED_OUT result is never
  // evidence of anything, and this is checked here as well as in the query
  // because the query is an optimisation and this is the rule.
  if (prior.status !== 'PASSED') {
    return { reason: `its last result in this window was ${prior.status}, not a pass` };
  }
  if (prior.retriedAndPassed) {
    return {
      reason:
        'it passed only on a retry, and a retry that passes is not a pass — reusing it would launder a flake into a green',
    };
  }

  if (prior.environmentId !== ctx.environmentId) {
    return { reason: 'its last pass came from a different environment' };
  }
  if (normalizeBaseUrl(prior.effectiveBaseUrl) !== normalizeBaseUrl(ctx.effectiveBaseUrl)) {
    return {
      reason: `its last pass ran against ${prior.effectiveBaseUrl}, and this run targets ${ctx.effectiveBaseUrl}`,
    };
  }

  if (!REPORTED_RUN_STATUSES.has(prior.runStatus) || prior.runFinishedAt === null) {
    return {
      reason: `the run that produced it ended ${prior.runStatus.toLowerCase()} rather than reporting, so its results are a partial picture`,
    };
  }

  const age = ctx.now.getTime() - prior.createdAt.getTime();
  // A result timestamped in the future means a clock we cannot reason about.
  if (age < 0) return { reason: 'its last pass is timestamped in the future' };
  if (age > ctx.windowMs) {
    return { reason: `its last pass is ${hours(age)} old, past the ${hours(ctx.windowMs)} window` };
  }

  /*
   * The authoritative check, once results carry their key: the test's code, its
   * spec, the plugin and the base URL all hashed together at the moment the
   * result was written. Nothing has to be reconstructed and nothing is assumed.
   */
  if (prior.cacheKey !== null) {
    return prior.cacheKey === currentKey
      ? { evidence: 'stored-key' }
      : { reason: 'its code, spec, type or target URL has changed since that pass' };
  }

  /*
   * No stored key, so "has this test changed" is answered from history instead.
   *
   * Every path that writes `code` or `spec` also writes a TestVersion row — the
   * editor, an applied heal, the agent — so a version newer than the result is
   * exactly the signal that the test moved underneath it. This is weaker than a
   * stored key and it is treated as weaker: unknown edit history disqualifies.
   */
  if (
    candidate.lastEditedAt !== null &&
    candidate.lastEditedAt.getTime() >= prior.createdAt.getTime()
  ) {
    return { reason: 'it was edited after that pass' };
  }

  /*
   * The base URL comparison above used the environment as it is NOW. If the
   * environment row has been touched since the result, the URL it ran against
   * may not be the URL recorded today, and there is no way to find out.
   */
  if (ctx.environmentUpdatedAt === null) {
    return {
      reason:
        'we cannot tell when this environment last changed, so we cannot vouch for the URL that pass ran against',
    };
  }
  if (ctx.environmentUpdatedAt.getTime() >= prior.createdAt.getTime()) {
    return {
      reason:
        'the environment was changed after that pass, and its base URL may have moved with it',
    };
  }

  return { evidence: 'reconstructed' };
}

/**
 * Can this test's previous result stand in for running it?
 *
 * `priors` should be newest first; the first usable one wins, and if none is
 * usable the newest one's rejection is what gets reported, because that is the
 * one the reader is about to ask about.
 */
export function decideCacheReuse(
  candidate: CacheCandidate,
  priors: PriorPass[],
  ctx: CacheContext,
): CacheDecision {
  const cacheKey = resultCacheKey({
    testType: candidate.testType,
    code: candidate.code,
    spec: candidate.spec,
    baseUrl: ctx.effectiveBaseUrl,
  });

  const no = (reason: string): CacheDecision => ({
    testId: candidate.testId,
    name: candidate.name,
    reuse: false,
    reason,
    cacheKey,
  });

  /*
   * The gate that makes this feature safe at all: a result is only reusable for
   * a test the diff cannot reach. "Unchanged and recently green" says nothing
   * about a test the change DOES reach — that test was selected precisely
   * because the application under it moved, and its own code holding still is
   * irrelevant to whether it still passes.
   */
  if (candidate.impactDecision === 'run') {
    return no('the change can reach this test, so a previous pass says nothing about it');
  }

  // A quarantined test is one this system has already decided it does not
  // believe. Caching its pass would make an unreliable signal look settled.
  if (candidate.quarantined) {
    return no('it is quarantined, so its passes are not evidence');
  }

  if (priors.length === 0) {
    return no(`it has no clean pass in this environment inside the ${hours(ctx.windowMs)} window`);
  }

  let firstRejection: string | null = null;
  for (const prior of priors) {
    const verdict = rejectPrior(candidate, prior, ctx, cacheKey);
    if ('reason' in verdict) {
      firstRejection ??= verdict.reason;
      continue;
    }
    return {
      testId: candidate.testId,
      name: candidate.name,
      reuse: true,
      reason:
        verdict.evidence === 'stored-key'
          ? `unchanged since it passed ${hours(ctx.now.getTime() - prior.createdAt.getTime())} ago in run ${prior.runId}, and the change cannot reach it`
          : `no edit and no environment change since it passed ${hours(ctx.now.getTime() - prior.createdAt.getTime())} ago in run ${prior.runId}, and the change cannot reach it`,
      cacheKey,
      evidence: verdict.evidence,
      source: {
        runId: prior.runId,
        resultId: prior.resultId,
        at: prior.createdAt.toISOString(),
        durationMs: prior.durationMs,
      },
    };
  }

  return no(firstRejection ?? 'nothing in its history is usable');
}

/**
 * Group prior passes by test, preserving the order they came in.
 *
 * Three lines that live here rather than at the call site because getting them
 * wrong is invisible. The first version built each list with
 * `map.get(id) ?? []` and never wrote the fresh array back, so the map stayed
 * empty, every candidate fell through to "no clean pass in this window", and
 * the cache reported zero reusable results for every run ever made. Nothing
 * threw and nothing logged: the output was indistinguishable from a suite that
 * genuinely had no reusable passes, which is exactly what a cache failing
 * closed looks like from outside. Fail-closed is the right direction to fail,
 * and it is also the direction that hides a dead feature indefinitely.
 *
 * Order is preserved rather than re-sorted: `decideCacheReuse` documents that
 * priors arrive newest-first, and quietly re-sorting here would let a caller
 * hand over an unordered list and still be told which pass was "most recent".
 */
export function groupPriorsByTest(priors: PriorPass[]): Map<string, PriorPass[]> {
  const byTest = new Map<string, PriorPass[]>();
  for (const prior of priors) {
    const list = byTest.get(prior.testId);
    if (list) list.push(prior);
    else byTest.set(prior.testId, [prior]);
  }
  return byTest;
}

export interface CachePlan {
  considered: number;
  reusable: number;
  decisions: CacheDecision[];
}

/** Every candidate's decision, and the two numbers a caller actually reads. */
export function planCacheReuse(
  candidates: CacheCandidate[],
  priorsByTest: Map<string, PriorPass[]>,
  ctx: CacheContext,
): CachePlan {
  const decisions = candidates.map((candidate) =>
    decideCacheReuse(candidate, priorsByTest.get(candidate.testId) ?? [], ctx),
  );
  return {
    considered: decisions.length,
    reusable: decisions.filter((d) => d.reuse).length,
    decisions,
  };
}

// ─── Fail-fast ───────────────────────────────────────────────────────────────

export interface FailFastCandidate {
  status: string;
  retriedAndPassed: boolean;
  quarantined: boolean;
}

/**
 * Is this the failure a fail-fast run exists to stop on?
 *
 * Narrow on purpose. A fail-fast that trips on a flake, or on a test the org has
 * already quarantined precisely so it stops gating deploys, kills a run that had
 * real answers left to give — and the second time that happens the flag gets
 * turned off and never comes back. FAILED and TIMED_OUT are the two statuses
 * that mean "this build is broken"; everything else keeps the run going.
 */
export function isRealFailure(result: FailFastCandidate): boolean {
  if (result.quarantined) return false;
  if (result.retriedAndPassed) return false;
  return result.status === 'FAILED' || result.status === 'TIMED_OUT';
}

export interface FailFastPlan {
  requested: boolean;
  /** Whether the run will actually stop early. */
  enforced: boolean;
  reason: string;
}

/**
 * Fail-fast is accepted by the API and NOT yet enforced, and this function's job
 * is to make sure nobody has to find that out from a run that kept going.
 *
 * Stopping a run mid-flight is the worker's decision to act on and the run row's
 * to carry — that is how cancellation already works, and inventing a second
 * channel for the same idea (a queue message, a Redis flag) would give a sharded
 * run two sources of truth about whether it should still be running. The run row
 * has nowhere to put the request today: `Run` has no `failFast` column, and the
 * worker's between-tests poll reads only `status` and `finalizedAt`. Both
 * changes live in files this change does not own, so the honest thing is to say
 * so in the response rather than accept the flag and silently ignore it.
 */
export function planFailFast(requested: boolean): FailFastPlan {
  if (!requested) {
    return { requested: false, enforced: false, reason: 'not requested' };
  }
  return {
    requested: true,
    enforced: false,
    reason:
      'This run will execute every selected test. Stopping early needs a `Run.failFast` / `Run.stopRequestedAt` pair for the worker to poll between tests, alongside the cancellation check it already makes — until those exist the API accepts the flag and says, here, that it did nothing.',
  };
}
