/**
 * Application source analysis — "what does this app expose?" (§7)
 *
 * `detect.ts` answers a different question and answers it well: *how do you run
 * this repo's tests*. It reads manifests, lockfiles and runner configs, and its
 * entire vocabulary of verdicts is a runner and an invocation. Ask it what the
 * application does and it has nothing to say — it never reads a route, a
 * handler, a form or a field, because that was never its job.
 *
 * This file is that second question. Given the same `RepoFile[]`, it reports
 * what the *application* declares: the pages it renders, the endpoints it
 * serves, the forms a user can fill in, and the surfaces that look like
 * authentication. Those four are what a test plan is written against, and every
 * one of them is stated somewhere in the source in a form a machine can read.
 *
 * Four rules, and each exists because the failure mode here is a plausible
 * fiction — an endpoint list that reads beautifully and does not match the
 * running app:
 *
 *  1. **Static means static.** Nothing here knows what the app *does*. A route
 *     that is registered behind a feature flag, a handler mounted under a prefix
 *     computed at boot, a form rendered only for admins — all invisible. That is
 *     what the crawl is for, and this module's output says so in its own notes
 *     rather than letting a caller assume otherwise.
 *  2. **Say which detectors ran.** "No endpoints found" is three different
 *     answers: nothing looked, something looked and found none, or something
 *     wanted file contents it was never given. A caller cannot tell those apart
 *     from an empty array, so every detector reports its own coverage —
 *     `filesExamined`, `found`, and `blocked` — whether or not it contributed.
 *  3. **Facts carry their source.** Every route, endpoint and form names the
 *     file it came from and the observation that produced it. A user overruling
 *     us needs to see the line, not the conclusion — the same contract the
 *     evidence tiers in detect.ts hold to.
 *  4. **Never resolve what cannot be resolved.** Express mount prefixes, React
 *     Router's nested relative paths, Django's `include()` — all need an import
 *     graph or a running process, and there is neither. Those are recorded as
 *     declared and flagged in `notes`, never silently joined into a path that
 *     would be wrong.
 *
 * Pure, like detect.ts: a function of a file listing, no filesystem, no network,
 * no model. `content` stays optional for the same reason it is optional there —
 * a git tree is cheap and file bodies are not — which means a caller can send
 * paths for the whole repo and bodies only for what matters, and get the
 * file-convention half of the answer for free.
 *
 * The form vocabulary is *borrowed, not redeclared*: `FieldSemantic` is
 * `FormField['semantic']` from flow-map.ts, so a field this file infers from a
 * `<form>` element and a field the Explorer observed in a live DOM are the same
 * kind of thing to everything downstream. A second copy of that union is exactly
 * the drift detect.ts's header warns about.
 */

import type { FormField } from './flow-map';
import type { RepoFile } from './detect';

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * The data-generation vocabulary is the Explorer's. A field read out of source
 * and a field observed in a live DOM describe the same thing, so they are typed
 * by the same union rather than by two that will drift.
 */
export type FieldSemantic = FormField['semantic'];

export const HTTP_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Every detector, named. This list is the honesty surface: a caller can compare
 * it against `analysis.detectors` and see that all of them ran, which is not
 * something an empty results array can tell you.
 */
export const SOURCE_DETECTORS = [
  'next-app-router',
  'pages-directory',
  'sveltekit',
  'react-router',
  'vue-router',
  'express-fastify',
  'django-urls',
  'rails-routes',
  'spring-mvc',
  'flask-fastapi',
  'html-forms',
  'auth-surfaces',
] as const;
export type SourceDetectorId = (typeof SOURCE_DETECTORS)[number];

/** What each detector is, and what it looks for — so "found nothing" is readable. */
const DETECTOR_META: Record<SourceDetectorId, { label: string; looksFor: string }> = {
  'next-app-router': {
    label: 'Next.js App Router',
    looksFor: 'app/**/page.* and app/**/route.* files, whose directory path is the URL',
  },
  'pages-directory': {
    label: 'pages/ directory (Next.js Pages Router, Nuxt 2, Astro)',
    looksFor: 'pages/**/*.{tsx,jsx,vue,astro} files, whose path is the URL, and pages/api/**',
  },
  sveltekit: {
    label: 'SvelteKit',
    looksFor: 'src/routes/**/+page.svelte and +server.* files',
  },
  'react-router': {
    label: 'React Router',
    looksFor: '<Route path="…"> elements and route objects in files importing react-router',
  },
  'vue-router': {
    label: 'Vue Router',
    looksFor: "{ path: '…', component: … } route objects in files importing vue-router",
  },
  'express-fastify': {
    label: 'Express / Fastify / Koa-style routers',
    looksFor: "app.get('/…'), router.post('/…') calls on a value built by a server factory",
  },
  'django-urls': {
    label: 'Django URLconf',
    looksFor: "path(), re_path() and url() entries in urls.py",
  },
  'rails-routes': {
    label: 'Rails routes',
    looksFor: 'config/routes.rb — verb declarations, root, resources, and namespace nesting',
  },
  'spring-mvc': {
    label: 'Spring MVC',
    looksFor: '@RequestMapping / @GetMapping / @PostMapping … annotations in .java and .kt',
  },
  'flask-fastapi': {
    label: 'Flask / FastAPI',
    looksFor: "@app.route(...) and @app.get('/…') / @router.post('/…') decorators",
  },
  'html-forms': {
    label: 'Forms in markup',
    looksFor: '<form> elements in HTML, JSX/TSX, Vue, Svelte, Astro, ERB and Blade templates',
  },
  'auth-surfaces': {
    label: 'Authentication surfaces',
    looksFor:
      'login / signup / logout / password / SSO shaped routes and endpoints, and forms with a password field',
  },
};

// ─── Results ─────────────────────────────────────────────────────────────────

export interface PageRoute {
  /** Normalised, with dynamic segments as `:param`: `/orders/:id`. */
  route: string;
  detector: SourceDetectorId;
  /** Repo-relative file the route was read from. */
  file: string;
  /** The observation, as a fact: "app/orders/[id]/page.tsx — directory path is the URL". */
  evidence: string;
  /** True when the route has at least one parameter segment. */
  dynamic: boolean;
}

export interface HttpEndpoint {
  /**
   * 'UNKNOWN' is a real answer, not a placeholder: a Next `route.ts` we were
   * given no content for is definitely an endpoint and its verbs are definitely
   * unreadable. Saying GET would be a guess dressed as a fact.
   */
  method: HttpMethod | 'UNKNOWN';
  path: string;
  detector: SourceDetectorId;
  file: string;
  evidence: string;
  dynamic: boolean;
}

export interface SourceFormField {
  name: string;
  label: string | null;
  /** HTML input type, or 'select' / 'textarea'. */
  inputType: string;
  required: boolean;
  semantic: FieldSemantic;
  /** Present for select elements whose options are literal in the markup. */
  options?: string[];
}

export interface SourceForm {
  /** Deterministic: file path plus the form's index within it. Stable across runs. */
  id: string;
  /** The form's own name/id attribute, or a name derived from the file. */
  name: string;
  /** The literal `action` attribute, when there is one. Often absent in SPAs. */
  action: string | null;
  /** The literal `method` attribute, uppercased. Null when unstated (HTML defaults to GET). */
  method: string | null;
  file: string;
  fields: SourceFormField[];
  /** Text of the submit control, when it is literal in the markup. */
  submitLabel: string | null;
}

export const AUTH_SURFACE_KINDS = [
  'LOGIN',
  'SIGNUP',
  'LOGOUT',
  'PASSWORD_RESET',
  'VERIFY',
  'SSO',
  'SESSION',
] as const;
export type AuthSurfaceKind = (typeof AUTH_SURFACE_KINDS)[number];

export interface AuthSurface {
  kind: AuthSurfaceKind;
  /** The route or endpoint path this surface sits at. */
  path: string;
  /** Where the claim came from: a route, an endpoint, or a form with a password field. */
  from: 'route' | 'endpoint' | 'form';
  file: string;
  evidence: string;
}

/**
 * One detector's own account of itself.
 *
 * Read it as a four-way answer to "did you look?":
 *   filesExamined === 0            nothing in the repo was its kind of file
 *   filesExamined > 0, found === 0 it read them and they declared nothing
 *   blocked !== null               it found its files and could not turn them
 *                                  into facts. Two ways that happens: the
 *                                  bodies were never uploaded, or the files do
 *                                  not mean what their layout suggests — a
 *                                  `pages/` tree in an app whose routes are
 *                                  declared in code is a folder of components,
 *                                  not a routing table.
 */
export interface DetectorReport {
  id: SourceDetectorId;
  label: string;
  looksFor: string;
  filesExamined: number;
  found: number;
  blocked: string | null;
}

/** An application framework observed in the source, as opposed to a test runner. */
export interface AppFrameworkSignal {
  framework: string;
  evidence: string;
  file: string | null;
}

export interface CodebaseAnalysis {
  routes: PageRoute[];
  endpoints: HttpEndpoint[];
  forms: SourceForm[];
  authSurfaces: AuthSurface[];
  /** Application frameworks the source names. Never a test runner — that is detect.ts. */
  frameworks: AppFrameworkSignal[];
  /** Every detector, run or not. The empty-array-is-ambiguous fix. */
  detectors: DetectorReport[];
  /** What was looked at, and what was not. */
  coverage: {
    filesGiven: number;
    filesAnalysed: number;
    /** Files whose `content` was provided; the rest contributed only their path. */
    filesWithContent: number;
    /** Vendored/generated paths skipped before analysis. */
    filesIgnored: number;
    /** Files whose content was longer than the per-file scan cap and was truncated. */
    filesTruncated: number;
    /** True when a result list hit its cap and the real repo has more. */
    truncated: boolean;
  };
  /** Sentences a user can act on: what was resolved, what was left declared-as-written. */
  notes: string[];
  /** Gaps in the input. A missing file body is a gap, not a finding. */
  warnings: string[];
}

// ─── Caps ────────────────────────────────────────────────────────────────────

/**
 * Bounds, all of them. A repo is attacker-controlled input the moment a browser
 * can POST one, and every loop below is over something a caller chose the size
 * of. These are the same species of guard as impact.ts's MAX_CODE_CHARS, and
 * hitting one is reported in `coverage.truncated` rather than silently dropping
 * the tail.
 */
const MAX_FILES_ANALYSED = 5000;
/** Matches impact.ts's per-blob cap: past this a file is minified or generated. */
const MAX_FILE_CHARS = 400_000;
const MAX_ROUTES = 2000;
const MAX_ENDPOINTS = 2000;
const MAX_FORMS = 500;
const MAX_FIELDS_PER_FORM = 60;
/** Forms are scanned with a bounded window so one huge template cannot dominate. */
const MAX_FORMS_PER_FILE = 20;

// ─── Paths ───────────────────────────────────────────────────────────────────

/** Vendored and generated trees describe someone else's project. Same list as detect.ts. */
const IGNORED_SEGMENT =
  /^(node_modules|vendor|\.git|\.venv|venv|dist|build|out|target|bin|obj|coverage|\.next|\.nuxt|\.svelte-kit|__pycache__|site-packages|Pods|\.gradle|\.idea|\.tox|storybook-static)$/;

/**
 * Test code is not application code. A `cypress/e2e/login.cy.ts` declares no
 * route the app serves, and letting it through would put the *test suite's*
 * fixtures into the list of things the app exposes — which is the exact
 * confusion this file exists to end.
 */
const TEST_PATH =
  /(^|\/)(tests?|e2e|cypress|playwright|__tests__|__specs__|spec|features)\/|\.(spec|test|cy|e2e)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go|rb)$|_spec\.rb$/;

function normalisePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
}

