/*
 * The CONTRACT half of synthetic.ts: uniqueness scope and cleanup obligation.
 *
 * In its own file rather than appended to `synthetic.test.ts`, matching the
 * repo's existing split (`codebase.guards.test.ts`,
 * `coverage-dimensions.verifier.test.ts`, `locators.identity.test.ts`): that
 * file covers the GENERATION — determinism, constraint fitting, pattern
 * satisfaction — and this one covers the two facts the generation already knew
 * and never told its caller.
 */
import { describe, expect, it } from 'vitest';
import { FORM_FIELD_SEMANTICS } from './flow-map';
import {
  CLEANUP_OBLIGATIONS,
  CLEANUP_OBLIGATION_LIST,
  UNIQUENESS_SCOPES,
  UNIQUENESS_SCOPE_LIST,
  cleanupFor,
  createSyntheticFactory,
  syntheticValue,
  uniquenessAtLeast,
  uniquenessFor,
  withCleanup,
} from './synthetic';
import type { SyntheticField } from './synthetic';
import { TEST_VALUES } from './test-values';
import {
  cleanupObligationSchema,
  syntheticValueSchema,
  testValueEntrySchema,
  uniquenessScopeSchema,
} from './schemas';

function field(over: Partial<SyntheticField> & { name: string; semantic: SyntheticField['semantic'] }): SyntheticField {
  return { ...over };
}

describe('uniqueness and cleanup vocabulary parity', () => {
  it('derives both lists from their presence records, in declaration order', () => {
    expect(UNIQUENESS_SCOPE_LIST).toEqual([...UNIQUENESS_SCOPES]);
    expect(CLEANUP_OBLIGATION_LIST).toEqual([...CLEANUP_OBLIGATIONS]);
  });

  it('gives each schema one option per member, and no others', () => {
    expect(uniquenessScopeSchema.options.slice().sort()).toEqual([...UNIQUENESS_SCOPES].sort());
    expect(cleanupObligationSchema.options.slice().sort()).toEqual([...CLEANUP_OBLIGATIONS].sort());
  });

  it('refuses a scope the union does not have', () => {
    expect(uniquenessScopeSchema.safeParse('SORT_OF_UNIQUE').success).toBe(false);
  });
});

describe('the semantic lookups are total', () => {
  it('answers for every semantic flow-map.ts declares', () => {
    /*
     * The failure a partial lookup produces is a new semantic defaulting to
     * REUSABLE — and REUSABLE is the answer that collides. A `Record` keyed on
     * `FormFieldSemantic` makes the compiler refuse an omission; this is the
     * run-time half, against the list the crawler actually uses.
     */
    for (const semantic of FORM_FIELD_SEMANTICS) {
      expect(UNIQUENESS_SCOPES).toContain(uniquenessFor(semantic));
      expect(CLEANUP_OBLIGATIONS).toContain(cleanupFor(semantic));
    }
  });

  it('makes the identity-shaped semantics globally unique', () => {
    // A collision ACROSS runs is the commonest cross-run flake there is: run 2
    // cannot sign up as run 1's user.
    expect(uniquenessFor('email')).toBe('GLOBALLY_UNIQUE');
    expect(uniquenessFor('username')).toBe('GLOBALLY_UNIQUE');
  });

  it('keeps a provider test card REUSABLE', () => {
    /*
     * Looks wrong, is the only correct answer: the value is a PROVIDER'S
     * PUBLISHED TEST NUMBER, every caller must use the same one, and generating
     * a "unique" card number means generating one the provider will not honour.
     */
    expect(uniquenessFor('credit_card')).toBe('REUSABLE');
    expect(uniquenessFor('card_cvc')).toBe('REUSABLE');
  });

  it('does not promise global uniqueness over a finite pool', () => {
    // The supply of valid reserved test numbers is small and genuinely
    // exhaustible, so a global promise is one this module breaks on the
    // two-hundredth run.
    expect(uniquenessFor('phone')).toBe('UNIQUE_PER_RUN');
  });

  it('leaves cleanup UNKNOWN wherever a submission might create a row', () => {
    // This module sees a FIELD and never a submission. UNKNOWN is honest and
    // actionable; NONE would be a quiet false claim that fills a database.
    expect(cleanupFor('email')).toBe('UNKNOWN');
    expect(cleanupFor('username')).toBe('UNKNOWN');
    expect(cleanupFor('city')).toBe('NONE');
    expect(cleanupFor('password')).toBe('NONE');
  });
});

