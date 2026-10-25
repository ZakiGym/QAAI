/**
 * Crawl-to-crawl drift — what changed between two enumerations of ONE
 * environment.
 *
 * ── THE DEFECT, AND WHY IT IS THE WORST SHAPE OF DEFECT THIS REPO HAS ───────
 *
 * `FlowMap.version` has existed since the first crawl: the column comment on it
 * says "the cockpit diffs versions", `flow-map.ts` says "Bumped every time the
 * Explorer re-crawls; the cockpit diffs versions", and the cockpit itself
 * offers to show what changed. NO DIFF CODE EXISTED ANYWHERE IN THE REPO. Two
 * doc comments and a screen all asserted a computation nobody had written,
 * which means four new routes with zero tests against them produced no event at
 * all — the one number a customer acts on was never calculated, and every
 * surface that implied otherwise was lying in the flattering direction.
 *
 * This module is that computation. It is deterministic, model-free and does no
 * I/O: both maps arrive already read, and the caller supplies the only outside
 * fact the diff needs (which routes have a test written against them).
 *
 * ── THE THREE WAYS A DIFF LIES, AND WHAT EACH ONE IS REPLACED WITH ──────────
 *
 * 1. "NO DRIFT" WHEN THERE WAS NOTHING TO COMPARE AGAINST. The first crawl of
 *    an environment has no baseline, so every route in it is "new" — true,
 *    useless, and the one shape that would page somebody on day one. A baseline
 *    that is a CANDIDATE or REJECTED crawl is worse than none: diffing against
 *    a crawl that stopped at a bot wall INVENTS the whole application as new
 *    surface. Both are UNCOMPARABLE, with the counts NULL and the reason on the
 *    row — never zero. See {@link SurfaceDriftComparability}, whose four
 *    members are the four sentences a reader may print.
 *
 *    THE SAME RULE APPLIES TO THE CURRENT SIDE, and that half was missing for a
 *    slice: `diffFlowMaps` adjudicated the baseline and took the current crawl
 *    on trust. A degraded CURRENT crawl is the more expensive of the two, and it
 *    gets past the truncation refusal in rule 2 below because a crawl that
 *    stopped at a login wall CONVERGED — the frontier emptied, no cap bit,
 *    nothing was discarded, so there is no truncation to disclose. It simply
 *    enumerated three routes instead of four hundred, and every route it never
 *    saw looked deleted: 399 removals reported, `/login` announced as new
 *    surface with no test against it, and `comparedAt` stamped on a row that
 *    measured a failed login. That is rule 10's own example — a login that
 *    FAILED recorded as a crawl that found nothing behind the wall — with a mass
 *    retirement on top. It is NOT_COMPARED: the comparison was declined, which
 *    is what that member is for.
 *
 * 2. A ROUTE "REMOVED" THAT WAS SIMPLY NOT VISITED. A truncated crawl reaches
 *    fewer routes than the one before it by construction — a page budget, a
 *    depth cap, a wall clock — and every route it did not get to looks deleted.
 *    Reporting those as removals would mean every capped crawl of a growing
 *    application files a false deletion report. So removals are refused
 *    outright when the current crawl disclosed truncation: `routesRemoved` and
 *    `controlsRemoved` come back NULL with
 *    {@link FlowDiffTruncation.removalsRefusedBecause} naming the cap that bit.
 *    This is why {@link FlowDiffCounts} has nullable members at all.
 *
 * 3. A DIFF ACROSS TWO ENVIRONMENTS. Staging gained four routes that production
 *    does not have yet; that is a deploy pending, not drift, and a count of it
 *    is a number with no meaning whatsoever. There is no honest row to write,
 *    so this one THROWS ({@link FlowDiffRefused}) rather than returning a
 *    storable shape — the same reasoning `GenerationRefused` gives in
 *    generator.ts: a union a caller can destructure is a union a caller can
 *    persist by accident, and a throw cannot be ignored.
 *
 * ── SPELLING ────────────────────────────────────────────────────────────────
 *
 * Routes are keyed with `canonicalRoute` from coverage.ts, not a local
 * normaliser. It is the key `CoverageItem.key` is built from (`ROUTE:` + it),
 * the key `reconcile.ts` matches on, and the key a customer pastes into a
 * waiver file. A second spelling here would make "4 new routes" and "4 routes
 * with no test" two numbers that disagree for no reason a human could see.
 */

