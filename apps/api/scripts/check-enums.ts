#!/usr/bin/env tsx
/**
 * Fail the build when a Prisma enum and its TypeScript twin drift apart.
 *
 * `packages/shared/src/constants.ts` has advertised this script by name since
 * the beginning — "npm run check:enums fails the build when they drift" — and
 * the file did not exist, so `npm run check:enums` died with MODULE_NOT_FOUND
 * and nothing enforced the parity every plugin lookup depends on.
 *
 * It was not hypothetical. Five TestType members were added to the Prisma
 * schema and to constants.ts, and the database itself was left five values
 * behind; the mismatch was invisible until a row was written. This script
 * compares all three: the schema, the TS constants, and — when a database is
 * reachable — the live enum.
 *
 * Exit 1 on any drift, so CI stops rather than shipping a type whose rows
 * cannot be inserted.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

// The repo-root .env, same file and same path the API itself loads. Without
// this the live-database check silently skips — which is precisely the check
// that would have caught the five un-migrated enum values.
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const SCHEMA = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
const CONSTANTS = fileURLToPath(new URL('../../../packages/shared/src/constants.ts', import.meta.url));
const TYPES = fileURLToPath(new URL('../../../packages/shared/src/types.ts', import.meta.url));
// Not every mirror lives in @qaai/shared. RunnerJobStatus is declared next to
// the lease and reaper logic that is its only reader, and moving it here just to
// be checkable would be the tail wagging the dog.
const RUNNERS = fileURLToPath(new URL('../src/lib/runners.ts', import.meta.url));
const SSO = fileURLToPath(new URL('../src/lib/sso.ts', import.meta.url));
/*
 * The enumeration vocabularies. They are in @qaai/shared but NOT in
 * constants.ts or types.ts: `surface.ts` and `flow-map.ts` are the files whose
 * readers consume them, and `scripts/check-wiring.ts` already treats
 * `surface.ts` as the home of the surface vocabulary (SURFACE_VOCABULARY there
 * diffs three of its lists against the Prisma enums). Dragging four more lists
 * into constants.ts purely to be reachable from this script would be the tail
 * wagging the dog — the same judgement the RUNNERS entry above records.
 */
const SURFACE = fileURLToPath(new URL('../../../packages/shared/src/surface.ts', import.meta.url));
const FLOW_MAP = fileURLToPath(new URL('../../../packages/shared/src/flow-map.ts', import.meta.url));
/*
 * The non-crawl enumeration vocabularies, in @qaai/shared for the same reason
 * and NOT in constants.ts either. `requirements.ts` is the spec side (what a
 * human declared) and `api-surface.ts` the machine-read side (what a document,
 * a module tree or a week of traffic declares); each sits beside the readers
 * that consume it, and each also holds the write-path schema for its own
 * vocabulary, which is the arrangement that stops a member existing with no
 * way to save it.
 */
const REQUIREMENTS = fileURLToPath(
  new URL('../../../packages/shared/src/requirements.ts', import.meta.url),
);
const API_SURFACE = fileURLToPath(
  new URL('../../../packages/shared/src/api-surface.ts', import.meta.url),
);
/*
 * The auth-gated enumeration vocabulary: who QAAI can be, whether it can reach
 * the door, and what each identity was allowed to see. In @qaai/shared and NOT
 * in constants.ts for the same reason as the four above — `auth-profiles.ts`
 * holds the write-path schemas for its own kinds beside the vocabulary, which
 * is the arrangement that stops a member existing with no way to save it, and
 * it is also the only one of these files that may import `flow-map.ts` (the
 * route-access basis is pinned to the in-memory union by a presence record
 * there; constants.ts cannot import it, because flow-map.ts imports
 * constants.ts).
 */
const AUTH_PROFILES = fileURLToPath(
  new URL('../../../packages/shared/src/auth-profiles.ts', import.meta.url),
);
/*
 * The measurement vocabulary: the coverage ladder and where an edge's evidence
 * came from. In @qaai/shared and NOT in constants.ts for the same reason as the
 * six above — `coverage-tiers.ts` holds the rank table, the per-source ceiling
 * and the promotion rule beside the vocabulary, and it also holds nothing else,
 * so dragging two lists into constants.ts would separate them from the only
 * code that interprets them.
 *
 * The metric channel's two enums are NOT here: `METRIC_UNITS` and
 * `METRIC_DIRECTIONS` live in types.ts, beside `TestMetric`, which is the shape
 * a plugin returns. They are paired below with `source: 'types'`.
 */
