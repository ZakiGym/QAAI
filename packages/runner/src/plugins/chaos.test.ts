/**
 * The chaos plugin, and the one lie it must never tell.
 *
 * "WE BROKE NOTHING AND THE APPLICATION WAS FINE."
 *
 * A glob that matched no request, a dependency the page no longer calls, a
 * pattern written against a URL that changed two deploys ago — every one of
 * them leaves the application untouched, every invariant trivially holding, and
 * a green row claiming the error path is covered. It is a pass meaning "we did
 * not check", it is the likeliest false green in this plugin, and the heaviest
 * block in this file exists to prove it cannot be reported.
 *
 * The counter-tests matter exactly as much. A plugin that answered
 * NOT_INJECTED, UNDETERMINED or UNAVAILABLE often enough would be a plugin that
 * never fails anything — so a dependency that really wipes a form, really
 * double-charges, really spins for ever and really renders a stack trace must
 * still go red, or the honesty vocabulary becomes a way to make every error-path
 * bug disappear.
 *
 * NO BROWSER, NO NETWORK AND NO CLOCK runs in this file. The page is a fake
 * implementing {@link ChaosPageSurface}; the routes are fake objects
 * implementing har.ts's `HarRoute`; nothing sleeps.
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAOS_FAULTS, CHAOS_FAULT_LIST, chaosTestSpecSchema } from '@qaai/shared';
import type { ExecutableTest, RunContext } from '@qaai/shared';
import type { HarApiResponse, HarRoute } from '../har.js';
import {
  CHAOS_CAPABILITIES,
  CHAOS_CAPABILITY_LIST,
  CHAOS_CAPABILITY_REMEDY,
  CHAOS_FAULT_DESCRIPTORS,
  CHAOS_FAULT_KINDS,
  CHAOS_FAULT_KIND_LIST,
  CHAOS_INJECTION_OUTCOMES,
  CHAOS_INJECTION_OUTCOME_LIST,
  CHAOS_INVARIANTS,
  CHAOS_INVARIANT_DESCRIPTORS,
  CHAOS_INVARIANT_LIST,
  CHAOS_REFUSAL_REASONS,
  CHAOS_REFUSAL_REASON_LIST,
  CHAOS_VERBS,
  CHAOS_VERB_LIST,
  FAULTS_WITHOUT_A_STORED_SPELLING,
  IDEMPOTENCY_HEADERS,
  IDEMPOTENT_METHODS,
  INVARIANTS_THE_PLANNER_CANNOT_PROPOSE,
  LIFT_ADDED_INVARIANTS,
  MALFORMED_JSON_BODY,
  NON_IDEMPOTENT_RULE,
  OUTCOMES_THAT_MAY_NOT_PASS,
  OUTCOMES_THAT_MAY_PASS,
  OUTCOME_NOT_RUN_KIND,
  STORED_FAULT_SPELLING,
  UNDETERMINED_AS_HOLE,
  UNDETERMINED_REASONS,
  UNDETERMINED_REASON_LIST,
  applyFault,
  capBiteFor,
  capabilityGap,
  chaosExecution,
  chaosMetrics,
  chaosPlugin,
  chaosRouteHandler,
  chaosScenarioSpecSchema,
  chaosStatus,
  claimsRequest,
  createHold,
  dropJsonFields,
  duplicateWriteVerdict,
  emptyInjectionState,
  emptyReading,
  evaluateInvariant,
  evidenceHeld,
  holesIn,
  injectionRefusal,
  liftStoredChaosSpec,
  looksLikeStackTrace,
  parseChaosSpec,
  requestPathOf,
  runChaosScenario,
  setChaosDeps,
  truncateBody,
  typedValuesFor,
  unavailableChaosPage,
} from './chaos.js';
import type {
  ChaosCapability,
  ChaosFaultKind,
  ChaosInvariantResult,
  ChaosProbeReading,
  ChaosScenarioSpec,
  ObservedWrite,
} from './chaos.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

interface RouteCalls {
  fulfilled: Array<{ status?: number; headers?: Record<string, string>; body?: Buffer | string }>;
  aborted: string[];
  continued: number;
  fetched: number;
}

function fakeRoute(init: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  response?: { status?: number; headers?: Record<string, string>; body?: string };
  fetchThrows?: boolean;
}): { route: HarRoute; calls: RouteCalls } {
  const calls: RouteCalls = { fulfilled: [], aborted: [], continued: 0, fetched: 0 };
  const route: HarRoute = {
    request: () => ({
      method: () => init.method ?? 'GET',
      url: () => init.url,
      headers: () => init.headers ?? {},
      postData: () => null,
    }),
    fetch: (): Promise<HarApiResponse> => {
      calls.fetched += 1;
      if (init.fetchThrows) return Promise.reject(new Error('ECONNRESET'));
      const r = init.response ?? {};
      return Promise.resolve({
        status: () => r.status ?? 200,
        statusText: () => 'OK',
        headers: () => r.headers ?? { 'content-type': 'application/json' },
        body: () => Promise.resolve(Buffer.from(r.body ?? '{}')),
      });
    },
    fulfill: (options) => {
      calls.fulfilled.push(options);
      return Promise.resolve();
    },
    abort: (code) => {
      calls.aborted.push(code ?? 'failed');
      return Promise.resolve();
    },
    continue: () => {
      calls.continued += 1;
      return Promise.resolve();
    },
  };
  return { route, calls };
}

interface FakePageInit {
  capabilities?: readonly ChaosCapability[];
  /** Requests the page "issues" on every navigation. */
  requests?: ReadonlyArray<{ method: string; url: string; headers?: Record<string, string> }>;
  /** Reading returned BEFORE the fault is armed. */
  clean?: Partial<ChaosProbeReading>;
  /** Reading returned once the handler has been installed. */
  faulted?: Partial<ChaosProbeReading>;
  /** Reading returned after the retry control is clicked. */
  retried?: Partial<ChaosProbeReading>;
  retryClickable?: boolean;
  gotoThrows?: boolean;
}

const ALL_CAPABILITIES: readonly ChaosCapability[] = CHAOS_CAPABILITY_LIST;

function reading(over: Partial<ChaosProbeReading>): ChaosProbeReading {
  return { ...emptyReading(), ...over };
}

/**
 * A page that issues a declared list of requests on every navigation.
 *
 * It drives the handler the plugin installs, so the handler under test is the
 * real one and the only fake thing is Playwright.
 */
function fakePage(init: FakePageInit = {}): {
  page: Parameters<typeof runChaosScenario>[1];
  filled: Record<string, string>;
  navigations: string[];
} {
  const filled: Record<string, string> = {};
  const navigations: string[] = [];
  let handler: ((route: HarRoute) => Promise<void>) | null = null;
  let retryDriven = false;
  const routeCalls: RouteCalls[] = [];

  const page = {
    capabilities: (): Promise<readonly ChaosCapability[]> =>
      Promise.resolve(init.capabilities ?? ALL_CAPABILITIES),
    goto: async (path: string): Promise<void> => {
      navigations.push(path);
      if (init.gotoThrows === true) throw new Error('net::ERR_CONNECTION_REFUSED');
      if (handler === null) return;
      for (const request of init.requests ?? []) {
        const { route, calls } = fakeRoute({
          url: request.url,
          method: request.method,
          ...(request.headers === undefined ? {} : { headers: request.headers }),
          response: { body: '{"total":10,"items":[{"name":"a"}]}' },
        });
        routeCalls.push(calls);
        await handler(route);
      }
    },
    route: (_glob: string, next: (route: HarRoute) => Promise<void>): Promise<void> => {
      handler = next;
      return Promise.resolve();
    },
    read: (): Promise<ChaosProbeReading> => {
      if (retryDriven) return Promise.resolve(reading(init.retried ?? {}));
      if (handler !== null) return Promise.resolve(reading(init.faulted ?? {}));
      return Promise.resolve(reading(init.clean ?? {}));
    },
    fill: (values: Readonly<Record<string, string>>): Promise<void> => {
      Object.assign(filled, values);
      return Promise.resolve();
    },
    clickRetry: async (): Promise<boolean> => {
      if (init.retryClickable === false) return false;
      retryDriven = true;
      /*
       * A retry re-issues the request, which is the whole point of the
       * assertion — so the fake drives the handler again, with the fault
       * disarmed by the orchestrator.
       */
      if (handler !== null) {
        for (const request of init.requests ?? []) {
          const { route, calls } = fakeRoute({
            url: request.url,
            method: request.method,
            ...(request.headers === undefined ? {} : { headers: request.headers }),
          });
          routeCalls.push(calls);
          await handler(route);
        }
      }
      return true;
    },
    applyOutOfBand: (): Promise<boolean> => Promise.resolve(true),
  };

  return { page, filled, navigations };
}

