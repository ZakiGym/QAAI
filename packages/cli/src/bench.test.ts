/**
 * `qaai bench` — the tests for the harness that measures the measurer.
 *
 * Two things are asserted throughout and the second matters as much as the
 * first: the NUMBER, and that the thing the number cannot say is NAMED. Nearly
 * every test below has a sibling checking that a null stayed null, that a
 * NOT_EXERCISED did not become a MISSED, or that a cap that bit arrived with its
 * count in a sentence. Those are the regressions that would not look like
 * failures in production — a benchmark reporting a flattering number is still a
 * green build.
 *
 * The parity block is first on purpose. bench.ts mirrors two shared
 * vocabularies as runtime arrays because the published CLI cannot import a
 * value from @qaai/shared, and a mirror nothing checks is a mirror that drifts
 * — so these tests import the SCHEMAS (which are on the barrel, unlike the raw
 * `const` arrays) and compare `.options`. Comparing against the validator is
 * the stronger assertion anyway: it is the write path, and a cell kind the API
 * would refuse is one this declaration must never produce.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  coverageCellKindSchema,
  faultDetectionOutcomeSchema,
  RATED_FAULT_OUTCOMES,
  SURFACE_KINDS,
} from '@qaai/shared';
import {
  API_ITEM_LIMIT,
  BENCH_CELL_KINDS,
  BENCH_EXIT,
  BENCH_FAULT_OUTCOMES,
  BENCH_RATED_OUTCOMES,
  BenchError,
  GROUND_TRUTH_AXIS_POLICY,
  GROUND_TRUTH_FLOORS,
  GROUND_TRUTH_MIN_ITEMS,
  applyFault,
  assertCleanBaseline,
  classifyFault,
  compareToGroundTruth,
  evaluateGroundTruthGate,
  faultRatesByClass,
  parseBenchArgs,
  parseFaultCatalogue,
  parseGroundTruth,
  parseJunit,
  renderBench,
  runBench,
  surfaceEnumeratorOverHttp,
  type BenchFileStore,
  type BenchSuiteReport,
  type BenchSuiteRunner,
  type BenchTestOutcome,
  type EnumeratedSurface,
  type FaultCatalogue,
  type SeededFault,
} from './bench.js';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const DEMO_ROOT = join(REPO_ROOT, 'apps/demo');

function readDemo(relative: string): string {
  return readFileSync(join(DEMO_ROOT, relative), 'utf8');
}

const REAL_GROUND_TRUTH = parseGroundTruth(JSON.parse(readDemo('src/surface.json')));
const REAL_CATALOGUE = parseFaultCatalogue(JSON.parse(readDemo('src/faults/catalogue.json')));

// ─── The mirrors ────────────────────────────────────────────────────────────

describe('the shared vocabularies this file mirrors', () => {
  it('has every coverage cell kind the write path accepts, in the same order', () => {
    // Order and not just membership: `declaredCellsByKind` iterates
    // BENCH_CELL_KINDS to produce a stable report, and a reordering would
    // silently change the shape of a diffable output.
    expect([...BENCH_CELL_KINDS]).toEqual([...coverageCellKindSchema.options]);
  });

  it('has every fault detection outcome the write path accepts', () => {
    expect([...BENCH_FAULT_OUTCOMES]).toEqual([...faultDetectionOutcomeSchema.options]);
  });

  it('keeps NOT_EXERCISED out of both halves of the detection rate', () => {
    // THE ARITHMETIC THE WHOLE BENCHMARK TURNS ON. Counting it as MISSED blames
    // the assertions for a coverage gap; counting it as DETECTED is fiction.
    //
    // Compared against the SHARED original and not against a literal, which is
    // what this file's header promises of every mirror ("bench.test.ts asserts
    // it against the shared original through the package entry point"). It did
    // not: the two neighbouring mirrors above are checked against
    // `coverageCellKindSchema` and `faultDetectionOutcomeSchema`, and this one
    // was checked against a hand-typed pair — so NOT_EXERCISED joining
    // `RATED_FAULT_OUTCOMES` in @qaai/shared would have left the CLI's mirror
    // green while the two halves of the product disagreed about what is in the
    // fraction. The literal stays BESIDE it, because the whole point is that
    // this particular pair is not allowed to grow on either side.
    expect([...BENCH_RATED_OUTCOMES]).toEqual([...RATED_FAULT_OUTCOMES]);
    expect([...BENCH_RATED_OUTCOMES]).toEqual(['DETECTED', 'MISSED']);
    expect(BENCH_RATED_OUTCOMES).not.toContain('NOT_EXERCISED');
    expect(BENCH_RATED_OUTCOMES).not.toContain('BASELINE_DIRTY');
  });

  it('has a comparison policy for every surface axis', () => {
    // A thirteenth axis landing in @qaai/shared must be a decision here, not an
    // axis the harness quietly stops checking — which would report a recall of
    // 100% on surface it never looked at.
    expect(Object.keys(GROUND_TRUTH_AXIS_POLICY).sort()).toEqual([...SURFACE_KINDS].sort());
  });

  it('gives every exit code a distinct number', () => {
    const codes = Object.values(BENCH_EXIT);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

// ─── The ratchet ────────────────────────────────────────────────────────────

describe('the accuracy ratchet', () => {
  it('is null on both floors, because nothing has measured them yet', () => {
    // If this goes red because somebody recorded a real measurement, update the
    // expectation IN THE SAME CHANGE as the floor and say which run it came
    // from. The test exists so arming the ratchet is a reviewed edit.
    expect(GROUND_TRUTH_FLOORS.precisionPercent).toBeNull();
    expect(GROUND_TRUTH_FLOORS.recallPercent).toBeNull();
  });

  it('cannot report a pass while a floor is null', () => {
    // THE DEFECT A `0` FLOOR WOULD HAVE CAUSED: every run exits 0, the ratchet
    // looks armed, and 4% precision goes green.
    const gate = evaluateGroundTruthGate({
      comparison: comparisonOf({ precisionPercent: 100, recallPercent: 100 }),
      floors: { precisionPercent: null, recallPercent: null },
    });
    expect(gate.state).toBe('NO_FLOOR');
    expect(gate.code).toBe(BENCH_EXIT.NOT_MEASURED);
    expect(gate.code).not.toBe(BENCH_EXIT.OK);
  });

  it('refuses a declaration that shrank below the recorded floor', async () => {
    const shrunk: unknown = {
      ...JSON.parse(readDemo('src/surface.json')),
      items: JSON.parse(readDemo('src/surface.json')).items.slice(0, 3),
    };
    await expect(
      runBench(
        {
          files: fakeFiles({
            [join('/app', 'src/surface.json')]: JSON.stringify(shrunk),
            [join('/app', 'src/faults/catalogue.json')]: readDemo('src/faults/catalogue.json'),
          }),
          runSuite: neverRunner,
        },
        { appRoot: '/app', seed: 's', onlyFaults: [], accuracyOnly: true, detectionOnly: false },
      ),
    ).rejects.toThrow(/EXTEND, DO NOT SHRINK/);
  });

  it('agrees with the declaration that actually ships', () => {
    expect(REAL_GROUND_TRUTH.items.length).toBeGreaterThanOrEqual(GROUND_TRUTH_MIN_ITEMS);
  });
});

// ─── Reading the declaration ────────────────────────────────────────────────

describe('parseGroundTruth', () => {
  it('reads the real declaration', () => {
    expect(REAL_GROUND_TRUTH.application).toBe('@qaai/demo');
    expect(REAL_GROUND_TRUTH.items.length).toBeGreaterThan(40);
    expect(REAL_GROUND_TRUTH.declaredAbsent).toContain('ROUTE:/*');
  });

  it('refuses a duplicate key', () => {
    // A duplicate counts one enumerated item as two hits and moves recall up
    // for nothing.
    const item = REAL_GROUND_TRUTH.items[0]!;
    expect(() =>
      parseGroundTruth({
        application: 'x',
        items: [rawItem(item.key), rawItem(item.key)],
      }),
    ).toThrow(/declared twice/);
  });

  it('refuses a key that does not begin with its own kind', () => {
    expect(() =>
      parseGroundTruth({ application: 'x', items: [{ ...rawItem('/products'), kind: 'ROUTE' }] }),
    ).toThrow(/must begin with its own kind/);
  });

  it('refuses NOT_CHECKED with no reason', () => {
    expect(() =>
      parseGroundTruth({
        application: 'x',
        items: [{ ...rawItem('ROUTE:/x'), compare: 'NOT_CHECKED' }],
      }),
    ).toThrow(/NOT_CHECKED with no reason/);
  });

  it('refuses an unreachable item with no reason', () => {
    // An item that leaves the recall denominator has to say why, or the
    // denominator is editable at will.
    expect(() =>
      parseGroundTruth({
        application: 'x',
        items: [{ ...rawItem('ROUTE:/x'), reachable: false }],
      }),
    ).toThrow(/declared unreachable with no reason/);
  });

  it('refuses a cell kind the API would refuse', () => {
    expect(() =>
      parseGroundTruth({
        application: 'x',
        items: [
          {
            ...rawItem('ROUTE:/x'),
            states: [{ stateKey: 's', cellKind: 'PAGE_SORT_OF_EMPTY', reachable: true, note: null }],
          },
        ],
      }),
    ).toThrow(/is not a coverage cell kind/);
  });
});

// ─── Precision and recall ───────────────────────────────────────────────────

describe('compareToGroundTruth', () => {
  const declared = parseGroundTruth({
    application: 'x',
    $declaredAbsent: { keys: ['ROUTE:/*'] },
    items: [
      rawItem('ROUTE:/a'),
      rawItem('ROUTE:/b'),
      { ...rawItem('ROUTE:/ghost'), reachable: false, unreachableReason: 'no handler' },
      { ...rawItem('FORM:POST /a#one'), kind: 'FORM', compare: 'COUNT' },
    ],
  });

  it('reports precision and recall as two separate numbers', () => {
    const comparison = compareToGroundTruth({
      declared,
      enumerated: enumerated(['ROUTE:/a', 'ROUTE:/nope']),
    });
    // One of two reachable found → 50% recall. One of two enumerated declared
    // → 50% precision. They happen to agree here; the next test separates them.
    expect(comparison.recallPercent).toBe(50);
    expect(comparison.precisionPercent).toBe(50);
  });

  it('names every false negative instead of summarising them', () => {
    const comparison = compareToGroundTruth({ declared, enumerated: enumerated(['ROUTE:/a']) });
    expect(comparison.falseNegatives.map((miss) => miss.key)).toEqual(['ROUTE:/b']);
    expect(comparison.falseNegatives[0]?.declaredIn).toBe('src/index.ts');
    expect(comparison.falseNegatives[0]?.detail).toContain('not enumerated');
  });

  it('separates an invented key from one the declaration may simply be missing', () => {
    // The two have different owners: DECLARED_ABSENT is a product defect,
    // UNDECLARED might be a gap in surface.json. Printing them as one list is
    // how the first gets lost in the second.
    const comparison = compareToGroundTruth({
      declared,
      enumerated: enumerated(['ROUTE:/*', 'ROUTE:/surprise']),
    });
    expect(comparison.falsePositives).toEqual([
      expect.objectContaining({ key: 'ROUTE:/*', cause: 'DECLARED_ABSENT' }),
      expect.objectContaining({ key: 'ROUTE:/surprise', cause: 'UNDECLARED' }),
    ]);
    expect(comparison.falsePositives[0]?.detail).toContain('invented');
  });

  it('counts an enumerated unreachable item in precision and NOT in recall', () => {
    // Finding it is correct of the extractor; crediting recall for it would
    // credit QAAI with covering something no test could ever reach.
    const comparison = compareToGroundTruth({
      declared,
      enumerated: enumerated(['ROUTE:/a', 'ROUTE:/b', 'ROUTE:/ghost']),
    });
    expect(comparison.precisionPercent).toBe(100);
    expect(comparison.recallPercent).toBe(100);
    expect(comparison.unreachableFound).toEqual(['ROUTE:/ghost']);
    expect(comparison.truePositives).not.toContain('ROUTE:/ghost');
  });

  it('keeps a COUNT axis out of precision and reports it as a count', () => {
    const comparison = compareToGroundTruth({
      declared,
      enumerated: enumerated(['ROUTE:/a', 'ROUTE:/b', 'FORM:src/views.ts#3']),
    });
    // The form key is neither a hit nor a false positive: its identity is not
    // comparable, so it may not move a percentage in either direction.
    expect(comparison.precisionPercent).toBe(100);
    expect(comparison.falsePositives).toEqual([]);
    expect(comparison.countComparisons).toEqual([
      expect.objectContaining({ kind: 'FORM', declaredCount: 1, enumeratedCount: 1 }),
    ]);
  });

  it('refuses both figures when the enumeration was truncated, and names the cap', () => {
    // THE DEFECT: every unreturned key reads as a false negative, so recall
    // becomes a property of the API's page size.
    const comparison = compareToGroundTruth({
      declared,
      enumerated: {
        keys: ['ROUTE:/a'],
        complete: false,
        caps: ['the item list was truncated: 1 of 400 keys returned'],
        detectors: [],
      },
    });
    expect(comparison.precisionPercent).toBeNull();
    expect(comparison.recallPercent).toBeNull();
    expect(comparison.comparable).toBe(false);
    expect(comparison.incomparableReason).toContain('1 of 400');
  });

  it('returns null rather than 0 when nothing was enumerated at all', () => {
    const comparison = compareToGroundTruth({ declared, enumerated: enumerated([]) });
    expect(comparison.precisionPercent).toBeNull();
    expect(comparison.recallPercent).toBe(0);
  });

  it('returns null rather than 100 when nothing was declared', () => {
    const empty = parseGroundTruth({ application: 'x', items: [] });
    const comparison = compareToGroundTruth({ declared: empty, enumerated: enumerated([]) });
    expect(comparison.recallPercent).toBeNull();
  });

  it('counts the declared cells by kind, so the dimension round has a target', () => {
    const comparison = compareToGroundTruth({
      declared: REAL_GROUND_TRUTH,
      enumerated: enumerated([]),
    });
    const kinds = new Map(comparison.declaredCellsByKind.map((row) => [row.cellKind, row.count]));
    expect(kinds.get('RULE_REQUIRED')).toBeGreaterThan(0);
    expect(kinds.get('ERROR_FORBIDDEN')).toBeGreaterThan(0);
  });

  it('names the axes it did not declare instead of scoring them', () => {
    const comparison = compareToGroundTruth({
      declared: REAL_GROUND_TRUTH,
      enumerated: enumerated([]),
    });
    expect(comparison.axesNotDeclared.map((axis) => axis.axis)).toContain('DEVICE_LOCALE');
    for (const axis of comparison.axesNotDeclared) expect(axis.reason.length).toBeGreaterThan(20);
  });
});

describe('evaluateGroundTruthGate', () => {
  const floors = { precisionPercent: 90, recallPercent: 95 };

  it('reports a recall regression before a precision one', () => {
    // A recall regression is the one that raises the headline coverage number,
    // so it has to be the sentence at the top of a CI log.
    const gate = evaluateGroundTruthGate({
      comparison: comparisonOf({ precisionPercent: 10, recallPercent: 10 }),
      floors,
    });
    expect(gate.state).toBe('RECALL_BELOW_FLOOR');
  });

  it('exits 3 and not 1 when there is nothing to divide', () => {
    // Accuracy did not drop; it was never measured. Collapsing the two means a
    // team spends an afternoon looking for a regression that never happened.
    const gate = evaluateGroundTruthGate({
      comparison: comparisonOf({ precisionPercent: null, recallPercent: null }),
      floors,
    });
    expect(gate.code).toBe(BENCH_EXIT.NOT_MEASURED);
    expect(gate.code).not.toBe(BENCH_EXIT.BELOW_FLOOR);
  });

  it('passes on the floor exactly, not only above it', () => {
    const gate = evaluateGroundTruthGate({
      comparison: comparisonOf({ precisionPercent: 90, recallPercent: 95 }),
      floors,
    });
    expect(gate.state).toBe('OK');
  });
});

// ─── The catalogue ──────────────────────────────────────────────────────────

describe('parseFaultCatalogue', () => {
  it('reads the real catalogue', () => {
    expect(REAL_CATALOGUE.faults.length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(REAL_CATALOGUE.classes).length).toBeGreaterThanOrEqual(7);
  });

  it('refuses a fault whose class has no definition', () => {
    expect(() =>
      parseFaultCatalogue({
        application: 'x',
        $classes: { A: 'a' },
        faults: [{ ...rawFault(), class: 'B' }],
      }),
    ).toThrow(/has no entry in \$classes/);
  });

  it('refuses a non-deterministic fault with no note', () => {
    // A benchmark you cannot reproduce from a seed is not a benchmark, so the
    // reason it cannot be has to reach the report.
    expect(() =>
      parseFaultCatalogue({
        application: 'x',
        $classes: { A: 'a' },
        faults: [{ ...rawFault(), deterministic: false, repetitions: 5 }],
      }),
    ).toThrow(/declared non-deterministic with no note/);
  });

  it('refuses a non-deterministic fault run once', () => {
    expect(() =>
      parseFaultCatalogue({
        application: 'x',
        $classes: { A: 'a' },
        faults: [
          {
            ...rawFault(),
            deterministic: false,
            repetitions: 1,
            nondeterminismNote: 'the app draws a uuid',
          },
        ],
      }),
    ).toThrow(/reports a coin toss as a measurement/);
  });

  it('refuses an edit that changes nothing', () => {
    // It would be scored MISSED against a suite that had nothing to find.
    expect(() =>
      parseFaultCatalogue({
        application: 'x',
        $classes: { A: 'a' },
        faults: [{ ...rawFault(), edits: [{ file: 'a.ts', find: 'x', replace: 'x' }] }],
      }),
    ).toThrow(/find and replace are identical/);
  });

  it('refuses a duplicate fault id', () => {
    expect(() =>
      parseFaultCatalogue({
        application: 'x',
        $classes: { A: 'a' },
        faults: [rawFault(), rawFault()],
      }),
    ).toThrow(/appears twice/);
  });

  it('lands every real fault on a key the declaration actually declares', () => {
    // A fault on an undeclared surface can never be NOT_EXERCISED or MISSED
    // correctly, because there is no declared item for the attribution to
    // match. This is the test that keeps the two JSON files in step.
    const keys = new Set(REAL_GROUND_TRUTH.items.map((item) => item.key));
    for (const fault of REAL_CATALOGUE.faults) {
      for (const key of [fault.surfaceItemKey, ...fault.alsoAffects]) {
        if (key !== null) expect(keys, `${fault.id} → ${key}`).toContain(key);
      }
    }
  });

  it('has at least two members in two classes, so no rate is an n of one everywhere', () => {
    const counts = new Map<string, number>();
    for (const fault of REAL_CATALOGUE.faults) {
      counts.set(fault.faultClass, (counts.get(fault.faultClass) ?? 0) + 1);
    }
    expect([...counts.values()].filter((count) => count >= 2).length).toBeGreaterThanOrEqual(2);
  });
});

// ─── The clean baseline ─────────────────────────────────────────────────────

describe('assertCleanBaseline', () => {
  it('passes against the real demo source with no fault applied', () => {
    const files = new Map<string, string>();
    for (const fault of REAL_CATALOGUE.faults) {
      for (const edit of fault.edits) files.set(edit.file, readDemo(edit.file));
    }
    const verdict = assertCleanBaseline(REAL_CATALOGUE, files);
    expect(verdict.problems).toEqual([]);
    expect(verdict.clean).toBe(true);
  });

  it('catches every real fault left switched on, one at a time', () => {
    // The guarantee the whole bench rests on. If any single fault can be left
    // applied without this noticing, a later run's readings are silently void.
    for (const fault of REAL_CATALOGUE.faults) {
      const files = new Map<string, string>();
      for (const other of REAL_CATALOGUE.faults) {
        for (const edit of other.edits) files.set(edit.file, readDemo(edit.file));
      }
      const applied = applyFault(fault, files);
      expect(applied.ok, fault.id).toBe(true);
      if (!applied.ok) continue;
      const verdict = assertCleanBaseline(REAL_CATALOGUE, applied.files);
      expect(verdict.clean, `${fault.id} was not noticed`).toBe(false);
      expect(verdict.problems.join(' ')).toContain(fault.id);
    }
  });

  it('notices an ADDITIVE patch, which the anchor check alone cannot', () => {
    /*
     * THIS TEST EXISTS BECAUSE A MUTATION SURVIVED WITHOUT IT.
     *
     * Deleting the `replace`-is-present check left "catches every real fault
     * left switched on" green, because all ten faults in the shipped catalogue
     * REPLACE their anchor — so the anchor vanishes and the other guard fires.
     * The two checks are not redundant, and this is the case that separates
     * them: an ADDITIVE patch (replace contains find) leaves the anchor exactly
     * where it was, present exactly once, and only "the patched text is already
     * here" can see it.
     *
     * The catalogue has no additive fault today. The guard still has to work,
     * because the first person to write one would otherwise get a dirty
     * baseline reported as clean and every reading after it would be void.
     */
    const catalogue = oneFaultCatalogue({ find: 'const x = 1;', replace: 'const x = 1; // broken' });
    const dirty = applyFault(catalogue.faults[0]!, new Map([['a.ts', 'const x = 1;']]));
    expect(dirty.ok).toBe(true);
    if (!dirty.ok) return;
    // The anchor survived the patch, so the anchor check has nothing to say.
    expect(dirty.files.get('a.ts')).toContain('const x = 1;');
    const verdict = assertCleanBaseline(catalogue, dirty.files);
    expect(verdict.clean).toBe(false);
    expect(verdict.problems.join(' ')).toContain('ALREADY PRESENT');
  });

  it('refuses an ambiguous anchor rather than seeding a different defect', () => {
    const catalogue = oneFaultCatalogue({ find: 'dup', replace: 'DUP' });
    const verdict = assertCleanBaseline(catalogue, new Map([['a.ts', 'dup dup']]));
    expect(verdict.clean).toBe(false);
    expect(verdict.problems[0]).toContain('appears 2 times');
  });

  it('reports a vanished anchor as its own problem, not as a dirty baseline', () => {
    const catalogue = oneFaultCatalogue({ find: 'gone', replace: 'GONE' });
    const verdict = assertCleanBaseline(catalogue, new Map([['a.ts', 'nothing here']]));
    expect(verdict.problems[0]).toContain('no longer in a.ts');
  });
});

