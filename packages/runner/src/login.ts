/**
 * Performing a login and capturing the session (§2 auth profiles).
 *
 * Everything downstream — the crawler, every run — already reads a cached
 * `storageState` to get past a login wall. Nothing ever produced one, so auth
 * profiles were configuration for a step that never happened, and any app
 * behind a login was effectively untestable.
 *
 * Credentials are read from the vault by name and never appear in a profile, a
 * log, or a stored artifact. What is persisted is the resulting session state,
 * which is what a browser would hold anyway.
 *
 * ── Which identity, and the defect that answers ─────────────────────────────
 *
 * A run had exactly ONE storage state: the first auth profile on the
 * environment, applied to every test in the suite. A plan item can name an
 * `authProfileId` (see `planItemSchema`), so a suite legitimately contains an
 * admin test and a member test — and under one session at most one of them was
 * running as the role it claims. The other was testing somebody else's
 * permissions and could not know it.
 *
 * This module owns half of that fix: {@link signInWithProfile} turns a profile
 * row into a session whatever its kind, which is what lets a RUN sign a profile
 * in rather than hoping a cached one is lying around. The other half — which
 * role a test asked for and which one the run actually supplied — lives in
 * `run-workspace.ts` beside the workspace channel, because it is a property of
 * the run context rather than of logging in, and because the Playwright harness
 * needs to compare the two without loading a browser driver to do it.
 *
 * ── THE FIVE WALLS, AND WHY EACH ONE WAS A WHOLE CLASS OF CUSTOMER ──────────
 *
 * This module honoured three kinds — FORM_LOGIN, COOKIE_INJECTION,
 * SSO_BYPASS_TOKEN — and answered the rest with "needs the mail catcher / TOTP
 * support that is not built yet". `AUTH_PROFILE_KINDS` has named MAGIC_LINK and
 * TOTP_MFA since the beginning, so the picker could STORE a kind this file
 * could not perform, and three more kinds could not even be described. An
 * application whose only way in is harder than a password form therefore had
 * ZERO enumerable authenticated surface — not a small number, zero — and it
 * reported as an application with very little behind the wall. Those are
 * opposite facts and the product was stating the wrong one.
 *
 *   TOTP_MFA   The code is arithmetic over a vault seed and the clock, so it
 *              needs no external system at all: {@link totpAt} is RFC 6238 and
 *              nothing more. The trap is the CLOCK, not the HMAC — see the note
 *              on {@link TOTP_MIN_REMAINING_MS}.
 *   MAGIC_LINK Poll a mailbox the customer nominated, take the link out, follow
 *              it. The link is SINGLE-USE, so a retry must ask for a NEW one;
 *              replaying the old one is how every second crawl fails
 *              mysteriously. See {@link performMagicLinkLogin}.
 *   PASSKEY    There is no password to type, so no amount of FORM_LOGIN
 *              configuration reaches it. The credential is served by a CDP
 *              virtual authenticator, which a Firefox or WebKit session
 *              genuinely cannot provide — so this is the kind that must be able
 *              to say UNAVAILABLE out loud.
 *   PHONE_OTP  The same shape as the magic link through a sink the customer
 *              owns. QAAI never reads a real phone and there is no phone here.
 *   MOCK_IDP   An SSO-fronted application decides a user's ROLE from an
 *              assertion, so minting the assertion is the only way to enumerate
 *              as an admin and then as a member. It is refused on PRODUCTION,
 *              structurally — see {@link performMockIdpLogin}.
 *
 * ── A FAILED LOGIN IS NOT AN EMPTY APPLICATION ──────────────────────────────
 *
 * The old `LoginResult` carried `ok: false` and a sentence. A caller could not
 * tell "your application rejected our credentials" from "no browser was
 * available" from "the link never arrived" from "we got in and there was
 * nothing there", and the crawl recorded all four the same way: a wall with
 * nothing behind it. The first three are OUR problem and the fourth is the
 * customer's, and reporting ours as theirs is the most expensive lie this file
 * could tell.
 *
 * So every failure now carries {@link LoginFailureReport}: WHAT failed
 * ({@link LoginFailure}), WHERE it failed ({@link LoginStep}) and WHOSE problem
 * it is ({@link LOGIN_FAILURE_FAULT}). `failure` is non-null on exactly the
 * results where `ok` is false, so a consumer cannot reach the unhappy path and
 * find nothing to report.
 *
 * ── THE RULES THIS FILE LIVES BY ────────────────────────────────────────────
 *
 *  1. **Every surface is INJECTED.** Nothing below `performFormLogin` imports
 *     playwright; the one adapter that does is {@link playwrightLoginBrowser},
 *     and it is deliberately thin. Playwright cannot drive a real browser in a
 *     unit test and there is no real IdP, no real phone and no authenticator
 *     here, so a login module welded to a `Page` is a login module with no
 *     tests — and the judgement calls in here (is this window about to expire?
 *     did this message arrive before or after we asked?) are exactly the kind
 *     that must be cheap to keep correct.
 *
 *  2. **UNAVAILABLE is an answer.** A capability the transport cannot provide
 *     is reported with `authAdapterUnavailable`'s missing list and remedy, at
 *     fault 'UNDETERMINED', never as `ok: false, 'login failed'`. "We could not
 *     try" and "we tried and were refused" are different facts.
 *
 *  3. **Nothing is logged.** Every string this module returns passes through
 *     `createMasker` built from the environment's own secret values, so a page
 *     title that echoes an email address, a driver error that quotes a filled
 *     value, or a mailbox body is redacted before it can reach a caller. A TOTP
 *     code, an OTP code, a magic link's token, an assertion and a cookie are
 *     never put in a message in the first place — the masker is the second
 *     line, not the first.
 *
 *  4. **A mailbox and a sink are UNTRUSTED.** Anybody can post a message into a
 *     catcher. A link is followed only when it is on the application's own
 *     origin and a code only when it matches the configured pattern; a link
 *     pointing anywhere else is a refusal naming the foreign origin, not a
 *     navigation.
 */

import { chromium } from 'playwright';
import { createHmac } from 'node:crypto';
// The `keepNames` shim, reused rather than reimplemented — see `postForm`.
import { inPage } from './a11y-deep.js';
import { createMasker, isOwnOrigin } from '@qaai/shared';
import type { AuthProfileKind, EnvironmentKind } from '@qaai/shared';
import {
  AUTH_CAPABILITIES,
  AUTH_CAPABILITY_REMEDY,
  AUTH_PROFILE_CONFIG_SCHEMAS,
  authAdapterUnavailable,
  authProfileKindRefusedOn,
} from '@qaai/shared';
import type {
  AuthAdapterUnavailable,
  AuthCapability,
} from '@qaai/shared';

// ─── What a login can fail at, and whose problem it is ───────────────────────

/**
 * Where in a login the failure happened.
 *
 * Ordered roughly as a login runs, because the first step that failed is the
 * one a customer must fix and the later ones are consequences. A report that
 * says only "login failed" sends a reader to read their application's logs when
 * the actual answer was that a vault secret is missing.
 */
export const LOGIN_STEPS = [
  /** The stored profile config did not describe a login we could drive. */
  'CONFIG',
  /** The adapter this kind needs is not present on this worker. */
  'CAPABILITY',
  /** The kind is not permitted against an environment of this kind. */
  'POLICY',
  /** A secret the config names is not in this environment's vault. */
  'SECRET',
  /** Reaching the login page at all. */
  'NAVIGATE',
  /** Entering the identifier — username, email, phone. */
  'IDENTIFY',
  /** Entering and submitting the first factor. */
  'CREDENTIAL',
  /** Waiting for a link or a code to arrive in a sink the customer owns. */
  'DELIVERY',
  /** Following the magic link out of the mailbox. */
  'FOLLOW_LINK',
  /** The second factor: a TOTP code, an OTP code, a passkey assertion. */
  'SECOND_FACTOR',
  /** Minting and delivering an identity assertion. */
  'ASSERTION',
  /** The success locator the customer nominated. */
  'CONFIRM',
  /** Reading the session out of the browser afterwards. */
  'CAPTURE',
] as const;
export type LoginStep = (typeof LOGIN_STEPS)[number];

/**
 * What kind of failure it was.
 *
 * The distinction this list exists to draw is REJECTED vs TIMED_OUT vs
 * UNAVAILABLE. All three used to be `ok: false`, and each one sends the reader
 * somewhere completely different: fix your credentials, find out why your
 * application did not send the message, install a browser on the runner.
 *
 * NOT_CAPTURED is the subtle one and it is a real defect class. A login can be
 * CONFIRMED — the success locator appeared — and still yield no session
 * material, because the surface could not read it. Reporting that as success
 * hands an anonymous session to a test that asked for a role, and the crawl
 * behind the wall then reports an empty application. So it is a failure, and it
 * says in its detail that the login itself worked.
 */
export const LOGIN_FAILURES = [
  /** Ours: the profile does not describe a drivable login. */
  'MISCONFIGURED',
  /** Ours: a secret the config names is absent from the vault. */
  'MISSING_SECRET',
  /** Neither: the adapter this kind needs is not here. Not a login attempt. */
  'UNAVAILABLE',
  /** Ours: the kind, or the destination, is not permitted. */
  'REFUSED_BY_POLICY',
  /** Ours: the application answered and said no. Our credentials are wrong. */
  'REJECTED',
  /** Undetermined: a link or code never arrived. Could be theirs, could be the sink. */
  'TIMED_OUT',
  /** Theirs: a bot defence stood in front of the form. */
  'BLOCKED',
  /** Ours: the browser or transport broke while being driven. */
  'DRIVER_ERROR',
  /** Undetermined: the login was confirmed and no session could be read out. */
  'NOT_CAPTURED',
] as const;
export type LoginFailure = (typeof LOGIN_FAILURES)[number];

/**
 * Whose problem each failure is.
 *
 * 'OURS' and 'THEIRS' are spelled as `ROLE_CRAWL_FAULT` in @qaai/shared spells
 * them, so a reader who has seen one recognises the other. The third member is
 * 'UNDETERMINED' rather than that enum's 'NOBODY' because for a login the third
 * case is genuinely "we cannot tell from here": a code that never arrived might
 * be an application that never sent it or a sink that never received it, and
 * claiming either would be inventing a fact.
 *
 * COMPILER-ENFORCED. A new {@link LoginFailure} breaks this line, which is the
 * point — a failure with no attribution reads as the application's fault by
 * default, and the whole reason this vocabulary exists is that the default was
 * wrong.
 */
export const LOGIN_FAILURE_FAULT: Record<LoginFailure, 'OURS' | 'THEIRS' | 'UNDETERMINED'> = {
  MISCONFIGURED: 'OURS',
  MISSING_SECRET: 'OURS',
  UNAVAILABLE: 'UNDETERMINED',
  REFUSED_BY_POLICY: 'OURS',
  REJECTED: 'OURS',
  TIMED_OUT: 'UNDETERMINED',
  BLOCKED: 'THEIRS',
  DRIVER_ERROR: 'OURS',
  NOT_CAPTURED: 'UNDETERMINED',
};

/**
 * How "signed in" was actually established.
 *
 * A success locator is an assertion. An HTTP status is not: a failed login very
 * often returns 200 with an error banner. Two of the five stored config shapes
 * — MAGIC_LINK and TOTP_MFA — have no `successSelector` field at all, so for
 * those the strongest available confirmation really is weaker, and a report
 * must be able to say which one it got. A weak confirmation is DISCLOSED, never
 * quietly promoted to the strong one.
 */
