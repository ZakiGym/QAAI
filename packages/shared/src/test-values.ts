/**
 * The third-party test-value catalogue (§2) — the published values that make a
 * gated flow testable at all.
 *
 * THE DEFECT THIS FIXES: the Explorer's plan prompt holds the sentence
 * `"skipped payments — no test card"` as its model of a *good* skip. It is a
 * good skip only if no test card exists, and for every payment provider a
 * buyer actually uses, one does and is published. So the first flow every buyer
 * names — "does checkout work" — was the one flow QAAI structurally refused to
 * cover, and it refused it politely, in a sentence that read like diligence.
 *
 * ─── Why this is data and not a constant ─────────────────────────────────────
 *
 * A bare `const STRIPE_SUCCESS = '4242…'` would have fixed the symptom and left
 * the real hazard. A card number is a value that CANNOT be sanity-checked by
 * the person reading the test: 4000000000000002 and 4000000000000127 differ by
 * two characters and mean "declined" and "wrong CVC", and a test built on the
 * wrong one fails with a message that describes neither. So every entry here
 * carries what it is for, what the app is supposed to DO with it, whether it
 * only works in test mode, and — the part that matters — how much we actually
 * know about it.
 *
 * ─── Honesty, concretely ─────────────────────────────────────────────────────
 *
 * `verified: true` means this module (or a test in this repo) can demonstrate
 * the claim right now, with no network: either the value's own arithmetic
 * proves it (a Luhn check) or the value is independently corroborated inside
 * this repository. Nothing else is marked verified, because nothing else was
 * fetched — there is no network call on this path by design.
 *
 * A number recalled slightly wrong is WORSE than an absent one: the absent one
 * leaves a visible gap, and the wrong one produces a red test whose failure
 * message is about the provider's API and not about the application. So the
 * rule applied while writing this file was: if the digits were not certain, the
 * entry was left out, and `OMITTED_FOR_LACK_OF_CONFIDENCE` below says which and
 * why. That list is part of the catalogue, not a footnote to it.
 */

// ─── Luhn, so a card number can check itself ─────────────────────────────────

/**
 * The Luhn (mod-10) checksum every card number in circulation satisfies.
 *
 * Here for two reasons. First, it is the one claim about a card number this
 * module can actually PROVE, which is what lets a handful of entries below say
 * `verified: true` honestly. Second, "Luhn-invalid" is an equivalence class a
 * payment form must reject client-side, and generating that case needs this
 * function (flip one digit of a valid number and the checksum fails).
 *
 * Spaces and dashes are ignored; anything else makes it false rather than
 * throwing, because the caller is often handing us a user-typed string.
 */
export function isLuhnValid(cardNumber: string): boolean {
  const digits = cardNumber.replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(digits)) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Turns a valid card number into one that fails the checksum, deterministically.
 *
 * Bumps the last digit by 1 (mod 10), which always breaks mod-10 by exactly 1 —
 * so the result is guaranteed invalid, guaranteed the same length, and still
 * guaranteed to look like a card number to a form that only checks the shape.
 * That combination is what makes it a useful negative case: it tests the
 * checksum, not the length validator.
 */
export function luhnBreak(cardNumber: string): string {
  const digits = cardNumber.replace(/[\s-]/g, '');
  if (digits.length === 0) return digits;
  const lastIndex = digits.length - 1;
  const last = digits.charCodeAt(lastIndex) - 48;
  return `${digits.slice(0, lastIndex)}${(last + 1) % 10}`;
}

// ─── Shape ───────────────────────────────────────────────────────────────────

export const TEST_VALUE_PROVIDERS = [
  'stripe',
  'adyen',
  'braintree',
  'paypal',
  'square',
  'twilio',
  'rfc', // Standards-reserved values: the ones nobody can revoke.
  'local', // Sinks you run yourself in compose.
] as const;
export type TestValueProvider = (typeof TEST_VALUE_PROVIDERS)[number];

