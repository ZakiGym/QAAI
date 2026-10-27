/**
 * The properties the localisation detectors live or die on:
 *
 *  1. "WE FOUND NOTHING" AND "WE LOOKED AT NOTHING" ARE DIFFERENT ANSWERS. More
 *     than half of this file is about that one sentence, because it is the only
 *     thing separating this module from the plugin it replaces — which re-ran
 *     the same spec under another locale and reported every page as clean.
 *  2. THEY DO NOT CRY WOLF. A large share of the cases here are correct pages
 *     and correct strings that must produce NOTHING: a filename, a hostname, a
 *     version number, an ambiguous date, a brand name, an ellipsis that is not
 *     firing, a parent box containing its own child. A detector with false
 *     positives is a detector somebody mutes, and the mute takes the real
 *     findings with it.
 *  3. ABSENT EVIDENCE IS NOT A ZERO. No geometry means UNMEASURED, not "nothing
 *     is clipped". An unparseable transform means UNMEASURED for that node, not
 *     "the icon did not mirror". No declared direction means UNMEASURED, not a
 *     guess from a locale table this module refuses to hold.
 *  4. EVERY CAP AND EVERY SET-ASIDE IS COUNTED. A detector that examined 2 of
 *     4,000 nodes and found nothing must say so in the same breath.
 *  5. DETERMINISM. `pseudoLocalize` has no RNG and no clock, so the same string
 *     expands identically for ever — which is what makes a baseline captured
 *     under pseudo-localization comparable at all.
 *
 * No browser anywhere in this file, which is the whole point of the injected
 * snapshot: every judgement call above is exercised in milliseconds against
 * fakes.
 */

import { describe, expect, it } from 'vitest';
import {
  L10N_CODE_PREFIX,
  L10N_DETECTORS,
  L10N_DETECTOR_LABELS,
  L10N_DETECTOR_LIST,
  L10N_UNMEASURED_REASONS,
  L10N_UNMEASURED_REASON_LABELS,
  L10N_UNMEASURED_REASON_LIST,
  LOCALE_DIRECTIONS,
  LOCALE_DIRECTION_LIST,
  MIRROR_EXPECTATIONS,
  MIRROR_EXPECTATION_LIST,
  NAME_ORDERS,
  NAME_ORDER_LIST,
  NO_EVIDENCE_UNMEASURED_REASONS,
  PSEUDO_END,
  PSEUDO_GROWTH_RATIO,
  PSEUDO_START,
  carriesPseudoAccents,
  detectFormatCorrectness,
  detectHardCodedStrings,
  detectMissingKeys,
  detectPseudoLocalization,
  detectRtlMirroring,
  detectTruncation,
  enabledL10nDetectors,
  hasHorizontalFlip,
  hasMixedDirection,
  intlLocaleFormats,
  isL10nFinding,
  isUnmeasuredL10nFinding,
  l10nDeepConfigSchema,
  l10nOutcomeProblems,
  looksLikeMessageKey,
  parseL10nDeepConfig,
  placeholdersIn,
  pseudoLocalize,
  readNumberSeparators,
  runL10nDetectors,
  unmeasuredFindings,
} from './l10n-deep.js';
import type {
  L10nBox,
  L10nDeepInput,
  L10nDetectorOutcome,
  L10nNode,
  L10nRendering,
  LocaleFormats,
} from './l10n-deep.js';

// ─── Builders ────────────────────────────────────────────────────────────────

function box(over: Partial<L10nBox> = {}): L10nBox {
  return {
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    scrollWidth: 100,
    scrollHeight: 20,
    clientWidth: 100,
    clientHeight: 20,
    ...over,
  };
}

function node(over: Partial<L10nNode> & { locator: string; text: string }): L10nNode {
  return {
    ancestors: [],
    tag: 'SPAN',
    direction: 'ltr',
    textAlign: 'start',
    unicodeBidi: 'isolate',
    transform: 'none',
    textOverflow: 'clip',
    overflowHidden: false,
    box: null,
    mirror: null,
    ...over,
  };
}

function rendering(over: Partial<L10nRendering> & { locale: string }): L10nRendering {
  return {
    direction: 'LTR',
    documentDirection: 'ltr',
    htmlLang: over.locale,
    nodes: [],
    pseudo: false,
    ...over,
  };
}

/** A config with every detector on, which is what the detector tests want. */
function allOn(over: Record<string, unknown> = {}): L10nDeepInput['config'] {
  return parseL10nDeepConfig({
    deep: {
      missingKey: true,
      pseudoLocalization: true,
      truncation: true,
      rtlMirroring: true,
      formatCorrectness: true,
      hardCodedStrings: true,
      ...over,
    },
  });
}

function input(over: Partial<L10nDeepInput> & { target: L10nRendering }): L10nDeepInput {
  return { route: '/checkout', base: null, config: allOn(), ...over };
}

/**
 * A rendering whose `nodes` read THROWS.
 *
 * Defined after construction rather than as a getter in the literal, because the
 * builder spreads its overrides and a getter in the literal fires during the
 * spread — so the test blew up before `runL10nDetectors` was ever reached, which
 * is the opposite of what it is trying to prove.
 */
function exploding(message: string): L10nRendering {
  const snapshot = rendering({ locale: 'de-DE' });
  Object.defineProperty(snapshot, 'nodes', {
    get(): readonly L10nNode[] {
      throw new Error(message);
    },
  });
  return snapshot;
}

function codes(findings: readonly { code: string }[]): string[] {
  return findings.map((finding) => finding.code);
}

// ─── Parity guards, both halves ──────────────────────────────────────────────

describe('every closed union has both halves of its parity guard', () => {
  it.each([
    ['L10N_DETECTORS', L10N_DETECTORS, L10N_DETECTOR_LIST],
    ['L10N_UNMEASURED_REASONS', L10N_UNMEASURED_REASONS, L10N_UNMEASURED_REASON_LIST],
    ['LOCALE_DIRECTIONS', LOCALE_DIRECTIONS, LOCALE_DIRECTION_LIST],
    ['MIRROR_EXPECTATIONS', MIRROR_EXPECTATIONS, MIRROR_EXPECTATION_LIST],
    ['NAME_ORDERS', NAME_ORDERS, NAME_ORDER_LIST],
  ])('%s and its derived list agree, member for member and in order', (_name, source, derived) => {
    expect([...derived]).toEqual([...source]);
  });

  it('labels every detector and every unmeasured reason, with nothing extra', () => {
    expect(Object.keys(L10N_DETECTOR_LABELS).sort()).toEqual([...L10N_DETECTORS].sort());
    expect(Object.keys(L10N_UNMEASURED_REASON_LABELS).sort()).toEqual(
      [...L10N_UNMEASURED_REASONS].sort(),
    );
  });

  it('gives every detector a config key, so none of them is unswitchable', () => {
    /*
     * THE RUN-TIME HALF, and the defect it catches. A detector in
     * `L10N_DETECTORS` with no key on `l10nDeepConfigSchema` can never be
     * switched on by any customer: `enabledL10nDetectors` reads `config[detector]`
     * and would find undefined for ever. That is exactly how eight `GateRule`
     * kinds shipped unsaveable for two slices, and the compiler cannot see it —
     * the schema's shape and the union are independent declarations.
     */
    const keys = Object.keys(l10nDeepConfigSchema.shape).filter(
      (key) => key !== 'maxNodes' && key !== 'maxFindingsPerDetector',
    );
    expect(keys.sort()).toEqual([...L10N_DETECTORS].sort());
  });

  it('keeps every unmeasured reason in the no-evidence list', () => {
    expect([...NO_EVIDENCE_UNMEASURED_REASONS].sort()).toEqual([...L10N_UNMEASURED_REASONS].sort());
  });
});

