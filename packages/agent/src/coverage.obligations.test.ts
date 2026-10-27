/**
 * THE OBLIGATION MATRIX, NOW THAT IT READS THE TYPE DECLARATIONS.
 *
 * `coversSurfaceKinds` was declared on all thirty types and read by NOTHING
 * outside its own zod schema. The defect it closes is the nastiest shape a
 * coverage number can take: an obligation NO test type can ever satisfy. A
 * project that declares `ROUTE: ['DATABASE']` mints one per route, every one is
 * reported uncovered for ever, the percentage is permanently capped, and the
 * remedy — fix the policy — is the one thing the report never suggests.
 *
 * MODEL-FREE. No `LlmService` anywhere, because the path under test has none.
 */

import { describe, expect, it } from 'vitest';
import { SURFACE_KINDS, TEST_TYPE_DECLARATIONS } from '@qaai/shared';
import type { TypeObligationPolicy } from '@qaai/shared';
import {
  OBLIGATION_REFUSALS,
  OBLIGATION_REFUSALS_OUT_OF_DENOMINATOR,
  OBLIGATION_REFUSAL_LIST,
  auditObligationPolicy,
  typesCovering,
} from './coverage.js';

const policy = (byKind: TypeObligationPolicy['byKind']): TypeObligationPolicy => ({ byKind });

describe('the vocabulary', () => {
  it('derives its list from the presence record, so the two cannot drift', () => {
    expect(OBLIGATION_REFUSAL_LIST).toEqual([...OBLIGATION_REFUSALS]);
  });

  it('keeps NO_PRODUCER inside the denominator, which is the one that is tempting to get wrong', () => {
    // The type is right for the axis and this deployment can run it; what is
    // missing is a producer in QAAI. Shedding it would raise the CUSTOMER'S
    // number because of a shortfall in OUR product.
    expect(OBLIGATION_REFUSALS_OUT_OF_DENOMINATOR).not.toContain('NO_PRODUCER');
    expect([...OBLIGATION_REFUSALS_OUT_OF_DENOMINATOR].sort()).toEqual([
      'IMPOSSIBLE_FOR_AXIS',
      'NOT_A_DECLARED_TYPE',
      'UNRUNNABLE_HERE',
    ]);
  });
});

describe('a policy nobody wrote owes nothing', () => {
  it('produces no obligation at all from a null policy', () => {
    const audit = auditObligationPolicy({ policy: null });
    // DEFAULT_TYPE_OBLIGATIONS is empty on every axis on purpose: QAAI's
    // opinion about what a team should test is not the team's debt.
    expect(audit.verdicts).toHaveLength(0);
    expect(audit.counted).toBe(0);
    expect(audit.excluded).toHaveLength(0);
  });
});

describe('an obligation nothing can ever close', () => {
  it('refuses a type that does not cover the axis, and says what it does cover', () => {
    const audit = auditObligationPolicy({ policy: policy({ ROUTE: ['DATABASE'] }) });
    expect(audit.counted).toBe(0);
    expect(audit.impossible).toHaveLength(1);
    const verdict = audit.impossible[0];
    expect(verdict?.refusal).toBe('IMPOSSIBLE_FOR_AXIS');
    expect(verdict?.counts).toBe(false);
    expect(verdict?.why).toContain('could never be closed');
    expect(verdict?.why).toContain('correct the policy');
    // The remedy is only actionable if it names what DATABASE does cover.
    for (const kind of TEST_TYPE_DECLARATIONS.DATABASE.coversSurfaceKinds) {
      expect(verdict?.why).toContain(kind);
    }
  });

  it('refuses a policy entry that is not a declared type at all', () => {
    const audit = auditObligationPolicy({
      policy: policy({ ROUTE: ['NOT_A_TYPE' as never] }),
    });
    expect(audit.counted).toBe(0);
    expect(audit.excluded[0]?.refusal).toBe('NOT_A_DECLARED_TYPE');
    expect(audit.excluded[0]?.why).toContain('not a declared test type');
  });

  it('separates a mis-typed POLICY from an un-runnable DEPLOYMENT', () => {
    // Both leave the denominator and the remedies are opposite: edit the
    // policy versus install the tool. A single "excluded" flag would send the
    // reader to do the wrong one.
    const audit = auditObligationPolicy({
      policy: policy({ ROUTE: ['DATABASE', 'E2E'] }),
      capability: { E2E: 'MISSING' },
    });
    const byRefusal = new Map(audit.verdicts.map((verdict) => [verdict.type, verdict.refusal]));
    expect(byRefusal.get('DATABASE')).toBe('IMPOSSIBLE_FOR_AXIS');
    expect(byRefusal.get('E2E')).toBe('UNRUNNABLE_HERE');
    expect(audit.counted).toBe(0);
    expect(audit.impossible.map((verdict) => verdict.type)).toEqual(['DATABASE']);
  });
});

