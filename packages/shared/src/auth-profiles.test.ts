import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTH_PROFILE_KINDS, type AuthProfileKind, ENVIRONMENT_KINDS } from './constants';
import { ACCESS_OUTCOMES, type AccessOutcome } from './flow-map';
import {
  ACCESS_OUTCOME_TO_ROUTE_ACCESS,
  ANONYMOUS_ROLE,
  AUTH_CAPABILITIES,
  AUTH_CAPABILITY_REMEDY,
  AUTH_PROFILE_CAPABILITIES,
  AUTH_PROFILE_CONFIG_SCHEMAS,
  AUTH_PROFILE_KIND_LABELS,
  BOT_BYPASS_MODES,
  BOT_PROTECTION_PROVIDERS,
  CRAWLED_ROLE_OUTCOMES,
  ENVIRONMENT_REACHABILITIES,
  FLOW_MAP_ACCESS_BASES,
  MEASURED_ROUTE_ACCESS_OUTCOMES,
  ROLE_CRAWL_FAULT,
  ROLE_CRAWL_OUTCOMES,
  ROUTE_ACCESS_BASES,
  ROUTE_ACCESS_OUTCOMES,
  ROUTE_ACCESS_OUTCOME_LABELS,
  authAdapterUnavailable,
  authProfileKindRefusedOn,
  botProtectionRemedy,
  botProtectionSchema,
  environmentExtraHeaderSchema,
  isRouteAccessMeasured,
  mockIdpConfigSchema,
  passkeyConfigSchema,
  phoneOtpConfigSchema,
  reachabilityFromPolicy,
  roleHadNoExtraSurface,
  roleKey,
  routeAccessOutcomeFrom,
} from './auth-profiles';

/**
 * The guard that makes "storable but unperformable" impossible, and the
 * derivations that must have exactly one implementation.
 *
 * ── Why the parity assertions are not a case per kind ───────────────────────
 *
 * Because that is the test that would have passed. `AUTH_PROFILE_KINDS` has
 * named MAGIC_LINK and TOTP_MFA since the beginning and `signInWithProfile`
 * honoured three kinds; a file with one case per kind someone remembered to
 * write would have had three green cases and said nothing about the two that
 * were broken. A test that enumerates what somebody remembered cannot catch the
 * thing that was forgotten.
 *
 * So the shape is a PARITY ASSERTION in both directions, exactly as
 * `schemas.test.ts` does for the gate rules:
 *
 *   · the COMPILER refuses `AUTH_PROFILE_CONFIG_SCHEMAS`,
 *     `AUTH_PROFILE_CAPABILITIES` and `AUTH_PROFILE_KIND_LABELS` if they are
 *     missing a kind or name one that does not exist, because each is a
 *     `Record` keyed on the union;
 *   · the tests below compare those keys against the vocabulary at RUN TIME,
 *     where zod's own keys live, and additionally parse one real config per arm
 *     — because parity proves an arm EXISTS and cannot prove it accepts the
 *     shape its adapter reads.
 *
 * Every assertion is written to go red under a specific, plausible weakening,
 * and the weakening is named beside it.
 */

