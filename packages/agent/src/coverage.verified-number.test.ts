/**
 * THE NUMBER ITSELF, CHECKED AGAINST A FIXTURE WHOSE ANSWER IS KNOWN BY
 * CONSTRUCTION.
 *
 * `coverage.test.ts` is the honesty suite for GAPS — the claims this analysis
 * must not make about a team's work. This file is the adversarial suite for the
 * PERCENTAGE: one fixture of 20 routes, 2 journeys, 4 forms and 30 controls,
 * with every category of cover the product distinguishes deliberately placed in
 * it, so each figure in the response can be recomputed by hand and compared.
 *
 * It is a SEPARATE FILE and not an addition to `coverage.test.ts` for the same
 * reason `surface-inventory.denominator.test.ts` and
 * `route-manifest.provenance.test.ts` are separate: one question, one fixture,
 * and a reader who wants to know whether the headline can be trusted should not
 * have to read 2,000 lines of gap assertions to find out.
 *
 * Every case below was written by RUNNING the report and comparing, not by
 * reading the implementation and restating it. Three of them lock a defect this
 * file's investigation found and fixed; those three say so, and say what the
 * code did before.
 */

import { describe, expect, it } from 'vitest';
import {
  COVERAGE_AXIS_WEIGHT,
  analyzeCoverage,
  type CoverageExecutionFact,
  type CoverageReport,
  type CoverageTestInput,
} from './coverage.js';

// ─── The ground-truth fixture ────────────────────────────────────────────────

const sel = (name: string) => ({
  strategy: 'ROLE' as const,
  value: 'button',
  name,
  confidence: 0.9,
});

function node(over: {
  id: string;
  route: string;
  forms?: unknown[];
  affordances?: unknown[];
}): Record<string, unknown> {
  return {
    id: over.id,
    route: over.route,
    url: `https://gt.test${over.route}`,
    title: over.route,
    stateKey: 'default',
    requiresRoles: [],
    behindAuth: false,
    forms: over.forms ?? [],
    affordances: over.affordances ?? [],
    screenshotKey: null,
    a11yViolationCount: 0,
  };
}

function form(name: string, fields: string[]): Record<string, unknown> {
  return {
    id: `form-${name}`,
    name,
    selector: { strategy: 'CSS', value: 'form', confidence: 0.7 },
    submit: sel(`Submit ${name}`),
    fields: fields.map((label) => ({
      name: label.toLowerCase().replace(/\s+/g, '_'),
      label,
      inputType: 'text',
      required: true,
      selector: { strategy: 'LABEL', value: label, name: label, confidence: 0.9 },
      semantic: 'freeform',
    })),
  };
}

/**
 * 20 routes (`/r0`…`/r19`), 4 forms (on `/r0`…`/r3`), 30 controls (3 each on
 * `/r0`…`/r9`), 2 journeys.
 *
 * `extraControls` pads `/r0` with more buttons and nothing else, which is the
 * lever for the weighting test: it grows ONE axis's denominator and leaves the
 * other three untouched.
 */
function gtGraph(extraControls = 0): Record<string, unknown> {
  const nodes: Record<string, unknown>[] = [];
  for (let index = 0; index < 20; index += 1) {
    const forms = index < 4 ? [form(`F${index}`, [`Field ${index}A`, `Field ${index}B`])] : [];
    const affordances: Record<string, unknown>[] =
      index < 10
        ? [0, 1, 2].map((slot) => ({
            label: `Control ${index}-${slot}`,
            selector: sel(`Control ${index}-${slot}`),
            kind: 'button',
          }))
        : [];
    if (index === 0) {
      for (let pad = 0; pad < extraControls; pad += 1) {
        affordances.push({ label: `Filler ${pad}`, selector: sel(`Filler ${pad}`), kind: 'button' });
      }
    }
    nodes.push(node({ id: `n${index}`, route: `/r${index}`, forms, affordances }));
  }
  const edges = [];
  for (let index = 1; index < 20; index += 1) {
    edges.push({
      id: `e${index}`,
      from: 'n0',
      to: `n${index}`,
      action: `click "to r${index}"`,
      selector: null,
    });
  }
  return {
    projectId: 'gt',
    environmentId: 'gte',
    version: 7,
    baseUrl: 'https://gt.test',
    exploredAt: '2026-10-01T00:00:00.000Z',
    truncatedReason: null,
    nodes,
    edges,
    journeys: [
      {
        id: 'j0',
        name: 'Journey zero',
        description: 'r0 to r1',
        edgeIds: ['e1'],
        priority: 'CRITICAL_PATH',
        roles: [],
      },
      {
        id: 'j1',
        name: 'Journey one',
        description: 'r0 to r2',
        edgeIds: ['e2'],
        priority: 'IMPORTANT',
        roles: [],
      },
    ],
    features: [{ name: 'All', nodeIds: nodes.map((item) => (item as { id: string }).id) }],
  };
}

