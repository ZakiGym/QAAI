/**
 * The async dimension — crons, queue consumers, webhook receivers, uploads,
 * sockets, server actions, tRPC procedures and transactional email.
 *
 * WHY THIS FILE EXISTS
 *
 * `TEST_TYPES` has carried EMAIL_OTP and PROTOCOL for as long as the runner has
 * existed, so a customer can write — and QAAI can generate — a test for a
 * surface the product cannot count. `SURFACE_KINDS` has had `BACKGROUND_JOB`
 * and `NOTIFICATION` members all along; the ENUMERATE round built the detectors
 * (`detectBackgroundSurfaces` in packages/shared/src/codebase.ts, nine kinds,
 * `BackgroundSurfaceFact`) and `BACKGROUND_SURFACE_DIMENSION` already maps each
 * kind onto `JOB` or `EMAIL`. What has never existed is the denominator: a
 * `SourceBackgroundSurface` is a parse result that nothing counts, so "this app
 * has 14 scheduled jobs and 3 of them have a test" is unsayable, and a webhook
 * receiver with no test anywhere is INVISIBLE rather than uncovered. Invisible
 * raises the percentage. Uncovered lowers it.
 *
 * ── THE EVIDENCE HERE IS WEAKER THAN ON A ROUTE, AND SAYING SO IS THE JOB ───
 *
 * A route has a URL. A browser either reached it or it did not, and the
 * observation is unambiguous. A background surface has neither, and two
 * different weaknesses have to be reported rather than averaged away:
 *
 *   1. WE MAY BE WRONG THAT IT EXISTS. A cron read out of `vercel.json` was
 *      parsed from a file whose purpose is to declare crons. A "job" inferred
 *      from a filename is a regex's opinion. Both would otherwise enter the
 *      denominator identically. {@link ASYNC_DETECTION_BASES} and
 *      {@link ASYNC_DETECTION_CONFIDENCE} keep them apart, and a LOW-confidence
 *      surface STAYS IN the denominator — dropping it would raise the
 *      percentage on the strength of our own uncertainty, which is the one
 *      direction this product must never move for free.
 *
 *   2. A TEST THAT CALLS THE HANDLER HAS NOT EXERCISED THE SURFACE. This is the
 *      distinction the whole file turns on. A unit test that imports
 *      `sendInvoiceReminder` and calls it proves the function works. It proves
 *      nothing about the cron expression that is supposed to call it, and a
 *      schedule that was deleted last quarter passes every one of those tests.
 *      That is exactly the route case: a unit test of a page component does not
 *      make its URL NAVIGATED, because navigation is a different observation.
 *      So {@link ASYNC_REACH_REACHED_SURFACE} is `false` for HANDLER_CALLED,
 *      which feeds `navigationObserved: false` into the ONE promotion rule and
 *      holds the cell at DECLARED — written is not run, stated in the async
 *      vocabulary. A cell whose trigger fired is NAVIGATED and up.
 *
 * ── THE PROMOTION RULE IS NOT REIMPLEMENTED HERE ────────────────────────────
 *
 * `promoteCoverageTier` from @qaai/shared decides every tier below. There is no
 * second ladder, no async-specific rung and no local arithmetic over
 * `COVERAGE_TIER_RANK`: a background surface and a route must mean the same
 * thing by PASSING or the headline is two numbers. What this file supplies is
 * the honest translation of async facts into that rule's five inputs, plus one
 * axis the rule has no field for — {@link AsyncReach}, reported beside the tier
 * rather than folded into it.
 *
 * One deliberate omission follows from that. `CoverageTierVerdict.blockedBy` is
 * NOT copied onto a cell. For a handler-only cell the rule returns
 * `NO_RUN_OBSERVED`, whose label is "no run has executed the matched test" —
 * and a run DID execute it. Storing a reason whose sentence is false about the
 * row is a doc comment contradicting the code under it, so the cell carries
 * `reach` and {@link ASYNC_REACH_EVIDENCE} instead, and the missing
 * `TIER_CAP_REASONS` member is named in this slice's report rather than faked.
 * `cappedBy` IS copied: quarantine and the source ceiling are true here.
 *
 * ── WHAT THIS FILE IS NOT ───────────────────────────────────────────────────
 *
 * It reads nothing. No Prisma, no clock (`nowIso` is an argument, exactly as
 * `promoteCoverageTier` takes one), no network, no model. The detectors are
 * upstream in @qaai/shared and their output is an INPUT here, so this module's
 * logic is exercised against literal facts rather than against a repository
 * fixture — the shape `crawler.ts` is 629 largely untested lines for want of.
 */

import {
  BACKGROUND_SURFACE_DIMENSION,
  COVERAGE_DIMENSION_DESCRIPTORS,
  COVERAGE_TIER_LABELS,
  DEFAULT_COVERAGE_FRESHNESS_DAYS,
  SURFACE_EXERCISABILITY_LABELS,
  UNEXERCISABLE_REASON_LABELS,
  backgroundSurfaceAxis,
  backgroundTrigger,
  dimensionCellIdentity,
  exercisabilityCounts,
  measuredDimension,
  promoteCoverageTier,
  surfaceKey,
  unmeasuredDimension,
} from '@qaai/shared';
import type {
  BackgroundSurfaceFact,
  BackgroundSurfaceKind,
  CoverageDimensionKind,
  CoverageEdgeSource,
  CoverageTier,
  DimensionCapBite,
  DimensionMeasurement,
  DimensionUnmeasuredReason,
  SurfaceDimensionKind,
  SurfaceExercise,
  SurfaceKind,
  SurfaceWaiver,
  TestResultStatus,
  TierCapReason,
} from '@qaai/shared';
import type { Confidence } from './coverage.js';
import { dominantRollupReason, unmeasuredSentence } from './coverage-rollup.js';
import type { RollupItem } from './coverage-rollup.js';

// ─── The two axes these surfaces are counted on ─────────────────────────────

