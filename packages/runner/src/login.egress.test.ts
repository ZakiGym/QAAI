import { describe, expect, it } from 'vitest';
import { guardUrl, resolveEgressPolicy } from '@qaai/shared';
import { classifyAddress, classifyHost } from '@qaai/shared/private-address';
import {
  LOGIN_EGRESS_REFUSAL,
  guardLoginBrowser,
  performFormLogin,
  planLoginLaunch,
  signInWithProfile,
} from './login.js';
import type {
  LoginBrowser,
  LoginBrowserLaunch,
  LoginEgressGuard,
  LoginHostApproval,
  LoginNavigation,
} from './login.js';

/**
 * THE FORM_LOGIN DEFECT, AND THE THREE THINGS THAT HAD TO BECOME TRUE.
 *
 * The recorded defect: a MEMBER's FORM_LOGIN profile drives a browser to any
 * URL and types the environment's VAULT PLAINTEXT into whatever answers, then
 * echoes the page title back. From inside the API container that reaches
 * `169.254.169.254` and every internal service on the network.
 *
 * `ownOriginUrl` had already closed one half before this round: a `loginUrl`
 * naming another ORIGIN is refused with the customer's own `additionalOrigins`
 * as the remedy. Three things were still true and all three are tested here:
 *
 *   1. NOTHING CLASSIFIED THE HOST. `http://169.254.169.254/` is its own
 *      origin, so the same-origin check passed it unchanged. Reproduced at HEAD
 *      37498c1: `grep -nE 'classifyHost|resolvesPublicly|egress' login.ts`
 *      returned NOTHING.
 *   2. THE CHECK WAS ON THE CONFIGURED URL, NOT ON THE PAGE BEING TYPED INTO.
 *      A redirect after an approved navigation landed somewhere else and the
 *      next line typed a password into it.
 *   3. THE PAGE TITLE CAME BACK, which is a read primitive against the
 *      internal network dressed up as a debugging aid.
 *   4. THE NAME WAS RESOLVED TWICE AND ONLY ONCE BY US. Added 2026-10-30 after
 *      an adversary drove it: the guard resolved `app.example.com`, pinned
 *      `93.184.216.34`, classified it `public` and returned `{ ok: true }` with
 *      the pin DISCARDED — `LoginEgressGuard` had no field it could occupy.
 *      Chromium then resolved the same name inside its own network service and
 *      got `169.254.169.254`. The URL-bar host never changed, so (2) saw
 *      nothing wrong, and BOTH vault secrets were typed into the link-local
 *      host. Section 4 below is that probe, kept.
 *
 * NO NETWORK AND NO DNS. Two kinds of fixture, and the difference matters:
 *
 *   - The GUARD is the real `guardUrl`, the real policy and the real
 *     classifiers, over an INJECTED resolver ({@link loginGuardAnswering}). A
 *     fixture that answered yes or no by itself could not have caught (4),
 *     because the thing that was dropped was the real permit's pinned address —
 *     a fake with no permit makes deleting the pin undetectable, which is rule
 *     9 one layer down.
 *   - The BROWSER is a fake that does ITS OWN resolution and honours
 *     `--host-resolver-rules` the way Chromium does ({@link rebindingBrowser}),
 *     because the launch argument is the only seam that reaches a real
 *     Chromium's resolver and a test cannot launch one without a network.
 *
 * `classifyHost` and `classifyAddress` are pure; the `node:dns` its module
 * imports is never called, here or by `guardUrl`, which takes `lookup` as part
 * of its injected io.
 */

// ─── Fixtures ───────────────────────────────────────────────────────────────

/**
 * A documentation address that classifies `public`, so the HOSTED policy
 * (public only) allows it. Used as the answer a name gets when this fixture
 * means "this host is fine".
 */
const PUBLIC_ANSWER = '93.184.216.34';

/**
 * THE SECOND ANSWER. What the adversary's resolver tells the BROWSER, after
 * telling the guard {@link PUBLIC_ANSWER}. The instance metadata service.
 */
const REBOUND_ANSWER = '169.254.169.254';

interface Recorder {
  /** The factory a `LoginSurfaces` takes. Records the launch argument. */
  readonly open: (launch: LoginBrowserLaunch) => Promise<LoginBrowser>;
  readonly browser: LoginBrowser;
  readonly launched: LoginBrowserLaunch[];
  readonly filled: { selector: string; value: string }[];
  readonly navigated: string[];
}

/**
 * A browser that records what it was asked to do, and can be told it is on a
 * different host than the one it was sent to — which is the redirect case.
 *
 * It IGNORES the launch argument, deliberately: these are the tests about
 * classification and about the live host at the moment of typing, and a fake
 * that re-implemented Chromium's resolver would only make them harder to read.
 * {@link rebindingBrowser} is the one that honours it, and section 4 is where
 * that matters. What this one does record is `launched`, so a test can assert
 * WHAT the browser was launched with without simulating it.
 */