describe('what the deployment can run, and what nobody probed', () => {
  it('takes a MISSING type out of the denominator with its reason', () => {
    const audit = auditObligationPolicy({
      policy: policy({ ROUTE: ['E2E'] }),
      capability: { E2E: 'MISSING' },
    });
    expect(audit.counted).toBe(0);
    expect(audit.excluded[0]?.why).toContain('install the tool');
    expect(audit.excluded[0]?.why).toContain('not installed here');
  });

  it('keeps an UNPROBED type IN the denominator, so a skipped preflight cannot raise the number', () => {
    /*
     * THE SUBTLE HALF, and the same rule NON_EXECUTABLE_CAPABILITY_STATUSES
     * records: an absent capability key is NOT_CHECKED, never MISSING.
     * Dropping it would let a deployment that never ran a preflight shed every
     * obligation it could not prove it could run.
     */
    const unprobed = auditObligationPolicy({ policy: policy({ ROUTE: ['E2E'] }) });
    expect(unprobed.counted).toBe(1);
    expect(unprobed.excluded).toHaveLength(0);

    const explicit = auditObligationPolicy({
      policy: policy({ ROUTE: ['E2E'] }),
      capability: { E2E: 'NOT_CHECKED' },
    });
    expect(explicit.counted).toBe(1);
  });

  it('keeps a WRONG_VERSION type out, and says upgrade rather than install', () => {
    const audit = auditObligationPolicy({
      policy: policy({ ROUTE: ['E2E'] }),
      capability: { E2E: 'WRONG_VERSION' },
    });
    expect(audit.counted).toBe(0);
    expect(audit.excluded[0]?.why).toContain('outside the version range');
  });
});

describe('a gap that is OURS stays counted, and says so', () => {
  it('counts an obligation no producer can propose, and blames QAAI', () => {
    /*
     * DESKTOP and JOBS are the two types with `producers: ['NONE']` after this
     * round, so this is the real case rather than a fabricated one. The
     * obligation is genuinely uncovered and must stay in the denominator: the
     * missing work is a producer in QAAI, and hiding it would raise the
     * customer's percentage for our own shortfall.
     */
    const audit = auditObligationPolicy({
      policy: policy({ BACKGROUND_JOB: ['JOBS' as never] }),
      capability: { JOBS: 'AVAILABLE' },
    });
    expect(audit.counted).toBe(1);
    expect(audit.verdicts[0]?.refusal).toBe('NO_PRODUCER');
    expect(audit.verdicts[0]?.counts).toBe(true);
    expect(audit.verdicts[0]?.why).toContain('The gap is ours, not yours');
  });

  it('no longer blames QAAI for a type this round gave a producer', () => {
    // LOCALIZATION had `producers: ['NONE']` before the type funnel landed.
    const audit = auditObligationPolicy({
      policy: policy({ DEVICE_LOCALE: ['LOCALIZATION'] }),
      capability: { LOCALIZATION: 'AVAILABLE' },
    });
    expect(audit.counted).toBe(1);
    expect(audit.verdicts[0]?.refusal).toBeNull();
  });
});

describe('an ordinary obligation', () => {
  it('counts, with no refusal and a readable sentence', () => {
    const audit = auditObligationPolicy({
      policy: policy({ ROUTE: ['E2E', 'ACCESSIBILITY'] }),
      capability: { E2E: 'AVAILABLE', ACCESSIBILITY: 'AVAILABLE' },
    });
    expect(audit.counted).toBe(2);
    expect(audit.excluded).toHaveLength(0);
    for (const verdict of audit.verdicts) {
      expect(verdict.refusal).toBeNull();
      expect(verdict.why.length).toBeGreaterThan(20);
    }
  });

  it('gives every verdict a sentence, refused or not', () => {
    const audit = auditObligationPolicy({
      policy: policy({ ROUTE: ['E2E', 'DATABASE', 'NOT_A_TYPE' as never] }),
      capability: { E2E: 'MISSING' },
    });
    for (const verdict of audit.verdicts) expect(verdict.why).not.toBe('');
  });

  it('is byte-identical for one input and iterates a constant', () => {
    const input = {
      policy: policy({ ROUTE: ['E2E'], FORM: ['E2E'] }),
      capability: { E2E: 'AVAILABLE' as const },
    };
    expect(JSON.stringify(auditObligationPolicy(input))).toBe(
      JSON.stringify(auditObligationPolicy(input)),
    );
  });
});

describe('the editor read path, so an impossible policy is hard to type', () => {
  it('offers only the types that cover an axis', () => {
    expect(typesCovering('ROUTE')).toContain('E2E');
    expect(typesCovering('ROUTE')).not.toContain('DATABASE');
    expect(typesCovering('BACKGROUND_JOB')).toContain('JOBS');
  });

  it('cannot disagree with the audit, on any axis or any type', () => {
    for (const kind of SURFACE_KINDS) {
      for (const type of typesCovering(kind)) {
        const audit = auditObligationPolicy({
          policy: policy({ [kind]: [type as never] }),
          capability: { [type]: 'AVAILABLE' },
        });
        expect(audit.verdicts[0]?.refusal, `${kind}/${type}`).not.toBe('IMPOSSIBLE_FOR_AXIS');
      }
    }
  });

  it('names the axis no type covers at all, rather than hiding it', () => {
    // FLAG_COMBINATION: `surfaceKindsNoTypeCovers()` reports it, and an
    // obligation on it would be impossible for EVERY type. Asserted so the
    // audit and that read agree.
    expect(typesCovering('FLAG_COMBINATION')).toEqual([]);
    const audit = auditObligationPolicy({
      policy: policy({ FLAG_COMBINATION: ['E2E'] }),
      capability: { E2E: 'AVAILABLE' },
    });
    expect(audit.impossible).toHaveLength(1);
  });
});
