/**
 * The coverage ladder — five rungs, and the evidence each one demands.
 *
 * WHY THIS FILE EXISTS
 *
 * `SurfaceItemCoverage.status` answers "is this covered?" with one word, and
 * `COVERED` means a test is matched to the item and has been seen to run. That
 * is already better than the boolean every competitor ships. It is still one
 * word for five different situations, and the gap between the best and the
 * worst of them is the whole product:
 *
 *   · a regex found `/orders/:id` inside a spec file;
 *   · a run was observed to REACH `/orders/:id`;
 *   · that run asserted something about what it found there;
 *   · the assertion passed;
 *   · it passed recently enough that the fact is still about today's code.
 *
 * The first of those is what a sales demo counts. The last is what a release
 * decision needs. Reporting them as one number is not a rounding error — it is
 * the specific arithmetic that lets a vendor quote 80% coverage for a suite
 * that asserts nothing, and it is how every number in this market is built.
 *
 * So this file makes the ladder a real vocabulary, with the evidence named per
 * rung, so a report can say "61% navigated, 34% passing" instead of "74%
 * covered" and a reader can see which half of that they are buying.
 *
 * ── MONOTONIC, AND WHY THAT IS A CONSTRAINT RATHER THAN A NOTE ──────────────
 *
 * Every rung IMPLIES every rung below it. An item that is PASSING is also
 * ASSERTED, NAVIGATED and DECLARED. That is what makes "34% passing, 61%
 * navigated" two readings of one measurement instead of two measurements: the
 * series can only fall as the bar rises, so a reader can compare the two
 * figures directly and the shape of the drop-off is the finding.
 *
 * It also settles a question that looks like taste and is not. ASSERTED sits
 * ABOVE NAVIGATED, so asserting implies having been reached — which means
 * STATIC extraction cannot reach ASSERTED, no matter how confidently a regex
 * spots an `expect()` three lines under a route literal. A test file is not a
 * run. {@link COVERAGE_EDGE_SOURCE_CEILING} is where that is enforced, and
 * DECLARED being the ceiling for every static and declared source is the point
 * of the whole file rather than a limitation of it.
 *
 * ── NULL IS NOT THE BOTTOM RUNG ─────────────────────────────────────────────
 *
 * `CoverageTier | null`, everywhere, and null means NO CLAIM OF ANY KIND — no
 * test mentions it, nobody declared it, no run touched it. It is NOT DECLARED.
 * DECLARED is a positive assertion that somebody said this item is covered, and
 * defaulting an un-evidenced item to it would put a claim in the database that
 * nothing produced. Same rule as `TestResult.notRunKind`, `mutationScore` and
 * `SurfaceKindTotals.percent`: not measured is null, never the weakest value.
 *
 * ── WHAT THIS FILE IS NOT ───────────────────────────────────────────────────
 *
 * It computes no coverage. It holds the rungs, their ranks, the evidence each
 * demands, the per-source ceilings, the promotion function and the ladder
 * arithmetic, so the extractor, the run finaliser, the API, the CLI gate and
 * the cockpit all mean the same thing by PASSING. Nothing here reads a clock,
 * a database or a network: `promoteCoverageTier` takes the time as an argument
 * for exactly that reason.
 */

import type { TestResultStatus } from './constants';
import { coveragePercent } from './surface';
import type { SurfaceStatus } from './surface';

// ─── The rungs ───────────────────────────────────────────────────────────────

