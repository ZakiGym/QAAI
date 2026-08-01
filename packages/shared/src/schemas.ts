/**
 * Zod schemas for everything crossing the wire. The API validates request
 * bodies with these; the agent validates LLM tool-call output with the same
 * ones, so a hallucinated plan item fails exactly like a malformed POST.
 */

import { z } from 'zod';
import {
  AUTH_PROFILE_KINDS,
  ENVIRONMENT_KINDS,
  FRAMEWORKS_BY_LANGUAGE,
  GIT_INTEGRATION_KINDS,
  GRID_INTEGRATION_KINDS,
  LANGUAGES,
  ORG_ROLES,
  PRIORITIES,
  TEST_TYPES,
  UI_FRAMEWORKS,
  VERDICTS,
} from './constants.js';
import { SELECTOR_STRATEGIES } from './flow-map.js';

const slug = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'lowercase letters, digits and dashes only');

/** Rejects non-http(s) schemes so a base URL can never become file:// or javascript:. */
const httpUrl = z
  .string()
  .url()
  .refine((u) => ['http:', 'https:'].includes(new URL(u).protocol), 'must be http or https');

// ─── Auth (§1) ───────────────────────────────────────────────────────────────

export const signupSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12, 'use at least 12 characters').max(200),
  name: z.string().min(1).max(120),
  /** Creating the first org inline keeps signup to one screen. */
  orgName: z.string().min(1).max(120),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /** Required only once the user has enrolled in TOTP. */
  totpCode: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(ORG_ROLES),
});

// ─── Projects & environments (§2) ────────────────────────────────────────────

export const createProjectSchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: slug.optional(),
    repoUrl: httpUrl.nullish(),
    primaryLanguage: z.enum(LANGUAGES).default('TYPESCRIPT'),
    primaryFramework: z.enum(UI_FRAMEWORKS).default('PLAYWRIGHT'),
  })
  /**
   * The pair has to be one the generator can actually emit. Selenium with
   * TypeScript passed validation happily and then produced tests that could
   * never run — a failure the user only discovered after a crawl, a plan, an
   * approval and a generation.
   */
  .superRefine((value, ctx) => {
    const allowed = FRAMEWORKS_BY_LANGUAGE[value.primaryLanguage];
    if (!allowed.includes(value.primaryFramework)) {
      ctx.addIssue({
        code: 'custom',
        path: ['primaryFramework'],
        message: `${value.primaryFramework} is not available for ${value.primaryLanguage}. Choose one of: ${allowed.join(', ')}`,
      });
    }
  });

export const createEnvironmentSchema = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum(ENVIRONMENT_KINDS),
  baseUrl: httpUrl,
});

/** Rename / repoint an environment. Kind is immutable — LOCAL vs PRODUCTION is a
 *  meaningful identity, not an editable label. */
export const updateEnvironmentSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    baseUrl: httpUrl.optional(),
  })
  .refine((v) => v.name !== undefined || v.baseUrl !== undefined, 'nothing to update');

/** SCREAMING_SNAKE_CASE, so a secret can be injected into a test process verbatim. */
const secretName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'use SCREAMING_SNAKE_CASE');

export const upsertSecretSchema = z.object({
  name: secretName,
  value: z.string().min(1).max(8192),
});

/**
 * Bulk-import secrets from a pasted `.env` file. The raw text is parsed on the
 * server (KEY=VALUE, `export` prefix and `#` comments tolerated, quotes
 * stripped) so a whole environment's credentials land in the vault in one step.
 * Parsed values never echo back — only the names that were imported.
 */
export const importSecretsSchema = z.object({
  content: z.string().min(1).max(200_000),
  /** Replace an existing secret of the same name (default) or skip it. */
  overwrite: z.boolean().default(true),
});

export const authProfileSchema = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum(AUTH_PROFILE_KINDS),
  /**
   * Shape depends on `kind`; validated per-kind by `authProfileConfigSchema`.
   * Secret-bearing fields are stored in the vault, not inline.
   */
  config: z.record(z.string(), z.unknown()),
});

export const authProfileConfigSchema = {
  FORM_LOGIN: z.object({
    loginUrl: z.string(),
    usernameSelector: z.string(),
    passwordSelector: z.string(),
    submitSelector: z.string(),
    usernameSecretName: z.string(),
    passwordSecretName: z.string(),
    /** A locator that only exists once login succeeded. */
    successSelector: z.string(),
  }),
  MAGIC_LINK: z.object({
    requestUrl: z.string(),
    emailSelector: z.string(),
    submitSelector: z.string(),
    /** Mailbox the built-in SMTP catcher should poll. */
    mailbox: z.string().email(),
    linkPattern: z.string().default('https?://\\S+'),
  }),
  SSO_BYPASS_TOKEN: z.object({
    tokenSecretName: z.string(),
    header: z.string().default('Authorization'),
    valueTemplate: z.string().default('Bearer {token}'),
  }),
  COOKIE_INJECTION: z.object({
    cookiesSecretName: z.string(),
    domain: z.string(),
  }),
  TOTP_MFA: z.object({
    /** Base32 seed, held in the vault. The agent computes codes at run time. */
    seedSecretName: z.string(),
    codeSelector: z.string(),
    submitSelector: z.string(),
  }),
} as const;

// ─── Flow map & plan (§3.1) ──────────────────────────────────────────────────

export const selectorSchema = z.object({
  strategy: z.enum(SELECTOR_STRATEGIES),
  value: z.string().min(1),
  name: z.string().optional(),
  nth: z.number().int().min(0).optional(),
  confidence: z.number().min(0).max(1),
});

export const planItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(160),
  rationale: z.string().min(1).max(1000),
  feature: z.string().min(1).max(80),
  priority: z.enum(PRIORITIES),
  testType: z.enum(TEST_TYPES),
  steps: z.array(z.string().min(1)).min(1).max(40),
  assertions: z.array(z.string().min(1)).min(1).max(20),
  journeyId: z.string().nullable().default(null),
  authProfileId: z.string().nullable().default(null),
});

export const testPlanSchema = z.object({
  flowMapVersion: z.number().int().min(0),
  summary: z.string().min(1),
  items: z.array(planItemSchema).min(1).max(200),
  skipped: z.array(z.object({ what: z.string(), why: z.string() })).default([]),
});

export const approvePlanSchema = z.object({
  /** Plan item ids the human ticked. Everything else is discarded. */
  approvedItemIds: z.array(z.string().min(1)).min(1),
  /** Optional per-item edits made in the approval UI. */
  edits: z
    .record(
      z.string(),
      z.object({ title: z.string().optional(), priority: z.enum(PRIORITIES).optional() }),
    )
    .default({}),
});

// ─── Generation (§3.2) ───────────────────────────────────────────────────────

export const generatedTestSchema = z.object({
  name: z.string().min(1).max(160),
  filePath: z
    .string()
    .min(1)
    .max(300)
    // Traversal guard: generated paths are written to disk and committed to PRs.
    .refine((p) => !p.includes('..') && !p.startsWith('/'), 'must be a relative path without ..'),
  code: z.string().min(1),
  /** Selectors the generator was not confident about; surfaced for review. */
  reviewFlags: z.array(z.string()).default([]),
});

// ─── Hand-authored tests (§8 editor) ─────────────────────────────────────────

/** A path that is safe to write to disk — the runner turns this into a real file. */
const relativeFilePath = z
  .string()
  .min(1)
  .max(300)
  .refine((p) => !p.includes('..') && !p.startsWith('/'), 'must be relative and cannot contain ..');

export const updateTestSchema = z.object({
  code: z.string().max(500_000),
  name: z.string().min(1).max(160).optional(),
  /** Type-specific config for the non-Playwright plugins (API, a11y, security). */
  spec: z.unknown().optional(),
  /** Shown in the version history. */
  message: z.string().max(300).optional(),
});

export const createTestSchema = z.object({
  name: z.string().min(1).max(160),
  type: z.enum(TEST_TYPES).default('E2E'),
  feature: z.string().min(1).max(80).optional(),
  priority: z.enum(PRIORITIES).default('IMPORTANT'),
  code: z.string().max(500_000),
  filePath: relativeFilePath,
  spec: z.unknown().optional(),
  tags: z.array(z.string().max(40)).max(20).default([]),
});

