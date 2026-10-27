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
  BROWSER_CAPABILITY_AXES,
  checkRequirement,
  checkRunnability,
  deploymentProbeCells,
  isBrowserCapabilityAxis,
  probeDeploymentBrowsers,
  resolveDeploymentCells,
  summariseBrowserMatrix,
  compareVersions,
  guardProbeHost,
  parseVersion,
  satisfiesRange,
  storageStateVerdict,
  STORAGE_STATE_MARGIN_MS,
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
import type {
  BrowserCapabilityProbes,
  HostGuardIo,
  RunnabilityProbes,
  UrlProbeResult,
} from './preflight.js';
import {
  BROWSER_CHANNEL_LIST,
  DEVICE_PRESET_LIST,
  MATRIX_CELL_STATUS_LIST,
  TEST_TYPES,
  resolveMatrixCell,
} from '@qaai/shared';
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

/**
 * A host guard that allows everything, injected into every probe below.
 *
 * It is not optional politeness. `probeBaseUrl` defaults to HOSTED mode, and
 * HOSTED mode resolves the hostname through `node:dns` before it will connect —
 * so a test that left this out would do a real DNS lookup for
 * `staging.example.com`, pass on a machine with a resolver and fail on a train.
 * Eight tests in this file did exactly that the moment the guard landed, which
 * is the guard proving it runs before the connection rather than after it.
 *
 * The guard's OWN behaviour is tested separately, against a fake classifier and
 * a fake resolver, under 'refusing a host this worker must not open'.
 */
