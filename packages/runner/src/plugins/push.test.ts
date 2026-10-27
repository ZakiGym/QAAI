/**
 * The push plugin, and the one lie it must never tell.
 *
 * Push is the test type most likely to produce a FALSE GREEN, because "we asked
 * the OS and heard nothing back" looks exactly like success: no exception, no
 * failed request, no red. A plugin written the obvious way would report a
 * healthy notification path on an application that sends nothing, on an image
 * with no device, for ever.
 *
 * So the heaviest block in this file is REQUESTED_NOT_OBSERVED CAN NEVER BE
 * PASSED, and it is written to survive a future change of mind about WHICH
 * non-pass it is: one test pins the invariant (`!== 'PASSED'`, at the mapping,
 * across the whole list and through the execution path) and a separate one
 * pins today's choice (FAILED). Weakening the second cannot weaken the first.
 *
 * The counter-tests matter as much. A notification that really does arrive with
 * the wrong title, or whose deep link really does not route, must still fail —
 * or REQUESTED_NOT_OBSERVED becomes a way to make every notification bug
 * disappear into a pass.
 *
 * Nothing here touches a device, a provider, a browser or a socket. Every
 * surface is a fake, and the credential source is STRUCTURALLY incapable of
 * handing over a value — which is itself asserted, because that is the only
 * guard rule 11's "never log a device token or a provider key" actually needs.
 */

import { describe, expect, it } from 'vitest';
import { DEVICE_BOUND_PUSH_TRANSPORTS, PUSH_TRANSPORTS, pushTestSpecSchema } from '@qaai/shared';
import type { ExecutableTest, PushTransport, RunContext, TestExecution } from '@qaai/shared';
import {
  PUSH_OUTCOMES,
  PUSH_OUTCOME_LABELS,
  PUSH_OUTCOME_LIST,
  PUSH_PASSING_OUTCOME,
  PUSH_UNAVAILABLE_AS_UNASSERTED,
  PUSH_UNAVAILABLE_REASONS,
  PUSH_UNAVAILABLE_REASON_LIST,
  PUSH_UNAVAILABLE_REMEDIES,
  closestNotification,
  compareNotification,
  missingPermissionGrant,
  pushPlugin,
  pushStatus,
  realPushClock,
  refuseLiveSender,
  requestedNotObservedWhy,
  runPushDelivery,
  runPushTest,
  setPushDeps,
  unavailablePushObserver,
  unavailablePushTrigger,
  unavailableSenderCredentials,
  unavailableServiceWorker,
} from './push.js';
import type {
  ObservedNotification,
  PushClock,
  PushDeliverySpec,
  PushDeps,
  PushObserver,
  PushTestSpec,
  PushTrigger,
  SenderCredential,
  SenderCredentialSource,
  ServiceWorkerSurface,
  TapResult,
} from './push.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

/**
 * A clock that advances by a fixed step on every read, so the elapsed
 * observation window in a disclosure sentence is a known number and nothing
 * sleeps.
 */
function fakeClock(stepMs = 1_200): PushClock {
  let now = 1_000_000;
  return {
    now: () => {
      const value = now;
      now += stepMs;
      return value;
    },
  };
}

interface FakeObserverOptions {
  available?: PushUnavailableName | null;
  notifications?: readonly ObservedNotification[];
  tap?: TapResult;
}
type PushUnavailableName = (typeof PUSH_UNAVAILABLE_REASONS)[number];

function fakeObserver(options: FakeObserverOptions = {}): PushObserver & {
  observeCalls: number;
  tapCalls: number;
} {
  const state = { observeCalls: 0, tapCalls: 0 };
  return {
    get observeCalls() {
      return state.observeCalls;
    },
    get tapCalls() {
      return state.tapCalls;
    },
    available: async () =>
      options.available
        ? { ok: false as const, reason: options.available }
        : { ok: true as const },
    observe: async () => {
      state.observeCalls += 1;
      return options.notifications ?? [];
    },
    tap: async () => {
      state.tapCalls += 1;
      return (
        options.tap ?? { supported: true, landedOn: '/orders/931', detail: 'Tapped.' }
      );
    },
  };
}

function fakeTrigger(fired = true): PushTrigger & { fires: number } {
  const state = { fires: 0 };
  return {
    get fires() {
      return state.fires;
    },
    fire: async (triggerPath) => {
      state.fires += 1;
      return { fired, detail: fired ? `Fired ${triggerPath}.` : 'The route answered 500.' };
    },
  };
}

