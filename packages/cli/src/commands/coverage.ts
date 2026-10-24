/**
 * `qaai coverage` — the dark-surface report, and the CI gate that acts on it.
 *
 * WHY THIS FILE EXISTS
 *
 * `/surface/:projectId` can already say, by name and with the declaring file,
 * which of a customer's routes, endpoints, forms and auth surfaces no test has
 * ever asserted anything about. Until this command existed that answer lived
 * only in a dashboard somebody had to open, which means it was read once and
 * then never again. A coverage number that nobody is accountable to drifts
 * downward quietly; a coverage number wired to an exit code does not.
 *
 * So this file is two things, and the second one is the product:
 *
 *   1. A printer. The NAMED LIST is the output — 43 routes with the file each
 *      is declared in gets forwarded to someone who can act on it, while a
 *      percentage gets argued about. The percentage is one line above the list.
 *
 *   2. A gate. `--min 80` exits nonzero below the floor, so a build goes red
 *      without any extra scripting. The exit code is the deliverable here, not
 *      the text, which is why the codes are a named table below and have tests
 *      asserting they stay distinct from one another.
 *
 * THE FIVE RULES, AND WHERE EACH ONE IS ENFORCED HERE
 *
 * Every one of these exists because a coverage product's failure mode is being
 * confidently wrong in the direction that flatters the vendor. Breaking one
 * does not produce a cosmetic bug, it produces a number that is a lie.
 *
 *   1. percent NULL ≠ 0 ≠ 100 → {@link formatPercent} prints "not measured
 *      yet" and there is no code path that substitutes a digit for null.
 *   2. ASSERTED_NOT_RUN ≠ COVERED → it is its own column in the summary and in
 *      the per-axis lines, with the shared vocabulary's own wording.
 *   3. UNKNOWN is not a gap → the gap list is driven by the status filter,
 *      which defaults to UNCOVERED, and "cannot tell" is reported in the
 *      summary as a limit on our knowledge rather than listed as untested.
 *   4. An UNMEASURED axis is not 0% → {@link renderUnmeasured} names the axes
 *      QAAI has no extractor for. "We do not measure component states" is a
 *      fact about our product; "0% of your component states are covered" is a
 *      claim about the customer's app that we have no basis for.
 *   5. CAVEATS ARE NOT DECORATION → they print directly under the figure,
 *      before the list, every time, and they are in the --json payload. A CLI
 *      has no tooltips to hide them behind, which is an advantage.
 *
 * WHY THIS FILE TALKS TO HTTP ITSELF
 *
 * `index.ts` has an `apiCall` helper and this file deliberately does not use
 * it: importing index.ts executes it (it calls `main()` at module scope), so a
 * command module that reached for the shared helper would run the CLI twice.
 * `report.ts` and `runner.ts` are self-contained for the same reason. The cost
 * is ~30 lines of fetch handling; the benefit is that the error → exit-code
 * mapping this command is judged on lives in one file and is directly testable.
 *
 * Only `import type` from @qaai/shared, like runner.ts — the published CLI has
 * no runtime dependencies at all (see index.ts), and a type-only import is
 * erased by `verbatimModuleSyntax`. Where a runtime value is needed (labels,
 * axis order) it is declared here as a `Record` keyed by the shared union, so
 * a renamed or added kind is a compile error rather than a missing row, and
 * coverage.test.ts asserts the copies equal the shared originals.
 */

import { stderr, stdout } from 'node:process';
import type {
  SurfaceItemCoverage,
  SurfaceKind,
  SurfaceOrigin,
  SurfaceSnapshot,
  SurfaceStatus,
} from '@qaai/shared';

// ─── Exit codes ──────────────────────────────────────────────────────────────

/**
 * The actual product of this command.
 *
 * A pipeline step has to be able to tell these apart, because the right human
 * response to each is different and in two cases opposite:
 *
 *   BELOW_FLOOR   somebody shipped untested surface. Act on the list.
 *   USAGE         the gate never ran — bad flags, no key, API unreachable. The
 *                 coverage number is unknown and nothing can be concluded from
 *                 this build about it.
 *   NOT_MEASURED  the gate ran and there was nothing to divide. See the long
 *                 note on {@link evaluateGate}.
 *
 * Collapsing USAGE into BELOW_FLOOR — which is what a single nonzero code
 * does — means a team whose API key expired spends an afternoon looking for
 * the coverage regression that never happened.
 */
export const COVERAGE_EXIT = {
  /** Coverage met the floor, or no floor was asked for. */
  OK: 0,
  /** The percentage is below `--min`. The one failure a team asked for. */
  BELOW_FLOOR: 1,
  /** Bad flags, no API key, or the API could not be reached or read. */
  USAGE: 2,
  /** `--min` was given and there is no percentage to compare it against. */
  NOT_MEASURED: 3,
} as const;

