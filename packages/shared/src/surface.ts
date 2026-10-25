/**
 * The surface of the application under test — the denominator.
 *
 * WHY THIS FILE EXISTS
 *
 * QAAI could already answer "what did the crawl reach, and which of those did a
 * test touch?" That is a ratio of things already visited, and every vendor in
 * this market computes some version of it: a link crawl's page list, the DOM
 * elements a suite happened to interact with, the sessions a recorder captured,
 * the tickets a human linked. All of them share one property — the denominator
 * is produced by the same process that produces the numerator, so a surface
 * nothing has ever touched is not merely uncovered, it is INVISIBLE.
 *
 * This file is the other denominator: the surface the SOURCE declares, read
 * independently of whether anything has ever reached it. `analyseCodebase`
 * already extracts it — routes, endpoints, forms, auth surfaces, each with the
 * file it was declared in. Nothing has ever divided by it.
 *
 * THE TWO PROPERTIES THAT MAKE A COVERAGE NUMBER WORTH PRINTING
 *
 * 1. It is RECOMPUTABLE by the customer. A percentage a vendor computes in
 *    private is a marketing number. Every item below carries its `kind`, its
 *    stable `key`, the `file` it came from and the `evidence` sentence that
 *    justifies it, so the same extractor run in the customer's own CI produces
 *    the same inventory and they can check our arithmetic.
 *
 * 2. It is HONEST about what it does not know. Three states do real work here
 *    and must never be collapsed into "uncovered":
 *      - UNKNOWN: a test navigates to a URL built at run time, so static
 *        extraction cannot see which item it covers. Counting that as a gap
 *        asserts knowledge we do not have.
 *      - WAIVED: the team has said, on the record, that this item is not worth
 *        testing. Without waivers 100% is unreachable, and an unreachable
 *        target gets gamed instead of met.
 *      - UNREACHED: the source declares it and the crawl never got there. That
 *        is a fact about our enumeration, not about their tests.
 *
 * WHAT THIS FILE IS NOT
 *
 * It computes nothing. It is the vocabulary — the kinds, the key format, the
 * statuses and the snapshot shape — so that the extractor, the matcher, the
 * persistence layer, the API, the CLI gate and the cockpit all mean the same
 * thing by "covered". The arithmetic lives in packages/agent.
 */

// ─── Axes ────────────────────────────────────────────────────────────────────

/**
 * The dimensions of a surface.
 *
 * Four ship now because `analyseCodebase` already extracts all four. The rest
 * are declared deliberately, in one list, because the alternative is what this
 * codebase has done before: a measurement built for routes, then widened one
 * special case at a time until no two screens agree on the denominator.
 *
 * An axis listed here but not yet extracted is reported as a known-absent
 * dimension rather than silently omitted — "we do not measure component states"
 * is a true and useful sentence, and a customer comparing us to a vendor who
 * quietly measures only frontend lines deserves to hear it.
 */
import type { TestResultStatus } from './constants';

export const SURFACE_KINDS = [
  /** A page the source declares a URL for. */
  'ROUTE',
  /** An HTTP operation: method plus path. */
  'ENDPOINT',
  /** A form, identified by its file and index, with its fields. */
  'FORM',
  /** A login/signup/reset/verify/SSO surface. */
  'AUTH_SURFACE',

  // ─ Declared, not yet extracted. Reported as unmeasured dimensions. ─
  /** A route × role cell: "a VIEWER requesting /admin/billing". */
  'ROLE_CELL',
  /** A component in a named state: loading, empty, error. */
  'COMPONENT_STATE',
  /** A combination of feature flags that yields a different application. */
  'FLAG_COMBINATION',
  /** A queue consumer, cron entry or webhook receiver. */
  'BACKGROUND_JOB',
  /** An outbound email or notification template. */
  'NOTIFICATION',
  /** A declared error or empty state of a route. */
  'ERROR_STATE',
  /** A device, viewport or locale the app claims to support. */
  'DEVICE_LOCALE',
  /** A distinct data shape a route must handle: empty, one, many, pathological. */
  'DATA_VARIANT',
] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/** The axes an extractor exists for today. Everything else is reported unmeasured. */
export const MEASURED_SURFACE_KINDS: readonly SurfaceKind[] = [
  'ROUTE',
  'ENDPOINT',
  'FORM',
  'AUTH_SURFACE',
];

export const SURFACE_KIND_LABELS: Record<SurfaceKind, string> = {
  ROUTE: 'Routes',
  ENDPOINT: 'API endpoints',
  FORM: 'Forms',
  AUTH_SURFACE: 'Auth surfaces',
  ROLE_CELL: 'Route × role cells',
  COMPONENT_STATE: 'Component states',
  FLAG_COMBINATION: 'Feature-flag combinations',
  BACKGROUND_JOB: 'Jobs, crons and webhooks',
  NOTIFICATION: 'Emails and notifications',
  ERROR_STATE: 'Error and empty states',
  DEVICE_LOCALE: 'Devices and locales',
  DATA_VARIANT: 'Data variants',
};

// ─── Provenance ──────────────────────────────────────────────────────────────

/**
 * Where an item came from, which is the reconciliation the product turns on.
 *
 * `SOURCE_ONLY` is the interesting one and the reason this whole file exists:
 * the code declares it and the crawl has never reached it. That is either a
 * genuinely unreachable route (dead code the customer will want to delete) or —
 * far more often — a page behind a button, a wizard step, a role we do not hold,
 * or a flag we did not set. Either way it is a thing no runtime-only competitor
 * can see at all.
 *
 * `CRAWL_ONLY` is the mirror and is equally diagnostic: the app serves it and
 * the source analysis never declared it, which usually means a route table we
 * failed to parse. It is evidence about OUR extractor, and suppressing it would
 * be hiding our own error rate.
 */
export const SURFACE_ORIGINS = ['SOURCE_ONLY', 'CRAWL_ONLY', 'BOTH'] as const;
export type SurfaceOrigin = (typeof SURFACE_ORIGINS)[number];

export const SURFACE_ORIGIN_LABELS: Record<SurfaceOrigin, string> = {
  SOURCE_ONLY: 'declared in source, never reached by a crawl',
  CRAWL_ONLY: 'reached by a crawl, never found in source',
  BOTH: 'declared in source and reached by a crawl',
};

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * Whether an item is covered — and the three answers that are not yes or no.
 *
 * COVERED means at least one test is matched to this item AND that test has
 * been seen to run. Those are two different claims and conflating them is how a
 * coverage number becomes a lie: a string appearing in a spec file proves a test
 * was written, not that it executes, not that it passes, and not that it
 * asserts anything. {@link SurfaceItemCoverage.verification} keeps them apart.
 */
