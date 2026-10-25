/**
 * Static-versus-crawl reconciliation — where the product's best sentence lives.
 *
 * WHY THIS FILE EXISTS
 *
 * Both halves of enumeration already shipped. `analyseCodebase` reads the
 * repository and declares routes; `crawl/*` drives a browser and reaches them.
 * The two have never been compared, so the sentence the whole company rests on
 *
 *     "your source declares 412 routes, the crawl reached 25"
 *
 * could not be said, even though every number in it existed on a different
 * screen. This module says it. `headlineOf` below builds that literal sentence,
 * because a sentence assembled by whichever caller happens to render it is a
 * sentence that will eventually be assembled two different ways.
 *
 * WHAT IT PRODUCES
 *
 *   DECLARED_BUT_NEVER_REACHED  the crawl undercounted, or the route is dead
 *                               code. Either answer is worth a meeting, and no
 *                               runtime-only vendor can produce this set at all.
 *   REACHED_BUT_NEVER_DECLARED  OUR source analysis undercounted, or the route
 *                               is built at run time. This is evidence about our
 *                               own error rate and is reported rather than
 *                               suppressed, for the reason surface.ts gives.
 *   DECLARED_AND_REACHED        the only set a competitor could also enumerate.
 *
 * ── SPELLING, AND WHY BOTH ORIGINALS STAY ON THE ROW ────────────────────────
 *
 * The same route is spelled `/users/[id]`, `/users/:id`, `/users/{id}`,
 * `/users/*` and `/users/417` by five different declarers. `canonicalRoute`
 * collapses the first three onto `/users/:param`; the fourth onto `/users/*`;
 * and leaves the fifth alone, because `417` is not syntactically a parameter.
 * So canonical equality alone still reports a route as never reached when a
 * crawl visited a concrete instance of it.
 *
 * Hence TWO passes, and the second one is recorded rather than hidden:
 *
 *   EXACT             the canonical keys are identical.
 *   TEMPLATE          `routeVisits` pairs a template with an instance, or a
 *                     `*` with the subtree it swallows.
 *   METHOD_AGNOSTIC   one side's HTTP verb is UNKNOWN (a Next `route.ts` whose
 *                     body we were never given) and the paths pair.
 *
 * Every row keeps every original spelling with the source that used it, so a
 * human auditing a bad match can see exactly which two strings we decided were
 * one thing. A reconciliation that printed only the canonical form would be
 * un-auditable, and the matcher would be the one component nobody could check.
 *
 * ── A RECONCILIATION WITH A MISSING SOURCE IS NOT A RECONCILIATION ──────────
 *
 * `participation` is on the report unconditionally and `complete` is true only
 * when every source that was asked actually loaded and was counted — a source
 * the project has not set up was not asked, and does not make it false. A
 * sitemap that 404s and a
 * sitemap that lists nothing are different facts: the first is our failure and
 * the second is theirs, and conflating them turns "we could not read it" into
 * "they declare nothing", which raises the recall figure. `SourceParticipation`
 * keeps the three states apart and `notCountedBecause` says why anything was
 * left out.
 *
 * NOTHING HERE CALLS A MODEL, AND NOTHING HERE DOES I/O. Every source is passed
 * in already read. Reconciliation is set arithmetic over strings.
 */

import {
  coveragePercent,
  isObservedSource,
  originFromSources,
  surfaceKey,
  type SurfaceOrigin,
  type SurfaceSource,
} from '@qaai/shared';
import { canonicalRoute, routeVisits } from './coverage.js';
import { endpointIdentity } from './surface-inventory.js';

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * The axes a reconciliation runs on, ONE PER CALL.
 *
 * One per call rather than all at once, because the identity of an endpoint
 * includes a verb and the identity of a route does not. Mixing them in one pass
 * means either endpoints lose their method (so `GET /users` and `DELETE /users`
 * become one surface) or routes gain a fake one. Both are a second key format,
 * which is the thing this slice is under instruction not to create.
 */
export const RECONCILE_AXES = ['ROUTE', 'ENDPOINT'] as const;
export type ReconcileAxis = (typeof RECONCILE_AXES)[number];

/**
 * What happened when a source was asked for its declarations.
 *
 * THE DISTINCTION BETWEEN THE LAST TWO IS THE POINT. `NOT_CONFIGURED` is the
 * customer's choice and costs the reconciliation nothing it is entitled to.
 * `FAILED` is a hole: the document exists, we could not read it, and every
 * surface it would have declared is now missing from the declared set. Reading
 * a FAILED source as "declared nothing" makes the crawl's recall go UP, which
 * is the direction that flatters us.
 */
export const SOURCE_PARTICIPATIONS = ['LOADED', 'FAILED', 'NOT_CONFIGURED'] as const;
export type SourceParticipation = (typeof SOURCE_PARTICIPATIONS)[number];

export const SOURCE_PARTICIPATION_LABELS: Record<SourceParticipation, string> = {
  LOADED: 'read successfully',
  FAILED: 'could not be read — its declarations are missing from this comparison',
  NOT_CONFIGURED: 'not set up for this project',
};

