/**
 * Getting past the five walls, and never lying about which side of one we are on.
 *
 * These tests exist because the defect they cover was INVISIBLE in exactly the
 * way that matters most to this product. `signInWithProfile` answered five of
 * eight auth-profile kinds with "needs the mail catcher / TOTP support that is
 * not built yet", a crawl recorded that as a wall with nothing behind it, and
 * the coverage number went UP. Nothing here asserts that a function was called.
 * Everything here asserts the FACT a consumer reads: whether a login happened,
 * what step it died at, and whose problem that is.
 *
 * Three groups of assertion carry most of the weight:
 *
 *  • THE PARITY GUARD. A kind the picker offers and this module cannot perform
 *    is the defect that shipped eight `GateRule` kinds unsaveable for two
 *    slices, and `check:wiring` cannot see it. `LOGIN_ADAPTER_PRESENT` is the
 *    compiler half; the run-time half is here, diffing three key sets.
 *
 *  • THE SINGLE-USE TRAP. A magic link and an SMS code are consumed by being
 *    used, so a retry must ask for a NEW one. A replayed one produces a login
 *    that works the first time and fails every time afterwards, and the symptom
 *    points at the application. Two tests per kind pin it: one counts the
 *    re-requests, the other feeds a sink that ignores the time filter.
 *
 *  • THE CLOCK. A TOTP code accepted at t and rejected at t+1 is a flaky login
 *    that gets blamed on the app under test. The window boundary is tested
 *    against RFC 6238's own vectors, and the wait-for-a-fresh-window behaviour
 *    is tested by watching what actually gets typed into the form.
 *
 * No test here touches a network, a browser, a mailbox or a clock it does not
 * own: every surface is the injected interface, faked in an object literal.
 */

import { describe, expect, it, vi } from 'vitest';
import { AUTH_PROFILE_KINDS, SECRET_MASK } from '@qaai/shared';
import {
  AUTH_CAPABILITIES,
  AUTH_PROFILE_CONFIG_SCHEMAS,
} from '@qaai/shared';
import {
  LOGIN_FAILURES,
  LOGIN_FAILURE_FAULT,
  PERFORMABLE_AUTH_PROFILE_KINDS,
  TOTP_MIN_REMAINING_MS,
  decodeBase32,
  hotp,
  loginCapabilities,
  performCookieInjection,
  performFormLogin,
  performMagicLinkLogin,
  performMockIdpLogin,
  performPasskeyLogin,
  performPhoneOtpLogin,
  performSsoToken,
  performTotpMfaLogin,
  signInWithProfile,
  totpAt,
} from './login.js';
import type {
  LoginBrowser,
  LoginNavigation,
  LoginResult,
  LoginStorageState,
  LoginSurfaces,
  MailboxMessage,
  MintedAssertion,
  MockIdpMintRequest,
  OtpDelivery,
  VirtualAuthenticatorOptions,
  VirtualAuthenticatorSurface,
} from './login.js';

const BASE = 'https://app.example.com';

// ─── The fakes ───────────────────────────────────────────────────────────────

interface FakeBrowserScript {
  /** Selectors `waitFor` should find. Everything else is absent, not an error. */
  visible?: readonly string[];
  /** Per-URL navigation answers, keyed by the URL as it is requested. */
  navigate?: Record<string, Partial<LoginNavigation>>;
  /** What `goto` answers for a URL with no entry above. */
  defaultNavigation?: Partial<LoginNavigation>;
  title?: string;
  storageState?: LoginStorageState | (() => Promise<LoginStorageState>);
  /** Selectors whose fill or click should report failure. */
  broken?: readonly string[];
  withPostForm?: boolean;
  /** Called after each goto, so a test can change the script mid-flow. */
  onGoto?: (url: string, visit: number) => void;
}

interface FakeBrowser extends LoginBrowser {
  readonly calls: string[];
  readonly filled: Record<string, string[]>;
  readonly clicks: string[];
  readonly posted: { url: string; fields: Readonly<Record<string, string>> }[];
  readonly visited: string[];
  closed: number;
}

function fakeBrowser(script: FakeBrowserScript = {}): FakeBrowser {
  const calls: string[] = [];
  const filled: Record<string, string[]> = {};
  const clicks: string[] = [];
  const posted: { url: string; fields: Readonly<Record<string, string>> }[] = [];
  const visited: string[] = [];
  const visible = new Set(script.visible ?? []);
  const broken = new Set(script.broken ?? []);
  let current = BASE;

  const navigationFor = (url: string): LoginNavigation => {
    const over = script.navigate?.[url] ?? script.defaultNavigation ?? {};
    return {
      ok: over.ok ?? true,
      url: over.url ?? url,
      status: over.status ?? 200,
      error: over.error ?? null,
    };
  };

  const browser: FakeBrowser = {
    calls,
    filled,
    clicks,
    posted,
    visited,
    closed: 0,

    url: () => current,

    goto: async (url) => {
      calls.push(`goto ${url}`);
      visited.push(url);
      const nav = navigationFor(url);
      current = nav.url;
      script.onGoto?.(url, visited.filter((seen) => seen === url).length);
      return nav;
    },

    fill: async (selector, value) => {
      calls.push(`fill ${selector}`);
      (filled[selector] ??= []).push(value);
      return !broken.has(selector);
    },

    click: async (selector) => {
      calls.push(`click ${selector}`);
      clicks.push(selector);
      return !broken.has(selector);
    },

    waitFor: async (selector) => {
      calls.push(`waitFor ${selector}`);
      return visible.has(selector);
    },

    title: async () => script.title ?? '',

    storageState: async () => {
      calls.push('storageState');
      const state = script.storageState;
      if (typeof state === 'function') return state();
      return state ?? { cookies: [{ name: 'sid' }], origins: [] };
    },

    close: async () => {
      browser.closed += 1;
    },
  };

  if (script.withPostForm) {
    browser.postForm = async (url, fields) => {
      calls.push(`postForm ${url}`);
      posted.push({ url, fields });
      const nav = navigationFor(url);
      current = nav.url;
      return nav;
    };
  }

  return browser;
}