describe('uniquenessAtLeast', () => {
  it('lets a stricter scope satisfy a looser requirement', () => {
    expect(uniquenessAtLeast('GLOBALLY_UNIQUE', 'UNIQUE_PER_RUN')).toBe(true);
    expect(uniquenessAtLeast('UNIQUE_PER_RUN', 'UNIQUE_PER_RUN')).toBe(true);
    expect(uniquenessAtLeast('UNIQUE_PER_TEST', 'UNIQUE_PER_RUN')).toBe(false);
    expect(uniquenessAtLeast('REUSABLE', 'UNIQUE_PER_TEST')).toBe(false);
  });

  it('ranks every scope, so none compares as undefined', () => {
    for (const scope of UNIQUENESS_SCOPES) {
      expect(uniquenessAtLeast(scope, 'REUSABLE')).toBe(true);
    }
  });
});

describe('every generated value carries both facts', () => {
  it('reports them on a plain generated value', () => {
    const v = syntheticValue(field({ name: 'email', semantic: 'email' }), { seed: 'run-1' });
    expect(v.uniqueness).toBe('GLOBALLY_UNIQUE');
    expect(v.cleanup).toBe('UNKNOWN');
  });

  it('reports them on a value chosen from a control’s own options', () => {
    /*
     * The option arm is a separate return path and had to be covered: a value
     * that reaches a caller with no scope is a value the caller must guess
     * about.
     *
     * THE SEMANTIC HERE IS LOAD-BEARING. An earlier version of this test used
     * `country` and asserted only that the scope was a MEMBER of the
     * vocabulary — and `uniquenessFor('country')` is REUSABLE, so a hard-coded
     * `uniqueness: 'REUSABLE'` on this arm was indistinguishable from a derived
     * one and a mutation survived. An `email` select pins the DERIVED value,
     * because GLOBALLY_UNIQUE is not what a careless hard-code would pick.
     */
    const v = syntheticValue(
      field({ name: 'identity', semantic: 'email', options: ['a@example.com', 'b@example.com'] }),
      { seed: 'run-1' },
    );
    expect(v.uniqueness).toBe(uniquenessFor('email'));
    expect(v.uniqueness).toBe('GLOBALLY_UNIQUE');
    expect(v.cleanup).toBe(cleanupFor('email'));
  });

  it('reports the DERIVED scope on the placeholder-only arm too', () => {
    // The third return path. Same reasoning as above: assert the derived value,
    // not merely a member of the vocabulary.
    const v = syntheticValue(
      field({ name: 'identity', semantic: 'email', options: ['Select…'] }),
      { seed: 'run-1' },
    );
    expect(v.unsatisfiable).toContain('options');
    expect(v.uniqueness).toBe('GLOBALLY_UNIQUE');
  });

  it('reports them for every semantic, through the public factory', () => {
    const factory = createSyntheticFactory({ seed: 'run-1', scope: 'test-1' });
    for (const semantic of FORM_FIELD_SEMANTICS) {
      const v = factory.describe(field({ name: `f_${semantic}`, semantic }));
      expect(v.uniqueness).toBe(uniquenessFor(semantic));
      expect(v.cleanup).toBe(cleanupFor(semantic));
    }
  });

  it('reports them on every field of a whole-form fill', () => {
    const fill = createSyntheticFactory({ seed: 'run-1' }).fillForm([
      field({ name: 'email', semantic: 'email' }),
      field({ name: 'name', semantic: 'person_name' }),
      field({ name: 'card', semantic: 'credit_card' }),
    ]);
    for (const f of fill.fields) {
      expect(UNIQUENESS_SCOPES).toContain(f.uniqueness);
      expect(CLEANUP_OBLIGATIONS).toContain(f.cleanup);
    }
  });

  it('stays deterministic — the two facts do not depend on a clock or a counter', () => {
    const a = syntheticValue(field({ name: 'email', semantic: 'email' }), { seed: 's' });
    const b = syntheticValue(field({ name: 'email', semantic: 'email' }), { seed: 's' });
    expect(a).toEqual(b);
  });
});