/**
 * The dimensions this module measures.
 *
 * Two, and they are two because `SURFACE_DIMENSION_KINDS` already decided that
 * a job and an outbound email are the two enumerable background dimensions, and
 * `BACKGROUND_SURFACE_DIMENSION` already maps all nine finer kinds onto them. A
 * third axis here would be a third denominator for surface the inventory
 * already counts twice over.
 *
 * Spelled as its own `as const` array rather than filtered out of
 * `COVERAGE_DIMENSIONS`, so the two records below are keyed on a union the
 * compiler can close, and asserted to be a subset of the keystone's list by
 * coverage-async.test.ts.
 */
export const ASYNC_DIMENSIONS = ['BACKGROUND_JOB', 'NOTIFICATION'] as const;
export type AsyncDimensionKind = (typeof ASYNC_DIMENSIONS)[number];

/** Compile-time proof that both members are real `CoverageDimensionKind`s. */
const ASYNC_DIMENSIONS_ARE_COVERAGE_DIMENSIONS: readonly CoverageDimensionKind[] = ASYNC_DIMENSIONS;
void ASYNC_DIMENSIONS_ARE_COVERAGE_DIMENSIONS;

/**
 * Which of the two axes each `SurfaceDimensionKind` belongs to, or null for the
 * four that are not background surface at all.
 *
 * A TOTAL `Record` with explicit nulls rather than a `Partial`, because a
 * seventh `SurfaceDimensionKind` must break this line and make somebody decide
 * whether it is async. A `Partial` would have silently answered `undefined`,
 * and `asyncDimensionFor` would have thrown at run time on a customer's data
 * instead of at compile time on ours.
 *
 * It exists at all — rather than relying on `backgroundSurfaceAxis` returning
 * the same two strings — because `SurfaceKind` and `CoverageDimensionKind` are
 * different vocabularies that happen to spell these two members identically.
 * Leaning on that coincidence would make a rename in either list a silent
 * mis-attribution, so coverage-async.test.ts pins this map to
 * `COVERAGE_DIMENSION_DESCRIPTORS[...].cellAxis` for all nine kinds instead.
 */
const ASYNC_DIMENSION_OF_SURFACE_DIMENSION: Record<
  SurfaceDimensionKind,
  AsyncDimensionKind | null
> = {
  ROLE: null,
  LOCALE: null,
  DEVICE: null,
  FLAG: null,
  JOB: 'BACKGROUND_JOB',
  EMAIL: 'NOTIFICATION',
};

/** The dimension one background surface kind is counted on. Total by construction. */
export function asyncDimensionFor(kind: BackgroundSurfaceKind): AsyncDimensionKind {
  const dimension = ASYNC_DIMENSION_OF_SURFACE_DIMENSION[BACKGROUND_SURFACE_DIMENSION[kind]];
  if (dimension === null) {
    /*
     * Unreachable while `BACKGROUND_SURFACE_DIMENSION` maps every kind to JOB
     * or EMAIL — which api-surface.test.ts holds it to. Kept as a throw rather
     * than a fallback because a fallback would quietly file a tenth background
     * kind under the wrong denominator, and a surface counted on the wrong axis
     * is worse than one counted nowhere: it moves a number nobody can trace.
     */
    throw new Error(`${kind} maps to a dimension that is not a background axis`);
  }
  return dimension;
}

/** The `SURFACE_KINDS` axis a background surface's stored item sits on. */
export function asyncAxisFor(kind: BackgroundSurfaceKind): SurfaceKind {
  return backgroundSurfaceAxis(kind);
}

// ─── How we came to believe the surface exists ──────────────────────────────

/**
 * THE BASIS FOR BELIEVING A BACKGROUND SURFACE EXISTS.
 *
 * A closed vocabulary, because the report GROUPS by it and because the grouping
 * is the half a reader can act on: "parsed out of the file that declares your
 * crons" and "a filename looked like a job" are not degrees of one fact, and a
 * denominator that mixed them would be a denominator whose error rate is
 * invisible.
 *
 * This is about the DENOMINATOR, not about coverage. A LOW-confidence surface
 * is still counted — see the header — and what changes is the sentence beside
 * it and the count in {@link AsyncCoverageReport.findings}.
 */
export const ASYNC_DETECTION_BASES = [
  /**
   * Parsed out of a file whose purpose is to declare the surface: the `crons`
   * array in vercel.json, a `schedule:` in a workflow. Structured, not a regex.
   */
  'DECLARED_CONFIG',
  /**
   * An event or message contract declared the channel: an AsyncAPI document, a
   * schema registry. As strong as a config file and from a different direction.
   */
  'ASYNC_CONTRACT',
  /**
   * A library registration read out of source: `cron.schedule('0 3 * * *')`,
   * `@Processor('emails')`, `new Worker('billing')`. The surface and its
   * identity both come from the call, not from the file it sits in.
   */
  'REGISTRATION_CALL',
  /**
   * A handler observed verifying an inbound payload signature. Strong evidence
   * that it RECEIVES something; the path it answers at is derived from the file
   * convention and may be a file path rather than a URL, which is why this is
   * not as strong as a registration.
   */
  'SIGNATURE_VERIFICATION',
  /**
   * A file-convention router places the handler somewhere; the trigger is
   * inferred from where the file sits rather than from anything it says.
   */
  'ROUTE_CONVENTION',
  /**
   * A file or export NAME suggested it and nothing else did. The weakest basis
   * available, and the one this vocabulary exists to be able to report.
   */
  'NAMING_CONVENTION',
  /**
   * A person said so. Stronger than any regex about whether the surface exists
   * — they built it — and silent about whether it is still wired, which is why
   * it is a separate member rather than folded into DECLARED_CONFIG.
   */
  'DECLARED_BY_HUMAN',
  /** A run observed the surface actually fire. The only basis that is an observation. */
  'OBSERVED_DELIVERY',
] as const;
export type AsyncDetectionBasis = (typeof ASYNC_DETECTION_BASES)[number];

/**
 * The compile-time half of the guard this codebase requires for a vocabulary
 * with a write path: a ninth basis breaks THIS line until somebody states what
 * it means, and coverage-async.test.ts compares the derived list against the
 * array at run time. Eight `GateRule` kinds shipped unsaveable for two slices
 * because only one of the two mechanisms existed.
 */