// ─── The headline: unmeasured is not clean ───────────────────────────────────

describe('a detector that did not look says so, rather than reporting a clean page', () => {
  it('reports six UNMEASURED/NOT_ENABLED outcomes for a spec with no deep block', () => {
    const config = parseL10nDeepConfig({});
    const result = runL10nDetectors(
      input({ target: rendering({ locale: 'de-DE' }), config }),
    );

    expect(result.outcomes).toHaveLength(L10N_DETECTORS.length);
    expect(result.outcomes.every((outcome) => outcome.status === 'UNMEASURED')).toBe(true);
    expect(result.outcomes.every((outcome) => outcome.reason === 'NOT_ENABLED')).toBe(true);
    expect(result.findings).toEqual([]);
    // The one boolean a coverage number may read.
    expect(result.measuredAnything).toBe(false);
  });

  it('turns those outcomes into findings a human reading a report will see', () => {
    const config = parseL10nDeepConfig({});
    const result = runL10nDetectors(input({ target: rendering({ locale: 'de-DE' }), config }));
    const surfaced = unmeasuredFindings('/checkout', result.outcomes);

    expect(surfaced).toHaveLength(L10N_DETECTORS.length);
    // MINOR on every one: these are not defects in the customer's application
    // and must never fail their build.
    expect(surfaced.every((finding) => finding.severity === 'MINOR')).toBe(true);
    expect(surfaced.every((finding) => isUnmeasuredL10nFinding(finding))).toBe(true);
    expect(surfaced.every((finding) => finding.kind === 'LOCALIZATION')).toBe(true);
    expect(surfaced[0]?.message).toContain('must not be counted as a passing check');
  });

  it('calls a locale with no translation data UNMEASURED, not free of hard-coded strings', () => {
    /*
     * THE DEFECT THIS WHOLE MODULE EXISTS FOR. Every string identical between
     * the two locales means nobody has translated anything. Every detector then
     * finds zero problems, and reporting that as "no localisation defects" is the
     * lie the product cannot afford: what was proved is that a catalogue is
     * missing.
     */
    const nodes = [
      node({ locator: '#a', text: 'Pay now', ancestors: ['#form'] }),
      node({ locator: '#b', text: 'Card number', ancestors: ['#form'] }),
    ];
    const run = detectHardCodedStrings(
      input({
        base: rendering({ locale: 'en-US', nodes }),
        target: rendering({ locale: 'de-DE', nodes }),
      }),
    );

    expect(run.outcome.status).toBe('UNMEASURED');
    expect(run.outcome.reason).toBe('NO_TRANSLATION_DATA');
    expect(run.outcome.detail).toContain('no translation data behind it');
    expect(run.findings).toEqual([]);
  });

  it('measures the same page once one sibling actually changed', () => {
    const run = detectHardCodedStrings(
      input({
        base: rendering({
          locale: 'en-US',
          nodes: [
            node({ locator: '#a', text: 'Pay now', ancestors: ['#form'] }),
            node({ locator: '#b', text: 'Card number', ancestors: ['#form'] }),
          ],
        }),
        target: rendering({
          locale: 'de-DE',
          nodes: [
            node({ locator: '#a', text: 'Jetzt bezahlen', ancestors: ['#form'] }),
            node({ locator: '#b', text: 'Card number', ancestors: ['#form'] }),
          ],
        }),
      }),
    );

    expect(run.outcome.status).toBe('MEASURED');
    expect(run.outcome.reason).toBeNull();
    expect(codes(run.findings)).toEqual([`${L10N_CODE_PREFIX}hard-coded`]);
  });

  it('refuses to report a hard-coded string whose neighbours were not translated either', () => {
    /*
     * The neighbour qualifier IS this detector's precision. An untranslated
     * REGION is one fact about a missing catalogue; a single English label inside
     * a German form is another, and only the second is a defect in one string.
     */
    const run = detectHardCodedStrings(
      input({
        base: rendering({
          locale: 'en-US',
          nodes: [
            node({ locator: '#a', text: 'Pay now', ancestors: ['#footer'] }),
            node({ locator: '#b', text: 'Jetzt bezahlen', ancestors: ['#form'] }),
          ],
        }),
        target: rendering({
          locale: 'de-DE',
          nodes: [
            node({ locator: '#a', text: 'Pay now', ancestors: ['#footer'] }),
            node({ locator: '#b', text: 'Zahlen Sie jetzt', ancestors: ['#form'] }),
          ],
        }),
      }),
    );

    expect(run.outcome.status).toBe('MEASURED');
    expect(run.findings).toEqual([]);
    expect(run.outcome.setAside.map((entry) => entry.why).join(' ')).toContain(
      'none of its siblings changed either',
    );
  });

  it('sets aside a single capitalised word rather than calling a brand name untranslated', () => {
    const run = detectHardCodedStrings(
      input({
        base: rendering({
          locale: 'en-US',
          nodes: [
            node({ locator: '#brand', text: 'Acme', ancestors: ['#bar'] }),
            node({ locator: '#b', text: 'Settings', ancestors: ['#bar'] }),
          ],
        }),
        target: rendering({
          locale: 'de-DE',
          nodes: [
            node({ locator: '#brand', text: 'Acme', ancestors: ['#bar'] }),
            node({ locator: '#b', text: 'Einstellungen', ancestors: ['#bar'] }),
          ],
        }),
      }),
    );
    expect(run.findings).toEqual([]);
    expect(run.outcome.setAside.map((entry) => entry.why).join(' ')).toContain('proper noun');
  });

  it('honours a declared do-not-translate list', () => {
    const base = rendering({
      locale: 'en-US',
      nodes: [
        node({ locator: '#a', text: 'powered by acme', ancestors: ['#bar'] }),
        node({ locator: '#b', text: 'Settings', ancestors: ['#bar'] }),
      ],
    });
    const target = rendering({
      locale: 'de-DE',
      nodes: [
        node({ locator: '#a', text: 'powered by acme', ancestors: ['#bar'] }),
        node({ locator: '#b', text: 'Einstellungen', ancestors: ['#bar'] }),
      ],
    });
    expect(codes(detectHardCodedStrings(input({ base, target })).findings)).toEqual([
      `${L10N_CODE_PREFIX}hard-coded`,
    ]);
    expect(
      detectHardCodedStrings(input({ base, target, doNotTranslate: ['powered by acme'] })).findings,
    ).toEqual([]);
  });

  it('is UNMEASURED with NO_BASE_RENDERING when only one locale was captured', () => {
    const run = detectHardCodedStrings(
      input({ target: rendering({ locale: 'de-DE', nodes: [node({ locator: '#a', text: 'x' })] }) }),
    );
    expect(run.outcome.reason).toBe('NO_BASE_RENDERING');
  });
});

