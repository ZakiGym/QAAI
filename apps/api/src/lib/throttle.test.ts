/**
 * Tests for per-identifier and per-source login throttling.
 *
 * What is being proven, worst defect first:
 *
 *   1. CREDENTIAL STUFFING IS NO LONGER UNIMPEDED. Failures accumulate, the
 *      backoff grows, and the identifier locks at the policy's threshold. Every
 *      one of those assertions fails against the state this round started in,
 *      where nothing counted anything.
 *
 *   2. THE CONTROL IS NOT AN ACCOUNT-ENUMERATION ORACLE. A row is created for
 *      an address with NO ACCOUNT, and nothing in this module reads, takes or
 *      returns anything that depends on whether the identifier is known. The
 *      HTTP half of that claim — identical body and identical timing — is in
 *      routes/auth.test.ts, because it is a property of the response.
 *
 *   3. THE CONTROL IS NOT A DENIAL-OF-SERVICE WEAPON EITHER. The first half of
 *      the budget is free, the lock is bounded, an existing lock is never
 *      extended by further guessing, and a completed password reset clears it.
 *
 *   4. THE SOURCE COUNTER NEVER HARD-LOCKS. An office behind one NAT address is
 *      one source; locking it is locking a building out of its own account.
 *
 *   5. A CAP APPLIED IS A CAP COUNTED. `LOCKED_OUT` rows are what the OBSERVE
 *      brake owes, and `countWouldHaveRefused` reads them rather than keeping a
 *      second number that could disagree.
 *
 * The prisma stand-in HONOURS `select`: a select-blind fake makes deleting a
 * field from a query undetectable, and two defects survived a whole slice
 * behind one. It also refuses an unknown filter rather than shrugging at it, so
 * a `where` clause that quietly stopped being applied is a thrown error here
 * instead of a passing test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_THROTTLE_DEFAULTS } from '@qaai/shared';
import type { LoginThrottlePolicy } from '@qaai/shared';

type Row = Record<string, any>;

interface Hoisted {
  throttles: Row[];
  attempts: Row[];
  failCreate: boolean;
  /**
   * `'ABSENT'` makes every `loginThrottle` query throw Postgres's
   * "relation does not exist" exactly as Prisma reports it, which is the state
   * a deployment is in before `prisma migrate deploy` runs. `'UNREADABLE'`
   * throws something else, which must keep failing closed. Two flags would let
   * a test set both; one field cannot.
   */
  throttleTable: 'PRESENT' | 'ABSENT' | 'UNREADABLE';
  /** How many times `loginThrottle.findUnique` was ENTERED, including throws. */
  throttleReads: number;
}

const h = vi.hoisted(
    (): Hoisted => ({
    throttles: [],
    attempts: [],
    failCreate: false,
    throttleTable: 'PRESENT',
    throttleReads: 0,
  }),
);

vi.mock('../env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  },
  isProd: false,
}));

/** The filters these queries are allowed to use. Anything else throws. */
const KNOWN_FILTERS: Record<string, Set<string>> = {
  loginThrottle: new Set(['identifierHash']),
  loginAttempt: new Set(['identifierHash', 'outcome', 'createdAt']),
};

function matches(value: unknown, cond: unknown): boolean {
  if (cond === null) return (value ?? null) === null;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (cond && typeof cond === 'object') {
    const c = cond as Row;
    if ('gte' in c) return value instanceof Date && value.getTime() >= (c.gte as Date).getTime();
    throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
  }
  return value === cond;
}

function matchesWhere(model: string, row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (!KNOWN_FILTERS[model]!.has(key)) {
      throw new Error(`fake prisma: unsupported filter on ${model}.${key}`);
    }
    return matches(row[key] ?? null, cond);
  });
}

/**
 * `select` is HONOURED, and the missing-column case is a THROW rather than a
 * null. `readThrottle` reads four columns through one shared constant; if a
 * future edit drops one from that constant the caller would read `undefined`
 * and the window arithmetic would silently become `NaN`, which compares false
 * against everything and means "never expired". That is a throw here.
 */
