/**
 * The PAYMENTS plugin's safety boundary, driven through the real aggregate:
 * it prints nothing that is, or contains, a credential (rule 3), and it drives
 * nothing at a host the environment did not name (rule 9).
 *
 * ── THE DEFECT THESE TESTS PIN ──────────────────────────────────────────────
 *
 * The plugin's header promised there is "NO EXPRESSION in this file that can
 * reach a provider secret key: not to log it, not to hash it, not in an error
 * path". That was true of the gateway interface, which has no value field, and
 * false of every string the plugin interpolated. A scenario's `path`,
 * `publisher` and `webhookEvent` are customer text the schema bounds in length
 * and nothing else; an adapter's `detail` is prose off a customer's page; a
 * thrown adapter error is whatever its author wrote; and a `catalogueId` that
 * was long, mixed-case and unstructured — the shape of a generated key with a
 * prefix the vocabulary does not carry — was refused by nobody and then QUOTED
 * into a step title as "no published value is catalogued under <the id>".
 *
 * All of it went verbatim into a step title, an `errorMessage`, a console line
 * and the logger. Driven here through `runPaymentsTest` — the real aggregate —
 * and not through a helper, because the leak was in the join between the
 * plugin's sentences and the places a run prints them.
 *
 * ── RULE 4 ──────────────────────────────────────────────────────────────────
 *
 * Nothing in this file is a complete key-shaped literal. Every probe is
 * COMPOSED at run time from a prefix in the exported `SECRET_SHAPES` vocabulary
 * plus an obviously-fake tail, and the opaque identifier is built from an
 * alphabet and then checked against the catalogue's own admission so the test
 * fails loudly if the construction ever stops being the shape it claims to be.
 */

import { describe, expect, it } from 'vitest';
import { SECRET_SHAPES, admitPublishedValue, paymentsTestSpecSchema } from '@qaai/shared';
import type { ExecutableTest, RunContext, TestExecution } from '@qaai/shared';
import {
  adapterDetail,
  maskCredentialShapes,
  paymentsPlugin,
  printablePath,
  refuseOffEnvironmentPath,
  runPaymentScenario,
  runPaymentsTest,
} from './payments.js';
import type {
  CheckoutSurface,
  GatewayModeSource,
  MoneyStateSource,
  PaymentsDeps,
  WebhookObserver,
} from './payments.js';

const FAKE_TAIL = ['zz', 'not', 'a', 'real', 'key', '0000'].join('');
const keyFor = (prefix: string): string => `${prefix}${FAKE_TAIL}`;
const ALL_KEY_SHAPED = SECRET_SHAPES.map((shape) => keyFor(shape.prefix));

/** A stripe-live-prefixed and a JWT-prefixed probe, looked up rather than spelled. */
const prefixOf = (what: RegExp): string => {
  const found = SECRET_SHAPES.find((shape) => what.test(shape.what));
  if (found === undefined) throw new Error(`no secret shape matches ${String(what)}`);
  return found.prefix;
};
const STRIPE_LIVE = keyFor(prefixOf(/Stripe live secret/));
const JWT_SHAPED = keyFor(prefixOf(/JWT/));

/**
 * Forty characters, mixed case, digits, many distinct — built from an alphabet,
 * never written out. Asserted below to be what the catalogue calls opaque.
 */
const ALPHABET = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
const OPAQUE_ID = Array.from({ length: 40 }, (_, i) => ALPHABET[(i * 7 + 3) % ALPHABET.length]).join(
  '',
);

function makeCtx(): RunContext & { logged: string[] } {
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
    signal: new AbortController().signal,
    determinism: { freezeClockAt: null, randomSeed: 1, waitForNetworkIdle: false, retryOnce: false },
    logged,
  };
}

function makeTest(spec: unknown): ExecutableTest {
  return {
    id: 'test_1',
    name: 'the checkout takes the right money',
    type: 'E2E',
    code: '',
    filePath: 'payments/checkout.json',
    spec,
    timeoutMs: 60_000,
    quarantined: false,
    tags: [],
  };
}

function specWith(over: Record<string, unknown> = {}) {
  return paymentsTestSpecSchema.parse({
    scenarios: [
      {
        kind: 'AUTHORISE_AND_CAPTURE',
        testMode: true,
        publisher: 'stripe',
        catalogueId: 'stripe.card.success.visa',
        path: '/checkout',
        amountMinor: 4_200,
        currency: 'GBP',
        ...over,
      },
    ],
  });
}

