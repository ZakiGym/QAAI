import { describe, expect, it } from 'vitest';
import {
  BROWSER_CHANNELS,
  BROWSER_CHANNEL_LIST,
  BROWSER_ENGINES,
  BROWSER_ENGINE_LIST,
  BROWSER_PERMISSIONS,
  BROWSER_PERMISSION_LIST,
  CHANNEL_ENGINE,
  COLOUR_SCHEMES,
  COLOUR_SCHEME_LIST,
  DEFAULT_ENGINE_KEY,
  DEVICE_PRESETS,
  DEVICE_PRESET_LIST,
  FORCED_COLORS_LIST,
  FORCED_COLORS_MODES,
  INTERACTION_STATES,
  INTERACTION_STATE_LIST,
  MATRIX_CELL_STATUSES,
  MATRIX_CELL_STATUS_LIST,
  NETWORK_PROFILES,
  NETWORK_PROFILE_LIST,
  NETWORK_PROFILE_SHAPES,
  PLAYWRIGHT_CHANNEL,
  PLAYWRIGHT_DEVICE,
  PLAYWRIGHT_PERMISSION,
  REDUCED_MOTION_LIST,
  REDUCED_MOTION_PREFERENCES,
  STATE_UNREACHED_REASONS,
  STATE_UNREACHED_REASON_LIST,
  UNEXERCISABLE_CELL_STATUSES,
  UNPINNED,
  UNVARIED_CELL,
  baselineViewportKey,
  cellCounts,
  channelExistsFor,
  compareBrowserVersions,
  describeVersionRange,
  enumerateMatrix,
  environmentUnsupportedOn,
  fabricatedEnvironmentFields,
  matrixCellKey,
  parseBrowserVersion,
  parseVersionBound,
  resolveMatrixCell,
  variantBrowserKey,
  variantLocaleKey,
  variantViewportKey,
  variedAxes,
  versionInRange,
} from './browser-matrix';
import type {
  BrowserEnvironment,
  DeploymentBrowsers,
  MatrixAxes,
  MatrixCell,
} from './browser-matrix';
import {
  browserChannelSchema,
  createTestSchema,
  planItemSchema,
  updateTestSchema,
  browserEngineSchema,
  browserEnvironmentSchema,
  browserPermissionSchema,
  colourSchemeSchema,
  devicePresetSchema,
  forcedColorsSchema,
  interactionStateSchema,
  matrixAxesSchema,
  matrixCellSchema,
  matrixCellStatusSchema,
  networkProfileSchema,
  reducedMotionSchema,
  stateUnreachedReasonSchema,
  testMatrixSchema,
  testVariantKeySchema,
  visualCaptureSchema,
  visualTestSpecSchema,
} from './schemas';
import { UNVARIED } from './types';

/*
 * ── The parity guards ───────────────────────────────────────────────────────
 *
 * Every closed union in browser-matrix.ts has TWO mechanisms and each catches
 * what the other cannot. A `Record<Union, true>` in the module makes the
 * COMPILER refuse a member with no entry, which is why every `*_LIST` is derived
 * rather than hand-written. The assertions below are the RUN-TIME half: zod's
 * `.options` exist only at run time, so nothing but an assertion can compare
 * them — and `check:wiring` cannot see this class of defect at all.
 *
 * This is not hypothetical bookkeeping. EIGHT GateRule kinds shipped unsaveable
 * for two slices because only one of the two mechanisms existed: the union grew,
 * the zod enum did not, and there was no write path for the new members.
 */
describe('every closed union has both halves of its parity guard', () => {
  const pairs: Array<[string, readonly string[], readonly string[], { options: readonly string[] }]> =
    [
      ['BROWSER_ENGINES', BROWSER_ENGINES, BROWSER_ENGINE_LIST, browserEngineSchema],
      ['BROWSER_CHANNELS', BROWSER_CHANNELS, BROWSER_CHANNEL_LIST, browserChannelSchema],
      ['DEVICE_PRESETS', DEVICE_PRESETS, DEVICE_PRESET_LIST, devicePresetSchema],
      ['COLOUR_SCHEMES', COLOUR_SCHEMES, COLOUR_SCHEME_LIST, colourSchemeSchema],
      [
        'REDUCED_MOTION_PREFERENCES',
        REDUCED_MOTION_PREFERENCES,
        REDUCED_MOTION_LIST,
        reducedMotionSchema,
      ],
      ['FORCED_COLORS_MODES', FORCED_COLORS_MODES, FORCED_COLORS_LIST, forcedColorsSchema],
      ['INTERACTION_STATES', INTERACTION_STATES, INTERACTION_STATE_LIST, interactionStateSchema],
      [
        'STATE_UNREACHED_REASONS',
        STATE_UNREACHED_REASONS,
        STATE_UNREACHED_REASON_LIST,
        stateUnreachedReasonSchema,
      ],
      ['NETWORK_PROFILES', NETWORK_PROFILES, NETWORK_PROFILE_LIST, networkProfileSchema],
      [
        'BROWSER_PERMISSIONS',
        BROWSER_PERMISSIONS,
        BROWSER_PERMISSION_LIST,
        browserPermissionSchema,
      ],
      [
        'MATRIX_CELL_STATUSES',
        MATRIX_CELL_STATUSES,
        MATRIX_CELL_STATUS_LIST,
        matrixCellStatusSchema,
      ],
    ];

  it.each(pairs)('%s: the derived list is the declared list', (_name, declared, derived) => {
    expect([...derived].sort()).toEqual([...declared].sort());
  });

  it.each(pairs)("%s: the zod schema's options are the declared list", (_name, declared, _d, schema) => {
    expect([...schema.options].sort()).toEqual([...declared].sort());
  });

  it('maps every channel, device and permission to the string a launcher wants', () => {
    // A `Record` keyed on the union, so the COMPILER refuses a member with no
    // mapping — but a mapping that exists and is empty would compile and would
    // launch SOMETHING while being labelled with the requested name.
    for (const channel of BROWSER_CHANNELS) {
      const value = PLAYWRIGHT_CHANNEL[channel];
      // null is the instruction to pass no channel at all, which is what makes
      // BUNDLED mean Playwright's own build. An empty string is not.
      expect(value === null || value.length > 0, channel).toBe(true);
    }
    for (const preset of DEVICE_PRESETS) expect(PLAYWRIGHT_DEVICE[preset].length).toBeGreaterThan(0);
    for (const perm of BROWSER_PERMISSIONS) {
      expect(PLAYWRIGHT_PERMISSION[perm].length).toBeGreaterThan(0);
    }
  });

  it('gives BUNDLED no owning engine and every other channel exactly one', () => {
    // The whole of the "a Firefox beta does not exist" rule, in data.
    expect(CHANNEL_ENGINE.BUNDLED).toBeNull();
    for (const channel of BROWSER_CHANNELS) {
      if (channel === 'BUNDLED') continue;
      expect(CHANNEL_ENGINE[channel], channel).toBe('chromium');
    }
  });

  it('marks OFFLINE as the only profile with the link down', () => {
    for (const profile of NETWORK_PROFILES) {
      expect(NETWORK_PROFILE_SHAPES[profile].offline, profile).toBe(profile === 'OFFLINE');
    }
  });
});

describe('channelExistsFor separates "does not exist" from "not installed"', () => {
  it('lets BUNDLED stand for every engine', () => {
    for (const engine of BROWSER_ENGINES) expect(channelExistsFor(engine, 'BUNDLED')).toBe(true);
  });

  it('refuses a chromium channel on firefox and webkit', () => {
    // There is no Firefox beta build. "Install chrome-beta for Firefox" is
    // advice that cannot be followed, which is why this is not MISSING.
    expect(channelExistsFor('firefox', 'CHROME_BETA')).toBe(false);
    expect(channelExistsFor('webkit', 'MSEDGE')).toBe(false);
    expect(channelExistsFor('chromium', 'CHROME_BETA')).toBe(true);
  });
});

