/**
 * Cross-browser and localisation testing (§4) — and the PRODUCTION CALLER the
 * matrix execution surface did not have.
 *
 * Both types are the same idea — run the identical spec more than once under a
 * different `use` block — so they are one file with two exported plugins rather
 * than two near-copies that drift apart.
 *
 * ── THE DEFECT THIS FILE NOW CLOSES ─────────────────────────────────────────
 *
 * `packages/runner/src/matrix.ts` is complete, tested and was CALLED BY NOTHING.
 * Eight of its eleven exports — `planMatrix`, `variantsFor`, `variantKeyFor`,
 * `rollUpVerdict`, `NOT_RUN_KIND_FOR_CELL`, `CELL_STATUS_SEVERITY`,
 * `floorCellFor`, `mayWriteBaseline` — were reached only by their own test file
 * and by the package barrel. A barrel export plus a colocated test satisfies the
 * package-exports ratchet, so `check:wiring` reported green over a module that
 * decided nothing in production. "It has tests" is not a read path.
 *
 * What that cost, concretely, is the sentence this product exists to say. This
 * plugin handed Playwright three projects, Playwright ran them, and the harness
 * reduced the lot WORST-WINS into one `TestResult` row. So "it passes in Chromium
 * and fails in WebKit" was stored as "it failed", and "covered in WebKit and in
 * de-DE" was not merely unsaid — there was no row it could have been said on.
 * `TestResultVariant` existed, the worker persisted it
 * (`apps/worker/src/processors/run.ts`, `measurementRows`), the API served it
 * (`apps/api/src/routes/measurements.ts`), and NO PLUGIN IN THE PRODUCT EVER
 * EMITTED ONE.
 *
 * ── WHY ONE HARNESS CALL PER CELL, WHICH IS SLOWER ──────────────────────────
 *
 * `runPlaywrightSpec` collapses every project into a single `TestExecution`:
 * there is no per-project verdict on the way out, only merged steps. Keeping one
 * call with N projects and then stamping the merged verdict onto N variant rows
 * would be the "one image asserted for every cell" defect wearing a different
 * hat — chromium green and webkit red, both filed as red, with the row claiming
 * per-cell precision it does not have.
 *
 * So each cell gets its own call and its own honest verdict. That is N harness
 * spawns where there was one, and the browser work is unchanged (N browsers were
 * always launched); what is added is N-1 workspace materialisations and CLI
 * boots. The cheaper alternative — returning per-project results from the
 * harness — is a change inside `playwright-harness.ts`, which this file does not
 * own; it is in this round's handover.
 *
 * ── WHAT A CELL THIS HARNESS CANNOT HONOUR DOES ─────────────────────────────
 *
 * `HarnessOptions['projects']` carries `browserName`, `locale` and `timezoneId`
 * and nothing else. A cell naming a colour scheme, reduced motion, forced
 * colors, a device preset, a channel or a version pin CANNOT be executed here —
 * and running it anyway would execute the default rendering and file the result
 * under that cell's name, which is a lie with a row number. So
 * {@link refuseUnhonourableCells} moves it into `refused` with a typed
 * `UNSUPPORTED` and the exact remedy, and it STAYS IN THE DENOMINATOR. An
 * unmeasured cell is null with a reason, never a zero nobody read.
 */

import {
  CHANNEL_ENGINE,
  crossBrowserSpecSchema,
  localizationSpecSchema,
  matrixCellKey,
  notRunMessage,
  variantBrowserKey,
  variedAxes,
} from '@qaai/shared';
import type {
  BrowserEngine,
  ConsoleEntry,
  ExecutableTest,
  Finding,
  MatrixAxes,
  MatrixCell,
  NetworkEntry,
  RunContext,
  RunnerPlugin,
  StepResult,
  TestExecution,
} from '@qaai/shared';
import { runPlaywrightSpec } from '../playwright-harness.js';
import type { HarnessOptions } from '../playwright-harness.js';
import {
  planMatrix,
  rollUpVerdict,
  variantsFor,
  type CellOutcome,
  type MatrixExecution,
  type MatrixPlan,
  type MatrixRefusal,
} from '../matrix.js';

/** One entry of `HarnessOptions['projects']` — the only `use` block this harness has. */
export type HarnessProject = NonNullable<HarnessOptions['projects']>[number];