function fakeWorker(scope: string | null = '/'): ServiceWorkerSurface {
  return { claimedScope: async () => scope };
}

function fakeSenders(credential: SenderCredential): SenderCredentialSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    describe: async (id) => {
      asked.push(id);
      return credential;
    },
  };
}

function deps(overrides: Partial<PushDeps> = {}): PushDeps {
  return {
    observer: overrides.observer ?? fakeObserver(),
    trigger: overrides.trigger ?? fakeTrigger(),
    worker: overrides.worker ?? fakeWorker(),
    senders: overrides.senders ?? fakeSenders({ present: true, mode: 'TEST' }),
    clock: overrides.clock ?? fakeClock(),
  };
}

const notification = (
  overrides: Partial<ObservedNotification> = {},
): ObservedNotification => ({
  title: 'Your order shipped',
  body: 'Order 931 is on its way.',
  data: { orderId: '931' },
  deepLink: '/orders/931',
  badge: 1,
  priority: 'high',
  ...overrides,
});

function makeSpec(overrides: Record<string, unknown> = {}): PushTestSpec {
  return pushTestSpecSchema.parse({
    deliveries: [
      {
        transport: 'WEB_PUSH',
        triggerPath: '/checkout/complete',
        expectTitle: 'Your order shipped',
        timeoutSeconds: 5,
      },
    ],
    environment: { permissions: ['NOTIFICATIONS'] },
    ...overrides,
  });
}

function firstDelivery(spec: PushTestSpec): PushDeliverySpec {
  const delivery = spec.deliveries[0];
  if (delivery === undefined) throw new Error('the fixture has no delivery');
  return delivery;
}

function makeCtx(signal?: AbortSignal): RunContext & { logged: string[] } {
  const logged: string[] = [];
  return {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl: 'https://shop.example.com',
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
    signal: signal ?? new AbortController().signal,
    determinism: {
      freezeClockAt: null,
      randomSeed: 1,
      waitForNetworkIdle: false,
      retryOnce: false,
    },
    logged,
  };
}

function makeTest(spec: unknown, name = 'the shipping notification is delivered'): ExecutableTest {
  return {
    id: 'test_1',
    name,
    // PUSH is not in TEST_TYPES yet — see the registry's PENDING_PLUGINS.
    type: 'E2E',
    code: '',
    filePath: 'push/shipping.json',
    spec,
    timeoutMs: 60_000,
    quarantined: false,
    tags: [],
  };
}

/** Every string a result carries, flattened, for the "nothing leaked" sweeps. */
function allText(execution: TestExecution): string {
  return JSON.stringify(execution);
}

// ─── THE INVARIANT ───────────────────────────────────────────────────────────

