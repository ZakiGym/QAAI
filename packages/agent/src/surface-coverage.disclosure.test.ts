/**
 * WHAT LEAVES THE SURFACE DENOMINATOR, AND WHETHER THE READER IS TOLD.
 *
 * Two different things are subtracted from `totalsForKind`'s denominator and
 * they are not the same kind of thing:
 *
 *   · a WAIVER is the team's decision not to test something. It carries an
 *     owner and an expiry, and the report has always named it.
 *   · UNEXERCISABLE / REFUSED is OUR limit — a session-ending flow with no
 *     disposable account, a destructive endpoint, a path a policy rule
 *     declined. It carries no owner and never expires.
 *
 * Both raise the percentage. Only the first was disclosed. This file is the
 * suite for that asymmetry, plus the one for `summedKindPercent`, which is the
 * four-denominator sum still living in `SurfaceSnapshotTotals.percent` under a
 * name that used to claim it was the product headline.
 *
 * Separate from `surface-coverage.test.ts` on the same grounds as
 * `surface-inventory.denominator.test.ts` is separate from its own module's
 * suite: one question, one fixture.
 */

import { describe, expect, it } from 'vitest';
import type { SurfaceItem, SurfaceWaiver } from '@qaai/shared';
import {
  analyseSurfaceCoverage,
  headlinePercent,
  summedKindPercent,
  type TestExecutionFact,
} from './surface-coverage.js';
import type { CoverageTestInput } from './coverage.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const item = (
  kind: SurfaceItem['kind'],
  key: string,
  over: Partial<SurfaceItem> = {},
): SurfaceItem => ({
  kind,
  key,
  label: key,
  file: null,
  line: null,
  origin: 'CRAWL_ONLY',
  evidence: `fixture ${key}`,
  detector: 'fixture',
  ...over,
});

/** Declares `/a0`…`/a4`, so exactly five of ten ROUTE items are matched. */
const fiveCoveringTests: CoverageTestInput[] = [
  {
    id: 'tst_1',
    name: 'covers five',
    filePath: 'tests/a.spec.ts',
    feature: null,
    priority: 'IMPORTANT',
    testType: 'E2E',
    tags: [],
    routes: ['/a0', '/a1', '/a2', '/a3', '/a4'],
    code: null,
  },
];

const ran: TestExecutionFact[] = [
  { testId: 'tst_1', runId: 'run_1', status: 'PASSED', atIso: '2026-10-20T00:00:00.000Z' },
];

const tenRoutes = (): SurfaceItem[] =>
  Array.from({ length: 10 }, (_, index) => item('ROUTE', `ROUTE:/a${index}`));

// ─── (a) Our limits, held out of the division and now said so ──────────────

describe('items this harness cannot drive leave the denominator, disclosed', () => {
  it('names the count AND the reasons when UNEXERCISABLE items are held out', () => {
    /*
     * THE DEFECT THIS LOCKS. `NON_DENOMINATOR_EXERCISABILITIES` subtracts
     * UNEXERCISABLE and REFUSED from the denominator — a defensible decision,
     * and one that RAISES the percentage. The counts sat on `totals` the whole
     * time and NOTHING in `caveats` said they had left the division: 5/8 was
     * reported where 5/10 is the figure over every item enumerated. Twelve and
     * a half points, from two rows the reader never saw go.
     */
    const items = tenRoutes();
    items[8] = item('ROUTE', 'ROUTE:/a8', {
      exercise: {
        state: 'UNEXERCISABLE',
        reason: 'SESSION_ENDING',
        detail: 'logs the only account out',
      },
    });
    items[9] = item('ROUTE', 'ROUTE:/a9', {
      exercise: { state: 'UNEXERCISABLE', reason: 'DESTRUCTIVE', detail: 'deletes the org' },
    });

    const result = analyseSurfaceCoverage({
      items,
      tests: fiveCoveringTests,
      executions: ran,
    });

    // The arithmetic is UNCHANGED by this fix — only the disclosure is new.
    expect(result.totals.denominator).toBe(8);
    expect(result.totals.unexercisable).toBe(2);
    expect(result.totals.covered).toBe(5);
    expect(result.totals.percent).toBe(62.5);

    const caveat = result.caveats.find((entry) => /OUT of the denominator/.test(entry));
    expect(caveat).toBeDefined();
    // A count, and the reasons behind it, because "2 items held out" is not
    // something a customer can act on and "1 session-ending, 1 destructive" is.
    expect(caveat).toMatch(/2 items/);
    expect(caveat).toContain('SESSION_ENDING');
    expect(caveat).toContain('DESTRUCTIVE');
    // The arithmetic a reader needs to undo it, stated.
    expect(caveat).toContain('The denominator is 8, not 10');
    // And the distinction from a waiver, which is the whole reason these are
    // counted separately rather than folded into one "excluded" number.
    expect(caveat).toMatch(/no owner and no expiry/);

    // The items stay visible: a surface we cannot drive is the one most worth
    // naming, and the bug this guards against is it vanishing.
    expect(result.entries.filter((entry) => entry.item.exercise?.state === 'UNEXERCISABLE')).toHaveLength(2);
  });

  it('says nothing when nothing was held out, rather than printing a zero', () => {
    const result = analyseSurfaceCoverage({
      items: tenRoutes(),
      tests: fiveCoveringTests,
      executions: ran,
    });
    expect(result.totals.denominator).toBe(10);
    expect(result.caveats.some((entry) => /OUT of the denominator/.test(entry))).toBe(false);
  });

  it('names a REFUSED item by the policy rule that refused it', () => {
    const items = tenRoutes();
    items[9] = item('ROUTE', 'ROUTE:/a9', {
      exercise: { state: 'REFUSED', rule: 'no-destructive-admin', detail: 'policy declined' },
    });
    const result = analyseSurfaceCoverage({ items, tests: fiveCoveringTests, executions: ran });

    expect(result.totals.refused).toBe(1);
    const caveat = result.caveats.find((entry) => /OUT of the denominator/.test(entry));
    // "excluded by policy" with no rule named is indistinguishable from a bug
    // in the crawler, which is `SurfaceExercise.rule`'s own argument.
    expect(caveat).toContain('no-destructive-admin');
  });
});