/**
 * The cap on cells one matrix test may expand to.
 *
 * Twelve, and the number is chosen against the cost model above rather than
 * plucked: one harness spawn per cell means a 12-cell matrix is already a
 * multi-minute test, and a declaration that wants more is a declaration whose
 * author should see a `capBite` saying so. `planMatrix` discloses the bite as a
 * count and a reason, so a percentage over a capped matrix is never mistaken for
 * a percentage over the whole one.
 */
export const MATRIX_MAX_CELLS = 12;

/**
 * Which of a cell's axes this harness can actually put into a browser context.
 *
 * A `Record<keyof MatrixCell, boolean>` and not a list of three strings, for the
 * reason `PLAYWRIGHT_CHANNEL` and `NOT_RUN_KIND_FOR_CELL` are records: a TENTH
 * AXIS ADDED TO `MatrixCell` IS A COMPILE ERROR HERE. A hand-written list would
 * instead leave the new axis quietly absent, `harnessSupport` would call it
 * unhonoured, and that is the safe direction — but only until somebody "fixes"
 * the list by adding the name without adding the project field, at which point
 * the cell executes in the browser's own rendering and is filed under its name.
 *
 * `variedAxes` returns `string[]`, so the lookup is by a cast and an unknown
 * string resolves to `undefined` — which is `!== true` and therefore
 * UNHONOURED. The default is "we cannot express this", never "we can".
 */
export const HARNESS_HONOURS: Record<keyof MatrixCell, boolean> = {
  engine: true,
  locale: true,
  timezone: true,
  // Everything below needs a field the generated project does not have.
  channel: false,
  version: false,
  device: false,
  colourScheme: false,
  reducedMotion: false,
  forcedColors: false,
};

/** Can the Playwright project shape express this cell, or would running it mislabel the result? */
export function harnessSupport(
  cell: MatrixCell,
): { readonly honoured: true } | { readonly honoured: false; readonly why: string } {
  const unhonoured = variedAxes(cell).filter(
    (axis) => HARNESS_HONOURS[axis as keyof MatrixCell] !== true,
  );
  if (unhonoured.length === 0) return { honoured: true };
  return {
    honoured: false,
    why:
      `this cell varies ${unhonoured.join(', ')}, and the Playwright project shape this runner ` +
      'generates carries only browserName, locale and timezoneId. Running it would execute the ' +
      "browser's own rendering and file the result under this cell's name, which is a false claim " +
      'with a row number, so it was refused instead. The remedy is a change to ' +
      "HarnessOptions['projects'] in packages/runner/src/playwright-harness.ts — it is QAAI work, " +
      'not an install, which is why this is UNSUPPORTED rather than BLOCKED_BY_ENV.',
  };
}

/**
 * Move every cell this harness cannot honour out of `runnable` and into
 * `refused`, with the typed reason.
 *
 * `scored` IS DELIBERATELY UNCHANGED. A cell refused for OUR missing plumbing
 * must not leave the denominator — that is how a percentage rises because we
 * stopped trying. `attempted`, `unprobed` and `refused` are recounted because
 * they are counts of what happened, and the `rule` sentence gains the clause, so
 * a reader checking the arithmetic sees the split rather than discovering it.
 */
export function refuseUnhonourableCells(plan: MatrixPlan): MatrixPlan {
  const runnable: MatrixExecution[] = [];
  const extra: MatrixRefusal[] = [];

  for (const execution of plan.runnable) {
    const support = harnessSupport(execution.cell);
    if (support.honoured) {
      runnable.push(execution);
      continue;
    }
    extra.push({
      cell: execution.cell,
      resolution: execution.resolution,
      notRun: { kind: 'UNSUPPORTED', why: support.why },
    });
  }

  if (extra.length === 0) return plan;

  const refused = [...plan.refused, ...extra];
  return {
    ...plan,
    runnable,
    refused,
    denominator: {
      ...plan.denominator,
      attempted: runnable.length,
      unprobed: runnable.filter((execution) => execution.unprobed).length,
      refused: refused.length,
      rule:
        `${plan.denominator.rule} A further ${extra.length} cell(s) were refused by this runner ` +
        'rather than by the image: the generated Playwright project carries browserName, locale ' +
        'and timezoneId only. They stay IN the denominator, because a cell dropped for our own ' +
        'missing plumbing would make the percentage rise for work nobody did.',
    },
  };
}