describe('the auth profile vocabulary is complete in every direction', () => {
  it('has a config schema for every kind, and no schema for a kind that does not exist', () => {
    // Goes red if a kind is added to AUTH_PROFILE_KINDS and the write path is
    // not widened — the exact defect that let a profile be stored and never
    // performed. The compiler catches it first; this catches it if the record
    // is ever loosened to a plain object.
    expect(Object.keys(AUTH_PROFILE_CONFIG_SCHEMAS).sort()).toEqual([...AUTH_PROFILE_KINDS].sort());
  });

  it('declares the capabilities every kind needs', () => {
    expect(Object.keys(AUTH_PROFILE_CAPABILITIES).sort()).toEqual([...AUTH_PROFILE_KINDS].sort());
  });

  it('labels every kind, so a picker cannot offer a nameless one', () => {
    expect(Object.keys(AUTH_PROFILE_KIND_LABELS).sort()).toEqual([...AUTH_PROFILE_KINDS].sort());
    for (const kind of AUTH_PROFILE_KINDS) {
      expect(AUTH_PROFILE_KIND_LABELS[kind].length).toBeGreaterThan(0);
    }
  });

  it('names the eight kinds, spelled out, so a shrunk list cannot pass by agreeing with less', () => {
    // The three parity tests above compare two lists. If BOTH shrank — a kind
    // deleted from the vocabulary and from all three records — they would still
    // agree. This is the pin. PASSKEY, PHONE_OTP and MOCK_IDP are the three
    // classes of customer that had no describable login at all.
    expect([...AUTH_PROFILE_KINDS].sort()).toEqual([
      'COOKIE_INJECTION',
      'FORM_LOGIN',
      'MAGIC_LINK',
      'MOCK_IDP',
      'PASSKEY',
      'PHONE_OTP',
      'SSO_BYPASS_TOKEN',
      'TOTP_MFA',
    ]);
  });

  it('declares only capabilities that exist, and a remedy for each of them', () => {
    // A capability with no remedy is an UNAVAILABLE report with nothing to act
    // on, which is most of the value of reporting it.
    for (const kind of AUTH_PROFILE_KINDS) {
      for (const capability of AUTH_PROFILE_CAPABILITIES[kind]) {
        expect(AUTH_CAPABILITIES).toContain(capability);
        expect(AUTH_CAPABILITY_REMEDY[capability].length).toBeGreaterThan(0);
      }
    }
  });

  it('has no duplicate member in any vocabulary', () => {
    for (const vocabulary of [
      AUTH_PROFILE_KINDS,
      AUTH_CAPABILITIES,
      ROUTE_ACCESS_OUTCOMES,
      ROUTE_ACCESS_BASES,
      ROLE_CRAWL_OUTCOMES,
      BOT_PROTECTION_PROVIDERS,
      BOT_BYPASS_MODES,
      ENVIRONMENT_REACHABILITIES,
    ]) {
      expect(new Set(vocabulary).size).toBe(vocabulary.length);
    }
  });
});

/**
 * One accepted config per NEW kind, and they are not decoration.
 *
 * The parity test proves an ARM exists; it cannot prove the arm accepts what
 * the adapter reads. A `PASSKEY` arm that was `z.object({})` would satisfy
 * parity and then hand the adapter a config with no relying-party id — which
 * fails inside a browser, where the error nobody can read comes from.
 */
describe('the three new arms accept what their adapter needs', () => {
  it('passkey: a usernameless flow with a virtual authenticator', () => {
    const parsed = passkeyConfigSchema.safeParse({
      loginUrl: '/signin',
      submitSelector: '[data-test=passkey]',
      successSelector: '[data-test=dashboard]',
      authenticator: { rpId: 'app.example.com' },
    });
    expect(parsed.success).toBe(true);
    // The defaults are the CDP call's own defaults, so an adapter can pass the
    // parsed object through. Goes red if a default is dropped and the adapter
    // starts receiving undefined for a required CDP parameter.
    expect(parsed.success && parsed.data.authenticator.protocol).toBe('ctap2');
    expect(parsed.success && parsed.data.authenticator.transport).toBe('internal');
    expect(parsed.success && parsed.data.authenticator.hasResidentKey).toBe(true);
  });

  it('passkey: refuses an authenticator with no relying-party id', () => {
    // rpId is what scopes the credential. Without it the virtual authenticator
    // offers a credential for the wrong origin and the login silently fails.
    expect(
      passkeyConfigSchema.safeParse({
        loginUrl: '/signin',
        submitSelector: '#go',
        successSelector: '#home',
        authenticator: {},
      }).success,
    ).toBe(false);
  });

  it('phone OTP: each of the three sinks, and nothing else', () => {
    const base = {
      loginUrl: '/signin',
      phoneSelector: '#phone',
      phoneSecretName: 'TEST_PHONE',
      requestSelector: '#send',
      codeSelector: '#code',
      submitSelector: '#verify',
      successSelector: '#home',
    };
    for (const sink of [
      {
        kind: 'TWILIO_TEST_NUMBER',
        accountSidSecretName: 'TWILIO_SID',
        authTokenSecretName: 'TWILIO_TOKEN',
        number: '+15005550006',
      },
      { kind: 'WEBHOOK', url: 'https://sink.example.com/sms', signingSecretName: 'SINK_SIG' },
      { kind: 'APPLICATION_ENDPOINT', url: 'https://staging.example.com/__last-otp' },
    ]) {
      expect(phoneOtpConfigSchema.safeParse({ ...base, sink }).success).toBe(true);
    }
    // There is deliberately no arm for "it arrives on a real handset". That
    // case is UNAVAILABLE with OTP_SINK named, not a fourth sink, and this
    // assertion goes red the day somebody adds one.
    expect(
      phoneOtpConfigSchema.safeParse({ ...base, sink: { kind: 'REAL_PHONE', number: '+1555' } })
        .success,
    ).toBe(false);
  });

  it('phone OTP: stores the number as a vault reference, not a number', () => {
    // A phone number is personal data and a profile row is read by every
    // surface that lists profiles. Goes red if `phoneSecretName` is ever
    // relaxed into an optional literal `phone`.
    const parsed = phoneOtpConfigSchema.safeParse({
      loginUrl: '/signin',
      phoneSelector: '#phone',
      requestSelector: '#send',
      codeSelector: '#code',
      submitSelector: '#verify',
      successSelector: '#home',
      sink: { kind: 'APPLICATION_ENDPOINT', url: 'https://staging.example.com/__last-otp' },
    });
    expect(parsed.success).toBe(false);
  });

  it('mock IdP: mints the claims that choose a role', () => {
    const parsed = mockIdpConfigSchema.safeParse({
      issuer: 'https://idp.staging.example.com',
      protocol: 'OIDC',
      startUrl: '/sso/start',
      successSelector: '#home',
      subject: 'admin@example.com',
      claims: { groups: ['admin'], email_verified: true },
      signingKeySecretName: 'IDP_SIGNING_KEY',
    });
    expect(parsed.success).toBe(true);
    // The role axis depends on the claims surviving the parse. Goes red if
    // `claims` is ever narrowed to a fixed shape no real application matches.
    expect(parsed.success && parsed.data.claims['groups']).toEqual(['admin']);
  });

  it('mock IdP: the two protocols, pinned against SsoProtocol', () => {
    // `SsoProtocol` in schema.prisma has exactly these two and its TypeScript
    // twin lives in apps/api/src/lib/sso.ts, which @qaai/shared cannot import.
    // So the literals are written out here and this is the assertion that says
    // a third protocol has to be added in both places.
    expect(mockIdpConfigSchema.safeParse(mockIdp('SAML')).success).toBe(true);
    expect(mockIdpConfigSchema.safeParse(mockIdp('OIDC')).success).toBe(true);
    expect(mockIdpConfigSchema.safeParse(mockIdp('WS_FED')).success).toBe(false);
  });

  const mockIdp = (protocol: string): unknown => ({
    issuer: 'https://idp.staging.example.com',
    protocol,
    startUrl: '/sso/start',
    successSelector: '#home',
    subject: 'admin@example.com',
    signingKeySecretName: 'IDP_SIGNING_KEY',
  });
});