describe('REQUESTED_NOT_OBSERVED can never be reported as PASSED', () => {
  it('maps away from PASSED, whatever else changes about it', () => {
    /*
     * THE test this file exists for. Deliberately written as `not PASSED`
     * rather than as `=== 'FAILED'`: a future round may decide the right
     * non-pass is SKIPPED, and that decision must not be able to take this
     * guard with it.
     */
    expect(pushStatus('REQUESTED_NOT_OBSERVED')).not.toBe('PASSED');
  });

  it('is FAILED today, which is a separate claim from the invariant above', () => {
    expect(pushStatus('REQUESTED_NOT_OBSERVED')).toBe('FAILED');
  });

  it('leaves DELIVERED as the ONLY outcome that passes', () => {
    const passing = PUSH_OUTCOMES.filter((outcome) => pushStatus(outcome) === 'PASSED');
    expect(passing).toEqual([PUSH_PASSING_OUTCOME]);
    expect(PUSH_PASSING_OUTCOME).toBe('DELIVERED');
  });

  it('keeps "we saw the wrong one" apart from "we saw nothing"', () => {
    /*
     * Both are FAILED and they are NOT the same fact. MISMATCHED is a defect
     * this run PROVED — we read the notification field by field — while
     * REQUESTED_NOT_OBSERVED is bounded by what one observer could see. Folding
     * the first into the second would attach the "nothing seen is not nothing
     * sent" caveat to a result that has no need of it, which understates a
     * defect the customer can act on today.
     */
    expect(pushStatus('MISMATCHED')).toBe('FAILED');
    expect(pushStatus('REQUESTED_NOT_OBSERVED')).toBe('FAILED');
    expect(PUSH_OUTCOME_LABELS.MISMATCHED).not.toBe(
      PUSH_OUTCOME_LABELS.REQUESTED_NOT_OBSERVED,
    );
    expect(requestedNotObservedWhy(firstDelivery(makeSpec()), 1_000, 10)).toContain(
      'does not establish that nothing was sent',
    );
  });

  it('never passes a whole test in which any delivery was not observed', async () => {
    /*
     * The mapping being right is not enough: `runPushTest` aggregates, and an
     * aggregate that let one DELIVERED outvote one REQUESTED_NOT_OBSERVED would
     * reinstate the false green one level up. Two deliveries, one of each — the
     * observer answers once with a notification and then with nothing, which is
     * what a second trigger that sends nothing actually looks like.
     */
    const spec = makeSpec({
      deliveries: [
        {
          transport: 'WEB_PUSH',
          triggerPath: '/a',
          expectTitle: 'Your order shipped',
          timeoutSeconds: 1,
        },
        {
          transport: 'WEB_PUSH',
          triggerPath: '/b',
          expectTitle: 'Your order shipped',
          timeoutSeconds: 1,
        },
      ],
    });
    const batches: ObservedNotification[][] = [[notification()], []];
    const observer: PushObserver = {
      available: async () => ({ ok: true as const }),
      observe: async () => batches.shift() ?? [],
      tap: async () => ({ supported: false, landedOn: null, detail: 'no' }),
    };
    const execution = await runPushTest(makeCtx(), makeTest(spec), spec, deps({ observer }));
    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toContain('REQUESTED_NOT_OBSERVED');
  });

  it('never passes a test in which nothing was observed at all', async () => {
    const spec = makeSpec();
    const execution = await runPushTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({ observer: fakeObserver({ notifications: [] }) }),
    );
    expect(execution.status).not.toBe('PASSED');
    expect(execution.status).toBe('FAILED');
  });

  it('says in writing that nothing seen is not nothing sent', () => {
    /*
     * The sentence is the honesty. A reader who is told only "no notification
     * arrived" will go and debug the application; a reader told what was and
     * was not established can tell our bound from their bug.
     */
    const why = requestedNotObservedWhy(firstDelivery(makeSpec()), 5_000, 1_200);
    expect(why).toContain('NOT a pass');
    expect(why).toContain('does not establish that nothing was sent');
    expect(why).toContain('1200ms');
    expect(why).toContain('5000ms');
    expect(why).toContain('timeoutSeconds');
  });
});

