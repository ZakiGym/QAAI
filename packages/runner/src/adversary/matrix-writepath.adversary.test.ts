/**
 * ADVERSARIAL COUNTER-TESTS, written against the plugin rather than with it.
 *
 * Each one is an attempt to MAKE the plugin report a pass it did not earn,
 * built from a fixture the colocated suite does not hold. Where a sweep over a
 * whole exported union was possible it is done that way rather than over the
 * members somebody remembered to list: that is what makes a new member
 * un-passable by default instead of un-passable by review.
 *
 * ── THE PROPERTY THIS FILE EXISTS TO HOLD ───────────────────────────────────
 *
 *   FOR EVERY SPEC THE SPEC SCHEMA ACCEPTS, THE VARIANT ROWS ITS PLAN PRODUCES
 *   MUST BE ACCEPTED BY THE WRITE PATH.
 *
 * ── WHY IT IS A PROPERTY AND NOT AN EIGHTH HAND-WRITTEN CASE ────────────────
 *
 * The round that wired `crossBrowserPlan` and `localizationPlan` to
 * `variantsFor` gave the key producers their first production caller. Every
 * latent disagreement between a producer and the write-path validator arrived
 * live that day, and SIX of them have since been found ONE AT A TIME, each by a
 * different reader, each after the previous one declared the family closed:
 *
 *   · `'<unvaried>+dark'` — a colour-scheme-only cell put a sentinel INSIDE a
 *     composite viewport key;
 *   · `'>=120<130'` — a bounded version window spelled the forging bracket;
 *   · `'<default>'` on the browser dimension — the sentinel its own producer
 *     emits for every LOCALIZATION cell, refused by the column;
 *   · two bounds (`locale` at 40, `notRun.why` at 500) that refused the widest
 *     value their own producer can emit;
 *   · one locale in two zones — two cells, ONE variant key;
 *   · an engine-less channel cell, and the EVIDENCE of a cell that resolved
 *     UNSUPPORTED_COMBINATION, both refused by a declaration rule.
 *
 * Every one cost the SAME thing, and the cost is why none of them was caught by
 * a red test. `validateMeasurements` (apps/worker/src/processors/run.ts) refuses
 * a matrix WHOLE on its first bad cell, so ONE bad cell writes ZERO variant rows
 * for the entire run behind one `logger.warn` — no red test, no disconnected
 * module, nothing for any gate to report — and the worst-wins roll-up survives,
 * so the run still reads as fine. On the agent path apps/api/src/routes/runners.ts
 * parses the whole body through `z.array(testResultVariantSchema)`, so the same
 * cell 400s a POST carrying a batch of results and the verdicts go with them.
 *
 * And every one of the six had a GREEN TEST OVER IT. browser-matrix.test.ts
 * asserted `'chromium:CHROME_BETA@>=130<132'` character for character while
 * every run of such a cell wrote nothing. A TEST THAT ASSERTS A KEY'S SPELLING
 * DOES NOT ASSERT THAT THE KEY CAN BE STORED. So every case here ENDS AT THE
 * VALIDATOR — `testVariantKeySchema`, then `testResultVariantSchema`, then
 * `planMeasurements`, which is the chain BOTH ingest paths run — and the shapes
 * are derived from the spec schemas' own vocabularies and ceilings rather than
 * from shapes somebody invented to be awkward.
 *
 * ── WHAT IS REPORTED ON FAILURE ─────────────────────────────────────────────
 *
 * A zod PATH and the AXIS NAMES of the generated spec. Never the value: a
 * variant key and a cell are customer-authored text by the same rule a metric
 * name is, which is why `validateMeasurements` reports a path and not a key.
 * These specs are synthetic, but a message that prints a value is a message
 * somebody copies into one that does not.
 */
import { describe, expect, it } from 'vitest';
import {
  BROWSER_CHANNEL_LIST,
  BROWSER_ENGINE_LIST,
  COLOUR_SCHEME_LIST,
  DEVICE_PRESET_LIST,
  FORCED_COLORS_LIST,
  MATRIX_CELL_STATUS_LIST,
  REDUCED_MOTION_LIST,
  browserVersionPinSchema,
  crossBrowserSpecSchema,
  explicitViewportSchema,
  localizationSpecSchema,
  matrixAxesSchema,
  matrixCellEvidenceSchema,
  matrixCellKey,
  planMeasurements,
  testResultVariantSchema,
  testVariantKeySchema,
  variantBrowserKey,
  type DeploymentBrowsers,
  type MatrixAxes,
  type MatrixCell,
  type MatrixCellStatus,
} from '@qaai/shared';
import {
  HARNESS_HONOURS,
  MATRIX_MAX_CELLS,
  crossBrowserPlan,
  localizationPlan,
  refuseUnhonourableCells,
} from '../plugins/matrix.js';
import { planMatrix, variantsFor, type CellOutcome } from '../matrix.js';

// ─── The vocabularies and the ceilings, READ rather than restated ────────────

/**
 * Every axis name, from `matrixAxesSchema`'s own shape.
 *
 * `keyof Required<MatrixAxes>` below makes a TENTH AXIS a compile error in this
 * file, and this list is the run-time half of the same guard: the two are
 * checked against each other by a test, so an axis added to the schema cannot
 * be absent from the corpus without something going red.
 */
type AxisName = keyof Required<MatrixAxes>;
const SCHEMA_AXIS_NAMES = Object.keys(
  (matrixAxesSchema as unknown as { shape: Record<string, unknown> }).shape,
);

/**
 * The cell field each axis contributes to.
 *
 * A `Record` over the axis names and not a `replace(/s$/, '')`, because that
 * guess is silently WRONG on `forcedColors` and `reducedMotion` — and a wrong
 * field name does not throw: `matrixCellKey` ignores a property it does not
 * know, so every value of that axis keys identically and the distinctness check
 * below passes over nothing. A TENTH AXIS is a compile error here too.
 */
