/**
 * Data-driven testing — one test, many cases (§4).
 *
 * Every real suite needs it: thirty discount codes, eight currencies, the
 * boundary values of a form. Without it a team writes thirty near-identical
 * tests that drift apart, or one test with a loop nobody can read a result out
 * of — "the test failed" when what happened is that case 17 failed.
 *
 * So the unit of reporting here is the ROW. A test with a dataset produces one
 * step per row, each with its own status, and a summary that names the failing
 * rows by their key column. `1 of 30 failed` is a different fact from `the test
 * failed`, and it is the one worth knowing.
 *
 * Three properties this module exists to hold:
 *
 *   1. INTERPOLATION IS BY NAME, NEVER BY EVALUATION. A row is org-authored
 *      content — quite possibly a CSV somebody exported from a spreadsheet —
 *      and a template engine that compiles or evaluates it is remote code
 *      execution wearing a test framework's clothes. Substitution here is a
 *      single-pass lookup of `{{name}}` in a plain map. Nothing is compiled,
 *      nothing is evaluated, and the text a substitution inserts is never
 *      rescanned for further placeholders (so a cell containing `{{API_TOKEN}}`
 *      is a literal seven-plus characters, not a key to the vault).
 *
 *   2. A ROW THAT FAILS DOES NOT STOP THE REST. Knowing which four of thirty
 *      currencies round wrong is worth more than thirty aborted runs, and the
 *      information is only there if every row runs.
 *
 *   3. A CONFIGURATION GAP IS NOT A TEST FAILURE. A malformed CSV, a missing
 *      fixture, a dataset with no rows, a range that would generate 100,000
 *      cases — none of those are the application under test misbehaving, and
 *      reporting them as FAILED blames the customer's app for the customer's
 *      spec. They are SKIPPED, with the line number or the count that lets
 *      someone fix it. The same rule cuts the other way and is the more
 *      important half: a dataset that produced nothing may never report PASSED,
 *      because nothing was evaluated. Suppression fails open.
 */

import { FIXTURE_PREFIX, MAX_DATASET_ROWS, datasetSchema } from '@qaai/shared';
import type { DatasetConfig } from '@qaai/shared';

/** The one placeholder form, shared with the API plugin's own interpolation. */
export const PLACEHOLDER_PATTERN = /\{\{(\w+)\}\}/g;

/** Columns the runner will treat as the row's name when the spec did not say. */
const CONVENTIONAL_KEY_COLUMNS = ['case', 'name', 'label', 'key', 'code', 'id'];

/** How many failing row names one summary line will list before it abbreviates. */
const SUMMARY_KEY_LIMIT = 10;

/**
 * A problem with the dataset itself, as opposed to a problem the dataset found.
 *
 * Everything that throws this ends as SKIPPED, never FAILED: the test was not
 * evaluated, and saying otherwise puts a red mark on an application that was
 * never asked a question.
 */
export class DatasetConfigError extends Error {
  /** 1-based source line, when the problem has one (a malformed CSV always does). */
  readonly line: number | null;

  constructor(message: string, line: number | null = null) {
    super(message);
    this.name = 'DatasetConfigError';
    this.line = line;
  }

  /** The message a step or a result carries, with the line number folded in. */
  get detail(): string {
    return this.line === null ? this.message : `${this.message} (line ${this.line})`;
  }
}

// ─── Reading the block off a spec ────────────────────────────────────────────

