/**
 * The matrix dimensions — what TYPE of test a surface owes, what DEVICE and
 * LOCALE it was exercised at, and which FEATURE-FLAG combination the crawl was
 * actually looking at.
 *
 * WHY THIS FILE EXISTS
 *
 * `surface-coverage.ts` decides whether an item is covered with one boolean,
 * and `coverage.ts` indexes every test into that one boolean whatever kind of
 * test it is (`indexTest` reads routes and source; `totals.byType` counts tests
 * per type and never divides anything BY a type). Three sentences follow from
 * that, and all three are either unsayable or false today:
 *
 *   1. COVERAGE IS TYPE-BLIND. A PERFORMANCE test marks /checkout fully
 *      visited exactly as an E2E does, so "routes with an ACCESSIBILITY test:
 *      3 of 14" cannot be said at all. Nineteen test types, one boolean.
 *   2. CROSS_BROWSER, LOCALIZATION and MOBILE have working plugins and NOTHING
 *      to measure them against. The runner can execute a test in de-DE on
 *      WebKit at 390×844 and the product cannot count the cell it ran in.
 *   3. A FLAG THAT CHANGES A PAGE MEANS THE CRAWL SAW ONE OF TWO APPS, and the
 *      denominator cannot say which. Half an application can be missing from
 *      the inventory with nothing anywhere recording that it was.
 *
 * ── THREE DENOMINATORS. NEVER SUMMED. ───────────────────────────────────────
 *
 * The one rule this file is arranged around. A type obligation, a device cell
 * and a flag combination are three different things to test, counted over three
 * different populations, and there is deliberately NO function here that
 * returns "the matrix percentage". {@link CoverageMatrix} holds three
 * {@link DimensionMeasurement}s side by side and no total; every figure comes
 * off ONE measurement's own ladder through `dimensionPercentAt`, which is
 * structurally incapable of adding two denominators. This product has already
 * shipped a headline that summed routes + journeys + forms + controls, which
 * made controls roughly 80% of the figure; three axes is three more chances to
 * do it again.
 *
 * ── AND NEVER THE CROSS PRODUCT ─────────────────────────────────────────────
 *
 * 412 routes × 4 devices × 12 locales is 19,776 cells nobody declared, and 20
 * boolean flags is a million applications. Both would make every real number
 * look like a rounding error, and both are false: they assert that every device
 * interacts with every locale on every route, which no source has said. So the
 * denominators here are DECLARED PAIRINGS, counted by `dimensionDenominator`
 * and `multiAxisDenominator` in packages/shared/src/surface.ts, with the cross
 * product reported BESIDE the declared count so the possible/declared gap is
 * visible rather than implied. The dimensions SUM across axes; they do not
 * multiply.
 *
 * ── IT IS PURE: NO PRISMA, NO BROWSER, NO CLOCK ─────────────────────────────
 *
 * Every input below is an observation somebody else read and every output is a
 * row somebody else stores — the same arrangement `access-matrix.ts` uses, and
 * for the same reason. There is no injected I/O interface here because there is
 * no I/O to inject: freshness takes `nowIso` as an argument, so the one
 * decision that could depend on a clock is deterministic and testable.
 *
 * ── THE FLAG LANDMINE, STATED ONCE AND PLAINLY ──────────────────────────────
 *
 * The flags measured here are the CUSTOMER'S flags: `SurfaceDimension` rows of
 * kind FLAG, whose variants the ENUMERATE round reads out of their provider.
 * QAAI's OWN `FeatureFlag` / `FeatureFlagOverride` tables are a different
 * thing entirely — four seeded rows, all `enabled: false`, read by nothing, and
 * one of the four known gaps `check:wiring` prints on every run. Wiring them as
 * they stand would switch four working features OFF. Nothing in this module
 * reads, writes, names or resolves them, and because the module is pure it
 * could not reach them if it tried.
 *
 * ── THE RULES INHERITED, NOT RE-DECIDED ─────────────────────────────────────
 *
 * `percent` is null for an empty denominator (`coveragePercent`). Written is
 * not run (`COVERAGE_EDGE_SOURCE_CEILING`). A failing test is still coverage —
 * covered and failing are two facts. UNKNOWN is not a gap and stays in the
 * denominator. An unmeasured axis is NAMED as unmeasured and is never 0%
 * (`unmeasuredDimension`, which cannot produce a zero). A cap that bit is
 * reported as a count AND a reason (`DimensionCapBite`). An UNEXERCISABLE or
 * REFUSED surface leaves the denominator with a reason and is never scored as a
 * pass. None of those is re-implemented here; every one of them is a call.
 */

import {
  COVERAGE_DIMENSION_DESCRIPTORS,
  COVERAGE_TIER_RANK,
  DIMENSION_AXIS,
  DIMENSION_UNMEASURED_REASONS,
  DIMENSION_UNMEASURED_REASON_LABELS,
  MEASURED_SURFACE_KINDS,
  TEST_TYPES,
  UNVARIED,
  capabilityCounts,
  coverageLadder,
  dimensionCellIdentity,
  dimensionDenominator,
  exercisabilityCounts,
  measuredDimension,
  multiAxisDenominator,
  obligationsFor,
  promoteCoverageTier,
  resolveCoverageEdges,
  surfaceKey,
  unmeasuredDimension,
} from '@qaai/shared';
import type {
  CoverageDimensionKind,
  CoverageEdgeSource,
  CoverageLadder,
  CoverageTier,
  DeploymentCapabilityStatus,
  DimensionCapBite,
  DimensionDenominator,
  DimensionMeasurement,
  DimensionUnmeasuredReason,
  NotRunKind,
  SurfaceDimensionKind,
  SurfaceExercise,
  SurfaceKind,
  SurfaceSource,
  TestResultStatus,
  TestType,
  TierCapReason,
  TypeObligationPolicy,
} from '@qaai/shared';

/**
 * The three axes this module measures, and nothing else.
 *
 * A `readonly CoverageDimensionKind[]` rather than three string literals, so
 * the compiler refuses a fourth name that is not one of the keystone's thirteen
 * dimensions — a matrix axis spelled `DEVICE` or `DEVICES_AND_LOCALES` would be
 * a fourteenth dimension with no descriptor, no cell vocabulary and no
 * denominator, which is the drift `COVERAGE_DIMENSION_DESCRIPTORS` exists to
 * stop. The order is the order the report prints them in.
 */
export const MATRIX_DIMENSIONS: readonly CoverageDimensionKind[] = [
  'TEST_TYPE',
  'DEVICE_LOCALE',
  'FLAG_COMBINATION',
];

// ─── Shared: naming WHY cells went unmeasured, when several reasons apply ────

/**
 * One {@link DimensionMeasurement} carries ONE `unmeasuredReason`, and a real
 * matrix hits several at once. This picks the one the row reports and writes a
 * detail that names every one of them with its count.
 *
 * ── WHY THE DETAIL MUST NAME ALL OF THEM ────────────────────────────────────
 *
 * The reason is the actionable half: NO_EXTRACTOR is work for us, CAP_BIT is a
 * budget to raise, HELD_OUT is a binary to install or a waiver to revisit. A
 * row that reported only the largest group would hide the others behind a
 * number that looks complete — "41 obligations were not measured" with one
 * cause named reads as "41 for that cause", which is false whenever it is not
 * the only one. So the code is the dominant group and the SENTENCE is the whole
 * breakdown, and the per-reason counts also travel on the matrix's own result
 * so nothing has to be parsed back out of prose.
 *
 * Ties break on declaration order in `DIMENSION_UNMEASURED_REASONS`, not on
 * whichever key `Map` iteration happened to yield, so two runs over the same
 * data cannot report two different reasons for the same shortfall.
 */
export function dominantUnmeasuredReason(
  counts: ReadonlyMap<DimensionUnmeasuredReason, number>,
): { reason: DimensionUnmeasuredReason; detail: string; unmeasured: number } | null {
  let total = 0;
  for (const count of counts.values()) total += count;
  if (total === 0) return null;

  const ordered = DIMENSION_UNMEASURED_REASONS.filter((reason) => (counts.get(reason) ?? 0) > 0);
  let dominant = ordered[0]!;
  for (const reason of ordered) {
    if ((counts.get(reason) ?? 0) > (counts.get(dominant) ?? 0)) dominant = reason;
  }

  return {
    reason: dominant,
    unmeasured: total,
    detail: ordered
      .map(
        (reason) => `${counts.get(reason) ?? 0} — ${DIMENSION_UNMEASURED_REASON_LABELS[reason]}`,
      )
      .join('; '),
  };
}

/**
 * True when `candidate` sits above `current` on the ladder.
 *
 * `COVERAGE_TIER_RANK` and not an `indexOf` into `COVERAGE_TIERS`: the rank
 * table is the published one, a sixth rung breaks it until somebody decides
 * where it ranks, and an `indexOf` would silently rank an unknown tier last.
 */
function strongerTier(candidate: CoverageTier, current: CoverageTier): boolean {
  return COVERAGE_TIER_RANK[candidate] > COVERAGE_TIER_RANK[current];
}

/**
 * The reading for an axis whose CELL SET could not be enumerated at all.
 *
 * `cells: 0` and NOT_ENUMERATED, which says "we do not know how many there
 * are" — deliberately not "there are none". An empty `SurfaceDimension` table
 * for LOCALE is indistinguishable from a monolingual application, and claiming
 * the second from the first would be a fact about the customer's app assembled
 * out of our own silence. The percentage is null at every rung by arithmetic,
 * because `unmeasuredDimension` builds `coverageLadder([])`.
 */