const publicHost: HostGuardIo = {
  classify: () => ({ kind: 'name' }),
  resolves: async () => ({ ok: true, reason: '' }),
};

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
      const check = await probeBaseUrl({ hostGuard: publicHost, baseUrl: BASE, types: ['E2E'], probe, sleep: noSleep });
      expect(check.outcome, `HTTP ${status}`).toBe('OK');
      expect(check.blocksTypes).toEqual([]);
      expect(calls).toHaveLength(1);
    }
  });

  it('says so in the detail, so nobody re-litigates the 5xx rule from the code', async () => {
    const { probe } = recordingProbe([answered(500)]);
    const check = await probeBaseUrl({ hostGuard: publicHost, baseUrl: BASE, types: ['E2E'], probe, sleep: noSleep });
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
      hostGuard: publicHost,
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
      hostGuard: publicHost,
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
    const check = await probeBaseUrl({ hostGuard: publicHost, baseUrl: BASE, types: ['E2E'], probe, sleep: noSleep });

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
      hostGuard: publicHost,
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
      const check = await probeBaseUrl({ hostGuard: publicHost, baseUrl: bad, types: ['E2E'], probe, sleep: noSleep });
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
      hostGuard: publicHost,
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
      hostGuard: publicHost,
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
      hostGuard: publicHost,
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
      hostGuard: publicHost,
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
      hostGuard: publicHost,
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
      hostGuard: publicHost,
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
      hostGuard: publicHost,
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
      hostGuard: publicHost,
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
      hostGuard: publicHost,
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

// ─────────────────────────────────────────────────────────────────────────────
// Versions: the difference between "not installed" and "installed and too old".
// ─────────────────────────────────────────────────────────────────────────────

describe('reading a tool version', () => {
  it('reads the version out of whatever the tool decided to print', () => {
    // Four real shapes. No tool agrees with any other tool about this.
    expect(parseVersion('k6 v0.49.0')).toEqual([0, 49, 0]);
    expect(parseVersion('grpcurl 1.9.1')).toEqual([1, 9, 1]);
    expect(parseVersion('11.7.1\n')).toEqual([11, 7, 1]);
    expect(parseVersion('Chromium 121.0.6167.85')).toEqual([121, 0, 6167, 85]);
  });

  it('answers null — never a zero version — for output it cannot parse', () => {
    /*
     * The whole point. `[0]` would compare as older than everything and turn a
     * tool whose `--version` we failed to read into a confident WRONG_VERSION
     * against a binary that may be perfectly current.
     */
    expect(parseVersion('command not found')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });

  it('treats a short version as the same version, not a smaller one', () => {
    expect(compareVersions([1, 2], [1, 2, 0])).toBe(0);
    expect(compareVersions([1, 2], [1, 2, 1])).toBe(-1);
    // Component-wise, not string-wise: 10 is above 9 and "10" sorts below "9".
    expect(compareVersions([0, 10, 0], [0, 9, 9])).toBe(1);
  });

  it('refuses a version below the floor and accepts one on it', () => {
    const range = { atLeast: '0.40.0', below: null, why: 'needs --summary-export' };
    expect(satisfiesRange('k6 v0.39.9', range)).toBe(false);
    expect(satisfiesRange('k6 v0.40.0', range)).toBe(true);
    // No ceiling established means no ceiling applied.
    expect(satisfiesRange('k6 v9.0.0', range)).toBe(true);
  });

  it('applies a ceiling only when one has been established', () => {
    const range = { atLeast: '1.0.0', below: '2.0.0', why: 'the flag went away in 2.x' };
    expect(satisfiesRange('1.9.9', range)).toBe(true);
    expect(satisfiesRange('2.0.0', range)).toBe(false);
  });

  it('answers null for a version it could not parse, rather than refusing it', () => {
    const range = { atLeast: '1.0.0', below: null, why: 'whatever' };
    expect(satisfiesRange('not a version', range)).toBeNull();
  });
});

describe('a requirement with a declared version window', () => {
  const ranged: RunnabilityProbes = { ...everything, onPath: () => true };

  /*
   * TYPE_REQUIREMENTS declares no version ranges on purpose (see its header), so
   * these tests build their own requirement. That is deliberate: the mechanism
   * is proven here, and nothing in the shipped table can fire it until somebody
   * establishes a real floor.
   */
  const withRange = (over: Partial<RunnabilityProbes> = {}) =>
    checkRequirement(
      {
        kind: 'BINARY' as const,
        scope: 'TYPE' as const,
        name: 'k6',
        install: 'brew install k6',
        version: { atLeast: '0.40.0', below: null, why: 'plugins/load.ts passes --summary-export' },
      },
      { ...ranged, ...over },
    );

  it('separates "too old" from "not installed", because the remedies differ', async () => {
    const status = await withRange({ binaryVersion: () => 'k6 v0.30.0' });
    expect(status.satisfied).toBe(false);
    expect(status.unmet).toBe('VERSION');
    expect(status.observedVersion).toBe('k6 v0.30.0');
    // The sentence has to send the reader to upgrade, not to install.
    expect(status.detail).toContain('is installed');
    expect(status.detail).toContain('Upgrade it rather than installing it');
  });

  it('calls an absent binary ABSENT and reads no version off it', async () => {
    const status = await withRange({ onPath: () => false, binaryVersion: () => 'k6 v9.9.9' });
    expect(status.unmet).toBe('ABSENT');
    // It is not there, so there is no version to report. Reporting the probe's
    // answer here would be a reading taken from a binary that is not present.
    expect(status.observedVersion).toBeNull();
  });

  it('claims nothing when a window is declared and no version probe exists', async () => {
    // The default: no `binaryVersion` probe, because reading a version means
    // executing the binary and this module does not do that.
    const status = await withRange();
    expect(status.satisfied).toBeNull();
    expect(status.unmet).toBeNull();
    expect(status.observedVersion).toBeNull();
    expect(status.detail).toContain('could not be read');
  });

  it('claims nothing when the tool answers with something unparseable', async () => {
    const status = await withRange({ binaryVersion: () => 'k6: permission denied' });
    expect(status.satisfied).toBeNull();
    expect(status.observedVersion).toBeNull();
  });

  it('says the version was NOT READ when no window is declared', async () => {
    const status = await checkRequirement(
      { kind: 'BINARY', scope: 'TYPE', name: 'k6', install: 'brew install k6' },
      ranged,
    );
    expect(status.satisfied).toBe(true);
    /*
     * "We did not check" must never read as "any version works". This is the
     * sentence that keeps those apart.
     */
    expect(status.detail).toContain('its version was not read');
  });

  it('refuses the type on a wrong version, and keeps it out of `missing`', async () => {
    const [load] = await checkRunnability(['LOAD'], {
      probes: { ...ranged, binaryVersion: () => 'k6 v0.1.0' },
      requirements: {
        LOAD: [
          {
            kind: 'BINARY',
            scope: 'TYPE',
            name: 'k6',
            install: 'brew install k6',
            version: { atLeast: '0.40.0', below: null, why: 'needs --summary-export' },
          },
        ],
      },
    });
    expect(load!.runnable).toBe(false);
    expect(load!.wrongVersion).toHaveLength(1);
    // Kept apart: a row that said "missing" about an installed binary would
    // send somebody to install something they already have.
    expect(load!.missing).toHaveLength(0);
    expect(load!.reason).toContain('upgrade, not an install');
  });

  it('reports an absent requirement before an out-of-range one', async () => {
    const [type] = await checkRunnability(['LOAD'], {
      probes: {
        ...ranged,
        onPath: (binary) => binary !== 'absent-tool',
        binaryVersion: () => 'v0.1.0',
      },
      requirements: {
        LOAD: [
          { kind: 'BINARY', scope: 'TYPE', name: 'absent-tool', install: 'install absent-tool' },
          {
            kind: 'BINARY',
            scope: 'TYPE',
            name: 'old-tool',
            install: 'upgrade old-tool',
            version: { atLeast: '5.0.0', below: null, why: 'needs a 5.x flag' },
          },
        ],
      },
    });
    // Both are unmet. The install has to be named first — a reader told to
    // upgrade a tool they have not installed goes looking for a version of it.
    expect(type!.missing).toHaveLength(1);
    expect(type!.wrongVersion).toHaveLength(1);
    expect(type!.reason).toContain('it is missing');
    expect(type!.reason).not.toContain('upgrade, not an install');
  });

  it('declares no version window for any shipped type, until somebody establishes one', () => {
    /*
     * A TRIPWIRE, not a tautology. No minimum version for k6, Lighthouse or
     * grpcurl has ever been established in this repository — there is no such
     * figure in the Dockerfile, in docs/ or in the plugins. A plausible floor
     * typed into TYPE_REQUIREMENTS would fire on a customer's working binary
     * and report a number this product invented about a tool it never tested.
     *
     * So adding one has to be a deliberate edit that deletes this assertion and
     * says how the figure was verified, rather than a line in a diff.
     */
    const ranged = Object.entries(TYPE_REQUIREMENTS).flatMap(([type, reqs]) =>
      reqs.filter((r) => r.kind === 'BINARY' && r.version !== undefined).map(() => type),
    );
    expect(ranged).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The host guard: this probe opens a host a customer named.
// ─────────────────────────────────────────────────────────────────────────────

describe('refusing a host this worker must not open', () => {
  const refusing = (reason: string): HostGuardIo => ({
    classify: () => ({ kind: 'name' }),
    resolves: async () => ({ ok: false, reason }),
  });

  it('refuses a target that does not resolve publicly, in hosted mode', async () => {
    const verdict = await guardProbeHost({
      hostname: 'metadata.internal',
      mode: 'HOSTED',
      io: refusing('Refusing metadata.internal: it resolves to 169.254.169.254, which is a link-local address.'),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining('link-local') });
  });

  it('refuses an ambiguous host without ever handing it to a resolver', async () => {
    /*
     * `0177.0.0.1` is 127.0.0.1 to something downstream and a hostname to
     * something else. Resolving it would give the octal form a second chance at
     * being interpreted, so the refusal must happen before the lookup.
     */
    const resolves = vi.fn(async () => ({ ok: true, reason: '' }));
    const verdict = await guardProbeHost({
      hostname: '0177.0.0.1',
      mode: 'HOSTED',
      io: { classify: () => ({ kind: 'ambiguous', why: 'that is an IP address in a form QAAI will not guess at' }), resolves },
    });
    expect(verdict.allowed).toBe(false);
    expect(resolves).not.toHaveBeenCalled();
  });

  it('allows a public host and says the check actually ran', async () => {
    const verdict = await guardProbeHost({
      hostname: 'staging.example.com',
      mode: 'HOSTED',
      io: publicHost,
    });
    expect(verdict).toMatchObject({ allowed: true, skipped: false });
  });

  it('skips the check for a self-hosted deployment, and SAYS it skipped it', async () => {
    /*
     * A self-hosted QAAI exists to test http://localhost:3000. Refusing that
     * would break the install for everyone behind their own firewall — but a
     * guard that passes silently in the one mode where it does nothing is
     * indistinguishable from a guard that ran.
     */
    const resolves = vi.fn(async () => ({ ok: true, reason: '' }));
    const verdict = await guardProbeHost({
      hostname: 'localhost',
      mode: 'SELF_HOSTED',
      io: { classify: () => ({ kind: 'address' }), resolves },
    });
    expect(verdict).toMatchObject({ allowed: true, skipped: true });
    expect(resolves).not.toHaveBeenCalled();
    expect(verdict).toMatchObject({ detail: expect.stringContaining('was not checked') });
  });

  it('never connects to a host it refused', async () => {
    // The assertion that makes this a guard rather than a label: the prober is
    // never called at all.
    const { calls, probe } = recordingProbe([answered(200)]);
    const check = await probeBaseUrl({
      baseUrl: 'http://169.254.169.254/latest/meta-data/',
      types: ['E2E'],
      probe,
      sleep: noSleep,
      hostGuard: refusing('Refusing 169.254.169.254: that is a link-local address.'),
    });
    expect(calls).toEqual([]);
    expect(check.outcome).toBe('UNAVAILABLE');
    expect(check.blocksTypes).toContain('E2E');
  });

  it('blames QAAI rather than the customer when it is QAAI that refused', async () => {
    const check = await probeBaseUrl({
      baseUrl: 'http://10.0.0.5/',
      types: ['E2E'],
      probe: async () => answered(200),
      sleep: noSleep,
      hostGuard: refusing('Refusing 10.0.0.5: that is a private address.'),
    });
    /*
     * A reader sent to check their VPN over a refusal QAAI made would never
     * find anything wrong with it. The sentence has to say which side said no.
     */
    expect(check.detail).toContain('refusal by QAAI');
    expect(check.detail).not.toContain('did not answer');
  });

  it('defaults to refusing rather than probing when no mode is given', async () => {
    /*
     * The direction a security default has to fail. A caller that forgets the
     * mode gets HOSTED, not an open probe at whatever host it was handed.
     */
    const resolves = vi.fn(async () => ({ ok: false, reason: 'Refusing it: private.' }));
    const check = await probeBaseUrl({
      baseUrl: 'http://192.168.1.1/',
      types: ['E2E'],
      probe: async () => answered(200),
      sleep: noSleep,
      hostGuard: { classify: () => ({ kind: 'address' }), resolves },
    });
    expect(resolves).toHaveBeenCalled();
    expect(check.outcome).toBe('UNAVAILABLE');
  });

  it('names the skipped check in the detail of a run that passed', async () => {
    const check = await probeBaseUrl({
      baseUrl: 'http://localhost:3000',
      types: ['E2E'],
      probe: async () => answered(200),
      sleep: noSleep,
      mode: 'SELF_HOSTED',
      hostGuard: publicHost,
    });
    expect(check.outcome).toBe('OK');
    // A degradation that is APPLIED must also be REPORTED.
    expect(check.detail).toContain('was not checked against the private-address rules');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The stored session, checked without spending a login on it.
// ─────────────────────────────────────────────────────────────────────────────

describe('checking a stored session for staleness', () => {
  const NOW = Date.parse('2026-10-26T12:00:00.000Z');
  const at = (iso: string): number => Date.parse(iso) / 1000;

  it('proves a session unusable when a cookie has already expired', () => {
    const verdict = storageStateVerdict({
      cookies: [{ name: 'session', expires: at('2026-10-22T12:00:00.000Z') }],
      now: NOW,
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.detail).toContain('session');
    expect(verdict.detail).toContain('Re-record the session');
  });

  it('refuses to claim a fresh session WORKS, only that nothing says it is stale', () => {
    /*
     * A server can revoke a session whose cookie has months left. The login
     * probe establishes that it works; this only establishes that it has not
     * timed out, and the wording may not overstate it.
     */
    const verdict = storageStateVerdict({
      cookies: [{ name: 'session', expires: at('2027-01-01T00:00:00.000Z') }],
      now: NOW,
    });
    expect(verdict.usable).toBe(true);
    expect(verdict.detail).toContain('Nothing in the stored session says it is stale');
    expect(verdict.detail).toContain('separate question');
  });

  it('answers null — not usable, not broken — with no session to inspect', () => {
    expect(storageStateVerdict({ cookies: null, now: NOW }).usable).toBeNull();
    expect(storageStateVerdict({ cookies: [], now: NOW }).usable).toBeNull();
  });

  it('answers null for session cookies, which carry no expiry to read', () => {
    /*
     * Playwright writes `-1` for a session cookie. Treating that as an expiry
     * would make every such state look like it expired in 1969 — the most
     * destructive available reading, since it would block the run.
     */
    const verdict = storageStateVerdict({
      cookies: [{ name: 'sid', expires: -1 }],
      now: NOW,
    });
    expect(verdict.usable).toBeNull();
    expect(verdict.detail).toContain('no expiry');
  });

  it('ignores session cookies when dating the ones that do have expiries', () => {
    const verdict = storageStateVerdict({
      cookies: [
        { name: 'sid', expires: -1 },
        { name: 'auth', expires: at('2027-01-01T00:00:00.000Z') },
      ],
      now: NOW,
    });
    expect(verdict.usable).toBe(true);
    expect(verdict.detail).toContain('2027-01-01');
  });

  it('calls a session that dies inside the margin stale now, not mid-suite', () => {
    const verdict = storageStateVerdict({
      cookies: [{ name: 'auth', expires: (NOW + 10_000) / 1000 }],
      now: NOW,
      marginMs: STORAGE_STATE_MARGIN_MS,
    });
    // Ten seconds left will not survive a suite. Reporting it as usable means
    // the run spends its budget discovering that halfway through.
    expect(verdict.usable).toBe(false);
  });

  it('names the cookie and the date and cannot name the value', () => {
    const verdict = storageStateVerdict({
      cookies: [{ name: 'qaai_session', expires: at('2020-01-01T00:00:00.000Z') }],
      now: NOW,
    });
    /*
     * `StoredCookie` has no `value` field, so there is nothing for a detail
     * string to leak — this asserts the consequence of that design. The cookie
     * NAME is the actionable half and is not a secret.
     */
    expect(verdict.detail).toContain('qaai_session');
    expect(verdict.detail).toContain('2020-01-01');
    expect(Object.keys({ name: '', expires: 0 })).toEqual(['name', 'expires']);
  });
});

describe('spending a login only when it could tell us something', () => {
  it('does not drive a browser login for a session it can prove is expired', async () => {
    const signIn = vi.fn(async () => ({ ok: true }) as const);
    const checks = await probeIdentities({
      identities: [
        {
          profileId: 'p1',
          label: 'admin',
          testIds: ['t1', 't2'],
          cookies: [{ name: 'auth', expires: Date.parse('2020-01-01T00:00:00.000Z') / 1000 }],
        },
      ],
      signIn,
      now: () => Date.parse('2026-10-26T12:00:00.000Z'),
    });
    // Thirty seconds of browser saved, and — the bigger win — the right
    // diagnosis instead of "could not sign in".
    expect(signIn).not.toHaveBeenCalled();
    expect(checks[0]).toMatchObject({ outcome: 'UNAVAILABLE', blocksTestIds: ['t1', 't2'] });
    expect(checks[0]!.detail).toContain('stale');
  });

  it('still asks the resolver when freshness establishes nothing', async () => {
    /*
     * The control. `usable: null` and `usable: true` must BOTH fall through:
     * neither establishes that the application still accepts the session, and
     * short-circuiting on either would turn this cheap check into a pass that
     * means "we did not look".
     */
    const signIn = vi.fn(async () => ({ ok: true }) as const);
    await probeIdentities({
      identities: [{ profileId: 'p1', label: 'admin', testIds: ['t1'], cookies: null }],
      signIn,
      now: () => Date.parse('2026-10-26T12:00:00.000Z'),
    });
    expect(signIn).toHaveBeenCalledTimes(1);

    const fresh = vi.fn(async () => ({ ok: true }) as const);
    await probeIdentities({
      identities: [
        {
          profileId: 'p1',
          label: 'admin',
          testIds: ['t1'],
          cookies: [{ name: 'auth', expires: Date.parse('2027-01-01T00:00:00.000Z') / 1000 }],
        },
      ],
      signIn: fresh,
      now: () => Date.parse('2026-10-26T12:00:00.000Z'),
    });
    expect(fresh).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The browser capability: what `resolveMatrixCell` had nothing to resolve
// against.
// ─────────────────────────────────────────────────────────────────────────────

/*
 * Every assertion below is about one of the two asymmetric ways a capability
 * probe lies, because the statuses they produce have opposite blast radii:
 *
 *   ABSENT READ AS AVAILABLE — the deployment vouches for a browser it does not
 *   have. The test launches, Playwright throws, and the failure is reported
 *   against the customer's application.
 *
 *   ABSENT READ AS MISSING — the cell is REFUSED with an install line for a
 *   browser that may well be installed somewhere this probe does not look.
 *   "QAAI refused my Chrome" is the same defect as "QAAI refused my k6".
 *
 * NOT_CHECKED is the third answer and it is the honest one, so the omission of a
 * key is asserted directly rather than through a status three layers up.
 */

const noBrowsers: BrowserCapabilityProbes = {
  browserInstalled: () => null,
  channelResolves: () => null,
  devicePresetKnown: () => null,
};

describe('collecting what this deployment has to launch with', () => {
  it('omits an axis member nothing could answer for, in either direction', async () => {
    const probe = await probeDeploymentBrowsers(noBrowsers);

    expect(probe.readings.length).toBeGreaterThan(0);
    expect(probe.notProbed.length).toBe(probe.readings.length);
    // Not `{ chromium: false }`, and not `{ chromium: true }`. Absent.
    expect(probe.browsers.engines).toEqual({});
    expect(probe.browsers.channels).toEqual({});
    expect(probe.browsers.devicePresets).toEqual({});
    expect(probe.why).toContain('ABSENT rather than as a yes or a no');
  });

  it('leaves an unprobed cell resolving NOT_CHECKED with no remedy', async () => {
    /*
     * The whole point of the omission. A fabricated `false` would make this
     * MISSING and print `npx playwright install` to somebody whose image is
     * fine; a fabricated `true` would make it AVAILABLE and launch nothing.
     */
    const probe = await probeDeploymentBrowsers(noBrowsers);
    const resolved = resolveMatrixCell({ engine: 'chromium' }, probe.browsers);
    expect(resolved.status).toBe('NOT_CHECKED');
    expect(resolved.remedy).toBeNull();
  });

  it('records a probed engine, so AVAILABLE becomes reachable at all', async () => {
    const probe = await probeDeploymentBrowsers({ ...noBrowsers, browserInstalled: () => true });
    expect(probe.browsers.engines).toEqual({ chromium: true, firefox: true, webkit: true });
    const resolved = resolveMatrixCell({ engine: 'webkit' }, probe.browsers);
    expect(resolved.status).toBe('AVAILABLE');
  });

  it('records an engine that is genuinely absent as a refusal with the install line', async () => {
    const probe = await probeDeploymentBrowsers({
      ...noBrowsers,
      browserInstalled: (engine) => engine !== 'webkit',
    });
    expect(probe.browsers.engines).toEqual({ chromium: true, firefox: true, webkit: false });
    const resolved = resolveMatrixCell({ engine: 'webkit' }, probe.browsers);
    expect(resolved.status).toBe('MISSING');
    expect(resolved.remedy).toContain('playwright install');
  });

  it('never takes a reading for BUNDLED, which is not a browser on the host', async () => {
    /*
     * BUNDLED is Playwright's own build — `resolveMatrixCell` skips the channel
     * check for it entirely — so a reading about it would be a reading about
     * nothing, and a stored `BUNDLED: false` row would refuse every cell in the
     * product.
     */
    const probe = await probeDeploymentBrowsers({ ...noBrowsers, channelResolves: () => true });
    const channels = probe.readings.filter((reading) => reading.axis === 'CHANNEL');
    expect(channels.length).toBeGreaterThan(0);
    expect(channels.map((reading) => reading.name)).not.toContain('BUNDLED');
    expect(probe.browsers.channels).not.toHaveProperty('BUNDLED');
  });

  it('answers a channel on a PATH hit and refuses to answer on a miss', async () => {
    /*
     * THE FALSE-NEGATIVE GUARD. Playwright resolves a channel by absolute
     * per-platform paths — `/Applications/Google Chrome.app/…` on macOS,
     * `/opt/google/chrome/chrome` on Linux — so a PATH miss is NOT evidence the
     * browser is absent. If this ever answers `false`, every macOS deployment
     * starts refusing Chrome cells and printing an install line for a browser
     * the host already has.
     */
    const probe = await probeDeploymentBrowsers({
      ...noBrowsers,
      channelResolves: undefined,
      onPath: (binary) => binary === 'google-chrome',
    });

    expect(probe.browsers.channels).toEqual({ CHROME: true });
    const beta = probe.readings.find((reading) => reading.name === 'CHROME_BETA');
    expect(beta?.installed).toBeNull();
    expect(beta?.detail).toContain('not through PATH');
  });

  it('asks only questions a deployment can be blamed for', () => {
    /*
     * Each channel cell is paired with the engine it is a build OF, and no cell
     * pins a version — so no cell this probe asks about can resolve
     * UNSUPPORTED_COMBINATION ("is there a Firefox beta installed") or
     * NEEDS_BROWSER_GRID. Those two are properties of a CUSTOMER's declared
     * cell, and a probe that generated them would be reporting on its own
     * question rather than on the image.
     */
    const everythingInstalled = {
      engines: { chromium: true, firefox: true, webkit: true },
      channels: Object.fromEntries(
        BROWSER_CHANNEL_LIST.filter((channel) => channel !== 'BUNDLED').map((channel) => [
          channel,
          true,
        ]),
      ),
      devicePresets: Object.fromEntries(DEVICE_PRESET_LIST.map((preset) => [preset, true])),
    };
    const resolved = resolveDeploymentCells(everythingInstalled);
    expect(resolved.length).toBe(deploymentProbeCells().length);
    expect(resolved.map((cell) => cell.status)).not.toContain('UNSUPPORTED_COMBINATION');
    expect(resolved.map((cell) => cell.status)).not.toContain('NEEDS_BROWSER_GRID');
    expect(new Set(resolved.map((cell) => cell.status))).toEqual(new Set(['AVAILABLE']));
  });

  it('emits every axis it declares, which is the run-time half of the record', () => {
    // The compiler-enforced half is `BROWSER_CAPABILITY_AXIS_PRESENT` in the
    // module. This catches the reverse: an axis declared and never probed, which
    // would be a vocabulary entry nothing can ever store a row under.
    const probed = new Set(BROWSER_CAPABILITY_AXES.map((axis) => axis));
    return probeDeploymentBrowsers(noBrowsers).then((probe) => {
      expect(new Set(probe.readings.map((reading) => reading.axis))).toEqual(probed);
      for (const axis of BROWSER_CAPABILITY_AXES) expect(isBrowserCapabilityAxis(axis)).toBe(true);
      expect(isBrowserCapabilityAxis('ENGINES')).toBe(false);
    });
  });
});

describe('summarising a resolved matrix by what a reader can do about it', () => {
  const missing = resolveMatrixCell({ engine: 'webkit' }, { engines: { webkit: false } });
  const unsupported = resolveMatrixCell({ engine: 'firefox', channel: 'CHROME_BETA' }, {});
  const needsGrid = resolveMatrixCell(
    {
      engine: 'webkit',
      version: { kind: 'RANGE', range: { atLeast: '17.0', below: null, why: 'a Safari 17 fix' } },
    },
    {},
  );
  const unprobed = resolveMatrixCell({ engine: 'chromium' }, {});

  it('files the two statuses no install can fix away from the install advice', () => {
    /*
     * There is no Firefox beta to install anywhere on earth, and no install on
     * this image is ever going to be Safari. An install line against either is
     * advice that cannot be followed — and advice that cannot be followed is how
     * a reader learns to ignore the whole report.
     */
    const summary = summariseBrowserMatrix([unsupported, needsGrid]);
    expect(summary.impossibleHere.length).toBe(2);
    expect(summary.installable).toEqual([]);
    expect(summary.sentence).toContain('Not an install');
    expect(summary.sentence).not.toContain('npx playwright install');
    expect(summary.sentence).not.toContain('fixable here —');
  });

  it('does put the install line against the one that is an install', () => {
    // The positive control for the test above: if the buckets were swapped, or
    // collapsed, exactly one of the two would still pass.
    const summary = summariseBrowserMatrix([missing]);
    expect(summary.installable.length).toBe(1);
    expect(summary.impossibleHere).toEqual([]);
    expect(summary.sentence).toContain('npx playwright install');
  });

  it('keeps an unprobed cell out of `available` and says it stays in the denominator', () => {
    const summary = summariseBrowserMatrix([unprobed]);
    expect(summary.notChecked.length).toBe(1);
    expect(summary.available).toEqual([]);
    expect(summary.sentence).toContain('stay IN the denominator');
  });

  it('reports NULL refusable cells when nothing was probed, because 0 is a reading nobody took', () => {
    /*
     * ── A ZERO IS A REAL READING NOBODY TOOK ────────────────────────────────
     *
     * apps/worker/src/index.ts logs this number as `browserCellsRefusable` —
     * the field an operator alerts on — and it already logged `null` when the
     * capability store could not be REACHED, for the right reason: a zero
     * there reads as "this image refuses nothing", the most flattering
     * possible reading of a question nobody asked.
     *
     * A REACHABLE AND EMPTY table is the same question. Nothing has been
     * probed, so every cell resolves NOT_CHECKED, both refusal buckets are
     * empty, and the sum was 0 — indistinguishable from an image that WAS
     * probed and refuses nothing. That is the normal state of a deployment
     * between the capability migration landing and the first sweep running.
     */
    const summary = summariseBrowserMatrix([unprobed]);
    expect(summary.refusableCells).toBeNull();
    // And it is not null because the list was empty — an empty resolution set
    // is also a question nobody asked.
    expect(summariseBrowserMatrix([]).refusableCells).toBeNull();
  });

  it('reports a real 0 once any cell carries a reading, so a measurement is not discarded', () => {
    /*
     * THE OPPOSITE ERROR, and it is the easier one to make. If five cells were
     * probed and none is refusable, 0 IS a reading — of those five — and
     * nulling it because the rest are unprobed throws away a measurement
     * somebody took. `notChecked` stays in the denominator either way, which is
     * what makes a partial 0 readable.
     */
    const available = resolveMatrixCell({ engine: 'chromium' }, { engines: { chromium: true } });
    expect(available.status).toBe('AVAILABLE');
    expect(summariseBrowserMatrix([available, unprobed]).refusableCells).toBe(0);
    // And it counts both refusal buckets, never just the installable one.
    expect(summariseBrowserMatrix([missing, unsupported, unprobed]).refusableCells).toBe(2);
  });

  it('counts all six statuses, including the ones a probe cannot produce', () => {
    const summary = summariseBrowserMatrix([missing, unsupported, needsGrid, unprobed]);
    expect(Object.keys(summary.byStatus).sort()).toEqual([...MATRIX_CELL_STATUS_LIST].sort());
    expect(summary.byStatus.MISSING).toBe(1);
    expect(summary.byStatus.UNSUPPORTED_COMBINATION).toBe(1);
    expect(summary.byStatus.NEEDS_BROWSER_GRID).toBe(1);
    expect(summary.byStatus.NOT_CHECKED).toBe(1);
    expect(summary.byStatus.AVAILABLE).toBe(0);
  });
});