/**
 * Rename or move a file. These are one operation, not two: a move is a rename
 * whose directory part changed. Keeping them together means the path rules —
 * traversal, uniqueness, the fixtures/ boundary — are enforced in exactly one
 * place instead of drifting apart.
 */
export const moveTestSchema = z.object({
  filePath: relativeFilePath,
  /** Rename the test itself too. Omit to keep the current name. */
  name: z.string().min(1).max(160).optional(),
});

/**
 * Rename or move a folder — a bulk path-prefix rewrite.
 *
 * Folders are not stored anywhere. They exist only as slashes inside filePath,
 * exactly as they do in git, which is why this is a prefix update across many
 * rows rather than an edit to a folder row that does not exist.
 */
export const moveFolderSchema = z.object({
  from: relativeFilePath,
  to: relativeFilePath,
});

export const deleteFolderSchema = z.object({
  path: relativeFilePath,
});

/**
 * An inline edit request (⌘K in the editor). The selection may be empty — the
 * user can invoke it with nothing highlighted to act on the whole file.
 */
export const inlineEditRequestSchema = z.object({
  instruction: z.string().min(1).max(2000),
  selection: z.string().max(100_000).default(''),
  selectionStartLine: z.number().int().min(0).default(0),
  selectionEndLine: z.number().int().min(0).default(0),
});

// ─── Triage (§3.3) ───────────────────────────────────────────────────────────

export const triageVerdictSchema = z.object({
  verdict: z.enum(VERDICTS),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1).max(2000),
  evidence: z
    .array(
      z.object({
        kind: z.enum(['STEP', 'NETWORK', 'CONSOLE', 'DIFF', 'HISTORY']),
        ref: z.string(),
        detail: z.string(),
      }),
    )
    .min(1),
  suspectCommit: z
    .object({
      sha: z.string(),
      author: z.string(),
      message: z.string(),
      files: z.array(z.string()),
    })
    .nullable()
    .default(null),
});

// ─── Healing (§3.4) ──────────────────────────────────────────────────────────

export const healProposalSchema = z.object({
  diff: z.string().min(1),
  explanation: z.string().min(1).max(2000),
  riskLevel: z.enum(['SELECTOR_ONLY', 'ASSERTION_CHANGE', 'STRUCTURAL']),
  confidence: z.number().min(0).max(1),
});

// ─── API test spec (§4) ──────────────────────────────────────────────────────

/** The methods a hand-written spec will normally use; documented, not exhaustive. */
export const COMMON_HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;

export const apiRequestStepSchema = z.object({
  name: z.string().min(1),
  /**
   * Any uppercase HTTP method. `fetch` executes whatever it is given, so an
   * imported Postman request using PURGE or PROPFIND runs rather than failing
   * spec validation — the earlier `z.enum` rejected those outright.
   */
  method: z
    .string()
    .transform((m) => m.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]+$/, 'HTTP method must be letters only')),
  /** Relative to the environment base URL, or absolute. Supports {{var}}. */
  path: z.string().min(1),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.unknown().optional(),
  assertions: z
    .object({
      status: z.number().int().min(100).max(599).optional(),
      maxLatencyMs: z.number().int().positive().optional(),
      /** JSON-path-ish dotted key → expected literal. */
      bodyMatches: z.record(z.string(), z.unknown()).optional(),
      bodyContains: z.string().optional(),
    })
    .default({}),
  /** Pull values out of the response into variables for later steps. */
  extract: z.record(z.string(), z.string()).default({}),
});

export const apiTestSpecSchema = z.object({
  variables: z.record(z.string(), z.string()).default({}),
  steps: z.array(apiRequestStepSchema).min(1),
});
export type ApiTestSpec = z.infer<typeof apiTestSpecSchema>;

// ─── Email / OTP (§4) ────────────────────────────────────────────────────────

/**
 * A real email-code sign-in. The mailbox URL is the one honest dependency: you
 * need a test mail sink. The bundled demo exposes `/__mail`; MailHog, Mailpit
 * and Mailosaur expose the same shape.
 */
export const emailOtpSpecSchema = z.object({
  requestUrl: z.string().min(1).default('/login'),
  emailSelector: z.string().min(1),
  requestSubmitSelector: z.string().min(1),
  /** Prefer a vault secret; an inline address is allowed for throwaway inboxes. */
  recipientSecretName: z.string().max(80).default('OTP_RECIPIENT'),
  recipient: z.string().email().optional(),
  mailboxUrl: z.string().min(1).default('/__mail'),
  /** First capture group wins, else the whole match. */
  codePattern: z.string().min(1).default('\\b(\\d{6})\\b'),
  codeSelector: z.string().min(1),
  verifySubmitSelector: z.string().min(1),
  successSelector: z.string().min(1),
  timeoutSeconds: z.number().int().min(5).max(300).default(60),
});

export type EmailOtpSpec = z.infer<typeof emailOtpSpecSchema>;

// ─── Cross-browser & localisation (§4) ───────────────────────────────────────

export const BROWSER_ENGINES = ['chromium', 'firefox', 'webkit'] as const;

/** Chromium is always run; listing it again is harmless. */
export const crossBrowserSpecSchema = z.object({
  browsers: z.array(z.enum(BROWSER_ENGINES)).min(1).default(['chromium', 'firefox', 'webkit']),
});

export const localizationSpecSchema = z.object({
  locales: z
    .array(
      z.object({
        /** BCP-47, e.g. `de-DE`. */
        tag: z.string().min(2).max(35),
        /** IANA zone. Half of localisation bugs are date and currency formatting. */
        timezone: z.string().max(64).optional(),
      }),
    )
    .min(1)
    .max(20),
});

// ─── Schedules & monitors (§6) ───────────────────────────────────────────────

/** Standard 5-field cron. Validated on the worker too, which disables a bad one. */
const cronExpression = z
  .string()
  .min(9)
  .max(120)
  .regex(/^[\d*/,\-\s?LW#]+$/, 'not a cron expression');

export const createScheduleSchema = z.object({
  name: z.string().min(1).max(80),
  suiteId: z.string().min(1),
  environmentId: z.string().min(1),
  cron: cronExpression,
  timezone: z.string().min(1).max(64).default('UTC'),
});

export const createMonitorSchema = z.object({
  name: z.string().min(1).max(80),
  suiteId: z.string().min(1),
  environmentId: z.string().min(1),
  intervalMinutes: z.number().int().min(1).max(1440).default(15),
  /** Consecutive failures before it pages — 1 makes every blip an alert. */
  failureThreshold: z.number().int().min(1).max(10).default(2),
});

// ─── Quality gates (§5) ──────────────────────────────────────────────────────

/**
 * The rules that decide whether a run blocks a deploy.
 *
 * A discriminated union so an invalid combination cannot be stored: a
 * BLOCK_ON_VERDICT rule has no rate, and a MAX_FLAKE_RATE rule has no verdict.
 * These have lived on Project.gateRules as untyped JSON with no way to edit
 * them — the product's teeth, configurable only by hand-editing the database.
 */
export const gateRuleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('BLOCK_ON_VERDICT'),
    verdict: z.enum(VERDICTS),
    onlyPriorities: z.array(z.enum(PRIORITIES)).default([]),
  }),
  z.object({
    kind: z.literal('MAX_FLAKE_RATE'),
    ratePercent: z.number().min(0).max(100),
    action: z.enum(['WARN', 'BLOCK']),
  }),
  z.object({
    kind: z.literal('MAX_P95_LATENCY_MS'),
    ms: z.number().int().positive().max(600_000),
    action: z.enum(['WARN', 'BLOCK']),
  }),
  z.object({
    kind: z.literal('MIN_PASS_RATE'),
    ratePercent: z.number().min(0).max(100),
    action: z.enum(['WARN', 'BLOCK']),
  }),
]);

export const updateGateRulesSchema = z.object({
  rules: z.array(gateRuleSchema).max(20),
});

// ─── Visual regression (§4) ──────────────────────────────────────────────────

const ignoreRegionSchema = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().positive(),
  height: z.number().positive(),
});

const viewportSchema = z.object({
  width: z.number().int().min(200).max(4000).default(1280),
  height: z.number().int().min(200).max(4000).default(800),
});