export const LOGIN_CONFIRMATIONS = [
  /** A locator the customer nominated appeared. The only strong answer. */
  'SUCCESS_LOCATOR',
  /** No locator is configurable for this kind: a non-error load off the login page. */
  'STATUS_AND_URL_ONLY',
  /** The kind captures no session, so there was nothing to confirm in a browser. */
  'NOT_APPLICABLE',
] as const;
export type LoginConfirmation = (typeof LOGIN_CONFIRMATIONS)[number];

/** A login that did not happen, and everything a reader needs to act on it. */
export interface LoginFailureReport {
  kind: LoginFailure;
  step: LoginStep;
  fault: 'OURS' | 'THEIRS' | 'UNDETERMINED';
  /** Safe to show a user; masked, and never built from a credential. */
  detail: string;
  /**
   * The missing capabilities and their remedies, for `UNAVAILABLE` only. Null
   * elsewhere: an absent adapter is a different conversation from a refused
   * password, and a caller that renders a remedy must not be handed one when
   * there is nothing to install.
   */
  unavailable: AuthAdapterUnavailable | null;
}

export interface LoginResult {
  ok: boolean;
  /** Playwright storageState — cookies and origin storage. */
  storageState: unknown | null;
  /** Safe to show a user; never contains a credential. */
  message: string;
  /** How long the captured session should be trusted. */
  expiresAt: Date | null;
  /**
   * Non-null on exactly the results where `ok` is false.
   *
   * The invariant is the point. `ok: false` with nothing to report is how a
   * failed login came to be indistinguishable from a wall with nothing behind
   * it, and `login.test.ts` asserts the two fields agree on every path.
   */
  failure: LoginFailureReport | null;
  /** How the success was established. Null on a failure. */
  confirmedBy: LoginConfirmation | null;
}

/** Sessions are re-captured well before a typical expiry rather than on failure. */
const SESSION_TTL_HOURS = 8;

function expiry(): Date {
  return new Date(Date.now() + SESSION_TTL_HOURS * 3600_000);
}

/**
 * The one chokepoint every returned string passes through.
 *
 * Built per call from the environment's own secret VALUES, so a page title that
 * echoes the username, a driver error that quotes what was typed, or a mailbox
 * body that got into a message is redacted by construction rather than by
 * everyone remembering. Nothing in here deliberately puts a secret in a string;
 * this is the line that catches the time somebody does.
 */
type Masker = (input: string) => string;

function maskerFor(secrets: Readonly<Record<string, string>>): Masker {
  return createMasker(Object.values(secrets));
}

function failed(
  mask: Masker,
  kind: LoginFailure,
  step: LoginStep,
  detail: string,
  unavailable: AuthAdapterUnavailable | null = null,
): LoginResult {
  const safe = mask(detail);
  return {
    ok: false,
    storageState: null,
    message: safe,
    expiresAt: null,
    failure: { kind, step, fault: LOGIN_FAILURE_FAULT[kind], detail: safe, unavailable },
    confirmedBy: null,
  };
}

function succeeded(
  mask: Masker,
  storageState: unknown | null,
  confirmedBy: LoginConfirmation,
  message: string,
): LoginResult {
  return {
    ok: true,
    storageState,
    message: mask(message),
    expiresAt: expiry(),
    failure: null,
    confirmedBy,
  };
}

// ─── The surfaces, injected ──────────────────────────────────────────────────

export interface LoginNavigation {
  ok: boolean;
  /** Where we ENDED UP after redirects, which is not what we asked for. */
  url: string;
  /** Null when the surface cannot report one. Never 0 — see rule 10. */
  status: number | null;
  error: string | null;
}

/** What a storage state is, to the extent this module reads it. */
export interface LoginStorageState {
  cookies: readonly unknown[];
  origins: readonly unknown[];
}

/**
 * The browser, as the eight things a login does to one.
 *
 * Narrow enough to fake in an object literal, which is the whole point: the
 * fakes in `login.test.ts` are page scripts, and the one real implementation
 * ({@link playwrightLoginBrowser}) has no judgement in it to get wrong.
 *
 * `waitFor` returns false rather than throwing, because "the success locator
 * never appeared" is an ordinary measurement here and the control flow around
 * it should not be exception handling.
 */
export interface LoginBrowser {
  goto(url: string, timeoutMs: number): Promise<LoginNavigation>;
  /** The current URL, read without a round trip. */
  url(): string;
  fill(selector: string, value: string, timeoutMs: number): Promise<boolean>;
  click(selector: string, timeoutMs: number): Promise<boolean>;
  waitFor(selector: string, timeoutMs: number): Promise<boolean>;
  /** For a failure message. Masked before it reaches a caller. */
  title(): Promise<string>;
  storageState(): Promise<LoginStorageState>;
  close(): Promise<void>;
  /**
   * Deliver a form POST. SAML hands the assertion back to the application by
   * auto-submitting one, so a surface without this method cannot perform a SAML
   * MOCK_IDP login — reported UNAVAILABLE, not attempted and failed.
   */
  postForm?(
    url: string,
    fields: Readonly<Record<string, string>>,
    timeoutMs: number,
  ): Promise<LoginNavigation>;
}

/** One message as the catcher reports it. The text is UNTRUSTED input. */
export interface MailboxMessage {
  id: string;
  receivedAtMs: number;
  /** Subject and body, already length-capped by the adapter. Never logged. */
  text: string;
}

/**
 * A mailbox or webhook sink the customer nominated.
 *
 * `sinceMs` is not a convenience. A magic link is single-use, so the message
 * that matters is the one produced by THIS attempt, and a poll that may return
 * the previous attempt's mail will happily replay a consumed link — see
 * {@link performMagicLinkLogin}.
 */
export interface MailboxSurface {
  poll(request: { mailbox: string; sinceMs: number }): Promise<readonly MailboxMessage[]>;
}

/** One delivery as the sink reports it. The text is UNTRUSTED input. */
export interface OtpDelivery {
  id: string;
  receivedAtMs: number;
  /** The message the sink received. Never logged, never echoed in a failure. */
  text: string;
}

/**
 * A sink the customer owns that receives the code.
 *
 * `sink` is handed over verbatim from the profile config — the adapter knows
 * how to read a Twilio test number, a signed webhook or a non-production
 * application endpoint, and this module knows only that a code may arrive. The
 * signing secret is named, never carried.
 */
export interface OtpSinkSurface {
  poll(request: { sink: unknown; sinceMs: number }): Promise<readonly OtpDelivery[]>;
}

/** The arguments `WebAuthn.addVirtualAuthenticator` actually takes. */
export interface VirtualAuthenticatorOptions {
  rpId: string;
  protocol: 'ctap2' | 'u2f';
  transport: 'usb' | 'nfc' | 'ble' | 'internal' | 'hybrid';
  hasResidentKey: boolean;
  hasUserVerification: boolean;
  isUserVerified: boolean;
}

/**
 * A CDP virtual authenticator.
 *
 * The capability is real and genuinely absent on some transports: it is the
 * Chrome DevTools Protocol's `WebAuthn` domain, so a Firefox or WebKit session
 * cannot provide it at all. That is why the factory on {@link LoginSurfaces}
 * may return null for a session it cannot serve — the honest report is
 * UNAVAILABLE with CDP_WEBAUTHN named, and a passkey login that silently
 * "failed" instead would be blamed on the application under test.
 *
 * `addCredential` is optional on purpose. An application that only accepts a
 * passkey it has seen enrolled needs it; the common discoverable-credential
 * flow does not, and a transport that offers an authenticator but no credential
 * injection can still serve that flow.
 */
export interface VirtualAuthenticatorSurface {
  add(options: VirtualAuthenticatorOptions): Promise<{ authenticatorId: string }>;
  /** `credential` is opaque material from the vault. Never logged. */
  addCredential?(authenticatorId: string, credential: string): Promise<void>;
  remove(authenticatorId: string): Promise<void>;
}

export interface MockIdpMintRequest {
  issuer: string;
  protocol: 'SAML' | 'OIDC';
  subject: string;
  claims: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  audience: string | null;
  lifetimeSeconds: number;
  /**
   * A vault NAME, never key material. The surface resolves it itself, so no
   * signing key passes through this module and none can end up in a message.
   */
  signingKeySecretName: string;
  /** Where the application sent the browser to begin the flow. */
  authnRequestUrl: string;
}

/** How the application takes delivery of a minted assertion. */
export interface MintedAssertion {
  delivery: 'REDIRECT' | 'FORM_POST';
  /**
   * The APPLICATION's own endpoint — its ACS or callback. Checked same-origin
   * against the environment's base URL before anything is sent to it, which is
   * the structural half of "this never touches a real provider".
   */
  url: string;
  /** FORM_POST only. Assertion material; never logged. */
  fields?: Readonly<Record<string, string>>;
}

export interface MockIdpSurface {
  mint(request: MockIdpMintRequest): Promise<MintedAssertion>;
}

/**
 * Everything a login may need that is not in the profile row.
 *
 * All optional, and that is the design: the caller supplies what the transport
 * it is driving can do, {@link loginCapabilities} reports the set, and
 * `authAdapterUnavailable` in @qaai/shared turns a gap into the missing
 * capabilities plus the remedy for each. Nothing here is read by the pure
 * functions below — the seam is a contract rather than a convention.
 */
export interface LoginSurfaces {
  /** Opens a browser. Defaults to {@link playwrightLoginBrowser}. */
  browser?: () => Promise<LoginBrowser>;
  mailbox?: MailboxSurface;
  otpSink?: OtpSinkSurface;
  /**
   * Yields the authenticator for an OPEN session, or null when that session
   * cannot serve one. Two stages because the transport's claim and the
   * session's reality are different facts and both have to be reportable.
   */
  webAuthn?: (browser: LoginBrowser) => VirtualAuthenticatorSurface | null;
  idp?: MockIdpSurface;
  /** Injected so the TOTP window boundary is testable. Defaults to `Date.now`. */
  now?: () => number;
  /** Injected so a poll does not really sleep. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Which surface proves each capability.
 *
 * A `Record` keyed on the shared `AuthCapability` union, so a new capability
 * cannot be added over there without someone deciding what satisfies it here.
 * 'ALWAYS' is not a cop-out in either of its two uses: NONE is satisfied by
 * definition (cookie injection is the one kind designed for a machine with no
 * browser, and must not report unavailable on it), and TOTP_CLOCK is arithmetic
 * over `node:crypto` and the clock — there is no external system to be missing.
 */
const CAPABILITY_SOURCE: Record<AuthCapability, keyof LoginSurfaces | 'ALWAYS'> = {
  NONE: 'ALWAYS',
  TOTP_CLOCK: 'ALWAYS',
  BROWSER: 'browser',
  MAILBOX_POLL: 'mailbox',
  OTP_SINK: 'otpSink',
  CDP_WEBAUTHN: 'webAuthn',
  MOCK_IDP_ISSUER: 'idp',
};

/**
 * What this set of surfaces can do.
 *
 * BROWSER is reported available when no factory was supplied, because the
 * default is the real Playwright adapter — a caller that passes `{}` gets a
 * browser. A caller with no browsers installed passes a factory that throws and
 * gets a DRIVER_ERROR at the step that needed one, which is a measurement
 * rather than a guess made up front.
 */
export function loginCapabilities(surfaces: LoginSurfaces): AuthCapability[] {
  return AUTH_CAPABILITIES.filter((capability) => {
    const source = CAPABILITY_SOURCE[capability];
    if (source === 'ALWAYS') return true;
    if (source === 'browser') return true;
    return typeof surfaces[source] !== 'undefined';
  });
}

function clock(surfaces: LoginSurfaces): () => number {
  return surfaces.now ?? (() => Date.now());
}

function waiter(surfaces: LoginSurfaces): (ms: number) => Promise<void> {
  return (
    surfaces.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }))
  );
}