/**
 * A short, readable name for one cell — what a human reads beside a step.
 *
 * The engine key is included only when the cell NAMED an engine. An absent
 * engine keys as `'<default>'`, which is correct in a baseline key and useless
 * in a label: a localisation cell would read `<default> de-DE` where `de-DE` is
 * the whole of what varies.
 */
export function cellLabel(cell: MatrixCell): string {
  const parts: string[] = [];
  if (cell.engine !== undefined) parts.push(variantBrowserKey(cell));
  if (cell.locale !== undefined) parts.push(cell.locale);
  if (cell.timezone !== undefined) parts.push(cell.timezone);
  return parts.length > 0 ? parts.join(' ') : matrixCellKey(cell);
}

/**
 * The Playwright project for one cell.
 *
 * A single-engine cell produces `{ name: 'chromium', browserName: 'chromium' }`
 * — byte for byte what `browserProjects` produced before this file called the
 * matrix at all, which keeps the project name in every artifact path and every
 * runtime-observation attribution exactly where it was.
 *
 * Every optional is spread CONDITIONALLY rather than set to undefined: the
 * config generator tests each field for truthiness, and an explicit
 * `locale: undefined` would be indistinguishable from an absent one here but is
 * not indistinguishable to a reader of this object in a log.
 */
export function projectForCell(cell: MatrixCell): HarnessProject {
  return {
    name: cellLabel(cell).replace(/[^A-Za-z0-9._-]+/g, '-'),
    ...(cell.engine !== undefined ? { browserName: cell.engine } : {}),
    ...(cell.locale !== undefined ? { locale: cell.locale } : {}),
    ...(cell.timezone !== undefined ? { timezoneId: cell.timezone } : {}),
  };
}

/**
 * The engine a bare version RANGE is a claim about.
 *
 * `CHANNEL_ENGINE` answers the same question for a channel IN DATA — it is "the
 * whole of the 'a firefox beta does not exist' rule", so this file must not hold
 * a second opinion about channels — and nothing answers it for a version,
 * because a range is two numerals and carries no engine in it. The answer is the
 * one `crossBrowserPlan` was already relying on without saying so: an absent
 * `engines` axis means "whatever this deployment launches", and the config this
 * runner generates launches chromium. So `>=120` with no engine named is a range
 * over chromium's release train, and the repair below is making the plan SAY
 * that rather than leaving it implied.
 *
 * Exported so {@link engineAxisFor}'s choice is checkable from a test without
 * the test restating the word 'chromium' in a second place.
 */
export const VERSION_PIN_ENGINE: BrowserEngine = 'chromium';

