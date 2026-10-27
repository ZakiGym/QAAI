import { describe, expect, it } from 'vitest';
import { COMPONENT_STATE_KINDS } from './api-surface';
import { TEST_TYPES } from './constants';
import { COVERAGE_TIERS } from './coverage-tiers';
import {
  CELL_KIND_DIMENSION,
  COVERAGE_CELL_KINDS,
  COVERAGE_DIMENSION_DESCRIPTORS,
  COVERAGE_DIMENSION_KINDS,
  COVERAGE_DIMENSIONS,
  DEFAULT_TYPE_OBLIGATIONS,
  DEPLOYMENT_CAPABILITY_STATUS_KINDS,
  DEPLOYMENT_CAPABILITY_STATUSES,
  DIMENSION_UNMEASURED_REASON_KINDS,
  DIMENSION_UNMEASURED_REASONS,
  FAULT_DETECTION_OUTCOME_KINDS,
  FAULT_DETECTION_OUTCOMES,
  HAPPY_PATH_CELL_KINDS,
  HEADLINE_SCOPE_KEY,
  MINIMUM_BACKTEST_DEFECTS,
  NON_EXECUTABLE_CAPABILITY_STATUSES,
  OUR_LIMIT_UNMEASURED_REASONS,
  RATED_FAULT_OUTCOMES,
  SELF_DEPLOYMENT,
  SNAPSHOT_COMPARABILITIES,
  SNAPSHOT_COMPARABILITY_KINDS,
  UNATTRIBUTED_ENVIRONMENT,
  UNATTRIBUTED_FEATURE,
  UNOWNED_TEAM,
  VALIDITY_VERDICT_KINDS,
  VALIDITY_VERDICTS,
  backtestVerdict,
  capabilityCounts,
  cellKindsFor,
  dimensionAxesReferenced,
  EXTRACTED_COVERAGE_DIMENSIONS,
  dimensionHasExtractor,
  dimensionPercentAt,
  dimensionWasMeasured,
  isNonHappyPathCell,
  measuredDimension,
  obligationsFor,
  parseRollupScopeKey,
  rollupScopeKey,
  runnerPoolDeploymentKey,
  snapshotDelta,
  strongestDimensionTier,
  unextractedDimensions,
  unmeasuredDimension,
  type CoverageCellKind,
  type TypeObligationPolicy,
} from './coverage-dimensions';
import {
  attestationUnmeasuredSchema,
  benchmarkFaultResultSchema,
  benchmarkRunSchema,
  coverageAttestationSchema,
  coverageCellKindSchema,
  coverageDimensionSchema,
  coverageFormFieldSchema,
  coverageHistorySchema,
  coverageItemStateSchema,
  coverageRollupSchema,
  coverageTypeObligationSchema,
  deploymentCapabilitySchema,
  dimensionMeasurementSchema,
  dimensionUnmeasuredReasonSchema,
  deploymentCapabilityStatusSchema,
  faultDetectionOutcomeSchema,
  snapshotComparabilitySchema,
  typeObligationPolicySchema,
  validityBacktestSchema,
  validityVerdictSchema,
} from './schemas';
import { SURFACE_DIMENSION_KINDS, SURFACE_KINDS } from './surface';

/**
 * The vocabularies, pinned at the words they were introduced with.
 *
 * Every one of these is STORED — `CoverageItemState.kind`,
 * `CoverageRollup.dimension`, `DeploymentCapability.status`,
 * `CoverageHistory.comparability` — so a member respelled in transit does not
 * fail to compile. It fails to match a row somebody already wrote, which is
 * silent and permanent. Hence literal lists rather than length assertions: the
 * assertion has to be the spelling.
 */
describe('the dimension vocabularies', () => {
  it('keeps the thirteen dimensions, in declaration order', () => {
    expect([...COVERAGE_DIMENSIONS]).toEqual([
      'PAGE_STATE',
      'ERROR_STATE',
      'DATA_VARIANT',
      'FORM_FIELD',
      'VALIDATION_RULE',
      'COMPONENT',
      'COMPONENT_STATE',
      'TEST_TYPE',
      'DEVICE_LOCALE',
      'FLAG_COMBINATION',
      'ROLE_CELL',
      'BACKGROUND_JOB',
      'NOTIFICATION',
    ]);
  });

  it('keeps the five unmeasured reasons', () => {
    expect([...DIMENSION_UNMEASURED_REASONS]).toEqual([
      'NO_EXTRACTOR',
      'NOT_ENUMERATED',
      'EXTRACTOR_RETURNED_UNKNOWN',
      'HELD_OUT',
      'CAP_BIT',
    ]);
  });

  it('names exactly four of the five as OUR limit, leaving HELD_OUT out', () => {
    // HELD_OUT is deliberately not ours: a waiver is the team's decision, and
    // an obligation this deployment cannot run is ours. The caller says which
    // on the row rather than this list guessing, and a report that merged them
    // would blame the customer for our harness.
    expect([...OUR_LIMIT_UNMEASURED_REASONS]).toEqual([
      'NO_EXTRACTOR',
      'NOT_ENUMERATED',
      'EXTRACTOR_RETURNED_UNKNOWN',
      'CAP_BIT',
    ]);
    expect(OUR_LIMIT_UNMEASURED_REASONS).not.toContain('HELD_OUT');
  });

  it('keeps the four capability statuses and holds out exactly two', () => {
    expect([...DEPLOYMENT_CAPABILITY_STATUSES]).toEqual([
      'AVAILABLE',
      'MISSING',
      'WRONG_VERSION',
      'NOT_CHECKED',
    ]);
    expect([...NON_EXECUTABLE_CAPABILITY_STATUSES]).toEqual(['MISSING', 'WRONG_VERSION']);
  });

  it('keeps NOT_CHECKED in the denominator', () => {
    /*
     * The one that matters. Dropping an unprobed type would mean a deployment
     * that never ran a preflight silently shed every obligation it could not
     * prove it could run, and the percentage would RISE for a preflight nobody
     * executed. Same argument as `exercisabilityCounts` counting `undefined`.
     */
    expect(capabilityCounts('NOT_CHECKED')).toBe(true);
    expect(capabilityCounts('AVAILABLE')).toBe(true);
    expect(capabilityCounts('MISSING')).toBe(false);
    expect(capabilityCounts('WRONG_VERSION')).toBe(false);
  });

  it('keeps the four fault outcomes and rates only two of them', () => {
    expect([...FAULT_DETECTION_OUTCOMES]).toEqual([
      'DETECTED',
      'MISSED',
      'NOT_EXERCISED',
      'BASELINE_DIRTY',
    ]);
    /*
     * NOT_EXERCISED is excluded from BOTH halves of the fraction, and that is
     * the arithmetic the whole benchmark turns on: counting it as MISSED blames
     * the assertions for a coverage gap, and counting it as DETECTED is
     * fiction. BASELINE_DIRTY is a refusal, not a reading.
     */
    expect([...RATED_FAULT_OUTCOMES]).toEqual(['DETECTED', 'MISSED']);
    expect(RATED_FAULT_OUTCOMES).not.toContain('NOT_EXERCISED');
    expect(RATED_FAULT_OUTCOMES).not.toContain('BASELINE_DIRTY');
  });

  it('keeps the six snapshot comparabilities and the three validity verdicts', () => {
    expect([...SNAPSHOT_COMPARABILITIES]).toEqual([
      'COMPARABLE',
      'UNCOMPARABLE_NO_BASELINE',
      'UNCOMPARABLE_CRAWL_CHANGED',
      'UNCOMPARABLE_DENOMINATOR_CHANGED',
      'UNCOMPARABLE_FINGERPRINT_MISSING',
      'NOT_COMPARED',
    ]);
    expect([...VALIDITY_VERDICTS]).toEqual(['SUFFICIENT', 'INSUFFICIENT_DATA', 'NOT_ATTEMPTED']);
  });

  it('keeps the sentinels the rest of the product already spells this way', () => {
    /*
     * `UNATTRIBUTED` and `UNOWNED` are the two buckets
     * apps/api/src/routes/issues.ts already files gaps into (its local consts
     * of the same names, used by POST /issues/coverage). Two spellings of "no
     * feature" is two different 31%, and the rollup and the issue filer have to
     * agree about which surface is which.
     */
    expect(UNATTRIBUTED_FEATURE).toBe('UNATTRIBUTED');
    expect(UNOWNED_TEAM).toBe('UNOWNED');
    // The angle-bracket convention `UNVARIED` and `<anonymous>` already use, so
    // a real environment id or runner pool can never collide with a sentinel.
    expect(UNATTRIBUTED_ENVIRONMENT).toBe('<unattributed>');
    expect(SELF_DEPLOYMENT).toBe('<self>');
    expect(runnerPoolDeploymentKey('eu-west')).toBe('pool:eu-west');
    expect(() => runnerPoolDeploymentKey('')).toThrow();
  });
});