/**
 * The ladder, weakest first. ORDER IS THE CONTRACT.
 *
 * Declared as an `as const` ARRAY rather than derived from a presence record,
 * and that is deliberate rather than lazy. Three things consume this list and
 * each needs a different form of it:
 *
 *   · `z.enum(COVERAGE_TIERS)` in schemas.ts needs the tuple.
 *   · `apps/api/scripts/check-enums.ts` reads it with a regex over this file's
 *     SOURCE (`export const NAME = [ … ]`), because it compares the list
 *     against the Prisma enum without executing TypeScript. A list built by
 *     `Object.keys` of a record is invisible to it, and an enum the drift guard
 *     cannot see is the exact hole that script was written to close.
 *   · the records below are `Record<CoverageTier, …>`, so the COMPILER refuses
 *     a rung with no rank, no label and no stated evidence.
 *
 * Three mechanisms, each catching what the others cannot — the same reasoning
 * `GATE_RULE_KIND_PRESENT` records, where eight gate kinds shipped unsaveable
 * for two slices because only one of the two guards existed. The run-time half
 * lives in coverage-tiers.test.ts, which compares `coverageTierSchema.options`
 * against this array because zod's options exist only at run time and the
 * compiler cannot see them. (schemas.test.ts asserts what the schemas REFUSE —
 * a STATIC writer storing PASSING, a regex claiming confidence 1 — which is a
 * different guard against a different mistake.)
 */
export const COVERAGE_TIERS = ['DECLARED', 'NAVIGATED', 'ASSERTED', 'PASSING', 'FRESH'] as const;
export type CoverageTier = (typeof COVERAGE_TIERS)[number];

/**
 * Where each rung sits. Higher is stronger, and the numbers are contiguous from
 * 1 so that "one rung up" is arithmetic rather than an index into the array.
 *
 * A `Record<CoverageTier, number>` and not a lookup into `COVERAGE_TIERS`,
 * because this is the compile-time presence guard: a sixth rung added to the
 * array breaks THIS line until somebody decides where it ranks. An
 * `indexOf` would have silently ranked it last.
 */
export const COVERAGE_TIER_RANK: Record<CoverageTier, number> = {
  DECLARED: 1,
  NAVIGATED: 2,
  ASSERTED: 3,
  PASSING: 4,
  FRESH: 5,
};

/** What to call each rung on screen. */
export const COVERAGE_TIER_LABELS: Record<CoverageTier, string> = {
  DECLARED: 'declared',
  NAVIGATED: 'navigated',
  ASSERTED: 'asserted',
  PASSING: 'passing',
  FRESH: 'fresh',
};

/**
 * THE EVIDENCE THAT PROMOTES AN ITEM TO EACH RUNG, as the sentence a customer
 * reads beside the figure.
 *
 * Not decoration. A coverage number is only defensible if the reader can be
 * told what was observed to produce it, and these five sentences are that
 * answer. They are a `Record` so a rung cannot exist without one — a tier with
 * no stated evidence is a tier nobody can audit, which is the condition this
 * whole file exists to end.
 */
export const COVERAGE_TIER_EVIDENCE: Record<CoverageTier, string> = {
  DECLARED:
    'a test names this item — found in the test source, or declared on the test itself. ' +
    'Nothing has been observed to run.',
  NAVIGATED: 'a run executed a test matched to this item and was observed to reach it.',
  ASSERTED: 'that run made at least one assertion attributable to this item.',
  PASSING: 'the assertion held and the run reported PASSED without needing a retry.',
  FRESH: 'that pass is recent enough to be about the code as it stands today.',
};

/**
 * Whether a rung rests on an OBSERVATION or on a CLAIM.
 *
 * False for DECLARED alone, and that single `false` is the commercial point of
 * the file. A declaration — whether a regex produced it or a human typed it —
 * is somebody saying a test covers something. Everything from NAVIGATED up is
 * something a run was seen to do. A report that renders the two the same way
 * is the report every competitor ships.
 */
export const COVERAGE_TIER_IS_OBSERVED: Record<CoverageTier, boolean> = {
  DECLARED: false,
  NAVIGATED: true,
  ASSERTED: true,
  PASSING: true,
  FRESH: true,
};

/**
 * The rung at which an item may be called COVERED in `surface.ts`'s vocabulary.
 *
 * NAVIGATED, because `SURFACE_STATUSES` already draws the line in exactly that
 * place: COVERED means a matched test "has been observed to run", and
 * ASSERTED_NOT_RUN means it has not. Pinning the two vocabularies to each other
 * here is what stops them drifting into two different definitions of covered —
 * which, in a product whose only sentence is a coverage percentage, would be
 * two different percentages.
 */
export const MINIMUM_COVERED_TIER: CoverageTier = 'NAVIGATED';