export const SURFACE_STATUSES = [
  /**
   * A test is matched to it and has been observed to run. Whether that run
   * passed is a separate question — see {@link SurfaceVerification}.
   */
  'COVERED',
  /**
   * A test is matched to it and no run has ever exercised that test.
   *
   * This must mean literally never run, because that is what its label says.
   * It previously also caught a test that ran and FAILED, which made the
   * sentence shown to the customer — "a test exists but has never run" —
   * false about a test they had watched fail.
   */
  'ASSERTED_NOT_RUN',
  /** Nothing is matched to it. The number this product exists to shrink. */
  'UNCOVERED',
  /**
   * A test might cover it, but static extraction cannot tell — a runtime URL,
   * a computed selector. Never counted as covered and never counted as a gap.
   */
  'UNKNOWN',
  /** The team recorded a reason not to test it. Excluded from the denominator. */
  'WAIVED',
] as const;
export type SurfaceStatus = (typeof SURFACE_STATUSES)[number];

export const SURFACE_STATUS_LABELS: Record<SurfaceStatus, string> = {
  COVERED: 'covered',
  ASSERTED_NOT_RUN: 'a test exists but has never run',
  UNCOVERED: 'no test',
  UNKNOWN: 'cannot tell',
  WAIVED: 'waived',
};

/** Statuses that count toward the numerator. */
export const COVERED_STATUSES: readonly SurfaceStatus[] = ['COVERED'];

/**
 * Statuses excluded from the denominator entirely.
 *
 * Only WAIVED. UNKNOWN deliberately stays IN the denominator: an item we cannot
 * reason about is a hole in our knowledge, and moving it out of the denominator
 * would quietly raise the percentage every time our extractor got worse.
 */
export const EXCLUDED_STATUSES: readonly SurfaceStatus[] = ['WAIVED'];

// ─── Items ───────────────────────────────────────────────────────────────────

/**
 * One thing that can be tested.
 *
 * `key` is the identity, and it must be stable across runs or a snapshot cannot
 * be diffed against the one before it and no trend exists. It is derived only
 * from facts that do not move when the repo is reformatted: the kind and the
 * canonical identity of the thing. Never a line number — adding an import above
 * a form must not retire the form and mint a new one.
 */
export interface SurfaceItem {
  kind: SurfaceKind;
  /** Stable identity. See {@link surfaceKey}. */
  key: string;
  /** What to call it on screen: `/orders/:id`, `POST /api/refunds`. */
  label: string;
  /** Repo-relative file it was declared in, when a source detector found it. */
  file: string | null;
  /**
   * Line in that file, for the editor link. Deliberately NOT part of `key`:
   * it is navigation, not identity.
   */
  line: number | null;
  origin: SurfaceOrigin;
  /**
   * The sentence that justifies the item's existence, in the customer's terms:
   * "app/orders/[id]/page.tsx — directory path is the URL". This is what makes
   * the denominator auditable rather than asserted.
   */
  evidence: string;
  /** Which detector produced it, so a systematically wrong one can be found. */
  detector: string | null;
  /** Kind-specific detail the cockpit renders — a form's fields, an auth kind. */
  meta?: Record<string, unknown>;

  /*
   * ─── Naming the invisible ──────────────────────────────────────────────────
   *
   * Every member below is OPTIONAL and distinguishes three states, exactly as
   * `FormField`'s constraint capture does, because a `CoverageItem` row is
   * STORED and every row written before this slice has none of them:
   *
   *   • absent    → this item predates the capture. Nobody classified it.
   *   • null      → we looked and there is nothing to record.
   *   • a value   → the recorded fact.
   *
   * Collapsing absent into a value is the specific failure this product cannot
   * afford. "Nobody classified it" read as REFUSED drops the item from the
   * denominator and raises the percentage; read as EXERCISABLE it claims a
   * capability we have not got.
   */

  /**
   * Every declarer that put this item in the inventory, newest first.
   *
   * `origin` above is the two-source summary and stays — 16 readers order and
   * group by it. Derive it with `originFromSources` rather than setting both by
   * hand, or the two will disagree about an item and only one of them will be
   * on screen.
   */
  sources?: SurfaceSource[];
  /**
   * Whether a test may touch it here, and why not. An item whose surface
   * nothing is permitted to drive is still COUNTED and NAMED — see
   * `SURFACE_EXERCISABILITIES` for why dropping it instead is the move that
   * makes a coverage number go up.
   */
  exercise?: SurfaceExercise | null;
  /**
   * The environment this item was observed in, when a crawl or traffic declared
   * it. Null for a source declaration, which is environment-independent.
   *
   * Without it a staging-only route enters a production project's denominator
   * and is reported as an uncovered production gap — the same defect as the 13
   * flow-map readers that order by `version` across every environment.
   */
  environmentId?: string | null;
  /**
   * The dimension coordinates, for an item on a multi-axis kind. Parsed from
   * `key` by `parseDimensionCellIdentity`; carried here so a reader does not
   * have to parse, and so a cell with no coordinates is visibly wrong.
   */
  coordinates?: DimensionCoordinate[];
}

/** How a test came to be matched to an item — the audit trail for `COVERED`. */
export interface SurfaceMatch {
  testId: string;
  testName: string;
  /**
   * Why we believe this test covers this item. Mirrors the asymmetry the gap
   * analyser already uses: `LITERAL` where a route string appears verbatim,
   * `HEURISTIC` where the evidence is weaker (a label mentioned in a spec).
   */
  basis: 'LITERAL' | 'NORMALISED' | 'HEURISTIC' | 'DECLARED';
  evidence: string;
}

/**
 * Whether the matched tests have actually been seen to execute.
 *
 * THE THREE FIELDS ARE THREE DIFFERENT QUESTIONS, AND MERGING ANY TWO LIES
 *
 * An earlier version had `executed` mean "a matched test passed" and let a
 * PASSED result overwrite `lastRunId`/`lastStatus`. The effect was that an item
 * whose newest run FAILED reported `lastStatus: 'PASSED'` from an older run —
 * a wrong fact, in the direction that flatters the vendor, on a surface whose
 * only test is red. That is precisely the failure mode this feature exists to
 * avoid, so the fields are now separate and each answers exactly one thing.
 *
 * `executed` also no longer requires a pass. Coverage asks whether a test
 * exists and runs; whether it passes is the run report's job. An item whose
 * test runs and fails IS covered — and failing — and calling it uncovered
 * would be the false sentence "no test has ever asserted anything about this"
 * about a surface that has a test asserting something and finding a bug.
 */