// ─── The presence records ───────────────────────────────────────────────────

/**
 * The compile-time half of each guard, read back at run time.
 *
 * `Record<Union, true>` makes the COMPILER refuse a member with no entry. This
 * reads the record's keys back and compares them to the array, which catches
 * the other direction: a member deleted from the array while the record kept
 * it. Eight `GateRule` kinds shipped unsaveable for two slices because only one
 * of the two mechanisms existed.
 */
describe('the presence records agree with the arrays', () => {
  it.each([
    ['COVERAGE_DIMENSIONS', COVERAGE_DIMENSION_KINDS, COVERAGE_DIMENSIONS],
    ['DIMENSION_UNMEASURED_REASONS', DIMENSION_UNMEASURED_REASON_KINDS, DIMENSION_UNMEASURED_REASONS],
    [
      'DEPLOYMENT_CAPABILITY_STATUSES',
      DEPLOYMENT_CAPABILITY_STATUS_KINDS,
      DEPLOYMENT_CAPABILITY_STATUSES,
    ],
    ['FAULT_DETECTION_OUTCOMES', FAULT_DETECTION_OUTCOME_KINDS, FAULT_DETECTION_OUTCOMES],
    ['SNAPSHOT_COMPARABILITIES', SNAPSHOT_COMPARABILITY_KINDS, SNAPSHOT_COMPARABILITIES],
    ['VALIDITY_VERDICTS', VALIDITY_VERDICT_KINDS, VALIDITY_VERDICTS],
  ])('%s', (_name, fromRecord, fromArray) => {
    expect([...fromRecord].sort()).toEqual([...fromArray].sort());
  });
});

/**
 * The run-time half: zod's options, which the compiler cannot see.
 *
 * This is the guard that would have caught the eight unsaveable gate kinds. A
 * member added to a list and not to its schema is a value no writer can ever
 * store, and `check:wiring` cannot see it because a union member with no write
 * path is live code in a reached file.
 *
 * `snapshotComparabilitySchema` and `validityVerdictSchema` are the two that
 * matter most here, because their columns are TEXT: this assertion is the ONLY
 * guard those two vocabularies have anywhere in the stack.
 */
describe('the zod enums are the vocabularies, not copies of them', () => {
  it.each([
    ['coverageDimensionSchema', coverageDimensionSchema.options, COVERAGE_DIMENSIONS],
    ['coverageCellKindSchema', coverageCellKindSchema.options, COVERAGE_CELL_KINDS],
    [
      'dimensionUnmeasuredReasonSchema',
      dimensionUnmeasuredReasonSchema.options,
      DIMENSION_UNMEASURED_REASONS,
    ],
    [
      'deploymentCapabilityStatusSchema',
      deploymentCapabilityStatusSchema.options,
      DEPLOYMENT_CAPABILITY_STATUSES,
    ],
    ['faultDetectionOutcomeSchema', faultDetectionOutcomeSchema.options, FAULT_DETECTION_OUTCOMES],
    ['snapshotComparabilitySchema', snapshotComparabilitySchema.options, SNAPSHOT_COMPARABILITIES],
    ['validityVerdictSchema', validityVerdictSchema.options, VALIDITY_VERDICTS],
  ])('%s', (_name, options, list) => {
    expect([...options].sort()).toEqual([...list].sort());
  });
});

// ─── The descriptors ────────────────────────────────────────────────────────

describe('COVERAGE_DIMENSION_DESCRIPTORS', () => {
  it('has a descriptor for every dimension, keyed by itself', () => {
    for (const dimension of COVERAGE_DIMENSIONS) {
      expect(COVERAGE_DIMENSION_DESCRIPTORS[dimension].dimension).toBe(dimension);
    }
  });

  it('refines at least one axis SURFACE_KINDS already has', () => {
    /*
     * The reason this is an extension and not a fork, exactly as surface.ts's
     * `DIMENSION_AXIS` test records. A dimension that refined an axis the
     * inventory does not have would be rows nothing could ever join to, and a
     * cell counted on a fourteenth kind would be a SECOND DENOMINATOR — which
     * is two coverage numbers.
     */
    for (const dimension of COVERAGE_DIMENSIONS) {
      const descriptor = COVERAGE_DIMENSION_DESCRIPTORS[dimension];
      expect(descriptor.refines.length, dimension).toBeGreaterThan(0);
      for (const kind of descriptor.refines) expect(SURFACE_KINDS, dimension).toContain(kind);
      if (descriptor.cellAxis !== null) {
        expect(SURFACE_KINDS, dimension).toContain(descriptor.cellAxis);
      }
      for (const keyed of descriptor.keyedOn) {
        expect(SURFACE_DIMENSION_KINDS, dimension).toContain(keyed);
      }
    }
  });

  it('lets exactly TEST_TYPE have no cell axis of its own', () => {
    /*
     * TEST_TYPE refines every measured axis — a route, an endpoint and a form
     * can each owe an ACCESSIBILITY test — so its cells are counted per refined
     * item kind. Giving it a thirteenth `SurfaceKind` would have been a second
     * denominator; letting any OTHER dimension have a null axis would mean
     * cells with nowhere to be counted, which is the invisible state.
     */
    const axisless = COVERAGE_DIMENSIONS.filter(
      (dimension) => COVERAGE_DIMENSION_DESCRIPTORS[dimension].cellAxis === null,
    );
    expect(axisless).toEqual(['TEST_TYPE']);
  });

  it('reports only axes the inventory has', () => {
    const referenced = dimensionAxesReferenced();
    expect(referenced.length).toBeGreaterThan(0);
    for (const kind of referenced) expect(SURFACE_KINDS).toContain(kind);
  });
});

// ─── Cells ──────────────────────────────────────────────────────────────────