function recordingBrowser(landsOn?: string): Recorder {
  const filled: { selector: string; value: string }[] = [];
  const navigated: string[] = [];
  const launched: LoginBrowserLaunch[] = [];
  let current = 'https://app.example.com/login';
  const browser: LoginBrowser = {
    url: () => current,
    goto: async (url): Promise<LoginNavigation> => {
      navigated.push(url);
      current = landsOn ?? url;
      return { ok: true, url: current, status: 200, error: null };
    },
    fill: async (selector, value) => {
      filled.push({ selector, value });
      return true;
    },
    click: async () => true,
    waitFor: async () => true,
    title: async () => 'Grafana — Internal Metrics',
    storageState: async () => ({ cookies: [{ name: 'session' }], origins: [] }),
    close: async () => {},
  };
  return {
    filled,
    navigated,
    launched,
    browser,
    open: async (launch) => {
      launched.push(launch);
      return browser;
    },
  };
}

/**
 * THE REAL GUARD, OVER AN INJECTED RESOLVER.
 *
 * `guardUrl`, `resolveEgressPolicy`, `classifyHost` and `classifyAddress` are
 * the production ones; only `lookup`, the clock and the delay are fakes. So the
 * permit these tests receive is the permit production receives, pinned address
 * and all — which is the whole reason the dropped pin was invisible before: a
 * fixture that answered `{ ok: true }` by itself had nothing to drop.
 *
 * A name this fixture was not told about answers {@link REBOUND_ANSWER}, which
 * is link-local, so "not allowed" is decided by the real HOSTED policy rather
 * than by an `includes` in a fixture.
 *
 * `resolveEgressPolicy(undefined)` is the HOSTED policy — PUBLIC ONLY — because
 * an absent policy must be the strictest reading and not an open one.
 */
function loginGuardAnswering(
  answers: Readonly<Record<string, string>>,
  policy: unknown = undefined,
): LoginEgressGuard {
  const resolved = resolveEgressPolicy(policy);
  const io = {
    classifyHost,
    classifyAddress,
    lookup: async (host: string) => [{ address: answers[host] ?? REBOUND_ANSWER }],
    now: () => new Date('2026-10-30T00:00:00.000Z'),
    monotonicMs: () => 0,
    delay: async () => {},
  };
  return async (url) => {
    const verdict = await guardUrl({ url, context: 'LOGIN', policy: resolved, io });
    return verdict.ok ? { ok: true, permit: verdict.permit } : { ok: false, permit: null };
  };
}

const refuseAll: LoginEgressGuard = async () => ({ ok: false, permit: null });

/** The real guard, told that each of these hosts resolves to a public address. */
function guardAllowing(...hosts: readonly string[]): LoginEgressGuard {
  return loginGuardAnswering(Object.fromEntries(hosts.map((host) => [host, PUBLIC_ANSWER])));
}

/**
 * WHAT CHROMIUM DOES WITH `--host-resolver-rules`, as much of it as this fake
 * needs: the first `MAP <pattern> <target>` whose pattern is the host wins, and
 * a host with NO rule is resolved normally.
 *
 * It THROWS on a rule form it does not implement. A fake that silently ignored
 * a rule it did not understand would make deleting that rule undetectable,
 * which is the defect pattern rule 9 names for Prisma `select` — the same
 * mistake with a different fake.
 */
function chromiumResolve(rules: string, hostname: string): string | null {
  /*
   * THE NAME, NOT `host:port`. Chromium matches a rule against the name it is
   * about to RESOLVE, and the port is the socket's business — a fake that
   * compared `app.example.com:8443` against the pattern `app.example.com`
   * would report no rule for a host that is in fact pinned, and would have
   * made this suite pass for the wrong reason on any non-default port.
   */
  // '' is NO ARGUMENT AT ALL, which is not the same as an empty rule set. The
  // browser then resolves every name itself.
  if (rules === '') return null;
  for (const rule of rules.split(',')) {
    const parts = rule.trim().split(/\s+/);
    const [verb, pattern, target] = parts;
    if (parts.length !== 3 || verb !== 'MAP' || pattern === undefined || target === undefined) {
      throw new Error(
        `this fake implements "MAP <host> <target>" only, not ${JSON.stringify(rule)}`,
      );
    }
    if (pattern.toLowerCase() === hostname) return target;
  }
  return null;
}