/** zod issues, flattened far enough that a nested record-key problem is readable. */
function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => {
      const nested = (issue as { issues?: { message: string }[] }).issues;
      const where = issue.path.map(String).join('.') || '(root)';
      const inner = nested?.[0]?.message;
      return inner ? `${where}: ${inner}` : `${where}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Reads the `dataset` block off a RAW spec.
 *
 * Reads the raw spec rather than a plugin's parsed one for the same reason
 * `parseLeakConfig` does: the spec schemas in `@qaai/shared` strip keys they do
 * not know about, so by the time a plugin has its typed spec the block is gone.
 *
 * Returns null when there is no block — that is the default, and it is what
 * every test that existed before this feature gets, byte for byte.
 *
 * A block that is PRESENT but malformed throws. It is never treated as absent:
 * silently running a data-driven test once, with `{{code}}` still in the URL,
 * is the exact suppression this module is supposed to make impossible.
 */
export function parseDatasetConfig(rawSpec: unknown): DatasetConfig | null {
  if (rawSpec === null || typeof rawSpec !== 'object') return null;
  const block = (rawSpec as Record<string, unknown>).dataset;
  if (block === undefined || block === null) return null;

  const parsed = datasetSchema.safeParse(block);
  if (!parsed.success) {
    throw new DatasetConfigError(
      `The dataset block is invalid, so no case was executed — ${describeIssues(parsed.error.issues)}.`,
    );
  }
  return parsed.data;
}

// ─── Interpolation ───────────────────────────────────────────────────────────

/**
 * Substitute `{{name}}` from a flat map. By name, one pass, no evaluation.
 *
 * `String.prototype.replace` with a FUNCTION replacer is load-bearing twice
 * over: it inserts the returned text literally (so `$&` and `$1` in a data cell
 * are not replacement patterns), and it does not rescan what it inserted (so a
 * cell holding `{{DB_PASSWORD}}` stays seven-plus literal characters instead of
 * becoming a second lookup against a bag that contains the vault).
 *
 * An unknown name is left alone, which is the behaviour the API plugin has
 * always had. Data-driven tests do not rely on it: `unresolvedPlaceholders`
 * below refuses the run up front instead, because for a dataset an unknown name
 * is always a typo and always produces thirty identical bogus requests.
 */
export function interpolateByName(input: string, vars: Readonly<Record<string, string>>): string {
  return input.replace(PLACEHOLDER_PATTERN, (whole, name: string) => vars[name] ?? whole);
}

/**
 * Interpolate a JSON body STRUCTURALLY — into string leaves and keys, then
 * serialise.
 *
 * The obvious implementation (`interpolate(JSON.stringify(body), vars)`) splices
 * raw text into an already-serialised document, so a value containing a quote or
 * a backslash either corrupts the body or, worse, adds fields to it: a cell
 * reading `x","admin":true` turns a one-field object into a two-field one. That
 * is data escaping into structure, which is the JSON spelling of injection, and
 * a dataset makes it reachable from a spreadsheet.
 *
 * Walking the value and letting `JSON.stringify` do the escaping closes it. The
 * one deliberate behaviour change: a placeholder can no longer smuggle raw JSON
 * into a body. It never legitimately could — the result was invalid JSON unless
 * the value happened to be a scalar — and the supported way to vary structure is
 * to put the structure in the spec and interpolate its leaves.
 */
export function interpolateJsonValue(
  value: unknown,
  vars: Readonly<Record<string, string>>,
): unknown {
  if (typeof value === 'string') return interpolateByName(value, vars);
  if (Array.isArray(value)) return value.map((item) => interpolateJsonValue(item, vars));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        interpolateByName(key, vars),
        interpolateJsonValue(item, vars),
      ]),
    );
  }
  return value;
}

/**
 * Compare what came back against an expectation a row supplied.
 *
 * Strict JSON equality first, exactly as a hand-written expectation is compared.
 * The widening applies ONLY to a value a placeholder actually filled in, and
 * exists because every cell of a CSV is text: `percent,10` means the number ten,
 * and an expectation engine that answers `"10" is not 10` for it turns the most
 * ordinary dataset there is into thirty false failures. A literal written in the
 * spec keeps byte-for-byte semantics, because there the author chose the type.
 */
export function expectationMatches(got: unknown, want: unknown, fromData: boolean): boolean {
  if (JSON.stringify(got) === JSON.stringify(want)) return true;
  // Scalars only: an object never usefully equals a cell, and stringifying one
  // to find out produces "[object Object]" and a mystery.
  const scalar = typeof got === 'number' || typeof got === 'boolean' || typeof got === 'string';
  return fromData && typeof want === 'string' && scalar && String(got) === want;
}