describe('CELL_KIND_DIMENSION partitions the cell kinds', () => {
  it('gives every cell kind a dimension that exists', () => {
    for (const kind of COVERAGE_CELL_KINDS) {
      expect(COVERAGE_DIMENSIONS, kind).toContain(CELL_KIND_DIMENSION[kind]);
    }
  });

  it('partitions them exactly — every kind in one dimension and no kind in two', () => {
    /*
     * A kind in two dimensions would be counted twice, in two denominators,
     * and the denominator would grow without the application doing so — the
     * same defect `COMPONENT_KINDS_WITH_OWN_AXIS` exists to prevent one level
     * down. A kind in NO dimension is worse: the row exists, nothing counts it,
     * and the state it represents is invisible rather than uncovered.
     */
    const assigned = COVERAGE_DIMENSIONS.flatMap((dimension) => [...cellKindsFor(dimension)]);
    expect(assigned.slice().sort()).toEqual([...COVERAGE_CELL_KINDS].sort());
    expect(assigned).toEqual([...new Set(assigned)]);
  });

  it('leaves the six keyed-on-a-row dimensions with no cell kinds', () => {
    // A dimension with no cell kinds is not a dimension with no cells: these
    // key their cells on a `SurfaceDimension` ROW or on a `TestType`.
    for (const dimension of [
      'TEST_TYPE',
      'DEVICE_LOCALE',
      'FLAG_COMBINATION',
      'ROLE_CELL',
      'BACKGROUND_JOB',
      'NOTIFICATION',
    ] as const) {
      expect(cellKindsFor(dimension), dimension).toEqual([]);
    }
  });

  it('mirrors COMPONENT_STATE_KINDS member for member', () => {
    /*
     * The ENUMERATE round already writes those six into `ComponentState` rows.
     * A COMPONENT_* kind here that it cannot produce would be a cell with no
     * possible evidence — permanently uncovered for a reason no test could fix.
     */
    const mine = cellKindsFor('COMPONENT_STATE').map((kind) =>
      kind.replace(/^COMPONENT_/, ''),
    );
    expect(mine.slice().sort()).toEqual([...COMPONENT_STATE_KINDS].sort());
  });

  it('treats everything but three kinds as off the happy path', () => {
    // Derived by EXCLUSION so a new kind is non-happy-path by default: the
    // opposite default would quietly leave a new error state out of the one
    // count that makes "not just the happy path" checkable.
    expect([...HAPPY_PATH_CELL_KINDS]).toEqual(['PAGE_DEFAULT', 'DATA_MANY', 'COMPONENT_DEFAULT']);
    expect(isNonHappyPathCell('PAGE_DEFAULT')).toBe(false);
    expect(isNonHappyPathCell('ERROR_FORBIDDEN')).toBe(true);
    expect(isNonHappyPathCell('DATA_PAGE_BOUNDARY')).toBe(true);
  });
});

// ─── The extractor list ─────────────────────────────────────────────────────

describe('EXTRACTED_COVERAGE_DIMENSIONS', () => {
  it('claims exactly the twelve axes a module in packages/agent measures', () => {
    /*
     * This list is the half of the two-mechanism guard that lives in
     * packages/shared. The other half is in packages/agent's own test, which
     * asserts `measuredDimensionKinds()` — derived from `DIMENSION_REGISTRY`,
     * where the producers actually are — equals this one. Neither file can be
     * edited alone without a red test, and that is what stops this list
     * becoming a claim nobody checks.
     *
     * Written out rather than `toHaveLength(12)` so that adding a member is a
     * deliberate edit naming the axis that became measured. Pre-populating it
     * with axes somebody INTENDS to build would be the cardinal lie of this
     * product in its purest form: a thing reported as measured that was not
     * measured.
     */
    expect([...EXTRACTED_COVERAGE_DIMENSIONS]).toEqual([
      'PAGE_STATE',
      'ERROR_STATE',
      'DATA_VARIANT',
      'FORM_FIELD',
      'VALIDATION_RULE',
      'COMPONENT',
      'COMPONENT_STATE',
      'TEST_TYPE',
      'DEVICE_LOCALE',
      'FLAG_COMBINATION',
      'BACKGROUND_JOB',
      'NOTIFICATION',
    ]);
    for (const dimension of EXTRACTED_COVERAGE_DIMENSIONS) {
      expect(dimensionHasExtractor(dimension), dimension).toBe(true);
    }
  });

  it('leaves ROLE_CELL unextracted, because a probe is not an assertion', () => {
    /*
     * The one axis whose CELLS exist and whose COVERAGE does not. The access
     * matrix enumerates route x role, so the denominator is real; nothing
     * matches a TEST to one of those cells, and the outcome the matrix records
     * is the application's behaviour rather than a test's assertion about it.
     * Listing it here would promote a crawl probe to coverage — the figure
     * would rise with no test written, and invisibly, because the probe really
     * did happen.
     */
    expect(unextractedDimensions()).toEqual(['ROLE_CELL']);
    expect(dimensionHasExtractor('ROLE_CELL')).toBe(false);
  });

  it('never claims an extractor for an axis that is not a dimension', () => {
    // Guards the list against a typo that would silently make an axis
    // unmeasured for ever: a member not in COVERAGE_DIMENSIONS can never be
    // returned by `unextractedDimensions`, so it would look registered here
    // and absent everywhere else.
    for (const dimension of EXTRACTED_COVERAGE_DIMENSIONS) {
      expect(COVERAGE_DIMENSIONS, dimension).toContain(dimension);
    }
  });
});

// ─── The measurement, which is the heart of the file ────────────────────────

describe('unmeasuredDimension cannot produce a zero percent', () => {
  const reading = unmeasuredDimension({
    dimension: 'COMPONENT_STATE',
    reason: 'NO_EXTRACTOR',
    detail: 'QAAI does not enumerate component states in this build',
    cells: 410,
  });

  it('reports NULL at every rung, not 0', () => {
    /*
     * THE MOST IMPORTANT TEST IN THIS FILE. "0% of your component states are
     * covered" is a lie about the customer's application assembled out of our
     * own silence; "we do not measure component states" is a fact about our
     * product. The difference is this `toBeNull`, and it holds by ARITHMETIC —
     * `coverageLadder([])` has denominator 0, and `coveragePercent` returns
     * null for an empty denominator — rather than by a renderer remembering to
     * check a flag.
     */
    for (const tier of COVERAGE_TIERS) {
      expect(dimensionPercentAt(reading, tier), tier).toBeNull();
    }
    for (const rung of reading.tiers.tiers) {
      expect(rung.percent, rung.tier).toBeNull();
      expect(rung.atOrAbove, rung.tier).toBe(0);
    }
  });

  it('keeps the cells it knows about in sight, and names why they were not measured', () => {
    expect(reading.cells).toBe(410);
    expect(reading.measured).toBe(0);
    expect(reading.unmeasured).toBe(410);
    expect(reading.unmeasuredReason).toBe('NO_EXTRACTOR');
    expect(dimensionWasMeasured(reading)).toBe(false);
    expect(strongestDimensionTier(reading)).toBeNull();
  });

  it('keeps the reason even when the cell count itself is unknown', () => {
    // NOT_ENUMERATED with cells 0 is the other honest case: we do not even know
    // how many there are. Without the reason it would be indistinguishable from
    // an axis that WAS measured and found to have nothing, and those are
    // opposite facts.
    const unknown = unmeasuredDimension({
      dimension: 'DATA_VARIANT',
      reason: 'NOT_ENUMERATED',
      detail: 'no crawl recorded a data profile for this route',
    });
    expect(unknown.cells).toBe(0);
    expect(unknown.unmeasuredReason).toBe('NOT_ENUMERATED');
  });

  it('refuses a reason code with no sentence', () => {
    expect(() =>
      unmeasuredDimension({ dimension: 'PAGE_STATE', reason: 'NO_EXTRACTOR', detail: '' }),
    ).toThrow(/sentence/);
  });
});