export interface SurfaceVerification {
  /**
   * The genuinely most recent run that executed a matched test — whatever it
   * reported. Never upgraded by an older, happier result.
   */
  lastRunId: string | null;
  /**
   * The status that run reported, in the vocabulary the database and the runner
   * already use — never a parallel spelling invented here.
   */
  lastStatus: TestResultStatus | null;
  /**
   * True when a matched test has been observed to run with a terminal status.
   * SKIPPED does not count: a skipped test asserted nothing.
   *
   * The difference between this and `matches.length > 0` is the difference
   * between a coverage number and a coverage claim.
   */
  executed: boolean;
  /**
   * True when a matched test has run and passed at some point. Reported, but
   * deliberately NOT what makes an item covered — see the note above.
   */
  everPassed: boolean;
  /**
   * Whether any matched test has been shown to kill a mutant in the code behind
   * this item. Null until a mutation run has had an opinion.
   *
   * This is the field no competitor in this market publishes: coverage without
   * it cannot distinguish a test that asserts behaviour from one that asserts
   * the page loaded.
   */
  mutationKilled: boolean | null;
}

export interface SurfaceItemCoverage {
  item: SurfaceItem;
  status: SurfaceStatus;
  matches: SurfaceMatch[];
  verification: SurfaceVerification;
  /** Present only when status is WAIVED. */
  waiver?: SurfaceWaiver;
}

/**
 * The exercisability of one coverage entry, read off the item.
 *
 * A function rather than a second field, so there is exactly one place that
 * knows where the fact lives. `undefined` here means "never classified", which
 * `exercisabilityCounts` deliberately counts — see the note there.
 */
export function exerciseOf(entry: SurfaceItemCoverage): SurfaceExercisability | null | undefined {
  return entry.item.exercise?.state;
}

export interface SurfaceWaiver {
  reason: string;
  /** Who recorded it — a waiver with no owner is a silent exclusion. */
  byUserId: string | null;
  byEmail: string | null;
  createdAtIso: string;
  /**
   * When the waiver lapses. Optional, but a waiver with no expiry is how a
   * denominator quietly shrinks forever, so the UI defaults to proposing one.
   */
  expiresAtIso: string | null;
}

// ─── Keys ────────────────────────────────────────────────────────────────────

/**
 * The stable identity of a surface item.
 *
 * Format: `KIND:identity`. The identity is already canonical by the time it
 * reaches here — routes through `canonicalRoute`, endpoints upper-cased with a
 * canonical path, forms as `file#index`. Keeping the kind as a visible prefix
 * means a key is readable in a log, a URL and a CLI argument, which matters
 * because customers will paste these into waiver files.
 */
export function surfaceKey(kind: SurfaceKind, identity: string): string {
  return `${kind}:${identity}`;
}

/** Splits a key back apart. Returns null when the string is not one of ours. */
export function parseSurfaceKey(key: string): { kind: SurfaceKind; identity: string } | null {
  const separator = key.indexOf(':');
  if (separator <= 0) return null;
  const kind = key.slice(0, separator) as SurfaceKind;
  if (!SURFACE_KINDS.includes(kind)) return null;
  const identity = key.slice(separator + 1);
  if (identity.length === 0) return null;
  return { kind, identity };
}

// ─── Sources: WHICH DECLARER PUT IT IN THE INVENTORY ────────────────────────

/**
 * The declarer that put an item in the inventory.
 *
 * `SurfaceOrigin` above answers a two-source question — source analysis, or a
 * crawl — because for two slices those were the only two declarers that
 * existed. That is also why the whole class of surface that NEITHER can see
 * was absent from the denominator rather than uncovered: a background job, an
 * outbound email, a webhook receiver, a feature flag, a role, a locale, an
 * error path, a download. Nothing crawls them and no route table declares
 * them, so they were not UNCOVERED — they were not THERE.
 *
 * Absent and uncovered are opposite facts. Uncovered lowers the percentage and
 * gets a line in the named list; absent raises it and gets nothing. Every
 * silent omission in a coverage product moves the number the same way, which
 * is why the declarer is now a stored field rather than an inference from two
 * booleans.
 *
 * The eight members are the eight ways this product can learn that something
 * exists, and they are deliberately ranked by what they PROVE:
 *
 *   · CRAWL and TRAFFIC are OBSERVATIONS. Something answered. The thing exists.
 *   · SOURCE, SITEMAP and OPENAPI are DECLARATIONS a machine read. The repo
 *     says it exists; it may be dead code.
 *   · REQUIREMENT, MANUAL and CATALOGUE are DECLARATIONS A HUMAN MADE. A
 *     requirement document, somebody typing it in, or a catalogue of jobs and
 *     email templates the team maintains. These are the only declarers that can
 *     name an uncrawlable surface at all, which is exactly why they exist.
 */
export const SURFACE_SOURCES = [
  /** A crawl reached it. */
  'CRAWL',
  /** A source detector read it out of the repository. */
  'SOURCE',
  /** The application's own sitemap.xml listed it. */
  'SITEMAP',
  /** An OpenAPI/Swagger document declared the operation. */
  'OPENAPI',
  /** Real traffic was observed against it (a HAR, an access log, a proxy). */
  'TRAFFIC',
  /** A requirement, ticket or specification named it. */
  'REQUIREMENT',
  /** A human entered it. The only declarer for a surface nothing can read. */
  'MANUAL',
  /**
   * A maintained catalogue the customer already has: the job registry, the
   * email-template directory, the flag provider, the locale table. Machine
   * read, like SOURCE, but out of a system rather than out of the repo.
   */
  'CATALOGUE',
] as const;
export type SurfaceSource = (typeof SURFACE_SOURCES)[number];

export const SURFACE_SOURCE_LABELS: Record<SurfaceSource, string> = {
  CRAWL: 'reached by a crawl',
  SOURCE: 'declared in source',
  SITEMAP: 'listed in sitemap.xml',
  OPENAPI: 'declared in an OpenAPI document',
  TRAFFIC: 'seen in real traffic',
  REQUIREMENT: 'named in a requirement',
  MANUAL: 'entered by hand',
  CATALOGUE: 'listed in a catalogue',
};

/**
 * The declarers that OBSERVED the thing answering, rather than reading a claim
 * that it exists.
 *
 * Load-bearing in two places. `originFromSources` below derives the legacy
 * SOURCE_ONLY/CRAWL_ONLY/BOTH from this split, so the two vocabularies cannot
 * come to disagree; and `selectFlowMap` in flow-map.ts refuses to let a
 * DECLARED map displace an OBSERVED one, which is the defect where a
 * source-derived flow map at v9 silently replaced a real crawl at v8.
 */
export const OBSERVED_SOURCES: readonly SurfaceSource[] = ['CRAWL', 'TRAFFIC'];

/** True when this declarer watched the thing answer. */
export function isObservedSource(source: SurfaceSource): boolean {
  return OBSERVED_SOURCES.includes(source);
}

/**
 * The legacy three-valued origin, derived from the declarer set.
 *
 * Returns NULL for an empty set, and null is the point: an item whose
 * declarers were never recorded has no origin, and defaulting it to BOTH (the
 * flattering answer) or SOURCE_ONLY (the alarming one) would be a fact we
 * invented. Every stored `CoverageItem` written before the `sources` column
 * existed is in exactly that state.
 */
