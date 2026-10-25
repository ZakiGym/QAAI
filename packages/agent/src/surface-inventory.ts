/**
 * Builds the surface inventory — the denominator — from source and crawl.
 *
 * THE ONE IDEA IN THIS FILE
 *
 * `analyseCodebase` reads the customer's repository and produces routes,
 * endpoints, forms and auth surfaces, each with the file it was declared in.
 * The crawler produces flow-map nodes, each a page something actually reached.
 * Until now these were two separate inventories rendered on two separate
 * screens, and nothing ever put them side by side.
 *
 * Unioning them is the whole product, because the overlap is diagnostic in both
 * directions:
 *
 *   SOURCE_ONLY  the code declares it, no crawl has reached it. Either dead
 *                code, or — far more often — a page behind a button, a wizard
 *                step, a role we do not hold, or a flag we did not set. This is
 *                the set no runtime-only tool can see AT ALL: mabl's crawler,
 *                Cypress's DOM snapshots, Meticulous's recorded sessions and
 *                SeaLights' runtime agents all build their denominator from
 *                things already executed, so a surface nothing has touched is
 *                invisible rather than uncovered.
 *   CRAWL_ONLY   the app serves it, source analysis never declared it. That is
 *                evidence about OUR extractor, not about the customer, and it
 *                is reported rather than suppressed because hiding our own
 *                error rate is how a denominator stops being trustworthy.
 *   BOTH         declared and reached. The only set a competitor could also
 *                enumerate.
 *
 * NOTHING HERE CALLS A MODEL
 *
 * Same rule as coverage.ts, for the same reason: a denominator is a claim about
 * the customer's application, and a claim whose working we cannot show is worse
 * than no claim. Every item carries the `evidence` sentence the detector
 * produced, so the customer can re-run the extractor in their own CI and check
 * our arithmetic. That recomputability is the answer to the only real objection
 * to this product — "your denominator is invented, like everyone else's".
 *
 * WHAT COUNTS AS THE SAME THING
 *
 * Identity is by canonical key, never by line number, so reformatting a file
 * does not retire an item and mint a new one. Routes go through
 * `canonicalRoute` from coverage.ts — the same function applied to both sides,
 * which is the only way `/orders/123` from a crawl and `/orders/[id]` from a
 * Next.js directory are recognised as one route.
 *
 * ─── EIGHT DECLARERS, ONE DENOMINATOR ───────────────────────────────────────
 *
 * The two-source union above was the first half. The second half is that there
 * are now EIGHT ways this product can learn a surface exists — `SURFACE_SOURCES`
 * names them — and until this change three of those inventories lived on three
 * separate screens and were never unioned. A customer could read two different
 * coverage numbers for one application and no combined figure, which is not a
 * rounding disagreement: it is two denominators, and a percentage over an
 * unstated denominator is the thing every competitor in this market already
 * ships.
 *
 * The union is only worth having if it is honest rather than merely bigger, so
 * four rules hold and each one is tested:
 *
 *   1. ONE SURFACE, N PROVENANCES. The same route declared by a repo, a build
 *      manifest and a sitemap is ONE item carrying three entries in `sources`.
 *      Three items would inflate the denominator with phantoms, which lowers
 *      the percentage over a denominator containing things that do not exist —
 *      wrong in a way that looks conservative and is simply wrong.
 *
 *   2. ONE DECLARER IS STILL A DECLARER, AND WHICH ONE IS VISIBLE. A route only
 *      a source map mentioned deserves less confidence than one three declarers
 *      agree on, so `sources` is on the row and `soleDeclarerOf` is counted per
 *      declarer. Collapsing that to a count of items would make our weakest
 *      evidence indistinguishable from our strongest.
 *
 *   3. A DECLARER THAT FAILED DOES NOT SILENTLY DROP OUT. `participation`
 *      records every declarer that was ASKED and what happened, and `complete`
 *      is false when any of them failed. A failed sitemap read as "declared
 *      nothing" shrinks the denominator and raises the percentage, and the
 *      report would still say "reconciled". It is three-valued — NULL when the
 *      caller did not account for which declarers were asked — because "we did
 *      not check" and "everything loaded" are different facts.
 *
 *   4. UNEXERCISABLE AND REFUSED SURFACES STAY IN, WITH THEIR REASON. A
 *      destructive flow nobody can safely test is the highest-risk surface in
 *      the application. Dropping it makes the number go up, which is exactly
 *      backwards, so `FlowMap.excluded` is read and each refusal becomes an
 *      item carrying the `SurfaceExercise` that `exclusionAsExercise` derived.
 *      The shared arithmetic (`totalsForKind`) then holds it out of the COVERAGE
 *      denominator and counts it separately — which is the documented behaviour
 *      of `NON_DENOMINATOR_EXERCISABILITIES`, not a second rule invented here:
 *      in the inventory and named, out of the division and explained.
 */

import { createHash } from 'node:crypto';
import {
  SHORTFALL_REASON_LABELS,
  SURFACE_SOURCES,
  SURFACE_SOURCE_LABELS,
  exercisabilityCounts,
  isObservedSource,
  originFromSources,
  surfaceKey,
  unmeasuredKinds,
  type AuthSurface,
  type CodebaseAnalysis,
  type FlowMap,
  type FlowNode,
  type HttpEndpoint,
  type PageRoute,
  type SourceForm,
  type SurfaceItem,
  type SurfaceKind,
  type SurfaceSource,
} from '@qaai/shared';
import {
  canonicalRoute,
  exclusionAsExercise,
  reverseReconcile,
  routeVisits,
  type CoverageTestInput,
  type ReverseReconciliation,
} from './coverage.js';
/*
 * TYPE-ONLY, and it has to be.
 *
 * reconcile.ts imports `endpointIdentity` from THIS file at run time, so a
 * value import back the other way would be a module cycle. A `import type` is
 * erased entirely, which gives us reconcile's participation vocabulary without
 * creating one — and restating `SOURCE_PARTICIPATIONS` here instead is exactly
 * the second-vocabulary defect this round is under instruction not to create.
 * The run-time parity check against its members lives in the test, which
 * imports both modules anyway.
 */
import type { SourceParticipation } from './reconcile.js';

// ─── Input ───────────────────────────────────────────────────────────────────