/**
 * A BROWSER THAT RESOLVES THE NAME ITSELF — the half nothing guarded.
 *
 * This is the adversary's probe as a fixture. The guard is told one address and
 * this browser is told another, for the SAME name, and the URL-bar host never
 * changes — so nothing about the page looks wrong. `filledAt` records the
 * ADDRESS each secret was typed at, which is the only place the difference
 * shows, and is the assertion the previous thirteen tests could not make
 * because nothing in this file held an address at all.
 *
 * It honours `--host-resolver-rules`, so the launch argument is what decides
 * which of the two answers wins. `~NOTFOUND` fails the navigation the way
 * Chromium does.
 */
function rebindingBrowser(browserAnswer: string) {
  const filledAt: { selector: string; value: string; address: string }[] = [];
  const launched: LoginBrowserLaunch[] = [];
  let at = 'https://app.example.com/login';
  let connected: string | null = null;
  return {
    filledAt,
    launched,
    open: async (launch: LoginBrowserLaunch): Promise<LoginBrowser> => {
      launched.push(launch);
      return {
        url: () => at,
        goto: async (url): Promise<LoginNavigation> => {
          const mapped = chromiumResolve(
            launch.hostResolverRules,
            new URL(url).hostname.toLowerCase(),
          );
          if (mapped === '~NOTFOUND') {
            // The name does not resolve, so the connection does not happen.
            connected = null;
            return { ok: false, url, status: null, error: 'net::ERR_NAME_NOT_RESOLVED' };
          }
          // THE SECOND RESOLUTION. With no rule for this host the browser
          // answers for itself, which is what the pin exists to prevent.
          connected = mapped ?? browserAnswer;
          at = url;
          return { ok: true, url: at, status: 200, error: null };
        },
        fill: async (selector, value) => {
          filledAt.push({ selector, value, address: connected ?? 'NEVER_CONNECTED' });
          return true;
        },
        click: async () => true,
        waitFor: async () => true,
        title: async () => 'EC2 Instance Metadata',
        storageState: async () => ({ cookies: [{ name: 'session' }], origins: [] }),
        close: async () => {},
      };
    },
  };
}

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

const VAULT = { u: 'ada@example.com', p: 'correct-horse-battery' };

// ─── 1. The host is classified and refused under policy ────────────────────

describe('1. the host is classified and refused under policy', () => {
  it('REFUSES THE IMDS ADDRESS, which is its own origin and so passed the origin check', async () => {
    /*
     * THE WHOLE POINT. `ownOriginUrl` compares origins, and
     * `http://169.254.169.254/` IS the origin of a base URL set to it — so the
     * pre-existing check passes it and only classification refuses it.
     */
    const rec = recordingBrowser();
    const result = await performFormLogin(formConfig(), VAULT, 'http://169.254.169.254/', {
      browser: rec.open,
      egress: guardAllowing('app.example.com'),
    });

    expect(result.ok).toBe(false);
    /*
     * NOT ONE BYTE. The REAL browser is never asked to navigate — the
     * decorator refuses before it delegates, so `navigated` is empty rather
     * than carrying the refused URL. An earlier draft of this test asserted
     * the refused URL WAS recorded, which contradicted the comment above it;
     * the empty array is both the correct expectation and the stronger one.
     */
    expect(rec.navigated).toEqual([]);
    expect(rec.filled).toEqual([]);
    expect(result.message).toContain('Refused by this environment’s egress policy');
  });

  it('refuses a loopback base URL the same way', async () => {
    const rec = recordingBrowser();
    const result = await performFormLogin(formConfig(), VAULT, 'http://127.0.0.1:8080/', {
      browser: rec.open,
      egress: guardAllowing('app.example.com'),
    });

    expect(result.ok).toBe(false);
    expect(rec.filled).toEqual([]);
  });

  it('FAILS CLOSED when the guard itself THROWS', async () => {
    // A guard that throws is a refusal. A login that read an exception as
    // permission would be unguarded for exactly as long as something was
    // broken, which is when it matters most.
    const rec = recordingBrowser();
    const result = await performFormLogin(formConfig(), VAULT, 'https://app.example.com/', {
      browser: rec.open,
      egress: async () => {
        throw new Error('the resolver fell over');
      },
    });

    expect(result.ok).toBe(false);
    /*
     * `navigated` AND `filled`, and the first one is the assertion mutation
     * testing added. An earlier draft checked only `filled`, and reverting the
     * fail-closed `catch` to `return true` turned NO test red — because the
     * browser navigated to the host (the SSRF) and the `fill` check then
     * refused the credential anyway, so `filled` was still empty. The
     * connection is the thing being refused, so the connection is what the
     * test has to look at.
     */
    expect(rec.navigated).toEqual([]);
    expect(rec.filled).toEqual([]);
  });

  it('REFUSES EVERYTHING when no guard was supplied at all', async () => {
    /*
     * The fail-closed fallback. A `LoginSurfaces` built by hand with no
     * `egress` gets `REFUSE_ALL_EGRESS`, not a permissive one — so the symptom
     * of forgetting the control is every login refusing, which somebody notices
     * in a minute, rather than every login running unguarded, which nobody
     * notices at all.
     */
    const rec = recordingBrowser();
    const result = await performFormLogin(formConfig(), VAULT, 'https://app.example.com/', {
      browser: rec.open,
    });

    expect(result.ok).toBe(false);
    expect(rec.filled).toEqual([]);
  });

  it('allows the application under test, so the control is not just "no"', async () => {
    // A control that refuses everything is not a control, it is an outage.
    const rec = recordingBrowser();
    const result = await performFormLogin(formConfig(), VAULT, 'https://app.example.com/', {
      browser: rec.open,
      egress: guardAllowing('app.example.com'),
    });

    expect(result.ok).toBe(true);
    expect(rec.filled.map((f) => f.selector)).toEqual(['#username', '#password']);
  });
});

