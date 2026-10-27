/**
 * Localisation depth — the detectors that make a LOCALIZATION finding possible.
 *
 * ── THE DEFECT THIS FILE EXISTS TO CLOSE ────────────────────────────────────
 *
 * `plugins/matrix.ts`'s `localizationPlugin` RE-RUNS THE SAME SPEC UNDER
 * ANOTHER LOCALE and that is all it does. Playwright reports one project per
 * locale, the harness parses them, and a de-DE run that renders
 * `checkout.button.pay` in place of a button label, clips every heading, keeps
 * the whole page left-to-right under `ar`, and prints `1,234.56` to a reader who
 * writes `1.234,56` comes back GREEN — because nothing in the product ever
 * looked at the rendering. `FindingKind` has a `LOCALIZATION` member and NOTHING
 * IN THE REPOSITORY EVER EMITS ONE. A dead Finding kind, and six whole defect
 * classes that score zero.
 *
 * ── THE DISTINCTION THAT IS THE WHOLE POINT ─────────────────────────────────
 *
 * "WE FOUND NOTHING" AND "WE LOOKED AT NOTHING" MUST BE DIFFERENT ANSWERS.
 *
 * A locale with no translation data behind it renders byte-for-byte like the
 * source language. Every detector in this file then finds zero problems, and
 * every one of those zeros is honest about the comparison and a LIE about the
 * application: the run proved that a catalogue is missing, not that the
 * localisation is correct. So no detector here may return an empty finding list
 * on its own. Each one returns a {@link L10nDetectorOutcome} that is MEASURED
 * with a count of what it examined, or UNMEASURED with one of
 * {@link L10N_UNMEASURED_REASONS} — and the absence of a `deep` block is itself
 * UNMEASURED (`NOT_ENABLED`), never a clean bill of health. That is the single
 * rule this module is built around and it is the reason the outcome ledger is
 * as large as the detectors.
 *
 * ── FOUR MORE RULES, EACH PAID FOR BY A DEFECT ──────────────────────────────
 *
 * NO BROWSER IN HERE. Every function below is pure and takes an INJECTED
 * {@link L10nRendering} — a narrow snapshot of text, computed style and box
 * metrics that an adapter in the plugin collects. There is no playwright `Page`
 * import, no `fetch` and no `node:` builtin, so the whole detector set is
 * testable in milliseconds. No AMBIENT clock either: the one `new Date(...)` in
 * the file is a fixed 1987 constant handed to `Intl` so a locale's date pattern
 * can be read, and it is named at {@link intlLocaleFormats} rather than left for
 * a reader to find and doubt. 629 lines of crawler.ts went almost untested for
 * exactly the want of that split.
 *
 * ABSENT EVIDENCE IS NEVER A ZERO. A snapshot with no box metrics cannot decide
 * truncation, so the truncation detector reports UNMEASURED rather than "no
 * clipping". A node whose `transform` will not parse is COUNTED as inconclusive
 * rather than read as unmirrored. A cap that bit is reported as a count and a
 * reason.
 *
 * PSEUDO-LOCALIZATION IS THE CHEAPEST VALUE IN THE PRODUCT AND IT NEEDS NO
 * TRANSLATOR. {@link pseudoLocalize} expands every string by the standard ~40%,
 * accents it and brackets it, and the bracket is load-bearing: a rendering that
 * shows `⟦` and not `⟧` is a clipped string, decided with NO GEOMETRY AT ALL.
 * The same pass finds hard-coded strings for free — under pseudo-localization a
 * string that is not accented never went through the translation layer.
 *
 * NO HAND-WRITTEN LOCALE TABLES. This file holds no list of right-to-left
 * languages and no list of family-name-first locales. A locale's expected
 * direction arrives as data, because the surface inventory already records it
 * (`DimensionDetail` with `dimension: 'LOCALE'` carries `rtl: boolean`), and
 * name order arrives as a declared expectation. A plausible table typed in here
 * reads as measurement and is a second opinion about a fact that already has an
 * owner — which is how two halves of one vocabulary come to disagree.
 *
 * Read packages/runner/src/a11y-deep.ts first: this is its sibling, built to the
 * same split (pure analysis, injected snapshot, an outcome per check) and the
 * same refusal to report a check it did not run as a check that passed.
 */

import { z } from 'zod';
import type { Finding } from '@qaai/shared';

// ─── Codes ───────────────────────────────────────────────────────────────────

/**
 * Prefix on every code this module emits.
 *
 * A namespace so a mute rule, a gate or a dashboard filter can separate these
 * from whatever else files a `LOCALIZATION` finding later, exactly as
 * `DEEP_A11Y_CODE_PREFIX` separates this product's behavioural checks from axe's
 * own rule ids.
 */
export const L10N_CODE_PREFIX = 'l10n.';

export function isL10nFinding(finding: Finding): boolean {
  return finding.code.startsWith(L10N_CODE_PREFIX);
}

/**
 * A detector that could not look. Evidence that we did not measure, NEVER that
 * the page is clean.
 *
 * Exported so a gate and a reporter test membership of one predicate rather than
 * each re-deriving it from a code string — the thing that decides whether a
 * percentage may count this route at all.
 */
export function isUnmeasuredL10nFinding(finding: Finding): boolean {
  return finding.code.startsWith(`${L10N_CODE_PREFIX}unmeasured`);
}

// ─── The detectors, and the honesty ledger ───────────────────────────────────

/**
 * The six defect classes. Each one is a question about the rendering that the
 * re-run-under-another-locale plugin could not ask.
 */
export const L10N_DETECTORS = [
  /** A raw key or an unrendered template token reaching the screen. */
  'missingKey',
  /** Expand every string and see what breaks. Needs no translator. */
  'pseudoLocalization',
  /** Text clipped, ellipsised unexpectedly, or overflowing its container. */
  'truncation',
  /** Direction applied, layout mirrored, icons mirrored only where they should be. */
  'rtlMirroring',
  /** Dates, numbers, currency and name order per locale, not per developer. */
  'formatCorrectness',
  /** Text that does not change between two locales when its neighbours do. */
  'hardCodedStrings',
] as const;
export type L10nDetector = (typeof L10N_DETECTORS)[number];

/**
 * The compile-time half of the parity guard: a `Record` keyed on the union
 * cannot be written without naming every member. The run-time half — comparing
 * the zod schema's `.options` back against this list — is in l10n-deep.test.ts,
 * because zod's options exist only at run time. Both halves, for every closed
 * union in this file: eight `GateRule` kinds shipped unsaveable for two slices
 * because only one of the two existed.
 */
const L10N_DETECTOR_PRESENT: Record<L10nDetector, true> = {
  missingKey: true,
  pseudoLocalization: true,
  truncation: true,
  rtlMirroring: true,
  formatCorrectness: true,
  hardCodedStrings: true,
};

/** Derived, never hand-listed. */
export const L10N_DETECTOR_LIST = Object.keys(
  L10N_DETECTOR_PRESENT,
) as ReadonlyArray<L10nDetector>;

export const L10N_DETECTOR_LABELS: Record<L10nDetector, string> = {
  missingKey: 'Missing keys and unrendered tokens',
  pseudoLocalization: 'Pseudo-localization',
  truncation: 'Truncation and overlap',
  rtlMirroring: 'Right-to-left mirroring',
  formatCorrectness: 'Date, number, currency and name formatting',
  hardCodedStrings: 'Hard-coded strings',
};

/**
 * WHY a detector did not measure.
 *
 * Every member names a fact about the INPUT and not about the application, which
 * is what makes the list safe to put in a denominator rule: none of these is
 * evidence in either direction, so a route carrying one must leave the
 * numerator AND the denominator for that detector rather than scoring zero
 * defects.
 *
 * `NO_TRANSLATION_DATA` is the sharpest of them and the reason this vocabulary
 * exists at all: it is the state a localisation suite is in before anybody has
 * translated anything, it makes every other detector return zero, and reporting
 * it as "no localisation defects" is the lie this product cannot afford.
 */
export const L10N_UNMEASURED_REASONS = [
  /** The detector was not switched on. Not evidence about the page. */
  'NOT_ENABLED',
  /** The locale rendered identically to the source, so nothing was translated. */
  'NO_TRANSLATION_DATA',
  /** Only one rendering was supplied, and this detector compares two. */
  'NO_BASE_RENDERING',
  /** No pseudo-localized rendering was supplied. */
  'NO_PSEUDO_RENDERING',
  /** No node carried box metrics, so clipping cannot be decided. */
  'NO_GEOMETRY',
  /** Nobody said which direction this locale expects. */
  'NO_DIRECTION_DECLARED',
  /** ICU has no data for this locale, so there is no expected format to compare to. */
  'LOCALE_NOT_SUPPORTED_BY_ICU',
  /** The snapshot held no text-bearing nodes at all. */
  'NO_NODES',
  /** The detector threw. Counted and reported, never suppressed. */
  'DETECTOR_FAILED',
] as const;
export type L10nUnmeasuredReason = (typeof L10N_UNMEASURED_REASONS)[number];

const L10N_UNMEASURED_PRESENT: Record<L10nUnmeasuredReason, true> = {
  NOT_ENABLED: true,
  NO_TRANSLATION_DATA: true,
  NO_BASE_RENDERING: true,
  NO_PSEUDO_RENDERING: true,
  NO_GEOMETRY: true,
  NO_DIRECTION_DECLARED: true,
  LOCALE_NOT_SUPPORTED_BY_ICU: true,
  NO_NODES: true,
  DETECTOR_FAILED: true,
} as const;

export const L10N_UNMEASURED_REASON_LIST = Object.keys(
  L10N_UNMEASURED_PRESENT,
) as ReadonlyArray<L10nUnmeasuredReason>;

export const L10N_UNMEASURED_REASON_LABELS: Record<L10nUnmeasuredReason, string> = {
  NOT_ENABLED: 'this detector was not switched on, so nothing was looked at',
  NO_TRANSLATION_DATA:
    'the locale rendered identically to the source language, so there is no translation to inspect — this proves a catalogue is missing, not that the localisation is correct',
  NO_BASE_RENDERING: 'this detector compares two renderings and only one was supplied',
  NO_PSEUDO_RENDERING: 'no pseudo-localized rendering was captured',
  NO_GEOMETRY: 'no node carried box metrics, so clipping and overlap cannot be decided',
  NO_DIRECTION_DECLARED: "nobody declared which direction this locale's script runs in",
  LOCALE_NOT_SUPPORTED_BY_ICU:
    'ICU resolved this tag to a different locale, so there is no expected format to compare against',
  NO_NODES: 'the snapshot held no text-bearing nodes',
  DETECTOR_FAILED: 'the detector itself failed, so its defect class went unexamined',
};

/**
 * Reasons that mean the detector produced NO EVIDENCE, so it must leave both
 * halves of any ratio.
 *
 * Every member of {@link L10N_UNMEASURED_REASONS} is here, and the list exists
 * anyway rather than being written as "all of them": a reason that is genuinely
 * a measurement will be added one day (a detector that examined 40 of 400 nodes
 * and says so is MEASURED with a cap, not unmeasured) and this is the line that
 * has to be edited when it is.
 */
export const NO_EVIDENCE_UNMEASURED_REASONS: readonly L10nUnmeasuredReason[] = [
  'NOT_ENABLED',
  'NO_TRANSLATION_DATA',
  'NO_BASE_RENDERING',
  'NO_PSEUDO_RENDERING',
  'NO_GEOMETRY',
  'NO_DIRECTION_DECLARED',
  'LOCALE_NOT_SUPPORTED_BY_ICU',
  'NO_NODES',
  'DETECTOR_FAILED',
];

/** Direction a locale's script runs in. Declared, never guessed from the tag. */
export const LOCALE_DIRECTIONS = ['LTR', 'RTL'] as const;
export type LocaleDirection = (typeof LOCALE_DIRECTIONS)[number];

const LOCALE_DIRECTION_PRESENT: Record<LocaleDirection, true> = { LTR: true, RTL: true };

export const LOCALE_DIRECTION_LIST = Object.keys(
  LOCALE_DIRECTION_PRESENT,
) as ReadonlyArray<LocaleDirection>;