const CELL_FIELD_FOR_AXIS: Record<AxisName, keyof MatrixCell> = {
  engines: 'engine',
  channels: 'channel',
  versions: 'version',
  devices: 'device',
  colourSchemes: 'colourScheme',
  reducedMotion: 'reducedMotion',
  forcedColors: 'forcedColors',
  locales: 'locale',
  timezones: 'timezone',
};

/** Peel `.default()` / `.nullable()` / `.optional()` off a field to reach the bound it carries. */
function innerSchema(field: unknown): any {
  let current: any = field;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (current.shape !== undefined || current.maxLength !== undefined) return current;
    current = current.def?.innerType ?? current.unwrap?.();
  }
  return current;
}

/** An array axis's `.max()`, asked of the schema so a widened bound lands here on its own. */
function axisCeiling(axis: AxisName): number {
  const field = (matrixAxesSchema as any).shape[axis].unwrap();
  for (const check of field.def.checks ?? []) {
    const def = check._zod?.def ?? check.def;
    if (def?.check === 'max_length') return def.maximum as number;
  }
  throw new Error(`the ${axis} axis declares no ceiling, so nothing here can derive its worst case`);
}

/*
 * The per-VALUE ceilings. These are the ones that decide how wide a KEY can
 * get, and every one is taken off the schema that owns it — `matrixCellSchema`
 * for the two free-text cell fields, the RANGE branch of the version pin for a
 * numeral, `explicitViewportSchema` for a screen. Restating "35" here is how
 * the `locale` column came to be 40 characters wide for a producer that emits
 * 100.
 */
const TAG_MAX = (matrixCellEvidenceSchema as any).shape.locale.unwrap().maxLength as number;
const TAG_MIN = (matrixCellEvidenceSchema as any).shape.locale.unwrap().minLength as number;
const ZONE_MAX = (matrixCellEvidenceSchema as any).shape.timezone.unwrap().maxLength as number;
const RANGE_SHAPE = ((browserVersionPinSchema as any).options as any[]).find(
  (option) => option.shape?.range !== undefined,
)!.shape.range.shape;
const NUMERAL_MAX = RANGE_SHAPE.atLeast.maxLength as number;
const VIEWPORT = (explicitViewportSchema as any).shape;
const SCREEN_MAX = VIEWPORT.width.maxValue as number;
const SCALE_MAX = VIEWPORT.deviceScaleFactor.unwrap().maxValue as number;
const USER_AGENT_MAX = VIEWPORT.userAgent.unwrap().maxLength as number;

/*
 * THE FLOORS OF THE LOCALISATION PAIRING, ASKED OF ITS OWN SCHEMA.
 *
 * Every figure above is a CEILING, and so was every defect the corpus was built
 * from — until `localizationSpecSchema` let a pairing declare `timezone: ''`
 * while the evidence schema (and the two other places that declare a zone)
 * demand a character. The corpus never tried it: its zone floor was `'X'`, taken
 * from the CROSS_BROWSER axis, which is the one surface that HAD a `min(1)`. So
 * the floor is read off the pairing's own fields, and an absent `minLength` is
 * 0, which is the empty string — the value the property then drives through the
 * write path if the schema accepts it.
 */
const PAIRING = (localizationSpecSchema as any).shape.locales.element.shape;
const PAIRING_TAG_MIN = (PAIRING.tag.minLength ?? 0) as number;
const PAIRING_ZONE_MIN = (PAIRING.timezone.unwrap().minLength ?? 0) as number;

/** A tag of an exact length that no key delimiter can appear in — see `NO_KEY_DELIMITER`. */
const tagOfLength = (n: number) => `en-${'x'.repeat(Math.max(0, n - 3))}`.slice(0, n);
const zoneOfLength = (n: number) => `America/${'x'.repeat(Math.max(0, n - 8))}`.slice(0, n);
/** The widest legal numeral, and a second one that differs — an empty window is refused. */
const WIDEST_NUMERAL = '1'.repeat(NUMERAL_MAX);
const WIDER_NUMERAL = `2${'1'.repeat(NUMERAL_MAX - 1)}`;

/**
 * The tags and zones the corpus varies.
 *
 * The odd-but-real spellings are deliberate and they are the half a BCP-47
 * regex would have cost: `de_DE`, `en-US.UTF-8` and a long `-u-` extension are
 * real locales a customer has already stored, and the delimiter refusal on
 * `localeTagField` was kept to four characters precisely so they still pass.
 * The two synthesised ones sit on the field's own floor and ceiling.
 */
const TAGS: readonly string[] = [
  'en-US',
  'de-DE',
  'ja-JP',
  'ar-EG',
  'de_DE',
  'en-US.UTF-8',
  'en-Latn-US-u-ca-gregory',
  tagOfLength(TAG_MAX),
  tagOfLength(TAG_MIN),
];
const ZONES: readonly string[] = [
  'America/New_York',
  'Pacific/Auckland',
  'Europe/Berlin',
  'UTC',
  'X',
  zoneOfLength(ZONE_MAX),
];

/**
 * ── WHY THE DEVICE AND VERSION LISTS HOLD NO TWO VALUES THAT KEY ALIKE ──────
 *
 * `deviceKey` records a user agent as the presence marker `ua` and never its
 * value, and `versionKey` drops a range's `why` entirely, so two values that
 * differ only there produce ONE `matrixCellKey` — and `planMatrix` then refuses
 * the declaration as a duplicate it is not. That is a real gap, it is NOT this
 * property's subject, and it is pinned on its own at the bottom of this file
 * with the door refusal it wants. Keeping such a pair out of the corpus is a
 * PRECONDITION of the property, not a convenience, so it is machine-checked
 * below rather than left to this comment.
 */
