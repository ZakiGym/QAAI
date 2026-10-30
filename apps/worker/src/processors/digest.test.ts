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
import { summariseSuppressions } from '@qaai/shared';

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

const { collectDigest, hasSomethingToSay, renderDigest } = await import('./digest.js');
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
  /*
   * NOTHING SUPPRESSED, stated rather than omitted. `summariseSuppressions([])`
   * is used instead of a hand-written object so the fixture cannot disagree
   * with the summariser about what "nothing" looks like — including its
   * `Nothing was suppressed.` sentence, which is the thing that distinguishes a
   * surface that asked from one that forgot to.
   */
  suppressions: summariseSuppressions([]),
  /*
   * NULL, which is NOT MEASURED, and that is the honest default for a fixture:
   * a project with no stored snapshot has no coverage figure. The renderer
   * prints the words rather than a number for it, which the test below asserts
   * — a `0` here would have let the one lie this field exists to prevent pass
   * unnoticed in every other case in this file.
   */
  coverage: null,
  newFailures,
  flakes: [],
  fixed: [],
  stillFailing: 0,
  silentSchedules: [],
  unowned: newFailures.filter((item) => !item.owner).length,
  truncated: false,
  /*
   * Null means the ledger read was NOT capped — which is a different fact from
   * `truncated: false` above, and the two are separate fields for that reason:
   * one says the digest saw every RESULT, the other that it saw everything that
   * was SILENCED.
   */
  ledgerTruncated: null,
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
  /**
   * `SuppressionEvent` rows for this window's runs. Defaults to NONE, which is
   * the honest default and the one that makes "Nothing was suppressed." the
   * fixture's answer rather than a missing field.
   */
  ledger?: Array<Record<string, unknown>>;
}): { ruleQuery: Array<Record<string, unknown>>; ledgerQuery: Array<Record<string, unknown>> } {
  const ruleQuery: Array<Record<string, unknown>> = [];
  const ledgerQuery: Array<Record<string, unknown>> = [];
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
  /*
   * The suppression ledger. The QUERY is captured as well as answered, because
   * the window scoping is the property worth holding: these rows are scoped by
   * RUN ID and not by a date range on the ledger, so a finaliser redelivered
   * the next morning cannot file a suppression against the wrong day.
   */
  prisma.suppressionEvent = {
    findMany: async (args: Record<string, unknown>) => {
      ledgerQuery.push(args);
      return opts.ledger ?? [];
    },
  };

  return { ruleQuery, ledgerQuery };
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
  /*
   * WHERE THE RULE CAME FROM, defaulted to NULL — what a rule somebody typed
   * into QAAI stores. It decides whether the digest NAMES a team or merely
   * SUGGESTS one, so the default has to be a value this fixture states rather
   * than a missing key.
   */
  source: null,
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

  /*
   * ── THE IMPORTED GLOB, AND WHY THE PAIR IS THE TEST ───────────────────────
   *
   * `OwnershipRule.source` decides whether a match is an ASSIGNMENT or a
   * SUGGESTION: CODEOWNERS_IMPORT is deliberately WEAKER than RULE_PATH and
   * `mayPage` is false for it. Until the digest read it, a glob pasted out of a
   * customer's CODEOWNERS file named a team outright in the morning message —
   * and the second time a team is paged for something it never agreed to own,
   * it filters the digest, after which the feature is worse than not having it.
   *
   * THE TWO CASES DIFFER IN ONE FIELD ON ONE FIXTURE. Same rule, same path,
   * same team, opposite claim about what the match is worth — so neither can
   * pass by accident, and the third case pins the `select` that feeds them,
   * because this stub returns whole rule rows regardless of what was asked for.
   */
  it('names the team outright for a rule somebody typed', async () => {
    db({
      rules: [rule({ pathPattern: 'specs/**', ownerTeamId: 'team_payments' })],
      teams: [{ id: 'team_payments', slug: 'payments' }],
    });

    const digest = await collectDigest({ orgId: ORG, projectId: PROJECT }, SINCE, UNTIL);

    expect(digest!.newFailures[0]).toMatchObject({
      owner: '@payments',
      ownerState: 'OWNED',
      ownerProvenance: 'RULE_PATH',
    });
    const text = renderDigest(digest!, 'https://app.qaai.test');
    expect(text).toContain('• checkout applies a promo code — @payments');
    expect(text).not.toContain('suggested');
  });

  it('calls an imported glob a suggestion, and declines to page on it', async () => {
    db({
      rules: [
        rule({ pathPattern: 'specs/**', ownerTeamId: 'team_payments', source: 'CODEOWNERS' }),
      ],
      teams: [{ id: 'team_payments', slug: 'payments' }],
    });

    const digest = await collectDigest({ orgId: ORG, projectId: PROJECT }, SINCE, UNTIL);

    expect(digest!.newFailures[0]).toMatchObject({
      owner: '@payments',
      ownerState: 'OWNED',
      ownerProvenance: 'CODEOWNERS_IMPORT',
    });
    // STILL OWNED: the owner is right. What changed is what the match is worth,
    // and conflating those two is how a suggestion comes to page.
    expect(digest!.unowned).toBe(0);
    const text = renderDigest(digest!, 'https://app.qaai.test');
    expect(text).toContain('• checkout applies a promo code — @payments (suggested, not paged)');
  });

  it('discloses the suppression-ledger cap when it bites, as a count AND a reason', async () => {
    /*
     * IT WAS A SILENT `take`. The ledger read was capped at MAX_RESULTS and the
     * message said nothing, so a window with more suppressions than the cap
     * under-reported what had been silenced with no sign it had happened. On
     * the one surface whose job is to be believed, that is a cap applied
     * without being disclosed AND a failure suppressed without being counted.
     *
     * The `+ 1` is what makes the disclosure possible: with a plain `take` the
     * read cannot tell a window of exactly the cap from one over it.
     */
    const over = Array.from({ length: 5_001 }, (_unused, index) => ({
      kind: 'MUTE' as const,
      sourceId: `ki_${index}`,
      suppressed: 1,
      inForce: true,
    }));
    db({ ledger: over });

    const digest = await collectDigest({ orgId: ORG, projectId: PROJECT }, SINCE, UNTIL);

    expect(digest!.ledgerTruncated).toMatchObject({ limit: 5_000, rowsRead: 5_000 });
    expect(digest!.ledgerTruncated!.reason).toMatch(/FLOOR/);
    // And a reader of the morning message is told, not just a reader of the
    // object.
    expect(renderDigest(digest!, 'https://app.qaai.test')).toContain('are a FLOOR');
    // The fold stopped at the cap rather than walking the extra row.
    expect(digest!.suppressions.suppressed).toBe(5_000);
  });

  it('reports NO ledger truncation for a window of exactly the cap', async () => {
    // The mirror of the silent cap: `>= MAX_RESULTS` called an untruncated
    // window truncated, which is a thing reported as unmeasured that WAS
    // measured.
    const exact = Array.from({ length: 5_000 }, (_unused, index) => ({
      kind: 'MUTE' as const,
      sourceId: `ki_${index}`,
      suppressed: 1,
      inForce: true,
    }));
    db({ ledger: exact });

    const digest = await collectDigest({ orgId: ORG, projectId: PROJECT }, SINCE, UNTIL);

    expect(digest!.ledgerTruncated).toBeNull();
    expect(digest!.suppressions.suppressed).toBe(5_000);
  });

  it('asks for `source` at all — without it every imported glob pages again', async () => {
    const observed = db({ rules: [] });
    await collectDigest({ orgId: ORG, projectId: PROJECT }, SINCE, UNTIL);

    expect(observed.ruleQuery[0]!.select).toMatchObject({ source: true });
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

  /*
   * ── "47 FAILURES BY 3 KNOWN ISSUES" ──────────────────────────────────────
   *
   * THE DEFECT: a digest listing three new failures while a mute silenced forty
   * is a digest that makes the larger fact invisible every morning, and this is
   * the message most of a team ever reads about their suite. The file's own
   * opening line is that a suppression nobody can audit is one nobody should
   * trust; until this landed, the file could not say the sentence.
   */
  it('counts what went quiet, by kind, and says it on the digest', async () => {
    db({
      ledger: [
        { kind: 'MUTE', sourceId: 'ki_1', suppressed: 40, inForce: true },
        { kind: 'MUTE', sourceId: 'ki_2', suppressed: 7, inForce: true },
        { kind: 'QUARANTINE', sourceId: 't9', suppressed: 2, inForce: true },
      ],
    });

    const digest = await collectDigest({ orgId: ORG, projectId: PROJECT }, SINCE, UNTIL);

    expect(digest!.suppressions.suppressed).toBe(49);
    // DISTINCT mutes, not ledger rows: two rows, two `sourceId`s, two issues.
    expect(digest!.suppressions.disclosure).toContain('47 failures by 2 known issues');
    expect(digest!.suppressions.disclosure).toContain('2 failures by 1 quarantined test');
    expect(renderDigest(digest!, 'https://app.test')).toContain('Suppressed in this window');
  });

  it('counts one ENV_ISSUE suppression per run, because the run IS the source', async () => {
    /*
     * ── "THE BOARD WAS QUIET BECAUSE THE ENVIRONMENT WAS DOWN NINE TIMES" ─────
     *
     * ENV_ISSUE is the kind most likely to go uncounted: there is no roster page
     * for it, nobody renews it, and it disappears with the run. It is counted
     * here by the GENERIC fold and needs no kind-specific constructor, and that
     * is a choice made at the writer rather than a coincidence —
     * `envIssueEventRow` sets `sourceId` to the RUN id precisely because
     * ENV_ISSUE has no owning row to point at, so "distinct live sourceIds" and
     * "runs the environment was down for" are the same number.
     *
     * `packages/agent/src/env-issue.ts` held an `envIssueTally` that built this
     * tally from `{runs, suppressed}` and had no caller anywhere; it was deleted
     * and this test is where the fact it encoded now lives, on the path that
     * actually produces the sentence.
     */
    db({
      ledger: Array.from({ length: 9 }, (_, index) => ({
        kind: 'ENV_ISSUE' as const,
        // One row per run, and the run is the source.
        sourceId: `run_${index}`,
        suppressed: 12,
        inForce: true,
      })),
    });

    const digest = await collectDigest({ orgId: ORG, projectId: PROJECT }, SINCE, UNTIL);

    const env = digest!.suppressions.byKind.find((tally) => tally.kind === 'ENV_ISSUE')!;
    expect(env.suppressions).toBe(9);
    expect(env.suppressed).toBe(108);
    // A run-scoped suppression is either in force during its run or gone with
    // it, so there is no expired-ENV population to report. An honest zero.
    expect(env.expired).toBe(0);
    expect(digest!.suppressions.disclosure).toContain('108 failures by 9');
  });

  /*
   * THE ROW THAT PROVES AN EXPIRY WORKED silenced nothing, and is still
   * reported. Hiding it is what makes an expiry arrive as a surprise outage.
   */
  it('reports an expired suppression that silenced nothing', async () => {
    db({ ledger: [{ kind: 'MUTE', sourceId: 'ki_3', suppressed: 0, inForce: false }] });

    const digest = await collectDigest({ orgId: ORG, projectId: PROJECT }, SINCE, UNTIL);

    expect(digest!.suppressions.suppressed).toBe(0);
    expect(digest!.suppressions.expired).toBe(1);
    expect(renderDigest(digest!, 'https://app.test')).toContain('expired and silenced nothing');
  });

  /*
   * ZERO IS IN THE DATA AND NOT IN THE MESSAGE, deliberately — and both halves
   * matter. `summariseSuppressions` says "Nothing was suppressed." so an API
   * reader can tell a surface that ASKED from one that forgot; a chat message
   * that says it every single morning is a line a team stops reading, and then
   * the mornings that DO matter get skipped with it.
   */
  it('keeps the zero out of the chat message while still stating it in the data', async () => {
    db({});

    const digest = await collectDigest({ orgId: ORG, projectId: PROJECT }, SINCE, UNTIL);

    expect(digest!.suppressions.disclosure).toBe('Nothing was suppressed.');
    expect(renderDigest(digest!, 'https://app.test')).not.toContain('Suppressed in this window');
  });

  /*
   * SCOPED BY RUN ID, not by a date range on the ledger. A finaliser redelivered
   * the next morning writes its row then, and a digest that read
   * `createdAt BETWEEN since AND until` would attribute that suppression to the
   * wrong day — or miss it entirely.
   */
  it('scopes the ledger to this window’s runs rather than to a date range', async () => {
    const { ledgerQuery } = db({});

    await collectDigest({ orgId: ORG, projectId: PROJECT }, SINCE, UNTIL);

    expect(ledgerQuery).toHaveLength(1);
    const where = (ledgerQuery[0]!.where ?? {}) as Record<string, unknown>;
    expect(where.runId).toEqual({ in: ['run1'] });
    expect(where.createdAt).toBeUndefined();
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

// ─── The coverage line ───────────────────────────────────────────────────────

/**
 * The one sentence this company has, in the only message most of a team ever
 * reads about their test suite.
 *
 * Found by MUTATION: replacing the "not measured" branch with `0.0%` left this
 * whole suite green, which means the lie this field exists to prevent was
 * enforced by nothing but a comment — in a message that arrives in a chat
 * channel every morning, where nobody re-reads it after the first time they
 * have believed it.
 */
describe('the coverage line in a digest', () => {
  const WEB = 'https://app.qaai.dev';

  it('says NOT MEASURED in words, never 0%, when there is no snapshot', () => {
    const text = renderDigest(digestOf([digestItem()]), WEB);

    expect(text).toContain('Coverage: not measured');
    expect(text).toContain('this is not 0%');
    // The assertion that kills the mutant: no figure anywhere on the line.
    expect(text).not.toMatch(/Coverage: \d/);
  });

  it('reports the figure and a comparable delta', () => {
    const text = renderDigest(
      {
        ...digestOf([digestItem()]),
        coverage: {
          percent: 61.4,
          denominator: 412,
          tier: 'ASSERTED',
          deltaPercent: 6.4,
          comparability: 'COMPARABLE',
          comparabilityDetail: null,
          rollup: null,
        },
      },
      WEB,
    );

    expect(text).toContain('61.4% of 412 surface item(s) at ASSERTED');
    expect(text).toContain('(+6.4 points)');
  });

  it('REFUSES a delta across two crawl fingerprints and says why instead', () => {
    /*
     * The number is right there in the field. Subtracting two percentages
     * always succeeds, which is exactly why this has to be a refusal: the two
     * snapshots measured different applications, and "coverage fell 9 points"
     * in a morning digest is a regression a whole team will spend the morning
     * looking for.
     */
    const text = renderDigest(
      {
        ...digestOf([digestItem()]),
        coverage: {
          percent: 48,
          denominator: 100,
          tier: 'ASSERTED',
          deltaPercent: -9,
          comparability: 'UNCOMPARABLE_CRAWL_CHANGED',
          comparabilityDetail: 'the crawl fingerprint changed between the two',
          rollup: null,
        },
      },
      WEB,
    );

    expect(text).toContain('no comparable baseline');
    expect(text).toContain('crawl fingerprint changed');
    expect(text).not.toContain('-9.0 points');
  });

  it('says NOT MEASURED when the denominator was zero, rather than 0%', () => {
    const text = renderDigest(
      {
        ...digestOf([digestItem()]),
        coverage: {
          percent: null,
          denominator: 0,
          tier: 'ASSERTED',
          deltaPercent: null,
          comparability: 'UNCOMPARABLE_NO_BASELINE',
          comparabilityDetail: null,
          rollup: null,
        },
      },
      WEB,
    );

    expect(text).toContain('not measured (the denominator was zero');
    expect(text).not.toMatch(/Coverage: 0/);
  });

  it('names the unowned bucket as a FINDING rather than printing a sentinel', () => {
    // "UNOWNED" in a chat message is jargon. "surface nobody owns" is the
    // sentence a reader acts on — and an unowned bucket being the LARGEST one
    // is the single most useful thing this line can say.
    const text = renderDigest(
      {
        ...digestOf([digestItem()]),
        coverage: {
          percent: 61.4,
          denominator: 412,
          tier: 'ASSERTED',
          deltaPercent: null,
          comparability: 'UNCOMPARABLE_NO_BASELINE',
          comparabilityDetail: null,
          rollup: { label: 'surface nobody owns', percent: 12.5, denominator: 128 },
        },
      },
      WEB,
    );

    expect(text).toContain('surface nobody owns: 12.5% of 128');
  });

  it('renders an unmeasured rollup bucket as words too', () => {
    const text = renderDigest(
      {
        ...digestOf([digestItem()]),
        coverage: {
          percent: 61.4,
          denominator: 412,
          tier: 'ASSERTED',
          deltaPercent: null,
          comparability: 'UNCOMPARABLE_NO_BASELINE',
          comparabilityDetail: null,
          rollup: { label: 'the payments feature', percent: null, denominator: 40 },
        },
      },
      WEB,
    );

    expect(text).toContain('the payments feature: not measured of 40');
  });

  it('does NOT make a quiet digest speak', () => {
    /*
     * Coverage is deliberately absent from `hasSomethingToSay`. A window full
     * of passing runs must stay quiet, and "your coverage is still 61%" is not
     * news — it is the same number as yesterday, and a daily message that
     * always has something in it is a daily message nobody opens.
     */
    const quiet = {
      ...digestOf([]),
      coverage: {
        percent: 61.4,
        denominator: 412,
        tier: 'ASSERTED',
        deltaPercent: 6.4,
        comparability: 'COMPARABLE',
        comparabilityDetail: null,
        rollup: null,
      },
    };
    expect(hasSomethingToSay(quiet)).toBe(false);
  });
});
