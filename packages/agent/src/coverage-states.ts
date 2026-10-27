/**
 * Page states, error states and data variants — the three dimensions that were
 * folded into one route entry.
 *
 * WHY THIS FILE EXISTS
 *
 * `coverage.ts` reports one entry per route, with every state of that route
 * folded into it "because coverage is a property of the route". It is not. A
 * route has an empty state, a loading state, a 403 for the wrong role, a
 * not-found state for a dead id and a pagination boundary, and each of those is
 * a separate thing a test either drives or does not. Folded into one slot they
 * are not UNCOVERED — they are INVISIBLE, and the difference is the whole
 * product: invisible raises the percentage, uncovered lowers it.
 *
 * So this module reads what the crawl already recorded — the node status, the
 * structural verdict, the interstitial finding, the bounce ledger, the access
 * matrix, the error probes and the declared data profiles — and turns it into
 * cells with their own identities, their own tiers and their own denominators.
 *
 * ── THREE DIMENSIONS, THREE DENOMINATORS, NEVER SUMMED ──────────────────────
 *
 * A route's empty state, its 403 and its pagination boundary are three things
 * to test, and {@link StateDimensionReport} therefore holds three
 * `DimensionMeasurement`s and NO combined figure. There is no function here
 * that takes two of them and returns one percentage; `dimensionPercentAt` in
 * @qaai/shared reads one measurement at a time against its own denominator.
 * This product has already shipped a headline that added routes + journeys +
 * forms + controls into one fraction, which made controls roughly 80% of the
 * figure. Three more chances to do it again is three more than zero.
 *
 * ── WHAT IS NOT MEASURED IS NAMED, NEVER ZEROED ─────────────────────────────
 *
 * Four different things stop a cell being measured and this module keeps them
 * apart, because they are four findings with four remedies:
 *
 *   NOT_ENUMERATED             nobody recorded this item's states at all, or an
 *                              interstitial blocked the enumeration. The
 *                              DENOMINATOR is unknown, not the numerator.
 *   EXTRACTOR_RETURNED_UNKNOWN a state exists and this build's cell vocabulary
 *                              has no member for it — a 405, a PARTIAL render,
 *                              a trial-expired fixture. OUR hole, named.
 *   HELD_OUT                   the crawl REFUSED to reach it, or it is
 *                              UNEXERCISABLE here. Counted, named, not scored.
 *   CAP_BIT                    a budget stopped the enumeration short, reported
 *                              with the cap's own count.
 *
 * `DimensionMeasurement` has ONE `unmeasuredReason` field, so a dimension that
 * hit several gets the dominant one there and the full breakdown in the detail
 * AND in {@link StateDimensionReport.unmeasuredBreakdown}. The single field
 * never hides the others — see {@link combineUnmeasured}.
 *
 * ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────
 *
 * It reads nothing and drives nothing. Every input is a narrow record the
 * caller already holds — `StateNodeFact` is not a `FlowNode`, `ProbeStateFact`
 * is not a `ProbeResult` — so the whole module is exercised with plain objects
 * and no browser, no database and no clock: `nowIso` is an argument for the
 * same reason `promoteCoverageTier` takes one. The one cell-key format is
 * `dimensionCellIdentity` in surface.ts and this module calls it rather than
 * spelling a second one, because two formats make two dimensions silently
 * uncomparable.
 */

import {
  CELL_KIND_DIMENSION,
  COVERAGE_DIMENSION_DESCRIPTORS,
  COVERAGE_TIER_RANK,
  DEFAULT_COVERAGE_FRESHNESS_DAYS,
  DIMENSION_UNMEASURED_REASONS,
  dimensionCellIdentity,
  exercisabilityCounts,
  isObservedSource,
  measuredDimension,
  parseDimensionCellIdentity,
  promoteCoverageTier,
  resolveCoverageEdges,
  statusClassFor,
  type CoverageCellKind,
  type CoverageDimensionKind,
  type CoverageEdgeSource,
  type CoverageTier,
  type CoverageTierVerdict,
  type DimensionCapBite,
  type DimensionCoordinate,
  type DimensionMeasurement,
  type DimensionUnmeasuredReason,
  type NodeStatus,
  type RouteAccessBasis,
  type RouteAccessOutcome,
  type SurfaceExercise,
  type SurfaceKind,
  type SurfaceSource,
  type TestResultStatus,
  type TierCapReason,
} from '@qaai/shared';
import type {
  BounceKind,
  InterstitialFinding,
  InterstitialKind,
  ProbeKind,
  ProbeVerdict,
  StructuralState,
  StructuralVerdict,
} from './crawl/observe.js';
import type { DataProfileKind, FaultState, VariantOutcome } from './crawl/variants.js';

// ─── The three axes this module owns ────────────────────────────────────────

/**
 * The dimensions measured here, as a subtype of the keystone's union.
 *
 * `Extract` rather than three string literals, so a rename in
 * `COVERAGE_DIMENSIONS` breaks this line instead of producing a module that
 * measures an axis the vocabulary no longer has.
 */
export type StateDimensionKind = Extract<
  CoverageDimensionKind,
  'PAGE_STATE' | 'ERROR_STATE' | 'DATA_VARIANT'
>;

/** The compile-time presence half; coverage-states.test.ts holds the other. */
const STATE_DIMENSION_PRESENT: Record<StateDimensionKind, true> = {
  PAGE_STATE: true,
  ERROR_STATE: true,
  DATA_VARIANT: true,
};

export const STATE_DIMENSIONS = Object.keys(
  STATE_DIMENSION_PRESENT,
) as readonly StateDimensionKind[];

/** Whether a dimension is one of the three this module measures. */
export function isStateDimension(
  dimension: CoverageDimensionKind,
): dimension is StateDimensionKind {
  return dimension in STATE_DIMENSION_PRESENT;
}

/**
 * The sentence printed where a combined percentage would otherwise go.
 *
 * Exported because the report has to be able to say it, and a report that
 * cannot explain why there is no single "state coverage" number is a report
 * whose reader invents one by averaging the three.
 */
export const NEVER_SUMMED_RULE =
  'page states, error states and data variants are three denominators and are never summed: ' +
  "a route's empty state, its 403 and its pagination boundary are three things to test, and " +
  'one blended figure over them would be the four-summed-denominators defect rebuilt below the item';

// ─── 1. The cell key ────────────────────────────────────────────────────────

/**
 * How a state's identity is spelled, and why the state goes in the BASE.
 *
 * `dimensionCellIdentity(base, coordinates)` is the one format in this repo,
 * and its coordinates are `SURFACE_DIMENSION_KINDS` — ROLE, LOCALE, DEVICE,
 * FLAG, JOB, EMAIL. A page state is not one of those: it is not a value
 * enumerable independently of the page, it IS the page in a condition. So the
 * state discriminator is folded into the BASE, which the format percent-encodes
 * for us, and any genuine role or device coordinate still travels as a
 * coordinate:
 *
 *   /orders#PAGE_EMPTY
 *   /orders#PAGE_INTERSTITIAL:CONSENT_WALL
 *   /admin/billing#ERROR_FORBIDDEN|ROLE=VIEWER
 *
 * `#` is the separator because route templates cannot contain one — every
 * normaliser in this repo strips the fragment (`raw.split('#')[0]`) — and
 * because `route#stateKey` is already the crawl's own spelling for a node
 * identity. It is also why {@link parseStateCellKey} splits on the LAST `#`:
 * the kind and the qualifier are guaranteed free of it (the qualifier is
 * refused if it carries one), so the last occurrence is the separator even if
 * some future item key is not a route and does carry one.
 */
export const STATE_CELL_SEPARATOR = '#';

/** Separates the cell kind from its qualifier inside the base. */
export const STATE_CELL_QUALIFIER_SEPARATOR = ':';

export interface StateCellKeyInput {
  /** `CoverageItem.key`, exactly as the inventory spells it. */
  itemKey: string;
  kind: CoverageCellKind;
  /**
   * What distinguishes two cells of the SAME kind on the same item: which
   * interstitial, which data profile. Null when the kind is the whole identity.
   *
   * It must never carry evidence that can change between crawls — the
   * structural verdict's `basis`, for instance. `structuralStateKeyPart` in
   * observe.ts deliberately includes the basis because it is comparing two
   * readings of one node; a key that did so would RETIRE a cell and mint a new
   * one the first time an empty state was decided on a strong signal instead of
   * a weak one, and every diff across that crawl would report a state that
   * appeared and a state that vanished.
   */
  qualifier?: string | null;
  /** Genuine dimension coordinates, when the state is role- or device-bound. */
  coordinates?: readonly DimensionCoordinate[];
}