// ─── 2. The plaintext is never typed into an unapproved host ───────────────

describe('2. the vault plaintext is never typed into an unapproved host', () => {
  it('REFUSES TO FILL AFTER A REDIRECT TO AN UNAPPROVED HOST', async () => {
    /*
     * THE SECOND HALF OF THE DEFECT, and the one a pre-navigation check cannot
     * catch. `ownOriginUrl` and the guard both run against the URL we ASKED
     * for. The application then answers with a 302, the browser is somewhere
     * else, and the next line types a password into it.
     *
     * The browser here is told it LANDS ON a host nobody approved, so the
     * navigation is allowed and the fill must not be.
     */
    const rec = recordingBrowser('http://169.254.169.254/latest/meta-data/');
    const result = await performFormLogin(formConfig(), VAULT, 'https://app.example.com/', {
      browser: rec.open,
      egress: guardAllowing('app.example.com'),
    });

    expect(result.ok).toBe(false);
    // THE ASSERTION THAT MATTERS: no secret was typed anywhere.
    expect(rec.filled).toEqual([]);
  });

  it('never lets a secret value reach `fill` on a refused host, checked by VALUE', async () => {
    // Asserted on the VALUE and not just the selector, because the thing that
    // must not leave is the plaintext itself.
    const rec = recordingBrowser('https://evil.example.net/login');
    await performFormLogin(formConfig(), VAULT, 'https://app.example.com/', {
      browser: rec.open,
      egress: guardAllowing('app.example.com'),
    });

    const typed = rec.filled.map((f) => f.value).join(' ');
    expect(typed).not.toContain('correct-horse-battery');
    expect(typed).not.toContain('ada@example.com');
  });

  it('fills when the browser stayed on the host the guard approved', async () => {
    const rec = recordingBrowser('https://app.example.com/login?next=/home');
    const result = await performFormLogin(formConfig(), VAULT, 'https://app.example.com/', {
      browser: rec.open,
      egress: guardAllowing('app.example.com'),
    });

    expect(result.ok).toBe(true);
    expect(rec.filled.map((f) => f.value)).toEqual([
      'ada@example.com',
      'correct-horse-battery',
    ]);
  });

  it('the APPROVAL comes from the guard, never from the URL alone', async () => {
    /*
     * `guardLoginBrowser` writes a host into its record ONLY where the guard
     * answered. A `fill` on a host nothing decided about therefore refuses,
     * even though the browser reports a perfectly ordinary URL — the record is
     * the control, not the shape of the string.
     *
     * The launch map is EMPTY here, which is the case of a browser opened with
     * no pin at all. There is no default for that argument on purpose: a
     * default of "everything is pinned" would be an off switch nobody can see.
     */
    const rec = recordingBrowser();
    const guarded = guardLoginBrowser(
      rec.browser,
      guardAllowing('app.example.com'),
      new Map<string, LoginHostApproval>(),
    );

    const beforeAnyNavigation = await guarded.fill('#password', VAULT.p, 1_000);

    expect(beforeAnyNavigation).toBe(false);
    expect(rec.filled).toEqual([]);
  });
});

// ─── 3. Nothing about the page comes back ──────────────────────────────────