import {
  capsThatBit,
  CRAWL_CAP_LABELS,
  driftCountsAreMeaningful,
  type CrawlAcceptanceState,
  type FlowMap,
  type FlowNode,
  type FormModel,
  type SurfaceDriftComparability,
} from '@qaai/shared';
import { canonicalRoute, routeVisits } from './coverage.js';

// ─── What one side of the comparison is ─────────────────────────────────────

/**
 * One crawl, as the diff needs to see it: the row's identity plus the graph.
 *
 * `acceptance` is on the SIDE and not read out of `map.acceptance`, because the
 * authority on whether a map may be measured against is the COLUMN — the stored
 * `FlowMap.acceptance`, which `selectFlowMap` ranks on and which a human can
 * resolve later. The graph's own copy is written at the same moment and is the
 * same value today, but only one of the two is the one anything else reads, and
 * a diff that trusted the blob would disagree with the cockpit the first time
 * somebody promoted a candidate by hand.
 *
 * Null acceptance means the row predates adjudication. Treated as comparable —
 * see {@link baselineIsMeasurable} for why that is the lesser of the two wrongs.
 */
export interface FlowDiffSide {
  /** `FlowMap.id`, which is what a `SurfaceDriftRecord` stores. */
  flowMapId: string;
  version: number;
  environmentId: string;
  /** `FlowMap.acceptance`. Null for every row written before adjudication. */
  acceptance: CrawlAcceptanceState | null;
  map: FlowMap;
}

// ─── Caps and truncation, carried through rather than re-derived ────────────

/**
 * How many changes of each kind are NAMED in the detail payload.
 *
 * There is a cap because `SurfaceDriftRecord.detail` is a JSON column on a row
 * read by a web page, and the first crawl after a framework upgrade legitimately
 * adds four hundred routes. There is a DISCLOSURE because a cap nobody is told
 * about is this product's defining failure: every list below carries its own
 * `total`, so a reader says "40 named of 412" and never "40".
 */
export const MAX_NAMED_CHANGES = 40;

/**
 * A bounded list and the number it was taken from.
 *
 * The one-line version of `Frontier.sample`/`sampleTruncated`: the sample makes
 * the count auditable, and the count stops the sample being mistaken for the
 * set. `named.length < total` is the whole invariant.
 */
export interface FlowDiffSample<T> {
  named: T[];
  total: number;
  truncated: boolean;
}

function sample<T>(items: readonly T[]): FlowDiffSample<T> {
  return {
    named: items.slice(0, MAX_NAMED_CHANGES),
    total: items.length,
    truncated: items.length > MAX_NAMED_CHANGES,
  };
}

/**
 * What each crawl disclosed about stopping early, and what that cost the diff.
 *
 * Reported for BOTH sides, because the two sides fail differently. A truncated
 * CURRENT crawl makes removals unsayable (every unvisited route looks deleted).
 * A truncated BASELINE makes additions unreliable in the other direction — a
 * route the baseline never reached shows up as "added" when it has been there
 * all along — which is not a refusal, because the route genuinely is new surface
 * to the denominator and a customer who tests it is better off than one who
 * does not. It is a caveat, and it is printed as one.
 */
export interface FlowDiffTruncation {
  /** True when this crawl said it stopped early, by any of the three signals. */
  currentTruncated: boolean;
  baselineTruncated: boolean;
  /** The sentences the two crawls wrote, verbatim. Empty when neither did. */
  reasons: string[];
  /**
   * Set exactly when `routesRemoved`/`controlsRemoved` are NULL for this reason.
   * Null when removals WERE reported, so the field cannot be rendered as a
   * caveat on a diff that does not have one.
   */
  removalsRefusedBecause: string | null;
  /**
   * The lower bound on in-scope URLs the CURRENT crawl knew about and did not
   * visit. A floor and never an estimate — `Frontier.atLeastMoreUrls`, carried
   * through unchanged. Null when this crawl did no frontier accounting, which is
   * every crawl stored before the frontier existed and is NOT zero.
   */
  currentAtLeastMoreUrls: number | null;
}

