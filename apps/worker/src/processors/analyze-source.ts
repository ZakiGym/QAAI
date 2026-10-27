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

import {
  MAX_BOUNDARY_CASES_PER_GAP,
  canScaffoldWithoutModel,
  chooseAuthProfile,
  expandNegativeCases,
  type AuthProfileChoice,
  type FormSummary,
  type GapAuthProfile,
} from '@qaai/agent';
import {
  AUTH_SURFACE_KINDS,
  COMPONENT_ITEM_KINDS,
  CREATABLE_TEST_TYPES,
  FORM_FIELD_SEMANTICS,
  TEST_TYPES,
  TEST_TYPE_LABELS,
  componentHasOwnAxis,
} from '@qaai/shared';
import type {
  AuthSurfaceKind,
  ComponentItemKind,
  FlowMap,
  FlowNode,
  FormField,
  FormFieldSemantic,
  FormModel,
  PlanItem,
  Priority,
  Selector,
  TestPlan,
  TestType,
} from '@qaai/shared';
import { config, logger, prisma, publishEvent } from '../context.js';
import { enqueueGenerate, type AnalyzeSourceJob } from '../queues.js';
import {
  readSourceUnderTest,
  type SourceUnderTestContext,
  type WorkspaceFileReader,
} from '../lib/workspace.js';

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

/**
 * One field of a form, as the SOURCE declares it. No DOM was consulted.
 *
 * ─── What this shape can and cannot feed into a boundary expansion ───────────
 *
 * `expandBoundaries` partitions a field's input space using the constraints the
 * page declares, and this is the honest inventory of which of them survive a
 * static read. The producer is `analyseCodebase` in packages/shared/src/codebase.ts
 * (`detectForms`), and it reads a `<form>` block with regexes: for each control
 * it takes `name`/`id`, the associated label, `type`, the bare `required`
 * attribute, the six declared constraints (`maxlength`, `minlength`, `min`,
 * `max`, `step`, `pattern`) and — for a `<select>` — the literal `<option>`
 * text.
 *
 * PRESENT, so these classes are reachable: happy-path, empty, whitespace-only
 * (from `required`), unbounded-length, injection-like, wrong-type,
 * luhn-invalid, boundary-date (from `semantic`/`inputType`), unicode-emoji
 * (where the semantic admits it), and not-in-options (from `options`, which
 * `parseField` used to drop and now keeps — the producer has always written it).
 *
 * ALSO PRESENT NOW, and this paragraph used to say the opposite: at-max-length,
 * over-max-length, at-min-length, under-min-length, at-min, under-min, at-max,
 * over-max, step-misaligned and pattern-violating. Every one needs a number or
 * a regex off the markup — `maxlength`, `minlength`, `min`, `max`, `step`,
 * `pattern` — and the inventory recorded that `detectForms` read none of them
 * and that the fix was a request on packages/shared rather than something that
 * could be faked here. That request was granted:
 * `SOURCE_FORM_CONSTRAINTS` in packages/shared/src/codebase.ts reads all six.
 *
 * The request being granted is not the same as the value arriving, and for one
 * round it did not: `parseField` never read the six keys and
 * `negativeExpansionFor` hard-coded them absent, so the producer read them, the
 * consumer had a slot for each, and the ten classes stayed unreachable because
 * the link between them dropped the values. Both ends are wired now.
 *
 * Absence still has two meanings and they are still kept apart, which is the
 * part of the old paragraph that was right: a constraint is UNCAPTURED when the
 * producer could not read the tag completely (a JSX expression, a spread) and
 * DECLARED_ABSENT when it read the tag and the attribute is not there. Only the
 * second licenses the unbounded classes, and only the first asks for a crawl.
 */
export interface SourceFormField {
  /** The `name` attribute, or the schema key the handler reads. */
  name: string;
  label: string | null;
  /** HTML input type, or 'select' / 'textarea'. */
  inputType: string;
  required: boolean;
  /** Same 16-value vocabulary the crawler uses, so the two agree downstream. */
  semantic: FormField['semantic'];
  /**
   * Literal `<option>` text, for a `<select>` the markup spells out.
   *
   * The producer has always written this (`SourceFormField.options` in
   * packages/shared/src/codebase.ts) and `parseField` dropped it. That loss cost
   * a whole equivalence class: `not-in-options` posts a value outside the
   * select's set, which a user cannot type and anyone can POST, and it is where
   * authorisation-by-dropdown fails. Absent when the markup builds the options
   * from data rather than writing them out.
   */
  options?: string[];

  /*
   * ─── The six declared constraints ──────────────────────────────────────────
   *
   * THE SAME DEFECT AS `options`, ONE ROUND LATER AND TEN CLASSES WIDE. The
   * inventory above used to say these were absent because `detectForms` read
   * none of them, and that the fix was "a request on packages/shared". The
   * request was GRANTED — `SOURCE_FORM_CONSTRAINTS` in
   * packages/shared/src/codebase.ts now reads `maxlength`, `minlength`, `min`,
   * `max`, `step` and `pattern` off the markup — and this file was never
   * updated, so `parseField` dropped all six on the way in and
   * `negativeExpansionFor` left them absent on the way out. The producer read
   * them, the consumer (`FormFieldSummary` in packages/agent/src/coverage.ts)
   * already had a slot for every one, and the ten classes stayed unreachable
   * anyway because the one link between them threw the values away.
   *
   * ── THE THREE STATES ARE THE WHOLE VALUE AND MUST SURVIVE THE JSON ────────
   *
   * Same convention as `FormField` and as the producer:
   *   • key ABSENT    → NOT_CAPTURED   (nothing looked; the remedy is a crawl)
   *   • key null      → DECLARED_ABSENT (we read the tag; it declares none)
   *   • key a value   → READ
   *
   * So these are carried with a CONDITIONAL SPREAD and never with an explicit
   * `undefined`, which would create the key and turn "nobody looked" into "the
   * page declares nothing" — the false-UNBOUNDED claim the producer's opacity
   * rule exists to prevent, re-introduced one file downstream.
   */
  maxLength?: number | null;
  minLength?: number | null;
  min?: string | null;
  max?: string | null;
  step?: string | null;
  pattern?: string | null;
}

/**
 * Carry one three-stated NUMERIC constraint across the JSON boundary.
 *
 * `raw` is parsed JSON, so every arm has to be decided rather than trusted: a
 * number is READ, an explicit null is DECLARED_ABSENT, and anything else —
 * missing, a string, a NaN the producer could not parse — is NOT_CAPTURED and
 * returns `{}` so the key stays absent. Returning `{ [key]: undefined }` would
 * create the key and lose exactly the distinction this function exists for.
 */
function carryNumeric<K extends 'maxLength' | 'minLength'>(
  raw: Record<string, unknown>,
  key: K,
): { [P in K]?: number | null } {
  const value = raw[key];
  if (value === null) return { [key]: null } as { [P in K]?: number | null };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { [key]: value } as { [P in K]?: number | null };
  }
  return {};
}