export const TEST_VALUE_KINDS = [
  'card',
  'card-cvc',
  'card-expiry',
  'email-pattern',
  'phone',
  /**
   * Not a value at all: a note that this provider has NO fixed test value and
   * what you must do instead. Present on purpose — "there is no test card for
   * PayPal, you provision a sandbox buyer" is a far more useful thing to carry
   * than silence, which reads identically to "nobody looked".
   */
  'no-fixed-value',
] as const;
export type TestValueKind = (typeof TEST_VALUE_KINDS)[number];

/** What a payment test value is supposed to make happen. */
export const PAYMENT_OUTCOMES = [
  'success',
  'declined-generic',
  'declined-insufficient-funds',
  'declined-expired-card',
  'declined-incorrect-cvc',
  'declined-processing-error',
  'requires-3ds',
  'invalid-number', // Rejected client-side, before any network call.
] as const;
export type PaymentOutcome = (typeof PAYMENT_OUTCOMES)[number];

/**
 * How much this repo actually knows about an entry. Deliberately not a number:
 * a 0–1 "confidence" invites averaging, and these are three different KINDS of
 * knowledge, not three points on one scale.
 */
export const TEST_VALUE_EVIDENCE = [
  /** The value's own arithmetic proves the claim. A colocated test runs it. */
  'computed-here',
  /** The same value appears elsewhere in this repository, independently. */
  'corroborated-in-repo',
  /**
   * From a provider's or a regulator's public documentation, recalled rather
   * than fetched — this module makes no network call. Treat as "very likely
   * right, and the first thing to check if a test fails for an inexplicable
   * reason".
   */
  'published-recalled',
  /** A property of a standard (RFC/regulator allocation), not of a vendor. */
  'standards-reserved',
  /**
   * The VALUE is safe by standard but the BEHAVIOUR depends on infrastructure
   * this module cannot see — a mail sink that may or may not be running, on a
   * port only the compose file knows.
   *
   * This kind exists because the catalogue's own test caught the muddle: the
   * local mail-sink entry was claiming `standards-reserved` on the strength of
   * its reserved domain while the useful half of the claim — that a sink is
   * there to read the message out of — was pure assumption. Two different
   * confidences in one entry is exactly the dishonesty the evidence field is
   * for, so the weaker one wins and gets its own name.
   */
  'environment-dependent',
] as const;
export type TestValueEvidence = (typeof TEST_VALUE_EVIDENCE)[number];

export interface TestValueEntry {
  /** Stable id, safe to reference from a generated test's comment. */
  id: string;
  provider: TestValueProvider;
  kind: TestValueKind;
  /** The value itself; null only for `kind: 'no-fixed-value'`. */
  value: string | null;
  /** What it is for, in the words a test name would use. */
  purpose: string;
  /** The outcome it forces, for the payment kinds. */
  outcome?: PaymentOutcome;
  /** What the application under test should DO. This is the assertion. */
  expected: string;
  /**
   * True when the value only behaves this way against the provider's test
   * credentials. Every such entry is a landmine in a production environment:
   * against live keys it is either a hard decline or, worse, a real charge
   * attempt on a real BIN.
   */
  testModeOnly: boolean;
  /** See the honesty note at the top of this file. */
  verified: boolean;
  evidence: TestValueEvidence;
  /** Where it came from and how to confirm it. Always populated. */
  sourceNote: string;
}

// ─── Stripe ──────────────────────────────────────────────────────────────────

/**
 * The 4242 card is the only payment value in this file that is independently
 * corroborated without leaving the repo: `apps/demo/src/views.ts` uses
 * "4242 4242 4242 4242" as the checkout placeholder, written by someone else,
 * at a different time, for a different reason. Two sources is not proof, but it
 * is one more than recall.
 */