describe('a kind whose adapter is absent reports UNAVAILABLE, never a silent pass', () => {
  const everything = AUTH_CAPABILITIES;

  it('is satisfied for every kind when every capability is present', () => {
    for (const kind of AUTH_PROFILE_KINDS) {
      expect(authAdapterUnavailable(kind, everything)).toBeNull();
    }
  });

  it('names every missing capability, not just the first', () => {
    // A report naming only the browser would send somebody to install
    // Playwright when the actual blocker is the virtual authenticator.
    const blocked = authAdapterUnavailable('PASSKEY', []);
    expect(blocked?.missing.slice().sort()).toEqual(['BROWSER', 'CDP_WEBAUTHN']);
    expect(blocked?.remedy).toContain('Chromium');
  });

  it('blocks a passkey on a browser with no DevTools Protocol', () => {
    // The real case: Firefox or WebKit. A browser is present and the
    // authenticator is not, and the honest answer is UNAVAILABLE rather than a
    // login attempt that fails on a selector.
    const blocked = authAdapterUnavailable('PASSKEY', ['BROWSER']);
    expect(blocked?.missing).toEqual(['CDP_WEBAUTHN']);
  });

  it('never blocks a kind that needs nothing, even with no capabilities at all', () => {
    // Cookie injection is the one kind designed for a machine with no browser.
    // Goes red if `NONE` is ever treated as a capability to be satisfied, which
    // would report the kind as unavailable on exactly the machine it is for.
    expect(authAdapterUnavailable('COOKIE_INJECTION', [])).toBeNull();
    expect(authAdapterUnavailable('SSO_BYPASS_TOKEN', [])).toBeNull();
  });

  it('blocks a form login with no browser, and says so', () => {
    const blocked = authAdapterUnavailable('FORM_LOGIN', ['TOTP_CLOCK']);
    expect(blocked?.kind).toBe('FORM_LOGIN');
    expect(blocked?.missing).toEqual(['BROWSER']);
    expect(blocked?.remedy.length).toBeGreaterThan(0);
  });
});