export function originFromSources(sources: readonly SurfaceSource[]): SurfaceOrigin | null {
  if (sources.length === 0) return null;
  const observed = sources.some(isObservedSource);
  const declared = sources.some((source) => !isObservedSource(source));
  if (observed && declared) return 'BOTH';
  return observed ? 'CRAWL_ONLY' : 'SOURCE_ONLY';
}

// ─── Exercisability: can a test touch it AT ALL ──────────────────────────────

/**
 * Whether a test can exercise this item, and the two reasons it cannot.
 *
 * This is not coverage and must never be stored as coverage. An item QAAI
 * cannot exercise is still IN THE INVENTORY — it is named, it is counted as a
 * surface, and the report says why it is not in the coverage denominator.
 * Dropping it instead is the move that makes the percentage go up, because the
 * hardest surfaces are the ones that get dropped.
 *
 * Three states, and the distinction between the last two is the one that
 * matters most:
 *
 *   EXERCISABLE    a test can drive it with the data and credentials we have.
 *   UNEXERCISABLE  it exists and is testable in principle, but not SAFELY here:
 *                  it ends the session, or it destroys data we cannot replace.
 *                  Give it disposable data and it becomes exercisable — so this
 *                  is a statement about the ENVIRONMENT, not about the surface.
 *   REFUSED        policy excluded it. We did not look. Nothing is claimed
 *                  about it in either direction.
 *
 * A REFUSED surface and a surface that DOES NOT EXIST must never be recorded
 * the same way, which is the specific defect in the crawler today: /logout,
 * /delete-*, /destroy and __reset are dropped with no record at all, so a route
 * we refused is indistinguishable from a route the app does not serve.
 */
export const SURFACE_EXERCISABILITIES = ['EXERCISABLE', 'UNEXERCISABLE', 'REFUSED'] as const;
export type SurfaceExercisability = (typeof SURFACE_EXERCISABILITIES)[number];

export const SURFACE_EXERCISABILITY_LABELS: Record<SurfaceExercisability, string> = {
  EXERCISABLE: 'a test can drive it here',
  UNEXERCISABLE: 'needs disposable data — not safe to drive in this environment',
  REFUSED: 'excluded by policy; never attempted',
};

/**
 * Why an item is UNEXERCISABLE. A closed vocabulary because the report groups
 * by it and because "needs disposable data" is a remedy a customer can act on,
 * while a free-text sentence is one they can only read.
 */
export const UNEXERCISABLE_REASONS = [
  /** Driving it logs the session out, so the rest of the crawl is anonymous. */
  'SESSION_ENDING',
  /** It deletes or cancels something we cannot restore. */
  'DESTRUCTIVE',
  /** It needs a record we are allowed to consume, and none is provisioned. */
  'NEEDS_DISPOSABLE_DATA',
  /** It charges money, sends mail to a real person, or calls a paid third party. */
  'REAL_WORLD_SIDE_EFFECT',
  /** We have no capability for it here: no CDP, no download sink, no mailbox. */
  'CAPABILITY_UNAVAILABLE',
  /** It needs a role, flag or locale this environment cannot produce. */
  'DIMENSION_UNAVAILABLE',
] as const;
export type UnexercisableReason = (typeof UNEXERCISABLE_REASONS)[number];

export const UNEXERCISABLE_REASON_LABELS: Record<UnexercisableReason, string> = {
  SESSION_ENDING: 'ends the session',
  DESTRUCTIVE: 'destroys data that cannot be restored here',
  NEEDS_DISPOSABLE_DATA: 'needs a disposable record and none is provisioned',
  REAL_WORLD_SIDE_EFFECT: 'has a real-world side effect — money, mail, a third party',
  CAPABILITY_UNAVAILABLE: 'the capability it needs is not available here',
  DIMENSION_UNAVAILABLE: 'needs a role, flag or locale this environment cannot produce',
};

/**
 * Exercisabilities that keep an item in the INVENTORY and out of the COVERAGE
 * denominator.
 *
 * Dividing by an item nothing is permitted to touch produces a permanent,
 * unclosable gap, and a target nobody can reach gets gamed instead of met —
 * the same argument that justifies `EXCLUDED_STATUSES`. The difference is the
 * direction of the honesty requirement: a waiver is a decision the TEAM made
 * and is shown next to the number, while these two are limits OUR harness has,
 * so the report has to name them as our limits rather than their waivers.
 */
export const NON_DENOMINATOR_EXERCISABILITIES: readonly SurfaceExercisability[] = [
  'UNEXERCISABLE',
  'REFUSED',
];

/**
 * Whether this entry's exercisability lets it into the coverage denominator.
 *
 * UNDEFINED COUNTS, and that is deliberate. Every `CoverageItem` row written
 * before the column existed has no exercisability, and reading "nobody
 * classified it" as "we are not allowed to touch it" would quietly drop most
 * of an existing install's denominator in one deploy — the percentage would
 * jump on the day of the migration and nothing would explain why.
 */
export function exercisabilityCounts(value: SurfaceExercisability | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return !NON_DENOMINATOR_EXERCISABILITIES.includes(value);
}

/**
 * One item's exercisability, with the evidence for it.
 *
 * `rule` is required for REFUSED and is the whole point of the state: "excluded
 * by policy" with no rule named is indistinguishable from a bug in the crawler,
 * and the customer's only possible response to it is to distrust the number.
 */
export interface SurfaceExercise {
  state: SurfaceExercisability;
  /** Set when state is UNEXERCISABLE. */
  reason?: UnexercisableReason | null;
  /**
   * The policy rule that refused it, when state is REFUSED — a rule id a human
   * can look up in the environment's crawl policy, never a dumped regex.
   */
  rule?: string | null;
  /** The sentence shown next to it. Always written, never defaulted to ''. */
  detail: string;
}

// ─── Dimensions: the axes that were strings in a blob ───────────────────────

/**
 * The dimensions a surface item can be multiplied along.
 *
 * Today roles, locales, devices, flags, jobs and emails exist only as strings
 * inside one JSONB blob — `requiresRoles` on a flow node, a locale list in a
 * spec, a device name in a test title. A string inside a blob cannot be
 * counted, so "route × role × locale" has never been a denominator: there was
 * nothing to divide by. Each of these becomes a queryable row (model
 * `SurfaceDimension`), scoped to an org and a project, carrying the source that
 * declared it.
 *
 * Six and not twelve: these are the dimensions whose VALUES are enumerable
 * independently of the pages they apply to. A component state or a data variant
 * is a property of one item and belongs on that item, not in a shared table.
 */
export const SURFACE_DIMENSION_KINDS = [
  'ROLE',
  'LOCALE',
  'DEVICE',
  'FLAG',
  'JOB',
  'EMAIL',
] as const;
export type SurfaceDimensionKind = (typeof SURFACE_DIMENSION_KINDS)[number];

