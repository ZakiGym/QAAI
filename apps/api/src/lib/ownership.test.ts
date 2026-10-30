/**
 * Safety tests for ownership.
 *
 * Every bug in this module is silent. A pattern that matches one directory too
 * many routes another team's failures at you; a pattern that matches one too few
 * routes yours at nobody, and "nobody" is indistinguishable from a suite that
 * has not been assigned yet. Neither shows up as an error, so the tests are the
 * only thing standing between the feature and a team quietly turning it off.
 *
 * Two contracts are being pinned:
 *
 *   1. The glob dialect is CODEOWNERS'. People paste these rules out of a file
 *      they already have, and a pattern that means something subtly different
 *      here is worse than one that is rejected.
 *   2. A rule that cannot be evaluated is REPORTED, never dropped. Skipping is
 *      how routing stops without anyone noticing.
 */

import { describe, expect, it } from 'vitest';
import {
  OwnershipRuleError,
  assignOwner,
  consensusOwner,
  matchesPath,
  normalisePattern,
  normaliseRuleDraft,
  normaliseTestPath,
  ownerKey,
  ownableSurface,
  ownerLabel,
  resolveOwnership,
  resolveOwnershipFor,
  verdictOwnerColumns,
} from './ownership.js';
import type { OwnableTest, OwnerAssignment, OwnershipRuleInput } from './ownership.js';

const rule = (over: Partial<OwnershipRuleInput> = {}): OwnershipRuleInput => ({
  id: 'rule_1',
  position: 0,
  pathPattern: null,
  testId: null,
  suiteId: null,
  feature: null,
  ownerUserId: null,
  ownerTeamId: 'team_payments',
  ...over,
});

const test = (over: Partial<OwnableTest> = {}): OwnableTest => ({
  id: 'test_1',
  filePath: 'tests/checkout/pay.spec.ts',
  suiteId: 'suite_1',
  feature: 'Checkout',
  ...over,
});

describe('path patterns', () => {
  it('matches everything under a directory with **', () => {
    expect(matchesPath('tests/checkout/**', 'tests/checkout/pay.spec.ts')).toBe(true);
    expect(matchesPath('tests/checkout/**', 'tests/checkout/deep/nested/pay.spec.ts')).toBe(true);
    expect(matchesPath('tests/checkout/**', 'tests/billing/pay.spec.ts')).toBe(false);
  });

  it('keeps * inside one segment', () => {
    expect(matchesPath('tests/*.spec.ts', 'tests/pay.spec.ts')).toBe(true);
    // The whole point of `*` not crossing a slash: this is a different rule.
    expect(matchesPath('tests/*.spec.ts', 'tests/checkout/pay.spec.ts')).toBe(false);
  });

  it('anchors a pattern that contains a slash, and floats one that does not', () => {
    // gitignore's rule, and the one people get wrong most often.
    expect(matchesPath('*.visual.ts', 'tests/deep/home.visual.ts')).toBe(true);
    expect(matchesPath('tests/home.spec.ts', 'e2e/tests/home.spec.ts')).toBe(false);
    expect(matchesPath('/playwright.config.ts', 'playwright.config.ts')).toBe(true);
    expect(matchesPath('/playwright.config.ts', 'packages/playwright.config.ts')).toBe(false);
  });

  it('treats a trailing slash as "this directory, wherever it is"', () => {
    expect(matchesPath('e2e/', 'e2e/home.spec.ts')).toBe(true);
    expect(matchesPath('e2e/', 'apps/web/e2e/home.spec.ts')).toBe(true);
    expect(matchesPath('e2e/', 'e2e-legacy/home.spec.ts')).toBe(false);
  });

  it('lets **/ cross any number of directories, including none', () => {
    expect(matchesPath('tests/**/*.spec.ts', 'tests/pay.spec.ts')).toBe(true);
    expect(matchesPath('tests/**/*.spec.ts', 'tests/a/b/pay.spec.ts')).toBe(true);
    expect(matchesPath('**/fixtures/**', 'apps/web/fixtures/user.json')).toBe(true);
  });

  it('does not let a name that merely starts the same match', () => {
    // `tests/checkout` and `tests/checkout-v2` are different directories, and a
    // prefix match here would hand one team the other team's failures.
    expect(matchesPath('tests/checkout/**', 'tests/checkout-v2/pay.spec.ts')).toBe(false);
  });

  it('matches ? against exactly one character, never a slash', () => {
    expect(matchesPath('tests/shard-?.spec.ts', 'tests/shard-1.spec.ts')).toBe(true);
    expect(matchesPath('tests/shard-?.spec.ts', 'tests/shard-12.spec.ts')).toBe(false);
    expect(matchesPath('tests/shard-?.spec.ts', 'tests/shard-/.spec.ts')).toBe(false);
  });

  it('treats a dot as a literal, not as "any character"', () => {
    expect(matchesPath('tests/pay.spec.ts', 'tests/payxspecxts')).toBe(false);
  });

  it('normalises a path before matching it', () => {
    expect(normaliseTestPath('./tests//checkout/pay.spec.ts')).toBe('tests/checkout/pay.spec.ts');
    expect(matchesPath('tests/checkout/**', './tests/checkout/pay.spec.ts')).toBe(true);
    expect(matchesPath('tests/checkout/**', 'tests\\checkout\\pay.spec.ts')).toBe(true);
  });

  it('stays case-sensitive, because git paths are', () => {
    expect(matchesPath('tests/Checkout/**', 'tests/checkout/pay.spec.ts')).toBe(false);
  });
});

describe('rejecting patterns this dialect does not have', () => {
  it('refuses negation instead of ignoring the !', () => {
    expect(() => normalisePattern('!tests/legacy/**')).toThrow(OwnershipRuleError);
  });

  it('refuses character ranges rather than matching them literally', () => {
    expect(() => normalisePattern('tests/shard-[12].spec.ts')).toThrow(OwnershipRuleError);
  });

  it('refuses backslashes, empty patterns and traversal', () => {
    expect(() => normalisePattern('tests\\checkout')).toThrow(OwnershipRuleError);
    expect(() => normalisePattern('   ')).toThrow(OwnershipRuleError);
    expect(() => normalisePattern('tests/../secrets/**')).toThrow(OwnershipRuleError);
  });

  it('caps length and depth so one rule cannot make every lookup expensive', () => {
    expect(() => normalisePattern(`tests/${'a'.repeat(300)}`)).toThrow(OwnershipRuleError);
    expect(() => normalisePattern(Array.from({ length: 40 }, () => '**').join('/'))).toThrow(
      OwnershipRuleError,
    );
  });
});

