/**
 * The browser / device matrix vocabulary — what a cell of a run IS.
 *
 * ── THE DEFECT THIS FILE EXISTS TO CLOSE ────────────────────────────────────
 *
 * `z.enum(['chromium', 'firefox', 'webkit'])` was the entire cross-browser
 * vocabulary of this product. Three members, and every one of them collapses to
 * ONE desktop preset:
 *
 *   · "Chrome stable vs Chrome beta" — the thing a buyer means when they say
 *     cross-browser, because that is where their customers' regressions come
 *     from — was INEXPRESSIBLE. So was Edge, so was "the Safari version our
 *     enterprise accounts are pinned to", so was a real iPhone viewport.
 *   · A VISUAL test got one path and one viewport, so covering a route's four
 *     visual states cost four hand-written tests, and nothing anywhere said
 *     which states had never been reached.
 *   · `CONFIG_TEMPLATE`'s `use` block carried baseURL, timezone and locale and
 *     nothing else, so geolocation, permissions, fake media, clipboard,
 *     throttling, offline and colour scheme were all UNGATED — every feature
 *     behind one of them was untestable, and nothing said so.
 *
 * ── THE RULE THAT KEEPS IT HONEST ───────────────────────────────────────────
 *
 * A widened vocabulary lets a customer ask for a cell this deployment cannot
 * run. That is NOT an authoring error (the request is legitimate and the
 * remedy is ours), and it is NOT a silent skip (a skipped cell inside a
 * percentage is a test that can never fail). It RESOLVES: every cell is put to
 * {@link resolveMatrixCell} against what a deployment reported, and comes back
 * as one of six named outcomes with the exact remedy. `MISSING` means install
 * something; `WRONG_VERSION` means upgrade or pin; `NEEDS_BROWSER_GRID` means
 * no install on this image will ever satisfy it; `UNSUPPORTED_COMBINATION`
 * means no deployment anywhere can, because the combination does not exist;
 * `NOT_CHECKED` means nobody looked and nothing is claimed.
 *
 * Collapsing any pair of those into one word is the lie this file is built to
 * prevent, and it is the same argument `DeploymentCapabilityStatus` in
 * ./coverage-dimensions.ts records at length for the nineteen test types. This
 * is its per-cell twin, and it needs two members that one does not: a cell can
 * be impossible rather than merely absent.
 *
 * ── ABSENT IS NEVER A FABRICATED VALUE ──────────────────────────────────────
 *
 * Every field of {@link BrowserEnvironment} is optional, and absent means "the
 * browser's own default" every single time. A defaulted geolocation is the
 * sharpest version of this: `{ latitude: 0, longitude: 0 }` as a fallback would
 * make every location-dependent test pass at Null Island, somewhere nobody
 * chose, and the suite would be green. So the schema in ./schemas.ts REFUSES
 * the default-shaped values rather than accepting them, and
 * {@link fabricatedEnvironmentFields} is the pure half of that refusal, usable
 * by a producer before it writes.
 *
 * ── NO PIXEL DIMENSIONS FOR A NAMED DEVICE, ON PURPOSE ──────────────────────
 *
 * {@link DEVICE_PRESETS} carries device IDENTITIES and {@link PLAYWRIGHT_DEVICE}
 * maps each to the descriptor name the runner looks up. Neither carries a width,
 * a height or a device scale factor, and that omission is load-bearing: a
 * viewport typed into this file that disagreed with the registry the runner
 * actually resolves would silently test a size no phone has ever had, and the
 * screenshot would be approved as a baseline. A preset the runner cannot resolve
 * reports MISSING with the preset named. An EXPLICIT viewport is the other arm
 * of the union, and there the numbers are the customer's own and are therefore
 * theirs to be wrong about.
 *
 * Pure data, closed unions and arithmetic. No `node:` builtin, no zod — the
 * write paths live in ./schemas.ts and import FROM here, so there is exactly
 * one copy of every list.
 */

import { UNVARIED } from './types';

// ─── Engines ─────────────────────────────────────────────────────────────────

/**
 * The three rendering engines Playwright ships.
 *
 * Moved here from ./schemas.ts, which declared it beside `crossBrowserSpecSchema`
 * and was its only reader. It belongs with the rest of the matrix: a channel is
 * a property of an engine, a device preset implies one, and three lists in three
 * files is how `BROWSER_ENGINES` and `BrowserEngine` in packages/runner came to
 * be two hand-written copies of the same union.
 */
export const BROWSER_ENGINES = ['chromium', 'firefox', 'webkit'] as const;
export type BrowserEngine = (typeof BROWSER_ENGINES)[number];

/**
 * The compile-time half of the parity guard: a `Record` keyed on the union
 * cannot be written without naming every member, and naming one that does not
 * exist is an excess property. The run-time half — comparing the zod schema's
 * `.options` back against the list — lives in ./browser-matrix.test.ts, because
 * zod's options exist only at run time and nothing but an assertion can see
 * them.
 *
 * BOTH halves, for every closed union in this file. Eight `GateRule` kinds
 * shipped unsaveable for two slices because only one of the two existed, and
 * `check:wiring` cannot see that class of defect.
 */
const BROWSER_ENGINE_PRESENT: Record<BrowserEngine, true> = {
  chromium: true,
  firefox: true,
  webkit: true,
};

/** Derived, never hand-listed. */
export const BROWSER_ENGINE_LIST = Object.keys(
  BROWSER_ENGINE_PRESENT,
) as ReadonlyArray<BrowserEngine>;

// ─── Channels ────────────────────────────────────────────────────────────────

/**
 * WHICH BUILD OF THE ENGINE, which is what "cross-browser" actually means.
 *
 * `BUNDLED` is Playwright's own build and is the only member that is not a
 * released consumer browser. It is first in the list and it is the honest
 * default: it is what every existing test in this product has always run in,
 * and it is NOT Chrome — Playwright's chromium is a build of the Chromium
 * project without Chrome's codecs, its integrity checks or its release train.
 * A report that printed "Chrome" for a bundled run would be claiming coverage
 * of a browser nobody launched.
 *
 * The eight others are Playwright's `channel` strings, spelled in this file's
 * UPPER_SNAKE convention and mapped by {@link PLAYWRIGHT_CHANNEL}. They exist
 * only for chromium — Playwright ships ONE firefox and ONE webkit build with no
 * channel concept at all — which is why {@link CHANNEL_ENGINE} exists and why a
 * firefox cell naming a channel resolves UNSUPPORTED_COMBINATION rather than
 * MISSING. "Install chrome-beta for Firefox" is advice that cannot be followed.
 */
export const BROWSER_CHANNELS = [
  /** Playwright's own build. Not Chrome, and never reported as Chrome. */
  'BUNDLED',
  'CHROME',
  'CHROME_BETA',
  'CHROME_DEV',
  'CHROME_CANARY',
  'MSEDGE',
  'MSEDGE_BETA',
  'MSEDGE_DEV',
  'MSEDGE_CANARY',
] as const;
export type BrowserChannel = (typeof BROWSER_CHANNELS)[number];

const BROWSER_CHANNEL_PRESENT: Record<BrowserChannel, true> = {
  BUNDLED: true,
  CHROME: true,
  CHROME_BETA: true,
  CHROME_DEV: true,
  CHROME_CANARY: true,
  MSEDGE: true,
  MSEDGE_BETA: true,
  MSEDGE_DEV: true,
  MSEDGE_CANARY: true,
};

export const BROWSER_CHANNEL_LIST = Object.keys(
  BROWSER_CHANNEL_PRESENT,
) as ReadonlyArray<BrowserChannel>;

/**
 * The string a launcher is handed, or `null` for "pass no channel at all".
 *
 * `null` is not a missing entry: it is the instruction to omit the option, which
 * is a different call from passing an empty string and is what makes BUNDLED
 * mean Playwright's build. A `Record` so the compiler refuses a channel with no
 * mapping, which would otherwise launch SOMETHING and label it with the
 * requested channel's name.
 */
export const PLAYWRIGHT_CHANNEL: Record<BrowserChannel, string | null> = {
  BUNDLED: null,
  CHROME: 'chrome',
  CHROME_BETA: 'chrome-beta',
  CHROME_DEV: 'chrome-dev',
  CHROME_CANARY: 'chrome-canary',
  MSEDGE: 'msedge',
  MSEDGE_BETA: 'msedge-beta',
  MSEDGE_DEV: 'msedge-dev',
  MSEDGE_CANARY: 'msedge-canary',
};

/**
 * The engine a channel is a build OF, or `null` for BUNDLED, which every engine
 * has.
 *
 * This is the whole of the "a firefox beta does not exist" rule, in data.
 */
export const CHANNEL_ENGINE: Record<BrowserChannel, BrowserEngine | null> = {
  BUNDLED: null,
  CHROME: 'chromium',
  CHROME_BETA: 'chromium',
  CHROME_DEV: 'chromium',
  CHROME_CANARY: 'chromium',
  MSEDGE: 'chromium',
  MSEDGE_BETA: 'chromium',
  MSEDGE_DEV: 'chromium',
  MSEDGE_CANARY: 'chromium',
};

/**
 * Can this engine be driven through this channel AT ALL — on any deployment,
 * ever?
 *
 * A distinct question from "is it installed here", and the reason the two
 * cannot share a status. This one is a property of the browser vendors; the
 * other is a property of an image.
 */
export function channelExistsFor(engine: BrowserEngine, channel: BrowserChannel): boolean {
  const owner = CHANNEL_ENGINE[channel];
  return owner === null || owner === engine;
}

// ─── Versions ────────────────────────────────────────────────────────────────

/**
 * A version window, and WHY it is needed.
 *
 * Structurally identical to `VersionRange` in packages/runner/src/preflight.ts,
 * which is deliberate rather than careless: that one describes a BINARY's window
 * and is probed by spawning the binary, this one describes a BROWSER's and is
 * resolved against a reported version, and TypeScript's structural typing means
 * a value of either is assignable to the other wherever a caller legitimately
 * wants both. `shared` cannot import from `runner` (that is the dependency
 * direction), so the alternative to two declarations was moving a module that
 * spawns processes into the package the web bundler eats.
 *
 * `below` is nullable and `atLeast` is not, for the reason preflight records: a
 * floor is something you learn by reading what you depend on, a CEILING is
 * something you learn by being broken, and asserting one that has not happened
 * refuses a newer build that works fine.
 */