/**
 * A visual test. The two thresholds do different jobs and both matter:
 * `pixelThreshold` is per-pixel colour tolerance (anti-aliasing, sub-pixel text),
 * while `maxDiffRatio` is how much of the image may legitimately change before
 * the test fails.
 */
export const visualTestSpecSchema = z.object({
  /** Route or absolute URL to capture. */
  path: z.string().min(1).default('/'),
  /** Capture just this element instead of the page. */
  selector: z.string().max(400).optional(),
  fullPage: z.boolean().default(true),
  viewport: viewportSchema.default(viewportSchema.parse({})),
  /** Per-pixel colour tolerance, 0–1. 0.1 absorbs anti-aliasing without hiding real change. */
  pixelThreshold: z.number().min(0).max(1).default(0.1),
  /** Share of the image allowed to differ, 0–1. */
  maxDiffRatio: z.number().min(0).max(1).default(0.002),
  /** Extra wait after network idle, for late-settling UI. */
  settleMs: z.number().int().min(0).max(30_000).default(250),
  /** Rectangles excluded from the diff — clocks, avatars, ad slots. */
  ignoreRegions: z.array(ignoreRegionSchema).max(50).default([]),
});

export type VisualTestSpec = z.infer<typeof visualTestSpecSchema>;

// ─── Load testing — k6 (§4) ──────────────────────────────────────────────────

/**
 * A k6 load test.
 *
 * Either bring your own script, or describe the shape and let QAAI generate one.
 * Thresholds are the assertions: a load test that reports "it ran" without
 * saying what was acceptable is not a test, so a spec with no thresholds gets
 * sensible defaults rather than silently always passing.
 */
/** The shape of the generated scenario, split out so its defaults are typed. */
const loadScenarioSchema = z.object({
  /** Path or absolute URL to hit. Relative resolves against the environment. */
  path: z.string().min(1).default('/'),
  method: z
    .string()
    .transform((m) => m.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]+$/))
    .default('GET'),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  /** Virtual users held for `durationSeconds`. */
  vus: z.number().int().min(1).max(10_000).default(10),
  durationSeconds: z.number().int().min(1).max(3600).default(30),
  /** Ramp to `vus` over this long; 0 means start at full load. */
  rampUpSeconds: z.number().int().min(0).max(3600).default(0),
});

const loadThresholdsSchema = z.object({
  /** Fail if the 95th-percentile response exceeds this. */
  p95Ms: z.number().int().positive().default(800),
  /** Fail above this share of failed requests, 0–1. */
  errorRate: z.number().min(0).max(1).default(0.01),
});

export const loadTestSpecSchema = z.object({
  /** A complete k6 script. When present, `scenario` is ignored. */
  script: z.string().max(200_000).optional(),
  scenario: loadScenarioSchema.default(loadScenarioSchema.parse({})),
  thresholds: loadThresholdsSchema.default(loadThresholdsSchema.parse({})),
});

export type LoadTestSpec = z.infer<typeof loadTestSpecSchema>;

// ─── External command tests (§4) ─────────────────────────────────────────────

/**
 * Report shapes QAAI can turn into per-test results.
 *
 * One id per parser in packages/runner/src/reports, plus two that are not
 * parsers: `exit-code` (the process's own verdict, with no file read at all)
 * and `auto` (sniff the format from the file's first bytes).
 *
 * `junit` and `json-summary` are the ids that existed before the parsers landed
 * and are kept so specs already stored against them keep working — they resolve
 * to `junit-xml` and `auto`.
 */
export const EXTERNAL_REPORT_FORMATS = [
  'junit-xml',
  'tap',
  'go-json',
  'trx',
  'nunit3',
  'jest-json',
  'pytest-json',
  'rspec-json',
  'cucumber-json',
  'auto',
  'exit-code',
  'junit',
  'json-summary',
] as const;
export type ExternalReportFormat = (typeof EXTERNAL_REPORT_FORMATS)[number];

/**
 * Run any test tool that QAAI does not implement natively — Vitest, Jest, Mocha,
 * Cypress, Newman, Pa11y, Lighthouse CI, Maestro, and so on.
 *
 * Rather than pretend to reimplement a dozen runners, QAAI executes the tool's
 * own command in the workspace and reads the report it already emits. Nearly
 * every runner can produce JUnit XML, which is why that is the default.
 */
export const externalTestSpecSchema = z.object({
  /** The executable, e.g. `npx`. Never passed through a shell. */
  command: z.string().min(1).max(200),
  args: z.array(z.string().max(500)).max(64).default([]),
  /** Extra env for the child. Secret VALUES are injected separately, by name. */
  env: z.record(z.string(), z.string()).default({}),
  /** Secret names to expose to the child process, resolved from the vault. */
  secretNames: z.array(z.string().max(80)).max(50).default([]),
  /** Where the tool writes its report, relative to the workspace. */
  reportPath: z.string().max(300).default('report.xml'),
  reportFormat: z.enum(EXTERNAL_REPORT_FORMATS).default('junit'),
  timeoutSeconds: z.number().int().min(1).max(3600).default(600),
  /** Working directory inside the workspace. */
  cwd: z.string().max(300).default('.'),
});

export type ExternalTestSpec = z.infer<typeof externalTestSpecSchema>;

// ─── Database tests (§4) ─────────────────────────────────────────────────────

/**
 * Engines the DATABASE plugin can actually talk to. Postgres only, deliberately:
 * `pg` is already in the tree, and a plugin that claims MySQL/SQLite without a
 * driver behind it would fail at run time instead of at validation time.
 */
export const DATABASE_ENGINES = ['POSTGRES'] as const;
export type DatabaseEngine = (typeof DATABASE_ENGINES)[number];

/**
 * What a `sql` step expects to see. Every field is optional; a step with no
 * expectation still asserts something real — that the statement executes.
 */
const sqlExpectationSchema = z.object({
  rowCount: z.number().int().min(0).optional(),
  minRowCount: z.number().int().min(0).optional(),
  maxRowCount: z.number().int().min(0).optional(),
  /**
   * The first row's `column` (or its first column) must equal this. Compared
   * loosely against the string form too, because Postgres returns `count(*)`
   * and every bigint as a string — `rowCount: 1, value: 3` is what a user means
   * even when they wrote `3` and the driver handed back `"3"`.
   */
  value: z.unknown().optional(),
  column: z.string().max(120).optional(),
});

const databaseSqlStepSchema = z.object({
  kind: z.literal('sql'),
  name: z.string().min(1).max(160),
  sql: z.string().min(1).max(50_000),
  /** Bound as $1, $2… — never interpolated into the statement. */
  params: z.array(z.unknown()).max(64).default([]),
  expect: sqlExpectationSchema.default({}),
});

/**
 * A constraint that must REJECT the row that violates it.
 *
 * This is the step type that catches the silent disaster: a unique index that
 * was dropped in a migration and never recreated, a foreign key that came back
 * as `NOT VALID`, a check constraint someone disabled to unblock a deploy.
 * Nothing else in a test suite notices until the data is already wrong.
 */
const databaseConstraintStepSchema = z.object({
  kind: z.literal('constraint'),
  name: z.string().min(1).max(160),
  /** The constraint expected to do the rejecting, e.g. `users_email_key`. */
  constraint: z.string().min(1).max(120),
  /** A statement that violates it. If this SUCCEEDS, the test fails. */
  sql: z.string().min(1).max(50_000),
  params: z.array(z.unknown()).max(64).default([]),
  /**
   * Expected SQLSTATE. Defaults to the integrity-violation class `23xxx`
   * (23505 unique, 23503 foreign key, 23514 check, 23502 not-null).
   */
  expectSqlState: z
    .string()
    .regex(/^[0-9A-Z]{5}$/, 'a SQLSTATE is five characters, e.g. 23505')
    .optional(),
});

/**
 * A migration and its rollback, applied forward and then back, with the schema
 * compared before and after. The rollback half of a migration is the thing
 * nobody exercises until an incident makes them run it for the first time.
 */
