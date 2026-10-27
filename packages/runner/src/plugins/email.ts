/**
 * Transactional email as a test type (§4 EMAIL) — the outbound half of every
 * application.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * `plugins/email-otp.ts` stops at request-code → read → sign-in. It reads one
 * message, pulls one code out of it with one regex, and throws the rest of the
 * mail away. So every OTHER thing an application sends — the receipt, the
 * invite, the password reset, the verification mail, the invoice, the weekly
 * digest — has NO TEST SURFACE AT ALL. `SURFACE_KINDS` has counted
 * `NOTIFICATION` since the inventory was built and `DIMENSION_AXIS` maps the
 * EMAIL dimension onto it, so those templates have been sitting in the
 * uncovered column with no way out of it: countable and uncoverable, which is
 * the worst shape a denominator can have.
 *
 * The defects that actually ship in transactional mail are not "the send call
 * threw". They are: the total in the receipt is the pre-discount total; the
 * reset link 404s because the route moved; `Hi {{firstName}}` went out to
 * 40,000 people; the invoice PDF is 0 bytes; the unsubscribe link is a
 * `mailto:` nobody reads; the German mail is in English. Every one of those is
 * a mail that SENT SUCCESSFULLY, so every provider dashboard shows green.
 *
 * ── ONE MAILBOX INTERFACE, NOT TWO ─────────────────────────────────────────
 *
 * email-otp.ts had no injected mailbox at all: it called a top-level `fetch`
 * against `mailboxUrl` inside its own `waitForMail`. {@link MailboxReader} is
 * THE mailbox surface for this package, and {@link DeliveredMail} is a strict
 * superset of the four fields that file reads (`to`, `subject`, `text`,
 * `receivedAt`), so adopting it there is a mechanical edit and not a rewrite.
 * It is named in the handover. Writing a second mailbox here would have given
 * the product two answers to "did the mail arrive", and they would have drifted.
 *
 * ── A MAIL THAT DID NOT ARRIVE IS NOT A PASS, AND NOT ALWAYS A FAILURE ──────
 *
 * This is the one judgement in the file worth arguing about, so here is the
 * argument. `plugins/jobs.ts` rules that an expired wait is UNKNOWN rather than
 * FAILED, because a queue consumer's latency is a property of how the
 * customer's workers are scaled and QAAI's 30-second budget is not an SLA
 * anybody agreed to. Mail is different in one specific way and the same in
 * another, so this file splits on it:
 *
 *   · THE TRIGGER FIRED HERE, and no mail arrived inside the author's own
 *     `timeoutSeconds` → FAILED. We know the cause happened, because this
 *     plugin caused it and got a success back. A receipt that has not arrived
 *     inside the bound the test's own author chose is the defect this type
 *     exists to catch, and reporting it as UNKNOWN would make EMAIL a type
 *     that can never fail — which is the lie the product cannot afford. The
 *     sentence still names the elapsed wait, the poll count and the budget, so
 *     a reader can raise it rather than go hunting.
 *
 *   · THE TRIGGER WAS `EXTERNAL` — a preceding test, a human, a cron — and no
 *     mail arrived → SKIPPED with `notRun.kind` NOT_RUN. We cannot establish
 *     that the cause ever happened, so we are not entitled to a verdict about
 *     the effect. This is jobs.ts's reasoning applied where it actually holds.
 *
 * Both are {@link EMAIL_NOT_DELIVERED}, both report the wait that elapsed, and
 * NEITHER is ever PASSED. {@link deliveryStatus} is the one function that maps
 * the pair to a status, and the invariant is a test.
 *
 * ── SECURITY: THE TOKEN IS NEVER THE EVIDENCE ──────────────────────────────
 *
 * A magic link and a reset link carry a bearer credential in the URL. This file
 * asserts a link's SHAPE ({@link describeLinkToken} — where the token sits, how
 * long it is, which alphabet) and its EFFECT (it resolves, it lands where it
 * should), and the VALUE never reaches a step title, an error message, a
 * console note or a returned field: {@link redactLink} is applied at every
 * print site and {@link safeExcerpt} masks credential-shaped runs out of body
 * text, because an application that mails its own API key is a real defect and
 * echoing it into an artifact store would be our defect on top of theirs.
 *
 * Every host — the mailbox's and every link's — goes through
 * {@link screenHost} before a byte is sent to it, and a host whose name was not
 * resolved says so rather than being reported as checked.
 *
 * ── INJECTED SURFACES (rule 8) ─────────────────────────────────────────────
 *
 * There is no mail sink, no network and no clock to wait on here, so the
 * mailbox, the link probe, the trigger and the clock are all injected and the
 * logic is tested against fakes with no sleeping and no sockets. The three
 * unavailable adapters at the bottom REFUSE rather than return a plausible
 * empty answer, for the reason jobs.ts writes out at length: a stub that
 * returned "one mail, no links, no attachments" would make every assertion in
 * this file pass against nothing at all, and move a coverage number on the
 * strength of a fake.
 *
 * ── WHAT THIS TYPE DOES NOT ASSERT ─────────────────────────────────────────
 *
 * Declared rather than implied, and carried on the type declaration's
 * `knownUnasserted` so a report can count it:
 *
 *   · HTML RENDERING. Links are extracted from the body with a regex over
 *     `<a href>` plus bare URLs in the text part. A link that exists only in a
 *     CSS `background-image`, an image map or a VML fallback is not extracted,
 *     and a client-specific rendering defect (Outlook's table model, dark-mode
 *     colour inversion) is outside this type entirely.
 *   · SPAM AND DELIVERABILITY. SPF, DKIM, DMARC alignment and inbox placement
 *     are properties of a domain and a reputation, not of a build.
 *   · TRANSLATION CORRECTNESS. {@link EMAIL_LOCALE} asserts that the mail is in
 *     the locale it claims, never that the words are right.
 */

import { z } from 'zod';
import { SECRET_SHAPES, unassertedReasonSchema } from '@qaai/shared';
import type {
  ConsoleEntry,
  ExecutableTest,
  RunContext,
  StepResult,
  TestExecution,
  TestResultStatus,
} from '@qaai/shared';
/*
 * A SUBPATH, not the barrel: private-address.ts reaches for `node:dns`, and the
 * barrel is what the web app's bundler eats. sandbox.ts and contract-broker.ts
 * import it the same way for the same reason.
 */
import { classifyHost, resolvesPublicly } from '@qaai/shared/private-address';
import type { LookupFn } from '@qaai/shared/private-address';

// ─── The assertion axis ──────────────────────────────────────────────────────

/**
 * The ten things worth asserting about a transactional mail.
 *
 * Each one is a defect class that ships today behind a green provider
 * dashboard — see the file header. `DELIVERED` is first and is special: it is
 * evaluated whether or not a spec lists it, because nothing else in this list
 * can be evaluated without the message.
 */
export const EMAIL_ASSERTIONS = [
  'DELIVERED',
  'SUBJECT',
  'SENDER',
  'BODY_VALUES',
  'LINKS',
  'LINK_TOKEN_SHAPE',
  'ATTACHMENTS',
  'UNSUBSCRIBE',
  'LOCALE',
  'NO_PLACEHOLDERS',
] as const;
export type EmailAssertion = (typeof EMAIL_ASSERTIONS)[number];

/**
 * The compiler-enforced presence record this codebase requires beside a
 * vocabulary with a write path, paired with the run-time parity test in
 * email.test.ts and with a third test that walks every member through
 * {@link runEmailAssertion} and insists on a verdict.
 *
 * All three halves, because eight GateRule kinds shipped unsaveable for two
 * slices when only the zod enum existed: the schema accepted a kind no branch
 * honoured, and `check:wiring` cannot see that.
 */
export const EMAIL_ASSERTION_PRESENCE: Record<EmailAssertion, true> = {
  DELIVERED: true,
  SUBJECT: true,
  SENDER: true,
  BODY_VALUES: true,
  LINKS: true,
  LINK_TOKEN_SHAPE: true,
  ATTACHMENTS: true,
  UNSUBSCRIBE: true,
  LOCALE: true,
  NO_PLACEHOLDERS: true,
};

export const EMAIL_ASSERTION_LABELS: Record<EmailAssertion, string> = {
  DELIVERED: 'The mail arrived, inside the bound',
  SUBJECT: 'The subject is the one the template declares',
  SENDER: 'The from and reply-to addresses are right',
  BODY_VALUES: 'The named values are rendered in the body',
  LINKS: 'Every link resolves and lands where it should',
  LINK_TOKEN_SHAPE: 'The link carries a token of the right shape',
  ATTACHMENTS: 'The attachments are named, typed and non-empty',
  UNSUBSCRIBE: 'The unsubscribe link is present and works',
  LOCALE: 'The mail is in the locale it claims',
  NO_PLACEHOLDERS: 'No unrendered template token survived',
};

export const emailAssertionSchema = z.enum(EMAIL_ASSERTIONS);

/** The one assertion that is never optional. See {@link EMAIL_ASSERTIONS}. */
export const EMAIL_DELIVERED: EmailAssertion = 'DELIVERED';
export const EMAIL_LOCALE: EmailAssertion = 'LOCALE';

// ─── What caused the mail ────────────────────────────────────────────────────

/**
 * WHO FIRED THE TRIGGER, which decides what a non-delivery means.
 *
 * `EXTERNAL` is not a lesser member and it is not a placeholder: a receipt is
 * usually caused by the checkout E2E test that ran before this one, and
 * re-driving the purchase here would charge twice. What it costs is the right
 * to call a non-delivery a failure, and {@link deliveryStatus} charges exactly
 * that and nothing more.
 */
export const EMAIL_TRIGGER_KINDS = ['EXTERNAL', 'HTTP_GET', 'HTTP_POST'] as const;
export type EmailTriggerKind = (typeof EMAIL_TRIGGER_KINDS)[number];

const EMAIL_TRIGGER_KIND_PRESENT: Record<EmailTriggerKind, true> = {
  EXTERNAL: true,
  HTTP_GET: true,
  HTTP_POST: true,
};

