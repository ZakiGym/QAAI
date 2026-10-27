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
import {
  implementedTypes,
  pendingTypes,
  pluginFor,
  promotePendingPlugins,
  reasonUnsupported,
  runnabilityFor,
  runnabilityReport,
} from './registry.js';
import type { RunnabilityProbes } from './preflight.js';
import { TEST_TYPES } from '@qaai/shared';
import type { RunnerPlugin } from '@qaai/shared';
import { desktopPlugin } from './plugins/desktop.js';
import { jobsPlugin } from './plugins/jobs.js';
import { linksPlugin } from './plugins/links.js';
import { seoPlugin } from './plugins/seo.js';

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

/*
 * ── Plugins waiting on a TestType ───────────────────────────────────────────
 *
 * The usual gap in this registry is a type with no plugin. DESKTOP, JOBS,
 * LINKS and SEO are the mirror image — a complete plugin for a type
 * `TEST_TYPES` does not contain yet — and the risk is the one this repo keeps
 * producing: a module that only its own test calls, which `check:wiring`
 * cannot see here because an unminted type is not in the list that gate
 * iterates.
 *
 * So these assertions are about the SEAM: the plugins are reachable from the
 * registry today, the gap is sayable, and the promotion is what makes the
 * shared edit sufficient on its own.
 */
describe('a plugin whose TestType is not minted yet', () => {
  it('names every pending type, so the gap is sayable rather than silent', () => {
    // "QAAI cannot test your Electron app" and "QAAI can, but you cannot create
    // the test yet" are different sentences with different remedies.
    //
    // WIDENED FROM FIVE TO TEN when this round's six test types were
    // registered, and the list is pinned EXACTLY on purpose: it is the gap
    // ledger, so a plugin joining or a type being minted must change this line
    // deliberately rather than drift. This assertion is what caught the
    // registration, which is the point of pinning it.
    //
    // 'EMAIL' is the one entry that is NOT merely awaiting a mint: unlike its
    // nine siblings it is in neither TEST_TYPES nor PENDING_TEST_TYPES, so it
    // has no declaration either. `undeclaredPluginTypes()` in registry.ts is
    // the function that reports that narrower gap, and
    // registry.declarations.test.ts pins it.
    expect(pendingTypes().sort()).toEqual([
      'CHAOS',
      'DESKTOP',
      'DOCUMENT',
      'EMAIL',
      'JOBS',
      'LINKS',
      'PUSH',
      'PWA',
      'SEO',
      'TENANCY',
    ]);
  });

  it('keeps every pending type genuinely absent from TEST_TYPES', () => {
    /*
     * The guard on the guard. If a sibling change mints DESKTOP without this
     * registry being re-read, the promotion below must have fired — so a
     * pending type that IS in TEST_TYPES means the promotion silently failed
     * and `pluginFor` is returning null for a type the product offers.
     */
    for (const type of pendingTypes()) {
      expect((TEST_TYPES as readonly string[]).includes(type), type).toBe(false);
      expect(pluginFor(type as never), type).toBeNull();
    }
  });

  it('promotes a pending plugin the moment its type is minted, with no edit here', () => {
    /*
     * The property that makes the shared edit sufficient — and it is asserted
     * by RUNNING the promotion, not by re-deriving its condition.
     *
     * An earlier version of this test rebuilt the predicate itself
     * (`['DESKTOP'].filter((n) => minted.includes(n))`) and a mutation that
     * disabled the real loop entirely left it green. The promotion would have
     * been dead on the day the vocabulary landed and this suite would have said
     * nothing. Hence `promotePendingPlugins` takes the minted list: the test
     * hands it a widened one and watches the plugins arrive in a real table.
     */
    const table: Record<string, RunnerPlugin> = {};
    const moved = promotePendingPlugins(table, [...TEST_TYPES, 'DESKTOP', 'JOBS', 'LINKS', 'SEO']);

    expect(moved.sort()).toEqual(['DESKTOP', 'JOBS', 'LINKS', 'SEO']);
    expect(table.DESKTOP).toBe(desktopPlugin);
    expect(table.JOBS).toBe(jobsPlugin);
    expect(table.LINKS).toBe(linksPlugin);
    expect(table.SEO).toBe(seoPlugin);
    for (const name of moved) {
      expect(typeof table[name]?.validate, name).toBe('function');
      expect(typeof table[name]?.execute, name).toBe('function');
    }
  });

  it('promotes each plugin under the name the plugin itself claims', () => {
    /*
     * The key in `PENDING_PLUGINS` is what `pluginFor` will answer to, and the
     * plugin's own `type` is what every result it produces is labelled with.
     * Nothing in the type system ties them together — `PendingPlugin.type` is a
     * bare `string` precisely because the union does not contain these names —
     * so a copy-paste that registered the SEO plugin under LINKS would compile,
     * promote, and then file every SEO defect as a links result.
     *
     * Asserted by promoting into a real table and reading each plugin's own
     * `type` back off it, because that is the pair that has to agree.
     */
    const table: Record<string, RunnerPlugin> = {};
    const moved = promotePendingPlugins(table, [...TEST_TYPES, 'DESKTOP', 'JOBS', 'LINKS', 'SEO']);

    expect(moved.length).toBeGreaterThan(0);
    for (const name of moved) {
      expect(table[name]?.type, name).toBe(name);
    }
  });

  it('promotes nothing while the vocabulary does not name them', () => {
    // The other half: promotion must not smuggle a type into the table that
    // `TEST_TYPES` does not contain, or `implementedTypes()` would claim a
    // type the database cannot store.
    const table: Record<string, RunnerPlugin> = {};
    expect(promotePendingPlugins(table, TEST_TYPES)).toEqual([]);
    expect(Object.keys(table)).toEqual([]);
  });

  it('does not tell a reader to write a plugin that already exists', () => {
    /*
     * The defect this branch removes. "No runner plugin registered for
     * DESKTOP" is FALSE — the plugin is in this build and this table imports
     * it — and it would send the reader to write one. The remedy is minting
     * the type, so that is what the sentence says.
     */
    for (const type of ['DESKTOP', 'JOBS', 'LINKS', 'SEO'] as const) {
      const reason = reasonUnsupported(type as never);
      expect(reason, type).toMatch(/has a runner plugin in this build/);
      expect(reason, type).toMatch(/not a member of TEST_TYPES yet/);
      expect(reason, type).toMatch(/constants\.ts/);
      expect(reason, type).not.toMatch(/No runner plugin registered/);
    }
  });

  it('still says "no plugin" for a type that genuinely has none', () => {
    // The counter-test: the pending branch must not swallow the real gap it
    // sits next to.
    expect(reasonUnsupported('SOMETHING_ELSE' as never)).toMatch(
      /No runner plugin registered for SOMETHING_ELSE/,
    );
  });
});
