import { describe, expect, it } from 'vitest';
import {
  BOUNDARY_CLASSES,
  BOUNDARY_CLASS_LIST,
  BOUNDARY_CONSTRAINTS,
  BOUNDARY_CONSTRAINT_LIST,
  BOUNDARY_DESCRIPTORS,
  BOUNDARY_EXPECTATIONS,
  BOUNDARY_EXPECTATION_LIST,
  BOUNDARY_RISKS,
  BOUNDARY_RISK_RANK,
  boundaryApplicability,
  enumerateBoundaries,
  mayAssertRejection,
  needsPrecondition,
  readConstraint,
} from './boundaries';
import type { BoundaryClass, BoundaryField } from './boundaries';
import {
  boundaryCaseSchema,
  boundaryClassSchema,
  boundaryConstraintSchema,
  boundaryExpectationSchema,
  boundaryRiskSchema,
} from './schemas';

/** A text field with every constraint READ, so every text class is applicable. */
function textField(over: Partial<BoundaryField> = {}): BoundaryField {
  return {
    name: 'fullName',
    semantic: 'person_name',
    inputType: 'text',
    required: true,
    maxLength: 40,
    minLength: 2,
    min: null,
    max: null,
    step: null,
    pattern: null,
    ...over,
  };
}

/*
 * ── Parity ──────────────────────────────────────────────────────────────────
 *
 * The compile-time half is a `Record<Union, true>` in boundaries.ts, which is
 * why each `*_LIST` is derived rather than hand-written. These are the run-time
 * half: zod's `.options` exist only at run time. Both are needed — eight
 * `GateRule` kinds shipped unsaveable for two slices with only one in place.
 */
describe('boundary vocabulary parity', () => {
  it('derives every list from its presence record, in declaration order', () => {
    expect(BOUNDARY_CLASS_LIST).toEqual([...BOUNDARY_CLASSES]);
    expect(BOUNDARY_EXPECTATION_LIST).toEqual([...BOUNDARY_EXPECTATIONS]);
    expect(BOUNDARY_CONSTRAINT_LIST).toEqual([...BOUNDARY_CONSTRAINTS]);
  });

  it('gives every schema one option per member, and no others', () => {
    expect(boundaryClassSchema.options.slice().sort()).toEqual([...BOUNDARY_CLASSES].sort());
    expect(boundaryExpectationSchema.options.slice().sort()).toEqual(
      [...BOUNDARY_EXPECTATIONS].sort(),
    );
    expect(boundaryRiskSchema.options.slice().sort()).toEqual([...BOUNDARY_RISKS].sort());
    expect(boundaryConstraintSchema.options.slice().sort()).toEqual(
      [...BOUNDARY_CONSTRAINTS].sort(),
    );
  });

  it('enumerates all 27 classes the register named', () => {
    // A guard against silent shrinkage. The register listed these by name, and a
    // class quietly removed is a whole family of bugs nobody looks for again.
    expect(BOUNDARY_CLASSES).toHaveLength(27);
  });

  it('describes every class, so none can be generated with no expectation', () => {
    for (const klass of BOUNDARY_CLASSES) {
      const descriptor = BOUNDARY_DESCRIPTORS[klass];
      expect(BOUNDARY_CONSTRAINTS).toContain(descriptor.constraint);
      expect(BOUNDARY_EXPECTATIONS).toContain(descriptor.expected);
      expect(BOUNDARY_RISKS).toContain(descriptor.risk);
      // The sentence lands in a plan item's rationale, so it has to be a sentence.
      expect(descriptor.why.length).toBeGreaterThan(20);
    }
  });

  it('ranks every risk, so none sorts as undefined', () => {
    for (const risk of BOUNDARY_RISKS) {
      expect(typeof BOUNDARY_RISK_RANK[risk]).toBe('number');
    }
  });

  it('refuses a class the union does not have', () => {
    expect(boundaryClassSchema.safeParse('VIBES_INVALID').success).toBe(false);
  });
});

/*
 * ── The three-state reading ─────────────────────────────────────────────────
 *
 * The whole file turns on `undefined` and `null` meaning different things.
 */
