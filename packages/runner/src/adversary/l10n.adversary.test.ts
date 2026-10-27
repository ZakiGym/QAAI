/**
 * ADVERSARIAL COUNTER-TESTS, written against the plugin rather than with it.
 *
 * Each one is an attempt to MAKE the plugin report a pass it did not earn,
 * built from a fixture the colocated suite does not hold. Where a sweep over a
 * whole exported union was possible it is done that way rather than over the
 * members somebody remembered to list: that is what makes a new member
 * un-passable by default instead of un-passable by review.
 */
import { describe, expect, it } from 'vitest';
import {
  runL10nDetectors,
  detectMissingKeys,
  detectPseudoLocalization,
  parseL10nDeepConfig,
  l10nOutcomeProblems,
  pseudoLocalize,
  PSEUDO_START,
  PSEUDO_END,
  L10N_DETECTOR_LIST,
  NO_EVIDENCE_UNMEASURED_REASONS,
  unmeasuredFindings,
  type L10nDeepInput,
  type L10nNode,
  type L10nRendering,
} from '../l10n-deep.js';

function node(partial: Partial<L10nNode> & { locator: string; text: string }): L10nNode {
  return {
    ancestors: [],
    tag: 'DIV',
    direction: null,
    textAlign: null,
    unicodeBidi: null,
    transform: null,
    textOverflow: null,
    overflowHidden: null,
    box: null,
    mirror: null,
    ...partial,
  };
}

function rendering(partial: Partial<L10nRendering> & { locale: string }): L10nRendering {
  return { direction: null, documentDirection: null, htmlLang: null, nodes: [], pseudo: false, ...partial };
}

/* Every detector ON, through the real spec reader. */
const CONFIG = parseL10nDeepConfig({
  deep: Object.fromEntries(L10N_DETECTOR_LIST.map((d) => [d, true])),
});
/* Nothing switched on, which is the "we looked at nothing" fixture. */
const ALL_OFF = parseL10nDeepConfig({});