describe('precedence', () => {
  it('prefers the test over the suite, the feature and the pattern', () => {
    const resolution = resolveOwnership(test(), [
      rule({ id: 'r_path', pathPattern: 'tests/**', ownerTeamId: 'team_platform' }),
      rule({ id: 'r_feature', feature: 'Checkout', ownerTeamId: 'team_growth' }),
      rule({ id: 'r_suite', suiteId: 'suite_1', ownerTeamId: 'team_qa' }),
      rule({ id: 'r_test', testId: 'test_1', ownerUserId: 'user_dana', ownerTeamId: null }),
    ]);

    expect(resolution.owner?.ruleId).toBe('r_test');
    expect(resolution.owner?.owner).toEqual({ kind: 'USER', userId: 'user_dana' });
    // All four still matched: "why does Dana own this?" needs the whole list.
    expect(resolution.matched.map((m) => m.subject)).toEqual(['TEST', 'SUITE', 'FEATURE', 'PATH']);
  });

  it('gives the last matching path pattern the file, like CODEOWNERS', () => {
    // The catch-all is written first and the specific rule last, which is how
    // every CODEOWNERS file in the world is laid out.
    const resolution = resolveOwnership(test({ filePath: 'tests/billing/invoice.spec.ts' }), [
      rule({ id: 'r_catch_all', position: 0, pathPattern: '**', ownerTeamId: 'team_platform' }),
      rule({ id: 'r_billing', position: 1, pathPattern: 'tests/billing/**', ownerTeamId: 'team_billing' }),
    ]);

    expect(resolution.owner?.owner).toEqual({ kind: 'TEAM', teamId: 'team_billing' });
  });

  it('resolves the same way twice when two rules sit at the same position', () => {
    const rules = [
      rule({ id: 'r_a', position: 3, pathPattern: 'tests/**', ownerTeamId: 'team_a' }),
      rule({ id: 'r_b', position: 3, pathPattern: 'tests/**', ownerTeamId: 'team_b' }),
    ];
    const first = resolveOwnership(test(), rules).owner;
    const second = resolveOwnership(test(), [...rules].reverse()).owner;
    expect(first?.ruleId).toBe(second?.ruleId);
  });

  it('matches a feature regardless of case, and not at all when the test has none', () => {
    expect(
      resolveOwnership(test({ feature: 'checkout' }), [rule({ feature: 'Checkout' })]).owner,
    ).not.toBeNull();
    expect(resolveOwnership(test({ feature: null }), [rule({ feature: 'Checkout' })]).owner).toBeNull();
  });

  it('does not attach a suite rule to a test that has no suite', () => {
    // A test with no suite must not match a suite rule. Comparing the two ids
    // directly is only safe because of the emptiness check in front of it;
    // without it `null === null` would put every unsuited test in every suite.
    const suiteRule = rule({ suiteId: 'suite_1', ownerTeamId: 'team_qa' });
    expect(resolveOwnership(test({ suiteId: null }), [suiteRule]).owner).toBeNull();
    expect(resolveOwnership(test({ suiteId: 'suite_1' }), [suiteRule]).owner?.subject).toBe('SUITE');
  });
});

describe('an unowned test is a normal state', () => {
  it('returns null rather than inventing a fallback owner', () => {
    const resolution = resolveOwnership(test({ filePath: 'tests/search/query.spec.ts' }), [
      rule({ pathPattern: 'tests/checkout/**' }),
    ]);
    expect(resolution.owner).toBeNull();
    expect(resolution.matched).toEqual([]);
    expect(resolution.skipped).toEqual([]);
  });

  it('resolves an empty rule list without complaint', () => {
    expect(resolveOwnership(test(), []).owner).toBeNull();
  });
});

describe('bad rows are reported, never silently dropped', () => {
  it('skips a rule with no owner and says why', () => {
    const resolution = resolveOwnership(test(), [
      rule({ id: 'r_broken', pathPattern: 'tests/**', ownerTeamId: null }),
    ]);
    expect(resolution.owner).toBeNull();
    expect(resolution.skipped).toEqual([
      { ruleId: 'r_broken', reason: expect.stringContaining('exactly one owner') },
    ]);
  });

  it('skips a rule that names two subjects', () => {
    const resolution = resolveOwnership(test(), [
      rule({ id: 'r_two', pathPattern: 'tests/**', testId: 'test_1' }),
    ]);
    expect(resolution.skipped[0]?.ruleId).toBe('r_two');
  });

  it('skips a stored pattern that no longer compiles, and keeps resolving the rest', () => {
    // A pattern can only get into the database through normaliseRuleDraft, but
    // the validation may tighten later — and one poisoned row must not take the
    // whole project's routing down with it.
    const resolution = resolveOwnership(test(), [
      rule({ id: 'r_bad', pathPattern: 'tests/[a-z]/**' }),
      rule({ id: 'r_good', pathPattern: 'tests/checkout/**', ownerTeamId: 'team_payments' }),
    ]);

    expect(resolution.skipped[0]?.ruleId).toBe('r_bad');
    expect(resolution.owner?.ruleId).toBe('r_good');
  });
});

describe('resolveOwnershipFor', () => {
  it('answers for every test it was given, owned or not', () => {
    const tests = [
      test({ id: 'a', filePath: 'tests/checkout/pay.spec.ts' }),
      test({ id: 'b', filePath: 'tests/search/query.spec.ts' }),
    ];
    const resolved = resolveOwnershipFor(tests, [rule({ pathPattern: 'tests/checkout/**' })]);

    expect(resolved.size).toBe(2);
    expect(resolved.get('a')?.owner?.owner).toEqual({ kind: 'TEAM', teamId: 'team_payments' });
    expect(resolved.get('b')?.owner).toBeNull();
  });
});

describe('ownerKey', () => {
  it('keeps a user and a team with the same id apart', () => {
    expect(ownerKey({ kind: 'USER', userId: 'x' })).not.toBe(ownerKey({ kind: 'TEAM', teamId: 'x' }));
  });
});

