/**
 * The five rules, as tests.
 *
 * Each case below is a way the dark-surface screen could be confidently wrong
 * in the direction that flatters us: a percentage invented from an empty
 * denominator, a gap count that swallowed "a test exists but has never run",
 * an axis we have no extractor for drawn as 0%, a trend plotted backwards. The
 * suite is organised around those failures rather than around the exports.
 */

import { describe, expect, it } from 'vitest';
import type {
  SurfaceItemCoverage,
  SurfaceKind,
  SurfaceKindTotals,
  SurfaceSnapshotTotals,
} from '@qaai/shared';
import {
  DEFAULT_FILTERS,
  checkWaiver,
  defaultExpiry,
  describeKind,
  describeUnmeasured,
  formatPercent,
  gapCount,
  groupByKind,
  headlineFor,
  heldBack,
  otherStates,
  pageOf,
  sparkline,
  storedDrift,
  surfaceQuery,
  waiverBody,
  type StoredSnapshot,
} from './surface';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function totals(over: Partial<SurfaceSnapshotTotals> = {}): SurfaceSnapshotTotals {
  return {
    percent: 62.4,
    denominator: 125,
    covered: 78,
    assertedNotRun: 9,
    uncovered: 31,
    unknown: 7,
    waived: 4,
    byKind: [],
    declaredNeverReached: 22,
    reachedNeverDeclared: 3,
    ...over,
  };
}

function kindTotals(over: Partial<SurfaceKindTotals> = {}): SurfaceKindTotals {
  return {
    kind: 'ROUTE',
    denominator: 8,
    covered: 3,
    assertedNotRun: 0,
    uncovered: 5,
    unknown: 0,
    waived: 0,
    percent: 37.5,
    measured: true,
    ...over,
  };
}

function entry(kind: SurfaceKind, key: string): SurfaceItemCoverage {
  return {
    item: {
      kind,
      key,
      label: key,
      file: 'app/x/page.tsx',
      line: 1,
      origin: 'SOURCE_ONLY',
      evidence: 'directory path is the URL',
      detector: 'next-app-router',
    },
    status: 'UNCOVERED',
    matches: [],
    verification: {
      lastRunId: null,
      lastStatus: null,
      executed: false,
      everPassed: false,
      mutationKilled: null,
    },
  };
}

function stored(over: Partial<StoredSnapshot> = {}): StoredSnapshot {
  return {
    id: 'snap_1',
    createdAt: '2026-10-20T09:00:00.000Z',
    commitSha: null,
    percent: 62.4,
    denominator: 125,
    covered: 78,
    uncovered: 31,
    unknown: 7,
    waived: 4,
    assertedNotRun: 9,
    declaredNeverReached: 22,
    reachedNeverDeclared: 3,
    caveats: [],
    fingerprint: 'abc',
    testCount: 40,
    flowMapVersion: 2,
    ...over,
  };
}

// ─── Rule 1: null is not zero and not a hundred ──────────────────────────────