function isIgnoredPath(path: string): boolean {
  return path.split('/').some((seg) => IGNORED_SEGMENT.test(seg));
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

/** Collapse a declared URL into the one shape everything downstream compares. */
function normaliseRoute(raw: string): string {
  let out = raw.trim();
  // A declared path may carry a query or fragment; neither is part of the route.
  out = out.split('?')[0]!.split('#')[0]!;
  if (!out.startsWith('/')) out = `/${out}`;
  out = out.replace(/\/{2,}/g, '/');
  if (out.length > 1) out = out.replace(/\/+$/, '');
  return out || '/';
}

const isDynamic = (route: string): boolean => /:|\*/.test(route);

// ─── Collector ───────────────────────────────────────────────────────────────

/**
 * Accumulator with the caps and the dedupe built in, so no detector has to
 * remember either. Deduping matters more than it looks: `app/orders/page.tsx`
 * and a `<Route path="/orders">` in the same repo are two observations of one
 * route, and listing it twice would inflate every count a user reads.
 */
class Collector {
  readonly routes: PageRoute[] = [];
  readonly endpoints: HttpEndpoint[] = [];
  readonly forms: SourceForm[] = [];
  truncated = false;

  private readonly routeKeys = new Set<string>();
  private readonly endpointKeys = new Set<string>();

  addRoute(route: PageRoute): boolean {
    const key = `${route.route}`;
    if (this.routeKeys.has(key)) return false;
    if (this.routes.length >= MAX_ROUTES) {
      this.truncated = true;
      return false;
    }
    this.routeKeys.add(key);
    this.routes.push(route);
    return true;
  }

  addEndpoint(endpoint: HttpEndpoint): boolean {
    const key = `${endpoint.method} ${endpoint.path}`;
    if (this.endpointKeys.has(key)) return false;
    if (this.endpoints.length >= MAX_ENDPOINTS) {
      this.truncated = true;
      return false;
    }
    this.endpointKeys.add(key);
    this.endpoints.push(endpoint);
    return true;
  }

  addForm(form: SourceForm): boolean {
    if (this.forms.length >= MAX_FORMS) {
      this.truncated = true;
      return false;
    }
    this.forms.push(form);
    return true;
  }
}

interface AnalysedFile {
  path: string;
  /** Undefined when the caller sent a listing entry with no body. */
  content: string | undefined;
  ext: string;
}

/** Per-detector bookkeeping, so the report is produced by the work rather than asserted. */
class Ledger {
  private readonly examined = new Map<SourceDetectorId, number>();
  private readonly found = new Map<SourceDetectorId, number>();
  private readonly blocked = new Map<SourceDetectorId, number>();
  private readonly refusals = new Map<SourceDetectorId, string>();

  examine(id: SourceDetectorId, n = 1): void {
    this.examined.set(id, (this.examined.get(id) ?? 0) + n);
  }

  hit(id: SourceDetectorId, n = 1): void {
    this.found.set(id, (this.found.get(id) ?? 0) + n);
  }

  /** A candidate file this detector needed the body of and did not get. */
  starve(id: SourceDetectorId): void {
    this.blocked.set(id, (this.blocked.get(id) ?? 0) + 1);
  }

  /**
   * This detector found its files, read them, and deliberately claimed nothing.
   * Distinct from `starve`, and the distinction is the point: nothing is missing
   * from the upload, the files simply do not mean what the detector would
   * otherwise take them to mean. Saying so is a finding; an empty list is not.
   */
  refuse(id: SourceDetectorId, reason: string): void {
    this.refusals.set(id, reason);
  }

  /**
   * The refusal itself, for the summary a user reads.
   *
   * Separate from `report()` because a refusal is a finding on its own terms: in
   * a monorepo one package can refuse while another yields routes, so waiting
   * for the detector's total to be zero would hide the sentence exactly where
   * the mixed answer makes it most worth reading.
   */
  refusalFor(id: SourceDetectorId): string | null {
    return this.refusals.get(id) ?? null;
  }

  report(): DetectorReport[] {
    return SOURCE_DETECTORS.map((id) => {
      const starved = this.blocked.get(id) ?? 0;
      const refusal = this.refusals.get(id) ?? null;
      return {
        id,
        label: DETECTOR_META[id].label,
        looksFor: DETECTOR_META[id].looksFor,
        filesExamined: this.examined.get(id) ?? 0,
        found: this.found.get(id) ?? 0,
        blocked:
          refusal ??
          (starved > 0
            ? `${starved} matching file${starved === 1 ? '' : 's'} had no content in the upload, so ${starved === 1 ? 'it' : 'they'} could not be read`
            : null),
      };
    });
  }
}

// ─── Is the filesystem this app's routing table? ─────────────────────────────

/**
 * The single most expensive mistake this file can make.
 *
 * In Next.js, Nuxt and Astro the filesystem *is* the router: `pages/orders.tsx`
 * is reachable at `/orders` because the framework says so, and reading the route
 * off the path is exact. In React Router, TanStack Router and Vue Router it is
 * not: routes are declared in code, and `src/pages/` is a folder people name by
 * convention and fill however they like. A React Router repo's
 * `src/pages/admin/analytics/ChurnTab.tsx` is a tab component rendered inside
 * one analytics page — there is no `/admin/analytics/ChurnTab` to visit, and a
 * generated test that tries will 404 on a URL the application never had.
 *
 * So before any path is read as a URL, the upload is asked which kind of app
 * this is. The answer has three states and only one of them is a refusal, so
 * this cannot quietly turn into "find nothing, ever":
 *
 *   confirmed    a file-convention framework is named outright — its config
 *                file, or its package on the manifest. Read paths as URLs, and
 *                say which framework makes that true.
 *   contradicted no such framework is named AND a code-declared router is.
 *                The `pages/` tree is a naming convention here. Claim nothing,
 *                and say why in the detector's own report.
 *   unknown      neither is named — typically a paths-only upload with no
 *                manifest body. The layout convention is all there is, so it is
 *                still read, and `notes` says the claim rests on it.
 *
 * And the answer is asked PER PACKAGE, not per upload. What a customer uploads
 * is a monorepo: `apps/web` is Next.js, `apps/admin` is React Router, and both
 * have a `pages/` tree. A verdict taken once over every file in the upload would
 * find `next` somewhere and unlock "the path is the URL" for `pages/**` in every
 * workspace beside it — which is the original defect, scoped down but not gone.
 * So signals are filed under the directory of the `package.json` that owns them,
 * and a file is judged by its NEAREST such ancestor: `apps/admin/src/pages/Foo`
 * answers to `apps/admin/package.json`, never to `apps/web`'s three directories
 * away. Falling back, in order, to the root manifest and then to whatever the
 * upload named anywhere — because a file under no manifest at all is still
 * better served by the repository's one answer than by none.
 */
interface RouterSignal {
  name: string;
  evidence: string;
  /**
   * The detector that DOES read this router's table, when there is one. Named so
   * a refusal can point the reader at a report that exists: the refusal used to
   * end "see the React Router detector", and no id in `SOURCE_DETECTORS` is
   * called that, so it pointed at nothing. Undefined for routers this pass
   * cannot read at all, and the refusal then says that instead of implying a
   * detector picked the work up.
   */
  detector?: SourceDetectorId;
}

interface RoutingVerdict {
  /** Frameworks whose router is the filesystem, each with the trees it owns. */
  fileConvention: Array<RouterSignal & { trees: string[] }>;
  /** Routers whose table is a literal in the source. */
  codeDeclared: RouterSignal[];
}

/** Package names that mean "the filesystem is the router", by the tree they own. */
const FILE_CONVENTION_DEPS: Array<{ dep: RegExp; name: string; trees: string[] }> = [
  { dep: /^next$/, name: 'Next.js', trees: ['app', 'pages'] },
  { dep: /^nuxt(3|-edge)?$/, name: 'Nuxt', trees: ['pages'] },
  { dep: /^astro$/, name: 'Astro', trees: ['pages'] },
  { dep: /^@sveltejs\/kit$/, name: 'SvelteKit', trees: [] },
  { dep: /^@remix-run\/(react|dev|node|serve)$/, name: 'Remix', trees: ['app'] },
];

/**
 * Package names that mean "the route table is written in code, not in the tree".
 *
 * `detector` is the id of the pass that reads that table, where one exists. Only
 * two of these six are read today, and the refusal sentence has to be able to
 * tell the reader which case they are in — "its table was read instead" is a
 * promise, and it is false for the four with no detector.
 */
const CODE_DECLARED_DEPS: Array<{ dep: RegExp; name: string; detector?: SourceDetectorId }> = [
  { dep: /^react-router(-dom|-native)?$/, name: 'React Router', detector: 'react-router' },
  { dep: /^vue-router$/, name: 'Vue Router', detector: 'vue-router' },
  { dep: /^@tanstack\/(react-)?router$/, name: 'TanStack Router' },
  { dep: /^@angular\/router$/, name: 'Angular Router' },
  { dep: /^wouter$/, name: 'Wouter' },
  { dep: /^@reach\/router$/, name: 'Reach Router' },
];

/** Config files that name a file-convention framework without needing a manifest body. */
const FILE_CONVENTION_CONFIG: Array<{ file: RegExp; name: string; trees: string[] }> = [
  { file: /^next\.config\.[cm]?[jt]s$/, name: 'Next.js', trees: ['app', 'pages'] },
  { file: /^nuxt\.config\.[cm]?[jt]s$/, name: 'Nuxt', trees: ['pages'] },
  { file: /^astro\.config\.[cm]?[jt]s$/, name: 'Astro', trees: ['pages'] },
];

/** The directory part of a repo-relative path; '' for a file at the root. */
function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/**
 * What a file-convention detector is allowed to claim about ONE file, and the
 * sentence it owes the user either way.
 */
interface TreeGate {
  claim: boolean;
  /** Names the framework that makes "the path is the URL" true, when one is named. */
  because: string | null;
  /** Why nothing was claimed, for the detector report. Null when it claimed. */
  refusal: string | null;
}

/**
 * The verdict, resolved per file rather than per upload.
 *
 * `gateFor(path, tree)` is the whole interface: hand it the file about to be
 * read as a URL and it answers for the package that file belongs to.
 */
interface RoutingGates {
  gateFor(path: string, tree: 'app' | 'pages'): TreeGate;
}

function routingVerdict(files: AnalysedFile[]): RoutingGates {
  // Pass one: every directory holding a manifest. A workspace is a package.json
  // and the subtree under it, and that subtree is the unit the routing question
  // has a single answer for. The repo root is always a bucket, so a file under
  // no manifest at all still has somewhere to fall back to.
  const owners = new Set<string>(['']);
  for (const file of files) {
    if (basename(file.path) === 'package.json') owners.add(dirname(file.path));
  }

  const ownerCache = new Map<string, string>();
  /** The nearest ancestor directory that owns a manifest. '' when none does. */
  const ownerOf = (path: string): string => {
    let dir = dirname(path);
    const cached = ownerCache.get(dir);
    if (cached !== undefined) return cached;
    const start = dir;
    for (;;) {
      if (owners.has(dir)) break;
      if (dir === '') break;
      dir = dirname(dir);
    }
    ownerCache.set(start, dir);
    return dir;
  };

  const byOwner = new Map<string, RoutingVerdict>();
  // Deduped per owner, not globally: two workspaces both depending on Next each
  // deserve their own signal, because each will be quoted in its own evidence.
  const seen = new Set<string>();
  const verdictFor = (owner: string): RoutingVerdict => {
    let verdict = byOwner.get(owner);
    if (!verdict) {
      verdict = { fileConvention: [], codeDeclared: [] };
      byOwner.set(owner, verdict);
    }
    return verdict;
  };

  const addFileConvention = (
    owner: string,
    name: string,
    evidence: string,
    trees: string[],
  ): void => {
    const key = `${owner}\u0000fs:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    verdictFor(owner).fileConvention.push({ name, evidence, trees });
  };

  const addCodeDeclared = (
    owner: string,
    name: string,
    evidence: string,
    detector: SourceDetectorId | undefined,
  ): void => {
    const key = `${owner}\u0000code:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    verdictFor(owner).codeDeclared.push({ name, evidence, detector });
  };

  for (const file of files) {
    const base = basename(file.path);

    for (const entry of FILE_CONVENTION_CONFIG) {
      if (!entry.file.test(base)) continue;
      addFileConvention(ownerOf(file.path), entry.name, `found ${file.path}`, entry.trees);
    }

    // Next's own specials are proof of Next even with no manifest in the upload:
    // nothing but the Pages Router looks for a file called `pages/_app.tsx`.
    if (/(?:^|\/)(?:src\/)?pages\/_(app|document)\.[cm]?[jt]sx?$/.test(file.path)) {
      addFileConvention(
        ownerOf(file.path),
        'Next.js',
        `found ${file.path}, which only the Pages Router looks for`,
        ['app', 'pages'],
      );
    }

    if (base !== 'package.json' || file.content === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.content);
    } catch {
      continue; // An unparseable manifest is reported by the caller, not here.
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const pkg = parsed as Record<string, unknown>;
    // A manifest speaks for its own directory, never for a sibling workspace.
    const owner = dirname(file.path);
    for (const section of ['dependencies', 'devDependencies']) {
      const deps = pkg[section];
      if (!deps || typeof deps !== 'object') continue;
      for (const name of Object.keys(deps)) {
        const lower = name.toLowerCase();
        const fs = FILE_CONVENTION_DEPS.find((entry) => entry.dep.test(lower));
        if (fs) {
          addFileConvention(owner, fs.name, `${name} in ${section} (${file.path})`, fs.trees);
        }
        const code = CODE_DECLARED_DEPS.find((entry) => entry.dep.test(lower));
        if (code) {
          addCodeDeclared(owner, code.name, `${name} in ${section} (${file.path})`, code.detector);
        }
      }
    }
  }

  /**
   * No opinion. Reached when neither the file's own workspace nor any ancestor
   * named a router, and it means UNKNOWN — which the gate reads as "claim", the
   * permissive answer a paths-only upload needs.
   */
  const silent: RoutingVerdict = { fileConvention: [], codeDeclared: [] };

  const answers = (verdict: RoutingVerdict): boolean =>
    verdict.fileConvention.length > 0 || verdict.codeDeclared.length > 0;

  /**
   * The nearest ancestor manifest with an opinion, then the root's, then none.
   *
   * There is deliberately NO union-of-the-whole-upload at the end of this
   * chain. That fallback existed and it quietly reintroduced the defect this
   * scoping was built to remove: a workspace whose own manifest named no router
   * inherited every SIBLING's, so `apps/legacy` was judged by whatever
   * `apps/console` happened to depend on. A sibling is not an ancestor and does
   * not speak for you — two workspaces in one repo are exactly the case where
   * "somewhere in this upload" is the wrong question.
   *
   * Ancestors still speak, because they genuinely do: a root manifest declaring
   * Next for the whole repo is a fact about every directory under it.
   */
  const resolve = (path: string): { verdict: RoutingVerdict; owner: string } => {
    let dir = ownerOf(path);
    for (;;) {
      const verdict = byOwner.get(dir);
      if (verdict && answers(verdict)) return { verdict, owner: dir };
      if (dir === '') break;
      // `ownerOf` starts from the DIRNAME of what it is given, so this always
      // moves strictly up and the walk terminates at the root.
      dir = ownerOf(dir);
    }
    const root = byOwner.get('');
    if (root && answers(root)) return { verdict: root, owner: '' };
    return { verdict: silent, owner: ownerOf(path) };
  };

  const gateCache = new Map<string, TreeGate>();
  return {
    gateFor(path: string, tree: 'app' | 'pages'): TreeGate {
      const key = `${ownerOf(path)}\u0000${tree}`;
      const cached = gateCache.get(key);
      if (cached) return cached;
      const { verdict, owner } = resolve(path);
      const gate = gateForVerdict(verdict, owner, tree);
      gateCache.set(key, gate);
      return gate;
    },
  };
}

function gateForVerdict(verdict: RoutingVerdict, owner: string, tree: string): TreeGate {
  // A framework's answer is scoped to the trees it owns: Remix owns `app/` and
  // says nothing whatever about `pages/`, so filtering here rather than at build
  // time is what keeps one framework from answering for another's directory.
  const fs = verdict.fileConvention.filter((f) => f.trees.includes(tree));
  const code = verdict.codeDeclared;
  if (fs.length > 0) {
    return { claim: true, because: `${fs[0]!.name} (${fs[0]!.evidence})`, refusal: null };
  }
  if (code.length > 0) {
    // Prefer a router this pass can actually read, so the refusal can point at a
    // report the reader can go and look at. Falls back to the first named.
    const router = code.find((entry) => entry.detector !== undefined) ?? code[0]!;
    // Whose routes these are. Naming the repository when it is one workspace of
    // eight is the same over-claim in prose that the verdict itself just stopped
    // making in code.
    const whose = owner === '' ? 'this repo declares' : `${owner} declares`;
    // Not `${owner}/${tree}/`: the tree may sit under a `src/` the owner path
    // does not mention, and a literal directory that does not exist would be one
    // more evidence string a reader cannot check.
    const where = owner === '' ? `a file under ${tree}/` : `a file in ${owner}'s ${tree}/ tree`;
    return {
      claim: false,
      because: null,
      refusal:
        `${whose} its routes in code — ${router.name}, ${router.evidence} — and names no ` +
        `framework that routes by filename, so ${where} is a component, not a URL. ` +
        (router.detector
          ? `Its route table was read from the source instead; see the ${router.detector} detector`
          : `This pass has no detector for ${router.name}, so its route table was not read either`),
    };
  }
  return { claim: true, because: null, refusal: null };
}

/**
 * One sentence per distinct refusal.
 *
 * A monorepo answers differently per package, so a detector can refuse in
 * `apps/admin` and claim in `apps/web` on the same run. Folding those into one
 * global sentence would name one workspace's router as if it were the whole
 * repository's — which is the same lie, in prose, that the per-package verdict
 * exists to stop telling.
 */
function refusalSummary(counts: Map<string, number>, lead: (n: number) => string): string | null {
  if (counts.size === 0) return null;
  return [...counts.entries()].map(([reason, n]) => `${lead(n)}, but ${reason}`).join('; ');
}

// ─── File-convention routing ─────────────────────────────────────────────────

/** Extensions that can be a page in a file-convention router. */
const PAGE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx)$/;
/** Extensions that can be a server handler. */
const SERVER_EXT = /\.[cm]?[jt]s$/;