export interface SurfaceInventoryInput {
  /**
   * The source read. Null when the repo was never ingested — then every item
   * is CRAWL_ONLY and a caveat says so, because a crawl-only inventory is
   * exactly the denominator this product exists to improve on.
   */
  analysis: CodebaseAnalysis | null;
  /** The most recent readable flow map. Null when nothing has crawled yet. */
  flowMap: FlowMap | null;
  /**
   * Items declared by a source that is neither the repo nor a crawl: a sitemap,
   * an OpenAPI document, real traffic, a recorded session, a requirement, a
   * manual entry, a maintained catalogue.
   *
   * Each item carries its own `sources`, because only the reader that produced
   * it knows which declarer it is. Merged BY KEY with everything else, so a
   * route the repo declares and traffic walked is one item with two
   * provenances — see rule 1 in the header.
   *
   * ABSENT IS NOT EMPTY. Undefined means no other declarer was offered to this
   * union, which `participation` below is where a caller says so.
   */
  observed?: readonly SurfaceItem[];
  /**
   * Every declarer that was ASKED, and what happened when it was.
   *
   * The field that makes `complete` answerable. Without it this union cannot
   * tell "the sitemap declared nothing" from "the sitemap 404'd and we skipped
   * it", and those differ by the whole size of the sitemap: the second shrinks
   * the denominator and raises the percentage, and nothing on screen says so.
   *
   * Omit it and `complete` is NULL rather than true — the honest answer to a
   * question nobody accounted for.
   */
  participation?: readonly SurfaceSourceAsked[];
  /**
   * The suite, for the reverse direction.
   *
   * A test navigating to a route no declarer enumerated is the hardest evidence
   * of undercount this product can obtain, and it runs against the WHOLE union
   * here rather than against one crawl. See `reverseReconcile` in coverage.ts.
   */
  tests?: readonly CoverageTestInput[];
}

/** One declarer, as the caller reports asking it. */
export interface SurfaceSourceAsked {
  source: SurfaceSource;
  /**
   * From reconcile.ts's `SOURCE_PARTICIPATIONS`, not a second vocabulary. The
   * distinction between the last two is the point: `NOT_CONFIGURED` is the
   * customer's choice and costs this union nothing it was entitled to, while
   * `FAILED` is a hole with a known shape and an unknown size.
   */
  participation: SourceParticipation;
  /** Why. Required even for LOADED, where it says what was read. */
  detail: string;
}

/** One declarer, with what it actually contributed to the union. */
export interface SurfaceSourceContribution extends SurfaceSourceAsked {
  /** Whether its items entered the union at all. False for FAILED and NOT_CONFIGURED. */
  counted: boolean;
  /**
   * Items naming this declarer in `sources`. NULL when it did not participate —
   * never 0, because "it declared nothing" and "it was never read" are the two
   * facts this whole field exists to keep apart.
   */
  itemsDeclared: number | null;
  /**
   * Items THIS declarer is the only one for. Null under the same rule.
   *
   * The confidence signal rule 2 in the header is about: a route only a source
   * map mentioned is a weaker claim than one three declarers agree on, and a
   * reader cannot tell them apart from a total.
   */
  soleDeclarerOf: number | null;
}

export interface SurfaceInventory {
  items: SurfaceItem[];
  /** Axes with no extractor, named so our own measurement gap is stated. */
  unmeasuredKinds: SurfaceKind[];
  /**
   * Things a reader must know before trusting any number derived from this.
   * Never empty by default — a silent inventory is an overconfident one.
   */
  caveats: string[];
  /** Per-axis counts of how the union landed. Drives the reconciliation panel. */
  reconciliation: {
    sourceOnly: number;
    crawlOnly: number;
    both: number;
    /**
     * Items carrying NO `sources` at all.
     *
     * Every `CoverageItem` written before the declarer column existed is in
     * this state, and they arrive here through `observed`. Their `origin` is
     * whatever the old two-source derivation stored, which is a real answer to
     * a narrower question — so they are counted apart rather than claimed as
     * agreement between declarers nobody recorded.
     */
    declarersUnrecorded: number;
  };
  /**
   * Every declarer asked, and what it put in. See `SurfaceSourceContribution`.
   */
  participation: SurfaceSourceContribution[];
  /**
   * True when every declarer that was asked LOADED.
   *
   * THREE-VALUED. Null means the caller did not account for which declarers
   * were asked, which is not the same as "all of them loaded" — the same
   * distinction `enumerationComplete` draws in surface-catalog.ts, and the
   * reason "reconciled" may not be printed over a union that skipped a source.
   */
  complete: boolean | null;
  /** Set whenever `complete` is not true. One sentence per missing declarer. */
  partialBecause: string[];
  /**
   * Items held out of the COVERAGE denominator by `totalsForKind`, counted here
   * so the inventory's own total and the division's can be reconciled by hand.
   *
   * They are IN `items`. This is not a second list; it is the arithmetic.
   */
  heldOut: {
    unexercisable: number;
    refused: number;
  };
  /**
   * What the suite knows that no declarer did.
   *
   * `declaredSetUnderstatedByAtLeast` is the number that makes every percentage
   * over this inventory an upper bound, and it is a FLOOR: it counts only
   * surfaces a test named out loud.
   */
  reverse: ReverseReconciliation;
  /** Changes whenever the inventory could change. */
  fingerprint: string;
}

/**
 * `originFromSources` for a declarer set this module knows is non-empty.
 *
 * `originFromSources` returns NULL for an empty set and that null is right: an
 * item whose declarers were never recorded has no origin, and defaulting it to
 * BOTH (the flattering answer) or SOURCE_ONLY (the alarming one) would be a
 * fact we invented. But `SurfaceItem.origin` is not nullable, so a row in that
 * state cannot be BUILT here — only read back from a `CoverageItem` written
 * before the `sources` column existed.
 *
 * Every call site below passes at least one declarer, so the throw is
 * unreachable. It is a throw and not a default because a default is exactly the
 * invention `originFromSources` refuses to make, and a silent SOURCE_ONLY on an
 * item with no declarer would be indistinguishable from a real reading.
 */
function originOfDeclared(sources: readonly SurfaceSource[]): SurfaceItem['origin'] {
  const origin = originFromSources(sources);
  if (origin === null) {
    throw new Error(
      'surface-inventory: an item was built with no declarer, so its origin cannot be derived',
    );
  }
  return origin;
}

// ─── Identity ────────────────────────────────────────────────────────────────

/**
 * The canonical identity of an endpoint.
 *
 * Method and path, method upper-cased, path through the same canonicaliser as
 * routes. `UNKNOWN` is preserved rather than guessed: a Next.js `route.ts` whose
 * body we were never given is definitely an endpoint whose verbs are definitely
 * unreadable, and writing `GET` there would be a guess dressed as a fact.
 */
export function endpointIdentity(method: string, path: string): string {
  return `${method.toUpperCase()} ${canonicalRoute(path)}`;
}

/**
 * The canonical identity of a form.
 *
 * `analyseCodebase` already produces a deterministic id from the file path plus
 * the form's index within the file, which is stable across runs and across
 * reformatting. Reused verbatim rather than recomputed so the two halves of the
 * system cannot disagree about which form is which.
 */
export function formIdentity(form: Pick<SourceForm, 'id'>): string {
  return form.id;
}

/** The canonical identity of an auth surface: its kind at its path. */
export function authSurfaceIdentity(kind: string, path: string): string {
  return `${kind}@${canonicalRoute(path)}`;
}