export interface ParsedStateCell {
  itemKey: string;
  kind: CoverageCellKind;
  qualifier: string | null;
  coordinates: DimensionCoordinate[];
}

/** Builds one state's `stateKey`. Throws rather than minting an ambiguous key. */
export function stateCellKey(input: StateCellKeyInput): string {
  const qualifier = input.qualifier ?? null;
  if (qualifier !== null) {
    if (qualifier.length === 0) {
      throw new Error(
        'an empty qualifier is not a qualifier — pass null when the kind is the whole identity',
      );
    }
    if (qualifier.includes(STATE_CELL_SEPARATOR)) {
      throw new Error(
        `a state qualifier may not contain ${STATE_CELL_SEPARATOR} — it is the separator, and a ` +
          'qualifier carrying one makes the key unparseable in both directions',
      );
    }
  }
  const base = `${input.itemKey}${STATE_CELL_SEPARATOR}${input.kind}${
    qualifier === null ? '' : `${STATE_CELL_QUALIFIER_SEPARATOR}${qualifier}`
  }`;
  return dimensionCellIdentity(base, input.coordinates ?? []);
}

/** Splits a state key back apart. Null when the string is not one of ours. */
export function parseStateCellKey(stateKey: string): ParsedStateCell | null {
  const parsed = parseDimensionCellIdentity(stateKey);
  if (!parsed) return null;

  const cut = parsed.base.lastIndexOf(STATE_CELL_SEPARATOR);
  if (cut <= 0) return null;
  const itemKey = parsed.base.slice(0, cut);
  const suffix = parsed.base.slice(cut + 1);
  if (itemKey.length === 0 || suffix.length === 0) return null;

  const split = suffix.indexOf(STATE_CELL_QUALIFIER_SEPARATOR);
  const kind = (split < 0 ? suffix : suffix.slice(0, split)) as CoverageCellKind;
  // A kind the vocabulary does not hold is not a cell key of ours, however much
  // it looks like one. Returning it would hand a caller a `CoverageCellKind`
  // that no `Record` keyed on the union can answer for.
  if (!(kind in CELL_KIND_DIMENSION)) return null;
  const qualifier = split < 0 ? null : suffix.slice(split + 1);
  if (qualifier !== null && qualifier.length === 0) return null;

  return { itemKey, kind, qualifier, coordinates: parsed.coordinates };
}

// ─── 2. What one signal resolves to ─────────────────────────────────────────

/**
 * THE THREE ANSWERS A SIGNAL CAN GIVE, and why there are three rather than two.
 *
 * A boolean "did this produce a cell" collapses the two cases that matter:
 *
 *   UNNAMEABLE  we LEARNED that a state exists and cannot name it, because
 *               `COVERAGE_CELL_KINDS` has no member for a 405, a PARTIAL render
 *               or a quota-exceeded fixture. That is one unmeasured cell with
 *               `EXTRACTOR_RETURNED_UNKNOWN` — a hole in OUR vocabulary, which
 *               must never read as a gap in the customer's testing and must
 *               never be silently dropped either.
 *   NOTHING     nothing was learned, or we looked and there is genuinely no
 *               state here. `enumerated` tells those two apart: a probe that
 *               came back ACCEPTED_BAD_INPUT means we ASKED and this route has
 *               no not-found state to test, which is enumeration with zero
 *               cells; a probe that could not be issued is not enumeration at
 *               all, and reading the second as the first would let a crawl that
 *               never ran report a complete error-state inventory.
 */
export type StateResolution =
  | { kind: 'CELL'; cell: CoverageCellKind; qualifier: string | null; why: string }
  | { kind: 'UNNAMEABLE'; dimension: StateDimensionKind; why: string }
  | { kind: 'NOTHING'; enumerated: boolean; why: string };

/**
 * The one reason an UNNAMEABLE cell carries.
 *
 * `EXTRACTOR_RETURNED_UNKNOWN` and not `NO_EXTRACTOR`, and the distinction is
 * the keystone's: all three of these axes HAVE an extractor in this build —
 * this very module — so claiming otherwise would understate what we measure.
 * What happened is narrower and is exactly what that member says: the extractor
 * ran and could not decide, because the cell vocabulary has no member for what
 * it saw.
 */
export const UNNAMEABLE_CELL_REASON: DimensionUnmeasuredReason = 'EXTRACTOR_RETURNED_UNKNOWN';

function cell(
  kind: CoverageCellKind,
  why: string,
  qualifier: string | null = null,
): StateResolution {
  return { kind: 'CELL', cell: kind, qualifier, why };
}

function unnameable(dimension: StateDimensionKind, why: string): StateResolution {
  return { kind: 'UNNAMEABLE', dimension, why };
}

function nothing(enumerated: boolean, why: string): StateResolution {
  return { kind: 'NOTHING', enumerated, why };
}

// ─── 3. The vocabulary bridges ──────────────────────────────────────────────

/**
 * WHICH ERROR CELL A STATUS CODE IS.
 *
 * Exact codes and not classes, because the classes are not the cells: 401 and
 * 403 are two different tests and `CLIENT_ERROR` is neither. Four codes have no
 * member in `COVERAGE_CELL_KINDS` — 405, 409, 415, 429 among them — and they
 * return null, which the callers turn into an UNNAMEABLE cell rather than
 * dropping. 410 Gone is folded onto ERROR_NOT_FOUND because the state a test
 * drives is identical: ask for a thing that is not there and assert what comes
 * back.
 *
 * A 2xx or 3xx is not an error state and returns null with no shortfall — see
 * the callers, which pass `enumerated: true` for it.
 */
export function errorCellForStatus(code: number | null | undefined): CoverageCellKind | null {
  if (code === null || code === undefined || !Number.isFinite(code)) return null;
  if (code === 401) return 'ERROR_UNAUTHENTICATED';
  if (code === 403) return 'ERROR_FORBIDDEN';
  if (code === 404 || code === 410) return 'ERROR_NOT_FOUND';
  if (code === 400 || code === 422) return 'ERROR_VALIDATION';
  if (statusClassFor(code) === 'SERVER_ERROR') return 'ERROR_SERVER';
  return null;
}

/**
 * The structural verdict, as a page-state cell.
 *
 * ERROR is null HERE and not a mistake: an error PAGE is an ERROR_STATE cell
 * and WHICH one depends on the status, which this table cannot see. Deciding it
 * here would be guessing between a 403 and a 500 from the presence of a
 * `role="alert"`. {@link pageStatesOfNode} pairs the verdict with the status
 * instead.
 *
 * UNKNOWN is null for the opposite reason — nothing was decided — and the two
 * nulls are told apart by the caller, which reads `basis`: a verdict that rests
 * on NO signal means the structural read did not run (NOT_ENUMERATED), while
 * UNKNOWN with signals means the read ran and could not decide
 * (EXTRACTOR_RETURNED_UNKNOWN).
 */
export const STRUCTURAL_STATE_CELL: Record<StructuralState, CoverageCellKind | null> = {
  LOADING: 'PAGE_LOADING',
  EMPTY: 'PAGE_EMPTY',
  POPULATED: 'PAGE_DEFAULT',
  ERROR: null,
  UNKNOWN: null,
};

/**
 * The interstitial finding, as a cell.
 *
 * ── Why three of the seven are null ────────────────────────────────────────
 *
 * BOT_CHALLENGE and MAINTENANCE are facts about OUR access to the whole
 * deployment, not states of this route. A site-wide bot wall would otherwise
 * mint one PAGE_INTERSTITIAL cell per route — hundreds of fabricated cells, all
 * of them the same finding, and a denominator inflated by our own blocked
 * afternoon. They are reported through {@link StateDimensionReport.notEnumerated}
 * instead, which is where "we could not see this application" belongs.
 *
 * LOGIN_WALL is ERROR_UNAUTHENTICATED rather than PAGE_INTERSTITIAL: being sent
 * to a sign-in surface IS the route's unauthenticated state, and it is the one a
 * test asserts. CONSENT_WALL, AGE_GATE and GEO_BLOCK are the application's own
 * gates standing in front of the route, which is what PAGE_INTERSTITIAL names.
 */
export const INTERSTITIAL_CELL: Record<InterstitialKind, CoverageCellKind | null> = {
  NONE: null,
  BOT_CHALLENGE: null,
  MAINTENANCE: null,
  CONSENT_WALL: 'PAGE_INTERSTITIAL',
  AGE_GATE: 'PAGE_INTERSTITIAL',
  GEO_BLOCK: 'PAGE_INTERSTITIAL',
  LOGIN_WALL: 'ERROR_UNAUTHENTICATED',
};