const testGateway: GatewayModeSource = {
  describe: async () => ({ present: true, mode: 'TEST' }),
};
const readableMoney: MoneyStateSource = {
  available: async () => ({ ok: true }),
  observe: async () => ({ state: 'CAPTURED', chargedMinor: 4_200, currency: 'GBP', chargeCount: 1 }),
};
const watchingWebhooks: WebhookObserver = {
  available: async () => ({ ok: true }),
  waitFor: async () => null,
};

function checkoutWith(over: Partial<CheckoutSurface> = {}): CheckoutSurface {
  return {
    arrive: async () => ({ ok: true, detail: 'arrived' }),
    submit: async () => ({
      submitted: true,
      reference: 'ord_1',
      rejectedClientSide: false,
      challengePresented: false,
      detail: 'submitted',
    }),
    resolveChallenge: async () => null,
    merchantAction: async () => null,
    ...over,
  };
}

function depsWith(over: Partial<PaymentsDeps> = {}): PaymentsDeps {
  return {
    checkout: checkoutWith(),
    gateways: testGateway,
    money: readableMoney,
    webhooks: watchingWebhooks,
    ...over,
  };
}

/** Everything a run prints: the execution, and every step title the logger saw. */
function everythingPrinted(execution: TestExecution, ctx: { logged: string[] }): string {
  return `${JSON.stringify(execution)}\n${ctx.logged.join('\n')}`;
}

async function run(spec: ReturnType<typeof specWith>, deps: PaymentsDeps) {
  const ctx = makeCtx();
  const execution = await runPaymentsTest(ctx, makeTest(spec), spec, deps);
  return { execution, text: everythingPrinted(execution, ctx) };
}

describe('the probes are what they claim to be', () => {
  it('builds an opaque identifier the catalogue itself calls opaque', () => {
    const admission = admitPublishedValue(OPAQUE_ID);
    expect(admission.admitted).toBe(false);
    expect(admission.admitted ? '' : admission.reason).toBe('OPAQUE_HIGH_ENTROPY');
  });

  it('derives its key-shaped probes from the whole exported vocabulary', () => {
    expect(ALL_KEY_SHAPED.length).toBe(SECRET_SHAPES.length);
    expect(ALL_KEY_SHAPED.length).toBeGreaterThan(20);
  });
});

describe('maskCredentialShapes', () => {
  it('masks every shape in the vocabulary, wherever it sits in a sentence', () => {
    for (const probe of ALL_KEY_SHAPED) {
      const masked = maskCredentialShapes(`before ${probe} after`);
      expect(masked, probe.slice(0, 6)).not.toContain(probe);
      expect(masked).toContain('[redacted:');
      expect(masked.startsWith('before ')).toBe(true);
      expect(masked.endsWith(' after')).toBe(true);
    }
  });

  it('leaves ordinary text alone', () => {
    const text = 'The form refused the card before any network call, as it should.';
    expect(maskCredentialShapes(text)).toBe(text);
  });

  it('masks BEFORE it bounds, so a cut cannot leave a usable prefix', () => {
    // The key STARTS inside the three-hundred-character bound and ends past it.
    // Truncating first would leave its whole prefix and the front of its tail in
    // the sentence — a usable credential fragment — which a key that began at the
    // very edge would not, and is why the offset is not simply "near 300".
    const detail = `${'x'.repeat(285)}${STRIPE_LIVE}`;
    expect(detail.length).toBeGreaterThan(300);
    expect(285 + prefixOf(/Stripe live secret/).length).toBeLessThan(300);
    const bounded = adapterDetail(detail);
    expect(bounded).not.toContain(prefixOf(/Stripe live secret/));
    expect(bounded).not.toContain(FAKE_TAIL.slice(0, 6));
  });
});

describe('printablePath', () => {
  it('drops the query, says it did, and masks what is left', () => {
    expect(printablePath('/checkout')).toBe('/checkout');
    expect(printablePath('/pay?token=abc123')).toBe('/pay?…');
    expect(printablePath('/pay#frag')).toBe('/pay?…');
    expect(printablePath(`/${STRIPE_LIVE}/pay`)).not.toContain(STRIPE_LIVE);
  });
});

