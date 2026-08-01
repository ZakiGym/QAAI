/**
 * Safety tests for run selection.
 *
 * Like impact.ts, everything in run-selection.ts decides what NOT to do, so its
 * bugs do not show up as errors — they show up as a green check on a build that
 * was never tested. The contract is the same one, and it is the only thing these
 * tests are really checking: **any doubt resolves to running the test.**
 *
 * The cache gets the most attention because it is the most dangerous piece of
 * the three. It is the only one whose input is a claim about the PAST ("this
 * passed, and nothing has changed since"), and every one of the cases below is a
 * way that claim can be true-looking and false.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CACHE_WINDOW_HOURS,
  MAX_CACHE_WINDOW_HOURS,
  cacheWindowMs,
  canonicalJson,
  decideCacheReuse,
  groupPriorsByTest,
  isRealFailure,
  planCacheReuse,
  planFailFast,
  resultCacheKey,
  selectTestsForRun,
} from './run-selection.js';
import type { CacheCandidate, CacheContext, PriorPass } from './run-selection.js';
import type { ImpactTestInput } from './impact.js';

const HOUR = 3_600_000;
const NOW = new Date('2025-05-01T12:00:00.000Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

const BASE_URL = 'https://staging.example.com';

const candidate = (over: Partial<CacheCandidate> = {}): CacheCandidate => ({
  testId: 'test_1',
  name: 'Checkout completes',
  testType: 'E2E',
  code: "await page.goto('/checkout');",
  spec: null,
  quarantined: false,
  impactDecision: 'skip',
  lastEditedAt: null,
  ...over,
});

const prior = (over: Partial<PriorPass> = {}): PriorPass => ({
  resultId: 'res_1',
  runId: 'run_1',
  testId: 'test_1',
  status: 'PASSED',
  retriedAndPassed: false,
  durationMs: 4200,
  createdAt: ago(2 * HOUR),
  runStatus: 'PASSED',
  runFinishedAt: ago(2 * HOUR),
  environmentId: 'env_1',
  effectiveBaseUrl: BASE_URL,
  cacheKey: null,
  ...over,
});

const context = (over: Partial<CacheContext> = {}): CacheContext => ({
  environmentId: 'env_1',
  effectiveBaseUrl: BASE_URL,
  // Comfortably before the passing result, so the base URL it ran against is
  // still the base URL this environment has today.
  environmentUpdatedAt: ago(30 * 24 * HOUR),
  now: NOW,
  windowMs: 24 * HOUR,
  ...over,
});

// ─── The cache key ───────────────────────────────────────────────────────────

describe('the result cache key', () => {
  const key = (over: Partial<Parameters<typeof resultCacheKey>[0]> = {}): string =>
    resultCacheKey({
      testType: 'E2E',
      code: 'await page.goto("/")',
      spec: null,
      baseUrl: BASE_URL,
      ...over,
    });

  it('is stable for identical inputs', () => {
    expect(key()).toBe(key());
    expect(key()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the test code changes', () => {
    expect(key({ code: 'await page.goto("/checkout")' })).not.toBe(key());
  });

  it('changes when the spec changes', () => {
    expect(key({ spec: { method: 'GET' } })).not.toBe(key({ spec: { method: 'POST' } }));
  });

  it('changes when the base URL changes', () => {
    // The whole point of keying on it: a pass collected against staging is not
    // evidence about production, however identical the test is.
    expect(key({ baseUrl: 'https://prod.example.com' })).not.toBe(key());
  });

  it('changes when the plugin that runs it changes', () => {
    // The same `spec` means something completely different to the API plugin
    // and the accessibility one.
    expect(key({ testType: 'API', spec: { path: '/orders' } })).not.toBe(
      key({ testType: 'A11Y', spec: { path: '/orders' } }),
    );
  });

  it('does not change when the database hands the spec keys back in another order', () => {
    // Postgres has no obligation to preserve key order in a jsonb column, and a
    // cache whose hit rate depends on that would be a cache nobody could reason
    // about.
    expect(key({ spec: { a: 1, b: { c: 2, d: 3 } } })).toBe(
      key({ spec: { b: { d: 3, c: 2 }, a: 1 } }),
    );
  });

  it('treats a missing spec and a null spec as the same statement', () => {
    expect(key({ spec: undefined })).toBe(key({ spec: null }));
  });

  it('does not treat an empty spec as a missing one', () => {
    expect(key({ spec: {} })).not.toBe(key({ spec: null }));
  });

  it('ignores a trailing slash on the base URL and nothing else', () => {
    expect(key({ baseUrl: `${BASE_URL}/` })).toBe(key({ baseUrl: BASE_URL }));
    expect(key({ baseUrl: `${BASE_URL}/app` })).not.toBe(key({ baseUrl: BASE_URL }));
    expect(key({ baseUrl: 'http://staging.example.com' })).not.toBe(key({ baseUrl: BASE_URL }));
  });

  it('refuses to hash something it cannot canonicalise', () => {
    // Collapsing an unexpected value to null would silently equate two specs
    // that differ. Throwing surfaces the bug instead of caching through it.
    expect(() => canonicalJson({ onFail: () => undefined })).toThrow(TypeError);
  });

  it('keeps non-finite numbers hashable rather than throwing', () => {
    expect(canonicalJson({ timeout: Number.NaN })).toBe('{"timeout":null}');
  });
});

describe('the cache window', () => {
  it('defaults when nothing is asked for', () => {
    expect(cacheWindowMs(null)).toBe(DEFAULT_CACHE_WINDOW_HOURS * HOUR);
    expect(cacheWindowMs(undefined)).toBe(DEFAULT_CACHE_WINDOW_HOURS * HOUR);
  });

  it('clamps to a window a result can still be evidence for', () => {
    expect(cacheWindowMs(10_000)).toBe(MAX_CACHE_WINDOW_HOURS * HOUR);
    expect(cacheWindowMs(0)).toBe(HOUR);
    expect(cacheWindowMs(6)).toBe(6 * HOUR);
  });
});

// ─── Reuse fails open ────────────────────────────────────────────────────────

describe('a previous pass is only reused when nothing about it is in doubt', () => {
  it('reuses a clean recent pass for a test the change cannot reach', () => {
    // The baseline. Every test below changes exactly one thing about this case,
    // so a "no reuse" result means that one thing was decisive.
    const decision = decideCacheReuse(candidate(), [prior()], context());
    expect(decision.reuse).toBe(true);
    expect(decision.source?.runId).toBe('run_1');
    expect(decision.evidence).toBe('reconstructed');
  });

  it('never reuses for a test the change can reach', () => {
    // The load-bearing rule. "Unchanged and recently green" says nothing about a
    // test the diff reaches: it was selected precisely because the application
    // under it moved, and its own code holding still is beside the point.
    const decision = decideCacheReuse(candidate({ impactDecision: 'run' }), [prior()], context());
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toMatch(/can reach/i);
  });

  it('never reuses anything that is not a clean pass', () => {
    for (const status of ['FAILED', 'FLAKY', 'SKIPPED', 'TIMED_OUT']) {
      expect(decideCacheReuse(candidate(), [prior({ status })], context()).reuse).toBe(false);
    }
  });

  it('never reuses a pass that needed a retry', () => {
    // §5's rule, and the one a cache is most likely to launder: a flake reused
    // as a green becomes a permanent green.
    const decision = decideCacheReuse(candidate(), [prior({ retriedAndPassed: true })], context());
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toMatch(/retry/i);
  });

  it('never reuses across environments', () => {
    expect(
      decideCacheReuse(candidate(), [prior({ environmentId: 'env_other' })], context()).reuse,
    ).toBe(false);
  });

  it('never reuses a pass collected against another URL in the same environment', () => {
    // A preview-deploy run overrides the base URL. Its passes belong to that
    // deployment, not to this environment's.
    const decision = decideCacheReuse(
      candidate(),
      [prior({ effectiveBaseUrl: 'https://pr-42.preview.example.com' })],
      context(),
    );
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toMatch(/pr-42/);
  });

  it('never reuses a result from a run that did not report', () => {
    // A cancelled or errored run stopped somewhere in the middle. Its passing
    // rows are real, but the run they belong to never reached a verdict, and a
    // half-run suite is not a state to build further conclusions on.
    for (const runStatus of ['CANCELLED', 'ERRORED', 'RUNNING', 'QUEUED']) {
      expect(decideCacheReuse(candidate(), [prior({ runStatus })], context()).reuse).toBe(false);
    }
    expect(decideCacheReuse(candidate(), [prior({ runFinishedAt: null })], context()).reuse).toBe(
      false,
    );
  });

  it('expires a pass older than the window', () => {
    const decision = decideCacheReuse(
      candidate(),
      [prior({ createdAt: ago(25 * HOUR) })],
      context(),
    );
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toMatch(/window/);
  });

  it('honours a shorter window than the default', () => {
    const priors = [prior({ createdAt: ago(3 * HOUR) })];
    expect(decideCacheReuse(candidate(), priors, context()).reuse).toBe(true);
    expect(decideCacheReuse(candidate(), priors, context({ windowMs: HOUR })).reuse).toBe(false);
  });

  it('refuses a result timestamped in the future', () => {
    // A clock we cannot reason about is not a clock we can age a result with.
    const decision = decideCacheReuse(
      candidate(),
      [prior({ createdAt: new Date(NOW.getTime() + HOUR) })],
      context(),
    );
    expect(decision.reuse).toBe(false);
  });

  it('refuses when the test was edited after the pass', () => {
    const decision = decideCacheReuse(
      candidate({ lastEditedAt: ago(HOUR) }),
      [prior({ createdAt: ago(2 * HOUR) })],
      context(),
    );
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toMatch(/edited/);
  });

  it('accepts an edit that happened before the pass', () => {
    const decision = decideCacheReuse(
      candidate({ lastEditedAt: ago(5 * HOUR) }),
      [prior({ createdAt: ago(2 * HOUR) })],
      context(),
    );
    expect(decision.reuse).toBe(true);
  });

  it('refuses when the environment changed after the pass', () => {
    // The base URL comparison uses the environment as it is NOW. If the row has
    // been touched since, the URL that pass ran against may not be the one we
    // just compared it to, and nothing records what it was.
    const decision = decideCacheReuse(
      candidate(),
      [prior({ createdAt: ago(2 * HOUR) })],
      context({ environmentUpdatedAt: ago(HOUR) }),
    );
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toMatch(/environment was changed/);
  });

  it('refuses when it cannot tell whether the environment changed', () => {
    const decision = decideCacheReuse(
      candidate(),
      [prior()],
      context({ environmentUpdatedAt: null }),
    );
    expect(decision.reuse).toBe(false);
  });

  it('refuses for a quarantined test', () => {
    // The system has already decided it does not believe this test. Caching its
    // pass would make a signal we distrust look settled.
    expect(decideCacheReuse(candidate({ quarantined: true }), [prior()], context()).reuse).toBe(
      false,
    );
  });

  it('refuses when there is no history at all', () => {
    const decision = decideCacheReuse(candidate(), [], context());
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toMatch(/no clean pass/);
  });

  it('reports why the newest result was rejected, not the oldest', () => {
    // The reader is about to ask about the most recent one.
    const decision = decideCacheReuse(
      candidate(),
      [prior({ retriedAndPassed: true }), prior({ resultId: 'res_0', environmentId: 'env_other' })],
      context(),
    );
    expect(decision.reason).toMatch(/retry/i);
  });

  it('falls through to an older result when the newest is unusable', () => {
    const decision = decideCacheReuse(
      candidate(),
      [
        prior({ resultId: 'res_2', runId: 'run_2', createdAt: ago(HOUR), retriedAndPassed: true }),
        prior({ resultId: 'res_1', runId: 'run_1', createdAt: ago(3 * HOUR) }),
      ],
      context(),
    );
    expect(decision.reuse).toBe(true);
    expect(decision.source?.runId).toBe('run_1');
  });
});

describe('a stored cache key overrules the reconstruction', () => {
  const currentKey = (c: CacheCandidate, ctx: CacheContext): string =>
    resultCacheKey({
      testType: c.testType,
      code: c.code,
      spec: c.spec,
      baseUrl: ctx.effectiveBaseUrl,
    });

  it('reuses when the stored key matches, even if the test was edited and edited back', () => {
    const c = candidate({ lastEditedAt: ago(HOUR) });
    const ctx = context();
    const decision = decideCacheReuse(
      c,
      [prior({ createdAt: ago(2 * HOUR), cacheKey: currentKey(c, ctx) })],
      ctx,
    );
    expect(decision.reuse).toBe(true);
    expect(decision.evidence).toBe('stored-key');
  });

  it('refuses when the stored key differs, however clean everything else looks', () => {
    const decision = decideCacheReuse(
      candidate(),
      [prior({ cacheKey: 'a-key-from-different-code' })],
      context(),
    );
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toMatch(/changed since/);
  });
});

describe('planCacheReuse', () => {
  it('counts what is reusable and answers for every candidate', () => {
    const plan = planCacheReuse(
      [candidate(), candidate({ testId: 'test_2', name: 'Cart' })],
      new Map([['test_1', [prior()]]]),
      context(),
    );
    expect(plan.considered).toBe(2);
    expect(plan.reusable).toBe(1);
    expect(plan.decisions.map((d) => d.testId)).toEqual(['test_1', 'test_2']);
    // A test with no history is answered, not omitted — "why is this one not
    // cached" has to have an answer too.
    expect(plan.decisions[1]?.reason).toMatch(/no clean pass/);
  });
});

describe('groupPriorsByTest', () => {
  it('keeps every prior, not just the last one seen per test', () => {
    const a1 = prior({ resultId: 'r1', testId: 'test_1' });
    const a2 = prior({ resultId: 'r2', testId: 'test_1' });
    const b1 = prior({ resultId: 'r3', testId: 'test_2' });

    const grouped = groupPriorsByTest([a1, a2, b1]);

    expect(grouped.size).toBe(2);
    expect(grouped.get('test_1')?.map((p) => p.resultId)).toEqual(['r1', 'r2']);
    expect(grouped.get('test_2')?.map((p) => p.resultId)).toEqual(['r3']);
  });

  it('preserves the order it was given, because callers rely on newest-first', () => {
    const newest = prior({ resultId: 'newest', createdAt: new Date('2024-05-02T00:00:00Z') });
    const older = prior({ resultId: 'older', createdAt: new Date('2024-05-01T00:00:00Z') });

    expect(groupPriorsByTest([newest, older]).get('test_1')?.map((p) => p.resultId)).toEqual([
      'newest',
      'older',
    ]);
  });

  /*
   * The regression this function exists for. Built inline, the grouping used
   * `map.get(id) ?? []` without writing the fresh array back; the map came out
   * empty, every candidate was told it had "no clean pass in this window", and
   * the cache reported zero reusable results for every run. It threw nothing and
   * logged nothing — a dead cache and an genuinely cold one look identical from
   * outside, which is why this asserts on a reuse decision rather than on the
   * map's shape.
   */
  it('feeds planCacheReuse priors it will actually use', () => {
    const plan = planCacheReuse([candidate()], groupPriorsByTest([prior()]), context());

    expect(plan.reusable).toBe(1);
    expect(plan.decisions[0]?.reuse).toBe(true);
  });
});

