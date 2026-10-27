/**
 * The third-party provider catalogue — the published values that make a GATED
 * flow testable, and the structural guarantee that none of them is a secret.
 *
 * THE DEFECT THIS FIXES, in two halves.
 *
 * FIRST HALF — `test-values.ts` solved cards and sinks and stopped there. It
 * carries Stripe's full outcome set, a handful of other gateways, RFC mail
 * domains and reserved phone ranges. What it has no vocabulary for is the rest
 * of the gated surface a buyer actually asks about: SEPA direct debit (an
 * IBAN), tax-id validation (a VAT number), "log in with Google" (a sandbox
 * OAuth user), and the bot defence sitting in front of the signup form. Each of
 * those turns into the same polite refusal the Explorer already prints for
 * payments — `"skipped payments — no test card"` — which reads like diligence
 * and is a coverage hole with a sentence in front of it.
 *
 * SECOND HALF — and the reason this is a separate module rather than more rows
 * in `test-values.ts`: the moment a catalogue carries OAuth users and bot-
 * protection keys, it is one careless field away from being a credential store.
 * `TestValueEntry.value` is a bare `string`, so nothing stops a well-meaning
 * contributor pasting `sk_live_…` into it and committing it. That field is
 * fine for a card number; it is not fine for the shape of data this module
 * carries. So the entry type here CANNOT hold a raw string at all —
 * {@link PublishedTestValue} is branded with a module-private symbol and
 * {@link admitPublishedValue} is the only way to obtain one.
 *
 * ─── What this module refuses to do ──────────────────────────────────────────
 *
 * It does not carry a secret, and it has no field one could occupy. A published
 * test IBAN and a CAPTCHA site key are both public BY CONSTRUCTION — the site
 * key ships in the customer's own HTML — and that is exactly what makes them
 * publishable here. Anything that is genuinely secret, including the paired
 * CAPTCHA *secret* key and every sandbox OAuth password, is carried as a
 * REQUIREMENT with a remedy and never as a value. Those live on an
 * `AuthProfile` row referencing `Secret.name`, which is the pattern the schema
 * already has.
 *
 * It carries NO CARD NUMBERS, and that absence is structural rather than
 * editorial: {@link CATALOGUE_VALUE_KINDS} has no card kind, so there is no
 * entry shape a card could be filed under. The reason is that a REAL card
 * number and a TEST card number are indistinguishable by shape — both are
 * sixteen Luhn-valid digits — so no admission function can tell them apart, and
 * a module that invited card numbers would be a module whose safety rested
 * entirely on contributors being careful. Cards stay in `test-values.ts`, where
 * the set is closed, every entry is a provider's published number, and nothing
 * new is minted at run time.
 *
 * It does not defeat a bot defence. The only entries here are the providers'
 * OWN documented test keys, which exist so that a customer can test their own
 * form. When a customer has not configured one, the honest output is
 * `UNREACHABLE_BEHIND_BOT_PROTECTION` plus the remedy — never a workaround.
 *
 * It makes no network call, and it reads nothing from `process.env`. Both are
 * asserted by this module's own test rather than promised here, because a
 * doc comment that contradicts the code under it is one of the lies this
 * product cannot afford.
 *
 * ─── Honesty, concretely ─────────────────────────────────────────────────────
 *
 * The evidence vocabulary is `test-values.ts`'s, imported rather than reinvented,
 * so a reader comparing a card against an IBAN is comparing like with like. The
 * one claim this module can PROVE without a network call is the arithmetic:
 * {@link ibanChecksumValid} is ISO 7064 MOD-97-10, and an IBAN that satisfies
 * it is `computed-here` for its SHAPE. Which sandbox honours it is
 * `published-recalled` and says so. A mis-recalled digit fails mod-97 with
 * probability 96/97, so the arithmetic is a real check on the recall and not a
 * decoration — which is the same bargain `isLuhnValid` strikes for cards.
 */

import type { TestValueEvidence, TestValueProvider } from './test-values';

// ─── MOD-97, so an IBAN can check itself ─────────────────────────────────────

/**
 * ISO 7064 MOD-97-10, the checksum every IBAN in circulation satisfies.
 *
 * Here for the same two reasons `isLuhnValid` is in `test-values.ts`. First, it
 * is the one claim about an IBAN this module can prove, which is what lets the
 * entries below say anything stronger than "I remember it this way". Second,
 * "checksum-invalid IBAN" is an equivalence class a bank-details form must
 * reject before it ever reaches a payment provider, and generating that case
 * needs this function.
 *
 * Returns the remainder, which is 1 for a valid IBAN, or `null` when the input
 * is not IBAN-shaped at all. Null rather than a throw because the caller is
 * usually holding a user-typed string, and rather than `false` because a
 * malformed IBAN and a wrong-checksum IBAN are two different findings: the
 * first is a format error the form should catch, the second is a transposed
 * digit that only arithmetic catches.
 */
export function ibanMod97(iban: string): number | null {
  const compact = iban.replace(/[\s-]/g, '').toUpperCase();
  // Country code, two check digits, then 10-30 of the national BBAN. The BBAN
  // is alphanumeric on purpose: French and Maltese IBANs contain letters, and a
  // digits-only validator is a bug this class of test exists to find.
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(compact)) return null;

  // Move the first four characters to the end, map A-Z to 10-35, then take the
  // whole thing mod 97. Done digit by digit because the number is far wider
  // than Number.MAX_SAFE_INTEGER and a BigInt here would be a dependency on
  // bigint literals for no gain.
  const rearranged = `${compact.slice(4)}${compact.slice(0, 4)}`;
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const chunk = code >= 65 ? String(code - 55) : ch;
    for (const digit of chunk) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder;
}

/** True only for an IBAN-shaped string whose MOD-97-10 remainder is 1. */
export function ibanChecksumValid(iban: string): boolean {
  return ibanMod97(iban) === 1;
}

