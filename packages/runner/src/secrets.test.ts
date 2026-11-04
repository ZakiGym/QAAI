/**
 * The control: a secret reaches a test only when a row says it may.
 *
 * ── WHAT THESE TESTS ARE GUARDING AGAINST, SPECIFICALLY ────────────────────
 *
 * The defect is not subtle and that is what makes the regression easy: today
 * `secretsFor(orgId, environmentId)` decrypts the whole environment into one
 * map and every plugin for every test reads it, so a test that needs a payment
 * provider's test key also receives the production database password. Any
 * change that restores a "just pass the map through" path puts it back.
 *
 * So the assertions below are deliberately of three kinds, and the second and
 * third are the ones that would catch a plausible-looking regression:
 *
 *  1. per-kind admission — the obvious half.
 *  2. THE ARITHMETIC. `injected + withheld === considered`, and
 *     `injected === Object.keys(values).length`, over every input shape. A
 *     second writer of `values` — which is exactly what "pass the map through"
 *     looks like in a diff — breaks these without touching a matcher.
 *  3. THE STRUCTURAL SWEEP. In ENFORCE, every name in `values` is proved to
 *     have an admitting row, over a table of mixed rows. A matcher that
 *     accidentally returns `'ADMIT'` on a fall-through passes every test in
 *     group 1 and fails this one.
 *
 * ── NO SECRET IN A TEST NAME, A MESSAGE OR A LITERAL ───────────────────────
 *
 * The plaintext used below is composed at run time from a prefix in
 * `SECRET_SHAPES` plus an obviously fake tail, because a complete key-shaped
 * literal in source is a thing push protection rejects — and it has rejected a
 * finished commit in this repository for exactly that, including a literal
 * inside the comment explaining its own removal.
 */

import { describe, expect, it } from 'vitest';
import { SECRET_SCOPE_KINDS, SECRET_SCOPE_RULES, SECRET_SHAPES } from '@qaai/shared';
import type { ControlMode, SecretScopeKind } from '@qaai/shared';
import {
  WITHHOLD_CAUSES,
  WITHHOLD_CAUSE_LIST,
  SCOPE_MATCHER_KINDS,
  resolveScopedSecrets,
  scopeAudit,
  unscopedSecrets,
  withheldNote,
  withholdCauseFor,
} from './secrets.js';
import type { ScopableSecret, SecretScopeRow, SecretTarget } from './secrets.js';

const SHAPE = SECRET_SHAPES[0];
if (!SHAPE) throw new Error('SECRET_SHAPES is empty, so the fake plaintext cannot be composed');

/** A value that LOOKS like a credential without being one. Never a literal. */
const FAKE_PLAINTEXT = `${SHAPE.prefix}obviously-not-a-real-credential`;

const TARGET: SecretTarget = {
  testId: 'test_cart',
  testType: 'INTEGRATION',
  suiteId: 'suite_checkout',
  authProfileId: 'profile_admin',
};

function secret(id: string, name = id.toUpperCase()): ScopableSecret {
  return { id, name, value: `${FAKE_PLAINTEXT}-${id}` };
}

function row(secretId: string, kind: SecretScopeKind, value: string | null): SecretScopeRow {
  return { secretId, kind, value };
}

/** The value a row of this kind would carry to admit {@link TARGET}. */
const ADMITTING_VALUE: Record<SecretScopeKind, string | null> = {
  TEST: TARGET.testId,
  SUITE: TARGET.suiteId,
  TEST_TYPE: TARGET.testType,
  AUTH_PROFILE: TARGET.authProfileId,
  ENVIRONMENT_WIDE: null,
};

// ─── The two presence records, against their lists ───────────────────────────