/**
 * Next.js App Router segment → URL segment. Returns null for segments that
 * organise the tree without contributing to the URL, which is the whole reason
 * a route cannot be read off a path with a naive join.
 */
function appSegment(segment: string): string | null {
  if (/^\(.*\)$/.test(segment)) return null; // route group
  if (segment.startsWith('@')) return null; // parallel-route slot
  if (segment.startsWith('_')) return null; // private folder
  return dynamicSegment(segment);
}

/** `[id]` → `:id`, `[...slug]` → `:slug*`, `[[...slug]]` → `:slug*`. */
function dynamicSegment(segment: string): string {
  const optionalCatchAll = /^\[\[\.\.\.(.+)\]\]$/.exec(segment);
  if (optionalCatchAll) return `:${optionalCatchAll[1]}*`;
  const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment);
  if (catchAll) return `:${catchAll[1]}*`;
  const param = /^\[(.+)\]$/.exec(segment);
  if (param) return `:${param[1]}`;
  return segment;
}

function joinSegments(segments: Array<string | null>): string {
  return normaliseRoute(`/${segments.filter((s): s is string => Boolean(s)).join('/')}`);
}

/**
 * HTTP verbs a JS/TS server module exports, e.g. Next's `export async function
 * GET` or SvelteKit's `export const POST`. Absence is meaningful and reported as
 * UNKNOWN rather than defaulted.
 */
function exportedHttpMethods(content: string): HttpMethod[] {
  const found = new Set<HttpMethod>();
  const re =
    /export\s+(?:async\s+)?(?:function|const|let|var)\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/g;
  for (const m of content.matchAll(re)) found.add(m[1] as HttpMethod);
  // `export { GET, POST }` — a re-export list is just as declarative.
  for (const m of content.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const name of (m[1] ?? '').split(',')) {
      const clean = name.split(/\s+as\s+/)[0]!.trim();
      if ((HTTP_METHODS as readonly string[]).includes(clean)) found.add(clean as HttpMethod);
    }
  }
  return [...found];
}

/** Methods a Pages-Router handler branches on: `req.method === 'POST'`, `case 'PUT':`. */
function branchedHttpMethods(content: string): HttpMethod[] {
  const found = new Set<HttpMethod>();
  for (const m of content.matchAll(
    /\.method\s*===?\s*['"`](GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)['"`]/gi,
  )) {
    found.add(m[1]!.toUpperCase() as HttpMethod);
  }
  for (const m of content.matchAll(
    /case\s+['"`](GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)['"`]\s*:/gi,
  )) {
    found.add(m[1]!.toUpperCase() as HttpMethod);
  }
  return [...found];
}

/**
 * Rails also calls its source directory `app/`, and it contains a great many
 * files. `app/javascript/controllers/page.js` would otherwise be read as an App
 * Router page serving `/javascript/controllers` — a route that does not exist,
 * in a framework the repo does not use. These are the subdirectories Rails owns.
 */
const RAILS_APP_SUBDIRS = new Set([
  'models',
  'controllers',
  'views',
  'helpers',
  'jobs',
  'mailers',
  'assets',
  'javascript',
  'channels',
  'services',
  'serializers',
  'policies',
]);

function detectNextAppRouter(
  files: AnalysedFile[],
  out: Collector,
  ledger: Ledger,
  gates: RoutingGates,
): void {
  // Keyed by the refusal sentence, because in a monorepo there is one sentence
  // per package and the report has to carry all of them.
  const refusals = new Map<string, number>();
  for (const file of files) {
    const match = /(?:^|\/)(?:src\/)?app\/(.+)$/.exec(file.path);
    if (!match) continue;
    const parts = match[1]!.split('/');
    if (parts.length > 1 && RAILS_APP_SUBDIRS.has(parts[0]!)) continue;
    const leaf = parts.pop()!;
    if (!PAGE_EXT.test(leaf)) continue;
    const stem = leaf.replace(PAGE_EXT, '');
    // Only leaves own a route. A layout wraps a subtree and is navigable at no
    // URL of its own, so listing it would invent a page that does not exist.
    if (stem !== 'page' && stem !== 'route') continue;

    ledger.examine('next-app-router');
    const gate = gates.gateFor(file.path, 'app');
    if (!gate.claim) {
      if (gate.refusal) refusals.set(gate.refusal, (refusals.get(gate.refusal) ?? 0) + 1);
      continue;
    }
    const route = joinSegments(parts.map(appSegment));

    if (stem === 'page') {
      if (
        out.addRoute({
          route,
          detector: 'next-app-router',
          file: file.path,
          evidence: gate.because
            ? `${file.path} is an App Router page in a ${gate.because} app; its directory path is the URL`
            : `${file.path} is an App Router page; its directory path is the URL`,
          dynamic: isDynamic(route),
        })
      ) {
        ledger.hit('next-app-router');
      }
      continue;
    }

    if (!SERVER_EXT.test(leaf)) continue;
    if (file.content === undefined) {
      ledger.starve('next-app-router');
      if (
        out.addEndpoint({
          method: 'UNKNOWN',
          path: route,
          detector: 'next-app-router',
          file: file.path,
          evidence: `${file.path} is an App Router route handler, but no file content was uploaded, so its exported verbs are unknown`,
          dynamic: isDynamic(route),
        })
      ) {
        ledger.hit('next-app-router');
      }
      continue;
    }

    const methods = exportedHttpMethods(file.content);
    const emit: Array<HttpMethod | 'UNKNOWN'> = methods.length > 0 ? methods : ['UNKNOWN'];
    for (const method of emit) {
      if (
        out.addEndpoint({
          method,
          path: route,
          detector: 'next-app-router',
          file: file.path,
          evidence:
            method === 'UNKNOWN'
              ? `${file.path} is an App Router route handler that exports no recognisable HTTP verb`
              : `${file.path} exports ${method}`,
          dynamic: isDynamic(route),
        })
      ) {
        ledger.hit('next-app-router');
      }
    }
  }

  const summary = refusalSummary(
    refusals,
    (n) =>
      `${n} file${n === 1 ? '' : 's'} under app/ ${n === 1 ? 'is' : 'are'} named the ` +
      `way an App Router page is`,
  );
  if (summary) ledger.refuse('next-app-router', summary);
}

/**
 * Files a `pages/` directory contains that are not pages. Next's specials are
 * the trap here: `pages/_app.tsx` is framework plumbing, while Nuxt 2's
 * `pages/_id.vue` is a genuine dynamic route — the same leading underscore
 * meaning opposite things in two frameworks that share the directory name.
 */
const NEXT_PAGES_SPECIALS = new Set(['_app', '_document', '_error', 'middleware']);

function pagesSegment(segment: string, vueStyle: boolean): string | null {
  if (/^\[.*\]$/.test(segment)) return dynamicSegment(segment);
  // Nuxt 2 spells a parameter with a leading underscore, but only in .vue trees.
  if (vueStyle && segment.startsWith('_') && segment.length > 1) return `:${segment.slice(1)}`;
  if (segment.startsWith('_')) return null;
  return segment;
}

function detectPagesDirectory(
  files: AnalysedFile[],
  out: Collector,
  ledger: Ledger,
  gates: RoutingGates,
): void {
  const refusals = new Map<string, number>();
  for (const file of files) {
    const match = /(?:^|\/)(?:src\/)?pages\/(.+)$/.exec(file.path);
    if (!match) continue;
    // An `app/…/pages/…` file belongs to the App Router detector, which reads the
    // whole path as the URL. Letting both claim it would produce two routes for
    // one file, and one of them would be wrong.
    if (/(?:^|\/)(?:src\/)?app\//.test(file.path)) continue;
    const rest = match[1]!;
    if (!PAGE_EXT.test(rest)) continue;

    const parts = rest.replace(PAGE_EXT, '').split('/');
    const leaf = parts[parts.length - 1]!;
    if (NEXT_PAGES_SPECIALS.has(leaf)) continue;

    ledger.examine('pages-directory');
    const gate = gates.gateFor(file.path, 'pages');
    if (!gate.claim) {
      if (gate.refusal) refusals.set(gate.refusal, (refusals.get(gate.refusal) ?? 0) + 1);
      continue;
    }
    const vueStyle = file.ext === '.vue';
    if (leaf === 'index') parts.pop();
    const segments = parts.map((s) => pagesSegment(s, vueStyle));
    const route = joinSegments(segments);

    // `pages/api/**` is Next's server half and serves no page at all.
    const isApi = /(?:^|\/)api(?:\/|$)/.test(`/${rest}`) && parts[0] === 'api';
    if (!isApi) {
      if (
        out.addRoute({
          route,
          detector: 'pages-directory',
          file: file.path,
          evidence: gate.because
            ? `${file.path} is a ${gate.because} page; its path under pages/ is the URL`
            : `${file.path} sits in a pages/ directory; its path is the URL`,
          dynamic: isDynamic(route),
        })
      ) {
        ledger.hit('pages-directory');
      }
      continue;
    }

    if (file.content === undefined) {
      ledger.starve('pages-directory');
    }
    const methods = file.content ? branchedHttpMethods(file.content) : [];
    const emit: Array<HttpMethod | 'UNKNOWN'> = methods.length > 0 ? methods : ['UNKNOWN'];
    for (const method of emit) {
      if (
        out.addEndpoint({
          method,
          path: route,
          detector: 'pages-directory',
          file: file.path,
          evidence:
            method === 'UNKNOWN'
              ? `${file.path} is a pages/api handler; it declares no verb this pass can read, and a Pages-Router handler answers every method by default`
              : `${file.path} branches on req.method === '${method}'`,
          dynamic: isDynamic(route),
        })
      ) {
        ledger.hit('pages-directory');
      }
    }
  }

  const summary = refusalSummary(
    refusals,
    (n) => `${n} file${n === 1 ? '' : 's'} sit${n === 1 ? 's' : ''} under a pages/ directory`,
  );
  if (summary) ledger.refuse('pages-directory', summary);
}

function svelteSegment(segment: string): string | null {
  if (/^\(.*\)$/.test(segment)) return null; // SvelteKit group
  const rest = /^\[\.\.\.(.+)\]$/.exec(segment);
  if (rest) return `:${rest[1]}*`;
  const param = /^\[(.+?)(?:=[^\]]*)?\]$/.exec(segment);
  // A matcher suffix (`[id=integer]`) constrains the parameter; the name is what matters.
  if (param) return `:${param[1]}`;
  return segment;
}

function detectSvelteKit(files: AnalysedFile[], out: Collector, ledger: Ledger): void {
  for (const file of files) {
    const match = /(?:^|\/)src\/routes\/(.*)$/.exec(file.path);
    if (!match) continue;
    const parts = match[1]!.split('/');
    const leaf = parts.pop()!;
    if (!leaf.startsWith('+')) continue;

    const kind = /^\+(page|server|layout)/.exec(leaf)?.[1];
    if (!kind || kind === 'layout') continue;
    // `+page.server.ts` is the loader for a page the `+page.svelte` already declared.
    const isPageLoader = leaf.startsWith('+page.');
    ledger.examine('sveltekit');

    const route = joinSegments(parts.map(svelteSegment));

    if (kind === 'page' && !isPageLoader) {
      if (
        out.addRoute({
          route,
          detector: 'sveltekit',
          file: file.path,
          evidence: `${file.path} is a SvelteKit page; its directory path is the URL`,
          dynamic: isDynamic(route),
        })
      ) {
        ledger.hit('sveltekit');
      }
      continue;
    }
    if (kind !== 'server') continue;

    if (file.content === undefined) {
      ledger.starve('sveltekit');
      if (
        out.addEndpoint({
          method: 'UNKNOWN',
          path: route,
          detector: 'sveltekit',
          file: file.path,
          evidence: `${file.path} is a SvelteKit endpoint, but no file content was uploaded, so its exported verbs are unknown`,
          dynamic: isDynamic(route),
        })
      ) {
        ledger.hit('sveltekit');
      }
      continue;
    }

    const methods = exportedHttpMethods(file.content);
    const emit: Array<HttpMethod | 'UNKNOWN'> = methods.length > 0 ? methods : ['UNKNOWN'];
    for (const method of emit) {
      if (
        out.addEndpoint({
          method,
          path: route,
          detector: 'sveltekit',
          file: file.path,
          evidence:
            method === 'UNKNOWN'
              ? `${file.path} is a SvelteKit endpoint that exports no recognisable HTTP verb`
              : `${file.path} exports ${method}`,
          dynamic: isDynamic(route),
        })
      ) {
        ledger.hit('sveltekit');
      }
    }
  }
}

// ─── Declaration-based routing ───────────────────────────────────────────────

/** Turn a router library's parameter spelling into ours. */
function paramsToColon(path: string): string {
  return path
    .replace(/\{([^}:]+)(?::[^}]*)?\}/g, ':$1') // FastAPI / Spring / .NET `{id}`
    .replace(/<(?:[a-z_]+:)?([^>]+)>/g, ':$1') // Flask / Django `<int:pk>`
    .replace(/\*\*/g, '*');
}

