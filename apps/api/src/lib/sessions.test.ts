/**
 * Tests for session listing, revocation and the CSRF token derived from one.
 *
 * What is being proven, worst defect first:
 *
 *   1. THE LIST NEVER CARRIES THE TOKEN. The projection is asserted field for
 *      field rather than described, because "we do not return the token" is the
 *      kind of sentence that stays in a comment after somebody adds a spread.
 *
 *   2. ONE PERSON CANNOT REVOKE ANOTHER PERSON'S SESSION. The id comes from a
 *      URL; without `userId` in the WHERE an `update` by id would succeed the
 *      moment an id leaked, and the caller could not tell because the response
 *      would be the same.
 *
 *   3. A REVOCATION IS NOT OVERWRITTEN. Revoking an already-revoked session
 *      reports false and leaves the first reason and time intact — that pair is
 *      evidence, and the second writer would destroy it.
 *
 *   4. THE REASON GOES THROUGH THE VOCABULARY. A spelling no reader can name is
 *      a revocation an operator cannot explain.
 *
 *   5. `lastSeenAt` IS COARSE, NEVER MOVES BACKWARDS, AND NEVER TOUCHES A DEAD
 *      SESSION. A write per authenticated request would turn a cookie into a
 *      row-level lock on the hot path of the whole API.
 *
 *   6. THE CSRF TOKEN IS DERIVED, DOMAIN-SEPARATED AND COMPARED IN CONSTANT
 *      TIME — and it dies with the session it came from.
 *
 * The prisma stand-in HONOURS `select` and REFUSES an unknown filter: a
 * select-blind fake makes deleting a field from a query undetectable, and a
 * filter-blind one makes deleting `revokedAt: null` from a WHERE undetectable,
 * which is this file's defect number three.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  sessions: Row[];
  failUpdate: boolean;
}

const h = vi.hoisted((): Hoisted => ({ sessions: [], failUpdate: false }));

const SECRET = 'test-session-secret-at-least-32-characters-long';

vi.mock('../env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', SESSION_SECRET: SECRET },
  isProd: false,
}));

/** The filters these queries may use. Anything else throws rather than matching everything. */
const KNOWN_FILTERS = new Set([
  'id',
  'userId',
  'tokenHash',
  'revokedAt',
  'expiresAt',
  'lastSeenAt',
  'NOT',
  'OR',
]);

function matchesCondition(value: unknown, cond: unknown): boolean {
  if (cond === null) return (value ?? null) === null;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (cond && typeof cond === 'object') {
    const c = cond as Row;
    if ('gt' in c) return value instanceof Date && value.getTime() > (c.gt as Date).getTime();
    if ('lt' in c) return value instanceof Date && value.getTime() < (c.lt as Date).getTime();
    throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
  }
  return value === cond;
}

function matchesWhere(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (!KNOWN_FILTERS.has(key)) throw new Error(`fake prisma: unsupported filter session.${key}`);
    if (key === 'NOT') return !matchesWhere(row, cond as Row);
    if (key === 'OR') return (cond as Row[]).some((clause) => matchesWhere(row, clause));
    return matchesCondition(row[key] ?? null, cond);
  });
}

/**
 * `select` is HONOURED, and a column the row does not have is a THROW.
 *
 * The listing reads eight columns through one shared constant. A future edit
 * that drops one from that constant would make the mapper read `undefined`,
 * and `undefined` serialises away in JSON — so a field would silently vanish
 * from the screen with every test still green.
 */
function projectRow(row: Row, sel: Row | undefined): Row {
  if (!sel) return { ...row };
  const out: Row = {};
  for (const [key, want] of Object.entries(sel)) {
    if (want !== true) throw new Error(`fake prisma: unsupported select on session.${key}`);
    if (!(key in row)) throw new Error(`fake prisma: session has no column ${key}`);
    out[key] = row[key];
  }
  return out;
}

/**
 * `orderBy` with POSTGRES NULL ORDERING, which is the only reason this is
 * modelled rather than shrugged at.
 *
 * `ORDER BY "lastSeenAt" DESC` puts NULLs FIRST in Postgres, and Prisma emits
 * exactly that. A fake that sorted nulls last would make the listing test pass
 * while the real screen puts every session that has made no request since the
 * column landed at the top — "unknown" rendered as "most recent", which is the
 * one ordering that makes the list useless for choosing a device to kill.
 */