describe('normaliseRuleDraft', () => {
  it('accepts one subject and one owner', () => {
    expect(normaliseRuleDraft({ pathPattern: '  tests/checkout/**  ', ownerTeamId: 'team_1' })).toEqual({
      subject: 'PATH',
      pathPattern: 'tests/checkout/**',
      testId: null,
      suiteId: null,
      feature: null,
      owner: { kind: 'TEAM', teamId: 'team_1' },
    });
  });

  it('refuses a rule that covers two things', () => {
    expect(() => normaliseRuleDraft({ testId: 't', suiteId: 's', ownerTeamId: 'team_1' })).toThrow(
      /one thing/,
    );
  });

  it('refuses a rule with two owners or none', () => {
    expect(() =>
      normaliseRuleDraft({ testId: 't', ownerTeamId: 'team_1', ownerUserId: 'user_1' }),
    ).toThrow(/one owner/);
    expect(() => normaliseRuleDraft({ testId: 't' })).toThrow(/routes nowhere/);
  });

  it('refuses an unusable pattern at write time, where it can still be fixed', () => {
    expect(() => normaliseRuleDraft({ pathPattern: '!tests/**', ownerTeamId: 'team_1' })).toThrow(
      OwnershipRuleError,
    );
    expect(() => normaliseRuleDraft({ pathPattern: '/', ownerTeamId: 'team_1' })).toThrow(
      OwnershipRuleError,
    );
  });

  it('treats whitespace as absent rather than as a subject', () => {
    expect(() => normaliseRuleDraft({ pathPattern: '   ', ownerTeamId: 'team_1' })).toThrow(
      /one of pathPattern/,
    );
  });
});

// ─── Assignment ──────────────────────────────────────────────────────────────

/**
 * The four kinds of nobody.
 *
 * `owner: null` is the answer in four different situations and only one of them
 * is benign. The expensive bug this section guards is the one that cannot be
 * seen: a rule that can no longer be evaluated reads, from outside, exactly
 * like a suite nobody has assigned — so a team that believes it is being paged
 * is not, and nothing anywhere says so. If `assignOwner` ever collapses
 * RULES_UNUSABLE into NO_MATCH, these tests are what notices.
 */
describe('assignOwner names which kind of nobody', () => {
  it('reports OWNED with the winning rule and its reason', () => {
    const assignment = assignOwner(test(), [rule({ id: 'r1', pathPattern: 'tests/checkout/**' })]);

    expect(assignment.state).toBe('OWNED');
    expect(assignment.owner).toEqual({ kind: 'TEAM', teamId: 'team_payments' });
    expect(assignment.ruleId).toBe('r1');
    expect(assignment.note).toContain('tests/checkout/**');
    expect(assignment.unusable).toEqual([]);
  });

  it('reports NO_RULES when nobody has opted in, without calling it a problem', () => {
    const assignment = assignOwner(test(), []);

    expect(assignment.state).toBe('NO_RULES');
    expect(assignment.owner).toBeNull();
    expect(assignment.note).toMatch(/Nobody has written an ownership rule/);
  });

  it('reports NO_MATCH, naming the path and the number of rules that missed it', () => {
    const assignment = assignOwner(test({ filePath: 'tests/search/query.spec.ts' }), [
      rule({ pathPattern: 'tests/checkout/**' }),
      rule({ id: 'r2', pathPattern: 'tests/billing/**' }),
    ]);

    expect(assignment.state).toBe('NO_MATCH');
    expect(assignment.note).toContain('tests/search/query.spec.ts');
    expect(assignment.note).toContain('2 ownership rules');
  });

  it('reports RULES_UNUSABLE — the case that looks identical to NO_MATCH from outside', () => {
    const assignment = assignOwner(test({ filePath: 'tests/search/query.spec.ts' }), [
      rule({ id: 'r_bad', pathPattern: 'tests/[a-z]/**' }),
    ]);

    // The whole point: not NO_MATCH. Routing has STOPPED, which is a different
    // fact and a different fix.
    expect(assignment.state).toBe('RULES_UNUSABLE');
    expect(assignment.note).toMatch(/could not be evaluated/);
    expect(assignment.unusable.map((u) => u.ruleId)).toEqual(['r_bad']);
  });

  it('still warns about a broken rule when another rule DID match', () => {
    const assignment = assignOwner(test(), [
      rule({ id: 'r_bad', pathPattern: 'tests/[a-z]/**' }),
      rule({ id: 'r_good', pathPattern: 'tests/checkout/**' }),
    ]);

    expect(assignment.state).toBe('OWNED');
    // A project can route this test correctly and still have a rule that has
    // quietly stopped routing twenty others.
    expect(assignment.unusable).toHaveLength(1);
    expect(assignment.note).toMatch(/could not be evaluated/);
  });
});

describe('verdictOwnerColumns', () => {
  it('writes BOTH ids on every assignment, so a re-route clears the old owner', () => {
    const toTeam = verdictOwnerColumns(
      assignOwner(test(), [rule({ pathPattern: 'tests/checkout/**' })]),
    );
    expect(toTeam).toMatchObject({ assigneeUserId: null, assigneeTeamId: 'team_payments' });

    const toUser = verdictOwnerColumns(
      assignOwner(test(), [
        rule({ pathPattern: 'tests/checkout/**', ownerTeamId: null, ownerUserId: 'user_dana' }),
      ]),
    );
    // The team id is null, not absent: a row that kept both would page whoever
    // used to own it as well as whoever does.
    expect(toUser).toMatchObject({ assigneeUserId: 'user_dana', assigneeTeamId: null });
  });

  it('carries the state and a bounded note for an unowned failure', () => {
    const columns = verdictOwnerColumns(assignOwner(test(), []));
    expect(columns.ownerState).toBe('NO_RULES');
    expect(columns.assigneeUserId).toBeNull();
    expect(columns.assigneeTeamId).toBeNull();
    expect(columns.ownerNote.length).toBeLessThanOrEqual(1_000);
    expect(columns.assignedAt).toBeInstanceOf(Date);
  });
});

describe('consensusOwner', () => {
  const owned = (teamId: string): OwnerAssignment => ({
    state: 'OWNED',
    owner: { kind: 'TEAM', teamId },
    ruleId: 'r',
    note: 'matched',
    unusable: [],
  });
  const unowned = (state: 'NO_MATCH' | 'NO_RULES' | 'RULES_UNUSABLE'): OwnerAssignment => ({
    state,
    owner: null,
    ruleId: null,
    note: state,
    unusable: [],
  });

  it('routes a unanimous cause to its owner', () => {
    const consensus = consensusOwner([owned('team_payments'), owned('team_payments')]);
    expect(consensus.state).toBe('OWNED');
    expect(consensus.owner).toEqual({ kind: 'TEAM', teamId: 'team_payments' });
  });

  it('refuses to pick a winner when the members disagree', () => {
    const consensus = consensusOwner([owned('team_payments'), owned('team_search')]);
    // Naming one of two teams is worse than naming none: one ignores the
    // ticket and the other closes it having fixed half the problem.
    expect(consensus.state).toBe('SPLIT');
    expect(consensus.owner).toBeNull();
    expect(consensus.note).toContain('2 different owners');
  });

  it('lets unowned members ride along without vetoing the owner', () => {
    const consensus = consensusOwner([owned('team_payments'), unowned('NO_MATCH')]);
    expect(consensus.state).toBe('OWNED');
    expect(consensus.note).toContain('1 of 2 are owned');
  });

  it('reports the worst reason when nobody owns any of them', () => {
    const consensus = consensusOwner([unowned('NO_MATCH'), unowned('RULES_UNUSABLE')]);
    // RULES_UNUSABLE is the one somebody has to act on, so it is the one the
    // ticket says.
    expect(consensus.state).toBe('RULES_UNUSABLE');
  });
});

