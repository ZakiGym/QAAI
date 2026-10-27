/**
 * WHAT A TEST TYPE DECLARES IT NEEDS — the file nineteen types went without.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * Nineteen test types had working plugins and NOTHING ANYWHERE STATED WHAT EACH
 * ONE NEEDS. Four consequences, every one of them shipped:
 *
 *   1. THE FUNNEL WAS FIVE TYPES WIDE. The crawl path could propose E2E, SMOKE,
 *      API, ACCESSIBILITY and SECURITY_SMOKE; the deterministic path, two.
 *      Fourteen types were unreachable by any producer at all — not disabled,
 *      not gated, simply never emitted — and LOCALIZATION, MOBILE and
 *      CROSS_BROWSER were dead plugins nothing could route a test to.
 *   2. UNIT_GEN COULD NOT RUN. No producer emitted it, the prompt handed the
 *      model crawl locators instead of the function under test, and the
 *      external plugin never read `test.code` — so it ran a command pointing at
 *      a file that does not exist. INTEGRATION, UNIT_GEN and MUTATION executed
 *      against the WORKER'S OWN DIRECTORY, because nothing recorded that those
 *      three need the customer's repository materialised into the workspace.
 *      `buildRepoTree` existed and only the zip route used it.
 *   3. THE RUNNABILITY PREFLIGHT KNEW ABOUT BINARIES AND NOTHING ELSE.
 *      `TYPE_REQUIREMENTS` in packages/runner/src/preflight.ts answers "is k6 on
 *      this image" very well and cannot answer "does this type need a device",
 *      "does it need egress to a host the customer named", "does it WRITE to the
 *      customer's data", or "which principals does it need" — and the last two
 *      are the questions that decide whether a type is allowed to run at all.
 *   4. THE COVERAGE OBLIGATION MATRIX HAD NO IDEA WHAT EACH TYPE COVERS. So
 *      `DEFAULT_TYPE_OBLIGATIONS` in ./coverage-dimensions.ts is correctly
 *      empty-on-purpose, and there was no data anywhere to fill it from.
 *
 * ── WHAT THIS FILE IS AND IS NOT ────────────────────────────────────────────
 *
 * It is the DECLARATION. `packages/runner/src/preflight.ts` is the PROBER: it
 * spawns binaries, stats browser installs and caches the answers, and it must
 * stay in `runner` because this package is what the web app's bundler eats and a
 * `node:child_process` import here would 500 every page that reads a value from
 * @qaai/shared.
 *
 * So {@link TypeRequirement} mirrors preflight's `Requirement` union MEMBER FOR
 * MEMBER and structurally, which is deliberate: TypeScript's structural typing
 * makes {@link requirementsForType} output assignable to preflight's own type,
 * so `TYPE_REQUIREMENTS` can be DERIVED from this file rather than being a
 * second hand-written copy. Until that edit lands they are two lists, and the
 * run-time parity between them is asserted in ./test-type-decl.test.ts by name,
 * not by count — a count is satisfied by swapping one entry for another.
 *
 * ── THE PENDING TIER, AND WHY THE SEVEN NEW TYPES ARE IN IT ─────────────────
 *
 * `TEST_TYPES` is a Postgres enum, `createTestSchema`, the cockpit's filter
 * chips, a `Record` in two packages, and `check:wiring` FAILS a member with no
 * runner plugin — correctly, because "every test of this type is recorded
 * SKIPPED at run time" is a percentage with tests in it that cannot fail. The
 * registry already solved this from the other side: `PENDING_PLUGINS` in
 * packages/runner/src/registry.ts holds five complete plugins whose type is not
 * minted, and promotes each one the moment the vocabulary arrives.
 *
 * This file is the declaration-side twin of that arrangement.
 * {@link TEST_TYPE_DECLARATIONS} covers the nineteen MINTED types with a
 * compiler-exhaustive `Record`, and {@link PENDING_TEST_TYPE_DECLARATIONS}
 * covers the eight that have a declaration and no minted member yet. A pending
 * type is fully declarable, fully spec-validatable and NOT STORABLE, which is
 * the honest state of a type whose plugin is being written in parallel — and it
 * is one named edit from minted. See `PENDING_TEST_TYPES` in ./constants.ts for
 * the recipe.
 *
 * Pure data and closed unions. No zod — the write paths live in ./schemas.ts and
 * import from here, so there is one copy of every list.
 */

import { PENDING_TEST_TYPES, TEST_TYPES } from './constants';
import type { AnyTestType, PendingTestType, TestType } from './constants';
import { PRINCIPAL_KINDS } from './principals';
import type { PrincipalKind } from './principals';
import { SURFACE_KINDS } from './surface';
import type { SurfaceKind } from './surface';
import { BROWSER_ENGINES } from './browser-matrix';
import type { BrowserChannel, BrowserEngine, BrowserVersionRange } from './browser-matrix';

// ─── Who can emit a test of this type ────────────────────────────────────────

/**
 * WHICH PRODUCER CAN PUT A TEST OF THIS TYPE INTO A PLAN.
 *
 * This is the field that makes the funnel's width a FACT rather than a thing
 * somebody would have to go and read five producers to find out. `NONE` is a
 * real and currently common answer, and it is the whole point: fourteen types
 * had working plugins and no producer, and that was invisible because nothing
 * anywhere expressed "could a test of this type ever come to exist".
 *
 * `IMPORT` is kept apart from the three generators because it is not a gap of
 * ours: a type reachable only by importing a Postman collection or a Pact file
 * is reachable, by the customer, deliberately.
 */
export const TEST_TYPE_PRODUCERS = [
  /** The crawl path proposes it from what a browser reached. */
  'CRAWL',
  /** A deterministic, model-free rule proposes it from an enumerated surface. */
  'DETERMINISTIC',
  /** Source analysis proposes it from the customer's repository. */
  'SOURCE_ANALYSIS',
  /** Only an import brings it in — a collection, a pact, an existing suite. */
  'IMPORT',
  /**
   * Nothing emits it. Not disabled, not gated: no code path anywhere can put a
   * test of this type into a plan, so the plugin is dead weight.
   */
  'NONE',
] as const;
export type TestTypeProducer = (typeof TEST_TYPE_PRODUCERS)[number];

const TEST_TYPE_PRODUCER_PRESENT: Record<TestTypeProducer, true> = {
  CRAWL: true,
  DETERMINISTIC: true,
  SOURCE_ANALYSIS: true,
  IMPORT: true,
  NONE: true,
};

export const TEST_TYPE_PRODUCER_LIST = Object.keys(
  TEST_TYPE_PRODUCER_PRESENT,
) as ReadonlyArray<TestTypeProducer>;

// ─── What it needs from the machine and the network ──────────────────────────

/**
 * Does this type need the CUSTOMER'S REPOSITORY, and in what form?
 *
 * The distinction between the two non-NONE members is the whole of defect 2 in
 * this file's header. `READ_ONLY` is a type that reads source to decide what to
 * assert — it can work from a tree fetched into memory. `MATERIALISED` is a type
 * that EXECUTES INSIDE the checkout: it runs `npm test`, `pytest`, Stryker. With
 * nothing recording which was which, INTEGRATION, UNIT_GEN and MUTATION ran in
 * the worker's own directory — so the command resolved against QAAI's package
 * manifest, and "no tests found" was reported as a result about the customer's
 * application.
 */
export const REPOSITORY_NEEDS = [
  /** Never looks at the repository. */
  'NONE',
  /** Reads source; a fetched tree is enough. */
  'READ_ONLY',
  /**
   * EXECUTES inside the checkout. Must be materialised into the run workspace
   * with the project's own dependencies installed, or the command runs against
   * the wrong manifest and reports it as a result about the application.
   */
  'MATERIALISED',
] as const;
export type RepositoryNeed = (typeof REPOSITORY_NEEDS)[number];

const REPOSITORY_NEED_PRESENT: Record<RepositoryNeed, true> = {
  NONE: true,
  READ_ONLY: true,
  MATERIALISED: true,
};

export const REPOSITORY_NEED_LIST = Object.keys(
  REPOSITORY_NEED_PRESENT,
) as ReadonlyArray<RepositoryNeed>;

