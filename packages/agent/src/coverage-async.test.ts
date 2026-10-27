/**
 * WHETHER THE ASYNC DENOMINATOR TELLS THE TRUTH ABOUT WEAK EVIDENCE.
 *
 * The five questions this file settles, in the order they would cost money:
 *
 *   1. DOES A UNIT-TESTED HANDLER REPORT AS PASSING? It must not. A cron whose
 *      handler is green and whose schedule was deleted last quarter passes
 *      every one of those tests, so `ASYNC_REACH_REACHED_SURFACE.HANDLER_CALLED`
 *      is `false` and the cell is held at DECLARED. The mutation that flips it
 *      to `true` is the single most expensive one available in this module, and
 *      `holds a handler-only cell at DECLARED` is the test that catches it.
 *   2. IS "WE NEVER LOOKED" TOLD APART FROM "THERE ARE NONE"? Two opposite
 *      facts an empty surface list cannot distinguish, which is why
 *      `enumerated` is a required total record.
 *   3. IS A LOW-CONFIDENCE SURFACE COUNTED? Yes — dropping it would raise the
 *      percentage on the strength of our own uncertainty — and SAID.
 *   4. ARE THE TWO AXES KEPT APART? A cron and an email template are two things
 *      to test, so there is no combined percentage anywhere in the output.
 *   5. IS THE CELL KEY THE ONE FORMAT? Built by `dimensionCellIdentity` and
 *      round-tripped through its parser, because a second format would make
 *      this dimension silently uncomparable to every other one.
 */

import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_SURFACE_DIMENSION,
  BACKGROUND_SURFACE_KINDS,
  COVERAGE_DIMENSIONS,
  COVERAGE_DIMENSION_DESCRIPTORS,
  COVERAGE_TIERS,
  backgroundSurfaceAxis,
  dimensionPercentAt,
  dimensionWasMeasured,
  parseDimensionCellIdentity,
} from '@qaai/shared';
import type { BackgroundSurfaceFact, SurfaceWaiver } from '@qaai/shared';
import {
  ASYNC_DETECTION_BASES,
  ASYNC_DETECTION_BASIS_KINDS,
  ASYNC_DETECTION_BASIS_LABELS,
  ASYNC_DETECTION_CONFIDENCE,
  ASYNC_DIMENSIONS,
  ASYNC_REACHES,
  ASYNC_REACH_ASSERTED_EFFECT,
  ASYNC_REACH_EVIDENCE,
  ASYNC_REACH_RANK,
  ASYNC_REACH_REACHED_SURFACE,
  LOW_CONFIDENCE_ASYNC_BASES,
  MAX_ASYNC_CELLS,
  MINIMUM_TRIGGERED_REACH,
  asyncCellIdentity,
  asyncCellKey,
  asyncDimensionFor,
  asyncRollupItems,
  measureAsyncCoverage,
  type AsyncCoverageInput,
  type AsyncExercise,
  type AsyncSurfaceInput,
} from './coverage-async.js';
import { rollupCoverage } from './coverage-rollup.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = '2026-10-26T12:00:00.000Z';
const YESTERDAY = '2026-10-25T12:00:00.000Z';
const LAST_YEAR = '2025-10-25T12:00:00.000Z';

const cron: BackgroundSurfaceFact = {
  kind: 'CRON',
  expression: '0 3 * * *',
  handler: 'src/jobs/reminders.ts',
};
const queue: BackgroundSurfaceFact = {
  kind: 'QUEUE_CONSUMER',
  queue: 'billing',
  concurrency: 4,
  handler: 'src/jobs/billing.ts',
};
const webhook: BackgroundSurfaceFact = {
  kind: 'WEBHOOK_RECEIVER',
  path: '/api/webhooks/stripe',
  signatureScheme: 'stripe-signature',
};
const email: BackgroundSurfaceFact = {
  kind: 'OUTBOUND_EMAIL',
  templateId: 'invoice-reminder',
  sentBy: 'src/mail/invoices.ts',
};

const exercise = (over: Partial<AsyncExercise> = {}): AsyncExercise => ({
  reach: null,
  namedByTestIds: [],
  declaredByTestIds: [],
  runStatus: null,
  retriedAndPassed: false,
  quarantined: false,
  confirmedAtIso: null,
  ...over,
});