describe('readConstraint', () => {
  it('reads undefined as NOT_CAPTURED — nobody looked', () => {
    expect(readConstraint(undefined)).toEqual({ state: 'NOT_CAPTURED' });
  });

  it('reads null as DECLARED_ABSENT — we looked and the page declares nothing', () => {
    expect(readConstraint(null)).toEqual({ state: 'DECLARED_ABSENT' });
  });

  it('reads a value as READ', () => {
    expect(readConstraint(40)).toEqual({ state: 'READ', value: 40 });
    expect(readConstraint('2026-01-01')).toEqual({ state: 'READ', value: '2026-01-01' });
  });

  it('reads an empty pattern as DECLARED_ABSENT, not as a pattern', () => {
    // `pattern=""` constrains nothing. Reading it as a declared pattern would
    // generate a PATTERN_VIOLATION case against a pattern every string matches.
    expect(readConstraint('')).toEqual({ state: 'DECLARED_ABSENT' });
    expect(readConstraint('   ')).toEqual({ state: 'DECLARED_ABSENT' });
  });

  it('reads zero as READ and not as absent', () => {
    // `maxlength="0"` and `min="0"` are real declarations. A falsy check here
    // would turn a field that accepts nothing into a field with no limit.
    expect(readConstraint(0)).toEqual({ state: 'READ', value: 0 });
  });
});

/*
 * ── THE RULE THAT MATTERS ───────────────────────────────────────────────────
 *
 * A class is APPLICABLE only when the constraint that defines it was READ.
 * "Type 300 characters and expect an error" against a field whose maxlength
 * nobody captured is a failing test that is QAAI's fault.
 */
describe('boundaryApplicability — the unread-constraint rule', () => {
  it('reports CONSTRAINT_UNREAD when the defining constraint was never captured', () => {
    const old = { name: 'bio', semantic: 'freeform', inputType: 'textarea', required: true } as const;
    const result = boundaryApplicability('TOO_LONG', old);
    expect(result.state).toBe('CONSTRAINT_UNREAD');
    if (result.state !== 'CONSTRAINT_UNREAD') return;
    expect(result.constraint).toBe('maxLength');
    // The remedy must be in the sentence — this is OUR gap, not the customer's.
    expect(result.reason).toContain('Re-crawl');
  });

  it('never yields an assertable expectation for an unread constraint', () => {
    // The structural half of the rule: there is no code path that returns
    // APPLICABLE/REJECTED for a constraint nobody read, because the arm that
    // carries an expectation is not constructed there.
    const old = { name: 'bio', semantic: 'freeform', inputType: 'textarea', required: true } as const;
    for (const klass of BOUNDARY_CLASSES) {
      const result = boundaryApplicability(klass, old);
      if (result.state === 'CONSTRAINT_UNREAD') {
        expect(mayAssertRejection(result)).toBe(false);
        expect(result).not.toHaveProperty('expected');
      }
    }
  });

  it('reports UNBOUNDED when the page declares no such constraint', () => {
    const result = boundaryApplicability('TOO_LONG', textField({ maxLength: null }));
    expect(result.state).toBe('UNBOUNDED');
    if (result.state !== 'UNBOUNDED') return;
    expect(result.expected).toBe('UNKNOWN');
    expect(result.reason).toContain('may not be asserted as a rejection');
  });

  it('keeps UNBOUNDED and CONSTRAINT_UNREAD distinct', () => {
    /*
     * The fourth state, and the reason it exists. An unbounded field is a GOOD
     * place to send ten thousand characters — that is where the bugs are — and
     * an unread constraint is a gap in our own crawl. Collapsing the two loses a
     * real test on one side and invents a false failure on the other.
     */
    const unbounded = boundaryApplicability('TOO_LONG', textField({ maxLength: null }));
    const unread = boundaryApplicability('TOO_LONG', textField({ maxLength: undefined }));
    expect(unbounded.state).not.toBe(unread.state);
    expect(mayAssertRejection(unbounded)).toBe(false);
    expect(mayAssertRejection(unread)).toBe(false);
  });

  it('reports APPLICABLE with the basis when the constraint was read', () => {
    const result = boundaryApplicability('TOO_LONG', textField({ maxLength: 40 }));
    expect(result.state).toBe('APPLICABLE');
    if (result.state !== 'APPLICABLE') return;
    expect(result.expected).toBe('REJECTED');
    // The basis is what lets a reviewer see the 41-character string is 41
    // characters BECAUSE the page said 40.
    expect(result.basis).toBe('40');
    expect(mayAssertRejection(result)).toBe(true);
  });
});