function notEnumerated(
  dimension: CoverageDimensionKind,
  detail: string,
  caps: readonly DimensionCapBite[] = [],
): DimensionMeasurement {
  return unmeasuredDimension({ dimension, reason: 'NOT_ENUMERATED', detail, caps });
}

// ─── 1. TEST_TYPE: surface × obligation ──────────────────────────────────────

/**
 * The fields of a `SurfaceItem` an obligation is entitled to read.
 *
 * STRUCTURAL, so a real `SurfaceItem` row satisfies it without a mapping step,
 * and narrow so nothing here can quietly start branching on a label, a
 * detector or a line number. `exercise` and `waived` are the two that move a
 * number, and both move it DOWNWARD into "held out with a reason" rather than
 * out of sight.
 */
export interface ObligationSubject {
  /** `CoverageItem.key` — `surfaceKey(kind, identity)`. */
  key: string;
  kind: SurfaceKind;
  /** `SurfaceItem.exercise`. UNEXERCISABLE and REFUSED leave the denominator. */
  exercise?: SurfaceExercise | null;
  /**
   * Whether a `CoverageWaiver` holds this item out. Absent is read as not
   * waived, which is what every caller that does not pass it has meant.
   */
  waived?: boolean;
}

/**
 * "This route owes an ACCESSIBILITY test" — one obligation, as a declarer
 * stated it.
 *
 * `declaredBy` is a `SurfaceSource` rather than a new enum, matching
 * `CoverageTypeObligation.declaredBy`: a policy a human configured is MANUAL, a
 * requirement that demands an accessibility check is REQUIREMENT, a detector
 * that read it out of the repo is SOURCE. Reusing the declarer vocabulary means
 * the strength of the claim is already ranked and already drift-guarded.
 */
export interface DeclaredTypeObligation {
  itemKey: string;
  testType: TestType;
  declaredBy: SurfaceSource;
  /** The sentence that justifies the obligation. Never defaulted. */
  evidence: string;
}

/**
 * One (test → item) link, WITH THE TYPE OF THE TEST ON IT.
 *
 * `testType` is the whole point of this shape and the fix for the defect in
 * this file's header: a PERFORMANCE edge is evidence for the PERFORMANCE
 * obligation of that item and for nothing else. An edge with no type could only
 * ever satisfy "some test touched this", which is the single boolean.
 *
 * `tier` arrives already promoted by `promoteCoverageTier` — the source
 * ceiling, the quarantine cap and the freshness window are decided once, in
 * coverage-tiers.ts, and re-deciding them here would be a second definition of
 * PASSING.
 */
export interface TypedCoverageEdge {
  itemKey: string;
  testId: string;
  /** The type of the TEST. Not of the obligation it may happen to satisfy. */
  testType: TestType;
  source: CoverageEdgeSource;
  tier: CoverageTier;
  cappedBy?: TierCapReason | null;
  /**
   * The run that confirmed it. NULL IS NOT OPTIONAL: a tier above DECLARED
   * with no run named is a promotion nobody can audit, and the cell is capped
   * back to DECLARED rather than stored in a shape
   * `coverageTypeObligationSchema` refuses. See {@link TypeObligationMatrix}.
   */
  runId: string | null;
}

/**
 * Whether this deployment can execute one test type at all.
 *
 * Mirrors `DeploymentCapability` row for row. A type ABSENT from the list is
 * NOT_CHECKED and stays IN the denominator — dropping an unprobed type would
 * let a deployment that never ran a preflight shed every obligation it could
 * not prove it could run, and the percentage would rise for a preflight nobody
 * executed. `capabilityCounts` is the one place that decision lives.
 */
export interface DeploymentCapabilityFact {
  testType: TestType;
  status: DeploymentCapabilityStatus;
  /** What a human needs in order to fix it. Never a credential. */
  detail: string;
}

/** One (item, testType) obligation, measured. Shaped as the row that stores it. */
export interface TypeObligationCell {
  itemKey: string;
  /** The axis the item is on, so the per-kind breakdown needs no second read. */
  kind: SurfaceKind;
  testType: TestType;
  declaredBy: SurfaceSource;
  evidence: string;
  /** NULL means nothing claims this obligation. Not DECLARED — see the ladder. */
  tier: CoverageTier | null;
  tierCappedBy: TierCapReason | null;
  lastConfirmedRunId: string | null;
  /** Non-null EXACTLY when this cell is out of `measured`. */
  unmeasuredReason: DimensionUnmeasuredReason | null;
  unmeasuredDetail: string | null;
  /** Whether this cell is in the ladder's denominator. */
  counted: boolean;
  /** What this deployment can do about the type. NOT_CHECKED when nobody asked. */
  capability: DeploymentCapabilityStatus;
}

/** One test type's own ladder, over its own denominator. */
export interface TypeObligationTotals {
  testType: TestType;
  /** Obligations declared for this type, held-out ones included. */
  owed: number;
  /**
   * The ladder over the obligations of THIS TYPE that were measured. One
   * denominator per type: "routes with an ACCESSIBILITY test: 3 of 14" is
   * `tiers` at NAVIGATED, and it is never added to another type's figure.
   */
  tiers: CoverageLadder;
  unmeasured: number;
  capability: DeploymentCapabilityStatus;
}

export interface TypeObligationMatrix {
  measurement: DimensionMeasurement;
  cells: readonly TypeObligationCell[];
  /** Per type. The breakdown that makes the headline sentence sayable. */
  byType: readonly TypeObligationTotals[];
  /** Per item axis, because an obligation refines every measured axis. */
  byKind: ReadonlyArray<{ kind: SurfaceKind; owed: number; tiers: CoverageLadder }>;
  /** Cells out of the denominator, grouped by reason, largest first. */
  heldOut: ReadonlyArray<{ reason: DimensionUnmeasuredReason; detail: string; cells: number }>;
  /**
   * Obligations a declarer stated on an axis `TEST_TYPE` does not refine, and
   * therefore REFUSED rather than minted.
   *
   * An obligation on a DEVICE_LOCALE or FLAG_COMBINATION item would be an
   * obligation on a CELL, and a cell that owes nineteen typed tests is how
   * nineteen fabricated denominators get built out of one real one. These are
   * counted and named instead of thrown, because they arrive from a stored
   * table and one bad row must not take the whole matrix down with it.
   */
  refused: ReadonlyArray<{ itemKey: string; testType: TestType; why: string }>;
  /**
   * Typed edges that matched an item owing no obligation of that type.
   *
   * THE DEFECT IN THIS FILE'S HEADER, MADE VISIBLE. A PERFORMANCE test against
   * /checkout is real work and real evidence; what it is not is evidence that
   * /checkout has an E2E test. The count says how much evidence this matrix
   * declined to credit, so "we ran 40 performance tests and the type matrix
   * moved by nothing" has an explanation on the same screen.
   */
  uncredited: ReadonlyArray<{ testType: TestType; edges: number }>;
  /**
   * Edges claiming a rung above DECLARED with no run id, capped back to
   * DECLARED. A promotion nobody can point at a run for is not a promotion.
   */
  unattributedPromotions: number;
  /** The sentence printed where a product would otherwise go. */
  rule: string;
}

/**
 * Resolves WHAT IS OWED from the explicit declarations and the project policy.
 *
 * ── AN OBLIGATION NOBODY DECLARED IS NOT OWED ───────────────────────────────
 *
 * `obligationsFor` is the one resolver and `DEFAULT_TYPE_OBLIGATIONS` owes
 * NOTHING, so a project with no policy and no declarations has an empty
 * denominator and no figure — not nineteen gaps per item. For a 412-route
 * project a single default would mint 824 obligations on migration day and
 * report QAAI's opinion about what a team should test as the team's debt.
 *
 * Explicit declarations are applied FIRST and the policy only fills what they
 * do not cover, because a declaration names its own evidence and the policy's
 * is generic. Dedup is on (itemKey, testType): an axis declared to owe the same
 * type twice would count one obligation as two and inflate a denominator the
 * customer configured by hand.
 */
export function resolveTypeObligations(input: {
  items: readonly ObligationSubject[];
  declarations?: readonly DeclaredTypeObligation[];
  policy?: TypeObligationPolicy | null;
}): DeclaredTypeObligation[] {
  const byItem = new Map<string, ObligationSubject>();
  for (const item of input.items) byItem.set(item.key, item);

  const resolved = new Map<string, DeclaredTypeObligation>();
  const cellKey = (itemKey: string, testType: TestType): string => `${itemKey}\u0000${testType}`;

  for (const declaration of input.declarations ?? []) {
    const key = cellKey(declaration.itemKey, declaration.testType);
    if (!resolved.has(key)) resolved.set(key, declaration);
  }

  const policy = input.policy ?? null;
  if (policy !== null) {
    for (const item of byItem.values()) {
      for (const testType of obligationsFor(item.kind, policy)) {
        const key = cellKey(item.key, testType);
        if (resolved.has(key)) continue;
        resolved.set(key, {
          itemKey: item.key,
          testType,
          // MANUAL, because a type-obligation policy is a thing a human
          // configured. Attributing it to SOURCE would claim a detector read it
          // out of the repository, which is a stronger claim than was made.
          declaredBy: 'MANUAL',
          evidence: `the project's type-obligation policy says a ${item.kind} owes a ${testType} test`,
        });
      }
    }
  }

  return [...resolved.values()];
}