const surface = (
  fact: BackgroundSurfaceFact,
  over: Partial<AsyncSurfaceInput> = {},
): AsyncSurfaceInput => ({
  fact,
  basis: 'REGISTRATION_CALL',
  evidence: `fixture declared ${fact.kind}`,
  file: 'src/jobs/x.ts',
  exercise: null,
  waiver: null,
  tested: null,
  ...over,
});

const measure = (
  surfaces: readonly AsyncSurfaceInput[],
  over: Partial<AsyncCoverageInput> = {},
): ReturnType<typeof measureAsyncCoverage> =>
  measureAsyncCoverage({
    surfaces,
    enumerated: { BACKGROUND_JOB: true, NOTIFICATION: true },
    nowIso: NOW,
    ...over,
  });

/** A run that reached end to end and passed yesterday — the strongest honest input. */
const endToEnd = exercise({
  reach: 'END_TO_END',
  namedByTestIds: ['tst_1'],
  runStatus: 'PASSED',
  confirmedAtIso: YESTERDAY,
});

// ─── The vocabularies, and the two-mechanism guard ──────────────────────────

describe('the async vocabularies', () => {
  it('keeps the presence record and the array in step', () => {
    expect([...ASYNC_DETECTION_BASIS_KINDS].sort()).toEqual([...ASYNC_DETECTION_BASES].sort());
  });

  it('states a label and a confidence for every basis, so none is unaudited', () => {
    for (const basis of ASYNC_DETECTION_BASES) {
      expect(ASYNC_DETECTION_BASIS_LABELS[basis].length).toBeGreaterThan(0);
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(ASYNC_DETECTION_CONFIDENCE[basis]);
    }
  });

  it('derives the LOW list from the confidence record rather than listing it twice', () => {
    expect(LOW_CONFIDENCE_ASYNC_BASES).toEqual(['NAMING_CONVENTION']);
    for (const basis of LOW_CONFIDENCE_ASYNC_BASES) {
      expect(ASYNC_DETECTION_CONFIDENCE[basis]).toBe('LOW');
    }
  });

  it('lets exactly HANDLER_CALLED not reach the surface, which is the whole file', () => {
    const notReaching = ASYNC_REACHES.filter((reach) => !ASYNC_REACH_REACHED_SURFACE[reach]);
    expect(notReaching).toEqual(['HANDLER_CALLED']);
    expect(ASYNC_REACH_REACHED_SURFACE[MINIMUM_TRIGGERED_REACH]).toBe(true);
  });

  it('is monotonic: asserting an effect implies the trigger fired', () => {
    for (const reach of ASYNC_REACHES) {
      if (!ASYNC_REACH_ASSERTED_EFFECT[reach]) continue;
      expect(ASYNC_REACH_REACHED_SURFACE[reach]).toBe(true);
      expect(ASYNC_REACH_RANK[reach]).toBeGreaterThanOrEqual(
        ASYNC_REACH_RANK[MINIMUM_TRIGGERED_REACH],
      );
    }
    const ranks = ASYNC_REACHES.map((reach) => ASYNC_REACH_RANK[reach]);
    expect(ranks).toEqual([1, 2, 3, 4]);
    for (const reach of ASYNC_REACHES) {
      expect(ASYNC_REACH_EVIDENCE[reach].length).toBeGreaterThan(0);
    }
  });

  it('measures two axes, both of them real coverage dimensions', () => {
    expect(ASYNC_DIMENSIONS).toEqual(['BACKGROUND_JOB', 'NOTIFICATION']);
    for (const dimension of ASYNC_DIMENSIONS) {
      expect(COVERAGE_DIMENSIONS).toContain(dimension);
    }
  });

  it('pins its axis map to the keystone descriptors instead of to a string coincidence', () => {
    for (const kind of BACKGROUND_SURFACE_KINDS) {
      const dimension = asyncDimensionFor(kind);
      expect(COVERAGE_DIMENSION_DESCRIPTORS[dimension].cellAxis).toBe(backgroundSurfaceAxis(kind));
      expect(COVERAGE_DIMENSION_DESCRIPTORS[dimension].keyedOn).toContain(
        BACKGROUND_SURFACE_DIMENSION[kind],
      );
    }
    expect(asyncDimensionFor('OUTBOUND_EMAIL')).toBe('NOTIFICATION');
    expect(asyncDimensionFor('CRON')).toBe('BACKGROUND_JOB');
  });
});