function spec(over: Partial<ChaosScenarioSpec> = {}): ChaosScenarioSpec {
  return chaosScenarioSpecSchema.parse({
    path: '/orders',
    target: { methods: ['GET'], pathGlob: '/api/orders' },
    fault: 'UPSTREAM_500',
    assertInvariants: ['STAYS_ON_ROUTE'],
    ownOrigins: ['https://shop.example.com'],
    seed: 'seed-1',
    ...over,
  });
}

const OWN = 'https://shop.example.com';

function makeCtx(): RunContext & { logged: string[] } {
  const logged: string[] = [];
  return {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl: `${OWN}/`,
    secrets: {},
    storageState: null,
    artifacts: {
      put: async () => 'key',
      putFile: async () => 'key',
      get: async () => null,
      putPersistent: async () => 'key',
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      step: (event) => logged.push(`${event.status} ${event.title}`),
    },
    signal: new AbortController().signal,
    determinism: { freezeClockAt: null, randomSeed: 7, waitForNetworkIdle: false, retryOnce: false },
    logged,
  };
}

function makeTest(testSpec: unknown, name = 'the orders list survives a 500'): ExecutableTest {
  return {
    id: 'test_1',
    name,
    // CHAOS is not in TEST_TYPES yet — see the handover and registry.test.ts.
    type: 'E2E',
    code: '',
    filePath: 'chaos/orders-500.json',
    spec: testSpec,
    timeoutMs: 60_000,
    quarantined: false,
    tags: [],
  };
}

// ─── The vocabularies ────────────────────────────────────────────────────────

describe('every closed union has both halves of its parity guard', () => {
  it.each([
    ['CHAOS_VERBS', CHAOS_VERBS, CHAOS_VERB_LIST],
    ['CHAOS_CAPABILITIES', CHAOS_CAPABILITIES, CHAOS_CAPABILITY_LIST],
    ['CHAOS_FAULT_KINDS', CHAOS_FAULT_KINDS, CHAOS_FAULT_KIND_LIST],
    ['CHAOS_INVARIANTS', CHAOS_INVARIANTS, CHAOS_INVARIANT_LIST],
    ['UNDETERMINED_REASONS', UNDETERMINED_REASONS, UNDETERMINED_REASON_LIST],
    ['CHAOS_INJECTION_OUTCOMES', CHAOS_INJECTION_OUTCOMES, CHAOS_INJECTION_OUTCOME_LIST],
    ['CHAOS_REFUSAL_REASONS', CHAOS_REFUSAL_REASONS, CHAOS_REFUSAL_REASON_LIST],
  ])('%s is derived from its presence record and not hand-listed', (_name, declared, derived) => {
    expect([...derived].sort()).toEqual([...declared].sort());
    expect(derived.length).toBe(declared.length);
  });

  it('gives every fault a descriptor, and every capability a remedy', () => {
    for (const fault of CHAOS_FAULT_KIND_LIST) {
      expect(CHAOS_FAULT_DESCRIPTORS[fault].label.length).toBeGreaterThan(0);
      expect(CHAOS_FAULT_DESCRIPTORS[fault].why.length).toBeGreaterThan(0);
    }
    for (const capability of CHAOS_CAPABILITY_LIST) {
      expect(CHAOS_CAPABILITY_REMEDY[capability]).toMatch(/\w/);
    }
  });

  it('gives every invariant a claim and an evidence need', () => {
    for (const invariant of CHAOS_INVARIANT_LIST) {
      const descriptor = CHAOS_INVARIANT_DESCRIPTORS[invariant];
      expect(descriptor.claim.length).toBeGreaterThan(0);
      expect(descriptor.why.length).toBeGreaterThan(0);
    }
  });

  it('declares exactly one WEAK invariant, and it is the floor', () => {
    const weak = CHAOS_INVARIANT_LIST.filter(
      (kind) => CHAOS_INVARIANT_DESCRIPTORS[kind].strength === 'WEAK',
    );
    expect(weak).toEqual(['SOME_ERROR_SHOWN']);
  });

  it('names the three invariants no producer can propose yet', () => {
    /*
     * An invariant only this plugin knows about is an invariant no producer can
     * emit — the round's own headline defect one level down. The list is
     * derived by exclusion, so a thirteenth invariant lands here by default
     * rather than silently claiming planner support.
     */
    expect([...INVARIANTS_THE_PLANNER_CANNOT_PROPOSE].sort()).toEqual([
      'NO_DUPLICATE_WRITE',
      'NO_FALSE_SUCCESS',
      'NO_RAW_STACK_TRACE',
    ]);
  });

  it("restates the agent's non-idempotent rule verbatim", () => {
    // Two copies, two packages, one sentence. A diff on either side is visible.
    expect(NON_IDEMPOTENT_RULE).toBe(
      'faults: a non-idempotent request is never injected against — failing a POST means first issuing it',
    );
    expect([...IDEMPOTENT_METHODS]).toEqual(['GET', 'HEAD', 'OPTIONS', 'TRACE']);
  });
});

describe('the bridge from the stored fault vocabulary', () => {
  it('maps every stored fault, and maps no two onto the same kind', () => {
    const targets = CHAOS_FAULT_LIST.map((stored) => STORED_FAULT_SPELLING[stored]);
    expect(targets).toHaveLength(CHAOS_FAULTS.length);
    expect(new Set(targets).size).toBe(targets.length);
    for (const target of targets) expect(CHAOS_FAULT_KIND_LIST).toContain(target);
  });

  it('keeps EMPTY_BODY and CONNECTION_REFUSED as themselves', () => {
    /*
     * The two collapses that would have made the bridge lossy. A stored
     * EMPTY_BODY mapped onto EMPTY_COLLECTION would serve `[]` where the test
     * asked for zero bytes — a different fault under the row's name, which is
     * indistinguishable from a bug.
     */
    expect(STORED_FAULT_SPELLING.EMPTY_BODY).toBe('EMPTY_BODY');
    expect(STORED_FAULT_SPELLING.CONNECTION_REFUSED).toBe('CONNECTION_REFUSED');
    expect(CHAOS_FAULT_KIND_LIST).toContain('EMPTY_COLLECTION');
    expect(CHAOS_FAULT_KIND_LIST).toContain('OFFLINE_MID_FLOW');
  });

  it('counts the faults no Test row can ask for yet', () => {
    // The funnel gap, as a number a report can print rather than a surprise.
    expect([...FAULTS_WITHOUT_A_STORED_SPELLING].sort()).toEqual([
      'CLOCK_SKEW',
      'EMPTY_COLLECTION',
      'NO_RESPONSE',
      'OFFLINE_MID_FLOW',
      'SHAPE_DRIFT',
      'STALLED_RESPONSE',
      'WEBSOCKET_DROPPED',
    ]);
  });
});

// ─── THE FALSE GREEN ─────────────────────────────────────────────────────────

describe('a fault that was not injected can never be reported as PASSED', () => {
  it('admits exactly one outcome to the pass path, and derives the rest by exclusion', () => {
    expect([...OUTCOMES_THAT_MAY_PASS]).toEqual(['INJECTED']);
    expect([...OUTCOMES_THAT_MAY_NOT_PASS].sort()).toEqual([
      'INJECTION_FAILED',
      'NOT_INJECTED',
      'REFUSED',
      'UNAVAILABLE',
    ]);
    expect(OUTCOMES_THAT_MAY_PASS.length + OUTCOMES_THAT_MAY_NOT_PASS.length).toBe(
      CHAOS_INJECTION_OUTCOME_LIST.length,
    );
  });

  it.each(OUTCOMES_THAT_MAY_NOT_PASS)(
    'refuses PASSED for %s even when every invariant is reported HELD',
    (outcome) => {
      const held: ChaosInvariantResult[] = CHAOS_INVARIANT_LIST.map((invariant) => ({
        invariant,
        verdict: 'HELD',
        strength: CHAOS_INVARIANT_DESCRIPTORS[invariant].strength,
        detail: 'held',
        undetermined: null,
      }));
      const verdict = chaosStatus({ outcome, results: held });
      expect(verdict.status).toBe('SKIPPED');
      expect(verdict.notRun?.kind).toBe(OUTCOME_NOT_RUN_KIND[outcome]);
      expect(verdict.notRun?.why).toContain(outcome);
    },
  );

  it('reports NOT_INJECTED, with no invariants evaluated, when the pattern matches nothing', async () => {
    const { page } = fakePage({
      requests: [{ method: 'GET', url: `${OWN}/api/customers` }],
      faulted: reading({ route: '/orders', visibleText: 'all good', busyIndicatorVisible: false }),
    });
    const outcome = await runChaosScenario(
      spec({ assertInvariants: ['STAYS_ON_ROUTE', 'NO_RAW_STACK_TRACE'] }),
      page,
    );

    expect(outcome.outcome).toBe('NOT_INJECTED');
    expect(outcome.claimed).toBe(0);
    /*
     * The invariants are deliberately NOT evaluated. A list of trivially-HELD
     * results is the thing a later reader, or a later refactor, mistakes for
     * evidence.
     */
    expect(outcome.results).toEqual([]);
    expect(outcome.notes.join(' ')).toContain('/api/orders');
    expect(outcome.notes.join(' ')).toContain('no fault was injected');
    expect(outcome.notAsserted.map((n) => n.reason)).toEqual([
      'SURFACE_UNREACHED',
      'SURFACE_UNREACHED',
    ]);

    const verdict = chaosStatus({ outcome: outcome.outcome, results: outcome.results });
    expect(verdict.status).toBe('SKIPPED');
    expect(verdict.notRun?.kind).toBe('NOT_RUN');
  });

  it('does not blame the environment for a stale pattern', () => {
    // NOT_RUN, not BLOCKED_BY_ENV: a wrong glob is not a broken firewall.
    expect(OUTCOME_NOT_RUN_KIND.NOT_INJECTED).toBe('NOT_RUN');
    expect(OUTCOME_NOT_RUN_KIND.REFUSED).toBe('UNSUPPORTED');
    expect(OUTCOME_NOT_RUN_KIND.INJECTED).toBeNull();
  });

  it('reports a zero claim count as zero and an unreached one as NULL', () => {
    const notInjected = chaosMetrics({
      outcome: 'NOT_INJECTED',
      refusal: null,
      results: [],
      capBite: null,
      writes: [],
      claimed: 0,
      notAsserted: [],
      notes: [],
    });
    const claimed = notInjected.find((m) => m.name === 'chaos_requests_claimed');
    expect(claimed?.value).toBe(0);
    expect(claimed?.unavailableReason).toBeNull();

    const unavailable = chaosMetrics({
      outcome: 'UNAVAILABLE',
      refusal: null,
      results: [],
      capBite: null,
      writes: [],
      claimed: 0,
      notAsserted: [],
      notes: [],
    });
    const notMeasured = unavailable.find((m) => m.name === 'chaos_requests_claimed');
    /*
     * The null-became-zero lie, in its chaos form: "the pattern matched nothing"
     * and "we never installed a handler" are different facts and only the first
     * is a zero.
     */
    expect(notMeasured?.value).toBeNull();
    expect(notMeasured?.unavailableReason).toContain('UNAVAILABLE');
  });
});

