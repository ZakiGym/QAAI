/**
 * Analyze-source processor (§3.1b): turn a codebase into a test plan, with no
 * model and no browser.
 *
 * The Explorer answers "what does this app DO" by driving it. This answers the
 * cheaper, earlier question — "what does this app CLAIM to have" — by reading
 * what the ingest pass extracted from the customer's own source. It exists
 * because the first thing a new user has is a repository, not a running URL,
 * and because the crawl is useless on an app that will not start until someone
 * has configured six environment variables.
 *
 * ── The boundary, which every sentence this file writes must respect ─────────
 *
 * A static pass knows what the tree DECLARES. It does not know what the app
 * DOES. It has not rendered a page, issued a request, followed a redirect, or
 * seen a single byte of a response. So:
 *
 *   • "there is a route file at app/orders/[id]/page.tsx" is a fact.
 *   • "/orders/:id returns 200" is not a fact; it is the test's question.
 *   • "this route is guarded" is a fact about a decorator or a middleware
 *     matcher. Whether the guard actually refuses anyone is the test's question.
 *   • a journey — "add to cart, then check out" — is NOT derivable. There is no
 *     import graph and no runtime, so this file proposes none and says so,
 *     rather than inventing a plausible one.
 *
 * Every rationale below is therefore evidence-shaped: the file it came from,
 * the fact read out of it, and the edge of the claim. A rationale that implied
 * the page renders would be the product lying about its own knowledge, which
 * is the failure mode this whole wave exists to stop.
 *
 * ── Deterministic first, model second ───────────────────────────────────────
 *
 * Nothing here calls a model, on purpose — the same rule packages/agent's
 * coverage.ts works under, and for the same reason: this deployment has no
 * ANTHROPIC_API_KEY by the owner's standing choice, and a feature that only
 * works with one is a feature this product does not have. A model can enrich
 * these items later (that is what the Generator is for); without one they are
 * still complete, still approvable, and still turn into tests that run.
 *
 * ── How an approved item becomes a test that RUNS ───────────────────────────
 *
 * It goes through the SAME generate processor as a crawl-derived item — this
 * file mints no test content of its own. That processor generates against a
 * FlowMap, so the analysis is translated into one (`flowMapFromSource`) and
 * stored alongside the plan. That is not a lie about a crawl: the FlowMap is
 * this repo's shared vocabulary for "routes, forms, auth walls", the row's
 * `truncatedReason` says in one sentence that nothing was rendered, and every
 * node carries `stateKey: 'source'` because a static pass cannot tell two
 * states of one route apart.
 *
 * The payoff is concrete. `scaffoldSpec` in @qaai/agent reads exactly two
 * things off a FlowMap — the public routes and the auth-walled ones — and the
 * source knows both without a browser. So ACCESSIBILITY, SECURITY_SMOKE and
 * API items scaffold into plugin-valid specs on a deployment with no key at
 * all, while E2E and SMOKE stay APPROVED and wait for one.
 */

import { canScaffoldWithoutModel } from '@qaai/agent';
import { AUTH_SURFACE_KINDS, CREATABLE_TEST_TYPES, TEST_TYPES, TEST_TYPE_LABELS } from '@qaai/shared';
import type {
  AuthSurfaceKind,
  FlowMap,
  FlowNode,
  FormField,
  FormModel,
  PlanItem,
  Priority,
  Selector,
  TestPlan,
  TestType,
} from '@qaai/shared';
import { config, logger, prisma, publishEvent } from '../context.js';
import { enqueueGenerate, type AnalyzeSourceJob } from '../queues.js';

// ─────────────────────────────────────────────────────────────────────────────
// The analysis this processor consumes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHY THESE TYPES LIVE HERE AND NOT IN packages/shared: the ingest half of this
 * wave is being written in parallel and `packages/shared/src/codebase.ts` did
 * not exist when this file was written. Declaring the shape here — rather than
 * blocking, or importing a module that may never land — keeps the two halves
 * independently reviewable, and `parseCodebaseAnalysis` below is written to be
 * tolerant enough that a near-miss on field names degrades to "that subject was
 * not found" instead of a crash.
 *
 * When the shared module lands, this block moves there and the import changes.
 * Nothing else in this file does.
 */

/** One field of a form, as the SOURCE declares it. No DOM was consulted. */
export interface SourceFormField {
  /** The `name` attribute, or the schema key the handler reads. */
  name: string;
  label: string | null;
  /** HTML input type, or 'select' / 'textarea'. */
  inputType: string;
  required: boolean;
  /** Same 16-value vocabulary the crawler uses, so the two agree downstream. */
  semantic: FormField['semantic'];
}

export interface SourceForm {
  name: string;
  /**
   * Route the form is declared on, when it could be tied to one.
   *
   * Null is a real answer and not a defect: the producer finds a form by
   * scanning markup, so the FILE is the only location fact it has. A form in
   * `components/ContactForm.tsx` sits on whichever page imports it, and there
   * is no import graph here to say which. `attachForms` resolves the ones that
   * can be resolved and leaves the rest null rather than parking them on `/`.
   */
  route: string | null;
  /**
   * The literal `action` attribute, when the markup states one. Kept because it
   * is the only thing on a form that names a URL outright, and it is the first
   * rule `attachForms` tries.
   */
  action: string | null;
  /** Repo-relative file. This is the evidence, and it is never optional. */
  file: string;
  fields: SourceFormField[];
  submitLabel: string | null;
}

export interface SourceRoute {
  /** Normalised, dynamic segments as `:name` — the FlowNode vocabulary. */
  path: string;
  file: string;
  /**
   * True when a guard was found in the source: middleware, decorator, layout.
   *
   * Always false for anything @qaai/shared produces today. `PageRoute` and
   * `HttpEndpoint` (packages/shared/src/codebase.ts) carry no guard field, no
   * detector there reads one, and the single file that would hold a Next.js
   * matcher — `middleware.ts` — is on that module's skip list. The ingest
   * response says as much in its own words: "what this cannot tell you …
   * which pages need a login". So this is read but never set from a real
   * analysis, and a plan built from one proposes no authenticated scenario.
   * It stays read because a snapshot written by hand, or by a later producer
   * that DOES express a guard, must not lose it silently.
   */
  behindAuth: boolean;
  /** What the guard was, concretely enough for a human to disagree with it. */
  authEvidence: string | null;
  forms: SourceForm[];
}

export interface SourceEndpoint {
  /** Upper-cased HTTP verb. */
  method: string;
  path: string;
  file: string;
  behindAuth: boolean;
  authEvidence: string | null;
}

/*
 * The vocabulary comes from @qaai/shared, which is what WRITES these — this
 * file used to declare its own five-name list (SIGN_IN/SIGN_UP/SIGN_OUT/
 * PASSWORD_RESET/MFA) against the seven shared actually emits (LOGIN/SIGNUP/
 * LOGOUT/PASSWORD_RESET/VERIFY/SSO/SESSION). Only PASSWORD_RESET overlapped, so
 * the parser below rejected almost every surface as an unknown kind and the
 * plan silently proposed no authentication tests at all — on the one subject
 * where a missing test is least acceptable.
 *
 * Re-exported because callers and tests import it from here.
 */
export { AUTH_SURFACE_KINDS };
export type { AuthSurfaceKind };

export interface SourceAuthSurface {
  kind: AuthSurfaceKind;
  /**
   * Named `path` by the producer. Kept as `path` here too: this type used to
   * call it `route`, and a rename at the boundary is exactly how the two sides
   * stopped agreeing.
   */
  path: string;
  file: string;
  /** The producer's own sentence about why this is an auth surface. */
  evidence: string;
  /** The credential form, when the extractor found one on the same route. */
  form: SourceForm | null;
}