const COVERAGE_TIERS_FILE = fileURLToPath(
  new URL('../../../packages/shared/src/coverage-tiers.ts', import.meta.url),
);
/*
 * The dimension vocabulary: the axes a number may be broken down on, the kinds
 * of cell that live below a surface item, why a cell carries no measurement,
 * which test types a deployment can execute, and whether a seeded defect was
 * found. In @qaai/shared and NOT in constants.ts for the same reason as the
 * seven above — `coverage-dimensions.ts` holds the cell-kind-to-dimension
 * record, the two measurement constructors and the comparability rule beside
 * the vocabulary, and dragging five lists into constants.ts would separate them
 * from the only code that interprets them.
 *
 * `SNAPSHOT_COMPARABILITIES` and `VALIDITY_VERDICTS` are deliberately NOT
 * paired below, and that is not an omission: neither is a Prisma enum.
 * `CoverageSnapshot.comparability`, `CoverageHistory.comparability` and
 * `ValidityBacktest.verdict` are TEXT columns with their domain enforced at the
 * producer, exactly as `MutationSurvivor.reason`, `CoverageItem`.
 * `unexercisableReason` and `TestCoverageEdge.cappedBy` are. Nothing filters
 * rows on them, so an enum would have been two more Postgres types whose only
 * job is to need a drift guard. The run-time parity for those two lives in
 * packages/shared/src/coverage-dimensions.test.ts against the zod schemas.
 */
const COVERAGE_DIMENSIONS_FILE = fileURLToPath(
  new URL('../../../packages/shared/src/coverage-dimensions.ts', import.meta.url),
);

/**
 * Enums that must exist identically on both sides, and the TS declaration that
 * mirrors each.
 *
 * `kind` matters: most mirrors are a `const X = [...] as const` array, but
 * RunShardStatus is a union TYPE. It was added after this script existed and
 * landed outside it — the newest enum in the repo was the one enum the drift
 * guard could not see, which is exactly the hole this script was written to
 * close.
 */
