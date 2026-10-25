/**
 * "Which of the 19 test types can this deployment actually execute?"
 *
 * The question had no single answer. Half of it lived here — `pluginFor`
 * returns null for a type nobody implemented — and the other half lived inside
 * each plugin's ENOENT branch, discovered one run at a time and only after the
 * run had been queued, scheduled, started and paid for: `load.ts` spawns k6 and
 * reads ENOENT, `mutation.ts` spawns Stryker and reads ENOENT, `mobile.ts` tries
 * `xcodebuild` and finds out it is not on macOS. A customer who wrote a LOAD
 * test on an image with no k6 learned about it from a skipped result.
 *
 * These assertions are mostly about the two halves staying ONE answer, and
 * about the one way this report can be worse than no report: declaring a type
 * unsupported that the project in question can run perfectly well.
 */

import { describe, expect, it } from 'vitest';
import { implementedTypes, pluginFor, runnabilityFor, runnabilityReport } from './registry.js';
import type { RunnabilityProbes } from './preflight.js';
import { TEST_TYPES } from '@qaai/shared';

/** A healthy image: every tool present, every browser installed. */
const everything: RunnabilityProbes = {
  onPath: () => true,
  browserInstalled: () => true,
  platform: 'linux',
};

describe('the deployment-wide runnability report', () => {
  it('covers every type the product claims to support', async () => {
    /*
     * Not `implementedTypes()`, deliberately. A report that only listed the
     * types with plugins could never say "there is no plugin for this", which
     * is the answer a customer writing that test most needs — and the two
     * halves of the question would be on different surfaces again, which is how
     * one of them ends up on neither.
     */
    const report = await runnabilityReport({ probes: everything });
    expect(report.map((entry) => entry.type).sort()).toEqual([...TEST_TYPES].sort());
  });

  it('reports no plugin gaps, because this build has a plugin for every type', async () => {
    // The same invariant `check:wiring`'s test-types check enforces, asserted
    // here from the other direction: a type with no plugin would surface in
    // this report rather than only at run time.
    const report = await runnabilityReport({ probes: everything });
    const pluginless = report.filter((entry) => /No runner plugin registered/.test(entry.reason));

    expect(pluginless).toEqual([]);
    expect(implementedTypes().sort()).toEqual([...TEST_TYPES].sort());
  });

  it('names the two kinds of gap differently, because they have different remedies', async () => {
    /*
     * "Install k6 on the worker" and "nobody has written this plugin" are both
     * "you cannot run this here", and conflating them sends a customer to do
     * something that will not help.
     */
    const report = await runnabilityFor(['LOAD', 'VISUAL'], {
      probes: { ...everything, onPath: () => false },
      hasPlugin: (type) => type !== 'VISUAL',
    });

    const load = report.find((entry) => entry.type === 'LOAD')!;
    const visual = report.find((entry) => entry.type === 'VISUAL')!;

    expect(load.runnable).toBe(false);
    expect(load.reason).toMatch(/brew install k6/);

    expect(visual.runnable).toBe(false);
    expect(visual.reason).toMatch(/No runner plugin registered for VISUAL/);
    expect(visual.reason).toMatch(/no amount of installing tools/);
  });

  it('does not declare a type unsupported that an INSTALLED plugin can run', async () => {
    /*
     * The one way this report can cause the outcome it exists to prevent. A run
     * resolves a type through `resolveTestPlugin`, which also consults the
     * project's installed third-party plugins — so a type with no first-party
     * plugin can be perfectly runnable for that project. A report that asked
     * only this registry would mark it unsupported, and the run would then
     * refuse tests it was about to execute.
     *
     * Hence `hasPlugin` is the caller's answer rather than this module's.
     */
    const [withPlugin] = await runnabilityFor(['VISUAL'], {
      probes: everything,
      hasPlugin: () => true,
    });
    const [withoutPlugin] = await runnabilityFor(['VISUAL'], {
      probes: everything,
      hasPlugin: () => false,
    });

    expect(withPlugin!.runnable).toBe(true);
    expect(withoutPlugin!.runnable).toBe(false);
  });

  it('asks about the suite\u2019s own types only, not every type in the product', async () => {
    // A run must not pay to probe Maestro because some other project has mobile
    // tests, and must not report a tooling gap for a type nobody in this run is
    // using.
    const report = await runnabilityFor(['E2E', 'API'], { probes: everything });
    expect(report.map((entry) => entry.type)).toEqual(['E2E', 'API']);
  });

  it('exposes the preflight through this module, so both halves arrive together', async () => {
    // The re-export is the wiring: a caller that had to import the registry for
    // one half and ./preflight.js for the other would be free to use one and
    // forget the other, which is precisely the split this change removes.
    const registry = await import('./registry.js');
    expect(typeof registry.environmentPreflight).toBe('function');
    expect(typeof registry.environmentBlock).toBe('function');
    expect(typeof registry.unattemptable).toBe('function');
    expect(typeof registry.repoWorkspaceCheck).toBe('function');
  });

  it('still resolves a plugin for every type, which the report depends on', () => {
    for (const type of TEST_TYPES) {
      expect(pluginFor(type), type).not.toBeNull();
    }
  });
});