// ─── Selection ───────────────────────────────────────────────────────────────

const t = (over: Partial<ImpactTestInput> & { id: string }): ImpactTestInput => ({
  name: over.id,
  filePath: `specs/${over.id}.spec.ts`,
  code: null,
  spec: null,
  tags: [],
  feature: null,
  priority: 'IMPORTANT',
  ...over,
});

const checkout = t({
  id: 'checkout',
  name: 'Checkout completes',
  code: "await page.goto('/checkout');",
  priority: 'CRITICAL_PATH',
});
const about = t({ id: 'about', name: 'About renders', code: "await page.goto('/about');" });

describe('selecting the tests a run executes', () => {
  it('runs only what the diff can reach', () => {
    const selection = selectTestsForRun({
      changedPaths: ['app/about/page.tsx'],
      tests: [checkout, about],
    });
    expect(selection.testIds).toEqual(['about']);
    expect(selection.analysis.skip.map((d) => d.testId)).toEqual(['checkout']);
    expect(selection.fallbackReason).toBeNull();
  });

  it('runs everything when the diff cannot be attributed', () => {
    // A lockfile bump can change any page, so there is nothing to rule out.
    const selection = selectTestsForRun({
      changedPaths: ['package-lock.json'],
      tests: [checkout, about],
    });
    expect(selection.testIds.sort()).toEqual(['about', 'checkout']);
    expect(selection.analysis.strategy).toBe('RUN_EVERYTHING');
  });

  it('never selects a test that was not a candidate', () => {
    // The analysis is handed the candidate set, and the result is intersected
    // with it anyway: an id this run was not asked to execute must not appear
    // just because the analysis mentioned it.
    const selection = selectTestsForRun({
      changedPaths: ['app/about/page.tsx'],
      tests: [about],
    });
    expect(selection.testIds).toEqual(['about']);
  });

  it('reports a fallback rather than an empty run', () => {
    // A selection of nothing reaches a human as a green run over zero tests,
    // which is the most convincing lie this system could tell.
    const selection = selectTestsForRun({ changedPaths: ['app/about/page.tsx'], tests: [] });
    expect(selection.fallbackReason).toMatch(/selected no test/);
  });
});