describe('withCleanup', () => {
  it('lets a scenario that knows resolve an UNKNOWN', () => {
    const v = syntheticValue(field({ name: 'email', semantic: 'email' }), { seed: 'run-1' });
    const resolved = withCleanup(v, 'DELETE_ENTITY');
    expect(resolved.cleanup).toBe('DELETE_ENTITY');
    // Nothing here mutates: the original is untouched, so a value handed to two
    // scenarios cannot have its obligation rewritten by one of them.
    expect(v.cleanup).toBe('UNKNOWN');
  });

  it('changes nothing else about the value', () => {
    const v = syntheticValue(field({ name: 'email', semantic: 'email' }), { seed: 'run-1' });
    expect(withCleanup(v, 'DELETE_ENTITY')).toEqual({ ...v, cleanup: 'DELETE_ENTITY' });
  });
});

/*
 * ── The write path ──────────────────────────────────────────────────────────
 */
describe('syntheticValueSchema', () => {
  const good = {
    field: 'email',
    semantic: 'email',
    value: 'qa-ab12cd@example.com',
    honoured: ['maxLength'],
    unsatisfiable: [],
    note: null,
    uniqueness: 'GLOBALLY_UNIQUE' as const,
    cleanup: 'DELETE_ENTITY' as const,
  };

  it('accepts a value that declares both facts', () => {
    expect(syntheticValueSchema.safeParse(good).success).toBe(true);
  });

  it('REFUSES a value with no uniqueness scope', () => {
    /*
     * Required with NO DEFAULT, and the absence of a default is the point. A
     * default of REUSABLE would make every value that forgot to declare a scope
     * collide on the unique index it needed, and the failure would read as an
     * application bug; a default of GLOBALLY_UNIQUE would claim a guarantee the
     * generation did not make. There is no safe default.
     */
    const { uniqueness: _dropped, ...without } = good;
    expect(syntheticValueSchema.safeParse(without).success).toBe(false);
  });

  it('refuses a value with no cleanup obligation', () => {
    const { cleanup: _dropped, ...without } = good;
    expect(syntheticValueSchema.safeParse(without).success).toBe(false);
  });

  it('refuses a globally unique value that obliges no cleanup', () => {
    // It would exhaust its own namespace: every run consumes an identifier that
    // nothing ever releases.
    const result = syntheticValueSchema.safeParse({ ...good, cleanup: 'NONE' });
    expect(result.success).toBe(false);
  });

  it('accepts a reusable value that obliges no cleanup', () => {
    expect(
      syntheticValueSchema.safeParse({
        ...good,
        semantic: 'city',
        uniqueness: 'REUSABLE',
        cleanup: 'NONE',
      }).success,
    ).toBe(true);
  });

  it('refuses an extra property rather than dropping it', () => {
    expect(syntheticValueSchema.safeParse({ ...good, password: 'hunter2' }).success).toBe(false);
  });

  it('accepts every value the generator actually produces', () => {
    /*
     * The guard that matters most: the contract and the generator must agree, or
     * the write path refuses output the product itself produced. Asserted over
     * every semantic rather than a sample, because a sample would pass for the
     * semantics someone remembered.
     */
    const factory = createSyntheticFactory({ seed: 'run-1', scope: 'test-1' });
    for (const semantic of FORM_FIELD_SEMANTICS) {
      const v = factory.describe(field({ name: `f_${semantic}`, semantic }));
      // GLOBALLY_UNIQUE values arrive UNKNOWN from the generator, which the
      // refinement permits; it only refuses an explicit NONE.
      const result = syntheticValueSchema.safeParse(v);
      expect(result.success, `${semantic}: ${JSON.stringify(result.error?.issues ?? [])}`).toBe(true);
    }
  });
});