/** Interpolate, and report whether a placeholder was actually filled in. */
export function interpolateTracked(
  input: string,
  vars: Readonly<Record<string, string>>,
): { text: string; substituted: boolean } {
  let substituted = false;
  const text = input.replace(PLACEHOLDER_PATTERN, (whole, name: string) => {
    const value = vars[name];
    if (value === undefined) return whole;
    substituted = true;
    return value;
  });
  return { text, substituted };
}

/** Every `{{name}}` appearing anywhere in a JSON-ish value, keys included. */
export function collectPlaceholders(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER_PATTERN)) into.add(match[1]!);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPlaceholders(item, into);
    return into;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      collectPlaceholders(key, into);
      collectPlaceholders(item, into);
    }
  }
  return into;
}

/**
 * Names a spec uses that nothing can supply.
 *
 * Only ever applied to data-driven tests. The single most common data-driven
 * mistake is a column named `discount_code` and a URL saying `{{discountCode}}`:
 * every row then requests the literal `/discounts/%7B%7BdiscountCode%7D%7D`,
 * every row 404s, and thirty red rows accuse the application of a bug it does
 * not have. Refusing up front turns that into one sentence naming the
 * placeholder and listing the columns that do exist.
 */
export function unresolvedPlaceholders(
  used: Iterable<string>,
  available: Iterable<string>,
): string[] {
  const have = new Set(available);
  return [...new Set(used)].filter((name) => !have.has(name));
}

// ─── Rows ────────────────────────────────────────────────────────────────────

export interface DatasetRow {
  /** 0-based position in the dataset. */
  index: number;
  /** What a human calls this case — the key column's value, or a fallback. */
  key: string;
  /** Column → value, already flattened to the strings interpolation deals in. */
  values: Readonly<Record<string, string>>;
}

/**
 * A cell as a placeholder value.
 *
 * `null` becomes the empty string rather than the text "null": in a CSV an empty
 * cell and a JSON null are the same statement ("no value here"), and a URL
 * containing the word `null` because a column was blank is a bug report waiting
 * to be filed against the wrong team.
 */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Unreachable through the schema; kept so a hand-built config cannot produce
  // "[object Object]" in a request.
  return JSON.stringify(value);
}

function assertUsableColumn(name: string, where: string, line: number | null): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new DatasetConfigError(
      `${where} has a column named "${name}", which cannot be used as a {{placeholder}} — rename it to start with a letter or underscore and use only letters, digits and underscores`,
      line,
    );
  }
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

interface CsvCell {
  text: string;
  /** Physical line the field started on, for error messages. */
  line: number;
}

/**
 * RFC 4180-ish CSV, with line numbers on every complaint.
 *
 * A malformed CSV is a configuration error and the only thing that makes it
 * fixable in one pass is the line number, so every throw here carries one. The
 * three malformations that actually happen: a quote nobody closed (usually an
 * apostrophe in a product name), stray text after a closing quote, and a row
 * with the wrong number of fields (usually an unescaped comma).
 */