export type CoverageExit = (typeof COVERAGE_EXIT)[keyof typeof COVERAGE_EXIT];

// ─── The shared vocabulary, mirrored as runtime values ───────────────────────

/*
 * These four records are the only place this file names a kind, a status or an
 * origin. Each is keyed by the shared union type, so dropping or renaming a
 * member of SurfaceKind in packages/shared fails the typecheck here instead of
 * producing a report with a blank column. Adding one cannot be caught by the
 * compiler for the ORDER array, so coverage.test.ts imports the shared lists at
 * runtime and asserts these cover them — the same mirror-test discipline
 * report.test.ts uses for the Allure and TestRail renderers.
 */

const KIND_LABELS: Record<SurfaceKind, string> = {
  ROUTE: 'Routes',
  ENDPOINT: 'API endpoints',
  FORM: 'Forms',
  AUTH_SURFACE: 'Auth surfaces',
  ROLE_CELL: 'Route × role cells',
  COMPONENT_STATE: 'Component states',
  FLAG_COMBINATION: 'Feature-flag combinations',
  BACKGROUND_JOB: 'Jobs, crons and webhooks',
  NOTIFICATION: 'Emails and notifications',
  ERROR_STATE: 'Error and empty states',
  DEVICE_LOCALE: 'Devices and locales',
  DATA_VARIANT: 'Data variants',
};

const STATUS_LABELS: Record<SurfaceStatus, string> = {
  COVERED: 'covered',
  ASSERTED_NOT_RUN: 'a test exists but has never run',
  UNCOVERED: 'no test',
  UNKNOWN: 'cannot tell',
  WAIVED: 'waived',
};

const ORIGIN_LABELS: Record<SurfaceOrigin, string> = {
  SOURCE_ONLY: 'declared in source, never reached by a crawl',
  CRAWL_ONLY: 'reached by a crawl, never found in source',
  BOTH: 'declared in source and reached by a crawl',
};

/**
 * Worst axis first, and this exact order.
 *
 * It is not "lowest percentage first", which would reorder the report every
 * time a single test landed and make two runs impossible to compare by eye. It
 * is severity: an untested auth surface is a different kind of problem from an
 * untested form, whatever the arithmetic says. It is also the order the API's
 * own `rankUncovered` already uses, and a CLI that listed gaps in a different
 * order from the dashboard would look like a second, disagreeing product.
 */
const KIND_ORDER: readonly SurfaceKind[] = [
  'AUTH_SURFACE',
  'ENDPOINT',
  'ROUTE',
  'FORM',
  'ROLE_CELL',
  'COMPONENT_STATE',
  'FLAG_COMBINATION',
  'BACKGROUND_JOB',
  'NOTIFICATION',
  'ERROR_STATE',
  'DEVICE_LOCALE',
  'DATA_VARIANT',
];

/** Exported for the mirror test, which is the only thing keeping these honest. */
export const COVERAGE_VOCABULARY = {
  KIND_LABELS,
  STATUS_LABELS,
  ORIGIN_LABELS,
  KIND_ORDER,
} as const;

const KINDS = Object.keys(KIND_LABELS) as SurfaceKind[];
const STATUSES = Object.keys(STATUS_LABELS) as SurfaceStatus[];
const ORIGINS = Object.keys(ORIGIN_LABELS) as SurfaceOrigin[];

// ─── The response, as the API returns it ─────────────────────────────────────

/**
 * The persisted snapshot row — NOT a {@link SurfaceSnapshot}.
 *
 * `lastStored` comes straight from the database through `latestSnapshot`, so
 * its columns are flat (`percent`, `fingerprint`) rather than nested under
 * `totals`, and `createdAt` is a JSON date string rather than `createdAtIso`.
 * Typing it as a snapshot would compile and then read `undefined` at run time.
 */
export interface StoredSnapshotRow {
  id: string;
  createdAt: string;
  commitSha: string | null;
  percent: number | null;
  denominator: number;
  covered: number;
  fingerprint: string;
}

/** The body of `GET /surface/:projectId`. */
export interface SurfaceReportResponse {
  projectId: string;
  snapshot: SurfaceSnapshot;
  /** The page. `total` is always the full count — see `truncated`. */
  items: SurfaceItemCoverage[];
  total: number;
  offset: number;
  limit: number;
  truncated: boolean;
  unmeasuredKinds: SurfaceKind[];
  lastStored: StoredSnapshotRow | null;
}

// ─── Options ─────────────────────────────────────────────────────────────────

/** How many items are printed when nothing says otherwise. */
const DEFAULT_PRINT_LIMIT = 50;
/** The API's own cap. Asking for more would 400 after a wasted round trip. */
const MAX_PRINT_LIMIT = 1000;