/**
 * Turns a valid IBAN into one that fails the checksum, deterministically.
 *
 * The result is the same length and the same country, so a test built on it
 * exercises the CHECKSUM rather than the length validator or the country-code
 * lookup.
 *
 * ─── WHY IT VERIFIES INSTEAD OF ASSUMING, AND THE BUG THAT TAUGHT IT ────────
 *
 * The first version of this function transposed the last two characters and
 * returned. A transposition is the right mutation — it is the error a human
 * actually makes typing bank details, and MOD-97-10 exists to catch it — but
 * the catalogue's own succeeding IBAN ends `…013000`, and transposing two
 * identical characters is a no-op. So it returned a string that was still
 * perfectly valid, labelled "invalid", and a negative test built on it would
 * have asserted that the form rejects a GOOD IBAN: green, and proving the
 * opposite of what it claimed. Its doc comment even predicted the case and
 * told the caller to check — which is the shape of a defect this codebase keeps
 * finding, a correct comment above an unusable function.
 *
 * So this now CHECKS. It walks candidate mutations in a fixed order and returns
 * the first one whose MOD-97-10 remainder is not 1:
 *
 *   1. adjacent transpositions, from the end of the string backwards — the
 *      realistic human error, preferred for that reason;
 *   2. failing all of those, bumping each digit by one mod 10, which changes
 *      the remainder by a non-multiple of 97 and so cannot fail to break it.
 *
 * Deterministic: no randomness, no clock, and the same input gives the same
 * output forever. Returns the compacted input unchanged only when it is too
 * short to mutate at all, and the caller should still assert invalidity — not
 * because this function is unsure, but because an assertion is how the next
 * person finds out if somebody weakens it.
 */
export function ibanBreak(iban: string): string {
  const compact = iban.replace(/[\s-]/g, '').toUpperCase();
  if (compact.length < 6) return compact;

  const broken = (candidate: string): boolean => ibanMod97(candidate) !== 1;

  // 1. Adjacent transposition, scanning backwards so the mutation lands in the
  //    account number rather than in the country code.
  for (let i = compact.length - 1; i > 0; i--) {
    const a = compact[i - 1]!;
    const b = compact[i]!;
    if (a === b) continue;
    const candidate = `${compact.slice(0, i - 1)}${b}${a}${compact.slice(i + 1)}`;
    if (broken(candidate)) return candidate;
  }

  // 2. Bump a digit. Changing one digit at weight 10^k alters the value by
  //    d*10^k for some 1 <= |d| <= 9, and gcd(97, 10) = 1, so the remainder
  //    always moves — this arm cannot return a still-valid IBAN.
  for (let i = compact.length - 1; i >= 4; i--) {
    const ch = compact[i]!;
    if (ch < '0' || ch > '9') continue;
    const bumped = String((Number(ch) + 1) % 10);
    const candidate = `${compact.slice(0, i)}${bumped}${compact.slice(i + 1)}`;
    if (broken(candidate)) return candidate;
  }

  return compact;
}

// ─── The brand: why this catalogue cannot hold a secret ──────────────────────

/**
 * The witness. A real runtime symbol, module-private, never exported — which is
 * the whole mechanism: no other module can name this key, so the only way to
 * hold a {@link PublishedTestValue} is to have been given one by
 * {@link admitPublishedValue}, which refuses anything secret-shaped.
 *
 * `const … : unique symbol = Symbol(…)` and NOT `declare const`, for the reason
 * `principals.ts` records against its own witness: `declare` typechecks and has
 * no runtime value, so the object literal carrying the brand throws
 * `ReferenceError` on the first call while `tsc --noEmit` stays clean.
 */
const PUBLISHED_VALUE_WITNESS: unique symbol = Symbol('qaai.provider-catalogue.published');

/**
 * A value this module has admitted as publishable. THE type every catalogue
 * entry's value field has.
 *
 * A bare `string` is not assignable to it, so there is no expression that puts
 * `sk_live_51H…` into a catalogue entry — not in this file, not in a
 * contributor's addition, not in a route handler that builds one from a request
 * body. That is what "structural" means here: the guarantee does not depend on
 * anybody remembering to call a validator, because the type cannot be
 * constructed without one.
 */
export interface PublishedTestValue {
  readonly [PUBLISHED_VALUE_WITNESS]: true;
  /** The published value itself, safe to print, log and commit. */
  readonly published: string;
}

/**
 * Why a string may not enter the catalogue. Every member is a sentence the
 * refusal prints, because a contributor who is told "rejected" and not why will
 * work around the guard.
 */
export const CATALOGUE_REFUSAL_REASONS = [
  /** Matched a known live-credential shape. See {@link SECRET_SHAPES}. */
  'SECRET_SHAPED',
  /** Long, high-entropy and unstructured — the shape of a key, not of a test value. */
  'OPAQUE_HIGH_ENTROPY',
  /** Empty or whitespace. A value nobody can use, recorded rather than stored. */
  'EMPTY',
  /** Longer than any published test value legitimately is. */
  'TOO_LONG',
] as const;
export type CatalogueRefusalReason = (typeof CATALOGUE_REFUSAL_REASONS)[number];

/** Compile-time half of the parity guard; the run-time half is in the test. */
const CATALOGUE_REFUSAL_PRESENT: Record<CatalogueRefusalReason, true> = {
  SECRET_SHAPED: true,
  OPAQUE_HIGH_ENTROPY: true,
  EMPTY: true,
  TOO_LONG: true,
};

/** Derived, never hand-listed. */
export const CATALOGUE_REFUSAL_REASON_LIST = Object.keys(
  CATALOGUE_REFUSAL_PRESENT,
) as ReadonlyArray<CatalogueRefusalReason>;

/**
 * No published test value is longer than this. The longest real one is a
 * 34-character IBAN; the cap is generous and still far below the length of a
 * JWT or a PEM block, which is the point.
 */
const MAX_PUBLISHED_VALUE_LENGTH = 120;

/**
 * Live-credential prefixes, with the provider each belongs to.
 *
 * ─── WHAT THIS LIST IS, AND WHAT IT IS NOT ──────────────────────────────────
 *
 * It is a list of shapes that are DEFINITELY a credential. It is NOT a general
 * secret detector, and saying so here matters more than the list: a guard that
 * is described as catching secrets gets trusted to catch all of them, and then
 * the one it misses is committed on the strength of a green check. The
 * structural guarantee is the brand — a value cannot reach an entry without
 * passing through the admission — and this list is the part of the admission
 * that can name WHY.
 *
 * `pk_live_` and `pk_test_` are deliberately ABSENT. A Stripe publishable key
 * ships in the customer's own HTML; it is public by design, exactly like a
 * CAPTCHA site key, and refusing it would make the admission reject the kind of
 * value this catalogue exists to carry.
 */