const test_ = (over: Partial<CoverageTestInput> & { id: string }): CoverageTestInput => ({
  name: over.id,
  filePath: `specs/${over.id}.spec.ts`,
  feature: null,
  priority: 'IMPORTANT',
  testType: 'E2E',
  tags: [],
  routes: [],
  code: null,
  ...over,
});

/**
 * Nine tests, covering ten routes, in the five states the product treats
 * differently:
 *
 *   · `t-pass-0`…`t-pass-5` — 6 routes, PASSED, each also quoting one control.
 *   · `t-fail`              — 2 routes (`/r6`, `/r7`), always FAILED.
 *   · `t-quarantine`        — 1 route (`/r8`), passing but quarantined.
 *   · `t-neverran`          — 1 route (`/r9`), no TestResult at all.
 */
function gtTests(): CoverageTestInput[] {
  const out: CoverageTestInput[] = [];
  for (let index = 0; index < 6; index += 1) {
    out.push(
      test_({
        id: `t-pass-${index}`,
        routes: [`/r${index}`],
        code: `await page.goto('/r${index}'); await expect(page.getByRole('button', { name: 'Control ${index}-0' })).toBeVisible();`,
      }),
    );
  }
  out.push(
    test_({ id: 't-fail', routes: ['/r6', '/r7'], code: `await page.goto('/r6');` }),
  );
  out.push(test_({ id: 't-quarantine', routes: ['/r8'], code: `await page.goto('/r8');` }));
  out.push(test_({ id: 't-neverran', routes: ['/r9'], code: `await page.goto('/r9');` }));
  return out;
}

/** `t-neverran` is ABSENT on purpose: asked, and it has never produced a result. */
function gtExecutions(): CoverageExecutionFact[] {
  const out: CoverageExecutionFact[] = [];
  for (let index = 0; index < 6; index += 1) {
    out.push({
      testId: `t-pass-${index}`,
      runId: 'run1',
      status: 'PASSED',
      atIso: '2026-10-20T00:00:00.000Z',
    });
  }
  out.push({ testId: 't-fail', runId: 'run1', status: 'FAILED', atIso: '2026-10-20T00:00:00.000Z' });
  out.push({
    testId: 't-quarantine',
    runId: 'run1',
    status: 'PASSED',
    atIso: '2026-10-20T00:00:00.000Z',
    quarantined: true,
  });
  return out;
}

const groundTruth = (extraControls = 0): CoverageReport =>
  analyzeCoverage({
    flowMapGraph: gtGraph(extraControls),
    tests: gtTests(),
    executions: gtExecutions(),
  });

const axis = (report: CoverageReport, name: 'ROUTE' | 'JOURNEY' | 'FORM' | 'CONTROL') =>
  report.headline.axes.find((reading) => reading.axis === name)!;

// ─── (a) The headline is arithmetic a reader can redo ───────────────────────