describe('UNAVAILABLE is kept apart from REQUESTED_NOT_OBSERVED', () => {
  it('skips rather than fails when no observer can see the transport', async () => {
    /*
     * The mirror-image false report: an environment gap recorded as a FAILED
     * notification path. That is QAAI blaming the customer's code for this
     * image having no device, and it is why `available` is asked BEFORE the
     * trigger fires.
     */
    const trigger = fakeTrigger();
    const result = await runPushDelivery(
      firstDelivery(makeSpec()),
      /*
       * The grant IS present, deliberately. With no `environment` block the
       * permission gate refuses first and this test would pass even with the
       * observer gate deleted — a mutation proved exactly that. Granting
       * NOTIFICATIONS leaves the observer check as the only thing standing
       * between this call and a REQUESTED_NOT_OBSERVED, which is what the test
       * is named after.
       */
      { permissions: ['NOTIFICATIONS'] },
      'https://shop.example.com',
      deps({ observer: fakeObserver({ available: 'NO_DEVICE' }), trigger }),
    );
    expect(result.outcome).toBe('UNAVAILABLE');
    expect(result.unavailableReason).toBe('NO_DEVICE');
    expect(pushStatus(result.outcome)).toBe('SKIPPED');
    expect(trigger.fires).toBe(0);
  });

  it('calls a trigger that never fired UNAVAILABLE, not REQUESTED_NOT_OBSERVED', async () => {
    const observer = fakeObserver({ notifications: [notification()] });
    const result = await runPushDelivery(
      firstDelivery(makeSpec()),
      { permissions: ['NOTIFICATIONS'] },
      'https://shop.example.com',
      deps({ observer, trigger: fakeTrigger(false) }),
    );
    // "Requested" is false, so the name would be a lie — and the status would
    // be FAILED, on a trigger we could not even send.
    expect(result.outcome).toBe('UNAVAILABLE');
    expect(observer.observeCalls).toBe(0);
    expect(result.detail).toContain('nothing was requested');
  });

  it('refuses rather than skips silently: every UNAVAILABLE carries a remedy', async () => {
    const seen = new Set<string>();
    for (const reason of PUSH_UNAVAILABLE_REASONS) {
      expect(PUSH_UNAVAILABLE_REMEDIES[reason], reason).toBeTruthy();
      expect(PUSH_UNAVAILABLE_REMEDIES[reason].length, reason).toBeGreaterThan(40);
      // Each remedy must be its own sentence, or two gaps share one dead end.
      expect(seen.has(PUSH_UNAVAILABLE_REMEDIES[reason]), reason).toBe(false);
      seen.add(PUSH_UNAVAILABLE_REMEDIES[reason]);
    }
  });

  it('files our refusal apart from a missing install', () => {
    /*
     * Rule 12: a REFUSED surface must not be recorded the same way as one that
     * does not exist. A report that filed the live-sender refusal as
     * CAPABILITY_ABSENT would send somebody to fix the Dockerfile.
     */
    expect(PUSH_UNAVAILABLE_AS_UNASSERTED.LIVE_SENDER_REFUSED).toBe('WOULD_MUTATE_PROTECTED_DATA');
    expect(PUSH_UNAVAILABLE_AS_UNASSERTED.NO_DEVICE).toBe('CAPABILITY_ABSENT');
    expect(PUSH_UNAVAILABLE_AS_UNASSERTED.NO_SENDER_CREDENTIAL).toBe(
      'REQUIRES_PROVISIONED_SANDBOX',
    );
  });

  it('does not pass a test whose every delivery was unavailable', async () => {
    const spec = makeSpec();
    const execution = await runPushTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({ observer: fakeObserver({ available: 'NO_DEVICE' }) }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun).toEqual({ kind: 'NOT_RUN', why: expect.any(String) });
    expect(execution.notRun?.why).toContain('nothing is claimed');
    // The remedy has to survive into the result, or the gap is a dead end.
    expect(execution.notRun?.why).toContain('device farm');
  });

  it('passes a mixed run and DISCLOSES the count that was not measured', async () => {
    /*
     * Rule 12: a cap that bit must be reported as a count AND a reason. Here
     * the "cap" is a transport this image cannot observe, and a pass that did
     * not say so would put an APNs delivery inside a green percentage.
     */
    const spec = makeSpec({
      deliveries: [
        {
          transport: 'WEB_PUSH',
          triggerPath: '/a',
          expectTitle: 'Your order shipped',
          timeoutSeconds: 1,
        },
        {
          transport: 'APNS',
          triggerPath: '/b',
          expectTitle: 'Your order shipped',
          senderIntegrationId: 'int_apns_test',
          timeoutSeconds: 1,
        },
      ],
    });
    const observer: PushObserver = {
      available: async (transport: PushTransport) =>
        transport === 'WEB_PUSH'
          ? { ok: true as const }
          : { ok: false as const, reason: 'NO_DEVICE' as const },
      observe: async () => [notification()],
      tap: async () => ({ supported: true, landedOn: '/orders/931', detail: 'Tapped.' }),
    };
    const execution = await runPushTest(makeCtx(), makeTest(spec), spec, deps({ observer }));
    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage).toContain('1 of 2 delivery(ies) were NOT measured');
    expect(execution.errorMessage).toContain('NO_DEVICE');
  });
});

// ─── The structural credential refusal ───────────────────────────────────────