export const SECRET_SHAPES: ReadonlyArray<{
  prefix: string;
  what: string;
}> = [
  { prefix: 'sk_live_', what: 'a Stripe live secret key' },
  { prefix: 'sk_test_', what: 'a Stripe test secret key — still a credential, still not ours' },
  { prefix: 'rk_live_', what: 'a Stripe live restricted key' },
  { prefix: 'rk_test_', what: 'a Stripe test restricted key' },
  { prefix: 'whsec_', what: 'a Stripe webhook signing secret' },
  { prefix: 'AKIA', what: 'an AWS access key id' },
  { prefix: 'ASIA', what: 'an AWS temporary access key id' },
  { prefix: 'ghp_', what: 'a GitHub personal access token' },
  { prefix: 'gho_', what: 'a GitHub OAuth token' },
  { prefix: 'ghu_', what: 'a GitHub user-to-server token' },
  { prefix: 'ghs_', what: 'a GitHub server-to-server token' },
  { prefix: 'ghr_', what: 'a GitHub refresh token' },
  { prefix: 'github_pat_', what: 'a GitHub fine-grained personal access token' },
  { prefix: 'xoxb-', what: 'a Slack bot token' },
  { prefix: 'xoxp-', what: 'a Slack user token' },
  { prefix: 'xapp-', what: 'a Slack app-level token' },
  { prefix: 'glpat-', what: 'a GitLab personal access token' },
  { prefix: 'npm_', what: 'an npm access token' },
  { prefix: 'AIza', what: 'a Google API key' },
  { prefix: 'ya29.', what: 'a Google OAuth access token' },
  { prefix: 'sq0csp-', what: 'a Square application secret' },
  { prefix: 'sq0atp-', what: 'a Square access token' },
  { prefix: 'EAAA', what: 'a Square OAuth access token' },
  { prefix: 'SG.', what: 'a SendGrid API key' },
  { prefix: 'eyJ', what: 'a JWT — base64url of `{"`, so a bearer token or an id token' },
  { prefix: '-----BEGIN', what: 'a PEM block: a private key or a certificate' },
];

/**
 * Admission. The ONE way to obtain a {@link PublishedTestValue}, and a
 * refusal — a value, not a throw — for everything it will not admit.
 *
 * A refusal is returned rather than thrown so that a write path can RECORD it:
 * "this entry was refused and why" is a line in a report, where an exception is
 * a 500 and a stack trace. That is the same choice `proveDisposable` makes, for
 * the same reason.
 */
export type CatalogueAdmission =
  | { readonly admitted: true; readonly value: PublishedTestValue }
  | {
      readonly admitted: false;
      readonly reason: CatalogueRefusalReason;
      /** What matched, in a form safe to print: never the input itself. */
      readonly detail: string;
    };

/**
 * Is this string admissible as a published test value?
 *
 * ─── THE INPUT IS NEVER ECHOED ──────────────────────────────────────────────
 *
 * `detail` names the SHAPE that matched and never quotes the input, not even
 * truncated. A refusal message containing the first eight characters of a live
 * key puts `sk_live_` plus entropy into a log, and a log is the one place a
 * leaked credential is guaranteed to be retained. So the refusal says "a Stripe
 * live secret key" and the caller already has the value if it needs it.
 */
export function admitPublishedValue(candidate: string): CatalogueAdmission {
  if (candidate.trim().length === 0) {
    return {
      admitted: false,
      reason: 'EMPTY',
      detail: 'the value is empty or whitespace, so no test could use it',
    };
  }
  if (candidate.length > MAX_PUBLISHED_VALUE_LENGTH) {
    return {
      admitted: false,
      reason: 'TOO_LONG',
      detail: `${candidate.length} characters, over the ${MAX_PUBLISHED_VALUE_LENGTH}-character ceiling — the longest legitimate published value is a 34-character IBAN`,
    };
  }

  for (const shape of SECRET_SHAPES) {
    if (candidate.startsWith(shape.prefix)) {
      return {
        admitted: false,
        reason: 'SECRET_SHAPED',
        detail: `starts with the prefix of ${shape.what}; a credential belongs on an AuthProfile row referencing Secret.name, never in a catalogue`,
      };
    }
  }

  if (looksOpaque(candidate)) {
    return {
      admitted: false,
      reason: 'OPAQUE_HIGH_ENTROPY',
      detail:
        'long, mixed-case and unstructured — the shape of a generated key rather than of a published test value, which is always either formatted (an IBAN, a card) or a readable convention',
    };
  }

  return {
    admitted: true,
    value: { [PUBLISHED_VALUE_WITNESS]: true, published: candidate },
  };
}

/**
 * The catch-all behind the prefix list: a long run of mixed-case alphanumerics
 * with no structure.
 *
 * ─── WHY 32, AND WHY BOTH CASES ─────────────────────────────────────────────
 *
 * Every published test value this module carries is either FORMATTED (an IBAN
 * has a country code and check digits; a card is digits; a Turnstile key is a
 * run of zeros) or a READABLE CONVENTION (`<local>@example.com`). None of them
 * is 32+ characters of unstructured mixed case, and essentially every generated
 * credential is. The threshold is the point where the two populations stop
 * overlapping — a 30-character single-case token still gets through, which is
 * why the prefix list exists and why this function's name says "looks".
 *
 * Deliberately requires BOTH cases: a 34-character uppercase IBAN and a
 * 19-digit card number must not trip it, and both would under a pure length
 * rule.
 */
function looksOpaque(candidate: string): boolean {
  if (candidate.length < 32) return false;
  if (!/^[A-Za-z0-9_\-.]+$/.test(candidate)) return false;
  const hasLower = /[a-z]/.test(candidate);
  const hasUpper = /[A-Z]/.test(candidate);
  const hasDigit = /[0-9]/.test(candidate);
  if (!(hasLower && hasUpper && hasDigit)) return false;
  // A long run of one repeated character is a test key, not a credential:
  // Turnstile's are a 1, twenty zeros and two letters.
  const distinct = new Set(candidate).size;
  return distinct > 12;
}

/**
 * The published value, or `null` when the string was refused.
 *
 * The convenience form for the entry tables below, where a refusal is a
 * PROGRAMMING ERROR rather than a runtime condition — every literal in this
 * file is a value I have already decided is publishable. The catalogue's own
 * test asserts that no entry's value is null, so a contributor who adds a
 * secret-shaped literal gets a red test naming the entry rather than a silent
 * `null` in the data.
 */
function published(candidate: string): PublishedTestValue | null {
  const admission = admitPublishedValue(candidate);
  return admission.admitted ? admission.value : null;
}

// ─── Shape ───────────────────────────────────────────────────────────────────

/**
 * Who published the value.
 *
 * SEPARATE from `test-values.ts`'s `TestValueProvider` and joined to it by
 * {@link CatalogueEntry.linkedTestValueProvider} rather than replacing it. Two
 * reasons: that union is a closed vocabulary with a parity guard and a zod
 * schema already validating customer writes against it, and the publishers this
 * module needs — a standards registry, the European Commission, two CAPTCHA
 * vendors — are not payment providers and would make a union called
 * `TestValueProvider` mean something else. The join is what keeps them one
 * catalogue instead of two.
 */