describe('the headline can be recomputed by hand from the response', () => {
  it('is the weighted mean of the four per-axis percentages, to the digit', () => {
    const report = groundTruth();

    // The denominators, by construction. If the fixture drifts, every number
    // below drifts with it, so they are asserted rather than assumed.
    expect(axis(report, 'ROUTE').denominator).toBe(20);
    expect(axis(report, 'JOURNEY').denominator).toBe(2);
    expect(axis(report, 'FORM').denominator).toBe(4);
    expect(axis(report, 'CONTROL').denominator).toBe(30);

    // Ten tests declare a route; `t-quarantine`'s does not count (see below).
    expect(axis(report, 'ROUTE').provenPercent).toBe(45);
    expect(axis(report, 'CONTROL').provenPercent).toBe(20);
    expect(axis(report, 'JOURNEY').provenPercent).toBe(0);
    expect(axis(report, 'FORM').provenPercent).toBe(0);

    const byHand =
      COVERAGE_AXIS_WEIGHT.ROUTE * 45 +
      COVERAGE_AXIS_WEIGHT.JOURNEY * 0 +
      COVERAGE_AXIS_WEIGHT.FORM * 0 +
      COVERAGE_AXIS_WEIGHT.CONTROL * 20;
    expect(byHand).toBeCloseTo(15.5, 10);
    expect(report.headline.lowerPercent).toBe(15.5);
  });

  it('does NOT move the way a sum of four denominators would when one axis grows', () => {
    const base = groundTruth();
    const padded = groundTruth(500);

    // CONTROL's own fraction collapses, which is correct and visible.
    expect(axis(padded, 'CONTROL').denominator).toBe(530);
    expect(axis(padded, 'CONTROL').provenPercent).toBe(1.1);
    // The other three axes are untouched by 500 buttons.
    expect(axis(padded, 'ROUTE').provenPercent).toBe(axis(base, 'ROUTE').provenPercent);

    // The headline may move by AT MOST CONTROL's weight times CONTROL's own
    // swing — a tenth of 18.9 points — because that is all the authority the
    // published table gives the most numerous axis. The sum this replaced moved
    // by 24 points on the same input, which is the defect in one number.
    const moved = base.headline.lowerPercent! - padded.headline.lowerPercent!;
    expect(moved).toBeCloseTo(1.9, 1);
    expect(moved).toBeLessThanOrEqual(COVERAGE_AXIS_WEIGHT.CONTROL * 100);

    const summed = (report: CoverageReport) => {
      const totals = report.totals;
      const numerator =
        totals.routesVisited +
        totals.journeysWalked +
        totals.formsExercised +
        totals.affordancesUsed;
      const denominator = totals.routes + totals.journeys + totals.forms + totals.affordances;
      return Math.round((numerator / denominator) * 100);
    };
    expect(summed(base) - summed(padded)).toBeGreaterThan(20);
  });
});

// ─── (b) The five kinds of cover, kept apart ────────────────────────────────