describe('the plugin is structurally incapable of driving a live sender', () => {
  it('cannot obtain a credential value through the only interface it has', async () => {
    /*
     * The type-level half of rule 11, asserted at run time because a comment
     * is not a guard. `SenderCredential` has two fields and neither is a
     * secret, so there is no expression in push.ts that can reach a device
     * token, a push certificate or a provider key — to log, to hash, or to put
     * in an error path.
     */
    const credential = await unavailableSenderCredentials.describe('int_1');
    expect(Object.keys(credential).sort()).toEqual(['mode', 'present']);
    for (const key of ['value', 'token', 'secret', 'key', 'pem', 'certificate', 'deviceToken']) {
      expect(credential, key).not.toHaveProperty(key);
    }
  });

  it('refuses a LIVE sender and triggers nothing', async () => {
    const spec = makeSpec({
      deliveries: [
        {
          transport: 'FCM',
          triggerPath: '/orders/ship',
          expectTitle: 'Your order shipped',
          senderIntegrationId: 'int_fcm_live',
          timeoutSeconds: 1,
        },
      ],
    });
    const trigger = fakeTrigger();
    const result = await runPushDelivery(
      firstDelivery(spec),
      spec.environment,
      'https://shop.example.com',
      deps({
        trigger,
        senders: fakeSenders({ present: true, mode: 'LIVE' }),
        observer: fakeObserver({ notifications: [notification()] }),
      }),
    );
    expect(result.outcome).toBe('UNAVAILABLE');
    expect(result.unavailableReason).toBe('LIVE_SENDER_REFUSED');
    expect(trigger.fires).toBe(0);
  });

  it('refuses an UNKNOWN mode exactly as hard as LIVE', async () => {
    /*
     * The mutation that matters most in this file. `mode !== 'TEST'` becoming
     * `mode === 'LIVE'` reads as a tightening and is the one change that lets a
     * row nobody looked at drive a real notification to a real person. Absent
     * is NOT "probably test".
     */
    const unknown = await refuseLiveSender(
      {
        ...firstDelivery(makeSpec()),
        transport: 'FCM',
        senderIntegrationId: 'int_unprobed',
      },
      fakeSenders({ present: true, mode: 'UNKNOWN' }),
    );
    expect(unknown?.reason).toBe('LIVE_SENDER_REFUSED');
    expect(unknown?.detail).toContain('UNKNOWN');
  });

  it('lets WEB_PUSH past with no Integration, which is the app’s own VAPID setup', async () => {
    const allowed = await refuseLiveSender(
      { ...firstDelivery(makeSpec()), senderIntegrationId: null },
      fakeSenders({ present: false, mode: 'UNKNOWN' }),
    );
    expect(allowed).toBeNull();
  });

  it('refuses a device-bound transport with no Integration even off-schema', async () => {
    /*
     * `pushDeliverySchema` already refuses this at parse time, and
     * `runPushDelivery` is exported and callable with a hand-built spec. A
     * run-time path that trusted the schema to have run is a path that fails
     * open.
     */
    for (const transport of DEVICE_BOUND_PUSH_TRANSPORTS) {
      const refused = await refuseLiveSender(
        { ...firstDelivery(makeSpec()), transport, senderIntegrationId: null },
        fakeSenders({ present: true, mode: 'TEST' }),
      );
      expect(refused?.reason, transport).toBe('NO_SENDER_CREDENTIAL');
    }
  });

  it('never puts a credential-shaped string into a result, because it never holds one', async () => {
    /*
     * Derived from the exported vocabulary rather than hand-written — the
     * previous round's hand-written list probed 16 of 27 declared shapes — and
     * COMPOSED at run time from a prefix plus an obviously-fake tail, because a
     * complete key-shaped literal in a test file is what GitHub push
     * protection blocks (lesson E).
     */
    const fakeTail = 'NOTAREALKEY000000000000';
    const spec = makeSpec({
      deliveries: [
        {
          transport: 'FCM',
          triggerPath: '/orders/ship',
          expectTitle: 'Your order shipped',
          senderIntegrationId: `int_${fakeTail}`,
          timeoutSeconds: 1,
        },
      ],
    });
    const execution = await runPushTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({
        senders: fakeSenders({ present: true, mode: 'TEST' }),
        observer: fakeObserver({ available: 'NO_DEVICE' }),
      }),
    );
    // The Integration ID is a customer-visible identifier and may appear; a
    // credential may not, and there is no path by which one could.
    expect(allText(execution)).not.toContain(fakeTail.toLowerCase());
    expect(execution.status).toBe('SKIPPED');
  });
});

// ─── The permission and worker gates ─────────────────────────────────────────

