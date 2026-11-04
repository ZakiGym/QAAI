/**
 * Domain constants shared by every app and package.
 *
 * These string unions are the source of truth; `apps/api/prisma/schema.prisma`
 * mirrors them as Postgres enums. If you add a member here, add it there too —
 * `npm run check:enums -w @qaai/api` fails the build when they drift.
 */

// ─── Test types (§4) ─────────────────────────────────────────────────────────

export const TEST_TYPES = [
  'E2E',
  'SMOKE',
  'INTEGRATION',
  'API',
  'VISUAL',
  'ACCESSIBILITY',
  'LOAD',
  'SECURITY_SMOKE',
  'UNIT_GEN',
  'CROSS_BROWSER',
  'LOCALIZATION',
  'EMAIL_OTP',
  'DATABASE',
  'CLI',
  'PROTOCOL',
  'CONTRACT',
  'MUTATION',
  'MOBILE',
  'PERFORMANCE',
] as const;
export type TestType = (typeof TEST_TYPES)[number];

/** Human labels for the cockpit's suite tree and filter chips. */
export const TEST_TYPE_LABELS: Record<TestType, string> = {
  E2E: 'E2E / UI',
  SMOKE: 'Smoke',
  INTEGRATION: 'Integration',
  API: 'API',
  VISUAL: 'Visual regression',
  ACCESSIBILITY: 'Accessibility',
  LOAD: 'Load / performance',
  SECURITY_SMOKE: 'Security smoke',
  UNIT_GEN: 'Unit / component',
  CROSS_BROWSER: 'Cross-browser',
  LOCALIZATION: 'Localization',
  EMAIL_OTP: 'Email / OTP',
  DATABASE: 'Database',
  CLI: 'CLI / command',
  PROTOCOL: 'Protocol / streaming',
  CONTRACT: 'Contract (Pact / OpenAPI)',
  MUTATION: 'Mutation',
  MOBILE: 'Mobile (native app)',
  // Distinct from LOAD: that one measures what the server survives, this one
  // measures what the person holding the laptop waits for.
  PERFORMANCE: 'Performance budgets (Core Web Vitals)',
};

// ─── Test types that have a declaration and no minted member yet ─────────────
//
// ── THE DEFECT, AND WHY IT IS TWO LISTS AND NOT ONE ─────────────────────────
//
// `TEST_TYPES` above is not a list. It is a Postgres enum, `createTestSchema`,
// the cockpit's filter chips, a compiler-exhaustive `Record` in @qaai/runner and
// another in @qaai/agent, and — the part that decides this — `check:wiring`
// FAILS a member with no runner plugin, saying "every test of this type is
// recorded SKIPPED at run time". It is right to. A percentage containing tests
// that cannot fail is the one lie this product cannot afford, and a minted type
// with no plugin is exactly that.
//
// The runner already solved the mirror image. `PENDING_PLUGINS` in
// packages/runner/src/registry.ts holds FIVE COMPLETE PLUGINS whose type is not
// minted — DESKTOP, JOBS, LINKS, SEO and TENANCY — and `promotePendingPlugins`
// moves each into the live table the moment the vocabulary names it, so that
// "the shared edit alone is sufficient". What was missing was the other end: a
// name a plugin, a spec schema, a preflight declaration and a plan item could
// all be written against while the member does not exist yet.
//
// That is this list. A pending type is:
//   · DECLARABLE — `PENDING_TEST_TYPE_DECLARATIONS` in ./test-type-decl.ts says
//     what it needs, which producer may emit it and what it will NOT assert;
//   · SPEC-VALIDATABLE — its spec schema lives in ./schemas.ts like any other;
//   · NOT STORABLE — no `Test` row can carry it, because the Prisma `TestType`
//     enum does not have it and `check:enums` would fail a Prisma value with no
//     TypeScript twin.
//
// Not storable is the honest state of a type whose plugin is being written, and
// it is strictly better than the alternative: six plugins landing in parallel,
// each adding its own member to the array above, is six conflicting edits to one
// file and a window in which `check:wiring` reports six failures that no agent
// can tell apart from its own.
//
// ── THE MINT, WHICH IS ONE EDIT PER TYPE AND MUST BE ALL OF IT ──────────────
//
// See {@link mintTestTypeSteps}. All four steps go in ONE change: a member here
// without a plugin fails `check:wiring`, a Prisma value without a member fails
// `check:enums`, and a member without a Prisma value fails `check:wiring` too.
// The three guards are deliberately mutually blocking, which is what makes a
// half-finished mint impossible to ship.

export const PENDING_TEST_TYPES = [
  /** Electron, Tauri and WebView shells. Plugin: plugins/desktop.ts. */
  'DESKTOP',
  /** Queue consumers, cron entries, webhook receivers. Plugin: plugins/jobs.ts. */
  'JOBS',
  /** Link and asset edges a crawl discovered. Plugin: plugins/links.ts. */
  'LINKS',
  /** Title, canonical, hreflang, OG, JSON-LD, robots. Plugin: plugins/seo.ts. */
  'SEO',
  /** One tenant's session against another tenant's ids. Plugin: plugins/tenancy.ts. */
  'TENANCY',
  /** A dependency misbehaving, through the route interception har.ts already has. */
  'CHAOS',
  /** The money path: 3DS, declines, webhook transitions, refunds, partial capture. */
  'PAYMENTS',
  /** A produced file: invoice, statement, label, signed contract, export. */
  'DOCUMENT',
  /** Service worker, offline navigation, cache-first, background sync, install. */
  'PWA',
  /** A notification actually delivered: Web Push, APNs, FCM. */
  'PUSH',
  /** RTL mirroring, pseudo-localization, truncation, missing keys. */
  'I18N_DEEP',
] as const;
export type PendingTestType = (typeof PENDING_TEST_TYPES)[number];

/**
 * Human labels, beside the list rather than in the web app, for the same reason
 * `TEST_TYPE_LABELS` is: the surface that offers a type and the code that
 * refuses it must not end up describing different things.
 */
export const PENDING_TEST_TYPE_LABELS: Record<PendingTestType, string> = {
  DESKTOP: 'Desktop shell (Electron / Tauri)',
  JOBS: 'Background jobs & webhooks',
  LINKS: 'Links & assets',
  SEO: 'SEO & metadata',
  TENANCY: 'Cross-tenant isolation',
  CHAOS: 'Dependency chaos',
  PAYMENTS: 'Payments (test mode)',
  DOCUMENT: 'Documents & downloads',
  PWA: 'PWA & offline',
  PUSH: 'Push notifications',
  I18N_DEEP: 'Deep i18n (RTL, pseudo-loc, truncation)',
};

/**
 * Every type name the product has a declaration for, minted or not.
 *
 * DERIVED, never hand-listed. A third array would be a third thing to forget,
 * and this one is the denominator of "what can QAAI test" on every surface that
 * answers that question.
 */
export const ANY_TEST_TYPES: readonly (TestType | PendingTestType)[] = [
  ...TEST_TYPES,
  ...PENDING_TEST_TYPES,
];
export type AnyTestType = TestType | PendingTestType;

/** Narrows an untrusted string to a MINTED type — the only kind a row may hold. */
export function isTestType(value: unknown): value is TestType {
  return typeof value === 'string' && (TEST_TYPES as readonly string[]).includes(value);
}

/**
 * Narrows to a PENDING type.
 *
 * Its one job is to let a caller say the right sentence. "QAAI cannot test your
 * Electron app" and "QAAI can test your Electron app and you cannot create the
 * test yet" are different facts with different remedies, and without this the
 * second reads as the first — understating what the product does while
 * overstating what a customer can reach.
 */
export function isPendingTestType(value: unknown): value is PendingTestType {
  return typeof value === 'string' && (PENDING_TEST_TYPES as readonly string[]).includes(value);
}

/**
 * The four edits that mint a pending type, in the order they must be made.
 *
 * A function returning sentences rather than a doc comment, because this is the
 * text a refusal prints: `reasonUnsupported` in packages/runner/src/registry.ts
 * already tells a reader "add it to TEST_TYPES in constants.ts", and it could
 * only say two of the four steps. A remedy that is three-quarters complete sends
 * somebody to ship a mint that fails a different guard.
 */
export function mintTestTypeSteps(type: PendingTestType): string[] {
  return [
    `Add '${type}' to TEST_TYPES in packages/shared/src/constants.ts and a label to TEST_TYPE_LABELS.`,
    `Move its entry from PENDING_TEST_TYPE_DECLARATIONS to TEST_TYPE_DECLARATIONS in packages/shared/src/test-type-decl.ts.`,
    `Add ${type} to enum TestType in apps/api/prisma/schema.prisma and write the migration (ALTER TYPE "TestType" ADD VALUE '${type}').`,
    `Add an entry to TYPE_REQUIREMENTS in packages/runner/src/preflight.ts and to STRATEGIES in packages/agent/src/spec-strategies.ts — both are compiler-exhaustive Records over TestType, so neither package compiles until you do.`,
  ];
}

// ─── Verdicts (§3.3) ─────────────────────────────────────────────────────────

export const VERDICTS = ['REAL_BUG', 'INTENDED_CHANGE', 'FLAKE', 'ENV_ISSUE'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_LABELS: Record<Verdict, string> = {
  REAL_BUG: 'Real bug',
  INTENDED_CHANGE: 'Intended change',
  FLAKE: 'Flake',
  ENV_ISSUE: 'Environment issue',
};

/**
 * Only REAL_BUG blocks a merge by default. INTENDED_CHANGE routes to the Healer,
 * FLAKE routes to the quarantine lane, ENV_ISSUE alerts but never gates.
 */
export const BLOCKING_VERDICTS: readonly Verdict[] = ['REAL_BUG'];

// ─── Run + step status ───────────────────────────────────────────────────────

export const RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'PASSED',
  'FAILED',
  'CANCELLED',
  'ERRORED',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'PASSED',
  'FAILED',
  'CANCELLED',
  'ERRORED',
];

export const TEST_RESULT_STATUSES = ['PASSED', 'FAILED', 'SKIPPED', 'FLAKY', 'TIMED_OUT'] as const;
export type TestResultStatus = (typeof TEST_RESULT_STATUSES)[number];