// ─── The counter-tests: real defects must still go red ───────────────────────

describe('a dependency that really breaks the application still fails the test', () => {
  const evidence = {
    typedFieldNames: ['addressLine1'],
    ownErrorText: 'We could not load your orders',
    ownSuccessText: 'Order placed',
    loadingStateSeen: true,
    populatedStateSeen: true,
    consoleChannelWorked: true,
    writeRequestsObservable: true,
    retryControl: { identity: 'button:retry', label: 'Try again' },
  };

  it('fails when the typed input is wiped, naming the FIELD and never its value', async () => {
    const { page } = fakePage({
      requests: [{ method: 'GET', url: `${OWN}/api/orders` }],
      clean: reading({
        route: '/orders',
        fieldValues: { addressLine1: 'qaai-SECRET-VALUE' },
        visibleText: 'form',
      }),
      faulted: reading({
        route: '/orders',
        fieldValues: { addressLine1: '' },
        visibleText: 'We could not load your orders',
      }),
    });
    /*
     * The fake's `clean` reading has to agree with what the plugin typed, so the
     * comparison is driven off a value this test does not know; instead the
     * spec's own seeded value is read back below.
     */
    const scenario = spec({
      evidence: { ...evidence, typedFieldNames: ['addressLine1'] },
      assertInvariants: ['NO_INPUT_LOSS'],
    });
    const typed = typedValuesFor(['addressLine1'], scenario.seed);
    const { page: page2 } = fakePage({
      requests: [{ method: 'GET', url: `${OWN}/api/orders` }],
      clean: reading({ route: '/orders', fieldValues: typed }),
      faulted: reading({ route: '/orders', fieldValues: { addressLine1: '' } }),
    });
    void page;

    const outcome = await runChaosScenario(scenario, page2);
    expect(outcome.outcome).toBe('INJECTED');
    const result = outcome.results[0];
    expect(result?.verdict).toBe('VIOLATED');
    expect(result?.detail).toContain('addressLine1');
    // The value is compared and never printed.
    expect(JSON.stringify(outcome)).not.toContain(typed.addressLine1);
  });

  it('fails when the page spins for ever', () => {
    const result = evaluateInvariant('NO_INFINITE_LOADING', {
      fault: 'NO_RESPONSE',
      evidence,
      before: reading({ busyIndicatorVisible: false }),
      after: reading({ busyIndicatorVisible: true }),
      afterRetry: null,
      writes: [],
    });
    expect(result.verdict).toBe('VIOLATED');
    expect(result.detail).toContain('for ever');
  });

  it('fails when a stack trace is rendered to the user', () => {
    const result = evaluateInvariant('NO_RAW_STACK_TRACE', {
      fault: 'UPSTREAM_500',
      evidence,
      before: reading({ visibleText: 'orders' }),
      after: reading({
        visibleText:
          'TypeError: cannot read properties of undefined\n    at OrderList (/srv/app/web/list.tsx:42:11)',
      }),
      afterRetry: null,
      writes: [],
    });
    expect(result.verdict).toBe('VIOLATED');
  });

  it('fails when the application claims success while the dependency is failing', () => {
    const result = evaluateInvariant('NO_FALSE_SUCCESS', {
      fault: 'UPSTREAM_500',
      evidence,
      before: reading({ visibleText: 'checkout' }),
      after: reading({ visibleText: 'Order placed — thank you!' }),
      afterRetry: null,
      writes: [],
    });
    expect(result.verdict).toBe('VIOLATED');
    expect(result.detail).toContain('reported success');
  });

  it('fails when the failure bounces the user off the route', () => {
    const result = evaluateInvariant('STAYS_ON_ROUTE', {
      fault: 'UPSTREAM_500',
      evidence,
      before: reading({ route: '/orders' }),
      after: reading({ route: '/login' }),
      afterRetry: null,
      writes: [],
    });
    expect(result.verdict).toBe('VIOLATED');
    expect(result.detail).toContain('/login');
  });

  it('fails when the retry control leaves the error on screen', () => {
    const result = evaluateInvariant('RETRY_RECOVERS', {
      fault: 'UPSTREAM_500',
      evidence,
      before: reading({}),
      after: reading({ visibleText: 'We could not load your orders' }),
      afterRetry: reading({ visibleText: 'We could not load your orders' }),
      writes: [],
    });
    expect(result.verdict).toBe('VIOLATED');
    expect(result.detail).toContain('did not re-issue');
  });

  it('fails when an unrendered value reaches the screen', () => {
    const result = evaluateInvariant('NO_PARTIAL_RENDER', {
      fault: 'SHAPE_DRIFT',
      evidence,
      before: reading({ visibleText: 'Total 10.00' }),
      after: reading({ visibleText: 'Total undefined' }),
      afterRetry: null,
      writes: [],
    });
    expect(result.verdict).toBe('VIOLATED');
  });

  it('fails when an empty collection renders the error path', () => {
    const result = evaluateInvariant('EMPTY_IS_NOT_ERROR', {
      fault: 'EMPTY_COLLECTION',
      evidence,
      before: reading({ visibleText: '3 orders' }),
      after: reading({ visibleText: 'We could not load your orders' }),
      afterRetry: null,
      writes: [],
    });
    expect(result.verdict).toBe('VIOLATED');
  });

  it('fails when an unhandled error reaches the console', () => {
    const result = evaluateInvariant('NO_UNHANDLED_RUNTIME_ERROR', {
      fault: 'UPSTREAM_500',
      evidence,
      before: reading({ consoleErrors: [] }),
      after: reading({ consoleErrors: ['Uncaught (in promise) TypeError: x is undefined'] }),
      afterRetry: null,
      writes: [],
    });
    expect(result.verdict).toBe('VIOLATED');
  });

  it('fails when the failure is swallowed entirely', () => {
    const result = evaluateInvariant('SOME_ERROR_SHOWN', {
      fault: 'UPSTREAM_500',
      evidence: {},
      before: reading({ visibleText: 'Orders' }),
      after: reading({ visibleText: 'Orders' }),
      afterRetry: null,
      writes: [],
    });
    expect(result.verdict).toBe('VIOLATED');
    expect(result.strength).toBe('WEAK');
  });

  it('holds, and says it proves very little, when only the floor is asserted', () => {
    const result = evaluateInvariant('SOME_ERROR_SHOWN', {
      fault: 'UPSTREAM_500',
      evidence: {},
      before: reading({ visibleText: 'Orders' }),
      after: reading({ visibleText: 'Something went wrong' }),
      afterRetry: null,
      writes: [],
    });
    expect(result.verdict).toBe('HELD');
    expect(result.detail).toContain('WEAK');
  });
});

// ─── The money invariant ─────────────────────────────────────────────────────