export interface BrowserVersionRange {
  /** Lowest version known to work, inclusive. */
  atLeast: string;
  /** First version known NOT to work, exclusive. Null = no ceiling established. */
  below: string | null;
  /** The behaviour, API or rendering change this cell depends on. */
  why: string;
}

/**
 * Pinned, or not — and `UNPINNED` is a member rather than `null` on purpose.
 *
 * `null` would be read by the first careless consumer as "no answer yet", which
 * is the state `NOT_CHECKED` describes and a completely different sentence.
 * UNPINNED is a DECISION: this cell does not care which version it gets, so no
 * version is read and none is reported. A report must never print a version for
 * an UNPINNED cell, because the number would be whatever the image happened to
 * hold and would read as a thing somebody chose.
 */
export type BrowserVersionPin =
  | { readonly kind: 'UNPINNED' }
  | { readonly kind: 'RANGE'; readonly range: BrowserVersionRange };

/** The one UNPINNED value, so a producer does not allocate a fresh object per cell. */
export const UNPINNED: BrowserVersionPin = { kind: 'UNPINNED' };

/**
 * Parse the leading dotted-numeric version out of whatever a browser printed.
 *
 * The same two rules, and the same reasoning, as `parseVersion` in
 * packages/runner/src/preflight.ts — which learned them the expensive way, by
 * reading `k6 v0.49.0` as version SIX:
 *
 *   · the number may not be preceded by an alphanumeric, with a single `v`
 *     allowed in front of it, so a digit inside a product name is not a version;
 *   · it must contain AT LEAST ONE DOT, because a bare integer in a banner is
 *     far more likely to be a name, a year or a build counter.
 *
 * Returns `null` and never `[0]`. A `0.0.0` compares as older than everything
 * and would turn an unreadable version string into a confident WRONG_VERSION
 * against a browser that may be perfectly current — the null-became-zero lie in
 * its most expensive form, because it refuses a working tool.
 */
export function parseBrowserVersion(raw: string): number[] | null {
  const match = /(?<![A-Za-z0-9])v?(\d+(?:\.\d+)+)/.exec(raw);
  if (!match) return null;
  const parts = match[1]!.split('.').map((part) => Number.parseInt(part, 10));
  return parts.some((part) => !Number.isFinite(part)) ? null : parts;
}

/**
 * Parse a version a HUMAN DECLARED as a bound, which is a different job from
 * reading one a browser printed.
 *
 * ── WHY THIS IS NOT `parseBrowserVersion` ──────────────────────────────────
 *
 * That function's "must contain at least one dot" rule is an INFERENCE
 * HEURISTIC: it is picking a version out of a banner full of other numbers, and
 * a bare integer there is far more likely to be part of a product name, a year
 * or a build counter. Applied to a DECLARED bound it is simply wrong. `atLeast:
 * '131'` is an author writing a Chrome major on purpose, there is nothing else
 * in the string for it to be confused with, and `browserVersionRangeSchema`
 * accepts it (`/^\d+(\.\d+)*$/`).
 *
 * This was a real defect in this file and the colocated test caught it: the
 * schema accepted `'131'`, the comparator could not read it, `versionInRange`
 * returned `null`, and a cell pinned to Chrome 131 running on Chrome 131.0.1
 * resolved NOT_CHECKED. A pin that silently stops being applied is the worst of
 * the available failures — it reads as a measurement and measures nothing, and
 * it fails CLOSED in the one direction nobody looks at.
 *
 * `packages/runner/src/preflight.ts` has the same shape in `satisfiesRange`,
 * where it parses `range.atLeast` with its own banner reader. Named in the
 * handover rather than reached across the workspace boundary to fix.
 */
export function parseVersionBound(raw: string): number[] | null {
  if (!/^\d+(\.\d+)*$/.test(raw.trim())) return null;
  const parts = raw.trim().split('.').map((part) => Number.parseInt(part, 10));
  return parts.some((part) => !Number.isFinite(part)) ? null : parts;
}

/** Component-wise, absent components treated as 0, so `1.2` equals `1.2.0`. */
export function compareBrowserVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Is the observed version inside the window?
 *
 * Tri-state, and the `null` is the entire reason this is a function: an output
 * this cannot parse is NOT a failure, it is a version nobody could read, and
 * the only honest answer is "not checked".
 */
export function versionInRange(observed: string, range: BrowserVersionRange): boolean | null {
  // The OBSERVED string is a banner and needs the heuristic. The BOUNDS were
  // declared by a human and must not: see the note on `parseVersionBound` for
  // the defect that distinction fixes.
  const found = parseBrowserVersion(observed);
  if (!found) return null;
  const floor = parseVersionBound(range.atLeast);
  if (!floor) return null;
  if (compareBrowserVersions(found, floor) < 0) return false;
  if (range.below !== null) {
    const ceiling = parseVersionBound(range.below);
    if (!ceiling) return null;
    if (compareBrowserVersions(found, ceiling) >= 0) return false;
  }
  return true;
}

/** One line describing the window, for a refusal somebody has to act on. */
export function describeVersionRange(range: BrowserVersionRange): string {
  return range.below === null
    ? `>= ${range.atLeast} (no upper bound established)`
    : `>= ${range.atLeast} and < ${range.below}`;
}

// ─── Devices ─────────────────────────────────────────────────────────────────

/**
 * Named device identities, in this file's own spelling.
 *
 * NOT Playwright's descriptor strings — {@link PLAYWRIGHT_DEVICE} maps to those
 * — and the indirection is worth its cost twice over. A stored cell key built
 * out of `'iPhone 15 Pro'` breaks the moment the registry renames it, and every
 * historical `TestResultVariant` row silently stops matching the cell it came
 * from; and a Prisma enum or a grouped query cannot hold a string with a space
 * in it without quoting that nobody gets right every time.
 *
 * AND NO DIMENSIONS HERE. See this file's header: a width typed in this file is
 * a width that can disagree with the registry the runner resolves, and a
 * screenshot taken at a size no device has is a baseline somebody approves.
 */
export const DEVICE_PRESETS = [
  'DESKTOP_CHROME',
  'DESKTOP_CHROME_HIDPI',
  'DESKTOP_EDGE',
  'DESKTOP_FIREFOX',
  'DESKTOP_SAFARI',
  'IPHONE_SE',
  'IPHONE_12',
  'IPHONE_13',
  'IPHONE_14',
  'IPHONE_14_PRO_MAX',
  'IPHONE_15',
  'IPAD_MINI',
  'IPAD_PRO_11',
  'PIXEL_5',
  'PIXEL_7',
  'GALAXY_S9_PLUS',
  'GALAXY_TAB_S4',
] as const;
export type DevicePreset = (typeof DEVICE_PRESETS)[number];

const DEVICE_PRESET_PRESENT: Record<DevicePreset, true> = {
  DESKTOP_CHROME: true,
  DESKTOP_CHROME_HIDPI: true,
  DESKTOP_EDGE: true,
  DESKTOP_FIREFOX: true,
  DESKTOP_SAFARI: true,
  IPHONE_SE: true,
  IPHONE_12: true,
  IPHONE_13: true,
  IPHONE_14: true,
  IPHONE_14_PRO_MAX: true,
  IPHONE_15: true,
  IPAD_MINI: true,
  IPAD_PRO_11: true,
  PIXEL_5: true,
  PIXEL_7: true,
  GALAXY_S9_PLUS: true,
  GALAXY_TAB_S4: true,
};

export const DEVICE_PRESET_LIST = Object.keys(
  DEVICE_PRESET_PRESENT,
) as ReadonlyArray<DevicePreset>;

/**
 * The descriptor name the runner looks up in Playwright's device registry.
 *
 * A name the registry does not hold is a MISSING cell with the name printed, not
 * a fallback to a desktop viewport. The fallback is the defect: a mobile test
 * silently executed at 1280x720 passes, and passes while asserting nothing about
 * a phone.
 */
export const PLAYWRIGHT_DEVICE: Record<DevicePreset, string> = {
  DESKTOP_CHROME: 'Desktop Chrome',
  DESKTOP_CHROME_HIDPI: 'Desktop Chrome HiDPI',
  DESKTOP_EDGE: 'Desktop Edge',
  DESKTOP_FIREFOX: 'Desktop Firefox',
  DESKTOP_SAFARI: 'Desktop Safari',
  IPHONE_SE: 'iPhone SE',
  IPHONE_12: 'iPhone 12',
  IPHONE_13: 'iPhone 13',
  IPHONE_14: 'iPhone 14',
  IPHONE_14_PRO_MAX: 'iPhone 14 Pro Max',
  IPHONE_15: 'iPhone 15',
  IPAD_MINI: 'iPad Mini',
  IPAD_PRO_11: 'iPad Pro 11',
  PIXEL_5: 'Pixel 5',
  PIXEL_7: 'Pixel 7',
  GALAXY_S9_PLUS: 'Galaxy S9+',
  GALAXY_TAB_S4: 'Galaxy Tab S4',
};

/**
 * An explicit screen, for the case a preset cannot express.
 *
 * `width` and `height` are required and everything else is optional, because
 * everything else has a browser default that is correct to leave alone.
 * `deviceScaleFactor: 1`, `hasTouch: false` and a bare `isMobile: false` are
 * what a browser does anyway, so an absent field and a field set to the default
 * mean the same thing HERE and nowhere else in this file — stated rather than
 * assumed, because `userAgent` is the one that does not work that way: an absent
 * user agent is the engine's own, and a fabricated one is a lie the application
 * under test will believe.
 */
export interface ExplicitViewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  hasTouch?: boolean;
  isMobile?: boolean;
  /** Absent = the engine's own. Never synthesised. */
  userAgent?: string;
}

export type MatrixDevice =
  | { readonly kind: 'PRESET'; readonly preset: DevicePreset }
  | { readonly kind: 'VIEWPORT'; readonly viewport: ExplicitViewport };

// ─── Rendering preferences ───────────────────────────────────────────────────