export interface CodebaseAnalysis {
  /** Bumped when the shape changes; an unknown version is still parsed leniently. */
  schema: number;
  analyzedAt: string;
  /** Human labels for the plan's prose: 'Next.js', 'Express', 'Django'. */
  frameworks: string[];
  routes: SourceRoute[];
  /**
   * Every form the analysis declares, flat — the shape the producer publishes
   * them in (`CodebaseAnalysis.forms`, packages/shared/src/codebase.ts). Forms
   * that could be tied to a route also hang off that route, so the FlowMap
   * keeps its per-node form models; this list is what the plan counts and what
   * it derives E2E items from, so a form on no known route is still proposed
   * rather than lost.
   */
  forms: SourceForm[];
  endpoints: SourceEndpoint[];
  authSurfaces: SourceAuthSurface[];
  /**
   * What the ingest could not read — unparseable files, skipped directories, a
   * truncated upload. Carried onto the plan verbatim, because a plan that is
   * quietly short has to say why or it reads as the agent's judgement.
   */
  warnings: string[];
}

/**
 * Project columns this processor will accept the stored analysis on, in order.
 *
 * This list was written when the ingest half of the wave was expected to land
 * the analysis on a Project COLUMN. It did not: `POST /projects/:id/source`
 * stores it in the `CodebaseSnapshot` table, and the two halves shipped
 * disagreeing about where the input lives — every job failed with the "no
 * stored codebase analysis" message below, which is at least the loud miss
 * this file was designed to produce rather than a plan quietly built from
 * nothing.
 *
 * `loadAnalysis` is the real read path now. This stays as a fallback because
 * the dependency-injected tests seed a row through it, and because a project
 * that acquires such a column later keeps working without touching this file.
 */
export const PROJECT_ANALYSIS_FIELDS = ['codebaseAnalysis', 'sourceAnalysis'] as const;