/**
 * How many days a pass stays FRESH by default.
 *
 * Seven, and the number has a reason: a suite that runs daily or faster — which
 * is the only kind a gate is useful on — re-confirms every item every day, so
 * seven absorbs a weekend, a holiday and one broken pipeline without ever
 * claiming that a month-old pass describes today's code. It is a CONSTANT and
 * not an environment variable on purpose: a freshness window nobody can see is
 * a window that gets widened until FRESH means nothing, and the one place it
 * may be overridden (`promoteCoverageTier`'s `freshnessDays`) reports the
 * window it used on the verdict.
 */
export const DEFAULT_COVERAGE_FRESHNESS_DAYS = 7;

// ─── Where an edge's evidence came from ──────────────────────────────────────

/**
 * How a test came to be linked to a surface item.
 *
 * ── The defect these three names exist to end ───────────────────────────────
 *
 * The numerator link was recomputed by regex over test source on every single
 * request. It had no identity, no history and no provenance, so there was no
 * way to say WHY a test was believed to cover an item, no way for a human or a
 * generator to assert it directly, and — the expensive part — no way for
 * coverage to FALL when a test was deleted or quarantined. A link that is
 * re-derived from scratch each time cannot go down for the most common reason
 * it should.
 *
 * RUNTIME OUTRANKS SPEC OUTRANKS STATIC, and the ordering is not a preference.
 * One of them is a record of what a browser did; one is a person or a generator
 * stating an intention; one is a regular expression's opinion about a string in
 * a file. When two disagree about the same (test, item) pair, the observation
 * wins — see {@link resolveCoverageEdges}.
 */
export const COVERAGE_EDGE_SOURCES = ['STATIC', 'SPEC', 'RUNTIME'] as const;
export type CoverageEdgeSource = (typeof COVERAGE_EDGE_SOURCES)[number];

export const COVERAGE_EDGE_SOURCE_LABELS: Record<CoverageEdgeSource, string> = {
  STATIC: 'extracted from the test source',
  SPEC: 'declared by the test',
  RUNTIME: 'observed by a run',
};

/** Strength order. Higher wins a disagreement. */
export const COVERAGE_EDGE_SOURCE_RANK: Record<CoverageEdgeSource, number> = {
  STATIC: 1,
  SPEC: 2,
  RUNTIME: 3,
};

/**
 * THE HIGHEST RUNG EACH SOURCE OF EVIDENCE CAN EVER REACH.
 *
 * DECLARED for STATIC and for SPEC, FRESH for RUNTIME, and the asymmetry is the
 * honesty of the whole measurement:
 *
 *   · STATIC is a regex over a file. It can prove a string appears in a spec.
 *     It cannot prove the spec is reachable, enabled, wired into a suite, or
 *     ever executed. "The word `/checkout` appears in checkout.spec.ts" and
 *     "a browser reached /checkout" are not degrees of the same fact.
 *   · SPEC is stronger as INTENT and identical as EVIDENCE. A declaration is a
 *     claim, which is precisely why it exists — many tests are simply
 *     unreadable to an extractor and somebody has to be able to SAY what a test
 *     is for. It must never be promotable past DECLARED without a run, or
 *     `covers: ['ROUTE:/billing']` would be a one-line way to manufacture a
 *     passing coverage report.
 *   · RUNTIME is the only source that observed anything, so it is the only one
 *     that can carry an item up the ladder.
 *
 * Also a `Record`, so a fourth source cannot be added without somebody stating
 * what it is allowed to claim.
 */
export const COVERAGE_EDGE_SOURCE_CEILING: Record<CoverageEdgeSource, CoverageTier> = {
  STATIC: 'DECLARED',
  SPEC: 'DECLARED',
  RUNTIME: 'FRESH',
};

/** True when `a` is stronger evidence than `b`. */
export function edgeSourceOutranks(a: CoverageEdgeSource, b: CoverageEdgeSource): boolean {
  return COVERAGE_EDGE_SOURCE_RANK[a] > COVERAGE_EDGE_SOURCE_RANK[b];
}

// ─── Why a rung is not higher ────────────────────────────────────────────────

