/**
 * Zod schemas for everything crossing the wire. The API validates request
 * bodies with these; the agent validates LLM tool-call output with the same
 * ones, so a hallucinated plan item fails exactly like a malformed POST.
 */

import { z } from 'zod';
import {
  AUTH_PROFILE_KINDS,
  ENVIRONMENT_KINDS,
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

export const createProjectSchema = z.object({
  name: z.string().min(1).max(120),
  slug: slug.optional(),
  repoUrl: httpUrl.nullish(),
  primaryLanguage: z.enum(LANGUAGES).default('TYPESCRIPT'),
  primaryFramework: z.enum(UI_FRAMEWORKS).default('PLAYWRIGHT'),
});

export const createEnvironmentSchema = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum(ENVIRONMENT_KINDS),
  baseUrl: httpUrl,
});

export const upsertSecretSchema = z.object({
  /** Env-var style so it can be injected into test processes verbatim. */
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'use SCREAMING_SNAKE_CASE'),
  value: z.string().min(1).max(8192),
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
});

// ─── Chat (§3.5) ─────────────────────────────────────────────────────────────

export const chatMessageSchema = z.object({
  projectId: z.string().min(1),
  conversationId: z.string().nullish(),
  message: z.string().min(1).max(8000),
});

// ─── Pagination ──────────────────────────────────────────────────────────────

export const pageSchema = z.object({
  cursor: z.string().nullish(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
