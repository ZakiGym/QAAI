/**
 * The transactional-email plugin, and the three lies it must never tell.
 *
 *  1. A MAIL THAT DID NOT ARRIVE IS NOT A PASS. It is NOT_DELIVERED, with the
 *     wait that elapsed — and whether it is a FAILURE or an UNKNOWN depends on
 *     one thing only: whether this plugin fired the trigger itself. The heaviest
 *     block here pins both halves and the invariant that neither is PASSED.
 *
 *  2. A MAIL THAT ARRIVED AND COULD NOT BE CHECKED IS NOT A PASS EITHER. "A
 *     receipt landed in the sink" is not a statement about the receipt, and a
 *     green EMAIL test whose every assertion came back UNKNOWN is the "pass that
 *     means we did not check" the register names as the single likeliest defect
 *     in a round of new plugins.
 *
 *  3. THE TOKEN IS NEVER THE EVIDENCE. A magic link and a reset link carry a
 *     bearer credential. This file sweeps the WHOLE serialised result for the
 *     token value after every path that handles one, because a redaction that
 *     covers the step title and not the error message is not a redaction.
 *
 * The counter-tests matter as much as the honesty ones: a receipt with the wrong
 * total, a reset link that 404s, an invoice that is zero bytes and a
 * `Hi {{firstName}}` that went out to 40,000 people must all still FAIL, or
 * UNKNOWN becomes a way to make every mail defect disappear.
 *
 * Nothing here opens a socket, resolves a name or sleeps. The mailbox, the link
 * probe, the trigger, the clock and the DNS resolver are all fakes.
 */

import { describe, expect, it } from 'vitest';
import { SECRET_SHAPES } from '@qaai/shared';
import type { ExecutableTest, RunContext, TestExecution } from '@qaai/shared';
import type { LookupFn } from '@qaai/shared/private-address';
import {
  DEFAULT_PLACEHOLDER_MARKERS,
  EMAIL_ASSERTIONS,
  EMAIL_ASSERTION_LABELS,
  EMAIL_ASSERTION_PRESENCE,
  EMAIL_NOT_DELIVERED,
  EMAIL_TRIGGER_KINDS,
  EMAIL_TRIGGER_KIND_LIST,
  LINK_TOKEN_ALPHABETS,
  LINK_TOKEN_ALPHABET_LIST,
  LINK_TOKEN_PLACES,
  LINK_TOKEN_PLACE_LIST,
  alphabetSatisfies,
  classifyAlphabet,
  deliveryStatus,
  describeLinkToken,
  emailAssertionSchema,
  emailPlugin,
  emailTestSpecSchema,
  extractLinks,
  findLink,
  findUnsubscribe,
  missingEmailFields,
  notDeliveredWhy,
  realMailClock,
  redactLink,
  runEmailAssertion,
  runEmailTest,
  safeExcerpt,
  screenHost,
  setEmailDeps,
  sniffContentType,
  unavailableLinkProbe,
  unavailableMailTrigger,
  unavailableMailbox,
  waitForMail,
} from './email.js';
import type {
  DeliveredMail,
  EmailDeps,
  EmailTestSpec,
  LinkProbe,
  LinkProbeResult,
  MailAttachment,
  MailClock,
  MailTrigger,
  MailboxReader,
} from './email.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

/**
 * A clock that never sleeps.
 *
 * `sleep` ADVANCES the clock instead of waiting, so a 60-second budget is
 * exhausted in microseconds and the NOT_DELIVERED paths — unreachable through a
 * real provider that happens to be fast — are the easiest ones to test.
 */
function fakeClock(): MailClock & { elapsed: () => number } {
  let now = 1_700_000_000_000;
  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    elapsed: () => now - 1_700_000_000_000,
  };
}

/**
 * The token every redaction sweep looks for.
 *
 * COMPOSED at run time from a prefix constant and an obviously-fake tail, never
 * written as a complete credential-shaped literal — lesson E: GitHub push
 * protection blocked a finished, green commit on three invented `sk_live_`
 * strings in a test file whose own comment said they were keyboard noise.
 */
const TOKEN_TAIL = 'ZZZnotarealtokenZZZ000111222333';
const RESET_TOKEN = `rst${TOKEN_TAIL}`;

function mail(overrides: Partial<DeliveredMail> = {}): DeliveredMail {
  return {
    to: 'buyer@example.test',
    from: 'receipts@shop.example.com',
    replyTo: 'support@shop.example.com',
    subject: 'Your receipt from Shop — order 931',
    text: 'Hi Sam, your total was $42.50 on 4 March. https://shop.example.com/orders/931',
    html:
      '<p>Hi Sam, your total was $42.50 on 4 March.</p>' +
      '<a href="https://shop.example.com/orders/931">View your order</a>' +
      `<a href="https://shop.example.com/receipt/view?t=${RESET_TOKEN}">Download your receipt</a>` +
      '<a href="https://shop.example.com/mail/unsubscribe?u=abc">Unsubscribe</a>',
    headers: { 'content-language': 'en-GB', 'list-unsubscribe': '<https://shop.example.com/u/abc>' },
    attachments: [],
    receivedAt: '2026-03-04T10:00:00.000Z',
    ...overrides,
  };
}

function attachment(overrides: Partial<MailAttachment> = {}): MailAttachment {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
  return {
    filename: 'invoice-000931.pdf',
    contentType: 'application/pdf',
    sizeBytes: bytes.length,
    bytes,
    ...overrides,
  };
}

/** A sink whose answer per poll the test controls. */
function fakeMailbox(batches: Array<readonly DeliveredMail[]>): MailboxReader & {
  polls: number;
  queries: string[];
} {
  const state = { polls: 0 };
  const queries: string[] = [];
  return {
    get polls() {
      return state.polls;
    },
    queries,
    list: async (query) => {
      queries.push(`${query.to}|${query.templateId ?? '*'}`);
      const batch = batches[Math.min(state.polls, batches.length - 1)] ?? [];
      state.polls += 1;
      return batch;
    },
  };
}

function fakeProbe(answers: Record<string, LinkProbeResult> = {}): LinkProbe & { probed: string[] } {
  const probed: string[] = [];
  return {
    probed,
    probe: async (url) => {
      probed.push(url);
      for (const [needle, answer] of Object.entries(answers)) {
        if (url.includes(needle)) return answer;
      }
      return { status: 200, finalUrl: url, unreachable: null };
    },
  };
}

function fakeTrigger(fired = true): MailTrigger & { fires: number } {
  const state = { fires: 0 };
  return {
    get fires() {
      return state.fires;
    },
    fire: async (trigger) => {
      state.fires += 1;
      return { fired, detail: fired ? `Fired ${trigger.target}.` : 'The route answered 500.' };
    },
  };
}

/** A resolver that answers with whatever the test says, so nothing does DNS. */
function fakeLookup(address = '93.184.216.34'): LookupFn {
  return async () => [{ address }];
}

function deps(overrides: Partial<EmailDeps> = {}): EmailDeps {
  return {
    mailbox: overrides.mailbox ?? fakeMailbox([[mail()]]),
    links: overrides.links ?? fakeProbe(),
    trigger: overrides.trigger ?? fakeTrigger(),
    clock: overrides.clock ?? fakeClock(),
    // `in` and not `??`: an explicit `lookup: null` is the "do not resolve"
    // case this suite has to be able to express, and `??` swallowed it.
    lookup: 'lookup' in overrides ? overrides.lookup : fakeLookup(),
  };
}