describe('no duplicate write', () => {
  const write = (keyGroup: number | null): ObservedWrite => ({
    method: 'POST',
    path: '/api/charges',
    keyGroup,
  });

  it('is UNDETERMINED rather than a pass when the flow issued no write', () => {
    /*
     * The quiet false green: a read-only page under a fault would otherwise be
     * counted as proof that the money path cannot double-charge.
     */
    const result = duplicateWriteVerdict([]);
    expect(result.verdict).toBe('UNDETERMINED');
    expect(result.undetermined).toBe('NO_WRITE_IN_FLOW');
  });

  it('holds on a single write', () => {
    expect(duplicateWriteVerdict([write(null)]).verdict).toBe('HELD');
  });

  it('fails on two unkeyed writes to the same path', () => {
    const result = duplicateWriteVerdict([write(null), write(null)]);
    expect(result.verdict).toBe('VIOLATED');
    expect(result.detail).toContain('no idempotency key');
  });

  it('holds on a repeat that carries the SAME idempotency key — a keyed retry', () => {
    const result = duplicateWriteVerdict([write(1), write(1)]);
    expect(result.verdict).toBe('HELD');
    expect(result.detail).toContain('keyed retry');
  });

  it('fails on a repeat under DIFFERENT keys, which the server cannot collapse', () => {
    const result = duplicateWriteVerdict([write(1), write(2)]);
    expect(result.verdict).toBe('VIOLATED');
    expect(result.detail).toContain('different idempotency');
  });

  it('does not conflate two different endpoints', () => {
    const result = duplicateWriteVerdict([
      { method: 'POST', path: '/api/charges', keyGroup: null },
      { method: 'POST', path: '/api/receipts', keyGroup: null },
    ]);
    expect(result.verdict).toBe('HELD');
  });

  it('never lets an idempotency KEY VALUE out of the handler', async () => {
    const secretKey = 'a0e1-not-a-real-key-9f3b';
    const state = emptyInjectionState();
    const handler = chaosRouteHandler(spec(), state, createHold());
    const first = fakeRoute({
      url: `${OWN}/api/charges`,
      method: 'POST',
      headers: { 'idempotency-key': secretKey },
    });
    const second = fakeRoute({
      url: `${OWN}/api/charges`,
      method: 'POST',
      headers: { 'idempotency-key': secretKey },
    });
    await handler(first.route);
    await handler(second.route);

    // Counted, grouped, and continued — never faulted.
    expect(state.writes).toEqual([
      { method: 'POST', path: '/api/charges', keyGroup: 1 },
      { method: 'POST', path: '/api/charges', keyGroup: 1 },
    ]);
    expect(first.calls.continued).toBe(1);
    expect(second.calls.continued).toBe(1);
    expect(first.calls.fulfilled).toEqual([]);
    expect(first.calls.aborted).toEqual([]);
    expect(JSON.stringify(state)).not.toContain(secretKey);
    expect(JSON.stringify(duplicateWriteVerdict(state.writes))).not.toContain(secretKey);
  });

  it('reads no trace id as an idempotency key', () => {
    // `x-request-id` changes per attempt by design; reading one would report
    // every correct retry as keyed and the defect would vanish.
    expect(IDEMPOTENCY_HEADERS).not.toContain('x-request-id');
  });
});

// ─── Safety: what is refused before anything is touched ──────────────────────

describe('refusals', () => {
  it('refuses a non-idempotent target at VALIDATE time, before a run is queued', () => {
    expect(() =>
      chaosScenarioSpecSchema.parse({
        target: { methods: ['POST'], pathGlob: '/api/orders' },
        fault: 'UPSTREAM_500',
        assertInvariants: ['STAYS_ON_ROUTE'],
        ownOrigins: [OWN],
        seed: 's',
      }),
    ).toThrow(/never injected against/);
  });

  it('refuses a loopback target with a named reason, and touches no page', async () => {
    const refusal = injectionRefusal(spec({ ownOrigins: ['http://127.0.0.1:3000'] }));
    expect(refusal?.reason).toBe('PRIVATE_TARGET');
    expect(refusal?.rule).toContain('loopback');

    /*
     * The page is `unavailableChaosPage`, whose `goto` REJECTS. A refusal that
     * reached the browser would surface as INJECTION_FAILED here, so this
     * asserts the ordering as well as the verdict.
     */
    const outcome = await runChaosScenario(
      spec({ ownOrigins: ['http://127.0.0.1:3000'] }),
      unavailableChaosPage,
    );
    expect(outcome.outcome).toBe('REFUSED');
    expect(outcome.results).toEqual([]);
  });

  it.each([
    ['http://10.0.0.5', 'private'],
    ['http://169.254.1.1', 'link-local'],
    ['http://printer.local', 'internal network name'],
  ])('refuses %s', (origin, needle) => {
    const refusal = injectionRefusal(spec({ ownOrigins: [origin] }));
    expect(refusal).not.toBeNull();
    expect(refusal?.rule).toContain(needle);
  });

  it('admits a public origin', () => {
    expect(injectionRefusal(spec({ ownOrigins: [OWN] }))).toBeNull();
  });

  it('does not claim a request on somebody else\'s origin', () => {
    /*
     * A glob like `/api/*` matches the application's own call AND a third
     * party's that shares the shape. Failing the second tests somebody else's
     * surface.
     */
    const scenario = spec({ target: { methods: ['GET'], pathGlob: '/api/*' } });
    expect(claimsRequest(scenario, { method: 'GET', url: `${OWN}/api/orders`, headers: {} })).toBe(
      true,
    );
    expect(
      claimsRequest(scenario, { method: 'GET', url: 'https://analytics.example.net/api/t', headers: {} }),
    ).toBe(false);
  });

  it('refuses a matcher carrying a query or a fragment', () => {
    for (const pathGlob of ['/api/orders?token=x', '/api/orders#top']) {
      expect(() =>
        chaosScenarioSpecSchema.parse({
          target: { methods: ['GET'], pathGlob },
          fault: 'UPSTREAM_500',
          assertInvariants: ['STAYS_ON_ROUTE'],
          ownOrigins: [OWN],
          seed: 's',
        }),
      ).toThrow(/may not carry a query/);
    }
  });

  it('strips the query from a URL before matching', () => {
    expect(requestPathOf(`${OWN}/api/orders?token=abcdef&page=2`)).toBe('/api/orders');
    expect(requestPathOf('/api/orders#frag')).toBe('/api/orders');
  });
});

// ─── Injection, against har.ts's own route interface ─────────────────────────