describe('applyFault', () => {
  it('is all-or-nothing across a multi-edit fault', () => {
    // Half of a two-edit fault is not a milder defect, it is a syntax error —
    // and a syntax error makes every test red, which this harness would
    // otherwise score as a triumphant DETECTED.
    const fault: SeededFault = {
      ...rawParsedFault(),
      edits: [
        { file: 'a.ts', find: 'one', replace: 'ONE' },
        { file: 'a.ts', find: 'missing', replace: 'MISSING' },
      ],
    };
    const applied = applyFault(fault, new Map([['a.ts', 'one']]));
    expect(applied.ok).toBe(false);
  });

  it('leaves the input map untouched', () => {
    const files = new Map([['a.ts', 'one']]);
    applyFault({ ...rawParsedFault(), edits: [{ file: 'a.ts', find: 'one', replace: 'ONE' }] }, files);
    expect(files.get('a.ts')).toBe('one');
  });
});

// ─── The classification, which is the product ───────────────────────────────

describe('classifyFault', () => {
  const fault: SeededFault = { ...rawParsedFault(), surfaceItemKey: 'ROUTE:/checkout' };

  it('calls it DETECTED when a baseline-passing test goes red', () => {
    const reading = classifyFault({
      fault,
      baseline: report([test('t1', 'PASSED'), test('t2', 'PASSED')]),
      withFault: [report([test('t1', 'FAILED'), test('t2', 'PASSED')])],
    });
    expect(reading.outcome).toBe('DETECTED');
    expect(reading.detectedByTestId).toBe('t1');
  });

  it('does NOT call it DETECTED when the test was already red on the baseline', () => {
    // THE DEFECT A NAIVE "SOMETHING IS RED" CHECK WOULD HAVE: a dead target, an
    // expired credential or an already-broken test becomes a detection, which
    // is the condition a CI box is in on a bad day.
    const reading = classifyFault({
      fault,
      baseline: report([test('t1', 'FAILED'), test('t2', 'PASSED', ['ROUTE:/checkout'])]),
      withFault: [report([test('t1', 'FAILED'), test('t2', 'PASSED', ['ROUTE:/checkout'])])],
    });
    expect(reading.outcome).toBe('MISSED');
    expect(reading.detectedByTestId).toBeNull();
  });

  it('does not let a quarantined test claim a detection', () => {
    // A quarantined test gates nothing, so its failure cannot be the evidence
    // that the suite caught something.
    const reading = classifyFault({
      fault,
      baseline: report([{ ...test('t1', 'PASSED'), quarantined: true }]),
      withFault: [report([{ ...test('t1', 'FAILED'), quarantined: true }])],
    });
    expect(reading.outcome).toBe('NOT_EXERCISED');
  });

  it('does not let a FLAKY verdict claim a detection', () => {
    // Crediting it would let the detection rate rise as the suite gets less
    // reliable.
    const reading = classifyFault({
      fault,
      baseline: report([test('t1', 'PASSED', ['ROUTE:/checkout'])]),
      withFault: [report([test('t1', 'FLAKY', ['ROUTE:/checkout'])])],
    });
    expect(reading.outcome).toBe('MISSED');
  });

  it('calls it MISSED when a test exercised the surface and passed anyway', () => {
    const reading = classifyFault({
      fault,
      baseline: report([test('t1', 'PASSED', ['ROUTE:/checkout'])]),
      withFault: [report([test('t1', 'PASSED', ['ROUTE:/checkout'])])],
    });
    expect(reading.outcome).toBe('MISSED');
    expect(reading.detail).toContain('assertion is weak');
  });

  it('calls it NOT_EXERCISED, never MISSED, when no test went near the surface', () => {
    // The distinction the whole benchmark exists for: one is an assertion gap
    // and one is a coverage gap, and they have different owners.
    const reading = classifyFault({
      fault,
      baseline: report([test('t1', 'PASSED', ['ROUTE:/other'])]),
      withFault: [report([test('t1', 'PASSED', ['ROUTE:/other'])])],
    });
    expect(reading.outcome).toBe('NOT_EXERCISED');
    expect(reading.outcome).not.toBe('MISSED');
    expect(reading.detail).toContain('COVERAGE gap');
  });

  it('honours alsoAffects when deciding whether anything was exercised', () => {
    const reading = classifyFault({
      fault: { ...fault, alsoAffects: ['NOTIFICATION:order-receipt'] },
      baseline: report([test('t1', 'PASSED', ['NOTIFICATION:order-receipt'])]),
      withFault: [report([test('t1', 'PASSED', ['NOTIFICATION:order-receipt'])])],
    });
    expect(reading.outcome).toBe('MISSED');
  });

  it('refuses to rate anything when the build broke', () => {
    // Every test red for a reason unconnected to the defect. Scoring that as a
    // detection would be the most self-flattering bug this file could contain.
    const reading = classifyFault({
      fault,
      baseline: report([test('t1', 'PASSED')]),
      withFault: [{ ...report([test('t1', 'FAILED')]), buildOk: false }],
    });
    expect(reading.outcome).toBeNull();
    expect(reading.detail).toContain('did not build');
  });

  it('refuses to rate anything when every run was inconclusive', () => {
    const reading = classifyFault({
      fault,
      baseline: report([test('t1', 'PASSED')]),
      withFault: [
        {
          ...report([test('t1', 'FAILED')]),
          inconclusive: true,
          inconclusiveReason: 'the target never answered',
        },
      ],
    });
    expect(reading.outcome).toBeNull();
    expect(reading.detail).toContain('the target never answered');
  });

  it('refuses to split the remainder when the runner cannot attribute exercise', () => {
    // THE HONESTY POINT OF THE WHOLE FILE. Without attribution, MISSED and
    // NOT_EXERCISED are indistinguishable, and either guess is a lie — one
    // blames the assertions for a coverage gap, the other claims a coverage gap
    // on surface the tests do cover.
    const reading = classifyFault({
      fault,
      baseline: { ...report([test('t1', 'PASSED')]), exerciseAttribution: 'UNAVAILABLE' },
      withFault: [{ ...report([test('t1', 'PASSED')]), exerciseAttribution: 'UNAVAILABLE' }],
    });
    expect(reading.outcome).toBeNull();
    expect(reading.detail).toContain('no coverage attribution');
  });

  it('counts the red repetitions of a non-deterministic fault rather than one boolean', () => {
    const flaky: SeededFault = { ...fault, deterministic: false, repetitions: 4 };
    const reading = classifyFault({
      fault: flaky,
      baseline: report([test('t1', 'PASSED')]),
      withFault: [
        report([test('t1', 'PASSED')]),
        report([test('t1', 'FAILED')]),
        report([test('t1', 'PASSED')]),
        report([test('t1', 'FAILED')]),
      ],
    });
    expect(reading.outcome).toBe('DETECTED');
    expect(reading.redRepetitions).toBe(2);
    expect(reading.detail).toContain('2 of 4');
  });

  it('names the same witness on every re-run of the same data', () => {
    // A detection attributed to a different test each time is a detection
    // nobody can reproduce.
    const first = classifyFault({
      fault,
      baseline: report([test('zz', 'PASSED'), test('aa', 'PASSED')]),
      withFault: [report([test('zz', 'FAILED'), test('aa', 'FAILED')])],
    });
    const second = classifyFault({
      fault,
      baseline: report([test('aa', 'PASSED'), test('zz', 'PASSED')]),
      withFault: [report([test('aa', 'FAILED'), test('zz', 'FAILED')])],
    });
    expect(first.detectedByTestId).toBe('aa');
    expect(second.detectedByTestId).toBe(first.detectedByTestId);
  });
});