describe('version reading never turns an unreadable string into a number', () => {
  it('does not read the digit in a product name as a version', () => {
    // The defect preflight.ts paid for: `/(\d+(?:\.\d+)*)/` reads `k6 v0.49.0`
    // as version SIX, and `[6]` compares as newer than every floor on earth.
    expect(parseBrowserVersion('k6 v0.49.0')).toEqual([0, 49, 0]);
    expect(parseBrowserVersion('Chromium 121.0.6167.85')).toEqual([121, 0, 6167, 85]);
    expect(parseBrowserVersion('Firefox 128.0')).toEqual([128, 0]);
  });

  it('returns null rather than [0] for anything without a dotted number', () => {
    // `[0]` would compare as older than everything and turn an unparseable
    // banner into a confident WRONG_VERSION against a current browser — the
    // null-became-zero lie in its most expensive form, because it refuses a
    // working tool.
    expect(parseBrowserVersion('nightly')).toBeNull();
    expect(parseBrowserVersion('build 20261027')).toBeNull();
    expect(parseBrowserVersion('')).toBeNull();
  });

  it('treats absent components as zero, so 1.2 equals 1.2.0', () => {
    expect(compareBrowserVersions([1, 2], [1, 2, 0])).toBe(0);
    expect(compareBrowserVersions([1, 2], [1, 3])).toBe(-1);
    expect(compareBrowserVersions([2], [1, 99])).toBe(1);
  });

  it('answers null for an unreadable observation rather than false', () => {
    const range = { atLeast: '120.0', below: null, why: 'the dialog closedby attribute' };
    expect(versionInRange('Chrome 121.0', range)).toBe(true);
    expect(versionInRange('Chrome 119.0', range)).toBe(false);
    // Not false: a version nobody could read is "not checked", and false would
    // refuse a browser that may be perfectly current.
    expect(versionInRange('nightly', range)).toBeNull();
  });

  it('applies a bare-major pin, which the banner heuristic could not read', () => {
    /*
     * THE DEFECT THIS FOUND, in this file, before it shipped. The schema accepts
     * `atLeast: '131'` (`/^\d+(\.\d+)*$/`), the banner reader requires a dot,
     * `versionInRange` therefore returned null, and a cell pinned to Chrome 131
     * running on Chrome 131.0.1 resolved NOT_CHECKED. A pin that silently stops
     * being applied reads as a measurement and measures nothing, and it fails in
     * the one direction nobody looks at.
     */
    expect(parseVersionBound('131')).toEqual([131]);
    expect(parseVersionBound('131.0.1')).toEqual([131, 0, 1]);
    // And it still refuses something that is not a version at all, rather than
    // guessing: a bound nobody could read must stay unreadable all the way to
    // the report.
    expect(parseVersionBound('v131')).toBeNull();
    expect(parseVersionBound('latest')).toBeNull();

    const range = { atLeast: '131', below: null, why: 'a flag' };
    expect(versionInRange('131.0.1', range)).toBe(true);
    expect(versionInRange('130.9.9', range)).toBe(false);
  });

  it('says "no upper bound established" rather than implying one', () => {
    expect(describeVersionRange({ atLeast: '120', below: null, why: 'x' })).toContain(
      'no upper bound established',
    );
    expect(describeVersionRange({ atLeast: '120', below: '130', why: 'x' })).toBe(
      '>= 120 and < 130',
    );
  });
});