export const SURFACE_DIMENSION_LABELS: Record<SurfaceDimensionKind, string> = {
  ROLE: 'Roles',
  LOCALE: 'Locales',
  DEVICE: 'Devices and viewports',
  FLAG: 'Feature flags',
  JOB: 'Jobs, crons and webhook receivers',
  EMAIL: 'Emails and notifications',
};

/**
 * Which existing axis each dimension's cells land on.
 *
 * A `Record` keyed on the dimension union, so a seventh dimension breaks this
 * line rather than quietly producing cells with no axis to be counted on. The
 * mapping is also the reason this is an extension and not a fork: the twelve
 * `SURFACE_KINDS` already named every one of these axes, and a dimension whose
 * cells landed on a thirteenth kind would be a second denominator.
 *
 * JOB and EMAIL map to axes whose cells are not pairings at all — a job is a
 * surface in its own right, not a route × job cell. They are in this table
 * anyway because the question "how many jobs does this app have" needs the same
 * enumerable, sourced, org-scoped row as the question "how many roles", and
 * `dimensionDenominator` below is given no base keys for them.
 */
export const DIMENSION_AXIS: Record<SurfaceDimensionKind, SurfaceKind> = {
  ROLE: 'ROLE_CELL',
  LOCALE: 'DEVICE_LOCALE',
  DEVICE: 'DEVICE_LOCALE',
  FLAG: 'FLAG_COMBINATION',
  JOB: 'BACKGROUND_JOB',
  EMAIL: 'NOTIFICATION',
};

/**
 * The per-dimension detail, as a discriminated union.
 *
 * ── Why a union and not a `Record<string, unknown>` ─────────────────────────
 *
 * Because the six are not the same shape and pretending they are is the defect
 * item 2 of the register names. A locale has a BCP-47 tag and a text direction;
 * a device has a width, a height and whether it is touch; a flag has variants
 * and a default; a job has a trigger and a schedule; an email has a template id
 * and what sends it. Flattened into one blob of strings, not one of those
 * properties can be validated on the way in or filtered on the way out, and a
 * device with no width cannot be used to drive anything.
 *
 * ── The write path, and the pattern this copies ─────────────────────────────
 *
 * This union HAS a write path (`dimensionDetailSchema` in schemas.ts is the
 * only way a row is created), so it carries both halves of the guard that
 * `GateRule` now has: `DIMENSION_DETAIL_PRESENT` is a
 * `Record<DimensionDetail['dimension'], true>` the compiler refuses to let
 * drift, and a run-time parity test in surface.test.ts compares that list
 * against the zod union's own options. Two mechanisms because each catches what
 * the other cannot — eight `GateRule` kinds were unsaveable by any customer for
 * two slices precisely because only one existed.
 */
export type DimensionDetail =
  | {
      dimension: 'ROLE';
      /**
       * True for a role that can reach administrative surface. Not cosmetic: a
       * route × role cell for a privileged role is where an authorization
       * defect is worth finding, and the ranking has to come from somewhere
       * other than the role's name.
       */
      privileged: boolean;
      /** The role this one inherits from, when the app declares a hierarchy. */
      inheritsFrom: string | null;
    }
  | {
      dimension: 'LOCALE';
      /** BCP-47 as the app spells it: `pt-BR`, not `pt_br`. */
      tag: string;
      /** RTL locales re-lay-out the page, so they are not a string swap. */
      rtl: boolean;
    }
  | {
      dimension: 'DEVICE';
      widthPx: number;
      heightPx: number;
      touch: boolean;
      /** Playwright device descriptor name, when it is one of theirs. */
      descriptor: string | null;
    }
  | {
      dimension: 'FLAG';
      /** Every value this flag can take. `['on','off']` for a boolean flag. */
      variants: string[];
      /** The variant served when nothing overrides it. Null when unknown. */
      defaultVariant: string | null;
      /** The provider it is read from: LaunchDarkly, a table, an env var. */
      provider: string | null;
    }
  | {
      dimension: 'JOB';
      /** How it starts: CRON, QUEUE, WEBHOOK, STARTUP, MANUAL. */
      trigger: string;
      /** Cron expression or queue name — whatever the trigger implies. */
      schedule: string | null;
      /** True for a receiver the public internet can reach. */
      publiclyTriggerable: boolean;
    }
  | {
      dimension: 'EMAIL';
      /** The template identity, which is what a mailbox assertion matches on. */
      templateId: string;
      /** What sends it, in the customer's words. */
      sentBy: string | null;
      /** Transactional mail is testable; a marketing blast is usually waived. */
      transactional: boolean;
    };

/**
 * Every discriminant `DimensionDetail` has, as a run-time value. See the note
 * on the union above: the compiler enforces this record, and surface.test.ts
 * enforces the zod union against it.
 */
const DIMENSION_DETAIL_PRESENT: Record<DimensionDetail['dimension'], true> = {
  ROLE: true,
  LOCALE: true,
  DEVICE: true,
  FLAG: true,
  JOB: true,
  EMAIL: true,
};

export const DIMENSION_DETAIL_KINDS = Object.keys(DIMENSION_DETAIL_PRESENT) as ReadonlyArray<
  DimensionDetail['dimension']
>;

/**
 * One row of a dimension table.
 *
 * `key` is the identity and is scoped to (project, kind): two projects may both
 * have an `ADMIN` role and they are different things. `label` is for people;
 * `key` is what a cell identity is built from, so it must be the spelling the
 * APPLICATION uses — never title-cased, never lower-cased on the way in. A role
 * the app calls `Admin` and a role it calls `admin` are two roles until the
 * customer says otherwise, and normalising them here would merge two cells and
 * shrink a denominator silently.
 */
export interface SurfaceDimensionValue {
  kind: SurfaceDimensionKind;
  /** Identity within (project, kind). The app's own spelling. */
  key: string;
  label: string;
  /** Which declarer put it in the table. */
  source: SurfaceSource;
  /** The sentence that justifies the row, same contract as `SurfaceItem`. */
  evidence: string;
  /**
   * True for the value used when nothing selects one: the anonymous role, the
   * default locale, the desktop viewport, the flag's off state. At most one per
   * (project, kind) — enforced by the writer, because two defaults make
   * `dimensionDenominator`'s default-cell arithmetic ambiguous.
   */
  isDefault: boolean;
  /**
   * Whether this environment can actually produce the value. A role we hold no
   * credentials for is DIMENSION_UNAVAILABLE on every cell it appears in, and
   * saying so is better than reporting those cells as uncovered.
   */
  available: boolean;
  detail: DimensionDetail;
  /** Repo-relative file or catalogue reference, when a reader found one. */
  file?: string | null;
}

// ─── Cell identity: the key six writers must agree on ───────────────────────