/** A clock a test drives by hand, plus a sleep that advances it. */
function fakeClock(startMs = 0) {
  let nowMs = startMs;
  const slept: number[] = [];
  return {
    slept,
    now: () => nowMs,
    sleep: async (ms: number) => {
      slept.push(ms);
      nowMs += ms;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    get nowMs() {
      return nowMs;
    },
  };
}

function surfacesWith(browser: LoginBrowser, over: LoginSurfaces = {}): LoginSurfaces {
  return { browser: async () => browser, ...over };
}

/** RFC 6238's own seed: ASCII "12345678901234567890" in base32. */
const RFC_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

// ─── The parity guard: a kind the UI offers and this file cannot perform ─────

describe('every auth-profile kind has an adapter', () => {
  /*
   * THE DEFECT. MAGIC_LINK and TOTP_MFA were in `AUTH_PROFILE_KINDS` from the
   * beginning and `signInWithProfile`'s `default:` arm answered "not built yet"
   * for both. The picker offered them, the API stored them, and the crawl
   * behind the wall reported an application with nothing in it. Three kinds
   * more have since been added. `check:wiring` cannot see this class of break,
   * which is why the compiler half (`LOGIN_ADAPTER_PRESENT`) and this run-time
   * half both exist.
   */
  it('performs exactly the kinds the shared vocabulary names', () => {
    expect([...PERFORMABLE_AUTH_PROFILE_KINDS].sort()).toEqual([...AUTH_PROFILE_KINDS].sort());
  });

  it('performs exactly the kinds that have a stored config schema', () => {
    expect([...PERFORMABLE_AUTH_PROFILE_KINDS].sort()).toEqual(
      Object.keys(AUTH_PROFILE_CONFIG_SCHEMAS).sort(),
    );
  });

  it('never answers any kind with "not built yet"', async () => {
    // With no surfaces and an empty config, every kind must come back with a
    // real, actionable failure — UNAVAILABLE, MISCONFIGURED or a policy
    // refusal. The one answer that must not exist any more is the old one.
    for (const kind of AUTH_PROFILE_KINDS) {
      const result = await signInWithProfile(
        { id: 'p1', name: 'probe', kind, config: {} },
        {},
        { environmentKind: 'STAGING', baseUrl: BASE },
      );
      expect(result.ok, kind).toBe(false);
      expect(result.failure, kind).not.toBeNull();
      expect(result.message.toLowerCase(), kind).not.toContain('not built');
      expect(['UNAVAILABLE', 'MISCONFIGURED', 'REFUSED_BY_POLICY'], kind).toContain(
        result.failure?.kind,
      );
    }
  });

  it('attributes every failure kind', () => {
    for (const failure of LOGIN_FAILURES) {
      expect(LOGIN_FAILURE_FAULT[failure], failure).toBeDefined();
    }
    expect(Object.keys(LOGIN_FAILURE_FAULT).sort()).toEqual([...LOGIN_FAILURES].sort());
  });

  it('decides every capability from a surface', () => {
    // A capability nobody decided on reads as "needs nothing" and gets
    // attempted, which is how an adapterless kind looks like a failed login.
    const none = loginCapabilities({});
    const all = loginCapabilities({
      mailbox: { poll: async () => [] },
      otpSink: { poll: async () => [] },
      webAuthn: () => null,
      idp: { mint: async () => ({ delivery: 'REDIRECT', url: BASE }) },
    });
    expect([...all].sort()).toEqual([...AUTH_CAPABILITIES].sort());
    // BROWSER is available with no factory because the default is the real
    // Playwright adapter; the external systems are not.
    expect(none).toContain('BROWSER');
    expect(none).not.toContain('MAILBOX_POLL');
    expect(none).not.toContain('CDP_WEBAUTHN');
  });
});

describe('ok and failure never disagree', () => {
  /*
   * The invariant that makes the whole vocabulary trustworthy. `ok: false` with
   * `failure: null` is the old behaviour wearing the new shape, and a consumer
   * that renders `failure.step` would print nothing for it.
   */
  const scenarios: [string, () => Promise<LoginResult> | LoginResult][] = [
    ['form login, confirmed', () =>
      performFormLogin(formConfig(), { u: 'ada', p: 'hunter22' }, BASE,
        surfacesWith(fakeBrowser({ visible: ['#home'] })))],
    ['form login, rejected', () =>
      performFormLogin(formConfig(), { u: 'ada', p: 'hunter22' }, BASE,
        surfacesWith(fakeBrowser({})))],
    ['form login, missing secret', () => performFormLogin(formConfig(), {}, BASE, surfacesWith(fakeBrowser()))],
    ['cookie injection', () => performCookieInjection({ cookiesSecretName: 'c', domain: 'x' }, { c: '[{"name":"s"}]' })],
    ['cookie injection, bad json', () => performCookieInjection({ cookiesSecretName: 'c', domain: 'x' }, { c: 'nope' })],
    ['sso token', () => performSsoToken({ tokenSecretName: 't', header: 'Authorization', valueTemplate: 'Bearer {token}' }, { t: 'abc123' })],
    ['passkey, no authenticator', () => performPasskeyLogin(passkeyConfig(), {}, BASE, surfacesWith(fakeBrowser()))],
    ['magic link, no mailbox', () => performMagicLinkLogin(magicConfig(), {}, BASE, surfacesWith(fakeBrowser()))],
  ];

  for (const [name, run] of scenarios) {
    it(name, async () => {
      const result = await run();
      if (result.ok) {
        expect(result.failure).toBeNull();
        expect(result.confirmedBy).not.toBeNull();
        expect(result.expiresAt).toBeInstanceOf(Date);
      } else {
        const failure = result.failure;
        expect(failure).not.toBeNull();
        expect(result.confirmedBy).toBeNull();
        expect(result.expiresAt).toBeNull();
        expect(failure?.detail).toBe(result.message);
        // The fault is derived, so it cannot drift from the kind it attributes.
        expect(failure?.fault).toBe(failure && LOGIN_FAILURE_FAULT[failure.kind]);
      }
    });
  }
});

// ─── Register item 1: TOTP / MFA ─────────────────────────────────────────────

describe('TOTP is RFC 6238 and not an approximation of it', () => {
  /*
   * Checked against the SPEC's vectors, not against itself. A self-consistent
   * wrong implementation produces codes every application rejects, and a test
   * that computed the expected value with the same code would pass anyway.
   * These are RFC 6238 appendix B, SHA-1, 8 digits.
   */
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  for (const [seconds, expected] of vectors) {
    it(`matches the published vector at T=${seconds}`, () => {
      expect(totpAt(RFC_SEED, seconds * 1000, { digits: 8 }).code).toBe(expected);
    });
  }

  it('defaults to six digits over a thirty-second period', () => {
    const code = totpAt(RFC_SEED, 59_000);
    expect(code.code).toHaveLength(6);
    // The six-digit code is the low six of the eight-digit one.
    expect(code.code).toBe('287082');
    expect(code.step).toBe(1);
  });

  it('honours a non-default hash', () => {
    // An authenticator may be provisioned with SHA-256. Computing SHA-1 for it
    // yields a code the application rejects and a login that looks like a wrong
    // password, so the option has to actually change the answer.
    const sha1 = totpAt(RFC_SEED, 59_000, { digits: 8 });
    const sha256 = totpAt(RFC_SEED, 59_000, { digits: 8, algorithm: 'sha256' });
    expect(sha256.code).not.toBe(sha1.code);
  });

  it('decodes a seed in the shape a human was shown it', () => {
    // Authenticator seeds are presented lower-case in groups of four and get
    // pasted that way. Refusing that is refusing the format the secret came in.
    const canonical = decodeBase32(RFC_SEED);
    expect(decodeBase32('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toEqual(canonical);
    expect(decodeBase32('GEZD-GNBV-GY3T-QOJQ-GEZD-GNBV-GY3T-QOJQ')).toEqual(canonical);
    expect(decodeBase32('MFRGG===')).toEqual(decodeBase32('MFRGG'));
    expect(decodeBase32(RFC_SEED).toString('ascii')).toBe('12345678901234567890');
  });

  it('refuses a seed that is not base32 instead of decoding it nearly right', () => {
    // A silently skipped character produces codes that are always wrong with no
    // clue as to why, which is indistinguishable from a wrong password.
    expect(() => decodeBase32('GEZD1NBV')).toThrow(/not base32.*"1"/);
    expect(() => decodeBase32('   ')).toThrow(/empty/);
  });

  it('agrees with HOTP on the counter it derives', () => {
    const step = Math.floor(1111111109 / 30);
    expect(hotp(decodeBase32(RFC_SEED), step, 8, 'sha1')).toBe('07081804');
  });
});

describe('the TOTP window boundary', () => {
  /*
   * THE DEFECT. A code computed at t=29.8s inside a 30s window is correct when
   * computed and expired when submitted. The login fails perhaps one time in a
   * hundred, looks exactly like a wrong password, and is blamed on the
   * application under test — so the customer goes hunting a bug they do not
   * have. Everything below is about that one second.
   */
  it('holds one code for the whole window and changes on the boundary', () => {
    const atZero = totpAt(RFC_SEED, 0);
    const atEnd = totpAt(RFC_SEED, 29_999);
    const afterEnd = totpAt(RFC_SEED, 30_000);

    expect(atEnd.code).toBe(atZero.code);
    expect(atEnd.step).toBe(0);
    expect(afterEnd.step).toBe(1);
    expect(afterEnd.code).not.toBe(atZero.code);
  });

  it('reports how long the code it just produced has left', () => {
    expect(totpAt(RFC_SEED, 0).msRemaining).toBe(30_000);
    expect(totpAt(RFC_SEED, 29_999).msRemaining).toBe(1);
    expect(totpAt(RFC_SEED, 45_000).validFromMs).toBe(30_000);
    expect(totpAt(RFC_SEED, 45_000).validUntilMs).toBe(60_000);
    expect(totpAt(RFC_SEED, 45_000).msRemaining).toBe(15_000);
  });

  it('waits out a window that is about to end rather than racing it', async () => {
    // 500ms left: below the floor, so the next window's code is what gets typed.
    const clock = fakeClock(29_500);
    const browser = fakeBrowser({ visible: ['#code', '#home'] });
    const result = await performTotpMfaLogin(
      totpConfig(),
      { u: 'ada', p: 'hunter22', seed: RFC_SEED },
      BASE,
      surfacesWith(browser, { now: clock.now, sleep: clock.sleep }),
    );

    expect(result.ok).toBe(true);
    expect(clock.slept).toEqual([500]);
    expect(browser.filled['#code']).toEqual([totpAt(RFC_SEED, 30_000).code]);
    // The wait is disclosed rather than being an invisible pause.
    expect(result.message).toMatch(/waited 500ms/);
  });

  it('does not wait when the window has room', async () => {
    const clock = fakeClock(25_000);
    const browser = fakeBrowser({ visible: ['#code', '#home'] });
    const result = await performTotpMfaLogin(
      totpConfig(),
      { u: 'ada', p: 'hunter22', seed: RFC_SEED },
      BASE,
      surfacesWith(browser, { now: clock.now, sleep: clock.sleep }),
    );

    expect(result.ok).toBe(true);
    expect(clock.slept).toEqual([]);
    expect(browser.filled['#code']).toEqual([totpAt(RFC_SEED, 25_000).code]);
    expect(result.message).not.toMatch(/waited/);
    // The floor is the thing being relied on, so it is asserted rather than assumed.
    expect(totpAt(RFC_SEED, 25_000).msRemaining).toBeGreaterThanOrEqual(TOTP_MIN_REMAINING_MS);
  });
});

describe('a TOTP login reports which factor failed', () => {
  it('blames the password when the code field never appears', async () => {
    // THE DISTINCTION. A missing code field means the first factor was
    // rejected. Reporting it at SECOND_FACTOR sends the reader to check their
    // authenticator seed, which is fine, and their password, which is wrong.
    const browser = fakeBrowser({ title: 'Sign in' });
    const result = await performTotpMfaLogin(
      totpConfig(),
      { u: 'ada', p: 'hunter22', seed: RFC_SEED },
      BASE,
      surfacesWith(browser),
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe('REJECTED');
    expect(result.failure?.step).toBe('CREDENTIAL');
    expect(result.failure?.fault).toBe('OURS');
    expect(result.message).toMatch(/password was not accepted/);
    // Nothing was typed into the code field, so no code was spent.
    expect(browser.filled['#code']).toBeUndefined();
  });

  it('blames the code when the first factor was accepted and the login was not', async () => {
    const browser = fakeBrowser({ visible: ['#code'] });
    const result = await performTotpMfaLogin(
      totpConfig(),
      { u: 'ada', p: 'hunter22', seed: RFC_SEED },
      BASE,
      surfacesWith(browser, { now: () => 0 }),
    );

    expect(result.failure?.step).toBe('SECOND_FACTOR');
    expect(browser.filled['#code']).toHaveLength(1);
  });

  it('calls a bad seed configuration, not a failed login', async () => {
    // The arithmetic never ran, so no credential was ever offered. TIMED_OUT or
    // REJECTED here would both be inventions.
    const result = await performTotpMfaLogin(
      totpConfig(),
      { u: 'ada', p: 'hunter22', seed: 'not!base32' },
      BASE,
      surfacesWith(fakeBrowser({ visible: ['#code'] })),
    );

    expect(result.failure?.kind).toBe('MISCONFIGURED');
    expect(result.failure?.step).toBe('CONFIG');
  });

  it('never puts the code in the result', async () => {
    const clock = fakeClock(0);
    const browser = fakeBrowser({ visible: ['#code'] });
    const result = await performTotpMfaLogin(
      totpConfig(),
      { u: 'ada', p: 'hunter22', seed: RFC_SEED },
      BASE,
      surfacesWith(browser, { now: clock.now, sleep: clock.sleep }),
    );

    const code = totpAt(RFC_SEED, 0).code;
    expect(browser.filled['#code']).toEqual([code]);
    expect(result.message).not.toContain(code);
    expect(JSON.stringify(result)).not.toContain(code);
  });
});

// ─── Register item 2: magic link ─────────────────────────────────────────────

describe('magic-link sign-in', () => {
  const link = `${BASE}/auth/callback?token=sealed-token-value`;

  it('requests a link, waits for it, and follows it', async () => {
    const browser = fakeBrowser({
      navigate: { [link]: { status: 200, url: `${BASE}/dashboard` } },
    });
    const clock = fakeClock(1_000);
    const result = await performMagicLinkLogin(magicConfig(), {}, BASE, {
      ...surfacesWith(browser, { now: clock.now, sleep: clock.sleep }),
      mailbox: mailbox([{ id: 'm1', receivedAtMs: 1_000, text: `Sign in: ${link}` }]),
    });

    expect(result.ok).toBe(true);
    expect(browser.visited).toContain(link);
    // No success locator is configurable for this kind, so the weaker
    // confirmation is DISCLOSED rather than quietly called the strong one.
    expect(result.confirmedBy).toBe('STATUS_AND_URL_ONLY');
  });

  it('reports a link that never came as a timed-out login, not an empty app', async () => {
    /*
     * RULE 10. "The link never arrived" and "we got in and your app has no
     * authenticated surface" are opposite facts, and only the second is the
     * customer's coverage problem. The old shape could express only one of them.
     */
    const clock = fakeClock(0);
    const result = await performMagicLinkLogin(magicConfig(), {}, BASE, {
      ...surfacesWith(fakeBrowser(), { now: clock.now, sleep: clock.sleep }),
      mailbox: mailbox([]),
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe('TIMED_OUT');
    expect(result.failure?.step).toBe('DELIVERY');
    expect(result.failure?.fault).toBe('UNDETERMINED');
    expect(result.message).toMatch(/Nothing was learned about what is behind this login/);
    expect(result.storageState).toBeNull();
  });

  it('requests a NEW link on a retry instead of replaying the old one', async () => {
    /*
     * THE SINGLE-USE TRAP. A magic link is consumed by being followed, so a
     * replay produces a login that works the first time and fails every time
     * afterwards — "the second crawl of this environment always fails", blamed
     * on the application.
     */
    const stale = `${BASE}/auth/callback?token=spent`;
    const fresh = `${BASE}/auth/callback?token=minted`;
    const browser = fakeBrowser({
      navigate: {
        [stale]: { status: 410, ok: false },
        [fresh]: { status: 200, url: `${BASE}/dashboard` },
      },
    });
    const clock = fakeClock(1_000);
    const delivered: MailboxMessage[] = [
      { id: 'm1', receivedAtMs: 1_000, text: `Sign in: ${stale}` },
    ];
    const result = await performMagicLinkLogin(magicConfig(), {}, BASE, {
      ...surfacesWith(browser, { now: clock.now, sleep: clock.sleep }),
      mailbox: {
        poll: async ({ sinceMs }) => {
          // The application mints a new link because the form was submitted again.
          if (browser.clicks.length >= 2 && !delivered.some((m) => m.id === 'm2')) {
            delivered.push({ id: 'm2', receivedAtMs: clock.nowMs, text: `Sign in: ${fresh}` });
          }
          return delivered.filter((m) => m.receivedAtMs >= sinceMs);
        },
      },
    });

    expect(result.ok).toBe(true);
    // The request form was submitted twice: the second link was MINTED, not reused.
    expect(browser.clicks.filter((c) => c === '#send')).toHaveLength(2);
    expect(browser.visited).toContain(fresh);
    expect(browser.visited.filter((url) => url === stale)).toHaveLength(1);
  });

  it('will not accept a link that arrived before it asked for one', async () => {
    /*
     * The third guard, and the one the other two cannot stand in for. A mailbox
     * legitimately holds older links — one the customer requested by hand, one
     * left by the previous crawl — and every one of them is spent or about to
     * be. The `consumed` set is empty on the first attempt, so only the
     * per-attempt `sinceMs` can refuse this, and a poll from the epoch would
     * follow a stale link on the very first try.
     *
     * This test was added because a mutation that polled from 0 instead of from
     * this attempt's request instant SURVIVED the rest of this file.
     */
    const old = `${BASE}/auth/callback?token=from-five-minutes-ago`;
    const browser = fakeBrowser();
    const clock = fakeClock(300_000);
    const result = await performMagicLinkLogin(magicConfig(), {}, BASE, {
      ...surfacesWith(browser, { now: clock.now, sleep: clock.sleep }),
      // The sink honours the filter it is given — so what it returns is decided
      // entirely by the instant this module asks about.
      mailbox: mailbox([{ id: 'm0', receivedAtMs: 1_000, text: `Sign in: ${old}` }]),
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe('TIMED_OUT');
    expect(browser.visited).not.toContain(old);
  });

  it('refuses to replay a link even when the sink ignores the time filter', async () => {
    /*
     * The second half of the same guard, and the one that matters when the
     * catcher is somebody else's. A sink that returns everything it has would
     * otherwise hand back the consumed link on every poll of every attempt.
     */
    const spent = `${BASE}/auth/callback?token=spent`;
    const browser = fakeBrowser({ navigate: { [spent]: { status: 410, ok: false } } });
    const clock = fakeClock(1_000);
    const result = await performMagicLinkLogin(magicConfig(), {}, BASE, {
      ...surfacesWith(browser, { now: clock.now, sleep: clock.sleep }),
      // Returns the same message forever, at an instant that is always "now".
      mailbox: { poll: async ({ sinceMs }) => [{ id: 'm1', receivedAtMs: sinceMs, text: spent }] },
    });

    expect(result.ok).toBe(false);
    // Followed exactly once, on the attempt that first saw it.
    expect(browser.visited.filter((url) => url === spent)).toHaveLength(1);
    expect(result.failure?.kind).toBe('TIMED_OUT');
  });

  it('will not follow a link out of the mailbox to another origin', async () => {
    /*
     * A mailbox is UNTRUSTED input — anyone can post into a catcher — and
     * `linkPattern` defaults to "any URL". Following whatever turns up is a way
     * to be walked off the application under test.
     */
    const foreign = 'https://click.tracker.example/r/abc?u=app.example.com';
    const browser = fakeBrowser();
    const clock = fakeClock(1_000);
    const result = await performMagicLinkLogin(magicConfig(), {}, BASE, {
      ...surfacesWith(browser, { now: clock.now, sleep: clock.sleep }),
      mailbox: mailbox([{ id: 'm1', receivedAtMs: 1_000, text: `Go: ${foreign}` }]),
    });

    expect(result.failure?.kind).toBe('REFUSED_BY_POLICY');
    expect(result.failure?.step).toBe('FOLLOW_LINK');
    expect(result.message).toContain('https://click.tracker.example');
    // The ORIGIN is named and the link is not: a magic-link URL is a single-use
    // credential and must not appear in a message.
    expect(result.message).not.toContain('/r/abc');
    expect(browser.visited).not.toContain(foreign);
  });

  it('calls a broken pattern configuration rather than a delivery failure', async () => {
    const result = await performMagicLinkLogin(
      { ...magicConfig(), linkPattern: 'https?://(' },
      {},
      BASE,
      { ...surfacesWith(fakeBrowser()), mailbox: mailbox([]) },
    );
    expect(result.failure?.kind).toBe('MISCONFIGURED');
    expect(result.failure?.step).toBe('CONFIG');
  });

  it('reports UNAVAILABLE, with a remedy, when there is no mailbox at all', async () => {
    const result = await performMagicLinkLogin(magicConfig(), {}, BASE, surfacesWith(fakeBrowser()));

    expect(result.failure?.kind).toBe('UNAVAILABLE');
    expect(result.failure?.fault).toBe('UNDETERMINED');
    expect(result.failure?.unavailable?.missing).toEqual(['MAILBOX_POLL']);
    expect(result.failure?.unavailable?.remedy).not.toBe('');
    expect(result.message).toMatch(/nothing is known about the surface behind this wall/);
  });
});

// ─── Register item 3: passkey / WebAuthn ─────────────────────────────────────

describe('passkey sign-in through a virtual authenticator', () => {
  function fakeAuthenticator(over: Partial<VirtualAuthenticatorSurface> = {}) {
    const added: VirtualAuthenticatorOptions[] = [];
    const removed: string[] = [];
    const credentials: string[] = [];
    const surface: VirtualAuthenticatorSurface = {
      add: async (options) => {
        added.push(options);
        return { authenticatorId: 'auth-1' };
      },
      addCredential: async (_id, credential) => {
        credentials.push(credential);
      },
      remove: async (id) => {
        removed.push(id);
      },
      ...over,
    };
    return { surface, added, removed, credentials };
  }

  it('attaches the configured authenticator and signs in', async () => {
    const authenticator = fakeAuthenticator();
    const browser = fakeBrowser({ visible: ['#home'] });
    const result = await performPasskeyLogin(passkeyConfig(), {}, BASE, {
      ...surfacesWith(browser),
      webAuthn: () => authenticator.surface,
    });

    expect(result.ok).toBe(true);
    expect(result.confirmedBy).toBe('SUCCESS_LOCATOR');
    // The config's fields are the CDP call's real arguments, passed through.
    expect(authenticator.added).toEqual([passkeyConfig().authenticator]);
    expect(authenticator.removed).toEqual(['auth-1']);
  });

  it('types no username in a discoverable-credential flow', async () => {
    // The common modern passkey page offers the credential directly. Requiring
    // an identifier would refuse the flow most passkey apps actually ship.
    const browser = fakeBrowser({ visible: ['#home'] });
    const result = await performPasskeyLogin(
      { ...passkeyConfig(), usernameSelector: undefined, usernameSecretName: undefined },
      {},
      BASE,
      { ...surfacesWith(browser), webAuthn: () => fakeAuthenticator().surface },
    );

    expect(result.ok).toBe(true);
    expect(Object.keys(browser.filled)).toEqual([]);
  });

  it('reports UNAVAILABLE when the transport has no authenticator', async () => {
    const result = await performPasskeyLogin(passkeyConfig(), {}, BASE, surfacesWith(fakeBrowser()));

    expect(result.failure?.kind).toBe('UNAVAILABLE');
    expect(result.failure?.unavailable?.missing).toEqual(['CDP_WEBAUTHN']);
    expect(result.failure?.unavailable?.remedy).toMatch(/Chromium/);
  });

  it('reports UNAVAILABLE when THIS session cannot serve one', async () => {
    /*
     * The second stage, and the reason the factory takes the open browser. A
     * Firefox or WebKit session genuinely has no CDP `WebAuthn` domain. That is
     * a fact about the session rather than the configuration, and a DRIVER_ERROR
     * here would read as "your passkey login is broken".
     */
    const browser = fakeBrowser();
    const result = await performPasskeyLogin(passkeyConfig(), {}, BASE, {
      ...surfacesWith(browser),
      webAuthn: () => null,
    });

    expect(result.failure?.kind).toBe('UNAVAILABLE');
    expect(result.failure?.step).toBe('SECOND_FACTOR');
    expect(result.failure?.unavailable?.missing).toEqual(['CDP_WEBAUTHN']);
    // The remedy names the ONE thing that is missing. A session that reached
    // this point plainly has a browser, and telling its owner to install
    // Playwright's browsers would send them to fix something that is not broken.
    expect(result.failure?.unavailable?.remedy).toMatch(/Chromium/);
    expect(result.failure?.unavailable?.remedy).not.toMatch(/No browser could be launched/);
    expect(browser.closed).toBe(1);
  });

  it('reports UNAVAILABLE when an enrolled credential cannot be injected', async () => {
    const authenticator = fakeAuthenticator({ addCredential: undefined });
    const result = await performPasskeyLogin(
      { ...passkeyConfig(), credentialSecretName: 'cred' },
      { cred: 'enrolled-credential-blob' },
      BASE,
      { ...surfacesWith(fakeBrowser({ visible: ['#home'] })), webAuthn: () => authenticator.surface },
    );

    expect(result.failure?.kind).toBe('UNAVAILABLE');
    expect(result.message).toMatch(/cannot inject a credential/);
    expect(authenticator.added).toEqual([]);
  });

  it('never logs the enrolled credential', async () => {
    const authenticator = fakeAuthenticator();
    const result = await performPasskeyLogin(
      { ...passkeyConfig(), credentialSecretName: 'cred' },
      { cred: 'enrolled-credential-blob' },
      BASE,
      { ...surfacesWith(fakeBrowser({ visible: ['#home'] })), webAuthn: () => authenticator.surface },
    );

    expect(result.ok).toBe(true);
    expect(authenticator.credentials).toEqual(['enrolled-credential-blob']);
    expect(JSON.stringify(result)).not.toContain('enrolled-credential-blob');
  });

  it('removes the authenticator even when the login fails', async () => {
    // A virtual authenticator left attached to a pooled session would serve the
    // next crawl somebody else's credential.
    const authenticator = fakeAuthenticator();
    const result = await performPasskeyLogin(passkeyConfig(), {}, BASE, {
      ...surfacesWith(fakeBrowser({})),
      webAuthn: () => authenticator.surface,
    });

    expect(result.ok).toBe(false);
    expect(authenticator.removed).toEqual(['auth-1']);
  });

  it('does not let a failing cleanup turn a success into an error', async () => {
    const authenticator = fakeAuthenticator({
      remove: async () => {
        throw new Error('CDP session already gone');
      },
    });
    const result = await performPasskeyLogin(passkeyConfig(), {}, BASE, {
      ...surfacesWith(fakeBrowser({ visible: ['#home'] })),
      webAuthn: () => authenticator.surface,
    });

    expect(result.ok).toBe(true);
  });
});

// ─── Register item 4: phone / SMS OTP ────────────────────────────────────────

describe('phone-OTP sign-in', () => {
  it('reads the code out of the sink and submits it', async () => {
    const browser = fakeBrowser({ visible: ['#home'] });
    const clock = fakeClock(1_000);
    const result = await performPhoneOtpLogin(otpConfig(), { phone: '+15555550123' }, BASE, {
      ...surfacesWith(browser, { now: clock.now, sleep: clock.sleep }),
      otpSink: otpSink([{ id: 'd1', receivedAtMs: 1_000, text: 'Your code is 408913' }]),
    });

    expect(result.ok).toBe(true);
    expect(browser.filled['#code']).toEqual(['408913']);
    // Neither the code nor the phone number is in anything we hand back.
    expect(JSON.stringify(result)).not.toContain('408913');
    expect(JSON.stringify(result)).not.toContain('+15555550123');
  });

  it('reports a code that never came as timed out, with the cap named', async () => {
    const clock = fakeClock(0);
    const result = await performPhoneOtpLogin(otpConfig(), { phone: '+15555550123' }, BASE, {
      ...surfacesWith(fakeBrowser(), { now: clock.now, sleep: clock.sleep }),
      otpSink: otpSink([]),
    });

    expect(result.failure?.kind).toBe('TIMED_OUT');
    expect(result.failure?.step).toBe('DELIVERY');
    expect(result.message).toMatch(/within 30s/);
    expect(result.message).toMatch(/nothing was learned about the surface behind it/);
  });

  it('requests a NEW code on a retry instead of resubmitting the old one', async () => {
    const browser = fakeBrowser({ visible: [] });
    const clock = fakeClock(1_000);
    let issued = 0;
    const result = await performPhoneOtpLogin(otpConfig(), { phone: '+15555550123' }, BASE, {
      ...surfacesWith(browser, { now: clock.now, sleep: clock.sleep }),
      otpSink: {
        poll: async ({ sinceMs }) => {
          issued += 1;
          return [{ id: `d${issued}`, receivedAtMs: sinceMs, text: `code ${100000 + issued}` }];
        },
      },
    });

    expect(result.ok).toBe(false);
    // Two requests, two distinct codes typed — not one code typed twice.
    expect(browser.clicks.filter((c) => c === '#request')).toHaveLength(2);
    expect(browser.filled['#code']).toHaveLength(2);
    expect(new Set(browser.filled['#code']).size).toBe(2);
  });

  it('will not use a code that arrived before it asked for one', async () => {
    // The same guard as the magic link's, and found the same way: a mutation
    // that polled the sink from the epoch survived every other test here. An
    // SMS code is short-lived, so an old one in the sink is spent by definition
    // — using it produces a rejected login blamed on the application.
    const browser = fakeBrowser({ visible: ['#home'] });
    const clock = fakeClock(300_000);
    const result = await performPhoneOtpLogin(otpConfig(), { phone: '+15555550123' }, BASE, {
      ...surfacesWith(browser, { now: clock.now, sleep: clock.sleep }),
      otpSink: otpSink([{ id: 'd0', receivedAtMs: 1_000, text: 'Your code is 111111' }]),
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe('TIMED_OUT');
    expect(browser.filled['#code']).toBeUndefined();
  });

  it('reports UNAVAILABLE when there is no sink, rather than guessing a code', async () => {
    // QAAI never reads a real phone and there is no phone here. UNAVAILABLE is
    // an honest answer; guessing six digits is not an answer at all.
    const result = await performPhoneOtpLogin(otpConfig(), { phone: '+1' }, BASE, surfacesWith(fakeBrowser()));

    expect(result.failure?.kind).toBe('UNAVAILABLE');
    expect(result.failure?.unavailable?.missing).toEqual(['OTP_SINK']);
    expect(result.failure?.unavailable?.remedy).toMatch(/never reads a real phone/);
  });

  it('prefers a capture group so a pattern can bracket the digits', async () => {
    const browser = fakeBrowser({ visible: ['#home'] });
    const clock = fakeClock(1_000);
    await performPhoneOtpLogin(
      { ...otpConfig(), codePattern: 'code:\\s*(\\d{6})' },
      { phone: '+1' },
      BASE,
      {
        ...surfacesWith(browser, { now: clock.now, sleep: clock.sleep }),
        otpSink: otpSink([{ id: 'd1', receivedAtMs: 1_000, text: 'ACME code: 224466 expires soon' }]),
      },
    );

    expect(browser.filled['#code']).toEqual(['224466']);
  });
});

// ─── Register item 5: mock IdP ───────────────────────────────────────────────

describe('mock-IdP sign-in', () => {
  function fakeIdp(assertion: Partial<MintedAssertion> = {}) {
    const requests: MockIdpMintRequest[] = [];
    return {
      requests,
      surface: {
        mint: async (request: MockIdpMintRequest) => {
          requests.push(request);
          return {
            delivery: assertion.delivery ?? 'REDIRECT',
            url: assertion.url ?? `${BASE}/sso/callback?code=minted`,
            ...(assertion.fields ? { fields: assertion.fields } : {}),
          } satisfies MintedAssertion;
        },
      },
    };
  }

  it('refuses PRODUCTION outright, and mints nothing', async () => {
    /*
     * SECURITY. Minting an assertion against a production environment is
     * forging a real identity against a real system. The refusal is checked
     * here as well as at the dispatcher because this function is exported and
     * callable directly, and `environmentKind` is a required parameter with no
     * default so that no caller can reach this code without stating it.
     */
    const idp = fakeIdp();
    const browser = fakeBrowser({ visible: ['#home'] });
    const result = await performMockIdpLogin(mockIdpConfig(), {}, BASE, 'PRODUCTION', {
      ...surfacesWith(browser),
      idp: idp.surface,
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe('REFUSED_BY_POLICY');
    expect(result.failure?.step).toBe('POLICY');
    expect(result.message).toMatch(/forging a real identity/);
    // Nothing was minted and no browser was even opened.
    expect(idp.requests).toEqual([]);
    expect(browser.calls).toEqual([]);
  });

  it('allows a staging environment the customer configured to trust the issuer', async () => {
    const idp = fakeIdp();
    const browser = fakeBrowser({
      visible: ['#home'],
      navigate: { [`${BASE}/sso/start`]: { url: `${BASE}/sso/start?SAMLRequest=abc` } },
    });
    const result = await performMockIdpLogin(mockIdpConfig(), {}, BASE, 'STAGING', {
      ...surfacesWith(browser),
      idp: idp.surface,
    });

    expect(result.ok).toBe(true);
    expect(idp.requests).toHaveLength(1);
    expect(idp.requests[0]?.issuer).toBe('https://idp.test.internal');
    expect(idp.requests[0]?.subject).toBe('ada@example.com');
    expect(idp.requests[0]?.claims).toEqual({ groups: ['admin'] });
    // The authn request is READ off the application's own redirect, never built.
    expect(idp.requests[0]?.authnRequestUrl).toBe(`${BASE}/sso/start?SAMLRequest=abc`);
  });

  it('hands the signing key by NAME and never by value', async () => {
    const idp = fakeIdp();
    await performMockIdpLogin(
      mockIdpConfig(),
      { 'idp-key': '-----BEGIN PRIVATE KEY-----sealed' },
      BASE,
      'LOCAL',
      { ...surfacesWith(fakeBrowser({ visible: ['#home'] })), idp: idp.surface },
    );

    expect(idp.requests[0]?.signingKeySecretName).toBe('idp-key');
    expect(JSON.stringify(idp.requests)).not.toContain('BEGIN PRIVATE KEY');
  });

  it('names the claims it minted and not their values', async () => {
    // A claim VALUE is the role material. It belongs in the profile row, not in
    // a message that gets rendered in a cockpit and written to an audit log.
    const result = await performMockIdpLogin(
      { ...mockIdpConfig(), claims: { groups: ['platform-admin'], tier: 'enterprise' } },
      {},
      BASE,
      'STAGING',
      { ...surfacesWith(fakeBrowser({ visible: ['#home'] })), idp: fakeIdp().surface },
    );

    expect(result.message).toContain('groups');
    expect(result.message).toContain('tier');
    expect(result.message).not.toContain('platform-admin');
    expect(result.message).not.toContain('enterprise');
  });

  it('refuses to deliver an assertion to any host but the application', async () => {
    /*
     * The structural half of "this never touches a real provider". A mint that
     * hands back somebody else's host is refused before anything is sent, so
     * there is no code path that posts an assertion off the environment.
     */
    const browser = fakeBrowser({ visible: ['#home'], withPostForm: true });
    const result = await performMockIdpLogin(mockIdpConfig(), {}, BASE, 'STAGING', {
      ...surfacesWith(browser),
      idp: fakeIdp({ url: 'https://accounts.google.com/signin/oauth' }).surface,
    });

    expect(result.failure?.kind).toBe('REFUSED_BY_POLICY');
    expect(result.failure?.step).toBe('ASSERTION');
    expect(result.message).toContain('https://accounts.google.com');
    expect(browser.posted).toEqual([]);
    expect(browser.visited).not.toContain('https://accounts.google.com/signin/oauth');
  });

  it('delivers a SAML assertion by form POST', async () => {
    const browser = fakeBrowser({ visible: ['#home'], withPostForm: true });
    const result = await performMockIdpLogin(mockIdpConfig(), {}, BASE, 'STAGING', {
      ...surfacesWith(browser),
      idp: fakeIdp({
        delivery: 'FORM_POST',
        url: `${BASE}/saml/acs`,
        fields: { SAMLResponse: 'base64-assertion' },
      }).surface,
    });

    expect(result.ok).toBe(true);
    expect(browser.posted).toEqual([
      { url: `${BASE}/saml/acs`, fields: { SAMLResponse: 'base64-assertion' } },
    ]);
    expect(JSON.stringify(result)).not.toContain('base64-assertion');
  });

  it('reports UNAVAILABLE when the browser cannot post a form', async () => {
    // A surface that cannot POST cannot do SAML. That is a capability gap, not
    // an application that rejected us.
    const result = await performMockIdpLogin(mockIdpConfig(), {}, BASE, 'STAGING', {
      ...surfacesWith(fakeBrowser({ visible: ['#home'] })),
      idp: fakeIdp({ delivery: 'FORM_POST', url: `${BASE}/saml/acs` }).surface,
    });

    expect(result.failure?.kind).toBe('UNAVAILABLE');
    expect(result.message).toMatch(/cannot post a form/);
  });

  it('blames the trust configuration when the application rejects the assertion', async () => {
    const result = await performMockIdpLogin(mockIdpConfig(), {}, BASE, 'STAGING', {
      ...surfacesWith(
        fakeBrowser({
          visible: ['#home'],
          navigate: { [`${BASE}/sso/callback?code=minted`]: { status: 403 } },
        }),
      ),
      idp: fakeIdp().surface,
    });

    expect(result.failure?.kind).toBe('REJECTED');
    expect(result.failure?.step).toBe('ASSERTION');
    expect(result.message).toMatch(/configured to trust the issuer/);
  });

  it('reports UNAVAILABLE with no issuer surface', async () => {
    const result = await performMockIdpLogin(mockIdpConfig(), {}, BASE, 'STAGING', surfacesWith(fakeBrowser()));
    expect(result.failure?.kind).toBe('UNAVAILABLE');
    expect(result.failure?.unavailable?.missing).toEqual(['MOCK_IDP_ISSUER']);
  });
});

// ─── A confirmed login that captured nothing ─────────────────────────────────

describe('capturing the session', () => {
  it('refuses to call an empty storage state a session', async () => {
    /*
     * THE SUBTLE ONE. The success locator appeared, so the login worked — and
     * the browser holds nothing. Returning ok:true hands an anonymous context to
     * a test that asked for a role, and the crawl behind the wall then reports
     * an application with nothing in it. That is rule 10 arrived at by being one
     * step too generous.
     */
    const result = await performFormLogin(
      formConfig(),
      { u: 'ada', p: 'hunter22' },
      BASE,
      surfacesWith(fakeBrowser({ visible: ['#home'], storageState: { cookies: [], origins: [] } })),
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe('NOT_CAPTURED');
    expect(result.failure?.step).toBe('CAPTURE');
    expect(result.failure?.fault).toBe('UNDETERMINED');
    expect(result.message).toMatch(/would crawl this environment anonymously/);
  });

  it('accepts origin storage with no cookies', async () => {
    // A token-in-localStorage application has no cookies and is still logged in.
    const result = await performFormLogin(
      formConfig(),
      { u: 'ada', p: 'hunter22' },
      BASE,
      surfacesWith(
        fakeBrowser({
          visible: ['#home'],
          storageState: { cookies: [], origins: [{ origin: BASE }] },
        }),
      ),
    );

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/0 cookie\(s\), 1 origin\(s\)/);
  });

  it('says the login worked when only the capture failed', async () => {
    const result = await performFormLogin(
      formConfig(),
      { u: 'ada', p: 'hunter22' },
      BASE,
      surfacesWith(
        fakeBrowser({
          visible: ['#home'],
          storageState: async () => {
            throw new Error('context was closed');
          },
        }),
      ),
    );

    expect(result.failure?.kind).toBe('NOT_CAPTURED');
    expect(result.message).toMatch(/this is not a credential problem/);
  });
});

// ─── Secrets never come back out ─────────────────────────────────────────────

describe('nothing a login touches gets into the result', () => {
  it('masks a page title that echoes a credential', async () => {
    /*
     * The chokepoint, not the convention. Nothing in login.ts deliberately puts
     * a secret in a message; this is the line that catches the time somebody
     * does, and an application that renders the submitted email in its title is
     * ordinary.
     */
    const result = await performFormLogin(
      formConfig(),
      { u: 'ada@example.com', p: 'correct-horse' },
      BASE,
      surfacesWith(fakeBrowser({ title: 'Welcome back ada@example.com — correct-horse' })),
    );

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('ada@example.com');
    expect(result.message).not.toContain('correct-horse');
    expect(result.message).toContain(SECRET_MASK);
  });

  it('masks a driver error that quotes what was typed', async () => {
    const browser = fakeBrowser({ broken: ['#password'], title: 'Sign in' });
    browser.fill = async (selector, value) => {
      throw new Error(`could not set ${selector} to "${value}"`);
    };
    const result = await performFormLogin(
      formConfig(),
      { u: 'ada@example.com', p: 'correct-horse' },
      BASE,
      surfacesWith(browser),
    );

    expect(result.failure?.kind).toBe('DRIVER_ERROR');
    expect(result.message).not.toContain('ada@example.com');
  });
});

// ─── Dispatch ────────────────────────────────────────────────────────────────

describe('signInWithProfile', () => {
  it('refuses on policy before looking at capability or config', async () => {
    /*
     * The ORDER is the assertion. A MOCK_IDP profile on production must be
     * refused whatever its config says and whatever adapters are missing: each
     * of the later checks would otherwise answer a question that should never
     * have been asked.
     */
    const result = await signInWithProfile(
      { id: 'p1', name: 'prod sso', kind: 'MOCK_IDP', config: {} },
      {},
      { environmentKind: 'PRODUCTION', baseUrl: BASE },
    );

    expect(result.failure?.kind).toBe('REFUSED_BY_POLICY');
    expect(result.failure?.step).toBe('POLICY');
  });

  it('reports a missing adapter before complaining about the config', async () => {
    // An UNAVAILABLE kind tells the customer nothing about their application,
    // so sending them to fix a config first wastes the trip.
    const result = await signInWithProfile(
      { id: 'p1', name: 'passkeys', kind: 'PASSKEY', config: {} },
      {},
      { environmentKind: 'STAGING', baseUrl: BASE },
    );

    expect(result.failure?.kind).toBe('UNAVAILABLE');
    expect(result.failure?.step).toBe('CAPABILITY');
  });

  it('drives a form login through the injected surface', async () => {
    const browser = fakeBrowser({ visible: ['#home'] });
    const result = await signInWithProfile(
      { id: 'p1', name: 'ada', kind: 'FORM_LOGIN', config: formConfig() },
      { u: 'ada', p: 'hunter22' },
      { environmentKind: 'STAGING', baseUrl: BASE, surfaces: surfacesWith(browser) },
    );

    expect(result.ok).toBe(true);
    expect(browser.clicks).toEqual(['#submit']);
  });

  it('tells a TOTP profile that carries only the authenticator half', async () => {
    /*
     * THE STORED-SHAPE GAP, reported rather than papered over. The TOTP_MFA
     * config schema holds three fields and no first factor, and the POST route
     * stores `parsed.data`, so zod's `$strip` drops any form fields a client
     * sends. The profile genuinely does not describe a drivable login, and
     * MISCONFIGURED is the truth. It is not a failed login and not an empty app.
     */
    const result = await signInWithProfile(
      {
        id: 'p1',
        name: 'ada mfa',
        kind: 'TOTP_MFA',
        config: { seedSecretName: 'seed', codeSelector: '#code', submitSelector: '#submit' },
      },
      { seed: RFC_SEED },
      { environmentKind: 'STAGING', baseUrl: BASE, surfaces: surfacesWith(fakeBrowser()) },
    );

    expect(result.failure?.kind).toBe('MISCONFIGURED');
    expect(result.message).toMatch(/authenticator half and not the password half/);
    expect(result.message).toMatch(/loginUrl/);
  });

  it('composes both stored schemas when the profile carries the whole form', async () => {
    const browser = fakeBrowser({ visible: ['#code', '#home'] });
    const result = await signInWithProfile(
      {
        id: 'p1',
        name: 'ada mfa',
        kind: 'TOTP_MFA',
        config: { ...formConfig(), seedSecretName: 'seed', codeSelector: '#code' },
      },
      { u: 'ada', p: 'hunter22', seed: RFC_SEED },
      {
        environmentKind: 'STAGING',
        baseUrl: BASE,
        surfaces: surfacesWith(browser, { now: () => 0 }),
      },
    );

    expect(result.ok).toBe(true);
    expect(browser.filled['#username']).toEqual(['ada']);
    expect(browser.filled['#code']).toEqual([totpAt(RFC_SEED, 0).code]);
  });

  it('does not open a browser for a kind that needs none', async () => {
    // Cookie injection is the one kind designed for a machine with no browser
    // at all, and it must not report unavailable on exactly that machine.
    const open = vi.fn(async () => fakeBrowser());
    const result = await signInWithProfile(
      {
        id: 'p1',
        name: 'pasted',
        kind: 'COOKIE_INJECTION',
        config: { cookiesSecretName: 'c', domain: 'app.example.com' },
      },
      { c: '[{"name":"sid","value":"x"}]' },
      { environmentKind: 'STAGING', baseUrl: BASE, surfaces: { browser: open } },
    );

    expect(result.ok).toBe(true);
    expect(result.confirmedBy).toBe('NOT_APPLICABLE');
    expect(open).not.toHaveBeenCalled();
  });
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function formConfig() {
  return {
    loginUrl: '/login',
    usernameSelector: '#username',
    passwordSelector: '#password',
    submitSelector: '#submit',
    usernameSecretName: 'u',
    passwordSecretName: 'p',
    successSelector: '#home',
  };
}

function totpConfig() {
  return { ...formConfig(), seedSecretName: 'seed', codeSelector: '#code' };
}

function magicConfig() {
  return {
    requestUrl: '/magic',
    emailSelector: '#email',
    submitSelector: '#send',
    mailbox: 'catcher@qaai.test',
    linkPattern: 'https?://\\S+',
  };
}

function passkeyConfig() {
  return {
    loginUrl: '/login',
    usernameSelector: '#username',
    usernameSecretName: undefined as string | undefined,
    submitSelector: '#passkey',
    successSelector: '#home',
    authenticator: {
      rpId: 'app.example.com',
      protocol: 'ctap2' as const,
      transport: 'internal' as const,
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  };
}

function otpConfig() {
  return {
    loginUrl: '/login',
    phoneSelector: '#phone',
    phoneSecretName: 'phone',
    requestSelector: '#request',
    codeSelector: '#code',
    submitSelector: '#verify',
    successSelector: '#home',
    sink: { kind: 'APPLICATION_ENDPOINT', url: `${BASE}/test/last-code` },
    codePattern: '\\b(\\d{4,8})\\b',
    timeoutSeconds: 30,
  };
}

function mockIdpConfig() {
  return {
    issuer: 'https://idp.test.internal',
    protocol: 'SAML' as const,
    startUrl: '/sso/start',
    successSelector: '#home',
    subject: 'ada@example.com',
    claims: { groups: ['admin'] },
    signingKeySecretName: 'idp-key',
    lifetimeSeconds: 300,
  };
}

function mailbox(messages: readonly MailboxMessage[]) {
  return {
    poll: async ({ sinceMs }: { mailbox: string; sinceMs: number }) =>
      messages.filter((message) => message.receivedAtMs >= sinceMs),
  };
}

function otpSink(deliveries: readonly OtpDelivery[]) {
  return {
    poll: async ({ sinceMs }: { sink: unknown; sinceMs: number }) =>
      deliveries.filter((delivery) => delivery.receivedAtMs >= sinceMs),
  };
}

// ─── The origin of a login, and the credential that followed it ──────────────

/**
 * THE DEFECT THESE COVER: a profile's `loginUrl` was navigated to WHEREVER it
 * pointed, and the vault username and password were typed into whatever loaded.
 *
 * `absoluteUrl` returns an absolute `https://…` unchanged, nothing checked the
 * host, and the success locator was whatever that page chose to render — so the
 * result was `ok: true`. These tests pin the refusal, the step it is reported
 * at, and the two things a refusal must NOT do: open a browser, or read a
 * secret out of the vault.
 */
describe('a login is driven only on the application under test', () => {
  const FOREIGN = 'https://attacker.example';

  it('refuses a form login whose loginUrl is another origin, before typing anything', async () => {
    const browser = fakeBrowser({ visible: ['#home'] });
    const result = await performFormLogin(
      { ...formConfig(), loginUrl: `${FOREIGN}/harvest` },
      { u: 'victim@example.com', p: 'the-password' },
      BASE,
      surfacesWith(browser),
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe('REFUSED_BY_POLICY');
    expect(result.failure?.step).toBe('POLICY');
    // The two facts that make this a seal rather than a message: nothing was
    // loaded and nothing was filled.
    expect(browser.visited).toEqual([]);
    expect(browser.filled).toEqual({});
    expect(result.storageState).toBeNull();
  });

  it('names the foreign ORIGIN and not the URL, which carries a tenant hint', async () => {
    const result = await performFormLogin(
      { ...formConfig(), loginUrl: `${FOREIGN}/harvest?tenant=acme&return=/admin` },
      { u: 'u', p: 'p' },
      BASE,
      surfacesWith(fakeBrowser()),
    );

    expect(result.message).toContain(FOREIGN);
    expect(result.message).not.toContain('tenant=acme');
    expect(result.message).not.toContain('/harvest');
  });

  it('says nothing was learned about the surface behind the wall', async () => {
    const result = await performFormLogin(
      { ...formConfig(), loginUrl: `${FOREIGN}/harvest` },
      { u: 'u', p: 'p' },
      BASE,
      surfacesWith(fakeBrowser()),
    );

    // Rule 10: a login we refused to attempt is not an application with
    // nothing in it.
    expect(result.message).toMatch(/nothing is known about the surface/i);
  });

  it.each([
    [
      'magic link requestUrl',
      () =>
        performMagicLinkLogin(
          { ...magicConfig(), requestUrl: `${FOREIGN}/magic` },
          {},
          BASE,
          { ...surfacesWith(fakeBrowser()), mailbox: mailbox([]) },
        ),
    ],
    [
      'phone OTP loginUrl',
      () =>
        performPhoneOtpLogin({ ...otpConfig(), loginUrl: `${FOREIGN}/login` }, { phone: '+1' }, BASE, {
          ...surfacesWith(fakeBrowser()),
          otpSink: otpSink([]),
        }),
    ],
    [
      'passkey loginUrl',
      () =>
        performPasskeyLogin({ ...passkeyConfig(), loginUrl: `${FOREIGN}/login` }, {}, BASE, {
          ...surfacesWith(fakeBrowser()),
          webAuthn: () => ({
            add: async () => ({ authenticatorId: 'a1' }),
            remove: async () => {},
          }),
        }),
    ],
  ])('refuses a foreign %s too', async (_label, run) => {
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe('REFUSED_BY_POLICY');
    expect(result.failure?.step).toBe('POLICY');
  });

  /*
   * The MOCK_IDP case is the one its own doc comment promised was impossible.
   * An absolute `startUrl` put the browser on a real provider's sign-in page on
   * the first navigation, which is the single thing that function claims it
   * cannot do.
   */
  it('refuses a MOCK_IDP startUrl on a real provider, and never opens it', async () => {
    const browser = fakeBrowser({ visible: ['#home'] });
    const minted: MockIdpMintRequest[] = [];
    const result = await performMockIdpLogin(
      { ...mockIdpConfig(), startUrl: 'https://accounts.google.com/o/oauth2/v2/auth' },
      {},
      BASE,
      'STAGING',
      {
        ...surfacesWith(browser),
        idp: {
          mint: async (request) => {
            minted.push(request);
            return { delivery: 'REDIRECT', url: `${BASE}/acs` } satisfies MintedAssertion;
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe('REFUSED_BY_POLICY');
    expect(browser.visited).toEqual([]);
    // Nothing was minted either: no assertion exists for a flow we did not start.
    expect(minted).toEqual([]);
  });

  it('allows an origin the customer declared, which is the documented remedy', async () => {
    const browser = fakeBrowser({ visible: ['#home'] });
    const result = await performFormLogin(
      { ...formConfig(), loginUrl: 'https://auth.example.com/login' },
      { u: 'u', p: 'p' },
      BASE,
      surfacesWith(browser),
      ['https://auth.example.com'],
    );

    expect(result.ok).toBe(true);
    expect(browser.visited).toEqual(['https://auth.example.com/login']);
  });

  it('compares declared origins as origins, so a suffix is not a match', async () => {
    const browser = fakeBrowser({ visible: ['#home'] });
    const result = await performFormLogin(
      // Ends with the base host and is a different site entirely.
      { ...formConfig(), loginUrl: 'https://app.example.com.evil.net/login' },
      { u: 'u', p: 'p' },
      BASE,
      surfacesWith(browser),
      ['https://auth.example.com'],
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe('REFUSED_BY_POLICY');
    expect(browser.visited).toEqual([]);
  });

  it('still drives a relative loginUrl, which is what every profile uses', async () => {
    const browser = fakeBrowser({ visible: ['#home'] });
    const result = await performFormLogin(formConfig(), { u: 'u', p: 'p' }, BASE, surfacesWith(browser));

    expect(result.ok).toBe(true);
    expect(browser.visited).toEqual([`${BASE}/login`]);
  });

  it('passes the environment\'s declared origins through signInWithProfile', async () => {
    const browser = fakeBrowser({ visible: ['#home'] });
    const result = await signInWithProfile(
      {
        id: 'p1',
        name: 'cross-origin SSO',
        kind: 'FORM_LOGIN',
        config: { ...formConfig(), loginUrl: 'https://auth.example.com/login' },
      },
      { u: 'u', p: 'p' },
      {
        environmentKind: 'STAGING',
        baseUrl: BASE,
        surfaces: surfacesWith(browser),
        additionalOrigins: ['https://auth.example.com'],
      },
    );

    expect(result.ok).toBe(true);
    expect(browser.visited).toEqual(['https://auth.example.com/login']);
  });
});

// ─── A seed that decodes to no key at all ────────────────────────────────────

/**
 * THE DEFECT THIS COVERS: `decodeBase32` checked the length of the STRING and
 * not of the KEY. A one-character seed is legal base32 carrying five bits —
 * fewer than one byte — so the decode loop pushed nothing, `createHmac`
 * accepted the empty key, and `hotp` returned a plausible six-digit code
 * computed from no secret. Every such code is wrong, so the login is REJECTED
 * with fault OURS and the message "the credentials are wrong", which sends the
 * customer to audit their application's MFA over a truncated paste.
 */
describe('a truncated TOTP seed is configuration, not a wrong password', () => {
  it.each(['A', 'a', 'A=', ' A ', 'A-'])('refuses %o, which carries fewer than 8 bits', (seed) => {
    expect(() => decodeBase32(seed)).toThrow(/too short|truncated/i);
  });

  it('still decodes the shortest seed that IS a byte', () => {
    // Two base32 characters carry ten bits, so one whole byte comes out.
    expect(decodeBase32('AA')).toHaveLength(1);
  });

  it('reports a truncated seed as MISCONFIGURED, never as a rejected credential', async () => {
    const browser = fakeBrowser({ visible: ['#code', '#home'] });
    const result = await performTotpMfaLogin(
      totpConfig(),
      { u: 'u', p: 'p', seed: 'A' },
      BASE,
      surfacesWith(browser),
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe('MISCONFIGURED');
    expect(result.failure?.step).toBe('CONFIG');
    expect(LOGIN_FAILURE_FAULT[result.failure!.kind]).toBe('OURS');
    // Names the field to fix, and does not put the seed in the message.
    expect(result.message).toContain('seed');
    expect(result.message).not.toContain('A=');
    // No code was ever typed from an empty key.
    expect(browser.filled['#code']).toBeUndefined();
  });
});

// ─── Two claims that had no biting test ──────────────────────────────────────

/**
 * Both of these were found by mutation, not by reading.
 *
 * `pollSink`'s doc comment says `sinceMs` is "passed through to the sink AND
 * re-checked here". Deleting the re-check broke NO test in this file: the test
 * that reads as though it covers it uses a sink which stamps every message AT
 * `sinceMs`, so the comparison is never false and the `consumed` set is what
 * actually refuses the replay. The genuinely uncovered case is the one the
 * comment describes — somebody else's catcher, holding a message from BEFORE
 * this attempt that has never been consumed.
 */
describe('the sink filter is re-checked in this module, not just delegated', () => {
  it('ignores a stale message a non-filtering sink offers from before the request', async () => {
    const stale = `${BASE}/auth/callback?token=left-by-the-last-crawl`;
    const browser = fakeBrowser();
    const clock = fakeClock(600_000);
    const result = await performMagicLinkLogin(magicConfig(), {}, BASE, {
      ...surfacesWith(browser, { now: clock.now, sleep: clock.sleep }),
      /*
       * Ignores `sinceMs` completely AND reports an instant long before this
       * attempt — the combination neither existing test produces. `consumed`
       * is empty on attempt 1, so the in-module re-check is the only thing
       * that can refuse this link.
       */
      mailbox: { poll: async () => [{ id: 'stale-1', receivedAtMs: 1_000, text: `Sign in: ${stale}` }] },
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe('TIMED_OUT');
    // The whole point: a spent link from a previous run was never followed.
    expect(browser.visited).not.toContain(stale);
  });

  it('ignores a stale OTP a non-filtering sink offers from before the request', async () => {
    const browser = fakeBrowser({ visible: ['#code'] });
    const clock = fakeClock(600_000);
    const result = await performPhoneOtpLogin(otpConfig(), { phone: '+15550000000' }, BASE, {
      ...surfacesWith(browser, { now: clock.now, sleep: clock.sleep }),
      otpSink: { poll: async () => [{ id: 'old-1', receivedAtMs: 1_000, text: 'Your code is 428913' }] },
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe('TIMED_OUT');
    // A stale code is single-use and already dead; typing it would be reported
    // as our credentials being wrong.
    expect(browser.filled['#code']).toBeUndefined();
  });
});

/**
 * The fault column is the file's central claim — "reporting ours as theirs is
 * the most expensive lie this file could tell" — and flipping any entry of it
 * broke no test. The `Record` type enforces that every failure HAS a fault; it
 * cannot enforce that the fault is the right one.
 */
describe('whose problem each login failure is', () => {
  it('attributes every failure exactly as the report contract promises', () => {
    expect(LOGIN_FAILURE_FAULT).toEqual({
      // Ours: we were handed something we could not drive.
      MISCONFIGURED: 'OURS',
      MISSING_SECRET: 'OURS',
      REFUSED_BY_POLICY: 'OURS',
      REJECTED: 'OURS',
      DRIVER_ERROR: 'OURS',
      // Theirs: a bot defence in front of the form is the environment owner's.
      BLOCKED: 'THEIRS',
      // Undetermined: nothing was attempted, or nobody can tell from here.
      UNAVAILABLE: 'UNDETERMINED',
      TIMED_OUT: 'UNDETERMINED',
      NOT_CAPTURED: 'UNDETERMINED',
    });
  });

  it('never attributes a failure to the customer by default', () => {
    // Only BLOCKED is THEIRS. Any new failure kind defaulting to THEIRS would
    // have a customer auditing an application that behaved correctly.
    const theirs = LOGIN_FAILURES.filter((kind) => LOGIN_FAILURE_FAULT[kind] === 'THEIRS');
    expect(theirs).toEqual(['BLOCKED']);
  });
});