describe('the cell key says which axes were varied and which were not', () => {
  it('reports an unvaried engine as <default> rather than chromium', () => {
    // A report that printed "chromium" for a cell that expressed no opinion
    // would be claiming coverage of a browser nobody asked for.
    expect(variantBrowserKey(UNVARIED_CELL)).toBe(DEFAULT_ENGINE_KEY);
    expect(variantViewportKey(UNVARIED_CELL)).toBe(UNVARIED);
    expect(matrixCellKey(UNVARIED_CELL)).toBe(
      `${DEFAULT_ENGINE_KEY}|${UNVARIED}|${UNVARIED}|${UNVARIED}`,
    );
  });

  it('omits an explicit BUNDLED channel and an UNPINNED version from the key', () => {
    // Otherwise there would be TWO keys for one cell — the explicit default and
    // the absent one — and TestResultVariant's unique index would hold both,
    // counting one cell twice in every denominator.
    expect(variantBrowserKey({ engine: 'chromium' })).toBe('chromium');
    expect(variantBrowserKey({ engine: 'chromium', channel: 'BUNDLED' })).toBe('chromium');
    expect(variantBrowserKey({ engine: 'chromium', version: UNPINNED })).toBe('chromium');
  });

  it('omits an explicitly-defaulted viewport field, for the same reason', () => {
    const bare: MatrixCell = { device: { kind: 'VIEWPORT', viewport: { width: 1280, height: 800 } } };
    const explicit: MatrixCell = {
      device: { kind: 'VIEWPORT', viewport: { width: 1280, height: 800, hasTouch: false } },
    };
    expect(variantViewportKey(bare)).toBe('1280x800');
    // Set explicitly, it appears: the caller DID express an opinion, and
    // dropping it would merge two cells the caller kept apart.
    expect(variantViewportKey(explicit)).toBe('1280x800/notouch');
  });

  it('never puts the unvaried sentinel inside a composite viewport key', () => {
    /*
     * `<unvaried>+dark` was the real output here, and it was a value BOTH
     * ingest paths REFUSE: `variantDimension` reserves angle brackets for
     * values that are EXACTLY a sentinel, which is the one thing stopping a
     * caller forging "this dimension was not varied" for a cell that was. And
     * `validateMeasurements` refuses a matrix WHOLE on its first bad cell, so a
     * customer declaring a dark-mode cell lost every variant row of that run —
     * including the cells that ran perfectly — to one log line and no red test.
     *
     * An absent screen segment already MEANS the size was not varied, so
     * dropping the sentinel loses nothing and says nothing untrue.
     */
    expect(variantViewportKey({ colourScheme: 'DARK' })).toBe('dark');
    expect(variantViewportKey({ reducedMotion: 'REDUCE' })).toBe('reduced-motion');
    expect(variantViewportKey({ forcedColors: 'ACTIVE' })).toBe('forced-colors');
    expect(variantViewportKey({ colourScheme: 'LIGHT', reducedMotion: 'NO_PREFERENCE' })).toBe(
      'light+full-motion',
    );
    for (const cell of [
      { colourScheme: 'DARK' } as MatrixCell,
      { reducedMotion: 'REDUCE' } as MatrixCell,
      { forcedColors: 'ACTIVE' } as MatrixCell,
    ]) {
      expect(variantViewportKey(cell)).not.toContain('<');
    }
  });

  it('still keys a cell that names a screen byte-identically, sentinel or not', () => {
    /*
     * The positive control for the repair above, and the reason it is safe:
     * every key that names a device is untouched, which is all of
     * `VisualBaseline`'s — `baselineViewportKey` is only ever handed a cell from
     * `floorCellFor`, which always sets one. A repair that moved these would
     * have silently re-identified every approved baseline in the product.
     */
    const dark: MatrixCell = {
      device: { kind: 'VIEWPORT', viewport: { width: 1280, height: 800 } },
      colourScheme: 'DARK',
    };
    expect(variantViewportKey(dark)).toBe('1280x800+dark');
    expect(baselineViewportKey(dark, 'DEFAULT')).toBe('1280x800+dark');
    // And the no-preference cell keeps the bare sentinel as its WHOLE value,
    // which the refinement accepts and which is what every pre-matrix row holds.
    expect(variantViewportKey(UNVARIED_CELL)).toBe(UNVARIED);
  });

  it('is byte-identical regardless of the order the fields were written in', () => {
    // `JSON.stringify` would not be: property order is insertion order, and an
    // optional field set to `undefined` is not the same key as an absent one.
    const a: MatrixCell = { engine: 'chromium', colourScheme: 'DARK', locale: 'de-DE' };
    const b: MatrixCell = { locale: 'de-DE', colourScheme: 'DARK', engine: 'chromium' };
    expect(matrixCellKey(a)).toBe(matrixCellKey(b));
  });

  it('carries the channel and the version pin into the browser half', () => {
    const cell: MatrixCell = {
      engine: 'chromium',
      channel: 'CHROME_BETA',
      version: { kind: 'RANGE', range: { atLeast: '130', below: '132', why: 'a flag' } },
    };
    // `..` and not `<`: see `versionKey`. The `<` spelling was a value both
    // ingest paths refused, and this assertion passed while every run of such a
    // cell wrote nothing.
    expect(variantBrowserKey(cell)).toBe('chromium:CHROME_BETA@>=130..132');
  });

  it('emits a key the WRITE PATH accepts for the widest cell a spec can declare', () => {
    /*
     * ── THE PARITY NOTHING ENFORCED, AND IT COST EVERY ROW OF A RUN ─────────
     *
     * These two functions are the ONLY producers of `TestResultVariant.browser`
     * and `.viewport`, and `testVariantKeySchema` is the only consumer. Nothing
     * put a key from the first through the second, so the matrix round widened
     * what a cell can vary and left three values the write path refuses:
     *
     *   · `>=120<130` — the `<` is an angle bracket in the middle of a
     *     composite, which `variantDimension` reserves for whole-value
     *     sentinels. ANY bounded version window.
     *   · a browser key of 105 characters against a bound of 60.
     *   · a viewport key of 90 against the same 60.
     *
     * `validateMeasurements` refuses a matrix WHOLE on its first bad cell, so
     * each of those wrote ZERO variant rows for the entire run behind one log
     * line, and the agent path 400s the whole batch. The previous test asserts
     * the key's SPELLING and passed throughout.
     *
     * The cell is built from the SPEC SCHEMA'S OWN CEILINGS — `versionLiteral`
     * is `.max(40)` at both ends, `explicitViewportSchema` caps width and height
     * at 4000, `deviceScaleFactor` is an unrounded double — and is parsed
     * through `matrixCellSchema` first, so this is the widest cell a customer
     * can actually store and not a shape invented to be long. Tighten a bound
     * in schemas.ts and this goes red rather than production going quiet.
     */
    const fortyNumerals = '120.0.6099.109.1.2.3.4.5.6.7.8.9.10.11.1';
    expect(fortyNumerals).toHaveLength(40);
    const widest: MatrixCell = {
      engine: 'chromium',
      channel: 'CHROME_CANARY',
      version: {
        kind: 'RANGE',
        range: { atLeast: fortyNumerals, below: '130.0.6099.109.1.2.3.4.5.6.7.8.9.10.11.1', why: 'a flag' },
      },
      device: {
        kind: 'VIEWPORT',
        viewport: {
          width: 4000,
          height: 4000,
          // An unrounded double, because the schema permits one and this is
          // what makes the segment as long as it can get.
          deviceScaleFactor: 0.1 + 0.2,
          hasTouch: true,
          isMobile: true,
          userAgent: 'QAAI',
        },
      },
      colourScheme: 'LIGHT',
      reducedMotion: 'REDUCE',
      // NONE and not ACTIVE: `variantViewportKey` spells NONE as
      // `no-forced-colors`, which is the longer of the two.
      forcedColors: 'NONE',
      locale: 'de-DE',
      timezone: 'Europe/Berlin',
    };
    expect(matrixCellSchema.safeParse(widest).success).toBe(true);

    const browser = variantBrowserKey(widest);
    const viewport = variantViewportKey(widest);
    /*
     * No `<` anywhere but as a whole value. `variantDimension` tests for `<`
     * alone and not for `>`, which is why `>=120` has always been storable and
     * `>=120<130` never was — the bracket that can start a sentinel is the one
     * that is reserved.
     */
    expect(browser).not.toContain('<');
    expect(viewport).not.toContain('<');

    const parsed = testVariantKeySchema.safeParse({
      browser,
      viewport,
      locale: widest.locale,
      role: UNVARIED,
      environment: 'env-1',
    });
    // The PATHS, never the key text: a failure must name the dimension the way
    // `validateMeasurements` does, not print a 100-character key into a diff.
    expect(
      parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'),
    ).toEqual([]);
  });

  it('names only the axes a cell actually varied', () => {
    expect(variedAxes(UNVARIED_CELL)).toEqual([]);
    expect(variedAxes({ engine: 'webkit', channel: 'BUNDLED', version: UNPINNED })).toEqual([
      'engine',
    ]);
    expect(variedAxes({ colourScheme: 'DARK', timezone: 'Europe/Berlin' })).toEqual([
      'colourScheme',
      'timezone',
    ]);
  });
});

describe('the locale dimension carries the timezone', () => {
  /**
   * The expression this column was built with before `variantLocaleKey`
   * existed, held here as the thing the two unvaried shapes are compared
   * AGAINST rather than a literal somebody typed. A literal pins the spelling
   * of this test; this pins the spelling production has already stored, which
   * is the half that decides whether a historical row keeps its identity.
   */
  const previousProducer = (cell: MatrixCell): string => cell.locale ?? UNVARIED;

  it('is byte-identical to the old expression for every cell naming no timezone', () => {
    const noZone: MatrixCell[] = [
      UNVARIED_CELL,
      { locale: 'en-US' },
      { locale: 'ar-EG' },
      { engine: 'chromium', colourScheme: 'DARK', locale: 'ja-JP' },
    ];
    for (const cell of noZone) {
      expect(variantLocaleKey(cell)).toBe(previousProducer(cell));
    }
    // The two values that identity consists of, named once so a reader sees
    // what byte-identity means here.
    expect(variantLocaleKey(UNVARIED_CELL)).toBe(UNVARIED);
    expect(variantLocaleKey({ locale: 'en-US' })).toBe('en-US');
  });

  it('spells both composites with the separator the browser key already uses', () => {
    expect(variantLocaleKey({ locale: 'en-US', timezone: 'America/New_York' })).toBe(
      'en-US@America/New_York',
    );
    expect(variantLocaleKey({ timezone: 'America/New_York' })).toBe('@America/New_York');
  });

  it('never puts a sentinel INSIDE a composite, which both ingest paths refuse', () => {
    /*
     * `'<unvaried>@America/New_York'` reads perfectly and stores nowhere.
     * `variantDimension` reserves an angle bracket for a value that is EXACTLY
     * a sentinel — the one thing that stops a producer claiming an axis was not
     * varied when it was — so a bracket mid-composite is refused, and
     * `validateMeasurements` refuses a matrix WHOLE on its first bad cell. That
     * is the `'<unvaried>+dark'` defect of this round, one dimension over.
     */
    const timezoneOnly = variantLocaleKey({ timezone: 'America/New_York' });
    expect(timezoneOnly).not.toContain('<');
    expect(timezoneOnly.startsWith('@')).toBe(true);
  });

  it('emits a locale column the WRITE PATH accepts for the widest pair a spec declares', () => {
    /*
     * ── THE BOUND IS HALF OF THIS CHANGE, AND A SPELLING TEST CANNOT SEE IT ──
     *
     * The composite widened this column from a tag to a tag AND a zone, and the
     * ceilings are the spec schemas' own: `locale` is `.max(35)` and `timezone`
     * `.max(64)` on `matrixCellSchema`, on `matrixAxesSchema`'s two axes and on
     * `localizationSpecSchema`. So the widest LEGAL pair is 100 characters,
     * where the column used to hold 35 — and a column narrower than that
     * refuses its own producer, which costs the whole matrix behind one log
     * line exactly as the `'<unvaried>+dark'` and `'>=120<130'` leaks did.
     *
     * Derived from the schemas rather than restated, and parsed through
     * `matrixCellSchema` first, so this is the widest cell a customer can
     * actually store. Tighten either bound and this goes red instead of
     * production going quiet.
     */
    const widest: MatrixCell = {
      // A real tag and a real zone, padded to the ceiling rather than invented
      // at it, so the shape stays recognisable to anyone reading the failure.
      locale: 'en-Latn-US-u-ca-gregory-nu-latn'.padEnd(35, 'x'),
      timezone: 'America/Argentina/ComodRivadavia'.padEnd(64, 'x'),
    };
    expect(widest.locale).toHaveLength(35);
    expect(widest.timezone).toHaveLength(64);
    expect(matrixCellSchema.safeParse(widest).success).toBe(true);

    const locale = variantLocaleKey(widest);
    expect(locale).toHaveLength(100);
    expect(locale).not.toContain('<');

    const parsed = testVariantKeySchema.safeParse({
      browser: DEFAULT_ENGINE_KEY,
      viewport: UNVARIED,
      locale,
      role: UNVARIED,
      environment: 'env-1',
    });
    // The PATHS, never the value: a tag and a zone are customer-authored text,
    // and `validateMeasurements` reports a zod path for that reason.
    expect(
      parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'),
    ).toEqual([]);
  });
});

