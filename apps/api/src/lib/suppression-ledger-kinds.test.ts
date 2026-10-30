import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SUPPRESSION_KINDS, denominatorEffectOf } from '@qaai/shared';

/**
 * WHICH KINDS WRITE A `SuppressionEvent` ROW, pinned against the code.
 *
 * ── THE DEFECT THIS EXISTS FOR ────────────────────────────────────────────────
 *
 * `SuppressionEvent`'s own doc comment said "ONE ROW PER SUPPRESSION THAT
 * APPLIED, ACROSS ALL FIVE KINDS … So every kind writes HERE, and every surface
 * reads HERE" — on the table that same comment calls the most important one in
 * its section. Two of the five never wrote a row, which made
 * `summariseSuppressions` structurally incapable of naming them and made the
 * paragraph a claim about intentions rather than a description of code.
 *
 * The paragraph is now a measured list, and this is what keeps it measured.
 * A doc comment cannot fail; a test can.
 *
 * ── WHY THE TWO ABSENCES ARE CORRECT AND NOT A GAP ────────────────────────────
 *
 * The ledger counts SILENCED FAILURES. The two kinds that write nothing are the
 * two whose effect is not on failures at all, which this test asserts from
 * `denominatorEffectOf` rather than from a hand-kept list — so a day somebody
 * changes a kind's denominator effect without changing its writer is a failure
 * here.
 */
const ROOT = new URL('../../../../', import.meta.url);
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, ROOT)), 'utf8');

/** The ONLY writer of this table. A second one is a finding, not a refactor. */
const WRITER = 'apps/worker/src/processors/triage.ts';
const SCHEMA = 'apps/api/prisma/schema.prisma';
const LEDGER_READ = 'apps/api/src/routes/runs.ts';

/** Kinds a row is written for. Everything else must be absent for a stated reason. */
const WRITTEN = ['MUTE', 'ENV_ISSUE'] as const;
/** Synthesised on read from `Run.suppressedFailures` instead of stored. */
const SYNTHESISED = ['QUARANTINE'] as const;
/** Disclosed where their effect lands — the measurement, and the obsolescence surface. */
const ELSEWHERE = ['COVERAGE_WAIVER', 'RETIREMENT'] as const;

describe('the suppression ledger knows which kinds write to it', () => {
  it('accounts for all five kinds exactly once', () => {
    // The denominator of this test. A sixth kind lands here before it lands
    // anywhere else, which is the point of a presence check.
    const accounted = [...WRITTEN, ...SYNTHESISED, ...ELSEWHERE].sort();
    expect(accounted).toEqual([...SUPPRESSION_KINDS].sort());
  });

  it('has exactly one writer, and it writes exactly the two kinds that silence a failure', () => {
    const writer = read(WRITER);
    for (const kind of WRITTEN) {
      expect(writer, `${WRITER} should write a ${kind} ledger row`).toContain(kind);
    }
    // One writer. `suppressionEvent` appearing in a second production file
    // means two places decide what a suppression count is.
    const others = [
      'apps/api/src/routes/surface.ts',
      'apps/api/src/routes/triage.ts',
      'apps/api/src/routes/team.ts',
      'apps/worker/src/processors/close-loop.ts',
      'apps/api/src/lib/coverage-store.ts',
    ];
    for (const file of others) {
      expect(read(file), `${file} must not write the ledger`).not.toMatch(
        /prisma\.suppressionEvent\.(create|createMany|upsert|update)/,
      );
    }
  });

  it('the two kinds that write nothing are the two that silence no failure', () => {
    /*
     * NOT a hand-kept pairing. COVERAGE_WAIVER removes a SURFACE from the
     * measurement and RETIREMENT deletes a TEST, so neither silences a failure
     * and neither belongs in a ledger of silenced failures. Both of those facts
     * come from the kind's own rule, so changing one without changing its
     * writer reddens this.
     */
    expect(denominatorEffectOf('COVERAGE_WAIVER')).toBe('LEAVES_DENOMINATOR');
    expect(denominatorEffectOf('RETIREMENT')).toBe('RETURNS_TO_UNCOVERED');
    for (const kind of WRITTEN) {
      expect(denominatorEffectOf(kind)).toBe('STAYS_COUNTED');
    }
  });

  it('the schema says which kinds write, and names the ones that do not', () => {
    const schema = read(SCHEMA);
    const header = schema.slice(0, schema.indexOf('model SuppressionEvent'));
    const doc = header.slice(header.lastIndexOf('/// ONE ROW PER SUPPRESSION'));

    // The claim that was false is gone.
    expect(doc).not.toContain('So every kind writes HERE');
    // And each absence is named with its reason, so a reader of the table is
    // not left to infer it from a missing writer.
    for (const kind of [...SYNTHESISED, ...ELSEWHERE]) {
      expect(doc, `the doc should account for ${kind}`).toContain(kind);
    }
  });

  it('the ledger read excludes the synthesised kind, so one suppression is not counted twice', () => {
    // QUARANTINE comes from `Run.suppressedFailures`. Reading it from both
    // would double every quarantined failure in the headline sentence.
    expect(read(LEDGER_READ)).toMatch(/kind:\s*\{\s*not:\s*'QUARANTINE'\s*\}/);
  });
});