/**
 * The bounce ledger, as a cell.
 *
 * NONE is null because the route was served — its served state comes from the
 * structural read, and minting a second cell here would count one state twice.
 * ERROR_STATUS is null because the status is the fact and
 * {@link errorCellForStatus} is where it is read; `kind` alone cannot say which
 * error. SOFT_NAVIGATION is PAGE_REDIRECTED: a client-side route guard that
 * changes the URL with no response has redirected the user, and a test drives
 * it exactly as it drives a server redirect.
 */
export const BOUNCE_CELL: Record<BounceKind, CoverageCellKind | null> = {
  NONE: null,
  SAME_ORIGIN_REDIRECT: 'PAGE_REDIRECTED',
  OFF_ORIGIN: 'PAGE_REDIRECTED',
  SOFT_NAVIGATION: 'PAGE_REDIRECTED',
  AUTH_WALL: 'ERROR_UNAUTHENTICATED',
  ERROR_STATUS: null,
};

/**
 * An access-matrix outcome, as a cell.
 *
 * ── ALLOWED IS NULL, AND THAT IS THE ANTI-DOUBLE-COUNTING RULE ─────────────
 *
 * A role being served the route is a ROLE_CELL measurement — `route × role` is
 * that dimension's denominator and `DIMENSION_AXIS.ROLE` is its axis. Minting
 * an ERROR_STATE cell for it would put the same fact on two denominators.
 *
 * The same reasoning decides something less obvious, which is why it is written
 * down: the error cells this table produces carry NO role coordinate. A route
 * has ONE forbidden state however many roles were refused it — the access
 * matrix is the EVIDENCE that the state exists, and the role-by-role breakdown
 * is ROLE_CELL's business. One cell per role here would rebuild `route × role`
 * inside ERROR_STATE and the two axes would double-count every refusal.
 *
 * ERRORED and NOT_PROBED are null with nothing learned. Recording ERRORED as
 * FORBIDDEN would manufacture a security finding out of a flaky box, which is
 * the sentence `MEASURED_ROUTE_ACCESS_OUTCOMES` already exists to enforce.
 */
export const ACCESS_OUTCOME_CELL: Record<RouteAccessOutcome, CoverageCellKind | null> = {
  ALLOWED: null,
  FORBIDDEN: 'ERROR_FORBIDDEN',
  REDIRECTED_TO_LOGIN: 'ERROR_UNAUTHENTICATED',
  REDIRECTED_ELSEWHERE: 'PAGE_REDIRECTED',
  NOT_FOUND: 'ERROR_NOT_FOUND',
  ERRORED: null,
  NOT_PROBED: null,
};

/**
 * Whether a probe verdict is a measurement of an error state at all.
 *
 * SOFT_ERROR counts, and it is the reason this is a `Record` rather than a
 * status read: a 200 with an error page is the case that fools every other
 * tool, and the state is real even though the status denies it. The probe's own
 * INTENT names it — see {@link PROBE_KIND_CELL}.
 *
 * ACCEPTED_BAD_INPUT is `true` as a measurement and produces no cell: the
 * application accepted an id that cannot exist, so there is no error state to
 * test here. It is a defect for the findings lane and an enumerated zero for
 * this one. UNMEASURED is false — never a pass, never a cell, and not
 * enumeration either.
 */
export const PROBE_VERDICT_MEASURES: Record<ProbeVerdict, boolean> = {
  ERROR_PATH_CONFIRMED: true,
  SOFT_ERROR: true,
  ACCEPTED_BAD_INPUT: true,
  SERVER_FAULT: true,
  UNMEASURED: false,
};

/**
 * The error state a probe was aiming at, used when the status cannot say.
 *
 * A soft 404 answers 200, so the only honest source of "which error state is
 * this" is what the probe asked for. UNSUPPORTED_METHOD is null because the
 * vocabulary has no member for a 405 and inventing one here — ERROR_VALIDATION
 * is the tempting neighbour — would file a method-not-allowed state under
 * validation, where nobody looking for it would ever find it.
 */
export const PROBE_KIND_CELL: Record<ProbeKind, CoverageCellKind | null> = {
  BAD_ID: 'ERROR_NOT_FOUND',
  MISSING_REQUIRED_QUERY: 'ERROR_VALIDATION',
  UNSUPPORTED_METHOD: null,
};

/**
 * An injected fault state, as a cell.
 *
 * PARTIAL and RATE_LIMITED are null because the vocabulary has no member for
 * either, and both are states a customer genuinely has: a page where half the
 * widgets loaded, and a page that hit a 429. They are counted as UNNAMEABLE
 * rather than mapped onto a neighbour, because "the partially-loaded state of
 * /dashboard is covered" must not be printed about a cell that is really the
 * empty state.
 */
export const FAULT_STATE_CELL: Record<FaultState, CoverageCellKind | null> = {
  LOADING: 'PAGE_LOADING',
  SLOW: 'PAGE_SLOW',
  EMPTY: 'PAGE_EMPTY',
  ERROR: 'ERROR_SERVER',
  FORBIDDEN: 'ERROR_FORBIDDEN',
  NOT_FOUND: 'ERROR_NOT_FOUND',
  PARTIAL: null,
  RATE_LIMITED: null,
};

/**
 * Which denominator each fault state counts toward.
 *
 * Needed as its own record because the two UNNAMEABLE faults have no cell kind
 * to derive it from, and an unnameable cell still has to be counted on the
 * right axis — a rate-limited state counted on PAGE_STATE would be a shortfall
 * reported against the wrong number. For every fault that DOES have a cell, the
 * test holds this record to `CELL_KIND_DIMENSION`, so the two cannot disagree.
 */
export const FAULT_STATE_DIMENSION: Record<FaultState, StateDimensionKind> = {
  LOADING: 'PAGE_STATE',
  SLOW: 'PAGE_STATE',
  EMPTY: 'PAGE_STATE',
  PARTIAL: 'PAGE_STATE',
  ERROR: 'ERROR_STATE',
  FORBIDDEN: 'ERROR_STATE',
  NOT_FOUND: 'ERROR_STATE',
  RATE_LIMITED: 'ERROR_STATE',
};

/**
 * A DECLARED DATA PROFILE, AS A DATA-VARIANT CELL. One profile, one cell.
 *
 * ── Why four of seven, and why the other three are not dropped ─────────────
 *
 * The variants module's profiles are the DECLARED variant set — the fixture
 * states somebody said this application has — and four of them name a data
 * SHAPE that `COVERAGE_CELL_KINDS` holds a member for. The other three
 * (TRIAL_EXPIRED, QUOTA_EXCEEDED, PLAN_TIER) name an ENTITLEMENT state, and
 * there is no member for those. They are counted as UNNAMEABLE cells with the
 * reason named, never relabelled DATA_MALFORMED to make the table look total —
 * a cell reported under a kind it is not is worse than a cell reported as
 * unnameable, because the first is a sentence about the customer's application
 * that is false and the second is a true sentence about ours.
 *
 * ── Why one profile mints one cell and not two ─────────────────────────────
 *
 * BOUNDARY's own description covers "one record, the maximum, zero-length,
 * maximum-length" — four things, by one declaration. Minting a cell for each
 * would be the cross-product lie in miniature: a denominator built from what is
 * POSSIBLE rather than from what a declarer asserted. So BOUNDARY is one cell,
 * and DATA_ONE and DATA_MALFORMED are left with no profile that produces
 * them — which is reported by {@link unproducedDataCells} rather than quietly
 * never appearing.
 *
 * TYPICAL is DATA_MANY because the keystone already fixed that correspondence:
 * `HAPPY_PATH_CELL_KINDS` is PAGE_DEFAULT, DATA_MANY, COMPONENT_DEFAULT, and
 * TYPICAL is defined as "the ordinary account a crawl already sees".
 */
export const DATA_PROFILE_CELL: Record<DataProfileKind, CoverageCellKind | null> = {
  EMPTY: 'DATA_NONE',
  TYPICAL: 'DATA_MANY',
  HEAVY: 'DATA_PAGE_BOUNDARY',
  BOUNDARY: 'DATA_MAXIMUM',
  TRIAL_EXPIRED: null,
  QUOTA_EXCEEDED: null,
  PLAN_TIER: null,
};

/**
 * The data-variant cells no declared profile produces in this build.
 *
 * DERIVED, so it cannot fall out of date with the table above, and reported
 * rather than omitted: "nothing in this project declares a one-row or a
 * malformed fixture, so those two states are not enumerated for any route" is a
 * true and actionable sentence, and silence in its place reads as coverage.
 */
export function unproducedDataCells(): CoverageCellKind[] {
  const produced = new Set(Object.values(DATA_PROFILE_CELL).filter((kind) => kind !== null));
  return (Object.keys(CELL_KIND_DIMENSION) as CoverageCellKind[]).filter(
    (kind) => CELL_KIND_DIMENSION[kind] === 'DATA_VARIANT' && !produced.has(kind),
  );
}

