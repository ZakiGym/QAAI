/**
 * The wall at the edge of the map: who QAAI can be, whether it can reach the
 * door at all, and what each identity was allowed to see.
 *
 * WHY THIS FILE EXISTS
 *
 * `surface.ts`, `requirements.ts` and `api-surface.ts` answer "what exists".
 * This file answers the question that decides whether any of that is reachable:
 * WHO is asking. Three absences made three whole classes of customer
 * uncoverable, and none of them was visible as a bug — each read as an
 * application with very little authenticated surface.
 *
 *   1. AN APP WHOSE ONLY LOGIN IS HARDER THAN A FORM HAD ZERO ENUMERABLE
 *      AUTHENTICATED SURFACE. `AUTH_PROFILE_KINDS` has named MAGIC_LINK and
 *      TOTP_MFA since the beginning and `signInWithProfile` in
 *      packages/runner/src/login.ts honours three kinds — FORM_LOGIN,
 *      COOKIE_INJECTION, SSO_BYPASS_TOKEN — and answers the rest with "needs
 *      the mail catcher / TOTP support that is not built yet". So the UI could
 *      STORE a kind the login module could not perform. A passkey app, an
 *      SMS-code app and an SSO-fronted app could not even be described.
 *   2. THERE WAS NO ROLE AXIS. `authProfile.findFirst({ orderBy: { createdAt:
 *      'asc' } })` picks ONE identity for a whole crawl and `FlowNode
 *      .requiresRoles` is set to `[]` unconditionally, so "a member gets 403 on
 *      /admin" has never been expressible: authorization coverage had no
 *      denominator. A 403 is not an absence of surface, it is the correct
 *      behaviour OF a surface, and the most expensive defect class a web
 *      application has lives exactly there.
 *   3. AN APP BEHIND A BOT DEFENCE WAS UNREACHABLE BY EVERY PROFILE KIND AT
 *      ONCE, and reported as an application with nothing in it. A reCAPTCHA on
 *      the login form means coverage is zero for a reason that has nothing to
 *      do with the customer's tests, and saying so is the difference between a
 *      product and a confident 100% of nothing.
 *
 * THE DEFECT THIS FILE IS SHAPED TO PREVENT
 *
 * A kind the UI can store and the login module cannot honour. That is not a
 * hypothetical: eight `GateRule` kinds shipped unsaveable for two slices
 * because the union grew and the zod write path did not, and `check:wiring`
 * cannot see it — a union member with no write path is live code in a reached
 * file. So the same two mechanisms guard the auth kinds, because each catches
 * what the other cannot:
 *
 *   · the COMPILER half — {@link AUTH_PROFILE_CONFIG_SCHEMAS},
 *     {@link AUTH_PROFILE_CAPABILITIES} and {@link AUTH_PROFILE_KIND_LABELS}
 *     are each a `Record` keyed on `AuthProfileKind`. A ninth kind added to
 *     `AUTH_PROFILE_KINDS` breaks all three lines rather than quietly shipping
 *     unsaveable, unperformable and unlabelled.
 *   · the RUN-TIME half — `auth-profiles.test.ts` asserts those keys are
 *     exactly `AUTH_PROFILE_KINDS`, and that every arm parses the shape its
 *     adapter reads. zod's options only exist at run time, so the compiler
 *     cannot do this half and a hand-written list would drift from the union.
 *
 * WHAT HAPPENS TO A KIND WHOSE ADAPTER IS ABSENT
 *
 * {@link authAdapterUnavailable} returns the missing capabilities and a remedy,
 * and the caller reports UNAVAILABLE. Never a silent skip, and never `ok: true`
 * with no session — that is how a logged-out browser gets handed to a test that
 * needs a role, and the run then reports the login wall as "nothing behind it".
 * A login that FAILED and a crawl that found nothing are opposite facts and
 * only one of them is the customer's problem; {@link ROLE_CRAWL_OUTCOMES} is
 * where that difference is stored.
 *
 * SECRETS
 *
 * Every credential-bearing field on every config below is a NAME that resolves
 * in the vault — `…SecretName` — never a value. Nothing in this file logs,
 * returns or embeds a credential, a TOTP seed, a signing key, a bypass token or
 * a session cookie, truncated or otherwise. The one place a value would be
 * tempting is the bot-protection bypass, and {@link BOT_BYPASS_MODES} records
 * the MODE with the header's name while the header's value stays a vault
 * reference.
 *
 * NOTHING HERE DEFEATS A BOT DEFENCE. There is no solver, no challenge-token
 * forger and no evasion. The only two legitimate routes are the ones the
 * providers document — the customer configuring their own test environment with
 * the provider's test keys, or the customer issuing a signed bypass header for
 * their own environment — plus the customer allowlisting our traffic. When none
 * of the three is configured the honest answer is
 * UNREACHABLE_BEHIND_BOT_PROTECTION with the remedy, and that is what this file
 * provides.
 *
 * WHAT THIS FILE IS NOT
 *
 * It stores nothing, reads nothing and drives nothing. It is the vocabulary,
 * the write-path schemas and the handful of derivations that must have exactly
 * one implementation — {@link routeAccessOutcomeFrom},
 * {@link roleHadNoExtraSurface}, {@link authAdapterUnavailable} — or the stored
 * column and the rows it summarises will come to disagree. The adapters live in
 * packages/runner and packages/agent; the rows live in
 * apps/api/prisma/schema.prisma.
 */

import { z } from 'zod';
import type { AuthProfileKind, EnvironmentKind } from './constants';
import { matchesGlob, type AccessOutcome, type RouteAccess } from './flow-map';
/*
 * The five config shapes that already existed. Imported rather than copied:
 * `authProfileConfigSchema` is what the auth-profile write route has always
 * parsed through, and a second copy of those five shapes here would be two
 * sources of truth for the same five configs — the defect this file exists to
 * prevent, reintroduced one layer down. See AUTH_PROFILE_CONFIG_SCHEMAS.
 */
import { authProfileConfigSchema as legacyAuthProfileConfigSchema } from './schemas';

// ─── What an adapter needs before it can perform a kind ──────────────────────

