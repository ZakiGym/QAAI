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
import type { SurfaceSource } from './surface';
/*
 * TYPE-ONLY, and it has to stay that way: api-surface.ts imports the VALUE
 * `HTTP_METHODS` from this file, so a value import back would be a runtime
 * import cycle. Every name below is erased at compile time, which is why this
 * file can borrow the vocabulary without owning it — the same bargain the
 * header strikes with `FieldSemantic`.
 */
import type {
  BackgroundSurfaceFact,
  ComponentItemKind,
  ComponentStateKind,
  FlagProvider,
  LocaleCatalogueReader,
} from './api-surface';

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
  /*
   * ─── The five surfaces nothing in this file could see ──────────────────────
   *
   * Everything above answers "what URL does this app serve?". These five answer
   * questions that were not merely unanswered but UNASKED, and an unasked
   * question does not lower a coverage percentage — it raises it, because the
   * surface is absent from the denominator rather than uncovered. Each one is
   * here because something downstream already reads a field nothing writes:
   *
   *  · route-guards       `SourceRoute.behindAuth` is read throughout
   *                       apps/worker/src/processors/analyze-source.ts and set
   *                       from real analysis nowhere, so a source-derived plan
   *                       can never propose an authenticated scenario.
   *  · component-inventory UNIT_GEN has no denominator at all.
   *  · background-surfaces the PROTOCOL and EMAIL_OTP runners EXECUTE crons,
   *                       queues, webhooks and mail today. QAAI can test these
   *                       and cannot count them.
   *  · feature-flags      the crawl saw ONE of two applications and cannot say
   *                       which. The most insidious of the five, because the
   *                       number looks fine.
   *  · locales            the LOCALIZATION runner takes its locale list from a
   *                       hand-written spec, so the denominator is whatever a
   *                       human typed.
   */
  'route-guards',
  'component-inventory',
  'background-surfaces',
  'feature-flags',
  'locales',
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
  'route-guards': {
    label: 'Route guards',
    looksFor:
      'Next.js middleware matchers and auth route groups, layouts that redirect, Express/Koa middleware chains, @UseGuards / @Roles decorators, React Router loaders that redirect, and withAuth / requireAuth wrappers',
  },
  'component-inventory': {
    label: 'Components and their states',
    looksFor:
      'exported components, pages, layouts, hooks, providers and helpers, their render branches on loading / empty / error / forbidden, and *.stories.* catalogue entries',
  },
  'background-surfaces': {
    label: 'Surfaces off the request path',
    looksFor:
      'cron declarations (vercel.json, node-cron, @nestjs/schedule, GitHub Actions), queue consumers (BullMQ, SQS, Pub/Sub, Kafka), webhook receivers that verify a signature, outbound email, upload handlers, websocket/SSE endpoints, server actions and tRPC procedures',
  },
  'feature-flags': {
    label: "The application's feature flags",
    looksFor:
      'LaunchDarkly, Unleash, OpenFeature, GrowthBook, Flagsmith and Statsig call sites, process.env feature gates, and checked-in flag config files',
  },
  locales: {
    label: 'Locales the application claims to support',
    looksFor:
      'locales/ and messages/ catalogues, next-intl / i18next / vue-i18n config, Next.js i18n routing config, and hreflang alternates in static markup',
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
  /**
   * What the source says about who may reach this route. See {@link RouteGuard}.
   *
   * ABSENT means the guard pass did not run over this analysis at all — which
   * every analysis stored before this slice is. `{ access: 'UNKNOWN' }` means it
   * ran and could not tell. Those are different facts and a reader that merged
   * them would report an un-analysed repo as a repo with no guards.
   */
  guard?: RouteGuard;
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
  /** Same contract as {@link PageRoute.guard}: absent, UNKNOWN and a verdict differ. */
  guard?: RouteGuard;
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

// ─── 1. Guards: who is allowed to reach this route ───────────────────────────

/**
 * Whether the source says a route is behind a login — and the third answer.
 *
 * ── Why this is not a boolean ───────────────────────────────────────────────
 *
 * Because `SourceRoute.behindAuth` (apps/worker/src/processors/analyze-source.ts)
 * IS a boolean, it is read all over that file, and no producer has ever set it.
 * Its own doc comment admits as much: "Always false for anything @qaai/shared
 * produces today". A boolean has nowhere to put "we did not analyse this", so
 * every route in every repo QAAI has ever ingested arrived as `false` — and
 * `false` on that field is not an absence of information, it is the positive
 * claim THIS ROUTE IS PUBLIC.
 *
 * The consequences are concrete and all in the flattering direction. `roleFor`
 * hands the route no auth profile. `accessibilityItem` filters to
 * `!r.behindAuth` and so sweeps the guarded half of the app as though it were
 * public. Every form on a guarded route is proposed signed-out. The plan's
 * own list of guarded paths — `routes.filter(r => r.behindAuth)` — comes back
 * empty for every customer. An admin route is reported as
 * uncovered-and-public, a plan proposes an anonymous smoke test for it, the
 * test gets a redirect to /login, and the redirect is recorded as the page.
 *
 * So three values, and the two negative ones are NOT the same:
 *
 *   GUARDED    a guard was found. Something in the source demands a session
 *              before this route renders or this handler runs.
 *   UNGUARDED  the guard pass read this route's own declaration sites and
 *              found no guard. The strongest negative a STATIC read can make,
 *              and still not a proof of public access — a parent layout whose
 *              body was never uploaded may guard it. `evidence` says what was
 *              looked at, so the claim can be disagreed with.
 *   UNKNOWN    we could not analyse it: no file body, a matcher written as an
 *              expression, a guard behind an import a static pass cannot
 *              follow. Nothing is claimed in either direction.
 *
 * UNKNOWN must never be flattened into UNGUARDED on the way to storage. That
 * is the "source's silence read as a source's answer" lie, and on this field it
 * is the one that gets an authorization hole shipped.
 *
 * ── Not to be confused with `RouteAccess` in flow-map.ts ────────────────────
 *
 * That type is the OBSERVED half of the same question: one role asked for one
 * route and this is what came back. This type is the DECLARED half — the
 * source says a guard exists and nobody asked. They meet at
 * `RouteAccess.basis`, whose two values are exactly OBSERVED and DECLARED, so a
 * GUARDED verdict here is what finally gives that `'DECLARED'` branch
 * something to be derived from. The two disagreeing — declared GUARDED,
 * observed ALLOWED for an anonymous visitor — is the most valuable finding
 * either of them can produce, which is why they stay separate types.
 */
export const GUARD_VERDICTS = ['GUARDED', 'UNGUARDED', 'UNKNOWN'] as const;
export type GuardVerdict = (typeof GUARD_VERDICTS)[number];

export const GUARD_VERDICT_LABELS: Record<GuardVerdict, string> = {
  GUARDED: 'the source declares a guard on it',
  UNGUARDED: 'no guard was found at any declaration site we could read',
  UNKNOWN: 'we could not analyse the guards on it',
};

/**
 * The shapes a guard is written in, in the ecosystems QAAI is pointed at.
 *
 * Named rather than merged into one "a guard" so that a systematically wrong
 * reader can be found — the same argument `SurfaceItem.detector` makes. A
 * customer who sees every `NEXT_ROUTE_GROUP` verdict disputed knows which
 * reader to distrust without distrusting the number.
 */
export const GUARD_KINDS = [
  /** `middleware.ts` with a matcher, Next.js's one real request interceptor. */
  'NEXT_MIDDLEWARE',
  /** An `app/(authenticated)/…` route group whose name declares the guard. */
  'NEXT_ROUTE_GROUP',
  /** A `layout.tsx` / `+layout.server.ts` that redirects when there is no session. */
  'LAYOUT_REDIRECT',
  /** `app.get('/x', requireAuth, handler)` or `router.use(requireAuth)`. */
  'MIDDLEWARE_CHAIN',
  /** `@UseGuards(JwtAuthGuard)` / `@Roles('ADMIN')` — Nest and Spring. */
  'DECORATOR',
  /** A React Router loader that redirects to a login route. */
  'ROUTER_LOADER',
  /** `withAuth(Page)`, `requireAuth(handler)`, `protectedProcedure`. */
  'AUTH_WRAPPER',
] as const;
export type GuardKind = (typeof GUARD_KINDS)[number];

/**
 * Every member of {@link GuardKind}, as a run-time value the compiler maintains.
 *
 * The pattern this codebase enforces for a vocabulary with a write path, and
 * the first of its two halves: a `Record` keyed on the union, which the
 * compiler refuses to let drift. The second half is the parity test in
 * codebase.test.ts that compares this list against `GUARD_READERS`' own keys.
 * Eight `GateRule` kinds shipped unsaveable for two slices because only one of
 * the two existed, and `check:wiring` cannot see that class of defect.
 */
const GUARD_KIND_PRESENT: Record<GuardKind, true> = {
  NEXT_MIDDLEWARE: true,
  NEXT_ROUTE_GROUP: true,
  LAYOUT_REDIRECT: true,
  MIDDLEWARE_CHAIN: true,
  DECORATOR: true,
  ROUTER_LOADER: true,
  AUTH_WRAPPER: true,
};

/** `GUARD_KINDS`, derived from the record the compiler checks. */
export const GUARD_KIND_LIST = Object.keys(GUARD_KIND_PRESENT) as ReadonlyArray<GuardKind>;

/** One guard declaration, as read out of one file. */
export interface GuardDeclaration {
  kind: GuardKind;
  /** The file the declaration is in. Evidence, never optional. */
  file: string;
  line: number | null;
  /**
   * The URL patterns this declaration covers, in this file's own route
   * spelling (`/admin/:id`, `/admin/*`). Empty when the declaration guards
   * whatever it wraps rather than a path it names — a layout, a decorator.
   */
  patterns: string[];
  /**
   * The roles the declaration demands.
   *
   * NULL IS NOT `[]`. Null means the declaration guards access and names no
   * role we could read; `[]` would say "it demands the empty set of roles",
   * which is what "anyone logged in" would be if we had read that positively.
   * `requiresRoles: []` set unconditionally is the existing defect on
   * `FlowNode` (flow-map.ts names it), and reproducing it here would make the
   * route × role matrix a table of empty sets.
   */
  roles: string[] | null;
  /** The sentence that justifies the verdict, in the customer's terms. */
  evidence: string;
}

/**
 * What the source says about who may reach one route or endpoint.
 *
 * `declaredBy` carries every declaration that applied, because two can: a
 * middleware matcher AND a `@Roles` decorator on the same handler is the normal
 * case in a Nest app behind a gateway, and reporting one would make the other
 * invisible.
 */
export interface RouteGuard {
  access: GuardVerdict;
  /**
   * The union of every applying declaration's roles, or null.
   *
   * Null under GUARDED means "guarded, and no declaration named a role" — a
   * perfectly common and useful fact. Null under UNGUARDED and UNKNOWN is the
   * only possible value: a route with no guard demands no role, and a route we
   * could not analyse has no readable role list.
   */
  roles: string[] | null;
  declaredBy: GuardDeclaration[];
  /** The sentence shown next to the verdict. Always written, never defaulted to ''. */
  evidence: string;
}

// ─── 2. The component inventory ──────────────────────────────────────────────

/**
 * One named state of one component, as read out of the source or a catalogue.
 *
 * `source` is `SurfaceSource` and not a local union, because a state found by
 * reading a branch on `isLoading` is SOURCE, one found in a Storybook entry is
 * CATALOGUE, and those are the same two distinctions the surface registry
 * already draws. A third spelling of them would be a second vocabulary.
 */
export interface SourceComponentState {
  kind: ComponentStateKind;
  /** 'SOURCE' for a render branch, 'CATALOGUE' for a story. Never anything else here. */
  source: SurfaceSource;
  /** "renders <Spinner/> when `isLoading`" — the branch, not the conclusion. */
  evidence: string;
}

/**
 * One exported component, hook, page, layout, provider or helper.
 *
 * Shaped to `componentItemSchema` in api-surface.ts, which is the only write
 * path into `ComponentItem`, plus the two fields that schema has no column for:
 * `line`, which is navigation rather than identity, and `states`, which become
 * `ComponentState` rows.
 *
 * ── The denominator trap this shape exists to avoid ─────────────────────────
 *
 * `hasCatalogueEntry` is `boolean | null` and the null is load-bearing: null
 * means NO CATALOGUE WAS READ, false means one was read and this component is
 * not in it. A component with no story is STILL A COMPONENT and still in the
 * inventory — letting "we found no story" shrink the denominator is the
 * undisclosed cap that makes a coverage percentage go up, and it would do it on
 * the one axis (UNIT_GEN) that has had no denominator at all.
 */
export interface SourceComponent {
  /** Repo-relative module path. Identity, with `exportName`. */
  modulePath: string;
  /** The exported name. `default` is a legal and common value. */
  exportName: string;
  kind: ComponentItemKind;
  /** A one-line summary of the props — never the full type. Null when it takes none. */
  propsSummary: string | null;
  /** Three states. See the note above; null means no catalogue was read. */
  hasCatalogueEntry: boolean | null;
  /** The catalogue entry's id (`Button` in `Components/Button`), when there is one. */
  catalogueRef: string | null;
  evidence: string;
  line: number | null;
  states: SourceComponentState[];
}

// ─── 3. Surfaces off the HTTP request path ───────────────────────────────────

/**
 * One background surface: a cron, a queue consumer, a webhook receiver, an
 * outbound email, an upload, a socket, a server action, a tRPC procedure.
 *
 * `fact` is `BackgroundSurfaceFact` from api-surface.ts — the nine-member
 * discriminated union the Model agent defined, stored in `CoverageItem.meta` on
 * the axis `backgroundSurfaceAxis` gives. This file does not restate it and
 * must not: the whole point of that union is that a cron's expression and a
 * queue's name are different facts, and a tenth spelling of them here would be
 * the second registry this round exists to prevent.
 *
 * ── The one overlap a writer has to resolve, named here so it cannot be
 *    discovered by a customer instead ──────────────────────────────────────
 *
 * A Next.js server action is BOTH an export of a module (so the component
 * reader lists it, kind UTILITY) and a surface off the request path (so this
 * reader lists it, kind SERVER_ACTION). Both lists are the honest answer to
 * their own question and neither should be trimmed. But a writer that puts
 * both into `CoverageItem` without joining them counts one surface in two
 * denominators — the defect `componentHasOwnAxis` exists to prevent, arriving
 * from two readers that agree rather than from one that is wrong.
 *
 * They join on `(module, exportName)` here and `(modulePath, exportName)` on
 * {@link SourceComponent}, which are deliberately the same two values.
 */
export interface SourceBackgroundSurface {
  fact: BackgroundSurfaceFact;
  file: string;
  line: number | null;
  evidence: string;
}

// ─── 4. The application's feature flags ──────────────────────────────────────

/*
 * THESE ARE THE CUSTOMER'S FLAGS. QAAI'S OWN `model FeatureFlag` IS NOT ONE.
 *
 * `model FeatureFlag` in apps/api/prisma/schema.prisma is QAAI's own flag
 * store: four rows written by prisma/seed.ts, read by nothing, and one of the
 * four gaps `scripts/check-wiring.ts` records. Nothing in this section has
 * anything to do with it. The flags below belong to the APPLICATION UNDER TEST
 * and are stored as `SurfaceDimension` rows with `kind: 'FLAG'` — never in
 * `FeatureFlag`, because the same primary key would then mean both "QAAI's
 * visual-regression feature is off" and "the customer's checkout-v2 flag
 * exists" and no reader could tell which.
 */

/**
 * One feature flag the application reads.
 *
 * ── Why this is the most insidious of the five ──────────────────────────────
 *
 * A flag the crawl did not set means the crawl saw ONE of two applications and
 * reported a coverage number for it without saying which one. Nothing looks
 * wrong: the percentage is plausible, the route list is plausible, and an
 * entire second application — the one behind `checkout-v2` — is absent from the
 * denominator rather than uncovered. Absent flatters; uncovered lowers.
 */
export interface SourceFeatureFlag {
  /** The flag's key as the application spells it. Never normalised: see below. */
  key: string;
  provider: FlagProvider;
  /**
   * Every value this flag can take, or NULL when the call site did not name
   * them.
   *
   * Null and `[]` are different and the difference decides whether a flag
   * sweep is possible. `['on','off']` is a boolean gate, enumerable from the
   * shape of the call. Null is a multivariate flag whose variants live in the
   * provider's dashboard and not in the repo — a thing to go and fetch from a
   * CATALOGUE reader, not a flag with no variants. `DimensionDetail.FLAG`
   * types this field as `string[]`, so a writer persisting a null must record
   * the shortfall rather than writing `[]`.
   */
  variants: string[] | null;
  /** The variant served when nothing overrides it, read off the SDK fallback. */
  defaultVariant: string | null;
  file: string;
  line: number | null;
  evidence: string;
}

// ─── 5. Locales ──────────────────────────────────────────────────────────────

/**
 * One locale the application claims to support.
 *
 * The LOCALIZATION runner's locale list is hand-written in a spec today, so the
 * locale denominator is whatever a human typed — which means a locale the app
 * ships and nobody typed is not under-tested, it is invisible.
 */
export interface SourceLocale {
  /** BCP-47 as the APP spells it: `pt-BR`, never `pt_br` and never `pt-br`. */
  tag: string;
  reader: LocaleCatalogueReader;
  /**
   * True for the locale served when nothing selects one.
   *
   * Only ever set from a config that NAMES a default (`defaultLocale`,
   * `fallbackLng`, `fallbackLocale`). A catalogue directory declares no default
   * and gets `false` on every tag — guessing that `en` is the default because
   * it is first alphabetically would invent the one fact the sweep's arithmetic
   * turns on.
   */
  isDefault: boolean;
  /**
   * True for a right-to-left locale. Derived from the language subtag against
   * the closed list of RTL scripts, which is a fact rather than a guess, and it
   * matters because an RTL locale re-lays-out the page instead of swapping
   * strings.
   */
  rtl: boolean;
  file: string;
  evidence: string;
}

// ─── What could not be analysed ──────────────────────────────────────────────

/**
 * Why a detector could not turn a file it found into a fact.
 *
 * ── The lie this exists to prevent ──────────────────────────────────────────
 *
 * An ingest that quietly skips 10% of the repo makes the coverage percentage go
 * UP, because the surfaces in the skipped tenth are absent from the denominator
 * rather than uncovered. So every cap, take, limit and failed parse that BIT
 * is reported here as a count AND a reason, which is what lets the report say
 * "at least N more existed". `DetectorReport.blocked` is one sentence per
 * detector and cannot carry a count per cause; this can.
 */
export const SHORTFALL_REASONS = [
  /** The caller sent the path and not the body. Nothing is wrong with the repo. */
  'NO_CONTENT',
  /** The body was longer than the per-file scan cap and was read to that point. */
  'FILE_TRUNCATED',
  /** One of OUR caps bit. The count is how many facts we declined to report. */
  'CAP_REACHED',
  /** The value was an expression, not a literal: a static read cannot follow it. */
  'EXPRESSION_NOT_LITERAL',
  /** The thing is behind an import or a dynamic require we cannot resolve. */
  'UNRESOLVED_IMPORT',
  /** We matched the shape and the body did not parse — our error, reported as ours. */
  'UNPARSEABLE',
] as const;
export type ShortfallReason = (typeof SHORTFALL_REASONS)[number];

export const SHORTFALL_REASON_LABELS: Record<ShortfallReason, string> = {
  NO_CONTENT: 'the file body was not uploaded',
  FILE_TRUNCATED: 'the file was longer than the scan cap and was read only up to it',
  CAP_REACHED: 'one of this analysis’s own caps was reached',
  EXPRESSION_NOT_LITERAL: 'the value was written as an expression, not a literal',
  UNRESOLVED_IMPORT: 'it is behind an import a static pass cannot follow',
  UNPARSEABLE: 'the file matched the shape and could not be read',
};

/** One cause, counted, for one detector. */
export interface AnalysisShortfall {
  /**
   * The detector that lost the fact, or NULL when the cause is the input and
   * every detector lost by it.
   *
   * Null is not a missing value. A repo truncated at the file cap costs the
   * guard reader, the component reader and the locale reader alike, and
   * attributing that to one of them would say the other two read the whole
   * repo — which is the kind of near-miss that makes a customer stop checking
   * the rest of the numbers.
   */
  detector: SourceDetectorId | null;
  reason: ShortfallReason;
  /** How many things went unreported because of this cause. Never 0. */
  count: number;
  /** What was skipped and what it would have taken, in the customer's terms. */
  detail: string;
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
  /*
   * ─── The five non-crawl inventories, and why every one is OPTIONAL ─────────
   *
   * `analyseCodebase` ALWAYS sets all five, so a fresh analysis always has
   * them. They are optional because an analysis is also a STORED value: the
   * `analysis` Json column is read back and cast straight to this interface
   * (`apps/api/src/lib/coverage-store.ts`), and every row written before this
   * slice has none of these keys.
   *
   * Declaring them required would make the compiler promise an array that is
   * `undefined` at run time — so `analysis.components.length` on a
   * three-month-old snapshot throws, and `analysis.locales` read as `[]`
   * reports "this application supports no locales" about an application nobody
   * looked at. That is the absent-versus-measured distinction `SurfaceItem`'s
   * own optional members are declared for, and it applies here for exactly the
   * same reason.
   *
   *   • absent → this analysis predates the reader. Nothing looked.
   *   • []     → the reader ran and the application declares none.
   */

  /**
   * Every guard declaration found, whether or not a route matched it.
   *
   * The ones that matched nothing are the finding: a middleware matcher for
   * `/admin/:path*` with no `/admin` route in the inventory means either dead
   * configuration or — far more likely — a whole admin area our route detectors
   * failed to read. That is evidence about OUR extractor, and suppressing it
   * would be hiding our own error rate, the same argument `CRAWL_ONLY` makes.
   */
  guards?: GuardDeclaration[];
  /** Exported components, hooks, pages, layouts and providers. The UNIT_GEN denominator. */
  components?: SourceComponent[];
  /** Crons, queues, webhook receivers, mail, uploads, sockets, actions, procedures. */
  backgroundSurfaces?: SourceBackgroundSurface[];
  /** The application's own feature flags. NOT QAAI's `model FeatureFlag`. */
  featureFlags?: SourceFeatureFlag[];
  /** The locales the app claims to support, instead of the ones a human typed. */
  locales?: SourceLocale[];
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
  /**
   * Every cause that cost this analysis a fact, counted.
   *
   * `coverage.truncated` is one boolean for the whole run and `notes` is prose;
   * neither can answer "how many, and why". This can, which is what lets a
   * report say "at least N more existed" instead of printing a percentage over
   * a denominator it quietly shrank.
   */
  shortfalls?: AnalysisShortfall[];
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

/*
 * The five new readers' caps. Every one of them is reported through
 * `Shortfalls` when it bites, with a count — a cap that silently truncates an
 * ingest raises the coverage percentage, because the surfaces past it are
 * absent from the denominator rather than uncovered.
 */
const MAX_GUARD_DECLARATIONS = 2000;
const MAX_COMPONENTS = 5000;
/** Six state kinds, each reachable from source and from a catalogue. */
const MAX_STATES_PER_COMPONENT = 12;
const MAX_EXPORTS_PER_FILE = 200;
const MAX_BACKGROUND_SURFACES = 1000;
const MAX_FLAGS = 500;
const MAX_LOCALES = 200;

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

/**
 * The counted account of what went unread, which `Ledger` cannot give.
 *
 * `Ledger.blocked` is one sentence per detector, so a detector that lost nine
 * facts to a missing body and one to its own cap reports a single string and no
 * numbers. The difference matters because only one of those two is OUR fault,
 * and only a count supports the sentence "at least N more existed".
 */
class Shortfalls {
  private readonly rows = new Map<string, AnalysisShortfall>();

  /**
   * Record one more thing lost to `reason`.
   *
   * `detail` is taken from the FIRST occurrence and never rewritten, so the
   * sentence stays about a concrete file a reader can go and look at rather
   * than drifting to whichever file happened to be last.
   */
  note(
    detector: SourceDetectorId | null,
    reason: ShortfallReason,
    detail: string,
    n = 1,
  ): void {
    if (n <= 0) return;
    const key = `${detector ?? '*'}|${reason}`;
    const existing = this.rows.get(key);
    if (existing) {
      existing.count += n;
      return;
    }
    this.rows.set(key, { detector, reason, count: n, detail });
  }

  /**
   * Ordered with the input-wide causes first, then by detector declaration
   * order, then by reason. Stable, so a reader diffing two analyses sees only
   * what changed about the repo.
   */
  report(): AnalysisShortfall[] {
    const rank = (detector: SourceDetectorId | null): number =>
      detector === null ? -1 : SOURCE_DETECTORS.indexOf(detector);
    return [...this.rows.values()].sort(
      (a, b) =>
        rank(a.detector) - rank(b.detector) ||
        SHORTFALL_REASONS.indexOf(a.reason) - SHORTFALL_REASONS.indexOf(b.reason),
    );
  }
}

/**
 * The 1-based line a character offset falls on.
 *
 * For the editor link only, which is why it is never part of any identity: a
 * line number moves when an import is added above it, and an identity derived
 * from one would retire every item in a file somebody reformatted.
 */
function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
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

/**
 * The TOP-LEVEL arguments of a call whose `(` is at `openAt`, as source slices.
 *
 * Splitting the text on commas attributes the wrong things to the wrong
 * positions the moment an argument has a comma or a paren of its own —
 * `app.post('/x', requireRole('ADMIN', 'OWNER'), handler)` is three arguments
 * and four commas. The guard pass needs the POSITIONS and not just the text,
 * because "this registration has a middleware between the path and the
 * handler" is a different fact from "the word requireAuth appears on this
 * line", and only the first one can be used to say we did not read something.
 *
 * NULL when the call does not close inside the window. A truncated argument
 * list read as a complete one would report a two-argument registration — no
 * middleware, nothing unread — for a chain we simply stopped looking at.
 */
function callArguments(src: string, openAt: number, window = 4000): string[] | null {
  if (src[openAt] !== '(') return null;
  const limit = Math.min(src.length, openAt + window);
  const args: string[] = [];
  let depth = 0;
  let start = openAt + 1;
  let i = openAt;
  while (i < limit) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuoted(src, i);
      continue;
    }
    const past = skipComment(src, i);
    if (past !== i) {
      i = past;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(src.slice(start, i));
        const trimmed = args.map((arg) => arg.trim());
        return trimmed.length === 1 && trimmed[0] === '' ? [] : trimmed;
      }
      i += 1;
      continue;
    }
    if (ch === ',' && depth === 1) {
      args.push(src.slice(start, i));
      start = i + 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return null;
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

// ─── Route guards ────────────────────────────────────────────────────────────

/**
 * Words that make a route group a GUARD rather than a filing decision.
 *
 * Deliberately short, and the omissions are the design. `(dashboard)`, `(app)`,
 * `(shop)` and `(main)` are organisational names: they sit behind a login in
 * some applications and in front of one in others, and there is nothing in the
 * name to tell us which. Reading them as guards would mark a public marketing
 * tree GUARDED, and reading GUARDED as a fact is how a crawl stops trying a
 * page it was always allowed to see. Every word below, by contrast, says the
 * access rule out loud.
 */
const AUTH_GROUP_WORD =
  /^(?:auth|authed|authenticated|protected|private|secure|secured|signed-?in|logged-?in|members?|members-only|internal)$/i;

/** A group whose name is also a ROLE claim. `(admin)` says who, not just that. */
const ROLE_GROUP_WORD = /^(?:admin|administrator|superadmin|staff|owner)$/i;

/**
 * Names a guard middleware, decorator or wrapper is written under.
 *
 * One list for all of Express, Koa, Nest, Passport and the hand-rolled
 * `requireAuth` every application eventually grows, because the question each
 * of them answers is the same one and a per-framework list would drift apart.
 */
const GUARD_NAME_BODY =
  'requireAuth|requiresAuth|requireUser|requireLogin|requireSession|requireAdmin|requireRole|requireRoles|requirePermission|ensureAuth|ensureAuthenticated|ensureLoggedIn|isAuthenticated|isAuthorized|authenticate|authGuard|authMiddleware|authorize|authorized|checkAuth|checkRole|verifyToken|verifyJwt|jwtAuth|protect|protected|adminOnly|withAuth|withPageAuthRequired|withApiAuthRequired|withAuthenticationRequired|AuthGuard|JwtAuthGuard|JwtGuard|SessionGuard|RolesGuard|PoliciesGuard|PermissionsGuard';

/**
 * One list, two regexes, built from one string.
 *
 * The blanket-`use()` check below needs the same names embedded in a larger
 * pattern. Building it by slicing `GUARD_NAME.source` is how the two come to
 * disagree the first time somebody adds a name with a different shape, so the
 * names live in a string and both regexes are compiled from it.
 */
const GUARD_NAME = new RegExp(`\\b(?:${GUARD_NAME_BODY})\\b`);

/** The session-shaped reads that make a redirect an AUTH redirect and not a 404. */
const SESSION_READ =
  /\b(?:getServerSession|getSession|getToken|unstable_getServerSession|currentUser|auth\(\)|useUser|requireUser|getUser|session|accessToken|refreshToken|jwt|cookies\(\)\s*\.\s*get)\b/;

/** A path a guard redirects an anonymous visitor to. */
const LOGIN_TARGET = /['"`]\/(?:[\w-]+\/)*(?:login|signin|sign-in|auth|sso|unauthorized|403)\b/i;

/**
 * `@Public()` and friends: an explicit opt-OUT written next to a class-level
 * guard.
 *
 * Its presence is why a file-level decorator verdict becomes UNKNOWN rather
 * than GUARDED. A Nest controller with `@UseGuards` on the class and `@Public()`
 * on one method is a MIXTURE, and this static pass cannot say which method is
 * which — so it says so. Claiming GUARDED for the whole file would hide a
 * public endpoint inside an inventory of protected ones, which is the exact
 * surface an authorization test is written to find.
 */
const PUBLIC_MARKER = /@(?:Public|SkipAuth|NoAuth|AllowAnonymous|Unprotected)\s*\(/;

/**
 * An argument whose body is RIGHT HERE: an inline arrow or function expression.
 *
 * The distinction this draws is the one that keeps the unresolved-middleware
 * verdict from becoming UNKNOWN everywhere. A middleware written inline has
 * already been read — `GUARD_NAME` and `SESSION_READ` scanned the whole file —
 * so a route in front of one is a route we are entitled to call UNGUARDED. A
 * bare identifier, a member access or a call is a definition somewhere else,
 * and following it needs the import graph rule 4 of this module's header
 * forbids inventing.
 */
const INLINE_FUNCTION = /^(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/;

/** Nest/Spring role declarations, with the app's own spelling preserved. */
const ROLE_DECLARATIONS: RegExp[] = [
  /@Roles\s*\(([^)]*)\)/g,
  /@PreAuthorize\s*\(\s*["'`][^"'`]*?hasR(?:ole|oles|ny)\w*\s*\(([^)]*)\)/g,
  /@Secured\s*\(([^)]*)\)/g,
  /\brequireRoles?\s*\(([^)]*)\)/g,
  /\bauthorize\s*\(([^)]*)\)/g,
  /\bhasRole\s*\(([^)]*)\)/g,
  /\ballowedRoles\s*:\s*(\[[^\]]*\])/g,
  /\brequiredRoles\s*:\s*(\[[^\]]*\])/g,
];