// ─── (b) A waiver is the team's call, and carries who and until when ───────

describe('a waived item leaves the denominator with an owner and an expiry', () => {
  it('subtracts the three waived items and keeps their waiver on the entry', () => {
    const waiver = (reason: string, expiresAtIso: string | null): SurfaceWaiver => ({
      reason,
      byUserId: 'user_7',
      byEmail: 'ana@example.test',
      createdAtIso: '2026-10-01T00:00:00.000Z',
      expiresAtIso,
    });
    const result = analyseSurfaceCoverage({
      items: tenRoutes(),
      tests: fiveCoveringTests,
      executions: ran,
      waivers: {
        'ROUTE:/a7': waiver('third-party widget', '2026-12-01T00:00:00.000Z'),
        'ROUTE:/a8': waiver('legacy, being deleted', '2026-12-01T00:00:00.000Z'),
        'ROUTE:/a9': waiver('deprecated', null),
      },
    });

    expect(result.totals.waived).toBe(3);
    expect(result.totals.denominator).toBe(7);
    expect(result.totals.covered).toBe(5);
    expect(result.totals.percent).toBe(71.4);

    const waived = result.entries.filter((entry) => entry.status === 'WAIVED');
    expect(waived).toHaveLength(3);
    for (const entry of waived) {
      // A waiver with no owner is a silent exclusion — the field's own words.
      expect(entry.waiver?.byUserId).toBe('user_7');
      expect(entry.waiver?.reason).toBeTruthy();
      // `expiresAtIso` may be null, but the KEY must be present, so a consumer
      // can tell "never expires" from "nobody recorded an expiry".
      expect(entry.waiver).toHaveProperty('expiresAtIso');
    }
  });
});

// ─── (c) The four-denominator sum that is still in the database ────────────

describe('summedKindPercent is a sum of four denominators and says so', () => {
  it('slides two orders of magnitude while the axis it is "about" never moves', () => {
    /*
     * THE DEFECT THIS DOCUMENTS. `totalsForItems` divides sum(covered) by
     * sum(denominator) across the four MEASURED_SURFACE_KINDS, which is the
     * same arithmetic `CoverageHeadline` was built to replace. This function
     * used to be documented as "Convenience for the CLI gate: the headline".
     *
     * ROUTE is held at a constant 5/10 = 50% in every row below. Nothing about
     * the suite changes. The number moves because ONE OTHER KIND grows.
     */
    const readings = [0, 10, 100, 1000].map((endpoints) => {
      const items = tenRoutes();
      for (let index = 0; index < endpoints; index += 1) {
        items.push(
          item('ENDPOINT', `ENDPOINT:GET /api/e${index}`, {
            meta: { method: 'GET', path: `/api/e${index}` },
          }),
        );
      }
      const result = analyseSurfaceCoverage({ items, tests: fiveCoveringTests, executions: ran });
      return {
        endpoints,
        summed: summedKindPercent(result),
        route: result.totals.byKind.find((kind) => kind.kind === 'ROUTE')!,
      };
    });

    // The ROUTE axis's own fraction is identical in all four runs.
    for (const reading of readings) {
      expect(reading.route.covered).toBe(5);
      expect(reading.route.denominator).toBe(10);
      expect(reading.route.percent).toBe(50);
    }

    // And the "headline" is not.
    expect(readings.map((reading) => reading.summed)).toEqual([50, 25, 4.5, 0.5]);
  });

  it('keeps the old name working, pointed at the renamed function', () => {
    // `headlinePercent` is kept as a deprecated alias rather than deleted: the
    // same field is persisted as `CoverageSnapshot.percent`, so removing the
    // one named accessor would hide the problem instead of fixing it.
    expect(headlinePercent).toBe(summedKindPercent);
  });

  it('is null — never 0 — when no measured kind enumerated anything', () => {
    const result = analyseSurfaceCoverage({
      items: [item('ROLE_CELL', 'ROLE_CELL:/a0#admin')],
      tests: [],
    });
    // ROLE_CELL is not a MEASURED_SURFACE_KIND, so there is nothing to divide.
    expect(summedKindPercent(result)).toBeNull();
  });
});