/**
 * The `engines` axis this declaration implies — which is not always the one it
 * wrote down.
 *
 * ── CHROMIUM IS FORCED INTO A DECLARED AXIS ─────────────────────────────────
 *
 * A matrix without the default browser hides regressions, which is the rule the
 * pre-matrix `browserProjects` enforced and `crossBrowserSpecSchema` restates
 * for the widened axes.
 *
 * ── AND INTO AN ABSENT ONE, WHEN A CHANNEL OR A VERSION ANCHORED IT ─────────
 *
 * THE DEFECT THIS CLOSES, which reached production and wrote nothing. An absent
 * `engines` axis means "whatever this deployment launches", so for a cell that
 * says nothing about the engine, leaving the axis absent is the honest answer:
 * the row keys `'<default>'`, which `testVariantKeySchema` admits as a REAL
 * ANSWER, and every LOCALIZATION cell is one of those. That is why this function
 * stays narrow — a locale, a timezone, a device or a rendering preference does
 * NOT anchor an engine and must keep keying `'<default>'`.
 *
 * A CHANNEL OR A VERSION RANGE IS DIFFERENT, because it is a statement ABOUT an
 * engine. `matrixCellSchema` refuses either one with no engine named, in its own
 * words: every channel except BUNDLED is a chromium build, so a channel on an
 * unanchored cell "is either redundant or a contradiction and nothing can tell
 * which", and a version range is "a claim about one engine's release train".
 * The don't-care is therefore not available on those two axes — the declaration
 * has already named an engine implicitly, and the plan has to say which.
 *
 * Until it did, `channels: ['MSEDGE_DEV']` with no `engines` produced the cell
 * `{ channel: 'MSEDGE_DEV' }`, which `variantBrowserKey` keys
 * `'<default>:MSEDGE_DEV'` — and BOTH ingest paths refuse that TWICE OVER. Once
 * at `key.browser`, because `variantDimension` reserves an angle bracket for a
 * value that is EXACTLY a sentinel and a bracket mid-composite is the forging
 * hole that refinement exists to close. And once on the EVIDENCE side, where
 * `testResultVariantCellSchema` asks `declarationRulesRefuse` and insists that a
 * cell the declaration rules reject be stored as UNSUPPORTED_COMBINATION — which
 * is the right rule for a cell that genuinely cannot exist, and the wrong status
 * for one this planner could simply have anchored.
 * `validateMeasurements` refuses a matrix WHOLE on its first bad cell, so such a
 * spec wrote ZERO variant rows for the entire run behind one logger.warn, and on
 * the agent path one cell 400s a POST carrying a whole batch of results.
 *
 * A PREVIOUS VERIFIER RECORDED THESE KEYS AS STRUCTURALLY IMPOSSIBLE, on the
 * grounds that `matrixCellSchema` refuses a channel with no engine. That is true
 * of a cell a CUSTOMER DECLARED and false of one this planner BUILT: the planner
 * does not parse its own output, so no refinement runs between here and the
 * column. It is exactly why the defect reached production, and the next reader
 * will re-derive the same wrong conclusion unless this paragraph stops them.
 *
 * THE REPAIR IS HERE AND NOT IN THE REFINEMENT. Teaching `variantDimension` to
 * accept `'<default>'` inside a composite would reopen that forging hole for
 * every dimension, and `'<default>:MSEDGE_DEV'` is self-contradictory anyway: it
 * claims nobody chose an engine and then names a build of one.
 *
 * NO STORED KEY MOVES. The keys this changes are the keys of specs that declare
 * a non-BUNDLED channel or a RANGE pin without `engines` — and such a spec lost
 * its WHOLE matrix on the first bad cell, so not one of its rows, including its
 * storable BUNDLED and UNPINNED siblings, has ever reached a column. A spec
 * declaring only `['BUNDLED']` or only `[{ kind: 'UNPINNED' }]` anchors nothing
 * and is byte-identical to before: those two values mean "the build this
 * deployment already runs", which is the same don't-care as an absent axis.
 */
export function engineAxisFor(matrix: MatrixAxes): { readonly engines?: readonly BrowserEngine[] } {
  const declared = matrix.engines;
  if (declared !== undefined && declared.length > 0) {
    return declared.includes('chromium')
      ? { engines: [...new Set(declared)] }
      : { engines: ['chromium', ...new Set(declared)] };
  }

  return impliedEngineAxis(matrix);
}

/**
 * THE ANCHORING HALF ALONE — the engine a declaration NAMED IMPLICITLY, with no
 * opinion about whether the default browser belongs in the matrix.
 *
 * Split out of {@link engineAxisFor} because the two halves of that function
 * answer to two different authorities, and only ONE of them is universal.
 *
 * "A matrix must still include chromium" is a rule `crossBrowserSpecSchema`
 * STATES, in its own words: when `matrix` is present it is the richer statement
 * and `browsers` is its floor, "for the reason `browserProjects` records — a
 * matrix without the default browser hides regressions". `visualTestSpecSchema`
 * says no such thing and has no `browsers` field to be a floor, so forcing
 * chromium into a DECLARED visual engines axis would invent a rule, add a cell
 * `plugins/visual.ts` cannot capture, and spend `VISUAL_MAX_CELLS` on it —
 * narrowing the disclosure of the cells the author actually asked for.
 *
 * "A channel or a version RANGE has already named an engine" is not a rule of
 * either spec: it is `matrixCellSchema`'s, which refuses both with no engine
 * because every channel but BUNDLED is a chromium build and a range is a claim
 * about one engine's release train. That applies to any declaration anywhere,
 * so it is what a caller with no floor rule of its own asks for.
 *
 * ONE implementation and not two, because the first thing a second copy of
 * "which engine is MSEDGE_DEV a build of" does is diverge, and the divergence
 * is a cell anchored to an engine nobody launched — storable, and wrong.
 */