/*
 * ── The provider test-value catalogue ───────────────────────────────────────
 *
 * The catalogue itself already existed with provenance on every entry. What did
 * not exist was a WRITE PATH, so nothing refused an entry that lacked it.
 */
describe('testValueEntrySchema', () => {
  const good = {
    id: 'stripe-visa-success',
    provider: 'stripe' as const,
    kind: 'card' as const,
    value: '4242424242424242',
    purpose: 'a card that succeeds',
    expected: 'the charge succeeds and the order is created',
    testModeOnly: true,
    verified: true,
    evidence: 'computed-here' as const,
    sourceNote: 'Luhn-checked by a colocated test; corroborated in apps/demo.',
  };

  it('accepts an entry that says where it came from', () => {
    expect(testValueEntrySchema.safeParse(good).success).toBe(true);
  });

  it('REFUSES an entry with no provenance', () => {
    // A wrong test card number is a SILENT payment-test failure: the charge is
    // declined for the wrong reason, the test asserts a decline, and it passes
    // while proving nothing.
    const { sourceNote: _dropped, ...without } = good;
    expect(testValueEntrySchema.safeParse(without).success).toBe(false);
    expect(testValueEntrySchema.safeParse({ ...good, sourceNote: '   ' }).success).toBe(false);
  });

  it('refuses an entry with no evidence kind', () => {
    const { evidence: _dropped, ...without } = good;
    expect(testValueEntrySchema.safeParse(without).success).toBe(false);
  });

  it('refuses a recalled value that claims to be verified', () => {
    // Recall is the weakest evidence here, and claiming otherwise is the one
    // dishonesty this catalogue exists to prevent.
    const result = testValueEntrySchema.safeParse({
      ...good,
      evidence: 'published-recalled',
      verified: true,
    });
    expect(result.success).toBe(false);
  });

  it('IS INCAPABLE OF HOLDING A SECRET', () => {
    /*
     * The structural half of the guarantee, and the reason it is `.strict()`
     * rather than permissive: there is no property for a credential, and an
     * entry that sends one is REFUSED rather than having it silently dropped. A
     * dropped secret is a secret the sender still believes was stored, and it
     * reached our logs on the way to being dropped.
     */
    for (const leak of ['secret', 'apiKey', 'password', 'token', 'storageState', 'totpSecret']) {
      /*
       * Composed rather than written out: the schema refuses the KEY, not the
       * value, so a key-shaped literal in a committed test file would buy
       * nothing and cost a secret-scanner hit on every push.
       */
      const keyShaped = ['sk', 'live', 'EXAMPLE-NOT-A-REAL-CREDENTIAL'].join('_');
      const result = testValueEntrySchema.safeParse({ ...good, [leak]: keyShaped });
      expect(result.success, `${leak} was accepted`).toBe(false);
    }
  });

  it('accepts every entry already in the catalogue', () => {
    // The write path and the data must agree, or the schema refuses the
    // product's own shipped catalogue.
    for (const entry of TEST_VALUES) {
      const result = testValueEntrySchema.safeParse(entry);
      expect(result.success, `${entry.id}: ${JSON.stringify(result.error?.issues ?? [])}`).toBe(true);
    }
  });
});
