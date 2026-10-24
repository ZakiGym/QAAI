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
 */

import { createHash } from 'node:crypto';
import {
  MEASURED_SURFACE_KINDS,
  surfaceKey,
  type AuthSurface,
  type CodebaseAnalysis,
  type FlowMap,
  type FlowNode,
  type HttpEndpoint,
  type PageRoute,
  type SourceForm,
  type SurfaceItem,
  type SurfaceKind,
} from '@qaai/shared';
import { canonicalRoute, routeVisits } from './coverage.js';

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
  };
  /** Changes whenever the inventory could change. */
  fingerprint: string;
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

// ─── Source side ─────────────────────────────────────────────────────────────

function itemFromRoute(route: PageRoute): SurfaceItem {
  const identity = canonicalRoute(route.route);
  return {
    kind: 'ROUTE',
    key: surfaceKey('ROUTE', identity),
    label: identity,
    file: route.file,
    line: null,
    origin: 'SOURCE_ONLY',
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
    origin: 'SOURCE_ONLY',
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
    origin: 'SOURCE_ONLY',
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
    origin: 'SOURCE_ONLY',
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
function routeItemFromFlowNode(node: FlowNode, baseUrl: string): SurfaceItem {
  const identity = canonicalRoute(node.route);
  return {
    kind: 'ROUTE',
    key: surfaceKey('ROUTE', identity),
    label: identity,
    file: null,
    line: null,
    origin: 'CRAWL_ONLY',
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
): SurfaceItem {
  const identity = canonicalRoute(node.route);
  return {
    kind: 'FORM',
    key: surfaceKey('FORM', `${identity}#${form.id}`),
    label: form.name,
    file: null,
    line: null,
    origin: 'CRAWL_ONLY',
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

// ─── The union ───────────────────────────────────────────────────────────────

/**
 * Merges two observations of the same item.
 *
 * The source side wins on `file`, `line`, `detector` and `evidence` because
 * those are the fields that make an item actionable — a customer clicking a
 * route in the dark-surface report wants the file that declares it, not the URL
 * a crawler happened to hit. The crawl side's observation is appended to the
 * evidence rather than discarded, because "declared here AND reached there" is
 * a stronger sentence than either half.
 */
function merge(source: SurfaceItem, crawl: SurfaceItem): SurfaceItem {
  return {
    ...source,
    origin: 'BOTH',
    evidence: `${source.evidence}; ${crawl.evidence}`,
    meta: { ...crawl.meta, ...source.meta },
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
      crawlItems.push(routeItemFromFlowNode(node, flowMap.baseUrl));
      crawledFormCount += node.forms.length;
      // Only when the crawl is the entire inventory. See routeItemFromFlowNode.
      if (!analysis) {
        for (const form of node.forms) crawlItems.push(formItemFromFlowNode(node, form));
      }
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

  /**
   * Route templates from the source, for matching concrete crawled URLs.
   *
   * This is the step that stops the denominator filling with phantoms. The
   * crawl reports `/orders/123`, `/orders/456`, `/orders/789`; the source
   * declares `/orders/:param`. Keyed literally those are four items, three of
   * which do not exist as distinct testable things — and on a paginated or
   * faceted app it is hundreds. `routeVisits` is the same matcher the gap
   * analyser uses, applied here so one template absorbs its own instances.
   *
   * Exact keys are tried first and separately: a static route must never be
   * absorbed by a template that merely happens to be compatible with it.
   */
  const routeTemplates = [...byKey.values()].filter(
    (item) => item.kind === 'ROUTE' && item.key.includes(':param'),
  );

  let absorbedInstances = 0;
  for (const item of crawlItems) {
    const exact = byKey.get(item.key);
    if (exact) {
      byKey.set(item.key, merge(exact, item));
      continue;
    }

    if (item.kind === 'ROUTE') {
      const crawled = item.key.slice('ROUTE:'.length);
      const template = routeTemplates.find((candidate) =>
        routeVisits(crawled, candidate.key.slice('ROUTE:'.length)),
      );
      if (template) {
        const current = byKey.get(template.key) ?? template;
        byKey.set(template.key, merge(current, item));
        absorbedInstances += 1;
        continue;
      }
    }

    byKey.set(item.key, item);
  }

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
  }

  const reconciliation = {
    sourceOnly: items.filter((item) => item.origin === 'SOURCE_ONLY').length,
    crawlOnly: items.filter((item) => item.origin === 'CRAWL_ONLY').length,
    both: items.filter((item) => item.origin === 'BOTH').length,
  };

  if (reconciliation.crawlOnly > 0 && analysis) {
    caveats.push(
      `${reconciliation.crawlOnly} item${reconciliation.crawlOnly === 1 ? '' : 's'} were reached by a crawl but never found in the source. That is a gap in QAAI's own extraction, not in your tests — the route table it reads may not be the one your app uses.`,
    );
  }

  if (absorbedInstances > 0) {
    caveats.push(
      `${absorbedInstances} crawled URL${absorbedInstances === 1 ? '' : 's'} were folded into the dynamic route${absorbedInstances === 1 ? ' it belongs' : 's they belong'} to, so a route is counted once however many instances of it the crawl visited.`,
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
    unmeasuredKinds: [],
    caveats,
    reconciliation,
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
    hash.update(item.origin);
    hash.update('\u0000');
  }
  return hash.digest('hex').slice(0, 16);
}

/** The axes QAAI has no extractor for, for a report to name rather than omit. */
export function missingAxes(): SurfaceKind[] {
  return (
    [
      'ROLE_CELL',
      'COMPONENT_STATE',
      'FLAG_COMBINATION',
      'BACKGROUND_JOB',
      'NOTIFICATION',
      'ERROR_STATE',
      'DEVICE_LOCALE',
      'DATA_VARIANT',
    ] as SurfaceKind[]
  ).filter((kind) => !MEASURED_SURFACE_KINDS.includes(kind));
}
