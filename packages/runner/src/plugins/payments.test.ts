/**
 * The payments plugin, and the two lies it must never tell.
 *
 * THE FIRST is a pass nobody earned. "We clicked checkout and nothing threw"
 * looks exactly like a working money path: no exception, no red, a success page
 * that renders. A plugin written the obvious way would report a healthy
 * payments integration on an application that double-charges, on an image with
 * no adapter, for ever. So the heaviest block in this file is
 * SUBMITTED_NOT_CONFIRMED CAN NEVER BE PASSED, and it is written to survive a
 * future change of mind about WHICH non-pass it is: one test pins the invariant
 * (`!== 'PASSED'`, at the mapping, across the whole union and through the
 * execution path) and a separate one pins today's choice (FAILED). Weakening
 * the second cannot weaken the first.
 *
 * THE SECOND is a live-mode charge. The plugin must be STRUCTURALLY incapable
 * of one, not guarded against one, so this file asserts the structure rather
 * than the behaviour: the only credential interface in the plugin has two
 * fields and neither is a secret, the published-value description has no value
 * field at all, and `testMode` is re-asserted at run time off an untyped view
 * so that a CAST cannot get past it. Every credential-shaped probe string is
 * COMPOSED at run time from the exported `SECRET_SHAPES` vocabulary plus an
 * obviously-fake tail — a complete key-shaped literal in a committed test file
 * is what GitHub push protection blocks, and a scanner cannot tell an invented
 * live key from a real one.
 *
 * The counter-tests matter as much. A charge that really did succeed where a
 * decline was expected, a capture for the wrong total, a second charge from one
 * double-click and a webhook that arrived and was ignored must all still FAIL —
 * or the honest non-pass outcomes become a way to make every payment bug
 * disappear into a skip.
 *
 * Nothing here touches a browser, a provider, a socket or a card number.
 */

import { describe, expect, it } from 'vitest';
import {
  OUTCOME_FORCING_SCENARIOS,
  PAYMENT_SCENARIO_KINDS,
  SECRET_SHAPES,
  TEST_VALUES,
  paymentScenarioKindSchema,
  paymentsTestSpecSchema,
} from '@qaai/shared';
import type {
  ExecutableTest,
  PaymentScenarioKind,
  RunContext,
  TestExecution,
} from '@qaai/shared';
import {
  ACCEPTABLE_MONEY_STATES,
  DEFAULT_MONEY_OBSERVATION_MS,
  MAX_ADAPTER_DETAIL,
  adapterDetail,
  FORCED_OUTCOME_FOR_SCENARIO,
  MERCHANT_ACTIONS,
  MERCHANT_ACTION_LIST,
  MONEY_PATH_OUTCOMES,
  MONEY_PATH_OUTCOME_LABELS,
  MONEY_PATH_OUTCOME_LIST,
  MONEY_PATH_PASSING_OUTCOME,
  MONEY_STATES,
  MONEY_STATE_LIST,
  PAYMENT_REFUSAL_AS_UNASSERTED,
  PAYMENT_REFUSAL_REASONS,
  PAYMENT_REFUSAL_REASON_LIST,
  PAYMENT_REFUSAL_REMEDIES,
  PAYMENT_UNAVAILABLE_AS_UNASSERTED,
  PAYMENT_UNAVAILABLE_REASONS,
  PAYMENT_UNAVAILABLE_REASON_LIST,
  PAYMENT_UNAVAILABLE_REMEDIES,
  chargesAllowedFor,
  compareMoney,
  describePublishedValue,
  expectedChargeMinor,
  moneyObservationBoundMs,
  moneyPathStatus,
  paymentsPlugin,
  providerCanForce,
  realPaymentsClock,
  refuseCredentialShapedId,
  refuseLiveMode,
  resolveGateway,
  runPaymentScenario,
  runPaymentsTest,
  setPaymentsDeps,
  submittedNotConfirmedWhy,
  unavailableCheckoutSurface,
  unavailableGatewayModes,
  unavailableMoneyStateSource,
  unavailableWebhookObserver,
  validatePublishedValue,
} from './payments.js';
import type {
  ChallengeResult,
  CheckoutSubmission,
  CheckoutSurface,
  GatewayMode,
  GatewayModeSource,
  MerchantAction,
  MerchantActionResult,
  MoneyStateSource,
  ObservedMoney,
  ObservedTransition,
  PaymentScenarioSpec,
  PaymentUnavailableReason,
  PaymentsClock,
  PaymentsDeps,
  PaymentsTestSpec,
  WebhookObserver,
} from './payments.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

/**
 * A clock that advances by a fixed step on every read, so the elapsed
 * observation window in a disclosure sentence is a known number and nothing
 * sleeps.
 */
function fakeClock(stepMs = 1_200): PaymentsClock {
  let now = 1_000_000;
  return {
    now: () => {
      const value = now;
      now += stepMs;
      return value;
    },
  };
}

interface CheckoutOptions {
  arrival?: PaymentUnavailableReason | null;
  submission?: Partial<CheckoutSubmission>;
  challenge?: ChallengeResult | null;
  merchant?: MerchantActionResult | null;
}

type RecordingCheckout = CheckoutSurface & {
  readonly arrivals: string[];
  readonly submissions: number[];
  readonly actions: Array<{ action: MerchantAction; amountMinor: number | null }>;
  readonly challenges: Array<'COMPLETE' | 'ABANDON'>;
};

function fakeCheckout(options: CheckoutOptions = {}): RecordingCheckout {
  const arrivals: string[] = [];
  const submissions: number[] = [];
  const actions: Array<{ action: MerchantAction; amountMinor: number | null }> = [];
  const challenges: Array<'COMPLETE' | 'ABANDON'> = [];
  return {
    arrivals,
    submissions,
    actions,
    challenges,
    arrive: async (path) => {
      arrivals.push(path);
      return options.arrival
        ? { ok: false as const, reason: options.arrival, detail: 'The fake refused.' }
        : { ok: true as const, detail: 'The checkout came up.' };
    },
    submit: async (request) => {
      submissions.push(request.submissions);
      return {
        submitted: true,
        reference: 'order_931',
        rejectedClientSide: false,
        challengePresented: false,
        detail: `Submitted ${request.submissions} time(s).`,
        ...options.submission,
      };
    },
    resolveChallenge: async (action) => {
      challenges.push(action);
      return options.challenge === undefined
        ? { completed: action === 'COMPLETE', detail: 'The fake resolved it.' }
        : options.challenge;
    },
    merchantAction: async (action, amountMinor) => {
      actions.push({ action, amountMinor });
      return options.merchant === undefined
        ? { performed: true, detail: 'The fake performed it.' }
        : options.merchant;
    },
  };
}

function fakeGateways(mode: GatewayMode): GatewayModeSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    describe: async (publisher) => {
      asked.push(publisher);
      return mode;
    },
  };
}

function fakeMoney(
  observed: ObservedMoney | null | 'throws',
  available: PaymentUnavailableReason | null = null,
): MoneyStateSource & { reads: number } {
  const state = { reads: 0 };
  return {
    get reads() {
      return state.reads;
    },
    available: async () => (available ? { ok: false as const, reason: available } : { ok: true as const }),
    observe: async () => {
      state.reads += 1;
      if (observed === 'throws') throw new Error('the money adapter fell over');
      return observed;
    },
  };
}

function fakeWebhooks(
  transition: ObservedTransition | null,
  available: PaymentUnavailableReason | null = null,
): WebhookObserver & { waits: string[] } {
  const waits: string[] = [];
  return {
    waits,
    available: async () => (available ? { ok: false as const, reason: available } : { ok: true as const }),
    waitFor: async (event) => {
      waits.push(event);
      return transition;
    },
  };
}

const money = (overrides: Partial<ObservedMoney> = {}): ObservedMoney => ({
  state: 'CAPTURED',
  chargedMinor: 4_200,
  currency: 'GBP',
  chargeCount: 1,
  ...overrides,
});

function deps(overrides: Partial<PaymentsDeps> = {}): PaymentsDeps {
  return {
    checkout: overrides.checkout ?? fakeCheckout(),
    gateways: overrides.gateways ?? fakeGateways({ present: true, mode: 'TEST' }),
    money: overrides.money ?? fakeMoney(money()),
    webhooks: overrides.webhooks ?? fakeWebhooks(null),
    clock: overrides.clock ?? fakeClock(),
  };
}

