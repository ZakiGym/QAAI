/**
 * `qaai bench` — the harness that measures the measurer.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * Every other number this product prints is a claim about the customer's
 * application. These are claims about QAAI, and until this file existed there
 * were none: no ground truth, no seeded-fault benchmark, no accuracy figure of
 * any kind. The consequence was not theoretical. A catch-all route literal once
 * produced 100% coverage and survived a whole round, because nothing anywhere
 * was checking the measurement against a known answer.
 *
 * apps/demo is a real application in this repo with a surface small enough to
 * enumerate by hand, and apps/demo/src/surface.json is that enumeration. This
 * file does two things with it:
 *
 *   1. GROUND-TRUTH ACCURACY. Diff what QAAI enumerated against what the
 *      application has, and report PRECISION and RECALL as two separate numbers
 *      with the false positives and the false negatives NAMED.
 *
 *   2. SEEDED-FAULT DETECTION. Switch one defect on at a time from
 *      apps/demo/src/faults/catalogue.json, run the suite, and record whether
 *      the suite noticed — per fault CLASS, never as one blended figure.
 *
 * ── WHY TWO NUMBERS AND NOT AN F-SCORE ──────────────────────────────────────
 *
 * Because the two errors are not symmetric and the blend hides the one that
 * matters:
 *
 *   A FALSE POSITIVE inflates the DENOMINATOR. It makes QAAI look worse than it
 *   is, and the customer who investigates finds a route that does not exist.
 *   Embarrassing, and self-correcting — somebody complains.
 *
 *   A FALSE NEGATIVE inflates the PERCENTAGE. Surface we never enumerated is
 *   surface no test is ever asked for, so the number goes UP for it, silently,
 *   in the direction that flatters the vendor. Nobody complains, because nobody
 *   can see it. That is the lie that sells, and an F-score averages it away
 *   against its opposite.
 *
 * So they are two fields, two floors and two gates, and there is no function in
 * this file that combines them.
 *
 * ── WHY EVERY I/O IS INJECTED ───────────────────────────────────────────────
 *
 * The logic here is the product — which key is a false negative, whether a
 * fault was MISSED or merely NOT_EXERCISED, whether the baseline is clean — and
 * logic is only trustworthy if it is cheap to test. So the enumeration, the
 * suite, the filesystem and the clock all arrive through narrow interfaces
 * defined below, every one of them satisfiable by a plain object. The real
 * adapters are the last section of the file and are deliberately dull.
 *
 * ── Only `import type` from @qaai/shared ────────────────────────────────────
 *
 * Same constraint as runner.ts and commands/coverage.ts: the published CLI has
 * no runtime dependencies, so a value from @qaai/shared cannot be imported
 * here. Where a runtime list is needed it is declared in this file and
 * bench.test.ts asserts it against the shared original through the package
 * entry point — never by reaching across the workspace with a relative path,
 * which compiles, bypasses the barrel, and is a defect nine files in this repo
 * have already committed.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stderr, stdout } from 'node:process';
import type { SurfaceKind } from '@qaai/shared';

// ─── Exit codes ──────────────────────────────────────────────────────────────

/**
 * The product of the command, as far as a pipeline is concerned.
 *
 * Five codes and not two, because the right human response to each is
 * different and in three cases opposite:
 *
 *   BELOW_FLOOR    accuracy regressed. Read the named list.
 *   USAGE          the bench never ran. Nothing can be concluded.
 *   NOT_MEASURED   it ran and there is no floor to compare against yet. See
 *                  {@link GROUND_TRUTH_FLOORS}.
 *   BASELINE_DIRTY the bench REFUSED. A fault was already applied, or a revert
 *                  did not restore the tree, so every reading in the run is
 *                  meaningless. This is not a regression and must not be
 *                  reported as one — a build that goes red here needs a `git
 *                  checkout`, not an investigation into test quality.
 */
export const BENCH_EXIT = {
  OK: 0,
  /** Precision or recall is below its floor. */
  BELOW_FLOOR: 1,
  /** Bad flags, an unreadable declaration, or the enumeration could not be fetched. */
  USAGE: 2,
  /** A floor was asked for and there is no measurement to compare it against. */
  NOT_MEASURED: 3,
  /** The clean baseline was dirty at either end. Every reading is void. */
  BASELINE_DIRTY: 4,
} as const;

export type BenchExit = (typeof BENCH_EXIT)[keyof typeof BENCH_EXIT];

export class BenchError extends Error {
  readonly code: BenchExit;
  constructor(message: string, code: BenchExit = BENCH_EXIT.USAGE, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BenchError';
    this.code = code;
  }
}

// ─── The shared vocabularies, mirrored as runtime values ────────────────────

/*
 * Three lists this file needs at run time and cannot import. Each is checked
 * against its shared original by a named test in bench.test.ts, which imports
 * the schema from '@qaai/shared' and compares `.options` — so a member added to
 * the shared list and not here fails a test instead of silently making a
 * declaration unvalidatable.
 *
 * The schemas are the comparison target rather than the raw `const` arrays
 * because `coverageCellKindSchema` and `faultDetectionOutcomeSchema` ARE on the
 * barrel while `COVERAGE_CELL_KINDS` and `FAULT_DETECTION_OUTCOMES` are not.
 * Comparing against the validator is in fact the stronger test: it is the write
 * path, and a kind the API would refuse is a kind this declaration must not
 * use.
 */

/** Mirrors `coverageCellKindSchema.options`. */
export const BENCH_CELL_KINDS = [
  'PAGE_DEFAULT',
  'PAGE_LOADING',
  'PAGE_EMPTY',
  'PAGE_SLOW',
  'PAGE_INTERSTITIAL',
  'PAGE_REDIRECTED',
  'ERROR_UNAUTHENTICATED',
  'ERROR_FORBIDDEN',
  'ERROR_NOT_FOUND',
  'ERROR_SERVER',
  'ERROR_VALIDATION',
  'DATA_NONE',
  'DATA_ONE',
  'DATA_MANY',
  'DATA_PAGE_BOUNDARY',
  'DATA_MAXIMUM',
  'DATA_MALFORMED',
  'FORM_FIELD',
  'RULE_REQUIRED',
  'RULE_LENGTH',
  'RULE_RANGE',
  'RULE_STEP',
  'RULE_PATTERN',
  'RULE_SEMANTIC',
  'COMPONENT',
  'COMPONENT_DEFAULT',
  'COMPONENT_LOADING',
  'COMPONENT_EMPTY',
  'COMPONENT_ERROR',
  'COMPONENT_FORBIDDEN',
  'COMPONENT_SLOW',
] as const;
export type BenchCellKind = (typeof BENCH_CELL_KINDS)[number];

/** Mirrors `faultDetectionOutcomeSchema.options`. */
export const BENCH_FAULT_OUTCOMES = [
  'DETECTED',
  'MISSED',
  'NOT_EXERCISED',
  'BASELINE_DIRTY',
] as const;
export type BenchFaultOutcome = (typeof BENCH_FAULT_OUTCOMES)[number];

/**
 * The outcomes that belong in a detection RATE, mirroring
 * `RATED_FAULT_OUTCOMES`.
 *
 * NOT_EXERCISED is in neither half of the fraction, which is the arithmetic the
 * whole benchmark turns on: counting it as MISSED blames the assertions for a
 * coverage gap, counting it as DETECTED is fiction, and both are reported as
 * their own numbers beside the rate.
 */
export const BENCH_RATED_OUTCOMES: readonly BenchFaultOutcome[] = ['DETECTED', 'MISSED'];

/**
 * How each axis of the declaration is compared.
 *
 * A `Record` keyed on `SurfaceKind`, so a thirteenth axis landing in
 * @qaai/shared is a compile error in this file rather than an axis the harness
 * silently stops checking. That failure mode is the whole point: a ground-truth
 * comparison that quietly skips a new axis reports a recall of 100% on surface
 * it never looked at.
 */
export const GROUND_TRUTH_AXIS_POLICY: Record<SurfaceKind, GroundTruthAxisPolicy> = {
  ROUTE: 'IDENTITY',
  ENDPOINT: 'IDENTITY',
  AUTH_SURFACE: 'IDENTITY',
  ROLE_CELL: 'IDENTITY',
  NOTIFICATION: 'IDENTITY',
  ERROR_STATE: 'DECLARATION_DECIDES',
  /*
   * COUNT, and not a failure of nerve. `SourceForm.id` is a file path plus the
   * form's INDEX WITHIN THE FILE, so a declaration that matched it would be
   * pinned to the source order of views.ts and would go red the next time
   * somebody moved a function. The count per axis still catches the defect that
   * matters here — an extractor that invents forms, or loses them.
   */
  FORM: 'COUNT',
  /*
   * Declared as nested `states` on the item they belong to, never as top-level
   * items, because `CoverageItemState` is keyed (itemId, stateKey) and a second
   * top-level spelling would be a second denominator for the same cells.
   */
  COMPONENT_STATE: 'NOT_DECLARED',
  DATA_VARIANT: 'NOT_DECLARED',
  DEVICE_LOCALE: 'NOT_DECLARED',
  FLAG_COMBINATION: 'NOT_DECLARED',
  BACKGROUND_JOB: 'DECLARATION_DECIDES',
};

/**
 * What the policy table above can say about an axis.
 *
 * `DECLARATION_DECIDES` exists for the two axes where the answer is per item
 * rather than per kind: the demo declares BACKGROUND_JOB as having no members
 * at all (a positive, checkable claim) and declares its one ERROR_STATE item as
 * NOT_CHECKED with a reason. Hard-coding either here would put a judgement
 * about the demo application into a table about QAAI's axes.
 */
export type GroundTruthAxisPolicy =
  | 'IDENTITY'
  | 'COUNT'
  | 'NOT_DECLARED'
  | 'DECLARATION_DECIDES';

// ─── The declaration ────────────────────────────────────────────────────────

export type DeclaredCompareMode = 'IDENTITY' | 'COUNT' | 'NOT_CHECKED';

