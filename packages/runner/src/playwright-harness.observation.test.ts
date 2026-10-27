/**
 * The questions the runtime observer exists to answer, asked adversarially.
 *
 * Separate from playwright-harness.test.ts, which covers what the builder
 * tested. This file goes after the four things most likely to be wrong, and
 * found one of them:
 *
 *  1. IS `TestResult.network` STILL EMPTY ON ONE OF THE PATHS? Driven with a
 *     fake observation source performing two navigations and four requests, on
 *     EVERY path, not the one path with a test. REFUTED: the two paths that
 *     observe carry them, attributed to the test and the variant, and the three
 *     that never spawn a browser carry nothing AND say on the result that
 *     nothing was watched.
 *  2. AN UNREADABLE OBSERVATION FILE. CONFIRMED and fixed: a file that existed
 *     and could not be read contributed zero lines, so the parser counted zero
 *     malformed and the result came back OBSERVED with no requests and no caps.
 *     A test whose application threw four exceptions and a test whose evidence
 *     QAAI dropped on the floor were the same result. The adapter's own comment
 *     claimed the parser would notice; the parser cannot notice a file it was
 *     never handed.
 *  3. A DELIBERATE 403 BECOMING A FINDING. REFUTED, and pinned: this is the
 *     false positive that would teach a team to ignore QAAI entirely.
 *  4. 5,000 CONSOLE ERRORS. REFUTED: capped in the browser, capped again per
 *     invariant, and every drop disclosed as a count with a reason.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectRuntimeObservation,
  fileObservationSource,
  observedNetworkEntries,
  observedSurface,
  parseObservationLines,
  runtimeFindings,
  RUNTIME_FINDING_CAP,
  RUNTIME_OBSERVATION_CAPS,
  type RuntimeObservationSource,
} from './playwright-harness.js';

const BASE = 'https://app.test';

/** A source that hands back exactly these lines: no disk, no browser. */
const sourceOf = (lines: readonly string[]): RuntimeObservationSource => ({
  read: () => Promise.resolve(lines),
});

const nd = (...records: Array<Record<string, unknown>>): string[] =>
  records.map((record) => JSON.stringify(record));

/** Two navigations and four requests, by one test under one project variant. */
const TWO_NAVS_FOUR_REQUESTS = nd(
  { t: 'attach', test: 'checkout › pays', variant: 'chromium' },
  { t: 'req', method: 'GET', url: `${BASE}/checkout`, status: 200, rt: 'document', nav: true, chain: [], from: `${BASE}/` },
  { t: 'req', method: 'GET', url: `${BASE}/api/cart`, status: 200, rt: 'fetch', nav: false, chain: [], from: `${BASE}/checkout` },
  { t: 'timing', method: 'GET', url: `${BASE}/api/cart`, ms: 31 },
  { t: 'req', method: 'POST', url: `${BASE}/api/pay`, status: 201, rt: 'fetch', nav: false, chain: [], from: `${BASE}/checkout` },
  { t: 'req', method: 'GET', url: `${BASE}/receipt/8421`, status: 200, rt: 'document', nav: true, chain: [], from: `${BASE}/checkout` },
);