// ─── 5. The cell key is the one format ──────────────────────────────────────

describe('cell identity', () => {
  it('builds the identity with dimensionCellIdentity and round-trips it', () => {
    const identity = asyncCellIdentity(cron);
    expect(parseDimensionCellIdentity(identity)).toEqual({
      base: 'CRON',
      coordinates: [{ dimension: 'JOB', value: '0 3 * * *|src/jobs/reminders.ts' }],
    });
    expect(asyncCellKey(cron)).toBe(`BACKGROUND_JOB:${identity}`);
    expect(asyncCellKey(email)).toBe(`NOTIFICATION:${asyncCellIdentity(email)}`);
  });

  it('keeps a WEBSOCKET and an SSE at the same path as two cells', () => {
    const path = '/stream';
    const sockets = asyncCellKey({ kind: 'WEBSOCKET', path, events: [] });
    const sse = asyncCellKey({ kind: 'SSE', path, events: [] });
    expect(sockets).not.toBe(sse);
  });

  it('percent-encodes a value that would otherwise forge a second coordinate', () => {
    const identity = asyncCellIdentity({
      kind: 'QUEUE_CONSUMER',
      queue: 'a|JOB=b',
      concurrency: null,
      handler: null,
    });
    const parsed = parseDimensionCellIdentity(identity);
    expect(parsed?.coordinates).toEqual([{ dimension: 'JOB', value: 'a|JOB=b' }]);
  });
});

// ─── 1. A unit-tested handler is not a tested surface ───────────────────────

describe('the reach decides the rung', () => {
  it('holds a handler-only cell at DECLARED even when the run PASSED', () => {
    const report = measure([
      surface(cron, {
        tested: exercise({
          reach: 'HANDLER_CALLED',
          namedByTestIds: ['tst_1'],
          runStatus: 'PASSED',
          confirmedAtIso: YESTERDAY,
        }),
      }),
    ]);
    const cell = report.cells[0];
    expect(cell?.reach).toBe('HANDLER_CALLED');
    expect(cell?.tier).toBe('DECLARED');
    expect(cell?.why).toContain('held at DECLARED');
    expect(dimensionPercentAt(report.byDimension.BACKGROUND_JOB, 'PASSING')).toBe(0);
    expect(dimensionPercentAt(report.byDimension.BACKGROUND_JOB, 'DECLARED')).toBe(100);
  });

  it('promotes an end-to-end pass all the way to FRESH', () => {
    const report = measure([surface(cron, { tested: endToEnd })]);
    expect(report.cells[0]?.tier).toBe('FRESH');
    expect(dimensionPercentAt(report.byDimension.BACKGROUND_JOB, 'FRESH')).toBe(100);
  });

  it('stops at NAVIGATED when the trigger fired and nothing asserted', () => {
    const report = measure([
      surface(queue, {
        tested: exercise({
          reach: 'TRIGGER_FIRED',
          runStatus: 'PASSED',
          confirmedAtIso: YESTERDAY,
        }),
      }),
    ]);
    expect(report.cells[0]?.tier).toBe('NAVIGATED');
  });

  it('counts a FAILING end-to-end test as coverage, at ASSERTED', () => {
    const report = measure([
      surface(webhook, {
        tested: exercise({
          reach: 'EFFECT_OBSERVED',
          runStatus: 'FAILED',
          confirmedAtIso: YESTERDAY,
        }),
      }),
    ]);
    // Covered AND failing are two facts; the denominator keeps it.
    expect(report.cells[0]?.tier).toBe('ASSERTED');
    expect(report.byDimension.BACKGROUND_JOB.tiers.denominator).toBe(1);
  });

  it('refuses to promote a static mention past DECLARED — written is not run', () => {
    const report = measure([surface(cron, { tested: exercise({ namedByTestIds: ['tst_1'] }) })]);
    expect(report.cells[0]?.tier).toBe('DECLARED');
    expect(report.cells[0]?.reach).toBeNull();
  });

  it('refuses to promote a declaration past DECLARED either', () => {
    const report = measure([surface(cron, { tested: exercise({ declaredByTestIds: ['tst_1'] }) })]);
    expect(report.cells[0]?.tier).toBe('DECLARED');
  });

  it('gives a cell nothing claims a NULL tier, not DECLARED', () => {
    /*
     * Two spellings of "nothing knows about this": `tested: null` and an
     * exercise whose every field is empty. Both must give a NULL tier, or the
     * caller's choice between them would move the number.
     */
    const report = measure([surface(cron), surface(queue, { tested: exercise() })]);
    expect(report.cells.map((cell) => cell.tier)).toEqual([null, null]);
    expect(report.byDimension.BACKGROUND_JOB.tiers.unclaimed).toBe(2);
  });

  it('names quarantine as the cap, because that coverage gates nothing', () => {
    const report = measure([surface(cron, { tested: { ...endToEnd, quarantined: true } })]);
    expect(report.cells[0]?.tier).toBe('DECLARED');
    expect(report.cells[0]?.tierCappedBy).toBe('TEST_QUARANTINED');
  });

  it('does not let a stale pass claim FRESH', () => {
    const report = measure([surface(cron, { tested: { ...endToEnd, confirmedAtIso: LAST_YEAR } })]);
    expect(report.cells[0]?.tier).toBe('PASSING');
  });

  it('holds a claimed observation with no run status at DECLARED', () => {
    const report = measure([
      surface(cron, { tested: exercise({ reach: 'END_TO_END', runStatus: null }) }),
    ]);
    expect(report.cells[0]?.tier).toBe('DECLARED');
  });
});