describe('ADVERSARY — I18N: "found nothing" and "looked at nothing" are different', () => {
  it('a page with NO nodes at all is UNMEASURED with a reason, not clean', () => {
    const input: L10nDeepInput = {
      route: '/pricing',
      base: null,
      target: rendering({ locale: 'de-DE', nodes: [] }),
      config: CONFIG,
    };
    const result = runL10nDetectors(input);
    expect(result.findings).toEqual([]);
    // The crux: every outcome must say UNMEASURED and WHY.
    const measured = result.outcomes.filter((o) => o.status === 'MEASURED');
    for (const o of result.outcomes) {
      if (o.status === 'UNMEASURED') {
        expect(o.reason, `${o.detector} must name WHY`).not.toBeNull();
        expect(o.detail.length).toBeGreaterThan(10);
      }
      expect(l10nOutcomeProblems(o), o.detector).toEqual([]);
    }
    // A detector that reports MEASURED on zero nodes would be the lie.
    for (const o of measured) {
      expect(o.nodesExamined, `${o.detector} claims MEASURED`).toBeGreaterThan(0);
    }
  });

  it('with no catalogue and no pseudo pass, those detectors are UNMEASURED not MEASURED-clean', () => {
    const input: L10nDeepInput = {
      route: '/pricing',
      base: null,
      target: rendering({ locale: 'de-DE', nodes: [node({ locator: '#h1', text: 'Preise' })] }),
      // No catalogueKeys, no pseudoRendering.
      config: CONFIG,
    };
    const result = runL10nDetectors(input);
    const pseudo = result.outcomes.find((o) => o.detector === 'pseudoLocalization');
    expect(pseudo?.status).toBe('UNMEASURED');
    expect(pseudo?.reason).not.toBeNull();
    expect(pseudo?.findings).toBe(0);
  });

  it('a spec with no `deep` block is six UNMEASURED/NOT_ENABLED outcomes, not six clean ones', () => {
    const input: L10nDeepInput = {
      route: '/pricing',
      base: null,
      target: rendering({
        locale: 'de-DE',
        nodes: [node({ locator: '#h1', text: 'Preise' }), node({ locator: '#cta', text: 'Jetzt' })],
      }),
      config: ALL_OFF,
    };
    const result = runL10nDetectors(input);
    expect(result.outcomes.length).toBe(L10N_DETECTOR_LIST.length);
    for (const o of result.outcomes) {
      expect(o.status, o.detector).toBe('UNMEASURED');
      expect(o.reason, o.detector).not.toBeNull();
      expect(o.findings).toBe(0);
      expect(o.nodesExamined).toBe(0);
    }
    /*
     * `findings` is EMPTY here, and that is the design rather than the defect:
     * the "we did not look" half travels in `measuredAnything` and `outcomes`,
     * and `unmeasuredFindings` is the human-readable projection a caller must
     * emit. So the honest assertion is that an empty finding list NEVER arrives
     * alone — it arrives beside a false `measuredAnything`, which is the one
     * boolean a coverage number is allowed to read.
     */
    expect(result.findings).toEqual([]);
    expect(result.measuredAnything).toBe(false);
    const surfaced = unmeasuredFindings('/pricing', result.outcomes);
    expect(surfaced.length).toBe(L10N_DETECTOR_LIST.length);
    for (const f of surfaced) {
      expect(f.severity).toBe('MINOR');
      expect(f.message).toMatch(/must not be counted as a passing check/);
      expect(f.kind).toBe('LOCALIZATION');
    }
  });

  it('measuredAnything is the guard: a measured page sets it true, an unlooked-at page false', () => {
    const nodes = [node({ locator: '#h1', text: 'Preise' })];
    const looked = runL10nDetectors({
      route: '/p',
      base: null,
      target: rendering({ locale: 'de-DE', nodes }),
      catalogueKeys: ['pricing.title'],
      config: CONFIG,
    });
    const notLooked = runL10nDetectors({
      route: '/p',
      base: null,
      target: rendering({ locale: 'de-DE', nodes }),
      config: ALL_OFF,
    });
    expect(looked.measuredAnything).toBe(true);
    expect(notLooked.measuredAnything).toBe(false);
    // Both have an empty finding list; only the boolean tells them apart.
    expect(looked.findings).toEqual([]);
    expect(notLooked.findings).toEqual([]);
  });

  it('an UNMEASURED outcome with findings and no evidence is incoherent and caught', () => {
    const problems = l10nOutcomeProblems({
      detector: 'missingKey',
      status: 'UNMEASURED',
      reason: NO_EVIDENCE_UNMEASURED_REASONS[0]!,
      detail: 'nothing was captured',
      nodesExamined: 0,
      setAside: [],
      findings: 3,
      cappedBy: null,
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toMatch(/finding/i);
  });

  it('an UNMEASURED outcome with NO reason is caught', () => {
    const problems = l10nOutcomeProblems({
      detector: 'truncation',
      status: 'UNMEASURED',
      reason: null,
      detail: 'x',
      nodesExamined: 0,
      setAside: [],
      findings: 0,
      cappedBy: null,
    });
    expect(problems.join(' ')).toMatch(/indistinguishable/i);
  });
});

describe('ADVERSARY — I18N: the detectors fire on a SEEDED defect', () => {
  it('MISSING_KEYS fires on a raw message key rendered to screen', () => {
    const input: L10nDeepInput = {
      route: '/pricing',
      base: null,
      target: rendering({
        locale: 'de-DE',
        nodes: [
          // The planted bug: an untranslated key reached the UI.
          node({ locator: '#cta', text: 'pricing.cta.upgrade_now', tag: 'BUTTON' }),
          node({ locator: '#h1', text: 'Preise und Tarife', tag: 'H1' }),
        ],
      }),
      catalogueKeys: ['pricing.cta.upgrade_now', 'pricing.title'],
      config: CONFIG,
    };
    const run = detectMissingKeys(input);
    expect(run.outcome.status).toBe('MEASURED');
    expect(run.findings.length, 'the planted key must be caught').toBeGreaterThan(0);
    expect(run.findings.some((f) => f.location?.includes('#cta') ?? false)).toBe(true);
    // And the CLEAN sibling must not be reported.
    expect(run.findings.some((f) => f.location?.includes('#h1') ?? false)).toBe(false);
  });

  it('PSEUDO_LOCALIZATION fires on a string cut off under the pseudo pass', () => {
    const long = pseudoLocalize('Upgrade your plan now');
    expect(long).toContain(PSEUDO_START);
    expect(long).toContain(PSEUDO_END);
    // The planted bug: the closing sentinel is GONE — the string was clipped.
    const clipped = long.slice(0, long.length - 6);
    expect(clipped).not.toContain(PSEUDO_END);

    const input: L10nDeepInput = {
      route: '/pricing',
      base: rendering({ locale: 'en-GB', nodes: [node({ locator: '#cta', text: 'Upgrade your plan now' })] }),
      target: rendering({ locale: 'en-GB', nodes: [node({ locator: '#cta', text: 'Upgrade your plan now' })] }),
      pseudoRendering: rendering({
        locale: 'en-XA',
        pseudo: true,
        nodes: [node({ locator: '#cta', text: clipped })],
      }),
      config: CONFIG,
    };
    const run = detectPseudoLocalization(input);
    expect(run.outcome.status).toBe('MEASURED');
    expect(run.findings.length, 'a clipped pseudo string must be caught').toBeGreaterThan(0);
  });

  it('PSEUDO_LOCALIZATION does NOT fire when every sentinel survived', () => {
    const whole = pseudoLocalize('Upgrade your plan now');
    const input: L10nDeepInput = {
      route: '/pricing',
      base: rendering({ locale: 'en-GB', nodes: [node({ locator: '#cta', text: 'Upgrade your plan now' })] }),
      target: rendering({ locale: 'en-GB', nodes: [node({ locator: '#cta', text: 'Upgrade your plan now' })] }),
      pseudoRendering: rendering({
        locale: 'en-XA',
        pseudo: true,
        nodes: [node({ locator: '#cta', text: whole })],
      }),
      config: CONFIG,
    };
    const run = detectPseudoLocalization(input);
    expect(run.outcome.status).toBe('MEASURED');
    expect(run.findings).toEqual([]);
  });
});
