/*
 * THE FIVE HONESTY COLUMNS, AT THE ONE PLACE BOTH INGEST PATHS WRITE THEM.
 *
 * `matrixCell`, `cellStatus`, `cellRemedy`, `notAsserted` and
 * `notAssertedReason` were added to `TestResultVariant` by one round — with the
 * migration, the Prisma enums, the write-path schema and its four refinements —
 * and then written by NOBODY. Five NULLs for ever, and a pass with a hole in it
 * indistinguishable from a pass. These assertions are about the writer.
 *
 * Deliberately NOT about the two pairings `testResultVariantCellSchema` owns (a
 * `notAsserted` list with no reason; a reason with nothing listed). Those have
 * their own tests in ./test-type-decl.ts's suite and this module honours them
 * rather than re-deriving them — a second hand-rolled copy of a rule is a second
 * place for it to be wrong. What is asserted here is the half only this function
 * can see: that the row's IDENTITY and its resolved cell describe the same cell,
 * that a cell nobody could run does not also carry a verdict, and that every
 * member of both vocabularies survives the trip into a row.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  MATRIX_CELL_STATUS_LIST,
  UNASSERTED_REASON_LIST,
  UNVARIED,
  planMeasurements,
  variantBrowserKey,
  variantKeyOf,
  variantViewportKey,
} from './index';
import type {
  MatrixCell,
  MatrixCellStatus,
  MeasuredVariant,
  MeasurementParent,
  ReportedCellEvidence,
  TestExecution,
  UnassertedReason,
} from './index';

const PARENT: MeasurementParent = {
  orgId: 'org_1',
  projectId: 'proj_1',
  runId: 'run_1',
  testId: 'test_1',
  testResultId: 'tr_1',
};

/**
 * A cell that varies two axes the five TEXT columns cannot express on their own:
 * a chromium CHANNEL and a dark colour scheme. That is the whole reason
 * `matrixCell` is a column — `variantBrowserKey` packs the channel into
 * `browser` and `variantViewportKey` packs the scheme into `viewport`, and the
 * JSON is the detail behind those two keys.
 *
 * It names an EXPLICIT VIEWPORT, and not for taste: the key
 * `variantViewportKey` builds for a cell with a colour scheme and no device is
 * `<unvaried>+dark`, and `testVariantKeySchema` refuses an angle bracket in
 * anything that is not exactly a sentinel. This function never sees that schema
 * — both ingest paths run it first — so a cell keyed that way would make these
 * assertions about a shape neither path can deliver.
 */
const BETA_DARK: MatrixCell = {
  engine: 'chromium',
  channel: 'CHROME_BETA',
  device: { kind: 'VIEWPORT', viewport: { width: 1280, height: 720 } },
  colourScheme: 'DARK',
};

/** The row identity those two key functions produce for a cell. Never hand-written. */
function keyFor(cell: MatrixCell): MeasuredVariant['key'] {
  return {
    browser: variantBrowserKey(cell),
    viewport: variantViewportKey(cell),
    locale: cell.locale ?? UNVARIED,
    role: '<anonymous>',
    environment: 'env_1',
  };
}

function variantWith(
  cell: MatrixCell,
  evidence: Partial<ReportedCellEvidence> | null,
  overrides: Partial<MeasuredVariant> = {},
): MeasuredVariant {
  return {
    key: keyFor(cell),
    status: 'PASSED',
    durationMs: 10,
    errorMessage: null,
    retriedAndPassed: false,
    notRun: null,
    ...overrides,
    cell:
      evidence === null
        ? null
        : {
            matrixCell: cell,
            cellStatus: 'AVAILABLE',
            cellRemedy: null,
            notAsserted: [],
            notAssertedReason: null,
            ...evidence,
          },
  };
}

function rowsOf(variants: readonly MeasuredVariant[]): ReturnType<typeof planMeasurements> {
  return planMeasurements(PARENT, variants, []);
}