describe('3. nothing about the page is returned', () => {
  it('NEVER RETURNS THE PAGE TITLE, which names what is running inside the network', async () => {
    /*
     * The title here is `Grafana — Internal Metrics`, which is exactly the
     * value of the leak: a deliberately-failed login against an internal host
     * told the attacker what was listening on it. Three failure paths used to
     * append `(page title: "…")`.
     */
    const rec = recordingBrowser();
    const result = await performFormLogin(
      { ...formConfig(), successSelector: '#never-appears' },
      VAULT,
      'https://app.example.com/',
      {
        browser: async () => ({ ...rec.browser, waitFor: async () => false }),
        egress: guardAllowing('app.example.com'),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('Grafana');
    expect(result.message).not.toContain('Internal Metrics');
    expect(result.message).not.toContain('page title');
  });

  it('GIVES ONE SENTENCE FOR EVERY REFUSAL, naming no host, class or reason', async () => {
    /*
     * NOT AN ORACLE. The person who configured the URL is the one reading this
     * message, and for this control that person is the adversary. A refusal
     * that distinguished "link-local" from "did not resolve" from "not on the
     * allowlist" would turn a failed login into a port scanner with a report.
     */
    const rec = recordingBrowser();
    const imds = await performFormLogin(formConfig(), VAULT, 'http://169.254.169.254/', {
      browser: rec.open,
      egress: refuseAll,
    });
    const internal = await performFormLogin(
      formConfig(),
      VAULT,
      'https://nothing.internal.example/',
      { browser: recordingBrowser().open, egress: refuseAll },
    );

    // Byte-identical for two completely different hosts and reasons.
    expect(imds.message).toBe(internal.message);
    expect(imds.message).toContain(LOGIN_EGRESS_REFUSAL);
    expect(imds.message).not.toContain('169.254');
    expect(imds.message).not.toContain('link-local');
    expect(imds.message).not.toContain('internal.example');
  });
});

// ─── The production door ───────────────────────────────────────────────────

describe('signInWithProfile cannot be called unguarded', () => {
  it('BUILDS A REAL GUARD WHEN NONE IS SUPPLIED, and it refuses loopback', async () => {
    /*
     * THE TEST THAT PROVES THE DOOR. No `egress` is passed, so
     * `signInWithProfile` builds the real guard — the real `guardUrl`, the real
     * `classifyHost`, the real `resolveEgressPolicy` — and the only reason this
     * runs without a network is that `127.0.0.1` is an IP LITERAL, which
     * `decideEgress` decides before it ever reaches `io.lookup`.
     *
     * No `egressPolicy` is passed either: `resolveEgressPolicy(undefined)`
     * falls back to the HOSTED policy, PUBLIC ONLY. An absent policy is the
     * STRICTEST reading, not an open one.
     *
     * If this entry point ever stops building a guard, `filled` goes non-empty
     * and this test goes red.
     */
    const rec = recordingBrowser();

    const result = await signInWithProfile(
      { id: 'p1', name: 'ada', kind: 'FORM_LOGIN', config: formConfig() },
      VAULT,
      {
        environmentKind: 'STAGING',
        baseUrl: 'http://127.0.0.1:3000/',
        surfaces: { browser: rec.open },
      },
    );

    expect(result.ok).toBe(false);
    expect(rec.filled).toEqual([]);
  });

  it('AND THE REAL GUARD ALLOWS A PUBLIC HOST, so this is not just refuse-all', async () => {
    /*
     * THE OTHER HALF OF THE PRODUCTION-DOOR TEST, and mutation testing is why
     * it exists. Deleting `?? await defaultLoginEgressGuard(...)` left
     * `surfaces.egress` undefined, `openBrowser` fell back to
     * `REFUSE_ALL_EGRESS`, and the loopback test above STILL PASSED — it could
     * not tell "the real guard refused loopback" from "there is no guard so
     * everything is refused". Both are `ok: false` with nothing filled.
     *
     * So this asserts the opposite direction through the same door: a PUBLIC IP
     * LITERAL is ALLOWED and the credential IS typed. A refuse-all fallback
     * fails this, a missing guard fails this, and only a real guard applying
     * the real HOSTED policy passes both.
     *
     * An IP literal again, so no resolver is consulted: `decideEgress` returns
     * at `verdict.kind === 'address'` before `io.lookup`. `93.184.216.34` is a
     * documentation address and classifies `public`.
     */
    const rec = recordingBrowser('http://93.184.216.34/login');

    const result = await signInWithProfile(
      { id: 'p1', name: 'ada', kind: 'FORM_LOGIN', config: formConfig() },
      VAULT,
      {
        environmentKind: 'STAGING',
        baseUrl: 'http://93.184.216.34/',
        surfaces: { browser: rec.open },
      },
    );

    expect(result.ok).toBe(true);
    expect(rec.filled.map((f) => f.selector)).toEqual(['#username', '#password']);
  });
});

// ─── 4. The browser is pinned to the address the guard classified ──────────

/**
 * THE REBINDING HALF, which is the one the first thirteen tests could not see.
 *
 * All thirteen assert that a host was APPROVED or REFUSED. Not one of them
 * asserts that an ADDRESS was PINNED, and that is exactly the gap the defect
 * lived in: `LoginEgressGuard` returned `{ ok: boolean }`, the comment above
 * the approved-host `Set` called it "the pin cache", and it held no addresses
 * at all. A test that asserts a value's spelling does not assert the value can
 * be stored.
 *
 * So these drive two DNS answers for one name — public to the guard, link-local
 * to the browser — and assert on the ADDRESS each secret was typed at.
 */
describe('4. the login browser is pinned, not merely pointed', () => {
  it('NEVER TYPES A SECRET AT AN ADDRESS THE GUARD DID NOT CLASSIFY', async () => {
    /*
     * THE ADVERSARY'S PROBE, KEPT. Measured on this tree before the fix: the
     * guard answered PINNED for `93.184.216.34`, the browser resolved the same
     * name itself and got `169.254.169.254`, the URL-bar host never changed —
     * so the `fill` host check saw nothing wrong — and both vault secrets were
     * typed into the instance metadata service.
     *
     * The fix is the launch argument, and this test fails the moment it stops
     * being built: with no `--host-resolver-rules` the fake browser resolves
     * for itself, which is what a real Chromium does, and the addresses below
     * become the link-local one.
     */
    const rec = rebindingBrowser(REBOUND_ANSWER);

    const result = await performFormLogin(formConfig(), VAULT, 'https://app.example.com/', {
      browser: rec.open,
      egress: guardAllowing('app.example.com'),
    });

    expect(result.ok).toBe(true);

    // THE PIN WAS DELIVERED. One rule, for the host the guard decided about.
    expect(rec.launched.map((launch) => launch.hostResolverRules)).toEqual([
      `MAP app.example.com ${PUBLIC_ANSWER}`,
    ]);

    /*
     * THE ASSERTION THAT MATTERS, AND IT IS ABOUT THE ADDRESS. Both secrets
     * were typed, and both at the address the guard resolved and classified —
     * never at the one the browser's own resolver offered.
     */
    expect(rec.filledAt.map((f) => f.address)).toEqual([PUBLIC_ANSWER, PUBLIC_ANSWER]);
    for (const typed of rec.filledAt) {
      expect(typed.address).not.toBe(REBOUND_ANSWER);
    }
  });

  it('CARRIES THE PERMIT THROUGH THE PRODUCTION DOOR, so the real guard pins too', async () => {
    /*
     * The other half, and the one a test with an injected guard cannot reach:
     * `defaultLoginEgressGuard` used to end `return { ok: verdict.ok }`, which
     * threw the pin away. An injected guard would not notice.
     *
     * No `egress` is passed, so `signInWithProfile` builds the real one. An IP
     * LITERAL again, so no resolver is consulted: `decideEgress` returns at
     * `verdict.kind === 'address'` before `io.lookup`. `93.184.216.34` is a
     * documentation address and classifies `public`.
     */
    const rec = recordingBrowser('http://93.184.216.34/login');

    const result = await signInWithProfile(
      { id: 'p1', name: 'ada', kind: 'FORM_LOGIN', config: formConfig() },
      VAULT,
      {
        environmentKind: 'STAGING',
        baseUrl: 'http://93.184.216.34/',
        surfaces: { browser: rec.open },
      },
    );

    expect(result.ok).toBe(true);
    expect(rec.launched.map((launch) => launch.hostResolverRules)).toEqual([
      `MAP ${PUBLIC_ANSWER} ${PUBLIC_ANSWER}`,
    ]);
  });

  it('MAPS A REFUSED HOST TO NOTHING rather than leaving it out of the rules', async () => {
    /*
     * An OMITTED host is resolved NORMALLY by the browser, which is the hole
     * this pin closes — so a host this login has already refused must be named
     * in the rules as unresolvable, not simply absent. `goto` is still the gate;
     * the rule is what covers the surfaces `goto` does not see.
     *
     * `packages/agent/src/crawl/egress.ts` refuses an empty address list for the
     * matching reason: `chromiumHostResolverRules` would emit a map to nothing.
     */
    const rec = recordingBrowser();

    const result = await performFormLogin(formConfig(), VAULT, 'http://169.254.169.254/', {
      browser: rec.open,
      egress: guardAllowing('app.example.com'),
    });

    expect(result.ok).toBe(false);
    expect(rec.launched.map((launch) => launch.hostResolverRules)).toEqual([
      'MAP 169.254.169.254 ~NOTFOUND',
    ]);
    expect(rec.navigated).toEqual([]);
    expect(rec.filled).toEqual([]);
  });

  it('REFUSES A PINNED PERMIT THAT AUTHORISED NO ADDRESS', async () => {
    /*
     * A pin that authorises nothing is as dangerous as no pin: both
     * `chromiumHostResolverRules` and `pinnedLookup` answer with nothing for an
     * empty address list, and a resolver that answers nothing falls back to the
     * system one. A success arm that falls through to "unpinned" is the same
     * defect as an exception arm that falls through to "allow".
     *
     * The permit is DERIVED from a real one rather than written out, so it
     * cannot drift from `EgressPermit` — only `pinned.addresses` is emptied.
     */
    const real = await guardAllowing('app.example.com')('https://app.example.com/login');
    const permit = real.permit;
    if (permit == null || permit.kind !== 'PINNED') {
      throw new Error('this fixture needs a real PINNED permit to empty out');
    }
    const authorisedNothing: LoginEgressGuard = async () => ({
      ok: true,
      permit: { ...permit, pinned: { ...permit.pinned, addresses: [] } },
    });

    const rec = rebindingBrowser(REBOUND_ANSWER);
    const result = await performFormLogin(formConfig(), VAULT, 'https://app.example.com/', {
      browser: rec.open,
      egress: authorisedNothing,
    });

    expect(result.ok).toBe(false);
    expect(rec.filledAt).toEqual([]);
    expect(rec.launched.map((launch) => launch.hostResolverRules)).toEqual([
      'MAP app.example.com ~NOTFOUND',
    ]);
    // NOT AN ORACLE: the refusal names no address, and not the rule either.
    expect(result.message).toContain(LOGIN_EGRESS_REFUSAL);
    expect(result.message).not.toContain(PUBLIC_ANSWER);
    expect(result.message).not.toContain('MAP ');
  });

  it('REFUSES THE CREDENTIAL ON A HOST APPROVED ONLY AFTER LAUNCH', async () => {
    /*
     * The pin is a LAUNCH argument, so a host first seen after the browser
     * opened cannot be pinned however the guard answers. The navigation still
     * happens — refusing it would take away a hop that works today, such as a
     * magic link or an SSO assertion POST, and no driver in this file fills on
     * a post-launch host — but the credential does not, because "approved by
     * name, resolved by somebody else" is the whole defect.
     */
    const rec = recordingBrowser();
    const guarded = guardLoginBrowser(
      rec.browser,
      guardAllowing('app.example.com', 'second.example.com'),
      new Map<string, LoginHostApproval>([
        ['app.example.com', { kind: 'PINNED', addresses: [PUBLIC_ANSWER] }],
      ]),
    );

    const hop = await guarded.goto('https://second.example.com/sso', 1_000);
    expect(hop.ok).toBe(true);
    expect(await guarded.fill('#password', VAULT.p, 1_000)).toBe(false);
    expect(rec.filled).toEqual([]);

    // AND THE PINNED HOST STILL FILLS, so this is a pin and not an outage.
    await guarded.goto('https://app.example.com/login', 1_000);
    expect(await guarded.fill('#password', VAULT.p, 1_000)).toBe(true);
    expect(rec.filled.map((f) => f.selector)).toEqual(['#password']);
  });

  it('REFUSES THE CREDENTIAL WHEN A GUARD SAID YES AND PINNED NOTHING', async () => {
    /*
     * FAIL CLOSED on `{ ok: true }` with no permit. A success arm that fell
     * through to "pinned" is what made the defect invisible: the old fixtures
     * in this file and in `login.test.ts` all answered exactly this shape, so a
     * `fill` that trusted "approved" could not tell a pinned host from a named
     * one. The navigation is still allowed — the guard did say yes — and the
     * credential is not.
     *
     * Written out by hand rather than through {@link loginGuardAnswering},
     * because the shape being tested is the one a HAND-BUILT `LoginSurfaces`
     * produces; the real guard always carries a permit.
     */
    const pinsNothing: LoginEgressGuard = async () => ({ ok: true });

    const rec = rebindingBrowser(REBOUND_ANSWER);
    const result = await performFormLogin(formConfig(), VAULT, 'https://app.example.com/', {
      browser: rec.open,
      egress: pinsNothing,
    });

    expect(result.ok).toBe(false);
    expect(rec.filledAt).toEqual([]);
    // No rule either: there is no address to write, and a `~NOTFOUND` for a
    // host the guard ALLOWED would break a working login rather than guard one.
    expect(rec.launched.map((launch) => launch.hostResolverRules)).toEqual(['']);
  });

  it('PINS BY NAME AND APPROVES BY `host:port`, which are two different keys', async () => {
    /*
     * A NON-DEFAULT PORT is where the two keys diverge, and getting them
     * crossed is a silent failure in either direction. The RESOLVER RULE must
     * carry the NAME — Chromium resolves a name, and a pattern with a port
     * matches only that port, so a refusal keyed on `host:port` would leave the
     * same name reachable everywhere else. The APPROVAL RECORD must carry the
     * PORT — `browser.url()` reports it, and a virtual host on another port is
     * a different server that nobody approved.
     *
     * So this drives a login on `:8443` and asserts both: one rule, named
     * without the port, and the credential typed at the pinned address.
     */
    const rec = rebindingBrowser(REBOUND_ANSWER);

    const result = await performFormLogin(formConfig(), VAULT, 'https://app.example.com:8443/', {
      browser: rec.open,
      egress: guardAllowing('app.example.com'),
    });

    expect(result.ok).toBe(true);
    expect(rec.launched.map((launch) => launch.hostResolverRules)).toEqual([
      `MAP app.example.com ${PUBLIC_ANSWER}`,
    ]);
    expect(rec.filledAt.map((f) => f.address)).toEqual([PUBLIC_ANSWER, PUBLIC_ANSWER]);

    /*
     * AND THE REFUSAL ON A PORT, which is the direction that matters more: a
     * `~NOTFOUND` keyed on `host:port` would block one port and leave the name
     * resolvable on all the others.
     */
    const refused = rebindingBrowser(REBOUND_ANSWER);
    const blocked = await performFormLogin(
      formConfig(),
      VAULT,
      'https://nothing.example.test:8443/',
      { browser: refused.open, egress: guardAllowing('app.example.com') },
    );

    expect(blocked.ok).toBe(false);
    expect(refused.filledAt).toEqual([]);
    expect(refused.launched.map((launch) => launch.hostResolverRules)).toEqual([
      'MAP nothing.example.test ~NOTFOUND',
    ]);
  });

  it('records the ADDRESSES, which is what "pinned" has to mean', async () => {
    /*
     * The vocabulary fix, asserted. What used to be a `Set<string>` of hosts
     * under a comment calling it "the pin cache" is now a map to a
     * {@link LoginHostApproval}, and this is the test that would have failed
     * against the old shape: there was nowhere for an address to be.
     */
    const plan = await planLoginLaunch(
      guardAllowing('app.example.com'),
      'https://app.example.com/login',
    );

    expect(plan.approved.get('app.example.com')).toEqual({
      kind: 'PINNED',
      addresses: [PUBLIC_ANSWER],
    });
    expect(plan.hostResolverRules).toBe(`MAP app.example.com ${PUBLIC_ANSWER}`);
  });

  it('LEAVES THE OBSERVE BRAKE ALONE: no pin, no refusal, today’s behaviour', async () => {
    /*
     * A BRAKE THAT DOES NOT BRAKE IS WORSE THAN NO BRAKE. An operator who set
     * `mode: 'OBSERVE'` on the environment's egress policy was promised that
     * today's behaviour continues, so an OBSERVED permit must produce NO
     * resolver rule — the name resolves normally, rebinding window open — and
     * must not refuse the credential. That is what observe MEANS, and it is why
     * `SECURITY_CONTROL_BRAKES.EGRESS_CLASSIFICATION.fallback` is ENFORCE: this
     * arm is reached only where somebody armed the brake on purpose.
     *
     * The same host under ENFORCE is refused, which is the contrast that shows
     * the mode is doing the work rather than the host being special.
     */
    const answers = { 'app.example.com': '10.0.0.5' };

    const observing = rebindingBrowser(REBOUND_ANSWER);
    const observed = await performFormLogin(formConfig(), VAULT, 'https://app.example.com/', {
      browser: observing.open,
      egress: loginGuardAnswering(answers, { deployment: 'HOSTED', mode: 'OBSERVE' }),
    });

    expect(observed.ok).toBe(true);
    // NO RULE. The brake is the absence of the pin, not a pin nobody applied.
    expect(observing.launched.map((launch) => launch.hostResolverRules)).toEqual(['']);
    expect(observing.filledAt.map((f) => f.selector)).toEqual(['#username', '#password']);
    /*
     * AND THE ADDRESS IS THE BROWSER'S OWN, stated rather than left implicit.
     * This is the COST of the brake and it should be visible in the test that
     * defends it: in OBSERVE the second resolution still wins, because that is
     * the behaviour the operator chose to keep. Anyone who later makes OBSERVE
     * pin will land here and have to decide it on purpose — a pin changes which
     * address a working login reaches, which is not an observation.
     */
    expect(observing.filledAt.map((f) => f.address)).toEqual([REBOUND_ANSWER, REBOUND_ANSWER]);

    const enforcing = rebindingBrowser(REBOUND_ANSWER);
    const refused = await performFormLogin(formConfig(), VAULT, 'https://app.example.com/', {
      browser: enforcing.open,
      egress: loginGuardAnswering(answers, { deployment: 'HOSTED', mode: 'ENFORCE' }),
    });

    expect(refused.ok).toBe(false);
    expect(enforcing.filledAt).toEqual([]);
    expect(enforcing.launched.map((launch) => launch.hostResolverRules)).toEqual([
      'MAP app.example.com ~NOTFOUND',
    ]);
  });
});