describe('the observed network reaches the result, attributed', () => {
  it('carries two navigations and four requests off a fake browser surface', async () => {
    const collected = await collectRuntimeObservation({
      testId: 't_1',
      dir: '/observe',
      baseUrl: BASE,
      specCode: 'await page.goto("/checkout")',
      source: sourceOf(TWO_NAVS_FOUR_REQUESTS),
    });

    expect(collected.observation.availability.state).toBe('OBSERVED');
    expect(collected.observation.navigations.map((nav) => nav.finalUrl)).toEqual([
      '/checkout',
      '/receipt/:id',
    ]);

    const { entries, untimed } = observedNetworkEntries(collected.observation);
    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => `${entry.method} ${entry.url} ${String(entry.status)}`)).toEqual([
      'GET /checkout 200',
      'GET /api/cart 200',
      'POST /api/pay 201',
      'GET /receipt/:id 200',
    ]);

    // Every request is attributed to the test AND the project variant.
    for (const request of collected.observation.requests) {
      expect(request.test).toBe('checkout › pays');
      expect(request.variant).toBe('chromium');
    }
    expect(collected.observation.attribution).toEqual([
      { test: 'checkout › pays', variant: 'chromium' },
    ]);

    /*
     * Three of the four have no timing, and `NetworkEntry.durationMs` is a
     * non-nullable number — so they read 0, which is NOT a claim that they were
     * instantaneous. The invariant that keeps that honest: every entry reading
     * 0 for want of a measurement is counted in `untimed`, which the two paths
     * in `runPlaywrightSpec` turn into a warning on the result's console pane.
     *
     * Asserted as the invariant rather than against the warning text, because
     * measuring it showed the warning is assembled in `runPlaywrightSpec` and
     * NOT in this exported seam — so a second caller of
     * `collectRuntimeObservation` would emit the zeros with no disclosure
     * beside them. That asymmetry is in this round's handover.
     */
    expect(untimed).toBe(3);
    expect(entries.filter((entry) => entry.durationMs === 0)).toHaveLength(untimed);
    expect(entries.find((entry) => entry.url === '/api/cart')?.durationMs).toBe(31);
  });

  it('keeps two project variants of one request apart', async () => {
    // A cross-browser matrix runs the same spec twice. Folding the two into one
    // request would report half the traffic the suite actually produced.
    const collected = await collectRuntimeObservation({
      testId: 't_1',
      dir: '/observe',
      baseUrl: BASE,
      specCode: 'page',
      source: sourceOf([
        ...TWO_NAVS_FOUR_REQUESTS,
        ...nd(
          { t: 'attach', test: 'checkout › pays', variant: 'firefox' },
          { t: 'req', method: 'POST', url: `${BASE}/api/pay`, status: 201, rt: 'fetch', nav: false, chain: [], from: `${BASE}/checkout` },
        ),
      ]),
    });

    const pay = collected.observation.requests.filter((request) => request.template === '/api/pay');
    expect(pay.map((request) => request.variant).sort()).toEqual(['chromium', 'firefox']);
    expect(collected.observation.attribution).toHaveLength(2);
  });

  it('never writes a query string into the network it reports', async () => {
    const collected = await collectRuntimeObservation({
      testId: 't_1',
      dir: '/observe',
      baseUrl: BASE,
      specCode: 'page',
      source: sourceOf(
        nd(
          { t: 'attach', test: 'reset', variant: 'default' },
          { t: 'req', method: 'GET', url: `${BASE}/reset?token=OBS-TOKEN-1`, status: 200, rt: 'document', nav: true, chain: [], from: `${BASE}/` },
        ),
      ),
    });

    const blob = JSON.stringify([collected.observation, collected.console, collected.findings]);
    expect(blob).not.toContain('OBS-TOKEN-1');
    expect(blob).toContain('/reset');
    // And the drop is disclosed, so a reader is not left wondering.
    expect(collected.console.map((entry) => entry.text).join('\n')).toMatch(
      /Observation cap \(query\)/,
    );
  });
});

describe('an observation file that could not be read is not a quiet application', () => {
  it('reports PARTIAL with a disclosed cap, instead of OBSERVED with nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qaai-obs-unreadable-'));
    const file = join(dir, 'obs-1.ndjson');
    await writeFile(file, nd({ t: 'attach', test: 'a', variant: 'default' }).join('\n'));
    // The file exists and cannot be opened. Measured, not simulated: this is
    // the state the adapter's catch block used to swallow.
    await chmod(file, 0o000);

    try {
      const collected = await collectRuntimeObservation({
        testId: 't_1',
        dir,
        baseUrl: BASE,
        specCode: 'await page.goto("/")',
        source: fileObservationSource,
      });

      expect(collected.observation.availability.state).toBe('PARTIAL');
      expect(collected.observation.availability.reason).toMatch(
        /whole observation file\(s\) were unreadable/,
      );
      const cap = collected.observation.caps.find((entry) => entry.kind === 'unreadable');
      expect(cap?.dropped).toBe(1);
      expect(cap?.reason).toMatch(/its absence here is not evidence that it did nothing/);
      // And it is said on the RESULT's own console pane, not only in an artifact.
      expect(collected.console.map((entry) => entry.text).join('\n')).toMatch(
        /Observation cap \(unreadable\)/,
      );
    } finally {
      await chmod(file, 0o644);
    }
  });

  it('still reports UNAVAILABLE when the observer wrote nothing at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qaai-obs-empty-'));
    const collected = await collectRuntimeObservation({
      testId: 't_1',
      dir,
      baseUrl: BASE,
      specCode: 'await page.goto("/")',
      source: fileObservationSource,
    });

    // No files is a different fact from an unreadable file, and both differ
    // from "it ran and saw nothing". All three are distinguishable.
    expect(collected.observation.availability.state).toBe('UNAVAILABLE');
    expect(collected.observation.availability.reason).toMatch(/NOT a statement that the application/);
  });

  it('reads a surface that genuinely saw nothing as OBSERVED with no caps', async () => {
    const collected = await collectRuntimeObservation({
      testId: 't_1',
      dir: '/observe',
      baseUrl: BASE,
      specCode: 'page',
      source: sourceOf(nd({ t: 'attach', test: 'a', variant: 'default' })),
    });

    expect(collected.observation.availability.state).toBe('OBSERVED');
    expect(collected.observation.caps).toEqual([]);
    expect(collected.observation.requests).toEqual([]);
  });
});