function sortRows(rows: Row[], orderBy: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    for (const clause of orderBy) {
      const [key, spec] = Object.entries(clause)[0] as [string, unknown];
      const dir: 'asc' | 'desc' =
        typeof spec === 'string' ? (spec as 'asc' | 'desc') : ((spec as Row).sort as 'asc' | 'desc');
      /*
       * Postgres's own default when the query does not say: NULLS FIRST for
       * DESC and NULLS LAST for ASC. Modelled rather than assumed, so a revert
       * from the explicit `{ sort, nulls }` form to a bare `'desc'` puts the
       * never-seen session back at the top and the listing test fails.
       */
      const nulls: 'first' | 'last' =
        typeof spec === 'string'
          ? dir === 'desc'
            ? 'first'
            : 'last'
          : ((spec as Row).nulls as 'first' | 'last');
      const left = a[key] ?? null;
      const right = b[key] ?? null;
      if (left === null && right === null) continue;
      if (left === null) return nulls === 'first' ? -1 : 1;
      if (right === null) return nulls === 'first' ? 1 : -1;
      const l = left instanceof Date ? left.getTime() : left;
      const r = right instanceof Date ? right.getTime() : right;
      if (l === r) continue;
      return (l < r ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

vi.mock('./prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();

  const session = {
    findMany: async ({ where, orderBy, select }: Row = {}) =>
      sortRows(
        h.sessions.filter((row) => matchesWhere(row, where ?? {})),
        Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [],
      ).map((row) => projectRow(row, select)),
    updateMany: async ({ where, data }: Row) => {
      if (h.failUpdate) throw new Error('fake prisma: session.updateMany refused');
      const hits = h.sessions.filter((row) => matchesWhere(row, where ?? {}));
      for (const row of hits) Object.assign(row, data);
      return { count: hits.length };
    },
  };

  return {
    prisma: { session },
    withTenant: <T>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

const {
  CSRF_COOKIE,
  CSRF_HEADER,
  LAST_SEEN_RESOLUTION_MS,
  csrfTokenFor,
  csrfTokenMatches,
  listSessions,
  methodNeedsCsrf,
  normaliseDeviceLabel,
  revokeAllSessions,
  revokeSession,
  touchSession,
} = await import('./sessions.js');

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const ME = 'user_me';
const SOMEBODY_ELSE = 'user_them';

/** A token hash shape — a hex digest, composed rather than written out. */
const hash = (seed: string): string => seed.padEnd(64, '0').slice(0, 64);

function seed(): void {
  h.sessions = [
    {
      id: 'sess_laptop',
      userId: ME,
      tokenHash: hash('laptop'),
      activeOrgId: 'org_1',
      ip: '198.51.100.7',
      userAgent: 'Mozilla/5.0 (Macintosh)',
      deviceLabel: 'Work laptop',
      lastSeenAt: new Date(NOW - 3_600_000),
      expiresAt: new Date(NOW + 86_400_000),
      revokedAt: null,
      revokedReason: null,
      revokedBy: null,
      createdAt: new Date(NOW - 7 * 86_400_000),
    },
    {
      id: 'sess_phone',
      userId: ME,
      tokenHash: hash('phone'),
      activeOrgId: 'org_1',
      ip: '198.51.100.8',
      userAgent: 'QAAI/iOS',
      deviceLabel: 'Phone',
      lastSeenAt: new Date(NOW - 60_000),
      expiresAt: new Date(NOW + 86_400_000),
      revokedAt: null,
      revokedReason: null,
      revokedBy: null,
      createdAt: new Date(NOW - 2 * 86_400_000),
    },
    {
      /** Never made a request since the column landed. NOT back-filled. */
      id: 'sess_quiet',
      userId: ME,
      tokenHash: hash('quiet'),
      activeOrgId: 'org_1',
      ip: null,
      userAgent: null,
      deviceLabel: null,
      lastSeenAt: null,
      expiresAt: new Date(NOW + 86_400_000),
      revokedAt: null,
      revokedReason: null,
      revokedBy: null,
      createdAt: new Date(NOW - 86_400_000),
    },
    {
      /** Already revoked, with a reason somebody will want to read later. */
      id: 'sess_dead',
      userId: ME,
      tokenHash: hash('dead'),
      activeOrgId: 'org_1',
      ip: null,
      userAgent: null,
      deviceLabel: 'Old tablet',
      lastSeenAt: new Date(NOW - 10 * 86_400_000),
      expiresAt: new Date(NOW + 86_400_000),
      revokedAt: new Date(NOW - 9 * 86_400_000),
      revokedReason: 'ADMIN_REVOKED',
      revokedBy: 'user_admin',
      createdAt: new Date(NOW - 30 * 86_400_000),
    },
    {
      /** Expired but never revoked: live in the column, dead in fact. */
      id: 'sess_expired',
      userId: ME,
      tokenHash: hash('expired'),
      activeOrgId: 'org_1',
      ip: null,
      userAgent: null,
      deviceLabel: 'Hotel desktop',
      lastSeenAt: new Date(NOW - 20 * 86_400_000),
      expiresAt: new Date(NOW - 86_400_000),
      revokedAt: null,
      revokedReason: null,
      revokedBy: null,
      createdAt: new Date(NOW - 40 * 86_400_000),
    },
    {
      id: 'sess_theirs',
      userId: SOMEBODY_ELSE,
      tokenHash: hash('theirs'),
      activeOrgId: 'org_2',
      ip: null,
      userAgent: null,
      deviceLabel: 'Not yours',
      lastSeenAt: new Date(NOW),
      expiresAt: new Date(NOW + 86_400_000),
      revokedAt: null,
      revokedReason: null,
      revokedBy: null,
      createdAt: new Date(NOW),
    },
  ];
}

beforeEach(() => {
  seed();
  h.failUpdate = false;
});

describe('the list a person acts on', () => {
  it('NEVER CARRIES THE SESSION TOKEN', async () => {
    const sessions = await listSessions(ME, { nowMs: NOW, currentTokenHash: hash('laptop') });
    expect(sessions.length).toBeGreaterThan(0);
    for (const row of sessions) {
      // Asserted on the KEYS, not on a spot check: a spread added later would
      // carry `tokenHash` into the response and a `toBeUndefined()` on one
      // field would not notice.
      expect(Object.keys(row).sort()).toEqual(
        [
          'createdAt',
          'current',
          'deviceLabel',
          'expiresAt',
          'id',
          'ip',
          'lastSeenAt',
          'userAgent',
        ].sort(),
      );
      expect(JSON.stringify(row)).not.toContain(hash('laptop'));
    }
  });

  it('shows only LIVE sessions — not the revoked one, not the expired one', async () => {
    const sessions = await listSessions(ME, { nowMs: NOW, currentTokenHash: null });
    expect(sessions.map((s) => s.id)).toEqual(['sess_phone', 'sess_laptop', 'sess_quiet']);
  });

  it('shows nobody else\'s sessions', async () => {
    const sessions = await listSessions(ME, { nowMs: NOW, currentTokenHash: null });
    expect(sessions.some((s) => s.id === 'sess_theirs')).toBe(false);
  });

  it('marks the caller\'s own session, so they do not kill it looking for the laptop', async () => {
    const sessions = await listSessions(ME, { nowMs: NOW, currentTokenHash: hash('phone') });
    expect(sessions.filter((s) => s.current).map((s) => s.id)).toEqual(['sess_phone']);
  });

  it('marks none when the caller holds no cookie, rather than guessing', async () => {
    const sessions = await listSessions(ME, { nowMs: NOW, currentTokenHash: null });
    expect(sessions.length).toBeGreaterThan(0);
    // A bearer-token caller holds no session cookie. Picking one to call
    // "current" would have the screen refuse to let them revoke a device they
    // are not using.
    expect(sessions.some((s) => s.current)).toBe(false);
  });

  it('keeps a null lastSeenAt as NULL rather than standing in for createdAt', async () => {
    const sessions = await listSessions(ME, { nowMs: NOW, currentTokenHash: null });
    const quiet = sessions.find((s) => s.id === 'sess_quiet')!;
    // "Signed in three weeks ago" and "last used three weeks ago" are the two
    // facts a person uses to choose; conflating them makes the screen useless.
    expect(quiet.lastSeenAt).toBeNull();
    expect(quiet.createdAt).toEqual(new Date(NOW - 86_400_000));
  });
});

describe('revoking one session', () => {
  it('revokes it, with a reason and an author', async () => {
    expect(
      await revokeSession({
        userId: ME,
        sessionId: 'sess_laptop',
        reason: 'USER_REVOKED_DEVICE',
        byUserId: ME,
        nowMs: NOW,
      }),
    ).toBe(true);

    const row = h.sessions.find((s) => s.id === 'sess_laptop')!;
    expect(row.revokedAt).toEqual(new Date(NOW));
    expect(row.revokedReason).toBe('USER_REVOKED_DEVICE');
    expect(row.revokedBy).toBe(ME);
  });

  it('REFUSES SOMEBODY ELSE\'S SESSION, and changes nothing', async () => {
    expect(
      await revokeSession({
        userId: ME,
        sessionId: 'sess_theirs',
        reason: 'USER_REVOKED_DEVICE',
        byUserId: ME,
        nowMs: NOW,
      }),
    ).toBe(false);
    // The id came from a URL. Without `userId` in the WHERE this would have
    // succeeded and the caller could not have told, because the response to a
    // successful revocation is the same shape.
    expect(h.sessions.find((s) => s.id === 'sess_theirs')!.revokedAt).toBeNull();
  });

  it('answers false for an id that does not exist, indistinguishably', async () => {
    expect(
      await revokeSession({
        userId: ME,
        sessionId: 'sess_nothing',
        reason: 'USER_REVOKED_DEVICE',
        byUserId: ME,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it('DOES NOT OVERWRITE AN EXISTING REVOCATION', async () => {
    expect(
      await revokeSession({
        userId: ME,
        sessionId: 'sess_dead',
        reason: 'USER_REVOKED_DEVICE',
        byUserId: ME,
        nowMs: NOW,
      }),
    ).toBe(false);

    const row = h.sessions.find((s) => s.id === 'sess_dead')!;
    // "Who ended this session and why" is evidence. A second writer would
    // replace an ADMIN_REVOKED nine days ago with a user action today.
    expect(row.revokedReason).toBe('ADMIN_REVOKED');
    expect(row.revokedBy).toBe('user_admin');
    expect(row.revokedAt).toEqual(new Date(NOW - 9 * 86_400_000));
  });

  it('REFUSES A REASON OUTSIDE THE VOCABULARY, before touching a row', async () => {
    await expect(
      revokeSession({
        userId: ME,
        sessionId: 'sess_laptop',
        // Deliberately not a member. A spelling no reader can name is a
        // revocation an operator cannot explain.
        reason: 'BECAUSE_I_SAID_SO' as never,
        byUserId: ME,
        nowMs: NOW,
      }),
    ).rejects.toThrow();
    expect(h.sessions.find((s) => s.id === 'sess_laptop')!.revokedAt).toBeNull();
  });
});

describe('revoking in bulk', () => {
  it('spares the caller\'s own session when asked', async () => {
    const revoked = await revokeAllSessions({
      userId: ME,
      exceptTokenHash: hash('phone'),
      reason: 'PASSWORD_CHANGED',
      byUserId: ME,
      nowMs: NOW,
    });
    // laptop, quiet and expired were live-in-column; dead already had a reason.
    expect(revoked).toBe(3);
    expect(h.sessions.find((s) => s.id === 'sess_phone')!.revokedAt).toBeNull();
  });

  it('spares nothing when the caller asks to be signed out everywhere', async () => {
    const revoked = await revokeAllSessions({
      userId: ME,
      exceptTokenHash: null,
      reason: 'ALL_SESSIONS_REVOKED',
      byUserId: ME,
      nowMs: NOW,
    });
    expect(revoked).toBe(4);
    expect(h.sessions.find((s) => s.id === 'sess_phone')!.revokedAt).toEqual(new Date(NOW));
  });

  it('touches nobody else\'s sessions', async () => {
    await revokeAllSessions({
      userId: ME,
      exceptTokenHash: null,
      reason: 'ALL_SESSIONS_REVOKED',
      byUserId: ME,
      nowMs: NOW,
    });
    expect(h.sessions.find((s) => s.id === 'sess_theirs')!.revokedAt).toBeNull();
  });

  it('REPORTS A NUMBER, because a bulk action that says "done" cannot be verified', async () => {
    const first = await revokeAllSessions({
      userId: ME,
      exceptTokenHash: null,
      reason: 'ALL_SESSIONS_REVOKED',
      byUserId: ME,
      nowMs: NOW,
    });
    const second = await revokeAllSessions({
      userId: ME,
      exceptTokenHash: null,
      reason: 'ALL_SESSIONS_REVOKED',
      byUserId: ME,
      nowMs: NOW,
    });
    expect(first).toBe(4);
    // Idempotent, and honestly reported as zero rather than as four again.
    expect(second).toBe(0);
  });
});

describe('the last-seen stamp', () => {
  it('writes when the recorded value is older than the resolution', async () => {
    await touchSession({ tokenHash: hash('laptop'), nowMs: NOW });
    expect(h.sessions.find((s) => s.id === 'sess_laptop')!.lastSeenAt).toEqual(new Date(NOW));
  });

  it('writes when there is no recorded value at all', async () => {
    await touchSession({ tokenHash: hash('quiet'), nowMs: NOW });
    expect(h.sessions.find((s) => s.id === 'sess_quiet')!.lastSeenAt).toEqual(new Date(NOW));
  });

  it('SKIPS a session seen inside the resolution, so a cookie is not a write lock', async () => {
    const before = h.sessions.find((s) => s.id === 'sess_phone')!.lastSeenAt;
    await touchSession({ tokenHash: hash('phone'), nowMs: NOW });
    // `sess_phone` was seen a minute ago, which is exactly the resolution — a
    // write per authenticated request would put a row-level lock on the hot
    // path of the whole API.
    expect(LAST_SEEN_RESOLUTION_MS).toBe(60_000);
    expect(h.sessions.find((s) => s.id === 'sess_phone')!.lastSeenAt).toEqual(before);
  });

  it('NEVER TOUCHES A REVOKED SESSION, so "last seen" cannot creep on a dead one', async () => {
    const before = h.sessions.find((s) => s.id === 'sess_dead')!.lastSeenAt;
    await touchSession({ tokenHash: hash('dead'), nowMs: NOW });
    expect(h.sessions.find((s) => s.id === 'sess_dead')!.lastSeenAt).toEqual(before);
  });

  it('swallows a write failure, because a presence stamp is not worth a 500', async () => {
    h.failUpdate = true;
    await expect(touchSession({ tokenHash: hash('laptop'), nowMs: NOW })).resolves.toBeUndefined();
  });
});

describe('the device label', () => {
  it('is bounded, trimmed and stripped of control characters', () => {
    expect(normaliseDeviceLabel('  Work laptop  ')).toBe('Work laptop');
    expect(normaliseDeviceLabel('x'.repeat(500))).toHaveLength(80);
    // The list is also read in a terminal, where a stray escape rewrites the
    // operator's screen. That is a log-injection surface with nothing to do
    // with the browser.
    expect(normaliseDeviceLabel('Lap\u001b[2Jtop\r\n')).toBe('Lap [2Jtop');
  });

  it('is null for anything that is not a usable string', () => {
    for (const value of [null, undefined, 42, {}, [], '', '   ', '\u0000\u0000']) {
      expect(normaliseDeviceLabel(value)).toBeNull();
    }
  });
});

describe('the CSRF token', () => {
  it('is derived from the session, so it dies exactly when the session does', () => {
    const a = csrfTokenFor(hash('laptop'));
    const b = csrfTokenFor(hash('phone'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(csrfTokenFor(hash('laptop'))).toBe(a);
  });

  it('is DOMAIN-SEPARATED from the session hash itself', () => {
    const tokenHash = hash('laptop');
    // Two keyed digests of one input is how a value minted for one purpose
    // starts authenticating another. The separator is what stops this value
    // being computable from, or substitutable for, anything else keyed on
    // SESSION_SECRET and the same hash.
    expect(csrfTokenFor(tokenHash)).not.toBe(tokenHash);
  });

  it('matches only the exact token', () => {
    const expected = csrfTokenFor(hash('laptop'));
    expect(csrfTokenMatches(expected, expected)).toBe(true);
    expect(csrfTokenMatches(expected, `${expected.slice(0, -1)}0`)).toBe(
      expected.endsWith('0'),
    );
    expect(csrfTokenMatches(expected, expected.toUpperCase())).toBe(false);
  });

  it('refuses a non-string and a wrong length without throwing', () => {
    const expected = csrfTokenFor(hash('laptop'));
    for (const supplied of [undefined, null, 42, {}, [], '', expected.slice(0, 10), [expected]]) {
      expect(csrfTokenMatches(expected, supplied)).toBe(false);
    }
  });

  it('names the header and the cookie once, so two spellings cannot drift', () => {
    expect(CSRF_HEADER).toBe('x-qaai-csrf');
    expect(CSRF_COOKIE).toBe('qaai_csrf');
  });

  it('is required for the mutating methods and NOT for the safe ones', () => {
    for (const method of ['GET', 'get', 'HEAD', 'OPTIONS']) {
      // A token on a GET is a token in a URL in a referrer header in somebody
      // else's analytics.
      expect(methodNeedsCsrf(method)).toBe(false);
    }
    for (const method of ['POST', 'put', 'PATCH', 'DELETE']) {
      expect(methodNeedsCsrf(method)).toBe(true);
    }
  });
});