/**
 * How a multi-axis cell's identity is spelled, and why it is a function.
 *
 * Several independent writers mint these — the role prober, the locale sweep,
 * the flag enumerator, the manual entry form — and a cell is only diffable
 * across runs if every one of them produces a byte-identical key. The format
 * is deliberately readable, because customers paste these into waiver files:
 *
 *   /admin/billing|ROLE=VIEWER
 *   /checkout|DEVICE=iphone-15|LOCALE=pt-BR
 *
 * Rules, all four of which are tested:
 *
 *   1. Coordinates are sorted by the dimension's position in
 *      `SURFACE_DIMENSION_KINDS`, not alphabetically. Declaration order is
 *      fixed in this file; alphabetical order of what a customer happens to
 *      have configured is not, and re-sorting a key retires every cell and
 *      mints a new one.
 *   2. Values keep their case. See `SurfaceDimensionValue.key`.
 *   3. `|`, `=` and `%` inside a base or a value are percent-encoded, so a
 *      locale called `a=b` cannot forge a second coordinate.
 *   4. One coordinate per dimension. Two LOCALE values in one cell is not a
 *      cell, it is two, and this throws rather than silently keeping the last.
 */
export interface DimensionCoordinate {
  dimension: SurfaceDimensionKind;
  /** The `SurfaceDimensionValue.key`, not the label. */
  value: string;
}