describe('each category of cover is counted the way the rules say', () => {
  it('counts a test that ALWAYS FAILS as coverage, and reports the failure separately', () => {
    const report = groundTruth();
    // Covered and failing are two facts. A build that "fixed" this into a lower
    // number would have broken a documented rule, so this is a guard against a
    // future correction as much as against a regression.
    for (const route of ['/r6', '/r7']) {
      const row = report.ledger.items.find((item) => item.key === `ROUTE:${route}`);
      expect(row?.testIds).toEqual(['t-fail']);
      expect(row?.execution?.status).toBe('COVERED');
      expect(row?.execution?.lastStatus).toBe('FAILED');
      expect(row?.execution?.ran).toBe(true);
    }
  });

  it('excludes a QUARANTINED cover from the numerator and reports it as a gap', () => {
    const report = groundTruth();
    // Ten routes have a declaring test; /r8's only one is quarantined, so nine.
    expect(axis(report, 'ROUTE').covered).toBe(9);
    expect(report.totals.routesVisited).toBe(9);
    expect(report.gaps.some((gap) => gap.route === '/r8' && gap.kind === 'UNVISITED_ROUTE')).toBe(
      true,
    );
    expect(report.caveats.join(' ')).toMatch(/quarantined/i);
  });

  it('keeps a quarantine-only item OUT of `ledger.total`, which its doc comment denied', () => {
    /*
     * THE DEFECT THIS LOCKS. The field's doc comment read "These are counted in
     * `total` — somebody did write a test", and they are not: `buildLedger`
     * takes `total` from `rows.length` and a quarantine-only item has no row.
     * A reader who believed the sentence would have subtracted this count out of
     * `total` and undercounted their own coverage.
     */
    const report = groundTruth();
    expect(report.ledger.coveredOnlyByQuarantined).toBe(1);
    expect(report.ledger.items.some((item) => item.key === 'ROUTE:/r8')).toBe(false);
    expect(report.ledger.total).toBe(report.ledger.items.length);
  });

  it('reports a NEVER-RUN cover as ASSERTED_NOT_RUN, and discloses that the numerator counts it', () => {
    /*
     * THE DEFECT THIS LOCKS. `/r9`'s only test has no TestResult. Its ledger
     * row says ASSERTED_NOT_RUN and "written is not run"; the ROUTE numerator
     * counts it anyway. Two surfaces of one report gave one item two answers,
     * and nothing on the response said so. The asymmetry is still there — a
     * quarantined cover is excluded and a never-run one is not — but it is now
     * a stated count rather than a silent one, which is the difference between
     * a disclosed limitation and coverage attributed to a test that never ran.
     */
    const report = groundTruth();
    const row = report.ledger.items.find((item) => item.key === 'ROUTE:/r9');
    expect(row?.execution?.status).toBe('ASSERTED_NOT_RUN');
    expect(row?.execution?.ran).toBe(false);
    expect(row?.execution?.why).toMatch(/written is not run/);

    expect(report.ledger.neverRun).toBe(1);
    const disclosure = report.caveats.find((caveat) => /ASSERTED_NOT_RUN/.test(caveat));
    expect(disclosure).toBeDefined();
    expect(disclosure).toMatch(/1 of the \d+ covered items/);
    expect(disclosure).toMatch(/no run has executed/);
    expect(disclosure).toMatch(/ledger\.neverRun/);
  });

  it('reports `neverRun` as NULL, not 0, when no caller asked the database', () => {
    const report = analyzeCoverage({ flowMapGraph: gtGraph(), tests: gtTests() });
    expect(report.ledger.neverRun).toBeNull();
    // And says nothing about never-run tests, because nothing was asked.
    expect(report.caveats.some((caveat) => /ASSERTED_NOT_RUN/.test(caveat))).toBe(false);
  });
});

// ─── (c) The bound: the lower edge is proven matches and nothing else ───────

describe('the lower edge of the interval counts only proven matches', () => {
  it('excludes a control established by a bare substring from `provenCovered`', () => {
    const report = analyzeCoverage({
      flowMapGraph: gtGraph(),
      tests: [
        // `Control 0-0` appears in the source but is never quoted.
        test_({ id: 'bare', routes: ['/r0'], code: `await page.goto('/r0'); // Control 0-0 here` }),
        test_({
          id: 'quoted',
          routes: ['/r0'],
          code: `await page.goto('/r0'); await page.getByRole('button', { name: 'Control 0-1' }).click();`,
        }),
      ],
      executions: [
        { testId: 'bare', runId: 'r', status: 'PASSED', atIso: '2026-10-20T00:00:00.000Z' },
        { testId: 'quoted', runId: 'r', status: 'PASSED', atIso: '2026-10-20T00:00:00.000Z' },
      ],
    });

    const control = axis(report, 'CONTROL');
    expect(control.covered).toBe(2);
    expect(control.provenCovered).toBe(1);
    expect(control.mentionOnly).toBe(1);
    // The two edges must actually differ, or the interval is decoration.
    expect(report.headline.lowerPercent!).toBeLessThan(report.headline.upperPercent!);
    expect(report.headline.quotes).toBe('lowerPercent');
  });
});

// ─── (d) The ratchet: a worse measurement cannot raise the number ───────────