const VERSIONS = [
  { kind: 'UNPINNED' as const },
  { kind: 'RANGE' as const, range: { atLeast: '120', below: null, why: 'closedby landed in 120' } },
  { kind: 'RANGE' as const, range: { atLeast: '120', below: '132', why: 'a bounded window' } },
  {
    kind: 'RANGE' as const,
    range: { atLeast: WIDEST_NUMERAL, below: WIDER_NUMERAL, why: 'the widest legal window' },
  },
  { kind: 'RANGE' as const, range: { atLeast: '999', below: null, why: 'a floor nothing meets' } },
];
const DEVICES = [
  ...DEVICE_PRESET_LIST.map((preset) => ({ kind: 'PRESET' as const, preset })),
  { kind: 'VIEWPORT' as const, viewport: { width: 1280, height: 800 } },
  { kind: 'VIEWPORT' as const, viewport: { width: 200, height: 200, hasTouch: true } },
  {
    kind: 'VIEWPORT' as const,
    viewport: {
      width: SCREEN_MAX,
      height: SCREEN_MAX,
      /* An unrounded double, because `deviceScaleFactor` is a plain `z.number()`
       * and a double prints up to 24 characters into the viewport key. */
      deviceScaleFactor: SCALE_MAX / 4.05,
      hasTouch: true,
      isMobile: true,
      userAgent: 'u'.repeat(USER_AGENT_MAX),
    },
  },
  {
    kind: 'VIEWPORT' as const,
    viewport: { width: SCREEN_MAX, height: SCREEN_MAX, deviceScaleFactor: SCALE_MAX },
  },
];

/**
 * The value set per axis.
 *
 * A `Record` over `keyof Required<MatrixAxes>` and not a list of nine, for the
 * reason `HARNESS_HONOURS` and `NOT_RUN_KIND_FOR_CELL` are records: A TENTH
 * AXIS ADDED TO `MatrixAxes` IS A COMPILE ERROR HERE. A hand-written list would
 * leave the new axis quietly uncovered, and uncovered is exactly the state all
 * six defects above were found in.
 *
 * Every finite axis is its WHOLE exported list — the ones derived from the
 * compiler-enforced presence records in browser-matrix.ts — so a tenth channel
 * or a fourth colour scheme is driven through the write path the day it is
 * declared, with nobody editing this file.
 */
const AXIS_VALUES: Record<AxisName, readonly unknown[]> = {
  engines: BROWSER_ENGINE_LIST,
  channels: BROWSER_CHANNEL_LIST,
  versions: VERSIONS,
  devices: DEVICES,
  colourSchemes: COLOUR_SCHEME_LIST,
  reducedMotion: REDUCED_MOTION_LIST,
  forcedColors: FORCED_COLORS_LIST,
  locales: TAGS,
  timezones: ZONES,
};
const AXIS_NAMES = Object.keys(AXIS_VALUES) as AxisName[];

// ─── Generating the corpus ───────────────────────────────────────────────────

interface GeneratedSpec {
  /** AXIS NAMES ONLY. A label is printed on failure, and a value never is. */
  readonly family: string;
  readonly type: 'CROSS_BROWSER' | 'LOCALIZATION';
  readonly spec: unknown;
}

/**
 * FNV-1a, 32-bit — the seed mixer, copied for the reason browser-matrix.ts and
 * synthetic.ts already record: ten lines of fixed-output arithmetic is the
 * cheapest thing in this repo to copy, and it is not exported from either.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The seed.
 *
 * A FIXED STRING and never a clock or a run id: a corpus that differs between
 * two runs is a corpus where a failure cannot be reproduced from the output,
 * and a flaky adversary test is an adversary test somebody deletes.
 */
const SEED = 'matrix-writepath-adversary';
const pickFrom = <T,>(values: readonly T[], salt: string): T =>
  values[fnv1a32(`${SEED}|${salt}`) % values.length]!;

/**
 * How many specs the higher-order layer samples.
 *
 * WHAT IT TRADES, stated rather than implied. The pairwise layer below is
 * EXHAUSTIVE — every (axis value, axis value) pairing this file knows about is
 * planned and driven, with no sampling anywhere in it. Above two axes the space
 * is the full cross product of nine vocabularies, so this layer SAMPLES: it
 * picks the axes and one value each by hashing {@link SEED}, which makes the
 * sample identical in every checkout and on every run, and it means a defect
 * that needs THREE specific values at once and is invisible at two can be
 * missed. The cost is about a millisecond per sample, so raising this number is
 * nearly free and lowering it is what hides something.
 */
const HIGHER_ORDER_SAMPLES = 400;

/**
 * The ceiling on a generated spec's DECLARED cross product.
 *
 * Not a style rule — here the bound is chosen so that every cell of every
 * generated spec is PLANNED, because the cap never bites (see below).
 * `enumerateMatrix` used to materialise the WHOLE product before the cap
 * selected from it, so the widest spec `matrixAxesSchema` accepts (3 engines x
 * 9 channels x 8 versions x 24 devices x 3 x 2 x 2 x 20 locales x 20 zones)
 * built 24,883,200 cell objects to keep twelve: 5.9 s and 3.7 GB resident, and
 * an uncatchable heap abort at a 1 GB heap. That is FIXED — it decodes only the
 * cells it keeps, and `browser-matrix.test.ts` holds it with a read count and a
 * differential against the old implementation — so this bound no longer defends
 * the suite from the library; it is kept because a corpus whose product exceeds
 * the cap would plan a seeded twelfth of it and quietly stop driving the rest.
 *
 * Every axis combination below is CHUNKED to at most `MATRIX_MAX_CELLS` values
 * on the varying axis, which has a second effect worth having: the cap never
 * bites, so every cell of every generated spec is actually planned and driven
 * rather than a seeded twelfth of them.
 */
const MAX_DECLARED_PRODUCT = MATRIX_MAX_CELLS;

const chunk = <T,>(values: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
};

const BROWSER_FLOORS: ReadonlyArray<readonly string[]> = [
  ['chromium'],
  ['firefox'],
  ['webkit'],
  ['chromium', 'firefox', 'webkit'],
  ['webkit', 'firefox'],
];