/** Percent-encodes only the three characters the format reserves. */
function encodeCellPart(raw: string): string {
  return raw.replace(/[%|=]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeCellPart(raw: string): string {
  return raw.replace(/%(25|7C|3D)/gi, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/**
 * The identity of one multi-axis cell. Pass it to {@link surfaceKey} with the
 * axis from {@link DIMENSION_AXIS} to get the stored `CoverageItem.key`.
 */
export function dimensionCellIdentity(
  base: string,
  coordinates: readonly DimensionCoordinate[],
): string {
  if (base.length === 0) throw new Error('a dimension cell needs a base identity');
  const seen = new Set<SurfaceDimensionKind>();
  for (const coordinate of coordinates) {
    if (seen.has(coordinate.dimension)) {
      throw new Error(
        `two ${coordinate.dimension} coordinates in one cell — that is two cells, not one`,
      );
    }
    seen.add(coordinate.dimension);
  }
  const ordered = [...coordinates].sort(
    (left, right) =>
      SURFACE_DIMENSION_KINDS.indexOf(left.dimension) -
      SURFACE_DIMENSION_KINDS.indexOf(right.dimension),
  );
  return [
    encodeCellPart(base),
    ...ordered.map((coordinate) => `${coordinate.dimension}=${encodeCellPart(coordinate.value)}`),
  ].join('|');
}

/** Splits a cell identity back apart. Null when the string is not one of ours. */
export function parseDimensionCellIdentity(
  identity: string,
): { base: string; coordinates: DimensionCoordinate[] } | null {
  const parts = identity.split('|');
  const rawBase = parts.shift();
  if (rawBase === undefined || rawBase.length === 0) return null;

  const coordinates: DimensionCoordinate[] = [];
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator <= 0) return null;
    const dimension = part.slice(0, separator) as SurfaceDimensionKind;
    if (!SURFACE_DIMENSION_KINDS.includes(dimension)) return null;
    const value = decodeCellPart(part.slice(separator + 1));
    if (value.length === 0) return null;
    coordinates.push({ dimension, value });
  }
  return { base: decodeCellPart(rawBase), coordinates };
}

// ─── The multi-axis denominator, which is NOT the cross product ─────────────

/**
 * How a multi-axis denominator is computed. The short answer: by COUNTING
 * DECLARED PAIRINGS and reporting the cross product beside them, never by
 * multiplying.
 *
 * ── Why the cross product is the wrong answer ───────────────────────────────
 *
 * 412 routes × 7 roles × 12 locales × 4 devices is 138,432 cells. Printing that
 * as a denominator makes every real number look like a rounding error, and it
 * is also false: it asserts that every role interacts with every locale on
 * every route, which no source anywhere has declared. A vendor who multiplies
 * is not measuring more of the app, they are dividing by a number they made up
 * — and the percentage that falls out moves whenever a customer adds a locale,
 * for no reason connected to their tests.
 *
 * ── What the answer is ──────────────────────────────────────────────────────
 *
 * A cell enters the denominator when a SOURCE DECLARED that the dimension
 * changes this item's behaviour. `/admin/billing` declares a role requirement,
 * so it has one cell per role in that declaration. `/pricing` declares none, so
 * it has exactly one cell, at the default value, and that cell is counted
 * SEPARATELY (`defaultCells`) so a reader can see how much of the axis is
 * "nobody has said anything about this".
 *
 * Three numbers are therefore reported and none of them is derivable from the
 * others:
 *
 *   declaredCells  pairings a declarer asserted. The real denominator.
 *   defaultCells   bases with no declaration, counted once at the default.
 *   crossProduct   bases × values. Reported so the gap between what is
 *                  POSSIBLE and what is DECLARED is visible rather than
 *                  implied — and so nobody has to guess whether we multiplied.
 *
 * ── The finding this produces ───────────────────────────────────────────────
 *
 * `unpairedValues` is the sentence a customer forwards: "no route anywhere
 * declares the SUPPORT role". That is either a role nobody uses or an entire
 * authorization surface nothing has ever looked at, and both are worth a
 * meeting. It is only computable because the values are rows now.
 */
export interface DimensionDenominatorInput {
  dimension: SurfaceDimensionKind;
  /**
   * Identities of the items that can be paired — normally the ROUTE and
   * ENDPOINT axes. Empty for JOB and EMAIL, whose cells are not pairings.
   */
  baseKeys: readonly string[];
  /** The dimension's values for this project, as rows. */
  values: readonly string[];
  /** The value used when nothing is declared, or null when there is none. */
  defaultValue: string | null;
  /**
   * base identity → the values a declarer says change this item's behaviour.
   * A base absent from the map has no declaration and contributes a default
   * cell only.
   */
  declared: ReadonlyMap<string, readonly string[]>;
}

export interface DimensionDenominator {
  dimension: SurfaceDimensionKind;
  /** The `SURFACE_KINDS` axis these cells are counted on. */
  axis: SurfaceKind;
  /** Pairings a declarer asserted. */
  declaredCells: number;
  /** Bases with no declaration, counted once at the default value. */
  defaultCells: number;
  /** `declaredCells + defaultCells`. What to divide by. */
  cells: number;
  /** `baseKeys.length * values.length`. Never the denominator. */
  crossProduct: number;
  /** Bases a declarer said something about. */
  pairedBases: number;
  /** Bases nothing declared. */
  unpairedBases: number;
  /** Values no base declares and which are not the default. A finding. */
  unpairedValues: string[];
  /**
   * Values a declaration named that the dimension table does not hold. Counted
   * nowhere — a pairing against a value that does not exist is a dangling
   * reference in OUR extractor, and inflating the denominator with it would
   * hide our own error rate.
   */
  undeclaredValues: string[];
  /** The sentence the report prints where a product would otherwise go. */
  rule: string;
}

export function dimensionDenominator(input: DimensionDenominatorInput): DimensionDenominator {
  const known = new Set(input.values);
  const paired = new Set<string>();
  const usedValues = new Set<string>();
  const undeclared = new Set<string>();

  let declaredCells = 0;
  let defaultCells = 0;

  for (const base of input.baseKeys) {
    const declaration = input.declared.get(base);
    /*
     * Filtered against the dimension table on purpose, and the filter is what
     * keeps `cells <= crossProduct` true. A declaration naming a value no row
     * holds would otherwise push the denominator above the cross product, which
     * is an arithmetic impossibility a reader would rightly refuse to believe.
     */
    const usable = (declaration ?? []).filter((value) => {
      if (known.has(value)) return true;
      undeclared.add(value);
      return false;
    });

    if (usable.length > 0) {
      paired.add(base);
      declaredCells += new Set(usable).size;
      for (const value of usable) usedValues.add(value);
      continue;
    }
    // No usable declaration. One cell at the default, or none when the project
    // has not said what its default is — inventing one would be inventing a
    // measurement.
    if (input.defaultValue !== null) defaultCells += 1;
  }

  const unpairedValues = input.values.filter(
    (value) => !usedValues.has(value) && value !== input.defaultValue,
  );

  return {
    dimension: input.dimension,
    axis: DIMENSION_AXIS[input.dimension],
    declaredCells,
    defaultCells,
    cells: declaredCells + defaultCells,
    crossProduct: input.baseKeys.length * input.values.length,
    pairedBases: paired.size,
    unpairedBases: input.baseKeys.length - paired.size,
    unpairedValues,
    undeclaredValues: [...undeclared],
    rule:
      `${declaredCells} declared pairing(s) plus ${defaultCells} default cell(s); ` +
      `the cross product would be ${input.baseKeys.length} × ${input.values.length} = ` +
      `${input.baseKeys.length * input.values.length}, which is not what was counted`,
  };
}

export interface MultiAxisDenominator {
  /** The sum over dimensions. A SUM — see `rule`. */
  cells: number;
  /** The sum of each dimension's cross product, for the same comparison. */
  crossProduct: number;
  byDimension: DimensionDenominator[];
  rule: string;
}

/**
 * Rolls the per-dimension counts into one number by ADDING them.
 *
 * Adding, not multiplying, and this is the sentence the product has to be able
 * to defend: a route × role cell and a route × locale cell are two separate
 * things to test, so they add. A route × role × locale cell would be a third
 * thing — and it only exists if some declarer said that role and locale
 * interact on that route. Multiplying the dimensions together asserts that
 * interaction for every combination, which is the lie the cross product tells.
 *
 * When a genuine three-way cell does exist, its identity carries all three
 * coordinates (see `dimensionCellIdentity`) and it is one item on one axis —
 * counted once, by the same arithmetic as everything else.
 */
export function multiAxisDenominator(parts: readonly DimensionDenominator[]): MultiAxisDenominator {
  const cells = parts.reduce((running, part) => running + part.cells, 0);
  const crossProduct = parts.reduce((running, part) => running + part.crossProduct, 0);
  return {
    cells,
    crossProduct,
    byDimension: [...parts],
    rule:
      `${cells} cell(s), summed across ${parts.length} dimension(s) and never multiplied: ` +
      `a route × role cell and a route × locale cell are two things to test, not one ` +
      `combined thing. A three-way cell is counted once, on one axis, when a declarer ` +
      `says the dimensions interact.`,
  };
}

// ─── Snapshots ───────────────────────────────────────────────────────────────

/** Per-axis arithmetic. Every field is a count, so the division is checkable. */
export interface SurfaceKindTotals {
  kind: SurfaceKind;
  /** Items on this axis, excluding waived. */
  denominator: number;
  covered: number;
  assertedNotRun: number;
  uncovered: number;
  unknown: number;
  waived: number;
  /**
   * Items held out of the denominator because OUR harness cannot drive them
   * safely here, and items a policy rule refused.
   *
   * Optional, and for the same reason as `FormField.maxLength`: `byKind` is
   * stored as JSON on every `CoverageSnapshot` ever written, and a snapshot
   * from before this slice has not got these numbers. Absent means "this
   * measurement did not classify exercisability"; 0 means "it did, and found
   * none". A reader that cannot tell those apart will report an old install as
   * having nothing unexercisable, which is a claim it has no evidence for.
   *
   * They are NOT part of `denominator`, and they are not part of `waived`
   * either: a waiver is the team's decision, these two are our limits, and a
   * report that merged them would blame the customer for our harness.
   */
  unexercisable?: number;
  refused?: number;
  /**
   * `covered / denominator`, rounded to one decimal, or null when the
   * denominator is zero.
   *
   * Null is not 0% and not 100%. An axis with nothing on it means the extractor
   * found nothing, and printing either number would be a claim about the
   * customer's app made from our own silence.
   */
  percent: number | null;
  /** False for an axis QAAI has no extractor for. Stated, never omitted. */
  measured: boolean;
}

export interface SurfaceSnapshotTotals {
  /** The headline. Same formula as the per-axis one, over every measured axis. */
  percent: number | null;
  denominator: number;
  covered: number;
  assertedNotRun: number;
  uncovered: number;
  unknown: number;
  waived: number;
  /** Summed from the per-axis counts. Optional for the same stored-JSON reason. */
  unexercisable?: number;
  refused?: number;
  byKind: SurfaceKindTotals[];
  /** Items the source declares that no crawl has reached. */
  declaredNeverReached: number;
  /** Items a crawl reached that the source analysis never declared. */
  reachedNeverDeclared: number;
}

/**
 * A stored measurement, so a trend exists and a gate has something to compare.
 *
 * The inputs are recorded alongside the number because a percentage without its
 * inputs cannot be defended in a meeting. If the crawl was truncated at 60
 * pages, that belongs next to the figure it produced, not in a tooltip.
 */
export interface SurfaceSnapshot {
  /**
   * Null when this measurement was computed and not stored — which is every
   * GET, by design. It was previously the empty string, which is a value that
   * looks like an id and silently fails any truthiness check a consumer
   * forgets to write.
   */
  id: string | null;
  projectId: string;
  createdAtIso: string;
  /** The commit this was measured against, when the caller knew it. */
  commitSha: string | null;
  totals: SurfaceSnapshotTotals;
  /** What the measurement was computed from, for auditability. */
  inputs: {
    analysisId: string | null;
    flowMapVersion: number | null;
    testCount: number;
    runId: string | null;
  };
  /** Things a reader must know before trusting the number. Never empty-by-default. */
  caveats: string[];
  /** Changes whenever the answer could change. */
  fingerprint: string;
}

// ─── Reports ─────────────────────────────────────────────────────────────────

/**
 * The dark-surface report: the named list, which is the actual product.
 *
 * A percentage gets argued about; a list of 43 named routes with the file each
 * one is declared in gets forwarded. So this is the shape the API returns and
 * the CLI prints, and the percentage is a field on it rather than the point.
 */
export interface DarkSurfaceReport {
  projectId: string;
  snapshot: SurfaceSnapshot;
  /** Uncovered items, worst axis first, each with its file and evidence. */
  uncovered: SurfaceItemCoverage[];
  /** Items we cannot reason about. Reported separately, never as gaps. */
  unknown: SurfaceItemCoverage[];
  /** Waived items, so an exclusion is always visible next to the number. */
  waived: SurfaceItemCoverage[];
  /**
   * Items held out because this harness cannot drive them here, and items a
   * policy rule refused. Two lists and not one: "give us a disposable account
   * and we will test these 14" and "your crawl policy excluded these 31" are
   * different sentences with different remedies, and the second one is the only
   * place a reader ever learns that a refusal happened at all.
   *
   * They are listed for the same reason `unmeasuredKinds` is: an exclusion that
   * appears nowhere is indistinguishable from a surface that does not exist.
   */
  unexercisable: SurfaceItemCoverage[];
  refused: SurfaceItemCoverage[];
  /** Axes with no extractor, named so the gap in our own measurement is stated. */
  unmeasuredKinds: SurfaceKind[];
  /** True when more uncovered items exist than were returned. */
  truncated: boolean;
}

// ─── Arithmetic ──────────────────────────────────────────────────────────────

/**
 * One decimal place, and null rather than a number when there is nothing to
 * divide. Centralised because a coverage product with two rounding rules has
 * two coverage numbers.
 */
export function coveragePercent(covered: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((covered / denominator) * 1000) / 10;
}

/** Totals for one axis from its items. The only place a per-kind count is derived. */
export function totalsForKind(
  kind: SurfaceKind,
  items: readonly SurfaceItemCoverage[],
): SurfaceKindTotals {
  const mine = items.filter((entry) => entry.item.kind === kind);
  const count = (status: SurfaceStatus) => mine.filter((entry) => entry.status === status).length;

  /*
   * Driven by COVERED_STATUSES and EXCLUDED_STATUSES, not by string literals.
   *
   * This read `count('COVERED')` and `mine.length - count('WAIVED')`, which
   * happened to agree with the two constants while leaving them inert — a
   * mutation adding ASSERTED_NOT_RUN to COVERED_STATUSES changed nothing but a
   * caveat, and EXCLUDED_STATUSES had no reader anywhere in the repo.
   *
   * That is this codebase's signature defect in miniature: the documented lever
   * and the thing it claims to govern were in different packages with nothing
   * connecting them, so the next person to implement "stop counting X as
   * covered" would edit the constant, see the tests pass, and ship no change.
   */
  const waived = count('WAIVED');
  const covered = mine.filter((entry) => COVERED_STATUSES.includes(entry.status)).length;
  const excluded = mine.filter((entry) => EXCLUDED_STATUSES.includes(entry.status)).length;

  /*
   * The second exclusion, and it is a different KIND of exclusion.
   *
   * `EXCLUDED_STATUSES` holds out what the team decided not to test.
   * `NON_DENOMINATOR_EXERCISABILITIES` holds out what THIS HARNESS cannot drive
   * here — a session-ending flow with no disposable account, a destructive
   * endpoint, a path a policy rule refused. Both leave the item in the
   * inventory and both are counted, separately, because the remedy differs:
   * one is a conversation with the team and the other is work for us.
   *
   * A waived item is counted only once. Without the `&&` an item that is both
   * waived and unexercisable would be subtracted twice and the denominator
   * would come out below the number of items it was derived from — the kind of
   * arithmetic error a customer reproduces in a spreadsheet and never trusts us
   * again after.
   */
  const heldOut = mine.filter(
    (entry) =>
      !EXCLUDED_STATUSES.includes(entry.status) && !exercisabilityCounts(exerciseOf(entry)),
  );
  const unexercisable = heldOut.filter((entry) => exerciseOf(entry) === 'UNEXERCISABLE').length;
  const refused = heldOut.filter((entry) => exerciseOf(entry) === 'REFUSED').length;
  const denominator = mine.length - excluded - heldOut.length;

  return {
    kind,
    denominator,
    covered,
    assertedNotRun: count('ASSERTED_NOT_RUN'),
    uncovered: count('UNCOVERED'),
    unknown: count('UNKNOWN'),
    waived,
    unexercisable,
    refused,
    percent: coveragePercent(covered, denominator),
    measured: MEASURED_SURFACE_KINDS.includes(kind),
  };
}

/**
 * The headline totals.
 *
 * Only MEASURED axes contribute. An axis we have no extractor for must not
 * enter the denominator as a row of zeroes — that would read as "0% of your
 * component states are covered" when the truth is "we do not look at component
 * states", and the first sentence is a lie about the customer's app while the
 * second is a fact about our product.
 */
export function totalsForItems(items: readonly SurfaceItemCoverage[]): SurfaceSnapshotTotals {
  /*
   * `+ unexercisable + refused` in the keep-it predicate, because without them
   * an unmeasured axis holding nothing BUT held-out items vanished from the
   * report entirely: denominator 0, waived 0, filtered out. That is the exact
   * shape of the bug this slice exists to end — the surfaces we cannot drive
   * are the ones most worth naming, and they were the ones that disappeared.
   */
  const byKind = SURFACE_KINDS.map((kind) => totalsForKind(kind, items)).filter(
    (totals) =>
      totals.measured ||
      totals.denominator + totals.waived + (totals.unexercisable ?? 0) + (totals.refused ?? 0) > 0,
  );

  const measured = byKind.filter((totals) => totals.measured);
  const sum = (pick: (totals: SurfaceKindTotals) => number) =>
    measured.reduce((running, totals) => running + pick(totals), 0);

  const covered = sum((t) => t.covered);
  const denominator = sum((t) => t.denominator);

  return {
    percent: coveragePercent(covered, denominator),
    denominator,
    covered,
    assertedNotRun: sum((t) => t.assertedNotRun),
    uncovered: sum((t) => t.uncovered),
    unknown: sum((t) => t.unknown),
    waived: sum((t) => t.waived),
    unexercisable: sum((t) => t.unexercisable ?? 0),
    refused: sum((t) => t.refused ?? 0),
    byKind,
    declaredNeverReached: items.filter((entry) => entry.item.origin === 'SOURCE_ONLY').length,
    reachedNeverDeclared: items.filter((entry) => entry.item.origin === 'CRAWL_ONLY').length,
  };
}

/** The axes with no extractor, for the report to name rather than omit. */
export function unmeasuredKinds(): SurfaceKind[] {
  return SURFACE_KINDS.filter((kind) => !MEASURED_SURFACE_KINDS.includes(kind));
}