describe('the reported percentage cannot rise because the measurement got worse', () => {
  it('falls when the MATCHER breaks, because the denominator is the crawl and not the tests', () => {
    const base = groundTruth();
    // A route extractor that reads nothing: the numerator empties, the
    // denominator is untouched, and the only possible direction is down.
    const blinded = analyzeCoverage({
      flowMapGraph: gtGraph(),
      tests: gtTests().map((test) => ({ ...test, routes: [] })),
      executions: gtExecutions(),
    });
    expect(axis(blinded, 'ROUTE').denominator).toBe(20);
    expect(axis(blinded, 'ROUTE').covered).toBe(0);
    expect(blinded.headline.lowerPercent!).toBeLessThan(base.headline.lowerPercent!);
  });

  it('discloses the weight it rests on when an axis stops being enumerated, because then it CAN rise', () => {
    /*
     * THE HOLE THIS LOCKS. An unmeasured axis must not count as 0%, so it
     * leaves the mean and the remaining weights are rescaled. The consequence
     * is that the number RISES when the ENUMERATOR degrades: stop finding the
     * journeys and forms that both sit at 0% here and the headline goes from
     * 15.5% to 38.8% with nothing about the suite changed. `renormalised: true`
     * was the only warning, and a boolean is not a number — so the share of the
     * published weight actually carried is in the sentence, with the comparison
     * a reader would otherwise make named as wrong.
     */
    const base = groundTruth();
    const graph = gtGraph();
    graph.journeys = [];
    for (const item of graph.nodes as Record<string, unknown>[]) item.forms = [];
    const degraded = analyzeCoverage({
      flowMapGraph: graph,
      tests: gtTests(),
      executions: gtExecutions(),
    });

    expect(degraded.headline.unmeasuredAxes).toEqual(['JOURNEY', 'FORM']);
    expect(degraded.headline.renormalised).toBe(true);
    // The rise is real and is the reason the disclosure has to exist.
    expect(degraded.headline.lowerPercent!).toBeGreaterThan(base.headline.lowerPercent!);

    // 0.3 (ROUTE) + 0.1 (CONTROL) of the published 1.
    expect(degraded.headline.why).toContain('0.4 of the published weight of 1');
    expect(degraded.headline.why).toMatch(/NOT comparable/);
    expect(degraded.headline.why).toMatch(/RISES if enumeration/);

    // And the opposite case says so too, rather than staying silent.
    expect(base.headline.renormalised).toBe(false);
    expect(base.headline.why).toContain('full published weight of 1');
  });
});

// ─── (e) A zero denominator is NULL, and never 0 or 100 ─────────────────────

describe('percent is null on a zero denominator', () => {
  it('reports null on every axis and for the headline when the crawl enumerated nothing', () => {
    const report = analyzeCoverage({
      flowMapGraph: {
        projectId: 'p',
        environmentId: 'e',
        version: 1,
        baseUrl: 'https://x.test',
        exploredAt: '2026-01-01T00:00:00.000Z',
        truncatedReason: null,
        nodes: [],
        edges: [],
        journeys: [],
        features: [],
      },
      tests: [],
      executions: [],
    });
    expect(report.headline.lowerPercent).toBeNull();
    expect(report.headline.upperPercent).toBeNull();
    expect(report.headline.range).toBeNull();
    for (const reading of report.headline.axes) expect(reading.percent).toBeNull();
    expect(report.headline.why).toContain('NOT 0% coverage');
  });
});

// ─── (f) The cap on the uncovered list, and what it hides ───────────────────

describe('the per-axis gap cap, and the count it must not hide', () => {
  it('lists 40 of 830 uncovered controls and names the full count in a caveat', () => {
    /*
     * THE CAP TEST. 830 uncovered controls, no tests. MAX_AFFORDANCE_GAPS is 40
     * and it is applied INSIDE the analysis, so no page size and no chain of
     * cursors on the API can reach the other 790. That is a legitimate cap on a
     * report nobody could read otherwise — what it may not be is silent, and
     * `totals.gaps` is NOT the count of uncovered items, which the endpoint's
     * own `page.rule` used to imply it was.
     */
    const report = analyzeCoverage({ flowMapGraph: gtGraph(800), tests: [], executions: [] });

    expect(report.totals.affordances).toBe(830);
    expect(report.totals.affordancesUsed).toBe(0);

    const controlGaps = report.gaps.filter((gap) => gap.kind === 'UNUSED_AFFORDANCE');
    expect(controlGaps).toHaveLength(40);
    // The uncapped truth, as a count and a reason, in the payload.
    const caveat = report.caveats.find((entry) => /never mentioned by any test/.test(entry));
    expect(caveat).toContain('830 controls');
    expect(caveat).toContain('40 highest-scoring');
    // `totals.gaps` counts the LIST, which is 790 short of the finding.
    expect(report.totals.gaps).toBeLessThan(report.totals.affordances);
  });
});