const ASYNC_DETECTION_BASIS_PRESENT: Record<AsyncDetectionBasis, true> = {
  DECLARED_CONFIG: true,
  ASYNC_CONTRACT: true,
  REGISTRATION_CALL: true,
  SIGNATURE_VERIFICATION: true,
  ROUTE_CONVENTION: true,
  NAMING_CONVENTION: true,
  DECLARED_BY_HUMAN: true,
  OBSERVED_DELIVERY: true,
};

export const ASYNC_DETECTION_BASIS_KINDS = Object.keys(
  ASYNC_DETECTION_BASIS_PRESENT,
) as ReadonlyArray<AsyncDetectionBasis>;

export const ASYNC_DETECTION_BASIS_LABELS: Record<AsyncDetectionBasis, string> = {
  DECLARED_CONFIG: 'declared in the config file that exists to declare it',
  ASYNC_CONTRACT: 'declared as a channel by an event or message contract',
  REGISTRATION_CALL: 'registered by a call in the source',
  SIGNATURE_VERIFICATION: 'a handler observed verifying an inbound payload signature',
  ROUTE_CONVENTION: 'placed by a file-convention router; the trigger is inferred',
  NAMING_CONVENTION: 'a file or export name suggested it, and nothing else did',
  DECLARED_BY_HUMAN: 'a person told us it exists',
  OBSERVED_DELIVERY: 'a run observed it fire',
};

/**
 * How much weight each basis carries.
 *
 * `Confidence` is the vocabulary coverage.ts already uses for a gap, imported
 * rather than restated so a LOW-confidence background surface and a LOW
 * confidence route gap mean the same thing on one screen.
 */
export const ASYNC_DETECTION_CONFIDENCE: Record<AsyncDetectionBasis, Confidence> = {
  DECLARED_CONFIG: 'HIGH',
  ASYNC_CONTRACT: 'HIGH',
  REGISTRATION_CALL: 'HIGH',
  SIGNATURE_VERIFICATION: 'MEDIUM',
  ROUTE_CONVENTION: 'MEDIUM',
  NAMING_CONVENTION: 'LOW',
  DECLARED_BY_HUMAN: 'HIGH',
  OBSERVED_DELIVERY: 'HIGH',
};

/**
 * The bases that produce a LOW-confidence surface.
 *
 * DERIVED from {@link ASYNC_DETECTION_CONFIDENCE} and never listed a second
 * time, so a basis downgraded to LOW appears in the report's disclosure in the
 * same commit. A hand-maintained second list is how a weak detector comes to be
 * counted as strong on one screen.
 */
export const LOW_CONFIDENCE_ASYNC_BASES: readonly AsyncDetectionBasis[] =
  ASYNC_DETECTION_BASES.filter((basis) => ASYNC_DETECTION_CONFIDENCE[basis] === 'LOW');

// ─── What a test actually did to the surface ────────────────────────────────

/**
 * HOW FAR INTO A BACKGROUND SURFACE THE SUITE GOT. Weakest first; ORDER IS THE
 * CONTRACT, as it is on the coverage ladder.
 *
 * MONOTONIC, which is what makes the ranks comparable: EFFECT_OBSERVED implies
 * TRIGGER_FIRED. A test that calls the handler directly and then checks the row
 * it wrote is therefore HANDLER_CALLED and NOT EFFECT_OBSERVED — it observed an
 * effect of a function call, and the trigger that is supposed to cause that
 * call was never exercised. Letting such a test claim EFFECT_OBSERVED is the
 * single easiest way to make an unwired cron report as covered, so the rule is
 * stated here and tested rather than left to each caller's judgement.
 *
 * `null` — not a bottom member — means nothing exercised it, matching
 * `CoverageTier | null` and for the same reason: not measured is null, never
 * the weakest value.
 */
export const ASYNC_REACHES = [
  /**
   * A test invoked the handler in process. Proves the function runs; proves
   * nothing about what is supposed to call it.
   */
  'HANDLER_CALLED',
  /**
   * The real trigger was made to fire: a tick, an enqueue, an inbound POST, a
   * send through the application. Nothing checked what it did.
   */
  'TRIGGER_FIRED',
  /** The trigger fired AND the downstream effect was observed where it lands. */
  'EFFECT_OBSERVED',
  /**
   * As above, driven through the application's own path with no harness stub
   * standing in for the producer or the transport.
   */
  'END_TO_END',
] as const;
export type AsyncReach = (typeof ASYNC_REACHES)[number];

/**
 * Where each reach sits. Contiguous from 1 so "one step further in" is
 * arithmetic, and a `Record` so a fifth reach cannot be added without somebody
 * deciding where it ranks — an `indexOf` would have ranked it last silently.
 */
export const ASYNC_REACH_RANK: Record<AsyncReach, number> = {
  HANDLER_CALLED: 1,
  TRIGGER_FIRED: 2,
  EFFECT_OBSERVED: 3,
  END_TO_END: 4,
};

/**
 * WHETHER THE SURFACE ITSELF WAS REACHED, which is the single load-bearing
 * boolean in this file.
 *
 * It becomes `CoverageEdgeEvidence.navigationObserved`, so `false` holds the
 * cell at DECLARED however green the test was. HANDLER_CALLED is the only
 * `false`: calling a function inside a surface is not reaching the surface, in
 * exactly the way that unit-testing a page component is not navigating to its
 * route.
 */
export const ASYNC_REACH_REACHED_SURFACE: Record<AsyncReach, boolean> = {
  HANDLER_CALLED: false,
  TRIGGER_FIRED: true,
  EFFECT_OBSERVED: true,
  END_TO_END: true,
};

/**
 * Whether an assertion attributable to the SURFACE was made.
 *
 * TRIGGER_FIRED is `false`: firing a cron and not looking at what happened is
 * the async form of navigating to a page and asserting nothing, which the
 * ladder already has a rung for.
 */
export const ASYNC_REACH_ASSERTED_EFFECT: Record<AsyncReach, boolean> = {
  HANDLER_CALLED: false,
  TRIGGER_FIRED: false,
  EFFECT_OBSERVED: true,
  END_TO_END: true,
};