/**
 * `prefers-color-scheme`.
 *
 * NO_PREFERENCE is a real third answer and not a stand-in for "unset": a
 * stylesheet can and does branch on it, and a matrix that offered only
 * light/dark could not cover the branch. Omitting the whole field from a
 * {@link BrowserEnvironment} is how a caller says "leave it alone", which is a
 * fourth, different thing.
 */
export const COLOUR_SCHEMES = ['LIGHT', 'DARK', 'NO_PREFERENCE'] as const;
export type ColourScheme = (typeof COLOUR_SCHEMES)[number];

const COLOUR_SCHEME_PRESENT: Record<ColourScheme, true> = {
  LIGHT: true,
  DARK: true,
  NO_PREFERENCE: true,
};

export const COLOUR_SCHEME_LIST = Object.keys(
  COLOUR_SCHEME_PRESENT,
) as ReadonlyArray<ColourScheme>;

export const PLAYWRIGHT_COLOUR_SCHEME: Record<ColourScheme, string> = {
  LIGHT: 'light',
  DARK: 'dark',
  NO_PREFERENCE: 'no-preference',
};

/** `prefers-reduced-motion`. The axis every animation-gated assertion needs. */
export const REDUCED_MOTION_PREFERENCES = ['REDUCE', 'NO_PREFERENCE'] as const;
export type ReducedMotionPreference = (typeof REDUCED_MOTION_PREFERENCES)[number];

const REDUCED_MOTION_PRESENT: Record<ReducedMotionPreference, true> = {
  REDUCE: true,
  NO_PREFERENCE: true,
};

export const REDUCED_MOTION_LIST = Object.keys(
  REDUCED_MOTION_PRESENT,
) as ReadonlyArray<ReducedMotionPreference>;

export const PLAYWRIGHT_REDUCED_MOTION: Record<ReducedMotionPreference, string> = {
  REDUCE: 'reduce',
  NO_PREFERENCE: 'no-preference',
};

/** `forced-colors`, the Windows high-contrast axis nothing in this product reached. */
export const FORCED_COLORS_MODES = ['ACTIVE', 'NONE'] as const;
export type ForcedColorsMode = (typeof FORCED_COLORS_MODES)[number];

const FORCED_COLORS_PRESENT: Record<ForcedColorsMode, true> = {
  ACTIVE: true,
  NONE: true,
};

export const FORCED_COLORS_LIST = Object.keys(
  FORCED_COLORS_PRESENT,
) as ReadonlyArray<ForcedColorsMode>;

export const PLAYWRIGHT_FORCED_COLORS: Record<ForcedColorsMode, string> = {
  ACTIVE: 'active',
  NONE: 'none',
};

// ─── Interaction states ──────────────────────────────────────────────────────

/**
 * The states a surface has to be PUT INTO before a capture means anything.
 *
 * This is the other half of the visual defect. A VISUAL test could name a path
 * and a viewport, so what it captured was always the page as it arrives — and a
 * dropdown, a focus ring, an error summary, a loading skeleton and an empty
 * state are exactly the places visual regressions live. Covering them took one
 * hand-written test each, so in practice nobody covered them.
 *
 * A state that could not be reached is UNREACHED with a reason from
 * {@link STATE_UNREACHED_REASONS}. It is NEVER a baseline captured of whatever
 * the page happened to be showing: that is the worst available outcome, because
 * the reference image then looks fine, is approved, and permanently asserts the
 * DEFAULT state under the name of a state nobody ever saw.
 */
export const INTERACTION_STATES = [
  /** As the surface arrives. The only state a capture gets for free. */
  'DEFAULT',
  'HOVER',
  'FOCUS',
  'FOCUS_VISIBLE',
  'ACTIVE',
  /** A menu, dialog, drawer or popover standing open. */
  'OPEN',
  'EXPANDED',
  'SELECTED',
  'CHECKED',
  'DISABLED',
  /** Validation has run and failed. Reached by submitting, not by styling. */
  'ERROR',
  /** Mid-request: skeletons, spinners, optimistic rows. */
  'LOADING',
  /** The zero-row rendering, which is the one a fixture-seeded suite never sees. */
  'EMPTY',
  /** Enough rows to paginate, wrap or overflow. */
  'POPULATED',
] as const;
export type InteractionState = (typeof INTERACTION_STATES)[number];

const INTERACTION_STATE_PRESENT: Record<InteractionState, true> = {
  DEFAULT: true,
  HOVER: true,
  FOCUS: true,
  FOCUS_VISIBLE: true,
  ACTIVE: true,
  OPEN: true,
  EXPANDED: true,
  SELECTED: true,
  CHECKED: true,
  DISABLED: true,
  ERROR: true,
  LOADING: true,
  EMPTY: true,
  POPULATED: true,
};

export const INTERACTION_STATE_LIST = Object.keys(
  INTERACTION_STATE_PRESENT,
) as ReadonlyArray<InteractionState>;

/**
 * WHY a declared state was not reached.
 *
 * TEXT and not a Prisma enum, on the same judgement as
 * `TestCoverageEdge.cappedBy` and `MutationSurvivor.reason`: the domain is
 * enforced at the producer by `stateUnreachedReasonSchema` in ./schemas.ts, and
 * nothing FILTERS rows on it — the reads are "show me this capture" and "which
 * states did this route never reach", and the second groups on the STATE, not on
 * the reason. An enum here would be a Postgres type whose only job is to need a
 * drift guard, and this round already mints two that earn one.
 *
 * NOT_ATTEMPTED is the weakest and the only honest reading of a state nothing
 * tried, and it is deliberately distinct from ENGINE_CANNOT_SIMULATE: one is
 * work for us, the other is a fact about the browser.
 */
export const STATE_UNREACHED_REASONS = [
  /** Nothing in the surface matched the state's trigger. */
  'NO_TRIGGER_FOUND',
  /** The trigger exists and is not interactable — covered, off-screen, aria-hidden. */
  'TRIGGER_NOT_VISIBLE',
  /** The state needs rows, or needs zero rows, and the fixture gave neither. */
  'REQUIRES_DATA',
  /** Only a signed-in or specifically-roled principal can see it. */
  'REQUIRES_PRINCIPAL',
  /** The engine has no way to hold this state for a screenshot. */
  'ENGINE_CANNOT_SIMULATE',
  /** The wait for the state expired. A cap that bit, and reported as one. */
  'TIMED_OUT',
  /** Nobody tried. Not evidence about the surface in either direction. */
  'NOT_ATTEMPTED',
] as const;
export type StateUnreachedReason = (typeof STATE_UNREACHED_REASONS)[number];

const STATE_UNREACHED_PRESENT: Record<StateUnreachedReason, true> = {
  NO_TRIGGER_FOUND: true,
  TRIGGER_NOT_VISIBLE: true,
  REQUIRES_DATA: true,
  REQUIRES_PRINCIPAL: true,
  ENGINE_CANNOT_SIMULATE: true,
  TIMED_OUT: true,
  NOT_ATTEMPTED: true,
};

export const STATE_UNREACHED_REASON_LIST = Object.keys(
  STATE_UNREACHED_PRESENT,
) as ReadonlyArray<StateUnreachedReason>;

/**
 * States no screenshot may be claimed for when the reason is this one.
 *
 * Exported so the gate and the reporter test membership of ONE list rather than
 * each re-deciding. Every member is a reason the state was never on screen, so a
 * capture alongside it would be a capture of something else entirely.
 */
export const NEVER_CAPTURABLE_UNREACHED_REASONS: readonly StateUnreachedReason[] = [
  'NO_TRIGGER_FOUND',
  'TRIGGER_NOT_VISIBLE',
  'REQUIRES_DATA',
  'REQUIRES_PRINCIPAL',
  'ENGINE_CANNOT_SIMULATE',
  'TIMED_OUT',
  'NOT_ATTEMPTED',
];

// ─── A cell ──────────────────────────────────────────────────────────────────

/**
 * ONE cell of the matrix: the whole of what "where did this run" means.
 *
 * Every field is optional except none — and that is the point of the shape. A
 * cell that names only `{ engine: 'chromium' }` is a legitimate cell meaning
 * "chromium, bundled, whatever version, whatever device, browser defaults
 * throughout", and it is what every test in this product has implicitly been
 * for its whole life. A cell that names all eight axes is the other end. Both
 * produce a key, and the key says which axes were VARIED and which were not, so
 * a report can never print "light mode" for a run that expressed no opinion
 * about colour scheme.
 *
 * `engine` is optional for one specific reason, and it is the refinement
 * ./schemas.ts carries: a cell may legitimately say "this device, I do not care
 * which engine", but a cell may NOT pin a version or name a channel without one.
 * A version range is a claim about one engine's release train — Chrome 120 and
 * Firefox 120 are unrelated builds months apart — so an unanchored range would
 * be checked against whatever the deployment happened to launch, which is a
 * number compared to nothing.
 */
export interface MatrixCell {
  /** Absent = the deployment's default engine, and reported as `<default>`. */
  readonly engine?: BrowserEngine;
  /** Absent = BUNDLED. Distinguished from an explicit BUNDLED only in intent. */
  readonly channel?: BrowserChannel;
  /** Absent = UNPINNED. No version is read and none is reported. */
  readonly version?: BrowserVersionPin;
  /** Absent = the engine's own window size. */
  readonly device?: MatrixDevice;
  readonly colourScheme?: ColourScheme;
  readonly reducedMotion?: ReducedMotionPreference;
  readonly forcedColors?: ForcedColorsMode;
  /** BCP-47. Absent = the engine's own, which is whatever the image's locale is. */
  readonly locale?: string;
  /** IANA zone. Absent = the host's, which is why a date test must name one. */
  readonly timezone?: string;
}

/** The empty cell: every axis unvaried. What every pre-matrix test has always been. */
export const UNVARIED_CELL: MatrixCell = {};