/**
 * Whether a variant's outcome produced an observation of the cell.
 *
 * OBSERVED alone. The other four are the honest half of the plan: UNAVAILABLE
 * and REFUSED are held out with a reason, FAILED and NOT_RUN enumerate the cell
 * and observe nothing. A plan of 400 variants of which 12 ran must not read as
 * 400 measured cells, which is the defect `VARIANT_OUTCOMES` was widened to
 * five members to prevent.
 */
export const VARIANT_OUTCOME_OBSERVED: Record<VariantOutcome, boolean> = {
  OBSERVED: true,
  UNAVAILABLE: false,
  REFUSED: false,
  FAILED: false,
  NOT_RUN: false,
};

// ─── 4. Claims: what a test says about a state ──────────────────────────────

/**
 * HOW A TEST CAME TO BE LINKED TO A STATE.
 *
 * Five bases, and the last one is the point of the list. Today the only
 * negative-path signal in `coverage.ts` is an English regex over test source of
 * LOW confidence, and it is treated like any other match. It is kept here —
 * "should show an error when the cart is empty" IS evidence, and discarding it
 * would lose the only signal most suites give — but it is pinned to the STATIC
 * edge source, whose ceiling is DECLARED, so IT CAN NEVER BY ITSELF PROMOTE A
 * STATE TO ASSERTED. A phrase in a file is not an assertion about a page, and a
 * product that let one count as an assertion would be selling a regex.
 */
export const STATE_CLAIM_BASES = [
  /** A run was observed in this state while executing the test. */
  'RUN_OBSERVED',
  /** The test declared it — `covers: [...]` or a generator's own record. */
  'TEST_DECLARED',
  /** The source declares a handler for it: an error boundary, a 404 page. */
  'SOURCE_HANDLER',
  /** An API document declares the status this operation can answer with. */
  'API_STATUS',
  /** An English phrase in the test source mentions it. LOW confidence. */
  'ENGLISH_PHRASE',
] as const;
export type StateClaimBasis = (typeof STATE_CLAIM_BASES)[number];

/** The compile-time presence half; the test compares the schema-free list. */
const STATE_CLAIM_BASIS_PRESENT: Record<StateClaimBasis, true> = {
  RUN_OBSERVED: true,
  TEST_DECLARED: true,
  SOURCE_HANDLER: true,
  API_STATUS: true,
  ENGLISH_PHRASE: true,
};

export const STATE_CLAIM_BASIS_KINDS = Object.keys(
  STATE_CLAIM_BASIS_PRESENT,
) as readonly StateClaimBasis[];

/**
 * The edge source each basis is, which is what applies the ceiling.
 *
 * A `Record` and not a caller's choice: if `ENGLISH_PHRASE` could arrive as
 * RUNTIME, the one rule this section exists to enforce would depend on every
 * caller remembering it. `COVERAGE_EDGE_SOURCE_CEILING` then caps STATIC and
 * SPEC at DECLARED with no further code here.
 */
export const STATE_CLAIM_BASIS_SOURCE: Record<StateClaimBasis, CoverageEdgeSource> = {
  RUN_OBSERVED: 'RUNTIME',
  TEST_DECLARED: 'SPEC',
  SOURCE_HANDLER: 'STATIC',
  API_STATUS: 'STATIC',
  ENGLISH_PHRASE: 'STATIC',
};

/** The bases that are a declaration about existence rather than about a test. */
export const DECLARING_CLAIM_BASES: readonly StateClaimBasis[] = ['SOURCE_HANDLER', 'API_STATUS'];

/** One (test → state) claim, as the only input the tier rule may see. */
export interface StateClaim {
  /** The cell, spelled by {@link stateCellKey}. */
  stateKey: string;
  basis: StateClaimBasis;
  testId: string;
  /**
   * The run that observed it, or null. A tier above DECLARED with no run named
   * is held at DECLARED — `coverageItemStateSchema` refuses the row otherwise,
   * and it is right to: a rung we cannot attribute to a run is a rung nobody
   * can audit.
   */
  runId: string | null;
  navigationObserved: boolean;
  assertionObserved: boolean;
  runStatus: TestResultStatus | null;
  retriedAndPassed?: boolean;
  quarantined?: boolean;
  confirmedAtIso?: string | null;
  /** The sentence the row carries. Never defaulted to ''. */
  evidence: string;
}

export interface StateClaimVerdict extends CoverageTierVerdict {
  stateKey: string;
  testId: string;
  runId: string | null;
  basis: StateClaimBasis;
  source: CoverageEdgeSource;
  /** Always set here: `promoteCoverageTier` never returns null for an edge. */
  tier: CoverageTier;
}

/**
 * One claim's rung.
 *
 * It is `promoteCoverageTier` plus ONE extra floor — the run-name rule above —
 * and deliberately not a second promotion rule. The ladder, the ceilings and
 * the freshness window live in coverage-tiers.ts; a state is not a different
 * kind of thing from an item and must not be promoted by different arithmetic,
 * or "34% passing" would mean two things on one screen.
 */
export function promoteStateClaim(
  claim: StateClaim,
  nowIso: string,
  freshnessDays: number = DEFAULT_COVERAGE_FRESHNESS_DAYS,
): StateClaimVerdict {
  const source = STATE_CLAIM_BASIS_SOURCE[claim.basis];
  const verdict = promoteCoverageTier(
    {
      source,
      navigationObserved: claim.navigationObserved,
      assertionObserved: claim.assertionObserved,
      runStatus: claim.runStatus,
      retriedAndPassed: claim.retriedAndPassed ?? false,
      quarantined: claim.quarantined ?? false,
      confirmedAtIso: claim.confirmedAtIso ?? null,
    },
    nowIso,
    freshnessDays,
  );
  // `promoteCoverageTier` returns DECLARED at worst for an edge that exists, so
  // the non-null assertion below is the ladder's contract rather than a guess.
  const tier = verdict.tier ?? 'DECLARED';

  const base = { ...verdict, stateKey: claim.stateKey, testId: claim.testId, runId: claim.runId, basis: claim.basis, source };

  if (claim.runId === null && COVERAGE_TIER_RANK[tier] > COVERAGE_TIER_RANK.DECLARED) {
    const capped: TierCapReason = 'NO_RUN_OBSERVED';
    return {
      ...base,
      tier: 'DECLARED',
      cappedBy: capped,
      why:
        `declared — reached ${tier.toLowerCase()} and no run is named, so nothing can be ` +
        're-checked or dated; a rung nobody can audit is not a rung',
    };
  }
  return { ...base, tier };
}

// ─── 5. The inputs ─────────────────────────────────────────────────────────

/** An item whose states are being enumerated. */
export interface StateItem {
  /** `CoverageItem.key`, exactly as the inventory spells it. */
  key: string;
  label: string;
  /**
   * The axis it sits on. Used to keep an item out of a dimension that does not
   * refine it: `COVERAGE_DIMENSION_DESCRIPTORS.PAGE_STATE.refines` is ROUTE
   * alone, so an ENDPOINT never enters the page-state denominator — it has no
   * page. Reading the descriptor rather than hard-coding the filter is what
   * keeps this module and the vocabulary from disagreeing.
   */
  kind: SurfaceKind;
}

/**
 * One node of the crawl, as this module needs it.
 *
 * Narrower than `FlowNode` deliberately, and the precedent is `VariantNode`:
 * the callers that could supply a whole node are the ones holding a live crawl,
 * while the integrator reading a stored map holds verdicts and statuses. Every
 * field that can be absent is distinguishable from a field that is empty.
 */
export interface StateNodeFact {
  itemKey: string;
  /** `FlowNode.stateKey`, carried into the evidence sentence, never the key. */
  nodeStateKey: string;
  /**
   * The navigation's status. `undefined` means this crawl predates status
   * capture, `null` means the navigation produced no response — and neither is
   * 200, which is the rule `shouldGenerateAgainst` already enforces.
   */
  status?: NodeStatus | null;
  /** The structural verdict, or null when the read did not run. */
  structural?: StructuralVerdict | null;
  /** The interstitial finding, or null when nothing classified one. */
  interstitial?: InterstitialFinding | null;
  /** The bounce for the url that was REQUESTED, narrowed. */
  bounce?: { kind: BounceKind; finalRoute: string; status: number | null } | null;
  observedAtIso: string;
  /** Set when a test may not drive this node here. */
  exercise?: SurfaceExercise | null;
}

/** One access-matrix cell, narrowed to the three columns a state needs. */
export interface AccessStateFact {
  itemKey: string;
  role: string;
  outcome: RouteAccessOutcome;
  basis: RouteAccessBasis;
  /** NULL when nothing asked. See `AccessMatrixCell.probedAtIso`. */
  probedAtIso: string | null;
  /** The sentence the row carries. */
  evidence: string;
}