/**
 * What a node is EXPECTED to do when the layout mirrors.
 *
 * Declared per node and never inferred, because the rule is not derivable from
 * the markup: a back-arrow must mirror, a play button must mirror, and a clock
 * face, a logo, a checkmark and a musical note must NOT — and a detector that
 * guessed would file a finding against every icon on the page in one direction
 * or the other. A node with no expectation is COUNTED as undeclared, which is
 * what makes "we have no mirroring expectations on this page" a reportable fact
 * rather than a silent pass.
 */
export const MIRROR_EXPECTATIONS = ['MUST_MIRROR', 'MUST_NOT_MIRROR'] as const;
export type MirrorExpectation = (typeof MIRROR_EXPECTATIONS)[number];

const MIRROR_EXPECTATION_PRESENT: Record<MirrorExpectation, true> = {
  MUST_MIRROR: true,
  MUST_NOT_MIRROR: true,
};

export const MIRROR_EXPECTATION_LIST = Object.keys(
  MIRROR_EXPECTATION_PRESENT,
) as ReadonlyArray<MirrorExpectation>;

/** Which way round a person's name goes. Declared, for the reason in the header. */
export const NAME_ORDERS = ['GIVEN_FIRST', 'FAMILY_FIRST'] as const;
export type NameOrder = (typeof NAME_ORDERS)[number];

const NAME_ORDER_PRESENT: Record<NameOrder, true> = {
  GIVEN_FIRST: true,
  FAMILY_FIRST: true,
};

export const NAME_ORDER_LIST = Object.keys(NAME_ORDER_PRESENT) as ReadonlyArray<NameOrder>;

// ─── The injected snapshot ───────────────────────────────────────────────────

/**
 * One node's geometry, as an adapter reads it back.
 *
 * `scrollWidth > clientWidth` is the whole of the truncation test and it is the
 * reason this is a separate optional object rather than four optional fields on
 * the node: a snapshot that collected text and style but not metrics must make
 * the truncation detector report UNMEASURED, and `box: null` says that in one
 * place. Four independently-optional numbers would let a half-collected box
 * decide a clipping question with three of its four sides missing.
 */
export interface L10nBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
}

/** A computed `direction`, as CSS spells it. */
export type ComputedDirection = 'ltr' | 'rtl';

/**
 * ONE TEXT-BEARING NODE, as a narrow snapshot.
 *
 * Deliberately not a playwright `ElementHandle` and deliberately not a DOM node:
 * the analysis below is where every judgement call lives, and a detector that
 * could only be exercised with a browser running is a detector that is tested by
 * nothing. The adapter that fills this in is a dozen lines of `page.evaluate`
 * living in the plugin, which is the one place a real `Page` belongs.
 *
 * `ancestors` carries the locators of this node's ancestors, nearest LAST. It is
 * here for the overlap check: two boxes that intersect are a defect only when
 * neither node contains the other, and without the chain every parent would be
 * reported as overlapping its own child. The last entry doubles as the parent
 * key the hard-coded-string detector groups siblings by.
 */
export interface L10nNode {
  /** A stable locator — what lands in `Finding.location`. */
  readonly locator: string;
  /** Ancestor locators, nearest last. Empty for a root. */
  readonly ancestors: readonly string[];
  /** Upper-case tag name, for the containers whose braces are not a defect. */
  readonly tag: string;
  /** The visible text of this node, already trimmed by the adapter. */
  readonly text: string;
  /** Computed `direction`. Null = not collected. */
  readonly direction: ComputedDirection | null;
  /** Computed `text-align`, which resolves `start` to a physical side. */
  readonly textAlign: string | null;
  /** Computed `unicode-bidi` — `isolate` and `plaintext` are what stop a reorder. */
  readonly unicodeBidi: string | null;
  /** Computed `transform`, for the icon-mirroring pair. Null = not collected. */
  readonly transform: string | null;
  /** Computed `text-overflow`. `ellipsis` plus an overflow is a real clip. */
  readonly textOverflow: string | null;
  /** Whether overflow is clipped. Null = not collected. */
  readonly overflowHidden: boolean | null;
  /** Null = no metrics were collected for this node. */
  readonly box: L10nBox | null;
  /** Null = nobody declared whether this node mirrors. Counted, not assumed. */
  readonly mirror: MirrorExpectation | null;
}

/**
 * The whole page under ONE locale.
 *
 * `direction` is what the locale EXPECTS and `documentDirection` is what the page
 * APPLIED, and the gap between those two is the single highest-value right-to-left
 * finding there is: a page serving Arabic strings inside a left-to-right layout
 * is unusable and passes every string-level check ever written. Expected is
 * nullable because it is declared rather than derived — see the header — and a
 * null makes the mirroring detector UNMEASURED instead of letting it compare
 * against a table this file refuses to hold.
 */
export interface L10nRendering {
  /** BCP-47 as the application spells it. */
  readonly locale: string;
  /** What this locale EXPECTS. Null = nobody declared it. */
  readonly direction: LocaleDirection | null;
  /** What the document APPLIED. Null = not collected. */
  readonly documentDirection: ComputedDirection | null;
  /** The `lang` attribute the document carried. Null = not collected. */
  readonly htmlLang: string | null;
  readonly nodes: readonly L10nNode[];
  /** True when this rendering was captured under pseudo-localization. */
  readonly pseudo: boolean;
}

// ─── Pseudo-localization ─────────────────────────────────────────────────────

/**
 * The standard expansion. Forty per cent is not a number this file invented: it
 * is the growth English→German and English→Finnish actually produce on short UI
 * strings, which is why every pseudo-locale implementation uses it.
 */
export const PSEUDO_GROWTH_RATIO = 0.4;

/**
 * The sentinels, and WHY these two codepoints.
 *
 * `⟦` and `⟧` (U+27E6/U+27E7) rather than `[[` and `]]` or `{` and `}`, and the
 * choice is load-bearing twice over. First, a doubled square bracket collides
 * with real UI text — a citation, a log line, a diff — so a clipped-string
 * finding would fire on content nobody localized. Second, a brace collides with
 * the placeholder syntaxes {@link PLACEHOLDER_PATTERNS} looks for, so the
 * missing-key detector and this one would each read the other's marker as its own
 * defect.
 *
 * THE CLOSING ONE IS THE MEASUREMENT. A rendering that shows the opening
 * sentinel and not the closing one is a string being cut off, and that is decided
 * with NO BOX METRICS AT ALL — which is what makes this detector work against a
 * snapshot the truncation detector has to refuse.
 */
export const PSEUDO_START = '⟦';
export const PSEUDO_END = '⟧';

/** The filler appended to reach the growth ratio. One codepoint, visibly not a letter. */
export const PSEUDO_FILLER = '·';

/**
 * ASCII letter → accented letter, one codepoint each.
 *
 * Single codepoints on purpose: a combining-mark form would make
 * `[...text].length` disagree with the grapheme count, and the expansion
 * arithmetic below would then under- or over-pad by the number of marks. Every
 * entry is also visually recognisable as its source letter, which is the
 * property that lets a human read a pseudo-localized screen and still spot a
 * layout break.
 */
const PSEUDO_ACCENTS: Readonly<Record<string, string>> = {
  a: 'á', b: 'ƀ', c: 'ć', d: 'đ', e: 'é', f: 'ƒ', g: 'ģ', h: 'ĥ', i: 'í',
  j: 'ĵ', k: 'ķ', l: 'ĺ', m: 'ɱ', n: 'ñ', o: 'ó', p: 'ƥ', q: 'ɋ', r: 'ŕ',
  s: 'ś', t: 'ţ', u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ҳ', y: 'ý', z: 'ź',
  A: 'Á', B: 'Ɓ', C: 'Ć', D: 'Đ', E: 'É', F: 'Ƒ', G: 'Ģ', H: 'Ĥ', I: 'Í',
  J: 'Ĵ', K: 'Ķ', L: 'Ĺ', M: 'Ṁ', N: 'Ñ', O: 'Ó', P: 'Ƥ', Q: 'Ɋ', R: 'Ŕ',
  S: 'Ś', T: 'Ţ', U: 'Ú', V: 'Ṽ', W: 'Ŵ', X: 'Ҳ', Y: 'Ý', Z: 'Ź',
};

/** Every accented form, for "did this string go through the pipeline at all". */
const PSEUDO_ACCENT_SET = new Set(Object.values(PSEUDO_ACCENTS));

/**
 * Does this text carry the marks of having been pseudo-localized?
 *
 * Asked of the accent set rather than of the sentinels, because the sentinels are
 * what a clip removes and an accent survives anywhere in the string. A text with
 * no letters at all — `"1,234.56"`, `"→"` — can never carry an accent, so it
 * answers `null`: NOT EVIDENCE in either direction, which is the distinction the
 * hard-coded detector would otherwise get wrong on every number on the page.
 */
export function carriesPseudoAccents(text: string): boolean | null {
  let sawLetter = false;
  for (const char of text) {
    if (PSEUDO_ACCENT_SET.has(char)) return true;
    if (PSEUDO_ACCENTS[char] !== undefined) sawLetter = true;
  }
  return sawLetter ? false : null;
}

/**
 * The placeholder syntaxes a message catalogue actually uses.
 *
 * Six families because this product does not know which i18n library a customer
 * runs, and a token the expansion MANGLES is worse than one it leaves alone: an
 * accented `{{nàɱé}}` no longer matches the interpolation the application
 * performs, so the string renders with the braces visible and the pseudo run
 * reports a missing-key defect in a page that has none. So every pattern here is
 * preserved verbatim by {@link pseudoLocalize}, and a token that reaches the
 * screen UNINTERPOLATED is a real finding reported by the missing-key detector.
 *
 * Ordered longest-form-first: `{{name}}` must match before `{name}` can, or the
 * inner braces are taken as an ICU placeholder and the outer pair is left behind.
 *
 * THE ICU CLASS IS `[^{}\s:"']` AND NOT `[A-Za-z0-9_.]`, which is load-bearing
 * in both directions. It has to admit an ACCENTED name, because a token the
 * pseudo-localization pass damaged (`{náɱé}`) is precisely what
 * `l10n.pseudo.placeholder-mangled` exists to report — with the narrow class that
 * detector could never fire and would be dead code. And it has to exclude
 * quotes, colons and whitespace, because `{"key":"value"}` rendered by a JSON
 * viewer is CONTENT: admitting it would file an unrendered-token finding on every
 * minified object on the page.
 */