describe('the vocabulary is derived, not restated', () => {
  it('has one matcher per scope kind the shared vocabulary declares', () => {
    // The compile-time half is the `Record<SecretScopeKind, …>` on
    // SCOPE_MATCHERS; this is the run-time half. Lesson D of this round: one
    // without the other passes while the two disagree.
    expect([...SCOPE_MATCHER_KINDS].sort()).toEqual([...SECRET_SCOPE_KINDS].sort());
  });

  it('derives the cause list from the presence record', () => {
    expect([...WITHHOLD_CAUSE_LIST].sort()).toEqual([...WITHHOLD_CAUSES].sort());
  });

  it('agrees with SECRET_SCOPE_RULES about which kind names nothing', () => {
    /*
     * The cross-check, not a restatement. `SECRET_SCOPE_RULES[kind].names ===
     * 'NOTHING'` is the shared table's claim about ENVIRONMENT_WIDE; the
     * matcher's claim is that a null `value` admits. If the two ever disagree,
     * a null becomes a wildcard on one of the four kinds that name something —
     * which would turn the single broadest scope into four of them.
     */
    for (const kind of SECRET_SCOPE_KINDS) {
      const namesNothing = SECRET_SCOPE_RULES[kind].names === 'NOTHING';
      const nullAdmits =
        withholdCauseFor(secret('s'), [row('s', kind, null)], TARGET) === null;
      expect(nullAdmits).toBe(namesNothing);
    }
  });
});

// ─── Default deny ────────────────────────────────────────────────────────────

describe('the absence of a row is the denial', () => {
  it('injects nothing when no secret has a scope row, under ENFORCE', () => {
    const scoped = resolveScopedSecrets({
      secrets: [secret('db'), secret('stripe'), secret('s3')],
      scopes: [],
      target: TARGET,
      mode: 'ENFORCE',
    });

    expect(scoped.values).toEqual({});
    expect(scoped.considered).toBe(3);
    expect(scoped.injected).toBe(0);
    expect(scoped.withheld).toBe(3);
    expect(scoped.withheldByCause.NO_SCOPE_ROW).toBe(3);
  });

  it('withholds the production password while admitting the test key', () => {
    // The defect, in one assertion. A test scoped to the payment provider's key
    // must not come away with the database password as well.
    const stripe = secret('stripe', 'STRIPE_TEST_KEY');
    const db = secret('db', 'PROD_DATABASE_PASSWORD');

    const scoped = resolveScopedSecrets({
      secrets: [stripe, db],
      scopes: [row('stripe', 'TEST', TARGET.testId)],
      target: TARGET,
      mode: 'ENFORCE',
    });

    expect(Object.keys(scoped.values)).toEqual(['STRIPE_TEST_KEY']);
    expect(scoped.values.PROD_DATABASE_PASSWORD).toBeUndefined();
    expect(scoped.withheld).toBe(1);
  });
});