describe('boundaryApplicability — field families', () => {
  it('does not propose a presence case against an optional field', () => {
    const result = boundaryApplicability('EMPTY', textField({ required: false }));
    expect(result.state).toBe('INAPPLICABLE');
    if (result.state !== 'INAPPLICABLE') return;
    expect(result.reason).toContain('happy path');
  });

  it('does not propose a length case against a checkbox', () => {
    const box = { name: 'tos', semantic: 'unknown', inputType: 'checkbox', required: true } as const;
    expect(boundaryApplicability('TOO_LONG', box).state).toBe('INAPPLICABLE');
  });

  it('checks the family BEFORE the constraint reading', () => {
    /*
     * Order matters and this asserts it. A maxlength nobody captured on a
     * checkbox is not an ignorance worth reporting — the class could not have
     * applied anyway. Reporting it as CONSTRAINT_UNREAD would bury the real
     * unread constraints under noise about classes that were never candidates,
     * and print a useless "re-crawl" remedy beside each one.
     */
    const box = { name: 'tos', semantic: 'unknown', inputType: 'checkbox', required: true } as const;
    expect(boundaryApplicability('TOO_LONG', box).state).toBe('INAPPLICABLE');
  });

  it('only proposes a checksum case where a checksum exists', () => {
    expect(boundaryApplicability('CHECKSUM_INVALID', textField({ semantic: 'credit_card' })).state).toBe(
      'APPLICABLE',
    );
    expect(boundaryApplicability('CHECKSUM_INVALID', textField({ semantic: 'person_name' })).state).toBe(
      'INAPPLICABLE',
    );
  });

  it('honours step="any" as an explicit statement that no step applies', () => {
    const n = textField({ semantic: 'number', inputType: 'number', step: 'any' });
    expect(boundaryApplicability('STEP_MISALIGNED', n).state).toBe('INAPPLICABLE');
  });

  it('proposes LEADING_ZERO on a postal code, which is a TEXT field', () => {
    /*
     * Deliberately wider than "numeric". 02134 is the canonical case, and it is
     * a text input in every application that gets it right and a number input in
     * every application that gets it wrong — so restricting this class to
     * numeric fields would skip exactly the fields the bug lives in.
     */
    const zip = textField({ name: 'zip', semantic: 'postal_code', inputType: 'text' });
    expect(boundaryApplicability('LEADING_ZERO', zip).state).toBe('APPLICABLE');
  });

  it('only proposes a leap day where a calendar date is expressible', () => {
    expect(
      boundaryApplicability('LEAP_DAY', textField({ semantic: 'date', inputType: 'date' })).state,
    ).toBe('APPLICABLE');
    expect(
      boundaryApplicability('LEAP_DAY', textField({ semantic: 'date', inputType: 'time' })).state,
    ).toBe('INAPPLICABLE');
  });

  it('only proposes a DST boundary where a wall clock is expressible', () => {
    expect(
      boundaryApplicability('DST_BOUNDARY', textField({ semantic: 'date', inputType: 'time' })).state,
    ).toBe('APPLICABLE');
    expect(
      boundaryApplicability('DST_BOUNDARY', textField({ semantic: 'date', inputType: 'date' })).state,
    ).toBe('INAPPLICABLE');
  });

  it('does not propose a duplicate case where nothing suggests uniqueness', () => {
    expect(boundaryApplicability('DUPLICATE_OF_EXISTING', textField({ semantic: 'city' })).state).toBe(
      'INAPPLICABLE',
    );
    expect(boundaryApplicability('DUPLICATE_OF_EXISTING', textField({ semantic: 'email' })).state).toBe(
      'APPLICABLE',
    );
  });

  it('leaves no class unreachable', () => {
    /*
     * Exhaustiveness, which a hand-written list of cases cannot be. A class in
     * the vocabulary that no field shape can ever reach is a family of bugs the
     * product claims to look for and never does — and it would be invisible,
     * because nothing fails.
     */
    const shapes: BoundaryField[] = [
      textField(),
      textField({ semantic: 'email', inputType: 'email' }),
      textField({ semantic: 'credit_card' }),
      textField({ semantic: 'postal_code' }),
      textField({ semantic: 'number', inputType: 'number', min: '1', max: '10', step: '1' }),
      textField({ semantic: 'currency', inputType: 'number', min: '0', max: '999', step: '0.01' }),
      textField({ semantic: 'date', inputType: 'date', min: '2026-01-01', max: '2026-12-31' }),
      textField({ semantic: 'date', inputType: 'datetime-local', min: '2026-01-01T00:00', max: '2026-12-31T23:59', step: '60' }),
      textField({ semantic: 'freeform', pattern: '^[a-z]+$' }),
    ];
    const reachable = new Set<BoundaryClass>();
    for (const shape of shapes) {
      for (const klass of BOUNDARY_CLASSES) {
        const state = boundaryApplicability(klass, shape).state;
        if (state === 'APPLICABLE' || state === 'UNBOUNDED') reachable.add(klass);
      }
    }
    const unreachable = BOUNDARY_CLASSES.filter((k) => !reachable.has(k));
    expect(unreachable).toEqual([]);
  });
});