describe('a Web Push delivery is refused before it can produce a false failure', () => {
  it('refuses a WEB_PUSH delivery with no environment block at all', () => {
    const gap = missingPermissionGrant('WEB_PUSH', undefined);
    expect(gap?.reason).toBe('NO_PERMISSION_GRANT');
    expect(gap?.detail).toContain('environment');
    expect(gap?.detail).toContain('NOTIFICATIONS');
  });

  it('refuses a WEB_PUSH delivery whose grant list omits NOTIFICATIONS', () => {
    const gap = missingPermissionGrant('WEB_PUSH', { permissions: ['GEOLOCATION'] });
    expect(gap?.reason).toBe('NO_PERMISSION_GRANT');
    expect(gap?.detail).toContain('1 permission(s)');
  });

  it('does NOT apply the browser grant rule to a device transport', () => {
    /*
     * An OS-level grant on a handset is not a Playwright permission. Asserting
     * the browser block for APNs would refuse a correct device spec, so this is
     * the counter-test to the two above.
     */
    for (const transport of DEVICE_BOUND_PUSH_TRANSPORTS) {
      expect(missingPermissionGrant(transport, undefined), transport).toBeNull();
    }
  });

  it('refuses when no service worker claimed a scope, and names the remedy', async () => {
    const trigger = fakeTrigger();
    const result = await runPushDelivery(
      firstDelivery(makeSpec()),
      { permissions: ['NOTIFICATIONS'] },
      'https://shop.example.com',
      deps({ worker: fakeWorker(null), trigger }),
    );
    expect(result.outcome).toBe('UNAVAILABLE');
    expect(result.unavailableReason).toBe('NO_SERVICE_WORKER');
    expect(result.detail).toContain('service worker');
    expect(trigger.fires).toBe(0);
  });

  it('rejects the spec at validate() rather than after a run was queued', () => {
    const spec = {
      deliveries: [
        { transport: 'WEB_PUSH', triggerPath: '/a', expectTitle: 'Shipped', timeoutSeconds: 5 },
      ],
    };
    expect(() => pushPlugin.validate(makeTest(spec))).toThrow(/NOTIFICATIONS/);
  });

  it('accepts a granted spec at validate()', () => {
    expect(() => pushPlugin.validate(makeTest(makeSpec()))).not.toThrow();
  });
});

// ─── What a delivered notification must match ────────────────────────────────

describe('a notification that arrived wrong still fails', () => {
  it('reports every mismatched field, not the first', () => {
    const problems = compareNotification(
      {
        ...firstDelivery(makeSpec()),
        expectTitle: 'Your order shipped',
        expectBody: 'Order 932',
        expectDeepLink: '/orders/932',
      },
      notification({ title: 'Your order was cancelled' }),
    );
    expect(problems.map((p) => p.field)).toEqual(['title', 'body', 'deepLink']);
  });

  it('tells a missing deep link apart from an empty one', () => {
    const problems = compareNotification(
      { ...firstDelivery(makeSpec()), expectDeepLink: '/orders' },
      notification({ deepLink: null }),
    );
    expect(problems[0]?.actual).toBe('(the payload carries no deep link)');
  });

  it('accepts a deep link that appends a campaign id, which every real one does', () => {
    const problems = compareNotification(
      { ...firstDelivery(makeSpec()), expectDeepLink: '/orders/931' },
      notification({ deepLink: '/orders/931?utm=push&mid=abc' }),
    );
    expect(problems).toEqual([]);
  });

  it('fails when the deep link is in the payload and does not route', async () => {
    /*
     * The half that silently rots: the payload is perfect, the notification
     * arrives, and tapping it opens the home screen. A plugin that stopped at
     * the payload would pass this for ever.
     */
    const spec = makeSpec({
      deliveries: [
        {
          transport: 'WEB_PUSH',
          triggerPath: '/checkout/complete',
          expectTitle: 'Your order shipped',
          expectDeepLink: '/orders/931',
          timeoutSeconds: 1,
        },
      ],
    });
    const result = await runPushDelivery(
      firstDelivery(spec),
      spec.environment,
      'https://shop.example.com',
      deps({
        observer: fakeObserver({
          notifications: [notification()],
          tap: { supported: true, landedOn: '/', detail: 'Landed on the home screen.' },
        }),
      }),
    );
    expect(result.outcome).toBe('MISMATCHED');
    expect(pushStatus(result.outcome)).toBe('FAILED');
    expect(result.detail).toContain('does not route');
    // The bounded caveat belongs to the OTHER outcome; this one is proved.
    expect(result.detail).not.toContain('does not establish that nothing was sent');
  });

  it('records an un-tappable environment as a stated hole, not as a pass on the deep link', async () => {
    const spec = makeSpec({
      deliveries: [
        {
          transport: 'WEB_PUSH',
          triggerPath: '/checkout/complete',
          expectTitle: 'Your order shipped',
          expectDeepLink: '/orders/931',
          timeoutSeconds: 1,
        },
      ],
    });
    const result = await runPushDelivery(
      firstDelivery(spec),
      spec.environment,
      'https://shop.example.com',
      deps({
        observer: fakeObserver({
          notifications: [notification()],
          tap: { supported: false, landedOn: null, detail: 'This observer cannot tap.' },
        }),
      }),
    );
    expect(result.outcome).toBe('DELIVERED');
    expect(result.notAsserted.map((h) => h.reason)).toContain('CAPABILITY_ABSENT');
    expect(result.detail).toContain('NOT followed');
  });

  it('picks the closest notification, so delivery order cannot decide the verdict', () => {
    const delivery = { ...firstDelivery(makeSpec()), expectTitle: 'Your order shipped' };
    const wrong = notification({ title: 'A new message from Sam' });
    const right = notification();
    expect(closestNotification(delivery, [wrong, right])?.notification.title).toBe(right.title);
    expect(closestNotification(delivery, [right, wrong])?.notification.title).toBe(right.title);
  });

  it('reports the closest candidate’s real mismatches when none matches', () => {
    const delivery = { ...firstDelivery(makeSpec()), expectTitle: 'Your order shipped' };
    const closest = closestNotification(delivery, [notification({ title: 'Cancelled' })]);
    expect(closest?.problems.map((p) => p.field)).toEqual(['title']);
  });

  it('passes a delivery that matches, and says how long it waited', async () => {
    const spec = makeSpec();
    const result = await runPushDelivery(
      firstDelivery(spec),
      spec.environment,
      'https://shop.example.com',
      deps({ observer: fakeObserver({ notifications: [notification()] }) }),
    );
    expect(result.outcome).toBe('DELIVERED');
    expect(result.observedForMs).toBe(1_200);
    expect(pushStatus(result.outcome)).toBe('PASSED');
  });
});