describe('each scope kind admits exactly what it names', () => {
  it.each(SECRET_SCOPE_KINDS)('admits a %s row that names this target', (kind) => {
    const scoped = resolveScopedSecrets({
      secrets: [secret('s')],
      scopes: [row('s', kind, ADMITTING_VALUE[kind])],
      target: TARGET,
      mode: 'ENFORCE',
    });
    expect(scoped.injected).toBe(1);
  });

  it.each(SECRET_SCOPE_KINDS.filter((k) => SECRET_SCOPE_RULES[k].names !== 'NOTHING'))(
    'refuses a %s row that names something else',
    (kind) => {
      expect(withholdCauseFor(secret('s'), [row('s', kind, 'somebody_else')], TARGET)).toBe(
        'SCOPE_NAMES_SOMETHING_ELSE',
      );
    },
  );

  it('does not let ENVIRONMENT_WIDE carry a value', () => {
    // It names NOTHING, so a row with a value is not an annotated wildcard —
    // its author meant one of the other four kinds, and guessing which is how a
    // scope ends up broader than anybody approved.
    expect(
      withholdCauseFor(secret('s'), [row('s', 'ENVIRONMENT_WIDE', TARGET.testId)], TARGET),
    ).toBe('SCOPE_ROW_MALFORMED');
  });

  it.each(['TEST', 'SUITE', 'TEST_TYPE', 'AUTH_PROFILE'] as const)(
    'treats a null value on %s as malformed rather than as a wildcard',
    (kind) => {
      expect(withholdCauseFor(secret('s'), [row('s', kind, null)], TARGET)).toBe(
        'SCOPE_ROW_MALFORMED',
      );
    },
  );

  it('refuses a kind this build has never heard of', () => {
    // A row written by a newer deployment against the same database. Unknown and
    // refused have to land in the same place; a `default:` that allowed would
    // make every future enum member a hole.
    const unknown = { secretId: 's', kind: 'ORG_WIDE' as SecretScopeKind, value: null };
    expect(withholdCauseFor(secret('s'), [unknown], TARGET)).toBe('SCOPE_ROW_MALFORMED');
  });

  it('admits when ANY row admits, and reports the most actionable cause otherwise', () => {
    const admitted = withholdCauseFor(
      secret('s'),
      [row('s', 'TEST', 'another_test'), row('s', 'TEST_TYPE', TARGET.testType)],
      TARGET,
    );
    expect(admitted).toBeNull();

    // Row order is a property of the query, so the cause must not depend on it.
    const rows = [row('s', 'TEST', 'another_test'), row('s', 'ENVIRONMENT_WIDE', 'oops')];
    expect(withholdCauseFor(secret('s'), rows, TARGET)).toBe('SCOPE_ROW_MALFORMED');
    expect(withholdCauseFor(secret('s'), [...rows].reverse(), TARGET)).toBe(
      'SCOPE_ROW_MALFORMED',
    );
  });
});

describe('a fact the caller does not have is not a match', () => {
  it.each([
    ['SUITE', 'suiteId'],
    ['AUTH_PROFILE', 'authProfileId'],
  ] as const)('withholds a %s scope when the run cannot say which %s it is', (kind, field) => {
    const blind: SecretTarget = { ...TARGET, [field]: null };
    const scoped = resolveScopedSecrets({
      secrets: [secret('s')],
      scopes: [row('s', kind, 'anything')],
      target: blind,
      mode: 'ENFORCE',
    });

    expect(scoped.injected).toBe(0);
    expect(scoped.withheldByCause.TARGET_FACT_MISSING).toBe(1);
  });
});

// ─── Measured zero vs unmeasured ─────────────────────────────────────────────

describe('"we looked and found none" is not "we did not look"', () => {
  it('reports an empty row set as a measurement', () => {
    const scoped = resolveScopedSecrets({
      secrets: [secret('s')],
      scopes: [],
      target: TARGET,
      mode: 'ENFORCE',
    });
    expect(scoped.source).toBe('SCOPE_ROWS');
    expect(scoped.withheldByCause.NO_SCOPE_ROW).toBe(1);
    expect(scoped.withheldByCause.SCOPES_UNAVAILABLE).toBe(0);
  });

  it('reports UNAVAILABLE as unmeasured, and still withholds under ENFORCE', () => {
    const scoped = resolveScopedSecrets({
      secrets: [secret('s')],
      scopes: 'UNAVAILABLE',
      target: TARGET,
      mode: 'ENFORCE',
    });
    expect(scoped.source).toBe('UNAVAILABLE');
    expect(scoped.withheldByCause.SCOPES_UNAVAILABLE).toBe(1);
    expect(scoped.withheldByCause.NO_SCOPE_ROW).toBe(0);
    // Fail closed: a scope that cannot be determined does not inject.
    expect(scoped.values).toEqual({});
  });

  it('says so in the note, so the number is not read as a finding', () => {
    const note = withheldNote(
      resolveScopedSecrets({
        secrets: [secret('s')],
        scopes: 'UNAVAILABLE',
        target: TARGET,
        mode: 'OBSERVE',
      }),
    );
    expect(note).toMatch(/not measured/);
  });

  it('builds an UNAVAILABLE set from a flat name-keyed map', () => {
    // Every existing plugin receives `RunContext.secrets`, which has no ids.
    // That path must be recorded as unmeasured rather than as a clean zero.
    const scoped = unscopedSecrets({ A: FAKE_PLAINTEXT, B: FAKE_PLAINTEXT }, TARGET, 'OBSERVE');
    expect(scoped.source).toBe('UNAVAILABLE');
    expect(scoped.wouldWithhold).toBe(2);
    expect(scoped.injected).toBe(2);
  });
});