function makeSpec(overrides: Record<string, unknown> = {}): EmailTestSpec {
  return emailTestSpecSchema.parse({
    recipient: 'buyer@example.test',
    mailboxUrl: 'https://mail.example.com/__mail',
    trigger: { kind: 'HTTP_POST', target: '/checkout/complete' },
    assertions: ['SUBJECT'],
    expectSubject: 'Your receipt from Shop',
    timeoutSeconds: 5,
    pollIntervalMs: 500,
    ...overrides,
  });
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

function makeTest(spec: unknown, name = 'the receipt is correct'): ExecutableTest {
  return {
    id: 'test_1',
    name,
    // EMAIL is not in TEST_TYPES yet — see the registry's PENDING_PLUGINS.
    type: 'E2E',
    code: '',
    filePath: 'email/receipt.json',
    spec,
    timeoutMs: 60_000,
    quarantined: false,
    tags: [],
  };
}

/** Every string a result carries, flattened, for the redaction sweeps. */
function allText(execution: TestExecution): string {
  return JSON.stringify(execution);
}

const noSignal = new AbortController().signal;
const assertionDeps = (links: LinkProbe = fakeProbe(), lookup: LookupFn | null = fakeLookup()) => ({
  links,
  lookup,
});

// ─── LIE 1: a mail that did not arrive ───────────────────────────────────────

describe('a mail that did not arrive is NOT_DELIVERED, never a pass', () => {
  it('never maps a non-delivery to PASSED, under either trigger', () => {
    /*
     * THE invariant. Written as `not PASSED` on both arms rather than as two
     * equalities, so a future change of mind about WHICH non-pass each one is
     * cannot take this guard with it.
     */
    expect(deliveryStatus(true)).not.toBe('PASSED');
    expect(deliveryStatus(false)).not.toBe('PASSED');
  });

  it('FAILS when this plugin fired the trigger and the mail never came', async () => {
    /*
     * The cause happened — we caused it and got a success back — and the effect
     * did not. That is the defect this type exists to catch, and calling it
     * UNKNOWN would make EMAIL a type that can never fail.
     */
    expect(deliveryStatus(true)).toBe('FAILED');
    const spec = makeSpec();
    const trigger = fakeTrigger();
    const execution = await runEmailTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({ mailbox: fakeMailbox([[]]), trigger }),
    );
    expect(trigger.fires).toBe(1);
    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toContain('NOT_DELIVERED');
    expect(execution.errorMessage).toContain('the cause DID happen');
  });

  it('SKIPS when the cause was EXTERNAL and may never have happened', async () => {
    /*
     * jobs.ts's reasoning, applied where it actually holds: we cannot establish
     * the cause, so we are not entitled to a verdict about the effect. A FAILED
     * here would blame the customer's template for a preceding test that never
     * ran.
     */
    expect(deliveryStatus(false)).toBe('SKIPPED');
    const spec = makeSpec({
      trigger: { kind: 'EXTERNAL', target: 'the checkout E2E test' },
    });
    const trigger = fakeTrigger();
    const execution = await runEmailTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({ mailbox: fakeMailbox([[]]), trigger }),
    );
    expect(trigger.fires).toBe(0);
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun).toEqual({ kind: 'NOT_RUN', why: expect.any(String) });
    expect(execution.notRun?.why).toContain('cannot establish that the cause ever happened');
  });

  it('reports the wait that elapsed as a count AND a reason', () => {
    /*
     * Rule 10: a cap that bit must be reported as a count and a reason. Here
     * both the elapsed wait and the budget are the count, and WHO fired the
     * trigger is the reason — because that fact is what decides whether this is
     * a failure at all, and a reader cannot infer it.
     */
    const fired = notDeliveredWhy(
      { kind: 'HTTP_POST', target: '/checkout/complete' },
      5_000,
      5_000,
      6,
    );
    expect(fired).toContain('NOT_DELIVERED');
    expect(fired).toContain('5000ms (6 poll(s))');
    expect(fired).toContain('timeoutSeconds');
    expect(fired).toContain('the cause DID happen');

    const external = notDeliveredWhy({ kind: 'EXTERNAL', target: 'the nightly cron' }, 5_000, 5_000, 6);
    expect(external).toContain('the nightly cron');
    expect(external).toContain('claims nothing about your application');
  });

  it('names every assertion that was never looked at', async () => {
    /*
     * A reader must be able to see that the links and attachments were not
     * checked, because the mail they are properties of does not exist. Leaving
     * them out of the result entirely reads as "they were fine".
     */
    const spec = makeSpec({ assertions: ['SUBJECT', 'LINKS', 'ATTACHMENTS'], links: [{ match: '/orders', expectStatus: 200 }], attachments: [{ filenameContains: 'invoice', contentType: 'application/pdf', minBytes: 8 }] });
    const execution = await runEmailTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({ mailbox: fakeMailbox([[]]) }),
    );
    const notes = execution.console.map((entry) => entry.text).join(' ');
    expect(notes).toContain('3 assertion(s) were NOT measured');
    expect(notes).toContain('LINKS');
    expect(notes).toContain('ATTACHMENTS');
  });

  it('blocks on a trigger that could not even be sent, rather than failing the template', async () => {
    const spec = makeSpec();
    const execution = await runEmailTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({ trigger: fakeTrigger(false), mailbox: fakeMailbox([[]]) }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('BLOCKED_BY_ENV');
    expect(execution.notRun?.why).toContain('never triggered');
  });
});

// ─── The bounded wait ────────────────────────────────────────────────────────

describe('the wait for a mail', () => {
  it('returns ARRIVED with zero elapsed when the mail was already there', async () => {
    const mailbox = fakeMailbox([[mail()]]);
    const clock = fakeClock();
    const result = await waitForMail(
      mailbox,
      { to: 'buyer@example.test', since: '2026-03-04T09:00:00.000Z', templateId: null },
      60_000,
      1_000,
      noSignal,
      clock,
    );
    expect(result.outcome).toBe('ARRIVED');
    expect(result.waitedMs).toBe(0);
    expect(result.polls).toBe(1);
    expect(clock.elapsed()).toBe(0);
  });

  it('never sleeps past the budget, so the printed wait is true', async () => {
    /*
     * A 1000ms interval on a 200ms remainder would report having waited 1200ms
     * against a 200ms budget. The disclosure sentence has to be true about the
     * number it prints or the brake is undiscoverable.
     */
    const clock = fakeClock();
    const result = await waitForMail(
      fakeMailbox([[]]),
      { to: 'buyer@example.test', since: '2026-03-04T09:00:00.000Z', templateId: null },
      1_200,
      1_000,
      noSignal,
      clock,
    );
    expect(result.outcome).toBe(EMAIL_NOT_DELIVERED);
    expect(result.waitedMs).toBe(1_200);
    expect(clock.elapsed()).toBe(1_200);
  });

  it('picks the NEWEST match, not the first the sink hands back', async () => {
    /*
     * A sink that returns oldest-first would otherwise hand back the previous
     * run's receipt — right subject, right sender, WRONG total — and it passes.
     */
    const old = mail({ subject: 'old', receivedAt: '2026-03-04T09:00:00.000Z' });
    const fresh = mail({ subject: 'fresh', receivedAt: '2026-03-04T10:00:00.000Z' });
    const result = await waitForMail(
      fakeMailbox([[old, fresh]]),
      { to: 'buyer@example.test', since: '2026-03-04T08:00:00.000Z', templateId: null },
      1_000,
      100,
      noSignal,
      fakeClock(),
    );
    expect(result.mail?.subject).toBe('fresh');
  });

  it('still returns a message whose timestamp will not parse', async () => {
    // An unparseable timestamp is bad sink metadata, not an undelivered mail.
    const result = await waitForMail(
      fakeMailbox([[mail({ receivedAt: 'not a date' })]]),
      { to: 'buyer@example.test', since: '2026-03-04T08:00:00.000Z', templateId: null },
      1_000,
      100,
      noSignal,
      fakeClock(),
    );
    expect(result.outcome).toBe('ARRIVED');
  });

  it('stops on a cancelled run', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await waitForMail(
      fakeMailbox([[]]),
      { to: 'buyer@example.test', since: '2026-03-04T08:00:00.000Z', templateId: null },
      60_000,
      1_000,
      controller.signal,
      fakeClock(),
    );
    expect(result.outcome).toBe('CANCELLED');
  });

  it('passes the template id through to the sink', async () => {
    const mailbox = fakeMailbox([[mail()]]);
    await waitForMail(
      mailbox,
      { to: 'buyer@example.test', since: '2026-03-04T08:00:00.000Z', templateId: 'receipt.v3' },
      1_000,
      100,
      noSignal,
      fakeClock(),
    );
    expect(mailbox.queries[0]).toBe('buyer@example.test|receipt.v3');
  });
});

