/**
 * What these tests are for, in the order that matters.
 *
 *  1. **The exit code is the product.** `qaai coverage --min 80` is a CI gate,
 *     so the only thing a pipeline sees is a number. Three of them must never
 *     collapse into each other: 1 "coverage is below the floor", 2 "the gate
 *     never ran", 3 "there was nothing to divide". A team whose API key expired
 *     and a team who deleted their tests must not spend the same afternoon.
 *     The null-percent case gets the most attention here because both obvious
 *     answers to it are wrong — see `evaluateGate`'s own note.
 *
 *  2. **The five rules are asserted, not trusted.** A percentage of null is
 *     never rendered as a digit; ASSERTED_NOT_RUN never counts as covered;
 *     UNKNOWN never appears as a gap; an unmeasured axis is named rather than
 *     scored 0%; the caveats print above the list rather than nowhere. Each of
 *     these is a one-character change away from being a number that flatters
 *     us, which is why each has a test naming the lie it prevents.
 *
 *  3. **The vocabulary cannot drift.** This file imports @qaai/shared at RUN
 *     TIME — it is a test, excluded from the published build, so it may — and
 *     asserts that the label records and the axis order in coverage.ts cover
 *     and equal the shared originals. The command cannot import those values
 *     itself without giving the zero-dependency CLI a runtime dependency, so
 *     this mirror test is the only thing standing between one vocabulary and
 *     two. Same discipline as report.test.ts.
 *
 *  4. **Nothing is held back silently.** A list that prints 50 of 62 says so.
 *     A stored snapshot computed from different inputs than the figure being
 *     gated on says so.
 */