const databaseMigrationStepSchema = z.object({
  kind: z.literal('migration'),
  name: z.string().min(1).max(160),
  up: z.array(z.string().min(1).max(50_000)).min(1).max(50),
  down: z.array(z.string().min(1).max(50_000)).min(1).max(50),
  /**
   * Fail when `up` left the schema byte-identical. A migration that changes
   * nothing is usually a migration that silently did not apply — but set this
   * to false for a data-only migration, where no schema change is the point.
   */
  expectSchemaChange: z.boolean().default(true),
});

export const databaseStepSchema = z.discriminatedUnion('kind', [
  databaseSqlStepSchema,
  databaseConstraintStepSchema,
  databaseMigrationStepSchema,
]);
export type DatabaseStep = z.infer<typeof databaseStepSchema>;

/**
 * A database test.
 *
 * The connection string is named, never inline: a spec is org-authored data that
 * ends up in a git repo, and a DSN carries a password. The runner resolves
 * `connectionSecretName` out of the environment's vault at execution time.
 */
export const databaseTestSpecSchema = z.object({
  engine: z.enum(DATABASE_ENGINES).default('POSTGRES'),
  /** Vault secret holding the DSN. Never the DSN itself. */
  connectionSecretName: secretName.default('DATABASE_URL'),
  /** Schemas included in the migration fingerprint. */
  schemas: z.array(z.string().min(1).max(63)).min(1).max(20).default(['public']),
  statementTimeoutMs: z.number().int().min(100).max(600_000).default(15_000),
  /**
   * Opt in to running write steps against a database whose name or host looks
   * like production. Off by default; see the guard in the plugin.
   */
  allowProductionDatabase: z.boolean().default(false),
  /** Runs first, inside the same transaction that gets rolled back at the end. */
  seed: z.array(z.string().min(1).max(50_000)).max(50).default([]),
  steps: z.array(databaseStepSchema).min(1).max(100),
});

export type DatabaseTestSpec = z.infer<typeof databaseTestSpecSchema>;

// ─── CLI tests (§4) ──────────────────────────────────────────────────────────

/** A regex a spec supplied as a string — rejected at validation if it will not compile. */
const regexSource = z
  .string()
  .min(1)
  .max(2000)
  .refine((source) => {
    try {
      new RegExp(source);
      return true;
    } catch {
      return false;
    }
  }, 'is not a valid regular expression');

/**
 * What one output stream must look like. Every assertion present becomes its own
 * cockpit step, so a failure points at the one that broke rather than at
 * "output did not match".
 */
const streamExpectationSchema = z.object({
  equals: z.string().max(200_000).optional(),
  contains: z.array(z.string().min(1).max(2000)).max(50).default([]),
  notContains: z.array(z.string().min(1).max(2000)).max(50).default([]),
  matches: regexSource.optional(),
  /** Flags for `matches`; `s` and `i` are the useful ones. */
  matchFlags: z
    .string()
    .max(8)
    .regex(/^[gimsuy]*$/, 'only the standard regex flags are allowed')
    .default(''),
  /** Assert the stream is empty (after normalisation) — the usual stderr check. */
  empty: z.boolean().optional(),
});

const cliExpectationSchema = z.object({
  /** null means "do not assert an exit code". 0 is the default because it is the point. */
  exitCode: z.number().int().min(0).max(255).nullable().default(0),
  stdout: streamExpectationSchema.optional(),
  stderr: streamExpectationSchema.optional(),
  maxDurationMs: z.number().int().positive().max(3_600_000).optional(),
  /**
   * Normalise CRLF to LF, strip trailing whitespace per line, and drop trailing
   * blank lines before comparing. On by default: line endings and a stray
   * trailing newline are the overwhelming majority of false CLI failures.
   */
  normalizeWhitespace: z.boolean().default(true),
});

/**
 * Run a command-line program and assert on what it did.
 *
 * The command is spawned WITHOUT a shell and args are passed as an array — a
 * spec is data, and `shell: true` would make it remote code execution.
 */
export const cliTestSpecSchema = z.object({
  /** The executable. Resolved on PATH; never passed through a shell. */
  command: z.string().min(1).max(200),
  args: z.array(z.string().max(4000)).max(128).default([]),
  /** Piped to the process's stdin, which is then closed. */
  stdin: z.string().max(1_000_000).optional(),
  /** Working directory, relative to the run workspace. Cannot escape it. */
  cwd: z.string().max(300).default('.'),
  env: z.record(z.string(), z.string()).default({}),
  /** Secret names to expose as env vars, resolved from the vault. */
  secretNames: z.array(secretName).max(50).default([]),
  timeoutSeconds: z.number().int().min(1).max(3600).default(60),
  /** Shown when the binary is missing, e.g. `brew install jq`. */
  installHint: z.string().max(200).optional(),
  expect: cliExpectationSchema.default(cliExpectationSchema.parse({})),
});

export type CliTestSpec = z.infer<typeof cliTestSpecSchema>;

// ─── Protocol tests — GraphQL / WebSocket / SSE / gRPC (§4) ──────────────────

/**
 * The four protocols a modern backend speaks that plain REST assertions cannot
 * reach. One TestType rather than four, because they share everything that
 * matters: a connection, an ordered sequence of messages, and per-message
 * assertions with a deadline.
 */
export const PROTOCOL_KINDS = ['GRAPHQL', 'WEBSOCKET', 'SSE', 'GRPC'] as const;
export type ProtocolKind = (typeof PROTOCOL_KINDS)[number];

/**
 * Interpolation bag shared by every protocol. `{{NAME}}` resolves against the
 * environment's vault secrets first, then these literals — so a bearer token is
 * referenced BY NAME and its value never appears in the spec the customer
 * commits. Identical semantics to the API plugin's variables.
 */
const protocolVariables = z.record(z.string(), z.string()).default({});

// GraphQL ────────────────────────────────────────────────────────────────────

/**
 * GraphQL assertions.
 *
 * There is deliberately no `status` field. A GraphQL server reports resolver
 * failures as `errors` inside the body with HTTP 200, so a status-code assertion
 * passes on exactly the responses you most want to catch. `expectErrors` is the
 * real switch: false (the default) fails the step when `errors` is non-empty,
 * true fails it when the operation did NOT error.
 */
const graphqlAssertionsSchema = z.object({
  /** Dotted path INTO `data` → expected literal, e.g. `viewer.email`. */
  dataMatches: z.record(z.string(), z.unknown()).optional(),
  /** Substring search over `JSON.stringify(data)` — never over `errors`. */
  dataContains: z.string().optional(),
  expectErrors: z.boolean().default(false),
  /** Checked against the joined `errors[].message` list. Implies expectErrors. */
  errorMessageContains: z.string().optional(),
  maxLatencyMs: z.number().int().positive().optional(),
});

export const graphqlOperationSchema = z.object({
  name: z.string().min(1).max(160),
  /** The document. Supports `{{var}}`. */
  query: z.string().min(1).max(100_000),
  /** GraphQL variables. String values support `{{var}}`. */
  variables: z.record(z.string(), z.unknown()).default({}),
  /** Required when the document declares more than one operation. */
  operationName: z.string().max(160).optional(),
  assertions: graphqlAssertionsSchema.default(graphqlAssertionsSchema.parse({})),
  /** Name → dotted path into `data`, for later operations to interpolate. */
  extract: z.record(z.string(), z.string()).default({}),
});

export const graphqlProtocolSpecSchema = z.object({
  protocol: z.literal('GRAPHQL'),
  /** Relative to the environment base URL, or absolute. */
  endpoint: z.string().min(1).max(2000).default('/graphql'),
  headers: z.record(z.string(), z.string()).default({}),
  variables: protocolVariables,
  /**
   * Fetch the schema by introspection and check each operation's ROOT fields
   * exist before sending it. When introspection is disabled on the server (as it
   * usually is in production) the check is reported SKIPPED, never FAILED — a
   * closed schema is a hardening choice, not a bug in the operation.
   */
  introspect: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(300_000).default(30_000),
  operations: z.array(graphqlOperationSchema).min(1).max(50),
});

// WebSocket ──────────────────────────────────────────────────────────────────

/**
 * One step of a socket conversation. EXPECT defaults to MATCH rather than NEXT
 * because a real socket interleaves heartbeats, presence events and other
 * subscriptions with the message you care about; asserting on "the next frame"
 * makes a test that passes only when the server happens to be quiet.
 */
