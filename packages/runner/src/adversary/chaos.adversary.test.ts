/**
 * ADVERSARIAL COUNTER-TESTS, written against the plugin rather than with it.
 *
 * These are not a second copy of the colocated suite. Each one is an attempt to
 * MAKE the plugin lie, built from a fixture the plugin's own tests do not hold:
 * a page that installs the route handler and never issues the request, a probe
 * that can read nothing off the screen, and a brute force over the WHOLE
 * outcome union rather than the members somebody remembered to list. The union
 * sweep is the one that matters most — it is what makes a sixteenth outcome
 * un-passable by default instead of un-passable by review.
 */
import { describe, expect, it } from 'vitest';
import {
  chaosScenarioSpecSchema,
  chaosStatus,
  runChaosScenario,
  evaluateInvariant,
  CHAOS_INJECTION_OUTCOME_LIST,
  OUTCOMES_THAT_MAY_PASS,
  emptyReading,
  type ChaosPageSurface,
  type ChaosProbeReading,
  type ChaosCapability,
  INVARIANT_STRENGTHS,
} from '../plugins/chaos.js';
import type { HarRoute } from '../har.js';

/* The strength field the parallel round added to ChaosInvariantResult. */
const STRENGTH = INVARIANT_STRENGTHS[0]!;

/** A page that NEVER issues the request the pattern claims. */
function pageThatNeverRequests(opts?: {
  capabilities?: ChaosCapability[];
  reading?: Partial<ChaosProbeReading>;
}): ChaosPageSurface {
  return {
    capabilities: () =>
      Promise.resolve(opts?.capabilities ?? (['ROUTE_INTERCEPTION'] as ChaosCapability[])),
    goto: () => Promise.resolve(),
    // Installs the handler and then nothing ever calls it. This is the fixture.
    route: (_glob: string, _handler: (r: HarRoute) => Promise<void>) => Promise.resolve(),
    read: () =>
      Promise.resolve({
        ...emptyReading(),
        route: '/orders',
        visibleText: 'Orders',
        busyIndicatorVisible: false,
        consoleErrors: [],
        retryControlPresent: true,
        ...opts?.reading,
      }),
    fill: () => Promise.resolve(),
    clickRetry: () => Promise.resolve(true),
    applyOutOfBand: () => Promise.resolve(true),
  };
}

const SPEC = chaosScenarioSpecSchema.parse({
  path: '/orders',
  target: { pathGlob: '**/api/does-not-exist/**', methods: ['GET'] },
  fault: 'UPSTREAM_500',
  assertInvariants: ['STAYS_ON_ROUTE', 'SOME_ERROR_SHOWN'],
  evidence: { ownErrorText: 'Something went wrong' },
  ownOrigins: ['https://app.example.com'],
  seed: 'adversary-seed-1',
});

describe('ADVERSARY — chaos cannot pass what it did not inject', () => {
  it('reports NOT_INJECTED when the pattern never matches, and asserts nothing', async () => {
    const out = await runChaosScenario(SPEC, pageThatNeverRequests());
    expect(out.outcome).toBe('NOT_INJECTED');
    expect(out.claimed).toBe(0);
    // The invariants must NOT be evaluated into a list of trivial HELDs.
    expect(out.results).toEqual([]);
    expect(out.notAsserted.map((h) => h.reason)).toEqual(['SURFACE_UNREACHED', 'SURFACE_UNREACHED']);
    expect(out.notes[0]).toMatch(/No request matched GET \*\*\/api\/does-not-exist\/\*\*/);
  });

  it('turns that NOT_INJECTED into SKIPPED + typed NOT_RUN, never PASSED', async () => {
    const out = await runChaosScenario(SPEC, pageThatNeverRequests());
    const verdict = chaosStatus({ outcome: out.outcome, results: out.results });
    expect(verdict.status).toBe('SKIPPED');
    expect(verdict.notRun).toEqual({ kind: 'NOT_RUN', why: expect.any(String) });
  });

  it('cannot PASS from ANY outcome other than INJECTED, for every outcome in the union', () => {
    // Brute force: a HELD invariant under every non-INJECTED outcome.
    const held = [
      { invariant: 'STAYS_ON_ROUTE' as const, verdict: 'HELD' as const, strength: STRENGTH, detail: 'x', undetermined: null },
    ];
    for (const outcome of CHAOS_INJECTION_OUTCOME_LIST) {
      const verdict = chaosStatus({ outcome, results: held });
      if (outcome === 'INJECTED') {
        expect(verdict.status).toBe('PASSED');
      } else {
        expect(verdict.status, `${outcome} must not pass`).toBe('SKIPPED');
        expect(verdict.notRun, `${outcome} must carry a typed not-run`).not.toBeNull();
      }
    }
    expect(OUTCOMES_THAT_MAY_PASS).toEqual(['INJECTED']);
  });

  it('an INJECTED fault whose invariants are all UNDETERMINED is SKIPPED, not PASSED', () => {
    const verdict = chaosStatus({
      outcome: 'INJECTED',
      results: [
        {
          invariant: 'NO_INPUT_LOSS',
          verdict: 'UNDETERMINED',
          strength: STRENGTH,
          detail: 'nobody captured the fields',
          undetermined: 'EVIDENCE_NOT_CAPTURED',
        },
      ],
    });
    expect(verdict.status).toBe('SKIPPED');
    expect(verdict.notRun?.kind).toBe('NOT_RUN');
  });

  it('a VIOLATED invariant under a REFUSED outcome still FAILS and is not discarded', () => {
    const verdict = chaosStatus({
      outcome: 'REFUSED',
      results: [
        { invariant: 'NO_RAW_STACK_TRACE', verdict: 'VIOLATED', strength: STRENGTH, detail: 'stack on screen', undetermined: null },
      ],
    });
    expect(verdict.status).toBe('FAILED');
  });
});

