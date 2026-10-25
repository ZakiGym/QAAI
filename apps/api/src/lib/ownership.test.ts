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