function projectRow(model: string, row: Row, sel: Row | undefined): Row {
  if (!sel) return { ...row };
  const out: Row = {};
  for (const [key, want] of Object.entries(sel)) {
    if (want !== true) throw new Error(`fake prisma: unsupported select on ${model}.${key}`);
    if (!(key in row)) throw new Error(`fake prisma: ${model} has no column ${key}`);
    out[key] = row[key];
  }
  return out;
}

let sequence = 0;

/** Columns the database would default. Mirrors the model, per model. */
const THROTTLE_DEFAULTS: Row = {
  failures: 0,
  lockedUntil: null,
  lockCount: 0,
  lastFailureAt: null,
  lastSuccessAt: null,
};

vi.mock('./prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();

  /**
   * The two failures the read has to tell apart, as the DATABASE produces them.
   *
   * Shaped on `PrismaClientKnownRequestError`: the recogniser keys on `code`
   * and nothing looser, so a fake that only carried a message would pass a test
   * the real error would fail. `P1001` is "cannot reach the database" — a real
   * code that must NOT be read as a missing relation.
   */
  const refuseIfUnavailable = () => {
    if (h.throttleTable === 'PRESENT') return;
    const err = new Error(
      h.throttleTable === 'ABSENT'
        ? 'The table `public.LoginThrottle` does not exist in the current database.'
        : "Can't reach database server",
    ) as Error & { code: string };
    err.name = 'PrismaClientKnownRequestError';
    err.code = h.throttleTable === 'ABSENT' ? 'P2021' : 'P1001';
    throw err;
  };

  const loginThrottle = {
    findUnique: async ({ where, select }: Row) => {
      // Counted BEFORE the throw, so "it did not read twice" is a measurement
      // and not an inference from the absence of a second error.
      h.throttleReads += 1;
      refuseIfUnavailable();
      const found = h.throttles.find((row) => matchesWhere('loginThrottle', row, where));
      return found ? projectRow('loginThrottle', found, select) : null;
    },
    upsert: async ({ where, create, update, select }: Row) => {
      refuseIfUnavailable();
      const found = h.throttles.find((row) => matchesWhere('loginThrottle', row, where));
      if (found) {
        Object.assign(found, update);
        found.updatedAt = new Date();
        return projectRow('loginThrottle', found, select);
      }
      sequence += 1;
      const row: Row = {
        id: `thr_${sequence}`,
        ...THROTTLE_DEFAULTS,
        ...create,
        updatedAt: new Date(),
      };
      h.throttles.push(row);
      return projectRow('loginThrottle', row, select);
    },
    updateMany: async ({ where, data }: Row) => {
      const hits = h.throttles.filter((row) => matchesWhere('loginThrottle', row, where));
      for (const row of hits) Object.assign(row, data);
      return { count: hits.length };
    },
  };

  const loginAttempt = {
    create: async ({ data, select }: Row) => {
      if (h.failCreate) throw new Error('fake prisma: loginAttempt.create refused');
      sequence += 1;
      const row: Row = { id: `att_${sequence}`, createdAt: new Date(), ...data };
      h.attempts.push(row);
      return projectRow('loginAttempt', row, select);
    },
    count: async ({ where }: Row = {}) =>
      h.attempts.filter((row) => matchesWhere('loginAttempt', row, where ?? {})).length,
  };

  return {
    prisma: { loginThrottle, loginAttempt },
    withTenant: <T>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

const {
  BACKOFF_BASE_MS,
  throttleTableAbsent,
  BACKOFF_CAP_MS,
  SOURCE_FAILURE_MULTIPLIER,
  backoffFor,
  checkLoginThrottle,
  clearLoginLock,
  countWouldHaveRefused,
  readThrottle,
  recordFailure,
  recordLoginAttempt,
  recordSuccess,
  throttleKey,
  throttleVerdict,
  windowExpired,
} = await import('./throttle.js');

const POLICY: LoginThrottlePolicy = LOGIN_THROTTLE_DEFAULTS;
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const KNOWN = 'person@example.test';
/** No account anywhere. The row this address gets is the point of the control. */
const UNKNOWN = 'nobody-at-all@example.test';
const SOURCE = '203.0.113.9';

beforeEach(() => {
  h.throttles = [];
  h.attempts = [];
  h.failCreate = false;
  h.throttleTable = 'PRESENT';
  h.throttleReads = 0;
});

afterEach(() => {
  h.failCreate = false;
});

describe('the counter key', () => {
  it('is a hex SHA-256 digest, which is what the write schema requires', () => {
    expect(throttleKey('email', KNOWN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('separates the two namespaces, so a source can never collide with an address', () => {
    // Without the prefix, an installation whose users are identified by IP-like
    // strings would share one counter with the source bucket — and locking an
    // identifier would throttle a network.
    expect(throttleKey('email', SOURCE)).not.toBe(throttleKey('source', SOURCE));
  });

  it('is case- and whitespace-insensitive, because an address is', () => {
    expect(throttleKey('email', ' Person@Example.TEST ')).toBe(throttleKey('email', KNOWN));
  });
});

describe('the backoff', () => {
  it('is FREE for the first half of the budget, so a human mistyping notices nothing', () => {
    const free = Math.ceil(POLICY.maxFailures / 2);
    for (let failures = 0; failures <= free; failures += 1) {
      expect(backoffFor(failures, POLICY)).toBe(0);
    }
    expect(backoffFor(free + 1, POLICY)).toBe(BACKOFF_BASE_MS);
  });

  it('doubles, and then stops at the cap', () => {
    const free = Math.ceil(POLICY.maxFailures / 2);
    expect(backoffFor(free + 2, POLICY)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffFor(free + 3, POLICY)).toBe(BACKOFF_BASE_MS * 4);
    // Capped rather than unbounded: every held request is a held socket, and a
    // throttle that becomes a memory-exhaustion surface has traded one
    // availability problem for another.
    expect(backoffFor(free + 40, POLICY)).toBe(BACKOFF_CAP_MS);
  });
});

describe('one counter, as a pure verdict', () => {
  const state = (over: Row = {}) => ({
    failures: 0,
    windowStart: new Date(NOW),
    lockedUntil: null,
    lockCount: 0,
    ...over,
  });

  it('treats a MISSING row as a first attempt, which is what almost every login is', () => {
    expect(throttleVerdict(null, POLICY, NOW)).toEqual({
      wouldRefuse: false,
      backoffMs: 0,
      failures: 0,
      lockedUntil: null,
    });
  });

  it('refuses at the threshold and not before it', () => {
    expect(throttleVerdict(state({ failures: POLICY.maxFailures - 1 }), POLICY, NOW).wouldRefuse).toBe(
      false,
    );
    expect(throttleVerdict(state({ failures: POLICY.maxFailures }), POLICY, NOW).wouldRefuse).toBe(
      true,
    );
  });

  it('refuses while a lock is live and stops the moment it lifts', () => {
    const lockedUntil = new Date(NOW + 60_000);
    expect(throttleVerdict(state({ failures: 99, lockedUntil }), POLICY, NOW).wouldRefuse).toBe(true);
    // One millisecond after the lock, with the window also expired: allowed.
    const after = NOW + 60_001 + POLICY.windowMinutes * 60_000;
    expect(throttleVerdict(state({ failures: 99, lockedUntil }), POLICY, after).wouldRefuse).toBe(
      false,
    );
  });

  it('pays the FULL backoff while locked, so "locked" cannot be timed apart from "nearly"', () => {
    const lockedUntil = new Date(NOW + 60_000);
    expect(throttleVerdict(state({ failures: 3, lockedUntil }), POLICY, NOW).backoffMs).toBe(
      BACKOFF_CAP_MS,
    );
  });

  it('forgets failures once the window has passed', () => {
    const old = state({ failures: POLICY.maxFailures, windowStart: new Date(NOW) });
    const later = NOW + POLICY.windowMinutes * 60_000;
    expect(windowExpired(old, POLICY, later)).toBe(true);
    const verdict = throttleVerdict(old, POLICY, later);
    expect(verdict.failures).toBe(0);
    expect(verdict.wouldRefuse).toBe(false);
  });

  it('NEVER refuses in the source namespace, whatever the count', () => {
    const verdict = throttleVerdict(state({ failures: 10_000 }), POLICY, NOW, { canLock: false });
    // An office behind one NAT address is one source. The backoff still applies
    // — that is the brake — but the hard refusal does not.
    expect(verdict.wouldRefuse).toBe(false);
    expect(verdict.backoffMs).toBe(BACKOFF_CAP_MS);
  });
});

describe('writing failures', () => {
  it('CREATES A ROW FOR AN ADDRESS WITH NO ACCOUNT — the no-oracle property', async () => {
    const key = throttleKey('email', UNKNOWN);
    await recordFailure(key, POLICY, NOW);
    const row = await readThrottle(key);
    // If the counter existed only for known addresses, "did a row appear" would
    // answer "does this account exist" for anybody with database access, and
    // the throttle itself would be unable to slow a list-walk.
    expect(row?.failures).toBe(1);
  });

  it('accumulates, and locks exactly at the threshold', async () => {
    const key = throttleKey('email', KNOWN);
    let last = { failures: 0, lockedUntil: null as Date | null, lockCount: 0 };
    for (let i = 1; i <= POLICY.maxFailures; i += 1) {
      last = await recordFailure(key, POLICY, NOW + i * 1000);
      if (i < POLICY.maxFailures) expect(last.lockedUntil).toBeNull();
    }
    expect(last.failures).toBe(POLICY.maxFailures);
    expect(last.lockedUntil).not.toBeNull();
    expect(last.lockCount).toBe(1);
  });

  it('NEVER SHORTENS AN EXISTING LOCK, so guessing cannot end the lock early', async () => {
    const key = throttleKey('email', KNOWN);
    for (let i = 1; i <= POLICY.maxFailures; i += 1) await recordFailure(key, POLICY, NOW + i);
    const locked = (await readThrottle(key))!.lockedUntil!;

    // A failure one second before the lock lifts. Without the guard this writes
    // a NEW, LATER `lockedUntil` — which sounds harmless and is not: the
    // attacker controls when it is written, and a lock whose end they can move
    // is a lock they can also keep a legitimate user inside indefinitely.
    const nearlyOver = locked.getTime() - 1_000;
    await recordFailure(key, POLICY, nearlyOver);
    expect((await readThrottle(key))!.lockedUntil!.getTime()).toBe(locked.getTime());
  });

  it('starts a new window at ONE failure, not at eleven', async () => {
    const key = throttleKey('email', KNOWN);
    await recordFailure(key, POLICY, NOW);
    await recordFailure(key, POLICY, NOW + 1000);
    expect((await readThrottle(key))!.failures).toBe(2);

    const later = NOW + POLICY.windowMinutes * 60_000 + 1;
    const after = await recordFailure(key, POLICY, later);
    // A user who gets it wrong once a week must never be locked out.
    expect(after.failures).toBe(1);
  });

  it('does not lock in the source namespace however many failures arrive', async () => {
    const key = throttleKey('source', SOURCE);
    const sourcePolicy = {
      ...POLICY,
      maxFailures: POLICY.maxFailures * SOURCE_FAILURE_MULTIPLIER,
    };
    for (let i = 0; i < sourcePolicy.maxFailures + 5; i += 1) {
      await recordFailure(key, sourcePolicy, NOW + i, { canLock: false });
    }
    expect((await readThrottle(key))!.lockedUntil).toBeNull();
  });
});

describe('both counters, as one decision', () => {
  it('takes the WORST of the two, so neither can be walked around', async () => {
    // The identifier is clean; the source is deep into its backoff.
    const sourceKey = throttleKey('source', SOURCE);
    const sourcePolicy = {
      ...POLICY,
      maxFailures: POLICY.maxFailures * SOURCE_FAILURE_MULTIPLIER,
    };
    for (let i = 0; i < sourcePolicy.maxFailures; i += 1) {
      await recordFailure(sourceKey, sourcePolicy, NOW + i, { canLock: false });
    }

    const decision = await checkLoginThrottle({
      identifier: UNKNOWN,
      sourceIp: SOURCE,
      storedPolicy: null,
      nowMs: NOW + 1000,
    });
    // Narrowed, not asserted non-null: `identifier` and `source` are null on
    // the NOT_INSTALLED arm, and this test is about the MEASURED one.
    expect(decision.availability).toBe('MEASURED');
    if (decision.availability !== 'MEASURED') throw new Error('unreachable');
    expect(decision.identifier.backoffMs).toBe(0);
    expect(decision.backoffMs).toBeGreaterThan(0);
    // A distributed list-walk is stopped by the identifier counter and one host
    // walking a thousand addresses by the source counter. Reading only one is
    // how each attack gets through the control built for the other.
    expect(decision.backoffMs).toBe(decision.source.backoffMs);
  });

  it('gives a request with NO source address no source counter at all', async () => {
    const decision = await checkLoginThrottle({
      identifier: KNOWN,
      sourceIp: null,
      storedPolicy: null,
      nowMs: NOW,
    });
    // A shared "unknown" bucket would be one counter for every caller behind a
    // proxy that strips the header, locking them out of each other's accounts.
    expect(decision.source).toEqual({
      wouldRefuse: false,
      backoffMs: 0,
      failures: 0,
      lockedUntil: null,
    });
    expect(h.throttles).toHaveLength(0);
  });

  it('honours a stored per-org override, clamped', async () => {
    const key = throttleKey('email', KNOWN);
    // Three failures, and an org that asked to lock at three.
    for (let i = 0; i < 3; i += 1) await recordFailure(key, { ...POLICY, maxFailures: 3 }, NOW + i);

    const strict = await checkLoginThrottle({
      identifier: KNOWN,
      sourceIp: null,
      storedPolicy: { maxFailures: 3 },
      nowMs: NOW + 10,
    });
    expect(strict.wouldRefuse).toBe(true);

    // `maxFailures: 0` would lock the whole install out on its first attempt;
    // `resolveLoginThrottle` clamps it to 3, so this is still a refusal and not
    // a policy that refuses everybody.
    const clamped = await checkLoginThrottle({
      identifier: KNOWN,
      sourceIp: null,
      storedPolicy: { maxFailures: 0 },
      nowMs: NOW + 10,
    });
    expect(clamped.wouldRefuse).toBe(true);

    /*
     * A SEPARATE identifier for the generous case, and the reason is a finding
     * rather than tidiness: the three failures above LOCKED the first one, and
     * a live lock refuses whatever the threshold says — correctly, because the
     * lock was earned under the policy in force when it was written. Reusing
     * the same address here asserted that raising a threshold retroactively
     * releases a lock, which it must not.
     */
    const other = 'someone-else@example.test';
    for (let i = 0; i < 3; i += 1) {
      await recordFailure(throttleKey('email', other), { ...POLICY, maxFailures: 50 }, NOW + i);
    }
    const generous = await checkLoginThrottle({
      identifier: other,
      sourceIp: null,
      storedPolicy: { maxFailures: 50 },
      nowMs: NOW + 10,
    });
    expect(generous.wouldRefuse).toBe(false);
  });

  it('does not let a RAISED threshold release a lock that was already earned', async () => {
    const key = throttleKey('email', KNOWN);
    for (let i = 0; i < 3; i += 1) await recordFailure(key, { ...POLICY, maxFailures: 3 }, NOW + i);

    const relaxed = await checkLoginThrottle({
      identifier: KNOWN,
      sourceIp: null,
      storedPolicy: { maxFailures: 100 },
      nowMs: NOW + 10,
    });
    // The lock stands until it expires or somebody proves the mailbox. A
    // settings change that lifted every live lock would make the threshold a
    // way to end a lock rather than a way to set one.
    expect(relaxed.wouldRefuse).toBe(true);
  });

  it('falls back to the defaults for a malformed stored policy rather than to zero', async () => {
    for (const stored of [null, undefined, 'nonsense', [], { maxFailures: 'ten' }]) {
      const decision = await checkLoginThrottle({
        identifier: UNKNOWN,
        sourceIp: null,
        storedPolicy: stored,
        nowMs: NOW,
      });
      expect(decision.wouldRefuse).toBe(false);
    }
  });
});

describe('clearing, and the unlock path', () => {
  it('a SUCCESS resets the counter and releases the lock', async () => {
    const key = throttleKey('email', KNOWN);
    for (let i = 0; i < POLICY.maxFailures; i += 1) await recordFailure(key, POLICY, NOW + i);
    expect((await readThrottle(key))!.lockedUntil).not.toBeNull();

    await recordSuccess(key, NOW + 10_000);
    const row = (await readThrottle(key))!;
    // A correct credential after a lock expired must not leave the row one
    // failure away from locking again.
    expect(row.failures).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it('a COMPLETED PASSWORD RESET clears the lock — the door an attacker cannot reach', async () => {
    const key = throttleKey('email', KNOWN);
    for (let i = 0; i < POLICY.maxFailures; i += 1) await recordFailure(key, POLICY, NOW + i);

    await clearLoginLock(KNOWN, NOW + 1000);
    const row = (await readThrottle(key))!;
    expect(row.lockedUntil).toBeNull();
    expect(row.failures).toBe(0);
    // The LOCK COUNT survives. "Locked out forty times this month" is the
    // signal that separates a forgetful human from a password list, and a reset
    // must not erase it.
    expect(row.lockCount).toBe(1);
  });

  it('clears nothing for an address that was never locked, and does not create a row', async () => {
    await clearLoginLock(UNKNOWN, NOW);
    expect(h.throttles).toHaveLength(0);
  });
});

describe('the evidence log', () => {
  it('records the outcome, the source and nothing that could be a credential', async () => {
    await recordLoginAttempt({
      identifierHash: throttleKey('email', KNOWN),
      outcome: 'BAD_TOTP',
      ip: SOURCE,
      userAgent: 'qaai-cli/1.0',
    });
    expect(h.attempts).toHaveLength(1);
    // Four fields, and the schema this goes through has no room for a fifth.
    expect(Object.keys(h.attempts[0]!).sort()).toEqual(
      ['createdAt', 'id', 'identifierHash', 'ip', 'outcome', 'userAgent'].sort(),
    );
  });

  it('REFUSES a hash that is not a hex digest rather than storing a plaintext address', async () => {
    await recordLoginAttempt({
      identifierHash: KNOWN,
      outcome: 'BAD_PASSWORD',
      ip: null,
      userAgent: null,
    });
    // Silently dropped rather than written: this table must never become a
    // readable list of the addresses somebody is walking.
    expect(h.attempts).toHaveLength(0);
  });

  it('bounds a hostile user agent instead of storing it whole', async () => {
    await recordLoginAttempt({
      identifierHash: throttleKey('email', KNOWN),
      outcome: 'SUCCESS',
      ip: null,
      userAgent: 'x'.repeat(5_000),
    });
    expect(h.attempts[0]!.userAgent).toHaveLength(500);
  });

  it('SWALLOWS a write failure, so evidence cannot turn a correct login into a 500', async () => {
    h.failCreate = true;
    await expect(
      recordLoginAttempt({
        identifierHash: throttleKey('email', KNOWN),
        outcome: 'SUCCESS',
        ip: null,
        userAgent: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('COUNTS what OBSERVE mode would have refused, from the rows themselves', async () => {
    const key = throttleKey('email', KNOWN);
    await recordLoginAttempt({ identifierHash: key, outcome: 'LOCKED_OUT', ip: null, userAgent: null });
    await recordLoginAttempt({ identifierHash: key, outcome: 'LOCKED_OUT', ip: null, userAgent: null });
    await recordLoginAttempt({ identifierHash: key, outcome: 'BAD_PASSWORD', ip: null, userAgent: null });

    // Read off the attempt rows rather than kept as a second number, so the
    // count and the behaviour cannot disagree — a mode with a counter that can
    // drift is an off switch with a reassuring name.
    expect(await countWouldHaveRefused(NOW - 60_000)).toBe(2);
  });
});

/**
 * THE WINDOW BETWEEN THE CODE AND THE MIGRATION.
 *
 * `LoginThrottle` arrives in a hand-written migration, so there is a window in
 * which this code is deployed and the relation is not there. MEASURED before
 * this arm existed, by driving the real router over a loopback socket with that
 * one relation answering `P2021`: `POST /auth/login` answered 500 FOR EVERY
 * CALLER. Fail-closed, and a total login outage nobody owned.
 *
 * "There is no lock table" and "I cannot read the lock table" are two facts and
 * they call for opposite answers, which is what these tests pin. The HTTP half
 * — that the degrade is admitted, counted and logged — is in routes/auth.test.ts.
 */
describe('the counters are not installed yet', () => {
  it('recognises ONLY the missing relation, and nothing that merely looks like one', () => {
    // The code, never the message: a recogniser that matched text would read a
    // statement timeout quoting the table name as "the table is absent".
    expect(throttleTableAbsent({ code: 'P2021' })).toBe(true);
    expect(throttleTableAbsent({ code: 'P1001' })).toBe(false);
    expect(throttleTableAbsent({ code: 'P2024' })).toBe(false);
    expect(throttleTableAbsent(new Error('relation "LoginThrottle" does not exist'))).toBe(false);
    expect(throttleTableAbsent(null)).toBe(false);
    expect(throttleTableAbsent(undefined)).toBe(false);
  });

  it('reports NOT_INSTALLED rather than a measured zero when the relation is absent', async () => {
    h.throttleTable = 'ABSENT';

    const decision = await checkLoginThrottle({
      identifier: KNOWN,
      sourceIp: SOURCE,
      storedPolicy: null,
      nowMs: NOW,
    });

    expect(decision.availability).toBe('NOT_INSTALLED');
    /*
     * NULL AND NOT A VERDICT. `failures: 0` here would be a number nobody
     * measured, reported in the field a caller reads to say how many failures
     * it observed — and the union is what stops a call site reading it at all.
     */
    expect(decision.identifier).toBeNull();
    expect(decision.source).toBeNull();
    // Nothing was read, so nothing may be refused and nothing may be waited
    // for: a backoff derived from an absent counter is a delay with no evidence.
    expect(decision.wouldRefuse).toBe(false);
    expect(decision.backoffMs).toBe(0);
  });

  it('STILL FAILS CLOSED when the table is there and cannot be read', async () => {
    /*
     * The half that must not be degraded with the other. An unreadable lock
     * means the control cannot say whether this identifier is locked out, and
     * admitting the login on that basis is the control being switched off by a
     * dropped connection. It throws, the route answers 500, and that is right.
     */
    h.throttleTable = 'UNREADABLE';

    await expect(
      checkLoginThrottle({ identifier: KNOWN, sourceIp: SOURCE, storedPolicy: null, nowMs: NOW }),
    ).rejects.toMatchObject({ code: 'P1001' });
  });

  it('attempts no SECOND read once the first said the relation is absent', async () => {
    /*
     * The source counter is a second `findUnique`. Walking into it would log a
     * second error for one attempt and double the noise for one fact — and on
     * the UNREADABLE path it would be a second query against a database that
     * has already said it cannot answer.
     */
    h.throttleTable = 'ABSENT';

    const decision = await checkLoginThrottle({
      identifier: KNOWN,
      sourceIp: SOURCE,
      storedPolicy: null,
      nowMs: NOW,
    });

    expect(decision.availability).toBe('NOT_INSTALLED');
    expect(h.throttleReads).toBe(1);
    // Nothing was written either: an upsert against a missing relation would
    // throw out of a path whose job was to read.
    expect(h.throttles).toEqual([]);
  });
});