describe('an outcome cannot contradict itself', () => {
  const sound: L10nDetectorOutcome = {
    detector: 'truncation',
    status: 'MEASURED',
    reason: null,
    detail: 'measured 4 nodes',
    nodesExamined: 4,
    setAside: [],
    findings: 1,
    cappedBy: null,
  };

  it('accepts a coherent one', () => {
    expect(l10nOutcomeProblems(sound)).toEqual([]);
  });

  it('refuses UNMEASURED with no reason', () => {
    expect(
      l10nOutcomeProblems({ ...sound, status: 'UNMEASURED', reason: null, findings: 0 }).join(' '),
    ).toContain('indistinguishable from a detector that found nothing');
  });

  it('refuses MEASURED carrying a reason', () => {
    expect(l10nOutcomeProblems({ ...sound, reason: 'NO_GEOMETRY' }).join(' ')).toContain(
      'says both',
    );
  });

  it('refuses findings from a detector that produced no evidence', () => {
    expect(
      l10nOutcomeProblems({
        ...sound,
        status: 'UNMEASURED',
        reason: 'NO_TRANSLATION_DATA',
        findings: 3,
      }).join(' '),
    ).toContain('a finding from a detector that did not look is a finding about nothing');
  });

  it('refuses a cap that is recorded as having bitten and lost nothing', () => {
    expect(
      l10nOutcomeProblems({
        ...sound,
        cappedBy: { cap: 'maxNodes', limit: 10, taken: 4, atLeastMore: 0, detail: 'x' },
      }).join(' '),
    ).toContain('a cap that did not bite says nothing');
  });

  it('refuses a set-aside entry with a count of zero', () => {
    expect(
      l10nOutcomeProblems({ ...sound, setAside: [{ count: 0, why: 'x' }] }).join(' '),
    ).toContain('not a set-aside');
  });

  it('holds for every outcome the runner actually produces', () => {
    const result = runL10nDetectors(
      input({
        base: rendering({
          locale: 'en-US',
          nodes: [node({ locator: '#a', text: 'Pay now', ancestors: ['#f'], box: box() })],
        }),
        target: rendering({
          locale: 'de-DE',
          nodes: [
            node({
              locator: '#a',
              text: 'Jetzt bezahlen 1.234,56',
              ancestors: ['#f'],
              box: box({ scrollWidth: 160 }),
            }),
          ],
        }),
      }),
    );
    for (const outcome of result.outcomes) expect(l10nOutcomeProblems(outcome)).toEqual([]);
  });

  it('never lets the finding count disagree with the finding list', () => {
    const nodes = Array.from({ length: 6 }, (_, index) =>
      node({ locator: `#n${index}`, text: `checkout.label.${index === 0 ? 'ab' : 'cd'}` }),
    );
    const config = allOn({ maxFindingsPerDetector: 2 });
    const run = detectMissingKeys(input({ target: rendering({ locale: 'de-DE', nodes }), config }));
    expect(run.findings).toHaveLength(run.outcome.findings);
    expect(run.outcome.cappedBy?.cap).toBe('maxFindingsPerDetector');
    expect(run.outcome.cappedBy?.atLeastMore).toBe(4);
  });

  it('reports a node cap as a count and a reason, preferring it over the finding cap', () => {
    const nodes = Array.from({ length: 5 }, (_, index) =>
      node({ locator: `#n${index}`, text: 'checkout.button.pay' }),
    );
    const config = allOn({ maxNodes: 2, maxFindingsPerDetector: 1 });
    const run = detectMissingKeys(input({ target: rendering({ locale: 'de-DE', nodes }), config }));
    expect(run.outcome.cappedBy?.cap).toBe('maxNodes');
    expect(run.outcome.cappedBy?.atLeastMore).toBe(3);
    expect(run.outcome.cappedBy?.detail).toContain('a prefix of the page and not the page');
  });
});

describe('a deep block that cannot be read is reported, not obeyed', () => {
  it('files one config finding and claims nothing about any detector', () => {
    const config = parseL10nDeepConfig({ deep: { maxNodes: -4 } });
    expect(config.configError).not.toBeNull();

    const result = runL10nDetectors(input({ target: rendering({ locale: 'de-DE' }), config }));
    expect(codes(result.findings)).toEqual([`${L10N_CODE_PREFIX}unmeasured.config`]);
    expect(result.measuredAnything).toBe(false);
    expect(result.outcomes).toHaveLength(L10N_DETECTORS.length);
  });

  it('reads the shorthand and the object form the same way', () => {
    expect(enabledL10nDetectors(parseL10nDeepConfig({ deep: { truncation: true } }))).toEqual([
      'truncation',
    ]);
    expect(
      enabledL10nDetectors(parseL10nDeepConfig({ deep: { truncation: { tolerancePx: 4 } } })),
    ).toEqual(['truncation']);
    expect(enabledL10nDetectors(parseL10nDeepConfig({ deep: { truncation: false } }))).toEqual([]);
  });
});

// ─── Pseudo-localization ─────────────────────────────────────────────────────