/**
 * Whether a source's absence from this comparison is a HOLE.
 *
 * THE PREDICATE `complete` USED TO GET WRONG, and getting it wrong cost the
 * flag its entire value. `complete` was `participation.every(counted)`, and a
 * NOT_CONFIGURED source is never counted — so a project with a repo and a crawl
 * and no sitemap, no OpenAPI document, no traffic connector and no requirement
 * import (which is every project on the day it signs up, and the caller in
 * apps/api/src/lib/coverage-store.ts passes all eight declarers) reported
 * `complete: false`, headlined "(partial — see the participation list)" and
 * printed "every surface it would have named is missing from the declared set,
 * which raises the reach percentage" about four declarers the customer had
 * deliberately not set up.
 *
 * Two consequences, both bad. The sentence is false: a declarer that does not
 * exist for this project costs the comparison nothing it was entitled to, which
 * is the whole reason `SOURCE_PARTICIPATIONS` keeps NOT_CONFIGURED and FAILED
 * apart. And the flag that exists to stop the word "reconciled" being printed
 * over a failed read was stuck at false, so the one case it was built for —
 * a sitemap that 404s — became indistinguishable from the normal state. An
 * always-false flag flags nothing.
 *
 * A hole is therefore one of exactly two things:
 *
 *   FAILED             the document exists, we could not read it, and every
 *                      surface it would have declared is missing.
 *   LOADED, not counted  it loaded and this comparison threw its entries away
 *                      — today only the environment gate, which drops a crawl
 *                      of somewhere else. We were entitled to that observation
 *                      and do not have it HERE.
 *
 * `buildSurfaceInventory` draws the same line for its own `complete` (its
 * rule 3), which is why this is a predicate and not an inlined `!==`: the two
 * modules answering this question differently is how one application came to
 * have two completeness answers on two screens.
 */
export function participationIsHole(
  report: Pick<SourceParticipationReport, 'participation' | 'counted'>,
): boolean {
  if (report.counted) return false;
  return report.participation !== 'NOT_CONFIGURED';
}

export const RECONCILIATION_STATES = [
  'DECLARED_BUT_NEVER_REACHED',
  'REACHED_BUT_NEVER_DECLARED',
  'DECLARED_AND_REACHED',
] as const;
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

export const RECONCILIATION_STATE_LABELS: Record<ReconciliationState, string> = {
  DECLARED_BUT_NEVER_REACHED: 'declared in a source, never reached by an observation',
  REACHED_BUT_NEVER_DECLARED: 'observed answering, never declared by a source',
  DECLARED_AND_REACHED: 'declared and observed',
};

/** How confident the pairing is. See the header. */
export const MATCH_BASES = ['EXACT', 'TEMPLATE', 'METHOD_AGNOSTIC'] as const;
export type MatchBasis = (typeof MATCH_BASES)[number];

export const MATCH_BASIS_LABELS: Record<MatchBasis, string> = {
  EXACT: 'the canonical keys are identical',
  TEMPLATE: 'a route template was paired with an instance or a subtree',
  METHOD_AGNOSTIC: "one side's HTTP method was unreadable, so the paths were paired without it",
};

// ─── Input ───────────────────────────────────────────────────────────────────

/**
 * A cap that bit while a source was being read.
 *
 * NOT `CapBite` from flow-map.ts, deliberately: that type's `cap` is the closed
 * `CrawlCap` vocabulary, and a sitemap reader's page limit or an OpenAPI
 * reader's `take` is not one of its members. Forcing one would file an
 * unrelated cap under a crawl cap's name. An adapter maps a `CapBite` into this
 * shape; the reverse would need a new `CrawlCap` value, which lives in a file
 * this module does not own.
 *
 * `discarded` is required and is the whole reason this exists: "a limit
 * applied" is an adjective, and the honesty rule is that a cap which bit must
 * be reported as a COUNT as well, so the report can say "at least N more
 * existed" instead of "possibly incomplete".
 */
export interface ReconcileCap {
  /** Which source it bit on. */
  source: SurfaceSource;
  /** What limited the read, in the reader's own words: 'page budget', 'depth'. */
  cap: string;
  /** The limit as applied. */
  limit: number;
  /** Candidates it threw away. The lower bound on what it cost. */
  discarded: number;
  /** The sentence the report prints. */
  reason: string;
}

export interface ReconcileEntry {
  /**
   * The template EXACTLY as this source spelled it. Kept verbatim on the row,
   * never normalised in place — the original is the only thing that makes a
   * suspicious match auditable.
   */
  spelling: string;
  /**
   * The HTTP verb, for the ENDPOINT axis only. Absent or null means the source
   * did not say, which normalises to `UNKNOWN` and is preserved as UNKNOWN
   * rather than guessed — the same rule `HttpEndpoint.method` already states.
   *
   * On the ENDPOINT axis `spelling` is the PATH alone. A reader that has
   * `"GET /users"` as one string must split it before calling; parsing a verb
   * out of a path here would guess for every path whose first segment happens
   * to be a word like `post`.
   */
  method?: string | null;
}

export interface ReconcileSourceInput {
  source: SurfaceSource;
  participation: SourceParticipation;
  /**
   * Why. REQUIRED, including for LOADED, where it says what was read ('42
   * routes from 3 detectors'). A failure with no reason is a failure nobody can
   * act on, and an empty string here would be printed as a blank in the one
   * place a reader looks to find out what went wrong.
   */
  detail: string;
  entries: readonly ReconcileEntry[];
  /**
   * The environment this source observed. Required-by-convention for an
   * observed source and null for a declaration, which is
   * environment-independent.
   *
   * Enforced rather than advisory: an observed source from the wrong
   * environment is DROPPED with a reason, never merged. A staging crawl is not
   * a weaker observation of production, it is an observation of something else
   * — the rule `selectFlowMap` already applies to flow maps, applied here to
   * the sets they feed.
   */
  environmentId?: string | null;
  caps?: readonly ReconcileCap[];
}

export interface ReconcileInput {
  projectId: string;
  environmentId: string;
  axis: ReconcileAxis;
  sources: readonly ReconcileSourceInput[];
}

// ─── Output ──────────────────────────────────────────────────────────────────

/** One source's spelling of one surface. Both sides of a row carry a list of these. */
export interface SpellingRef {
  source: SurfaceSource;
  spelling: string;
}