/**
 * Role names out of a declaration's argument list.
 *
 * Case is preserved deliberately. surface.ts is explicit that a role the app
 * calls `Admin` and one it calls `admin` are two roles until the customer says
 * otherwise — normalising them here would merge two cells of the route × role
 * matrix and shrink that denominator silently, which is the one direction a
 * denominator must never move on its own.
 */
function rolesIn(args: string): string[] {
  const out: string[] = [];
  for (const m of args.matchAll(/['"`]([^'"`\n]{1,60})['"`]/g)) {
    const name = (m[1] ?? '').trim();
    if (name.length > 0 && !out.includes(name)) out.push(name);
  }
  // `@Roles(Role.ADMIN)` — an enum member reference, which names the role just
  // as plainly as a string does and is the idiomatic Nest spelling.
  for (const m of args.matchAll(/\b[A-Z]\w*\s*\.\s*([A-Z][A-Z0-9_]{1,40})\b/g)) {
    const name = m[1] ?? '';
    if (name.length > 0 && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Every role any declaration in `text` demands, or null when none names one. */
function rolesDeclaredIn(text: string): string[] | null {
  const found: string[] = [];
  for (const pattern of ROLE_DECLARATIONS) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      for (const role of rolesIn(m[1] ?? '')) {
        if (!found.includes(role)) found.push(role);
      }
    }
  }
  return found.length > 0 ? found : null;
}

/**
 * A matcher pattern as a test against a route, or null when it is unreadable.
 *
 * Null is the important return. A Next.js matcher may be a full regular
 * expression — `'/((?!api|_next).*)'` is the documented idiom — and a pattern
 * this function cannot faithfully convert must make the routes it might cover
 * UNKNOWN, not UNGUARDED. Approximating it would decide an access question with
 * a guess, and the guess that falls out of a half-converted negative lookahead
 * is "public".
 */
function matcherToTest(pattern: string): RegExp | null {
  if (pattern.length === 0 || !pattern.startsWith('/')) return null;
  // A lookahead, an alternation or a character class is a real regex, not a
  // path pattern. We do not translate those; we admit we did not.
  if (/[(){}|[\]+^$\\]/.test(pattern)) return null;
  /*
   * Built by appending, not by joining on '/', and that is the whole point.
   *
   * `:path*` means ZERO OR MORE segments, so the slash in front of it is part
   * of the optional group: `/admin/:path*` matches `/admin` as well as
   * `/admin/users`. Joining the translated segments with '/' produced
   * `^/admin/.*$`, which does NOT match `/admin` — so a middleware matcher
   * covering an entire admin area left `/admin` itself UNGUARDED, and
   * UNGUARDED is spent downstream as a positive claim that the route is
   * public. That is this file's worst available defect, arriving from one
   * misplaced slash.
   */
  let body = '';
  for (const segment of pattern.split('/')) {
    if (segment.length === 0) continue;
    if (/^:[\w-]+\*$/.test(segment) || segment === '**') {
      body += '(?:/.*)?';
      continue;
    }
    if (/^:[\w-]+$/.test(segment) || segment === '*') {
      body += '/[^/]+';
      continue;
    }
    body += `/${segment.replace(/[.*?]/g, (char) => `\\${char}`)}`;
  }
  if (body.length === 0) body = '/';
  try {
    return new RegExp(`^${body}/?$`);
  } catch {
    return null;
  }
}

/** Does any of this declaration's patterns cover `route`? */
function patternsCover(patterns: readonly string[], route: string): boolean {
  for (const pattern of patterns) {
    const test = matcherToTest(pattern);
    if (test?.test(route)) return true;
  }
  return false;
}

/**
 * String literals out of an array or scalar property: `matcher: ['/a', '/b']`.
 *
 * Bounded by the ARRAY'S OWN BRACKETS, not by a heuristic about where the next
 * property starts. The heuristic version looked for a newline before the next
 * key, so `{ matcher: ['/admin'], regions: ['/iad1'] }` written on one line
 * donated `/iad1` to the matcher — and `/iad1`, a perfectly public route, came
 * out GUARDED. An invented guard is as damaging as a missed one: it tells the
 * crawl not to bother with a page it was always allowed to see.
 *
 * `sawValue` distinguishes "the property is not there" from "it is there and
 * holds nothing we could read", which is the same distinction every other
 * reader in this file draws.
 */
function literalList(source: string, property: string): { values: string[]; sawValue: boolean } {
  const at = new RegExp(`\\b${property}\\s*:`).exec(source);
  if (!at) return { values: [], sawValue: false };
  const from = at.index + at[0].length;
  const rest = source.slice(from, from + 4000);
  const open = rest.search(/\S/);
  if (open === -1) return { values: [], sawValue: true };

  const strings = (text: string): string[] =>
    [...text.matchAll(/['"`]([^'"`\n]{1,200})['"`]/g)]
      .map((m) => m[1] ?? '')
      .filter((value) => value.length > 0);

  if (rest[open] === '[') {
    const close = rest.indexOf(']', open);
    // An array that does not close inside the window is read as far as the
    // window goes. The caller's unreadable-pattern path then reports it.
    return {
      values: strings(close === -1 ? rest.slice(open + 1) : rest.slice(open + 1, close)),
      sawValue: true,
    };
  }
  // A scalar property: exactly one literal, and only if it is the next thing.
  const scalar = /^\s*['"`]([^'"`\n]{1,200})['"`]/.exec(rest);
  return { values: scalar && scalar[1] ? [scalar[1]] : [], sawValue: true };
}

/** The directory a layout guards, as a route prefix pattern. */
function layoutPrefix(path: string): string {
  const dir = dirname(path);
  const segments = dir.split('/');
  const anchor = segments.findIndex((s) => s === 'app' || s === 'routes' || s === 'pages');
  const rest = anchor === -1 ? [] : segments.slice(anchor + 1);
  const base = joinSegments(rest.map(appSegment));
  return base === '/' ? '/*' : `${base}/*`;
}

/**
 * Guard sites we FOUND and could not read, and what each one could cover.
 *
 * This is the machinery behind "UNKNOWN, never false". A `middleware.ts` whose
 * body was never uploaded is proof that an interceptor exists and no evidence
 * at all about what it intercepts, so every route it might cover has to come
 * out UNKNOWN. Without this list those routes would fall through to UNGUARDED
 * — a positive claim of public access derived from our own missing input.
 */
interface BlindGuardSite {
  file: string;
  /** Null when the site could cover anything (a middleware with no readable matcher). */
  coversPrefix: string | null;
  why: string;
  /**
   * Restrict the site to routes declared in `file`, not every route whose path
   * the prefix happens to match.
   *
   * Set for a site whose scope is ONE registration — an Express handler with a
   * middleware we could not resolve. Without it, `app.get('/', cors(), home)`
   * in a server file clouded the Next.js page route `/` declared in
   * app/page.tsx, because `blindFor` matches a prefix against a path and the
   * two files share nothing but the string. A layout's prefix is genuinely
   * cross-file and keeps the default.
   */
  inFileOnly?: true;
}

interface GuardFindings {
  declarations: GuardDeclaration[];
  blind: BlindGuardSite[];
  /** Paths a Clerk-style `publicRoutes` list declares anonymous. A positive negative. */
  publicPatterns: string[];
}

/**
 * Read every guard declaration in the repo.
 *
 * Phase one of two. It does not decide anything about a route: it collects what
 * the source SAYS, and `resolveGuards` applies it. Splitting them is what lets
 * a declaration that matched no route still be reported — a middleware matcher
 * for `/admin/:path*` in a repo whose inventory has no `/admin` is evidence
 * that our route detectors missed an admin area, and that is a fact about OUR
 * error rate rather than about the customer's app.
 */
function collectGuards(
  files: AnalysedFile[],
  ledger: Ledger,
  shortfalls: Shortfalls,
): GuardFindings {
  const declarations: GuardDeclaration[] = [];
  const blind: BlindGuardSite[] = [];
  const publicPatterns: string[] = [];
  let capped = 0;

  const declare = (declaration: GuardDeclaration): void => {
    if (declarations.length >= MAX_GUARD_DECLARATIONS) {
      capped++;
      return;
    }
    declarations.push(declaration);
    ledger.hit('route-guards');
  };

  for (const file of files) {
    const base = basename(file.path);
    const stem = base.replace(/\.[^.]+$/, '');
    const isMiddleware = /^middleware$/.test(stem) && SERVER_EXT.test(base);
    const isLayout = /^(?:layout|\+layout(?:\.server|\.ts)?|_app)$/.test(stem);
    const guardShaped = isMiddleware || isLayout;

    // ── Route groups: readable from the PATH alone, so no body is needed ──
    for (const segment of file.path.split('/')) {
      const group = /^\((.+)\)$/.exec(segment);
      if (!group) continue;
      const word = group[1] ?? '';
      const isAuthWord = AUTH_GROUP_WORD.test(word);
      const isRoleWord = ROLE_GROUP_WORD.test(word);
      if (!isAuthWord && !isRoleWord) continue;
      if (!PAGE_EXT.test(base)) continue;
      if (stem !== 'page' && stem !== 'route') continue;
      ledger.examine('route-guards');
      declare({
        kind: 'NEXT_ROUTE_GROUP',
        file: file.path,
        line: null,
        patterns: [],
        roles: isRoleWord ? [word] : null,
        evidence: isRoleWord
          ? `${file.path} sits in the route group (${word}), whose name is the only basis for the role claim`
          : `${file.path} sits in the route group (${word}), which names the access rule`,
      });
      break;
    }

    if (!guardShaped && file.content === undefined) continue;

    if (guardShaped && file.content === undefined) {
      ledger.examine('route-guards');
      ledger.starve('route-guards');
      blind.push({
        file: file.path,
        coversPrefix: isMiddleware ? null : layoutPrefix(file.path),
        why: isMiddleware
          ? 'a middleware file whose body was not uploaded, so what it intercepts is unknown'
          : 'a layout whose body was not uploaded, so whether it redirects anonymous visitors is unknown',
      });
      shortfalls.note(
        'route-guards',
        'NO_CONTENT',
        `${file.path} is a guard site (${isMiddleware ? 'middleware' : 'layout'}) and no body was uploaded, so every route it could cover is UNKNOWN rather than public`,
      );
      continue;
    }

    const content = file.content;
    if (content === undefined) continue;

    // ── Next.js middleware ──
    if (isMiddleware) {
      ledger.examine('route-guards');
      const guards = GUARD_NAME.test(content) || SESSION_READ.test(content);
      const redirectsToLogin = LOGIN_TARGET.test(content) && /\bredirect\b/.test(content);
      if (!guards && !redirectsToLogin) {
        // Read, and it is not a guard — an i18n rewrite, a header shim. Saying
        // nothing here is correct: the routes stay eligible for UNGUARDED
        // because we DID read the one file that could have guarded them.
        continue;
      }
      const matcher = literalList(content, 'matcher');
      const publics = literalList(content, 'publicRoutes');
      for (const pattern of publics.values) {
        if (!publicPatterns.includes(pattern)) publicPatterns.push(pattern);
      }

      const unreadable = matcher.values.filter((p) => matcherToTest(p) === null);
      const readable = matcher.values.filter((p) => matcherToTest(p) !== null);

      if (!matcher.sawValue || matcher.values.length === 0) {
        /*
         * A guard middleware with no matcher runs on EVERY request — that is
         * Next's documented default — so it covers everything. We know that,
         * and we also cannot read which requests its own body lets through, so
         * the honest coverage is "could be anything" rather than "all guarded".
         */
        blind.push({
          file: file.path,
          coversPrefix: null,
          why: 'a guard middleware that declares no matcher, so it runs on every request and we cannot read which ones it lets through',
        });
        shortfalls.note(
          'route-guards',
          'EXPRESSION_NOT_LITERAL',
          `${file.path} guards requests and declares no literal matcher, so which routes it covers was not read`,
        );
        continue;
      }
      if (unreadable.length > 0) {
        blind.push({
          file: file.path,
          coversPrefix: null,
          why: `a middleware matcher written as a regular expression (${unreadable[0]}), which this static pass does not translate`,
        });
        shortfalls.note(
          'route-guards',
          'EXPRESSION_NOT_LITERAL',
          `${file.path} declares ${unreadable.length} matcher pattern(s) written as regular expressions; they were not translated, so the routes they could cover are UNKNOWN`,
          unreadable.length,
        );
      }
      if (readable.length > 0) {
        const at = content.indexOf('matcher');
        declare({
          kind: 'NEXT_MIDDLEWARE',
          file: file.path,
          line: at === -1 ? null : lineAt(content, at),
          patterns: readable,
          roles: rolesDeclaredIn(content),
          evidence: `${file.path} is Next.js middleware whose matcher covers ${readable.join(', ')}, and its body reads a session`,
        });
      }
      continue;
    }

    // ── A layout that redirects an anonymous visitor ──
    if (isLayout) {
      ledger.examine('route-guards');
      const redirects = /\bredirect\s*\(|\bthrow\s+redirect\b|\bnavigate\s*\(/.test(content);
      if (redirects && SESSION_READ.test(content) && LOGIN_TARGET.test(content)) {
        const at = content.search(/\bredirect\s*\(/);
        declare({
          kind: 'LAYOUT_REDIRECT',
          file: file.path,
          line: at === -1 ? null : lineAt(content, at),
          patterns: [layoutPrefix(file.path)],
          roles: rolesDeclaredIn(content),
          evidence: `${file.path} reads a session and redirects to a login path, so it guards everything under ${layoutPrefix(file.path)}`,
        });
      }
      continue;
    }

    // ── Decorators: Nest and Spring ──
    if (/@UseGuards\s*\(|@PreAuthorize\s*\(|@Secured\s*\(|@Roles\s*\(/.test(content)) {
      ledger.examine('route-guards');
      const mixed = PUBLIC_MARKER.test(content);
      const at = content.search(/@(?:UseGuards|PreAuthorize|Secured|Roles)\s*\(/);
      declare({
        kind: 'DECORATOR',
        file: file.path,
        line: at === -1 ? null : lineAt(content, at),
        patterns: [],
        roles: rolesDeclaredIn(content),
        evidence: mixed
          ? `${file.path} declares a guard decorator AND an explicit public marker, so which of its handlers are guarded was not read`
          : `${file.path} declares a guard decorator on the handlers it contains`,
      });
      if (mixed) {
        blind.push({
          file: file.path,
          coversPrefix: null,
          why: `${file.path} mixes a guard decorator with an explicit public marker, and this pass cannot say which handler is which`,
        });
        shortfalls.note(
          'route-guards',
          'EXPRESSION_NOT_LITERAL',
          `${file.path} mixes a guard decorator with a public marker; per-handler resolution needs the decorator-to-method binding a static pass over text does not have`,
        );
      }
    }

    // ── An Express/Koa middleware chain ──
    if (/\b(?:app|router|server|fastify)\s*\.\s*(?:use|get|post|put|patch|delete|all)\s*\(/.test(content)) {
      // `app.use(requireAuth)` with no path guards everything the file declares
      // after it. Scoped to the file because resolving what else mounts this
      // router needs an import graph, which rule 4 of this module's header
      // forbids inventing.
      const blanket = new RegExp(
        `\\b(?:app|router|server|fastify)\\s*\\.\\s*use\\s*\\(\\s*(?:${GUARD_NAME_BODY})\\b`,
      ).exec(content);
      if (blanket) {
        ledger.examine('route-guards');
        declare({
          kind: 'MIDDLEWARE_CHAIN',
          file: file.path,
          line: lineAt(content, blanket.index),
          patterns: [],
          roles: rolesDeclaredIn(content),
          evidence: `${file.path} installs a guard with .use() before the routes it declares`,
        });
      }

      // `app.get('/admin', requireAuth, handler)` — the path is right there.
      for (const m of content.matchAll(
        /*
         * The tail runs to the end of the line, NOT to the first `)`.
         * `app.post('/x', requireRole('ADMIN'), handler)` has a `)` inside the
         * guard's own argument list, so `[^)]*` cut the tail to
         * `requireRole('ADMIN'` — an unbalanced fragment that no role pattern
         * can match, and the route came out GUARDED WITH NO ROLE. A guarded
         * route whose role we dropped is a route × role matrix with an empty
         * cell where the only interesting cell was.
         */
        /\b(?:app|router|server|fastify)\s*\.\s*(?:get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`\n]{1,300})['"`]\s*,([^\n;]{0,400})/g,
      )) {
        const rest = m[2] ?? '';
        if (!GUARD_NAME.test(rest)) continue;
        ledger.examine('route-guards');
        declare({
          kind: 'MIDDLEWARE_CHAIN',
          file: file.path,
          line: lineAt(content, m.index ?? 0),
          patterns: [normaliseRoute(paramsToColon(m[1] ?? ''))],
          roles: rolesDeclaredIn(rest),
          evidence: `${file.path} registers ${normaliseRoute(paramsToColon(m[1] ?? ''))} with a guard between the path and the handler`,
        });
      }

      /*
       * ── A MIDDLEWARE WE COULD NOT RESOLVE IS NOT AN ABSENT GUARD ──────────
       *
       * This is the case the whole three-valued verdict exists for, and it was
       * the one case that still fell through to UNGUARDED.
       *
       *   app.get('/exports', policyFor('finance'), handler)
       *   app.get('/vault', ...buildChain('admin'), handler)
       *   app.get('/reports', middlewares.admin, handler)
       *
       * Every one of those has a guard sitting in the chain under a name this
       * pass cannot follow — resolving `policyFor` needs the import graph rule
       * 4 of this module's header forbids inventing. `GUARD_NAME` does not
       * match, the loop above declares nothing, and `resolveGuards` then found
       * no declaration and no blind site and answered UNGUARDED: "the guard
       * pass read this route's own declaration sites and found no guard". We
       * read the declaration site and found a middleware we could not read,
       * which is the opposite claim.
       *
       * UNGUARDED is spent downstream as a POSITIVE claim of public access — it
       * is what makes a plan propose an anonymous scenario — so an admin
       * endpoint came out uncovered-and-public, got an anonymous smoke test,
       * and the 401 was recorded as the page.
       *
       * ── WHAT IS DELIBERATELY NOT CLOUDED ──────────────────────────────────
       *
       * A two-argument registration: `app.get('/health', handler)` has no
       * middleware at all, so UNGUARDED there is earned and stays.
       *
       * An INLINE function in the middle: its body is right here, `GUARD_NAME`
       * and `SESSION_READ` have both had a look at it, and a route whose own
       * middleware we read is a route we are entitled to speak about. Only a
       * bare identifier, a member access, a call or a spread — something whose
       * definition is elsewhere — makes the chain unreadable.
       *
       * The site names the ARGUMENT, so a human can dismiss `cors()` in one
       * glance instead of distrusting the verdict. We cannot tell `cors()` from
       * `policyFor('finance')` without the import graph, and saying so is
       * cheaper than being wrong in the flattering direction.
       */
      for (const m of content.matchAll(
        /\b(?:app|router|server|fastify)\s*\.\s*(?:get|post|put|patch|delete|all)\s*\(/g,
      )) {
        const openAt = (m.index ?? 0) + m[0].length - 1;
        const args = callArguments(content, openAt);
        if (args === null) continue;
        const rawPath = /^['"`]([^'"`\n]{1,300})['"`]$/.exec(args[0] ?? '');
        if (!rawPath) continue;
        const after = args.slice(1);
        // Already declared GUARDED by the loop above; nothing is unread.
        if (GUARD_NAME.test(after.join(','))) continue;
        const unresolved = after.filter((arg, at) => {
          if (arg.length === 0) return false;
          // A spread can hide any number of middlewares, including the handler,
          // so it is unreadable wherever it sits.
          if (arg.startsWith('...')) return true;
          // The last argument is the handler, not a middleware in front of it.
          if (at === after.length - 1) return false;
          return !INLINE_FUNCTION.test(arg);
        });
        if (unresolved.length === 0) continue;
        const route = normaliseRoute(paramsToColon(rawPath[1] ?? ''));
        ledger.examine('route-guards');
        ledger.starve('route-guards');
        blind.push({
          file: file.path,
          coversPrefix: route,
          inFileOnly: true,
          why:
            `${file.path} registers ${route} with ${unresolved[0]} between the path and the ` +
            'handler, and whether that is a guard needs the import graph this pass does not have',
        });
        shortfalls.note(
          'route-guards',
          'UNRESOLVED_IMPORT',
          `${file.path} registers ${route} behind a middleware (${unresolved[0]}) declared elsewhere, so whether it is guarded is UNKNOWN rather than public`,
        );
      }
    }

    // ── A React Router loader that redirects ──
    if (/react-router/.test(content)) {
      // JSX: both attributes live in one tag, so the binding is exact.
      for (const m of content.matchAll(
        /<Route\b([^>]{0,600}?)\/?>/g,
      )) {
        const tag = m[1] ?? '';
        if (!/\bloader\s*=/.test(tag) || !GUARD_NAME.test(tag)) continue;
        const path = attr(tag, 'path');
        if (path === null) continue;
        ledger.examine('route-guards');
        declare({
          kind: 'ROUTER_LOADER',
          file: file.path,
          line: lineAt(content, m.index ?? 0),
          patterns: [normaliseRoute(path)],
          roles: rolesDeclaredIn(tag),
          evidence: `${file.path} gives <Route path="${path}"> a guard loader`,
        });
      }
      /*
       * Objects: bounded to the window between this `path:` and the next one,
       * so a guard loader on a sibling record cannot be credited to this one.
       * The window is the honest limit of a text scan — a nested `children:`
       * array can still put a descendant's loader inside it, which is why the
       * evidence names the window rather than claiming a resolved binding.
       */
      for (const m of content.matchAll(
        /\bpath\s*:\s*['"`]([^'"`\n]{1,300})['"`]([\s\S]{0,400}?)(?=\bpath\s*:|$)/g,
      )) {
        const window = m[2] ?? '';
        if (!/\bloader\s*:/.test(window) || !GUARD_NAME.test(window)) continue;
        ledger.examine('route-guards');
        declare({
          kind: 'ROUTER_LOADER',
          file: file.path,
          line: lineAt(content, m.index ?? 0),
          patterns: [normaliseRoute(m[1] ?? '')],
          roles: rolesDeclaredIn(window),
          evidence: `${file.path} declares a route record for ${normaliseRoute(m[1] ?? '')} whose loader is a guard`,
        });
      }
    }

    // ── An auth wrapper around the file's own default export ──
    const wrapped =
      /export\s+default\s+(?:async\s+)?(withAuth|withPageAuthRequired|withApiAuthRequired|withAuthenticationRequired|requireAuth|requireUser|protect)\s*\(/.exec(
        content,
      );
    if (wrapped) {
      ledger.examine('route-guards');
      declare({
        kind: 'AUTH_WRAPPER',
        file: file.path,
        line: lineAt(content, wrapped.index),
        patterns: [],
        roles: rolesDeclaredIn(content),
        evidence: `${file.path} exports its default through ${wrapped[1]}(), which guards it`,
      });
    }
  }

  if (capped > 0) {
    shortfalls.note(
      'route-guards',
      'CAP_REACHED',
      `more than ${MAX_GUARD_DECLARATIONS} guard declarations were found; the rest were not recorded, so at least ${capped} more exist`,
      capped,
    );
  }

  return { declarations, blind, publicPatterns };
}

/**
 * Apply the declarations to the routes and endpoints already collected.
 *
 * Phase two. Every item gets a verdict — there is no "we skipped this one" —
 * because an item with no `guard` at all is indistinguishable from an analysis
 * that predates this pass, and that ambiguity is the thing `PageRoute.guard`'s
 * doc comment promises not to produce.
 */
function resolveGuards(
  out: Collector,
  findings: GuardFindings,
  anyContent: boolean,
  filesWithoutContent: ReadonlySet<string>,
): void {
  const covering = (path: string, file: string): GuardDeclaration[] =>
    findings.declarations.filter((declaration) =>
      declaration.patterns.length === 0
        ? declaration.file === file || isAncestorGuard(declaration, file)
        : patternsCover(declaration.patterns, path),
    );

  /*
   * A blind site clouds a route only when it could actually cover it: the same
   * FILE, a layout whose prefix matches, or a middleware, which covers
   * everything.
   *
   * `dirname(site.file) === dirname(file)` used to be in this list and was far
   * too broad — one Nest controller mixing a guard with a `@Public()` marker
   * turned every endpoint declared anywhere in `src/` UNKNOWN. UNKNOWN is the
   * safe direction, but UNKNOWN everywhere is not honesty, it is an unusable
   * report: the customer learns nothing and the route × role matrix has no
   * ground truth to check the crawl against. A declaration that matches no
   * route still surfaces in `analysis.guards`, which is the designed finding
   * for exactly this case.
   */
  const blindFor = (path: string, file: string): BlindGuardSite[] =>
    findings.blind.filter((site) => {
      if (site.coversPrefix === null) return site.file === file || isGlobalSite(site);
      if (site.inFileOnly === true) {
        return site.file === file && patternsCover([site.coversPrefix], path);
      }
      return patternsCover([site.coversPrefix], path);
    });

  const verdict = (path: string, file: string): RouteGuard => {
    const applying = covering(path, file);
    if (applying.length > 0) {
      const roles: string[] = [];
      for (const declaration of applying) {
        for (const role of declaration.roles ?? []) {
          if (!roles.includes(role)) roles.push(role);
        }
      }
      const mixed = applying.some((d) => d.evidence.includes('public marker'));
      if (mixed) {
        return {
          access: 'UNKNOWN',
          roles: null,
          declaredBy: applying,
          evidence: `${file} declares a guard and an explicit public marker; which of its handlers ${path} is was not read`,
        };
      }
      return {
        access: 'GUARDED',
        roles: roles.length > 0 ? roles : null,
        declaredBy: applying,
        evidence: applying.map((d) => d.evidence).join('; '),
      };
    }

    if (findings.publicPatterns.length > 0 && patternsCover(findings.publicPatterns, path)) {
      return {
        access: 'UNGUARDED',
        roles: null,
        declaredBy: [],
        evidence: `a publicRoutes list in the middleware config names ${path} as anonymous`,
      };
    }

    /*
     * Every reason we are not entitled to say UNGUARDED, in the order a reader
     * would ask about them. Each one ends in UNKNOWN, and UNKNOWN is the answer
     * that costs nothing: the crawl will try the route either way, and the
     * route × role matrix simply records that the source did not tell us.
     *
     * UNGUARDED, by contrast, is spent downstream as a POSITIVE claim — it is
     * what makes a plan propose an anonymous scenario — so it has to be earned.
     */
    if (!anyContent) {
      return {
        access: 'UNKNOWN',
        roles: null,
        declaredBy: [],
        evidence:
          'no file bodies were uploaded, so no guard could be read; this is our missing input, not a public route',
      };
    }
    const blind = blindFor(path, file);
    if (blind.length > 0) {
      return {
        access: 'UNKNOWN',
        roles: null,
        declaredBy: [],
        evidence: `a guard site above ${path} could not be read: ${blind[0]!.why}`,
      };
    }
    if (filesWithoutContent.has(file)) {
      return {
        access: 'UNKNOWN',
        roles: null,
        declaredBy: [],
        evidence: `${file} was uploaded as a path with no body, so a guard wrapper or decorator on it was not read`,
      };
    }
    return {
      access: 'UNGUARDED',
      roles: null,
      declaredBy: [],
      evidence: `no guard was found in ${file}, in any layout above it, or in any middleware matcher covering ${path}`,
    };
  };

  for (const route of out.routes) route.guard = verdict(route.route, route.file);
  for (const endpoint of out.endpoints) endpoint.guard = verdict(endpoint.path, endpoint.file);
}

/** A layout's or middleware's directory encloses this file's directory. */
function isAncestorGuard(declaration: GuardDeclaration, file: string): boolean {
  if (declaration.kind !== 'LAYOUT_REDIRECT' && declaration.kind !== 'NEXT_ROUTE_GROUP') {
    return false;
  }
  const guardDir = dirname(declaration.file);
  return file === declaration.file || file.startsWith(`${guardDir}/`);
}

/** A site with no readable scope, which therefore could cover any route. */
function isGlobalSite(site: BlindGuardSite): boolean {
  return site.coversPrefix === null && /middleware/.test(basename(site.file));
}

function detectRouteGuards(
  files: AnalysedFile[],
  out: Collector,
  ledger: Ledger,
  shortfalls: Shortfalls,
): GuardDeclaration[] {
  const findings = collectGuards(files, ledger, shortfalls);
  const anyContent = files.some((file) => file.content !== undefined);
  const withoutContent = new Set(
    files.filter((file) => file.content === undefined).map((file) => file.path),
  );
  resolveGuards(out, findings, anyContent, withoutContent);
  return findings.declarations;
}

// ─── The component inventory ─────────────────────────────────────────────────

/** Files that can declare a component, a hook or a provider. */
const MODULE_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.vue',
  '.svelte',
]);

/** A catalogue entry file: Storybook's CSF, and Ladle's and Histoire's copies of it. */
const STORY_PATH = /\.stories\.[cm]?[jt]sx?$|\.story\.[cm]?[jt]sx?$/;

/**
 * Exported names that are declarations rather than components.
 *
 * `metadata`, `config`, `generateStaticParams` and the HTTP verbs are framework
 * contracts: Next.js reads them, nothing renders them, and counting them as
 * exported components would pad the UNIT_GEN denominator with things no unit
 * test could ever be written for. A denominator padded with untestable entries
 * is worse than a small one — it makes the percentage fall for a reason the
 * customer cannot act on.
 */
const NOT_A_COMPONENT_EXPORT = new Set<string>([
  'metadata',
  'generateMetadata',
  'generateStaticParams',
  'generateViewport',
  'viewport',
  'config',
  'revalidate',
  'dynamic',
  'dynamicParams',
  'fetchCache',
  'runtime',
  'preferredRegion',
  'maxDuration',
  'loader',
  'action',
  'middleware',
  ...HTTP_METHODS,
]);

/** State kinds a story's own name declares. The CATALOGUE half of the inventory. */
const STORY_STATE_NAME: Array<{ pattern: RegExp; kind: ComponentStateKind }> = [
  { pattern: /^(?:loading|pending|fetching|skeleton)$/i, kind: 'LOADING' },
  { pattern: /^(?:empty|noresults|nodata|blank|zerostate)$/i, kind: 'EMPTY' },
  { pattern: /^(?:error|errored|failure|failed|errorstate)$/i, kind: 'ERROR' },
  { pattern: /^(?:forbidden|unauthorized|unauthorised|denied|noaccess|readonly)$/i, kind: 'FORBIDDEN' },
  { pattern: /^(?:slow|delayed|timeout|throttled)$/i, kind: 'SLOW' },
  { pattern: /^(?:default|basic|primary|normal|playground)$/i, kind: 'DEFAULT' },
];

/**
 * Render branches that declare a state, and the sentence each one justifies.
 *
 * SLOW is deliberately absent. A slow response is not a render branch — it is
 * reached by holding a response open — so no source pattern declares it, and
 * inventing one would report a measurement nobody took. It arrives from a
 * CATALOGUE entry named `Slow` or it does not arrive at all, and that is the
 * honest shape of the fact.
 */
const SOURCE_STATE_BRANCH: Array<{ pattern: RegExp; kind: ComponentStateKind; because: string }> = [
  {
    /*
     * `isLoading` is unambiguous on its own. A bare `loading` is not — it is
     * also a prop name, a CSS class and an import — so it only counts when it
     * is USED IN A BRANCH. Without that the detector would report a LOADING
     * state for every file containing the word, and a denominator padded with
     * states that do not exist is a percentage that falls for a reason the
     * customer cannot act on.
     */
    pattern:
      /\b(?:isLoading|isPending|isFetching|isValidating)\b|\b(?:loading|pending)\s*(?:\?|&&)|\bif\s*\(\s*!?\s*(?:loading|pending)\b/,
    kind: 'LOADING',
    because: 'branches on a loading flag',
  },
  {
    pattern: /\.length\s*===?\s*0|\.length\s*<\s*1|\b(?:isEmpty|hasNoResults|noResults)\b|!\w+\.length/,
    kind: 'EMPTY',
    because: 'branches on an empty collection',
  },
  {
    /* Same reasoning as LOADING: a bare `error` is the commonest identifier in
     * a catch block, which is not a render branch. */
    pattern:
      /\b(?:isError|hasError|isRejected)\b|<ErrorBoundary|componentDidCatch|\berror\s*(?:\?|&&)|\bif\s*\(\s*!?\s*error\b/,
    kind: 'ERROR',
    because: 'branches on an error',
  },
  {
    pattern:
      /\b(?:forbidden|unauthorized|unauthorised|canAccess|hasPermission|isAllowed|notAllowed)\b/i,
    kind: 'FORBIDDEN',
    because: 'branches on a permission check',
  },
];

/** Kinds that RENDER, and therefore have a happy path to be in. */
const RENDERABLE_KINDS: readonly ComponentItemKind[] = [
  'COMPONENT',
  'PAGE',
  'LAYOUT',
  'CONTEXT_PROVIDER',
];

interface ExportSite {
  name: string;
  /** Offset of the export, for the line number and for the body window. */
  index: number;
}

/**
 * Every name a module exports, with where it is declared.
 *
 * Text, not a parser, and the limits are stated rather than hidden: a name
 * re-exported from a barrel (`export * from './Button'`) is NOT listed, because
 * following it needs an import graph and rule 4 of this module's header forbids
 * inventing one. A barrel therefore contributes nothing instead of
 * contributing a plausible guess, and `components` counts the file the
 * component is actually declared in.
 */
function exportedNames(content: string): { sites: ExportSite[]; capped: number } {
  const sites: ExportSite[] = [];
  const seen = new Set<string>();
  let capped = 0;

  const add = (name: string, index: number): void => {
    if (name.length === 0 || seen.has(name)) return;
    if (sites.length >= MAX_EXPORTS_PER_FILE) {
      capped++;
      return;
    }
    seen.add(name);
    sites.push({ name, index });
  };

  for (const m of content.matchAll(
    /export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    add(m[1] ?? '', m.index ?? 0);
  }
  for (const m of content.matchAll(
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    add(m[1] ?? '', m.index ?? 0);
  }
  for (const m of content.matchAll(/export\s+default\s+(?:async\s+)?(?:function|class)\s*([A-Za-z_$][\w$]*)?/g)) {
    add('default', m.index ?? 0);
  }
  if (/export\s+default\s+(?!function|class)/.test(content)) {
    add('default', content.search(/export\s+default\s+/));
  }
  for (const m of content.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      const alias = part.split(/\s+as\s+/);
      const exported = (alias[alias.length - 1] ?? '').trim();
      const local = (alias[0] ?? '').trim();
      /*
       * Anchored at the LOCAL declaration when there is one, not at the
       * `export {}` statement. `function helper() { … }` followed by
       * `export { helper }` is one declaration seen from two places, and
       * anchoring on the export list gave the body window nothing but the list
       * itself — so the export was judged un-callable and dropped from the
       * inventory, and a helper the module plainly exports went missing from
       * the UNIT_GEN denominator.
       */
      const declaration =
        local.length > 0
          ? new RegExp(`\\b(?:function|class|const|let|var)\\s+${local.replace(/[^\w$]/g, '')}\\b`).exec(
              content,
            )
          : null;
      add(exported, declaration?.index ?? m.index ?? 0);
    }
  }
  return { sites, capped };
}

/**
 * Where a component's body ends, for the purpose of reading its branches.
 *
 * The window stops at the next export so one component's loading state is not
 * credited to its neighbour. It is a window and not a scope — a nested helper
 * declared inside the component is inside it, which is correct, and a branch in
 * a sibling `function` between two exports is also inside it, which is the
 * limit a text scan has. The evidence sentence names the component, so a
 * customer who disagrees can see which body was read.
 */
function bodyWindow(content: string, sites: readonly ExportSite[], at: number): string {
  let end = content.length;
  for (const site of sites) {
    if (site.index > at && site.index < end) end = site.index;
  }
  return content.slice(at, Math.min(end, at + 20_000));
}

/** Which of the six kinds this export is, from its name, its file and its body. */
function classifyExport(
  path: string,
  name: string,
  body: string,
  ext: string,
): ComponentItemKind | null {
  if (NOT_A_COMPONENT_EXPORT.has(name)) return null;

  const base = basename(path);
  const stem = base.replace(/\.[^.]+$/, '');
  const inAppTree = /(?:^|\/)(?:src\/)?app\//.test(path);
  const inPagesRouterTree = /(?:^|\/)(?:src\/)?pages\//.test(path);
  const inRoutesTree = /(?:^|\/)src\/routes\//.test(path);

  if (/^(?:layout|\+layout(?:\.server)?|_app|_document)$/.test(stem)) return 'LAYOUT';
  /*
   * PAGE is decided by the SAME convention the route detectors use, and by
   * nothing looser. In an `app/` tree only `page.*` is a page; `pages/` is the
   * flat router where every module IS a page. Reading `app/_components/
   * Button.tsx` as a page because it sits under `app/` and has a default
   * export would count a button on the ROUTE axis — the double count
   * `componentHasOwnAxis` exists to prevent, arriving by the back door.
   */
  if (name === 'default' && (stem === 'page' || stem === '+page') && (inAppTree || inRoutesTree)) {
    return 'PAGE';
  }
  if (
    name === 'default' &&
    inPagesRouterTree &&
    PAGE_EXT.test(base) &&
    !stem.startsWith('_') &&
    !/(?:^|\/)pages\/api\//.test(path)
  ) {
    return 'PAGE';
  }

  if (/^use[A-Z]/.test(name)) return 'HOOK';
  if (/Provider$/.test(name) || /createContext\s*[<(]/.test(body)) return 'CONTEXT_PROVIDER';

  /*
   * A component is a PascalCase export that renders. `default` has no case to
   * read, so the file's own name stands in for it — which is exactly how a
   * human reads `export default function () {}` in `Button.tsx`.
   */
  const named = name === 'default' ? stem : name;
  const looksLikeComponent = /^[A-Z]/.test(named);
  const renders =
    ext === '.vue' ||
    ext === '.svelte' ||
    /return\s*\(?\s*</.test(body) ||
    /=>\s*\(?\s*</.test(body) ||
    /\bjsx\b|createElement|h\(/.test(body);

  if (looksLikeComponent && renders) return 'COMPONENT';

  /*
   * UTILITY is "an exported helper", and a helper is something you can CALL.
   * `export const locales = ['en','de']` is data, and so is
   * `export const beta = process.env.FEATURE_BETA === 'true'` — neither is a
   * subject a unit test could be written against, so neither belongs in the
   * UNIT_GEN denominator. Counting them would make the percentage fall for a
   * reason the customer cannot act on, which is the mirror image of the
   * missing-surface problem rather than a cure for it.
   *
   * It also stops a double count the other way: `export const billingRouter =
   * createTRPCRouter({...})` is already enumerated procedure by procedure on
   * the BACKGROUND_JOB axis, and `componentHasOwnAxis` exists precisely to
   * keep one surface out of two denominators.
   */
  return isCallableExport(body, name) ? 'UTILITY' : null;
}

/**
 * Is this export something you can CALL?
 *
 * Judged on the INITIALISER and not on the body, which is the distinction that
 * makes it work. `export const billingRouter = createTRPCRouter({ list:
 * publicProcedure.query(() => []) })` has an arrow function inside it, so a
 * scan of the first 400 characters called it callable — and it was then
 * counted as a helper on the component axis WHILE its two procedures were
 * counted on the BACKGROUND_JOB axis. One surface in two denominators is
 * exactly what `componentHasOwnAxis` exists to prevent, and it got in through
 * a loose regex rather than through the door that guard watches.
 */
function isCallableExport(body: string, name: string): boolean {
  /*
   * The `export` keyword is OPTIONAL here, because the body window may be
   * anchored at a LOCAL declaration rather than at an export statement:
   * `function toCents() {}` followed by `export { toCents }` is one
   * declaration seen from two places. Requiring the keyword dropped every
   * helper exported through a list — a real shrink of the UNIT_GEN
   * denominator, caused by the very fix that was meant to find them.
   */
  if (/^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class)\b/.test(body)) return true;
  const declared = new RegExp(
    `\\b${name === 'default' ? 'default' : name.replace(/[^\w$]/g, '')}\\b\\s*=\\s*([\\s\\S]{0,120})`,
  ).exec(body);
  const initialiser = declared?.[1];
  if (initialiser === undefined) return false;
  return /^\s*(?:async\s+)?(?:function\b|\(|<|[A-Za-z_$][\w$]*\s*=>)/.test(initialiser);
}

/**
 * A one-line props summary, never the full type.
 *
 * `allowDeclaredType` is false for a hook and a helper, and that is not a
 * nicety. The declared-`Props`-interface fallback searches the WHOLE FILE, so
 * `export function formatMoney()` sitting next to a `ButtonProps` interface was
 * handed the button's props — a doc comment reading "a one-line summary of the
 * props" over a value that describes a different export. Only something that
 * renders is allowed that fallback; the destructure path reads the export's own
 * signature and is safe for anything.
 */
function propsSummaryFor(
  content: string,
  body: string,
  allowDeclaredType: boolean,
): string | null {
  const destructured = /\(\s*\{([^}]{1,400})\}/.exec(body);
  if (destructured) {
    const names = (destructured[1] ?? '')
      .split(',')
      .map((part) => (part.split(/[:=]/)[0] ?? '').trim().replace(/^\.\.\./, ''))
      .filter((part) => /^[A-Za-z_$][\w$]*$/.test(part));
    if (names.length > 0) return `props: ${names.slice(0, 20).join(', ')}`;
  }
  if (!allowDeclaredType) return null;
  // A declared Props type is the next best thing, and it is still one line.
  const declared = /(?:interface|type)\s+\w*Props\w*\s*(?:=\s*)?\{([^}]{1,600})\}/.exec(content);
  if (declared) {
    /*
     * `;` and `,` separate members as validly as a newline does. Keying only
     * on `\n` read `interface Props { tone: string; onPress: () => void }` as
     * a one-prop type, so a single-line interface — which is how most small
     * ones are written — lost every member after the first.
     */
    const keys = [
      ...(declared[1] ?? '').matchAll(/(?:^|[\n;,])\s*([A-Za-z_$][\w$]*)\s*\??\s*:/g),
    ].map((m) => m[1] ?? '');
    if (keys.length > 0) return `props: ${keys.slice(0, 20).join(', ')}`;
  }
  return null;
}

/** `Button.stories.tsx` → the catalogue entries it declares, by component name. */
interface CatalogueEntry {
  /** The CSF `title`, which is the entry id a human recognises. */
  title: string | null;
  file: string;
  /** The named exports, which are the stories. */
  stories: string[];
}

/**
 * Read the catalogue, and report whether one was read AT ALL.
 *
 * `read: false` is the reason this returns a record rather than a map. A repo
 * with no Storybook must leave `hasCatalogueEntry` NULL on every component —
 * `false` there would say "a catalogue was read and this component is not in
 * it", a measured claim about a measurement nobody took. The two look the same
 * on a screen and mean opposite things to a customer deciding whether to go and
 * write stories.
 */
function readCatalogue(
  files: AnalysedFile[],
  ledger: Ledger,
  shortfalls: Shortfalls,
): { read: boolean; byComponent: Map<string, CatalogueEntry> } {
  const byComponent = new Map<string, CatalogueEntry>();
  let read = false;

  for (const file of files) {
    if (!STORY_PATH.test(file.path)) continue;
    read = true;
    ledger.examine('component-inventory');
    if (file.content === undefined) {
      shortfalls.note(
        'component-inventory',
        'NO_CONTENT',
        `${file.path} is a catalogue entry whose body was not uploaded, so the states it declares were not read`,
      );
      // The file's NAME still proves a catalogue entry exists for its sibling —
      // `Button.stories.tsx` is about `Button` by Storybook's own convention —
      // so the component is not demoted to "no story" for want of a body.
      const subject = basename(file.path).replace(STORY_PATH, '');
      if (subject.length > 0 && !byComponent.has(subject)) {
        byComponent.set(subject, { title: null, file: file.path, stories: [] });
      }
      continue;
    }

    const content = file.content;
    const title = /\btitle\s*:\s*['"`]([^'"`\n]{1,200})['"`]/.exec(content)?.[1] ?? null;
    const componentRef = /\bcomponent\s*:\s*([A-Za-z_$][\w$]*)/.exec(content)?.[1] ?? null;
    const stories = exportedNames(content)
      .sites.map((site) => site.name)
      .filter((name) => name !== 'default');

    const subjects = new Set<string>();
    if (componentRef) subjects.add(componentRef);
    const fromName = basename(file.path).replace(STORY_PATH, '');
    if (fromName.length > 0) subjects.add(fromName);
    // The last segment of the CSF title: `Forms/LoginForm` is about LoginForm.
    if (title) {
      const leaf = title.split('/').pop()?.trim();
      if (leaf && /^[A-Za-z_$][\w$]*$/.test(leaf)) subjects.add(leaf);
    }

    for (const subject of subjects) {
      const existing = byComponent.get(subject);
      if (existing) {
        for (const story of stories) {
          if (!existing.stories.includes(story)) existing.stories.push(story);
        }
        continue;
      }
      byComponent.set(subject, { title, file: file.path, stories: [...stories] });
    }
    /*
     * No `ledger.hit` here. `found` on this detector counts COMPONENTS, and
     * crediting it with stories would make the report claim more components
     * than the inventory holds — a number that disagrees with the list beside
     * it is the one thing a customer checks first.
     */
  }

  return { read, byComponent };
}

function detectComponents(
  files: AnalysedFile[],
  ledger: Ledger,
  shortfalls: Shortfalls,
): SourceComponent[] {
  const catalogue = readCatalogue(files, ledger, shortfalls);
  const components: SourceComponent[] = [];
  let capped = 0;
  let exportsCapped = 0;

  for (const file of files) {
    if (!MODULE_EXT.has(file.ext)) continue;
    if (STORY_PATH.test(file.path)) continue;
    ledger.examine('component-inventory');
    if (file.content === undefined) {
      /*
       * A module whose body was never uploaded declares an unknown number of
       * components. Counted and named, because the alternative — saying nothing
       * — is the undisclosed cap: the components in it are absent from the
       * UNIT_GEN denominator rather than uncovered, and absent raises the
       * percentage while uncovered lowers it.
       */
      shortfalls.note(
        'component-inventory',
        'NO_CONTENT',
        `${file.path} was uploaded as a path with no body, so the components it exports were not counted`,
      );
      continue;
    }

    const { sites, capped: localCap } = exportedNames(file.content);
    exportsCapped += localCap;

    for (const site of sites) {
      const body = bodyWindow(file.content, sites, site.index);
      const kind = classifyExport(file.path, site.name, body, file.ext);
      if (kind === null) continue;

      if (components.length >= MAX_COMPONENTS) {
        capped++;
        continue;
      }

      const entry =
        catalogue.byComponent.get(site.name) ??
        (site.name === 'default'
          ? catalogue.byComponent.get(basename(file.path).replace(/\.[^.]+$/, ''))
          : undefined);

      const states: SourceComponentState[] = [];
      const addState = (state: SourceComponentState): void => {
        if (states.length >= MAX_STATES_PER_COMPONENT) return;
        if (states.some((s) => s.kind === state.kind && s.source === state.source)) return;
        states.push(state);
      };

      if (RENDERABLE_KINDS.includes(kind)) {
        addState({
          kind: 'DEFAULT',
          source: 'SOURCE',
          evidence: `${site.name} in ${file.path} renders, so it has a happy path`,
        });
      }
      for (const branch of SOURCE_STATE_BRANCH) {
        if (!branch.pattern.test(body)) continue;
        addState({
          kind: branch.kind,
          source: 'SOURCE',
          evidence: `${site.name} ${branch.because} in ${file.path}`,
        });
      }
      for (const story of entry?.stories ?? []) {
        const match = STORY_STATE_NAME.find((candidate) => candidate.pattern.test(story));
        if (!match) continue;
        addState({
          kind: match.kind,
          source: 'CATALOGUE',
          evidence: `the story "${story}" in ${entry?.file ?? 'the catalogue'} declares this state`,
        });
      }

      components.push({
        modulePath: file.path,
        exportName: site.name,
        kind,
        propsSummary: propsSummaryFor(file.content, body, RENDERABLE_KINDS.includes(kind)),
        /*
         * The three states, decided here and nowhere else. Null when no
         * catalogue was read anywhere in the repo; false when one was and this
         * component is absent from it; true when it is in it.
         */
        hasCatalogueEntry: catalogue.read ? entry !== undefined : null,
        catalogueRef: entry?.title ?? entry?.file ?? null,
        evidence: `${file.path} exports ${site.name}${
          site.name === 'default' ? ' (the default export)' : ''
        } — classified ${kind}`,
        line: lineAt(file.content, site.index),
        states,
      });
      ledger.hit('component-inventory');
    }
  }

  if (capped > 0) {
    shortfalls.note(
      'component-inventory',
      'CAP_REACHED',
      `more than ${MAX_COMPONENTS} components were found; the rest were not recorded, so at least ${capped} more exist`,
      capped,
    );
  }
  if (exportsCapped > 0) {
    shortfalls.note(
      'component-inventory',
      'CAP_REACHED',
      `${exportsCapped} export(s) past the per-file cap of ${MAX_EXPORTS_PER_FILE} were not examined`,
      exportsCapped,
    );
  }
  return components;
}

// ─── Surfaces off the HTTP request path ──────────────────────────────────────

/**
 * The detectors for everything an application does that no crawl can reach.
 *
 * This is the half of the surface that was not merely uncovered but ABSENT.
 * QAAI's PROTOCOL and EMAIL_OTP runners already EXECUTE these surfaces — they
 * drive a webhook, they read a mailbox — so the product could test a cron it
 * could not count, and a denominator that omits what the numerator includes is
 * the one arithmetic error a customer will reproduce in a spreadsheet.
 */
function detectBackgroundSurfaces(
  files: AnalysedFile[],
  ledger: Ledger,
  shortfalls: Shortfalls,
): SourceBackgroundSurface[] {
  const found: SourceBackgroundSurface[] = [];
  let capped = 0;

  const add = (
    fact: BackgroundSurfaceFact,
    file: string,
    index: number | null,
    content: string | null,
    evidence: string,
  ): void => {
    if (found.length >= MAX_BACKGROUND_SURFACES) {
      capped++;
      return;
    }
    const identity = `${fact.kind}|${backgroundIdentity(fact)}`;
    if (found.some((existing) => `${existing.fact.kind}|${backgroundIdentity(existing.fact)}` === identity)) {
      return;
    }
    found.push({
      fact,
      file,
      line: index !== null && content !== null ? lineAt(content, index) : null,
      evidence,
    });
    ledger.hit('background-surfaces');
  };

  for (const file of files) {
    const base = basename(file.path);

    // ── vercel.json crons: JSON, so it parses or it is reported as unparseable ──
    if (base === 'vercel.json') {
      ledger.examine('background-surfaces');
      if (file.content === undefined) {
        ledger.starve('background-surfaces');
        shortfalls.note(
          'background-surfaces',
          'NO_CONTENT',
          `${file.path} declares the project's crons and its body was not uploaded`,
        );
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(file.content);
      } catch {
        shortfalls.note(
          'background-surfaces',
          'UNPARSEABLE',
          `${file.path} is not valid JSON, so the crons it declares were not read`,
        );
        continue;
      }
      const crons =
        parsed !== null && typeof parsed === 'object' && 'crons' in parsed
          ? (parsed as { crons?: unknown }).crons
          : undefined;
      if (Array.isArray(crons)) {
        for (const entry of crons) {
          if (entry === null || typeof entry !== 'object') continue;
          const row = entry as { path?: unknown; schedule?: unknown };
          if (typeof row.schedule !== 'string' || row.schedule.length === 0) continue;
          add(
            {
              kind: 'CRON',
              expression: row.schedule,
              handler: typeof row.path === 'string' ? row.path : null,
            },
            file.path,
            file.content.indexOf('"crons"'),
            file.content,
            `${file.path} declares a Vercel cron at ${row.schedule}${
              typeof row.path === 'string' ? ` hitting ${row.path}` : ''
            }`,
          );
        }
      }
      continue;
    }

    // ── GitHub Actions schedules ──
    if (/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(file.path)) {
      ledger.examine('background-surfaces');
      if (file.content === undefined) {
        ledger.starve('background-surfaces');
        shortfalls.note(
          'background-surfaces',
          'NO_CONTENT',
          `${file.path} may declare a schedule and its body was not uploaded`,
        );
        continue;
      }
      for (const m of file.content.matchAll(/-\s*cron\s*:\s*['"]?([^'"\n]{1,120}?)['"]?\s*$/gm)) {
        const expression = (m[1] ?? '').trim();
        if (expression.length === 0) continue;
        add(
          { kind: 'CRON', expression, handler: file.path },
          file.path,
          m.index ?? 0,
          file.content,
          `${file.path} is a scheduled GitHub Actions workflow running at ${expression}`,
        );
      }
      continue;
    }

    if (file.content === undefined) continue;
    const content = file.content;
    if (!MODULE_EXT.has(file.ext) && file.ext !== '.py' && file.ext !== '.rb') continue;

    /*
     * Once per FILE, because that is what `filesExamined` means. Calling it per
     * match would turn the honesty surface into a count of regex hits, and a
     * detector reporting 400 files examined in a 40-file repo is a report
     * nobody can use to check us.
     */
    ledger.examine('background-surfaces');

    // ── node-cron / @nestjs/schedule / cron ──
    for (const m of content.matchAll(
      /(?:cron\s*\.\s*schedule|new\s+CronJob|@Cron|schedule\s*\.\s*scheduleJob)\s*\(\s*['"`]([^'"`\n]{1,120})['"`]/g,
    )) {
      add(
        { kind: 'CRON', expression: m[1] ?? '', handler: file.path },
        file.path,
        m.index ?? 0,
        content,
        `${file.path} schedules a job at ${m[1] ?? ''}`,
      );
    }
    // `@Cron(CronExpression.EVERY_HOUR)` — the enum member names the schedule
    // just as plainly, and it is NOT normalised to an expression: surface.ts
    // requires the schedule as written.
    for (const m of content.matchAll(/@Cron\s*\(\s*(CronExpression\s*\.\s*[A-Z0-9_]+)\s*\)/g)) {
      add(
        { kind: 'CRON', expression: (m[1] ?? '').replace(/\s+/g, ''), handler: file.path },
        file.path,
        m.index ?? 0,
        content,
        `${file.path} schedules a job at ${(m[1] ?? '').replace(/\s+/g, '')}`,
      );
    }

    // ── Queue consumers ──
    for (const m of content.matchAll(
      /new\s+(?:Worker|Queue|QueueScheduler)\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`\n]{1,120})['"`]([\s\S]{0,600})/g,
    )) {
      /*
       * The window spans newlines and the handler's own parentheses, because
       * `concurrency` comes AFTER them: `new Worker('q', async (job) => {...},
       * { concurrency: 5 })`. A `[^)]` tail stopped at the `)` of `(job)` and
       * reported `concurrency: null` for a worker that plainly declares 5 —
       * a null where a measured value existed, which is the same species of
       * error as a null that became 0. It is cut at the next registration so a
       * sibling worker's setting cannot be credited to this one.
       */
      const raw = m[2] ?? '';
      const next = raw.search(/new\s+(?:Worker|Queue|QueueScheduler)\s*(?:<[^>]*>)?\s*\(/);
      const tail = next === -1 ? raw : raw.slice(0, next);
      const concurrency = /\bconcurrency\s*:\s*(\d{1,4})\b/.exec(tail)?.[1];
      add(
        {
          kind: 'QUEUE_CONSUMER',
          queue: m[1] ?? '',
          concurrency: concurrency === undefined ? null : Number.parseInt(concurrency, 10),
          handler: file.path,
        },
        file.path,
        m.index ?? 0,
        content,
        `${file.path} binds a BullMQ worker or queue to "${m[1] ?? ''}"`,
      );
    }
    for (const m of content.matchAll(
      /@Processor\s*\(\s*['"`]([^'"`\n]{1,120})['"`]|\bQueueName\s*\.\s*([A-Z0-9_]{1,60})\b/g,
    )) {
      const queue = m[1] ?? m[2] ?? '';
      if (queue.length === 0) continue;
      add(
        { kind: 'QUEUE_CONSUMER', queue, concurrency: null, handler: file.path },
        file.path,
        m.index ?? 0,
        content,
        `${file.path} declares a processor for the "${queue}" queue`,
      );
    }
    for (const m of content.matchAll(
      /(?:QueueUrl|queueUrl)\s*:\s*['"`]([^'"`\n]{1,300})['"`]|\.\s*subscription\s*\(\s*['"`]([^'"`\n]{1,120})['"`]|consumer\s*\.\s*subscribe\s*\(\s*\{[^}]{0,200}?topics?\s*:\s*\[?\s*['"`]([^'"`\n]{1,120})['"`]/g,
    )) {
      const queue = m[1] ?? m[2] ?? m[3] ?? '';
      if (queue.length === 0) continue;
      add(
        { kind: 'QUEUE_CONSUMER', queue, concurrency: null, handler: file.path },
        file.path,
        m.index ?? 0,
        content,
        `${file.path} consumes the queue, subscription or topic "${queue}"`,
      );
    }

    // ── Webhook receivers: a handler that VERIFIES A SIGNATURE ──
    const verifies =
      /constructEvent|verifyHeader|verifySignature|verifyWebhook|createHmac|timingSafeEqual|new\s+Webhook\s*\(|svix|x-hub-signature|stripe-signature|x-signature/i.test(
        content,
      );
    if (verifies && handlesRequests(content, file.path)) {
      const scheme =
        /stripe-signature/i.test(content) || /constructEvent/.test(content)
          ? 'stripe-signature'
          : /svix|new\s+Webhook\s*\(/.test(content)
            ? 'svix'
            : /x-hub-signature-256/i.test(content)
              ? 'hmac-sha256'
              : /createHmac\s*\(\s*['"`](sha\d+)['"`]/.exec(content)
                ? `hmac-${/createHmac\s*\(\s*['"`](sha\d+)['"`]/.exec(content)?.[1]}`
                : null;
      const path = webhookPathFor(file.path);
      add(
        { kind: 'WEBHOOK_RECEIVER', path, signatureScheme: scheme },
        file.path,
        content.search(
          /constructEvent|verifyHeader|verifySignature|verifyWebhook|createHmac|new\s+Webhook\s*\(/,
        ),
        content,
        scheme === null
          ? `${file.path} verifies an incoming payload; the scheme was not readable, which is not the same as none`
          : `${file.path} verifies an incoming payload with ${scheme}`,
      );
    }

    // ── Outbound email ──
    for (const m of content.matchAll(
      /\b(?:sendMail|sendEmail|emails\s*\.\s*send|sgMail\s*\.\s*send|mailer\s*\.\s*send|postmark\w*\s*\.\s*send\w*|ses\s*\.\s*sendEmail)\s*\(([^)]{0,400})/g,
    )) {
      const args = m[1] ?? '';
      const templateId =
        /\b(?:template|templateId|templateAlias|react|subject)\s*:\s*['"`]?([\w.\-/]{1,120})/.exec(
          args,
        )?.[1] ?? null;
      add(
        {
          kind: 'OUTBOUND_EMAIL',
          /*
           * No template id is readable for a mail assembled inline, and the
           * file path is the only identity left. It is a real identity — a
           * mailbox assertion can match on it — and it is labelled as such in
           * the evidence rather than passed off as a template the app named.
           */
          templateId: templateId ?? file.path,
          sentBy: file.path,
        },
        file.path,
        m.index ?? 0,
        content,
        templateId === null
          ? `${file.path} sends mail with no readable template id, so the file path stands in as the identity`
          : `${file.path} sends the "${templateId}" mail`,
      );
    }

    // ── Upload handlers ──
    const uploads =
      /\bmulter\s*\(|\bformidable\s*\(|\bbusboy\b|createReadStream\s*\(\s*req|\bformData\s*\(\s*\)|request\s*\.\s*files\b/.test(
        content,
      ) || /\bfile\s*:\s*File\b|instanceof\s+File\b/.test(content);
    if (uploads) {
      const maxBytes = /\b(?:fileSize|maxFileSize|maxSize|limit)\s*:\s*(\d{3,15})\b/.exec(
        content,
      )?.[1];
      const accepted = [
        ...content.matchAll(/\b(?:accept|mimetype|contentType|allowedTypes)\s*:?\s*['"`]([\w.+/-]*\/[\w.+*-]+)['"`]/g),
      ]
        .map((m) => m[1] ?? '')
        .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
        .slice(0, 20);
      add(
        {
          kind: 'UPLOAD',
          path: webhookPathFor(file.path),
          acceptedTypes: accepted,
          maxBytes: maxBytes === undefined ? null : Number.parseInt(maxBytes, 10),
        },
        file.path,
        content.search(/\bmulter\s*\(|\bformidable\s*\(|\bbusboy\b|\bformData\s*\(\s*\)/),
        content,
        `${file.path} accepts an uploaded file${
          maxBytes === undefined ? ' and declares no size cap' : ` with a declared cap of ${maxBytes} bytes`
        }`,
      );
    }

    // ── Websockets and SSE ──
    if (/new\s+WebSocketServer|new\s+Server\s*\(\s*\w*\s*,\s*\{[^}]*?cors|socket\.io|\bio\s*\.\s*on\s*\(\s*['"`]connection/.test(content)) {
      const events = [...content.matchAll(/\b(?:socket|io|ws)\s*\.\s*(?:on|emit)\s*\(\s*['"`]([^'"`\n]{1,80})['"`]/g)]
        .map((m) => m[1] ?? '')
        .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
        .slice(0, 40);
      add(
        { kind: 'WEBSOCKET', path: webhookPathFor(file.path), events },
        file.path,
        content.search(/new\s+WebSocketServer|socket\.io|\bio\s*\.\s*on\s*\(/),
        content,
        `${file.path} opens a websocket${events.length > 0 ? ` emitting ${events.slice(0, 5).join(', ')}` : ''}`,
      );
    }
    if (/text\/event-stream/.test(content) && handlesRequests(content, file.path)) {
      const events = [...content.matchAll(/event\s*:\s*['"`]?([\w.-]{1,60})/g)]
        .map((m) => m[1] ?? '')
        .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
        .slice(0, 40);
      add(
        { kind: 'SSE', path: webhookPathFor(file.path), events },
        file.path,
        content.indexOf('text/event-stream'),
        content,
        `${file.path} answers with text/event-stream, so it is a server-sent-event endpoint`,
      );
    }

    // ── Next.js server actions ──
    if (/^\s*['"]use server['"]\s*;?\s*$/m.test(content)) {
      const moduleLevel = /^\s*['"]use server['"]/.test(content.trimStart());
      for (const site of exportedNames(content).sites) {
        if (NOT_A_COMPONENT_EXPORT.has(site.name)) continue;
        const body = content.slice(site.index, site.index + 2000);
        // A file-level 'use server' makes every export an action. An inline one
        // marks only the function that contains it, and a text scan can only
        // see the directive inside the body it sits in.
        if (!moduleLevel && !/['"]use server['"]/.test(body)) continue;
        add(
          { kind: 'SERVER_ACTION', module: file.path, exportName: site.name },
          file.path,
          site.index,
          content,
          `${file.path} exports ${site.name} from a 'use server' ${moduleLevel ? 'module' : 'function'}`,
        );
      }
    }

    // ── tRPC procedures ──
    if (/\b(?:publicProcedure|protectedProcedure|authedProcedure|t\s*\.\s*procedure)\b/.test(content)) {
      const routerName =
        /\b(?:export\s+const\s+)?(\w+)Router\s*=\s*(?:createTRPCRouter|router|t\s*\.\s*router)\s*\(/.exec(
          content,
        )?.[1] ?? null;
      for (const m of content.matchAll(
        /(\w{1,60})\s*:\s*(?:publicProcedure|protectedProcedure|authedProcedure|t\s*\.\s*procedure)([\s\S]{0,300}?)(?:\.query|\.mutation|\.subscription)\s*\(/g,
      )) {
        const name = m[1] ?? '';
        const mutation = /\.mutation\s*\($/.test(m[0] ?? '');
        add(
          {
            kind: 'TRPC_PROCEDURE',
            procedure: routerName === null ? name : `${routerName}.${name}`,
            mutation,
          },
          file.path,
          m.index ?? 0,
          content,
          `${file.path} declares the tRPC ${mutation ? 'mutation' : 'query'} ${
            routerName === null ? name : `${routerName}.${name}`
          }`,
        );
      }
    }
  }

  if (capped > 0) {
    shortfalls.note(
      'background-surfaces',
      'CAP_REACHED',
      `more than ${MAX_BACKGROUND_SURFACES} background surfaces were found; the rest were not recorded, so at least ${capped} more exist`,
      capped,
    );
  }
  return found;
}

/** The identity inside a kind, for the dedupe. One fact per real surface. */
function backgroundIdentity(fact: BackgroundSurfaceFact): string {
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
 * The URL a handler file answers at, derived from the file-convention routers.
 *
 * Returns the FILE PATH when the convention does not apply, and says so by
 * being a path rather than a URL. A guessed URL for a handler mounted by code
 * would send a webhook test to a 404, which is rule 4 of this module's header:
 * never resolve what cannot be resolved.
 */
function webhookPathFor(path: string): string {
  const app = /(?:^|\/)(?:src\/)?app\/(.+)\/route\.[cm]?[jt]s$/.exec(path);
  if (app) return joinSegments((app[1] ?? '').split('/').map(appSegment));
  const pages = /(?:^|\/)(?:src\/)?pages\/(api\/.+)\.[cm]?[jt]s$/.exec(path);
  if (pages) {
    const parts = (pages[1] ?? '').split('/');
    const leaf = parts.pop() ?? '';
    const tail = leaf === 'index' ? [] : [dynamicSegment(leaf)];
    return joinSegments([...parts.map((s) => dynamicSegment(s)), ...tail]);
  }
  const sveltekit = /(?:^|\/)src\/routes\/(.+)\/\+server\.[cm]?[jt]s$/.exec(path);
  if (sveltekit) return joinSegments((sveltekit[1] ?? '').split('/').map(svelteSegment));
  return path;
}

/**
 * Does this module handle incoming requests at all?
 *
 * The guard on the webhook and SSE detectors, and it exists because
 * `createHmac` in a crypto helper is not a webhook receiver and
 * `'text/event-stream'` in a client `fetch` is not an SSE endpoint. Both would
 * otherwise be reported as background surfaces that do not exist — an
 * over-report, which on this axis is just as damaging as an omission: the
 * denominator grows by a surface no test can ever drive, and the percentage
 * falls for a reason the customer cannot act on.
 */
function handlesRequests(content: string, path: string): boolean {
  if (/(?:^|\/)(?:src\/)?(?:app|pages)\/.*(?:route|api)/.test(path)) return true;
  if (/(?:^|\/)src\/routes\/.*\+server\./.test(path)) return true;
  return /\b(?:req|request)\s*\.\s*(?:headers|body|method|rawBody|text|json)\b|\(\s*req(?:uest)?\s*:\s*(?:Next)?Request\b|\bexport\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE)\b|\bres\s*\.\s*(?:status|send|json|write)\b/.test(
    content,
  );
}

// ─── The application's feature flags ─────────────────────────────────────────

/**
 * One SDK's call sites, and what each one tells us about the flag's variants.
 *
 * `booleanGate` is the field that does the honest work. A `isEnabled('x')` call
 * proves the flag is a boolean, so `['on','off']` is an ENUMERATION and not a
 * guess. A `getStringValue('theme','light')` call proves only that `light` is
 * the fallback — the other variants live in the provider's dashboard, not in
 * the repo — so variants come out NULL. Writing `['light']` there instead would
 * be the "null that became a value" lie, and it would make a flag sweep think
 * it had covered a flag it had seen one side of.
 */
const FLAG_CALL_SITES: Array<{
  provider: FlagProvider;
  /** Capture group 1 is the flag key; group 2, when present, is the fallback. */
  pattern: RegExp;
  booleanGate: boolean;
  what: string;
}> = [
  {
    provider: 'LAUNCHDARKLY',
    pattern:
      /\b(?:ldClient|ldclient|client|ld)\s*\.\s*(?:variation|boolVariation|stringVariation|numberVariation|jsonVariation)\s*\(\s*['"`]([^'"`\n]{1,200})['"`]\s*(?:,[^,)]{0,120}){0,1}(?:,\s*([^,)\n]{1,60}))?/g,
    booleanGate: false,
    what: 'a LaunchDarkly variation call',
  },
  {
    provider: 'LAUNCHDARKLY',
    pattern: /\buseFlag(?:s)?\s*\(\s*['"`]([^'"`\n]{1,200})['"`]/g,
    booleanGate: true,
    what: 'a LaunchDarkly flag hook',
  },
  {
    provider: 'UNLEASH',
    pattern:
      /\b(?:unleash|client)\s*\.\s*isEnabled\s*\(\s*['"`]([^'"`\n]{1,200})['"`]|\buseFlag\s*\(\s*['"`]([^'"`\n]{1,200})['"`]|\buseUnleashContext\b/g,
    booleanGate: true,
    what: 'an Unleash toggle check',
  },
  {
    provider: 'OPENFEATURE',
    pattern:
      /\b\w*[Cc]lient\s*\.\s*get(Boolean|String|Number|Object)(?:Value|Details)\s*\(\s*['"`]([^'"`\n]{1,200})['"`]\s*,\s*([^,)\n]{1,60})/g,
    booleanGate: false,
    what: 'an OpenFeature evaluation',
  },
  {
    provider: 'GROWTHBOOK',
    pattern:
      /\b(?:growthbook|gb)\s*\.\s*(?:isOn|isOff)\s*\(\s*['"`]([^'"`\n]{1,200})['"`]|\buseFeatureIsOn\s*\(\s*['"`]([^'"`\n]{1,200})['"`]/g,
    booleanGate: true,
    what: 'a GrowthBook feature check',
  },
  {
    provider: 'GROWTHBOOK',
    pattern:
      /\b(?:growthbook|gb)\s*\.\s*getFeatureValue\s*\(\s*['"`]([^'"`\n]{1,200})['"`]\s*,\s*([^,)\n]{1,60})/g,
    booleanGate: false,
    what: 'a GrowthBook feature value',
  },
  {
    provider: 'FLAGSMITH',
    pattern:
      /\bflagsmith\s*\.\s*(?:hasFeature|getValue)\s*\(\s*['"`]([^'"`\n]{1,200})['"`]|\buseFlags\s*\(\s*\[\s*['"`]([^'"`\n]{1,200})['"`]/g,
    booleanGate: true,
    what: 'a Flagsmith feature check',
  },
  {
    provider: 'STATSIG',
    pattern:
      /\b(?:Statsig|statsig)\s*\.\s*checkGate\s*\(\s*['"`]([^'"`\n]{1,200})['"`]|\buseGate\s*\(\s*['"`]([^'"`\n]{1,200})['"`]/g,
    booleanGate: true,
    what: 'a Statsig gate check',
  },
  {
    provider: 'STATSIG',
    pattern:
      /\b(?:Statsig|statsig)\s*\.\s*(?:getExperiment|getConfig|getDynamicConfig)\s*\(\s*['"`]([^'"`\n]{1,200})['"`]/g,
    booleanGate: false,
    what: 'a Statsig experiment or dynamic config',
  },
];

/**
 * Plain environment gates — the commonest flag mechanism of all, and the one
 * no provider SDK will ever tell us about.
 *
 * Only names that SAY they are a gate: `FEATURE_`, `ENABLE_`, `DISABLE_`,
 * `_ENABLED`, `FLAG_`. `process.env.DATABASE_URL` is configuration, not a flag,
 * and reading it as one would put a connection string in the flag dimension
 * and multiply the FLAG_COMBINATION axis by it.
 */
const ENV_GATE =
  /(?:process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env)\s*(?:\.\s*|\[\s*['"`])((?:NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|VUE_APP_)?(?:FEATURE_|FEATURES_|FLAG_|FLAGS_|ENABLE_|DISABLE_)[A-Z0-9_]{1,80}|[A-Z0-9_]{1,80}_(?:ENABLED|DISABLED|FEATURE_FLAG))/g;

/** Checked-in flag catalogues. A file whose whole job is to list the flags. */
const FLAG_CONFIG_FILE = /(?:^|\/)(?:flags|features|feature-flags|featureFlags)\.(?:json|ya?ml)$/;

/**
 * The truthiness fallback a boolean gate is read against, as a variant name.
 *
 * `['on','off']` is the spelling `DimensionDetail.FLAG` documents for a boolean
 * flag, so a boolean gate's default is one of those two words and never the
 * literal `false` — a variants list of `['on','off']` whose default is `false`
 * names a variant that is not in the list, which is a dangling reference inside
 * our own row.
 */
/** A captured literal without the quotes the source wrote around it. */
function unquote(raw: string): string {
  const value = raw.trim();
  const quoted = /^(['"`])([\s\S]*)\1$/.exec(value);
  return quoted ? (quoted[2] ?? '') : value;
}

function booleanDefaultFrom(fallback: string | undefined): string | null {
  if (fallback === undefined) return null;
  const value = fallback.trim();
  if (/^(?:true|'true'|"true"|1)$/.test(value)) return 'on';
  if (/^(?:false|'false'|"false"|0)$/.test(value)) return 'off';
  return null;
}

function detectFeatureFlags(
  files: AnalysedFile[],
  ledger: Ledger,
  shortfalls: Shortfalls,
): SourceFeatureFlag[] {
  const flags: SourceFeatureFlag[] = [];
  const byKey = new Set<string>();
  let capped = 0;

  const add = (flag: SourceFeatureFlag): void => {
    /*
     * KEYED ON THE KEY ALONE, AND NOT ON THE PROVIDER.
     *
     * The same name in LaunchDarkly and in a `NEXT_PUBLIC_FEATURE_*` env gate
     * is ONE flag read two ways, and the first reading wins so the SDK's
     * richer answer — variants, a default variant — is not overwritten by the
     * env gate's poorer one. Keying on the pair would put both in the list and
     * count one flag twice, which is a denominator divided by a larger number
     * rather than a bigger measurement of the application. The comment here
     * used to say "provider AND key", which is what the code does NOT do.
     */
    if (byKey.has(flag.key)) return;
    if (flags.length >= MAX_FLAGS) {
      capped++;
      return;
    }
    byKey.add(flag.key);
    flags.push(flag);
    ledger.hit('feature-flags');
  };

  for (const file of files) {
    if (FLAG_CONFIG_FILE.test(file.path)) {
      ledger.examine('feature-flags');
      if (file.content === undefined) {
        ledger.starve('feature-flags');
        shortfalls.note(
          'feature-flags',
          'NO_CONTENT',
          `${file.path} is a flag catalogue and its body was not uploaded, so the flags it lists were not counted`,
        );
        continue;
      }
      if (file.path.endsWith('.json')) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(file.content);
        } catch {
          shortfalls.note(
            'feature-flags',
            'UNPARSEABLE',
            `${file.path} is not valid JSON, so the flags it declares were not read`,
          );
          continue;
        }
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            const isBoolean = typeof value === 'boolean';
            add({
              key,
              provider: 'CONFIG_FILE',
              variants: isBoolean ? ['on', 'off'] : null,
              defaultVariant: isBoolean ? (value ? 'on' : 'off') : null,
              file: file.path,
              line: lineAt(file.content, file.content.indexOf(`"${key}"`)),
              evidence: isBoolean
                ? `${file.path} lists ${key} as a boolean flag, default ${value ? 'on' : 'off'}`
                : `${file.path} lists ${key}; its variants are not enumerable from the file`,
            });
          }
        }
        continue;
      }
      /*
       * YAML without a parser. The top-level keys are readable from the
       * indentation and the variants are not, so the keys are reported and the
       * shortfall says what was skipped — half a fact, labelled as half.
       */
      for (const m of file.content.matchAll(/^([A-Za-z_][\w.-]{0,80})\s*:/gm)) {
        add({
          key: m[1] ?? '',
          provider: 'CONFIG_FILE',
          variants: null,
          defaultVariant: null,
          file: file.path,
          line: lineAt(file.content, m.index ?? 0),
          evidence: `${file.path} lists ${m[1] ?? ''} as a top-level key; its variants were not read`,
        });
      }
      shortfalls.note(
        'feature-flags',
        'UNPARSEABLE',
        `${file.path} is YAML and this pass reads only its top-level keys, so each flag's variants and default were not read`,
      );
      continue;
    }

    if (!MODULE_EXT.has(file.ext)) continue;
    if (file.content === undefined) continue;
    const content = file.content;
    if (!/[Ff]lag|[Ff]eature|isEnabled|checkGate|variation|useGate|isOn\(|process\s*\.\s*env|import\s*\.\s*meta/.test(content)) {
      continue;
    }
    ledger.examine('feature-flags');

    for (const site of FLAG_CALL_SITES) {
      site.pattern.lastIndex = 0;
      for (const m of content.matchAll(site.pattern)) {
        /*
         * The alternations above put the key in different groups depending on
         * which branch matched, so the key is the first group that captured a
         * non-empty string that is NOT the type word. `getBooleanValue` puts
         * the type in group 1 and the key in group 2, which is why the type
         * words are excluded by name rather than by position.
         */
        const groups = m.slice(1).filter((g): g is string => typeof g === 'string' && g.length > 0);
        const key = groups.find((g) => !/^(?:Boolean|String|Number|Object)$/.test(g));
        if (key === undefined) continue;
        const fallback = groups[groups.length - 1] === key ? undefined : groups[groups.length - 1];
        add({
          key,
          provider: site.provider,
          variants: site.booleanGate ? ['on', 'off'] : null,
          /*
           * Unquoted, because the capture includes the quotes the source wrote:
           * `getFeatureValue('theme', 'light')` yielded `light` still wrapped
           * in apostrophes, and a default variant spelled `'light'` matches no
           * variant named `light` anywhere downstream — a dangling reference
           * inside our own row.
           */
          defaultVariant: site.booleanGate
            ? booleanDefaultFrom(fallback)
            : fallback === undefined
              ? null
              : unquote(fallback),
          file: file.path,
          line: lineAt(content, m.index ?? 0),
          evidence: site.booleanGate
            ? `${file.path} reads ${key} through ${site.what}, which is a boolean gate`
            : `${file.path} reads ${key} through ${site.what}; its variants live in the provider and not in the repo`,
        });
      }
    }

    ENV_GATE.lastIndex = 0;
    for (const m of content.matchAll(ENV_GATE)) {
      const key = m[1] ?? '';
      if (key.length === 0) continue;
      add({
        key,
        provider: 'ENV_GATE',
        /*
         * An env gate is read for truthiness, so it has two variants. The
         * DEFAULT, though, is whatever the deployment sets — which is not in
         * the repository — so it is null rather than 'off'. Guessing 'off'
         * would tell a flag sweep it already knows the production state of
         * every gate in the app.
         */
        variants: ['on', 'off'],
        defaultVariant: null,
        file: file.path,
        line: lineAt(content, m.index ?? 0),
        evidence: `${file.path} gates behaviour on the ${key} environment variable; which value production sets is not in the repository`,
      });
    }
  }

  if (capped > 0) {
    shortfalls.note(
      'feature-flags',
      'CAP_REACHED',
      `more than ${MAX_FLAGS} flags were found; the rest were not recorded, so at least ${capped} more exist`,
      capped,
    );
  }
  return flags;
}

// ─── Locales ─────────────────────────────────────────────────────────────────

/**
 * ISO 639-1 language subtags.
 *
 * The list exists to stop `locales/common.json` and `messages/index.json`
 * entering the locale denominator. A pure BCP-47 shape check passes `ui`, `db`
 * and `qa` just as happily as `de`, and three invented locales multiply the
 * DEVICE_LOCALE axis by a factor nobody asked for — the mirror image of a
 * missing surface, and just as wrong.
 */
const ISO_639_1 = new Set(
  (
    'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy ' +
    'da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu ' +
    'hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb ' +
    'lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om ' +
    'or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ' +
    'ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'
  ).split(' '),
);

/**
 * Languages written right to left.
 *
 * A fact, not a guess, and it earns its place because an RTL locale re-lays-out
 * the page rather than swapping strings — so a localisation sweep that treats
 * `ar` like `de` tests the translation and not the layout, which is where the
 * defects are.
 */
const RTL_LANGUAGES = new Set(['ar', 'arc', 'ckb', 'dv', 'fa', 'he', 'ku', 'ps', 'sd', 'ug', 'ur', 'yi']);

/** Does this string name a locale, as opposed to a namespace or a section? */
function localeTag(raw: string): string | null {
  const value = raw.trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)) return null;
  const language = (value.split('-')[0] ?? '').toLowerCase();
  if (!ISO_639_1.has(language)) return null;
  return value;
}

const isRtl = (tag: string): boolean =>
  RTL_LANGUAGES.has((tag.split('-')[0] ?? '').toLowerCase());

/** Where in a config the locale list and the default are written, per library. */
const LOCALE_CONFIG: Array<{
  reader: LocaleCatalogueReader;
  /** The dependency or import that proves this library is in use. */
  signal: RegExp;
  /**
   * Matches the property NAME, not a literal array.
   *
   * A `(?=\[)` lookahead used to be part of this, and it meant a list written
   * as `locales = Object.keys(catalogues)` did not match at all — so no
   * shortfall was recorded and an app with a dozen locales was reported as an
   * app with none. Finding the property and then failing to read it is the
   * fact worth reporting; not finding the property at all is silence.
   */
  listProperty: RegExp;
  defaultProperty: RegExp;
}> = [
  {
    reader: 'NEXT_INTL',
    signal: /next-intl/,
    listProperty: /\blocales\s*[:=]\s*/,
    defaultProperty: /\bdefaultLocale\s*[:=]\s*['"`]([^'"`\n]{1,35})['"`]/,
  },
  {
    reader: 'I18NEXT',
    signal: /i18next|react-i18next/,
    listProperty: /\b(?:supportedLngs|locales|languages)\s*[:=]\s*/,
    defaultProperty: /\b(?:fallbackLng|lng|defaultLocale)\s*[:=]\s*['"`]([^'"`\n]{1,35})['"`]/,
  },
  {
    reader: 'VUE_I18N',
    signal: /vue-i18n/,
    listProperty: /\b(?:locales|availableLocales)\s*[:=]\s*/,
    defaultProperty: /\b(?:locale|fallbackLocale)\s*[:=]\s*['"`]([^'"`\n]{1,35})['"`]/,
  },
  {
    reader: 'REACT_INTL',
    signal: /react-intl/,
    listProperty: /\b(?:locales|supportedLocales)\s*[:=]\s*/,
    defaultProperty: /\bdefaultLocale\s*[:=]\s*['"`]([^'"`\n]{1,35})['"`]/,
  },
  {
    reader: 'FRAMEWORK_CONFIG',
    signal: /\bi18n\s*:/,
    listProperty: /\blocales\s*[:=]\s*/,
    defaultProperty: /\bdefaultLocale\s*[:=]\s*['"`]([^'"`\n]{1,35})['"`]/,
  },
];

/** A message catalogue path, and the tag it declares. */
function catalogueTag(path: string): string | null {
  // `locales/de.json`, `messages/pt-BR.json`
  const flat = /(?:^|\/)(?:public\/|src\/|app\/)?(?:locales?|messages|lang|translations|i18n)\/([^/]+)\.(?:json|ya?ml|ts|js)$/.exec(
    path,
  );
  if (flat) return localeTag(flat[1] ?? '');
  // `public/locales/de/common.json`
  const nested = /(?:^|\/)(?:public\/|src\/|app\/)?(?:locales?|messages|lang|translations|i18n)\/([^/]+)\//.exec(
    path,
  );
  if (nested) return localeTag(nested[1] ?? '');
  return null;
}

function detectLocales(
  files: AnalysedFile[],
  ledger: Ledger,
  shortfalls: Shortfalls,
): SourceLocale[] {
  const locales: SourceLocale[] = [];
  const seen = new Set<string>();
  let capped = 0;
  /**
   * The default, once the whole repo has been read.
   *
   * Collected separately and applied at the end because the catalogue
   * DIRECTORY is usually read before the config that names the default, and a
   * tag recorded `isDefault: false` from the directory must be corrected by the
   * config rather than left wrong. Directories declare no default at all, which
   * is why guessing from one is forbidden two paragraphs below.
   */
  let declaredDefault: string | null = null;

  const add = (locale: SourceLocale): void => {
    if (seen.has(locale.tag)) return;
    if (locales.length >= MAX_LOCALES) {
      capped++;
      return;
    }
    seen.add(locale.tag);
    locales.push(locale);
    ledger.hit('locales');
  };

  for (const file of files) {
    // ── A message catalogue. Readable from the PATH, so no body is needed ──
    const fromPath = catalogueTag(file.path);
    if (fromPath !== null) {
      ledger.examine('locales');
      add({
        tag: fromPath,
        reader: 'MESSAGE_DIRECTORY',
        /*
         * A catalogue directory declares WHICH locales exist and says nothing
         * about which one is served by default. `false` here is the only honest
         * value, and the config pass below is the only thing allowed to set
         * `true`.
         */
        isDefault: false,
        rtl: isRtl(fromPath),
        file: file.path,
        evidence: `${file.path} is a message catalogue for ${fromPath}`,
      });
      continue;
    }

    if (file.content === undefined) continue;
    const content = file.content;

    // ── hreflang alternates in static markup ──
    if (/\.html?$|\.(?:ejs|erb|hbs|njk)$/.test(file.path) || /<link\b[^>]*hreflang/i.test(content)) {
      for (const m of content.matchAll(/<link\b[^>]*\bhreflang\s*=\s*["']([^"']{1,35})["'][^>]*>/gi)) {
        const tag = localeTag(m[1] ?? '');
        if (tag === null) continue;
        ledger.examine('locales');
        add({
          tag,
          reader: 'HREFLANG',
          isDefault: false,
          rtl: isRtl(tag),
          file: file.path,
          evidence: `${file.path} declares an hreflang alternate for ${tag}`,
        });
      }
    }

    if (!MODULE_EXT.has(file.ext) && file.ext !== '.json' && file.ext !== '.mjs') continue;

    for (const config of LOCALE_CONFIG) {
      if (!config.signal.test(content)) continue;
      const at = config.listProperty.exec(content);
      if (at === null) continue;
      ledger.examine('locales');

      const tail = content.slice(at.index + at[0].length, at.index + at[0].length + 2000);
      const stringsEnd = tail.indexOf(']');
      const list = stringsEnd === -1 ? tail.slice(0, 200) : tail.slice(0, stringsEnd);
      const tags = [...list.matchAll(/['"`]([^'"`\n]{1,35})['"`]/g)]
        .map((m) => localeTag(m[1] ?? ''))
        .filter((tag): tag is string => tag !== null);

      if (tags.length === 0) {
        /*
         * The property is there and holds no literal — a list built from
         * `Object.keys(messages)` or imported from elsewhere. Reported, because
         * a locale list we could not read is not an app with no locales.
         */
        shortfalls.note(
          'locales',
          'EXPRESSION_NOT_LITERAL',
          `${file.path} declares a locale list that is not a literal array, so the locales it holds were not read`,
        );
        continue;
      }
      for (const tag of tags) {
        add({
          tag,
          reader: config.reader,
          isDefault: false,
          rtl: isRtl(tag),
          file: file.path,
          evidence: `${file.path} declares ${tag} in its ${config.reader === 'FRAMEWORK_CONFIG' ? 'framework i18n' : config.reader.toLowerCase()} locale list`,
        });
      }
      const named = config.defaultProperty.exec(content)?.[1];
      const defaultTag = named === undefined ? null : localeTag(named);
      if (defaultTag !== null) declaredDefault = defaultTag;
    }
  }

  /*
   * Applied last, and only when a config NAMED it. A locale list with no
   * declared default leaves every row `isDefault: false`, which reads as "we do
   * not know which one is served" — and that is what `dimensionDenominator`
   * needs to hear, because it counts no default cells at all when
   * `defaultValue` is null rather than inventing one.
   */
  if (declaredDefault !== null) {
    const row = locales.find((locale) => locale.tag === declaredDefault);
    if (row) {
      row.isDefault = true;
      row.evidence = `${row.evidence}; a config names it the default locale`;
    } else {
      // A default naming a locale no catalogue holds is a dangling reference in
      // the CUSTOMER's config, and reporting it beats silently adding the row.
      shortfalls.note(
        'locales',
        'UNRESOLVED_IMPORT',
        `a config names "${declaredDefault}" as the default locale and no catalogue or list declares it`,
      );
    }
  }

  if (capped > 0) {
    shortfalls.note(
      'locales',
      'CAP_REACHED',
      `more than ${MAX_LOCALES} locales were found; the rest were not recorded, so at least ${capped} more exist`,
      capped,
    );
  }
  return locales;
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
  const shortfalls = new Shortfalls();

  // Caps that bit before any detector ran. They are counted here rather than
  // only described in `warnings`, because "at least N more existed" needs N.
  if (overflowed) {
    shortfalls.note(
      null,
      'CAP_REACHED',
      `more than ${MAX_FILES_ANALYSED} files were uploaded and the rest were not analysed at all, so every surface in them is missing from every count below`,
      input.length - analysed.length - ignored,
    );
  }
  if (truncatedFiles > 0) {
    shortfalls.note(
      null,
      'FILE_TRUNCATED',
      `${truncatedFiles} file${truncatedFiles === 1 ? ' was' : 's were'} longer than ${MAX_FILE_CHARS} characters and were read only up to that point; anything declared past it was not seen by any detector`,
      truncatedFiles,
    );
  }

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

  /*
   * The guard pass runs AFTER the route detectors and before nothing, because
   * it decides a fact ABOUT the routes they collected. It mutates each route's
   * and endpoint's `guard`, so every item in the inventory carries a verdict —
   * including UNKNOWN, which is the verdict for a route we could not analyse
   * and the one that must never arrive as `false`.
   */
  const guards = detectRouteGuards(analysed, collector, ledger, shortfalls);
  const components = detectComponents(analysed, ledger, shortfalls);
  const backgroundSurfaces = detectBackgroundSurfaces(analysed, ledger, shortfalls);
  const featureFlags = detectFeatureFlags(analysed, ledger, shortfalls);
  const locales = detectLocales(analysed, ledger, shortfalls);

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

  // ── The five surfaces, each with the sentence that makes it legible ─────────
  //
  // Every one of these says what was NOT established as plainly as what was,
  // because on these five axes our silence has until now been indistinguishable
  // from the application having nothing there.
  const guarded = [...collector.routes, ...collector.endpoints].filter(
    (item) => item.guard?.access === 'GUARDED',
  ).length;
  const accessUnknown = [...collector.routes, ...collector.endpoints].filter(
    (item) => item.guard?.access === 'UNKNOWN',
  ).length;
  const total = collector.routes.length + collector.endpoints.length;
  if (total > 0) {
    notes.push(
      `Of ${total} route${total === 1 ? '' : 's'} and endpoint${total === 1 ? '' : 's'}, ${guarded} ` +
        `${guarded === 1 ? 'is' : 'are'} behind a guard the source declares and ${accessUnknown} ` +
        `could not be analysed. The ${accessUnknown} are reported as UNKNOWN and NOT as public: ` +
        'a route we could not read is not a route anyone may reach, and the two are opposite ' +
        'facts about an admin page.',
    );
  }
  if (components.length > 0) {
    const cataloguedRead = components.some((c) => c.hasCatalogueEntry !== null);
    const withEntry = components.filter((c) => c.hasCatalogueEntry === true).length;
    const nonHappy = components.reduce(
      (running, c) => running + c.states.filter((s) => s.kind !== 'DEFAULT').length,
      0,
    );
    notes.push(
      `${components.length} exported component${components.length === 1 ? '' : 's'}, hook${components.length === 1 ? '' : 's'} ` +
        `and provider${components.length === 1 ? '' : 's'} were found, declaring ${nonHappy} state${nonHappy === 1 ? '' : 's'} ` +
        'that are not the happy path. ' +
        (cataloguedRead
          ? `A component catalogue was read and ${withEntry} of them appear in it; the rest are still components and are still counted.`
          : 'No component catalogue was found anywhere in the repo, so whether each component has a story is recorded as unknown rather than as no.'),
    );
  }
  if (backgroundSurfaces.length > 0) {
    notes.push(
      `${backgroundSurfaces.length} surface${backgroundSurfaces.length === 1 ? '' : 's'} off the HTTP ` +
        'request path were found — crons, queue consumers, webhook receivers, outbound mail, uploads, ' +
        'sockets, server actions and tRPC procedures. Nothing crawls these, so until now they were ' +
        'absent from a surface count rather than uncovered by it.',
    );
  }
  if (featureFlags.length > 0) {
    const unenumerable = featureFlags.filter((flag) => flag.variants === null).length;
    notes.push(
      `${featureFlags.length} feature flag${featureFlags.length === 1 ? '' : 's'} were found. A crawl ` +
        'that does not set them sees one configuration of this application and cannot say which one. ' +
        (unenumerable > 0
          ? `${unenumerable} of them are not boolean gates, so their variants live in the provider rather than in the repo and were not read here.`
          : 'All of them are boolean gates, so their variants are enumerable from the call site.'),
    );
  }
  if (locales.length > 0) {
    const defaulted = locales.some((locale) => locale.isDefault);
    const rtl = locales.filter((locale) => locale.rtl).length;
    notes.push(
      `${locales.length} locale${locales.length === 1 ? '' : 's'} were discovered from the repository ` +
        `itself, ${rtl} of them right-to-left. ` +
        (defaulted
          ? 'A config names the default locale.'
          : 'No config names a default locale, so none is claimed — guessing one would invent the fact a locale sweep divides by.'),
    );
  }

  const unreadGuardSites = shortfalls
    .report()
    .filter((row) => row.detector === 'route-guards' && row.reason === 'NO_CONTENT');
  if (unreadGuardSites.length > 0) {
    notes.push(
      `${unreadGuardSites[0]!.count} guard site${unreadGuardSites[0]!.count === 1 ? '' : 's'} ` +
        '(middleware or layout files) were found with no body uploaded. Every route they could cover ' +
        'is reported UNKNOWN rather than public.',
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
  /*
   * Every counted shortfall as a warning too, and this is not duplication.
   * `shortfalls` is the machine-readable account a denominator is corrected
   * from; `warnings` is what a person reads before trusting a number. An
   * undisclosed cap makes a coverage percentage go UP, so the disclosure has to
   * appear in the place a human actually looks.
   */
  for (const row of shortfalls.report()) {
    warnings.push(
      `${row.detector === null ? 'Every detector' : DETECTOR_META[row.detector].label}: ` +
        `${row.count} fact${row.count === 1 ? '' : 's'} not reported — ${row.detail}.`,
    );
  }

  return {
    routes: collector.routes,
    endpoints: collector.endpoints,
    forms: collector.forms,
    authSurfaces,
    guards,
    components,
    backgroundSurfaces,
    featureFlags,
    locales,
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
    shortfalls: shortfalls.report(),
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
  /*
   * The five non-crawl axes, in the same sentence as the four crawlable ones.
   *
   * Deliberately one summary and not two. Three disjoint inventories of one
   * application on three screens is the defect this round exists to end, and a
   * summary that named routes here and components somewhere else would be the
   * fourth.
   */
  /*
   * Read through `??`, and the sentence CHANGES when they are absent rather
   * than printing zeroes. "0 components" about a stored analysis that predates
   * the component reader is a measured claim about something not measured —
   * and it is the flattering direction, because a reader concludes there is
   * nothing there to test.
   */
  const counted =
    analysis.components !== undefined ||
    analysis.backgroundSurfaces !== undefined ||
    analysis.featureFlags !== undefined ||
    analysis.locales !== undefined;
  if (counted) {
    const components = analysis.components ?? [];
    const background = analysis.backgroundSurfaces ?? [];
    const flags = analysis.featureFlags ?? [];
    const locales = analysis.locales ?? [];
    parts.push(
      `It also found ${components.length} component${components.length === 1 ? '' : 's'}, ` +
        `${background.length} surface${background.length === 1 ? '' : 's'} off the request path, ` +
        `${flags.length} feature flag${flags.length === 1 ? '' : 's'} and ` +
        `${locales.length} locale${locales.length === 1 ? '' : 's'}.`,
    );
  } else {
    parts.push(
      'It did not look for components, background surfaces, feature flags or locales: this analysis ' +
        'was produced before those readers existed, so nothing is claimed about them in either direction.',
    );
  }
  parts.push(
    `${contributed.length} of ${analysis.detectors.length} detectors found something; ` +
      `${ran.length - contributed.length} examined files and found nothing; ` +
      `${idle.length} had no files of their kind to look at.`,
  );

  const unknownAccess = [...analysis.routes, ...analysis.endpoints].filter(
    (item) => item.guard?.access === 'UNKNOWN',
  ).length;
  if (unknownAccess > 0) {
    parts.push(
      `${unknownAccess} of them could not be analysed for guards and are reported UNKNOWN, not public.`,
    );
  }
  /*
   * The lost count, in the summary rather than only in `shortfalls`. A sentence
   * that states a total and omits what the total cost is the undisclosed cap,
   * and the summary is the one line a reader is guaranteed to see.
   */
  const shortfalls = analysis.shortfalls ?? [];
  const lost = shortfalls.reduce((running, row) => running + row.count, 0);
  if (lost > 0) {
    parts.push(
      `${lost} fact${lost === 1 ? '' : 's'} went unreported across ${shortfalls.length} ` +
        `cause${shortfalls.length === 1 ? '' : 's'}, so at least that many more exist than are listed.`,
    );
  }

  parts.push(
    'All of it is static: this is what the source declares, not what the running application does.',
  );
  return parts.join(' ');
}