export const websocketStepSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('SEND'),
    name: z.string().min(1).max(160),
    /** Strings are sent verbatim (after `{{var}}`); anything else is JSON-encoded. */
    payload: z.unknown(),
  }),
  z.object({
    action: z.literal('EXPECT'),
    name: z.string().min(1).max(160),
    /** MATCH scans past non-matching frames; NEXT asserts on the very next one. */
    mode: z.enum(['MATCH', 'NEXT']).default('MATCH'),
    contains: z.string().max(2000).optional(),
    /** Dotted path in the frame's JSON → expected literal. */
    jsonMatches: z.record(z.string(), z.unknown()).optional(),
    matchesRegex: z.string().max(500).optional(),
    /** Name → dotted path, captured off the frame that matched. */
    extract: z.record(z.string(), z.string()).default({}),
    timeoutMs: z.number().int().min(1).max(300_000).default(10_000),
  }),
  z.object({
    action: z.literal('WAIT'),
    name: z.string().min(1).max(160),
    ms: z.number().int().min(0).max(60_000),
  }),
  z.object({
    action: z.literal('CLOSE'),
    name: z.string().min(1).max(160),
    code: z.number().int().min(1000).max(4999).default(1000),
  }),
]);

export const websocketProtocolSpecSchema = z.object({
  protocol: z.literal('WEBSOCKET'),
  /** `ws://`, `wss://`, or a path — a path inherits the base URL's host, http→ws. */
  url: z.string().min(1).max(2000).default('/ws'),
  /** Sent on the upgrade request. Values support `{{var}}` so tokens come from the vault. */
  headers: z.record(z.string(), z.string()).default({}),
  subprotocols: z.array(z.string().max(120)).max(8).default([]),
  variables: protocolVariables,
  openTimeoutMs: z.number().int().min(1).max(120_000).default(10_000),
  steps: z.array(websocketStepSchema).min(1).max(200),
});

// Server-sent events ─────────────────────────────────────────────────────────

export const sseExpectationSchema = z.object({
  name: z.string().min(1).max(160),
  /** The `event:` name. Omit to match any event, including unnamed ones. */
  event: z.string().max(200).optional(),
  dataContains: z.string().max(2000).optional(),
  /** Dotted path in the event's JSON payload → expected literal. */
  jsonMatches: z.record(z.string(), z.unknown()).optional(),
  /** Wait for this many matching events before the step passes. */
  count: z.number().int().min(1).max(1000).default(1),
  timeoutMs: z.number().int().min(1).max(300_000).default(15_000),
  /** Name → dotted path, captured off the last matching event. */
  extract: z.record(z.string(), z.string()).default({}),
});

export const sseProtocolSpecSchema = z.object({
  protocol: z.literal('SSE'),
  path: z.string().min(1).max(2000).default('/events'),
  /** POST streams are common for LLM and agent endpoints, so the method is open. */
  method: z
    .string()
    .transform((m) => m.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]+$/, 'HTTP method must be letters only'))
    .default('GET'),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.unknown().optional(),
  variables: protocolVariables,
  connectTimeoutMs: z.number().int().min(1).max(120_000).default(10_000),
  expect: z.array(sseExpectationSchema).min(1).max(50),
});

// gRPC ───────────────────────────────────────────────────────────────────────

const grpcAssertionsSchema = z.object({
  /** Expected gRPC status name, e.g. `OK`, `NOT_FOUND`, `PERMISSION_DENIED`. */
  status: z.string().max(40).default('OK'),
  /** Dotted path into the decoded response message → expected literal. */
  responseMatches: z.record(z.string(), z.unknown()).optional(),
  responseContains: z.string().max(2000).optional(),
  maxLatencyMs: z.number().int().positive().optional(),
});

export const grpcCallSchema = z.object({
  name: z.string().min(1).max(160),
  /** Fully-qualified `package.Service/Method`. */
  method: z
    .string()
    .min(3)
    .max(300)
    .regex(/^[A-Za-z_][\w.]*\/[A-Za-z_]\w*$/, 'use package.Service/Method'),
  /** The request message. Omit for an empty message. */
  request: z.unknown().optional(),
  /** Call metadata. Values support `{{var}}`, so a token comes from the vault. */
  metadata: z.record(z.string(), z.string()).default({}),
  assertions: grpcAssertionsSchema.default(grpcAssertionsSchema.parse({})),
  extract: z.record(z.string(), z.string()).default({}),
});

export const grpcProtocolSpecSchema = z.object({
  protocol: z.literal('GRPC'),
  /** `host:port`. Defaults to the environment base URL's host. */
  target: z.string().max(300).default(''),
  /** grpcurl defaults to TLS and so does this — opt in to plaintext explicitly. */
  plaintext: z.boolean().default(false),
  /**
   * Server reflection is used when the target exposes it. Point `protoPath` at a
   * committed `.proto` for servers that do not. Workspace-relative: a spec is
   * org-authored data and must not read arbitrary paths off the worker.
   */
  protoPath: relativeFilePath.optional(),
  importPaths: z.array(relativeFilePath).max(10).default([]),
  variables: protocolVariables,
  timeoutSeconds: z.number().int().min(1).max(600).default(60),
  calls: z.array(grpcCallSchema).min(1).max(50),
});

/**
 * A protocol test. Discriminated on `protocol` so an invalid combination cannot
 * be stored — a WEBSOCKET spec has no `operations`, a GRAPHQL spec has no
 * `calls`, and the plugin never has to guess which shape it was handed.
 */
export const protocolTestSpecSchema = z.discriminatedUnion('protocol', [
  graphqlProtocolSpecSchema,
  websocketProtocolSpecSchema,
  sseProtocolSpecSchema,
  grpcProtocolSpecSchema,
]);

export type ProtocolTestSpec = z.infer<typeof protocolTestSpecSchema>;
export type GraphqlProtocolSpec = z.infer<typeof graphqlProtocolSpecSchema>;
export type WebsocketProtocolSpec = z.infer<typeof websocketProtocolSpecSchema>;
export type SseProtocolSpec = z.infer<typeof sseProtocolSpecSchema>;
export type GrpcProtocolSpec = z.infer<typeof grpcProtocolSpecSchema>;

// ─── Contract tests — Pact & OpenAPI (§4) ────────────────────────────────────

/**
 * How the provider (or the broker holding the document) is authenticated.
 *
 * Only the NAME of the vault secret lives in the spec, mirroring the
 * SSO_BYPASS_TOKEN auth profile: a verification can carry a real bearer token
 * without that token ever being written into the file the customer keeps in
 * their repo.
 */
const contractAuthSchema = z.object({
  secretName,
  header: z.string().min(1).max(80).default('Authorization'),
  /** `{token}` is replaced with the secret's value. */
  valueTemplate: z.string().min(1).max(300).default('Bearer {token}'),
});

/**
 * Where a contract document comes from: an http(s) URL (a pact broker, a served
 * `/openapi.json`), or a workspace-relative path — which also resolves against
 * the run's `fixtures/` test data, so a pact can be committed with the tests.
 */
const contractDocumentRef = z
  .string()
  .min(1)
  .max(2000)
  .refine(
    (v) => /^https?:\/\//i.test(v) || (!v.includes('..') && !v.startsWith('/')),
    'use an http(s) URL or a workspace-relative path without ..',
  );

const contractCommonShape = {
  /** The provider under verification. Defaults to the environment's base URL. */
  providerBaseUrl: httpUrl.optional(),
  /** Extra headers sent on every replayed request. */
  headers: z.record(z.string(), z.string()).default({}),
  auth: contractAuthSchema.optional(),
  requestTimeoutSeconds: z.number().int().min(1).max(300).default(30),
};

/**
 * Verify a provider against a consumer's pact.
 *
 * The pact file is the consumer's declaration of what it needs; every
 * interaction in it is replayed against the running provider and the response
 * compared to the expectation. Matching rules are honoured — a pact that
 * demands exact values is a pact nobody can keep green.
 */