export const CATALOGUE_PUBLISHERS = [
  'stripe',
  'adyen',
  'paypal',
  /** The SWIFT-maintained IBAN registry: the source of the per-country formats. */
  'iban-registry',
  /** The European Commission's VIES VAT-validation service, including its test endpoint. */
  'ec-vies',
  'google',
  'cloudflare',
  'auth0',
  'okta',
  /** Standards-reserved values nobody can revoke. Mirrors test-values.ts's `rfc`. */
  'rfc',
] as const;
export type CataloguePublisher = (typeof CATALOGUE_PUBLISHERS)[number];

/** Compile-time half of the parity guard. */
const CATALOGUE_PUBLISHER_PRESENT: Record<CataloguePublisher, true> = {
  stripe: true,
  adyen: true,
  paypal: true,
  'iban-registry': true,
  'ec-vies': true,
  google: true,
  cloudflare: true,
  auth0: true,
  okta: true,
  rfc: true,
};

/** Derived, never hand-listed. */
export const CATALOGUE_PUBLISHER_LIST = Object.keys(
  CATALOGUE_PUBLISHER_PRESENT,
) as ReadonlyArray<CataloguePublisher>;

/**
 * What kind of gate the value gets a test through.
 *
 * Named after the GATE rather than after the data type, because that is the
 * question a plan asks: "can this flow be driven at all?" `bank-account` and
 * `tax-id` are two different gates even though both are strings with checksums.
 */
export const CATALOGUE_VALUE_KINDS = [
  /** An IBAN for a SEPA direct-debit or bank-transfer flow. */
  'bank-account',
  /** A VAT or other tax identifier, for a billing-address or invoicing flow. */
  'tax-id',
  /** A sandbox identity for a third-party sign-in flow. */
  'oauth-sandbox-user',
  /** A bot-defence site key whose documented behaviour is deterministic. */
  'bot-protection-test-key',
  /**
   * Not a value: a gate that CANNOT be passed with a published value, and what
   * the customer must provision instead.
   *
   * The most important kind, and the one that makes this catalogue honest. "No
   * published value exists for a PayPal sandbox buyer, you provision one in the
   * developer dashboard" is a far more useful thing to carry than silence —
   * silence reads identically to "nobody looked". Copied deliberately from
   * `test-values.ts`'s `no-fixed-value`.
   */
  'requires-provisioning',
] as const;
export type CatalogueValueKind = (typeof CATALOGUE_VALUE_KINDS)[number];

/** Compile-time half of the parity guard. */
const CATALOGUE_VALUE_KIND_PRESENT: Record<CatalogueValueKind, true> = {
  'bank-account': true,
  'tax-id': true,
  'oauth-sandbox-user': true,
  'bot-protection-test-key': true,
  'requires-provisioning': true,
};

/** Derived, never hand-listed. */
export const CATALOGUE_VALUE_KIND_LIST = Object.keys(
  CATALOGUE_VALUE_KIND_PRESENT,
) as ReadonlyArray<CatalogueValueKind>;

/**
 * WHERE the value is published, as structured data rather than prose.
 *
 * `test-values.ts` carries provenance as a `sourceNote` sentence, which is
 * right for a human and useless to anything else: a report cannot group by it
 * and a reviewer cannot diff it. This is the same fact in a shape code can use,
 * and `sourceNote` survives alongside it for the sentence a reader acts on.
 *
 * ─── NO URL FIELD, ON PURPOSE ───────────────────────────────────────────────
 *
 * A URL recalled from memory is the worst field in a provenance record: it
 * looks authoritative, it is unfalsifiable without a network call this module
 * will not make, and provider docs are reorganised constantly, so a stale link
 * sends the reader to a 404 and they conclude the value is made up. `document`
 * and `section` are what a reader types into the provider's own search box,
 * which still works after a reorganisation.
 */
export interface PublicationRef {
  /** The organisation that published it, in its own name. */
  publisher: CataloguePublisher;
  /** The document, as it is titled — "Testing", "IBAN Registry", "VIES technical specification". */
  document: string;
  /** The section or table within it, when the document is large. Null when it is the whole page. */
  section: string | null;
  /**
   * Always false. This module makes no network call, so nothing here was
   * fetched and verified against the live document.
   *
   * A literal rather than an omission because a reader scanning the data should
   * see the claim and its falsity together. When a fetching path lands, it sets
   * this true on the rows it confirmed and the difference between a confirmed
   * and a recalled row becomes visible instead of inferred.
   */
  fetched: false;
}

/**
 * One catalogue entry.
 *
 * Deliberately parallel to `TestValueEntry` field for field where the meaning
 * is the same — `id`, `purpose`, `expected`, `testModeOnly`, `verified`,
 * `evidence`, `sourceNote` — so the two catalogues read as one vocabulary. The
 * differences are the two that matter: `value` is a {@link PublishedTestValue}
 * and not a string, and provenance is {@link PublicationRef} and not only
 * prose.
 *
 * ─── THE FIELDS THAT ARE ABSENT ─────────────────────────────────────────────
 *
 * There is no `secret`, `apiKey`, `token`, `password`, `privateKey` or
 * `credential` field, and there is no index signature, so there is nowhere for
 * one to go. An entry that needs a credential to be useful says so in
 * `kind: 'requires-provisioning'` and names the remedy in `expected`. That is
 * not a limitation to work around; it is the design.
 */
export interface CatalogueEntry {
  /** Stable id, safe to reference from a generated test's comment. */
  id: string;
  publisher: CataloguePublisher;
  kind: CatalogueValueKind;
  /**
   * The value, admitted. Null ONLY for `kind: 'requires-provisioning'`, where
   * there is no published value by definition.
   */
  value: PublishedTestValue | null;
  /** What it is for, in the words a test name would use. */
  purpose: string;
  /** What the application under test should DO with it. This is the assertion. */
  expected: string;
  /**
   * The payment/identity provider in `test-values.ts`'s vocabulary, when this
   * entry is about one. Null for a standards registry or a CAPTCHA vendor,
   * which that union does not name.
   *
   * This is the join that keeps the two catalogues one catalogue: a plan that
   * has found a Stripe checkout can ask both for cards and for IBANs without
   * knowing there are two tables.
   */
  linkedTestValueProvider: TestValueProvider | null;
  /**
   * True when the value only behaves this way against the provider's test
   * credentials. Every such entry is a landmine against a production
   * environment.
   */
  testModeOnly: boolean;
  /** See the honesty note at the top of the file. */
  verified: boolean;
  evidence: TestValueEvidence;
  /** Structured provenance. */
  publication: PublicationRef;
  /** The sentence a reader acts on. Always populated. */
  sourceNote: string;
}