export interface DeclaredState {
  stateKey: string;
  cellKind: BenchCellKind;
  reachable: boolean;
  note: string | null;
}

export interface DeclaredField {
  fieldKey: string;
  cellKind: BenchCellKind;
  required: boolean;
  note: string | null;
}

export interface DeclaredItem {
  /** The spelling QAAI's own identity builders produce: `KIND:identity`. */
  key: string;
  kind: SurfaceKind;
  compare: DeclaredCompareMode;
  label: string;
  declaredIn: string;
  /**
   * False for surface the application HAS and cannot be driven. It stays in the
   * declaration because an enumerator that reports it is CORRECT — so precision
   * counts it — and recall does not, because no test could ever reach it. The
   * same rule the product applies to an UNEXERCISABLE item: it stays in the
   * inventory and leaves the denominator, with a reason.
   */
  reachable: boolean;
  unreachableReason: string | null;
  /** Required when `compare` is NOT_CHECKED. A skip with no reason is a skip nobody can audit. */
  notCheckedReason: string | null;
  states: readonly DeclaredState[];
  fields: readonly DeclaredField[];
  /** Repeated renders of one template. Recorded so nobody reconciles 4 against 5. */
  instances: number;
  expectedMissBy: readonly string[];
}

export interface GroundTruth {
  version: number;
  application: string;
  items: readonly DeclaredItem[];
  /** Spellings the application definitively does NOT have. A named false positive. */
  declaredAbsent: readonly string[];
  /** Axis → why this application has no members on it. */
  axesWithNothingToDeclare: Readonly<Record<string, string>>;
  /** Axis → why this declaration leaves it out. Reported NOT_CHECKED, never 0. */
  axesNotDeclared: Readonly<Record<string, string>>;
}

/**
 * The size of the declaration when it landed.
 *
 * EXTEND, DO NOT SHRINK. Deleting an entry is the cheapest possible way to make
 * recall go up, and it leaves no trace in any number — the denominator simply
 * gets smaller and the percentage gets better. So the floor is a constant, a
 * named test asserts the file is at or above it, and lowering it is a reviewed
 * edit with a reason beside it rather than a diff line nobody reads.
 *
 * 54 is the count at the first commit of apps/demo/src/surface.json. If the
 * demo application genuinely loses surface, this number comes down in the same
 * change that removes the source line.
 */
export const GROUND_TRUTH_MIN_ITEMS = 54;

interface RawShape {
  [key: string]: unknown;
}

function asRecord(value: unknown, what: string): RawShape {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BenchError(`${what} must be an object`);
  }
  return value as RawShape;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BenchError(`${what} must be a non-empty string`);
  }
  return value;
}

function asStringOrNull(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, what);
}

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new BenchError(`${what} must be true or false`);
  return value;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new BenchError(`${what} must be an array`);
  return value;
}

function asStringMap(value: unknown, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(asRecord(value ?? {}, what))) {
    // `$why` keys carry the prose. Skipping them here rather than stripping
    // them from the JSON keeps the reason beside the data it explains.
    if (key.startsWith('$')) continue;
    if (typeof raw === 'string') out[key] = raw;
  }
  return out;
}

function cellKind(value: unknown, what: string): BenchCellKind {
  const text = asString(value, what);
  if (!(BENCH_CELL_KINDS as readonly string[]).includes(text)) {
    throw new BenchError(
      `${what}: "${text}" is not a coverage cell kind. A cell the API would refuse is a cell ` +
        'this declaration must not use, so the list here is checked against the write path.',
    );
  }
  return text as BenchCellKind;
}

function surfaceKindOf(value: unknown, what: string): SurfaceKind {
  const text = asString(value, what);
  if (!Object.prototype.hasOwnProperty.call(GROUND_TRUTH_AXIS_POLICY, text)) {
    throw new BenchError(`${what}: "${text}" is not a SurfaceKind`);
  }
  return text as SurfaceKind;
}

/**
 * Reads the declaration, refusing every shape that would make a number a lie.
 *
 * Validation and not trust, even though the file lives in this repo: a
 * declaration with a duplicate key double-counts a hit, one with a NOT_CHECKED
 * item and no reason is an unauditable skip, and one whose key does not start
 * with its own kind can never match an enumerated item — which would read as a
 * false negative for ever and be blamed on the extractor.
 */
export function parseGroundTruth(raw: unknown): GroundTruth {
  const root = asRecord(raw, 'surface.json');
  const items: DeclaredItem[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of asArray(root.items, 'surface.json items').entries()) {
    const row = asRecord(entry, `item ${index}`);
    const key = asString(row.key, `item ${index} key`);
    if (seen.has(key)) {
      throw new BenchError(
        `item ${index}: "${key}" is declared twice. A duplicate counts one enumerated item as ` +
          'two hits and moves recall up for nothing.',
      );
    }
    seen.add(key);

    const kind = surfaceKindOf(row.kind, `${key} kind`);
    if (!key.startsWith(`${kind}:`)) {
      throw new BenchError(
        `${key}: a declared key must begin with its own kind, because that is what ` +
          '`surfaceKey` produces. A key that cannot match reads as a false negative for ever.',
      );
    }

    const compare = asString(row.compare, `${key} compare`) as DeclaredCompareMode;
    if (compare !== 'IDENTITY' && compare !== 'COUNT' && compare !== 'NOT_CHECKED') {
      throw new BenchError(`${key}: compare must be IDENTITY, COUNT or NOT_CHECKED`);
    }
    const notCheckedReason = asStringOrNull(row.notCheckedReason, `${key} notCheckedReason`);
    if (compare === 'NOT_CHECKED' && notCheckedReason === null) {
      throw new BenchError(
        `${key}: NOT_CHECKED with no reason. NOT_CHECKED is a real answer and an unexplained ` +
          'skip is not — a reader cannot tell it from an oversight.',
      );
    }

    const reachable = asBoolean(row.reachable, `${key} reachable`);
    const unreachableReason = asStringOrNull(row.unreachableReason, `${key} unreachableReason`);
    if (!reachable && unreachableReason === null) {
      throw new BenchError(
        `${key}: declared unreachable with no reason. An item that leaves the recall ` +
          'denominator has to say why, or the denominator is editable at will.',
      );
    }

    const states: DeclaredState[] = asArray(row.states ?? [], `${key} states`).map(
      (stateEntry, stateIndex) => {
        const state = asRecord(stateEntry, `${key} state ${stateIndex}`);
        return {
          stateKey: asString(state.stateKey, `${key} state ${stateIndex} stateKey`),
          cellKind: cellKind(state.cellKind, `${key} state ${stateIndex} cellKind`),
          reachable: asBoolean(state.reachable, `${key} state ${stateIndex} reachable`),
          note: asStringOrNull(state.note, `${key} state ${stateIndex} note`),
        };
      },
    );

    const fields: DeclaredField[] = asArray(row.fields ?? [], `${key} fields`).map(
      (fieldEntry, fieldIndex) => {
        const field = asRecord(fieldEntry, `${key} field ${fieldIndex}`);
        return {
          fieldKey: asString(field.fieldKey, `${key} field ${fieldIndex} fieldKey`),
          cellKind: cellKind(field.cellKind, `${key} field ${fieldIndex} cellKind`),
          required: asBoolean(field.required, `${key} field ${fieldIndex} required`),
          note: asStringOrNull(field.note, `${key} field ${fieldIndex} note`),
        };
      },
    );

    items.push({
      key,
      kind,
      compare,
      label: asString(row.label, `${key} label`),
      declaredIn: asString(row.declaredIn, `${key} declaredIn`),
      reachable,
      unreachableReason,
      notCheckedReason,
      states,
      fields,
      instances: typeof row.instances === 'number' ? row.instances : 1,
      expectedMissBy: asArray(row.expectedMissBy ?? [], `${key} expectedMissBy`).map((value, i) =>
        asString(value, `${key} expectedMissBy ${i}`),
      ),
    });
  }

  const absentBlock = asRecord(root.$declaredAbsent ?? {}, 'surface.json $declaredAbsent');
  return {
    version: typeof root.version === 'number' ? root.version : 0,
    application: asString(root.application, 'surface.json application'),
    items,
    declaredAbsent: asArray(absentBlock.keys ?? [], '$declaredAbsent keys').map((value, i) =>
      asString(value, `$declaredAbsent keys ${i}`),
    ),
    axesWithNothingToDeclare: asStringMap(
      root.$axesWithNothingToDeclare,
      '$axesWithNothingToDeclare',
    ),
    axesNotDeclared: asStringMap(root.$axesNotDeclared, '$axesNotDeclared'),
  };
}

// ─── What QAAI enumerated ───────────────────────────────────────────────────

/**
 * The enumeration side of the diff, as a narrow interface.
 *
 * `complete` is the field that stops this from being a vanity metric. The API
 * pages its item list, so a comparison run against a truncated page would see
 * every unreturned key as a false negative and report a recall that is a
 * property of the page size. When `complete` is false the comparison refuses to
 * produce either figure and names the cap — a cap applied without being
 * disclosed is the specific lie rule 10 forbids, and here it would be a cap
 * that moved the headline.
 */
export interface EnumeratedSurface {
  keys: readonly string[];
  /** False when a cap, page size or budget kept keys out of `keys`. */
  complete: boolean;
  /** Every cap that bit, as a sentence with its number in it. */
  caps: readonly string[];
  /** Which extractors ran, so an expected miss can be attributed to one. */
  detectors: readonly string[];
}

export type SurfaceEnumerator = () => Promise<EnumeratedSurface>;

// ─── The comparison ─────────────────────────────────────────────────────────

export interface GroundTruthFalsePositive {
  key: string;
  /**
   * DECLARED_ABSENT is the much more useful finding: the declaration said this
   * spelling does not exist, so the extractor invented it. UNDECLARED might
   * instead be a gap in surface.json, and the two must not be printed as one
   * list.
   */
  cause: 'DECLARED_ABSENT' | 'UNDECLARED';
  detail: string;
}