describe('a mock identity provider is refused on production', () => {
  it('refuses MOCK_IDP on PRODUCTION and nowhere else', () => {
    expect(authProfileKindRefusedOn('MOCK_IDP', 'PRODUCTION')).toContain('forging');
    for (const environment of ['LOCAL', 'PREVIEW', 'STAGING'] as const) {
      expect(authProfileKindRefusedOn('MOCK_IDP', environment)).toBeNull();
    }
  });

  it('refuses nothing else anywhere', () => {
    // Narrow on purpose. A rule that refused more kinds on production would be
    // read as a safety feature and would quietly make production environments
    // unenumerable, which is the opposite of this product.
    for (const kind of AUTH_PROFILE_KINDS) {
      if (kind === 'MOCK_IDP') continue;
      for (const environment of ENVIRONMENT_KINDS) {
        expect(authProfileKindRefusedOn(kind, environment)).toBeNull();
      }
    }
  });
});

describe('the role axis', () => {
  it('spells anonymous exactly as flow-map.ts keys it', () => {
    // `accessCoverage` in flow-map.ts keys on `entry.role ?? '<anonymous>'`.
    // If this constant drifts from that literal, the durable cells and the
    // in-memory coverage count two different anonymous roles and neither is
    // wrong on its own screen.
    expect(ANONYMOUS_ROLE).toBe('<anonymous>');
  });

  it('turns every shade of "no role" into the one key', () => {
    for (const absent of [null, undefined, '', '   ']) {
      expect(roleKey(absent)).toBe(ANONYMOUS_ROLE);
    }
  });

  it('trims a real role rather than storing two spellings of it', () => {
    // `' admin'` and `'admin'` under the unique index would be two cells for
    // one role, and the role filter would find one of them.
    expect(roleKey(' admin ')).toBe('admin');
    expect(roleKey('member')).toBe('member');
  });
});

describe('ROUTE_ACCESS_OUTCOMES', () => {
  it('labels every outcome', () => {
    expect(Object.keys(ROUTE_ACCESS_OUTCOME_LABELS).sort()).toEqual(
      [...ROUTE_ACCESS_OUTCOMES].sort(),
    );
  });

  it('excludes exactly NOT_PROBED and ERRORED from the measured set', () => {
    // The authorization denominator. NOT_PROBED is our silence and ERRORED is
    // an answer about something other than authorization; counting either as a
    // measurement is how a 429 becomes a security finding or a gap becomes a
    // pass.
    expect([...MEASURED_ROUTE_ACCESS_OUTCOMES].sort()).toEqual([
      'ALLOWED',
      'FORBIDDEN',
      'NOT_FOUND',
      'REDIRECTED_ELSEWHERE',
      'REDIRECTED_TO_LOGIN',
    ]);
  });

  it('counts a cell only when somebody actually asked', () => {
    expect(isRouteAccessMeasured({ basis: 'OBSERVED', outcome: 'FORBIDDEN' })).toBe(true);
    // A DECLARED restriction the application does not enforce is the defect.
    expect(isRouteAccessMeasured({ basis: 'DECLARED', outcome: 'FORBIDDEN' })).toBe(false);
    expect(isRouteAccessMeasured({ basis: 'OBSERVED', outcome: 'NOT_PROBED' })).toBe(false);
    expect(isRouteAccessMeasured({ basis: 'OBSERVED', outcome: 'ERRORED' })).toBe(false);
  });

  it('agrees with flow-map.ts about the two bases', () => {
    // `FLOW_MAP_ACCESS_BASES` is derived from a `Record<RouteAccess['basis'],
    // true>`, so the compiler refuses a list that drifts from the in-memory
    // union. This is the run-time half of that pin.
    expect([...FLOW_MAP_ACCESS_BASES].sort()).toEqual([...ROUTE_ACCESS_BASES].sort());
  });

  it('maps every coarse crawl outcome, and only those', () => {
    expect(Object.keys(ACCESS_OUTCOME_TO_ROUTE_ACCESS).sort()).toEqual([...ACCESS_OUTCOMES].sort());
    for (const coarse of ACCESS_OUTCOMES) {
      for (const refined of ACCESS_OUTCOME_TO_ROUTE_ACCESS[coarse]) {
        expect(ROUTE_ACCESS_OUTCOMES).toContain(refined);
      }
    }
  });

  it('lets UNKNOWN become nothing but NOT_PROBED', () => {
    // The honesty edge of the mapping table: a crawl that learned nothing must
    // not be refinable into an answer.
    expect(ACCESS_OUTCOME_TO_ROUTE_ACCESS.UNKNOWN).toEqual(['NOT_PROBED']);
  });

  it('lets nothing else become NOT_PROBED', () => {
    // The other direction, and the one that is easier to get wrong: an
    // observation refined into "nobody asked" reads on screen as an honest gap
    // while the real result has been thrown away.
    for (const coarse of ACCESS_OUTCOMES) {
      if (coarse === 'UNKNOWN') continue;
      expect(ACCESS_OUTCOME_TO_ROUTE_ACCESS[coarse]).not.toContain('NOT_PROBED');
    }
  });
});