describe('measuredDimension', () => {
  it('divides by what was measured and reports the rest beside it', () => {
    /*
     * Both numbers, neither folded. Dividing by `cells` would report every cell
     * we never looked at as UNCOVERED; dividing by `measured` and printing
     * nothing else would HIDE them, which raises the figure every time our
     * extractor gets worse.
     */
    const reading = measuredDimension({
      dimension: 'PAGE_STATE',
      measuredCells: ['PASSING', 'NAVIGATED', null, null],
      unmeasured: 6,
      unmeasuredReason: 'NOT_ENUMERATED',
      unmeasuredDetail: 'six routes have no recorded states',
    });
    expect(reading.measured).toBe(4);
    expect(reading.unmeasured).toBe(6);
    expect(reading.cells).toBe(10);
    expect(reading.tiers.denominator).toBe(4);
    expect(reading.tiers.unclaimed).toBe(2);
    expect(dimensionPercentAt(reading, 'NAVIGATED')).toBe(50);
    expect(dimensionPercentAt(reading, 'PASSING')).toBe(25);
    expect(dimensionWasMeasured(reading)).toBe(true);
    expect(strongestDimensionTier(reading)).toBe('PASSING');
  });

  it('refuses unmeasured cells with no reason', () => {
    expect(() =>
      measuredDimension({ dimension: 'PAGE_STATE', measuredCells: ['PASSING'], unmeasured: 3 }),
    ).toThrow(/no reason/);
  });

  it('refuses a reason with nothing unmeasured', () => {
    expect(() =>
      measuredDimension({
        dimension: 'PAGE_STATE',
        measuredCells: ['PASSING'],
        unmeasuredReason: 'CAP_BIT',
        unmeasuredDetail: 'a cap bit',
      }),
    ).toThrow(/did not hit/);
  });

  it('returns null for a rung that does not exist', () => {
    const reading = measuredDimension({ dimension: 'PAGE_STATE', measuredCells: ['PASSING'] });
    // Defensive rather than reachable through the types, and deliberately not
    // an exception: a report asking for a rung the ladder does not carry must
    // render "not measured", never 0%.
    expect(dimensionPercentAt(reading, 'NOT_A_RUNG' as never)).toBeNull();
  });
});

// ─── Obligations ────────────────────────────────────────────────────────────

describe('type obligations owe nothing by default', () => {
  it('is empty for every axis', () => {
    /*
     * EVERY ENTRY EMPTY IS THE FEATURE. The day somebody adds a default, this
     * test fails and the change becomes deliberate and reviewed — which is the
     * point, because defaulting a route to owing an E2E and an ACCESSIBILITY
     * test would mint 824 obligations for a 412-route project on the day of the
     * migration, report them all as uncovered, and present our own opinion
     * about what a team should test as the team's debt.
     */
    for (const kind of SURFACE_KINDS) {
      expect(DEFAULT_TYPE_OBLIGATIONS[kind], kind).toEqual([]);
    }
  });

  it('owes nothing for a project that never configured a policy', () => {
    expect(obligationsFor('ROUTE', null)).toEqual([]);
  });

  it('owes what the policy declares, and the default for an axis it is silent about', () => {
    const policy: TypeObligationPolicy = { byKind: { ROUTE: ['E2E', 'ACCESSIBILITY'] } };
    expect(obligationsFor('ROUTE', policy)).toEqual(['E2E', 'ACCESSIBILITY']);
    expect(obligationsFor('ENDPOINT', policy)).toEqual([]);
  });

  it('lets a project declare, on the record, that an axis owes nothing', () => {
    // `[]` in the policy and absent from the policy agree about the ANSWER and
    // differ about the CLAIM: one is a decision somebody made and can be held
    // to, the other is silence. The resolver returns the policy's own array so
    // a caller can tell them apart by identity if it needs to.
    const policy: TypeObligationPolicy = { byKind: { ROUTE: [] } };
    expect(obligationsFor('ROUTE', policy)).toBe(policy.byKind.ROUTE);
  });
});

// ─── Comparability ──────────────────────────────────────────────────────────

describe('snapshotDelta refuses a delta it cannot justify', () => {
  const side = (percent: number | null, crawl: string | null, denom: string | null) => ({
    percent,
    crawlFingerprint: crawl,
    denominatorDefinition: denom,
  });

  it('is UNCOMPARABLE_NO_BASELINE for a first measurement', () => {
    const result = snapshotDelta({ current: side(61, 'c1', 'd1'), previous: null });
    expect(result.comparability).toBe('UNCOMPARABLE_NO_BASELINE');
    expect(result.deltaPercent).toBeNull();
  });

  it('reports a MISSING fingerprint before a CHANGED one', () => {
    /*
     * The order is the finding. "We cannot establish comparability" and "we
     * established that they are not comparable" are different claims, and only
     * the second is evidence that the crawl moved. Every snapshot written
     * before the column existed is in the first state.
     */
    const result = snapshotDelta({
      current: side(61, 'c2', 'd1'),
      previous: side(70, null, 'd1'),
    });
    expect(result.comparability).toBe('UNCOMPARABLE_FINGERPRINT_MISSING');
    expect(result.deltaPercent).toBeNull();
  });

  it('refuses a delta across two crawl fingerprints', () => {
    // THE refusal this function exists for. Subtracting two percentages always
    // succeeds, and "coverage fell 9 points" across two different crawls is an
    // artefact of our own enumeration that reads as a regression.
    const result = snapshotDelta({
      current: side(61, 'c2', 'd1'),
      previous: side(70, 'c1', 'd1'),
    });
    expect(result.comparability).toBe('UNCOMPARABLE_CRAWL_CHANGED');
    expect(result.deltaPercent).toBeNull();
    expect(result.detail).toContain('c1');
    expect(result.detail).toContain('c2');
  });

  it('refuses a delta across two denominator definitions', () => {
    const result = snapshotDelta({
      current: side(61, 'c1', 'd2'),
      previous: side(70, 'c1', 'd1'),
    });
    expect(result.comparability).toBe('UNCOMPARABLE_DENOMINATOR_CHANGED');
    expect(result.deltaPercent).toBeNull();
  });

  it('subtracts when both sides are the same measurement', () => {
    const result = snapshotDelta({
      current: side(61.4, 'c1', 'd1'),
      previous: side(70.1, 'c1', 'd1'),
    });
    expect(result.comparability).toBe('COMPARABLE');
    // One decimal, matching `coveragePercent`, so a delta and the figures it
    // was taken between cannot round differently and fail to add up on screen.
    expect(result.deltaPercent).toBe(-8.7);
  });

  it('is COMPARABLE with a null delta when one side has no percentage', () => {
    /*
     * Looks like a contradiction and is not. The two measurements ARE the same
     * measurement; one has no figure because its denominator was zero.
     * NOT_COMPARED would blame the comparison for an empty denominator, and a
     * delta of 0 would claim nothing changed between a number and an absence.
     */
    const result = snapshotDelta({ current: side(null, 'c1', 'd1'), previous: side(70, 'c1', 'd1') });
    expect(result.comparability).toBe('COMPARABLE');
    expect(result.deltaPercent).toBeNull();
  });
});