/**
 * The capabilities a login adapter may require from the machine it runs on.
 *
 * This list exists because the honest answer to "can you log into this app" is
 * sometimes NO, and the useful form of that answer names the missing part. Four
 * of the seven cannot be faked in this repo's test environment at all — there
 * is no real IdP, no phone, no authenticator and no mailbox here — so each is
 * declared as a capability, implemented by exactly one thin adapter, and
 * reported ABSENT when the adapter is not there.
 *
 *   NONE                no external capability: a cookie array or a header
 *                       token is a session already, and needs no browser.
 *   BROWSER             a real browser we can drive. Every kind that fills a
 *                       form needs it, and Playwright cannot drive one inside
 *                       a unit test, which is why every module that needs it
 *                       takes its browser surface as an injected interface.
 *   TOTP_CLOCK          a TOTP code derived from a vault seed and the clock.
 *                       Pure arithmetic — the only one of the five hard kinds
 *                       that needs no external system.
 *   MAILBOX_POLL        read a magic link out of a mailbox or a webhook sink
 *                       the customer nominated.
 *   OTP_SINK            read a numeric code out of a sink the customer owns.
 *                       Never a real phone: see {@link phoneOtpConfigSchema}.
 *   CDP_WEBAUTHN        a virtual authenticator over the Chrome DevTools
 *                       Protocol. Chromium-only, and genuinely unavailable on
 *                       a Firefox or WebKit session, which is a fact a report
 *                       must be able to state.
 *   MOCK_IDP_ISSUER     an identity provider the customer's own non-production
 *                       environment is configured to trust.
 */
export const AUTH_CAPABILITIES = [
  'NONE',
  'BROWSER',
  'TOTP_CLOCK',
  'MAILBOX_POLL',
  'OTP_SINK',
  'CDP_WEBAUTHN',
  'MOCK_IDP_ISSUER',
] as const;
export type AuthCapability = (typeof AUTH_CAPABILITIES)[number];

/**
 * What each kind needs, all of it.
 *
 * A list and not a single capability, because the interesting kinds need two —
 * a browser AND the thing that reads the second factor — and a report that
 * named only one of the two missing parts would send the customer to fix the
 * wrong half. `authAdapterUnavailable` returns every missing capability for
 * that reason.
 *
 * COMPILER-ENFORCED. A ninth `AuthProfileKind` breaks this line, which is the
 * point: a kind with no declared capability is a kind whose adapter nobody
 * decided on, and it would otherwise read as "needs nothing" and be attempted.
 */
export const AUTH_PROFILE_CAPABILITIES: Record<AuthProfileKind, readonly AuthCapability[]> = {
  FORM_LOGIN: ['BROWSER'],
  COOKIE_INJECTION: ['NONE'],
  SSO_BYPASS_TOKEN: ['NONE'],
  TOTP_MFA: ['BROWSER', 'TOTP_CLOCK'],
  MAGIC_LINK: ['BROWSER', 'MAILBOX_POLL'],
  PASSKEY: ['BROWSER', 'CDP_WEBAUTHN'],
  PHONE_OTP: ['BROWSER', 'OTP_SINK'],
  MOCK_IDP: ['BROWSER', 'MOCK_IDP_ISSUER'],
};

/**
 * What the customer must do when a capability is absent.
 *
 * A sentence and not a code, because the reader of an UNAVAILABLE report is a
 * person deciding whether their coverage number is their fault. "PASSKEY
 * unsupported" sends nobody anywhere; naming Chromium and the virtual
 * authenticator does.
 */
export const AUTH_CAPABILITY_REMEDY: Record<AuthCapability, string> = {
  NONE: 'Nothing is required — this kind needs no browser and no external system.',
  BROWSER:
    'No browser could be launched on this worker. Run the crawl on a runner with the ' +
    'Playwright browsers installed, or point the environment at an on-prem runner pool.',
  TOTP_CLOCK:
    'Store the authenticator seed in this environment vault and name it in the profile ' +
    "config's seedSecretName; QAAI computes the code and never stores one.",
  MAILBOX_POLL:
    'Give the profile a mailbox QAAI can read the link out of — the built-in catcher ' +
    'address, or a webhook sink you own — in the config mailbox or sink field.',
  OTP_SINK:
    'Point the profile at a sink you own that receives the code: a test number, a ' +
    'webhook, or a non-production endpoint that exposes the last code issued. QAAI ' +
    'never reads a real phone.',
  CDP_WEBAUTHN:
    'Passkey login needs a Chromium session with the DevTools Protocol available, ' +
    'because the credential is served by a virtual authenticator. Firefox and WebKit ' +
    'cannot do it; re-run this environment on Chromium.',
  MOCK_IDP_ISSUER:
    'Configure your non-production environment to trust a test issuer and give the ' +
    "profile that issuer plus the claims to mint. QAAI will not mint for a production " +
    'environment.',
};

/** The label a picker shows. Compiler-enforced, so a new kind cannot be nameless. */
export const AUTH_PROFILE_KIND_LABELS: Record<AuthProfileKind, string> = {
  FORM_LOGIN: 'Username and password form',
  COOKIE_INJECTION: 'Paste a session cookie',
  SSO_BYPASS_TOKEN: 'Bypass token header',
  TOTP_MFA: 'Password plus authenticator code (TOTP)',
  MAGIC_LINK: 'Emailed magic link',
  PASSKEY: 'Passkey / WebAuthn',
  PHONE_OTP: 'Code sent to a phone (SMS or voice)',
  MOCK_IDP: 'Single sign-on against a test identity provider',
};

/** A kind that cannot be performed here, and the reason, in the customer's terms. */
export interface AuthAdapterUnavailable {
  kind: AuthProfileKind;
  /** Every capability the kind needs and this machine does not have. */
  missing: readonly AuthCapability[];
  /** One remedy per missing capability, joined — what to do about it. */
  remedy: string;
}