// ─── LIE 2: a mail that arrived and could not be checked ─────────────────────

describe('a mail that arrived and could not be checked is not a pass', () => {
  it('SKIPS when every assertion about the delivered mail came back UNKNOWN', async () => {
    const spec = makeSpec({ assertions: ['LOCALE'], expectLocale: 'de-DE' });
    const execution = await runEmailTest(
      makeCtx(),
      makeTest(spec),
      spec,
      // No Content-Language header: LOCALE is UNKNOWN, and that is the only
      // assertion, so nothing about the mail was measured.
      deps({ mailbox: fakeMailbox([[mail({ headers: {} })]]) }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('NOT_RUN');
    expect(execution.notRun?.why).toContain('none of this test');
  });

  it('passes a spec that asks only whether the mail arrived', async () => {
    /*
     * The counter-test to the one above, and a defect it caught: delivery is
     * settled by `waitForMail` and never enters the assertion loop, so a
     * `['DELIVERED']` spec produces an EMPTY results list — and the bare
     * "nothing was measured" rule reported a correctly-delivered mail as
     * SKIPPED. That spec asked one question and got a real answer to it.
     */
    const spec = makeSpec({ assertions: ['DELIVERED'] });
    const execution = await runEmailTest(makeCtx(), makeTest(spec), spec, deps());
    expect(execution.status).toBe('PASSED');
    expect(execution.notRun).toBeUndefined();
    expect(execution.steps.some((step) => step.title.includes('arrived'))).toBe(true);
  });

  it('still refuses to pass a DELIVERED-only spec whose mail never came', async () => {
    const spec = makeSpec({ assertions: ['DELIVERED'] });
    const execution = await runEmailTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({ mailbox: fakeMailbox([[]]) }),
    );
    expect(execution.status).toBe('FAILED');
  });

  it('passes a mixed result and DISCLOSES the count that was not measured', async () => {
    const spec = makeSpec({
      assertions: ['SUBJECT', 'LOCALE'],
      expectLocale: 'de-DE',
    });
    const execution = await runEmailTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({ mailbox: fakeMailbox([[mail({ headers: {} })]]) }),
    );
    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage).toContain('1 of 2 assertion(s) were NOT measured');
    expect(execution.errorMessage).toContain('LOCALE (UNKNOWN)');
  });

  it('refuses to guess a language from body text', async () => {
    const result = await runEmailAssertion(
      'LOCALE',
      makeSpec({ assertions: ['LOCALE'], expectLocale: 'de-DE' }),
      mail({ headers: {}, text: 'Guten Tag Sam, Ihre Summe betrug 42,50 €.' }),
      assertionDeps(),
    );
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.detail).toContain('does not guess a language from body text');
  });

  it('reads a missing attachment body as UNKNOWN, never as a zero-byte invoice', async () => {
    /*
     * Rule 12's second entry: a null that became a 0. MailHog lists attachment
     * metadata and hands the body over on a second request, so `bytes: null` is
     * "not fetched" — and a `minBytes` failure here would report a defect
     * nobody has looked at.
     */
    const result = await runEmailAssertion(
      'ATTACHMENTS',
      makeSpec({
        assertions: ['ATTACHMENTS'],
        attachments: [
          { filenameContains: 'invoice', contentType: 'application/pdf', minBytes: 2_048 },
        ],
      }),
      mail({ attachments: [attachment({ bytes: null, sizeBytes: 12_043 })] }),
      assertionDeps(),
    );
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.detail).toContain('did not hand over the body');
    expect(result.notAsserted?.[0]?.reason).toBe('CAPABILITY_ABSENT');
  });

  it('records an unfollowed unsubscribe link as a stated hole, not as a pass', async () => {
    /*
     * "The link is present" and "the link works" are different claims, and a
     * customer reads a green UNSUBSCRIBE as the second. Following it is a WRITE
     * — it unsubscribes somebody — so it is refused by default and DISCLOSED.
     */
    const probe = fakeProbe();
    const result = await runEmailAssertion(
      'UNSUBSCRIBE',
      makeSpec({ assertions: ['UNSUBSCRIBE'] }),
      mail(),
      assertionDeps(probe),
    );
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.notAsserted?.[0]?.reason).toBe('WOULD_MUTATE_PROTECTED_DATA');
    expect(probe.probed).toEqual([]);
  });

  it('follows the unsubscribe link only when the author says the recipient is disposable', async () => {
    const probe = fakeProbe();
    const result = await runEmailAssertion(
      'UNSUBSCRIBE',
      makeSpec({ assertions: ['UNSUBSCRIBE'], unsubscribe: { mayFollow: true } }),
      mail(),
      assertionDeps(probe),
    );
    expect(result.verdict).toBe('MET');
    expect(probe.probed).toHaveLength(1);
  });

  it('reports links that were found and never followed as UNKNOWN', async () => {
    const result = await runEmailAssertion(
      'LINKS',
      makeSpec({
        assertions: ['LINKS'],
        links: [
          {
            match: '/receipt/view',
            token: { where: 'QUERY', minLength: 24, alphabet: 'BASE64URL' },
          },
        ],
      }),
      mail(),
      assertionDeps(),
    );
    // Token-only expectation: LINK_TOKEN_SHAPE owns it, and LINKS says plainly
    // that it claims nothing about where the link goes.
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.detail).toContain('NONE was followed');
  });

  it('turns an unreachable probe into UNMET with the reason, never a silent pass', async () => {
    const result = await runEmailAssertion(
      'LINKS',
      makeSpec({ assertions: ['LINKS'], links: [{ match: '/orders/931', expectStatus: 200 }] }),
      mail(),
      assertionDeps(
        fakeProbe({
          '/orders/931': { status: null, finalUrl: null, unreachable: 'connection reset' },
        }),
      ),
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('connection reset');
    expect(result.notAsserted?.[0]?.reason).toBe('CAPABILITY_ABSENT');
  });
});

// ─── LIE 3: the token is never the evidence ──────────────────────────────────