// ─── TOTP: RFC 6238, and the clock trap that is the real defect ──────────────

/**
 * How much of the current window must be left before a code is typed.
 *
 * THE DEFECT THIS PREVENTS: a code computed at t=29.8s inside a 30s window is
 * correct when computed and expired by the time the form is submitted. The
 * login then fails perhaps one time in a hundred, the failure looks exactly
 * like a wrong password, and it is blamed on the application under test — which
 * is the worst available outcome, because the customer goes looking for a bug
 * they do not have.
 *
 * So {@link totpAt} reports how long the window has left and the drivers below
 * WAIT for the next one rather than racing it. Two seconds is a form fill and a
 * submit with room to spare; shorter is a gamble and longer wastes half a
 * window on every login.
 */
export const TOTP_MIN_REMAINING_MS = 2_000;

const TOTP_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Base32 (RFC 4648) with the tolerance real authenticator seeds need.
 *
 * Seeds are shown to humans in lower case and in groups of four separated by
 * spaces, and get pasted that way. Rejecting that is rejecting the format the
 * secret was presented in, so case, whitespace, hyphens and `=` padding are all
 * accepted. Anything else is an error rather than a silently skipped character:
 * a seed that decodes "nearly right" produces codes that are always wrong, with
 * no clue as to why.
 */
export function decodeBase32(seed: string): Buffer {
  const cleaned = seed.replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase();
  if (cleaned.length === 0) throw new Error('the seed is empty');

  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const character of cleaned) {
    const index = TOTP_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new Error(`the seed is not base32 (unexpected "${character}")`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }

  /*
   * A SEED THAT DECODES TO NO KEY AT ALL.
   *
   * The length check above is on the STRING; this one is on the KEY, and they
   * are not the same test. A one-character seed — a truncated paste, or a stray
   * "A" — is legal base32 and carries five bits, which is fewer than one byte,
   * so the loop above pushes nothing and this returned a ZERO-LENGTH buffer.
   * `createHmac` accepts an empty key, so `hotp` then produced a plausible
   * six-digit code from no secret whatsoever: every code wrong, every login
   * REJECTED, and the fault recorded as 'OURS' with "the credentials are
   * wrong". That sends the customer to audit their application's MFA when the
   * actual answer is that their seed is a fragment.
   *
   * So it is MISCONFIGURED instead, which is what `performTotpMfaLogin` turns
   * this throw into — the same treatment as a seed with a non-base32 character,
   * because it is the same mistake one character further along.
   */
  if (bytes.length === 0) {
    throw new Error(
      `the seed is too short to be a key (${cleaned.length} base32 character(s) carry ` +
        'fewer than 8 bits) — it looks truncated',
    );
  }
  return Buffer.from(bytes);
}

/** Which hashes an authenticator may be configured with. SHA-1 is the default. */
export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface TotpOptions {
  digits?: number;
  periodSeconds?: number;
  algorithm?: TotpAlgorithm;
}

/** HOTP (RFC 4226) — the counter half, which TOTP is a clock over. */
export function hotp(
  key: Buffer,
  counter: number,
  digits: number,
  algorithm: TotpAlgorithm,
): string {
  const block = Buffer.alloc(8);
  block.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, key).update(block).digest();

  // Dynamic truncation (RFC 4226 §5.3). The low nibble of the last byte picks
  // the offset, and the top bit of the chosen word is cleared so the result is
  // the same on a platform without unsigned arithmetic.
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** A code, and the window it is the code FOR. */
export interface TotpCode {
  code: string;
  /** The RFC 6238 time step. Exposed because a test asserting a boundary needs it. */
  step: number;
  validFromMs: number;
  /** Exclusive: the instant the next window's code takes over. */
  validUntilMs: number;
  /** How long this code has left. The number the drivers below act on. */
  msRemaining: number;
}

/**
 * The code for one instant, and how long it is good for.
 *
 * Returning the window rather than just the code is what makes the clock trap
 * fixable: a caller can see that it has 200ms left and wait, and a test can
 * pin the boundary without mocking a timer. RFC 6238's own test vectors are in
 * `login.test.ts` — the algorithm is checked against the spec rather than
 * against itself, because a self-consistent wrong implementation produces codes
 * every application rejects and no test here would notice.
 */
export function totpAt(seed: string, atMs: number, options: TotpOptions = {}): TotpCode {
  const digits = options.digits ?? 6;
  const periodSeconds = options.periodSeconds ?? 30;
  const algorithm = options.algorithm ?? 'sha1';

  const periodMs = periodSeconds * 1000;
  const step = Math.floor(atMs / periodMs);
  const validFromMs = step * periodMs;
  const validUntilMs = validFromMs + periodMs;

  return {
    code: hotp(decodeBase32(seed), step, digits, algorithm),
    step,
    validFromMs,
    validUntilMs,
    msRemaining: validUntilMs - atMs,
  };
}

/**
 * The code to actually type, having waited out a window that was about to end.
 *
 * Returns the code AND whether it waited, because "we paused 300ms" belongs in
 * the record of what happened rather than being invisible.
 */
async function freshTotpCode(
  seed: string,
  surfaces: LoginSurfaces,
  options: TotpOptions = {},
): Promise<{ code: TotpCode; waitedMs: number }> {
  const now = clock(surfaces);
  const sleep = waiter(surfaces);

  const first = totpAt(seed, now(), options);
  if (first.msRemaining >= TOTP_MIN_REMAINING_MS) return { code: first, waitedMs: 0 };

  // Sleep to the start of the next window, not merely "a bit": landing exactly
  // on the boundary is what makes the wait deterministic in a test.
  const waitedMs = first.msRemaining;
  await sleep(waitedMs);
  return { code: totpAt(seed, first.validUntilMs, options), waitedMs };
}

// ─── Timeouts, in one place so none of them is a magic number ────────────────

const NAVIGATE_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
const CONFIRM_TIMEOUT_MS = 20_000;
/** How often a mailbox or sink is asked. Slower than this and a 60s wait feels broken. */
const POLL_INTERVAL_MS = 2_000;

export interface FormLoginConfig {
  loginUrl: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  usernameSecretName: string;
  passwordSecretName: string;
  /** A locator that only exists once login succeeded — the actual assertion. */
  successSelector: string;
}

export interface CookieInjectionConfig {
  cookiesSecretName: string;
  domain: string;
}

export interface SsoTokenConfig {
  tokenSecretName: string;
  header: string;
  valueTemplate: string;
}

/** The TOTP_MFA config's own three fields: the SECOND factor and nothing else. */
export interface TotpSecondFactorConfig {
  /** Base32 seed, held in the vault. The code is computed here, never stored. */
  seedSecretName: string;
  codeSelector: string;
  submitSelector: string;
}

/**
 * A TOTP login is a form login plus a code, so its config is both shapes.
 *
 * It is a composition of the two STORED schemas rather than a third schema of
 * its own: two shapes describing one form that disagree by a selector is the
 * defect this file is one layer away from. See {@link signInWithProfile} for
 * the parse, and for the stored-config gap that composition papers over today.
 */
export type TotpMfaLoginConfig = FormLoginConfig & TotpSecondFactorConfig;

export interface MagicLinkConfig {
  requestUrl: string;
  emailSelector: string;
  submitSelector: string;
  /** Mailbox the catcher should poll. */
  mailbox: string;
  linkPattern: string;
}

export interface PasskeyConfig {
  loginUrl: string;
  usernameSelector?: string;
  usernameSecretName?: string;
  submitSelector: string;
  successSelector: string;
  authenticator: VirtualAuthenticatorOptions;
  credentialSecretName?: string;
}

export interface PhoneOtpConfig {
  loginUrl: string;
  phoneSelector: string;
  phoneSecretName: string;
  requestSelector: string;
  codeSelector: string;
  submitSelector: string;
  successSelector: string;
  sink: unknown;
  codePattern: string;
  timeoutSeconds: number;
}

export interface MockIdpConfig {
  issuer: string;
  protocol: 'SAML' | 'OIDC';
  startUrl: string;
  successSelector: string;
  subject: string;
  claims: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  signingKeySecretName: string;
  audience?: string;
  lifetimeSeconds: number;
}

// ─── Shared machinery the drivers sit on ─────────────────────────────────────

function absoluteUrl(candidate: string, baseUrl: string): string {
  return /^https?:\/\//i.test(candidate) ? candidate : new URL(candidate, baseUrl).toString();
}

/**
 * A URL out of a profile config, resolved AND checked to be the customer's own.
 *
 * ── THE DEFECT THIS PREVENTS: THE VAULT PASSWORD, TYPED INTO ANOTHER HOST ───
 *
 * Every driver below starts by navigating to a URL off the profile row, and
 * `absoluteUrl` passes an absolute `https://…` through UNCHANGED. Nothing then
 * checked where that was. So a FORM_LOGIN profile whose `loginUrl` named
 * another host had QAAI open that host and `fill` the environment's vault
 * username and password into it — and report `ok: true`, because the success
 * locator was whatever that page chose to show. The same hole reached the
 * passkey username, the magic-link mailbox address and the phone number, and
 * for MOCK_IDP it was the one path by which a "mock" login could put a browser
 * on a real provider's production sign-in endpoint, which that function's own
 * doc comment promises is impossible.
 *
 * The profile row is not hostile input, but it is not a secret either: it is an
 * ordinary editable field, it is not reviewed, and a typo in it is enough. The
 * module's whole premise is that credentials come out of the vault and go only
 * to the application under test, and that premise needs one check to be true
 * rather than a convention that every driver remembers.
 *
 * ── WHY A CROSS-ORIGIN LOGIN HOST IS REFUSED RATHER THAN GUESSED ────────────
 *
 * `auth.customer.com` fronting `app.customer.com` is a real and common setup,
 * and from here the two are indistinguishable from `app.customer.com` and
 * somebody else's host — a suffix test would accept `customer.com.evil.net`.
 * So it is not guessed: the customer DECLARES the other origin on their own
 * environment, the same `additionalOrigins` the crawl policy already uses for
 * exactly this question, and the refusal says so. A loud refusal naming the
 * origin costs one configuration field; the silent version posts a password to
 * a third party.
 *
 * Only the NAVIGATION is widened by that list. The magic link and the minted
 * assertion are still checked strictly against `baseUrl`, because a link and an
 * assertion are single-use credentials rather than a page to open.
 */