/**
 * The canonical identity of one named state of one component.
 *
 * `modulePath#exportName:KIND` — the module and export are `ComponentItem`'s
 * own unique key, so this is that identity plus the state, and a component
 * moved between files is correctly a different component (its props, its
 * imports and its tests all moved with it).
 *
 * Lives here beside the other three identities rather than in the persistence
 * layer, because `ComponentState.coverageItemKey` is TEXT and not a foreign
 * key: the writer of the state row and the writer of the registry row are
 * different passes, and a second spelling of this string in one of them would
 * produce a dangling reference that looks exactly like a real one.
 *
 * NOT a `dimensionCellIdentity`. A component state is a property of ONE item,
 * not a value enumerable independently of the pages it applies to — which is
 * the line surface.ts draws when it explains why `SURFACE_DIMENSION_KINDS` has
 * six members and not twelve.
 */
export function componentStateIdentity(
  modulePath: string,
  exportName: string,
  kind: string,
): string {
  return `${modulePath}#${exportName}:${kind}`;
}

// ─── Source side ─────────────────────────────────────────────────────────────

function itemFromRoute(route: PageRoute): SurfaceItem {
  const identity = canonicalRoute(route.route);
  return {
    kind: 'ROUTE',
    key: surfaceKey('ROUTE', identity),
    label: identity,
    file: route.file,
    line: null,
    // Derived, never set beside `sources` by hand. Two fields saying the same
    // thing is how they come to disagree and only one ends up on screen.
    sources: ['SOURCE'],
    origin: originOfDeclared(['SOURCE']),
    evidence: route.evidence,
    detector: route.detector,
    meta: { dynamic: route.dynamic, declaredAs: route.route },
  };
}

function itemFromEndpoint(endpoint: HttpEndpoint): SurfaceItem {
  const identity = endpointIdentity(endpoint.method, endpoint.path);
  return {
    kind: 'ENDPOINT',
    key: surfaceKey('ENDPOINT', identity),
    label: identity,
    file: endpoint.file,
    line: null,
    sources: ['SOURCE'],
    origin: originOfDeclared(['SOURCE']),
    evidence: endpoint.evidence,
    detector: endpoint.detector,
    meta: {
      method: endpoint.method,
      path: canonicalRoute(endpoint.path),
      dynamic: endpoint.dynamic,
      // Stated so the cockpit can mark it rather than quietly treating an
      // unreadable verb as a tested one.
      verbUnreadable: endpoint.method === 'UNKNOWN',
    },
  };
}

function itemFromForm(form: SourceForm): SurfaceItem {
  const required = form.fields.filter((field) => field.required).length;
  return {
    kind: 'FORM',
    key: surfaceKey('FORM', formIdentity(form)),
    label: form.name,
    file: form.file,
    line: null,
    sources: ['SOURCE'],
    origin: originOfDeclared(['SOURCE']),
    evidence: `${form.file} — a form with ${form.fields.length} field${form.fields.length === 1 ? '' : 's'}${required > 0 ? `, ${required} required` : ''}${form.action ? `, posting to ${form.action}` : ''}`,
    detector: null,
    meta: {
      action: form.action,
      method: form.method,
      submitLabel: form.submitLabel,
      fieldCount: form.fields.length,
      requiredCount: required,
      // The field list is what a generated test needs, and what makes a
      // "validation untested" claim concrete rather than rhetorical.
      fields: form.fields.map((field) => ({
        name: field.name,
        label: field.label,
        inputType: field.inputType,
        required: field.required,
        semantic: field.semantic,
      })),
    },
  };
}

function itemFromAuthSurface(surface: AuthSurface): SurfaceItem {
  const identity = authSurfaceIdentity(surface.kind, surface.path);
  return {
    kind: 'AUTH_SURFACE',
    key: surfaceKey('AUTH_SURFACE', identity),
    label: `${surface.kind.toLowerCase().replace(/_/g, ' ')} at ${canonicalRoute(surface.path)}`,
    file: surface.file,
    line: null,
    sources: ['SOURCE'],
    origin: originOfDeclared(['SOURCE']),
    evidence: surface.evidence,
    detector: surface.from,
    meta: { authKind: surface.kind, from: surface.from, path: canonicalRoute(surface.path) },
  };
}

// ─── Crawl side ──────────────────────────────────────────────────────────────

/**
 * The route a crawl node reached.
 *
 * The crawl contributes routes. It does NOT contribute endpoints: a flow-map
 * node is a page, and inferring an API operation from a page would be exactly
 * the kind of guess that produced 325 invented routes the last time this
 * codebase inferred a URL from a file path.
 *
 * Nor does it contribute FORMS as items of their own when source analysis
 * exists. The crawler's form ids come from the live DOM and the source
 * analyser's come from `file#index`; there is no reliable way to tell that they
 * describe the same form, so minting both would double-count every form in the
 * application and corrupt the denominator in the direction that flatters us
 * (more items, same numerator, lower percentage — but a percentage of a
 * denominator containing phantoms). Instead the count of forms a crawl saw is
 * recorded on the route, and a caveat states the limitation. When there is NO
 * source analysis the crawl is the only inventory there is, so its forms do
 * become items — see `buildSurfaceInventory`.
 */
function routeItemFromFlowNode(
  node: FlowNode,
  baseUrl: string,
  environmentId: string | null,
): SurfaceItem {
  const identity = canonicalRoute(node.route);
  return {
    kind: 'ROUTE',
    key: surfaceKey('ROUTE', identity),
    label: identity,
    file: null,
    line: null,
    sources: ['CRAWL'],
    origin: originOfDeclared(['CRAWL']),
    /*
     * The environment, carried.
     *
     * A crawl is an observation OF SOMEWHERE. Without this a staging crawl's
     * routes enter a production project's denominator and are reported as
     * uncovered production gaps — the defect `selectFlowMap` exists to prevent
     * for flow maps, applied to the items they feed.
     */
    environmentId,
    /*
     * The crawl reached it, so a test can drive it: the strongest
     * exercisability evidence an observation produces. Stated rather than left
     * absent, because absent means "nobody classified it" and the crawl plainly
     * did — it was there.
     */
    exercise: {
      state: 'EXERCISABLE',
      detail: `the crawl navigated to ${node.url || identity} and it answered`,
    },
    evidence: `the crawl reached ${node.url || identity}${node.title ? ` ("${node.title}")` : ''}${node.behindAuth ? ', behind the auth wall' : ''}`,
    detector: 'crawler',
    meta: {
      url: node.url,
      title: node.title,
      behindAuth: node.behindAuth,
      requiresRoles: node.requiresRoles,
      baseUrl,
      affordances: node.affordances.length,
      formsSeen: node.forms.length,
    },
  };
}