export const pactContractSpecSchema = z.object({
  kind: z.literal('pact'),
  pactPath: contractDocumentRef,
  /** When the document holds several consumers, verify only this one. */
  consumer: z.string().max(200).optional(),
  /** Verify only interactions whose description or provider state matches this regex. */
  only: z.string().max(300).optional(),
  /**
   * Provider-state hook. Pact's own protocol: before each interaction QAAI
   * POSTs `{ consumer, state, params, action: "setup" }` here, so the provider
   * can put itself into the state the interaction was recorded against.
   */
  stateChangeUrl: z.string().max(2000).optional(),
  ...contractCommonShape,
});
export type PactContractSpec = z.infer<typeof pactContractSpecSchema>;

/**
 * Check a live API against its own OpenAPI document: call the documented
 * operations and assert the responses conform to the declared schema.
 */
export const openApiContractSpecSchema = z.object({
  kind: z.literal('openapi'),
  specPath: contractDocumentRef,
  /**
   * Which operations to check — `GET /pets/{petId}`, a bare path, or an
   * operationId. Naming an operation is an explicit opt-in, so `methods` is
   * ignored when this is non-empty. Empty means every documented operation
   * whose method is in `methods`.
   */
  operations: z.array(z.string().min(1).max(300)).max(200).default([]),
  /**
   * Read-only by default, and deliberately so: this runs against a live
   * provider, and a contract check that POSTs is a contract check that creates
   * orders. Widen it only for an environment you are happy to mutate.
   */
  methods: z
    .array(
      z
        .string()
        .transform((m) => m.toUpperCase())
        .pipe(z.string().regex(/^[A-Z]+$/, 'HTTP method must be letters only')),
    )
    .min(1)
    .max(8)
    .default(['GET']),
  /** Values for templated path segments, keyed by parameter name. */
  pathParams: z.record(z.string(), z.string()).default({}),
  /** Query sent with every request, on top of any required parameters. */
  query: z.record(z.string(), z.string()).default({}),
  /** Request bodies for operations that need one, keyed by `POST /pets`. */
  bodies: z.record(z.string(), z.unknown()).default({}),
  ...contractCommonShape,
});
export type OpenApiContractSpec = z.infer<typeof openApiContractSpecSchema>;

export const contractTestSpecSchema = z.discriminatedUnion('kind', [
  pactContractSpecSchema,
  openApiContractSpecSchema,
]);
export type ContractTestSpec = z.infer<typeof contractTestSpecSchema>;

// ─── Mutation testing (§4) ───────────────────────────────────────────────────

/**
 * The mutation tools QAAI drives — one per ecosystem.
 *
 * QAAI does not implement a mutation engine. Mutating source correctly (parse,
 * rewrite one operator, rebuild, rerun only the covering tests) is
 * language-specific work each ecosystem has already done, and mutants from a
 * home-grown engine are ones no reviewer trusts. Same build-vs-buy call as k6
 * for load: run the real tool, read the report it already emits.
 */
export const MUTATION_TOOLS = [
  'stryker',
  'stryker-net',
  'pit',
  'mutmut',
  'mutant',
  'go-mutesting',
  'infection',
] as const;
export type MutationTool = (typeof MUTATION_TOOLS)[number];

/** Shown next to the tool picker in the spec editor. */
export const MUTATION_TOOL_LABELS: Record<MutationTool, string> = {
  stryker: 'Stryker — JavaScript / TypeScript',
  'stryker-net': 'Stryker.NET — C#',
  pit: 'PIT — Java, via Maven',
  mutmut: 'mutmut — Python',
  mutant: 'mutant — Ruby',
  'go-mutesting': 'go-mutesting — Go',
  infection: 'Infection — PHP',
};

/** A path a spec supplies that has to stay inside the run workspace. */
const workspaceRelativePath = z
  .string()
  .max(300)
  .refine(
    (p) => !p.startsWith('/') && !p.split(/[\\/]/).includes('..'),
    'must be a relative path inside the workspace',
  );

/**
 * A mutation test.
 *
 * `minScore` is the assertion, and it has a default for the same reason the
 * load thresholds do: a mutation run that reports a score without saying what
 * was acceptable always passes, which is worse than not running it. 60% is a
 * starting bar, not a target — raise it once a suite clears it.
 *
 * `scope` and `timeoutSeconds` are not conveniences. Every mutant reruns the
 * covering tests, so a whole repo takes hours; pointing a run at one module is
 * the difference between a nightly job and an unusable one.
 */
export const mutationTestSpecSchema = z
  .object({
    tool: z.enum(MUTATION_TOOLS).default('stryker'),
    /**
     * What to mutate, in whatever dialect the tool speaks: globs for Stryker and
     * Infection, paths for mutmut, class patterns for PIT, subject expressions
     * for mutant, packages for go-mutesting. Empty means the tool's own
     * configured scope.
     */
    scope: z.array(z.string().min(1).max(300)).max(50).default([]),
    /** The gate: the test fails when the mutation score drops below this percentage. */
    minScore: z.number().min(0).max(100).default(60),
    /** Mutation runs are slow. Default 30 minutes, ceiling 6 hours. */
    timeoutSeconds: z.number().int().min(30).max(21_600).default(1_800),
    /** Working directory inside the workspace. */
    cwd: workspaceRelativePath.default('.'),
    /** Overrides where the tool's report is read from, relative to `cwd`. */
    reportPath: workspaceRelativePath.optional(),
    /** Extra flags appended to the built-in command for the chosen tool. */
    extraArgs: z.array(z.string().max(500)).max(64).default([]),
    /** Escape hatch: run this executable instead of the tool's built-in command. */
    command: z.string().min(1).max(200).optional(),
    /** The complete argv when `command` is set. Never passed through a shell. */
    args: z.array(z.string().max(500)).max(64).default([]),
    env: z.record(z.string(), z.string()).default({}),
    /** Secret names to expose to the child process, resolved from the vault. */
    secretNames: z.array(z.string().max(80)).max(50).default([]),
    /** How many surviving mutants become steps before the list is truncated. */
    maxSurvivorsReported: z.number().int().min(1).max(500).default(100),
  })
  .refine((s) => s.args.length === 0 || s.command !== undefined, {
    path: ['args'],
    message:
      'only applies together with command — use extraArgs to add flags to the built-in command',
  });

export type MutationTestSpec = z.infer<typeof mutationTestSpecSchema>;

// ─── Mobile native tests (§4) ────────────────────────────────────────────────

/**
 * The five ways a team actually tests a native app, and the only five listed in
 * `UI_FRAMEWORKS`. One TestType rather than five, for the reason PROTOCOL is
 * one: they differ in transport, not in shape — install or address an app on a
 * device, drive an ordered sequence of interactions, assert on what the screen
 * shows.
 *
 * APPIUM is driven directly over its W3C HTTP API. The other four are their
 * ecosystem's own CLI and are shelled out to, exactly as LOAD does with k6 and
 * MUTATION does with Stryker: reimplementing `xcodebuild` or Gradle's
 * instrumentation runner is not a thing anyone should attempt, and the report
 * those tools already emit is the one their users trust.
 */
export const MOBILE_DRIVERS = ['APPIUM', 'MAESTRO', 'DETOX', 'ESPRESSO', 'XCUITEST'] as const;
export type MobileDriver = (typeof MOBILE_DRIVERS)[number];

/** Shown next to the driver picker in the spec editor. */
export const MOBILE_DRIVER_LABELS: Record<MobileDriver, string> = {
  APPIUM: 'Appium — Android + iOS, over the W3C protocol',
  MAESTRO: 'Maestro — YAML flows',
  DETOX: 'Detox — React Native',
  ESPRESSO: 'Espresso — Android, via Gradle',
  XCUITEST: 'XCUITest — iOS, via xcodebuild',
};

export const MOBILE_PLATFORMS = ['ANDROID', 'IOS'] as const;
export type MobilePlatform = (typeof MOBILE_PLATFORMS)[number];

/**
 * Locator strategies Appium accepts. The W3C set plus the two platform engines
 * every real suite ends up using — a UiAutomator selector and an iOS predicate
 * are what you reach for when a screen has no accessibility id.
 *
 * `accessibility id` is the default on purpose: it is the one locator that is
 * stable across a redesign, works on both platforms, and improves the app for
 * screen-reader users when a developer has to add it.
 */