export interface ReconciledSurface {
  /**
   * The stored `CoverageItem.key` for this surface, built with `surfaceKey` on
   * the axis — the same key the registry uses, so a row joins to a coverage
   * entry without a second format.
   */
  key: string;
  /** The canonical identity inside that key. */
  identity: string;
  state: ReconciliationState;
  /** Null for a matched row only when the basis is EXACT on both sides. */
  matchBasis: MatchBasis | null;
  /** Every declaring source's own spelling. Empty for REACHED_BUT_NEVER_DECLARED. */
  declaredAs: SpellingRef[];
  /** Every observing source's own spelling. Empty for DECLARED_BUT_NEVER_REACHED. */
  reachedAs: SpellingRef[];
  /**
   * The legacy three-valued origin, from `originFromSources` over this row's
   * declarers. Never set by hand beside `state` — two fields saying the same
   * thing is how they come to disagree and only one of them ends up on screen.
   */
  origin: SurfaceOrigin | null;
  /**
   * True when more than one declared template could have absorbed this
   * observation and the most specific was chosen. The flag a human follows when
   * a match looks wrong.
   */
  ambiguous: boolean;
}

export interface SourceParticipationReport {
  source: SurfaceSource;
  participation: SourceParticipation;
  /** Which side of the comparison it feeds, from `isObservedSource`. */
  side: 'DECLARED' | 'REACHED';
  /** Whether its entries entered the comparison at all. */
  counted: boolean;
  /**
   * Whether this source's absence is a HOLE in the comparison. See
   * {@link participationIsHole} — the predicate, so a screen asks the same
   * question rather than re-deriving it from `counted`, which answered a
   * different one.
   */
  hole: boolean;
  /** Set whenever `counted` is false. Never null while counted is false. */
  notCountedBecause: string | null;
  /** Entries it contributed, after normalisation and dedupe. */
  distinctEntries: number;
  detail: string;
}

/**
 * The crawl's coverage of the declared set.
 *
 * A RATIO OF WHAT WE HOLD, not an estimate of anything hidden — that is
 * `PopulationEstimate`'s job and the two must not be read as one number. The
 * denominator is the distinct declared surfaces that PARTICIPATED, which is why
 * `complete` on the report matters so much here: a sitemap that failed to load
 * shrinks this denominator and raises the percentage.
 */
export interface CrawlRecall {
  declared: number;
  /** Declared surfaces an observed source also reached, by any basis. */
  reached: number;
  percent: number | null;
  /** The same count, EXACT matches only. The figure to quote when challenged. */
  exactReached: number;
  exactPercent: number | null;
  /** Matches that needed a template or method relaxation: `reached - exactReached`. */
  relaxedMatches: number;
  rule: string;
}

/**
 * Capture–recapture: how much surface do two sources imply exists beyond both?
 *
 * ── THE ESTIMATOR ───────────────────────────────────────────────────────────
 *
 * Chapman's, not Lincoln–Petersen's:  N̂ = ((n1+1)(n2+1) / (m+1)) − 1
 *
 * Lincoln–Petersen (n1·n2/m) is undefined at m = 0 and badly biased upward for
 * small m, which is exactly the regime a software enumeration lives in.
 * Chapman's is defined everywhere and near-unbiased for small samples. Even so
 * this module REFUSES to report at m = 0 — a number produced from two sources
 * that share no surface at all is arithmetic, not evidence.
 *
 * ── THE ASSUMPTIONS, WHICH ARE USUALLY FALSE ────────────────────────────────
 *
 *   1. CLOSED POPULATION. The application did not gain or lose surface between
 *      the two reads.
 *   2. INDEPENDENCE. Being declared by one source does not change the
 *      probability of being found by the other.
 *   3. CORRECT IDENTIFICATION. Normalisation pairs the same surface across
 *      spellings, and never two different surfaces.
 *   4. SAME POPULATION. Both sources read the same project and environment.
 *   5. HOMOGENEOUS CATCHABILITY. Every surface is equally likely to be found by
 *      each source.
 *
 * Assumption 2 is what makes SOURCE-versus-CRAWL ineligible, and that is the
 * headline pair. A route's presence in the repository CAUSES it to be
 * reachable, and a crawler seeds itself from links the declared routes render,
 * so the two captures are positively correlated — which biases N̂ DOWNWARD and
 * would let us publish a reassuring estimate of hidden surface that is too
 * small. So the honest answer for that pair is UNPROVEN, and the recall ratio
 * above is what gets quoted instead. `INDEPENDENT_SOURCE_PAIRS` is the closed
 * list of pairs this module will estimate across, with a reason per line.
 *
 * Assumption 5 is violated by every real crawl: surface behind a role we do not
 * hold has a capture probability of zero, and heterogeneous catchability also
 * biases N̂ downward. So `beyondBothSources`, when it is reported at all, is a
 * LOWER bound in practice, and `assumptions` says so.
 */
export interface PopulationEstimate {
  state: 'ESTIMATED' | 'UNPROVEN';
  pair: [SurfaceSource, SurfaceSource] | null;
  n1: number;
  n2: number;
  /** EXACT matches only — see the note in `estimatePopulation`. */
  overlap: number;
  /** Chapman's N̂, floored. Null when UNPROVEN: never 0, which would be a claim. */
  totalSurfaces: number | null;
  /** `N̂ − |union of the pair|`, floored at 0. Null when UNPROVEN. */
  beyondBothSources: number | null;
  assumptions: string[];
  /** The estimator used, or why there is no estimate. Always set. */
  reason: string;
}