describe('routeAccessOutcomeFrom', () => {
  const observe = (
    observed: AccessOutcome | null,
    status: number | null,
    finalUrl: string | null = null,
  ) => routeAccessOutcomeFrom({ observed, status, finalUrl, loginRoutes: ['/login', '/auth/**'] });

  it('reports NOT_PROBED when nothing asked', () => {
    expect(observe(null, null)).toBe('NOT_PROBED');
    expect(observe('UNKNOWN', null)).toBe('NOT_PROBED');
    // Even with a status lying around: UNKNOWN means the crawl learned nothing,
    // and inventing an answer from a stray status is the lie.
    expect(observe('UNKNOWN', 200)).toBe('NOT_PROBED');
  });

  it('separates our silence from the application erroring', () => {
    // We DID ask and no response came back. NOT_PROBED would blame us for the
    // application's failure; ALLOWED would be a fabrication.
    expect(observe('ALLOWED', null)).toBe('ERRORED');
  });

  it('reads 401 and 403 as FORBIDDEN', () => {
    expect(observe('DENIED', 401)).toBe('FORBIDDEN');
    expect(observe('DENIED', 403)).toBe('FORBIDDEN');
  });

  it('keeps NOT_FOUND distinct from FORBIDDEN', () => {
    // Both are DENIED to the crawl and they are different facts: a 404 hides
    // the resource, a 403 confirms it exists. Collapsing them loses the one
    // comparison that makes an information-leak finding possible.
    expect(observe('DENIED', 404)).toBe('NOT_FOUND');
    expect(observe('DENIED', 410)).toBe('NOT_FOUND');
  });

  it('reads a hard redirect to the login wall as REDIRECTED_TO_LOGIN', () => {
    expect(observe('REDIRECTED', 302, 'https://app.example.com/login?next=/admin')).toBe(
      'REDIRECTED_TO_LOGIN',
    );
    // A glob, in the one dialect this repo has.
    expect(observe('REDIRECTED', 302, '/auth/sign-in')).toBe('REDIRECTED_TO_LOGIN');
  });

  it('refuses to call an unrelated redirect a login bounce', () => {
    expect(observe('REDIRECTED', 302, 'https://app.example.com/onboarding')).toBe(
      'REDIRECTED_ELSEWHERE',
    );
    // No final URL at all: we cannot claim a destination we did not observe.
    expect(observe('REDIRECTED', 302, null)).toBe('REDIRECTED_ELSEWHERE');
  });

  it('catches the SOFT redirect, which is the common case and the whole reason finalUrl exists', () => {
    // A single-page application answers 200 and renders the login form. The
    // navigation "succeeded", so the crawl records ALLOWED — and storing that
    // claims an anonymous visitor is served /admin. Goes red the moment the
    // final-URL check is moved after the 2xx arm.
    expect(observe('ALLOWED', 200, 'https://app.example.com/login')).toBe('REDIRECTED_TO_LOGIN');
  });

  it('reads a plain 200 on the route itself as ALLOWED', () => {
    expect(observe('ALLOWED', 200, 'https://app.example.com/admin')).toBe('ALLOWED');
    expect(observe('ALLOWED', 204, null)).toBe('ALLOWED');
  });

  it('refuses to turn a 429 or a 500 into a security finding', () => {
    // Neither is an answer about authorization. FORBIDDEN here would
    // manufacture a finding out of a rate limiter or a flaky box.
    expect(observe('DENIED', 429)).toBe('ERRORED');
    expect(observe('ALLOWED', 500)).toBe('ERRORED');
    expect(observe('DENIED', 400)).toBe('ERRORED');
  });

  it('never leaves the refinement the mapping table permits', () => {
    /*
     * The pin between the table and the derivation, and it has already earned
     * its keep: the first version of `ACCESS_OUTCOME_TO_ROUTE_ACCESS` was
     * narrower than the truth and this loop broke it on `ALLOWED` carrying a
     * 301 — a redirect the driver followed, which the crawler records as a
     * successful navigation. The table was the thing that was wrong.
     *
     * What it proves now is the pair of invariants that matter: UNKNOWN refines
     * only to NOT_PROBED, and nothing else ever refines to NOT_PROBED. Those
     * are fabricating a measurement and discarding one.
     */
    const statuses = [null, 100, 200, 204, 301, 302, 304, 400, 401, 403, 404, 410, 429, 500, 503];
    const urls = [null, 'https://app.example.com/login', 'https://app.example.com/admin'];
    for (const coarse of ACCESS_OUTCOMES) {
      for (const status of statuses) {
        for (const finalUrl of urls) {
          const outcome = routeAccessOutcomeFrom({
            observed: coarse,
            status,
            finalUrl,
            loginRoutes: ['/login'],
          });
          expect(
            ACCESS_OUTCOME_TO_ROUTE_ACCESS[coarse],
            `${coarse} + ${String(status)} + ${String(finalUrl)} became ${outcome}`,
          ).toContain(outcome);
        }
      }
    }
  });

  it('matches no login route when none is configured', () => {
    // An environment that never said where its login wall is cannot have a
    // redirect attributed to it.
    expect(
      routeAccessOutcomeFrom({
        observed: 'REDIRECTED',
        status: 302,
        finalUrl: 'https://app.example.com/login',
        loginRoutes: [],
      }),
    ).toBe('REDIRECTED_ELSEWHERE');
  });

  it('survives a final URL that is not a URL', () => {
    // A driver can hand back anything. `new URL` on a relative value would
    // throw on the happy path.
    expect(observe('ALLOWED', 200, 'login')).toBe('REDIRECTED_TO_LOGIN');
    expect(observe('ALLOWED', 200, 'about:blank')).toBe('ALLOWED');
  });
});