export const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\{\{[^{}]{1,80}\}\}/g,
  /\$\{[^{}]{1,80}\}/g,
  /%\([A-Za-z_][A-Za-z0-9_]{0,60}\)[sdfi]/g,
  /%\d{1,2}\$[sdfi]/g,
  /\{[^{}\s:"']{1,60}\}/g,
  /%[sdfi]/g,
];

/** Every placeholder in this text, in the order they appear, never overlapping. */
export function placeholdersIn(text: string): Array<{ token: string; index: number }> {
  const found: Array<{ token: string; index: number }> = [];
  const taken: Array<[number, number]> = [];
  for (const pattern of PLACEHOLDER_PATTERNS) {
    // A fresh RegExp per call: `lastIndex` on a module-level /g literal is
    // mutable state shared between every caller, and two detectors scanning the
    // same text would then each start where the other stopped.
    const scanner = new RegExp(pattern.source, 'g');
    let match = scanner.exec(text);
    while (match !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const overlaps = taken.some(([a, b]) => start < b && end > a);
      if (!overlaps) {
        taken.push([start, end]);
        found.push({ token: match[0], index: start });
      }
      match = scanner.exec(text);
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

export interface PseudoOptions {
  /** Share of extra length to add. {@link PSEUDO_GROWTH_RATIO} by default. */
  readonly growth?: number;
  /** Wrap in the sentinels, which is what makes a clip visible. Default true. */
  readonly bracket?: boolean;
}

/**
 * Expand, accent and bracket one string — deterministically, with no RNG.
 *
 * ── WHAT IS AND IS NOT TRANSFORMED ──────────────────────────────────────────
 *
 * Letters are accented. Placeholders are copied through BYTE FOR BYTE, for the
 * reason {@link PLACEHOLDER_PATTERNS} records. Digits, punctuation and
 * whitespace are left alone — accenting a digit would break the format detector
 * running over the same page, and this file must not generate the defect it
 * reports.
 *
 * ── THE PADDING IS APPENDED, NOT INTERLEAVED ────────────────────────────────
 *
 * Inside the closing sentinel and after the last literal character, so that a
 * container which clips loses the filler and the sentinel FIRST — which is
 * exactly the signal the clip detector reads. Interleaving the filler between
 * words would grow the string identically and make a clipped tail
 * indistinguishable from a short translation.
 *
 * The length is `ceil(letters * growth)` and NOT `ceil(total * growth)`: a string
 * that is mostly a placeholder (`"{count} items"`) does not grow when translated
 * in proportion to the placeholder, and padding on the token's length would
 * inflate a nine-character label to twenty and report a truncation defect the
 * application does not have.
 *
 * NO `Math.random`, NO `Date.now`. Same input, same output, for ever — which is
 * what lets a baseline captured under pseudo-localization be compared at all.
 */
export function pseudoLocalize(text: string, options: PseudoOptions = {}): string {
  const growth = options.growth ?? PSEUDO_GROWTH_RATIO;
  const bracket = options.bracket ?? true;
  if (text.length === 0) return text;

  const placeholders = placeholdersIn(text);
  let out = '';
  let letters = 0;
  let cursor = 0;

  for (const { token, index } of placeholders) {
    for (const char of text.slice(cursor, index)) {
      const accented = PSEUDO_ACCENTS[char];
      if (accented !== undefined) letters += 1;
      out += accented ?? char;
    }
    out += token;
    cursor = index + token.length;
  }
  for (const char of text.slice(cursor)) {
    const accented = PSEUDO_ACCENTS[char];
    if (accented !== undefined) letters += 1;
    out += accented ?? char;
  }

  const padding = Math.ceil(letters * Math.max(0, growth));
  const padded = out + PSEUDO_FILLER.repeat(padding);
  return bracket ? `${PSEUDO_START}${padded}${PSEUDO_END}` : padded;
}

// ─── Message keys leaking into the UI ────────────────────────────────────────

/**
 * Extensions and suffixes a dotted string is a FILE or a HOST rather than a key.
 *
 * Every entry here is a false positive this detector produced on real UI text.
 * `logo.svg` in an alt attribute, `example.com` in a footer, `v2.11.4` in a
 * status line, `README.md` in a docs link: all of them are dotted,
 * whitespace-free and lower-case, which is every structural property a message
 * key has. A heuristic with no exclusion list files one finding per asset
 * reference on the page, and a detector whose findings are mostly wrong is a
 * detector somebody mutes — taking the real ones with it.
 */
const NON_KEY_LAST_SEGMENTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp',
  'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'json', 'xml', 'yaml', 'yml',
  'html', 'htm', 'md', 'txt', 'csv', 'pdf', 'zip', 'gz', 'woff', 'woff2',
  'com', 'net', 'org', 'io', 'dev', 'app', 'co', 'uk', 'de', 'fr', 'jp',
  'gov', 'edu', 'info', 'biz', 'me', 'ai', 'cloud', 'localhost',
]);

/**
 * The shortest segment a key may have.
 *
 * Two, and what it actually catches is a chain of SINGLE-character segments:
 * `U.S`, `i.e`, `a.b`. The trailing-dot forms — `e.g.`, `U.S.A.` — are already
 * refused by the anchored pattern at the end of {@link looksLikeMessageKey},
 * which requires at least one character after the final dot; a mutation test
 * showed this constant doing none of that work and the comment claiming all of
 * it, so the claim is now the narrower true one and there are cases below for it.
 */
const MIN_KEY_SEGMENT = 2;

export interface MessageKeyVerdict {
  /** The text, confirmed to have a key's shape. */
  readonly key: string;
  /** Which structural property identified it, for the finding's evidence. */
  readonly why: string;
}

/**
 * Does this whole text look like a message key that escaped translation?
 *
 * ── WHY `null` RATHER THAN A CONFIDENCE NUMBER ──────────────────────────────
 *
 * Because a number invites a threshold, and a threshold here would be a figure
 * this file made up about a customer's naming convention. The structural test is
 * all-or-nothing — two or more dot-separated segments, every segment at least two
 * characters, no whitespace, not a file, not a host, not a version — and the
 * CALLER raises the severity when it can confirm the string against a real
 * catalogue. Heuristic and confirmed are two different findings, not two points
 * on one scale.
 */
export function looksLikeMessageKey(text: string): MessageKeyVerdict | null {
  const value = text.trim();
  if (value.length === 0 || value.length > 120) return null;
  if (/[\s@:/\\()[\]{}<>"'`,;!?]/.test(value)) return null;
  if (!value.includes('.')) return null;

  const segments = value.split('.');
  if (segments.length < 2) return null;
  if (segments.some((segment) => segment.length < MIN_KEY_SEGMENT)) return null;
  // A version, a decimal, an ordered list marker: numerals all the way down.
  if (segments.every((segment) => /^\d+$/.test(segment))) return null;
  if (!/[A-Za-z]/.test(value)) return null;
  // A leading numeral is a version (`2.11.4b`), never an identifier.
  if (/^\d/.test(value)) return null;
  const last = segments[segments.length - 1];
  if (last !== undefined && NON_KEY_LAST_SEGMENTS.has(last.toLowerCase())) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/.test(value)) return null;

  return {
    key: value,
    why: `${segments.length} dot-separated identifier segments, no whitespace, and not a filename, host or version`,
  };
}

/**
 * Containers whose braces and dotted strings are CONTENT, not defects.
 *
 * A JSON viewer, a code sample, a keyboard hint and a textarea holding a template
 * all legitimately render `{{name}}` and `config.db.host`, and a detector that
 * reported them would be wrong on every developer-facing page this product is
 * most likely to be pointed at first.
 */
const LITERAL_TEXT_TAGS = new Set(['CODE', 'PRE', 'SAMP', 'KBD', 'TEXTAREA', 'SCRIPT', 'STYLE']);

function inLiteralContainer(node: L10nNode): boolean {
  return LITERAL_TEXT_TAGS.has(node.tag.toUpperCase());
}

// ─── Finding construction ────────────────────────────────────────────────────

/*
 * Findings are persisted with `message` truncated at 2000 characters and
 * `location` at 1000 (apps/worker/src/processors/run.ts). Cut them HERE so the
 * text ends in an ellipsis rather than mid-word, which is the same arrangement
 * and the same two numbers as a11y-deep.ts.
 */
const MESSAGE_LIMIT = 1800;
const LOCATION_LIMIT = 900;

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

interface L10nFindingInput {
  readonly code: string;
  readonly severity: Finding['severity'];
  readonly location: string;
  /** What is wrong, naming the node and quoting the evidence. */
  readonly problem: string;
  /** What to do about it. */
  readonly remedy: string;
}

/**
 * `helpUrl` is `null` on every finding this module emits, and that is a decision
 * rather than an omission. There is no canonical public document for "your
 * de-DE build clipped this heading" the way there is a WCAG understanding page
 * for a focus-order failure, and a link to a vendor's blog post would be this
 * product asserting an authority it does not have. The remedy sentence carries
 * the actionable half instead.
 */
function toFinding(input: L10nFindingInput, mask: (value: string) => string): Finding {
  return {
    kind: 'LOCALIZATION',
    severity: input.severity,
    code: input.code,
    message: truncate(mask(`${input.problem} ${input.remedy}`), MESSAGE_LIMIT),
    location: truncate(mask(input.location), LOCATION_LIMIT),
    helpUrl: null,
  };
}

/**
 * Text quoted into a finding, bounded and with its newlines escaped.
 *
 * A raw newline from page content inside a message is a forged log line, which is
 * the reason `variantKeyOf` in packages/shared/src/measurement-rows.ts assembles
 * its refusals through `JSON.stringify`. Crawled page text is DATA.
 */
function quote(text: string, limit = 120): string {
  const flattened = text.replace(/\s+/g, ' ').trim();
  const cut = flattened.length <= limit ? flattened : `${flattened.slice(0, limit - 1)}…`;
  return JSON.stringify(cut);
}

// ─── Configuration: every detector switched on BY NAME ───────────────────────

/** `true` / `false` shorthand for the object form, as a11y-deep.ts does it. */
function toggled<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (value === true ? {} : value === false ? { enabled: false } : value),
    schema,
  );
}

const missingKeySchema = z.object({
  enabled: z.boolean().default(true),
  /** Report a key-SHAPED string with no catalogue to confirm it against. */
  heuristicKeys: z.boolean().default(true),
});

const pseudoLocalizationSchema = z.object({
  enabled: z.boolean().default(true),
  growth: z.number().min(0).max(3).default(PSEUDO_GROWTH_RATIO),
});

const truncationSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Pixels of overflow tolerated before a clip is reported.
   *
   * One, not zero. Sub-pixel layout rounding makes `scrollWidth` exceed
   * `clientWidth` by a fraction on text that is not clipped at all, and a
   * zero-tolerance check files a finding on roughly every line of text on a
   * page — which is how a detector gets switched off in its first week.
   */
  tolerancePx: z.number().min(0).max(64).default(1),
  /** Minimum intersection area before two boxes count as overlapping. */
  minOverlapPx2: z.number().min(0).max(100_000).default(16),
  overlap: z.boolean().default(true),
});

const rtlMirroringSchema = z.object({
  enabled: z.boolean().default(true),
  /** Compare computed `text-align` across two renderings to find physical sides. */
  physicalAlignment: z.boolean().default(true),
  icons: z.boolean().default(true),
  bidi: z.boolean().default(true),
});

const formatCorrectnessSchema = z.object({
  enabled: z.boolean().default(true),
  numbers: z.boolean().default(true),
  dates: z.boolean().default(true),
  currency: z.boolean().default(true),
  names: z.boolean().default(true),
});

const hardCodedStringsSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Shortest unchanged text worth reporting.
   *
   * Three, because a one- or two-character label (`OK`, `×`, `No`) is as likely
   * to be a brand mark or an icon glyph as an untranslated string, and this
   * detector has no way to tell. Reported as a set-aside count rather than
   * silently dropped.
   */
  minLength: z.number().int().min(1).max(200).default(3),
});

export const l10nDeepConfigSchema = z.object({
  missingKey: toggled(missingKeySchema).optional(),
  pseudoLocalization: toggled(pseudoLocalizationSchema).optional(),
  truncation: toggled(truncationSchema).optional(),
  rtlMirroring: toggled(rtlMirroringSchema).optional(),
  formatCorrectness: toggled(formatCorrectnessSchema).optional(),
  hardCodedStrings: toggled(hardCodedStringsSchema).optional(),
  /**
   * How many nodes one detector may examine.
   *
   * A CAP, and it is DISCLOSED when it bites: a detector that silently examined
   * 200 of 4,000 nodes and reported two findings has produced a percentage over a
   * sample that reads as a percentage over the page.
   */
  maxNodes: z.number().int().min(1).max(20_000).default(2_000),
  /** How many findings one detector may emit, for the same reason. */
  maxFindingsPerDetector: z.number().int().min(1).max(1_000).default(50),
});

export type ResolvedL10nConfig = z.output<typeof l10nDeepConfigSchema> & {
  /** Non-null when the `deep` block could not be read. Reported, never obeyed. */
  configError: string | null;
};

function allOff(): ResolvedL10nConfig {
  return {
    maxNodes: l10nDeepConfigSchema.shape.maxNodes.parse(undefined),
    maxFindingsPerDetector: l10nDeepConfigSchema.shape.maxFindingsPerDetector.parse(undefined),
    configError: null,
  };
}

/**
 * Read the `deep` block off a LOCALIZATION spec.
 *
 * ── A SPEC WITH NO `deep` BLOCK IS UNMEASURED, NOT CLEAN ────────────────────
 *
 * It returns a config with every detector absent, and {@link runL10nDetectors}
 * turns that into six UNMEASURED outcomes with `NOT_ENABLED`. It does NOT return
 * null-meaning-skip and it does not return an empty finding list, because the
 * caller downstream has no way to tell an empty list from a page that was
 * examined and found good — which is the one distinction this module exists to
 * preserve. A localisation suite that reports every route as having no
 * localisation defects, because nobody switched a detector on, is the exact lie
 * this round was convened to remove.
 *
 * A BLOCK THAT WILL NOT PARSE IS REPORTED, NOT OBEYED. `configError` travels in
 * the resolved config and becomes an `l10n.unmeasured.config` finding, the same
 * arrangement as `parseDeepA11yConfig`.
 */