describe('ownableSurface', () => {
  it('routes an untested route by the same path rules as a test', () => {
    const assignment = assignOwner(
      ownableSurface({ key: 'ROUTE:/checkout', file: 'app/checkout/page.tsx', feature: null }),
      [rule({ pathPattern: 'app/checkout/**' })],
    );
    expect(assignment.owner).toEqual({ kind: 'TEAM', teamId: 'team_payments' });
  });

  it('matches a FEATURE rule when the item has an attributed feature', () => {
    const assignment = assignOwner(
      ownableSurface({ key: 'ENDPOINT:POST /api/refunds', file: null, feature: 'Payments' }),
      [rule({ feature: 'payments' })],
    );
    expect(assignment.owner).toEqual({ kind: 'TEAM', teamId: 'team_payments' });
  });

  it('is unowned, not mis-owned, when the item has no file and no feature', () => {
    const assignment = assignOwner(
      ownableSurface({ key: 'ROUTE:/seen-only-by-the-crawl', file: null, feature: null }),
      [rule({ pathPattern: 'app/**' })],
    );
    expect(assignment.state).toBe('NO_MATCH');
    expect(assignment.owner).toBeNull();
  });

  /*
   * The pattern above is unowned because `app/**` happens not to match an
   * empty string. A CODEOWNERS CATCH-ALL does — `*` compiles to `[^/]*` — and
   * a catch-all is line 1 of most CODEOWNERS files, so this is the case that
   * decides whether "no file means no path owner" is a rule or an accident.
   * The giveaway was the reason sentence, which read " matches *." with
   * nothing in front of the verb.
   *
   * It must come out unowned. Every surface the crawl found and the source
   * analysis never declared would otherwise land on the catch-all team's
   * board, be filtered OUT of the `unowned: true` gap ticket, and count
   * towards that team's percentage in the owner rollup — and a gap on the
   * wrong team's board is worse than one on nobody's, because the wrong team
   * closes it.
   */
  it('a CODEOWNERS catch-all does not own a surface that has no file at all', () => {
    for (const pathPattern of ['*', '**/*', '*.ts']) {
      const assignment = assignOwner(
        ownableSurface({ key: 'ROUTE:/seen-only-by-the-crawl', file: null, feature: null }),
        [rule({ pathPattern })],
      );
      expect(assignment.state, pathPattern).toBe('NO_MATCH');
      expect(assignment.owner, pathPattern).toBeNull();
    }
  });

  /*
   * And the other half: a BROKEN rule must still be reported as unusable for
   * such an item. Suppressing the match must not suppress the warning, or the
   * guard above would hide the one state that means routing has stopped.
   */
  it('still reports a rule it cannot evaluate, even for an item with no file', () => {
    const assignment = assignOwner(
      ownableSurface({ key: 'ROUTE:/seen-only-by-the-crawl', file: null, feature: null }),
      [rule({ pathPattern: 'app/[abc]/**' })],
    );
    expect(assignment.state).toBe('RULES_UNUSABLE');
    expect(assignment.unusable).toHaveLength(1);
  });
});

describe('ownerLabel', () => {
  const directory = {
    users: new Map([['user_dana', { name: 'Dana Ruiz', email: 'dana@acme.test' }]]),
    teams: new Map([['team_payments', { slug: 'payments' }]]),
  };

  it('prints a team the way the digest does, so one owner reads as one owner', () => {
    expect(ownerLabel({ kind: 'TEAM', teamId: 'team_payments' }, directory)).toBe('@payments');
  });

  it('falls back from a name to an email', () => {
    expect(ownerLabel({ kind: 'USER', userId: 'user_dana' }, directory)).toBe('Dana Ruiz');
    expect(
      ownerLabel({ kind: 'USER', userId: 'u2' }, {
        users: new Map([['u2', { name: null, email: 'qa@acme.test' }]]),
        teams: new Map(),
      }),
    ).toBe('qa@acme.test');
  });

  it('says something true about a row that is gone, rather than rendering undefined', () => {
    expect(ownerLabel({ kind: 'TEAM', teamId: 'gone' }, directory)).toBe('a deleted team');
    expect(ownerLabel({ kind: 'USER', userId: 'gone' }, directory)).toBe('a deleted user');
  });
});

// ─── The promoted vocabulary, still reachable from here ─────────────────────

describe('the ownership vocabulary is re-exported, not just moved', () => {
  /*
   * `OwnershipState`, `IssueOwnerState`, `IssueSubject`, `OwnerRef` and
   * `OwnerAssignment` were declared in lib/ownership.ts and now live in
   * @qaai/shared, where the web app can name the state it renders. Three
   * modules import them FROM this one — routes/surface.ts, routes/issues.ts and
   * this test file — and a promotion without a re-export breaks all three for
   * no reader's benefit: a module that resolves ownership is exactly where a
   * caller looks for the words ownership is described in.
   *
   * Asserted on the VALUES because every one of them is the validated domain of
   * a TEXT column: a member dropped or respelled in transit does not fail to
   * compile, it fails to match a row somebody already wrote.
   */
  it('still exports the state lists, with the same members', async () => {
    const here = await import('./ownership.js');
    const shared = await import('@qaai/shared');

    expect([...here.OWNERSHIP_STATES]).toEqual([
      'OWNED',
      'NO_RULES',
      'NO_MATCH',
      'RULES_UNUSABLE',
    ]);
    expect([...here.ISSUE_OWNER_STATES]).toEqual([...here.OWNERSHIP_STATES, 'SPLIT']);
    expect([...here.ISSUE_SUBJECTS]).toEqual(['FAILURE', 'COVERAGE_GAP']);

    // The same arrays, not a second copy that can drift from them.
    expect(here.OWNERSHIP_STATES).toBe(shared.OWNERSHIP_STATES);
    expect(here.ISSUE_OWNER_STATES).toBe(shared.ISSUE_OWNER_STATES);
    expect(here.ISSUE_SUBJECTS).toBe(shared.ISSUE_SUBJECTS);
  });

  it('writes a state that `OWNERSHIP_STATES` contains, whatever happened', async () => {
    const here = await import('./ownership.js');
    const states = new Set<string>(here.OWNERSHIP_STATES);

    for (const assignment of [
      assignOwner(test({ filePath: 'tests/a.spec.ts' }), []),
      assignOwner(test({ filePath: 'tests/a.spec.ts' }), [
        rule({ pathPattern: 'nothing/**', ownerTeamId: 'team_payments' }),
      ]),
      assignOwner(test({ filePath: 'tests/a.spec.ts' }), [
        rule({ pathPattern: 'tests/**', ownerTeamId: 'team_payments' }),
      ]),
    ]) {
      // `TriageVerdict.ownerState` is a TEXT column with no enum behind it, so
      // this list is the only thing standing between it and a value no reader
      // switches on.
      expect(states.has(assignment.state)).toBe(true);
      expect(verdictOwnerColumns(assignment).ownerState).toBe(assignment.state);
    }
  });
});