/** One error probe's answer, narrowed. */
export interface ProbeStateFact {
  itemKey: string;
  probeKind: ProbeKind;
  verdict: ProbeVerdict;
  /** The status it answered with. Null is never 200. */
  status: number | null;
  observedAtIso: string;
  evidence: string;
  exercise?: SurfaceExercise | null;
}

/**
 * A state a DECLARER named, with no observation behind it.
 *
 * The half of item 2 that makes the dimension more than a crawl report: a 500
 * handler in the source and a 409 in an OpenAPI document are states the
 * application HAS, whether or not a crawl ever provoked them. They enter the
 * denominator with `observedAtIso: null`, which is the stored distinction
 * between declared and observed.
 */
export interface DeclaredStateFact {
  itemKey: string;
  cell: CoverageCellKind;
  qualifier?: string | null;
  origin: SurfaceSource;
  evidence: string;
}

/**
 * One injected fault state, paired with what became of it.
 *
 * The fault axis is the ONLY producer of a slow or a loading state — nothing a
 * crawl observes by itself puts `PAGE_SLOW` in the denominator — which is why
 * it is an input here and not left to the caller to translate. A fault the
 * policy REFUSED to inject (`NON_IDEMPOTENT_RULE`: failing a POST means first
 * issuing it) arrives with its `exercise` set and leaves the denominator with
 * the rule named, rather than being counted as a gap the customer could close.
 */
export interface FaultStateFact {
  itemKey: string;
  fault: FaultState;
  /** What the pass did with it. See {@link VARIANT_OUTCOME_OBSERVED}. */
  outcome: VariantOutcome;
  /** Null unless the pass observed it. */
  observedAtIso: string | null;
  evidence: string;
  exercise?: SurfaceExercise | null;
}

/** One declared data profile, paired with what became of it. */
export interface DataProfileFact {
  itemKey: string;
  profileKey: string;
  profile: DataProfileKind;
  /** What the pass did with it. See {@link VARIANT_OUTCOME_OBSERVED}. */
  outcome: VariantOutcome;
  /** Null unless the pass observed it. */
  observedAtIso: string | null;
  evidence: string;
  /** Set when the environment cannot produce the profile, or policy refused it. */
  exercise?: SurfaceExercise | null;
}

/**
 * A cap that bit, tagged with the dimensions it actually truncated.
 *
 * Tagged, rather than applied to all three, because a page budget that stopped
 * the crawl truncated the page-state enumeration and said nothing about the
 * data-variant plan. Reporting one cap on three dimensions would be three
 * disclosures where one is true, and a reader who finds one false caveat stops
 * believing the others.
 */
export interface StateCapBite extends DimensionCapBite {
  dimensions: readonly StateDimensionKind[];
}

export interface StateEnumerationInput {
  items: readonly StateItem[];
  nodes?: readonly StateNodeFact[];
  access?: readonly AccessStateFact[];
  probes?: readonly ProbeStateFact[];
  declared?: readonly DeclaredStateFact[];
  faults?: readonly FaultStateFact[];
  profiles?: readonly DataProfileFact[];
  claims?: readonly StateClaim[];
  caps?: readonly StateCapBite[];
  /** ISO-8601. Passed in, never read from a clock, so freshness is testable. */
  nowIso: string;
  freshnessDays?: number;
}

// ─── 6. The rows ───────────────────────────────────────────────────────────

/**
 * One enumerated state, in the shape `coverageItemStateSchema` parses.
 *
 * The field names are the schema's, so the write path is a parse and an upsert
 * rather than a mapping layer nobody can diff against the table. The ONE
 * difference is `dimension`, which is derived from `kind` through
 * `CELL_KIND_DIMENSION` and is NOT stored — the schema has no such column
 * because storing it twice is how the two come to disagree.
 */
export interface CoverageStateRow {
  itemKey: string;
  stateKey: string;
  kind: CoverageCellKind;
  label: string;
  origin: SurfaceSource;
  evidence: string;
  parentStateKey: string | null;
  observedAtIso: string | null;
  exercise: SurfaceExercise | null;
  tier: CoverageTier | null;
  tierCappedBy: TierCapReason | null;
  lastConfirmedRunId: string | null;
  unmeasuredReason: DimensionUnmeasuredReason | null;
  unmeasuredDetail: string | null;
  /** Derived from `kind`. Not a column — see the note above. */
  dimension: StateDimensionKind;
  /** How many sightings produced this row, after merging. */
  sightings: number;
}

/** A cell we learned exists and this build cannot name. Counted, never stored. */
export interface UnnameableCell {
  itemKey: string;
  dimension: StateDimensionKind;
  why: string;
}

/** An item whose cell set nobody enumerated, and why. */
export interface NotEnumeratedItem {
  itemKey: string;
  dimension: StateDimensionKind;
  why: string;
}

/**
 * One reason's share of a dimension's unmeasured cells.
 *
 * `State…`-prefixed because coverage-fields.ts exports an `UnmeasuredBreakdown`
 * of its own with a different shape (`Record<reason, number>`), and both
 * modules belong on the agent barrel. Two different types under one name in one
 * `export *` graph is an ambiguous re-export: it breaks the barrel for every
 * consumer, which is a worse outcome than a longer name.
 */
export interface StateUnmeasuredBreakdown {
  reason: DimensionUnmeasuredReason;
  cells: number;
  detail: string;
}

export interface StateDimensionReport {
  /** Three measurements. There is deliberately no fourth, combined one. */
  pageStates: DimensionMeasurement;
  errorStates: DimensionMeasurement;
  dataVariants: DimensionMeasurement;
  /** Every enumerated, nameable cell. Ready for `coverageItemStateSchema`. */
  rows: CoverageStateRow[];
  notEnumerated: NotEnumeratedItem[];
  unnameable: UnnameableCell[];
  /** The full reason breakdown the single `unmeasuredReason` field cannot hold. */
  unmeasuredBreakdown: Record<StateDimensionKind, StateUnmeasuredBreakdown[]>;
  /** Data-variant cells no declared profile produces in this build. */
  unproducedDataCells: CoverageCellKind[];
  rule: string;
}

// ─── 7. Resolving each signal ──────────────────────────────────────────────

/**
 * The page states one node contributes.
 *
 * Several, not one, and that is the fold being undone: a node can be in a
 * structural state AND have been bounced AND have had an interstitial in front
 * of it, and each is a different thing to drive.
 */
export function pageStatesOfNode(node: StateNodeFact): StateResolution[] {
  const out: StateResolution[] = [];

  // ─ The interstitial first, because a STRONG one means we never saw the page
  //   and therefore must not describe its states.
  const interstitial = node.interstitial ?? null;
  if (interstitial && interstitial.kind !== 'NONE') {
    const kind = INTERSTITIAL_CELL[interstitial.kind];
    if (kind !== null) {
      out.push(
        cell(
          kind,
          `${interstitial.reason ?? interstitial.kind} — ${interstitial.signals.length} signal(s)`,
          kind === 'PAGE_INTERSTITIAL' ? interstitial.kind : null,
        ),
      );
    }
  }

  const structural = node.structural ?? null;
  if (structural) {
    const kind = STRUCTURAL_STATE_CELL[structural.state];
    if (kind !== null) {
      out.push(cell(kind, `${structural.why} (basis: ${structural.basis})`));
    } else if (structural.state === 'ERROR') {
      /*
       * An error page. WHICH error is the status's answer, not the DOM's — so
       * the status decides, and a soft error page (an error body behind a 200)
       * is an UNNAMEABLE cell rather than a guess between a 403 and a 500. That
       * soft case is the one that fools every other tool, so it is reported as
       * a state we found and could not classify instead of not being reported.
       */
      const fromStatus = errorCellForStatus(node.status?.code ?? null);
      out.push(
        fromStatus === null
          ? unnameable(
              'ERROR_STATE',
              `an error page answered with status ${node.status?.code ?? 'none'} — the body is an ` +
                'error and the status does not say which, so this state is counted and not named',
            )
          : cell(fromStatus, `an error page: ${structural.why}`),
      );
    } else if (structural.basis === 'NONE') {
      out.push(nothing(false, structural.why));
    } else {
      out.push(
        unnameable(
          'PAGE_STATE',
          `${structural.signals.length} signal(s) fired and decided nothing: ${structural.why}`,
        ),
      );
    }
  }

  const bounce = node.bounce ?? null;
  if (bounce) {
    const kind = BOUNCE_CELL[bounce.kind];
    if (kind !== null) {
      out.push(cell(kind, `asked for this route and arrived at ${bounce.finalRoute}`));
    } else if (bounce.kind === 'ERROR_STATUS') {
      const fromStatus = errorCellForStatus(bounce.status);
      out.push(
        fromStatus === null
          ? unnameable(
              'ERROR_STATE',
              `answered with status ${bounce.status ?? 'none'}, which this build's cell ` +
                'vocabulary has no member for',
            )
          : cell(fromStatus, `answered with status ${bounce.status ?? 'none'} and did not move`),
      );
    }
  }

  // The status on its own, for a node with no structural read and no bounce:
  // a 404 node is an error state whatever else we failed to look at.
  if (node.status && node.status.code !== null) {
    const fromStatus = errorCellForStatus(node.status.code);
    if (fromStatus !== null) {
      out.push(cell(fromStatus, `the navigation answered ${node.status.code}`));
    } else if (statusClassFor(node.status.code) === 'CLIENT_ERROR') {
      out.push(
        unnameable(
          'ERROR_STATE',
          `the navigation answered ${node.status.code}, which this build's cell vocabulary has ` +
            'no member for',
        ),
      );
    }
  }

  if (out.length === 0) {
    out.push(
      nothing(
        false,
        'this node carries no status, no structural verdict and no bounce — nothing recorded ' +
          'what state it was in',
      ),
    );
  }
  return out;
}