/**
 * THE TYPE MATRIX: surface × obligation.
 *
 * ── WHY ONE DENOMINATOR HERE IS NOT NINETEEN SUMMED ─────────────────────────
 *
 * Every cell is the same unit — one typed test somebody owes — so an obligation
 * on a ROUTE and one on an ENDPOINT are commensurable in a way that a route and
 * a form are not. That is the difference between this measurement and the
 * headline that summed four axes: there, four incommensurable populations were
 * divided by one number; here one population is divided by itself, and
 * {@link TypeObligationMatrix.byType} and `byKind` carry the per-type and
 * per-axis ladders beside it, each over its own denominator.
 *
 * ── THE FOUR WAYS A CELL LEAVES THE DENOMINATOR, IN ORDER ───────────────────
 *
 * The order is tested, because when two apply the row reports one of them and
 * the wrong one sends the reader to the wrong remedy:
 *
 *   1. NO_EXTRACTOR — the item's axis is outside `MEASURED_SURFACE_KINDS`, so
 *      nothing in this build can match a test to it at all. Reported FIRST:
 *      installing the missing binary would not help, which is exactly what a
 *      HELD_OUT row would tell the reader to do.
 *   2. HELD_OUT, because the item is waived, UNEXERCISABLE or REFUSED. The
 *      team's decision or our harness's limit, named either way.
 *   3. HELD_OUT, because this deployment cannot EXECUTE the type: no k6, no
 *      Lighthouse, no Firefox. The plugin degrades to SKIPPED, so scoring the
 *      obligation would put a test that can never fail inside a percentage.
 *   4. counted — including when nothing claims it, which is the gap.
 */
export function buildTypeObligationMatrix(input: {
  items: readonly ObligationSubject[];
  obligations: readonly DeclaredTypeObligation[];
  edges?: readonly TypedCoverageEdge[];
  capabilities?: readonly DeploymentCapabilityFact[];
  caps?: readonly DimensionCapBite[];
}): TypeObligationMatrix {
  const caps = [...(input.caps ?? [])];
  const byItem = new Map<string, ObligationSubject>();
  for (const item of input.items) byItem.set(item.key, item);

  const capability = new Map<TestType, DeploymentCapabilityFact>();
  for (const fact of input.capabilities ?? []) capability.set(fact.testType, fact);

  const refinedAxes = COVERAGE_DIMENSION_DESCRIPTORS.TEST_TYPE.refines;

  if (byItem.size === 0) {
    return {
      measurement: notEnumerated(
        'TEST_TYPE',
        'no surface items were supplied, so whether anything owes a typed test is unknown rather than zero',
        caps,
      ),
      cells: [],
      byType: [],
      byKind: [],
      heldOut: [],
      refused: [],
      uncredited: [],
      unattributedPromotions: 0,
      rule: 'no inventory was supplied, so no obligation could be resolved against one',
    };
  }

  /*
   * Edges grouped per CELL, not per item. This grouping IS the fix: a
   * PERFORMANCE edge lands in the (item, PERFORMANCE) bucket and can never be
   * seen by the (item, ACCESSIBILITY) cell, which is the single boolean's
   * defect expressed as a data structure rather than as a rule somebody has to
   * remember.
   */
  const edgesByCell = new Map<string, TypedCoverageEdge[]>();
  const edgeCellKey = (itemKey: string, testType: TestType): string =>
    `${itemKey}\u0000${testType}`;
  for (const edge of input.edges ?? []) {
    const key = edgeCellKey(edge.itemKey, edge.testType);
    const bucket = edgesByCell.get(key);
    if (bucket) bucket.push(edge);
    else edgesByCell.set(key, [edge]);
  }

  const cells: TypeObligationCell[] = [];
  const refused: Array<{ itemKey: string; testType: TestType; why: string }> = [];
  const unmeasuredCounts = new Map<DimensionUnmeasuredReason, number>();
  const heldOutDetail = new Map<DimensionUnmeasuredReason, Map<string, number>>();
  let unattributedPromotions = 0;

  const noteUnmeasured = (reason: DimensionUnmeasuredReason, detail: string): void => {
    unmeasuredCounts.set(reason, (unmeasuredCounts.get(reason) ?? 0) + 1);
    const byDetail = heldOutDetail.get(reason) ?? new Map<string, number>();
    byDetail.set(detail, (byDetail.get(detail) ?? 0) + 1);
    heldOutDetail.set(reason, byDetail);
  };

  const seen = new Set<string>();
  for (const obligation of input.obligations) {
    const item = byItem.get(obligation.itemKey);
    if (item === undefined) {
      refused.push({
        itemKey: obligation.itemKey,
        testType: obligation.testType,
        why: 'this item key is not in the inventory, so the obligation refines nothing',
      });
      continue;
    }
    if (!refinedAxes.includes(item.kind)) {
      refused.push({
        itemKey: obligation.itemKey,
        testType: obligation.testType,
        why:
          `TEST_TYPE does not refine the ${item.kind} axis — an obligation on a cell would be ` +
          'nineteen fabricated denominators built out of one real one',
      });
      continue;
    }
    const cellKey = edgeCellKey(obligation.itemKey, obligation.testType);
    if (seen.has(cellKey)) continue;
    seen.add(cellKey);

    const status = capability.get(obligation.testType)?.status ?? 'NOT_CHECKED';

    // 1. No extractor for the item's axis. Checked first — see the header.
    if (!MEASURED_SURFACE_KINDS.includes(item.kind)) {
      const detail =
        `nothing in this build matches a test to a ${item.kind}, so whether this obligation is ` +
        'met is unknown rather than unmet';
      noteUnmeasured('NO_EXTRACTOR', detail);
      cells.push({
        itemKey: obligation.itemKey,
        kind: item.kind,
        testType: obligation.testType,
        declaredBy: obligation.declaredBy,
        evidence: obligation.evidence,
        tier: null,
        tierCappedBy: null,
        lastConfirmedRunId: null,
        unmeasuredReason: 'NO_EXTRACTOR',
        unmeasuredDetail: detail,
        counted: false,
        capability: status,
      });
      continue;
    }

    // 2. The item itself is out of the denominator. A waiver is the team's
    // decision; UNEXERCISABLE and REFUSED are our harness's limits. Both are
    // counted, named, and never scored as a pass.
    const waived = item.waived === true;
    if (waived || !exercisabilityCounts(item.exercise?.state)) {
      const detail = waived
        ? 'the item carries a waiver, so every obligation on it is out of the denominator by the team’s decision'
        : `the harness cannot drive this item here (${item.exercise?.detail ?? 'no detail recorded'})`;
      noteUnmeasured('HELD_OUT', detail);
      cells.push({
        itemKey: obligation.itemKey,
        kind: item.kind,
        testType: obligation.testType,
        declaredBy: obligation.declaredBy,
        evidence: obligation.evidence,
        tier: null,
        tierCappedBy: null,
        lastConfirmedRunId: null,
        unmeasuredReason: 'HELD_OUT',
        unmeasuredDetail: detail,
        counted: false,
        capability: status,
      });
      continue;
    }

    // 3. This deployment cannot execute the type. NOT_CHECKED is NOT here:
    // `capabilityCounts` keeps an unprobed type in the denominator.
    if (!capabilityCounts(status)) {
      const detail =
        `this deployment cannot execute a ${obligation.testType} test (${status}: ` +
        `${capability.get(obligation.testType)?.detail ?? 'no detail recorded'}), so scoring it ` +
        'would put a test that always skips inside a percentage';
      noteUnmeasured('HELD_OUT', detail);
      cells.push({
        itemKey: obligation.itemKey,
        kind: item.kind,
        testType: obligation.testType,
        declaredBy: obligation.declaredBy,
        evidence: obligation.evidence,
        tier: null,
        tierCappedBy: null,
        lastConfirmedRunId: null,
        unmeasuredReason: 'HELD_OUT',
        unmeasuredDetail: detail,
        counted: false,
        capability: status,
      });
      continue;
    }

    // 4. Measured. The edges of THIS TYPE, resolved by MAX with the strongest
    // source winning a tie — two tests covering one obligation does not make it
    // more covered than the better of the two makes it.
    const bucket = edgesByCell.get(cellKey) ?? [];
    const resolvedEdges = resolveCoverageEdges(bucket);
    let tier = resolvedEdges.tier;
    let tierCappedBy = resolvedEdges.authoritative?.cappedBy ?? null;
    let runId = resolvedEdges.authoritative?.runId ?? null;
    if (tier !== null && tier !== 'DECLARED' && runId === null) {
      /*
       * A rung above DECLARED with no run behind it. `coverageTypeObligation
       * Schema` refuses the row ("a tier above DECLARED must name the run that
       * observed it") and it is refused here too rather than demoted silently:
       * the claim keeps its DECLARED half, which somebody did make, and loses
       * the promotion nobody can audit. Capping DOWN is the only safe direction
       * — the other one invents a run id.
       */
      unattributedPromotions += 1;
      tier = 'DECLARED';
      tierCappedBy = 'NO_RUN_OBSERVED';
      runId = null;
    }
    cells.push({
      itemKey: obligation.itemKey,
      kind: item.kind,
      testType: obligation.testType,
      declaredBy: obligation.declaredBy,
      evidence: obligation.evidence,
      tier,
      tierCappedBy,
      // Null for DECLARED and for null: a run id beside a claim nothing ran
      // reads as a measurement.
      lastConfirmedRunId: tier === null || tier === 'DECLARED' ? null : runId,
      unmeasuredReason: null,
      unmeasuredDetail: null,
      counted: true,
      capability: status,
    });
  }

  const counted = cells.filter((cell) => cell.counted);
  const unmeasured = dominantUnmeasuredReason(unmeasuredCounts);

  const measurement =
    cells.length === 0
      ? /*
         * NOTHING IS OWED, AND THAT IS NOT "UNMEASURED".
         *
         * The one place in this module where an empty denominator is a FACT
         * rather than a hole: `DEFAULT_TYPE_OBLIGATIONS` owes nothing, so a
         * project that declared no policy owes nothing, and we know that
         * exactly. `measuredDimension([])` reports it with no reason code and a
         * null percentage at every rung — where NOT_ENUMERATED would claim we
         * failed to look. The inventory being empty is the other case and is
         * handled above, because THAT one really is a hole.
         */
        measuredDimension({ dimension: 'TEST_TYPE', measuredCells: [], caps })
      : measuredDimension({
          dimension: 'TEST_TYPE',
          measuredCells: counted.map((cell) => cell.tier),
          unmeasured: unmeasured?.unmeasured ?? 0,
          unmeasuredReason: unmeasured?.reason ?? null,
          unmeasuredDetail: unmeasured?.detail ?? null,
          caps,
        });

  const byType: TypeObligationTotals[] = [];
  for (const testType of TEST_TYPES) {
    const owned = cells.filter((cell) => cell.testType === testType);
    if (owned.length === 0) continue;
    byType.push({
      testType,
      owed: owned.length,
      tiers: coverageLadder(owned.filter((cell) => cell.counted).map((cell) => cell.tier)),
      unmeasured: owned.filter((cell) => !cell.counted).length,
      capability: capability.get(testType)?.status ?? 'NOT_CHECKED',
    });
  }

  const byKind: Array<{ kind: SurfaceKind; owed: number; tiers: CoverageLadder }> = [];
  for (const kind of refinedAxes) {
    const owned = cells.filter((cell) => cell.kind === kind);
    if (owned.length === 0) continue;
    byKind.push({
      kind,
      owed: owned.length,
      tiers: coverageLadder(owned.filter((cell) => cell.counted).map((cell) => cell.tier)),
    });
  }

  const heldOut: Array<{ reason: DimensionUnmeasuredReason; detail: string; cells: number }> = [];
  for (const reason of DIMENSION_UNMEASURED_REASONS) {
    const byDetail = heldOutDetail.get(reason);
    if (!byDetail) continue;
    for (const [detail, count] of byDetail) heldOut.push({ reason, detail, cells: count });
  }
  heldOut.sort((left, right) => right.cells - left.cells || left.detail.localeCompare(right.detail));

  /*
   * Edges that match no obligation AT ALL — not edges whose obligation was held
   * out. The distinction matters: an edge against a held-out obligation was
   * credited to a cell that exists and left the denominator with a reason,
   * which the `heldOut` list already explains. An edge here is evidence this
   * matrix had nowhere to put, which is the PERFORMANCE-test-against-/checkout
   * case and the one worth a sentence of its own.
   */
  const uncreditedCounts = new Map<TestType, number>();
  for (const [key, bucket] of edgesByCell) {
    if (seen.has(key)) continue;
    const testType = bucket[0]!.testType;
    uncreditedCounts.set(testType, (uncreditedCounts.get(testType) ?? 0) + bucket.length);
  }
  const uncredited = TEST_TYPES.filter((testType) => uncreditedCounts.has(testType)).map(
    (testType) => ({ testType, edges: uncreditedCounts.get(testType) ?? 0 }),
  );

  return {
    measurement,
    cells,
    byType,
    byKind,
    heldOut,
    refused,
    uncredited,
    unattributedPromotions,
    rule:
      cells.length === 0
        ? 'no test type is owed by anything in this inventory, so there is no figure — this is ' +
          'not 0%, and an obligation nobody declared is not owed'
        : `${counted.length} obligation(s) in the denominator, ${cells.length - counted.length} ` +
          'held out with a reason; each type also carries its own ladder over its own ' +
          'denominator, and the three matrix dimensions are never summed',
  };
}