function deviceKey(device: MatrixDevice | undefined): string {
  if (!device) return UNVARIED;
  if (device.kind === 'PRESET') return device.preset;
  const v = device.viewport;
  /*
   * Only the parts the caller actually set go in the key. Appending `@1x` or
   * `touch=false` unconditionally would make two keys for one screen — the
   * explicit default and the absent one — and `TestResultVariant`'s unique index
   * would then hold both, counting one cell twice in every denominator.
   */
  const parts = [`${v.width}x${v.height}`];
  if (v.deviceScaleFactor !== undefined) parts.push(`@${v.deviceScaleFactor}x`);
  if (v.hasTouch !== undefined) parts.push(v.hasTouch ? 'touch' : 'notouch');
  if (v.isMobile !== undefined) parts.push(v.isMobile ? 'mobile' : 'desktop');
  if (v.userAgent !== undefined) parts.push('ua');
  return parts.join('/');
}

/**
 * The version segment of a browser key.
 *
 * ── `<` IS AN ANGLE BRACKET, AND THAT MADE A WHOLE RUN VANISH ───────────────
 *
 * The bounded window used to spell itself `>=120<130`, which reads perfectly
 * and is a value BOTH ingest paths REFUSE: `variantDimension` in schemas.ts
 * reserves angle brackets for strings that are EXACTLY a sentinel — the one
 * thing that stops a producer forging "this dimension was not varied" — so the
 * `<` in the middle of a composite is refused for the same reason
 * `<unvaried>+dark` was.
 *
 * The cost was total and silent, identical to the two leaks repaired alongside
 * it. `validateMeasurements` in apps/worker/src/processors/run.ts refuses a
 * matrix WHOLE on its first bad cell, so a CROSS_BROWSER test declaring ANY
 * bounded version window wrote ZERO variant rows for the entire run and said
 * so in one log line — no red test, because the one test that drove a bounded
 * window asserted the KEY and never put it through the schema that has to
 * accept it.
 *
 * `..` because it is what a reader already means by it and it is in neither
 * sentinel. NO STORED KEY MOVES: a key that reaches a column has been through
 * that refinement, so no accepted key has ever held a `<`, and the UNBOUNDED
 * form `>=120` — which has no bracket and is storable — is byte-identical.
 */
function versionKey(pin: BrowserVersionPin | undefined): string {
  if (!pin || pin.kind === 'UNPINNED') return UNVARIED;
  return pin.range.below === null
    ? `>=${pin.range.atLeast}`
    : `>=${pin.range.atLeast}..${pin.range.below}`;
}

/** The sentinel for an axis the cell expressed no opinion about. */
export const DEFAULT_ENGINE_KEY = '<default>';

/**
 * The `TestResultVariant.browser` value for this cell.
 *
 * The MEASURE round gave that table five NOT NULL TEXT dimensions — browser,
 * viewport, locale, role, environment — with `'<unvaried>'` meaning nobody
 * varied this axis, and a six-column unique over them. This round widens what
 * "browser" and "viewport" can mean WITHOUT adding a column to the largest table
 * in the product, by making these two functions the only producers of those two
 * strings.
 *
 * That is deliberate and it is the instruction the MEASURE round left: per-cell
 * evidence lands on `TestResultVariant`, not on a parallel shape beside it. The
 * axes those five columns cannot express — channel is in here, but device scheme
 * and motion are not — travel in `TestResultVariant.matrixCell` as the resolved
 * cell, which this round adds, and the KEY stays the identity.
 */
export function variantBrowserKey(cell: MatrixCell): string {
  const engine = cell.engine ?? DEFAULT_ENGINE_KEY;
  const channel = cell.channel ?? 'BUNDLED';
  const version = versionKey(cell.version);
  const base = channel === 'BUNDLED' ? engine : `${engine}:${channel}`;
  return version === UNVARIED ? base : `${base}@${version}`;
}

/**
 * The `TestResultVariant.viewport` value for this cell.
 *
 * Carries the rendering preferences as well as the screen, because those three
 * axes are what a VISUAL capture differs by and the table has exactly one column
 * for "how big and how rendered". Appended only when set, for the same
 * double-counting reason {@link deviceKey} records.
 *
 * ── A SENTINEL IS NEVER A SEGMENT OF A COMPOSITE KEY ────────────────────────
 *
 * The screen segment is dropped when it is the UNVARIED sentinel AND a
 * rendering preference follows, so a cell that varies only the colour scheme
 * keys as `dark` and not as `<unvaried>+dark`.
 *
 * That string was a live, silent defect rather than an ugly key.
 * `variantDimension` in schemas.ts reserves angle brackets for values that are
 * EXACTLY a sentinel — the one thing that stops a caller forging "this
 * dimension was not varied" for a cell that was — so `<unvaried>+dark` is a
 * value BOTH ingest paths REFUSE. And `validateMeasurements` refuses a matrix
 * WHOLE on its first bad cell, there being no such thing as half a matrix. So a
 * customer declaring a dark-mode cell lost every variant row of that run,
 * including the cells that ran perfectly, to one log line and no red test.
 *
 * The repair is here and not in the refinement because `<unvaried>+dark` is
 * self-contradictory on its own terms: it claims nobody varied the viewport and
 * then names what varied. Teaching the refinement to accept a sentinel inside a
 * composite would have reopened the forging hole it exists for. An absent
 * screen segment already MEANS "the size was not varied", so nothing is lost.
 *
 * No stored key changes. A key that reaches a column has been through that
 * refinement, so no accepted key has ever contained an angle bracket anywhere
 * but as its whole value — the only strings this moves are ones nothing could
 * store. `1280x800+dark` is byte-identical, and so is every key that names a
 * device, which is all of VisualBaseline's: {@link baselineViewportKey} is
 * only ever handed a cell from `floorCellFor`, which always sets one.
 */
export function variantViewportKey(cell: MatrixCell): string {
  const rendering: string[] = [];
  if (cell.colourScheme !== undefined) rendering.push(cell.colourScheme.toLowerCase());
  if (cell.reducedMotion !== undefined) {
    rendering.push(cell.reducedMotion === 'REDUCE' ? 'reduced-motion' : 'full-motion');
  }
  if (cell.forcedColors !== undefined) {
    rendering.push(cell.forcedColors === 'ACTIVE' ? 'forced-colors' : 'no-forced-colors');
  }

  const screen = deviceKey(cell.device);
  if (rendering.length === 0) return screen;
  return screen === UNVARIED ? rendering.join('+') : [screen, ...rendering].join('+');
}

/**
 * The `TestResultVariant.locale` value for this cell.
 *
 * ── TWO ZONES, ONE ROW, AND THE WHOLE MATRIX LOST ───────────────────────────
 *
 * The timezone lived in {@link matrixCellKey}, in the stored cell, and in
 * NOTHING ELSE. The five-column identity a row is written under did not carry
 * it: `variantKeyFor` built this column as `cell.locale ?? UNVARIED`, so two
 * cells differing ONLY by zone were one row. `planMatrix`'s own duplicate check
 * cannot see that, because it keys on `matrixCellKey`, which DOES include the
 * timezone — the plan is two honest cells — so the loss landed at the far end:
 * `planMeasurements` refuses a matrix WHOLE for a duplicated cell, so the run
 * wrote ZERO variant rows behind one log line, and the worst-wins roll-up
 * survived, so the run read as fine.
 *
 * `{ locales: [{ tag: 'en-US', timezone: 'America/New_York' },
 * { tag: 'en-US', timezone: 'Pacific/Auckland' }] }` is VALID to
 * `localizationSpecSchema` and is the single most natural thing a localisation
 * matrix says — half of localisation bugs are date and currency formatting, and
 * one locale in two zones is how you find them. It stored nothing at all. The
 * same collision was reachable on the CROSS_BROWSER `timezones` axis.
 *
 * ── THE FOUR SHAPES, AND WHY `@` IS NOT NEW VOCABULARY ──────────────────────
 *
 * `@` is already the separator {@link variantBrowserKey} uses for a version
 * pin, so a reader of these columns has seen it. Four shapes and no fifth:
 *
 *   · neither varied → `'<unvaried>'`             — the WHOLE value, a sentinel
 *   · locale only    → `'en-US'`                  — byte-identical to before
 *   · both           → `'en-US@America/New_York'`
 *   · timezone only  → `'@America/New_York'`
 *
 * The first two are BYTE-IDENTICAL to what this column has always held, and
 * that is the load-bearing half: no stored row is re-identified, so no
 * historical cell moves and nobody re-approves anything.
 *
 * The timezone-only shape leads with the SEPARATOR and not with the sentinel,
 * because `'<unvaried>@America/New_York'` is a value both ingest paths REFUSE.
 * `variantDimension` in schemas.ts reserves an angle bracket for a value that is
 * EXACTLY a sentinel — the one thing that stops a producer forging "nobody
 * varied this axis" for a cell that did — and a bracket mid-composite is the
 * `'<unvaried>+dark'` defect {@link variantViewportKey} records above, which
 * cost a run of its own. An absent locale segment already MEANS the locale was
 * not varied, so nothing is lost by dropping it.
 *
 * ── THE BOUND IS THE OTHER HALF OF THIS CHANGE ──────────────────────────────
 *
 * A tag is `.max(35)` and a zone `.max(64)` in every spec schema that declares
 * one, so this column can now hold 100 characters where it used to hold 35.
 * `testVariantKeySchema.locale` must be at least that wide or the widest legal
 * pair is refused — the same total, silent loss, one bound further on. The
 * widest-pair test in browser-matrix.test.ts derives those figures from the
 * spec schemas rather than restating them, so tightening either goes red here
 * instead of going quiet in production.
 */
export function variantLocaleKey(cell: MatrixCell): string {
  if (cell.timezone === undefined) return cell.locale ?? UNVARIED;
  return `${cell.locale ?? ''}@${cell.timezone}`;
}