describe('pseudoLocalize', () => {
  it('is byte-identical for the same input, with no RNG and no clock', () => {
    const once = pseudoLocalize('Checkout now');
    const twice = pseudoLocalize('Checkout now');
    expect(once).toBe(twice);
    /*
     * Pinned, because "deterministic" that nobody wrote down drifts on the first
     * refactor of the accent table. The filler sits INSIDE the closing sentinel,
     * which is the property the clip detector reads: a container that cuts the
     * string loses the padding and the bracket together, in that order.
     */
    expect(once).toBe('⟦Ćĥéćķóúţ ñóŵ·····⟧');
  });

  it('grows by the standard ratio, counted over LETTERS and not over the whole string', () => {
    /*
     * `{count} items` has five letters outside the token. Padding on the token's
     * length would inflate a short label by the width of a variable name and
     * report a truncation the application does not have.
     */
    const grown = pseudoLocalize('{count} items');
    expect(grown).toContain('{count}');
    expect(grown.match(/·/g) ?? []).toHaveLength(Math.ceil(5 * PSEUDO_GROWTH_RATIO));
  });

  it('copies every placeholder family through byte for byte', () => {
    for (const token of ['{{name}}', '${name}', '%(name)s', '%1$s', '{name}', '%s']) {
      const source = `Hello ${token} welcome`;
      const grown = pseudoLocalize(source);
      expect(grown).toContain(token);
      // The surrounding words ARE transformed, so this is not a no-op pass.
      expect(grown).not.toContain('Hello');
    }
  });

  it('leaves digits and punctuation alone, so it cannot forge a format defect', () => {
    const grown = pseudoLocalize('Total: 1.234,56 EUR');
    expect(grown).toContain('1.234,56');
  });

  it('brackets the string so a clip is visible with no geometry at all', () => {
    const grown = pseudoLocalize('Save');
    expect(grown.startsWith(PSEUDO_START)).toBe(true);
    expect(grown.endsWith(PSEUDO_END)).toBe(true);
    expect(pseudoLocalize('Save', { bracket: false }).startsWith(PSEUDO_START)).toBe(false);
  });

  it('returns an empty string untouched rather than a pair of empty brackets', () => {
    expect(pseudoLocalize('')).toBe('');
  });
});

describe('carriesPseudoAccents answers three ways, and the third one matters', () => {
  it('is true for an accented string and false for a plain one', () => {
    expect(carriesPseudoAccents('Ćĥéćķóúţ')).toBe(true);
    expect(carriesPseudoAccents('Checkout')).toBe(false);
  });

  it('is NULL for text with no letters, which is not evidence either way', () => {
    // Every number, separator and icon glyph on the page is in this category. A
    // detector reading them as `false` would file one finding per price.
    expect(carriesPseudoAccents('1.234,56')).toBeNull();
    expect(carriesPseudoAccents('→')).toBeNull();
  });
});

describe('the pseudo-localization detector', () => {
  const pseudo = (nodes: readonly L10nNode[]): L10nRendering =>
    rendering({ locale: 'qps-ploc', nodes, pseudo: true });

  it('is UNMEASURED when no pseudo rendering was captured', () => {
    const run = detectPseudoLocalization(input({ target: rendering({ locale: 'de-DE' }) }));
    expect(run.outcome.reason).toBe('NO_PSEUDO_RENDERING');
  });

  it('refuses a rendering handed to it that is not marked as pseudo', () => {
    const run = detectPseudoLocalization(
      input({
        target: rendering({ locale: 'de-DE' }),
        pseudoRendering: rendering({
          locale: 'qps-ploc',
          nodes: [node({ locator: '#a', text: '⟦Śáṽé⟧··' })],
        }),
      }),
    );
    expect(run.outcome.reason).toBe('NO_PSEUDO_RENDERING');
    expect(run.outcome.detail).toContain('not marked as pseudo');
  });

  it('calls a page where nothing was accented a configuration fact, not a page of literals', () => {
    /*
     * The single worst thing this detector could do. A page the pseudo locale
     * never reached has NOTHING accented, so every node would be reported as a
     * hard-coded literal: one finding per element, all of them wrong, from a
     * detector that proved only that its own input was broken.
     */
    const run = detectPseudoLocalization(
      input({
        target: rendering({ locale: 'de-DE' }),
        pseudoRendering: pseudo([
          node({ locator: '#a', text: 'Save' }),
          node({ locator: '#b', text: 'Cancel' }),
        ]),
      }),
    );
    expect(run.outcome.status).toBe('UNMEASURED');
    expect(run.outcome.reason).toBe('NO_TRANSLATION_DATA');
    expect(run.findings).toEqual([]);
  });

  it('finds a clipped string from TEXT ALONE, with no box metrics anywhere', () => {
    const run = detectPseudoLocalization(
      input({
        target: rendering({ locale: 'de-DE' }),
        pseudoRendering: pseudo([
          node({ locator: '#ok', text: '⟦Śáṽé⟧··' }),
          node({ locator: '#clipped', text: '⟦Ćóñţíñúé ţó ƥáý' }),
        ]),
      }),
    );
    expect(codes(run.findings)).toEqual([`${L10N_CODE_PREFIX}pseudo.clipped`]);
    expect(run.findings[0]?.location).toBe('#clipped');
    expect(run.findings[0]?.severity).toBe('SERIOUS');
    // Nothing in the snapshot carried a box; this is the property that makes the
    // detector work where the truncation one must refuse.
    expect(run.outcome.status).toBe('MEASURED');
  });

  it('finds a hard-coded literal with no second locale at all', () => {
    const run = detectPseudoLocalization(
      input({
        target: rendering({ locale: 'de-DE' }),
        pseudoRendering: pseudo([
          node({ locator: '#ok', text: '⟦Śáṽé⟧··' }),
          node({ locator: '#literal', text: 'Hard coded label' }),
        ]),
      }),
    );
    expect(codes(run.findings)).toEqual([`${L10N_CODE_PREFIX}pseudo.not-localized`]);
    expect(run.findings[0]?.location).toBe('#literal');
  });

  it('sets aside a letterless node rather than reporting every price as a literal', () => {
    const run = detectPseudoLocalization(
      input({
        target: rendering({ locale: 'de-DE' }),
        pseudoRendering: pseudo([
          node({ locator: '#ok', text: '⟦Ţóţáĺ⟧··' }),
          node({ locator: '#price', text: '1.234,56' }),
        ]),
      }),
    );
    expect(run.findings).toEqual([]);
    expect(run.outcome.setAside.map((entry) => entry.why).join(' ')).toContain('no letters');
  });

  it('reports a placeholder the expansion damaged', () => {
    const run = detectPseudoLocalization(
      input({
        target: rendering({ locale: 'de-DE' }),
        pseudoRendering: pseudo([node({ locator: '#a', text: '⟦Ĥéĺĺó {ñáɱé}⟧····' })]),
      }),
    );
    expect(codes(run.findings)).toEqual([`${L10N_CODE_PREFIX}pseudo.placeholder-mangled`]);
  });

  it('says nothing about an intact placeholder, which is the expansion working', () => {
    const run = detectPseudoLocalization(
      input({
        target: rendering({ locale: 'de-DE' }),
        pseudoRendering: pseudo([node({ locator: '#a', text: pseudoLocalize('Hello {name}') })]),
      }),
    );
    expect(run.findings).toEqual([]);
  });
});

// ─── Missing keys ────────────────────────────────────────────────────────────