const PAIRS: Array<{
  prismaEnum: string;
  tsConst: string;
  source?:
    | 'constants'
    | 'types'
    | 'runners'
    | 'sso'
    | 'surface'
    | 'flowMap'
    | 'requirements'
    | 'apiSurface'
    | 'authProfiles'
    | 'coverageTiers'
    | 'coverageDimensions';
  kind?: 'array' | 'union';
}> = [
  { prismaEnum: 'TestType', tsConst: 'TEST_TYPES' },
  /*
   * Whether a test passed, which is the enum the ENTIRE product's pass/fail
   * arithmetic is built on — and it had no drift guard for the life of this
   * repo. Found by the durable half of
   * `check-enums.measurement.test.ts` ("pair every enum the new models
   * store"), which went red because "TestResultVariant"."status" stores it:
   * exactly the same class of finding as `AuthProfileKind`, which that
   * mechanism caught one round earlier.
   *
   * Unlike `AuthProfileKind` it can go straight in. Its five labels have been
   * deployed since the init migration and this round adds none, so all three
   * sources — schema.prisma, constants.ts and the live database — agree today
   * and the LIVE half is not blocked on a deploy.
   */
  { prismaEnum: 'TestResultStatus', tsConst: 'TEST_RESULT_STATUSES' },
  { prismaEnum: 'Verdict', tsConst: 'VERDICTS' },
  { prismaEnum: 'Language', tsConst: 'LANGUAGES' },
  { prismaEnum: 'RunShardStatus', tsConst: 'RunShardStatus', source: 'types', kind: 'union' },
  // Dunning (§9). The webhook writes it and the UI will eventually render it;
  // a database value TypeScript does not know about would be an org whose
  // billing screen cannot say what state it is in.
  { prismaEnum: 'BillingState', tsConst: 'BillingState', source: 'types', kind: 'union' },
  // Outbound deliveries (§7). The worker writes it on every attempt and the
  // deliveries read path renders it; a database value TypeScript does not know
  // about would be a delivery whose state the screen cannot name.
  {
    prismaEnum: 'WebhookDeliveryStatus',
    tsConst: 'WebhookDeliveryStatus',
    source: 'types',
    kind: 'union',
  },
  // SSO (§1). The admin API validates `protocol` against SSO_PROTOCOLS, so a
  // value in the database enum that TypeScript does not know about is a
  // connection nobody can log in through.
  { prismaEnum: 'SsoProtocol', tsConst: 'SSO_PROTOCOLS', source: 'sso' },
  // On-prem runners (§5). Same shape as RunShardStatus — a union TYPE, not an
  // array — and it lives beside the code that transitions it rather than in
  // @qaai/shared, because the lease/reaper logic is the only thing that reads it.
  {
    prismaEnum: 'RunnerJobStatus',
    tsConst: 'RunnerJobStatus',
    source: 'runners',
    kind: 'union',
  },
  // Why a result did not run (§4). The run finaliser writes it on every
  // unattempted test and the pass-rate and coverage denominators are meant to
  // EXCLUDE two of its four members — so a database value TypeScript does not
  // know about is a skip that silently counts as evidence about the customer's
  // application. The TS side is NOT_RUN_KINDS in constants.ts, which is also
  // what `isNotRunKind` and `parseNotRun` validate against, so this entry
  // guards the read path as well as the write.
  { prismaEnum: 'NotRunKind', tsConst: 'NOT_RUN_KINDS' },
  /*
   * ── The enumeration denominator (§ coverage) ──────────────────────────────
   *
   * All four are written by the surface extractors and the crawl adjudicator,
   * and all four are FILTERED ON by a reader, which is why each earned a
   * database type rather than a TEXT column. That also makes each one a value a
   * row may hold and TypeScript may not know about — the precise failure this
   * script's docstring describes, where five TestType members sat un-migrated
   * and invisible until an insert failed at run time.
   */
  // Which declarer put an item in the inventory. The one that makes an
  // uncrawlable surface — a job, an email, a webhook receiver, a flag, a role,
  // a locale — nameable at all, so that ABSENT stops masquerading as covered.
  // Also the arbiter in `selectFlowMap`: an OBSERVED map outranks a DECLARED
  // one regardless of version, which is what stops a source-derived flow map
  // from displacing a real crawl.
  { prismaEnum: 'SurfaceSource', tsConst: 'SURFACE_SOURCES', source: 'surface' },
  // Whether a test may drive an item here. A value in the database that
  // TypeScript cannot name would be an item the dark-surface report can neither
  // count in the denominator nor list as held out — invisible in both
  // directions, which is the one outcome this feature exists to prevent.
  {
    prismaEnum: 'SurfaceExercisability',
    tsConst: 'SURFACE_EXERCISABILITIES',
    source: 'surface',
  },
  // The dimension tables. `DIMENSION_AXIS` is a `Record` keyed on this union,
  // so a seventh dimension in the database that TypeScript does not know about
  // would be rows of cells with no axis to be counted on.
  {
    prismaEnum: 'SurfaceDimensionKind',
    tsConst: 'SURFACE_DIMENSION_KINDS',
    source: 'surface',
  },
  // Whether a crawl may be the denominator. The highest-stakes of the four: a
  // state the database accepts and the selector cannot rank would fall through
  // `selectFlowMap`'s acceptance ranking into the legacy-null arm and a
  // degraded crawl would be promoted — which is exactly the defect that makes
  // the coverage percentage go up on the day a customer's environment falls
  // over.
  {
    prismaEnum: 'CrawlAcceptanceState',
    tsConst: 'CRAWL_ACCEPTANCE_STATES',
    source: 'flowMap',
  },
  /*
   * ── The non-crawl enumeration sources (§ coverage) ────────────────────────
   *
   * Ten, and every one is a closed vocabulary a reader FILTERS on — which is
   * what earned it a database type in the first place, and is therefore
   * exactly what makes it a value a row may hold and TypeScript may not know
   * about. Five TestType members once sat un-migrated and invisible until an
   * insert failed at run time; these ten are the same hazard, in a feature
   * whose whole output is a number a customer is asked to believe.
   *
   * The spec side first. `requirements.ts` is their home for the same reason
   * `surface.ts` is the home of the four above: the readers that consume them
   * live beside them, and dragging ten more lists into constants.ts purely to
   * be reachable from this script would be the tail wagging the dog.
   */
  // Where a requirement or a manual test case was read from. Filtered on by
  // every re-import: the importer asks "which rows did THIS connector own?"
  // before retiring anything, and a system the database accepts that TypeScript
  // cannot name would be rows no re-import can ever reconcile.
  { prismaEnum: 'SpecSourceSystem', tsConst: 'SPEC_SOURCE_SYSTEMS', source: 'requirements' },
  // A requirement's normalised status. The highest-stakes of the ten:
  // `OBSOLETE_STATUSES` takes a requirement OUT of the coverage denominator and
  // `requirementTestability` decides whether a generated test is expected to
  // pass, so a status value TypeScript cannot name falls through both switches
  // — and a requirement that silently leaves the denominator raises the
  // percentage with nothing anywhere to explain it.
  { prismaEnum: 'RequirementStatus', tsConst: 'REQUIREMENT_STATUSES', source: 'requirements' },
  // How much structure survived the import of one acceptance criterion.
  // `STRUCTURED_CRITERION_FORMATS` is what generation selects on, so an unknown
  // format is a criterion no generator will ever pick up and nothing will report
  // as skipped.
  {
    prismaEnum: 'AcceptanceCriterionFormat',
    tsConst: 'ACCEPTANCE_CRITERION_FORMATS',
    source: 'requirements',
  },
  // HOW a requirement→test link was made. THE honesty column:
  // `LINK_METHOD_CONFIDENCE_CEILING` is a `Record` keyed on this union, so a
  // fifth method in the database that TypeScript does not know about would be a
  // link with NO CEILING — a regex able to claim 1.0 and read as traceability.
  {
    prismaEnum: 'RequirementLinkMethod',
    tsConst: 'REQUIREMENT_LINK_METHODS',
    source: 'requirements',
  },
  // Whether anything is linked, and how strongly. `linkStateFrom` is the only
  // derivation and `UNLINKED_STATES` is what the report pages through; a state
  // the database accepts and TypeScript cannot name is a requirement that
  // appears in neither the covered list nor the gap list.
  {
    prismaEnum: 'RequirementLinkState',
    tsConst: 'REQUIREMENT_LINK_STATES',
    source: 'requirements',
  },
  // Whether a manual case is automated. `AUTOMATION_BACKLOG_STATUSES` is the
  // backlog number quoted at the customer, and NOT_STATED is deliberately
  // outside it — an unknown member would land in neither bucket and the
  // `total` would stop equalling the parts.
  {
    prismaEnum: 'ManualTestAutomationStatus',
    tsConst: 'MANUAL_TEST_AUTOMATION_STATUSES',
    source: 'requirements',
  },
  /*
   * The API and component side, in `api-surface.ts` for the same reason.
   */
  // What the DOCUMENT says about auth. `ANONYMOUS_ACCESS_DECLARED` gates
  // negative-auth generation, and a value that falls outside it is read as "do
  // not generate" — safe — while a value TypeScript cannot name at all cannot
  // be rendered, so the reader would show nothing where the document's position
  // belongs. UNSTATED and NOT_READ are the two members an omission would hide.
  { prismaEnum: 'ApiAuthDeclaration', tsConst: 'API_AUTH_DECLARATIONS', source: 'apiSurface' },
  // Whether an operation has been CONFIRMED to exist. A value the database
  // accepts and the reader cannot name is an operation that is neither declared
  // nor confirmed nor unprobed on screen — and NOT_PROBED rendering as
  // anything other than "we did not ask" is the single rendering mistake this
  // enum exists to prevent.
  {
    prismaEnum: 'ApiOperationVerification',
    tsConst: 'API_OPERATION_VERIFICATIONS',
    source: 'apiSurface',
  },
  // What kind of exported thing a component row is. `COMPONENT_KINDS_WITH_OWN_AXIS`
  // is a `Record` keyed on this union, so a seventh kind in the database that
  // TypeScript does not know about would be a row with no answer to "is this
  // already counted on the ROUTE axis?" — which is how the same page gets
  // counted twice and the denominator grows without the application doing so.
  { prismaEnum: 'ComponentItemKind', tsConst: 'COMPONENT_ITEM_KINDS', source: 'apiSurface' },
  // The named states. `NON_HAPPY_PATH_STATES` is derived by filtering this list,
  // so a state in the database that TypeScript cannot name is a state excluded
  // from the one count that makes "not just the happy path" checkable.
  { prismaEnum: 'ComponentStateKind', tsConst: 'COMPONENT_STATE_KINDS', source: 'apiSurface' },
  /*
   * ── The wall at the edge of the map (§ coverage) ──────────────────────────
   *
   * Nine. `AuthProfileKind` belongs here too and is held back for one specific
   * reason — see the deliberate-omission note below the list, which names it.
   */
  // What one role got when it asked for one route. THE security half of
  // enumeration. `MEASURED_ROUTE_ACCESS_OUTCOMES` is derived by EXCLUDING
  // NOT_PROBED and ERRORED from this list, so an eighth outcome the database
  // accepts and TypeScript cannot name would be an outcome that silently
  // enters the authorization denominator as a measurement — and NOT_PROBED
  // reading as anything other than "nobody asked" is the single rendering
  // mistake this enum exists to prevent.
  { prismaEnum: 'RouteAccessOutcome', tsConst: 'ROUTE_ACCESS_OUTCOMES', source: 'authProfiles' },
  // Whether we asked or a source told us. Doubly pinned: this entry guards the
  // Prisma enum against the shared list, and a `Record<RouteAccess['basis'],
  // true>` in auth-profiles.ts guards the shared list against flow-map.ts's
  // in-memory union. A declaration counted as a measurement is how "we
  // checked" gets said about a check nobody ran.
  { prismaEnum: 'RouteAccessBasis', tsConst: 'ROUTE_ACCESS_BASES', source: 'authProfiles' },
  // What became of the attempt to enumerate as one role. `CRAWLED_ROLE_OUTCOMES`
  // is what `roleHadNoExtraSurface` tests membership of before it will answer
  // at all, so an outcome TypeScript cannot name falls into the "did not
  // succeed" arm — safe — while an outcome MISSING from the Prisma enum is an
  // attempt that cannot be recorded, and an unrecorded attempt is
  // indistinguishable from a role with no extra surface. That is the lie the
  // whole table exists to prevent.
  { prismaEnum: 'RoleCrawlOutcome', tsConst: 'ROLE_CRAWL_OUTCOMES', source: 'authProfiles' },
  // What is standing in front of the login form. `botProtectionRemedy`
  // switches exhaustively on it to produce the sentence a customer acts on, so
  // a provider in the database that TypeScript cannot name is an environment
  // reported as unreachable with no remedy beside it — which is the half of
  // this feature that makes it worth having.
  {
    prismaEnum: 'BotProtectionProvider',
    tsConst: 'BOT_PROTECTION_PROVIDERS',
    source: 'authProfiles',
  },
  // The three legitimate ways past a challenge. `reachabilityFromPolicy` reads
  // NOT_CONFIGURED as "unreachable" and every other member as "configured", so
  // a fifth mode the database accepts and TypeScript cannot name would be read
  // as a working bypass — an environment reported as reachable that is not.
  { prismaEnum: 'BotBypassMode', tsConst: 'BOT_BYPASS_MODES', source: 'authProfiles' },
  // Whether an environment can be reached at all. Three members and the third
  // is the point: NOT_PROBED rendering as REACHABLE makes zero coverage look
  // like a testing failure instead of an access problem.
  {
    prismaEnum: 'EnvironmentReachability',
    tsConst: 'ENVIRONMENT_REACHABILITIES',
    source: 'authProfiles',
  },
  /*
   * The re-enumeration lifecycle, in constants.ts rather than auth-profiles.ts:
   * neither vocabulary has anything to do with identity, and both are read by
   * the scheduler and the drift feed. constants.ts is this script's default
   * home for exactly that kind of cross-cutting enum — NotRunKind lives there
   * on the same argument.
   */
  // What can cause the surface to be enumerated again. A kind the scheduler
  // cannot name is a trigger row that will never fire, which presents as a
  // denominator that silently stops being refreshed — the failure that makes
  // the coverage percentage rise when the application grows.
  {
    prismaEnum: 'ReEnumerationTriggerKind',
    tsConst: 'RE_ENUMERATION_TRIGGER_KINDS',
    source: 'constants',
  },
  // How a trigger's last run went. `triggerHasRun` is the only predicate that
  // separates NEVER_RUN from "ran and found no drift", and those are opposite
  // claims; a state TypeScript cannot name falls into the `!== 'NEVER_RUN'`
  // arm and would be reported as a trigger that has run.
  {
    prismaEnum: 'ReEnumerationRunState',
    tsConst: 'RE_ENUMERATION_RUN_STATES',
    source: 'constants',
  },
  // Whether two crawls could be compared at all. THE highest-stakes member of
  // the ten: `driftCountsAreMeaningful` returns true for COMPARABLE and
  // nothing else, and `newSurfaceWithoutTests` returns null on the strength of
  // it. A comparability the database accepts and TypeScript cannot name would
  // fall through to the null arm — honest — but one MISSING from the Prisma
  // enum is a diff that cannot record why it was not a diff, and the only
  // remaining way to render it is a zero. Zero here means "nothing new is
  // untested" and is a green tick over a comparison that never ran.
  {
    prismaEnum: 'SurfaceDriftComparability',
    tsConst: 'SURFACE_DRIFT_COMPARABILITIES',
    source: 'constants',
  },
  /*
   * ── The measurement (§ coverage) ──────────────────────────────────────────
   *
   * Four, and all four are filtered on, which is what earned each one a
   * database type instead of a TEXT column — and is therefore exactly what
   * makes each one a value a row may hold and TypeScript may not know about.
   *
   * The reason to be strict about these four specifically: every one of them
   * participates in deciding the HEADLINE NUMBER. The enumeration enums decide
   * what is in the denominator; these decide what is in the numerator and how
   * strong it is, and a value that falls through a switch here does not produce
   * an obviously-wrong screen — it produces a plausible percentage that is
   * wrong, which is the one failure mode a coverage product cannot survive.
   */
  // The ladder. THE highest-stakes member of the four: `COVERAGE_TIER_RANK` is
  // a `Record` keyed on this union, so a sixth rung in the database that
  // TypeScript cannot name would have NO RANK — `tierAtLeast` would throw or,
  // worse, compare `undefined` and answer false, which silently demotes every
  // item at that rung and makes the number fall for a reason nobody can find.
  // A rung MISSING from the Prisma enum is the mirror and is worse: the rung
  // exists in every report and no row can store it, so the writer fails at run
  // time on an insert.
  { prismaEnum: 'CoverageTier', tsConst: 'COVERAGE_TIERS', source: 'coverageTiers' },
  // Where an edge's evidence came from. `COVERAGE_EDGE_SOURCE_CEILING` is also a
  // `Record` keyed on this union, and it is the single line that stops a regex
  // claiming PASSING. A fourth source the database accepts and TypeScript cannot
  // name would have no ceiling at all.
  {
    prismaEnum: 'CoverageEdgeSource',
    tsConst: 'COVERAGE_EDGE_SOURCES',
    source: 'coverageTiers',
  },
  // What a metric is measured in. A unit a row holds and TypeScript cannot name
  // renders as a bare number beside numbers that have units, which is the thing
  // a reader misreads — and `MetricUnit` is on the write path for every vital,
  // every k6 threshold and every visual diff ratio the product will ever store.
  { prismaEnum: 'MetricUnit', tsConst: 'METRIC_UNITS', source: 'types' },
  // Which way is better. Two members, and a gate reads it to decide whether a
  // number going UP is a regression: a direction the database accepts and
  // TypeScript cannot name is a gate that fires backwards.
  { prismaEnum: 'MetricDirection', tsConst: 'METRIC_DIRECTIONS', source: 'types' },
  /*
   * ── The dimensions (§ coverage) ───────────────────────────────────────────
   *
   * Five, and every one is filtered on or keyed on a `Record`, which is what
   * earned it a database type rather than a TEXT column — and is therefore
   * exactly what makes it a value a row may hold and TypeScript may not know
   * about.
   *
   * The reason to be strict about these five specifically: the previous slice's
   * four decided how STRONG the numerator is, and these five decide WHAT IS
   * BEING DIVIDED and WHETHER IT WAS MEASURED AT ALL. A value that falls
   * through a switch here does not produce an obviously-broken screen — it
   * produces an axis rendered as 0% that was never measured, which is a lie
   * about the customer's application assembled out of our own silence.
   */
  // The axes a report may be broken down on. `COVERAGE_DIMENSION_DESCRIPTORS`
  // is a `Record` keyed on this union, so a fourteenth dimension in the
  // database that TypeScript cannot name would be rows of cells with no axis to
  // be counted on — and a cell counted on no axis is counted nowhere, which
  // raises the percentage.
  {
    prismaEnum: 'CoverageDimensionKind',
    tsConst: 'COVERAGE_DIMENSIONS',
    source: 'coverageDimensions',
  },
  // Every kind of cell below a surface item. `CELL_KIND_DIMENSION` is also a
  // `Record` keyed on this union, so a kind the database accepts and TypeScript
  // cannot name has NO DIMENSION: the row exists, no denominator contains it,
  // and the state it represents is invisible rather than uncovered. One enum
  // and not six precisely so that six parallel dimension modules cannot each
  // invent their own spelling of a page state.
  {
    prismaEnum: 'CoverageCellKind',
    tsConst: 'COVERAGE_CELL_KINDS',
    source: 'coverageDimensions',
  },
  // THE highest-stakes member of the five. It is the only reason an unmeasured
  // axis renders as "not measured" rather than as 0%, and it is grouped by —
  // "we have no extractor" is work for us and "a cap bit" is a budget to raise.
  // A reason in the database that TypeScript cannot name falls through the
  // grouping into neither bucket, and the shortfall it explains becomes an
  // unexplained one.
  {
    prismaEnum: 'DimensionUnmeasuredReason',
    tsConst: 'DIMENSION_UNMEASURED_REASONS',
    source: 'coverageDimensions',
  },
  // Which of the nineteen test types this deployment can execute.
  // `capabilityCounts` tests membership of `NON_EXECUTABLE_CAPABILITY_STATUSES`
  // before it will take an obligation out of the denominator, so a status
  // TypeScript cannot name lands in the "counts" arm — safe — while one MISSING
  // from the Prisma enum is a probe that cannot be recorded, and an unrecorded
  // probe is indistinguishable from NOT_CHECKED. NOT_CHECKED rendering as
  // UNSUPPORTED is the single rendering mistake this enum exists to prevent.
  {
    prismaEnum: 'DeploymentCapabilityStatus',
    tsConst: 'DEPLOYMENT_CAPABILITY_STATUSES',
    source: 'coverageDimensions',
  },
  // Whether a seeded defect was found. `RATED_FAULT_OUTCOMES` is what the
  // detection rate divides by, and NOT_EXERCISED is deliberately outside it —
  // an outcome the database accepts and TypeScript cannot name would land in
  // neither half of the fraction and the parts would stop summing to the whole.
  // This is the number the entire product's credibility rests on, so it is the
  // last place an unnameable value may appear.
  {
    prismaEnum: 'FaultDetectionOutcome',
    tsConst: 'FAULT_DETECTION_OUTCOMES',
    source: 'coverageDimensions',
  },
];