// ─── Provenance: how well we know, not just who ──────────────────────────────

/*
 * WHAT THESE PROVE, in order of how expensive the bug would be:
 *
 *   1. A WEAK ANSWER IS NOT AN ASSIGNMENT. A bulk-imported glob, a git-blame
 *      guess and an inherited owner all produce `kind: 'SUGGESTED'` and
 *      `pageable: false`. The expensive version of this bug is a digest paging
 *      the payments team on the strength of a catch-all `tests/**`, which
 *      teaches the payments team to filter the digest — after which the feature
 *      is worse than not having it.
 *   2. A FALLBACK NEVER OVERRIDES A RULE. git blame speaks only when no rule
 *      matched. A fallback that won would move ownership on every re-run.
 *   3. `ownerProvenance` IS ACTUALLY WRITTEN. The column was minted by the
 *      keystone and a minted column owes a writer in the same round; the test
 *      asserts on the column, not on the function's return shape.
 *   4. AN UNUSABLE RULE SURVIVES EVERY PATH. Routing may have silently stopped
 *      for twenty other tests, and an answer reached by blame must still say so.
 */

/*
 * These arrive from `@qaai/shared` rather than by a four-dot relative path
 * through `packages/`: the barrel re-exports `./ownership` now, and the module
 * under test imports them that way too. One resolution for one module, so the
 * test cannot be exercising a second copy of the vocabulary.
 */
import {
  ASSIGNMENT_KINDS,
  CODEOWNERS_SOURCE,
  KIND_BY_STRENGTH,
  MAX_CODEOWNERS_CHARS,
  MAX_CODEOWNERS_LINES,
  OWNERSHIP_RULE_SELECT,
  PROVENANCE_BY_SUBJECT,
  RULE_ORIGINS,
  RULE_ORIGIN_BY_SOURCE,
  codeownersOwnerToken,
  codeownersRuleIdsOf,
  consensusProvenance,
  ownerClaimLabel,
  parseCodeowners,
  provenanceOfMatch,
  routeOwner,
  routeOwnershipFor,
  routingResolution,
  verdictRoutingColumns,
} from './ownership.js';

describe('every rule subject earns a provenance, and the tables cannot disagree', () => {
  it('names every subject, and every value is a RULE_ provenance', async () => {
    const { OWNER_PROVENANCES } = await import('@qaai/shared');
    const subjects = Object.keys(PROVENANCE_BY_SUBJECT).sort();
    expect(subjects).toEqual(['FEATURE', 'PATH', 'SUITE', 'TEST']);
    for (const provenance of Object.values(PROVENANCE_BY_SUBJECT)) {
      // A spelling that is not in the shared vocabulary would be stored in a
      // Prisma enum column and fail at the database, not here.
      expect(OWNER_PROVENANCES).toContain(provenance);
      expect(provenance.startsWith('RULE_')).toBe(true);
    }
  });

  it('ranks a test rule above a path rule, the same order the shared file declares', async () => {
    const { provenanceRank } = await import('@qaai/shared');
    expect(provenanceRank(PROVENANCE_BY_SUBJECT.TEST)).toBeLessThan(
      provenanceRank(PROVENANCE_BY_SUBJECT.SUITE),
    );
    expect(provenanceRank(PROVENANCE_BY_SUBJECT.SUITE)).toBeLessThan(
      provenanceRank(PROVENANCE_BY_SUBJECT.FEATURE),
    );
    expect(provenanceRank(PROVENANCE_BY_SUBJECT.FEATURE)).toBeLessThan(
      provenanceRank(PROVENANCE_BY_SUBJECT.PATH),
    );
  });

  it('agrees with mayPage about which strengths may be shown as an assignment', async () => {
    const { OWNER_PROVENANCES, OWNER_PROVENANCE_STRENGTH, mayPage } = await import('@qaai/shared');
    /*
     * The derivation, checked rather than asserted. `KIND_BY_STRENGTH` is meant
     * to be `mayPage` with a different name; a second threshold here is how a
     * catch-all glob comes to page again after somebody "tunes" one of the two.
     */
    for (const provenance of OWNER_PROVENANCES) {
      const kind = KIND_BY_STRENGTH[OWNER_PROVENANCE_STRENGTH[provenance]];
      expect(ASSIGNMENT_KINDS).toContain(kind);
      expect(kind === 'ASSIGNED').toBe(mayPage(provenance));
    }
  });
});

describe('a bulk-imported glob is a suggestion, not an assignment', () => {
  const pathRule = rule({ id: 'rule_glob', pathPattern: 'tests/**', ownerTeamId: 'team_payments' });

  it('is ASSIGNED when a person wrote the rule in QAAI', () => {
    const routed = routeOwner(test(), [pathRule]);
    expect(routed.provenance).toBe('RULE_PATH');
    expect(routed.kind).toBe('ASSIGNED');
    expect(routed.pageable).toBe(true);
    expect(routed.humanSet).toBe(false);
  });

  it('is SUGGESTED when the same rule arrived from a repository CODEOWNERS file', () => {
    const routed = routeOwner(test(), [pathRule], {
      codeownersRuleIds: new Set(['rule_glob']),
    });
    // Same owner, same rule, same match — a different thing to say about it.
    expect(routed.owner).toEqual({ kind: 'TEAM', teamId: 'team_payments' });
    expect(routed.provenance).toBe('CODEOWNERS_IMPORT');
    expect(routed.kind).toBe('SUGGESTED');
    expect(routed.pageable).toBe(false);
  });

  it('downgrades only the rule that was imported', () => {
    expect(
      provenanceOfMatch({ ruleId: 'rule_a', subject: 'PATH' }, new Set(['rule_b'])),
    ).toBe('RULE_PATH');
    expect(provenanceOfMatch({ ruleId: 'rule_b', subject: 'TEST' }, new Set(['rule_b']))).toBe(
      'CODEOWNERS_IMPORT',
    );
  });
});

