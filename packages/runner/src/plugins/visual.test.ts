/**
 * The visual plugin's BASELINE KEY, which is the one thing in this file that
 * cannot be got wrong twice.
 *
 * `VisualBaseline`'s unique key is (testId, viewport, browser, environmentId).
 * This plugin used to compute `viewport` itself — `` `${width}x${height}` `` —
 * and hard-code `browser: 'chromium'`, so a declared matrix had ONE row for
 * every cell: whichever ran last became the others' reference, somebody approved
 * it, and every later diff was measured against the wrong rendering. One image
 * approved and asserted for the whole matrix.
 *
 * Two properties are pinned here and they pull in opposite directions, which is
 * why both are named:
 *
 *  1. **BYTE-IDENTITY.** An unvaried DEFAULT-state cell must still produce
 *     `1280x800` and `chromium` exactly. Every baseline a customer has already
 *     approved is keyed on the strings this file wrote before, so a separator
 *     appended anywhere forces a re-approval sweep across every visual test in
 *     the product — which is worse than the bug being fixed.
 *  2. **SEPARATION.** Light and dark, and DEFAULT and ERROR, must produce
 *     DIFFERENT strings, or the four-column key cannot hold them apart.
 *
 * No browser is launched by anything in this file. The key computation is a pure
 * function, and the one plugin path driven end to end is the REFUSAL — a spec
 * whose states omit DEFAULT returns before `acquireBrowser` is reached. The
 * pixel diff itself needs a browser and is not re-proved here.
 */

import { describe, expect, it } from 'vitest';
import { visualTestSpecSchema } from '@qaai/shared';
import type { ArtifactSink, ExecutableTest, RunContext } from '@qaai/shared';
import { mayWriteBaseline, recordCapture } from '../matrix.js';
import { artifactLabel, planVisualBaselines, visualPlugin } from './visual.js';

const artifacts: ArtifactSink = {
  put: async () => 'key',
  putFile: async () => 'key',
  get: async () => null,
  putPersistent: async () => 'key',
};

const ctx: RunContext = {
  runId: 'run_visual_1',
  orgId: 'org_1',
  projectId: 'proj_1',
  environmentId: 'env_staging',
  baseUrl: 'http://127.0.0.1:1',
  secrets: {},
  storageState: null,
  artifacts,
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    step: () => {},
  },
  signal: new AbortController().signal,
  determinism: {
    freezeClockAt: null,
    randomSeed: 1,
    waitForNetworkIdle: true,
    retryOnce: false,
  },
};

function visualTest(spec: unknown): ExecutableTest {
  return {
    id: 't_visual',
    name: 'the pricing page looks right',
    type: 'VISUAL',
    code: '',
    filePath: 'tests/visual/pricing.spec.ts',
    spec,
    timeoutMs: 30_000,
    quarantined: false,
    tags: [],
  };
}

describe('the baseline key an existing customer is already keyed on', () => {
  it('still produces 1280x800 and chromium for an unvaried DEFAULT cell, byte for byte', () => {
    const spec = visualTestSpecSchema.parse({ path: '/pricing' });
    const plan = planVisualBaselines(spec, 'seed');

    /*
     * THE INVARIANT. These two strings are what the pre-matrix writer put in
     * `VisualBaseline.viewport` and `.browser`, and every approved reference row
     * in every customer's database is keyed on them. A separator appended to
     * either one misses every existing row, every visual test reports "first
     * run, baseline captured", and nobody notices until a real regression ships
     * green.
     */
    expect(plan.captured?.baselineViewport).toBe('1280x800');
    expect(plan.captured?.baselineBrowser).toBe('chromium');
    expect(plan.captured?.state).toBe('DEFAULT');
    expect(plan.uncaptured).toEqual([]);
    expect(plan.refusal).toBeNull();
  });

  it('keeps the artifact path byte-identical too, and flattens only what a path cannot hold', () => {
    // `1280x800` through unchanged; `#` would truncate a URL at the fragment
    // and `/` would invent a directory, so a stateful key is flattened for the
    // PATH only — never for the row identity.
    expect(artifactLabel('1280x800')).toBe('1280x800');
    expect(artifactLabel('1280x800+dark#ERROR')).toBe('1280x800_dark_ERROR');
    expect(artifactLabel('iphone-14/@2x+dark')).toBe('iphone-14_2x_dark');
  });

  it('honours a non-default viewport without inventing an axis', () => {
    const spec = visualTestSpecSchema.parse({ viewport: { width: 390, height: 844 } });
    expect(planVisualBaselines(spec, 'seed').captured?.baselineViewport).toBe('390x844');
  });
});