describe('looksLikeMessageKey does not cry wolf', () => {
  it.each([
    'checkout.button.pay',
    'errors.payment.declined',
    'nav_bar.items.settings',
  ])('accepts %s', (text) => {
    expect(looksLikeMessageKey(text)).not.toBeNull();
  });

  it.each([
    ['logo.svg', 'a filename'],
    ['README.md', 'a filename in another case'],
    ['example.com', 'a hostname'],
    ['api.staging.dev', 'a hostname with a subdomain'],
    ['2.11.4', 'a version'],
    ['1.5', 'a decimal'],
    ['e.g.', 'an abbreviation'],
    ['U.S.A.', 'an initialism'],
    // Single-character segments, which is what MIN_KEY_SEGMENT is actually for:
    // the trailing-dot forms above are refused by the anchored pattern instead.
    ['U.S', 'an initialism with no trailing dot'],
    ['i.e', 'an abbreviation with no trailing dot'],
    ['a.b', 'two single-character segments'],
    ['Pay now.', 'a sentence'],
    ['hello@example.org', 'an email'],
    ['https://x.test/a', 'a URL'],
    ['no dots here', 'ordinary prose'],
    ['...', 'punctuation'],
  ])('rejects %s (%s)', (text) => {
    expect(looksLikeMessageKey(text)).toBeNull();
  });
});

describe('placeholdersIn', () => {
  it('prefers the longest form, so {{name}} is one token and not three', () => {
    expect(placeholdersIn('Hi {{name}}').map((found) => found.token)).toEqual(['{{name}}']);
    expect(placeholdersIn('Hi ${name}').map((found) => found.token)).toEqual(['${name}']);
  });

  it('returns them in document order and never overlapping', () => {
    expect(placeholdersIn('%s then {count} then %2$s').map((found) => found.token)).toEqual([
      '%s',
      '{count}',
      '%2$s',
    ]);
  });

  it('does not carry regex state between calls', () => {
    // A module-level /g literal shares `lastIndex` across every caller, so two
    // detectors scanning the same text would each start where the other stopped.
    expect(placeholdersIn('{a}')).toHaveLength(1);
    expect(placeholdersIn('{a}')).toHaveLength(1);
  });
});

describe('the missing-key detector', () => {
  it('separates a CONFIRMED key from a key-SHAPED guess, in code and in severity', () => {
    const nodes = [node({ locator: '#pay', text: 'checkout.button.pay' })];
    const confirmed = detectMissingKeys(
      input({
        target: rendering({ locale: 'de-DE', nodes }),
        catalogueKeys: ['checkout.button.pay'],
      }),
    );
    expect(codes(confirmed.findings)).toEqual([`${L10N_CODE_PREFIX}missing-key`]);
    expect(confirmed.findings[0]?.severity).toBe('SERIOUS');

    const guessed = detectMissingKeys(input({ target: rendering({ locale: 'de-DE', nodes }) }));
    expect(codes(guessed.findings)).toEqual([`${L10N_CODE_PREFIX}key-shaped-text`]);
    expect(guessed.findings[0]?.severity).toBe('MODERATE');
    expect(guessed.findings[0]?.message).toContain('heuristic');
  });

  it('says nothing about key-shaped text the supplied catalogue does not hold', () => {
    const run = detectMissingKeys(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [node({ locator: '#id', text: 'order.ref.a1b2' })],
        }),
        catalogueKeys: ['checkout.button.pay'],
      }),
    );
    expect(run.findings).toEqual([]);
    expect(run.outcome.setAside.map((entry) => entry.why).join(' ')).toContain(
      "the application's own content",
    );
  });

  it('reports an uninterpolated token as SERIOUS', () => {
    const run = detectMissingKeys(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [node({ locator: '#hi', text: 'Hallo {{name}}' })],
        }),
      }),
    );
    expect(codes(run.findings)).toEqual([`${L10N_CODE_PREFIX}unrendered-token`]);
    expect(run.findings[0]?.severity).toBe('SERIOUS');
  });

  it('leaves a <code> block alone, where braces and dotted names are content', () => {
    const run = detectMissingKeys(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [node({ locator: 'pre', tag: 'PRE', text: '{"key": "checkout.button.pay"}' })],
        }),
      }),
    );
    expect(run.findings).toEqual([]);
    expect(run.outcome.setAside.map((entry) => entry.why).join(' ')).toContain('<pre>');
  });

  it('is UNMEASURED with NO_NODES on an empty snapshot', () => {
    expect(detectMissingKeys(input({ target: rendering({ locale: 'de-DE' }) })).outcome.reason).toBe(
      'NO_NODES',
    );
  });

  it('masks a finding, because page text can carry an interpolated secret', () => {
    const run = detectMissingKeys(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [node({ locator: '#t', text: 'Hallo {{name}} swordfish' })],
        }),
        mask: (value) => value.replace(/swordfish/g, '***'),
      }),
    );
    expect(run.findings[0]?.message).toContain('***');
    expect(run.findings[0]?.message).not.toContain('swordfish');
  });
});

// ─── Truncation ──────────────────────────────────────────────────────────────

