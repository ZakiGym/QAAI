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

export const ENVIRONMENT_KINDS = ['LOCAL', 'PREVIEW', 'STAGING', 'PRODUCTION'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

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

export const AUTH_PROFILE_KINDS = [
  'FORM_LOGIN',
  'MAGIC_LINK',
  'SSO_BYPASS_TOKEN',
  'COOKIE_INJECTION',
  'TOTP_MFA',
] as const;
export type AuthProfileKind = (typeof AUTH_PROFILE_KINDS)[number];

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

/** Prefix on every API key so leak-scanners can pattern-match it. */
export const API_KEY_PREFIX = 'qaai_';