export const ASYNC_REACH_LABELS: Record<AsyncReach, string> = {
  HANDLER_CALLED: 'handler called directly',
  TRIGGER_FIRED: 'trigger fired',
  EFFECT_OBSERVED: 'effect observed',
  END_TO_END: 'end to end',
};

/** The sentence a customer reads beside the reach. One per member, so none is unaudited. */
export const ASYNC_REACH_EVIDENCE: Record<AsyncReach, string> = {
  HANDLER_CALLED:
    'a test imported the handler and called it. The function was exercised; the schedule, ' +
    'queue binding or route that is supposed to call it was not, so this cell is held at ' +
    'DECLARED however green the test is.',
  TRIGGER_FIRED:
    'the real trigger was made to fire and the surface was reached. Nothing asserted what it ' +
    'then did.',
  EFFECT_OBSERVED: 'the trigger fired and the downstream effect was observed where it lands.',
  END_TO_END:
    'driven through the application own path, with no harness stub standing in for the producer ' +
    'or the transport.',
};

/** The weakest reach that counts as having reached the surface at all. */
export const MINIMUM_TRIGGERED_REACH: AsyncReach = 'TRIGGER_FIRED';

/**
 * Everything the suite is known to have done to one background surface.
 *
 * A flat record of separate FACTS, the shape `CoverageEdgeEvidence` and
 * `SurfaceVerification` both take, because merging any two of these is how the
 * number stops being true. Every field is a different question and none is
 * derivable from another.
 */
export interface AsyncExercise {
  /** How far in the suite got. Null means nothing ran against it. */
  reach: AsyncReach | null;
  /**
   * Tests whose SOURCE names this surface — a queue string, a cron handler
   * path, a template id. A static match, which can never be more than DECLARED.
   */
  namedByTestIds: readonly string[];
  /** Tests that DECLARE they cover it. A claim, and capped at DECLARED too. */
  declaredByTestIds: readonly string[];
  /**
   * The terminal status of the confirming run, in the database's vocabulary.
   * NULL MEANS NO RUN EVER EXECUTED IT, which is the difference between a
   * coverage number and a coverage claim.
   */
  runStatus: TestResultStatus | null;
  /** A retry that passes is not a pass. */
  retriedAndPassed: boolean;
  /** A quarantined test gates nothing, so coverage from it is coverage nothing checks. */
  quarantined: boolean;
  /** When the confirming run finished, ISO-8601. Null when no run confirmed it. */
  confirmedAtIso: string | null;
}

// ─── What goes in ───────────────────────────────────────────────────────────

/**
 * One background surface as the enumerate round found it, plus what the suite
 * did to it.
 *
 * `fact` is `BackgroundSurfaceFact` straight from @qaai/shared, never re-spelled
 * here: the whole point of that union is that a cron's expression and a queue's
 * name are different facts, and a tenth spelling of them in this file would be
 * the second registry the enumerate round was arranged to prevent.
 */
export interface AsyncSurfaceInput {
  fact: BackgroundSurfaceFact;
  /** REQUIRED. There is no default basis, because a default would be a confidence nobody measured. */
  basis: AsyncDetectionBasis;
  /** The detector's own sentence. What makes the denominator auditable rather than asserted. */
  evidence: string;
  file: string | null;
  /** Whether a test may drive it here. Null means nobody classified it, which COUNTS. */
  exercise: SurfaceExercise | null;
  /** The team's decision not to test it. Leaves the denominator, with an owner and an expiry. */
  waiver: SurfaceWaiver | null;
  /** What the suite did. Null is the one spelling of "the suite says nothing about this". */
  tested: AsyncExercise | null;
}

export interface AsyncCoverageInput {
  surfaces: readonly AsyncSurfaceInput[];
  /**
   * WHETHER ANYTHING ENUMERATED EACH AXIS FOR THIS SUBJECT. Required and total,
   * so the caller must state both.
   *
   * This separates two opposite facts that an empty `surfaces` list cannot tell
   * apart: "we read this repository and it has no cron jobs" (a measurement,
   * denominator 0, percent null) and "nothing has ever looked for cron jobs
   * here" (NOT_ENUMERATED, and not a gap in the customer's testing). Defaulting
   * it to `true` would report our own silence as their clean bill of health.
   */
  enumerated: Record<AsyncDimensionKind, boolean>;
  /** ISO-8601. This module never reads a clock; freshness has to be deterministic. */
  nowIso: string;
  freshnessDays?: number;
  /**
   * Caps that bit upstream — `MAX_BACKGROUND_SURFACES` in codebase.ts is 1,000
   * and it reports how many it dropped. Carried through onto the measurement
   * rather than left in an analysis shortfall nothing reads, because a cap that
   * shrank the denominator is a fact about the figure this module prints.
   */
  upstreamCaps?: readonly DimensionCapBite[];
}

// ─── What comes out ─────────────────────────────────────────────────────────

/** Why one cell left the denominator. Counted and named, never silently dropped. */
export interface AsyncHoldOut {
  reason: DimensionUnmeasuredReason;
  detail: string;
}

/**
 * ONE ASYNC CELL: one cron, one queue consumer, one webhook receiver, one
 * template.
 *
 * `tier` and `reach` are both present and neither is derived from the other for
 * display. `tier` is where this cell sits on the ONE coverage ladder, so it is
 * comparable to a route's. `reach` is how far into the surface the suite got,
 * which the ladder has no field for and which is the fact that distinguishes a
 * unit-tested handler from an end-to-end delivery.
 */