export function parseL10nDeepConfig(rawSpec: unknown): ResolvedL10nConfig {
  const block =
    rawSpec !== null && typeof rawSpec === 'object' && 'deep' in rawSpec
      ? (rawSpec as { deep?: unknown }).deep
      : undefined;
  if (block === undefined || block === null) return allOff();

  const parsed = l10nDeepConfigSchema.safeParse(block);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ...allOff(), configError: `the deep block could not be read — ${issues}` };
  }
  return { ...parsed.data, configError: null };
}

/** Which detectors this config switched on. Order follows {@link L10N_DETECTORS}. */
export function enabledL10nDetectors(config: ResolvedL10nConfig): L10nDetector[] {
  if (config.configError) return [];
  return L10N_DETECTOR_LIST.filter((detector) => {
    const block = config[detector];
    return block !== undefined && block.enabled;
  });
}

// ─── The outcome ledger ──────────────────────────────────────────────────────

/**
 * What ONE detector did, and the shape that makes the headline honesty rule
 * enforceable rather than remembered.
 *
 * `reason` is non-null exactly when `status` is UNMEASURED, which
 * {@link l10nOutcomeProblems} checks and the colocated test pins in both
 * directions. The pair is what separates "0 findings over 412 nodes" from "0
 * findings because we never looked", and a consumer handed only the findings
 * cannot tell those apart.
 *
 * `cappedBy` is non-null exactly when a budget BIT, and carries the count and
 * the reason — never a bare truncation.
 */
export interface L10nDetectorOutcome {
  readonly detector: L10nDetector;
  readonly status: 'MEASURED' | 'UNMEASURED';
  /** Required when UNMEASURED, forbidden otherwise. */
  readonly reason: L10nUnmeasuredReason | null;
  /** One clause saying what was looked at, never what was assumed. */
  readonly detail: string;
  /** How many nodes this detector actually inspected. */
  readonly nodesExamined: number;
  /** Nodes it deliberately set aside, with why — never a silent skip. */
  readonly setAside: readonly { readonly count: number; readonly why: string }[];
  readonly findings: number;
  /** Non-null exactly when a cap bit. */
  readonly cappedBy: {
    readonly cap: string;
    readonly limit: number;
    readonly taken: number;
    readonly atLeastMore: number;
    readonly detail: string;
  } | null;
}

/**
 * Every way an outcome could contradict itself, as sentences.
 *
 * Exported and asked of by the colocated test rather than asserted field by
 * field, so a seventh invariant is added in one place. This is the same
 * arrangement as `declarationProblems` in packages/shared/src/test-type-decl.ts:
 * an incoherent record is a defect in OUR producer, and a producer that can
 * write one is a producer whose output a gate cannot trust.
 */
export function l10nOutcomeProblems(outcome: L10nDetectorOutcome): string[] {
  const problems: string[] = [];
  if (outcome.status === 'UNMEASURED' && outcome.reason === null) {
    problems.push(
      'UNMEASURED with no reason, which is indistinguishable from a detector that found nothing',
    );
  }
  if (outcome.status === 'MEASURED' && outcome.reason !== null) {
    problems.push('MEASURED and carrying an unmeasured reason, so the row says both');
  }
  if (
    outcome.status === 'UNMEASURED' &&
    outcome.reason !== null &&
    NO_EVIDENCE_UNMEASURED_REASONS.includes(outcome.reason) &&
    outcome.findings > 0
  ) {
    problems.push(
      `${outcome.findings} finding(s) reported beside ${outcome.reason}, which means no evidence was produced — a finding from a detector that did not look is a finding about nothing`,
    );
  }
  if (outcome.cappedBy !== null && outcome.cappedBy.atLeastMore <= 0) {
    problems.push(
      'a cap is recorded as having bitten and nothing was lost to it; a cap that did not bite says nothing and must be null',
    );
  }
  if (outcome.setAside.some((entry) => entry.count <= 0)) {
    problems.push('a set-aside entry with a count of zero, which is not a set-aside');
  }
  return problems;
}

export interface L10nDeepResult {
  readonly findings: readonly Finding[];
  readonly outcomes: readonly L10nDetectorOutcome[];
  /**
   * TRUE only when at least one detector MEASURED something.
   *
   * The one boolean a coverage number may read. A route where this is false has
   * produced no evidence about localisation at all and must leave both halves of
   * any ratio — which is the difference between a product that reports 0 defects
   * and a product that reports that it did not look.
   */
  readonly measuredAnything: boolean;
}

// ─── Detector: missing keys and unrendered tokens ────────────────────────────

/**
 * A budget-aware accumulator.
 *
 * Exists so that every detector counts what it set aside and what it lost to a
 * cap in exactly the same way, rather than each one re-deciding. A detector that
 * returned `findings.slice(0, limit)` would be the "cap applied without being
 * disclosed" defect, once per detector.
 */
class Ledger {
  readonly findings: L10nFindingInput[] = [];
  private readonly aside = new Map<string, number>();
  private suppressed = 0;
  examined = 0;

  constructor(private readonly limit: number) {}

  add(input: L10nFindingInput): void {
    if (this.findings.length >= this.limit) {
      this.suppressed += 1;
      return;
    }
    this.findings.push(input);
  }

  setAside(why: string, count = 1): void {
    this.aside.set(why, (this.aside.get(why) ?? 0) + count);
  }

  asideList(): Array<{ count: number; why: string }> {
    return [...this.aside.entries()].map(([why, count]) => ({ count, why }));
  }

  cap(name: string): L10nDetectorOutcome['cappedBy'] {
    if (this.suppressed === 0) return null;
    return {
      cap: name,
      limit: this.limit,
      taken: this.findings.length,
      atLeastMore: this.suppressed,
      detail:
        `${this.suppressed} further finding(s) were not reported because the limit is ${this.limit}. ` +
        'The count above is a sample, not the total for this route.',
    };
  }
}

/**
 * A raw key or an unrendered template token reaching the screen.
 *
 * Two findings with deliberately different severities and deliberately different
 * codes:
 *
 *   · `l10n.missing-key` — the text IS a key the supplied catalogue holds. This
 *     is not a heuristic: the application rendered the lookup key instead of the
 *     message, so the string is definitively missing for this locale. SERIOUS.
 *   · `l10n.key-shaped-text` — the text has a key's SHAPE and no catalogue was
 *     supplied to confirm it. MODERATE, and it says so in the message, because a
 *     customer whose UI legitimately displays dotted identifiers deserves to
 *     read that we guessed.
 *   · `l10n.unrendered-token` — `{{name}}` on screen. The interpolation did not
 *     happen, which is user-visible nonsense in any locale. SERIOUS.
 *
 * Separating the first two is the whole value: merging them into one code would
 * make a confirmed defect and a guess indistinguishable in a gate, and the gate
 * would be set to the looser of the two.
 */
export function detectMissingKeys(input: L10nDeepInput): L10nDetectorRun {
  const config = input.config.missingKey;
  const base = { detector: 'missingKey' as const };
  if (config === undefined || !config.enabled) return notEnabled(base.detector);

  const nodes = input.target.nodes;
  if (nodes.length === 0) {
    return unmeasured(base.detector, 'NO_NODES', 'the snapshot held no text-bearing nodes');
  }

  const catalogue = input.catalogueKeys ? new Set(input.catalogueKeys) : null;
  const ledger = new Ledger(input.config.maxFindingsPerDetector);
  const { taken, lost } = take(nodes, input.config.maxNodes);

  for (const node of taken) {
    if (node.text.length === 0) continue;
    if (inLiteralContainer(node)) {
      ledger.setAside(
        `inside a <${node.tag.toLowerCase()}>, where braces and dotted identifiers are content rather than a defect`,
      );
      continue;
    }
    ledger.examined += 1;

    const tokens = placeholdersIn(node.text);
    for (const { token } of tokens) {
      ledger.add({
        code: `${L10N_CODE_PREFIX}unrendered-token`,
        severity: 'SERIOUS',
        location: node.locator,
        problem: `Under ${input.target.locale} this node renders the interpolation token ${quote(token)} literally, inside ${quote(node.text)}.`,
        remedy:
          'The message was looked up but its arguments were never substituted — check that the call site passes the values this message declares.',
      });
    }

    const verdict = looksLikeMessageKey(node.text);
    if (verdict === null) continue;

    if (catalogue !== null && catalogue.has(verdict.key)) {
      ledger.add({
        code: `${L10N_CODE_PREFIX}missing-key`,
        severity: 'SERIOUS',
        location: node.locator,
        problem: `Under ${input.target.locale} this node renders the message key ${quote(verdict.key)}, which the supplied catalogue holds as a key rather than as text.`,
        remedy: `Add a ${input.target.locale} translation for that key, or fix the lookup — the application is displaying the identifier it looked the message up by.`,
      });
      continue;
    }
    if (catalogue !== null) {
      ledger.setAside(
        'key-shaped text that the supplied catalogue does not hold as a key, so it is the application\'s own content',
      );
      continue;
    }
    if (!config.heuristicKeys) {
      ledger.setAside('key-shaped text, with heuristic reporting switched off');
      continue;
    }
    ledger.add({
      code: `${L10N_CODE_PREFIX}key-shaped-text`,
      severity: 'MODERATE',
      location: node.locator,
      problem: `Under ${input.target.locale} this node renders ${quote(node.text)}, which has the shape of a message key (${verdict.why}). No catalogue was supplied, so this is a heuristic and not a confirmed lookup failure.`,
      remedy:
        'Supply the locale catalogue to this test to have the key confirmed, or ignore this node if your UI legitimately displays dotted identifiers.',
    });
  }

  return measured(base.detector, ledger, lost, input, {
    detail:
      `examined ${ledger.examined} text node(s) under ${input.target.locale} for leaked keys and unrendered tokens` +
      (catalogue === null
        ? ', with no catalogue supplied, so every key report is a shape heuristic'
        : `, confirmed against a catalogue of ${catalogue.size} key(s)`),
  });
}

// ─── Detector: pseudo-localization ───────────────────────────────────────────

/**
 * Expand every string and see what breaks.
 *
 * ── WHY THIS IS THE CHEAPEST L10N VALUE IN THE PRODUCT ──────────────────────
 *
 * It needs NO TRANSLATOR, NO CATALOGUE and NO SECOND LOCALE. A pseudo-localized
 * run finds truncation, hard-coded widths, interpolation the pipeline mangles and
 * strings that never reach the pipeline at all — on day one, against an
 * English-only application, before a single word has been translated. Every other
 * detector in this file needs translation data to exist first.
 *
 * ── THE THREE FINDINGS, AND WHY THE CLIP ONE NEEDS NO GEOMETRY ──────────────
 *
 *   · `l10n.pseudo.clipped` — the opening sentinel reached the screen and the
 *     closing one did not. That is a string being cut off, decided from TEXT
 *     ALONE: no `scrollWidth`, no box, nothing the truncation detector has to
 *     have. It therefore works against snapshots that detector must refuse,
 *     which is the reason the two are separate detectors and not one.
 *   · `l10n.pseudo.not-localized` — the node carries no accents while its
 *     siblings do. Under pseudo-localization EVERY string that passed through the
 *     translation layer is accented, so one that is not never went through it:
 *     a hard-coded literal, found without a second locale.
 *   · `l10n.pseudo.placeholder-mangled` — a placeholder arrived accented or
 *     broken, so the interpolation this application performs will no longer match
 *     it. The defect is in the pipeline, not in the page.
 *
 * ── WHAT IT REFUSES TO DECIDE ───────────────────────────────────────────────
 *
 * A node with no letters cannot carry an accent, so `carriesPseudoAccents`
 * answers null for it and it is SET ASIDE with a count rather than reported as
 * hard-coded. Every number, icon glyph and separator on the page is in that
 * category, and a detector that read them as literals would file one finding per
 * price.
 */