describe('the truncation detector', () => {
  it('is UNMEASURED with NO_GEOMETRY when nothing carried a box', () => {
    const run = detectTruncation(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [node({ locator: '#a', text: 'Jetzt bezahlen' })],
        }),
      }),
    );
    expect(run.outcome.status).toBe('UNMEASURED');
    expect(run.outcome.reason).toBe('NO_GEOMETRY');
    expect(run.outcome.detail).toContain('says nothing about whether the page truncates');
  });

  it('reports a clipped overflow with no ellipsis as SERIOUS', () => {
    const run = detectTruncation(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [
            node({
              locator: '#h',
              text: 'Zahlungsinformationen',
              overflowHidden: true,
              box: box({ scrollWidth: 240, clientWidth: 100 }),
            }),
          ],
        }),
      }),
    );
    expect(codes(run.findings)).toEqual([`${L10N_CODE_PREFIX}truncated`]);
    expect(run.findings[0]?.severity).toBe('SERIOUS');
    expect(run.findings[0]?.message).toContain('140px');
  });

  it('reports an ellipsis that is FIRING, and says nothing about one that is not', () => {
    const firing = detectTruncation(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [
            node({
              locator: '#cell',
              text: 'Zahlungsinformationen',
              textOverflow: 'ellipsis',
              overflowHidden: true,
              box: box({ scrollWidth: 160, clientWidth: 100 }),
            }),
          ],
        }),
      }),
    );
    expect(codes(firing.findings)).toEqual([`${L10N_CODE_PREFIX}ellipsised`]);

    // Styled for an ellipsis and not overflowing: the application working as
    // designed. A detector that reported this would be reporting the design.
    const quiet = detectTruncation(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [
            node({
              locator: '#cell',
              text: 'Kurz',
              textOverflow: 'ellipsis',
              overflowHidden: true,
              box: box(),
            }),
          ],
        }),
      }),
    );
    expect(quiet.findings).toEqual([]);
  });

  it('absorbs sub-pixel rounding, which would otherwise fire on every line of text', () => {
    const run = detectTruncation(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [
            node({
              locator: '#a',
              text: 'Jetzt bezahlen',
              overflowHidden: true,
              box: box({ scrollWidth: 100.6, clientWidth: 100 }),
            }),
          ],
        }),
      }),
    );
    expect(run.findings).toEqual([]);
  });

  it('reports a vertical clip, which hides whole lines rather than a word', () => {
    const run = detectTruncation(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [
            node({
              locator: '#p',
              text: 'Ein langer Absatz',
              overflowHidden: true,
              box: box({ scrollHeight: 80, clientHeight: 20 }),
            }),
          ],
        }),
      }),
    );
    expect(codes(run.findings)).toEqual([`${L10N_CODE_PREFIX}truncated`]);
    expect(run.findings[0]?.message).toContain('taller');
  });

  it('reports two overlapping siblings and NEVER a parent over its own child', () => {
    const parent = node({
      locator: '#row',
      text: 'Jetzt bezahlen',
      box: box({ width: 300, height: 40 }),
    });
    const child = node({
      locator: '#label',
      text: 'Jetzt',
      ancestors: ['#row'],
      box: box({ width: 120, height: 20 }),
    });
    const quiet = detectTruncation(
      input({ target: rendering({ locale: 'de-DE', nodes: [parent, child] }) }),
    );
    expect(quiet.findings).toEqual([]);

    const sibling = node({
      locator: '#other',
      text: 'Abbrechen',
      ancestors: ['#row'],
      box: box({ x: 60, width: 120, height: 20 }),
    });
    const loud = detectTruncation(
      input({ target: rendering({ locale: 'de-DE', nodes: [child, sibling] }) }),
    );
    expect(codes(loud.findings)).toEqual([`${L10N_CODE_PREFIX}overlap`]);
    expect(loud.findings[0]?.location).toBe('#label over #other');
  });

  it('measures the nodes that have boxes and COUNTS the ones that do not', () => {
    const run = detectTruncation(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [
            node({ locator: '#a', text: 'ok', box: box() }),
            node({ locator: '#b', text: 'no box' }),
            node({ locator: '#c', text: 'no box either' }),
          ],
        }),
      }),
    );
    expect(run.outcome.status).toBe('MEASURED');
    expect(run.outcome.nodesExamined).toBe(1);
    expect(run.outcome.setAside).toEqual([
      { count: 2, why: 'no box metrics collected for this node, so it was not measured' },
    ]);
  });
});

// ─── Right-to-left mirroring ─────────────────────────────────────────────────

describe('hasHorizontalFlip answers three ways', () => {
  it.each([
    ['matrix(-1, 0, 0, 1, 0, 0)', true],
    ['matrix(1, 0, 0, 1, 0, 0)', false],
    ['matrix3d(-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)', true],
    ['scaleX(-1)', true],
    ['scale(-1, 1)', true],
    ['none', false],
    ['', false],
  ])('reads %s as %s', (transform, expected) => {
    expect(hasHorizontalFlip(transform)).toBe(expected);
  });

  it('is NULL for an unparseable transform and for one that was not collected', () => {
    // A transform this parser cannot read is NOT evidence that an icon failed to
    // mirror. Reading it as `false` would file a finding on a measurement we
    // never made.
    expect(hasHorizontalFlip('rotate3d(1, 1, 1, 45deg) perspective(4px)')).toBeNull();
    expect(hasHorizontalFlip(null)).toBeNull();
  });
});

describe('hasMixedDirection', () => {
  it('is true only when BOTH a strong RTL and a strong LTR run are present', () => {
    expect(hasMixedDirection('رقم الطلب ABC-123')).toBe(true);
    expect(hasMixedDirection('رقم الطلب')).toBe(false);
    expect(hasMixedDirection('Order ABC-123')).toBe(false);
  });

  it('treats digits as neutral, so an Arabic price is not "mixed"', () => {
    expect(hasMixedDirection('المجموع ١٢٣')).toBe(false);
    expect(hasMixedDirection('المجموع 123')).toBe(false);
  });
});