export function parseCsv(
  text: string,
  where = 'the CSV',
): {
  columns: string[];
  rows: Array<Record<string, string>>;
} {
  // A BOM is invisible and would otherwise become part of the first column's
  // name — the classic "why does {{id}} never resolve" hour.
  const input = text.replace(/^\uFEFF/, '');

  const records: CsvCell[][] = [];
  let record: CsvCell[] = [];
  let field = '';
  /** Physical line the pending field began on. */
  let fieldLine = 1;
  let line = 1;
  let quoted = false;
  let quoteOpenedAt = 1;
  /** Whether any character of the pending field has been consumed. */
  let started = false;

  const endField = (): void => {
    record.push({ text: field, line: fieldLine });
    field = '';
    started = false;
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
          continue;
        }
        quoted = false;
        // Anything other than a separator or a line ending after the closing
        // quote means the quoting is wrong, and every field after it is a
        // guess. Say so instead of guessing.
        const next = input[i + 1];
        if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') {
          throw new DatasetConfigError(
            `${where} has text after a closing quote — a quoted field must end at a comma or a line break, and a literal quote inside one is written ""`,
            line,
          );
        }
        continue;
      }
      // A newline inside quotes is data, but it still moves the file's lines.
      if (char === '\n') line += 1;
      field += char;
      continue;
    }

    // Runs for separators too, so an EMPTY field still records where it was.
    if (!started) fieldLine = line;

    if (char === '"' && !started) {
      quoted = true;
      started = true;
      quoteOpenedAt = line;
      continue;
    }
    if (char === ',') {
      endField();
      continue;
    }
    if (char === '\r') {
      // Swallow CRLF as one break; a lone CR is treated the same way.
      if (input[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      continue;
    }
    if (char === '\n') {
      endRecord();
      line += 1;
      continue;
    }
    started = true;
    field += char;
  }

  if (quoted) {
    throw new DatasetConfigError(
      `${where} has a quoted value that is never closed — add the missing " or write an embedded quote as ""`,
      quoteOpenedAt,
    );
  }
  // A trailing newline already ended the last record; anything else leaves one open.
  if (started || field !== '' || record.length > 0) endRecord();

  // Drop wholly blank records (a trailing blank line, a stray one in the middle).
  const meaningful = records.filter((r) => !(r.length === 1 && r[0]!.text.trim() === ''));
  const header = meaningful[0];
  if (!header) {
    throw new DatasetConfigError(`${where} is empty — it needs a header row and at least one row`);
  }

  const columns = header.map((cell) => cell.text.trim());
  const seen = new Set<string>();
  for (const [i, name] of columns.entries()) {
    if (name === '') {
      throw new DatasetConfigError(
        `${where} has an empty column name in position ${i + 1}; every column needs a name to be addressable as a {{placeholder}}`,
        header[i]!.line,
      );
    }
    assertUsableColumn(name, where, header[i]!.line);
    if (seen.has(name)) {
      throw new DatasetConfigError(
        `${where} has two columns named "${name}"; a placeholder cannot mean two things`,
        header[i]!.line,
      );
    }
    seen.add(name);
  }

  const rows = meaningful.slice(1).map((cells) => {
    if (cells.length !== columns.length) {
      throw new DatasetConfigError(
        `${where} has a row with ${cells.length} value(s) where the header declares ${columns.length}; check for an unescaped comma or a missing quote`,
        cells[0]?.line ?? null,
      );
    }
    return Object.fromEntries(columns.map((name, i) => [name, cells[i]!.text]));
  });

  return { columns, rows };
}

// ─── JSON ────────────────────────────────────────────────────────────────────

/** Turn a JSON parse offset into a line number, so a bad fixture reads like a CSV one. */
function lineOfOffset(text: string, offset: number): number {
  return text.slice(0, Math.max(0, offset)).split('\n').length;
}

export function parseJsonRows(
  text: string,
  where = 'the JSON dataset',
): {
  columns: string[];
  rows: Array<Record<string, string>>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // V8 words this three ways: `… (line 3 column 11)`, `… at position 24`, and
    // a snippet form with neither. Take a line where one is offered, derive it
    // from an offset where that is, and settle for the snippet otherwise —
    // whichever it is, the message itself always points at the problem.
    const message = err instanceof Error ? err.message : String(err);
    const atLine = /\bline (\d+)/.exec(message);
    const atOffset = /\bposition (\d+)/.exec(message);
    throw new DatasetConfigError(
      `${where} is not valid JSON — ${message}`,
      atLine ? Number(atLine[1]) : atOffset ? lineOfOffset(text, Number(atOffset[1])) : null,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new DatasetConfigError(
      `${where} must be an array of row objects, e.g. [{"code":"SAVE10","percent":10}]`,
    );
  }

  const columns: string[] = [];
  const rows = parsed.map((entry, i) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DatasetConfigError(
        `${where} has a non-object at position ${i + 1}; every row must be an object of column → value`,
      );
    }
    const row: Record<string, string> = {};
    for (const [name, value] of Object.entries(entry as Record<string, unknown>)) {
      assertUsableColumn(name, where, null);
      if (value !== null && typeof value === 'object') {
        throw new DatasetConfigError(
          `${where} has an object or array in column "${name}" at position ${i + 1}; a {{placeholder}} can only carry a string, number, boolean or null`,
        );
      }
      if (!columns.includes(name)) columns.push(name);
      row[name] = cellToString(value);
    }
    return row;
  });

  return { columns, rows };
}