/**
 * Whether a node's interstitial means we never saw the application.
 *
 * `blocksEnumeration` is set only by a STRONG signal — never by a phrase — so
 * this is the crawl's own word that the page behind the wall was not read. The
 * item's page-state set is then NOT_ENUMERATED however many cells the wall
 * itself produced, because the wall is a state and not the inventory.
 */
export function blocksStateEnumeration(node: StateNodeFact): boolean {
  return node.interstitial?.blocksEnumeration === true;
}

/** The error state one access cell contributes. */
export function errorStateOfAccess(fact: AccessStateFact): StateResolution {
  if (fact.outcome === 'NOT_PROBED') {
    return nothing(false, `nobody asked what ${fact.role} gets here`);
  }
  if (fact.basis === 'DECLARED') {
    /*
     * A source said so and nobody asked. It is a real declaration and it enters
     * the denominator through {@link DeclaredStateFact} when the caller wants
     * it to — but it is not an OBSERVED access cell, and reading it as one here
     * is how "we checked" gets said about a check nobody ran. That is
     * `isRouteAccessMeasured`'s rule and this is the same rule.
     */
    return nothing(
      false,
      `a source claims ${fact.role} gets ${fact.outcome} here and nobody asked the application`,
    );
  }
  const kind = ACCESS_OUTCOME_CELL[fact.outcome];
  if (kind !== null) return cell(kind, fact.evidence);
  if (fact.outcome === 'ERRORED') {
    return nothing(
      false,
      `the request errored, so nothing was learned about ${fact.role}'s access — recording it as ` +
        'forbidden would manufacture a security finding out of a flaky box',
    );
  }
  // ALLOWED. Enumeration happened and this axis has no cell for it: being
  // served is ROLE_CELL's measurement, not an error state.
  return nothing(true, `${fact.role} was served the route, which is a role cell and not an error state`);
}

/** The error state one probe contributes. */
export function errorStateOfProbe(fact: ProbeStateFact): StateResolution {
  if (!PROBE_VERDICT_MEASURES[fact.verdict]) {
    return nothing(false, `the ${fact.probeKind} probe could not be issued: ${fact.evidence}`);
  }
  if (fact.verdict === 'ACCEPTED_BAD_INPUT') {
    return nothing(
      true,
      'the application accepted input that cannot be valid, so there is no error state here to ' +
        'test — that is a defect for the findings lane and an enumerated zero for this one',
    );
  }
  if (fact.verdict === 'SERVER_FAULT') {
    return cell('ERROR_SERVER', `the ${fact.probeKind} probe produced a 5xx: ${fact.evidence}`);
  }
  /*
   * ERROR_PATH_CONFIRMED and SOFT_ERROR. The status is preferred when it names
   * a cell, and the probe's INTENT is the fallback — which is what makes a soft
   * 404 countable at all, since its status says 200.
   */
  const fromStatus = errorCellForStatus(fact.status);
  const intent = PROBE_KIND_CELL[fact.probeKind];
  const kind = fromStatus ?? intent;
  if (kind === null) {
    return unnameable(
      'ERROR_STATE',
      `the ${fact.probeKind} probe answered ${fact.status ?? 'nothing'} and neither the status ` +
        "nor the probe's intent names a cell this build holds",
    );
  }
  return cell(
    kind,
    fact.verdict === 'SOFT_ERROR'
      ? `a soft error: status ${fact.status ?? 'none'} with an error body — ${fact.evidence}`
      : fact.evidence,
  );
}

/** The state one injected fault contributes. */
export function stateOfFault(fact: FaultStateFact): StateResolution {
  const kind = FAULT_STATE_CELL[fact.fault];
  if (kind === null) {
    return unnameable(
      FAULT_STATE_DIMENSION[fact.fault],
      `the ${fact.fault} fault state has no member in this build's cell vocabulary, so it is ` +
        'counted on its own axis and not mapped onto a neighbouring state it is not',
    );
  }
  return cell(kind, fact.evidence);
}

/** The data variant one declared profile contributes. */
export function dataVariantOfProfile(fact: DataProfileFact): StateResolution {
  const kind = DATA_PROFILE_CELL[fact.profile];
  if (kind === null) {
    return unnameable(
      'DATA_VARIANT',
      `the ${fact.profile} profile names an entitlement state, and this build's cell vocabulary ` +
        'has no member for it — counted here rather than relabelled as a data shape it is not',
    );
  }
  return cell(kind, fact.evidence, fact.profileKey);
}

// ─── 8. Enumeration and measurement ───────────────────────────────────────

/** One sighting of one cell, before merging. */
interface Sighting {
  itemKey: string;
  stateKey: string;
  kind: CoverageCellKind;
  dimension: StateDimensionKind;
  label: string;
  origin: SurfaceSource;
  evidence: string;
  observedAtIso: string | null;
  exercise: SurfaceExercise | null;
}

/** How many sighting sentences a merged row prints before it says "+N more". */
const EVIDENCE_SIGHTINGS_SHOWN = 3;
/** `CoverageItemState.evidence` is `String @db` and the schema caps it here. */
const EVIDENCE_MAX = 1_000;

function joinEvidence(sentences: readonly string[]): string {
  const shown = sentences.slice(0, EVIDENCE_SIGHTINGS_SHOWN).join('; ');
  const hidden = sentences.length - Math.min(sentences.length, EVIDENCE_SIGHTINGS_SHOWN);
  const full = hidden > 0 ? `${shown} (+${hidden} more sighting(s))` : shown;
  // A display truncation, not a measurement cap: the SIGHTING COUNT is on the
  // row either way, so nothing about the denominator is hidden by it.
  return full.length <= EVIDENCE_MAX ? full : `${full.slice(0, EVIDENCE_MAX - 1)}…`;
}

/**
 * The dimension a cell kind counts toward, refused if it is not one of ours.
 *
 * A guard and not a cast. A COMPONENT_LOADING row written by this module would
 * be a cell counted on the COMPONENT_STATE denominator and stored where no
 * component reader looks — present, counted nowhere, invisible rather than
 * uncovered, which is the one failure this whole round exists to end.
 */
function stateDimensionOf(kind: CoverageCellKind): StateDimensionKind {
  const dimension = CELL_KIND_DIMENSION[kind];
  if (!isStateDimension(dimension)) {
    throw new Error(
      `${kind} counts toward ${dimension}, which this module does not measure — a row stored ` +
        'under the wrong dimension is counted on no denominator and is invisible',
    );
  }
  return dimension;
}

/** True when this item's axis is one the dimension refines. */
function dimensionRefines(dimension: StateDimensionKind, kind: SurfaceKind): boolean {
  return COVERAGE_DIMENSION_DESCRIPTORS[dimension].refines.includes(kind);
}

/**
 * Turns the inputs into sightings, the not-enumerated list and the unnameable
 * list. Pure; the measurement arithmetic is the next function's job.
 */