export const MOBILE_LOCATOR_STRATEGIES = [
  'accessibility id',
  'id',
  'xpath',
  'class name',
  '-android uiautomator',
  '-ios predicate string',
  '-ios class chain',
] as const;
export type MobileLocatorStrategy = (typeof MOBILE_LOCATOR_STRATEGIES)[number];

export const mobileSelectorSchema = z.object({
  using: z.enum(MOBILE_LOCATOR_STRATEGIES).default('accessibility id'),
  value: z.string().min(1).max(2000),
});
export type MobileSelector = z.infer<typeof mobileSelectorSchema>;

/**
 * One interaction. Every step becomes a cockpit step, so a broken checkout
 * names the tap that never landed rather than "the test failed".
 *
 * String fields support `{{NAME}}`, resolved against the vault first — a login
 * step types a real password without the password being in the spec.
 */
export const appiumStepSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('TAP'),
    name: z.string().min(1).max(160),
    selector: mobileSelectorSchema,
    /** How long to keep looking for the element before giving up. */
    timeoutMs: z.number().int().min(1).max(300_000).default(10_000),
  }),
  z.object({
    action: z.literal('TYPE'),
    name: z.string().min(1).max(160),
    selector: mobileSelectorSchema,
    text: z.string().max(10_000),
    /** Clear the field first. On by default: a rerun otherwise appends. */
    clearFirst: z.boolean().default(true),
    timeoutMs: z.number().int().min(1).max(300_000).default(10_000),
  }),
  z.object({
    action: z.literal('ASSERT_VISIBLE'),
    name: z.string().min(1).max(160),
    selector: mobileSelectorSchema,
    /** Set false to assert the element is NOT on screen. */
    visible: z.boolean().default(true),
    timeoutMs: z.number().int().min(1).max(300_000).default(10_000),
  }),
  z.object({
    action: z.literal('ASSERT_TEXT'),
    name: z.string().min(1).max(160),
    selector: mobileSelectorSchema,
    equals: z.string().max(4000).optional(),
    contains: z.string().max(4000).optional(),
    timeoutMs: z.number().int().min(1).max(300_000).default(10_000),
  }),
  z.object({
    action: z.literal('WAIT'),
    name: z.string().min(1).max(160),
    ms: z.number().int().min(0).max(120_000),
  }),
  /** Coordinates are fractions of the screen (0–1), so one spec fits every device. */
  z.object({
    action: z.literal('SWIPE'),
    name: z.string().min(1).max(160),
    fromX: z.number().min(0).max(1).default(0.5),
    fromY: z.number().min(0).max(1).default(0.7),
    toX: z.number().min(0).max(1).default(0.5),
    toY: z.number().min(0).max(1).default(0.3),
    durationMs: z.number().int().min(50).max(10_000).default(600),
  }),
  /** Android's hardware back button; on iOS the driver rejects it and the step fails. */
  z.object({
    action: z.literal('PRESS_BACK'),
    name: z.string().min(1).max(160),
  }),
  z.object({
    action: z.literal('SCREENSHOT'),
    name: z.string().min(1).max(160),
  }),
]);
export type AppiumStep = z.infer<typeof appiumStepSchema>;

/**
 * A device farm — BrowserStack, Sauce Labs, LambdaTest, Perfecto.
 *
 * Only the NAMES of the vault secrets live here. The endpoint is NOT taken from
 * the spec: it is derived from the provider and host-pinned in the plugin, the
 * same discipline `apps/api/src/lib/git.ts` applies to a push token. A spec is
 * org-authored data that ends up in the customer's repo, and an endpoint read
 * out of it would be an access key handed to whatever host it named.
 */
export const mobileDeviceFarmSchema = z.object({
  provider: z.enum(GRID_INTEGRATION_KINDS),
  usernameSecretName: secretName.default('DEVICE_FARM_USERNAME'),
  accessKeySecretName: secretName.default('DEVICE_FARM_ACCESS_KEY'),
  /** Shown in the provider's dashboard so a session is traceable back to QAAI. */
  buildName: z.string().max(120).default('QAAI'),
  projectName: z.string().max(120).default('QAAI'),
});
export type MobileDeviceFarm = z.infer<typeof mobileDeviceFarmSchema>;

/**
 * Drive a real Appium server over its W3C HTTP API.
 *
 * No new dependency: the protocol is JSON over HTTP, and `appium` itself is a
 * server the worker (or the device farm) runs, not a library QAAI links against.
 */
export const appiumMobileSpecSchema = z
  .object({
    driver: z.literal('APPIUM'),
    platform: z.enum(MOBILE_PLATFORMS),
    /**
     * A self-hosted Appium server. Optional so that setting it together with
     * `deviceFarm` can be rejected rather than silently ignored — see the
     * refinement below.
     */
    serverUrl: z.string().max(2000).optional(),
    deviceFarm: mobileDeviceFarmSchema.optional(),
    /**
     * Appium capabilities. `platformName` comes from `platform`; anything here
     * that is not already a W3C standard capability is given the `appium:`
     * prefix by the plugin, because an unprefixed vendor capability is the most
     * common reason a W3C session is refused.
     */
    capabilities: z.record(z.string(), z.unknown()).default({}),
    /** Convenience for `appium:app` — a path, or the app id the farm assigned. */
    app: z.string().max(2000).optional(),
    /** `{{NAME}}` values for step text, resolved against the vault first. */
    variables: z.record(z.string(), z.string()).default({}),
    /** Per-request ceiling. Session creation gets its own, longer, budget. */
    requestTimeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
    newSessionTimeoutMs: z.number().int().min(1000).max(900_000).default(180_000),
    /** Capture a screenshot when a step fails. The single most useful triage artifact. */
    screenshotOnFailure: z.boolean().default(true),
    steps: z.array(appiumStepSchema).min(1).max(200),
  })
  .refine((s) => !(s.deviceFarm && s.serverUrl), {
    path: ['serverUrl'],
    message:
      'a device farm supplies its own hub endpoint — remove serverUrl, or remove deviceFarm to use your own server',
  });
export type AppiumMobileSpec = z.infer<typeof appiumMobileSpecSchema>;

/**
 * Fields every shelled-out mobile driver shares.
 *
 * `command` is an escape hatch with a real job: the binary is `./gradlew` in one
 * repo and `gradle` in the next, and Maestro is as often invoked through a
 * version manager as it is off PATH. Never passed through a shell.
 */
const mobileCliShape = {
  command: z.string().min(1).max(200).optional(),
  /** The complete argv when `command` is set. */
  args: z.array(z.string().max(500)).max(64).default([]),
  /** Appended to the built-in command line. */
  extraArgs: z.array(z.string().max(500)).max(64).default([]),
  env: z.record(z.string(), z.string()).default({}),
  /** Secret names to expose to the child process, resolved from the vault. */
  secretNames: z.array(secretName).max(50).default([]),
  cwd: workspaceRelativePath.default('.'),
  /** A device build is slow. Default 20 minutes, ceiling 2 hours. */
  timeoutSeconds: z.number().int().min(10).max(7200).default(1200),
};

/** `maestro test` against a flow file or a directory of them. */
export const maestroMobileSpecSchema = z.object({
  driver: z.literal('MAESTRO'),
  flowPath: workspaceRelativePath,
  /** `--device`. Omit to let Maestro pick the only running device. */
  deviceId: z.string().max(120).optional(),
  /** Flow parameters, passed as `-e KEY=VALUE`. */
  flowEnv: z.record(z.string(), z.string()).default({}),
  /** Where `--format junit --output` writes. Read back with the JUnit parser. */
  reportPath: workspaceRelativePath.default('maestro-report.xml'),
  ...mobileCliShape,
});
export type MaestroMobileSpec = z.infer<typeof maestroMobileSpecSchema>;

/** `detox test` — React Native's own harness, driving its own Jest run. */
export const detoxMobileSpecSchema = z.object({
  driver: z.literal('DETOX'),
  /** A `configurations` key from .detoxrc, e.g. `ios.sim.debug`. */
  configuration: z.string().min(1).max(120),
  /** JUnit XML from the Jest reporter, when the project is set up to emit it. */
  reportPath: workspaceRelativePath.optional(),
  ...mobileCliShape,
});
export type DetoxMobileSpec = z.infer<typeof detoxMobileSpecSchema>;