describe('an explicit assignment is the only human answer', () => {
  it('beats every rule and is the one provenance a suppression may hang on', () => {
    const routed = routeOwner(test(), [rule({ pathPattern: 'tests/**', ownerTeamId: 'team_x' })], {
      explicit: { owner: { kind: 'USER', userId: 'user_dana' }, byLabel: 'Dana' },
    });
    expect(routed.owner).toEqual({ kind: 'USER', userId: 'user_dana' });
    expect(routed.provenance).toBe('EXPLICIT_ASSIGNMENT');
    expect(routed.humanSet).toBe(true);
    expect(routed.note).toContain('Dana');
  });

  it('carries the unusable-rule warning even though it did not consult a rule', () => {
    // A project can route this one failure by hand and still have a broken rule
    // that has stopped routing twenty others. Swallowing that is the whole
    // failure mode this file is arranged against.
    const broken = rule({ id: 'rule_bad', pathPattern: null, ownerTeamId: null });
    const routed = routeOwner(test(), [broken], {
      explicit: { owner: { kind: 'USER', userId: 'user_dana' } },
    });
    expect(routed.unusable).toHaveLength(1);
    expect(routed.note).toContain('could not be evaluated');
  });
});

describe('a weak fallback speaks only when no rule did', () => {
  it('does not override a matching rule with git blame', () => {
    const routed = routeOwner(test(), [rule({ pathPattern: 'tests/**', ownerTeamId: 'team_pay' })], {
      lastEditor: { userId: 'user_whoever' },
    });
    expect(routed.owner).toEqual({ kind: 'TEAM', teamId: 'team_pay' });
    expect(routed.provenance).toBe('RULE_PATH');
  });

  it('uses git blame when nothing matched, as a SUGGESTION', () => {
    const routed = routeOwner(test(), [rule({ pathPattern: 'other/**' })], {
      lastEditor: { userId: 'user_whoever' },
    });
    expect(routed.state).toBe('OWNED');
    expect(routed.provenance).toBe('LAST_EDITOR');
    expect(routed.kind).toBe('SUGGESTED');
    expect(routed.pageable).toBe(false);
    expect(routed.note).toContain('suggestion');
  });

  it('prefers an inherited owner to git blame', () => {
    const routed = routeOwner(test(), [], {
      inherited: { owner: { kind: 'TEAM', teamId: 'team_parent' }, fromLabel: 'its suite' },
      lastEditor: { userId: 'user_whoever' },
    });
    expect(routed.provenance).toBe('INHERITED');
    expect(routed.owner).toEqual({ kind: 'TEAM', teamId: 'team_parent' });
  });

  it('reports UNOWNED with provenance NONE when there is nothing to fall back to', () => {
    const routed = routeOwner(test(), []);
    expect(routed.state).toBe('NO_RULES');
    expect(routed.provenance).toBe('NONE');
    expect(routed.kind).toBe('UNOWNED');
    expect(routed.owner).toBeNull();
  });

  it('keeps RULES_UNUSABLE visible rather than reporting NO_MATCH', () => {
    const routed = routeOwner(test(), [rule({ id: 'rule_bad', pathPattern: null, ownerTeamId: null })]);
    expect(routed.state).toBe('RULES_UNUSABLE');
    expect(routed.kind).toBe('UNOWNED');
  });
});

describe('the verdict carries the provenance it was routed by', () => {
  it('writes ownerProvenance beside ownerState, never one without the other', () => {
    const routed = routeOwner(test(), [rule({ testId: 'test_1', ownerUserId: 'user_dana', ownerTeamId: null })]);
    const columns = verdictRoutingColumns(routed, new Date('2026-10-29T00:00:00Z'));
    expect(columns.ownerProvenance).toBe('RULE_TEST');
    expect(columns.ownerState).toBe('OWNED');
    expect(columns.assigneeUserId).toBe('user_dana');
    // Both ids on every write: a re-route from a user to a team must CLEAR the
    // user, or the row keeps paging whoever used to own it.
    expect(columns.assigneeTeamId).toBeNull();
    expect(columns.assignedAt.toISOString()).toBe('2026-10-29T00:00:00.000Z');
  });

  it('writes NONE rather than null when routing ran and found nobody', () => {
    // NULL means "nothing has tried to route this verdict yet". An unowned
    // failure that looks un-routed is how it stops being looked for.
    const columns = verdictRoutingColumns(routeOwner(test(), []));
    expect(columns.ownerProvenance).toBe('NONE');
    expect(columns.ownerState).toBe('NO_RULES');
  });

  it('resolves to the shared OwnerResolution shape, coherently', async () => {
    const { resolutionIsCoherent } = await import('@qaai/shared');
    for (const routed of [
      routeOwner(test(), [rule({ pathPattern: 'tests/**' })]),
      routeOwner(test(), []),
      routeOwner(test(), [], { lastEditor: { userId: 'user_x' } }),
    ]) {
      const resolution = routingResolution('FAILURE', routed);
      expect(resolution.subject).toBe('FAILURE');
      expect(resolutionIsCoherent(resolution)).toEqual({ coherent: true });
    }
  });

  it('routes a list, keyed by test id', () => {
    const routed = routeOwnershipFor(
      [test({ id: 't1' }), test({ id: 't2', filePath: 'other/x.spec.ts', suiteId: null, feature: null })],
      [rule({ pathPattern: 'tests/**', ownerTeamId: 'team_pay' })],
      (t) => (t.id === 't2' ? { lastEditor: { userId: 'user_x' } } : {}),
    );
    expect(routed.get('t1')?.provenance).toBe('RULE_PATH');
    expect(routed.get('t2')?.provenance).toBe('LAST_EDITOR');
  });
});