// ─── The brake ───────────────────────────────────────────────────────────────

describe('the brake counts what enforcing would have refused', () => {
  const input = {
    secrets: [secret('db'), secret('stripe')],
    scopes: [row('stripe', 'TEST', TARGET.testId)],
    target: TARGET,
  } as const;

  it('changes nothing in OBSERVE, and counts the one it would have refused', () => {
    const scoped = resolveScopedSecrets({ ...input, mode: 'OBSERVE' });

    // The whole point of the default: no existing install has a scope row, so
    // ENFORCE on day one takes the credentials away from every test at once.
    expect(Object.keys(scoped.values).sort()).toEqual(['DB', 'STRIPE']);
    expect(scoped.withheld).toBe(0);
    expect(scoped.wouldWithhold).toBe(1);
  });

  it('keeps the two numbers as TWO numbers', () => {
    // One field reading "1" would be true in both modes and mean something
    // different in each. `verified` was defensibly true for a heal that left
    // the test red; two facts in one field is a defect even when both readings
    // are correct.
    const observed = resolveScopedSecrets({ ...input, mode: 'OBSERVE' });
    const enforced = resolveScopedSecrets({ ...input, mode: 'ENFORCE' });

    expect([observed.withheld, observed.wouldWithhold]).toEqual([0, 1]);
    expect([enforced.withheld, enforced.wouldWithhold]).toEqual([1, 1]);
  });

  it('says which mode produced the set', () => {
    for (const mode of ['OBSERVE', 'ENFORCE'] as const) {
      expect(resolveScopedSecrets({ ...input, mode }).mode).toBe(mode);
    }
  });

  it('warns rather than claiming a refusal, in OBSERVE', () => {
    const note = withheldNote(resolveScopedSecrets({ ...input, mode: 'OBSERVE' }));
    expect(note).toMatch(/WERE provided/);
    expect(note).toMatch(/observe mode/);
    expect(note).toMatch(/warning, not a failure/);
  });
});

// ─── What a human is told ────────────────────────────────────────────────────