// ─── 2. DEVICE_LOCALE: the matrix a run varies over ──────────────────────────

/**
 * One value of the DEVICE or LOCALE dimension, as a `SurfaceDimension` row.
 *
 * Narrow on purpose: this module counts cells and matches evidence, so it needs
 * the identity, whether the value is the default, and nothing else. A device's
 * width and a locale's text direction are what DRIVES a run, and reading them
 * here would invite a decision about which cells "matter" that no declarer made.
 */
export interface DeviceLocaleValue {
  kind: Extract<SurfaceDimensionKind, 'DEVICE' | 'LOCALE'>;
  /** `SurfaceDimension.key`, in the application's own spelling. Never folded. */
  key: string;
  isDefault?: boolean;
}

/**
 * A declarer saying that a dimension changes one item's behaviour.
 *
 * This is what puts a cell in the denominator. `/checkout` declaring `pt-BR`
 * and `de-DE` has two locale cells; `/pricing` declaring nothing has exactly
 * one, at the default, counted separately so a reader can see how much of the
 * axis is "nobody has said anything about this".
 */
export interface DeviceLocaleDeclaration {
  /** The base item's identity — the ROUTE half of the cell key, not the key. */
  baseKey: string;
  kind: Extract<SurfaceDimensionKind, 'DEVICE' | 'LOCALE'>;
  /** `SurfaceDimension.key` values the declarer named. */
  values: readonly string[];
  source: SurfaceSource;
}

/**
 * ONE CELL OF ONE RUN'S MATRIX — a `TestResultVariant` row, as this module
 * needs it.
 *
 * ── A VARIANT ROW IS THE ONLY THING THAT MAY PROMOTE A CELL ─────────────────
 *
 * `TestResult.status` is the WORST of a test's cells, and a worst-wins roll-up
 * cannot promote anything here: a test that passed on Chromium/en-US and failed
 * on WebKit/de-DE has one PASSED row and one FAILED row, and the roll-up says
 * FAILED for both cells. Crediting the pass to de-DE would be fiction and
 * crediting the failure to en-US would be slander. So there is NO INPUT on this
 * module through which a `TestResult` can reach a device or locale cell — the
 * absence is the enforcement, and a test pins it.
 *
 * `baseKey` is resolved by the CALLER from the test's coverage edges. A variant
 * row knows its run, its test and its cell and has no idea which route it was
 * looking at; inventing the attribution here would be inventing the measurement.
 */
export interface VariantCellObservation {
  /** The base item's identity, as the declarations spell it. */
  baseKey: string;
  testId: string;
  runId: string;
  /** `TestResultVariant.viewport` — the DEVICE key, or {@link UNVARIED}. */
  viewport: string;
  /** `TestResultVariant.locale` — the LOCALE key, or {@link UNVARIED}. */
  locale: string;
  /** Carried for the report; this module never matches a cell on it. */
  browser: string;
  /** THE CELL's own status, never the test's. */
  status: TestResultStatus;
  /**
   * Whether the run asserted anything attributable to this cell.
   *
   * REQUIRED, with no default, and it is the most important field in the shape.
   * A variant row records a status and not an assertion, so defaulting this to
   * true would manufacture the ASSERTED rung for every cell that ran — which is
   * the one promotion the ladder exists to withhold. Defaulting it to false
   * would cap every cell at NAVIGATED and make PASSING unreachable, so the
   * caller states it from the test's edge.
   */
  assertionObserved: boolean;
  /** §5 — a retry that passes is not a pass, per cell as well as per test. */
  retriedAndPassed?: boolean;
  /**
   * Why this cell measured nothing. NULL IS A FIFTH STATE AND IT IS NOT
   * NOT_RUN: a plugin that returned SKIPPED with a plain sentence made no claim
   * about which of the four reasons applies, and a cell whose reason was never
   * recorded stays IN the denominator. All four recorded kinds take it out —
   * see `NOT_RUN_KINDS`, which is on the record that none of them is evidence
   * about the application in either direction.
   */
  notRunKind?: NotRunKind | null;
  /** ISO-8601. Compared against an `nowIso` the caller passes in. */
  observedAtIso: string;
}

/** One declared (base × device) or (base × locale) cell, measured. */
export interface DeviceLocaleCell {
  /** `surfaceKey('DEVICE_LOCALE', dimensionCellIdentity(base, [coordinate]))`. */
  key: string;
  /** The identity half, for a reader that does not want to parse the key. */
  identity: string;
  baseKey: string;
  dimension: Extract<SurfaceDimensionKind, 'DEVICE' | 'LOCALE'>;
  value: string;
  /** True for a cell counted because nothing was declared about this base. */
  atDefault: boolean;
  tier: CoverageTier | null;
  tierCappedBy: TierCapReason | null;
  lastConfirmedRunId: string | null;
  unmeasuredReason: DimensionUnmeasuredReason | null;
  unmeasuredDetail: string | null;
  counted: boolean;
  /** Variant rows that landed on this cell, whatever they said. */
  observations: number;
}