/**
 * The `VisualBaseline.viewport` value for one cell IN ONE INTERACTION STATE.
 *
 * ── WHY THIS EXISTS RATHER THAN TWO MORE COLUMNS ON `VisualBaseline` ────────
 *
 * A visual test can now declare viewports, colour schemes, reduced motion AND
 * the states to reach first, and `VisualBaseline`'s unique key is
 * (testId, viewport, browser, environmentId). The obvious reading is that the
 * key needs two more members — otherwise a light and a dark capture of one test
 * upsert onto ONE row, whichever cell ran last becomes the other's reference,
 * and every later diff is measured against the wrong rendering. That is the
 * shared-baseline defect `environmentId` was added to kill, multiplied by the
 * number of cells, and a visual suite that cannot be made green gets switched
 * off.
 *
 * It does not need them, because `viewport` and `browser` ARE the cell as long
 * as one function produces each. Two properties make that the better trade:
 *
 *   · AN UNVARIED, DEFAULT-STATE CELL PRODUCES `1280x800` BYTE FOR BYTE, which
 *     is exactly what the pre-matrix writer wrote (`${width}x${height}` in
 *     plugins/visual.ts). So no existing baseline stops matching and no customer
 *     is forced into a re-approval sweep by a migration. A sixth column with a
 *     back-filled sentinel would have been correct and would have cost that.
 *   · A six-column unique there derives the name
 *     `VisualBaseline_testId_viewport_browser_environmentId_cellKey_state_key`,
 *     which is 69 bytes, and PostgreSQL TRUNCATES AT 63 SILENTLY — permanent
 *     phantom drift on every `migrate dev`, which an earlier round already paid
 *     for once.
 *
 * DEFAULT is appended as nothing, for the byte-identity above. Every other state
 * is appended after a `#`, which no other part of either key uses.
 */
export function baselineViewportKey(cell: MatrixCell, state: InteractionState): string {
  const base = variantViewportKey(cell);
  return state === 'DEFAULT' ? base : `${base}#${state}`;
}

/**
 * The whole cell as one deterministic string: the identity a baseline, a
 * capability probe and a report all have to agree on.
 *
 * Built out of the two variant keys plus locale and timezone, in a fixed order,
 * so two callers constructing the same cell from different field orders produce
 * byte-identical output. A `JSON.stringify` of the object would not: property
 * order is insertion order, and an optional field set to `undefined` is not the
 * same key as an absent one.
 *
 * ── WHERE THIS KEY AND THE ROW'S IDENTITY STILL DISAGREE ────────────────────
 *
 * This key keeps locale and timezone as SEPARATE segments while
 * {@link variantLocaleKey} composes them with an `@`. On every well-formed tag
 * the two now count the same four cell-borne axes, which is the point of that
 * function: a difference this key can see is a difference the row can store.
 *
 * They disagree in two directions on a MALFORMED tag, because `locale` is
 * unconstrained text — `z.string().min(2).max(35)` with no shape — in all three
 * schemas that declare one, so a tag may carry either delimiter:
 *
 *   · a tag of `en@<a zone>` keys the same COLUMN as `en` plus that zone, and a
 *     DIFFERENT key here, so a matrix holding both plans as two cells and then
 *     loses the lot to `planMeasurements`' duplicate refusal;
 *   · a tag of `en|US` with a zone of `x` keys the same KEY HERE as `en` with a
 *     zone of `US|x`, and two different columns, so the planner drops one of
 *     two cells the row could have told apart. That direction predates the
 *     composite.
 *
 * Both are closed at the DOOR by a BCP-47 shape on the tag, not by a producer
 * escaping a delimiter: a key that escapes is a key nobody can read back. The
 * tag bounds live in schemas.ts, which this round does not own, so this is
 * recorded here and reported rather than repaired.
 */
export function matrixCellKey(cell: MatrixCell): string {
  return [
    variantBrowserKey(cell),
    variantViewportKey(cell),
    cell.locale ?? UNVARIED,
    cell.timezone ?? UNVARIED,
  ].join('|');
}

/** Every axis this cell actually varied, for a report that must not over-claim. */
export function variedAxes(cell: MatrixCell): string[] {
  const axes: string[] = [];
  if (cell.engine !== undefined) axes.push('engine');
  if (cell.channel !== undefined && cell.channel !== 'BUNDLED') axes.push('channel');
  if (cell.version !== undefined && cell.version.kind === 'RANGE') axes.push('version');
  if (cell.device !== undefined) axes.push('device');
  if (cell.colourScheme !== undefined) axes.push('colourScheme');
  if (cell.reducedMotion !== undefined) axes.push('reducedMotion');
  if (cell.forcedColors !== undefined) axes.push('forcedColors');
  if (cell.locale !== undefined) axes.push('locale');
  if (cell.timezone !== undefined) axes.push('timezone');
  return axes;
}

// ─── Resolving a cell against a deployment ───────────────────────────────────

/**
 * What became of one cell when it met a real image.
 *
 * SIX members where `DeploymentCapabilityStatus` has four, and the two extra are
 * the reason this is its own vocabulary rather than a reuse. That one answers
 * "can this deployment execute this TEST TYPE", where every negative answer is
 * an install or an upgrade. A CELL has two more ways to fail, and both have
 * remedies nobody can act on by installing anything:
 *
 *   UNSUPPORTED_COMBINATION — no deployment anywhere can run this, because the
 *       combination does not exist. A Firefox beta channel is the example: there
 *       is no such build. Reporting it as MISSING sends a reader to install a
 *       thing that was never published, and reporting it as a SKIP hides an
 *       authoring mistake inside a percentage.
 *   NEEDS_BROWSER_GRID — the request is coherent and this image can never serve
 *       it, because a pinned Safari or Firefox VERSION means a released consumer
 *       browser and Playwright ships one patched build of each with no channels.
 *       Playwright's webkit is NOT Safari. The remedy is a hosted grid or a
 *       device farm, which is a purchase, not an install.
 *
 * A Prisma enum, with a `check:enums` pair, because this is filtered and grouped
 * on: "how many of this run's cells did we refuse, and for which of the six
 * reasons" is the question that stops a matrix percentage from including cells
 * that cannot run. That is the lie this product cannot afford, so the answer is
 * a `GROUP BY` and not a regex over a sentence.
 */
export const MATRIX_CELL_STATUSES = [
  /** Probed, and everything this cell names is here and usable. */
  'AVAILABLE',
  /** Probed, and the engine, channel or device preset is absent from this image. */
  'MISSING',
  /** Probed, present, and outside the version window the cell pinned. */
  'WRONG_VERSION',
  /** Nobody probed. Not a verdict about the image in either direction. */
  'NOT_CHECKED',
  /** No build of this engine has this channel. No image can ever satisfy it. */
  'UNSUPPORTED_COMBINATION',
  /** Coherent, and only a hosted grid or device farm can serve it. */
  'NEEDS_BROWSER_GRID',
] as const;
export type MatrixCellStatus = (typeof MATRIX_CELL_STATUSES)[number];

const MATRIX_CELL_STATUS_PRESENT: Record<MatrixCellStatus, true> = {
  AVAILABLE: true,
  MISSING: true,
  WRONG_VERSION: true,
  NOT_CHECKED: true,
  UNSUPPORTED_COMBINATION: true,
  NEEDS_BROWSER_GRID: true,
};

export const MATRIX_CELL_STATUS_LIST = Object.keys(
  MATRIX_CELL_STATUS_PRESENT,
) as ReadonlyArray<MatrixCellStatus>;

export const MATRIX_CELL_STATUS_LABELS: Record<MatrixCellStatus, string> = {
  AVAILABLE: 'this deployment can run this cell',
  MISSING: 'the engine, channel or device it names is not installed here',
  WRONG_VERSION: 'installed, and outside the version window this cell pinned',
  NOT_CHECKED: 'never probed — nothing is claimed in either direction',
  UNSUPPORTED_COMBINATION: 'no build of that engine has that channel, anywhere',
  NEEDS_BROWSER_GRID: 'a released consumer version — only a hosted grid can serve it',
};

/**
 * The statuses that mean NO EVIDENCE WAS PRODUCED, so the cell must leave every
 * numerator and every denominator.
 *
 * NOT_CHECKED is NOT here, and it is the same argument
 * `NON_EXECUTABLE_CAPABILITY_STATUSES` records: an unprobed cell stays in the
 * denominator, because dropping it would let a deployment that never ran a
 * preflight silently shed every cell it could not prove it could run, and the
 * percentage would rise for a probe nobody executed.
 */
export const UNEXERCISABLE_CELL_STATUSES: readonly MatrixCellStatus[] = [
  'MISSING',
  'WRONG_VERSION',
  'UNSUPPORTED_COMBINATION',
  'NEEDS_BROWSER_GRID',
];

/** Whether a cell of this status may be scored at all. */
export function cellCounts(status: MatrixCellStatus): boolean {
  return !UNEXERCISABLE_CELL_STATUSES.includes(status);
}

/**
 * What a deployment reported about itself, as an INJECTED fact.
 *
 * Nothing in this module looks anything up: it has no filesystem, no process
 * and no Playwright, which is what lets the whole resolution table below be
 * tested in milliseconds with no browser. The one thin adapter that actually
 * stats a browser install lives in packages/runner/src/preflight.ts, which
 * already has a probe budget and a cache around it.
 *
 * EVERY FIELD IS OPTIONAL AND ABSENT MEANS NOT PROBED. That is the whole reason
 * this is three optional maps rather than three required ones: a resolution
 * against an empty capability returns NOT_CHECKED for everything, which is
 * correct and is what a caller with no preflight must get. A default of "yes,
 * installed" would turn a missing probe into an AVAILABLE cell, and a default of
 * "no" would refuse a working image.
 */
export interface DeploymentBrowsers {
  /** Which engines are on disk. Absent engine = not probed. */
  readonly engines?: Readonly<Partial<Record<BrowserEngine, boolean>>>;
  /** Which channels resolved. Absent channel = not probed. */
  readonly channels?: Readonly<Partial<Record<BrowserChannel, boolean>>>;
  /**
   * The version each (engine, channel) pair reported, keyed by
   * {@link variantBrowserKey} of a cell naming only those two. Absent = no
   * version was read, which resolves NOT_CHECKED and never AVAILABLE.
   */
  readonly versions?: Readonly<Record<string, string>>;
  /** Device preset names the registry resolved. Absent preset = not probed. */
  readonly devicePresets?: Readonly<Partial<Record<DevicePreset, boolean>>>;
}