export const EMAIL_TRIGGER_KIND_LIST = Object.keys(
  EMAIL_TRIGGER_KIND_PRESENT,
) as ReadonlyArray<EmailTriggerKind>;

export const emailTriggerSchema = z
  .object({
    kind: z.enum(EMAIL_TRIGGER_KINDS),
    /**
     * The path or URL to call, or — for EXTERNAL — what caused it in the
     * customer's words, which is what the report prints so a reader knows what
     * was supposed to have happened.
     */
    target: z.string().min(1).max(500),
    /** Body for HTTP_POST. Not secret: secrets go through `ctx.secrets`. */
    body: z.unknown().optional(),
  })
  .strict();
export type EmailTriggerSpec = z.infer<typeof emailTriggerSchema>;

// ─── Link token shapes ───────────────────────────────────────────────────────

/**
 * WHERE a link's credential sits. Spec-supplied, never guessed.
 *
 * Guessing is the defect: a heuristic that picked "the longest path segment"
 * would, on `/invoices/INV-2024-000931/download?ref=abc`, describe an invoice
 * number as a token, pass a `minLength` check, and report the reset-token
 * assertion as MET on a link that carries no token at all.
 */
export const LINK_TOKEN_PLACES = ['PATH_SEGMENT', 'QUERY', 'FRAGMENT'] as const;
export type LinkTokenPlace = (typeof LINK_TOKEN_PLACES)[number];

const LINK_TOKEN_PLACE_PRESENT: Record<LinkTokenPlace, true> = {
  PATH_SEGMENT: true,
  QUERY: true,
  FRAGMENT: true,
};

export const LINK_TOKEN_PLACE_LIST = Object.keys(
  LINK_TOKEN_PLACE_PRESENT,
) as ReadonlyArray<LinkTokenPlace>;

/**
 * The alphabet a token is drawn from, ORDERED NARROWEST FIRST.
 *
 * The order is the contract, because these sets nest: every digit string is
 * also valid hex and also valid base64url. A spec asking for BASE64URL on a
 * six-digit code must not be told "expected BASE64URL, got DIGITS" — that is a
 * false failure on a correct application — so {@link alphabetSatisfies} reads
 * the expectation as "no wider than this". `MIXED` is the residue and satisfies
 * nothing but itself: a token containing `+`, `/` or `=` is classic base64 in a
 * URL, which is a real bug, and swallowing it into BASE64URL would hide it.
 */
export const LINK_TOKEN_ALPHABETS = ['DIGITS', 'HEX', 'BASE64URL', 'MIXED'] as const;
export type LinkTokenAlphabet = (typeof LINK_TOKEN_ALPHABETS)[number];

const LINK_TOKEN_ALPHABET_PRESENT: Record<LinkTokenAlphabet, true> = {
  DIGITS: true,
  HEX: true,
  BASE64URL: true,
  MIXED: true,
};

export const LINK_TOKEN_ALPHABET_LIST = Object.keys(
  LINK_TOKEN_ALPHABET_PRESENT,
) as ReadonlyArray<LinkTokenAlphabet>;

/**
 * A token described WITHOUT its value. Every field here is safe to print.
 *
 * There is deliberately no `value` and no `prefix`: a four-character prefix of
 * a reset token is four characters of a live credential in an artifact store,
 * and "it is only truncated" is the sentence that precedes every one of those
 * incidents.
 */
export interface LinkToken {
  readonly where: LinkTokenPlace;
  readonly length: number;
  readonly alphabet: LinkTokenAlphabet;
  /** The query parameter it came from, for QUERY. Null elsewhere. */
  readonly param: string | null;
}

/** Narrowest alphabet the string fits. Order matters — see {@link LINK_TOKEN_ALPHABETS}. */
export function classifyAlphabet(token: string): LinkTokenAlphabet {
  if (/^[0-9]+$/.test(token)) return 'DIGITS';
  if (/^[0-9a-f]+$/i.test(token)) return 'HEX';
  if (/^[A-Za-z0-9_-]+$/.test(token)) return 'BASE64URL';
  return 'MIXED';
}

/**
 * Does the observed alphabet satisfy the expectation?
 *
 * "No wider than expected", not "equal to expected". See
 * {@link LINK_TOKEN_ALPHABETS} for why equality would fail correct
 * applications, and why MIXED is excluded from the widening.
 */
export function alphabetSatisfies(
  observed: LinkTokenAlphabet,
  expected: LinkTokenAlphabet,
): boolean {
  if (expected === 'MIXED') return observed === 'MIXED';
  if (observed === 'MIXED') return false;
  return LINK_TOKEN_ALPHABETS.indexOf(observed) <= LINK_TOKEN_ALPHABETS.indexOf(expected);
}

/**
 * Describe the token at a SPEC-NAMED place in a URL, or null when there is
 * none there.
 *
 * Null is a real answer and the caller must treat it as UNMET rather than as
 * "nothing to check" — a reset link with no token in it is the defect.
 */
export function describeLinkToken(raw: string, where: LinkTokenPlace): LinkToken | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  /*
   * Only http(s) has the structure this function describes. For a non-special
   * scheme the path is OPAQUE, so `mailto:x@y.test` reported an 8-character
   * MIXED "token in its PATH_SEGMENT" — a shape assertion satisfied by an email
   * address. See the twin branch in {@link redactLink}; the two share one defect
   * and are fixed together on purpose.
   */
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  switch (where) {
    case 'PATH_SEGMENT': {
      const segments = url.pathname.split('/').filter((s) => s.length > 0);
      // The LAST non-empty segment, which is where every framework puts it.
      // Not "the longest": see LINK_TOKEN_PLACES on why guessing is the defect.
      const last = segments.at(-1);
      if (last === undefined || last.length === 0) return null;
      const decoded = safeDecode(last);
      return {
        where,
        length: decoded.length,
        alphabet: classifyAlphabet(decoded),
        param: null,
      };
    }
    case 'QUERY': {
      /*
       * The LONGEST parameter value, with its NAME reported. A mail link
       * routinely carries `?utm_source=digest&token=…`, and picking the first
       * parameter would describe a UTM tag as the credential.
       */
      let best: { param: string; value: string } | null = null;
      for (const [param, value] of url.searchParams) {
        if (best === null || value.length > best.value.length) best = { param, value };
      }
      if (best === null || best.value.length === 0) return null;
      return {
        where,
        length: best.value.length,
        alphabet: classifyAlphabet(best.value),
        param: best.param,
      };
    }
    case 'FRAGMENT': {
      const hash = url.hash.replace(/^#/, '');
      if (hash.length === 0) return null;
      // `#access_token=…` is the OAuth implicit shape; `#abc…` is the bare one.
      const eq = hash.indexOf('=');
      const value = eq >= 0 ? hash.slice(eq + 1) : hash;
      if (value.length === 0) return null;
      return {
        where,
        length: safeDecode(value).length,
        alphabet: classifyAlphabet(safeDecode(value)),
        param: eq >= 0 ? hash.slice(0, eq) : null,
      };
    }
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ─── Redaction, applied at every print site ──────────────────────────────────

/** What a redacted path segment or query value is replaced with. */
const REDACTED = '…';

/**
 * How short a path segment has to be to survive redaction intact.
 *
 * Twelve, which is shorter than any token worth minting and longer than the
 * route words that make a redacted URL readable (`reset`, `verify`, `invoices`,
 * `unsubscribe`). A `uuid` is 36 and a base64url 32-byte token is 43, so both
 * are well clear.
 */
const MAX_SAFE_SEGMENT_LENGTH = 12;

/**
 * THE SHORT CREDENTIAL THE LENGTH RULE ALONE LET THROUGH.
 *
 * The length rule above is correct about tokens and wrong about ONE-TIME CODES.
 * A six-digit OTP in a path — `/verify/418203`, `/confirm/902144` — is six
 * characters, so `length > 12` let it through and `redactLink` printed a live
 * credential verbatim into a step title. It is not hypothetical: EMAIL_OTP is a
 * sibling test type in this same runner, and the shape it exists for is exactly
 * this one.
 *
 * Lowering MAX_SAFE_SEGMENT_LENGTH is the wrong fix — at five it would redact
 * `reset`, `verify` and `invoices`, which is the readability the number was
 * chosen for. So the second rule is about the ALPHABET instead: a short segment
 * that is nothing but digits is never a route word in any application, and an
 * all-digit run of four or more is an OTP, a PIN or a confirmation code often
 * enough that printing it cannot be justified for the evidence a resource id
 * adds to a step title. Redaction is a safety property and must cover every
 * place a credential could be; describing one is the assertion, and
 * {@link describeLinkToken} is still the only thing that looks.
 *
 * Four, not three: `/v1/`, `/en/` and `/us/` stay readable, and no code worth
 * mailing is three digits.
 *
 * ── THE HALF THE ALL-DIGIT RULE STILL LET THROUGH ───────────────────────────
 *
 * The all-digit rule above closed ONE of the four alphabets this plugin's own
 * spec declares. `LINK_TOKEN_ALPHABETS` is DIGITS, HEX, BASE64URL and MIXED,
 * and `linkExpectationSchema` accepts a `minLength` of SIX — so a customer may
 * legitimately declare a six-character HEX token, which is 6 ≤ 12 and not
 * all-digits, and `redactLink` printed it VERBATIM. Measured, not supposed:
 * `/verify/9f3b1c`, `/verify/a1b2c3d4e5` and `/verify/a1b2c3d4e5f6` all came
 * back with the token intact, while the all-digit `/verify/482913` was
 * correctly redacted. A magic-link token in a report is the exact leak the
 * binding rule names, and it was reachable from a spec the schema accepts.
 *
 * So the alphabet rule now covers a token-shaped run in ANY of the declared
 * alphabets, keyed on CARRYING A DIGIT. That predicate is what separates a
 * credential from a route word without a word list: `reset`, `verify`,
 * `invoices`, `unsubscribe`, `app` and `account` carry none, and a token in
 * DIGITS, HEX, BASE64URL or MIXED carries one with overwhelming probability.
 * It over-redacts a versioned route word like `v2024`, which is the safe
 * direction and is what "deliberately CONSERVATIVE" above already chose.
 *
 * ── AND THE HALF *THAT* RULE STILL LET THROUGH ────────────────────────
 *
 * "A token-shaped run in ANY of the declared alphabets" is the rule the
 * paragraph above states, and `/[0-9]/` does not implement it. HEX is one of
 * the four declared alphabets and 1 in 16 of its characters is a letter, so a
 * hex token that happens to draw no digit — `/verify/deadbeef`,
 * `/verify/abcdef`, `/verify/facade` — carried no digit and printed VERBATIM.
 * Measured, not supposed. It is a narrow slice of the token space (a 6-char
 * all-letter hex run is ~0.3% of it) and that is irrelevant: the slice is
 * reachable from a spec `linkExpectationSchema` accepts, a report is an
 * artifact a customer keeps, and a credential leaked 0.3% of the time is a
 * credential leaked.
 *
 * So the third rule is the HEX alphabet with no digit in it. The readability
 * words the length rule was chosen for — `reset`, `verify`, `invoices`,
 * `unsubscribe`, `app`, `account` — none of them are confined to [a-f], so
 * this costs none of them. It does over-redact a route word that happens to
 * be, `/cafe/` or `/faded/`, which is the safe direction and is what
 * "deliberately CONSERVATIVE" above already chose.
 *
 * WHAT IS STILL NOT COVERED, stated rather than left to be discovered: an
 * all-letter BASE64URL or MIXED token that reaches past `f` (`abcdefgh`,
 * `xyzzyplugh`) is indistinguishable from a route word by shape alone and
 * survives. That one is not a gap in the alphabet rule but a limit of shape
 * itself — closing it needs the spec's declared `where`, which is
 * `describeLinkToken`'s job and deliberately not this one's.
 */
const MIN_REDACTED_TOKEN_SEGMENT = 4;

/**
 * Is this short segment credential-shaped despite being short?
 *
 * Three rules, because the declared alphabets are four and one of them does
 * not need a digit. An all-digit run is the OTP case; a run that mixes a digit
 * into an otherwise URL-safe token alphabet is the same credential in HEX,
 * BASE64URL or MIXED; and a run confined to the HEX alphabet is a hex token
 * whether or not it drew a digit. All three are measured against the same
 * floor, so `/v1/`, `/en/` and `/us/` stay readable.
 */
function shortButCredentialShaped(segment: string): boolean {
  if (segment.length < MIN_REDACTED_TOKEN_SEGMENT) return false;
  if (/^[0-9]+$/.test(segment)) return true;
  if (/^[0-9A-Za-z_-]+$/.test(segment) && /[0-9]/.test(segment)) return true;
  // The digitless hex token. See the third section of MIN_REDACTED_TOKEN_SEGMENT's
  // comment for why the readability words survive this.
  return /^[0-9a-fA-F]+$/.test(segment);
}

/**
 * A URL reduced to the parts that are evidence, with the parts that are
 * credentials removed.
 *
 * The rule is deliberately CONSERVATIVE and not spec-driven, which is the
 * opposite choice to {@link describeLinkToken} and the right one: describing a
 * token is an assertion and must only look where the author said, while
 * redacting is a safety property and must cover every place a token could be.
 * So: every long path segment goes, EVERY query value goes whatever its name,
 * and the fragment is dropped whole — `#access_token=…` is the single most
 * common place a bearer token hides and no fragment is worth the risk.
 *
 * Length is preserved in the replacement count? No — deliberately not. The
 * length is reported separately and only when the spec asked for it, via
 * {@link LinkToken}; baking it into every printed URL would leak a
 * fingerprint of the token space into every artifact for no assertion's sake.
 */
export function redactLink(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '(unparseable link)';
  }

  /*
   * ── THE DEFECT THIS BRANCH IS THE ANSWER TO ─────────────────────────────
   *
   * `new URL('mailto:support@shop.example.com')` SUCCEEDS, and for a non-special
   * scheme the path is OPAQUE: assigning to `url.pathname` is a silent no-op.
   * So the segment redaction below ran, changed nothing, and this function
   * returned its input unmodified — a `mailto:`, `tel:`, `sms:` or custom
   * app-scheme deep link (`shopapp://reset/<token>`) went into a step title
   * verbatim, token and all. The redaction LOOKED applied and was not, which is
   * the worst shape a safety function can have.
   *
   * A custom scheme is exactly where a mobile reset link lives, so this is not
   * a hypothetical. Anything that is not http(s) is reduced to its scheme: the
   * structure below cannot be reasoned about, and a link whose shape we cannot
   * parse is a link we must not print.
   */
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `(${url.protocol.replace(/:$/, '')} link, redacted)`;
  }

  if (url.username) url.username = REDACTED;
  if (url.password) url.password = REDACTED;

  url.pathname = url.pathname
    .split('/')
    .map((segment) =>
      segment.length > MAX_SAFE_SEGMENT_LENGTH || shortButCredentialShaped(segment)
        ? REDACTED
        : segment,
    )
    .join('/');

  for (const key of [...url.searchParams.keys()]) {
    url.searchParams.set(key, REDACTED);
  }

  url.hash = '';
  return url.toString();
}