describe('the baseline key keeps a matrix off one reference image', () => {
  it('is byte-identical to the pre-matrix writer for an unvaried DEFAULT cell', () => {
    /*
     * The property that means no customer is forced into a re-approval sweep by
     * this round: plugins/visual.ts writes `${width}x${height}`, and a
     * DEFAULT-state cell naming only that viewport must produce the same string
     * — otherwise every existing baseline stops matching on deploy.
     */
    const cell: MatrixCell = {
      device: { kind: 'VIEWPORT', viewport: { width: 1280, height: 800 } },
    };
    expect(baselineViewportKey(cell, 'DEFAULT')).toBe('1280x800');
  });

  it('separates light from dark and state from state under the same 4-column key', () => {
    const base: MatrixCell = {
      device: { kind: 'VIEWPORT', viewport: { width: 1280, height: 800 } },
    };
    const light = baselineViewportKey({ ...base, colourScheme: 'LIGHT' }, 'DEFAULT');
    const dark = baselineViewportKey({ ...base, colourScheme: 'DARK' }, 'DEFAULT');
    const darkError = baselineViewportKey({ ...base, colourScheme: 'DARK' }, 'ERROR');

    // Three different rows. Without this, whichever ran last would become the
    // others' reference and every later diff would be measured against the
    // wrong rendering — the shared-baseline defect, per cell.
    expect(new Set([light, dark, darkError]).size).toBe(3);
    expect(dark).toBe('1280x800+dark');
    expect(darkError).toBe('1280x800+dark#ERROR');
  });
});

describe('resolving a cell against a deployment', () => {
  const everything: DeploymentBrowsers = {
    engines: { chromium: true, firefox: true, webkit: true },
    channels: { BUNDLED: true, CHROME: true, CHROME_BETA: true },
    devicePresets: { IPHONE_15: true },
    versions: { 'chromium:CHROME_BETA': '131.0.1', chromium: '130.0.2' },
  };

  it('reports NOT_CHECKED, never AVAILABLE, against an empty capability', () => {
    // A default of "installed" would turn a missing probe into an AVAILABLE
    // cell; a default of "no" would refuse a working image.
    const r = resolveMatrixCell({ engine: 'chromium' });
    expect(r.status).toBe('NOT_CHECKED');
    // And no remedy: there is none for a question nobody asked, and inventing
    // one would be advice derived from a fact we do not have.
    expect(r.remedy).toBeNull();
    expect(r.observedVersion).toBeNull();
  });

  it('calls a Firefox beta UNSUPPORTED_COMBINATION, not MISSING', () => {
    const r = resolveMatrixCell({ engine: 'firefox', channel: 'CHROME_BETA' }, everything);
    expect(r.status).toBe('UNSUPPORTED_COMBINATION');
    // The remedy must not send a reader to install a build that was never
    // published.
    expect(r.remedy).toMatch(/There is no CHROME_BETA build of firefox to install/);
  });

  it('calls a pinned Safari version NEEDS_BROWSER_GRID and says webkit is not Safari', () => {
    const r = resolveMatrixCell(
      {
        engine: 'webkit',
        version: { kind: 'RANGE', range: { atLeast: '17.4', below: null, why: 'a CSS feature' } },
      },
      everything,
    );
    expect(r.status).toBe('NEEDS_BROWSER_GRID');
    expect(r.detail).toMatch(/webkit is not Safari/);
    expect(r.remedy).toMatch(/hosted browser grid|device farm/);
  });

  it('separates a missing engine from a missing channel, with different remedies', () => {
    const noWebkit: DeploymentBrowsers = { ...everything, engines: { chromium: true, webkit: false } };
    const engine = resolveMatrixCell({ engine: 'webkit' }, noWebkit);
    expect(engine.status).toBe('MISSING');
    expect(engine.remedy).toBe('npx playwright install');

    const noEdge: DeploymentBrowsers = { ...everything, channels: { MSEDGE: false } };
    const channel = resolveMatrixCell({ engine: 'chromium', channel: 'MSEDGE' }, noEdge);
    expect(channel.status).toBe('MISSING');
    expect(channel.remedy).toMatch(/msedge/);
  });

  it('refuses to fall back to a desktop window for an unknown device preset', () => {
    const r = resolveMatrixCell(
      { engine: 'chromium', device: { kind: 'PRESET', preset: 'GALAXY_TAB_S4' } },
      { ...everything, devicePresets: { GALAXY_TAB_S4: false } },
    );
    expect(r.status).toBe('MISSING');
    // The fallback IS the defect: a mobile test silently executed at 1280x720
    // passes while asserting nothing about a phone.
    expect(r.remedy).toMatch(/must NOT fall back to a desktop window/);
  });

  it('reads the version for the (engine, channel) pair and compares it', () => {
    const inside = resolveMatrixCell(
      {
        engine: 'chromium',
        channel: 'CHROME_BETA',
        version: { kind: 'RANGE', range: { atLeast: '131', below: null, why: 'a flag' } },
      },
      everything,
    );
    expect(inside.status).toBe('AVAILABLE');
    expect(inside.observedVersion).toBe('131.0.1');

    const outside = resolveMatrixCell(
      {
        engine: 'chromium',
        channel: 'CHROME_BETA',
        version: { kind: 'RANGE', range: { atLeast: '140', below: null, why: 'a newer flag' } },
      },
      everything,
    );
    expect(outside.status).toBe('WRONG_VERSION');
    expect(outside.observedVersion).toBe('131.0.1');
    // Upgrade or pin, never "install" — a row that says missing about an
    // installed browser sends a reader to do the wrong thing.
    expect(outside.remedy).toMatch(/Install a chrome-beta inside the window|widen the pin/);
    expect(outside.detail).toMatch(/a newer flag/);
  });

  it('says NOT_CHECKED when a pin is declared and no version was read', () => {
    const r = resolveMatrixCell(
      {
        engine: 'chromium',
        version: { kind: 'RANGE', range: { atLeast: '120', below: null, why: 'a flag' } },
      },
      { engines: { chromium: true } },
    );
    expect(r.status).toBe('NOT_CHECKED');
    expect(r.observedVersion).toBeNull();
  });

  it('keeps an unprobed cell inside the denominator and takes the refused ones out', () => {
    /*
     * The same argument NON_EXECUTABLE_CAPABILITY_STATUSES records: dropping
     * NOT_CHECKED would let a deployment that never ran a preflight silently
     * shed every cell it could not prove it could run, and the percentage would
     * rise for a probe nobody executed.
     */
    expect(cellCounts('NOT_CHECKED')).toBe(true);
    expect(cellCounts('AVAILABLE')).toBe(true);
    for (const status of UNEXERCISABLE_CELL_STATUSES) expect(cellCounts(status), status).toBe(false);
    expect(UNEXERCISABLE_CELL_STATUSES).not.toContain('NOT_CHECKED');
  });
});