export interface GroundTruthFalseNegative {
  key: string;
  kind: SurfaceKind;
  declaredIn: string;
  /** Extractors the declaration already expects to miss this. Not an excuse; a note. */
  expectedMissBy: readonly string[];
  detail: string;
}

export interface GroundTruthCountComparison {
  kind: SurfaceKind;
  declaredCount: number;
  enumeratedCount: number;
  /** Instances behind the templates, so 4 is never reconciled against 5. */
  declaredInstances: number;
  reason: string;
}

export interface GroundTruthComparison {
  /** |found ∩ declared-or-unreachable| / |enumerated|. NULL when nothing was enumerated. */
  precisionPercent: number | null;
  /** |found ∩ declared-reachable| / |declared-reachable|. NULL when nothing was declared. */
  recallPercent: number | null;
  comparedKeys: number;
  truePositives: readonly string[];
  falsePositives: readonly GroundTruthFalsePositive[];
  falseNegatives: readonly GroundTruthFalseNegative[];
  /** Declared unreachable AND enumerated: correct, and not a recall hit. */
  unreachableFound: readonly string[];
  countComparisons: readonly GroundTruthCountComparison[];
  notChecked: readonly { key: string; reason: string }[];
  axesNotDeclared: readonly { axis: string; reason: string }[];
  /** Declared cells, by kind, so the dimension round has a target to measure against. */
  declaredCellsByKind: readonly { cellKind: BenchCellKind; count: number }[];
  caps: readonly string[];
  /** False when the enumeration was incomplete. Both percentages are then null. */
  comparable: boolean;
  incomparableReason: string | null;
}