export function impliedEngineAxis(matrix: MatrixAxes): {
  readonly engines?: readonly BrowserEngine[];
} {
  /*
   * Asked of `CHANNEL_ENGINE` per channel rather than written as "chromium",
   * because that record IS the rule and a second copy of it here would diverge
   * the first time a channel of some other engine is added — at which point the
   * cells would be anchored to the wrong engine and still be storable, which is
   * the worse failure: a row naming a build nobody launched. BUNDLED maps to
   * `null`, which anchors nothing, and that is why it is not special-cased.
   */
  const anchors = new Set<BrowserEngine>();
  for (const channel of matrix.channels ?? []) {
    const owner = CHANNEL_ENGINE[channel];
    if (owner !== null) anchors.add(owner);
  }
  for (const pin of matrix.versions ?? []) {
    if (pin.kind === 'RANGE') anchors.add(VERSION_PIN_ENGINE);
  }

  return anchors.size === 0 ? {} : { engines: [...anchors] };
}

/**
 * A value's identity, with object keys sorted so that property ORDER cannot
 * forge a difference between two values that are the same value.
 *
 * `JSON.stringify` writes properties in insertion order, so without the sort
 * `{ width: 200, height: 200 }` and `{ height: 200, width: 200 }` are two
 * different strings and the same screen.
 */
function canonicalValue(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : inner,
  );
}

/** The same list with a repeat removed, keeping the FIRST occurrence and the declared order. */
function withoutRepeats<T>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const value of values) {
    const id = canonicalValue(value);
    if (seen.has(id)) continue;
    seen.add(id);
    kept.push(value);
  }
  return kept;
}

/**
 * ONE DECISION WRITTEN TWICE IS NOT TWO CELLS — and until this ran it cost the
 * WHOLE TEST, not one cell of it.
 *
 * `crossBrowserPlan` has deduplicated `browsers` since it was written, and the
 * comment on that line is the entire argument: `crossBrowserSpecSchema` says
 * listing chromium again "is harmless", and a duplicate reaching `planMatrix`
 * is a REFUSAL there — two cells with one key write one variant row — "which
 * would turn a harmless spec into an unrunnable one". `engineAxisFor` makes the
 * same move for `engines`, through a `Set`.
 *
 * THE OTHER EIGHT AXES GOT NEITHER, and the cost is total.
 * `matrix: { locales: ['en-US', 'en-US'] }` is VALID, expands to two identical
 * cells, and `planMatrix` reports a problem — at which point `runMatrixCells`
 * returns the ENTIRE TEST as SKIPPED with a NOT_RUN quoting a cell key the
 * author never typed. Observed on all eight before this function existed —
 * channels, versions, devices, colourSchemes, reducedMotion, forcedColors,
 * locales, timezones — each one `runnable=0 refused=0 problems=1`. Zero variant
 * rows for the run, which is the same loss the five key defects of this family
 * cost, arriving one step earlier in the chain.
 *
 * DEDUPLICATED AND NOT REFUSED, because that is the decision already made for
 * the identical question one function below, and two answers to one question
 * diverge. A duplicate CELL arising from two DIFFERENT declarations is still
 * reported by `planMatrix`, exactly as its own note says: that author believed
 * they were covering two things. A repeated axis VALUE is one thing typed
 * twice, and there is nothing else it could mean.
 *
 * BY DEEP VALUE AND NOT BY CELL KEY. Deduplicating on `matrixCellKey` would be
 * shorter and would silently DROP a cell the key cannot tell apart: two
 * explicit viewports of one size with different user agents key identically,
 * because `deviceKey` records a user agent as the presence marker `ua` and
 * never its value. Those two are two real cells — the schema's own note says a
 * synthesised agent "is a lie the application under test will believe and
 * branch on" — so they survive here and are still refused, loudly, by
 * `planMatrix`. That gap is pinned in
 * adversary/matrix-writepath.adversary.test.ts with the door refusal it wants.
 *
 * GENERIC OVER THE AXES rather than a list of nine, so a TENTH AXIS is covered
 * the day it lands instead of the day somebody remembers this function.
 *
 * NOTHING MOVES for a spec without a repeat: every value is carried through by
 * reference, in declared order, so the expansion is byte-identical — and a spec
 * WITH a repeat planned nothing at all, so it has no stored key to move.
 */