// ─── The rate ───────────────────────────────────────────────────────────────

describe('faultRatesByClass', () => {
  it('divides by the rated faults only, and states the n', () => {
    const rates = faultRatesByClass([
      reading('A', 'DETECTED'),
      reading('A', 'MISSED'),
      reading('A', 'NOT_EXERCISED'),
      reading('A', null),
    ]);
    expect(rates).toEqual([
      {
        faultClass: 'A',
        detected: 1,
        missed: 1,
        notExercised: 1,
        notRated: 1,
        rated: 2,
        detectionPercent: 50,
      },
    ]);
  });

  it('reports null, not 0, for a class where nothing could be rated', () => {
    const rates = faultRatesByClass([reading('A', 'NOT_EXERCISED'), reading('A', null)]);
    expect(rates[0]?.detectionPercent).toBeNull();
    expect(rates[0]?.detectionPercent).not.toBe(0);
  });

  it('keeps the classes apart instead of blending them', () => {
    // "90% of broken validations and 20% of silent failures" is a finding;
    // "55%" is a marketing number that moves when somebody adds three faults
    // of the class we are good at.
    const rates = faultRatesByClass([
      reading('A', 'DETECTED'),
      reading('B', 'MISSED'),
      reading('B', 'MISSED'),
    ]);
    expect(rates.map((rate) => [rate.faultClass, rate.detectionPercent])).toEqual([
      ['A', 100],
      ['B', 0],
    ]);
  });
});