// ─── Bank accounts ───────────────────────────────────────────────────────────

/**
 * The example IBANs, every one of which satisfies MOD-97-10.
 *
 * ─── WHAT THE ARITHMETIC DOES AND DOES NOT ESTABLISH ────────────────────────
 *
 * Each of these is marked `computed-here` and `verified: true`, and the claim
 * being verified is narrow and stated in `expected`: the string is a
 * well-formed IBAN whose check digits are right. The catalogue's own test
 * recomputes mod-97 on every one, so a transposed digit in this table is a red
 * test and not a silent wrong value. That is a real check on my recall — a
 * single wrong digit passes mod-97 with probability 1/97.
 *
 * What it does NOT establish is that a given sandbox ACCEPTS the IBAN or
 * returns a particular outcome for it. That is a property of the provider and
 * it is `published-recalled`, which is why the one entry making an outcome
 * claim (Stripe's) carries that evidence grade instead.
 *
 * The country spread is not decoration. FR contains a LETTER in its BBAN and is
 * 27 characters; DE is 22 and digits-only; NO is 15. An application that
 * validates IBANs with `/^\d+$/` or a fixed length passes the German case and
 * fails the French one, and that defect is only reachable with both.
 */
const BANK_ACCOUNTS: CatalogueEntry[] = [
  {
    id: 'stripe.iban.sepa.success',
    publisher: 'stripe',
    kind: 'bank-account',
    value: published('DE89370400440532013000'),
    purpose: 'The happy path for a SEPA direct-debit mandate.',
    expected:
      'The mandate is accepted and a subscription or payment is created against it. Note that SEPA settles asynchronously: a test that asserts a PAID invoice immediately is asserting something the rails do not do, and should assert a PENDING mandate plus the eventual webhook instead.',
    linkedTestValueProvider: 'stripe',
    testModeOnly: true,
    verified: true,
    evidence: 'computed-here',
    publication: {
      publisher: 'stripe',
      document: 'Testing',
      section: 'SEPA Direct Debit test account numbers',
      fetched: false,
    },
    sourceNote:
      "The canonical German example IBAN, which Stripe documents as its succeeding SEPA test account. MOD-97-10 valid (recomputed in provider-catalogue.test.ts) — that is what `verified` claims here. The SUCCESS BEHAVIOUR is recalled from Stripe's testing page and not fetched; if a mandate test fails inexplicably, check the number against that page first.",
  },
  {
    id: 'iban.registry.fr.alphanumeric',
    publisher: 'iban-registry',
    kind: 'bank-account',
    value: published('FR1420041010050500013M02606'),
    purpose: 'A 27-character IBAN containing a letter inside the national part.',
    expected:
      'Accepted by a correct IBAN validator. An application that rejects it is validating with a digits-only or fixed-length rule and is rejecting every French account — the bug this entry exists to find.',
    linkedTestValueProvider: null,
    testModeOnly: false,
    verified: true,
    evidence: 'computed-here',
    publication: {
      publisher: 'iban-registry',
      document: 'IBAN Registry',
      section: 'France — example',
      fetched: false,
    },
    sourceNote:
      'The published example IBAN for France. MOD-97-10 valid (recomputed in the test), which is the whole claim: this entry asserts a FORMAT a validator must accept, not a sandbox outcome, so no provider behaviour is being recalled.',
  },
  {
    id: 'iban.registry.gb.example',
    publisher: 'iban-registry',
    kind: 'bank-account',
    value: published('GB33BUKB20201555555555'),
    purpose: 'A 22-character UK IBAN with a four-letter bank code.',
    expected:
      'Accepted by a correct validator. Useful as the second country in any IBAN test: one country proves nothing about a length- or alphabet-sensitive validator.',
    linkedTestValueProvider: null,
    testModeOnly: false,
    verified: true,
    evidence: 'computed-here',
    publication: {
      publisher: 'iban-registry',
      document: 'IBAN Registry',
      section: 'United Kingdom — example',
      fetched: false,
    },
    sourceNote:
      'The published example IBAN for the United Kingdom. MOD-97-10 valid (recomputed in the test). Format claim only.',
  },
  {
    id: 'iban.registry.no.shortest',
    publisher: 'iban-registry',
    kind: 'bank-account',
    value: published('NO9386011117947'),
    purpose: 'The shortest IBAN in use: 15 characters.',
    expected:
      'Accepted by a correct validator. This is the lower boundary of the IBAN length range, and an application with a `minLength` of 16 on its bank-details field rejects every Norwegian account.',
    linkedTestValueProvider: null,
    testModeOnly: false,
    verified: true,
    evidence: 'computed-here',
    publication: {
      publisher: 'iban-registry',
      document: 'IBAN Registry',
      section: 'Norway — example',
      fetched: false,
    },
    sourceNote:
      'The published example IBAN for Norway, and the shortest length the standard allows. MOD-97-10 valid (recomputed in the test). Carried specifically as a length boundary.',
  },
];

// ─── Tax identifiers ─────────────────────────────────────────────────────────

/**
 * VAT, where the testable thing is a SERVICE CONVENTION rather than a number.
 *
 * ─── WHY THERE IS NO "VALID FRENCH VAT NUMBER" HERE ─────────────────────────
 *
 * Because a VAT number that is well-formed and not allocated behaves
 * differently from one that is, and which it is depends on a live lookup. Worse,
 * every member state uses a DIFFERENT check-digit algorithm — there are twenty-
 * seven of them and no single checksum like mod-97 — so this module cannot
 * compute its way to confidence the way it can for an IBAN. Quoting a plausible
 * French VAT number would produce a test that fails against VIES for a reason
 * that has nothing to do with the application.
 *
 * What IS published and stable is the VIES TEST SERVICE convention: against the
 * test endpoint, the VAT number itself selects the response. That is the
 * testable fact, and it is the one carried.
 */