export function dedupeAxisValues(matrix: MatrixAxes): MatrixAxes {
  const deduped: Record<string, unknown> = {};
  for (const [axis, values] of Object.entries(matrix)) {
    /*
     * A non-array axis is passed through untouched. `matrixAxesSchema` holds
     * nine arrays and nothing else today, and guessing at a scalar's identity
     * is not this function's business.
     */
    deduped[axis] = Array.isArray(values) ? withoutRepeats(values as readonly unknown[]) : values;
  }
  /*
   * The same object rebuilt: only a repeat is dropped and every surviving value
   * is the caller's own, so each axis keeps its element type. Every field of
   * `MatrixAxes` is optional and `matrixAxesSchema` is `.strict()`, so there is
   * nothing in here the type does not already describe and no assertion is
   * needed to say so.
   */
  return deduped;
}

/** The plan a CROSS_BROWSER spec declares, against this run's seed. */
export function crossBrowserPlan(
  spec: { browsers: BrowserEngine[]; matrix?: MatrixAxes },
  seed: string,
): MatrixPlan {
  if (spec.matrix !== undefined) {
    /*
     * The richer statement wins and `browsers` is its floor — the arrangement
     * `crossBrowserSpecSchema.matrix` documents. The axes are expanded by
     * `enumerateMatrix` through `planMatrix`, which owns the cap and its
     * disclosure; nothing here re-implements either.
     *
     * Deduplicated FIRST, and `engineAxisFor` is asked of the deduplicated axes
     * rather than the raw ones, so there is one canonical declaration and not
     * two readings of it.
     */
    const declared = dedupeAxisValues(spec.matrix);
    const axes: MatrixAxes = {
      ...declared,
      ...engineAxisFor(declared),
    };
    return refuseUnhonourableCells(planMatrix({ axes, seed, maxCells: MATRIX_MAX_CELLS }));
  }

  /*
   * One cell per engine, as an EXPLICIT CELL LIST and not an axis, because that
   * is what it is: `browsers: ['chromium', 'webkit']` is two declared pairings,
   * and `planMatrix` honours a list exactly rather than re-expanding it into a
   * product. Deduplicated here because the schema's own comment says listing
   * chromium twice is harmless — and a duplicate reaching `planMatrix` is a
   * REFUSAL there (two cells, one variant row), which would turn a harmless
   * spec into an unrunnable one.
   */
  const engines = [...new Set<BrowserEngine>(['chromium', ...spec.browsers])];
  const cells: MatrixCell[] = engines.map((engine) => ({ engine }));
  return refuseUnhonourableCells(planMatrix({ cells, seed, maxCells: MATRIX_MAX_CELLS }));
}

/** The plan a LOCALIZATION spec declares. */
export function localizationPlan(
  spec: { locales: Array<{ tag: string; timezone?: string }> },
  seed: string,
): MatrixPlan {
  /*
   * DECLARED PAIRINGS, never a product. A locale and its timezone travel
   * together — half of localisation bugs are date and currency formatting, which
   * a locale alone does not exercise — so `de-DE`+`Europe/Berlin` is ONE cell.
   * Crossing the two axes would assert `de-DE`+`America/New_York`, which nobody
   * declared and which is a different test.
   *
   * ONE PAIRING WRITTEN TWICE IS STILL ONE PAIRING. `{ locales: [{ tag:
   * 'en-US' }, { tag: 'en-US' }] }` is VALID and used to plan two identical
   * cells, which `planMatrix` refuses as a duplicate — and `runMatrixCells`
   * then returns the whole test SKIPPED with zero variant rows. Same argument
   * and same function as {@link dedupeAxisValues}: a repeat is one decision
   * typed twice, and an absent `timezone` canonicalises identically to one
   * present and undefined, which is the same cell either way.
   */
  const cells: MatrixCell[] = withoutRepeats(spec.locales).map((locale) => ({
    locale: locale.tag,
    ...(locale.timezone !== undefined ? { timezone: locale.timezone } : {}),
  }));
  return refuseUnhonourableCells(planMatrix({ cells, seed, maxCells: MATRIX_MAX_CELLS }));
}

/** One cell handed to the thing that actually runs a spec. INJECTED, so the tests need no browser. */
export interface CellRun {
  readonly cell: MatrixCell;
  readonly project: HarnessProject;
}

export type CellRunner = (run: CellRun) => Promise<TestExecution>;