describe('a link token never reaches a result', () => {
  const resetMail = mail({
    subject: 'Reset your password',
    text: `Reset here: https://shop.example.com/reset/${RESET_TOKEN}`,
    html: `<a href="https://shop.example.com/reset/${RESET_TOKEN}">Reset your password</a>`,
  });

  it('strips a long path segment, every query value and the whole fragment', () => {
    expect(redactLink(`https://shop.example.com/reset/${RESET_TOKEN}`)).toBe(
      'https://shop.example.com/reset/%E2%80%A6',
    );
    expect(redactLink(`https://shop.example.com/verify?token=${RESET_TOKEN}&utm=digest`)).not.toContain(
      TOKEN_TAIL,
    );
    expect(redactLink(`https://shop.example.com/app#access_token=${RESET_TOKEN}`)).not.toContain(
      TOKEN_TAIL,
    );
    // The route words survive, or a redacted URL is unreadable and nobody can
    // tell which link failed.
    expect(redactLink(`https://shop.example.com/reset/${RESET_TOKEN}`)).toContain('/reset/');
  });

  it('strips a SHORT token in every declared alphabet, not just the all-digit one', () => {
    /*
     * THE DEFECT, measured. The all-digit rule covered DIGITS and left HEX,
     * BASE64URL and MIXED printing verbatim at any length from 4 to 12 — and
     * `linkExpectationSchema` accepts a `minLength` of 6, so a six-character
     * HEX token was a leak reachable from a spec this plugin itself validates.
     * `9f3b1c`, `a1b2c3d4e5` and `a1b2c3d4e5f6` all came back intact.
     *
     * Composed from parts rather than written as literals, per the standing
     * rule about credential-shaped strings in test files.
     */
    const SHORT_TOKENS = ['9f3b1c', '48291374', 'a1b2' + 'c3d4e5', 'a1b2' + 'c3d4e5f6', '482913'];
    for (const token of SHORT_TOKENS) {
      const printed = redactLink(`https://shop.example.com/verify/${token}`);
      expect(printed, `redactLink printed the ${token.length}-character token verbatim`).not.toContain(
        token,
      );
      // The route word still has to survive, or nobody can tell which link failed.
      expect(printed).toContain('/verify/');
    }
  });

  it('strips a HEX token that happens to carry no digit', () => {
    /*
     * THE HALF THE DIGIT RULE LEFT OPEN, measured. The rule above says "a
     * token-shaped run in ANY of the declared alphabets" and keyed on carrying
     * a digit, which is not the same thing: 1 in 16 hex characters is a letter,
     * so a hex token that draws none printed verbatim. `deadbeef`, `abcdef` and
     * `facade` all came back intact while `9f3b1c` was correctly redacted.
     *
     * Composed from parts, per the standing rule about credential-shaped
     * strings in test files.
     */
    const DIGITLESS_HEX = ['dead' + 'beef', 'abc' + 'def', 'fac' + 'ade', 'cafe'];
    for (const token of DIGITLESS_HEX) {
      const printed = redactLink(`https://shop.example.com/verify/${token}`);
      expect(
        printed,
        `redactLink printed the digitless hex token ${token.length} chars long verbatim`,
      ).not.toContain(token);
      expect(printed).toContain('/verify/');
    }
  });

  it('still prints a route word that reaches past the hex alphabet', () => {
    /*
     * The boundary of the rule above, pinned so it cannot quietly widen into
     * "redact every short segment". A segment with a letter past `f` in it is
     * not a hex token and is left alone; the all-letter BASE64URL case
     * (`abcdefgh`) is the gap the module's own comment states and does not
     * pretend to close.
     */
    for (const word of ['digest', 'orders', 'xyz']) {
      expect(redactLink(`https://shop.example.com/${word}/x`)).toContain(`/${word}/`);
    }
  });

  it('keeps the route words that make a redacted URL readable', () => {
    // The counter-test for the rule above: over-redacting every short segment
    // would make every printed link `/…/…/…`, which is the readability
    // MAX_SAFE_SEGMENT_LENGTH was chosen for in the first place.
    for (const word of ['reset', 'verify', 'invoices', 'unsubscribe', 'account', 'v1', 'en', 'us']) {
      expect(redactLink(`https://shop.example.com/${word}/x`)).toContain(`/${word}/`);
    }
  });

  it('strips URL credentials too', () => {
    const redacted = redactLink(`https://user:${RESET_TOKEN}@shop.example.com/x`);
    expect(redacted).not.toContain(TOKEN_TAIL);
  });

  it('reduces a non-http scheme to its scheme, and says so on a non-URL', () => {
    /*
     * THE DEFECT, caught by this test while it was being written: `new URL` on
     * a `mailto:` SUCCEEDS and its path is OPAQUE, so assigning to `pathname`
     * is a silent no-op — the function returned its input verbatim and the
     * redaction looked applied. A custom app scheme is exactly where a mobile
     * reset link lives, so a `shopapp://reset/<token>` would have gone into a
     * step title token and all.
     */
    expect(redactLink('mailto:support@shop.example.com')).toBe('(mailto link, redacted)');
    expect(redactLink(`shopapp://reset/${RESET_TOKEN}`)).toBe('(shopapp link, redacted)');
    expect(redactLink(`shopapp://reset/${RESET_TOKEN}`)).not.toContain(TOKEN_TAIL);
    expect(redactLink('not a url at all')).toBe('(unparseable link)');
  });

  it('keeps the token out of the WHOLE result when the link 404s', async () => {
    /*
     * The sweep is over the serialised execution, not over the step titles: a
     * redaction that covers the title and not the `error.message` is not a
     * redaction, and the error path is exactly where a hurried implementation
     * interpolates the URL it was given.
     */
    const spec = makeSpec({
      assertions: ['LINKS'],
      links: [{ match: '/reset/', expectStatus: 200 }],
    });
    const execution = await runEmailTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({
        mailbox: fakeMailbox([[resetMail]]),
        links: fakeProbe({ '/reset/': { status: 404, finalUrl: null, unreachable: null } }),
      }),
    );
    expect(execution.status).toBe('FAILED');
    expect(allText(execution)).not.toContain(TOKEN_TAIL);
    expect(allText(execution)).not.toContain(RESET_TOKEN);
  });

  it('keeps the token out of the result when the link lands in the wrong place', async () => {
    const spec = makeSpec({
      assertions: ['LINKS'],
      links: [{ match: '/reset/', expectFinalPathPrefix: '/account/password' }],
    });
    const execution = await runEmailTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({
        mailbox: fakeMailbox([[resetMail]]),
        links: fakeProbe({
          '/reset/': {
            status: 200,
            // The real redirect target carries the token forward, which is how
            // it gets into a report through the "where did it land" path.
            finalUrl: `https://shop.example.com/signin?next=/reset/${RESET_TOKEN}`,
            unreachable: null,
          },
        }),
      }),
    );
    expect(execution.status).toBe('FAILED');
    expect(allText(execution)).not.toContain(TOKEN_TAIL);
  });

  it('asserts the token SHAPE and never its value', async () => {
    const spec = makeSpec({
      assertions: ['LINK_TOKEN_SHAPE'],
      links: [
        {
          match: '/reset/',
          token: { where: 'PATH_SEGMENT', minLength: 24, alphabet: 'BASE64URL' },
        },
      ],
    });
    const execution = await runEmailTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({ mailbox: fakeMailbox([[resetMail]]) }),
    );
    expect(execution.status).toBe('PASSED');
    expect(allText(execution)).not.toContain(TOKEN_TAIL);
  });

  it('fails a reset link that carries a token too short to be one', async () => {
    const weak = mail({
      html: '<a href="https://shop.example.com/reset/1234">Reset</a>',
      text: 'https://shop.example.com/reset/1234',
    });
    const result = await runEmailAssertion(
      'LINK_TOKEN_SHAPE',
      makeSpec({
        assertions: ['LINK_TOKEN_SHAPE'],
        links: [
          { match: '/reset/', token: { where: 'PATH_SEGMENT', minLength: 24, alphabet: 'HEX' } },
        ],
      }),
      weak,
      assertionDeps(),
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('4-character token');
  });

  it('fails a link that is supposed to authenticate somebody and carries nothing', async () => {
    const bare = mail({
      html: '<a href="https://shop.example.com/reset">Reset</a>',
      text: 'https://shop.example.com/reset',
    });
    const result = await runEmailAssertion(
      'LINK_TOKEN_SHAPE',
      makeSpec({
        assertions: ['LINK_TOKEN_SHAPE'],
        links: [
          { match: '/reset', token: { where: 'QUERY', minLength: 24, alphabet: 'BASE64URL' } },
        ],
      }),
      bare,
      assertionDeps(),
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('carries no token');
  });

  it('masks every credential shape the catalogue declares out of a body excerpt', () => {
    /*
     * DERIVED from `SECRET_SHAPES`, never a hand-written parallel list — the
     * previous round's hand-written one probed 16 of 27 declared shapes and
     * nobody noticed. An application that mails its own API key is a real
     * defect of theirs; echoing it into an artifact would be ours on top.
     *
     * Each probe is COMPOSED from the prefix plus an obviously-fake tail, so
     * this file contains no complete credential-shaped literal (lesson E).
     */
    const tail = 'XNOTREALXNOTREALXNOTREAL0000';
    expect(SECRET_SHAPES.length).toBeGreaterThan(20);
    for (const shape of SECRET_SHAPES) {
      const probe = `${shape.prefix}${tail}`;
      const masked = safeExcerpt(`Your key is ${probe} — keep it safe.`, 400);
      expect(masked, shape.prefix).not.toContain(tail);
      expect(masked, shape.prefix).toContain('[redacted:');
    }
  });

  it('masks before truncating, so a prefix of a key never survives', () => {
    const tail = 'XNOTREALXNOTREALXNOTREAL0000';
    const probe = `${SECRET_SHAPES[0]?.prefix ?? 'sk_'}${tail}`;
    // A limit that would cut the probe in half if truncation came first.
    const masked = safeExcerpt(`${probe} and then a long tail of ordinary words`, 20);
    expect(masked).not.toContain(tail.slice(0, 8));
  });

  it('leaves ordinary text alone', () => {
    expect(safeExcerpt('Your total was $42.50 on 4 March.')).toBe(
      'Your total was $42.50 on 4 March.',
    );
    expect(safeExcerpt('x'.repeat(300), 10)).toBe(`${'x'.repeat(10)}…`);
  });
});