const STRIPE: TestValueEntry[] = [
  {
    id: 'stripe.card.success.visa',
    provider: 'stripe',
    kind: 'card',
    value: '4242424242424242',
    outcome: 'success',
    purpose: 'The happy path: a Visa that always succeeds in test mode.',
    expected:
      'The payment succeeds, the order/subscription is created, and the success state reflects the real amount — not merely that a success page rendered.',
    testModeOnly: true,
    verified: true,
    evidence: 'corroborated-in-repo',
    sourceNote:
      "Stripe's canonical test Visa. Corroborated in this repo by the checkout placeholder in apps/demo/src/views.ts, and Luhn-valid (asserted in test-values.test.ts).",
  },
  {
    id: 'stripe.card.declined.generic',
    provider: 'stripe',
    kind: 'card',
    value: '4000000000000002',
    outcome: 'declined-generic',
    purpose: 'A generic decline — the most common real-world failure.',
    expected:
      'The charge is refused with decline_code "generic_decline", NOTHING is fulfilled, and the user is shown a message they can act on. Re-reading the order afterwards shows no order.',
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    sourceNote:
      "Stripe's published generic-decline test card. Luhn-valid (asserted), but the DECLINE REASON is recalled from Stripe's docs rather than fetched; if a test on this card fails oddly, check the card against docs.stripe.com/testing first.",
  },
  {
    id: 'stripe.card.declined.insufficient-funds',
    provider: 'stripe',
    kind: 'card',
    value: '4000000000009995',
    outcome: 'declined-insufficient-funds',
    purpose: 'Decline with a reason the UI usually special-cases.',
    expected:
      'The charge is refused with decline_code "insufficient_funds" and the message distinguishes it from a generic decline — this is the case a retry prompt is for.',
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    sourceNote: "Stripe's published insufficient-funds test card. Luhn-valid (asserted).",
  },
  {
    id: 'stripe.card.declined.expired',
    provider: 'stripe',
    kind: 'card',
    value: '4000000000000069',
    outcome: 'declined-expired-card',
    purpose: 'A card the processor reports as expired.',
    expected:
      'decline_code "expired_card". Worth its own test because many forms validate the expiry field client-side and then never handle the processor saying the same thing.',
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    sourceNote: "Stripe's published expired-card test card. Luhn-valid (asserted).",
  },
  {
    id: 'stripe.card.declined.incorrect-cvc',
    provider: 'stripe',
    kind: 'card',
    value: '4000000000000127',
    outcome: 'declined-incorrect-cvc',
    purpose: 'CVC check failure, whatever CVC is typed.',
    expected:
      'decline_code "incorrect_cvc", and the error is attached to the CVC field rather than shown as a generic banner.',
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    sourceNote: "Stripe's published incorrect-CVC test card. Luhn-valid (asserted).",
  },
  {
    id: 'stripe.card.declined.processing-error',
    provider: 'stripe',
    kind: 'card',
    value: '4000000000000119',
    outcome: 'declined-processing-error',
    purpose: 'A processing error rather than a decision — the retryable class.',
    expected:
      'decline_code "processing_error". The app should treat it as transient (retryable) and must NOT mark the order failed-permanently or double-charge on retry.',
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    sourceNote: "Stripe's published processing-error test card. Luhn-valid (asserted).",
  },
  {
    id: 'stripe.card.3ds.required',
    provider: 'stripe',
    kind: 'card',
    value: '4000002500003155',
    outcome: 'requires-3ds',
    purpose: 'Forces a 3D Secure authentication step.',
    expected:
      'The flow pauses on an authentication challenge; the payment completes only after it is passed, and abandoning the challenge leaves the order uncreated rather than half-created. This is the single most under-tested payment path in any checkout.',
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    sourceNote:
      "Stripe's published 'authentication required' test card. Luhn-valid (asserted). Stripe publishes several 3DS cards with different trigger conditions (on-setup vs every-payment); only this one is carried here, and the others are in OMITTED_FOR_LACK_OF_CONFIDENCE.",
  },
  {
    id: 'stripe.card.invalid.luhn',
    provider: 'stripe',
    kind: 'card',
    value: '4242424242424241',
    outcome: 'invalid-number',
    purpose: 'A number that fails the mod-10 checksum.',
    expected:
      'Rejected in the browser, BEFORE any network call: no request to the payment provider, no spinner that resolves into a server error. If this reaches the server, client-side card validation is not wired up.',
    testModeOnly: false,
    verified: true,
    evidence: 'computed-here',
    sourceNote:
      'The success card with its check digit bumped by one. Verified by arithmetic in this module — isLuhnValid() returns false for it, asserted in test-values.test.ts — so this entry does not depend on recall at all.',
  },
  {
    id: 'stripe.cvc.any',
    provider: 'stripe',
    kind: 'card-cvc',
    value: '123',
    purpose: 'A CVC to pair with any Stripe test card.',
    expected: 'Accepted. Stripe test mode does not check the CVC value except via 4000…0127.',
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    sourceNote:
      "Stripe test mode accepts any 3-digit CVC (4 for Amex). '123' is a convention, not a magic value.",
  },
  {
    id: 'stripe.expiry.future',
    provider: 'stripe',
    kind: 'card-expiry',
    value: '12/34',
    purpose: 'An expiry to pair with any Stripe test card.',
    expected: 'Accepted — Stripe test mode takes any future expiry date.',
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    sourceNote:
      'Any future date works; 12/34 is the convention. NOTE THE EXPIRY ON THIS ENTRY ITSELF: it stops being a future date in 2035, at which point every payment test built on it fails for a reason that has nothing to do with the application. See SYNTHETIC_CLOCK in synthetic.ts, which is the single place that date is derived.',
  },
];

