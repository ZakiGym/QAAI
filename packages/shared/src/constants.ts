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