describe('a percent with nothing to divide', () => {
  it('never renders as a number', () => {
    const text = formatPercent(null);
    expect(text).toBe('not measured');
    expect(text).not.toMatch(/\d/);
  });

  it('does render a real zero, because zero of a hundred is a measurement', () => {
    expect(formatPercent(0)).toBe('0%');
  });

  it('drops the pointless decimal on a whole number but keeps a real one', () => {
    expect(formatPercent(100)).toBe('100%');
    expect(formatPercent(62.4)).toBe('62.4%');
  });

  it('refuses a headline when the denominator is empty, and says which emptiness', () => {
    const nothing = headlineFor(totals({ percent: null, denominator: 0, covered: 0, waived: 0 }));
    expect(nothing.measured).toBe(false);
    expect(nothing.sentence).toBe('Not measured yet');
    // The sentence is what a skimming reader takes away; it must hold no digit.
    expect(nothing.sentence).not.toMatch(/\d/);
    if (!nothing.measured) expect(nothing.reason).toMatch(/no denominator/i);

    const allWaived = headlineFor(
      totals({ percent: null, denominator: 0, covered: 0, waived: 12 }),
    );
    expect(allWaived.measured).toBe(false);
    if (!allWaived.measured) {
      expect(allWaived.reason).toMatch(/waived/);
      expect(allWaived.next).toMatch(/[Ww]ithdraw/);
    }
  });

  it('refuses a headline when the server sends a null percent with a denominator', () => {
    // Should not happen — but printing "null% of your application" if it ever
    // does is worse than falling back to the honest answer.
    const headline = headlineFor(totals({ percent: null, denominator: 40 }));
    expect(headline.measured).toBe(false);
    expect(headline.sentence).not.toMatch(/null/);
  });

  it('states the division when there is one, so the arithmetic is checkable', () => {
    const headline = headlineFor(totals());
    expect(headline.measured).toBe(true);
    if (headline.measured) {
      expect(headline.sentence).toContain('62.4%');
      expect(headline.detail).toContain('78 of 125');
    }
  });
});

// ─── Rules 2 and 3: the states that are not gaps ─────────────────────────────

describe('the states that are neither covered nor a gap', () => {
  it('keeps all three apart from the gap count', () => {
    const t = totals();
    const states = otherStates(t);
    expect(states.map((state) => state.status)).toEqual(['ASSERTED_NOT_RUN', 'UNKNOWN', 'WAIVED']);
    expect(states.map((state) => state.count)).toEqual([9, 7, 4]);
    // The gap number is UNCOVERED alone. If any of the three ever leaked into
    // it, this is the assertion that notices.
    expect(gapCount(t)).toBe(31);
    expect(gapCount(t)).not.toBe(t.uncovered + t.unknown);
    expect(gapCount(t)).not.toBe(t.uncovered + t.assertedNotRun);
  });

  it('states a zero rather than hiding the row', () => {
    const states = otherStates(totals({ assertedNotRun: 0, unknown: 0, waived: 0 }));
    expect(states).toHaveLength(3);
    expect(states.every((state) => state.count === 0)).toBe(true);
  });

  it('says out loud that "cannot tell" is not a gap', () => {
    const unknown = otherStates(totals()).find((state) => state.status === 'UNKNOWN');
    expect(unknown?.note).toMatch(/never presented as a gap/i);
  });
});

// ─── Rule 4: an unmeasured axis is not 0% ────────────────────────────────────

describe('an axis', () => {
  it('reports a measured ratio when there is one', () => {
    expect(describeKind(kindTotals())).toEqual({ text: '37.5% covered', measured: true });
  });

  it('says we do not measure it, rather than measuring it as zero', () => {
    const described = describeKind(
      kindTotals({ kind: 'COMPONENT_STATE', measured: false, denominator: 0, percent: null }),
    );
    expect(described.text).toBe('not measured by QAAI');
    expect(described.text).not.toMatch(/\d/);
  });

  it('distinguishes "we found none" from "we do not look"', () => {
    const empty = describeKind(kindTotals({ denominator: 0, covered: 0, percent: null }));
    expect(empty.text).toBe('nothing to divide');
    expect(empty.measured).toBe(false);
  });

  it('names the unmeasured axes as facts about QAAI', () => {
    expect(describeUnmeasured(['COMPONENT_STATE', 'ROLE_CELL'])).toEqual([
      'We do not measure component states.',
      'We do not measure route × role cells.',
    ]);
  });
});

// ─── The named list ──────────────────────────────────────────────────────────