// ─── Other payment providers ─────────────────────────────────────────────────

const OTHER_PAYMENTS: TestValueEntry[] = [
  {
    id: 'adyen.card.success.visa',
    provider: 'adyen',
    kind: 'card',
    value: '4111111111111111',
    outcome: 'success',
    purpose: 'Adyen test Visa — the authorised path.',
    expected: 'Authorised. resultCode "Authorised" and the order is created.',
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    sourceNote:
      'The classic 4111…1111 Visa test number, which Adyen publishes along with most other gateways. Luhn-valid (asserted). Adyen pairs it with a specific CVC convention, which is carried separately below because I am less sure of it than of the number.',
  },
  {
    id: 'adyen.cvc.visa',
    provider: 'adyen',
    kind: 'card-cvc',
    value: '737',
    purpose: 'The CVC Adyen test cards expect for Visa/Mastercard.',
    expected: 'Accepted alongside an Adyen test card.',
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    sourceNote:
      "Adyen's test cards use a fixed CVC rather than any-3-digits, and I recall it as 737 for Visa/Mastercard. CONFIRM THIS ONE before building a suite on it — unlike a card number, a wrong CVC fails in a way that looks like a CVC-validation bug in the application.",
  },
  {
    id: 'braintree.card.success.visa',
    provider: 'braintree',
    kind: 'card',
    value: '4111111111111111',
    outcome: 'success',
    purpose: 'Braintree sandbox Visa — settles successfully.',
    expected: 'Transaction submitted for settlement; the order is created.',
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    sourceNote:
      'Braintree sandbox publishes 4111…1111 as a successful Visa. Luhn-valid (asserted). Braintree ALSO triggers failures by transaction AMOUNT rather than by card, which is a different mechanism from Stripe and is noted in OMITTED_FOR_LACK_OF_CONFIDENCE because I am not certain of the amounts.',
  },
  {
    id: 'square.card.success.visa',
    provider: 'square',
    kind: 'card',
    value: '4111111111111111',
    outcome: 'success',
    purpose: 'Square sandbox Visa — the approved path.',
    expected: 'Payment APPROVED/COMPLETED and the order is created.',
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    sourceNote:
      "Square's sandbox documents 4111…1111 as a successful Visa. Luhn-valid (asserted). Square's decline triggers are CVV- and postal-code-based rather than card-based; those specific trigger values are omitted — see OMITTED_FOR_LACK_OF_CONFIDENCE.",
  },
  {
    id: 'paypal.sandbox.no-fixed-card',
    provider: 'paypal',
    kind: 'no-fixed-value',
    value: null,
    purpose: 'PayPal sandbox has no universal test card number.',
    expected:
      'A PayPal checkout test is driven by a SANDBOX BUYER ACCOUNT created in the PayPal developer dashboard, not by a magic card number — so the test needs a credential in the environment, and that is a setup prerequisite the plan should state rather than a value this catalogue can supply.',
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    sourceNote:
      'Carried deliberately as a non-value. PayPal sandbox generates card numbers per sandbox account rather than publishing fixed ones, so any number quoted here would be wrong for the reader. The honest output for a PayPal flow is "needs a sandbox buyer credential", not "skipped — no test card".',
  },
];