function skippedExecution(test: ExecutableTest, kind: 'NOT_RUN', why: string): TestExecution {
  return {
    testId: test.id,
    status: 'SKIPPED',
    durationMs: 0,
    steps: [],
    network: [],
    console: [],
    videoKey: null,
    traceKey: null,
    errorMessage: notRunMessage(kind, why),
    retriedAndPassed: false,
    notRun: { kind, why },
    findings: [],
  };
}

/**
 * Run every runnable cell, route each verdict onto its own variant row, and roll
 * the lot up.
 *
 * THE ROLL-UP IS THE DECISION, not a decoration: with three engines and one
 * uninstalled WebKit, `rollUpVerdict` returns the worst of the TWO THAT RAN and
 * reports the third as excluded — so a missing binary cannot turn a green test
 * red, and two passes cannot report a test as passing while the third cell is
 * silently absent from the status. Both halves matter and neither is expressible
 * in a status alone, which is why the counts come back beside it.
 */
export async function runMatrixCells(args: {
  readonly ctx: RunContext;
  readonly test: ExecutableTest;
  readonly plan: MatrixPlan;
  readonly run: CellRunner;
}): Promise<TestExecution> {
  const { ctx, test, plan, run } = args;
  const startedAt = Date.now();

  if (plan.problems.length > 0) {
    /*
     * RETURNED, never thrown, and SKIPPED rather than FAILED. A declaration
     * nothing could read is a suite defect, and reporting it as a failure would
     * put a red row against the customer's application for a sentence somebody
     * typed into a spec.
     */
    return { ...skippedExecution(test, 'NOT_RUN', plan.problems.join(' ')), durationMs: Date.now() - startedAt };
  }

  const steps: StepResult[] = [];
  const network: NetworkEntry[] = [];
  const consoleEntries: ConsoleEntry[] = [];
  const findings: Finding[] = [];
  const outcomes: CellOutcome[] = [];
  let videoKey: string | null = null;
  let traceKey: string | null = null;
  let retriedAndPassed = false;
  let cancelledAfter: number | null = null;

  for (const execution of plan.runnable) {
    if (ctx.signal.aborted) {
      /*
       * Cancellation stops the loop and is DISCLOSED. The remaining cells get no
       * outcome, so `variantsFor` writes them as NOT_RUN — the honest reading of
       * a row nobody wrote to — and this line is what tells a reader the cause
       * was a human stopping the run rather than our runner losing a result.
       */
      cancelledAfter = outcomes.length;
      break;
    }

    const label = cellLabel(execution.cell);
    const cellExecution = await run({ cell: execution.cell, project: projectForCell(execution.cell) });

    outcomes.push({
      cell: execution.cell,
      status: cellExecution.status,
      durationMs: cellExecution.durationMs,
      errorMessage: cellExecution.errorMessage,
      retriedAndPassed: cellExecution.retriedAndPassed,
    });

    // Re-indexed, because a step index is a position in THIS result's list and
    // three cells each starting at 0 would make the cockpit's ordering arbitrary.
    for (const step of cellExecution.steps) {
      steps.push({ ...step, index: steps.length, title: `[${label}] ${step.title}` });
    }
    network.push(...cellExecution.network);
    consoleEntries.push(...cellExecution.console);
    findings.push(...cellExecution.findings);
    retriedAndPassed = retriedAndPassed || cellExecution.retriedAndPassed;
    videoKey = videoKey ?? cellExecution.videoKey;
    traceKey = traceKey ?? cellExecution.traceKey;
  }

  // A refused cell gets a STEP as well as a row: the row is what a query reads
  // and the step is what the person staring at a red run reads.
  for (const refusal of plan.refused) {
    steps.push({
      index: steps.length,
      title: `[${cellLabel(refusal.cell)}] not run — ${refusal.notRun.kind}`,
      status: 'SKIPPED',
      startedAt: new Date().toISOString(),
      durationMs: 0,
      screenshotKey: null,
      error: null,
    });
    consoleEntries.push({
      level: 'warn',
      text: `Cell ${matrixCellKey(refusal.cell)} was not run: ${refusal.notRun.why}`,
      at: new Date().toISOString(),
    });
  }

  if (plan.capBite !== null) {
    consoleEntries.push({
      level: 'warn',
      text: `Matrix cap bit: ${plan.capBite.detail}`,
      at: new Date().toISOString(),
    });
  }

  if (cancelledAfter !== null) {
    consoleEntries.push({
      level: 'warn',
      text:
        `The run was cancelled after ${cancelledAfter} of ${plan.runnable.length} cell(s). The ` +
        'cells below it are recorded as NOT_RUN, which is what nobody measuring them means.',
      at: new Date().toISOString(),
    });
  }

  const { variants, omitted } = variantsFor(
    plan,
    {
      /*
       * The test's own auth profile id, and NOT `ANONYMOUS_ROLE` by omission: a
       * test bound to an admin profile that reported `'<anonymous>'` would claim
       * the suite covers the logged-out rendering of a page it only ever saw as
       * an admin. An id is a weaker label than a role name and it is a true one;
       * the name is not on `ExecutableTest` to be read.
       */
      ...(test.authProfileId ? { role: test.authProfileId } : {}),
      environment: ctx.environmentId,
    },
    outcomes,
  );

  for (const omission of omitted) {
    consoleEntries.push({
      level: 'warn',
      text: `No variant row for ${matrixCellKey(omission.cell)}: ${omission.why}`,
      at: new Date().toISOString(),
    });
  }

  const verdict = rollUpVerdict(variants);
  consoleEntries.push({
    level: 'log',
    text: `Matrix: ${verdict.rule} Denominator: ${plan.denominator.rule}`,
    at: new Date().toISOString(),
  });

  /*
   * The first cell that said something, and ONLY when the roll-up is not green.
   * A message on a PASSED parent reads as a failure to every screen that shows
   * `errorMessage` beside a status, and the cell rows are where a per-cell
   * sentence belongs anyway — this field exists so the person looking at a red
   * run learns WHICH cell was red without opening the rows.
   */
  const firstFailure =
    verdict.status === 'PASSED'
      ? undefined
      : outcomes.find(
          (outcome) => outcome.errorMessage !== null && outcome.errorMessage !== undefined,
        );

  return {
    testId: test.id,
    status: verdict.status,
    durationMs: Date.now() - startedAt,
    steps,
    network,
    console: consoleEntries,
    videoKey,
    traceKey,
    errorMessage:
      verdict.parentNotRun !== null
        ? notRunMessage(verdict.parentNotRun.kind, verdict.parentNotRun.why)
        : firstFailure
          ? `[${cellLabel(firstFailure.cell)}] ${firstFailure.errorMessage}`
          : null,
    retriedAndPassed,
    notRun: verdict.parentNotRun,
    findings,
    /*
     * The per-cell evidence, which is the whole point. Written whenever a cell
     * row exists — a CROSS_BROWSER or LOCALIZATION test is a matrix by
     * definition, so there is no unvaried case here for which one synthetic row
     * would duplicate the roll-up. `variantsFor` is the guard against that, and
     * it refuses such a cell rather than leaving it to this call site.
     */
    variants: variants.length > 0 ? [...variants] : null,
  };
}