describe('what an adapter says is data, and a credential in it is not printed', () => {
  it('masks a key the checkout page quoted when the route would not open', async () => {
    const { execution, text } = await run(
      specWith(),
      depsWith({
        checkout: checkoutWith({
          arrive: async () => ({
            ok: false,
            reason: 'CHECKOUT_UNREACHABLE',
            detail: `the page said: Invalid API Key provided: ${STRIPE_LIVE}`,
          }),
        }),
      }),
    );
    expect(execution.status).toBe('SKIPPED');
    for (const probe of ALL_KEY_SHAPED) expect(text).not.toContain(probe);
    expect(text).toContain('[redacted:');
  });

  it('masks a key the checkout page quoted when the submission did not happen', async () => {
    const { text } = await run(
      specWith(),
      depsWith({
        checkout: checkoutWith({
          submit: async () => ({
            submitted: false,
            reference: null,
            rejectedClientSide: false,
            challengePresented: false,
            detail: `server error: ${STRIPE_LIVE}`,
          }),
        }),
      }),
    );
    expect(text).not.toContain(STRIPE_LIVE);
  });

  it('masks a key inside the text of an error an adapter threw', async () => {
    const { execution, text } = await run(
      specWith(),
      depsWith({
        money: {
          available: async () => ({ ok: true }),
          observe: async () => {
            throw new Error(`gateway said ${STRIPE_LIVE}`);
          },
        },
      }),
    );
    expect(execution.status).toBe('FAILED');
    expect(text).not.toContain(STRIPE_LIVE);

    // The scenario result ITSELF, before any print site masks it a second time:
    // the hole it records is the sentence that reaches the console, the errorMessage
    // and anything that later reads `ScenarioResult`.
    const scenario = specWith().scenarios[0]!;
    const result = await runPaymentScenario(
      scenario,
      'https://shop.example.com',
      depsWith({
        money: {
          available: async () => ({ ok: true }),
          observe: async () => {
            throw new Error(`gateway said ${STRIPE_LIVE}`);
          },
        },
      }),
    );
    expect(result.outcome).toBe('SUBMITTED_NOT_CONFIRMED');
    expect(JSON.stringify(result)).not.toContain(STRIPE_LIVE);

    const thrownAtCheckout = await run(
      specWith(),
      depsWith({
        checkout: checkoutWith({
          arrive: async () => {
            throw new Error(`boom ${JWT_SHAPED}`);
          },
        }),
      }),
    );
    expect(thrownAtCheckout.text).not.toContain(JWT_SHAPED);
  });

  it('masks a key in the provider event an observer reports', async () => {
    const spec = specWith({ kind: 'WEBHOOK_TRANSITION', webhookEvent: 'charge.refunded' });
    const { text } = await run(
      spec,
      depsWith({
        webhooks: {
          available: async () => ({ ok: true }),
          waitFor: async () => ({
            event: `charge.refunded ${STRIPE_LIVE}`,
            appliedByApplication: false,
            detail: `signature ${JWT_SHAPED}`,
          }),
        },
      }),
    );
    expect(text).not.toContain(STRIPE_LIVE);
    expect(text).not.toContain(JWT_SHAPED);
  });
});