/**
 * WHERE THIS TYPE SENDS PACKETS, which is a security question before it is a
 * capability one.
 *
 * `CUSTOMER_NAMED_HOST` is the member with teeth. A type that connects to a host
 * out of a test's own spec must put it through `classifyHost` / `resolvesPublicly`
 * from ./private-address.ts BEFORE connecting, and refuse a private, loopback or
 * link-local target with a named reason in hosted mode. Declaring the need here
 * is what lets the gate check that the plugin does, instead of each plugin being
 * trusted to remember.
 *
 * `PROVIDER_TEST_MODE` is narrower than that and deliberately its own member:
 * the host is a payment or identity provider's SANDBOX, the values are published
 * test values from ./provider-catalogue.ts, and a type carrying this need must be
 * structurally incapable of driving a live-mode request.
 */
export const EGRESS_NEEDS = [
  /** Nothing leaves the machine. */
  'NONE',
  /** The environment's own base URL, and nothing else. */
  'APP_UNDER_TEST',
  /** A host the test's spec names. Must be classified before connecting. */
  'CUSTOMER_NAMED_HOST',
  /** A provider's sandbox, in test mode, with published test values only. */
  'PROVIDER_TEST_MODE',
] as const;
export type EgressNeed = (typeof EGRESS_NEEDS)[number];

const EGRESS_NEED_PRESENT: Record<EgressNeed, true> = {
  NONE: true,
  APP_UNDER_TEST: true,
  CUSTOMER_NAMED_HOST: true,
  PROVIDER_TEST_MODE: true,
};

export const EGRESS_NEED_LIST = Object.keys(EGRESS_NEED_PRESENT) as ReadonlyArray<EgressNeed>;

/**
 * Does this type need a DEVICE, and whose?
 *
 * `EMULATED` is a viewport and a user-agent string in a desktop browser, which
 * every image can do. `REAL_DEVICE` is somebody else's machine — a simulator, an
 * emulator or a farm — and there is no install that produces one. Reporting the
 * second as MISSING sends a reader to run `playwright install`; it is a purchase
 * or a local simulator, and that is a different sentence.
 */
export const DEVICE_NEEDS = ['NONE', 'EMULATED', 'REAL_DEVICE'] as const;
export type DeviceNeed = (typeof DEVICE_NEEDS)[number];

const DEVICE_NEED_PRESENT: Record<DeviceNeed, true> = {
  NONE: true,
  EMULATED: true,
  REAL_DEVICE: true,
};

export const DEVICE_NEED_LIST = Object.keys(DEVICE_NEED_PRESENT) as ReadonlyArray<DeviceNeed>;

/**
 * DOES THIS TYPE CHANGE THE CUSTOMER'S DATA?
 *
 * The highest-stakes field in this file, and the reason it is three members and
 * not a boolean. `READS_ONLY` and `WRITES` are the obvious pair; `DESTROYS` is
 * the one a boolean collapses, and it is the one that matters: a type that signs
 * out, expires a session, locks an account or deletes a row cannot be pointed at
 * a PERSISTENT principal without costing the customer the only way in. That is
 * the whole argument `PRINCIPAL_KINDS` in ./principals.ts records, and
 * `proveDisposable` is the refusal — but nothing connected the refusal to the
 * TYPE, so every type was treated as safe by default.
 *
 * The rule the schema enforces: anything above READS_ONLY must declare at least
 * one principal kind, and DESTROYS must declare DISPOSABLE.
 */
export const DATA_EFFECTS = ['READS_ONLY', 'WRITES', 'DESTROYS'] as const;
export type DataEffect = (typeof DATA_EFFECTS)[number];

const DATA_EFFECT_PRESENT: Record<DataEffect, true> = {
  READS_ONLY: true,
  WRITES: true,
  DESTROYS: true,
};

export const DATA_EFFECT_LIST = Object.keys(DATA_EFFECT_PRESENT) as ReadonlyArray<DataEffect>;

/** Effects that may not be aimed at an identity the customer cannot lose. */
export const MUTATING_DATA_EFFECTS: readonly DataEffect[] = ['WRITES', 'DESTROYS'];

// ─── What a result did NOT assert ────────────────────────────────────────────

/**
 * WHY A TYPE'S RESULT DOES NOT CARRY THE ASSERTION IT IS SUPPOSED TO.
 *
 * ── The defect, which is the headline one of this round ─────────────────────
 *
 * CHECKOUT COULD BE CLICKED THROUGH AND THE MONEY PATH COULD NOT BE ASSERTED.
 * No 3DS, no decline, no insufficient funds, no webhook transition, no refund,
 * no partial capture — and the result of clicking through it was a PASS. The
 * same shape runs through every new type in this round: a PWA test that could
 * not reach a service worker, a PUSH test with no APNs/FCM transport, a DOCUMENT
 * test that downloaded a PDF and asserted nothing about its bytes. Every one of
 * them would have been a green row.
 *
 * So a plugin that could not make an assertion RECORDS WHICH ONE AND WHY, as a
 * value, in `TestResultVariant.notAsserted` and `notAssertedReason`. A pass with
 * a non-empty `notAsserted` is a pass with a stated hole in it, and the gate can
 * refuse to count it. A pass with nothing recorded is the lie.
 *
 * A Prisma enum with a `check:enums` pair, because the one question that makes
 * this useful is "how often, across this project, did we fail to assert the
 * webhook transition" — which is a `GROUP BY` and not a regex over a sentence.
 * That is the same argument the migration moving the mutation score out of a
 * Step TITLE makes at length.
 */
export const UNASSERTED_REASONS = [
  /** The transport, binary, device or engine the assertion needs is absent here. */
  'CAPABILITY_ABSENT',
  /**
   * The provider is in test mode and does not produce this outcome, or produces
   * it only through a path this plugin refuses. Not our gap and not a defect.
   */
  'PROVIDER_TEST_MODE_LIMIT',
  /** A bot defence stands in front of it and no documented test key is configured. */
  'UNREACHABLE_BEHIND_BOT_PROTECTION',
  /** The customer has not supplied the sandbox credential the assertion needs. */
  'REQUIRES_PROVISIONED_SANDBOX',
  /** Asserting it would have written or destroyed data this run may not touch. */
  'WOULD_MUTATE_PROTECTED_DATA',
  /** A budget, take or timeout bit before the assertion was reached. */
  'CAP_BIT',
  /** The surface the assertion needed was never reached. */
  'SURFACE_UNREACHED',
  /**
   * Nobody has built it. The weakest member and the only honest reading of an
   * assertion this product does not yet make — and deliberately distinct from
   * CAPABILITY_ABSENT, because one is work for us and the other is an install.
   */
  'NOT_IMPLEMENTED',
] as const;
export type UnassertedReason = (typeof UNASSERTED_REASONS)[number];

const UNASSERTED_REASON_PRESENT: Record<UnassertedReason, true> = {
  CAPABILITY_ABSENT: true,
  PROVIDER_TEST_MODE_LIMIT: true,
  UNREACHABLE_BEHIND_BOT_PROTECTION: true,
  REQUIRES_PROVISIONED_SANDBOX: true,
  WOULD_MUTATE_PROTECTED_DATA: true,
  CAP_BIT: true,
  SURFACE_UNREACHED: true,
  NOT_IMPLEMENTED: true,
};

export const UNASSERTED_REASON_LIST = Object.keys(
  UNASSERTED_REASON_PRESENT,
) as ReadonlyArray<UnassertedReason>;

export const UNASSERTED_REASON_LABELS: Record<UnassertedReason, string> = {
  CAPABILITY_ABSENT: 'the transport, binary, device or engine it needs is not here',
  PROVIDER_TEST_MODE_LIMIT: "the provider's test mode does not produce this outcome",
  UNREACHABLE_BEHIND_BOT_PROTECTION: 'a bot defence stands in front of it, with no test key set',
  REQUIRES_PROVISIONED_SANDBOX: 'the customer has not supplied the sandbox credential',
  WOULD_MUTATE_PROTECTED_DATA: 'asserting it would have changed data this run may not touch',
  CAP_BIT: 'a budget, take or timeout bit first',
  SURFACE_UNREACHED: 'the surface it needed was never reached',
  NOT_IMPLEMENTED: 'nobody has built this assertion yet',
};

/**
 * Reasons that are OUR gap rather than the environment's.
 *
 * Exported because the two halves go to different people: NOT_IMPLEMENTED is a
 * roadmap item and CAPABILITY_ABSENT is a Dockerfile line, and a report that
 * merged them would send a customer to install something that does not exist.
 */
export const OUR_UNASSERTED_REASONS: readonly UnassertedReason[] = [
  'NOT_IMPLEMENTED',
  'SURFACE_UNREACHED',
  'CAP_BIT',
];

// ─── A requirement ───────────────────────────────────────────────────────────