function collect(input: StateEnumerationInput): {
  sightings: Sighting[];
  notEnumerated: NotEnumeratedItem[];
  unnameable: UnnameableCell[];
} {
  const items = new Map(input.items.map((item) => [item.key, item]));
  const sightings: Sighting[] = [];
  const unnameable: UnnameableCell[] = [];
  /** dimension → item keys something enumerated. */
  const enumerated = new Map<StateDimensionKind, Set<string>>(
    STATE_DIMENSIONS.map((dimension) => [dimension, new Set<string>()]),
  );
  /** item key → why its enumeration was blocked. */
  const blocked = new Map<string, string>();

  const take = (
    itemKey: string,
    resolution: StateResolution,
    context: {
      /** The dimensions this fact enumerates when it decides anything. */
      enumerates: readonly StateDimensionKind[];
      origin: SurfaceSource;
      observedAtIso: string | null;
      exercise?: SurfaceExercise | null;
      qualifier?: string | null;
    },
  ): void => {
    const item = items.get(itemKey);
    // A fact about an item the inventory does not hold is a dangling reference
    // in OUR extractor. Minting a cell for it would inflate a denominator with
    // a row nothing can ever join to, so it is dropped and the drop is visible
    // as the item's absence from the inventory rather than as a phantom cell.
    if (!item) return;

    const mark = (dimension: StateDimensionKind): void => {
      if (dimensionRefines(dimension, item.kind)) enumerated.get(dimension)?.add(itemKey);
    };

    if (resolution.kind === 'NOTHING') {
      if (resolution.enumerated) for (const dimension of context.enumerates) mark(dimension);
      return;
    }
    if (resolution.kind === 'UNNAMEABLE') {
      if (!dimensionRefines(resolution.dimension, item.kind)) return;
      mark(resolution.dimension);
      unnameable.push({ itemKey, dimension: resolution.dimension, why: resolution.why });
      return;
    }

    const dimension = stateDimensionOf(resolution.cell);
    if (!dimensionRefines(dimension, item.kind)) return;
    mark(dimension);
    sightings.push({
      itemKey,
      stateKey: stateCellKey({
        itemKey,
        kind: resolution.cell,
        qualifier: resolution.qualifier ?? context.qualifier ?? null,
      }),
      kind: resolution.cell,
      dimension,
      label: `${item.label} — ${resolution.cell}`,
      origin: context.origin,
      evidence: resolution.why,
      observedAtIso: context.observedAtIso,
      exercise: context.exercise ?? null,
    });
  };

  for (const node of input.nodes ?? []) {
    if (blocksStateEnumeration(node)) {
      blocked.set(
        node.itemKey,
        node.interstitial?.reason ??
          `a ${node.interstitial?.kind ?? 'interstitial'} answered instead of the application`,
      );
    }
    for (const resolution of pageStatesOfNode(node)) {
      take(node.itemKey, resolution, {
        enumerates: ['PAGE_STATE'],
        origin: 'CRAWL',
        observedAtIso: node.observedAtIso,
        exercise: node.exercise ?? null,
      });
    }
  }

  for (const fact of input.access ?? []) {
    take(fact.itemKey, errorStateOfAccess(fact), {
      enumerates: ['ERROR_STATE'],
      origin: 'CRAWL',
      observedAtIso: fact.probedAtIso,
    });
  }

  for (const fact of input.probes ?? []) {
    take(fact.itemKey, errorStateOfProbe(fact), {
      enumerates: ['ERROR_STATE'],
      origin: 'CRAWL',
      observedAtIso: fact.observedAtIso,
      exercise: fact.exercise ?? null,
    });
  }

  for (const fact of input.declared ?? []) {
    take(
      fact.itemKey,
      cell(fact.cell, fact.evidence, fact.qualifier ?? null),
      {
        enumerates: STATE_DIMENSIONS,
        origin: fact.origin,
        // NULL, ALWAYS. A declared state has never been observed, and stamping
        // it with the request time is how every declaration becomes a sighting.
        observedAtIso: null,
      },
    );
  }

  for (const fact of input.faults ?? []) {
    take(fact.itemKey, stateOfFault(fact), {
      enumerates: [FAULT_STATE_DIMENSION[fact.fault]],
      origin: 'CRAWL',
      // A planned fault that did not run is a DECLARED state and not an
      // observed one, whatever timestamp the caller happens to hold.
      observedAtIso: VARIANT_OUTCOME_OBSERVED[fact.outcome] ? fact.observedAtIso : null,
      exercise: fact.exercise ?? null,
    });
  }

  for (const fact of input.profiles ?? []) {
    take(fact.itemKey, dataVariantOfProfile(fact), {
      enumerates: ['DATA_VARIANT'],
      origin: 'CATALOGUE',
      observedAtIso: VARIANT_OUTCOME_OBSERVED[fact.outcome] ? fact.observedAtIso : null,
      exercise: fact.exercise ?? null,
    });
  }

  const notEnumerated: NotEnumeratedItem[] = [];
  for (const dimension of STATE_DIMENSIONS) {
    const seen = enumerated.get(dimension) ?? new Set<string>();
    for (const item of input.items) {
      if (!dimensionRefines(dimension, item.kind)) continue;
      const block = blocked.get(item.key);
      if (block !== undefined && dimension === 'PAGE_STATE') {
        notEnumerated.push({
          itemKey: item.key,
          dimension,
          why: `enumeration was blocked: ${block} — the states behind the wall were never read`,
        });
        continue;
      }
      if (!seen.has(item.key)) {
        notEnumerated.push({
          itemKey: item.key,
          dimension,
          why: `nothing recorded any ${COVERAGE_DIMENSION_DESCRIPTORS[dimension].cellNoun} of this item`,
        });
      }
    }
  }

  return { sightings, notEnumerated, unnameable };
}

/**
 * Merges every sighting of one cell into one row.
 *
 * Four merge rules, each with a reason:
 *
 *   origin        an OBSERVED declarer beats a DECLARED one. `originFromSources`
 *                 draws the same line one level up: a crawl that reached the
 *                 state outranks a source that said it exists.
 *   observedAt    the LATEST non-null, because the column answers "when was
 *                 this state last seen" and a state seen today is not stale
 *                 because it was also seen in March.
 *   exercise      a sighting that DROVE it beats one that refused it. A refusal
 *                 is a statement about what we were willing to try, and an
 *                 observation is proof it can be driven; keeping the refusal
 *                 would hold a reachable state out of the denominator.
 *   evidence      every sentence, bounded, with the hidden count stated.
 */
function mergeSightings(sightings: readonly Sighting[]): Map<string, CoverageStateRow> {
  const rows = new Map<string, CoverageStateRow>();
  const evidence = new Map<string, string[]>();

  for (const sighting of sightings) {
    const id = `${sighting.itemKey}\u0000${sighting.stateKey}`;
    const existing = rows.get(id);
    const sentences = evidence.get(id) ?? [];
    sentences.push(sighting.evidence);
    evidence.set(id, sentences);

    if (!existing) {
      rows.set(id, {
        itemKey: sighting.itemKey,
        stateKey: sighting.stateKey,
        kind: sighting.kind,
        label: sighting.label,
        origin: sighting.origin,
        evidence: sighting.evidence,
        parentStateKey: null,
        observedAtIso: sighting.observedAtIso,
        exercise: sighting.exercise,
        tier: null,
        tierCappedBy: null,
        lastConfirmedRunId: null,
        unmeasuredReason: null,
        unmeasuredDetail: null,
        dimension: sighting.dimension,
        sightings: 1,
      });
      continue;
    }

    existing.sightings += 1;
    if (isObservedSource(sighting.origin) && !isObservedSource(existing.origin)) {
      existing.origin = sighting.origin;
      existing.label = sighting.label;
    }
    if (
      sighting.observedAtIso !== null &&
      (existing.observedAtIso === null || sighting.observedAtIso > existing.observedAtIso)
    ) {
      existing.observedAtIso = sighting.observedAtIso;
    }
    if (existing.exercise !== null && !exercisabilityCounts(existing.exercise.state)) {
      if (sighting.exercise === null || exercisabilityCounts(sighting.exercise.state)) {
        existing.exercise = sighting.exercise;
      }
    }
  }

  for (const [id, row] of rows) {
    row.evidence = joinEvidence(evidence.get(id) ?? [row.evidence]);
  }
  return rows;
}

/**
 * Picks the ONE reason a dimension's `unmeasuredReason` carries, and writes the
 * sentence that gives all of them.
 *
 * `DimensionMeasurement` has a single reason field, which is the right shape for
 * a report that groups by it and the wrong shape for a reading that hit three
 * limits at once. So the dominant reason — most cells, ties broken by
 * `DIMENSION_UNMEASURED_REASONS` order so the result is deterministic — goes in
 * the field, and the detail enumerates EVERY reason with its count. The field
 * can therefore never hide a reason; the only thing the single slot costs is
 * which one a grouping screen files the dimension under, and the full
 * breakdown is on {@link StateDimensionReport.unmeasuredBreakdown} as well.
 */