// ─── Token shapes ────────────────────────────────────────────────────────────

describe('token shapes', () => {
  it('classifies each alphabet at its narrowest', () => {
    expect(classifyAlphabet('123456')).toBe('DIGITS');
    expect(classifyAlphabet('deadbeef')).toBe('HEX');
    expect(classifyAlphabet('abc-DEF_123')).toBe('BASE64URL');
    expect(classifyAlphabet('abc+def/ghi=')).toBe('MIXED');
  });

  it('reads an expectation as "no wider than this", so a numeric code is valid hex', () => {
    /*
     * These sets nest. A spec asking BASE64URL on a six-digit code must not be
     * told "expected BASE64URL, got DIGITS" — that is a false failure on a
     * correct application.
     */
    expect(alphabetSatisfies('DIGITS', 'HEX')).toBe(true);
    expect(alphabetSatisfies('DIGITS', 'BASE64URL')).toBe(true);
    expect(alphabetSatisfies('HEX', 'BASE64URL')).toBe(true);
    expect(alphabetSatisfies('BASE64URL', 'HEX')).toBe(false);
  });

  it('keeps MIXED out of the widening, in both directions', () => {
    /*
     * A token containing `+`, `/` or `=` is classic base64 in a URL, which is a
     * real bug — it breaks on the first client that re-encodes it. Swallowing
     * MIXED into BASE64URL would hide it.
     */
    expect(alphabetSatisfies('MIXED', 'BASE64URL')).toBe(false);
    expect(alphabetSatisfies('BASE64URL', 'MIXED')).toBe(false);
    expect(alphabetSatisfies('MIXED', 'MIXED')).toBe(true);
  });

  it('looks only where the spec said, so an invoice number is never a token', () => {
    /*
     * The heuristic this replaces: "the longest path segment". On
     * `/invoices/INV-2024-000931/download?ref=abc` that describes an invoice
     * number as a credential, passes a minLength check, and reports the
     * reset-token assertion as MET on a link that carries no token at all.
     */
    const url = 'https://shop.example.com/invoices/INV-2024-000931/download?ref=abc';
    expect(describeLinkToken(url, 'PATH_SEGMENT')?.length).toBe('download'.length);
    expect(describeLinkToken(url, 'QUERY')?.param).toBe('ref');
    expect(describeLinkToken(url, 'FRAGMENT')).toBeNull();
  });

  it('picks the longest query value and names the parameter', () => {
    const url = `https://shop.example.com/verify?utm_source=digest&token=${RESET_TOKEN}`;
    const token = describeLinkToken(url, 'QUERY');
    expect(token?.param).toBe('token');
    expect(token?.length).toBe(RESET_TOKEN.length);
  });

  it('reads both the bare and the OAuth-implicit fragment shapes', () => {
    expect(describeLinkToken('https://x.example.com/a#abc-DEF_123456', 'FRAGMENT')?.alphabet).toBe(
      'BASE64URL',
    );
    // `#abcdef123456` is all hex digits, so the narrowest answer is HEX and
    // `alphabetSatisfies` is what makes a BASE64URL expectation accept it.
    expect(describeLinkToken('https://x.example.com/a#abcdef123456', 'FRAGMENT')?.alphabet).toBe(
      'HEX',
    );
    const named = describeLinkToken('https://x.example.com/a#access_token=deadbeef', 'FRAGMENT');
    expect(named?.param).toBe('access_token');
    expect(named?.alphabet).toBe('HEX');
  });

  it('describes no token in a scheme whose path is opaque', () => {
    /*
     * The twin of the redactLink defect above. `mailto:x@y.test` reported an
     * 8-character MIXED "token in its PATH_SEGMENT" — a shape assertion
     * satisfied by an email address.
     */
    for (const place of LINK_TOKEN_PLACES) {
      expect(describeLinkToken('mailto:x@y.test', place), place).toBeNull();
      expect(describeLinkToken('not a url at all', place), place).toBeNull();
      expect(describeLinkToken(`shopapp://reset/${RESET_TOKEN}`, place), place).toBeNull();
    }
  });
});

// ─── Host screening ──────────────────────────────────────────────────────────