// ─── The run ────────────────────────────────────────────────────────────────

describe('runBench', () => {
  function demoFiles(): Record<string, string> {
    const files: Record<string, string> = {
      '/app/src/surface.json': readDemo('src/surface.json'),
      '/app/src/faults/catalogue.json': readDemo('src/faults/catalogue.json'),
    };
    for (const fault of REAL_CATALOGUE.faults) {
      for (const edit of fault.edits) files[`/app/${edit.file}`] = readDemo(edit.file);
    }
    return files;
  }

  it('restores every touched file byte-for-byte', async () => {
    const files = demoFiles();
    const store = fakeFiles(files);
    const before = new Map(Object.entries(files));
    const result = await runBench(
      { files: store, runSuite: attributingRunner() },
      { appRoot: '/app', seed: 'seed-1', onlyFaults: [], accuracyOnly: false, detectionOnly: false },
    );
    expect(result.baselineCleanAfter).toBe(true);
    for (const [path, text] of before) expect(store.snapshot().get(path)).toBe(text);
    expect(result.quotable).toBe(true);
  });

  it('actually patches the file while the suite is running', async () => {
    // Without this the harness could pass every other test while never
    // changing a byte — a benchmark that measures nothing and reports a rate.
    const seen: string[] = [];
    const store = fakeFiles(demoFiles());
    await runBench(
      {
        files: store,
        runSuite: {
          run: ({ faultId }) => {
            if (faultId) seen.push(store.snapshot().get('/app/src/store.ts') ?? '');
            return Promise.resolve(report([test('t1', 'PASSED', ['ROUTE:/checkout'])]));
          },
        },
      },
      {
        appRoot: '/app',
        seed: 'seed-1',
        onlyFaults: ['FAULT-TOTAL-TAX-FLOOR'],
        accuracyOnly: false,
        detectionOnly: false,
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('Math.floor(subtotal * TAX_RATE)');
  });

  it('refuses the whole run when a fault is already applied', async () => {
    const files = demoFiles();
    files['/app/src/store.ts'] = files['/app/src/store.ts']!.replace(
      'Math.round(subtotal * TAX_RATE)',
      'Math.floor(subtotal * TAX_RATE)',
    );
    const result = await runBench(
      { files: fakeFiles(files), runSuite: attributingRunner() },
      { appRoot: '/app', seed: 's', onlyFaults: [], accuracyOnly: false, detectionOnly: false },
    );
    expect(result.quotable).toBe(false);
    expect(result.baselineCleanBefore).toBe(false);
    expect(result.finishedAtIso).toBeNull();
    // Every count null, not zero: a refusal is not a result.
    expect(result.detectedCount).toBeNull();
    expect(result.missedCount).toBeNull();
    expect(result.baselineProblems.join(' ')).toContain('ALREADY PRESENT');
  });

  it('restores the tree even when a suite run throws mid-loop', async () => {
    const store = fakeFiles(demoFiles());
    const before = store.snapshot().get('/app/src/store.ts');
    let calls = 0;
    await expect(
      runBench(
        {
          files: store,
          runSuite: {
            run: () => {
              calls += 1;
              if (calls > 1) return Promise.reject(new Error('runner died'));
              return Promise.resolve(report([test('t1', 'PASSED')]));
            },
          },
        },
        { appRoot: '/app', seed: 's', onlyFaults: [], accuracyOnly: false, detectionOnly: false },
      ),
    ).rejects.toThrow('runner died');
    expect(store.snapshot().get('/app/src/store.ts')).toBe(before);
  });

  it('refuses when the tree is not restored, and says the readings are void', async () => {
    const store = fakeFiles(demoFiles());
    const result = await runBench(
      {
        files: {
          read: (path) => store.read(path),
          // A write that silently drops the revert is exactly what a crashed
          // bench leaves behind, and the next person to run the suite has no
          // way to know that is why it is red.
          write: async (path, text) => {
            if (path.endsWith('store.ts') && text.includes('Math.round')) return;
            await store.write(path, text);
          },
        },
        runSuite: attributingRunner(),
        now: () => new Date('2026-10-26T00:00:00.000Z'),
      },
      {
        appRoot: '/app',
        seed: 's',
        onlyFaults: ['FAULT-TOTAL-TAX-FLOOR'],
        accuracyOnly: false,
        detectionOnly: false,
      },
    );
    expect(result.quotable).toBe(false);
    expect(result.baselineCleanAfter).toBe(false);
    expect(result.baselineProblems.join(' ')).toContain('WAS NOT RESTORED');
  });

  it('refuses to run at all against a runner with no attribution', async () => {
    await expect(
      runBench(
        { files: fakeFiles(demoFiles()), runSuite: unattributingRunner() },
        { appRoot: '/app', seed: 's', onlyFaults: [], accuracyOnly: false, detectionOnly: false },
      ),
    ).rejects.toThrow(/cannot tell a weak assertion/);
  });

  it('leaves MISSED and NOT_EXERCISED null in detection-only mode', async () => {
    // Filtering the readings would return 0 for both, and 0 MISSED is the
    // best-looking value this benchmark can produce.
    const result = await runBench(
      { files: fakeFiles(demoFiles()), runSuite: unattributingRunner() },
      { appRoot: '/app', seed: 's', onlyFaults: [], accuracyOnly: false, detectionOnly: true },
    );
    expect(result.detectedCount).toBe(0);
    expect(result.missedCount).toBeNull();
    expect(result.notExercisedCount).toBeNull();
    expect(result.notRatedCount).toBe(REAL_CATALOGUE.faults.length);
    expect(result.persistable).toBe(false);
    expect(result.persistableReason).toContain('inventing two of them');
  });

  it('discloses a fault filter as a cap that bit', async () => {
    const result = await runBench(
      { files: fakeFiles(demoFiles()), runSuite: attributingRunner() },
      {
        appRoot: '/app',
        seed: 's',
        onlyFaults: ['FAULT-TOTAL-TAX-FLOOR'],
        accuracyOnly: false,
        detectionOnly: false,
      },
    );
    expect(result.caveats.join(' ')).toContain(
      `1 of ${REAL_CATALOGUE.faults.length} faults were run`,
    );
    expect(result.caveats.join(' ')).toContain('not comparable with a full run');
  });

  it('discloses the non-deterministic fault by name', async () => {
    const result = await runBench(
      { files: fakeFiles(demoFiles()), runSuite: attributingRunner() },
      { appRoot: '/app', seed: 's', onlyFaults: [], accuracyOnly: false, detectionOnly: false },
    );
    expect(result.caveats.join(' ')).toContain('FAULT-FLAKY-SESSION-REMINT is not reproducible');
  });

  it('says accuracy was not measured when no enumerator was given', async () => {
    const result = await runBench(
      { files: fakeFiles(demoFiles()), runSuite: attributingRunner() },
      { appRoot: '/app', seed: 's', onlyFaults: [], accuracyOnly: false, detectionOnly: false },
    );
    expect(result.comparison).toBeNull();
    expect(result.caveats.join(' ')).toContain('Not measured is not 100%');
  });

  it('runs the accuracy half without touching a single file', async () => {
    const store = fakeFiles(demoFiles());
    const result = await runBench(
      {
        files: {
          read: (path) => store.read(path),
          write: () => Promise.reject(new Error('must not write')),
        },
        runSuite: neverRunner,
        enumerate: () => Promise.resolve(enumerated(['ROUTE:/'])),
      },
      { appRoot: '/app', seed: 's', onlyFaults: [], accuracyOnly: true, detectionOnly: false },
    );
    expect(result.comparison?.recallPercent).not.toBeNull();
    expect(result.detectedCount).toBeNull();
    expect(result.faultCount).toBe(0);
  });

  it('rejects an unknown fault id instead of silently running none', async () => {
    await expect(
      runBench(
        { files: fakeFiles(demoFiles()), runSuite: attributingRunner() },
        {
          appRoot: '/app',
          seed: 's',
          onlyFaults: ['FAULT-NOPE'],
          accuracyOnly: false,
          detectionOnly: false,
        },
      ),
    ).rejects.toThrow(/no such fault: FAULT-NOPE/);
  });
});

// ─── Arguments, adapters and rendering ──────────────────────────────────────

describe('parseBenchArgs', () => {
  it('requires a seed', () => {
    const parsed = parseBenchArgs(['--suite-cmd', 'npm test']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain('--seed is required');
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    // `index.ts`'s lenient parser would let `--sed abc` through, and the run
    // would then have no seed while looking like it did.
    const parsed = parseBenchArgs(['--sed', 'abc']);
    expect(parsed.ok).toBe(false);
  });

  it('requires a suite command unless accuracy-only', () => {
    expect(parseBenchArgs(['--seed', 's']).ok).toBe(false);
    expect(parseBenchArgs(['--seed', 's', '--accuracy-only']).ok).toBe(true);
  });

  it('collects repeated --fault flags', () => {
    const parsed = parseBenchArgs(['--seed', 's', '--accuracy-only', '--fault', 'A', '--fault', 'B']);
    expect(parsed.ok && parsed.options.onlyFaults).toEqual(['A', 'B']);
  });

  it('refuses a flag whose value is another flag', () => {
    const parsed = parseBenchArgs(['--seed', '--accuracy-only']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain('--seed needs a value');
  });
});

describe('surfaceEnumeratorOverHttp', () => {
  it('reports a truncated page as incomplete and says how many more existed', async () => {
    const enumerate = surfaceEnumeratorOverHttp({
      apiUrl: 'https://api.test',
      apiKey: 'k',
      projectId: 'p',
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ item: { key: 'ROUTE:/a' } }],
          total: 400,
          truncated: true,
          snapshot: { caveats: ['the crawl stopped at 60 pages'] },
        }),
      }),
    });
    const result = await enumerate();
    expect(result.complete).toBe(false);
    expect(result.caps).toContain('the crawl stopped at 60 pages');
    // The cap is reported as a COUNT and as a reason: rule 10 asks for both, so
    // "at least N more existed" has to be a number a reader can act on.
    expect(result.caps.join(' ')).toContain('1 of 400');
    expect(result.caps.join(' ')).toContain('at least 399 more');
    expect(result.caps.join(' ')).toContain(`${API_ITEM_LIMIT}-item ceiling`);
  });

  it('infers truncation from a total larger than the page, even without the flag', async () => {
    const enumerate = surfaceEnumeratorOverHttp({
      apiUrl: 'https://api.test',
      apiKey: 'k',
      projectId: 'p',
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ items: [{ item: { key: 'ROUTE:/a' } }], total: 9 }),
      }),
    });
    expect((await enumerate()).complete).toBe(false);
  });

  it('throws rather than reporting an empty enumeration on an API error', async () => {
    // An empty enumeration would read as "every declared item is a false
    // negative", which is a measurement of the HTTP status code.
    const enumerate = surfaceEnumeratorOverHttp({
      apiUrl: 'https://api.test',
      apiKey: 'k',
      projectId: 'p',
      fetch: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    });
    await expect(enumerate()).rejects.toThrow(BenchError);
  });
});