export interface DeviceLocaleMatrix {
  measurement: DimensionMeasurement;
  cells: readonly DeviceLocaleCell[];
  /** Per axis, with the cross product beside the declared count. */
  byDimension: readonly DimensionDenominator[];
  /** `declaredCells + defaultCells`, SUMMED across the two axes, never multiplied. */
  declaredCells: number;
  /** The sum of each axis's cross product. Reported, and never a denominator. */
  crossProduct: number;
  /**
   * Variant rows that varied the dimension at {@link UNVARIED} and could
   * therefore promote nothing.
   *
   * A disclosure and a fix in one sentence: the harness ran at whatever ambient
   * viewport it had and recorded no coordinate, so the cell it ran in is
   * unknown. Crediting the project's DEFAULT cell with it would be inventing
   * the coordinate the sentinel exists to say we do not have.
   *
   * Counted per (row, AXIS) and not per row, because a row may name its
   * viewport and leave its locale at the sentinel — that is one disclosure
   * about locales and none about devices, and one count per row could not say
   * which. A row unvaried on both measured axes therefore contributes two.
   */
  unvariedObservations: number;
  /** Rows at a value the dimension table does not hold. Our extractor's error rate. */
  unknownCoordinates: ReadonlyArray<{
    dimension: Extract<SurfaceDimensionKind, 'DEVICE' | 'LOCALE'>;
    value: string;
    observations: number;
  }>;
  /** Rows attributed to a base that is not in `baseKeys`. */
  unattributedObservations: number;
  heldOut: ReadonlyArray<{ reason: DimensionUnmeasuredReason; detail: string; cells: number }>;
  rule: string;
}

/**
 * Enumerates the cells of one axis and CHECKS the count against
 * `dimensionDenominator`.
 *
 * The cell list and the count are produced by two different pieces of code —
 * this loop and the shared arithmetic — and the check is what stops them
 * drifting into two denominators for one axis. A silent disagreement here would
 * be the worst available defect on this dimension: a percentage over a cell
 * list of one size, printed beside a denominator of another, with both numbers
 * looking right on their own. So it throws, naming both figures, rather than
 * returning whichever one the caller reads first.
 */
function enumerateAxisCells(input: {
  dimension: Extract<SurfaceDimensionKind, 'DEVICE' | 'LOCALE'>;
  baseKeys: readonly string[];
  values: readonly DeviceLocaleValue[];
  declared: ReadonlyMap<string, readonly string[]>;
}): { denominator: DimensionDenominator; cells: Array<{ baseKey: string; value: string; atDefault: boolean }> } {
  const keys = input.values.map((value) => value.key);
  const known = new Set(keys);
  const defaultValue = input.values.find((value) => value.isDefault === true)?.key ?? null;

  const denominator = dimensionDenominator({
    dimension: input.dimension,
    baseKeys: input.baseKeys,
    values: keys,
    defaultValue,
    declared: input.declared,
  });

  const cells: Array<{ baseKey: string; value: string; atDefault: boolean }> = [];
  for (const baseKey of input.baseKeys) {
    // Filtered against the dimension table, and de-duplicated, exactly as
    // `dimensionDenominator` does — a declaration naming a value no row holds
    // is a dangling reference in OUR extractor and must not inflate anything.
    const usable = [...new Set((input.declared.get(baseKey) ?? []).filter((value) => known.has(value)))];
    if (usable.length > 0) {
      for (const value of usable) cells.push({ baseKey, value, atDefault: false });
      continue;
    }
    if (defaultValue !== null) cells.push({ baseKey, value: defaultValue, atDefault: true });
  }

  if (cells.length !== denominator.cells) {
    throw new Error(
      `${input.dimension}: enumerated ${cells.length} cell(s) and dimensionDenominator counted ` +
        `${denominator.cells} — two denominators for one axis, which is the one thing this axis ` +
        'may not have',
    );
  }
  return { denominator, cells };
}

/**
 * THE DEVICE / VIEWPORT / LOCALE MATRIX.
 *
 * ── THE TWO AXES SUM. THEY DO NOT MULTIPLY. ─────────────────────────────────
 *
 * A route × device cell and a route × locale cell are two separate things to
 * test, so `multiAxisDenominator` ADDS them. A route × device × locale cell
 * would be a third thing, and it exists only if a declarer said the two
 * interact on that route — in which case its identity carries both coordinates
 * and it is one cell on one axis, counted once. Multiplying asserts that
 * interaction for every combination, which is the cross product's lie, and the
 * cross product is reported beside the count rather than as it.
 */