describe('what stops one image becoming the whole matrix', () => {
  it('gives a declared dark cell its own baseline row rather than the captured one', () => {
    const spec = visualTestSpecSchema.parse({ matrix: { colourSchemes: ['DARK'] } });
    const plan = planVisualBaselines(spec, 'seed');

    expect(plan.captured?.baselineViewport).toBe('1280x800');
    expect(plan.uncaptured).toHaveLength(1);
    const dark = plan.uncaptured[0]?.plan.baselineViewport;
    expect(dark).not.toBe(plan.captured?.baselineViewport);
    expect(dark).toContain('dark');
    // And it is REPORTED, with the reason, rather than quietly folded into the
    // captured cell's reference.
    expect(plan.uncaptured[0]?.why).toContain('newBaseline carries ONE row');
  });

  it('separates every interaction state from the arrival rendering', () => {
    const spec = visualTestSpecSchema.parse({ states: ['DEFAULT', 'ERROR', 'LOADING'] });
    const plan = planVisualBaselines(spec, 'seed');

    expect(plan.captured?.baselineViewport).toBe('1280x800');
    expect(plan.uncaptured.map((pair) => pair.plan.baselineViewport)).toEqual([
      '1280x800#ERROR',
      '1280x800#LOADING',
    ]);
    const keys = new Set([
      plan.captured?.baselineViewport,
      ...plan.uncaptured.map((pair) => pair.plan.baselineViewport),
    ]);
    expect(keys.size).toBe(3);
  });

  it('refuses to approve a baseline for a state nothing reached', () => {
    const spec = visualTestSpecSchema.parse({ states: ['DEFAULT', 'ERROR'] });
    const plan = planVisualBaselines(spec, 'seed');

    /*
     * The gate the writer asks. A record for an unreached state never passes it,
     * even when an image key is handed in — which is the whole protection: a
     * capture of the DEFAULT rendering filed as ERROR looks fine, gets approved,
     * and makes every future run of that cell falsely green for ever.
     */
    const errorPair = plan.uncaptured[0];
    const record = recordCapture({
      plan: errorPair!.plan,
      outcome: { reached: false, reason: errorPair!.reason, detail: errorPair!.why },
      imageKey: 'baselines/t_visual-1280x800.png',
      environmentId: 'env_staging',
    });
    expect(mayWriteBaseline(record)).toBe(false);
    expect(record.imageKey).toBeNull();
    expect(record.imageDiscarded).toBe(true);

    // And the pair that WAS reached is the only one that may be written.
    const reached = recordCapture({
      plan: plan.captured!,
      outcome: { reached: true },
      imageKey: 'baselines/t_visual-1280x800.png',
      environmentId: 'env_staging',
    });
    expect(mayWriteBaseline(reached)).toBe(true);
  });

  it('refuses a capture whose artifact store returned no key', () => {
    const spec = visualTestSpecSchema.parse({});
    const plan = planVisualBaselines(spec, 'seed');
    const record = recordCapture({
      plan: plan.captured!,
      outcome: { reached: true },
      imageKey: null,
      environmentId: 'env_staging',
    });
    // A `VisualBaseline` row pointing at nothing fails every future run of the
    // test with a missing-baseline error that reads as a product defect.
    expect(mayWriteBaseline(record)).toBe(false);
  });
});