describe('expectations that are not rejections', () => {
  it("expects O'Brien to be ACCEPTED, not refused", () => {
    // An application that rejects an apostrophe in a surname has confused
    // escaping with validation. The test asserts ACCEPTANCE, which is a stronger
    // and more useful claim than that the input was refused.
    expect(BOUNDARY_DESCRIPTORS.SQL_META.expected).toBe('ACCEPTED_NORMALISED');
    const result = boundaryApplicability('SQL_META', textField());
    expect(mayAssertRejection(result)).toBe(false);
  });

  it('expects angle brackets to survive as TEXT', () => {
    expect(BOUNDARY_DESCRIPTORS.HTML_META.expected).toBe('ACCEPTED_NORMALISED');
  });

  it('expects the bound itself to be accepted, which is where off-by-one lives', () => {
    expect(BOUNDARY_DESCRIPTORS.AT_MIN.expected).toBe('ACCEPTED_NORMALISED');
    expect(BOUNDARY_DESCRIPTORS.AT_MAX.expected).toBe('ACCEPTED_NORMALISED');
    expect(BOUNDARY_DESCRIPTORS.BELOW_MIN.expected).toBe('REJECTED');
    expect(BOUNDARY_DESCRIPTORS.ABOVE_MAX.expected).toBe('REJECTED');
  });

  it('leaves genuinely ambiguous classes UNKNOWN rather than asserting a rejection', () => {
    // Accepting, normalising and refusing are all defensible for these, so a
    // suite that demands one reports two correct applications as broken.
    for (const klass of ['UNICODE_COMBINING', 'RTL_MARK', 'EMOJI_ASTRAL', 'FUTURE_DATE', 'PAST_DATE', 'DST_BOUNDARY'] as const) {
      expect(BOUNDARY_DESCRIPTORS[klass].expected).toBe('UNKNOWN');
    }
  });

  it('makes NULL_BYTE the one text class that expects rejection', () => {
    expect(BOUNDARY_DESCRIPTORS.NULL_BYTE.expected).toBe('REJECTED');
  });
});

describe('preconditions', () => {
  it('knows that a duplicate case needs a value already in the system', () => {
    // "Sign up with an existing email" run against an email nobody registered
    // tests the happy path and reports a negative-case pass.
    expect(needsPrecondition('DUPLICATE_OF_EXISTING')).toBe(true);
    expect(needsPrecondition('TOO_LONG')).toBe(false);
  });

  it('emits a precondition alongside the candidate', () => {
    const result = enumerateBoundaries([textField({ name: 'email', semantic: 'email', inputType: 'email' })]);
    expect(result.preconditions.map((p) => p.klass)).toContain('DUPLICATE_OF_EXISTING');
  });
});

/*
 * ── Enumeration ─────────────────────────────────────────────────────────────
 */