export function buildDeviceLocaleMatrix(input: {
  /** The items the cells are pairings OF — normally route identities. */
  baseKeys: readonly string[];
  values: readonly DeviceLocaleValue[];
  declarations?: readonly DeviceLocaleDeclaration[];
  observations?: readonly VariantCellObservation[];
  /** ISO-8601. This module never reads a clock; freshness is an argument. */
  nowIso: string;
  freshnessDays?: number;
  caps?: readonly DimensionCapBite[];
}): DeviceLocaleMatrix {
  const caps = [...(input.caps ?? [])];
  const baseKeys = [...new Set(input.baseKeys)].sort();
  const devices = input.values.filter((value) => value.kind === 'DEVICE');
  const locales = input.values.filter((value) => value.kind === 'LOCALE');

  const empty = (detail: string): DeviceLocaleMatrix => ({
    measurement: notEnumerated('DEVICE_LOCALE', detail, caps),
    cells: [],
    byDimension: [],
    declaredCells: 0,
    crossProduct: 0,
    unvariedObservations: 0,
    unknownCoordinates: [],
    unattributedObservations: 0,
    heldOut: [],
    rule: detail,
  });

  if (baseKeys.length === 0) {
    return empty(
      'no base items were supplied, so how many device or locale cells exist is unknown rather than zero',
    );
  }
  if (devices.length === 0 && locales.length === 0) {
    /*
     * An empty DEVICE and LOCALE table is NOT a monolingual desktop-only
     * application. The two are indistinguishable from here, and claiming the
     * second would be a fact about the customer's app assembled out of our own
     * silence — so the axis is named as not enumerated and the percentage is
     * null, which is the whole contract of `unmeasuredDimension`.
     */
    return empty(
      'this project holds no device and no locale rows, so the cells on this axis were never ' +
        'enumerated — that is not the same as an application with one viewport and one language',
    );
  }

  const baseSet = new Set(baseKeys);
  const declaredBy = (
    kind: Extract<SurfaceDimensionKind, 'DEVICE' | 'LOCALE'>,
  ): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const declaration of input.declarations ?? []) {
      if (declaration.kind !== kind) continue;
      // A declaration about a base outside the inventory pairs with nothing.
      // Keeping it would put `dimensionDenominator`'s count above the cell list
      // this module enumerates, and `enumerateAxisCells` would throw.
      if (!baseSet.has(declaration.baseKey)) continue;
      const bucket = map.get(declaration.baseKey) ?? [];
      bucket.push(...declaration.values);
      map.set(declaration.baseKey, bucket);
    }
    return map;
  };

  const axes: Array<{
    dimension: Extract<SurfaceDimensionKind, 'DEVICE' | 'LOCALE'>;
    denominator: DimensionDenominator;
    cells: Array<{ baseKey: string; value: string; atDefault: boolean }>;
  }> = [];
  if (devices.length > 0) {
    axes.push({
      dimension: 'DEVICE',
      ...enumerateAxisCells({
        dimension: 'DEVICE',
        baseKeys,
        values: devices,
        declared: declaredBy('DEVICE'),
      }),
    });
  }
  if (locales.length > 0) {
    axes.push({
      dimension: 'LOCALE',
      ...enumerateAxisCells({
        dimension: 'LOCALE',
        baseKeys,
        values: locales,
        declared: declaredBy('LOCALE'),
      }),
    });
  }

  const summed = multiAxisDenominator(axes.map((axis) => axis.denominator));

  /*
   * Observations bucketed onto cells. A variant row at the sentinel promotes
   * NOTHING: `<unvaried>` means the harness recorded no coordinate, and the
   * project's default cell is a different claim from "we do not know which cell
   * this ran in". The two counts below are the disclosure that makes the
   * difference visible instead of flattering.
   */
  /*
   * Only the axes that EXIST are read off an observation. A project with no
   * LOCALE rows has no locale axis, so a row's `locale` column is nothing this
   * measurement has an opinion about — counting it as an unknown coordinate, or
   * its sentinel as an unvaried one, would disclose a gap on an axis the report
   * correctly says it does not measure.
   */
  const knownValues = new Map<Extract<SurfaceDimensionKind, 'DEVICE' | 'LOCALE'>, Set<string>>();
  if (devices.length > 0) knownValues.set('DEVICE', new Set(devices.map((value) => value.key)));
  if (locales.length > 0) knownValues.set('LOCALE', new Set(locales.map((value) => value.key)));

  const observationsByCell = new Map<string, VariantCellObservation[]>();
  const unknownCoordinateCounts = new Map<string, number>();
  let unvariedObservations = 0;
  let unattributedObservations = 0;

  const bucketKey = (
    dimension: SurfaceDimensionKind,
    baseKey: string,
    value: string,
  ): string => `${dimension}\u0000${baseKey}\u0000${value}`;

  for (const observation of input.observations ?? []) {
    if (!baseSet.has(observation.baseKey)) {
      unattributedObservations += 1;
      continue;
    }
    for (const [dimension, value] of [
      ['DEVICE', observation.viewport],
      ['LOCALE', observation.locale],
    ] as const) {
      const known = knownValues.get(dimension);
      if (known === undefined) continue;
      if (value === UNVARIED) {
        unvariedObservations += 1;
        continue;
      }
      if (!known.has(value)) {
        const key = `${dimension}\u0000${value}`;
        unknownCoordinateCounts.set(key, (unknownCoordinateCounts.get(key) ?? 0) + 1);
        continue;
      }
      const key = bucketKey(dimension, observation.baseKey, value);
      const bucket = observationsByCell.get(key);
      if (bucket) bucket.push(observation);
      else observationsByCell.set(key, [observation]);
    }
  }

  const cells: DeviceLocaleCell[] = [];
  const unmeasuredCounts = new Map<DimensionUnmeasuredReason, number>();
  const heldOutDetail = new Map<DimensionUnmeasuredReason, Map<string, number>>();

  for (const axis of axes) {
    for (const cell of axis.cells) {
      const identity = dimensionCellIdentity(cell.baseKey, [
        { dimension: axis.dimension, value: cell.value },
      ]);
      const observations = observationsByCell.get(
        bucketKey(axis.dimension, cell.baseKey, cell.value),
      ) ?? [];

      /*
       * Every recorded `notRunKind` takes the cell OUT of the denominator, and
       * `NOT_RUN_KINDS` is already on the record about why: BLOCKED_BY_ENV and
       * UNSUPPORTED must be excluded rather than scored as skips, because a
       * test that could not be attempted is not evidence about the application
       * in either direction and counting it is how a dead staging box moved a
       * coverage number. CANCELLED is nobody wanting the answer, and NOT_RUN is
       * the honest reading of a row nobody wrote to. A row whose reason was
       * never RECORDED stays in, because an unrecorded reason must not shed a
       * cell — the same direction `capabilityCounts` takes with NOT_CHECKED.
       */
      const attempted = observations.filter(
        (observation) => (observation.notRunKind ?? null) === null,
      );
      if (observations.length > 0 && attempted.length === 0) {
        const kinds = [...new Set(observations.map((observation) => observation.notRunKind))].join(
          ', ',
        );
        const detail =
          `every run of this cell recorded that it was not attempted (${kinds}), which is not ` +
          'evidence about the application in either direction';
        unmeasuredCounts.set('HELD_OUT', (unmeasuredCounts.get('HELD_OUT') ?? 0) + 1);
        const byDetail = heldOutDetail.get('HELD_OUT') ?? new Map<string, number>();
        byDetail.set(detail, (byDetail.get(detail) ?? 0) + 1);
        heldOutDetail.set('HELD_OUT', byDetail);
        cells.push({
          key: surfaceKey(DIMENSION_AXIS[axis.dimension], identity),
          identity,
          baseKey: cell.baseKey,
          dimension: axis.dimension,
          value: cell.value,
          atDefault: cell.atDefault,
          tier: null,
          tierCappedBy: null,
          lastConfirmedRunId: null,
          unmeasuredReason: 'HELD_OUT',
          unmeasuredDetail: detail,
          counted: false,
          observations: observations.length,
        });
        continue;
      }

      /*
       * The strongest rung any attempted run of this cell earned. MAX, not the
       * newest and not the worst: a cell that passed in one run and failed in
       * the next is covered either way, because covered and failing are two
       * facts and pass/fail is the run report's job rather than the
       * denominator's. The promotion itself is `promoteCoverageTier`'s — the one
       * place a rung is decided.
       */
      let tier: CoverageTier | null = null;
      let tierCappedBy: TierCapReason | null = null;
      let lastConfirmedRunId: string | null = null;
      for (const observation of attempted) {
        const verdict = promoteCoverageTier(
          {
            // RUNTIME, because a variant row IS a record of what a run did. It
            // is the only source whose ceiling permits a cell to reach PASSING,
            // which is this dimension's whole evidence rule.
            source: 'RUNTIME',
            navigationObserved: true,
            assertionObserved: observation.assertionObserved,
            runStatus: observation.status,
            retriedAndPassed: observation.retriedAndPassed === true,
            quarantined: false,
            confirmedAtIso: observation.observedAtIso,
          },
          input.nowIso,
          input.freshnessDays,
        );
        if (verdict.tier !== null && (tier === null || strongerTier(verdict.tier, tier))) {
          tier = verdict.tier;
          tierCappedBy = verdict.cappedBy;
          lastConfirmedRunId = observation.runId;
        }
      }

      cells.push({
        key: surfaceKey(DIMENSION_AXIS[axis.dimension], identity),
        identity,
        baseKey: cell.baseKey,
        dimension: axis.dimension,
        value: cell.value,
        atDefault: cell.atDefault,
        tier,
        tierCappedBy,
        lastConfirmedRunId: tier === null || tier === 'DECLARED' ? null : lastConfirmedRunId,
        unmeasuredReason: null,
        unmeasuredDetail: null,
        counted: true,
        observations: observations.length,
      });
    }
  }

  const counted = cells.filter((cell) => cell.counted);
  const unmeasured = dominantUnmeasuredReason(unmeasuredCounts);

  const heldOut: Array<{ reason: DimensionUnmeasuredReason; detail: string; cells: number }> = [];
  for (const reason of DIMENSION_UNMEASURED_REASONS) {
    const byDetail = heldOutDetail.get(reason);
    if (!byDetail) continue;
    for (const [detail, count] of byDetail) heldOut.push({ reason, detail, cells: count });
  }
  heldOut.sort((left, right) => right.cells - left.cells || left.detail.localeCompare(right.detail));

  const unknownCoordinates = [...unknownCoordinateCounts.entries()]
    .map(([key, observations]) => {
      const [dimension, value] = key.split('\u0000') as [
        Extract<SurfaceDimensionKind, 'DEVICE' | 'LOCALE'>,
        string,
      ];
      return { dimension, value, observations };
    })
    .sort(
      (left, right) =>
        right.observations - left.observations ||
        left.dimension.localeCompare(right.dimension) ||
        left.value.localeCompare(right.value),
    );

  return {
    measurement: measuredDimension({
      dimension: 'DEVICE_LOCALE',
      measuredCells: counted.map((cell) => cell.tier),
      unmeasured: unmeasured?.unmeasured ?? 0,
      unmeasuredReason: unmeasured?.reason ?? null,
      unmeasuredDetail: unmeasured?.detail ?? null,
      caps,
    }),
    cells,
    byDimension: axes.map((axis) => axis.denominator),
    declaredCells: summed.cells,
    crossProduct: summed.crossProduct,
    unvariedObservations,
    unknownCoordinates,
    unattributedObservations,
    heldOut,
    rule: `${summed.rule} The cross product across both axes would be ${summed.crossProduct}, which is reported and never divided by.`,
  };
}

// ─── 3. FLAG_COMBINATION: which of two applications the crawl saw ────────────

/** One flag at one variant. The customer's flag — see this file's header. */
export interface FlagAssignment {
  /** `SurfaceDimension.key` for a kind FLAG row, in the provider's spelling. */
  flag: string;
  /** One member of that flag's `variants`. */
  variant: string;
}

/**
 * The separator a combination key uses between assignments, and the one
 * character {@link flagCombinationKey} refuses inside a flag or a variant.
 *
 * `;` rather than `,`: a flag called `a,b` would otherwise join to the same
 * string as the pair (`a`, `b`) and two different combinations would share one
 * cell — the same injectivity argument `variantKeyOf` makes about `|`. `=` is
 * refused for the same reason, since it separates a flag from its variant.
 */
const COMBINATION_SEPARATOR = ';';

/**
 * THE IDENTITY OF ONE FLAG COMBINATION, as the single coordinate value a
 * FLAG cell carries.
 *
 * `dimensionCellIdentity` permits ONE coordinate per dimension — two FLAG
 * coordinates in one cell is two cells, and it throws — so a combination of
 * three flags has to be one value. This is that value, and it is a function for
 * the same reason `dimensionCellIdentity` is: several writers mint these (the
 * crawl's flag sweep, a provider import, a manual declaration) and a cell is
 * only diffable across runs if every one of them produces a byte-identical key.
 *
 *   checkout-v2=on;promo-banner=off
 *
 * Rules, all four tested:
 *
 *   1. Assignments are sorted by FLAG KEY, so the order a declarer happened to
 *      list them in cannot mint a second cell for one combination.
 *   2. Values keep their case, as everywhere else in this vocabulary.
 *   3. `;` and `=` are REFUSED inside a flag or a variant rather than escaped.
 *      Escaping would work; refusing is better, because a flag provider that
 *      genuinely has one in a key is a case nobody has seen and silently
 *      re-spelling their identity is worse than telling them.
 *   4. One assignment per flag. The same flag twice is not a combination, and
 *      this throws rather than keeping the last.
 */
export function flagCombinationKey(assignments: readonly FlagAssignment[]): string {
  if (assignments.length === 0) {
    throw new Error('a flag combination needs at least one assignment');
  }
  const seen = new Set<string>();
  for (const assignment of assignments) {
    if (assignment.flag.length === 0 || assignment.variant.length === 0) {
      throw new Error('a flag combination needs a flag and a variant, and neither may be empty');
    }
    for (const [label, value] of [
      ['flag', assignment.flag],
      ['variant', assignment.variant],
    ] as const) {
      if (value.includes(COMBINATION_SEPARATOR) || value.includes('=')) {
        throw new Error(
          `a ${label} may not contain "${COMBINATION_SEPARATOR}" or "=" — ${JSON.stringify(value)} ` +
            'would forge a second assignment and two combinations would share one cell',
        );
      }
    }
    if (seen.has(assignment.flag)) {
      throw new Error(
        `two assignments for ${assignment.flag} in one combination — that is two combinations, not one`,
      );
    }
    seen.add(assignment.flag);
  }
  return [...assignments]
    .sort((left, right) => left.flag.localeCompare(right.flag))
    .map((assignment) => `${assignment.flag}=${assignment.variant}`)
    .join(COMBINATION_SEPARATOR);
}