/**
 * The reason an item sits where it sits.
 *
 * Every rung an item did NOT reach has a reason, and the reason is the only
 * actionable half of a coverage report: "63% of your surface is DECLARED and
 * not NAVIGATED because those tests are quarantined" is a sentence a team can
 * act on, where "63%" is one they argue about.
 *
 * TEXT IN THE DATABASE, NOT A POSTGRES ENUM, and the judgement is this repo's
 * existing one — `MutationSurvivor.reason`, `Project.closureApprovalPolicy` and
 * `CoverageItem.unexercisableReason` are all stored the same way. The domain is
 * enforced at the producer (`tierCapReasonSchema` in schemas.ts) and nothing
 * filters rows on it, so an enum here would be this round's FIFTH new Postgres
 * type, added purely so that it could need a drift guard of its own.
 */
export const TIER_CAP_REASONS = [
  /** The only evidence is a regex over test source. See the ceiling table. */
  'STATIC_EVIDENCE_ONLY',
  /** The only evidence is somebody declaring it. A claim, not proof. */
  'DECLARATION_ONLY',
  /**
   * The test is quarantined, so its result is suppressed from every gate.
   * Coverage attributed to a quarantined test is coverage nothing will ever
   * check — the item keeps its DECLARED claim and nothing more.
   */
  'TEST_QUARANTINED',
  /** No run has ever executed the matched test. Written is not run. */
  'NO_RUN_OBSERVED',
  /** A run reached it and asserted nothing about it. */
  'NO_ASSERTION_OBSERVED',
  /** It asserted, and the run did not pass. Covered AND failing are two facts. */
  'RUN_NOT_PASSED',
  /** §5: a test that failed then passed on retry is a flake candidate, not a pass. */
  'RETRY_PASS_NOT_A_PASS',
  /** It passed, longer ago than the freshness window. */
  'CONFIRMATION_STALE',
] as const;
export type TierCapReason = (typeof TIER_CAP_REASONS)[number];

export const TIER_CAP_REASON_LABELS: Record<TierCapReason, string> = {
  STATIC_EVIDENCE_ONLY: 'only a static match in the test source',
  DECLARATION_ONLY: 'only a declaration, with no run behind it',
  TEST_QUARANTINED: 'the test is quarantined, so its result gates nothing',
  NO_RUN_OBSERVED: 'no run has executed the matched test',
  NO_ASSERTION_OBSERVED: 'the run reached it and asserted nothing about it',
  RUN_NOT_PASSED: 'the run did not pass',
  RETRY_PASS_NOT_A_PASS: 'it only passed on a retry',
  CONFIRMATION_STALE: 'the last pass is older than the freshness window',
};

// ─── Promotion ───────────────────────────────────────────────────────────────

/**
 * Everything observed about one (test → item) link, as the only input the
 * promotion rule is allowed to see.
 *
 * A flat record of FACTS rather than a row, so the rule can be exercised
 * against a fake with no database, no clock and no browser — and so that
 * nothing in here can be quietly derived from something else. Every field is a
 * separate question, exactly as `SurfaceVerification`'s five are, because
 * merging any two of them is how the number stops being true.
 */
export interface CoverageEdgeEvidence {
  source: CoverageEdgeSource;
  /**
   * A run was observed to REACH this item while executing the test. Only a
   * RUNTIME source can honestly set this; a STATIC or SPEC edge that does is
   * capped anyway by the ceiling table, so a mistaken writer cannot promote.
   */
  navigationObserved: boolean;
  /** The run made at least one assertion attributable to this item. */
  assertionObserved: boolean;
  /**
   * The terminal status the confirming run reported for the test, in the
   * database's own vocabulary. NULL MEANS NO RUN HAS EVER EXECUTED IT, which is
   * the distinction between a coverage number and a coverage claim.
   */
  runStatus: TestResultStatus | null;
  /** §5 — a retry that passes is not a pass. */
  retriedAndPassed: boolean;
  /**
   * Whether the test was quarantined. Separate from `runStatus` because a
   * quarantined test still produces results; what it does not produce is a
   * result anything gates on.
   */
  quarantined: boolean;
  /**
   * When the confirming run finished, ISO-8601. Null when no run confirmed it.
   * Compared against an `nowIso` the caller passes in — this module never reads
   * a clock, so freshness is deterministic and testable.
   */
  confirmedAtIso: string | null;
}