function buildCorpus(): GeneratedSpec[] {
  const specs: GeneratedSpec[] = [];
  const cb = (family: string, spec: unknown) =>
    specs.push({ family: `CROSS_BROWSER ${family}`, type: 'CROSS_BROWSER', spec });
  const l10n = (family: string, spec: unknown) =>
    specs.push({ family: `LOCALIZATION ${family}`, type: 'LOCALIZATION', spec });

  // 1. Every value of every axis, on its own. This is where a single-axis key
  //    defect lives — `'<unvaried>+dark'` and `'>=120<130'` were both here.
  for (const axis of AXIS_NAMES) {
    for (const group of chunk(AXIS_VALUES[axis], MAX_DECLARED_PRODUCT)) {
      cb(`solo ${axis}`, { browsers: ['chromium'], matrix: { [axis]: group } });
    }
  }

  // 2. EXHAUSTIVE over every pairing of axis values. Two of the six defects —
  //    engines crossed with channels, and a channel with no engines axis —
  //    needed exactly two axes and were invisible with one, which is the
  //    lesson: the two tests that drove an unhonourable cell each varied
  //    exactly ONE axis, so neither ever reached the length that broke.
  for (let i = 0; i < AXIS_NAMES.length; i += 1) {
    for (let j = i + 1; j < AXIS_NAMES.length; j += 1) {
      const [a, b] = [AXIS_NAMES[i]!, AXIS_NAMES[j]!];
      for (const fixed of AXIS_VALUES[a]) {
        for (const group of chunk(AXIS_VALUES[b], MAX_DECLARED_PRODUCT)) {
          cb(`pair ${a} x ${b}`, { browsers: ['chromium'], matrix: { [a]: [fixed], [b]: group } });
        }
      }
    }
  }

  // 3. All nine axes at once, at one value each, so the widest CELL — the one
  //    that varies everything and whose refusal sentence names every axis this
  //    harness cannot honour — is in the corpus at both ends of its ceilings.
  const narrow: Record<string, unknown[]> = {};
  const widest: Record<string, unknown[]> = {};
  for (const axis of AXIS_NAMES) {
    const values = AXIS_VALUES[axis];
    narrow[axis] = [values[0]];
    widest[axis] = [values[values.length - 1]];
  }
  for (const browsers of BROWSER_FLOORS) {
    cb('all axes, narrowest value', { browsers, matrix: narrow });
    cb('all axes, widest value', { browsers, matrix: widest });
  }

  // 4. The `browsers` floor, with and without a matrix beside it.
  for (const browsers of BROWSER_FLOORS) {
    cb('browsers only', { browsers });
    cb('browsers + locales', { browsers, matrix: { locales: TAGS.slice(0, 4) } });
  }
  cb('empty spec, every default', {});

  // 5. The higher-order sample. Seeded, bounded, and one value per axis so the
  //    declared product stays at one cell.
  for (let n = 0; n < HIGHER_ORDER_SAMPLES; n += 1) {
    const matrix: Record<string, unknown[]> = {};
    const chosen: string[] = [];
    for (const axis of AXIS_NAMES) {
      if (fnv1a32(`${SEED}|${n}|${axis}|in`) % 3 === 0) continue;
      matrix[axis] = [pickFrom(AXIS_VALUES[axis], `${n}|${axis}|value`)];
      chosen.push(axis);
    }
    if (chosen.length < 3) continue;
    cb(`sampled ${chosen.join('+')}`, {
      browsers: pickFrom(BROWSER_FLOORS, `${n}|browsers`),
      matrix,
    });
  }

  // 6. A value written TWICE on one axis. A spec the schema accepts, and until
  //    `crossBrowserPlan` deduplicated the axes it planned two identical cells
  //    — which `planMatrix` refuses WHOLE, so the test ran nothing. In the
  //    corpus and not only in its own describe, because the property is about
  //    every spec the schema accepts and this is one of them.
  for (const axis of AXIS_NAMES) {
    const value = AXIS_VALUES[axis][0];
    cb(`repeated ${axis} value`, {
      browsers: ['chromium'],
      // An engine beside it, so a channel or a version pin is declarable.
      matrix: { engines: ['chromium'], [axis]: [value, value] },
    });
  }

  // 7. LOCALIZATION: exhaustive over tag x zone, in both directions, plus the
  //    pairing that cost every row of a localisation run — one tag, two zones.
  for (const tag of TAGS) {
    l10n('one tag, no zone', { locales: [{ tag }] });
    for (const group of chunk(ZONES, MAX_DECLARED_PRODUCT)) {
      l10n('one tag, many zones', { locales: group.map((timezone) => ({ tag, timezone })) });
    }
  }
  for (const timezone of ZONES) {
    for (const group of chunk(TAGS, MAX_DECLARED_PRODUCT)) {
      l10n('many tags, one zone', { locales: group.map((tag) => ({ tag, timezone })) });
    }
  }
  l10n('one tag, with and without a zone', {
    locales: [{ tag: 'en-US' }, { tag: 'en-US', timezone: 'UTC' }],
  });
  l10n('a repeated pairing', { locales: [{ tag: 'en-US' }, { tag: 'en-US' }] });
  l10n('a repeated pairing with a zone', {
    locales: [
      { tag: 'en-US', timezone: 'UTC' },
      { tag: 'en-US', timezone: 'UTC' },
    ],
  });
  // The FLOOR of both pairing fields, as the pairing's OWN schema declares it.
  // A schema that lets a pairing declare an empty zone puts '' here, and the
  // evidence schema then refuses the row — so this is red on that schema alone.
  l10n('the narrowest pair both fields allow', {
    locales: [{ tag: tagOfLength(PAIRING_TAG_MIN), timezone: zoneOfLength(PAIRING_ZONE_MIN) }],
  });
  l10n('a zone on its floor beside a tag on its ceiling', {
    locales: [{ tag: tagOfLength(TAG_MAX), timezone: zoneOfLength(PAIRING_ZONE_MIN) }],
  });
  l10n('the widest pair both fields allow', {
    locales: [{ tag: tagOfLength(TAG_MAX), timezone: zoneOfLength(ZONE_MAX) }],
  });
  // The array's own ceiling, so the cap DOES bite here and the capped plan is
  // driven through the write path like any other.
  l10n('the locales array at its ceiling', {
    locales: Array.from({ length: axisCeiling('locales') }, (_, i) => ({
      tag: TAGS[i % TAGS.length]!,
      timezone: ZONES[i % ZONES.length]!,
    })),
  });

  return specs;
}

const CORPUS = buildCorpus();