export interface MatrixCellResolution {
  readonly cell: MatrixCell;
  readonly key: string;
  readonly status: MatrixCellStatus;
  /** What was LOOKED AT, never what was assumed. One clause, for a report. */
  readonly detail: string;
  /**
   * The exact next action, or `null` for AVAILABLE and NOT_CHECKED.
   *
   * Null on NOT_CHECKED on purpose: there is no remedy for a question nobody
   * asked, and inventing one ("install chromium") would be advice derived from a
   * fact we do not have.
   */
  readonly remedy: string | null;
  /**
   * What the probe read back, when it read anything. Null for every other case —
   * no range declared, nothing installed, nothing probed — and all three are
   * "not measured", none of which may be rendered as a version.
   */
  readonly observedVersion: string | null;
}

/**
 * Resolve one cell against one deployment.
 *
 * Order matters and is the honesty of the function. The IMPOSSIBLE checks come
 * first, because they are properties of the world and no probe can change them:
 * asking whether a Firefox beta is installed is a question with no meaningful
 * answer. Then the GRID check, for a request this image can never serve. Only
 * then the probes, and only then the version, because a version comparison
 * against something that is not installed is a number compared to nothing.
 */
export function resolveMatrixCell(
  cell: MatrixCell,
  deployment: DeploymentBrowsers = {},
): MatrixCellResolution {
  const key = matrixCellKey(cell);
  const engine = cell.engine;
  const channel = cell.channel ?? 'BUNDLED';
  const pin = cell.version ?? UNPINNED;
  const base = { cell, key } as const;

  // 1. Does the combination exist at all?
  if (engine !== undefined && !channelExistsFor(engine, channel)) {
    return {
      ...base,
      status: 'UNSUPPORTED_COMBINATION',
      detail: `${channel} is a build of ${CHANNEL_ENGINE[channel] ?? 'no engine'}, and this cell names ${engine}`,
      remedy: `Drop the channel from the ${engine} cell, or move it to a chromium cell. There is no ${channel} build of ${engine} to install.`,
      observedVersion: null,
    };
  }

  // 2. Is it a released consumer version, which this image has no way to serve?
  if (
    pin.kind === 'RANGE' &&
    (engine === 'firefox' || engine === 'webkit') &&
    channel === 'BUNDLED'
  ) {
    return {
      ...base,
      status: 'NEEDS_BROWSER_GRID',
      detail: `a pinned ${engine} version (${describeVersionRange(pin.range)}) means a released consumer browser, and Playwright ships one patched ${engine} build with no channels — its webkit is not Safari`,
      remedy:
        'Point this cell at a hosted browser grid or device farm, or drop the version pin and test the bundled build. No install on this image satisfies it.',
      observedVersion: null,
    };
  }

  // 3. Is the engine on disk?
  if (engine !== undefined) {
    const installed = deployment.engines?.[engine];
    if (installed === false) {
      return {
        ...base,
        status: 'MISSING',
        detail: `the ${engine} browser is not installed on this deployment`,
        remedy: 'npx playwright install',
        observedVersion: null,
      };
    }
    if (installed === undefined) {
      return {
        ...base,
        status: 'NOT_CHECKED',
        detail: `nothing probed whether ${engine} is installed here`,
        remedy: null,
        observedVersion: null,
      };
    }
  }

  // 4. Did the channel resolve?
  if (channel !== 'BUNDLED') {
    const resolved = deployment.channels?.[channel];
    if (resolved === false) {
      return {
        ...base,
        status: 'MISSING',
        detail: `the ${PLAYWRIGHT_CHANNEL[channel] ?? channel} channel did not resolve on this deployment`,
        remedy: `Install the ${PLAYWRIGHT_CHANNEL[channel] ?? channel} browser, or run \`npx playwright install ${PLAYWRIGHT_CHANNEL[channel] ?? ''}\`.`,
        observedVersion: null,
      };
    }
    if (resolved === undefined) {
      return {
        ...base,
        status: 'NOT_CHECKED',
        detail: `nothing probed whether the ${PLAYWRIGHT_CHANNEL[channel] ?? channel} channel resolves here`,
        remedy: null,
        observedVersion: null,
      };
    }
  }

  // 5. Did the device preset resolve? An explicit viewport needs no registry.
  if (cell.device?.kind === 'PRESET') {
    const preset = cell.device.preset;
    const known = deployment.devicePresets?.[preset];
    if (known === false) {
      return {
        ...base,
        status: 'MISSING',
        detail: `the device registry on this deployment has no descriptor named "${PLAYWRIGHT_DEVICE[preset]}"`,
        remedy: `Upgrade Playwright, or replace the preset with an explicit viewport. It must NOT fall back to a desktop window — a mobile test executed at desktop size passes while asserting nothing about a phone.`,
        observedVersion: null,
      };
    }
    if (known === undefined) {
      return {
        ...base,
        status: 'NOT_CHECKED',
        detail: `nothing probed whether "${PLAYWRIGHT_DEVICE[preset]}" is in this deployment's device registry`,
        remedy: null,
        observedVersion: null,
      };
    }
  }

  // 6. The version, last, because it is the only check that needed the others to pass.
  if (pin.kind === 'RANGE') {
    const observed = deployment.versions?.[variantBrowserKey({ ...cell, version: UNPINNED })];
    if (observed === undefined) {
      return {
        ...base,
        status: 'NOT_CHECKED',
        detail: `this cell pins ${describeVersionRange(pin.range)} and no version was read for ${engine ?? DEFAULT_ENGINE_KEY}/${channel}`,
        remedy: null,
        observedVersion: null,
      };
    }
    const inside = versionInRange(observed, pin.range);
    if (inside === null) {
      return {
        ...base,
        status: 'NOT_CHECKED',
        detail: `the reported version could not be parsed, so the window ${describeVersionRange(pin.range)} was not applied`,
        remedy: null,
        observedVersion: observed,
      };
    }
    if (!inside) {
      return {
        ...base,
        status: 'WRONG_VERSION',
        detail: `installed ${observed}, outside ${describeVersionRange(pin.range)} — needed because ${pin.range.why}`,
        remedy:
          channel === 'BUNDLED'
            ? 'Pin the `playwright` dependency to a release carrying a browser inside the window, or move this cell to a channel.'
            : `Install a ${PLAYWRIGHT_CHANNEL[channel] ?? channel} inside the window, or widen the pin.`,
        observedVersion: observed,
      };
    }
    return {
      ...base,
      status: 'AVAILABLE',
      detail: `installed ${observed}, inside ${describeVersionRange(pin.range)}`,
      remedy: null,
      observedVersion: observed,
    };
  }

  return {
    ...base,
    status: 'AVAILABLE',
    detail:
      engine === undefined
        ? "every axis this cell names resolved; it expressed no opinion about the engine, so the deployment's default runs it"
        : `${engine}/${channel} resolved on this deployment`,
    remedy: null,
    observedVersion: null,
  };
}

// ─── The browser environment block ───────────────────────────────────────────

/**
 * Named throttling profiles, because a magic number is not a test.
 *
 * The four numbers in each entry mirror the presets Chrome DevTools publishes
 * under the same names, and that provenance is the point: `"2000"` in a spec is
 * a figure somebody typed, where `SLOW_3G` is a condition two engineers can
 * agree they measured the same thing under. A profile is a DEFINITION this file
 * chooses, not a measurement it claims — which is the difference between this
 * list and a version floor, and is why this one may carry numbers while
 * {@link DEVICE_PRESETS} may not.
 *
 * OFFLINE is a member AND there is a separate `offline` boolean on the block.
 * That is not redundancy: Playwright's offline mode and a zero-bandwidth profile
 * are different mechanisms with different failure modes, and a spec that set one
 * and not the other was silently half-throttled. ./schemas.ts refuses the
 * contradiction rather than picking a winner.
 */
export const NETWORK_PROFILES = [
  'NO_THROTTLING',
  'WIFI',
  'REGULAR_4G',
  'FAST_3G',
  'SLOW_3G',
  'OFFLINE',
] as const;
export type NetworkProfile = (typeof NETWORK_PROFILES)[number];

const NETWORK_PROFILE_PRESENT: Record<NetworkProfile, true> = {
  NO_THROTTLING: true,
  WIFI: true,
  REGULAR_4G: true,
  FAST_3G: true,
  SLOW_3G: true,
  OFFLINE: true,
};

export const NETWORK_PROFILE_LIST = Object.keys(
  NETWORK_PROFILE_PRESENT,
) as ReadonlyArray<NetworkProfile>;

export interface NetworkProfileShape {
  /** Kilobits per second down. `0` with `offline: true` means no link at all. */
  downloadKbps: number;
  uploadKbps: number;
  latencyMs: number;
  /** True only for OFFLINE: the link is down, not merely slow. */
  offline: boolean;
}

export const NETWORK_PROFILE_SHAPES: Record<NetworkProfile, NetworkProfileShape> = {
  NO_THROTTLING: { downloadKbps: 0, uploadKbps: 0, latencyMs: 0, offline: false },
  WIFI: { downloadKbps: 30_000, uploadKbps: 15_000, latencyMs: 2, offline: false },
  REGULAR_4G: { downloadKbps: 4_000, uploadKbps: 3_000, latencyMs: 20, offline: false },
  FAST_3G: { downloadKbps: 1_600, uploadKbps: 750, latencyMs: 150, offline: false },
  SLOW_3G: { downloadKbps: 400, uploadKbps: 400, latencyMs: 400, offline: false },
  OFFLINE: { downloadKbps: 0, uploadKbps: 0, latencyMs: 0, offline: true },
};

/**
 * `NO_THROTTLING` is a real instruction and not an absence.
 *
 * Exported so a caller can tell "the customer chose not to throttle" from "the
 * customer said nothing about throttling". The second is the absent field and
 * means the browser's own behaviour; the first is a decision a report may print.
 */
export const UNTHROTTLED_PROFILES: readonly NetworkProfile[] = ['NO_THROTTLING'];

/**
 * Permissions a context may be granted.
 *
 * Spelled in this file's convention and mapped by {@link PLAYWRIGHT_PERMISSION}
 * to the strings the browser accepts, for the same two reasons
 * {@link DEVICE_PRESETS} records: a hyphenated literal in a stored key is a
 * rename away from orphaning every historical row, and a grouped query wants a
 * token.
 *
 * ── A GRANT IS NOT A CAPABILITY ─────────────────────────────────────────────
 *
 * Playwright's `grantPermissions` is a Chromium-backed API. On firefox and
 * webkit most of these names are accepted and do nothing, which is the worst
 * available shape: the test proceeds, the permission prompt never appears
 * because the feature is not wired, and the assertion that "no prompt blocked
 * us" passes. {@link environmentUnsupportedOn} is how that is REPORTED rather
 * than discovered, and it is why the field exists on the block instead of being
 * silently applied.
 */