// ─── 2. "We never looked" is not "there are none" ───────────────────────────

describe('the two kinds of empty', () => {
  it('reports NULL at every rung for an axis nothing enumerated', () => {
    const report = measure([], { enumerated: { BACKGROUND_JOB: false, NOTIFICATION: false } });
    for (const dimension of ASYNC_DIMENSIONS) {
      const measurement = report.byDimension[dimension];
      expect(measurement.unmeasuredReason).toBe('NOT_ENUMERATED');
      expect(measurement.cells).toBe(0);
      expect(dimensionWasMeasured(measurement)).toBe(false);
      for (const tier of COVERAGE_TIERS) {
        expect(dimensionPercentAt(measurement, tier)).toBeNull();
      }
    }
    expect(report.findings.some((line) => line.includes('not 0% covered'))).toBe(true);
  });

  it('tells that apart from an axis that was read and found empty', () => {
    const report = measure([]);
    const jobs = report.byDimension.BACKGROUND_JOB;
    expect(jobs.unmeasuredReason).toBeNull();
    expect(jobs.measured).toBe(0);
    expect(jobs.unmeasured).toBe(0);
    expect(dimensionPercentAt(jobs, 'PASSING')).toBeNull();
    expect(report.findings.some((line) => line.includes('found none'))).toBe(true);
  });

  it('refuses a surface on an axis the caller said was never enumerated', () => {
    expect(() =>
      measure([surface(cron)], { enumerated: { BACKGROUND_JOB: false, NOTIFICATION: true } }),
    ).toThrow(/cannot both be true/);
  });

  it('measures one axis while the other is unenumerated, without mixing them', () => {
    const report = measure([surface(email, { tested: endToEnd })], {
      enumerated: { BACKGROUND_JOB: false, NOTIFICATION: true },
    });
    expect(report.byDimension.NOTIFICATION.measured).toBe(1);
    expect(dimensionPercentAt(report.byDimension.NOTIFICATION, 'FRESH')).toBe(100);
    expect(report.byDimension.BACKGROUND_JOB.unmeasuredReason).toBe('NOT_ENUMERATED');
    expect(dimensionPercentAt(report.byDimension.BACKGROUND_JOB, 'FRESH')).toBeNull();
  });
});

// ─── 3. Low confidence is counted and said ──────────────────────────────────

