/**
 * Test impact analysis — run only the tests a change can affect.
 *
 * The whole design turns on one asymmetry. Running a test that could not
 * possibly have broken costs a minute of CI. NOT running the test that would
 * have caught the bug costs a production incident — and, worse, it costs the
 * user's belief in every green check this product has ever shown them. The two
 * mistakes are not comparable, so nothing in here is allowed to trade them off
 * as if they were.
 *
 * The rule that falls out of that: a test is skipped only when the analysis can
 * argue its way there. Every path in the diff must be attributed to something we
 * recognise — a route, a feature, a name — before ANY test is parked. One file
 * we cannot explain (a lockfile, a shared util, a config) and the answer is the
 * whole suite. "I don't know" resolves to run, never to skip.
 *
 * Confidence is graded rather than boolean because the evidence is graded.
 * Knowing that `app/checkout/page.tsx` serves `/checkout` is a fact about a
 * framework's file conventions; guessing that `components/CheckoutSummary.tsx`
 * relates to checkout is pattern-matching on a filename. Both are useful, but
 * only the first is ever allowed to park a CRITICAL_PATH test.
 *
 * The honest limitation, stated once here rather than apologised for later: this
 * never sees the customer's source, only the paths in their diff. There is no
 * import graph, so "which pages render this component" is unknowable. That is
 * precisely why the fallbacks below are as blunt as they are.
 */

import type { Priority } from '@qaai/shared';

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

/**
 * RUN_EVERYTHING  the diff was not fully explainable; the suite is the answer.
 * SELECTIVE       every path was attributed; per-test decisions apply.
 * SMOKE_FLOOR     nothing in the diff can touch the app (docs, licence). The
 *                 critical-path tests still run — see the floor rule below.
 */
export type ImpactStrategy = 'RUN_EVERYTHING' | 'SELECTIVE' | 'SMOKE_FLOOR';

const CONFIDENCE_RANK: Record<Confidence, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

/**
 * How well the WHOLE diff must be understood before a test of this priority may
 * be skipped. Read it as: a critical-path test is parked only when every changed
 * file mapped to a route by framework convention. An important test tolerates a
 * filename-derived route. A nice-to-have test tolerates a bare name match.
 *
 * Priority is the lever because it is the user's own statement of what a missed
 * regression would cost them.
 */
const MIN_CONFIDENCE_TO_SKIP: Record<Priority, Confidence> = {
  CRITICAL_PATH: 'HIGH',
  IMPORTANT: 'MEDIUM',
  NICE_TO_HAVE: 'LOW',
};

/**
 * Past this many changed files the diff is a refactor, a merge, or a generated
 * commit — the kind of change that touches everything. Attributing 1000+ paths
 * is also the obvious way to turn this endpoint into a CPU sink, and both
 * problems have the same correct answer.
 */
export const MAX_CHANGED_PATHS = 1000;

/** Regex scanning is linear, but a pathological `code` blob should not be free. */
const MAX_CODE_CHARS = 400_000;

/** Caps on what one test may contribute, so a generated spec cannot dominate. */
const MAX_ROUTES_PER_TEST = 200;

/** How far into a `spec` blob the route walk goes before it gives up. */
const MAX_SPEC_DEPTH = 6;

// ─── Inputs and outputs ──────────────────────────────────────────────────────

export interface ImpactTestInput {
  id: string;
  name: string;
  filePath: string;
  /** Playwright source. Spec-driven types (API, a11y, security) leave this inert. */
  code: string | null;
  /** Type-specific config; routes live in here for the spec-driven test types. */
  spec: unknown;
  tags: string[];
  feature: string | null;
  priority: Priority;
}

export interface ImpactInput {
  changedPaths: string[];
  tests: ImpactTestInput[];
  /** Serialised FlowMap of the latest crawl, or null when the app was never crawled. */
  flowMapGraph?: unknown;
}

/** A route the analysis believes a file serves. */
export interface RouteRef {
  route: string;
  /** True for layouts/templates: the change lands on everything BELOW this route. */
  subtree: boolean;
}

export interface PathAttribution {
  path: string;
  /** What kind of file we decided this is — the heuristic's own label. */
  kind:
    | 'test-file'
    | 'test-support'
    | 'framework-page'
    | 'framework-layout'
    | 'server-route'
    | 'named-source'
    | 'global'
    | 'documentation'
    | 'unattributable';
  routes: RouteRef[];
  tokens: string[];
  confidence: Confidence;
  /** Plain-English statement of what we concluded, shown to the caller. */
  why: string;
  /** True when this file alone forces the whole suite. */
  blastRadius: boolean;
  /** True when the file cannot affect the running app at all. */
  ignored: boolean;
}

export interface TestDecision {
  testId: string;
  name: string;
  filePath: string;
  priority: Priority;
  feature: string | null;
  decision: 'run' | 'skip';
  /** One sentence, per test. The point of the feature is that this is readable. */
  reason: string;
  confidence: Confidence;
  /** Machine-readable version of the reason: 'route:/checkout', 'feature:Checkout'. */
  signals: string[];
  /** The changed paths that implicated this test, if any. */
  matchedPaths: string[];
}

export interface ImpactAnalysis {
  strategy: ImpactStrategy;
  /** Why the whole suite / a selection / the floor was chosen. */
  reason: string;
  /** Confidence in the diff as a whole — the weakest link across changed paths. */
  confidence: Confidence;
  savedPercent: number;
  run: TestDecision[];
  skip: TestDecision[];
  /** Ready to POST as `testIds` to /runs — no other endpoint has to change. */
  testIds: string[];
  attributions: PathAttribution[];
  totals: { tests: number; run: number; skip: number; changedPaths: number };
}

// ─── Path and route normalisation ────────────────────────────────────────────

/** Repo-relative, forward slashes, no leading `./` or `/`. */
export function normalizePath(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
}

function isDynamicSegment(segment: string): boolean {
  return segment === ':param' || segment === '*';
}

/**
 * Collapse every framework's dynamic-segment spelling onto one: `:param`.
 * `[id]`, `{id}`, `:id`, `$id` and `[...slug]` all mean "anything here", and
 * comparing them literally is how a test for `/orders/123` gets mistaken for
 * unrelated to a change in `/orders/[id]`.
 */
export function normalizeRoute(raw: string): string {
  const withoutQuery = raw.split('?')[0]!.split('#')[0]!;
  const segments = withoutQuery
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const s = segment.trim().toLowerCase();
      if (!s) return '';
      if (/^\[\[?\.\.\..+\]\]?$/.test(s) || s === '*' || s === '**') return '*';
      if (/^\[.+\]$/.test(s) || /^\{.+\}$/.test(s) || /^[:$].+/.test(s)) return ':param';
      return s;
    })
    .filter(Boolean);

  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function routeSegments(route: string): string[] {
  return route.split('/').filter(Boolean);
}