export const crossBrowserPlugin: RunnerPlugin = {
  type: 'CROSS_BROWSER',

  validate(test: ExecutableTest): void {
    const parsed = crossBrowserSpecSchema.safeParse(test.spec ?? {});
    if (!parsed.success) {
      throw new Error(
        `Cross-browser test "${test.name}" has an invalid spec — ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
  },

  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const spec = crossBrowserSpecSchema.parse(test.spec ?? {});
    return runMatrixCells({
      ctx,
      test,
      // The run id is the seed, so a re-run of the same run takes the same
      // subset when the cap bites and a new run is free to take another.
      plan: crossBrowserPlan(spec, ctx.runId),
      run: ({ project }) => runPlaywrightSpec(ctx, test, { projects: [project] }),
    });
  },
};

export const localizationPlugin: RunnerPlugin = {
  type: 'LOCALIZATION',

  validate(test: ExecutableTest): void {
    const parsed = localizationSpecSchema.safeParse(test.spec ?? {});
    if (!parsed.success) {
      throw new Error(
        `Localization test "${test.name}" has an invalid spec — ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
  },

  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const spec = localizationSpecSchema.parse(test.spec ?? {});
    return runMatrixCells({
      ctx,
      test,
      plan: localizationPlan(spec, ctx.runId),
      run: ({ project }) => runPlaywrightSpec(ctx, test, { projects: [project] }),
    });
  },
};