describe('the environment block refuses a fabricated default', () => {
  it('names Null Island as a fallback rather than a place', () => {
    const fields = fabricatedEnvironmentFields({ geolocation: { latitude: 0, longitude: 0 } });
    expect(fields.map((f) => f.field)).toEqual(['geolocation']);
    expect(fields[0]?.why).toMatch(/Null Island/);
  });

  it('accepts a real coordinate on the equator or the prime meridian', () => {
    // `0` alone is not refused — the equator and the prime meridian exist. Only
    // the PAIR is the fallback-shaped value.
    expect(fabricatedEnvironmentFields({ geolocation: { latitude: 0, longitude: 13.4 } })).toEqual([]);
    expect(fabricatedEnvironmentFields({ geolocation: { latitude: 52.5, longitude: 0 } })).toEqual([]);
  });

  it('refuses an empty permission list, which cannot be a decision', () => {
    const fields = fabricatedEnvironmentFields({ permissions: [] });
    expect(fields.map((f) => f.field)).toEqual(['permissions']);
  });

  it('reports every fabricated field at once rather than one at a time', () => {
    const fields = fabricatedEnvironmentFields({
      geolocation: { latitude: 0, longitude: 0, accuracyMetres: 0 },
      permissions: [],
      deviceScaleFactor: 0,
    });
    expect(fields.map((f) => f.field).sort()).toEqual([
      'deviceScaleFactor',
      'geolocation',
      'geolocation.accuracyMetres',
      'permissions',
    ]);
  });

  it('treats an entirely absent block as the browser default, not as a problem', () => {
    expect(fabricatedEnvironmentFields({})).toEqual([]);
  });
});

describe('a grant that will not be observed is reported, not applied silently', () => {
  const env: BrowserEnvironment = {
    permissions: ['CAMERA'],
    camera: { fixture: 'qr.y4m', describes: 'a frame holding a valid QR code' },
    network: 'SLOW_3G',
    clipboard: true,
  };

  it('claims nothing against chromium, which implements all four', () => {
    expect(environmentUnsupportedOn('chromium', env)).toEqual([]);
  });

  it('names each unobserved field on firefox and webkit', () => {
    /*
     * The worst available shape without this: the test runs, the permission
     * prompt never appears because the feature is not wired, and the assertion
     * that "no prompt blocked us" PASSES. That is "a pass that means we did not
     * check", and the only defence is saying so before the run.
     */
    for (const engine of ['firefox', 'webkit'] as const) {
      const fields = environmentUnsupportedOn(engine, env).map((f) => f.field);
      expect(fields.sort(), engine).toEqual(['camera', 'clipboard', 'network', 'permissions']);
    }
  });

  it('does not report NO_THROTTLING as unsupported, because nothing is asked of CDP', () => {
    expect(environmentUnsupportedOn('webkit', { network: 'NO_THROTTLING' })).toEqual([]);
  });
});

