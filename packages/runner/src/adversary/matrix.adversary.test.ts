/**
 * ADVERSARIAL COUNTER-TESTS, written against the plugin rather than with it.
 *
 * Each one is an attempt to MAKE the plugin report a pass it did not earn,
 * built from a fixture the colocated suite does not hold. Where a sweep over a
 * whole exported union was possible it is done that way rather than over the
 * members somebody remembered to list: that is what makes a new member
 * un-passable by default instead of un-passable by review.
 */
import { describe, expect, it } from 'vitest';
import {
  MATRIX_CELL_STATUSES,
  NEVER_CAPTURABLE_UNREACHED_REASONS,
  STATE_UNREACHED_REASON_LIST,
  INTERACTION_STATES,
  resolveMatrixCell,
  visualCaptureSchema,
  type MatrixCell,
} from '@qaai/shared';
import {
  planMatrix,
  rollUpVerdict,
  recordCapture,
  mayWriteBaseline,
  runVisualMatrix,
  floorCellFor,
  planVisualCaptures,
  NOT_RUN_KIND_FOR_CELL,
  CELL_STATUS_SEVERITY,
} from '../matrix.js';

const CHROMIUM: MatrixCell = { engine: 'chromium' };
const WEBKIT: MatrixCell = { engine: 'webkit' };
const FIREFOX: MatrixCell = { engine: 'firefox' };

describe('ADVERSARY — THE MATRIX: a cell that could not run is not a product defect', () => {
  it('a missing WebKit binary is a typed NOT_RUN refusal, never a FAILED cell', () => {
    const plan = planMatrix({
      cells: [CHROMIUM, WEBKIT, FIREFOX],
      seed: 'adversary',
      maxCells: 10,
      // Only chromium is on disk, and the other two were PROBED and absent.
      deployment: { engines: { chromium: true, firefox: false, webkit: false } } as never,
    });
    expect(plan.problems).toEqual([]);
    expect(plan.runnable.map((r) => r.cell.engine)).toEqual(['chromium']);
    expect(plan.refused.map((r) => r.cell.engine).sort()).toEqual(['firefox', 'webkit']);
    for (const r of plan.refused) {
      expect(r.notRun.kind, `${r.cell.engine}`).toBe('BLOCKED_BY_ENV');
      expect(r.notRun.why.length).toBeGreaterThan(20);
    }
    // And the denominator takes them OUT rather than counting them as untested.
    expect(plan.denominator.refused).toBe(2);
    expect(plan.denominator.scored).toBe(1);
  });

  it('a refused cell does NOT drag the parent verdict down through worst-wins', () => {
    const verdict = rollUpVerdict([
      { status: 'PASSED', notRun: null } as never,
      { status: 'PASSED', notRun: null } as never,
      // The WebKit cell that never ran. SKIPPED ranks BELOW passed, so if it
      // entered the reduction the test would read SKIPPED, and if a reader
      // "fixed" that by ranking skipped above passed it would read FAILED.
      { status: 'SKIPPED', notRun: { kind: 'BLOCKED_BY_ENV', why: 'no webkit here' } } as never,
    ]);
    expect(verdict.status).toBe('PASSED');
    expect(verdict.scored).toBe(2);
    expect(verdict.notRun).toBe(1);
    expect(verdict.parentNotRun).toBeNull();
    expect(verdict.rule).toMatch(/excluded/);
  });

  it('a real failure in ONE cell still fails the parent, with the refused one excluded', () => {
    const verdict = rollUpVerdict([
      { status: 'PASSED', notRun: null } as never,
      { status: 'FAILED', notRun: null } as never,
      { status: 'SKIPPED', notRun: { kind: 'UNSUPPORTED', why: 'no safari build' } } as never,
    ]);
    expect(verdict.status).toBe('FAILED');
    expect(verdict.scored).toBe(2);
  });

  it('EVERY cell refused is a parent NOT_RUN — never PASSED and never FAILED', () => {
    const verdict = rollUpVerdict([
      { status: 'SKIPPED', notRun: { kind: 'NOT_RUN', why: 'nobody probed' } } as never,
      { status: 'SKIPPED', notRun: { kind: 'UNSUPPORTED', why: 'no safari build exists' } } as never,
    ]);
    expect(verdict.status).toBe('SKIPPED');
    expect(verdict.status).not.toBe('PASSED');
    expect(verdict.status).not.toBe('FAILED');
    // The STRONGEST reason, so "no install fixes this" is not hidden by "nobody probed".
    expect(verdict.parentNotRun?.kind).toBe('UNSUPPORTED');
  });

  it('an EMPTY capability resolves NOT_CHECKED and never AVAILABLE', () => {
    for (const cell of [CHROMIUM, WEBKIT, FIREFOX]) {
      const r = resolveMatrixCell(cell, {});
      expect(r.status, `${cell.engine}`).toBe('NOT_CHECKED');
      expect(r.status).not.toBe('AVAILABLE');
    }
  });

  it('SKIPPED ranks BELOW PASSED, which is what makes the exclusion necessary', () => {
    expect(CELL_STATUS_SEVERITY.SKIPPED).toBeLessThan(CELL_STATUS_SEVERITY.PASSED);
    expect(CELL_STATUS_SEVERITY.TIMED_OUT).toBeGreaterThan(CELL_STATUS_SEVERITY.FAILED);
  });

  it('every refusing cell status maps to a NOT_RUN kind, and the two runnable ones to null', () => {
    for (const status of MATRIX_CELL_STATUSES) {
      const kind = NOT_RUN_KIND_FOR_CELL[status];
      if (status === 'AVAILABLE' || status === 'NOT_CHECKED') expect(kind, status).toBeNull();
      else expect(kind, status).not.toBeNull();
    }
  });
});