// ─── Driving the real chain ──────────────────────────────────────────────────

/**
 * The deployments a cell is resolved against.
 *
 * THE FIRST ONE IS WHAT PRODUCTION DOES: neither `crossBrowserPlan` nor
 * `localizationPlan` passes a `deployment` to `planMatrix`, so every cell
 * resolves without a probe. The other three re-plan the SAME cells with a
 * capability injected, which is the only way `MISSING` and `WRONG_VERSION`
 * evidence reaches the validators at all — those two statuses are unreachable
 * from a spec today, and that is recorded as a finding rather than papered over
 * here. The day a preflight is threaded into the plugins, this layer is already
 * holding the property for it.
 */
const PROBED_VERSIONS: Record<string, string> = {};
for (const channel of [...BROWSER_CHANNEL_LIST, undefined]) {
  for (const engine of [...BROWSER_ENGINE_LIST, undefined]) {
    const cell = {
      ...(engine === undefined ? {} : { engine }),
      ...(channel === undefined ? {} : { channel }),
    } as MatrixCell;
    PROBED_VERSIONS[variantBrowserKey(cell)] = '125.0.1';
  }
}
const everyEngine = (installed: boolean) =>
  Object.fromEntries(BROWSER_ENGINE_LIST.map((e) => [e, installed]));
const everyChannel = (resolved: boolean) =>
  Object.fromEntries(BROWSER_CHANNEL_LIST.map((c) => [c, resolved]));
const everyPreset = (known: boolean) =>
  Object.fromEntries(DEVICE_PRESET_LIST.map((p) => [p, known]));

const DEPLOYMENTS: ReadonlyArray<{ name: string; capability: DeploymentBrowsers | null }> = [
  { name: 'as production plans it, with no probe at all', capability: null },
  { name: 'probed and empty', capability: {} },
  {
    name: 'everything probed and present',
    capability: {
      engines: everyEngine(true),
      channels: everyChannel(true),
      devicePresets: everyPreset(true),
      versions: PROBED_VERSIONS,
    },
  },
  {
    name: 'probed and nothing installed',
    capability: {
      engines: everyEngine(false),
      channels: everyChannel(false),
      devicePresets: everyPreset(false),
    },
  },
];

/**
 * The three outcome shapes a cell comes back in.
 *
 * `failed with a message over the bound` is not decoration: the first cell that
 * FAILED with a long Playwright message made the whole variant list unstorable
 * once already, and that is the only time a per-cell row was worth having.
 * `nothing reported` is the path where every row carries a typed `notRun` and a
 * non-empty `notAsserted`, which is a different half of the schema.
 */
const OVERLONG_MESSAGE = 'x'.repeat(20_000);
const OUTCOME_MODES = ['every cell passed', 'every cell failed, verbosely', 'nothing reported'] as const;
type OutcomeMode = (typeof OUTCOME_MODES)[number];

const PARENT = {
  orgId: 'org-adversary',
  projectId: 'project-adversary',
  runId: 'run-adversary',
  testId: 'test-adversary',
  testResultId: 'result-adversary',
};

interface Refusal {
  readonly family: string;
  readonly deployment: string;
  readonly mode: OutcomeMode;
  readonly where: string;
  /** Zod paths, or a classification of a `planMeasurements` sentence. NEVER a value. */
  readonly paths: readonly string[];
}

interface DriveResult {
  readonly refusals: readonly Refusal[];
  readonly statuses: ReadonlySet<MatrixCellStatus>;
  readonly widest: { browser: number; viewport: number; locale: number; why: number };
  readonly unhonouredAxes: number;
  readonly rows: number;
  readonly plannedCells: number;
}

/**
 * `planMeasurements` refuses with a SENTENCE, and the sentence embeds the cell
 * key. Classified into the rule that fired rather than reported raw, for the
 * reason rule 3 gives: a key is customer-authored text and a report of one is a
 * report of a value.
 */
function refusalRule(why: string): string {
  if (/twice/.test(why)) return 'DUPLICATE_CELL';
  if (/none of the five dimensions varied/.test(why)) return 'UNVARIED_CELL';
  if (/both an error message and a not-run/.test(why)) return 'ERROR_MESSAGE_AND_NOT_RUN';
  if (/matrix cells; at most/.test(why)) return 'TOO_MANY_CELLS';
  if (/browser\/viewport/.test(why)) return 'IDENTITY_DISAGREES_WITH_DETAIL';
  if (/nested under the cell/.test(why)) return 'READING_NAMES_ANOTHER_CELL';
  return 'UNCLASSIFIED_REFUSAL';
}

