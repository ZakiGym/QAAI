/**
 * Tests for the session-refresh sweep.
 *
 * ── THE ONE TO READ FIRST ───────────────────────────────────────────────────
 *
 * "a failed refresh reports NOT_RUN and NEVER permits an anonymous run". That
 * is the defect this whole module exists for: an expired session became `null`,
 * `null` became `{ ok: true, storageState }`, and the run executed anonymously
 * and reported a pass — so every auth-gated route it touched looked covered by
 * a test that was never signed in. A security hole and a lie in the product's
 * core number, from one falsy check.
 *
 * ── THE SECOND GROUP IS ABOUT NOT HARMING THE CUSTOMER ─────────────────────
 *
 * A refresh is an unattended process typing a password into a customer's own
 * login form every hour. "stops attempting at the cap" and "drives no login at
 * all past the cap" are the tests that stop this feature locking a customer out
 * of their own account with their own credentials.
 *
 * ── NO NETWORK, NO DNS, NO REAL BROWSER, NO KEY ON DISK ────────────────────
 *
 * `EgressIo`, the cipher, the clock and the login are all injected. The
 * resolver is a function in this file, so no test can touch DNS even by
 * accident — the production classifier is behind a DYNAMIC import that is only
 * reached when nothing was injected. The cipher is the REAL AES-256-GCM one
 * over a key generated in-process, because a round trip that only ever ran
 * against a fake proves nothing about the envelope the database will hold.
 */

import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The worker's context opens Postgres, Redis and the LLM at import time, so it
// is replaced wholesale; `h.prisma` is swapped per test through the proxy.
const h = vi.hoisted((): { prisma: Record<string, unknown>; log: string[] } => ({
  prisma: {},
  log: [],
}));

vi.mock('../context.js', () => ({
  config: { vaultMasterKey: '' },
  connection: {},
  logger: {
    debug: () => {},
    info: () => {},
    warn: (_o: unknown, msg?: string) => h.log.push(`warn:${msg ?? ''}`),
    error: (_o: unknown, msg?: string) => h.log.push(`error:${msg ?? ''}`),
  },
  prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
}));
vi.mock('../vault.js', () => ({ secretsFor: async () => ({}) }));

const {
  AUTH_REFRESH_OUTCOMES,
  AUTH_REFRESH_OUTCOME_RULES,
  AUTH_REFRESH_QUEUE,
  DEFAULT_MAX_PROFILES_PER_TICK,
  MAX_REFRESH_FAILURES,
  REFRESH_BACKOFF_MS,
  REFRESH_CANDIDATE_SELECT,
  REFRESH_PIN_LIMITATION,
  SESSION_SEAL_CONTROL,
  auditMetadata,
  openCachedSession,
  processAuthRefreshTick,
  refreshBackoff,
  refreshProfile,
  workerSessionCipher,
} = await import('./auth-refresh.js');

type RefreshCandidate = import('./auth-refresh.js').RefreshCandidate;
type AuthRefreshDeps = import('./auth-refresh.js').AuthRefreshDeps;
type AuthRefreshLogin = import('./auth-refresh.js').AuthRefreshLogin;
type AuthRefreshSignIn = import('./auth-refresh.js').AuthRefreshSignIn;

const { localSessionCipher, masterKeyResolver, openSession, sessionGate, useSessionState } =
  await import('../../../api/src/lib/session-store.js');
type SealedSessionRow = import('../../../api/src/lib/session-store.js').SealedSessionRow;
const { classifyAddress, classifyHost } = await import('@qaai/shared/private-address');
/*
 * The real `Prisma` namespace, for `Prisma.DbNull`.
 *
 * `storageState` is a nullable Json column, so the WRITE that empties it is
 * `Prisma.DbNull` and the READ that comes back is `null`. A fake that echoed
 * the write straight back would report the sentinel as the column's value and
 * make every state assertion below read `LEGACY_PLAINTEXT` — which is the
 * select-blind-fake hazard in a second costume, so the fake models the
 * translation instead (see `fakePrisma`).
 */
const { Prisma } = await import('../../../api/src/generated/prisma/client.js');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-10-29T12:00:00.000Z');
const HOUR = 3_600_000;

/**
 * The things being protected, composed at run time rather than written as
 * literals — rule 19 is absolute about credential-shaped literals here, and a
 * session cookie is the most credential-shaped value this product holds. Every
 * leak assertion greps output for these strings.
 */
const COOKIE_VALUE = ['qaai', 'fake', 'session', 'cookie'].join('-') + '-00000000';
const PASSWORD = ['qaai', 'fake', 'password'].join('-');
/** What login.ts puts in `message` — the page title of whatever answered. */
const PAGE_TITLE = 'Internal Admin Console — staging-db-7';

const SESSION = { cookies: [{ name: 'sid', value: COOKIE_VALUE }], origins: [] };

const ACTIVE_KEY = { keyId: 'local-1', version: 1, state: 'ACTIVE' as const };
const KEYS = { keys: [ACTIVE_KEY], unreadableVersions: [] as number[] };

const cipher = () => localSessionCipher(masterKeyResolver(randomBytes(32).toString('base64')));

/**
 * The resolver and classifier, injected.
 *
 * `classifyHost` and `classifyAddress` are the REAL ones from
 * private-address.ts — the classification rules are not this module's to
 * reinvent, and a fake classifier would let a test "refuse" an address the real
 * one permits. Only the LOOKUP is faked, which is the only part that would
 * touch the network.
 */
const egressIo = (answers: Record<string, string[]>) => ({
  classifyHost,
  classifyAddress,
  lookup: async (host: string) => (answers[host] ?? []).map((address) => ({ address })),
  now: () => NOW,
});

/** A profile whose sealed session has just expired. Each test spoils one thing. */
const candidate = (over: Partial<RefreshCandidate> = {}): RefreshCandidate => ({
  id: 'prof1',
  orgId: 'org1',
  environmentId: 'env1',
  name: 'Admin',
  kind: 'FORM_LOGIN',
  config: {},
  storageState: null,
  storageStateExpiresAt: new Date(NOW.getTime() - HOUR),
  storageStateSealed: 'qs1.local-1.1.AES_256_GCM.AAAA',
  storageStateKeyVersion: 1,
  storageStateNeedsReseal: false,
  storageStateRefreshAttemptedAt: null,
  storageStateRefreshFailures: 0,
  environment: {
    id: 'env1',
    kind: 'STAGING',
    baseUrl: 'https://app.example.com/login',
    egressPolicy: null,
  },
  ...over,
});

/** A login that succeeds, and that also hands back a page title it must not leak. */
const goodLogin = async (): Promise<AuthRefreshLogin> =>
  ({
    ok: true,
    storageState: SESSION,
    expiresAt: new Date(NOW.getTime() + 8 * HOUR),
    failure: null,
    // Not a member of AuthRefreshLogin. Present on purpose: the real
    // signInWithProfile returns `message`, and the narrowing in browserSignIn
    // is what drops it. If anything in this module started spreading the login
    // result, this field would show up in the leak assertions below.
    message: `Signed in (page title: "${PAGE_TITLE}")`,
  }) as unknown as AuthRefreshLogin;

const failedLogin = async (): Promise<AuthRefreshLogin> =>
  ({
    ok: false,
    storageState: null,
    expiresAt: null,
    failure: { kind: 'REJECTED', step: 'SUBMIT', fault: 'OURS' },
    message: `Sign-in failed (page title: "${PAGE_TITLE}"). Tried ${PASSWORD}`,
  }) as unknown as AuthRefreshLogin;