/** Project columns the funnel may have stored the test-type preference on. */
export const PROJECT_TEST_TYPE_FIELDS = [
  'testTypePreference',
  'preferredTestTypes',
  'testTypes',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Bounds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many items reach the approval screen. A repository can declare hundreds
 * of routes; a person can tick thirty boxes. Everything past the cap is listed
 * by name in `skipped`, so nothing disappears silently — it is deferred, in
 * writing, with a reason.
 */
export const MAX_PLAN_ITEMS = 40;

/** How many of the deferred items are named individually before the tail is summarised. */
const MAX_NAMED_SKIPS = 60;

/** Ceilings on a JSON blob written by another process. Bounded work, always. */
const MAX_ROUTES = 2000;
const MAX_ENDPOINTS = 4000;
/** The producer's own cap on the top-level list (MAX_FORMS in codebase.ts). */
const MAX_FORMS = 500;
const MAX_FORMS_PER_ROUTE = 20;
const MAX_FIELDS_PER_FORM = 60;
const MAX_AUTH_SURFACES = 40;
const MAX_WARNINGS = 50;

/**
 * The types proposed when the funnel stored no preference.
 *
 * Exactly the three the four derivation rules produce, and no more. A default
 * that quietly included, say, LOAD would put a k6 scenario in front of someone
 * who never asked for one and cannot run it.
 */
export const DEFAULT_TEST_TYPES: readonly TestType[] = ['SMOKE', 'API', 'E2E'];

/**
 * Types this pass can derive from source at all, and what it derives them from.
 * A requested type absent from this map is skipped with this sentence, so the
 * user hears "static analysis cannot found this on anything" rather than
 * silence.
 */
const DERIVABLE: Partial<Record<TestType, string>> = {
  SMOKE: 'one per route declared in the source',
  API: 'one per HTTP endpoint declared in the source',
  E2E: 'one per form, and one per sign-in surface',
  ACCESSIBILITY: 'one axe scan over the routes the source declares',
  SECURITY_SMOKE: 'one probe that the routes the source guards actually refuse anonymous requests',
};

// ─────────────────────────────────────────────────────────────────────────────
// Parsing what another process wrote
// ─────────────────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

const arr = (v: unknown, cap: number): unknown[] => (Array.isArray(v) ? v.slice(0, cap) : []);

/** A route path the rest of this file can reason about: leading slash, no query. */
function normalisePath(raw: string): string | null {
  const trimmed = raw.trim().split('?')[0]!.split('#')[0]!;
  if (trimmed === '') return null;
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  // Collapse doubled slashes and drop a trailing one, so '/products/' and
  // '/products' are one route rather than two items a human has to notice are
  // the same.
  const collapsed = withSlash.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  return collapsed;
}

/**
 * The URL an entry sits at, whichever of the two names the producer used.
 *
 * @qaai/shared spells one idea two ways: a page route's URL is `route`
 * (`PageRoute`), an endpoint's is `path` (`HttpEndpoint`), and an auth
 * surface's is `path` again. `parseRoute` read only `path`, so `str(undefined)`
 * was '', `normalisePath('')` was null, and the guard below rejected EVERY page
 * route a real analysis produced: no SMOKE items, no ACCESSIBILITY item, and a
 * FlowMap with no nodes — a pure-frontend app yielded an entirely empty plan.
 *
 * `parseAuthSurface` had already been patched with its own local fallback for
 * exactly this reason. One helper, used by all three call sites, is what stops
 * the two sides drifting apart a fourth time.
 */
function pathOf(raw: Record<string, unknown>): string | null {
  return normalisePath(str(raw.path) || str(raw.route));
}

/** `app/account/page.tsx` → `app/account`; '' for a file at the repo root. */
function dirOf(file: string): string {
  const normalised = file.replace(/\\/g, '/');
  const cut = normalised.lastIndexOf('/');
  return cut === -1 ? '' : normalised.slice(0, cut);
}

const SEMANTICS: ReadonlySet<string> = new Set<FormField['semantic']>([
  'email',
  'password',
  'person_name',
  'phone',
  'street_address',
  'city',
  'postal_code',
  'country',
  'credit_card',
  'card_expiry',
  'card_cvc',
  'date',
  'number',
  'search',
  'freeform',
  'unknown',
]);

function parseField(raw: unknown): SourceFormField | null {
  if (!isRecord(raw)) return null;
  const name = str(raw.name).trim();
  if (name === '') return null;
  const semantic = str(raw.semantic);
  return {
    name,
    label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : null,
    inputType: str(raw.inputType, 'text') || 'text',
    required: raw.required === true,
    // An unrecognised hint becomes 'unknown' rather than being trusted: the
    // synthetic-data generator switches on this union and a stray value would
    // fall through its cases silently.
    semantic: SEMANTICS.has(semantic) ? (semantic as FormField['semantic']) : 'unknown',
  };
}

function parseForm(raw: unknown, routePath: string | null): SourceForm | null {
  if (!isRecord(raw)) return null;
  const file = str(raw.file).trim();
  if (file === '') return null; // No evidence, no item. The file IS the argument.
  const fields = arr(raw.fields, MAX_FIELDS_PER_FORM)
    .map(parseField)
    .filter((f): f is SourceFormField => f !== null);
  const declaredRoute = typeof raw.route === 'string' ? normalisePath(raw.route) : null;
  return {
    name: str(raw.name).trim() || 'form',
    route: declaredRoute ?? routePath,
    action: typeof raw.action === 'string' ? normalisePath(raw.action) : null,
    file,
    fields,
    submitLabel:
      typeof raw.submitLabel === 'string' && raw.submitLabel.trim() !== ''
        ? raw.submitLabel.trim()
        : null,
  };
}

function parseRoute(raw: unknown): SourceRoute | null {
  if (!isRecord(raw)) return null;
  const path = pathOf(raw);
  const file = str(raw.file).trim();
  if (path === null || file === '') return null;
  return {
    path,
    file,
    behindAuth: raw.behindAuth === true,
    authEvidence: typeof raw.authEvidence === 'string' ? raw.authEvidence.trim() || null : null,
    forms: arr(raw.forms, MAX_FORMS_PER_ROUTE)
      .map((f) => parseForm(f, path))
      .filter((f): f is SourceForm => f !== null),
  };
}

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

function parseEndpoint(raw: unknown): SourceEndpoint | null {
  if (!isRecord(raw)) return null;
  const path = pathOf(raw);
  const file = str(raw.file).trim();
  const method = str(raw.method).trim().toUpperCase();
  if (path === null || file === '' || !HTTP_METHODS.has(method)) return null;
  return {
    method,
    path,
    file,
    behindAuth: raw.behindAuth === true,
    authEvidence: typeof raw.authEvidence === 'string' ? raw.authEvidence.trim() || null : null,
  };
}

function parseAuthSurface(raw: unknown): SourceAuthSurface | null {
  if (!isRecord(raw)) return null;
  const kind = str(raw.kind).trim().toUpperCase();
  // `path` is what the producer writes; `pathOf` reads `route` as a fallback so
  // a snapshot stored by the older shape still yields its auth tests.
  const path = pathOf(raw);
  const file = str(raw.file).trim();
  if (path === null || file === '') return null;
  if (!(AUTH_SURFACE_KINDS as readonly string[]).includes(kind)) return null;
  return {
    kind: kind as AuthSurfaceKind,
    path,
    file,
    evidence: str(raw.evidence).trim(),
    form: parseForm(raw.form, path),
  };
}

/**
 * Read an analysis out of whatever the ingest pass stored.
 *
 * Tolerant on purpose, in the shape of `resolveFlakePolicy`: the input is JSON
 * written by another process, and the failure that matters is not "a field was
 * shaped oddly" but "we invented a subject that is not in the customer's
 * repository". So every entry that cannot be read WITH ITS EVIDENCE FILE is
 * dropped rather than defaulted, and a blob with nothing readable in it comes
 * back with empty lists — which the caller reports rather than papering over.
 */
export function parseCodebaseAnalysis(raw: unknown): CodebaseAnalysis | null {
  if (!isRecord(raw)) return null;

  const routes = dedupeRoutes(
    arr(raw.routes, MAX_ROUTES)
      .map(parseRoute)
      .filter((r): r is SourceRoute => r !== null),
  );
  const endpoints = arr(raw.endpoints, MAX_ENDPOINTS)
    .map(parseEndpoint)
    .filter((e): e is SourceEndpoint => e !== null);
  // The top-level list is the producer's, and it names no route: `attachForms`
  // ties what it can to the routes above and hands back the whole set, nested
  // forms included.
  const forms = attachForms(
    routes,
    arr(raw.forms, MAX_FORMS)
      .map((f) => parseForm(f, null))
      .filter((f): f is SourceForm => f !== null),
  );
  const authSurfaces = arr(raw.authSurfaces, MAX_AUTH_SURFACES)
    .map(parseAuthSurface)
    .filter((a): a is SourceAuthSurface => a !== null)
    // The producer's `AuthSurface` carries no form, so the credential fields
    // are matched in from the list above — see `formForSurface`.
    .map((surface) => (surface.form ? surface : { ...surface, form: formForSurface(surface, forms) }));

  return {
    schema: typeof raw.schema === 'number' ? raw.schema : 1,
    analyzedAt: str(raw.analyzedAt) || new Date(0).toISOString(),
    /*
     * The fourth field-name disagreement on this boundary, and the same shape
     * as the other three: the producer emits `AppFrameworkSignal` OBJECTS
     * (`{ framework, evidence, file }`), while this read them as plain strings.
     * `str()` on an object is '', every entry was filtered out, and the plan
     * summary a person reads — "N tests proposed from your codebase (Next.js,
     * Express)" — silently lost its parenthetical for every repo ever analysed.
     *
     * The string branch is kept because snapshots written before this fix are
     * still in the table and still get read back.
     */
    frameworks: arr(raw.frameworks, 20)
      .map((f) => (isRecord(f) ? str(f.framework) : str(f)).trim())
      .filter((f) => f !== ''),
    routes,
    forms,
    endpoints: dedupeEndpoints(endpoints),
    authSurfaces,
    warnings: arr(raw.warnings, MAX_WARNINGS)
      .map((w) => str(w).trim())
      .filter((w) => w !== ''),
  };
}

/** One item per route. Two files declaring `/login` is one page to a tester. */
function dedupeRoutes(routes: SourceRoute[]): SourceRoute[] {
  const byPath = new Map<string, SourceRoute>();
  for (const route of routes) {
    const existing = byPath.get(route.path);
    if (!existing) {
      byPath.set(route.path, route);
      continue;
    }
    // Merge rather than drop: a layout file may carry the guard while the page
    // file carries the form, and losing either would lose a real fact.
    byPath.set(route.path, {
      ...existing,
      behindAuth: existing.behindAuth || route.behindAuth,
      authEvidence: existing.authEvidence ?? route.authEvidence,
      forms: [...existing.forms, ...route.forms].slice(0, MAX_FORMS_PER_ROUTE),
    });
  }
  return [...byPath.values()];
}

/**
 * Tie each declared form to the route it sits on, and return every form there is.
 *
 * The producer publishes forms at the TOP LEVEL of the analysis
 * (`CodebaseAnalysis.forms`, packages/shared/src/codebase.ts) with a file and no
 * route, because a `<form>` is found by scanning markup and the file is the only
 * location fact that scan has. This parser looked for forms NESTED inside each
 * route and nowhere else, so every form a real analysis produced was dropped:
 * no E2E item for any of them, no fields on the login item, and
 * `summaryFromSource` said "0 form(s)" one click after the ingest response had
 * listed several — two screens of one feature contradicting each other.
 *
 * Matching is by evidence, most specific first, and a route file claimed by
 * more than one route is not used at all: `src/App.tsx` declaring ten
 * `<Route path>` elements says nothing about which of the ten a form in that
 * file belongs to, and picking one would be a guess wearing a citation.
 */
function attachForms(routes: SourceRoute[], topLevel: SourceForm[]): SourceForm[] {
  const byPath = new Map(routes.map((route) => [route.path, route]));
  const byFile = new Map<string, SourceRoute | null>();
  const byDir = new Map<string, SourceRoute | null>();
  for (const route of routes) {
    byFile.set(route.file, byFile.has(route.file) ? null : route);
    const dir = dirOf(route.file);
    byDir.set(dir, byDir.has(dir) ? null : route);
  }

  // Two entries for one form — a nested copy and a top-level one — are one
  // form. Keyed on file plus name, which is what the producer makes unique
  // (`form 1 in <file>` when the markup names none).
  const seen = new Set<string>();
  const out: SourceForm[] = [];
  const keep = (form: SourceForm): void => {
    const key = `${form.file}|${form.name}`;
    if (seen.has(key) || out.length >= MAX_FORMS) return;
    seen.add(key);
    out.push(form);
  };

  for (const route of routes) for (const form of route.forms) keep(form);

  for (const form of topLevel) {
    const host =
      (form.route !== null ? byPath.get(form.route) : undefined) ??
      (form.action !== null ? byPath.get(form.action) : undefined) ??
      byFile.get(form.file) ??
      byDir.get(dirOf(form.file)) ??
      null;
    const resolved = host ? { ...form, route: host.path } : form;
    if (host && host.forms.length < MAX_FORMS_PER_ROUTE) {
      // Onto the route as well as into the flat list: `flowMapFromSource` reads
      // per-node forms, and that is how a generated E2E test gets its fields.
      if (!host.forms.some((f) => f.file === resolved.file && f.name === resolved.name)) {
        host.forms.push(resolved);
      }
    }
    keep(resolved);
  }

  return out;
}

/**
 * The credential form for an auth surface.
 *
 * The producer's `AuthSurface` (codebase.ts) is kind/path/from/file/evidence and
 * nothing else — the fields live on the form. Without this every login item read
 * "the source names no fields on it" for repositories whose sign-in form had
 * just been parsed field by field, and the generated test had nothing to fill in.
 *
 * Matched on the surface's own evidence — the file it was read from, or the
 * route it sits at — and a form with a password field wins, because that is what
 * makes a form a credential form rather than the newsletter box below it.
 */
function formForSurface(surface: SourceAuthSurface, forms: SourceForm[]): SourceForm | null {
  const candidates = forms.filter(
    (form) => form.file === surface.file || (form.route !== null && form.route === surface.path),
  );
  return (
    candidates.find((form) => form.fields.some((field) => field.semantic === 'password')) ??
    candidates[0] ??
    null
  );
}

/** METHOD + path is the identity of an endpoint; the same pair twice is one. */
function dedupeEndpoints(endpoints: SourceEndpoint[]): SourceEndpoint[] {
  const seen = new Map<string, SourceEndpoint>();
  for (const endpoint of endpoints) {
    const key = `${endpoint.method} ${endpoint.path}`;
    if (!seen.has(key)) seen.set(key, endpoint);
  }
  return [...seen.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// The org's chosen test types
// ─────────────────────────────────────────────────────────────────────────────

export interface TestTypeChoice {
  /** What the plan may propose. Always a subset of CREATABLE_TEST_TYPES. */
  types: TestType[];
  /** Whether the funnel actually stored something, or this is the fallback. */
  source: 'stored' | 'default';
  /**
   * Requested strings that were refused, with the reason. Surfaced on the plan
   * rather than dropped: a user who ticked "Load" in the funnel and sees no
   * load test is owed the sentence explaining it.
   */
  refused: Array<{ what: string; why: string }>;
}

/**
 * Resolve the funnel's stored preference into types this pass may actually
 * propose.
 *
 * Two filters, and each has cost the product a bug before. CREATABLE_TEST_TYPES
 * is the honest set — a type with no NEW_TEST_TEMPLATES entry has no plugin-
 * validated scaffold, so proposing it mints a test the runner cannot execute.
 * DERIVABLE is the narrower question of whether static facts can found the item
 * at all; a VISUAL baseline is perfectly runnable and completely unjustifiable
 * from a file tree, and saying so is better than inventing a pixel budget.
 */
export function resolveTestTypeChoice(raw: unknown): TestTypeChoice {
  const requested = readRequestedTypes(raw);
  if (requested === null) {
    return { types: [...DEFAULT_TEST_TYPES], source: 'default', refused: [] };
  }

  const types: TestType[] = [];
  const refused: TestTypeChoice['refused'] = [];

  for (const entry of requested) {
    const candidate = entry.trim().toUpperCase();
    if (!(TEST_TYPES as readonly string[]).includes(candidate)) {
      refused.push({ what: entry, why: 'not a test type this product has.' });
      continue;
    }
    const type = candidate as TestType;
    if (types.includes(type)) continue;
    if (!CREATABLE_TEST_TYPES.includes(type)) {
      refused.push({
        what: TEST_TYPE_LABELS[type],
        why: 'there is no scaffold its runner plugin accepts, so an approved item could not become a test that runs.',
      });
      continue;
    }
    if (!DERIVABLE[type]) {
      refused.push({
        what: TEST_TYPE_LABELS[type],
        why: 'reading source cannot found one — it needs a judgement (or a running app) this pass does not have. Run the Explorer against a URL, or write it by hand.',
      });
      continue;
    }
    types.push(type);
  }

  // Every requested type was refused. Falling back to the defaults here would
  // quietly overrule the user; an empty list is honest and the caller turns it
  // into a plan that says nothing could be proposed.
  return { types, source: 'stored', refused };
}

/** null means "the funnel stored nothing", which is different from "it stored []". */
function readRequestedTypes(raw: unknown): string[] | null {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
  if (isRecord(raw)) {
    // `{ testTypes: [...] }` — the shape a settings blob would take.
    for (const key of ['testTypes', 'types']) {
      const nested = raw[key];
      if (Array.isArray(nested)) return nested.filter((v): v is string => typeof v === 'string');
    }
  }
  return null;
}

/** Pull the preference off a project row without naming a column in a select. */
export function testTypeChoiceFromProject(row: Record<string, unknown> | null): TestTypeChoice {
  for (const field of PROJECT_TEST_TYPE_FIELDS) {
    const value = row?.[field];
    if (value === undefined || value === null) continue;
    const choice = resolveTestTypeChoice(value);
    if (choice.source === 'stored') return choice;
  }
  return { types: [...DEFAULT_TEST_TYPES], source: 'default', refused: [] };
}

/** Pull the stored analysis off a project row, same reasoning as above. */
export function analysisFromProject(row: Record<string, unknown> | null): CodebaseAnalysis | null {
  for (const field of PROJECT_ANALYSIS_FIELDS) {
    const parsed = parseCodebaseAnalysis(row?.[field]);
    if (parsed) return parsed;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Source facts → plan items
// ─────────────────────────────────────────────────────────────────────────────

const clamp = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/**
 * The one sentence every rationale ends on, and the only place in this file
 * allowed to use the vocabulary of running something.
 *
 * Exported because the test that walks every generated item looking for claims
 * of observation has to subtract this sentence first — it is the disclaimer,
 * not a claim, and a copy of the string in the test would be a copy that drifts.
 */
export const STATIC_ONLY_SENTENCE =
  'Read from the source; nothing was rendered or requested, so whether it behaves this way is what running the test would establish.';
const STATIC_ONLY = STATIC_ONLY_SENTENCE;

/** `/orders/:id` → 'Orders'. The suite tree groups on this. */
function featureFor(path: string): string {
  const segment = path.split('/').filter((s) => s !== '' && !s.startsWith(':'))[0];
  if (!segment) return 'Root';
  const words = segment.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Falls back to 'root', not to a generic word: the one subject that slugs to
 * nothing is the path `/`, and calling its item `source:smoke:item` is both
 * unreadable and a collision waiting for the next empty-slugging subject.
 */
const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'root';

/** Deterministic, so re-analysing an unchanged repo proposes the same handles. */
const itemId = (kind: string, subject: string): string => `source:${kind}:${slug(subject)}`;

/** True for a path the source declares with a segment nobody can fill in blind. */
const isDynamic = (path: string): boolean => path.includes(':');

const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function smokeItem(route: SourceRoute): PlanItem {
  const dynamic = isDynamic(route.path);
  const priority: Priority = dynamic
    ? 'NICE_TO_HAVE'
    : route.path === '/'
      ? 'CRITICAL_PATH'
      : 'IMPORTANT';

  return {
    id: itemId('smoke', route.path),
    title: clamp(`${route.path} renders`, 160),
    rationale: clamp(
      `\`${route.file}\` declares the route \`${route.path}\`.` +
        (route.behindAuth
          ? ` The source guards it${route.authEvidence ? ` (${route.authEvidence})` : ''}, so a signed-out visitor should not reach it.`
          : '') +
        (dynamic
          ? ' The path has a dynamic segment, so the source names the shape of the id and no value it takes.'
          : '') +
        ` ${STATIC_ONLY}`,
      1000,
    ),
    feature: clamp(featureFor(route.path), 80),
    priority,
    testType: 'SMOKE',
    steps: [
      ...(route.behindAuth ? ['Sign in — the source guards this route'] : []),
      ...(dynamic
        ? [
            `Obtain a real value for each dynamic segment of ${route.path} — the source names the segment, not any id that exists`,
          ]
        : []),
      `Open ${route.path}`,
    ],
    assertions: [
      `${route.path} answers with a successful status rather than a server error`,
      `The response is this page's own content, not a generic error or an empty shell — assert something only ${route.path} can produce`,
      ...(route.behindAuth
        ? [`Signed out, ${route.path} refuses or redirects rather than rendering`]
        : []),
    ],
    journeyId: null,
    authProfileId: null,
  };
}

function apiItem(endpoint: SourceEndpoint): PlanItem {
  const writes = WRITE_METHODS.has(endpoint.method);
  const label = `${endpoint.method} ${endpoint.path}`;

  /*
   * A write endpoint gets the NEGATIVE case, not the happy path, and this is
   * the most important judgement in the file. Static analysis knows the handler
   * exists; it does not know a body the handler would accept, and a proposal
   * that asserts "POST /orders returns 201" is asking a human to approve a
   * guess. What the source DOES support is the refusal: a guarded endpoint must
   * turn away a request carrying no credentials, and any endpoint must turn
   * away a body it cannot parse. Both are real tests, and neither needs a fact
   * this pass does not have.
   */
  const expectation = endpoint.behindAuth
    ? 'refuses an unauthenticated request with 401 or 403 — never 200, and never a 500'
    : writes
      ? 'rejects an empty or malformed body with a 4xx that names the problem — never a 500, and never a silent success'
      : 'answers 200 with the content type it declares';

  return {
    id: itemId('api', label),
    title: clamp(`${label} ${writes ? 'refuses a bad request' : 'answers'}`, 160),
    rationale: clamp(
      `\`${endpoint.file}\` declares the handler \`${label}\`.` +
        (endpoint.behindAuth
          ? ` The source guards it${endpoint.authEvidence ? ` (${endpoint.authEvidence})` : ''}.`
          : '') +
        (writes
          ? ' It writes, and the source names no request body it accepts, so this covers the refusal rather than guessing a payload that would succeed.'
          : '') +
        ` ${STATIC_ONLY}`,
      1000,
    ),
    feature: clamp(featureFor(endpoint.path), 80),
    priority: endpoint.behindAuth ? 'CRITICAL_PATH' : 'IMPORTANT',
    testType: 'API',
    steps: [
      ...(isDynamic(endpoint.path)
        ? [
            `Substitute a real value for each dynamic segment of ${endpoint.path} — the source names the segment, not an id that exists`,
          ]
        : []),
      endpoint.behindAuth
        ? `Send ${label} with no session and no credentials`
        : writes
          ? `Send ${label} with an empty body`
          : `Send ${label}`,
    ],
    assertions: [
      `${label} ${expectation}`,
      ...(endpoint.behindAuth
        ? ['The refusal leaks nothing about the resource behind it — no record, no id, no field names']
        : []),
    ],
    journeyId: null,
    authProfileId: null,
  };
}

function formItem(form: SourceForm, behindAuth: boolean): PlanItem {
  /*
   * A form the analysis could not tie to a route used to be proposed on `/`,
   * which is a claim about where it renders and not one the source makes. The
   * item is still worth proposing — the fields are read, the file is the
   * evidence — so the unknown is stated instead, and the tester is told to find
   * the page rather than sent to the wrong one.
   */
  const route = form.route;
  const required = form.fields.filter((f) => f.required);

  return {
    id: itemId('form', `${route ?? form.file}-${form.name}`),
    title: clamp(
      route
        ? `Submit the "${form.name}" form on ${route}`
        : `Submit the "${form.name}" form declared in ${form.file}`,
      160,
    ),
    rationale: clamp(
      `\`${form.file}\` declares a form named "${form.name}" with ${form.fields.length} field(s)` +
        (required.length > 0
          ? `, ${required.length} of them marked required in the source`
          : ', none of them marked required in the source') +
        `.${behindAuth ? ' The route it sits on is guarded, so reaching it needs a session.' : ''}` +
        (route
          ? ''
          : ' The source names no route for it — a form is found by reading markup, and which page renders this file needs an import graph this pass does not have.') +
        ` ${STATIC_ONLY}`,
      1000,
    ),
    feature: clamp(route ? featureFor(route) : 'Forms', 80),
    priority: 'IMPORTANT',
    testType: 'E2E',
    steps: [
      ...(behindAuth ? ['Sign in — the source guards the route this form sits on'] : []),
      route
        ? `Navigate to ${route}`
        : `Open the page that renders ${form.file} — the source ties this form to no route`,
      ...form.fields
        .slice(0, 25)
        .map(
          (f) =>
            `Fill "${f.label ?? f.name}" with a valid ${f.semantic.replace(/_/g, ' ')} value` +
            (f.required ? ' (the source marks it required)' : ''),
        ),
      form.submitLabel ? `Submit with "${form.submitLabel}"` : 'Submit the form',
      // The locators come out of source, not out of a rendered page, so the
      // first thing the test proves is that they match anything at all.
      'Locate each field by its label or name as the source declares it — this pass never saw the rendered markup',
    ].slice(0, 40),
    assertions: [
      'The submission is accepted and the resulting state reflects what was entered, not merely that a success message appeared',
      required.length > 0
        ? `Leaving "${required[0]!.label ?? required[0]!.name}" empty is refused, and the error names that field`
        : 'Submitting invalid input is refused rather than silently accepted',
    ],
    journeyId: null,
    authProfileId: null,
  };
}

export const AUTH_TITLES: Record<AuthSurfaceKind, string> = {
  LOGIN: 'Sign in with valid credentials, and fail with invalid ones',
  SIGNUP: 'Register a new account, and refuse a duplicate one',
  LOGOUT: 'Sign out, and lose access to what the session unlocked',
  PASSWORD_RESET: 'Request a password reset and complete it',
  VERIFY: 'Complete the verification step, and refuse a wrong code',
  SSO: 'Sign in through the identity provider, and land back signed in',
  SESSION: 'A session outlives a reload, and ends when it should',
};

function authItem(surface: SourceAuthSurface): PlanItem {
  const fields = surface.form?.fields ?? [];

  return {
    id: itemId('auth', `${surface.kind}-${surface.path}`),
    title: clamp(AUTH_TITLES[surface.kind], 160),
    rationale: clamp(
      `\`${surface.file}\` declares a ${surface.kind.toLowerCase().replace(/_/g, ' ')} surface at \`${surface.path}\`` +
        (fields.length > 0
          ? ` with ${fields.map((f) => `"${f.label ?? f.name}"`).join(', ')}`
          : ', though the source names no fields on it') +
        '. Authentication is the gate every other guarded test has to pass, so it is proposed at critical path.' +
        ` ${STATIC_ONLY}`,
      1000,
    ),
    feature: 'Authentication',
    priority: 'CRITICAL_PATH',
    testType: 'E2E',
    steps: [
      `Navigate to ${surface.path}`,
      ...(fields.length > 0
        ? fields
            .slice(0, 20)
            .map((f) => `Fill "${f.label ?? f.name}" with a valid ${f.semantic.replace(/_/g, ' ')} value`)
        : ['Fill the credential fields the page presents — the source names none, so read them off the page']),
      surface.form?.submitLabel ? `Submit with "${surface.form.submitLabel}"` : 'Submit',
      'Repeat with a deliberately wrong credential',
    ].slice(0, 40),
    assertions: [
      'A valid attempt ends signed in — assert something only a session can reach, not that the form disappeared',
      'A wrong credential is refused, and the message does not reveal which half was wrong',
    ],
    journeyId: null,
    authProfileId: null,
  };
}

function accessibilityItem(routes: SourceRoute[]): PlanItem {
  const scanned = routes.filter((r) => !r.behindAuth && !isDynamic(r.path));
  return {
    id: itemId('a11y', 'declared-routes'),
    title: clamp('Every page the source declares passes an axe scan', 160),
    rationale: clamp(
      `The source declares ${routes.length} route(s), ${scanned.length} of them reachable without a session and free of dynamic segments. That list is exactly what an axe scan needs, and it is one of the few things a file tree can supply outright. ${STATIC_ONLY}`,
      1000,
    ),
    feature: 'Accessibility',
    priority: 'IMPORTANT',
    testType: 'ACCESSIBILITY',
    steps: [
      `Scan each of the ${scanned.length || 1} public route(s) the source declares against WCAG 2.1 AA`,
    ],
    assertions: [
      'No serious or critical axe violation on any scanned route',
      'Routes behind a guard are covered separately, with a session — this item scans only what the source says is public',
    ],
    journeyId: null,
    authProfileId: null,
  };
}

function securityItem(guarded: Array<{ path: string; evidence: string | null }>): PlanItem {
  return {
    id: itemId('security', 'guarded-routes'),
    title: clamp('Guarded routes actually refuse an anonymous request', 160),
    rationale: clamp(
      `The source guards ${guarded.length} route(s)${
        guarded[0]?.evidence ? ` (for example: ${guarded[0].evidence})` : ''
      }. A guard in the source is a claim; that no anonymous request gets past it is the thing worth proving, and the claim is the only part reading files can establish. ${STATIC_ONLY}`,
      1000,
    ),
    feature: 'Security',
    priority: 'CRITICAL_PATH',
    testType: 'SECURITY_SMOKE',
    steps: [
      `Request each of the ${guarded.length} guarded path(s) with no session`,
      'Inspect the security headers on the public paths',
    ],
    assertions: [
      'Every guarded path refuses an anonymous request — a redirect to sign-in counts, a 200 does not',
      'No refusal carries data from behind the guard in its body',
    ],
    journeyId: null,
    authProfileId: null,
  };
}

const PRIORITY_RANK: Record<Priority, number> = {
  CRITICAL_PATH: 0,
  IMPORTANT: 1,
  NICE_TO_HAVE: 2,
};

export interface DerivedPlan {
  items: PlanItem[];
  skipped: Array<{ what: string; why: string }>;
  /** Counts for the summary line and the log. */
  totals: { routes: number; endpoints: number; forms: number; authSurfaces: number };
}

/**
 * The whole deterministic pass: static facts in, approvable proposals out.
 *
 * Pure — no database, no clock, no model — so its judgement is testable over a
 * fixture and its output is a function of the repository alone.
 */
export function scenariosFromSource(
  analysis: CodebaseAnalysis,
  choice: TestTypeChoice,
): DerivedPlan {
  const wants = (type: TestType): boolean => choice.types.includes(type);
  const items: PlanItem[] = [];
  const skipped: Array<{ what: string; why: string }> = [...choice.refused];

  // The analysis's own flat list, not a walk over the routes: a form the source
  // ties to no route is still a form a user fills in, and counting only the
  // attached ones is how the plan came to disagree with the ingest screen.
  const guardByPath = new Map(analysis.routes.map((route) => [route.path, route.behindAuth]));
  const forms = analysis.forms.map((form) => ({
    form,
    behindAuth: form.route !== null && (guardByPath.get(form.route) ?? false),
  }));
  const totals = {
    routes: analysis.routes.length,
    endpoints: analysis.endpoints.length,
    forms: forms.length,
    authSurfaces: analysis.authSurfaces.length,
  };

  if (wants('SMOKE')) items.push(...analysis.routes.map(smokeItem));
  if (wants('API')) items.push(...analysis.endpoints.map(apiItem));
  if (wants('E2E')) {
    items.push(...analysis.authSurfaces.map(authItem));
    items.push(...forms.map(({ form, behindAuth }) => formItem(form, behindAuth)));
  }
  if (wants('ACCESSIBILITY') && analysis.routes.length > 0) {
    items.push(accessibilityItem(analysis.routes));
  }

  const guarded = [
    ...analysis.routes.filter((r) => r.behindAuth).map((r) => ({ path: r.path, evidence: r.authEvidence })),
    ...analysis.endpoints
      .filter((e) => e.behindAuth)
      .map((e) => ({ path: e.path, evidence: e.authEvidence })),
  ];
  if (wants('SECURITY_SMOKE')) {
    if (guarded.length > 0) items.push(securityItem(guarded));
    else {
      skipped.push({
        what: TEST_TYPE_LABELS.SECURITY_SMOKE,
        why: 'the source declares no guarded route or endpoint, so there is no auth wall to probe. That is a fact about the files read, not a statement that the app has no auth.',
      });
    }
  }

  // A type asked for that the repository gave nothing to found. Said once per
  // type, naming what would have produced it.
  for (const type of choice.types) {
    if (items.some((i) => i.testType === type)) continue;
    if (type === 'SECURITY_SMOKE') continue; // Already explained above.
    skipped.push({
      what: TEST_TYPE_LABELS[type],
      why: `nothing in the analysis to found one on — ${DERIVABLE[type] ?? 'no derivation exists'}, and none was found.`,
    });
  }

  // Critical path first, then the order the source declared things in. Stable,
  // because the approval screen's top item should not shuffle between runs on
  // an unchanged repository.
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.item.priority] - PRIORITY_RANK[b.item.priority] || a.index - b.index,
    )
    .map((entry) => entry.item);

  const chosen = ordered.slice(0, MAX_PLAN_ITEMS);
  const deferred = ordered.slice(MAX_PLAN_ITEMS);
  for (const item of deferred.slice(0, MAX_NAMED_SKIPS)) {
    skipped.push({
      what: item.title,
      why: `below the top ${MAX_PLAN_ITEMS} by priority in this analysis. Re-run the analysis after approving these, or write it by hand.`,
    });
  }
  if (deferred.length > MAX_NAMED_SKIPS) {
    skipped.push({
      what: `${deferred.length - MAX_NAMED_SKIPS} further proposals`,
      why: `also below the top ${MAX_PLAN_ITEMS}, and too many to list individually.`,
    });
  }

  for (const warning of analysis.warnings) {
    skipped.push({
      what: 'Part of the repository the analysis could not read',
      why: warning,
    });
  }

  return { items: chosen, skipped, totals };
}

/** The prose above the approval list. Says what was read, and what was not. */
export function summaryFromSource(derived: DerivedPlan, analysis: CodebaseAnalysis): string {
  const { totals } = derived;
  const frameworks = analysis.frameworks.length > 0 ? ` (${analysis.frameworks.join(', ')})` : '';
  const count = derived.items.length;
  return (
    `${count} test${count === 1 ? '' : 's'} proposed from your codebase${frameworks} — ` +
    `${totals.routes} route(s), ${totals.endpoints} endpoint(s), ${totals.forms} form(s) and ` +
    `${totals.authSurfaces} auth surface(s) read out of the source. ` +
    `Nothing was rendered and no request was sent: these are the claims the code makes, ` +
    `and each item is a way to find out whether the claim holds. ` +
    `No journeys are proposed — a path through the app is a runtime fact, and there is no ` +
    `import graph here to infer one from; point the Explorer at a running URL for those. ` +
    `Written deterministically, without a model.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Source facts → a FlowMap the Generator already knows how to read
// ─────────────────────────────────────────────────────────────────────────────

/** The one sentence stamped on the stored row so nothing downstream mistakes this for a crawl. */
export const SOURCE_FLOW_MAP_REASON =
  'Derived from source files, not from a crawl. Nothing was rendered and no request was sent, so redirects, client-rendered routes, real ids and page state are all unknown. Run the Explorer against a URL to replace this with what the app actually does.';

/**
 * Selectors from source are guesses about markup this pass never saw, so they
 * are minted at low confidence deliberately: the Generator flags anything under
 * 0.6 for review, and that flag is the honest signal here.
 */
const SOURCE_SELECTOR_CONFIDENCE = 0.4;

function selectorForField(field: SourceFormField): Selector {
  if (field.label) {
    return { strategy: 'LABEL', value: field.label, confidence: SOURCE_SELECTOR_CONFIDENCE };
  }
  return {
    strategy: 'CSS',
    value: `[name="${field.name}"]`,
    confidence: SOURCE_SELECTOR_CONFIDENCE,
  };
}

function formModel(form: SourceForm, index: number): FormModel {
  return {
    id: `source-form-${index}`,
    name: form.name,
    selector: { strategy: 'CSS', value: 'form', confidence: SOURCE_SELECTOR_CONFIDENCE },
    fields: form.fields.map((field) => ({
      name: field.name,
      label: field.label,
      inputType: field.inputType,
      required: field.required,
      selector: selectorForField(field),
      semantic: field.semantic,
    })),
    submit: form.submitLabel
      ? {
          strategy: 'ROLE',
          value: 'button',
          name: form.submitLabel,
          confidence: SOURCE_SELECTOR_CONFIDENCE,
        }
      : null,
  };
}

/**
 * Translate the analysis into the Generator's input vocabulary.
 *
 * Every field that would be a claim about runtime is filled with the value that
 * means "not observed", not with a plausible one: no edges (no import graph, so
 * no transition is knowable), no journeys (a journey is a runtime path), no
 * screenshots, and `stateKey: 'source'` on every node because one route is one
 * declaration and a static pass cannot tell a logged-in state from an empty-cart
 * one.
 */
export function flowMapFromSource(
  analysis: CodebaseAnalysis,
  ctx: { projectId: string; environmentId: string; version: number; baseUrl: string },
): FlowMap {
  let formIndex = 0;
  const nodes: FlowNode[] = analysis.routes.map((route) => ({
    id: `source:${route.path}`,
    route: route.path,
    url: `${ctx.baseUrl.replace(/\/$/, '')}${route.path}`,
    // The route, not a page title: nothing rendered, so no <title> was read.
    title: route.path,
    stateKey: 'source',
    requiresRoles: [],
    behindAuth: route.behindAuth,
    forms: route.forms.map((form) => formModel(form, formIndex++)),
    affordances: [],
    screenshotKey: null,
    a11yViolationCount: 0,
  }));

  const features = new Map<string, string[]>();
  for (const node of nodes) {
    const name = featureFor(node.route);
    features.set(name, [...(features.get(name) ?? []), node.id]);
  }

  return {
    projectId: ctx.projectId,
    environmentId: ctx.environmentId,
    version: ctx.version,
    baseUrl: ctx.baseUrl,
    nodes,
    edges: [],
    journeys: [],
    features: [...features].map(([name, nodeIds]) => ({ name, nodeIds })),
    exploredAt: analysis.analyzedAt,
    truncatedReason: SOURCE_FLOW_MAP_REASON,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The processor
// ─────────────────────────────────────────────────────────────────────────────

export interface AnalyzeSourceDeps {
  /**
   * Test seam. Production reads the analysis off the project row — see
   * PROJECT_ANALYSIS_FIELDS for why it is read untyped.
   */
  loadProjectRow?: (orgId: string, projectId: string) => Promise<Record<string, unknown> | null>;
  /**
   * The stored analysis, from the snapshot the ingest wrote.
   *
   * Separate from `loadProjectRow` because they answer different questions off
   * different tables: the project row carries what the person CHOSE, and the
   * snapshot carries what their source SAID. Merging them into one loader is
   * what let the two halves of this wave disagree in the first place.
   */
  loadAnalysis?: (orgId: string, projectId: string) => Promise<CodebaseAnalysis | null>;
}

export async function processAnalyzeSource(
  job: AnalyzeSourceJob,
  deps: AnalyzeSourceDeps = {},
): Promise<void> {
  const { orgId, projectId } = job;
  const channel = `explore:${projectId}`;

  const say = (message: string): void => {
    publishEvent(orgId, {
      // The onboarding screen subscribes to `explore:<projectId>` (see the
      // comment on GET /projects/:id/explore/events). A source analysis is not
      // a crawl, but it IS the same step of the same funnel from the user's
      // side, so it reports on the channel that screen is already listening to
      // rather than opening a second one nothing reads.
      runId: channel,
      type: 'log',
      data: { message },
      at: new Date().toISOString(),
    });
  };

  const row =
    (await (deps.loadProjectRow ?? defaultLoadProjectRow)(orgId, projectId)) ??
    null;
  if (!row) throw new Error(`Project ${projectId} not found for org ${orgId}`);

  /*
   * The snapshot first, the project row second. A project with both has been
   * re-ingested since whatever put the column there, and the newer upload is
   * the one the person is waiting on.
   */
  const analysis =
    (await (deps.loadAnalysis ?? defaultLoadAnalysis)(orgId, projectId)) ??
    analysisFromProject(row);
  if (!analysis) {
    // A missing input is not this processor's failure, but it must be loud and
    // it must name the fix — a job that "succeeded" having found nothing is the
    // no-op that looks like a feature working.
    throw new Error(
      `No stored codebase analysis on project ${projectId}. Looked at: the latest CodebaseSnapshot, then project.${PROJECT_ANALYSIS_FIELDS.join('/')}. Import the application source first — POST /projects/${projectId}/source, or Setup → Add app. This processor reads, it does not fetch.`,
    );
  }

  const subjects =
    analysis.routes.length + analysis.endpoints.length + analysis.authSurfaces.length;
  if (subjects === 0) {
    throw new Error(
      `The stored codebase analysis for project ${projectId} has no routes, endpoints or auth surfaces in it${
        analysis.warnings.length > 0 ? ` (it reported: ${analysis.warnings.join('; ')})` : ''
      }. There is nothing to propose a test against.`,
    );
  }

  const choice = testTypeChoiceFromProject(row);
  say(
    `Reading your codebase: ${analysis.routes.length} route(s), ${analysis.endpoints.length} endpoint(s), ${analysis.authSurfaces.length} auth surface(s). ` +
      (choice.source === 'stored'
        ? `Proposing the type(s) you chose: ${choice.types.map((t) => TEST_TYPE_LABELS[t]).join(', ') || 'none left after filtering'}.`
        : `No test-type preference stored, so proposing the safe default: ${choice.types.map((t) => TEST_TYPE_LABELS[t]).join(', ')}.`),
  );

  const derived = scenariosFromSource(analysis, choice);
  if (derived.items.length === 0) {
    throw new Error(
      `Nothing could be proposed for project ${projectId}: ${
        derived.skipped.map((s) => `${s.what} — ${s.why}`).join(' ') || 'no reason recorded'
      }`,
    );
  }

  /*
   * The Generator generates against a FlowMap, and a FlowMap row is scoped to an
   * environment. A project that arrived as a repository may not have one yet —
   * that is a real and expected state, not an error — so the plan is written
   * either way and the missing half is stated on it. Approving an item here
   * still records the human's decision; only the generation waits.
   */
  const environment = await prisma.environment.findFirst({
    where: { orgId, projectId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, baseUrl: true },
  });

  const skipped = [...derived.skipped];
  let flowMapId: string | null = null;
  let flowMapVersion = 0;

  if (!environment) {
    skipped.push({
      what: 'Turning these into test files',
      why: 'this project has no environment yet, and a generated test needs a base URL to run against. Add one under Setup → Environments, then approve this plan.',
    });
  } else {
    const previous = await prisma.flowMap.findFirst({
      where: { orgId, projectId, environmentId: environment.id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (previous?.version ?? 0) + 1;
    const flowMap = flowMapFromSource(analysis, {
      projectId,
      environmentId: environment.id,
      version,
      baseUrl: environment.baseUrl,
    });
    const stored = await prisma.flowMap.create({
      data: {
        orgId,
        projectId,
        environmentId: environment.id,
        version,
        // Prisma's Json input type does not accept a named interface directly;
        // eslint's `no-unnecessary-type-assertion` disagrees and is wrong here,
        // because the receiver is `InputJsonValue`, not `FlowMap`.
        graph: flowMap as unknown as object,
        nodeCount: flowMap.nodes.length,
        edgeCount: 0,
        journeyCount: 0,
        truncatedReason: SOURCE_FLOW_MAP_REASON,
      },
    });
    flowMapId = stored.id;
    flowMapVersion = version;
  }

  if (!config.anthropicApiKey && derived.items.some((i) => i.testType === 'API')) {
    // The plan item names a method and a path; the no-key API scaffold in
    // @qaai/agent writes a single GET against the first public route and flags
    // it. That gap is the Generator's, not the plan's, and the person ticking
    // the box is the one who needs to know about it before they read the file.
    skipped.push({
      what: 'The exact request chain inside each API test',
      why: 'without ANTHROPIC_API_KEY the Generator scaffolds one GET against the first public route and flags it for review. The method, path and expectation this plan names are in the item; putting them in the generated spec needs a model.',
    });
  }

  const plan: TestPlan = {
    // 0 when no environment exists, because then no flow map was written and
    // there is no version to point at — not because version 0 exists.
    flowMapVersion,
    summary: summaryFromSource(derived, analysis),
    skipped,
    items: derived.items,
  };

  /*
   * The plan and its audit row land together or not at all. Every mutation
   * audits, and a retry that wrote a second plan because the audit failed after
   * the first one would be two plans and one record of one.
   */
  const testPlan = await prisma.$transaction(async (tx) => {
    const created = await tx.testPlan.create({
      data: {
        orgId,
        projectId,
        flowMapId,
        summary: plan.summary,
        skipped: plan.skipped,
        items: {
          create: plan.items.map((item) => ({
            orgId,
            title: item.title,
            rationale: item.rationale,
            feature: item.feature,
            priority: item.priority,
            testType: item.testType,
            steps: item.steps,
            assertions: item.assertions,
            journeyId: item.journeyId,
            authProfileId: item.authProfileId,
          })),
        },
      },
      include: { items: { select: { id: true, testType: true } } },
    });

    await tx.auditLog.create({
      data: {
        orgId,
        userId: job.requestedBy,
        action: 'plan.from-source',
        targetType: 'TestPlan',
        targetId: created.id,
        metadata: {
          projectId,
          flowMapId,
          items: created.items.length,
          testTypes: choice.types,
          testTypeSource: choice.source,
          routes: derived.totals.routes,
          endpoints: derived.totals.endpoints,
          forms: derived.totals.forms,
          authSurfaces: derived.totals.authSurfaces,
          writtenByModel: false,
        },
      },
    });

    return created;
  });

  logger.info(
    {
      planId: testPlan.id,
      projectId,
      items: testPlan.items.length,
      flowMapId,
      testTypes: choice.types,
      ...derived.totals,
    },
    'plan proposed from source',
  );

  publishEvent(orgId, {
    runId: channel,
    type: 'run.finished',
    data: {
      planId: testPlan.id,
      items: testPlan.items.length,
      source: 'codebase',
      writtenByModel: false,
    },
    at: new Date().toISOString(),
  });

  if (!job.autoApprove || testPlan.items.length === 0) return;

  await prisma.planItem.updateMany({
    where: { testPlanId: testPlan.id },
    data: { state: 'APPROVED', decidedBy: job.requestedBy, decidedAt: new Date() },
  });

  if (!flowMapId) {
    say(
      `${testPlan.items.length} item(s) approved. No test file was written: this project has no environment, so there is no base URL to generate a runnable test against. Add one and approve the plan again.`,
    );
    return;
  }

  /*
   * The same split explore.ts makes on the same deployment, for the same
   * reason: test CODE needs a model, but the spec-driven types scaffold
   * deterministically from the flow map above — which, here, is the customer's
   * own route list. So without a key the scaffoldable subset is generated and
   * the rest stays APPROVED, waiting for one, instead of failing the job.
   */
  const generatable = config.anthropicApiKey
    ? testPlan.items
    : testPlan.items.filter((i) => canScaffoldWithoutModel(i.testType));

  if (generatable.length > 0) {
    await enqueueGenerate({
      orgId,
      projectId,
      testPlanId: testPlan.id,
      planItemIds: generatable.map((i) => i.id),
      requestedBy: job.requestedBy,
    });
  }

  const waiting = testPlan.items.length - generatable.length;
  if (waiting > 0) {
    say(
      `${testPlan.items.length} item(s) approved. ${generatable.length} scaffold from your source without a model; the other ${waiting} need ANTHROPIC_API_KEY, which is not set on this deployment. They stay approved — set the key and approve the plan again.`,
    );
  } else {
    say(`${testPlan.items.length} item(s) approved and queued for generation.`);
  }
}

/**
 * Read the project row WITHOUT a `select`.
 *
 * Deliberate: the analysis and the type preference live in columns the ingest
 * and funnel halves of this wave add, and naming an unmigrated column in a
 * select is a compile error here and a runtime error in production. Reading the
 * whole row costs one extra round of scalars and lets this processor work the
 * day the migration lands, with no change to this file.
 */
/**
 * The most recent ingest for this project.
 *
 * `findFirst` ordered by `createdAt` rather than a unique lookup: a project can
 * be re-ingested any number of times, every snapshot is kept, and the plan must
 * be built from the newest source rather than whichever row came back first.
 *
 * A stored blob is parsed, never trusted — `parseCodebaseAnalysis` is the same
 * gate the project-column path goes through, so a snapshot written by an older
 * shape of the ingest reads as "no analysis" instead of crashing the job on a
 * missing field.
 */
async function defaultLoadAnalysis(
  orgId: string,
  projectId: string,
): Promise<CodebaseAnalysis | null> {
  const snapshot = await prisma.codebaseSnapshot.findFirst({
    where: { projectId, orgId },
    orderBy: { createdAt: 'desc' },
    select: { analysis: true },
  });
  return parseCodebaseAnalysis(snapshot?.analysis);
}

async function defaultLoadProjectRow(
  orgId: string,
  projectId: string,
): Promise<Record<string, unknown> | null> {
  const row = await prisma.project.findFirst({ where: { id: projectId, orgId } });
  return (row) ?? null;
}