// ─── The vocabulary guards ───────────────────────────────────────────────────

describe('the push vocabularies cannot drift', () => {
  it('keeps the outcome union, its presence record and its labels one set', () => {
    expect([...PUSH_OUTCOME_LIST].sort()).toEqual([...PUSH_OUTCOMES].sort());
    for (const outcome of PUSH_OUTCOMES) {
      expect(PUSH_OUTCOME_LABELS[outcome], outcome).toBeTruthy();
      expect(pushStatus(outcome), outcome).toBeTruthy();
    }
  });

  it('keeps the unavailable reasons, their remedies and their unasserted mapping one set', () => {
    expect([...PUSH_UNAVAILABLE_REASON_LIST].sort()).toEqual([...PUSH_UNAVAILABLE_REASONS].sort());
    expect(Object.keys(PUSH_UNAVAILABLE_REMEDIES).sort()).toEqual(
      [...PUSH_UNAVAILABLE_REASONS].sort(),
    );
    expect(Object.keys(PUSH_UNAVAILABLE_AS_UNASSERTED).sort()).toEqual(
      [...PUSH_UNAVAILABLE_REASONS].sort(),
    );
  });

  it('reaches an outcome for every transport the product names', async () => {
    /*
     * The failure the two guards above cannot catch: a transport the schema
     * accepts and `runPushDelivery` silently falls through. A fall-through
     * returns undefined here.
     */
    for (const transport of PUSH_TRANSPORTS) {
      const result = await runPushDelivery(
        {
          ...firstDelivery(makeSpec()),
          transport,
          senderIntegrationId: DEVICE_BOUND_PUSH_TRANSPORTS.includes(transport)
            ? 'int_test'
            : null,
        },
        { permissions: ['NOTIFICATIONS'] },
        'https://shop.example.com',
        deps({ observer: fakeObserver({ notifications: [notification()] }) }),
      );
      expect(result, transport).toBeDefined();
      expect(PUSH_OUTCOMES, transport).toContain(result.outcome);
    }
  });
});

// ─── The unavailable adapters, which are the production default ──────────────

