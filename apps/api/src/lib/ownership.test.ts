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
  matchesPath,
  normalisePattern,
  normaliseRuleDraft,
  normaliseTestPath,
  ownerKey,
  resolveOwnership,
  resolveOwnershipFor,
} from './ownership.js';
import type { OwnableTest, OwnershipRuleInput } from './ownership.js';

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
