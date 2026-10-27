import { describe, expect, it } from 'vitest';
import {
  CELL_KIND_DIMENSION,
  COVERAGE_CELL_KINDS,
  COVERAGE_DIMENSIONS,
  COVERAGE_TIERS,
  ROUTE_ACCESS_OUTCOMES,
  coverageItemStateSchema,
  dimensionCellIdentity,
  dimensionMeasurementSchema,
  dimensionPercentAt,
  type CoverageCellKind,
  type SurfaceExercise,
} from '@qaai/shared';
import {
  ACCESS_OUTCOME_CELL,
  BOUNCE_CELL,
  DATA_PROFILE_CELL,
  DECLARING_CLAIM_BASES,
  FAULT_STATE_CELL,
  FAULT_STATE_DIMENSION,
  INTERSTITIAL_CELL,
  NEVER_SUMMED_RULE,
  PROBE_KIND_CELL,
  PROBE_VERDICT_MEASURES,
  STATE_CLAIM_BASES,
  STATE_CLAIM_BASIS_KINDS,
  STATE_CLAIM_BASIS_SOURCE,
  STATE_DIMENSIONS,
  STRUCTURAL_STATE_CELL,
  UNNAMEABLE_CELL_REASON,
  VARIANT_OUTCOME_OBSERVED,
  blocksStateEnumeration,
  combineUnmeasured,
  dataVariantOfProfile,
  errorCellForStatus,
  errorStateBreakdown,
  errorStateOfAccess,
  errorStateOfProbe,
  isStateDimension,
  measureStateDimensions,
  pageStatesOfNode,
  parseStateCellKey,
  promoteStateClaim,
  stateCellKey,
  stateOfFault,
  unproducedDataCells,
  type AccessStateFact,
  type DataProfileFact,
  type ProbeStateFact,
  type StateClaim,
  type StateDimensionReport,
  type StateEnumerationInput,
  type StateItem,
  type StateNodeFact,
} from './coverage-states';
import { BOUNCE_KINDS, INTERSTITIAL_KINDS, PROBE_KINDS, PROBE_VERDICTS, STRUCTURAL_STATES } from './crawl/observe';
import { DATA_PROFILE_KINDS, FAULT_STATES, VARIANT_OUTCOMES } from './crawl/variants';
import type { InterstitialFinding, StructuralVerdict } from './crawl/observe';

/**
 * What is and is not covered here.
 *
 * Every function in coverage-states.ts is pure — the inputs are narrow records
 * the caller already holds, which is why there is no browser and no clock in
 * this file and why `nowIso` is passed to every tier assertion.
 *
 * The tests are grouped by the three register items, then by the honesty rules
 * that cut across all three, because that is where a mistake would silently
 * flatter the number: an un-enumerated route read as "one state, covered", a
 * role-by-role refusal double-counted on two axes, an English phrase promoted
 * to an assertion, a held-out state scored as a pass, or three denominators
 * added together.
 */

const NOW = '2026-10-26T12:00:00.000Z';
const SEEN = '2026-10-26T11:00:00.000Z';
const EARLIER = '2026-10-20T11:00:00.000Z';

function route(key: string, label = key): StateItem {
  return { key, label, kind: 'ROUTE' };
}

function structural(
  state: StructuralVerdict['state'],
  basis: StructuralVerdict['basis'] = 'STRONG',
): StructuralVerdict {
  return {
    state,
    basis,
    signals:
      basis === 'NONE'
        ? []
        : [{ signal: 'ARIA_BUSY', strength: basis === 'STRONG' ? 'STRONG' : 'WEAK', state, detail: 'a signal' }],
    why: `the page read as ${state}`,
  };
}

function interstitial(
  kind: InterstitialFinding['kind'],
  blocksEnumeration = false,
): InterstitialFinding {
  return {
    kind,
    signals: [{ signal: 'CHALLENGE_HEADER', strength: 'STRONG', detail: 'a header' }],
    blocksEnumeration,
    reason: `a ${kind} answered`,
    degradation: null,
  };
}

function node(itemKey: string, over: Partial<StateNodeFact> = {}): StateNodeFact {
  return {
    itemKey,
    nodeStateKey: over.nodeStateKey ?? 'default',
    status: over.status === undefined ? { code: 200, class: 'OK', isErrorPage: false } : over.status,
    structural: over.structural === undefined ? structural('POPULATED') : over.structural,
    interstitial: over.interstitial ?? null,
    bounce: over.bounce ?? null,
    observedAtIso: over.observedAtIso ?? SEEN,
    exercise: over.exercise ?? null,
  };
}

function accessFact(itemKey: string, over: Partial<AccessStateFact> = {}): AccessStateFact {
  return {
    itemKey,
    role: over.role ?? 'VIEWER',
    outcome: over.outcome ?? 'FORBIDDEN',
    basis: over.basis ?? 'OBSERVED',
    probedAtIso: over.probedAtIso === undefined ? SEEN : over.probedAtIso,
    evidence: over.evidence ?? 'refused with 403',
  };
}

function probeFact(itemKey: string, over: Partial<ProbeStateFact> = {}): ProbeStateFact {
  return {
    itemKey,
    probeKind: over.probeKind ?? 'BAD_ID',
    verdict: over.verdict ?? 'ERROR_PATH_CONFIRMED',
    status: over.status === undefined ? 404 : over.status,
    observedAtIso: over.observedAtIso ?? SEEN,
    evidence: over.evidence ?? 'asked for id 0 and got a 404',
    exercise: over.exercise ?? null,
  };
}

function profileFact(itemKey: string, over: Partial<DataProfileFact> = {}): DataProfileFact {
  return {
    itemKey,
    profileKey: over.profileKey ?? 'empty-account',
    profile: over.profile ?? 'EMPTY',
    outcome: over.outcome ?? 'OBSERVED',
    observedAtIso: over.observedAtIso === undefined ? SEEN : over.observedAtIso,
    evidence: over.evidence ?? 'crawled with a zero-row account',
    exercise: over.exercise ?? null,
  };
}

function claim(stateKey: string, over: Partial<StateClaim> = {}): StateClaim {
  return {
    stateKey,
    basis: over.basis ?? 'RUN_OBSERVED',
    testId: over.testId ?? 'test-1',
    runId: over.runId === undefined ? 'run-1' : over.runId,
    navigationObserved: over.navigationObserved ?? true,
    assertionObserved: over.assertionObserved ?? true,
    runStatus: over.runStatus === undefined ? 'PASSED' : over.runStatus,
    retriedAndPassed: over.retriedAndPassed ?? false,
    quarantined: over.quarantined ?? false,
    confirmedAtIso: over.confirmedAtIso === undefined ? SEEN : over.confirmedAtIso,
    evidence: over.evidence ?? 'a run reached and asserted this state',
  };
}

function measure(over: Partial<StateEnumerationInput> & { items: readonly StateItem[] }): StateDimensionReport {
  return measureStateDimensions({ nowIso: NOW, ...over });
}