describe('ADVERSARY — an undecidable invariant is UNDETERMINED, never a guess', () => {
  it('reports UNDETERMINED with a reason when the evidence was not captured', async () => {
    // Injected fault, but the probe could read NOTHING off the screen.
    const blind: ChaosPageSurface = {
      capabilities: () => Promise.resolve(['ROUTE_INTERCEPTION'] as ChaosCapability[]),
      goto: () => Promise.resolve(),
      route: async (_glob, handler) => {
        // Drive one matching request through the real handler so claimed > 0.
        await handler({
          request: () => ({
            url: () => 'https://app.example.com/api/orders',
            method: () => 'GET',
            headers: () => ({}),
            postData: () => null,
          }),
          fulfill: () => Promise.resolve(),
          abort: () => Promise.resolve(),
          continue: () => Promise.resolve(),
          fetch: () =>
            Promise.resolve({ status: () => 200, headers: () => ({}), text: () => Promise.resolve('{}') }),
        } as unknown as HarRoute);
      },
      read: () => Promise.resolve(emptyReading()),
      fill: () => Promise.resolve(),
      clickRetry: () => Promise.resolve(false),
      applyOutOfBand: () => Promise.resolve(true),
    };
    const spec = chaosScenarioSpecSchema.parse({
      path: '/orders',
      target: { pathGlob: '**/api/orders', methods: ['GET'] },
      fault: 'UPSTREAM_500',
      assertInvariants: ['STAYS_ON_ROUTE'],
      ownOrigins: ['https://app.example.com'],
      seed: 'adversary-seed-2',
    });
    const out = await runChaosScenario(spec, blind);
    expect(out.outcome).toBe('INJECTED');
    expect(out.claimed).toBeGreaterThan(0);
    const verdicts = out.results.map((r) => r.verdict);
    expect(verdicts).not.toContain('HELD');
    for (const r of out.results.filter((r) => r.verdict === 'UNDETERMINED')) {
      expect(r.undetermined, `${r.invariant} must name WHY`).not.toBeNull();
      expect(r.detail.length).toBeGreaterThan(10);
    }
    const verdict = chaosStatus({ outcome: out.outcome, results: out.results });
    expect(verdict.status).toBe('SKIPPED');
  });

  it('evaluateInvariant never returns HELD from all-null evidence', () => {
    const blind = emptyReading();
    for (const invariant of [
      'STAYS_ON_ROUTE',
      'SOME_ERROR_SHOWN',
      'NO_INPUT_LOSS',
      'NO_RAW_STACK_TRACE',
      'NO_FALSE_SUCCESS',
      'NO_PARTIAL_RENDER',
      'NO_INFINITE_LOADING',
      'NO_UNHANDLED_RUNTIME_ERROR',
    ] as const) {
      const r = evaluateInvariant(invariant, {
        fault: 'UPSTREAM_500',
        evidence: {
          // Evidence PRESENT and non-null, so the refusal can only come from the
          // all-null probe reading — not from a missing crawl record.
          typedFieldNames: ['email'],
          ownErrorText: 'Something went wrong',
          ownSuccessText: 'Saved',
          loadingStateSeen: true,
          populatedStateSeen: true,
          consoleChannelWorked: true,
          writeRequestsObservable: true,
          retryControl: { identity: 'text=Retry', label: 'Retry' },
        },
        before: blind,
        after: blind,
        afterRetry: null,
        writes: [],
      });
      expect(r.verdict, `${invariant} from nothing`).not.toBe('HELD');
    }
  });
});