describe('a role whose crawl failed is not a role with no extra surface', () => {
  it('assigns a fault to every outcome', () => {
    expect(Object.keys(ROLE_CRAWL_FAULT).sort()).toEqual([...ROLE_CRAWL_OUTCOMES].sort());
  });

  it('refuses to answer at all unless a crawl actually ran', () => {
    // THE assertion this whole table exists for. Every one of these produces
    // zero cells, exactly like a successful crawl that found nothing, and
    // `false` or `true` here would be a fabrication either way.
    for (const outcome of ROLE_CRAWL_OUTCOMES) {
      if ((CRAWLED_ROLE_OUTCOMES as readonly string[]).includes(outcome)) continue;
      expect(
        roleHadNoExtraSurface({ outcome, routesNewToThisRole: 0 }),
        `${outcome} must not answer`,
      ).toBeNull();
    }
  });

  it('answers NO EXTRA SURFACE only for a crawl that finished', () => {
    expect(roleHadNoExtraSurface({ outcome: 'CRAWLED', routesNewToThisRole: 0 })).toBe(true);
  });

  it('refuses to say "no extra surface" when a budget bit', () => {
    // The routes a partial crawl did not reach are precisely the ones in
    // question. Goes red if CRAWLED_PARTIAL is ever folded in with CRAWLED.
    expect(roleHadNoExtraSurface({ outcome: 'CRAWLED_PARTIAL', routesNewToThisRole: 0 })).toBeNull();
  });

  it('still says "found extra surface" on a partial crawl', () => {
    // Finding a route is positive evidence and a budget cannot take it away.
    expect(roleHadNoExtraSurface({ outcome: 'CRAWLED_PARTIAL', routesNewToThisRole: 3 })).toBe(
      false,
    );
    expect(roleHadNoExtraSurface({ outcome: 'CRAWLED', routesNewToThisRole: 1 })).toBe(false);
  });

  it('refuses to read a null count as zero', () => {
    // A crawl that ran and recorded no count has not told us it found nothing.
    expect(roleHadNoExtraSurface({ outcome: 'CRAWLED', routesNewToThisRole: null })).toBeNull();
  });

  it('calls a missing adapter ours and a bad credential theirs', () => {
    // The customer's first question. Reversing these sends them to check
    // credentials that are fine, or has us chase a bug that is not ours.
    expect(ROLE_CRAWL_FAULT.LOGIN_UNAVAILABLE).toBe('OURS');
    expect(ROLE_CRAWL_FAULT.LOGIN_FAILED).toBe('THEIRS');
    expect(ROLE_CRAWL_FAULT.NEVER_ATTEMPTED).toBe('OURS');
  });
});