describe('the right-to-left detector', () => {
  const arabic = (over: Partial<L10nRendering> = {}): L10nRendering =>
    rendering({ locale: 'ar-EG', direction: 'RTL', documentDirection: 'rtl', ...over });

  it('is UNMEASURED when nobody declared the direction, and holds no locale table', () => {
    const run = detectRtlMirroring(
      input({
        target: rendering({
          locale: 'ar-EG',
          direction: null,
          nodes: [node({ locator: '#a', text: 'مرحبا' })],
        }),
      }),
    );
    expect(run.outcome.status).toBe('UNMEASURED');
    expect(run.outcome.reason).toBe('NO_DIRECTION_DECLARED');
    expect(run.outcome.detail).toContain('no table of right-to-left languages on purpose');
  });

  it('files the unmirrored document as the one CRITICAL finding in the module', () => {
    const run = detectRtlMirroring(
      input({
        target: arabic({
          documentDirection: 'ltr',
          nodes: [node({ locator: '#a', text: 'مرحبا', direction: 'rtl' })],
        }),
      }),
    );
    const document = run.findings.find(
      (finding) => finding.code === `${L10N_CODE_PREFIX}rtl.document-direction`,
    );
    expect(document?.severity).toBe('CRITICAL');
    expect(document?.message).toContain('every string-level check passes on a page in this state');
  });

  it('says nothing at all about a correctly mirrored Arabic page', () => {
    const run = detectRtlMirroring(
      input({
        base: rendering({
          locale: 'en-US',
          nodes: [node({ locator: '#a', text: 'Order', textAlign: 'left' })],
        }),
        target: arabic({
          nodes: [
            node({
              locator: '#a',
              text: 'الطلب',
              direction: 'rtl',
              textAlign: 'right',
              mirror: null,
            }),
          ],
        }),
      }),
    );
    expect(run.findings).toEqual([]);
  });

  it('reports an RTL run trapped in a left-to-right box', () => {
    const run = detectRtlMirroring(
      input({
        target: arabic({
          nodes: [node({ locator: '#a', text: 'مرحبا', direction: 'ltr' })],
        }),
      }),
    );
    expect(codes(run.findings)).toContain(`${L10N_CODE_PREFIX}rtl.node-direction`);
  });

  it('needs two renderings to tell a physical text-align from a logical one', () => {
    const nodes = [node({ locator: '#a', text: 'الطلب', direction: 'rtl', textAlign: 'left' })];
    const alone = detectRtlMirroring(input({ target: arabic({ nodes }) }));
    expect(codes(alone.findings)).not.toContain(`${L10N_CODE_PREFIX}rtl.physical-alignment`);
    expect(alone.outcome.setAside.map((entry) => entry.why).join(' ')).toContain(
      'they compute to the same string',
    );

    const physical = detectRtlMirroring(
      input({
        base: rendering({
          locale: 'en-US',
          nodes: [node({ locator: '#a', text: 'Order', textAlign: 'left' })],
        }),
        target: arabic({ nodes }),
      }),
    );
    expect(codes(physical.findings)).toContain(`${L10N_CODE_PREFIX}rtl.physical-alignment`);

    // `left` then `right` is `start` resolving twice: authored logically, correct.
    const logical = detectRtlMirroring(
      input({
        base: rendering({
          locale: 'en-US',
          nodes: [node({ locator: '#a', text: 'Order', textAlign: 'left' })],
        }),
        target: arabic({
          nodes: [node({ locator: '#a', text: 'الطلب', direction: 'rtl', textAlign: 'right' })],
        }),
      }),
    );
    expect(codes(logical.findings)).not.toContain(`${L10N_CODE_PREFIX}rtl.physical-alignment`);
  });

  it('reports both halves of the icon pair, and neither without a declaration', () => {
    const undeclared = detectRtlMirroring(
      input({
        target: arabic({
          nodes: [node({ locator: '#icon', text: '', direction: 'rtl', transform: 'none' })],
        }),
      }),
    );
    expect(undeclared.findings).toEqual([]);
    expect(undeclared.outcome.setAside.map((entry) => entry.why).join(' ')).toContain(
      'a back arrow must mirror and a clock face must not',
    );

    const notMirrored = detectRtlMirroring(
      input({
        target: arabic({
          nodes: [
            node({
              locator: '#back',
              text: '',
              direction: 'rtl',
              transform: 'none',
              mirror: 'MUST_MIRROR',
            }),
          ],
        }),
      }),
    );
    expect(codes(notMirrored.findings)).toEqual([`${L10N_CODE_PREFIX}rtl.icon-not-mirrored`]);

    const wronglyMirrored = detectRtlMirroring(
      input({
        target: arabic({
          nodes: [
            node({
              locator: '#logo',
              text: '',
              direction: 'rtl',
              transform: 'matrix(-1, 0, 0, 1, 0, 0)',
              mirror: 'MUST_NOT_MIRROR',
            }),
          ],
        }),
      }),
    );
    expect(codes(wronglyMirrored.findings)).toEqual([
      `${L10N_CODE_PREFIX}rtl.icon-wrongly-mirrored`,
    ]);
  });

  it('reports mixed-direction text with no isolation, and accepts it with', () => {
    const loud = detectRtlMirroring(
      input({
        target: arabic({
          nodes: [
            node({
              locator: '#ref',
              text: 'رقم الطلب ABC-123',
              direction: 'rtl',
              unicodeBidi: 'normal',
            }),
          ],
        }),
      }),
    );
    expect(codes(loud.findings)).toContain(`${L10N_CODE_PREFIX}rtl.bidi-not-isolated`);

    const quiet = detectRtlMirroring(
      input({
        target: arabic({
          nodes: [
            node({
              locator: '#ref',
              text: 'رقم الطلب ABC-123',
              direction: 'rtl',
              unicodeBidi: 'isolate',
            }),
          ],
        }),
      }),
    );
    expect(codes(quiet.findings)).not.toContain(`${L10N_CODE_PREFIX}rtl.bidi-not-isolated`);
  });

  it('checks nothing directional on a left-to-right locale', () => {
    const run = detectRtlMirroring(
      input({
        target: rendering({
          locale: 'de-DE',
          direction: 'LTR',
          nodes: [node({ locator: '#a', text: 'Zahlen', textAlign: 'left' })],
        }),
      }),
    );
    expect(run.outcome.status).toBe('MEASURED');
    expect(run.findings).toEqual([]);
  });
});

// ─── Format correctness ──────────────────────────────────────────────────────

describe('readNumberSeparators refuses the ambiguous cases, which is most of them', () => {
  it('resolves a token carrying BOTH separators', () => {
    expect(readNumberSeparators('1.234,56')).toEqual({
      token: '1.234,56',
      decimal: ',',
      group: '.',
    });
    expect(readNumberSeparators('1,234.56')).toEqual({
      token: '1,234.56',
      decimal: '.',
      group: ',',
    });
  });

  it('is NULL for a three-digit tail, which is a group in one locale and a fraction in another', () => {
    // `1.234` is one thousand two hundred and thirty-four in German and one point
    // two three four in English. Picking one would report half the correct pages
    // in the world as defective.
    expect(readNumberSeparators('1.234')).toBeNull();
    expect(readNumberSeparators('1,234')).toBeNull();
  });

  it('resolves a tail that cannot be a thousands group', () => {
    expect(readNumberSeparators('1,23')?.decimal).toBe(',');
    expect(readNumberSeparators('12.5')?.decimal).toBe('.');
  });

  it('is NULL for a bare integer and for a malformed tail', () => {
    expect(readNumberSeparators('1234')).toBeNull();
    expect(readNumberSeparators('1.2a')).toBeNull();
  });
});

describe('intlLocaleFormats is honest about a fallback', () => {
  it('reads real separators for a locale ICU has', () => {
    const german = intlLocaleFormats('de-DE');
    expect(german?.decimalSeparator).toBe(',');
    expect(german?.groupSeparator).toBe('.');
    expect(german?.dateOrder).toBe('DMY');
  });

  it('returns NULL when ICU resolved a different language', () => {
    /*
     * `Intl` falls back silently: asked for a pseudo-locale it hands back en-US
     * formats without complaint. Comparing a rendering against a fallback's
     * formats would report the application as wrong for matching the locale
     * nobody asked for.
     */
    expect(intlLocaleFormats('qps-ploc')).toBeNull();
    expect(intlLocaleFormats('not a locale at all')).toBeNull();
  });
});