// ─── Ranges ──────────────────────────────────────────────────────────────────

/** Decimal places, so `0.1` steps accumulate as decimals rather than as float dust. */
function decimals(n: number): number {
  const text = String(n);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

export function expandRange(range: Extract<DatasetConfig, { source: 'range' }>): {
  columns: string[];
  rows: Array<Record<string, string>>;
} {
  const { column, from, to, step } = range;
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(step)) {
    throw new DatasetConfigError(
      `The generated range for "${column}" must use finite numbers; got from=${from}, to=${to}, step=${step}`,
    );
  }
  if (to < from) {
    throw new DatasetConfigError(
      `The generated range for "${column}" counts down (from=${from}, to=${to}) but step is positive, so it would produce no cases; swap from and to`,
    );
  }

  // +1 because both ends are inclusive, and a rounded quotient because
  // (0.3 - 0) / 0.1 is 2.9999999999999996 in binary floating point and a
  // boundary-value dataset that silently drops its last case is worse than
  // useless.
  const span = Number(((to - from) / step).toFixed(9));
  const count = Math.floor(span + 1e-9) + 1;
  refuseOversized(count, `the generated range for "${column}"`);

  const places = Math.max(decimals(from), decimals(step));
  const rows = Array.from({ length: count }, (_, i) => ({
    [column]: Number((from + i * step).toFixed(places)).toString(),
  }));
  return { columns: [column], rows };
}

// ─── Loading ─────────────────────────────────────────────────────────────────

function refuseOversized(count: number, what: string): void {
  if (count > MAX_DATASET_ROWS) {
    throw new DatasetConfigError(
      `${what} would produce ${count.toLocaleString('en-US')} cases, and the limit is ${MAX_DATASET_ROWS.toLocaleString('en-US')} — nothing was executed. Narrow the dataset, or split the test.`,
    );
  }
}

/** JSON when it says so or looks like it; CSV otherwise. */
function chooseFormat(
  path: string,
  declared: 'auto' | 'csv' | 'json',
  text: string,
): 'csv' | 'json' {
  if (declared !== 'auto') return declared;
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.csv')) return 'csv';
  const head = text.trimStart()[0];
  return head === '[' || head === '{' ? 'json' : 'csv';
}

/**
 * Read the dataset the spec asked for, out of the run's test data.
 *
 * Fixtures only — RunContext carries them, keyed by workspace-relative path —
 * and never the worker's filesystem. A dataset is committed alongside the tests
 * that use it, so there is no legitimate case for reading elsewhere, and not
 * having a filesystem path means there is no traversal to get wrong.
 */