/**
 * Credential-shaped runs, masked, in a string that is about to be printed.
 *
 * DERIVED FROM `SECRET_SHAPES`, never a hand-written parallel list. The round
 * before this one probed 16 of 27 declared shapes with a hand-written list and
 * nobody noticed, which is the whole argument: a vocabulary with two copies has
 * one that is wrong.
 *
 * An application that mails its own API key is a real defect of theirs, and
 * echoing the key into a step title, an error message or an artifact would be
 * our defect stacked on top — so the excerpt is masked BEFORE the length limit
 * is applied, because truncating first can leave a prefix that is still a
 * usable credential.
 */
export function safeExcerpt(text: string, limit = 200): string {
  let masked = text;
  for (const shape of SECRET_SHAPES) {
    /*
     * The prefix plus the run that follows it. Escaped, because `-----BEGIN`
     * and `ya29.` both contain regex metacharacters, and an unescaped `.` here
     * would match one character of anything.
     */
    const prefix = shape.prefix.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    masked = masked.replace(
      new RegExp(`${prefix}[A-Za-z0-9_\\-./+=]*`, 'g'),
      `[redacted: ${shape.what}]`,
    );
  }
  return masked.length > limit ? `${masked.slice(0, limit)}…` : masked;
}

// ─── Host screening ──────────────────────────────────────────────────────────

/**
 * Whether a host may be connected to, and whether we actually checked.
 *
 * `resolved: false` is the field rule 12 requires. The static classification
 * alone cannot tell `mail.internal.corp` from `mail.example.com`, so a decision
 * taken without a resolver is a decision that did not look — and reporting it
 * as "screened" would be a thing reported as measured that was not measured.
 */
export interface HostDecision {
  readonly allowed: boolean;
  /** Never empty, in either direction. It is what the step prints. */
  readonly reason: string;
  /** False when only the static rules ran because no resolver was supplied. */
  readonly resolved: boolean;
}

/**
 * Screen a host before a byte is sent to it.
 *
 * The literal and private-name cases are decided by `classifyHost`, which
 * touches no resolver; a public-looking NAME is then put through
 * `resolvesPublicly` when — and only when — a lookup is injected. Tests inject
 * a fake one, so nothing in this file's test suite performs DNS.
 */
export async function screenHost(
  rawHost: string,
  lookup: LookupFn | null,
): Promise<HostDecision> {
  const verdict = classifyHost(rawHost);

  if (verdict.kind === 'ambiguous') {
    return { allowed: false, reason: `Refusing ${verdict.host}: ${verdict.why}.`, resolved: true };
  }
  if (verdict.kind === 'address') {
    return verdict.class === 'public'
      ? { allowed: true, reason: `${verdict.host} is a public address.`, resolved: true }
      : {
          allowed: false,
          reason: `Refusing ${verdict.host}: that is a ${verdict.class} address.`,
          resolved: true,
        };
  }
  if (verdict.internal) {
    return {
      allowed: false,
      reason: `Refusing ${verdict.host}: that name resolves inside a private network.`,
      resolved: true,
    };
  }

  if (lookup === null) {
    return {
      allowed: true,
      reason:
        `${verdict.host} passed the static rules and was NOT resolved — no resolver was ` +
        'supplied to this run, so whether it points at a private address is unknown.',
      resolved: false,
    };
  }

  const resolution = await resolvesPublicly(verdict.host, lookup);
  return resolution.ok
    ? {
        allowed: true,
        reason: `${verdict.host} resolves to ${resolution.addresses.length} public address(es).`,
        resolved: true,
      }
    : { allowed: false, reason: resolution.reason, resolved: true };
}

// ─── The spec ────────────────────────────────────────────────────────────────