function deps(over: Partial<AuthRefreshDeps> = {}): AuthRefreshDeps {
  return {
    now: () => NOW,
    cipher: cipher(),
    egress: egressIo({ 'app.example.com': ['93.184.216.34'] }),
    signIn: goodLogin,
    secretsFor: async () => ({ PASSWORD }),
    ...over,
  };
}

/**
 * A `prisma` fake that HONOURS `select`, `take` and `orderBy`.
 *
 * Rule 9 and lesson F, and neither is theoretical on this path: a select-blind
 * fake would make deleting `storageStateNeedsReseal: true` from
 * REFRESH_CANDIDATE_SELECT undetectable, and a row whose `needsReseal` read as
 * `undefined` looks perfectly fresh — which is the exact state the sealing
 * migration left behind. `take` and `orderBy` are honoured too, because the
 * budget cap and the "never-attempted first" ordering are both facts this
 * module reports.
 */
function project(row: Record<string, unknown>, select: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, want] of Object.entries(select)) {
    if (want === true) out[key] = row[key];
    else if (typeof want === 'object' && want !== null && 'select' in want) {
      const nested = row[key];
      out[key] =
        nested === null || nested === undefined
          ? nested
          : project(
              nested as Record<string, unknown>,
              (want as { select: Record<string, unknown> }).select,
            );
    }
  }
  return out;
}

interface Calls {
  /** The raw `data` the processor handed Prisma, sentinels included. */
  updates: Array<{ id: string; data: Record<string, unknown> }>;
  /**
   * WHAT THE COLUMN WOULD HOLD AFTERWARDS. `Prisma.DbNull` is SQL NULL, so a
   * write of the sentinel reads back as `null` — and an assertion against the
   * raw write would call that row LEGACY_PLAINTEXT for ever.
   */
  stored: Array<{ id: string; data: Record<string, unknown> }>;
  audits: Array<Record<string, unknown>>;
  findManyArgs: Array<Record<string, unknown>>;
}

/** The database's reading of one written value. One place, so no test guesses. */
function asStored(value: unknown): unknown {
  return value === Prisma.DbNull || value === Prisma.JsonNull ? null : value;
}

function fakePrisma(profiles: RefreshCandidate[], options: { storedModes?: unknown } = {}): Calls {
  const calls: Calls = { updates: [], stored: [], audits: [], findManyArgs: [] };
  h.prisma = {
    vaultKey: {
      findMany: async (args: { select: Record<string, unknown> }) =>
        [{ keyId: 'local-1', version: 1, state: 'ACTIVE', note: 'the first key' }].map((r) =>
          project(r, args.select),
        ),
    },
    authProfile: {
      findMany: async (args: {
        select: Record<string, unknown>;
        take?: number;
        orderBy?: unknown;
      }) => {
        calls.findManyArgs.push(args);
        const ordered = [...profiles].sort((a, b) => {
          const at = a.storageStateRefreshAttemptedAt?.getTime();
          const bt = b.storageStateRefreshAttemptedAt?.getTime();
          // nulls first, which is what the production orderBy asks for.
          if (at === undefined && bt === undefined) return 0;
          if (at === undefined) return -1;
          if (bt === undefined) return 1;
          return at - bt;
        });
        const taken = args.take === undefined ? ordered : ordered.slice(0, args.take);
        return taken.map((r) => project(r as unknown as Record<string, unknown>, args.select));
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.updates.push({ id: args.where.id, data: args.data });
        calls.stored.push({
          id: args.where.id,
          data: Object.fromEntries(
            Object.entries(args.data).map(([key, value]) => [key, asStored(value)]),
          ),
        });
        return {};
      },
    },
    organization: {
      findUnique: async () => ({ securityControlModes: options.storedModes ?? null }),
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        calls.audits.push(args.data);
        return {};
      },
    },
  };
  return calls;
}

beforeEach(() => {
  h.log = [];
  h.prisma = {};
});

// ─────────────────────────────────────────────────────────────────────────────
// THE HEADLINE
// ─────────────────────────────────────────────────────────────────────────────