export function detectPseudoLocalization(input: L10nDeepInput): L10nDetectorRun {
  const config = input.config.pseudoLocalization;
  if (config === undefined || !config.enabled) return notEnabled('pseudoLocalization');

  const rendering = input.pseudoRendering;
  if (!rendering) {
    return unmeasured(
      'pseudoLocalization',
      'NO_PSEUDO_RENDERING',
      'no pseudo-localized rendering was captured, so no string was expanded and nothing about truncation under growth is known',
    );
  }
  if (!rendering.pseudo) {
    return unmeasured(
      'pseudoLocalization',
      'NO_PSEUDO_RENDERING',
      'the rendering supplied as the pseudo-localized one is not marked as pseudo, so expanding it was never requested',
    );
  }
  if (rendering.nodes.length === 0) {
    return unmeasured('pseudoLocalization', 'NO_NODES', 'the pseudo rendering held no text nodes');
  }

  const ledger = new Ledger(input.config.maxFindingsPerDetector);
  const { taken, lost } = take(rendering.nodes, input.config.maxNodes);

  /*
   * "Did ANY string on this page get pseudo-localized" has to be answered before
   * the not-localized finding may be emitted at all. A page where nothing is
   * accented is a page the pseudo locale was never applied to — a misconfigured
   * run — and reporting every node on it as a hard-coded literal would be one
   * finding per element, all of them wrong, from a detector that proved only that
   * its own input was broken.
   */
  const anyAccented = taken.some((node) => carriesPseudoAccents(node.text) === true);
  if (!anyAccented) {
    return unmeasured(
      'pseudoLocalization',
      'NO_TRANSLATION_DATA',
      `not one of ${taken.length} node(s) carries a pseudo-localized accent, so the pseudo locale never reached the rendering — this is evidence about the run's configuration, not about the page`,
    );
  }

  for (const node of taken) {
    if (node.text.length === 0) continue;
    if (inLiteralContainer(node)) {
      ledger.setAside(`inside a <${node.tag.toLowerCase()}>, which renders literal text`);
      continue;
    }
    ledger.examined += 1;

    const hasStart = node.text.includes(PSEUDO_START);
    const hasEnd = node.text.includes(PSEUDO_END);
    if (hasStart && !hasEnd) {
      ledger.add({
        code: `${L10N_CODE_PREFIX}pseudo.clipped`,
        severity: 'SERIOUS',
        location: node.locator,
        problem: `Under pseudo-localization this node shows the opening marker and not the closing one, so its text is being cut off: ${quote(node.text)}.`,
        remedy:
          'The container cannot hold a string 40% longer than the source. Give it room to grow, wrap, or use a shorter message — German and Finnish will produce this growth for real.',
      });
      continue;
    }

    const accented = carriesPseudoAccents(node.text);
    if (accented === null) {
      ledger.setAside(
        'no letters in the text, so it can carry no accent and says nothing about the translation layer either way',
      );
      continue;
    }
    if (!accented && !hasStart) {
      ledger.add({
        code: `${L10N_CODE_PREFIX}pseudo.not-localized`,
        severity: 'MODERATE',
        location: node.locator,
        problem: `Under pseudo-localization this node's text is unchanged — ${quote(node.text)} — while other strings on the page were expanded, so it never passed through the translation layer.`,
        remedy:
          'Move this string into a message catalogue and look it up. A literal in the markup cannot be translated at all, in any locale.',
      });
      continue;
    }

    for (const { token } of placeholdersIn(node.text)) {
      /*
       * A placeholder that reached the screen at all is the missing-key
       * detector's finding, not this one's. What belongs HERE is a placeholder
       * the EXPANSION damaged — so this reports only when the token carries an
       * accent, which `pseudoLocalize` is built never to produce.
       */
      if (carriesPseudoAccents(token) === true) {
        ledger.add({
          code: `${L10N_CODE_PREFIX}pseudo.placeholder-mangled`,
          severity: 'SERIOUS',
          location: node.locator,
          problem: `The interpolation token ${quote(token)} came back accented from the pseudo-localization pass, so it no longer matches the placeholder this application substitutes.`,
          remedy:
            'The pseudo-localization step is transforming placeholders. Exclude interpolation tokens from it — a mangled token renders as visible braces in every locale that goes through the same pipeline.',
        });
      }
    }
  }

  return measured('pseudoLocalization', ledger, lost, input, {
    detail: `examined ${ledger.examined} node(s) in a pseudo-localized rendering grown by ${Math.round(config.growth * 100)}%`,
  });
}

// ─── Detector: truncation and overlap ────────────────────────────────────────

function overlapArea(a: L10nBox, b: L10nBox): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Text clipped, ellipsised unexpectedly, or overflowing its container.
 *
 * ── UNMEASURED RATHER THAN CLEAN, AND THIS IS WHERE IT BITES HARDEST ────────
 *
 * Every check here needs box metrics. A snapshot collected without them makes
 * this detector report `NO_GEOMETRY` — because "no node is clipped" and "we never
 * measured a box" are different answers, and the first one is what a reader will
 * assume from an empty finding list. A snapshot where SOME nodes carry metrics
 * measures those and SETS ASIDE the rest with a count, so the examined number is
 * never mistaken for the page.
 *
 * ── `text-overflow: ellipsis` IS NOT A DEFECT ON ITS OWN ────────────────────
 *
 * It is a deliberate design decision on a table cell or a filename, and a
 * detector that reported it would be reporting the application working as
 * intended. What is reported is an ellipsis that is ACTUALLY CLIPPING — styled
 * for it AND overflowing — which is the same measurement with the designer's
 * intent taken into account.
 */
export function detectTruncation(input: L10nDeepInput): L10nDetectorRun {
  const config = input.config.truncation;
  if (config === undefined || !config.enabled) return notEnabled('truncation');

  const nodes = input.target.nodes;
  if (nodes.length === 0) {
    return unmeasured('truncation', 'NO_NODES', 'the snapshot held no text-bearing nodes');
  }
  if (!nodes.some((node) => node.box !== null)) {
    return unmeasured(
      'truncation',
      'NO_GEOMETRY',
      `none of ${nodes.length} node(s) carried box metrics, so no clip or overlap could be decided — this says nothing about whether the page truncates`,
    );
  }

  const ledger = new Ledger(input.config.maxFindingsPerDetector);
  const { taken, lost } = take(nodes, input.config.maxNodes);
  const measurable: L10nNode[] = [];

  for (const node of taken) {
    if (node.box === null) {
      ledger.setAside('no box metrics collected for this node, so it was not measured');
      continue;
    }
    if (node.text.length === 0) continue;
    ledger.examined += 1;
    measurable.push(node);

    const box = node.box;
    const overflowX = box.scrollWidth - box.clientWidth;
    const overflowY = box.scrollHeight - box.clientHeight;
    const ellipsised = (node.textOverflow ?? '').includes('ellipsis');

    if (overflowX > config.tolerancePx) {
      if (ellipsised) {
        ledger.add({
          code: `${L10N_CODE_PREFIX}ellipsised`,
          severity: 'MODERATE',
          location: node.locator,
          problem: `Under ${input.target.locale} this node is styled to ellipsise AND is overflowing by ${Math.round(overflowX)}px, so its text is actually being cut: ${quote(node.text)}.`,
          remedy:
            'An ellipsis is a deliberate choice; an ellipsis that fires is lost information. Widen the container for this locale, or confirm the full text is reachable another way.',
        });
      } else if (node.overflowHidden === true) {
        ledger.add({
          code: `${L10N_CODE_PREFIX}truncated`,
          severity: 'SERIOUS',
          location: node.locator,
          problem: `Under ${input.target.locale} this node's text is ${Math.round(overflowX)}px wider than its clipped container, with no ellipsis, so the end of ${quote(node.text)} is simply gone.`,
          remedy:
            'Let the container grow or wrap for this locale. A hard-coded width that fits the source language clips every longer translation silently.',
        });
      } else {
        ledger.add({
          code: `${L10N_CODE_PREFIX}overflow`,
          severity: 'MODERATE',
          location: node.locator,
          problem: `Under ${input.target.locale} this node's text overflows its box by ${Math.round(overflowX)}px horizontally: ${quote(node.text)}.`,
          remedy:
            'Overflow is not clipped here, so the text escapes its container rather than disappearing — check it is not sitting on top of a neighbour.',
        });
      }
      continue;
    }
    if (overflowY > config.tolerancePx && node.overflowHidden === true) {
      ledger.add({
        code: `${L10N_CODE_PREFIX}truncated`,
        severity: 'SERIOUS',
        location: node.locator,
        problem: `Under ${input.target.locale} this node's text is ${Math.round(overflowY)}px taller than its clipped container, so its last line or lines are not rendered: ${quote(node.text)}.`,
        remedy:
          'A fixed height that fits the source language hides whole lines of a longer translation. Let the container grow vertically for this locale.',
      });
    }
  }

  if (config.overlap) {
    for (let i = 0; i < measurable.length; i += 1) {
      const a = measurable[i];
      if (!a?.box) continue;
      for (let j = i + 1; j < measurable.length; j += 1) {
        const b = measurable[j];
        if (!b?.box) continue;
        /*
         * A parent's box CONTAINS its child's by definition, so an ancestry test
         * is what stops this reporting every container on the page as
         * overlapping its own text. Without it the detector produces one finding
         * per nesting level, all of them describing correct layout.
         */
        if (a.ancestors.includes(b.locator) || b.ancestors.includes(a.locator)) continue;
        const area = overlapArea(a.box, b.box);
        if (area <= config.minOverlapPx2) continue;
        ledger.add({
          code: `${L10N_CODE_PREFIX}overlap`,
          severity: 'SERIOUS',
          location: `${a.locator} over ${b.locator}`,
          problem: `Under ${input.target.locale} two unrelated text nodes overlap by ${Math.round(area)}px²: ${quote(a.text, 60)} and ${quote(b.text, 60)}.`,
          remedy:
            'One of the two grew past the space reserved for it. Both strings are now partly unreadable, which no amount of re-translating fixes — the layout has to give.',
        });
      }
    }
  }

  return measured('truncation', ledger, lost, input, {
    detail: `measured ${ledger.examined} node(s) with box metrics under ${input.target.locale}, tolerance ${config.tolerancePx}px`,
  });
}

// ─── Detector: right-to-left mirroring ───────────────────────────────────────

/**
 * Does this computed `transform` flip the horizontal axis?
 *
 * `null` for a transform that will not parse, and that third answer is the point:
 * a `transform` from a matrix library, a 3D composition or a CSS function this
 * parser does not know is NOT evidence that an icon failed to mirror. Reading it
 * as "no flip" would file a finding against an icon whose mirroring we simply
 * could not read, which is a measurement we did not make.
 */