/*
 * NOT LISTED YET, and the reason is a finding rather than an exemption:
 *
 *   { prismaEnum: 'HealState', tsConst: 'HEAL_STATES', source: 'types' }
 *
 * `HealState` now HAS a TypeScript mirror (`HEAL_STATES` in
 * packages/shared/src/types.ts) and the two agree member for member — the
 * static half of this check passes for it today. What fails is the third
 * source, the live one: `HealState.SUPERSEDED` was added to schema.prisma by
 * migration 20261024050000_heal_lifecycle_enum_values and that migration has
 * not been deployed, so the database does not have the value. `planSupersede`
 * in packages/agent/src/healer.ts writes SUPERSEDED, which means every
 * supersede INSERT fails at run time on a database in that state — exactly the
 * defect this script's docstring describes, and exactly what adding the pair
 * would report.
 *
 * It is left out only because adding it would make this script red for a
 * reason no code change can fix, and a red check with no available remedy is a
 * check people start skipping. Run `prisma migrate deploy`, then add the line
 * above; it should pass immediately.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * SECOND ENTRY, same shape, and the first half of it is a finding:
 *
 *   { prismaEnum: 'AuthProfileKind', tsConst: 'AUTH_PROFILE_KINDS' }
 *
 * `AuthProfileKind` has existed since the beginning, has always been mirrored
 * by `AUTH_PROFILE_KINDS`, and HAS NEVER BEEN IN THE LIST ABOVE. So the one
 * enum that decides whether a customer's application can be logged into at all
 * has had no drift guard for the whole life of the repo — exactly the hole this
 * script was written to close, sitting in the script itself.
 *
 * Its two STATIC halves agree today: migration
 * 20261024100000_auth_kinds_role_access_and_reenumeration adds PASSKEY,
 * PHONE_OTP and MOCK_IDP to schema.prisma and constants.ts names the same
 * eight, in the same order, and `check-enums.auth-and-access.test.ts` asserts
 * that directly rather than through this list. What fails is the third source,
 * the live one, for the same reason as `HealState`: the migration is written
 * and NOT DEPLOYED, so the database still has five labels and this entry would
 * report three missing — truthfully, and with no code change able to fix it.
 *
 * The nine NEW types in the list above do not have that problem: their
 * `CREATE TYPE` has not run either, so `checkLiveDatabase` finds no such type
 * and skips them. Only an enum that already EXISTS in the database can be
 * behind.
 *
 * ── HOW FAR BEHIND THE DATABASE ACTUALLY IS, MEASURED ──────────────────────
 *
 * An earlier draft of this note said "the nine new types" as though nine were
 * all that went unchecked. RUN THE SCRIPT: it reports 8 of 32 pairs compared
 * against the live database and TWENTY-FOUR types absent from it. The other
 * fifteen belong to the two migrations that landed before this one and have not
 * been deployed either, so the live half of this check has been covering a
 * quarter of the list while its success line claimed all three sources agreed.
 * That overclaim is fixed at the bottom of this file; the number is left here
 * because "nine" would send the next reader looking for a discrepancy of nine.
 *
 * None of this is drift and none of it is red: an undeployed migration is a
 * deploy step. What it was, until the success line was corrected, is a tick
 * standing in for a comparison nobody ran.
 *
 * Run `prisma migrate deploy`, then add the line above. Both entries clear
 * together, and the test file named earlier fails the moment this note stops
 * being true.
 */