function drive(corpus: readonly GeneratedSpec[]): DriveResult {
  const refusals: Refusal[] = [];
  const statuses = new Set<MatrixCellStatus>();
  const widest = { browser: 0, viewport: 0, locale: 0, why: 0 };
  let unhonouredAxes = 0;
  let rows = 0;
  let plannedCells = 0;

  for (const generated of corpus) {
    const parsed =
      generated.type === 'CROSS_BROWSER'
        ? crossBrowserSpecSchema.safeParse(generated.spec)
        : localizationSpecSchema.safeParse(generated.spec);
    if (!parsed.success) {
      // A spec the schema REFUSES is not this property's subject — but a
      // corpus that is quietly all refusals proves nothing, so it is reported
      // rather than skipped in silence.
      refusals.push({
        family: generated.family,
        deployment: '—',
        mode: 'every cell passed',
        where: 'the spec schema refused its own generated spec',
        paths: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'),
      });
      continue;
    }

    const planned =
      generated.type === 'CROSS_BROWSER'
        ? crossBrowserPlan(parsed.data as never, SEED)
        : localizationPlan(parsed.data as never, SEED);

    for (const { name, capability } of DEPLOYMENTS) {
      const plan =
        capability === null
          ? planned
          : refuseUnhonourableCells(
              planMatrix({
                cells: [
                  ...planned.runnable.map((execution) => execution.cell),
                  ...planned.refused.map((refusal) => refusal.cell),
                ],
                seed: SEED,
                maxCells: MATRIX_MAX_CELLS,
                deployment: capability,
              }),
            );

      if (plan.problems.length > 0) {
        /*
         * A PLAN NOBODY COULD READ IS THE SAME TOTAL LOSS ONE STEP EARLIER.
         * `runMatrixCells` returns the ENTIRE test as SKIPPED with a NOT_RUN,
         * so no cell of it is attempted and no variant row is written — which
         * is why this counts as a refusal of the property and not as a
         * generation mishap.
         */
        refusals.push({
          family: generated.family,
          deployment: name,
          mode: 'every cell passed',
          where: 'planMatrix refused the declaration',
          paths: [plan.problems.length === 1 ? 'one problem' : `${plan.problems.length} problems`],
        });
        continue;
      }
      plannedCells += plan.runnable.length + plan.refused.length;

      for (const mode of OUTCOME_MODES) {
        const outcomes: CellOutcome[] =
          mode === 'nothing reported'
            ? []
            : plan.runnable.map((execution) => ({
                cell: execution.cell,
                status: mode === 'every cell passed' ? 'PASSED' : 'FAILED',
                durationMs: 1,
                errorMessage: mode === 'every cell passed' ? null : OVERLONG_MESSAGE,
                retriedAndPassed: false,
              }));

        const { variants } = variantsFor(
          plan,
          { role: 'auth-profile-adversary', environment: 'environment-adversary' },
          outcomes,
        );
        rows += variants.length;

        for (const variant of variants) {
          widest.browser = Math.max(widest.browser, variant.key.browser.length);
          widest.viewport = Math.max(widest.viewport, variant.key.viewport.length);
          widest.locale = Math.max(widest.locale, variant.key.locale.length);
          widest.why = Math.max(widest.why, variant.notRun?.why.length ?? 0);
          if (variant.cell) {
            statuses.add(variant.cell.cellStatus);
            const unhonoured = Object.entries(variant.cell.matrixCell).filter(
              ([axis]) => HARNESS_HONOURS[axis as keyof MatrixCell] !== true,
            ).length;
            unhonouredAxes = Math.max(unhonouredAxes, unhonoured);
          }

          const key = testVariantKeySchema.safeParse(variant.key);
          if (!key.success) {
            refusals.push({
              family: generated.family,
              deployment: name,
              mode,
              where: 'testVariantKeySchema',
              paths: [...new Set(key.error.issues.map((i) => i.path.join('.') || '(root)'))].sort(),
            });
          }
          const row = testResultVariantSchema.safeParse(variant);
          if (!row.success) {
            refusals.push({
              family: generated.family,
              deployment: name,
              mode,
              where: 'testResultVariantSchema',
              paths: [...new Set(row.error.issues.map((i) => i.path.join('.') || '(root)'))].sort(),
            });
          }
        }

        const measurements = planMeasurements(PARENT, variants, []);
        if (!measurements.ok) {
          refusals.push({
            family: generated.family,
            deployment: name,
            mode,
            where: 'planMeasurements',
            paths: [refusalRule(measurements.why)],
          });
        }
      }
    }
  }

  return { refusals, statuses, widest, unhonouredAxes, rows, plannedCells };
}

const RESULT = drive(CORPUS);

/** One line per distinct refusal signature, counted. Paths and axis names only. */
function report(refusals: readonly Refusal[]): string {
  const grouped = new Map<string, number>();
  for (const refusal of refusals) {
    const signature = `${refusal.where} @ ${refusal.paths.join(', ')} — first seen on [${refusal.family}] against [${refusal.deployment}] with [${refusal.mode}]`;
    grouped.set(signature, (grouped.get(signature) ?? 0) + 1);
  }
  return [...grouped]
    .sort((a, b) => b[1] - a[1])
    .map(([signature, count]) => `${count} row(s): ${signature}`)
    .join('\n');
}

// ─── The property ────────────────────────────────────────────────────────────

describe('ADVERSARY — THE WRITE PATH: a key a producer can emit is a key a column can hold', () => {
  it('EVERY spec the schema accepts produces rows BOTH ingest paths accept', () => {
    expect(
      report(RESULT.refusals),
      `${RESULT.refusals.length} refused row(s) out of ${RESULT.rows} driven from ${CORPUS.length} specs`,
    ).toBe('');
    expect(RESULT.refusals).toEqual([]);
  });

  it('the corpus covers every axis the schema declares, and no axis it does not', () => {
    /*
     * The run-time half of `Record<keyof Required<MatrixAxes>, …>` above. The
     * compiler catches an axis added to the TYPE; this catches one added to the
     * SCHEMA whose type somebody widened by hand, and it is the cheaper of the
     * two to read.
     */
    expect([...AXIS_NAMES].sort()).toEqual([...SCHEMA_AXIS_NAMES].sort());
  });

  it('every finite axis is swept WHOLE, so a tenth channel is covered the day it lands', () => {
    expect(AXIS_VALUES.engines).toEqual(BROWSER_ENGINE_LIST);
    expect(AXIS_VALUES.channels).toEqual(BROWSER_CHANNEL_LIST);
    expect(AXIS_VALUES.colourSchemes).toEqual(COLOUR_SCHEME_LIST);
    expect(AXIS_VALUES.reducedMotion).toEqual(REDUCED_MOTION_LIST);
    expect(AXIS_VALUES.forcedColors).toEqual(FORCED_COLORS_LIST);
    // The device axis is its whole preset list PLUS explicit viewports, which
    // have no vocabulary to sweep — so the containment, not the equality.
    for (const preset of DEVICE_PRESET_LIST) {
      expect(AXIS_VALUES.devices).toContainEqual({ kind: 'PRESET', preset });
    }
  });

  it('no two values on one axis key alike, which is the precondition the property needs', () => {
    /*
     * `matrixCellKey` is the identity `planMatrix` deduplicates on, so two
     * values of one axis that produce the same key are a declaration it refuses
     * WHOLE — the loss, not the subject. The corpus is built to hold no such
     * pair; this is what keeps it that way when somebody adds a value.
     */
    for (const axis of AXIS_NAMES) {
      const keys = AXIS_VALUES[axis].map((value) =>
        matrixCellKey({ [CELL_FIELD_FOR_AXIS[axis]]: value }),
      );
      expect(new Set(keys).size, `two ${axis} values share one cell key`).toBe(keys.length);
    }
  });

  it('the corpus is identical on every run, so a failure can be reproduced from its label', () => {
    const again = buildCorpus();
    expect(again.length).toBe(CORPUS.length);
    expect(again.map((spec) => spec.family)).toEqual(CORPUS.map((spec) => spec.family));
    expect(fnv1a32(JSON.stringify(again))).toBe(fnv1a32(JSON.stringify(CORPUS)));
  });

  it('no generated spec asks `enumerateMatrix` to materialise more than it keeps', () => {
    /*
     * The bound exists so the cap NEVER BITES on a generated spec: a corpus
     * that wandered past it would plan a seeded twelfth of its cells and the
     * rest would stop being driven through the write path without anything
     * going red. (It used to be a guard against `enumerateMatrix` materialising
     * the whole product too; that is fixed and held in browser-matrix.test.ts.)
     */
    for (const generated of CORPUS) {
      const matrix = (generated.spec as { matrix?: Record<string, unknown[]> }).matrix;
      if (matrix === undefined) continue;
      const product = Object.values(matrix).reduce((running, values) => running * values.length, 1);
      expect(product, `[${generated.family}] declares ${product} cells`).toBeLessThanOrEqual(
        MAX_DECLARED_PRODUCT,
      );
    }
  });
});