describe('what the spec says is customer text, and a credential in it is not printed', () => {
  it('prints neither the key nor the query when the route carries one — on a PASSING run', async () => {
    /*
     * A PASSED run, deliberately: the leak was in the step title, which every
     * scenario prints whatever it concluded, so a green run leaked as readily as
     * a red one.
     */
    const spec = specWith({ path: `/pay?key=${STRIPE_LIVE}&token=${JWT_SHAPED}` });
    const { execution, text } = await run(spec, depsWith());
    expect(execution.status).toBe('PASSED');
    for (const probe of ALL_KEY_SHAPED) expect(text).not.toContain(probe);
    expect(text).not.toContain('token=');
    expect(text).toContain('/pay?…');
  });

  it('still hands the adapter the route exactly as written', async () => {
    // The query string can be what routes the checkout, so the adapter gets all of
    // it — masking is for what is PRINTED, never for what is driven.
    const seen: string[] = [];
    const spec = specWith({ path: '/pay?session=opaque-value' });
    await run(
      spec,
      depsWith({
        checkout: checkoutWith({
          arrive: async (path) => {
            seen.push(path);
            return { ok: true, detail: 'arrived' };
          },
          submit: async (request) => {
            seen.push(request.path);
            return {
              submitted: true,
              reference: 'ord_1',
              rejectedClientSide: false,
              challengePresented: false,
              detail: 'submitted',
            };
          },
        }),
      }),
    );
    expect(seen).toEqual(['/pay?session=opaque-value', '/pay?session=opaque-value']);
  });

  it('prints neither the key nor a mislabelled gateway when the publisher is a credential', async () => {
    const spec = specWith({ publisher: STRIPE_LIVE });
    const { execution, text } = await run(
      spec,
      depsWith({ gateways: { describe: async () => ({ present: true, mode: 'LIVE' }) } }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(text).not.toContain(STRIPE_LIVE);

    const absent = await run(
      spec,
      depsWith({ gateways: { describe: async () => ({ present: false, mode: 'UNKNOWN' }) } }),
    );
    expect(absent.text).not.toContain(STRIPE_LIVE);
  });

  it('prints neither the key nor the event name when the awaited event is a credential', async () => {
    const spec = specWith({ kind: 'WEBHOOK_TRANSITION', webhookEvent: STRIPE_LIVE });
    const { execution, text } = await run(spec, depsWith());
    expect(execution.status).toBe('FAILED');
    expect(text).not.toContain(STRIPE_LIVE);
  });

  it('refuses an opaque catalogueId as a credential and never quotes it', async () => {
    const spec = specWith({ catalogueId: OPAQUE_ID });
    const { execution, text } = await run(spec, depsWith());
    expect(text).not.toContain(OPAQUE_ID);
    // REFUSED and recorded as refused — not filed as "no value is catalogued".
    expect(execution.console.some((entry) => entry.text.includes('SPEC_NAMES_A_CREDENTIAL_SHAPED_VALUE'))).toBe(
      true,
    );
    expect(text).not.toContain('NO_PUBLISHED_TEST_VALUE');
  });

  it('refuses it at validate() as well, by shape, without echoing it', () => {
    const spec = specWith({ catalogueId: OPAQUE_ID });
    let message = '';
    try {
      paymentsPlugin.validate(makeTest(spec));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(OPAQUE_ID);
  });
});

describe('a route that leaves the environment is refused, recorded as refused, and not driven', () => {
  /**
   * `paymentScenarioSchema.path` is a bounded string and nothing more, so each of
   * these parses. The checkout adapter resolves `(path, baseUrl)` with the
   * platform's URL parser, which obliges every one of them. Composed from parts
   * so that no complete URL to a metadata service or a loopback port is written
   * out as a literal in a file a scanner reads.
   */
  const METADATA_HOST = ['169', '254', '169', '254'].join('.');
  const OFF_ENVIRONMENT = [
    `https://${METADATA_HOST}/latest/meta-data/`,
    '//evil.example/pay',
    'http://localhost:6379/',
    'https://shop.example.com.evil.example/checkout',
    'http://shop.example.com/checkout',
    'https://shop.example.com:8443/checkout',
    '\\\\evil.example\\pay',
    'javascript:void(0)',
    'data:text/html,hello',
  ];

  it.each(OFF_ENVIRONMENT)('refuses %s', async (path) => {
    let touched = 0;
    const counting = checkoutWith({
      arrive: async () => {
        touched += 1;
        return { ok: true, detail: 'arrived' };
      },
      submit: async () => {
        touched += 1;
        return {
          submitted: true,
          reference: 'ord_1',
          rejectedClientSide: false,
          challengePresented: false,
          detail: 'submitted',
        };
      },
    });
    const spec = specWith({ path });
    const { execution, text } = await run(spec, depsWith({ checkout: counting }));

    // Nothing was opened and nothing was submitted.
    expect(touched).toBe(0);
    expect(execution.status).toBe('SKIPPED');
    // RECORDED AS REFUSED, under its own reason — not as a missing adapter and not
    // as a route that failed to come up.
    expect(execution.console.some((entry) => entry.text.includes('REFUSED (PATH_LEAVES_THE_ENVIRONMENT)'))).toBe(
      true,
    );
    expect(text).not.toContain('CHECKOUT_UNREACHABLE');
    expect(text).not.toContain('NO_CHECKOUT_SURFACE');
    // The destination is the thing a report must not carry.
    expect(text).not.toContain(METADATA_HOST);
    expect(text).not.toContain('evil.example');
  });

  it('leaves a route on the environment alone, query and all', () => {
    const base = 'https://shop.example.com';
    for (const path of [
      '/checkout',
      'checkout',
      '/checkout/step-2?session=abc',
      '/pay?next=https://evil.example/x',
      '/a/../checkout',
    ]) {
      expect(refuseOffEnvironmentPath(path, base), path).toBeNull();
    }
  });

  it('refuses when the environment itself cannot be resolved, rather than guessing', () => {
    expect(refuseOffEnvironmentPath('/checkout', '')?.reason).toBe('PATH_LEAVES_THE_ENVIRONMENT');
    expect(refuseOffEnvironmentPath('/checkout', 'not a url')?.reason).toBe(
      'PATH_LEAVES_THE_ENVIRONMENT',
    );
  });

  it('is asked BEFORE the gateway, the money source or the checkout is', async () => {
    const asked: string[] = [];
    const spec = specWith({ path: '//evil.example/pay' });
    await run(
      spec,
      depsWith({
        gateways: {
          describe: async () => {
            asked.push('gateways');
            return { present: true, mode: 'TEST' };
          },
        },
        money: {
          available: async () => {
            asked.push('money');
            return { ok: true };
          },
          observe: async () => null,
        },
      }),
    );
    expect(asked).toEqual([]);
  });
});