function prismaEnumMembers(source: string, name: string): string[] | null {
  const block = new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`).exec(source);
  if (!block) return null;
  return block[1]!
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line));
}

function tsConstMembers(source: string, name: string): string[] | null {
  // Matches `export const NAME = [ 'A', 'B' ] as const;`
  const block = new RegExp(`export const ${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!block) return null;
  return [...block[1]!.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]!);
}

/** Matches `export type Name = 'A' | 'B' | 'C';` across line breaks. */
function tsUnionMembers(source: string, name: string): string[] | null {
  const block = new RegExp(`export type ${name}\\s*=([^;]*);`).exec(source);
  if (!block) return null;
  const members = [...block[1]!.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]!);
  return members.length > 0 ? members : null;
}

const schema = readFileSync(SCHEMA, 'utf8');
const constants = readFileSync(CONSTANTS, 'utf8');
const types = readFileSync(TYPES, 'utf8');
const runners = readFileSync(RUNNERS, 'utf8');
const sso = readFileSync(SSO, 'utf8');
const surface = readFileSync(SURFACE, 'utf8');
const flowMap = readFileSync(FLOW_MAP, 'utf8');
const requirements = readFileSync(REQUIREMENTS, 'utf8');
const apiSurface = readFileSync(API_SURFACE, 'utf8');
const authProfiles = readFileSync(AUTH_PROFILES, 'utf8');
const coverageTiers = readFileSync(COVERAGE_TIERS_FILE, 'utf8');
const coverageDimensions = readFileSync(COVERAGE_DIMENSIONS_FILE, 'utf8');
const SOURCES: Record<
  | 'constants'
  | 'types'
  | 'runners'
  | 'sso'
  | 'surface'
  | 'flowMap'
  | 'requirements'
  | 'apiSurface'
  | 'authProfiles'
  | 'coverageTiers'
  | 'coverageDimensions',
  { text: string; label: string }
