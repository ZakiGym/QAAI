/**
 * The preflight, and the three ways a preflight can be worse than none.
 *
 * It is easy to write a check that asks "is the environment healthy?" and gets
 * a plausible answer. Every assertion in this file is about one of the three
 * ways that plausible answer destroys a product:
 *
 *  1. REFUSING A RUN THAT WOULD HAVE WORKED. A false negative here does not
 *     cost one test, it cancels a whole suite — so a 500 from the application
 *     counts as reachable (it is very possibly the bug), one unlucky packet is
 *     retried, a malformed base URL is a configuration error rather than an
 *     outage, and anything that could not be checked blocks nothing at all.
 *
 *  2. CLAIMING A CAPABILITY NOBODY VERIFIED. `satisfied: null` is a
 *     first-class answer and is never rounded to true. "`k6` resolves on PATH"
 *     is the claim this file makes; "k6 works" is the claim it refuses to make,
 *     because it never executes anything.
 *
 *  3. BLAMING THE WRONG THING. A deleted auth profile and a rotated password
 *     both arrive as "could not sign in" and have opposite remedies — and
 *     opposite consequences, since one must gate and the other must not.
 *
 * Every probe is injected. A unit test that reaches the network is not a unit
 * test, and a suite that fails on a train is a suite people delete.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  checkRunnability,
  environmentBlock,
  environmentPreflight,
  fetchProbe,
  probeBaseUrl,
  probeIdentities,
  preflightSummary,
  repoWorkspaceCheck,
  unattemptable,
  ALL_TEST_TYPES,
  PREFLIGHT_PROBE_ATTEMPTS,
  TYPE_REQUIREMENTS,
} from './preflight.js';
import type { RunnabilityProbes, UrlProbeResult } from './preflight.js';
import { TEST_TYPES } from '@qaai/shared';
import type { TestType } from '@qaai/shared';

const BASE = 'https://staging.example.com';

const answered = (status: number): UrlProbeResult => ({
  reached: true,
  status,
  detail: `answered HTTP ${status}`,
});
const refused: UrlProbeResult = {
  reached: false,
  status: null,
  detail: 'the connection was refused',
};

/** A prober that records every call, so the retry policy is observable. */
function recordingProbe(results: UrlProbeResult[]) {
  const calls: string[] = [];
  return {
    calls,
    probe: async (url: string): Promise<UrlProbeResult> => {
      calls.push(url);
      return results[Math.min(calls.length - 1, results.length - 1)]!;
    },
  };
}

/** Everything present, as a healthy image would answer. */
const everything: RunnabilityProbes = {
  onPath: () => true,
  browserInstalled: () => true,
  platform: 'linux',
};

const noSleep = async (): Promise<void> => {};

// ─────────────────────────────────────────────────────────────────────────────
// The base URL
// ─────────────────────────────────────────────────────────────────────────────