// ─── Mail sinks ──────────────────────────────────────────────────────────────

/**
 * Reserved domains first, on purpose.
 *
 * A signup test needs an address that (a) is unique per run and (b) cannot
 * possibly reach a human. RFC-reserved names are the only ones where (b) is
 * guaranteed by a standard rather than by a company's continued goodwill, so
 * they are the default the synthetic factory uses.
 */
const MAIL: TestValueEntry[] = [
  {
    id: 'rfc.email.example-domain',
    provider: 'rfc',
    kind: 'email-pattern',
    value: '<local>@example.com',
    purpose: 'The default synthetic address: reserved, undeliverable, unmistakable.',
    expected:
      'The app accepts it as a syntactically valid address. Nothing is ever delivered — this is the point. Use it whenever the test does not need to READ the mail.',
    testModeOnly: false,
    verified: true,
    evidence: 'standards-reserved',
    sourceNote:
      'example.com / .net / .org are reserved by RFC 2606 for documentation and cannot be registered, so no address there can reach anyone. Verified in the sense that it is a property of the standard, not of a vendor.',
  },
  {
    id: 'rfc.email.invalid-tld',
    provider: 'rfc',
    kind: 'email-pattern',
    value: '<local>@qa.invalid',
    purpose: 'An address that is syntactically valid but can never resolve.',
    expected:
      'Accepted by a correct syntax validator and then permanently undeliverable. Use it to test BOUNCE handling: an app that queues mail to .invalid should record a hard failure, not retry forever.',
    testModeOnly: false,
    verified: true,
    evidence: 'standards-reserved',
    sourceNote: '.invalid is reserved by RFC 2606 and guaranteed never to resolve.',
  },
  {
    id: 'rfc.email.subaddress',
    provider: 'rfc',
    kind: 'email-pattern',
    value: '<mailbox>+<run-token>@<domain>',
    purpose: 'One real mailbox, a unique address per run.',
    expected:
      'Treated as the SAME mailbox by the mail server and as a DIFFERENT address by the application — which is exactly the uniqueness a repeatable signup test needs. It is also a negative case in its own right: an app that rejects a "+" in an email address is rejecting valid addresses.',
    testModeOnly: false,
    verified: true,
    evidence: 'standards-reserved',
    sourceNote:
      'Sub-addressing is specified in RFC 5233 and supported by every major provider. Verified as a standard; whether a given self-hosted mail server honours it is not something this module can know.',
  },
  {
    id: 'local.email.mailpit-sink',
    provider: 'local',
    kind: 'email-pattern',
    value: '<local>@sink.test',
    purpose: 'A mailbox the test can actually READ, with nothing leaving the machine.',
    expected:
      'Delivered to a local catch-all SMTP sink (Mailpit / MailHog / Inbucket in compose), where a test can fetch the message and assert on the link inside it. This is the only honest way to test a verification-email or password-reset flow end to end.',
    testModeOnly: false,
    verified: false,
    evidence: 'environment-dependent',
    sourceNote:
      ".test is RFC 6761-reserved, so the DOMAIN is safe by standard. The SINK is not: whether one is running, and on which HTTP port its API is exposed, is a property of this project's compose file and not something this catalogue can assert. Check it before writing a test that reads mail.",
  },
];

// ─── Phone sinks ─────────────────────────────────────────────────────────────