/**
 * Do a source file's route and a test's route plausibly refer to the same part
 * of the app?
 *
 * Deliberately generous in both directions: a change to `/checkout` is treated
 * as touching `/checkout/success`, and a test that visits `/checkout/success` is
 * treated as touching `/checkout`. Over-matching costs a test run; under-matching
 * costs a missed regression.
 *
 * The one place it is strict is the root. Half the suite starts with
 * `page.goto('/')`, so letting `/` overlap everything would make the whole
 * heuristic a no-op. A root layout still reaches everything — that is what
 * `subtree` is for.
 */
export function routesOverlap(source: RouteRef, testRoute: string): boolean {
  const a = routeSegments(source.route);
  const b = routeSegments(testRoute);

  if (a.length === 0 || b.length === 0) return source.subtree || (a.length === 0 && b.length === 0);

  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left === right) continue;
    if (isDynamicSegment(left) || isDynamicSegment(right)) continue;
    return false;
  }
  return true;
}

// ─── Tokenisation ────────────────────────────────────────────────────────────

/**
 * Words that appear in every repo and therefore distinguish nothing. Being too
 * aggressive here loses savings; being too lax runs extra tests. Only one of
 * those is a correctness problem, which is why the list is short.
 */
const STOP_TOKENS = new Set([
  'src',
  'app',
  'apps',
  'lib',
  'libs',
  'packages',
  'components',
  'component',
  'pages',
  'page',
  'routes',
  'route',
  'views',
  'view',
  'screens',
  'containers',
  'features',
  'feature',
  'modules',
  'module',
  'index',
  'main',
  'test',
  'tests',
  'spec',
  'specs',
  'styles',
  'style',
  'utils',
  'helpers',
  'hooks',
  'types',
  'api',
  'server',
  'client',
  'web',
  'www',
  'public',
  'static',
  'assets',
  'common',
  'shared',
  'core',
  'dist',
  'build',
  'node',
  'the',
  'and',
  'with',
  'for',
  'from',
  'that',
  'this',
  'when',
  'then',
  'into',
  'has',
  'have',
  'are',
  'was',
  'its',
  'not',
]);

const SOURCE_SUFFIX = /\.(spec|test|stories|module|styles?|component|controller|handler|service)$/;

/**
 * Lowercased word tokens, camelCase split, plural folded onto singular. Both
 * forms are kept — `orders` in a path should match a feature called `Order`, and
 * dropping one of them silently loses that match.
 */
export function tokenize(value: string): string[] {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);

  const out = new Set<string>();
  for (const word of words) {
    if (word.length < 3) continue;
    if (/^\d+$/.test(word)) continue;
    if (STOP_TOKENS.has(word)) continue;
    out.add(word);
    // `orders` → `order`, but not `success` → `succes`.
    if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) out.add(word.slice(0, -1));
  }
  return [...out];
}

function tokensForPath(path: string): string[] {
  const segments = path.split('/');
  const file = segments.pop() ?? '';
  const stem = file.replace(/\.[^./]+$/, '').replace(SOURCE_SUFFIX, '');
  return tokenize([...segments, stem].join(' '));
}

// ─── What a changed file tells us ────────────────────────────────────────────

interface PathFacts {
  path: string;
  kind: PathAttribution['kind'];
  routes: RouteRef[];
  tokens: string[];
  why: string;
  blastRadius: boolean;
  ignored: boolean;
  /** Confidence before the suite index gets a say (name matches need it). */
  baseConfidence: Confidence;
}

/**
 * Files whose effect cannot be expressed as a route: build config, dependencies,
 * environment, the data layer, the app shell. A dependency bump can change
 * anything on any page, so the only defensible reading of a lockfile diff is
 * "the entire application".
 */