describe('enumerateBoundaries', () => {
  const form: BoundaryField[] = [
    textField({ name: 'email', semantic: 'email', inputType: 'email' }),
    textField({ name: 'password', semantic: 'password', inputType: 'password', maxLength: 72, minLength: 8 }),
    textField({ name: 'age', semantic: 'number', inputType: 'number', min: '18', max: '120', step: '1' }),
  ];

  it('turns one form into many cases, not one', () => {
    // The defect, measured: one whole feature became ONE negative item derived
    // from the FIRST required field.
    const result = enumerateBoundaries(form);
    expect(result.candidates.length).toBeGreaterThan(20);
  });

  it('accounts for every pair it considered', () => {
    /*
     * The honesty invariant. Every candidate was either returned, ruled out,
     * lost to an unread constraint, or capped — and the parts must sum to the
     * whole, or a shortfall exists that nothing explains.
     */
    const result = enumerateBoundaries(form);
    expect(result.considered).toBe(form.length * BOUNDARY_CLASSES.length);
    expect(
      result.candidates.length + result.inapplicable + result.unreadConstraints + result.omittedByCap,
    ).toBe(result.considered);
  });

  it('counts our own unread constraints separately from the customer’s field shapes', () => {
    // Collapsing these would hide a bug in QAAI inside a fact about the
    // customer's application.
    const old: BoundaryField[] = [{ name: 'bio', semantic: 'freeform', inputType: 'textarea', required: true }];
    const result = enumerateBoundaries(old);
    expect(result.unreadConstraints).toBeGreaterThan(0);
    expect(
      result.candidates.length + result.inapplicable + result.unreadConstraints,
    ).toBe(result.considered);
  });

  it('is byte-identical across calls — no clock, no randomness', () => {
    // Determinism is not optional: a generator that is not reproducible produces
    // a suite nobody can debug, and it is the commonest cause of the flake this
    // product exists to eliminate.
    const a = JSON.stringify(enumerateBoundaries(form));
    const b = JSON.stringify(enumerateBoundaries(form));
    expect(a).toBe(b);
  });

  it('pins the declared order, so any reordering is visible', () => {
    /*
     * The order a capped run depends on, written down. It is NOT what makes two
     * calls agree — `Array.prototype.sort` is stable by specification and the
     * comparator's tie-breaks reproduce the loops' insertion order, so removing
     * them changes nothing observable (a mutation that does so survives, and
     * the module comment says as much).
     *
     * What this test buys is that a change to the comparator OR to the nested
     * loops shows up as a diff here rather than as a silently different set of
     * cases inside a `limit`.
     */
    const result = enumerateBoundaries(form, { limit: 4 });
    expect(result.candidates.map((c) => `${c.field}:${c.klass}`)).toEqual([
      // CRITICAL first, and the two CRITICAL text classes come before every
      // HIGH one — which is the ranking working: an application that rejects an
      // apostrophe in a surname, or renders angle brackets as markup, matters
      // more than one missing a maxlength check.
      'email:SQL_META',
      'email:HTML_META',
      'password:SQL_META',
      'password:HTML_META',
    ]);
  });

  it('orders by risk, with a total tie-break', () => {
    const result = enumerateBoundaries(form);
    const ranks = result.candidates.map((c) =>
      c.applicability.state === 'APPLICABLE' || c.applicability.state === 'UNBOUNDED'
        ? BOUNDARY_RISK_RANK[c.applicability.risk]
        : 0,
    );
    expect(ranks).toEqual([...ranks].sort((x, y) => y - x));
  });

  it('returns the same prefix under a cap as it does uncapped', () => {
    // What makes the cap safe to apply: the sort is total, so capping takes a
    // PREFIX rather than an arbitrary 10.
    const full = enumerateBoundaries(form);
    const capped = enumerateBoundaries(form, { limit: 10 });
    expect(capped.candidates).toEqual(full.candidates.slice(0, 10));
  });

  it('DISCLOSES the cap as a count and a reason', () => {
    /*
     * "A cap applied without being disclosed" is on the short list of lies this
     * product cannot afford: a take of 10 over a form with 60 candidates must
     * say that at least 50 more existed, or the number below it measures our
     * budget and is presented as measuring the customer's application.
     */
    const capped = enumerateBoundaries(form, { limit: 10 });
    expect(capped.candidates).toHaveLength(10);
    expect(capped.omittedByCap).toBeGreaterThan(0);
    expect(capped.capReason).not.toBeNull();
    expect(capped.capReason).toContain(`at least ${capped.omittedByCap} more`);
  });

  it('never reports a shortfall with no reason beside it', () => {
    for (const limit of [1, 5, 10, 1000, undefined]) {
      const result = enumerateBoundaries(form, { limit });
      expect(result.omittedByCap > 0).toBe(result.capReason !== null);
    }
  });

  it('reports no cap when none bit', () => {
    const result = enumerateBoundaries(form, { limit: 10_000 });
    expect(result.omittedByCap).toBe(0);
    expect(result.capReason).toBeNull();
  });

  it('drops a precondition whose candidate was capped away', () => {
    // An obligation for a case that will not run is an obligation that would
    // create data for nothing.
    const result = enumerateBoundaries(form, { limit: 1 });
    const keptFields = new Set(result.candidates.map((c) => c.field));
    for (const p of result.preconditions) expect(keptFields.has(p.establishedBy)).toBe(true);
  });

  it('handles an empty form without inventing anything', () => {
    const result = enumerateBoundaries([]);
    expect(result).toEqual({
      candidates: [],
      preconditions: [],
      considered: 0,
      inapplicable: 0,
      unreadConstraints: 0,
      omittedByCap: 0,
      capReason: null,
    });
  });
});