const PHONE: TestValueEntry[] = [
  {
    id: 'rfc.phone.na-fictional',
    provider: 'rfc',
    kind: 'phone',
    value: '+1 555 555 0142',
    purpose: 'A North American number reserved for fiction.',
    expected:
      'Accepted by a correct validator (it is a well-formed NANP number) and incapable of reaching anyone. The 555-0100 to 555-0199 range inside any area code is held back for fictional use.',
    testModeOnly: false,
    verified: true,
    evidence: 'standards-reserved',
    sourceNote:
      'The 555-01XX fictional range is a NANPA allocation, not a vendor convention — which is why it is the safe default, on the same footing as RFC 2606 rather than on the footing of a recalled docs page. The specific area code is arbitrary; only the 555-01XX line number carries the guarantee.',
  },
  {
    id: 'rfc.phone.uk-drama-mobile',
    provider: 'rfc',
    kind: 'phone',
    value: '+44 7700 900142',
    purpose: 'A UK mobile number reserved for drama.',
    expected:
      'Accepted as a valid UK mobile and never connected. Use this rather than a made-up 07… number, which may well belong to somebody.',
    testModeOnly: false,
    verified: false,
    evidence: 'published-recalled',
    sourceNote:
      'Ofcom reserves 07700 900000–900999 for drama use. Unlike the NANP entry above, this is a specific numeric range recalled out of a regulator document rather than a rule of the form "this whole TLD is reserved", so it is not marked verified. The allocation is long-standing and stable.',
  },
  {
    id: 'twilio.phone.magic.valid',
    provider: 'twilio',
    kind: 'phone',
    value: '+15005550006',
    purpose: 'Twilio magic number: a number that passes validation and sends nothing.',
    expected:
      'With Twilio TEST credentials the API returns success and no message is sent. Use it to prove the send path is wired without sending.',
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    sourceNote:
      "Twilio's published magic number for a valid 'from'. Works ONLY with the test Account SID/Auth Token; against live credentials it is just an unroutable number and the call fails differently.",
  },
  {
    id: 'twilio.phone.magic.invalid',
    provider: 'twilio',
    kind: 'phone',
    value: '+15005550001',
    purpose: 'Twilio magic number that forces an "invalid number" error.',
    expected:
      'The API returns error 21211 (invalid "To" number). The app should surface a field-level error, not a 500 — the negative half of a phone-verification flow.',
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    sourceNote:
      "Twilio's published magic number for an invalid phone number. Test credentials only.",
  },
];

/** The whole catalogue, in one array. */
export const TEST_VALUES: readonly TestValueEntry[] = [
  ...STRIPE,
  ...OTHER_PAYMENTS,
  ...MAIL,
  ...PHONE,
];

/**
 * What was LEFT OUT, and why — printed by the catalogue's own reporter so the
 * absence is visible rather than inferred.
 *
 * This list exists because of the failure mode described at the top of the
 * file: a plausible-but-wrong card number costs more than a missing one. A
 * reader who needs one of these now knows (a) that it exists, (b) that QAAI
 * does not vouch for the digits, and (c) exactly which page to open. That is
 * strictly more useful than a confident guess and strictly more useful than
 * silence.
 */