const GLOBAL_PATTERNS: Array<{ re: RegExp; why: string }> = [
  {
    re: /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json)$/,
    why: 'a dependency manifest or lockfile — a version bump can change any page',
  },
  {
    re: /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|Gemfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock)|composer\.(json|lock)|pom\.xml|build\.gradle[^/]*)$/,
    why: 'a dependency manifest or lockfile — a version bump can change any page',
  },
  {
    re: /(^|\/)[^/]*\.config\.(m|c)?(j|t)sx?$/,
    why: 'a build or framework config, which applies to the whole app',
  },
  {
    re: /(^|\/)(tsconfig[^/]*\.json|jsconfig\.json|\.babelrc[^/]*|babel\.config\.[^/]+|\.swcrc|\.eslintrc[^/]*|eslint\.config\.[^/]+)$/,
    why: 'a compiler or lint config, which applies to the whole app',
  },
  {
    re: /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|Procfile|Makefile|turbo\.json|nx\.json|lerna\.json|vercel\.json|netlify\.toml|fly\.toml|serverless\.ya?ml)$/,
    why: 'build or deployment configuration',
  },
  { re: /(^|\/)\.github\/workflows\//, why: 'CI configuration' },
  { re: /(^|\/)(\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|\.circleci\/)/, why: 'CI configuration' },
  { re: /(^|\/)\.env([^/]*)$/, why: 'environment configuration, which every request reads' },
  {
    re: /(^|\/)(schema\.prisma|schema\.rb|structure\.sql)$/,
    why: 'the database schema — every feature reads from it',
  },
  { re: /(^|\/)migrations?\//, why: 'a database migration — every feature reads from it' },
  {
    re: /(^|\/)(src\/)?(app|pages)\/(_app|_document|_error|layout|global-error)\.(m|c)?(j|t)sx?$/,
    why: 'the application shell, which wraps every route',
  },
  {
    re: /(^|\/)(src\/)?middleware\.(m|c)?(j|t)sx?$/,
    why: 'request middleware, which runs on every route',
  },
  /*
   * API route handlers reach further than their own URL.
   *
   * The framework conventions below would otherwise file `app/api/orders/route.ts`
   * as "the /api/orders page" with HIGH confidence — and that is true but
   * useless: the file layout proves which URL SERVES the handler, and says
   * nothing about which pages CALL it. A checkout test navigating /checkout
   * does not overlap /api/orders, so breaking order creation skipped the
   * critical-path checkout test. That is the archetypal change that breaks
   * checkout without touching a checkout file, and it was the one unbounded
   * file kind that still earned HIGH confidence.
   *
   * Listed here, ahead of frameworkRoutes(), so an API handler forces the
   * suite the way middleware and auth already do.
   */
  {
    re: /(^|\/)(src\/)?(app|pages)\/api\//,
    why: 'an API route handler — any page may call it, and the file layout does not say which',
  },
  {
    re: /(^|\/)api\/[^/]*\/?route\.(m|c)?(j|t)sx?$/,
    why: 'an API route handler — any page may call it, and the file layout does not say which',
  },
  {
    re: /(^|\/)(globals?\.css|global\.s[ac]ss|reset\.css|tokens?\.(css|s[ac]ss|ts|js|json)|theme\.(css|s[ac]ss|ts|js)|variables\.s[ac]ss)$/,
    why: 'global styling, which every page inherits',
  },
  {
    re: /(^|\/)(i18n|locales?|translations?)\//,
    why: 'localisation, which every rendered string depends on',
  },
  {
    re: /(^|\/)(service-worker|sw)\.(m|c)?(j|t)s$/,
    why: 'a service worker, which intercepts every request',
  },
  {
    re: /(^|\/)(auth|authn|authz|session|sessions|permissions?|rbac|acl|guards?)\//,
    why: 'the authentication or authorisation layer, which every signed-in test traverses',
  },
  {
    re: /(^|\/)(auth|authn|authz|session|permissions?|rbac|acl)\.(m|c)?(j|t)sx?$/,
    why: 'the authentication or authorisation layer, which every signed-in test traverses',
  },
];

/**
 * Routes that every authenticated test passes through on its way in. A change
 * here is a route change on paper and a suite-wide change in practice.
 */
const AUTH_ROUTE = /^\/(login|signin|sign-in|signup|sign-up|register|auth|logout|sso|session)(\/|$)/;

/**
 * Files that cannot alter the running application. Scoped narrowly on purpose:
 * markdown under `src/`, `content/`, `posts/` or `blog/` IS the product for a
 * content-driven site, so it is deliberately absent from this list. Even for
 * what remains, "ignorable" does not mean "run nothing" — see the smoke floor.
 *
 * This is a syntactic pre-filter, not the verdict. `docs/` is repo metadata on
 * most projects and the routed product on a Docusaurus, Nextra, VitePress or
 * Starlight site, and the path alone cannot tell those apart. The verdict is
 * reached in attribute(), which reverses this whenever the suite is actually
 * standing on the route the file serves — see contentCandidateRoutes().
 */
function isIgnorable(path: string): boolean {
  if (/^(docs?|\.github\/(ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE))\//i.test(path)) return true;
  if (
    /^(readme|license|licence|changelog|contributing|code_of_conduct|codeowners|authors|notice|security)(\.[a-z]+)?$/i.test(
      path,
    )
  ) {
    return true;
  }
  if (/^\.(gitignore|gitattributes|editorconfig|prettierrc[^/]*|nvmrc)$/i.test(path)) return true;
  if (/(^|\/)\.prettierrc[^/]*$/i.test(path)) return true;
  return /\.(md|markdown|txt)$/i.test(path) && !/(^|\/)(src|app|pages|content|posts|blog)\//.test(path);
}

/** A spec file: test code, which by definition ships nothing to the application. */
const SPEC_FILE = /\.(spec|test|cy|e2e)\.(m|c)?(j|t)sx?$/;

/** Directories that hold test code and the helpers it imports. */
const TEST_DIR = /(^|\/)(tests?|e2e|cypress|playwright|__tests__|__specs__)\//;

/** Next.js App Router segment → URL segment, or null when it contributes none. */
function appRouterSegment(segment: string): string | null {
  if (/^\(.*\)$/.test(segment)) return null; // route group: organisational only
  if (segment.startsWith('@')) return null; // parallel-route slot
  if (segment.startsWith('_')) return null; // private folder
  return segment;
}

function routeFromSegments(segments: string[], convert: (s: string) => string | null): string {
  const kept: string[] = [];
  for (const segment of segments) {
    const converted = convert(segment);
    if (converted) kept.push(converted);
  }
  return normalizeRoute(`/${kept.join('/')}`);
}

const PAGE_EXT = /\.(m|c)?(j|t)sx?$|\.(vue|svelte|astro|mdx)$/;

/** Basenames that own a route (App Router) versus wrap a subtree. */
const APP_LEAF_FILES = new Set(['page', 'route']);
const APP_SUBTREE_FILES = new Set(['layout', 'template', 'default', 'error', 'loading', 'not-found']);

function frameworkRoutes(path: string): { routes: RouteRef[]; why: string; subtree: boolean } | null {
  // Next.js App Router / Nuxt 3 `app/` conventions.
  const appMatch = /(?:^|\/)(?:src\/)?app\/(.+)$/.exec(path);
  if (appMatch) {
    const parts = appMatch[1]!.split('/');
    const file = parts.pop()!;
    if (PAGE_EXT.test(file)) {
      const base = file.replace(PAGE_EXT, '');
      if (APP_LEAF_FILES.has(base) || APP_SUBTREE_FILES.has(base)) {
        const subtree = APP_SUBTREE_FILES.has(base);
        return {
          routes: [{ route: routeFromSegments(parts, appRouterSegment), subtree }],
          why: subtree
            ? `an App Router ${base}, which wraps every route beneath it`
            : 'an App Router page/handler, which serves exactly this route',
          subtree,
        };
      }
    }
  }

  // Next.js Pages Router, Nuxt 2, Astro, Vue Router file conventions.
  const pagesMatch = /(?:^|\/)(?:src\/)?pages\/(.+)$/.exec(path);
  if (pagesMatch && PAGE_EXT.test(pagesMatch[1]!)) {
    const parts = pagesMatch[1]!.replace(PAGE_EXT, '').split('/');
    if (parts[parts.length - 1] === 'index') parts.pop();
    return {
      routes: [{ route: routeFromSegments(parts, (s) => s), subtree: false }],
      why: 'a pages-directory file, which serves exactly this route',
      subtree: false,
    };
  }

  // SvelteKit: src/routes/**/+page.svelte, +server.ts, +layout.svelte
  const svelteMatch = /(?:^|\/)src\/routes\/(.*)\+(page|server|layout)[^/]*$/.exec(path);
  if (svelteMatch) {
    const parts = svelteMatch[1]!.split('/').filter(Boolean);
    const subtree = svelteMatch[2] === 'layout';
    return {
      routes: [{ route: routeFromSegments(parts, appRouterSegment), subtree }],
      why: subtree
        ? 'a SvelteKit layout, which wraps every route beneath it'
        : 'a SvelteKit route file, which serves exactly this route',
      subtree,
    };
  }

  return null;
}

/**
 * An API route handler: `app/api/**`, `pages/api/**`, or a `route.ts` sitting
 * under an `api` segment.
 *
 * These are the one place where the file layout actively misleads. For a page,
 * "which URL serves this file" and "which URL breaks if I change it" are the
 * same question. For an endpoint they are not related at all: the layout proves
 * only that the handler answers at `/api/orders`, and says nothing about the
 * checkout page, the admin panel and the mobile client that all call it. There
 * is no import graph here to ask, so the consumer set is unbounded — the same
 * situation as middleware or the auth layer, and it gets the same answer.
 *
 * Deliberately narrow: it catches exactly the paths that would otherwise be
 * handed HIGH confidence by frameworkRoutes(). A handler under a plain `api/`
 * directory is read by handlerRoutes() at MEDIUM, which already cannot park a
 * CRITICAL_PATH test.
 */
function isApiHandlerPath(path: string): boolean {
  const segments = path.split('/');
  const file = (segments.pop() ?? '').toLowerCase();
  const dirs = segments.map((s) => s.toLowerCase());

  const apiIndex = dirs.indexOf('api');
  if (apiIndex === -1) return false;

  // `app/api/…` and `pages/api/…` — the framework's own API surface.
  const parent = apiIndex > 0 ? dirs[apiIndex - 1] : '';
  if (parent === 'app' || parent === 'pages') return true;

  // A `route.ts` anywhere below an `api` segment: route groups, versioned
  // folders and monorepo prefixes all put arbitrary directories in between.
  return /^route\.(m|c)?(j|t)sx?$/.test(file);
}

/**
 * Directories that hold request handlers in every server framework worth naming.
 * The route is read off the filename rather than the framework's own table, so
 * this is a guess — an educated one, but MEDIUM is as high as it gets.
 */
const HANDLER_DIRS = new Set([
  'routes',
  'controllers',
  'handlers',
  'endpoints',
  'resources',
  'views',
  'api',
]);

const HANDLER_SUFFIX = /[._-]?(controller|handler|router|route|view|resource|endpoint)$/i;

function handlerRoutes(path: string): { routes: RouteRef[]; why: string } | null {
  const segments = path.split('/');
  const dirIndex = segments.findIndex((s) => HANDLER_DIRS.has(s.toLowerCase()));
  if (dirIndex === -1 || dirIndex === segments.length - 1) return null;

  const rest = segments.slice(dirIndex + 1);
  const file = rest.pop()!;
  const stem = file.replace(/\.[^./]+$/, '').replace(HANDLER_SUFFIX, '');
  if (!stem || stem.startsWith('_')) return null;

  // Remix flattens nesting into dots: `checkout.success.tsx` → /checkout/success.
  const stemSegments = stem.split('.').filter((s) => s && s !== 'index');
  const route = routeFromSegments([...rest, ...stemSegments], appRouterSegment);
  if (route === '/') return null;

  return {
    routes: [{ route, subtree: false }],
    why: 'a request handler whose filename names the route it serves',
  };
}

/** Everything a changed file says about itself, before the suite is consulted. */
export function derivePathFacts(rawPath: string): PathFacts {
  const path = normalizePath(rawPath);
  const tokens = tokensForPath(path);

  /** A file whose reach cannot be bounded: it alone forces the whole suite. */
  const unbounded = (
    why: string,
    routes: RouteRef[] = [],
    kind: PathFacts['kind'] = 'global',
  ): PathFacts => ({
    path,
    kind,
    routes,
    tokens,
    why,
    blastRadius: true,
    ignored: false,
    baseConfidence: 'NONE',
  });

  const bounded = (
    kind: PathFacts['kind'],
    baseConfidence: Confidence,
    why: string,
    routes: RouteRef[] = [],
  ): PathFacts => ({ path, kind, routes, tokens, why, blastRadius: false, ignored: false, baseConfidence });

  if (isIgnorable(path)) {
    return {
      ...bounded(
        'documentation',
        'HIGH',
        'documentation or repo metadata — it cannot change the running app',
      ),
      ignored: true,
    };
  }

  /*
   * Checked ahead of the global patterns because a spec file is test code, not
   * product code: `e2e/auth/login.spec.ts` must not be read as a change to the
   * authentication layer. Which test it is gets resolved against the suite in
   * attribute() — here we only know it ships nothing to the application.
   */
  if (SPEC_FILE.test(path)) {
    return bounded(
      'test-file',
      'HIGH',
      'a spec file — test code, which cannot change the application under test',
    );
  }

  for (const { re, why } of GLOBAL_PATTERNS) {
    if (re.test(path)) return unbounded(why);
  }

  /*
   * Not a spec but inside a test tree: a fixture, a page object, a login helper.
   * Any spec in the suite may import it, and we cannot see which do — so this is
   * a change to the tests themselves, of unknown extent.
   */
  if (TEST_DIR.test(path)) {
    return unbounded('test support code that any spec in the suite may import', [], 'test-support');
  }

  const authSurface = (route: string) =>
    `${route} is an authentication surface — every signed-in test passes through it`;

  /*
   * Checked ahead of the framework conventions, which would otherwise read an
   * endpoint as "the page at /api/orders" and hand it HIGH confidence. The file
   * layout only says which URL SERVES this handler; nothing in the diff says
   * which pages CALL it. Breaking order creation is the textbook way to break
   * checkout without touching a checkout file, so the reach is unbounded.
   */
  if (isApiHandlerPath(path)) {
    return unbounded(
      'an API route handler — its path says which URL serves it, never which pages call it, so every test could be downstream of it',
      frameworkRoutes(path)?.routes ?? [],
    );
  }

  const framework = frameworkRoutes(path);
  if (framework) {
    const first = framework.routes[0]!;

    // A root layout wraps the entire application; calling that "the / route"
    // would let it be matched away against tests that never visit /.
    if (first.subtree && first.route === '/') {
      return unbounded('the root layout, which wraps every route in the app');
    }
    if (AUTH_ROUTE.test(first.route)) return unbounded(authSurface(first.route), framework.routes);

    // A framework's file layout IS the routing table, so this is knowledge, not
    // inference — the only signal strong enough to park a critical-path test.
    return bounded(
      framework.subtree ? 'framework-layout' : 'framework-page',
      'HIGH',
      framework.why,
      framework.routes,
    );
  }

  const handler = handlerRoutes(path);
  if (handler) {
    const first = handler.routes[0]!;
    if (AUTH_ROUTE.test(first.route)) return unbounded(authSurface(first.route), handler.routes);
    return bounded('server-route', 'MEDIUM', handler.why, handler.routes);
  }

  // Resolved against the suite in attribute(): a name that matches nothing we
  // test told us nothing at all.
  return bounded(
    'named-source',
    'LOW',
    'source with no route convention — only its name is a signal',
  );
}

/** What the suite knows, so a path's claims can be checked against reality. */
interface SuiteContext {
  tokens: Set<string>;
  /** Every route any test or the flow map has ever mentioned. */
  routes: string[];
  /** True when this exact path is a test row we hold. */
  ownsTestFile: (path: string) => boolean;
}

/**
 * Kinds whose route was read off the SHAPE of the path rather than off a routing
 * table. Every one of them has to be corroborated before it is believed — see
 * the demotion in attribute().
 */
const SHAPE_DERIVED_KINDS = new Set<PathAttribution['kind']>([
  'server-route',
  'framework-page',
  'framework-layout',
]);

/**
 * Has the app ever actually been seen at this route?
 *
 * `routesOverlap` is deliberately generous, and at one segment deep that
 * generosity swallows whole subtrees — `/api` would corroborate itself against
 * any suite that ever calls `/api/orders`. So a one-segment claim has to be met
 * exactly; anything deeper is specific enough for the normal prefix rule.
 */
function suiteHasSeen(source: RouteRef, suite: SuiteContext): boolean {
  const depth = routeSegments(source.route).length;
  if (depth <= 1) return suite.routes.some((known) => known === source.route);
  return suite.routes.some((known) => routesOverlap(source, known));
}

/**
 * The routes an ostensibly-inert file would serve if this is one of the projects
 * where it is not inert at all: `docs/getting-started.md` is a page on every
 * docs-site generator, and `public/robots.txt` is served verbatim at the web
 * root. Both are spelled exactly like the repo metadata isIgnorable() exists to
 * discard, so the only honest way to separate them is to ask whether the suite
 * is standing on the route.
 */
function contentCandidateRoutes(path: string): RouteRef[] {
  const segments = path.split('/').filter(Boolean);
  const out = new Set<string>();

  const add = (parts: string[]): void => {
    if (parts.length === 0) return;
    const route = normalizeRoute(`/${parts.join('/')}`);
    if (route !== '/') out.add(route);
  };

  // Both the path as written and the path minus its first segment, because a
  // generator's content root (`docs/`, `public/`, `content/`) may or may not
  // appear in the URL, and we do not get to see its config.
  for (const parts of [segments, segments.slice(1)]) {
    if (parts.length === 0) continue;
    add(parts); // served verbatim: public/robots.txt → /robots.txt
    const head = parts.slice(0, -1);
    const stem = parts[parts.length - 1]!.replace(/\.[^./]+$/, '');
    // index/README serve their directory, not a child of it.
    if (/^(index|readme)$/i.test(stem)) add(head);
    else add([...head, stem]); // docs/getting-started.md → /docs/getting-started
  }

  return [...out].map((route) => ({ route, subtree: false }));
}

/**
 * Second pass: a claim is only a signal if the suite can corroborate it. A
 * change to `lib/money.ts` in a suite that never says "money" is a file we
 * cannot place at all, and an unplaceable file means the whole suite.
 */
function attribute(facts: PathFacts, suite: SuiteContext): PathAttribution {
  const base: Omit<PathAttribution, 'confidence' | 'kind' | 'why' | 'blastRadius'> = {
    path: facts.path,
    routes: facts.routes,
    tokens: facts.tokens,
    ignored: facts.ignored,
  };

  /*
   * A spec file implicates exactly one test: its own. Routes and name tokens are
   * dropped rather than matched, because "this spec mentions /cart" says nothing
   * about whether the OTHER cart tests can still pass — editing a test cannot
   * break its neighbours. Helpers, which can, were separated out as
   * `test-support` before this point.
   */
  if (facts.kind === 'test-file') {
    return {
      ...base,
      routes: [],
      tokens: [],
      kind: 'test-file',
      confidence: 'HIGH',
      why: suite.ownsTestFile(facts.path)
        ? 'this test file itself changed, so it runs and nothing else follows from it'
        : 'a spec file with no matching test in this project — it cannot affect the tests we hold',
      blastRadius: false,
    };
  }

  /*
   * The file said it was documentation. Before that is believed, ask the one
   * question the path cannot answer: is the suite standing on the route this
   * file would serve? A Docusaurus repo's `docs/getting-started.md` IS the page
   * a test asserts on, and `public/robots.txt` IS what an SEO test fetches;
   * calling either of them inert sends the whole diff to the smoke floor and
   * parks the very test that would have caught the breakage.
   *
   * Corroborated content comes back as LOW, not as a page. We know the suite has
   * been at that URL; we do not know this generator publishes the file there, so
   * the match is good enough to make tests run and nowhere near good enough to
   * park an IMPORTANT one.
   */
  if (facts.ignored) {
    const covered = contentCandidateRoutes(facts.path).filter((source) =>
      suiteHasSeen(source, suite),
    );
    if (covered.length > 0) {
      return {
        ...base,
        routes: covered,
        ignored: false,
        kind: 'named-source',
        confidence: 'LOW',
        why: `a file that looks like documentation, except the route it would serve (${covered[0]!.route}) is one this project tests — on a docs-site generator this file IS the page`,
        blastRadius: false,
      };
    }
  }

  /*
   * A route read off the SHAPE of a path is a guess about the routing table, not
   * a reading of it. If the app has never been seen at that route — no test
   * navigates there, no crawl found it — the guess is unsupported, and
   * `src/api/client.ts` would be filed as "the /client route", or the Page
   * Object Model directory every Playwright project calls `pages/` would make
   * `support/pages/LoginPage.ts` "the /loginpage route", and either would then
   * park a real test at full confidence. Demote it to what it actually is: a
   * name.
   *
   * This can only ever add runs. The demotion test is "no route the suite knows
   * overlaps this one", and the per-test route match asks the same question
   * against a subset of the same routes — so a path that would have matched a
   * test cannot be demoted out from under it.
   */
  if (SHAPE_DERIVED_KINDS.has(facts.kind) && !facts.blastRadius) {
    const corroborated = facts.routes.some((source) => suiteHasSeen(source, suite));
    if (!corroborated) {
      return attribute(
        {
          ...facts,
          kind: 'named-source',
          routes: [],
          why: 'source with no route convention — only its name is a signal',
          baseConfidence: 'LOW',
        },
        suite,
      );
    }
    return {
      ...base,
      kind: facts.kind,
      confidence: facts.baseConfidence,
      why: facts.why,
      blastRadius: facts.blastRadius,
    };
  }

  if (facts.kind !== 'named-source') {
    return {
      ...base,
      kind: facts.kind,
      confidence: facts.baseConfidence,
      why: facts.why,
      blastRadius: facts.blastRadius,
    };
  }

  const known = facts.tokens.filter((t) => suite.tokens.has(t));
  if (known.length === 0) {
    return {
      ...base,
      kind: 'unattributable',
      confidence: 'NONE',
      why: 'nothing in this path matches any route, feature, or tag the suite knows about — what it can break is unknown',
      blastRadius: true,
    };
  }

  return {
    ...base,
    kind: 'named-source',
    confidence: 'LOW',
    why: `its name matches ${known.slice(0, 3).join(', ')} in the suite, but nothing proves that is the only thing it touches`,
    blastRadius: false,
  };
}

// ─── What a test tells us about itself ───────────────────────────────────────

/** Quoted absolute paths: page.goto('/checkout'), request.get("/api/orders"). */
const QUOTED_PATH = /(['"`])(\/[^'"`\s\\]{0,200})\1/g;
/** Template prefixes: `/orders/${id}` — everything up to the first interpolation. */
const TEMPLATE_PATH = /`(\/[^`$\\\s]{0,200})\$\{/g;
const ABSOLUTE_URL = /(['"`])(https?:\/\/[^'"`\s]{0,300})\1/g;
/**
 * expect(page).toHaveURL(/\/checkout\/success/) — a route the test asserts on.
 * The body has to allow escaped slashes: `\/` is how every one of these is
 * written, and stopping at the first `/` would read the whole assertion as empty.
 */
const URL_ASSERTION = /(?:toHaveURL|waitForURL)\(\s*\/((?:\\.|[^/\n]){1,200}?)\//g;

/**
 * Every cap in this file protects the server from a pathological row, and every
 * one of them does it by throwing away part of what a test says it covers. That
 * is fine for the server and lethal for the decision: a test whose declared
 * coverage was trimmed looks LESS related to the diff than it is, which is the
 * one direction of error this module does not accept. So the extractors carry a
 * flag, and a test that tripped any cap is never a skip candidate.
 */
export interface CoverageTruncation {
  truncated: boolean;
}

function addRoute(out: Set<string>, candidate: string, truncation?: CoverageTruncation): void {
  if (out.size >= MAX_ROUTES_PER_TEST) {
    if (truncation) truncation.truncated = true;
    return;
  }
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return;
  const route = normalizeRoute(candidate);
  if (route === '/' && candidate.replace(/\/+$/, '') !== '') return;
  out.add(route);
}

/**
 * Route literals a Playwright spec navigates to or asserts on.
 *
 * String-level rather than AST-level on purpose: the code column holds whatever
 * the generator, the importer, or a human last wrote — including files that do
 * not parse — and a parser that throws on one test would take the whole analysis
 * down with it. Over-collecting here is harmless: a stray path literal only ever
 * causes a test to run.
 */
export function routeLiteralsFromCode(code: string, truncation?: CoverageTruncation): string[] {
  const oversized = code.length > MAX_CODE_CHARS;
  // Whatever is past the cut may hold the one goto() that ties this test to the
  // diff, and we are choosing not to look. Say so rather than pretend.
  if (oversized && truncation) truncation.truncated = true;
  const source = oversized ? code.slice(0, MAX_CODE_CHARS) : code;
  const out = new Set<string>();

  for (const match of source.matchAll(QUOTED_PATH)) addRoute(out, match[2]!, truncation);

  for (const match of source.matchAll(TEMPLATE_PATH)) {
    const prefix = match[1]!;
    const upToLastSlash = prefix.endsWith('/') ? prefix : prefix.slice(0, prefix.lastIndexOf('/') + 1);
    addRoute(out, `${upToLastSlash}:param`, truncation);
  }

  for (const match of source.matchAll(ABSOLUTE_URL)) {
    try {
      addRoute(out, new URL(match[2]!).pathname, truncation);
    } catch {
      // Not a URL after all; the literal simply contributes nothing.
    }
  }

  for (const match of source.matchAll(URL_ASSERTION)) {
    const body = match[1]!.replace(/\\/g, '').replace(/[$^]/g, '');
    const path = /(\/[a-z0-9\-_/:]*)/i.exec(body);
    if (path?.[1]) addRoute(out, path[1], truncation);
  }

  return [...out];
}

/**
 * Routes buried in `spec`, for the test types whose code column is inert: API
 * steps carry `path`, accessibility carries `routes`, security carries
 * `authRequiredPaths` and IDOR templates, visual carries `path`.
 *
 * Walked structurally rather than by key name because those shapes are owned by
 * the runner plugins and drift independently of this file. A deep walk keeps
 * working when a new plugin invents a new field; a key allow-list would silently
 * stop seeing that plugin's routes, and silence is the failure mode that skips
 * tests it should not.
 */
export function routesFromSpec(
  spec: unknown,
  depth = 0,
  out = new Set<string>(),
  truncation?: CoverageTruncation,
): string[] {
  if (depth > MAX_SPEC_DEPTH || out.size >= MAX_ROUTES_PER_TEST) {
    /*
     * We are walking away from a subtree we have not read. Only flag it when
     * something down there could actually have been a route — abandoning a
     * header map or a viewport number costs this test nothing, and flagging
     * those would make every spec unskippable for no gain.
     */
    if (
      truncation &&
      (out.size >= MAX_ROUTES_PER_TEST ||
        (typeof spec === 'object' && spec !== null) ||
        (typeof spec === 'string' && (spec.startsWith('/') || /^https?:\/\//i.test(spec))))
    ) {
      truncation.truncated = true;
    }
    return [...out];
  }

  if (typeof spec === 'string') {
    if (spec.startsWith('/')) addRoute(out, spec, truncation);
    else if (/^https?:\/\//i.test(spec)) {
      try {
        addRoute(out, new URL(spec).pathname, truncation);
      } catch {
        // Ignore: an unparseable URL simply carries no route.
      }
    }
    return [...out];
  }

  if (Array.isArray(spec)) {
    for (const item of spec) routesFromSpec(item, depth + 1, out, truncation);
    return [...out];
  }

  if (spec && typeof spec === 'object') {
    for (const value of Object.values(spec)) routesFromSpec(value, depth + 1, out, truncation);
  }
  return [...out];
}

// ─── The flow map ────────────────────────────────────────────────────────────

interface FlowFacts {
  /** Lowercased feature name → the routes its nodes cover. */
  featureRoutes: Map<string, string[]>;
  /** Every route the crawler has seen, used to widen a match, never to narrow one. */
  routes: string[];
}

/**
 * Read the serialised FlowMap defensively.
 *
 * The row may have been written by an older Explorer than the types in
 * @qaai/shared describe, and a shape mismatch here must degrade to "no flow-map
 * signal" — which costs savings — rather than throw, which would cost the whole
 * analysis.
 */
export function readFlowMap(graph: unknown): FlowFacts {
  const empty: FlowFacts = { featureRoutes: new Map(), routes: [] };
  if (!graph || typeof graph !== 'object') return empty;

  const g = graph as { nodes?: unknown; features?: unknown };
  if (!Array.isArray(g.nodes)) return empty;

  const nodeRoutes = new Map<string, string>();
  const allRoutes = new Set<string>();

  for (const node of g.nodes) {
    if (!node || typeof node !== 'object') continue;
    const n = node as { id?: unknown; route?: unknown; url?: unknown };
    if (typeof n.id !== 'string') continue;

    let route: string | null = null;
    if (typeof n.route === 'string' && n.route.startsWith('/')) route = normalizeRoute(n.route);
    else if (typeof n.url === 'string') {
      try {
        route = normalizeRoute(new URL(n.url).pathname);
      } catch {
        route = null;
      }
    }
    if (!route) continue;
    nodeRoutes.set(n.id, route);
    allRoutes.add(route);
  }

  const featureRoutes = new Map<string, string[]>();
  if (Array.isArray(g.features)) {
    for (const feature of g.features) {
      if (!feature || typeof feature !== 'object') continue;
      const f = feature as { name?: unknown; nodeIds?: unknown };
      if (typeof f.name !== 'string' || !Array.isArray(f.nodeIds)) continue;

      const routes = new Set<string>();
      for (const nodeId of f.nodeIds) {
        const route = typeof nodeId === 'string' ? nodeRoutes.get(nodeId) : undefined;
        if (route) routes.add(route);
      }
      if (routes.size > 0) featureRoutes.set(f.name.toLowerCase(), [...routes]);
    }
  }

  return { featureRoutes, routes: [...allRoutes] };
}

// ─── The test index ──────────────────────────────────────────────────────────

export interface TestIndexEntry {
  testId: string;
  name: string;
  filePath: string;
  priority: Priority;
  feature: string | null;
  tags: string[];
  /** Every route this test navigates to, asserts on, or configures. */
  routes: string[];
  tokens: string[];
  /**
   * False when the row says nothing CHECKABLE about what it covers.
   *
   * Routes are the only thing that qualifies, because routes are the only thing
   * a diff can be compared against. A tag is a label a human typed; `["smoke"]`
   * is not a claim that the test avoids checkout, and a test whose navigation
   * lives in an imported helper carries that tag while declaring nothing at all.
   * A feature name counts only once the flow map has turned it into routes —
   * which it already has by the time this is set, since those routes are folded
   * in below. Without a flow map the name is just more words.
   *
   * Such a test can never be skipped: there is no claim to check the diff
   * against, and skipping on "no claim" is skipping on nothing.
   */
  known: boolean;
  /**
   * True when a cap dropped part of what this test declares. Its coverage was
   * read incompletely, so it cannot be argued into a skip — see CoverageTruncation.
   */
  coverageTruncated: boolean;
}

function indexTest(test: ImpactTestInput, flow: FlowFacts): TestIndexEntry {
  const routes = new Set<string>();
  const truncation: CoverageTruncation = { truncated: false };
  for (const route of routeLiteralsFromCode(test.code ?? '', truncation)) routes.add(route);
  for (const route of routesFromSpec(test.spec, 0, new Set<string>(), truncation)) routes.add(route);

  // A test's feature pulls in every route the crawler filed under that feature,
  // so a checkout test that only navigates to /cart still answers to a change
  // anywhere in checkout.
  if (test.feature) {
    for (const route of flow.featureRoutes.get(test.feature.toLowerCase()) ?? []) routes.add(route);
  }

  const tokens = new Set<string>();
  for (const token of tokensForPath(test.filePath)) tokens.add(token);
  for (const token of tokenize(test.name)) tokens.add(token);
  if (test.feature) for (const token of tokenize(test.feature)) tokens.add(token);
  for (const tag of test.tags) for (const token of tokenize(tag)) tokens.add(token);
  for (const route of routes) for (const token of tokenize(route)) tokens.add(token);

  return {
    testId: test.id,
    name: test.name,
    filePath: normalizePath(test.filePath),
    priority: test.priority,
    feature: test.feature,
    tags: test.tags,
    routes: [...routes],
    tokens: [...tokens],
    known: routes.size > 0,
    coverageTruncated: truncation.truncated,
  };
}

/** Exposed so the cockpit can show what the analysis thinks each test covers. */
export function indexTests(tests: ImpactTestInput[], flowMapGraph?: unknown): TestIndexEntry[] {
  const flow = readFlowMap(flowMapGraph);
  return tests.map((test) => indexTest(test, flow));
}

/**
 * Does a changed path point at this test's own file?
 *
 * Compared by suffix because the two live in different trees: the DB stores
 * `checkout/order-total.spec.ts` and the exported repo — which is what the PR
 * diffs — has it at `tests/checkout/order-total.spec.ts`.
 */
function isOwnTestFile(entry: TestIndexEntry, changedPath: string): boolean {
  if (!entry.filePath) return false;
  if (changedPath === entry.filePath) return true;
  if (changedPath.endsWith(`/${entry.filePath}`)) return true;

  // The exporter appends `.spec.ts` to spec-driven stems (`x.a11y` → `x.a11y.spec.ts`).
  const stem = entry.filePath.replace(/\.[^./]+$/, '');
  return stem.length > 0 && (changedPath.includes(`/${stem}.`) || changedPath.startsWith(`${stem}.`));
}

// ─── The analysis ────────────────────────────────────────────────────────────

function lowest(values: Confidence[]): Confidence {
  return values.reduce<Confidence>(
    (worst, value) => (CONFIDENCE_RANK[value] < CONFIDENCE_RANK[worst] ? value : worst),
    'HIGH',
  );
}

function decisionFor(
  entry: TestIndexEntry,
  decision: 'run' | 'skip',
  reason: string,
  confidence: Confidence,
  signals: string[] = [],
  matchedPaths: string[] = [],
): TestDecision {
  return {
    testId: entry.testId,
    name: entry.name,
    filePath: entry.filePath,
    priority: entry.priority,
    feature: entry.feature,
    decision,
    reason,
    confidence,
    signals,
    matchedPaths,
  };
}

function summarise(paths: string[], limit = 3): string {
  const shown = paths.slice(0, limit).join(', ');
  return paths.length > limit ? `${shown} and ${paths.length - limit} more` : shown;
}

/** These strings are read by a human deciding whether to trust a skip. */
function count(n: number, singular: string): string {
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

function article(word: string): string {
  return /^[AEIOU]/i.test(word) ? 'an' : 'a';
}

export function analyzeImpact(input: ImpactInput): ImpactAnalysis {
  const flow = readFlowMap(input.flowMapGraph);
  const entries = input.tests.map((test) => indexTest(test, flow));
  const changedPaths = [...new Set(input.changedPaths.map(normalizePath).filter(Boolean))];

  const runEverything = (reason: string, attributions: PathAttribution[] = []): ImpactAnalysis => {
    const run = entries.map((entry) =>
      decisionFor(entry, 'run', `The whole suite is running: ${reason}`, 'NONE'),
    );
    return {
      strategy: 'RUN_EVERYTHING',
      reason,
      confidence: 'NONE',
      savedPercent: 0,
      run,
      skip: [],
      testIds: run.map((d) => d.testId),
      attributions,
      totals: { tests: entries.length, run: run.length, skip: 0, changedPaths: changedPaths.length },
    };
  };

  if (entries.length === 0) {
    return {
      strategy: 'RUN_EVERYTHING',
      reason: 'This project has no runnable tests, so there is nothing to select from.',
      confidence: 'NONE',
      savedPercent: 0,
      run: [],
      skip: [],
      testIds: [],
      attributions: [],
      totals: { tests: 0, run: 0, skip: 0, changedPaths: changedPaths.length },
    };
  }

  if (changedPaths.length === 0) {
    return runEverything('No changed paths were supplied, so nothing can be ruled out.');
  }
  if (changedPaths.length > MAX_CHANGED_PATHS) {
    return runEverything(
      `${count(changedPaths.length, 'changed file')} is beyond the ${MAX_CHANGED_PATHS}-file limit for attribution; a diff that wide touches everything anyway.`,
    );
  }

  const suiteTokens = new Set<string>();
  const suiteRoutes = new Set<string>(flow.routes);
  for (const entry of entries) {
    for (const token of entry.tokens) suiteTokens.add(token);
    for (const route of entry.routes) suiteRoutes.add(route);
  }

  const suite: SuiteContext = {
    tokens: suiteTokens,
    routes: [...suiteRoutes],
    ownsTestFile: (path) => entries.some((entry) => isOwnTestFile(entry, path)),
  };

  const attributions = changedPaths.map((path) => attribute(derivePathFacts(path), suite));

  /*
   * The fail-safe gate. One file we cannot place makes every skip decision a
   * guess, so the whole suite runs — and the caller is told exactly which file
   * cost them the saving, because that is the only way the heuristic improves.
   */
  const blocking = attributions.filter((a) => a.blastRadius);
  if (blocking.length > 0) {
    const first = blocking[0]!;
    return runEverything(
      `${summarise(blocking.map((a) => a.path))} could not be narrowed down (${first.why}), so no test can be safely skipped.`,
      attributions,
    );
  }

  const meaningful = attributions.filter((a) => !a.ignored);

  /*
   * Nothing in the diff can reach the app. Running zero tests would still be
   * wrong: the classification above is a heuristic too, and a suite that reports
   * "0 tests, all green" teaches people to stop reading it. The critical-path
   * tests run as a floor.
   */
  if (meaningful.length === 0) {
    const critical = entries.filter((e) => e.priority === 'CRITICAL_PATH');
    if (critical.length === 0) {
      return runEverything(
        'Only documentation changed, but this project has no CRITICAL_PATH tests to use as a floor, so the suite runs.',
        attributions,
      );
    }
    const criticalIds = new Set(critical.map((c) => c.testId));
    const run = critical.map((entry) =>
      decisionFor(
        entry,
        'run',
        'Only documentation changed; CRITICAL_PATH tests run anyway so a green check never means "nothing ran".',
        'MEDIUM',
        ['smoke-floor'],
      ),
    );
    const skip = entries
      .filter((e) => !criticalIds.has(e.testId))
      .map((entry) =>
        decisionFor(
          entry,
          'skip',
          `Only documentation changed (${summarise(attributions.map((a) => a.path))}), which cannot affect the running app.`,
          'MEDIUM',
        ),
      );
    return {
      strategy: 'SMOKE_FLOOR',
      reason: `Every changed file is documentation or repo metadata; running the ${run.length} CRITICAL_PATH tests as a floor.`,
      confidence: 'MEDIUM',
      savedPercent: Math.round((skip.length / entries.length) * 100),
      run,
      skip,
      testIds: run.map((d) => d.testId),
      attributions,
      totals: {
        tests: entries.length,
        run: run.length,
        skip: skip.length,
        changedPaths: changedPaths.length,
      },
    };
  }

  /*
   * Our belief that a test is unaffected is only as strong as our weakest
   * reading of the diff, so the change set carries one confidence: the minimum.
   * A PR of nine page files and one mystery component is a LOW-confidence PR.
   */
  const changeConfidence = lowest(meaningful.map((a) => a.confidence));

  const run: TestDecision[] = [];
  const skip: TestDecision[] = [];

  for (const entry of entries) {
    const signals: string[] = [];
    const matchedPaths: string[] = [];
    let reason = '';

    for (const attribution of meaningful) {
      let matched = false;

      if (isOwnTestFile(entry, attribution.path)) {
        signals.push('test-file-changed');
        matched = true;
        reason ||= `Its own test file is in the diff (${attribution.path}).`;
      }

      for (const source of attribution.routes) {
        const hit = entry.routes.find((testRoute) => routesOverlap(source, testRoute));
        if (hit) {
          signals.push(`route:${source.route}`);
          matched = true;
          reason ||= `It exercises ${hit}, and ${attribution.path} is ${attribution.why}.`;
        }
      }

      // The flow map turns a route change into a feature change: a test filed
      // under Checkout answers for every route the crawler put in Checkout.
      for (const [feature, routes] of flow.featureRoutes) {
        if (entry.feature?.toLowerCase() !== feature) continue;
        const hit = attribution.routes.find((source) =>
          routes.some((featureRoute) => routesOverlap(source, featureRoute)),
        );
        if (hit) {
          signals.push(`flow-map:${feature}`);
          matched = true;
          reason ||= `The flow map puts ${hit.route} in the ${entry.feature} feature this test covers.`;
        }
      }

      const sharedTokens = attribution.tokens.filter((token) => entry.tokens.includes(token));
      if (sharedTokens.length > 0) {
        signals.push(`name:${sharedTokens[0]!}`);
        matched = true;
        reason ||= `"${sharedTokens[0]!}" ties it to ${attribution.path}.`;
      }

      if (matched) matchedPaths.push(attribution.path);
    }

    if (signals.length > 0) {
      run.push(decisionFor(entry, 'run', reason, changeConfidence, [...new Set(signals)], matchedPaths));
      continue;
    }

    if (!entry.known) {
      run.push(
        decisionFor(
          entry,
          'run',
          'This test declares no route we can check a diff against — a tag or a feature name alone says nothing about what it exercises — so it runs by default.',
          'NONE',
          ['no-coverage-signal'],
        ),
      );
      continue;
    }

    /*
     * We read this test's coverage through a cap and know we did not see all of
     * it. The missing part is exactly where a match might have been, so the only
     * honest reading is "unknown", and unknown runs.
     */
    if (entry.coverageTruncated) {
      run.push(
        decisionFor(
          entry,
          'run',
          'Part of what this test declares was past an internal limit and never read, so we cannot say the diff misses it — it runs by default.',
          'NONE',
          ['truncated-coverage'],
        ),
      );
      continue;
    }

    const required = MIN_CONFIDENCE_TO_SKIP[entry.priority];
    if (CONFIDENCE_RANK[changeConfidence] < CONFIDENCE_RANK[required]) {
      run.push(
        decisionFor(
          entry,
          'run',
          `Nothing links it to this diff, but attribution is only ${changeConfidence} confidence and ${article(entry.priority)} ${entry.priority} test needs ${required} before it is skipped.`,
          changeConfidence,
          ['priority-floor'],
        ),
      );
      continue;
    }

    // Always routes: a test only reaches this line by declaring at least one,
    // and the reason a human reads has to name the thing we actually compared.
    // "touches its tags" was a confession that we compared nothing.
    const covers = entry.routes.slice(0, 3).join(', ');
    skip.push(
      decisionFor(
        entry,
        'skip',
        `Nothing in the ${count(meaningful.length, 'changed file')} touches ${covers}, and every one of them was attributed with at least ${changeConfidence} confidence.`,
        changeConfidence,
      ),
    );
  }

  /*
   * Last line of defence. A selection that runs nothing is indistinguishable
   * from not testing at all, and it is exactly what a subtly wrong heuristic
   * produces. If the analysis talked itself out of every test, it is wrong.
   */
  if (run.length === 0) {
    return runEverything(
      'The analysis matched no test at all, which is far more likely to be a gap in the heuristic than a change that breaks nothing.',
      attributions,
    );
  }

  return {
    strategy: 'SELECTIVE',
    reason: `Attributed all ${count(meaningful.length, 'changed file')} with ${changeConfidence} confidence; ${run.length} of ${entries.length} tests can reach the change.`,
    confidence: changeConfidence,
    savedPercent: Math.round((skip.length / entries.length) * 100),
    run,
    skip,
    testIds: run.map((d) => d.testId),
    attributions,
    totals: {
      tests: entries.length,
      run: run.length,
      skip: skip.length,
      changedPaths: changedPaths.length,
    },
  };
}