// ─── The rollup scope key ───────────────────────────────────────────────────

describe('rollupScopeKey', () => {
  it('spells the headline as one stable word', () => {
    expect(rollupScopeKey({})).toBe(HEADLINE_SCOPE_KEY);
    expect(rollupScopeKey({ dimension: null, feature: null, teamId: null })).toBe('HEADLINE');
  });

  it('puts the parts in a fixed order, not the order they were passed', () => {
    /*
     * Re-sorting a key retires every row it names and mints new ones, so the
     * order is declaration order and not whatever a caller happened to build.
     *
     * WHAT THIS TEST DOES NOT PROVE, measured and reported rather than claimed:
     * `DIM`, `FEATURE` and `TEAM` are themselves in alphabetical order, so a
     * `.sort()` added to `rollupScopeKey` is INVISIBLE to this assertion — the
     * mutant survives. See the note on rule 1 in coverage-dimensions.ts. What
     * this does prove is insensitivity to the CALLER's order, which is the
     * failure a writer can actually cause today.
     */
    expect(rollupScopeKey({ teamId: 't_7', feature: 'payments', dimension: 'FORM_FIELD' })).toBe(
      'DIM=FORM_FIELD|FEATURE=payments|TEAM=t_7',
    );
    expect(rollupScopeKey({ dimension: 'FORM_FIELD', feature: 'payments', teamId: 't_7' })).toBe(
      'DIM=FORM_FIELD|FEATURE=payments|TEAM=t_7',
    );
  });

  it('keeps the case of a feature and a team', () => {
    // A team called `Billing` and one called `billing` are two teams until the
    // customer says otherwise, and case-folding here would merge two buckets.
    expect(rollupScopeKey({ teamId: 'Billing' })).toBe('TEAM=Billing');
    expect(rollupScopeKey({ teamId: 'billing' })).toBe('TEAM=billing');
  });

  it('percent-encodes the three reserved characters so a value cannot forge a part', () => {
    const key = rollupScopeKey({ feature: 'a=b|c%d' });
    expect(key).toBe('FEATURE=a%3Db%7Cc%25d');
    expect(parseRollupScopeKey(key)).toEqual({
      dimension: null,
      feature: 'a=b|c%d',
      teamId: null,
    });
  });

  it('refuses an empty feature or team rather than filing it under the headline', () => {
    // `feature: ''` is a writer's bug, and silently treating it as absent would
    // merge a feature's numbers into the global ones.
    expect(() => rollupScopeKey({ feature: '' })).toThrow();
    expect(() => rollupScopeKey({ teamId: '' })).toThrow();
  });

  it('round-trips every shape', () => {
    for (const scope of [
      {},
      { dimension: 'PAGE_STATE' as const },
      { feature: 'checkout' },
      { teamId: UNOWNED_TEAM },
      { dimension: 'ROLE_CELL' as const, feature: UNATTRIBUTED_FEATURE, teamId: 'T 9' },
    ]) {
      const parsed = parseRollupScopeKey(rollupScopeKey(scope));
      expect(parsed).toEqual({
        dimension: scope.dimension ?? null,
        feature: scope.feature ?? null,
        teamId: scope.teamId ?? null,
      });
    }
  });

  it('rejects a string that is not one of ours', () => {
    expect(parseRollupScopeKey('DIM=NOT_A_DIMENSION')).toBeNull();
    expect(parseRollupScopeKey('WHAT=x')).toBeNull();
    expect(parseRollupScopeKey('DIM=PAGE_STATE|DIM=ERROR_STATE')).toBeNull();
    expect(parseRollupScopeKey('FEATURE=')).toBeNull();
    expect(parseRollupScopeKey('=payments')).toBeNull();
  });
});

// ─── The self-measurement thresholds ────────────────────────────────────────

describe('backtestVerdict states the n rather than a flattering rate', () => {
  it('is INSUFFICIENT_DATA below the threshold and SUFFICIENT at it', () => {
    expect(MINIMUM_BACKTEST_DEFECTS).toBe(30);
    expect(backtestVerdict(0)).toBe('INSUFFICIENT_DATA');
    expect(backtestVerdict(29)).toBe('INSUFFICIENT_DATA');
    expect(backtestVerdict(30)).toBe('SUFFICIENT');
  });
});

// ─── The write paths ────────────────────────────────────────────────────────

const LADDER = (denominator: number, unclaimed = 0) => ({
  denominator,
  unclaimed,
  tiers: COVERAGE_TIERS.map((tier) => ({ tier, atOrAbove: 0, percent: null })),
});