export interface CoverageOptions {
  projectId: string;
  /** The floor, 0–100. Null when the command is only reporting. */
  min: number | null;
  limit: number;
  kinds: SurfaceKind[] | null;
  statuses: SurfaceStatus[] | null;
  origin: SurfaceOrigin | null;
}

export type ParsedCoverageArgs =
  { ok: true; options: CoverageOptions } | { ok: false; message: string };

const FLAG_LIST = '--project, --min, --limit, --kind, --status, --origin';

/**
 * Argument parsing, strict on purpose.
 *
 * `index.ts`'s `parseFlags` is lenient — an unrecognised flag lands in a record
 * nobody reads — and that is actively dangerous for a gate: `--mim 80` would
 * then exit 0 on a project with no coverage at all, and the build would be
 * green for a reason nobody could see. Every flag here is either understood or
 * a usage error, and `--min` is validated BEFORE any request is made, because a
 * typo should cost a millisecond rather than a round trip whose result is then
 * thrown away.
 */
export function parseCoverageArgs(args: readonly string[]): ParsedCoverageArgs {
  const options: CoverageOptions = {
    projectId: '',
    min: null,
    limit: DEFAULT_PRINT_LIMIT,
    kinds: null,
    statuses: null,
    origin: null,
  };
  let positional: string | null = null;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (!arg.startsWith('--')) {
      // `qaai coverage <projectId>` as well as `--project <id>`, matching
      // `qaai status <runId>`. A second bare word is a mistake, not a list.
      if (positional !== null) {
        return { ok: false, message: `Unexpected argument "${arg}". Flags are ${FLAG_LIST}.` };
      }
      positional = arg;
      continue;
    }

    // Both `--min 80` and `--min=80`: CI YAML is written both ways, and the
    // second form landing as an unknown flag would be a confusing failure.
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    const inline = equals === -1 ? null : arg.slice(equals + 1);
    const take = (): string | null => {
      if (inline !== null) return inline;
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) return null;
      index++;
      return next;
    };

    switch (name) {
      case 'project': {
        const value = take();
        if (value === null || value.trim() === '') {
          return { ok: false, message: '--project needs a project id. Copy it from the app.' };
        }
        options.projectId = value.trim();
        break;
      }
      case 'min': {
        const value = take();
        if (value === null) {
          return {
            ok: false,
            message:
              '--min needs the percentage floor the build must meet, e.g. --min 80. ' +
              'Omit it entirely to print the report without gating.',
          };
        }
        const parsed = parseFloor(value);
        if (parsed.ok === false) return parsed;
        options.min = parsed.value;
        break;
      }
      case 'limit': {
        const value = take();
        if (value === null) {
          return { ok: false, message: `--limit needs a count between 1 and ${MAX_PRINT_LIMIT}.` };
        }
        const count = Number(value.trim() === '' ? NaN : value);
        if (!Number.isInteger(count) || count < 1 || count > MAX_PRINT_LIMIT) {
          return {
            ok: false,
            message: `--limit must be a whole number between 1 and ${MAX_PRINT_LIMIT} — got "${value}". The totals are always the full picture whatever the list holds.`,
          };
        }
        options.limit = count;
        break;
      }
      case 'kind': {
        const parsed = parseEnumList(take(), KINDS, 'kind');
        if (parsed.ok === false) return parsed;
        options.kinds = parsed.value;
        break;
      }
      case 'status': {
        const parsed = parseEnumList(take(), STATUSES, 'status');
        if (parsed.ok === false) return parsed;
        options.statuses = parsed.value;
        break;
      }
      case 'origin': {
        const parsed = parseEnumList(take(), ORIGINS, 'origin');
        if (parsed.ok === false) return parsed;
        // The query takes exactly one origin, so a list here would silently
        // drop everything after the first.
        if (parsed.value.length !== 1) {
          return {
            ok: false,
            message: `--origin takes exactly one value: ${ORIGINS.join(', ')}.`,
          };
        }
        options.origin = parsed.value[0] ?? null;
        break;
      }
      default:
        return {
          ok: false,
          message: `Unknown flag "--${name}". qaai coverage takes ${FLAG_LIST}.`,
        };
    }
  }

  const projectId = options.projectId || positional;
  if (!projectId) {
    return {
      ok: false,
      message: 'Usage: qaai coverage --project <projectId> [--min <percent>]',
    };
  }

  return { ok: true, options: { ...options, projectId } };
}