export const BROWSER_PERMISSIONS = [
  'GEOLOCATION',
  'NOTIFICATIONS',
  'CAMERA',
  'MICROPHONE',
  'CLIPBOARD_READ',
  'CLIPBOARD_WRITE',
  'BACKGROUND_SYNC',
  'MIDI',
  'PAYMENT_HANDLER',
  'STORAGE_ACCESS',
  'ACCELEROMETER',
  'GYROSCOPE',
  'MAGNETOMETER',
] as const;
export type BrowserPermission = (typeof BROWSER_PERMISSIONS)[number];

const BROWSER_PERMISSION_PRESENT: Record<BrowserPermission, true> = {
  GEOLOCATION: true,
  NOTIFICATIONS: true,
  CAMERA: true,
  MICROPHONE: true,
  CLIPBOARD_READ: true,
  CLIPBOARD_WRITE: true,
  BACKGROUND_SYNC: true,
  MIDI: true,
  PAYMENT_HANDLER: true,
  STORAGE_ACCESS: true,
  ACCELEROMETER: true,
  GYROSCOPE: true,
  MAGNETOMETER: true,
};

export const BROWSER_PERMISSION_LIST = Object.keys(
  BROWSER_PERMISSION_PRESENT,
) as ReadonlyArray<BrowserPermission>;

export const PLAYWRIGHT_PERMISSION: Record<BrowserPermission, string> = {
  GEOLOCATION: 'geolocation',
  NOTIFICATIONS: 'notifications',
  CAMERA: 'camera',
  MICROPHONE: 'microphone',
  CLIPBOARD_READ: 'clipboard-read',
  CLIPBOARD_WRITE: 'clipboard-write',
  BACKGROUND_SYNC: 'background-sync',
  MIDI: 'midi',
  PAYMENT_HANDLER: 'payment-handler',
  STORAGE_ACCESS: 'storage-access',
  ACCELEROMETER: 'accelerometer',
  GYROSCOPE: 'gyroscope',
  MAGNETOMETER: 'magnetometer',
};

/**
 * A synthetic camera or microphone stream, and the fixture it plays.
 *
 * `fixture` is REQUIRED and that is the whole shape. Chromium's fake-device
 * flags, used without a file, synthesise a rolling green pattern and a beep —
 * so a QR-scanner test, an identity-document upload or a video-call join would
 * run against content nobody chose, fail to find what it was looking for, and
 * report an application defect. A fake stream with no named fixture is a
 * fabricated default in the most literal sense, so there is no way to express
 * one: the field is not optional.
 */
export interface FakeMediaDevice {
  /** A fixture key the run already loaded. Never a path off this machine. */
  readonly fixture: string;
  /** What the fixture contains, for a report that has to explain a failure. */
  readonly describes: string;
}

/**
 * HTTP basic credentials, as SECRET NAMES ONLY.
 *
 * There is no `password` field and there never will be. `.strict()` in
 * ./schemas.ts means an extra property is REFUSED rather than dropped, so this
 * block is structurally incapable of carrying a credential — the same
 * arrangement, and the same argument, as the provider catalogue's entry shape.
 * The names resolve against the project's `Secret` rows at launch, in the
 * runner, and the resolved values never return to a spec, a log or a report.
 */
export interface HttpCredentialRef {
  readonly usernameSecretName: string;
  readonly passwordSecretName: string;
  /** Scope it to one origin, so a redirect cannot carry it somewhere else. */
  readonly origin?: string;
}

/**
 * THE BROWSER ENVIRONMENT BLOCK — everything `CONFIG_TEMPLATE`'s `use` could
 * not say.
 *
 * It carried baseURL, timezone and locale. So geolocation, permissions, fake
 * media, clipboard, throttling, offline, colour scheme, reduced motion,
 * forced-colors, device scale and HTTP credentials were all ungated, and every
 * feature behind one of them was untestable with nothing anywhere saying so.
 *
 * EVERY FIELD IS OPTIONAL AND ABSENT MEANS THE BROWSER'S OWN DEFAULT. Not one
 * of them has a fallback value in this file, and `geolocation` is why: a
 * defaulted `{ 0, 0 }` would put every location test at Null Island and every
 * one of them would pass, somewhere nobody chose, for ever. The refusals live in
 * `browserEnvironmentSchema` and {@link fabricatedEnvironmentFields} is their
 * pure half.
 *
 * `locale` and `timezone` are deliberately NOT here. They belong to the CELL —
 * they are axes a matrix varies, and a report breaks results down by them — and
 * carrying them in both places is how one spec comes to name two locales.
 */
export interface BrowserEnvironment {
  /**
   * Both coordinates required when present. An accuracy is optional because the
   * browser has one; a latitude without a longitude is not a place.
   */
  readonly geolocation?: {
    readonly latitude: number;
    readonly longitude: number;
    readonly accuracyMetres?: number;
  };
  /**
   * An EXPLICIT grant list. Absent means "grant nothing, and let the
   * application's own prompts happen", which is what a browser does. An EMPTY
   * ARRAY is refused by the schema: it is indistinguishable from absent and
   * claims a decision nobody made.
   */
  readonly permissions?: readonly BrowserPermission[];
  readonly camera?: FakeMediaDevice;
  readonly microphone?: FakeMediaDevice;
  /**
   * Clipboard read/write without a prompt. A convenience flag over the two
   * permissions, kept separate because the thing a copy-button test needs is
   * "the clipboard works", and spelling that as two permission grants is how
   * half of them get written with one.
   */
  readonly clipboard?: boolean;
  readonly network?: NetworkProfile;
  /**
   * Playwright's own offline switch. Distinct from `network: 'OFFLINE'`; the
   * schema refuses the contradiction rather than choosing.
   */
  readonly offline?: boolean;
  readonly colourScheme?: ColourScheme;
  readonly reducedMotion?: ReducedMotionPreference;
  readonly forcedColors?: ForcedColorsMode;
  /**
   * An override for the device's own. Present ONLY to answer "does our layout
   * survive a 3x screen", because a preset carries its own factor and this
   * would otherwise contradict it. The schema refuses it alongside a PRESET
   * device for that reason.
   */
  readonly deviceScaleFactor?: number;
  readonly httpCredentials?: HttpCredentialRef;
}

/**
 * Fields whose value is the shape of a fallback rather than a choice.
 *
 * THE DEFECT: every one of these reads as a measurement and is in fact a
 * placeholder, and the test built on it PASSES. `{ 0, 0 }` is the archetype —
 * Null Island is a real coordinate, so the browser accepts it, the application
 * geolocates, and the assertion holds somewhere nobody chose. An empty
 * permission list is the same mistake wearing a different hat: it is identical
 * in effect to the absent field, so it cannot be a decision, so the only reason
 * it is there is that a writer had nowhere else to put "I do not know".
 *
 * Returned as a list of `{ field, why }` rather than a boolean so a refusal can
 * name every one at once: a producer that fixed the geolocation and left the
 * empty grant list would otherwise be refused twice.
 *
 * `0` is NOT refused as a latitude or longitude on its own — the equator and
 * the prime meridian exist — only the PAIR, which is the fallback-shaped value.
 * A test that genuinely needs Null Island may say `0.0001`, and that is a far
 * better trade than accepting the one coordinate pair this product's own
 * producers are most likely to write by accident.
 */
export function fabricatedEnvironmentFields(
  env: BrowserEnvironment,
): Array<{ field: string; why: string }> {
  const found: Array<{ field: string; why: string }> = [];

  if (env.geolocation && env.geolocation.latitude === 0 && env.geolocation.longitude === 0) {
    found.push({
      field: 'geolocation',
      why: '0,0 is Null Island — a real coordinate the browser accepts, and the exact value a producer writes when it has none. Every location assertion built on it passes somewhere nobody chose. Name a coordinate, or omit the field and let the browser default.',
    });
  }
  if (env.geolocation && env.geolocation.accuracyMetres === 0) {
    found.push({
      field: 'geolocation.accuracyMetres',
      why: 'an accuracy of 0 metres is a perfect fix no device has ever produced. Omit it and the browser supplies its own.',
    });
  }
  if (env.permissions !== undefined && env.permissions.length === 0) {
    found.push({
      field: 'permissions',
      why: 'an empty grant list has exactly the effect of omitting the field, so it cannot be a decision — it is a writer with nowhere to put "I do not know". Omit it, or name the permissions.',
    });
  }
  if (env.deviceScaleFactor !== undefined && env.deviceScaleFactor <= 0) {
    found.push({
      field: 'deviceScaleFactor',
      why: 'a scale factor of 0 or less is not a screen. Omit it and the device keeps its own.',
    });
  }

  return found;
}

/**
 * Which fields of this block THIS ENGINE will accept and not act on.
 *
 * The fields are real, the request is coherent, and on firefox and webkit
 * several of them are a no-op — so the test runs, nothing is gated, and the
 * assertion that nothing blocked it passes. That is the "a pass that means we
 * did not check" defect, and the only defence is saying so before the run.
 *
 * Returned, never thrown and never silently dropped: a spec that grants camera
 * on webkit is not wrong, it is a spec whose camera grant must be reported as
 * unobserved beside its result.
 */