describe('ADVERSARY — THE VISUAL BASELINE: an unreached state writes NOTHING', () => {
  it('drops the image for EVERY unreached reason, and says it dropped it', () => {
    for (const reason of STATE_UNREACHED_REASON_LIST) {
      const plan = planVisualCaptures([floorCellFor({ width: 1280, height: 800 })], ['ERROR'])[0]!;
      const record = recordCapture({
        plan,
        outcome: { reached: false, reason, detail: 'nothing triggered validation' },
        // The adversarial part: a capture WAS taken and is being offered.
        imageKey: 'visual/t1-ERROR-actual.png',
        environmentId: 'env-1',
      });
      expect(record.imageKey, reason).toBeNull();
      expect(mayWriteBaseline(record), reason).toBe(false);
      expect(record.unreachedReason, reason).toBe(reason);
      // Rule 12: a failure suppressed without being counted.
      expect(record.imageDiscarded, reason).toBe(true);
      expect(record.discardReason, reason).toMatch(/falsely green/);
    }
  });

  it('the two unreached-reason lists are IDENTICAL, so no reason can keep an image', () => {
    /*
     * The latent hole: `recordCapture` keeps the image when the reason is not in
     * NEVER_CAPTURABLE_UNREACHED_REASONS. Today the two lists are the same seven
     * members, so that branch is unreachable — and this assertion is what keeps
     * it unreachable when an eighth reason lands.
     */
    expect([...NEVER_CAPTURABLE_UNREACHED_REASONS].sort()).toEqual(
      [...STATE_UNREACHED_REASON_LIST].sort(),
    );
  });

  it('a reached state whose capture FAILED also writes no baseline', () => {
    const plan = planVisualCaptures([floorCellFor({ width: 1280, height: 800 })], ['ERROR'])[0]!;
    const record = recordCapture({
      plan,
      outcome: { reached: true },
      imageKey: null,
      environmentId: 'env-1',
    });
    expect(record.reached).toBe(true);
    expect(mayWriteBaseline(record)).toBe(false);
  });

  it('visualCaptureSchema REFUSES an imageKey beside an unreached reason', () => {
    const base = {
      cell: { engine: 'chromium' },
      state: 'ERROR',
      environmentId: 'env-1',
    };
    const forged = visualCaptureSchema.safeParse({
      ...base,
      reached: false,
      unreachedReason: 'NO_TRIGGER_FOUND',
      unreachedDetail: 'nothing triggered validation',
      imageKey: 'visual/t1-ERROR-actual.png',
    });
    expect(forged.success).toBe(false);
    const honest = visualCaptureSchema.safeParse({
      ...base,
      reached: false,
      unreachedReason: 'NO_TRIGGER_FOUND',
      unreachedDetail: 'nothing triggered validation',
      imageKey: null,
    });
    expect(honest.success).toBe(true);
  });

  it('a REACHER that lies (claims reached, captures the default) cannot be caught — but a thrower is', async () => {
    const plan = planMatrix({
      cells: [CHROMIUM],
      seed: 'adversary',
      maxCells: 4,
      deployment: { engines: { chromium: true } } as never,
    });
    const out = await runVisualMatrix({
      plan,
      states: ['ERROR', 'EMPTY'],
      environmentId: 'env-1',
      reach: () => {
        throw new Error('the dropdown never opened');
      },
      capture: () => 'visual/should-never-be-written.png',
    });
    expect(out.captures.length).toBe(2);
    for (const c of out.captures) {
      expect(c.reached).toBe(false);
      expect(c.imageKey).toBeNull();
      expect(c.unreachedReason).toBe('ENGINE_CANNOT_SIMULATE');
      expect(mayWriteBaseline(c)).toBe(false);
    }
    expect(out.reached).toBe(0);
  });

  it('a refused CELL yields typed NOT_RUN entries, kept apart from UNREACHED states', async () => {
    const plan = planMatrix({
      cells: [CHROMIUM, WEBKIT],
      seed: 'adversary',
      maxCells: 4,
      deployment: { engines: { chromium: true, webkit: false } } as never,
    });
    const out = await runVisualMatrix({
      plan,
      states: ['DEFAULT', 'ERROR'],
      environmentId: 'env-1',
      reach: (p) => (p.state === 'DEFAULT' ? { reached: true } : { reached: false, reason: 'NO_TRIGGER_FOUND', detail: 'no trigger' }),
      capture: (p) => `visual/${p.baselineBrowser}-${p.state}.png`,
    });
    // WebKit's two (cell, state) pairs are NOT_RUN — our image, not their bug.
    expect(out.notRun.length).toBe(2);
    for (const n of out.notRun) {
      expect(n.cell.engine).toBe('webkit');
      expect(n.notRun.kind).toBe('BLOCKED_BY_ENV');
    }
    // Chromium's DEFAULT wrote a baseline; its ERROR did not.
    const written = out.captures.filter((c) => mayWriteBaseline(c));
    expect(written.map((c) => c.state)).toEqual(['DEFAULT']);
  });

  it('a DEFAULT-state unvaried cell keys byte-identically to the pre-matrix writer', () => {
    const plan = planVisualCaptures([floorCellFor({ width: 1280, height: 800 })], ['DEFAULT'])[0]!;
    expect(plan.baselineViewport).toBe('1280x800');
    expect(plan.baselineBrowser).toBe('chromium');
  });

  it('every interaction state produces a DISTINCT baseline key, so none upserts onto another', () => {
    const keys = INTERACTION_STATES.map(
      (state) => planVisualCaptures([floorCellFor({ width: 1280, height: 800 })], [state])[0]!.baselineViewport,
    );
    expect(new Set(keys).size).toBe(INTERACTION_STATES.length);
  });
});