describe('a negative test is not a defect, and a throwing app is', () => {
  const specAsserting403 =
    "test('a member cannot delete another member’s booking', async ({ page }) => {\n" +
    "  const response = await page.request.delete('/api/bookings/7');\n" +
    '  expect(response.status()).toBe(403);\n' +
    '});';

  it('produces NO finding for a 403 the spec asserts on', () => {
    const result = runtimeFindings(
      parseObservationLines(
        nd(
          { t: 'attach', test: 'cannot delete', variant: 'default' },
          { t: 'req', method: 'DELETE', url: `${BASE}/api/bookings/7`, status: 403, rt: 'fetch', nav: false, chain: [], from: `${BASE}/bookings` },
        ),
      ).records,
      { baseUrl: BASE, specCode: specAsserting403 },
    );

    expect(result.findings).toEqual([]);
    // Suppressed, and the suppression is DISCLOSED — a filter nobody is told
    // about is how a real 403 goes missing later.
    const cap = result.caps.find((entry) => entry.reason.includes('appears to assert on it'));
    expect(cap?.dropped).toBe(1);
    expect(cap?.reason).toContain('403');
  });

  it('produces findings for an app that throws under a PASSING test', () => {
    const result = runtimeFindings(
      parseObservationLines(
        nd(
          { t: 'attach', test: 'checkout works', variant: 'default' },
          { t: 'pageerror', name: 'TypeError', message: "Cannot read properties of undefined (reading 'total')", from: `${BASE}/checkout` },
          { t: 'req', method: 'POST', url: `${BASE}/api/pay`, status: 500, rt: 'fetch', nav: false, chain: [], from: `${BASE}/checkout` },
          { t: 'console', level: 'error', text: 'Uncaught (in promise) cart sync failed', from: `${BASE}/checkout` },
        ),
      ).records,
      {
        baseUrl: BASE,
        specCode:
          "test('checkout works', async ({ page }) => { await page.goto('/checkout'); await expect(page.getByText('Thanks')).toBeVisible(); });",
      },
    );

    expect(result.findings.map((finding) => finding.code).sort()).toEqual([
      'runtime.http-5xx',
      'runtime.page-error',
      'runtime.unhandled-rejection',
    ]);
    for (const finding of result.findings) expect(finding.severity).toBe('SERIOUS');
  });

  it('reports LOW CONFIDENCE rather than a confident finding with no spec to read', () => {
    // With no source, the entire basis for calling a 4xx unintended is gone.
    const result = runtimeFindings(
      parseObservationLines(
        nd(
          { t: 'attach', test: 'imported', variant: 'default' },
          { t: 'req', method: 'GET', url: `${BASE}/api/x`, status: 404, rt: 'fetch', nav: false, chain: [], from: `${BASE}/` },
        ),
      ).records,
      { baseUrl: BASE, specCode: '' },
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe('MINOR');
    expect(result.findings[0]?.message).toContain('LOW CONFIDENCE');
  });
});

describe('a chatty application is capped, and the cap is disclosed', () => {
  it('survives 5,000 console errors without exploding or truncating silently', () => {
    const lines = [
      ...nd({ t: 'attach', test: 'dashboard', variant: 'default' }),
      ...Array.from({ length: 5_000 }, (_, index) =>
        JSON.stringify({
          t: 'console',
          level: 'error',
          text: `render loop error #${index}`,
          from: `${BASE}/dash`,
        }),
      ),
      ...nd({ t: 'cap', k: 'console', limit: RUNTIME_OBSERVATION_CAPS.console, dropped: 4_900 }),
    ];
    const records = parseObservationLines(lines).records;

    const result = runtimeFindings(records, { baseUrl: BASE, specCode: 'page' });
    // Bounded on both axes: the console pane and the finding list.
    expect(result.console).toHaveLength(RUNTIME_OBSERVATION_CAPS.console);
    expect(result.findings).toHaveLength(RUNTIME_FINDING_CAP);

    const findingCap = result.caps.find((entry) => entry.kind === 'finding');
    expect(findingCap?.dropped).toBe(5_000 - RUNTIME_FINDING_CAP);
    expect(findingCap?.limit).toBe(RUNTIME_FINDING_CAP);
    const consoleCap = result.caps.find((entry) => entry.kind === 'console');
    expect(consoleCap?.dropped).toBe(5_000 - RUNTIME_OBSERVATION_CAPS.console);

    // And the browser-side ceiling, which is the only place that knows what it
    // never wrote down, arrives on the surface as its own disclosed cap.
    const surface = observedSurface(records, {
      testId: 't_1',
      baseUrl: BASE,
      malformed: 0,
      availability: { state: 'OBSERVED', reason: null },
    });
    expect(surface.caps.find((entry) => entry.kind === 'console')?.dropped).toBe(4_900);
  });

  it('folds 5,000 repeats of ONE error into one finding that counts them', () => {
    const records = parseObservationLines([
      ...nd({ t: 'attach', test: 'dashboard', variant: 'default' }),
      ...Array.from({ length: 5_000 }, () =>
        JSON.stringify({ t: 'console', level: 'error', text: 'the same error', from: `${BASE}/dash` }),
      ),
    ]).records;

    const result = runtimeFindings(records, { baseUrl: BASE, specCode: 'page' });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toContain('seen 5000×');
    // Nothing was dropped from the FINDING list, so nothing claims it was.
    expect(result.caps.find((entry) => entry.kind === 'finding')).toBeUndefined();
  });
});