export function loadDataset(
  config: DatasetConfig,
  fixtures: Readonly<Record<string, string>> = {},
): DatasetRow[] {
  let columns: string[];
  let raw: Array<Record<string, string>>;

  if (config.source === 'inline') {
    refuseOversized(config.rows.length, 'the inline dataset');
    columns = [...new Set(config.rows.flatMap((row) => Object.keys(row)))];
    raw = config.rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cellToString(v)])),
    );
  } else if (config.source === 'range') {
    ({ columns, rows: raw } = expandRange(config));
  } else {
    // `fixtures/x.csv` and `x.csv` both find the fixture, the same way the
    // contract plugin resolves a pact — a spec written either way works.
    const key =
      config.path in fixtures
        ? config.path
        : `${FIXTURE_PREFIX}${config.path}` in fixtures
          ? `${FIXTURE_PREFIX}${config.path}`
          : null;
    const text = key === null ? undefined : fixtures[key];
    if (text === undefined) {
      throw new DatasetConfigError(
        `No dataset at "${config.path}", so no case was executed — commit the file as test data under ${FIXTURE_PREFIX} and re-run.`,
      );
    }
    const where = `The dataset at ${config.path}`;
    ({ columns, rows: raw } =
      chooseFormat(config.path, config.format, text) === 'json'
        ? parseJsonRows(text, where)
        : parseCsv(text, where));
    refuseOversized(raw.length, where);
  }

  if (raw.length === 0) {
    // Never PASSED. A test whose dataset produced nothing asked the application
    // no questions, and a green tick for it is the most expensive kind of lie.
    throw new DatasetConfigError(
      'The dataset has no rows, so no case was executed. A dataset that produces nothing cannot pass.',
    );
  }
  if (columns.length === 0) {
    throw new DatasetConfigError('The dataset has no columns, so no value could be interpolated.');
  }

  const keyColumn = resolveKeyColumn(config.keyColumn, columns);

  return raw.map((values, index) => {
    // A JSON dataset may have ragged rows; fill the gaps so every row offers
    // every column and a missing cell reads as empty rather than as an
    // unresolved placeholder.
    const filled: Record<string, string> = {};
    for (const column of columns) filled[column] = values[column] ?? '';
    const named = filled[keyColumn]?.trim();
    return { index, key: named ? named : `row ${index + 1}`, values: filled };
  });
}

function resolveKeyColumn(requested: string | undefined, columns: string[]): string {
  if (requested !== undefined) {
    if (!columns.includes(requested)) {
      throw new DatasetConfigError(
        `keyColumn "${requested}" is not a column in the dataset; it has ${columns.map((c) => `"${c}"`).join(', ')}`,
      );
    }
    return requested;
  }
  const lower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  for (const candidate of CONVENTIONAL_KEY_COLUMNS) {
    const hit = lower.get(candidate);
    if (hit !== undefined) return hit;
  }
  return columns[0]!;
}

// ─── Summary ─────────────────────────────────────────────────────────────────

export interface DatasetRowOutcome {
  index: number;
  key: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
}

export interface DatasetSummary {
  total: number;
  passed: number;
  failed: number;
  /** Cases that were not evaluated: a per-row config gap, or a cancelled run. */
  skipped: number;
  /** Named by key column, in dataset order. What a human actually needs. */
  failedKeys: string[];
  skippedKeys: string[];
}

export function summariseDataset(outcomes: readonly DatasetRowOutcome[]): DatasetSummary {
  const failing = outcomes.filter((o) => o.status === 'FAILED');
  const skipped = outcomes.filter((o) => o.status === 'SKIPPED');
  return {
    total: outcomes.length,
    passed: outcomes.filter((o) => o.status === 'PASSED').length,
    failed: failing.length,
    skipped: skipped.length,
    failedKeys: failing.map((o) => o.key),
    skippedKeys: skipped.map((o) => o.key),
  };
}

function nameList(keys: readonly string[]): string {
  const shown = keys.slice(0, SUMMARY_KEY_LIMIT).map((k) => `"${k}"`);
  const rest = keys.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

/**
 * The one line the cockpit shows for a data-driven test.
 *
 * Named cases, not indices: "row 17" means nothing to a human, and `"SAVE10"`
 * means everything to the person who wrote the discount.
 */
export function formatDatasetSummary(summary: DatasetSummary): string {
  const counts = [
    `${summary.passed} passed`,
    `${summary.failed} failed`,
    ...(summary.skipped > 0 ? [`${summary.skipped} not evaluated`] : []),
  ].join(', ');

  const parts = [`${summary.total} case${summary.total === 1 ? '' : 's'}: ${counts}.`];
  if (summary.failedKeys.length > 0) parts.push(`Failing: ${nameList(summary.failedKeys)}.`);
  if (summary.skippedKeys.length > 0) {
    parts.push(`Not evaluated: ${nameList(summary.skippedKeys)}.`);
  }
  return parts.join(' ');
}

/** Step title for one case. Carries the name AND the position, so duplicates stay apart. */
export function rowStepTitle(row: DatasetRow, total: number): string {
  return `case ${row.index + 1} of ${total} — "${row.key}"`;
}