export interface ReconciliationReport {
  projectId: string;
  environmentId: string;
  axis: ReconcileAxis;
  /** Which sources were asked and what happened. Present unconditionally. */
  participation: SourceParticipationReport[];
  /**
   * True when this comparison has no HOLE: nothing that was asked failed, and
   * nothing that loaded was thrown away. A declarer the project has not set up
   * does not make it false — see {@link participationIsHole}, which is where
   * that distinction is argued and which `buildSurfaceInventory` draws the same
   * way for its own `complete`.
   */
  complete: boolean;
  /**
   * The product's sentence, assembled in one place so two screens cannot word
   * it two ways. See `headlineOf`.
   */
  headline: string;
  /** What this reconciliation is and is not, in one line. */
  verdict: string;
  rows: ReconciledSurface[];
  counts: {
    declaredNeverReached: number;
    reachedNeverDeclared: number;
    declaredAndReached: number;
    /** Of the matched rows, how many needed a relaxation. Discount at will. */
    relaxedMatches: number;
    /** Matched rows where more than one template could have absorbed the observation. */
    ambiguousMatches: number;
  };
  crawlRecall: CrawlRecall;
  populationEstimate: PopulationEstimate;
  /** Every cap that bit on any source, as a count and a reason. */
  caps: ReconcileCap[];
  caveats: string[];
}

// ─── Normalisation ───────────────────────────────────────────────────────────

/** A normalised entry: the comparison key, split so the relaxed passes can reason. */
interface Normalised {
  /** 'UNKNOWN' on the ENDPOINT axis when the source did not say; null on ROUTE. */
  method: string | null;
  path: string;
  identity: string;
}

/**
 * One entry, normalised.
 *
 * The identity is built by `endpointIdentity` on the ENDPOINT axis rather than
 * by a local template string, so this module and `surface-inventory.ts` cannot
 * come to spell the same endpoint two ways. That is the same reasoning the
 * dimension-cell format uses: several independent writers mint these and a row
 * is only diffable if every one of them produces byte-identical keys.
 */
export function normaliseEntry(axis: ReconcileAxis, entry: ReconcileEntry): Normalised {
  if (axis === 'ROUTE') {
    const path = canonicalRoute(entry.spelling);
    return { method: null, path, identity: path };
  }
  const raw = (entry.method ?? '').trim();
  const method = raw.length === 0 ? 'UNKNOWN' : raw.toUpperCase();
  const path = canonicalRoute(entry.spelling);
  return { method, path, identity: endpointIdentity(method, path) };
}

/**
 * Whether two normalised entries are the same surface under a RELAXED rule.
 *
 * Only ever consulted for entries whose exact identities already differ, so a
 * null here means "not even loosely the same thing".
 */
function relaxedBasis(axis: ReconcileAxis, left: Normalised, right: Normalised): MatchBasis | null {
  if (!routeVisits(left.path, right.path)) return null;
  if (axis === 'ROUTE') return 'TEMPLATE';

  const methodsAgree = left.method === right.method;
  const eitherUnknown = left.method === 'UNKNOWN' || right.method === 'UNKNOWN';
  if (!methodsAgree && !eitherUnknown) return null;
  // Report the WEAKER of the two relaxations when both applied, so a reader
  // discounting method-agnostic matches is not shown a reassuring 'TEMPLATE'.
  return methodsAgree ? 'TEMPLATE' : 'METHOD_AGNOSTIC';
}

/**
 * How specific a template is: fewer placeholders is more specific.
 *
 * Used to choose between two declared templates that could both absorb one
 * observation. `/users/:param` beats `/users/*` for `/users/417`, and an
 * UNKNOWN method loses to a stated one. Ties break lexicographically so the
 * choice is deterministic across runs — a non-deterministic pairing would make
 * every run look like a change and destroy the trend the gate depends on.
 */
function specificity(entry: Normalised): [number, number, string] {
  let placeholders = 0;
  for (const segment of entry.path.split('/')) {
    if (segment === ':param' || segment === '*') placeholders += 1;
  }
  return [placeholders, entry.method === 'UNKNOWN' ? 1 : 0, entry.identity];
}