describe('enumerating a matrix is deterministic and discloses its cap', () => {
  const axes: MatrixAxes = {
    engines: ['chromium', 'firefox'],
    colourSchemes: ['LIGHT', 'DARK'],
    locales: ['en-GB', 'de-DE', 'ar-EG'],
  };

  it('contributes one UNVARIED value for an omitted axis, not a default', () => {
    const only = enumerateMatrix({ colourSchemes: ['DARK'] }, { seed: 's', maxCells: 10 });
    expect(only.cells).toEqual([{ colourScheme: 'DARK' }]);
    // The engine is ABSENT from the cell rather than set to chromium, which is
    // what makes "these schemes, everything else the browser's own" expressible.
    expect(only.cells[0]).not.toHaveProperty('engine');
  });

  it('returns the declared cross product in declared order when nothing bites', () => {
    const out = enumerateMatrix(axes, { seed: 'seed-a', maxCells: 100 });
    expect(out.cells).toHaveLength(12);
    expect(out.declared).toBe(12);
    expect(out.capBite).toBeNull();
    expect(matrixCellKey(out.cells[0]!)).toBe(matrixCellKey({
      engine: 'chromium',
      colourScheme: 'LIGHT',
      locale: 'en-GB',
    }));
  });

  it('ignores the seed entirely when the cap does not bite', () => {
    /*
     * The property that matters more than the shuffle: changing a run seed must
     * not reshuffle a suite that was never capped, or every historical cell key
     * stops matching for no reason.
     */
    const a = enumerateMatrix(axes, { seed: 'seed-a', maxCells: 100 });
    const b = enumerateMatrix(axes, { seed: 'completely-different', maxCells: 100 });
    expect(a.cells.map(matrixCellKey)).toEqual(b.cells.map(matrixCellKey));
  });

  it('is byte-identical for the same seed when it does bite', () => {
    const a = enumerateMatrix(axes, { seed: 'seed-a', maxCells: 5 });
    const b = enumerateMatrix(axes, { seed: 'seed-a', maxCells: 5 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('lets the seed choose the subset and never the order', () => {
    const a = enumerateMatrix(axes, { seed: 'seed-a', maxCells: 5 });
    const b = enumerateMatrix(axes, { seed: 'seed-b', maxCells: 5 });
    const full = enumerateMatrix(axes, { seed: 'x', maxCells: 100 }).cells.map(matrixCellKey);

    // Different seeds take different cells…
    expect(a.cells.map(matrixCellKey)).not.toEqual(b.cells.map(matrixCellKey));
    // …and both come back in DECLARED order.
    for (const taken of [a, b]) {
      const positions = taken.cells.map((c) => full.indexOf(matrixCellKey(c)));
      expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    }
  });

  it('reports the cap as a count AND a reason, with how many were lost', () => {
    const out = enumerateMatrix(axes, { seed: 'seed-a', maxCells: 5 });
    expect(out.cells).toHaveLength(5);
    expect(out.declared).toBe(12);
    expect(out.capBite).not.toBeNull();
    expect(out.capBite?.taken).toBe(5);
    // Not 0. A cap that bit and reported "nothing more existed" is the lie.
    expect(out.capBite?.atLeastMore).toBe(7);
    expect(out.capBite?.detail).toMatch(/percentage over a sample, not over the matrix/);
  });

  it('refuses rather than silently returning a matrix with nothing in it', () => {
    const out = enumerateMatrix(axes, { seed: 's', maxCells: 0 });
    expect(out.cells).toEqual([]);
    expect(out.declared).toBe(12);
    // An empty result with no cap recorded would read as "the axes expand to
    // nothing", which is a different and false sentence.
    expect(out.capBite?.atLeastMore).toBe(12);
    expect(out.capBite?.detail).toMatch(/configuration refusal/);
  });
});

describe('enumerating a matrix builds only the cells it keeps', () => {
  /*
   * ── THE DEFECT, AND WHY THESE TWO TESTS AND NOT A STOPWATCH ─────────────────
   *
   * `enumerateMatrix` used to build EVERY cell of the declared product and only
   * then pick `maxCells` of them. The widest declaration `matrixAxesSchema`
   * accepts is 24,883,200 cells; keeping twelve cost ~3.7 GB, and at a 1 GB heap
   * a 14.9 million cell product ABORTS the process ("JavaScript heap out of
   * memory" — not catchable) with every other organisation's job still on that
   * worker. Nothing at the door bounds the product, so a spec a customer can
   * POST could do it.
   *
   * A TIMING OR HEAP ASSERTION WOULD BE FLAKY AND, ON A REVERT, WOULD TAKE THE
   * TEST RUNNER DOWN WITH IT. So the guard is a COUNT of how many axis elements
   * the function reads — deterministic, instant to fail, and a revert at this
   * product size costs ~0.3 s and ~400 MB rather than the worker.
   *
   * The second test is the one that makes the first safe to believe: a function
   * that read nothing could pass the count, so the output is held byte-identical
   * to the implementation this replaced, which is kept below as a REFERENCE.
   */

  /** The implementation this replaced, verbatim in behaviour: build all, shuffle indices, keep. */
  function referenceEnumerate(
    axes: MatrixAxes,
    options: { seed: string; maxCells: number },
  ): { cells: MatrixCell[]; declared: number; capBite: unknown } {
    const orOne = <T,>(list: readonly T[] | undefined): ReadonlyArray<T | undefined> =>
      list && list.length > 0 ? list : [undefined];
    const cells: MatrixCell[] = [];
    for (const engine of orOne(axes.engines))
      for (const channel of orOne(axes.channels))
        for (const version of orOne(axes.versions))
          for (const device of orOne(axes.devices))
            for (const colourScheme of orOne(axes.colourSchemes))
              for (const reducedMotion of orOne(axes.reducedMotion))
                for (const forcedColors of orOne(axes.forcedColors))
                  for (const locale of orOne(axes.locales))
                    for (const timezone of orOne(axes.timezones))
                      cells.push({
                        ...(engine !== undefined ? { engine } : {}),
                        ...(channel !== undefined ? { channel } : {}),
                        ...(version !== undefined ? { version } : {}),
                        ...(device !== undefined ? { device } : {}),
                        ...(colourScheme !== undefined ? { colourScheme } : {}),
                        ...(reducedMotion !== undefined ? { reducedMotion } : {}),
                        ...(forcedColors !== undefined ? { forcedColors } : {}),
                        ...(locale !== undefined ? { locale } : {}),
                        ...(timezone !== undefined ? { timezone } : {}),
                      });
    const { seed, maxCells } = options;
    const declared = cells.length;
    if (maxCells <= 0) {
      return {
        cells: [],
        declared,
        capBite: {
          cap: 'maxCells',
          limit: maxCells,
          taken: 0,
          atLeastMore: declared,
          detail: `maxCells is ${maxCells}, so none of the ${declared} declared cells was expanded. This is a configuration refusal, not a matrix with nothing in it.`,
        },
      };
    }
    if (declared <= maxCells) return { cells, declared, capBite: null };
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i += 1) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    let a = h >>> 0;
    const rng = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const indices = cells.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [indices[i], indices[j]] = [indices[j]!, indices[i]!];
    }
    const kept = indices.slice(0, maxCells).sort((x, y) => x - y);
    return {
      cells: kept.map((i) => cells[i]!),
      declared,
      capBite: {
        cap: 'maxCells',
        limit: maxCells,
        taken: kept.length,
        atLeastMore: declared - kept.length,
        detail: `the declared axes expand to ${declared} cells and the limit is ${maxCells}, so ${declared - kept.length} were not run. The subset is seeded on "${seed}", so the same seed takes the same cells — any percentage over these ${kept.length} is a percentage over a sample, not over the matrix.`,
      },
    };
  }

  const SOME_AXES: ReadonlyArray<MatrixAxes> = [
    {},
    { colourSchemes: ['DARK'] },
    { engines: ['chromium', 'firefox', 'webkit'], locales: ['en-GB', 'de-DE'] },
    {
      engines: ['chromium', 'firefox'],
      channels: ['BUNDLED', 'CHROME'],
      versions: [{ kind: 'UNPINNED' }, { kind: 'RANGE', range: { atLeast: '120', below: null, why: 'w' } }],
      devices: [
        { kind: 'PRESET', preset: DEVICE_PRESET_LIST[0]! },
        { kind: 'VIEWPORT', viewport: { width: 300, height: 400 } },
      ],
      colourSchemes: ['LIGHT', 'DARK', 'NO_PREFERENCE'],
      reducedMotion: ['REDUCE', 'NO_PREFERENCE'],
      forcedColors: ['ACTIVE'],
      locales: ['en-GB', 'de-DE', 'ar-EG'],
      timezones: ['UTC', 'Asia/Tokyo'],
    },
    // One axis only, at several sizes, so every digit position is the only one that moves.
    { timezones: ['UTC', 'Asia/Tokyo', 'Europe/Berlin'] },
    { locales: ['a1', 'b2', 'c3', 'd4', 'e5'] },
    { forcedColors: ['ACTIVE', 'NONE'] },
    { reducedMotion: ['REDUCE', 'NO_PREFERENCE'], engines: ['webkit'] },
    { devices: [{ kind: 'VIEWPORT', viewport: { width: 200, height: 200 } }], channels: ['CHROME', 'MSEDGE'] },
  ];

  it('returns exactly what the build-everything implementation returned, for every seed and cap', () => {
    let compared = 0;
    let bitten = 0;
    for (const axes of SOME_AXES) {
      for (const seed of ['seed-a', 'run_0001', 'ünï-cødé', 'x']) {
        for (const maxCells of [-3, 0, 1, 2, 5, 7, 12, 36, 37, 100, 100_000]) {
          const expected = referenceEnumerate(axes, { seed, maxCells });
          const actual = enumerateMatrix(axes, { seed, maxCells });
          // JSON and not toEqual: property ORDER inside a cell is part of the
          // contract, because a stored cell is compared as text.
          expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
          compared += 1;
          if (expected.capBite !== null && maxCells > 0) bitten += 1;
        }
      }
    }
    // Non-vacuous: a corpus that never bit the cap would prove nothing about the take.
    expect(compared).toBeGreaterThan(300);
    expect(bitten).toBeGreaterThan(50);
  });

  it('reads a handful of axis elements for a million-cell product, never the product', () => {
    // 3 x 9 x 8 x 24 x 3 x 2 x 2 x 20 x 1 = 1,244,160 cells. Wide enough that
    // building them is unmistakable, small enough that a revert is survivable.
    let reads = 0;
    const counted = <T,>(values: readonly T[]): readonly T[] =>
      new Proxy([...values], {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
          return Reflect.get(target, key, receiver);
        },
      });
    const axes: MatrixAxes = {
      engines: counted(BROWSER_ENGINE_LIST),
      channels: counted(BROWSER_CHANNEL_LIST),
      versions: counted(
        Array.from({ length: 8 }, (_, i) => ({
          kind: 'RANGE' as const,
          range: { atLeast: String(100 + i), below: null, why: 'w' },
        })),
      ),
      devices: counted(
        Array.from({ length: 24 }, (_, i) => ({
          kind: 'VIEWPORT' as const,
          viewport: { width: 300 + i, height: 400 },
        })),
      ),
      colourSchemes: counted(COLOUR_SCHEME_LIST),
      reducedMotion: counted(REDUCED_MOTION_LIST),
      forcedColors: counted(FORCED_COLORS_LIST),
      locales: counted(Array.from({ length: 20 }, (_, i) => `xx-L${i}`)),
      timezones: counted(['UTC']),
    };

    const out = enumerateMatrix(axes, { seed: 'seed', maxCells: 12 });

    expect(out.declared).toBe(3 * 9 * 8 * 24 * 3 * 2 * 2 * 20);
    expect(out.cells).toHaveLength(12);
    // Nine axes read once per KEPT cell is the ceiling; building the product
    // reads each axis element once per iteration, which is over a million.
    expect(reads).toBeLessThanOrEqual(12 * 9);
  });
});

describe('the cell write path refuses the three incoherent cells', () => {
  it('refuses a pinned version with no engine', () => {
    const parsed = matrixCellSchema.safeParse({
      version: { kind: 'RANGE', range: { atLeast: '120', why: 'a flag' } },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/unrelated builds/);
  });

  it('accepts an UNPINNED version with no engine, which is a real cell', () => {
    expect(matrixCellSchema.safeParse({ version: { kind: 'UNPINNED' } }).success).toBe(true);
  });

  it('refuses a channel with no engine, and allows an explicit BUNDLED', () => {
    expect(matrixCellSchema.safeParse({ channel: 'CHROME' }).success).toBe(false);
    expect(matrixCellSchema.safeParse({ channel: 'BUNDLED' }).success).toBe(true);
  });

  it('refuses a channel that no build of the engine has', () => {
    const parsed = matrixCellSchema.safeParse({ engine: 'webkit', channel: 'CHROME_CANARY' });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/no Firefox beta and no WebKit canary/);
  });

  it('accepts the empty cell, which is what every pre-matrix test has been', () => {
    expect(matrixCellSchema.safeParse({}).success).toBe(true);
  });

  it('refuses an unknown property rather than dropping it', () => {
    expect(matrixCellSchema.safeParse({ engine: 'chromium', browser: 'chrome' }).success).toBe(false);
  });

  it('refuses an empty version range window', () => {
    const parsed = matrixCellSchema.safeParse({
      engine: 'chromium',
      version: { kind: 'RANGE', range: { atLeast: '120', below: '120', why: 'a flag' } },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a version range with no reason, which nobody can review', () => {
    expect(
      matrixCellSchema.safeParse({
        engine: 'chromium',
        version: { kind: 'RANGE', range: { atLeast: '120', below: null, why: '' } },
      }).success,
    ).toBe(false);
  });
});

describe('the axes write path refuses an axis that is present and empty', () => {
  it('refuses it, because it has exactly the effect of omitting it', () => {
    expect(matrixAxesSchema.safeParse({ engines: [] }).success).toBe(false);
    expect(matrixAxesSchema.safeParse({}).success).toBe(true);
    expect(matrixAxesSchema.safeParse({ engines: ['chromium'] }).success).toBe(true);
  });
});

describe('the environment write path', () => {
  it('refuses Null Island, and says why in the message', () => {
    const parsed = browserEnvironmentSchema.safeParse({
      geolocation: { latitude: 0, longitude: 0 },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/Null Island/);
  });

  it('refuses an empty permission list at the array bound', () => {
    expect(browserEnvironmentSchema.safeParse({ permissions: [] }).success).toBe(false);
  });

  it('refuses a fake camera with no named fixture, because the flags synthesise one', () => {
    /*
     * Chromium's fake-device flags without a file produce a rolling green
     * pattern, so a QR-scanner test runs against content nobody chose, fails to
     * find what it was looking for, and reports an application defect.
     *
     * The FIRST version of this test asserted `{ camera: {} }`, and a mutation
     * making `fixture` optional SURVIVED it — because `describes` is required
     * too, so the empty object was being refused for the other reason entirely.
     * The test was passing for the wrong reason. Each field is now pinned on its
     * own, which is the only form of this assertion that holds.
     */
    expect(browserEnvironmentSchema.safeParse({ camera: { describes: 'a QR code' } }).success).toBe(
      false,
    );
    expect(browserEnvironmentSchema.safeParse({ camera: { fixture: 'qr.y4m' } }).success).toBe(
      false,
    );
    expect(browserEnvironmentSchema.safeParse({ camera: {} }).success).toBe(false);
    expect(
      browserEnvironmentSchema.safeParse({ camera: { fixture: 'qr.y4m', describes: 'a QR code' } })
        .success,
    ).toBe(true);
  });

  it('is structurally incapable of carrying a password', () => {
    /*
     * `.strict()` means an extra property is REFUSED rather than dropped, which
     * is what makes "no credential in a spec" a guarantee instead of a habit.
     *
     * The FIRST version of this test omitted `passwordSecretName`, and a
     * mutation removing `.strict()` SURVIVED it — the object was being refused
     * for the missing required field, not for the extra one, so the test proved
     * nothing about strictness at all. Both required names are present below, so
     * the ONLY thing that can refuse it is the extra property. The value is
     * composed at run time from a prefix and an obviously-fake tail rather than
     * written as a literal: a scanner cannot tell an invented credential from a
     * real one, and a finished green commit was once blocked by push protection
     * over exactly that.
     */
    const notASecret = ['not', 'a', 'real', 'password'].join('-');
    const parsed = browserEnvironmentSchema.safeParse({
      httpCredentials: {
        usernameSecretName: 'BASIC_USER',
        passwordSecretName: 'BASIC_PASS',
        password: notASecret,
      },
    });
    expect(parsed.success).toBe(false);
    // And the same for the other spellings a careless writer reaches for.
    for (const field of ['secret', 'token', 'apiKey', 'value']) {
      expect(
        browserEnvironmentSchema.safeParse({
          httpCredentials: {
            usernameSecretName: 'BASIC_USER',
            passwordSecretName: 'BASIC_PASS',
            [field]: notASecret,
          },
        }).success,
        field,
      ).toBe(false);
    }
  });

  it('accepts secret NAMES for HTTP credentials', () => {
    expect(
      browserEnvironmentSchema.safeParse({
        httpCredentials: { usernameSecretName: 'BASIC_USER', passwordSecretName: 'BASIC_PASS' },
      }).success,
    ).toBe(true);
  });

  it('refuses the offline contradiction in both directions', () => {
    expect(browserEnvironmentSchema.safeParse({ network: 'OFFLINE', offline: false }).success).toBe(
      false,
    );
    expect(browserEnvironmentSchema.safeParse({ offline: true, network: 'SLOW_3G' }).success).toBe(
      false,
    );
    // Consistent pairs pass.
    expect(browserEnvironmentSchema.safeParse({ offline: true, network: 'OFFLINE' }).success).toBe(
      true,
    );
    expect(
      browserEnvironmentSchema.safeParse({ offline: true, network: 'NO_THROTTLING' }).success,
    ).toBe(true);
  });

  it('accepts the empty block, which means the browser default throughout', () => {
    expect(browserEnvironmentSchema.safeParse({}).success).toBe(true);
  });
});

describe('the stored matrix cannot be a sample pretending to be a matrix', () => {
  const cell = { engine: 'chromium' as const };

  it('accepts a complete, uncapped matrix', () => {
    const parsed = testMatrixSchema.safeParse({ cells: [cell], declared: 1, capBite: null });
    expect(parsed.success).toBe(true);
  });

  it('refuses fewer cells than declared with no cap recorded', () => {
    const parsed = testMatrixSchema.safeParse({ cells: [cell], declared: 12, capBite: null });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/a count AND a reason/);
  });

  it('refuses a cap that disagrees with the sample it describes', () => {
    const parsed = testMatrixSchema.safeParse({
      cells: [cell],
      declared: 12,
      capBite: { cap: 'maxCells', limit: 5, taken: 5, atLeastMore: 7, detail: 'bit' },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a declared count smaller than the stored cells', () => {
    expect(
      testMatrixSchema.safeParse({ cells: [cell, { engine: 'webkit' }], declared: 1, capBite: null })
        .success,
    ).toBe(false);
  });

  it('accepts the empty-but-declared matrix, which is a real unvaried run', () => {
    expect(testMatrixSchema.safeParse({}).success).toBe(true);
  });
});

describe('a visual capture may not be of the wrong thing under the right name', () => {
  const base = {
    cell: { engine: 'chromium' as const },
    state: 'ERROR' as const,
    environmentId: 'env_staging',
  };

  it('accepts a reached state with an image', () => {
    expect(
      visualCaptureSchema.safeParse({ ...base, reached: true, imageKey: 'k/1.png' }).success,
    ).toBe(true);
  });

  it('refuses an unreached state with no reason', () => {
    expect(visualCaptureSchema.safeParse({ ...base, reached: false }).success).toBe(false);
  });

  it('refuses an unreached reason with no detail, which nobody can act on', () => {
    expect(
      visualCaptureSchema.safeParse({
        ...base,
        reached: false,
        unreachedReason: 'NO_TRIGGER_FOUND',
      }).success,
    ).toBe(false);
  });

  it('refuses a reason beside a reached state, which claims both', () => {
    expect(
      visualCaptureSchema.safeParse({
        ...base,
        reached: true,
        unreachedReason: 'TIMED_OUT',
        unreachedDetail: 'x',
      }).success,
    ).toBe(false);
  });

  it('refuses an image for a state that was never on screen', () => {
    /*
     * THE WORST OUTCOME A VISUAL MATRIX HAS. The capture is of the DEFAULT
     * rendering, it looks fine, somebody approves it, and the baseline then
     * asserts the ERROR state for ever while the real one stays untested behind
     * a green row.
     */
    const parsed = visualCaptureSchema.safeParse({
      ...base,
      reached: false,
      unreachedReason: 'NO_TRIGGER_FOUND',
      unreachedDetail: 'no element matched [role=alert]',
      imageKey: 'k/whatever-the-page-was-showing.png',
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/behind a green row/);
  });

  it('accepts an unreached state with no image', () => {
    expect(
      visualCaptureSchema.safeParse({
        ...base,
        reached: false,
        unreachedReason: 'REQUIRES_DATA',
        unreachedDetail: 'the fixture seeded three rows and this state needs zero',
        imageKey: null,
      }).success,
    ).toBe(true);
  });

  it('requires an environment, with no default and no sentinel', () => {
    // A defaulted scope is how the shared-baseline defect comes back one writer
    // at a time, which is the whole reason VisualBaseline.environmentId exists.
    const { environmentId: _drop, ...noEnv } = base;
    expect(visualCaptureSchema.safeParse({ ...noEnv, reached: true }).success).toBe(false);
  });
});

describe('the widened VISUAL spec stays backward compatible', () => {
  it('parses a spec written before the matrix existed, unchanged', () => {
    const parsed = visualTestSpecSchema.safeParse({ path: '/billing', fullPage: true });
    expect(parsed.success).toBe(true);
    // The new fields are absent rather than defaulted: a defaulted matrix would
    // claim a declaration the author never made.
    expect(parsed.data?.matrix).toBeUndefined();
    expect(parsed.data?.states).toBeUndefined();
    expect(parsed.data?.environment).toBeUndefined();
    // And the old defaults still apply.
    expect(parsed.data?.viewport).toEqual({ width: 1280, height: 800 });
  });

  it('accepts a matrix, a state list and an environment block together', () => {
    const parsed = visualTestSpecSchema.safeParse({
      path: '/billing',
      matrix: { colourSchemes: ['LIGHT', 'DARK'], devices: [{ kind: 'PRESET', preset: 'IPHONE_15' }] },
      states: ['DEFAULT', 'ERROR', 'EMPTY'],
      environment: { reducedMotion: 'REDUCE' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.states).toEqual(['DEFAULT', 'ERROR', 'EMPTY']);
  });
});

describe('the matrix can actually be saved, which is the half that is usually missing', () => {
  /*
   * ── THE DEFECT THESE FOUR TESTS EXIST FOR ──────────────────────────────────
   *
   * A column on `Test` plus a vocabulary plus a validator is three-quarters of a
   * feature, and the missing quarter is invisible: `check:wiring` sees the models
   * as connected (they are read and written for other reasons), the migration
   * applies, every schema validates, and a customer declaring a 12-cell matrix
   * watches it be silently dropped by the request validator before any route
   * sees it. The test still runs, in one cell, and passes.
   *
   * `PlanItem.gapId` shipped exactly that way — minted by the route, dropped by
   * this file's own parser, re-attached by hand afterwards by two writers.
   */
  const MATRIX = {
    cells: [{ engine: 'chromium' as const, channel: 'CHROME_BETA' as const }],
    declared: 1,
    capBite: null,
  };

  it('accepts a matrix and an environment on createTestSchema', () => {
    const parsed = createTestSchema.safeParse({
      name: 'checkout in chrome beta',
      type: 'E2E',
      code: '// x',
      filePath: 'tests/checkout.spec.ts',
      matrixCells: MATRIX,
      browserEnv: { geolocation: { latitude: 52.52, longitude: 13.405 } },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.matrixCells?.cells).toHaveLength(1);
    expect(parsed.data?.browserEnv?.geolocation?.latitude).toBe(52.52);
  });

  it('accepts a matrix on updateTestSchema and on planItemSchema', () => {
    /*
     * ASSERTED ON THE PARSED OUTPUT, NOT ON `.success`, and the difference is
     * the whole test. `updateTestSchema` is not `.strict()`, so an unknown key
     * is DROPPED and the parse still succeeds — a mutation that deleted the
     * field from the schema SURVIVED the first version of this assertion, which
     * only checked that the request validated. That is the defect in miniature:
     * the request is accepted, the matrix never reaches the route, the test runs
     * in one cell and passes, and nothing anywhere said so.
     */
    const update = updateTestSchema.safeParse({ code: '// x', matrixCells: MATRIX });
    expect(update.success, JSON.stringify(update.error?.issues)).toBe(true);
    expect(update.data?.matrixCells?.cells[0]?.channel).toBe('CHROME_BETA');
    const updateEnv = updateTestSchema.safeParse({
      code: '// x',
      browserEnv: { colourScheme: 'DARK' },
    });
    expect(updateEnv.data?.browserEnv?.colourScheme).toBe('DARK');
    const item = planItemSchema.safeParse({
      id: 'item-1',
      title: 'checkout in chrome beta',
      rationale: 'the channel our enterprise accounts are pinned to',
      feature: 'checkout',
      priority: 'IMPORTANT',
      testType: 'E2E',
      steps: ['open /checkout'],
      assertions: ['the order confirmation is shown'],
      matrixCells: MATRIX,
    });
    expect(item.success, JSON.stringify(item.error?.issues)).toBe(true);
    expect(item.data?.matrixCells?.cells[0]?.channel).toBe('CHROME_BETA');
  });

  it('leaves both fields ABSENT rather than defaulted when a client omits them', () => {
    // Every client that predates these fields omits them on every save, and a
    // defaulted `{ cells: [] }` would claim a decision nobody made — the
    // difference the approval screen renders as "runs in 12 cells" versus
    // nothing at all.
    const parsed = createTestSchema.safeParse({
      name: 'x',
      type: 'E2E',
      code: '// x',
      filePath: 'tests/x.spec.ts',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('matrixCells');
    expect(parsed.data).not.toHaveProperty('browserEnv');
  });

  it('carries the refusals through the door rather than only at the leaf', () => {
    // The point of importing the schema instead of restating the shape: a
    // request naming a Firefox beta is refused by the CREATE route, not
    // discovered by the runner.
    expect(
      createTestSchema.safeParse({
        name: 'x',
        type: 'E2E',
        code: '// x',
        filePath: 'tests/x.spec.ts',
        matrixCells: {
          cells: [{ engine: 'firefox', channel: 'CHROME_BETA' }],
          declared: 1,
          capBite: null,
        },
      }).success,
    ).toBe(false);
    expect(
      createTestSchema.safeParse({
        name: 'x',
        type: 'E2E',
        code: '// x',
        filePath: 'tests/x.spec.ts',
        browserEnv: { geolocation: { latitude: 0, longitude: 0 } },
      }).success,
    ).toBe(false);
  });
});