export const OMITTED_FOR_LACK_OF_CONFIDENCE: ReadonlyArray<{
  provider: TestValueProvider;
  what: string;
  why: string;
}> = [
  {
    provider: 'stripe',
    what: "Stripe's other 3DS test cards (the 'authenticate on every payment' and '3DS authentication fails' variants)",
    why: "Several exist with different trigger conditions and I could not separate the digits from each other with confidence. Only the one 'authentication required' card is carried. Get the rest from Stripe's testing page.",
  },
  {
    provider: 'stripe',
    what: 'Non-Visa brand test cards (Mastercard, Amex, Discover, JCB, UnionPay) and the non-US-issuer cards',
    why: "Stripe publishes a card per brand and per issuing country, and brand/country matters for exactly one real question — international-card fee handling. Guessing a BIN would answer that question wrongly. 5555…4444 for Mastercard is the one I am fairly sure of, and it is still omitted: 'fairly sure' is the confidence level this list exists to refuse.",
  },
  {
    provider: 'braintree',
    what: "Braintree's amount-triggered failure values (the transaction amounts that force processor-declined and gateway-rejected) and its specific decline card numbers",
    why: 'Braintree forces failures by AMOUNT as well as by card, which is a mechanism Stripe does not have, and I do not know the exact amounts. A wrong amount silently succeeds — the worst possible failure for a negative test, because the test goes green while proving nothing.',
  },
  {
    provider: 'square',
    what: "Square sandbox's CVV and postal-code decline triggers",
    why: 'Square forces CVV_FAILURE and ADDRESS_VERIFICATION_FAILURE via specific CVV and postal-code values rather than specific cards. I recall the shape of the mechanism but not the values, and a wrong CVV here is indistinguishable from a real CVV-handling bug in the application under test.',
  },
  {
    provider: 'adyen',
    what: "Adyen's refusal-reason test cards and its non-Visa brand cards",
    why: 'Adyen publishes a matrix of cards per brand and per refusal reason. The Visa success number is widely shared across gateways and safe to carry; the refusal-specific numbers are not ones I can reproduce digit for digit.',
  },
  {
    provider: 'paypal',
    what: 'Any PayPal sandbox card number',
    why: 'Not an omission for lack of confidence so much as a fact about PayPal: sandbox cards are generated per sandbox account. Carried as an explicit no-fixed-value entry instead.',
  },
  {
    provider: 'local',
    what: "The HTTP port and API shape of this project's mail sink",
    why: 'Mailpit, MailHog and Inbucket all commonly listen on 8025 and all expose different APIs. A test that polls the wrong one fails for an infrastructure reason, so the catalogue names the need and declines to name the port.',
  },
];

// ─── Lookups ─────────────────────────────────────────────────────────────────

export function testValuesForProvider(provider: TestValueProvider): TestValueEntry[] {
  return TEST_VALUES.filter((v) => v.provider === provider);
}

export function testValuesOfKind(kind: TestValueKind): TestValueEntry[] {
  return TEST_VALUES.filter((v) => v.kind === kind);
}

/**
 * The card for an outcome, preferring the provider asked for and falling back
 * to Stripe.
 *
 * The fallback is not laziness: a crawl can see a card field and have no idea
 * which processor is behind it, and "here is a number that is right for Stripe,
 * and it says so" is a better answer than null. Callers that know the provider
 * pass it; callers that do not get a value whose `sourceNote` names the
 * assumption, which is what makes the assumption auditable.
 */
export function cardForOutcome(
  outcome: PaymentOutcome,
  provider: TestValueProvider = 'stripe',
): TestValueEntry | null {
  return (
    TEST_VALUES.find(
      (v) => v.kind === 'card' && v.outcome === outcome && v.provider === provider,
    ) ??
    TEST_VALUES.find(
      (v) => v.kind === 'card' && v.outcome === outcome && v.provider === 'stripe',
    ) ??
    null
  );
}

/**
 * One paragraph a human can read before trusting any of this.
 *
 * Deliberately leads with what is NOT verified and ends with the omissions,
 * because a catalogue that opens with its coverage number is a catalogue that
 * gets trusted further than it has earned.
 */
export function describeTestValueConfidence(): string {
  const total = TEST_VALUES.length;
  const verified = TEST_VALUES.filter((v) => v.verified).length;
  const recalled = TEST_VALUES.filter((v) => v.evidence === 'published-recalled').length;
  return [
    `${total} test values. ${verified} are verified without a network call (Luhn arithmetic, or corroborated elsewhere in this repo); ${recalled} are recalled from provider documentation and NOT fetched.`,
    `A recalled card number is very likely right and is still the first thing to check when a payment test fails for a reason that makes no sense.`,
    `${OMITTED_FOR_LACK_OF_CONFIDENCE.length} groups of values were deliberately left out rather than guessed; see OMITTED_FOR_LACK_OF_CONFIDENCE for what and why.`,
  ].join(' ');
}