const TAX_IDS: CatalogueEntry[] = [
  {
    id: 'vies.test.valid',
    publisher: 'ec-vies',
    kind: 'tax-id',
    value: published('100'),
    purpose: 'The VIES test endpoint returns VALID for this VAT number.',
    expected:
      'The application treats the tax id as validated: it stores it, drops VAT from the invoice for a reverse-charge sale, or whatever its own rule is. The assertion is on the APPLICATION\'S reaction, not on the VIES response — a test that only asserts "VIES said valid" is testing the European Commission.',
    linkedTestValueProvider: null,
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    publication: {
      publisher: 'ec-vies',
      document: 'VIES technical specification',
      section: 'checkVatTestService',
      fetched: false,
    },
    sourceNote:
      "VIES publishes a separate TEST service whose `checkVatTestService` operation selects its response from the VAT number: 100 returns VALID. Recalled, not fetched. Works ONLY against the test endpoint — against the production endpoint 100 is simply a malformed VAT number, which is a different test with a different assertion.",
  },
  {
    id: 'vies.test.invalid',
    publisher: 'ec-vies',
    kind: 'tax-id',
    value: published('200'),
    purpose: 'The VIES test endpoint returns INVALID for this VAT number.',
    expected:
      'A field-level error the user can act on, the sale proceeds WITH VAT, and nothing is persisted as a validated tax id. The negative half, and the one that costs money when it is wrong: an application that treats "could not validate" as "validated" drops tax it then owes.',
    linkedTestValueProvider: null,
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    publication: {
      publisher: 'ec-vies',
      document: 'VIES technical specification',
      section: 'checkVatTestService',
      fetched: false,
    },
    sourceNote:
      'Same mechanism as the entry above: 200 returns INVALID from the VIES test service. Recalled, not fetched. Test endpoint only.',
  },
];

// ─── Third-party sign-in ─────────────────────────────────────────────────────

/**
 * OAuth, where the honest answer is almost always "you must provision one".
 *
 * ─── WHY NO PROVIDER PUBLISHES A TEST USER ──────────────────────────────────
 *
 * Because a test user is an ACCOUNT, and an account that everybody shares is an
 * account anybody can change the password of. So Google, Auth0 and Okta all
 * make you create your own, and the entries here say exactly that rather than
 * leaving a silence a reader will fill with "nobody looked".
 *
 * This is not a dead end for coverage. `packages/runner/src/login.ts` already
 * has a MOCK IDP adapter, and that is the right answer for most suites: a mock
 * IdP tests the application's OAuth CALLBACK HANDLING — state validation, nonce
 * checking, account linking, the error branches — which is where the defects
 * are and all of which is reachable without a real Google account. What a mock
 * cannot test is the provider's own consent screen, and that is a far smaller
 * surface than it appears.
 */
const OAUTH_SANDBOX: CatalogueEntry[] = [
  {
    id: 'google.oauth.no-published-test-user',
    publisher: 'google',
    kind: 'requires-provisioning',
    value: null,
    purpose: 'Google publishes no shared test account for "Sign in with Google".',
    expected:
      'A Google sign-in flow is driven EITHER by a test user the customer adds to their own OAuth consent screen while it is in Testing status, OR — preferably — by the mock IdP in packages/runner/src/login.ts, which exercises the callback handling where the defects actually live. What must NOT happen is a scenario that drives accounts.google.com with a real personal account.',
    linkedTestValueProvider: null,
    testModeOnly: false,
    verified: false,
    evidence: 'published-recalled',
    publication: {
      publisher: 'google',
      document: 'Setting up OAuth 2.0',
      section: 'Test users',
      fetched: false,
    },
    sourceNote:
      'Carried deliberately as a non-value. An unverified Google OAuth app in Testing status serves only the test users listed on its consent screen; those are per-customer and are a credential, so they belong on an AuthProfile row and not here. The honest plan output is "needs a provisioned test user, or use the mock IdP", never "skipped login — no credentials".',
  },
  {
    id: 'auth0.oauth.no-published-test-user',
    publisher: 'auth0',
    kind: 'requires-provisioning',
    value: null,
    purpose: 'Auth0 tenants ship with no users at all.',
    expected:
      'A test creates a user in the customer\'s own dev tenant through the Management API, or uses a database connection seeded by the customer. Either way the credential is the customer\'s and belongs on an AuthProfile row. A disposable user created this way is also the right PRINCIPAL for a destructive scenario — see principals.ts.',
    linkedTestValueProvider: null,
    testModeOnly: false,
    verified: false,
    evidence: 'published-recalled',
    publication: {
      publisher: 'auth0',
      document: 'Tenant settings',
      section: 'Development tenants',
      fetched: false,
    },
    sourceNote:
      'Carried as a non-value: a fresh Auth0 tenant has an empty user store, so there is nothing to publish. Noted because the Management-API path is the one way an OAuth suite gets a genuinely DISPOSABLE identity, which is what logout, lockout and password-reset scenarios require.',
  },
  {
    id: 'paypal.oauth.sandbox-buyer',
    publisher: 'paypal',
    kind: 'requires-provisioning',
    value: null,
    purpose: 'PayPal checkout needs a sandbox buyer account, which is generated per developer account.',
    expected:
      'The plan states "needs a PayPal sandbox buyer credential" as a setup prerequisite and the flow is reported UNEXERCISABLE until one exists — not skipped, and not passed.',
    linkedTestValueProvider: 'paypal',
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    publication: {
      publisher: 'paypal',
      document: 'Developer dashboard',
      section: 'Sandbox accounts',
      fetched: false,
    },
    sourceNote:
      "Deliberately duplicates the FACT that `test-values.ts`'s `paypal.sandbox.no-fixed-card` records about cards, in the OAUTH vocabulary, because a PayPal flow is gated twice: on a card and on a buyer login. `linkedTestValueProvider` joins the two entries so a reader finds both.",
  },
];

// ─── Bot protection ──────────────────────────────────────────────────────────

/**
 * The ONLY sanctioned way past a bot defence: the provider's own test key.
 *
 * ─── THE RULE THIS FILE OBEYS ───────────────────────────────────────────────
 *
 * A CAPTCHA is never defeated, solved, evaded or bypassed. The entries here are
 * not a bypass — they are keys the VENDOR publishes so that a customer can test
 * their own form, and they only work when the CUSTOMER has configured them on
 * the CUSTOMER'S own environment. A site key the customer has not set does
 * nothing, and the honest output in that case is
 * `UNREACHABLE_BEHIND_BOT_PROTECTION` with the remedy. There is no third
 * option, and the absence of one is the point.
 *
 * ─── WHY ONLY THE SITE KEY ──────────────────────────────────────────────────
 *
 * A site key ships in the customer's HTML: it is public by construction, which
 * is what makes it publishable here. Each of these has a paired SECRET key, also
 * published by the vendor, and this catalogue carries NONE of them. Not because
 * a published test secret is dangerous in itself, but because a `secret` field
 * on this type would be a field a real secret could occupy, and there is no
 * version of that which stays safe for long. The pairing is named in
 * `expected`, so a reader knows to fetch it from the vendor's page and put it
 * where secrets go.
 */