describe('probing the base URL', () => {
  it('counts any HTTP response as reachable, a 500 included', async () => {
    /*
     * The most consequential assertion in this file. A 5xx from the app under
     * test is very possibly THE BUG, and a preflight that read it as "the
     * environment is down" would suppress exactly the run that was about to
     * catch an outage — turning the instrument into the thing that hides the
     * fault.
     */
    for (const status of [200, 302, 401, 404, 500, 503]) {
      const { probe, calls } = recordingProbe([answered(status)]);
      const check = await probeBaseUrl({ baseUrl: BASE, types: ['E2E'], probe, sleep: noSleep });
      expect(check.outcome, `HTTP ${status}`).toBe('OK');
      expect(check.blocksTypes).toEqual([]);
      expect(calls).toHaveLength(1);
    }
  });

  it('says so in the detail, so nobody re-litigates the 5xx rule from the code', async () => {
    const { probe } = recordingProbe([answered(500)]);
    const check = await probeBaseUrl({ baseUrl: BASE, types: ['E2E'], probe, sleep: noSleep });
    expect(check.detail).toMatch(/any status counts/i);
    expect(check.detail).toMatch(/may be the bug under test/i);
  });

  it('blocks only the types that actually reach the environment over HTTP', async () => {
    /*
     * A dead base URL says nothing about a CLI test, a DATABASE test or a
     * MUTATION run — they reach their target by a route this check never looked
     * at. Blocking the whole suite on one check is how a preflight starts
     * eating runs it had no business stopping.
     */
    const { probe } = recordingProbe([refused]);
    const check = await probeBaseUrl({
      baseUrl: BASE,
      types: ['E2E', 'CLI', 'DATABASE', 'API', 'MUTATION', 'PROTOCOL'],
      probe,
      sleep: noSleep,
    });

    expect(check.outcome).toBe('UNAVAILABLE');
    expect([...check.blocksTypes].sort()).toEqual(['API', 'E2E']);
  });

  it('retries before condemning the run, and stops at the first success', async () => {
    const { probe, calls } = recordingProbe([refused, answered(200)]);
    const sleeps: number[] = [];

    const check = await probeBaseUrl({
      baseUrl: BASE,
      types: ['E2E'],
      probe,
      sleep: async (ms) => void sleeps.push(ms),
    });

    expect(check.outcome).toBe('OK');
    expect(calls).toHaveLength(2);
    // One backoff, between the two attempts — not after the last one.
    expect(sleeps).toHaveLength(1);
    expect(check.detail).toMatch(/on attempt 2 of 3/);
  });

  it('gives up only after the documented number of attempts', async () => {
    const { probe, calls } = recordingProbe([refused]);
    const check = await probeBaseUrl({ baseUrl: BASE, types: ['E2E'], probe, sleep: noSleep });

    expect(calls).toHaveLength(PREFLIGHT_PROBE_ATTEMPTS);
    expect(check.outcome).toBe('UNAVAILABLE');
    expect(check.detail).toMatch(/on all 3 attempts/);
    expect(check.kind).toBe('BLOCKED_BY_ENV');
  });

  it('does not probe at all for a suite that never touches the base URL', async () => {
    // Nothing to be right or wrong about, and a request nobody needed is a
    // request somebody else's server has to answer.
    const { probe, calls } = recordingProbe([answered(200)]);
    const check = await probeBaseUrl({
      baseUrl: BASE,
      types: ['CLI', 'DATABASE'],
      probe,
      sleep: noSleep,
    });

    expect(calls).toEqual([]);
    expect(check.outcome).toBe('UNKNOWN');
    expect(check.blocksTypes).toEqual([]);
  });

  it('treats a malformed base URL as configuration, never as an outage', async () => {
    /*
     * A typo in an environment's base URL and a down staging box are different
     * problems with different owners. Reporting the first as the second sends
     * somebody to check a VPN over a missing colon — and, worse, blocks a run
     * on a fact the probe never established.
     */
    for (const bad of ['not a url', 'staging.example.com', 'ftp://files.example.com']) {
      const { probe, calls } = recordingProbe([refused]);
      const check = await probeBaseUrl({ baseUrl: bad, types: ['E2E'], probe, sleep: noSleep });
      expect(check.outcome, bad).toBe('UNKNOWN');
      expect(check.blocksTypes).toEqual([]);
      expect(calls).toEqual([]);
    }
  });

  it('survives a prober that throws, rather than escaping into the run', async () => {
    // A broken prober is a bug in the prober, not evidence about the
    // environment — and this function must never be the reason a run fails to
    // start with an exception instead of a verdict.
    const check = await probeBaseUrl({
      baseUrl: BASE,
      types: ['E2E'],
      probe: async () => {
        throw new Error('probe exploded');
      },
      sleep: noSleep,
    });

    expect(check.outcome).toBe('UNAVAILABLE');
    expect(check.detail).toMatch(/the probe itself failed/);
  });
});