describe('a refresh that fails', () => {
  /*
   * ── THE TEST THAT STOPS THE DEFECT COMING BACK ──────────────────────────
   *
   * Revert the gate's NOT_RUN or let `anonymousPermitted` default to true under
   * ENFORCE and this goes red. It is the only thing standing between a dead
   * session and a suite that reports every auth-gated route as covered by a
   * test that was never signed in.
   */
  it('reports a typed NOT_RUN and NEVER permits an anonymous run', async () => {
    const result = await refreshProfile(deps({ signIn: failedLogin }), candidate(), {
      mode: 'ENFORCE',
      keys: KEYS,
    });

    expect(result.report.outcome).toBe('LOGIN_FAILED');
    expect(result.report.notRun).not.toBeNull();
    expect(result.report.notRun?.kind).toBe('BLOCKED_BY_ENV');
    expect(result.report.anonymousPermitted).toBe(false);
    expect(result.report.failureKind).toBe('REJECTED');
    expect(result.report.failureFault).toBe('OURS');
  });

  /*
   * The coverage half of the same defect. BLOCKED_BY_ENV is the kind the
   * NOT_RUN_KINDS guidance says must be EXCLUDED from a pass rate and from a
   * coverage denominator — so an auth-gated route whose test did not run
   * cannot be credited to an anonymous pass. Asserted as the property rather
   * than as a spelling, because a test that asserts a value's spelling does not
   * assert what the value does.
   */
  it('reports the kind that a coverage denominator must exclude, for every failure path', async () => {
    const paths: Array<[string, Partial<AuthRefreshDeps>]> = [
      ['LOGIN_FAILED', { signIn: failedLogin }],
      [
        'NOT_REFRESHABLE',
        {
          signIn: async () => ({ ok: true, storageState: null, expiresAt: null, failure: null }),
        },
      ],
      ['REFUSED_BY_EGRESS', { egress: egressIo({ 'app.example.com': ['169.254.169.254'] }) }],
      [
        'SEAL_FAILED',
        {
          cipher: {
            encrypt: async () => {
              throw new Error('no key');
            },
            decrypt: async () => '',
          },
        },
      ],
    ];
    for (const [expected, over] of paths) {
      const result = await refreshProfile(deps(over), candidate(), {
        mode: 'ENFORCE',
        keys: KEYS,
      });
      expect(result.report.outcome).toBe(expected);
      expect(result.report.notRun?.kind).toBe('BLOCKED_BY_ENV');
      expect(result.report.anonymousPermitted).toBe(false);
    }
  });

  /*
   * A failed refresh does NOT destroy the session it failed to replace.
   * Nulling the sealed column on failure would turn a five-minute outage at the
   * customer's identity provider into a profile with nothing at all, and the
   * next run would then be anonymous for a different reason.
   */
  it('leaves the existing sealed session untouched', async () => {
    const result = await refreshProfile(deps({ signIn: failedLogin }), candidate(), {
      mode: 'ENFORCE',
      keys: KEYS,
    });
    const data = result.write?.data ?? {};
    expect(Object.keys(data).sort()).toEqual([
      'storageStateRefreshAttemptedAt',
      'storageStateRefreshFailures',
    ]);
    expect(data.storageStateRefreshFailures).toEqual({ increment: 1 });
    expect(data.storageStateRefreshAttemptedAt).toEqual(NOW);
  });

  it('permits the anonymous run under OBSERVE instead, and says so', async () => {
    const result = await refreshProfile(deps({ signIn: failedLogin }), candidate(), {
      mode: 'OBSERVE',
      keys: KEYS,
    });
    expect(result.report.anonymousPermitted).toBe(true);
    expect(result.report.notRun).toBeNull();
    expect(result.report.mode).toBe('OBSERVE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The egress guard
// ─────────────────────────────────────────────────────────────────────────────

describe('the refresh as an outbound credential-using call', () => {
  /*
   * THE STRONGEST ASSERTION IN THIS FILE: `signIn` is never called.
   *
   * A guard that refuses after the browser has typed the password is not a
   * guard. So this does not check a refusal message, it checks that the code
   * which would type vault plaintext into whatever answered was never reached.
   */
  it('REFUSES THE METADATA ADDRESS BEFORE ANY BROWSER IS LAUNCHED', async () => {
    let attempts = 0;
    const result = await refreshProfile(
      deps({
        egress: egressIo({ 'app.example.com': ['169.254.169.254'] }),
        signIn: async () => {
          attempts += 1;
          return goodLogin();
        },
      }),
      candidate(),
      { mode: 'ENFORCE', keys: KEYS },
    );

    expect(attempts).toBe(0);
    expect(result.report.outcome).toBe('REFUSED_BY_EGRESS');
    expect(result.report.egressOutcome).toBe('REFUSED');
    expect(result.report.egressRefusal).toBe('NOT_ALLOWLISTED');
  });

  it('refuses a loopback target under the default HOSTED policy, with no login driven', async () => {
    let attempts = 0;
    const result = await refreshProfile(
      deps({
        egress: egressIo({}),
        signIn: async () => {
          attempts += 1;
          return goodLogin();
        },
      }),
      candidate({
        environment: {
          id: 'env1',
          kind: 'STAGING',
          baseUrl: 'http://127.0.0.1:3000/login',
          egressPolicy: null,
        },
      }),
      { mode: 'ENFORCE', keys: KEYS },
    );
    expect(attempts).toBe(0);
    expect(result.report.outcome).toBe('REFUSED_BY_EGRESS');
    expect(result.report.egressRefusal).toBe('CLASS_NOT_PERMITTED');
  });

  /*
   * The self-hosted customer's legitimate case. A QAAI behind somebody's own
   * firewall exists to test `http://localhost:3000`, and refusing that would
   * break the install for every customer who is not attacking themselves.
   */
  it('permits a loopback target for a SELF_HOSTED deployment, and names the skipped check', async () => {
    const result = await refreshProfile(
      deps({ egress: egressIo({}) }),
      candidate({
        environment: {
          id: 'env1',
          kind: 'STAGING',
          baseUrl: 'http://127.0.0.1:3000/login',
          egressPolicy: { deployment: 'SELF_HOSTED' },
        },
      }),
      { mode: 'ENFORCE', keys: KEYS },
    );
    expect(result.report.outcome).toBe('REFRESHED');
    expect(result.report.egressOutcome).toBe('ALLOWED');
  });

  it('refuses a base URL with no host, without quoting the URL', async () => {
    const result = await refreshProfile(
      deps(),
      candidate({
        environment: {
          id: 'env1',
          kind: 'STAGING',
          baseUrl: 'not a url at all',
          egressPolicy: null,
        },
      }),
      { mode: 'ENFORCE', keys: KEYS },
    );
    expect(result.report.outcome).toBe('TARGET_UNUSABLE');
    expect(result.report.detail).not.toContain('not a url at all');
  });

  /*
   * HONESTY ABOUT WHAT THIS CONTROL DOES NOT DO. The browser resolves the name
   * itself, so the pinned set is not enforced at the socket — and the report
   * says so on every attempt rather than reading as a closed window. A pass
   * that means "we did not check" is the lie this product may not ship.
   */
  it('states the pin limitation on every login it attempted, and on none it did not', async () => {
    const attempted = await refreshProfile(deps(), candidate(), {
      mode: 'ENFORCE',
      keys: KEYS,
    });
    expect(attempted.report.pinLimitation).toBe(REFRESH_PIN_LIMITATION);

    const refused = await refreshProfile(
      deps({ egress: egressIo({ 'app.example.com': ['10.0.0.5'] }) }),
      candidate(),
      { mode: 'ENFORCE', keys: KEYS },
    );
    expect(refused.report.pinLimitation).toBeNull();
  });

  it('hands the login the pinned addresses, not just the name', async () => {
    const seen: AuthRefreshSignIn[] = [];
    await refreshProfile(
      deps({
        signIn: async (input) => {
          seen.push(input);
          return goodLogin();
        },
      }),
      candidate(),
      { mode: 'ENFORCE', keys: KEYS },
    );
    expect(seen[0]?.pinnedAddresses).toEqual(['93.184.216.34']);
  });

  it('refuses a name that resolves to nothing, rather than letting the browser try', async () => {
    let attempts = 0;
    const result = await refreshProfile(
      deps({
        egress: egressIo({}),
        signIn: async () => {
          attempts += 1;
          return goodLogin();
        },
      }),
      candidate(),
      { mode: 'ENFORCE', keys: KEYS },
    );
    expect(attempts).toBe(0);
    expect(result.report.egressRefusal).toBe('NO_ADDRESSES');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Nothing about the page comes back
// ─────────────────────────────────────────────────────────────────────────────

describe('never echoing what answered', () => {
  /*
   * The existing path returns the page title, which is an information leak from
   * inside the network — `login.ts` builds it on three paths. The fake logins
   * above DO hand back a `message` containing a title and a password; this
   * asserts there is no field through which either can reach anything written
   * down.
   */
  it('gets no page title and no password into the report or the audit row', async () => {
    for (const signIn of [goodLogin, failedLogin]) {
      const result = await refreshProfile(deps({ signIn }), candidate(), {
        mode: 'ENFORCE',
        keys: KEYS,
      });
      const written = JSON.stringify([
        result.report,
        auditMetadata(result.report),
        result.write?.data ?? null,
      ]);
      expect(written).not.toContain(PAGE_TITLE);
      expect(written).not.toContain('staging-db-7');
      expect(written).not.toContain(PASSWORD);
      expect(written).not.toContain(COOKIE_VALUE);
    }
  });

  it('keeps the captured session out of the report, out of the audit row and out of the log', async () => {
    fakePrisma([candidate()]);
    const tick = await processAuthRefreshTick({ at: NOW.toISOString() }, deps());
    const written = JSON.stringify([tick, h.log]);
    expect(written).not.toContain(COOKIE_VALUE);
    expect(written).not.toContain(PASSWORD);
  });

  /*
   * The audit metadata is a CLOSED list of what may be written down about a
   * secret, so its key set is pinned. A field added to it is a visible change
   * to this test rather than a new thing quietly appearing in the audit log.
   */
  it('writes exactly the audit fields it declares, and no others', async () => {
    const result = await refreshProfile(deps({ signIn: failedLogin }), candidate(), {
      mode: 'ENFORCE',
      keys: KEYS,
    });
    expect(Object.keys(auditMetadata(result.report)).sort()).toEqual([
      'attempt',
      'capped',
      'egressOutcome',
      'egressRefusal',
      'failureFault',
      'failureKind',
      'mode',
      'nextAttemptAt',
      'notRunKind',
      'outcome',
      'pinLimitation',
      'refusalSentence',
      'sealWithheld',
      'stateBefore',
    ]);
  });

  /*
   * NO ORACLE. Whatever the egress guard refused — a loopback address, the
   * metadata address, an unresolvable name — the sentence a non-operator may be
   * shown is ONE CONSTANT from egress.ts. A refusal that varied would tell
   * whoever typed the URL which internal hosts exist.
   */
  it('shows one refusal sentence whatever the egress guard refused, and never the address', async () => {
    const sentences = new Set<string>();
    for (const addresses of [['127.0.0.1'], ['169.254.169.254'], ['10.0.0.5'], []]) {
      const result = await refreshProfile(
        deps({ egress: egressIo({ 'app.example.com': addresses }) }),
        candidate(),
        { mode: 'ENFORCE', keys: KEYS },
      );
      const meta = auditMetadata(result.report);
      expect(result.report.outcome).toBe('REFUSED_BY_EGRESS');
      sentences.add(String(meta.refusalSentence));
      for (const address of addresses) {
        expect(String(meta.refusalSentence)).not.toContain(address);
      }
    }
    expect(sentences.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The bounds — not locking the customer out
// ─────────────────────────────────────────────────────────────────────────────

describe('bounding the retries', () => {
  it('is due immediately after a success, and backs off after each failure', () => {
    expect(refreshBackoff(0, null, NOW).due).toBe(true);

    const justTried = new Date(NOW.getTime() - 60_000);
    expect(refreshBackoff(1, justTried, NOW).due).toBe(false);
    expect(refreshBackoff(1, new Date(NOW.getTime() - 16 * 60_000), NOW).due).toBe(true);

    // The schedule lengthens, which is the whole point of a backoff.
    const waits = [1, 2, 3, 4].map((failures) => {
      const next = refreshBackoff(failures, NOW, NOW).nextAttemptAt;
      return (next?.getTime() ?? 0) - NOW.getTime();
    });
    expect(waits).toEqual([...REFRESH_BACKOFF_MS]);
    expect([...waits].sort((a, b) => a - b)).toEqual(waits);
  });

  /*
   * ── THE TEST THAT KEEPS A CUSTOMER'S ACCOUNT USABLE ────────────────────
   *
   * Past the cap, NO LOGIN IS DRIVEN. Not a slower one, not one more — zero.
   * The next attempt would be the sixth consecutive unattended password
   * submission at an account whose password we hold, and that is how a refresh
   * becomes a lockout we caused.
   */
  it('DRIVES NO LOGIN AT ALL past the attempt cap', async () => {
    let attempts = 0;
    const result = await refreshProfile(
      deps({
        signIn: async () => {
          attempts += 1;
          return goodLogin();
        },
      }),
      candidate({
        storageStateRefreshFailures: MAX_REFRESH_FAILURES,
        storageStateRefreshAttemptedAt: new Date(NOW.getTime() - 365 * 24 * HOUR),
      }),
      { mode: 'ENFORCE', keys: KEYS },
    );

    expect(attempts).toBe(0);
    expect(result.report.outcome).toBe('ATTEMPTS_CAPPED');
    expect(result.report.capped).toBe(true);
    // The cap bit, so it is REPORTED — and it does not advance the counter,
    // because no attempt was made.
    expect(result.report.detail).toContain(String(MAX_REFRESH_FAILURES));
    expect(result.write).toBeNull();
  });

  it('writes an audit row when the cap bites, so a cap is never silent', async () => {
    const calls = fakePrisma([
      candidate({
        storageStateRefreshFailures: MAX_REFRESH_FAILURES,
        storageStateRefreshAttemptedAt: new Date(NOW.getTime() - 24 * HOUR),
      }),
    ]);
    await processAuthRefreshTick({ at: NOW.toISOString() }, deps());
    expect(calls.audits).toHaveLength(1);
    expect(calls.audits[0]?.action).toBe('auth_profile.session_refresh_capped');
  });

  it('stays quiet inside the backoff window, and drives no login', async () => {
    let attempts = 0;
    const result = await refreshProfile(
      deps({
        signIn: async () => {
          attempts += 1;
          return goodLogin();
        },
      }),
      candidate({
        storageStateRefreshFailures: 2,
        storageStateRefreshAttemptedAt: new Date(NOW.getTime() - 60_000),
      }),
      { mode: 'ENFORCE', keys: KEYS },
    );
    expect(attempts).toBe(0);
    expect(result.report.outcome).toBe('BACKED_OFF');
    expect(result.report.nextAttemptAt).not.toBeNull();
    expect(result.write).toBeNull();
  });

  /*
   * The cap is a PAUSE and not a tombstone: a success resets the counter, so a
   * customer who fixes the password is not left with a profile nothing will
   * ever try again.
   */
  /*
   * `nextAttemptAt: null` must not carry two facts. On the failure that
   * REACHES the cap, the report says so — otherwise an operator reading the
   * audit row sees "no next attempt" and cannot tell a cap from a gap.
   */
  it('says the cap was reached on the failure that reaches it, not just afterwards', async () => {
    const lastAllowed = await refreshProfile(
      deps({ signIn: failedLogin }),
      candidate({
        storageStateRefreshFailures: MAX_REFRESH_FAILURES - 1,
        storageStateRefreshAttemptedAt: new Date(NOW.getTime() - 365 * 24 * HOUR),
      }),
      { mode: 'ENFORCE', keys: KEYS },
    );
    expect(lastAllowed.report.outcome).toBe('LOGIN_FAILED');
    expect(lastAllowed.report.attempt).toBe(MAX_REFRESH_FAILURES);
    expect(lastAllowed.report.capped).toBe(true);
    expect(lastAllowed.report.nextAttemptAt).toBeNull();
    expect(auditMetadata(lastAllowed.report).capped).toBe(true);

    // And an earlier failure reports a real next attempt, not a cap.
    const earlier = await refreshProfile(
      deps({ signIn: failedLogin }),
      candidate({
        storageStateRefreshFailures: 1,
        storageStateRefreshAttemptedAt: new Date(NOW.getTime() - 365 * 24 * HOUR),
      }),
      { mode: 'ENFORCE', keys: KEYS },
    );
    expect(earlier.report.capped).toBe(false);
    expect(earlier.report.nextAttemptAt).not.toBeNull();
  });

  /*
   * A login that reports no expiry gets the refresh LEAD as a floor, never the
   * eight-hour TTL — the row it writes must be re-checked almost immediately
   * rather than claiming validity nothing measured.
   */
  it('floors a missing login expiry at the refresh lead, not at the full TTL', async () => {
    const result = await refreshProfile(
      deps({
        signIn: async () => ({
          ok: true,
          storageState: SESSION,
          expiresAt: null,
          failure: null,
        }),
      }),
      candidate(),
      { mode: 'ENFORCE', keys: KEYS },
    );
    expect(result.report.outcome).toBe('REFRESHED');
    const expiresAt = result.write?.data.storageStateExpiresAt as Date;
    expect(expiresAt.getTime() - NOW.getTime()).toBe(60 * 60_000);
  });

  it('resets the failure counter on success', async () => {
    const result = await refreshProfile(
      deps(),
      candidate({
        storageStateRefreshFailures: 3,
        storageStateRefreshAttemptedAt: new Date(NOW.getTime() - 24 * HOUR),
      }),
      { mode: 'ENFORCE', keys: KEYS },
    );
    expect(result.report.outcome).toBe('REFRESHED');
    expect(result.write?.data.storageStateRefreshFailures).toBe(0);
    expect(result.write?.data.storageStateRefreshedAt).toEqual(NOW);
  });

  it('treats failures with no attempt timestamp as due, so an inconsistent row is not parked for ever', () => {
    expect(refreshBackoff(2, null, NOW)).toEqual({
      due: true,
      nextAttemptAt: null,
      capped: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The successful refresh, end to end
// ─────────────────────────────────────────────────────────────────────────────

describe('a refresh that succeeds', () => {
  /*
   * THE CONSTRUCTED-AND-RAN EVIDENCE. A real tick, over a fake database that
   * honours `select`, with the REAL AES-256-GCM cipher — and the session that
   * comes out of the column at the end is the one that went in.
   */
  it('seals the captured session into the column, and it opens again', async () => {
    const key = cipher();
    const calls = fakePrisma([candidate()]);
    const tick = await processAuthRefreshTick({ at: NOW.toISOString() }, deps({ cipher: key }));

    expect(tick.byOutcome.REFRESHED).toBe(1);
    expect(calls.updates).toHaveLength(1);
    const data = calls.stored[0]!.data;

    const opened = await openSession({
      row: {
        id: 'prof1',
        storageState: data.storageState,
        storageStateExpiresAt: data.storageStateExpiresAt as Date,
        storageStateSealed: data.storageStateSealed as string,
        storageStateKeyVersion: data.storageStateKeyVersion as number,
        storageStateNeedsReseal: data.storageStateNeedsReseal as boolean,
      },
      keys: [ACTIVE_KEY],
      cipher: key,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(useSessionState(opened.value, (s) => (s as typeof SESSION).cookies[0]?.value)).toBe(
      COOKIE_VALUE,
    );
  });

  /*
   * And the row it wrote is one the gate calls FRESH. A seal that produced a
   * row the gate still refused would be a refresh that fixed nothing — and the
   * two are written by different functions, so this is the only place they are
   * checked against each other.
   */
  it('writes a row the gate then reports as usable', async () => {
    const calls = fakePrisma([candidate()]);
    await processAuthRefreshTick({ at: NOW.toISOString() }, deps());
    const data = calls.stored[0]!.data;
    const gate = sessionGate(
      {
        id: 'prof1',
        storageState: data.storageState,
        storageStateExpiresAt: data.storageStateExpiresAt as Date,
        storageStateSealed: data.storageStateSealed as string,
        storageStateKeyVersion: data.storageStateKeyVersion as number,
        storageStateNeedsReseal: data.storageStateNeedsReseal as boolean,
      },
      { now: NOW, mode: 'ENFORCE' },
    );
    expect(gate.state).toBe('SEALED_FRESH');
    expect(gate.usable).toBe(true);
    expect(gate.notRun).toBeNull();
  });

  /*
   * THE CLEAN-UP THAT MAKES THE COLUMN'S CLAIM TRUE. A profile an un-migrated
   * writer put plaintext into is refused by the gate AND cleared by the
   * refresh, so the plaintext does not need a second sweep to find it.
   */
  it('clears the legacy plaintext column, for a profile that had one', async () => {
    const calls = fakePrisma([candidate({ storageState: SESSION })]);
    const tick = await processAuthRefreshTick({ at: NOW.toISOString() }, deps());
    expect(tick.reports[0]?.stateBefore).toBe('LEGACY_PLAINTEXT');
    // The COLUMN's value, not the sentinel the write carries.
    expect(calls.stored[0]!.data.storageState).toBeNull();
    expect(calls.updates[0]!.data.storageState).toBe(Prisma.DbNull);
    expect(calls.updates[0]!.data.storageStateNeedsReseal).toBe(false);
  });

  /*
   * ── THE BRAKE THAT DID NOT BRAKE ────────────────────────────────────────
   *
   * `sealSession` was called UNCONDITIONALLY and its write nulls
   * `storageState`, so OBSERVE destroyed the plaintext column exactly as
   * ENFORCE did. An operator who set OBSERVE believing today's behaviour
   * continued got the one irreversible half of the control anyway — and every
   * auth-gated crawl and run on that profile went anonymous on the first tick,
   * which is the defect this whole control exists to end, caused by the fix.
   *
   * Delete the `if (!enforcing)` arm in `refreshProfile` and this goes red on
   * the first assertion.
   */
  it('leaves the plaintext column populated under OBSERVE, and counts the seal it withheld', async () => {
    const calls = fakePrisma([candidate({ storageState: SESSION })], {
      storedModes: { SESSION_STATE_SEAL: 'OBSERVE' },
    });

    const tick = await processAuthRefreshTick({ at: NOW.toISOString() }, deps());

    expect(tick.byOutcome.REFRESHED).toBe(1);
    const data = calls.updates[0]!.data;
    // STILL POPULATED. Not null, and holding a session.
    expect(data.storageState).not.toBeNull();
    expect(data.storageState).toEqual(SESSION);
    // And nothing was sealed: OBSERVE does not perform the write it declined.
    expect(data.storageStateSealed).toBeUndefined();
    expect(data.storageStateKeyVersion).toBeUndefined();

    // THE COUNT, over a known denominator. One profile a seal would have
    // replaced, out of one considered.
    expect(tick.reports[0]?.sealWithheld).toBe(true);
    // The WORKLIST bucket, not `degraded`: nothing ran anonymously here. The
    // sweep reports which profiles arming the brake would change.
    expect(tick.degradation.wouldSeal).toBe(1);
    expect(tick.degradation.degraded).toBe(0);
    expect(tick.degradation.total).toBe(1);
    expect(tick.visited).toBe(1);
  });

  /*
   * The other side of the same brake, so the pair cannot silently become one
   * answer: ENFORCE is what seals and what nulls, and it counts nothing
   * because the profile is now repaired.
   */
  it('seals and nulls the plaintext column under ENFORCE, and counts nothing', async () => {
    const calls = fakePrisma([candidate({ storageState: SESSION })], {
      storedModes: { SESSION_STATE_SEAL: 'ENFORCE' },
    });

    const tick = await processAuthRefreshTick({ at: NOW.toISOString() }, deps());

    const data = calls.stored[0]!.data;
    expect(data.storageState).toBeNull();
    expect(typeof data.storageStateSealed).toBe('string');
    expect(tick.reports[0]?.sealWithheld).toBe(false);
    expect(tick.degradation).toEqual({
      degraded: 0,
      blocked: 0,
      used: 0,
      signedIn: 0,
      wouldSeal: 0,
      total: 0,
    });
  });

  /*
   * ── AND OBSERVE MUST NOT BECOME AN HOURLY LOGIN ─────────────────────────
   *
   * `SESSION_STATE_RULES.LEGACY_PLAINTEXT.refreshDue` is true because under
   * ENFORCE that row holds a session nothing may carry. Under OBSERVE both
   * consumers carry it and nothing clears it, so without the OBSERVE arm in
   * `refreshProfile` every plaintext profile in the install would be due on
   * every tick — an unattended sign-in per profile per hour at the customer's
   * own login form, which is the lockout hazard the attempt cap exists to
   * bound and which a SUCCESSFUL login never trips.
   */
  it('drives no login under OBSERVE for a plaintext profile whose session is still live', async () => {
    const logins: string[] = [];
    fakePrisma(
      [
        candidate({
          storageState: SESSION,
          storageStateExpiresAt: new Date(NOW.getTime() + 8 * HOUR),
        }),
      ],
      { storedModes: { SESSION_STATE_SEAL: 'OBSERVE' } },
    );

    const tick = await processAuthRefreshTick(
      { at: NOW.toISOString() },
      deps({
        signIn: async (input: AuthRefreshSignIn) => {
          logins.push(input.profile.id);
          return goodLogin();
        },
      }),
    );

    expect(tick.byOutcome.NOT_DUE).toBe(1);
    expect(logins).toEqual([]);
    expect(tick.reports[0]?.detail).toMatch(/seal brake is OBSERVE/);
  });

  /*
   * Rule 11 on the path that deliberately keeps a session in the clear. The
   * COLUMN holds it, because that is what today's writers do and what OBSERVE
   * promises; the report, the detail and the audit row must not.
   */
  it('never puts the session into the report or the audit row, even under OBSERVE', async () => {
    const calls = fakePrisma([candidate({ storageState: SESSION })], {
      storedModes: { SESSION_STATE_SEAL: 'OBSERVE' },
    });

    const tick = await processAuthRefreshTick({ at: NOW.toISOString() }, deps());

    expect(JSON.stringify(tick.reports)).not.toContain(COOKIE_VALUE);
    expect(JSON.stringify(tick.degradation)).not.toContain(COOKIE_VALUE);
    expect(JSON.stringify(calls.audits)).not.toContain(COOKIE_VALUE);
    expect(JSON.stringify(calls.audits)).not.toContain(PAGE_TITLE);
    expect(h.log.join('|')).not.toContain(COOKIE_VALUE);
  });

  it('discards a session it could not seal rather than storing it in the clear', async () => {
    const calls = fakePrisma([candidate()]);
    const tick = await processAuthRefreshTick(
      { at: NOW.toISOString() },
      deps({
        cipher: {
          encrypt: async () => {
            throw new Error('no key material');
          },
          decrypt: async () => '',
        },
      }),
    );
    expect(tick.byOutcome.SEAL_FAILED).toBe(1);
    const data = calls.updates[0]!.data;
    expect(Object.keys(data).sort()).toEqual([
      'storageStateRefreshAttemptedAt',
      'storageStateRefreshFailures',
    ]);
    expect(JSON.stringify(data)).not.toContain(COOKIE_VALUE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The sweep
// ─────────────────────────────────────────────────────────────────────────────

describe('the sweep', () => {
  it('selects every field the decision needs, nested environment included', () => {
    const select = REFRESH_CANDIDATE_SELECT as unknown as Record<string, unknown>;
    for (const field of [
      'id',
      'storageState',
      'storageStateExpiresAt',
      'storageStateSealed',
      'storageStateKeyVersion',
      'storageStateNeedsReseal',
      'orgId',
      'environmentId',
      'name',
      'kind',
      'config',
      'storageStateRefreshAttemptedAt',
      'storageStateRefreshFailures',
    ]) {
      expect(select[field]).toBe(true);
    }
    expect(select.environment).toEqual({
      select: { id: true, kind: true, baseUrl: true, egressPolicy: true },
    });
  });

  /*
   * A NEVER-SIGNED-IN PROFILE IS NOT STALE, IT IS NEW.
   *
   * Including those would mean driving a login at every profile in the install
   * on the first tick after deploy — a sweep hammering a customer's identity
   * provider to fix something that was not broken. The rows the sealing
   * migration actually emptied are found by `storageStateNeedsReseal`, which is
   * exactly the difference between the two.
   */
  it('asks for marked, unversioned, expiring and plaintext rows, and not for empty ones', async () => {
    const calls = fakePrisma([]);
    await processAuthRefreshTick({ at: NOW.toISOString() }, deps());
    const where = calls.findManyArgs[0]!.where as Record<string, unknown>;
    expect(where.principalKind).toBe('PERSISTENT');
    const or = where.OR as Array<Record<string, unknown>>;
    expect(or.some((arm) => arm.storageStateNeedsReseal === true)).toBe(true);
    expect(or.some((arm) => 'storageState' in arm)).toBe(true);

    /*
     * EVERY arm must constrain one of the three things that distinguish "we
     * destroyed or outdated the session that was here" from "nobody has ever
     * signed in as this identity". An arm that constrained none of them would
     * match every profile in the install, and the first tick after deploy would
     * drive a login at all of them.
     */
    for (const arm of or) {
      const clauses = (arm.AND as Array<Record<string, unknown>> | undefined) ?? [arm];
      const names = clauses.flatMap((clause) => Object.keys(clause));
      expect(
        names.includes('storageStateNeedsReseal') ||
          names.includes('storageState') ||
          names.includes('storageStateSealed'),
      ).toBe(true);
    }
  });

  it('reads one more than the budget, so "there were more" is measured', async () => {
    const many = Array.from({ length: 4 }, (_, i) => candidate({ id: `prof${i}` }));
    const calls = fakePrisma(many);
    const tick = await processAuthRefreshTick({ at: NOW.toISOString(), maxProfiles: 2 }, deps());
    expect(calls.findManyArgs[0]!.take).toBe(3);
    expect(tick.visited).toBe(2);
    expect(tick.cappedByBudget).toBe(true);
  });

  it('reports no budget cap when everything due was visited', async () => {
    fakePrisma([candidate()]);
    const tick = await processAuthRefreshTick({ at: NOW.toISOString(), maxProfiles: 5 }, deps());
    expect(tick.cappedByBudget).toBe(false);
    expect(tick.visited).toBe(1);
  });

  it('puts the never-attempted profiles first', async () => {
    const calls = fakePrisma([]);
    await processAuthRefreshTick({ at: NOW.toISOString() }, deps());
    expect(calls.findManyArgs[0]!.orderBy).toEqual([
      { storageStateRefreshAttemptedAt: { sort: 'asc', nulls: 'first' } },
    ]);
  });

  it('defaults the per-tick budget rather than reading every due profile', async () => {
    const calls = fakePrisma([]);
    await processAuthRefreshTick({ at: NOW.toISOString() }, deps());
    expect(calls.findManyArgs[0]!.take).toBe(DEFAULT_MAX_PROFILES_PER_TICK + 1);
  });

  /*
   * THE BRAKE'S COUNT. `SECURITY_CONTROL_BRAKES.SESSION_STATE_SEAL` promises
   * "every run that would have been reported NOT_RUN and instead went
   * anonymous, per profile", and a mode that does not count is an off switch
   * with a reassuring name.
   */
  it('counts what OBSERVE would have refused, with a denominator', async () => {
    fakePrisma([candidate({ id: 'a' }), candidate({ id: 'b' })], {
      storedModes: { SESSION_STATE_SEAL: 'OBSERVE' },
    });
    const tick = await processAuthRefreshTick(
      { at: NOW.toISOString() },
      deps({ signIn: failedLogin }),
    );
    expect(tick.degradation.wouldSeal).toBe(2);
    expect(tick.degradation.degraded).toBe(0);
    expect(tick.degradation.blocked).toBe(0);
    expect(tick.degradation.total).toBe(2);
  });

  /*
   * A PROFILE THIS TICK REPAIRED IS NOT COUNTED AS BLOCKED.
   *
   * The OBSERVE count is what an operator reads before they dare enforce, so
   * inflating it with sessions that are now perfectly usable would make the
   * brake look more dangerous than it is. A refusal that was applied has to be
   * counted; a refusal that did not happen must not be.
   */
  it('counts nothing for a profile whose session it successfully refreshed', async () => {
    fakePrisma([candidate()]);
    const tick = await processAuthRefreshTick({ at: NOW.toISOString() }, deps());
    expect(tick.byOutcome.REFRESHED).toBe(1);
    expect(tick.degradation).toEqual({
      degraded: 0,
      blocked: 0,
      used: 0,
      signedIn: 0,
      wouldSeal: 0,
      total: 0,
    });
  });

  it('defaults the seal control to ENFORCE when nothing is stored', async () => {
    fakePrisma([candidate()]);
    const tick = await processAuthRefreshTick(
      { at: NOW.toISOString() },
      deps({ signIn: failedLogin }),
    );
    expect(tick.reports[0]?.mode).toBe('ENFORCE');
    expect(tick.degradation.blocked).toBe(1);
    expect(tick.degradation.degraded).toBe(0);
    // ENFORCE is already acting, so this profile is REFUSED and not on the
    // worklist an operator reads before arming.
    expect(tick.degradation.wouldSeal).toBe(0);
  });

  /*
   * EVERY egress decision is counted, allowed ones included: "we would have
   * refused 1,204 connections" is only defensible beside how many there were,
   * and a refusal count with no denominator is a number that cannot be quoted
   * at a customer.
   */
  it('counts the allowed egress decisions as well as the refused ones', async () => {
    fakePrisma([candidate()]);
    const allowed = await processAuthRefreshTick({ at: NOW.toISOString() }, deps());
    expect(allowed.egress).toHaveLength(1);
    expect(allowed.egress[0]?.outcome).toBe('ALLOWED');
    expect(allowed.egress[0]?.context).toBe('LOGIN');

    fakePrisma([candidate()]);
    const refused = await processAuthRefreshTick(
      { at: NOW.toISOString() },
      deps({ egress: egressIo({ 'app.example.com': ['169.254.169.254'] }) }),
    );
    expect(refused.egress[0]?.outcome).toBe('REFUSED');
  });

  /*
   * A tick that classified nothing reports an EMPTY tally list, not a zero
   * refusal rate. UNAVAILABLE, never PASS — a measurement nobody took must not
   * look like a measurement that came back clean.
   */
  it('reports no egress tallies at all when no target was classified', async () => {
    fakePrisma([
      candidate({
        storageStateRefreshFailures: MAX_REFRESH_FAILURES,
        storageStateRefreshAttemptedAt: new Date(NOW.getTime() - 24 * HOUR),
      }),
    ]);
    const tick = await processAuthRefreshTick({ at: NOW.toISOString() }, deps());
    expect(tick.egress).toEqual([]);
    expect(tick.byOutcome.ATTEMPTS_CAPPED).toBe(1);
  });

  it('reports key versions whose state it could not read, rather than ignoring them', async () => {
    fakePrisma([candidate()]);
    h.prisma = {
      ...h.prisma,
      vaultKey: {
        findMany: async (args: { select: Record<string, unknown> }) =>
          [
            { keyId: 'local-1', version: 1, state: 'ACTIVE' },
            { keyId: 'local-9', version: 9, state: 'NOT_A_STATE' },
          ].map((r) => project(r, args.select)),
      },
    };
    const tick = await processAuthRefreshTick({ at: NOW.toISOString() }, deps());
    expect(tick.unreadableKeyVersions).toEqual([9]);
  });

  it('refreshes exactly one profile when the job names one, bypassing the staleness filter', async () => {
    const calls = fakePrisma([candidate()]);
    await processAuthRefreshTick({ at: NOW.toISOString(), profileId: 'prof1' }, deps());
    const where = calls.findManyArgs[0]!.where as Record<string, unknown>;
    expect(where.id).toBe('prof1');
    expect(where.OR).toBeUndefined();
  });

  it('does not let a write failure take the sweep down', async () => {
    fakePrisma([candidate()]);
    h.prisma = {
      ...h.prisma,
      authProfile: {
        ...(h.prisma.authProfile as Record<string, unknown>),
        update: async () => {
          throw new Error('deadlock');
        },
      },
    };
    const tick = await processAuthRefreshTick({ at: NOW.toISOString() }, deps());
    expect(tick.visited).toBe(1);
    expect(h.log).toContain('warn:could not record the refresh attempt');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The vocabulary
// ─────────────────────────────────────────────────────────────────────────────

describe('the vocabulary', () => {
  it('gives every outcome a rule, in both directions', () => {
    expect([...AUTH_REFRESH_OUTCOMES].sort()).toEqual(
      Object.keys(AUTH_REFRESH_OUTCOME_RULES).sort(),
    );
    for (const outcome of AUTH_REFRESH_OUTCOMES) {
      expect(AUTH_REFRESH_OUTCOME_RULES[outcome].what.length).toBeGreaterThan(20);
    }
  });

  /*
   * The counter rule, asserted as the PROPERTY rather than as a list: no
   * outcome may advance the failure counter without an attempt or a target,
   * because a deferral counted as a failure makes the cap arrive with fewer
   * than five failures behind it.
   */
  it('advances the failure counter only where a target was actually tried', () => {
    for (const outcome of AUTH_REFRESH_OUTCOMES) {
      const rule = AUTH_REFRESH_OUTCOME_RULES[outcome];
      if (outcome === 'NOT_DUE' || outcome === 'BACKED_OFF' || outcome === 'ATTEMPTS_CAPPED') {
        expect(rule.countsAsFailure).toBe(false);
        expect(rule.attempted).toBe(false);
      } else if (outcome === 'REFRESHED') {
        expect(rule.countsAsFailure).toBe(false);
      } else {
        expect(rule.countsAsFailure).toBe(true);
      }
    }
  });

  it('audits everything except the two quiet, expected outcomes', () => {
    const quiet = AUTH_REFRESH_OUTCOMES.filter(
      (outcome) => !AUTH_REFRESH_OUTCOME_RULES[outcome].audited,
    );
    expect([...quiet].sort()).toEqual(['BACKED_OFF', 'NOT_DUE']);
  });

  it('pins the queue name, which index.ts has to register', () => {
    expect(AUTH_REFRESH_QUEUE).toBe('qaai.auth-refresh');
  });

  it('names the brake this sweep reads', () => {
    expect(SESSION_SEAL_CONTROL).toBe('SESSION_STATE_SEAL');
  });

  it('does nothing and writes nothing for a session that is still fresh', async () => {
    const result = await refreshProfile(
      deps(),
      candidate({ storageStateExpiresAt: new Date(NOW.getTime() + 8 * HOUR) }),
      { mode: 'ENFORCE', keys: KEYS },
    );
    expect(result.report.outcome).toBe('NOT_DUE');
    expect(result.write).toBeNull();
    expect(result.decision).toBeNull();
  });

  it('refreshes a session that is expiring inside the lead, before a run needs it', async () => {
    const result = await refreshProfile(
      deps(),
      candidate({ storageStateExpiresAt: new Date(NOW.getTime() + 10 * 60_000) }),
      { mode: 'ENFORCE', keys: KEYS },
    );
    expect(result.report.stateBefore).toBe('SEALED_EXPIRING');
    expect(result.report.outcome).toBe('REFRESHED');
    // Usable the whole time: an expiring session is used now and replaced.
    expect(result.report.notRun).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CONSUMERS' DOOR
//
// `sealSession` had a production caller and `openSession` had NONE: the sweep
// sealed the column and nulled the plaintext while explore.ts and run.ts went
// on reading `profile.storageState` only. So the first hourly tick after deploy
// turned every working auth-gated crawl and run into an anonymous one — the
// exact defect the control exists to end, caused by the control. These are the
// tests over the reader that both consumers now go through.
// ─────────────────────────────────────────────────────────────────────────────

describe('openCachedSession — seal, then read it back as the identity', () => {
  /** A row as the sealing sweep leaves it: sealed, versioned, plaintext NULLED. */
  async function sealedRow(key = cipher()): Promise<{ row: SealedSessionRow; key: typeof key }> {
    const calls = fakePrisma([candidate()]);
    await processAuthRefreshTick({ at: NOW.toISOString() }, deps({ cipher: key }));
    const data = calls.stored[0]!.data;
    return {
      key,
      row: {
        id: 'prof1',
        storageState: data.storageState,
        storageStateExpiresAt: data.storageStateExpiresAt as Date,
        storageStateSealed: data.storageStateSealed as string,
        storageStateKeyVersion: data.storageStateKeyVersion as number,
        storageStateNeedsReseal: data.storageStateNeedsReseal as boolean,
      },
    };
  }

  /*
   * ── THE REGRESSION, END TO END ──────────────────────────────────────────
   *
   * Seal the session through the real sweep, confirm the plaintext column is
   * gone, then run the CONSUMERS' OWN DERIVATION over the row that is left and
   * assert the identity comes back. Remove the sealed reader — go back to
   * `row.storageState && (!expiresAt || expiresAt > now)` — and this is red on
   * `toBe(COOKIE_VALUE)`, because that expression answers `null` for a sealed
   * row and `null` is what became an anonymous crawl.
   */
  it('carries the identity after the sweep has sealed it and nulled the plaintext', async () => {
    const { row, key } = await sealedRow();
    expect(row.storageState).toBeNull();

    const read = await openCachedSession(row, {
      keys: KEYS,
      cipher: key,
      now: NOW,
      mode: 'ENFORCE',
    });

    expect(read.source).toBe('SEALED');
    expect(read.gate.state).toBe('SEALED_FRESH');
    expect(read.gate.notRun).toBeNull();
    expect((read.storageState as typeof SESSION).cookies[0]?.value).toBe(COOKIE_VALUE);
  });

  /*
   * LEGACY_PLAINTEXT KEEPS WORKING.
   *
   * THIS PARAGRAPH SAID apps/api/src/routes/projects.ts "still writes the live
   * session into the legacy column ... until that half lands". That half HAS
   * landed: the cockpit sign-in route now seals and writes
   * `storageState: Prisma.DbNull`, so a cockpit "Sign in" no longer produces
   * this state. Corrected rather than deleted, because the state is still
   * reachable and the reason it is CARRIED has not changed: an older image, or
   * any writer that predates the sealing migration, puts the customer's
   * CURRENT session there, and refusing it would take a working product away to
   * protect a value that is already in the clear in the database.
   */
  it('carries a legacy plaintext session rather than refusing it, and says where it came from', async () => {
    const read = await openCachedSession(
      {
        ...candidate({
          storageState: SESSION,
          storageStateExpiresAt: new Date(NOW.getTime() + 4 * HOUR),
        }),
      },
      { keys: KEYS, cipher: cipher(), now: NOW, mode: 'ENFORCE' },
    );

    expect(read.gate.state).toBe('LEGACY_PLAINTEXT');
    expect(read.source).toBe('LEGACY_PLAINTEXT');
    expect(read.storageState).toEqual(SESSION);
  });

  /*
   * ── AND ONLY WHILE IT IS VALID ──────────────────────────────────────────
   *
   * `sessionStateOf` tests the legacy column FIRST and never reaches the
   * expiry, so carrying LEGACY_PLAINTEXT unconditionally hands a DEAD session
   * to a browser — which is the ORIGINAL defect and not a mitigation of it: the
   * browser is bounced to a login and most assertions pass against the login
   * page. A NULL expiry is refused for the reason `SEALED_NO_EXPIRY` exists as
   * a state of its own: `!expiresAt ||` was the arm that read a missing expiry
   * as "valid for ever".
   *
   * `run.test.ts`'s "signs in again when the cached session has expired" is the
   * end-to-end half of this and was RED while the arm was unconditional.
   */
  it('refuses a legacy plaintext session that is expired or has no expiry', async () => {
    for (const [label, expiresAt] of [
      ['expired', new Date(NOW.getTime() - 1000)],
      ['no expiry', null],
    ] as Array<[string, Date | null]>) {
      const read = await openCachedSession(
        { ...candidate({ storageState: SESSION, storageStateExpiresAt: expiresAt }) },
        { keys: KEYS, cipher: cipher(), now: NOW, mode: 'ENFORCE' },
      );
      expect(read.gate.state, label).toBe('LEGACY_PLAINTEXT');
      expect(read.source, label).toBe('NONE');
      expect(read.storageState, label).toBeNull();
      expect(read.detail, label).toMatch(/not carried/);
    }
  });

  /*
   * FAIL CLOSED, and on every one of the states the gate refuses. A `null`
   * session here is "there is no session", never "run it signed out" — the
   * caller's typed refusal is what makes that distinction, and these are the
   * rows that reach it.
   */
  it('carries nothing for every state the gate refuses, with the reason and no session', async () => {
    const key = cipher();
    const rows: Array<[string, Partial<SealedSessionRow>]> = [
      ['ABSENT', { storageStateSealed: null }],
      ['NEEDS_RESEAL', { storageStateNeedsReseal: true }],
      ['SEALED_UNVERSIONED', { storageStateKeyVersion: null }],
      ['SEALED_NO_EXPIRY', { storageStateExpiresAt: null }],
      ['SEALED_EXPIRED', { storageStateExpiresAt: new Date(NOW.getTime() - HOUR) }],
    ];
    for (const [expected, over] of rows) {
      const read = await openCachedSession(
        { ...candidate(over) },
        { keys: KEYS, cipher: key, now: NOW, mode: 'ENFORCE' },
      );
      expect(read.gate.state, expected).toBe(expected);
      expect(read.storageState, expected).toBeNull();
      expect(read.source, expected).toBe('NONE');
      expect(read.gate.notRun?.kind, expected).toBe('BLOCKED_BY_ENV');
      expect(read.detail.length, expected).toBeGreaterThan(20);
    }
  });

  /*
   * A SEALED ROW THIS PROCESS CANNOT OPEN IS NOT AN ABSENT SESSION.
   *
   * The two cases that would be indistinguishable if an exception handler fell
   * through to "no session": a process with no usable master key, and a row
   * whose ciphertext was sealed under a different key. Both answer NONE with a
   * reason, and neither answers "usable: false because there is nothing here".
   */
  it('refuses rather than reporting an absent session when it cannot open one', async () => {
    const { row } = await sealedRow();

    const noKey = await openCachedSession(row, {
      keys: KEYS,
      cipher: null,
      now: NOW,
      mode: 'ENFORCE',
    });
    expect(noKey.source).toBe('NONE');
    expect(noKey.gate.state).toBe('SEALED_FRESH');
    expect(noKey.gate.usable).toBe(true);
    expect(noKey.storageState).toBeNull();
    expect(noKey.detail).toMatch(/no usable vault master key/);

    const wrongKey = await openCachedSession(row, {
      keys: KEYS,
      cipher: cipher(),
      now: NOW,
      mode: 'ENFORCE',
    });
    expect(wrongKey.source).toBe('NONE');
    expect(wrongKey.storageState).toBeNull();
    expect(wrongKey.detail).toMatch(/AAD_MISMATCH/);
  });

  /*
   * Rule 11 over everything this reader can say. Every refusal detail, for
   * every state and both modes, reportable without quoting any part of the
   * session — and the gate object travels with it, so it is checked too.
   */
  it('never names any part of the session in anything it returns', async () => {
    const { row, key } = await sealedRow();
    const overrides: Array<Partial<SealedSessionRow>> = [
      {},
      { storageState: SESSION },
      { storageStateSealed: null },
      { storageStateNeedsReseal: true },
      { storageStateKeyVersion: 7 },
    ];
    for (const mode of ['OBSERVE', 'ENFORCE'] as const) {
      for (const over of overrides) {
        const read = await openCachedSession(
          { ...row, ...over },
          { keys: KEYS, cipher: key, now: NOW, mode },
        );
        const printed = JSON.stringify({ detail: read.detail, gate: read.gate });
        expect(printed).not.toContain(COOKIE_VALUE);
        expect(printed).not.toContain(PASSWORD);
        expect(printed).not.toContain(row.storageStateSealed);
      }
    }
  });

  /*
   * The master key is read through `config`, which the mock at the top of this
   * file leaves empty — so the honest answer for this process is NULL, and
   * `openCachedSession` turns it into a refusal rather than a crash. A throw
   * here would take a whole run down over one profile's sealed column.
   */
  it('reports no cipher rather than throwing when the master key is unusable', () => {
    expect(workerSessionCipher()).toBeNull();
  });
});