/**
 * One thing a type needs, and WHO decides whether this particular test needs it.
 *
 * Mirrors `Requirement` in packages/runner/src/preflight.ts member for member
 * and field for field, on purpose — see this file's header. The `scope`
 * semantics are that file's and are repeated here because this is the half a
 * reader meets first:
 *
 *   scope 'TYPE' — every test of this type needs it. Missing means the type
 *                  cannot execute here, and a run may refuse its tests up front.
 *   scope 'SPEC' — only some tests need it, and which ones is in their spec.
 *                  Missing is REPORTED and never blocks: refusing every MOBILE
 *                  test because `maestro` is absent would refuse the Appium
 *                  tests that have no use for it.
 *
 * `install` is not decoration. A refusal that does not say what to install is a
 * wall.
 */
export type TypeRequirement =
  | {
      kind: 'BINARY';
      scope: 'TYPE' | 'SPEC';
      name: string;
      install: string;
      why?: string;
      /**
       * The window this type needs, when one has been ESTABLISHED.
       *
       * Absent on every entry below, and that is a deliberate empty default
       * rather than an oversight — the same judgement, for the same reason, as
       * `TYPE_REQUIREMENTS` in preflight.ts and `DEFAULT_TYPE_OBLIGATIONS` in
       * ./coverage-dimensions.ts. No minimum version for k6, Lighthouse,
       * grpcurl or any mobile driver has ever been established in this
       * repository; writing a plausible floor here reads as measurement, would
       * fire on a customer's working binary, and would produce a row that is a
       * number this product invented about a tool it never tested.
       */
      version?: BrowserVersionRange;
    }
  | { kind: 'BROWSER'; scope: 'TYPE' | 'SPEC'; name: BrowserEngine; install: string; why?: string }
  | {
      kind: 'CHANNEL';
      scope: 'TYPE' | 'SPEC';
      channel: BrowserChannel;
      install: string;
      why?: string;
    }
  | { kind: 'PLATFORM'; scope: 'TYPE' | 'SPEC'; platform: string; why: string }
  /** Something only the test's own spec names, or only the tenant's network can reach. */
  | { kind: 'UNPROBED'; scope: 'SPEC'; what: string; why: string };

// ─── The declaration ────────────────────────────────────────────────────────

/**
 * Everything one test type declares about itself.
 *
 * Read by four consumers that cannot see each other's source, which is the
 * reason this is one record and not four: the runnability preflight, the funnel
 * (which producer may emit it), the coverage obligation matrix (which surface
 * kinds it can cover) and the gate (whether a result of this type may be
 * counted). Four hand-maintained answers to "what does MOBILE need" is how three
 * of them come to disagree.
 */
export interface TestTypeDeclaration {
  /** The type, as a string — minted or pending. */
  readonly type: AnyTestType;
  /** One line, for a refusal a human has to act on. */
  readonly summary: string;
  /** Binaries, browsers, channels, platforms and the honestly unprobeable. */
  readonly requirements: readonly TypeRequirement[];
  /** Engines a test of this type drives. Empty = it does not drive a browser. */
  readonly engines: readonly BrowserEngine[];
  readonly repository: RepositoryNeed;
  readonly device: DeviceNeed;
  readonly egress: EgressNeed;
  readonly dataEffect: DataEffect;
  /**
   * Principal kinds a test of this type needs. EMPTY is legitimate and means
   * "no identity at all" — an anonymous HTTP probe, a CLI invocation. The schema
   * refuses an empty list beside a mutating `dataEffect`.
   */
  readonly principalKinds: readonly PrincipalKind[];
  /** Surface kinds a test of this type can produce coverage for. */
  readonly coversSurfaceKinds: readonly SurfaceKind[];
  /** Which producers can emit this type today. `['NONE']` is the honest answer for many. */
  readonly producers: readonly TestTypeProducer[];
  /**
   * Assertions this type is NOT yet able to make, with each one's reason.
   *
   * The declaration-time half of {@link UNASSERTED_REASONS}. Present so a plan
   * can say what a test of this type will and will not prove BEFORE it is run,
   * rather than a reader discovering it from a green row. Empty means the type
   * makes every assertion it claims — a strong statement, and the reason this
   * is a list rather than a boolean.
   */
  readonly knownUnasserted: ReadonlyArray<{
    readonly assertion: string;
    readonly reason: UnassertedReason;
  }>;
  /**
   * Must this type REFUSE a live-mode credential structurally?
   *
   * True only for the types that touch a payment or identity provider. It is a
   * declaration that the plugin's refusal is type-level and run-time, not a
   * convention — the gate checks the declaration, the plugin's own tests check
   * the refusal.
   */
  readonly refusesLiveCredentials: boolean;
}

const PLAYWRIGHT_INSTALL = 'npx playwright install';
const CHROMIUM: TypeRequirement = {
  kind: 'BROWSER',
  scope: 'TYPE',
  name: 'chromium',
  install: PLAYWRIGHT_INSTALL,
};

/**
 * THE NINETEEN MINTED TYPES.
 *
 * A `Record<TestType, …>` so the compiler refuses a twentieth minted member with
 * no declaration — which would otherwise be a type the preflight cannot describe
 * and the funnel cannot route to, discovered by a customer.
 *
 * ── `producers` IS WHERE THE FOURTEEN LIVE ──────────────────────────────────
 *
 * Fourteen of these nineteen carry `['NONE']`, and that is not an admission
 * buried in a comment: it is a value, in a field, that a report can count. The
 * three the round names explicitly — LOCALIZATION, MOBILE and CROSS_BROWSER —
 * are dead plugins by this reading, and {@link typesWithNoProducer} is the one
 * function that answers "how wide is the funnel actually".
 *
 * Nothing here is corrected by wishful thinking. A type gets a producer in this
 * table when a producer emits it, and not before.
 */