describe('parseJunit', () => {
  it('reads passes, failures and skips, including self-closing cases', () => {
    const outcomes = parseJunit(
      '<testsuite>' +
        '<testcase classname="cart" name="adds a line"/>' +
        '<testcase classname="cart" name="totals"><failure message="x"/></testcase>' +
        '<testcase classname="cart" name="later"><skipped/></testcase>' +
        '</testsuite>',
    );
    expect(outcomes.map((outcome) => [outcome.testId, outcome.status])).toEqual([
      ['cart.adds a line', 'PASSED'],
      ['cart.totals', 'FAILED'],
      ['cart.later', 'SKIPPED'],
    ]);
  });

  it('reports no exercise attribution rather than an empty one', () => {
    // An adapter that returned empty `exercised` arrays as if they were real
    // would make every fault NOT_EXERCISED — a coverage gap on surface the
    // tests do cover, which is the flattering half of the guess.
    const outcomes = parseJunit('<testcase classname="a" name="b"/>');
    expect(outcomes[0]?.exercised).toEqual([]);
  });
});

describe('renderBench', () => {
  it('prints "not measured" where a percentage is null, never a digit', () => {
    const lines = renderBench({
      seed: 's',
      startedAtIso: '2026-10-26T00:00:00.000Z',
      finishedAtIso: null,
      baselineCleanBefore: true,
      baselineCleanAfter: null,
      baselineProblems: [],
      faultCount: 0,
      readings: [],
      rates: [],
      detectedCount: null,
      missedCount: null,
      notExercisedCount: null,
      notRatedCount: null,
      comparison: comparisonOf({ precisionPercent: null, recallPercent: null }),
      gate: null,
      caveats: [],
      quotable: true,
      persistable: false,
      persistableReason: 'no fault was run',
    }).join('\n');
    expect(lines).toContain('precision not measured');
    expect(lines).toContain('recall    not measured');
    expect(lines).not.toMatch(/precision 0%/);
    expect(lines).toContain('NOT PERSISTED');
  });

  it('labels a refused run as unquotable before anything else', () => {
    const lines = renderBench({
      seed: 's',
      startedAtIso: '2026-10-26T00:00:00.000Z',
      finishedAtIso: null,
      baselineCleanBefore: false,
      baselineCleanAfter: null,
      baselineProblems: ['FAULT-X: the patched text is ALREADY PRESENT in a.ts'],
      faultCount: 1,
      readings: [],
      rates: [],
      detectedCount: null,
      missedCount: null,
      notExercisedCount: null,
      notRatedCount: null,
      comparison: null,
      gate: null,
      caveats: [],
      quotable: false,
      persistable: false,
      persistableReason: null,
    });
    expect(lines[2]).toContain('REFUSED');
    expect(lines.join('\n')).toContain('ALREADY PRESENT');
  });
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

function rawItem(key: string): Record<string, unknown> {
  return {
    key,
    kind: key.slice(0, Math.max(0, key.indexOf(':'))) || 'ROUTE',
    compare: 'IDENTITY',
    label: key,
    declaredIn: 'src/index.ts',
    reachable: true,
    unreachableReason: null,
  };
}

function rawFault(): Record<string, unknown> {
  return {
    id: 'FAULT-X',
    class: 'A',
    title: 't',
    breaks: 'b',
    surfaceItemKey: 'ROUTE:/x',
    deterministic: true,
    repetitions: 1,
    edits: [{ file: 'a.ts', find: 'one', replace: 'ONE' }],
  };
}

function rawParsedFault(): SeededFault {
  return {
    id: 'FAULT-X',
    faultClass: 'A',
    title: 't',
    breaks: 'b',
    surfaceItemKey: 'ROUTE:/x',
    alsoAffects: [],
    deterministic: true,
    repetitions: 1,
    nondeterminismNote: null,
    edits: [{ file: 'a.ts', find: 'one', replace: 'ONE' }],
  };
}

function oneFaultCatalogue(edit: { find: string; replace: string }): FaultCatalogue {
  return {
    version: 1,
    application: 'x',
    classes: { A: 'a' },
    faults: [{ ...rawParsedFault(), edits: [{ file: 'a.ts', ...edit }] }],
  };
}

function test(
  id: string,
  status: BenchTestOutcome['status'],
  exercised: readonly string[] = [],
): BenchTestOutcome {
  return { testId: id, name: id, status, exercised, quarantined: false };
}

function report(outcomes: readonly BenchTestOutcome[]): BenchSuiteReport {
  return {
    runId: 'run-1',
    outcomes,
    exerciseAttribution: 'KNOWN',
    buildOk: true,
    inconclusive: false,
    inconclusiveReason: null,
    caveats: [],
  };
}

function reading(
  faultClass: string,
  outcome: 'DETECTED' | 'MISSED' | 'NOT_EXERCISED' | null,
): Parameters<typeof faultRatesByClass>[0][number] {
  return {
    faultId: `F-${faultClass}-${outcome ?? 'NR'}-${Math.random()}`,
    faultClass,
    surfaceItemKey: null,
    outcome,
    detail: 'd',
    detectedByTestId: null,
    repetitions: 1,
    redRepetitions: null,
  };
}

function enumerated(keys: readonly string[]): EnumeratedSurface {
  return { keys, complete: true, caps: [], detectors: [] };
}

function comparisonOf(input: {
  precisionPercent: number | null;
  recallPercent: number | null;
}): ReturnType<typeof compareToGroundTruth> {
  return {
    ...input,
    comparedKeys: 0,
    truePositives: [],
    falsePositives: [],
    falseNegatives: [],
    unreachableFound: [],
    countComparisons: [],
    notChecked: [],
    axesNotDeclared: [],
    declaredCellsByKind: [],
    caps: [],
    comparable: true,
    incomparableReason: null,
  };
}

/** A file store over a plain record, so nothing here touches a real filesystem. */
function fakeFiles(initial: Record<string, string>): BenchFileStore & {
  snapshot: () => Map<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    read: (path) => {
      const text = store.get(path);
      if (text === undefined) return Promise.reject(new Error(`ENOENT ${path}`));
      return Promise.resolve(text);
    },
    write: (path, text) => {
      store.set(path, text);
      return Promise.resolve();
    },
    snapshot: () => new Map(store),
  };
}

/** Passes everything and attributes exercise, so MISSED is reachable. */
function attributingRunner(): BenchSuiteRunner {
  return { run: () => Promise.resolve(report([test('t1', 'PASSED', ['ROUTE:/checkout'])])) };
}

function unattributingRunner(): BenchSuiteRunner {
  return {
    run: () =>
      Promise.resolve({
        ...report([test('t1', 'PASSED')]),
        exerciseAttribution: 'UNAVAILABLE' as const,
      }),
  };
}

const neverRunner: BenchSuiteRunner = {
  run: () => Promise.reject(new Error('the suite must not be run in this test')),
};