function percent(numerator: number, denominator: number): number | null {
  // NULL, never 0 and never 100, when there is nothing to divide. The same rule
  // `coveragePercent` enforces for the product's own headline.
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Diff the enumeration against the declaration.
 *
 * Pure, and the only place either figure is produced. Four sets come out of it
 * and none is derivable from the others:
 *
 *   truePositives     declared reachable, and enumerated.
 *   falseNegatives    declared reachable, NOT enumerated. The lie that sells.
 *   falsePositives    enumerated, declared nowhere. Inflates the denominator.
 *   unreachableFound  declared UNREACHABLE, and enumerated. Correct of the
 *                     extractor, and deliberately not a recall hit — a test
 *                     could never reach it, so counting it would credit QAAI
 *                     with covering something uncoverable.
 */
export function compareToGroundTruth(input: {
  declared: GroundTruth;
  enumerated: EnumeratedSurface;
}): GroundTruthComparison {
  const { declared, enumerated } = input;
  const enumeratedKeys = new Set(enumerated.keys);

  const identityItems = declared.items.filter((item) => item.compare === 'IDENTITY');
  const reachable = identityItems.filter((item) => item.reachable);
  const unreachable = identityItems.filter((item) => !item.reachable);
  const declaredAnywhere = new Set<string>([
    ...identityItems.map((item) => item.key),
    // A COUNT item's key is still a real spelling of a real thing, so finding
    // it is not an invention. It does not enter recall (its identity is not
    // comparable) and it must not be scored as a false positive either.
    ...declared.items.filter((item) => item.compare !== 'IDENTITY').map((item) => item.key),
  ]);

  const truePositives = reachable
    .filter((item) => enumeratedKeys.has(item.key))
    .map((item) => item.key);
  const unreachableFound = unreachable
    .filter((item) => enumeratedKeys.has(item.key))
    .map((item) => item.key);

  const falseNegatives: GroundTruthFalseNegative[] = reachable
    .filter((item) => !enumeratedKeys.has(item.key))
    .map((item) => ({
      key: item.key,
      kind: item.kind,
      declaredIn: item.declaredIn,
      expectedMissBy: item.expectedMissBy,
      detail:
        `${item.label} — declared in ${item.declaredIn} and not enumerated. ` +
        (item.expectedMissBy.length > 0
          ? `The declaration already expects ${item.expectedMissBy.join(', ')} to miss it, ` +
            'which makes it a known limitation rather than a surprise. It is still counted: a ' +
            'known false negative raises the percentage by exactly as much as an unknown one.'
          : 'Nothing in the declaration expects this to be missed.'),
    }));

  /*
   * Keys whose identity the declaration does not compare are excluded from the
   * precision numerator, the precision DENOMINATOR, and the false-positive
   * list. All three, and the third was a real defect this file's own test
   * caught: scoring the false positives over every enumerated key reported
   * each of the demo's nine forms as "enumerated and appears nowhere in the
   * declaration" — nine findings that are not findings, in the list whose
   * whole value is that every line in it is real. An axis we chose not to
   * score may not move a number OR fill a report in either direction.
   */
  const countKinds = new Set(
    declared.items.filter((item) => item.compare === 'COUNT').map((item) => item.kind),
  );
  const scoredEnumerated = [...enumeratedKeys].filter(
    (key) => !countKinds.has(keyKind(key) as SurfaceKind),
  );

  const absent = new Set(declared.declaredAbsent);
  const falsePositives: GroundTruthFalsePositive[] = scoredEnumerated
    .filter((key) => !declaredAnywhere.has(key))
    .sort()
    .map((key) =>
      absent.has(key)
        ? {
            key,
            cause: 'DECLARED_ABSENT' as const,
            detail:
              `The declaration names "${key}" as a spelling this application does not have. ` +
              'An extractor producing it has invented surface, which inflates the denominator ' +
              'and makes every real percentage look worse than it is.',
          }
        : {
            key,
            cause: 'UNDECLARED' as const,
            detail:
              `"${key}" was enumerated and appears nowhere in the declaration. Either the ` +
              'extractor invented it or surface.json is missing an entry — check the ' +
              'application before blaming either.',
          },
    );

  const precisionHits = scoredEnumerated.filter((key) => declaredAnywhere.has(key)).length;

  const countComparisons: GroundTruthCountComparison[] = [...countKinds]
    .sort()
    .map((kind) => {
      const declaredOfKind = declared.items.filter((item) => item.kind === kind);
      return {
        kind,
        declaredCount: declaredOfKind.length,
        enumeratedCount: [...enumeratedKeys].filter((key) => keyKind(key) === kind).length,
        declaredInstances: declaredOfKind.reduce((sum, item) => sum + item.instances, 0),
        reason:
          GROUND_TRUTH_AXIS_POLICY[kind] === 'COUNT'
            ? 'The identity QAAI produces for this axis is derived from the source layout, not ' +
              'from the application, so it is compared as a count. Reported on its own and ' +
              'never folded into precision or recall — two denominators added together make ' +
              'one meaningless percentage.'
            : 'Declared as a count by surface.json.',
      };
    });

  const cells = new Map<BenchCellKind, number>();
  for (const item of declared.items) {
    for (const state of item.states) cells.set(state.cellKind, (cells.get(state.cellKind) ?? 0) + 1);
    for (const field of item.fields) cells.set(field.cellKind, (cells.get(field.cellKind) ?? 0) + 1);
  }

  const comparable = enumerated.complete;
  const incomparableReason = comparable
    ? null
    : 'The enumeration was incomplete — a cap, page size or budget kept keys out of it. Every ' +
      'key it did not return would read as a false negative, so the figures would be a ' +
      'property of the page size rather than of the extractor. ' +
      (enumerated.caps.length > 0
        ? `Caps that bit: ${enumerated.caps.join('; ')}`
        : 'The enumerator reported no cap by name, which is itself a defect: a cap that bit ' +
          'has to say so.');

  return {
    precisionPercent: comparable ? percent(precisionHits, scoredEnumerated.length) : null,
    recallPercent: comparable ? percent(truePositives.length, reachable.length) : null,
    comparedKeys: scoredEnumerated.length,
    truePositives: truePositives.sort(),
    falsePositives,
    falseNegatives: falseNegatives.sort((left, right) => left.key.localeCompare(right.key)),
    unreachableFound: unreachableFound.sort(),
    countComparisons,
    notChecked: declared.items
      .filter((item) => item.compare === 'NOT_CHECKED')
      .map((item) => ({ key: item.key, reason: item.notCheckedReason ?? '' })),
    axesNotDeclared: Object.entries(declared.axesNotDeclared).map(([axis, reason]) => ({
      axis,
      reason,
    })),
    declaredCellsByKind: BENCH_CELL_KINDS.filter((kind) => cells.has(kind)).map((kind) => ({
      cellKind: kind,
      count: cells.get(kind) ?? 0,
    })),
    caps: enumerated.caps,
    comparable,
    incomparableReason,
  };
}

/** The `KIND` half of a `KIND:identity` key. Empty when the string is not one. */
function keyKind(key: string): string {
  const separator = key.indexOf(':');
  return separator <= 0 ? '' : key.slice(0, separator);
}

// ─── The ratchet ────────────────────────────────────────────────────────────

/**
 * The floors precision and recall are ratcheted against.
 *
 * BOTH ARE NULL, AND THAT IS THE HONEST VALUE TODAY. Nothing has yet run QAAI's
 * enumerator against this declaration — doing so needs a project, a database
 * and a crawl, none of which exist inside a unit test — so there is no measured
 * baseline to ratchet from. A null floor makes the gate report NOT_MEASURED and
 * exit 3. It cannot report a pass.
 *
 * Writing `0` here instead would have been the single worst line in this file:
 * every run would exit 0, the ratchet would look armed, and the first real
 * measurement could be 4% precision without anything going red. NOT MEASURED IS
 * NULL, NEVER 0 — the rule the product applies to the customer's coverage,
 * applied to our own accuracy.
 *
 * Setting them is a deliberate edit, in the same change that records the run
 * the numbers came from. A test asserts a null floor can never pass, so nobody
 * can arm the ratchet by accident and nobody can disarm it by deleting a line.
 */
export const GROUND_TRUTH_FLOORS: {
  readonly precisionPercent: number | null;
  readonly recallPercent: number | null;
} = {
  precisionPercent: null,
  recallPercent: null,
};

export type GroundTruthGateState =
  | 'OK'
  | 'NO_FLOOR'
  | 'NOT_MEASURED'
  | 'PRECISION_BELOW_FLOOR'
  | 'RECALL_BELOW_FLOOR'
  | 'NOT_COMPARABLE';

export interface GroundTruthGate {
  state: GroundTruthGateState;
  code: BenchExit;
  message: string;
}

/**
 * Turn the comparison into an exit code.
 *
 * Recall is checked BEFORE precision when both are below their floors, and the
 * order is deliberate rather than alphabetical: a recall regression is the one
 * that raises the headline percentage, so it is the sentence that has to be at
 * the top of a CI log somebody will read three lines of.
 */
export function evaluateGroundTruthGate(input: {
  comparison: GroundTruthComparison;
  floors?: { precisionPercent: number | null; recallPercent: number | null };
}): GroundTruthGate {
  const floors = input.floors ?? GROUND_TRUTH_FLOORS;
  const { comparison } = input;

  if (!comparison.comparable) {
    return {
      state: 'NOT_COMPARABLE',
      code: BENCH_EXIT.NOT_MEASURED,
      message: `Accuracy was NOT measured. ${comparison.incomparableReason ?? ''}`.trim(),
    };
  }

  if (floors.precisionPercent === null && floors.recallPercent === null) {
    return {
      state: 'NO_FLOOR',
      code: BENCH_EXIT.NOT_MEASURED,
      message:
        'No accuracy floor is set, so this run gates nothing. GROUND_TRUTH_FLOORS in ' +
        'packages/cli/src/bench.ts is null/null because no measurement has been recorded yet, ' +
        'and a floor of 0 would have made every run green while looking armed. Record this ' +
        "run's figures there to arm the ratchet.",
    };
  }

  if (comparison.precisionPercent === null || comparison.recallPercent === null) {
    return {
      state: 'NOT_MEASURED',
      code: BENCH_EXIT.NOT_MEASURED,
      message:
        'A floor is set and there is nothing to divide: ' +
        `${comparison.comparedKeys} enumerated keys, ${comparison.truePositives.length + comparison.falseNegatives.length} ` +
        'declared reachable items. Accuracy was not measured, so it did not drop.',
    };
  }

  if (floors.recallPercent !== null && comparison.recallPercent < floors.recallPercent) {
    return {
      state: 'RECALL_BELOW_FLOOR',
      code: BENCH_EXIT.BELOW_FLOOR,
      message:
        `RECALL ${comparison.recallPercent}% is below the ${floors.recallPercent}% floor. ` +
        `${comparison.falseNegatives.length} declared surface item(s) were not enumerated, and ` +
        'surface QAAI does not enumerate is surface no test is asked for — which moves the ' +
        'coverage percentage UP. The named list is above.',
    };
  }

  if (floors.precisionPercent !== null && comparison.precisionPercent < floors.precisionPercent) {
    return {
      state: 'PRECISION_BELOW_FLOOR',
      code: BENCH_EXIT.BELOW_FLOOR,
      message:
        `PRECISION ${comparison.precisionPercent}% is below the ${floors.precisionPercent}% ` +
        `floor. ${comparison.falsePositives.length} enumerated key(s) are not in the ` +
        'declaration, which inflates the denominator and makes real coverage look worse than ' +
        'it is.',
    };
  }

  return {
    state: 'OK',
    code: BENCH_EXIT.OK,
    message: `Precision ${comparison.precisionPercent}%, recall ${comparison.recallPercent}% — both at or above their floors.`,
  };
}

// ─── The fault catalogue ────────────────────────────────────────────────────

export interface FaultEdit {
  /** Relative to the application root the bench was pointed at. */
  file: string;
  find: string;
  replace: string;
}

export interface SeededFault {
  id: string;
  faultClass: string;
  title: string;
  breaks: string;
  /** The declared surface item this defect lives on. */
  surfaceItemKey: string | null;
  alsoAffects: readonly string[];
  deterministic: boolean;
  /** How many times to run it. >1 only for a fault that is not deterministic. */
  repetitions: number;
  nondeterminismNote: string | null;
  edits: readonly FaultEdit[];
}

export interface FaultCatalogue {
  version: number;
  application: string;
  classes: Readonly<Record<string, string>>;
  faults: readonly SeededFault[];
}

export function parseFaultCatalogue(raw: unknown): FaultCatalogue {
  const root = asRecord(raw, 'catalogue.json');
  const classes = asStringMap(root.$classes, 'catalogue.json $classes');
  const faults: SeededFault[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of asArray(root.faults, 'catalogue.json faults').entries()) {
    const row = asRecord(entry, `fault ${index}`);
    const id = asString(row.id, `fault ${index} id`);
    if (seen.has(id)) {
      throw new BenchError(
        `fault ${index}: "${id}" appears twice. The unique constraint on ` +
          '(benchmarkRunId, faultId) is what stops one fault being counted twice in its class ' +
          'rate, and a duplicate here would break the write before it broke the arithmetic.',
      );
    }
    seen.add(id);

    const faultClass = asString(row.class, `${id} class`);
    if (!Object.prototype.hasOwnProperty.call(classes, faultClass)) {
      throw new BenchError(
        `${id}: class "${faultClass}" has no entry in $classes. The rate is grouped by class, ` +
          'so a class with no definition is a column in the report nobody can interpret.',
      );
    }

    const deterministic = asBoolean(row.deterministic, `${id} deterministic`);
    const repetitions = typeof row.repetitions === 'number' ? row.repetitions : 1;
    if (repetitions < 1) throw new BenchError(`${id}: repetitions must be at least 1`);
    const nondeterminismNote = asStringOrNull(row.nondeterminismNote, `${id} nondeterminismNote`);
    if (!deterministic && nondeterminismNote === null) {
      throw new BenchError(
        `${id}: declared non-deterministic with no note. A benchmark you cannot reproduce from ` +
          'a seed is not a benchmark, so the reason it cannot be has to be in the report.',
      );
    }
    if (!deterministic && repetitions < 2) {
      throw new BenchError(
        `${id}: a non-deterministic fault run once reports a coin toss as a measurement.`,
      );
    }

    const edits = asArray(row.edits, `${id} edits`).map((editEntry, editIndex) => {
      const edit = asRecord(editEntry, `${id} edit ${editIndex}`);
      const find = asString(edit.find, `${id} edit ${editIndex} find`);
      const replace = asString(edit.replace, `${id} edit ${editIndex} replace`);
      if (find === replace) {
        throw new BenchError(
          `${id} edit ${editIndex}: find and replace are identical, so this fault changes ` +
            'nothing and would be scored MISSED against a suite that had nothing to find.',
        );
      }
      return { file: asString(edit.file, `${id} edit ${editIndex} file`), find, replace };
    });
    if (edits.length === 0) throw new BenchError(`${id}: a fault needs at least one edit`);

    faults.push({
      id,
      faultClass,
      title: asString(row.title, `${id} title`),
      breaks: asString(row.breaks, `${id} breaks`),
      surfaceItemKey: asStringOrNull(row.surfaceItemKey, `${id} surfaceItemKey`),
      alsoAffects: asArray(row.alsoAffects ?? [], `${id} alsoAffects`).map((value, i) =>
        asString(value, `${id} alsoAffects ${i}`),
      ),
      deterministic,
      repetitions,
      nondeterminismNote,
      edits,
    });
  }

  return {
    version: typeof root.version === 'number' ? root.version : 0,
    application: asString(root.application, 'catalogue.json application'),
    classes,
    faults,
  };
}

// ─── The clean baseline, which is not optional ──────────────────────────────

export interface BaselineVerdict {
  clean: boolean;
  /** Every reason it is not clean, named. A dirty baseline is a refusal, not a warning. */
  problems: readonly string[];
}

/**
 * Is any fault from this catalogue currently applied?
 *
 * Structural rather than a committed digest, and the choice is load-bearing. An
 * edit's `find` text present exactly once and its `replace` text absent IS the
 * statement "this fault is off" — and it stays true across every unrelated
 * change to the demo application. A digest checked into the catalogue would be
 * stronger and useless: it goes stale the first time somebody fixes a typo in a
 * comment, and a benchmark that is red for a reason unconnected to the
 * benchmark is a benchmark somebody switches off.
 *
 * Pure: it takes the file contents, so the test does not need a filesystem and
 * the real run reads each file exactly once.
 */
export function assertCleanBaseline(
  catalogue: FaultCatalogue,
  files: ReadonlyMap<string, string>,
): BaselineVerdict {
  const problems: string[] = [];
  for (const fault of catalogue.faults) {
    for (const edit of fault.edits) {
      const text = files.get(edit.file);
      if (text === undefined) {
        problems.push(`${fault.id}: ${edit.file} was not read, so its state is unknown.`);
        continue;
      }
      if (text.includes(edit.replace)) {
        problems.push(
          `${fault.id}: the patched text is ALREADY PRESENT in ${edit.file}. A fault left ` +
            'switched on makes every reading in this run meaningless, including the ones about ' +
            'other faults.',
        );
      }
      const occurrences = countOccurrences(text, edit.find);
      if (occurrences === 0) {
        problems.push(
          `${fault.id}: the anchor is no longer in ${edit.file}. The application changed under ` +
            'the catalogue; this fault cannot be attempted.',
        );
      } else if (occurrences > 1) {
        problems.push(
          `${fault.id}: the anchor appears ${occurrences} times in ${edit.file}. An ambiguous ` +
            'patch would seed a different defect from the one described.',
        );
      }
    }
  }
  return { clean: problems.length === 0, problems };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export type FaultApplication =
  | { ok: true; files: ReadonlyMap<string, string> }
  | { ok: false; reason: string };

/**
 * Apply one fault to a snapshot of the files. Pure, all-or-nothing.
 *
 * All-or-nothing matters for the two-edit faults: half of FAULT-SILENT-NO-
 * RECEIPT applied is not a milder defect, it is a syntax error, and a syntax
 * error makes every test red — which this harness would otherwise score as a
 * triumphant DETECTED.
 */
export function applyFault(
  fault: SeededFault,
  files: ReadonlyMap<string, string>,
): FaultApplication {
  const next = new Map(files);
  for (const edit of fault.edits) {
    const text = next.get(edit.file);
    if (text === undefined) return { ok: false, reason: `${edit.file} was not read` };
    if (countOccurrences(text, edit.find) !== 1) {
      return {
        ok: false,
        reason: `the anchor in ${edit.file} does not appear exactly once, so the patch is not safe to apply`,
      };
    }
    next.set(edit.file, text.replace(edit.find, edit.replace));
  }
  return { ok: true, files: next };
}

// ─── What the suite did about it ────────────────────────────────────────────

export type BenchTestStatus = 'PASSED' | 'FAILED' | 'SKIPPED' | 'FLAKY' | 'TIMED_OUT';

export interface BenchTestOutcome {
  /** Stable across runs. The value recorded as `detectedByTestId`. */
  testId: string;
  name: string;
  status: BenchTestStatus;
  /**
   * `CoverageItem` keys this test was OBSERVED to exercise. Empty is a real
   * answer and is not the same as unknown — see
   * {@link BenchSuiteReport.exerciseAttribution}.
   */
  exercised: readonly string[];
  /** A quarantined test gates nothing, so it can neither detect nor fail to. */
  quarantined: boolean;
}

export interface BenchSuiteReport {
  runId: string | null;
  outcomes: readonly BenchTestOutcome[];
  /**
   * KNOWN when `exercised` is real on every outcome. UNAVAILABLE when the
   * runner cannot attribute exercise at all — in which case MISSED and
   * NOT_EXERCISED are indistinguishable and the bench refuses to guess between
   * them rather than reporting the flattering one.
   */
  exerciseAttribution: 'KNOWN' | 'UNAVAILABLE';
  /**
   * False when the application did not build or start. Every test is then red
   * for a reason that has nothing to do with the seeded fault, and scoring that
   * as DETECTED would be the most self-flattering bug this file could contain.
   */
  buildOk: boolean;
  /**
   * True when the run itself cannot be judged: a dead target, a broken login, a
   * runner that never connected. Distinct from `buildOk` because the fixes are
   * different and both poison the reading.
   */
  inconclusive: boolean;
  inconclusiveReason: string | null;
  caveats: readonly string[];
}

export interface BenchSuiteRunner {
  /** Never throws for a red suite — a red suite is the signal, not an error. */
  run(input: { seed: string; faultId: string | null; attempt: number }): Promise<BenchSuiteReport>;
}

export interface FaultReading {
  faultId: string;
  faultClass: string;
  surfaceItemKey: string | null;
  /** NULL when the reading is NOT RATED. The reason is in `detail`. */
  outcome: BenchFaultOutcome | null;
  detail: string;
  detectedByTestId: string | null;
  repetitions: number;
  /** How many repetitions went red. NULL when the fault was not rated. */
  redRepetitions: number | null;
}

function failing(status: BenchTestStatus): boolean {
  // FLAKY is not counted as a detection. A flaky test that went red beside a
  // seeded fault has not demonstrated anything about the fault, and crediting
  // it would let the detection rate rise as the suite gets less reliable.
  return status === 'FAILED' || status === 'TIMED_OUT';
}

/**
 * Did the suite catch this fault?
 *
 * ── THE COMPARISON IS AGAINST THE CLEAN RUN, NOT AGAINST GREEN ──────────────
 *
 * A fault is DETECTED when a test that PASSED IN THE CLEAN BASELINE goes red
 * with the fault applied. Not "some test is red" — that would score a dead
 * target, an expired credential or an already-failing test as a detection, and
 * those are exactly the conditions a CI box is in on a bad day. The product's
 * own rule is the same one: a dead target or a broken login turns into N test
 * failures that poison the pass rate, and a number that cannot tell them from a
 * finding is a number nobody can act on.
 *
 * ── AND THE REMAINDER IS SPLIT, OR IT IS NOT REPORTED ───────────────────────
 *
 * When nothing regressed there are two completely different explanations and
 * only one of them is about the tests:
 *
 *   MISSED          a test exercised the surface and passed anyway. The
 *                   ASSERTION is weak. This is the finding that says the tests
 *                   we have are not good enough.
 *   NOT_EXERCISED   no test touched the surface. A COVERAGE gap. Nothing was
 *                   proved about the assertions either way.
 *
 * Telling them apart needs exercise attribution. Without it the reading is NOT
 * RATED, with the reason, rather than being filed under the more flattering of
 * the two — and `outcome: null` is what makes that unmistakable downstream.
 */
export function classifyFault(input: {
  fault: SeededFault;
  baseline: BenchSuiteReport;
  withFault: readonly BenchSuiteReport[];
}): FaultReading {
  const { fault, baseline, withFault } = input;
  const base: Omit<FaultReading, 'outcome' | 'detail' | 'detectedByTestId' | 'redRepetitions'> = {
    faultId: fault.id,
    faultClass: fault.faultClass,
    surfaceItemKey: fault.surfaceItemKey,
    repetitions: fault.repetitions,
  };
  const notRated = (detail: string): FaultReading => ({
    ...base,
    outcome: null,
    detail,
    detectedByTestId: null,
    redRepetitions: null,
  });

  if (withFault.length === 0) return notRated('the fault was never run');

  const broken = withFault.find((report) => !report.buildOk);
  if (broken) {
    return notRated(
      `the application did not build with ${fault.id} applied, so every test was red for a ` +
        'reason unconnected to the defect. Scoring that as a detection would be the most ' +
        'self-flattering result this benchmark could produce.',
    );
  }

  const judgeable = withFault.filter((report) => !report.inconclusive);
  if (judgeable.length === 0) {
    const reason = withFault.find((r) => r.inconclusiveReason !== null)?.inconclusiveReason;
    return notRated(
      `every run with ${fault.id} applied was inconclusive${reason ? ` — ${reason}` : ''}. ` +
        'A run that could not be judged is not a miss.',
    );
  }

  const baselinePassing = new Map<string, string>();
  for (const outcome of baseline.outcomes) {
    if (outcome.status === 'PASSED' && !outcome.quarantined) {
      baselinePassing.set(outcome.testId, outcome.name);
    }
  }

  const regressions = new Map<string, string>();
  let redRepetitions = 0;
  for (const report of judgeable) {
    const regressedHere = report.outcomes.filter(
      (outcome) =>
        failing(outcome.status) && !outcome.quarantined && baselinePassing.has(outcome.testId),
    );
    if (regressedHere.length > 0) redRepetitions += 1;
    for (const outcome of regressedHere) regressions.set(outcome.testId, outcome.name);
  }

  if (regressions.size > 0) {
    // Sorted so the named witness is the same on every re-run of the same data.
    // A detection attributed to a different test each time is a detection
    // nobody can reproduce.
    const witnesses = [...regressions.entries()].sort(([a], [b]) => a.localeCompare(b));
    const first = witnesses[0]!;
    return {
      ...base,
      outcome: 'DETECTED',
      detectedByTestId: first[0],
      redRepetitions,
      detail:
        `${first[1]} passed on the clean baseline and failed with ${fault.id} applied` +
        (witnesses.length > 1 ? ` (${witnesses.length} tests regressed)` : '') +
        (fault.repetitions > 1
          ? `. Red in ${redRepetitions} of ${judgeable.length} repetition(s)` +
            (fault.nondeterminismNote ? ' — this fault is declared non-deterministic' : '')
          : '') +
        '.',
    };
  }

  if (baseline.exerciseAttribution === 'UNAVAILABLE') {
    return notRated(
      `nothing regressed, and this runner reported no coverage attribution — so there is no way ` +
        `to tell whether a test exercised ${fault.surfaceItemKey ?? 'the surface'} and passed ` +
        'anyway (a weak assertion) or whether no test went near it (a coverage gap). Those are ' +
        'different findings with different owners, and guessing between them is how a ' +
        'benchmark stops being worth running.',
    );
  }

  const surfaces = new Set(
    [fault.surfaceItemKey, ...fault.alsoAffects].filter((key): key is string => key !== null),
  );
  const exercisers = baseline.outcomes.filter(
    (outcome) =>
      outcome.status === 'PASSED' &&
      !outcome.quarantined &&
      outcome.exercised.some((key) => surfaces.has(key)),
  );

  if (exercisers.length === 0) {
    return {
      ...base,
      outcome: 'NOT_EXERCISED',
      detectedByTestId: null,
      redRepetitions,
      detail:
        `no test exercised ${fault.surfaceItemKey ?? 'the surface this fault lives on'}` +
        (surfaces.size > 1 ? ` or any of the ${surfaces.size - 1} surface(s) it also affects` : '') +
        ', so nothing was proved about the assertions either way. This is a COVERAGE gap and is ' +
        'excluded from both halves of the detection rate.',
    };
  }

  return {
    ...base,
    outcome: 'MISSED',
    detectedByTestId: null,
    redRepetitions,
    detail:
      `${exercisers.length} test(s) exercised ${fault.surfaceItemKey ?? 'this surface'} and ` +
      `passed with ${fault.id} applied` +
      (exercisers[0] ? ` (for example ${exercisers[0].name})` : '') +
      '. The surface is covered and the assertion is weak.',
  };
}

// ─── The rate, per class ────────────────────────────────────────────────────

export interface FaultClassRate {
  faultClass: string;
  detected: number;
  missed: number;
  notExercised: number;
  notRated: number;
  /** The n the percentage is over. Always printed beside it. */
  rated: number;
  /** detected / (detected + missed). NULL when nothing was rated. */
  detectionPercent: number | null;
}

/**
 * The detection rate, grouped by class and never blended.
 *
 * There is deliberately no function in this file that returns one overall
 * detection percentage. "We catch 90% of broken validations and 20% of silent
 * failures" is a finding a team acts on; one number is a marketing figure, and
 * it moves when somebody adds three more faults of the class we happen to be
 * good at. The TOTALS (counts, not percentages) are what `BenchmarkRun` stores,
 * because a count can be re-divided and a blended percentage cannot be
 * un-blended.
 */
export function faultRatesByClass(readings: readonly FaultReading[]): FaultClassRate[] {
  const byClass = new Map<string, FaultReading[]>();
  for (const reading of readings) {
    const bucket = byClass.get(reading.faultClass) ?? [];
    bucket.push(reading);
    byClass.set(reading.faultClass, bucket);
  }

  return [...byClass.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([faultClass, group]) => {
      const detected = group.filter((r) => r.outcome === 'DETECTED').length;
      const missed = group.filter((r) => r.outcome === 'MISSED').length;
      const notExercised = group.filter((r) => r.outcome === 'NOT_EXERCISED').length;
      const notRated = group.filter((r) => r.outcome === null).length;
      const rated = detected + missed;
      return {
        faultClass,
        detected,
        missed,
        notExercised,
        notRated,
        rated,
        detectionPercent: percent(detected, rated),
      };
    });
}

// ─── The run ────────────────────────────────────────────────────────────────

export interface BenchFileStore {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
}

export interface BenchDeps {
  files: BenchFileStore;
  runSuite: BenchSuiteRunner;
  /** Injected so the enumeration half can be tested without an API. */
  enumerate?: SurfaceEnumerator;
  now?: () => Date;
}

export interface BenchOptions {
  /** The application root the catalogue's relative paths resolve against. */
  appRoot: string;
  /** Taken as an argument, never generated here: no seed, no benchmark. */
  seed: string;
  /** Run only these fault ids. Empty means all of them, and is disclosed either way. */
  onlyFaults: readonly string[];
  /** Skip the suite entirely and report the ground-truth accuracy only. */
  accuracyOnly: boolean;
  /** Accept a runner with no exercise attribution. The limit is then in the caveats. */
  detectionOnly: boolean;
}

export interface BenchResult {
  seed: string;
  startedAtIso: string;
  /** NULL when the bench refused or crashed — never a timestamp it did not reach. */
  finishedAtIso: string | null;
  baselineCleanBefore: boolean;
  /** NULL when the run never got as far as re-asserting it. */
  baselineCleanAfter: boolean | null;
  baselineProblems: readonly string[];
  faultCount: number;
  readings: readonly FaultReading[];
  rates: readonly FaultClassRate[];
  /** NULL when the bench did not complete. 0 detected is a result; "unfinished" is not. */
  detectedCount: number | null;
  missedCount: number | null;
  notExercisedCount: number | null;
  notRatedCount: number | null;
  comparison: GroundTruthComparison | null;
  gate: GroundTruthGate | null;
  caveats: readonly string[];
  /**
   * False when nothing here may be quoted: the baseline was dirty at either
   * end. Separate from `finishedAtIso` because a bench can finish and still be
   * void.
   */
  quotable: boolean;
  /**
   * Whether this result may be written as a FINISHED `BenchmarkRun`.
   *
   * A third state, and it has to be, because the schema's refinement is right:
   * "a finished bench must report its counts". A detection-only run has two of
   * the three counts genuinely unknown, so it can be printed and must not be
   * persisted as finished — writing 0 for `missedCount` there would be a null
   * that became a zero, and a zero that happens to be the best-looking value.
   */
  persistable: boolean;
  persistableReason: string | null;
}

/**
 * Switch one fault on, run the suite, switch it off, repeat — and refuse to
 * report anything if the tree was not clean at both ends.
 *
 * The revert is in a `finally` per fault AND the whole run re-asserts the
 * baseline at the end, which is belt and braces on purpose: the failure this
 * guards against is a crashed bench leaving a defect in the working tree, and
 * the person who next runs the suite has no way to know that is why it is red.
 */
export async function runBench(deps: BenchDeps, options: BenchOptions): Promise<BenchResult> {
  const now = deps.now ?? (() => new Date());
  const startedAtIso = now().toISOString();
  const caveats: string[] = [];

  const catalogue = parseFaultCatalogue(
    JSON.parse(await deps.files.read(join(options.appRoot, 'src/faults/catalogue.json'))),
  );
  const declared = parseGroundTruth(
    JSON.parse(await deps.files.read(join(options.appRoot, 'src/surface.json'))),
  );
  if (declared.items.length < GROUND_TRUTH_MIN_ITEMS) {
    throw new BenchError(
      `surface.json declares ${declared.items.length} items and the recorded floor is ` +
        `${GROUND_TRUTH_MIN_ITEMS}. EXTEND, DO NOT SHRINK: deleting a declared item is the ` +
        'cheapest way to make recall go up and it leaves no trace in any number. If the demo ' +
        'application really lost surface, lower GROUND_TRUTH_MIN_ITEMS in the same change.',
      BENCH_EXIT.USAGE,
    );
  }

  let comparison: GroundTruthComparison | null = null;
  let gate: GroundTruthGate | null = null;
  if (deps.enumerate) {
    comparison = compareToGroundTruth({ declared, enumerated: await deps.enumerate() });
    gate = evaluateGroundTruthGate({ comparison });
    caveats.push(...comparison.caps);
  } else {
    caveats.push(
      'Ground-truth accuracy was NOT measured in this run: no enumerator was supplied. Not ' +
        'measured is not 100%.',
    );
  }

  const selected = options.onlyFaults.length
    ? catalogue.faults.filter((fault) => options.onlyFaults.includes(fault.id))
    : catalogue.faults;
  if (options.onlyFaults.length) {
    const unknown = options.onlyFaults.filter(
      (id) => !catalogue.faults.some((fault) => fault.id === id),
    );
    if (unknown.length) throw new BenchError(`no such fault: ${unknown.join(', ')}`);
    caveats.push(
      `A FILTER WAS APPLIED: ${selected.length} of ${catalogue.faults.length} faults were run. ` +
        'The rates below are over the filtered set and are not comparable with a full run.',
    );
  }
  for (const fault of selected) {
    if (!fault.deterministic && fault.nondeterminismNote) {
      caveats.push(`${fault.id} is not reproducible from the seed: ${fault.nondeterminismNote}`);
    }
  }

  /*
   * --accuracy-only returns BEFORE the baseline machinery, deliberately. A
   * stale fault anchor is a real problem and it is not THIS run's problem: an
   * accuracy run touches no file, so refusing it because a catalogue entry
   * drifted would make the ground-truth figures unobtainable for a reason
   * unconnected to them. The counts stay NULL — not measured is null, never 0.
   */
  if (options.accuracyOnly) {
    caveats.push(
      'The seeded-fault benchmark was SKIPPED (--accuracy-only), so no detection rate was ' +
        'measured. The three counts are null rather than zero, and no clean baseline was ' +
        'asserted because no file was touched.',
    );
    return {
      seed: options.seed,
      startedAtIso,
      finishedAtIso: now().toISOString(),
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
      comparison,
      gate,
      caveats,
      quotable: comparison !== null,
      persistable: false,
      persistableReason:
        'no fault was run, so there is no benchmark to persist — only the accuracy comparison.',
    };
  }

  const touched = [...new Set(selected.flatMap((f) => f.edits.map((e) => e.file)))].sort();
  const clean = new Map<string, string>();
  for (const file of touched) clean.set(file, await deps.files.read(join(options.appRoot, file)));
  const digestsBefore = digestAll(clean);

  const before = assertCleanBaseline({ ...catalogue, faults: selected }, clean);
  const refused = (problems: readonly string[], after: boolean | null): BenchResult => ({
    seed: options.seed,
    startedAtIso,
    finishedAtIso: null,
    baselineCleanBefore: before.clean,
    baselineCleanAfter: after,
    baselineProblems: problems,
    faultCount: selected.length,
    readings: [],
    rates: [],
    detectedCount: null,
    missedCount: null,
    notExercisedCount: null,
    notRatedCount: null,
    comparison,
    gate,
    caveats,
    quotable: false,
    persistable: false,
    persistableReason:
      'the clean baseline was dirty at one end, so every reading in this run is void.',
  });
  if (!before.clean) return refused(before.problems, null);

  const readings: FaultReading[] = [];
  let baseline: BenchSuiteReport;
  try {
    baseline = await deps.runSuite.run({ seed: options.seed, faultId: null, attempt: 0 });
  } catch (error) {
    throw new BenchError(
      `the clean baseline run failed to execute — ${error instanceof Error ? error.message : String(error)}. ` +
        'Without it nothing can be compared, because a detection IS a regression against the ' +
        'clean run.',
      BENCH_EXIT.USAGE,
      { cause: error },
    );
  }
  caveats.push(...baseline.caveats);

  if (baseline.exerciseAttribution === 'UNAVAILABLE' && !options.detectionOnly) {
    throw new BenchError(
      'This suite runner cannot attribute which surface each test exercised, so the bench ' +
        'cannot tell a weak assertion (MISSED) from a coverage gap (NOT_EXERCISED). Those are ' +
        'different findings with different owners. Pass --detection-only to run anyway and get ' +
        'the DETECTED count alone, with the limit recorded in the caveats — the run is then ' +
        'reported and deliberately not persisted as a finished benchmark, because a finished ' +
        'BenchmarkRun has to report all three counts and two of them would be invented.',
      BENCH_EXIT.USAGE,
    );
  }
  if (options.detectionOnly) {
    caveats.push(
      'DETECTION-ONLY: this runner reported no coverage attribution, so every undetected fault ' +
        'is NOT RATED rather than MISSED or NOT_EXERCISED. The detection counts below are over ' +
        'the rated subset and the unrated count is stated.',
    );
  }

  let after: boolean | null = null;
  const afterProblems: string[] = [];
  try {
    for (const fault of selected) {
      const runs: BenchSuiteReport[] = [];
      const applied = applyFault(fault, clean);
      if (!applied.ok) {
        readings.push({
          faultId: fault.id,
          faultClass: fault.faultClass,
          surfaceItemKey: fault.surfaceItemKey,
          outcome: null,
          detail: `the fault could not be applied: ${applied.reason}`,
          detectedByTestId: null,
          repetitions: fault.repetitions,
          redRepetitions: null,
        });
        caveats.push(`${fault.id} was NOT ATTEMPTED: ${applied.reason}.`);
        continue;
      }

      try {
        for (const [file, text] of applied.files) {
          await deps.files.write(join(options.appRoot, file), text);
        }
        for (let attempt = 1; attempt <= fault.repetitions; attempt += 1) {
          runs.push(await deps.runSuite.run({ seed: options.seed, faultId: fault.id, attempt }));
        }
      } finally {
        // Per fault, not once at the end: a throw in the middle of the loop
        // must not leave the next fault's run reading a doubly-patched tree.
        for (const [file, text] of clean) {
          await deps.files.write(join(options.appRoot, file), text);
        }
      }

      for (const run of runs) caveats.push(...run.caveats);
      readings.push(classifyFault({ fault, baseline, withFault: runs }));
    }
  } finally {
    const reread = new Map<string, string>();
    for (const file of touched) {
      reread.set(file, await deps.files.read(join(options.appRoot, file)));
    }
    const digestsAfter = digestAll(reread);
    const drifted = touched.filter((file) => digestsBefore.get(file) !== digestsAfter.get(file));
    const structural = assertCleanBaseline({ ...catalogue, faults: selected }, reread);
    after = drifted.length === 0 && structural.clean;
    if (!after) {
      afterProblems.push(...structural.problems);
      if (drifted.length) {
        afterProblems.push(
          `These files differ from their pre-bench digest: ${drifted.join(', ')}.`,
        );
      }
      afterProblems.push(
        'THE WORKING TREE WAS NOT RESTORED. Every reading in this run is void, and the next ' +
          'person to run the suite will see failures with no visible cause. Restore the tree ' +
          'before quoting anything.',
      );
      caveats.push(...afterProblems);
    }
  }

  if (after !== true) return refused(afterProblems, after);

  const rates = faultRatesByClass(readings);
  /*
   * In detection-only mode two of the three counts are genuinely unknown, so
   * they are NULL and the run is not persistable. Filtering the readings would
   * return 0 for both — and 0 MISSED is the best-looking value this benchmark
   * can produce, which is exactly why it must not be the value of "we could not
   * tell". `notRatedCount` carries the number instead, where a reader will see
   * it beside the reason.
   */
  const split = baseline.exerciseAttribution === 'KNOWN';
  return {
    seed: options.seed,
    startedAtIso,
    finishedAtIso: now().toISOString(),
    baselineCleanBefore: true,
    baselineCleanAfter: true,
    baselineProblems: [],
    faultCount: selected.length,
    readings,
    rates,
    detectedCount: readings.filter((r) => r.outcome === 'DETECTED').length,
    missedCount: split ? readings.filter((r) => r.outcome === 'MISSED').length : null,
    notExercisedCount: split ? readings.filter((r) => r.outcome === 'NOT_EXERCISED').length : null,
    notRatedCount: readings.filter((r) => r.outcome === null).length,
    comparison,
    gate,
    caveats,
    quotable: true,
    persistable: split,
    persistableReason: split
      ? null
      : 'detection-only: MISSED and NOT_EXERCISED are unknown, and a finished BenchmarkRun has ' +
        'to report all three counts. Persisting this would mean inventing two of them.',
  };
}

function digestAll(files: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [file, text] of files) {
    out.set(file, createHash('sha256').update(text, 'utf8').digest('hex'));
  }
  return out;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function formatPercent(value: number | null): string {
  // There is no code path in this file that substitutes a digit for null.
  return value === null ? 'not measured' : `${value}%`;
}

export function renderBench(result: BenchResult): string[] {
  const lines: string[] = [];
  lines.push(`qaai bench — seed ${result.seed}`);

  if (!result.quotable) {
    lines.push('');
    lines.push('REFUSED — nothing in this run may be quoted.');
    for (const problem of result.baselineProblems) lines.push(`  · ${problem}`);
  }

  const comparison = result.comparison;
  if (comparison) {
    lines.push('');
    lines.push('── Ground-truth accuracy ──');
    lines.push(
      `  precision ${formatPercent(comparison.precisionPercent)}   ` +
        `(${comparison.comparedKeys} enumerated key(s) compared)`,
    );
    lines.push(
      `  recall    ${formatPercent(comparison.recallPercent)}   ` +
        `(${comparison.truePositives.length} of ` +
        `${comparison.truePositives.length + comparison.falseNegatives.length} declared reachable)`,
    );
    if (comparison.incomparableReason) lines.push(`  ! ${comparison.incomparableReason}`);

    if (comparison.falseNegatives.length) {
      lines.push('');
      lines.push(
        `  FALSE NEGATIVES (${comparison.falseNegatives.length}) — declared and not enumerated.`,
      );
      lines.push('  This is the direction that raises the coverage percentage.');
      for (const miss of comparison.falseNegatives) lines.push(`    - ${miss.key}: ${miss.detail}`);
    }
    if (comparison.falsePositives.length) {
      lines.push('');
      lines.push(
        `  FALSE POSITIVES (${comparison.falsePositives.length}) — enumerated and not declared.`,
      );
      for (const extra of comparison.falsePositives) {
        lines.push(`    - [${extra.cause}] ${extra.key}: ${extra.detail}`);
      }
    }
    if (comparison.unreachableFound.length) {
      lines.push('');
      lines.push(
        `  Declared UNREACHABLE and correctly enumerated (${comparison.unreachableFound.length}): ` +
          `${comparison.unreachableFound.join(', ')}. Counted in precision, never in recall.`,
      );
    }
    for (const count of comparison.countComparisons) {
      lines.push('');
      lines.push(
        `  ${count.kind}: declared ${count.declaredCount} (${count.declaredInstances} rendered ` +
          `instance(s)), enumerated ${count.enumeratedCount} — compared as a COUNT. ${count.reason}`,
      );
    }
    for (const skipped of comparison.notChecked) {
      lines.push(`  NOT CHECKED ${skipped.key}: ${skipped.reason}`);
    }
    for (const axis of comparison.axesNotDeclared) {
      lines.push(`  NOT CHECKED axis ${axis.axis}: ${axis.reason}`);
    }
  }

  if (result.readings.length) {
    lines.push('');
    lines.push('── Seeded-fault detection, per class ──');
    for (const rate of result.rates) {
      lines.push(
        `  ${rate.faultClass}: ${formatPercent(rate.detectionPercent)} ` +
          `(${rate.detected} detected / ${rate.rated} rated; ` +
          `${rate.notExercised} not exercised, ${rate.notRated} not rated)`,
      );
    }
    lines.push('');
    for (const reading of result.readings) {
      lines.push(`  [${reading.outcome ?? 'NOT_RATED'}] ${reading.faultId} — ${reading.detail}`);
    }
  }

  if (result.caveats.length || result.persistableReason) {
    lines.push('');
    lines.push('── Caveats ──');
    for (const caveat of result.caveats) lines.push(`  ! ${caveat}`);
    // Printed with the caveats rather than hidden in --json: "this result will
    // not be recorded" is something the person who ran it has to be told.
    if (result.persistableReason) lines.push(`  ! NOT PERSISTED — ${result.persistableReason}`);
  }
  if (result.gate?.message) {
    lines.push('');
    lines.push(result.gate.message);
  }
  return lines;
}

export const BENCH_HELP = `qaai bench — how accurate is QAAI itself?

Usage:
  qaai bench --app <path> --seed <value> [options]

Two measurements, reported separately:

  GROUND-TRUTH ACCURACY  Diffs what QAAI enumerated against what the application
                         declares in <app>/src/surface.json, and reports
                         PRECISION and RECALL as two numbers with the false
                         positives and false negatives named. Never an F-score:
                         a false negative raises the coverage percentage and a
                         false positive lowers it, and averaging them hides the
                         one that flatters us.

  SEEDED-FAULT DETECTION Switches one defect at a time from
                         <app>/src/faults/catalogue.json, runs the suite, and
                         reports the detection rate PER FAULT CLASS. A fault no
                         test exercised is NOT_EXERCISED, never MISSED.

Options:
  --app <path>        Application root (default apps/demo)
  --seed <value>      Required. A benchmark you cannot reproduce is not one.
  --project <id>      The project whose enumeration to diff against the
                      declaration. Without it (or without an API key) the
                      accuracy half is reported as NOT MEASURED, which is not
                      the same as reported at 100%.
  --fault <id>        Run only this fault. Repeatable. Disclosed in the caveats.
  --suite-cmd <cmd>   Shell command that runs the suite and writes JUnit XML
  --junit <path>      Where that command writes it (default junit.xml)
  --accuracy-only     Skip the fault bench entirely
  --detection-only    Accept a runner with no coverage attribution. Every
                      undetected fault is then NOT RATED rather than MISSED,
                      and the run is not persisted as a finished benchmark.
  --json              The whole result as JSON

Exit codes:
  0  both figures at or above their floors, or no floor is set
  1  precision or recall is below its floor
  2  usage error, or the bench never ran
  3  there is nothing to divide, or no floor has been recorded yet. Distinct
     from 1: accuracy did not drop, it was never measured.
  4  THE BASELINE WAS DIRTY. A fault was already applied, or the tree was not
     restored. Every reading is void — this needs a git checkout, not an
     investigation.`;

// ─── The adapters, which are deliberately dull ──────────────────────────────

/** Narrowed to the three members used, so a test hands in a plain object. */
export type BenchFetch = (
  url: string,
  init: { method?: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * The enumeration side, over HTTP.
 *
 * `truncated` is read and honoured rather than ignored, which is the whole
 * reason this adapter is four lines longer than it could be: a truncated page
 * would make every unreturned key look like a false negative, and the recall
 * figure would then be a property of the API's page size.
 */
/** The API's own ceiling on `limit`. Disclosed where it bites, never worked around. */
export const API_ITEM_LIMIT = 1000;

export function surfaceEnumeratorOverHttp(ctx: {
  apiUrl: string;
  apiKey: string;
  projectId: string;
  fetch?: BenchFetch;
}): SurfaceEnumerator {
  return async () => {
    const call: BenchFetch = ctx.fetch ?? fetch;
    /*
     * 1000 is the API's own ceiling on `limit` — asking for more is a 400 after
     * a wasted round trip (MAX_PRINT_LIMIT in commands/coverage.ts). So the cap
     * is OURS to disclose rather than to work around, and `complete: false`
     * below is how it reaches the report. Every status is asked for on purpose:
     * the diff is about what was ENUMERATED, and filtering to UNCOVERED would
     * make every covered route look like a false negative.
     */
    const url =
      `${ctx.apiUrl}/surface/${encodeURIComponent(ctx.projectId)}` +
      `?limit=${API_ITEM_LIMIT}&status=COVERED,UNCOVERED,ASSERTED_NOT_RUN,UNKNOWN,WAIVED`;
    const response = await call(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    if (!response.ok) {
      throw new BenchError(
        `GET /surface/${ctx.projectId} failed with ${response.status}; the enumeration was not read.`,
      );
    }
    const body = (await response.json()) as {
      items?: Array<{ item?: { key?: unknown } }>;
      total?: number;
      truncated?: boolean;
      snapshot?: { caveats?: unknown[] };
    };
    const keys = (body.items ?? [])
      .map((entry) => entry.item?.key)
      .filter((key): key is string => typeof key === 'string');
    const caps = (body.snapshot?.caveats ?? []).map((caveat) => String(caveat));
    const truncated = body.truncated === true || (body.total ?? keys.length) > keys.length;
    return {
      keys,
      complete: !truncated,
      caps: truncated
        ? [
            ...caps,
            `The item list was truncated at the API's ${API_ITEM_LIMIT}-item ceiling: ` +
              `${keys.length} of ${body.total ?? 'an unknown number of'} keys were returned, ` +
              `so at least ${body.total === undefined ? 'one' : body.total - keys.length} more ` +
              'existed. Precision and recall are not reported for this run.',
          ]
        : caps,
      detectors: [],
    };
  };
}

/**
 * A suite runner that shells out and reads JUnit XML.
 *
 * DETECTION-ONLY BY CONSTRUCTION, and it says so in the report rather than in a
 * comment: JUnit carries a name and a failure and has nowhere to put "this test
 * exercised ROUTE:/checkout". So `exerciseAttribution` is UNAVAILABLE, the
 * bench refuses to split the undetected faults between MISSED and
 * NOT_EXERCISED, and the caller has to pass --detection-only to proceed. An
 * adapter that quietly returned empty `exercised` arrays instead would have
 * reported every fault as NOT_EXERCISED — a coverage gap on surface the tests
 * do cover, which is the flattering half of the guess.
 */
export function junitSuiteRunner(options: {
  command: string;
  junitPath: string;
  cwd: string;
  files: BenchFileStore;
  exec?: (command: string, cwd: string) => Promise<{ code: number; stderr: string }>;
}): BenchSuiteRunner {
  const exec = options.exec ?? defaultExec;
  return {
    async run() {
      const { code, stderr: errorText } = await exec(options.command, options.cwd);
      let xml: string;
      try {
        xml = await options.files.read(options.junitPath);
      } catch {
        return {
          runId: null,
          outcomes: [],
          exerciseAttribution: 'UNAVAILABLE',
          // A missing report after a nonzero exit is a run that never produced
          // results, not a run in which everything failed.
          buildOk: code === 0,
          inconclusive: true,
          inconclusiveReason: `the suite wrote no JUnit XML at ${options.junitPath} (exit ${code})`,
          caveats: errorText ? [`suite stderr: ${errorText.slice(0, 400)}`] : [],
        };
      }
      return {
        runId: null,
        outcomes: parseJunit(xml),
        exerciseAttribution: 'UNAVAILABLE',
        buildOk: true,
        inconclusive: false,
        inconclusiveReason: null,
        caveats: [],
      };
    },
  };
}

async function defaultExec(command: string, cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errorText = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      errorText += chunk.toString('utf8');
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stderr: errorText }));
    child.on('error', (error) => resolve({ code: 1, stderr: error.message }));
  });
}