describe('grouping the named list', () => {
  it("preserves the server's worst-first order instead of re-sorting", () => {
    const groups = groupByKind([
      entry('AUTH_SURFACE', 'AUTH_SURFACE:login'),
      entry('ENDPOINT', 'ENDPOINT:POST /api/refunds'),
      entry('AUTH_SURFACE', 'AUTH_SURFACE:reset'),
      entry('ROUTE', 'ROUTE:/orders'),
    ]);
    // Alphabetically this would be AUTH_SURFACE, ENDPOINT, ROUTE — which here
    // is a coincidence for the first two. What matters is first appearance.
    expect(groups.map((group) => group.kind)).toEqual(['AUTH_SURFACE', 'ENDPOINT', 'ROUTE']);
    expect(groups[0]?.items.map((item) => item.item.key)).toEqual([
      'AUTH_SURFACE:login',
      'AUTH_SURFACE:reset',
    ]);
    expect(groups[1]?.label).toBe('API endpoints');
  });

  it('holds nothing back silently', () => {
    expect(heldBack({ total: 243, offset: 0, items: new Array(50) })).toBe(193);
    expect(heldBack({ total: 243, offset: 200, items: new Array(43) })).toBe(0);
    // A page past the end must not report a negative hold-back.
    expect(heldBack({ total: 10, offset: 50, items: [] })).toBe(0);
  });

  it('counts pages from the offset', () => {
    expect(pageOf({ total: 243, offset: 100, limit: 50 })).toEqual({ page: 3, pages: 5 });
    expect(pageOf({ total: 0, offset: 0, limit: 50 })).toEqual({ page: 1, pages: 1 });
  });
});

// ─── The query ───────────────────────────────────────────────────────────────

describe('the query the screen sends', () => {
  it('opens on the gaps', () => {
    expect(surfaceQuery(DEFAULT_FILTERS)).toBe('limit=50&offset=0&status=UNCOVERED');
  });

  it('sends every status explicitly when none is selected', () => {
    // Omitting `status` makes the endpoint answer with UNCOVERED only, under a
    // filter row claiming everything was selected.
    const query = surfaceQuery({ ...DEFAULT_FILTERS, statuses: [] });
    const status = new URLSearchParams(query).get('status');
    expect(status?.split(',')).toEqual([
      'COVERED',
      'ASSERTED_NOT_RUN',
      'UNCOVERED',
      'UNKNOWN',
      'WAIVED',
    ]);
  });

  it('comma-joins kinds, omits an empty kind filter, and carries the origin', () => {
    const query = new URLSearchParams(
      surfaceQuery({
        kinds: ['ROUTE', 'FORM'],
        statuses: ['UNCOVERED'],
        origin: 'SOURCE_ONLY',
        offset: 50,
        limit: 25,
      }),
    );
    expect(query.get('kind')).toBe('ROUTE,FORM');
    expect(query.get('origin')).toBe('SOURCE_ONLY');
    expect(query.get('offset')).toBe('50');
    expect(query.get('limit')).toBe('25');
    expect(new URLSearchParams(surfaceQuery(DEFAULT_FILTERS)).has('kind')).toBe(false);
    expect(new URLSearchParams(surfaceQuery(DEFAULT_FILTERS)).has('origin')).toBe(false);
  });
});

// ─── Waivers ─────────────────────────────────────────────────────────────────