describe('the fault library, applied to a HarRoute', () => {
  async function inject(
    over: Partial<ChaosScenarioSpec>,
    init: Parameters<typeof fakeRoute>[0] = { url: `${OWN}/api/orders` },
  ): Promise<{ calls: RouteCalls; state: ReturnType<typeof emptyInjectionState> }> {
    const scenario = spec(over);
    const state = emptyInjectionState();
    const hold = createHold();
    const { route, calls } = fakeRoute(init);
    const promise = applyFault(route, scenario, state, hold);
    hold.release();
    await promise;
    return { calls, state };
  }

  it('fulfils a 500', async () => {
    const { calls } = await inject({ fault: 'UPSTREAM_500' });
    expect(calls.fulfilled[0]?.status).toBe(500);
  });

  it('carries Retry-After on a 503 and on a 429', async () => {
    for (const fault of ['SERVICE_UNAVAILABLE', 'RATE_LIMITED'] as const) {
      const { calls } = await inject({
        fault,
        assertInvariants: ['STAYS_ON_ROUTE'],
        options: {
          retryAfterSeconds: 30,
          throttleProfile: null,
          emptyEnvelope: null,
          dropFields: [],
          clockSkewSeconds: null,
          websocketUrlGlob: null,
        },
      });
      expect(calls.fulfilled[0]?.headers?.['retry-after']).toBe('30');
    }
  });

  it('aborts a refused connection, which is not a 5xx', async () => {
    const { calls } = await inject({ fault: 'CONNECTION_REFUSED' });
    expect(calls.aborted).toEqual(['connectionrefused']);
    expect(calls.fulfilled).toEqual([]);
  });

  it('holds a response until it is released, then times it out', async () => {
    const scenario = spec({ fault: 'NO_RESPONSE' });
    const state = emptyInjectionState();
    const hold = createHold();
    const { route, calls } = fakeRoute({ url: `${OWN}/api/orders` });
    const promise = applyFault(route, scenario, state, hold);

    // Nothing has been answered: the skeleton is on screen, which is the point.
    expect(calls.aborted).toEqual([]);
    expect(hold.pending()).toBe(1);

    hold.release();
    await promise;
    expect(calls.aborted).toEqual(['timedout']);
  });

  it('serves an HTML error page under an application/json content type', async () => {
    const { calls } = await inject({ fault: 'MALFORMED_JSON' });
    expect(calls.fulfilled[0]?.headers?.['content-type']).toBe('application/json');
    expect(calls.fulfilled[0]?.body).toBe(MALFORMED_JSON_BODY);
    // Not `{`: the defect is the proxy's HTML, not the parser's first character.
    expect(MALFORMED_JSON_BODY).toContain('502');
  });

  it('serves zero bytes for EMPTY_BODY and the declared envelope for EMPTY_COLLECTION', async () => {
    const empty = await inject({ fault: 'EMPTY_BODY' });
    expect(empty.calls.fulfilled[0]?.body).toBe('');

    const collection = await inject({
      fault: 'EMPTY_COLLECTION',
      assertInvariants: ['EMPTY_IS_NOT_ERROR'],
      evidence: { populatedStateSeen: true },
      options: {
        retryAfterSeconds: null,
        throttleProfile: null,
        emptyEnvelope: '{"data":[],"total":0}',
        dropFields: [],
        clockSkewSeconds: null,
        websocketUrlGlob: null,
      },
    });
    expect(collection.calls.fulfilled[0]?.body).toBe('{"data":[],"total":0}');
  });

  it('truncates the REAL body and keeps the length the client was promised', async () => {
    const body = '{"items":[{"name":"one"},{"name":"two"},{"name":"three"}]}';
    const { calls } = await inject(
      { fault: 'TRUNCATED_BODY', assertInvariants: ['NO_PARTIAL_RENDER'], evidence: { populatedStateSeen: true } },
      { url: `${OWN}/api/orders`, response: { body } },
    );
    expect(calls.fetched).toBe(1);
    const served = String(calls.fulfilled[0]?.body);
    expect(served.length).toBeLessThan(body.length);
    // The overstated length IS the fault: a short body alone is a small response.
    expect(calls.fulfilled[0]?.headers?.['content-length']).toBe(String(Buffer.byteLength(body)));
  });

  it('drops the named fields from the REAL response for SHAPE_DRIFT', async () => {
    const { calls } = await inject(
      {
        fault: 'SHAPE_DRIFT',
        assertInvariants: ['NO_PARTIAL_RENDER'],
        evidence: { populatedStateSeen: true },
        options: {
          retryAfterSeconds: null,
          throttleProfile: null,
          emptyEnvelope: null,
          dropFields: ['total'],
          clockSkewSeconds: null,
          websocketUrlGlob: null,
        },
      },
      { url: `${OWN}/api/orders`, response: { body: '{"total":10,"items":[{"name":"a","total":1}]}' } },
    );
    const served = String(calls.fulfilled[0]?.body);
    expect(served).not.toContain('total');
    expect(served).toContain('items');
  });

  it('records a failure rather than inventing a body when the dependency is not JSON', async () => {
    const { calls, state } = await inject(
      {
        fault: 'SHAPE_DRIFT',
        assertInvariants: ['NO_PARTIAL_RENDER'],
        evidence: { populatedStateSeen: true },
        options: {
          retryAfterSeconds: null,
          throttleProfile: null,
          emptyEnvelope: null,
          dropFields: ['total'],
          clockSkewSeconds: null,
          websocketUrlGlob: null,
        },
      },
      { url: `${OWN}/api/orders`, response: { body: '<html>nope</html>' } },
    );
    expect(state.failure).toContain('nothing was injected');
    // The real response is let through rather than replaced by one we made up.
    expect(calls.continued).toBe(1);
    expect(calls.fulfilled).toEqual([]);
  });

  it('never throws out of the handler when the upstream fetch fails', async () => {
    const { calls, state } = await inject(
      {
        fault: 'TRUNCATED_BODY',
        assertInvariants: ['NO_PARTIAL_RENDER'],
        evidence: { populatedStateSeen: true },
      },
      { url: `${OWN}/api/orders`, fetchThrows: true },
    );
    expect(state.failure).toContain('TRUNCATED_BODY');
    expect(calls.continued).toBe(1);
  });

  it('continues a request the pattern does not claim', async () => {
    const state = emptyInjectionState();
    const handler = chaosRouteHandler(spec(), state, createHold());
    const { route, calls } = fakeRoute({ url: `${OWN}/static/app.css` });
    await handler(route);
    expect(calls.continued).toBe(1);
    expect(state.claimed).toBe(0);
  });

  it('drops a field nested inside the response too', () => {
    expect(dropJsonFields('{"a":{"b":1,"c":2}}', ['b'])).toBe('{"a":{"c":2}}');
    expect(dropJsonFields('[{"b":1}]', ['b'])).toBe('[{}]');
    expect(dropJsonFields('not json', ['b'])).toBeNull();
  });

  it('declares the truncated length from the ORIGINAL body', () => {
    const cut = truncateBody('abcdefgh');
    expect(cut.body).toBe('abcd');
    expect(cut.declaredLength).toBe(8);
  });
});

// ─── Capability honesty ──────────────────────────────────────────────────────

describe('a fault this image cannot inject says so, and does not skip', () => {
  it.each([
    ['CLOCK_SKEW', 'CLOCK_INSTALL'],
    ['WEBSOCKET_DROPPED', 'WEBSOCKET_INTERCEPTION'],
    ['STALLED_RESPONSE', 'RESPONSE_STREAMING'],
  ] as const)('reports %s UNAVAILABLE when %s is absent', (fault, capability) => {
    const available = CHAOS_CAPABILITY_LIST.filter((c) => c !== capability);
    const gap = capabilityGap(fault as ChaosFaultKind, available, {
      retryAfterSeconds: null,
      throttleProfile: null,
      emptyEnvelope: null,
      dropFields: [],
      clockSkewSeconds: null,
      websocketUrlGlob: null,
    });
    expect(gap?.capability).toBe(capability);
    expect(gap?.remedy).toBe(CHAOS_CAPABILITY_REMEDY[capability]);
  });

  it('reports UNAVAILABLE when the page cannot route at all', async () => {
    const { page } = fakePage({ capabilities: [] });
    const outcome = await runChaosScenario(spec(), page);
    expect(outcome.outcome).toBe('UNAVAILABLE');
    expect(outcome.notes.join(' ')).toContain('ROUTE_INTERCEPTION');
    expect(outcome.notAsserted.map((n) => n.reason)).toEqual(['CAPABILITY_ABSENT']);
    const verdict = chaosStatus({ outcome: outcome.outcome, results: outcome.results });
    expect(verdict.status).toBe('SKIPPED');
    expect(verdict.notRun?.kind).toBe('BLOCKED_BY_ENV');
  });

  it('does not demand a throttle capability for the NO_THROTTLING decision', () => {
    /*
     * NO_THROTTLING is a decision a report may print, not a request for CDP.
     * Demanding the capability for it would make every SLOW_RESPONSE test
     * UNAVAILABLE on an image that can hold a response perfectly well.
     */
    const options = {
      retryAfterSeconds: null,
      throttleProfile: 'NO_THROTTLING',
      emptyEnvelope: null,
      dropFields: [],
      clockSkewSeconds: null,
      websocketUrlGlob: null,
    };
    const without = CHAOS_CAPABILITY_LIST.filter((c) => c !== 'NETWORK_THROTTLE');
    expect(capabilityGap('SLOW_RESPONSE', without, options)).toBeNull();
    expect(
      capabilityGap('SLOW_RESPONSE', without, { ...options, throttleProfile: 'SLOW_3G' })
        ?.capability,
    ).toBe('NETWORK_THROTTLE');
  });

  it('measures nothing through the unavailable page, and claims nothing', async () => {
    expect(await unavailableChaosPage.capabilities()).toEqual([]);
    expect(await unavailableChaosPage.clickRetry('x')).toBe(false);
    const read = await unavailableChaosPage.read([]);
    /*
     * All-nulls and not an empty screen. A stub reporting "the page loaded and
     * said nothing" would resolve every invariant against a fake.
     */
    expect(read).toEqual(emptyReading());
  });
});

// ─── Evidence gating ─────────────────────────────────────────────────────────