/**
 * The rung, and the two different reasons it is not higher.
 *
 * `cappedBy` and `blockedBy` are deliberately NOT one field. "It reached
 * PASSING and we refuse to count it because the test is quarantined" and "it
 * never got past DECLARED because nothing ran" are different findings with
 * different remedies, and a single `why` string would make the first one
 * indistinguishable from the second in any aggregate.
 */
export interface CoverageTierVerdict {
  /**
   * The rung this edge earns. NULL — never DECLARED — when there is no evidence
   * at all. See the header: not measured is null.
   */
  tier: CoverageTier | null;
  /**
   * The rung the observations alone would have reached, before the source
   * ceiling and quarantine were applied. Equal to `tier` when nothing capped.
   */
  reached: CoverageTier | null;
  /** Why `reached` was demoted to `tier`. Null when nothing demoted it. */
  cappedBy: TierCapReason | null;
  /**
   * Why `reached` is not the next rung up. Null only at FRESH, which is the top
   * — there is nothing above it to be blocked from.
   */
  blockedBy: TierCapReason | null;
  /** The freshness window this verdict was decided against, in days. */
  freshnessDays: number;
  /** One sentence, for the row the customer reads. */
  why: string;
}

/** Lower of two rungs. */
function lowerTier(a: CoverageTier, b: CoverageTier): CoverageTier {
  return COVERAGE_TIER_RANK[a] <= COVERAGE_TIER_RANK[b] ? a : b;
}

/** Whole days between two ISO instants, or null when either is unparseable. */
function daysBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return (to - from) / 86_400_000;
}

/**
 * Whether a confirmation is recent enough to mean anything.
 *
 * Returns null — not false — when either instant is unparseable, because "we
 * cannot tell how old this is" is not the same claim as "it is stale", and
 * collapsing the two would demote every item whose timestamp we failed to read.
 * A FUTURE confirmation (clock skew on a customer's runner) is fresh: refusing
 * it would make a skewed clock look like a stale suite.
 */
export function isFreshConfirmation(
  confirmedAtIso: string,
  nowIso: string,
  freshnessDays: number = DEFAULT_COVERAGE_FRESHNESS_DAYS,
): boolean | null {
  const age = daysBetween(confirmedAtIso, nowIso);
  if (age === null) return null;
  return age <= freshnessDays;
}

/**
 * THE PROMOTION RULE. Deterministic, model-free, and the only place a tier is
 * decided.
 *
 * It walks the ladder from the bottom and stops at the first rung whose
 * evidence is absent, then applies the two ceilings — the source's and
 * quarantine's — and names whichever one bit. Written as a walk rather than as
 * a chain of booleans because the ladder is monotonic: a rung that could be
 * reached without the one below it would break the "34% passing, 61%
 * navigated" reading that is the reason the ladder exists.
 */