describe('detection confidence', () => {
  it('keeps a naming-convention surface in the denominator and says it may not exist', () => {
    const report = measure([
      surface(cron, { basis: 'NAMING_CONVENTION' }),
      surface(queue, { basis: 'DECLARED_CONFIG', tested: endToEnd }),
    ]);
    expect(report.byDimension.BACKGROUND_JOB.tiers.denominator).toBe(2);
    expect(dimensionPercentAt(report.byDimension.BACKGROUND_JOB, 'FRESH')).toBe(50);
    expect(report.cells[0]?.confidence).toBe('LOW');
    expect(report.cells[0]?.why).toContain('LOW confidence and may not exist');
    expect(report.findings.some((line) => line.includes('rest on a naming convention alone'))).toBe(
      true,
    );
  });

  it('does not claim low confidence about a registration call', () => {
    const report = measure([surface(queue)]);
    expect(report.cells[0]?.confidence).toBe('HIGH');
    expect(report.cells[0]?.why).not.toContain('LOW confidence');
  });
});

// ─── 4. The two axes are never summed ───────────────────────────────────────

describe('two axes, two denominators', () => {
  it('counts a cron and an email on separate readings with no combined figure', () => {
    const report = measure([surface(cron, { tested: endToEnd }), surface(email)]);
    expect(report.byDimension.BACKGROUND_JOB.tiers.denominator).toBe(1);
    expect(report.byDimension.NOTIFICATION.tiers.denominator).toBe(1);
    expect(dimensionPercentAt(report.byDimension.BACKGROUND_JOB, 'FRESH')).toBe(100);
    expect(dimensionPercentAt(report.byDimension.NOTIFICATION, 'FRESH')).toBe(0);
    // No field anywhere offers the 50% a summed denominator would have produced.
    expect(Object.keys(report)).toEqual(['cells', 'byDimension', 'findings', 'caps']);
  });

  it('files every one of the nine kinds on exactly one of the two readings', () => {
    const facts: BackgroundSurfaceFact[] = [
      cron,
      queue,
      webhook,
      email,
      { kind: 'UPLOAD', path: '/api/upload', acceptedTypes: [], maxBytes: null },
      { kind: 'WEBSOCKET', path: '/ws', events: [] },
      { kind: 'SSE', path: '/sse', events: [] },
      { kind: 'SERVER_ACTION', module: 'src/actions.ts', exportName: 'pay' },
      { kind: 'TRPC_PROCEDURE', procedure: 'billing.list', mutation: false },
    ];
    const report = measure(facts.map((fact) => surface(fact)));
    const jobs = report.byDimension.BACKGROUND_JOB.cells;
    const notifications = report.byDimension.NOTIFICATION.cells;
    expect(jobs + notifications).toBe(facts.length);
    expect(notifications).toBe(1);
  });
});

// ─── What leaves the denominator, and with whose name on it ─────────────────