describe('importing a repository CODEOWNERS file', () => {
  it('parses handles, teams and emails and keeps the line number', () => {
    const parsed = parseCodeowners(
      ['# comment', '', 'tests/checkout/** @acme/payments', '*.visual.ts @dana dana@acme.com'].join('\n'),
    );
    expect(parsed.skipped).toEqual([]);
    expect(parsed.entries).toEqual([
      { line: 3, pathPattern: 'tests/checkout/**', owners: ['@acme/payments'] },
      { line: 4, pathPattern: '*.visual.ts', owners: ['@dana', 'dana@acme.com'] },
    ]);
  });

  it('refuses a line this dialect cannot express rather than reinterpreting it', () => {
    const parsed = parseCodeowners(['!tests/skip/** @acme/payments', 'src/[abc]/** @dana'].join('\n'));
    expect(parsed.entries).toEqual([]);
    expect(parsed.skipped.map((s) => s.line)).toEqual([1, 2]);
    // The sentence names the fix, because an import drops a thousand of these
    // at once and "invalid" is not something a human can act on.
    expect(parsed.skipped[0]!.reason).toContain('Negated patterns');
    expect(parsed.skipped[1]!.reason).toContain('Character ranges');
  });

  it('skips a section header rather than flattening its optional reviewers into owners', () => {
    const parsed = parseCodeowners('[Payments]\ntests/** @acme/payments');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.skipped[0]!.reason).toContain('approval counts');
  });

  it('refuses a half-parsed line rather than importing the half that parsed', () => {
    const parsed = parseCodeowners('tests/** @acme/payments some-garbage');
    expect(parsed.entries).toEqual([]);
    expect(parsed.skipped[0]!.reason).toContain('not imported');
  });

  it('reports a line with no owner rather than storing a rule that routes nowhere', () => {
    const parsed = parseCodeowners('tests/**');
    expect(parsed.entries).toEqual([]);
    expect(parsed.skipped[0]!.reason).toContain('routes nowhere');
  });

  it('REPORTS the line cap when it bites, with the count of what was not read', () => {
    /*
     * A cap applied without being disclosed is one of the lies this product
     * cannot afford: an import that silently stopped would leave a project
     * believing it had routed a directory it had not.
     */
    const lines = Array.from({ length: MAX_CODEOWNERS_LINES + 3 }, (_, i) => `d${i}/** @acme/t`);
    const parsed = parseCodeowners(lines.join('\n'));
    expect(parsed.entries).toHaveLength(MAX_CODEOWNERS_LINES);
    expect(parsed.truncated).not.toBeNull();
    expect(parsed.truncated!.lines).toBe(3);
    expect(parsed.truncated!.reason).toContain('still unowned');
  });

  it('reports null truncation when nothing was cut, rather than zero', () => {
    expect(parseCodeowners('tests/** @acme/t').truncated).toBeNull();
  });
});