function ownOriginUrl(
  mask: Masker,
  candidate: string,
  baseUrl: string,
  field: string,
  allowedOrigins: readonly string[],
): { ok: true; url: string } | { ok: false; result: LoginResult } {
  let url: string;
  try {
    url = absoluteUrl(candidate, baseUrl);
  } catch {
    return {
      ok: false,
      result: failed(
        mask,
        'MISCONFIGURED',
        'CONFIG',
        `The profile's ${field} ("${candidate}") is not a URL this environment can resolve.`,
      ),
    };
  }

  if (isOwnOrigin(baseUrl, url)) return { ok: true, url };
  // Each declared origin compared as an ORIGIN, not matched as a string: this
  // is `isOwnOrigin`'s own equality, borrowed rather than re-implemented.
  if (allowedOrigins.some((origin) => isOwnOrigin(origin, url))) return { ok: true, url };

  // Names the ORIGIN only. A login URL carries tenant hints and return paths in
  // its query string, and this message is stored and rendered in the cockpit.
  let foreign = 'an unparseable URL';
  try {
    foreign = new URL(url).origin;
  } catch {
    /* keep the placeholder */
  }
  return {
    ok: false,
    result: failed(
      mask,
      'REFUSED_BY_POLICY',
      'POLICY',
      `The profile's ${field} points at ${foreign}, which is not this environment. QAAI ` +
        'will not drive a login — or type a credential — on an origin that is not the ' +
        'application under test. Nothing was attempted, so nothing is known about the ' +
        'surface behind this wall. If that host is genuinely yours, add it to this ' +
        "environment's crawl policy additionalOrigins and re-run.",
    ),
  };
}

/** A secret, or the failure that says which one is missing. */
function requireSecrets(
  mask: Masker,
  secrets: Readonly<Record<string, string>>,
  names: readonly string[],
): { ok: true; values: string[] } | { ok: false; result: LoginResult } {
  const missing = names.filter((name) => !secrets[name]);
  if (missing.length > 0) {
    return {
      ok: false,
      result: failed(
        mask,
        'MISSING_SECRET',
        'SECRET',
        `Missing secret(s): ${missing.join(', ')}. Add them to this environment.`,
      ),
    };
  }
  return { ok: true, values: names.map((name) => secrets[name] ?? '') };
}

async function openBrowser(surfaces: LoginSurfaces): Promise<LoginBrowser> {
  return (surfaces.browser ?? playwrightLoginBrowser)();
}

/**
 * Read the session out, and refuse to call an empty one a session.
 *
 * A storage state with no cookies AND no origin storage is not a logged-in
 * browser. Returning it as a success hands an anonymous context to a test that
 * asked for a role, and the crawl behind the wall then reports an application
 * with nothing in it — rule 10's exact failure, arrived at by being too
 * generous one step earlier.
 */