/** Splits a combination key back apart. Null when the string is not one of ours. */
export function parseFlagCombinationKey(key: string): FlagAssignment[] | null {
  if (key.length === 0) return null;
  const assignments: FlagAssignment[] = [];
  const seen = new Set<string>();
  for (const part of key.split(COMBINATION_SEPARATOR)) {
    const separator = part.indexOf('=');
    if (separator <= 0) return null;
    const flag = part.slice(0, separator);
    const variant = part.slice(separator + 1);
    if (variant.length === 0 || variant.includes('=')) return null;
    if (seen.has(flag)) return null;
    seen.add(flag);
    assignments.push({ flag, variant });
  }
  return assignments;
}

/**
 * One of the CUSTOMER's feature flags, from a `SurfaceDimension` row of kind
 * FLAG and its `DimensionDetail`.
 */
export interface CustomerFlag {
  /** `SurfaceDimension.key`. */
  key: string;
  /** Every value this flag can take. `['on','off']` for a boolean flag. */
  variants: readonly string[];
  /** The variant served when nothing overrides it. Null when unknown. */
  defaultVariant?: string | null;
}

/**
 * A combination the crawl OBSERVED, or the customer DECLARED, for one item.
 *
 * The only thing that puts a combination in the denominator. The space is
 * exponential and every unobserved point in it is a guess, so the denominator
 * is what somebody actually asserted and the remainder is reported as a count.
 */
export interface FlagCombinationDeclaration {
  baseKey: string;
  assignments: readonly FlagAssignment[];
  source: SurfaceSource;
  evidence: string;
  /**
   * Whether a run was OBSERVED in this combination, as against a declaration
   * that it is reachable. A declaration is a claim; only an observation is
   * evidence, and the two are counted separately for the same reason
   * `SurfaceOrigin` distinguishes SOURCE_ONLY from CRAWL_ONLY.
   */
  observed: boolean;
}

/** One (base × combination) cell, measured. */
export interface FlagCombinationCell {
  /** `surfaceKey('FLAG_COMBINATION', dimensionCellIdentity(base, [FLAG=combo]))`. */
  key: string;
  identity: string;
  baseKey: string;
  /** {@link flagCombinationKey} of the assignments. */
  combination: string;
  assignments: readonly FlagAssignment[];
  source: SurfaceSource;
  evidence: string;
  observed: boolean;
  tier: CoverageTier | null;
  tierCappedBy: TierCapReason | null;
  lastConfirmedRunId: string | null;
  unmeasuredReason: DimensionUnmeasuredReason | null;
  unmeasuredDetail: string | null;
  counted: boolean;
}

/**
 * How large a combination space this module will put a NUMBER on.
 *
 * A million, and the ceiling is a judgement with a reason: twenty boolean flags
 * is 1,048,576 and the figure has already stopped being a quantity a reader can
 * use — it is "effectively unbounded", and the honest way to print that is to
 * print nothing and say the cap bit. A CONSTANT rather than a column, for the
 * same reason as `MINIMUM_BACKTEST_DEFECTS`: a ceiling a customer can raise is
 * one that gets raised until the number means nothing, and the one place it is
 * applied reports the value it used.
 */
export const MAX_REPORTED_COMBINATION_SPACE = 1_000_000;

export interface FlagCombinationMatrix {
  measurement: DimensionMeasurement;
  cells: readonly FlagCombinationCell[];
  /** Distinct (base, combination) cells in the denominator plus those held out. */
  declaredCombinations: number;
  /** Of those, the ones a run was observed in rather than merely declared. */
  observedCombinations: number;
  /**
   * The assignments that are POSSIBLE over the flags each base is known to be
   * touched by, summed across bases. NULL when it exceeded
   * {@link MAX_REPORTED_COMBINATION_SPACE}, with the cap on `caps`.
   *
   * Over the flags OBSERVED ON THAT BASE and not over every flag in the
   * project, because a flag nothing says touches /pricing has not been shown to
   * change /pricing and multiplying it in would be the cross product's lie with
   * one more step. It is reported and NEVER divided by.
   */
  combinationSpace: number | null;
  /**
   * `combinationSpace - declaredCombinations`. NULL when the space is null.
   *
   * The sentence this dimension exists to produce: "the crawl saw 12 of at
   * least 96 reachable configurations of these routes, so the denominator is
   * about the 12". A percentage over the space would be the cross-product
   * percentage this module refuses to compute.
   */
  unobservedRemainder: number | null;
  /** Declarations refused, with the reason. Never counted into anything. */
  refused: ReadonlyArray<{ baseKey: string; why: string }>;
  heldOut: ReadonlyArray<{ reason: DimensionUnmeasuredReason; detail: string; cells: number }>;
  /** Every cap that BIT, including this module's own combination-space ceiling. */
  caps: readonly DimensionCapBite[];
  rule: string;
}

/**
 * Evidence that a run exercised one flag combination of one item.
 *
 * Deliberately NOT a `TestResultVariant`: the variant matrix has five
 * dimensions and a flag is none of them, so a flag cell's evidence is the
 * caller's attribution of a run to a combination. Shaped like the device
 * evidence so the two read the same way, and `assertionObserved` carries the
 * same required-with-no-default contract for the same reason.
 */
export interface FlagCombinationObservation {
  baseKey: string;
  /** {@link flagCombinationKey} of the assignments the run ran under. */
  combination: string;
  runId: string;
  status: TestResultStatus;
  assertionObserved: boolean;
  retriedAndPassed?: boolean;
  notRunKind?: NotRunKind | null;
  observedAtIso: string;
}

/**
 * THE FLAG-COMBINATION MATRIX.
 *
 * ── WHY THERE IS NO CROSS-PRODUCT PERCENTAGE HERE ───────────────────────────
 *
 * A flag that changes a page means the crawl saw ONE OF TWO APPLICATIONS, and
 * the denominator cannot say which — that is the defect. The fix is NOT to
 * divide by every configuration: twenty boolean flags is a million
 * applications, 12/1,048,576 is 0.0%, and a number that is 0.0% for every
 * customer with flags measures nothing and would move only when somebody added
 * a flag. The fix is to count the configurations somebody actually asserted,
 * report how many more are reachable, and name the cap that stopped the sweep.
 * Three numbers, none derivable from the others, and no percentage over any of
 * the last two.
 */