const BOT_PROTECTION: CatalogueEntry[] = [
  {
    id: 'cloudflare.turnstile.sitekey.always-passes',
    publisher: 'cloudflare',
    kind: 'bot-protection-test-key',
    value: published('1x00000000000000000000AA'),
    purpose: 'A Turnstile site key whose documented behaviour is "always passes, visible widget".',
    expected:
      'The widget renders and issues a token, so the form behind it can be submitted and the FORM can be tested. The paired test SECRET key — which this catalogue does not carry — must be configured server-side, or verification fails and the test reports a backend error rather than a form defect.',
    linkedTestValueProvider: null,
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    publication: {
      publisher: 'cloudflare',
      document: 'Turnstile',
      section: 'Testing / dummy sitekeys and secret keys',
      fetched: false,
    },
    sourceNote:
      "Cloudflare publishes a table of dummy Turnstile keys for exactly this purpose; `1x…AA` is the always-passes visible one. Recalled, not fetched. It is only in effect when the CUSTOMER has configured it on their own environment — setting it is a change to the customer's application and not something a test run may do.",
  },
  {
    id: 'cloudflare.turnstile.sitekey.always-blocks',
    publisher: 'cloudflare',
    kind: 'bot-protection-test-key',
    value: published('2x00000000000000000000AB'),
    purpose: 'A Turnstile site key whose documented behaviour is "always blocks".',
    expected:
      'The widget never issues a token, so the protected form cannot be submitted. This is the negative case for the DEFENCE: an application that submits anyway, or that treats a missing token as success, has a bot-protection bypass — which is a security finding and not a cosmetic one.',
    linkedTestValueProvider: null,
    testModeOnly: true,
    verified: false,
    evidence: 'published-recalled',
    publication: {
      publisher: 'cloudflare',
      document: 'Turnstile',
      section: 'Testing / dummy sitekeys and secret keys',
      fetched: false,
    },
    sourceNote:
      "From the same published table as the entry above. Recalled, not fetched. Carried because the always-blocks key is the only way to test that a form's server side actually VERIFIES the token — the commonest CAPTCHA defect by far is a widget that renders and a backend that never checks.",
  },
];

/** The whole catalogue, in one array. */
export const PROVIDER_CATALOGUE: readonly CatalogueEntry[] = [
  ...BANK_ACCOUNTS,
  ...TAX_IDS,
  ...OAUTH_SANDBOX,
  ...BOT_PROTECTION,
];

/**
 * What was LEFT OUT, and why — the same mechanism `test-values.ts` uses, for
 * the same reason: a plausible-but-wrong value costs more than a missing one,
 * and an absence nobody records reads as an absence nobody noticed.
 */
export const CATALOGUE_OMISSIONS: ReadonlyArray<{
  publisher: CataloguePublisher;
  what: string;
  why: string;
}> = [
  {
    publisher: 'ec-vies',
    what: "The rest of the VIES test service's response codes (the service-unavailable, timeout, blocked and max-concurrent-request selectors)",
    why: 'The test service selects several more responses from the VAT number than the two carried here, and I can place the general scheme but not each code against each response. A wrong selector returns a DIFFERENT error than the test expects, which looks exactly like an application bug in the error-handling branch — the hardest kind of false finding to dismiss. Get the table from the VIES technical specification.',
  },
  {
    publisher: 'stripe',
    what: 'The SEPA test IBANs that force a failed or disputed mandate',
    why: 'Stripe publishes IBANs that settle and then fail, and ones that produce a dispute, which is the interesting half of a direct-debit suite. I am confident those exist and not confident of the digits, and unlike a card number a wrong IBAN here would still pass mod-97 only by luck — so it would be refused at the mandate step and the failure would read as a validation bug. Only the succeeding account is carried.',
  },
  {
    publisher: 'google',
    what: "reCAPTCHA's published always-passing test key pair",
    why: 'Google documents a site/secret pair that always passes verification, and it is a legitimate testing path exactly like the Turnstile keys above. I can recall its shape but not the full forty-character site key digit for digit, and a wrong CAPTCHA key does not fail loudly — the widget simply refuses to render, which reads as a broken page. Turnstile\'s keys are carried instead because their all-zeros structure is recallable with confidence.',
  },
  {
    publisher: 'okta',
    what: 'Anything at all about Okta developer-org test users',
    why: 'Listed as a publisher because the access-matrix work names Okta as a sign-in host, and then nothing is carried for it: I do not know Okta\'s dev-org user provisioning well enough to write the remedy sentence that makes a `requires-provisioning` entry useful. An entry whose `expected` is vague is worse than no entry, because it looks answered.',
  },
  {
    publisher: 'adyen',
    what: 'Adyen test IBANs and its test tax identifiers',
    why: "Adyen publishes a sandbox matrix as broad as Stripe's. `test-values.ts` carries only its widely-shared Visa for the same reason, and the bank-account and tax-id halves are omitted here for that reason too: not recallable digit for digit.",
  },
  {
    publisher: 'rfc',
    what: 'Mail-sink and phone-sink conventions',
    why: 'NOT an omission: they are carried in `test-values.ts` under the `email-pattern` and `phone` kinds, with the RFC 2606 / RFC 6761 reserved domains and the NANP and Ofcom reserved ranges. Recorded here so a reader who looks for them in this module finds the pointer rather than concluding nobody did it. `rfc` stays in CATALOGUE_PUBLISHERS because an entry minted here could legitimately be standards-reserved.',
  },
];

// ─── Is this flow testable at all? ───────────────────────────────────────────

/**
 * The answer the Explorer should print instead of "skipped — no test card".
 *
 * Four outcomes, and the distinction between the middle two is the whole point:
 * a gate that needs a credential the customer has not supplied is NOT the same
 * as a gate nothing can get through, and neither is the same as a gate nobody
 * catalogued. Collapsing them into one word is how a coverage hole acquires a
 * sentence that reads like diligence.
 */
export const PAYMENT_TESTABILITIES = [
  /** A published value exists here and the flow can be driven today. */
  'TESTABLE_WITH_PUBLISHED_VALUE',
  /** Driveable, but only once the customer provisions a sandbox credential. */
  'REQUIRES_PROVISIONED_SANDBOX',
  /**
   * A bot defence stands in front of it and no documented test key is
   * configured. The honest terminal state: the remedy is named, and no
   * workaround is offered or exists.
   */
  'UNREACHABLE_BEHIND_BOT_PROTECTION',
  /**
   * This catalogue has nothing about this publisher. NOT "untestable" — the
   * difference between "we checked and there is no way" and "we have no entry"
   * is the difference between a finding and a gap in our own data, and
   * reporting the second as the first is a lie this product cannot afford.
   */
  'NOT_CATALOGUED',
] as const;
export type PaymentTestability = (typeof PAYMENT_TESTABILITIES)[number];