describe('a ticket for many tests claims the weakest provenance behind it', () => {
  const routed = (over: Partial<OwnershipRuleInput>, ctx = {}) =>
    routeOwner(test(), [rule(over)], ctx);

  it('is as weak as the weakest owned member, never as strong as the strongest', () => {
    const strong = routeOwner(test(), [], {
      explicit: { owner: { kind: 'TEAM', teamId: 'team_pay' } },
    });
    const weak = routed({ id: 'r', pathPattern: 'tests/**', ownerTeamId: 'team_pay' }, {
      codeownersRuleIds: new Set(['r']),
    });
    // Taking the strongest would let one explicit assignment launder a glob's
    // guess into an assignment nobody made.
    expect(consensusProvenance([strong, strong, weak])).toEqual({
      provenance: 'CODEOWNERS_IMPORT',
      kind: 'SUGGESTED',
    });
    expect(consensusProvenance([strong, strong])).toEqual({
      provenance: 'EXPLICIT_ASSIGNMENT',
      kind: 'ASSIGNED',
    });
  });

  it('is not weakened by a member nobody owns', () => {
    const owned = routed({ pathPattern: 'tests/**', ownerTeamId: 'team_pay' });
    const nobody = routeOwner(test({ filePath: 'elsewhere/x.spec.ts' }), []);
    expect(consensusProvenance([owned, nobody])).toEqual({
      provenance: 'RULE_PATH',
      kind: 'ASSIGNED',
    });
  });

  it('reports NONE / UNOWNED when nothing is owned, rather than picking a member', () => {
    expect(consensusProvenance([routeOwner(test(), [])])).toEqual({
      provenance: 'NONE',
      kind: 'UNOWNED',
    });
    expect(consensusProvenance([])).toEqual({ provenance: 'NONE', kind: 'UNOWNED' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The CODEOWNERS column: one reader, one spelling, one phrasing
//
// `provenanceOfMatch` and `mayPage` have existed for a round and NOTHING IN
// PRODUCTION FED THEM: `routeOwner`'s `codeownersRuleIds` was empty at every
// call site because `OwnershipRule` had no `source` column, so every glob
// pasted out of a repository's CODEOWNERS file claimed the strength of a rule
// somebody typed. These are the three pieces that close it — the select that
// asks for the column, the reader that turns rows into the set, and the one
// phrasing both surfaces print.
// ─────────────────────────────────────────────────────────────────────────────

describe('codeownersRuleIdsOf is the only reader of OwnershipRule.source', () => {
  it('collects exactly the rules recorded as imported', () => {
    const ids = codeownersRuleIdsOf([
      { id: 'a', source: 'CODEOWNERS' },
      { id: 'b', source: 'MANUAL' },
      { id: 'c', source: 'CODEOWNERS' },
    ]);
    expect([...ids].sort()).toEqual(['a', 'c']);
  });

  it('treats NULL and ABSENT as not-imported, which is MANUAL and is true', () => {
    /*
     * The column is nullable and deliberately not back-filled. There was no
     * importer before it existed, so no row that predates it can have been
     * imported — which is the one case in this round where a null may be read
     * as a value, and the migration says so as its reason for not filling it.
     */
    expect(codeownersRuleIdsOf([{ id: 'a', source: null }]).size).toBe(0);
    expect(codeownersRuleIdsOf([{ id: 'a' }]).size).toBe(0);
  });

  it('asks "is it CODEOWNERS", never "is it not MANUAL"', () => {
    /*
     * A spelling this build has never heard of is UNKNOWN, and unknown is not
     * imported. Reading it as imported would silently stop a real assignment
     * paging anybody — RULES_UNUSABLE's failure mode, introduced quietly.
     */
    expect(codeownersRuleIdsOf([{ id: 'a', source: 'SOMETHING_LATER' }]).size).toBe(0);
  });

  it('is what `routeOwner` needs: the same rule, two strengths', () => {
    const imported = rule({ id: 'rule_glob', pathPattern: 'tests/**', ownerTeamId: 'team_pay' });
    const bare = routeOwner(test(), [imported]);
    const weak = routeOwner(test(), [imported], {
      codeownersRuleIds: codeownersRuleIdsOf([{ id: 'rule_glob', source: CODEOWNERS_SOURCE }]),
    });

    // Identical matching, identical owner, different strength — and only the
    // first of the two may wake somebody up.
    expect(bare.owner).toEqual(weak.owner);
    expect(bare).toMatchObject({ provenance: 'RULE_PATH', kind: 'ASSIGNED', pageable: true });
    expect(weak).toMatchObject({
      provenance: 'CODEOWNERS_IMPORT',
      kind: 'SUGGESTED',
      pageable: false,
    });
  });
});

describe('the stored source has one spelling and the compiler is its validator', () => {
  it('is a member of the domain the column accepts', async () => {
    const { OWNERSHIP_RULE_SOURCES } = await import('@qaai/shared');
    /*
     * LESSON H, in the only form available for a TEXT column. There is no zod
     * schema and no database enum between `source: 'CODEOWNER'` and a stored
     * row — the annotation on `CODEOWNERS_SOURCE` is the whole guard, and this
     * asserts the value it holds is one the domain actually names rather than
     * merely that it is spelled the way this test spells it.
     */
    expect(OWNERSHIP_RULE_SOURCES).toContain(CODEOWNERS_SOURCE);
  });

  it('maps every stored source onto an origin this module can reason about', async () => {
    const { OWNERSHIP_RULE_SOURCES } = await import('@qaai/shared');
    // Compiler-enforced by `satisfies`; this is the run-time half, over the
    // shared list rather than over the record's own keys — a check against its
    // own keys could not notice a member added to the domain.
    expect(Object.keys(RULE_ORIGIN_BY_SOURCE).sort()).toEqual([...OWNERSHIP_RULE_SOURCES].sort());
    for (const origin of Object.values(RULE_ORIGIN_BY_SOURCE)) {
      expect(RULE_ORIGINS).toContain(origin);
    }
  });

  it('is in the SHARED select, so no surface can forget to ask', () => {
    /*
     * The three routing surfaces take their field list from here. A copy that
     * dropped `source` would not fail — every rule would read as hand-typed
     * and every imported glob would page, which is invisible in the output.
     */
    expect(OWNERSHIP_RULE_SELECT).toMatchObject({ source: true, position: true });
  });
});

describe('ownerClaimLabel — one fact, one phrasing, two surfaces', () => {
  it('prints a pageable owner bare', () => {
    expect(ownerClaimLabel('@payments', true)).toBe('@payments');
  });

  it('qualifies a weak one, and still names it', () => {
    /*
     * The name is kept because it is the best lead there is. What changes is
     * the claim: a digest or a 3am page that printed an imported glob's team
     * exactly as a human assignment is how a team that was never asked learns
     * to mute the channel.
     */
    expect(ownerClaimLabel('@payments', false)).toBe('@payments (suggested, not paged)');
  });

  it('agrees with `mayPage` for every provenance, rather than re-deciding', async () => {
    const { OWNER_PROVENANCES, mayPage } = await import('@qaai/shared');
    for (const provenance of OWNER_PROVENANCES) {
      const qualified = ownerClaimLabel('@x', mayPage(provenance)) !== '@x';
      expect(qualified).toBe(!mayPage(provenance));
    }
  });
});

describe('codeownersOwnerToken reads a token’s SHAPE and resolves nothing', () => {
  it('reads an @org/team as its slug, which is the part QAAI stores', () => {
    expect(codeownersOwnerToken('@acme/payments')).toEqual({ kind: 'TEAM', slug: 'payments' });
  });

  it('reads a bare @handle as a team slug, and never guesses an email for it', () => {
    /*
     * QAAI stores no GitHub handles. Matching `@dana` against a user by
     * composing an address would INVENT one, which is the opposite of
     * resolving from our own records.
     */
    expect(codeownersOwnerToken('@dana')).toEqual({ kind: 'TEAM', slug: 'dana' });
  });

  it('reads an email as a user', () => {
    expect(codeownersOwnerToken('dana@acme.test')).toEqual({
      kind: 'USER',
      email: 'dana@acme.test',
    });
  });

  it('refuses a shape GitHub does not produce rather than reading its last segment', () => {
    // `@acme/payments/oncall` read as `oncall` would import a team nobody named.
    expect(codeownersOwnerToken('@acme/payments/oncall')).toBeNull();
  });

  it('refuses what it cannot classify, so the caller refuses the LINE', () => {
    for (const token of [
      '',
      '   ',
      '@',
      '@/',
      'not-a-token',
      'a@b@c',
      'dana@localhost',
      'dana@',
      '@acme/pay@ments',
      `@${'a'.repeat(300)}`,
      '@team\u0007name',
    ]) {
      expect(codeownersOwnerToken(token)).toBeNull();
    }
  });
});

describe('normalisePattern refuses a control character, before anything quotes it', () => {
  it('refuses it, and the sentence names the field and not the pattern', () => {
    /*
     * THE DEFECT: `stripped.split(/\s+/)` in `parseCodeowners` does not treat
     * U+0007 as a separator, so such a pattern stored fine and then reached
     * `compilePattern`'s doubled-slash refusal — which INTERPOLATES THE
     * PATTERN. A newline or an escape sequence out of a customer's own file
     * then landed in `OwnerAssignment.unusable[].reason`, which is copied into
     * `TriageVerdict.ownerNote` and read by a human and a model.
     */
    let message = '';
    try {
      normalisePattern('specs/evil\u0007/**');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('control character');
    expect(message).not.toContain('evil');
    expect(message).not.toContain('\u0007');
  });

  it('refuses a newline and a DEL, not only the obvious one', () => {
    for (const bad of ['a\nb/**', 'a\rb/**', 'a\u007fb/**', 'a\u0000b/**']) {
      expect(() => normalisePattern(bad)).toThrow(OwnershipRuleError);
    }
  });

  it('is the validator the IMPORT path runs, so such a line is skipped by number', () => {
    const parsed = parseCodeowners('specs/evil\u0007/** @acme/payments\nspecs/ok/** @acme/qa\n');
    expect(parsed.entries.map((entry) => entry.pathPattern)).toEqual(['specs/ok/**']);
    expect(parsed.skipped.map((row) => row.line)).toEqual([1]);
    // And the skip reason carries no byte of the line, which is what lets the
    // endpoint report it to a customer.
    expect(parsed.skipped[0]!.reason).not.toContain('evil');
  });

  it('still accepts the patterns a real CODEOWNERS file contains', () => {
    for (const good of ['*', 'tests/**', '/playwright.config.ts', 'e2e/', '*.spec.ts']) {
      expect(normalisePattern(good)).toBe(good);
    }
  });
});

describe('MAX_CODEOWNERS_CHARS bounds what a request may CARRY', () => {
  it('is a different job from the line cap, and sits above a real file', () => {
    /*
     * The line cap bounds what is READ and DISCLOSES what it did not read; this
     * bounds what arrives at all and is a refusal. A single three-megabyte line
     * is one line as far as the line cap is concerned.
     */
    expect(MAX_CODEOWNERS_CHARS).toBeGreaterThan(MAX_CODEOWNERS_LINES * 100);
  });
});