/** The string-valued half: `min`, `max`, `step`, `pattern`. See {@link carryNumeric}. */
function carryString<K extends 'min' | 'max' | 'step' | 'pattern'>(
  raw: Record<string, unknown>,
  key: K,
): { [P in K]?: string | null } {
  const value = raw[key];
  if (value === null) return { [key]: null } as { [P in K]?: string | null };
  if (typeof value === 'string' && value !== '') {
    return { [key]: value } as { [P in K]?: string | null };
  }
  return {};
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

/**
 * One exported function, hook or component — the UNIT_GEN denominator.
 *
 * Projected from `SourceComponent` in packages/shared/src/codebase.ts, which is
 * what WRITES these, and deliberately narrower: the catalogue fields
 * (`hasCatalogueEntry`, `catalogueRef`) and the render `states` belong to the
 * component-inventory axis and say nothing about whether a FUNCTION is worth a
 * unit test, so they are not read here rather than read and ignored.
 *
 * ── The ceiling on what this can know, which every sentence below respects ──
 *
 * `propsSummary` is produced by `propsSummaryFor`, which splits a destructured
 * parameter list on `[:=]` and keeps the identifiers. So it carries PARAMETER
 * NAMES and nothing else — no types, no arity for a positional signature, no
 * return shape, no throw. And `model CodebaseSnapshot` says it outright: "the
 * repo-relative paths that were analysed. No file contents."
 *
 * So this inventory can say WHICH function deserves a test and cannot say WHAT
 * it does. A proposal that asserted "priceCart applies the discount before tax"
 * would be inventing the one fact nobody read. The function's own text comes
 * from the materialised checkout, through
 * `apps/worker/src/lib/workspace.ts` — and when there is no checkout, the item
 * is still correct and says which half it is missing.
 */
export interface SourceComponentExport {
  /** Repo-relative module path. Identity, with `exportName`. The evidence. */
  modulePath: string;
  /** The exported name. `default` is legal and common. */
  exportName: string;
  kind: ComponentItemKind;
  /** `props: a, b, c` — parameter NAMES. Null when none were read. */
  propsSummary: string | null;
  /** Navigation, not identity. */
  line: number | null;
  /** The producer's own sentence about why this is an export. */
  evidence: string;
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
   * Exported functions, hooks and components. The UNIT_GEN denominator.
   *
   * It was parsed away. `CodebaseAnalysis` here declared no such field, so
   * `parseCodebaseAnalysis` dropped `analysis.components` on the floor —
   * `analyseCodebase` ALWAYS sets it, and a repository with four hundred
   * exported functions in it arrived at this processor as a list of routes and
   * forms. That is why no producer anywhere emitted a UNIT_GEN item: the input
   * never reached the only pass that could have derived one.
   *
   * Empty is a real answer (a repository of templates exports nothing), and so
   * is "the stored snapshot predates the component reader" — both arrive here
   * as `[]`, and the difference is reported by the skipped entry the producer
   * writes rather than being guessed at.
   */
  components: SourceComponentExport[];
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
/** The producer's own cap on the component inventory (MAX_COMPONENTS in codebase.ts). */
const MAX_COMPONENTS = 5000;

/**
 * The types proposed when the funnel stored no preference.
 *
 * Exactly the three the four derivation rules produce, and no more. A default
 * that quietly included, say, LOAD would put a k6 scenario in front of someone
 * who never asked for one and cannot run it.
 *
 * UNIT_GEN is DERIVABLE and deliberately NOT here, which is that argument one
 * step further in: a unit item needs the repository materialised into the run
 * workspace to execute (`TEST_TYPE_DECLARATIONS.UNIT_GEN.repository` is
 * `MATERIALISED`) and its spec strategy is `hybrid`, so on a deployment with no
 * model it is refused with a reason. Both are honest outcomes for a type
 * somebody ASKED for, and neither is an acceptable surprise for somebody who
 * did not.
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
  UNIT_GEN:
    'one per exported function whose name, module path or parameters put it on a risk facet — money, a permission decision, input validation, date arithmetic or concurrent execution',
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

/*
 * Narrowed against the shared vocabulary rather than a copy of it. The copy
 * that used to live here listed sixteen semantics and the union had grown to
 * nineteen, so a model correctly reporting `url`, `username` or `currency` had
 * it silently coerced to 'unknown' — the field's meaning thrown away by a list
 * nobody remembered to update. A hand-maintained duplicate of a union is a
 * drift bug with a delay fuse.
 */
const SEMANTICS: ReadonlySet<string> = new Set<FormField['semantic']>(FORM_FIELD_SEMANTICS);

function parseField(raw: unknown): SourceFormField | null {
  if (!isRecord(raw)) return null;
  const name = str(raw.name).trim();
  if (name === '') return null;
  const semantic = str(raw.semantic);
  const options = Array.isArray(raw.options)
    ? raw.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '')
    : [];
  return {
    name,
    label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : null,
    inputType: str(raw.inputType, 'text') || 'text',
    required: raw.required === true,
    // An unrecognised hint becomes 'unknown' rather than being trusted: the
    // synthetic-data generator switches on this union and a stray value would
    // fall through its cases silently.
    semantic: SEMANTICS.has(semantic) ? (semantic as FormField['semantic']) : 'unknown',
    // Spread conditionally so "the markup writes no literal options" stays
    // ABSENT rather than becoming an empty array. An empty array is a claim
    // that the select offers nothing, which no real select does.
    ...(options.length > 0 ? { options } : {}),
    // The six declared constraints, each independently three-stated. Order
    // matches SOURCE_FORM_CONSTRAINTS in packages/shared/src/codebase.ts so a
    // seventh is one line in both places rather than a silent omission here.
    ...carryNumeric(raw, 'maxLength'),
    ...carryNumeric(raw, 'minLength'),
    ...carryString(raw, 'min'),
    ...carryString(raw, 'max'),
    ...carryString(raw, 'step'),
    ...carryString(raw, 'pattern'),
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

const COMPONENT_KINDS: ReadonlySet<string> = new Set<ComponentItemKind>(COMPONENT_ITEM_KINDS);

/**
 * One exported function, or null.
 *
 * Dropped rather than defaulted on three fields, for the reason the file header
 * gives: an entry with no module path has no evidence, an entry with no export
 * name cannot be imported by a test, and an entry whose `kind` this build does
 * not know is from a newer producer — guessing UTILITY for it would put an
 * unknown thing into the risk ranking under a label nobody wrote.
 */
function parseComponent(raw: unknown): SourceComponentExport | null {
  if (!isRecord(raw)) return null;
  const modulePath = str(raw.modulePath).trim();
  const exportName = str(raw.exportName).trim();
  const kind = str(raw.kind).trim();
  if (modulePath === '' || exportName === '' || !COMPONENT_KINDS.has(kind)) return null;

  const propsSummary = str(raw.propsSummary).trim();
  const line = typeof raw.line === 'number' && Number.isFinite(raw.line) ? raw.line : null;
  return {
    modulePath,
    exportName,
    kind: kind as ComponentItemKind,
    propsSummary: propsSummary === '' ? null : propsSummary,
    line,
    evidence: str(raw.evidence).trim() || `${modulePath} exports ${exportName}`,
  };
}

/**
 * `(module, exportName)` is the identity, the same pair `SourceBackgroundSurface`
 * joins on, so the same export read twice by two detectors is one subject.
 */
function dedupeComponents(components: SourceComponentExport[]): SourceComponentExport[] {
  const seen = new Set<string>();
  const out: SourceComponentExport[] = [];
  for (const component of components) {
    const key = `${component.modulePath}\u0000${component.exportName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(component);
  }
  return out;
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
  const authSurfaces = dedupeAuthSurfaces(
    arr(raw.authSurfaces, MAX_AUTH_SURFACES)
      .map(parseAuthSurface)
      .filter((a): a is SourceAuthSurface => a !== null),
  )
    // The producer's `AuthSurface` carries no form, so the credential fields
    // are matched in from the list above — see `formForSurface`. Deduping first
    // is deliberate: `formForSurface` keys on the file, so the surface that
    // survives inherits the fields of the reading that was folded into it.
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
    components: dedupeComponents(
      arr(raw.components, MAX_COMPONENTS)
        .map(parseComponent)
        .filter((c): c is SourceComponentExport => c !== null),
    ),
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

/**
 * True when a surface's `path` is nothing but its own file.
 *
 * That is the producer's fallback for a form that declares no `action` — an SPA
 * form almost never does — so the "path" is `src/pages/auth/login.tsx` rather
 * than a URL anyone can navigate to.
 */
function isFileShaped(surface: SourceAuthSurface): boolean {
  return surface.path === normalisePath(surface.file);
}

/**
 * One item per auth surface a tester would actually visit.
 *
 * Two readings collapse here. First, the same kind at the same path is one
 * surface however many files declared it — the rule `dedupeRoutes` already
 * applies one line up. Second, and the reason this exists: a file-shaped
 * surface is the FORM detector's reading of a page the ROUTE detector already
 * reported. `src/pages/auth/login.tsx` yielded LOGIN twice, once as
 * `/auth/login` and once as `/src/pages/auth/login.tsx`, and those became two
 * rows on the approval screen carrying the identical sentence about signing in.
 * The route-shaped reading wins because it is the only one holding a URL the
 * generated test can navigate to.
 *
 * Nothing is lost when a form-shaped surface is folded away: it is folded only
 * into a surface citing the same file, and `formForSurface` matches the fields
 * back on by exactly that file.
 */
function dedupeAuthSurfaces(surfaces: SourceAuthSurface[]): SourceAuthSurface[] {
  const routeShaped = new Set(
    surfaces.filter((s) => !isFileShaped(s)).map((s) => `${s.kind} ${s.file}`),
  );
  const out: SourceAuthSurface[] = [];
  const seen = new Set<string>();
  for (const surface of surfaces) {
    if (isFileShaped(surface) && routeShaped.has(`${surface.kind} ${surface.file}`)) continue;
    const key = `${surface.kind} ${surface.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(surface);
  }
  return out;
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

/**
 * How many "fill this field" steps a form item spells out, and the arithmetic
 * behind the number.
 *
 * `planItemSchema` caps an item at 40 steps and `formItem` ends on
 * `.slice(0, 40)`, which SILENTLY drops whatever does not fit — so adding the
 * boundary table without re-budgeting would have truncated the very rows it
 * exists to add, and the "write this as one parameterised test" instruction
 * with them. The worst case now adds up to 39: one sign-in, one navigation,
 * twenty fills, one line counting the fills not listed, one submit, one locator
 * note, one table preamble, one positive control, eleven boundary cases (the
 * cap in @qaai/agent minus that control) and one parameterisation instruction.
 *
 * If you add a step to this item, redo that sum.
 */
const MAX_FILL_STEPS = 20;

// ─────────────────────────────────────────────────────────────────────────────
// The negative half of a form item
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE DEFECT, SECOND INSTANCE. `formItem` and `authItem` below were a
 * structurally identical copy of the one in packages/agent/src/coverage.ts: a
 * list of "Fill X with a valid value" steps, and then a single negative
 * assertion built from `required[0]` —
 *
 *     `Leaving "${required[0]!.label}" empty is refused, and the error names that field`
 *
 * — so a twelve-field signup form proposed the one negative fact nearly every
 * form already gets right, and fixing only the crawl path would have left this
 * one standing. The register's entry is about the mechanism, not the file.
 *
 * `expandNegativeCases` is the same entry point the crawl path uses, so the two
 * cannot drift: one cap, one ranking, one disclosure format. The only
 * difference is the INPUT, and that difference is the honest part — see the
 * inventory on `SourceFormField` for which ten of the twenty equivalence
 * classes a static read cannot reach, and `negativeDisclosure` below for how
 * that is said to the person approving the item.
 *
 * The seed is the item id, which is derived from the route and the form name
 * and nothing else. So an unchanged repository proposes identical values for
 * ever, which is the promise this file already makes about its handles.
 */
function negativeExpansionFor(
  itemHandle: string,
  form: SourceForm,
): ReturnType<typeof expandNegativeCases> {
  /*
   * A `SourceForm` is projected onto the `FormSummary` the shared expansion
   * reads, and each of the six declared constraints is carried THROUGH in
   * whichever of its three states the producer answered.
   *
   * It used to hard-code every constraint as absent, with a comment arguing
   * that this was the honest answer because a static read never looked. That
   * argument was true and is now FALSE: `detectForms` reads all six off literal
   * markup and answers `undefined` only for a tag it could not parse
   * completely. Hard-coding absence here would report "no maxlength was
   * captured" about a field whose `maxlength="5"` the producer read and handed
   * over — our own gap invented on top of a fact we already had, which is the
   * same lie as the one the old comment was avoiding, pointing the other way.
   *
   * A conditional spread, not `?? null`: the difference between NOT_CAPTURED
   * and DECLARED_ABSENT is what `boundaries.ts` words its reason from, and
   * `?? null` would collapse the first into the second and license the
   * UNBOUNDED classes on a field nobody could read.
   */
  const summary: FormSummary = {
    name: form.name,
    submitLabel: form.submitLabel,
    fields: form.fields.map((field) => ({
      label: field.label ?? field.name,
      required: field.required,
      semantic: field.semantic,
      name: field.name,
      inputType: field.inputType,
      ...(field.options && field.options.length > 0 ? { options: field.options } : {}),
      ...('maxLength' in field ? { maxLength: field.maxLength } : {}),
      ...('minLength' in field ? { minLength: field.minLength } : {}),
      ...('min' in field ? { min: field.min } : {}),
      ...('max' in field ? { max: field.max } : {}),
      ...('step' in field ? { step: field.step } : {}),
      ...('pattern' in field ? { pattern: field.pattern } : {}),
    })),
  };
  return expandNegativeCases(itemHandle, [summary]);
}

/** A boundary case as one step of a plan item. */
function caseStep(testCase: ReturnType<typeof expandNegativeCases>['cases'][number]): string {
  const value = testCase.value;
  const printable =
    value === null
      ? 'every field valid'
      : value === ''
        ? 'the empty string'
        : value.trim() === ''
          ? `${value.length} space(s) and nothing else`
          : value.length > 48
            ? `a ${value.length}-character value beginning ${JSON.stringify(value.slice(0, 16))}`
            : JSON.stringify(value);
  return testCase.field === null
    ? `[${testCase.equivalenceClass}] submit with ${printable} as the positive control — expect it to be ${testCase.expectation}. Without this row, every case below is equally consistent with a form that refuses all input`
    : `[${testCase.equivalenceClass}] set "${testCase.fieldLabel ?? testCase.field}" to ${printable}, leaving every other field valid, and submit — expect it to be ${testCase.expectation}`;
}

/**
 * The sentence that keeps the table honest on THIS path.
 *
 * Two different omissions have to be told apart, and a single "some cases were
 * dropped" line would let the second hide inside the first:
 *
 *   • the cap — this feature has more ranked cases than the item carries, which
 *     is the same trade-off the crawl path makes and is reported the same way;
 *   • the INPUT — ten equivalence classes are unreachable because a static read
 *     captured no `maxlength`, `min`, `max`, `step` or `pattern`. Those classes
 *     are missing for want of a crawl, not because the application declares
 *     nothing, and the next action for them is "point the Explorer at a URL",
 *     not "write the test by hand".
 *
 * Left as an assertion rather than a `skipped` entry because `PlanItem` is what
 * travels to the approval screen, and this is the sentence that stops a reader
 * taking a green parameterised test as proof the form's limits are enforced.
 */
const UNCAPTURED_CLASSES =
  'at/over-max-length, at/under-min-length, at/under-min, at/over-max, step-misaligned and pattern-violating';

function negativeDisclosure(expansion: ReturnType<typeof expandNegativeCases>): string {
  const cap = expansion.dropped
    .filter((d) => d.what.includes('equivalence class(es) with NO case') || d.what.includes('further case(s)'))
    .map((d) => d.what);
  return clamp(
    `NOT COVERED by this test: ${UNCAPTURED_CLASSES} — those ten classes each need a limit, a range, a step or a pattern read off the markup, and reading files captures none of them, so they are absent for want of input rather than because the form declares nothing.${
      cap.length > 0 ? ` Also, inside what could be built: ${cap.join('; ')}.` : ''
    } Do not read a pass here as proof that the field limits are enforced.`,
    400,
  );
}

/**
 * The role a source-derived item will run as, or null.
 *
 * `chooseAuthProfile` is the deterministic chooser from @qaai/agent: four
 * rules, strongest evidence first, and a REFUSAL rather than a guess between
 * unmatched profiles — because a wrong role does not fail loudly, it signs in
 * successfully as the wrong person and asserts whatever that person can see.
 *
 * Rule 1 (the application's own declared `requiresRoles`) can never fire on
 * this path: the analysis records that a route is guarded, never by whom, and
 * `flowMapFromSource` therefore writes `requiresRoles: []` on every node. So
 * what actually decides here is rule 2 (a word the path and a profile name
 * share) and rule 3 (there is only one profile). Rule 4 refuses, which leaves
 * the item unbound and the limitation visible — the same outcome as before this
 * wiring existed, reached on purpose instead of by a hard-coded `null`.
 */
function roleFor(
  behindAuth: boolean,
  path: string | null,
  profiles: readonly AuthProfileChoice[],
): GapAuthProfile | null {
  if (!behindAuth || profiles.length === 0) return null;
  return chooseAuthProfile([...profiles], { route: path, requiresRoles: [] });
}

function smokeItem(route: SourceRoute, profiles: readonly AuthProfileChoice[]): PlanItem {
  const dynamic = isDynamic(route.path);
  const priority: Priority = dynamic
    ? 'NICE_TO_HAVE'
    : route.path === '/'
      ? 'CRITICAL_PATH'
      : 'IMPORTANT';
  /*
   * A guarded route cannot be smoke-tested by a visitor who cannot reach it.
   * This was a hard-coded `null`, so the item said "Sign in" in a step and then
   * ran anonymously — asserting that the page "answers with a successful
   * status" against whatever the login redirect returns.
   */
  const profile = roleFor(route.behindAuth, route.path, profiles);

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
      ...(profile
        ? [
            `Sign in as the "${profile.name}" auth profile — the runner injects its stored session before the first navigation, so do NOT write a login form in the test`,
          ]
        : route.behindAuth
          ? ['Sign in — the source guards this route, and no auth profile was bound to this test']
          : []),
      ...(dynamic
        ? [
            `Obtain a real value for each dynamic segment of ${route.path} — the source names the segment, not any id that exists`,
          ]
        : []),
      `Open ${route.path}`,
    ],
    assertions: [
      profile
        ? `Signed in as "${profile.name}", ${route.path} answers with a successful status rather than a server error or a redirect to a login page`
        : `${route.path} answers with a successful status rather than a server error`,
      `The response is this page's own content, not a generic error or an empty shell — assert something only ${route.path} can produce`,
      /*
       * The signed-out leg needs NO session, so it cannot share a bound
       * profile: the runner injects one before the first navigation. Said as an
       * instruction rather than dropped, because the guarded-routes
       * SECURITY_SMOKE item covers exactly this anonymously and only exists
       * when the user asked for that type.
       */
      ...(route.behindAuth
        ? [
            profile
              ? `With the session removed, ${route.path} refuses or redirects rather than rendering — run that leg without the bound profile, or leave it to the guarded-routes security probe`
              : `Signed out, ${route.path} refuses or redirects rather than rendering`,
          ]
        : []),
    ],
    journeyId: null,
    authProfileId: profile?.id ?? null,
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
    /*
     * NULL ON PURPOSE. Read the step above: a guarded endpoint's item sends the
     * request WITH NO SESSION AND NO CREDENTIALS, because the only expectation
     * static analysis can defend for a write handler is the refusal (see the
     * judgement comment above). Binding an auth profile would have the runner
     * inject a session before the call, the endpoint would answer 200, and the
     * test would fail — or worse, a POST would succeed against real data. The
     * authenticated half of this endpoint needs a request body nobody here
     * knows, so it is not proposed at all rather than proposed with a guess.
     */
    authProfileId: null,
  };
}

function formItem(
  form: SourceForm,
  behindAuth: boolean,
  profiles: readonly AuthProfileChoice[],
): PlanItem {
  /*
   * A form the analysis could not tie to a route used to be proposed on `/`,
   * which is a claim about where it renders and not one the source makes. The
   * item is still worth proposing — the fields are read, the file is the
   * evidence — so the unknown is stated instead, and the tester is told to find
   * the page rather than sent to the wrong one.
   */
  const route = form.route;
  const required = form.fields.filter((f) => f.required);
  const id = itemId('form', `${route ?? form.file}-${form.name}`);
  /*
   * The role, where the evidence supports one. A form on a guarded route needs
   * a session to reach at all, and `authProfileId` is how the runner delivers
   * one — it was a hard-coded `null` here, so every guarded-form item asked a
   * human to "sign in" in prose and then ran as nobody.
   */
  const profile = roleFor(behindAuth, route, profiles);
  const expansion = negativeExpansionFor(id, form);
  const controls = expansion.cases.filter((c) => c.field === null);
  const negativeCases = expansion.cases.filter((c) => c.field !== null);

  return {
    id,
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
        (negativeCases.length > 0
          ? ` Partitioning the fields' input space gives ${expansion.totalCases} case(s); the ${negativeCases.length} highest-ranked, in ${expansion.classes} equivalence class(es), are the input table below.`
          : '') +
        ` ${STATIC_ONLY}`,
      1000,
    ),
    feature: clamp(route ? featureFor(route) : 'Forms', 80),
    priority: 'IMPORTANT',
    testType: 'E2E',
    steps: [
      /*
       * The sign-in step says what the BINDING does, when there is one. The
       * binding on `authProfileId` is what actually delivers the session; this
       * sentence is so the written test does not hand-roll a login form on top
       * of an injected one.
       */
      ...(profile
        ? [
            `Sign in as the "${profile.name}" auth profile — the runner injects its stored session before the first navigation, so do NOT write a login form in the test`,
          ]
        : behindAuth
          ? ['Sign in — the source guards the route this form sits on, and no auth profile was bound to this test']
          : []),
      route
        ? `Navigate to ${route}`
        : `Open the page that renders ${form.file} — the source ties this form to no route`,
      ...form.fields
        .slice(0, MAX_FILL_STEPS)
        .map(
          (f) =>
            `Fill "${f.label ?? f.name}" with a valid ${f.semantic.replace(/_/g, ' ')} value` +
            (f.required ? ' (the source marks it required)' : ''),
        ),
      ...(form.fields.length > MAX_FILL_STEPS
        ? [
            `Fill the remaining ${form.fields.length - MAX_FILL_STEPS} field(s) the source declares on this form with valid values — they are named in the analysis and are not listed individually here`,
          ]
        : []),
      form.submitLabel ? `Submit with "${form.submitLabel}"` : 'Submit the form',
      // The locators come out of source, not out of a rendered page, so the
      // first thing the test proves is that they match anything at all.
      'Locate each field by its label or name as the source declares it — this pass never saw the rendered markup',
      /*
       * The table. One row per equivalence class, one invalid field per row,
       * every other field valid — replacing the single "leave the first
       * required field empty" assertion this item used to end on.
       */
      ...(negativeCases.length > 0
        ? [
            'Then repeat the submission once per row of the table below, changing exactly ONE field each time and leaving the rest valid — a submission with two bad fields fails for a reason nobody can attribute',
            ...controls.map(caseStep),
            ...negativeCases.map(caseStep),
            'Write those rows as ONE parameterised test (parametrize / test.each / TestCase / DataProvider, whichever this project uses), not one test per row and not a loop inside a single test: a loop reports the first bad row and hides the rest',
          ]
        : []),
    ].slice(0, 40),
    assertions: [
      'The submission is accepted and the resulting state reflects what was entered, not merely that a success message appeared',
      ...(negativeCases.length > 0
        ? [
            ...negativeCases
              .slice(0, MAX_BOUNDARY_CASES_PER_GAP)
              .map((c) => `[${c.equivalenceClass}] "${c.fieldLabel ?? c.field}": ${c.expected}`),
            'Every rejection leaves no trace — re-reading afterwards shows the original value, not a partially written record',
            negativeDisclosure(expansion),
          ]
        : [
            required.length > 0
              ? `Leaving "${required[0]!.label ?? required[0]!.name}" empty is refused, and the error names that field`
              : 'Submitting invalid input is refused rather than silently accepted',
          ]),
      ...(behindAuth && !profile
        ? [
            'NOT COVERED by this test: the page behind the guard as a real user. The source guards this route and no auth profile was available to bind, so a pass here is not coverage of what the form does once you are signed in',
          ]
        : []),
    ].slice(0, 20),
    journeyId: null,
    authProfileId: profile?.id ?? null,
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

/** The plan-wide cap on a title, and the width a person reads one in. */
const TITLE_MAX = 160;

/**
 * How much of a title the disambiguating path may take.
 *
 * A title is read in a narrow column on the approval screen, so the sentence
 * has to survive: `Sign in with valid credentials, and fail with invalid ones`
 * is the part that says what the test does, and a path long enough to push it
 * off the end would trade one unreadable title for another.
 */
const LOCATOR_MAX = 40;

/**
 * The shortest honest way to point at one surface.
 *
 * Paths are already short in practice — `/forgot-password`, `/auth/SignUp` —
 * so the whole path is the locator whenever it fits. Only a deeply nested one
 * gets trimmed, and it is trimmed from the FRONT at a segment boundary, because
 * the tail is the half that names the page.
 */
function authLocator(path: string): string {
  /*
   * The extension stays.
   *
   * It used to be shaved off unconditionally, which turned a file-derived
   * surface into `src/pages/auth/SignUp` on the approval screen — a string that
   * is neither a filename nor a URL, and cannot be pasted into either an editor
   * or a browser. A surface found in a file is located BY that file, extension
   * and all; a surface found on a route has no extension to lose.
   *
   * The only thing the strip ever bought was two characters against the length
   * budget, and the trimming below already handles length honestly, from the
   * front, at a segment boundary.
   */
  const trimmed = path;
  if (trimmed.length <= LOCATOR_MAX) return trimmed;

  const segments = trimmed.split('/').filter((s) => s !== '');
  let tail = segments[segments.length - 1] ?? trimmed;
  for (let i = segments.length - 2; i >= 0; i--) {
    const wider = `${segments[i]}/${tail}`;
    if (wider.length + 2 > LOCATOR_MAX) break;
    tail = wider;
  }
  return `…/${clamp(tail, LOCATOR_MAX - 2)}`;
}

/**
 * `AUTH_TITLES` is one sentence per KIND, and a repository has more than one
 * surface per kind.
 *
 * A real run produced four rows all reading "A session outlives a reload, and
 * ends when it should" — the rationales differed, but the title is what a
 * person reads while ticking boxes, and four identical rows is a list nobody
 * can act on. Most of those four were a misclassification and are fixed at
 * source; the collision is not, because a gym app genuinely has a
 * `/forgot-password`, a `/reset-password` and a `/change-password`.
 *
 * So: the sentence stays exactly as written, and where a kind occurs more than
 * once the path is appended — the path is already on the surface and is already
 * what distinguishes them. A kind that occurs once keeps the bare sentence.
 */
function authTitles(surfaces: SourceAuthSurface[]): string[] {
  const perKind = new Map<AuthSurfaceKind, number>();
  for (const surface of surfaces) perKind.set(surface.kind, (perKind.get(surface.kind) ?? 0) + 1);

  const used = new Set<string>();
  const unique = (title: string): string => {
    // Only reachable when two locators collide after trimming, which needs two
    // surfaces of one kind under paths agreeing for their last 38 characters.
    // Ugly, and still better than two rows a person cannot tell apart.
    let candidate = title;
    for (let n = 2; used.has(candidate); n++) candidate = `${title} (${n})`;
    used.add(candidate);
    return candidate;
  };

  return surfaces.map((surface) => {
    const sentence = AUTH_TITLES[surface.kind];
    if ((perKind.get(surface.kind) ?? 0) < 2) return unique(clamp(sentence, TITLE_MAX));
    const locator = authLocator(surface.path);
    // Budget the sentence around the locator rather than the other way round:
    // the locator is the entire reason this branch exists, so it must not be
    // the half the clamp removes.
    return unique(`${clamp(sentence, TITLE_MAX - locator.length - 3)} — ${locator}`);
  });
}

function authItem(surface: SourceAuthSurface, title: string): PlanItem {
  const fields = surface.form?.fields ?? [];
  const id = itemId('auth', `${surface.kind}-${surface.path}`);
  /*
   * The credential form gets the same expansion the ordinary form item gets,
   * and it is the form that most deserves it: "Repeat with a deliberately wrong
   * credential" was the WHOLE negative half of a sign-in test, which proves
   * that one bad password is refused and says nothing about an empty one, a
   * whitespace-only one, an injection-shaped one, or a 10,000-character one.
   *
   * The expectations stay the shared ones. An auth form's rejections are
   * ordinary input rejections; what makes the sign-in case special is the
   * message, and that is already asserted separately below.
   */
  const expansion = surface.form ? negativeExpansionFor(id, surface.form) : null;
  const negativeCases = expansion?.cases.filter((c) => c.field !== null) ?? [];

  return {
    id,
    title: clamp(title, TITLE_MAX),
    rationale: clamp(
      `\`${surface.file}\` declares a ${surface.kind.toLowerCase().replace(/_/g, ' ')} surface at \`${surface.path}\`` +
        (fields.length > 0
          ? ` with ${fields.map((f) => `"${f.label ?? f.name}"`).join(', ')}`
          : ', though the source names no fields on it') +
        '. Authentication is the gate every other guarded test has to pass, so it is proposed at critical path.' +
        (negativeCases.length > 0
          ? ` The ${negativeCases.length} rejection case(s) below are one representative per equivalence class of the credential fields, ranked — "repeat with a wrong credential" on its own proves only that one bad password is refused.`
          : '') +
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
            .slice(0, MAX_FILL_STEPS)
            .map((f) => `Fill "${f.label ?? f.name}" with a valid ${f.semantic.replace(/_/g, ' ')} value`)
        : ['Fill the credential fields the page presents — the source names none, so read them off the page']),
      surface.form?.submitLabel ? `Submit with "${surface.form.submitLabel}"` : 'Submit',
      'Repeat with a deliberately wrong credential',
      ...(negativeCases.length > 0
        ? [
            'Then repeat once per row below, changing exactly ONE credential field each time and leaving the rest valid',
            ...negativeCases.map(caseStep),
            'Write those rows as ONE parameterised test (parametrize / test.each / TestCase / DataProvider, whichever this project uses), not one test per row and not a loop inside a single test',
          ]
        : []),
    ].slice(0, 40),
    assertions: [
      'A valid attempt ends signed in — assert something only a session can reach, not that the form disappeared',
      'A wrong credential is refused, and the message does not reveal which half was wrong',
      ...(expansion
        ? [
            ...negativeCases.map(
              (c) => `[${c.equivalenceClass}] "${c.fieldLabel ?? c.field}": ${c.expected}`,
            ),
            'No rejected attempt leaves a session behind — assert signed-out state after each one, not just that an error appeared',
            negativeDisclosure(expansion),
          ]
        : []),
    ].slice(0, 20),
    journeyId: null,
    /*
     * NULL ON PURPOSE, AND THE ONE PLACE WHERE IT IS THE WHOLE POINT.
     *
     * This item IS the sign-in test. Binding an auth profile makes the runner
     * inject a stored session before the first navigation, so the test would
     * arrive already signed in and "a valid attempt ends signed in" would pass
     * without the credential form being exercised at all — a green test proving
     * nothing about the gate every other guarded test depends on. `roleFor` is
     * deliberately not consulted here.
     */
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
    /*
     * NULL ON PURPOSE. `scanned` filters to `!r.behindAuth`: this item visits
     * only the routes the source says are public, so there is nothing for a
     * session to unlock and no role to assume. Binding a profile would sign the
     * scan in for no reason and change what the public pages render.
     *
     * (Scanning the guarded pages too is a real missing item, and the assertion
     * above says so in the item's own words rather than this binding implying it.)
     */
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
    /*
     * NULL ON PURPOSE, and the most important of the four. The whole assertion
     * is "every guarded path refuses AN ANONYMOUS REQUEST". A bound profile
     * makes the runner inject a session before the first request, every guarded
     * path then answers 200, and the test fails against an application whose
     * auth is working perfectly — or, if the assertion were ever loosened, it
     * passes while proving the opposite of what it claims.
     */
    authProfileId: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIT_GEN: the logic half of the application
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ── WHY THIS SECTION EXISTS ────────────────────────────────────────────────
 *
 * Every producer in this file proposes a test that drives the application from
 * OUTSIDE — a page, a request, a form. None of them can reach the arithmetic.
 * A pricing function that applies the discount after tax, a permission check
 * that reads the role off the wrong object, a renewal date that lands a day
 * early in one timezone: none of those is visible from a route's status code,
 * and all three are the defects that cost money.
 *
 * `TEST_TYPE_DECLARATIONS.UNIT_GEN` in packages/shared/src/test-type-decl.ts
 * records the state this replaces, in its own words: `producers: ['NONE']` —
 * "the type whose emptiness costs the most. Pricing, validation and permission
 * logic — the LOGIC HALF of every application — is unreachable."
 *
 * ── THE LINE THIS SECTION WILL NOT CROSS ───────────────────────────────────
 *
 * The inventory carries a module path, an export name, a kind and a list of
 * PARAMETER NAMES. It does not carry a body, a type, a return shape or a
 * default. So a proposal here may say "this function's name and its module
 * both name money, and money arithmetic is worth a test at its edges"; it may
 * NOT say what the function computes, what it returns, or what it should
 * return. The first is a fact about the repository. The second would be the
 * agent's imagination wearing a rationale's clothes, and on the one subject
 * where a plausible-looking wrong assertion is hardest to spot.
 *
 * The function's own text arrives separately, from the materialised checkout,
 * through apps/worker/src/lib/workspace.ts — fenced as untrusted data, bounded,
 * and with every absence counted. When there is no checkout the item is still
 * correct and SAYS which half it is missing.
 */

/**
 * The five risk facets, which are the five places a unit defect costs
 * something a route test cannot see.
 *
 * Not "complexity", not "lines of code", not "cyclomatic anything". Those rank
 * the functions that are HARD, and the question is which ones are EXPENSIVE
 * WHEN WRONG. A six-line function that rounds a tax figure outranks a
 * two-hundred-line formatter, and no complexity metric says so.
 */
export const UNIT_RISK_FACETS = [
  'MONEY',
  'PERMISSION',
  'VALIDATION',
  'DATE_MATH',
  'CONCURRENCY',
] as const;
export type UnitRiskFacet = (typeof UNIT_RISK_FACETS)[number];

const UNIT_RISK_FACET_PRESENT: Record<UnitRiskFacet, true> = {
  MONEY: true,
  PERMISSION: true,
  VALIDATION: true,
  DATE_MATH: true,
  CONCURRENCY: true,
};

/** Derived, never hand-listed. */
export const UNIT_RISK_FACET_LIST = Object.keys(
  UNIT_RISK_FACET_PRESENT,
) as ReadonlyArray<UnitRiskFacet>;

interface RiskFacetDeclaration {
  readonly label: string;
  /**
   * Weight. MONEY and PERMISSION outrank the rest because their defects are
   * silent: a wrong total is charged and a wrong permission is granted, and
   * neither raises anything. A validation defect usually surfaces as a visible
   * error, which is why it ranks below them and above the other two.
   */
  readonly weight: number;
  /** What a human reads as the reason this function was picked out. */
  readonly why: string;
  /** The assertion a human can approve, which must not claim to know the body. */
  readonly expectation: string;
  /** Four words for a title. */
  readonly titleVerb: string;
  /** Matched against the identifier's WORDS, never as a substring. */
  readonly words: readonly string[];
}

/**
 * The vocabulary, matched word-wise.
 *
 * Word-wise and not by substring, which is the difference between a classifier
 * and a coincidence generator: `'tax'` as a substring hits `syntax`,
 * `taxonomy` and `getTaxonomyLabel`; `'can'` hits `cancel`, `canonical` and
 * `scanDirectory`. `identifierWords` splits camelCase and snake_case first, so
 * `getTaxonomy` yields ['get','taxonomy'] and matches nothing here.
 */
const RISK_FACETS: Record<UnitRiskFacet, RiskFacetDeclaration> = {
  MONEY: {
    label: 'money arithmetic',
    weight: 5,
    why: 'a wrong total is charged, and nothing raises — the customer finds it on the statement',
    expectation:
      'it never returns a negative, a fractional-cent or a NaN amount, and it rounds the same way twice for the same input',
    titleVerb: 'holds its money arithmetic at the edges',
    words: [
      'price', 'pricing', 'amount', 'amounts', 'total', 'totals', 'subtotal', 'tax', 'taxes',
      'vat', 'discount', 'discounts', 'coupon', 'refund', 'refunds', 'fee', 'fees', 'charge',
      'charges', 'invoice', 'invoices', 'currency', 'cents', 'money', 'cost', 'payment',
      'payments', 'billing', 'proration', 'prorate', 'balance', 'payout', 'payouts',
    ],
  },
  PERMISSION: {
    label: 'a permission decision',
    weight: 4,
    why: 'a wrong answer here grants access, and a granted access raises nothing at all',
    expectation:
      'it DENIES by default — an unknown role, a missing subject, a null actor and a mismatched tenant each come back refused, not allowed',
    titleVerb: 'denies rather than defaults open',
    words: [
      'can', 'may', 'allow', 'allowed', 'allows', 'authorize', 'authorise', 'authorized',
      'permission', 'permissions', 'permit', 'role', 'roles', 'scope', 'scopes', 'grant',
      'grants', 'guard', 'access', 'acl', 'policy', 'policies', 'owns', 'owner', 'tenant',
      'admin', 'forbid', 'forbidden', 'authz',
    ],
  },
  VALIDATION: {
    label: 'input validation',
    weight: 3,
    why: 'it is the boundary between data somebody typed and data the rest of the application trusts',
    expectation:
      'it REJECTS what it cannot accept rather than passing it through — and the rejection names the field, so a caller can act on it',
    titleVerb: 'rejects what it cannot accept',
    words: [
      'validate', 'validated', 'validates', 'validation', 'valid', 'invalid', 'sanitize',
      'sanitise', 'sanitizer', 'parse', 'parsed', 'parser', 'assert', 'schema', 'check',
      'checks', 'verify', 'verified', 'normalize', 'normalise', 'coerce', 'guardrail',
    ],
  },
  DATE_MATH: {
    label: 'date arithmetic',
    weight: 2,
    why: 'month ends, leap days and timezone offsets are where date code is wrong, and a route test never sees them',
    expectation:
      'it lands on the same instant across a DST boundary, a leap day and a month end, and is explicit about the timezone it computes in',
    titleVerb: 'survives month ends and DST',
    words: [
      'date', 'dates', 'datetime', 'time', 'times', 'timestamp', 'timezone', 'tz', 'expire',
      'expires', 'expiry', 'expiration', 'duration', 'period', 'periods', 'due', 'overdue',
      'schedule', 'scheduled', 'interval', 'age', 'renew', 'renewal', 'anniversary', 'elapsed',
      'cutoff', 'deadline',
    ],
  },
  CONCURRENCY: {
    label: 'concurrent or repeated execution',
    weight: 2,
    why: 'the second caller, the retry and the duplicate delivery are what break it, and a single-threaded test never produces any of them',
    expectation:
      'running it twice with the same input has the same effect as running it once, and a second concurrent caller does not observe a half-finished state',
    titleVerb: 'is safe to run twice',
    words: [
      'lock', 'locks', 'locking', 'mutex', 'semaphore', 'queue', 'queued', 'retry', 'retries',
      'debounce', 'throttle', 'concurrent', 'concurrency', 'atomic', 'atomically', 'race',
      'idempotent', 'idempotency', 'transaction', 'transactional', 'reentrant', 'dedupe',
      'deduplicate',
    ],
  },
};

/** Built once, so the per-export loop is a set lookup rather than a scan. */
const FACET_BY_WORD: ReadonlyMap<string, UnitRiskFacet> = (() => {
  const map = new Map<string, UnitRiskFacet>();
  for (const facet of UNIT_RISK_FACET_LIST) {
    for (const word of RISK_FACETS[facet].words) {
      // First declaration wins, so a word in two lists is a decision somebody
      // made in the order above rather than whichever loop ran last.
      if (!map.has(word)) map.set(word, facet);
    }
  }
  return map;
})();

/**
 * `getTaxAmount_v2` → ['get','tax','amount','v2'].
 *
 * The whole classifier rests on this. Substring matching on these vocabularies
 * produces nonsense at a rate that would discredit the ranking — see the note
 * on {@link RISK_FACETS}.
 */
export function identifierWords(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word !== '');
}

/** `props: a, b, c` → ['a','b','c']. Empty for null, which is a real answer. */
export function parameterNames(propsSummary: string | null): string[] {
  if (propsSummary === null) return [];
  const body = propsSummary.replace(/^props\s*:\s*/i, '');
  return body
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^[A-Za-z_$][\w$]*$/.test(part));
}

/** One facet found on one export, with the evidence that found it. */
export interface UnitRiskHit {
  readonly facet: UnitRiskFacet;
  /** Where the word was: the export name, the module path, or a parameter. */
  readonly where: 'EXPORT_NAME' | 'MODULE_PATH' | 'PARAMETER';
  /** The word that matched, so a human can disagree with the classification. */
  readonly word: string;
}

/** An export ranked for a unit test, with everything the item needs. */
export interface UnitSubject {
  readonly component: SourceComponentExport;
  readonly hits: readonly UnitRiskHit[];
  /** Sum of the matched facets' weights. Each facet counts ONCE. */
  readonly score: number;
  /** Highest-weighted facet found. The one the item is titled after. */
  readonly leadFacet: UnitRiskFacet;
  readonly parameters: readonly string[];
  /** Repo-relative test files that look like they cover this module. */
  readonly testPaths: readonly string[];
}

/**
 * Classify one export. Null when no facet matched.
 *
 * A facet counts ONCE however many of its words hit, so a function called
 * `applyDiscountToInvoiceTotal` does not outrank `chargeCard` four times over
 * for being wordier. The hits list keeps every match, because it is the
 * evidence a human reads to disagree.
 */
export function riskFacetsFor(component: SourceComponentExport): {
  hits: UnitRiskHit[];
  score: number;
  leadFacet: UnitRiskFacet | null;
} {
  const hits: UnitRiskHit[] = [];
  const add = (where: UnitRiskHit['where'], words: readonly string[]): void => {
    for (const word of words) {
      const facet = FACET_BY_WORD.get(word);
      if (facet) hits.push({ facet, where, word });
    }
  };

  add('EXPORT_NAME', identifierWords(component.exportName));
  /*
   * The path counts, and it is the weaker signal of the three on purpose: a
   * function called `apply` in `src/billing/discounts.ts` is money code and its
   * name says nothing, which is exactly the function a name-only classifier
   * misses. `identifierWords` is applied per SEGMENT so `src/billing` yields
   * ['src','billing'] and a repository that happens to live under
   * `~/tax-return-app` does not label its whole tree.
   */
  for (const segment of component.modulePath.split('/')) {
    add('MODULE_PATH', identifierWords(segment.replace(/\.[^.]+$/, '')));
  }
  const parameters = parameterNames(component.propsSummary);
  for (const parameter of parameters) add('PARAMETER', identifierWords(parameter));

  const found = new Set(hits.map((hit) => hit.facet));
  let score = 0;
  for (const facet of found) score += RISK_FACETS[facet].weight;

  // Ties broken by the declaration order of UNIT_RISK_FACETS, so the lead facet
  // is a function of the vocabulary rather than of iteration order.
  let leadFacet: UnitRiskFacet | null = null;
  for (const facet of UNIT_RISK_FACET_LIST) {
    if (!found.has(facet)) continue;
    if (leadFacet === null || RISK_FACETS[facet].weight > RISK_FACETS[leadFacet].weight) {
      leadFacet = facet;
    }
  }
  return { hits, score, leadFacet };
}

/**
 * How many unit items one analysis proposes.
 *
 * Below MAX_PLAN_ITEMS on purpose: a repository with four hundred exported
 * functions would otherwise fill the whole approval screen with unit tests and
 * push every route and endpoint off it. The ones left out are counted and said.
 */
export const MAX_UNIT_ITEMS = 8;

/**
 * Filename conventions that mean "this file tests that module".
 *
 * A closed, documented list rather than a regex over anything containing
 * `test`: `src/testUtils.ts` is not a test for `src/testUtils.ts`, and
 * `e2e/checkout.spec.ts` is not a unit test for `src/checkout.ts`. Each entry
 * is a suffix swap or a directory the ecosystem actually uses.
 *
 * This is a HEURISTIC over filenames and is reported as one — the inventory has
 * no import graph, so there is no way to know from here whether
 * `pricing.test.ts` imports `pricing.ts` or merely sits beside it.
 */
const TEST_PATH_SHAPES: readonly string[] = [
  '.test', '.spec', '_test', '-test', '.tests',
];

/** `src/a/b.ts` → ['src','a','b','.ts'] split into the parts a swap needs. */
function splitModulePath(modulePath: string): { dir: string; base: string; ext: string } {
  const slash = modulePath.lastIndexOf('/');
  const dir = slash === -1 ? '' : modulePath.slice(0, slash);
  const rest = modulePath.slice(slash + 1);
  const dot = rest.lastIndexOf('.');
  return dot <= 0
    ? { dir, base: rest, ext: '' }
    : { dir, base: rest.slice(0, dot), ext: rest.slice(dot) };
}

/**
 * Test files that look like they cover this module, out of the paths the
 * ANALYSIS recorded.
 *
 * Reads the recorded path list, never the disk: this runs at analysis time,
 * where there is no checkout. An empty result means "none of the conventions
 * below matched a recorded path", which is said rather than reported as "this
 * module has no tests".
 */
export function likelyTestPaths(
  modulePath: string,
  knownPaths: readonly string[],
): string[] {
  if (knownPaths.length === 0) return [];
  const { dir, base, ext } = splitModulePath(modulePath);
  const candidates = new Set<string>();
  const prefix = dir === '' ? '' : `${dir}/`;
  for (const shape of TEST_PATH_SHAPES) {
    // Beside it, and in the two directories the ecosystems put tests in.
    candidates.add(`${prefix}${base}${shape}${ext}`);
    candidates.add(`${prefix}__tests__/${base}${shape}${ext}`);
    candidates.add(`${prefix}tests/${base}${shape}${ext}`);
  }
  // Python's convention is a prefix, not a suffix.
  candidates.add(`${prefix}test_${base}${ext}`);

  const known = new Set(knownPaths);
  return [...candidates].filter((candidate) => known.has(candidate)).sort();
}

/**
 * Rank the inventory. Deterministic, and a pure function of the analysis.
 *
 * Sorted by score DESC, then by module path and export name ASC — never by the
 * order the producer happened to emit them in, so re-analysing an unchanged
 * repository proposes the same eight functions in the same order. No clock, no
 * `Math.random`, nothing ambient.
 *
 * An export with no facet is NOT proposed. That is a judgement and it is the
 * right one at a cap of eight: with four hundred exports to choose from,
 * proposing `formatLabel` ahead of `applyTax` would be worse than proposing
 * nothing. The ones skipped are counted by the caller.
 */
export function rankUnitSubjects(
  analysis: CodebaseAnalysis,
  knownPaths: readonly string[],
): { subjects: UnitSubject[]; unranked: number; onOtherAxis: number } {
  const subjects: UnitSubject[] = [];
  let unranked = 0;
  let onOtherAxis = 0;

  for (const component of analysis.components) {
    /*
     * A PAGE or a LAYOUT is already counted on the ROUTE axis — `smokeItem`
     * proposes a test for the route it serves. Proposing a unit test for it as
     * well puts one surface in two denominators, which is the defect
     * `componentHasOwnAxis` was written to prevent, arriving from two producers
     * that agree rather than from one that is wrong.
     */
    if (componentHasOwnAxis(component.kind) !== null) {
      onOtherAxis += 1;
      continue;
    }

    const { hits, score, leadFacet } = riskFacetsFor(component);
    if (leadFacet === null) {
      unranked += 1;
      continue;
    }
    subjects.push({
      component,
      hits,
      score,
      leadFacet,
      parameters: parameterNames(component.propsSummary),
      testPaths: likelyTestPaths(component.modulePath, knownPaths),
    });
  }

  subjects.sort(
    (a, b) =>
      b.score - a.score ||
      a.component.modulePath.localeCompare(b.component.modulePath) ||
      a.component.exportName.localeCompare(b.component.exportName),
  );
  return { subjects, unranked, onOtherAxis };
}

/**
 * A parameter's semantic, from its NAME, for the boundary expansion.
 *
 * Name-only, because that is all there is — and the item says so. `unknown` is
 * the honest answer for most parameters and it still yields the classes that do
 * not need a type: empty, whitespace-only, over-long, and the injection shapes.
 */
function semanticForParameter(parameter: string): FormFieldSemantic {
  const words = new Set(identifierWords(parameter));
  const has = (...candidates: string[]): boolean => candidates.some((c) => words.has(c));

  if (has('email', 'emails')) return 'email';
  if (has('password', 'passwd', 'secret', 'token')) return 'password';
  if (has('url', 'uri', 'href', 'link', 'endpoint')) return 'url';
  if (has('phone', 'mobile', 'msisdn')) return 'phone';
  if (has('amount', 'price', 'total', 'subtotal', 'cents', 'cost', 'fee', 'balance')) {
    return 'currency';
  }
  if (has('date', 'datetime', 'timestamp', 'expiry', 'due', 'deadline', 'cutoff')) return 'date';
  if (has('count', 'qty', 'quantity', 'limit', 'offset', 'index', 'size', 'age', 'days')) {
    return 'number';
  }
  if (has('name', 'firstname', 'lastname', 'fullname')) return 'person_name';
  return 'unknown';
}

/**
 * A unit test's parameters, projected onto the boundary expansion's form shape.
 *
 * ── `required: false` ON EVERY PARAMETER, AND WHY THAT IS THE HONEST CHOICE ─
 *
 * `propsSummaryFor` splits a destructured parameter list on `[:=]` and keeps
 * the identifier, so `{ qty = 1 }` and `{ qty }` produce the same string. The
 * inventory therefore cannot tell a defaulted parameter from a required one.
 *
 * `required: true` would license the expansion's missing-required-field case,
 * whose expectation is "rejected" — and on a parameter that actually has a
 * default, that case asserts a rejection the function is right not to perform,
 * so the test fails against correct code. `required: false` loses that one case
 * and keeps every case that does not depend on the distinction. The loss is
 * disclosed on the item rather than taken quietly.
 *
 * No constraint is carried AT ALL, for the reason the form path spells out: the
 * difference between NOT_CAPTURED and DECLARED_ABSENT is what `boundaries.ts`
 * words its reason from, and a signature nobody read declares neither.
 */
function unitExpansionFor(subject: UnitSubject, handle: string): ReturnType<typeof expandNegativeCases> {
  const summary: FormSummary = {
    name: `${subject.component.exportName}()`,
    submitLabel: null,
    fields: subject.parameters.slice(0, MAX_FIELDS_PER_FORM).map((parameter) => ({
      label: parameter,
      name: parameter,
      required: false,
      semantic: semanticForParameter(parameter),
      // There is no DOM here. 'text' is the expansion's own neutral value and
      // it is what makes the string classes apply; it is not a claim that the
      // parameter is a string.
      inputType: 'text',
    })),
  };
  return expandNegativeCases(handle, [summary]);
}

/** One ranked function as a proposal a human can approve. */
function unitItem(subject: UnitSubject): PlanItem {
  const { component, leadFacet } = subject;
  const declaration = RISK_FACETS[leadFacet];
  const handle = itemId('unit', `${component.modulePath}:${component.exportName}`);
  const expansion = unitExpansionFor(subject, handle);

  /*
   * The evidence, in the shape every other producer in this file writes it: the
   * file, the fact read out of it, and the WORD that caused the classification.
   * Naming the word is what lets a reviewer say "no, `charge` there means an
   * electric charge" and be right, instead of arguing with a score.
   */
  const facetsFound = [...new Set(subject.hits.map((hit) => hit.facet))];
  const evidenceWords = facetsFound
    .map((facet) => {
      const hit = subject.hits.find((h) => h.facet === facet)!;
      return `${RISK_FACETS[facet].label} (the word "${hit.word}" in its ${
        hit.where === 'EXPORT_NAME'
          ? 'name'
          : hit.where === 'MODULE_PATH'
            ? 'module path'
            : 'parameter list'
      })`;
    })
    .join('; ');

  const cases = expansion.cases.slice(0, MAX_BOUNDARY_CASES_PER_GAP);

  return {
    id: handle,
    title: clamp(`${component.exportName} ${declaration.titleVerb}`, TITLE_MAX),
    rationale: clamp(
      `\`${component.modulePath}\` exports \`${component.exportName}\`${
        component.line === null ? '' : ` (line ${component.line})`
      }, classified ${component.kind}. It names ${evidenceWords} — and ${declaration.why}. ` +
        `No route test can reach this: a wrong answer inside the function is invisible from the ` +
        `outside, which is what makes it worth its own test. ` +
        (subject.testPaths.length > 0
          ? `${subject.testPaths.length} file(s) in the repository look like tests for this module (${subject.testPaths.join(', ')}) — this proposal should extend them rather than restate them. `
          : 'No file matching a test-naming convention was found beside this module in the recorded paths. ') +
        `${STATIC_ONLY} In particular the function's BODY, its parameter TYPES and its RETURN ` +
        `shape were not read: ${UNIT_SIGNATURE_UNREAD}`,
      1000,
    ),
    feature: clamp(unitFeatureFor(component.modulePath), 80),
    // MONEY and PERMISSION only. A validation or date helper is worth a test and
    // is not a critical path, and marking all five critical would make the word
    // mean nothing on this plan.
    priority: declaration.weight >= 4 ? 'CRITICAL_PATH' : 'IMPORTANT',
    testType: 'UNIT_GEN',
    steps: [
      `Import \`${component.exportName}\` from \`${component.modulePath}\` — ${
        component.exportName === 'default'
          ? 'it is the default export'
          : 'it is a named export'
      }`,
      ...(subject.parameters.length > 0
        ? [
            `Call it with its declared parameters (${subject.parameters.join(', ')}) — the names are from the source, the TYPES are not, so read the signature before writing the call`,
          ]
        : [
            'Read the signature in the source to find out what it takes — the inventory recorded no parameter names for it',
          ]),
      ...cases.map(caseStep),
    ],
    assertions: [
      `\`${component.exportName}\` ${declaration.expectation}`,
      ...(subject.testPaths.length > 0
        ? [
            `Nothing here duplicates an assertion already made in ${subject.testPaths.join(' or ')}`,
          ]
        : []),
      unitDisclosure(expansion, subject),
    ],
    journeyId: null,
    /*
     * NULL ON PURPOSE, and for a different reason from the other four. A unit
     * test calls a function in a process; there is no browser, no session and
     * nobody to be. Binding a profile would have the runner resolve a
     * storageState and sign somebody in before invoking a pure function — work
     * with no subject, and a sign-in failure reported as a defect in the
     * arithmetic.
     */
    authProfileId: null,
  };
}

/**
 * The one sentence that stops a green unit test being read as proof the
 * signature is honoured.
 */
const UNIT_SIGNATURE_UNREAD =
  'the inventory records parameter NAMES only, so whether a parameter is optional, what type ' +
  'it takes and what the function returns are all unread here. Every case below is a shape ' +
  'question, not a type claim.';

/** `src/billing/invoice.ts` → 'Billing'. Groups the suite tree the way routes do. */
function unitFeatureFor(modulePath: string): string {
  const parts = modulePath.split('/').filter((part) => part !== '');
  // The directory above the file, skipping the conventional roots that group
  // nothing: `src/pricing.ts` is Pricing, not Src.
  const skip = new Set(['src', 'lib', 'app', 'packages', 'apps', 'source', 'internal']);
  const named = [...parts.slice(0, -1)].reverse().find((part) => !skip.has(part.toLowerCase()));
  const base = named ?? splitModulePath(modulePath).base;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * What this item does NOT cover, said on the item.
 *
 * Three separate omissions, told apart because they have three different next
 * actions — collapsing them into "some cases were not generated" is what lets
 * the worst one hide inside the mildest:
 *
 *   • the SIGNATURE was never read, so no case can depend on a type or on a
 *     parameter being optional. Next action: read the source.
 *   • the function has no recorded parameters at all, so there is nothing to
 *     vary. Next action: read the source.
 *   • the cap bit inside what COULD be built. Next action: approve this and
 *     propose the rest.
 */
function unitDisclosure(
  expansion: ReturnType<typeof expandNegativeCases>,
  subject: UnitSubject,
): string {
  /*
   * THE ORDER IS LOAD-BEARING, AND THE FIRST DRAFT GOT IT WRONG.
   *
   * This string is clamped to 400 characters, and the clamp BIT: the sentence
   * ended with "Do not read a pass here as proof the function's contract is
   * enforced", the `dropped` list from the expansion ran to several hundred
   * characters ahead of it, and the one sentence the whole disclosure exists
   * for was the part that got cut. A cap that silently removes the warning and
   * leaves the detail is worse than no disclosure, because what survives reads
   * complete. This module's own test caught it ("says outright that the BODY,
   * the TYPES and the RETURN were not read").
   *
   * So the non-negotiable sentence goes FIRST and the per-case detail LAST, and
   * the clamp can only ever eat the detail. Anything added here goes after the
   * first sentence, never before it.
   */
  const cap = expansion.dropped.map((d) => d.what);
  return clamp(
    `Do not read a pass here as proof the function's contract is enforced. ` +
      `NOT COVERED: ${
        subject.parameters.length === 0
          ? 'any input variation at all — the inventory recorded no parameter names for this export, so there is nothing to vary and the cases above are limited to calling it'
          : "anything that depends on a parameter's TYPE or on whether it is optional"
      }. ${UNIT_SIGNATURE_UNREAD}${
        cap.length > 0 ? ` Also, inside what could be built: ${cap.join('; ')}.` : ''
      }`,
    400,
  );
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
  totals: {
    routes: number;
    endpoints: number;
    forms: number;
    authSurfaces: number;
    /** Exported functions in the inventory, before the risk ranking trimmed them. */
    components: number;
  };
  /**
   * THE SEAM BETWEEN THIS PASS AND THE FUNCTION'S OWN SOURCE.
   *
   * A UNIT_GEN item is a proposal about a function, and the generator needs the
   * function — not a page's locators, which is what `relevantContext(flowMap,
   * item)` hands it today. `PlanItem` has no field for a module path and an
   * export name, and inventing one would mean a schema change this file does
   * not own, so the pairing travels beside the items instead.
   *
   * ONLY the items that survived the cap appear here. A subject for a deferred
   * item would have the generator fetch source for a proposal nobody approved.
   */
  unitSubjects: Array<{ itemId: string; subject: UnitSubject }>;
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
  /*
   * The roles this environment can sign in as, or none.
   *
   * Optional, and the default is the honest input for a project that has
   * configured no profile — which is also every existing caller, so nothing
   * that does not pass them changes behaviour. What a guarded item does with
   * them (and which items refuse to touch them at all) is on `roleFor` and on
   * the `authProfileId` of each producer.
   */
  authProfiles: readonly AuthProfileChoice[] = [],
  /**
   * Every repo-relative path the ingest recorded, or none.
   *
   * LAST, and with a default, so the three-argument call every existing caller
   * makes keeps its meaning — `authProfiles` is positional and inserting this
   * before it would silently pass a path list where the roles go.
   *
   * `CodebaseSnapshot.paths` is a SIBLING column to `analysis`, so it is not in
   * the blob the first argument parses. It is here for one job: deciding whether
   * a module already has a test beside it. An empty list means NOBODY LOOKED —
   * `likelyTestPaths` finds nothing and the item says "no file matching a
   * convention was found in the recorded paths", which is a different sentence
   * from "this module has no tests" and has to stay different.
   */
  knownPaths: readonly string[] = [],
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
    components: analysis.components.length,
  };

  /*
   * Item ids whose subject sits behind a guard, so a test for it NEEDS a role.
   *
   * Collected as the items are built rather than sniffed out of their prose
   * afterwards. The four producers that are anonymous by design never appear
   * here, which is what lets "this item wanted a role and has none" be reported
   * without also nagging about the security probe, whose whole assertion is
   * that an anonymous request is refused.
   */
  const needsRole = new Set<string>();

  if (wants('SMOKE')) {
    for (const route of analysis.routes) {
      const item = smokeItem(route, authProfiles);
      items.push(item);
      if (route.behindAuth) needsRole.add(item.id);
    }
  }
  if (wants('API')) items.push(...analysis.endpoints.map(apiItem));
  if (wants('E2E')) {
    // Titled as a set, not one at a time: whether a title needs the path on it
    // is a fact about the other auth surfaces, not about this one.
    const titles = authTitles(analysis.authSurfaces);
    items.push(...analysis.authSurfaces.map((surface, i) => authItem(surface, titles[i]!)));
    for (const { form, behindAuth } of forms) {
      const item = formItem(form, behindAuth, authProfiles);
      items.push(item);
      if (behindAuth) needsRole.add(item.id);
    }
  }
  if (wants('ACCESSIBILITY') && analysis.routes.length > 0) {
    items.push(accessibilityItem(analysis.routes));
  }

  /*
   * ── UNIT_GEN ──────────────────────────────────────────────────────────────
   *
   * The one producer here whose subject is not a URL. Every cap and every
   * exclusion it applies is reported as a count AND a reason, because the whole
   * point of a denominator is that trimming it quietly makes the number go up.
   */
  const unitSubjects: Array<{ itemId: string; subject: UnitSubject }> = [];
  if (wants('UNIT_GEN')) {
    const ranked = rankUnitSubjects(analysis, knownPaths);
    const taken = ranked.subjects.slice(0, MAX_UNIT_ITEMS);
    for (const subject of taken) {
      const item = unitItem(subject);
      items.push(item);
      unitSubjects.push({ itemId: item.id, subject });
    }

    if (analysis.components.length === 0) {
      skipped.push({
        what: TEST_TYPE_LABELS.UNIT_GEN,
        why: 'the stored analysis carries no component inventory, so there is no exported function to rank. Either the repository exports none, or the snapshot was written before the component reader existed — re-import the source to tell those two apart.',
      });
    }
    if (ranked.onOtherAxis > 0) {
      skipped.push({
        what: `${ranked.onOtherAxis} page and layout export(s)`,
        why: 'they are route entry points, and the route they serve is already proposed as its own test. Counting them here as well would put one surface in two denominators.',
      });
    }
    if (ranked.unranked > 0) {
      skipped.push({
        what: `${ranked.unranked} other exported function(s)`,
        why: `none of them names money, a permission decision, input validation, date arithmetic or concurrent execution, so none was ranked. They are not covered and they are not proposed — at a cap of ${MAX_UNIT_ITEMS} a formatter ahead of a tax calculation would be worse than nothing. Ask for one by hand if a name is misleading.`,
      });
    }
    if (ranked.subjects.length > taken.length) {
      skipped.push({
        what: `${ranked.subjects.length - taken.length} further ranked function(s)`,
        why: `only the top ${MAX_UNIT_ITEMS} by risk are proposed per analysis, so unit items cannot crowd every route and endpoint off the approval screen. Approve these and re-analyse for the next ones.`,
      });
    }
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

  /*
   * Said once, on the plan, and only when it BITES — never as a standing nag.
   *
   * An item whose subject is behind a guard and which carries no role produces
   * a test that runs anonymously, and a test that runs anonymously against a
   * guarded page passes while covering the redirect. That is a ceiling on the
   * project's coverage that no amount of test writing can lift, so it is a fact
   * about the setup rather than about any one item — and it is stated beside
   * the items it limits instead of being left as a silent `null`.
   */
  const unbound = chosen.filter((item) => needsRole.has(item.id) && item.authProfileId === null);
  if (unbound.length > 0) {
    skipped.push({
      what: `Running ${unbound.length} item(s) as a real user`,
      why:
        authProfiles.length === 0
          ? 'the source guards the route(s) they cover and this environment has no auth profile configured, so nothing generated for them can sign in. They are proposed anyway and can only assert that a signed-out visitor is refused — add a profile under Setup → Environments and analyse again to bind one.'
          : `the source guards the route(s) they cover and none of the ${authProfiles.length} configured auth profile(s) could be matched to them. A static read records that a route is guarded, never by whom, so there is no declared role to match a profile name against — name the profile on the item before generating, or the test will cover the wall rather than the page.`,
    });
  }

  for (const warning of analysis.warnings) {
    skipped.push({
      what: 'Part of the repository the analysis could not read',
      why: warning,
    });
  }

  /*
   * Only the subjects whose item SURVIVED the plan-wide cap. A subject whose
   * item was deferred would have the generator fetch a module's source for a
   * proposal nobody can approve — a download, a fence and a fingerprint for a
   * row that is not on the screen.
   */
  const kept = new Set(chosen.map((item) => item.id));
  return {
    items: chosen,
    skipped,
    totals,
    unitSubjects: unitSubjects.filter((pair) => kept.has(pair.itemId)),
  };
}

/** The prose above the approval list. Says what was read, and what was not. */
export function summaryFromSource(derived: DerivedPlan, analysis: CodebaseAnalysis): string {
  const { totals } = derived;
  const frameworks = analysis.frameworks.length > 0 ? ` (${analysis.frameworks.join(', ')})` : '';
  const count = derived.items.length;
  return (
    `${count} test${count === 1 ? '' : 's'} proposed from your codebase${frameworks} — ` +
    `${totals.routes} route(s), ${totals.endpoints} endpoint(s), ${totals.forms} form(s), ` +
    `${totals.authSurfaces} auth surface(s) and ${totals.components} exported function(s) ` +
    `read out of the source. ` +
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
  /**
   * Every repo-relative path the ingest recorded, or null when none was read.
   *
   * A SEPARATE loader rather than a wider `loadAnalysis`, because `paths` is a
   * sibling COLUMN to `analysis` on `CodebaseSnapshot` and the two answer
   * different questions: `analysis` is what the detectors concluded, `paths` is
   * the raw file list they concluded it from. The only thing read here needs
   * the second for is deciding whether a module already has a test beside it.
   *
   * NULL and `[]` are different and the difference is on the plan: null means
   * the path list was not read, `[]` means it was read and is empty.
   */
  loadAnalysedPaths?: (orgId: string, projectId: string) => Promise<string[] | null>;
  /**
   * THE FUNCTION'S OWN SOURCE, when a checkout of the repository is available.
   *
   * Undefined by every production caller today, and that is the honest state
   * rather than an oversight: this processor runs on an UPLOAD, before any run
   * has materialised anything, and `CodebaseSnapshot` stores paths with no
   * contents by design. So the deterministic path produces its UNIT_GEN items
   * from the inventory alone, and {@link readSourceUnderTest} reports
   * NO_WORKSPACE for each of them — which is what the plan then SAYS, instead
   * of leaving a reader to assume the function was read.
   *
   * WHAT IT WOULD TAKE to fill it is one call: `materialiseRepoWorkspace`
   * (apps/worker/src/repo-materialise.ts) already does the hard part — GitHub
   * App token, tarball at a ref, capped extraction into a per-run temp dir,
   * `cleanup()` for the `finally` — so a caller passes
   * `nodeWorkspaceFileReader(workspace.root)` here and holds the workspace for
   * the whole analysis rather than per item. It costs one download, which is
   * why it is a decision and not an accident.
   */
  openWorkspace?: () => Promise<WorkspaceFileReader | null>;
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

  /*
   * The Generator generates against a FlowMap, and a FlowMap row is scoped to an
   * environment. A project that arrived as a repository may not have one yet —
   * that is a real and expected state, not an error — so the plan is written
   * either way and the missing half is stated on it. Approving an item here
   * still records the human's decision; only the generation waits.
   *
   * READ BEFORE THE PLAN IS DERIVED, not after, which is why this moved up: the
   * auth profiles hang off the environment, and an item for a guarded route has
   * to NAME the role its test will run as. Deriving first and reading the roles
   * afterwards is how `authProfileId` came to be a hard-coded `null` on every
   * producer in this file.
   */
  const environment = await prisma.environment.findFirst({
    where: { orgId, projectId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, baseUrl: true },
  });

  /*
   * Id, name and kind only — the same three columns explore.ts reads for the
   * same purpose. Choosing which role a test assumes needs neither the stored
   * config nor the live session, and both of those would travel into plan text
   * that people read.
   */
  const authProfiles: AuthProfileChoice[] = environment
    ? (
        await prisma.authProfile.findMany({
          where: { orgId, environmentId: environment.id },
          orderBy: { createdAt: 'asc' },
          select: { id: true, name: true, kind: true },
        })
      ).map((profile) => ({ id: profile.id, name: profile.name, kind: profile.kind }))
    : [];

  /*
   * The recorded path list, for the one question it answers: does this module
   * already have a test beside it. NULL is kept apart from `[]` all the way
   * onto the plan — see the skipped entry below.
   */
  const analysedPaths = await (deps.loadAnalysedPaths ?? defaultLoadAnalysedPaths)(
    orgId,
    projectId,
  );

  const derived = scenariosFromSource(analysis, choice, authProfiles, analysedPaths ?? []);
  if (derived.items.length === 0) {
    throw new Error(
      `Nothing could be proposed for project ${projectId}: ${
        derived.skipped.map((s) => `${s.what} — ${s.why}`).join(' ') || 'no reason recorded'
      }`,
    );
  }

  // `scenariosFromSource` already records which guarded items ended up unbound,
  // because that is a judgement about the plan and belongs in the pure function.
  const skipped = [...derived.skipped];

  /*
   * ── THE UNIT ITEMS' SOURCE CONTEXT ────────────────────────────────────────
   *
   * A UNIT_GEN proposal names a function; the generator needs the function. The
   * read happens HERE rather than inside `scenariosFromSource` because that
   * function is pure — no database, no clock, no I/O — and its judgement is
   * testable over a fixture precisely because of that.
   *
   * Said once, when it BITES, and never as a standing nag: the sentence below
   * only reaches the plan when there ARE unit items, and it names the count.
   * A reader of a unit proposal has to know whether the function was read,
   * because "this function's name says money" and "I have read this function"
   * licence completely different assertions, and only one of them is what a
   * static pass has.
   */
  if (derived.unitSubjects.length > 0) {
    const reader = deps.openWorkspace ? await deps.openWorkspace() : null;
    const contexts: SourceUnderTestContext[] = [];
    for (const { subject } of derived.unitSubjects) {
      contexts.push(
        await readSourceUnderTest({
          reader,
          subject: {
            modulePath: subject.component.modulePath,
            exportName: subject.component.exportName,
            testPaths: subject.testPaths,
            /*
             * EMPTY, ALWAYS, AND NOT BECAUSE NOTHING CALLS THESE FUNCTIONS.
             * There is no import graph here — the file header says so about
             * journeys for the same reason — so which modules call this one is
             * a fact nobody has recorded. An inferred caller list would be the
             * plausible-looking invention this file exists not to make.
             */
            callerPaths: [],
          },
        }),
      );
    }

    const unread = contexts.filter((context) => context.module === null).length;
    if (unread > 0) {
      skipped.push({
        what: `Reading the source of ${unread} proposed function(s)`,
        why:
          contexts.every((context) =>
            context.omissions.some((omission) => omission.reason === 'NO_WORKSPACE'),
          )
            ? 'no checkout of your repository was available while this plan was written, so these proposals are derived from the inventory — the module, the export and its parameter NAMES — and not from the function body. Their assertions are about shape, never about what the function computes. A run materialises the repository and the generator reads the function then.'
            : `their module could not be read out of the checkout: ${contexts
                .flatMap((context) => context.omissions)
                .filter((omission) => omission.reason !== 'NO_WORKSPACE')
                .slice(0, 4)
                .map((omission) => `${omission.what} — ${omission.why}`)
                .join(' ')}`,
      });
    }

    /*
     * The fingerprint is logged and not stored, because there is no column for
     * it: `TestPlan` carries items, a summary and skips. Logged rather than
     * dropped so a support question about "which version of pricing.ts did this
     * proposal come from" has an answer in the run log, and NEVER substituted
     * with a hash of nothing when no source was read — see `fingerprint: null`.
     */
    logger.info(
      {
        projectId,
        unitItems: derived.unitSubjects.length,
        unreadModules: unread,
        fingerprints: contexts.map((context, index) => ({
          itemId: derived.unitSubjects[index]?.itemId ?? null,
          fingerprint: context.fingerprint,
        })),
      },
      'analyze-source: unit subjects prepared',
    );
  }

  if (analysedPaths === null && derived.unitSubjects.length > 0) {
    skipped.push({
      what: 'Checking whether these functions already have tests',
      why: 'the ingest recorded no file list for this project, so no existing test file could be matched to a module. Every unit proposal above may duplicate a test you already have — read it before approving.',
    });
  }

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

/**
 * The newest ingest's recorded file list, or null.
 *
 * Same row as `defaultLoadAnalysis` and a second query on purpose: the two are
 * separate deps (see {@link AnalyzeSourceDeps}), so a test can seed an analysis
 * with no path list and prove that the plan SAYS the existing-test check was
 * not made. Merging them would make that state unreachable.
 *
 * Returns null — never `[]` — for a snapshot whose `paths` is not a readable
 * array of strings. `[]` would read as "the ingest looked and the repository
 * has no files", which is not a thing that happens.
 */
async function defaultLoadAnalysedPaths(
  orgId: string,
  projectId: string,
): Promise<string[] | null> {
  const snapshot = await prisma.codebaseSnapshot.findFirst({
    where: { projectId, orgId },
    orderBy: { createdAt: 'desc' },
    select: { paths: true },
  });
  if (!Array.isArray(snapshot?.paths)) return null;
  const paths = snapshot.paths
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry !== '');
  return paths.length > 0 ? paths : null;
}

async function defaultLoadProjectRow(
  orgId: string,
  projectId: string,
): Promise<Record<string, unknown> | null> {
  const row = await prisma.project.findFirst({ where: { id: projectId, orgId } });
  return (row) ?? null;
}