import { describe, expect, it } from 'vitest';
import {
  SURFACE_KINDS,
  SURFACE_KIND_LABELS,
  SURFACE_ORIGINS,
  SURFACE_ORIGIN_LABELS,
  SURFACE_STATUSES,
  SURFACE_STATUS_LABELS,
  totalsForItems,
  unmeasuredKinds,
} from '@qaai/shared';
import type { SurfaceItemCoverage, SurfaceKind, SurfaceOrigin, SurfaceStatus } from '@qaai/shared';
import {
  COVERAGE_EXIT,
  COVERAGE_VOCABULARY,
  cmdCoverage,
  coverageQueryString,
  evaluateGate,
  formatPercent,
  parseCoverageArgs,
  renderCoverageReport,
  renderUnmeasured,
  staleSnapshotNote,
  type CoverageOptions,
  type StoredSnapshotRow,
  type SurfaceReportResponse,
} from './coverage.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function entry(
  kind: SurfaceKind,
  label: string,
  status: SurfaceStatus,
  extra: { file?: string | null; line?: number | null; origin?: SurfaceOrigin } = {},
): SurfaceItemCoverage {
  return {
    item: {
      kind,
      key: `${kind}:${label}`,
      label,
      file: extra.file === undefined ? 'app/orders/page.tsx' : extra.file,
      line: extra.line === undefined ? 12 : extra.line,
      origin: extra.origin ?? 'BOTH',
      evidence: `${label} — directory path is the URL`,
      detector: 'next-app-router',
    },
    status,
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

const MATCHING_FINGERPRINT = 'inv_abc.cov_def';

function stored(overrides: Partial<StoredSnapshotRow> = {}): StoredSnapshotRow {
  return {
    id: 'snap_0',
    createdAt: '2026-10-22T08:00:00.000Z',
    commitSha: 'abc1234',
    percent: 40,
    denominator: 5,
    covered: 2,
    fingerprint: MATCHING_FINGERPRINT,
    ...overrides,
  };
}

/**
 * The API's response, with the totals computed by the CONTRACT's own
 * arithmetic rather than typed by hand. A fixture whose percentage was written
 * out by the test author would pass while the real division was wrong.
 */
function report(input: {
  items: SurfaceItemCoverage[];
  page?: SurfaceItemCoverage[];
  caveats?: string[];
  lastStored?: StoredSnapshotRow | null;
  total?: number;
  limit?: number;
}): SurfaceReportResponse {
  const page = input.page ?? input.items.filter((candidate) => candidate.status === 'UNCOVERED');
  const total = input.total ?? page.length;
  return {
    projectId: 'proj_1',
    snapshot: {
      id: 'snap_1',
      projectId: 'proj_1',
      createdAtIso: '2026-10-23T09:00:00.000Z',
      commitSha: 'abc1234',
      totals: totalsForItems(input.items),
      inputs: { analysisId: 'an_1', flowMapVersion: 3, testCount: 12, runId: null },
      caveats: input.caveats ?? [],
      fingerprint: MATCHING_FINGERPRINT,
    },
    items: page,
    total,
    offset: 0,
    limit: input.limit ?? 50,
    truncated: total > page.length,
    unmeasuredKinds: unmeasuredKinds(),
    lastStored: input.lastStored === undefined ? stored() : input.lastStored,
  };
}

/** 2 of 5 covered → 40.0%. */
const FORTY_PERCENT = [
  entry('ROUTE', '/orders', 'COVERED'),
  entry('ROUTE', '/orders/:id', 'COVERED'),
  entry('ROUTE', '/admin/billing', 'UNCOVERED'),
  entry('ENDPOINT', 'POST /api/refunds', 'UNCOVERED'),
  entry('AUTH_SURFACE', 'login', 'UNCOVERED', { file: 'app/(auth)/login/page.tsx', line: 4 }),
];

/** 4 of 5 covered → exactly 80.0%, for the boundary. */
const EIGHTY_PERCENT = [
  entry('ROUTE', '/a', 'COVERED'),
  entry('ROUTE', '/b', 'COVERED'),
  entry('ROUTE', '/c', 'COVERED'),
  entry('ROUTE', '/d', 'COVERED'),
  entry('ROUTE', '/e', 'UNCOVERED'),
];

const DEFAULT_OPTIONS: CoverageOptions = {
  projectId: 'proj_1',
  min: null,
  limit: 50,
  kinds: null,
  statuses: null,
  origin: null,
};

interface RunResult {
  code: number;
  out: string;
  err: string;
  urls: string[];
}

async function run(
  args: string[],
  transport: {
    payload?: unknown;
    status?: number;
    throws?: Error;
    json?: boolean;
    apiKey?: string;
  } = {},
): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const urls: string[] = [];
  const status = transport.status ?? 200;

  const code = await cmdCoverage(
    {
      apiUrl: 'http://api.test',
      apiKey: transport.apiKey ?? 'qa_key',
      json: transport.json ?? false,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      fetch: (url) => {
        urls.push(url);
        if (transport.throws) return Promise.reject(transport.throws);
        return Promise.resolve({
          ok: status < 400,
          status,
          json: () => Promise.resolve(transport.payload),
        });
      },
    },
    args,
  );

  return { code, out: out.join(''), err: err.join(''), urls };
}

// ─── 1. The gate, and the null-percent decision ──────────────────────────────

describe('the --min gate', () => {
  it('exits 0 when the percentage is above the floor', async () => {
    const result = await run(['--project', 'proj_1', '--min', '30'], {
      payload: report({ items: FORTY_PERCENT }),
    });
    expect(result.code).toBe(COVERAGE_EXIT.OK);
    expect(result.out).toContain('meets the --min 30% floor');
  });

  it('exits 1 when the percentage is below the floor', async () => {
    const result = await run(['--project', 'proj_1', '--min', '80'], {
      payload: report({ items: FORTY_PERCENT }),
    });
    expect(result.code).toBe(COVERAGE_EXIT.BELOW_FLOOR);
    expect(result.out).toContain('40.0% is below the --min 80% floor');
  });

  it('treats the floor as the lowest ACCEPTABLE value, so exactly 80 passes --min 80', async () => {
    // Off-by-one flapping at the boundary reads as a flaky gate, and a gate
    // nobody trusts gets deleted from the pipeline.
    const result = await run(['--project', 'proj_1', '--min', '80'], {
      payload: report({ items: EIGHTY_PERCENT }),
    });
    expect(result.code).toBe(COVERAGE_EXIT.OK);
  });

  it('never fails the build when no floor was asked for, even at 0%', async () => {
    const zero = [entry('ROUTE', '/a', 'UNCOVERED'), entry('ROUTE', '/b', 'UNCOVERED')];
    const result = await run(['--project', 'proj_1'], { payload: report({ items: zero }) });
    expect(result.code).toBe(COVERAGE_EXIT.OK);
    expect(result.out).toContain('0.0%');
  });

  describe('when percent is NULL — the case both obvious answers get wrong', () => {
    const nothingMeasured = report({
      items: [],
      caveats: [
        'No source analysis has run for this project, so the denominator is only what a crawl reached.',
      ],
      lastStored: null,
    });

    it('does not pass, because a check we never ran must not report success', async () => {
      const result = await run(['--project', 'proj_1', '--min', '80'], {
        payload: nothingMeasured,
      });
      expect(result.code).not.toBe(COVERAGE_EXIT.OK);
    });

    it('does not fail as "below the floor", because coverage did not drop', async () => {
      const result = await run(['--project', 'proj_1', '--min', '80'], {
        payload: nothingMeasured,
      });
      expect(result.code).not.toBe(COVERAGE_EXIT.BELOW_FLOOR);
    });

    it('exits 3, naming the missing input and the fix', async () => {
      const result = await run(['--project', 'proj_1', '--min', '80'], {
        payload: nothingMeasured,
      });
      expect(result.code).toBe(COVERAGE_EXIT.NOT_MEASURED);
      expect(result.out).toContain('not measured yet');
      expect(result.out).toContain('exit 3, not 1');
      // The diagnosis is the caveat the inventory already wrote, verbatim.
      expect(result.out).toContain('No source analysis has run for this project');
      expect(result.out).toContain('/surface/proj_1/recompute');
    });

    it('never prints a digit as the percentage', () => {
      const verdict = evaluateGate({
        min: 80,
        percent: null,
        denominator: 0,
        caveats: [],
        projectId: 'proj_1',
      });
      expect(verdict.message).not.toMatch(/\b0(\.0)?%/);
      expect(verdict.message).not.toMatch(/\b100(\.0)?%/);
    });

    it('still prints the report and exits 0 when no floor was asked for', async () => {
      const result = await run(['--project', 'proj_1'], { payload: nothingMeasured });
      expect(result.code).toBe(COVERAGE_EXIT.OK);
      expect(result.out).toContain('Surface coverage — not measured yet');
    });
  });

  it('keeps the three failure codes distinct', () => {
    const codes = [COVERAGE_EXIT.BELOW_FLOOR, COVERAGE_EXIT.USAGE, COVERAGE_EXIT.NOT_MEASURED];
    expect(new Set(codes).size).toBe(codes.length);
    expect(COVERAGE_EXIT.OK).toBe(0);
  });
});

// ─── 2. "Could not measure" must not look like "coverage dropped" ────────────

describe('transport and usage failures', () => {
  it('exits 2 — not 1 — when the API is unreachable', async () => {
    const result = await run(['--project', 'proj_1', '--min', '80'], {
      throws: new Error('connect ECONNREFUSED 127.0.0.1:4000'),
    });
    expect(result.code).toBe(COVERAGE_EXIT.USAGE);
    expect(result.code).not.toBe(COVERAGE_EXIT.BELOW_FLOOR);
    expect(result.err).toContain('Could not reach http://api.test');
    expect(result.err).toContain('nothing can be concluded');
  });

  it('exits 2 on a 500, and prints the API message when there is one', async () => {
    const result = await run(['--project', 'proj_1'], {
      status: 500,
      payload: { error: { message: 'Coverage store unavailable' } },
    });
    expect(result.code).toBe(COVERAGE_EXIT.USAGE);
    expect(result.err).toContain('Coverage store unavailable');
  });

  it('names the scope a coverage read needs when the key is refused', async () => {
    const result = await run(['--project', 'proj_1'], { status: 403, payload: null });
    expect(result.code).toBe(COVERAGE_EXIT.USAGE);
    expect(result.err).toContain('tests:read');
  });

  it('says which project was not found on a 404', async () => {
    const result = await run(['--project', 'proj_missing'], { status: 404, payload: null });
    expect(result.code).toBe(COVERAGE_EXIT.USAGE);
    expect(result.err).toContain('proj_missing');
  });

  it('refuses without an API key, before any request', async () => {
    const result = await run(['--project', 'proj_1'], {
      apiKey: '',
      payload: report({ items: [] }),
    });
    expect(result.code).toBe(COVERAGE_EXIT.USAGE);
    expect(result.err).toContain('QAAI_API_KEY');
    expect(result.urls).toHaveLength(0);
  });
});

// ─── 3. Argument parsing — a typo must not produce a green build ─────────────

describe('parseCoverageArgs', () => {
  it('requires a project', () => {
    const parsed = parseCoverageArgs(['--min', '80']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain('--project');
  });

  it('accepts the project as a bare argument, like qaai status', () => {
    const parsed = parseCoverageArgs(['proj_9']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.options.projectId).toBe('proj_9');
  });

  it('rejects a second bare argument rather than guessing', () => {
    const parsed = parseCoverageArgs(['proj_9', 'proj_10']);
    expect(parsed.ok).toBe(false);
  });

  it('rejects an unknown flag, naming the ones it takes', () => {
    // `--mim 80` silently ignored is a gate that reports success on a project
    // with no coverage at all.
    const parsed = parseCoverageArgs(['--project', 'p', '--mim', '80']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain('--mim');
      expect(parsed.message).toContain('--min');
    }
  });

  it.each([
    ['not a number', ['--min', 'eighty']],
    ['above 100', ['--min', '101']],
    ['below 0', ['--min', '-1']],
    ['empty', ['--min=']],
    ['missing its value', ['--min', '--json']],
  ])('rejects a --min that is %s', (_why, flags) => {
    const parsed = parseCoverageArgs(['--project', 'p', ...flags]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain('--min');
  });

  it.each([
    ['--min 80', ['--min', '80'], 80],
    ['--min=80', ['--min=80'], 80],
    ['a fractional floor', ['--min', '79.5'], 79.5],
    ['a floor of 0', ['--min', '0'], 0],
    ['a floor of 100', ['--min', '100'], 100],
  ])('accepts %s', (_what, flags, expected) => {
    const parsed = parseCoverageArgs(['--project', 'p', ...flags]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.options.min).toBe(expected);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['fractional', '2.5'],
    ['over the API cap', '1001'],
    ['not a number', 'fifty'],
  ])('rejects a --limit that is %s', (_why, value) => {
    const parsed = parseCoverageArgs(['--project', 'p', '--limit', value]);
    expect(parsed.ok).toBe(false);
  });

  it('defaults --limit to 50', () => {
    const parsed = parseCoverageArgs(['--project', 'p']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.options.limit).toBe(50);
  });

  it('upper-cases and splits --kind and --status', () => {
    const parsed = parseCoverageArgs([
      '--project',
      'p',
      '--kind',
      'route, form',
      '--status',
      'uncovered,unknown',
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.options.kinds).toEqual(['ROUTE', 'FORM']);
      expect(parsed.options.statuses).toEqual(['UNCOVERED', 'UNKNOWN']);
    }
  });

  it('rejects an unknown kind rather than letting it return an empty list', () => {
    // An empty list reads as "you have no uncovered endpoints", which is the
    // opposite of the truth.
    const parsed = parseCoverageArgs(['--project', 'p', '--kind', 'ROUTES']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain('ROUTES');
  });

  it('rejects a list of origins, which the query cannot express', () => {
    const parsed = parseCoverageArgs(['--project', 'p', '--origin', 'SOURCE_ONLY,BOTH']);
    expect(parsed.ok).toBe(false);
  });

  it('exits 2 on a usage error and prints the help', async () => {
    const result = await run(['--min', '80']);
    expect(result.code).toBe(COVERAGE_EXIT.USAGE);
    expect(result.err).toContain('Exit codes:');
    expect(result.urls).toHaveLength(0);
  });
});

describe('coverageQueryString', () => {
  it('passes the filters through, and asks for exactly what it will print', () => {
    const query = new URLSearchParams(
      coverageQueryString({
        ...DEFAULT_OPTIONS,
        limit: 10,
        kinds: ['ROUTE', 'FORM'],
        statuses: ['UNCOVERED'],
        origin: 'SOURCE_ONLY',
      }),
    );
    expect(query.get('limit')).toBe('10');
    expect(query.get('kind')).toBe('ROUTE,FORM');
    expect(query.get('status')).toBe('UNCOVERED');
    expect(query.get('origin')).toBe('SOURCE_ONLY');
  });

  it("omits filters nobody asked for, so the API's defaults apply", () => {
    const query = new URLSearchParams(coverageQueryString(DEFAULT_OPTIONS));
    expect(query.get('kind')).toBeNull();
    expect(query.get('status')).toBeNull();
    expect(query.get('origin')).toBeNull();
  });

  it('encodes the project id into the path', async () => {
    const result = await run(['--project', 'proj/1'], { payload: report({ items: [] }) });
    expect(result.urls[0]).toContain('/surface/proj%2F1?');
  });
});

// ─── 4. The report — the five rules ──────────────────────────────────────────

describe('the printed report', () => {
  const text = (payload: SurfaceReportResponse, options: Partial<CoverageOptions> = {}) =>
    renderCoverageReport(payload, { ...DEFAULT_OPTIONS, ...options }).join('\n');

  it('puts the percentage one line above the named list, and the list is the body', () => {
    const output = text(report({ items: FORTY_PERCENT }));
    expect(output.indexOf('Surface coverage — 40.0%')).toBe(0);
    expect(output).toContain('No test has ever asserted anything about 3 surfaces:');
    expect(output).toContain('/admin/billing');
    expect(output).toContain('app/(auth)/login/page.tsx:4');
  });

  it('groups by kind, worst axis first — auth, endpoints, routes, forms', () => {
    const items = [
      entry('FORM', 'checkout form', 'UNCOVERED'),
      entry('ROUTE', '/orders', 'UNCOVERED'),
      entry('ENDPOINT', 'POST /api/refunds', 'UNCOVERED'),
      entry('AUTH_SURFACE', 'login', 'UNCOVERED'),
    ];
    const output = text(report({ items }));
    const order = (label: string) => output.indexOf(label);
    expect(order('Auth surfaces —')).toBeLessThan(order('API endpoints —'));
    expect(order('API endpoints —')).toBeLessThan(order('Routes —'));
    expect(order('Routes —')).toBeLessThan(order('Forms —'));
  });

  it('rule 1: renders a null percentage as "not measured yet", never as a number', () => {
    const output = text(report({ items: [], lastStored: null }));
    expect(output).toContain('Surface coverage — not measured yet');
    expect(output).not.toMatch(/Surface coverage — \d/);
    // And it does not print "0 of 0 covered" beside it, which would invite the
    // reader to perform the division the null is there to refuse.
    expect(output).toContain('nothing was in the denominator');
    expect(output.split('\n')[0]).not.toContain('0 of 0');
  });

  it('rule 2: a test that has never run is its own state, not covered', () => {
    const items = [entry('ROUTE', '/a', 'COVERED'), entry('ROUTE', '/b', 'ASSERTED_NOT_RUN')];
    const payload = report({ items });
    // 1 of 2, not 2 of 2: a test that has not executed has not been shown to
    // pass or to assert anything.
    expect(payload.snapshot.totals.percent).toBe(50);
    const output = text(payload);
    expect(output).toContain('1 with a test that has never run');
    expect(output).toContain('1 never ran');
  });

  it('rule 3: UNKNOWN is reported as a limit of ours, never listed as a gap', () => {
    const items = [
      entry('ROUTE', '/a', 'COVERED'),
      entry('ROUTE', '/known-gap', 'UNCOVERED'),
      entry('ROUTE', '/runtime-url', 'UNKNOWN'),
    ];
    const output = text(report({ items }));
    expect(output).toContain('No test has ever asserted anything about 1 surface:');
    // The unknown item is counted and explained, but it is not in the list of
    // things nothing has tested.
    expect(output).toContain('1 cannot tell');
    expect(output).toContain('not counted as a gap and not counted as covered');
    const listStart = output.indexOf('No test has ever asserted');
    expect(output.slice(listStart)).not.toContain('/runtime-url');
  });

  it('rule 4: an unmeasured axis is named, never scored', () => {
    const output = text(report({ items: FORTY_PERCENT }));
    expect(output).toContain('Axes QAAI does not measure');
    expect(output).toContain('Component states');
    const block = renderUnmeasured(unmeasuredKinds());
    // The heading says "not 0%" on purpose. What must never appear is a FIGURE
    // against an axis: no row for an unextracted axis carries a percentage.
    expect(block[0]).toContain('not 0%');
    for (const row of block.filter((line) => line.startsWith('  · '))) {
      expect(row).not.toMatch(/\d+(\.\d+)?%/);
    }
  });

  it('rule 4: every declared-but-unextracted axis is named, not just some', () => {
    const output = text(report({ items: FORTY_PERCENT }));
    for (const kind of unmeasuredKinds()) {
      expect(output).toContain(SURFACE_KIND_LABELS[kind]);
    }
  });

  it('rule 5: caveats print under the figure and above the list', () => {
    const output = text(
      report({
        items: FORTY_PERCENT,
        caveats: ['The crawl stopped early (page cap of 60), so reachability is a lower bound.'],
      }),
    );
    const caveat = output.indexOf('The crawl stopped early');
    expect(caveat).toBeGreaterThan(-1);
    expect(caveat).toBeLessThan(output.indexOf('No test has ever asserted'));
    expect(output).toContain('What this number could not see (1):');
  });

  it('prints the per-axis arithmetic as counts, so the division is checkable', () => {
    const output = text(report({ items: FORTY_PERCENT }));
    expect(output).toContain('Per axis — counts, so you can check the division:');
    expect(output).toContain('2 covered');
    expect(output).toContain('in the denominator');
  });

  it('counts out loud whatever the list held back', () => {
    const output = text(report({ items: FORTY_PERCENT, total: 62, limit: 50 }));
    expect(output).toContain('more matching items not shown');
    expect(output).toContain('of 62');
  });

  it('marks the rows no runtime-only tool could produce', () => {
    const items = [entry('ROUTE', '/wizard/step-2', 'UNCOVERED', { origin: 'SOURCE_ONLY' })];
    const output = text(report({ items }));
    expect(output).toContain('declared in source, never reached');
  });

  it('says so rather than inventing a file when an item has none', () => {
    const items = [
      entry('ROUTE', '/only-crawled', 'UNCOVERED', {
        file: null,
        line: null,
        origin: 'CRAWL_ONLY',
      }),
    ];
    expect(text(report({ items }))).toContain('no declaring file');
  });

  it('labels each row when the page mixes statuses', () => {
    const items = [entry('ROUTE', '/a', 'UNCOVERED'), entry('ROUTE', '/b', 'UNKNOWN')];
    const output = text(report({ items, page: items }), {
      statuses: ['UNCOVERED', 'UNKNOWN'],
    });
    expect(output).toContain('[no test]');
    expect(output).toContain('[cannot tell]');
  });

  it('does not claim an empty match is good news', () => {
    const output = text(report({ items: [entry('ROUTE', '/a', 'COVERED')] }));
    expect(output).toContain('nothing in the inventory is uncovered under these filters');
  });
});

describe('formatPercent', () => {
  it('is the only place a percentage becomes text, and null is never a digit', () => {
    expect(formatPercent(null)).toBe('not measured yet');
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(100)).toBe('100.0%');
    expect(formatPercent(40)).toBe('40.0%');
  });
});

// ─── 5. A stale stored snapshot ──────────────────────────────────────────────

describe('the stored snapshot', () => {
  it('warns when the stored fingerprint differs from the figure being gated on', async () => {
    const payload = report({
      items: FORTY_PERCENT,
      lastStored: stored({ fingerprint: 'inv_old.cov_old', percent: 91.2, denominator: 12 }),
    });
    const result = await run(['--project', 'proj_1', '--min', '30'], { payload });
    expect(result.err).toContain('computed from different inputs');
    expect(result.err).toContain('91.2%');
    expect(result.err).toContain('/surface/proj_1/recompute');
    // A stale snapshot is a note, not a verdict: the gate still used the live
    // figure, and that figure met the floor.
    expect(result.code).toBe(COVERAGE_EXIT.OK);
  });

  it('says nothing when the stored snapshot matches', () => {
    const payload = report({ items: FORTY_PERCENT });
    expect(staleSnapshotNote(payload.snapshot, payload.lastStored, 'proj_1')).toBeNull();
  });

  it('says there is no trend when nothing has ever been stored', () => {
    const payload = report({ items: FORTY_PERCENT, lastStored: null });
    const note = staleSnapshotNote(payload.snapshot, null, 'proj_1');
    expect(note).toContain('Nothing has been stored');
    expect(note).toContain('recompute');
  });
});

// ─── 6. --json ───────────────────────────────────────────────────────────────

describe('--json', () => {
  it("hands back the API's own payload plus the verdict, and keeps the exit code", async () => {
    const payload = report({ items: FORTY_PERCENT });
    const result = await run(['--project', 'proj_1', '--min', '80'], { payload, json: true });

    expect(result.code).toBe(COVERAGE_EXIT.BELOW_FLOOR);
    const parsed = JSON.parse(result.out) as Record<string, unknown> & {
      gate: { state: string; exitCode: number; percent: number | null; min: number };
    };
    // Verbatim, so a customer can recompute our arithmetic from the same bytes.
    expect(parsed.snapshot).toEqual(payload.snapshot);
    expect(parsed.items).toEqual(payload.items);
    expect(parsed.total).toBe(payload.total);
    expect(parsed.unmeasuredKinds).toEqual(payload.unmeasuredKinds);
    expect(parsed.gate).toEqual({
      min: 80,
      percent: 40,
      state: 'BELOW_FLOOR',
      exitCode: COVERAGE_EXIT.BELOW_FLOOR,
      message: expect.stringContaining('below the --min 80% floor'),
    });
  });

  it('carries null through as null rather than zero', async () => {
    const result = await run(['--project', 'proj_1', '--min', '80'], {
      payload: report({ items: [], lastStored: null }),
      json: true,
    });
    const parsed = JSON.parse(result.out) as {
      gate: { percent: number | null; state: string };
      snapshot: { totals: { percent: number | null } };
    };
    expect(parsed.gate.percent).toBeNull();
    expect(parsed.snapshot.totals.percent).toBeNull();
    expect(parsed.gate.state).toBe('NOT_MEASURED');
    expect(result.code).toBe(COVERAGE_EXIT.NOT_MEASURED);
  });

  it('keeps stdout parseable by routing the stale-snapshot note to stderr', async () => {
    const result = await run(['--project', 'proj_1'], {
      payload: report({
        items: FORTY_PERCENT,
        lastStored: stored({ fingerprint: 'other' }),
      }),
      json: true,
    });
    expect(() => JSON.parse(result.out)).not.toThrow();
    expect(result.err).toBe('');
    const parsed = JSON.parse(result.out) as { stale: { isStale: boolean; note: string | null } };
    expect(parsed.stale.isStale).toBe(true);
    expect(parsed.stale.note).toContain('different inputs');
  });
});

// ─── 7. The mirror: one vocabulary, not two ──────────────────────────────────

describe('the vocabulary mirrored from @qaai/shared', () => {
  it('labels every kind, with the shared wording', () => {
    expect(COVERAGE_VOCABULARY.KIND_LABELS).toEqual(SURFACE_KIND_LABELS);
    expect(Object.keys(COVERAGE_VOCABULARY.KIND_LABELS).sort()).toEqual([...SURFACE_KINDS].sort());
  });

  it('labels every status, with the shared wording', () => {
    expect(COVERAGE_VOCABULARY.STATUS_LABELS).toEqual(SURFACE_STATUS_LABELS);
    expect(Object.keys(COVERAGE_VOCABULARY.STATUS_LABELS).sort()).toEqual(
      [...SURFACE_STATUSES].sort(),
    );
  });

  it('labels every origin, with the shared wording', () => {
    expect(COVERAGE_VOCABULARY.ORIGIN_LABELS).toEqual(SURFACE_ORIGIN_LABELS);
    expect(Object.keys(COVERAGE_VOCABULARY.ORIGIN_LABELS).sort()).toEqual(
      [...SURFACE_ORIGINS].sort(),
    );
  });

  it('orders every kind, so a new axis cannot fall out of the report', () => {
    // A kind added to @qaai/shared and not to KIND_ORDER would still print —
    // orderedKinds() appends unknowns — but it would print last whatever its
    // severity, so this fails instead and someone decides where it belongs.
    expect([...COVERAGE_VOCABULARY.KIND_ORDER].sort()).toEqual([...SURFACE_KINDS].sort());
  });

  it('ranks the four measured axes first, worst first', () => {
    expect(COVERAGE_VOCABULARY.KIND_ORDER.slice(0, 4)).toEqual([
      'AUTH_SURFACE',
      'ENDPOINT',
      'ROUTE',
      'FORM',
    ]);
  });
});