export function promoteCoverageTier(
  evidence: CoverageEdgeEvidence,
  nowIso: string,
  freshnessDays: number = DEFAULT_COVERAGE_FRESHNESS_DAYS,
): CoverageTierVerdict {
  // An edge exists, so SOMETHING claims this item is covered. That claim is
  // DECLARED and nothing weaker; there is no rung below it, and null is
  // reserved for items with no edge at all (see `resolveCoverageEdges`).
  let reached: CoverageTier = 'DECLARED';
  let blockedBy: TierCapReason | null = null;

  const ran = evidence.runStatus !== null && evidence.runStatus !== 'SKIPPED';
  if (!ran || !evidence.navigationObserved) {
    blockedBy = 'NO_RUN_OBSERVED';
  } else {
    reached = 'NAVIGATED';
    if (!evidence.assertionObserved) {
      blockedBy = 'NO_ASSERTION_OBSERVED';
    } else {
      reached = 'ASSERTED';
      if (evidence.runStatus !== 'PASSED') {
        blockedBy = 'RUN_NOT_PASSED';
      } else if (evidence.retriedAndPassed) {
        blockedBy = 'RETRY_PASS_NOT_A_PASS';
      } else {
        reached = 'PASSING';
        const fresh =
          evidence.confirmedAtIso === null
            ? null
            : isFreshConfirmation(evidence.confirmedAtIso, nowIso, freshnessDays);
        // null is "we cannot date this pass", which must not read as stale —
        // same rule as `isFreshConfirmation`. An undatable pass stays PASSING
        // and is blocked from FRESH with the reason named.
        if (fresh === true) reached = 'FRESH';
        else blockedBy = 'CONFIRMATION_STALE';
      }
    }
  }

  // The two ceilings. Quarantine is applied first in the reporting order
  // because it is the one a team can clear today.
  let tier = reached;
  let cappedBy: TierCapReason | null = null;

  if (evidence.quarantined) {
    const capped = lowerTier(tier, 'DECLARED');
    if (COVERAGE_TIER_RANK[capped] < COVERAGE_TIER_RANK[tier]) cappedBy = 'TEST_QUARANTINED';
    tier = capped;
  }

  const ceiling = COVERAGE_EDGE_SOURCE_CEILING[evidence.source];
  if (COVERAGE_TIER_RANK[ceiling] < COVERAGE_TIER_RANK[tier]) {
    tier = ceiling;
    cappedBy = evidence.source === 'SPEC' ? 'DECLARATION_ONLY' : 'STATIC_EVIDENCE_ONLY';
  }

  const why = cappedBy
    ? `${COVERAGE_TIER_LABELS[tier]} — reached ${COVERAGE_TIER_LABELS[reached]}, held there because ${TIER_CAP_REASON_LABELS[cappedBy]}`
    : blockedBy
      ? `${COVERAGE_TIER_LABELS[tier]} — not ${COVERAGE_TIER_LABELS[nextTier(tier) ?? tier]} because ${TIER_CAP_REASON_LABELS[blockedBy]}`
      : `${COVERAGE_TIER_LABELS[tier]} — ${COVERAGE_TIER_EVIDENCE[tier]}`;

  return { tier, reached, cappedBy, blockedBy, freshnessDays, why };
}

/** The rung above this one, or null at the top. */
export function nextTier(tier: CoverageTier): CoverageTier | null {
  const index = COVERAGE_TIERS.indexOf(tier);
  return COVERAGE_TIERS[index + 1] ?? null;
}

/**
 * True when a tier is at least `floor`. Null is false — an item with no claim
 * does not satisfy the weakest bar, and `tierAtLeast(null, 'DECLARED')` being
 * true would quietly count every un-evidenced item as declared.
 */
export function tierAtLeast(tier: CoverageTier | null, floor: CoverageTier): boolean {
  if (tier === null) return false;
  return COVERAGE_TIER_RANK[tier] >= COVERAGE_TIER_RANK[floor];
}

// ─── Resolving several edges onto one item ───────────────────────────────────

/**
 * The minimum an edge must carry to be ranked. Structural on purpose, so a
 * Prisma row, an API payload and a test fixture all satisfy it without anyone
 * mapping between three shapes.
 */
export interface RankableEdge {
  source: CoverageEdgeSource;
  tier: CoverageTier;
}

export interface ResolvedCoverage<E extends RankableEdge> {
  /** The item's rung: the highest any surviving edge earns. Null with no edges. */
  tier: CoverageTier | null;
  /**
   * The edge whose sentence the report should print — highest rung, and on a
   * tie the strongest SOURCE. This is where RUNTIME beats STATIC: when a regex
   * and a run both claim DECLARED, the run's evidence is the one worth showing.
   */
  authoritative: E | null;
  /**
   * True when two edges on this item reach DIFFERENT rungs. Reported rather
   * than silently maxed away, because a RUNTIME edge that got no further than
   * DECLARED beside a STATIC one that claims the same thing is how you find out
   * that a test mentions a route it never visits.
   */
  conflicting: boolean;
}

/**
 * Collapse every edge pointing at one item into one rung.
 *
 * MAX, not sum and not average. Two tests covering one item does not make it
 * more covered than the better of the two makes it, and averaging would let a
 * weak second test DROP an item's tier — a product where adding a test lowers
 * the number is a product nobody adds tests to.
 */
