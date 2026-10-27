/**
 * THE REGISTRY, AFTER SIX TEST TYPES LANDED WITH NOTHING IMPORTING THEM.
 *
 * Seven files were flagged `package-exports` at once — chaos, document, email,
 * push, pwa, l10n-deep and matrix — every one complete, tested and imported by
 * its own test file alone, because the registry entry lives in a file none of
 * their authors owned. These tests pin the three things that make them real:
 * the plugin RESOLVES, the declaration can be PROBED, and a type this image
 * cannot execute is reported MISSING with a remedy and taken OUT of the
 * denominator rather than recorded SKIPPED.
 *
 * The last one is the register's own wording and the reason the file exists: a
 * percentage containing tests that can never fail is the lie this product
 * cannot afford, and a SKIPPED row inside a denominator is indistinguishable
 * from a surface nobody has got to yet.
 */

import { describe, expect, it } from 'vitest';
import { PENDING_TEST_TYPES, TEST_TYPES, declarationFor } from '@qaai/shared';
import {
  CHANNEL_REQUIREMENTS_DEMOTED,
  TYPE_REQUIREMENTS,
  asProbeRequirement,
  declaredRequirements,
  declaredRunnability,
  denominatorExclusions,
  implementedTypes,
  pendingTypes,
  pluginFor,
  reasonUnsupported,
  requirementParity,
  undeclaredPluginTypes,
} from './registry.js';
import type { RunnabilityProbes } from './preflight.js';

/** Nothing on this image: no binary, no browser, and a Linux worker. */
const BARE: RunnabilityProbes = {
  onPath: () => false,
  browserInstalled: () => false,
  platform: 'linux',
};

/** Everything present, so a refusal in a test below is about the declaration. */
const STOCKED: RunnabilityProbes = {
  onPath: () => true,
  browserInstalled: () => true,
  platform: 'linux',
};

describe('the six types this round landed are registered', () => {
  const LANDED = ['CHAOS', 'DOCUMENT', 'PWA', 'PUSH', 'EMAIL'] as const;

  it.each(LANDED)('%s resolves to a plugin through the pending table', (type) => {
    // Pending, not minted: `TEST_TYPES` does not contain any of them, so no
    // Test row can carry one. `pendingTypes()` is the read path that says so.
    expect(pendingTypes()).toContain(type);
    expect(TEST_TYPES as readonly string[]).not.toContain(type);
  });

  it('leaves the nineteen minted types exactly as they were', () => {
    expect(implementedTypes().sort()).toEqual([...TEST_TYPES].sort());
    for (const type of TEST_TYPES) expect(pluginFor(type)).not.toBeNull();
  });

  it('tells "the plugin is in this build" apart from "no plugin exists"', () => {
    const pending = reasonUnsupported('CHAOS' as never);
    expect(pending).toContain('has a runner plugin in this build');
    expect(pending).toContain('TEST_TYPES');
    expect(pending).not.toContain('No runner plugin registered');
  });
});

describe('what a type declares can now be probed, for all thirty', () => {
  it.each([...TEST_TYPES, ...PENDING_TEST_TYPES])('answers for %s', async (type) => {
    const declared = declaredRequirements(type);
    expect(declared.declared).toBe(true);
    const [report] = await declaredRunnability([type], { probes: STOCKED });
    expect(report).toBeDefined();
    expect(report?.type).toBe(type);
  });

  it('REFUSES a registered plugin whose type no declaration describes', () => {
    // 'EMAIL' is in neither TEST_TYPES nor PENDING_TEST_TYPES. The honest
    // answer is "unknown", never "needs nothing" — which is what API and
    // SECURITY_SMOKE genuinely report.
    expect(undeclaredPluginTypes()).toEqual(['EMAIL']);
    const declared = declaredRequirements('EMAIL');
    expect(declared.declared).toBe(false);
    expect(declared.requirements).toHaveLength(0);
    expect(declared.why).toContain('UNKNOWN rather than nothing');

    const api = declaredRequirements('API');
    expect(api.declared).toBe(true);
    expect(api.requirements).toHaveLength(0);
  });

  it('answers nothing at all for a name nobody has heard of', async () => {
    const report = await declaredRunnability(['NOT_A_TYPE'], { probes: STOCKED });
    expect(report).toHaveLength(0);
  });

  it('DEMOTES a channel requirement rather than dropping it or refusing on it', () => {
    const demoted = asProbeRequirement({
      kind: 'CHANNEL',
      scope: 'TYPE',
      channel: 'CHROME',
      install: 'npx playwright install chrome',
    });
    expect(demoted.kind).toBe('UNPROBED');
    // SPEC scope, so it is REPORTED and never a refusal: this prober cannot see
    // a channel, and refusing a type whose channel is installed would be worse
    // than saying it was not checked.
    expect(demoted.scope).toBe('SPEC');
    if (demoted.kind !== 'UNPROBED') throw new Error('unreachable');
    expect(demoted.what).toContain('CHROME');
    expect(demoted.why).toContain('resolveMatrixCell');
  });

  it('discloses every demotion as a count and a type, not silently', () => {
    const demoted = CHANNEL_REQUIREMENTS_DEMOTED();
    expect(demoted.length).toBeGreaterThan(0);
    const crossBrowser = demoted.find((entry) => entry.type === 'CROSS_BROWSER');
    expect(crossBrowser?.channels).toEqual(['CHROME', 'MSEDGE']);
  });
});