describe('dimensionMeasurementSchema refuses the four dishonest shapes', () => {
  const base = {
    dimension: 'PAGE_STATE' as const,
    cells: 4,
    measured: 4,
    unmeasured: 0,
    unmeasuredReason: null,
    unmeasuredDetail: null,
    tiers: LADDER(4),
  };

  it('accepts a well-formed reading', () => {
    expect(dimensionMeasurementSchema.safeParse(base).success).toBe(true);
  });

  it('refuses unmeasured cells with no reason', () => {
    const parsed = dimensionMeasurementSchema.safeParse({
      ...base,
      cells: 10,
      unmeasured: 6,
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a reason with nothing unmeasured', () => {
    expect(
      dimensionMeasurementSchema.safeParse({
        ...base,
        unmeasuredReason: 'NO_EXTRACTOR',
        unmeasuredDetail: 'x',
      }).success,
    ).toBe(false);
  });

  it('refuses parts that do not reconstruct the whole', () => {
    expect(dimensionMeasurementSchema.safeParse({ ...base, cells: 9 }).success).toBe(false);
  });

  it('refuses a ladder that divides by every cell rather than the measured ones', () => {
    expect(
      dimensionMeasurementSchema.safeParse({
        ...base,
        cells: 10,
        unmeasured: 6,
        unmeasuredReason: 'NOT_ENUMERATED',
        unmeasuredDetail: 'six routes have no recorded states',
        tiers: LADDER(10),
      }).success,
    ).toBe(false);
  });

  it('refuses CAP_BIT with no cap named', () => {
    // Rule 10 verbatim: a cap applied without being disclosed.
    expect(
      dimensionMeasurementSchema.safeParse({
        ...base,
        cells: 10,
        unmeasured: 6,
        unmeasuredReason: 'CAP_BIT',
        unmeasuredDetail: 'the page budget bit',
      }).success,
    ).toBe(false);
    expect(
      dimensionMeasurementSchema.safeParse({
        ...base,
        cells: 10,
        unmeasured: 6,
        unmeasuredReason: 'CAP_BIT',
        unmeasuredDetail: 'the page budget bit',
        caps: [
          { cap: 'pageBudget', limit: 1_000, atLeastMore: 240, detail: 'at least 240 more existed' },
        ],
      }).success,
    ).toBe(true);
  });

  it('accepts a cap that cannot say how much it hid', () => {
    // A wall-clock timeout knows it stopped and not what it stopped before, so
    // `atLeastMore: null` is a weaker and still useful sentence. `0` would be
    // the claim that nothing was hidden.
    expect(
      dimensionMeasurementSchema.safeParse({
        ...base,
        cells: 10,
        unmeasured: 6,
        unmeasuredReason: 'CAP_BIT',
        unmeasuredDetail: 'the wall clock bit',
        caps: [
          { cap: 'wallClockMillis', limit: 600_000, atLeastMore: null, detail: 'stopped early' },
        ],
      }).success,
    ).toBe(true);
  });

  it('refuses a reading whose unmeasured key is simply absent', () => {
    const { unmeasuredReason: _omitted, ...withoutReason } = base;
    expect(dimensionMeasurementSchema.safeParse({ ...withoutReason, cells: 10, unmeasured: 6 }).success).toBe(
      false,
    );
  });
});

describe('coverageItemStateSchema', () => {
  const row = {
    itemKey: 'ROUTE:/orders',
    stateKey: '/orders|',
    kind: 'PAGE_EMPTY' as CoverageCellKind,
    label: 'empty order list',
    origin: 'CRAWL' as const,
    evidence: 'the crawl saw /orders render with no rows',
  };

  it('accepts a state and defaults observedAt to null, not to now', () => {
    const parsed = coverageItemStateSchema.safeParse(row);
    expect(parsed.success).toBe(true);
    // NULL MEANS DECLARED AND NEVER OBSERVED. Defaulting it would turn every
    // declared state into an observed one.
    if (parsed.success) {
      expect(parsed.data.observedAtIso).toBeNull();
      expect(parsed.data.tier).toBeNull();
      expect(parsed.data.unmeasuredReason).toBeNull();
    }
  });

  it('refuses a cell kind that belongs to a form dimension', () => {
    // A row stored in the wrong table is counted on no denominator and is
    // invisible rather than uncovered.
    expect(coverageItemStateSchema.safeParse({ ...row, kind: 'RULE_PATTERN' }).success).toBe(false);
    expect(coverageItemStateSchema.safeParse({ ...row, kind: 'FORM_FIELD' }).success).toBe(false);
  });

  it('accepts every state, error, data and component kind', () => {
    for (const dimension of ['PAGE_STATE', 'ERROR_STATE', 'DATA_VARIANT', 'COMPONENT', 'COMPONENT_STATE'] as const) {
      for (const kind of cellKindsFor(dimension)) {
        expect(coverageItemStateSchema.safeParse({ ...row, kind }).success, kind).toBe(true);
      }
    }
  });

  it('refuses a tier above DECLARED with no run behind it', () => {
    expect(coverageItemStateSchema.safeParse({ ...row, tier: 'PASSING' }).success).toBe(false);
    expect(
      coverageItemStateSchema.safeParse({ ...row, tier: 'PASSING', lastConfirmedRunId: 'r1' })
        .success,
    ).toBe(true);
    expect(coverageItemStateSchema.safeParse({ ...row, tier: 'DECLARED' }).success).toBe(true);
  });

  it('refuses a state reachable only through itself', () => {
    expect(
      coverageItemStateSchema.safeParse({ ...row, parentStateKey: row.stateKey }).success,
    ).toBe(false);
  });
});

describe('coverageFormFieldSchema keeps absent apart from zero', () => {
  const field = {
    itemKey: 'FORM:app/checkout/page.tsx#0',
    fieldKey: 'app/checkout/page.tsx#0|email',
    kind: 'FORM_FIELD' as CoverageCellKind,
    label: 'Email',
    required: null,
    constraintsRead: false,
    origin: 'SOURCE' as const,
    evidence: 'detectForms read an input named email',
  };

  it('accepts a field whose required-ness could not be read', () => {
    // NULL means the reader could not tell; `false` means it looked. Collapsing
    // the first into the second removes the cell from the denominator.
    const parsed = coverageFormFieldSchema.safeParse(field);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.constraint).toBeNull();
  });

  it('refuses a required key that is simply absent', () => {
    const { required: _omitted, ...withoutRequired } = field;
    expect(coverageFormFieldSchema.safeParse(withoutRequired).success).toBe(false);
  });

  it('refuses a maxLength of 0 and accepts a min of 0', () => {
    /*
     * A maxlength of zero is not a constraint — it is an absent attribute a
     * writer turned into a number, and it produces a boundary cell nothing can
     * satisfy. `min="0"` on a quantity field is the most common numeric
     * constraint on the web, and refusing it would delete the cell that catches
     * a negative-quantity bug.
     */
    const constraint = {
      maxLength: null,
      minLength: null,
      min: null,
      max: null,
      step: null,
      pattern: null,
    };
    expect(
      coverageFormFieldSchema.safeParse({
        ...field,
        constraintsRead: true,
        constraint: { ...constraint, maxLength: 0 },
      }).success,
    ).toBe(false);
    expect(
      coverageFormFieldSchema.safeParse({
        ...field,
        constraintsRead: true,
        constraint: { ...constraint, step: 0 },
      }).success,
    ).toBe(false);
    expect(
      coverageFormFieldSchema.safeParse({
        ...field,
        constraintsRead: true,
        constraint: { ...constraint, min: 0, max: 0 },
      }).success,
    ).toBe(true);
  });

  it('refuses a constraint object with an omitted member', () => {
    // An omitted key and a null are the same thing to JSON.stringify and NOT
    // the same thing to a reader using `in` or `??`, so the writer must say it.
    expect(
      coverageFormFieldSchema.safeParse({
        ...field,
        constraintsRead: true,
        constraint: { maxLength: 12 },
      }).success,
    ).toBe(false);
  });

  it('refuses a constraint that was found without anything having read it', () => {
    expect(
      coverageFormFieldSchema.safeParse({
        ...field,
        constraintsRead: false,
        constraint: {
          maxLength: 12,
          minLength: null,
          min: null,
          max: null,
          step: null,
          pattern: null,
        },
      }).success,
    ).toBe(false);
  });

  it('refuses a validation rule with no field behind it', () => {
    expect(coverageFormFieldSchema.safeParse({ ...field, kind: 'RULE_REQUIRED' }).success).toBe(
      false,
    );
    expect(
      coverageFormFieldSchema.safeParse({
        ...field,
        kind: 'RULE_REQUIRED',
        parentFieldKey: field.fieldKey,
      }).success,
    ).toBe(true);
  });

  it('refuses a state cell kind', () => {
    expect(coverageFormFieldSchema.safeParse({ ...field, kind: 'PAGE_EMPTY' }).success).toBe(false);
  });
});

describe('coverageTypeObligationSchema', () => {
  it('accepts a declared obligation and refuses an unbacked tier', () => {
    const row = {
      itemKey: 'ROUTE:/checkout',
      testType: 'ACCESSIBILITY' as const,
      declaredBy: 'MANUAL' as const,
      evidence: 'the project policy declares that every route owes an accessibility test',
    };
    expect(coverageTypeObligationSchema.safeParse(row).success).toBe(true);
    expect(coverageTypeObligationSchema.safeParse({ ...row, tier: 'NAVIGATED' }).success).toBe(
      false,
    );
  });
});

describe('typeObligationPolicySchema', () => {
  it('accepts a policy that names one axis and stays silent about the rest', () => {
    const parsed = typeObligationPolicySchema.safeParse({ byKind: { ROUTE: ['E2E'] } });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // The compile-time pin: the schema's output IS the resolver's input, so
      // the write path and `obligationsFor` cannot drift into two shapes.
      const policy: TypeObligationPolicy = parsed.data;
      expect(obligationsFor('ROUTE', policy)).toEqual(['E2E']);
      expect(obligationsFor('FORM', policy)).toEqual([]);
    }
  });

  it('accepts an empty policy and refuses a duplicate obligation', () => {
    expect(typeObligationPolicySchema.safeParse({}).success).toBe(true);
    expect(
      typeObligationPolicySchema.safeParse({ byKind: { ROUTE: ['E2E', 'E2E'] } }).success,
    ).toBe(false);
  });

  it('refuses an axis the inventory does not have', () => {
    expect(typeObligationPolicySchema.safeParse({ byKind: { PAGE: ['E2E'] } }).success).toBe(false);
  });

  it('cannot owe more types than exist', () => {
    expect(
      typeObligationPolicySchema.safeParse({ byKind: { ROUTE: [...TEST_TYPES] } }).success,
    ).toBe(true);
  });
});