/**
 * Did this crawl disclose that it stopped early?
 *
 * THREE SIGNALS AND NOT ONE, and the reason is that `truncatedReason` is the
 * oldest of them and the weakest. A per-template budget can discard every
 * instance of `/orders/:id` while the queue empties and the crawl calls itself
 * converged, so `caps` is consulted; and a crawl can stop with URLs still
 * queued, so the frontier's own lower bound is consulted. Any one of the three
 * is enough: this predicate gates a REFUSAL, so the direction to be wrong in is
 * refusing a removal that was real, not reporting one that was not.
 */
function disclosedTruncation(map: FlowMap): string | null {
  if (typeof map.truncatedReason === 'string' && map.truncatedReason !== '') {
    return map.truncatedReason;
  }
  const bit = capsThatBit(map.caps ?? []);
  if (bit.length > 0) {
    return bit
      .map((cap) => `${CRAWL_CAP_LABELS[cap.cap]} bit and discarded ${cap.discarded} candidate(s)`)
      .join('; ');
  }
  const pending = map.frontier?.atLeastMoreUrls ?? 0;
  if (pending > 0) {
    return `at least ${pending} more in-scope URL(s) were known and not visited`;
  }
  return null;
}

// ─── Controls and forms, per route ──────────────────────────────────────────

/**
 * The identity of one interactive control.
 *
 * PER-ROUTE, deliberately unlike `crawlSurfaceOf` in obsolete.ts, which keys
 * locators globally on purpose. The two answer different questions and the
 * difference matters: obsolete.ts asks "has the crawl seen this element
 * ANYWHERE", where a per-route answer produces false accusations about a header
 * link that moved. Drift asks "what appeared on /checkout", where a global
 * answer hides the fact that the 'Pay' button is gone from the one page it
 * belongs on.
 *
 * Keyed on kind and accessible label, not on the selector. A restyle changes
 * `getByRole('button').nth(3)` into `.nth(2)` without changing the application
 * at all, and a diff that reported that as a control added and a control removed
 * would fire on every CSS change the customer ever makes.
 */
export function controlIdentity(route: string, kind: string, label: string): string {
  return `${route}|${kind}|${label.trim()}`;
}

/** What one route looked like in one crawl. */
interface RouteShape {
  route: string;
  /** Control identities on this route. A Set: a page with two 'Next' links has one. */
  controls: Set<string>;
  /** Form name → the sorted field names it declared. */
  forms: Map<string, string[]>;
}

function formFieldNames(form: FormModel): string[] {
  const names = new Set<string>();
  for (const field of form?.fields ?? []) {
    // A field with no name is still a field; keying it on its label keeps it in
    // the comparison instead of collapsing every unnamed input onto ''.
    const key = field?.name !== '' && field?.name != null ? field.name : (field?.label ?? '');
    names.add(key);
  }
  return [...names].sort();
}

/**
 * Index a crawl by canonical route.
 *
 * Defensive about shape, like every other reader of a stored FlowMap in this
 * package: the graph is JSON written by an older crawler, and a missing
 * `affordances` array has to narrow the comparison rather than throw inside a
 * scheduled sweep that also has a customer's nightly suite riding on it.
 *
 * Several nodes share one route — that is the whole point of `stateKey` — so the
 * shapes are MERGED. A logged-out /cart and a logged-in /cart are one route with
 * the union of their controls, because "the Pay button disappeared" must not be
 * reported when all that happened is that the second crawl saw the empty-cart
 * state of a page the first crawl saw full.
 */