export const TEST_TYPE_DECLARATIONS: Readonly<Record<TestType, TestTypeDeclaration>> = {
  E2E: {
    type: 'E2E',
    summary: 'A user journey through the UI, asserted at each step.',
    requirements: [{ ...CHROMIUM, why: "QAAI's own Playwright harness drives Chromium" }],
    engines: ['chromium'],
    repository: 'NONE',
    device: 'EMULATED',
    egress: 'APP_UNDER_TEST',
    dataEffect: 'WRITES',
    principalKinds: ['PERSISTENT', 'ANONYMOUS'],
    coversSurfaceKinds: ['ROUTE', 'FORM', 'AUTH_SURFACE', 'ERROR_STATE', 'ROLE_CELL'],
    producers: ['CRAWL', 'DETERMINISTIC', 'IMPORT'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
  SMOKE: {
    type: 'SMOKE',
    summary: 'The shortest path that proves the application is up and signed-in.',
    requirements: [CHROMIUM],
    engines: ['chromium'],
    repository: 'NONE',
    device: 'EMULATED',
    egress: 'APP_UNDER_TEST',
    dataEffect: 'READS_ONLY',
    principalKinds: ['PERSISTENT', 'ANONYMOUS'],
    coversSurfaceKinds: ['ROUTE', 'AUTH_SURFACE'],
    producers: ['CRAWL', 'DETERMINISTIC'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
  INTEGRATION: {
    type: 'INTEGRATION',
    summary: "The customer's own test command, run inside their checkout.",
    requirements: [
      {
        kind: 'UNPROBED',
        scope: 'SPEC',
        what: 'the command the test declares, inside the project checkout',
        why: "it is the customer's own runner — Vitest, Jest, pytest, go test — so this image cannot know its name in advance",
      },
    ],
    engines: [],
    /*
     * MATERIALISED, and this single value is defect 2 in this file's header.
     * Without it the command resolved against the WORKER'S OWN manifest, so
     * "no tests found" was reported as a result about the customer's
     * application. `buildRepoTree` already existed; only the zip route used it.
     */
    repository: 'MATERIALISED',
    device: 'NONE',
    egress: 'CUSTOMER_NAMED_HOST',
    dataEffect: 'WRITES',
    principalKinds: [],
    coversSurfaceKinds: ['ENDPOINT', 'BACKGROUND_JOB'],
    producers: ['DETERMINISTIC'],
    knownUnasserted: [
      /*
       * The same hole UNIT_GEN declares, and for the same reason: both types
       * are served by packages/runner/src/plugins/external.ts, and nothing in
       * that file reads a TEST COUNT. A customer's suite whose pattern matches
       * no file exits 0 and the result is a PASS for a run that executed
       * nothing. It is declared on both types rather than once, because a
       * reader asking "what does INTEGRATION prove" must not have to know
       * which plugin backs it.
       */
      {
        assertion:
          "that the project's own command actually EXECUTED a test — nothing reads a test count, so a suite that matched no file exits 0 and reports PASS",
        reason: 'NOT_IMPLEMENTED',
      },
    ],
    refusesLiveCredentials: false,
  },
  API: {
    type: 'API',
    summary: 'An HTTP request chain with status, latency and body assertions.',
    requirements: [],
    engines: [],
    repository: 'NONE',
    device: 'NONE',
    egress: 'APP_UNDER_TEST',
    dataEffect: 'WRITES',
    principalKinds: ['PERSISTENT', 'ANONYMOUS'],
    coversSurfaceKinds: ['ENDPOINT', 'ERROR_STATE'],
    producers: ['CRAWL', 'DETERMINISTIC', 'SOURCE_ANALYSIS', 'IMPORT'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
  VISUAL: {
    type: 'VISUAL',
    summary: 'A screenshot compared against an approved, environment-scoped baseline.',
    requirements: [{ ...CHROMIUM, why: 'a screenshot needs a browser to take it' }],
    engines: ['chromium'],
    repository: 'NONE',
    device: 'EMULATED',
    egress: 'APP_UNDER_TEST',
    dataEffect: 'READS_ONLY',
    principalKinds: ['PERSISTENT', 'ANONYMOUS'],
    coversSurfaceKinds: ['ROUTE', 'COMPONENT_STATE', 'DEVICE_LOCALE', 'ERROR_STATE'],
    producers: ['DETERMINISTIC'],
    knownUnasserted: [
      /*
       * THE DECLARATION SAID THIS TYPE ASSERTS EVERYTHING IT CLAIMS, AND THE
       * PLUGIN IS ONE PATH AT ONE VIEWPORT.
       *
       * `visualTestSpecSchema` now carries `matrix`, `states` and
       * `environment`, and `runVisualMatrix` / `planVisualCaptures` /
       * `recordCapture` in packages/runner/src/matrix.ts implement all three.
       * An empty `knownUnasserted` beside that is the worst available
       * combination — a stored 12-cell matrix would be accepted, one cell would
       * be captured, and the row would be green.
       *
       * REWORDED, because the half of it that named CAUSES went out of date the
       * moment the plugin was wired. `plugins/visual.ts` now DOES call
       * `planVisualCaptures` and `recordCapture`, and its baseline key comes
       * from `baselineViewportKey`/`variantBrowserKey` rather than a hard-coded
       * `'chromium'`. The HOLE is unchanged and is now stated as a hole rather
       * than as a list of uncalled functions: one captured pair, because
       * `RunContext.visualBaseline` holds ONE image and
       * `TestExecution.newBaseline` is ONE row, so there is nowhere a second
       * cell's reference could be fetched from or approved into.
       *
       * A `knownUnasserted` entry whose stated cause is false is worse than a
       * vague one: a reader checks the cause, finds it wrong, and discounts the
       * entry — which is how a real hole gets closed on paper.
       */
      {
        assertion:
          'any cell of a declared matrix other than the floor cell in DEFAULT — plugins/visual.ts captures ONE (cell, state) pair, because RunContext.visualBaseline holds one image and TestExecution.newBaseline is one row; every other declared pair is reported with its reason rather than captured',
        reason: 'NOT_IMPLEMENTED',
      },
      {
        assertion:
          'a named INTERACTION STATE (hover, focus, open, loading, error) — nothing reaches a state before capturing, so a capture labelled HOVER is of the default rendering',
        reason: 'NOT_IMPLEMENTED',
      },
    ],
    refusesLiveCredentials: false,
  },
  ACCESSIBILITY: {
    type: 'ACCESSIBILITY',
    summary: 'An axe scan plus the keyboard and focus checks axe cannot make.',
    requirements: [CHROMIUM],
    engines: ['chromium'],
    repository: 'NONE',
    device: 'EMULATED',
    egress: 'APP_UNDER_TEST',
    dataEffect: 'READS_ONLY',
    principalKinds: ['PERSISTENT', 'ANONYMOUS'],
    coversSurfaceKinds: ['ROUTE', 'FORM', 'COMPONENT_STATE'],
    producers: ['CRAWL', 'DETERMINISTIC'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
  LOAD: {
    type: 'LOAD',
    summary: 'What the server survives, measured by k6 against declared thresholds.',
    requirements: [
      {
        kind: 'BINARY',
        scope: 'TYPE',
        name: 'k6',
        install: 'brew install k6 (or https://k6.io/docs/get-started/installation/)',
        why: 'plugins/load.ts shells out to the real k6 binary rather than reimplementing a load generator',
      },
    ],
    engines: [],
    repository: 'NONE',
    device: 'NONE',
    egress: 'APP_UNDER_TEST',
    dataEffect: 'WRITES',
    principalKinds: ['ANONYMOUS'],
    coversSurfaceKinds: ['ENDPOINT'],
    producers: ['DETERMINISTIC'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
  SECURITY_SMOKE: {
    type: 'SECURITY_SMOKE',
    summary: 'Auth-required paths, IDOR probes and response-header inspection.',
    requirements: [],
    engines: [],
    repository: 'NONE',
    device: 'NONE',
    egress: 'APP_UNDER_TEST',
    dataEffect: 'READS_ONLY',
    principalKinds: ['ANONYMOUS', 'PERSISTENT'],
    coversSurfaceKinds: ['ENDPOINT', 'ROUTE', 'ROLE_CELL'],
    producers: ['CRAWL', 'DETERMINISTIC'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
  UNIT_GEN: {
    type: 'UNIT_GEN',
    summary: "A unit or component test over a function in the customer's source.",
    requirements: [
      {
        kind: 'UNPROBED',
        scope: 'SPEC',
        what: 'the command the test declares, inside the project checkout',
        why: 'same external-command route as INTEGRATION',
      },
    ],
    engines: [],
    repository: 'MATERIALISED',
    device: 'NONE',
    egress: 'NONE',
    dataEffect: 'READS_ONLY',
    principalKinds: [],
    coversSurfaceKinds: ['DATA_VARIANT', 'ERROR_STATE'],
    /*
     * NONE, and this is the type whose emptiness costs the most. Pricing,
     * validation and permission logic — the LOGIC HALF of every application —
     * is unreachable: no producer emits a UNIT_GEN item, the prompt hands the
     * model crawl locators instead of the function under test, and the external
     * plugin never reads `test.code`, so it runs a command pointing at a file
     * that does not exist. Three separate breaks in one path.
     */
    producers: ['DETERMINISTIC', 'SOURCE_ANALYSIS'],
    knownUnasserted: [
      /*
       * THE HOLE THAT WAS DECLARED HERE IS CLOSED, AND THIS ONE REPLACES IT.
       *
       * It read "the generated file exists on disk before the command runs",
       * which was true when it was written and is not any more:
       * `writeGeneratedTest` in packages/runner/src/plugins/external.ts is
       * called before `runExternal` (external.ts:154) and a run with no
       * materialised checkout is `notEvaluated`, not a pass. Leaving the stale
       * entry would be a declaration contradicting the code under it, and in
       * the expensive direction — it would keep a closed gap on the roadmap.
       *
       * What IS still unasserted is the other end of the same command, and it
       * is the "pass that means we did not check" in its purest form: nothing
       * in external.ts reads a TEST COUNT. A unit runner whose pattern matches
       * no test file exits 0, the plugin sees exit 0, and the result is a PASS
       * for a run that executed nothing. Grep for NO_TESTS_FOUND in that file:
       * there is no such branch.
       */
      {
        assertion:
          'that the unit runner actually EXECUTED a test — a runner whose pattern matches no file exits 0 and nothing reads a test count, so an empty run reports PASS',
        reason: 'NOT_IMPLEMENTED',
      },
    ],
    refusesLiveCredentials: false,
  },
  CROSS_BROWSER: {
    type: 'CROSS_BROWSER',
    summary: 'One spec run across a declared engine, channel, version and device matrix.',
    requirements: [
      /*
       * Chromium is TYPE-scoped because `browserProjects` in plugins/matrix.ts
       * always includes it ("a matrix without the default browser hides
       * regressions"). The other two are SPEC-scoped: which engines a given
       * test wants is in its own spec, so a missing WebKit is reported against
       * the deployment and never refuses a chromium+firefox matrix.
       */
      CHROMIUM,
      { kind: 'BROWSER', scope: 'SPEC', name: 'firefox', install: PLAYWRIGHT_INSTALL },
      { kind: 'BROWSER', scope: 'SPEC', name: 'webkit', install: PLAYWRIGHT_INSTALL },
      {
        kind: 'CHANNEL',
        scope: 'SPEC',
        channel: 'CHROME',
        install: 'npx playwright install chrome',
        why: 'a cell naming Chrome stable needs the real Chrome, not Playwright’s chromium build',
      },
      {
        kind: 'CHANNEL',
        scope: 'SPEC',
        channel: 'MSEDGE',
        install: 'npx playwright install msedge',
        why: 'Edge is the second-most-named browser in a cross-browser request and had no way to be asked for',
      },
    ],
    engines: [...BROWSER_ENGINES],
    repository: 'NONE',
    device: 'EMULATED',
    egress: 'APP_UNDER_TEST',
    dataEffect: 'WRITES',
    principalKinds: ['PERSISTENT', 'ANONYMOUS'],
    coversSurfaceKinds: ['ROUTE', 'DEVICE_LOCALE', 'COMPONENT_STATE'],
    /** A dead plugin: nothing has ever emitted a CROSS_BROWSER item. */
    producers: ['DETERMINISTIC'],
    knownUnasserted: [
      {
        assertion: 'a named Safari or Firefox release, as opposed to the bundled build',
        reason: 'CAPABILITY_ABSENT',
      },
    ],
    refusesLiveCredentials: false,
  },
  LOCALIZATION: {
    type: 'LOCALIZATION',
    summary: 'The same spec re-run under another locale and timezone.',
    requirements: [CHROMIUM],
    engines: ['chromium'],
    repository: 'NONE',
    device: 'EMULATED',
    egress: 'APP_UNDER_TEST',
    dataEffect: 'READS_ONLY',
    principalKinds: ['PERSISTENT', 'ANONYMOUS'],
    coversSurfaceKinds: ['DEVICE_LOCALE', 'ROUTE'],
    /** A dead plugin: nothing has ever emitted a LOCALIZATION item. */
    producers: ['DETERMINISTIC'],
    /*
     * The honest statement of what this type does. It RE-RUNS the same code
     * under another locale and emits ZERO findings, so no l10n defect class is
     * detectable by it: not RTL mirroring, not pseudo-localization, not
     * truncation, not a missing key. The `Finding` kind is dead. The deep
     * version is the pending I18N_DEEP type below, and this entry says so
     * rather than letting a green de-DE run read as localisation coverage.
     */
    knownUnasserted: [
      { assertion: 'RTL mirroring of the layout', reason: 'NOT_IMPLEMENTED' },
      { assertion: 'string truncation and overflow under a longer language', reason: 'NOT_IMPLEMENTED' },
      { assertion: 'a missing translation key, as opposed to a key echoed as its own value', reason: 'NOT_IMPLEMENTED' },
      { assertion: 'pseudo-localization round-trip', reason: 'NOT_IMPLEMENTED' },
    ],
    refusesLiveCredentials: false,
  },
  EMAIL_OTP: {
    type: 'EMAIL_OTP',
    summary: 'A real email-code sign-in, read back out of a test mail sink.',
    requirements: [
      CHROMIUM,
      {
        kind: 'UNPROBED',
        scope: 'SPEC',
        what: 'a mail catcher the test can read the message out of',
        why: "it is named by the test and lives on the tenant's network, so probing it from here would be probing the wrong host",
      },
    ],
    engines: ['chromium'],
    repository: 'NONE',
    device: 'EMULATED',
    egress: 'CUSTOMER_NAMED_HOST',
    dataEffect: 'WRITES',
    principalKinds: ['DISPOSABLE'],
    coversSurfaceKinds: ['AUTH_SURFACE', 'NOTIFICATION'],
    producers: ['DETERMINISTIC'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
  DATABASE: {
    type: 'DATABASE',
    summary: 'A query, a migration or a constraint, asserted against the schema itself.',
    requirements: [
      {
        kind: 'UNPROBED',
        scope: 'SPEC',
        what: "a database the environment's secrets can reach",
        why: 'connecting from here would open a tenant database on a preflight, which is both a side effect and a credential use nobody asked for',
      },
    ],
    engines: [],
    repository: 'NONE',
    device: 'NONE',
    egress: 'CUSTOMER_NAMED_HOST',
    dataEffect: 'WRITES',
    principalKinds: [],
    coversSurfaceKinds: ['DATA_VARIANT'],
    producers: ['DETERMINISTIC'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
  CLI: {
    type: 'CLI',
    summary: 'A command, its exit code, its streams and the files it left behind.',
    requirements: [
      {
        kind: 'UNPROBED',
        scope: 'SPEC',
        what: 'the command under test',
        why: 'the command IS the subject of a CLI test, so it is named by the spec and resolved at execution',
      },
    ],
    engines: [],
    repository: 'MATERIALISED',
    device: 'NONE',
    egress: 'NONE',
    dataEffect: 'WRITES',
    principalKinds: [],
    coversSurfaceKinds: ['DATA_VARIANT', 'ERROR_STATE'],
    producers: ['DETERMINISTIC'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
  PROTOCOL: {
    type: 'PROTOCOL',
    summary: 'gRPC, WebSocket and SSE: the endpoints an HTTP test cannot reach.',
    requirements: [
      {
        kind: 'BINARY',
        scope: 'SPEC',
        name: 'grpcurl',
        install: 'brew install grpcurl',
        why: 'only the gRPC specs shell out to it; a WebSocket or SSE test needs nothing but a socket',
      },
    ],
    engines: [],
    repository: 'NONE',
    device: 'NONE',
    egress: 'CUSTOMER_NAMED_HOST',
    dataEffect: 'WRITES',
    principalKinds: ['PERSISTENT', 'ANONYMOUS'],
    coversSurfaceKinds: ['ENDPOINT'],
    producers: ['IMPORT', 'DETERMINISTIC'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
  CONTRACT: {
    type: 'CONTRACT',
    summary: 'A pact or an OpenAPI document, verified against the running provider.',
    requirements: [
      {
        kind: 'UNPROBED',
        scope: 'SPEC',
        what: 'a pact file in the checkout, or a reachable Pact broker',
        why: 'the spec chooses between a committed document and a broker URL, and only one of those is a local fact',
      },
    ],
    engines: [],
    repository: 'READ_ONLY',
    device: 'NONE',
    egress: 'CUSTOMER_NAMED_HOST',
    dataEffect: 'READS_ONLY',
    principalKinds: ['PERSISTENT', 'ANONYMOUS'],
    coversSurfaceKinds: ['ENDPOINT'],
    producers: ['IMPORT', 'SOURCE_ANALYSIS', 'DETERMINISTIC'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
  MUTATION: {
    type: 'MUTATION',
    summary: 'Seeded defects in the source, to measure whether the suite notices.',
    requirements: [
      {
        kind: 'UNPROBED',
        scope: 'SPEC',
        what: 'the mutation tool the spec names (Stryker, PITest, mutmut, …) and the project it runs in',
        why: "the tool is chosen per test and is usually a dev dependency of the customer's repository, not a binary on this image",
      },
    ],
    engines: [],
    repository: 'MATERIALISED',
    device: 'NONE',
    egress: 'NONE',
    dataEffect: 'READS_ONLY',
    principalKinds: [],
    coversSurfaceKinds: ['DATA_VARIANT'],
    producers: ['SOURCE_ANALYSIS', 'DETERMINISTIC'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
  MOBILE: {
    type: 'MOBILE',
    summary: 'A native app, over Appium, Maestro, Detox, Espresso or XCUITest.',
    requirements: [
      {
        kind: 'UNPROBED',
        scope: 'SPEC',
        what: 'the driver the spec names (an Appium server, or the Maestro / Detox / Gradle / xcodebuild CLI) and a device',
        why: "five transports behind one plugin, chosen per test — and a device farm is somebody else's machine",
      },
      {
        kind: 'PLATFORM',
        scope: 'SPEC',
        platform: 'darwin',
        why: 'XCUITest runs through xcodebuild, which only exists on macOS; the other four drivers do not care',
      },
    ],
    engines: [],
    repository: 'NONE',
    device: 'REAL_DEVICE',
    egress: 'CUSTOMER_NAMED_HOST',
    dataEffect: 'WRITES',
    principalKinds: ['PERSISTENT', 'DISPOSABLE'],
    coversSurfaceKinds: ['ROUTE', 'FORM', 'AUTH_SURFACE', 'DEVICE_LOCALE'],
    /** A dead plugin: nothing has ever emitted a MOBILE item. */
    producers: ['DETERMINISTIC'],
    /*
     * Mobile tests stop at the app's own UI. Nothing triggers or asserts a push
     * notification, which is what the pending PUSH type exists for — and
     * recording it here is what stops a passing MOBILE run from reading as
     * coverage of the notification path.
     */
    knownUnasserted: [
      { assertion: 'an APNs, FCM or Web Push delivery arriving on the device', reason: 'NOT_IMPLEMENTED' },
      { assertion: 'the app opened from a notification tap, with its deep link honoured', reason: 'NOT_IMPLEMENTED' },
    ],
    refusesLiveCredentials: false,
  },
  PERFORMANCE: {
    type: 'PERFORMANCE',
    summary: 'Core Web Vitals against a budget: what the person holding the laptop waits for.',
    requirements: [
      CHROMIUM,
      {
        kind: 'BINARY',
        scope: 'SPEC',
        name: 'lighthouse',
        install: 'npm i -g lighthouse',
        why: 'without it the plugin uses its own collector, which costs the audit detail and nothing else',
      },
    ],
    engines: ['chromium'],
    repository: 'NONE',
    device: 'EMULATED',
    egress: 'APP_UNDER_TEST',
    dataEffect: 'READS_ONLY',
    principalKinds: ['PERSISTENT', 'ANONYMOUS'],
    coversSurfaceKinds: ['ROUTE'],
    producers: ['DETERMINISTIC'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
};

/**
 * THE PENDING TYPES — declared, spec-validatable, and not storable.
 *
 * Five of these eight already have a complete runner plugin sitting in
 * `PENDING_PLUGINS` (DESKTOP, JOBS, LINKS, SEO, TENANCY); three are being built
 * against this declaration in parallel with it. Both halves are in one table
 * because a reader asking "what can QAAI test" needs one answer, and because the
 * mint recipe is identical either way: a member in `TEST_TYPES`, a value in the
 * Prisma enum, and the registry promotes the plugin with no further edit.
 *
 * A `Record<PendingTestType, …>` for the same compiler reason as the minted
 * table: a pending member with no declaration would be a type the preflight
 * cannot describe.
 */
export const PENDING_TEST_TYPE_DECLARATIONS: Readonly<
  Record<PendingTestType, TestTypeDeclaration>
> = {
  DESKTOP: {
    type: 'DESKTOP',
    summary: 'An Electron, Tauri or WebView shell, driven as the application it is.',
    requirements: [
      {
        kind: 'UNPROBED',
        scope: 'SPEC',
        what: 'the packaged application binary the spec names',
        why: "it is the customer's own build artefact, so this image cannot know its path in advance",
      },
    ],
    engines: ['chromium'],
    repository: 'NONE',
    device: 'NONE',
    egress: 'APP_UNDER_TEST',
    dataEffect: 'WRITES',
    principalKinds: ['PERSISTENT'],
    coversSurfaceKinds: ['ROUTE', 'FORM'],
    producers: ['NONE'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
  JOBS: {
    type: 'JOBS',
    summary: 'A queue consumer, cron entry or webhook receiver, triggered and asserted.',
    requirements: [
      {
        kind: 'UNPROBED',
        scope: 'SPEC',
        what: "the broker or scheduler the spec names, on the tenant's network",
        why: 'enqueuing from here would put a job in a customer queue on a preflight',
      },
    ],
    engines: [],
    repository: 'NONE',
    device: 'NONE',
    egress: 'CUSTOMER_NAMED_HOST',
    dataEffect: 'WRITES',
    principalKinds: [],
    /*
     * The BACKGROUND_JOB surface kind has been counted by the inventory since
     * it was built, while nothing could execute one. This is the entry that
     * closes that: a surface counted in a denominator with no type able to
     * cover it is a permanent, unexplained shortfall.
     */
    coversSurfaceKinds: ['BACKGROUND_JOB', 'NOTIFICATION'],
    producers: ['NONE'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
  LINKS: {
    type: 'LINKS',
    summary: 'Every link and asset edge a crawl discovered, resolved.',
    requirements: [CHROMIUM],
    engines: ['chromium'],
    repository: 'NONE',
    device: 'NONE',
    egress: 'CUSTOMER_NAMED_HOST',
    dataEffect: 'READS_ONLY',
    principalKinds: ['ANONYMOUS', 'PERSISTENT'],
    coversSurfaceKinds: ['ROUTE', 'ERROR_STATE'],
    producers: ['CRAWL'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
  SEO: {
    type: 'SEO',
    summary: 'Title, canonical, hreflang, Open Graph, JSON-LD, robots and sitemap consistency.',
    requirements: [CHROMIUM],
    engines: ['chromium'],
    repository: 'NONE',
    device: 'NONE',
    egress: 'APP_UNDER_TEST',
    dataEffect: 'READS_ONLY',
    principalKinds: ['ANONYMOUS'],
    coversSurfaceKinds: ['ROUTE'],
    producers: ['CRAWL'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
  TENANCY: {
    type: 'TENANCY',
    summary: "One tenant's session against another tenant's ids, across every endpoint.",
    requirements: [],
    engines: [],
    repository: 'NONE',
    device: 'NONE',
    egress: 'APP_UNDER_TEST',
    /*
     * READS_ONLY, and that is the security property rather than a convenience:
     * the sweep uses safe methods only (`isSafeProbeMethod` in ./principals.ts),
     * so a cross-tenant probe can never be the thing that writes to the other
     * tenant's data. A declaration of WRITES here would be permission to do the
     * damage the test is looking for.
     */
    dataEffect: 'READS_ONLY',
    principalKinds: ['PERSISTENT', 'DISPOSABLE'],
    coversSurfaceKinds: ['ENDPOINT', 'ROLE_CELL'],
    producers: ['DETERMINISTIC'],
    knownUnasserted: [],
    refusesLiveCredentials: false,
  },
  CHAOS: {
    type: 'CHAOS',
    summary: "A dependency misbehaving: the response the application never sees in staging.",
    /*
     * NO REQUIREMENTS, and that is the finding. `har.ts` ALREADY HAS ROUTE
     * INTERCEPTION — 1,528 lines of it, written and tested — and no test type
     * used it, so dependency-misbehaviour paths could not be exercised at all.
     * The capability is on the image; what was missing was a type that asks for
     * it. A reader seeing an empty list here should read "nothing to install",
     * not "nothing known".
     */
    requirements: [{ ...CHROMIUM, why: 'route interception is a browser context feature' }],
    engines: ['chromium'],
    repository: 'NONE',
    device: 'EMULATED',
    /*
     * APP_UNDER_TEST and not CUSTOMER_NAMED_HOST: the point of the type is that
     * the misbehaving response is SYNTHESISED by the interceptor. It must never
     * reach the third party it is impersonating, which is also why it needs no
     * credential of any kind.
     */
    egress: 'APP_UNDER_TEST',
    dataEffect: 'READS_ONLY',
    principalKinds: ['PERSISTENT', 'ANONYMOUS'],
    coversSurfaceKinds: ['ERROR_STATE', 'ROUTE', 'ENDPOINT'],
    producers: ['DETERMINISTIC'],
    /*
     * AMENDED FROM `[]` ON THE PLUGIN AUTHOR'S OWN REPORT. `chaosPlugin` ships
     * with NO browser adapter, so three of its fifteen faults cannot be
     * injected on this image at all and one invariant is decidable only in
     * English. An empty list beside that said the type asserts everything it
     * claims, which is the declaration contradicting the code under it.
     */
    knownUnasserted: [
      {
        assertion: 'that a localised error message is error-shaped',
        reason: 'NOT_IMPLEMENTED',
      },
      {
        assertion:
          "that a response stalls after its headers, that a websocket drops, or that the browser's clock is skewed",
        reason: 'CAPABILITY_ABSENT',
      },
      {
        assertion: 'that no write was duplicated, on a flow that issues no write',
        reason: 'SURFACE_UNREACHED',
      },
    ],
    refusesLiveCredentials: false,
  },
  PAYMENTS: {
    type: 'PAYMENTS',
    summary: 'The money path: 3DS, declines, webhook transitions, refunds, partial capture.',
    requirements: [
      CHROMIUM,
      {
        kind: 'UNPROBED',
        scope: 'SPEC',
        what: "the provider's test-mode endpoint and the customer's sandbox credential",
        why: "a sandbox is the customer's own provider account, so this image cannot probe it and must never hold its key",
      },
    ],
    engines: ['chromium'],
    repository: 'NONE',
    device: 'EMULATED',
    egress: 'PROVIDER_TEST_MODE',
    /*
     * WRITES: a test-mode charge creates objects in the customer's sandbox. It
     * is the honest answer and it is what makes the DISPOSABLE principal
     * requirement below enforceable — a payment scenario pointed at the owner's
     * real account is the single most expensive mistake available here.
     */
    dataEffect: 'WRITES',
    principalKinds: ['DISPOSABLE'],
    coversSurfaceKinds: ['ROUTE', 'FORM', 'ENDPOINT', 'ERROR_STATE'],
    producers: ['DETERMINISTIC'],
    /*
     * Named here BEFORE the plugin exists, so that the first green PAYMENTS run
     * cannot read as coverage of a path it never drove. Every one of these is a
     * fact about a provider's test mode rather than a gap of ours, which is why
     * they carry PROVIDER_TEST_MODE_LIMIT and not NOT_IMPLEMENTED.
     */
    knownUnasserted: [
      { assertion: 'a settlement, which test mode never performs', reason: 'PROVIDER_TEST_MODE_LIMIT' },
      { assertion: 'a chargeback or dispute lifecycle beyond its simulated open', reason: 'PROVIDER_TEST_MODE_LIMIT' },
      { assertion: 'an issuer-specific 3DS challenge UI, which varies by real bank', reason: 'PROVIDER_TEST_MODE_LIMIT' },
    ],
    /*
     * TRUE, and the declaration is checked rather than trusted. The plugin must
     * be STRUCTURALLY INCAPABLE of driving a live-mode charge: a type-level
     * refusal (no field can carry a live key) and a run-time one (a test-mode
     * assertion before the first request), never a convention. Only published
     * test values from ./provider-catalogue.ts, in the provider's test mode.
     */
    refusesLiveCredentials: true,
  },
  DOCUMENT: {
    type: 'DOCUMENT',
    summary: 'A produced file: an invoice, a statement, a label, a signed contract, an export.',
    /*
     * `setInputFiles` APPEARS NOWHERE in the runner and nothing asserts a
     * downloaded file's name, type or bytes. No plugin calls `page.pdf()` or
     * asserts a produced document. So invoices, statements, shipping labels and
     * contracts — the artefacts a business is actually judged on — were
     * untested, and a click that produced a corrupt zero-byte PDF passed.
     *
     * The PDF text layer is the one genuinely external capability: extracting it
     * needs a parser this image does not carry, so the requirement is declared
     * SPEC-scoped and its absence is reported as UNAVAILABLE, never as a pass.
     */
    requirements: [
      { ...CHROMIUM, why: 'a download and a print-to-PDF both come out of a browser context' },
      {
        kind: 'BINARY',
        scope: 'SPEC',
        name: 'pdftotext',
        install: 'brew install poppler (or apt-get install poppler-utils)',
        why: 'asserting the TEXT of a PDF needs a parser; without it the type still asserts the name, the media type, the byte length and the magic number, and reports the text assertion as unavailable',
      },
    ],
    engines: ['chromium'],
    repository: 'NONE',
    device: 'NONE',
    egress: 'APP_UNDER_TEST',
    dataEffect: 'WRITES',
    principalKinds: ['PERSISTENT'],
    coversSurfaceKinds: ['ROUTE', 'FORM', 'NOTIFICATION'],
    producers: ['DETERMINISTIC'],
    knownUnasserted: [
      { assertion: 'the rendered appearance of a page of the document', reason: 'NOT_IMPLEMENTED' },
      { assertion: 'a digital signature on a signed contract', reason: 'NOT_IMPLEMENTED' },
    ],
    refusesLiveCredentials: false,
  },
  PWA: {
    type: 'PWA',
    summary: 'Service worker, offline navigation, cache-first behaviour, background sync, install.',
    requirements: [
      {
        ...CHROMIUM,
        why: 'service-worker registration, offline emulation and the install prompt are all Chromium-backed; webkit and firefox report UNAVAILABLE rather than a pass',
      },
    ],
    engines: ['chromium'],
    repository: 'NONE',
    device: 'EMULATED',
    egress: 'APP_UNDER_TEST',
    dataEffect: 'READS_ONLY',
    principalKinds: ['ANONYMOUS', 'PERSISTENT'],
    coversSurfaceKinds: ['ROUTE', 'ERROR_STATE'],
    producers: ['DETERMINISTIC'],
    knownUnasserted: [
      {
        assertion: 'a background sync replaying after the device genuinely regains connectivity',
        reason: 'CAPABILITY_ABSENT',
      },
      {
        assertion: 'the OS-level install prompt, which is chrome outside the page',
        reason: 'CAPABILITY_ABSENT',
      },
    ],
    refusesLiveCredentials: false,
  },
  PUSH: {
    type: 'PUSH',
    summary: 'A notification actually delivered: Web Push, APNs or FCM, triggered and asserted.',
    requirements: [
      CHROMIUM,
      {
        kind: 'UNPROBED',
        scope: 'SPEC',
        what: 'the push transport the spec names and the customer’s own sender credential',
        why: 'an APNs key or an FCM service account belongs on a customer-owned Integration row, never on this image — and the device that receives it is somebody else’s machine',
      },
    ],
    engines: ['chromium'],
    repository: 'NONE',
    /*
     * REAL_DEVICE for APNs and FCM, because there is no install that produces a
     * device token. Web Push is the one arm an emulated context can serve, and
     * the plugin must report the other two as UNAVAILABLE rather than skipping:
     * a skipped push test inside a percentage is a notification path that can
     * never fail.
     */
    device: 'REAL_DEVICE',
    egress: 'CUSTOMER_NAMED_HOST',
    dataEffect: 'WRITES',
    principalKinds: ['DISPOSABLE', 'PERSISTENT'],
    coversSurfaceKinds: ['NOTIFICATION', 'BACKGROUND_JOB'],
    producers: ['DETERMINISTIC'],
    knownUnasserted: [
      { assertion: 'an APNs delivery, which needs a real iOS device and token', reason: 'CAPABILITY_ABSENT' },
      { assertion: 'an FCM delivery, which needs a real Android device and token', reason: 'CAPABILITY_ABSENT' },
      { assertion: 'the notification as the OS renders it, outside the page', reason: 'CAPABILITY_ABSENT' },
    ],
    refusesLiveCredentials: true,
  },
  I18N_DEEP: {
    type: 'I18N_DEEP',
    summary: 'RTL mirroring, pseudo-localization, truncation and missing keys — the l10n defects.',
    /*
     * The type LOCALIZATION should have been. That one re-runs the same code
     * under another locale and emits ZERO findings, so no l10n defect class is
     * detectable and its `Finding` kind is dead. This one is deterministic and
     * model-free: a pseudo-localized string is generated from the seed, and
     * truncation, mirroring and an untranslated key are all measurable against
     * the rendered box.
     */
    requirements: [CHROMIUM],
    engines: ['chromium'],
    repository: 'READ_ONLY',
    device: 'EMULATED',
    egress: 'APP_UNDER_TEST',
    dataEffect: 'READS_ONLY',
    principalKinds: ['ANONYMOUS', 'PERSISTENT'],
    coversSurfaceKinds: ['DEVICE_LOCALE', 'ROUTE', 'COMPONENT_STATE', 'FORM'],
    producers: ['DETERMINISTIC'],
    knownUnasserted: [
      {
        assertion: 'whether a translation is CORRECT, as opposed to present and fitting',
        reason: 'NOT_IMPLEMENTED',
      },
    ],
    refusesLiveCredentials: false,
  },
};

// ─── Lookups ─────────────────────────────────────────────────────────────────

/**
 * Every declaration, minted and pending, by type.
 *
 * Built from the two tables rather than being a third hand-written one, so a
 * type cannot appear here with a declaration that disagrees with its own table.
 */
export const ALL_TEST_TYPE_DECLARATIONS: Readonly<Record<string, TestTypeDeclaration>> = {
  ...TEST_TYPE_DECLARATIONS,
  ...PENDING_TEST_TYPE_DECLARATIONS,
};

/**
 * The declaration for a type, or `null` for a name neither table has.
 *
 * `null` rather than a throw, and never a fabricated empty declaration: an
 * empty one would say "needs nothing, covers nothing, no producer", every word
 * of which is a claim, and a caller handed it would treat an unknown type as a
 * type that runs anywhere.
 */
export function declarationFor(type: string): TestTypeDeclaration | null {
  return ALL_TEST_TYPE_DECLARATIONS[type] ?? null;
}

/**
 * The requirements for a type, in the shape
 * `packages/runner/src/preflight.ts` wants.
 *
 * Structurally assignable to `readonly Requirement[]` there for every member
 * except CHANNEL, which that union does not have yet — so this returns the full
 * list and the handover names the one-line widening. Returns `[]` for an unknown
 * type, which is the only safe answer: a preflight asked about a type nobody
 * declared must not invent a requirement, and `TypeRunnability.runnable` already
 * distinguishes "nothing to check" from "nothing was checked".
 */
export function requirementsForType(type: string): readonly TypeRequirement[] {
  return declarationFor(type)?.requirements ?? [];
}

/**
 * THE TYPES NO PRODUCER CAN EMIT — the funnel's width, as a number.
 *
 * The single most useful read in this file, and the one the product had no way
 * to answer. A type in this list has a working plugin and no path by which a
 * test of it could come to exist, which is a different and much worse thing than
 * a type that is hard to run.
 */
export function typesWithNoProducer(): string[] {
  return Object.values(ALL_TEST_TYPE_DECLARATIONS)
    .filter((d) => d.producers.length === 1 && d.producers[0] === 'NONE')
    .map((d) => String(d.type))
    .sort();
}

/** Which types a given producer may emit, so a funnel can be audited from either end. */
export function typesEmittableBy(producer: TestTypeProducer): string[] {
  return Object.values(ALL_TEST_TYPE_DECLARATIONS)
    .filter((d) => d.producers.includes(producer))
    .map((d) => String(d.type))
    .sort();
}

/**
 * Types that need the customer's repository MATERIALISED into the run workspace.
 *
 * Exported as a list because the run processor needs exactly this question
 * answered once, before it starts: "does anything in this run require a
 * checkout". Asking per test and materialising lazily is how three types came to
 * execute in the worker's own directory.
 */
export function typesNeedingMaterialisedRepo(): string[] {
  return Object.values(ALL_TEST_TYPE_DECLARATIONS)
    .filter((d) => d.repository === 'MATERIALISED')
    .map((d) => String(d.type))
    .sort();
}

/**
 * Is this declaration internally coherent?
 *
 * The pure half of `testTypeDeclarationSchema` in ./schemas.ts, so a producer
 * can check before it writes and the schema can refuse on the same rules. Every
 * problem is a sentence naming the defect it prevents, because a refusal that
 * does not is a wall.
 */
export function declarationProblems(decl: TestTypeDeclaration): string[] {
  const problems: string[] = [];

  /*
   * ── THE WRITES RULE IS SCOPED TO BROWSER TYPES, AND THAT IS NOT A LOOPHOLE ──
   *
   * The first version of this rule was `MUTATING_DATA_EFFECTS.includes(...) &&
   * principalKinds.length === 0`, and the colocated test over the SHIPPED tables
   * caught it refusing four of the product's own declarations: INTEGRATION,
   * DATABASE, CLI and JOBS all write and name no principal — correctly, because
   * none of them acts as one. `npm test` runs as the checkout, a DATABASE test
   * runs as a connection string, a CLI test runs as a shell, and JOBS enqueues
   * through a broker. There is no identity for a `Principal` to BE.
   *
   * Satisfying the broad rule would have meant writing PERSISTENT into those
   * four declarations, which is a claim nothing produced about an actor that
   * does not exist — exactly the defect the rule was written to prevent, in the
   * file that prevents it. So the rule is scoped to the case where a Principal
   * IS the identity: a type that drives a browser.
   *
   * What guards the other four instead is named rather than assumed:
   * `repository: MATERIALISED` keeps the command inside the customer's own
   * checkout, and the connection or broker they reach is a `SPEC`-scoped
   * UNPROBED requirement — "it lives on the tenant's network, so probing it from
   * here would be probing the wrong host". Neither is a principal and neither
   * pretends to be.
   *
   * The DESTROYS rule below stays UNCONDITIONAL, which is where the teeth are:
   * destroying data is the one effect that costs the customer something they
   * cannot get back, and a non-browser type claiming it must still say whose
   * disposable identity it is destroying.
   */
  if (
    MUTATING_DATA_EFFECTS.includes(decl.dataEffect) &&
    decl.engines.length > 0 &&
    decl.principalKinds.length === 0
  ) {
    problems.push(
      `dataEffect is ${decl.dataEffect}, this type drives a browser, and no principal kind is declared — a browser type that changes data with no identity named is a type nothing can refuse to point at the customer's own account`,
    );
  }
  if (decl.dataEffect === 'DESTROYS' && !decl.principalKinds.includes('DISPOSABLE')) {
    problems.push(
      'dataEffect is DESTROYS and DISPOSABLE is not among the principal kinds — signing out, expiring a session or deleting a row against a PERSISTENT identity costs the customer the only way in',
    );
  }
  if (decl.egress === 'PROVIDER_TEST_MODE' && !decl.refusesLiveCredentials) {
    problems.push(
      'egress is PROVIDER_TEST_MODE and refusesLiveCredentials is false — a type that reaches a payment or identity provider must be structurally incapable of driving a live-mode request, not merely expected not to',
    );
  }
  if (decl.producers.length === 0) {
    problems.push(
      "producers is empty, which says nothing. A type nothing emits declares ['NONE'] — a value a report can count — because an empty list reads as 'not filled in yet'",
    );
  }
  if (decl.producers.length > 1 && decl.producers.includes('NONE')) {
    problems.push(
      "producers contains NONE alongside a real producer, which is a contradiction: NONE means nothing emits this type",
    );
  }
  if (decl.engines.length === 0 && decl.device === 'EMULATED') {
    problems.push(
      'device is EMULATED and no engine is declared — an emulated device is a browser context, so something has to drive it',
    );
  }
  for (const req of decl.requirements) {
    if (req.kind === 'BROWSER' && !decl.engines.includes(req.name)) {
      problems.push(
        `requires the ${req.name} browser and does not declare it in engines, so a preflight would probe for a browser this type says it never drives`,
      );
    }
  }

  return problems;
}

/**
 * The declarations that do not hold together, by type.
 *
 * Exported so the parity test can assert that the SHIPPED tables are clean —
 * which is the check that matters, because a rule nothing in the product
 * satisfies is a rule somebody will delete.
 */
export function incoherentDeclarations(): Array<{ type: string; problems: string[] }> {
  return Object.values(ALL_TEST_TYPE_DECLARATIONS)
    .map((decl) => ({ type: String(decl.type), problems: declarationProblems(decl) }))
    .filter((entry) => entry.problems.length > 0);
}

/*
 * ── Why these four lists are imported and not restated ──────────────────────
 *
 * `TEST_TYPES`, `PENDING_TEST_TYPES`, `PRINCIPAL_KINDS` and `SURFACE_KINDS` are
 * each referenced below purely so that this module's tables are provably built
 * over the SAME vocabularies the rest of the product uses. A hand-written
 * parallel list is how `BROWSER_ENGINES` came to exist twice, and how the
 * provider catalogue's shape probe came to cover 16 of 27 declared shapes.
 */
/** Every type name this file declares, minted first, then pending. Derived. */
export const DECLARED_TEST_TYPE_NAMES: readonly string[] = [
  ...TEST_TYPES,
  ...PENDING_TEST_TYPES,
];

/** Principal kinds any declaration may name. Derived, so it cannot drift. */
export const DECLARABLE_PRINCIPAL_KINDS: readonly PrincipalKind[] = PRINCIPAL_KINDS;

/** Surface kinds any declaration may claim to cover. Derived. */
export const DECLARABLE_SURFACE_KINDS: readonly SurfaceKind[] = SURFACE_KINDS;

/**
 * Surface kinds no declared type can cover.
 *
 * The denominator's permanent, structural shortfall, named. A surface kind the
 * inventory counts and no type can produce coverage for is a percentage that can
 * never reach 100 for a reason nobody can act on — and until this function
 * existed, it was invisible. Computed from the tables rather than listed, so it
 * cannot claim a gap that a new declaration has already closed.
 */
export function surfaceKindsNoTypeCovers(): SurfaceKind[] {
  const covered = new Set<SurfaceKind>();
  for (const decl of Object.values(ALL_TEST_TYPE_DECLARATIONS)) {
    for (const kind of decl.coversSurfaceKinds) covered.add(kind);
  }
  return DECLARABLE_SURFACE_KINDS.filter((kind) => !covered.has(kind));
}