describe('bot protection: why coverage is zero, and nothing that defeats a challenge', () => {
  it('reports UNREACHABLE with a remedy when nothing legitimate is configured', () => {
    const { reachability, remedy } = reachabilityFromPolicy({
      provider: 'RECAPTCHA',
      bypassMode: 'NOT_CONFIGURED',
    });
    expect(reachability).toBe('UNREACHABLE_BEHIND_BOT_PROTECTION');
    // The state without the sentence is the confident 100%-of-nothing this
    // whole table exists to replace.
    expect(remedy).toContain('test keys');
  });

  it('stops claiming UNREACHABLE once a legitimate route is configured', () => {
    for (const bypassMode of BOT_BYPASS_MODES) {
      if (bypassMode === 'NOT_CONFIGURED') continue;
      expect(reachabilityFromPolicy({ provider: 'TURNSTILE', bypassMode }).reachability).toBe(
        'NOT_PROBED',
      );
    }
  });

  it('never reports REACHABLE from configuration alone', () => {
    // Configuration is not a measurement. Goes red if somebody "helpfully"
    // returns REACHABLE for a NONE provider — reporting as measured a thing
    // that was not measured.
    for (const provider of BOT_PROTECTION_PROVIDERS) {
      for (const bypassMode of BOT_BYPASS_MODES) {
        expect(reachabilityFromPolicy({ provider, bypassMode }).reachability).not.toBe('REACHABLE');
      }
    }
  });

  it('keeps UNKNOWN out of the NONE arm', () => {
    // NONE is a claim that nothing is in the way; UNKNOWN is "a challenge was
    // observed and not attributed". Reading the second as the first is how an
    // unreachable environment reports as clean.
    expect(
      reachabilityFromPolicy({ provider: 'UNKNOWN', bypassMode: 'NOT_CONFIGURED' }).reachability,
    ).toBe('UNREACHABLE_BEHIND_BOT_PROTECTION');
    expect(
      reachabilityFromPolicy({ provider: 'NONE', bypassMode: 'NOT_CONFIGURED' }).reachability,
    ).toBe('NOT_PROBED');
  });

  it('has a remedy for every provider', () => {
    for (const provider of BOT_PROTECTION_PROVIDERS) {
      expect(botProtectionRemedy(provider).length).toBeGreaterThan(0);
    }
  });

  it('refuses a signed-bypass row with nothing to send', () => {
    // A row claiming a bypass and carrying neither a header name nor a secret
    // would read as reachable and then fail on every request.
    const missing = botProtectionSchema.safeParse({
      provider: 'WAF',
      bypassMode: 'SIGNED_BYPASS_HEADER',
    });
    expect(missing.success).toBe(false);
    expect(
      botProtectionSchema.safeParse({
        provider: 'WAF',
        bypassMode: 'SIGNED_BYPASS_HEADER',
        bypassHeaderName: 'X-Bypass',
        bypassSecretName: 'WAF_BYPASS',
      }).success,
    ).toBe(true);
  });
});

describe('per-environment extra headers keep credentials in the vault', () => {
  it('accepts a non-secret header inline', () => {
    expect(
      environmentExtraHeaderSchema.safeParse({ name: 'X-Environment', value: 'staging' }).success,
    ).toBe(true);
  });

  it('refuses an Authorization header with an inline value', () => {
    // This row is rendered on an environment settings screen. An inline value
    // here puts a bearer token on it.
    const refused = environmentExtraHeaderSchema.safeParse({
      name: 'Authorization',
      value: 'Bearer abc',
    });
    expect(refused.success).toBe(false);
  });

  it('refuses it whatever the casing, because header names are case-insensitive', () => {
    // Goes red if the check ever compares without lower-casing — a customer
    // typing `AUTHORIZATION` would walk straight past it.
    for (const name of ['authorization', 'AUTHORIZATION', 'Cookie', 'X-Api-Key']) {
      expect(environmentExtraHeaderSchema.safeParse({ name, value: 'secret' }).success).toBe(false);
    }
  });

  it('accepts the same header as a vault reference', () => {
    expect(
      environmentExtraHeaderSchema.safeParse({
        name: 'Authorization',
        secretName: 'STAGING_BEARER',
      }).success,
    ).toBe(true);
  });

  it('refuses both at once and neither at all', () => {
    // Both: the reader would have to guess which wins. Neither: a header with
    // no value is a header that cannot be sent.
    expect(
      environmentExtraHeaderSchema.safeParse({ name: 'X-A', value: 'v', secretName: 's' }).success,
    ).toBe(false);
    expect(environmentExtraHeaderSchema.safeParse({ name: 'X-A' }).success).toBe(false);
  });

  it('refuses a header name that is not a header name', () => {
    expect(
      environmentExtraHeaderSchema.safeParse({ name: 'X Bad: Name', value: 'v' }).success,
    ).toBe(false);
  });
});