function shapeByRoute(map: FlowMap): Map<string, RouteShape> {
  const shapes = new Map<string, RouteShape>();

  for (const node of map?.nodes ?? ([] as FlowNode[])) {
    if (typeof node?.route !== 'string' || node.route === '') continue;
    const route = canonicalRoute(node.route);
    const shape = shapes.get(route) ?? { route, controls: new Set<string>(), forms: new Map() };

    for (const affordance of node?.affordances ?? []) {
      if (typeof affordance?.label !== 'string') continue;
      shape.controls.add(controlIdentity(route, affordance.kind ?? 'unknown', affordance.label));
    }
    for (const form of node?.forms ?? []) {
      if (form?.submit?.name != null) {
        // A submit button IS a control. Left out, a form that lost its submit
        // button — the single most testable regression a page can have —
        // produced no count at all.
        shape.controls.add(controlIdentity(route, 'button', form.submit.name));
      }
      const name = form?.name !== '' && form?.name != null ? form.name : (form?.id ?? '');
      const fields = formFieldNames(form);
      const existing = shape.forms.get(name);
      // Union, for the same merge reason the routes are merged: two states of
      // one form are one form, and the fields either state showed are its
      // fields.
      shape.forms.set(name, existing ? [...new Set([...existing, ...fields])].sort() : fields);
    }

    shapes.set(route, shape);
  }

  return shapes;
}

// ─── The result ─────────────────────────────────────────────────────────────

/** One route that exists in both crawls and is not the same route it was. */
export interface FlowDiffRouteChange {
  route: string;
  controlsAdded: string[];
  /** Null when removals were refused — see {@link FlowDiffTruncation}. */
  controlsRemoved: string[] | null;
  /** Forms on this route whose field set moved. */
  formsChanged: FlowDiffFormChange[];
}

/**
 * One form whose fields changed.
 *
 * Named separately from the control counts because it is a different test
 * obligation. A control added is a new thing to click; a FIELD added to a form
 * that already has tests means every one of those tests now submits an
 * incomplete form, which is the most common way a passing suite starts lying
 * after a deploy.
 */
export interface FlowDiffFormChange {
  form: string;
  fieldsAdded: string[];
  /** Null when removals were refused, for the same reason as every other removal. */
  fieldsRemoved: string[] | null;
}

/**
 * The six counts, exactly the six nullable columns on `SurfaceDriftRecord`.
 *
 * Nullable where a count could be a lie:
 *
 *   routesRemoved / controlsRemoved  NULL when the current crawl was truncated.
 *                                    A capped crawl of a growing application
 *                                    cannot tell deletion from "did not reach".
 *   newSurfaceWithoutTests           NULL when the caller could not say which
 *                                    routes have tests. Zero there is the most
 *                                    expensive wrong answer available: it is
 *                                    what a dashboard renders as a green tick.
 *
 * `routesAdded`, `routesChanged` and `controlsAdded` are NOT nullable. A
 * truncated crawl under-reports every one of them, which is a floor and is
 * stated as one — "at least this many" is a defensible sentence, and `0` from a
 * comparison that ran is a real measurement.
 */
export interface FlowDiffCounts {
  routesAdded: number;
  routesRemoved: number | null;
  routesChanged: number;
  controlsAdded: number;
  controlsRemoved: number | null;
  newSurfaceWithoutTests: number | null;
}

/** The named lists behind the counts. Stored verbatim in `detail`. */
export interface FlowDiffDetail {
  routesAdded: FlowDiffSample<string>;
  /** Null when removals were refused. NOT an empty sample, which would claim none. */
  routesRemoved: FlowDiffSample<string> | null;
  routesChanged: FlowDiffSample<FlowDiffRouteChange>;
  controlsAdded: FlowDiffSample<string>;
  controlsRemoved: FlowDiffSample<string> | null;
  /** Every form whose fields moved, flattened across routes, for the digest line. */
  formsChanged: FlowDiffSample<{ route: string; change: FlowDiffFormChange }>;
  /**
   * The routes behind `newSurfaceWithoutTests`, named. Null when that count is
   * null — a list and a count that can disagree is two facts on one row.
   */
  untestedNewRoutes: FlowDiffSample<string> | null;
  truncation: FlowDiffTruncation;
  baselineVersion: number | null;
  currentVersion: number;
}

export interface FlowDiff {
  comparability: SurfaceDriftComparability;
  /**
   * The sentence a reader prints. NEVER empty: for COMPARABLE it says what
   * moved, and for the other three it is the reason the counts are null, which
   * is the whole point of this field existing.
   */
  why: string;
  currentFlowMapId: string;
  baselineFlowMapId: string | null;
  /** Null unless `comparability` is COMPARABLE. */
  counts: FlowDiffCounts | null;
  /** Null unless `comparability` is COMPARABLE. */
  detail: FlowDiffDetail | null;
}