function moreSpecific(left: Normalised, right: Normalised): boolean {
  const a = specificity(left);
  const b = specificity(right);
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

// ─── Independence ────────────────────────────────────────────────────────────

/**
 * The pairs of declarers this module will estimate a population across.
 *
 * A closed list with a reason per line, because independence is not a property
 * anybody can check at run time and an open default would silently publish an
 * estimate for the one pair that most needs refusing.
 *
 * Every pair not listed here — notably SOURCE × CRAWL, the headline pair — is
 * UNPROVEN. See the note on `PopulationEstimate` for why that pair in
 * particular cannot support the arithmetic.
 */
export const INDEPENDENT_SOURCE_PAIRS: ReadonlyArray<readonly [SurfaceSource, SurfaceSource]> = [
  // Real users exercise surface for their own reasons, which have nothing to do
  // with whether a route table in the repository mentions it.
  ['TRAFFIC', 'SOURCE'],
  // A sitemap is written for search engines; traffic is written by people.
  ['TRAFFIC', 'SITEMAP'],
  // An API document is maintained for integrators; traffic is what integrators
  // and the application's own frontend actually call.
  ['TRAFFIC', 'OPENAPI'],
  // A requirement is written before the surface exists, so it cannot have been
  // caused by the surface being easy to observe.
  ['TRAFFIC', 'REQUIREMENT'],
  ['CRAWL', 'REQUIREMENT'],
  // Somebody typing a list from memory is a genuinely separate capture process.
  ['TRAFFIC', 'MANUAL'],
  ['CRAWL', 'MANUAL'],
];

/** Order-insensitive membership in the table above. */
export function pairIsIndependent(left: SurfaceSource, right: SurfaceSource): boolean {
  return INDEPENDENT_SOURCE_PAIRS.some(
    ([a, b]) => (a === left && b === right) || (a === right && b === left),
  );
}

// ─── The reconciliation ──────────────────────────────────────────────────────

interface CountedSource {
  source: SurfaceSource;
  side: 'DECLARED' | 'REACHED';
  /** identity → the original spellings this source used for it. */
  byIdentity: Map<string, { normalised: Normalised; spellings: string[] }>;
}

/**
 * Reconciles the declared and the observed surface for one project, one
 * environment and one axis.
 *
 * Pure set arithmetic over strings passed in already read: no I/O, no model, no
 * network. Every reader is somebody else's module and hands its result here.
 */
export function reconcileSurface(input: ReconcileInput): ReconciliationReport {
  const participation: SourceParticipationReport[] = [];
  const counted: CountedSource[] = [];
  const caps: ReconcileCap[] = [];

  for (const entry of input.sources) {
    const side: 'DECLARED' | 'REACHED' = isObservedSource(entry.source) ? 'REACHED' : 'DECLARED';
    for (const cap of entry.caps ?? []) caps.push(cap);

    if (entry.participation !== 'LOADED') {
      participation.push({
        source: entry.source,
        participation: entry.participation,
        side,
        counted: false,
        // FAILED is a hole; NOT_CONFIGURED is not. See `participationIsHole`.
        hole: participationIsHole({ participation: entry.participation, counted: false }),
        notCountedBecause: `${SOURCE_PARTICIPATION_LABELS[entry.participation]} — ${entry.detail}`,
        distinctEntries: 0,
        detail: entry.detail,
      });
      continue;
    }

    /*
     * The environment gate. An observed source from another environment is
     * DROPPED, not merged and not quietly preferred: its routes are a
     * measurement of a different deployment, and letting them in is how a
     * staging-only route becomes an uncovered production gap. A DECLARED source
     * is environment-independent by definition, so `null` there is correct and
     * is not checked.
     */
    const observedElsewhere =
      side === 'REACHED' &&
      entry.environmentId !== undefined &&
      entry.environmentId !== null &&
      entry.environmentId !== input.environmentId;
    if (observedElsewhere) {
      participation.push({
        source: entry.source,
        participation: entry.participation,
        side,
        counted: false,
        // It LOADED and this comparison threw its entries away, so we are
        // missing an observation we were entitled to: a hole.
        hole: true,
        notCountedBecause:
          `observed in environment ${String(entry.environmentId)}, not ${input.environmentId} — ` +
          'a crawl of another environment is a measurement of something else, not a weaker measurement of this one',
        distinctEntries: 0,
        detail: entry.detail,
      });
      continue;
    }

    const byIdentity = new Map<string, { normalised: Normalised; spellings: string[] }>();
    for (const raw of entry.entries) {
      const normalised = normaliseEntry(input.axis, raw);
      const existing = byIdentity.get(normalised.identity);
      if (existing === undefined) {
        byIdentity.set(normalised.identity, { normalised, spellings: [raw.spelling] });
      } else if (!existing.spellings.includes(raw.spelling)) {
        existing.spellings.push(raw.spelling);
      }
    }

    counted.push({ source: entry.source, side, byIdentity });
    participation.push({
      source: entry.source,
      participation: 'LOADED',
      side,
      counted: true,
      hole: false,
      notCountedBecause: null,
      distinctEntries: byIdentity.size,
      detail: entry.detail,
    });
  }

  // ── The two sides, unioned across the sources on each ──────────────────────
  const declared = new Map<string, { normalised: Normalised; refs: SpellingRef[] }>();
  const reached = new Map<string, { normalised: Normalised; refs: SpellingRef[] }>();
  for (const source of counted) {
    const target = source.side === 'DECLARED' ? declared : reached;
    for (const [identity, held] of source.byIdentity) {
      const existing = target.get(identity);
      const refs = held.spellings.map((spelling) => ({ source: source.source, spelling }));
      if (existing === undefined) target.set(identity, { normalised: held.normalised, refs });
      else existing.refs.push(...refs);
    }
  }

  // ── Pass A: exact ──────────────────────────────────────────────────────────
  const rows: ReconciledSurface[] = [];
  const matchedDeclared = new Set<string>();
  const matchedReached = new Set<string>();

  for (const [identity, declaration] of declared) {
    const observation = reached.get(identity);
    if (observation === undefined) continue;
    matchedDeclared.add(identity);
    matchedReached.add(identity);
    rows.push({
      key: surfaceKey(input.axis, identity),
      identity,
      state: 'DECLARED_AND_REACHED',
      matchBasis: 'EXACT',
      declaredAs: declaration.refs,
      reachedAs: observation.refs,
      origin: originFromSources([
        ...declaration.refs.map((ref) => ref.source),
        ...observation.refs.map((ref) => ref.source),
      ]),
      ambiguous: false,
    });
  }

  /*
   * ── Pass B: relaxed ────────────────────────────────────────────────────────
   *
   * Every leftover observation is offered to every leftover declaration. The
   * observation is absorbed by the MOST SPECIFIC declaration that can take it,
   * and the declaration keeps absorbing: one `/users/:param` legitimately
   * accounts for `/users/1`, `/users/2` and `/users/3`, and minting three
   * "never declared" rows for them would report our own canonicaliser's
   * placeholder convention as the customer's undeclared surface.
   *
   * Driven off a SORTED list of identities rather than Map order, so the result
   * does not depend on insertion sequence.
   */
  const leftoverDeclared = [...declared.keys()].filter((id) => !matchedDeclared.has(id)).sort();
  const leftoverReached = [...reached.keys()].filter((id) => !matchedReached.has(id)).sort();

  const absorbed = new Map<string, { reachedIds: string[]; basis: MatchBasis; ambiguous: boolean }>();
  for (const reachedId of leftoverReached) {
    const observation = reached.get(reachedId);
    if (observation === undefined) continue;

    let best: { id: string; normalised: Normalised; basis: MatchBasis } | null = null;
    let candidates = 0;
    for (const declaredId of leftoverDeclared) {
      const declaration = declared.get(declaredId);
      if (declaration === undefined) continue;
      const basis = relaxedBasis(input.axis, declaration.normalised, observation.normalised);
      if (basis === null) continue;
      candidates += 1;
      if (best === null || moreSpecific(declaration.normalised, best.normalised)) {
        best = { id: declaredId, normalised: declaration.normalised, basis };
      }
    }
    if (best === null) continue;

    matchedReached.add(reachedId);
    const held = absorbed.get(best.id);
    if (held === undefined) {
      absorbed.set(best.id, {
        reachedIds: [reachedId],
        basis: best.basis,
        ambiguous: candidates > 1,
      });
    } else {
      held.reachedIds.push(reachedId);
      // The weaker basis wins for the row as a whole: if any of the absorbed
      // observations needed the method dropped, the row must say so.
      if (best.basis === 'METHOD_AGNOSTIC') held.basis = 'METHOD_AGNOSTIC';
      held.ambiguous = held.ambiguous || candidates > 1;
    }
  }

  for (const [declaredId, held] of absorbed) {
    const declaration = declared.get(declaredId);
    if (declaration === undefined) continue;
    matchedDeclared.add(declaredId);
    const refs: SpellingRef[] = [];
    for (const reachedId of held.reachedIds) {
      const observation = reached.get(reachedId);
      if (observation !== undefined) refs.push(...observation.refs);
    }
    rows.push({
      key: surfaceKey(input.axis, declaredId),
      identity: declaredId,
      state: 'DECLARED_AND_REACHED',
      matchBasis: held.basis,
      declaredAs: declaration.refs,
      reachedAs: refs,
      origin: originFromSources([
        ...declaration.refs.map((ref) => ref.source),
        ...refs.map((ref) => ref.source),
      ]),
      ambiguous: held.ambiguous,
    });
  }

  // ── What is left on each side is the finding ───────────────────────────────
  for (const identity of leftoverDeclared) {
    if (matchedDeclared.has(identity)) continue;
    const declaration = declared.get(identity);
    if (declaration === undefined) continue;
    rows.push({
      key: surfaceKey(input.axis, identity),
      identity,
      state: 'DECLARED_BUT_NEVER_REACHED',
      matchBasis: null,
      declaredAs: declaration.refs,
      reachedAs: [],
      origin: originFromSources(declaration.refs.map((ref) => ref.source)),
      ambiguous: false,
    });
  }
  for (const identity of leftoverReached) {
    if (matchedReached.has(identity)) continue;
    const observation = reached.get(identity);
    if (observation === undefined) continue;
    rows.push({
      key: surfaceKey(input.axis, identity),
      identity,
      state: 'REACHED_BUT_NEVER_DECLARED',
      matchBasis: null,
      declaredAs: [],
      reachedAs: observation.refs,
      origin: originFromSources(observation.refs.map((ref) => ref.source)),
      ambiguous: false,
    });
  }

  rows.sort((left, right) => {
    const order =
      RECONCILIATION_STATES.indexOf(left.state) - RECONCILIATION_STATES.indexOf(right.state);
    return order !== 0 ? order : left.identity.localeCompare(right.identity);
  });

  const matched = rows.filter((row) => row.state === 'DECLARED_AND_REACHED');
  const exactMatches = matched.filter((row) => row.matchBasis === 'EXACT').length;
  const counts = {
    declaredNeverReached: rows.filter((row) => row.state === 'DECLARED_BUT_NEVER_REACHED').length,
    reachedNeverDeclared: rows.filter((row) => row.state === 'REACHED_BUT_NEVER_DECLARED').length,
    declaredAndReached: matched.length,
    relaxedMatches: matched.length - exactMatches,
    ambiguousMatches: matched.filter((row) => row.ambiguous).length,
  };

  const crawlRecall: CrawlRecall = {
    declared: declared.size,
    reached: matched.length,
    percent: coveragePercent(matched.length, declared.size),
    exactReached: exactMatches,
    exactPercent: coveragePercent(exactMatches, declared.size),
    relaxedMatches: counts.relaxedMatches,
    rule:
      `${matched.length} of ${declared.size} declared surface(s) were also observed ` +
      `(${exactMatches} on identical keys, ${counts.relaxedMatches} after pairing a template ` +
      `with an instance). The denominator is the declared set the sources that LOADED produced ` +
      `— a source that failed to load shrinks it and raises this figure, so read it beside ` +
      `the participation list.`,
  };

  /*
   * Complete means NO HOLE, not "every declarer contributed". A declarer the
   * customer never set up is not a hole — see `participationIsHole`, which is
   * where the whole argument lives.
   */
  const complete = !participation.some((report) => report.hole);
  const populationEstimate = estimatePopulation(counted);

  return {
    projectId: input.projectId,
    environmentId: input.environmentId,
    axis: input.axis,
    participation,
    complete,
    headline: headlineOf(input.axis, participation, crawlRecall, counts, complete),
    verdict: verdictOf(participation, complete),
    rows,
    counts,
    crawlRecall,
    populationEstimate,
    caps,
    caveats: reconcileCaveats(participation, counts, caps, populationEstimate, complete),
  };
}

// ─── The estimate ────────────────────────────────────────────────────────────

/**
 * Chapman's estimator over the best eligible pair, or UNPROVEN.
 *
 * `overlap` is EXACT matches only, and that restriction is doing real work: a
 * template match may be one declared template paired with fifty observed
 * instances, and capture–recapture counts INDIVIDUALS. Feeding it a
 * one-to-many pairing would recapture an individual that was never captured, m
 * would be overstated, and N̂ — which moves inversely with m — would come out
 * reassuringly small. Understating hidden surface is the failure mode this
 * product cannot have.
 */
function estimatePopulation(counted: readonly CountedSource[]): PopulationEstimate {
  const assumptions = [
    'closed population: the application gained and lost no surface between the two reads',
    'independence: being found by one source did not change the probability of being found by the other',
    'correct identification: normalisation paired the same surface across spellings and never two different ones',
    'same population: both sources read this project and this environment',
    'homogeneous catchability: every surface was equally likely to be found by each source — violated by any crawl that holds no credentials for a role, which biases the estimate DOWNWARD, so a reported figure is a lower bound in practice',
  ];
  const nothing = {
    pair: null,
    n1: 0,
    n2: 0,
    overlap: 0,
    totalSurfaces: null,
    beyondBothSources: null,
    assumptions,
  } as const;

  if (counted.length < 2) {
    return {
      state: 'UNPROVEN',
      ...nothing,
      reason: `capture–recapture needs two sources that both loaded; ${counted.length} did`,
    };
  }

  let best: { left: CountedSource; right: CountedSource; overlap: number } | null = null;
  let eligiblePairs = 0;
  for (let i = 0; i < counted.length; i += 1) {
    for (let j = i + 1; j < counted.length; j += 1) {
      const left = counted[i];
      const right = counted[j];
      if (left === undefined || right === undefined) continue;
      if (!pairIsIndependent(left.source, right.source)) continue;
      eligiblePairs += 1;
      let overlap = 0;
      for (const identity of left.byIdentity.keys()) {
        if (right.byIdentity.has(identity)) overlap += 1;
      }
      if (best === null || overlap > best.overlap) best = { left, right, overlap };
    }
  }

  if (eligiblePairs === 0) {
    const names = counted.map((source) => source.source).join(', ');
    return {
      state: 'UNPROVEN',
      ...nothing,
      reason:
        `no pair among [${names}] is independent enough to estimate across: a route in the ` +
        `repository CAUSES it to be reachable and a crawler seeds itself from the links those ` +
        `routes render, so SOURCE and CRAWL are positively correlated and the estimate would be ` +
        `biased downward. Quote the recall ratio instead.`,
    };
  }

  /*
   * THE EMPTY-CAPTURE CASE COMES FIRST, and the order is the fix rather than a
   * preference. These two refusals were the other way round, and a source that
   * declared NOTHING on this axis has an overlap of zero by construction — so
   * the zero-overlap branch answered first every time and the empty-capture
   * reason was unreachable. The report then said "the independent sources share
   * no surface on identical keys", which reads as two sources that both found
   * things and failed to agree. "One of them found nothing at all" is a
   * different fact about a different problem (an OpenAPI document with no
   * operations, a traffic connector with no routes on this axis), and it is the
   * one a reader can act on.
   */
  const n1 = best === null ? 0 : best.left.byIdentity.size;
  const n2 = best === null ? 0 : best.right.byIdentity.size;
  if (best !== null && (n1 === 0 || n2 === 0)) {
    return {
      state: 'UNPROVEN',
      pair: [best.left.source, best.right.source],
      n1,
      n2,
      overlap: best.overlap,
      totalSurfaces: null,
      beyondBothSources: null,
      assumptions,
      reason:
        `one of the independent sources declared nothing on this axis (${best.left.source} ${n1}, ` +
        `${best.right.source} ${n2}), so it captured nothing to recapture`,
    };
  }

  if (best === null || best.overlap === 0) {
    return {
      state: 'UNPROVEN',
      pair: best === null ? null : [best.left.source, best.right.source],
      n1,
      n2,
      overlap: 0,
      totalSurfaces: null,
      beyondBothSources: null,
      assumptions,
      reason:
        'the independent sources share no surface on identical keys, and with no recapture there ' +
        'is nothing to estimate from — a number produced at zero overlap is arithmetic, not evidence',
    };
  }

  const estimate = Math.floor(((n1 + 1) * (n2 + 1)) / (best.overlap + 1) - 1);
  const union = new Set<string>([...best.left.byIdentity.keys(), ...best.right.byIdentity.keys()]);

  return {
    state: 'ESTIMATED',
    pair: [best.left.source, best.right.source],
    n1,
    n2,
    overlap: best.overlap,
    totalSurfaces: estimate,
    beyondBothSources: Math.max(0, estimate - union.size),
    assumptions,
    reason:
      `Chapman's estimator over ${best.left.source} × ${best.right.source}: ` +
      `((${n1}+1)(${n2}+1) / (${best.overlap}+1)) − 1 = ${estimate}. Chapman's rather than ` +
      `Lincoln–Petersen's because the latter is undefined at zero overlap and biased upward at ` +
      `small overlap, which is the regime an enumeration lives in. Overlap counts EXACT key ` +
      `matches only: a template paired with many instances is not a recapture of one individual.`,
  };
}

// ─── Sentences ───────────────────────────────────────────────────────────────

/**
 * The product's headline, assembled here and nowhere else.
 *
 * It names the declaring sources rather than saying "the source", because
 * "your OpenAPI document declares 412 operations and the crawl reached 25" is a
 * different and more useful claim than the generic one — and because a reader
 * who cannot see which declarer produced the 412 cannot check it.
 */
export function headlineOf(
  axis: ReconcileAxis,
  participation: readonly SourceParticipationReport[],
  recall: CrawlRecall,
  counts: ReconciliationReport['counts'],
  complete: boolean,
): string {
  const noun = axis === 'ROUTE' ? 'route' : 'operation';
  const declaring = participation
    .filter((report) => report.counted && report.side === 'DECLARED')
    .map((report) => report.source);
  const observing = participation
    .filter((report) => report.counted && report.side === 'REACHED')
    .map((report) => report.source);

  if (declaring.length === 0) {
    return observing.length === 0
      ? 'nothing was reconciled: no source loaded, so there is no declared set and no observed set'
      : `no source declared anything, so the ${recall.declared} ${noun}(s) below are only what ` +
          `${observing.join(' and ')} observed — this is a crawl-only inventory, which is the ` +
          `denominator this product exists to improve on`;
  }
  if (observing.length === 0) {
    return (
      `${declaring.join(' and ')} declare ${recall.declared} ${noun}(s); nothing observed any of ` +
      `them, so no reach can be reported — not 0% reached, which would be a measurement`
    );
  }

  const percent = recall.percent === null ? 'no percentage — the declared set is empty' : `${recall.percent}%`;
  const extra =
    counts.reachedNeverDeclared > 0
      ? `, and reached ${counts.reachedNeverDeclared} more that no source declares`
      : '';
  const partial = complete ? '' : ' (partial — see the participation list)';
  return (
    `${declaring.join(' and ')} declare ${recall.declared} ${noun}(s); ` +
    `${observing.join(' and ')} reached ${recall.reached} of them (${percent})${extra}${partial}`
  );
}

function verdictOf(
  participation: readonly SourceParticipationReport[],
  complete: boolean,
): string {
  const loaded = participation.filter((report) => report.counted);
  const notSetUp = participation.filter(
    (report) => !report.counted && !report.hole,
  );
  if (complete) {
    /*
     * The declarers that are not set up are NAMED even here, and that is the
     * point of saying "reconciled" at all: a reader has to be able to see what
     * was not consulted. What they must not be told is that those declarers are
     * a hole — "every surface it would have named is missing" is false about a
     * sitemap this project does not have.
     */
    const aside =
      notSetUp.length === 0
        ? ''
        : `. ${notSetUp.length} further declarer(s) are not set up for this project and were ` +
          `entitled to contribute nothing: ${notSetUp.map((report) => report.source).join(', ')}`;
    return (
      `reconciled across ${loaded.length} source(s): ${loaded
        .map((report) => report.source)
        .join(', ')}${aside}`
    );
  }
  const holes = participation.filter((report) => report.hole);
  return (
    `NOT a full reconciliation — ${loaded.length} of ${loaded.length + holes.length} source(s) that ` +
    `were asked participated. Left out: ${holes
      .map((report) => `${report.source} (${report.notCountedBecause ?? 'no reason recorded'})`)
      .join('; ')}. The three sets below are what the participating sources produced and nothing else.`
  );
}

/**
 * What a reader must know before quoting a number from this report.
 *
 * Never empty. The last line is unconditional and says what the matcher did,
 * because the one component a reader cannot otherwise check is the one that
 * decided two differently spelled strings were one surface.
 */
function reconcileCaveats(
  participation: readonly SourceParticipationReport[],
  counts: ReconciliationReport['counts'],
  caps: readonly ReconcileCap[],
  estimate: PopulationEstimate,
  complete: boolean,
): string[] {
  const caveats: string[] = [];

  /*
   * A HOLE gets the sentence about the reach percentage. A declarer that is not
   * set up gets a different sentence, and the difference is the entire reason
   * `SOURCE_PARTICIPATIONS` has three members: telling a customer that their
   * un-configured sitemap is hiding surface from the declared set is a false
   * statement about their application made out of our own bookkeeping.
   */
  for (const report of participation) {
    if (!report.hole) continue;
    caveats.push(
      `${report.source} contributed nothing: ${report.notCountedBecause ?? 'no reason recorded'}`,
    );
  }
  if (!complete) {
    caveats.push(
      'a source that was asked and did not participate declared nothing HERE, which is not the same as declaring nothing — ' +
        'every surface it would have named is missing from the declared set, which raises the reach percentage',
    );
  }
  const notSetUp = participation.filter((report) => !report.counted && !report.hole);
  if (notSetUp.length > 0) {
    caveats.push(
      `${notSetUp.length} declarer(s) are not set up for this project and contributed nothing they were ` +
        `entitled to contribute: ${notSetUp.map((report) => report.source).join(', ')}. That is not a hole in ` +
        `this comparison — but each one is surface this product could enumerate and currently does not, so the ` +
        `declared set below is as wide as the declarers this project has, not as wide as the application.`,
    );
  }

  for (const cap of caps) {
    caveats.push(
      `${cap.source}: ${cap.cap} capped at ${cap.limit} and discarded ${cap.discarded} candidate(s) — ` +
        `at least ${cap.discarded} more existed. ${cap.reason}`,
    );
  }

  if (counts.relaxedMatches > 0) {
    caveats.push(
      `${counts.relaxedMatches} of ${counts.declaredAndReached} match(es) needed a relaxed rule ` +
        `(a template paired with an instance, or an unreadable HTTP method ignored); both original ` +
        `spellings are on each row so a wrong pairing can be found`,
    );
  }
  if (counts.ambiguousMatches > 0) {
    caveats.push(
      `${counts.ambiguousMatches} match(es) had more than one declared template that could have ` +
        `absorbed the observation; the most specific was chosen and the row is flagged ambiguous`,
    );
  }
  if (estimate.state === 'UNPROVEN') {
    caveats.push(`no population estimate: ${estimate.reason}`);
  }

  caveats.push(
    'surfaces are compared on a canonical key, so every dialect of a parameter segment collapses ' +
      'together; a row keeps each source’s original spelling precisely so a bad match is auditable',
  );
  return caveats;
}