// ─── Fail-fast ───────────────────────────────────────────────────────────────

describe('what counts as a real failure', () => {
  const result = (over: Partial<Parameters<typeof isRealFailure>[0]> = {}) => ({
    status: 'FAILED',
    retriedAndPassed: false,
    quarantined: false,
    ...over,
  });

  it('stops on a failure and on a timeout', () => {
    expect(isRealFailure(result())).toBe(true);
    expect(isRealFailure(result({ status: 'TIMED_OUT' }))).toBe(true);
  });

  it('does not stop on a pass, a skip, or a flake', () => {
    for (const status of ['PASSED', 'SKIPPED', 'FLAKY']) {
      expect(isRealFailure(result({ status }))).toBe(false);
    }
  });

  it('does not stop on a test that passed on retry', () => {
    expect(isRealFailure(result({ retriedAndPassed: true }))).toBe(false);
  });

  it('does not stop on a quarantined test', () => {
    // Quarantine exists so a flaky test stops gating deploys. Letting one end
    // the whole run would give it more power than an ordinary test, not less.
    expect(isRealFailure(result({ quarantined: true }))).toBe(false);
  });
});

describe('planFailFast', () => {
  it('says plainly that a requested stop will not happen', () => {
    // The failure mode this exists to prevent: a caller believing their runs
    // stop early while every one of them has been running to the end.
    const plan = planFailFast(true);
    expect(plan.requested).toBe(true);
    expect(plan.enforced).toBe(false);
    expect(plan.reason).toMatch(/every selected test/i);
  });

  it('is silent when nobody asked', () => {
    expect(planFailFast(false)).toMatchObject({ requested: false, enforced: false });
  });
});
