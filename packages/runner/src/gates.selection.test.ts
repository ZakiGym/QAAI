import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MIN_PASS_RATE_SELECTION_ABSENT_DETAIL, evaluateGates } from './gates.js';

/**
 * The ratchet behind `GateInput.selection`'s absent branch.
 *
 * ── WHY A TEST THAT READS SOURCE FILES ────────────────────────────────────────
 *
 * `selection` is OPTIONAL, and absent keeps today's answer rather than
 * withholding — a blast-radius decision recorded in its doc comment. That is
 * only safe while every production caller actually passes it, and the previous
 * version of that comment got exactly this wrong in the other direction: it
 * claimed no caller passed it when three did. A doc comment is not an
 * invariant. This is.
 *
 * It reads the three call sites as TEXT rather than importing them, for the
 * reason check-enums.test.ts records about scripts: importing an Express route
 * or a BullMQ processor from a unit test drags a database client and a Redis
 * connection in with it. The question here is a syntactic one — does the object
 * literal handed to `evaluateGates` name this field — and text answers it.
 *
 * A FOURTH CALL SITE IS A FAILURE HERE, NOT A SILENT PASS. If somebody adds one,
 * this test fails with the file that was added rather than with a run that
 * published an unqualified percentage over a sliver of a suite.
 */
const ROOT = new URL('../../../', import.meta.url);

/** Every production file that scores a gate. Not the tests, which are the point of the option. */
const CALL_SITES = [
  'apps/api/src/lib/runners.ts',
  'apps/worker/src/processors/checks.ts',
  'apps/worker/src/processors/run.ts',
] as const;

function sourceOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, ROOT)), 'utf8');
}

/** A passing result, with only the fields the pass-rate rule reads. */
function passing(testId: string) {
  return {
    testId,
    testName: testId,
    status: 'PASSED' as const,
    priority: 'CRITICAL_PATH' as const,
    quarantined: false,
    retriedAndPassed: false,
    notRun: null,
    verdict: null,
    durationMs: 10,
  };
}

describe('evaluateGates passes the run selection from every production call site', () => {
  it('finds exactly the call sites this test knows about', () => {
    /*
     * The denominator. If a fourth file starts calling `evaluateGates`, the
     * list above is stale and the one below catches it — reported as the file
     * that appeared, so the fix is obvious.
     */
    const found = CALL_SITES.filter((file) => sourceOf(file).includes('evaluateGates('));
    expect([...found]).toEqual([...CALL_SITES]);
  });

  it('every one of them names `selection` on the input it builds', () => {
    for (const file of CALL_SITES) {
      const source = sourceOf(file);
      expect(source, `${file} builds a GateInput without selection`).toMatch(
        /selection:\s*\{\s*source:/,
      );
    }
  });

  it('withholds a suite-wide claim on a selective run, which is why the field exists', () => {
    const rate = (selection?: { source: string | null }) => {
      const gate = evaluateGates([{ kind: 'MIN_PASS_RATE', ratePercent: 90, action: 'BLOCK' }], {
        results: [passing('t1'), passing('t2')],
        ...(selection ? { selection } : {}),
      });
      return gate.evaluations.find((e) => e.rule.kind === 'MIN_PASS_RATE')!;
    };

    expect(rate({ source: 'FULL_SUITE' }).action).toBe('PASS');
    // 100% of two tests, selected by impact. Measured, and NOT a suite claim.
    expect(rate({ source: 'IMPACT' }).action).toBe('UNMEASURED');
    // NULL IS NOT FULL_SUITE. A run that recorded no selection source is
    // UNKNOWN, and a value this build has never heard of is treated the same —
    // the one thing that must never happen is an unnameable value reading as
    // suite-wide.
    expect(rate({ source: null }).action).toBe('UNMEASURED');
    expect(rate({ source: 'WHAT_IS_THIS' }).action).toBe('UNMEASURED');
    // And the unrecognised one must not echo the stored value back: a detail
    // assembled out of a hand-editable TEXT column is how a row prints itself
    // to a customer.
    expect(rate({ source: 'WHAT_IS_THIS' }).detail).not.toContain('WHAT_IS_THIS');
  });

  it('keeps today’s answer when the field is absent, and says so in the detail', () => {
    // The documented decision, pinned so it cannot drift silently in either
    // direction: absent PASSES, and the detail discloses that nothing read the
    // run's selection so the pass is not a verified suite-wide one.
    const gate = evaluateGates([{ kind: 'MIN_PASS_RATE', ratePercent: 90, action: 'BLOCK' }], {
      results: [passing('t1'), passing('t2')],
    });
    const rate = gate.evaluations.find((e) => e.rule.kind === 'MIN_PASS_RATE')!;
    expect(rate.action).toBe('PASS');
    expect(rate.detail).toContain(MIN_PASS_RATE_SELECTION_ABSENT_DETAIL);
  });
});