/** Compile-time half of the parity guard. */
const PAYMENT_TESTABILITY_PRESENT: Record<PaymentTestability, true> = {
  TESTABLE_WITH_PUBLISHED_VALUE: true,
  REQUIRES_PROVISIONED_SANDBOX: true,
  UNREACHABLE_BEHIND_BOT_PROTECTION: true,
  NOT_CATALOGUED: true,
};

/** Derived, never hand-listed. */
export const PAYMENT_TESTABILITY_LIST = Object.keys(
  PAYMENT_TESTABILITY_PRESENT,
) as ReadonlyArray<PaymentTestability>;

/** What a gate assessment carries: the verdict, the reason, and what to do. */
export interface GateAssessment {
  testability: PaymentTestability;
  /** The entries that support the verdict. Empty for NOT_CATALOGUED. */
  entries: readonly CatalogueEntry[];
  /** One sentence for the plan, naming the remedy when there is one. */
  remedy: string;
}

/**
 * Assess one publisher's gate of one kind.
 *
 * `botProtectionConfigured` is an INJECTED FACT and not something this function
 * can look up: whether a customer has set a dummy Turnstile key on their own
 * staging environment is a property of their deployment, and a module that
 * guessed would produce the worst possible answer — a plan that drives a
 * CAPTCHA-gated form, fails, and reports a form defect. `undefined` means
 * nobody established it, and it is reported as unreachable with that said out
 * loud, because an unestablished fact treated as true is how an
 * UNREACHABLE surface comes to be recorded the same way as a passing one.
 */
export function assessGate(
  publisher: CataloguePublisher,
  kind: CatalogueValueKind,
  options: { botProtectionConfigured?: boolean } = {},
): GateAssessment {
  const entries = PROVIDER_CATALOGUE.filter(
    (e) => e.publisher === publisher && e.kind === kind,
  );

  if (entries.length === 0) {
    return {
      testability: 'NOT_CATALOGUED',
      entries: [],
      remedy: `No catalogue entry for ${publisher} / ${kind}. This is a gap in QAAI's own data, not a proof that the flow cannot be tested — check CATALOGUE_OMISSIONS, which may name it and say why.`,
    };
  }

  if (kind === 'bot-protection-test-key') {
    if (options.botProtectionConfigured === true) {
      return {
        testability: 'TESTABLE_WITH_PUBLISHED_VALUE',
        entries,
        remedy: `The customer has configured a documented test key, so the form behind the widget can be driven. Use ${entries[0]!.id} for the passing case and the always-blocks key for the negative one.`,
      };
    }
    return {
      testability: 'UNREACHABLE_BEHIND_BOT_PROTECTION',
      entries,
      remedy:
        options.botProtectionConfigured === false
          ? `A bot defence guards this flow and no documented test key is configured on the environment. The remedy is for the CUSTOMER to set ${publisher}'s published dummy site key and its paired secret on their own test environment; QAAI will not and cannot work around the defence.`
          : `A bot defence guards this flow and nobody established whether a documented test key is configured — so this is reported unreachable rather than attempted. Establish it, then re-ask: the answer flips to testable the moment the customer sets ${publisher}'s published dummy key on their own environment.`,
      };
  }

  const withValue = entries.filter((e) => e.value !== null);
  if (withValue.length === 0) {
    return {
      testability: 'REQUIRES_PROVISIONED_SANDBOX',
      entries,
      // The entry's own `expected` already ends with the UNEXERCISABLE
      // instruction, so appending it again produced a remedy that said the same
      // sentence twice — the sort of thing a plan prints verbatim into a report.
      remedy: entries[0]!.expected,
    };
  }

  return {
    testability: 'TESTABLE_WITH_PUBLISHED_VALUE',
    entries: withValue,
    remedy: `Drive it with ${withValue.map((e) => e.id).join(', ')}. Every one is test-mode only where \`testModeOnly\` says so: against live keys these are a real charge attempt or a hard decline.`,
  };
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

export function catalogueEntriesFor(publisher: CataloguePublisher): CatalogueEntry[] {
  return PROVIDER_CATALOGUE.filter((e) => e.publisher === publisher);
}

export function catalogueEntriesOfKind(kind: CatalogueValueKind): CatalogueEntry[] {
  return PROVIDER_CATALOGUE.filter((e) => e.kind === kind);
}

/**
 * Every entry joined to a `test-values.ts` provider, so a plan that has
 * identified a payment processor can ask one question and get both catalogues.
 */
export function catalogueEntriesForTestValueProvider(
  provider: TestValueProvider,
): CatalogueEntry[] {
  return PROVIDER_CATALOGUE.filter((e) => e.linkedTestValueProvider === provider);
}

/**
 * One paragraph a human reads before trusting any of this.
 *
 * Leads with what is NOT verified and ends with the omissions, for the reason
 * `describeTestValueConfidence` gives: a catalogue that opens with its coverage
 * number gets trusted further than it has earned.
 */
export function describeProviderCatalogueConfidence(): string {
  const total = PROVIDER_CATALOGUE.length;
  const computed = PROVIDER_CATALOGUE.filter((e) => e.evidence === 'computed-here').length;
  const recalled = PROVIDER_CATALOGUE.filter((e) => e.evidence === 'published-recalled').length;
  const provisioning = catalogueEntriesOfKind('requires-provisioning').length;
  return [
    `${total} catalogue entries. ${computed} are proved by arithmetic in this process (MOD-97-10 on an IBAN) and nothing here was fetched: every PublicationRef carries fetched: false.`,
    `${recalled} are recalled from a provider's documentation, which is the weakest evidence in this file and the first thing to check when a gated flow fails for a reason that makes no sense.`,
    `${provisioning} entries carry no value at all, on purpose: they name a gate that needs a customer-provisioned credential and say what to provision, which is the honest alternative to skipping the flow.`,
    `${CATALOGUE_OMISSIONS.length} groups of values were left out rather than guessed; see CATALOGUE_OMISSIONS.`,
  ].join(' ');
}

/**
 * Every id in the catalogue, for a caller that wants to check a reference
 * before interpolating it into a generated test's comment.
 *
 * A generated spec that cites `stripe.iban.sepa.failed` — an id this catalogue
 * does not have, because that value is in CATALOGUE_OMISSIONS — sends its
 * reader to a value that does not exist, and the reader concludes the whole
 * provenance apparatus is decorative.
 */
export function catalogueHasId(id: string): boolean {
  return PROVIDER_CATALOGUE.some((e) => e.id === id);
}
