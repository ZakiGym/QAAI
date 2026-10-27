/**
 * ADVERSARIAL COUNTER-TESTS, written against the plugin rather than with it.
 *
 * Each one is an attempt to MAKE the plugin report a pass it did not earn,
 * built from a fixture the colocated suite does not hold. Where a sweep over a
 * whole exported union was possible it is done that way rather than over the
 * members somebody remembered to list: that is what makes a new member
 * un-passable by default instead of un-passable by review.
 */
import { describe, expect, it } from 'vitest';
import { pushTestSpecSchema } from '@qaai/shared';
import {
  runPushDelivery,
  pushStatus,
  PUSH_OUTCOME_LIST,
  PUSH_PASSING_OUTCOME,
  refuseLiveSender,
  unavailablePushObserver,
  type PushDeps,
  type PushObserver,
} from '../plugins/push.js';

const SPEC = pushTestSpecSchema.parse({
  deliveries: [
    {
      transport: 'WEB_PUSH',
      triggerPath: '/orders/1/ship',
      expectTitle: 'Your order shipped',
      timeoutSeconds: 5,
    },
  ],
  environment: { permissions: ['NOTIFICATIONS'] },
});
const DELIVERY = SPEC.deliveries[0]!;

/** Everything works and the OS simply never produced a notification. */
function depsSeeingNothing(): PushDeps {
  const observer: PushObserver = {
    available: () => Promise.resolve({ ok: true as const }),
    // The characteristic lie: "we asked the OS and heard nothing".
    observe: () => Promise.resolve([]),
    tap: () => Promise.resolve({ supported: false, landedOn: null, detail: 'no tap' }),
  };
  return {
    observer,
    trigger: { fire: () => Promise.resolve({ fired: true, detail: 'POST sent' }) },
    worker: { claimedScope: () => Promise.resolve('/') },
    senders: { describe: () => Promise.resolve({ present: true, mode: 'TEST' as const }) },
    clock: { now: () => 1_000 },
  };
}

describe('ADVERSARY — PUSH: silence is not success', () => {
  it('reports REQUESTED_NOT_OBSERVED, and pushStatus maps it to FAILED not PASSED', async () => {
    const r = await runPushDelivery(DELIVERY, SPEC.environment, 'https://app.example.com', depsSeeingNothing());
    expect(r.outcome).toBe('REQUESTED_NOT_OBSERVED');
    expect(pushStatus(r.outcome)).toBe('FAILED');
    expect(pushStatus(r.outcome)).not.toBe('PASSED');
    expect(pushStatus(r.outcome)).not.toBe('SKIPPED');
  });

  it('DELIVERED is the ONLY passing outcome, checked across the whole union', () => {
    for (const outcome of PUSH_OUTCOME_LIST) {
      if (outcome === PUSH_PASSING_OUTCOME) expect(pushStatus(outcome)).toBe('PASSED');
      else expect(pushStatus(outcome), outcome).not.toBe('PASSED');
    }
    expect(PUSH_PASSING_OUTCOME).toBe('DELIVERED');
  });

  it('an observer that cannot see is UNAVAILABLE, NOT the FAILED not-observed outcome', async () => {
    const blind: PushDeps = {
      ...depsSeeingNothing(),
      observer: unavailablePushObserver,
    };
    const r = await runPushDelivery(DELIVERY, SPEC.environment, 'https://app.example.com', blind);
    expect(r.outcome).toBe('UNAVAILABLE');
    expect(r.outcome).not.toBe('REQUESTED_NOT_OBSERVED');
    expect(pushStatus(r.outcome)).toBe('SKIPPED');
    expect(r.unavailableReason).not.toBeNull();
  });

  it('the not-observed sentence bounds the claim with the elapsed observation', async () => {
    const r = await runPushDelivery(DELIVERY, SPEC.environment, 'https://app.example.com', depsSeeingNothing());
    expect(r.observedForMs).toBe(0);
    expect(r.detail).toMatch(/NOT a pass/);
    // It must not claim "no notification was sent".
    expect(r.detail).not.toMatch(/no notification was sent/i);
  });
});

describe('ADVERSARY — PUSH: live senders, every path', () => {
  const paths: Array<{ mode: 'LIVE' | 'UNKNOWN' | 'TEST'; present: boolean; refused: boolean }> = [
    { mode: 'LIVE', present: true, refused: true },
    { mode: 'UNKNOWN', present: true, refused: true },
    { mode: 'TEST', present: false, refused: true },
    { mode: 'TEST', present: true, refused: false },
  ];

  for (const p of paths) {
    it(`mode=${p.mode} present=${p.present} → ${p.refused ? 'REFUSED' : 'allowed'}`, async () => {
      const delivery = { ...DELIVERY, senderIntegrationId: 'int_abc' };
      const out = await refuseLiveSender(delivery, {
        describe: () => Promise.resolve({ present: p.present, mode: p.mode }),
      });
      if (p.refused) expect(out).not.toBeNull();
      else expect(out).toBeNull();
    });
  }

  it('a LIVE sender never reaches the observe step — the delivery is UNAVAILABLE', async () => {
    const live: PushDeps = {
      ...depsSeeingNothing(),
      senders: { describe: () => Promise.resolve({ present: true, mode: 'LIVE' as const }) },
      // If the trigger were ever fired against a live sender that is the finding.
      trigger: {
        fire: () => {
          throw new Error('ADVERSARY: the trigger fired against a LIVE sender');
        },
      },
    };
    const r = await runPushDelivery(
      { ...DELIVERY, senderIntegrationId: 'int_live' },
      SPEC.environment,
      'https://app.example.com',
      live,
    );
    expect(r.outcome).toBe('UNAVAILABLE');
    expect(r.unavailableReason).toBe('LIVE_SENDER_REFUSED');
  });

  it('APNS/FCM with no sender credential cannot be expressed at all', () => {
    for (const transport of ['APNS', 'FCM'] as const) {
      const parsed = pushTestSpecSchema.safeParse({
        deliveries: [{ transport, triggerPath: '/x', expectTitle: 'hi' }],
      });
      expect(parsed.success, transport).toBe(false);
    }
  });
});