export const linkExpectationSchema = z
  .object({
    /**
     * Substring of the href or the link text that identifies WHICH link. Not a
     * regex: a mail body is attacker-adjacent data (the application renders a
     * customer's own name into it), and compiling a pattern out of a spec that
     * a crawl proposed is a different risk from matching a literal.
     */
    match: z.string().min(1).max(300),
    /** The status the link must answer with. Absent = any completed response. */
    expectStatus: z.number().int().min(100).max(599).optional(),
    /** Where it must LAND after redirects — the half that silently rots. */
    expectFinalPathPrefix: z.string().min(1).max(300).optional(),
    /** The credential it must carry. See {@link describeLinkToken}. */
    token: z
      .object({
        where: z.enum(LINK_TOKEN_PLACES),
        minLength: z.number().int().min(6).max(4096),
        alphabet: z.enum(LINK_TOKEN_ALPHABETS),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((l) => l.expectStatus !== undefined || l.expectFinalPathPrefix !== undefined || l.token, {
    message:
      'this link expectation asserts nothing beyond the link existing, so it would pass on a ' +
      'link that 404s — which is the defect the LINKS assertion exists to catch',
  });
export type LinkExpectation = z.infer<typeof linkExpectationSchema>;

export const attachmentExpectationSchema = z
  .object({
    /** Substring of the filename. `invoice` matches `invoice-000931.pdf`. */
    filenameContains: z.string().min(1).max(200),
    /** The declared content type, exactly. */
    contentType: z.string().min(3).max(120),
    /**
     * Required, with no default and a floor of 1.
     *
     * A zero-byte invoice is the archetypal document defect: the mail sends,
     * the attachment is listed, the client shows an icon, and the file is
     * empty. A `minBytes` default of 0 would assert exactly nothing while
     * looking like a size check.
     */
    minBytes: z.number().int().min(1).max(100_000_000),
  })
  .strict();
export type AttachmentExpectation = z.infer<typeof attachmentExpectationSchema>;

/**
 * Markers that mean a template did not render.
 *
 * A default, unlike `minBytes`, and the difference is defensible: these are
 * universal across every template engine in use, a spec that had to list them
 * would list them wrong, and the cost of a false positive is a readable
 * failure rather than a silent pass. `undefined` and `null` are the JavaScript
 * ones; `{{` and `${` cover Handlebars, Liquid, Jinja and template literals;
 * `Lorem` catches the placeholder copy that ships when a template is cloned.
 */
export const DEFAULT_PLACEHOLDER_MARKERS: readonly string[] = [
  '{{',
  '}}',
  '${',
  '%s',
  'undefined',
  'null',
  'NaN',
  'Lorem',
  'TODO',
];

export const emailTestSpecSchema = z
  .object({
    /** The vault name of the address, mirroring `emailOtpSpecSchema`. */
    recipientSecretName: z.string().min(1).max(200).default('QAAI_TEST_EMAIL'),
    /** A literal address, when the run has no secret for it. */
    recipient: z.string().min(3).max(320).optional(),
    /** The mail sink. Absolute, or relative to the environment's base URL. */
    mailboxUrl: z.string().min(1).max(500),
    /**
     * The template identity, which is what a mailbox assertion matches on —
     * the words `DimensionDetail` uses for the EMAIL dimension. Null means
     * "whatever arrived for this recipient", which is correct for an app that
     * stamps no template header.
     */
    templateId: z.string().min(1).max(200).nullable().default(null),
    trigger: emailTriggerSchema,
    assertions: z.array(emailAssertionSchema).min(1),
    /** The author's own delivery bound. See the file header on why it bites. */
    timeoutSeconds: z.number().int().min(1).max(600).default(60),
    pollIntervalMs: z.number().int().min(50).max(60_000).default(1_000),
    expectSubject: z.string().min(1).max(300).optional(),
    expectFrom: z.string().min(3).max(320).optional(),
    expectReplyTo: z.string().min(3).max(320).optional(),
    /** Named values the body must render: a total, a name, a date. */
    expectValues: z.array(z.string().min(1).max(300)).max(40).default([]),
    links: z.array(linkExpectationSchema).max(40).default([]),
    attachments: z.array(attachmentExpectationSchema).max(20).default([]),
    /**
     * Following an unsubscribe link UNSUBSCRIBES SOMEBODY, which is a write.
     *
     * Absent means the link's presence is asserted and it is NOT followed, and
     * the step says so — `notAsserted` with WOULD_MUTATE_PROTECTED_DATA rather
     * than a pass that implies the link works. `mayFollow` is the author's
     * explicit statement that the recipient is disposable.
     */
    unsubscribe: z
      .object({ mayFollow: z.boolean() })
      .strict()
      .optional(),
    /** BCP-47 tag the mail must declare. */
    expectLocale: z.string().min(2).max(35).optional(),
    placeholderMarkers: z
      .array(z.string().min(1).max(40))
      .max(40)
      .default([...DEFAULT_PLACEHOLDER_MARKERS]),
    /** Holes this test knowingly leaves, in the keystone's vocabulary. */
    notAsserted: z
      .array(
        z
          .object({ assertion: z.string().min(1).max(300), reason: unassertedReasonSchema })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();
export type EmailTestSpec = z.infer<typeof emailTestSpecSchema>;

/**
 * Assertions that are meaningless without a field the spec may not carry.
 *
 * A function rather than a pile of zod refinements, for the reason jobs.ts
 * gives: these are checked in `validate`, which runs before the trigger fires,
 * so a test author learns about the typo instead of waiting for a run and
 * getting an UNAVAILABLE back. A refine would also be unable to name more than
 * one missing field per parse.
 */
export function missingEmailFields(spec: EmailTestSpec): string[] {
  const missing: string[] = [];
  const asserts = (a: EmailAssertion): boolean => spec.assertions.includes(a);

  if (asserts('SUBJECT') && spec.expectSubject === undefined) {
    missing.push('SUBJECT needs `expectSubject`');
  }
  if (asserts('SENDER') && spec.expectFrom === undefined && spec.expectReplyTo === undefined) {
    missing.push('SENDER needs `expectFrom` or `expectReplyTo`');
  }
  if (asserts('BODY_VALUES') && spec.expectValues.length === 0) {
    missing.push('BODY_VALUES needs at least one entry in `expectValues`');
  }
  if (asserts('LINKS') && spec.links.length === 0) {
    missing.push('LINKS needs at least one entry in `links`');
  }
  if (asserts('LINK_TOKEN_SHAPE') && !spec.links.some((l) => l.token)) {
    missing.push('LINK_TOKEN_SHAPE needs a `links` entry carrying a `token`');
  }
  if (asserts('ATTACHMENTS') && spec.attachments.length === 0) {
    missing.push('ATTACHMENTS needs at least one entry in `attachments`');
  }
  if (asserts('LOCALE') && spec.expectLocale === undefined) {
    missing.push('LOCALE needs `expectLocale`');
  }
  if (asserts('NO_PLACEHOLDERS') && spec.placeholderMarkers.length === 0) {
    missing.push(
      'NO_PLACEHOLDERS was asked for with an empty `placeholderMarkers`, which asserts nothing',
    );
  }
  return missing;
}

// ─── The injected mailbox ────────────────────────────────────────────────────

/**
 * One attachment, as a mail sink reports it.
 *
 * `bytes` is NULLABLE AND NULL IS NOT EMPTY. MailHog lists attachment metadata
 * and hands the body over on a second request; Mailosaur returns a download
 * URL. A sink that has not been asked for the bytes yet reports null, and the
 * ATTACHMENTS assertion reads null as UNKNOWN. `new Uint8Array(0)` would be a
 * null that became a zero — rule 12's second entry — and it would fail a
 * `minBytes` check as though the invoice were empty.
 */
export interface MailAttachment {
  readonly filename: string;
  readonly contentType: string;
  /** As the sink declares it. Checked against `bytes.length` when both exist. */
  readonly sizeBytes: number;
  readonly bytes: Uint8Array | null;
}

/**
 * One delivered message.
 *
 * A STRICT SUPERSET of the four fields `email-otp.ts` reads, so that file can
 * adopt this interface without changing a line of its own logic — see the file
 * header. `html` is nullable because a text-only mail is normal and an empty
 * string would claim an empty HTML part exists.
 */
export interface DeliveredMail {
  readonly to: string;
  readonly from: string;
  readonly replyTo: string | null;
  readonly subject: string;
  readonly text: string;
  readonly html: string | null;
  /** LOWER-CASED keys. A sink that preserves case makes `content-language` unfindable. */
  readonly headers: Readonly<Record<string, string>>;
  readonly attachments: readonly MailAttachment[];
  readonly receivedAt: string;
}

export interface MailboxQuery {
  readonly to: string;
  /** ISO. Mail older than this is somebody else's test. */
  readonly since: string;
  /** Match on the template identity when the app stamps one. Null = any. */
  readonly templateId: string | null;
}

/**
 * The mailbox, as this plugin needs it.
 *
 * ONE method, on purpose: MailHog, Mailpit, Mailosaur, Ethereal, a Maildir and
 * the bundled demo sink at `/__mail` all satisfy it, which is the point. A
 * richer interface would have been one sink's API with the serial numbers filed
 * off, and the second adapter would not have fitted it.
 *
 * AN EMPTY ARRAY MEANS "the sink holds nothing for this recipient yet". It does
 * NOT mean "no mail was sent", and the distinction is what keeps a slow
 * provider from being reported as a broken template.
 */
export interface MailboxReader {
  list(query: MailboxQuery): Promise<readonly DeliveredMail[]>;
}

export interface LinkProbeResult {
  /** HTTP status, or null when the request never completed. */
  readonly status: number | null;
  /** Where it ended up after redirects. RAW — redact before printing. */
  readonly finalUrl: string | null;
  /** Why it could not be probed. Null on a completed request. */
  readonly unreachable: string | null;
}

export interface LinkProbe {
  probe(url: string): Promise<LinkProbeResult>;
}

export interface MailTriggerResult {
  readonly fired: boolean;
  /** Printable verbatim. On `fired: false`, why not. */
  readonly detail: string;
}

/** Causes the mail. `EXTERNAL` never reaches this surface. */
export interface MailTrigger {
  fire(trigger: EmailTriggerSpec, baseUrl: string): Promise<MailTriggerResult>;
}

/**
 * Injected so tests do not sleep and a cancelled run stops waiting.
 *
 * Structurally identical to `JobClock` in ./jobs.ts and deliberately NOT
 * imported from it: a plugin importing another plugin couples two independently
 * promotable types, and the shapes are mutually assignable anyway, so one fake
 * serves both. Consolidating the three into a runner-level module is named in
 * the handover rather than done here, because that file is not this change's.
 */
export interface MailClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const realMailClock: MailClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    }),
};

export interface EmailDeps {
  mailbox: MailboxReader;
  links: LinkProbe;
  trigger: MailTrigger;
  clock?: MailClock;
  /**
   * The DNS resolver {@link screenHost} uses. Null means "do not resolve", and
   * the decision then reports `resolved: false` rather than claiming a check.
   */
  lookup?: LookupFn | null;
}

// ─── The bounded wait ────────────────────────────────────────────────────────

/** The mail never showed up inside the bound. Never a pass. See {@link deliveryStatus}. */
export const EMAIL_NOT_DELIVERED = 'NOT_DELIVERED' as const;

export type MailWaitOutcome = 'ARRIVED' | typeof EMAIL_NOT_DELIVERED | 'CANCELLED';

export interface MailWaitResult {
  readonly outcome: MailWaitOutcome;
  readonly mail: DeliveredMail | null;
  /** How long we actually waited, for the disclosure sentence. */
  readonly waitedMs: number;
  /** How many times the sink was asked. */
  readonly polls: number;
}

/**
 * Poll the sink until a matching message lands, the budget expires, or the run
 * is cancelled.
 *
 * Exported and tested directly against a fake clock: it is the
 * honesty-critical primitive of this plugin, and a bug here turns slow
 * providers into reported defects across every EMAIL test at once.
 *
 * The sink is asked ONCE before any sleeping, so a mail that was already there
 * does not pay a poll interval — and a wait of 0 elapsed ms can still return
 * ARRIVED rather than NOT_DELIVERED.
 */
export async function waitForMail(
  mailbox: MailboxReader,
  query: MailboxQuery,
  budgetMs: number,
  pollIntervalMs: number,
  signal: AbortSignal,
  clock: MailClock,
): Promise<MailWaitResult> {
  const startedAt = clock.now();
  let polls = 0;

  for (;;) {
    if (signal.aborted) {
      return { outcome: 'CANCELLED', mail: null, waitedMs: clock.now() - startedAt, polls };
    }

    polls += 1;
    const messages = await mailbox.list(query);
    /*
     * The NEWEST match, not the first. A sink that returns oldest-first would
     * otherwise hand back the previous run's receipt — which has the right
     * subject, the right sender and the WRONG total, and passes.
     */
    const newest = newestOf(messages);
    if (newest !== null) {
      return { outcome: 'ARRIVED', mail: newest, waitedMs: clock.now() - startedAt, polls };
    }

    const elapsed = clock.now() - startedAt;
    if (elapsed >= budgetMs) {
      return { outcome: EMAIL_NOT_DELIVERED, mail: null, waitedMs: elapsed, polls };
    }

    // Never sleep past the budget: a 1000ms interval on a 200ms remainder would
    // report having waited 1200ms against a 200ms budget, and the disclosure
    // sentence has to be true about the number it prints.
    await clock.sleep(Math.min(pollIntervalMs, budgetMs - elapsed), signal);
  }
}

function newestOf(messages: readonly DeliveredMail[]): DeliveredMail | null {
  let best: DeliveredMail | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    const at = Date.parse(message.receivedAt);
    // An unparseable timestamp must not win a comparison against a real one,
    // and must not be discarded either: it is still a delivered message.
    const rank = Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
    if (best === null || rank > bestAt) {
      best = message;
      bestAt = rank;
    }
  }
  return best;
}

/**
 * The sentence a non-delivery is reported with.
 *
 * Exported so the test can assert its exact content: rule 10 requires a cap
 * that bit to be reported as a count AND a reason, and this is both — the
 * elapsed wait, the poll count, the budget and WHO fired the trigger, because
 * that last fact is what decides whether this is a failure at all.
 */
export function notDeliveredWhy(
  trigger: EmailTriggerSpec,
  budgetMs: number,
  waitedMs: number,
  polls: number,
): string {
  const cause =
    trigger.kind === 'EXTERNAL'
      ? `Nothing in this test caused the mail — "${trigger.target}" was supposed to have. So ` +
        'this run cannot establish that the cause ever happened, and claims nothing about your ' +
        'application in either direction.'
      : `QAAI fired ${trigger.kind} ${trigger.target} and it succeeded, so the cause DID happen ` +
        'and the mail did not follow it.';
  return (
    `NOT_DELIVERED: no matching mail reached the sink in ${waitedMs}ms (${polls} poll(s)) ` +
    `against the ${budgetMs}ms timeoutSeconds budget. ${cause} Raise \`timeoutSeconds\` if your ` +
    'provider is slower than this.'
  );
}

/**
 * The status a non-delivery produces. THE invariant of this file.
 *
 * One function, exported, so there is exactly one place that can get it wrong
 * and exactly one place a test can pin. The header argues the split at length;
 * the only thing that must never change is the first line of this body.
 */
export function deliveryStatus(triggerFired: boolean): TestResultStatus {
  // NEVER PASSED. Not under any trigger, not under any budget, not ever.
  return triggerFired ? 'FAILED' : 'SKIPPED';
}

// ─── Link extraction ─────────────────────────────────────────────────────────

export interface ExtractedLink {
  readonly href: string;
  /** The anchor text, trimmed and tag-stripped. Empty for a bare URL in text. */
  readonly text: string;
}

const ANCHOR = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))[^>]*>([\s\S]*?)<\/a>/gi;
const BARE_URL = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

/**
 * Every link in the message, from the HTML part and then the text part.
 *
 * Regex over the HTML rather than a parser, and the limitation is DECLARED
 * rather than discovered: a link that exists only in a CSS `background-image`,
 * an image map or a VML fallback is not extracted. Adding an HTML parser to the
 * runner for this would be a dependency on every worker image to read a mail
 * body, and the extraction that matters — `<a href>` and bare URLs — is what
 * every transactional template actually uses. The EMAIL declaration carries it
 * as `knownUnasserted` so a report can count it.
 *
 * Deduplicated on href, keeping the FIRST occurrence and therefore the anchor
 * text: the same URL usually appears once as a button and once as a bare
 * fallback, and probing it twice would double a write.
 */
export function extractLinks(mail: DeliveredMail): ExtractedLink[] {
  const found: ExtractedLink[] = [];
  const seen = new Set<string>();

  const push = (href: string, text: string): void => {
    const trimmed = href.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    found.push({ href: trimmed, text: text.trim() });
  };

  if (mail.html !== null) {
    for (const match of mail.html.matchAll(ANCHOR)) {
      const href = match[1] ?? match[2] ?? match[3] ?? '';
      const text = (match[4] ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
      push(href, text);
    }
  }
  for (const match of mail.text.matchAll(BARE_URL)) {
    push(match[0], '');
  }
  return found;
}

/** The link a spec entry names, by substring of href or anchor text. */
export function findLink(links: readonly ExtractedLink[], match: string): ExtractedLink | null {
  const needle = match.toLowerCase();
  return (
    links.find(
      (l) => l.href.toLowerCase().includes(needle) || l.text.toLowerCase().includes(needle),
    ) ?? null
  );
}

/** Unsubscribe, by the header RFC 8058 defines or by the link every client looks for. */
const UNSUBSCRIBE_TEXT = /unsubscribe|opt[\s-]?out|abmelden|désabonner|darse de baja/i;

export function findUnsubscribe(mail: DeliveredMail): {
  readonly viaHeader: string | null;
  readonly link: ExtractedLink | null;
} {
  const header = mail.headers['list-unsubscribe'] ?? null;
  const link =
    extractLinks(mail).find(
      (l) => UNSUBSCRIBE_TEXT.test(l.text) || UNSUBSCRIBE_TEXT.test(l.href),
    ) ?? null;
  return { viaHeader: header, link };
}

// ─── Assertions ──────────────────────────────────────────────────────────────

/**
 * An assertion's verdict.
 *
 * Four states and not two, for the same reason the wait has three outcomes: an
 * assertion we could not evaluate must not be scored in either direction.
 * UNKNOWN is "we looked and the evidence is absent" (the sink did not hand over
 * the attachment bytes); UNAVAILABLE is "there is no surface here to look
 * through" (no link probe is configured).
 */
export type EmailVerdict = 'MET' | 'UNMET' | 'UNKNOWN' | 'UNAVAILABLE';

/**
 * The keystone's `UnassertedReason`, taken off the zod enum rather than off
 * `./test-type-decl`.
 *
 * Not a style choice: `test-type-decl.ts` is NOT on @qaai/shared's barrel, and
 * reaching it by relative path across the workspace boundary is the exact
 * defect lesson B records — nine files did it in one round and it surfaced as
 * TS2305 somewhere else entirely. `unassertedReasonSchema` IS exported through
 * the barrel from ./schemas, so this derives the same closed union through the
 * package's front door. The barrel line is in the handover.
 */
type UnassertedReasonName = z.infer<typeof unassertedReasonSchema>;

export interface EmailAssertionResult {
  readonly assertion: EmailAssertion;
  readonly verdict: EmailVerdict;
  /** Printable verbatim. Already redacted and excerpted. */
  readonly detail: string;
  /** Holes this assertion left, in the keystone's vocabulary. */
  readonly notAsserted?: ReadonlyArray<{ assertion: string; reason: UnassertedReasonName }>;
}

const met = (assertion: EmailAssertion, detail: string): EmailAssertionResult => ({
  assertion,
  verdict: 'MET',
  detail,
});
const unmet = (assertion: EmailAssertion, detail: string): EmailAssertionResult => ({
  assertion,
  verdict: 'UNMET',
  detail,
});

/** The body a value assertion reads: both parts, because a value may be in either. */
function bodyOf(mail: DeliveredMail): string {
  return mail.html === null ? mail.text : `${mail.text}\n${mail.html}`;
}

/**
 * Evaluate one assertion against a delivered message.
 *
 * DELIVERED is absent from this switch on purpose: it is settled before any of
 * these can run, by {@link waitForMail}, and a branch here would be a second
 * implementation of the one rule this file cannot afford to have two of.
 */
export async function runEmailAssertion(
  assertion: Exclude<EmailAssertion, 'DELIVERED'>,
  spec: EmailTestSpec,
  mail: DeliveredMail,
  deps: Required<Pick<EmailDeps, 'links'>> & { lookup: LookupFn | null },
): Promise<EmailAssertionResult> {
  switch (assertion) {
    case 'SUBJECT': {
      const expected = spec.expectSubject;
      if (expected === undefined) {
        return {
          assertion,
          verdict: 'UNAVAILABLE',
          detail: 'No `expectSubject` in the spec, so there was nothing to compare against.',
        };
      }
      return mail.subject.includes(expected)
        ? met(assertion, `Subject contains "${safeExcerpt(expected, 120)}".`)
        : unmet(
            assertion,
            `Subject is "${safeExcerpt(mail.subject, 160)}", which does not contain ` +
              `"${safeExcerpt(expected, 120)}".`,
          );
    }

    case 'SENDER': {
      const problems: string[] = [];
      if (spec.expectFrom !== undefined && !mail.from.includes(spec.expectFrom)) {
        problems.push(`from is "${safeExcerpt(mail.from, 120)}", expected "${spec.expectFrom}"`);
      }
      if (spec.expectReplyTo !== undefined) {
        if (mail.replyTo === null) {
          problems.push(
            `reply-to is absent, expected "${spec.expectReplyTo}" — a reply to this mail goes ` +
              'to the from address, which is usually a no-reply mailbox',
          );
        } else if (!mail.replyTo.includes(spec.expectReplyTo)) {
          problems.push(
            `reply-to is "${safeExcerpt(mail.replyTo, 120)}", expected "${spec.expectReplyTo}"`,
          );
        }
      }
      if (spec.expectFrom === undefined && spec.expectReplyTo === undefined) {
        return {
          assertion,
          verdict: 'UNAVAILABLE',
          detail: 'Neither `expectFrom` nor `expectReplyTo` is set, so nothing was compared.',
        };
      }
      return problems.length === 0
        ? met(assertion, 'The sender addresses are the ones the spec names.')
        : unmet(assertion, problems.join('; '));
    }

    case 'BODY_VALUES': {
      const body = bodyOf(mail);
      const absent = spec.expectValues.filter((value) => !body.includes(value));
      return absent.length === 0
        ? met(assertion, `All ${spec.expectValues.length} named value(s) are in the body.`)
        : unmet(
            assertion,
            `${absent.length} of ${spec.expectValues.length} named value(s) are NOT in the ` +
              `body: ${absent.map((v) => `"${safeExcerpt(v, 80)}"`).join(', ')}.`,
          );
    }

    case 'LINKS': {
      const links = extractLinks(mail);
      const problems: string[] = [];
      const holes: Array<{ assertion: string; reason: UnassertedReasonName }> = [];
      let probed = 0;

      for (const expectation of spec.links) {
        const link = findLink(links, expectation.match);
        if (link === null) {
          problems.push(`no link matching "${safeExcerpt(expectation.match, 80)}" is in the mail`);
          continue;
        }
        if (expectation.expectStatus === undefined && expectation.expectFinalPathPrefix === undefined) {
          // Token-only expectation; LINK_TOKEN_SHAPE owns it.
          continue;
        }

        const host = hostOf(link.href);
        if (host === null) {
          problems.push(`"${redactLink(link.href)}" is not a URL this run can resolve a host from`);
          continue;
        }
        const decision = await screenHost(host, deps.lookup);
        if (!decision.allowed) {
          holes.push({
            assertion: `following ${redactLink(link.href)}`,
            reason: 'REQUIRES_PROVISIONED_SANDBOX',
          });
          problems.push(`refused to follow ${redactLink(link.href)}: ${decision.reason}`);
          continue;
        }

        const result = await deps.links.probe(link.href);
        probed += 1;
        if (result.status === null) {
          holes.push({ assertion: `following ${redactLink(link.href)}`, reason: 'CAPABILITY_ABSENT' });
          problems.push(
            `${redactLink(link.href)} could not be probed: ${result.unreachable ?? 'no reason given'}`,
          );
          continue;
        }
        if (expectation.expectStatus !== undefined && result.status !== expectation.expectStatus) {
          problems.push(
            `${redactLink(link.href)} answered ${result.status}, expected ${expectation.expectStatus}`,
          );
        }
        if (expectation.expectFinalPathPrefix !== undefined) {
          const landedPath = pathOf(result.finalUrl);
          if (landedPath === null) {
            problems.push(
              `${redactLink(link.href)} answered ${result.status} and the probe reported no ` +
                'final URL, so where it LANDED is unknown',
            );
          } else if (!landedPath.startsWith(expectation.expectFinalPathPrefix)) {
            problems.push(
              `${redactLink(link.href)} landed on "${landedPath}", which does not start with ` +
                `"${expectation.expectFinalPathPrefix}"`,
            );
          }
        }
      }

      if (problems.length > 0) {
        return { assertion, verdict: 'UNMET', detail: problems.join(' | '), notAsserted: holes };
      }
      if (probed === 0 && spec.links.length > 0) {
        return {
          assertion,
          verdict: 'UNKNOWN',
          detail:
            `All ${spec.links.length} link expectation(s) were found in the mail and NONE was ` +
            'followed, so nothing is claimed about where they go.',
          notAsserted: holes,
        };
      }
      return {
        ...met(assertion, `${probed} link(s) resolved and landed where the spec says.`),
        notAsserted: holes,
      };
    }

    case 'LINK_TOKEN_SHAPE': {
      const links = extractLinks(mail);
      const problems: string[] = [];
      let checked = 0;

      for (const expectation of spec.links) {
        const want = expectation.token;
        if (want === undefined) continue;
        const link = findLink(links, expectation.match);
        if (link === null) {
          problems.push(`no link matching "${safeExcerpt(expectation.match, 80)}" is in the mail`);
          continue;
        }
        const token = describeLinkToken(link.href, want.where);
        checked += 1;
        if (token === null) {
          problems.push(
            `${redactLink(link.href)} carries no token in its ${want.where} — a link that is ` +
              'supposed to authenticate somebody and carries nothing is the defect',
          );
          continue;
        }
        if (token.length < want.minLength) {
          problems.push(
            `${redactLink(link.href)} carries a ${token.length}-character token in its ` +
              `${want.where}, below the ${want.minLength} the spec requires`,
          );
        }
        if (!alphabetSatisfies(token.alphabet, want.alphabet)) {
          problems.push(
            `${redactLink(link.href)} carries a ${token.alphabet} token in its ${want.where}, ` +
              `which is wider than the ${want.alphabet} the spec requires`,
          );
        }
      }

      if (checked === 0) {
        return {
          assertion,
          verdict: 'UNAVAILABLE',
          detail: 'No `links` entry carries a `token`, so no shape was described.',
        };
      }
      return problems.length === 0
        ? met(assertion, `${checked} link token(s) match the declared shape.`)
        : unmet(assertion, problems.join(' | '));
    }

    case 'ATTACHMENTS': {
      const problems: string[] = [];
      const unknowns: string[] = [];
      const holes: Array<{ assertion: string; reason: UnassertedReasonName }> = [];

      for (const expectation of spec.attachments) {
        const found = mail.attachments.find((a) =>
          a.filename.toLowerCase().includes(expectation.filenameContains.toLowerCase()),
        );
        if (found === undefined) {
          problems.push(
            `no attachment whose name contains "${expectation.filenameContains}" ` +
              `(the mail carries ${mail.attachments.length})`,
          );
          continue;
        }
        if (found.contentType !== expectation.contentType) {
          problems.push(
            `"${found.filename}" is declared ${found.contentType}, expected ` +
              `${expectation.contentType}`,
          );
        }
        if (found.bytes === null) {
          /*
           * NULL IS NOT EMPTY. The sink listed the attachment and did not hand
           * the body over, so its size is unknown — and a `minBytes` failure
           * here would report a zero-byte invoice that nobody has looked at.
           */
          unknowns.push(
            `"${found.filename}" was listed at ${found.sizeBytes} declared byte(s) and the sink ` +
              'did not hand over the body, so its real size and type are unverified',
          );
          holes.push({
            assertion: `the bytes of "${found.filename}"`,
            reason: 'CAPABILITY_ABSENT',
          });
          continue;
        }
        if (found.bytes.length < expectation.minBytes) {
          problems.push(
            `"${found.filename}" is ${found.bytes.length} byte(s), below the ` +
              `${expectation.minBytes} the spec requires`,
          );
        }
        if (found.bytes.length !== found.sizeBytes) {
          problems.push(
            `"${found.filename}" declares ${found.sizeBytes} byte(s) and carries ` +
              `${found.bytes.length}`,
          );
        }
        const sniffed = sniffContentType(found.bytes);
        if (sniffed !== null && sniffed !== expectation.contentType) {
          problems.push(
            `"${found.filename}" declares ${expectation.contentType} and its first bytes are ` +
              `${sniffed} — the file is not what the header says it is`,
          );
        }
      }

      if (problems.length > 0) {
        return { assertion, verdict: 'UNMET', detail: problems.join(' | '), notAsserted: holes };
      }
      if (unknowns.length > 0) {
        return {
          assertion,
          verdict: 'UNKNOWN',
          detail: unknowns.join(' | '),
          notAsserted: holes,
        };
      }
      return met(assertion, `${spec.attachments.length} attachment(s) are named, typed and sized.`);
    }

    case 'UNSUBSCRIBE': {
      const { viaHeader, link } = findUnsubscribe(mail);
      if (viaHeader === null && link === null) {
        return unmet(
          assertion,
          'The mail carries neither a List-Unsubscribe header nor a link a client would ' +
            'recognise as one.',
        );
      }
      const present = viaHeader !== null ? 'a List-Unsubscribe header' : 'an unsubscribe link';

      if (link === null) {
        return {
          assertion,
          verdict: 'UNKNOWN',
          detail:
            `The mail carries ${present} and no clickable unsubscribe link, so whether a reader ` +
            'can actually unsubscribe is unverified.',
          notAsserted: [{ assertion: 'that unsubscribing works', reason: 'NOT_IMPLEMENTED' }],
        };
      }
      if (spec.unsubscribe === undefined || !spec.unsubscribe.mayFollow) {
        /*
         * Following it UNSUBSCRIBES SOMEBODY. Reported as a stated hole rather
         * than as a pass: "the link is present" and "the link works" are
         * different claims and the second is what a customer reads this as.
         */
        return {
          assertion,
          verdict: 'UNKNOWN',
          detail:
            `The mail carries ${present} at ${redactLink(link.href)} and it was NOT followed — ` +
            'following it unsubscribes the recipient, which is a write this run did not make. ' +
            'Set `unsubscribe.mayFollow` for a disposable recipient to have it exercised.',
          notAsserted: [
            { assertion: 'that unsubscribing works', reason: 'WOULD_MUTATE_PROTECTED_DATA' },
          ],
        };
      }

      const host = hostOf(link.href);
      if (host === null) {
        return unmet(
          assertion,
          `The unsubscribe target ${redactLink(link.href)} is not a URL with a resolvable host.`,
        );
      }
      const decision = await screenHost(host, deps.lookup);
      if (!decision.allowed) {
        return {
          assertion,
          verdict: 'UNAVAILABLE',
          detail: `Refused to follow the unsubscribe link: ${decision.reason}`,
          notAsserted: [
            { assertion: 'that unsubscribing works', reason: 'REQUIRES_PROVISIONED_SANDBOX' },
          ],
        };
      }
      const result = await deps.links.probe(link.href);
      if (result.status === null) {
        return {
          assertion,
          verdict: 'UNKNOWN',
          detail:
            `The unsubscribe link could not be probed: ${result.unreachable ?? 'no reason given'}.`,
          notAsserted: [{ assertion: 'that unsubscribing works', reason: 'CAPABILITY_ABSENT' }],
        };
      }
      return result.status >= 200 && result.status < 400
        ? met(assertion, `The unsubscribe link answered ${result.status}.`)
        : unmet(
            assertion,
            `The unsubscribe link answered ${result.status} — a reader who clicks it cannot ` +
              'unsubscribe, which is the one link that is legally required to work.',
          );
    }

    case 'LOCALE': {
      const expected = spec.expectLocale;
      if (expected === undefined) {
        return {
          assertion,
          verdict: 'UNAVAILABLE',
          detail: 'No `expectLocale` in the spec, so nothing was compared.',
        };
      }
      const declared = mail.headers['content-language'] ?? null;
      if (declared === null) {
        /*
         * No header is UNKNOWN and emphatically not a pass. Inferring the
         * language from the body would be a guess dressed as a measurement, and
         * the one defect this assertion exists for — the German customer who
         * got the English receipt — is exactly the case where the body looks
         * fine to a matcher that does not read German.
         */
        return {
          assertion,
          verdict: 'UNKNOWN',
          detail:
            `The mail declares no Content-Language header, so whether it is in "${expected}" is ` +
            'unverified. QAAI does not guess a language from body text.',
          notAsserted: [
            { assertion: 'the mail’s locale', reason: 'SURFACE_UNREACHED' },
          ],
        };
      }
      const normalise = (tag: string): string => tag.trim().toLowerCase().replace(/_/g, '-');
      return normalise(declared).startsWith(normalise(expected))
        ? met(assertion, `The mail declares Content-Language "${declared}".`)
        : unmet(
            assertion,
            `The mail declares Content-Language "${safeExcerpt(declared, 60)}", expected ` +
              `"${expected}".`,
          );
    }

    case 'NO_PLACEHOLDERS': {
      const body = `${mail.subject}\n${bodyOf(mail)}`;
      const hits = spec.placeholderMarkers.filter((marker) => body.includes(marker));
      return hits.length === 0
        ? met(
            assertion,
            `None of the ${spec.placeholderMarkers.length} placeholder marker(s) survived into ` +
              'the subject or body.',
          )
        : unmet(
            assertion,
            `The mail still contains ${hits.length} unrendered marker(s): ` +
              `${hits.map((h) => `"${h}"`).join(', ')}. Somebody received this.`,
          );
    }
  }
}

function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

function pathOf(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    return new URL(raw).pathname;
  } catch {
    return null;
  }
}

/**
 * The content type the first bytes actually say, or null when we do not know.
 *
 * Five signatures, chosen because they are what transactional mail attaches:
 * PDF invoices and statements, ZIP exports (and every OOXML document, which is
 * a ZIP), PNG and JPEG logos and QR codes. NULL IS "we do not recognise this",
 * never "it is wrong": a CSV has no magic number and must not be reported as a
 * type mismatch.
 */
export function sniffContentType(bytes: Uint8Array): string | null {
  const startsWith = (...signature: number[]): boolean =>
    signature.length <= bytes.length && signature.every((byte, index) => bytes[index] === byte);

  if (startsWith(0x25, 0x50, 0x44, 0x46)) return 'application/pdf'; // %PDF
  if (startsWith(0x50, 0x4b, 0x03, 0x04)) return 'application/zip'; // PK\x03\x04
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  return null;
}

// ─── Step recording ──────────────────────────────────────────────────────────

class StepRecorder {
  readonly steps: StepResult[] = [];

  constructor(
    private readonly ctx: RunContext,
    private readonly testId: string,
  ) {}

  /**
   * Record an assertion.
   *
   * UNKNOWN and UNAVAILABLE are both SKIPPED steps with the reason in the
   * title, because `error` on a StepResult means "this failed" and neither of
   * them did. Only UNMET is a failure, and only UNMET is a statement about the
   * customer's application.
   */
  record(result: EmailAssertionResult, startedAtMs: number): void {
    const label = EMAIL_ASSERTION_LABELS[result.assertion];
    const status: StepResult['status'] =
      result.verdict === 'MET' ? 'PASSED' : result.verdict === 'UNMET' ? 'FAILED' : 'SKIPPED';
    const title = result.verdict === 'MET' ? label : `${label} — ${result.verdict}: ${result.detail}`;

    const index = this.steps.length;
    this.ctx.logger.step({ testId: this.testId, index, title, status });
    this.steps.push({
      index,
      title,
      status,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: Math.max(0, Date.now() - startedAtMs),
      screenshotKey: null,
      error:
        result.verdict === 'UNMET'
          ? { message: result.detail, stack: null, selector: null, expected: null, actual: null }
          : null,
    });
  }
}

// ─── Execution ───────────────────────────────────────────────────────────────

function errorText(err: unknown): string {
  return safeExcerpt(err instanceof Error ? err.message : String(err), 500);
}

/** Absolute, or resolved against the environment's base URL. Mirrors email-otp.ts. */
function absolute(target: string, baseUrl: string): string {
  return /^https?:\/\//i.test(target) ? target : new URL(target, baseUrl).toString();
}

/**
 * Run a transactional-email test against an injected mailbox, probe and trigger.
 *
 * The status rule:
 *
 *   · the mail did not arrive          → {@link deliveryStatus}. FAILED when
 *                                        this plugin fired the trigger and it
 *                                        succeeded; SKIPPED when the cause was
 *                                        EXTERNAL and may never have happened.
 *                                        NEVER PASSED.
 *   · the trigger itself failed        → SKIPPED, BLOCKED_BY_ENV. We never got
 *                                        as far as asking about the mail.
 *   · any UNMET                        → FAILED. A real statement about the app.
 *   · nothing MET or UNMET             → SKIPPED, NOT_RUN. A result with only
 *                                        UNKNOWNs in it is not a pass, and this
 *                                        is the line a hurried implementation
 *                                        crosses.
 *   · a mix of MET and UNKNOWN         → PASSED, with every unmeasured
 *                                        assertion disclosed on the result and
 *                                        in its own step.
 */
export async function runEmailTest(
  ctx: RunContext,
  test: ExecutableTest,
  spec: EmailTestSpec,
  deps: EmailDeps,
): Promise<TestExecution> {
  const startedAt = Date.now();
  const recorder = new StepRecorder(ctx, test.id);
  const notes: ConsoleEntry[] = [];
  const clock = deps.clock ?? realMailClock;
  const lookup = deps.lookup ?? null;

  const base = {
    testId: test.id,
    network: [],
    console: notes,
    videoKey: null,
    traceKey: null,
    retriedAndPassed: false,
    findings: [],
  } satisfies Omit<TestExecution, 'status' | 'steps' | 'errorMessage' | 'durationMs'>;

  const skipped = (kind: 'NOT_RUN' | 'BLOCKED_BY_ENV', why: string): TestExecution => ({
    ...base,
    status: 'SKIPPED',
    durationMs: Date.now() - startedAt,
    steps: recorder.steps,
    notRun: { kind, why },
    errorMessage: why,
  });

  const recipient = ctx.secrets[spec.recipientSecretName] ?? spec.recipient ?? '';
  if (recipient.length === 0) {
    return skipped(
      'BLOCKED_BY_ENV',
      `No recipient: set the secret ${spec.recipientSecretName} on this environment, or put an ` +
        'address in the spec. Nothing was measured.',
    );
  }

  // ── The mailbox host, before a byte goes to it ────────────────────────────
  const mailboxUrl = absolute(spec.mailboxUrl, ctx.baseUrl);
  const mailboxHost = hostOf(mailboxUrl);
  if (mailboxHost === null) {
    return skipped('BLOCKED_BY_ENV', `"${spec.mailboxUrl}" is not a URL with a host.`);
  }
  const mailboxDecision = await screenHost(mailboxHost, lookup);
  if (!mailboxDecision.allowed) {
    return skipped(
      'BLOCKED_BY_ENV',
      `The mail sink was not contacted. ${mailboxDecision.reason} Nothing was measured.`,
    );
  }
  if (!mailboxDecision.resolved) {
    notes.push({ level: 'warn', text: mailboxDecision.reason, at: new Date().toISOString() });
  }

  // ── The trigger ───────────────────────────────────────────────────────────
  const since = new Date(clock.now()).toISOString();
  let triggerFired = false;

  if (spec.trigger.kind === 'EXTERNAL') {
    recorder.record(
      {
        assertion: 'DELIVERED',
        verdict: 'UNKNOWN',
        detail:
          `The cause is EXTERNAL — "${safeExcerpt(spec.trigger.target, 160)}" — so this test did ` +
          'not fire it and cannot claim it happened.',
      },
      Date.now(),
    );
  } else {
    const triggerStartedAt = Date.now();
    let fired: MailTriggerResult;
    try {
      fired = await deps.trigger.fire(spec.trigger, ctx.baseUrl);
    } catch (err) {
      fired = { fired: false, detail: `The trigger surface threw: ${errorText(err)}` };
    }
    triggerFired = fired.fired;
    recorder.record(
      {
        assertion: 'DELIVERED',
        verdict: fired.fired ? 'MET' : 'UNAVAILABLE',
        detail: fired.fired
          ? `Fired ${spec.trigger.kind} ${spec.trigger.target}.`
          : `Could not fire ${spec.trigger.kind} ${spec.trigger.target}: ${fired.detail}`,
      },
      triggerStartedAt,
    );
    if (!fired.fired) {
      /*
       * BLOCKED_BY_ENV and not FAILED: a trigger we could not even send tells
       * us nothing about the template, and recording it as a failing test would
       * put a red mark on the customer's mail code on the strength of a broken
       * URL.
       */
      return skipped(
        'BLOCKED_BY_ENV',
        `The mail was never triggered, so nothing is claimed about "${test.name}". ${fired.detail}`,
      );
    }
  }

  // ── The wait ──────────────────────────────────────────────────────────────
  const budgetMs = spec.timeoutSeconds * 1_000;
  const waitStartedAt = Date.now();
  let wait: MailWaitResult;
  try {
    wait = await waitForMail(
      deps.mailbox,
      { to: recipient, since, templateId: spec.templateId },
      budgetMs,
      spec.pollIntervalMs,
      ctx.signal,
      clock,
    );
  } catch (err) {
    return skipped(
      'BLOCKED_BY_ENV',
      `The mail sink could not be read, so nothing was measured: ${errorText(err)}`,
    );
  }

  if (wait.outcome === 'CANCELLED') {
    return skipped('NOT_RUN', 'The run was cancelled while waiting for the mail.');
  }

  if (wait.outcome === EMAIL_NOT_DELIVERED || wait.mail === null) {
    const why = notDeliveredWhy(spec.trigger, budgetMs, wait.waitedMs, wait.polls);
    const status = deliveryStatus(triggerFired);
    recorder.record(
      { assertion: 'DELIVERED', verdict: triggerFired ? 'UNMET' : 'UNKNOWN', detail: why },
      waitStartedAt,
    );
    /*
     * The unlisted assertions are reported as not measured rather than left
     * out: a reader must be able to see that the subject, the links and the
     * attachments were never looked at, because the mail they are properties of
     * does not exist.
     */
    const unreached = spec.assertions.filter((a) => a !== 'DELIVERED');
    if (unreached.length > 0) {
      notes.push({
        level: 'warn',
        text:
          `${unreached.length} assertion(s) were NOT measured because no mail arrived: ` +
          `${unreached.join(', ')}.`,
        at: new Date().toISOString(),
      });
    }
    return status === 'SKIPPED'
      ? skipped('NOT_RUN', why)
      : {
          ...base,
          status,
          durationMs: Date.now() - startedAt,
          steps: recorder.steps,
          errorMessage: why,
        };
  }

  const mail = wait.mail;
  recorder.record(
    {
      assertion: 'DELIVERED',
      verdict: 'MET',
      detail: `Arrived after ${wait.waitedMs}ms (${wait.polls} poll(s)).`,
    },
    waitStartedAt,
  );

  // ── The assertions ────────────────────────────────────────────────────────
  const results: EmailAssertionResult[] = [];
  const holes: Array<{ assertion: string; reason: UnassertedReasonName }> = [...spec.notAsserted];

  for (const assertion of spec.assertions) {
    if (assertion === 'DELIVERED') continue;
    const stepStartedAt = Date.now();
    let result: EmailAssertionResult;
    try {
      result = await runEmailAssertion(assertion, spec, mail, { links: deps.links, lookup });
    } catch (err) {
      // A surface that threw told us nothing about the mail.
      result = {
        assertion,
        verdict: 'UNAVAILABLE',
        detail: `A surface failed while checking this: ${errorText(err)}`,
      };
    }
    results.push(result);
    if (result.notAsserted) holes.push(...result.notAsserted);
    recorder.record(result, stepStartedAt);
  }

  const unmetResults = results.filter((r) => r.verdict === 'UNMET');
  const metResults = results.filter((r) => r.verdict === 'MET');
  const unmeasured = results.filter((r) => r.verdict === 'UNKNOWN' || r.verdict === 'UNAVAILABLE');

  for (const r of unmeasured) {
    notes.push({
      level: 'warn',
      text: `${EMAIL_ASSERTION_LABELS[r.assertion]} was not measured — ${r.verdict}: ${r.detail}`,
      at: new Date().toISOString(),
    });
  }
  for (const hole of holes) {
    notes.push({
      level: 'warn',
      text: `NOT ASSERTED (${hole.reason}): ${hole.assertion}`,
      at: new Date().toISOString(),
    });
  }

  const unmeasuredNote =
    unmeasured.length > 0
      ? ` ${unmeasured.length} of ${results.length} assertion(s) were NOT measured: ` +
        `${unmeasured.map((r) => `${r.assertion} (${r.verdict})`).join(', ')}.`
      : '';

  if (unmetResults.length > 0) {
    return {
      ...base,
      status: 'FAILED',
      durationMs: Date.now() - startedAt,
      steps: recorder.steps,
      errorMessage: `${unmetResults.map((r) => r.detail).join(' | ')}${unmeasuredNote}`,
    };
  }

  if (metResults.length === 0 && results.length > 0) {
    /*
     * The mail arrived, assertions about it WERE asked for, and not one of them
     * could be evaluated. Deliberately not PASSED: "a receipt landed in the
     * sink" is not a statement about the receipt, and a green EMAIL test that
     * measured nothing beyond delivery is the "pass that means we did not
     * check" rule 12 names.
     *
     * `results.length > 0` is load-bearing and was a defect without it. A spec
     * whose `assertions` is exactly `['DELIVERED']` produces NO entries in
     * `results`, because delivery is settled by `waitForMail` and never enters
     * the loop — so the bare `metResults.length === 0` test reported a
     * correctly-delivered mail as "nothing was measured", on a spec that had
     * asked one question and got a real answer to it. Under-claiming is a
     * smaller sin than over-claiming and it is still a false report: it puts a
     * working notification path in the unmeasured column for ever.
     */
    const why =
      `A mail arrived and none of this test's ${results.length} assertion(s) about it could be ` +
      `measured, so nothing is claimed about "${safeExcerpt(test.name, 120)}". ` +
      unmeasured.map((r) => `${r.assertion}: ${r.detail}`).join(' | ');
    return skipped('NOT_RUN', why);
  }

  return {
    ...base,
    status: 'PASSED',
    durationMs: Date.now() - startedAt,
    steps: recorder.steps,
    errorMessage: unmeasuredNote.trim() || null,
  };
}

// ─── The real adapters ───────────────────────────────────────────────────────

/**
 * The mailbox this plugin uses until one is configured.
 *
 * REFUSES rather than returns an empty list, and the difference is the whole
 * honesty argument. An empty list means "the sink holds nothing yet", so a stub
 * that returned one would drive every EMAIL test straight to NOT_DELIVERED —
 * and with a fired trigger that is a FAILED test, which is QAAI reporting a
 * defect in the customer's template on the strength of its own missing adapter.
 * A throw lands in BLOCKED_BY_ENV with this sentence in it instead.
 *
 * The HTTP sink adapter belongs beside `email-otp.ts`'s, which already speaks
 * the MailHog/Mailpit/Mailosaur `?to=` shape — one adapter for both types, named
 * in the handover rather than written twice here.
 */
export const unavailableMailbox: MailboxReader = {
  list() {
    return Promise.reject(
      new Error(
        'No mail-sink adapter is configured for this environment. QAAI can assert that a ' +
          'transactional mail arrived inside a bound, and check its subject, sender, rendered ' +
          'values, links, link token shapes, attachments, unsubscribe link, locale and ' +
          'unrendered placeholders — but it needs a readable test mailbox to do it. Nothing ' +
          'was measured.',
      ),
    );
  },
};

/**
 * A link probe that cannot see anything.
 *
 * `status: null` and a reason, never `status: 200`. A probe that invented a 200
 * would make the LINKS and UNSUBSCRIBE assertions pass on a 404 — which is the
 * single defect those assertions exist to catch.
 */
export const unavailableLinkProbe: LinkProbe = {
  probe() {
    return Promise.resolve({
      status: null,
      finalUrl: null,
      unreachable:
        'No link probe is configured, so no link in this mail was followed. This is not "the ' +
        'links work".',
    });
  },
};

/** A trigger that refuses, so a non-delivery is never blamed on the template. */
export const unavailableMailTrigger: MailTrigger = {
  fire(trigger) {
    return Promise.resolve({
      fired: false,
      detail:
        `No trigger adapter is configured, so ${trigger.kind} ${trigger.target} was not sent. ` +
        'Use an EXTERNAL trigger when a preceding test causes the mail.',
    });
  },
};

let deps: EmailDeps = {
  mailbox: unavailableMailbox,
  links: unavailableLinkProbe,
  trigger: unavailableMailTrigger,
  lookup: null,
};

/** Install mailbox/probe/trigger/clock surfaces. Returns the previous set, so a test restores. */
export function setEmailDeps(next: EmailDeps): EmailDeps {
  const previous = deps;
  deps = next;
  return previous;
}

/**
 * The plugin.
 *
 * `type: 'EMAIL'` is not in `TEST_TYPES` yet, so this registers in
 * `PENDING_PLUGINS` in packages/runner/src/registry.ts and `pendingTypes()`
 * reports it as a named gap until the mint lands. EMAIL is the name
 * `SurfaceDimensionKind` and `DIMENSION_AXIS` already use for this surface —
 * "the template identity, which is what a mailbox assertion matches on" — so
 * the type and the dimension it covers are spelled the same way on purpose.
 *
 * It is NOT folded into EMAIL_OTP to make it reachable sooner. That type's
 * plugin exists and does something else (it drives a sign-in), a transactional
 * spec executed by it would be validated against the wrong schema, and the
 * failure would be reported under a name that does not describe it.
 */
export const emailPlugin = {
  type: 'EMAIL' as const,

  validate(test: ExecutableTest): void {
    const parsed = emailTestSpecSchema.safeParse(test.spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Email test "${test.name}" has an invalid spec — ${issues}`);
    }

    const missing = missingEmailFields(parsed.data);
    if (missing.length > 0) {
      throw new Error(`Email test "${test.name}" is incomplete — ${missing.join('; ')}.`);
    }
  },

  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    return runEmailTest(ctx, test, emailTestSpecSchema.parse(test.spec), deps);
  },
};