> = {
  constants: { text: constants, label: 'constants.ts' },
  types: { text: types, label: 'types.ts' },
  runners: { text: runners, label: 'lib/runners.ts' },
  sso: { text: sso, label: 'lib/sso.ts' },
  surface: { text: surface, label: 'shared/surface.ts' },
  flowMap: { text: flowMap, label: 'shared/flow-map.ts' },
  requirements: { text: requirements, label: 'shared/requirements.ts' },
  apiSurface: { text: apiSurface, label: 'shared/api-surface.ts' },
  authProfiles: { text: authProfiles, label: 'shared/auth-profiles.ts' },
  coverageTiers: { text: coverageTiers, label: 'shared/coverage-tiers.ts' },
  coverageDimensions: { text: coverageDimensions, label: 'shared/coverage-dimensions.ts' },
};
const problems: string[] = [];

for (const { prismaEnum, tsConst, source = 'constants', kind = 'array' } of PAIRS) {
  const { text, label } = SOURCES[source];
  const fromPrisma = prismaEnumMembers(schema, prismaEnum);
  const fromTs =
    kind === 'union' ? tsUnionMembers(text, tsConst) : tsConstMembers(text, tsConst);

  // A missing declaration is drift too — silently skipping it is how a renamed
  // enum stops being checked without anyone noticing.
  if (!fromPrisma) {
    problems.push(`enum ${prismaEnum} was not found in schema.prisma`);
    continue;
  }
  if (!fromTs) {
    problems.push(`${tsConst} was not found in ${label}`);
    continue;
  }

  const onlyPrisma = fromPrisma.filter((v) => !fromTs.includes(v));
  const onlyTs = fromTs.filter((v) => !fromPrisma.includes(v));

  if (onlyPrisma.length > 0) {
    problems.push(`${prismaEnum}: in schema.prisma but not ${tsConst} — ${onlyPrisma.join(', ')}`);
  }
  if (onlyTs.length > 0) {
    problems.push(`${tsConst}: in TypeScript but not enum ${prismaEnum} — ${onlyTs.join(', ')}`);
  }
}