export const STEP_STATUSES = ['PASSED', 'FAILED', 'SKIPPED'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

// ─── Why a result did not run (§4) ───────────────────────────────────────────
//
// There was one SKIPPED, and four completely different facts were filed under
// it: a placeholder row nobody reached, a test this deployment has no tool to
// execute, a test whose environment was broken, and a run somebody cancelled.
// A reader could not tell "nobody has written this yet" from "this cannot run
// here", which means the skipped count answered no question at all — and the
// one question it is asked, every day, is "is this suite actually testing
// anything?".
//
// These are NOT new `TestResultStatus` members. The status column is read by
// the gate, the counters, the CLI's exit code, the GitHub check, the JUnit
// writer and the coverage pass, and widening it would quietly change what every
// one of them means by a skip. The status stays SKIPPED and the REASON becomes
// its own field, which is additive: nothing that reads the status changes
// behaviour, and anything that wants the distinction now has it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four reasons a result exists with nothing measured in it.
 *
 *   NOT_RUN        — nothing was attempted and nothing says it could not be.
 *                    A placeholder row for a test this run selected and never
 *                    reached: a dead shard, a lost queue job, a worker killed
 *                    mid-suite. Deliberately the weakest claim of the four,
 *                    because "we do not know what happened to this" is the
 *                    honest reading of a row nobody wrote to.
 *   BLOCKED_BY_ENV — QAAI tried, or refused to try, because the ENVIRONMENT was
 *                    not usable: the base URL did not answer, the configured
 *                    login no longer works, there was no repository checkout to
 *                    run inside. Not a verdict on the application.
 *   UNSUPPORTED    — this DEPLOYMENT cannot execute this test: no plugin for
 *                    the type, or the tool the type needs is not on this image
 *                    (no k6, no Lighthouse, no Firefox). A product/packaging
 *                    gap, fixed by installing something, not by editing a test.
 *   CANCELLED      — a person stopped the run. The only one of the four that is
 *                    somebody's decision rather than a fault, and the only one
 *                    nobody needs to act on.
 *
 * ── Where this is STORED, and why in two places ─────────────────────────────
 *
 * In the column `TestResult.notRunKind`, a Prisma enum mirrored by this array
 * with a `check:enums` parity entry. That is the queryable home, and it is what
 * makes "how many of this month's skips were the environment's fault?" a
 * `GROUP BY` instead of a regex over a text column — the same argument the
 * migration that moved the mutation score out of a Step TITLE makes at length.
 *
 * AND as a tag at the head of `TestResult.errorMessage`, written by
 * `notRunMessage` and read back by `parseNotRun`. That is not redundancy left
 * over from the interim: the tag is what a surface sees when it renders the
 * message, the sentence after it is complete English, and every row written
 * before the column existed carries the tag and nothing else. `parseNotRun` is
 * therefore still the only way to classify an old row, and a reader with both
 * should prefer the column and fall back to the tag.
 *
 * NEITHER OF THEM HAS A DEFAULT. The column is nullable with no default and the
 * tag is simply absent, and both spell the same fifth state: not recorded. A
 * plugin that returns SKIPPED with a plain sentence has made no claim about
 * which of the four reasons applies, and writing `NOT_RUN` on its behalf would
 * be putting a claim in the database that nothing produced. `TestExecution.
 * notRun` in types.ts is how a plugin makes that claim when it does have one.
 */
export const NOT_RUN_KINDS = ['NOT_RUN', 'BLOCKED_BY_ENV', 'UNSUPPORTED', 'CANCELLED'] as const;
export type NotRunKind = (typeof NOT_RUN_KINDS)[number];

/*
 * No label map and no "which of these count against a pass rate" list here yet,
 * and that is deliberate rather than an omission: `check:wiring` fails exported
 * code with no caller, and the two surfaces that want them — the run page's
 * result row, and the pass-rate and coverage denominators — are not in this
 * change. The guidance they will need is written down instead of shipped as
 * dead code:
 *
 *   · BLOCKED_BY_ENV and UNSUPPORTED must be EXCLUDED from a pass rate and from
 *     a coverage denominator rather than scored as skips. A test that could not
 *     be attempted is not evidence about the application in either direction,
 *     and counting it is how a dead staging box moved a coverage number.
 *   · CANCELLED is in the same position for a different reason: nobody wanted
 *     the answer.
 *   · NOT_RUN is the weakest of the four and the only honest reading of a row
 *     nobody wrote to. It is not evidence of anything and should not be
 *     averaged over either.
 */

/** Narrows an untrusted string, so an unknown value reads as "not recorded". */
export function isNotRunKind(value: unknown): value is NotRunKind {
  return typeof value === 'string' && (NOT_RUN_KINDS as readonly string[]).includes(value);
}

/**
 * The `TestResult.errorMessage` for a result that did not run.
 *
 * The tag is machine-readable and the rest is a sentence somebody can act on.
 * Both halves are required: a bare tag tells a human nothing, and a bare
 * sentence tells a program nothing, and this product has shipped both mistakes.
 */
export function notRunMessage(kind: NotRunKind, why: string): string {
  return `[${kind}] ${why}`;
}

/**
 * Read the kind back off a stored message, or null when it carries none.
 *
 * Null is the honest answer for every row written before this existed and for
 * every row written by a path that has not learned to tag yet — notably the
 * plugins, which still return SKIPPED with a plain sentence when their tool is
 * missing. Null must therefore never be scored as any particular kind; it means
 * "not recorded", which is a fifth state and is not NOT_RUN.
 */
export function parseNotRun(
  errorMessage: string | null | undefined,
): { kind: NotRunKind; why: string } | null {
  if (typeof errorMessage !== 'string') return null;
  const match = /^\[([A-Z_]+)\]\s*([\s\S]*)$/.exec(errorMessage);
  if (!match || !isNotRunKind(match[1])) return null;
  return { kind: match[1], why: (match[2] ?? '').trim() };
}

// ─── A run that could not be attempted ───────────────────────────────────────

/**
 * Opening words of `Run.errorMessage` on a run the environment made impossible.
 *
 * ── Why a prefix and not a sixth RunStatus ──────────────────────────────────
 *
 * `ENVIRONMENT_UNAVAILABLE` wants to be a run status, and it cannot be one yet:
 * `RunStatus` is a Postgres enum mirrored by `RUN_STATUSES`, and every consumer
 * of a run — the cockpit's badge, the CLI's exit code, the GitHub check's
 * conclusion, the JUnit writer, `TERMINAL_RUN_STATUSES`, the monitor streak —
 * switches on it exhaustively. A sixth member would be a value all of them
 * accept from the database and none of them can render, which is the drift this
 * repo's enum guard exists to prevent.
 *
 * So the STATUS is ERRORED, which already means exactly "the run did not
 * finish, so nothing was measured" and already answers `passed: false` — not a
 * green build and not a red one — and the KIND rides on `errorMessage`, the way
 * `FLAKE_RUN_PREFIX` rides on `Run.triggeredBy` and
 * `AUTO_QUARANTINE_REASON_PREFIX` on `Test.quarantineReason`. The sentence
 * after the prefix is complete English, so a surface that has never heard of
 * the prefix still shows a reader something true.
 *
 * What this costs, stated plainly: an ENVIRONMENT_UNAVAILABLE run cannot be
 * FILTERED in SQL and cannot be counted on a dashboard, because a prefix on a
 * free-text column is not a queryable fact. If either of those is wanted, the
 * answer is the enum member and its migration, not a LIKE query.
 */
export const ENVIRONMENT_UNAVAILABLE_PREFIX = 'ENVIRONMENT_UNAVAILABLE:';

/** The `Run.errorMessage` for a run nothing could be attempted in. */
export function environmentUnavailableMessage(reason: string): string {
  return `${ENVIRONMENT_UNAVAILABLE_PREFIX} ${reason}`;
}

/**
 * The reason, when this run's failure was the environment's — else null.
 *
 * Returns the sentence rather than a boolean so a caller that wants to say WHY
 * does not have to re-derive it by slicing the prefix off itself.
 */
export function environmentUnavailableReason(
  errorMessage: string | null | undefined,
): string | null {
  if (typeof errorMessage !== 'string') return null;
  if (!errorMessage.startsWith(ENVIRONMENT_UNAVAILABLE_PREFIX)) return null;
  return errorMessage.slice(ENVIRONMENT_UNAVAILABLE_PREFIX.length).trim();
}

// ─── Org & access (§1) ───────────────────────────────────────────────────────

export const ORG_ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Higher number = strictly more capable. Used by `requireRole`. */
export const ROLE_RANK: Record<OrgRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

/**
 * WHAT CHOSE THE TESTS IN A RUN. Stored by `Run.selectionSource` as TEXT.
 *
 * ── WHY A GATE NEEDS THIS, AND WHAT GOES WRONG WITHOUT IT ───────────────────
 *
 * A MIN_PASS_RATE gate over an impact-selected run of 11 tests computes 100%.
 * The web app's run page and the GitHub check both rendered that as a pass — a
 * suite-wide claim made from a sliver of the suite, on the one surface where a
 * pull request is actually gated. The CLI and the Action withhold it today
 * because they know what they asked for; the server could not, because the
 * selection chose the tests and was then discarded.
 *
 * NULL IS NOT `FULL_SUITE`. A run written before the column existed was not
 * necessarily a full-suite run, so a reader must render null as "selection
 * unknown" and must not let a gate claim a suite-wide pass from it.
 *
 * TEXT and not a Prisma enum, the decision `PullRequestRecord.purpose` records:
 * a sixth selection mode should be a feature, not a migration plus a deploy.
 * This list is the domain, and the zod schema that writes the column is built
 * from it — so the two cannot disagree.
 */
export const RUN_SELECTION_SOURCES = [
  /** Everything in the project (or in the named suite's full membership). */
  'FULL_SUITE',
  /** Chosen by impact analysis from a diff. A gate over this is not suite-wide. */
  'IMPACT',
  /** Only the failures of an earlier run. Says nothing about the rest. */
  'RERUN_FAILURES',
  /** One suite of several. Suite-wide, not project-wide. */
  'SUITE',
  /** A list of test ids the caller named. */
  'EXPLICIT',
] as const;
export type RunSelectionSource = (typeof RUN_SELECTION_SOURCES)[number];

/** Whether a selection can carry a claim about the WHOLE suite. */
export const SUITE_WIDE_SELECTIONS: readonly RunSelectionSource[] = ['FULL_SUITE'];

/**
 * WHERE AN OWNERSHIP RULE CAME FROM. Stored by `OwnershipRule.source` as TEXT.
 *
 * `OwnerProvenance.CODEOWNERS_IMPORT` is deliberately WEAKER than `RULE_PATH`,
 * because an imported catch-all glob should not page anybody at 3am. Without
 * this column that distinction could never be reported and every imported rule
 * claimed the strength of a deliberate human assignment.
 *
 * Null means MANUAL for rules written before the column existed, which is true
 * — there was no importer — and is still not back-filled, because a back-fill
 * would assert MANUAL about rows nobody can check.
 */
export const OWNERSHIP_RULE_SOURCES = ['MANUAL', 'CODEOWNERS'] as const;
export type OwnershipRuleSource = (typeof OWNERSHIP_RULE_SOURCES)[number];

export const ENVIRONMENT_KINDS = ['LOCAL', 'PREVIEW', 'STAGING', 'PRODUCTION'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

/**
 * EVERY THIRD-PARTY SYSTEM QAAI TALKS TO. Mirrors Prisma `IntegrationKind`.
 *
 * ── WHY THIS EXISTS ALONGSIDE THE FOUR LISTS BELOW ──────────────────────────
 *
 * The four lists under it — GIT_, GRID_, VISUAL_, CHAT_ — are CAPABILITY lists:
 * each one answers "what can QAAI actually do with this kind?", and a member is
 * absent from them on purpose when no code path can deliver to it (PAGERDUTY's
 * comment below is the worked example). Their union is 15 of the enum's 18
 * members, so JIRA, LINEAR and PAGERDUTY were in no list at all.
 *
 * This one is the STORAGE mirror: what the column can hold. Three columns store
 * `IntegrationKind` — `Integration.kind`, `TrackerIssue.provider` and
 * `PullRequestRecord.provider` — and until this list existed there was no
 * complete TypeScript name for any of them, so `check-enums` could not pair the
 * enum and nothing would have caught a member added to the schema and never
 * mentioned in the code. The enum naming the two trackers QAAI files tickets
 * into had three members TypeScript could not say out loud.
 *
 * So the two kinds of list answer different questions and both are needed. A
 * capability list says what works; this one says what is legal to store. Adding
 * a member here does NOT make it creatable — the creation paths validate
 * against the capability lists, which is the behaviour that was already right.
 */
export const INTEGRATION_KINDS = [
  'GITHUB',
  'GITLAB',
  'BITBUCKET',
  'BROWSERSTACK',
  'SAUCE_LABS',
  'LAMBDATEST',
  'PERFECTO',
  'APPLITOOLS',
  'PERCY',
  'CHROMATIC',
  'SLACK',
  'MSTEAMS',
  'DISCORD',
  'JIRA',
  'LINEAR',
  'PAGERDUTY',
  'WEBHOOK',
] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/** The git providers QAAI can push a materialised repo to (token-based). */
export const GIT_INTEGRATION_KINDS = ['GITHUB', 'GITLAB', 'BITBUCKET'] as const;
export type GitIntegrationKind = (typeof GIT_INTEGRATION_KINDS)[number];

/**
 * Cloud browser grids. A run can execute against one of these instead of the
 * worker's local browser — same tests, someone else's Windows/Safari/device farm.
 */
export const GRID_INTEGRATION_KINDS = [
  'BROWSERSTACK',
  'SAUCE_LABS',
  'LAMBDATEST',
  'PERFECTO',
] as const;
export type GridIntegrationKind = (typeof GRID_INTEGRATION_KINDS)[number];

/** Managed visual-diff services, as an alternative to QAAI's own baselines. */
export const VISUAL_INTEGRATION_KINDS = ['APPLITOOLS', 'PERCY', 'CHROMATIC'] as const;
export type VisualIntegrationKind = (typeof VISUAL_INTEGRATION_KINDS)[number];

/**
 * Chat and webhook destinations — where run notifications and the digest go
 * (§7). All four are a single HTTPS POST to an incoming-webhook URL; the URL is
 * the credential and lives sealed in the vault, never in `Integration.config`.
 *
 * PAGERDUTY is in the Prisma enum but deliberately NOT here: it is not an
 * incoming-webhook POST (it is the Events API v2 — routing keys, severities,
 * dedup keys — plus an on-call expectation this notification pipeline does not
 * meet), and nothing in the worker can deliver to it. Making it creatable would
 * mint an integration that silently never fires. It joins this list when a
 * delivery path exists.
 */
export const CHAT_INTEGRATION_KINDS = ['SLACK', 'MSTEAMS', 'DISCORD', 'WEBHOOK'] as const;
export type ChatIntegrationKind = (typeof CHAT_INTEGRATION_KINDS)[number];

/**
 * Per-integration notification preference for `run.finished` (§7).
 *
 *   off       — this channel hears nothing about runs
 *   failures  — failing runs only (the default; a green run is not news)
 *   all       — every finished run, green included
 */
export const RUN_FINISHED_PREFS = ['off', 'failures', 'all'] as const;
export type RunFinishedPref = (typeof RUN_FINISHED_PREFS)[number];

/**
 * A test whose `filePath` starts with this is treated as test data, not a test:
 * excluded from run selection and the flake radar, materialised into the run
 * workspace so specs can read it. Reuses the Test row so no new model is needed.
 */
export const FIXTURE_PREFIX = 'fixtures/';

/**
 * `AgentProposal.conversationId` prefix for inline edits. That column has no
 * foreign key, so it doubles as a namespace — inline edits are transient and
 * must not appear in the copilot's proposal inbox.
 */
export const INLINE_EDIT_PREFIX = 'inline:';

/**
 * How QAAI signs in (§2 auth profiles).
 *
 * ── The three that were missing, and the class of customer each one is ──────
 *
 * Five of these existed and `signInWithProfile` in packages/runner/src/login.ts
 * honoured three of them, answering the other two with "needs the mail catcher
 * / TOTP support that is not built yet". So the list was already longer than
 * the login module, and an application whose only way in is harder than a form
 * had ZERO enumerable authenticated surface — not a small number, zero, and
 * reported as an application with very little behind the wall.
 *
 *   PASSKEY     a WebAuthn-only login. There is no password to type at all, so
 *               no amount of FORM_LOGIN configuration reaches it.
 *   PHONE_OTP   a code sent to a phone. Reachable only through a sink the
 *               customer owns, which is why the config names one.
 *   MOCK_IDP    an SSO-fronted application. Also the only kind that can choose
 *               a ROLE — the claims it mints are what makes an admin crawl and
 *               a member crawl two different crawls.
 *
 * ── Why TOTP_MFA is not renamed to TOTP ─────────────────────────────────────
 *
 * It is a stored Postgres enum member. Renaming it is a data migration over
 * every profile row and a rename in every switch that reads one, bought for
 * four characters. MAGIC_LINK is left alone for the same reason. The defect was
 * never the spelling — it was that both kinds were storable and unperformable.
 *
 * ── What a new member obliges you to do ─────────────────────────────────────
 *
 * Adding one here breaks three lines in `auth-profiles.ts` on purpose:
 * `AUTH_PROFILE_CONFIG_SCHEMAS` (so it cannot be stored unvalidated),
 * `AUTH_PROFILE_CAPABILITIES` (so it cannot be attempted with no adapter) and
 * `AUTH_PROFILE_KIND_LABELS` (so it cannot be offered unnamed). That is
 * deliberate: eight `GateRule` kinds shipped unsaveable for two slices because
 * a union grew and its write path did not, and `check:wiring` cannot see that
 * class of break.
 */
export const AUTH_PROFILE_KINDS = [
  'FORM_LOGIN',
  'MAGIC_LINK',
  'SSO_BYPASS_TOKEN',
  'COOKIE_INJECTION',
  'TOTP_MFA',
  'PASSKEY',
  'PHONE_OTP',
  'MOCK_IDP',
] as const;
export type AuthProfileKind = (typeof AUTH_PROFILE_KINDS)[number];

// ─── Re-enumerating, and noticing that the application changed ──────────────

/**
 * What can cause the surface to be enumerated again.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * The only crawl trigger in this product is a human clicking a button. A
 * `Schedule` and a `Monitor` both exist and both can only run a SUITE, so the
 * DENOMINATOR goes stale on its own: the application grows four routes, nothing
 * re-enumerates, and the coverage percentage RISES because the numerator is
 * unchanged and the denominator is the one we measured in March. That is the
 * worst possible failure for a product whose entire claim is the denominator,
 * because it fails silently and in the flattering direction.
 *
 *   SCHEDULE  a cron expression, on the environment's clock.
 *   CI        a build asked, so the enumeration is of the commit under test.
 *   DEPLOY    a webhook from whatever actually ships the application. The one
 *             trigger that fires at the moment the surface changes.
 *   MANUAL    a person clicked. Kept as a member rather than left implicit, so
 *             "nothing is scheduled" and "somebody ran it by hand in March" are
 *             different rows rather than the same absence.
 */
export const RE_ENUMERATION_TRIGGER_KINDS = ['SCHEDULE', 'CI', 'DEPLOY', 'MANUAL'] as const;
export type ReEnumerationTriggerKind = (typeof RE_ENUMERATION_TRIGGER_KINDS)[number];

/**
 * How a trigger's last run went.
 *
 * NEVER_RUN is the default on insert and the reason this is an enum rather than
 * a nullable timestamp. A trigger that has never fired must read as NEVER_RUN,
 * never as "no drift" — those are opposite claims, and a dashboard that renders
 * a null `lastRunAt` as a clean bill of health is the exact lie. SKIPPED is
 * separate from SUCCEEDED because a run the policy or a lock declined is not a
 * run that enumerated anything.
 */
export const RE_ENUMERATION_RUN_STATES = [
  'NEVER_RUN',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
] as const;
export type ReEnumerationRunState = (typeof RE_ENUMERATION_RUN_STATES)[number];

/** Whether this trigger has ever actually produced an enumeration. */
export function triggerHasRun(state: ReEnumerationRunState): boolean {
  return state !== 'NEVER_RUN';
}

/**
 * Whether two crawls could be compared at all.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * `FlowMap.version` exists, the cockpit offers to show what changed, and NO
 * DIFF CODE EXISTS anywhere in the repo. So four new routes with zero tests
 * produce no event at all — the one number anyone acts on is not computed, and
 * the screen that implies it was is a doc comment contradicting the code under
 * it.
 *
 * ── Why "no drift" needs three different ways of being unsayable ────────────
 *
 *   COMPARABLE                        two accepted maps, diffed. The counts
 *                                     mean what they say.
 *   UNCOMPARABLE_NO_BASELINE          the first crawl of an environment. Every
 *                                     route is "new", which is true and
 *                                     useless, so the counts are NULL rather
 *                                     than a number that would be reported as
 *                                     a drift event on day one.
 *   UNCOMPARABLE_BASELINE_NOT_ACCEPTED the previous map is a CANDIDATE or
 *                                     REJECTED crawl. Diffing against a
 *                                     degraded crawl invents routes that were
 *                                     merely missed, which would page somebody
 *                                     about an outage they already had.
 *   NOT_COMPARED                      the comparison did not run. The state
 *                                     that stops "no drift since the last
 *                                     crawl" from being claimed by a code path
 *                                     that never looked.
 *
 * Only the first makes the counts meaningful, which is what
 * {@link driftCountsAreMeaningful} is for; the other three are each a reason,
 * and a reader renders the reason instead of a zero.
 */
export const SURFACE_DRIFT_COMPARABILITIES = [
  'COMPARABLE',
  'UNCOMPARABLE_NO_BASELINE',
  'UNCOMPARABLE_BASELINE_NOT_ACCEPTED',
  'NOT_COMPARED',
] as const;
export type SurfaceDriftComparability = (typeof SURFACE_DRIFT_COMPARABILITIES)[number];

/** Whether a drift record's counts are a measurement rather than an absence. */
export function driftCountsAreMeaningful(state: SurfaceDriftComparability): boolean {
  return state === 'COMPARABLE';
}

/**
 * The only drift number anyone acts on, or null when it was not measured.
 *
 * NULL AND NOT ZERO, in every case where the diff did not run or could not.
 * Zero is the most expensive possible wrong answer here: it is the value that
 * means "nothing new is untested", it is what a dashboard renders as a green
 * tick, and it is indistinguishable from "we never looked" once it has been
 * written to a column. A null forces the caller to render the comparability
 * reason, which is the sentence the customer needed.
 *
 * It also refuses a row that claims COMPARABLE and carries no count, because
 * that row is a bug in the writer and reporting it as 0 would hide the bug
 * behind a green tick.
 */
export function newSurfaceWithoutTests(record: {
  comparability: SurfaceDriftComparability;
  newSurfaceWithoutTests: number | null;
}): number | null {
  if (!driftCountsAreMeaningful(record.comparability)) return null;
  return record.newSurfaceWithoutTests;
}

// ─── Plans & limits (§9) ─────────────────────────────────────────────────────

export const PLANS = ['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE'] as const;
export type Plan = (typeof PLANS)[number];

export interface PlanLimits {
  readonly label: string;
  readonly monthlyPriceUsd: number | null; // null = contact sales
  readonly maxProjects: number;
  /** null = unlimited. The Team plan's unlimited CI runs is the differentiator (§9). */
  readonly maxRunsPerMonth: number | null;
  readonly maxParallelWorkers: number;
  readonly artifactRetentionDays: number;
  readonly sso: boolean;
  readonly auditLog: boolean;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE: {
    label: 'Free',
    monthlyPriceUsd: 0,
    maxProjects: 1,
    maxRunsPerMonth: 100,
    maxParallelWorkers: 1,
    artifactRetentionDays: 7,
    sso: false,
    auditLog: false,
  },
  TEAM: {
    label: 'Team',
    monthlyPriceUsd: 349,
    maxProjects: 3,
    maxRunsPerMonth: null,
    maxParallelWorkers: 5,
    artifactRetentionDays: 30,
    sso: false,
    auditLog: false,
  },
  BUSINESS: {
    label: 'Business',
    monthlyPriceUsd: 999,
    maxProjects: 10,
    maxRunsPerMonth: null,
    maxParallelWorkers: 15,
    artifactRetentionDays: 90,
    sso: true,
    auditLog: true,
  },
  ENTERPRISE: {
    label: 'Enterprise',
    monthlyPriceUsd: null,
    maxProjects: Number.MAX_SAFE_INTEGER,
    maxRunsPerMonth: null,
    maxParallelWorkers: 50,
    artifactRetentionDays: 365,
    sso: true,
    auditLog: true,
  },
};

// ─── Priority (§3.1) ─────────────────────────────────────────────────────────

export const PRIORITIES = ['CRITICAL_PATH', 'IMPORTANT', 'NICE_TO_HAVE'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  CRITICAL_PATH: 'Critical path',
  IMPORTANT: 'Important',
  NICE_TO_HAVE: 'Nice to have',
};

// ─── Languages & frameworks (§7b) ────────────────────────────────────────────

export const LANGUAGES = [
  'TYPESCRIPT',
  'JAVASCRIPT',
  'JAVA',
  'PYTHON',
  'CSHARP',
  'RUBY',
  'KOTLIN',
  'GO',
  'PHP',
] as const;
export type Language = (typeof LANGUAGES)[number];

export const UI_FRAMEWORKS = [
  'PLAYWRIGHT',
  'CYPRESS',
  'WEBDRIVERIO',
  'PUPPETEER',
  'NIGHTWATCH',
  'TESTCAFE',
  'SELENIUM',
  'CAPYBARA',
  'PANTHER',
  'CODECEPTION',
  'CHROMEDP',
  'APPIUM',
  'MAESTRO',
  'DETOX',
  'ESPRESSO',
  'XCUITEST',
] as const;
export type UiFramework = (typeof UI_FRAMEWORKS)[number];

/**
 * Which UI frameworks the generator can emit for a given language (§7b).
 * The first entry is the default when a project picks the language.
 */
export const FRAMEWORKS_BY_LANGUAGE: Record<Language, readonly UiFramework[]> = {
  TYPESCRIPT: ['PLAYWRIGHT', 'CYPRESS', 'WEBDRIVERIO', 'PUPPETEER', 'NIGHTWATCH', 'TESTCAFE'],
  JAVASCRIPT: ['PLAYWRIGHT', 'CYPRESS', 'WEBDRIVERIO', 'PUPPETEER', 'NIGHTWATCH', 'TESTCAFE'],
  JAVA: ['PLAYWRIGHT', 'SELENIUM', 'APPIUM'],
  PYTHON: ['PLAYWRIGHT', 'SELENIUM', 'APPIUM'],
  CSHARP: ['PLAYWRIGHT', 'SELENIUM'],
  RUBY: ['CAPYBARA', 'SELENIUM'],
  KOTLIN: ['PLAYWRIGHT', 'SELENIUM', 'ESPRESSO'],
  GO: ['PLAYWRIGHT', 'CHROMEDP'],
  PHP: ['PANTHER', 'CODECEPTION'],
};

/**
 * Human labels for the language dropdown. The enum spelling is a database
 * value, not a word anyone writes — "CSHARP" and "TYPESCRIPT" belong in a
 * payload, never on a form.
 */
export const LANGUAGE_LABELS: Record<Language, string> = {
  TYPESCRIPT: 'TypeScript',
  JAVASCRIPT: 'JavaScript',
  JAVA: 'Java',
  PYTHON: 'Python',
  CSHARP: 'C#',
  RUBY: 'Ruby',
  KOTLIN: 'Kotlin',
  GO: 'Go',
  PHP: 'PHP',
};

/** Ditto for the framework dropdown, which the pair rule filters per language. */
export const UI_FRAMEWORK_LABELS: Record<UiFramework, string> = {
  PLAYWRIGHT: 'Playwright',
  CYPRESS: 'Cypress',
  WEBDRIVERIO: 'WebdriverIO',
  PUPPETEER: 'Puppeteer',
  NIGHTWATCH: 'Nightwatch',
  TESTCAFE: 'TestCafe',
  SELENIUM: 'Selenium',
  CAPYBARA: 'Capybara',
  PANTHER: 'Panther',
  CODECEPTION: 'Codeception',
  CHROMEDP: 'chromedp',
  APPIUM: 'Appium',
  MAESTRO: 'Maestro',
  DETOX: 'Detox',
  ESPRESSO: 'Espresso',
  XCUITEST: 'XCUITest',
};

/**
 * Whether the generator can emit this framework for this language.
 *
 * One implementation, because there are now four callers who must agree:
 * `createProjectSchema` and `updateProjectSchema` reject the pair, the PATCH
 * route re-checks the MERGED pair (a request that changes only the language
 * can invalidate a framework the request never mentions), and the first-run
 * funnel filters its own dropdown so it cannot offer what the API will refuse.
 * The bug this closes was live: the funnel's own list offered Selenium, the
 * schema defaulted the language to TypeScript, and the pair rule rejected it —
 * so one of three options on the product's first screen could not be submitted.
 */
export function isSupportedPair(language: Language, framework: UiFramework): boolean {
  return FRAMEWORKS_BY_LANGUAGE[language].includes(framework);
}

/** The pair rule's own answer to "then what should I pick?" — never undefined. */
export function defaultFrameworkFor(language: Language): UiFramework {
  return FRAMEWORKS_BY_LANGUAGE[language][0]!;
}

/** The refusal, worded once, so create and update do not explain it differently. */
export function pairMessage(language: Language, framework: UiFramework): string {
  return (
    `${framework} is not available for ${language}. ` +
    `Choose one of: ${FRAMEWORKS_BY_LANGUAGE[language].join(', ')}`
  );
}

// ─── Flake automation (§5) ───────────────────────────────────────────────────

/**
 * `Run.triggeredBy` on a flake-confirmation re-run, followed by
 * `<testId>:<investigationId>`.
 *
 * A confirmation re-run is a real run — same environment, same plugin, same
 * retries — because a rate measured through a shadow execution path is a
 * measurement of the shadow path. The marker is how everything downstream can
 * tell "QAAI re-ran this ten times to measure it" from "a person asked for a
 * run", and it is a string rather than a RunTrigger member so it needed no
 * enum migration.
 */
export const FLAKE_RUN_PREFIX = 'flake-radar:';

/** True for a run the flake radar created to measure a suspected flake. */
export function isFlakeConfirmationRun(triggeredBy: string | null | undefined): boolean {
  return typeof triggeredBy === 'string' && triggeredBy.startsWith(FLAKE_RUN_PREFIX);
}

/**
 * `heal-verify:<healProposalId>` — the whole verification, in a string.
 *
 * The same trick as `FLAKE_RUN_PREFIX` above and for the same reason: a
 * verification needs no table of its own. It IS a Run row tagged with what it
 * is for, so it survives a worker restart, it is visible in the cockpit like
 * any other run, and a human can cancel it.
 *
 * Beside its neighbour because both its writers — the API's heal-approval route
 * and the worker's verification sweep — are in different packages, and a run
 * marker read in one package and written in another is the definition of a
 * shared constant. It lived in packages/agent/src/healer.ts, which meant the
 * API imported an agent module to borrow one string.
 */
export const HEAL_VERIFY_RUN_PREFIX = 'heal-verify:';

/**
 * Audit actions the heal lane writes — the only record its sweeps leave.
 *
 * Beside `FLAKE_AUDIT_ACTIONS` for the same reason that list is here: the
 * worker writes these rows and the audit-log reader renders them, so an action
 * string that lived in a worker PROCESSOR could not be named by the surface
 * that displays it without importing the processor.
 *
 * `unverifiable` is its own action and not a flavour of `verificationFailed`:
 * "applied, and nobody could check" must never be able to read as either a
 * pass or a failure.
 */
export const HEAL_AUDIT_ACTIONS = {
  deflakeProposed: 'heal.deflake.proposed',
  deflakeUnfixable: 'heal.deflake.unfixable',
  verified: 'heal.verified',
  verificationFailed: 'heal.verification.failed',
  unverifiable: 'heal.verification.unverifiable',
  reverted: 'heal.reverted',
  retirementProposed: 'heal.retirement.proposed',
  driftChecked: 'project.drift.checked',
} as const;
export type HealAuditAction = (typeof HEAL_AUDIT_ACTIONS)[keyof typeof HEAL_AUDIT_ACTIONS];

/**
 * Opening words of every machine-written `Test.quarantineReason`.
 *
 * Auto-release reads this: only a quarantine QAAI can prove it wrote is one
 * QAAI may lift. A reason it does not recognise belongs to a person, and a
 * person's decision is not ours to undo.
 */
export const AUTO_QUARANTINE_REASON_PREFIX = 'Auto-quarantined';

/**
 * Audit actions the flake automation writes. Every decision gets one — including
 * the decision to do nothing — because the row IS the record that an
 * investigation concluded, and because a human who disagrees needs to see the
 * measurement that convinced the machine.
 */
export const FLAKE_AUDIT_ACTIONS = {
  quarantined: 'test.flake.quarantined',
  released: 'test.flake.released',
  measured: 'test.flake.measured',
  abandoned: 'test.flake.abandoned',
} as const;
export type FlakeAuditAction = (typeof FLAKE_AUDIT_ACTIONS)[keyof typeof FLAKE_AUDIT_ACTIONS];

/** What the quarantine endpoint writes when a person flips the switch by hand. */
export const MANUAL_QUARANTINE_ACTIONS = ['test.quarantine', 'test.unquarantine'] as const;

/**
 * Per-project flake automation policy (§5).
 *
 * Every default here leans the same way: an auto-quarantined test stops gating,
 * so the expensive mistake is quarantining a test that was catching a real
 * intermittent bug — a green board over a broken build. Hence a measured rate
 * over a real sample, a REAL_BUG veto, and critical-path tests left alone.
 */
export interface FlakePolicy {
  /** Master switch. Off means suspicions are never even measured. */
  readonly confirm: boolean;
  /** How many re-runs an investigation attempts. */
  readonly samples: number;
  /** How many of those must yield a usable result before ANY action is taken. */
  readonly minSamples: number;
  readonly autoQuarantine: boolean;
  /** Measured failure rate must be strictly above this to quarantine. */
  readonly quarantineRatePercent: number;
  readonly autoRelease: boolean;
  /** Measured failure rate must be at or below this to release. */
  readonly releaseRatePercent: number;
  /** Never auto-quarantine a CRITICAL_PATH test; ask a human instead. */
  readonly protectCriticalPath: boolean;
  /** A REAL_BUG verdict this recent vetoes a quarantine outright. */
  readonly realBugLookbackDays: number;
  /** How long a quarantined test waits before it is re-measured for release. */
  readonly recheckQuarantinedAfterHours: number;
  /** Cooldown before the same test may be investigated again. */
  readonly reinvestigateAfterHours: number;
  /** Yield: no confirmation run is queued while the project has this many waiting. */
  readonly maxQueuedRunsBeforeYielding: number;
  /** An investigation that has not finished in this long is abandoned. */
  readonly investigationDeadlineMinutes: number;
}

export const FLAKE_POLICY_DEFAULTS: FlakePolicy = {
  confirm: true,
  samples: 10,
  minSamples: 8,
  autoQuarantine: true,
  quarantineRatePercent: 30,
  autoRelease: true,
  releaseRatePercent: 5,
  protectCriticalPath: true,
  realBugLookbackDays: 30,
  recheckQuarantinedAfterHours: 24,
  reinvestigateAfterHours: 24,
  maxQueuedRunsBeforeYielding: 3,
  investigationDeadlineMinutes: 360,
};

function flakeNumber(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function flakeBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

/**
 * Merge a stored per-project override onto the defaults, clamping every field.
 *
 * Never throws and never trusts: the input is JSON from a settings screen, and
 * a policy that cannot be parsed must resolve to the conservative default
 * rather than to zero — `minSamples: 0` would quarantine on no evidence at all,
 * which is the one outcome this whole module exists to prevent.
 */
export function resolveFlakePolicy(raw: unknown): FlakePolicy {
  const d = FLAKE_POLICY_DEFAULTS;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return d;
  const o = raw as Record<string, unknown>;

  const samples = flakeNumber(o.samples, d.samples, 3, 25);
  const quarantineRatePercent = flakeNumber(
    o.quarantineRatePercent,
    d.quarantineRatePercent,
    1,
    100,
  );

  return {
    confirm: flakeBoolean(o.confirm, d.confirm),
    samples,
    // Evidence can never be allowed to exceed what the investigation collects,
    // or the policy asks for proof it has no way of producing.
    minSamples: Math.min(
      samples,
      flakeNumber(o.minSamples, Math.min(d.minSamples, samples), 2, 25),
    ),
    autoQuarantine: flakeBoolean(o.autoQuarantine, d.autoQuarantine),
    quarantineRatePercent,
    autoRelease: flakeBoolean(o.autoRelease, d.autoRelease),
    // A release bar above the quarantine bar would quarantine and release the
    // same measurement forever.
    releaseRatePercent: Math.min(
      quarantineRatePercent,
      flakeNumber(o.releaseRatePercent, d.releaseRatePercent, 0, 100),
    ),
    protectCriticalPath: flakeBoolean(o.protectCriticalPath, d.protectCriticalPath),
    realBugLookbackDays: flakeNumber(o.realBugLookbackDays, d.realBugLookbackDays, 0, 365),
    recheckQuarantinedAfterHours: flakeNumber(
      o.recheckQuarantinedAfterHours,
      d.recheckQuarantinedAfterHours,
      1,
      24 * 30,
    ),
    reinvestigateAfterHours: flakeNumber(
      o.reinvestigateAfterHours,
      d.reinvestigateAfterHours,
      1,
      24 * 30,
    ),
    maxQueuedRunsBeforeYielding: flakeNumber(
      o.maxQueuedRunsBeforeYielding,
      d.maxQueuedRunsBeforeYielding,
      0,
      1000,
    ),
    investigationDeadlineMinutes: flakeNumber(
      o.investigationDeadlineMinutes,
      d.investigationDeadlineMinutes,
      5,
      24 * 60,
    ),
  };
}

// ─── Queues (§5) ─────────────────────────────────────────────────────────────

export const QUEUE_NAMES = {
  run: 'qaai.run',
  explore: 'qaai.explore',
  generate: 'qaai.generate',
  triage: 'qaai.triage',
  copilot: 'qaai.copilot',
  edit: 'qaai.edit',
  import: 'qaai.import',
  schedule: 'qaai.schedule',
  notify: 'qaai.notify',
  flake: 'qaai.flake',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ─── Misc ────────────────────────────────────────────────────────────────────

/** Redacted stand-in written wherever a secret would otherwise be serialised (§1). */
export const SECRET_MASK = '••••••••';

/**
 * How many `SuppressionEvent` rows one ledger read scans.
 *
 * ── ONE DEFINITION, BECAUSE TWO SURFACES REPORT THE SAME TOTAL ─────────────
 *
 * The run finaliser (apps/worker/src/processors/run.ts) and the run read
 * (apps/api/src/routes/runs.ts) each had their own literal at this value, and
 * `runs.test.ts` pins the two against each other on every terminal run — so
 * the day one of them moved, one surface would report a different number of
 * silenced failures for one run and the test would be the only thing that knew.
 *
 * It is a DISCLOSURE, not a gate: both readers take `cap + 1`, report the
 * truncation as a count AND a reason, and say the totals are a FLOOR. A cap
 * that bit without being disclosed is one of the lies this product cannot
 * ship — and on this surface it would be a failure suppressed without being
 * counted.
 */
export const SUPPRESSION_LEDGER_SCAN_CAP = 2_000;

/** Prefix on every API key so leak-scanners can pattern-match it. */
export const API_KEY_PREFIX = 'qaai_';

// ─── Security controls and their rollout brakes (§1) ─────────────────────────
//
// ── WHY THERE IS A TABLE AND NOT THIRTEEN CONSTANTS IN THIRTEEN FILES ───────
//
// Every control in this round changes behaviour for a deployment that is
// working today. Three of them would stop traffic that is legitimate: scoping
// secrets per test takes env vars away from tests that have always received
// them, enforcing email verification locks out a user base in which NOTHING has
// ever written `User.emailVerified`, and a strict CSP breaks a cockpit that was
// written without one. The other ten close a hole and break nothing.
//
// A brake is only a brake if its default is discoverable and its OBSERVE mode
// COUNTS what it would have refused. A mode with no counter is an off switch
// with a reassuring name, and this product has shipped one of those before.
//
// ── WHY A ROW AND NOT AN ENVIRONMENT VARIABLE ───────────────────────────────
//
// Same argument `Environment.crawlPolicy` records: an env var arms one answer
// for every org and every environment in the install at once, which is the
// opposite of a brake, and `scripts/check-wiring.ts` refuses one. The stored
// value lives on `Organization.securityControlModes` (per org) and, for egress,
// on `Environment.egressPolicy` (per environment, because a seeded throwaway
// and a production site want opposite answers).

/** OBSERVE counts what ENFORCE would have refused. Nothing else. */
export const CONTROL_MODES = ['OBSERVE', 'ENFORCE'] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];

/**
 * The controls this round builds, one name each.
 *
 * Five agents build against this list in parallel, which is the whole reason it
 * is one list: two spellings of "the egress control" is two counters, two
 * stored modes and two answers to "is it on".
 *
 * `CSRF_TOKEN` and `CONTENT_SECURITY_POLICY` are members although neither is a
 * refusal made in our own code — both are refusals made by the BROWSER on our
 * instructions, and both still need a mode, a default and a count, because a
 * CSP delivered report-only IS observe mode and is useless unless somebody
 * reads the reports.
 */
export const SECURITY_CONTROLS = [
  'EGRESS_CLASSIFICATION',
  'SESSION_STATE_SEAL',
  'VAULT_KEY_ROTATION',
  'SECRET_TEST_SCOPING',
  'TOTP_VERIFICATION',
  'LOGIN_THROTTLE',
  'SESSION_REVOCATION',
  'EMAIL_VERIFICATION',
  'API_KEY_SCOPE',
  'ROLE_RANK_GUARD',
  'ENFORCE_SSO',
  'CSRF_TOKEN',
  'CONTENT_SECURITY_POLICY',
] as const;
export type SecurityControl = (typeof SECURITY_CONTROLS)[number];

/** What one control's brake is set to out of the box, and what each mode costs. */
export interface SecurityControlBrake {
  /**
   * The mode when nothing has been stored. ENFORCE unless enforcing would stop
   * traffic that is legitimate today — see the three OBSERVE entries, each of
   * which names the traffic.
   */
  readonly fallback: ControlMode;
  /** What ENFORCE could break in a working deployment. 'nothing' is a claim, so it is spelt out. */
  readonly enforcingBreaks: string;
  /** What OBSERVE must COUNT. A mode with no counter is an off switch. */
  readonly observeCounts: string;
}

/**
 * The compiler-enforced presence record. A `Record<SecurityControl, …>` cannot
 * be written without naming every member, so a fourteenth control is a type
 * error here rather than a control with no default and no counter.
 *
 * Both halves, because one without the other passes while the two disagree:
 * this is the compile-time half, and `controlModeSchema.options` /
 * `securityControlSchema.options` in schemas.ts are the run-time half. Eight
 * `GateRule` kinds shipped UNSAVEABLE for two slices because only one existed.
 */
export const SECURITY_CONTROL_BRAKES = {
  EGRESS_CLASSIFICATION: {
    fallback: 'ENFORCE',
    enforcingBreaks:
      'Nothing legitimate. A self-hosted install reaches its own private hosts through the ' +
      'SELF_HOSTED deployment mode and the allowlist, NOT by turning the control off — so the ' +
      'escape for the customer who tests an internal app is a policy, not an OBSERVE.',
    observeCounts:
      'every connection that would have been refused, by context and by address class, so ' +
      '"we would have refused 1,204 connections" is answerable before anyone enforces.',
  },
  SESSION_STATE_SEAL: {
    fallback: 'ENFORCE',
    /*
     * ── THIS SENTENCE SAID "Nothing, by construction" AND THAT WAS FALSE ────
     *
     * It claimed "the first run after it signs in again", and the run does not:
     * apps/worker/src/processors/run.ts resolves the DEFAULT identity without
     * ever driving a login, so a profile the refresh sweep has sealed and
     * nulled used to leave that path with no session and the suite ran
     * ANONYMOUSLY — the exact defect the control was minted to end, caused by
     * the control. A doc comment that contradicts the code under it is the
     * worst kind of defect in a security file, because the comment is what the
     * next reviewer trusts instead of reading the code. Rewritten to say what
     * breaks now that both consumers open the sealed column.
     */
    enforcingBreaks:
      'Tests and crawls on a profile whose stored session this image cannot vouch for. ENFORCE ' +
      'is what lets the hourly sweep SEAL a session and NULL the plaintext column, and it is ' +
      'what turns an unopenable, expired, unversioned or re-seal-marked session into a typed ' +
      'BLOCKED_BY_ENV refusal instead of an anonymous pass that makes every auth-gated route ' +
      'look covered. Concretely: a run whose tests name no profile reports those tests FAILED ' +
      'rather than running them signed out, and a role crawl reports LOGIN_FAILED rather than ' +
      'enumerating the application as an anonymous visitor under that role\'s name. Every one of ' +
      'those states is on the refresh sweep\'s own worklist, so the refusal clears within an ' +
      'hour without an operator touching anything — except ABSENT, which the sweep skips on ' +
      'purpose because a profile that never had a session is new and not stale, and which is ' +
      'therefore the one state that is NOT refused: it carries no session today, it carried none ' +
      'before, and refusing it would be a brake nobody can release. ' +
      'OBSERVE, PRECISELY: it is the HOURLY SWEEP that honours the mode — under OBSERVE it leaves ' +
      'the plaintext column exactly as it is and writes a refreshed session into it the way every ' +
      'writer did before this control, and both consumers CARRY a valid plaintext session in ' +
      'either mode, so a deployment whose writers still produce plaintext goes on working. ' +
      'WHAT OBSERVE DOES NOT HOLD BACK is the cockpit sign-in route ' +
      '(apps/api/src/routes/projects.ts): it reads no mode and seals unconditionally, so a person ' +
      'pressing "Sign in" produces a SEALED row in both modes. That is deliberate — writing ' +
      'plaintext again would be the regression this control exists to end — and it is stated ' +
      'because the sentence this replaced implied the whole API half stayed on plaintext under ' +
      'OBSERVE, which it no longer does. The consequence an operator must know: on a deployment ' +
      'whose VaultKey table is unseeded, that route REFUSES to seal and discards the captured ' +
      'session rather than storing it in the clear, and OBSERVE does not release that — the ' +
      'refusal is reported on the response and in the audit row (`sealRefusal`) rather than ' +
      'being silent, and the remedy is to seed the key table, not to change the mode.',
    observeCounts:
      'every run that would have been reported NOT_RUN and instead went anonymous, per profile ' +
      'and per session state, beside how many were considered — and, in the sweep, every ' +
      'profile whose plaintext column a seal would have replaced, which is the worklist an ' +
      'operator reads before arming. THE TWO ARE SEPARATE BUCKETS and were not: both landed in ' +
      '`degraded`, so one number meant "runs that went anonymous" in the run and the crawl and ' +
      '"profiles a seal would replace" in the sweep. The run-side buckets now count WHAT THE ' +
      'CONSUMER DID rather than what the gate said, because the two disagree by design on three ' +
      'paths — a carried LEGACY_PLAINTEXT row, an ABSENT profile the run deliberately does not ' +
      'refuse, and a cache miss that drives a fresh login — and all three used to be reported as ' +
      'refused or degraded runs that in fact ran. See `SessionGateOutcome`.',
  },
  VAULT_KEY_ROTATION: {
    fallback: 'ENFORCE',
    enforcingBreaks:
      'Nothing. Version 1 keeps opening everything it opened before; what ENFORCE adds is that an ' +
      'UNKNOWN key version is a named refusal rather than a decrypt attempt.',
    observeCounts: 'every open attempted against a key version this deployment cannot name.',
  },
  SECRET_TEST_SCOPING: {
    // THE DANGEROUS ONE. Read the sentence below before arming it.
    fallback: 'OBSERVE',
    enforcingBreaks:
      'Every test in every existing install. Today all of an environment\'s decrypted secrets are ' +
      'injected into every test process, so no secret has a scope row and default-DENY means a ' +
      'suite that has always had its credentials suddenly has none. ENFORCE is safe only after ' +
      'the OBSERVE count has been read and scopes have been written.',
    observeCounts:
      'per test and per secret, every injection that default-DENY would have withheld — which is ' +
      'also the exact worklist for writing the scope rows.',
  },
  TOTP_VERIFICATION: {
    fallback: 'ENFORCE',
    enforcingBreaks:
      'Nothing, and the reason is a schema decision rather than a hope: a row with ' +
      '`totpEnabledAt` set and `totpConfirmedAt` null is treated as NOT ENROLLED, because the ' +
      'code was never checked at enrolment either, so such a user may hold a seed their ' +
      'authenticator never saw. That is the only reading that neither locks them out nor accepts ' +
      'an unverified second factor.',
    observeCounts:
      'every login that supplied a code which did not verify and was admitted anyway. This count ' +
      'is the size of the hole; it must not be left running.',
  },
  LOGIN_THROTTLE: {
    fallback: 'ENFORCE',
    enforcingBreaks:
      'A shared NAT or a CI job that signs in on every build can trip a per-identifier counter. ' +
      'The brake for that is the THRESHOLD, not the mode — so the mode defaults to ENFORCE and ' +
      'the thresholds are generous and stored beside the counter. ' +
      'AND ONE THING NEITHER MODE CONTROLS, named here because nobody owned it: `LoginThrottle` ' +
      'arrives in a hand-written migration, so between this code reaching a deployment and ' +
      '`prisma migrate deploy` running, the relation does not exist. MEASURED by driving the real ' +
      'router with that one relation answering P2021: login answered 500 FOR EVERY CALLER, which ' +
      'is fail-closed and a total outage at once. The read now tells a MISSING RELATION ' +
      '("this control is not installed") apart from an UNREADABLE one ("I cannot tell whether you ' +
      'are locked out") by Postgres\'s own error code: the first admits the login, and the second ' +
      'still answers 500, because an unreadable lock assumed open is the control being switched ' +
      'off by a dropped connection. The missing-relation window is NOT a mode an operator can ' +
      'set, it clears itself the moment the migration runs, and every login it admits is counted ' +
      'and logged AT ERROR naming the remedy.',
    observeCounts:
      'every attempt that would have been locked out, per identifier — and, independently of the ' +
      'mode, every login admitted while the relation was absent, as an audit row whose ' +
      '`wouldHaveRefused` is NULL rather than false, because nothing was read and a measured ' +
      'answer nobody measured is the lie this product cannot afford.',
  },
  SESSION_REVOCATION: {
    fallback: 'ENFORCE',
    /*
     * ── THIS SENTENCE SAID "no request path ever honoured it" AND THAT WAS
     *    FALSE, AND THE MODE HAS NO READER AT ALL ─────────────────────────────
     *
     * Both halves were wrong in the same direction — overstating a hole, which
     * in a security file is as damaging as hiding one, because the next
     * reviewer trusts the paragraph instead of reading the code.
     *
     * MEASURED: `apps/api/src/middleware/auth.ts` reads
     * `if (!session || session.revokedAt || session.expiresAt < new Date())
     * return null;` in `actorFromSession`, on EVERY request, and has since that
     * function was written. There is no token cache and no expiry window, so a
     * revocation is already immediate. apps/api/src/lib/sessions.ts's own
     * header records the same finding.
     *
     * And MEASURED the other way: grepping every workspace for this control
     * name finds NO production reader. The only other hits are
     * `AUTH_LIFECYCLE_FLOWS`, an unrelated vocabulary in packages/agent that
     * happens to share the spelling. So the mode changes nothing an operator
     * can observe and the `observeCounts` promise below was never kept — which
     * is rule 13's defect inverted: a brake nobody can arm.
     *
     * Left UNCONDITIONAL rather than given a reader. Honouring `revokedAt` is
     * not a behaviour change anybody needs to stage: it has been the behaviour
     * for as long as the column has been read, OBSERVE would mean serving
     * requests on sessions a customer has explicitly killed, and a brake whose
     * OBSERVE position is "ignore the revocation" is not an escape hatch, it is
     * an off switch for the feature. Said here instead of implied.
     */
    enforcingBreaks:
      'Nothing, and NOT because this mode is enforcing. `Session.revokedAt` is honoured ' +
      'unconditionally in `actorFromSession` (apps/api/src/middleware/auth.ts) on every request ' +
      'and has been since that function was written, so a revocation is already immediate. This ' +
      'control has NO production reader: setting it changes nothing. It is kept in the list ' +
      'because the vocabulary is persisted and removing a member is a migration, and it is ' +
      'documented as unconditional rather than left looking settable.',
    observeCounts:
      'NOTHING, and that is the honest answer rather than an unkept promise: there is no reader, ' +
      'so there is no decision to count. An OBSERVE here would have to mean serving requests on ' +
      'sessions the customer has killed, which is not a staging position.',
  },
  EMAIL_VERIFICATION: {
    // THE SECOND DANGEROUS ONE.
    fallback: 'OBSERVE',
    enforcingBreaks:
      'Every existing user. `User.emailVerified` is nullable and NOTHING has ever written it, so ' +
      'enforcing verification locks out the whole installed base at once. ENFORCE is safe only ' +
      'after a back-fill or a verification campaign.',
    observeCounts:
      'every sign-in and every SSO JIT provision on an address nobody has proved ownership of — ' +
      'which, with SSO JIT, is the pre-condition for an account takeover.',
  },
  API_KEY_SCOPE: {
    fallback: 'ENFORCE',
    enforcingBreaks:
      'Any key created with an empty scope array, because TODAY an empty array is read as the ' +
      'wildcard (apps/api/src/middleware/auth.ts). ENFORCE makes the empty array mean NOTHING. ' +
      'The OBSERVE count is how many keys that is before the meaning flips.',
    observeCounts: 'every request authorised by a key whose scopes are empty.',
  },
  ROLE_RANK_GUARD: {
    fallback: 'ENFORCE',
    /*
     * NO PRODUCTION READER EITHER, and this one is a DECISION rather than an
     * omission — recorded here because the previous paragraph read as though
     * the mode did something.
     *
     * The rank rule lives in `apps/api/src/routes/settings.ts`, which refuses
     * an ADMIN changing an OWNER's role and says at the call site why it is not
     * gated: an OBSERVE default would leave a privilege escalation open in
     * every deployment, and the refusal costs an ADMIN nothing they are
     * supposed to be able to do. Measured there: `PATCH
     * /settings/members/<owner>` with `{ role: 'MEMBER' }` from an ADMIN
     * session answered 200 and the OWNER became a MEMBER.
     */
    enforcingBreaks:
      'Nothing a customer does deliberately, and NOT because this mode is enforcing. The rank ' +
      'rule in apps/api/src/routes/settings.ts is UNCONDITIONAL: this control has no production ' +
      'reader, so setting it changes nothing. Gating it would mean an OBSERVE default that left ' +
      'an ADMIN able to demote an OWNER — a privilege escalation, not a workflow — in every ' +
      'install. Documented as unconditional rather than left looking settable.',
    observeCounts:
      'NOTHING, for the same reason: there is no reader and therefore no decision to count. The ' +
      'refusal is applied, audited as `member.role.change` being absent, and never staged.',
  },
  ENFORCE_SSO: {
    fallback: 'ENFORCE',
    enforcingBreaks:
      'Nothing unless an org sets the flag. The flag is the customer\'s decision; this mode is ' +
      'only about whether we honour it, and not honouring a stored security setting is worse ' +
      'than not offering it.',
    observeCounts: 'every password login into an org that has asked for SSO-only.',
  },
  CSRF_TOKEN: {
    fallback: 'ENFORCE',
    enforcingBreaks:
      'A cookie-authenticated client that does not send the token. Bearer-token callers (the CLI, ' +
      'the Action, every API key) are unaffected, because a CSRF check only applies where the ' +
      'browser attaches the credential by itself.',
    observeCounts: 'every cookie-authenticated mutating request that arrived without a valid token.',
  },
  CONTENT_SECURITY_POLICY: {
    // THE THIRD DANGEROUS ONE, and the one where OBSERVE has a name of its own.
    fallback: 'OBSERVE',
    enforcingBreaks:
      'The cockpit, until its inline styles and scripts are accounted for. OBSERVE here means ' +
      'Content-Security-Policy-Report-Only, which is a real header with a real report endpoint ' +
      'and not a disabled feature.',
    observeCounts: 'every violation report, by directive, so the policy can be tightened on evidence.',
  },
} as const satisfies Record<SecurityControl, SecurityControlBrake>;

/**
 * THE TWO NAMES THE DOUBLE-SUBMIT TOKEN TRAVELS UNDER, PUBLISHED ONCE.
 *
 * ── WHY THEY LIVE HERE AND NOT IN THE API ──────────────────────────────────
 *
 * The `CSRF_TOKEN` control is the only one in {@link SECURITY_CONTROLS} that
 * needs BOTH HALVES OF THE PRODUCT to agree on a literal: the API writes a
 * readable companion cookie and requires a header echoing it, and `apps/web`
 * has to read that exact cookie and send that exact header. They were declared
 * in apps/api/src/lib/sessions.ts and RETYPED in apps/web/lib/api.ts, because
 * `apps/web` must not import from `apps/api` — a duplication across a workspace
 * boundary, which is one rename from the defect this whole round exists to
 * undo: every cookie-authenticated `/auth/*` mutation answering 403, sign-out
 * and switch-org included, with nothing in either workspace looking wrong.
 *
 * A compiler cannot catch two string literals drifting apart. It can catch an
 * import, so the names are published here and both sides import them.
 *
 * NEITHER IS A SECRET. The cookie is deliberately NOT HttpOnly — the page has
 * to be able to read it — and these are its NAME and the HEADER's name, never
 * a token value. Rule 11 is about the value, which is derived per session in
 * `csrfTokenFor` and is published nowhere.
 */
/** The header the cockpit echoes the readable companion cookie back in. */
export const CSRF_HEADER = 'x-qaai-csrf';
/** The readable companion cookie. NOT HttpOnly, by design. */
export const CSRF_COOKIE = 'qaai_csrf';

/** True when this mode applies its refusal. OBSERVE counts and allows. */
export function controlEnforces(mode: ControlMode): boolean {
  return mode === 'ENFORCE';
}

/**
 * Read one control's mode out of whatever `Organization.securityControlModes`
 * holds, falling back to the control's own default.
 *
 * FAILS CLOSED ON AMBIGUITY in the direction the brake table chose: an
 * unparseable or unknown stored value resolves to `fallback`, which is ENFORCE
 * for ten of the thirteen. It never throws — the input is JSON from a settings
 * screen, and a control that crashes on a malformed row is a control that is
 * off for as long as the row is malformed.
 */
export function controlMode(control: SecurityControl, stored: unknown): ControlMode {
  const fallback: ControlMode = SECURITY_CONTROL_BRAKES[control].fallback;
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return fallback;
  const raw = (stored as Record<string, unknown>)[control];
  return raw === 'OBSERVE' || raw === 'ENFORCE' ? raw : fallback;
}

/**
 * WHOSE SIDE OF THE FIREWALL THIS DEPLOYMENT IS ON.
 *
 * Mirrors `ProbeHostMode` in packages/runner/src/preflight.ts, which already
 * had exactly this pair for exactly this reason: a self-hosted QAAI exists to
 * test `http://localhost:3000`, and refusing that would break the install for
 * every customer running behind their own firewall. Named here so the egress
 * policy and the preflight cannot disagree about what the two words mean.
 *
 * NOT a Prisma enum: it is a property of the INSTALL, stored inside the
 * `Environment.egressPolicy` JSON beside the rest of the policy, and nothing
 * filters rows on it. Its run-time parity is in packages/shared/src/egress.test.ts.
 */
export const EGRESS_DEPLOYMENT_MODES = ['HOSTED', 'SELF_HOSTED'] as const;
export type EgressDeploymentMode = (typeof EGRESS_DEPLOYMENT_MODES)[number];

/**
 * WHICH TESTS MAY RECEIVE ONE ENVIRONMENT SECRET. Stored by `SecretScope.kind`.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * There is no per-test scoping at all: every decrypted secret in an environment
 * is injected into every test process, so a test that needs a payment
 * provider's test key also receives the production database password. One
 * compromised generated test reads the lot.
 *
 * ── WHY ABSENCE IS THE DENY, AND WHY THAT IS STRUCTURAL ─────────────────────
 *
 * A secret with NO `SecretScope` row reaches NOTHING. The default is therefore
 * a property of the data rather than a convention somebody has to remember: to
 * widen a secret you write a row, and the row has an author, a timestamp and a
 * reason. A `scopeEverything: boolean` column would have made the permissive
 * answer the cheap one, which is how the current state happened.
 *
 * ENVIRONMENT_WIDE exists and is deliberately the broadest and most
 * uncomfortable member. It re-creates today's behaviour for ONE secret at a
 * time, EXPLICITLY, with somebody's name on it — which is the difference
 * between a decision and an accident. `SECRET_SCOPE_RULES` requires a reason
 * for it.
 */
export const SECRET_SCOPE_KINDS = [
  'TEST',
  'SUITE',
  'TEST_TYPE',
  'AUTH_PROFILE',
  'ENVIRONMENT_WIDE',
] as const;
export type SecretScopeKind = (typeof SECRET_SCOPE_KINDS)[number];

/** What one scope kind names, and how uncomfortable it ought to be. */
export interface SecretScopeRule {
  /** What `SecretScope.value` holds for this kind. ENVIRONMENT_WIDE names nothing. */
  readonly names: 'TEST_ID' | 'SUITE_ID' | 'TEST_TYPE' | 'AUTH_PROFILE_ID' | 'NOTHING';
  /** Broadest first: 0 is one test, 4 is every test in the environment. */
  readonly breadth: 0 | 1 | 2 | 3 | 4;
  /** True when a human must say WHY. The broad ones; a single test speaks for itself. */
  readonly requiresReason: boolean;
}

/**
 * The compiler-enforced presence record, with `secretScopeKindSchema.options`
 * in schemas.ts as the run-time half.
 */
export const SECRET_SCOPE_RULES = {
  TEST: { names: 'TEST_ID', breadth: 0, requiresReason: false },
  SUITE: { names: 'SUITE_ID', breadth: 1, requiresReason: false },
  TEST_TYPE: { names: 'TEST_TYPE', breadth: 2, requiresReason: true },
  AUTH_PROFILE: { names: 'AUTH_PROFILE_ID', breadth: 3, requiresReason: true },
  ENVIRONMENT_WIDE: { names: 'NOTHING', breadth: 4, requiresReason: true },
} as const satisfies Record<SecretScopeKind, SecretScopeRule>;

/**
 * WHAT BECAME OF ONE SIGN-IN ATTEMPT. Stored by `LoginAttempt.outcome`.
 *
 * ── NO ORACLE, AND THAT IS WHY UNKNOWN_IDENTIFIER MAY BE STORED ─────────────
 *
 * The RESPONSE to every failed login is identical — one message, one status,
 * one timing budget — so nothing a caller can observe distinguishes
 * UNKNOWN_IDENTIFIER from BAD_PASSWORD from LOCKED_OUT. This enum is what the
 * OPERATOR reads afterwards, inside their own tenant, and the distinction is
 * the difference between "somebody forgot their password" and "somebody is
 * walking a list of addresses". Collapsing the two to avoid the oracle would
 * remove the one signal that says which is happening.
 *
 * BAD_TOTP is a member and it is the one that matters most this round: today
 * `apps/api/src/routes/auth.ts` checks that a code was SUPPLIED and never looks
 * at its value, so this outcome has never been reachable and the count of it
 * has always been zero for the most flattering possible reason.
 */
export const LOGIN_ATTEMPT_OUTCOMES = [
  'SUCCESS',
  'BAD_PASSWORD',
  'BAD_TOTP',
  'UNKNOWN_IDENTIFIER',
  'LOCKED_OUT',
  'SSO_REQUIRED',
  'EMAIL_UNVERIFIED',
] as const;
export type LoginAttemptOutcome = (typeof LOGIN_ATTEMPT_OUTCOMES)[number];

/**
 * How long a per-identifier counter runs before it locks, and for how long.
 *
 * Generous on purpose: the brake for a throttle is the threshold, not the mode
 * (see `SECURITY_CONTROL_BRAKES.LOGIN_THROTTLE`). A CI job that signs in on
 * every build must not trip it, and an attacker walking a password list must.
 *
 * Clamped by `resolveLoginThrottle` so a stored override cannot set
 * `maxFailures: 0`, which would lock every identifier in the install out on its
 * first attempt — the same class of defect `resolveFlakePolicy` clamps against.
 */
export interface LoginThrottlePolicy {
  /** Failures within the window before the identifier is locked. */
  readonly maxFailures: number;
  /** The window the counter is measured over, in minutes. */
  readonly windowMinutes: number;
  /** How long a lock lasts, in minutes. */
  readonly lockMinutes: number;
}

export const LOGIN_THROTTLE_DEFAULTS: LoginThrottlePolicy = {
  maxFailures: 10,
  windowMinutes: 15,
  lockMinutes: 15,
};

/**
 * Merge a stored per-org override onto the defaults, clamping every field.
 *
 * Never throws and never trusts — same contract as `resolveFlakePolicy`, and
 * the same reason: the input is JSON from a settings screen, and a policy that
 * cannot be parsed must resolve to the default rather than to zero. Both
 * directions are clamped, because `maxFailures: 1` locks out the installed base
 * and `maxFailures: 10_000` is no throttle at all.
 */
export function resolveLoginThrottle(raw: unknown): LoginThrottlePolicy {
  const d = LOGIN_THROTTLE_DEFAULTS;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return d;
  const o = raw as Record<string, unknown>;
  const num = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, Math.trunc(value)))
      : fallback;
  return {
    maxFailures: num(o.maxFailures, d.maxFailures, 3, 100),
    windowMinutes: num(o.windowMinutes, d.windowMinutes, 1, 24 * 60),
    lockMinutes: num(o.lockMinutes, d.lockMinutes, 1, 24 * 60),
  };
}

/**
 * WHY A SESSION STOPPED WORKING. Stored by `Session.revokedReason` as TEXT.
 *
 * TEXT and not a Prisma enum, on the house argument `Run.selectionSource`
 * records: nothing filters rows on it (the reads are "list my sessions" and
 * "revoke this one"), so an enum would be one more Postgres type whose only job
 * is to need a drift guard. The domain is enforced by `sessionRevocationReasonSchema`
 * in schemas.ts, which is the only write path.
 *
 * NULL beside a non-null `revokedAt` is a legal and meaningful state: a session
 * revoked before this list existed. A reader must render it as "revoked, reason
 * not recorded" and never pick a member to stand in for it.
 */
export const SESSION_REVOCATION_REASONS = [
  'USER_SIGNED_OUT',
  'USER_REVOKED_DEVICE',
  'ADMIN_REVOKED',
  'PASSWORD_CHANGED',
  'TOTP_CHANGED',
  'ALL_SESSIONS_REVOKED',
  'KEY_COMPROMISE',
  'SSO_ENFORCED',
] as const;
export type SessionRevocationReason = (typeof SESSION_REVOCATION_REASONS)[number];

/**
 * WHAT A `VerificationToken` IS FOR. Stored by `VerificationToken.purpose` as TEXT.
 *
 * The column has carried the comment `// "EMAIL_VERIFY" | "PASSWORD_RESET" |
 * "INVITE"` since the init migration and there has never been a TypeScript list
 * to check a writer against, so the three spellings lived in whichever route
 * happened to need one. This is that list. The column stays TEXT — converting a
 * populated column to an enum is a data migration bought for nothing, since
 * nothing groups on it.
 */
export const VERIFICATION_TOKEN_PURPOSES = [
  'EMAIL_VERIFY',
  'PASSWORD_RESET',
  'INVITE',
] as const;
export type VerificationTokenPurpose = (typeof VERIFICATION_TOKEN_PURPOSES)[number];

/**
 * THE SCOPES AN API KEY MAY HOLD.
 *
 * ── THE DEFECT THIS LIST EXISTS TO CLOSE ────────────────────────────────────
 *
 * `apps/api/src/middleware/auth.ts` reads
 * `scopes: key.scopes.length > 0 ? key.scopes : ['*']`, so A KEY CREATED WITH
 * AN EMPTY SCOPE ARRAY HOLDS EVERY SCOPE. `POST /settings/api-keys` hand-parses
 * `req.body.scopes` with no schema and no vocabulary, so "create a read-only
 * key" and "create a key with no restrictions at all" are the same request with
 * a different body — and the restrictive-looking one is the unrestricted one.
 *
 * The six members are the scopes `requireScope` actually gates on today,
 * enumerated from the routes rather than invented: a seventh spelling in a
 * request body is a scope no route will ever check, which is a key the customer
 * believes is narrower than it is.
 *
 * `'*'` IS DELIBERATELY NOT A MEMBER. It is the sentinel `requireScope` gives a
 * SESSION actor, who is a human with a role, and it must not be storable on a
 * key: a key that can name the wildcard is the empty array with extra steps.
 */
export const API_KEY_SCOPES = [
  'tests:read',
  'tests:write',
  'runs:read',
  'runs:write',
  'secrets:write',
  'git:push',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