export function resolveCoverageEdges<E extends RankableEdge>(
  edges: readonly E[],
): ResolvedCoverage<E> {
  if (edges.length === 0) return { tier: null, authoritative: null, conflicting: false };

  let best = edges[0]!;
  for (const edge of edges.slice(1)) {
    const better =
      COVERAGE_TIER_RANK[edge.tier] > COVERAGE_TIER_RANK[best.tier] ||
      (edge.tier === best.tier && edgeSourceOutranks(edge.source, best.source));
    if (better) best = edge;
  }

  const tiers = new Set(edges.map((edge) => edge.tier));
  return { tier: best.tier, authoritative: best, conflicting: tiers.size > 1 };
}

/**
 * The `SurfaceStatus` a rung corresponds to, so the ladder and the one-word
 * vocabulary cannot drift into two definitions of covered.
 *
 * UNKNOWN and WAIVED are not reachable from here and must not be: UNKNOWN is a
 * statement about the EXTRACTOR (it could not resolve a runtime URL) and WAIVED
 * is a decision the team recorded. Neither is a property of the evidence on an
 * edge, and returning either from this function would let a tier calculation
 * move an item out of the denominator.
 */
export function surfaceStatusForTier(
  tier: CoverageTier | null,
): Extract<SurfaceStatus, 'COVERED' | 'ASSERTED_NOT_RUN' | 'UNCOVERED'> {
  if (tier === null) return 'UNCOVERED';
  return tierAtLeast(tier, MINIMUM_COVERED_TIER) ? 'COVERED' : 'ASSERTED_NOT_RUN';
}

// ─── Ladder arithmetic ───────────────────────────────────────────────────────

/** One rung's reading of one measurement. */
export interface CoverageTierTotals {
  tier: CoverageTier;
  /**
   * Items at this rung OR ABOVE. Cumulative by construction, which is what
   * makes the series monotonic and the two figures comparable.
   */
  atOrAbove: number;
  /** `atOrAbove / denominator`, one decimal, or NULL when there is nothing to divide. */
  percent: number | null;
}

/**
 * The whole ladder for one denominator.
 *
 * ── ONE DENOMINATOR. NOT FOUR ADDED TOGETHER ────────────────────────────────
 *
 * `coverageLadder` takes ONE array of items and its length IS the denominator.
 * It cannot be handed a count that disagrees with the items, and it cannot be
 * handed items from two axes and asked for one figure — that is the caller's
 * decision and the caller has to make it in the open. The headline percentage
 * this product shipped summed routes + journeys + forms + controls into a
 * single fraction, which made controls roughly 80% of the figure and let a code
 * comment naming four labels move the quoted number from 2% to 11%. Two
 * denominators added together to make one percentage is one of the lies this
 * product cannot afford, so the arithmetic here is structurally incapable of
 * it.
 */
export interface CoverageLadder {
  /** Items measured. Waived items are excluded by the CALLER, before this. */
  denominator: number;
  /**
   * Items with no edge of any kind — nothing claims them. Reported beside the
   * rungs rather than folded into "not DECLARED", because it is the one number
   * on the ladder that is a fact about the customer's suite rather than about
   * the strength of its evidence.
   */
  unclaimed: number;
  /** Weakest rung first, each cumulative. */
  tiers: CoverageTierTotals[];
}

/**
 * Build the ladder from one tier per item.
 *
 * `null` entries are items with no edge. They are IN the denominator — an item
 * nothing claims is the gap this product exists to shrink, and dropping it
 * would raise every figure on the ladder at once.
 */
export function coverageLadder(entries: ReadonlyArray<CoverageTier | null>): CoverageLadder {
  const denominator = entries.length;
  return {
    denominator,
    unclaimed: entries.filter((tier) => tier === null).length,
    tiers: COVERAGE_TIERS.map((tier) => {
      const atOrAbove = entries.filter((entry) => tierAtLeast(entry, tier)).length;
      return { tier, atOrAbove, percent: coveragePercent(atOrAbove, denominator) };
    }),
  };
}