/**
 * A comparison that must not produce a row.
 *
 * Thrown, not returned, for the reason `GenerationRefused` gives in
 * generator.ts: a returned union is a shape a caller can destructure and store
 * by accident, and the defect this module exists to close is a stored number
 * that was never measured. There is one condition — two different environments
 * — and it is a caller bug rather than a property of the data, which is the
 * other half of why it throws instead of becoming a fifth comparability member
 * that a dashboard would then have to render.
 */
export class FlowDiffRefused extends Error {
  readonly currentEnvironmentId: string;
  readonly baselineEnvironmentId: string;

  constructor(args: { currentEnvironmentId: string; baselineEnvironmentId: string }) {
    super(
      `Refusing to diff two crawls of different environments (${args.currentEnvironmentId} vs ` +
        `${args.baselineEnvironmentId}). The difference between two environments is a deploy ` +
        'pending, not drift, and counting it would report one application as changes to another.',
    );
    this.name = 'FlowDiffRefused';
    this.currentEnvironmentId = args.currentEnvironmentId;
    this.baselineEnvironmentId = args.baselineEnvironmentId;
  }
}

/**
 * May this baseline be diffed against?
 *
 * ACCEPTED yes. CANDIDATE and REJECTED no — a crawl held because the site was
 * down or the session had expired enumerated a fraction of the application, so
 * diffing against it reports the rest of the application as brand-new untested
 * surface and pages somebody about an outage they already had.
 *
 * NULL yes, and it is the one genuinely uncomfortable call in this file. Null is
 * every map written before adjudication existed, which on an existing install is
 * most of them. Refusing them would make the first diff after this ships
 * UNCOMPARABLE for every customer — which reads on screen as "we cannot tell
 * you", indefinitely, until a second post-adjudication crawl happens to land.
 * `selectFlowMap` already ranks null between accepted and candidate for exactly
 * this reason, and a null-acceptance baseline is at worst a crawl whose
 * degradation we never checked, not one we checked and rejected.
 */
export function baselineIsMeasurable(acceptance: CrawlAcceptanceState | null): boolean {
  return crawlIsMeasurable(acceptance);
}

/**
 * The one rule both sides are held to, so they cannot drift apart.
 *
 * `baselineIsMeasurable` above delegates here rather than repeating the
 * condition, because the two sides were allowed to disagree once already: the
 * baseline was adjudicated and the current crawl was not, so a REJECTED crawl
 * could still be the LEFT-HAND side of a comparison it had no business being in
 * (see rule 1 in the header). One body means a future change to what counts as
 * measurable cannot be applied to one side and forgotten on the other.
 *
 * Module-private on purpose. The exported predicate is the baseline one, which
 * `packages/agent/src/index.ts` already re-exports; the current-side rule is
 * observable through {@link diffFlowMaps}, which is the level a caller acts on.
 */
function crawlIsMeasurable(acceptance: CrawlAcceptanceState | null): boolean {
  return acceptance === 'ACCEPTED' || acceptance === null;
}

/**
 * Which routes have a test written against them, or NULL for "we could not say".
 *
 * A LIST AND NOT A SET, and matched with `routeVisits` rather than by equality,
 * because a spec that navigates to `/orders/417` is a test for `/orders/:param`
 * and exact-key matching would report that route as untested new surface. This
 * is the same asymmetry surface-coverage.ts rule 1 states: generous where the
 * evidence is weak, because a false "nobody tests your new page" is the claim
 * that makes a team stop reading the report.
 *
 * NULL is a first-class input and is not an empty list. An empty list says
 * "there are no tests", which is a measurement; null says "the caller could not
 * establish testedness", which makes `newSurfaceWithoutTests` null and forces
 * the reader to print the reason instead of a zero.
 */
export type TestedRoutes = readonly string[] | null;

function isTested(route: string, tested: readonly string[]): boolean {
  return tested.some((testRoute) => routeVisits(testRoute, route));
}