/** A crawled form, as its own item. Only used when there is no source analysis. */
function formItemFromFlowNode(
  node: FlowNode,
  form: FlowNode['forms'][number],
  environmentId: string | null,
): SurfaceItem {
  const identity = canonicalRoute(node.route);
  return {
    kind: 'FORM',
    key: surfaceKey('FORM', `${identity}#${form.id}`),
    label: form.name,
    file: null,
    line: null,
    sources: ['CRAWL'],
    origin: originOfDeclared(['CRAWL']),
    environmentId,
    evidence: `the crawl found a form with ${form.fields.length} field${form.fields.length === 1 ? '' : 's'} on ${identity}`,
    detector: 'crawler',
    meta: {
      route: identity,
      fieldCount: form.fields.length,
      requiredCount: form.fields.filter((field) => field.required).length,
      fields: form.fields.map((field) => ({
        name: field.name,
        label: field.label,
        inputType: field.inputType,
        required: field.required,
        semantic: field.semantic,
      })),
    },
  };
}

// ─── The surface a crawl refused to drive ────────────────────────────────────

/**
 * One refused URL as an item that stays in the inventory.
 *
 * THE ITEM THAT USED TO NOT EXIST. The crawler refuses /logout, /delete-* and
 * /destroy — correctly, because following them ends the session or removes a
 * record it cannot restore — and before `FlowMap.excluded` the refusal left no
 * trace at all. So a surface we refused was indistinguishable from a surface
 * the application does not serve, and the one class guaranteed to be missing
 * was the destructive one. Absent raises the percentage; uncovered lowers it.
 *
 * `sources: ['CRAWL']` is deliberate and is the subtle part: the crawl is the
 * declarer. It found the link, it classified it, and it decided not to follow.
 * "We saw this and would not touch it" is an observation, and recording it as
 * anything else would attribute our own policy to the customer's repository.
 *
 * Returns null when the URL is not this application's surface at all — an
 * off-origin identity provider, a `mailto:`. `exclusionAsExercise` owns that
 * decision so the gap report and the inventory cannot classify one refusal two
 * ways.
 */
/**
 * The route a refused URL names, when one can be read out of it.
 *
 * `ExcludedPath.route` is "the normalised route, WHEN IT COULD BE DERIVED", so
 * a refusal written with `route: null` is routine rather than exotic. This
 * module keyed those on the raw URL and `readCrawl` in coverage.ts read the
 * pathname out of the same field — so one `/logout` refused twice, once with a
 * route and once without, came out of here as TWO surfaces
 * (`ROUTE:/logout` and `ROUTE:https://app.example.com/logout?next=%2F`) while
 * the gap report counted one. A phantom in the denominator, a ROUTE key that is
 * not a route and can therefore never be matched by a test, and two readers of
 * one ledger disagreeing about how many destructive surfaces exist.
 *
 * Absolute first, then a path-only string, then null — and null still keys the
 * item on the URL, because a refusal nobody can normalise is still ONE refusal
 * and dropping it would hide the class this ledger exists to show.
 */
function routeOfRefusedUrl(url: string): string | null {
  try {
    return canonicalRoute(new URL(url).pathname);
  } catch {
    return url.startsWith('/') ? canonicalRoute(url) : null;
  }
}

function itemFromExclusion(
  exclusion: { url: string; route: string | null; kind: Parameters<typeof exclusionAsExercise>[0]; rule: string },
  environmentId: string | null,
): SurfaceItem | null {
  const classified = exclusionAsExercise(exclusion.kind, exclusion.rule);
  if (!classified) return null;
  const { remedy, ...exercise } = classified;

  // Route when we could normalise one; the URL otherwise, so a refusal with an
  // unreadable path is still ONE refusal rather than dropped.
  const identity = exclusion.route ?? exclusion.url;
  return {
    kind: 'ROUTE',
    key: surfaceKey('ROUTE', identity),
    label: identity,
    file: null,
    line: null,
    sources: ['CRAWL'],
    origin: originOfDeclared(['CRAWL']),
    environmentId,
    exercise,
    evidence: `${exercise.detail} — ${remedy}`,
    detector: 'crawler',
    meta: {
      refusedUrl: exclusion.url,
      exclusionKind: exclusion.kind,
      rule: exclusion.rule,
      // The remedy on the row as well as in the sentence, so a screen can
      // render it as an action rather than parsing it back out of prose.
      remedy,
    },
  };
}

// ─── The union ───────────────────────────────────────────────────────────────

/**
 * Merges two declarations of the same surface.
 *
 * `base` wins on `file`, `line`, `detector` and `evidence` when it has them,
 * because those are the fields that make an item actionable — a customer
 * clicking a route in the dark-surface report wants the file that declares it,
 * not the URL a crawler happened to hit. The other side's observation is
 * appended to the evidence rather than discarded, because "declared here AND
 * reached there" is a stronger sentence than either half.
 *
 * THREE THINGS THIS FUNCTION MUST NOT DO, each of which was a defect somewhere:
 *
 *   · It must not set `origin` directly. `sources` is unioned and `origin` is
 *     re-derived from the union with `originFromSources`. Writing SOURCE_ONLY
 *     onto a row whose `sources` say ['SOURCE','TRAFFIC'] is how one row ends
 *     up with two answers and only one of them on screen.
 *   · It must not let `file: null` overwrite a file. A later declarer with less
 *     information is still a declarer; it adds provenance, not blanks.
 *   · It must not drop an `exercise`. A REFUSED item merged with a reached one
 *     becomes EXERCISABLE (the crawl got there in the end, which is the
 *     stronger evidence), but a reached item merged with a refusal must NOT
 *     lose the refusal silently — `preferExercise` states the order.
 */
function preferExercise(
  left: SurfaceItem['exercise'],
  right: SurfaceItem['exercise'],
): SurfaceItem['exercise'] {
  // EXERCISABLE wins: something actually drove it, which beats any prediction
  // that it could not be driven. Then UNEXERCISABLE over REFUSED, because "we
  // know why not" is more informative than "a rule said no". Absent loses to
  // everything, since absent means nobody classified it.
  const rank = (value: SurfaceItem['exercise']): number => {
    if (!value) return 0;
    if (value.state === 'EXERCISABLE') return 3;
    if (value.state === 'UNEXERCISABLE') return 2;
    return 1;
  };
  return rank(right) > rank(left) ? right : left;
}

function merge(base: SurfaceItem, incoming: SurfaceItem): SurfaceItem {
  const sources = [...new Set([...(base.sources ?? []), ...(incoming.sources ?? [])])];
  return {
    ...base,
    file: base.file ?? incoming.file,
    line: base.line ?? incoming.line,
    detector: base.detector ?? incoming.detector,
    sources,
    origin: originOfDeclared(sources),
    environmentId: base.environmentId ?? incoming.environmentId,
    exercise: preferExercise(base.exercise, incoming.exercise),
    evidence: `${base.evidence}; ${incoming.evidence}`,
    meta: { ...incoming.meta, ...base.meta },
    coordinates: base.coordinates ?? incoming.coordinates,
  };
}

/**
 * The inventory.
 *
 * Deterministic in output order — sorted by kind then key — because a caller
 * diffs consecutive inventories, and an unstable order turns every run into a
 * change.
 */