export function environmentUnsupportedOn(
  engine: BrowserEngine,
  env: BrowserEnvironment,
): Array<{ field: string; why: string }> {
  if (engine === 'chromium') return [];
  const found: Array<{ field: string; why: string }> = [];

  if (env.permissions !== undefined && env.permissions.length > 0) {
    found.push({
      field: 'permissions',
      why: `grantPermissions is Chromium-backed; on ${engine} most names are accepted and have no effect, so a "no prompt blocked us" assertion would pass without the permission ever being granted`,
    });
  }
  if (env.camera !== undefined || env.microphone !== undefined) {
    found.push({
      field: env.camera !== undefined ? 'camera' : 'microphone',
      why: `the fake-device flags are Chromium launch arguments; on ${engine} no synthetic stream is produced, so a capture test asserts against nothing`,
    });
  }
  if (env.network !== undefined && !UNTHROTTLED_PROFILES.includes(env.network)) {
    found.push({
      field: 'network',
      why: `bandwidth and latency emulation goes through CDP, which ${engine} does not speak — the run proceeds unthrottled`,
    });
  }
  if (env.clipboard === true) {
    found.push({
      field: 'clipboard',
      why: `clipboard-read and clipboard-write are Chromium permission names; on ${engine} a copy-button assertion reads whatever the OS clipboard already held`,
    });
  }

  return found;
}

// ─── Enumerating a matrix, deterministically ─────────────────────────────────

/**
 * The axes a test declares, as lists.
 *
 * Every axis is OPTIONAL and an omitted axis contributes exactly one unvaried
 * value, which is what makes a declaration of `{ devices: [...] }` mean "these
 * devices, everything else the browser's own" instead of a cross product with
 * three fabricated defaults in it.
 */
export interface MatrixAxes {
  readonly engines?: readonly BrowserEngine[];
  readonly channels?: readonly BrowserChannel[];
  readonly versions?: readonly BrowserVersionPin[];
  readonly devices?: readonly MatrixDevice[];
  readonly colourSchemes?: readonly ColourScheme[];
  readonly reducedMotion?: readonly ReducedMotionPreference[];
  readonly forcedColors?: readonly ForcedColorsMode[];
  readonly locales?: readonly string[];
  readonly timezones?: readonly string[];
}

/**
 * A cap that BIT, in the shape `dimensionCapBiteSchema` already validates.
 *
 * `atLeastMore` is nullable and NOT `.default(0)` for the reason that schema
 * records: zero is the claim that nothing was hidden, which is the opposite of
 * what a bitten cap means. Here it is always known — the full product is
 * computed before the take — so it is always a number, and the field stays
 * nullable because the shape is shared with producers that genuinely cannot say.
 */
export interface MatrixCapBite {
  readonly cap: string;
  readonly limit: number;
  readonly taken: number;
  readonly atLeastMore: number | null;
  readonly detail: string;
}

export interface MatrixEnumeration {
  readonly cells: readonly MatrixCell[];
  /** Non-null exactly when the cap bit. A cap that did not bite says nothing. */
  readonly capBite: MatrixCapBite | null;
  /** The full product size, so a reader can see what the take was out of. */
  readonly declared: number;
}

/** FNV-1a, 32-bit — the seed mixer, so the take depends on the seed STRING. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * mulberry32 — the same ten lines as ./synthetic.ts and
 * packages/runner/src/determinism.ts.
 *
 * Duplicated for the reason ./synthetic.ts states and this file inherits: it is
 * not exported there, `runner` depends on `shared` so importing the other way is
 * a cycle, and ten lines of fixed-output arithmetic is the cheapest thing in
 * this repo to copy. It means a value generated there and a matrix take chosen
 * here are reproducible by the same mechanism.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Expand the axes into cells, cap the count, and SAY SO when the cap bit.
 *
 * ── DETERMINISM, AND WHAT THE SEED IS AND IS NOT FOR ────────────────────────
 *
 * The seed is required and never ambient: no `Math.random`, no `Date.now`. But
 * it decides ONLY WHICH CELLS ARE LOST, never the order of the ones kept. When
 * the product fits under the limit the output is the declared cross product in
 * declared order and the seed plays no part at all — so changing a run seed
 * cannot reshuffle a suite that was never capped, which would make every
 * historical cell key stop matching for no reason.
 *
 * When it does bite, a seeded shuffle picks the subset and the survivors are
 * returned IN DECLARED ORDER. Same seed, same axes, byte-identical output.
 *
 * ── THE CAP IS REPORTED AS A COUNT AND A REASON ─────────────────────────────
 *
 * A budget that silently truncated a 2,400-cell matrix to 50 produces a
 * percentage over 50 cells that reads as a percentage over the matrix. So
 * `capBite` is non-null exactly when the limit bit, carries what was taken and
 * how many more existed, and `declared` carries the full product either way.
 */
export function enumerateMatrix(
  axes: MatrixAxes,
  options: { readonly seed: string; readonly maxCells: number },
): MatrixEnumeration {
  const { seed, maxCells } = options;

  /*
   * `[undefined]` for an omitted axis is what makes an unvaried axis contribute
   * one value and stay ABSENT from the resulting cell, rather than contributing
   * a default somebody would later read as a choice.
   */
  const engines: ReadonlyArray<BrowserEngine | undefined> =
    axes.engines && axes.engines.length > 0 ? axes.engines : [undefined];
  const channels: ReadonlyArray<BrowserChannel | undefined> =
    axes.channels && axes.channels.length > 0 ? axes.channels : [undefined];
  const versions: ReadonlyArray<BrowserVersionPin | undefined> =
    axes.versions && axes.versions.length > 0 ? axes.versions : [undefined];
  const devices: ReadonlyArray<MatrixDevice | undefined> =
    axes.devices && axes.devices.length > 0 ? axes.devices : [undefined];
  const schemes: ReadonlyArray<ColourScheme | undefined> =
    axes.colourSchemes && axes.colourSchemes.length > 0 ? axes.colourSchemes : [undefined];
  const motions: ReadonlyArray<ReducedMotionPreference | undefined> =
    axes.reducedMotion && axes.reducedMotion.length > 0 ? axes.reducedMotion : [undefined];
  const forced: ReadonlyArray<ForcedColorsMode | undefined> =
    axes.forcedColors && axes.forcedColors.length > 0 ? axes.forcedColors : [undefined];
  const locales: ReadonlyArray<string | undefined> =
    axes.locales && axes.locales.length > 0 ? axes.locales : [undefined];
  const zones: ReadonlyArray<string | undefined> =
    axes.timezones && axes.timezones.length > 0 ? axes.timezones : [undefined];

  /*
   * ── THE PRODUCT IS COUNTED, NEVER BUILT ─────────────────────────────────────
   *
   * This function used to materialise EVERY cell of the declared product in nine
   * nested loops and only then ask which `maxCells` of them to keep. The widest
   * declaration `matrixAxesSchema` ACCEPTS — 3 engines x 9 channels x 8 versions
   * x 24 devices x 3 colour schemes x 2 motions x 2 forced-colours x 20 locales
   * x 20 zones — is 24,883,200 cells, and keeping twelve of them cost about
   * 3.7 GB and six seconds. The process does not throw on that: it aborts with
   * "JavaScript heap out of memory", which is not catchable, so a worker sized
   * for a few jobs at once dies with every OTHER organisation's job still on it.
   * Reproduced at a 1 GB heap with a 14.9 million cell product. The plugins
   * wired to this in the round before this one made it reachable from a spec a
   * customer can POST, and nothing at the door bounds the product.
   *
   * A cell is a position in a mixed-radix number — the last axis the least
   * significant digit, because the loops this replaces ran timezone innermost —
   * so `cellAt(i)` decodes the i-th cell of that order without the other
   * ones existing. The take below is then over INDICES, which is what it always
   * was; only the cells it never kept stop being built.
   *
   * BYTE-IDENTICAL, which is the constraint that decides how this is written.
   * Which cells a bitten cap loses is the SEED's business and a stored plan is
   * compared run over run, so the shuffle below is the same arithmetic over the
   * same indices, the keys of a cell are inserted in the same order, and a
   * differential test in browser-matrix.test.ts holds this to the old
   * implementation across axes, seeds and caps rather than to a spelling.
   */
  const axisLists: ReadonlyArray<ReadonlyArray<unknown>> = [
    engines,
    channels,
    versions,
    devices,
    schemes,
    motions,
    forced,
    locales,
    zones,
  ];
  const declared = axisLists.reduce((product, list) => product * list.length, 1);

  const cellAt = (index: number): MatrixCell => {
    // Decode the digits last-axis-first, so axis 8 (timezone) varies fastest.
    const digit: number[] = new Array<number>(axisLists.length);
    let rest = index;
    for (let axis = axisLists.length - 1; axis >= 0; axis -= 1) {
      const radix = axisLists[axis]!.length;
      digit[axis] = rest % radix;
      rest = Math.floor(rest / radix);
    }
    const engine = engines[digit[0]!];
    const channel = channels[digit[1]!];
    const version = versions[digit[2]!];
    const device = devices[digit[3]!];
    const colourScheme = schemes[digit[4]!];
    const reducedMotion = motions[digit[5]!];
    const forcedColors = forced[digit[6]!];
    const locale = locales[digit[7]!];
    const timezone = zones[digit[8]!];
    return {
      ...(engine !== undefined ? { engine } : {}),
      ...(channel !== undefined ? { channel } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(device !== undefined ? { device } : {}),
      ...(colourScheme !== undefined ? { colourScheme } : {}),
      ...(reducedMotion !== undefined ? { reducedMotion } : {}),
      ...(forcedColors !== undefined ? { forcedColors } : {}),
      ...(locale !== undefined ? { locale } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
    };
  };

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
  if (declared <= maxCells) {
    // Under the cap, so building every cell IS building what was asked for.
    return { cells: Array.from({ length: declared }, (_, i) => cellAt(i)), declared, capBite: null };
  }

  // Fisher-Yates over INDICES, seeded, then sort the survivors back into
  // declared order. Shuffling the cells themselves and slicing would also be
  // deterministic and would return them in shuffled order, which is the one
  // property we do not want: the subset is the seed's business, the order is not.
  const rng = mulberry32(fnv1a32(seed));
  // A typed array: four bytes a position and off the V8 heap, where the cells
  // this replaces were a hundred-odd bytes each and on it.
  const indices = new Uint32Array(declared);
  for (let i = 0; i < declared; i += 1) indices[i] = i;
  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = indices[i]!;
    const b = indices[j]!;
    indices[i] = b;
    indices[j] = a;
  }
  const kept = Array.from(indices.subarray(0, maxCells)).sort((x, y) => x - y);

  return {
    cells: kept.map((i) => cellAt(i)),
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