// ─── Non-vacuity: did the corpus REACH the places the defects lived? ─────────

describe('ADVERSARY — THE WRITE PATH: the corpus reaches the lengths that broke', () => {
  it('drives EVERY cell status, including the one minted for an impossible cell', () => {
    /*
     * `UNSUPPORTED_COMBINATION` is the status a cross of engines with channels
     * produces, and the EVIDENCE for such a cell was refused at
     * `cell.matrixCell.channel` until the declaration rules came off the
     * evidence schema — which made the one status that exists to record an
     * impossible cell unstorable for every cell that was actually impossible.
     * Swept over the exported list, so a seventh status is uncovered loudly.
     */
    expect([...RESULT.statuses].sort()).toEqual([...MATRIX_CELL_STATUS_LIST].sort());
  });

  it('drives a cell varying EVERY axis this harness cannot honour, which is what broke 500', () => {
    const unhonourable = Object.values(HARNESS_HONOURS).filter((honoured) => !honoured).length;
    expect(RESULT.unhonouredAxes).toBe(unhonourable);
    /*
     * And the sentence that cell produces has to FIT. `harnessSupport` composes
     * 482 characters of template plus the names of the axes the cell varied: one
     * axis fits in 500, two do not, and all of them reach 549 — which refused
     * the row, which refused the matrix whole. The bound is read off the schema
     * rather than restated, so tightening it goes red here instead of going
     * quiet in production.
     */
    const whyMax: number = innerSchema((testResultVariantSchema as any).shape.notRun).shape.why
      .maxLength;
    expect(RESULT.widest.why).toBeGreaterThan(500);
    expect(RESULT.widest.why).toBeLessThanOrEqual(whyMax);
  });

  it('produces the widest key each dimension can be ASKED to hold, and it fits', () => {
    /*
     * Derived from the spec schemas' own ceilings and compared against the
     * column's, so neither figure is restated here:
     *
     *   browser  — engine + ':' + the longest channel name + '@>=' + a numeral
     *              + '..' + a numeral, each `.max(NUMERAL_MAX)`;
     *   viewport — the widest explicit screen plus all three rendering
     *              preferences, joined with '+';
     *   locale   — a tag at its ceiling, '@', a zone at its ceiling.
     *
     * The `locale` column was `.max(40)` against a producer that emits
     * TAG_MAX + 1 + ZONE_MAX, and the cost was every row of the run.
     */
    const longestChannel = [...BROWSER_CHANNEL_LIST].sort((a, b) => b.length - a.length)[0]!;
    const widestBrowserKey =
      'chromium'.length + 1 + longestChannel.length + 3 + NUMERAL_MAX + 2 + NUMERAL_MAX;
    expect(RESULT.widest.browser).toBe(widestBrowserKey);
    expect(RESULT.widest.locale).toBe(TAG_MAX + 1 + ZONE_MAX);

    const bound = (dimension: 'browser' | 'viewport' | 'locale'): number =>
      innerSchema((testVariantKeySchema as any).shape[dimension]).maxLength as number;
    for (const dimension of ['browser', 'viewport', 'locale'] as const) {
      expect(RESULT.widest[dimension], dimension).toBeGreaterThan(0);
      expect(RESULT.widest[dimension], dimension).toBeLessThanOrEqual(bound(dimension));
    }
  });

  it('holds a spec for every defect this file replaces, so it cannot pass over nothing', () => {
    const families = CORPUS.map((generated) => generated.family);
    const has = (needle: string) => families.some((family) => family.includes(needle));
    // `'<unvaried>+dark'` — a rendering preference with no screen beside it.
    expect(has('solo colourSchemes')).toBe(true);
    // `'>=120<130'` — a bounded version window, which is only in the versions axis.
    expect(has('solo versions')).toBe(true);
    expect(
      VERSIONS.some((pin) => pin.kind === 'RANGE' && pin.range.below !== null),
      'no bounded window in the corpus, so the bracket defect is unreachable',
    ).toBe(true);
    // `'<default>:MSEDGE_DEV'` — a channel with no engines axis.
    expect(has('solo channels')).toBe(true);
    // The engines x channels cross, whose evidence was refused.
    expect(has('pair engines x channels')).toBe(true);
    // One locale, two zones — two cells and, until the composite key, one row.
    expect(has('one tag, many zones')).toBe(true);
    expect(ZONES.length).toBeGreaterThan(1);
  });

  it('drives real rows rather than planning nothing, which is how a sweep passes vacuously', () => {
    expect(CORPUS.length).toBeGreaterThan(500);
    expect(RESULT.plannedCells).toBeGreaterThan(1_000);
    expect(RESULT.rows).toBeGreaterThan(1_000);
  });
});