describe('an assertion with no evidence is UNDETERMINED, with the right reason', () => {
  it('tells "nobody captured it" apart from "this page has none"', () => {
    const notCaptured = evaluateInvariant('NO_INPUT_LOSS', {
      fault: 'UPSTREAM_500',
      evidence: {},
      before: reading({}),
      after: reading({}),
      afterRetry: null,
      writes: [],
    });
    expect(notCaptured.undetermined).toBe('EVIDENCE_NOT_CAPTURED');

    const lookedAndNone = evaluateInvariant('NO_INPUT_LOSS', {
      fault: 'UPSTREAM_500',
      evidence: { typedFieldNames: [] },
      before: reading({}),
      after: reading({}),
      afterRetry: null,
      writes: [],
    });
    /*
     * Two remedies: re-crawl with the behaviour capture on, versus "this page
     * has no fields and never will". Merging them sends somebody to re-crawl a
     * read-only dashboard.
     */
    expect(lookedAndNone.undetermined).toBe('EVIDENCE_ABSENT');
  });

  it('is UNDETERMINED, not HELD, when the probe could not answer', () => {
    const result = evaluateInvariant('NO_RAW_STACK_TRACE', {
      fault: 'UPSTREAM_500',
      evidence: {},
      before: reading({}),
      after: reading({ visibleText: null }),
      afterRetry: null,
      writes: [],
    });
    expect(result.verdict).toBe('UNDETERMINED');
    expect(result.undetermined).toBe('PROBE_UNAVAILABLE');
  });

  it('is UNDETERMINED when the invariant does not bear on the fault', () => {
    const result = evaluateInvariant('EMPTY_IS_NOT_ERROR', {
      fault: 'UPSTREAM_500',
      evidence: { populatedStateSeen: true },
      before: reading({}),
      after: reading({ visibleText: 'x' }),
      afterRetry: null,
      writes: [],
    });
    expect(result.undetermined).toBe('NOT_APPLICABLE_TO_FAULT');
  });

  it('reads an absent flag as "not captured" and a false one as "absent"', () => {
    expect(evidenceHeld({}, 'LOADING_STATE_SEEN')).toBeNull();
    expect(evidenceHeld({ loadingStateSeen: false }, 'LOADING_STATE_SEEN')).toBe(false);
    expect(evidenceHeld({ loadingStateSeen: true }, 'LOADING_STATE_SEEN')).toBe(true);
    expect(evidenceHeld({}, 'NONE')).toBe(true);
    expect(evidenceHeld({ ownErrorText: null }, 'OWN_ERROR_TEXT')).toBe(false);
    expect(evidenceHeld({}, 'OWN_ERROR_TEXT')).toBeNull();
  });

  it('refuses PASSED when every invariant came back UNDETERMINED', () => {
    const results: ChaosInvariantResult[] = [
      {
        invariant: 'NO_INPUT_LOSS',
        verdict: 'UNDETERMINED',
        strength: 'STRONG',
        detail: 'no evidence',
        undetermined: 'EVIDENCE_NOT_CAPTURED',
      },
    ];
    const verdict = chaosStatus({ outcome: 'INJECTED', results });
    expect(verdict.status).toBe('SKIPPED');
    expect(verdict.notRun?.why).toContain('nothing was measured');
  });

  it('records a pass\'s holes as DATA, so a gate can refuse to count it', async () => {
    const { page } = fakePage({
      requests: [{ method: 'GET', url: `${OWN}/api/orders` }],
      clean: reading({ route: '/orders' }),
      faulted: reading({ route: '/orders' }),
    });
    const outcome = await runChaosScenario(
      spec({
        // STAYS_ON_ROUTE decides; NO_INPUT_LOSS cannot, because no crawl
        // captured whether this page has fields at all.
        assertInvariants: ['STAYS_ON_ROUTE', 'NO_INPUT_LOSS'],
      }),
      page,
    );
    expect(outcome.outcome).toBe('INJECTED');
    expect(chaosStatus({ outcome: outcome.outcome, results: outcome.results }).status).toBe(
      'PASSED',
    );
    /*
     * The pass is correct AND incomplete, and the incompleteness is a value
     * rather than a sentence in a step title. This is the half-fix the round's
     * keystone minted UNASSERTED_REASONS to end.
     */
    expect(outcome.notAsserted).toEqual([
      {
        assertion: CHAOS_INVARIANT_DESCRIPTORS.NO_INPUT_LOSS.claim,
        reason: 'SURFACE_UNREACHED',
      },
    ]);
  });

  it('does not report an assertion nobody owes as a hole', () => {
    /*
     * EVIDENCE_ABSENT is "the crawl looked and this page has no typed fields".
     * There is nothing to assert, now or ever, so listing it would inflate our
     * own gap list and send somebody to re-crawl a read-only dashboard for ever.
     */
    expect(UNDETERMINED_AS_HOLE.EVIDENCE_ABSENT).toBeNull();
    expect(UNDETERMINED_AS_HOLE.NOT_APPLICABLE_TO_FAULT).toBeNull();
    expect(UNDETERMINED_AS_HOLE.EVIDENCE_NOT_CAPTURED).toBe('SURFACE_UNREACHED');
    expect(UNDETERMINED_AS_HOLE.PROBE_UNAVAILABLE).toBe('CAPABILITY_ABSENT');
    expect(UNDETERMINED_AS_HOLE.NO_WRITE_IN_FLOW).toBe('SURFACE_UNREACHED');

    expect(
      holesIn([
        {
          invariant: 'NO_INPUT_LOSS',
          verdict: 'UNDETERMINED',
          strength: 'STRONG',
          detail: 'd',
          undetermined: 'EVIDENCE_ABSENT',
        },
        {
          invariant: 'STAYS_ON_ROUTE',
          verdict: 'HELD',
          strength: 'STRONG',
          detail: 'd',
          undetermined: null,
        },
      ]),
    ).toEqual([]);
  });

  it('discloses a cap that bit as a hole as well as a count', async () => {
    const { page } = fakePage({
      requests: [
        { method: 'GET', url: `${OWN}/api/orders` },
        { method: 'GET', url: `${OWN}/api/orders` },
      ],
      clean: reading({ route: '/orders' }),
      faulted: reading({ route: '/orders' }),
    });
    const outcome = await runChaosScenario(spec({ maxInterceptions: 1 }), page);
    expect(outcome.capBite?.discarded).toBe(1);
    expect(outcome.notAsserted.some((h) => h.reason === 'CAP_BIT')).toBe(true);
  });

  it('passes on a mix of HELD and UNDETERMINED, with the holes disclosed', () => {
    const results: ChaosInvariantResult[] = [
      { invariant: 'STAYS_ON_ROUTE', verdict: 'HELD', strength: 'STRONG', detail: 'ok', undetermined: null },
      {
        invariant: 'NO_INPUT_LOSS',
        verdict: 'UNDETERMINED',
        strength: 'STRONG',
        detail: 'no evidence',
        undetermined: 'EVIDENCE_NOT_CAPTURED',
      },
    ];
    const verdict = chaosStatus({ outcome: 'INJECTED', results });
    expect(verdict.status).toBe('PASSED');
    expect(verdict.why).toContain('1 invariant(s) held');
  });

  it('fails even on a REFUSED outcome when an invariant was actually violated', () => {
    /*
     * A violated invariant is a real finding and is not thrown away by the
     * outcome gate. The gate's job is to stop a PASS, not to suppress a FAIL.
     */
    const verdict = chaosStatus({
      outcome: 'REFUSED',
      results: [
        {
          invariant: 'NO_RAW_STACK_TRACE',
          verdict: 'VIOLATED',
          strength: 'STRONG',
          detail: 'trace on screen',
          undetermined: null,
        },
      ],
    });
    expect(verdict.status).toBe('FAILED');
  });
});

// ─── Stack-trace detection ───────────────────────────────────────────────────

describe('a stack trace is told apart from an error message', () => {
  it.each([
    ['node', 'Error: boom\n    at handler (/srv/app/index.js:12:9)'],
    ['browser', 'TypeError: x\n    at https://shop.example.com/assets/main.js:1:2'],
    ['python', 'Traceback (most recent call last):\n  File "app.py", line 3'],
    ['java', 'oops\n    at com.shop.Orders(Orders.java:88)'],
    ['go', 'panic: nil map\n\ngoroutine 1 [running]:'],
    ['bundler', 'at webpack-internal:///./src/list.tsx'],
    ['dependency', 'boom /node_modules/@scope/pkg/dist/x.js:9:1'],
  ])('recognises a %s trace', (_dialect, text) => {
    expect(looksLikeStackTrace(text)).toBe(true);
  });

  it.each([
    'We could not load your orders. Please try again.',
    'Error: your card was declined. Use another card.',
    'Something went wrong at our end — we have been told.',
  ])('does not call a well-written message a trace: %s', (text) => {
    /*
     * The important false positive. Every good error message contains the word
     * "error" or "at", so the patterns are anchored on FRAME SYNTAX. A detector
     * that fired on these would fail every correct application.
     */
    expect(looksLikeStackTrace(text)).toBe(false);
  });
});

// ─── Caps ────────────────────────────────────────────────────────────────────