export function buildSurfaceInventory(input: SurfaceInventoryInput): SurfaceInventory {
  const { analysis, flowMap } = input;
  const environmentId = flowMap?.environmentId ?? null;
  const caveats: string[] = [];

  const sourceItems: SurfaceItem[] = [];
  if (analysis) {
    for (const route of analysis.routes) sourceItems.push(itemFromRoute(route));
    for (const endpoint of analysis.endpoints) sourceItems.push(itemFromEndpoint(endpoint));
    for (const form of analysis.forms) sourceItems.push(itemFromForm(form));
    for (const surface of analysis.authSurfaces) sourceItems.push(itemFromAuthSurface(surface));
  }

  const crawlItems: SurfaceItem[] = [];
  let crawledFormCount = 0;
  if (flowMap) {
    for (const node of flowMap.nodes) {
      crawlItems.push(routeItemFromFlowNode(node, flowMap.baseUrl, environmentId));
      crawledFormCount += node.forms.length;
      // Only when the crawl is the entire inventory. See routeItemFromFlowNode.
      if (!analysis) {
        for (const form of node.forms) {
          crawlItems.push(formItemFromFlowNode(node, form, environmentId));
        }
      }
    }
  }

  /*
   * The refusals, as items.
   *
   * `flowMap.excluded` is OPTIONAL and absent means "this crawl did not account
   * for refusals" — every map written before the exclusion ledger existed. That
   * is a different fact from "it refused nothing", and reading the first as the
   * second reports a clean bill of health about destructive flows to every
   * install with an older map. So: undefined → a caveat saying it is unknown,
   * [] → a real measurement of none.
   */
  const refusedItems: SurfaceItem[] = [];
  let notOurSurface = 0;
  const refusalLedger = flowMap?.excluded;
  if (refusalLedger) {
    const seen = new Set<string>();
    for (const exclusion of refusalLedger) {
      const item = itemFromExclusion(
        {
          url: exclusion.url,
          route:
            exclusion.route === null
              ? routeOfRefusedUrl(exclusion.url)
              : canonicalRoute(exclusion.route),
          kind: exclusion.kind,
          rule: exclusion.rule,
        },
        environmentId,
      );
      if (!item) {
        notOurSurface += 1;
        continue;
      }
      // /logout linked from fifty pages is ONE refused surface. Deduped here
      // rather than counted fifty times, the same way the crawler's own ledger
      // writer argues it. The dedupe is by KEY, which is why the key has to be
      // the route whenever a route can be read at all — see
      // `routeOfRefusedUrl`.
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      refusedItems.push(item);
    }
  }

  // Source first, so a merge keeps the source side's file and evidence.
  const byKey = new Map<string, SurfaceItem>();
  for (const item of sourceItems) {
    const existing = byKey.get(item.key);
    // Two detectors finding the same route is agreement, not a duplicate: keep
    // the first and record that another saw it too.
    if (existing) {
      byKey.set(item.key, {
        ...existing,
        evidence: `${existing.evidence}; also ${item.evidence}`,
      });
      continue;
    }
    byKey.set(item.key, item);
  }

  const ROUTE_PREFIX = 'ROUTE:';
  const routeIdentity = (item: SurfaceItem): string => item.key.slice(ROUTE_PREFIX.length);
  const placeholders = (identity: string): number =>
    identity.split('/').filter((segment) => segment === ':param' || segment === '*').length;

  let absorbedInstances = 0;
  /**
   * One declaration folded into the union.
   *
   * Shared by the crawl side, the refusal ledger and every other declarer,
   * because "the same route found by three sources is ONE item with three
   * provenances" has to hold for all three or the rule only applies to the two
   * that happened to be written first.
   */
  const fold = (item: SurfaceItem): void => {
    const exact = byKey.get(item.key);
    if (exact) {
      byKey.set(item.key, merge(exact, item));
      return;
    }
    byKey.set(item.key, item);
  };

  /**
   * Instances folded into the template that declares them.
   *
   * THE STEP THAT STOPS THE DENOMINATOR FILLING WITH PHANTOMS. The crawl
   * reports `/orders/123`, `/orders/456`, `/orders/789`; a declarer declares
   * `/orders/:param`. Keyed literally those are four items, three of which do
   * not exist as distinct testable things — and on a paginated or faceted app it
   * is hundreds. `routeVisits` is the same matcher the gap analyser and
   * `relaxedBasis` use, applied here so one template absorbs its own instances.
   *
   * ─── WHY THIS IS A PASS AND NO LONGER A STEP INSIDE `fold` ─────────────────
   *
   * The template list was snapshotted from the SOURCE items before anything
   * else was folded, and it filtered on `:param`. Two defects came out of that,
   * each demonstrated against a fixture app:
   *
   *   · A declared catch-all absorbed nothing, because `canonicalRoute` spells
   *     `[...slug]`, `[[...slug]]` and `/docs/*` as `/docs/*` and the filter
   *     only looked for `:param`. A declarer naming the documentation subtree
   *     plus a crawl that walked `/docs/intro` and `/docs/guides/auth` left
   *     THREE items here — the template declared-but-never-reached and both
   *     pages reported as "a gap in QAAI's own extraction" — while
   *     `reconcileSurface` over the same two declarers and the same two
   *     spellings answered ONE row, DECLARED_AND_REACHED on a TEMPLATE basis.
   *     One application, two inventories, two numbers: the defect this slice
   *     exists to end, inside the slice itself.
   *   · A template declared by any declarer OTHER than the repo — a route
   *     manifest (CATALOGUE), a hand entry (MANUAL) — absorbed nothing either,
   *     because those items are folded in last and the list had already been
   *     taken. Eight declarers, one of which got the rule.
   *
   * So the absorbers are now every DECLARED template in the union, whoever
   * declared it, most specific first — fewer placeholders wins, ties broken on
   * the key so consecutive runs cannot disagree. That is the preference
   * `moreSpecific` encodes in reconcile.ts, restated rather than imported
   * because reconcile.ts imports `endpointIdentity` from THIS file at run time
   * and a value import back would make a module cycle.
   *
   * ─── WHAT A TEMPLATE IS NOT ALLOWED TO SWALLOW ─────────────────────────────
   *
   *   · A route the source declares in its own right. `/orders/new` beside
   *     `/orders/[id]` is a page with its own file; `file !== null` is the test,
   *     and the exact-key merge in `fold` has already run anyway.
   *   · ANOTHER TEMPLATE. `/docs/:param` is not an instance of `/docs/*`.
   *   · A SURFACE THE CRAWL REFUSED, and this one was a live defect with the
   *     worst possible blast radius. An application declaring `/[slug]` — an
   *     ordinary CMS catch-all — plus a crawl that refused `/logout` produced
   *     ONE item: the refusal was folded into the declared route, the declared
   *     route inherited `UNEXERCISABLE/SESSION_ENDING` through `preferExercise`,
   *     `totalsForKind` then held the declared route out of the coverage
   *     denominator, and the ROUTE axis came back `denominator: 0, percent:
   *     null` for an application with a route and a logout. The refused surface
   *     vanished as an item, a real route carried another surface's reason, and
   *     the caveat said a URL the crawl had refused to open had been "folded
   *     into the dynamic route it belongs to". A refusal is its own surface with
   *     its own reason — rule 4 in this file's header — so an item held out of
   *     the division is never an instance of anything.
   */
  const collapseRouteInstances = (): void => {
    const templates = [...byKey.values()]
      .filter(
        (item) =>
          item.kind === 'ROUTE' &&
          placeholders(routeIdentity(item)) > 0 &&
          // A DECLARED template. An observation of `/orders/:param` is a
          // collapse somebody else already made, not a declaration we may
          // absorb other declarers' rows into.
          (item.sources ?? []).some((source) => !isObservedSource(source)),
      )
      .sort(
        (left, right) =>
          placeholders(routeIdentity(left)) - placeholders(routeIdentity(right)) ||
          left.key.localeCompare(right.key),
      );
    if (templates.length === 0) return;

    // A snapshot, because the loop writes to `byKey`. A merged template keeps
    // its key, so the next instance still finds it.
    for (const item of [...byKey.values()]) {
      if (item.kind !== 'ROUTE') continue;
      const identity = routeIdentity(item);
      // Not another template.
      if (placeholders(identity) > 0) continue;
      // Not a page the source declares in its own right.
      if (item.file !== null) continue;
      // Not a surface we were not allowed to drive: a refusal is its own.
      if (!exercisabilityCounts(item.exercise?.state)) continue;
      const template = templates.find(
        (candidate) => candidate.key !== item.key && routeVisits(identity, routeIdentity(candidate)),
      );
      if (template === undefined) continue;
      const current = byKey.get(template.key) ?? template;
      byKey.set(template.key, merge(current, item));
      byKey.delete(item.key);
      absorbedInstances += 1;
    }
  };

  for (const item of crawlItems) fold(item);

  /*
   * The refusals go in AFTER the reached routes, so a surface the crawl refused
   * on one path and reached on another ends up EXERCISABLE with both sentences
   * on it rather than one of them silently winning. `preferExercise` decides;
   * the order here only decides which evidence sentence reads first.
   */
  for (const item of refusedItems) fold(item);

  /*
   * Every other declarer: a sitemap, an OpenAPI document, traffic, a recording,
   * a requirement, a hand entry, a catalogue.
   *
   * Last, deliberately. A source-declared route carries a FILE and a crawled
   * one carries an environment, and `merge` keeps the first non-null of each —
   * so folding these in last adds provenance to the richest row rather than
   * replacing it with the thinnest. An item here that matches nothing is still
   * an item, which is the whole reason the field exists: a background job, an
   * outbound email and a webhook receiver have no file and no URL, and before
   * this they were not uncovered, they were not THERE.
   */
  for (const item of input.observed ?? []) fold(item);

  // Last, with every declarer in: see `collapseRouteInstances`.
  collapseRouteInstances();

  const items = [...byKey.values()].sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key),
  );

  // ─ Caveats. Each one is a fact about the measurement, stated where the
  //   number is produced rather than in documentation nobody reads. ─

  if (!analysis) {
    caveats.push(
      'No source analysis has run for this project, so the denominator is only what a crawl reached. A page behind a button, a role or a feature flag is invisible to a crawl — connect the repository and the inventory becomes what the code declares.',
    );
  } else if (analysis.coverage.filesWithContent === 0) {
    caveats.push(
      'The source analysis listed files but was given no file contents, so routes were inferred from paths alone and no endpoint, form or auth surface could be read.',
    );
  }

  if (!flowMap) {
    caveats.push(
      'Nothing has crawled this application, so no item is confirmed reachable. Every source-declared item is reported as declared-but-never-reached, which is a fact about our enumeration rather than about your tests.',
    );
  } else if (flowMap.truncatedReason) {
    caveats.push(
      `The crawl stopped early (${flowMap.truncatedReason}), so the set of reachable items is a lower bound. Items marked declared-but-never-reached may simply be past where the crawl stopped.`,
    );
  }

  if (analysis) {
    const blocked = analysis.detectors.filter((detector) => detector.blocked !== null);
    if (blocked.length > 0) {
      caveats.push(
        `${blocked.length} source detector${blocked.length === 1 ? '' : 's'} could not produce facts (${blocked.map((detector) => `${detector.label}: ${detector.blocked}`).join('; ')}), so the denominator is incomplete on ${blocked.length === 1 ? 'that axis' : 'those axes'}.`,
      );
    }

    const unreadableVerbs = analysis.endpoints.filter(
      (endpoint) => endpoint.method === 'UNKNOWN',
    ).length;
    if (unreadableVerbs > 0) {
      caveats.push(
        `${unreadableVerbs} endpoint${unreadableVerbs === 1 ? '' : 's'} were found with unreadable HTTP verbs, so each counts once rather than once per method it may actually serve.`,
      );
    }

    /*
     * THE COUNTED SHORTFALL LEDGER, WHICH IS AN UNDISCLOSED CAP IF IT STOPS
     * HERE.
     *
     * `analysis.shortfalls` is every cause that cost the source read a fact,
     * with a count: a file whose body was never uploaded, a cap that bit, an
     * expression a static pass cannot follow. Every one of those is a surface
     * that is ABSENT from this denominator rather than uncovered — and absent
     * raises the percentage while uncovered lowers it. Dropping the ledger
     * would make the number go UP exactly in proportion to how badly our own
     * reader did, which is the single worst incentive this file could contain.
     *
     * Reported as a total plus the causes, so the sentence is "at least N more
     * existed" rather than "possibly incomplete". `detector === null` means the
     * cause hit every detector, which is why the attribution is printed only
     * when there is one.
     *
     * ABSENT IS NOT EMPTY: a snapshot with no `shortfalls` key predates the
     * ledger, and `[]` means the readers ran and lost nothing.
     */
    const shortfalls = analysis.shortfalls;
    if (shortfalls === undefined) {
      caveats.push(
        'This source analysis predates the shortfall ledger, so how many facts its readers could not report is unknown — not zero. A surface our own reader skipped is absent from this denominator rather than uncovered, and absent raises the percentage.',
      );
    } else if (shortfalls.length > 0) {
      const lost = shortfalls.reduce((running, entry) => running + entry.count, 0);
      caveats.push(
        `The source read could not report at least ${lost} fact${lost === 1 ? '' : 's'} about this application, so that many surfaces may be absent from this denominator rather than uncovered: ${shortfalls
          .map(
            (entry) =>
              `${entry.count}× ${SHORTFALL_REASON_LABELS[entry.reason]}${entry.detector ? ` (${entry.detector})` : ' (every detector)'}`,
          )
          .join('; ')}.`,
      );
    }

    /*
     * Guard declarations that matched no route.
     *
     * A middleware matcher for `/admin/:path*` with no `/admin` route in the
     * inventory means either dead configuration or — far more likely — a whole
     * admin area our route detectors failed to read. That is evidence about OUR
     * extractor, and suppressing it would be hiding our own error rate: the
     * same argument `CRAWL_ONLY` makes, from the other direction.
     */
    const guards = analysis.guards;
    if (guards && guards.length > 0) {
      const routeKeys = new Set(
        items.filter((item) => item.kind === 'ROUTE').map((item) => item.key),
      );
      const unmatched = guards.filter(
        (guard) =>
          guard.patterns.length > 0 &&
          !guard.patterns.some((pattern) =>
            [...routeKeys].some((key) =>
              routeVisits(canonicalRoute(pattern), key.slice('ROUTE:'.length)),
            ),
          ),
      );
      if (unmatched.length > 0) {
        caveats.push(
          `${unmatched.length} guard declaration${unmatched.length === 1 ? '' : 's'} name${unmatched.length === 1 ? 's' : ''} URL patterns that match no route in this inventory (${unmatched
            .slice(0, 3)
            .map((guard) => `${guard.file}: ${guard.patterns.slice(0, 2).join(', ')}`)
            .join('; ')}). Either that configuration is dead, or our route detectors missed the area it protects — which is a gap in OUR extraction and not in your tests.`,
        );
      }
    }
  }

  const reconciliation = {
    sourceOnly: items.filter((item) => item.origin === 'SOURCE_ONLY').length,
    crawlOnly: items.filter((item) => item.origin === 'CRAWL_ONLY').length,
    both: items.filter((item) => item.origin === 'BOTH').length,
    // No declarer list at all — a row from before the column. Its `origin` is
    // still one of the three above, so this is an overlapping count and not a
    // fourth bucket; the caveat below says which.
    declarersUnrecorded: items.filter((item) => item.sources === undefined).length,
  };

  // ─ Provenance, per declarer ───────────────────────────────────────────────

  /*
   * Which declarers were asked, and what each one actually put in.
   *
   * `participation` is the caller's answer and this union does not second-guess
   * it: a declarer the caller did not mention is NOT silently assumed to have
   * been skipped, and one it reports as FAILED is not silently assumed to have
   * declared nothing. When the caller says nothing at all, `complete` is NULL
   * and the caveat says why — which is the one answer that is true whatever
   * happened.
   */
  const declaredBy = new Map<SurfaceSource, { total: number; sole: number }>();
  for (const item of items) {
    const sources = item.sources ?? [];
    for (const source of sources) {
      const tally = declaredBy.get(source) ?? { total: 0, sole: 0 };
      tally.total += 1;
      if (sources.length === 1) tally.sole += 1;
      declaredBy.set(source, tally);
    }
  }

  const asked = input.participation;
  const participation: SurfaceSourceContribution[] = (
    asked ??
    // The default, and it is a DERIVATION rather than a claim: a declarer with
    // items in the union plainly loaded. One with none gets NOT_CONFIGURED and
    // a detail that says out loud that nobody told us whether it was asked, so
    // the sentence on screen is about our bookkeeping and not about the
    // customer's sitemap.
    SURFACE_SOURCES.map((source): SurfaceSourceAsked => {
      const tally = declaredBy.get(source);
      return tally
        ? {
            source,
            participation: 'LOADED',
            detail: `${tally.total} item${tally.total === 1 ? '' : 's'} in this union name it as a declarer`,
          }
        : {
            source,
            participation: 'NOT_CONFIGURED',
            detail:
              'nothing told this union whether this declarer was asked, and it contributed no items — so "not configured" is a statement about our bookkeeping, not a reading of your application',
          };
    })
  ).map((entry) => {
    const counted = entry.participation === 'LOADED';
    const tally = declaredBy.get(entry.source);
    return {
      ...entry,
      counted,
      // Null, not 0, when it did not participate. "It declared nothing" and "it
      // was never read" are the two facts this field exists to keep apart.
      itemsDeclared: counted ? (tally?.total ?? 0) : null,
      soleDeclarerOf: counted ? (tally?.sole ?? 0) : null,
    };
  });

  const failed = participation.filter((entry) => entry.participation === 'FAILED');
  const complete = asked ? failed.length === 0 : null;
  const partialBecause: string[] = [];
  if (asked) {
    for (const entry of failed) {
      partialBecause.push(
        `${entry.source} was asked and could not be read (${entry.detail}), so every surface it would have declared is missing from this denominator. Its absence raises any percentage computed over this union.`,
      );
    }
  } else {
    partialBecause.push(
      'This union did not account for which declarers were asked, so whether it is complete is unknown — not true. A declarer that failed to load and one that was never configured both contribute nothing, and only the first is a hole.',
    );
  }
  caveats.push(...partialBecause);

  if (reconciliation.declarersUnrecorded > 0) {
    caveats.push(
      `${reconciliation.declarersUnrecorded} item${reconciliation.declarersUnrecorded === 1 ? '' : 's'} in this inventory record no declarer list, because ${reconciliation.declarersUnrecorded === 1 ? 'it was' : 'they were'} stored before provenance existed. Their declared/reached origin is the older two-source answer, which is true about source-and-crawl and silent about the other six declarers.`,
    );
  }

  const soleDeclared = participation.filter(
    (entry) => entry.counted && (entry.soleDeclarerOf ?? 0) > 0,
  );
  if (soleDeclared.length > 0) {
    caveats.push(
      `Items with a single declarer, by declarer: ${soleDeclared
        .map((entry) => `${entry.source} ${entry.soleDeclarerOf}`)
        .join(', ')}. A surface only one source names is a weaker claim than one several agree on, and the two are counted apart for that reason.`,
    );
  }

  // ─ What is held out of the division, and why ──────────────────────────────

  const heldOut = {
    unexercisable: items.filter((item) => item.exercise?.state === 'UNEXERCISABLE').length,
    refused: items.filter((item) => item.exercise?.state === 'REFUSED').length,
  };

  if (heldOut.unexercisable > 0) {
    caveats.push(
      `${heldOut.unexercisable} surface${heldOut.unexercisable === 1 ? '' : 's'} cannot be driven safely in this environment — a logout, a delete, a destroy — so ${heldOut.unexercisable === 1 ? 'it is' : 'they are'} counted and named here and held out of the coverage division with ${heldOut.unexercisable === 1 ? 'its' : 'their'} reason. Each one becomes testable the moment the environment can afford the side effect; dropping them instead would raise the percentage by removing the riskiest thing in the application from the denominator.`,
    );
  }
  if (heldOut.refused > 0) {
    caveats.push(
      `${heldOut.refused} surface${heldOut.refused === 1 ? ' was' : 's were'} refused by a crawl policy rule and never attempted, so nothing is claimed about ${heldOut.refused === 1 ? 'it' : 'them'} in either direction. A refused surface and a surface that does not exist are opposite facts.`,
    );
  }
  if (flowMap && !refusalLedger) {
    caveats.push(
      'This crawl recorded no refusal ledger, so whether it declined to drive a logout or a delete flow is unknown — not "none". A destructive surface absent from the denominator raises the coverage percentage, which is the wrong direction.',
    );
  }
  if (notOurSurface > 0) {
    caveats.push(
      `${notOurSurface} refused URL${notOurSurface === 1 ? ' was' : 's were'} off-origin or not a page, so ${notOurSurface === 1 ? 'it is' : 'they are'} not counted as this application's surface. Counting a third party's login form as your route produces a gap you could not possibly close.`,
    );
  }

  // ─ The reverse direction ──────────────────────────────────────────────────

  /*
   * What the suite knows that no declarer did.
   *
   * Against the WHOLE union, which is the strongest denominator this product
   * has — so a target still missing after eight declarers is the hardest
   * evidence of undercount obtainable. `enumerated` is null, not [], when there
   * is no union at all: no analysis, no crawl and no other declarer means we
   * have not enumerated, and reporting every test's route as un-enumerated
   * would be a finding about the customer made out of our own silence.
   */
  const enumeratedRoutes = items
    .filter((item) => item.kind === 'ROUTE')
    .map((item) => item.key.slice('ROUTE:'.length));
  const reverse = reverseReconcile({
    enumerated: items.length === 0 ? null : enumeratedRoutes,
    tests: input.tests ?? [],
  });
  caveats.push(...reverse.caveats);

  /*
   * ─── WHAT "OBSERVED AND NEVER DECLARED" IS ALLOWED TO COUNT ────────────────
   *
   * This sentence said "N items were reached by a crawl but never found in the
   * source" and counted `reconciliation.crawlOnly`, which is `origin ===
   * 'CRAWL_ONLY'` — and `origin` is the legacy TWO-VALUED summary that
   * `originFromSources` derives from the observed/declared split. So the count
   * swept in two classes that were never reached by anything:
   *
   *   · a route only REAL TRAFFIC named. TRAFFIC is an observed declarer, so
   *     its items are CRAWL_ONLY, and no crawl went anywhere near them.
   *   · a route the crawl REFUSED — /logout, /delete-account. The refusal is
   *     recorded as `sources: ['CRAWL']` because the crawl is the declarer, and
   *     the whole point of `FlowMap.excluded` is that we did NOT go there.
   *
   * Both were reported as "reached", which is a thing claimed as measured that
   * was not measured, and for the refusals it is the precise failure the
   * exclusion ledger exists to prevent: a surface we declined to touch recorded
   * the same way as one a crawl drove successfully. They are counted — the
   * held-out caveats above name them, with their reasons — just not here and not
   * as evidence about our extractor.
   *
   * So the count is taken off the items: an observed declarer, no declaring one,
   * and not held out of the division. `exercisabilityCounts` decides the last
   * part, because "were we allowed to touch it" already has one answer in this
   * codebase and a second spelling of it here would drift.
   */
  if (analysis) {
    const observedNeverDeclared = items.filter((item) => {
      const sources = item.sources ?? [];
      if (sources.length === 0) return false;
      if (!sources.some(isObservedSource)) return false;
      if (sources.some((source) => !isObservedSource(source))) return false;
      return exercisabilityCounts(item.exercise?.state);
    });
    if (observedNeverDeclared.length > 0) {
      const declarers = [
        ...new Set(observedNeverDeclared.flatMap((item) => item.sources ?? [])),
      ].sort();
      const count = observedNeverDeclared.length;
      caveats.push(
        `${count} item${count === 1 ? ' was' : 's were'} observed answering (${declarers
          .map((source) => SURFACE_SOURCE_LABELS[source])
          .join(', ')}) and never found in the source. That is a gap in QAAI's own extraction, not in your tests — the route table it reads may not be the one your app uses.`,
      );
    }
  }

  if (absorbedInstances > 0) {
    caveats.push(
      // "crawled URL" was wrong for half of them: an absorbed instance can come
      // from traffic, a sitemap or a hand entry, and one that came from the
      // refusal ledger was never visited at all (it is no longer absorbed —
      // see `collapseRouteInstances`).
      `${absorbedInstances} concrete URL${absorbedInstances === 1 ? ' was' : 's were'} folded into the dynamic route${absorbedInstances === 1 ? ' it is an instance' : 's they are instances'} of, so a route is counted once however many instances of it a declarer named.`,
    );
  }

  // Our own limitation, stated where the number is produced. A form found by
  // the crawl and a form found in the source cannot be matched to each other,
  // so with both inputs present the FORM axis is the source's list only.
  if (analysis && crawledFormCount > 0) {
    caveats.push(
      `The crawl saw ${crawledFormCount} form${crawledFormCount === 1 ? '' : 's'} in the running app. The form axis is counted from the source instead, because a form found in the DOM cannot be reliably matched to one found in a file — so a form that exists only at run time is not in the denominator.`,
    );
  }

  return {
    items,
    // Derived, not hardcoded and not empty. This returned [] for a field whose
    // own doc comment says it names the unmeasured axes, so every caller had to
    // know to ignore it and get the real list from somewhere else.
    unmeasuredKinds: unmeasuredKinds(),
    caveats,
    reconciliation,
    participation,
    complete,
    partialBecause,
    heldOut,
    reverse,
    fingerprint: fingerprintInventory(items),
  };
}