export interface AsyncCell {
  /** `surfaceKey(axis, dimensionCellIdentity(...))` — the stored `CoverageItem.key`. */
  key: string;
  /** The cell identity inside the axis, as `dimensionCellIdentity` spells it. */
  cellIdentity: string;
  dimension: AsyncDimensionKind;
  axis: SurfaceKind;
  kind: BackgroundSurfaceKind;
  label: string;
  /** The coarse trigger word, or null for an email, which has no trigger. */
  trigger: string | null;
  basis: AsyncDetectionBasis;
  confidence: Confidence;
  /** How far in the suite got. Null means nothing ran against it. */
  reach: AsyncReach | null;
  /** The rung on the one ladder. Null means nothing claims it at all. */
  tier: CoverageTier | null;
  /**
   * Why `reach`'s observations were demoted — quarantine, or the static/spec
   * ceiling. `blockedBy` is deliberately absent; see the file header.
   */
  tierCappedBy: TierCapReason | null;
  /** Non-null when this cell is NOT in the denominator. */
  heldOut: AsyncHoldOut | null;
  evidence: string;
  /** One sentence joining the tier and the reach. The only place the two are joined. */
  why: string;
}

export interface AsyncCoverageReport {
  cells: AsyncCell[];
  /**
   * One reading per axis, NEVER SUMMED. A cron and an email template are two
   * things to test, so they are two denominators — `multiAxisDenominator` adds
   * cell COUNTS and this module deliberately offers no combined percentage,
   * because two denominators added together to make one percentage is the lie
   * this product has already been burned by.
   */
  byDimension: Record<AsyncDimensionKind, DimensionMeasurement>;
  /** The sentences a reader forwards. Bounded by construction, not by a cap. */
  findings: string[];
  /** Every cap that bit, this module's and the caller's. */
  caps: DimensionCapBite[];
}

// ─── Caps ───────────────────────────────────────────────────────────────────

/**
 * The most async cells one call will measure.
 *
 * Two thousand, which is twice `MAX_BACKGROUND_SURFACES` in codebase.ts: the
 * source detectors cap themselves at 1,000 and a contract import can contribute
 * channels on top, so a limit at 1,000 here would re-truncate an already
 * truncated list and report the second cut as the first.
 *
 * The TAIL is dropped and the input order is kept, which is the detectors'
 * order. Re-ranking first would make the surviving set depend on a score this
 * module invented, and the dropped set would then be unexplainable to the
 * person whose job just vanished from the report.
 */
export const MAX_ASYNC_CELLS = 2_000;

// ─── Cell identity ──────────────────────────────────────────────────────────

/**
 * The identity of one background surface INSIDE its kind.
 *
 * ── A KNOWN DUPLICATION, STATED RATHER THAN HIDDEN ─────────────────────────
 *
 * `backgroundIdentity` in packages/shared/src/codebase.ts is the same switch and
 * is module-private there, where it serves as a dedupe key inside one analysis
 * and is never stored. This one IS stored, as part of `CoverageItem.key`. They
 * must agree, because if this one is COARSER than that one, two surfaces the
 * detector kept apart collide here — and `measureAsyncCoverage` throws on that
 * collision rather than counting one cell twice, which is the guard that makes
 * the divergence loud instead of arithmetic.
 *
 * Exported from codebase.ts is where this belongs; that line is named in this
 * slice's report. Until it exists this switch is exhaustive over
 * `BackgroundSurfaceFact`, so a tenth kind is a compile error here too.
 */
export function asyncSurfaceIdentity(fact: BackgroundSurfaceFact): string {
  switch (fact.kind) {
    case 'CRON':
      return `${fact.expression}|${fact.handler ?? ''}`;
    case 'QUEUE_CONSUMER':
      return fact.queue;
    case 'WEBHOOK_RECEIVER':
    case 'UPLOAD':
    case 'WEBSOCKET':
    case 'SSE':
      return fact.path;
    case 'OUTBOUND_EMAIL':
      return fact.templateId;
    case 'SERVER_ACTION':
      return `${fact.module}#${fact.exportName}`;
    case 'TRPC_PROCEDURE':
      return fact.procedure;
  }
}

/**
 * The cell identity, through `dimensionCellIdentity` and never by string
 * concatenation.
 *
 * That function is THE one cell-key format in this round — its ordering,
 * case-preservation and percent-encoding rules are what make a cell diffable
 * across runs — and a second format here would make the async dimension
 * silently uncomparable to every other one. The base is the finer
 * `BackgroundSurfaceKind` and the single coordinate is the JOB or EMAIL
 * dimension row, which is also why a WEBSOCKET and an SSE at the same path are
 * two cells rather than one: `asyncSurfaceIdentity` returns `path` for both, and
 * the kind is what tells them apart.
 */
export function asyncCellIdentity(fact: BackgroundSurfaceFact): string {
  return dimensionCellIdentity(fact.kind, [
    { dimension: BACKGROUND_SURFACE_DIMENSION[fact.kind], value: asyncSurfaceIdentity(fact) },
  ]);
}

/** The stored `CoverageItem.key` for one background surface. */
export function asyncCellKey(fact: BackgroundSurfaceFact): string {
  return surfaceKey(asyncAxisFor(fact.kind), asyncCellIdentity(fact));
}

/** A short human label, from the facts the surface actually carries. */
export function asyncCellLabel(fact: BackgroundSurfaceFact): string {
  switch (fact.kind) {
    case 'CRON':
      return `cron ${fact.expression}${fact.handler === null ? '' : ` — ${fact.handler}`}`;
    case 'QUEUE_CONSUMER':
      return `queue ${fact.queue}`;
    case 'WEBHOOK_RECEIVER':
      return `webhook ${fact.path}`;
    case 'OUTBOUND_EMAIL':
      return `email ${fact.templateId}`;
    case 'UPLOAD':
      return `upload ${fact.path}`;
    case 'WEBSOCKET':
      return `websocket ${fact.path}`;
    case 'SSE':
      return `server-sent events ${fact.path}`;
    case 'SERVER_ACTION':
      return `server action ${fact.exportName} in ${fact.module}`;
    case 'TRPC_PROCEDURE':
      return `tRPC ${fact.procedure}`;
  }
}

// ─── Held out of the denominator ────────────────────────────────────────────