/**
 * Whether this kind can be performed with the capabilities on hand — null when
 * it can.
 *
 * Null for "yes" rather than a boolean, because the interesting answer carries
 * data and the uninteresting one does not. A caller writes:
 *
 *   const blocked = authAdapterUnavailable(profile.kind, present);
 *   if (blocked) return unavailable(blocked);
 *
 * and cannot accidentally treat "unavailable" as "fine" the way `!ok` inverts.
 *
 * NONE is in `AUTH_CAPABILITIES` and is deliberately always satisfied: a kind
 * that needs nothing must not be blocked by an empty capability set, or cookie
 * injection — the one kind that works on a machine with no browser at all —
 * would report as unavailable on exactly the machine it was designed for.
 */
export function authAdapterUnavailable(
  kind: AuthProfileKind,
  available: Iterable<AuthCapability>,
): AuthAdapterUnavailable | null {
  const have = new Set(available);
  const missing = AUTH_PROFILE_CAPABILITIES[kind].filter(
    (capability) => capability !== 'NONE' && !have.has(capability),
  );
  if (missing.length === 0) return null;
  return {
    kind,
    missing,
    remedy: missing.map((capability) => AUTH_CAPABILITY_REMEDY[capability]).join(' '),
  };
}

/**
 * Whether a kind may be used against an environment of this kind at all.
 *
 * Only one kind is refused and it is refused for a security reason rather than
 * a technical one: MOCK_IDP mints an assertion, and minting one for a
 * PRODUCTION environment is forging a real identity against a real system. It
 * is legitimate against a staging or local environment the customer has
 * deliberately configured to trust a test issuer, which is how every hosted IdP
 * runs its own dev tenants, and illegitimate everywhere else.
 *
 * A crawl of a production environment stays read-only and within its policy;
 * this is the identity half of that same rule.
 */
export function authProfileKindRefusedOn(
  kind: AuthProfileKind,
  environment: EnvironmentKind,
): string | null {
  if (kind === 'MOCK_IDP' && environment === 'PRODUCTION') {
    return (
      'A mock identity provider mints an assertion, which against a production ' +
      'environment is forging a real identity. Use a staging or local environment ' +
      'configured to trust a test issuer, or a FORM_LOGIN profile with a real account.'
    );
  }
  return null;
}

// ─── The five kinds that could be stored and not performed ───────────────────

/*
 * WHY TOTP_MFA IS NOT RENAMED TO TOTP.
 *
 * The round that added these kinds was asked for "TOTP", and `TOTP_MFA` already
 * existed in the Prisma enum, in `AUTH_PROFILE_KINDS` and in
 * `authProfileConfigSchema`. Renaming a Postgres enum member is a data
 * migration on every stored profile and a rename in every switch that reads
 * one, in exchange for four characters. MAGIC_LINK existed for the same reason
 * and is likewise left alone. So this round ADDS three members — PASSKEY,
 * PHONE_OTP, MOCK_IDP — and fixes the real defect, which was never the
 * spelling: it was that two of the five existing kinds had no adapter and the
 * endpoint answered "not built yet".
 */

/**
 * Passkey / WebAuthn.
 *
 * The credential is served by a VIRTUAL AUTHENTICATOR — `WebAuthn
 * .addVirtualAuthenticator` over CDP — so the fields below are the arguments
 * that call actually takes rather than a shape invented for this file. That is
 * deliberate: a config whose fields do not correspond to the adapter's real
 * parameters is a config that validates and then cannot be used.
 *
 * `usernameSelector` and `usernameSecretName` are OPTIONAL because a usernameless
 * (discoverable-credential) flow is the common modern case: the page offers the
 * passkey directly and no identifier is typed. Requiring them would refuse the
 * flow most passkey apps actually ship.
 *
 * `credentialSecretName` is a vault REFERENCE to a previously registered
 * credential, for an application that will only accept a passkey it has seen
 * enrolled. Absent, the adapter registers a fresh credential in the virtual
 * authenticator, which is what a sign-up-then-sign-in flow wants.
 */
export const passkeyConfigSchema = z.object({
  loginUrl: z.string(),
  usernameSelector: z.string().optional(),
  usernameSecretName: z.string().optional(),
  submitSelector: z.string(),
  /** A locator that only exists once login succeeded — the actual assertion. */
  successSelector: z.string(),
  authenticator: z.object({
    /** The relying-party id the credential is scoped to, e.g. `app.example.com`. */
    rpId: z.string().min(1),
    protocol: z.enum(['ctap2', 'u2f']).default('ctap2'),
    transport: z.enum(['usb', 'nfc', 'ble', 'internal', 'hybrid']).default('internal'),
    hasResidentKey: z.boolean().default(true),
    hasUserVerification: z.boolean().default(true),
    /** Whether the authenticator reports the user as verified without a prompt. */
    isUserVerified: z.boolean().default(true),
  }),
  credentialSecretName: z.string().optional(),
});

/**
 * A code sent to a phone.
 *
 * The sink is the whole design. QAAI never reads a real phone and there is no
 * phone in this environment at all, so the code has to arrive somewhere the
 * CUSTOMER owns and nominated:
 *
 *   TWILIO_TEST_NUMBER     a number on the customer's own messaging account.
 *   WEBHOOK                a sink the customer points their provider at; the
 *                          signing secret is how the adapter knows a delivery
 *                          is really theirs and not an injected code.
 *   APPLICATION_ENDPOINT   a non-production endpoint of the application itself
 *                          that returns the last code issued. The cheapest
 *                          option and the one most staging builds already have.
 *
 * There is no fourth arm and there must not be one: a flow where the code
 * arrives only on a real handset is UNAVAILABLE, with OTP_SINK named as the
 * missing capability. That is an honest answer; guessing a six-digit code is
 * not an answer at all.
 *
 * `phoneSecretName` is a vault reference and not a literal number because a
 * phone number is personal data, and a profile row is read by every surface
 * that lists profiles.
 */