describe('the note is counts only', () => {
  const stripe = secret('stripe', 'STRIPE_TEST_KEY');
  const db = secret('db', 'PROD_DATABASE_PASSWORD');

  it('names no secret and quotes no value, in either mode or any cause', () => {
    for (const mode of ['OBSERVE', 'ENFORCE'] as const) {
      for (const scopes of [[] as SecretScopeRow[], 'UNAVAILABLE' as const]) {
        const scoped = resolveScopedSecrets({
          secrets: [stripe, db],
          scopes,
          target: TARGET,
          mode,
          requested: ['STRIPE_TEST_KEY', 'PROD_DATABASE_PASSWORD', 'TYPO'],
        });
        const note = withheldNote(scoped);
        expect(note).not.toBeNull();
        // A name is itself a disclosure: "so there IS a PROD_DATABASE_PASSWORD
        // in this environment". The author's question is answered by a count.
        expect(note).not.toContain('PROD_DATABASE_PASSWORD');
        expect(note).not.toContain('STRIPE_TEST_KEY');
        expect(note).not.toContain(SHAPE.prefix);
        expect(JSON.stringify(scopeAudit(scoped))).not.toContain(SHAPE.prefix);
        expect(JSON.stringify(scopeAudit(scoped))).not.toContain('STRIPE_TEST_KEY');
      }
    }
  });

  it('reads the same for every cause, so it cannot be used to probe', () => {
    // No-oracle: the cause is operator-facing and lives on the result. Two
    // authors whose secrets were withheld for different reasons see one
    // sentence, differing only in the count.
    const noRow = withheldNote(
      resolveScopedSecrets({ secrets: [stripe], scopes: [], target: TARGET, mode: 'ENFORCE' }),
    );
    const otherTest = withheldNote(
      resolveScopedSecrets({
        secrets: [stripe],
        scopes: [row('stripe', 'TEST', 'test_somebody_else')],
        target: TARGET,
        mode: 'ENFORCE',
      }),
    );
    expect(noRow).toBe(otherTest);
  });

  it('says nothing when nothing was withheld', () => {
    expect(
      withheldNote(
        resolveScopedSecrets({
          secrets: [stripe],
          scopes: [row('stripe', 'ENVIRONMENT_WIDE', null)],
          target: TARGET,
          mode: 'ENFORCE',
        }),
      ),
    ).toBeNull();
  });

  it('reports a misspelt name as a different problem from a refusal', () => {
    // A typo reported as a scoping refusal sends the reader to an owner to
    // widen a scope that was never the problem.
    const scoped = resolveScopedSecrets({
      secrets: [stripe],
      scopes: [row('stripe', 'TEST', TARGET.testId)],
      target: TARGET,
      mode: 'ENFORCE',
      requested: ['STRIPE_TEST_KEY', 'STRIPE_TEST_KEYY'],
    });

    expect(scoped.absent).toBe(1);
    expect(scoped.withheld).toBe(0);
    expect(withheldNote(scoped)).toMatch(/check the spelling/);
  });
});

// ─── The structural guarantees ───────────────────────────────────────────────