/**
 * Diff two crawls of one environment.
 *
 * `baseline` is null for the first crawl of an environment. That is the
 * UNCOMPARABLE_NO_BASELINE case and it is a normal, expected answer — not an
 * error, and emphatically not "no drift".
 *
 * @throws {FlowDiffRefused} when the two sides are different environments.
 */
export function diffFlowMaps(input: {
  current: FlowDiffSide;
  baseline: FlowDiffSide | null;
  tested: TestedRoutes;
}): FlowDiff {
  const { current, baseline } = input;

  /*
   * FIRST, before anything is counted, and it throws. A cross-environment diff
   * has no honest row: there is no number to store and no caveat that would
   * make one meaningful. See FlowDiffRefused.
   */
  if (baseline && baseline.environmentId !== current.environmentId) {
    throw new FlowDiffRefused({
      currentEnvironmentId: current.environmentId,
      baselineEnvironmentId: baseline.environmentId,
    });
  }

  /*
   * SECOND, and BEFORE the no-baseline branch, because a crawl that is not a
   * measurement is not a measurement whether or not there is something to
   * compare it with. Ordering it after would report a degraded first crawl as
   * "the first crawl of this environment, every route in it is new" — which
   * names the wrong fact about a crawl that enumerated a login page.
   *
   * NOT_COMPARED and not an UNCOMPARABLE_* member: the two of those describe a
   * BASELINE that could not serve, and this is the comparison being declined
   * outright. `driftCountsAreMeaningful` is false for it, so the counts stay
   * NULL and the caller writes the reason instead of a zero.
   */
  if (!crawlIsMeasurable(current.acceptance)) {
    return {
      comparability: 'NOT_COMPARED',
      why:
        `This crawl (v${current.version}) was itself held as ${current.acceptance}, so it is not ` +
        'a measurement of the application and nothing was compared against it. A held crawl ' +
        'enumerates a fraction of the surface — a login that failed, a bot wall, a site that was ' +
        'down — and diffing FROM one reports every route it never reached as removed. No drift is ' +
        'being claimed in either direction; re-run enumeration once the crawl can be accepted.',
      currentFlowMapId: current.flowMapId,
      baselineFlowMapId: baseline?.flowMapId ?? null,
      counts: null,
      detail: null,
    };
  }

  const currentTruncation = disclosedTruncation(current.map);

  if (!baseline) {
    return {
      comparability: 'UNCOMPARABLE_NO_BASELINE',
      why:
        `This is the first stored crawl of this environment (v${current.version}), so there is ` +
        'nothing to compare it against. Every route in it is new, which is true and not drift.',
      currentFlowMapId: current.flowMapId,
      baselineFlowMapId: null,
      counts: null,
      detail: null,
    };
  }

  if (!baselineIsMeasurable(baseline.acceptance)) {
    return {
      comparability: 'UNCOMPARABLE_BASELINE_NOT_ACCEPTED',
      why:
        `The previous crawl of this environment (v${baseline.version}) was held as ` +
        `${baseline.acceptance}, so it is not a denominator and cannot be a baseline. Diffing ` +
        'against a degraded crawl invents the routes it merely missed as new untested surface.',
      currentFlowMapId: current.flowMapId,
      baselineFlowMapId: baseline.flowMapId,
      counts: null,
      detail: null,
    };
  }

  // ── The comparison ────────────────────────────────────────────────────────

  const baselineTruncation = disclosedTruncation(baseline.map);
  const now = shapeByRoute(current.map);
  const before = shapeByRoute(baseline.map);

  const routesAdded = [...now.keys()].filter((route) => !before.has(route)).sort();
  const routesGone = [...before.keys()].filter((route) => !now.has(route)).sort();

  /*
   * THE REFUSAL. A truncated crawl reaches fewer routes than the one before it
   * BY CONSTRUCTION, so every route it did not get to is indistinguishable from
   * a deleted one. `routesGone` is computed above and then deliberately not
   * reported — the set is real, the INTERPRETATION of it as removal is what is
   * unavailable, and `removalsRefusedBecause` says so with the cap named.
   */
  const removalsReportable = currentTruncation === null;

  const controlsAdded: string[] = [];
  const controlsRemoved: string[] = [];
  const routesChanged: FlowDiffRouteChange[] = [];
  const formsChanged: Array<{ route: string; change: FlowDiffFormChange }> = [];

  for (const route of [...now.keys()].sort()) {
    const nowShape = now.get(route)!;
    const beforeShape = before.get(route);
    if (!beforeShape) {
      // An ADDED route's controls are not "controls added to an existing page":
      // they are part of the new route, already counted by routesAdded, and
      // counting them twice is how "6 controls added" came to mean one new page.
      continue;
    }

    const added = [...nowShape.controls].filter((key) => !beforeShape.controls.has(key)).sort();
    const removed = removalsReportable
      ? [...beforeShape.controls].filter((key) => !nowShape.controls.has(key)).sort()
      : [];

    const changedForms: FlowDiffFormChange[] = [];
    for (const [form, fields] of [...nowShape.forms].sort(([a], [b]) => a.localeCompare(b))) {
      const was = beforeShape.forms.get(form);
      if (!was) continue; // A new form on an existing page is a control addition.
      const fieldsAdded = fields.filter((field) => !was.includes(field));
      const fieldsRemoved = removalsReportable
        ? was.filter((field) => !fields.includes(field))
        : null;
      if (fieldsAdded.length === 0 && (fieldsRemoved?.length ?? 0) === 0) continue;
      const change: FlowDiffFormChange = { form, fieldsAdded, fieldsRemoved };
      changedForms.push(change);
      formsChanged.push({ route, change });
    }

    controlsAdded.push(...added);
    controlsRemoved.push(...removed);

    if (added.length > 0 || removed.length > 0 || changedForms.length > 0) {
      routesChanged.push({
        route,
        controlsAdded: added,
        controlsRemoved: removalsReportable ? removed : null,
        formsChanged: changedForms,
      });
    }
  }

  /*
   * ── THE ONE NUMBER ANYONE ACTS ON ─────────────────────────────────────────
   *
   * NEW SURFACE WITH NO TESTS. Counted over ROUTES and not over controls,
   * because a route is the unit a customer can act on — "write a test for
   * /refunds" is a task, "write a test for the third button on /refunds" is not
   * — and because `CoverageItem` already counts a route as the surface item.
   *
   * New surface is an ADDED route, OR an existing route that GAINED something: a
   * control, or a field on a form. A route that only LOST surface is not new
   * surface, and folding it in would make the number go up when the application
   * got smaller.
   *
   * NULL, never 0, when the caller could not establish testedness.
   */
  const grew = new Set<string>(routesAdded);
  for (const change of routesChanged) {
    const gainedField = change.formsChanged.some((form) => form.fieldsAdded.length > 0);
    if (change.controlsAdded.length > 0 || gainedField) grew.add(change.route);
  }
  const tested = input.tested;
  const untestedNewRoutes =
    tested === null ? null : [...grew].filter((route) => !isTested(route, tested)).sort();

  const truncation: FlowDiffTruncation = {
    currentTruncated: currentTruncation !== null,
    baselineTruncated: baselineTruncation !== null,
    reasons: [
      currentTruncation === null ? null : `this crawl (v${current.version}): ${currentTruncation}`,
      baselineTruncation === null
        ? null
        : `the baseline (v${baseline.version}): ${baselineTruncation}`,
    ].filter((line): line is string => line !== null),
    removalsRefusedBecause: removalsReportable
      ? null
      : `${routesGone.length} route(s) present in v${baseline.version} are absent from ` +
        `v${current.version}, and this crawl stopped early (${currentTruncation}), so they ` +
        'cannot be told apart from routes it did not reach. Removals are NOT reported.',
    currentAtLeastMoreUrls: current.map.frontier?.atLeastMoreUrls ?? null,
  };

  const counts: FlowDiffCounts = {
    routesAdded: routesAdded.length,
    routesRemoved: removalsReportable ? routesGone.length : null,
    routesChanged: routesChanged.length,
    controlsAdded: controlsAdded.length,
    controlsRemoved: removalsReportable ? controlsRemoved.length : null,
    newSurfaceWithoutTests: untestedNewRoutes === null ? null : untestedNewRoutes.length,
  };

  const detail: FlowDiffDetail = {
    routesAdded: sample(routesAdded),
    routesRemoved: removalsReportable ? sample(routesGone) : null,
    routesChanged: sample(routesChanged),
    controlsAdded: sample(controlsAdded),
    controlsRemoved: removalsReportable ? sample(controlsRemoved) : null,
    formsChanged: sample(formsChanged),
    untestedNewRoutes: untestedNewRoutes === null ? null : sample(untestedNewRoutes),
    truncation,
    baselineVersion: baseline.version,
    currentVersion: current.version,
  };

  return {
    comparability: 'COMPARABLE',
    why: driftHeadline({ counts, detail, baselineVersion: baseline.version, current }),
    currentFlowMapId: current.flowMapId,
    baselineFlowMapId: baseline.flowMapId,
    counts,
    detail,
  };
}