export const phoneOtpConfigSchema = z.object({
  loginUrl: z.string(),
  phoneSelector: z.string(),
  phoneSecretName: z.string(),
  /** The control that asks for the code to be sent. */
  requestSelector: z.string(),
  codeSelector: z.string(),
  submitSelector: z.string(),
  successSelector: z.string(),
  sink: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('TWILIO_TEST_NUMBER'),
      accountSidSecretName: z.string(),
      authTokenSecretName: z.string(),
      /** The receiving number in E.164, as the provider spells it. */
      number: z.string(),
    }),
    z.object({
      kind: z.literal('WEBHOOK'),
      url: z.string(),
      signingSecretName: z.string(),
    }),
    z.object({
      kind: z.literal('APPLICATION_ENDPOINT'),
      url: z.string(),
      tokenSecretName: z.string().optional(),
    }),
  ]),
  /** How the code is recognised in whatever the sink returns. */
  codePattern: z.string().default('\\b(\\d{4,8})\\b'),
  /** How long to wait for it before reporting that nothing arrived. */
  timeoutSeconds: z.number().int().min(5).max(300).default(60),
});

/**
 * Single sign-on against a test identity provider.
 *
 * The claims are the reason this kind exists at all. An SSO-fronted application
 * decides a user's ROLE from an assertion, so minting the assertion is the only
 * way to enumerate as an admin and then as a member — and the role axis is the
 * half of enumeration that has no denominator today. A profile of this kind is
 * therefore the natural writer of `AuthProfile.role`.
 *
 * `issuer` must be an issuer the customer's own non-production environment is
 * configured to trust, and {@link authProfileKindRefusedOn} refuses the kind on
 * PRODUCTION outright. The signing key is a vault reference; nothing here
 * carries a key, and the mock IdP is not a way into an application that did not
 * invite it.
 *
 * `protocol` repeats the two members of the `SsoProtocol` Prisma enum, whose
 * TypeScript twin deliberately lives in apps/api/src/lib/sso.ts next to its
 * only reader. Importing across that boundary is not possible from @qaai/shared,
 * so the two literals are written out and `auth-profiles.test.ts` pins them —
 * a third protocol would have to be added in both places, and the test says so.
 */
export const mockIdpConfigSchema = z.object({
  issuer: z.string().min(1),
  protocol: z.enum(['SAML', 'OIDC']),
  /** Where the application begins the flow. */
  startUrl: z.string(),
  successSelector: z.string(),
  /** The subject the assertion names. */
  subject: z.string().min(1),
  /**
   * The claims to mint. This is where the role comes from — `{ "groups":
   * ["admin"] }` is what makes an admin crawl possible — so it is an open map
   * rather than a fixed shape: no two applications agree on the claim name.
   */
  claims: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
    )
    .default({}),
  signingKeySecretName: z.string(),
  audience: z.string().optional(),
  /** How long the minted assertion is valid. Short on purpose. */
  lifetimeSeconds: z.number().int().min(30).max(3600).default(300),
});

// ─── The complete write path, assembled rather than duplicated ───────────────

/**
 * Every kind's config schema, and the only map a caller should index.
 *
 * ── Why this is spread from schemas.ts rather than restated ────────────────
 *
 * `authProfileConfigSchema` in schemas.ts holds the five arms that already
 * existed, and it is what POST /environments/:id/auth-profiles has always
 * parsed through. Copying those five shapes here would create two sources of
 * truth for the same five configs, which is the defect this file is supposed to
 * be preventing one layer up. So the five are spread in and the three new ones
 * are added, and there is exactly one complete map.
 *
 * ── Why the annotation matters more than the contents ─────────────────────
 *
 * `Record<AuthProfileKind, …>` is the compiler half of the parity guard. A new
 * kind in `AUTH_PROFILE_KINDS` with no arm here breaks THIS line, so it cannot
 * ship storable-but-unvalidatable; an arm here for a kind that does not exist
 * is an excess property and breaks it too. `auth-profiles.test.ts` closes the
 * other half at run time, where zod's keys actually live.
 *
 * `z.ZodType` and not the narrower inferred types on purpose: a caller does
 * `AUTH_PROFILE_CONFIG_SCHEMAS[profile.kind].safeParse(profile.config)` with a
 * kind it learned from the database, so the value it gets back is `unknown` and
 * must be narrowed by the adapter that asked. The alternative — a mapped type
 * keyed on the kind — reads beautifully and does nothing here, because
 * `profile.kind` is a run-time string either way.
 */
export const AUTH_PROFILE_CONFIG_SCHEMAS: Record<AuthProfileKind, z.ZodType> = {
  FORM_LOGIN: legacyAuthProfileConfigSchema.FORM_LOGIN,
  COOKIE_INJECTION: legacyAuthProfileConfigSchema.COOKIE_INJECTION,
  SSO_BYPASS_TOKEN: legacyAuthProfileConfigSchema.SSO_BYPASS_TOKEN,
  MAGIC_LINK: legacyAuthProfileConfigSchema.MAGIC_LINK,
  TOTP_MFA: legacyAuthProfileConfigSchema.TOTP_MFA,
  PASSKEY: passkeyConfigSchema,
  PHONE_OTP: phoneOtpConfigSchema,
  MOCK_IDP: mockIdpConfigSchema,
};

// ─── Reaching the door at all ────────────────────────────────────────────────

/**
 * What is standing in front of the login form.
 *
 * Named providers and not a boolean, because the legitimate route in differs
 * per provider: reCAPTCHA and Turnstile both publish a test-key mode, a WAF
 * does not and wants an allowlist or a bypass header instead. A customer who
 * picks their provider from this list gets the right remedy; a boolean would
 * get them "something is blocking us".
 *
 * UNKNOWN is the honest member and the one that will be used most: a challenge
 * was observed and could not be attributed. It is NOT `NONE`, and that
 * distinction is the whole point — NONE is a claim that nothing is in the way.
 */
export const BOT_PROTECTION_PROVIDERS = [
  'NONE',
  'RECAPTCHA',
  'HCAPTCHA',
  'TURNSTILE',
  'WAF',
  'OTHER',
  'UNKNOWN',
] as const;
export type BotProtectionProvider = (typeof BOT_PROTECTION_PROVIDERS)[number];