/**
 * Changes whenever the inventory could change.
 *
 * Over the identity-bearing fields only: `key` and `origin`. Deliberately NOT
 * over evidence or meta, because a crawl that reaches the same route via a
 * different URL changes the prose without changing what is being measured, and
 * a fingerprint that moves on prose would invalidate every cached snapshot on
 * every crawl.
 */
export function fingerprintInventory(items: readonly SurfaceItem[]): string {
  const hash = createHash('sha256');
  for (const item of items) {
    hash.update(item.key);
    hash.update('\u0000');
    // `origin` is now derived and can be null for a row whose declarers were
    // never recorded. The literal 'null' keeps that case distinct from the
    // three real origins instead of hashing the empty string for it.
    hash.update(item.origin ?? 'null');
    hash.update('\u0000');
    /*
     * The declarer set, sorted, and the exercisability.
     *
     * Both are identity-bearing in the sense this hash means: a route that was
     * declared only by the repo and is now also walked by real traffic IS a
     * different measurement, and a surface that went from EXERCISABLE to
     * REFUSED has moved out of the division. Without these the fingerprint
     * would hold still across exactly the changes this slice added, and every
     * cached snapshot would stay valid through them.
     */
    hash.update([...(item.sources ?? [])].sort().join(','));
    hash.update('\u0000');
    hash.update(item.exercise?.state ?? 'unclassified');
    hash.update('\u0000');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * The axes QAAI has no extractor for.
 *
 * Delegates to shared rather than restating the list. This used to hardcode
 * eight strings while `unmeasuredKinds()` in shared derived the same answer
 * from MEASURED_SURFACE_KINDS and had no caller — two derivations of one fact,
 * with the drift-prone copy wired in. Adding a ninth axis would have updated
 * the real list and left this one stale.
 */
export function missingAxes(): SurfaceKind[] {
  return unmeasuredKinds();
}
