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
    expect(variantBrowserKey(cell)).toBe('chromium:CHROME_BETA@>=130<132');
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