/**
 * The three legitimate ways past a challenge, and the fourth state that is not
 * a way past it.
 *
 * NOT_CONFIGURED is the default and the one that produces
 * UNREACHABLE_BEHIND_BOT_PROTECTION. It is a state and not an absence because
 * the customer has to be TOLD why their coverage is zero; a null here would be
 * rendered as "no bot protection", which is the opposite of true.
 *
 *   PROVIDER_TEST_KEYS       the customer has configured their own test
 *                            environment with the provider's documented test
 *                            keys, so the challenge self-resolves. The keys
 *                            live on the CUSTOMER'S site, not here, and this
 *                            value records only that they said so.
 *   SIGNED_BYPASS_HEADER     the customer issues a header their own edge
 *                            accepts. The name is on the row; the value is a
 *                            vault reference.
 *   ALLOWLISTED_BY_CUSTOMER  the customer allowlisted our traffic at their
 *                            edge. Nothing is sent and nothing is bypassed.
 *
 * There is no fourth mode, and specifically there is no solver. Every mode here
 * is an action the OWNER of the environment took on their own system.
 */
export const BOT_BYPASS_MODES = [
  'NOT_CONFIGURED',
  'PROVIDER_TEST_KEYS',
  'SIGNED_BYPASS_HEADER',
  'ALLOWLISTED_BY_CUSTOMER',
] as const;
export type BotBypassMode = (typeof BOT_BYPASS_MODES)[number];

/**
 * Whether this environment can be reached at all.
 *
 * Three members, and the third is why the enum exists. NOT_PROBED means nobody
 * has tried, which must never render as REACHABLE — an environment presumed
 * reachable is an environment whose zero coverage looks like a testing failure
 * instead of an access problem.
 *
 * Deliberately narrow: this says nothing about a box that is simply down. That
 * is `ENVIRONMENT_UNAVAILABLE_PREFIX` in constants.ts, already carried on
 * `Run.errorMessage`, and folding the two would make "your WAF blocked us" and
 * "your staging server is off" the same sentence.
 */
export const ENVIRONMENT_REACHABILITIES = [
  'REACHABLE',
  'UNREACHABLE_BEHIND_BOT_PROTECTION',
  'NOT_PROBED',
] as const;
export type EnvironmentReachability = (typeof ENVIRONMENT_REACHABILITIES)[number];

/**
 * Header names whose value must be a vault reference and never a literal.
 *
 * Lower-cased, because HTTP header names are case-insensitive and a customer
 * typing `Authorization` must not slip past a check that compared against
 * `authorization`. The list is short on purpose — it is the set of names that
 * carry a credential by definition, not a guess at what might be sensitive.
 */
export const SECRET_BEARING_HEADER_NAMES = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-session-token',
] as const;

/**
 * One extra HTTP header every request to an environment carries.
 *
 * Two legitimate shapes and a rule between them. `X-Environment: staging` is
 * not a secret and storing it inline is what a customer expects; an
 * `Authorization` header is a credential and must be a vault reference, or the
 * environment list screen renders a bearer token. The refinement enforces
 * exactly that, so the rule is a parse error rather than a code review.
 */
export const environmentExtraHeaderSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, 'must be a valid HTTP header name'),
    /** A literal value, for a header that carries no credential. */
    value: z.string().max(4096).optional(),
    /** A vault reference, for one that does. */
    secretName: z.string().min(1).max(200).optional(),
  })
  .superRefine((header, ctx) => {
    const hasValue = header.value !== undefined;
    const hasSecret = header.secretName !== undefined;
    if (hasValue === hasSecret) {
      ctx.addIssue({
        code: 'custom',
        message: 'give exactly one of value or secretName',
      });
      return;
    }
    if (
      hasValue &&
      (SECRET_BEARING_HEADER_NAMES as readonly string[]).includes(header.name.toLowerCase())
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `${header.name} carries a credential — store it in the vault and name it in secretName`,
      });
    }
  });

/** The whole list, as it is stored on the environment's access row. */
export const environmentExtraHeadersSchema = z.array(environmentExtraHeaderSchema).max(20);

/**
 * The bot-protection half of the same row, as a validated shape.
 *
 * `bypassHeaderName` is required by SIGNED_BYPASS_HEADER and meaningless
 * otherwise, and `bypassSecretName` with it. The refinement states that rather
 * than leaving a row that claims a bypass mode and carries nothing to send with
 * it — which would be reported as reachable and then fail on every request.
 */
export const botProtectionSchema = z
  .object({
    provider: z.enum(BOT_PROTECTION_PROVIDERS),
    bypassMode: z.enum(BOT_BYPASS_MODES),
    bypassHeaderName: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, 'must be a valid HTTP header name')
      .optional(),
    bypassSecretName: z.string().min(1).max(200).optional(),
    /**
     * What was seen, in words — `cf-mitigated: challenge`, or the selector of
     * the challenge iframe. Evidence, so "we think a WAF blocked us" is
     * auditable. NEVER a token: a challenge response is a credential.
     */
    observedSignal: z.string().max(500).optional(),
  })
  .superRefine((policy, ctx) => {
    if (policy.bypassMode !== 'SIGNED_BYPASS_HEADER') return;
    if (!policy.bypassHeaderName) {
      ctx.addIssue({
        code: 'custom',
        path: ['bypassHeaderName'],
        message: 'a signed bypass needs the header name your edge accepts',
      });
    }
    if (!policy.bypassSecretName) {
      ctx.addIssue({
        code: 'custom',
        path: ['bypassSecretName'],
        message: 'store the bypass value in the vault and name it here; it is a credential',
      });
    }
  });

/**
 * The reachability a configuration implies, before anything is probed.
 *
 * NOT_PROBED whenever nothing stands in the way AND nothing has been observed:
 * a `NONE` provider is a claim about configuration, not a measurement, and
 * returning REACHABLE for it would be reporting as measured a thing that was
 * not measured. UNREACHABLE only when a real provider is named and no
 * legitimate route past it is configured — which is the sentence a customer
 * needs, with the remedy beside it.
 */
export function reachabilityFromPolicy(policy: {
  provider: BotProtectionProvider;
  bypassMode: BotBypassMode;
}): { reachability: EnvironmentReachability; remedy: string | null } {
  if (policy.provider === 'NONE') return { reachability: 'NOT_PROBED', remedy: null };
  if (policy.bypassMode !== 'NOT_CONFIGURED') return { reachability: 'NOT_PROBED', remedy: null };
  return {
    reachability: 'UNREACHABLE_BEHIND_BOT_PROTECTION',
    remedy: botProtectionRemedy(policy.provider),
  };
}