describe('the format detector', () => {
  const german: LocaleFormats = {
    resolved: 'de-DE',
    decimalSeparator: ',',
    groupSeparator: '.',
    currencySymbolFirst: false,
    dateOrder: 'DMY',
    dateSeparator: '.',
  };

  it('is UNMEASURED when ICU has no data for the locale', () => {
    const run = detectFormatCorrectness(
      input({
        target: rendering({ locale: 'xx-YY', nodes: [node({ locator: '#a', text: '1,5' })] }),
        formats: () => null,
      }),
    );
    expect(run.outcome.status).toBe('UNMEASURED');
    expect(run.outcome.reason).toBe('LOCALE_NOT_SUPPORTED_BY_ICU');
  });

  it('reports a decimal separator from the wrong locale', () => {
    const run = detectFormatCorrectness(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [node({ locator: '#total', text: 'Summe 1,234.56' })],
        }),
        formats: () => german,
      }),
    );
    expect(codes(run.findings)).toContain(`${L10N_CODE_PREFIX}format.decimal-separator`);
    expect(run.findings[0]?.severity).toBe('SERIOUS');
  });

  it('says nothing about a correctly formatted German number', () => {
    const run = detectFormatCorrectness(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [node({ locator: '#total', text: 'Summe 1.234,56' })],
        }),
        formats: () => german,
      }),
    );
    expect(run.findings).toEqual([]);
  });

  it('reports a date in the wrong order, and sets aside one that cannot be decided', () => {
    const wrong = detectFormatCorrectness(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [node({ locator: '#d', text: 'Fällig 1987-06-05' })],
        }),
        formats: () => german,
      }),
    );
    expect(codes(wrong.findings)).toContain(`${L10N_CODE_PREFIX}format.date-order`);

    const undecidable = detectFormatCorrectness(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [node({ locator: '#d', text: 'Fällig 05.06.1987' })],
        }),
        formats: () => german,
      }),
    );
    expect(codes(undecidable.findings)).not.toContain(`${L10N_CODE_PREFIX}format.date-order`);
    expect(undecidable.outcome.setAside.map((entry) => entry.why).join(' ')).toContain(
      'guessing would report half the correct pages in the world',
    );
  });

  it('reports a currency symbol on the wrong side', () => {
    const run = detectFormatCorrectness(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [node({ locator: '#p', text: '€12,34' })],
        }),
        formats: () => german,
      }),
    );
    expect(codes(run.findings)).toContain(`${L10N_CODE_PREFIX}format.currency-position`);
  });

  it('sets the name-order sub-check aside rather than inventing a locale table', () => {
    const run = detectFormatCorrectness(
      input({
        target: rendering({
          locale: 'ja-JP',
          nodes: [node({ locator: '#n', text: 'Taro Yamada' })],
        }),
        formats: () => german,
        nameFields: [{ locator: '#n', given: 'Taro', family: 'Yamada' }],
      }),
    );
    expect(codes(run.findings)).not.toContain(`${L10N_CODE_PREFIX}format.name-order`);
    expect(run.outcome.setAside.map((entry) => entry.why).join(' ')).toContain(
      'no family-name-first locale table on purpose',
    );
  });

  it('reports the name order once the expectation is declared', () => {
    const run = detectFormatCorrectness(
      input({
        target: rendering({
          locale: 'ja-JP',
          nodes: [node({ locator: '#n', text: 'Taro Yamada' })],
        }),
        formats: () => german,
        nameOrder: 'FAMILY_FIRST',
        nameFields: [{ locator: '#n', given: 'Taro', family: 'Yamada' }],
      }),
    );
    expect(codes(run.findings)).toContain(`${L10N_CODE_PREFIX}format.name-order`);

    const correct = detectFormatCorrectness(
      input({
        target: rendering({
          locale: 'ja-JP',
          nodes: [node({ locator: '#n', text: 'Yamada Taro' })],
        }),
        formats: () => german,
        nameOrder: 'FAMILY_FIRST',
        nameFields: [{ locator: '#n', given: 'Taro', family: 'Yamada' }],
      }),
    );
    expect(codes(correct.findings)).not.toContain(`${L10N_CODE_PREFIX}format.name-order`);
  });
});

// ─── The runner ──────────────────────────────────────────────────────────────

describe('runL10nDetectors', () => {
  it('produces one outcome per detector and never throws when one fails', () => {
    const result = runL10nDetectors(input({ target: exploding('snapshot is corrupt') }));

    expect(result.outcomes).toHaveLength(L10N_DETECTORS.length);
    /*
     * The four detectors that read the snapshot report DETECTOR_FAILED with the
     * message. The other two never get that far — pseudoLocalization has no
     * pseudo rendering and hardCodedStrings has no base — and they report their
     * own reasons, which is the point: a detector that could not look says WHY it
     * could not, and "the input exploded" and "there was no second rendering" are
     * not the same sentence.
     */
    const failed = result.outcomes
      .filter((outcome) => outcome.reason === 'DETECTOR_FAILED')
      .map((outcome) => outcome.detector);
    expect(failed).toEqual(['missingKey', 'truncation', 'rtlMirroring', 'formatCorrectness']);
    expect(result.outcomes.every((outcome) => outcome.status === 'UNMEASURED')).toBe(true);
    expect(result.measuredAnything).toBe(false);
    expect(result.findings).toEqual([]);
    for (const outcome of result.outcomes) expect(l10nOutcomeProblems(outcome)).toEqual([]);
    expect(
      result.outcomes.find((outcome) => outcome.detector === 'missingKey')?.detail,
    ).toContain('snapshot is corrupt');
  });

  it('masks a detector failure message, which can carry page or config text', () => {
    const result = runL10nDetectors(
      input({
        target: exploding('token swordfish rejected'),
        mask: (value) => value.replace(/swordfish/g, '***'),
      }),
    );
    const detail = result.outcomes.find((outcome) => outcome.detector === 'missingKey')?.detail;
    expect(detail).toContain('***');
    expect(detail).not.toContain('swordfish');
  });

  it('marks everything it emits as a localisation finding under one prefix', () => {
    const result = runL10nDetectors(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [node({ locator: '#a', text: 'checkout.button.pay', box: box() })],
        }),
      }),
    );
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.every((finding) => isL10nFinding(finding))).toBe(true);
    expect(result.findings.every((finding) => finding.kind === 'LOCALIZATION')).toBe(true);
    expect(result.findings.every((finding) => finding.helpUrl === null)).toBe(true);
  });

  it('is MEASURED overall as soon as one detector looked at something', () => {
    const result = runL10nDetectors(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [node({ locator: '#a', text: 'Jetzt bezahlen', box: box() })],
        }),
        config: parseL10nDeepConfig({ deep: { truncation: true } }),
      }),
    );
    expect(result.measuredAnything).toBe(true);
    const measured = result.outcomes.filter((outcome) => outcome.status === 'MEASURED');
    expect(measured.map((outcome) => outcome.detector)).toEqual(['truncation']);
  });

  it('escapes a newline out of quoted page text, so a finding cannot forge a log line', () => {
    const result = runL10nDetectors(
      input({
        target: rendering({
          locale: 'de-DE',
          nodes: [node({ locator: '#a', text: 'Hallo {{name}}\n[ERROR] forged' })],
        }),
      }),
    );
    const finding = result.findings.find(
      (candidate) => candidate.code === `${L10N_CODE_PREFIX}unrendered-token`,
    );
    expect(finding).toBeDefined();
    expect(finding?.message).not.toContain('\n');
  });
});