/**
 * Enough of JUnit to tell a pass from a failure.
 *
 * Deliberately not a general XML parser. The identity is `classname.name`
 * because that is the only stable pair JUnit guarantees, and it is what lands in
 * `detectedByTestId` — recorded as a NAME rather than an id, which is why the
 * column is TEXT. A detection attributed to "the fourth test case" would not be
 * reproducible across a reordering.
 */
export function parseJunit(xml: string): BenchTestOutcome[] {
  const outcomes: BenchTestOutcome[] = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = match[1] ?? '';
    const body = match[3] ?? '';
    const name = /\bname="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const classname = /\bclassname="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const id = classname ? `${classname}.${name}` : name;
    if (!id) continue;
    const status: BenchTestStatus = /<(failure|error)\b/.test(body)
      ? 'FAILED'
      : /<skipped\b/.test(body)
        ? 'SKIPPED'
        : 'PASSED';
    outcomes.push({ testId: id, name: id, status, exercised: [], quarantined: false });
  }
  return outcomes;
}

// ─── The command ────────────────────────────────────────────────────────────

export interface BenchContext {
  apiUrl: string;
  apiKey: string;
  json: boolean;
  projectId?: string;
  fetch?: BenchFetch;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

export interface ParsedBenchArgs {
  appRoot: string;
  seed: string;
  onlyFaults: string[];
  accuracyOnly: boolean;
  detectionOnly: boolean;
  suiteCommand: string | null;
  junitPath: string;
  projectId: string | null;
}

/**
 * Strict, like `parseCoverageArgs` and for the same reason: `--sed abc` must not
 * silently produce a benchmark with no seed, because a benchmark with no seed is
 * not reproducible and the whole run is then unquotable.
 */
export function parseBenchArgs(
  args: readonly string[],
): { ok: true; options: ParsedBenchArgs } | { ok: false; message: string } {
  const options: ParsedBenchArgs = {
    appRoot: 'apps/demo',
    seed: '',
    onlyFaults: [],
    accuracyOnly: false,
    detectionOnly: false,
    suiteCommand: null,
    junitPath: 'junit.xml',
    projectId: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    const value = args[index + 1];
    const needsValue = (): string => {
      if (value === undefined || value.startsWith('--')) {
        throw new BenchError(`${flag} needs a value`);
      }
      index += 1;
      return value;
    };
    try {
      switch (flag) {
        case '--app':
          options.appRoot = needsValue();
          break;
        case '--seed':
          options.seed = needsValue();
          break;
        case '--fault':
          options.onlyFaults.push(needsValue());
          break;
        case '--suite-cmd':
          options.suiteCommand = needsValue();
          break;
        case '--junit':
          options.junitPath = needsValue();
          break;
        case '--project':
          options.projectId = needsValue();
          break;
        case '--accuracy-only':
          options.accuracyOnly = true;
          break;
        case '--detection-only':
          options.detectionOnly = true;
          break;
        default:
          return { ok: false, message: `Unknown flag: ${flag}` };
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  if (!options.seed) {
    return {
      ok: false,
      message:
        '--seed is required. A benchmark you cannot reproduce from a seed is not a benchmark, ' +
        'so the seed is taken as an argument and never generated inside the bench.',
    };
  }
  if (!options.accuracyOnly && !options.suiteCommand) {
    return {
      ok: false,
      message: '--suite-cmd is required unless --accuracy-only is given.',
    };
  }
  return { ok: true, options };
}

export async function cmdBench(ctx: BenchContext, args: readonly string[]): Promise<number> {
  const out =
    ctx.out ??
    ((text: string) => {
      stdout.write(text);
    });
  const err =
    ctx.err ??
    ((text: string) => {
      stderr.write(text);
    });

  const parsed = parseBenchArgs(args);
  if (!parsed.ok) {
    err(`${parsed.message}\n\n${BENCH_HELP}\n`);
    return BENCH_EXIT.USAGE;
  }
  const options = parsed.options;

  const files: BenchFileStore = {
    read: (path) => readFile(path, 'utf8'),
    write: (path, text) => writeFile(path, text, 'utf8'),
  };
  const projectId = options.projectId ?? ctx.projectId ?? null;

  let result: BenchResult;
  try {
    result = await runBench(
      {
        files,
        runSuite: options.suiteCommand
          ? junitSuiteRunner({
              command: options.suiteCommand,
              junitPath: options.junitPath,
              cwd: options.appRoot,
              files,
            })
          : refusingRunner,
        enumerate:
          projectId && ctx.apiKey
            ? surfaceEnumeratorOverHttp({
                apiUrl: ctx.apiUrl,
                apiKey: ctx.apiKey,
                projectId,
                fetch: ctx.fetch,
              })
            : undefined,
      },
      {
        appRoot: options.appRoot,
        seed: options.seed,
        onlyFaults: options.onlyFaults,
        accuracyOnly: options.accuracyOnly,
        detectionOnly: options.detectionOnly,
      },
    );
  } catch (error) {
    if (error instanceof BenchError) {
      err(`${error.message}\n`);
      return error.code;
    }
    throw error;
  }

  if (ctx.json) out(`${JSON.stringify(result)}\n`);
  else out(`${renderBench(result).join('\n')}\n`);

  if (!result.quotable) return BENCH_EXIT.BASELINE_DIRTY;
  return result.gate?.code ?? BENCH_EXIT.OK;
}

/** Used when --accuracy-only means no suite will ever be asked for. */
const refusingRunner: BenchSuiteRunner = {
  run: () =>
    Promise.reject(
      new BenchError('no suite command was given, so the suite cannot be run', BENCH_EXIT.USAGE),
    ),
};