/** The honest baseline: a captured Visa at £42. */
const BASE_SCENARIO = {
  kind: 'AUTHORISE_AND_CAPTURE' as const,
  testMode: true as const,
  publisher: 'stripe',
  catalogueId: 'stripe.card.success.visa',
  path: '/checkout',
  amountMinor: 4_200,
  currency: 'GBP',
};

function makeSpec(scenarios: ReadonlyArray<Record<string, unknown>> = [BASE_SCENARIO]): PaymentsTestSpec {
  return paymentsTestSpecSchema.parse({ scenarios });
}

function firstScenario(spec: PaymentsTestSpec): PaymentScenarioSpec {
  const scenario = spec.scenarios[0];
  if (scenario === undefined) throw new Error('the fixture has no scenario');
  return scenario;
}

/** One parsed scenario, built from the baseline plus overrides. */
function scenarioOf(overrides: Record<string, unknown> = {}): PaymentScenarioSpec {
  return firstScenario(makeSpec([{ ...BASE_SCENARIO, ...overrides }]));
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

function makeTest(spec: unknown, name = 'the checkout takes the right money'): ExecutableTest {
  return {
    id: 'test_1',
    name,
    // PAYMENTS is not in TEST_TYPES yet — see the registry's PENDING_PLUGINS.
    type: 'E2E',
    code: '',
    filePath: 'payments/checkout.json',
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

/*
 * Rule 4: a credential-shaped probe is COMPOSED at run time from the EXPORTED
 * vocabulary plus an obviously-fake tail, never written as a literal. Derived
 * from `SECRET_SHAPES` rather than from a hand-written parallel list, because a
 * hand-written list is how the catalogue's own shape probe came to cover
 * sixteen of twenty-seven declared shapes.
 */
const FAKE_TAIL = ['zz', 'not', 'a', 'real', 'key', '0000'].join('');
const CREDENTIAL_SHAPED = SECRET_SHAPES.map((shape) => `${shape.prefix}${FAKE_TAIL}`);

/** A sixteen-digit run, composed rather than written. Never a real PAN. */
const PAN_SHAPED = ['4', '1', '1', '1'].join('').repeat(4);

// ─── THE INVARIANT ───────────────────────────────────────────────────────────

describe('SUBMITTED_NOT_CONFIRMED can never be reported as PASSED', () => {
  it('maps away from PASSED, whatever else changes about it', () => {
    /*
     * THE test this file exists for. Deliberately `not PASSED` rather than
     * `=== 'FAILED'`: a future round may decide the right non-pass is SKIPPED,
     * and that decision must not be able to take this guard with it.
     */
    expect(moneyPathStatus('SUBMITTED_NOT_CONFIRMED')).not.toBe('PASSED');
  });

  it('is FAILED today, which is a separate claim from the invariant above', () => {
    expect(moneyPathStatus('SUBMITTED_NOT_CONFIRMED')).toBe('FAILED');
  });

  it('leaves ASSERTED as the ONLY outcome that passes', () => {
    const passing = MONEY_PATH_OUTCOMES.filter((outcome) => moneyPathStatus(outcome) === 'PASSED');
    expect(passing).toEqual([MONEY_PATH_PASSING_OUTCOME]);
    expect(MONEY_PATH_PASSING_OUTCOME).toBe('ASSERTED');
  });

  it('keeps "we read it and it is wrong" apart from "we could not confirm"', () => {
    /*
     * Both are FAILED and they are NOT the same fact. WRONG_MONEY_STATE is a
     * defect this run PROVED — we read the application's own money state —
     * while SUBMITTED_NOT_CONFIRMED is bounded by what one observer could see.
     * Folding the first into the second would attach the "money may have moved
     * and nobody knows" caveat to a result that has no need of it, which
     * understates a defect the customer can act on today.
     */
    expect(moneyPathStatus('WRONG_MONEY_STATE')).toBe('FAILED');
    expect(moneyPathStatus('SUBMITTED_NOT_CONFIRMED')).toBe('FAILED');
    expect(MONEY_PATH_OUTCOME_LABELS.WRONG_MONEY_STATE).not.toBe(
      MONEY_PATH_OUTCOME_LABELS.SUBMITTED_NOT_CONFIRMED,
    );
  });

  it('says in writing that nothing seen does not mean no money moved', () => {
    const why = submittedNotConfirmedWhy(scenarioOf(), 15_000, 1_200, null);
    expect(why).toContain('NOT a pass');
    expect(why).toContain('does NOT establish that no money moved');
    expect(why).toContain('provider dashboard');
  });

  it('reports a money state that could not be read as SUBMITTED_NOT_CONFIRMED', async () => {
    const result = await runPaymentScenario(
      scenarioOf(),
      'https://shop.example.com',
      deps({ money: fakeMoney(null) }),
    );
    expect(result.outcome).toBe('SUBMITTED_NOT_CONFIRMED');
    expect(moneyPathStatus(result.outcome)).toBe('FAILED');
  });

  it('never passes a whole test in which any scenario was not confirmed', async () => {
    /*
     * The mapping being right is not enough: `runPaymentsTest` aggregates, and
     * an aggregate that let one ASSERTED outvote one SUBMITTED_NOT_CONFIRMED
     * would reinstate the false green one level up. Two scenarios, one of each
     * — the money source answers once and then stops answering, which is what
     * a flaky read actually looks like.
     */
    const spec = makeSpec([
      { ...BASE_SCENARIO, path: '/checkout/a' },
      { ...BASE_SCENARIO, path: '/checkout/b' },
    ]);
    const answers: Array<ObservedMoney | null> = [money(), null];
    const source: MoneyStateSource = {
      available: async () => ({ ok: true as const }),
      observe: async () => answers.shift() ?? null,
    };
    const execution = await runPaymentsTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({ money: source }),
    );
    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toContain('SUBMITTED_NOT_CONFIRMED');
  });

  it('never passes a test in which nothing at all was asserted', async () => {
    const spec = makeSpec();
    const execution = await runPaymentsTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({ gateways: fakeGateways({ present: false, mode: 'UNKNOWN' }) }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('NOT_RUN');
    expect(execution.notRun?.why).toContain('nothing is claimed');
    expect(execution.notRun?.why).toContain('NOT measured');
  });

  it('does not pass a test whose only scenarios QAAI refused', async () => {
    /*
     * The subtlest version of the false green: every scenario REFUSED is a
     * money path nobody tested, and a REFUSED that mapped to PASSED would mean
     * pointing QAAI at a live gateway made the percentage go up.
     */
    const spec = makeSpec();
    const execution = await runPaymentsTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({ gateways: fakeGateways({ present: true, mode: 'LIVE' }) }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.why).toContain('REFUSED');
    expect(execution.errorMessage).toContain('LIVE_MODE_GATEWAY');
  });
});

// ─── The structural live-mode refusal (rule 5) ───────────────────────────────

describe('the plugin is structurally incapable of a live-mode charge', () => {
  it('cannot obtain a credential value through the only interface it has', async () => {
    /*
     * The type-level half of rule 5, asserted at run time because a comment is
     * not a guard. `GatewayMode` has two fields and neither is a secret, so
     * there is no expression in payments.ts that can reach a provider key — to
     * log it, to hash it, or to put it in an error path.
     */
    const mode = await unavailableGatewayModes.describe('stripe');
    expect(Object.keys(mode).sort()).toEqual(['mode', 'present']);
    for (const key of [
      'value',
      'key',
      'apiKey',
      'secretKey',
      'publishableKey',
      'token',
      'secret',
      'pem',
    ]) {
      expect(mode, key).not.toHaveProperty(key);
    }
  });

  it('cannot obtain a card number through the only description it has', () => {
    /*
     * The fourth structural guarantee. A published card number is not a secret,
     * and a PAN in a step title is still a PAN in a log, a report and a Slack
     * channel — so the plugin describes a value and the ADAPTER resolves it.
     */
    const described = describePublishedValue('stripe.card.success.visa');
    expect(described).not.toBeNull();
    expect(Object.keys(described!).sort()).toEqual([
      'forcesOutcome',
      'id',
      'publisher',
      'sourceNote',
      'testModeOnly',
      'testValueProvider',
      'verified',
    ]);
    for (const key of ['value', 'card', 'pan', 'number', 'cvc']) {
      expect(described!, key).not.toHaveProperty(key);
    }
    // And the real card's digits are nowhere in what it hands back.
    const entry = TEST_VALUES.find((v) => v.id === 'stripe.card.success.visa');
    expect(entry?.value).toBeTruthy();
    expect(JSON.stringify(described)).not.toContain(entry!.value!);
  });

  it('refuses a LIVE gateway and submits nothing', async () => {
    const checkout = fakeCheckout();
    const result = await runPaymentScenario(scenarioOf(), 'https://shop.example.com', {
      ...deps({ checkout }),
      gateways: fakeGateways({ present: true, mode: 'LIVE' }),
    });
    expect(result.outcome).toBe('REFUSED');
    expect(result.refusalReason).toBe('LIVE_MODE_GATEWAY');
    // Nothing was opened and nothing was submitted. The refusal is before the
    // drive, not after it.
    expect(checkout.arrivals).toEqual([]);
    expect(checkout.submissions).toEqual([]);
  });

  it('refuses an UNKNOWN mode exactly as hard as LIVE', async () => {
    /*
     * The mutation that matters most in this file. `mode !== 'TEST'` becoming
     * `mode === 'LIVE'` reads as a tightening and is the one change that lets
     * an environment nobody looked at take a real payment. Absent is NOT
     * "probably test".
     */
    const verdict = await resolveGateway(
      scenarioOf(),
      fakeGateways({ present: true, mode: 'UNKNOWN' }),
    );
    expect(verdict.ok).toBe(false);
    expect('refusal' in verdict && verdict.refusal.reason).toBe('GATEWAY_MODE_UNESTABLISHED');
  });

  it('tells an absent integration apart from a refused one', async () => {
    // Different owners and different remedies: one is "connect a sandbox" and
    // the other is "stop pointing this at live". Collapsing them would send a
    // customer to connect an account they already have.
    const verdict = await resolveGateway(
      scenarioOf(),
      fakeGateways({ present: false, mode: 'UNKNOWN' }),
    );
    expect(verdict.ok).toBe(false);
    expect('unavailable' in verdict && verdict.unavailable.reason).toBe('NO_GATEWAY_INTEGRATION');
  });

  it('defeats a CAST, because the refusal is a run-time read and not a type', async () => {
    /*
     * `paymentScenarioSchema.testMode` is `z.literal(true)`, so the field's
     * TYPE makes a direct comparison dead code — and `runPaymentScenario` is
     * exported and callable with exactly this cast, which is the path the
     * adversary suite in packages/shared takes. A guard the compiler optimises
     * away on the strength of a type the caller may have lied about is not a
     * guard.
     */
    const cast = { ...scenarioOf(), testMode: false } as unknown as PaymentScenarioSpec;
    expect(refuseLiveMode(cast)?.reason).toBe('TEST_MODE_NOT_DECLARED');

    const checkout = fakeCheckout();
    const gateways = fakeGateways({ present: true, mode: 'TEST' });
    const result = await runPaymentScenario(cast, 'https://shop.example.com', {
      ...deps({ checkout }),
      gateways,
    });
    expect(result.outcome).toBe('REFUSED');
    expect(result.refusalReason).toBe('TEST_MODE_NOT_DECLARED');
    // Refused before the gateway was even asked, let alone before a submission.
    expect(gateways.asked).toEqual([]);
    expect(checkout.submissions).toEqual([]);
  });

  it('lets the honest baseline through, so the refusals above are not vacuous', async () => {
    const result = await runPaymentScenario(scenarioOf(), 'https://shop.example.com', deps());
    expect(result.outcome).toBe('ASSERTED');
  });

  it('files every refusal as WOULD_MUTATE_PROTECTED_DATA, never as a missing install', () => {
    /*
     * Rule 12: a REFUSED surface must not be recorded the same way as one that
     * does not exist. A refusal filed as CAPABILITY_ABSENT would send a reader
     * to install an adapter that is already here.
     */
    for (const reason of PAYMENT_REFUSAL_REASONS) {
      expect(PAYMENT_REFUSAL_AS_UNASSERTED[reason], reason).toBe('WOULD_MUTATE_PROTECTED_DATA');
    }
  });

  it('records a refusal AS a refusal in the result, not as an unavailability', async () => {
    const spec = makeSpec();
    const execution = await runPaymentsTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({ gateways: fakeGateways({ present: true, mode: 'UNKNOWN' }) }),
    );
    // The two counts are reported separately, so "QAAI declined" is readable
    // without parsing ten remedy sentences.
    expect(execution.errorMessage).toContain('were REFUSED by QAAI');
    expect(execution.errorMessage).not.toContain('were NOT measured');
    expect(execution.console.some((entry) => entry.text.startsWith('REFUSED ('))).toBe(true);
  });

  it('never puts a credential-shaped string into a result, because it never holds one', async () => {
    /*
     * Swept over the WHOLE exported vocabulary rather than a hand-written
     * subset, and composed at run time (lesson E). Each one goes in as a
     * `catalogueId`, which is the only string field on a scenario a careless
     * author could paste a key into.
     */
    expect(CREDENTIAL_SHAPED.length).toBeGreaterThanOrEqual(16);
    for (const shaped of CREDENTIAL_SHAPED) {
      const scenario = scenarioOf({ catalogueId: shaped });
      const result = await runPaymentScenario(scenario, 'https://shop.example.com', deps());
      expect(result.outcome, shaped.slice(0, 6)).toBe('REFUSED');
      expect(result.refusalReason, shaped.slice(0, 6)).toBe(
        'SPEC_NAMES_A_CREDENTIAL_SHAPED_VALUE',
      );
      // THE ID IS NEVER ECHOED. Not truncated, not hashed, not in the remedy.
      expect(JSON.stringify(result), shaped.slice(0, 6)).not.toContain(FAKE_TAIL);
    }
  });

  it('refuses a raw card number as a catalogueId and never echoes it', async () => {
    /*
     * The adversary suite's second FINDING against the schema: a 16-digit PAN
     * is a plain string and `z.string()` has no opinion about it. This is the
     * producer-side gate that comment promised.
     */
    const result = await runPaymentScenario(
      scenarioOf({ catalogueId: PAN_SHAPED }),
      'https://shop.example.com',
      deps(),
    );
    expect(result.outcome).toBe('REFUSED');
    expect(result.refusalReason).toBe('SPEC_NAMES_A_RAW_CARD_NUMBER');
    expect(JSON.stringify(result)).not.toContain(PAN_SHAPED);
  });

  it('refuses a card-shaped id whether or not its checksum holds', () => {
    /*
     * The subtle half. Refusing only Luhn-VALID runs would mean the product
     * echoed every mistyped card number into a report, and a mistyped card is
     * still somebody's card.
     */
    const broken = `${PAN_SHAPED.slice(0, 15)}${(Number(PAN_SHAPED.slice(15)) + 1) % 10}`;
    for (const candidate of [PAN_SHAPED, broken, PAN_SHAPED.replace(/(\d{4})/g, '$1 ').trim()]) {
      const refusal = refuseCredentialShapedId(candidate);
      expect(refusal?.reason, candidate.length.toString()).toBe('SPEC_NAMES_A_RAW_CARD_NUMBER');
      expect(refusal?.detail).not.toContain(candidate);
    }
    // And a real catalogue id is not mistaken for one.
    expect(refuseCredentialShapedId('stripe.card.success.visa')).toBeNull();
  });

  it('refuses a credential-shaped spec at validate(), before anything is driven', () => {
    for (const shaped of CREDENTIAL_SHAPED.slice(0, 4)) {
      const test = makeTest(makeSpec([{ ...BASE_SCENARIO, catalogueId: shaped }]));
      expect(() => paymentsPlugin.validate(test), shaped.slice(0, 6)).toThrow(
        /cannot be attempted/,
      );
      try {
        paymentsPlugin.validate(test);
      } catch (err) {
        expect(String(err)).not.toContain(FAKE_TAIL);
      }
    }
  });
});

// ─── The catalogue gate ──────────────────────────────────────────────────────

describe('the catalogue gate the schema promised and nothing implemented', () => {
  it('refuses a decline scenario driving a card that declines for another reason', () => {
    /*
     * THE defect this gate exists for, and the catalogue's own header names it:
     * "a wrong test card number is a silent payment-test failure". The charge
     * is refused for the wrong reason, the assertion still sees a refusal, and
     * the test passes having proved nothing.
     */
    const verdict = validatePublishedValue(
      scenarioOf({
        kind: 'DECLINE_INSUFFICIENT_FUNDS',
        catalogueId: 'stripe.card.declined.generic',
      }),
    );
    expect(verdict.ok).toBe(false);
    expect('unavailable' in verdict && verdict.unavailable.reason).toBe(
      'VALUE_FORCES_A_DIFFERENT_OUTCOME',
    );
  });

  it('accepts the card that does force the asserted outcome', () => {
    const verdict = validatePublishedValue(
      scenarioOf({
        kind: 'DECLINE_INSUFFICIENT_FUNDS',
        catalogueId: 'stripe.card.declined.insufficient-funds',
      }),
    );
    expect(verdict.ok).toBe(true);
  });

  it('tells "you named the wrong card" apart from "no card can do this"', () => {
    /*
     * Two remedies, and one of them cannot work. Adyen's catalogued cards are a
     * success Visa and a CVC; no published Adyen value forces an
     * incorrect-CVC decline, so telling the author to name a different id would
     * be a loop they cannot get out of.
     */
    expect(providerCanForce('stripe', 'declined-incorrect-cvc')).toBe(true);
    expect(providerCanForce('adyen', 'declined-incorrect-cvc')).toBe(false);

    const adyen = validatePublishedValue(
      scenarioOf({
        kind: 'DECLINE_INCORRECT_CVC',
        publisher: 'adyen',
        catalogueId: 'adyen.card.success.visa',
      }),
    );
    expect('unavailable' in adyen && adyen.unavailable.reason).toBe('TEST_MODE_CANNOT_PRODUCE_IT');
    expect(PAYMENT_UNAVAILABLE_AS_UNASSERTED.TEST_MODE_CANNOT_PRODUCE_IT).toBe(
      'PROVIDER_TEST_MODE_LIMIT',
    );

    const stripe = validatePublishedValue(
      scenarioOf({
        kind: 'DECLINE_INCORRECT_CVC',
        catalogueId: 'stripe.card.declined.generic',
      }),
    );
    expect('unavailable' in stripe && stripe.unavailable.reason).toBe(
      'VALUE_FORCES_A_DIFFERENT_OUTCOME',
    );
  });

  it('reports an invented id as unavailable rather than failing the test', async () => {
    /*
     * The adversary suite's first FINDING, closed — and closed as UNAVAILABLE
     * rather than as a throw ON PURPOSE. The catalogue is OUR data and it grows
     * (the provider catalogue keeps its own `CATALOGUE_OMISSIONS` list), so a
     * spec naming an entry this build does not carry is as much a gap in our
     * data as an error in their test, and failing the whole test for it would
     * make our gap read as their defect.
     */
    const invented = 'card_that_does_not_exist_anywhere';
    expect(describePublishedValue(invented)).toBeNull();

    const result = await runPaymentScenario(
      scenarioOf({ catalogueId: invented }),
      'https://shop.example.com',
      deps(),
    );
    expect(result.outcome).toBe('UNAVAILABLE');
    expect(result.unavailableReason).toBe('NO_PUBLISHED_TEST_VALUE');
    expect(() =>
      paymentsPlugin.validate(makeTest(makeSpec([{ ...BASE_SCENARIO, catalogueId: invented }]))),
    ).not.toThrow();
  });

  it('raises an outcome mismatch at validate(), because no environment fixes it', () => {
    expect(() =>
      paymentsPlugin.validate(
        makeTest(
          makeSpec([
            {
              ...BASE_SCENARIO,
              kind: 'DECLINE_EXPIRED_CARD',
              catalogueId: 'stripe.card.declined.generic',
            },
          ]),
        ),
      ),
    ).toThrow(/needs a value that forces declined-expired-card/);
  });

  it('accepts a spec whose every scenario names the right card', () => {
    const spec = makeSpec(
      OUTCOME_FORCING_SCENARIOS.map((kind) => ({
        ...BASE_SCENARIO,
        kind,
        catalogueId: idThatForces(kind),
      })),
    );
    expect(() => paymentsPlugin.validate(makeTest(spec))).not.toThrow();
  });

  it('records an unverified entry as a stated hole, even on a scenario that passes', async () => {
    /*
     * The catalogue's own honesty, carried through rather than flattened. A
     * recalled card number is "very likely right and the first thing to check
     * when a payment test fails for a reason that makes no sense", and a green
     * row that did not say so would stand on a value nobody confirmed.
     */
    const scenario = scenarioOf({
      kind: 'DECLINE_GENERIC',
      catalogueId: 'stripe.card.declined.generic',
    });
    expect(TEST_VALUES.find((v) => v.id === 'stripe.card.declined.generic')?.verified).toBe(false);

    const result = await runPaymentScenario(scenario, 'https://shop.example.com', {
      ...deps(),
      money: fakeMoney(money({ state: 'DECLINED', chargedMinor: null, chargeCount: 0 })),
    });
    expect(result.outcome).toBe('ASSERTED');
    expect(result.notAsserted.map((hole) => hole.assertion).join(' ')).toContain('unverified');
  });

  it('records an un-checkable outcome as a hole rather than as agreement', () => {
    /*
     * `CatalogueEntry` has no `outcome` column, so for an IBAN or a VAT number
     * whether it forces what a scenario asserts is UNKNOWN — and an unknown
     * treated as agreement is exactly how the wrong value gets driven.
     */
    const iban = describePublishedValue('stripe.iban.sepa.success');
    expect(iban, 'the second catalogue is reachable from this plugin at all').not.toBeNull();
    expect(iban!.forcesOutcome).toBeNull();

    const verdict = validatePublishedValue(
      scenarioOf({ kind: 'DECLINE_GENERIC', catalogueId: 'stripe.iban.sepa.success' }),
    );
    expect(verdict.ok).toBe(true);
    expect(
      verdict.ok && verdict.holes.some((hole) => hole.assertion.includes('records no outcome')),
    ).toBe(true);
  });

  it('refuses a forcing scenario with no value even off-schema', () => {
    /*
     * `paymentScenarioSchema` already refuses this at parse time, and
     * `validatePublishedValue` is exported and callable with a hand-built
     * scenario. A run-time path that trusted the schema to have run is a path
     * that fails open.
     */
    for (const kind of OUTCOME_FORCING_SCENARIOS) {
      const handBuilt = { ...scenarioOf(), kind, catalogueId: null } as PaymentScenarioSpec;
      const verdict = validatePublishedValue(handBuilt);
      expect(verdict.ok, kind).toBe(false);
      expect('unavailable' in verdict && verdict.unavailable.reason, kind).toBe(
        'NO_PUBLISHED_TEST_VALUE',
      );
    }
  });
});

/** The catalogued id that forces a kind's outcome, for the fixtures above. */
function idThatForces(kind: PaymentScenarioKind): string {
  const wanted = FORCED_OUTCOME_FOR_SCENARIO[kind];
  const entry = TEST_VALUES.find(
    (candidate) => candidate.kind === 'card' && candidate.outcome === wanted,
  );
  if (entry === undefined) throw new Error(`no catalogued card forces ${String(wanted)}`);
  return entry.id;
}

// ─── The order of the refusals ───────────────────────────────────────────────

describe('nothing is charged that this run could not have verified', () => {
  it('submits no payment when the money state cannot be read back', async () => {
    /*
     * The step a reader is most likely to think is in the wrong place. A charge
     * nobody can verify is a write against the customer's sandbox with no
     * assertion attached, and the honest thing to do with one is not to make
     * it.
     */
    const checkout = fakeCheckout();
    const result = await runPaymentScenario(scenarioOf(), 'https://shop.example.com', {
      ...deps({ checkout }),
      money: fakeMoney(money(), 'NO_MONEY_STATE_SOURCE'),
    });
    expect(result.outcome).toBe('UNAVAILABLE');
    expect(result.unavailableReason).toBe('NO_MONEY_STATE_SOURCE');
    expect(checkout.submissions).toEqual([]);
    expect(checkout.arrivals).toEqual([]);
  });

  it('submits no payment for a webhook scenario with no observer attached', async () => {
    const checkout = fakeCheckout();
    const scenario = scenarioOf({
      kind: 'WEBHOOK_TRANSITION',
      webhookEvent: 'charge.succeeded',
      catalogueId: null,
    });
    const result = await runPaymentScenario(scenario, 'https://shop.example.com', {
      ...deps({ checkout }),
      webhooks: fakeWebhooks(null, 'NO_WEBHOOK_OBSERVER'),
    });
    expect(result.outcome).toBe('UNAVAILABLE');
    expect(result.unavailableReason).toBe('NO_WEBHOOK_OBSERVER');
    expect(checkout.submissions).toEqual([]);
  });

  it('stops at a bot defence with the remedy, and never tries to get past it', async () => {
    /*
     * Rule 6. With nothing configured the correct answer is
     * UNREACHABLE_BEHIND_BOT_PROTECTION plus the remedy, and the remedy belongs
     * entirely to the customer: their own environment, the provider's own
     * published test key. No workaround is offered because none exists.
     */
    const checkout = fakeCheckout({ arrival: 'BOT_PROTECTION_UNSOLVED' });
    const result = await runPaymentScenario(
      scenarioOf(),
      'https://shop.example.com',
      deps({ checkout }),
    );
    expect(result.outcome).toBe('UNAVAILABLE');
    expect(result.unavailableReason).toBe('BOT_PROTECTION_UNSOLVED');
    expect(PAYMENT_UNAVAILABLE_AS_UNASSERTED.BOT_PROTECTION_UNSOLVED).toBe(
      'UNREACHABLE_BEHIND_BOT_PROTECTION',
    );
    expect(result.detail).toContain('will not and cannot work around');
    expect(checkout.submissions).toEqual([]);
  });

  it('appends OUR remedy to the adapter’s reason rather than the adapter’s prose', async () => {
    // The adapter's `detail` is data. The remedy is a product decision, so an
    // adapter cannot talk a reader into working around a bot defence.
    const checkout = fakeCheckout({ arrival: 'CHECKOUT_UNREACHABLE' });
    const result = await runPaymentScenario(
      scenarioOf(),
      'https://shop.example.com',
      deps({ checkout }),
    );
    expect(result.detail).toContain('The fake refused.');
    expect(result.detail).toContain(PAYMENT_UNAVAILABLE_REMEDIES.CHECKOUT_UNREACHABLE);
  });

  it('bounds a sentence an adapter handed us, and says it was truncated', async () => {
    /*
     * Rule 8: adapter prose is data and every length is bounded. These strings
     * land in a step title, an `errorMessage` and a log line, and an adapter
     * that returned a megabyte of HTML would put it in all three. Truncated
     * AND SAID SO, because a sentence that stops mid-word with no marker reads
     * as the adapter's own wording and the next reader debugs the wrong thing.
     */
    const flood = 'x'.repeat(MAX_ADAPTER_DETAIL * 4);
    expect(adapterDetail('short')).toBe('short');
    expect(adapterDetail(flood).length).toBeLessThan(MAX_ADAPTER_DETAIL + 60);
    expect(adapterDetail(flood)).toContain('truncated from 1200 characters');

    const result = await runPaymentScenario(
      scenarioOf(),
      'https://shop.example.com',
      deps({ checkout: fakeCheckout({ submission: { submitted: false, detail: flood } }) }),
    );
    expect(result.detail).toContain('truncated from');
    expect(result.detail.length).toBeLessThan(flood.length);
  });

  it('keeps the value-verification holes on a submission that never happened', async () => {
    /*
     * The one path with no money read behind it, and the one most likely to
     * drop a hole: a `scenario.notAsserted` here instead of the accumulated set
     * is how a hole comes to exist on nine results and vanish on the tenth.
     */
    const result = await runPaymentScenario(
      scenarioOf({ kind: 'DECLINE_GENERIC', catalogueId: 'stripe.card.declined.generic' }),
      'https://shop.example.com',
      deps({ checkout: fakeCheckout({ submission: { submitted: false } }) }),
    );
    expect(result.outcome).toBe('UNAVAILABLE');
    expect(result.notAsserted.map((hole) => hole.assertion).join(' ')).toContain('unverified');
  });

  it('calls a failed submission UNAVAILABLE and not a failed payment path', async () => {
    /*
     * Nothing was submitted, so "submitted" would be a lie in the name — and
     * the status would be FAILED, blaming the customer's payment code for a
     * form this run could not drive.
     */
    const result = await runPaymentScenario(
      scenarioOf(),
      'https://shop.example.com',
      deps({ checkout: fakeCheckout({ submission: { submitted: false } }) }),
    );
    expect(result.outcome).toBe('UNAVAILABLE');
    expect(result.unavailableReason).toBe('CHECKOUT_UNREACHABLE');
    expect(moneyPathStatus(result.outcome)).toBe('SKIPPED');
  });

  it('turns a thrown surface into UNAVAILABLE rather than a failed money path', async () => {
    const spec = makeSpec();
    const execution = await runPaymentsTest(makeCtx(), makeTest(spec), spec, {
      ...deps(),
      gateways: {
        describe() {
          throw new Error('the integration lookup fell over');
        },
      },
    });
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('NO_CHECKOUT_SURFACE');
  });
});

// ─── The money assertions ────────────────────────────────────────────────────

describe('a payment that went wrong still fails', () => {
  it('fails a decline scenario whose charge actually succeeded', async () => {
    const result = await runPaymentScenario(
      scenarioOf({
        kind: 'DECLINE_GENERIC',
        catalogueId: 'stripe.card.declined.generic',
      }),
      'https://shop.example.com',
      deps({ money: fakeMoney(money({ state: 'CAPTURED' })) }),
    );
    expect(result.outcome).toBe('WRONG_MONEY_STATE');
    expect(result.detail).toContain('state expected');
  });

  it('fails a capture for the wrong total, which is THE invoice bug', async () => {
    const result = await runPaymentScenario(
      scenarioOf(),
      'https://shop.example.com',
      deps({ money: fakeMoney(money({ chargedMinor: 420 })) }),
    );
    expect(result.outcome).toBe('WRONG_MONEY_STATE');
    expect(result.detail).toContain('amount expected 4200 minor units, got 420 minor units');
  });

  it('fails a double charge from one double-click', async () => {
    const checkout = fakeCheckout();
    const result = await runPaymentScenario(
      scenarioOf({ kind: 'DUPLICATE_SUBMISSION' }),
      'https://shop.example.com',
      { ...deps({ checkout }), money: fakeMoney(money({ chargeCount: 2 })) },
    );
    // TWO submissions in ONE request: a user's double-click inside one page
    // lifetime, not two separate checkouts.
    expect(checkout.submissions).toEqual([2]);
    expect(result.outcome).toBe('WRONG_MONEY_STATE');
    expect(result.detail).toContain('chargeCount expected exactly 1, got 2');
  });

  it('checks the charge count on EVERY scenario, not only the one named for it', async () => {
    /*
     * A second charge from a single submission is the same defect from the
     * other side, and checking it only where it is named would let a retry path
     * double-charge on every other scenario in silence.
     */
    const result = await runPaymentScenario(
      scenarioOf(),
      'https://shop.example.com',
      deps({ money: fakeMoney(money({ chargeCount: 2 })) }),
    );
    expect(result.outcome).toBe('WRONG_MONEY_STATE');
    expect(result.detail).toContain('chargeCount');
  });

  it('fails an abandoned 3DS challenge that took the money anyway', async () => {
    /*
     * The single worst defect on the list, and the only way to catch it is to
     * assert the ABSENCE of a charge rather than the presence of an error
     * message.
     */
    const checkout = fakeCheckout({
      submission: { challengePresented: true },
      challenge: { completed: false, detail: 'Abandoned.' },
    });
    const result = await runPaymentScenario(
      scenarioOf({
        kind: 'THREE_DS_CHALLENGE_FAIL',
        catalogueId: 'stripe.card.3ds.required',
      }),
      'https://shop.example.com',
      { ...deps({ checkout }), money: fakeMoney(money({ state: 'CAPTURED' })) },
    );
    expect(checkout.challenges).toEqual(['ABANDON']);
    expect(result.outcome).toBe('WRONG_MONEY_STATE');
    expect(result.detail).toContain('ABANDONED');
  });

  it('accepts either honest spelling of "no money moved" after an abandonment', async () => {
    /*
     * The false-positive guard. An application that records "the challenge was
     * abandoned" and one that records nothing at all are BOTH correct, and a
     * single expected state would have failed one of them — QAAI reporting a
     * defect that is not there.
     */
    const scenario = scenarioOf({
      kind: 'THREE_DS_CHALLENGE_FAIL',
      catalogueId: 'stripe.card.3ds.required',
    });
    for (const state of ['NONE', 'CHALLENGE_ABANDONED'] as const) {
      const result = await runPaymentScenario(scenario, 'https://shop.example.com', {
        ...deps({
          checkout: fakeCheckout({
            submission: { challengePresented: true },
            challenge: { completed: false, detail: 'Abandoned.' },
          }),
        }),
        money: fakeMoney(money({ state, chargedMinor: null, chargeCount: 0 })),
      });
      expect(result.outcome, state).toBe('ASSERTED');
    }
  });

  it('reports a 3DS challenge that was never presented as a finding', async () => {
    /*
     * An application that skipped 3DS on a card the provider flags for it has a
     * defect the customer must know about. Filing that as "we could not
     * measure" would hide the one result this scenario exists to produce.
     */
    const result = await runPaymentScenario(
      scenarioOf({
        kind: 'THREE_DS_CHALLENGE_PASS',
        catalogueId: 'stripe.card.3ds.required',
      }),
      'https://shop.example.com',
      deps({ checkout: fakeCheckout({ submission: { challengePresented: false } }) }),
    );
    expect(result.outcome).toBe('WRONG_MONEY_STATE');
    expect(result.detail).toContain('threeDsChallenge');
    expect(result.detail).toContain('bypassed the challenge');
  });

  it('refuses to report a verdict when the adapter did the opposite of the instruction', async () => {
    // An ABANDON that reports `completed: true` would otherwise produce a
    // PASSED abandonment test that actually completed the challenge.
    const result = await runPaymentScenario(
      scenarioOf({
        kind: 'THREE_DS_CHALLENGE_FAIL',
        catalogueId: 'stripe.card.3ds.required',
      }),
      'https://shop.example.com',
      deps({
        checkout: fakeCheckout({
          submission: { challengePresented: true },
          challenge: { completed: true, detail: 'Completed it anyway.' },
        }),
      }),
    );
    expect(result.outcome).toBe('UNAVAILABLE');
    expect(result.unavailableReason).toBe('MERCHANT_ACTION_UNAVAILABLE');
  });

  it('fails a form that accepted a card number it should have refused', async () => {
    const result = await runPaymentScenario(
      scenarioOf({
        kind: 'INVALID_CARD_NUMBER',
        catalogueId: 'stripe.card.invalid.luhn',
      }),
      'https://shop.example.com',
      {
        ...deps({ checkout: fakeCheckout({ submission: { rejectedClientSide: false } }) }),
        money: fakeMoney(money({ state: 'NONE', chargedMinor: null, chargeCount: 0 })),
      },
    );
    expect(result.outcome).toBe('WRONG_MONEY_STATE');
    expect(result.detail).toContain('clientValidation');
  });

  it('passes a form that refused it client-side and took nothing', async () => {
    const result = await runPaymentScenario(
      scenarioOf({
        kind: 'INVALID_CARD_NUMBER',
        catalogueId: 'stripe.card.invalid.luhn',
      }),
      'https://shop.example.com',
      {
        ...deps({ checkout: fakeCheckout({ submission: { rejectedClientSide: true } }) }),
        money: fakeMoney(money({ state: 'REJECTED_CLIENT_SIDE', chargedMinor: null, chargeCount: 0 })),
      },
    );
    expect(result.outcome).toBe('ASSERTED');
  });

  it('asserts the partial amount on a partial capture, not the full one', async () => {
    const checkout = fakeCheckout();
    const result = await runPaymentScenario(
      scenarioOf({ kind: 'PARTIAL_CAPTURE', partialAmountMinor: 1_500 }),
      'https://shop.example.com',
      {
        ...deps({ checkout }),
        money: fakeMoney(money({ state: 'PARTIALLY_CAPTURED', chargedMinor: 1_500 })),
      },
    );
    expect(checkout.actions).toEqual([{ action: 'CAPTURE', amountMinor: 1_500 }]);
    expect(result.outcome).toBe('ASSERTED');
    expect(result.detail).toContain('1500 GBP minor units');
  });

  it('fails a partial capture that took the full amount', async () => {
    const result = await runPaymentScenario(
      scenarioOf({ kind: 'PARTIAL_CAPTURE', partialAmountMinor: 1_500 }),
      'https://shop.example.com',
      {
        ...deps(),
        money: fakeMoney(money({ state: 'PARTIALLY_CAPTURED', chargedMinor: 4_200 })),
      },
    );
    expect(result.outcome).toBe('WRONG_MONEY_STATE');
    expect(result.detail).toContain('amount expected 1500 minor units, got 4200 minor units');
  });

  it('reports every mismatch, not the first', () => {
    const problems = compareMoney(scenarioOf(), ['CAPTURED'], {
      state: 'DECLINED',
      chargedMinor: 7,
      currency: 'USD',
      chargeCount: 3,
    });
    expect(problems.map((p) => p.field).sort()).toEqual([
      'amount',
      'chargeCount',
      'currency',
      'state',
    ]);
  });

  it('discloses a missing amount as a hole and never as a zero', async () => {
    /*
     * Rule 11. The application says money moved and will not say how much; a
     * comparison against the expected total as if it had said zero would be a
     * fabricated reading.
     */
    const result = await runPaymentScenario(
      scenarioOf(),
      'https://shop.example.com',
      deps({ money: fakeMoney(money({ chargedMinor: null })) }),
    );
    expect(result.outcome).toBe('ASSERTED');
    expect(result.notAsserted.map((h) => h.assertion).join(' ')).toContain('not a zero');
    expect(result.notAsserted.some((h) => h.reason === 'SURFACE_UNREACHED')).toBe(true);
  });

  it('records a thrown money read as a hole, then reports it unconfirmed', async () => {
    const result = await runPaymentScenario(
      scenarioOf(),
      'https://shop.example.com',
      deps({ money: fakeMoney('throws') }),
    );
    expect(result.outcome).toBe('SUBMITTED_NOT_CONFIRMED');
    expect(result.notAsserted.map((h) => h.assertion).join(' ')).toContain('fell over');
  });

  it('discloses an outstanding authorisation when it cannot capture', async () => {
    // A reader who is not told an authorisation may be sitting in their sandbox
    // will not go and look.
    const result = await runPaymentScenario(
      scenarioOf({ kind: 'AUTHORISE_THEN_DELAYED_CAPTURE' }),
      'https://shop.example.com',
      deps({ checkout: fakeCheckout({ merchant: null }) }),
    );
    expect(result.outcome).toBe('UNAVAILABLE');
    expect(result.unavailableReason).toBe('MERCHANT_ACTION_UNAVAILABLE');
    expect(result.detail).toContain('authorisation may be outstanding');
  });

  it('drives the application’s own refund action and asserts the refunded state', async () => {
    const checkout = fakeCheckout();
    const result = await runPaymentScenario(
      scenarioOf({ kind: 'REFUND_PARTIAL', partialAmountMinor: 2_000 }),
      'https://shop.example.com',
      {
        ...deps({ checkout }),
        money: fakeMoney(money({ state: 'PARTIALLY_REFUNDED', chargedMinor: 2_000 })),
      },
    );
    expect(checkout.actions).toEqual([{ action: 'REFUND', amountMinor: 2_000 }]);
    expect(result.outcome).toBe('ASSERTED');
  });
});

// ─── The webhook arm ─────────────────────────────────────────────────────────

describe('the webhook, which is the half that breaks silently', () => {
  const webhookScenario = {
    ...BASE_SCENARIO,
    kind: 'WEBHOOK_TRANSITION' as const,
    webhookEvent: 'charge.succeeded',
    catalogueId: null,
  };

  it('fails when the event arrived and the application ignored it', async () => {
    /*
     * The order sitting unpaid against a customer who has already been billed —
     * proved, which is why it is WRONG_MONEY_STATE and not the bounded "we
     * could not confirm" sentence.
     */
    const result = await runPaymentScenario(
      firstScenario(makeSpec([webhookScenario])),
      'https://shop.example.com',
      deps({
        webhooks: fakeWebhooks({
          event: 'charge.succeeded',
          appliedByApplication: false,
          detail: 'The order is still marked unpaid.',
        }),
      }),
    );
    expect(result.outcome).toBe('WRONG_MONEY_STATE');
    expect(result.detail).toContain('did NOT apply it');
    expect(result.detail).toContain('order sitting unpaid');
  });

  it('fails when nothing arrived, with the bound and the limit of the claim', async () => {
    const result = await runPaymentScenario(
      firstScenario(makeSpec([webhookScenario])),
      'https://shop.example.com',
      deps({ webhooks: fakeWebhooks(null) }),
      { observationBoundMs: 9_000 },
    );
    expect(result.outcome).toBe('SUBMITTED_NOT_CONFIRMED');
    expect(result.detail).toContain('9000ms bound');
    expect(result.detail).toContain('charge.succeeded');
    expect(result.detail).toContain('does NOT establish that no money moved');
  });

  it('passes when it arrived and was applied, and still states its two holes', async () => {
    /*
     * A pass with a non-empty hole list is a pass a gate can refuse to count. A
     * silent pass cannot be refused by anything — and the two holes here are
     * real: which terminal state is correct afterwards, and whether the
     * RECEIVER verified the signature and rejected a replay. Neither is
     * observable from a test run, and a green row must not read as coverage of
     * them.
     */
    const result = await runPaymentScenario(
      firstScenario(makeSpec([webhookScenario])),
      'https://shop.example.com',
      deps({
        webhooks: fakeWebhooks({
          event: 'charge.succeeded',
          appliedByApplication: true,
          detail: 'The order moved to paid.',
        }),
      }),
    );
    expect(result.outcome).toBe('ASSERTED');
    const holes = result.notAsserted.map((h) => h.assertion).join(' ');
    expect(holes).toContain('which terminal money state is correct');
    expect(holes).toContain('constant time');
    expect(holes).toContain('resolved the org from its own records');
  });

  it('never carries a webhook body, header or signature in what it observes', () => {
    /*
     * Rule 3, asserted structurally. `ObservedTransition` has three fields —
     * the event name the spec already named, a boolean, and the adapter's own
     * sentence — so there is no field a request body, a header value or a
     * cookie could occupy.
     */
    const transition: ObservedTransition = {
      event: 'charge.succeeded',
      appliedByApplication: true,
      detail: 'ok',
    };
    expect(Object.keys(transition).sort()).toEqual(['appliedByApplication', 'detail', 'event']);
    for (const key of ['body', 'payload', 'headers', 'signature', 'cookie', 'raw']) {
      expect(transition, key).not.toHaveProperty(key);
    }
  });

  it('refuses a webhook scenario with no event even off-schema', async () => {
    // The schema refuses it at parse time; this keeps the run-time path from
    // passing the moment the page does.
    const handBuilt = {
      ...firstScenario(makeSpec([webhookScenario])),
      webhookEvent: null,
    } as PaymentScenarioSpec;
    const result = await runPaymentScenario(handBuilt, 'https://shop.example.com', deps());
    expect(result.outcome).toBe('UNAVAILABLE');
    expect(result.unavailableReason).toBe('NO_WEBHOOK_OBSERVER');
  });
});

// ─── The vocabularies cannot drift ───────────────────────────────────────────

describe('the payments vocabularies cannot drift', () => {
  it('keeps the outcome union, its presence record and its labels one set', () => {
    expect([...MONEY_PATH_OUTCOME_LIST].sort()).toEqual([...MONEY_PATH_OUTCOMES].sort());
    for (const outcome of MONEY_PATH_OUTCOMES) {
      expect(MONEY_PATH_OUTCOME_LABELS[outcome].length, outcome).toBeGreaterThan(0);
      expect(typeof moneyPathStatus(outcome), outcome).toBe('string');
    }
  });

  it('keeps the refusal reasons, their remedies and their unasserted mapping one set', () => {
    expect([...PAYMENT_REFUSAL_REASON_LIST].sort()).toEqual([...PAYMENT_REFUSAL_REASONS].sort());
    for (const reason of PAYMENT_REFUSAL_REASONS) {
      expect(PAYMENT_REFUSAL_REMEDIES[reason].length, reason).toBeGreaterThan(40);
      expect(PAYMENT_REFUSAL_AS_UNASSERTED[reason], reason).toBeTruthy();
    }
  });

  it('keeps the unavailable reasons, their remedies and their unasserted mapping one set', () => {
    expect([...PAYMENT_UNAVAILABLE_REASON_LIST].sort()).toEqual(
      [...PAYMENT_UNAVAILABLE_REASONS].sort(),
    );
    for (const reason of PAYMENT_UNAVAILABLE_REASONS) {
      // An UNAVAILABLE with no remedy is a dead end a customer cannot act on,
      // which is how a gap becomes permanent.
      expect(PAYMENT_UNAVAILABLE_REMEDIES[reason].length, reason).toBeGreaterThan(40);
      expect(PAYMENT_UNAVAILABLE_AS_UNASSERTED[reason], reason).toBeTruthy();
    }
  });

  it('keeps the money states and the merchant actions derived rather than restated', () => {
    expect([...MONEY_STATE_LIST].sort()).toEqual([...MONEY_STATES].sort());
    expect([...MERCHANT_ACTION_LIST].sort()).toEqual([...MERCHANT_ACTIONS].sort());
    for (const state of MONEY_STATES) {
      expect([0, 1], state).toContain(chargesAllowedFor(state));
    }
  });

  it('matches the shared scenario vocabulary member for member, at run time', () => {
    /*
     * The run-time half of the compiler-enforced records. `ACCEPTABLE_MONEY_STATES`
     * and `FORCED_OUTCOME_FOR_SCENARIO` are `Record<PaymentScenarioKind, …>`, so
     * the compiler catches a missing key — but zod's `.options` exist only at
     * run time, and `check:wiring` cannot see a list that grew without its
     * write path.
     */
    expect([...paymentScenarioKindSchema.options].sort()).toEqual([...PAYMENT_SCENARIO_KINDS].sort());
    for (const kind of paymentScenarioKindSchema.options) {
      expect(Object.keys(ACCEPTABLE_MONEY_STATES), kind).toContain(kind);
      expect(Object.keys(FORCED_OUTCOME_FOR_SCENARIO), kind).toContain(kind);
    }
    expect(Object.keys(ACCEPTABLE_MONEY_STATES).sort()).toEqual([...PAYMENT_SCENARIO_KINDS].sort());
    expect(Object.keys(FORCED_OUTCOME_FOR_SCENARIO).sort()).toEqual(
      [...PAYMENT_SCENARIO_KINDS].sort(),
    );
  });

  it('expects a no-money state for exactly the scenarios that must take nothing', () => {
    /*
     * The assertion that makes a decline test worth running. A scenario whose
     * accepted states allow a charge where the provider refused one is a
     * scenario that cannot catch a charge it should not have taken.
     */
    const mustTakeNothing: PaymentScenarioKind[] = [
      'THREE_DS_CHALLENGE_FAIL',
      'DECLINE_GENERIC',
      'DECLINE_INSUFFICIENT_FUNDS',
      'DECLINE_EXPIRED_CARD',
      'DECLINE_INCORRECT_CVC',
      'INVALID_CARD_NUMBER',
    ];
    for (const kind of mustTakeNothing) {
      const states = ACCEPTABLE_MONEY_STATES[kind];
      expect(states, kind).not.toBeNull();
      for (const state of states!) {
        expect(chargesAllowedFor(state), `${kind}/${state}`).toBe(0);
        expect(expectedChargeMinor(scenarioOf(), state), `${kind}/${state}`).toBeNull();
      }
    }
  });

  it('names a forcing outcome for every kind OUTCOME_FORCING_SCENARIOS names', () => {
    // A forcing scenario with no outcome in this table would be checked against
    // nothing, and the catalogue gate would pass every card for it.
    for (const kind of OUTCOME_FORCING_SCENARIOS) {
      expect(FORCED_OUTCOME_FOR_SCENARIO[kind], kind).not.toBeNull();
    }
    // And the webhook kind is deliberately out: the event forces it, not a card.
    expect(FORCED_OUTCOME_FOR_SCENARIO.WEBHOOK_TRANSITION).toBeNull();
    expect(ACCEPTABLE_MONEY_STATES.WEBHOOK_TRANSITION).toBeNull();
  });

  it('reaches an outcome for every one of the fourteen scenario kinds', async () => {
    /*
     * The sweep that makes a new kind un-passable by default rather than
     * un-passable by review: every kind is driven through the real code with
     * fakes, and each one has to produce a real outcome rather than throwing.
     */
    for (const kind of PAYMENT_SCENARIO_KINDS) {
      const scenario = scenarioOf({
        kind,
        catalogueId: FORCED_OUTCOME_FOR_SCENARIO[kind] === null ? null : idThatForces(kind),
        ...(kind === 'PARTIAL_CAPTURE' || kind === 'REFUND_PARTIAL'
          ? { partialAmountMinor: 1_500 }
          : {}),
        ...(kind === 'WEBHOOK_TRANSITION' ? { webhookEvent: 'charge.succeeded' } : {}),
      });
      const result = await runPaymentScenario(scenario, 'https://shop.example.com', deps());
      expect(MONEY_PATH_OUTCOMES, kind).toContain(result.outcome);
      expect(typeof result.detail, kind).toBe('string');
      expect(result.detail.length, kind).toBeGreaterThan(0);
    }
  });
});

// ─── The default surfaces ────────────────────────────────────────────────────

describe('the default surfaces refuse rather than fake an answer', () => {
  it('reports no checkout adapter rather than an unreachable route', async () => {
    /*
     * Blaming the deployment for our missing adapter would send somebody to
     * debug a server that is fine — and claiming a bot defence we never saw
     * would send them to configure a test key that would change nothing.
     */
    const arrival = await unavailableCheckoutSurface.arrive('/checkout', 'https://shop.example.com');
    expect(arrival.ok).toBe(false);
    expect(!arrival.ok && arrival.reason).toBe('NO_CHECKOUT_SURFACE');
  });

  it('never reports a submission it did not make', async () => {
    const submission = await unavailableCheckoutSurface.submit(
      {
        path: '/checkout',
        catalogueId: null,
        amountMinor: 1,
        currency: 'GBP',
        submissions: 1,
      },
      'https://shop.example.com',
    );
    expect(submission.submitted).toBe(false);
    expect(await unavailableCheckoutSurface.resolveChallenge('COMPLETE')).toBeNull();
    expect(await unavailableCheckoutSurface.merchantAction('CAPTURE', null)).toBeNull();
  });

  it('reads no money state rather than reporting that there is no charge', async () => {
    /*
     * The single most attractive wrong answer available here: a fake
     * `state: 'NONE'` passes every decline scenario in the product on a
     * deployment with no adapter at all, because it looks exactly like a
     * correctly refused payment.
     */
    const readable = await unavailableMoneyStateSource.available();
    expect(readable.ok).toBe(false);
    expect(await unavailableMoneyStateSource.observe('order_1', 1_000)).toBeNull();
  });

  it('sees no webhook and says which gap it is', async () => {
    const seeing = await unavailableWebhookObserver.available();
    expect(seeing.ok).toBe(false);
    expect(!seeing.ok && seeing.reason).toBe('NO_WEBHOOK_OBSERVER');
    expect(await unavailableWebhookObserver.waitFor('charge.succeeded', 1_000)).toBeNull();
  });

  it('runs a whole test through the installed defaults as SKIPPED with a remedy', async () => {
    /*
     * What the product actually ships until an adapter is configured. SKIPPED
     * with a named remedy, not PASSED, and not a submission against anybody's
     * sandbox.
     */
    const spec = makeSpec();
    const previous = setPaymentsDeps({
      checkout: unavailableCheckoutSurface,
      gateways: unavailableGatewayModes,
      money: unavailableMoneyStateSource,
      webhooks: unavailableWebhookObserver,
    });
    try {
      const execution = await paymentsPlugin.execute(makeCtx(), makeTest(spec));
      expect(execution.status).toBe('SKIPPED');
      expect(execution.notRun?.kind).toBe('NOT_RUN');
      expect(allText(execution)).toContain('NO_GATEWAY_INTEGRATION');
      expect(allText(execution)).toContain('Connect the provider');
    } finally {
      setPaymentsDeps(previous);
    }
  });

  it('gives the real clock a monotonic-enough now()', () => {
    const first = realPaymentsClock.now();
    const second = realPaymentsClock.now();
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('clamps the observation bound to the test’s own timeout', () => {
    /*
     * Without the clamp a five-second test would wait fifteen for its money
     * state and be killed mid-observation — reported as a timeout rather than
     * as the SUBMITTED_NOT_CONFIRMED it is, which is a worse sentence about a
     * payment than the true one.
     */
    expect(moneyObservationBoundMs(60_000)).toBe(DEFAULT_MONEY_OBSERVATION_MS);
    expect(moneyObservationBoundMs(5_000)).toBe(5_000);
    expect(moneyObservationBoundMs(10)).toBe(1_000);
    expect(moneyObservationBoundMs(0)).toBe(DEFAULT_MONEY_OBSERVATION_MS);
    expect(moneyObservationBoundMs(Number.NaN)).toBe(DEFAULT_MONEY_OBSERVATION_MS);
  });
});

// ─── The result shape ────────────────────────────────────────────────────────

describe('the result shape', () => {
  it('stops at a cancelled run without claiming a pass', async () => {
    const controller = new AbortController();
    controller.abort();
    const spec = makeSpec();
    const execution = await runPaymentsTest(
      makeCtx(controller.signal),
      makeTest(spec),
      spec,
      deps(),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('CANCELLED');
    expect(execution.steps).toEqual([]);
  });

  it('puts an error on a FAILED step and nothing on a SKIPPED one', async () => {
    /*
     * `error` on a StepResult means "this failed". A REFUSED or UNAVAILABLE
     * step did not fail, and a SKIPPED step under a FAILED test is how a reader
     * comes to believe the money path was merely unmeasured.
     */
    const spec = makeSpec([
      { ...BASE_SCENARIO, path: '/checkout/wrong' },
      { ...BASE_SCENARIO, path: '/checkout/refused' },
    ]);
    const answers: Array<ObservedMoney | null> = [money({ state: 'DECLINED' })];
    let call = 0;
    const execution = await runPaymentsTest(makeCtx(), makeTest(spec), spec, {
      ...deps(),
      gateways: {
        describe: async () => {
          call += 1;
          return call === 1 ? { present: true, mode: 'TEST' } : { present: true, mode: 'LIVE' };
        },
      },
      money: {
        available: async () => ({ ok: true as const }),
        observe: async () => answers.shift() ?? null,
      },
    });

    expect(execution.status).toBe('FAILED');
    const failed = execution.steps.filter((step) => step.status === 'FAILED');
    const skipped = execution.steps.filter((step) => step.status === 'SKIPPED');
    expect(failed.length).toBe(1);
    expect(skipped.length).toBe(1);
    expect(failed[0]?.error?.message).toBeTruthy();
    expect(skipped[0]?.error).toBeNull();
  });

  it('logs a step for every scenario', async () => {
    const spec = makeSpec([
      { ...BASE_SCENARIO, path: '/a' },
      { ...BASE_SCENARIO, path: '/b' },
    ]);
    const ctx = makeCtx();
    const execution = await runPaymentsTest(ctx, makeTest(spec), spec, deps());
    expect(execution.steps.map((step) => step.index)).toEqual([0, 1]);
    expect(ctx.logged.length).toBe(2);
    expect(ctx.logged[0]).toContain('AUTHORISE_AND_CAPTURE /a');
  });

  it('discloses the unmeasured scenarios on a result that still PASSED', async () => {
    /*
     * A mix of asserted and unmeasured is a PASS with a stated hole in it. The
     * gate can refuse to count it; a silent pass cannot be refused by anything.
     */
    const spec = makeSpec([
      { ...BASE_SCENARIO, path: '/a' },
      { ...BASE_SCENARIO, path: '/b' },
    ]);
    let call = 0;
    const execution = await runPaymentsTest(makeCtx(), makeTest(spec), spec, {
      ...deps(),
      checkout: {
        ...fakeCheckout(),
        arrive: async (path) => {
          call += 1;
          return call === 1
            ? { ok: true as const, detail: 'up' }
            : { ok: false as const, reason: 'CHECKOUT_UNREACHABLE' as const, detail: `${path} 500ed` };
        },
      },
    });
    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage).toContain('were NOT measured');
    expect(execution.errorMessage).toContain('CHECKOUT_UNREACHABLE');
  });

  it('carries the scenario’s own declared holes onto the result', async () => {
    /*
     * A producer that already knows an assertion cannot be made here records it
     * on `notAsserted`, and carrying it through is what makes a plan's promise
     * and a run's report the same list.
     */
    const spec = makeSpec([
      {
        ...BASE_SCENARIO,
        notAsserted: [
          { assertion: 'a settlement, which test mode never performs', reason: 'PROVIDER_TEST_MODE_LIMIT' },
        ],
      },
    ]);
    const execution = await runPaymentsTest(makeCtx(), makeTest(spec), spec, deps());
    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage).toContain('a settlement, which test mode never performs');
    expect(execution.console.some((entry) => entry.text.includes('NOT ASSERTED'))).toBe(true);
  });

  it('rejects an invalid spec at validate() rather than part-way through a run', () => {
    expect(() => paymentsPlugin.validate(makeTest({ scenarios: [] }))).toThrow(
      /has an invalid spec/,
    );
    expect(() =>
      paymentsPlugin.validate(makeTest({ scenarios: [{ ...BASE_SCENARIO, testMode: false }] })),
    ).toThrow(/has an invalid spec/);
  });

  it('claims the PAYMENTS type and nothing else', () => {
    // The key in PENDING_PLUGINS is what `pluginFor` answers to and this is
    // what every result it produces is labelled with. Nothing in the type
    // system ties them together.
    expect(paymentsPlugin.type).toBe('PAYMENTS');
    expect(typeof paymentsPlugin.validate).toBe('function');
    expect(typeof paymentsPlugin.execute).toBe('function');
  });
});