/**
 * What to do about each provider, in the customer's terms.
 *
 * Every sentence describes something the OWNER of the environment does on their
 * own system. None of them describes solving, replaying or evading a challenge,
 * and none of them is something QAAI can do unilaterally — which is the correct
 * shape for this answer.
 */
export function botProtectionRemedy(provider: BotProtectionProvider): string {
  const own =
    'Or allowlist QAAI at your edge, or issue a signed bypass header for this ' +
    'environment and store its value in the vault.';
  switch (provider) {
    case 'RECAPTCHA':
    case 'HCAPTCHA':
    case 'TURNSTILE':
      return (
        `Your ${provider} challenge blocks every login, so this environment has no ` +
        `enumerable authenticated surface. Configure this NON-PRODUCTION environment ` +
        `with the provider's documented test keys, so the challenge self-resolves. ${own}`
      );
    case 'WAF':
      return `A WAF is refusing our requests. ${own}`;
    case 'OTHER':
    case 'UNKNOWN':
      return (
        `Something is challenging our requests and we could not attribute it. Name the ` +
        `provider on this environment so we can tell you the exact remedy. ${own}`
      );
    case 'NONE':
      return 'Nothing is configured as blocking this environment.';
  }
}

// ─── The role axis, and the cells it makes countable ─────────────────────────

/**
 * How anonymous is spelled when a role has to be a key.
 *
 * `RouteAccess.role` in flow-map.ts is `string | null` and `accessCoverage`
 * already keys on `entry.role ?? '<anonymous>'`, so this is that same literal
 * given a name rather than a new convention. It exists because the DURABLE half
 * cannot use null: a unique index over `(environment, route, role)` with a
 * nullable role treats every NULL as distinct in PostgreSQL, so the one cell
 * that matters most — what a logged-out visitor gets on /admin — would be
 * inserted again on every crawl and counted once per crawl.
 *
 * The angle brackets are what make it safe: no role system spells an identifier
 * that way, so it cannot collide with a role the customer actually has.
 */
export const ANONYMOUS_ROLE = '<anonymous>';

/** The stored key for a role, with null meaning anonymous. */
export function roleKey(role: string | null | undefined): string {
  const trimmed = typeof role === 'string' ? role.trim() : '';
  return trimmed.length > 0 ? trimmed : ANONYMOUS_ROLE;
}

/**
 * What one role got when it asked for one route, as a row can hold it.
 *
 * ── Why this is finer than `ACCESS_OUTCOMES` and not a restatement of it ───
 *
 * flow-map.ts has four coarse outcomes — ALLOWED, DENIED, REDIRECTED, UNKNOWN —
 * which is the right grain for a node in a graph being walked. It is the wrong
 * grain for a ROW somebody queries, because the three questions a customer
 * actually asks collapse into one of those four:
 *
 *   · "which routes does a member get 403 on?"            FORBIDDEN
 *   · "which routes bounce an anonymous visitor to login?" REDIRECTED_TO_LOGIN
 *   · "which routes 404 for a member and 200 for an admin?" NOT_FOUND
 *
 * DENIED covers the first and the third, and REDIRECTED covers the second
 * together with every unrelated redirect in the application. So this enum
 * REFINES that one, {@link ACCESS_OUTCOME_TO_ROUTE_ACCESS} states the
 * correspondence under the compiler's supervision, and
 * {@link routeAccessOutcomeFrom} is the single derivation. Nothing here
 * re-decides what the crawl already decided.
 *
 * ── The two members that are not outcomes ──────────────────────────────────
 *
 *   NOT_PROBED  nobody asked. THE honesty value. It is not ALLOWED, it is not
 *               FORBIDDEN, and it must never be averaged with either; it is
 *               what makes "412 routes, 25 covered, here are the 387" a true
 *               sentence about the authorization axis too. There is NO DEFAULT
 *               on the stored column, so a writer that forgets the outcome
 *               fails loudly instead of inheriting one.
 *   ERRORED     the request produced a 5xx, a 429, or no response. That is not
 *               an answer about authorization in either direction, and
 *               recording it as FORBIDDEN would manufacture a security finding
 *               out of a flaky box.
 */
export const ROUTE_ACCESS_OUTCOMES = [
  'ALLOWED',
  'FORBIDDEN',
  'REDIRECTED_TO_LOGIN',
  'REDIRECTED_ELSEWHERE',
  'NOT_FOUND',
  'ERRORED',
  'NOT_PROBED',
] as const;
export type RouteAccessOutcome = (typeof ROUTE_ACCESS_OUTCOMES)[number];

export const ROUTE_ACCESS_OUTCOME_LABELS: Record<RouteAccessOutcome, string> = {
  ALLOWED: 'served the route',
  FORBIDDEN: 'refused with a status',
  REDIRECTED_TO_LOGIN: 'sent to the login wall',
  REDIRECTED_ELSEWHERE: 'sent somewhere else',
  NOT_FOUND: 'reported as not existing',
  ERRORED: 'errored, so nothing was learned',
  NOT_PROBED: 'not measured',
};

/**
 * The outcomes that are a measurement of authorization.
 *
 * Derived by exclusion rather than listed, so a seventh outcome has to be
 * argued about: if it belongs here, the `switch` below has to name it anyway.
 * NOT_PROBED is excluded because nobody asked, and ERRORED because the answer
 * was not about authorization — the two cases a denominator must not swallow.
 */
export const MEASURED_ROUTE_ACCESS_OUTCOMES: ReadonlyArray<RouteAccessOutcome> =
  ROUTE_ACCESS_OUTCOMES.filter(
    (outcome) => outcome !== 'NOT_PROBED' && outcome !== 'ERRORED',
  );

/**
 * Whether a stored cell counts toward the authorization denominator.
 *
 * Both halves are required. A DECLARED cell says the source claims a role is
 * needed and nothing asked, which is exactly the case where the application may
 * not actually enforce it — the defect. Counting a declaration as a measurement
 * is how "we checked" gets said about a check nobody ran.
 */