export function buildFlagCombinationMatrix(input: {
  baseKeys: readonly string[];
  flags: readonly CustomerFlag[];
  declarations?: readonly FlagCombinationDeclaration[];
  observations?: readonly FlagCombinationObservation[];
  nowIso: string;
  freshnessDays?: number;
  caps?: readonly DimensionCapBite[];
}): FlagCombinationMatrix {
  const caps = [...(input.caps ?? [])];
  const baseSet = new Set(input.baseKeys);
  const flagsByKey = new Map<string, CustomerFlag>();
  for (const flag of input.flags) flagsByKey.set(flag.key, flag);

  if (flagsByKey.size === 0) {
    /*
     * No FLAG rows is not "this application has no flags". A project whose
     * provider was never read holds no rows either, and the two are
     * indistinguishable from here — so the axis is named as not enumerated.
     * This is also the branch that keeps QAAI's own FeatureFlag table out of
     * the picture: the flags this module measures arrive as an argument, and
     * there is nothing it could fall back to.
     */
    const detail =
      'this project holds no feature-flag rows, so which configurations of the application exist ' +
      'was never enumerated — the crawl may have seen one of several applications and nothing ' +
      'here can say which';
    return {
      measurement: notEnumerated('FLAG_COMBINATION', detail, caps),
      cells: [],
      declaredCombinations: 0,
      observedCombinations: 0,
      combinationSpace: null,
      unobservedRemainder: null,
      refused: [],
      heldOut: [],
      caps,
      rule: detail,
    };
  }

  const cells: FlagCombinationCell[] = [];
  const refused: Array<{ baseKey: string; why: string }> = [];
  const unmeasuredCounts = new Map<DimensionUnmeasuredReason, number>();
  const heldOutDetail = new Map<DimensionUnmeasuredReason, Map<string, number>>();
  /** base → the flags any declaration says touch it. The space's own factors. */
  const flagsPerBase = new Map<string, Set<string>>();
  const seen = new Set<string>();

  const observationsByCell = new Map<string, FlagCombinationObservation[]>();
  for (const observation of input.observations ?? []) {
    const key = `${observation.baseKey}\u0000${observation.combination}`;
    const bucket = observationsByCell.get(key);
    if (bucket) bucket.push(observation);
    else observationsByCell.set(key, [observation]);
  }

  for (const declaration of input.declarations ?? []) {
    if (!baseSet.has(declaration.baseKey)) {
      refused.push({
        baseKey: declaration.baseKey,
        why: 'this base is not in the inventory, so the combination refines nothing',
      });
      continue;
    }
    /*
     * An assignment naming a flag no row holds, or a variant the flag does not
     * declare, is a DANGLING REFERENCE IN OUR OWN EXTRACTOR. Counting it would
     * inflate the denominator with a cell nothing can ever be observed in and
     * would hide our error rate inside the customer's percentage — the same
     * judgement `dimensionDenominator.undeclaredValues` already makes.
     */
    const dangling = declaration.assignments.find((assignment) => {
      const flag = flagsByKey.get(assignment.flag);
      return flag === undefined || !flag.variants.includes(assignment.variant);
    });
    if (dangling !== undefined) {
      refused.push({
        baseKey: declaration.baseKey,
        why: flagsByKey.has(dangling.flag)
          ? `flag ${dangling.flag} does not declare the variant ${dangling.variant}`
          : `no flag row is held for ${dangling.flag}`,
      });
      continue;
    }

    let combination: string;
    try {
      combination = flagCombinationKey(declaration.assignments);
    } catch (error) {
      // A malformed declaration is a writer's bug and is REFUSED rather than
      // thrown on: these arrive from a stored table and one bad row must not
      // take the whole matrix down with it.
      refused.push({
        baseKey: declaration.baseKey,
        why: error instanceof Error ? error.message : 'the combination key could not be built',
      });
      continue;
    }

    const cellKey = `${declaration.baseKey}\u0000${combination}`;
    if (seen.has(cellKey)) continue;
    seen.add(cellKey);

    const factors = flagsPerBase.get(declaration.baseKey) ?? new Set<string>();
    for (const assignment of declaration.assignments) factors.add(assignment.flag);
    flagsPerBase.set(declaration.baseKey, factors);

    const identity = dimensionCellIdentity(declaration.baseKey, [
      { dimension: 'FLAG', value: combination },
    ]);
    const observations = observationsByCell.get(cellKey) ?? [];
    const attempted = observations.filter(
      (observation) => (observation.notRunKind ?? null) === null,
    );

    if (observations.length > 0 && attempted.length === 0) {
      const kinds = [...new Set(observations.map((observation) => observation.notRunKind))].join(
        ', ',
      );
      const detail =
        `every run of this combination recorded that it was not attempted (${kinds}), which is ` +
        'not evidence about the application in either direction';
      unmeasuredCounts.set('HELD_OUT', (unmeasuredCounts.get('HELD_OUT') ?? 0) + 1);
      const byDetail = heldOutDetail.get('HELD_OUT') ?? new Map<string, number>();
      byDetail.set(detail, (byDetail.get(detail) ?? 0) + 1);
      heldOutDetail.set('HELD_OUT', byDetail);
      cells.push({
        key: surfaceKey('FLAG_COMBINATION', identity),
        identity,
        baseKey: declaration.baseKey,
        combination,
        assignments: [...declaration.assignments],
        source: declaration.source,
        evidence: declaration.evidence,
        observed: declaration.observed,
        tier: null,
        tierCappedBy: null,
        lastConfirmedRunId: null,
        unmeasuredReason: 'HELD_OUT',
        unmeasuredDetail: detail,
        counted: false,
      });
      continue;
    }

    let tier: CoverageTier | null = null;
    let tierCappedBy: TierCapReason | null = null;
    let lastConfirmedRunId: string | null = null;
    for (const observation of attempted) {
      const verdict = promoteCoverageTier(
        {
          source: 'RUNTIME',
          navigationObserved: true,
          assertionObserved: observation.assertionObserved,
          runStatus: observation.status,
          retriedAndPassed: observation.retriedAndPassed === true,
          quarantined: false,
          confirmedAtIso: observation.observedAtIso,
        },
        input.nowIso,
        input.freshnessDays,
      );
      if (verdict.tier !== null && (tier === null || strongerTier(verdict.tier, tier))) {
        tier = verdict.tier;
        tierCappedBy = verdict.cappedBy;
        lastConfirmedRunId = observation.runId;
      }
    }

    cells.push({
      key: surfaceKey('FLAG_COMBINATION', identity),
      identity,
      baseKey: declaration.baseKey,
      combination,
      assignments: [...declaration.assignments],
      source: declaration.source,
      evidence: declaration.evidence,
      observed: declaration.observed,
      tier,
      tierCappedBy,
      lastConfirmedRunId: tier === null || tier === 'DECLARED' ? null : lastConfirmedRunId,
      unmeasuredReason: null,
      unmeasuredDetail: null,
      counted: true,
    });
  }

  // The space, over the flags each base is KNOWN to be touched by. Capped,
  // disclosed, and null rather than a number when the cap bit.
  let combinationSpace: number | null = 0;
  for (const factors of flagsPerBase.values()) {
    let product = 1;
    for (const flag of factors) {
      product *= Math.max(flagsByKey.get(flag)?.variants.length ?? 1, 1);
      if (product > MAX_REPORTED_COMBINATION_SPACE) break;
    }
    combinationSpace += product;
    if (combinationSpace > MAX_REPORTED_COMBINATION_SPACE) {
      combinationSpace = null;
      caps.push({
        cap: 'MAX_REPORTED_COMBINATION_SPACE',
        limit: MAX_REPORTED_COMBINATION_SPACE,
        /*
         * NULL, not the partial product. A cap that bit does not always know
         * how much it hid, and the product so far is a LOWER bound on a figure
         * we are declining to print — reporting it as "at least this many more"
         * would put a precise-looking number on an estimate we stopped
         * computing. See `DimensionCapBite.atLeastMore`.
         */
        atLeastMore: null,
        detail:
          `the reachable configuration space of these items exceeds ` +
          `${MAX_REPORTED_COMBINATION_SPACE.toLocaleString('en-US')}, so it is reported as ` +
          'unbounded rather than as a number — it was never a denominator in any case',
      });
      break;
    }
  }

  const counted = cells.filter((cell) => cell.counted);
  const unmeasured = dominantUnmeasuredReason(unmeasuredCounts);

  const heldOut: Array<{ reason: DimensionUnmeasuredReason; detail: string; cells: number }> = [];
  for (const reason of DIMENSION_UNMEASURED_REASONS) {
    const byDetail = heldOutDetail.get(reason);
    if (!byDetail) continue;
    for (const [detail, count] of byDetail) heldOut.push({ reason, detail, cells: count });
  }
  heldOut.sort((left, right) => right.cells - left.cells || left.detail.localeCompare(right.detail));

  const observedCombinations = cells.filter((cell) => cell.observed).length;
  const unobservedRemainder =
    combinationSpace === null ? null : Math.max(combinationSpace - cells.length, 0);

  const measurement =
    cells.length === 0
      ? /*
         * Flags exist and NOTHING declared a combination for any item. That is
         * not an empty denominator we understand — it means the crawl never
         * recorded which configuration it was looking at, so every page in the
         * inventory may be one of several. NOT_ENUMERATED, with the sentence
         * that says so.
         */
        notEnumerated(
          'FLAG_COMBINATION',
          `${flagsByKey.size} flag(s) exist and no combination was declared or observed for any ` +
            'item, so which configuration of the application the crawl measured is unknown',
          caps,
        )
      : measuredDimension({
          dimension: 'FLAG_COMBINATION',
          measuredCells: counted.map((cell) => cell.tier),
          unmeasured: unmeasured?.unmeasured ?? 0,
          unmeasuredReason: unmeasured?.reason ?? null,
          unmeasuredDetail: unmeasured?.detail ?? null,
          caps,
        });

  return {
    measurement,
    cells,
    declaredCombinations: cells.length,
    observedCombinations,
    combinationSpace,
    unobservedRemainder,
    refused,
    heldOut,
    caps,
    rule:
      `${cells.length} declared combination(s), ${observedCombinations} of them observed by a run; ` +
      `the reachable space over the flags these items are known to be touched by is ` +
      `${combinationSpace === null ? 'larger than this module will put a number on' : combinationSpace}, ` +
      `leaving ${unobservedRemainder === null ? 'an unbounded number of' : unobservedRemainder} ` +
      'configuration(s) nobody has looked at. That space is never a denominator.',
  };
}

// ─── The three together, and deliberately not added up ───────────────────────

/**
 * The three matrix dimensions, side by side.
 *
 * THERE IS NO `percent` ON THIS OBJECT AND THERE MUST NOT BE ONE. Each
 * dimension's figure is read off its own ladder with `dimensionPercentAt`,
 * against its own denominator. A type obligation, a device cell and a flag
 * combination are three populations with nothing in common but the application
 * they are about, and one fraction over the three of them would be the
 * four-summed-denominators defect with a new set of axes — the arithmetic that
 * made controls roughly 80% of this product's first headline.
 */
export interface CoverageMatrix {
  testType: TypeObligationMatrix;
  deviceLocale: DeviceLocaleMatrix;
  flagCombination: FlagCombinationMatrix;
  /** The sentence that says why there is no fourth number here. */
  rule: string;
}

export function buildCoverageMatrix(input: {
  testType: Parameters<typeof buildTypeObligationMatrix>[0];
  deviceLocale: Parameters<typeof buildDeviceLocaleMatrix>[0];
  flagCombination: Parameters<typeof buildFlagCombinationMatrix>[0];
}): CoverageMatrix {
  return {
    testType: buildTypeObligationMatrix(input.testType),
    deviceLocale: buildDeviceLocaleMatrix(input.deviceLocale),
    flagCombination: buildFlagCombinationMatrix(input.flagCombination),
    rule:
      'three dimensions, three denominators, never summed: a type obligation, a device or locale ' +
      'cell and a flag combination are three different things to test. Every figure comes off one ' +
      "measurement's own ladder, and an axis with nothing enumerated reports null rather than 0%.",
  };
}