describe('the default surfaces refuse rather than fake an answer', () => {
  it('reports a device transport as NO_DEVICE and a web one as NO_OBSERVER', async () => {
    for (const transport of PUSH_TRANSPORTS) {
      const verdict = await unavailablePushObserver.available(transport);
      expect(verdict.ok, transport).toBe(false);
      if (!verdict.ok) {
        expect(
          verdict.reason,
          transport,
        ).toBe(DEVICE_BOUND_PUSH_TRANSPORTS.includes(transport) ? 'NO_DEVICE' : 'NO_OBSERVER');
      }
    }
  });

  it('never reports itself available and then observes nothing', async () => {
    /*
     * The combination that would turn the default build into a machine for
     * failing every customer's notification path: `available: true` plus an
     * empty `observe`.
     */
    const verdict = await unavailablePushObserver.available('WEB_PUSH');
    expect(verdict.ok).toBe(false);
    expect(await unavailablePushObserver.observe('WEB_PUSH', 1_000)).toEqual([]);
  });

  it('claims no service-worker scope and fires no trigger', async () => {
    expect(await unavailableServiceWorker.claimedScope('/')).toBeNull();
    expect((await unavailablePushTrigger.fire('/a', 'https://x.example.com')).fired).toBe(false);
  });

  it('runs a whole test through the defaults as SKIPPED with a remedy', async () => {
    const previous = setPushDeps({
      observer: unavailablePushObserver,
      trigger: unavailablePushTrigger,
      worker: unavailableServiceWorker,
      senders: unavailableSenderCredentials,
    });
    try {
      const execution = await pushPlugin.execute(makeCtx(), makeTest(makeSpec()));
      expect(execution.status).toBe('SKIPPED');
      expect(execution.notRun?.kind).toBe('NOT_RUN');
      expect(execution.steps.every((step) => step.status === 'SKIPPED')).toBe(true);
    } finally {
      setPushDeps(previous);
    }
  });

  it('gives the real clock a monotonic-enough now()', () => {
    // The one line of the real adapter worth pinning: a clock returning a
    // constant would make every disclosure sentence say 0ms.
    expect(typeof realPushClock.now()).toBe('number');
    expect(realPushClock.now()).toBeGreaterThan(0);
  });
});

// ─── Cancellation and step shape ─────────────────────────────────────────────

describe('the result shape', () => {
  it('stops at a cancelled run without claiming a pass', async () => {
    const controller = new AbortController();
    controller.abort();
    const spec = makeSpec();
    const execution = await runPushTest(
      makeCtx(controller.signal),
      makeTest(spec),
      spec,
      deps({ observer: fakeObserver({ notifications: [notification()] }) }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.steps).toEqual([]);
    expect(execution.notRun?.why).toContain('cancelled');
  });

  it('puts an error on a FAILED step and nothing on a SKIPPED one', async () => {
    const spec = makeSpec({
      deliveries: [
        {
          transport: 'WEB_PUSH',
          triggerPath: '/a',
          expectTitle: 'Never sent',
          timeoutSeconds: 1,
        },
        {
          transport: 'APNS',
          triggerPath: '/b',
          expectTitle: 'Shipped',
          senderIntegrationId: 'int_test',
          timeoutSeconds: 1,
        },
      ],
    });
    const observer: PushObserver = {
      available: async (transport: PushTransport) =>
        transport === 'WEB_PUSH'
          ? { ok: true as const }
          : { ok: false as const, reason: 'NO_DEVICE' as const },
      observe: async () => [],
      tap: async () => ({ supported: false, landedOn: null, detail: 'no' }),
    };
    const execution = await runPushTest(makeCtx(), makeTest(spec), spec, deps({ observer }));
    const failed = execution.steps.find((step) => step.status === 'FAILED');
    const skippedStep = execution.steps.find((step) => step.status === 'SKIPPED');
    expect(failed?.error?.message).toContain('REQUESTED_NOT_OBSERVED');
    expect(skippedStep?.error).toBeNull();
    // The step status is DERIVED from pushStatus, so the two can never disagree.
    for (const step of execution.steps) {
      expect(['PASSED', 'FAILED', 'SKIPPED']).toContain(step.status);
    }
  });

  it('logs a step for every delivery', async () => {
    const ctx = makeCtx();
    const spec = makeSpec();
    await runPushTest(
      ctx,
      makeTest(spec),
      spec,
      deps({ observer: fakeObserver({ notifications: [notification()] }) }),
    );
    expect(ctx.logged).toHaveLength(1);
    expect(ctx.logged[0]).toContain('PASSED');
  });

  it('turns a thrown surface into UNAVAILABLE rather than a failed notification path', async () => {
    const spec = makeSpec();
    const observer: PushObserver = {
      available: async () => {
        throw new Error('the device farm hung up');
      },
      observe: async () => [],
      tap: async () => ({ supported: false, landedOn: null, detail: 'no' }),
    };
    const execution = await runPushTest(makeCtx(), makeTest(spec), spec, deps({ observer }));
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.why).toContain('the device farm hung up');
  });
});