describe('the default prober', () => {
  it('names the failure class and never echoes the URL', async () => {
    /*
     * A base URL can carry a token in its query string, and `fetch` puts the
     * whole URL in its error message. Echoing that into a run's errorMessage —
     * which ends up in a PR comment and a Slack message — would leak it. The
     * failure CLASS is the diagnosis anyway.
     */
    const secret = 'https://staging.example.com/?token=SUPERSECRET';
    const cases: Array<[string, RegExp]> = [
      ['ECONNREFUSED', /connection was refused/],
      ['ENOTFOUND', /hostname does not resolve/],
      ['ECONNRESET', /connection was reset/],
      ['CERT_HAS_EXPIRED', /TLS certificate was rejected/],
    ];

    for (const [code, expected] of cases) {
      const stub = vi.fn(async () => {
        throw Object.assign(new Error(`fetch failed for ${secret}`), { cause: { code } });
      });
      vi.stubGlobal('fetch', stub);
      try {
        const result = await fetchProbe(secret, 50);
        expect(result.reached, code).toBe(false);
        expect(result.detail).toMatch(expected);
        expect(result.detail).not.toContain('SUPERSECRET');
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it('reports a timeout as a timeout, with the budget it was given', async () => {
    const stub = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    vi.stubGlobal('fetch', stub);
    try {
      const result = await fetchProbe(BASE, 10_000);
      expect(result.detail).toMatch(/did not answer within 10s/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads a response as reachable whatever its status', async () => {
    const stub = vi.fn(async () => ({ status: 503, body: null }));
    vi.stubGlobal('fetch', stub);
    try {
      expect(await fetchProbe(BASE, 100)).toMatchObject({ reached: true, status: 503 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Runnability
// ─────────────────────────────────────────────────────────────────────────────

describe('what this deployment can execute', () => {
  it('refuses LOAD on an image with no k6, and says how to install it', async () => {
    const [load] = await checkRunnability(['LOAD'], {
      probes: { ...everything, onPath: (binary) => binary !== 'k6' },
    });

    expect(load!.runnable).toBe(false);
    expect(load!.missing).toHaveLength(1);
    expect(load!.reason).toMatch(/cannot execute LOAD tests/);
    expect(load!.reason).toMatch(/brew install k6/);
    // A refusal that does not disclaim the application is a refusal that reads
    // as a verdict on it.
    expect(load!.reason).toMatch(/Nothing here is a verdict on your application/i);
  });

  it('allows LOAD when k6 resolves, and claims only that it resolved', async () => {
    const [load] = await checkRunnability(['LOAD'], { probes: everything });

    expect(load!.runnable).toBe(true);
    expect(load!.requirements[0]!.detail).toMatch(/resolves on PATH/);
    // The weaker claim, in writing. Nothing was executed.
    expect(load!.requirements[0]!.detail).toMatch(/not executed/);
  });

  it('says a type that needs nothing needs nothing', async () => {
    // An empty requirement list is a real answer and is NOT the same as an
    // unknown one: API and SECURITY_SMOKE need only the environment itself.
    const report = await checkRunnability(['API', 'SECURITY_SMOKE'], { probes: everything });

    for (const entry of report) {
      expect(entry.runnable, entry.type).toBe(true);
      expect(entry.reason).toMatch(/needs nothing beyond the environment under test/);
    }
  });

  it('reports a missing tool without promising a result it cannot deliver', async () => {
    /*
     * Two kinds of absence hide behind one `degraded` list and the sentence has
     * to cover both: a missing Lighthouse costs a PERFORMANCE test its audit
     * detail and nothing else, while a missing macOS worker means an XCUITest
     * spec refuses itself. "Reduced detail" would be a promise for the second.
     */
    const [mobile] = await checkRunnability(['MOBILE'], { probes: everything });
    expect(mobile!.reason).toMatch(/Not present on this worker/);
    expect(mobile!.reason).toMatch(/will say so itself/);
  });

  it('never refuses a type whose missing tool is optional', async () => {
    /*
     * plugins/performance.ts falls back to its own collector when Lighthouse is
     * absent — "which costs the audit detail and nothing else" — so refusing
     * the test would refuse one that works. Degraded is reported; it does not
     * block.
     */
    const [performance] = await checkRunnability(['PERFORMANCE'], {
      probes: { ...everything, onPath: (binary) => binary !== 'lighthouse' },
    });

    expect(performance!.runnable).toBe(true);
    expect(performance!.missing).toEqual([]);
    expect(performance!.degraded).toHaveLength(1);
    expect(performance!.reason).toMatch(/can run here/);
    expect(performance!.reason).toMatch(/lighthouse/);
  });

  it('never refuses a type whose engines its own spec chooses', async () => {
    // `browserProjects` in plugins/matrix.ts always includes chromium, so that
    // one is required; which others a test wants is in its spec, so a missing
    // WebKit is a fact about the image and not a reason to refuse a
    // chromium+firefox matrix.
    const [matrix] = await checkRunnability(['CROSS_BROWSER'], {
      probes: { ...everything, browserInstalled: (engine) => engine !== 'webkit' },
    });

    expect(matrix!.runnable).toBe(true);
    expect(matrix!.degraded.map((r) => (r.kind === 'BROWSER' ? r.name : ''))).toEqual(['webkit']);
  });

  it('refuses CROSS_BROWSER when even the default engine is missing', async () => {
    const [matrix] = await checkRunnability(['CROSS_BROWSER'], {
      probes: { ...everything, browserInstalled: (engine) => engine !== 'chromium' },
    });

    expect(matrix!.runnable).toBe(false);
    expect(matrix!.reason).toMatch(/npx playwright install/);
  });

  it('does not refuse MOBILE on Linux, because only one of its five drivers needs macOS', async () => {
    /*
     * `xcodebuild` only exists on macOS and only XCUITest uses it. A type-level
     * refusal would refuse the Appium, Maestro, Detox and Gradle tests that
     * have no use for it — four fifths of the feature.
     */
    const [mobile] = await checkRunnability(['MOBILE'], { probes: everything });

    expect(mobile!.runnable).not.toBe(false);
    expect(mobile!.missing).toEqual([]);
    expect(mobile!.degraded.map((r) => r.kind)).toEqual(['PLATFORM']);
  });

  it('claims nothing about a type whose every requirement is named by its spec', async () => {
    // MUTATION's tool is whatever the spec says — usually a dev dependency of
    // the customer's own repository, not a binary on this image — so there is
    // nothing here to be right about, and `null` says exactly that.
    const [mutation] = await checkRunnability(['MUTATION'], { probes: everything });

    expect(mutation!.runnable).toBeNull();
    expect(mutation!.missing).toEqual([]);
    expect(mutation!.reason).toMatch(/depends on each test's own spec/);
    expect(mutation!.reason).toMatch(/Not claimed either way/);
  });

  it('answers null — never false — when a probe could not tell', async () => {
    /*
     * Honesty rule 2. A browser whose install state could not be determined
     * must not be reported as missing (that refuses a working test) and must
     * not be reported as present (that claims a capability nobody verified).
     */
    const [e2e] = await checkRunnability(['E2E'], {
      probes: { ...everything, browserInstalled: () => null },
    });

    expect(e2e!.runnable).toBeNull();
    expect(e2e!.missing).toEqual([]);
    expect(e2e!.requirements[0]!.satisfied).toBeNull();
    expect(e2e!.requirements[0]!.detail).toMatch(/could not be determined/);
  });

  it('reports a type with no plugin as unfixable by installing anything', async () => {
    const [report] = await checkRunnability(['LOAD'], {
      probes: everything,
      pluginless: (type) => `No runner plugin registered for ${type}`,
    });

    expect(report!.runnable).toBe(false);
    expect(report!.reason).toMatch(/No runner plugin registered for LOAD/);
    // And it does not then go on to blame PATH for it.
    expect(report!.requirements).toEqual([]);
  });

  it('answers once per type, however often it is asked', async () => {
    const report = await checkRunnability(['E2E', 'E2E', 'API', 'E2E'], { probes: everything });
    expect(report.map((r) => r.type)).toEqual(['E2E', 'API']);
  });

  it('has a requirement list for every type the product claims to support', async () => {
    /*
     * The gap this closes is a silent one: a type added to TEST_TYPES with no
     * entry here would read as "nothing to check", which is the "needs nothing"
     * answer API legitimately gives — so a new type needing k6 would be
     * reported as runnable on an image that cannot run it. Reading the key off
     * the record is what makes the omission a test failure instead of a wrong
     * answer.
     */
    for (const type of TEST_TYPES) {
      expect(TYPE_REQUIREMENTS[type], type).toBeDefined();
    }
    expect(ALL_TEST_TYPES).toHaveLength(TEST_TYPES.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Identities
// ─────────────────────────────────────────────────────────────────────────────

describe('probing the identities a suite needs', () => {
  const identity = (testIds: string[]) => ({
    profileId: 'p_admin',
    label: 'the admin role',
    testIds,
  });

  it('asks once per profile, not once per test', async () => {
    // Thirty tests behind one profile is one credential to check. Asking thirty
    // times is thirty browser launches against an app that will answer
    // identically — which is the cost that made this worth getting right.
    const signIn = vi.fn(async () => ({ ok: true as const }));
    const checks = await probeIdentities({
      identities: [identity(['t1', 't2', 't3'])],
      signIn,
    });

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.outcome).toBe('OK');
  });

  it('blocks the tests behind a credential the application refused', async () => {
    const checks = await probeIdentities({
      identities: [identity(['t1', 't2'])],
      signIn: async () => ({ ok: false as const, fault: 'ENVIRONMENT', why: 'password rejected' }),
    });

    expect(checks[0]!.outcome).toBe('UNAVAILABLE');
    expect(checks[0]!.blocksTestIds).toEqual(['t1', 't2']);
    expect(checks[0]!.detail).toMatch(/no longer works/);
    expect(checks[0]!.detail).toMatch(/Nothing here is a verdict on your application/i);
  });

  it('blocks NOTHING when the binding is broken rather than the environment', async () => {
    /*
     * Honesty rule 3, and the one with teeth. A test pointing at a profile
     * somebody deleted is a defect in the SUITE and has to gate — a skip does
     * not block a gate, so filing it as "the environment" would let a suite
     * whose permission tests stopped running keep merging green. The run's own
     * session path records those as failures, which is why this check blocks
     * nothing and reports UNKNOWN.
     */
    const checks = await probeIdentities({
      identities: [identity(['t1'])],
      signIn: async () => ({ ok: false as const, fault: 'CONFIG', why: 'profile was deleted' }),
    });

    expect(checks[0]!.outcome).toBe('UNKNOWN');
    expect(checks[0]!.blocksTestIds).toEqual([]);
    expect(checks[0]!.detail).toMatch(/broken rather than the environment/);
    expect(checks[0]!.detail).toMatch(/defect in the suite and not an outage/);
  });

  it('treats a resolver that throws as an environment fault', async () => {
    const checks = await probeIdentities({
      identities: [identity(['t1'])],
      signIn: async () => {
        throw new Error('the browser died');
      },
    });

    expect(checks[0]!.outcome).toBe('UNAVAILABLE');
    expect(checks[0]!.detail).toMatch(/signing in threw/);
  });

  it('ignores an identity no test in this run actually needs', async () => {
    const signIn = vi.fn(async () => ({ ok: true as const }));
    expect(await probeIdentities({ identities: [identity([])], signIn })).toEqual([]);
    expect(signIn).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The whole preflight, and the decisions it hands back
// ─────────────────────────────────────────────────────────────────────────────

describe('the environment preflight', () => {
  it('does not drive a login at a host that is not listening', async () => {
    /*
     * A failed login against a dead host measures the host a second time and
     * reports it as a credential problem — sending the reader to rotate a
     * password that was never broken. The LOGIN check says so explicitly
     * instead of being silently absent, because an absent check is
     * indistinguishable from a check that passed.
     */
    const signIn = vi.fn(async () => ({ ok: true as const }));
    const pre = await environmentPreflight({
      baseUrl: BASE,
      types: ['E2E'],
      probes: everything,
      probe: async () => refused,
      sleep: noSleep,
      identities: [{ profileId: 'p', label: 'the admin role', testIds: ['t1'] }],
      signIn,
    });

    expect(signIn).not.toHaveBeenCalled();
    const login = pre.checks.find((c) => c.name === 'LOGIN');
    expect(login!.outcome).toBe('UNKNOWN');
    expect(login!.detail).toMatch(/did not answer/);
  });

  it('reports the first thing that is wrong as the run-level reason', async () => {
    const pre = await environmentPreflight({
      baseUrl: BASE,
      types: ['E2E'],
      probes: everything,
      probe: async () => refused,
      sleep: noSleep,
    });

    expect(pre.reason).toMatch(/connection was refused/);
    expect(preflightSummary(pre)).toMatch(/connection was refused/);
  });

  it('says so plainly when there is nothing wrong', async () => {
    const pre = await environmentPreflight({
      baseUrl: BASE,
      types: ['E2E'],
      probes: everything,
      probe: async () => answered(200),
      sleep: noSleep,
    });

    expect(pre.reason).toBeNull();
    expect(preflightSummary(pre)).toBe('Environment preflight passed.');
  });

  it('explains tooling before the environment, because installing comes first', async () => {
    /*
     * The order of `checks` is the order of explanation, and it is load-bearing:
     * an image with no k6 will still have no k6 after the VPN is fixed, so the
     * tooling answer is the one a reader can act on first.
     */
    const pre = await environmentPreflight({
      baseUrl: BASE,
      types: ['LOAD'],
      probes: { ...everything, onPath: () => false },
      probe: async () => refused,
      sleep: noSleep,
    });

    expect(pre.checks.map((c) => c.name)).toEqual(['TOOLING', 'BASE_URL']);
    const block = environmentBlock(pre, { id: 't1', type: 'LOAD' });
    expect(block!.kind).toBe('UNSUPPORTED');
    expect(block!.check).toBe('TOOLING');
  });

  it('carries a repository gap the caller already established', async () => {
    const pre = await environmentPreflight({
      baseUrl: BASE,
      types: ['UNIT_GEN'],
      probes: everything,
      probe: async () => answered(200),
      sleep: noSleep,
      contributed: [
        repoWorkspaceCheck({ available: false, why: 'No connected repository.', testIds: ['t1'] }),
      ],
    });

    expect(environmentBlock(pre, { id: 't1', type: 'UNIT_GEN' })).toMatchObject({
      kind: 'BLOCKED_BY_ENV',
      check: 'REPO_WORKSPACE',
    });
    // A test the gap does not cover is untouched by it.
    expect(environmentBlock(pre, { id: 't2', type: 'UNIT_GEN' })).toBeNull();
  });
});

describe('deciding whether a run could be attempted at all', () => {
  const blockedPreflight = async (types: readonly TestType[]) =>
    environmentPreflight({
      baseUrl: BASE,
      types,
      probes: everything,
      probe: async () => refused,
      sleep: noSleep,
    });

  it('is unattemptable only when EVERY test is blocked', async () => {
    /*
     * The threshold, and it is deliberately the strict one. A suite in which
     * one role's password rotated still has 400 tests worth of signal, and
     * refusing to run them would turn a small environment fault into a total
     * loss of it.
     */
    const pre = await blockedPreflight(['E2E', 'CLI']);

    expect(unattemptable(pre, [{ id: 't1', type: 'E2E' }])).toBe(true);
    expect(
      unattemptable(pre, [
        { id: 't1', type: 'E2E' },
        { id: 't2', type: 'CLI' },
      ]),
    ).toBe(false);
  });

  it('is never true for an empty suite', async () => {
    // "Nothing could be attempted" over nothing is vacuously true and would
    // report ENVIRONMENT_UNAVAILABLE for a run that selected no tests, which is
    // a different bug with a different fix.
    expect(unattemptable(await blockedPreflight(['E2E']), [])).toBe(false);
  });

  it('blocks nothing when every check passed', async () => {
    const pre = await environmentPreflight({
      baseUrl: BASE,
      types: ['E2E'],
      probes: everything,
      probe: async () => answered(204),
      sleep: noSleep,
    });

    expect(environmentBlock(pre, { id: 't1', type: 'E2E' })).toBeNull();
    expect(unattemptable(pre, [{ id: 't1', type: 'E2E' }])).toBe(false);
  });

  it('blocks nothing on a check that could not be made', async () => {
    // Honesty rule: UNKNOWN is never rounded to UNAVAILABLE. A browser whose
    // install state is undeterminable must not refuse the test.
    const pre = await environmentPreflight({
      baseUrl: 'not a url',
      types: ['E2E'],
      probes: { ...everything, browserInstalled: () => null },
      probe: async () => refused,
      sleep: noSleep,
    });

    expect(pre.checks.every((c) => c.outcome !== 'UNAVAILABLE')).toBe(true);
    expect(environmentBlock(pre, { id: 't1', type: 'E2E' })).toBeNull();
    expect(unattemptable(pre, [{ id: 't1', type: 'E2E' }])).toBe(false);
  });
});

describe('a probe that cannot answer', () => {
  it('neither refuses nor vouches for a binary whose presence is undeterminable', async () => {
    /*
     * Honesty rule 2, on the other probe. `onPathDefault` answers null on
     * win32, where there is no executable bit and resolution goes through
     * PATHEXT — rather than guessing, which would either refuse every
     * tool-dependent test on that platform or vouch for all of them.
     */
    const [load] = await checkRunnability(['LOAD'], {
      probes: { ...everything, onPath: () => null },
    });

    expect(load!.runnable).toBeNull();
    expect(load!.missing).toEqual([]);
    expect(load!.degraded).toEqual([]);
    expect(load!.requirements[0]!.detail).toMatch(/could not be determined on this platform/);
  });
});

describe('the rule that an unanswered check blocks nothing', () => {
  /*
   * Mutation-driven. Loosening `environmentBlock` to act on an UNKNOWN check
   * changed no behaviour and failed no test, because every check this module
   * builds leaves its block lists empty when it is UNKNOWN. That made the guard
   * untested defence — and the invariant it protects is the one a future check
   * author is most likely to break, by filling in `blocksTypes` on a check that
   * did not establish anything.
   *
   * So the rule is pinned directly: UNKNOWN never blocks, whatever the check
   * claims it blocks.
   */
  const claiming = (outcome: 'UNKNOWN' | 'UNAVAILABLE') => ({
    checks: [
      {
        name: 'BASE_URL' as const,
        outcome,
        kind: 'BLOCKED_BY_ENV' as const,
        detail: 'a check that did not establish anything but filled in its block list',
        blocksTypes: ['E2E' as const],
        blocksTestIds: ['t1'],
      },
    ],
    reason: null,
    durationMs: 0,
  });

  it('ignores a block claimed by a check that answered UNKNOWN', () => {
    const pre = claiming('UNKNOWN');
    expect(environmentBlock(pre, { id: 't1', type: 'E2E' })).toBeNull();
    expect(unattemptable(pre, [{ id: 't1', type: 'E2E' }])).toBe(false);
  });

  it('honours the identical block when the check actually answered', () => {
    // The control: without this, the test above would pass against a function
    // that blocks nothing at all.
    const pre = claiming('UNAVAILABLE');
    expect(environmentBlock(pre, { id: 't1', type: 'E2E' })).toMatchObject({
      kind: 'BLOCKED_BY_ENV',
    });
    expect(unattemptable(pre, [{ id: 't1', type: 'E2E' }])).toBe(true);
  });
});