export function isRouteAccessMeasured(cell: {
  basis: RouteAccessBasis;
  outcome: RouteAccessOutcome;
}): boolean {
  return (
    cell.basis === 'OBSERVED' &&
    (MEASURED_ROUTE_ACCESS_OUTCOMES as readonly string[]).includes(cell.outcome)
  );
}

/**
 * Whether we asked, or a source told us.
 *
 * The two literals are `RouteAccess['basis']` from flow-map.ts, where they are
 * an inline union on the in-memory shape. {@link ROUTE_ACCESS_BASIS_PRESENT}
 * below is keyed on that union, so these two lists cannot drift: a third basis
 * added to the flow map breaks this file.
 */
export const ROUTE_ACCESS_BASES = ['OBSERVED', 'DECLARED'] as const;
export type RouteAccessBasis = (typeof ROUTE_ACCESS_BASES)[number];

/**
 * The compiler tie to flow-map.ts.
 *
 * `Record<RouteAccess['basis'], true>` cannot be written without naming every
 * member of the in-memory union, and naming one it does not have is an excess
 * property. So the durable enum and the in-memory field are pinned to each
 * other by the type checker rather than by a comment asking the next person to
 * remember.
 */
const ROUTE_ACCESS_BASIS_PRESENT: Record<RouteAccess['basis'], true> = {
  OBSERVED: true,
  DECLARED: true,
};

/** The bases flow-map.ts itself declares, as a run-time list. */
export const FLOW_MAP_ACCESS_BASES = Object.keys(ROUTE_ACCESS_BASIS_PRESENT) as ReadonlyArray<
  RouteAccess['basis']
>;

/** Every stored outcome that represents an observation. Derived, not listed. */
const OBSERVED_ROUTE_ACCESS_OUTCOMES: ReadonlyArray<RouteAccessOutcome> =
  ROUTE_ACCESS_OUTCOMES.filter((outcome) => outcome !== 'NOT_PROBED');

/**
 * Which stored outcomes each coarse crawl outcome may become.
 *
 * ── Why three of the four lists are the same, which looks wrong ────────────
 *
 * An earlier draft of this table was narrower and more satisfying: ALLOWED
 * could only become ALLOWED, REDIRECTED_TO_LOGIN or ERRORED, DENIED only
 * FORBIDDEN or NOT_FOUND, and so on. The exhaustive test below broke it within
 * a minute, with `ALLOWED` carrying a 301, and the test was right: the COARSE
 * LABEL IS NOT AUTHORITATIVE OVER THE STATUS. The crawler sets ALLOWED when the
 * navigation worked, which it did — a 301 the driver followed, a 403 page that
 * rendered — and the status and final URL are strictly better evidence about
 * authorization than "the browser did not throw". A table that forbade the
 * combination would have forced the derivation to trust the weaker signal.
 *
 * So the table asserts the thing that actually matters, in both directions, and
 * nothing else:
 *
 *   · UNKNOWN may become ONLY NOT_PROBED. A crawl that learned nothing must not
 *     be refinable into an answer — that is fabricating a measurement.
 *   · NOTHING ELSE may become NOT_PROBED. An observation must not be refined
 *     into "nobody asked" — that is discarding one, and it reads on screen as
 *     an honest gap while the real result is gone.
 *
 * Compiler-enforced over flow-map's own union, so a fifth `AccessOutcome` has
 * to be mapped here before it can be stored. `auth-profiles.test.ts` holds
 * {@link routeAccessOutcomeFrom} to these lists across every status a crawl can
 * see, which is what stops the table and the derivation from drifting.
 */
export const ACCESS_OUTCOME_TO_ROUTE_ACCESS: Record<
  AccessOutcome,
  ReadonlyArray<RouteAccessOutcome>
> = {
  ALLOWED: OBSERVED_ROUTE_ACCESS_OUTCOMES,
  DENIED: OBSERVED_ROUTE_ACCESS_OUTCOMES,
  REDIRECTED: OBSERVED_ROUTE_ACCESS_OUTCOMES,
  UNKNOWN: ['NOT_PROBED'],
};

/** What a crawl saw when one role asked for one route. */
export interface RouteAccessObservation {
  /** The coarse outcome, or null when nothing asked at all. */
  observed: AccessOutcome | null;
  /** The HTTP status, or null when no response came back. Never 0. */
  status: number | null;
  /** Where the browser ended up — absolute or a path. */
  finalUrl: string | null;
  /**
   * The route templates or globs that are this application's login wall, from
   * the environment's configuration. `matchesGlob` from flow-map.ts is the only
   * dialect, so `/auth/**` means here what it means in a crawl policy, and a
   * literal `/login` still matches itself.
   */
  loginRoutes: readonly string[];
}

/**
 * The one derivation from an observation to a stored outcome.
 *
 * ── Why status-first and not outcome-first ─────────────────────────────────
 *
 * Because a SOFT redirect is the common case and the coarse outcome cannot see
 * it. A single-page application answers 200 and renders the login form at
 * /login; the navigation "succeeded", so the crawl records ALLOWED, and storing
 * that would claim an anonymous visitor is served /admin. The final URL is the
 * only evidence that it was not, which is why it is checked before ALLOWED is
 * returned.
 *
 * ── Why a 429 is not FORBIDDEN ──────────────────────────────────────────────
 *
 * Because it is not an answer about authorization. Only 401 and 403 are a
 * refusal on identity grounds; 404 and 410 are the application saying the route
 * does not exist for this caller, which is a DIFFERENT and interesting fact —
 * a route that 404s for a member and 200s for an admin is the correct way to
 * hide a resource, and a route that 403s tells the member it is there. Every
 * other 4xx and every 5xx is ERRORED, with the status kept so a reader can see
 * what actually happened.
 */