const REFUSED: SurfaceExercise = {
  state: 'REFUSED',
  reason: null,
  rule: 'destructive-paths',
  detail: 'the crawl policy refuses /orders/:id/delete',
};

const UNEXERCISABLE: SurfaceExercise = {
  state: 'UNEXERCISABLE',
  reason: 'NEEDS_DISPOSABLE_DATA',
  rule: null,
  detail: 'no disposable account is provisioned for the empty profile',
};

// ─────────────────────────────────────────────────────────────────────────────
// 0. The vocabularies — the run-time half of every compile-time Record
// ─────────────────────────────────────────────────────────────────────────────

describe('the axes this module measures', () => {
  it('measures exactly three of the keystone dimensions, and they are real ones', () => {
    expect([...STATE_DIMENSIONS].sort()).toEqual(['DATA_VARIANT', 'ERROR_STATE', 'PAGE_STATE']);
    for (const dimension of STATE_DIMENSIONS) expect(COVERAGE_DIMENSIONS).toContain(dimension);
  });

  it('refuses a dimension it does not measure', () => {
    expect(isStateDimension('PAGE_STATE')).toBe(true);
    // FORM_FIELD is a sibling agent's axis. A row of ours counted on it would
    // be stored where no form reader looks.
    expect(isStateDimension('FORM_FIELD')).toBe(false);
    expect(isStateDimension('COMPONENT_STATE')).toBe(false);
  });
});