describe('a cap that bit is reported as a count AND a reason', () => {
  it('discloses the interception cap and lets the extras through unfaulted', async () => {
    const state = emptyInjectionState();
    const scenario = spec({ maxInterceptions: 1 });
    const handler = chaosRouteHandler(scenario, state, createHold());
    const seen: RouteCalls[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { route, calls } = fakeRoute({ url: `${OWN}/api/orders` });
      seen.push(calls);
      await handler(route);
    }

    expect(state.claimed).toBe(1);
    expect(state.overCap).toBe(2);
    expect(seen[0]?.fulfilled).toHaveLength(1);
    expect(seen[1]?.continued).toBe(1);
    expect(seen[2]?.continued).toBe(1);

    const bite = capBiteFor(scenario, state);
    expect(bite).toEqual({
      cap: 'INTERCEPTIONS',
      limit: 1,
      bites: 2,
      discarded: 2,
      reason: expect.stringContaining('maxInterceptions is 1'),
    });
    expect(bite?.reason).toContain('Raise it');
  });

  it('reports no bite when the cap did not bite', () => {
    expect(capBiteFor(spec(), emptyInjectionState())).toBeNull();
  });

  it('puts the over-cap count in the metrics', () => {
    const metrics = chaosMetrics({
      outcome: 'INJECTED',
      refusal: null,
      results: [],
      capBite: { cap: 'INTERCEPTIONS', limit: 1, bites: 2, discarded: 2, reason: 'r' },
      writes: [],
      claimed: 1,
      notAsserted: [],
      notes: [],
    });
    expect(metrics.find((m) => m.name === 'chaos_requests_over_cap')?.value).toBe(2);
  });
});