describe('the five honesty columns have a writer', () => {
  it('lands a resolved cell, a cell status and a remedy in their own columns', () => {
    const plan = rowsOf([
      variantWith(
        BETA_DARK,
        {
          cellStatus: 'MISSING',
          cellRemedy: 'Install Chrome Beta, or run `npx playwright install chrome-beta`.',
        },
        { status: 'SKIPPED' },
      ),
    ]);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const row = plan.variants[0]!;
    /*
     * The JSON carries the channel and the scheme the two TEXT columns had to
     * pack, which is the entire reason the column exists. Deleting
     * `matrixCell:` from the writer turns this red.
     */
    expect(row.matrixCell).toEqual(BETA_DARK);
    expect(row.cellStatus).toBe('MISSING');
    expect(row.cellRemedy).toContain('chrome-beta');
    /*
     * AND THE IDENTITY IS UNCHANGED. The JSON is the detail behind the keys and
     * never a replacement for them: a writer that stored the cell and stopped
     * writing `browser`/`viewport` would break the six-column unique index.
     */
    expect(row.browser).toBe('chromium:CHROME_BETA');
    expect(row.viewport).toBe('1280x720+dark');
  });

  it('lands what a passing cell did NOT assert, with the reason, beside the pass', () => {
    /*
     * THE HEADLINE DEFECT OF THE ROUND, at the write path: checkout could be
     * clicked through and the money path could not be asserted, and the result
     * was a PASS. A pass with a non-empty `notAsserted` is a pass with a STATED
     * HOLE in it, which a gate can refuse to count; a pass with nothing recorded
     * is the lie.
     */
    const plan = rowsOf([
      variantWith(BETA_DARK, {
        notAsserted: ['the 3DS challenge', 'the webhook transition'],
        notAssertedReason: 'PROVIDER_TEST_MODE_LIMIT',
      }),
    ]);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.variants[0]!.status).toBe('PASSED');
    expect(plan.variants[0]!.notAsserted).toEqual(['the 3DS challenge', 'the webhook transition']);
    expect(plan.variants[0]!.notAssertedReason).toBe('PROVIDER_TEST_MODE_LIMIT');
  });

  it('copies the unasserted list rather than aliasing the producer\'s array', () => {
    /*
     * All-or-nothing planning is the one property this function guarantees, and
     * an aliased array lets a producer mutating its own report change a row that
     * was already planned.
     */
    const reported = ['the settlement'];
    const plan = rowsOf([
      variantWith(BETA_DARK, { notAsserted: reported, notAssertedReason: 'NOT_IMPLEMENTED' }),
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    reported.push('the dispute lifecycle');
    expect(plan.variants[0]!.notAsserted).toEqual(['the settlement']);
  });

  it('writes all five as nothing-recorded when the producer reported no cell', () => {
    const plan = rowsOf([variantWith(BETA_DARK, null)]);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const row = plan.variants[0]!;
    /*
     * ABSENT IS NOT AVAILABLE, and this is the assertion that says so. A writer
     * that defaulted `cellStatus` would put a claim in the database that no
     * producer made — "every historical cell ran" — which is the flattering
     * direction and therefore the dangerous one.
     */
    expect(row.cellStatus).toBeNull();
    expect(row.cellRemedy).toBeNull();
    expect(row.notAssertedReason).toBeNull();
    /*
     * `undefined` and NOT `null` for the Json column, which looks like the
     * mistake this file warns about and is not: Prisma writes SQL NULL for a
     * column an INSERT does not name, and a JS `null` in a nullable Json write
     * is a type error there — `Prisma.DbNull` is the sentinel. See
     * `VariantRow.matrixCell`.
     */
    expect(row.matrixCell).toBeUndefined();
    /*
     * `[]` IS THE FLOOR, NOT A CLAIM. `notAsserted` is `String[] @default([])`,
     * so there is no null to write — which is why `cellStatus IS NULL` is the
     * only honest "nobody recorded anything here" signal, and why a reader must
     * check it before reading `[]` as "asserted everything".
     */
    expect(row.notAsserted).toEqual([]);
  });

  it('still writes the ROW for an unmeasured cell, so it stays in the denominator', () => {
    // Rule: an unmeasured thing is null with a reason and STAYS IN the
    // denominator. Dropping the row would let a deployment shed every cell it
    // could not prove it could run, and the percentage would rise for a probe
    // nobody executed.
    const plan = rowsOf([
      variantWith(BETA_DARK, { cellStatus: 'NOT_CHECKED' }, { status: 'SKIPPED' }),
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.variants).toHaveLength(1);
    expect(plan.variants[0]!.cellStatus).toBe('NOT_CHECKED');
    // NOT_CHECKED carries no remedy: there is no remedy for a question nobody
    // asked, and inventing one would be advice derived from a fact we lack.
    expect(plan.variants[0]!.cellRemedy).toBeNull();
  });
});

describe('a cell whose identity and detail disagree', () => {
  it('is refused, naming both, rather than stored as one row describing two cells', () => {
    /*
     * The schema's own note says the resolved cell's key "must equal the stored
     * browser/viewport pair" and NOTHING ENFORCED IT:
     * `testResultVariantCellSchema` validates the cell alone and never sees the
     * key. This function is the only place that holds both.
     */
    const plan = rowsOf([
      variantWith(BETA_DARK, { matrixCell: { engine: 'webkit' } }),
    ]);

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.why).toContain('whose own identity is');
    // Both keys named, so a reader can see which two cells got crossed.
    expect(plan.why).toContain('chromium:CHROME_BETA');
    expect(plan.why).toContain('webkit');
    expect(plan.why).toContain('groups on the identity');
  });

  it('refuses a viewport disagreement, not only a browser one', () => {
    // Two columns make up the identity and a producer can pack either wrong.
    // Checking only `browser` would let a dark capture be filed as a light one.
    const plan = rowsOf([
      variantWith(BETA_DARK, { matrixCell: { engine: 'chromium', channel: 'CHROME_BETA' } }),
    ]);
    expect(plan.ok).toBe(false);
  });

  it('names both cells through JSON, so a free-text axis cannot forge a line', () => {
    /*
     * A locale is free text — `variantDimension` bounds its length and reserves
     * angle brackets, and that is all — so nothing forbids a newline in one, and
     * a raw newline in a refusal a customer's agent reads back is a forged log
     * line. The REPORTED cell is named by `variantKeyOf`, which escapes it, and
     * the EXPECTED pair comes out of `variantBrowserKey` / `variantViewportKey`,
     * whose every input is a closed vocabulary or a dotted numeral. Both halves
     * go through `JSON.stringify` anyway, because the second property is one a
     * later axis could quietly take away.
     */
    const forged: MatrixCell = { ...BETA_DARK, locale: 'en\nREFUSAL: none' };
    const plan = rowsOf([
      { ...variantWith(forged, { matrixCell: { engine: 'webkit' } }) },
    ]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.why).not.toContain('\n');
    expect(plan.why).toContain('\\n');
  });
});

describe('a cell this deployment could not run', () => {
  /** The four statuses that mean NO EVIDENCE WAS PRODUCED. */
  const unexercisable: readonly MatrixCellStatus[] = [
    'MISSING',
    'WRONG_VERSION',
    'UNSUPPORTED_COMBINATION',
    'NEEDS_BROWSER_GRID',
  ];

  it('cannot also carry a verdict, in either direction', () => {
    /*
     * A PASS on a cell that could not run is a cell that can never fail counted
     * in the numerator — the lie in the customer's favour this column exists to
     * kill. A FAILED is just as wrong the other way: a defect reported against
     * the customer's application from the fact that OUR image has no browser.
     */
    for (const cellStatus of unexercisable) {
      for (const status of ['PASSED', 'FAILED', 'FLAKY', 'TIMED_OUT'] as const) {
        const plan = rowsOf([
          variantWith(BETA_DARK, { cellStatus, cellRemedy: 'install it' }, { status }),
        ]);
        expect(plan.ok, `${cellStatus} beside ${status}`).toBe(false);
        if (plan.ok) continue;
        expect(plan.why).toContain('no evidence was');
      }
    }
  });

  it('is accepted as SKIPPED, which is what makes the cell status worth having', () => {
    // The row is written, the cell stays in the denominator, and now it says
    // WHICH of the six reasons applied — the distinction from a placeholder
    // nobody reached, which is the whole point of the column.
    for (const cellStatus of unexercisable) {
      const plan = rowsOf([
        variantWith(BETA_DARK, { cellStatus, cellRemedy: 'install it' }, { status: 'SKIPPED' }),
      ]);
      expect(plan.ok, cellStatus).toBe(true);
    }
  });

  it('lets AVAILABLE and NOT_CHECKED keep their verdicts', () => {
    /*
     * NOT_CHECKED is NOT unexercisable and must not be swept in with the four:
     * an unprobed cell was attempted, the attempt IS the evidence, and refusing
     * its verdict would throw away the only reading anybody took.
     */
    for (const cellStatus of ['AVAILABLE', 'NOT_CHECKED'] as const) {
      const plan = rowsOf([variantWith(BETA_DARK, { cellStatus }, { status: 'PASSED' })]);
      expect(plan.ok, cellStatus).toBe(true);
    }
  });
});

describe('both vocabularies survive the trip into a row', () => {
  /*
   * The run-time parity half, at the WRITE PATH rather than at the schema. A
   * member added to either list that the writer cannot store is exactly the
   * shape of the eight unsaveable gate kinds: present in the type, accepted by
   * the validator, and refused on an insert at run time.
   */
  it('writes every one of the six cell statuses', () => {
    const written: MatrixCellStatus[] = [];
    for (const cellStatus of MATRIX_CELL_STATUS_LIST) {
      // A remedy is required beside four of the six and refused beside
      // NOT_CHECKED — `testResultVariantCellSchema`'s rule, mirrored here only
      // so each status is offered in its one legal shape.
      const needsRemedy = cellStatus !== 'AVAILABLE' && cellStatus !== 'NOT_CHECKED';
      const plan = rowsOf([
        variantWith(
          BETA_DARK,
          { cellStatus, cellRemedy: needsRemedy ? 'do this' : null },
          { status: needsRemedy ? 'SKIPPED' : 'PASSED' },
        ),
      ]);
      expect(plan.ok, cellStatus).toBe(true);
      if (plan.ok) written.push(plan.variants[0]!.cellStatus!);
    }
    expect(written).toEqual([...MATRIX_CELL_STATUS_LIST]);
    expect(written).toHaveLength(6);
  });

  it('writes every one of the eight unasserted reasons', () => {
    const written: UnassertedReason[] = [];
    for (const notAssertedReason of UNASSERTED_REASON_LIST) {
      const plan = rowsOf([
        variantWith(BETA_DARK, { notAsserted: ['something'], notAssertedReason }),
      ]);
      expect(plan.ok, notAssertedReason).toBe(true);
      if (plan.ok) written.push(plan.variants[0]!.notAssertedReason!);
    }
    expect(written).toEqual([...UNASSERTED_REASON_LIST]);
    expect(written).toHaveLength(8);
  });
});

describe('the row builder stays something the web bundler can eat', () => {
  it('imports no node builtin, no Prisma client and no zod', () => {
    /*
     * The module's own standing claim, asserted rather than assumed: it is on
     * the @qaai/shared barrel the web app's bundler consumes, and the whole
     * reason the nullable-Json sentinel is spelled by the CALLERS is that a
     * Prisma import here would break every page that reads a value out of this
     * package.
     *
     * An IMPORT of each, not a mention: the doc comments name all three, so a
     * substring search for the words fails on the file that is correct.
     */
    const source = readFileSync(
      fileURLToPath(new URL('./measurement-rows.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/(?:from|import)\s*\(?\s*['"]node:/);
    expect(source).not.toMatch(/(?:from|import)\s*\(?\s*['"]zod['"]/);
    expect(source).not.toMatch(/(?:from|import)\s*\(?\s*['"][^'"]*generated\/prisma/);
    // And it still reaches the two key functions, which is the only thing that
    // makes the identity/detail check ask rather than re-derive.
    expect(source).toMatch(/from '\.\/browser-matrix'/);
  });

  it('keys a cell injectively, which is what the refusal messages rest on', () => {
    // `variantKeyOf` is JSON for injectivity: a viewport literally named `a|b`
    // would otherwise join to the same string as the pair (`a`, `b`).
    expect(variantKeyOf(keyFor({ engine: 'chromium' }))).not.toBe(
      variantKeyOf(keyFor({ engine: 'firefox' })),
    );
  });
});

/**
 * ── THE COMPILE-TIME HALF: A PRODUCER CANNOT REPORT WHAT THE TYPE WILL NOT HOLD
 *
 * `TestExecution.variants` used to be `TestResultVariant[]`, so the per-cell
 * evidence existed at RUN TIME and not in the type a plugin returns. Both
 * ingest paths validated and stored it, and the next author of a matrix plugin
 * would have read that declaration, found nowhere to put a cell, and emitted
 * nothing — which is how the five honesty columns came to have a migration, a
 * schema with four refinements, a row builder, an index and NO WRITER.
 *
 * This is a `typecheck` assertion and not a vitest one, and it is in the test
 * file on purpose: it has no run-time job, and a constant in a source file that
 * nothing reads is the defect this round removes rather than adds. `npm run
 * typecheck` is the gate it fails at — reverting the widening makes the
 * assignment below an excess-property error, naming `cell`.
 */
const REPORTED_BY_A_PLUGIN: TestExecution['variants'] = [
  {
    key: { browser: 'webkit', viewport: '1280x800', locale: UNVARIED, role: UNVARIED, environment: 'env_1' },
    status: 'SKIPPED',
    durationMs: 0,
    errorMessage: null,
    retriedAndPassed: false,
    notRun: { kind: 'UNSUPPORTED', why: 'no WebKit on this image' },
    cell: {
      matrixCell: { engine: 'webkit' },
      cellStatus: 'MISSING',
      cellRemedy: 'run `npx playwright install webkit` in the runner image',
      notAsserted: [],
      notAssertedReason: null,
    },
  },
];

describe('the execution type carries the evidence it is validated for', () => {
  it('accepts a reported cell on a variant a plugin returns', () => {
    // The run-time companion, so the constant above is not dead weight: the
    // same value a plugin would hand back, read the way the worker reads it.
    expect(REPORTED_BY_A_PLUGIN?.[0]?.cell?.cellStatus).toBe('MISSING');
    expect(REPORTED_BY_A_PLUGIN?.[0]?.cell?.cellRemedy).not.toBeNull();
  });
});