export function hasHorizontalFlip(transform: string | null): boolean | null {
  if (transform === null) return null;
  const value = transform.trim();
  if (value === '' || value === 'none') return false;

  const matrix = /^matrix\(\s*(-?[\d.eE+]+)/.exec(value);
  if (matrix?.[1] !== undefined) {
    const a = Number(matrix[1]);
    return Number.isFinite(a) ? a < 0 : null;
  }
  const matrix3d = /^matrix3d\(\s*(-?[\d.eE+]+)/.exec(value);
  if (matrix3d?.[1] !== undefined) {
    const a = Number(matrix3d[1]);
    return Number.isFinite(a) ? a < 0 : null;
  }
  const scaleX = /scaleX\(\s*(-?[\d.eE+]+)\s*\)/.exec(value);
  if (scaleX?.[1] !== undefined) {
    const x = Number(scaleX[1]);
    return Number.isFinite(x) ? x < 0 : null;
  }
  const scale = /scale\(\s*(-?[\d.eE+]+)/.exec(value);
  if (scale?.[1] !== undefined) {
    const x = Number(scale[1]);
    return Number.isFinite(x) ? x < 0 : null;
  }
  return null;
}

/**
 * Unicode blocks whose scripts run right to left.
 *
 * Written as `\u` escapes, not as literal characters. Five of the fourteen
 * boundaries are unprintable — U+0590, U+05FF, U+0600, U+FDFF and U+FEFF — so
 * the literal form was a class nobody could review, and the U+FEFF range end
 * tripped `no-irregular-whitespace` besides. Same code points, block by block:
 * Hebrew, Arabic, Syriac, Arabic Supplement, Arabic Extended-A, Presentation
 * Forms-A, Presentation Forms-B.
 */
const RTL_CHAR =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
/** Latin, Greek and Cyrillic letters: the strongly left-to-right runs. */
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;

/**
 * Does this text mix the two directions strongly enough to reorder wrongly?
 *
 * Both a strong-RTL and a strong-LTR run in one string is the condition the
 * Unicode bidirectional algorithm reorders, and it is where a phone number, an
 * order id or a product code lands in the wrong place inside an Arabic sentence.
 * Digits and punctuation are NEUTRAL and are deliberately not counted: `"١٢٣"`
 * beside Arabic text is not mixed, and treating a digit as a left-to-right run
 * would report every price in the application.
 */
export function hasMixedDirection(text: string): boolean {
  return RTL_CHAR.test(text) && LTR_CHAR.test(text);
}

/**
 * Direction applied, layout mirrored, and icons mirrored only where they should
 * be.
 *
 * ── THE ORDER OF THE FINDINGS IS THE SEVERITY ───────────────────────────────
 *
 * `l10n.rtl.document-direction` is CRITICAL and is the only critical finding in
 * this file: an Arabic or Hebrew rendering inside a left-to-right layout is not a
 * localisation imperfection, it is an application that cannot be used, and every
 * string-level check in the product passes on it. Everything below it is a
 * SERIOUS or MODERATE defect in an otherwise-mirrored page.
 *
 * ── PHYSICAL ALIGNMENT IS FOUND BY COMPARING TWO RENDERINGS ─────────────────
 *
 * A computed `text-align` resolves `start` to `left` or `right` depending on the
 * direction, so one rendering cannot tell a logical `start` from a physical
 * `left` — they are the same string. TWO renderings can: a node that computes
 * `left` under both an LTR and an RTL locale was authored with a physical side
 * and will not mirror, while one that computes `left` then `right` was authored
 * logically. Without a base rendering the sub-check is set aside with a count
 * rather than guessed.
 */
export function detectRtlMirroring(input: L10nDeepInput): L10nDetectorRun {
  const config = input.config.rtlMirroring;
  if (config === undefined || !config.enabled) return notEnabled('rtlMirroring');

  const target = input.target;
  if (target.direction === null) {
    return unmeasured(
      'rtlMirroring',
      'NO_DIRECTION_DECLARED',
      `nobody declared which direction ${target.locale} expects, and this module holds no table of right-to-left languages on purpose — supply the locale's direction from the surface inventory`,
    );
  }
  if (target.nodes.length === 0) {
    return unmeasured('rtlMirroring', 'NO_NODES', 'the snapshot held no text-bearing nodes');
  }

  const ledger = new Ledger(input.config.maxFindingsPerDetector);
  const { taken, lost } = take(target.nodes, input.config.maxNodes);
  const expectRtl = target.direction === 'RTL';

  if (expectRtl) {
    if (target.documentDirection === null) {
      ledger.setAside(
        "the document's own computed direction was not collected, so the page-level mirroring check did not run",
      );
    } else if (target.documentDirection !== 'rtl') {
      ledger.add({
        code: `${L10N_CODE_PREFIX}rtl.document-direction`,
        severity: 'CRITICAL',
        location: `document (lang=${target.htmlLang ?? 'not collected'})`,
        problem: `${target.locale} is a right-to-left locale and the document computes direction: ${target.documentDirection}, so the whole layout is unmirrored while the text reads the other way.`,
        remedy:
          'Set dir="rtl" on the html element for this locale. Nothing below this finding matters until the page itself mirrors, and every string-level check passes on a page in this state.',
      });
    }
  }

  const baseByLocator = new Map<string, L10nNode>();
  if (input.base) for (const node of input.base.nodes) baseByLocator.set(node.locator, node);

  for (const node of taken) {
    ledger.examined += 1;

    if (expectRtl && node.direction !== null && node.direction !== 'rtl' && RTL_CHAR.test(node.text)) {
      ledger.add({
        code: `${L10N_CODE_PREFIX}rtl.node-direction`,
        severity: 'SERIOUS',
        location: node.locator,
        problem: `This node holds right-to-left text and computes direction: ${node.direction}, so its runs render in the wrong order: ${quote(node.text)}.`,
        remedy:
          'Remove the direction override on this subtree, or set dir="auto" so the content decides. A left-to-right box containing Arabic or Hebrew reverses the reading order of every phrase in it.',
      });
    }

    if (config.physicalAlignment && expectRtl) {
      const counterpart = baseByLocator.get(node.locator);
      if (!input.base) {
        // Counted once per node so the set-aside total says how much of the page
        // this sub-check could not reach.
        ledger.setAside(
          'no base rendering, so a physical text-align could not be told apart from a logical one — they compute to the same string',
        );
      } else if (counterpart === undefined) {
        ledger.setAside('this node has no counterpart in the base rendering to compare alignment with');
      } else if (node.textAlign === null || counterpart.textAlign === null) {
        ledger.setAside('text-align was not collected on one of the two renderings');
      } else if (
        (node.textAlign === 'left' || node.textAlign === 'right') &&
        node.textAlign === counterpart.textAlign
      ) {
        ledger.add({
          code: `${L10N_CODE_PREFIX}rtl.physical-alignment`,
          severity: 'MODERATE',
          location: node.locator,
          problem: `This node computes text-align: ${node.textAlign} under both ${input.base.locale} and ${target.locale}, so the side was authored physically and does not mirror.`,
          remedy:
            'Use text-align: start or end instead of left or right. A physical side is correct in exactly one direction and wrong in the other, for ever.',
        });
      }
    }

    if (config.icons && expectRtl) {
      if (node.mirror === null) {
        ledger.setAside(
          'no mirroring expectation declared for this node, so whether it should flip is unknown — a back arrow must mirror and a clock face must not, and that cannot be read off the markup',
        );
      } else {
        const flipped = hasHorizontalFlip(node.transform);
        if (flipped === null) {
          ledger.setAside(
            'the computed transform could not be parsed, so whether this node mirrors was not measured',
          );
        } else if (node.mirror === 'MUST_MIRROR' && !flipped) {
          ledger.add({
            code: `${L10N_CODE_PREFIX}rtl.icon-not-mirrored`,
            severity: 'MODERATE',
            location: node.locator,
            problem: `This node is declared MUST_MIRROR and carries no horizontal flip under ${target.locale} (transform: ${node.transform ?? 'none'}).`,
            remedy:
              'Flip it for right-to-left. A directional icon pointing the wrong way sends the reader backwards through the flow.',
          });
        } else if (node.mirror === 'MUST_NOT_MIRROR' && flipped) {
          ledger.add({
            code: `${L10N_CODE_PREFIX}rtl.icon-wrongly-mirrored`,
            severity: 'MODERATE',
            location: node.locator,
            problem: `This node is declared MUST_NOT_MIRROR and is horizontally flipped under ${target.locale} (transform: ${node.transform ?? 'none'}).`,
            remedy:
              'Exclude it from the mirroring rule. A blanket flip on every icon reverses logos, clocks, checkmarks and musical notation along with the arrows.',
          });
        }
      }
    }

    if (config.bidi && hasMixedDirection(node.text)) {
      const isolated = (node.unicodeBidi ?? '').includes('isolate') || (node.unicodeBidi ?? '').includes('plaintext');
      if (node.unicodeBidi === null) {
        ledger.setAside('unicode-bidi was not collected, so the bidirectional check did not run on this node');
      } else if (!isolated) {
        ledger.add({
          code: `${L10N_CODE_PREFIX}rtl.bidi-not-isolated`,
          severity: 'SERIOUS',
          location: node.locator,
          problem: `This node mixes right-to-left and left-to-right runs with unicode-bidi: ${node.unicodeBidi}, so the bidirectional algorithm will reorder the embedded run: ${quote(node.text)}.`,
          remedy:
            'Wrap the embedded value in an element with unicode-bidi: isolate (or dir="auto"). Without isolation an order id, phone number or product code lands in the wrong place inside the sentence — and reads as a different value.',
        });
      }
    }
  }

  return measured('rtlMirroring', ledger, lost, input, {
    detail: `examined ${ledger.examined} node(s) against a declared ${target.direction} expectation for ${target.locale}`,
  });
}

// ─── Detector: format correctness ────────────────────────────────────────────

/**
 * What a locale's numbers and dates are SUPPOSED to look like.
 *
 * Injected, with one thin adapter ({@link intlLocaleFormats}) that reads it out
 * of ICU, so the detector itself is pure and the whole format table can be
 * swapped for a fixture in a test. The product does not hold a hand-written
 * separators-by-locale table and will not: ICU already has one, it is the one
 * every browser and every runtime agrees on, and a second copy in this
 * repository would disagree with it the first time a CLDR release changed.
 */
export interface LocaleFormats {
  /**
   * The locale ICU ACTUALLY resolved to.
   *
   * The whole honesty of this detector is in this field. `Intl` falls back
   * silently — asked for `qps-ploc` it hands back `en-US` formats without
   * complaint — so comparing a rendering against a fallback's formats would
   * report the application as wrong for matching the locale nobody asked for.
   * The adapter returns null in that case and the detector reports
   * LOCALE_NOT_SUPPORTED_BY_ICU.
   */
  readonly resolved: string;
  readonly decimalSeparator: string;
  readonly groupSeparator: string;
  /** Null = ICU gave no currency pattern to read a position out of. */
  readonly currencySymbolFirst: boolean | null;
  /** Null = the order could not be read. Never a guess. */
  readonly dateOrder: 'DMY' | 'MDY' | 'YMD' | null;
  readonly dateSeparator: string | null;
}

export type LocaleFormatProbe = (locale: string) => LocaleFormats | null;

/**
 * THE ONE THIN ADAPTER over `Intl`.
 *
 * Not a network call, not a browser and not a clock — `Intl` is a pure
 * formatting library and the dates below are fixed constants, so this stays
 * deterministic. It is still an adapter rather than inline code because the ICU
 * data present in a runtime is a CAPABILITY: a small-icu build has one locale,
 * and the honest answer there is `null` → UNMEASURED, not a comparison against
 * en-US dressed up as a comparison against de-DE.
 *
 * The probe dates and numbers are chosen so every component is unambiguous:
 * 1987-06-05 has a day under 13 that is still distinguishable from the month by
 * value, and 1234567.89 exposes both separators at once.
 */
export const intlLocaleFormats: LocaleFormatProbe = (locale) => {
  try {
    const numberFormat = new Intl.NumberFormat(locale);
    const resolved = numberFormat.resolvedOptions().locale;
    /*
     * A language subtag that came back different means ICU fell back. Compared on
     * the LANGUAGE only, because a request for `de` legitimately resolves to
     * `de` and a request for `de-AT` may legitimately resolve to `de-AT` or `de`
     * depending on the data present — but a request for `de` that resolved to
     * `en` is a fallback and nothing about German is known.
     */
    const asked = locale.split('-')[0]?.toLowerCase();
    const got = resolved.split('-')[0]?.toLowerCase();
    if (asked === undefined || got === undefined || asked !== got) return null;

    const parts = numberFormat.formatToParts(1234567.89);
    const decimalSeparator = parts.find((part) => part.type === 'decimal')?.value ?? '.';
    const groupSeparator = parts.find((part) => part.type === 'group')?.value ?? ',';

    let currencySymbolFirst: boolean | null = null;
    try {
      const currencyParts = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'USD',
      }).formatToParts(12.34);
      const symbolAt = currencyParts.findIndex((part) => part.type === 'currency');
      const integerAt = currencyParts.findIndex((part) => part.type === 'integer');
      if (symbolAt >= 0 && integerAt >= 0) currencySymbolFirst = symbolAt < integerAt;
    } catch {
      currencySymbolFirst = null;
    }

    let dateOrder: LocaleFormats['dateOrder'] = null;
    let dateSeparator: string | null = null;
    try {
      const dateParts = new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        timeZone: 'UTC',
      }).formatToParts(new Date(Date.UTC(1987, 5, 5)));
      const order = dateParts
        .filter((part) => part.type === 'day' || part.type === 'month' || part.type === 'year')
        .map((part) => part.type.charAt(0).toUpperCase())
        .join('');
      if (order === 'DMY' || order === 'MDY' || order === 'YMD') dateOrder = order;
      dateSeparator = dateParts.find((part) => part.type === 'literal')?.value.trim() ?? null;
      if (dateSeparator === '') dateSeparator = null;
    } catch {
      dateOrder = null;
      dateSeparator = null;
    }

    return {
      resolved,
      decimalSeparator,
      groupSeparator,
      currencySymbolFirst,
      dateOrder,
      dateSeparator,
    };
  } catch {
    return null;
  }
};

/** Currency symbols common enough that their side is worth checking. */
const CURRENCY_SYMBOL = /[$€£¥₹₽₺₩₪]/;

interface ObservedNumber {
  readonly token: string;
  readonly decimal: string | null;
  readonly group: string | null;
}