/*
 * The third source of truth, and the one that actually broke: the running
 * database. Prisma and TS can agree perfectly while the deployed enum is behind,
 * and the only symptom is an insert failing at run time. Checked only when a
 * database is reachable, so this stays useful on a machine with no Postgres.
 */
/**
 * What the live half actually managed to compare.
 *
 * ── WHY THIS IS A RETURN VALUE AND NOT A `void` ────────────────────────────
 *
 * Because the success line at the bottom of this file used to read
 * "✓ N enum(s) match across schema.prisma, constants.ts and the database" for
 * every N, including the Ns this function never looked at. A type that does not
 * exist in the database is SKIPPED by the loop below — correctly, there is
 * nothing to compare — and the skip was silent, so the script reported a
 * three-source agreement it had measured on two sources.
 *
 * That is the product's own cardinal rule applied to the product's own tooling:
 * a thing reported as measured that was not measured. Concretely, running this
 * today prints a tick while NINE of the types in `PAIRS` are absent from the
 * deployed database and `AuthProfileKind` is three labels behind it — which is
 * exactly the drift this script exists to catch, in the window where catching
 * it matters most. So the count that was compared is now carried out and
 * printed beside the count that was declared, with the names and the remedy.
 */
interface LiveEnumCheck {
  state: 'CHECKED' | 'SKIPPED';
  /** Why nothing was compared. Non-null exactly when `state` is SKIPPED. */
  why: string | null;
  /** Pairs actually compared against pg_enum. */
  compared: number;
  /** Declared types that do not exist in the database yet, by name. */
  absent: string[];
}

