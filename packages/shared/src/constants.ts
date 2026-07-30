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
 * A test whose `filePath` starts with this is treated as test data, not a test:
 * excluded from run selection and the flake radar, materialised into the run
 * workspace so specs can read it. Reuses the Test row so no new model is needed.
 */
export const FIXTURE_PREFIX = 'fixtures/';

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

// ─── Queues (§5) ─────────────────────────────────────────────────────────────

export const QUEUE_NAMES = {
  run: 'qaai.run',
  explore: 'qaai.explore',
  generate: 'qaai.generate',
  triage: 'qaai.triage',
  copilot: 'qaai.copilot',
  import: 'qaai.import',
  schedule: 'qaai.schedule',
  notify: 'qaai.notify',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ─── Misc ────────────────────────────────────────────────────────────────────

/** Redacted stand-in written wherever a secret would otherwise be serialised (§1). */
export const SECRET_MASK = '••••••••';

/** Prefix on every API key so leak-scanners can pattern-match it. */
export const API_KEY_PREFIX = 'qaai_';