/**
 * Read the separators out of a rendered numeric token, or answer null.
 *
 * ── WHAT IT REFUSES TO DECIDE, AND WHY THAT IS MOST OF THE FUNCTION ─────────
 *
 * `1.234` is `1234` in German and `1.234` in English and NOTHING can tell which
 * was meant. A detector that picked one would report half the correct pages in
 * the world as defective, so an ambiguous token answers null and is set aside
 * with a count. Only a token carrying BOTH separators (`1.234,56`), or one whose
 * trailing group is not three digits (`1,23` cannot be a thousands group),
 * resolves. That is the difference between a finding and a coin toss.
 */
export function readNumberSeparators(token: string): ObservedNumber | null {
  const separators = [...token].filter((char) => char === '.' || char === ',');
  if (separators.length === 0) return null;

  const lastDot = token.lastIndexOf('.');
  const lastComma = token.lastIndexOf(',');
  const kinds = new Set(separators);

  if (kinds.size === 2) {
    // Both present: the LAST one is the decimal, which is true in every locale
    // that uses both, and the other is therefore the group separator.
    const decimal = lastDot > lastComma ? '.' : ',';
    return { token, decimal, group: decimal === '.' ? ',' : '.' };
  }

  const only = separators[0];
  if (only === undefined) return null;
  const at = only === '.' ? lastDot : lastComma;
  const tail = token.slice(at + 1);
  if (!/^\d+$/.test(tail)) return null;
  /*
   * Exactly three trailing digits is the ambiguous case and the only one: it is a
   * thousands group in one locale and a three-decimal fraction in another.
   * Anything else resolves — two digits cannot be a group, four cannot be either
   * a group or a normal fraction on a price.
   */
  if (tail.length === 3) return null;
  if (token.slice(0, at).includes(only)) return null;
  return { token, decimal: only, group: null };
}

/**
 * Dates, numbers, currency and name order rendered per locale rather than per
 * developer.
 *
 * ── THE SUB-CHECKS ARE REPORTED SEPARATELY ──────────────────────────────────
 *
 * Four questions with four different amounts of available evidence. Numbers can
 * usually be decided, dates often cannot (an ambiguous `05/06/1987` is not
 * evidence in either direction and is set aside), currency position needs a
 * symbol in the text, and NAME ORDER needs a declared expectation because this
 * file holds no family-name-first locale table — for the reason in the header.
 * Rolling four different evidence levels into one outcome would let the one that
 * measured nothing hide behind the three that did.
 */
export function detectFormatCorrectness(input: L10nDeepInput): L10nDetectorRun {
  const config = input.config.formatCorrectness;
  if (config === undefined || !config.enabled) return notEnabled('formatCorrectness');

  const nodes = input.target.nodes;
  if (nodes.length === 0) {
    return unmeasured('formatCorrectness', 'NO_NODES', 'the snapshot held no text-bearing nodes');
  }
  const probe = input.formats ?? intlLocaleFormats;
  const formats = probe(input.target.locale);
  if (formats === null) {
    return unmeasured(
      'formatCorrectness',
      'LOCALE_NOT_SUPPORTED_BY_ICU',
      `no format data resolved for ${input.target.locale}, so there is no expected separator, date order or currency position to compare the rendering against`,
    );
  }

  const ledger = new Ledger(input.config.maxFindingsPerDetector);
  const { taken, lost } = take(nodes, input.config.maxNodes);

  for (const node of taken) {
    if (node.text.length === 0) continue;
    if (inLiteralContainer(node)) {
      ledger.setAside(`inside a <${node.tag.toLowerCase()}>, which renders literal text`);
      continue;
    }
    ledger.examined += 1;

    if (config.dates && formats.dateOrder !== null) {
      const dateScanner = /\b(\d{1,4})([/.-])(\d{1,2})\2(\d{1,4})\b/g;
      let dateMatch = dateScanner.exec(node.text);
      while (dateMatch !== null) {
        const [whole, first = '', separator = '', , third = ''] = dateMatch;
        const observed = readDateOrder(Number(first), Number(third));
        if (observed === null) {
          ledger.setAside(
            'a date whose component order cannot be determined from its values — 05/06/1987 is the same string in two orders, and guessing would report half the correct pages in the world',
          );
        } else if (observed !== formats.dateOrder) {
          ledger.add({
            code: `${L10N_CODE_PREFIX}format.date-order`,
            severity: 'SERIOUS',
            location: node.locator,
            problem: `Under ${input.target.locale} this node renders the date ${quote(whole)} in ${observed} order, and ${formats.resolved} writes dates ${formats.dateOrder}.`,
            remedy:
              'Format dates through the locale rather than with a fixed pattern. A date in the wrong order is not merely unfamiliar — it is read as a different day.',
          });
        } else if (
          formats.dateSeparator !== null &&
          separator !== formats.dateSeparator &&
          formats.dateSeparator.length === 1
        ) {
          ledger.add({
            code: `${L10N_CODE_PREFIX}format.date-separator`,
            severity: 'MINOR',
            location: node.locator,
            problem: `Under ${input.target.locale} this node renders ${quote(whole)} with "${separator}" between the parts, and ${formats.resolved} uses "${formats.dateSeparator}".`,
            remedy: 'Format the date through the locale instead of joining the parts yourself.',
          });
        }
        dateMatch = dateScanner.exec(node.text);
      }
    }

    if (config.numbers) {
      const numberScanner = /\d[\d.,]*\d/g;
      let numberMatch = numberScanner.exec(node.text);
      while (numberMatch !== null) {
        const token = numberMatch[0];
        // A date already reported above is not also a malformed number.
        if (!/^\d{1,4}[/.-]\d{1,2}/.test(token)) {
          const observedNumber = readNumberSeparators(token);
          if (observedNumber === null) {
            if (/[.,]/.test(token)) {
              ledger.setAside(
                'a number whose separators are ambiguous — 1.234 is one thousand two hundred and thirty-four in one locale and one point two three four in another',
              );
            }
          } else if (
            observedNumber.decimal !== null &&
            observedNumber.decimal !== formats.decimalSeparator
          ) {
            ledger.add({
              code: `${L10N_CODE_PREFIX}format.decimal-separator`,
              severity: 'SERIOUS',
              location: node.locator,
              problem: `Under ${input.target.locale} this node renders ${quote(token)} with "${observedNumber.decimal}" as the decimal separator, and ${formats.resolved} uses "${formats.decimalSeparator}".`,
              remedy:
                'Format numbers through the locale. A decimal separator in the wrong place changes the value by a factor of a thousand to a reader, which on a price is the whole defect.',
            });
          } else if (
            observedNumber.group !== null &&
            observedNumber.group !== formats.groupSeparator
          ) {
            ledger.add({
              code: `${L10N_CODE_PREFIX}format.group-separator`,
              severity: 'MODERATE',
              location: node.locator,
              problem: `Under ${input.target.locale} this node renders ${quote(token)} with "${observedNumber.group}" grouping the thousands, and ${formats.resolved} uses "${formats.groupSeparator}".`,
              remedy: 'Format numbers through the locale rather than inserting the separators yourself.',
            });
          }
        }
        numberMatch = numberScanner.exec(node.text);
      }
    }

    if (config.currency && formats.currencySymbolFirst !== null) {
      const symbol = CURRENCY_SYMBOL.exec(node.text);
      if (symbol !== null) {
        const digit = /\d/.exec(node.text);
        if (digit === null) {
          ledger.setAside('a currency symbol with no number beside it, so it has no side to be on');
        } else {
          const symbolFirst = symbol.index < digit.index;
          if (symbolFirst !== formats.currencySymbolFirst) {
            ledger.add({
              code: `${L10N_CODE_PREFIX}format.currency-position`,
              severity: 'MODERATE',
              location: node.locator,
              problem: `Under ${input.target.locale} this node renders the currency symbol ${symbolFirst ? 'before' : 'after'} the amount in ${quote(node.text)}, and ${formats.resolved} puts it ${formats.currencySymbolFirst ? 'before' : 'after'}.`,
              remedy:
                'Use a currency formatter for the locale rather than concatenating a symbol onto a number.',
            });
          }
        }
      }
    }
  }

  if (config.names) {
    const fields = input.nameFields ?? [];
    if (input.nameOrder === null || input.nameOrder === undefined) {
      ledger.setAside(
        'no name order was declared for this locale, and this module holds no family-name-first locale table on purpose — declare the expectation to have name order checked',
        Math.max(1, fields.length),
      );
    } else if (fields.length === 0) {
      ledger.setAside(
        'a name order is declared and no name fields were identified on the page, so nothing was compared',
      );
    } else {
      for (const field of fields) {
        const node = taken.find((candidate) => candidate.locator === field.locator);
        if (node === undefined) {
          ledger.setAside('a declared name field with no matching node in the snapshot');
          continue;
        }
        const givenAt = node.text.indexOf(field.given);
        const familyAt = node.text.indexOf(field.family);
        if (givenAt < 0 || familyAt < 0) {
          ledger.setAside(
            'a declared name field whose given and family parts are not both present in the rendered text',
          );
          continue;
        }
        const observed: NameOrder = givenAt < familyAt ? 'GIVEN_FIRST' : 'FAMILY_FIRST';
        if (observed !== input.nameOrder) {
          ledger.add({
            code: `${L10N_CODE_PREFIX}format.name-order`,
            severity: 'MODERATE',
            location: node.locator,
            problem: `Under ${input.target.locale} this node renders the name ${observed} and the declared expectation is ${input.nameOrder}: ${quote(node.text)}.`,
            remedy:
              'Compose the display name per locale rather than concatenating given and family in a fixed order. In the wrong order a name reads as a different person.',
          });
        }
      }
    }
  }

  return measured('formatCorrectness', ledger, lost, input, {
    detail:
      `compared ${ledger.examined} node(s) against ${formats.resolved} formats ` +
      `(decimal "${formats.decimalSeparator}", group "${formats.groupSeparator}", dates ${formats.dateOrder ?? 'not readable'})`,
  });
}

/**
 * Which order a date's components are in, from their VALUES alone, or null.
 *
 * Null is most of the answers and that is correct. A four-digit first component
 * is a year, a first component over twelve is a day, a third component over
 * thirty-one is a year — and everything else, which includes the whole of the
 * first twelve days of every month, is genuinely undecidable from the string.
 */
function readDateOrder(first: number, third: number): 'DMY' | 'MDY' | 'YMD' | null {
  if (first > 31) return 'YMD';
  if (first > 12) return 'DMY';
  if (third > 31) return first <= 12 ? null : 'DMY';
  return null;
}

// ─── Detector: hard-coded strings ────────────────────────────────────────────

/**
 * Text that does not change between two locales WHEN ITS NEIGHBOURS DO.
 *
 * ── THE NEIGHBOUR QUALIFIER IS THE ENTIRE PRECISION OF THIS DETECTOR ────────
 *
 * "Unchanged between two locales" on its own describes every brand name, every
 * product code, every number and — on a page with no translation data at all —
 * every single string. Scoped to a node whose SIBLINGS changed, it describes
 * something much narrower and much more likely to be a defect: a label that
 * stayed English inside a form whose other labels are German. So the comparison
 * is per parent, and a node whose siblings were also unchanged is set aside with
 * a count rather than reported.
 *
 * ── AND A PAGE WHERE NOTHING CHANGED IS UNMEASURED ──────────────────────────
 *
 * If no node anywhere changed, the locale has no translation data behind it. That
 * is the state every localisation suite starts in, it makes this detector and
 * every other one return zero, and reporting it as "no hard-coded strings" is
 * the lie this whole module was built to stop. `NO_TRANSLATION_DATA`, with the
 * count, so the report says we proved a catalogue is missing rather than that the
 * page is good.
 */