describe('held out of the denominator', () => {
  const waiver: SurfaceWaiver = {
    reason: 'the nightly reconciliation is owned by data engineering',
    byUserId: 'usr_1',
    byEmail: 'owner@example.com',
    createdAtIso: YESTERDAY,
    expiresAtIso: '2027-01-01T00:00:00.000Z',
  };

  it('takes a waived cell out, with the owner and the expiry on the sentence', () => {
    const report = measure([surface(cron, { waiver }), surface(queue, { tested: endToEnd })]);
    const held = report.cells.find((cell) => cell.heldOut !== null);
    expect(held?.heldOut?.reason).toBe('HELD_OUT');
    expect(held?.heldOut?.detail).toContain('owner@example.com');
    expect(held?.heldOut?.detail).toContain('expires 2027-01-01');
    // One cell measured, one held out, and the percentage is over the one.
    expect(report.byDimension.BACKGROUND_JOB.measured).toBe(1);
    expect(report.byDimension.BACKGROUND_JOB.unmeasured).toBe(1);
    expect(dimensionPercentAt(report.byDimension.BACKGROUND_JOB, 'FRESH')).toBe(100);
  });

  it('warns on a waiver with no expiry rather than accepting it silently', () => {
    const report = measure([surface(cron, { waiver: { ...waiver, expiresAtIso: null } })]);
    expect(report.cells[0]?.heldOut?.detail).toContain('no expiry');
  });

  it('names UNEXERCISABLE as our limit and not as the team decision', () => {
    const report = measure([
      surface(cron, {
        exercise: {
          state: 'UNEXERCISABLE',
          reason: 'DESTRUCTIVE',
          detail: 'the job truncates the ledger',
        },
      }),
    ]);
    expect(report.cells[0]?.heldOut?.detail).toContain('our limit, not a waiver');
    expect(report.byDimension.BACKGROUND_JOB.unmeasuredReason).toBe('HELD_OUT');
  });

  it('names the policy rule for a REFUSED surface', () => {
    const report = measure([
      surface(webhook, {
        exercise: { state: 'REFUSED', rule: 'no-third-party-posts', detail: 'policy declined it' },
      }),
    ]);
    expect(report.cells[0]?.heldOut?.detail).toContain('policy rule no-third-party-posts');
  });

  it('keeps a cell nobody classified IN the denominator', () => {
    const report = measure([
      surface(cron, { exercise: { state: 'EXERCISABLE', detail: 'drivable here' } }),
      surface(queue),
    ]);
    expect(report.byDimension.BACKGROUND_JOB.measured).toBe(2);
    expect(report.byDimension.BACKGROUND_JOB.unmeasured).toBe(0);
  });

  it('carries both sentences when a cell is waived AND unexercisable', () => {
    const report = measure([
      surface(cron, {
        waiver,
        exercise: { state: 'UNEXERCISABLE', reason: 'DESTRUCTIVE', detail: 'truncates' },
      }),
    ]);
    const detail = report.cells[0]?.heldOut?.detail ?? '';
    expect(detail).toContain('owner@example.com');
    expect(detail).toContain('our limit, not a waiver');
  });
});

// ─── The caps, disclosed as a count and a reason ────────────────────────────

describe('caps', () => {
  it('says exactly how many surfaces the take limit dropped', () => {
    const surfaces = Array.from({ length: MAX_ASYNC_CELLS + 3 }, (_, index) =>
      surface({ kind: 'QUEUE_CONSUMER', queue: `q${index}`, concurrency: null, handler: null }),
    );
    const report = measure(surfaces);

    expect(report.cells).toHaveLength(MAX_ASYNC_CELLS);
    const bite = report.caps.find((entry) => entry.cap === 'maxAsyncCells');
    expect(bite?.atLeastMore).toBe(3);
    const jobs = report.byDimension.BACKGROUND_JOB;
    expect(jobs.unmeasured).toBe(3);
    expect(jobs.unmeasuredReason).toBe('CAP_BIT');
    expect(jobs.caps.some((entry) => entry.cap === 'maxAsyncCells')).toBe(true);
    // The cap is disclosed on the untouched axis too: the run was truncated.
    expect(report.byDimension.NOTIFICATION.caps.some((e) => e.cap === 'maxAsyncCells')).toBe(true);
  });

  it('carries an upstream detector cap onto both readings and into the findings', () => {
    const report = measure([surface(cron)], {
      upstreamCaps: [
        {
          cap: 'MAX_BACKGROUND_SURFACES',
          limit: 1_000,
          atLeastMore: 212,
          detail: 'the source scan stopped at 1,000 background surfaces',
        },
      ],
    });
    for (const dimension of ASYNC_DIMENSIONS) {
      expect(
        report.byDimension[dimension].caps.some((e) => e.cap === 'MAX_BACKGROUND_SURFACES'),
      ).toBe(true);
    }
    expect(report.findings.some((line) => line.includes('at least 212 more existed'))).toBe(true);
  });

  it('says a cap could not tell what it hid rather than claiming zero', () => {
    const report = measure([surface(cron)], {
      upstreamCaps: [
        { cap: 'scanTimeout', limit: 30, atLeastMore: null, detail: 'the scan ran out of time' },
      ],
    });
    expect(report.findings.some((line) => line.includes('cannot be said'))).toBe(true);
    expect(report.findings.some((line) => line.includes('at least 0 more'))).toBe(false);
  });
});

// ─── The refusals ───────────────────────────────────────────────────────────