describe('the vocabulary bridges', () => {
  it('answers for every structural state, and only decides the two it can', () => {
    expect(Object.keys(STRUCTURAL_STATE_CELL).sort()).toEqual([...STRUCTURAL_STATES].sort());
    // ERROR is null because WHICH error is the status's answer, not the DOM's.
    expect(STRUCTURAL_STATE_CELL.ERROR).toBeNull();
    expect(STRUCTURAL_STATE_CELL.UNKNOWN).toBeNull();
    expect(STRUCTURAL_STATE_CELL.POPULATED).toBe('PAGE_DEFAULT');
  });

  it('answers for every interstitial kind, and mints nothing for OUR blockage', () => {
    expect(Object.keys(INTERSTITIAL_CELL).sort()).toEqual([...INTERSTITIAL_KINDS].sort());
    // A site-wide bot wall would otherwise mint one fabricated cell per route.
    expect(INTERSTITIAL_CELL.BOT_CHALLENGE).toBeNull();
    expect(INTERSTITIAL_CELL.MAINTENANCE).toBeNull();
    expect(INTERSTITIAL_CELL.LOGIN_WALL).toBe('ERROR_UNAUTHENTICATED');
    expect(INTERSTITIAL_CELL.CONSENT_WALL).toBe('PAGE_INTERSTITIAL');
  });

  it('answers for every bounce kind and leaves ERROR_STATUS to the status', () => {
    expect(Object.keys(BOUNCE_CELL).sort()).toEqual([...BOUNCE_KINDS].sort());
    expect(BOUNCE_CELL.NONE).toBeNull();
    expect(BOUNCE_CELL.ERROR_STATUS).toBeNull();
    expect(BOUNCE_CELL.SOFT_NAVIGATION).toBe('PAGE_REDIRECTED');
  });

  it('answers for every access outcome and mints nothing for ALLOWED', () => {
    expect(Object.keys(ACCESS_OUTCOME_CELL).sort()).toEqual([...ROUTE_ACCESS_OUTCOMES].sort());
    // Being served is a ROLE_CELL measurement. A cell here would put one fact
    // on two denominators.
    expect(ACCESS_OUTCOME_CELL.ALLOWED).toBeNull();
    expect(ACCESS_OUTCOME_CELL.ERRORED).toBeNull();
    expect(ACCESS_OUTCOME_CELL.NOT_PROBED).toBeNull();
  });

  it('answers for every probe verdict and every probe kind', () => {
    expect(Object.keys(PROBE_VERDICT_MEASURES).sort()).toEqual([...PROBE_VERDICTS].sort());
    expect(PROBE_VERDICT_MEASURES.UNMEASURED).toBe(false);
    // The soft 404 — the case that fools every other tool — is a measurement.
    expect(PROBE_VERDICT_MEASURES.SOFT_ERROR).toBe(true);
    expect(Object.keys(PROBE_KIND_CELL).sort()).toEqual([...PROBE_KINDS].sort());
    expect(PROBE_KIND_CELL.UNSUPPORTED_METHOD).toBeNull();
  });

  it('answers for every fault state and every variant outcome', () => {
    expect(Object.keys(FAULT_STATE_CELL).sort()).toEqual([...FAULT_STATES].sort());
    expect(FAULT_STATE_CELL.PARTIAL).toBeNull();
    expect(FAULT_STATE_CELL.RATE_LIMITED).toBeNull();
    expect(Object.keys(VARIANT_OUTCOME_OBSERVED).sort()).toEqual([...VARIANT_OUTCOMES].sort());
    expect(
      VARIANT_OUTCOMES.filter((outcome) => VARIANT_OUTCOME_OBSERVED[outcome]),
    ).toEqual(['OBSERVED']);
  });

  it('files every fault state on the same axis its cell counts toward', () => {
    expect(Object.keys(FAULT_STATE_DIMENSION).sort()).toEqual([...FAULT_STATES].sort());
    for (const fault of FAULT_STATES) {
      const kind = FAULT_STATE_CELL[fault];
      if (kind === null) continue;
      // The two records cannot disagree: an unnameable fault counted on the
      // wrong axis would be a shortfall reported against the wrong number.
      expect(FAULT_STATE_DIMENSION[fault]).toBe(CELL_KIND_DIMENSION[kind]);
    }
    expect(FAULT_STATE_DIMENSION.RATE_LIMITED).toBe('ERROR_STATE');
    expect(FAULT_STATE_DIMENSION.PARTIAL).toBe('PAGE_STATE');
  });

  it('names the two bases that declare a state exists rather than test it', () => {
    expect([...DECLARING_CLAIM_BASES].sort()).toEqual(['API_STATUS', 'SOURCE_HANDLER']);
    // A phrase in a test file is a claim about a TEST, not a declaration that
    // the application has the state, so it is deliberately not here.
    expect(DECLARING_CLAIM_BASES).not.toContain('ENGLISH_PHRASE');
    expect(DECLARING_CLAIM_BASES).not.toContain('RUN_OBSERVED');
  });

  it('answers for every data profile and names the cells no profile produces', () => {
    expect(Object.keys(DATA_PROFILE_CELL).sort()).toEqual([...DATA_PROFILE_KINDS].sort());
    // The three entitlement profiles have no member in the cell vocabulary and
    // are never relabelled as a data shape they are not.
    expect(DATA_PROFILE_CELL.TRIAL_EXPIRED).toBeNull();
    expect(DATA_PROFILE_CELL.QUOTA_EXCEEDED).toBeNull();
    expect(DATA_PROFILE_CELL.PLAN_TIER).toBeNull();
    expect(unproducedDataCells().sort()).toEqual(['DATA_MALFORMED', 'DATA_ONE']);
  });

  it('never names a cell that belongs to another agent’s dimension', () => {
    const produced = [
      ...Object.values(STRUCTURAL_STATE_CELL),
      ...Object.values(INTERSTITIAL_CELL),
      ...Object.values(BOUNCE_CELL),
      ...Object.values(ACCESS_OUTCOME_CELL),
      ...Object.values(PROBE_KIND_CELL),
      ...Object.values(FAULT_STATE_CELL),
      ...Object.values(DATA_PROFILE_CELL),
    ].filter((kind): kind is CoverageCellKind => kind !== null);
    expect(produced.length).toBeGreaterThan(0);
    for (const kind of produced) {
      expect(COVERAGE_CELL_KINDS).toContain(kind);
      expect(isStateDimension(CELL_KIND_DIMENSION[kind])).toBe(true);
    }
  });

  it('maps a status to the cell a test would drive, and null where it cannot', () => {
    expect(errorCellForStatus(401)).toBe('ERROR_UNAUTHENTICATED');
    expect(errorCellForStatus(403)).toBe('ERROR_FORBIDDEN');
    expect(errorCellForStatus(404)).toBe('ERROR_NOT_FOUND');
    expect(errorCellForStatus(410)).toBe('ERROR_NOT_FOUND');
    expect(errorCellForStatus(422)).toBe('ERROR_VALIDATION');
    expect(errorCellForStatus(503)).toBe('ERROR_SERVER');
    // No member for these, so they are counted as unnameable rather than filed
    // under a neighbour nobody would look under.
    expect(errorCellForStatus(405)).toBeNull();
    expect(errorCellForStatus(429)).toBeNull();
    // Not an error at all, and null is not 0.
    expect(errorCellForStatus(200)).toBeNull();
    expect(errorCellForStatus(null)).toBeNull();
    expect(errorCellForStatus(undefined)).toBeNull();
  });

  it('pins every claim basis to one edge source, with the phrase on STATIC', () => {
    expect([...STATE_CLAIM_BASIS_KINDS].sort()).toEqual([...STATE_CLAIM_BASES].sort());
    expect(Object.keys(STATE_CLAIM_BASIS_SOURCE).sort()).toEqual([...STATE_CLAIM_BASES].sort());
    // The one that matters: a regex over test source can never be RUNTIME, so
    // `COVERAGE_EDGE_SOURCE_CEILING` caps it at DECLARED with no code here.
    expect(STATE_CLAIM_BASIS_SOURCE.ENGLISH_PHRASE).toBe('STATIC');
    expect(STATE_CLAIM_BASIS_SOURCE.RUN_OBSERVED).toBe('RUNTIME');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The cell key — one format, and it must survive a round trip
// ─────────────────────────────────────────────────────────────────────────────

describe('stateCellKey', () => {
  it('builds on dimensionCellIdentity rather than inventing a second format', () => {
    expect(stateCellKey({ itemKey: '/orders', kind: 'PAGE_EMPTY' })).toBe(
      dimensionCellIdentity('/orders#PAGE_EMPTY', []),
    );
    expect(stateCellKey({ itemKey: '/orders', kind: 'PAGE_EMPTY' })).toBe('/orders#PAGE_EMPTY');
  });

  it('round trips, with a qualifier and with coordinates', () => {
    const bare = stateCellKey({ itemKey: '/orders', kind: 'PAGE_EMPTY' });
    expect(parseStateCellKey(bare)).toEqual({
      itemKey: '/orders',
      kind: 'PAGE_EMPTY',
      qualifier: null,
      coordinates: [],
    });

    const qualified = stateCellKey({
      itemKey: '/checkout',
      kind: 'PAGE_INTERSTITIAL',
      qualifier: 'CONSENT_WALL',
    });
    expect(qualified).toBe('/checkout#PAGE_INTERSTITIAL:CONSENT_WALL');
    expect(parseStateCellKey(qualified)?.qualifier).toBe('CONSENT_WALL');

    const coordinated = stateCellKey({
      itemKey: '/admin/billing',
      kind: 'ERROR_FORBIDDEN',
      coordinates: [
        { dimension: 'DEVICE', value: 'iphone-15' },
        { dimension: 'ROLE', value: 'VIEWER' },
      ],
    });
    // Coordinates keep `SURFACE_DIMENSION_KINDS` order, not alphabetical order.
    expect(coordinated).toBe('/admin/billing#ERROR_FORBIDDEN|ROLE=VIEWER|DEVICE=iphone-15');
    expect(parseStateCellKey(coordinated)?.coordinates).toEqual([
      { dimension: 'ROLE', value: 'VIEWER' },
      { dimension: 'DEVICE', value: 'iphone-15' },
    ]);
  });

  it('round trips an item key that carries the format’s reserved characters', () => {
    const key = stateCellKey({ itemKey: 'app/Form.tsx|3=a', kind: 'ERROR_VALIDATION' });
    expect(parseStateCellKey(key)?.itemKey).toBe('app/Form.tsx|3=a');
    expect(parseStateCellKey(key)?.kind).toBe('ERROR_VALIDATION');
  });

  it('refuses a qualifier that would make the key unparseable', () => {
    expect(() =>
      stateCellKey({ itemKey: '/orders', kind: 'PAGE_INTERSTITIAL', qualifier: 'a#b' }),
    ).toThrow(/separator/);
    expect(() =>
      stateCellKey({ itemKey: '/orders', kind: 'PAGE_INTERSTITIAL', qualifier: '' }),
    ).toThrow(/not a qualifier/);
  });

  it('refuses to parse a string that is not one of ours', () => {
    expect(parseStateCellKey('/orders')).toBeNull();
    expect(parseStateCellKey('')).toBeNull();
    // A kind the vocabulary does not hold: returning it would hand the caller a
    // CoverageCellKind no Record keyed on the union can answer for.
    expect(parseStateCellKey('/orders#PAGE_PURPLE')).toBeNull();
    expect(parseStateCellKey('/orders#PAGE_EMPTY:')).toBeNull();
  });

  it('keeps the structural BASIS out of the key, so a cell is not re-minted', () => {
    // `structuralStateKeyPart` includes the basis on purpose. A key that did so
    // would retire one cell and mint another the first time an empty state was
    // decided on a strong signal instead of a weak one, and every diff across
    // that crawl would report a state appearing and a state vanishing.
    const weak = measure({
      items: [route('/orders')],
      nodes: [node('/orders', { structural: structural('EMPTY', 'WEAK_ONLY') })],
    });
    const strong = measure({
      items: [route('/orders')],
      nodes: [node('/orders', { structural: structural('EMPTY', 'STRONG') })],
    });
    expect(weak.rows.map((row) => row.stateKey)).toEqual(strong.rows.map((row) => row.stateKey));
    // And the basis is still reported, on the evidence.
    expect(weak.rows[0]?.evidence).toContain('WEAK_ONLY');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ITEM 1 — page-state coverage per (route, stateKey)
// ─────────────────────────────────────────────────────────────────────────────

describe('item 1 — page states are cells, not one folded route entry', () => {
  it('gives an empty state and a populated state their own cells', () => {
    const report = measure({
      items: [route('/orders')],
      nodes: [
        node('/orders', { nodeStateKey: 'populated' }),
        node('/orders', { nodeStateKey: 'empty', structural: structural('EMPTY') }),
      ],
    });
    expect(report.pageStates.measured).toBe(2);
    expect(report.rows.map((row) => row.kind).sort()).toEqual(['PAGE_DEFAULT', 'PAGE_EMPTY']);
    // The whole point: untested empty state is now one of two cells and not
    // invisible inside one route entry.
    expect(report.pageStates.tiers.unclaimed).toBe(2);
  });

  it('reports a route whose states nobody enumerated as NOT_ENUMERATED, not covered', () => {
    const report = measure({ items: [route('/orders'), route('/settings')] });
    expect(report.pageStates.measured).toBe(0);
    expect(report.pageStates.unmeasured).toBe(2);
    expect(report.pageStates.unmeasuredReason).toBe('NOT_ENUMERATED');
    expect(report.notEnumerated.filter((entry) => entry.dimension === 'PAGE_STATE')).toHaveLength(2);
    // NOT MEASURED IS NULL, NEVER 0 — at every rung.
    for (const tier of COVERAGE_TIERS) {
      expect(dimensionPercentAt(report.pageStates, tier)).toBeNull();
    }
  });

  it('says the un-enumerated count is a FLOOR rather than a count', () => {
    const report = measure({ items: [route('/orders')] });
    expect(report.pageStates.unmeasuredDetail).toContain('FLOOR');
    expect(report.unmeasuredBreakdown.PAGE_STATE).toEqual([
      expect.objectContaining({ reason: 'NOT_ENUMERATED', cells: 1 }),
    ]);
  });

  it('reports a structural read that did not run as NOT_ENUMERATED', () => {
    const report = measure({
      items: [route('/orders')],
      // basis NONE is `detectStructuralState(null)`: the read did not run.
      nodes: [node('/orders', { status: null, structural: structural('UNKNOWN', 'NONE') })],
    });
    expect(report.pageStates.measured).toBe(0);
    expect(report.pageStates.unmeasuredReason).toBe('NOT_ENUMERATED');
  });

  it('reports a read that ran and could not decide as EXTRACTOR_RETURNED_UNKNOWN', () => {
    const report = measure({
      items: [route('/orders')],
      nodes: [node('/orders', { structural: structural('UNKNOWN', 'WEAK_ONLY') })],
    });
    expect(report.pageStates.unmeasuredReason).toBe(UNNAMEABLE_CELL_REASON);
    expect(report.unnameable).toEqual([
      expect.objectContaining({ itemKey: '/orders', dimension: 'PAGE_STATE' }),
    ]);
    // Enumerated, so there is no NOT_ENUMERATED floor on top of it.
    expect(report.notEnumerated.filter((entry) => entry.dimension === 'PAGE_STATE')).toHaveLength(0);
  });

  it('gives two different interstitials two cells, and keeps the wall off the page', () => {
    const report = measure({
      items: [route('/checkout')],
      nodes: [
        node('/checkout', { interstitial: interstitial('CONSENT_WALL') }),
        node('/checkout', { interstitial: interstitial('AGE_GATE'), structural: null }),
      ],
    });
    const interstitials = report.rows.filter((row) => row.kind === 'PAGE_INTERSTITIAL');
    expect(interstitials.map((row) => row.stateKey).sort()).toEqual([
      '/checkout#PAGE_INTERSTITIAL:AGE_GATE',
      '/checkout#PAGE_INTERSTITIAL:CONSENT_WALL',
    ]);
  });

  it('marks the page states NOT_ENUMERATED when an interstitial blocked the read', () => {
    const wall = interstitial('LOGIN_WALL', true);
    expect(blocksStateEnumeration(node('/admin', { interstitial: wall }))).toBe(true);
    const report = measure({
      items: [route('/admin')],
      nodes: [node('/admin', { interstitial: wall, structural: null, status: null })],
    });
    // The wall itself is a state we saw — on the ERROR_STATE axis.
    expect(report.rows.map((row) => row.kind)).toEqual(['ERROR_UNAUTHENTICATED']);
    // The page behind it was never read, so its page-state set is unknown.
    expect(report.pageStates.unmeasuredReason).toBe('NOT_ENUMERATED');
    expect(report.notEnumerated[0]?.why).toContain('blocked');
  });

  it('mints no page-state cell for a bot wall, which is our blockage and not a state', () => {
    const report = measure({
      items: [route('/orders'), route('/settings')],
      nodes: [
        node('/orders', { interstitial: interstitial('BOT_CHALLENGE', true), structural: null, status: null }),
        node('/settings', { interstitial: interstitial('BOT_CHALLENGE', true), structural: null, status: null }),
      ],
    });
    expect(report.rows).toHaveLength(0);
    expect(report.pageStates.cells).toBe(2);
    expect(report.pageStates.measured).toBe(0);
  });

  it('records a redirect as its own cell', () => {
    const report = measure({
      items: [route('/admin/billing')],
      nodes: [
        node('/admin/billing', {
          structural: null,
          status: { code: 302, class: 'REDIRECT', isErrorPage: false },
          bounce: { kind: 'SAME_ORIGIN_REDIRECT', finalRoute: '/upgrade', status: 302 },
        }),
      ],
    });
    expect(report.rows.map((row) => row.kind)).toEqual(['PAGE_REDIRECTED']);
    expect(report.rows[0]?.evidence).toContain('/upgrade');
  });

  it('keeps an ENDPOINT out of the page-state denominator, because it has no page', () => {
    const report = measure({
      items: [{ key: 'GET /api/orders', label: 'GET /api/orders', kind: 'ENDPOINT' }],
      nodes: [node('GET /api/orders')],
      probes: [probeFact('GET /api/orders')],
    });
    expect(report.pageStates.cells).toBe(0);
    expect(dimensionPercentAt(report.pageStates, 'NAVIGATED')).toBeNull();
    // ERROR_STATE refines ENDPOINT, so the probe still counts there.
    expect(report.errorStates.measured).toBe(1);
  });

  it('classifies a soft error page as found-and-unnameable rather than guessing', () => {
    const report = measure({
      items: [route('/orders/:id')],
      nodes: [
        node('/orders/:id', {
          structural: structural('ERROR'),
          status: { code: 200, class: 'OK', isErrorPage: true },
        }),
      ],
    });
    expect(report.rows).toHaveLength(0);
    expect(report.unnameable[0]?.why).toContain('does not say which');
    expect(report.errorStates.unmeasuredReason).toBe(UNNAMEABLE_CELL_REASON);
  });

  it('reads an error page with a status as that status’s cell', () => {
    const report = measure({
      items: [route('/orders/:id')],
      nodes: [
        node('/orders/:id', {
          structural: structural('ERROR'),
          status: { code: 500, class: 'SERVER_ERROR', isErrorPage: true },
        }),
      ],
    });
    expect(report.rows.map((row) => row.kind)).toEqual(['ERROR_SERVER']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ITEM 2 — error and empty states as their own dimension
// ─────────────────────────────────────────────────────────────────────────────

describe('item 2 — error states, declared vs asserted vs merely mentioned', () => {
  it('records one forbidden state per route, however many roles were refused', () => {
    const report = measure({
      items: [route('/admin/billing')],
      access: [
        accessFact('/admin/billing', { role: 'VIEWER' }),
        accessFact('/admin/billing', { role: 'SUPPORT' }),
        accessFact('/admin/billing', { role: 'MEMBER' }),
      ],
    });
    // One cell, three sightings. One cell per role would rebuild route × role
    // inside ERROR_STATE and double-count every refusal with ROLE_CELL.
    expect(report.errorStates.measured).toBe(1);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.sightings).toBe(3);
    expect(report.rows[0]?.stateKey).toBe('/admin/billing#ERROR_FORBIDDEN');
  });

  it('learns nothing from an errored probe and does not call it forbidden', () => {
    const report = measure({
      items: [route('/admin')],
      access: [accessFact('/admin', { outcome: 'ERRORED', evidence: 'a 502 from the box' })],
    });
    expect(report.rows).toHaveLength(0);
    // Not enumerated: nobody learned anything about this route's error states.
    expect(report.errorStates.unmeasuredReason).toBe('NOT_ENUMERATED');
    expect(errorStateOfAccess(accessFact('/admin', { outcome: 'ERRORED' }))).toMatchObject({
      kind: 'NOTHING',
      enumerated: false,
    });
  });

  it('counts a served route as enumeration with no error cell', () => {
    const report = measure({
      items: [route('/pricing')],
      access: [accessFact('/pricing', { outcome: 'ALLOWED', evidence: 'served with 200' })],
    });
    expect(report.errorStates.cells).toBe(0);
    expect(report.errorStates.unmeasured).toBe(0);
    expect(dimensionPercentAt(report.errorStates, 'NAVIGATED')).toBeNull();
  });

  it('refuses to read a DECLARED access cell as an observation', () => {
    const resolution = errorStateOfAccess(accessFact('/admin', { basis: 'DECLARED', probedAtIso: null }));
    expect(resolution).toMatchObject({ kind: 'NOTHING', enumerated: false });
    expect(resolution.why).toContain('nobody asked');
  });

  it('counts a soft 404 through the probe’s intent, because the status says 200', () => {
    const resolution = errorStateOfProbe(
      probeFact('/orders/:id', { verdict: 'SOFT_ERROR', status: 200 }),
    );
    expect(resolution).toMatchObject({ kind: 'CELL', cell: 'ERROR_NOT_FOUND' });
    expect(resolution.kind === 'CELL' && resolution.why).toContain('soft error');
  });

  it('counts a 405 as unnameable rather than filing it under validation', () => {
    const resolution = errorStateOfProbe(
      probeFact('/orders', { probeKind: 'UNSUPPORTED_METHOD', status: 405 }),
    );
    expect(resolution).toMatchObject({ kind: 'UNNAMEABLE', dimension: 'ERROR_STATE' });
  });

  it('treats a probe that could not be issued as no enumeration at all', () => {
    const report = measure({
      items: [route('/orders/:id')],
      probes: [probeFact('/orders/:id', { verdict: 'UNMEASURED', status: null })],
    });
    expect(report.errorStates.unmeasuredReason).toBe('NOT_ENUMERATED');
  });

  it('treats accepted bad input as an enumerated zero, not a gap', () => {
    const report = measure({
      items: [route('/orders/:id')],
      probes: [probeFact('/orders/:id', { verdict: 'ACCEPTED_BAD_INPUT', status: 200 })],
    });
    expect(report.errorStates.cells).toBe(0);
    expect(report.errorStates.unmeasured).toBe(0);
    expect(report.notEnumerated.filter((entry) => entry.dimension === 'ERROR_STATE')).toHaveLength(0);
  });

  it('puts a declared handler in the denominator with no observation behind it', () => {
    const report = measure({
      items: [route('/orders')],
      declared: [
        {
          itemKey: '/orders',
          cell: 'ERROR_SERVER',
          origin: 'SOURCE',
          evidence: 'an error boundary wraps this route in app/orders/error.tsx',
        },
      ],
    });
    expect(report.rows[0]).toMatchObject({
      kind: 'ERROR_SERVER',
      origin: 'SOURCE',
      // NULL MEANS DECLARED AND NEVER OBSERVED.
      observedAtIso: null,
      tier: null,
    });
    expect(report.errorStates.measured).toBe(1);
  });

  it('lets a crawl sighting outrank a declaration on the same cell', () => {
    const report = measure({
      items: [route('/orders')],
      declared: [
        { itemKey: '/orders', cell: 'ERROR_NOT_FOUND', origin: 'OPENAPI', evidence: 'declared 404' },
      ],
      probes: [probeFact('/orders', { observedAtIso: SEEN })],
    });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.origin).toBe('CRAWL');
    expect(report.rows[0]?.observedAtIso).toBe(SEEN);
    expect(report.rows[0]?.evidence).toContain('declared 404');
  });

  it('keeps the most recent sighting’s timestamp', () => {
    const report = measure({
      items: [route('/orders')],
      probes: [
        probeFact('/orders', { observedAtIso: EARLIER }),
        probeFact('/orders', { observedAtIso: SEEN }),
      ],
    });
    expect(report.rows[0]?.observedAtIso).toBe(SEEN);
  });

  it('splits declared, observed, asserted and merely mentioned', () => {
    const items = [route('/orders'), route('/admin'), route('/billing')];
    const mentioned = stateCellKey({ itemKey: '/orders', kind: 'ERROR_NOT_FOUND' });
    const asserted = stateCellKey({ itemKey: '/admin', kind: 'ERROR_FORBIDDEN' });
    const report = measure({
      items,
      probes: [probeFact('/orders')],
      access: [accessFact('/admin')],
      declared: [
        { itemKey: '/billing', cell: 'ERROR_SERVER', origin: 'SOURCE', evidence: 'a 500 handler' },
      ],
      claims: [
        // A phrase in a test file. A mention, and nothing more.
        claim(mentioned, { basis: 'ENGLISH_PHRASE', evidence: 'the title says "shows not found"' }),
        claim(asserted, { basis: 'RUN_OBSERVED' }),
      ],
    });
    expect(errorStateBreakdown(report)).toEqual({
      declared: 3,
      observed: 1,
      asserted: 1,
      mentionedOnly: 1,
      unclaimed: 1,
    });
  });
});

describe('the English-phrase signal', () => {
  it('can never by itself promote a state past DECLARED', () => {
    // Everything an observation could possibly carry, on a phrase-derived
    // claim: navigation, an assertion, a green run, a fresh timestamp.
    const verdict = promoteStateClaim(
      claim('/orders#ERROR_NOT_FOUND', { basis: 'ENGLISH_PHRASE' }),
      NOW,
    );
    expect(verdict.tier).toBe('DECLARED');
    expect(verdict.reached).toBe('FRESH');
    expect(verdict.cappedBy).toBe('STATIC_EVIDENCE_ONLY');
  });

  it('is outranked by a real run on the same cell', () => {
    const key = stateCellKey({ itemKey: '/orders', kind: 'ERROR_NOT_FOUND' });
    const report = measure({
      items: [route('/orders')],
      probes: [probeFact('/orders')],
      claims: [
        claim(key, { basis: 'ENGLISH_PHRASE', testId: 'phrase' }),
        claim(key, { basis: 'RUN_OBSERVED', testId: 'real', runId: 'run-9' }),
      ],
    });
    expect(report.rows[0]?.tier).toBe('FRESH');
    expect(report.rows[0]?.lastConfirmedRunId).toBe('run-9');
  });

  it('holds a declaration at DECLARED too, so `covers:` cannot manufacture a pass', () => {
    const verdict = promoteStateClaim(
      claim('/orders#ERROR_NOT_FOUND', { basis: 'TEST_DECLARED' }),
      NOW,
    );
    expect(verdict.tier).toBe('DECLARED');
    expect(verdict.cappedBy).toBe('DECLARATION_ONLY');
  });
});

describe('promoteStateClaim', () => {
  it('holds a tier at DECLARED when no run is named', () => {
    const verdict = promoteStateClaim(
      claim('/orders#PAGE_EMPTY', { runId: null }),
      NOW,
    );
    expect(verdict.tier).toBe('DECLARED');
    expect(verdict.cappedBy).toBe('NO_RUN_OBSERVED');
    expect(verdict.why).toContain('audit');
  });

  it('counts a FAILING run as coverage, because covered and failing are two facts', () => {
    const verdict = promoteStateClaim(
      claim('/orders#PAGE_EMPTY', { runStatus: 'FAILED' }),
      NOW,
    );
    expect(verdict.tier).toBe('ASSERTED');
    expect(verdict.blockedBy).toBe('RUN_NOT_PASSED');
  });

  it('does not promote a state a run reached and asserted nothing about', () => {
    const verdict = promoteStateClaim(
      claim('/orders#PAGE_EMPTY', { assertionObserved: false }),
      NOW,
    );
    expect(verdict.tier).toBe('NAVIGATED');
    expect(verdict.blockedBy).toBe('NO_ASSERTION_OBSERVED');
  });

  it('refuses coverage to a quarantined test’s state', () => {
    const verdict = promoteStateClaim(
      claim('/orders#PAGE_EMPTY', { quarantined: true }),
      NOW,
    );
    expect(verdict.tier).toBe('DECLARED');
    expect(verdict.cappedBy).toBe('TEST_QUARANTINED');
  });

  it('demotes a stale pass out of FRESH and names the window', () => {
    const verdict = promoteStateClaim(
      claim('/orders#PAGE_EMPTY', { confirmedAtIso: '2026-01-01T00:00:00.000Z' }),
      NOW,
    );
    expect(verdict.tier).toBe('PASSING');
    expect(verdict.blockedBy).toBe('CONFIRMATION_STALE');
    expect(verdict.freshnessDays).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ITEM 3 — data variants
// ─────────────────────────────────────────────────────────────────────────────

describe('item 3 — data variants are the declared profile set', () => {
  it('gives each declared profile its own cell', () => {
    const report = measure({
      items: [route('/orders')],
      profiles: [
        profileFact('/orders', { profile: 'EMPTY', profileKey: 'empty' }),
        profileFact('/orders', { profile: 'HEAVY', profileKey: 'heavy' }),
      ],
    });
    expect(report.dataVariants.measured).toBe(2);
    expect(report.rows.map((row) => row.kind).sort()).toEqual(['DATA_NONE', 'DATA_PAGE_BOUNDARY']);
    expect(report.rows.map((row) => row.stateKey).sort()).toEqual([
      '/orders#DATA_NONE:empty',
      '/orders#DATA_PAGE_BOUNDARY:heavy',
    ]);
  });

  it('reports a route with no profile as NOT_ENUMERATED, not as one slot', () => {
    const report = measure({ items: [route('/orders')], nodes: [node('/orders')] });
    expect(report.dataVariants.measured).toBe(0);
    expect(report.dataVariants.unmeasuredReason).toBe('NOT_ENUMERATED');
    expect(dimensionPercentAt(report.dataVariants, 'PASSING')).toBeNull();
  });

  it('counts an entitlement profile as unnameable rather than as a data shape', () => {
    expect(dataVariantOfProfile(profileFact('/orders', { profile: 'TRIAL_EXPIRED' }))).toMatchObject({
      kind: 'UNNAMEABLE',
      dimension: 'DATA_VARIANT',
    });
    const report = measure({
      items: [route('/orders')],
      profiles: [profileFact('/orders', { profile: 'PLAN_TIER' })],
    });
    expect(report.dataVariants.unmeasuredReason).toBe(UNNAMEABLE_CELL_REASON);
    expect(report.dataVariants.unmeasuredDetail).toContain('vocabulary');
  });

  it('names the data cells no declared profile can produce', () => {
    const report = measure({ items: [route('/orders')] });
    expect(report.unproducedDataCells.sort()).toEqual(['DATA_MALFORMED', 'DATA_ONE']);
  });

  it('enumerates a planned variant that never ran, and observes nothing', () => {
    const report = measure({
      items: [route('/orders')],
      profiles: [profileFact('/orders', { outcome: 'NOT_RUN', observedAtIso: SEEN })],
    });
    expect(report.dataVariants.measured).toBe(1);
    // The outcome was not OBSERVED, so no timestamp is written however much the
    // caller passed: 400 planned variants of which 12 ran must not read as 400
    // observations.
    expect(report.rows[0]?.observedAtIso).toBeNull();
    expect(report.rows[0]?.tier).toBeNull();
  });
});

describe('injected fault states', () => {
  it('is the only producer of a slow state, and puts it on the page-state axis', () => {
    const report = measure({
      items: [route('/dashboard')],
      faults: [
        {
          itemKey: '/dashboard',
          fault: 'SLOW',
          outcome: 'OBSERVED',
          observedAtIso: SEEN,
          evidence: 'the orders call was delayed by 5s and the page showed a spinner',
        },
      ],
    });
    expect(report.rows.map((row) => row.kind)).toEqual(['PAGE_SLOW']);
    expect(report.pageStates.measured).toBe(1);
    expect(report.rows[0]?.stateKey).toBe('/dashboard#PAGE_SLOW');
  });

  it('holds a refused injection out of the denominator with the rule named', () => {
    const report = measure({
      items: [route('/orders')],
      faults: [
        {
          itemKey: '/orders',
          fault: 'ERROR',
          outcome: 'REFUSED',
          observedAtIso: null,
          evidence: 'POST /api/orders is not idempotent',
          exercise: {
            state: 'REFUSED',
            reason: null,
            rule: 'faults-non-idempotent',
            detail: 'failing a POST means first issuing it',
          },
        },
      ],
    });
    expect(report.errorStates.measured).toBe(0);
    expect(report.errorStates.unmeasuredReason).toBe('HELD_OUT');
    expect(report.errorStates.unmeasuredDetail).toContain('faults-non-idempotent');
  });

  it('counts a rate-limited state as unnameable, on the error axis', () => {
    expect(stateOfFault({
      itemKey: '/orders',
      fault: 'RATE_LIMITED',
      outcome: 'OBSERVED',
      observedAtIso: SEEN,
      evidence: 'a 429 was injected',
    })).toMatchObject({ kind: 'UNNAMEABLE', dimension: 'ERROR_STATE' });
  });

  it('enumerates a planned fault that never ran, and observes nothing', () => {
    const report = measure({
      items: [route('/orders')],
      faults: [
        {
          itemKey: '/orders',
          fault: 'EMPTY',
          outcome: 'NOT_RUN',
          observedAtIso: SEEN,
          evidence: 'planned and never attempted',
        },
      ],
    });
    expect(report.pageStates.measured).toBe(1);
    expect(report.rows[0]?.observedAtIso).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The honesty rules that cut across all three
// ─────────────────────────────────────────────────────────────────────────────

describe('a held-out state', () => {
  it('leaves the denominator, keeps its reason, and is never scored', () => {
    const report = measure({
      items: [route('/orders/:id')],
      nodes: [node('/orders/:id')],
      probes: [probeFact('/orders/:id', { exercise: REFUSED })],
      profiles: [profileFact('/orders/:id', { exercise: UNEXERCISABLE })],
    });
    expect(report.errorStates.measured).toBe(0);
    expect(report.errorStates.unmeasured).toBe(1);
    expect(report.errorStates.unmeasuredReason).toBe('HELD_OUT');
    expect(report.dataVariants.unmeasuredReason).toBe('HELD_OUT');
    // Still in the inventory, with the reason on the row.
    const refused = report.rows.find((row) => row.kind === 'ERROR_NOT_FOUND');
    expect(refused).toMatchObject({ unmeasuredReason: 'HELD_OUT' });
    expect(refused?.unmeasuredDetail).toContain('destructive-paths');
    expect(refused?.tier).toBeNull();
    // The other half of the same rule: UNEXERCISABLE names the remedy, which is
    // a sentence a customer can act on where "not scored" is not.
    const unexercisable = report.rows.find((row) => row.dimension === 'DATA_VARIANT');
    expect(unexercisable?.unmeasuredDetail).toContain('NEEDS_DISPOSABLE_DATA');
  });

  it('lets an observed sighting overrule a refusal on the same cell', () => {
    const report = measure({
      items: [route('/orders/:id')],
      probes: [
        probeFact('/orders/:id', { exercise: REFUSED }),
        probeFact('/orders/:id', { exercise: null, evidence: 'and then a run drove it' }),
      ],
    });
    // We have proof it can be driven, so holding it out would withhold a
    // reachable state from the denominator.
    expect(report.errorStates.measured).toBe(1);
    expect(report.rows[0]?.exercise).toBeNull();
  });
});

describe('a cap that bit', () => {
  it('is reported as a count and a reason when it can say how much it hid', () => {
    const report = measure({
      items: [route('/orders')],
      nodes: [node('/orders')],
      caps: [
        {
          cap: 'pageBudget',
          limit: 200,
          atLeastMore: 40,
          dimensions: ['PAGE_STATE'],
          detail: 'the crawl stopped at 200 pages',
        },
      ],
    });
    expect(report.pageStates.unmeasured).toBe(40);
    expect(report.pageStates.unmeasuredReason).toBe('CAP_BIT');
    expect(report.pageStates.caps).toHaveLength(1);
    expect(report.pageStates.unmeasuredDetail).toContain('at least 40 more');
  });

  it('is still disclosed when it cannot say, and adds no invented cells', () => {
    const report = measure({
      items: [route('/orders')],
      nodes: [node('/orders')],
      caps: [
        {
          cap: 'wallClockMillis',
          limit: 600_000,
          atLeastMore: null,
          dimensions: ['PAGE_STATE'],
          detail: 'the crawl ran out of time',
        },
      ],
    });
    // 0 would be the claim that nothing was hidden.
    expect(report.pageStates.unmeasured).toBe(0);
    expect(report.pageStates.caps[0]?.atLeastMore).toBeNull();
    expect(report.pageStates.measured).toBe(1);
  });

  it('is reported only on the dimensions it truncated', () => {
    const report = measure({
      items: [route('/orders')],
      nodes: [node('/orders')],
      profiles: [profileFact('/orders')],
      caps: [
        {
          cap: 'variantBudget',
          limit: 50,
          atLeastMore: 9,
          dimensions: ['DATA_VARIANT'],
          detail: 'the variant plan was truncated',
        },
      ],
    });
    expect(report.dataVariants.caps).toHaveLength(1);
    expect(report.pageStates.caps).toHaveLength(0);
    expect(report.pageStates.unmeasured).toBe(0);
  });
});

describe('combineUnmeasured', () => {
  it('returns null when nothing is unmeasured', () => {
    expect(combineUnmeasured([{ reason: 'HELD_OUT', cells: 0, detail: 'none' }])).toBeNull();
  });

  it('puts the dominant reason in the field and EVERY reason in the sentence', () => {
    const combined = combineUnmeasured([
      { reason: 'NOT_ENUMERATED', cells: 2, detail: 'two routes nobody crawled' },
      { reason: 'HELD_OUT', cells: 5, detail: 'five refusals' },
      { reason: 'CAP_BIT', cells: 1, detail: 'one budget' },
    ]);
    expect(combined).toMatchObject({ reason: 'HELD_OUT', cells: 8 });
    expect(combined?.detail).toContain('5 HELD_OUT');
    expect(combined?.detail).toContain('2 NOT_ENUMERATED');
    expect(combined?.detail).toContain('1 CAP_BIT');
  });

  it('breaks a tie deterministically, by the vocabulary’s own order', () => {
    const combined = combineUnmeasured([
      { reason: 'HELD_OUT', cells: 3, detail: 'three refusals' },
      { reason: 'NOT_ENUMERATED', cells: 3, detail: 'three un-crawled' },
    ]);
    // NOT_ENUMERATED precedes HELD_OUT in DIMENSION_UNMEASURED_REASONS.
    expect(combined?.reason).toBe('NOT_ENUMERATED');
  });

  it('reports all four reasons at once without losing one', () => {
    const report = measure({
      items: [route('/orders'), route('/settings')],
      nodes: [node('/orders')],
      probes: [
        probeFact('/orders', { probeKind: 'UNSUPPORTED_METHOD', status: 405 }),
        probeFact('/orders', { exercise: REFUSED, evidence: 'refused' }),
      ],
      caps: [
        {
          cap: 'probeBudget',
          limit: 10,
          atLeastMore: 3,
          dimensions: ['ERROR_STATE'],
          detail: 'the probe plan was truncated',
        },
      ],
    });
    const reasons = report.unmeasuredBreakdown.ERROR_STATE.map((part) => part.reason).sort();
    expect(reasons).toEqual(['CAP_BIT', 'EXTRACTOR_RETURNED_UNKNOWN', 'HELD_OUT', 'NOT_ENUMERATED']);
    expect(report.errorStates.unmeasured).toBe(
      report.unmeasuredBreakdown.ERROR_STATE.reduce((running, part) => running + part.cells, 0),
    );
  });
});

describe('three dimensions, three denominators', () => {
  it('reports three separate readings and no combined one', () => {
    const report = measure({
      items: [route('/orders')],
      nodes: [node('/orders'), node('/orders', { structural: structural('EMPTY') })],
      probes: [probeFact('/orders')],
      profiles: [profileFact('/orders'), profileFact('/orders', { profile: 'HEAVY', profileKey: 'heavy' })],
    });
    expect(report.pageStates.measured).toBe(2);
    expect(report.errorStates.measured).toBe(1);
    expect(report.dataVariants.measured).toBe(2);
    // No key on the report holds a summed figure, and the rule says why.
    expect(Object.keys(report)).not.toContain('percent');
    expect(Object.keys(report)).not.toContain('total');
    expect(report.rule).toBe(NEVER_SUMMED_RULE);
    expect(report.rule).toContain('never summed');
  });

  it('keeps each dimension’s ladder dividing by its own measured count', () => {
    const report = measure({
      items: [route('/orders')],
      nodes: [node('/orders'), node('/orders', { structural: structural('EMPTY') })],
      probes: [probeFact('/orders')],
      claims: [claim(stateCellKey({ itemKey: '/orders', kind: 'PAGE_DEFAULT' }))],
    });
    expect(report.pageStates.tiers.denominator).toBe(2);
    expect(report.errorStates.tiers.denominator).toBe(1);
    expect(dimensionPercentAt(report.pageStates, 'FRESH')).toBe(50);
    expect(dimensionPercentAt(report.errorStates, 'FRESH')).toBe(0);
  });
});

describe('the write path and the read path agree', () => {
  function fullReport(): StateDimensionReport {
    return measure({
      items: [route('/orders'), route('/admin'), { key: 'GET /api/orders', label: 'orders api', kind: 'ENDPOINT' }],
      nodes: [
        node('/orders'),
        node('/orders', { structural: structural('EMPTY') }),
        node('/admin', { interstitial: interstitial('CONSENT_WALL') }),
      ],
      access: [accessFact('/admin')],
      probes: [probeFact('GET /api/orders'), probeFact('/orders', { exercise: REFUSED })],
      declared: [
        { itemKey: '/orders', cell: 'ERROR_SERVER', origin: 'SOURCE', evidence: 'a 500 handler' },
      ],
      profiles: [profileFact('/orders'), profileFact('/admin', { profile: 'TRIAL_EXPIRED' })],
      claims: [
        claim(stateCellKey({ itemKey: '/orders', kind: 'PAGE_DEFAULT' })),
        claim(stateCellKey({ itemKey: '/admin', kind: 'ERROR_FORBIDDEN' }), {
          basis: 'ENGLISH_PHRASE',
        }),
      ],
    });
  }

  it('produces rows coverageItemStateSchema accepts', () => {
    const report = fullReport();
    expect(report.rows.length).toBeGreaterThan(4);
    for (const row of report.rows) {
      const parsed = coverageItemStateSchema.safeParse(row);
      expect(parsed.success, `${row.stateKey}: ${parsed.error?.message ?? ''}`).toBe(true);
    }
  });

  it('produces measurements dimensionMeasurementSchema accepts', () => {
    const report = fullReport();
    for (const measurement of [report.pageStates, report.errorStates, report.dataVariants]) {
      const parsed = dimensionMeasurementSchema.safeParse(measurement);
      expect(parsed.success, `${measurement.dimension}: ${parsed.error?.message ?? ''}`).toBe(true);
      expect(measurement.cells).toBe(measurement.measured + measurement.unmeasured);
      expect(measurement.tiers.denominator).toBe(measurement.measured);
    }
  });

  it('keys every row with the one cell format, parseable back to its item', () => {
    for (const row of fullReport().rows) {
      const parsed = parseStateCellKey(row.stateKey);
      expect(parsed?.itemKey).toBe(row.itemKey);
      expect(parsed?.kind).toBe(row.kind);
      expect(CELL_KIND_DIMENSION[row.kind]).toBe(row.dimension);
    }
  });

  it('is deterministic: the same facts give a byte-identical report', () => {
    expect(JSON.stringify(fullReport())).toBe(JSON.stringify(fullReport()));
  });

  it('drops a fact about an item the inventory does not hold', () => {
    const report = measure({
      items: [route('/orders')],
      nodes: [node('/orders'), node('/ghost')],
      probes: [probeFact('/ghost')],
    });
    expect(report.rows.every((row) => row.itemKey === '/orders')).toBe(true);
    // And no phantom cell inflates any denominator.
    expect(report.pageStates.cells).toBe(1);
    expect(report.errorStates.cells).toBe(1);
  });

  it('refuses to key a cell that belongs to another dimension', () => {
    expect(() =>
      measure({
        items: [route('/orders')],
        declared: [
          {
            itemKey: '/orders',
            // A component cell. It would be counted on COMPONENT_STATE's
            // denominator and stored where no component reader looks.
            cell: 'COMPONENT_LOADING',
            origin: 'SOURCE',
            evidence: 'a loading skeleton',
          },
        ],
      }),
    ).toThrow(/does not measure/);
  });

  it('bounds the evidence on a heavily-sighted cell and states the count', () => {
    const report = measure({
      items: [route('/admin')],
      access: Array.from({ length: 7 }, (_, index) =>
        accessFact('/admin', { role: `ROLE_${index}`, evidence: `role ${index} got a 403` }),
      ),
    });
    expect(report.rows[0]?.sightings).toBe(7);
    expect(report.rows[0]?.evidence).toContain('+4 more sighting');
    expect(report.rows[0]?.evidence.length).toBeLessThanOrEqual(1_000);
  });
});

describe('pageStatesOfNode', () => {
  it('reports every state one node is in, not just the first', () => {
    const resolutions = pageStatesOfNode(
      node('/checkout', {
        interstitial: interstitial('CONSENT_WALL'),
        structural: structural('EMPTY'),
        status: { code: 404, class: 'CLIENT_ERROR', isErrorPage: false },
        bounce: { kind: 'SAME_ORIGIN_REDIRECT', finalRoute: '/cart', status: 302 },
      }),
    );
    const cells = resolutions.flatMap((resolution) =>
      resolution.kind === 'CELL' ? [resolution.cell] : [],
    );
    expect(cells.sort()).toEqual([
      'ERROR_NOT_FOUND',
      'PAGE_EMPTY',
      'PAGE_INTERSTITIAL',
      'PAGE_REDIRECTED',
    ]);
  });

  it('says nothing was recorded for a node with no status, verdict or bounce', () => {
    const resolutions = pageStatesOfNode(
      node('/orders', { status: undefined, structural: null, bounce: null }),
    );
    expect(resolutions).toEqual([
      expect.objectContaining({ kind: 'NOTHING', enumerated: false }),
    ]);
  });
});