export function routeAccessOutcomeFrom(observation: RouteAccessObservation): RouteAccessOutcome {
  const { observed, status, finalUrl, loginRoutes } = observation;

  // Nobody asked, or asked and learned nothing. Not a measurement either way.
  if (observed === null || observed === 'UNKNOWN') return 'NOT_PROBED';

  // A request was made and no response came back. ERRORED and not NOT_PROBED:
  // we DID ask, and that distinction is the difference between our silence and
  // the application's.
  if (status === null) return 'ERRORED';

  if (status === 401 || status === 403) return 'FORBIDDEN';
  if (status === 404 || status === 410) return 'NOT_FOUND';

  const atLogin = isLoginRoute(finalUrl, loginRoutes);
  if (status >= 300 && status < 400) {
    return atLogin ? 'REDIRECTED_TO_LOGIN' : 'REDIRECTED_ELSEWHERE';
  }
  if (status >= 400) return 'ERRORED';

  if (status >= 200 && status < 300) {
    // The soft redirect. A 200 that landed on the login wall is the wall doing
    // its job, not the route being served.
    if (atLogin) return 'REDIRECTED_TO_LOGIN';
    if (observed === 'REDIRECTED') return 'REDIRECTED_ELSEWHERE';
    return 'ALLOWED';
  }

  // 1xx, or a nonsense status. Not an answer; do not invent one.
  return 'ERRORED';
}

/**
 * Whether a final URL landed on the application's login wall.
 *
 * Tolerates a path as well as an absolute URL, because a crawl records whichever
 * the driver gave it, and a relative value thrown at `new URL` would otherwise
 * become an exception on the happy path.
 */
function isLoginRoute(finalUrl: string | null, loginRoutes: readonly string[]): boolean {
  if (finalUrl === null || loginRoutes.length === 0) return false;
  let path = finalUrl;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(finalUrl)) {
    try {
      path = new URL(finalUrl).pathname;
    } catch {
      return false;
    }
  } else {
    const cut = finalUrl.search(/[?#]/);
    if (cut >= 0) path = finalUrl.slice(0, cut);
  }
  if (!path.startsWith('/')) path = `/${path}`;
  return loginRoutes.some((route) => matchesGlob(route, path));
}

// ─── A role whose crawl failed is not a role with no extra surface ───────────

/**
 * What became of the attempt to enumerate as one role.
 *
 * ── The lie this enum exists to prevent ────────────────────────────────────
 *
 * "The admin crawl found no routes a member cannot see." That sentence is a
 * finding if the admin crawl RAN, and a fabrication if the admin login failed —
 * and with no record of the attempt the two are indistinguishable, because both
 * produce zero rows. Zero rows is the single most dangerous output this product
 * can have, so the attempt gets a row of its own and
 * {@link roleHadNoExtraSurface} refuses to answer unless the attempt succeeded.
 *
 *   NEVER_ATTEMPTED                    a role is declared and nothing has run
 *                                      for it. An admission, stored rather than
 *                                      inferred from an absence of rows.
 *   LOGIN_UNAVAILABLE                  the profile's kind has no adapter here.
 *                                      OURS to fix, and the remedy says which
 *                                      capability is missing.
 *   LOGIN_FAILED                       we drove the login and did not get in.
 *                                      THEIRS to fix — wrong credentials, or a
 *                                      success locator that no longer exists.
 *                                      Opposite facts, and only one of them is
 *                                      the customer's problem.
 *   UNREACHABLE_BEHIND_BOT_PROTECTION  we never reached the form.
 *   SKIPPED_BY_POLICY                  the environment's crawl policy excluded
 *                                      it. A decision somebody made, and it
 *                                      must not read as an absence of surface.
 *   CRAWLED_PARTIAL                    we got in and a budget bit. The counts
 *                                      are real and INCOMPLETE, which is why
 *                                      `cappedBy` and `atLeastMoreRoutes` are
 *                                      stored beside them.
 *   CRAWLED                            we got in and finished.
 */
export const ROLE_CRAWL_OUTCOMES = [
  'NEVER_ATTEMPTED',
  'LOGIN_UNAVAILABLE',
  'LOGIN_FAILED',
  'UNREACHABLE_BEHIND_BOT_PROTECTION',
  'SKIPPED_BY_POLICY',
  'CRAWLED_PARTIAL',
  'CRAWLED',
] as const;
export type RoleCrawlOutcome = (typeof ROLE_CRAWL_OUTCOMES)[number];

/** The two outcomes where a session was actually obtained and a crawl ran. */
export const CRAWLED_ROLE_OUTCOMES: ReadonlyArray<RoleCrawlOutcome> = [
  'CRAWLED',
  'CRAWLED_PARTIAL',
];

/** Whose problem each outcome is. The first question a customer asks. */
export const ROLE_CRAWL_FAULT: Record<RoleCrawlOutcome, 'OURS' | 'THEIRS' | 'NOBODY'> = {
  NEVER_ATTEMPTED: 'OURS',
  LOGIN_UNAVAILABLE: 'OURS',
  LOGIN_FAILED: 'THEIRS',
  UNREACHABLE_BEHIND_BOT_PROTECTION: 'THEIRS',
  SKIPPED_BY_POLICY: 'NOBODY',
  CRAWLED_PARTIAL: 'NOBODY',
  CRAWLED: 'NOBODY',
};

/**
 * Whether this role turned out to have no surface the others do not — or null
 * when the question cannot be answered.
 *
 * NULL IS THE POINT. Returning `false` for a failed login would be a claim;
 * returning `true` would be the lie in the docstring above. A caller that wants
 * a sentence gets null and has to render the outcome instead, which is exactly
 * the behaviour wanted: "we could not sign in as admin" is a useful report and
 * "admin sees nothing extra" is a dangerous one.
 *
 * A PARTIAL crawl can still answer YES-it-found-extra — finding a route is
 * positive evidence and a budget cannot take it away — but it can never answer
 * NO, because the routes it did not reach are the ones in question. That
 * asymmetry is the whole reason `routesNewToThisRole` is nullable and is not
 * defaulted to 0.
 */
export function roleHadNoExtraSurface(attempt: {
  outcome: RoleCrawlOutcome;
  routesNewToThisRole: number | null;
}): boolean | null {
  if (!(CRAWLED_ROLE_OUTCOMES as readonly string[]).includes(attempt.outcome)) return null;
  if (attempt.routesNewToThisRole === null) return null;
  if (attempt.routesNewToThisRole > 0) return false;
  // Zero new routes, and the crawl stopped early: the answer is unknown, not no.
  if (attempt.outcome === 'CRAWLED_PARTIAL') return null;
  return true;
}