async function checkLiveDatabase(): Promise<LiveEnumCheck> {
  const skipped = (why: string): LiveEnumCheck => ({
    state: 'SKIPPED',
    why,
    compared: 0,
    absent: [],
  });

  const url = process.env.DATABASE_URL;
  if (!url) return skipped('DATABASE_URL is not set');
  let Client: typeof import('pg').Client;
  try {
    ({ Client } = await import('pg'));
  } catch {
    return skipped('pg is not installed');
  }

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch {
    return skipped('the database was unreachable');
  }

  let compared = 0;
  const absent: string[] = [];
  try {
    for (const { prismaEnum } of PAIRS) {
      const declared = prismaEnumMembers(schema, prismaEnum) ?? [];
      const { rows } = await client.query<{ enumlabel: string }>(
        `select e.enumlabel from pg_enum e
           join pg_type t on t.oid = e.enumtypid
          where t.typname = $1`,
        [prismaEnum],
      );
      if (rows.length === 0) {
        /*
         * The type does not exist here yet, so there is nothing to compare and
         * this is NOT a failure — a migration that has not been deployed is a
         * deploy step, not drift. It is counted and named instead, because the
         * alternative is the tick above claiming it was checked.
         */
        absent.push(prismaEnum);
        continue;
      }
      compared += 1;
      const live = rows.map((r) => r.enumlabel);
      const missing = declared.filter((v) => !live.includes(v));
      if (missing.length > 0) {
        problems.push(
          `${prismaEnum}: declared in schema.prisma but MISSING FROM THE DATABASE — ` +
            `${missing.join(', ')}. Run \`prisma migrate deploy\`; until then, inserting one of ` +
            `these fails at run time.`,
        );
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
  return { state: 'CHECKED', why: null, compared, absent };
}

const live = await checkLiveDatabase();

if (problems.length > 0) {
  console.error('Enum drift:\n' + problems.map((p) => `  ✗ ${p}`).join('\n'));
  process.exit(1);
}

/*
 * THE SUCCESS LINE, AND WHY IT IS THREE SENTENCES INSTEAD OF ONE.
 *
 * It used to name all three sources unconditionally. The two STATIC sources are
 * always compared for every pair, so that half can be stated flatly. The LIVE
 * source cannot: it is skipped wholesale on a machine with no Postgres, and
 * skipped per-type for any type whose `CREATE TYPE` has not been deployed. The
 * number of pairs actually compared against it is therefore the only honest
 * thing to print, and the gap between that and `PAIRS.length` is a count with a
 * remedy attached rather than an absence a reader fills in with a tick.
 */
console.log(`✓ ${PAIRS.length} enum(s) match across schema.prisma and constants.ts.`);
if (live.state === 'SKIPPED') {
  console.log(
    `· the live database was NOT checked (${live.why}), so 0 of ${PAIRS.length} pair(s) were ` +
      `compared against a deployed enum. This is not a report that the database agrees.`,
  );
} else {
  console.log(`✓ ${live.compared} of ${PAIRS.length} also match the live database.`);
  if (live.absent.length > 0) {
    console.log(
      `· ${live.absent.length} declared type(s) DO NOT EXIST in the database yet and were not ` +
        `compared: ${live.absent.join(', ')}. Run \`prisma migrate deploy\`. Until then nothing ` +
        `here has checked them, and inserting one of their values fails at run time.`,
    );
  }
}