const JS_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);

/**
 * A route table that is written down rather than implied by a filename.
 *
 * React Router, TanStack Router and Vue Router all put their routes in a literal
 * — a `<Route>` tree, or an array of `{ path, children }` objects — which means
 * the table can be read exactly. The one thing that must not be skipped is the
 * nesting. `<Route path="login">` inside `<Route path="auth">` serves
 * `/auth/login`; reported on its own as `/login` it names a URL the application
 * will 404 on, which is worse than reporting nothing at all.
 *
 * What follows is a lexical scan, not a parse: it tracks strings, comments and
 * brace depth, so a `path` inside `element={<Nav path="x" />}` is never mistaken
 * for the route's own and a `>` inside an element expression never ends a tag
 * early. That is enough for a literal route table, which is what all three of
 * these routers ask you to write.
 */

/** Cap on route declarations read out of any one file. */
const MAX_DECLARATIONS_PER_FILE = 2000;
/** How deep nesting is followed. Real route tables are three or four deep. */
const MAX_ROUTE_DEPTH = 32;

/** Index past a quoted string or template literal that starts at `i`. */
function skipQuoted(src: string, i: number): number {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === quote) return j + 1;
    j += 1;
  }
  return src.length;
}

/** Index past a comment that starts at `i`, or `i` when none does. */
function skipComment(src: string, i: number): number {
  if (src[i] !== '/') return i;
  if (src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl + 1;
  }
  if (src[i + 1] === '*') {
    const close = src.indexOf('*/', i + 2);
    return close === -1 ? src.length : close + 2;
  }
  return i;
}

function skipTrivia(src: string, i: number): number {
  let j = i;
  for (;;) {
    while (j < src.length && /\s/.test(src[j]!)) j += 1;
    const past = skipComment(src, j);
    if (past === j) return j;
    j = past;
  }
}

/** Index past a balanced `()`, `[]` or `{}` run starting at `i`, strings and comments honoured. */
function skipBalanced(src: string, i: number): number {
  const open = src[i];
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const ch = src[j]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      j = skipQuoted(src, j);
      continue;
    }
    const past = skipComment(src, j);
    if (past !== j) {
      j = past;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }
  return src.length;
}

const JSX_ATTR_NAME = /[A-Za-z_$][\w$.:-]*/y;
const OBJECT_KEY = /[A-Za-z_$][\w$]*/y;

interface JsxTag {
  /** Attributes given a literal string; one given an expression maps to null. */
  values: Map<string, string | null>;
  /** Every attribute name, so a bare boolean like `index` is still visible. */
  present: Set<string>;
  end: number;
  selfClosing: boolean;
}

/** Read one JSX opening tag whose name ends at `from`. */
function readJsxTag(src: string, from: number): JsxTag {
  const values = new Map<string, string | null>();
  const present = new Set<string>();
  let i = from;
  while (i < src.length) {
    i = skipTrivia(src, i);
    const ch = src[i];
    if (ch === undefined) break;
    if (ch === '>') return { values, present, end: i + 1, selfClosing: false };
    if (ch === '/' && src[i + 1] === '>') return { values, present, end: i + 2, selfClosing: true };
    // `{...props}` — a spread carries attributes this pass cannot see.
    if (ch === '{') {
      i = skipBalanced(src, i);
      continue;
    }
    JSX_ATTR_NAME.lastIndex = i;
    const name = JSX_ATTR_NAME.exec(src)?.[0];
    if (name === undefined) {
      i += 1;
      continue;
    }
    i += name.length;
    present.add(name);
    const afterName = skipTrivia(src, i);
    if (src[afterName] !== '=') {
      i = afterName;
      continue; // A bare attribute: `index`, `caseSensitive`.
    }
    const valueAt = skipTrivia(src, afterName + 1);
    const value = src[valueAt];
    if (value === '"' || value === "'") {
      const close = skipQuoted(src, valueAt);
      values.set(name, src.slice(valueAt + 1, close - 1));
      i = close;
    } else if (value === '{') {
      values.set(name, null);
      i = skipBalanced(src, valueAt);
    } else {
      values.set(name, null);
      i = valueAt + 1;
    }
  }
  return { values, present, end: src.length, selfClosing: false };
}

interface RouteDecl {
  /** The literal `path`; null when the attribute is absent or is an expression. */
  path: string | null;
  /** True when `path` was written as an expression, which is unreadable here. */
  computed: boolean;
  index: boolean;
  /** Index of the enclosing `<Route>`, or null when this is a top-level one. */
  parent: number | null;
  /** Which `<Routes>` element this sits in; -1 when it sits in none. */
  block: number;
}

const ROUTE_TAG = /<(\/?)(Routes|Route)(?![\w$])/y;

/**
 * Whether a quote here opens a string literal or is just a character in JSX text.
 *
 * It has to be asked. A file's prose — `Don't`, `members'`, a comment — is full
 * of apostrophes, and treating one as the start of a string would skip forward
 * to the next one and swallow whatever route declarations lie between. A quote
 * that opens a string never follows a word, a `>`, or a closing brace or bracket;
 * one sitting in prose almost always does.
 */
function opensString(src: string, i: number): boolean {
  if (src[i] === '`') return true;
  let j = i - 1;
  while (j >= 0 && (src[j] === ' ' || src[j] === '\t')) j -= 1;
  return j < 0 || !/[\w$>}\]]/.test(src[j]!);
}

/**
 * Read a file's `<Route>` elements as a tree, preserving who nests under whom.
 *
 * The walk is character by character rather than a bare regex sweep because a
 * `<Route path="pricing">` written inside a comment is a real thing that happens
 * — gymmm-frontend's App.tsx has one — and a phantom opening tag with no closing
 * partner reparents every route declared after it.
 */
function scanRouteElements(src: string): RouteDecl[] {
  const decls: RouteDecl[] = [];
  const open: number[] = [];
  const blocks: number[] = [];
  let block = -1;
  let blocksSeen = 0;

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if ((ch === '"' || ch === "'" || ch === '`') && opensString(src, i)) {
      i = skipQuoted(src, i);
      continue;
    }
    const pastComment = skipComment(src, i);
    if (pastComment !== i) {
      i = pastComment;
      continue;
    }
    if (ch !== '<') {
      i += 1;
      continue;
    }

    ROUTE_TAG.lastIndex = i;
    const match = ROUTE_TAG.exec(src);
    if (match === null) {
      i += 1;
      continue;
    }
    const isClosing = match[1] === '/';
    const isRoutes = match[2] === 'Routes';

    if (isClosing) {
      const gt = src.indexOf('>', i);
      i = gt === -1 ? src.length : gt + 1;
      if (isRoutes) block = blocks.pop() ?? -1;
      else open.pop();
      continue;
    }

    const tag = readJsxTag(src, i + match[0].length);
    i = Math.max(tag.end, i + match[0].length);

    if (isRoutes) {
      if (!tag.selfClosing) {
        blocks.push(block);
        blocksSeen += 1;
        block = blocksSeen;
      }
      continue;
    }

    if (decls.length >= MAX_DECLARATIONS_PER_FILE) break;
    const raw = tag.values.get('path');
    decls.push({
      path: raw === undefined ? null : raw,
      computed: tag.present.has('path') && raw === null,
      index: tag.present.has('index'),
      parent: open.length > 0 ? open[open.length - 1]! : null,
      block,
    });
    if (!tag.selfClosing && open.length < MAX_ROUTE_DEPTH) open.push(decls.length - 1);
  }
  return decls;
}

/**
 * Join a child path onto its parent the way the router does at match time.
 *
 * The trailing splat is the subtle part. `<Route path="superadmin/*">` wrapping
 * `<Route path="dashboard">` serves `/superadmin/dashboard`, not
 * `/superadmin/*\/dashboard`: the router matches each ancestor's pattern in turn
 * with the end unanchored, so a parent's `/*` consumes nothing on the way down.
 */
function joinChildRoute(parent: string, child: string): string {
  return normaliseRoute(paramsToColon(`${stripSplat(parent)}/${child}`));
}

/**
 * Drop a trailing splat. Two places need it: joining a child onto its parent,
 * and reporting the parent itself. `<Route path="superadmin/*">` that wraps
 * child routes is a layout whose splat exists only so the children can match —
 * the URL it sits at is `/superadmin`, and `/superadmin/*` is not a page anyone
 * can open. A splat on a route with NO children is left alone: there it names a
 * real prefix, usually a descendant route table mounted underneath.
 */
function stripSplat(path: string): string {
  const stripped = path.replace(/\/?\*+$/, '');
  return stripped === '' ? '/' : stripped;
}

/** What a code-declared router detector could not resolve, for the notes. */
interface DeclaredRoutingReport {
  /** Route tables whose own mount point is decided elsewhere in the import graph. */
  unmountedTables: number;
  /** `path` values computed at runtime rather than written as a literal. */
  computedPaths: number;
}

/**
 * A file whose route elements are mounted at the site root — either it builds
 * the router itself, or one of its top-level routes is an absolute path, which
 * React Router only permits where there is no parent prefix to prepend.
 */