export function detectHardCodedStrings(input: L10nDeepInput): L10nDetectorRun {
  const config = input.config.hardCodedStrings;
  if (config === undefined || !config.enabled) return notEnabled('hardCodedStrings');

  if (!input.base) {
    return unmeasured(
      'hardCodedStrings',
      'NO_BASE_RENDERING',
      'this detector compares a locale against the source language and only one rendering was supplied',
    );
  }
  if (input.target.nodes.length === 0 || input.base.nodes.length === 0) {
    return unmeasured('hardCodedStrings', 'NO_NODES', 'one of the two renderings held no text nodes');
  }

  const baseByLocator = new Map<string, L10nNode>();
  for (const node of input.base.nodes) baseByLocator.set(node.locator, node);

  const ledger = new Ledger(input.config.maxFindingsPerDetector);
  const { taken, lost } = take(input.target.nodes, input.config.maxNodes);

  /** Per parent: did any sibling's text change at all? */
  const changedByParent = new Map<string, boolean>();
  let comparable = 0;
  let changed = 0;

  for (const node of taken) {
    const counterpart = baseByLocator.get(node.locator);
    if (counterpart === undefined) continue;
    comparable += 1;
    const parent = node.ancestors[node.ancestors.length - 1] ?? '(root)';
    if (counterpart.text !== node.text) {
      changed += 1;
      changedByParent.set(parent, true);
    } else if (!changedByParent.has(parent)) {
      changedByParent.set(parent, false);
    }
  }

  if (comparable === 0) {
    return unmeasured(
      'hardCodedStrings',
      'NO_BASE_RENDERING',
      `not one of ${taken.length} node(s) has a counterpart in the ${input.base.locale} rendering, so no text could be compared`,
    );
  }
  if (changed === 0) {
    return unmeasured(
      'hardCodedStrings',
      'NO_TRANSLATION_DATA',
      `all ${comparable} comparable node(s) render identically in ${input.base.locale} and ${input.target.locale}, so this locale has no translation data behind it — that is what was proved, not that the page is free of hard-coded strings`,
    );
  }

  const doNotTranslate = new Set(input.doNotTranslate ?? []);

  for (const node of taken) {
    const counterpart = baseByLocator.get(node.locator);
    if (counterpart === undefined) {
      ledger.setAside(`no counterpart in the ${input.base.locale} rendering to compare against`);
      continue;
    }
    ledger.examined += 1;
    if (counterpart.text !== node.text) continue;
    if (node.text.length < config.minLength) {
      ledger.setAside(
        `text shorter than ${config.minLength} characters, which is as likely to be an icon glyph or a brand mark as an untranslated string`,
      );
      continue;
    }
    if (doNotTranslate.has(node.text)) {
      ledger.setAside('on the declared do-not-translate list');
      continue;
    }
    if (!/\p{L}/u.test(node.text)) {
      ledger.setAside('no letters in the text, so there is nothing to translate');
      continue;
    }
    if (/^\p{Lu}\p{L}*$/u.test(node.text)) {
      ledger.setAside(
        'a single capitalised word, which this detector cannot tell from a proper noun or a brand name',
      );
      continue;
    }
    const parent = node.ancestors[node.ancestors.length - 1] ?? '(root)';
    if (changedByParent.get(parent) !== true) {
      ledger.setAside(
        'unchanged, and none of its siblings changed either — so this is a region with no translation rather than a string that missed one',
      );
      continue;
    }
    ledger.add({
      code: `${L10N_CODE_PREFIX}hard-coded`,
      severity: 'MODERATE',
      location: node.locator,
      problem: `This node renders ${quote(node.text)} identically in ${input.base.locale} and ${input.target.locale} while its siblings under the same parent were translated.`,
      remedy:
        'Move the string into the message catalogue and look it up. A literal in the markup is untranslatable in every locale, not just this one.',
    });
  }

  return measured('hardCodedStrings', ledger, lost, input, {
    detail:
      `compared ${ledger.examined} node(s) between ${input.base.locale} and ${input.target.locale}; ` +
      `${changed} of ${comparable} comparable node(s) changed, so there is translation data to reason about`,
  });
}

// ─── Running them all ────────────────────────────────────────────────────────

/**
 * Everything a detector run needs, as DATA.
 *
 * No `Page`, no `fetch`, no ambient clock. The plugin collects the renderings and hands
 * them over; this module decides what they mean. That split is the reason the
 * detectors have tests at all.
 */
export interface L10nDeepInput {
  /** The route these renderings came from, for a finding with no node of its own. */
  readonly route: string;
  /** The source-language rendering. Null = only one locale was captured. */
  readonly base: L10nRendering | null;
  /** The locale under test. */
  readonly target: L10nRendering;
  /** The same page under pseudo-localization. Null/absent = that pass did not run. */
  readonly pseudoRendering?: L10nRendering | null;
  /** The locale's catalogue keys, which turn a key-shape guess into a fact. */
  readonly catalogueKeys?: readonly string[] | null;
  /** Strings the customer has declared must NOT be translated. */
  readonly doNotTranslate?: readonly string[] | null;
  /** The declared name order for this locale. Absent = the sub-check is set aside. */
  readonly nameOrder?: NameOrder | null;
  /** Name fields identified on the page, for the name-order sub-check. */
  readonly nameFields?: readonly { locator: string; given: string; family: string }[] | null;
  /** Override the ICU adapter — a fixture in a test, ICU everywhere else. */
  readonly formats?: LocaleFormatProbe | null;
  readonly config: ResolvedL10nConfig;
  /** Page text lands in findings, so a string interpolated from a secret would too. */
  readonly mask?: ((value: string) => string) | null;
}

/**
 * ONE DETECTOR'S WHOLE ANSWER: the findings AND the ledger, in one object.
 *
 * ── WHY THE TWO TRAVEL TOGETHER AND NOT SEPARATELY ──────────────────────────
 *
 * A detector that returned only findings is the exact shape of this module's
 * headline defect: an empty array from a detector that measured four hundred
 * nodes and an empty array from a detector that was never switched on are the
 * same value, and every consumer downstream reads both as "clean". So there is no
 * way to get one without the other — the outcome is not an optional extra on the
 * side, it is half of the return type, and `findings.length` always equals
 * `outcome.findings` (pinned in l10n-deep.test.ts, because a count that can
 * disagree with its own list is a cap applied without being disclosed).
 */
export interface L10nDetectorRun {
  readonly outcome: L10nDetectorOutcome;
  readonly findings: readonly Finding[];
}

/** A cap on nodes, applied once and reported once. */
function take<T>(items: readonly T[], limit: number): { taken: readonly T[]; lost: number } {
  if (items.length <= limit) return { taken: items, lost: 0 };
  return { taken: items.slice(0, limit), lost: items.length - limit };
}

function notEnabled(detector: L10nDetector): L10nDetectorRun {
  return {
    outcome: {
      detector,
      status: 'UNMEASURED',
      reason: 'NOT_ENABLED',
      detail: L10N_UNMEASURED_REASON_LABELS.NOT_ENABLED,
      nodesExamined: 0,
      setAside: [],
      findings: 0,
      cappedBy: null,
    },
    findings: [],
  };
}

function unmeasured(
  detector: L10nDetector,
  reason: L10nUnmeasuredReason,
  detail: string,
): L10nDetectorRun {
  return {
    outcome: {
      detector,
      status: 'UNMEASURED',
      reason,
      detail,
      nodesExamined: 0,
      setAside: [],
      findings: 0,
      cappedBy: null,
    },
    findings: [],
  };
}

function measured(
  detector: L10nDetector,
  ledger: Ledger,
  nodesLost: number,
  input: L10nDeepInput,
  extra: { detail: string },
): L10nDetectorRun {
  const config = input.config;
  const mask = input.mask ?? ((value: string) => value);
  const findingCap = ledger.cap('maxFindingsPerDetector');
  const nodeCap =
    nodesLost > 0
      ? {
          cap: 'maxNodes',
          limit: config.maxNodes,
          taken: ledger.examined,
          atLeastMore: nodesLost,
          detail:
            `${nodesLost} node(s) beyond the limit of ${config.maxNodes} were never examined, so this ` +
            "detector's answer covers a prefix of the page and not the page.",
        }
      : null;
  return {
    outcome: {
      detector,
      status: 'MEASURED',
      reason: null,
      detail: extra.detail,
      nodesExamined: ledger.examined,
      setAside: ledger.asideList(),
      findings: ledger.findings.length,
      /*
       * The NODE cap is reported in preference to the FINDING cap when both bit:
       * losing nodes bounds what could have been found at all, which is the
       * stronger qualification on the number. Both are counts with reasons, and
       * neither is ever a bare truncation.
       */
      cappedBy: nodeCap ?? findingCap,
    },
    findings: ledger.findings.map((raw) => toFinding(raw, mask)),
  };
}

const DETECTOR_FUNCTIONS: Record<L10nDetector, (input: L10nDeepInput) => L10nDetectorRun> = {
  missingKey: detectMissingKeys,
  pseudoLocalization: detectPseudoLocalization,
  truncation: detectTruncation,
  rtlMirroring: detectRtlMirroring,
  formatCorrectness: detectFormatCorrectness,
  hardCodedStrings: detectHardCodedStrings,
};

/**
 * Run every detector and return the findings BESIDE the ledger of what was
 * measured.
 *
 * ── NEVER THROWS, AND A DETECTOR THAT FAILS IS COUNTED ──────────────────────
 *
 * Each one is wrapped. A detector that throws leaves `DETECTOR_FAILED` with its
 * message, because a thrown detector whose exception is swallowed reports a clean
 * defect class it never examined. That is almost the same failure mode as one
 * that was never switched on — which is why they are two different reasons in one
 * vocabulary and not one word covering both.
 *
 * ── THE FINDINGS ALONE ARE NOT THE RESULT ───────────────────────────────────
 *
 * `outcomes` and `measuredAnything` travel with them, and the caller is expected
 * to append {@link unmeasuredFindings} to the result so that a reader of the
 * findings list — which is what a report, a PR comment and a Slack message show
 * — still cannot mistake an unexamined route for a clean one. Two pieces because
 * one is for a human and the other is for a denominator.
 */
export function runL10nDetectors(input: L10nDeepInput): L10nDeepResult {
  const mask = input.mask ?? ((value: string) => value);

  /*
   * A `deep` block that would not parse is REPORTED, NOT OBEYED, and it is
   * reported against every detector rather than against one: it is not that a
   * check failed, it is that none of them ran, for a reason the spec's author
   * fixes in one line. Same arrangement as `runDeepA11yChecks`.
   */
  if (input.config.configError !== null) {
    const why = input.config.configError;
    return {
      findings: [
        toFinding(
          {
            code: `${L10N_CODE_PREFIX}unmeasured.config`,
            severity: 'MINOR',
            location: input.route,
            problem: `No localisation detector ran on ${input.route}: ${why}.`,
            remedy: `Correct the deep block in the test's spec. Available detectors: ${L10N_DETECTOR_LIST.join(', ')}.`,
          },
          mask,
        ),
      ],
      outcomes: L10N_DETECTOR_LIST.map(
        (detector) => unmeasured(detector, 'NOT_ENABLED', why).outcome,
      ),
      measuredAnything: false,
    };
  }

  const findings: Finding[] = [];
  const outcomes: L10nDetectorOutcome[] = [];

  for (const detector of L10N_DETECTOR_LIST) {
    try {
      const run = DETECTOR_FUNCTIONS[detector](input);
      outcomes.push(run.outcome);
      for (const finding of run.findings) findings.push(finding);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({
        detector,
        status: 'UNMEASURED',
        reason: 'DETECTOR_FAILED',
        detail: `the ${L10N_DETECTOR_LABELS[detector]} detector failed: ${mask(message)}`,
        nodesExamined: 0,
        setAside: [],
        findings: 0,
        cappedBy: null,
      });
    }
  }

  return {
    findings,
    outcomes,
    measuredAnything: outcomes.some((outcome) => outcome.status === 'MEASURED'),
  };
}

/**
 * The UNMEASURED outcomes, as findings a human will actually see.
 *
 * MINOR on every one, deliberately: these are not defects in the customer's
 * application and must never fail their build. They exist so that a reader of a
 * findings list cannot mistake six empty detectors for six clean ones. The
 * machine-readable half is `outcomes`; this is the half somebody reads.
 */
export function unmeasuredFindings(
  route: string,
  outcomes: readonly L10nDetectorOutcome[],
  mask: (value: string) => string = (value) => value,
): Finding[] {
  return outcomes
    .filter((outcome) => outcome.status === 'UNMEASURED')
    .map((outcome) =>
      toFinding(
        {
          code: `${L10N_CODE_PREFIX}unmeasured.${outcome.detector}`,
          severity: 'MINOR',
          location: route,
          problem: `${L10N_DETECTOR_LABELS[outcome.detector]} was not measured on ${route} (${outcome.reason ?? 'no reason recorded'}): ${outcome.detail}.`,
          remedy:
            'Treat this defect class as unexamined on this route. It is not a finding about the application, and it must not be counted as a passing check.',
        },
        mask,
      ),
    );
}