describe('the two requirement tables, and where they really disagree', () => {
  /*
   * NOT asserted empty, because it is NOT empty — and that is a finding rather
   * than a failure. `TEST_TYPE_DECLARATIONS` says CROSS_BROWSER needs the
   * CHROME and MSEDGE channels, which is what a buyer means by cross-browser;
   * `TYPE_REQUIREMENTS` in ./preflight.ts declares only the three engines. The
   * declaration is the stronger and more correct of the two, and reconciling it
   * is an edit to preflight.ts that this change does not own.
   *
   * Pinned as an EXACT set so the gap cannot grow without this test going red,
   * which is the whole value of the parity function.
   */
  it('disagrees about CROSS_BROWSER and about nothing else', () => {
    const parity = requirementParity();
    expect(parity.map((entry) => entry.type)).toEqual(['CROSS_BROWSER']);
    expect(parity[0]?.only).toEqual([
      'declaration:UNPROBED:the `CHROME` browser channel (npx playwright install chrome)',
      'declaration:UNPROBED:the `MSEDGE` browser channel (npx playwright install msedge)',
    ]);
  });

  it('keeps the preflight table total over the minted types', () => {
    expect(Object.keys(TYPE_REQUIREMENTS).sort()).toEqual([...TEST_TYPES].sort());
  });
});

describe('a type this image cannot execute is MISSING, excluded, and never skipped', () => {
  it('reports the missing binary with its install line', async () => {
    const [load] = await declaredRunnability(['LOAD'], { probes: BARE });
    expect(load?.runnable).toBe(false);
    expect(load?.missing.map((requirement) => ('name' in requirement ? requirement.name : ''))).toContain(
      'k6',
    );
    expect(load?.reason).toContain('k6');
    expect(load?.reason).toMatch(/install/i);
  });

  it('takes it OUT of the coverage denominator, with the sentence to print', async () => {
    const report = await declaredRunnability(['LOAD', 'API'], { probes: BARE });
    const excluded = denominatorExclusions(report);
    expect(excluded.map((entry) => entry.type)).toEqual(['LOAD']);
    const reason = excluded[0]?.reason ?? '';
    expect(reason).toContain('cannot run on this deployment');
    expect(reason).toContain('k6');
    // The register's exact requirement: not a pass, and not a skip either.
    expect(reason).toContain('not reported as passing');
    expect(reason).toContain('not reported as skipped');
  });

  it('does NOT exclude a type nobody probed, which would raise the percentage for free', async () => {
    /*
     * THE SUBTLE HALF. `runnable === null` means nothing was checked — which is
     * not evidence that the type cannot run. Excluding it would let a
     * deployment that never ran a preflight shed every type it could not prove
     * it could run, and the number would RISE for a probe nobody executed.
     */
    const unprobed = await declaredRunnability(['LOAD'], {
      probes: { onPath: () => null, browserInstalled: () => null, platform: 'linux' },
    });
    expect(unprobed[0]?.runnable).toBeNull();
    expect(denominatorExclusions(unprobed)).toHaveLength(0);
  });

  it('excludes a registered PENDING type on the same evidence as a minted one', async () => {
    // The point of the bridge: before it, `runnabilityReport()` could not be
    // asked about CHAOS at all, so a registered plugin was un-probeable.
    const [chaos] = await declaredRunnability(['CHAOS'], { probes: BARE });
    expect(chaos?.runnable).toBe(false);
    expect(denominatorExclusions([chaos as never]).map((entry) => entry.type)).toEqual(['CHAOS']);
  });

  it('refuses a type with no plugin before asking the machine anything', async () => {
    const [report] = await declaredRunnability(['DESKTOP'], {
      probes: BARE,
      hasPlugin: () => false,
    });
    expect(report?.runnable).toBe(false);
    expect(report?.requirements).toHaveLength(0);
    expect(report?.reason).toContain('no amount of installing tools');
  });
});

describe('every registered plugin is described by something', () => {
  it('has a declaration or is named in undeclaredPluginTypes — never neither', () => {
    for (const type of [...implementedTypes(), ...pendingTypes()]) {
      const described = declarationFor(type) !== null || undeclaredPluginTypes().includes(type);
      expect(described, `${type} is registered and described by nothing`).toBe(true);
    }
  });
});