/**
 * Espresso through Gradle. The instrumentation runner already writes JUnit XML
 * under `build/outputs/androidTest-results`, so `reportPath` may name that whole
 * directory — one XML per device, which is what a multi-device run produces.
 */
export const espressoMobileSpecSchema = z.object({
  driver: z.literal('ESPRESSO'),
  gradleTask: z.string().min(1).max(160).default('connectedAndroidTest'),
  /** Gradle module, e.g. `:app`. Prefixed to the task when set. */
  module: z.string().max(120).optional(),
  /** `-Pandroid.testInstrumentationRunnerArguments.class=…`, for a single class. */
  testClass: z.string().max(300).optional(),
  reportPath: workspaceRelativePath.default('app/build/outputs/androidTest-results/connected'),
  ...mobileCliShape,
});
export type EspressoMobileSpec = z.infer<typeof espressoMobileSpecSchema>;

/**
 * XCUITest through xcodebuild.
 *
 * `reportPath` is optional because xcodebuild does not write JUnit itself — a
 * project piping through xcbeautify does. Without one, the plugin reads
 * xcodebuild's own `Test Case '-[Suite test]' passed` lines, which it has
 * printed unchanged for a decade.
 */
export const xcuitestMobileSpecSchema = z
  .object({
    driver: z.literal('XCUITEST'),
    scheme: z.string().min(1).max(160),
    /** One of these, not both — xcodebuild rejects the pair. */
    project: workspaceRelativePath.optional(),
    workspace: workspaceRelativePath.optional(),
    destination: z
      .string()
      .min(1)
      .max(300)
      .default('platform=iOS Simulator,name=iPhone 15,OS=latest'),
    testPlan: z.string().max(160).optional(),
    /** `-only-testing:` entries, e.g. `UITests/CheckoutTests/testApplePay`. */
    onlyTesting: z.array(z.string().min(1).max(300)).max(50).default([]),
    reportPath: workspaceRelativePath.optional(),
    ...mobileCliShape,
  })
  .refine((s) => !(s.project && s.workspace), {
    path: ['workspace'],
    message: 'set project or workspace, not both — xcodebuild accepts only one',
  });
export type XcuitestMobileSpec = z.infer<typeof xcuitestMobileSpecSchema>;

/**
 * A mobile test. Discriminated on `driver` so an impossible combination cannot
 * be stored — a MAESTRO spec has no capabilities, an APPIUM spec has no Gradle
 * task — and the plugin never has to guess which shape it was handed.
 */
export const mobileTestSpecSchema = z.discriminatedUnion('driver', [
  appiumMobileSpecSchema,
  maestroMobileSpecSchema,
  detoxMobileSpecSchema,
  espressoMobileSpecSchema,
  xcuitestMobileSpecSchema,
]);
export type MobileTestSpec = z.infer<typeof mobileTestSpecSchema>;

// ─── Runs (§5) ───────────────────────────────────────────────────────────────

export const createRunSchema = z.object({
  suiteId: z.string().nullish(),
  /**
   * Explicit test ids override the suite. Nullish rather than optional: CLI and
   * CI callers serialise "no selection" as `null`, and rejecting that with a
   * validation error is a bad first experience for something so mechanical.
   */
  testIds: z.array(z.string()).nullish(),
  environmentId: z.string().min(1),
  trigger: z.enum(['MANUAL', 'SCHEDULE', 'CI', 'WEBHOOK', 'MONITOR']).default('MANUAL'),
  commitSha: z.string().nullish(),
  prNumber: z.number().int().nullish(),

  /**
   * Split the suite across this many parallel workers (§5 build sharding).
   *
   * Folded in from a second schema that parsed the same body inside the runs
   * route. Zod objects ignore unknown keys, so that arrangement worked — and it
   * meant the one contract the CLI, the GitHub Action and the web app compile
   * against did not mention the feature at all, so a caller could only discover
   * sharding by reading the server. Absent or 1 keeps the old behaviour
   * exactly: one job, one worker, no shard rows.
   */
  shards: z.number().int().min(1).max(50).nullish(),

  /**
   * The PR's changed files, so a run can execute only the tests that change can
   * actually reach (apps/api/src/lib/impact.ts does the reasoning).
   *
   * Paths exactly as the diff reports them — `git diff --name-only
   * --no-renames`, or GitHub's files API. BOTH SIDES OF A RENAME MUST BE SENT:
   * the analysis reasons about the routes a path serves, and a rename it hears
   * only the new half of reads as "a new page appeared" rather than "the old
   * page is gone", which parks every test that still visits the old URL on the
   * exact commit that 404s them.
   *
   * Omitted or empty means no selection at all — the whole suite runs.
   * Selection is never something a caller gets by accident.
   *
   * The cap is a request-size guard, not the analysis limit: a diff wider than
   * the analysis can attribute is answered with "run everything", never with an
   * error, because a caller with a huge diff wants a safe answer rather than a
   * 400. Matches the cap on POST /impact/analyze so the same array can be sent
   * to either endpoint.
   */
  changedPaths: z.array(z.string().min(1).max(1024)).max(10_000).nullish(),

  /**
   * Let a test whose own code and spec have not changed reuse its previous
   * PASSED result instead of running again.
   *
   * Opt-in per run, and inert without `changedPaths`: "this test has not
   * changed" is only half the question, and the other half — "and nothing in
   * the diff can reach it" — cannot be answered without a diff.
   */
  useCache: z.boolean().nullish(),

  /**
   * How old a passing result may be and still be reused. Configurable because
   * the right number is a property of the deployment rather than of this code:
   * an app that ships once a fortnight can trust a week-old green, and one that
   * ships hourly cannot trust yesterday's. Absent means the server default.
   */
  cacheWindowHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 14)
    .nullish(),

  /**
   * Stop the run at the first real failure, for when the only question is "is
   * this PR safe to merge" and the rest of the suite's answers are not worth
   * the minutes.
   *
   * A flake, a quarantined test and a skipped one are not real failures and
   * stop nothing — a fail-fast that trips on noise is one people turn off.
   */
  failFast: z.boolean().nullish(),
});

// ─── Chat (§3.5) ─────────────────────────────────────────────────────────────

export const chatMessageSchema = z.object({
  projectId: z.string().min(1),
  conversationId: z.string().nullish(),
  message: z.string().min(1).max(8000),
});

// ─── Git integrations & push (§7) ────────────────────────────────────────────

/** An `owner/repo` slug or a full https(s) git URL — never ssh, never a token in the URL. */
const gitRepo = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (r) => /^[\w.-]+\/[\w.-]+$/.test(r) || /^https:\/\/[^\s@]+$/.test(r),
    'use owner/repo or an https:// URL',
  );

/** A git branch name — no spaces, no leading dash, no `..`, no path tricks. */
const gitBranch = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[^\s~^:?*[\\]+$/, 'invalid branch name')
  .refine(
    (b) => !b.includes('..') && !b.startsWith('-') && !b.startsWith('/'),
    'invalid branch name',
  );

export const createIntegrationSchema = z.object({
  kind: z.enum(GIT_INTEGRATION_KINDS),
  name: z.string().min(1).max(80),
  repo: gitRepo,
  /** Personal access token. Write-only: sealed into the vault, never returned. */
  token: z.string().min(1).max(4096),
  defaultBranch: gitBranch.default('qaai/tests'),
});

export const updateIntegrationSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    repo: gitRepo.optional(),
    defaultBranch: gitBranch.optional(),
    enabled: z.boolean().optional(),
    /** Rotate the token. Omit to keep the existing one. */
    token: z.string().min(1).max(4096).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

/**
 * Push a project's materialised repo to a connected integration. `confirm` must
 * be the literal `true`: a network write to the customer's own repo is never
 * implicit, and a stray/replayed request without it is rejected.
 */
export const gitPushSchema = z.object({
  integrationId: z.string().min(1),
  branch: gitBranch.optional(),
  message: z.string().min(1).max(500).optional(),
  confirm: z.literal(true),
});

// ─── Pagination ──────────────────────────────────────────────────────────────

export const pageSchema = z.object({
  cursor: z.string().nullish(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