// ─── A value written twice is one decision, not an unrunnable spec ───────────

describe('ADVERSARY — THE WRITE PATH: a repeated axis value is one decision typed twice', () => {
  /*
   * `crossBrowserPlan` has always deduplicated `browsers` — the schema says
   * listing chromium again "is harmless" and a duplicate reaching `planMatrix`
   * is a refusal there, "which would turn a harmless spec into an unrunnable
   * one". The other EIGHT axes got neither that nor `engineAxisFor`'s `Set`, so
   * `{ locales: ['en-US', 'en-US'] }` planned two identical cells, `planMatrix`
   * reported a duplicate, and `runMatrixCells` returned the WHOLE TEST as
   * SKIPPED with zero variant rows.
   */
  it('still plans a cell when ANY axis repeats a value — derived from the axis list', () => {
    for (const axis of AXIS_NAMES) {
      const value = AXIS_VALUES[axis][0];
      const spec = crossBrowserSpecSchema.safeParse({
        browsers: ['chromium'],
        // An engine beside it, so a channel or a version pin is a legal declaration.
        matrix: { engines: ['chromium'], [axis]: [value, value] },
      });
      expect(spec.success, `the schema refused a repeat on ${axis}`).toBe(true);
      if (!spec.success) continue;
      const plan = crossBrowserPlan(spec.data, SEED);
      expect(plan.problems, `a repeated ${axis} value refused the whole declaration`).toEqual([]);
      expect(
        plan.runnable.length + plan.refused.length,
        `a repeated ${axis} value planned no cell at all`,
      ).toBeGreaterThan(0);
    }
  });

  it('still plans a cell when a LOCALIZATION pairing is written twice, zone or no zone', () => {
    for (const locales of [
      [{ tag: 'en-US' }, { tag: 'en-US' }],
      [
        { tag: 'en-US', timezone: 'UTC' },
        { tag: 'en-US', timezone: 'UTC' },
      ],
    ]) {
      const spec = localizationSpecSchema.safeParse({ locales });
      expect(spec.success).toBe(true);
      if (!spec.success) continue;
      const plan = localizationPlan(spec.data, SEED);
      expect(plan.problems).toEqual([]);
      expect(plan.runnable.length).toBe(1);
    }
  });

  it('does NOT collapse two values that differ, which is the over-fix', () => {
    const spec = crossBrowserSpecSchema.parse({
      browsers: ['chromium'],
      matrix: { locales: ['en-US', 'en-US', 'de-DE'], timezones: ['UTC', 'UTC'] },
    });
    const plan = crossBrowserPlan(spec, SEED);
    expect(plan.problems).toEqual([]);
    expect(plan.runnable.length).toBe(2);
    // Property order must not forge a difference either: these are one screen.
    const devices = crossBrowserSpecSchema.parse({
      browsers: ['chromium'],
      matrix: {
        devices: [
          { kind: 'VIEWPORT', viewport: { width: 1280, height: 800 } },
          { kind: 'VIEWPORT', viewport: { height: 800, width: 1280 } },
        ],
      },
    });
    const devicePlan = crossBrowserPlan(devices, SEED);
    expect(devicePlan.problems).toEqual([]);
    expect(devicePlan.runnable.length + devicePlan.refused.length).toBe(1);
  });
});

// ─── What the cell key cannot tell apart, pinned where it can be found ───────

describe('ADVERSARY — THE WRITE PATH: two cells the key cannot tell apart', () => {
  /*
   * RECORDED, NOT REPAIRED, and the distinction is deliberate. These two shapes
   * lose a whole test — but they lose it LOUDLY, through `planMatrix`'s
   * duplicate refusal, which names the key and reaches the customer as a
   * SKIPPED test with a NOT_RUN sentence. That is a different animal from the
   * six defects above, every one of which wrote nothing behind a `logger.warn`.
   *
   * The repair wanted is a DOOR REFUSAL on the devices axis, not a wider key: a
   * digest of the user agent in the key would re-identify every `.../ua` row
   * already stored, and an escaped key is a key nobody can read back. The exact
   * line belongs on `matrixAxesSchema` in packages/shared/src/schemas.ts, which
   * this file does not own.
   */
  it('two explicit viewports differing ONLY by user agent are refused, loudly', () => {
    const sameScreen = (userAgent: string) => ({
      kind: 'VIEWPORT' as const,
      viewport: { width: 1280, height: 800, userAgent },
    });
    const spec = crossBrowserSpecSchema.safeParse({
      browsers: ['chromium'],
      matrix: { devices: [sameScreen('an agent'), sameScreen('a different agent')] },
    });
    // The schema ACCEPTS the pair: a user agent is free text and nothing
    // cross-checks two of them.
    expect(spec.success).toBe(true);
    if (!spec.success) return;
    // `deviceKey` records a user agent as the presence marker `ua` and never
    // its value, so both cells carry one key.
    expect(matrixCellKey({ device: sameScreen('an agent') })).toBe(
      matrixCellKey({ device: sameScreen('a different agent') }),
    );
    const plan = crossBrowserPlan(spec.data, SEED);
    expect(plan.problems.length).toBe(1);
    expect(plan.problems[0]).toMatch(/declared more than once/);
    expect(plan.runnable.length + plan.refused.length).toBe(0);
  });

  it('two version pins differing ONLY in `why` are refused, and that one is CORRECT', () => {
    /*
     * The same blindness and the opposite verdict: `versionKey` drops the
     * reason because a reason is documentation, so two windows with the same
     * bounds ARE one cell however they are justified. Pinned beside its
     * neighbour so the next reader does not "fix" both with one change.
     */
    const window = (why: string) => ({ kind: 'RANGE' as const, range: { atLeast: '120', below: null, why } });
    const spec = crossBrowserSpecSchema.parse({
      browsers: ['chromium'],
      matrix: { engines: ['chromium'], versions: [window('one reason'), window('another')] },
    });
    const plan = crossBrowserPlan(spec, SEED);
    expect(plan.problems.length).toBe(1);
    expect(plan.problems[0]).toMatch(/declared more than once/);
  });
});