describe('coverageRollupSchema', () => {
  const rollup = {
    scopeKey: 'FEATURE=payments',
    feature: 'payments',
    numerator: 3,
    denominator: 10,
    percent: 30,
    tier: 'NAVIGATED' as const,
  };

  it('accepts a bucket with its own arithmetic', () => {
    expect(coverageRollupSchema.safeParse(rollup).success).toBe(true);
  });

  it('refuses a numerator above its denominator', () => {
    expect(coverageRollupSchema.safeParse({ ...rollup, numerator: 11 }).success).toBe(false);
  });

  it('refuses a percentage on an empty denominator', () => {
    expect(
      coverageRollupSchema.safeParse({ ...rollup, numerator: 0, denominator: 0, percent: 0 })
        .success,
    ).toBe(false);
    expect(
      coverageRollupSchema.safeParse({ ...rollup, numerator: 0, denominator: 0, percent: null })
        .success,
    ).toBe(true);
  });

  it('refuses a scopeKey that disagrees with the columns it encodes', () => {
    /*
     * Two fields encoding one fact will eventually disagree about a row and
     * only one of them will be on screen — the `origin`/`sources` hazard. Here
     * the unique index is built on the key and the filters on the columns, so a
     * disagreement means the index and the filters describe different buckets.
     */
    expect(coverageRollupSchema.safeParse({ ...rollup, feature: 'checkout' }).success).toBe(false);
    expect(
      coverageRollupSchema.safeParse({ ...rollup, scopeKey: 'HEADLINE', feature: null }).success,
    ).toBe(true);
  });

  it('refuses unmeasured cells in a bucket with no reason', () => {
    expect(coverageRollupSchema.safeParse({ ...rollup, unmeasured: 4 }).success).toBe(false);
    expect(
      coverageRollupSchema.safeParse({
        ...rollup,
        unmeasured: 4,
        unmeasuredReason: 'NO_EXTRACTOR',
        unmeasuredDetail: 'four cells on an axis we do not measure',
      }).success,
    ).toBe(true);
  });

  it('files unowned surface in a named bucket rather than nowhere', () => {
    const scope = { teamId: UNOWNED_TEAM };
    expect(
      coverageRollupSchema.safeParse({
        ...rollup,
        scopeKey: rollupScopeKey(scope),
        feature: null,
        teamId: UNOWNED_TEAM,
      }).success,
    ).toBe(true);
  });
});

describe('coverageHistorySchema refuses a delta across two crawls', () => {
  const history = {
    scopeKey: 'HEADLINE',
    numerator: 6,
    denominator: 10,
    percent: 60,
    tier: 'NAVIGATED' as const,
    comparability: 'COMPARABLE' as const,
    previousPercent: 70,
    deltaPercent: -10,
  };

  it('accepts a comparable delta', () => {
    expect(coverageHistorySchema.safeParse(history).success).toBe(true);
  });

  it('refuses a delta when the crawl changed', () => {
    // The validator half of the same rule `snapshotDelta` enforces in code.
    // Two mechanisms, because the API door and the computation are different
    // places a wrong delta could enter.
    expect(
      coverageHistorySchema.safeParse({
        ...history,
        comparability: 'UNCOMPARABLE_CRAWL_CHANGED',
        comparabilityDetail: 'the crawl fingerprint changed',
      }).success,
    ).toBe(false);
  });

  it('refuses an uncomparable reading with no sentence to print instead', () => {
    expect(
      coverageHistorySchema.safeParse({
        ...history,
        deltaPercent: null,
        comparability: 'UNCOMPARABLE_NO_BASELINE',
      }).success,
    ).toBe(false);
    expect(
      coverageHistorySchema.safeParse({
        ...history,
        deltaPercent: null,
        previousPercent: null,
        comparability: 'UNCOMPARABLE_NO_BASELINE',
        comparabilityDetail: 'the first measurement of this subject',
      }).success,
    ).toBe(true);
  });

  it('refuses a delta with nothing to subtract from', () => {
    expect(
      coverageHistorySchema.safeParse({ ...history, previousPercent: null }).success,
    ).toBe(false);
  });
});

describe('deploymentCapabilitySchema', () => {
  const probe = {
    testType: 'LOAD' as const,
    status: 'MISSING' as const,
    detail: 'k6 is not installed in this image',
    checkedAtIso: '2026-10-26T09:00:00.000Z',
  };

  it('accepts a probe and defaults the deployment to this image', () => {
    const parsed = deploymentCapabilitySchema.safeParse(probe);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.deploymentKey).toBe(SELF_DEPLOYMENT);
  });

  it('refuses a verdict with no time behind it', () => {
    // A cached AVAILABLE for a binary that has since vanished is the lie this
    // table exists to kill, so the age of the answer is part of the answer.
    expect(
      deploymentCapabilitySchema.safeParse({ ...probe, checkedAtIso: null }).success,
    ).toBe(false);
  });

  it('refuses NOT_CHECKED that claims to have been checked', () => {
    expect(
      deploymentCapabilitySchema.safeParse({ ...probe, status: 'NOT_CHECKED' }).success,
    ).toBe(false);
    expect(
      deploymentCapabilitySchema.safeParse({
        testType: 'LOAD',
        status: 'NOT_CHECKED',
        detail: 'no preflight has run on this deployment',
      }).success,
    ).toBe(true);
  });

  it('refuses WRONG_VERSION with no range named', () => {
    expect(
      deploymentCapabilitySchema.safeParse({ ...probe, status: 'WRONG_VERSION' }).success,
    ).toBe(false);
    expect(
      deploymentCapabilitySchema.safeParse({
        ...probe,
        status: 'WRONG_VERSION',
        requiredVersion: '>=0.49',
        observedVersion: '0.42.0',
      }).success,
    ).toBe(true);
  });
});