async function captureSession(
  mask: Masker,
  browser: LoginBrowser,
  confirmedBy: LoginConfirmation,
  what: string,
): Promise<LoginResult> {
  let state: LoginStorageState;
  try {
    state = await browser.storageState();
  } catch (err) {
    return failed(
      mask,
      'NOT_CAPTURED',
      'CAPTURE',
      `${what} succeeded and the session could not be read out of the browser: ` +
        `${errorText(err)}. The login itself worked — this is not a credential problem.`,
    );
  }

  if (state.cookies.length === 0 && state.origins.length === 0) {
    return failed(
      mask,
      'NOT_CAPTURED',
      'CAPTURE',
      `${what} was confirmed and the browser held no cookies and no origin storage, so ` +
        'there is no session to reuse. A later run would crawl this environment ' +
        'anonymously while believing it was signed in.',
    );
  }

  return succeeded(
    mask,
    state,
    confirmedBy,
    `${what} and captured the session (${state.cookies.length} cookie(s), ` +
      `${state.origins.length} origin(s)).`,
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'the surface failed without a message';
}

/**
 * The step-by-step drive of a form, as a result or nothing.
 *
 * Returns a LoginResult only when something went wrong, so the callers read as
 * a sequence of attempts rather than a staircase of ifs. `null` means carry on.
 */
async function drive(
  mask: Masker,
  browser: LoginBrowser,
  step: LoginStep,
  what: string,
  action: () => Promise<boolean>,
): Promise<LoginResult | null> {
  let ok: boolean;
  try {
    ok = await action();
  } catch (err) {
    return failed(mask, 'DRIVER_ERROR', step, `${what} failed: ${errorText(err)}`);
  }
  if (!ok) {
    const title = await browser.title().catch(() => '');
    return failed(
      mask,
      'DRIVER_ERROR',
      step,
      `${what} failed` + (title ? ` (page title: "${title}")` : '') + '.',
    );
  }
  return null;
}

/**
 * Wait for the locator the customer nominated.
 *
 * The success check is a locator and not an HTTP status: a failed login very
 * often returns 200 with an error banner, and treating that as success caches a
 * logged-out session and makes every later test fail for the wrong reason. The
 * failure is REJECTED — our credentials, not their application — because that
 * is overwhelmingly what it is, and the message says the other possibility out
 * loud so a wrong locator is also findable.
 */
async function confirm(
  mask: Masker,
  browser: LoginBrowser,
  successSelector: string,
  step: LoginStep = 'CONFIRM',
): Promise<LoginResult | null> {
  let appeared: boolean;
  try {
    appeared = await browser.waitFor(successSelector, CONFIRM_TIMEOUT_MS);
  } catch (err) {
    return failed(mask, 'DRIVER_ERROR', step, `Waiting for the success locator: ${errorText(err)}`);
  }
  if (appeared) return null;

  const title = await browser.title().catch(() => '');
  return failed(
    mask,
    'REJECTED',
    step,
    `"${successSelector}" never appeared` +
      (title ? ` (page title: "${title}")` : '') +
      '. Either the credentials are wrong or the success locator is.',
  );
}

async function navigate(
  mask: Masker,
  browser: LoginBrowser,
  url: string,
  step: LoginStep = 'NAVIGATE',
): Promise<LoginResult | null> {
  let nav: LoginNavigation;
  try {
    nav = await browser.goto(url, NAVIGATE_TIMEOUT_MS);
  } catch (err) {
    return failed(mask, 'DRIVER_ERROR', step, `Could not load the page: ${errorText(err)}`);
  }
  if (!nav.ok) {
    return failed(
      mask,
      'DRIVER_ERROR',
      step,
      `Could not load the page` +
        (nav.status === null ? '' : ` (HTTP ${nav.status})`) +
        (nav.error ? `: ${nav.error}` : '.'),
    );
  }
  return null;
}

/**
 * Ask a sink repeatedly until the deadline, and say so when nothing came.
 *
 * `sinceMs` is passed through to the sink AND re-checked here, because a sink
 * that ignores the filter must not be able to hand back a message from the
 * previous attempt. A single-use link replayed that way produces a login that
 * works the first time and fails every time after, and the symptom points at
 * the application.
 */
async function pollSink<T extends { id: string; receivedAtMs: number; text: string }>(
  surfaces: LoginSurfaces,
  read: (sinceMs: number) => Promise<readonly T[]>,
  options: {
    sinceMs: number;
    timeoutMs: number;
    consumed: ReadonlySet<string>;
    extract: (text: string) => string | null;
  },
): Promise<{ value: string; message: T } | null> {
  const now = clock(surfaces);
  const sleep = waiter(surfaces);
  const deadline = options.sinceMs + options.timeoutMs;

  for (;;) {
    const messages = await read(options.sinceMs);
    for (const message of messages) {
      if (message.receivedAtMs < options.sinceMs) continue;
      if (options.consumed.has(message.id)) continue;
      const value = options.extract(message.text);
      if (value !== null) return { value, message };
    }
    if (now() >= deadline) return null;
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Compile a customer-supplied pattern, or say it is the thing that is broken.
 *
 * A bad `linkPattern` or `codePattern` is MISCONFIGURED at step CONFIG, never a
 * delivery that timed out: those send the reader to two different places.
 */
function compilePattern(
  mask: Masker,
  pattern: string,
  field: string,
): { ok: true; regex: RegExp } | { ok: false; result: LoginResult } {
  try {
    return { ok: true, regex: new RegExp(pattern) };
  } catch (err) {
    return {
      ok: false,
      result: failed(
        mask,
        'MISCONFIGURED',
        'CONFIG',
        `The profile's ${field} is not a valid regular expression: ${errorText(err)}`,
      ),
    };
  }
}

// ─── FORM_LOGIN ──────────────────────────────────────────────────────────────

/**
 * Drive a real login form.
 *
 * `surfaces` is optional and defaults to the real Playwright adapter, which is
 * why the API's "test this profile" route keeps working unchanged while every
 * branch below is reachable from a test.
 */
export async function performFormLogin(
  config: FormLoginConfig,
  secrets: Readonly<Record<string, string>>,
  baseUrl: string,
  surfaces: LoginSurfaces = {},
  /**
   * Origins the customer has declared are theirs, from the environment's crawl
   * policy. Empty means "this environment's own origin and nothing else" — see
   * {@link ownOriginUrl} for why a cross-origin login host is declared rather
   * than inferred.
   */
  allowedOrigins: readonly string[] = [],
): Promise<LoginResult> {
  const mask = maskerFor(secrets);

  // POLICY FIRST: refused before a secret is read out of the vault and before a
  // browser is launched, because neither should happen for a login we will not drive.
  const entry = ownOriginUrl(mask, config.loginUrl, baseUrl, 'loginUrl', allowedOrigins);
  if (!entry.ok) return entry.result;
  const required = requireSecrets(mask, secrets, [
    config.usernameSecretName,
    config.passwordSecretName,
  ]);
  if (!required.ok) return required.result;
  const [username = '', password = ''] = required.values;

  let browser: LoginBrowser;
  try {
    browser = await openBrowser(surfaces);
  } catch (err) {
    return failed(mask, 'DRIVER_ERROR', 'NAVIGATE', `No browser: ${errorText(err)}`);
  }

  try {
    return (
      (await navigate(mask, browser, entry.url)) ??
      (await drive(mask, browser, 'IDENTIFY', 'Entering the username', () =>
        browser.fill(config.usernameSelector, username, ACTION_TIMEOUT_MS),
      )) ??
      (await drive(mask, browser, 'CREDENTIAL', 'Entering the password', () =>
        browser.fill(config.passwordSelector, password, ACTION_TIMEOUT_MS),
      )) ??
      (await drive(mask, browser, 'CREDENTIAL', 'Submitting the form', () =>
        browser.click(config.submitSelector, ACTION_TIMEOUT_MS),
      )) ??
      (await confirm(mask, browser, config.successSelector)) ??
      (await captureSession(mask, browser, 'SUCCESS_LOCATOR', 'Signed in'))
    );
  } catch (err) {
    return failed(mask, 'DRIVER_ERROR', 'NAVIGATE', `The login could not be driven: ${errorText(err)}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── COOKIE_INJECTION ────────────────────────────────────────────────────────

/**
 * Cookie injection — no browser needed. The secret holds a JSON cookie array
 * exported from a real session.
 */
export function performCookieInjection(
  config: CookieInjectionConfig,
  secrets: Readonly<Record<string, string>>,
): LoginResult {
  const mask = maskerFor(secrets);
  const required = requireSecrets(mask, secrets, [config.cookiesSecretName]);
  if (!required.ok) return required.result;
  const [raw = ''] = required.values;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return failed(
      mask,
      'MISCONFIGURED',
      'CONFIG',
      `${config.cookiesSecretName} is not valid JSON — it should be a Playwright cookie array.`,
    );
  }

  const cookies = (Array.isArray(parsed) ? parsed : []).map((c) => ({
    ...(c as Record<string, unknown>),
    domain: (c as { domain?: string }).domain ?? config.domain,
    path: (c as { path?: string }).path ?? '/',
  }));
  if (cookies.length === 0) {
    return failed(
      mask,
      'MISCONFIGURED',
      'CONFIG',
      'The secret parsed but contained no cookies.',
    );
  }

  return succeeded(
    mask,
    { cookies, origins: [] },
    // Nothing was driven, so nothing was confirmed. Saying SUCCESS_LOCATOR here
    // would claim an assertion that did not happen: a stale exported cookie
    // injects just as cleanly as a live one.
    'NOT_APPLICABLE',
    `Injected ${cookies.length} cookie(s) for ${config.domain}.`,
  );
}

// ─── SSO_BYPASS_TOKEN ────────────────────────────────────────────────────────

/**
 * An SSO bypass token is a header, not a session, so there is no storageState
 * to capture — it is validated for presence and reported honestly.
 */
export function performSsoToken(
  config: SsoTokenConfig,
  secrets: Readonly<Record<string, string>>,
): LoginResult {
  const mask = maskerFor(secrets);
  const required = requireSecrets(mask, secrets, [config.tokenSecretName]);
  if (!required.ok) return required.result;

  return succeeded(
    mask,
    null,
    'NOT_APPLICABLE',
    `Token present. It is sent as the ${config.header} header on every request.`,
  );
}

// ─── TOTP_MFA ────────────────────────────────────────────────────────────────

/**
 * Password, then the authenticator code.
 *
 * The code is derived from the vault seed and the clock and exists only inside
 * this function — it is not returned, not stored and not put in a message, so
 * there is no field anywhere that could hold one.
 *
 * The second factor is CONDITIONAL in a way the code deliberately is not: some
 * applications show the code field only after the password is accepted, others
 * render it on the same page. Waiting for the code field before filling it
 * handles both, and a code field that never appears is a REJECTED first
 * factor — the password was wrong — rather than a TOTP problem. Reporting that
 * at step SECOND_FACTOR would send the reader to check their seed.
 */
export async function performTotpMfaLogin(
  config: TotpMfaLoginConfig,
  secrets: Readonly<Record<string, string>>,
  baseUrl: string,
  surfaces: LoginSurfaces = {},
  /**
   * Origins the customer has declared are theirs, from the environment's crawl
   * policy. Empty means "this environment's own origin and nothing else" — see
   * {@link ownOriginUrl} for why a cross-origin login host is declared rather
   * than inferred.
   */
  allowedOrigins: readonly string[] = [],
): Promise<LoginResult> {
  const mask = maskerFor(secrets);

  // POLICY FIRST: refused before a secret is read out of the vault and before a
  // browser is launched, because neither should happen for a login we will not drive.
  const entry = ownOriginUrl(mask, config.loginUrl, baseUrl, 'loginUrl', allowedOrigins);
  if (!entry.ok) return entry.result;
  const required = requireSecrets(mask, secrets, [
    config.usernameSecretName,
    config.passwordSecretName,
    config.seedSecretName,
  ]);
  if (!required.ok) return required.result;
  const [username = '', password = '', seed = ''] = required.values;

  let browser: LoginBrowser;
  try {
    browser = await openBrowser(surfaces);
  } catch (err) {
    return failed(mask, 'DRIVER_ERROR', 'NAVIGATE', `No browser: ${errorText(err)}`);
  }

  try {
    const firstFactor =
      (await navigate(mask, browser, entry.url)) ??
      (await drive(mask, browser, 'IDENTIFY', 'Entering the username', () =>
        browser.fill(config.usernameSelector, username, ACTION_TIMEOUT_MS),
      )) ??
      (await drive(mask, browser, 'CREDENTIAL', 'Entering the password', () =>
        browser.fill(config.passwordSelector, password, ACTION_TIMEOUT_MS),
      )) ??
      (await drive(mask, browser, 'CREDENTIAL', 'Submitting the first factor', () =>
        browser.click(config.submitSelector, ACTION_TIMEOUT_MS),
      ));
    if (firstFactor) return firstFactor;

    // The code field is the receipt for the first factor. Its absence is a
    // rejected password, which is why this is CREDENTIAL and not SECOND_FACTOR.
    let prompted: boolean;
    try {
      prompted = await browser.waitFor(config.codeSelector, CONFIRM_TIMEOUT_MS);
    } catch (err) {
      return failed(
        mask,
        'DRIVER_ERROR',
        'CREDENTIAL',
        `Waiting for the authenticator code field: ${errorText(err)}`,
      );
    }
    if (!prompted) {
      const title = await browser.title().catch(() => '');
      return failed(
        mask,
        'REJECTED',
        'CREDENTIAL',
        `The authenticator code field "${config.codeSelector}" never appeared` +
          (title ? ` (page title: "${title}")` : '') +
          '. The password was not accepted, so the second factor was never reached.',
      );
    }

    let fresh: { code: TotpCode; waitedMs: number };
    try {
      fresh = await freshTotpCode(seed, surfaces);
    } catch (err) {
      // A bad seed is configuration, not a failed login: the arithmetic never ran.
      return failed(
        mask,
        'MISCONFIGURED',
        'CONFIG',
        `${config.seedSecretName} is not a usable authenticator seed: ${errorText(err)}`,
      );
    }

    const secondFactor =
      (await drive(mask, browser, 'SECOND_FACTOR', 'Entering the authenticator code', () =>
        browser.fill(config.codeSelector, fresh.code.code, ACTION_TIMEOUT_MS),
      )) ??
      (await drive(mask, browser, 'SECOND_FACTOR', 'Submitting the authenticator code', () =>
        browser.click(config.submitSelector, ACTION_TIMEOUT_MS),
      )) ??
      (await confirm(mask, browser, config.successSelector, 'SECOND_FACTOR'));
    if (secondFactor) return secondFactor;

    const waited =
      fresh.waitedMs > 0
        ? ` (waited ${fresh.waitedMs}ms for a fresh code rather than racing the window)`
        : '';
    return captureSession(
      mask,
      browser,
      'SUCCESS_LOCATOR',
      `Signed in with an authenticator code${waited}`,
    );
  } catch (err) {
    return failed(mask, 'DRIVER_ERROR', 'SECOND_FACTOR', `The login could not be driven: ${errorText(err)}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── MAGIC_LINK ──────────────────────────────────────────────────────────────

/** How many times a magic-link login will ask for a link before giving up. */
export const MAGIC_LINK_ATTEMPTS = 2;

/** How long one attempt waits for its link. */
export const MAGIC_LINK_TIMEOUT_MS = 60_000;

/**
 * Ask for a link, wait for it, follow it.
 *
 * ── THE SINGLE-USE TRAP ─────────────────────────────────────────────────────
 *
 * A magic link is consumed by being followed. So a retry must request a NEW
 * link: replaying the one from the previous attempt produces a login that works
 * the first time and fails every time afterwards, and the symptom — "the second
 * crawl of this environment always fails" — points squarely at the application.
 * Two things enforce it. Each attempt re-submits the request form and records
 * its OWN `requestedAtMs`, and only messages at or after that instant are
 * eligible; and every link this function follows is added to `consumed`, so
 * even a sink that ignores the time filter cannot hand the same one back.
 *
 * ── THE UNTRUSTED MAILBOX ───────────────────────────────────────────────────
 *
 * Anyone can post a message into a catcher, and the config's `linkPattern`
 * defaults to "any URL". Following whatever URL turns up in a mailbox is a way
 * to be walked off the application under test, so a link is followed only when
 * it is on the environment's own origin. A foreign one is REFUSED_BY_POLICY
 * naming the origin, which is also how a customer finds out their mail goes
 * through a click-tracking rewriter.
 *
 * ── WHAT IT CAN AND CANNOT CONFIRM ──────────────────────────────────────────
 *
 * The stored MAGIC_LINK config has no `successSelector` field, so the strongest
 * confirmation available is the link navigation's own status plus the fact that
 * it did not land back on the request page. That is weaker than a locator and
 * it is reported as `STATUS_AND_URL_ONLY` rather than quietly called the same
 * thing. See the note in `signInWithProfile` about the stored shape.
 */
export async function performMagicLinkLogin(
  config: MagicLinkConfig,
  secrets: Readonly<Record<string, string>>,
  baseUrl: string,
  surfaces: LoginSurfaces = {},
  /**
   * Origins the customer has declared are theirs, from the environment's crawl
   * policy. Empty means "this environment's own origin and nothing else" — see
   * {@link ownOriginUrl} for why a cross-origin login host is declared rather
   * than inferred.
   */
  allowedOrigins: readonly string[] = [],
): Promise<LoginResult> {
  const mask = maskerFor(secrets);

  const blocked = authAdapterUnavailable('MAGIC_LINK', loginCapabilities(surfaces));
  if (blocked) return unavailable(mask, blocked, 'DELIVERY');
  const mailbox = surfaces.mailbox;
  if (!mailbox) return unavailable(mask, forced('MAGIC_LINK', 'MAILBOX_POLL'), 'DELIVERY');

  // POLICY FIRST: refused before a secret is read out of the vault and before a
  // browser is launched, because neither should happen for a login we will not drive.
  const entry = ownOriginUrl(mask, config.requestUrl, baseUrl, 'requestUrl', allowedOrigins);
  if (!entry.ok) return entry.result;

  const pattern = compilePattern(mask, config.linkPattern, 'linkPattern');
  if (!pattern.ok) return pattern.result;

  const now = clock(surfaces);
  const requestUrl = entry.url;
  const consumed = new Set<string>();

  let browser: LoginBrowser;
  try {
    browser = await openBrowser(surfaces);
  } catch (err) {
    return failed(mask, 'DRIVER_ERROR', 'NAVIGATE', `No browser: ${errorText(err)}`);
  }

  try {
    let lastTimeout: LoginResult | null = null;

    for (let attempt = 1; attempt <= MAGIC_LINK_ATTEMPTS; attempt += 1) {
      const requested =
        (await navigate(mask, browser, requestUrl)) ??
        (await drive(mask, browser, 'IDENTIFY', 'Entering the mailbox address', () =>
          browser.fill(config.emailSelector, config.mailbox, ACTION_TIMEOUT_MS),
        )) ??
        (await drive(mask, browser, 'CREDENTIAL', 'Requesting the link', () =>
          browser.click(config.submitSelector, ACTION_TIMEOUT_MS),
        ));
      if (requested) return requested;

      // Recorded AFTER the request, so a link already sitting in the mailbox
      // from a previous attempt cannot satisfy this one.
      const requestedAtMs = now();

      const found = await pollSink(
        surfaces,
        (sinceMs) => mailbox.poll({ mailbox: config.mailbox, sinceMs }),
        {
          sinceMs: requestedAtMs,
          timeoutMs: MAGIC_LINK_TIMEOUT_MS,
          consumed,
          extract: (text) => pattern.regex.exec(text)?.[0] ?? null,
        },
      );

      if (!found) {
        lastTimeout = failed(
          mask,
          'TIMED_OUT',
          'DELIVERY',
          `No link matching the profile's pattern arrived at ${config.mailbox} within ` +
            `${MAGIC_LINK_TIMEOUT_MS / 1000}s of attempt ${attempt} of ${MAGIC_LINK_ATTEMPTS}. ` +
            'Nothing was learned about what is behind this login — the wall was never passed.',
        );
        continue;
      }

      consumed.add(found.message.id);

      if (!isOwnOrigin(baseUrl, found.value)) {
        // Deliberately names the ORIGIN and not the link: a magic-link URL is a
        // single-use credential and must not appear in a message.
        let foreign = 'an unparseable URL';
        try {
          foreign = new URL(found.value).origin;
        } catch {
          /* keep the placeholder; an unparseable link is reported as such */
        }
        return failed(
          mask,
          'REFUSED_BY_POLICY',
          'FOLLOW_LINK',
          `The link in that message points at ${foreign}, which is not this environment. ` +
            'QAAI will not follow a link out of a mailbox to another origin. If your mail ' +
            "goes through a click tracker, point the profile's mailbox at a sink that " +
            'receives the raw message.',
        );
      }

      let nav: LoginNavigation;
      try {
        nav = await browser.goto(found.value, NAVIGATE_TIMEOUT_MS);
      } catch (err) {
        return failed(
          mask,
          'DRIVER_ERROR',
          'FOLLOW_LINK',
          `Following the link failed: ${errorText(err)}`,
        );
      }

      if (!nav.ok || (nav.status !== null && nav.status >= 400)) {
        // A consumed or expired link answers 4xx. Worth another attempt, since
        // the new one will be freshly minted.
        lastTimeout = failed(
          mask,
          'REJECTED',
          'FOLLOW_LINK',
          `The link was rejected` +
            (nav.status === null ? '' : ` (HTTP ${nav.status})`) +
            `. Attempt ${attempt} of ${MAGIC_LINK_ATTEMPTS}; a single-use link that has ` +
            'already been followed answers this way.',
        );
        continue;
      }

      if (sameRoute(nav.url, requestUrl)) {
        lastTimeout = failed(
          mask,
          'REJECTED',
          'FOLLOW_LINK',
          'Following the link landed back on the request page, so the link was not accepted.',
        );
        continue;
      }

      return captureSession(
        mask,
        browser,
        // No locator is configurable for this kind. Disclosed, not promoted.
        'STATUS_AND_URL_ONLY',
        'Followed the emailed link',
      );
    }

    return (
      lastTimeout ??
      failed(mask, 'TIMED_OUT', 'DELIVERY', 'The link never arrived and no attempt reported why.')
    );
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Same origin and same path — the query is where a magic link's token lives. */
function sameRoute(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return false;
  }
}

// ─── PASSKEY ─────────────────────────────────────────────────────────────────

/**
 * Passkey / WebAuthn through a CDP virtual authenticator.
 *
 * There is no password to type, so this kind is not FORM_LOGIN with a different
 * selector — the credential is produced by a virtual authenticator attached to
 * the session, and an application whose only login is a passkey is otherwise
 * entirely uncoverable.
 *
 * TWO STAGES OF UNAVAILABLE, both of which have to be sayable. A caller with no
 * `webAuthn` factory cannot do passkeys at all. A caller WITH one may still be
 * driving a Firefox or WebKit session, where the CDP `WebAuthn` domain does not
 * exist — so the factory returns null and the answer is the same UNAVAILABLE
 * with CDP_WEBAUTHN named, decided against the real session rather than guessed
 * in advance. Neither is `ok: false, "login failed"`: an absent authenticator is
 * not a rejected credential, and reporting it as one would have the customer
 * auditing an application that is behaving correctly.
 */
export async function performPasskeyLogin(
  config: PasskeyConfig,
  secrets: Readonly<Record<string, string>>,
  baseUrl: string,
  surfaces: LoginSurfaces = {},
  /**
   * Origins the customer has declared are theirs, from the environment's crawl
   * policy. Empty means "this environment's own origin and nothing else" — see
   * {@link ownOriginUrl} for why a cross-origin login host is declared rather
   * than inferred.
   */
  allowedOrigins: readonly string[] = [],
): Promise<LoginResult> {
  const mask = maskerFor(secrets);

  const blocked = authAdapterUnavailable('PASSKEY', loginCapabilities(surfaces));
  if (blocked) return unavailable(mask, blocked, 'SECOND_FACTOR');
  const factory = surfaces.webAuthn;
  if (!factory) return unavailable(mask, forced('PASSKEY', 'CDP_WEBAUTHN'), 'SECOND_FACTOR');

  // POLICY FIRST: refused before a secret is read out of the vault and before a
  // browser is launched, because neither should happen for a login we will not drive.
  const entry = ownOriginUrl(mask, config.loginUrl, baseUrl, 'loginUrl', allowedOrigins);
  if (!entry.ok) return entry.result;

  // Only read when the config asks for an enrolled credential, so a
  // discoverable-credential flow is not refused for a secret it does not use.
  let credential: string | null = null;
  if (config.credentialSecretName) {
    const required = requireSecrets(mask, secrets, [config.credentialSecretName]);
    if (!required.ok) return required.result;
    credential = required.values[0] ?? null;
  }

  let username: string | null = null;
  if (config.usernameSecretName) {
    const required = requireSecrets(mask, secrets, [config.usernameSecretName]);
    if (!required.ok) return required.result;
    username = required.values[0] ?? null;
  }

  let browser: LoginBrowser;
  try {
    browser = await openBrowser(surfaces);
  } catch (err) {
    return failed(mask, 'DRIVER_ERROR', 'NAVIGATE', `No browser: ${errorText(err)}`);
  }

  let authenticator: VirtualAuthenticatorSurface | null;
  try {
    authenticator = factory(browser);
  } catch (err) {
    await browser.close().catch(() => {});
    return failed(
      mask,
      'DRIVER_ERROR',
      'SECOND_FACTOR',
      `Attaching a virtual authenticator failed: ${errorText(err)}`,
    );
  }
  if (!authenticator) {
    await browser.close().catch(() => {});
    return unavailable(mask, forced('PASSKEY', 'CDP_WEBAUTHN'), 'SECOND_FACTOR');
  }

  if (credential !== null && typeof authenticator.addCredential !== 'function') {
    await browser.close().catch(() => {});
    return unavailable(
      mask,
      forced('PASSKEY', 'CDP_WEBAUTHN'),
      'SECOND_FACTOR',
      `This profile names an enrolled credential (${config.credentialSecretName}) and this ` +
        'session can attach a virtual authenticator but cannot inject a credential into it, ' +
        'so the enrolled-credential flow cannot run.',
    );
  }

  let authenticatorId: string | null = null;
  try {
    const added = await authenticator.add(config.authenticator);
    authenticatorId = added.authenticatorId;

    if (credential !== null) {
      // The credential is vault material and is never logged, not even its length.
      await authenticator.addCredential?.(authenticatorId, credential);
    }

    const walked =
      (await navigate(mask, browser, entry.url)) ??
      (username !== null && config.usernameSelector
        ? await drive(mask, browser, 'IDENTIFY', 'Entering the username', () =>
            browser.fill(config.usernameSelector ?? '', username ?? '', ACTION_TIMEOUT_MS),
          )
        : null) ??
      (await drive(mask, browser, 'SECOND_FACTOR', 'Starting the passkey ceremony', () =>
        browser.click(config.submitSelector, ACTION_TIMEOUT_MS),
      )) ??
      (await confirm(mask, browser, config.successSelector, 'SECOND_FACTOR'));
    if (walked) return walked;

    return await captureSession(mask, browser, 'SUCCESS_LOCATOR', 'Signed in with a passkey');
  } catch (err) {
    return failed(
      mask,
      'DRIVER_ERROR',
      'SECOND_FACTOR',
      `The passkey ceremony could not be driven: ${errorText(err)}`,
    );
  } finally {
    // Removed before the browser closes, and never allowed to mask the result:
    // a cleanup that throws would otherwise turn a successful login into a
    // driver error, which is the most confusing lie available here.
    if (authenticatorId !== null) {
      await authenticator.remove(authenticatorId).catch(() => {});
    }
    await browser.close().catch(() => {});
  }
}

// ─── PHONE_OTP ───────────────────────────────────────────────────────────────

/** How many times a phone-OTP login will ask for a code before giving up. */
export const PHONE_OTP_ATTEMPTS = 2;

/**
 * A code sent to a phone, read out of a sink the customer owns.
 *
 * The same shape as the magic link and the same two traps. A code is single-use
 * and usually short-lived, so a retry REQUESTS A NEW ONE and only deliveries at
 * or after that request are eligible — replaying the previous attempt's code
 * produces exactly the "every second run fails" symptom. And a sink is
 * untrusted input: the configured `codePattern` is the only thing that turns
 * its text into a code, and neither the text nor the code appears in any
 * message this function returns.
 *
 * QAAI never reads a real phone; there isn't one. A flow whose code arrives
 * only on a handset is UNAVAILABLE with OTP_SINK named, which is an honest
 * answer. Guessing a six-digit code is not an answer at all.
 */
export async function performPhoneOtpLogin(
  config: PhoneOtpConfig,
  secrets: Readonly<Record<string, string>>,
  baseUrl: string,
  surfaces: LoginSurfaces = {},
  /**
   * Origins the customer has declared are theirs, from the environment's crawl
   * policy. Empty means "this environment's own origin and nothing else" — see
   * {@link ownOriginUrl} for why a cross-origin login host is declared rather
   * than inferred.
   */
  allowedOrigins: readonly string[] = [],
): Promise<LoginResult> {
  const mask = maskerFor(secrets);

  const blocked = authAdapterUnavailable('PHONE_OTP', loginCapabilities(surfaces));
  if (blocked) return unavailable(mask, blocked, 'DELIVERY');
  const sink = surfaces.otpSink;
  if (!sink) return unavailable(mask, forced('PHONE_OTP', 'OTP_SINK'), 'DELIVERY');

  // POLICY FIRST: refused before a secret is read out of the vault and before a
  // browser is launched, because neither should happen for a login we will not drive.
  const entry = ownOriginUrl(mask, config.loginUrl, baseUrl, 'loginUrl', allowedOrigins);
  if (!entry.ok) return entry.result;

  const required = requireSecrets(mask, secrets, [config.phoneSecretName]);
  if (!required.ok) return required.result;
  const [phone = ''] = required.values;

  const pattern = compilePattern(mask, config.codePattern, 'codePattern');
  if (!pattern.ok) return pattern.result;

  const now = clock(surfaces);
  const timeoutMs = config.timeoutSeconds * 1000;
  const consumed = new Set<string>();

  let browser: LoginBrowser;
  try {
    browser = await openBrowser(surfaces);
  } catch (err) {
    return failed(mask, 'DRIVER_ERROR', 'NAVIGATE', `No browser: ${errorText(err)}`);
  }

  try {
    let last: LoginResult | null = null;

    for (let attempt = 1; attempt <= PHONE_OTP_ATTEMPTS; attempt += 1) {
      const requested =
        (await navigate(mask, browser, entry.url)) ??
        (await drive(mask, browser, 'IDENTIFY', 'Entering the phone number', () =>
          browser.fill(config.phoneSelector, phone, ACTION_TIMEOUT_MS),
        )) ??
        (await drive(mask, browser, 'CREDENTIAL', 'Requesting the code', () =>
          browser.click(config.requestSelector, ACTION_TIMEOUT_MS),
        ));
      if (requested) return requested;

      const requestedAtMs = now();

      const found = await pollSink(
        surfaces,
        (sinceMs) => sink.poll({ sink: config.sink, sinceMs }),
        {
          sinceMs: requestedAtMs,
          timeoutMs,
          consumed,
          // Capture group first when there is one, so a pattern that brackets
          // the digits inside surrounding text yields the digits.
          extract: (text) => {
            const match = pattern.regex.exec(text);
            if (!match) return null;
            return match[1] ?? match[0];
          },
        },
      );

      if (!found) {
        last = failed(
          mask,
          'TIMED_OUT',
          'DELIVERY',
          `No code matching the profile's pattern reached the configured sink within ` +
            `${config.timeoutSeconds}s of attempt ${attempt} of ${PHONE_OTP_ATTEMPTS}. The ` +
            'wall was never passed, so nothing was learned about the surface behind it.',
        );
        continue;
      }

      consumed.add(found.message.id);

      const entered =
        (await drive(mask, browser, 'SECOND_FACTOR', 'Entering the code', () =>
          browser.fill(config.codeSelector, found.value, ACTION_TIMEOUT_MS),
        )) ??
        (await drive(mask, browser, 'SECOND_FACTOR', 'Submitting the code', () =>
          browser.click(config.submitSelector, ACTION_TIMEOUT_MS),
        ));
      if (entered) return entered;

      const confirmed = await confirm(mask, browser, config.successSelector, 'SECOND_FACTOR');
      if (confirmed) {
        // A rejected code is worth one more freshly-requested attempt, which is
        // the whole reason the loop exists.
        last = confirmed;
        continue;
      }

      return await captureSession(mask, browser, 'SUCCESS_LOCATOR', 'Signed in with a phone code');
    }

    return (
      last ??
      failed(mask, 'TIMED_OUT', 'DELIVERY', 'The code never arrived and no attempt reported why.')
    );
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── MOCK_IDP ────────────────────────────────────────────────────────────────

/**
 * Single sign-on against a MOCK identity provider the customer configured.
 *
 * ── WHY THIS KIND IS THE ROLE AXIS ──────────────────────────────────────────
 *
 * An SSO-fronted application decides a user's role from an assertion. Minting
 * the assertion is therefore the only way to enumerate as an admin and then as
 * a member, which is the half of coverage that has no denominator today.
 * "Sign in with Google/Okta"-only applications are reachable at the moment only
 * by hand-pasting a cookie that expires, which is to say they are not reachable.
 *
 * ── THIS CANNOT REACH A REAL PROVIDER, AND THAT IS STRUCTURAL ───────────────
 *
 * The rule is that this is a mock for an application the customer owns and
 * configured, and that it never touches a real provider's production sign-in.
 * FIVE properties of the code make that so rather than merely discouraging it.
 * The fifth was added after the first four were found to be insufficient: with
 * `startUrl` unchecked, an absolute `https://accounts.google.com/…` on the
 * profile row put the browser on a real provider's sign-in page on the first
 * navigation, and this comment claimed that could not happen. It is listed
 * last but it is the one that runs first.
 *
 *   1. `environmentKind` is a REQUIRED parameter. There is no overload, no
 *      default and no inference, so no caller can perform this kind without
 *      stating which environment it is against — and PRODUCTION is refused by
 *      `authProfileKindRefusedOn`, re-checked here and not only at the
 *      dispatcher, because this function is exported and callable directly.
 *   2. This function has no network and no transport of its own. The only thing
 *      that can produce an assertion is the injected {@link MockIdpSurface},
 *      and the only arguments it gets are the issuer and claims off the
 *      customer's own profile row.
 *   3. The assertion is delivered ONLY to an endpoint on the environment's own
 *      origin, checked with `isOwnOrigin` before anything is sent. A mint that
 *      hands back somebody else's host is refused, so there is no code path
 *      that posts an assertion to a provider.
 *   4. No signing key passes through here. The mint request names a vault
 *      secret and the surface resolves it, so there is nothing to leak and no
 *      key with which to sign something a real provider would accept.
 *
 *   5. `startUrl` is resolved through {@link ownOriginUrl}, so the ONE
 *      navigation this function chooses is on the environment's own origin (or
 *      an origin the customer declared). A profile naming a provider's host is
 *      REFUSED_BY_POLICY before a browser is opened.
 *
 * The issuer's own URL is never navigated to. We watch where the APPLICATION
 * sends the browser, hand that URL to the mock as the authn request, and
 * deliver what comes back to the application.
 *
 * Note what property 5 does NOT claim: the application's own redirect may
 * still land the browser on whatever host the app is configured to use, and
 * `authnRequestUrl` is read from wherever that is. That is the application
 * under test doing what it does, not a destination this module picked, and the
 * mock is what answers it — no credential is typed there and no assertion is
 * sent there.
 */
export async function performMockIdpLogin(
  config: MockIdpConfig,
  secrets: Readonly<Record<string, string>>,
  baseUrl: string,
  environmentKind: EnvironmentKind,
  surfaces: LoginSurfaces = {},
  /**
   * Origins the customer has declared are theirs, from the environment's crawl
   * policy. Empty means "this environment's own origin and nothing else" — see
   * {@link ownOriginUrl} for why a cross-origin login host is declared rather
   * than inferred.
   */
  allowedOrigins: readonly string[] = [],
): Promise<LoginResult> {
  const mask = maskerFor(secrets);

  // Property 1. Re-checked here rather than trusted to the dispatcher.
  const refused = authProfileKindRefusedOn('MOCK_IDP', environmentKind);
  if (refused) return failed(mask, 'REFUSED_BY_POLICY', 'POLICY', refused);

  // POLICY FIRST: refused before a secret is read out of the vault and before a
  // browser is launched, because neither should happen for a login we will not drive.
  const entry = ownOriginUrl(mask, config.startUrl, baseUrl, 'startUrl', allowedOrigins);
  if (!entry.ok) return entry.result;

  const blocked = authAdapterUnavailable('MOCK_IDP', loginCapabilities(surfaces));
  if (blocked) return unavailable(mask, blocked, 'ASSERTION');
  const idp = surfaces.idp;
  if (!idp) return unavailable(mask, forced('MOCK_IDP', 'MOCK_IDP_ISSUER'), 'ASSERTION');

  let browser: LoginBrowser;
  try {
    browser = await openBrowser(surfaces);
  } catch (err) {
    return failed(mask, 'DRIVER_ERROR', 'NAVIGATE', `No browser: ${errorText(err)}`);
  }

  try {
    const started = await navigate(mask, browser, entry.url);
    if (started) return started;

    // Where the APPLICATION sent us. This is the authn request, and it is read
    // rather than constructed — the mock answers the question the app asked.
    const authnRequestUrl = browser.url();

    let assertion: MintedAssertion;
    try {
      assertion = await idp.mint({
        issuer: config.issuer,
        protocol: config.protocol,
        subject: config.subject,
        claims: config.claims,
        audience: config.audience ?? null,
        lifetimeSeconds: config.lifetimeSeconds,
        signingKeySecretName: config.signingKeySecretName,
        authnRequestUrl,
      });
    } catch (err) {
      return failed(
        mask,
        'DRIVER_ERROR',
        'ASSERTION',
        `The mock identity provider could not mint an assertion: ${errorText(err)}`,
      );
    }

    // Property 3. The one check that makes "never a real provider" structural.
    if (!isOwnOrigin(baseUrl, assertion.url)) {
      let foreign = 'an unparseable URL';
      try {
        foreign = new URL(assertion.url).origin;
      } catch {
        /* keep the placeholder */
      }
      return failed(
        mask,
        'REFUSED_BY_POLICY',
        'ASSERTION',
        `The mock identity provider asked for the assertion to be delivered to ${foreign}, ` +
          'which is not this environment. QAAI delivers a minted assertion only to the ' +
          'application under test, never to another host.',
      );
    }

    let delivered: LoginNavigation;
    try {
      if (assertion.delivery === 'FORM_POST') {
        if (typeof browser.postForm !== 'function') {
          return unavailable(
            mask,
            forced('MOCK_IDP', 'MOCK_IDP_ISSUER'),
            'ASSERTION',
            'A SAML assertion is delivered by an auto-submitted form POST and this browser ' +
              'surface cannot post a form, so the assertion could not be handed to the ' +
              'application. An OIDC profile on the same issuer delivers by redirect and works.',
          );
        }
        delivered = await browser.postForm(
          assertion.url,
          assertion.fields ?? {},
          NAVIGATE_TIMEOUT_MS,
        );
      } else {
        delivered = await browser.goto(assertion.url, NAVIGATE_TIMEOUT_MS);
      }
    } catch (err) {
      return failed(
        mask,
        'DRIVER_ERROR',
        'ASSERTION',
        `Delivering the assertion to the application failed: ${errorText(err)}`,
      );
    }

    if (!delivered.ok || (delivered.status !== null && delivered.status >= 400)) {
      return failed(
        mask,
        'REJECTED',
        'ASSERTION',
        `The application rejected the assertion` +
          (delivered.status === null ? '' : ` (HTTP ${delivered.status})`) +
          `. Check that this environment is configured to trust the issuer "${config.issuer}"` +
          (config.audience ? ` for audience "${config.audience}"` : '') +
          '.',
      );
    }

    const confirmed = await confirm(mask, browser, config.successSelector, 'ASSERTION');
    if (confirmed) return confirmed;

    const named = Object.keys(config.claims);
    return await captureSession(
      mask,
      browser,
      'SUCCESS_LOCATOR',
      `Signed in as "${config.subject}" against the test issuer` +
        // Claim NAMES, never values: a claim value is the role material and
        // belongs in the profile, not in a message.
        (named.length > 0 ? ` with claim(s) ${named.join(', ')}` : ' with no extra claims'),
    );
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── UNAVAILABLE, said once ──────────────────────────────────────────────────

/**
 * A capability gap, reported the way rule 10 requires.
 *
 * Not `ok: false` with a sentence: `unavailable` carries the shared missing
 * list and per-capability remedy, and the fault is UNDETERMINED because
 * nothing was attempted. There is no login here to have failed, and a report
 * that said one had failed would have the customer auditing an application
 * that behaved perfectly.
 */
function unavailable(
  mask: Masker,
  gap: AuthAdapterUnavailable,
  step: LoginStep,
  detail?: string,
): LoginResult {
  const body =
    detail ??
    `A ${gap.kind} login needs ${gap.missing.join(', ')}, which this worker does not have, ` +
      'so no login was attempted and nothing is known about the surface behind this wall.';
  return failed(mask, 'UNAVAILABLE', step, `${body} ${gap.remedy}`, gap);
}

/**
 * The gap for a capability we KNOW is missing because we just looked for it.
 *
 * `authAdapterUnavailable` answers from a capability list, and that list is
 * computed from which surfaces were supplied — so it agrees with the direct
 * check below it in every normal case. This exists for the cases where it
 * cannot: a `webAuthn` factory that is present but returns null for this
 * session, and a `postForm` the browser does not implement. Those are facts
 * about the OPEN session rather than the configuration, and the report has to
 * carry the same missing list and remedy as if the surface had never been
 * supplied, rather than degrading into a driver error.
 */
function forced(kind: AuthProfileKind, capability: AuthCapability): AuthAdapterUnavailable {
  // The remedy is built from the ONE capability that is missing, not by asking
  // `authAdapterUnavailable(kind, [])`. That call would report every capability
  // the kind needs — so a Chromium session that cannot serve a virtual
  // authenticator would be told to go and install Playwright's browsers, which
  // are already installed and are not the problem. A remedy for something that
  // is not missing is a cap reported without being the cap that bit.
  return { kind, missing: [capability], remedy: AUTH_CAPABILITY_REMEDY[capability] };
}

// ─── The Playwright adapter: thin, and the only thing here that imports it ───

/*
 * The in-page half of `postForm`.
 *
 * Two house rules apply and both are load bearing. It runs INSIDE the browser,
 * so it may not reference anything in module scope — the action and the fields
 * arrive in its argument — and the runner's tsconfig has no DOM lib, so the
 * handful of DOM it touches is declared structurally below, the way
 * `a11y-deep.ts` declares its collectors' surface.
 *
 * It goes through `inPage` for the reason documented there: esbuild's
 * `keepNames` is on by default in tsx, which is how this repo runs the worker in
 * development, and it rewrites a named inner function into a call to a module
 * helper the page does not have. The failure is a `ReferenceError` inside the
 * page, which here would surface as a SAML assertion that silently never
 * arrives.
 */
interface FormDomElement {
  method: string;
  action: string;
  type: string;
  name: string;
  value: string;
  appendChild(child: FormDomElement): void;
  submit(): void;
}

interface FormDomDocument {
  body: FormDomElement;
  createElement(tag: string): FormDomElement;
}

function submitAssertionForm(arg: {
  action: string;
  fields: Readonly<Record<string, string>>;
}): void {
  const doc = (globalThis as unknown as { document: FormDomDocument }).document;
  const form = doc.createElement('form');
  form.method = 'POST';
  form.action = arg.action;
  for (const name of Object.keys(arg.fields)) {
    const input = doc.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = arg.fields[name] ?? '';
    form.appendChild(input);
  }
  doc.body.appendChild(form);
  form.submit();
}

/**
 * The one real browser.
 *
 * Deliberately without judgement: every method is a direct call, every failure
 * is turned into the surface's own vocabulary, and nothing decides anything. A
 * bug in here is visible the first time a real login runs; a bug in the logic
 * above would not be, which is why the logic above is the part with tests.
 *
 * `postForm` is implemented because Chromium can do it, and it is what makes a
 * SAML MOCK_IDP profile work. It builds the form in the page rather than
 * issuing a request, because the assertion has to arrive with the browser's own
 * cookie jar attached or the session it establishes is not the session we then
 * capture.
 */
export async function playwrightLoginBrowser(): Promise<LoginBrowser> {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const navigationOf = async (run: () => Promise<{ status: number | null } | null>) => {
    try {
      const response = await run();
      const status = response?.status ?? null;
      return {
        ok: status === null || status < 400,
        url: page.url(),
        status,
        error: null,
      } satisfies LoginNavigation;
    } catch (err) {
      return {
        ok: false,
        url: page.url(),
        status: null,
        error: errorText(err),
      } satisfies LoginNavigation;
    }
  };

  return {
    url: () => page.url(),

    goto: (url, timeoutMs) =>
      navigationOf(async () => {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        return response ? { status: response.status() } : null;
      }),

    postForm: (url, fields, timeoutMs) =>
      navigationOf(async () => {
        const navigation = page.waitForNavigation({
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        });
        await page.evaluate(inPage(submitAssertionForm), { action: url, fields });
        const response = await navigation;
        return response ? { status: response.status() } : null;
      }),

    fill: async (selector, value, timeoutMs) => {
      await page.fill(selector, value, { timeout: timeoutMs });
      return true;
    },

    click: async (selector, timeoutMs) => {
      await page.click(selector, { timeout: timeoutMs });
      return true;
    },

    waitFor: async (selector, timeoutMs) => {
      try {
        await page.waitForSelector(selector, { timeout: timeoutMs, state: 'visible' });
        return true;
      } catch {
        // Absent is a measurement here, not an exception. See LoginBrowser.
        return false;
      }
    },

    title: () => page.title(),
    storageState: () => context.storageState(),
    close: () => browser.close(),
  };
}

// ─── One profile, one session ────────────────────────────────────────────────

/** The columns of an `AuthProfile` row a sign-in actually needs. */
export interface AuthProfileRef {
  id: string;
  name: string;
  kind: AuthProfileKind;
  /** Non-secret config; validated per kind before anything is driven. */
  config: unknown;
}

/**
 * Every kind this module can actually perform.
 *
 * COMPILER-ENFORCED, and the reason it exists is the defect it would have
 * caught: MAGIC_LINK and TOTP_MFA were in `AUTH_PROFILE_KINDS` from the start,
 * the picker offered them, and `signInWithProfile`'s `default:` arm answered
 * "not built yet" for the product's whole life. A `Record<AuthProfileKind,
 * true>` makes a ninth kind break THIS line, and `login.test.ts` closes the
 * other half at run time by diffing these keys against the shared kind list and
 * against the config-schema map's keys — the same two-part guard that eight
 * unsaveable `GateRule` kinds taught this codebase to write, because
 * `check:wiring` cannot see this class of break.
 */
const LOGIN_ADAPTER_PRESENT: Record<AuthProfileKind, true> = {
  FORM_LOGIN: true,
  COOKIE_INJECTION: true,
  SSO_BYPASS_TOKEN: true,
  TOTP_MFA: true,
  MAGIC_LINK: true,
  PASSKEY: true,
  PHONE_OTP: true,
  MOCK_IDP: true,
};

/** The kinds {@link signInWithProfile} will drive. Derived, never restated. */
export const PERFORMABLE_AUTH_PROFILE_KINDS = Object.keys(
  LOGIN_ADAPTER_PRESENT,
) as ReadonlyArray<AuthProfileKind>;

export interface SignInContext {
  /**
   * Which environment this is. Required, with no default: MOCK_IDP is refused
   * on PRODUCTION, and a parameter that could be omitted would make the refusal
   * depend on a caller remembering it.
   */
  environmentKind: EnvironmentKind;
  baseUrl: string;
  surfaces?: LoginSurfaces;
  /**
   * Origins the customer has declared are theirs — `CrawlPolicy
   * .additionalOrigins` off the environment row, passed straight through.
   *
   * Omitted means the environment's own origin and nothing else, which is the
   * safe default: {@link ownOriginUrl} refuses a login URL anywhere else, and
   * the remedy in that refusal is to add the origin here. Not a new
   * environment variable and not a flag — it is a customer-owned column,
   * already used for the same question by the crawl.
   */
  additionalOrigins?: readonly string[];
}

/**
 * Sign in as one profile, whatever its kind.
 *
 * The per-kind branch used to exist only in the API's "test this profile"
 * route, which is why a RUN could not log in at all — it had no way to turn a
 * profile row into a session and had to hope a cached one was lying around.
 * Keeping the branch next to the functions it dispatches to means the run and
 * the "Sign in" button in the cockpit cannot drift about what a profile of a
 * given kind does.
 *
 * ── THE ORDER OF THE THREE REFUSALS IS THE POINT ────────────────────────────
 *
 * Policy, then capability, then config — because each one makes the next
 * meaningless. A MOCK_IDP profile on a production environment must be refused
 * before anything is driven, whatever its config says. A kind this worker has
 * no adapter for is UNAVAILABLE and reports nothing about the application. Only
 * then is it worth telling the customer their config is incomplete.
 *
 * The config is re-validated rather than trusted: a profile may predate the
 * per-kind schema, and driving a browser with a half-formed config fails in a
 * way nobody can read.
 */
export async function signInWithProfile(
  profile: AuthProfileRef,
  secrets: Readonly<Record<string, string>>,
  context: SignInContext,
): Promise<LoginResult> {
  const mask = maskerFor(secrets);
  const surfaces = context.surfaces ?? {};
  const baseUrl = context.baseUrl;
  const origins = context.additionalOrigins ?? [];

  const refused = authProfileKindRefusedOn(profile.kind, context.environmentKind);
  if (refused) {
    return failed(
      mask,
      'REFUSED_BY_POLICY',
      'POLICY',
      `"${profile.name}" cannot be used here. ${refused}`,
    );
  }

  const gap = authAdapterUnavailable(profile.kind, loginCapabilities(surfaces));
  if (gap) return unavailable(mask, gap, 'CAPABILITY');

  const parsed = AUTH_PROFILE_CONFIG_SCHEMAS[profile.kind].safeParse(profile.config);
  if (!parsed.success) {
    return failed(
      mask,
      'MISCONFIGURED',
      'CONFIG',
      `The "${profile.name}" ${profile.kind} profile is incomplete: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
        .join('; ')}`,
    );
  }

  switch (profile.kind) {
    case 'FORM_LOGIN':
      return performFormLogin(parsed.data as FormLoginConfig, secrets, baseUrl, surfaces, origins);

    case 'COOKIE_INJECTION':
      return performCookieInjection(parsed.data as CookieInjectionConfig, secrets);

    case 'SSO_BYPASS_TOKEN':
      return performSsoToken(parsed.data as SsoTokenConfig, secrets);

    case 'TOTP_MFA': {
      /*
       * THE STORED SHAPE IS SHORT, AND THIS IS NOT A WORKAROUND FOR IT.
       *
       * The TOTP_MFA config schema holds three fields — the seed, the code
       * selector and the submit selector — and no first factor at all. But the
       * kind IS "password plus authenticator code": there is a username and a
       * password before the code, and the POST route stores `parsed.data`, so
       * zod's `$strip` drops any first-factor fields a client sends. A TOTP_MFA
       * profile therefore cannot currently carry the form it belongs to.
       *
       * So the first factor is parsed with the FORM_LOGIN schema — a
       * COMPOSITION of the two shapes that already exist, not a third shape of
       * this module's own. Two schemas describing one form and disagreeing by a
       * selector is precisely the defect the shared config map was built to
       * prevent, and inventing one here would reintroduce it one layer down.
       *
       * Until the stored schema carries the merged shape, this arm reports
       * MISCONFIGURED naming the missing fields — which is the truth: the
       * profile does not describe a drivable login. It is not reported as a
       * failed or an empty login.
       */
      const firstFactor = AUTH_PROFILE_CONFIG_SCHEMAS.FORM_LOGIN.safeParse(profile.config);
      if (!firstFactor.success) {
        return failed(
          mask,
          'MISCONFIGURED',
          'CONFIG',
          `The "${profile.name}" TOTP_MFA profile has the authenticator half and not the ` +
            `password half: ${firstFactor.error.issues
              .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
              .join('; ')}. A TOTP login is a form login plus a code, so the profile needs ` +
            'both.',
        );
      }
      return performTotpMfaLogin(
        {
          ...(firstFactor.data as FormLoginConfig),
          ...(parsed.data as TotpSecondFactorConfig),
        },
        secrets,
        baseUrl,
        surfaces,
        origins,
      );
    }

    case 'MAGIC_LINK':
      return performMagicLinkLogin(parsed.data as MagicLinkConfig, secrets, baseUrl, surfaces, origins);

    case 'PASSKEY':
      return performPasskeyLogin(parsed.data as PasskeyConfig, secrets, baseUrl, surfaces, origins);

    case 'PHONE_OTP':
      return performPhoneOtpLogin(parsed.data as PhoneOtpConfig, secrets, baseUrl, surfaces, origins);

    case 'MOCK_IDP':
      return performMockIdpLogin(
        parsed.data as MockIdpConfig,
        secrets,
        baseUrl,
        context.environmentKind,
        surfaces,
        origins,
      );

    default: {
      /*
       * A ninth kind breaks THIS line.
       *
       * It replaces the arm that answered "needs the mail catcher / TOTP
       * support that is not built yet" for five years' worth of MAGIC_LINK and
       * TOTP_MFA profiles. A runtime message is how a storable-but-unperformable
       * kind survives; a `never` is how the next one does not ship.
       */
      const unreachable: never = profile.kind;
      return failed(
        mask,
        'UNAVAILABLE',
        'CAPABILITY',
        `${String(unreachable)} has no login adapter in this build.`,
      );
    }
  }
}