// ─── Determinism ─────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('types byte-identical values for the same seed, and different ones for another', () => {
    const a = typedValuesFor(['email', 'address'], 'seed-1');
    const b = typedValuesFor(['email', 'address'], 'seed-1');
    const c = typedValuesFor(['email', 'address'], 'seed-2');
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
    for (const value of Object.values(a)) expect(value.startsWith('qaai-')).toBe(true);
  });

  it('produces a byte-identical scenario result for the same seed', async () => {
    const run = async (): Promise<string> => {
      const { page } = fakePage({
        requests: [{ method: 'GET', url: `${OWN}/api/orders` }],
        clean: reading({ route: '/orders', visibleText: 'Orders' }),
        faulted: reading({ route: '/orders', visibleText: 'We could not load your orders' }),
      });
      const outcome = await runChaosScenario(
        spec({
          assertInvariants: ['STAYS_ON_ROUTE', 'ERROR_IS_NAMED'],
          evidence: { ownErrorText: 'We could not load your orders' },
        }),
        page,
      );
      return JSON.stringify(outcome);
    };
    expect(await run()).toBe(await run());
  });

  it('reads no clock and sleeps nowhere in the injection logic', () => {
    /*
     * A held response is released on a CONDITION, which is what makes a chaos
     * run reproducible — and what admission's NO_FIXED_SLEEP gate exists to
     * keep. `Date.now()` appears once, for the execution's own duration, and
     * nothing in this file may sleep or schedule.
     */
    const source = readFileSync(join(import.meta.dirname, 'chaos.ts'), 'utf8');
    /*
     * CALLS, not mentions: the first version of this scanned for the bare name
     * and went red on this file's own header, which says "no `Math.random`".
     * A guard that cannot survive being documented is a guard somebody deletes.
     */
    expect(source).not.toMatch(/setTimeout\(|setInterval\(|waitForTimeout\(/);
    expect(source).not.toMatch(/Math\.random\(/);
    // Twice, both in `execute`, both for the execution's own duration.
    expect(source.match(/Date\.now\(\)/g) ?? []).toHaveLength(2);
  });
});

// ─── The lift from the stored spec ───────────────────────────────────────────

describe('a stored chaos spec runs, and the lift is exact rather than approximate', () => {
  const stored = {
    path: '/orders',
    urlPattern: '/api/orders?page=1',
    fault: 'HTTP_500' as const,
    delayMs: null,
    expectVisible: 'We could not load your orders',
    expectNotVisible: 'Order placed',
  };

  it('is a spec the shared schema accepts, so this is not a shape I invented', () => {
    expect(
      chaosTestSpecSchema.safeParse({
        path: stored.path,
        urlPattern: stored.urlPattern,
        fault: stored.fault,
        expectVisible: stored.expectVisible,
        expectNotVisible: stored.expectNotVisible,
      }).success,
    ).toBe(true);
  });

  it('turns expectVisible into ERROR_IS_NAMED and expectNotVisible into NO_FALSE_SUCCESS', () => {
    const lifted = liftStoredChaosSpec(stored, { baseUrlOrigin: OWN, seed: 's' });
    expect(lifted.spec.assertInvariants).toContain('ERROR_IS_NAMED');
    expect(lifted.spec.assertInvariants).toContain('NO_FALSE_SUCCESS');
    expect(lifted.spec.evidence.ownErrorText).toBe(stored.expectVisible);
    expect(lifted.spec.evidence.ownSuccessText).toBe(stored.expectNotVisible);
  });

  it('adds the two evidence-free invariants and SAYS SO', () => {
    const lifted = liftStoredChaosSpec(stored, { baseUrlOrigin: OWN, seed: 's' });
    for (const added of LIFT_ADDED_INVARIANTS) {
      expect(lifted.spec.assertInvariants).toContain(added);
    }
    /*
     * An assertion the author did not write is a surprise if it is quiet. The
     * note is what keeps it readable in the result rather than inferable from
     * the source.
     */
    expect(lifted.notes.join(' ')).toContain('STAYS_ON_ROUTE');
    expect(lifted.notes.join(' ')).toContain('NO_RAW_STACK_TRACE');
  });

  it('takes the idempotent method set rather than inventing GET', () => {
    const lifted = liftStoredChaosSpec(stored, { baseUrlOrigin: OWN, seed: 's' });
    expect(lifted.spec.target.methods).toEqual([...IDEMPOTENT_METHODS]);
  });

  it('keeps the query out of the matcher and takes the origin from the run', () => {
    const lifted = liftStoredChaosSpec(stored, { baseUrlOrigin: OWN, seed: 's' });
    expect(lifted.spec.target.pathGlob).toBe('/api/orders');
    expect(lifted.spec.ownOrigins).toEqual([OWN]);
  });

  it('turns delayMs into a DECLARED profile and not into a sleep', () => {
    const lifted = liftStoredChaosSpec(
      { ...stored, fault: 'SLOW_RESPONSE', delayMs: 3000 },
      { baseUrlOrigin: OWN, seed: 's' },
    );
    expect(lifted.spec.options.throttleProfile).toBe('DECLARED_3000MS');
    expect(lifted.notes.join(' ')).toContain('released on a condition');
  });

  it('drops ERROR_IS_NAMED on a fault that is not an error, rather than producing a refused spec', () => {
    // EMPTY_BODY IS in ERROR_IS_NAMED's fault list, so it stays.
    const kept = liftStoredChaosSpec(
      { ...stored, fault: 'EMPTY_BODY' },
      { baseUrlOrigin: OWN, seed: 's' },
    );
    expect(kept.spec.assertInvariants).toContain('ERROR_IS_NAMED');

    /*
     * A HOLD fault is read while the response is still held, so the screen
     * shows a spinner and NO error-shaped assertion bears on it — not even the
     * weak floor. The first version of the lift fell back to SOME_ERROR_SHOWN
     * unconditionally and produced a spec `chaosScenarioSpecSchema` refused:
     * the lift and the schema disagreed about applicability, which is why both
     * now ask `invariantApplies`.
     */
    const held = liftStoredChaosSpec(
      { ...stored, fault: 'SLOW_RESPONSE', delayMs: 10 },
      { baseUrlOrigin: OWN, seed: 's' },
    );
    expect(held.spec.assertInvariants).not.toContain('ERROR_IS_NAMED');
    expect(held.spec.assertInvariants).not.toContain('SOME_ERROR_SHOWN');
    expect(held.notes.join(' ')).toContain('ERROR_IS_NAMED was dropped');
    expect(held.notes.join(' ')).toContain('could not be converted');
    // What is left still asserts something, which is why the spec is accepted.
    expect(held.spec.assertInvariants.length).toBeGreaterThan(0);

    /*
     * And a fault where the floor DOES apply takes it, so the fallback is not
     * dead code.
     */
    const floored = liftStoredChaosSpec(
      { ...stored, fault: 'TRUNCATED_BODY' },
      { baseUrlOrigin: OWN, seed: 's' },
    );
    expect(floored.spec.assertInvariants).toContain('ERROR_IS_NAMED');
  });

  it('keeps the floor when it applies and ERROR_IS_NAMED does not', () => {
    const lifted = liftStoredChaosSpec(
      { ...stored, fault: 'SLOW_RESPONSE', delayMs: 10 },
      { baseUrlOrigin: OWN, seed: 's' },
    );
    // SLOW_RESPONSE has no applicable error assertion at all; see above.
    expect(lifted.spec.assertInvariants).toEqual(
      expect.arrayContaining(['STAYS_ON_ROUTE', 'NO_RAW_STACK_TRACE', 'NO_FALSE_SUCCESS']),
    );
  });

  it('is accepted by parseChaosSpec in either vocabulary', () => {
    const fromStored = parseChaosSpec(stored, { baseUrlOrigin: OWN, seed: 's' });
    expect(fromStored.spec.fault).toBe('UPSTREAM_500');
    expect(fromStored.notes.length).toBeGreaterThan(0);

    const rich = parseChaosSpec(spec(), { baseUrlOrigin: OWN, seed: 's' });
    expect(rich.notes).toEqual([]);
  });

  it('refuses a spec that is neither', () => {
    expect(() => parseChaosSpec({ nonsense: true }, { baseUrlOrigin: OWN, seed: 's' })).toThrow(
      /invalid CHAOS spec/,
    );
  });
});

// ─── The spec's own refusals ─────────────────────────────────────────────────

describe('the spec refuses what would run as less than it says', () => {
  it('refuses a fault with a required option missing', () => {
    expect(() =>
      chaosScenarioSpecSchema.parse({
        target: { methods: ['GET'], pathGlob: '/api/orders' },
        fault: 'SERVICE_UNAVAILABLE',
        assertInvariants: ['SOME_ERROR_SHOWN'],
        ownOrigins: [OWN],
        seed: 's',
      }),
    ).toThrow(/needs `retryAfterSeconds`/);
  });

  it('refuses an option set on a fault that does not read it', () => {
    expect(() =>
      chaosScenarioSpecSchema.parse({
        target: { methods: ['GET'], pathGlob: '/api/orders' },
        fault: 'UPSTREAM_500',
        assertInvariants: ['SOME_ERROR_SHOWN'],
        ownOrigins: [OWN],
        seed: 's',
        options: { throttleProfile: 'SLOW_3G' },
      }),
    ).toThrow(/silently ignored/);
  });

  it('refuses an invariant that could only ever be UNDETERMINED', () => {
    expect(() =>
      chaosScenarioSpecSchema.parse({
        target: { methods: ['GET'], pathGlob: '/api/orders' },
        fault: 'UPSTREAM_500',
        assertInvariants: ['EMPTY_IS_NOT_ERROR'],
        ownOrigins: [OWN],
        seed: 's',
      }),
    ).toThrow(/do not bear on UPSTREAM_500/);
  });

  it('requires a seed, with no default', () => {
    expect(() =>
      chaosScenarioSpecSchema.parse({
        target: { methods: ['GET'], pathGlob: '/api/orders' },
        fault: 'UPSTREAM_500',
        assertInvariants: ['STAYS_ON_ROUTE'],
        ownOrigins: [OWN],
      }),
    ).toThrow();
  });

  it('refuses a spec that asserts nothing', () => {
    expect(() =>
      chaosScenarioSpecSchema.parse({
        target: { methods: ['GET'], pathGlob: '/api/orders' },
        fault: 'UPSTREAM_500',
        assertInvariants: [],
        ownOrigins: [OWN],
        seed: 's',
      }),
    ).toThrow();
  });

  it("names the assertion field so the agent's spec-assertion reader counts it", () => {
    /*
     * `specAssertions` in packages/agent/src/suite-health.ts decides whether a
     * spec-driven test declares anything to check by matching this regex
     * against the spec's KEY NAMES, and generation REFUSES a test that asserts
     * nothing. A field called `invariants` matches none of it, so every correct
     * CHAOS spec would have been refused. The regex is restated here, not
     * imported, because @qaai/runner does not depend on @qaai/agent — and
     * that is exactly why it needs pinning.
     */
    const SPEC_ASSERTION_KEYS =
      /(expect|assert|schema|jsonpath|contains|match|equals|bodyincludes|threshold|budget|violation)/;
    const keys = Object.keys(spec());
    const asserting = keys.filter((key) => SPEC_ASSERTION_KEYS.test(key.toLowerCase()));
    expect(asserting).toContain('assertInvariants');
  });
});

// ─── The plugin ──────────────────────────────────────────────────────────────

describe('the plugin', () => {
  it('declares the literal CHAOS type, which TEST_TYPES does not contain yet', () => {
    expect(chaosPlugin.type).toBe('CHAOS');
  });

  it('validates both vocabularies and rejects neither-shape', () => {
    expect(() => chaosPlugin.validate(makeTest(spec()))).not.toThrow();
    expect(() =>
      chaosPlugin.validate(
        makeTest({
          path: '/orders',
          urlPattern: '/api/orders',
          fault: 'HTTP_500',
          expectVisible: 'oops',
        }),
      ),
    ).not.toThrow();
    expect(() => chaosPlugin.validate(makeTest({ fault: 'NOPE' }))).toThrow(/invalid spec/);
  });

  it('runs a stored spec end to end and reports PASSED on a well-behaved application', async () => {
    const previous = setChaosDeps({
      page: fakePage({
        requests: [{ method: 'GET', url: `${OWN}/api/orders` }],
        clean: reading({ route: '/orders', visibleText: 'Orders', busyIndicatorVisible: false }),
        faulted: reading({
          route: '/orders',
          visibleText: 'We could not load your orders',
          busyIndicatorVisible: false,
          consoleErrors: [],
        }),
      }).page,
    });
    try {
      const execution = await chaosPlugin.execute(
        makeCtx(),
        makeTest({
          path: '/orders',
          urlPattern: '/api/orders',
          fault: 'HTTP_500',
          expectVisible: 'We could not load your orders',
          expectNotVisible: 'Order placed',
        }),
      );
      expect(execution.status).toBe('PASSED');
      expect(execution.steps[0]?.title).toContain('INJECTED');
      expect(execution.steps.some((s) => s.title.includes('ERROR_IS_NAMED'))).toBe(true);
      expect(execution.steps.some((s) => s.title.includes('NO_RAW_STACK_TRACE'))).toBe(true);
      expect(execution.notRun ?? null).toBeNull();
    } finally {
      setChaosDeps(previous);
    }
  });

  it('is UNAVAILABLE out of the box, because no browser adapter ships wired', async () => {
    const execution = await chaosPlugin.execute(makeCtx(), makeTest(spec()));
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('BLOCKED_BY_ENV');
    expect(execution.notRun?.why).toContain('ROUTE_INTERCEPTION');
    expect(execution.metrics?.find((m) => m.name === 'chaos_requests_claimed')?.value).toBeNull();
  });

  it('is INJECTION_FAILED, not FAILED, when the adapter throws', async () => {
    const previous = setChaosDeps({ page: fakePage({ gotoThrows: true }).page });
    try {
      const execution = await chaosPlugin.execute(makeCtx(), makeTest(spec()));
      /*
       * A broken navigation says nothing about the customer's error handling.
       * Reporting FAILED here would put a red mark on their code for our bug.
       */
      expect(execution.status).toBe('SKIPPED');
      expect(execution.notRun?.kind).toBe('BLOCKED_BY_ENV');
      expect(execution.notRun?.why).toContain('browser adapter failed');
    } finally {
      setChaosDeps(previous);
    }
  });

  it('writes every not-asserted hole as its own step', () => {
    const execution = chaosExecution(
      makeTest(spec()),
      spec(),
      {
        outcome: 'UNAVAILABLE',
        refusal: null,
        results: [],
        capBite: null,
        writes: [],
        claimed: 0,
        notAsserted: [
          { assertion: CHAOS_INVARIANT_DESCRIPTORS.NO_INPUT_LOSS.claim, reason: 'CAPABILITY_ABSENT' },
        ],
        notes: ['CLOCK_SKEW needs CLOCK_INSTALL'],
      },
      0,
      null,
    );
    const hole = execution.steps.find((s) => s.title.startsWith('not asserted'));
    expect(hole?.title).toContain('CAPABILITY_ABSENT');
    expect(hole?.status).toBe('SKIPPED');
    expect(execution.console.map((c) => c.text)).toContain('CLOCK_SKEW needs CLOCK_INSTALL');
  });

  it('puts the actionable sentence in notRun, beside the verdict', async () => {
    const previous = setChaosDeps({
      page: fakePage({ requests: [{ method: 'GET', url: `${OWN}/api/other` }] }).page,
    });
    try {
      const execution = await chaosPlugin.execute(makeCtx(), makeTest(spec()));
      expect(execution.notRun?.kind).toBe('NOT_RUN');
      expect(execution.notRun?.why).toContain('NOT_INJECTED');
      expect(execution.notRun?.why).toContain('/api/orders');
    } finally {
      setChaosDeps(previous);
    }
  });

  it('fails the test when the invariant is violated under a real injection', async () => {
    const previous = setChaosDeps({
      page: fakePage({
        requests: [{ method: 'GET', url: `${OWN}/api/orders` }],
        clean: reading({ route: '/orders', visibleText: 'Orders' }),
        faulted: reading({
          route: '/orders',
          visibleText: 'Error: boom\n    at loader (/srv/app/x.js:1:1)',
        }),
      }).page,
    });
    try {
      const execution = await chaosPlugin.execute(
        makeCtx(),
        makeTest({
          path: '/orders',
          urlPattern: '/api/orders',
          fault: 'HTTP_500',
          expectVisible: 'Error',
        }),
      );
      expect(execution.status).toBe('FAILED');
      expect(execution.errorMessage).toContain('NO_RAW_STACK_TRACE');
    } finally {
      setChaosDeps(previous);
    }
  });
});