describe('a declaration this plugin will not half-honour', () => {
  it('runs nothing when the declared states omit DEFAULT, and says why', async () => {
    /*
     * THE PLUGIN PATH, driven end to end with no browser: `execute` consults the
     * plan and returns before `acquireBrowser`. If this file stopped consulting
     * `planVisualBaselines` it would launch a browser, screenshot the arrival
     * rendering and file it under `#ERROR` — the falsely-green baseline — so
     * this test is what holds the wiring in place.
     */
    const result = await visualPlugin.execute(ctx, visualTest({ states: ['ERROR'] }));

    expect(result.status).toBe('SKIPPED');
    expect(result.notRun?.kind).toBe('NOT_RUN');
    expect(result.notRun?.why).toContain('DEFAULT is not among them');
    expect(result.errorMessage).toContain('[NOT_RUN]');
    expect(result.newBaseline).toBeUndefined();
  });

  it('captures nothing from a declaration it could not read, rather than a prefix of it', () => {
    const spec = visualTestSpecSchema.parse({ matrix: { colourSchemes: ['LIGHT', 'DARK'] } });

    /*
     * An empty seed makes a bitten cap unreproducible, so `planMatrix` returns
     * it as an authoring problem. Capturing "the first cell" of a declaration
     * nobody could read and approving it as the reference is a write made on a
     * half-understood statement, so nothing is captured at all.
     */
    const plan = planVisualBaselines(spec, '');
    expect(plan.captured).toBeNull();
    expect(plan.uncaptured).toEqual([]);
    expect(plan.refusal?.kind).toBe('NOT_RUN');
    expect(plan.refusal?.why).toContain('seed');
  });

  it('names the engine a declared channel is a build of, instead of contradicting itself', () => {
    /*
     * `visualTestSpecSchema.matrix` is the SAME `matrixAxesSchema` the
     * CROSS_BROWSER spec carries, so a visual declaration can name a channel
     * and no engine. That planned `{ channel: 'MSEDGE_DEV' }`, which
     * `variantBrowserKey` names `'<default>:MSEDGE_DEV'` — a label claiming
     * nobody chose an engine and then naming a build of one, with an angle
     * bracket mid-composite that `matrixCellSchema` would never have accepted
     * as a declaration and `variantDimension` refuses outright.
     *
     * Asserted on the ABSENCE OF THE SENTINEL rather than on the full string,
     * so this test is about the contradiction and not about the spelling of a
     * key two other producers own.
     */
    const spec = visualTestSpecSchema.parse({ matrix: { channels: ['MSEDGE_DEV'] } });
    const plan = planVisualBaselines(spec, 'seed');

    const browsers = [...plan.matrix.runnable, ...plan.matrix.refused].map(
      (entry) => entry.cell.engine,
    );
    expect(browsers).toEqual(['chromium']);
    expect(plan.uncaptured.map((pair) => pair.plan.baselineBrowser)).not.toContain(
      '<default>:MSEDGE_DEV',
    );
  });

  it('does the same for a bare version RANGE, which is a claim about one release train', () => {
    const spec = visualTestSpecSchema.parse({
      matrix: { versions: [{ kind: 'RANGE', range: { atLeast: '120', below: null, why: 'ships' } }] },
    });
    const plan = planVisualBaselines(spec, 'seed');

    expect(
      [...plan.matrix.runnable, ...plan.matrix.refused].map((entry) => entry.cell.engine),
    ).toEqual(['chromium']);
  });

  it('does NOT widen a DECLARED engines axis, because no rule of a visual spec says to', () => {
    /*
     * THE OTHER HALF, and the reason `impliedEngineAxis` is used here rather
     * than `engineAxisFor`. "A matrix must still include chromium" is a rule
     * `crossBrowserSpecSchema` STATES and `visualTestSpecSchema` does not — it
     * has no `browsers` field to be a floor. Forcing chromium in would add a
     * cell this plugin cannot capture (the floor cell is already chromium and
     * is the only one captured), report it as one more uncaptured pair, and
     * charge it against VISUAL_MAX_CELLS — narrowing the disclosure of the
     * cells the author actually asked for.
     */
    const spec = visualTestSpecSchema.parse({ matrix: { engines: ['webkit'] } });
    const plan = planVisualBaselines(spec, 'seed');

    expect(
      [...plan.matrix.runnable, ...plan.matrix.refused].map((entry) => entry.cell.engine),
    ).toEqual(['webkit']);
    // One declared cell plus the floor, so exactly ONE pair goes uncaptured.
    expect(plan.uncaptured).toHaveLength(1);
  });

  it('plans the test when one value is written twice, instead of refusing the WHOLE of it', () => {
    /*
     * ONE DECISION TYPED TWICE IS NOT TWO CELLS. `visualTestSpecSchema.matrix`
     * is the same `matrixAxesSchema` the CROSS_BROWSER spec carries and accepts
     * the same repeat, which used to expand to two identical cells; `planMatrix`
     * reports a duplicate as a problem, and the refusal in `planVisualBaselines`
     * returned the entire test as NOT_RUN — no capture, no comparison, no
     * baseline — for a spec with nothing wrong in it.
     *
     * Driven over a repeat on EVERY axis the way the cross-browser plan is,
     * and asserted on the OUTCOME (a captured pair, no refusal) rather than on
     * a key, so the test is about the loss and not about a spelling.
     */
    const repeats: ReadonlyArray<Record<string, unknown[]>> = [
      { engines: ['webkit', 'webkit'] },
      { channels: ['MSEDGE_DEV', 'MSEDGE_DEV'] },
      { colourSchemes: ['DARK', 'DARK'] },
      { reducedMotion: ['REDUCE', 'REDUCE'] },
      { forcedColors: ['ACTIVE', 'ACTIVE'] },
      { locales: ['de-DE', 'de-DE'] },
      { timezones: ['UTC', 'UTC'] },
      { devices: [{ kind: 'PRESET', preset: 'IPHONE_14' }, { kind: 'PRESET', preset: 'IPHONE_14' }] },
    ];
    for (const matrix of repeats) {
      const axis = Object.keys(matrix)[0]!;
      const plan = planVisualBaselines(visualTestSpecSchema.parse({ matrix }), 'seed');
      expect(plan.refusal, `a repeated ${axis} value refused the whole test`).toBeNull();
      expect(plan.captured, `a repeated ${axis} value captured nothing`).not.toBeNull();
    }
  });

  it('still refuses two DIFFERENT declarations that expand to one cell', () => {
    /*
     * The over-fix, pinned. Deduplication is by deep VALUE: two device viewports
     * of one size that differ only in user agent are two real cells that key
     * alike, and the refusal is loud and correct until the door says so. A
     * dedupe that collapsed them would silently drop one of the author's two
     * decisions.
     */
    const sameScreen = (userAgent: string) => ({
      kind: 'VIEWPORT' as const,
      viewport: { width: 1280, height: 800, userAgent },
    });
    const plan = planVisualBaselines(
      visualTestSpecSchema.parse({ matrix: { devices: [sameScreen('one'), sameScreen('two')] } }),
      'seed',
    );
    expect(plan.refusal?.kind).toBe('NOT_RUN');
    expect(plan.refusal?.why).toContain('declared more than once');
  });

  it('leaves a locale or a device keying the default sentinel, which is a real answer', () => {
    /*
     * The narrowness that keeps the repair honest: a locale, a zone, a device
     * or a rendering preference says NOTHING about the engine, so an absent
     * engine axis is the truthful plan and `'<default>'` is the answer, not a
     * gap. Anchoring those would name a build nobody chose.
     */
    const spec = visualTestSpecSchema.parse({
      matrix: { locales: ['de-DE'], devices: [{ kind: 'PRESET', preset: 'IPHONE_14' }] },
    });
    const plan = planVisualBaselines(spec, 'seed');

    for (const entry of [...plan.matrix.runnable, ...plan.matrix.refused]) {
      expect(entry.cell.engine).toBeUndefined();
    }
  });

  it('keeps the floor cell byte-identical while anchoring the rest', () => {
    // The whole safety argument for touching this function: no baseline a
    // customer has approved may be re-identified. The floor cell is the only
    // one that becomes a `VisualBaseline` row, and it is unchanged.
    const spec = visualTestSpecSchema.parse({ matrix: { channels: ['MSEDGE_DEV'] } });
    const plan = planVisualBaselines(spec, 'seed');

    expect(plan.captured?.baselineViewport).toBe('1280x800');
    expect(plan.captured?.baselineBrowser).toBe('chromium');
  });

  it('validates the spec shape and names the test in the message', () => {
    expect(() => visualPlugin.validate(visualTest({ pixelThreshold: 4 }))).toThrow(
      /the pricing page looks right/,
    );
    expect(() => visualPlugin.validate(visualTest({}))).not.toThrow();
  });
});