/**
 * Whether this cell is in the denominator, and the sentence if not.
 *
 * Both reasons land on HELD_OUT, which is the keystone's single code for "left
 * the denominator on purpose", and the DETAIL is what tells them apart —
 * because they are not the same kind of thing and the report's wording has to
 * differ. A WAIVER is the team's decision and carries an owner and an expiry.
 * UNEXERCISABLE or REFUSED is OUR harness's limit and carries neither, so it
 * has to be named as our limit rather than as their waiver.
 *
 * A surface with BOTH gets both sentences. Dropping one would hide either the
 * owner or the limit, and a reader needs to know which of the two they can
 * clear.
 */
function holdOutFor(surface: AsyncSurfaceInput): AsyncHoldOut | null {
  const parts: string[] = [];
  const waiver = surface.waiver;
  if (waiver !== null) {
    parts.push(
      `waived by ${waiver.byEmail ?? waiver.byUserId ?? 'an unrecorded owner'}: ${waiver.reason}` +
        (waiver.expiresAtIso === null
          ? ' (no expiry — a waiver with no expiry is how a denominator shrinks forever)'
          : ` (expires ${waiver.expiresAtIso})`),
    );
  }
  const exercise = surface.exercise;
  if (exercise !== null && !exercisabilityCounts(exercise.state)) {
    const reason = exercise.reason ?? null;
    parts.push(
      `${SURFACE_EXERCISABILITY_LABELS[exercise.state]} — our limit, not a waiver: ` +
        `${exercise.detail}` +
        (reason === null ? '' : ` (${UNEXERCISABLE_REASON_LABELS[reason]})`) +
        (exercise.rule === null || exercise.rule === undefined
          ? ''
          : ` (policy rule ${exercise.rule})`),
    );
  }
  if (parts.length === 0) return null;
  return { reason: 'HELD_OUT', detail: parts.join('; ') };
}

// ─── The tier ───────────────────────────────────────────────────────────────

/**
 * Which source of evidence this cell's strongest claim comes from, or null for
 * no claim at all.
 *
 * RUNTIME outranks SPEC outranks STATIC, which is not a preference: one is a
 * record of what a run did, one is somebody stating an intention, one is a
 * regular expression's opinion about a string in a file. The ranking is
 * `COVERAGE_EDGE_SOURCE_RANK`'s and this function only picks the strongest
 * available, so the ceiling table in coverage-tiers.ts does the capping.
 */
function edgeSourceFor(tested: AsyncExercise | null): CoverageEdgeSource | null {
  if (tested === null) return null;
  if (tested.reach !== null) return 'RUNTIME';
  if (tested.declaredByTestIds.length > 0) return 'SPEC';
  if (tested.namedByTestIds.length > 0) return 'STATIC';
  return null;
}

/**
 * One cell's rung, through the ONE promotion rule.
 *
 * The three translations this function performs, and nothing else:
 *
 *   · `navigationObserved` ← {@link ASYNC_REACH_REACHED_SURFACE}. The whole
 *     file turns on this; see the header.
 *   · `assertionObserved` ← {@link ASYNC_REACH_ASSERTED_EFFECT}.
 *   · a reach with no `runStatus` is a writer that recorded an observation and
 *     not how the run ended. `promoteCoverageTier` reads that as no run and
 *     holds the cell at DECLARED, which is the conservative answer and the one
 *     this module wants: a claimed observation with no result behind it must not
 *     promote.
 */
function tierFor(
  tested: AsyncExercise | null,
  nowIso: string,
  freshnessDays: number,
): { tier: CoverageTier | null; cappedBy: TierCapReason | null; ladderWhy: string | null } {
  const source = edgeSourceFor(tested);
  if (source === null || tested === null) {
    return { tier: null, cappedBy: null, ladderWhy: null };
  }
  const reach = tested.reach;
  const verdict = promoteCoverageTier(
    {
      source,
      navigationObserved: reach === null ? false : ASYNC_REACH_REACHED_SURFACE[reach],
      assertionObserved: reach === null ? false : ASYNC_REACH_ASSERTED_EFFECT[reach],
      runStatus: tested.runStatus,
      retriedAndPassed: tested.retriedAndPassed,
      quarantined: tested.quarantined,
      confirmedAtIso: tested.confirmedAtIso,
    },
    nowIso,
    freshnessDays,
  );
  return { tier: verdict.tier, cappedBy: verdict.cappedBy, ladderWhy: verdict.why };
}

/** The sentence joining the tier and the reach. The one place they are joined. */
function whyFor(
  tier: CoverageTier | null,
  reach: AsyncReach | null,
  heldOut: AsyncHoldOut | null,
  basis: AsyncDetectionBasis,
  ladderWhy: string | null,
): string {
  const confidence = ASYNC_DETECTION_CONFIDENCE[basis];
  const detection =
    confidence === 'LOW'
      ? ` Detected only because ${ASYNC_DETECTION_BASIS_LABELS[basis]}, so this surface is LOW ` +
        'confidence and may not exist; it is counted anyway, because dropping it would raise the ' +
        'percentage on the strength of our own uncertainty.'
      : '';
  if (heldOut !== null) {
    return `not scored — ${heldOut.detail}.${detection}`;
  }
  if (tier === null || reach === null) {
    const claim =
      tier === null
        ? 'nothing in the suite names, declares or exercises this surface'
        : `${COVERAGE_TIER_LABELS[tier]} — ${ladderWhy ?? 'a claim with no run behind it'}`;
    return `${claim}.${detection}`;
  }
  return `${COVERAGE_TIER_LABELS[tier]} — ${ASYNC_REACH_EVIDENCE[reach]}${detection}`;
}

// ─── The entry point ────────────────────────────────────────────────────────

/**
 * Measures both async axes.
 *
 * ── THE FOUR REFUSALS ──────────────────────────────────────────────────────
 *
 * Throws rather than skipping, for the reason `rollupCoverage` throws: a
 * skipped surface is a surface missing from a denominator with nothing on
 * screen to say so, and a denominator is read as exhaustive by everybody who
 * sees one.
 *
 *   1. TWO SURFACES WITH ONE CELL KEY. One cell counted twice inflates the
 *      numerator and the denominator together, so the percentage still looks
 *      plausible and no eyeball check finds it. It also means this module's
 *      identity is coarser than the detector's — see `asyncSurfaceIdentity`.
 *   2. A SURFACE ON AN AXIS THE CALLER SAID WAS NEVER ENUMERATED. The two
 *      statements cannot both be true, and the one the caller would not notice
 *      is the one that reports our silence as their clean result.
 *   3. AN EMPTY EVIDENCE SENTENCE. The sentence is what makes the denominator
 *      auditable rather than asserted.
 *   4. A HELD-OUT CELL WITH NO SENTENCE — refused by `holdOutFor`'s callers for
 *      the same reason.
 */