describe('a host is screened before a byte goes to it', () => {
  it('refuses a loopback and a link-local literal by name', async () => {
    const loopback = await screenHost('127.0.0.1', fakeLookup());
    expect(loopback.allowed).toBe(false);
    expect(loopback.reason).toContain('loopback');

    const metadata = await screenHost('169.254.169.254', fakeLookup());
    expect(metadata.allowed).toBe(false);
    expect(metadata.reason).toContain('169.254.169.254');
  });

  it('refuses a name that resolves to a private address', async () => {
    const decision = await screenHost('mail.example.com', fakeLookup('10.0.0.5'));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('10.0.0.5');
  });

  it('allows a public name and says it resolved', async () => {
    const decision = await screenHost('mail.example.com', fakeLookup());
    expect(decision.allowed).toBe(true);
    expect(decision.resolved).toBe(true);
  });

  it('DISCLOSES that it did not resolve, rather than reporting a check it skipped', async () => {
    /*
     * Rule 12: a thing reported as measured that was not measured. The static
     * rules cannot tell `mail.internal.corp` from `mail.example.com`, so a
     * decision taken with no resolver must say it did not look.
     */
    const decision = await screenHost('mail.example.com', null);
    expect(decision.allowed).toBe(true);
    expect(decision.resolved).toBe(false);
    expect(decision.reason).toContain('NOT resolved');
  });

  it('blocks the whole test on a private mail sink and measures nothing', async () => {
    const spec = makeSpec({ mailboxUrl: 'http://127.0.0.1:8025/__mail' });
    const execution = await runEmailTest(makeCtx(), makeTest(spec), spec, deps());
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('BLOCKED_BY_ENV');
    expect(execution.notRun?.why).toContain('loopback');
    expect(execution.notRun?.why).toContain('Nothing was measured');
  });

  it('refuses to follow a link to a private host and discloses the hole', async () => {
    const internal = mail({
      html: '<a href="http://10.0.0.9/admin/orders">View your order</a>',
      text: 'http://10.0.0.9/admin/orders',
    });
    const probe = fakeProbe();
    const result = await runEmailAssertion(
      'LINKS',
      makeSpec({ assertions: ['LINKS'], links: [{ match: '/admin/orders', expectStatus: 200 }] }),
      internal,
      assertionDeps(probe, fakeLookup()),
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('refused to follow');
    expect(probe.probed).toEqual([]);
    expect(result.notAsserted?.[0]?.reason).toBe('REQUIRES_PROVISIONED_SANDBOX');
  });

  it('notes the unresolved mail sink on the result rather than staying quiet', async () => {
    const spec = makeSpec();
    const execution = await runEmailTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({ lookup: null }),
    );
    expect(execution.status).toBe('PASSED');
    expect(execution.console.map((entry) => entry.text).join(' ')).toContain('NOT resolved');
  });
});

// ─── The ten assertions: each one fails when it should ───────────────────────