const ROOT_ROUTER_CONSTRUCT =
  /<(?:BrowserRouter|HashRouter|MemoryRouter|StaticRouter)\b|create(?:Browser|Hash|Memory)Router\s*\(/;

const REACT_ROUTER_TABLE =
  /\b(createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes)\s*\(\s*(?=\[)/g;

function detectReactRouter(
  files: AnalysedFile[],
  out: Collector,
  ledger: Ledger,
  report: DeclaredRoutingReport,
): void {
  for (const file of files) {
    if (!JS_EXT.has(file.ext)) continue;
    if (file.content === undefined) continue;
    // The import is the gate. Without it, `<Route` and `path:` match a router
    // someone wrote for something else entirely.
    if (!/from\s+['"]react-router(?:-dom|-native)?['"]/.test(file.content)) continue;
    const content = file.content;
    ledger.examine('react-router');

    // ── The <Route> tree ─────────────────────────────────────────────────────
    const decls = scanRouteElements(content);
    if (decls.length > 0) {
      const hasOwnRouter = ROOT_ROUTER_CONSTRUCT.test(content);
      const rootBlocks = new Set<number>();
      const allBlocks = new Set<number>();
      for (const decl of decls) {
        allBlocks.add(decl.block);
        if (decl.parent === null && decl.path !== null && decl.path.startsWith('/')) {
          rootBlocks.add(decl.block);
        }
      }
      if (hasOwnRouter) for (const b of allBlocks) rootBlocks.add(b);
      for (const b of allBlocks) if (!rootBlocks.has(b)) report.unmountedTables += 1;

      const hasChildren = new Set<number>();
      for (const decl of decls) if (decl.parent !== null) hasChildren.add(decl.parent);

      const bases: Array<string | null | undefined> = new Array(decls.length).fill(undefined);
      const baseOf = (i: number): string | null => {
        const cached = bases[i];
        if (cached !== undefined) return cached;
        bases[i] = null; // Breaks a cycle a malformed tag pairing could produce.
        const decl = decls[i]!;
        const parentBase =
          decl.parent === null ? (rootBlocks.has(decl.block) ? '/' : null) : baseOf(decl.parent);
        let base: string | null;
        if (parentBase === null || decl.computed) base = null;
        else if (decl.path === null || decl.path === '') base = parentBase;
        else if (decl.path.startsWith('/')) base = normaliseRoute(paramsToColon(decl.path));
        else base = joinChildRoute(parentBase, decl.path);
        if (base !== null && hasChildren.has(i)) base = stripSplat(base);
        bases[i] = base;
        return base;
      };

      for (let i = 0; i < decls.length; i += 1) {
        const decl = decls[i]!;
        if (decl.computed) report.computedPaths += 1;
        // `path="*"` is the fallback that matches everything unmatched. It names
        // no URL, so a test told to visit it has nowhere to go.
        if (decl.path === '*') continue;
        // A pathless <Route> is a layout: it wraps a subtree and is reachable at
        // no URL of its own, exactly like a Next.js layout.tsx.
        if (!decl.index && (decl.path === null || decl.path === '')) continue;
        const base = baseOf(i);
        if (base === null) continue;
        const parentBase = decl.parent === null ? '/' : (bases[decl.parent] ?? '/');
        const how =
          decl.path === null || decl.path === ''
            ? `an index <Route> under "${parentBase}"`
            : decl.parent === null
              ? `<Route path="${decl.path}">`
              : `<Route path="${decl.path}"> nested under "${parentBase}"`;
        if (
          out.addRoute({
            route: base,
            detector: 'react-router',
            file: file.path,
            evidence: `${file.path} declares ${how}`,
            dynamic: isDynamic(base),
          })
        ) {
          ledger.hit('react-router');
        }
      }
    }

    // ── The route-object form ────────────────────────────────────────────────
    REACT_ROUTER_TABLE.lastIndex = 0;
    let call: RegExpExecArray | null;
    while ((call = REACT_ROUTER_TABLE.exec(content)) !== null) {
      const at = REACT_ROUTER_TABLE.lastIndex;
      const nodes = parseRouteArray(content, at, 0);
      REACT_ROUTER_TABLE.lastIndex = Math.max(skipBalanced(content, at), at + 1);
      if (nodes.length === 0) continue;
      // `createBrowserRouter` IS the router, so its table sits at the root.
      // `useRoutes` is a hook inside a component that may itself be mounted
      // anywhere, so it is trusted only when it declares an absolute path.
      const rooted =
        call[1] !== 'useRoutes' || nodes.some((n) => n.path !== null && n.path.startsWith('/'));
      if (!rooted) {
        report.unmountedTables += 1;
        continue;
      }
      emitObjectRoutes(nodes, '/', file, 'react-router', out, ledger, report, 0);
    }
  }
}

/** Where a Vue Router table is written down. */
const VUE_ROUTER_TABLE = /\broutes\s*:\s*(?=\[)|\b(?:const|let|var)\s+routes\b[^=\n]*=\s*(?=\[)/g;

function detectVueRouter(
  files: AnalysedFile[],
  out: Collector,
  ledger: Ledger,
  report: DeclaredRoutingReport,
): void {
  for (const file of files) {
    if (!JS_EXT.has(file.ext) && file.ext !== '.vue') continue;
    if (file.content === undefined) continue;
    if (!/from\s+['"]vue-router['"]|createRouter\s*\(/.test(file.content)) continue;
    const content = file.content;
    ledger.examine('vue-router');

    VUE_ROUTER_TABLE.lastIndex = 0;
    while (VUE_ROUTER_TABLE.exec(content) !== null) {
      const at = VUE_ROUTER_TABLE.lastIndex;
      const nodes = parseRouteArray(content, at, 0);
      VUE_ROUTER_TABLE.lastIndex = Math.max(skipBalanced(content, at), at + 1);
      // A Vue Router record at the top of `routes` is absolute by the library's
      // own rule; only `children` are relative to it.
      emitObjectRoutes(nodes, '/', file, 'vue-router', out, ledger, report, 0);
    }
  }
}

interface ObjectRoute {
  path: string | null;
  computed: boolean;
  index: boolean;
  children: ObjectRoute[];
}

/** Read an array literal of route objects, following `children` into the nesting. */
function parseRouteArray(src: string, i: number, depth: number): ObjectRoute[] {
  const out: ObjectRoute[] = [];
  if (depth > MAX_ROUTE_DEPTH || src[i] !== '[') return out;
  let j = i + 1;
  while (j < src.length && out.length < MAX_DECLARATIONS_PER_FILE) {
    j = skipTrivia(src, j);
    const ch = src[j];
    if (ch === undefined || ch === ']') break;
    if (ch === '{') {
      const end = skipBalanced(src, j);
      out.push(parseRouteObject(src, j, end, depth));
      j = end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      j = skipQuoted(src, j);
      continue;
    }
    if (ch === '[' || ch === '(') {
      j = skipBalanced(src, j);
      continue;
    }
    j += 1;
  }
  return out;
}

function parseRouteObject(src: string, start: number, end: number, depth: number): ObjectRoute {
  const route: ObjectRoute = { path: null, computed: false, index: false, children: [] };
  let j = start + 1;
  while (j < end - 1) {
    j = skipTrivia(src, j);
    const ch = src[j];
    if (ch === undefined) break;

    let key: string | null = null;
    if (ch === '"' || ch === "'") {
      const close = skipQuoted(src, j);
      key = src.slice(j + 1, close - 1);
      j = close;
    } else {
      OBJECT_KEY.lastIndex = j;
      const name = OBJECT_KEY.exec(src)?.[0];
      if (name !== undefined) {
        key = name;
        j += name.length;
      }
    }

    if (key === null) {
      // A spread, a computed key, a nested literal — nothing this pass reads.
      if (ch === '{' || ch === '[' || ch === '(') j = skipBalanced(src, j);
      else j += 1;
      continue;
    }

    j = skipTrivia(src, j);
    if (src[j] !== ':') continue;
    j = skipTrivia(src, j + 1);
    const value = src[j];
    if (value === undefined) break;

    if (key === 'path' && (value === '"' || value === "'")) {
      const close = skipQuoted(src, j);
      route.path = src.slice(j + 1, close - 1);
      j = close;
      continue;
    }
    if (key === 'path') route.computed = true;
    if (key === 'index') route.index = /^true\b/.test(src.slice(j, j + 5));
    if (key === 'children' && value === '[') {
      route.children = parseRouteArray(src, j, depth + 1);
      j = skipBalanced(src, j);
      continue;
    }
    if (value === '{' || value === '[' || value === '(') {
      j = skipBalanced(src, j);
      continue;
    }
    if (value === '"' || value === "'" || value === '`') {
      j = skipQuoted(src, j);
      continue;
    }
    // Any other value runs to the next comma at this object's own depth. It has
    // to be walked rather than searched for: a TSX `element: <Err msg="a } b" />`
    // carries braces and quotes that would otherwise end the object early and
    // take its `children` with it.
    while (j < end - 1) {
      const c = src[j]!;
      if (c === '"' || c === "'" || c === '`') {
        j = skipQuoted(src, j);
        continue;
      }
      const past = skipComment(src, j);
      if (past !== j) {
        j = past;
        continue;
      }
      if (c === '{' || c === '[' || c === '(') {
        j = skipBalanced(src, j);
        continue;
      }
      if (c === ',' || c === '}') break;
      j += 1;
    }
    j += 1;
  }
  return route;
}

function emitObjectRoutes(
  nodes: ObjectRoute[],
  parentBase: string | null,
  file: AnalysedFile,
  detector: SourceDetectorId,
  out: Collector,
  ledger: Ledger,
  report: DeclaredRoutingReport,
  depth: number,
): void {
  if (depth > MAX_ROUTE_DEPTH) return;
  for (const node of nodes) {
    if (node.computed) report.computedPaths += 1;
    if (node.path === '*') continue;

    let base: string | null;
    if (parentBase === null || node.computed) base = null;
    else if (node.path === null || node.path === '') base = parentBase;
    else if (node.path.startsWith('/')) base = normaliseRoute(paramsToColon(node.path));
    else base = joinChildRoute(parentBase, node.path);
    if (base !== null && node.children.length > 0) base = stripSplat(base);

    const named = node.path !== null && node.path !== '';
    if (base !== null && (named || node.index)) {
      const how = !named
        ? `an index route under "${parentBase}"`
        : parentBase === '/'
          ? `a route object with path: "${node.path}"`
          : `a route object with path: "${node.path}" nested under "${parentBase}"`;
      if (
        out.addRoute({
          route: base,
          detector,
          file: file.path,
          evidence: `${file.path} declares ${how}`,
          dynamic: isDynamic(base),
        })
      ) {
        ledger.hit(detector);
      }
    }

    if (node.children.length > 0) {
      emitObjectRoutes(node.children, base, file, detector, out, ledger, report, depth + 1);
    }
  }
}

/**
 * Identifiers that take `.get(...)` and are emphatically not servers. Without
 * this list an `axios.get('/api/orders')` in the front end would be reported as
 * an endpoint the back end serves — a call site read as a definition, which is
 * the single most plausible wrong answer this whole file could produce.
 */
const NOT_A_SERVER = new Set([
  'axios',
  'http',
  'https',
  'fetch',
  'got',
  'ky',
  'superagent',
  'supertest',
  'request',
  'client',
  'api',
  'apiClient',
  'httpClient',
  'page',
  'browser',
  'context',
  'db',
  'cache',
  'redis',
  'store',
  'map',
  'headers',
  'cookies',
  'params',
  'searchParams',
  'localStorage',
  'sessionStorage',
  'env',
  'process',
  'config',
  'this',
]);

/** Names a server instance conventionally has, when no local factory call is visible. */
const SERVER_NAMES = new Set(['app', 'router', 'server', 'fastify', 'express', 'hono']);

const SERVER_FACTORY =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:new\s+)?(?:express|Router|express\.Router|Fastify|fastify|Hono|Koa|new\s+Hono|new\s+Koa)\s*\(/g;

function detectExpressFastify(files: AnalysedFile[], out: Collector, ledger: Ledger): boolean {
  let sawMountPrefix = false;

  for (const file of files) {
    if (!JS_EXT.has(file.ext)) continue;
    if (file.content === undefined) continue;
    const content = file.content;
    if (!/\.(get|post|put|patch|delete|options|head|all)\s*\(\s*['"`]\//.test(content)) continue;
    ledger.examine('express-fastify');

    // Locally-declared server values beat the conventional-name list: a repo
    // that calls its router `orders` is still declaring routes on it.
    const local = new Set<string>();
    for (const m of content.matchAll(SERVER_FACTORY)) local.add(m[1]!);

    const re =
      /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*(['"`])([^'"`]*)\3/g;
    for (const m of content.matchAll(re)) {
      const holder = m[1]!;
      const verb = m[2]!.toUpperCase();
      const raw = m[4]!;
      // A served path is absolute. This one condition removes most call sites.
      if (!raw.startsWith('/')) continue;
      if (NOT_A_SERVER.has(holder)) continue;
      if (!local.has(holder) && !SERVER_NAMES.has(holder)) continue;

      const path = normaliseRoute(paramsToColon(raw));
      const methods: Array<HttpMethod | 'UNKNOWN'> =
        verb === 'ALL' ? ['UNKNOWN'] : [verb as HttpMethod];
      for (const method of methods) {
        if (
          out.addEndpoint({
            method,
            path,
            detector: 'express-fastify',
            file: file.path,
            evidence:
              verb === 'ALL'
                ? `${file.path} declares ${holder}.all('${raw}'), which answers every method`
                : `${file.path} declares ${holder}.${m[2]}('${raw}')`,
            dynamic: isDynamic(path),
          })
        ) {
          ledger.hit('express-fastify');
        }
      }
    }

    // `app.use('/api', ordersRouter)` moves every path in that router. We have no
    // import graph, so the prefix cannot be applied — but its presence changes
    // how the list above should be read, and that is worth saying out loud.
    if (/\.use\s*\(\s*(['"`])\/[^'"`]*\1\s*,/.test(content)) sawMountPrefix = true;
  }

  return sawMountPrefix;
}

function detectDjangoUrls(files: AnalysedFile[], out: Collector, ledger: Ledger): boolean {
  let sawInclude = false;
  for (const file of files) {
    if (basename(file.path) !== 'urls.py') continue;
    ledger.examine('django-urls');
    if (file.content === undefined) {
      ledger.starve('django-urls');
      continue;
    }
    const content = file.content;

    for (const m of content.matchAll(
      /\b(?:path|re_path|url)\s*\(\s*r?(['"])([^'"]*)\1\s*,\s*([^,)\n]*)/g,
    )) {
      const raw = m[2]!;
      const target = (m[3] ?? '').trim();
      if (target.startsWith('include(')) {
        sawInclude = true;
        continue;
      }
      // A regex URLconf entry is not a literal path; strip only the anchors we
      // can strip safely and leave the rest visible rather than mangling it.
      const cleaned = raw.replace(/^\^/, '').replace(/\$$/, '');
      const route = normaliseRoute(paramsToColon(cleaned));
      if (
        out.addRoute({
          route,
          detector: 'django-urls',
          file: file.path,
          evidence: `${file.path} declares path('${raw}') → ${target || 'a view'}`,
          dynamic: isDynamic(route),
        })
      ) {
        ledger.hit('django-urls');
      }
    }
  }
  return sawInclude;
}

// ─── Rails ───────────────────────────────────────────────────────────────────

/**
 * The seven routes `resources :x` means, spelled out. This expansion is not a
 * heuristic — it is the documented contract of the macro, so it is exactly as
 * true as the line in routes.rb that triggers it.
 */
const RESOURCE_ROUTES: Array<{ action: string; method: HttpMethod; suffix: string }> = [
  { action: 'index', method: 'GET', suffix: '' },
  { action: 'new', method: 'GET', suffix: '/new' },
  { action: 'create', method: 'POST', suffix: '' },
  { action: 'show', method: 'GET', suffix: '/:id' },
  { action: 'edit', method: 'GET', suffix: '/:id/edit' },
  { action: 'update', method: 'PATCH', suffix: '/:id' },
  { action: 'destroy', method: 'DELETE', suffix: '/:id' },
];

/** Singular `resource :x` has no index and no :id. */
const SINGULAR_RESOURCE_ROUTES: Array<{ action: string; method: HttpMethod; suffix: string }> = [
  { action: 'new', method: 'GET', suffix: '/new' },
  { action: 'create', method: 'POST', suffix: '' },
  { action: 'show', method: 'GET', suffix: '' },
  { action: 'edit', method: 'GET', suffix: '/edit' },
  { action: 'update', method: 'PATCH', suffix: '' },
  { action: 'destroy', method: 'DELETE', suffix: '' },
];

function railsActionFilter(options: string): { only: string[] | null; except: string[] } {
  const only = /only:\s*(?:\[([^\]]*)\]|:(\w+))/.exec(options);
  const except = /except:\s*(?:\[([^\]]*)\]|:(\w+))/.exec(options);
  const parse = (m: RegExpExecArray | null): string[] =>
    m ? (m[1] ?? m[2] ?? '').split(',').map((s) => s.trim().replace(/^:/, '')).filter(Boolean) : [];
  return { only: only ? parse(only) : null, except: parse(except) };
}

function detectRailsRoutes(files: AnalysedFile[], out: Collector, ledger: Ledger): void {
  for (const file of files) {
    if (!/(?:^|\/)config\/routes(?:\/[^/]+)?\.rb$/.test(file.path)) continue;
    ledger.examine('rails-routes');
    if (file.content === undefined) {
      ledger.starve('rails-routes');
      continue;
    }

    // Rails nests with blocks, so the prefix is a stack. Entries carry null when
    // the block opens a scope that contributes no URL segment (`draw do`).
    const stack: Array<string | null> = [];
    const prefix = (): string => stack.filter((s): s is string => Boolean(s)).join('/');

    const addRoute = (method: HttpMethod, raw: string, evidence: string): void => {
      const path = normaliseRoute(paramsToColon(`/${prefix()}/${raw.replace(/^\//, '')}`));
      if (
        out.addEndpoint({
          method,
          path,
          detector: 'rails-routes',
          file: file.path,
          evidence,
          dynamic: isDynamic(path),
        })
      ) {
        ledger.hit('rails-routes');
      }
      // Rails renders HTML from GETs, so a GET declaration is also a page.
      if (method === 'GET' && !path.endsWith('.json')) {
        out.addRoute({
          route: path,
          detector: 'rails-routes',
          file: file.path,
          evidence,
          dynamic: isDynamic(path),
        });
      }
    };

    for (const line of file.content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      if (/^end\b/.test(trimmed)) {
        stack.pop();
        continue;
      }

      const namespace = /^(?:namespace|scope)\s+(?::(\w+)|(['"])([^'"]+)\2)/.exec(trimmed);
      const opensBlock = /\bdo\b\s*(?:\|[^|]*\|)?\s*$/.test(trimmed);

      const resource = /^(resources?)\s+:(\w+)(.*)$/.exec(trimmed);
      if (resource) {
        const plural = resource[1] === 'resources';
        const name = resource[2]!;
        const options = resource[3] ?? '';
        const { only, except } = railsActionFilter(options);
        const table = plural ? RESOURCE_ROUTES : SINGULAR_RESOURCE_ROUTES;
        for (const entry of table) {
          if (only && !only.includes(entry.action)) continue;
          if (except.includes(entry.action)) continue;
          addRoute(
            entry.method,
            `${name}${entry.suffix}`,
            `${file.path} declares ${resource[1]} :${name}, whose ${entry.action} action is ${entry.method} /${name}${entry.suffix}`,
          );
        }
        // A nested block scopes children under the member path.
        if (opensBlock) stack.push(plural ? `${name}/:${singularise(name)}_id` : name);
        continue;
      }

      const verb = /^(get|post|put|patch|delete)\s+(?::(\w+)|(['"])([^'"]+)\3)(.*)$/.exec(trimmed);
      if (verb) {
        const raw = verb[2] ?? verb[4] ?? '';
        const rest = verb[5] ?? '';
        // `get 'profile', to: 'users#show'` and `get :profile` both name a path.
        addRoute(
          verb[1]!.toUpperCase() as HttpMethod,
          raw,
          `${file.path} declares ${verb[1]} '${raw}'${/to:/.test(rest) ? rest.replace(/^,\s*/, ', ') : ''}`.trim(),
        );
        if (opensBlock) stack.push(null);
        continue;
      }

      if (/^root\b/.test(trimmed)) {
        addRoute('GET', '/', `${file.path} declares root, which serves /`);
        continue;
      }

      if (opensBlock) {
        stack.push(namespace ? (namespace[1] ?? namespace[3] ?? null) : null);
      }
    }
  }
}

/** Rails' own inflection is a dictionary; this is the 95% of it a path needs. */
function singularise(word: string): string {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('ches')) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

// ─── Spring ──────────────────────────────────────────────────────────────────

const SPRING_METHOD_ANNOTATION: Record<string, HttpMethod> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  PatchMapping: 'PATCH',
  DeleteMapping: 'DELETE',
};

/** `@GetMapping("/x")`, `@GetMapping(value = "/x")`, `@GetMapping(path = "/x")`. */
function springAnnotationPath(args: string): string | null {
  const explicit = /(?:value|path)\s*=\s*\{?\s*"([^"]*)"/.exec(args);
  if (explicit) return explicit[1]!;
  const positional = /^\s*\{?\s*"([^"]*)"/.exec(args);
  return positional ? positional[1]! : null;
}

function detectSpringMvc(files: AnalysedFile[], out: Collector, ledger: Ledger): void {
  for (const file of files) {
    if (file.ext !== '.java' && file.ext !== '.kt') continue;
    if (file.content === undefined) continue;
    if (!/@(?:Rest)?Controller\b|@RequestMapping\b|@(?:Get|Post|Put|Patch|Delete)Mapping\b/.test(
      file.content,
    )) {
      continue;
    }
    ledger.examine('spring-mvc');
    const content = file.content;

    // The class-level @RequestMapping is the prefix every method hangs off. It is
    // the one immediately above the class declaration; a method-level one sits
    // above a method, so position is what separates them.
    let classPrefix = '';
    const classMatch =
      /@RequestMapping\s*\(([^)]*)\)[\s\S]{0,400}?\b(?:public\s+|open\s+|final\s+|abstract\s+)*(?:class|object)\s+\w+/.exec(
        content,
      );
    if (classMatch) classPrefix = springAnnotationPath(classMatch[1] ?? '') ?? '';

    const emit = (method: HttpMethod | 'UNKNOWN', raw: string, how: string): void => {
      const path = normaliseRoute(paramsToColon(`/${classPrefix}/${raw.replace(/^\//, '')}`));
      if (
        out.addEndpoint({
          method,
          path,
          detector: 'spring-mvc',
          file: file.path,
          evidence: `${file.path} declares ${how}`,
          dynamic: isDynamic(path),
        })
      ) {
        ledger.hit('spring-mvc');
      }
    };

    // The parentheses are optional, and a bare `@GetMapping` is not an edge case:
    // it is how a controller declares the collection route at its class prefix.
    // Requiring `(…)` silently dropped the index and create actions of every
    // REST controller written the conventional way.
    for (const m of content.matchAll(
      /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\s*(?:\(([^)]*)\))?/g,
    )) {
      const method = SPRING_METHOD_ANNOTATION[m[1]!]!;
      const args = m[2] ?? '';
      emit(
        method,
        springAnnotationPath(args) ?? '',
        args ? `@${m[1]}(${args.trim()})` : `@${m[1]} with no path, so it serves the class prefix`,
      );
    }
    // A method-level @RequestMapping names its verb in `method =`; without one it
    // answers every verb, which is UNKNOWN rather than GET.
    for (const m of content.matchAll(/@RequestMapping\s*\(([^)]*)\)/g)) {
      const args = m[1] ?? '';
      const raw = springAnnotationPath(args);
      if (raw === null) continue;
      if (classMatch && m[0] === classMatch[0].slice(0, m[0].length) && raw === classPrefix) {
        continue; // the class-level annotation itself, already used as the prefix
      }
      const verb = /RequestMethod\.(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)/.exec(args);
      emit(
        verb ? (verb[1] as HttpMethod) : 'UNKNOWN',
        raw,
        `@RequestMapping(${args.trim()})${verb ? '' : ' with no method =, so it answers every verb'}`,
      );
    }
  }
}

// ─── Flask / FastAPI ─────────────────────────────────────────────────────────

function detectFlaskFastapi(files: AnalysedFile[], out: Collector, ledger: Ledger): void {
  for (const file of files) {
    if (file.ext !== '.py') continue;
    if (file.content === undefined) continue;
    const content = file.content;
    if (!/@\w+\.(?:route|get|post|put|patch|delete)\s*\(/.test(content)) continue;
    ledger.examine('flask-fastapi');

    // Flask: @app.route('/x', methods=['GET', 'POST'])
    for (const m of content.matchAll(
      /@(\w+)\.route\s*\(\s*(['"])([^'"]*)\2([^)]*)\)/g,
    )) {
      const raw = m[3]!;
      const options = m[4] ?? '';
      const methodsList = /methods\s*=\s*\[([^\]]*)\]/.exec(options);
      const methods: Array<HttpMethod | 'UNKNOWN'> = methodsList
        ? (methodsList[1] ?? '')
            .split(',')
            .map((s) => s.trim().replace(/['"]/g, '').toUpperCase())
            .filter((s): s is HttpMethod => (HTTP_METHODS as readonly string[]).includes(s))
        : ['GET']; // Flask's documented default when methods= is omitted.
      const path = normaliseRoute(paramsToColon(raw));
      for (const method of methods.length > 0 ? methods : (['UNKNOWN'] as const)) {
        if (
          out.addEndpoint({
            method,
            path,
            detector: 'flask-fastapi',
            file: file.path,
            evidence: `${file.path} declares @${m[1]}.route('${raw}'${methodsList ? `, methods=[${methodsList[1]}]` : ', which defaults to GET'})`,
            dynamic: isDynamic(path),
          })
        ) {
          ledger.hit('flask-fastapi');
        }
      }
    }

    // FastAPI: @app.get('/x'), @router.post('/x')
    for (const m of content.matchAll(
      /@(\w+)\.(get|post|put|patch|delete|options|head)\s*\(\s*(['"])([^'"]*)\3/g,
    )) {
      const raw = m[4]!;
      const path = normaliseRoute(paramsToColon(raw));
      if (
        out.addEndpoint({
          method: m[2]!.toUpperCase() as HttpMethod,
          path,
          detector: 'flask-fastapi',
          file: file.path,
          evidence: `${file.path} declares @${m[1]}.${m[2]}('${raw}')`,
          dynamic: isDynamic(path),
        })
      ) {
        ledger.hit('flask-fastapi');
      }
    }
  }
}

// ─── Forms ───────────────────────────────────────────────────────────────────

const FORM_EXT = new Set([
  '.html',
  '.htm',
  '.jsx',
  '.tsx',
  '.vue',
  '.svelte',
  '.astro',
  '.erb',
  '.php',
  '.hbs',
  '.mustache',
  '.twig',
  '.liquid',
]);

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{["'\`]([^"'\`]*)["'\`]\\})`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

const hasBareAttr = (tag: string, name: string): boolean =>
  new RegExp(`\\b${name}\\b(?!\\s*=\\s*\\{?\\s*(?:"|'|false))`, 'i').test(tag);

/**
 * name/label/type → a data-generation hint, in the Explorer's vocabulary.
 *
 * Ordered most specific first, and the card fields come before the generic ones
 * on purpose: `card_expiry` also matches `date`, and answering 'date' for it
 * would hand the synthetic-data generator a plausible value that no payment form
 * accepts.
 */
function inferSemantic(name: string, type: string, label: string | null): FieldSemantic {
  const hay = `${name} ${label ?? ''}`.toLowerCase().replace(/[\s_-]+/g, '_');
  const t = type.toLowerCase();

  if (t === 'password' || /pass(word|wd|phrase)/.test(hay)) return 'password';
  if (t === 'email' || /e_?mail/.test(hay)) return 'email';
  if (/cvc|cvv|security_code|card_code/.test(hay)) return 'card_cvc';
  if (/exp(iry|iration)|exp_(month|year|date)/.test(hay)) return 'card_expiry';
  if (/card_?number|cardnum|credit_?card|^cc$|cc_num/.test(hay)) return 'credit_card';
  if (t === 'tel' || /phone|mobile|telephone/.test(hay)) return 'phone';
  if (/zip|postal|postcode/.test(hay)) return 'postal_code';
  if (/country/.test(hay)) return 'country';
  if (/city|town|locality/.test(hay)) return 'city';
  if (/address|street|addr_?line/.test(hay)) return 'street_address';
  if (t === 'search' || /^q$|^query$|search/.test(hay)) return 'search';
  if (t === 'date' || t === 'datetime-local' || t === 'month' || /birth|dob|_date$/.test(hay)) {
    return 'date';
  }
  if (t === 'number' || t === 'range' || /quantity|amount|count|age/.test(hay)) return 'number';
  if (/(first|last|full|given|family|display|user)_?name$|^name$/.test(hay)) return 'person_name';
  if (t === 'textarea' || /message|comment|bio|description|notes?/.test(hay)) return 'freeform';
  if (t === 'text') return 'freeform';
  return 'unknown';
}

/** `<label for="email">Email address</label>` → { email: 'Email address' }. */
function labelsById(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(
    /<label\b[^>]*\bfor\s*=\s*(?:"([^"]*)"|'([^']*)'|\{["'`]([^"'`]*)["'`]\})[^>]*>([\s\S]{0,200}?)<\/label>/gi,
  )) {
    const target = m[1] ?? m[2] ?? m[3];
    const text = (m[4] ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (target && text) out.set(target, text);
  }
  return out;
}

function detectForms(files: AnalysedFile[], out: Collector, ledger: Ledger): void {
  for (const file of files) {
    if (!FORM_EXT.has(file.ext)) continue;
    if (file.content === undefined) {
      // Only starve on files that plausibly hold a form; every .tsx in the repo
      // would otherwise make the detector look blocked when it is merely idle.
      continue;
    }
    if (!/<form\b/i.test(file.content)) continue;
    ledger.examine('html-forms');

    const blocks = [...file.content.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi)].slice(
      0,
      MAX_FORMS_PER_FILE,
    );

    blocks.forEach((block, index) => {
      const openTag = block[1] ?? '';
      const body = block[2] ?? '';
      const labels = labelsById(body);

      const fields: SourceFormField[] = [];
      const seen = new Set<string>();
      const addField = (
        name: string,
        inputType: string,
        required: boolean,
        tag: string,
        options?: string[],
      ): void => {
        if (!name || seen.has(name) || fields.length >= MAX_FIELDS_PER_FORM) return;
        seen.add(name);
        const id = attr(tag, 'id');
        const label =
          (id ? labels.get(id) : null) ??
          labels.get(name) ??
          attr(tag, 'aria-label') ??
          attr(tag, 'placeholder') ??
          null;
        fields.push({
          name,
          label,
          inputType,
          required,
          semantic: inferSemantic(name, inputType, label),
          ...(options && options.length > 0 ? { options } : {}),
        });
      };

      for (const m of body.matchAll(/<input\b([^>]*)\/?>/gi)) {
        const tag = m[1] ?? '';
        const type = (attr(tag, 'type') ?? 'text').toLowerCase();
        if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') continue;
        const name = attr(tag, 'name') ?? attr(tag, 'id') ?? '';
        addField(name, type, hasBareAttr(tag, 'required'), tag);
      }
      for (const m of body.matchAll(/<textarea\b([^>]*)>/gi)) {
        const tag = m[1] ?? '';
        addField(
          attr(tag, 'name') ?? attr(tag, 'id') ?? '',
          'textarea',
          hasBareAttr(tag, 'required'),
          tag,
        );
      }
      for (const m of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select\s*>/gi)) {
        const tag = m[1] ?? '';
        const options = [...(m[2] ?? '').matchAll(/<option\b[^>]*>([\s\S]{0,120}?)<\/option>/gi)]
          .map((o) => (o[1] ?? '').replace(/<[^>]*>/g, '').trim())
          .filter(Boolean)
          .slice(0, 30);
        addField(
          attr(tag, 'name') ?? attr(tag, 'id') ?? '',
          'select',
          hasBareAttr(tag, 'required'),
          tag,
          options,
        );
      }

      const submit =
        /<button\b[^>]*>([\s\S]{0,120}?)<\/button\s*>/i.exec(body)?.[1] ??
        /<input\b[^>]*\btype\s*=\s*["']submit["'][^>]*>/i.exec(body)?.[0] ??
        null;
      const submitLabel = submit
        ? (attr(submit, 'value') ?? submit.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()) ||
          null
        : null;

      const method = attr(openTag, 'method');
      if (
        out.addForm({
          id: `${file.path}#${index}`,
          name: attr(openTag, 'name') ?? attr(openTag, 'id') ?? `form ${index + 1} in ${file.path}`,
          action: attr(openTag, 'action'),
          method: method ? method.toUpperCase() : null,
          file: file.path,
          fields,
          submitLabel,
        })
      ) {
        ledger.hit('html-forms');
      }
    });
  }
}

// ─── Auth surfaces ───────────────────────────────────────────────────────────

/**
 * A path broken into the words a human reads in it.
 *
 * Segments do not arrive pre-tokenised. A file-convention router turns
 * `src/pages/auth/ForgotPassword.tsx` into the route `/auth/ForgotPassword`, so
 * a vocabulary anchored on whole segments sees one opaque word `forgotpassword`
 * and matches none of `forgot`, `password` or `reset`. That is how a real
 * repository's password, signup and invite pages — every file under an `auth/`
 * directory — came back as SESSION: nothing matched them except the `auth`
 * directory itself, which used to be in the SESSION vocabulary and swallowed
 * the lot.
 *
 * `words` therefore carries each segment split on camelCase, kebab-case,
 * snake_case and dots, plus each ADJACENT PAIR run together, so `sign-out`,
 * `SignOut` and `SignOutButton` all answer to `signout`. `segments` carries the
 * raw lower-cased segment, which is all the ambiguous half of the vocabulary is
 * ever matched against.
 */
/** Every spelling of a dynamic segment the route detectors above can emit. */
const PARAM_SEGMENT = /^(:.*|\[.*\]|\{.*\}|<.*>|\*+)$/;

function authWords(path: string): { words: Set<string>; segments: Set<string> } {
  const words = new Set<string>();
  const segments = new Set<string>();
  for (const raw of path.split('/')) {
    // A parameter names a value the caller supplies, not the surface. Reading
    // one as vocabulary made `/accept-invite/:token` a SESSION on the strength
    // of the word `token`, which is the name of the invite code in the URL.
    if (PARAM_SEGMENT.test(raw)) continue;
    // A file extension is not a word: a form surface's path is its own file.
    const segment = raw.replace(/\.[A-Za-z0-9]+$/, '');
    if (segment === '') continue;
    segments.add(segment.toLowerCase());
    const parts = segment
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter((part) => part !== '')
      .map((part) => part.toLowerCase());
    parts.forEach((part, i) => {
      words.add(part);
      const next = parts[i + 1];
      if (next !== undefined) words.add(part + next);
    });
  }
  return { words, segments };
}

/**
 * Ordered: the first entry that matches wins, so `/auth/logout` is a LOGOUT
 * rather than the LOGIN its `login`-adjacent neighbours might also suggest.
 *
 * `strong` words are specific enough to mean what they say wherever they appear
 * in a path — nothing called `password` is not a password flow. `weak` words
 * are common English that only means auth when it is the WHOLE segment: `reset`
 * matches `/reset` but must not turn `/settings/reset-onboarding` into a
 * password test, and `confirm` must not do the same to `/orders/ConfirmOrder`.
 *
 * `auth` is deliberately in neither list. It names a DIRECTORY, not a surface,
 * and while it sat in the SESSION vocabulary every unrecognised file under
 * `auth/` was reported as a session — a wrong kind, which yields a wrongly
 * titled item with wrong steps. An auth-ish path this table cannot name now
 * yields no surface at all, which is the honest answer.
 */
const AUTH_VOCABULARY: Array<{
  kind: AuthSurfaceKind;
  strong: readonly string[];
  /**
   * A word that only means what this entry means when another word is present.
   * `token` is a session token beside `refresh`, and a push token beside
   * `notifications`; on its own it decides nothing.
   */
  qualified?: { word: string; by: readonly string[] };
  weak: readonly string[];
  /**
   * What the matched words name, as a bare noun phrase. Two callers word the
   * sentence around it differently — a URL names this, or a FILENAME does — and
   * a single pre-written `why` string meant the second one described the first.
   */
  names: string;
}> = [
  {
    kind: 'LOGOUT',
    strong: ['logout', 'signout'],
    weak: [],
    names: 'a sign-out',
  },
  {
    kind: 'SIGNUP',
    strong: ['signup', 'register', 'registration', 'createaccount'],
    weak: ['join'],
    names: 'an account creation',
  },
  {
    kind: 'PASSWORD_RESET',
    strong: ['password'],
    weak: ['forgot', 'reset'],
    names: 'a password flow',
  },
  {
    kind: 'VERIFY',
    strong: ['verify', 'verification', 'otp', 'mfa', '2fa', 'twofactor'],
    weak: ['confirm', 'activate'],
    names: 'a verification step',
  },
  {
    kind: 'SSO',
    strong: ['sso', 'saml', 'oidc', 'oauth', 'oauth2'],
    weak: ['callback'],
    names: 'a federated sign-in',
  },
  {
    kind: 'LOGIN',
    strong: ['login', 'signin', 'authenticate'],
    weak: [],
    names: 'a sign-in',
  },
  {
    /*
     * `session`, `sessions` and `refresh` are WEAK, and the demotion is the
     * whole point of this entry.
     *
     * As strong words they matched anywhere in a path, and `words` carries every
     * hyphen- and camel-split part — so a gym app's `/training-sessions`,
     * `/classes/:id/session-notes` and `/refresh-schedule` all came back as
     * authentication surfaces, each yielding a critical-path test titled "a
     * session outlives a reload" against a booking screen. A booking screen is
     * not a session surface. What the entry actually means is the endpoint a
     * session is created at or exchanged through — `/api/auth/session`,
     * `/auth/refresh`, `POST /sessions` — and in every one of those the word IS
     * the whole segment, which is exactly what `weak` requires.
     *
     * `token` is QUALIFIED rather than strong. It was strong on the argument
     * that "no ordinary noun in an application path is built out of it", and
     * that is not true of applications people actually write: a gym app with
     * mobile push has `/notifications/push-token`, and `device-token` and
     * `fcm-token` are just as common. None of them is a session surface, and
     * each would have produced a test titled "a session outlives a reload"
     * pointed at a notification endpoint.
     *
     * So `token` counts only next to a word that makes it an AUTH token —
     * `refresh-token`, `access-token`, `auth/token`. That keeps the shapes the
     * entry exists for and drops the ones it never meant. A parameter named
     * `:token` is skipped before this list is consulted, so an invite link does
     * not reach here either.
     */
    kind: 'SESSION',
    strong: [],
    qualified: { word: 'token', by: ['refresh', 'access', 'auth', 'session', 'bearer', 'id'] },
    weak: ['session', 'sessions', 'refresh'],
    names: 'a session or token exchange',
  },
];

function classifyAuthPath(path: string): { kind: AuthSurfaceKind; names: string } | null {
  const { words, segments } = authWords(path);
  for (const entry of AUTH_VOCABULARY) {
    // A qualified word counts only in the company of one that gives it the
    // meaning the entry is about — `token` alone is a push token as often as a
    // session one, and guessing wrong titles the test after the wrong thing.
    const qualified =
      entry.qualified !== undefined &&
      words.has(entry.qualified.word) &&
      entry.qualified.by.some((word) => words.has(word));
    const hit =
      entry.strong.some((word) => words.has(word)) ||
      qualified ||
      entry.weak.some((word) => segments.has(word));
    if (hit) return { kind: entry.kind, names: entry.names };
  }
  return null;
}

/**
 * The kinds a form with a password field can plausibly be.
 *
 * Used to decide whether a file NAME is allowed to overrule the field-shape
 * guess below. A file called `logout.tsx` holding a password field is a name
 * that does not describe the form, so the shape wins there.
 */
const CREDENTIAL_FORM_KINDS: ReadonlySet<AuthSurfaceKind> = new Set<AuthSurfaceKind>([
  'LOGIN',
  'SIGNUP',
  'PASSWORD_RESET',
]);

function detectAuthSurfaces(collector: Collector, ledger: Ledger): AuthSurface[] {
  const surfaces: AuthSurface[] = [];
  const seen = new Set<string>();

  const push = (surface: AuthSurface): void => {
    const key = `${surface.kind} ${surface.from} ${surface.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    surfaces.push(surface);
    ledger.hit('auth-surfaces');
  };

  for (const route of collector.routes) {
    ledger.examine('auth-surfaces');
    const hit = classifyAuthPath(route.route);
    if (hit) {
      push({
        kind: hit.kind,
        path: route.route,
        from: 'route',
        file: route.file,
        evidence: `${route.route} — the path names ${hit.names}`,
      });
    }
  }
  for (const endpoint of collector.endpoints) {
    ledger.examine('auth-surfaces');
    const hit = classifyAuthPath(endpoint.path);
    if (hit) {
      push({
        kind: hit.kind,
        path: endpoint.path,
        from: 'endpoint',
        file: endpoint.file,
        evidence: `${endpoint.method} ${endpoint.path} — the path names ${hit.names}`,
      });
    }
  }
  // A password field is the strongest signal there is that a form is a
  // credential form, and it does not depend on anyone naming the route sensibly.
  // WHICH credential form it is, though, is a guess — and a name beats a guess.
  for (const form of collector.forms) {
    ledger.examine('auth-surfaces');
    if (!form.fields.some((f) => f.semantic === 'password')) continue;

    // `ResetPassword.tsx` holds a password and a confirmation, which is the
    // shape of a sign-up and is not a sign-up. The shape rule below exists for
    // repositories that name nothing; where the file names itself, and names
    // something a password form can actually be, the name is the better answer.
    // Read off the FILE and not the action: an action of `/api/auth/session` is
    // where the sign-in form posts, not what the sign-in form is.
    const named = classifyAuthPath(form.file);
    if (named && CREDENTIAL_FORM_KINDS.has(named.kind)) {
      push({
        kind: named.kind,
        path: form.action ?? form.file,
        from: 'form',
        file: form.file,
        // Says what actually decided this, which is the FILENAME. The old
        // wording borrowed the vocabulary's own sentence — "the path names a
        // sign-in" — and the surface's path here is the form's `action`, which
        // for `LoginForm.tsx` is `/api/auth/session` and names no such thing.
        evidence:
          `${form.file} holds a form with a password field, and its filename names ` +
          `${named.names} — a name that specific beats the field shape, which cannot ` +
          `tell a password reset from a sign-up`,
      });
      continue;
    }

    const names = form.fields.map((f) => f.name.toLowerCase()).join(' ');
    const confirms = /confirm|repeat|verify/.test(names);
    const kind: AuthSurfaceKind = confirms ? 'SIGNUP' : 'LOGIN';
    push({
      kind,
      path: form.action ?? form.file,
      from: 'form',
      file: form.file,
      evidence: confirms
        ? `${form.file} holds a form with a password field and a confirmation field, which is the shape of a sign-up`
        : `${form.file} holds a form with a password field, which is the shape of a sign-in`,
    });
  }

  return surfaces;
}

// ─── Application frameworks ──────────────────────────────────────────────────

/**
 * Application frameworks, which detect.ts deliberately does not name — its
 * entire vocabulary is test runners, and a `next` dependency tells it nothing it
 * is looking for. Read straight off manifests and lockfile-adjacent markers.
 */
const FRAMEWORK_DEPS: Array<{ dep: RegExp; framework: string }> = [
  { dep: /^next$/, framework: 'Next.js' },
  { dep: /^nuxt$/, framework: 'Nuxt' },
  { dep: /^@sveltejs\/kit$/, framework: 'SvelteKit' },
  { dep: /^@remix-run\//, framework: 'Remix' },
  { dep: /^astro$/, framework: 'Astro' },
  { dep: /^react-router(-dom)?$/, framework: 'React Router' },
  { dep: /^vue-router$/, framework: 'Vue Router' },
  { dep: /^@angular\/core$/, framework: 'Angular' },
  { dep: /^express$/, framework: 'Express' },
  { dep: /^fastify$/, framework: 'Fastify' },
  { dep: /^koa$/, framework: 'Koa' },
  { dep: /^hono$/, framework: 'Hono' },
  { dep: /^@nestjs\/core$/, framework: 'NestJS' },
  { dep: /^django$/, framework: 'Django' },
  { dep: /^flask$/, framework: 'Flask' },
  { dep: /^fastapi$/, framework: 'FastAPI' },
  { dep: /^rails$/, framework: 'Ruby on Rails' },
  { dep: /^laravel\/framework$/, framework: 'Laravel' },
  { dep: /^spring-boot-starter-web$/, framework: 'Spring Boot' },
];

function detectFrameworks(files: AnalysedFile[]): AppFrameworkSignal[] {
  const out: AppFrameworkSignal[] = [];
  const seen = new Set<string>();

  const note = (framework: string, evidence: string, file: string | null): void => {
    if (seen.has(framework)) return;
    seen.add(framework);
    out.push({ framework, evidence, file });
  };

  for (const file of files) {
    const base = basename(file.path);

    // Framework config files name the framework outright and cost nothing to read.
    if (/^next\.config\.[cm]?[jt]s$/.test(base)) note('Next.js', `found ${file.path}`, file.path);
    if (/^nuxt\.config\.[cm]?[jt]s$/.test(base)) note('Nuxt', `found ${file.path}`, file.path);
    if (/^svelte\.config\.[cm]?[jt]s$/.test(base)) note('SvelteKit', `found ${file.path}`, file.path);
    if (/^astro\.config\.[cm]?[jt]s$/.test(base)) note('Astro', `found ${file.path}`, file.path);
    if (/^angular\.json$/.test(base)) note('Angular', `found ${file.path}`, file.path);
    if (/^manage\.py$/.test(base)) note('Django', `found ${file.path}`, file.path);
    if (/^artisan$/.test(base)) note('Laravel', `found ${file.path}`, file.path);
    if (/^config\/routes\.rb$/.test(file.path)) {
      note('Ruby on Rails', `found ${file.path}`, file.path);
    }

    if (file.content === undefined) continue;

    if (base === 'package.json') {
      try {
        const parsed: unknown = JSON.parse(file.content);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const pkg = parsed as Record<string, unknown>;
          for (const section of ['dependencies', 'devDependencies']) {
            const deps = pkg[section];
            if (!deps || typeof deps !== 'object') continue;
            for (const name of Object.keys(deps)) {
              const hit = FRAMEWORK_DEPS.find((entry) => entry.dep.test(name.toLowerCase()));
              if (hit) note(hit.framework, `${name} in ${section} (${file.path})`, file.path);
            }
          }
        }
      } catch {
        // A manifest we cannot parse is reported as a warning by the caller;
        // there is nothing to salvage here.
      }
      continue;
    }

    if (
      base === 'requirements.txt' ||
      base === 'pyproject.toml' ||
      base === 'Gemfile' ||
      base === 'composer.json' ||
      base === 'pom.xml' ||
      base === 'build.gradle' ||
      base === 'build.gradle.kts'
    ) {
      const lower = file.content.toLowerCase();
      for (const entry of FRAMEWORK_DEPS) {
        const bare = entry.dep.source.replace(/[$^\\]/g, '').replace(/\(.*\)\?/, '');
        if (!bare || bare.length < 4) continue;
        if (lower.includes(bare)) note(entry.framework, `${bare} named in ${file.path}`, file.path);
      }
    }
  }

  return out;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Analyse an application's source listing.
 *
 * Pure: no filesystem, no network, no model. `content` is optional per file, and
 * the result says exactly what that cost — the file-convention detectors work on
 * paths alone, everything else needs a body and reports when it did not get one.
 */
export function analyseCodebase(files: RepoFile[]): CodebaseAnalysis {
  const input = Array.isArray(files) ? files : [];
  const warnings: string[] = [];
  const notes: string[] = [];

  const analysed: AnalysedFile[] = [];
  const seen = new Set<string>();
  let ignored = 0;
  let truncatedFiles = 0;
  let overflowed = false;

  for (const file of input) {
    if (!file || typeof file.path !== 'string') continue;
    const path = normalisePath(file.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (isIgnoredPath(path) || TEST_PATH.test(path)) {
      ignored++;
      continue;
    }
    if (analysed.length >= MAX_FILES_ANALYSED) {
      overflowed = true;
      continue;
    }
    let content = typeof file.content === 'string' ? file.content : undefined;
    if (content !== undefined && content.length > MAX_FILE_CHARS) {
      content = content.slice(0, MAX_FILE_CHARS);
      truncatedFiles++;
    }
    analysed.push({ path, content, ext: extname(path) });
  }

  // Sorted, so the answer depends on the repo and never on the order the listing
  // happened to arrive in — the same guarantee detect.ts gives.
  analysed.sort((a, b) => a.path.localeCompare(b.path));

  const collector = new Collector();
  const ledger = new Ledger();

  // Which kind of app this is decides whether a file path may be read as a URL
  // at all. The signals are read once, here; the ANSWER is per file, because a
  // monorepo is many apps and they do not agree.
  const gates = routingVerdict(analysed);
  const declared: DeclaredRoutingReport = { unmountedTables: 0, computedPaths: 0 };

  detectNextAppRouter(analysed, collector, ledger, gates);
  detectPagesDirectory(analysed, collector, ledger, gates);
  detectSvelteKit(analysed, collector, ledger);
  detectReactRouter(analysed, collector, ledger, declared);
  detectVueRouter(analysed, collector, ledger, declared);
  const sawMountPrefix = detectExpressFastify(analysed, collector, ledger);
  const sawDjangoInclude = detectDjangoUrls(analysed, collector, ledger);
  detectRailsRoutes(analysed, collector, ledger);
  detectSpringMvc(analysed, collector, ledger);
  detectFlaskFastapi(analysed, collector, ledger);
  detectForms(analysed, collector, ledger);
  const authSurfaces = detectAuthSurfaces(collector, ledger);

  const frameworks = detectFrameworks(analysed);
  const withContent = analysed.filter((f) => f.content !== undefined).length;

  // ── Notes ───────────────────────────────────────────────────────────────────
  //
  // The first one is not optional and is not a disclaimer: it is the single most
  // important fact about everything above it.
  notes.push(
    'This is a STATIC read of the source. It reports what the code declares, not what the ' +
      'application does when it runs — a route registered behind a feature flag, a handler ' +
      'mounted under a prefix computed at boot, or a form rendered only for some roles is ' +
      'invisible here. Crawling a running environment is what establishes that.',
  );

  if (analysed.length === 0) {
    notes.push('No files were given, so there was nothing to analyse.');
  } else if (withContent === 0) {
    notes.push(
      'Only file paths were uploaded, with no contents. That is enough for the file-convention ' +
        'routers (Next.js, Nuxt, SvelteKit, Astro) and for nothing else: endpoints, forms and ' +
        'route declarations all live inside files.',
    );
  } else if (withContent < analysed.length) {
    notes.push(
      `${analysed.length - withContent} of ${analysed.length} files were uploaded as paths only. ` +
        'Any route, endpoint or form declared inside them was not read.',
    );
  }

  if (collector.routes.length === 0 && collector.endpoints.length === 0 && analysed.length > 0) {
    notes.push(
      'No routes or endpoints were found. Every detector below reports what it examined — if they ' +
        'all show 0 files examined, this app uses a framework QAAI cannot yet read statically, and ' +
        'the crawl is the way in.',
    );
  }

  if (sawMountPrefix) {
    notes.push(
      "This app mounts routers under a prefix (app.use('/api', router)). Endpoint paths are " +
        'reported exactly as each file declares them, WITHOUT that prefix applied — resolving it ' +
        'needs an import graph, which a static pass over a file listing does not have. The real ' +
        'URLs are the declared paths with one or more mount prefixes in front.',
    );
  }
  if (sawDjangoInclude) {
    notes.push(
      'A Django URLconf uses include(), which nests another urls.py under a prefix. Paths from the ' +
        'included module are listed as that module declares them, without the parent prefix.',
    );
  }
  if (declared.unmountedTables > 0) {
    notes.push(
      `${declared.unmountedTables} route table${declared.unmountedTables === 1 ? '' : 's'} in this ` +
        `app declare${declared.unmountedTables === 1 ? 's' : ''} only relative paths, which means ` +
        'the whole table hangs off a parent route ' +
        'somewhere else — a descendant <Routes> rendered by a component that is itself mounted at ' +
        'a URL. Which URL that is takes an import graph this static pass does not have, so those ' +
        'declarations are NOT listed above: a guessed prefix would send every test to a 404.',
    );
  }
  if (declared.computedPaths > 0) {
    notes.push(
      `${declared.computedPaths} route path${declared.computedPaths === 1 ? ' was' : 's were'} ` +
        'written as an expression rather than a literal string, so the URL it resolves to is ' +
        'decided at runtime and was not read.',
    );
  }

  // A refusal is a finding. If a detector found its files and deliberately
  // claimed nothing from them, the reason belongs in the summary a user reads,
  // not only in the detector table further down the page.
  for (const id of ['pages-directory', 'next-app-router'] as const) {
    const refusal = ledger.refusalFor(id);
    if (refusal) notes.push(`${DETECTOR_META[id].label}: ${refusal}.`);
  }

  const unknownMethods = collector.endpoints.filter((e) => e.method === 'UNKNOWN').length;
  if (unknownMethods > 0) {
    notes.push(
      `${unknownMethods} endpoint${unknownMethods === 1 ? '' : 's'} answered at a path this pass ` +
        'could read while the HTTP methods stayed unreadable. They are listed as UNKNOWN rather ' +
        'than assumed to be GET.',
    );
  }

  if (ignored > 0) {
    notes.push(
      `${ignored} path${ignored === 1 ? ' was' : 's were'} skipped as vendored, generated, or test ` +
        'code. Test files are skipped deliberately: a spec declares no route the application serves.',
    );
  }

  // ── Warnings ────────────────────────────────────────────────────────────────
  if (overflowed) {
    warnings.push(
      `More than ${MAX_FILES_ANALYSED} files were uploaded; the rest were not analysed. Send the ` +
        'application source without vendored directories, or ingest one workspace at a time.',
    );
  }
  if (truncatedFiles > 0) {
    warnings.push(
      `${truncatedFiles} file${truncatedFiles === 1 ? ' was' : 's were'} longer than ${MAX_FILE_CHARS} ` +
        'characters and were read only up to that point. Anything declared past it was not seen.',
    );
  }
  if (collector.truncated) {
    warnings.push(
      'A result list hit its cap, so this analysis is a prefix of what the repo declares, not the ' +
        'whole of it.',
    );
  }

  return {
    routes: collector.routes,
    endpoints: collector.endpoints,
    forms: collector.forms,
    authSurfaces,
    frameworks,
    detectors: ledger.report(),
    coverage: {
      filesGiven: input.length,
      filesAnalysed: analysed.length,
      filesWithContent: withContent,
      filesIgnored: ignored,
      filesTruncated: truncatedFiles,
      truncated: collector.truncated || overflowed,
    },
    notes,
    warnings,
  };
}

/**
 * A one-paragraph, honest summary of an analysis, for the API response and the
 * UI header. Kept here rather than in the route so the sentence a user reads is
 * generated from the same data the assertions are written against.
 */
export function summariseAnalysis(analysis: CodebaseAnalysis): string {
  const ran = analysis.detectors.filter((d) => d.filesExamined > 0);
  const contributed = ran.filter((d) => d.found > 0);
  const idle = analysis.detectors.filter((d) => d.filesExamined === 0);

  const parts: string[] = [];
  parts.push(
    `Read ${analysis.coverage.filesAnalysed} file${analysis.coverage.filesAnalysed === 1 ? '' : 's'} ` +
      `(${analysis.coverage.filesWithContent} with contents) and found ` +
      `${analysis.routes.length} page route${analysis.routes.length === 1 ? '' : 's'}, ` +
      `${analysis.endpoints.length} endpoint${analysis.endpoints.length === 1 ? '' : 's'}, ` +
      `${analysis.forms.length} form${analysis.forms.length === 1 ? '' : 's'} and ` +
      `${analysis.authSurfaces.length} auth surface${analysis.authSurfaces.length === 1 ? '' : 's'}.`,
  );
  parts.push(
    `${contributed.length} of ${analysis.detectors.length} detectors found something; ` +
      `${ran.length - contributed.length} examined files and found nothing; ` +
      `${idle.length} had no files of their kind to look at.`,
  );
  parts.push(
    'All of it is static: this is what the source declares, not what the running application does.',
  );
  return parts.join(' ');
}