export function measureAsyncCoverage(input: AsyncCoverageInput): AsyncCoverageReport {
  const freshnessDays = input.freshnessDays ?? DEFAULT_COVERAGE_FRESHNESS_DAYS;
  const upstreamCaps = input.upstreamCaps ?? [];

  const kept = input.surfaces.slice(0, MAX_ASYNC_CELLS);
  const dropped = input.surfaces.slice(MAX_ASYNC_CELLS);

  const cells: AsyncCell[] = [];
  const seen = new Set<string>();
  for (const surface of kept) {
    if (surface.evidence.length === 0) {
      throw new Error(
        `${asyncCellKey(surface.fact)} has no evidence sentence — an item with no stated reason ` +
          'to exist is a denominator nobody can audit',
      );
    }
    const dimension = asyncDimensionFor(surface.fact.kind);
    if (!input.enumerated[dimension]) {
      throw new Error(
        `${asyncCellKey(surface.fact)} was handed to a measurement that declares ${dimension} ` +
          'was never enumerated — those two statements cannot both be true',
      );
    }
    const key = asyncCellKey(surface.fact);
    if (seen.has(key)) {
      throw new Error(
        `${key} appears twice — that is one cell counted twice, and it means this module's cell ` +
          "identity is coarser than the detector's",
      );
    }
    seen.add(key);

    const heldOut = holdOutFor(surface);
    const reach = surface.tested?.reach ?? null;
    const { tier, cappedBy, ladderWhy } = tierFor(surface.tested, input.nowIso, freshnessDays);

    cells.push({
      key,
      cellIdentity: asyncCellIdentity(surface.fact),
      dimension,
      axis: asyncAxisFor(surface.fact.kind),
      kind: surface.fact.kind,
      label: asyncCellLabel(surface.fact),
      /*
       * Through `backgroundTrigger` and never a second switch:
       * `DimensionDetail.JOB.trigger` documents five words — CRON, QUEUE,
       * WEBHOOK, STARTUP, MANUAL — and writing nine into a field whose doc
       * comment names five would make that comment false. Null for an email,
       * which has no trigger at all.
       */
      trigger: backgroundTrigger(surface.fact.kind),
      basis: surface.basis,
      confidence: ASYNC_DETECTION_CONFIDENCE[surface.basis],
      reach,
      tier,
      tierCappedBy: cappedBy,
      heldOut,
      evidence: surface.evidence,
      why: whyFor(tier, reach, heldOut, surface.basis, ladderWhy),
    });
  }

  const caps: DimensionCapBite[] = [];
  const droppedByDimension = new Map<AsyncDimensionKind, number>();
  if (dropped.length > 0) {
    for (const surface of dropped) {
      const dimension = asyncDimensionFor(surface.fact.kind);
      droppedByDimension.set(dimension, (droppedByDimension.get(dimension) ?? 0) + 1);
    }
    caps.push({
      cap: 'maxAsyncCells',
      limit: MAX_ASYNC_CELLS,
      /*
       * Exact, because this module HELD the dropped surfaces and counted them.
       * `atLeastMore` is null only where the reader genuinely cannot tell — a
       * wall-clock timeout — and a null here would weaken a sentence we can
       * make precisely.
       */
      atLeastMore: dropped.length,
      detail:
        `${dropped.length} further background surface(s) were enumerated and are not measured; ` +
        `at most ${MAX_ASYNC_CELLS} are measured per run and the tail of the detectors' own ` +
        'order was dropped',
    });
  }
  caps.push(...upstreamCaps);

  const byDimension = {
    BACKGROUND_JOB: measureOne('BACKGROUND_JOB', cells, input, droppedByDimension, caps),
    NOTIFICATION: measureOne('NOTIFICATION', cells, input, droppedByDimension, caps),
  };

  return { cells, byDimension, findings: findingsFor(cells, kept, byDimension, caps), caps };
}

/**
 * One axis's reading.
 *
 * `unmeasuredDimension` when nothing enumerated the axis, `measuredDimension`
 * otherwise, and the two are not interchangeable: the first produces a NULL
 * percent at every rung by arithmetic, which is what "we never looked" has to
 * render as. Reporting it as 0% would be a claim about the customer's
 * application assembled out of our own silence.
 */
function measureOne(
  dimension: AsyncDimensionKind,
  cells: readonly AsyncCell[],
  input: AsyncCoverageInput,
  droppedByDimension: ReadonlyMap<AsyncDimensionKind, number>,
  caps: readonly DimensionCapBite[],
): DimensionMeasurement {
  const noun = COVERAGE_DIMENSION_DESCRIPTORS[dimension].cellNoun;
  if (!input.enumerated[dimension]) {
    return unmeasuredDimension({
      dimension,
      reason: 'NOT_ENUMERATED',
      detail:
        `nothing enumerated this project's ${noun}s, so the denominator is unknown rather than ` +
        'zero — this is a hole in our reading and not a gap in their testing',
      cells: 0,
      caps: [...caps],
    });
  }

  const mine = cells.filter((cell) => cell.dimension === dimension);
  const counted = mine.filter((cell) => cell.heldOut === null);
  const reasonCounts = new Map<DimensionUnmeasuredReason, number>();
  for (const cell of mine) {
    const heldOut = cell.heldOut;
    if (heldOut === null) continue;
    reasonCounts.set(heldOut.reason, (reasonCounts.get(heldOut.reason) ?? 0) + 1);
  }
  const droppedHere = droppedByDimension.get(dimension) ?? 0;
  if (droppedHere > 0)
    reasonCounts.set('CAP_BIT', (reasonCounts.get('CAP_BIT') ?? 0) + droppedHere);

  const unmeasured = mine.length - counted.length + droppedHere;
  const reason = dominantRollupReason(reasonCounts);
  return measuredDimension({
    dimension,
    measuredCells: counted.map((cell) => cell.tier),
    unmeasured,
    unmeasuredReason: reason,
    unmeasuredDetail: unmeasuredSentence(reasonCounts),
    /*
     * The cap list travels onto BOTH readings even when the bite dropped cells
     * from only one. A reader of the NOTIFICATION figure needs to know the run
     * was truncated; filtering the bite to the axis it happened to land on
     * would make the other axis look untouched by a limit that governed it.
     */
    caps: [...caps],
  });
}