export function combineUnmeasured(
  parts: readonly StateUnmeasuredBreakdown[],
): { reason: DimensionUnmeasuredReason; detail: string; cells: number } | null {
  const real = parts.filter((part) => part.cells > 0);
  if (real.length === 0) return null;

  const ordered = [...real].sort((left, right) => {
    if (right.cells !== left.cells) return right.cells - left.cells;
    return (
      DIMENSION_UNMEASURED_REASONS.indexOf(left.reason) -
      DIMENSION_UNMEASURED_REASONS.indexOf(right.reason)
    );
  });
  const dominant = ordered[0]!;
  const cells = real.reduce((running, part) => running + part.cells, 0);
  const detail = ordered
    .map((part) => `${part.cells} ${part.reason}: ${part.detail}`)
    .join(' · ');
  return { reason: dominant.reason, cells, detail };
}

/**
 * THE MEASUREMENT. Three dimensions, three denominators, one pass over the
 * inputs.
 *
 * Deterministic and model-free: same facts in, same cells, same tiers out, so a
 * state appearing or disappearing between runs is a fact about the application
 * or about the crawl rather than about us.
 */
export function measureStateDimensions(input: StateEnumerationInput): StateDimensionReport {
  const { sightings, notEnumerated, unnameable } = collect(input);
  const rows = [...mergeSightings(sightings).values()];

  // ─ Tiers. One verdict per claim, resolved per cell by the ladder's own
  //   MAX rule — two tests covering one state does not make it more covered
  //   than the better of the two makes it.
  const claimsByCell = new Map<string, StateClaimVerdict[]>();
  for (const claim of input.claims ?? []) {
    const verdict = promoteStateClaim(claim, input.nowIso, input.freshnessDays);
    const list = claimsByCell.get(claim.stateKey) ?? [];
    list.push(verdict);
    claimsByCell.set(claim.stateKey, list);
  }
  for (const row of rows) {
    const verdicts = claimsByCell.get(row.stateKey) ?? [];
    if (verdicts.length === 0) continue;
    const resolved = resolveCoverageEdges(verdicts);
    row.tier = resolved.tier;
    row.tierCappedBy = resolved.authoritative?.cappedBy ?? null;
    row.lastConfirmedRunId = resolved.authoritative?.runId ?? null;
  }

  const breakdown: Record<StateDimensionKind, StateUnmeasuredBreakdown[]> = {
    PAGE_STATE: [],
    ERROR_STATE: [],
    DATA_VARIANT: [],
  };
  const measurements = {} as Record<StateDimensionKind, DimensionMeasurement>;

  for (const dimension of STATE_DIMENSIONS) {
    const own = rows.filter((row) => row.dimension === dimension);
    const scored: Array<CoverageTier | null> = [];
    let heldOut = 0;
    /*
     * The distinct POLICIES that held cells out, for the aggregate sentence.
     * "1 state was held out" is a number nobody can act on; "1 state was held
     * out by faults-non-idempotent" names the rule they can look up, and the
     * per-row detail still carries each one individually.
     */
    const heldOutBy = new Set<string>();
    for (const row of own) {
      if (row.exercise !== null && !exercisabilityCounts(row.exercise.state)) {
        heldOut += 1;
        heldOutBy.add(row.exercise.rule ?? row.exercise.reason ?? row.exercise.state);
        /*
         * The row keeps its reason so the inventory can say why it is not
         * scored. It stays IN the inventory and OUT of the denominator, which
         * is `NON_DENOMINATOR_EXERCISABILITIES`' contract — a surface we are
         * not permitted to touch is never scored as a pass and never silently
         * dropped.
         */
        row.unmeasuredReason = 'HELD_OUT';
        /*
         * The RULE or the REASON travels with the sentence, never just the
         * state. `surfaceExerciseSchema` requires a rule for REFUSED and a
         * reason for UNEXERCISABLE for exactly this moment: "excluded by
         * policy" with no rule named is indistinguishable from a bug in our
         * crawler, and the customer's only possible response to it is to
         * distrust the number.
         */
        row.unmeasuredDetail = [
          row.exercise.state,
          row.exercise.rule ?? row.exercise.reason ?? null,
        ]
          .filter((part): part is string => part !== null)
          .join('/')
          .concat(`: ${row.exercise.detail}`);
        continue;
      }
      scored.push(row.tier);
    }

    const notEnumeratedHere = notEnumerated.filter((entry) => entry.dimension === dimension);
    const unnameableHere = unnameable.filter((entry) => entry.dimension === dimension);
    const caps = (input.caps ?? []).filter((cap) => cap.dimensions.includes(dimension));
    /*
     * Only a cap that can SAY how much it hid adds unmeasured cells. A
     * wall-clock timeout knows it stopped and not what it stopped before, and
     * `atLeastMore: null` means exactly that — adding 0 for it would be the
     * claim that nothing was hidden, which is the opposite of what a bitten cap
     * means. Every cap is still reported on the measurement, counted or not.
     */
    const cappedCells = caps.reduce((running, cap) => running + (cap.atLeastMore ?? 0), 0);

    const parts: StateUnmeasuredBreakdown[] = [
      {
        reason: 'NOT_ENUMERATED',
        cells: notEnumeratedHere.length,
        detail:
          `item(s) whose ${COVERAGE_DIMENSION_DESCRIPTORS[dimension].cellNoun} set nobody ` +
          'enumerated, counted as one cell each — a FLOOR, since every one of them has at ' +
          'least one state and the real count is unknown',
      },
      {
        reason: UNNAMEABLE_CELL_REASON,
        cells: unnameableHere.length,
        detail:
          "state(s) we found and this build's cell vocabulary has no member for, so they are " +
          'counted and not named',
      },
      {
        reason: 'HELD_OUT',
        cells: heldOut,
        detail:
          'state(s) the harness refused to drive or cannot drive here — in the inventory, out ' +
          `of the denominator, by: ${[...heldOutBy].sort().join(', ')}`,
      },
      {
        reason: 'CAP_BIT',
        cells: cappedCells,
        detail: caps
          .map(
            (cap) =>
              `${cap.cap} stopped at ${cap.limit}${
                cap.atLeastMore === null
                  ? ' and cannot say how much it hid'
                  : `, at least ${cap.atLeastMore} more existed`
              }`,
          )
          .join('; '),
      },
    ];
    breakdown[dimension] = parts.filter((part) => part.cells > 0);

    const combined = combineUnmeasured(parts);
    measurements[dimension] = measuredDimension({
      dimension,
      measuredCells: scored,
      unmeasured: combined?.cells ?? 0,
      unmeasuredReason: combined?.reason ?? null,
      unmeasuredDetail: combined?.detail ?? null,
      caps,
    });
  }

  return {
    pageStates: measurements.PAGE_STATE,
    errorStates: measurements.ERROR_STATE,
    dataVariants: measurements.DATA_VARIANT,
    rows,
    notEnumerated,
    unnameable,
    unmeasuredBreakdown: breakdown,
    unproducedDataCells: unproducedDataCells(),
    rule: NEVER_SUMMED_RULE,
  };
}

/**
 * The three-way split item 2 asks for, as COUNTS and never as a percentage.
 *
 * DECLARED, ASSERTED and "merely mentioned" are three different findings about
 * one error state, and the third is the one the product has been counting as
 * the first: a `/not found/i` match in a test file is a mention, and until this
 * round it was indistinguishable from a test that drives the 404 and asserts
 * what it sees. `mentionedOnly` is therefore its own number, and no percentage
 * is produced here — `dimensionPercentAt` is the one place a figure is read,
 * against one denominator.
 */
export interface ErrorStateBreakdown {
  /** Cells something declared exists. The denominator this split is about. */
  declared: number;
  /** Cells a run was observed to reach: tier NAVIGATED or above. */
  observed: number;
  /** Cells a run asserted something about: tier ASSERTED or above. */
  asserted: number;
  /**
   * Cells whose only claim is a declaration or a phrase — tier DECLARED. The
   * number a vendor would have reported as covered.
   */
  mentionedOnly: number;
  /** Cells nothing claims at all. The gap this product exists to shrink. */
  unclaimed: number;
}

export function errorStateBreakdown(report: StateDimensionReport): ErrorStateBreakdown {
  const own = report.rows.filter((row) => row.dimension === 'ERROR_STATE');
  const rank = (tier: CoverageTier | null): number =>
    tier === null ? 0 : COVERAGE_TIER_RANK[tier];
  return {
    declared: own.length,
    observed: own.filter((row) => rank(row.tier) >= COVERAGE_TIER_RANK.NAVIGATED).length,
    asserted: own.filter((row) => rank(row.tier) >= COVERAGE_TIER_RANK.ASSERTED).length,
    mentionedOnly: own.filter((row) => row.tier === 'DECLARED').length,
    unclaimed: own.filter((row) => row.tier === null).length,
  };
}