describe('every assertion has a branch, and every branch can fail', () => {
  it('keeps the presence record, the list and the zod enum one set', () => {
    expect(Object.keys(EMAIL_ASSERTION_PRESENCE).sort()).toEqual([...EMAIL_ASSERTIONS].sort());
    expect([...emailAssertionSchema.options].sort()).toEqual([...EMAIL_ASSERTIONS].sort());
    for (const assertion of EMAIL_ASSERTIONS) {
      expect(EMAIL_ASSERTION_LABELS[assertion], assertion).toBeTruthy();
    }
    expect([...EMAIL_TRIGGER_KIND_LIST].sort()).toEqual([...EMAIL_TRIGGER_KINDS].sort());
    expect([...LINK_TOKEN_PLACE_LIST].sort()).toEqual([...LINK_TOKEN_PLACES].sort());
    expect([...LINK_TOKEN_ALPHABET_LIST].sort()).toEqual([...LINK_TOKEN_ALPHABETS].sort());
  });

  it('gives every assertion a branch that reaches a verdict', async () => {
    /*
     * The failure the parity guards cannot catch: a member the schema accepts
     * and `runEmailAssertion` silently falls through. A fall-through returns
     * undefined here.
     */
    const spec = makeSpec({
      assertions: EMAIL_ASSERTIONS.filter((a) => a !== 'DELIVERED'),
      expectSubject: 'Your receipt',
      expectFrom: 'receipts@',
      expectValues: ['$42.50'],
      links: [
        { match: '/orders/931', expectStatus: 200 },
        {
          match: '/receipt/view',
          expectStatus: 200,
          token: { where: 'QUERY', minLength: 24, alphabet: 'BASE64URL' },
        },
      ],
      attachments: [
        { filenameContains: 'invoice', contentType: 'application/pdf', minBytes: 8 },
      ],
      unsubscribe: { mayFollow: true },
      expectLocale: 'en-GB',
    });
    for (const assertion of EMAIL_ASSERTIONS) {
      if (assertion === 'DELIVERED') continue;
      const result = await runEmailAssertion(
        assertion,
        spec,
        mail({ attachments: [attachment()] }),
        assertionDeps(),
      );
      expect(result, assertion).toBeDefined();
      expect(result.assertion, assertion).toBe(assertion);
      expect(['MET', 'UNMET', 'UNKNOWN', 'UNAVAILABLE'], assertion).toContain(result.verdict);
      expect(result.verdict, assertion).toBe('MET');
    }
  });

  it('fails a receipt whose total is the pre-discount one', async () => {
    const result = await runEmailAssertion(
      'BODY_VALUES',
      makeSpec({ assertions: ['BODY_VALUES'], expectValues: ['$38.25', 'Sam'] }),
      mail(),
      assertionDeps(),
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('1 of 2 named value(s)');
    expect(result.detail).toContain('$38.25');
  });

  it('fails a wrong subject and names what it actually said', async () => {
    const result = await runEmailAssertion(
      'SUBJECT',
      makeSpec({ assertions: ['SUBJECT'], expectSubject: 'Your refund' }),
      mail(),
      assertionDeps(),
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('Your receipt from Shop');
  });

  it('fails an absent reply-to and explains what that costs a reader', async () => {
    const result = await runEmailAssertion(
      'SENDER',
      makeSpec({ assertions: ['SENDER'], expectReplyTo: 'support@' }),
      mail({ replyTo: null }),
      assertionDeps(),
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('no-reply');
  });

  it('fails a link that 404s', async () => {
    const result = await runEmailAssertion(
      'LINKS',
      makeSpec({ assertions: ['LINKS'], links: [{ match: '/orders/931', expectStatus: 200 }] }),
      mail(),
      assertionDeps(fakeProbe({ '/orders': { status: 404, finalUrl: null, unreachable: null } })),
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('answered 404');
  });

  it('fails a link that resolves and lands in the wrong place', async () => {
    const result = await runEmailAssertion(
      'LINKS',
      makeSpec({
        assertions: ['LINKS'],
        links: [{ match: '/orders/931', expectFinalPathPrefix: '/orders' }],
      }),
      mail(),
      assertionDeps(
        fakeProbe({
          '/orders': {
            status: 200,
            finalUrl: 'https://shop.example.com/signin',
            unreachable: null,
          },
        }),
      ),
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('landed on "/signin"');
  });

  it('fails a zero-byte invoice', async () => {
    const result = await runEmailAssertion(
      'ATTACHMENTS',
      makeSpec({
        assertions: ['ATTACHMENTS'],
        attachments: [
          { filenameContains: 'invoice', contentType: 'application/pdf', minBytes: 1_024 },
        ],
      }),
      mail({
        attachments: [attachment({ bytes: new Uint8Array(0), sizeBytes: 0 })],
      }),
      assertionDeps(),
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('0 byte(s)');
  });

  it('fails a file that is not what its header says it is', async () => {
    const result = await runEmailAssertion(
      'ATTACHMENTS',
      makeSpec({
        assertions: ['ATTACHMENTS'],
        attachments: [
          { filenameContains: 'invoice', contentType: 'application/pdf', minBytes: 4 },
        ],
      }),
      mail({
        attachments: [
          attachment({
            // An HTML error page saved as the invoice — a real failure mode of
            // every server-side PDF renderer.
            bytes: new Uint8Array([0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45]),
            sizeBytes: 9,
          }),
        ],
      }),
      assertionDeps(),
    );
    // No magic number matches, so the sniffer stays silent rather than guessing.
    expect(result.verdict).toBe('MET');

    const wrongType = await runEmailAssertion(
      'ATTACHMENTS',
      makeSpec({
        assertions: ['ATTACHMENTS'],
        attachments: [{ filenameContains: 'invoice', contentType: 'application/pdf', minBytes: 4 }],
      }),
      mail({
        attachments: [
          attachment({
            bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]),
            sizeBytes: 5,
          }),
        ],
      }),
      assertionDeps(),
    );
    expect(wrongType.verdict).toBe('UNMET');
    expect(wrongType.detail).toContain('not what the header says');
  });

  it('fails an attachment whose declared size and real size disagree', async () => {
    const result = await runEmailAssertion(
      'ATTACHMENTS',
      makeSpec({
        assertions: ['ATTACHMENTS'],
        attachments: [{ filenameContains: 'invoice', contentType: 'application/pdf', minBytes: 4 }],
      }),
      mail({ attachments: [attachment({ sizeBytes: 12_043 })] }),
      assertionDeps(),
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('declares 12043 byte(s) and carries 8');
  });

  it('says NULL is not a recognised type rather than a wrong one', () => {
    expect(sniffContentType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe('application/pdf');
    expect(sniffContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    // A CSV has no magic number and must not be reported as a type mismatch.
    expect(sniffContentType(new Uint8Array([0x6e, 0x61, 0x6d, 0x65]))).toBeNull();
    expect(sniffContentType(new Uint8Array([0x25]))).toBeNull();
  });

  it('fails a mail with no unsubscribe at all', async () => {
    const result = await runEmailAssertion(
      'UNSUBSCRIBE',
      makeSpec({ assertions: ['UNSUBSCRIBE'] }),
      mail({ headers: {}, html: '<p>no links here</p>', text: 'no links here' }),
      assertionDeps(),
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('neither a List-Unsubscribe header nor a link');
  });

  it('fails an unsubscribe link that 404s, which is the one link legally required to work', async () => {
    const result = await runEmailAssertion(
      'UNSUBSCRIBE',
      makeSpec({ assertions: ['UNSUBSCRIBE'], unsubscribe: { mayFollow: true } }),
      mail(),
      assertionDeps(
        fakeProbe({ unsubscribe: { status: 404, finalUrl: null, unreachable: null } }),
      ),
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('legally required');
  });

  it('fails the German customer who got the English receipt', async () => {
    const result = await runEmailAssertion(
      'LOCALE',
      makeSpec({ assertions: ['LOCALE'], expectLocale: 'de-DE' }),
      mail(),
      assertionDeps(),
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('en-GB');
  });

  it('accepts a region variant of the expected language', async () => {
    const result = await runEmailAssertion(
      'LOCALE',
      makeSpec({ assertions: ['LOCALE'], expectLocale: 'en' }),
      mail({ headers: { 'content-language': 'EN_gb' } }),
      assertionDeps(),
    );
    expect(result.verdict).toBe('MET');
  });

  it('fails the Hi {{firstName}} that went out to 40,000 people', async () => {
    const result = await runEmailAssertion(
      'NO_PLACEHOLDERS',
      makeSpec({ assertions: ['NO_PLACEHOLDERS'] }),
      mail({ text: 'Hi {{firstName}}, your total was undefined.' }),
      assertionDeps(),
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('Somebody received this');
    expect(result.detail).toContain('{{');
    expect(result.detail).toContain('undefined');
  });

  it('scans the subject as well as the body for placeholders', async () => {
    const result = await runEmailAssertion(
      'NO_PLACEHOLDERS',
      makeSpec({ assertions: ['NO_PLACEHOLDERS'] }),
      mail({ subject: 'Your receipt from ${BRAND_NAME}' }),
      assertionDeps(),
    );
    expect(result.verdict).toBe('UNMET');
  });

  it('ships a marker set that covers every engine in use', () => {
    for (const marker of ['{{', '${', 'undefined', 'Lorem']) {
      expect(DEFAULT_PLACEHOLDER_MARKERS, marker).toContain(marker);
    }
  });
});

// ─── Link extraction ─────────────────────────────────────────────────────────

describe('link extraction', () => {
  it('takes the href and the anchor text out of the HTML part', () => {
    const links = extractLinks(mail());
    expect(links[0]?.href).toBe('https://shop.example.com/orders/931');
    expect(links[0]?.text).toBe('View your order');
  });

  it('keeps the HTML occurrence, so the anchor text survives a bare duplicate', () => {
    /*
     * The same URL usually appears once as a button and once as a bare
     * fallback. Deduplicating to the TEXT one would lose the anchor text that
     * `match` is written against, and probing both would double a write.
     */
    const links = extractLinks(mail());
    const orders = links.filter((l) => l.href.includes('/orders/931'));
    expect(orders).toHaveLength(1);
    expect(orders[0]?.text).toBe('View your order');
  });

  it('finds a bare URL in a text-only mail', () => {
    const links = extractLinks(mail({ html: null }));
    expect(links.map((l) => l.href)).toEqual(['https://shop.example.com/orders/931']);
  });

  it('matches on the href or on the anchor text', () => {
    const links = extractLinks(mail());
    expect(findLink(links, 'view your order')?.href).toContain('/orders/931');
    expect(findLink(links, '/orders/931')?.text).toBe('View your order');
    expect(findLink(links, 'nothing like this')).toBeNull();
  });

  it('finds the unsubscribe link in several languages and the header', () => {
    const found = findUnsubscribe(mail());
    expect(found.viaHeader).toContain('https://shop.example.com/u/abc');
    expect(found.link?.href).toContain('/mail/unsubscribe');

    const german = findUnsubscribe(
      mail({
        headers: {},
        html: '<a href="https://shop.example.com/x">Abmelden</a>',
        text: '',
      }),
    );
    expect(german.link?.href).toContain('/x');
  });

  it('strips nested tags out of the anchor text', () => {
    const links = extractLinks(
      mail({ html: '<a href="https://x.example.com/a"><span>View</span> <b>order</b></a>' }),
    );
    expect(links[0]?.text).toBe('View order');
  });
});

// ─── validate() ──────────────────────────────────────────────────────────────

describe('an incomplete spec is refused before the trigger fires', () => {
  it('names every missing field at once, not the first', () => {
    const spec = emailTestSpecSchema.parse({
      recipient: 'buyer@example.test',
      mailboxUrl: '/__mail',
      trigger: { kind: 'EXTERNAL', target: 'the checkout test' },
      assertions: ['SUBJECT', 'SENDER', 'BODY_VALUES', 'LINKS', 'LOCALE'],
    });
    const missing = missingEmailFields(spec);
    expect(missing).toHaveLength(5);
    expect(missing.join(' ')).toContain('expectSubject');
    expect(missing.join(' ')).toContain('expectValues');
    expect(missing.join(' ')).toContain('expectLocale');
  });

  it('refuses LINK_TOKEN_SHAPE with no link carrying a token', () => {
    const spec = emailTestSpecSchema.parse({
      recipient: 'buyer@example.test',
      mailboxUrl: '/__mail',
      trigger: { kind: 'EXTERNAL', target: 'x' },
      assertions: ['LINK_TOKEN_SHAPE'],
      links: [{ match: '/reset', expectStatus: 200 }],
    });
    expect(missingEmailFields(spec).join(' ')).toContain('carrying a `token`');
  });

  it('throws from validate() rather than waiting for a run', () => {
    expect(() =>
      emailPlugin.validate(
        makeTest({
          recipient: 'buyer@example.test',
          mailboxUrl: '/__mail',
          trigger: { kind: 'EXTERNAL', target: 'x' },
          assertions: ['SUBJECT'],
        }),
      ),
    ).toThrow(/expectSubject/);
  });

  it('refuses a link expectation that asserts nothing', () => {
    expect(() =>
      emailTestSpecSchema.parse({
        recipient: 'buyer@example.test',
        mailboxUrl: '/__mail',
        trigger: { kind: 'EXTERNAL', target: 'x' },
        assertions: ['LINKS'],
        links: [{ match: '/reset' }],
      }),
    ).toThrow(/asserts nothing beyond the link existing/);
  });

  it('refuses a minBytes of zero, which asserts nothing while looking like a size check', () => {
    expect(() =>
      emailTestSpecSchema.parse({
        recipient: 'buyer@example.test',
        mailboxUrl: '/__mail',
        trigger: { kind: 'EXTERNAL', target: 'x' },
        assertions: ['ATTACHMENTS'],
        attachments: [
          { filenameContains: 'invoice', contentType: 'application/pdf', minBytes: 0 },
        ],
      }),
    ).toThrow();
  });

  it('accepts a complete spec', () => {
    expect(() => emailPlugin.validate(makeTest(makeSpec()))).not.toThrow();
  });
});

// ─── The unavailable adapters, which are the production default ──────────────

describe('the default surfaces refuse rather than fake an answer', () => {
  it('rejects a mailbox read rather than returning an empty inbox', async () => {
    /*
     * An empty list means "the sink holds nothing yet", so a stub returning one
     * would drive every EMAIL test to NOT_DELIVERED — and with a fired trigger
     * that is FAILED, which is QAAI reporting a defect in the customer's
     * template on the strength of its own missing adapter.
     */
    await expect(
      unavailableMailbox.list({ to: 'x@y.test', since: '2026-01-01T00:00:00.000Z', templateId: null }),
    ).rejects.toThrow(/No mail-sink adapter is configured/);
  });

  it('answers a probe with null and a reason, never with 200', async () => {
    const result = await unavailableLinkProbe.probe('https://x.example.com/a');
    expect(result.status).toBeNull();
    expect(result.unreachable).toContain('not "the links work"');
  });

  it('refuses to fire, so a non-delivery is never blamed on the template', async () => {
    const fired = await unavailableMailTrigger.fire(
      { kind: 'HTTP_POST', target: '/x' },
      'https://shop.example.com',
    );
    expect(fired.fired).toBe(false);
    expect(fired.detail).toContain('EXTERNAL trigger');
  });

  it('runs a whole test through the defaults as BLOCKED_BY_ENV', async () => {
    const previous = setEmailDeps({
      mailbox: unavailableMailbox,
      links: unavailableLinkProbe,
      trigger: unavailableMailTrigger,
      lookup: null,
    });
    try {
      const execution = await emailPlugin.execute(makeCtx(), makeTest(makeSpec()));
      expect(execution.status).toBe('SKIPPED');
      expect(execution.notRun?.kind).toBe('BLOCKED_BY_ENV');
    } finally {
      setEmailDeps(previous);
    }
  });

  it('turns a throwing sink into BLOCKED_BY_ENV, not a failed template', async () => {
    const spec = makeSpec();
    const execution = await runEmailTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({
        mailbox: {
          list: () => Promise.reject(new Error('the sink hung up')),
        },
      }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('BLOCKED_BY_ENV');
    expect(execution.notRun?.why).toContain('the sink hung up');
  });

  it('gives the real clock a usable now() and a sleep that resolves', async () => {
    expect(realMailClock.now()).toBeGreaterThan(0);
    await expect(realMailClock.sleep(1, noSignal)).resolves.toBeUndefined();
  });

  it('stops sleeping when the run is aborted', async () => {
    const controller = new AbortController();
    const pending = realMailClock.sleep(60_000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });
});

// ─── The result shape ───────────────────────────────────────────────────────

describe('the result shape', () => {
  it('blocks when no recipient is resolvable from a secret or the spec', async () => {
    const spec = emailTestSpecSchema.parse({
      mailboxUrl: 'https://mail.example.com/__mail',
      trigger: { kind: 'EXTERNAL', target: 'x' },
      assertions: ['SUBJECT'],
      expectSubject: 'x',
    });
    const execution = await runEmailTest(makeCtx(), makeTest(spec), spec, deps());
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('BLOCKED_BY_ENV');
    expect(execution.notRun?.why).toContain('QAAI_TEST_EMAIL');
  });

  it('prefers the secret over the literal in the spec', async () => {
    const spec = makeSpec({ recipientSecretName: 'MAIL_TO', recipient: 'ignored@example.test' });
    const mailbox = fakeMailbox([[mail()]]);
    const ctx = makeCtx();
    await runEmailTest(
      { ...ctx, secrets: { MAIL_TO: 'real@example.test' } },
      makeTest(spec),
      spec,
      deps({ mailbox }),
    );
    expect(mailbox.queries[0]).toContain('real@example.test');
  });

  it('puts an error on a FAILED step and nothing on a SKIPPED one', async () => {
    const spec = makeSpec({
      assertions: ['SUBJECT', 'LOCALE'],
      expectSubject: 'Your refund',
      expectLocale: 'de-DE',
    });
    const execution = await runEmailTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({ mailbox: fakeMailbox([[mail({ headers: {} })]]) }),
    );
    const failed = execution.steps.find((step) => step.status === 'FAILED');
    const skippedStep = execution.steps.find((step) => step.status === 'SKIPPED');
    expect(failed?.error?.message).toBeTruthy();
    expect(skippedStep?.error).toBeNull();
  });

  it('logs the delivery step and one step per assertion', async () => {
    const ctx = makeCtx();
    const spec = makeSpec({ assertions: ['SUBJECT', 'NO_PLACEHOLDERS'] });
    await runEmailTest(ctx, makeTest(spec), spec, deps());
    // Fired-trigger step, arrival step, then one per assertion.
    expect(ctx.logged).toHaveLength(4);
    expect(ctx.logged.filter((line) => line.startsWith('PASSED'))).toHaveLength(4);
  });

  it('carries the spec’s own declared holes onto the result', async () => {
    const spec = makeSpec({
      notAsserted: [
        { assertion: 'that the invoice PDF renders in Outlook', reason: 'CAPABILITY_ABSENT' },
      ],
    });
    const execution = await runEmailTest(makeCtx(), makeTest(spec), spec, deps());
    expect(execution.status).toBe('PASSED');
    expect(execution.console.map((entry) => entry.text).join(' ')).toContain(
      'NOT ASSERTED (CAPABILITY_ABSENT): that the invoice PDF renders in Outlook',
    );
  });

  it('resolves a relative mailbox URL against the environment base URL', async () => {
    const spec = makeSpec({ mailboxUrl: '/__mail' });
    const execution = await runEmailTest(makeCtx(), makeTest(spec), spec, deps());
    // shop.example.com is public, so the run proceeds rather than blocking.
    expect(execution.status).toBe('PASSED');
  });

  it('stops at a cancelled run without claiming a pass', async () => {
    const controller = new AbortController();
    controller.abort();
    const spec = makeSpec();
    const execution = await runEmailTest(
      makeCtx(controller.signal),
      makeTest(spec),
      spec,
      deps({ mailbox: fakeMailbox([[mail()]]) }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.why).toContain('cancelled');
  });

  it('turns a thrown assertion surface into UNAVAILABLE, not a failed mail', async () => {
    const spec = makeSpec({
      assertions: ['SUBJECT', 'LINKS'],
      links: [{ match: '/orders/931', expectStatus: 200 }],
    });
    const execution = await runEmailTest(
      makeCtx(),
      makeTest(spec),
      spec,
      deps({
        links: {
          probe: () => Promise.reject(new Error('the probe exploded')),
        },
      }),
    );
    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage).toContain('LINKS (UNAVAILABLE)');
  });
});