describe('coverageAttestationSchema', () => {
  const envelope = {
    issuedAtIso: '2026-10-26T09:00:00.000Z',
    crawlVersion: 'crawl-7',
    denominatorDefinition: 'routes and endpoints, minus 4 waivers',
    percent: 61.2,
    denominator: 103,
    covered: 63,
    scopeStatement: 'This attestation covers routes and endpoints only.',
    unmeasured: [
      {
        dimension: 'COMPONENT_STATE' as const,
        kind: null,
        reason: 'NO_EXTRACTOR' as const,
        detail: 'QAAI does not enumerate component states in this build',
        cells: null,
      },
    ],
    caps: [],
    fingerprint: 'fp-1',
  };

  it('accepts an envelope that states its scope', () => {
    expect(coverageAttestationSchema.safeParse(envelope).success).toBe(true);
  });

  it('refuses an empty scope statement', () => {
    expect(coverageAttestationSchema.safeParse({ ...envelope, scopeStatement: '   ' }).success).toBe(
      false,
    );
  });

  it('refuses an envelope that omits the unmeasured list or the cap list', () => {
    /*
     * No `.default([])` on either, deliberately, and this is the test that
     * holds it. An empty list here would be the claim that nothing was
     * unmeasured in a round that added thirteen axes — a reader given a
     * percentage and no scope concludes "87% of the application", not "scope
     * unknown".
     */
    const { unmeasured: _u, ...noUnmeasured } = envelope;
    const { caps: _c, ...noCaps } = envelope;
    expect(coverageAttestationSchema.safeParse(noUnmeasured).success).toBe(false);
    expect(coverageAttestationSchema.safeParse(noCaps).success).toBe(false);
  });

  it('refuses a numerator above its denominator and a percent on an empty one', () => {
    expect(coverageAttestationSchema.safeParse({ ...envelope, covered: 104 }).success).toBe(false);
    expect(
      coverageAttestationSchema.safeParse({ ...envelope, denominator: 0, covered: 0, percent: 0 })
        .success,
    ).toBe(false);
  });

  it('refuses an unmeasured entry that names no axis', () => {
    expect(
      attestationUnmeasuredSchema.safeParse({
        dimension: null,
        kind: null,
        reason: 'NO_EXTRACTOR',
        detail: 'something',
        cells: null,
      }).success,
    ).toBe(false);
  });
});

describe('validityBacktestSchema never lets a thin sample produce a rate', () => {
  const backtest = {
    windowStartAtIso: '2026-07-26T00:00:00.000Z',
    windowEndAtIso: '2026-10-26T00:00:00.000Z',
    defectCount: 41,
    coveredSurfaceCount: 60,
    uncoveredSurfaceCount: 43,
    defectsOnCovered: 9,
    defectsOnUncovered: 32,
    escapedRateCovered: 0.15,
    escapedRateUncovered: 0.74,
    verdict: 'SUFFICIENT' as const,
    verdictDetail: '41 defects in the window, above the 30 this comparison needs',
    defectSource: 'github issues labelled bug',
    fingerprint: 'vb-1',
  };

  it('accepts a sufficient back-test', () => {
    expect(validityBacktestSchema.safeParse(backtest).success).toBe(true);
  });

  it('refuses a rate beside INSUFFICIENT_DATA', () => {
    // The whole point of that answer is that there is no number: a zero escaped
    // rate on covered surface is the most flattering figure this product could
    // print, and it is exactly what a back-test over three tickets produces.
    expect(
      validityBacktestSchema.safeParse({
        ...backtest,
        defectCount: 3,
        defectsOnCovered: 1,
        defectsOnUncovered: 2,
        verdict: 'INSUFFICIENT_DATA',
        verdictDetail: '3 defects in the window, below the 30 this comparison needs',
      }).success,
    ).toBe(false);
    expect(
      validityBacktestSchema.safeParse({
        ...backtest,
        defectCount: 3,
        defectsOnCovered: 1,
        defectsOnUncovered: 2,
        escapedRateCovered: null,
        escapedRateUncovered: null,
        verdict: 'INSUFFICIENT_DATA',
        verdictDetail: '3 defects in the window, below the 30 this comparison needs',
      }).success,
    ).toBe(true);
  });

  it('refuses SUFFICIENT below the threshold the row itself declares', () => {
    expect(
      validityBacktestSchema.safeParse({ ...backtest, defectCount: 32, minimumDefects: 40 })
        .success,
    ).toBe(false);
  });

  it('refuses more attributed defects than were counted', () => {
    expect(
      validityBacktestSchema.safeParse({ ...backtest, defectsOnCovered: 40 }).success,
    ).toBe(false);
  });

  it('refuses a window that ends before it starts', () => {
    expect(
      validityBacktestSchema.safeParse({
        ...backtest,
        windowStartAtIso: '2026-10-26T00:00:00.000Z',
        windowEndAtIso: '2026-07-26T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

describe('the benchmark schemas', () => {
  const run = {
    seed: 'seed-1',
    faultCount: 7,
    detectedCount: 4,
    missedCount: 2,
    notExercisedCount: 1,
    baselineCleanBefore: true,
    baselineCleanAfter: true,
    startedAtIso: '2026-10-26T09:00:00.000Z',
    finishedAtIso: '2026-10-26T09:30:00.000Z',
    fingerprint: 'bench-1',
  };

  it('accepts a completed bench', () => {
    expect(benchmarkRunSchema.safeParse(run).success).toBe(true);
  });

  it('lets an unfinished bench report no counts at all', () => {
    // 0 detected is a result — a terrible one — and "we did not finish" is not
    // a result. Defaulting the counts would make a crashed bench report a 0%
    // detection rate against the product's own suite.
    expect(
      benchmarkRunSchema.safeParse({
        ...run,
        detectedCount: null,
        missedCount: null,
        notExercisedCount: null,
        baselineCleanAfter: null,
        finishedAtIso: null,
      }).success,
    ).toBe(true);
  });

  it('refuses a finished bench with no counts and one that never re-checked the baseline', () => {
    expect(benchmarkRunSchema.safeParse({ ...run, detectedCount: null }).success).toBe(false);
    expect(benchmarkRunSchema.safeParse({ ...run, baselineCleanAfter: null }).success).toBe(false);
  });

  it('refuses more outcomes than faults', () => {
    expect(benchmarkRunSchema.safeParse({ ...run, faultCount: 3 }).success).toBe(false);
  });

  it('refuses a detection nobody can point at', () => {
    expect(
      benchmarkFaultResultSchema.safeParse({
        faultId: 'f1',
        faultClass: 'broken-validation',
        outcome: 'DETECTED',
        detail: 'checkout.spec.ts went red',
      }).success,
    ).toBe(false);
    expect(
      benchmarkFaultResultSchema.safeParse({
        faultId: 'f1',
        faultClass: 'broken-validation',
        outcome: 'DETECTED',
        detail: 'checkout.spec.ts went red',
        detectedByTestId: 't1',
      }).success,
    ).toBe(true);
  });

  it('refuses a test credited for a fault that was not recorded as detected', () => {
    expect(
      benchmarkFaultResultSchema.safeParse({
        faultId: 'f1',
        faultClass: 'silent-failure',
        outcome: 'NOT_EXERCISED',
        detail: 'no test exercised ROUTE:/refunds',
        detectedByTestId: 't1',
      }).success,
    ).toBe(false);
  });

  it('requires a sentence on NOT_EXERCISED, which is the outcome most easily misread', () => {
    expect(
      benchmarkFaultResultSchema.safeParse({
        faultId: 'f1',
        faultClass: 'silent-failure',
        outcome: 'NOT_EXERCISED',
        detail: '',
      }).success,
    ).toBe(false);
  });
});