/** `--min`, validated. A floor outside 0–100 can never be met or missed. */
function parseFloor(raw: string): { ok: true; value: number } | { ok: false; message: string } {
  const text = raw.trim();
  const value = text === '' ? Number.NaN : Number(text);
  if (!Number.isFinite(value)) {
    return {
      ok: false,
      message: `--min must be a number between 0 and 100 — "${raw}" is not a number.`,
    };
  }
  if (value < 0 || value > 100) {
    return {
      ok: false,
      message: `--min must be between 0 and 100 — ${text} is outside that range. A floor above 100 can never be met, and one below 0 can never be missed.`,
    };
  }
  return { ok: true, value };
}

/**
 * A comma-separated enum list, validated here rather than at the API.
 *
 * The API validates these too and 400s with a good message — this is not
 * trusting the client. It is that an unknown filter value answered by an empty
 * list reads as "you have no uncovered endpoints", which is the opposite of the
 * truth, and failing before the request makes that impossible to misread.
 */
function parseEnumList<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  field: string,
): { ok: true; value: T[] } | { ok: false; message: string } {
  if (raw === null || raw.trim() === '') {
    return { ok: false, message: `--${field} needs one or more of: ${allowed.join(', ')}.` };
  }
  const parts = raw
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part.length > 0);
  const unknown = parts.filter((part) => !allowed.includes(part as T));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `Unknown ${field}: ${unknown.join(', ')}. Valid values are ${allowed.join(', ')}.`,
    };
  }
  return { ok: true, value: parts as T[] };
}

/** The query string for `GET /surface/:projectId`. */
export function coverageQueryString(options: CoverageOptions): string {
  const params = new URLSearchParams();
  // `limit` is how many items are PRINTED, so it is also how many are fetched.
  // `total` on the response is the full count either way.
  params.set('limit', String(options.limit));
  if (options.kinds) params.set('kind', options.kinds.join(','));
  if (options.statuses) params.set('status', options.statuses.join(','));
  if (options.origin) params.set('origin', options.origin);
  return params.toString();
}

// ─── The gate ────────────────────────────────────────────────────────────────

export type GateState = 'NO_FLOOR' | 'MET' | 'BELOW_FLOOR' | 'NOT_MEASURED';

export interface GateVerdict {
  state: GateState;
  code: CoverageExit;
  /** A sentence for whoever is looking at a red build. Empty when no floor. */
  message: string;
}

/**
 * `--min` against the figure — including the case the whole feature turns on.
 *
 * WHAT `--min 80` DOES WHEN percent IS NULL, AND WHY
 *
 * Null means the denominator was zero: no source analysis has run, or the
 * extractors found nothing, so there was nothing to divide. Both obvious
 * answers are wrong, and wrong in a way that costs the customer something real:
 *
 *   - PASS treats "we measured nothing" as "everything is fine". That is the
 *     single worst outcome this product can produce. A repository that was
 *     never connected would sail through a `--min 95` gate for months, and the
 *     first person to notice would notice because of an outage.
 *   - FAIL as 0% reads as a coverage regression. The team goes looking for the
 *     tests somebody deleted, and there are none; the number was never
 *     computed. It also makes `--min` impossible to adopt — a new project is
 *     red before anybody has written a line of QAAI config, so the gate gets
 *     removed from the pipeline on day one and never comes back.
 *
 * So: a THIRD exit code. {@link COVERAGE_EXIT.NOT_MEASURED} = 3, distinct from
 * both "below the floor" (1) and "the gate could not run" (2), with a message
 * that names what is missing — the caveats already say which input was absent —
 * and what to do about it. The build goes red, because a gate that cannot
 * measure must not report success; but it goes red with a different number and
 * a different sentence, so nobody debugs the wrong problem.
 *
 * This is the behaviour to defend to a customer whose build went red: we will
 * not tell you that you passed a check we never ran, and we will not tell you
 * your coverage dropped when we never measured it. A pipeline that genuinely
 * wants to tolerate an unmeasured project can key on exit 3 explicitly, which
 * is a decision recorded in their config rather than one we made for them.
 *
 * `percent >= min` passes, so `--min 80` with exactly 80.0% is green: a floor
 * is the lowest acceptable value, and off-by-one flapping at the boundary would
 * be read as flakiness in the gate.
 */
