/**
 * Who the digest says a failure belongs to, and which kind of nobody.
 *
 * This file exists for one claim: `owner: null` is three different facts and
 * the digest used to print all three the same way — by printing nothing. The
 * dangerous one is RULES_UNUSABLE, which means a rule that SHOULD have matched
 * can no longer be evaluated, so routing has silently stopped and a team that
 * believes it is being paged is not. That was logged on the worker and appeared
 * nowhere a human looks, so the morning message a team with broken routing read
 * was byte-identical to the one a team that never configured ownership read.
 *
 * The other half is the shared helpers. This processor kept its own copy of the
 * ownership-rule `select` and its own spelling of an owner's label, and both
 * fail silently rather than loudly:
 *
 *   · a select that forgets `position` still resolves — against a column that
 *     is always 0, so last-match-wins routes every failure to the FIRST rule
 *     that matches instead of the last. `prefers the last matching path rule`
 *     below is the test that notices.
 *   · a label spelled `@slug` here and `Payments` on the ticket reads as two
 *     different owners to the person skimming both.
 *
 * Harness: the worker's context opens Postgres, Redis and the LLM at import
 * time, so it is replaced wholesale and `h.prisma` is swapped per test — the
 * same shape processors/notify.test.ts uses. Only the models `collectDigest`
 * touches are stubbed; an unstubbed one throws, which is the point.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted((): { prisma: Record<string, unknown>; log: string[] } => ({
  prisma: {},
  log: [],
}));

vi.mock('../context.js', () => ({
  config: { artifactsLocal: true },
  connection: {},
  logger: {
    debug: () => {},
    info: (_o: unknown, msg?: string) => h.log.push(`info:${msg ?? ''}`),
    warn: (_o: unknown, msg?: string) => h.log.push(`warn:${msg ?? ''}`),
    error: (_o: unknown, msg?: string) => h.log.push(`error:${msg ?? ''}`),
  },
  prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
}));

vi.mock('../vault.js', () => ({ open: (enc: string): string => enc }));

const { collectDigest, renderDigest } = await import('./digest.js');
import type { Digest, DigestItem } from './digest.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const ORG = 'org1';
const PROJECT = 'p1';
const SINCE = new Date('2026-02-01T00:00:00Z');
const UNTIL = new Date('2026-02-02T00:00:00Z');

const digestItem = (over: Partial<DigestItem> = {}): DigestItem => ({
  testId: 't1',
  name: 'checkout applies a promo code',
  filePath: 'specs/checkout.spec.ts',
  runId: 'run1',
  verdict: 'REAL_BUG',
  owner: null,
  ownerState: null,
  ...over,
});

const digestOf = (newFailures: DigestItem[]): Digest => ({
  projectId: PROJECT,
  projectName: 'Storefront',
  since: SINCE,
  until: UNTIL,
  runs: { total: 1, red: 1 },
  newFailures,
  flakes: [],
  fixed: [],
  stillFailing: 0,
  silentSchedules: [],
  unowned: newFailures.filter((item) => !item.owner).length,
  truncated: false,
});

/**
 * One failing test in the window, one rule table, one directory.
 *
 * `testResult.findMany` is called twice with different intents — the window
 * scan and `priorOutcomes`' look further back — and they are told apart by the
 * `createdAt: { lt }` only the second one carries. A stub that answered both
 * with the window's rows would report the failure as ALREADY failing and the
 * digest would have no new failures to put an owner on.
 */
function db(opts: {
  rules?: Array<Record<string, unknown>>;
  teams?: Array<{ id: string; slug: string }>;
  users?: Array<{ id: string; name: string | null; email: string }>;
  /** Results inside the window. Defaults to one failing test. */
  window?: Array<Record<string, unknown>>;
  /** What `priorOutcomes` sees before the window. Defaults to nothing. */
  prior?: Array<Record<string, unknown>>;
}): { ruleQuery: Array<Record<string, unknown>> } {
  const ruleQuery: Array<Record<string, unknown>> = [];
  const prisma = h.prisma;

  prisma.project = {
    findFirst: async () => ({ id: PROJECT, name: 'Storefront', archivedAt: null }),
  };
  prisma.run = {
    findMany: async () => [
      { id: 'run1', status: 'FAILED', finishedAt: new Date('2026-02-01T12:00:00Z') },
    ],
  };
  prisma.testResult = {
    findMany: async (args: Record<string, unknown>) => {
      const where = (args.where ?? {}) as Record<string, unknown>;
      // The historical look-back. Empty by default, so the window's failure is
      // NEW and therefore gets listed with an owner.
      if (where.createdAt) return opts.prior ?? [];
      return opts.window ?? [windowRow()];
    },
  };
  prisma.schedule = { findMany: async () => [] };
  prisma.ownershipRule = {
    findMany: async (args: Record<string, unknown>) => {
      ruleQuery.push(args);
      return opts.rules ?? [];
    },
  };
  prisma.user = { findMany: async () => opts.users ?? [] };
  prisma.team = { findMany: async () => opts.teams ?? [] };

  return { ruleQuery };
}