/**
 * The compiler, used as a test.
 *
 * A `Record` keyed on the union has no run time worth asserting beyond its
 * keys, which the parity tests above already do. What this fixture proves is
 * the direction those cannot: that an adapter can take a kind it learned from
 * the database and reach the config schema and the capability list for it,
 * without a cast and without a default arm. If either record is ever loosened
 * to a partial, this stops compiling.
 */
describe('an adapter can dispatch on a kind it read from a row', () => {
  it('resolves a schema and a capability list for an arbitrary stored kind', () => {
    const fromDatabase: AuthProfileKind = 'PHONE_OTP';
    const schema = AUTH_PROFILE_CONFIG_SCHEMAS[fromDatabase];
    const capabilities = AUTH_PROFILE_CAPABILITIES[fromDatabase];
    expect(schema.safeParse({}).success).toBe(false);
    expect(capabilities).toContain('OTP_SINK');
  });
});

/**
 * The Prisma enums these six vocabularies are mirrored by, compared value for
 * value — and why that comparison lives here rather than beside the other
 * nine.
 *
 * `apps/api/scripts/check-enums.auth-and-access.test.ts` checks this round's
 * enums against the hand-written migration's SQL and against schema.prisma,
 * and it compares the TypeScript mirror for the four vocabularies it can
 * import. It cannot import these six: they are in `auth-profiles.ts`, the
 * package barrel does not re-export the module yet, and reaching into another
 * workspace's source by relative path is not something this repo does.
 *
 * This file can import them, because it is in the same package. Reading
 * schema.prisma from here is the smaller of the two compromises, and it is a
 * file read in a test — nothing in the bundled path is touched.
 *
 * `npm run check:enums -w @qaai/api` makes the same comparison at build time
 * and additionally against the live database. This is the copy that fails in a
 * unit run, which is where a member added on one side only will actually be
 * noticed first.
 */
describe('the Prisma enums mirror these vocabularies exactly, in order', () => {
  const schema = readFileSync(
    fileURLToPath(new URL('../../../apps/api/prisma/schema.prisma', import.meta.url)),
    'utf8',
  );

  const prismaEnumMembers = (name: string): string[] => {
    const block = new RegExp(`\\benum\\s+${name}\\s*\\{([^}]*)\\}`).exec(schema);
    if (!block) throw new Error(`enum ${name} is not declared in schema.prisma`);
    return block[1]!
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line));
  };

  const PAIRS: ReadonlyArray<{ prismaEnum: string; members: readonly string[] }> = [
    { prismaEnum: 'RouteAccessOutcome', members: ROUTE_ACCESS_OUTCOMES },
    { prismaEnum: 'RouteAccessBasis', members: ROUTE_ACCESS_BASES },
    { prismaEnum: 'RoleCrawlOutcome', members: ROLE_CRAWL_OUTCOMES },
    { prismaEnum: 'BotProtectionProvider', members: BOT_PROTECTION_PROVIDERS },
    { prismaEnum: 'BotBypassMode', members: BOT_BYPASS_MODES },
    { prismaEnum: 'EnvironmentReachability', members: ENVIRONMENT_REACHABILITIES },
  ];

  for (const { prismaEnum, members } of PAIRS) {
    it(`${prismaEnum}`, () => {
      // Order as well as membership: the migration's CREATE TYPE was written
      // from these arrays, and a reordering would leave the two agreeing as
      // sets while the SQL and the schema disagreed — which PostgreSQL accepts
      // and which makes every ORDER BY on the enum silently different.
      expect(prismaEnumMembers(prismaEnum)).toEqual([...members]);
    });
  }

  it('declares a Prisma enum for each of them, so none is a TEXT column', () => {
    // Every one of these six is FILTERED ON by a reader — "which roles could we
    // not get into", "every FORBIDDEN cell", "is this environment reachable" —
    // which is what earns a database type rather than free text. A vocabulary
    // that quietly became TEXT would lose the drift guard entirely.
    for (const { prismaEnum } of PAIRS) {
      expect(schema).toContain(`enum ${prismaEnum} {`);
    }
  });
});