export function evaluateGate(input: {
  min: number | null;
  percent: number | null;
  denominator: number;
  caveats: readonly string[];
  projectId: string;
}): GateVerdict {
  if (input.min === null) return { state: 'NO_FLOOR', code: COVERAGE_EXIT.OK, message: '' };

  if (input.percent === null) {
    // The caveats are the diagnosis, already written in the customer's terms by
    // the inventory. Naming them here is what makes exit 3 actionable instead
    // of merely distinct.
    const missing =
      input.caveats.length > 0
        ? input.caveats.map((caveat) => `  - ${caveat}`).join('\n')
        : '  - Nothing is known about why the inventory is empty.';
    return {
      state: 'NOT_MEASURED',
      code: COVERAGE_EXIT.NOT_MEASURED,
      message:
        `✗ Coverage is not measured yet, so --min ${formatFloor(input.min)} can neither pass nor fail.\n` +
        `  Nothing was in the denominator (${input.denominator} items), so there is no percentage to compare.\n` +
        '  This is exit 3, not 1: your coverage did not drop, it was never computed.\n' +
        '\n  What is missing:\n' +
        `${missing}\n` +
        '\n  How to fix it:\n' +
        '  - Connect the repository and let a source analysis run, so the denominator is what\n' +
        '    your code declares rather than what a crawl happened to reach.\n' +
        `  - Then persist a snapshot: POST /surface/${input.projectId}/recompute\n` +
        '  - To let an unmeasured project through on purpose, treat exit 3 as success in your\n' +
        '    pipeline. We will not do it for you: a gate that cannot measure must not report\n' +
        '    that it passed.',
    };
  }

  if (input.percent < input.min) {
    return {
      state: 'BELOW_FLOOR',
      code: COVERAGE_EXIT.BELOW_FLOOR,
      message:
        `✗ ${formatPercent(input.percent)} is below the --min ${formatFloor(input.min)} floor ` +
        `(${input.denominator} items in the denominator). The named list above is what to act on.`,
    };
  }

  return {
    state: 'MET',
    code: COVERAGE_EXIT.OK,
    message: `✓ ${formatPercent(input.percent)} meets the --min ${formatFloor(input.min)} floor.`,
  };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/**
 * The one place a percentage becomes text.
 *
 * Null is "not measured yet" and never a digit. Rule 1 exists because 0% and
 * 100% are both claims about the customer's application, and an empty
 * denominator is a fact about our own extraction.
 */
export function formatPercent(percent: number | null): string {
  return percent === null ? 'not measured yet' : `${percent.toFixed(1)}%`;
}

/**
 * The floor as the operator wrote it — `80%`, not `80.0%`.
 *
 * Template interpolation already prints 80 as "80" and 79.5 as "79.5", so no
 * branch is needed. This was a ternary with two identical arms.
 */
function formatFloor(min: number): string {
  return `${min}%`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** `file:line`, or an honest sentence when there is no declaring file. */
function declaredAt(item: SurfaceItemCoverage['item']): string {
  if (!item.file) return `no declaring file — ${ORIGIN_LABELS[item.origin]}`;
  return item.line === null ? item.file : `${item.file}:${item.line}`;
}

// ─── The report ──────────────────────────────────────────────────────────────

/**
 * The whole human-readable report, as lines.
 *
 * Built as an array and joined by the caller so the tests can assert on the
 * text without capturing a stream, and so the order of the blocks — figure,
 * caveats, list, per-axis arithmetic, unmeasured axes — is visible in one
 * function rather than scattered across writes.
 */
export function renderCoverageReport(
  payload: SurfaceReportResponse,
  options: CoverageOptions,
): string[] {
  const { snapshot } = payload;
  const totals = snapshot.totals;
  const lines: string[] = [];

  // ─ The figure, with its inputs. One line, above the list, as promised. ─
  //   "0 of 0 covered" alongside a null percentage invites the reader to do the
  //   division we just refused to do, so an empty denominator says what it is.
  lines.push(
    `Surface coverage — ${formatPercent(totals.percent)} · ` +
      (totals.denominator === 0
        ? 'nothing was in the denominator, so there is nothing to divide'
        : `${totals.covered} of ${totals.denominator} measured ${plural(totals.denominator, 'item', 'items')} covered`),
  );
  lines.push(
    `  project ${payload.projectId} · measured ${snapshot.createdAtIso}` +
      `${snapshot.commitSha ? ` · commit ${snapshot.commitSha}` : ''}` +
      ` · ${snapshot.inputs.testCount} ${plural(snapshot.inputs.testCount, 'test', 'tests')}` +
      `${snapshot.inputs.analysisId ? ` · analysis ${snapshot.inputs.analysisId}` : ' · no source analysis'}`,
  );

  // Every state, separately. ASSERTED_NOT_RUN and UNKNOWN are not folded into
  // anything: a test that has never executed has not been shown to assert
  // anything, and an item static analysis cannot read is not a gap.
  lines.push(
    `  ${totals.uncovered} ${STATUS_LABELS.UNCOVERED} · ` +
      `${totals.assertedNotRun} with a test that has never run · ` +
      `${totals.unknown} ${STATUS_LABELS.UNKNOWN} · ` +
      `${totals.waived} ${STATUS_LABELS.WAIVED}`,
  );
  lines.push(
    `  ${totals.declaredNeverReached} ${ORIGIN_LABELS.SOURCE_ONLY} · ` +
      `${totals.reachedNeverDeclared} ${ORIGIN_LABELS.CRAWL_ONLY}`,
  );

  if (totals.unknown > 0) {
    lines.push(
      `  The ${totals.unknown} "${STATUS_LABELS.UNKNOWN}" ${plural(totals.unknown, 'item is', 'items are')} not counted as a gap and not counted as covered — ` +
        'static analysis could not read which item those tests reach. List them with --status UNKNOWN.',
    );
  }

  // ─ Caveats. Rule 5: next to the figure, before the list, never hidden. ─
  lines.push('');
  if (snapshot.caveats.length > 0) {
    lines.push(`What this number could not see (${snapshot.caveats.length}):`);
    for (const caveat of snapshot.caveats) lines.push(`  ! ${caveat}`);
  } else {
    lines.push('No caveats were recorded for this measurement.');
  }

  // ─ The named list, which is the output. ─
  lines.push('');
  lines.push(...renderItemList(payload, options));

  // ─ The arithmetic, per axis, as counts so the division is checkable. ─
  lines.push('');
  lines.push(...renderPerAxis(payload));

  // ─ Rule 4: an axis with no extractor is named, not scored. ─
  const unmeasured = renderUnmeasured(payload.unmeasuredKinds);
  if (unmeasured.length > 0) {
    lines.push('');
    lines.push(...unmeasured);
  }

  return lines;
}

function renderItemList(payload: SurfaceReportResponse, options: CoverageOptions): string[] {
  const lines: string[] = [];
  const statuses = options.statuses;
  const gapsOnly = statuses === null || (statuses.length === 1 && statuses[0] === 'UNCOVERED');

  if (payload.total === 0) {
    lines.push(
      gapsOnly
        ? 'No surface matched — nothing in the inventory is uncovered under these filters.'
        : 'No surface matched these filters.',
    );
    return lines;
  }

  lines.push(
    gapsOnly
      ? `No test has ever asserted anything about ${payload.total} ${plural(payload.total, 'surface', 'surfaces')}:`
      : `${payload.total} ${plural(payload.total, 'surface', 'surfaces')} matched ${statuses?.map((status) => STATUS_LABELS[status]).join(', ')}:`,
  );

  // A mixed-status page is ambiguous without the status on each row; a page
  // that is all one status does not need it repeated 50 times.
  const showStatus = new Set(payload.items.map((entry) => entry.status)).size > 1;

  for (const kind of orderedKinds(payload.items)) {
    const group = payload.items.filter((entry) => entry.item.kind === kind);
    if (group.length === 0) continue;

    const axis = payload.snapshot.totals.byKind.find((row) => row.kind === kind);
    // The group header mixes two sources deliberately: the count is from the
    // page in front of you, the percentage is the axis's full arithmetic.
    const axisNote = axis
      ? ` · axis is ${formatPercent(axis.percent)} covered (${axis.covered} of ${axis.denominator})`
      : '';
    lines.push('');
    lines.push(`  ${KIND_LABELS[kind]} — ${group.length} listed${axisNote}`);

    const width = Math.min(
      44,
      group.reduce((widest, entry) => Math.max(widest, entry.item.label.length), 0),
    );
    for (const entry of group) {
      const status = showStatus ? `[${STATUS_LABELS[entry.status]}] ` : '';
      const marker =
        entry.item.origin === 'SOURCE_ONLY' ? '  (declared in source, never reached)' : '';
      lines.push(
        `    ${status}${pad(entry.item.label, width)}  ${declaredAt(entry.item)}${marker}`,
      );
    }
  }

  // Held back, stated. A report that says 43 while sitting on 200 more is the
  // kind of quiet truncation that makes every other number here untrustworthy.
  const heldBack = payload.total - payload.items.length;
  if (heldBack > 0) {
    lines.push('');
    lines.push(
      `  … ${heldBack} more matching ${plural(heldBack, 'item', 'items')} not shown — printing ${payload.items.length} of ${payload.total}. Raise it with --limit, or narrow with --kind.`,
    );
  }

  return lines;
}

/** The kinds present in a page, in severity order, with anything unknown last. */
function orderedKinds(items: readonly SurfaceItemCoverage[]): SurfaceKind[] {
  const present = new Set(items.map((entry) => entry.item.kind));
  const ordered = KIND_ORDER.filter((kind) => present.has(kind));
  // A kind added to @qaai/shared but not to KIND_ORDER still prints, at the
  // end, rather than vanishing from the report.
  const missing = [...present].filter((kind) => !KIND_ORDER.includes(kind));
  return [...ordered, ...missing];
}

function renderPerAxis(payload: SurfaceReportResponse): string[] {
  const lines = ['Per axis — counts, so you can check the division:'];
  const rows = [...payload.snapshot.totals.byKind].sort(
    (left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind),
  );
  if (rows.length === 0) {
    lines.push('  Nothing in the inventory, so there is no per-axis arithmetic.');
    return lines;
  }

  const width = rows.reduce((widest, row) => Math.max(widest, KIND_LABELS[row.kind].length), 0);
  for (const row of rows) {
    if (!row.measured) {
      // It has items (it would not be in byKind otherwise) but no extractor, so
      // it is reported and deliberately not scored.
      lines.push(
        `  ${pad(KIND_LABELS[row.kind], width)}  not measured — QAAI has no extractor for this axis`,
      );
      continue;
    }
    const percent =
      row.denominator === 0 ? 'not measured (0 items)' : pad(formatPercent(row.percent), 7);
    lines.push(
      `  ${pad(KIND_LABELS[row.kind], width)}  ${percent}  ` +
        `${row.covered} covered · ${row.assertedNotRun} never ran · ${row.uncovered} ${STATUS_LABELS.UNCOVERED} · ` +
        `${row.unknown} ${STATUS_LABELS.UNKNOWN} · ${row.waived} ${STATUS_LABELS.WAIVED} · ` +
        `${row.denominator} in the denominator`,
    );
  }
  return lines;
}

/**
 * Rule 4. The axes QAAI does not look at, named rather than scored or omitted.
 *
 * Omitting them would let a reader assume the four measured axes are the whole
 * surface of their application. Scoring them 0% would be a lie about the
 * customer's app. Naming them is the only honest option, and it is also the
 * sentence a customer comparing us against a vendor who quietly measures only
 * frontend lines deserves to hear.
 */
export function renderUnmeasured(kinds: readonly SurfaceKind[]): string[] {
  if (kinds.length === 0) return [];
  return [
    `Axes QAAI does not measure (${kinds.length}) — not 0%, we do not look at them:`,
    ...kinds.map((kind) => `  · ${KIND_LABELS[kind]}`),
    '  These are absent from the denominator above, so the percentage is over the four axes',
    '  we do extract: auth surfaces, API endpoints, routes and forms.',
  ];
}

/**
 * Whether the stored snapshot still describes this measurement.
 *
 * The fingerprint changes whenever the answer could change, so a mismatch means
 * the dashboard, the trend and anything a previous gate compared against were
 * computed from different inputs than the figure printed above. That is not an
 * error — a GET deliberately never writes a snapshot — but a gate failing on a
 * number nobody can find in the UI is an afternoon lost, so it is said out loud.
 */
export function staleSnapshotNote(
  snapshot: SurfaceSnapshot,
  lastStored: StoredSnapshotRow | null,
  projectId: string,
): string | null {
  if (!lastStored) {
    return (
      'Nothing has been stored for this project yet, so there is no trend to compare against. ' +
      `POST /surface/${projectId}/recompute records one.`
    );
  }
  if (lastStored.fingerprint === snapshot.fingerprint) return null;
  return (
    `The stored snapshot (${lastStored.createdAt}) was computed from different inputs than this report: ` +
    `it reads ${formatPercent(lastStored.percent)} over ${lastStored.denominator} items, this one ` +
    `${formatPercent(snapshot.totals.percent)} over ${snapshot.totals.denominator}. ` +
    'This command gated on the figure computed just now; the dashboard and the trend still show the ' +
    `stored one until POST /surface/${projectId}/recompute persists a new snapshot.`
  );
}

// ─── Transport ───────────────────────────────────────────────────────────────

/** A message already fit to print, carrying the exit code it implies. */
class CoverageError extends Error {
  readonly code: CoverageExit;

  constructor(message: string, code: CoverageExit = COVERAGE_EXIT.USAGE, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CoverageError';
    this.code = code;
  }
}

/**
 * The shape of `fetch` this command needs, and no more.
 *
 * Narrowed to three members so the tests can hand in a stub without
 * constructing a `Response`, and so nothing here can start depending on a
 * browser type the published CLI has no business knowing about. The global
 * `fetch` satisfies it.
 */
export type CoverageFetch = (
  url: string,
  init: { method?: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface CoverageContext {
  apiUrl: string;
  apiKey: string;
  json: boolean;
  /** Injected by the tests; the global `fetch` otherwise. */
  fetch?: CoverageFetch;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

async function fetchReport(
  ctx: CoverageContext,
  options: CoverageOptions,
): Promise<SurfaceReportResponse> {
  if (!ctx.apiKey) {
    throw new CoverageError(
      'No API key. Set QAAI_API_KEY or pass --api-key. The key needs the tests:read scope.',
    );
  }

  const url = `${ctx.apiUrl}/surface/${encodeURIComponent(options.projectId)}?${coverageQueryString(options)}`;
  // No cast: the global `fetch` is assignable to CoverageFetch as written, and
  // keeping it that way is what proves the narrowed type is a real subset.
  const call: CoverageFetch = ctx.fetch ?? fetch;

  let response: Awaited<ReturnType<CoverageFetch>>;
  try {
    response = await call(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
  } catch (error) {
    // Exit 2, never 1. A build that went red because the API was unreachable
    // must not look like a build that went red because coverage dropped.
    throw new CoverageError(
      `Could not reach ${ctx.apiUrl} — ${error instanceof Error ? error.message : String(error)}. ` +
        'Coverage was not measured, so nothing can be concluded from this build about it.',
      COVERAGE_EXIT.USAGE,
      { cause: error },
    );
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    const detail = body?.error?.message;
    throw new CoverageError(httpMessage(response.status, detail, options.projectId));
  }

  return (await response.json()) as SurfaceReportResponse;
}

/** Each status gets the sentence that names the actual fix. */
function httpMessage(status: number, detail: string | undefined, projectId: string): string {
  if (status === 401 || status === 403) {
    return (
      detail ??
      `The API refused the key (${status}). A coverage read needs an API key with the tests:read scope.`
    );
  }
  if (status === 404) {
    return detail ?? `No project "${projectId}". Check the id, or run against the right API URL.`;
  }
  return detail ?? `GET /surface/${projectId} failed with ${status}.`;
}

// ─── The command ─────────────────────────────────────────────────────────────

export const COVERAGE_HELP = `qaai coverage — which parts of your application has nothing ever tested?

Usage:
  qaai coverage --project <projectId> [options]

Options:
  --project <id>      The project to report on (or pass it as the first argument)
  --min <percent>     Fail the build below this floor. 0-100.
  --limit <n>         How many items to print (default ${DEFAULT_PRINT_LIMIT}, max ${MAX_PRINT_LIMIT}). Anything
                      held back is counted out loud; the totals are always complete.
  --kind <list>       Comma-separated: ${KINDS.join(', ')}
  --status <list>     Comma-separated: ${STATUSES.join(', ')} (default UNCOVERED)
  --origin <value>    One of: ${ORIGINS.join(', ')}
  --json              The API's own payload plus the gate's verdict

Exit codes:
  0  coverage met the floor, or no floor was asked for
  1  below the --min floor
  2  usage error, or the API could not be reached — the gate never ran
  3  --min was given and there is nothing to divide: coverage is not measured
     yet. Distinct from 1 on purpose. Your coverage did not drop; it was never
     computed, and the message names the missing input.`;

/**
 * Print the report, then gate on it.
 *
 * Expected failures never throw out of here: the exit code IS the product, so
 * the mapping from "what went wrong" to "what the pipeline sees" is in one
 * place and directly testable. Anything unexpected still propagates to
 * index.ts, which exits 2 — the same code this command uses for "the gate never
 * ran", which is exactly what an unexpected error means.
 */
export async function cmdCoverage(ctx: CoverageContext, args: readonly string[]): Promise<number> {
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

  const parsed = parseCoverageArgs(args);
  if (!parsed.ok) {
    err(`${parsed.message}\n\n${COVERAGE_HELP}\n`);
    return COVERAGE_EXIT.USAGE;
  }
  const options = parsed.options;

  let payload: SurfaceReportResponse;
  try {
    payload = await fetchReport(ctx, options);
  } catch (error) {
    if (error instanceof CoverageError) {
      err(`${error.message}\n`);
      return error.code;
    }
    throw error;
  }

  const gate = evaluateGate({
    min: options.min,
    percent: payload.snapshot.totals.percent,
    denominator: payload.snapshot.totals.denominator,
    caveats: payload.snapshot.caveats,
    projectId: payload.projectId,
  });
  const stale = staleSnapshotNote(payload.snapshot, payload.lastStored, payload.projectId);

  if (ctx.json) {
    /*
     * The API's payload verbatim, then our two derived fields. Verbatim
     * matters: the point of --json is a customer recomputing our arithmetic
     * from the same bytes we used, and a reshaped payload makes that an
     * exercise in reverse-engineering. `items` is the page; `snapshot.totals`
     * is always the full picture.
     */
    out(
      JSON.stringify({
        ...payload,
        gate: {
          min: options.min,
          percent: payload.snapshot.totals.percent,
          state: gate.state,
          exitCode: gate.code,
          message: gate.message,
        },
        stale: { note: stale, isStale: stale !== null && payload.lastStored !== null },
      }) + '\n',
    );
  } else {
    out(renderCoverageReport(payload, options).join('\n') + '\n');
    // Warnings go to stderr so `qaai coverage --json > file` and a piped
    // human report both stay parseable, and a CI log still shows them.
    if (stale) err(`\n! ${stale}\n`);
    if (gate.message) out(`\n${gate.message}\n`);
  }

  return gate.code;
}