describe('refusals', () => {
  it('refuses two surfaces that collapse onto one cell key', () => {
    expect(() => measure([surface(cron), surface({ ...cron })])).toThrow(/one cell counted twice/);
  });

  it('refuses a surface with no evidence sentence', () => {
    expect(() => measure([surface(cron, { evidence: '' })])).toThrow(/nobody can audit/);
  });
});

// ─── The findings ───────────────────────────────────────────────────────────

describe('findings', () => {
  it('reports the handler-only share as the sentence a team can act on', () => {
    const report = measure([
      surface(cron, {
        tested: exercise({ reach: 'HANDLER_CALLED', runStatus: 'PASSED', confirmedAtIso: NOW }),
      }),
      surface(queue, { tested: endToEnd }),
    ]);
    expect(
      report.findings.some((line) => line.includes('1 of 2') && line.includes('handler call')),
    ).toBe(true);
  });

  it('reports that nothing in the suite touches any background surface', () => {
    const report = measure([surface(cron), surface(queue)]);
    expect(
      report.findings.some((line) =>
        line.includes('no test anywhere names, declares or exercises'),
      ),
    ).toBe(true);
  });

  it('flags a webhook receiver whose signature scheme was unreadable', () => {
    /*
     * Read off `signatureScheme: null` and NOT off the evidence prose, so the
     * finding survives a reword in codebase.ts. The second receiver has a
     * scheme and must not be counted.
     */
    const report = measure([
      surface({ kind: 'WEBHOOK_RECEIVER', path: '/api/hooks/x', signatureScheme: null }),
      surface(webhook),
    ]);
    const line = report.findings.find((entry) => entry.includes('no readable signature scheme'));
    expect(line).toContain('1 inbound webhook receiver(s)');
  });

  it('says nothing about signature schemes when every receiver has one', () => {
    const report = measure([surface(webhook)]);
    expect(report.findings.some((entry) => entry.includes('signature scheme'))).toBe(false);
  });
});

// ─── The seam onto the rollups ──────────────────────────────────────────────

describe('asyncRollupItems', () => {
  it('feeds rollupCoverage so a feature gets its own percentage', () => {
    const report = measure([
      surface(cron, { tested: endToEnd }),
      surface(queue),
      surface(webhook, { waiver: null, exercise: { state: 'REFUSED', rule: 'r1', detail: 'no' } }),
    ]);

    const items = asyncRollupItems(report, 'BACKGROUND_JOB', (cell) =>
      cell.kind === 'CRON'
        ? { feature: 'billing', teamId: 't_billing' }
        : { feature: null, teamId: null },
    );
    const rollup = rollupCoverage({ dimension: 'BACKGROUND_JOB', tier: 'FRESH', items });

    expect(rollup.headline.denominator).toBe(2);
    expect(rollup.headline.numerator).toBe(1);
    expect(rollup.headline.percent).toBe(50);
    expect(rollup.headline.unmeasured).toBe(1);
    expect(rollup.reconciliation.reconciles).toBe(true);
    expect(rollup.attribution.sentence).toContain('has no owner');

    const billing = rollup.rows.find((row) => row.feature === 'billing' && row.teamId === null);
    expect([billing?.numerator, billing?.denominator, billing?.percent]).toEqual([1, 1, 100]);
  });

  it('keeps a held-out cell in the rollup carrying its reason, not dropped from it', () => {
    const report = measure([
      surface(cron, { exercise: { state: 'UNEXERCISABLE', reason: 'DESTRUCTIVE', detail: 'x' } }),
    ]);
    const items = asyncRollupItems(report, 'BACKGROUND_JOB', () => ({
      feature: 'ops',
      teamId: 't_ops',
    }));
    expect(items).toHaveLength(1);
    expect(items[0]?.excluded?.reason).toBe('HELD_OUT');
  });

  it('returns only the asked-for axis cells', () => {
    const report = measure([surface(cron), surface(email)]);
    const attribute = () => ({ feature: null, teamId: null });
    expect(asyncRollupItems(report, 'NOTIFICATION', attribute)).toHaveLength(1);
    expect(asyncRollupItems(report, 'BACKGROUND_JOB', attribute)).toHaveLength(1);
  });
});