/**
 * The sentences a reader forwards.
 *
 * Bounded by construction — one per fact, not one per cell — so there is no cap
 * to disclose here. The counts come from the cells and the ladders, never from
 * a second traversal, so a sentence cannot disagree with the figure above it.
 */
function findingsFor(
  cells: readonly AsyncCell[],
  /**
   * The surfaces the cells were built from, in the same order.
   *
   * Needed because one finding is about a FACT — a webhook receiver whose
   * signature scheme was unreadable — and the fact lives on
   * `BackgroundSurfaceFact`, not on the cell. The alternative was a substring
   * match against the detector's own prose, which is a finding that disappears
   * the day somebody rewords a sentence in codebase.ts.
   */
  surfaces: readonly AsyncSurfaceInput[],
  byDimension: Record<AsyncDimensionKind, DimensionMeasurement>,
  caps: readonly DimensionCapBite[],
): string[] {
  const findings: string[] = [];

  for (const dimension of ASYNC_DIMENSIONS) {
    const measurement = byDimension[dimension];
    const noun = COVERAGE_DIMENSION_DESCRIPTORS[dimension].cellNoun;
    if (measurement.unmeasuredReason === 'NOT_ENUMERATED' && measurement.cells === 0) {
      findings.push(
        `${noun}s were never enumerated for this project, so there is no denominator for them — ` +
          'not 0% covered',
      );
      continue;
    }
    if (measurement.measured === 0 && measurement.unmeasured === 0) {
      findings.push(`this project has no ${noun}s; the detectors ran and found none`);
      continue;
    }
    if (measurement.tiers.unclaimed === measurement.measured && measurement.measured > 0) {
      findings.push(
        `no test anywhere names, declares or exercises any of this project's ` +
          `${measurement.measured} ${noun}(s)`,
      );
    }
  }

  const handlerOnly = cells.filter(
    (cell) => cell.heldOut === null && cell.reach === 'HANDLER_CALLED',
  );
  if (handlerOnly.length > 0) {
    findings.push(
      `${handlerOnly.length} of ${cells.filter((cell) => cell.heldOut === null).length} ` +
        'background surface(s) are proven only by a direct handler call. The handler runs; the ' +
        'schedule, queue binding or route that is supposed to call it is exercised by nothing, ' +
        'so each is held at DECLARED rather than counted as passing',
    );
  }

  const lowConfidence = cells.filter((cell) => cell.confidence === 'LOW');
  if (lowConfidence.length > 0) {
    findings.push(
      `${lowConfidence.length} surface(s) rest on a naming convention alone and are LOW ` +
        'confidence: they may not exist. They are counted in the denominator anyway, because ' +
        'dropping them would raise the percentage on the strength of our own uncertainty',
    );
  }

  /*
   * `signatureScheme: null` is "we could not read it", which is NOT `none` —
   * api-surface.ts says so on the field — and the difference decides whether an
   * unsigned-payload negative case is a valid test or a guess that reports the
   * application's 200 as a vulnerability.
   */
  const unsigned = surfaces.filter(
    (surface) => surface.fact.kind === 'WEBHOOK_RECEIVER' && surface.fact.signatureScheme === null,
  );
  if (unsigned.length > 0) {
    findings.push(
      `${unsigned.length} inbound webhook receiver(s) have no readable signature scheme, which ` +
        'is not the same as none — an unsigned-payload negative case against them would be a ' +
        'guess rather than a test',
    );
  }

  const heldOut = cells.filter((cell) => cell.heldOut !== null);
  if (heldOut.length > 0) {
    findings.push(
      `${heldOut.length} background surface(s) left the denominator: ` +
        heldOut.map((cell) => `${cell.key} — ${cell.heldOut?.detail ?? ''}`).join('; '),
    );
  }

  for (const bite of caps) {
    findings.push(
      `${bite.cap} bit at ${bite.limit}: ${bite.detail}` +
        (bite.atLeastMore === null
          ? ' (how many more existed cannot be said)'
          : ` (at least ${bite.atLeastMore} more existed)`),
    );
  }

  return findings;
}

// ─── The seam onto the rollups ──────────────────────────────────────────────

/**
 * Turns async cells into {@link RollupItem}s for one axis.
 *
 * ── ATTRIBUTION IS INJECTED, AND THAT IS THE POINT ─────────────────────────
 *
 * `attribute` is a function the CALLER supplies, because a feature name comes
 * from `featureOf` over the crawl and an owning team comes from
 * `apps/api/src/lib/ownership.ts`'s precedence rules, and neither is something
 * this module can see or should re-derive. A second opinion about who owns a
 * cron would diverge from the first the week after it shipped.
 *
 * Returning null for a cell is NOT how you exclude it — an excluded cell still
 * belongs in the rollup, carrying its reason, or the parts stop reconstructing
 * the whole. So the signature returns the attribution only, and `heldOut`
 * decides membership.
 */
export function asyncRollupItems(
  report: AsyncCoverageReport,
  dimension: AsyncDimensionKind,
  attribute: (cell: AsyncCell) => { feature: string | null; teamId: string | null },
): RollupItem[] {
  return report.cells
    .filter((cell) => cell.dimension === dimension)
    .map((cell) => {
      const { feature, teamId } = attribute(cell);
      return {
        key: cell.key,
        dimension,
        tier: cell.tier,
        feature,
        teamId,
        excluded: cell.heldOut === null ? null : { ...cell.heldOut },
      };
    });
}