describe('nothing reaches a test uncounted', () => {
  /** Every interesting shape, crossed with both modes. */
  const CASES: Array<{
    label: string;
    secrets: ScopableSecret[];
    scopes: readonly SecretScopeRow[] | 'UNAVAILABLE';
    requested?: readonly string[] | null;
  }> = [
    { label: 'no secrets at all', secrets: [], scopes: [] },
    { label: 'no rows', secrets: [secret('a'), secret('b')], scopes: [] },
    { label: 'unmeasured', secrets: [secret('a'), secret('b')], scopes: 'UNAVAILABLE' },
    {
      label: 'one admitting row',
      secrets: [secret('a'), secret('b'), secret('c')],
      scopes: [row('b', 'TEST', TARGET.testId)],
    },
    {
      label: 'every kind at once',
      secrets: SECRET_SCOPE_KINDS.map((kind) => secret(kind.toLowerCase())),
      scopes: SECRET_SCOPE_KINDS.map((kind) =>
        row(kind.toLowerCase(), kind, ADMITTING_VALUE[kind]),
      ),
    },
    {
      label: 'rows that name other tests',
      secrets: [secret('a'), secret('b')],
      scopes: [row('a', 'TEST', 'other'), row('b', 'SUITE', 'other')],
    },
    {
      label: 'malformed rows',
      secrets: [secret('a'), secret('b')],
      scopes: [row('a', 'TEST', null), row('b', 'ENVIRONMENT_WIDE', 'x')],
    },
    {
      label: 'a request with a duplicate and a typo',
      secrets: [secret('a'), secret('b')],
      scopes: [row('a', 'ENVIRONMENT_WIDE', null)],
      requested: ['A', 'A', 'MISSPELT'],
    },
  ];

  const MODES: ControlMode[] = ['OBSERVE', 'ENFORCE'];

  it.each(CASES.flatMap((c) => MODES.map((mode) => [`${c.label} / ${mode}`, c, mode] as const)))(
    'the arithmetic adds up for %s',
    (_label, c, mode) => {
      const scoped = resolveScopedSecrets({
        secrets: c.secrets,
        scopes: c.scopes,
        target: TARGET,
        mode,
        requested: c.requested ?? null,
      });

      // The invariant the resolver also asserts internally. A second writer of
      // `values` — "just pass the map through" in a diff — breaks this.
      expect(scoped.injected).toBe(Object.keys(scoped.values).length);
      expect(scoped.injected + scoped.withheld).toBe(scoped.considered);
      // Every withheld secret is attributed to exactly one cause.
      const attributed = Object.values(scoped.withheldByCause).reduce((a, b) => a + b, 0);
      expect(attributed).toBe(scoped.wouldWithhold);
      expect(scoped.withheld).toBe(mode === 'ENFORCE' ? scoped.wouldWithhold : 0);
    },
  );

  it.each(CASES)('every secret ENFORCE injects has an admitting row: $label', (c) => {
    /*
     * THE SWEEP. A matcher that accidentally returns 'ADMIT' from a
     * fall-through passes every per-kind test above and fails here, because
     * this re-derives admission from the ROWS rather than from the matcher.
     */
    const scoped = resolveScopedSecrets({
      secrets: c.secrets,
      scopes: c.scopes,
      target: TARGET,
      mode: 'ENFORCE',
      requested: c.requested ?? null,
    });

    for (const name of Object.keys(scoped.values)) {
      const found = c.secrets.find((s) => s.name === name);
      expect(found).toBeDefined();
      const rows = c.scopes === 'UNAVAILABLE' ? [] : c.scopes;
      const admitting = rows.filter((r) => r.secretId === found?.id).filter((r) => {
        switch (r.kind) {
          case 'TEST':
            return r.value === TARGET.testId;
          case 'SUITE':
            return r.value === TARGET.suiteId;
          case 'TEST_TYPE':
            return r.value === TARGET.testType;
          case 'AUTH_PROFILE':
            return r.value === TARGET.authProfileId;
          case 'ENVIRONMENT_WIDE':
            return r.value === null;
          default:
            return false;
        }
      });
      expect(admitting.length).toBeGreaterThan(0);
    }
  });

  it('counts a name listed twice once', () => {
    // `considered` must be a property of the environment and the request, not
    // of how tidily the spec was written.
    const scoped = resolveScopedSecrets({
      secrets: [secret('a')],
      scopes: [],
      target: TARGET,
      mode: 'ENFORCE',
      requested: ['A', 'A', 'A'],
    });
    expect(scoped.considered).toBe(1);
    expect(scoped.withheld).toBe(1);
  });

  it('hands back a frozen set, so a caller cannot widen it after the fact', () => {
    const scoped = resolveScopedSecrets({
      secrets: [secret('a')],
      scopes: [],
      target: TARGET,
      mode: 'ENFORCE',
    });
    expect(Object.isFrozen(scoped)).toBe(true);
    expect(Object.isFrozen(scoped.values)).toBe(true);
    expect(() => {
      (scoped.values as Record<string, string>).SMUGGLED = FAKE_PLAINTEXT;
    }).toThrow();
  });

  it('carries a brand nothing outside the resolver can name', () => {
    /*
     * The compiler is the real enforcement — `ScopedSecrets` has a
     * module-private `unique symbol` key, so no object literal written anywhere
     * else is assignable to it, and the typecheck is the proof. This asserts the
     * run-time half: the brand is there, and it is a symbol rather than a string
     * key somebody could reproduce.
     */
    const scoped = resolveScopedSecrets({
      secrets: [],
      scopes: [],
      target: TARGET,
      mode: 'ENFORCE',
    });
    const brands = Object.getOwnPropertySymbols(scoped);
    expect(brands).toHaveLength(1);
    expect(brands[0]?.description).toBe('qaai.runner.scopedSecrets');
  });
});