describe('waiving an item', () => {
  const now = new Date('2026-10-23T12:00:00.000Z');

  it('rejects a reason the API would reject, counting the trimmed length', () => {
    expect(checkWaiver({ reason: 'legacy', expiresAt: '' }, now).problem).toMatch(/at least 10/);
    // Ten characters of whitespace and a word is not a ten-character reason:
    // the endpoint validates the trimmed string.
    expect(checkWaiver({ reason: '          hi', expiresAt: '' }, now).problem).toMatch(
      /at least 10/,
    );
    expect(
      checkWaiver({ reason: 'Retired in Q3, deleted next sprint', expiresAt: '' }, now).problem,
    ).toBeNull();
  });

  it('flags a waiver with no expiry rather than accepting it silently', () => {
    const check = checkWaiver({ reason: 'Third-party page we do not own', expiresAt: '' }, now);
    expect(check.permanent).toBe(true);
    // Allowed — the API allows it — but the caller is told so it can say so.
    expect(check.problem).toBeNull();
  });

  it('refuses an expiry in the past, exactly as the endpoint does', () => {
    const past = checkWaiver(
      { reason: 'Retired in Q3, deleted next sprint', expiresAt: '2026-10-01' },
      now,
    );
    expect(past.problem).toMatch(/already expired/);
    expect(past.permanent).toBe(false);

    const future = checkWaiver(
      { reason: 'Retired in Q3, deleted next sprint', expiresAt: '2027-01-01' },
      now,
    );
    expect(future.problem).toBeNull();
  });

  it('rejects an unparseable date instead of posting it', () => {
    expect(
      checkWaiver({ reason: 'Retired in Q3, deleted next sprint', expiresAt: 'soon' }, now).problem,
    ).toMatch(/not a date/);
  });

  it('proposes an expiry three months out', () => {
    expect(defaultExpiry(now)).toBe('2027-01-21');
  });

  it('omits expiresAt from the body rather than sending null', () => {
    expect(
      waiverBody('ROUTE:/legacy', { reason: '  Retired, deleted soon  ', expiresAt: '' }),
    ).toEqual({ key: 'ROUTE:/legacy', reason: 'Retired, deleted soon' });
    expect(
      waiverBody('ROUTE:/legacy', { reason: 'Retired, deleted soon', expiresAt: '2027-01-01' }),
    ).toEqual({ key: 'ROUTE:/legacy', reason: 'Retired, deleted soon', expiresAt: '2027-01-01' });
  });
});

// ─── The trend ───────────────────────────────────────────────────────────────

describe('the sparkline', () => {
  it('plots oldest on the left, though the API sends newest first', () => {
    // 40 → 80 improving. Newest first is how /trend returns it.
    const line = sparkline([{ percent: 80 }, { percent: 60 }, { percent: 40 }], 100, 20);
    expect(line).not.toBeNull();
    expect(line?.oldest).toBe(40);
    expect(line?.newest).toBe(80);
    // Rising means the last y is nearer the top of the box, which is y=0.
    const ys = line!.points.split(' ').map((pair) => Number(pair.split(',')[1]));
    expect(ys[0]).toBe(20);
    expect(ys[ys.length - 1]).toBe(0);
  });

  it('drops a null percent rather than drawing it as a cliff to zero', () => {
    const line = sparkline([{ percent: 62 }, { percent: null }, { percent: 60 }], 100, 20);
    expect(line?.count).toBe(2);
    expect(line?.unmeasured).toBe(1);
    expect(line?.oldest).toBe(60);
    expect(line?.points.split(' ')).toHaveLength(2);
  });

  it('draws no line through a single point', () => {
    expect(sparkline([{ percent: 62 }])).toBeNull();
    expect(sparkline([{ percent: null }, { percent: 62 }])).toBeNull();
    expect(sparkline([])).toBeNull();
  });

  it('survives a flat series without dividing by zero', () => {
    const line = sparkline([{ percent: 62 }, { percent: 62 }], 100, 20);
    const ys = line!.points.split(' ').map((pair) => Number(pair.split(',')[1]));
    expect(ys.every((y) => y === 10)).toBe(true);
  });
});

// ─── The stored number ───────────────────────────────────────────────────────

describe('drift from the stored snapshot', () => {
  it('is silent when the live number matches what a gate last acted on', () => {
    expect(storedDrift(totals(), stored())).toBeNull();
  });

  it('is silent when there is nothing stored yet', () => {
    expect(storedDrift(totals(), null)).toBeNull();
  });

  it('notices a moved percent and a moved denominator', () => {
    expect(storedDrift(totals(), stored({ percent: 58.1 }))?.drifted).toBe(true);
    // The denominator moving with the percentage unchanged is the interesting
    // one: the same ratio over a different inventory is a different claim.
    expect(storedDrift(totals(), stored({ denominator: 140 }))?.drifted).toBe(true);
  });

  it('does not call two nulls a drift', () => {
    expect(
      storedDrift(
        totals({ percent: null, denominator: 0 }),
        stored({ percent: null, denominator: 0 }),
      ),
    ).toBeNull();
  });
});