/** One `TestResult` row as `collectDigest`'s window scan selects it. */
const windowRow = (over: Record<string, unknown> = {}) => ({
  runId: 'run1',
  testId: 't1',
  status: 'FAILED',
  retriedAndPassed: false,
  createdAt: new Date('2026-02-01T12:00:00Z'),
  test: {
    id: 't1',
    name: 'checkout applies a promo code',
    filePath: 'specs/checkout.spec.ts',
    suiteId: null,
    feature: null,
    quarantined: false,
  },
  verdict: { verdict: 'REAL_BUG', overriddenTo: null },
  ...over,
});

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'rule1',
  position: 0,
  pathPattern: null,
  testId: null,
  suiteId: null,
  feature: null,
  ownerUserId: null,
  ownerTeamId: null,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendering: which kind of nobody
// ─────────────────────────────────────────────────────────────────────────────

describe('a digest line names which kind of nobody owns a failure', () => {
  const lineFor = (item: DigestItem): string => {
    const text = renderDigest(digestOf([item]), 'https://app.qaai.test');
    return text.split('\n').find((line) => line.includes('• checkout applies'))!;
  };

  it('names RULES_UNUSABLE, the state that means routing has silently stopped', () => {
    /*
     * The one that has to be on the line. A rule stored when the validation was
     * looser no longer compiles, so it matches nothing — and from the outside
     * that is indistinguishable from a suite nobody has assigned. The team that
     * wrote the rule is not being paged and has no way to find out.
     */
    expect(lineFor(digestItem({ ownerState: 'RULES_UNUSABLE' }))).toContain(
      'an ownership rule could not be evaluated, so routing may have stopped',
    );
  });

  it('names NO_MATCH as nobody owning it', () => {
    expect(lineFor(digestItem({ ownerState: 'NO_MATCH' }))).toContain('— nobody owns this');
  });

  it('stays silent for NO_RULES, because ownership is opt-in', () => {
    // Nagging about a table nobody asked to fill in is how the digest gets
    // filtered to a folder — and the RULES_UNUSABLE line gets filtered with it.
    const line = lineFor(digestItem({ ownerState: 'NO_RULES' }));
    expect(line).toBe('  • checkout applies a promo code');
  });

  it('stays silent when ownership was never resolved, which is not NO_RULES', () => {
    // `fixed` items are in this state deliberately: resolving ownership for a
    // test that went green is work nobody reads. A null state must not be
    // rendered as a finding about the project's rules.
    expect(lineFor(digestItem({ ownerState: null }))).toBe('  • checkout applies a promo code');
  });

  it('prints the owner, not the state, once there is one', () => {
    const line = lineFor(digestItem({ owner: '@payments', ownerState: 'OWNED' }));
    expect(line).toBe('  • checkout applies a promo code — @payments');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Collection: one resolver, one select, one spelling
// ─────────────────────────────────────────────────────────────────────────────

describe('collectDigest resolves ownership through the shared helpers', () => {
  beforeEach(() => {
    h.log.length = 0;
    for (const key of Object.keys(h.prisma)) delete h.prisma[key];
  });

  it('labels a team the way every other surface labels it', async () => {
    db({
      rules: [rule({ pathPattern: 'specs/**', ownerTeamId: 'team_payments' })],
      teams: [{ id: 'team_payments', slug: 'payments' }],
    });

    const digest = await collectDigest({ orgId: ORG, projectId: PROJECT }, SINCE, UNTIL);

    expect(digest!.newFailures[0]).toMatchObject({ owner: '@payments', ownerState: 'OWNED' });
    expect(digest!.unowned).toBe(0);
  });

  it('prefers the LAST matching path rule', async () => {
    /*
     * CODEOWNERS' rule verbatim: `specs/**` at position 0 and
     * `specs/checkout.spec.ts` at position 1 resolves to the specific one. This
     * pins the PRECEDENCE the digest inherits from the shared resolver; the
     * `select` that feeds it is pinned separately below, because this stub
     * returns whole rule rows regardless of what was selected — exactly as a
     * real `select` that forgot `position` would return rows whose position is
     * 0, which is why a behaviour test cannot be the guard for that field.
     */
    db({
      rules: [
        rule({ id: 'rule_catch_all', position: 0, pathPattern: 'specs/**', ownerTeamId: 'team_qa' }),
        rule({
          id: 'rule_specific',
          position: 1,
          pathPattern: 'specs/checkout.spec.ts',
          ownerTeamId: 'team_payments',
        }),
      ],
      teams: [
        { id: 'team_qa', slug: 'qa' },
        { id: 'team_payments', slug: 'payments' },
      ],
    });

    const digest = await collectDigest({ orgId: ORG, projectId: PROJECT }, SINCE, UNTIL);

    expect(digest!.newFailures[0]!.owner).toBe('@payments');
  });

  it('asks for `position` at all — the one field a copied select loses silently', async () => {
    const observed = db({ rules: [] });
    await collectDigest({ orgId: ORG, projectId: PROJECT }, SINCE, UNTIL);

    expect(observed.ruleQuery[0]!.select).toMatchObject({
      position: true,
      pathPattern: true,
      testId: true,
      suiteId: true,
      feature: true,
      ownerUserId: true,
      ownerTeamId: true,
    });
  });

  it('reports NO_RULES rather than nothing when ownership is not configured', async () => {
    // A state, not an absence: "nobody has written a rule" and "we did not look"
    // are different answers and the digest now carries whichever is true.
    db({ rules: [] });

    const digest = await collectDigest({ orgId: ORG, projectId: PROJECT }, SINCE, UNTIL);

    expect(digest!.newFailures[0]).toMatchObject({ owner: null, ownerState: 'NO_RULES' });
  });

  it('reports RULES_UNUSABLE, and logs it, when a stored rule can no longer be evaluated', async () => {
    db({ rules: [rule({ pathPattern: 'specs/[a-z]/**', ownerTeamId: 'team_payments' })] });

    const digest = await collectDigest({ orgId: ORG, projectId: PROJECT }, SINCE, UNTIL);

    expect(digest!.newFailures[0]!.ownerState).toBe('RULES_UNUSABLE');
    expect(h.log.some((line) => line.includes('could not be evaluated'))).toBe(true);
  });

  it('leaves ownerState NULL on a FIXED test — not-resolved is not NO_RULES', async () => {
    /*
     * `collectDigest` resolves ownership only for what it LISTS as a problem:
     * new failures and flakes. A test that went green is deliberately not
     * resolved, and that item's state has to come out null. Defaulting it to
     * NO_RULES instead would have the digest report a finding about a project's
     * rule table — "nobody has written one" — off the back of a question
     * nobody asked, in an install whose rules are fine.
     */
    db({
      rules: [rule({ pathPattern: 'specs/**', ownerTeamId: 'team_payments' })],
      teams: [{ id: 'team_payments', slug: 'payments' }],
      window: [
        windowRow(),
        windowRow({
          testId: 't2',
          status: 'PASSED',
          test: {
            id: 't2',
            name: 'cart badge updates',
            filePath: 'specs/cart.spec.ts',
            suiteId: null,
            feature: null,
            quarantined: false,
          },
          verdict: null,
        }),
      ],
      // t2 was failing before the window, so it counts as FIXED.
      prior: [
        { testId: 't2', status: 'FAILED', retriedAndPassed: false, test: { quarantined: false } },
      ],
    });

    const digest = await collectDigest({ orgId: ORG, projectId: PROJECT }, SINCE, UNTIL);

    expect(digest!.fixed.map((item) => item.testId)).toEqual(['t2']);
    expect(digest!.fixed[0]!.ownerState).toBeNull();
    // And the thing that WAS listed still carries its real state.
    expect(digest!.newFailures[0]!.ownerState).toBe('OWNED');
  });

  it('still labels a rule whose user row has gone, rather than reporting it unowned', async () => {
    /*
     * Deleting a user cascades its rules away, so this should be unreachable —
     * and when it IS reached the old code produced NO label while the state
     * said OWNED, i.e. an owned failure rendering as unowned. `ownerLabel`'s
     * fallback says something true instead.
     */
    db({
      rules: [rule({ pathPattern: 'specs/**', ownerUserId: 'user_gone' })],
      users: [],
    });

    const digest = await collectDigest({ orgId: ORG, projectId: PROJECT }, SINCE, UNTIL);

    expect(digest!.newFailures[0]).toMatchObject({
      owner: 'a deleted user',
      ownerState: 'OWNED',
    });
  });
});