/*
 * ── The write path ──────────────────────────────────────────────────────────
 */
describe('boundaryCaseSchema', () => {
  const good = {
    field: 'email',
    klass: 'TOO_LONG' as const,
    applicability: 'APPLICABLE' as const,
    expected: 'REJECTED' as const,
    risk: 'HIGH' as const,
    basis: '40',
    assertsRejection: true,
  };

  it('accepts a case derived from a constraint that was read', () => {
    expect(boundaryCaseSchema.safeParse(good).success).toBe(true);
  });

  it('REFUSES a case resting on a constraint nobody read', () => {
    const result = boundaryCaseSchema.safeParse({
      ...good,
      applicability: 'CONSTRAINT_UNREAD',
      assertsRejection: false,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('unreadConstraints');
  });

  it('refuses a case for a class that cannot apply to the field', () => {
    expect(
      boundaryCaseSchema.safeParse({ ...good, applicability: 'INAPPLICABLE', assertsRejection: false })
        .success,
    ).toBe(false);
  });

  it('REFUSES an unwarranted rejection assertion on an unbounded field', () => {
    // The dangerous one. The probe is worth running; the assertion is not
    // warranted, because no limit was ever claimed to be enforced.
    const result = boundaryCaseSchema.safeParse({
      ...good,
      applicability: 'UNBOUNDED',
      expected: 'UNKNOWN',
      assertsRejection: true,
    });
    expect(result.success).toBe(false);
  });

  it('accepts an unbounded probe that asserts only a handled outcome', () => {
    const result = boundaryCaseSchema.safeParse({
      ...good,
      applicability: 'UNBOUNDED',
      expected: 'UNKNOWN',
      assertsRejection: false,
    });
    expect(result.success).toBe(true);
  });

  it('refuses a rejection assertion for a class that expects acceptance', () => {
    const result = boundaryCaseSchema.safeParse({
      ...good,
      klass: 'SQL_META',
      expected: 'ACCEPTED_NORMALISED',
      assertsRejection: true,
    });
    expect(result.success).toBe(false);
  });

  it('refuses an APPLICABLE case with no basis', () => {
    expect(boundaryCaseSchema.safeParse({ ...good, basis: null }).success).toBe(false);
  });

  it('refuses a duplicate case that does not name the established value', () => {
    const result = boundaryCaseSchema.safeParse({
      ...good,
      klass: 'DUPLICATE_OF_EXISTING',
      expected: 'UNKNOWN',
      assertsRejection: false,
      basis: null,
    });
    expect(result.success).toBe(false);
  });

  it('refuses an extra property rather than dropping it', () => {
    expect(boundaryCaseSchema.safeParse({ ...good, payload: 'x' }).success).toBe(false);
  });
});