/**
 * The sentence, built in ONE place.
 *
 * Here and not at each render site for the reason `headlineOf` in reconcile.ts
 * gives: a sentence assembled by whichever caller happens to print it is a
 * sentence that will eventually be assembled two different ways, and the two
 * will disagree about whether a null was a zero.
 *
 * Every clause is conditional on the thing it describes having been MEASURED. A
 * null removal count prints the refusal, not "0 removed".
 */
function driftHeadline(input: {
  counts: FlowDiffCounts;
  detail: FlowDiffDetail;
  baselineVersion: number;
  current: FlowDiffSide;
}): string {
  const { counts, detail } = input;

  /*
   * The controls clause is assembled as ONE string rather than as a fragment
   * plus a leading-comma fragment. Joined with a space, the second form printed
   * "0 control(s) added , 0 removed ; 0 form(s) changed fields." — a stray space
   * before every mark of punctuation, in the sentence that is stored on the
   * drift row and rendered in the cockpit. Cosmetic, and it is the sentence this
   * product's credibility is carried in.
   */
  const controls =
    counts.controlsRemoved === null
      ? `${counts.controlsAdded} control(s) added;`
      : `${counts.controlsAdded} control(s) added, ${counts.controlsRemoved} removed;`;

  const parts = [
    `v${input.baselineVersion} → v${input.current.version}:`,
    `${counts.routesAdded} route(s) added,`,
    counts.routesRemoved === null ? 'removals not reported,' : `${counts.routesRemoved} removed,`,
    `${counts.routesChanged} changed;`,
    controls,
    `${detail.formsChanged.total} form(s) changed fields.`,
  ];

  // The number anyone acts on, last and spelled out, or the reason there is none.
  parts.push(
    counts.newSurfaceWithoutTests === null
      ? 'New surface with no tests: NOT MEASURED — testedness could not be established for this' +
          ' project, so this is not zero.'
      : `New surface with no tests: ${counts.newSurfaceWithoutTests}.`,
  );

  if (detail.truncation.removalsRefusedBecause) {
    parts.push(detail.truncation.removalsRefusedBecause);
  } else if (detail.truncation.baselineTruncated) {
    parts.push(
      'The baseline crawl stopped early, so some "added" routes may have existed all along and' +
        ' merely been missed.',
    );
  }

  return parts.filter((part) => part !== '').join(' ');
}

/**
 * Is this drift worth telling somebody about?
 *
 * The event this gates is "new surface with no tests", so the only trigger is a
 * POSITIVE, MEASURED count of it. Three things deliberately do NOT raise it:
 *
 *   · an UNCOMPARABLE diff. There is no measurement, and an alert on one would
 *     page every customer on their first crawl.
 *   · a null count. `driftCountsAreMeaningful` plus a null is exactly the state
 *     that must print a reason rather than fire or stay silent on a number
 *     nobody computed.
 *   · routes removed, or controls that merely moved. Those are worth READING and
 *     are on the record; they are not a test obligation, and an event that fires
 *     on every restyle is one people mute, which costs the alert that matters.
 */
export function driftWorthAnnouncing(diff: FlowDiff): boolean {
  if (!driftCountsAreMeaningful(diff.comparability)) return false;
  const count = diff.counts?.newSurfaceWithoutTests ?? null;
  return count !== null && count > 0;
}
