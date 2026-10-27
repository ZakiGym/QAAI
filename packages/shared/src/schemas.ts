/**
 * Zod schemas for everything crossing the wire. The API validates request
 * bodies with these; the agent validates LLM tool-call output with the same
 * ones, so a hallucinated plan item fails exactly like a malformed POST.
 */

import { z } from 'zod';
/*
 * The scenario-depth vocabularies, imported rather than restated — same
 * argument as every other vocabulary in this file. A `z.enum(['PERSISTENT',
 * …])` written out here is a second list that drifts from the first, and the
 * drift is invisible until a customer cannot save a row.
 */
import {
  BOUNDARY_CLASSES,
  BOUNDARY_CONSTRAINTS,
  BOUNDARY_EXPECTATIONS,
  BOUNDARY_DESCRIPTORS,
  BOUNDARY_RISKS,
} from './boundaries';
import {
  DESTRUCTIVE_STEP_KINDS,
  PRINCIPAL_KINDS,
  PRINCIPAL_LIFECYCLES,
} from './principals';
import { CLEANUP_OBLIGATIONS, UNIQUENESS_SCOPES } from './synthetic';
import {
  PAYMENT_OUTCOMES,
  TEST_VALUE_EVIDENCE,
  TEST_VALUE_KINDS,
  TEST_VALUE_PROVIDERS,
} from './test-values';
import {
  AUTH_PROFILE_KINDS,
  CHAT_INTEGRATION_KINDS,
  ENVIRONMENT_KINDS,
  GIT_INTEGRATION_KINDS,
  GRID_INTEGRATION_KINDS,
  LANGUAGES,
  NOT_RUN_KINDS,
  ORG_ROLES,
  PRIORITIES,
  RUN_FINISHED_PREFS,
  TEST_RESULT_STATUSES,
  TEST_TYPES,
  UI_FRAMEWORKS,
  VERDICTS,
  isSupportedPair,
  pairMessage,
} from './constants';
import {
  ACCESS_OUTCOMES,
  CRAWL_ACCEPTANCE_STATES,
  CRAWL_CAPS,
  CRAWL_DEGRADATIONS,
  DEFAULT_CRAWL_POLICY,
  ENUMERATION_OUTCOMES,
  EXCLUSION_KINDS,
  EXTERNAL_KINDS,
  NODE_STATUS_CLASSES,
  SELECTOR_STRATEGIES,
} from './flow-map';
/*
 * The surface vocabularies, imported rather than restated — same argument as
 * `FINDING_SEVERITIES` below. A `z.enum(['CRAWL', 'SOURCE', ...])` written out
 * here would be a second copy of the declarer list, and the first thing a
 * second copy does is stop matching: a source added to SURFACE_SOURCES and not
 * to the schema is a declarer no customer can record, which is precisely the
 * shape of the eight unsaveable gate kinds.
 */
import {
  SURFACE_DIMENSION_KINDS,
  SURFACE_EXERCISABILITIES,
  SURFACE_KINDS,
  SURFACE_SOURCES,
  UNEXERCISABLE_REASONS,
} from './surface';
/*
 * The coverage ladder, imported rather than restated — the same argument as the
 * surface vocabularies above, and sharper here because this is the ONLY write
 * path to `TestCoverageEdge.tier`. A `z.enum(['DECLARED', …])` written out here
 * would be a second copy of the ladder, and the first thing a second copy does
 * is stop matching: a rung added to COVERAGE_TIERS and not to the schema is a
 * rung no writer can ever store, which is exactly the shape of the eight
 * unsaveable gate kinds. coverage-tiers.test.ts compares these enums' own
 * options back against these lists for that reason; this file's own test
 * asserts the refusals instead.
 */
import {
  COVERAGE_EDGE_SOURCES,
  COVERAGE_TIERS,
  DEFAULT_COVERAGE_FRESHNESS_DAYS,
  TIER_CAP_REASONS,
} from './coverage-tiers';
/*
 * The dimension vocabularies, imported and not restated, for the third time in
 * this file and with one addition worth naming: `CELL_KIND_DIMENSION`,
 * `rollupScopeKey` and `deltaIsMeaningful` are imported as VALUES, not just the
 * lists.
 *
 * That is the point. `coverageItemStateSchema` refuses a form cell kind by
 * asking the record which dimension the kind belongs to, rather than listing
 * the state kinds a second time; `coverageRollupSchema` refuses a `scopeKey`
 * that disagrees with its own columns by rebuilding it with the one key
 * function; and `coverageHistorySchema` refuses a delta by asking the one
 * comparability predicate. A refinement that reimplemented any of the three
 * would be a second opinion about the same fact, and the first thing a second
 * opinion does is diverge — which here means two spellings of a cell key, or a
 * delta the API refuses and the digest prints.
 *
 * coverage-dimensions.ts does NOT import this file, so there is no cycle.
 */
import {
  CELL_KIND_DIMENSION,
  COVERAGE_CELL_KINDS,
  COVERAGE_DIMENSIONS,
  DEPLOYMENT_CAPABILITY_STATUSES,
  DIMENSION_UNMEASURED_REASONS,
  FAULT_DETECTION_OUTCOMES,
  MINIMUM_BACKTEST_DEFECTS,
  SELF_DEPLOYMENT,
  SNAPSHOT_COMPARABILITIES,
  VALIDITY_VERDICTS,
  deltaIsMeaningful,
  rollupScopeKey,
} from './coverage-dimensions';
import type { CoverageDimensionKind } from './coverage-dimensions';
/*
 * The findings vocabulary, imported rather than restated. `MAX_FINDINGS` selects
 * on a severity and a kind, and a `z.enum` here that spelled its own four
 * severities would be a THIRD copy of a list the plugins already emit and
 * types.ts already names — which is how a gate comes to block on a severity the
 * cockpit renders below the threshold.
 *
 * types.ts imports this module back, but with `import type` only (it wants
 * `PerformanceMetric`), and `verbatimModuleSyntax` erases that, so the module
 * graph that executes is schemas → types → constants with no cycle. Keep it
 * that way: a value import there would close the loop, and in ESM the loser of
 * that race reads an uninitialised binding.
 */
import {
  COVERAGE_CRITICALITIES,
  FINDING_KINDS,
  FINDING_SEVERITIES,
  METRIC_DIRECTIONS,
  METRIC_UNITS,
  UNVARIED,
} from './types';

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

/**
 * Signup, in two shapes that share one route.
 *
 * Without an invite the caller names an organisation and becomes its OWNER.
 * With one, the organisation already exists and `orgName` is meaningless — so it
 * is not merely optional, it is REFUSED, because accepting and ignoring it is
 * how a field ends up looking like it does something.
 *
 * This union is the fix for a real bug: `POST /settings/invites` has always
 * minted `…/signup?invite=<token>`, and signup unconditionally created a brand
 * new organisation. Every invited teammate landed in their own private org
 * rather than the one that invited them, and `Invite.acceptedAt` was never
 * written by any code path. A non-strict `z.object` was part of why it went
 * unnoticed: a request carrying `invite` had the field silently stripped.
 */
const signupBase = {
  email: z.string().email().max(254),
  password: z.string().min(12, 'use at least 12 characters').max(200),
  name: z.string().min(1).max(120),
};

export const signupSchema = z.union([
  z
    .object({
      ...signupBase,
      /** Creating the first org inline keeps signup to one screen. */
      orgName: z.string().min(1).max(120),
      invite: z.undefined().optional(),
    })
    .strict(),
  z
    .object({
      ...signupBase,
      /** The raw token from the invite link. The org comes from the invite. */
      invite: z.string().min(1),
      orgName: z.undefined().optional(),
    })
    .strict(),
]);
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

// ─── Passwords ───────────────────────────────────────────────────────────────
//
// Until now a password could be set at signup and never again. There was no
// reset, no change, and no admin path either — a customer who forgot theirs was
// locked out of their organisation permanently, and for an org whose only OWNER
// forgot it, the account was simply dead.

export const requestPasswordResetSchema = z.object({
  email: z.string().email().max(254),
});

export const resetPasswordSchema = z.object({
  /** The raw token from the emailed link; the stored copy is a hash. */
  token: z.string().min(1),
  password: z.string().min(12, 'use at least 12 characters').max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12, 'use at least 12 characters').max(200),
});

/**
 * Changing a member's role.
 *
 * Deliberately its own schema rather than a partial of inviteSchema: the email
 * identifies an invite, and a userId identifies a member. Sharing one shape
 * across both invited them to be confused at the call site.
 */
export const updateMemberSchema = z.object({
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
    if (!isSupportedPair(value.primaryLanguage, value.primaryFramework)) {
      ctx.addIssue({
        code: 'custom',
        path: ['primaryFramework'],
        message: pairMessage(value.primaryLanguage, value.primaryFramework),
      });
    }
  });

/**
 * Change an app's name, language or framework after it exists.
 *
 * The first-run funnel promises, on every step, that none of its choices are
 * binding — "you can change any of this in Setup later". Until this existed
 * that sentence was false for the two choices the funnel makes most loudly:
 * `Project.primaryLanguage` and `primaryFramework` were writable exactly once,
 * at create time, and the only escape was to archive the app and start again.
 *
 * Every field is optional and the pair rule is deliberately NOT enforced here:
 * a request may legitimately send only a language, and whether the RESULT is a
 * supported pair depends on the row this merges into. The route re-checks the
 * merged pair — validating the fragment would either reject a valid partial
 * update or wave through an invalid combination, and it is the stored row that
 * the generator reads.
 */
export const updateProjectSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    primaryLanguage: z.enum(LANGUAGES).optional(),
    primaryFramework: z.enum(UI_FRAMEWORKS).optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'nothing to update',
  );

/**
 * The name of an on-prem runner pool, wherever one is named.
 *
 * Shared by runner registration and by the environment that points at a pool,
 * because those two strings are compared with `===` (see `servesPool` in
 * apps/api/src/lib/runners.ts) and a rule that lives on only one side is a rule
 * that lets `"staging "` be registered and `"staging"` be pointed at, with no
 * error anywhere and a queue that never drains.
 *
 * Trimmed rather than rejected-on-whitespace: the value is pasted or typed by a
 * human into a form, and a trailing space is a slip, not an intent. NOT
 * lowercased — a pool name is a label an operator chose for a network segment,
 * and case-folding "EU-Staging" behind their back is a different kind of
 * surprise.
 */
export const runnerPoolName = z.string().trim().min(1).max(64);

export const createEnvironmentSchema = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum(ENVIRONMENT_KINDS),
  baseUrl: httpUrl,
  /**
   * Execute this environment's runs on the customer's own agents instead of
   * QAAI's workers (ENTERPRISE). Null — the default — means the cloud pool.
   *
   * Nullable, not merely optional, because clearing it is a real edit: an
   * environment that stops being unreachable goes back to the shared workers,
   * and `undefined` cannot express that on the PATCH below.
   */
  runnerPool: runnerPoolName.nullish(),
});

/** Rename / repoint an environment. Kind is immutable — LOCAL vs PRODUCTION is a
 *  meaningful identity, not an editable label. */
export const updateEnvironmentSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    baseUrl: httpUrl.optional(),
    /** See createEnvironmentSchema. `null` moves the environment back to the cloud pool. */
    runnerPool: runnerPoolName.nullish(),
  })
  .refine(
    (v) => v.name !== undefined || v.baseUrl !== undefined || v.runnerPool !== undefined,
    'nothing to update',
  );

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
  /**
   * The coverage gap this item was minted to close — `CoverageGap.id`, a stable
   * hash of (kind, subject), so the next analysis produces the same id for the
   * same gap.
   *
   * It existed as `PlanItem.gapId` in the database and nowhere in the wire
   * shape, so the two writers (apps/api/src/routes/coverage.ts and
   * apps/worker/src/processors/close-loop.ts) each attached it by hand after
   * this schema had already parsed the item and dropped it. A column written
   * around its own validator is a column that will eventually be written
   * wrong.
   *
   * `.nullable().default(null)` rather than required, and nullable forever: the
   * Explorer proposes a cold plan from a crawl with no gap behind it, and a
   * back-filled id would invent a provenance that never existed. Null here
   * means "not minted for a gap" — it is not a missing value to be guessed at.
   */
  gapId: z.string().nullable().default(null),
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

/**
 * An AuthProfile id, as a test's role binding (§2).
 *
 * `null` is a legitimate value and not a missing one: most tests have no
 * business signing in, and the API must be able to say "this test is
 * anonymous" as distinctly as it says "this test is the admin". So the field is
 * NULLABLE everywhere it appears, and on `updateTestSchema` it is additionally
 * OPTIONAL — omitting it leaves the binding alone, while sending `null`
 * deliberately clears it. Collapsing those two into one would make every save
 * from a client that predates this field silently un-bind the test.
 *
 * Bounded rather than open: the value is a cuid the API looks up, and a
 * megabyte of string in a `where` clause is not a lookup.
 */
const authProfileId = z.string().min(1).max(64);

/**
 * WHAT THIS TEST IS FOR, SAID OUT LOUD — surface keys the test claims to cover.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * The numerator was derived entirely by regex over test source. Many tests are
 * simply unreadable to that extractor — a page object, a fixture-driven table
 * test, a helper that builds its URL from a factory — and there was NO WAY, for
 * a human or for our own generator, to state what a test is for. The product
 * asked customers to believe a coverage number and gave them no way to correct
 * it.
 *
 * ── A DECLARATION IS A CLAIM, NOT PROOF ─────────────────────────────────────
 *
 * This is the AUTHORITATIVE numerator in the sense that it beats a regex's
 * guess about intent. It is the WEAKEST evidence in the sense that matters for
 * the number: it feeds a `SPEC` edge, whose ceiling is `DECLARED`
 * (`COVERAGE_EDGE_SOURCE_CEILING`), so it can never reach PASSING without a
 * run observing the test. If it could, `covers: ['ROUTE:/billing']` would be a
 * one-line way to manufacture a green coverage report, and this field would be
 * the largest hole in the product rather than the fix for one.
 *
 * ── THE BOUNDS, AND WHY THERE ARE ANY ───────────────────────────────────────
 *
 * 100 keys and 500 characters each. A declaration is stored in a `TEXT[]`
 * column and expanded into one edge row per key on every run finalisation, so
 * an unbounded array is both a row explosion and a `where key in (…)` with a
 * megabyte of strings in it. 100 is far more than any honest test covers; a
 * test that claims more is describing a suite.
 */
const coversDeclaration = z.array(z.string().min(1).max(500)).max(100);

export const updateTestSchema = z.object({
  code: z.string().max(500_000),
  name: z.string().min(1).max(160).optional(),
  /** Type-specific config for the non-Playwright plugins (API, a11y, security). */
  spec: z.unknown().optional(),
  /** Shown in the version history. */
  message: z.string().max(300).optional(),
  /**
   * Re-bind, or clear, the role this test runs as. Omit to leave it as it is —
   * see the note on `authProfileId` above.
   */
  authProfileId: authProfileId.nullable().optional(),
  /**
   * "This test is meaningless signed out." Stored separately from the binding
   * so that deleting the profile (which nulls `authProfileId` by foreign key)
   * cannot erase the fact that a role was asked for. A test left with
   * `authProfileRequired: true` and no profile is reported as a broken binding
   * rather than quietly running anonymously and passing.
   */
  authProfileRequired: z.boolean().optional(),
  /**
   * Re-declare what this test covers. OPTIONAL and NOT nullable, which is a
   * different choice from `authProfileId` above and the difference is the
   * point: omitting it leaves the declaration alone, and sending `[]`
   * deliberately clears it. There is no third state to express — "no
   * declaration" and "an empty declaration" are the same fact about a test —
   * so a nullable would add a value with no meaning, and every client that
   * predates this field keeps saving without silently erasing a declaration
   * somebody made.
   */
  covers: coversDeclaration.optional(),
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
  /** The role this test runs as; null (the default) is anonymous. */
  authProfileId: authProfileId.nullable().default(null),
  /** See `updateTestSchema.authProfileRequired`. */
  authProfileRequired: z.boolean().default(false),
  /**
   * What this test covers, as the author or the generator declares it. Defaults
   * to empty — a test that declares nothing is the ordinary case and always
   * will be, and the STATIC extractor still has its say about it.
   */
  covers: coversDeclaration.default([]),
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

/**
 * What a MODEL may propose — which is why there is no RETIRE here while
 * `HealProposal.riskLevel` in types.ts has one.
 *
 * This schema is handed to `llm.structured` (packages/agent/src/healer.ts), so
 * every member of it is something a model is being invited to choose. RETIRE
 * means "this test should stop existing", it is minted by the deterministic
 * obsolescence detector (`apps/worker/src/processors/flake.ts`) and never by a
 * prompt, and `isAutoApprovable` refuses it by name. Adding it here to make the
 * two lists match would let a model retire a customer's test — the one mistake
 * in this feature that is unrecoverable.
 */
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

// ─── Accessibility & security smoke — authoring schemas (§4) ─────────────────

/**
 * The two plugins these describe (accessibility.ts, security-smoke.ts) parse
 * `test.spec` by hand and are slightly MORE permissive than this — the a11y
 * plugin silently drops non-string routes, for example. These schemas are the
 * strict authoring subset the Generator is held to: anything valid here is
 * valid there, so a generated spec can never be one the plugin rejects.
 * apps/worker/src/processors/generate.test.ts pins that subset relationship
 * against each plugin's own validate().
 */
export const accessibilityTestSpecSchema = z.object({
  /** Routes the axe scan visits. The plugin refuses an empty list. */
  routes: z.array(z.string().min(1)).min(1).max(50),
  /** axe rule tags. Omitted means the plugin's WCAG 2.1 AA default. */
  tags: z.array(z.string().min(1)).max(20).optional(),
});
export type AccessibilityTestSpec = z.infer<typeof accessibilityTestSpecSchema>;

const idorProbeSchema = z.object({
  /** Path template containing `{id}`, e.g. `/orders/{id}`. */
  template: z
    .string()
    .min(1)
    .refine((t) => t.includes('{id}'), 'must contain the {id} placeholder'),
  /** Object ids fetched anonymously through the template. */
  ids: z.array(z.string().min(1)).min(1).max(50),
  /** A 2xx whose body contains this marks the probe as an exposure. */
  mustNotContain: z.string().min(1).optional(),
});

export const securitySmokeSpecSchema = z
  .object({
    /** Paths that must NOT be reachable without a session. */
    authRequiredPaths: z.array(z.string().min(1)).max(100).default([]),
    idorProbes: z.array(idorProbeSchema).max(50).default([]),
    /** Paths whose response headers and cookies are inspected. */
    headerPaths: z.array(z.string().min(1)).max(100).default([]),
  })
  .refine(
    (s) => s.authRequiredPaths.length + s.idorProbes.length + s.headerPaths.length > 0,
    'must define at least one check — authRequiredPaths, idorProbes, or headerPaths',
  );
export type SecuritySmokeSpec = z.infer<typeof securitySmokeSpecSchema>;

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
 * The metrics a PERFORMANCE test can put a budget on.
 *
 * LOAD answers "how many requests per second does the server survive". None of
 * these answer that, and that is the point: a page that serves in 20ms and
 * paints in four seconds passes every server-side test ever written. These are
 * what the person holding the laptop experiences.
 *
 * Every one is "lower is better", which is what lets the plugin treat them
 * uniformly: a budget is always a ceiling and exceeding it always fails.
 */
export const PERFORMANCE_METRICS = ['lcpMs', 'clsScore', 'inpMs', 'tbtMs', 'fcpMs', 'ttfbMs'] as const;
export type PerformanceMetric = (typeof PERFORMANCE_METRICS)[number];

export const PERFORMANCE_METRIC_LABELS: Record<PerformanceMetric, string> = {
  lcpMs: 'LCP — largest contentful paint',
  clsScore: 'CLS — cumulative layout shift',
  inpMs: 'INP — interaction to next paint',
  tbtMs: 'TBT — total blocking time',
  fcpMs: 'FCP — first contentful paint',
  ttfbMs: 'TTFB — time to first byte',
};

/** Units, so a step can say "2100ms" and "0.14" rather than a bare number. */
export const PERFORMANCE_METRIC_UNITS: Record<PerformanceMetric, 'ms' | 'score'> = {
  lcpMs: 'ms',
  clsScore: 'score',
  inpMs: 'ms',
  tbtMs: 'ms',
  fcpMs: 'ms',
  ttfbMs: 'ms',
};

// ─── The gate rules themselves ───────────────────────────────────────────────

/**
 * What a rule does when it is not satisfied. Configuration, so only two
 * members: PASS and UNMEASURED are OUTCOMES the evaluator decides, and a rule
 * that could be configured to "pass" would be a rule that does nothing.
 */
const gateAction = z.enum(['WARN', 'BLOCK']);

/** A percentage floor or ceiling, 0–100 inclusive. */
const gatePercent = z.number().min(0).max(100);

/**
 * The rules that decide whether a run blocks a deploy.
 *
 * A discriminated union so an invalid combination cannot be stored: a
 * BLOCK_ON_VERDICT rule has no rate, and a MAX_FLAKE_RATE rule has no verdict.
 * These have lived on Project.gateRules as untyped JSON with no way to edit
 * them — the product's teeth, configurable only by hand-editing the database.
 *
 * ── THIS SCHEMA IS THE ONLY WRITE PATH, AND IT WAS FOUR KINDS BEHIND ────────
 *
 * PUT /projects/:projectId/gate-rules parses through it (apps/api/src/routes/
 * projects.ts) and nothing else writes `Project.gateRules`. Seven members were
 * added to `GateRule` in types.ts and not here, so every one of them was
 * REFUSED on the way in: the six measurement rules — the ones that gate on
 * coverage, patch coverage, mutation score, findings and vitals, which is to
 * say everything QAAI measures besides the suite — plus the environment
 * evaluation, could not be saved by any customer. The whole feature was
 * reachable only by hand-editing a database row.
 *
 * `check:wiring` cannot see this class of break, and that is worth stating
 * plainly: it looks for a FILE nobody reaches. A union member with no write
 * path is live code in a reached file, so nothing flagged it and nothing would
 * flag the next one. `GATE_RULE_KINDS` in types.ts and the parity test in
 * schemas.test.ts are what close it: the kinds list cannot be written without
 * naming every union member, and the test asserts this union's options are
 * exactly that list.
 *
 * Every vocabulary here is imported — verdicts and priorities from
 * constants.ts, severities and kinds from types.ts, metrics from the block
 * above — so a gate can never be configured against a word nothing in the
 * product produces.
 */
export const gateRuleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('BLOCK_ON_VERDICT'),
    verdict: z.enum(VERDICTS),
    onlyPriorities: z.array(z.enum(PRIORITIES)).default([]),
  }),
  z.object({
    kind: z.literal('MAX_FLAKE_RATE'),
    ratePercent: gatePercent,
    action: gateAction,
  }),
  z.object({
    kind: z.literal('MAX_P95_LATENCY_MS'),
    ms: z.number().int().positive().max(600_000),
    action: gateAction,
  }),
  z.object({
    kind: z.literal('MIN_PASS_RATE'),
    ratePercent: gatePercent,
    action: gateAction,
  }),
  /*
   * Appended by the evaluator rather than configured by a project — see the
   * member's own note in types.ts — and accepted here anyway, because THE
   * UNION IS THE DOMAIN. A kind this schema refuses is a rule the product can
   * hold and the product's only validator cannot check, which is the defect
   * this whole schema exists to close; "a project would not normally send it"
   * is not the same statement as "it is invalid".
   *
   * Saving one is also meaningful rather than inert: `scoreRule` in
   * packages/runner/src/gates.ts has a real arm for it, so a project writing
   * its own stricter quarantine ceiling gets it scored. The evaluator's own
   * appended copy is what cannot be deleted.
   */
  z.object({
    kind: z.literal('MAX_QUARANTINE_PERCENT'),
    percent: gatePercent,
    action: gateAction,
  }),
  // ── The measurement rules: everything QAAI measures beside the suite ──────
  z.object({
    kind: z.literal('MIN_COVERAGE'),
    percent: gatePercent,
    action: gateAction,
  }),
  z.object({
    kind: z.literal('MIN_PATCH_COVERAGE'),
    percent: gatePercent,
    action: gateAction,
  }),
  z.object({
    kind: z.literal('MIN_MUTATION_SCORE'),
    percent: gatePercent,
    action: gateAction,
  }),
  z.object({
    kind: z.literal('NO_NEW_UNCOVERED_ROUTES'),
    action: gateAction,
  }),
  z.object({
    kind: z.literal('MAX_FINDINGS'),
    atOrAbove: z.enum(FINDING_SEVERITIES),
    /** Empty means every kind, which is why the default is `[]` and not null. */
    onlyKinds: z.array(z.enum(FINDING_KINDS)).default([]),
    /**
     * `0` is the value most teams want with `atOrAbove: 'CRITICAL'`, so the
     * floor is 0 and not 1. The ceiling is a sanity bound on a stored integer,
     * not a product limit.
     */
    max: z.number().int().min(0).max(10_000),
    action: gateAction,
  }),
  z.object({
    kind: z.literal('MAX_VITAL_BREACHES'),
    /** One metric, or every one of them. Never a threshold — see the member. */
    metric: z.union([z.literal('ANY'), z.enum(PERFORMANCE_METRICS)]),
    max: z.number().int().min(0).max(1_000),
    action: gateAction,
  }),
  /*
   * Also evaluator-appended, and accepted for the same "the union is the
   * domain" reason — but with a cost that has to be said out loud, because it
   * is the opposite of the one above.
   *
   * `GateInput` carries no environment signal. The real evaluation is built by
   * the run finaliser, which knows which tests were blocked and why
   * (`ENVIRONMENT_GATE_RULE` in apps/worker/src/processors/run.ts). So a
   * project that saves this rule gets an UNMEASURED evaluation from
   * `scoreRule` — never a PASS, which would be a gate certifying an
   * environment it has no input about. Accepting it here keeps the validator
   * complete; it does not make it a useful thing to configure.
   */
  z.object({
    kind: z.literal('ENVIRONMENT_AVAILABLE'),
    action: gateAction,
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

// ─── Chat & webhook integrations (§7) ────────────────────────────────────────

/**
 * Which events reach one integration. Both fields have defaults, so an absent
 * preference parses to today's behaviour: failing runs and the digest.
 */
export const notifyPrefsSchema = z.object({
  runFinished: z.enum(RUN_FINISHED_PREFS).default('failures'),
  digest: z.boolean().default(true),
});

/** The same two fields, all optional — a PATCH names only what it changes. */
export const notifyPrefsPatchSchema = z.object({
  runFinished: z.enum(RUN_FINISHED_PREFS).optional(),
  digest: z.boolean().optional(),
});

/**
 * The URL is only length-checked here. The real validation — https, pinned
 * provider host, no internal names — lives in
 * apps/api/src/lib/chat-integrations.ts, because its error messages must be
 * written to never echo the URL back (the URL is the credential), and zod's
 * refine messages would be tempted to.
 */
export const createChatIntegrationSchema = z.object({
  kind: z.enum(CHAT_INTEGRATION_KINDS),
  name: z.string().min(1).max(80),
  /** The incoming-webhook URL. Write-only: sealed into the vault, never returned. */
  url: z.string().min(1).max(2048),
  /** WEBHOOK only: HMAC-SHA256 signing secret. Write-only, like the URL. */
  secret: z.string().min(8).max(256).optional(),
  notify: notifyPrefsSchema.optional(),
});

export const updateChatIntegrationSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    enabled: z.boolean().optional(),
    /** Rotate the webhook URL. Omit to keep the existing one. */
    url: z.string().min(1).max(2048).optional(),
    /** WEBHOOK only: rotate the signing secret. Omit to keep the existing one. */
    secret: z.string().min(8).max(256).optional(),
    notify: notifyPrefsPatchSchema.optional(),
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

// ─── Data-driven datasets (§4) ───────────────────────────────────────────────

/**
 * The ceiling on rows in one data-driven test.
 *
 * A dataset is a multiplier on everything a test does — requests, artifacts,
 * step rows, triage tokens — so an unbounded one is a way to turn a typo in a
 * generated range into an afternoon of queue. 1000 is far above every real
 * dataset (thirty discount codes, eight currencies, the boundary values of a
 * form) and far below the point where a run stops being reviewable.
 *
 * Enforced by the runner rather than by this schema on purpose: an oversized
 * dataset is a configuration gap, and the runner reports those as SKIPPED with
 * the count and this ceiling. Rejecting it here would surface as a FAILED test,
 * which blames the application under test for a spec that never executed.
 */
export const MAX_DATASET_ROWS = 1000;

/**
 * A column name must be usable as a `{{placeholder}}`, because that is the only
 * way a row's value can ever reach a request. Substitution is by NAME — the
 * template is never compiled, evaluated, or built from data — so a column that
 * cannot be a name is rejected here rather than silently never matching.
 */
const datasetColumn = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'a column name must start with a letter or underscore and contain only letters, digits and underscores, because it is used as a {{placeholder}}',
  );

/** Scalars only. An object in a cell has no meaning in a `{{placeholder}}`. */
const datasetValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const datasetBase = z.object({
  /**
   * Which column names a row in the summary. "case 17 of 30" tells a human
   * nothing; `case "SAVE10"` tells them which discount code broke.
   *
   * Optional: the runner falls back to a conventionally-named column and then
   * to the first column.
   */
  keyColumn: datasetColumn.optional(),
});

export const datasetSchema = z.discriminatedUnion('source', [
  datasetBase.extend({
    source: z.literal('inline'),
    /** Bounded by the runner, not here — see MAX_DATASET_ROWS. */
    rows: z.array(z.record(datasetColumn, datasetValue)),
  }),
  datasetBase.extend({
    source: z.literal('file'),
    /**
     * Relative to the run workspace, normally under `fixtures/`. Read out of the
     * run's test data (RunContext.fixtures), never off the worker's disk, so
     * there is no path for a spec to read a file it did not commit.
     */
    path: z
      .string()
      .min(1)
      .max(400)
      .refine(
        (p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..'),
        'must be a relative path inside the run workspace, e.g. fixtures/discounts.csv',
      ),
    format: z.enum(['auto', 'csv', 'json']).default('auto'),
  }),
  datasetBase.extend({
    source: z.literal('range'),
    /** The generated column, e.g. `quantity`. */
    column: datasetColumn,
    from: z.number(),
    to: z.number(),
    /**
     * Positive, so a range always terminates. The runner refuses a descending
     * range and one whose row count exceeds the ceiling — both as configuration
     * gaps rather than as failures of the application under test.
     */
    step: z.number().positive().default(1),
  }),
]);

export type DatasetConfig = z.infer<typeof datasetSchema>;

// ─── Performance budgets — Core Web Vitals (§4) ───────────────────────────────

/*
 * The vitals vocabulary used to be declared here, under this header. It now
 * sits above `gateRuleSchema` in the Quality gates section, because that schema
 * reads it: a `const` referenced 1,300 lines before its own initialiser is a
 * temporal dead zone, and the symptom is not a type error — it is the whole
 * @qaai/shared barrel throwing "Cannot access 'PERFORMANCE_METRICS' before
 * initialization" at import time, on every page of the web app.
 */

/**
 * Resource classes a byte budget can be set on.
 *
 * Bytes are here because they are the number a team can act on. "LCP regressed
 * by 300ms" starts an investigation; "the JS bundle grew by 180 KB" names the
 * commit. `total` is every request the page made, `document` is the HTML itself.
 */
export const PERFORMANCE_RESOURCE_TYPES = [
  'js',
  'css',
  'image',
  'font',
  'media',
  'document',
  'other',
  'total',
] as const;
export type PerformanceResourceType = (typeof PERFORMANCE_RESOURCE_TYPES)[number];

export const PERFORMANCE_RESOURCE_LABELS: Record<PerformanceResourceType, string> = {
  js: 'JavaScript',
  css: 'CSS',
  image: 'Images',
  font: 'Fonts',
  media: 'Audio / video',
  document: 'HTML document',
  other: 'Other',
  total: 'All resources',
};

/**
 * Budgets, defaulted to the thresholds web.dev publishes as "good".
 *
 * Defaults exist for the same reason `loadTestSpecSchema.thresholds` has them: a
 * performance test that reports numbers without saying what was acceptable
 * always passes, which is worse than not running it. `null` on any metric turns
 * its gate off — the number is still measured and still reported, it just stops
 * deciding the verdict.
 */
const performanceBudgetsSchema = z.object({
  /** Largest contentful paint. web.dev "good" is ≤2500ms. */
  lcpMs: z.number().int().positive().max(600_000).nullable().default(2500),
  /** Cumulative layout shift, unitless. web.dev "good" is ≤0.1. */
  clsScore: z.number().min(0).max(100).nullable().default(0.1),
  /** Interaction to next paint. Only measurable when `interactions` are set. */
  inpMs: z.number().int().positive().max(600_000).nullable().default(200),
  /** Total blocking time — the lab stand-in for responsiveness. */
  tbtMs: z.number().int().nonnegative().max(600_000).nullable().default(200),
  /** First contentful paint. */
  fcpMs: z.number().int().positive().max(600_000).nullable().default(1800),
  /** Time to first byte. */
  ttfbMs: z.number().int().positive().max(600_000).nullable().default(800),
});

/** Kilobytes over the wire (transfer size, i.e. after compression). */
const kilobytes = z.number().positive().max(10_000_000).nullable().default(null);

/**
 * Byte budgets are OFF by default, unlike the metric budgets above.
 *
 * A "good" LCP is a number the web platform agrees on. A "good" JS payload is
 * not — 400 KB is lean for a mapping app and obese for a blog — so inventing a
 * default here would produce failures nobody asked for. Unbudgeted classes are
 * still measured and still reported; they just do not gate.
 */
const performanceByteBudgetsSchema = z.object({
  js: kilobytes,
  css: kilobytes,
  image: kilobytes,
  font: kilobytes,
  media: kilobytes,
  document: kilobytes,
  other: kilobytes,
  total: kilobytes,
});

/**
 * Network shaping presets, in Chrome DevTools' own numbers so a budget written
 * against "fast-3g" means the same thing here as it does in the Network panel.
 */
export const PERFORMANCE_NETWORK_PRESETS = ['none', 'slow-3g', 'fast-3g', 'slow-4g'] as const;
export type PerformanceNetworkPreset = (typeof PERFORMANCE_NETWORK_PRESETS)[number];

/**
 * A defined machine profile is what makes a budget portable.
 *
 * Unthrottled numbers are a property of the CI box, not of the site: the same
 * page clears a 2500ms LCP budget on a developer's laptop and blows it on a
 * shared runner, and the team learns to ignore the test. Pinning CPU and
 * network makes the budget mean something everywhere — at the cost of amplifying
 * contention on a busy box, which is why `iterations` and the median matter more
 * once this is on, not less.
 */
const performanceThrottleSchema = z.object({
  /** 1 = the host CPU. 4 is Lighthouse's mid-tier-phone default. */
  cpuMultiplier: z.number().min(1).max(20).default(1),
  network: z.enum(PERFORMANCE_NETWORK_PRESETS).default('none'),
});

/** One post-load interaction, so INP has something to measure. */
const performanceInteractionSchema = z.object({
  selector: z.string().min(1).max(500),
  /** Let the handler and the paint it causes finish before the next click. */
  settleMs: z.number().int().min(0).max(30_000).default(500),
});

/**
 * A performance test.
 *
 * `iterations` is the honest part of this spec and the reason the default is not
 * 1. A cold cache, a busy runner or a slow DNS lookup moves LCP by seconds; one
 * sample cannot tell that apart from a regression, and a perf test that fails
 * randomly is deleted within a week. The plugin runs `iterations` loads, gates
 * on the MEDIAN, and reports the spread so a number that is really a range is
 * never presented as a fact.
 */
export const performanceTestSpecSchema = z.object({
  /** Path or absolute URL. Relative resolves against the environment's base URL. */
  path: z.string().min(1).max(2000).default('/'),
  /** Loads to perform. The median of these is what the budgets are checked against. */
  iterations: z.number().int().min(1).max(25).default(5),
  viewport: z
    .object({
      width: z.number().int().min(200).max(4000).default(1280),
      height: z.number().int().min(200).max(4000).default(800),
    })
    .default({ width: 1280, height: 800 }),
  budgets: performanceBudgetsSchema.default(performanceBudgetsSchema.parse({})),
  byteBudgets: performanceByteBudgetsSchema.default(performanceByteBudgetsSchema.parse({})),
  /**
   * How long to keep observing after the load event. LCP is not final until the
   * page stops painting and CLS keeps accumulating; cutting this to zero
   * systematically under-reports both.
   */
  settleMs: z.number().int().min(0).max(60_000).default(3000),
  navigationTimeoutMs: z.number().int().min(1_000).max(300_000).default(45_000),
  /**
   * Clicks performed after load so INP has real events to measure. Without
   * these, INP is unmeasurable in a lab — nobody interacted — and the plugin
   * says so rather than reporting a zero.
   */
  interactions: z.array(performanceInteractionSchema).max(10).default([]),
  /**
   * `auto` uses Lighthouse when it is installed and the built-in Web Vitals
   * collector when it is not. `off` always uses the collector.
   */
  lighthouse: z.enum(['auto', 'off']).default('auto'),
  /** Escape hatch for a Lighthouse that is not on PATH. Never run through a shell. */
  lighthouseCommand: z.string().min(1).max(300).optional(),
  lighthouseTimeoutSeconds: z.number().int().min(10).max(1_800).default(180),
  throttle: performanceThrottleSchema.default(performanceThrottleSchema.parse({})),
  /**
   * Relative spread — (max − min) ÷ median — above which the plugin stops
   * calling the median a fact and calls it a range.
   */
  spreadTolerance: z.number().min(0).max(100).default(0.25),
  /** Largest individual resources named when a byte budget is blown. */
  maxOffendersReported: z.number().int().min(0).max(50).default(5),
});

export type PerformanceTestSpec = z.infer<typeof performanceTestSpecSchema>;

// ─── Enumeration: the crawl policy, the ledgers, and the dimension tables ────

/**
 * The write path for everything the enumeration slice stores, and the reason
 * these are not optional nice-to-haves.
 *
 * Eight `GateRule` kinds existed in the TypeScript union and not in
 * `gateRuleSchema` for two slices, which meant no customer could save one: the
 * features were reachable only by hand-editing a database row, and
 * `check:wiring` could not see it because a union member with no write path is
 * not a disconnected FILE. Every vocabulary below therefore derives its
 * `z.enum` FROM the exported array rather than restating the members, and the
 * one discriminated union among them (`dimensionDetailSchema`) is checked
 * against its `Record`-derived kind list by a run-time parity test in
 * surface.test.ts.
 */

/**
 * A path glob, as `matchesGlob` in flow-map.ts reads it.
 *
 * Must start with `/`: a glob of `admin/**` silently matches nothing, because
 * the crawler tests it against `URL.pathname`, which always has a leading
 * slash. A scope rule that matches nothing is worse than no rule — it looks
 * applied in the panel and refuses nothing in the crawl.
 */
const pathGlob = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^\//, 'a path glob must start with "/" — it is matched against URL.pathname');

/** A query-parameter name. No `=`, no `&`, no whitespace. */
const queryParamName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.\-[\]]+$/, 'not a query parameter name');

/** An absolute http(s) origin. Reuses the base-URL rule, then keeps the origin. */
const originUrl = httpUrl.refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.pathname === '/' || parsed.pathname === '';
  } catch {
    return false;
  }
}, 'an additional origin is a scheme, host and port — not a path');

/**
 * The environment's crawl policy.
 *
 * Every field has a default and every default is `DEFAULT_CRAWL_POLICY`'s, so
 * `crawlPolicySchema.parse({})` is exactly the safe-for-production policy and
 * there is no second place where a default is written down. A partial body is
 * therefore accepted and completed, which is what the panel sends when a
 * customer changes one number.
 *
 * The ceilings are not the defaults. `pageBudget` defaults to 1,000 and is
 * capped at 100,000: the default is a judgement about a normal application and
 * the cap is a refusal to let a typo enqueue a crawl that never finishes.
 */
export const crawlPolicySchema = z.object({
  includeGlobs: z.array(pathGlob).max(200).default(DEFAULT_CRAWL_POLICY.includeGlobs),
  excludeGlobs: z.array(pathGlob).max(200).default(DEFAULT_CRAWL_POLICY.excludeGlobs),
  ignoredQueryParams: z
    .array(queryParamName)
    .max(100)
    .default(DEFAULT_CRAWL_POLICY.ignoredQueryParams),
  perTemplatePageBudget: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(DEFAULT_CRAWL_POLICY.perTemplatePageBudget),
  pageBudget: z.number().int().min(1).max(100_000).default(DEFAULT_CRAWL_POLICY.pageBudget),
  maxDepth: z.number().int().min(1).max(100).default(DEFAULT_CRAWL_POLICY.maxDepth),
  wallClockMillis: z
    .number()
    .int()
    .min(1_000)
    .max(6 * 60 * 60 * 1_000)
    .default(DEFAULT_CRAWL_POLICY.wallClockMillis),
  safeMethodsOnly: z.boolean().default(DEFAULT_CRAWL_POLICY.safeMethodsOnly),
  allowDestructive: z.boolean().default(DEFAULT_CRAWL_POLICY.allowDestructive),
  destructiveAllowGlobs: z
    .array(pathGlob)
    .max(200)
    .default(DEFAULT_CRAWL_POLICY.destructiveAllowGlobs),
  additionalOrigins: z.array(originUrl).max(20).default(DEFAULT_CRAWL_POLICY.additionalOrigins),
});

/**
 * `allowDestructive` without a single allow glob is refused.
 *
 * The flag on its own grants nothing — `policyDecision` requires BOTH — so a
 * customer who sets it and nothing else has configured a permission that does
 * not apply and will reasonably believe destructive paths are now being
 * covered. Refusing the body is the only way they find out at the moment they
 * are looking at the panel rather than three weeks later in a report.
 */
export const updateCrawlPolicySchema = crawlPolicySchema.refine(
  (policy) => !policy.allowDestructive || policy.destructiveAllowGlobs.length > 0,
  {
    message:
      'allowDestructive needs at least one destructiveAllowGlobs pattern — the flag alone ' +
      'grants nothing, and a permission that grants nothing is worse than none',
    path: ['destructiveAllowGlobs'],
  },
);

// ─── Flow-map honesty shapes ────────────────────────────────────────────────

export const nodeStatusSchema = z.object({
  /**
   * Nullable and NOT defaulted to 200. A same-document SPA transition produces
   * no response, and `shouldGenerateAgainst` refuses to write a happy-path test
   * against a node whose status was never recorded. Defaulting here would
   * convert "nobody looked" into "it answered 200" at the one boundary where
   * that lie is cheapest to tell.
   */
  code: z.number().int().min(100).max(599).nullable(),
  class: z.enum(NODE_STATUS_CLASSES),
  isErrorPage: z.boolean(),
});

export const routeAccessSchema = z
  .object({
    role: z.string().trim().min(1).max(120).nullable(),
    outcome: z.enum(ACCESS_OUTCOMES),
    status: z.number().int().min(100).max(599).nullable(),
    destinationRoute: z.string().max(2_000).nullable(),
    basis: z.enum(['OBSERVED', 'DECLARED']),
    observedAtIso: z.string().datetime().nullable(),
  })
  .refine((access) => access.basis !== 'DECLARED' || access.status === null, {
    message:
      'a DECLARED access outcome has no status — nobody made the request, and writing 403 ' +
      'there reports a measurement that was never taken',
    path: ['status'],
  })
  .refine((access) => access.outcome !== 'REDIRECTED' || access.destinationRoute !== null, {
    message:
      'a REDIRECTED outcome has to say where it landed, or it is indistinguishable from DENIED',
    path: ['destinationRoute'],
  });

export const excludedPathSchema = z.object({
  url: z.string().min(1).max(2_000),
  route: z.string().max(2_000).nullable(),
  kind: z.enum(EXCLUSION_KINDS),
  /** Required and non-empty: a refusal with no rule is why this ledger exists. */
  rule: z.string().min(1).max(300),
  discoveredFrom: z.string().max(2_000).nullable(),
});

export const externalBoundarySchema = z.object({
  kind: z.enum(EXTERNAL_KINDS),
  /**
   * An origin, enforced. A full URL here would store an IdP redirect's tenant,
   * user hint and state token in a flow map that is rendered in a cockpit and
   * exported on request, and no part of this product needs those values.
   */
  origin: originUrl,
  fromRoute: z.string().max(2_000).nullable(),
  samplePath: z
    .string()
    .max(2_000)
    .regex(/^\/[^?#]*$/, 'a sample path is a path — no query string, no fragment')
    .nullable(),
  occurrences: z.number().int().min(1),
});

export const capBiteSchema = z.object({
  cap: z.enum(CRAWL_CAPS),
  limit: z.number().int().min(0),
  bites: z.number().int().min(0),
  /**
   * Required, including when it is zero. An omitted `discarded` reads as "the
   * cap cost nothing", and that is the exact claim a truncated crawl is not
   * entitled to make.
   */
  discarded: z.number().int().min(0),
  scope: z.string().max(2_000).nullable(),
  reason: z.string().min(1).max(500),
});

export const frontierSchema = z
  .object({
    unvisitedQueued: z.number().int().min(0),
    beyondDepth: z.number().int().min(0),
    excluded: z.number().int().min(0),
    offOrigin: z.number().int().min(0),
    unreachable: z.number().int().min(0),
    atLeastMoreUrls: z.number().int().min(0),
    sample: z.array(z.string().min(1).max(2_000)).max(100),
    sampleTruncated: z.boolean(),
  })
  .refine(
    (frontier) => frontier.atLeastMoreUrls === frontier.unvisitedQueued + frontier.beyondDepth,
    {
      message:
        'atLeastMoreUrls must equal unvisitedQueued + beyondDepth — it is a derived lower bound ' +
        'on URLs we actually held, not an estimate a writer may choose',
      path: ['atLeastMoreUrls'],
    },
  )
  .refine(
    (frontier) =>
      !frontier.sampleTruncated ||
      frontier.sample.length < frontier.atLeastMoreUrls + frontier.excluded,
    {
      message:
        'sampleTruncated claims the sample is shorter than the frontier it came from, and it is not',
      path: ['sampleTruncated'],
    },
  );

export const crawlDegradationSchema = z.object({
  kind: z.enum(CRAWL_DEGRADATIONS),
  detail: z.string().min(1).max(500),
  count: z.number().int().min(0),
});

export const crawlAcceptanceSchema = z
  .object({
    state: z.enum(CRAWL_ACCEPTANCE_STATES),
    reasons: z.array(z.string().min(1).max(500)).max(50),
    degradations: z.array(crawlDegradationSchema).max(50),
    comparedToVersion: z.number().int().min(0).nullable(),
    previousNodeCount: z.number().int().min(0).nullable(),
  })
  .refine((acceptance) => acceptance.state === 'ACCEPTED' || acceptance.reasons.length > 0, {
    message:
      'a CANDIDATE or REJECTED crawl must carry its reasons — "degraded" with no reason is a ' +
      'denominator a customer cannot audit and will not believe',
    path: ['reasons'],
  });

export const flowMapProvenanceSchema = z.object({
  derivedFrom: z.enum(SURFACE_SOURCES),
  acceptance: z.enum(CRAWL_ACCEPTANCE_STATES),
  outcome: z.enum(ENUMERATION_OUTCOMES),
});

// ─── The surface registry ───────────────────────────────────────────────────

export const surfaceExerciseSchema = z
  .object({
    state: z.enum(SURFACE_EXERCISABILITIES),
    reason: z.enum(UNEXERCISABLE_REASONS).nullable().default(null),
    rule: z.string().min(1).max(300).nullable().default(null),
    detail: z.string().min(1).max(500),
  })
  .refine((exercise) => exercise.state !== 'UNEXERCISABLE' || exercise.reason !== null, {
    message: 'UNEXERCISABLE needs a reason — "needs disposable data" is a remedy, a shrug is not',
    path: ['reason'],
  })
  .refine((exercise) => exercise.state !== 'REFUSED' || exercise.rule !== null, {
    message:
      'REFUSED needs the rule that refused it, or a policy exclusion is indistinguishable from ' +
      'a bug in our crawler',
    path: ['rule'],
  });

export const dimensionCoordinateSchema = z.object({
  dimension: z.enum(SURFACE_DIMENSION_KINDS),
  /** The dimension row's `key`, in the application's own spelling. Never trimmed to lower case. */
  value: z.string().min(1).max(200),
});

/**
 * One item in the surface registry.
 *
 * `sources` is `.min(1)`: an item nobody declared has no business in a
 * denominator, and this is the only validator between a MANUAL entry form and
 * the row. `origin` is accepted but the server derives it with
 * `originFromSources` — see the note on `SurfaceItem.sources`.
 */
export const surfaceItemSchema = z.object({
  kind: z.enum(SURFACE_KINDS),
  key: z.string().min(1).max(500),
  label: z.string().min(1).max(500),
  file: z.string().max(1_000).nullable().default(null),
  line: z.number().int().min(1).nullable().default(null),
  sources: z.array(z.enum(SURFACE_SOURCES)).min(1).max(8),
  evidence: z.string().min(1).max(1_000),
  detector: z.string().max(200).nullable().default(null),
  exercise: surfaceExerciseSchema.nullable().default(null),
  environmentId: z.string().min(1).max(64).nullable().default(null),
  coordinates: z.array(dimensionCoordinateSchema).max(6).default([]),
  meta: z.record(z.string(), z.unknown()).default({}),
});

/**
 * The per-dimension detail, as a discriminated union.
 *
 * Twelve arms of `gateRuleSchema` and a `Record<GateRule['kind'], true>` exist
 * because eight kinds could not be saved for two slices with nothing to notice.
 * This union gets the same treatment from the start: `DIMENSION_DETAIL_KINDS`
 * is compiler-enforced against the TypeScript union, and surface.test.ts
 * asserts these options are exactly that list.
 */
export const dimensionDetailSchema = z.discriminatedUnion('dimension', [
  z.object({
    dimension: z.literal('ROLE'),
    privileged: z.boolean(),
    inheritsFrom: z.string().min(1).max(120).nullable().default(null),
  }),
  z.object({
    dimension: z.literal('LOCALE'),
    /** BCP-47 shape. Not a full registry check — `pt-BR`, `en`, `zh-Hant-TW`. */
    tag: z
      .string()
      .min(2)
      .max(35)
      .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'not a BCP-47 language tag'),
    rtl: z.boolean(),
  }),
  z.object({
    dimension: z.literal('DEVICE'),
    widthPx: z.number().int().min(120).max(10_000),
    heightPx: z.number().int().min(120).max(10_000),
    touch: z.boolean(),
    descriptor: z.string().min(1).max(120).nullable().default(null),
  }),
  z.object({
    dimension: z.literal('FLAG'),
    /**
     * `.min(2)`: a flag with one variant changes nothing, so it is not a
     * dimension — it is a constant, and counting it would add cells that cannot
     * differ.
     */
    variants: z.array(z.string().min(1).max(120)).min(2).max(50),
    defaultVariant: z.string().min(1).max(120).nullable().default(null),
    provider: z.string().min(1).max(120).nullable().default(null),
  }),
  z.object({
    dimension: z.literal('JOB'),
    trigger: z.enum(['CRON', 'QUEUE', 'WEBHOOK', 'STARTUP', 'MANUAL']),
    schedule: z.string().min(1).max(200).nullable().default(null),
    publiclyTriggerable: z.boolean(),
  }),
  z.object({
    dimension: z.literal('EMAIL'),
    templateId: z.string().min(1).max(200),
    sentBy: z.string().min(1).max(200).nullable().default(null),
    transactional: z.boolean(),
  }),
]);

/**
 * One row of a dimension table.
 *
 * The cross-check between `kind` and `detail.dimension` is the whole point of
 * having both: a LOCALE row carrying DEVICE detail would be a row no reader
 * could render and no cell identity could be built from, and nothing else in
 * the stack would catch it — Prisma stores the enum and the JSON
 * independently.
 */
export const surfaceDimensionSchema = z
  .object({
    kind: z.enum(SURFACE_DIMENSION_KINDS),
    key: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
    source: z.enum(SURFACE_SOURCES),
    evidence: z.string().min(1).max(1_000),
    isDefault: z.boolean().default(false),
    available: z.boolean().default(true),
    detail: dimensionDetailSchema,
    file: z.string().max(1_000).nullable().default(null),
  })
  .refine((row) => row.kind === row.detail.dimension, {
    message: 'kind and detail.dimension disagree — one row cannot be two dimensions',
    path: ['detail'],
  })
  .refine(
    (row) =>
      row.detail.dimension !== 'FLAG' ||
      row.detail.defaultVariant === null ||
      row.detail.variants.includes(row.detail.defaultVariant),
    {
      message: 'defaultVariant is not one of this flag’s variants',
      path: ['detail', 'defaultVariant'],
    },
  );

// ─── Measurement: the ladder, the edges, the variants and the metric channel ─

/**
 * The three vocabularies of the coverage ladder, as validators.
 *
 * `z.enum` over the imported lists rather than hand-written literals, so the
 * run-time parity tests in schemas.test.ts and coverage-tiers.test.ts are
 * comparing the schema against the ladder and not against a copy of it. See the
 * import note at the head of this file.
 */
export const coverageTierSchema = z.enum(COVERAGE_TIERS);
export const coverageEdgeSourceSchema = z.enum(COVERAGE_EDGE_SOURCES);
export const tierCapReasonSchema = z.enum(TIER_CAP_REASONS);

/**
 * One test → surface-item provenance edge.
 *
 * ── The defect this shape ends ──────────────────────────────────────────────
 *
 * The numerator link was recomputed by regex on every request, with no identity
 * and no history. So coverage could not FALL when a test was deleted or
 * quarantined: the link simply stopped being derived, and an item that had been
 * covered yesterday was indistinguishable from one that had never been covered
 * at all. The number was structurally incapable of going down for the most
 * common reason it should.
 *
 * ── `confidence` HAS A CEILING PER SOURCE, ENFORCED HERE ────────────────────
 *
 * The same pattern as `LINK_METHOD_CONFIDENCE_CEILING` in requirements.ts, and
 * for the identical reason: a regex able to write `confidence: 1` is a regex
 * whose guess reads on screen as certainty. A STATIC edge is capped at 0.8, a
 * SPEC edge at 0.95 — a human can be wrong about what a test does — and only a
 * RUNTIME edge, which is a record of something a browser was observed to do,
 * may claim 1.
 *
 * ── `tier` IS ACCEPTED AND STILL CAPPED SERVER-SIDE ─────────────────────────
 *
 * This schema deliberately does NOT re-derive the tier; `promoteCoverageTier`
 * does that, from evidence, in one place. What it DOES refuse is a tier the
 * source could never have earned, because that check is cheap and the failure
 * it catches — a STATIC writer storing PASSING — is the whole product.
 */
export const testCoverageEdgeSchema = z
  .object({
    testId: z.string().min(1).max(64),
    /** `CoverageItem.key`, the stable `KIND:identity`. Same bound as `surfaceItemSchema.key`. */
    itemKey: z.string().min(1).max(500),
    source: coverageEdgeSourceSchema,
    tier: coverageTierSchema,
    /**
     * Why `tier` is not higher. Null is legitimate and means nothing capped it:
     * a FRESH edge has nothing above it to be held back from.
     */
    cappedBy: tierCapReasonSchema.nullable().default(null),
    /** 0-1. See the ceiling note above. */
    confidence: z.number().min(0).max(1),
    /** The sentence that justifies the edge, in the customer's terms. */
    evidence: z.string().min(1).max(1_000),
    /**
     * The run that last confirmed this edge. REQUIRED for any tier above
     * DECLARED and refused below — see the refinements. A tier that claims an
     * observation with no run to point at is an unauditable claim, which is the
     * one thing a provenance edge may not be.
     */
    lastConfirmedRunId: z.string().min(1).max(64).nullable().default(null),
    lastConfirmedAtIso: z.string().datetime().nullable().default(null),
  })
  .refine(
    (edge) =>
      edge.confidence <=
      ({ STATIC: 0.8, SPEC: 0.95, RUNTIME: 1 } as const satisfies Record<
        (typeof COVERAGE_EDGE_SOURCES)[number],
        number
      >)[edge.source],
    {
      message:
        'confidence is above what this source can earn — a regex cannot be certain, and only an ' +
        'observed run may claim 1',
      path: ['confidence'],
    },
  )
  .refine((edge) => edge.source === 'RUNTIME' || edge.tier === 'DECLARED', {
    message:
      'only a RUNTIME edge may exceed DECLARED — a static match and a declaration are claims, ' +
      'not observations (COVERAGE_EDGE_SOURCE_CEILING)',
    path: ['tier'],
  })
  .refine((edge) => edge.tier === 'DECLARED' || edge.lastConfirmedRunId !== null, {
    message: 'a tier above DECLARED must name the run that observed it',
    path: ['lastConfirmedRunId'],
  });

/**
 * One cell of the matrix, as a validator.
 *
 * Every dimension DEFAULTS to its sentinel rather than being optional, so the
 * row written from this schema always has five non-null columns and the unique
 * index that is the row's identity actually holds. See `TestVariantKey` for why
 * a nullable dimension would silently duplicate the default cell once per run.
 */
/**
 * `'<anonymous>'`, restated rather than imported, and the reason is a real
 * import cycle rather than an oversight.
 *
 * The constant is `ANONYMOUS_ROLE` in auth-profiles.ts, which is its owner —
 * `roleKey` returns it and every `RouteAccessCell` row spells a logged-out
 * visitor with it. This file CANNOT import it: auth-profiles.ts imports
 * `authProfileConfigSchema` back out of this file, so a value import here
 * closes the cycle (schemas → auth-profiles → schemas), which is the same
 * hazard the `import type` notes at the head of this file document for
 * flow-map.ts and types.ts.
 *
 * So the literal is duplicated and PINNED: schemas.test.ts asserts it equals
 * `ANONYMOUS_ROLE`, which a test file can import because it imports both. A
 * duplicate nobody checks is how two halves of one key come to disagree; a
 * duplicate a test holds to its source is a duplicate that cannot drift.
 */
const ANONYMOUS_ROLE_SENTINEL = '<anonymous>';

const variantDimension = (max: number, extraSentinels: readonly string[] = []) =>
  z
    .string()
    .min(1)
    .max(max)
    /*
     * The sentinels are the only values allowed to contain an angle bracket. A
     * real browser name, locale tag or environment id cannot contain one, so
     * this refinement costs nothing — and it closes the only way a caller could
     * forge "this dimension was not varied" for a cell that was.
     */
    .refine(
      (value) => !value.includes('<') || value === UNVARIED || extraSentinels.includes(value),
      {
        message: `angle brackets are reserved for the sentinels ${[UNVARIED, ...extraSentinels].join(', ')}`,
      },
    );

export const testVariantKeySchema = z.object({
  browser: variantDimension(60).default(UNVARIED),
  viewport: variantDimension(60).default(UNVARIED),
  locale: variantDimension(40).default(UNVARIED),
  /**
   * `'<anonymous>'` is a real answer — it ran logged out — and {@link UNVARIED}
   * means nobody varied the role at all. Two sentinels because those are two
   * facts, and only one of them is a claim about the application.
   */
  role: variantDimension(120, [ANONYMOUS_ROLE_SENTINEL]).default(UNVARIED),
  environment: variantDimension(64).default(UNVARIED),
});

/**
 * One numeric reading.
 *
 * ── THE TWO REFINEMENTS ARE THE SCHEMA ──────────────────────────────────────
 *
 * A null value demands a reason, and a present value forbids one. Both
 * directions, because each prevents a different lie: a null with no reason is
 * indistinguishable from a writer's bug and will be read as zero by the first
 * consumer that forgets to check, and a value WITH an unavailability reason is
 * a row that says both "we measured 4.2" and "we could not measure this".
 *
 * There is no `0` for an unmeasured metric. An LCP of 0 ms is a page that
 * painted instantly; a p95 of 0 is a load test that never ran.
 */
export const testMetricSchema = z
  .object({
    /** The plugin's own spelling: `lcp`, `http_req_duration_p95`. Stable, or there is no trend. */
    name: z
      .string()
      .min(1)
      .max(120)
      .regex(
        /^[a-z0-9][a-z0-9_.:-]*$/,
        'a metric name is an identifier, not a sentence — it is the key a trend query groups on',
      ),
    /** NULL MEANS NOT MEASURED. Finite: NaN and Infinity are not measurements. */
    value: z
      .number()
      .refine((n) => Number.isFinite(n), 'must be a finite number')
      .nullable(),
    unavailableReason: z.string().min(1).max(300).nullable().default(null),
    unit: z.enum(METRIC_UNITS),
    direction: z.enum(METRIC_DIRECTIONS),
    variant: testVariantKeySchema.nullable().default(null),
  })
  .refine((metric) => metric.value !== null || metric.unavailableReason !== null, {
    message:
      'a metric with no value must say why — an unexplained null is read as zero by the first ' +
      'consumer that forgets to check',
    path: ['unavailableReason'],
  })
  .refine((metric) => metric.value === null || metric.unavailableReason === null, {
    message: 'a metric cannot both have a value and be unavailable',
    path: ['unavailableReason'],
  });

/**
 * One variant result, with its own status and its own numbers.
 *
 * Bounded at 40 metrics per cell: the performance plugin emits six vitals, k6
 * emits a handful of thresholds, and a cell claiming more than 40 readings is a
 * writer in a loop. The cap is a REFUSAL rather than a silent truncation —
 * dropping readings over a limit would be a cap that bit without being
 * reported, and this is a write path where the caller can be told.
 */
export const testResultVariantSchema = z.object({
  key: testVariantKeySchema,
  /**
   * `TEST_RESULT_STATUSES`, imported and not spelled out. A cell's status has to
   * be the same five words the roll-up uses or the worst-wins reduction has
   * nothing to compare — and a sixth word written here would be a value the
   * Postgres enum rejects, discovered on an insert at run time.
   */
  status: z.enum(TEST_RESULT_STATUSES),
  durationMs: z.number().int().min(0),
  errorMessage: z.string().max(5_000).nullable().default(null),
  retriedAndPassed: z.boolean().default(false),
  /**
   * Why this cell measured nothing. NULL IS A FIFTH STATE and it is NOT
   * `NOT_RUN` — the same contract as `TestResult.notRunKind`. `why` travels
   * with the kind because the kind alone ("UNSUPPORTED") is not a sentence a
   * customer can act on.
   */
  notRun: z
    .object({ kind: z.enum(NOT_RUN_KINDS), why: z.string().min(1).max(500) })
    .nullable()
    .default(null),
  metrics: z.array(testMetricSchema).max(40).default([]),
});

/**
 * A suite-health reading on its way to being stored.
 *
 * EVERY NUMBER IS `.nullable()` WITH A `null` DEFAULT, and that is not laziness
 * about validation — it is the contract. `0` is a measurement ("we scanned every
 * test and found no weak assertions"); `null` is the absence of one ("the scan
 * never ran, or was truncated"). A `.default(0)` anywhere in this object would
 * turn every unmeasured dimension into the best possible result, which is the
 * most flattering lie this product could tell about itself.
 */
const healthCount = z.number().int().min(0).nullable().default(null);
const healthPercent = z.number().min(0).max(100).nullable().default(null);

export const suiteHealthSnapshotSchema = z.object({
  commitSha: z.string().min(7).max(64).nullable().default(null),
  runId: z.string().min(1).max(64).nullable().default(null),
  testCount: healthCount,
  quarantinedCount: healthCount,
  flakyCount: healthCount,
  weakAssertionCount: healthCount,
  duplicateCount: healthCount,
  obsoleteCount: healthCount,
  passRatePercent: healthPercent,
  medianDurationMs: healthCount,
  p95DurationMs: healthCount,
  /** The composite. NULL WHEN NOT COMPUTED — a 0 would read as a worthless suite. */
  score: healthPercent,
  /**
   * Every cap that BIT, as a sentence. `.default([])` is safe here and nowhere
   * else in this object: an empty caveat list is a positive claim that nothing
   * was truncated, which is the ordinary and verifiable case, whereas an empty
   * COUNT would be a claim about the customer's suite.
   */
  caveats: z.array(z.string().min(1).max(500)).max(40).default([]),
  fingerprint: z.string().min(1).max(200),
});

/**
 * What the customer owns about their own measurement.
 *
 * ── Why this is configuration and not a better regex ────────────────────────
 *
 * Risk ranking is an English money-word regex, `\b`-bounded, so `/pay_now` and
 * `/checkoutConfirm` — the two highest-risk spellings in the sample — both
 * miss. No regex fixes that, because the question is not how a route is spelled
 * but what it does, and the only party who knows is the team that wrote it. A
 * code comment already invited them to "tell us so" with nowhere to do it.
 *
 * ── `maxOutOfScopePercent` IS THE BRAKE ON THE ONE SETTING THAT COULD LIE ────
 *
 * `outOfScope` removes items from the DENOMINATOR, which is the only knob in
 * this product a customer could use to make their own coverage number say
 * anything. So it is bounded, the bound is stored beside the rules, and the
 * reader is required to report the cap as a count AND as a reason when it bites
 * rather than applying half the configuration silently. 25 is the default
 * because a quarter of an application being declared not-our-problem is already
 * a lot; 100 is permitted, and a customer who sets it has said so on the record
 * in configuration anyone can read.
 */
const scopePattern = z
  .string()
  .min(1)
  .max(300)
  .refine((pattern) => !pattern.includes('\u0000'), 'a glob cannot contain a null byte');

const scopeRule = z.object({
  pattern: scopePattern,
  /** A scope rule with no reason is a silent exclusion — the thing waivers exist to prevent. */
  reason: z.string().min(1).max(500),
});

export const coverageConfigSchema = z.object({
  /** Most specific LAST: a later rule wins, as every ignore-file already works. */
  criticality: z
    .array(scopeRule.extend({ level: z.enum(COVERAGE_CRITICALITIES) }))
    .max(200)
    .default([]),
  outOfScope: z.array(scopeRule).max(200).default([]),
  weights: z
    .array(
      scopeRule.extend({
        /**
         * Bounded at 10. An unbounded multiplier is a ranking in which one glob
         * is the entire report, which is indistinguishable from no ranking.
         */
        multiplier: z.number().min(0.1).max(10),
      }),
    )
    .max(200)
    .default([]),
  maxOutOfScopePercent: z.number().int().min(0).max(100).default(25),
});

/**
 * The write path for `Project.coverageConfig`.
 *
 * A PUT of the whole object, not a patch, and deliberately: a scope
 * configuration is read as a whole by every reader, and a partial update that
 * left `outOfScope` from one revision beside `maxOutOfScopePercent` from
 * another would be a brake set against rules nobody reviewed together.
 */
export const updateCoverageConfigSchema = coverageConfigSchema;

/**
 * The freshness window a caller may ask a report to use.
 *
 * Exported as a schema rather than left to each route, because the window is
 * what the difference between PASSING and FRESH MEANS, and three routes with
 * three different unvalidated windows would be three different numbers on three
 * screens. Bounded at 365: a window longer than a year is not freshness.
 */
export const freshnessDaysSchema = z
  .number()
  .int()
  .min(1)
  .max(365)
  .default(DEFAULT_COVERAGE_FRESHNESS_DAYS);

// ─── The dimensions: the write paths for everything below an item ────────────

/**
 * The seven dimension vocabularies, as validators.
 *
 * `z.enum` over the imported lists rather than hand-written literals, for the
 * third time in this file and for the same reason: these are the ONLY write
 * paths to `CoverageItemState.kind`, `CoverageRollup.dimension`,
 * `DeploymentCapability.status` and the rest, and a second copy of a list is a
 * copy that stops matching. A cell kind added to `COVERAGE_CELL_KINDS` and not
 * here is a cell no writer can ever store — exactly the shape of the eight
 * unsaveable gate kinds.
 *
 * Two of the seven are NOT Prisma enums and that is deliberate:
 * `snapshotComparabilitySchema` and `validityVerdictSchema` validate TEXT
 * columns whose domain is enforced here, at the producer, the same arrangement
 * `tierCapReasonSchema` has for `TestCoverageEdge.cappedBy`. They are therefore
 * the ONLY guard those two vocabularies have, which is why
 * coverage-dimensions.test.ts compares their `.options` back against the lists.
 */
export const coverageDimensionSchema = z.enum(COVERAGE_DIMENSIONS);
export const coverageCellKindSchema = z.enum(COVERAGE_CELL_KINDS);
export const dimensionUnmeasuredReasonSchema = z.enum(DIMENSION_UNMEASURED_REASONS);
export const deploymentCapabilityStatusSchema = z.enum(DEPLOYMENT_CAPABILITY_STATUSES);
export const faultDetectionOutcomeSchema = z.enum(FAULT_DETECTION_OUTCOMES);
export const snapshotComparabilitySchema = z.enum(SNAPSHOT_COMPARABILITIES);
export const validityVerdictSchema = z.enum(VALIDITY_VERDICTS);

/**
 * A cap that BIT, as a count and a reason.
 *
 * `atLeastMore` is `.nullable()` and NOT `.default(0)`, and that single choice
 * is the whole point of the shape. A wall-clock timeout knows it stopped and
 * does not know what it stopped before, so null is "more existed and we cannot
 * say how many" — a weaker, still useful sentence. `0` would be the claim that
 * nothing was hidden, which is the opposite of what a bitten cap means, and it
 * is the value a reader sums into a total without noticing.
 */
export const dimensionCapBiteSchema = z.object({
  cap: z.string().min(1).max(120),
  limit: z.number().int().min(0),
  atLeastMore: z.number().int().min(0).nullable(),
  /** Always written. A cap with no sentence is a truncation nobody can act on. */
  detail: z.string().min(1).max(500),
});

/** One rung of a stored ladder. `percent` is null when there is nothing to divide. */
const coverageTierTotalsSchema = z.object({
  tier: coverageTierSchema,
  atOrAbove: z.number().int().min(0),
  percent: z.number().min(0).max(100).nullable(),
});

/**
 * A whole ladder, as stored or posted.
 *
 * `.length(COVERAGE_TIERS.length)` rather than `.min(1)`: the ladder's value is
 * that "34% passing, 61% navigated" are two readings of ONE measurement, and a
 * ladder missing a rung is a series a reader would compare across a hole.
 */
const coverageLadderSchema = z.object({
  denominator: z.number().int().min(0),
  unclaimed: z.number().int().min(0),
  tiers: z.array(coverageTierTotalsSchema).length(COVERAGE_TIERS.length),
});

/**
 * ONE DIMENSION'S READING, and the four refusals that make it honest.
 *
 * Each refinement is a specific lie this product cannot afford, and each one
 * has a named test in coverage-dimensions.test.ts:
 *
 *   1. AN UNMEASURED COUNT WITH NO REASON. The cardinal one. An unexplained
 *      shortfall is read as uncovered by the first consumer that forgets to
 *      check, which moves the percentage down for something the customer
 *      neither caused nor can fix.
 *   2. A REASON WITH NOTHING UNMEASURED. The mirror, and not symmetric
 *      decoration: a row claiming a limitation it did not hit puts a caveat on
 *      a report that does not need one, and a reader who finds one false caveat
 *      stops reading the true ones.
 *   3. PARTS THAT DO NOT RECONSTRUCT THE WHOLE. `cells` must equal
 *      `measured + unmeasured`, and `tiers.denominator` must equal `measured` —
 *      because a ladder divided by `cells` would report every cell we never
 *      looked at as UNCOVERED, and that is the exact arithmetic the
 *      `measured`/`unmeasured` split exists to prevent.
 *   4. CAP_BIT WITH NO CAP. "A cap stopped the measurement short" with no cap
 *      named is a cap applied without being disclosed, which is rule 10
 *      verbatim.
 */
export const dimensionMeasurementSchema = z
  .object({
    dimension: coverageDimensionSchema,
    cells: z.number().int().min(0),
    measured: z.number().int().min(0),
    unmeasured: z.number().int().min(0),
    /**
     * REQUIRED AS A PROPERTY, nullable as a VALUE. `.nullable()` with no
     * `.default(null)` on purpose: a caller who omits the key entirely has not
     * thought about it, and silently defaulting that to "nothing unmeasured"
     * is the omission this whole shape is arranged against.
     */
    unmeasuredReason: dimensionUnmeasuredReasonSchema.nullable(),
    unmeasuredDetail: z.string().min(1).max(500).nullable(),
    tiers: coverageLadderSchema,
    caps: z.array(dimensionCapBiteSchema).max(20).default([]),
  })
  .refine((m) => m.unmeasured === 0 || m.unmeasuredReason !== null, {
    message:
      'unmeasured cells with no reason — an unexplained shortfall is read as uncovered by the ' +
      'first consumer that forgets to check, and an unmeasured axis is NOT 0%',
    path: ['unmeasuredReason'],
  })
  /*
   * ── `|| m.measured === 0` IS LOAD-BEARING, AND IT WAS MISSING ─────────────
   *
   * The rule is right and its first spelling made every unmeasured axis
   * unwritable. `unmeasuredDimension` — the keystone's own constructor, the one
   * that exists because it CANNOT produce a zero percent — returns
   * `{ measured: 0, unmeasured: cells, reason }`, and `cells` defaults to 0
   * because an axis with no extractor usually cannot say how many cells it has.
   * So the constructor produced `{ measured: 0, unmeasured: 0, reason:
   * 'NO_EXTRACTOR' }`, this refinement refused it, and on a project's first
   * computation all thirteen readings would have failed to persist — measured
   * by running the constructor against this schema, not inferred.
   *
   * The two states the refinement has to tell apart differ by `measured`:
   *
   *   measured > 0, unmeasured 0, reason set  → the defect. A reading that DID
   *     measure its cells and still claims a limitation it never hit.
   *   measured 0, unmeasured 0, reason set    → the honest empty axis, and the
   *     reason is the whole content of it. Without it, "we have no extractor
   *     for this" is indistinguishable from "we measured it and there is
   *     nothing there" — opposite facts with opposite remedies. The constructor
   *     says exactly this in its own comment; this clause is what stops the
   *     schema contradicting it.
   */
  .refine((m) => m.unmeasured > 0 || m.unmeasuredReason === null || m.measured === 0, {
    message:
      'an unmeasured reason on a reading that measured all of its cells claims a limitation it ' +
      'did not hit (a reading that measured NOTHING keeps its reason — that is the only thing ' +
      'telling "no extractor" apart from "measured, and empty")',
    path: ['unmeasuredReason'],
  })
  .refine((m) => m.unmeasuredReason === null || m.unmeasuredDetail !== null, {
    message: 'a reason code with no sentence is a disclosure only we can read',
    path: ['unmeasuredDetail'],
  })
  .refine((m) => m.cells === m.measured + m.unmeasured, {
    message: 'cells must equal measured + unmeasured — parts that do not reconstruct the whole',
    path: ['cells'],
  })
  .refine((m) => m.tiers.denominator === m.measured, {
    message:
      'the ladder must divide by what was MEASURED, not by every cell — dividing by cells ' +
      'reports everything we never looked at as uncovered',
    path: ['tiers', 'denominator'],
  })
  .refine((m) => m.unmeasuredReason !== 'CAP_BIT' || m.caps.length > 0, {
    message: 'CAP_BIT with no cap named is a cap applied without being disclosed',
    path: ['caps'],
  });

/**
 * The cell kinds each per-item table is allowed to store.
 *
 * Derived from `CELL_KIND_DIMENSION` rather than listed, so a new kind lands in
 * the right table automatically and cannot land in both. A state row carrying
 * `RULE_PATTERN` would be a cell counted on the VALIDATION_RULE denominator and
 * stored where no rule reader looks — present, counted nowhere, invisible.
 */
const STATE_DIMENSIONS: readonly CoverageDimensionKind[] = [
  'PAGE_STATE',
  'ERROR_STATE',
  'DATA_VARIANT',
  'COMPONENT',
  'COMPONENT_STATE',
];
const FORM_DIMENSIONS: readonly CoverageDimensionKind[] = ['FORM_FIELD', 'VALIDATION_RULE'];

/** The measurement columns every per-cell row carries, with their contract. */
const cellMeasurement = {
  /**
   * NULL IS NOT `DECLARED`. Null means nothing claims this cell at all; the
   * same rule as `CoverageTierVerdict.tier` and for the same reason — a default
   * would mint a claim nothing produced.
   */
  tier: coverageTierSchema.nullable().default(null),
  tierCappedBy: tierCapReasonSchema.nullable().default(null),
  lastConfirmedRunId: z.string().min(1).max(64).nullable().default(null),
  unmeasuredReason: dimensionUnmeasuredReasonSchema.nullable().default(null),
  unmeasuredDetail: z.string().min(1).max(500).nullable().default(null),
};

/**
 * ONE STATE OF ONE ITEM: its empty state, its 403, its pagination boundary.
 *
 * `stateKey` is validated as a non-empty string and NOT re-derived here;
 * `dimensionCellIdentity` in surface.ts is the one format and the producer calls
 * it. A second derivation in this file would be a second format, and two
 * formats make two dimensions silently uncomparable — which is the one thing
 * the keystone exists to prevent.
 */
export const coverageItemStateSchema = z
  .object({
    /** `CoverageItem.key`, so the writer can resolve the item without an id. */
    itemKey: z.string().min(1).max(500),
    stateKey: z.string().min(1).max(500),
    kind: coverageCellKindSchema,
    label: z.string().min(1).max(300),
    origin: z.enum(SURFACE_SOURCES),
    evidence: z.string().min(1).max(1_000),
    parentStateKey: z.string().min(1).max(500).nullable().default(null),
    /**
     * NULL MEANS DECLARED AND NEVER OBSERVED. Defaulting it to the request time
     * would turn every declared state into an observed one, which is the same
     * collapse `SurfaceVerification` keeps apart between a test existing and a
     * test running.
     */
    observedAtIso: z.string().datetime().nullable().default(null),
    exercise: surfaceExerciseSchema.nullable().default(null),
    ...cellMeasurement,
  })
  .refine((row) => STATE_DIMENSIONS.includes(CELL_KIND_DIMENSION[row.kind]), {
    message:
      'this cell kind belongs to a form dimension, not a state dimension — a row stored in the ' +
      'wrong table is counted on no denominator and is invisible rather than uncovered',
    path: ['kind'],
  })
  .refine((row) => row.tier === null || row.tier === 'DECLARED' || row.lastConfirmedRunId !== null, {
    message: 'a tier above DECLARED must name the run that observed it',
    path: ['lastConfirmedRunId'],
  })
  .refine((row) => row.parentStateKey !== row.stateKey, {
    message: 'a state cannot be reached only through itself',
    path: ['parentStateKey'],
  });

/**
 * THE CONSTRAINTS AS THE READER FOUND THEM — and the three refusals that stop
 * an absent attribute becoming a number.
 *
 * EVERY MEMBER IS `number | null` AND NONE IS OPTIONAL. A writer must say
 * `maxLength: null` rather than omitting the key, because an omitted key and a
 * null are the same thing to `JSON.stringify` and NOT the same thing to a
 * reader that uses `in` or `??`. Making the writer state it is the only way the
 * distinction survives the round trip.
 *
 * `maxLength`, `minLength` and `step` are refused at 0. A maxlength of zero is
 * not a constraint — it is an absent attribute that a writer turned into a
 * number, and it would produce a boundary cell nothing can ever satisfy.
 * `min` and `max` MAY be 0, because zero is a real bound: `min="0"` on a
 * quantity field is the single most common numeric constraint on the web, and
 * refusing it would delete the cell that catches a negative-quantity bug.
 */
export const formFieldConstraintSchema = z.object({
  maxLength: z.number().int().min(1).max(1_000_000).nullable(),
  minLength: z.number().int().min(1).max(1_000_000).nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  step: z.number().positive().nullable(),
  pattern: z.string().min(1).max(500).nullable(),
});

/**
 * ONE FIELD OF ONE FORM, OR ONE VALIDATION RULE DERIVED FROM ONE FIELD.
 *
 * `required` is a NULLABLE boolean with NO DEFAULT, which is the single most
 * important line in this schema. Null means the reader could not read the
 * attribute; `false` means it looked and the field is optional. `required` is
 * one of the two boundary cases the register names as counted by nobody, and
 * reading "we could not tell" as "there is no rule here" removes the cell from
 * the denominator and raises the percentage.
 */
export const coverageFormFieldSchema = z
  .object({
    itemKey: z.string().min(1).max(500),
    fieldKey: z.string().min(1).max(500),
    kind: coverageCellKindSchema,
    label: z.string().min(1).max(300),
    parentFieldKey: z.string().min(1).max(500).nullable().default(null),
    inputType: z.string().min(1).max(60).nullable().default(null),
    required: z.boolean().nullable(),
    semantic: z.string().min(1).max(60).nullable().default(null),
    /** NULL MEANS THE CONSTRAINTS WERE NEVER READ. See the note above. */
    constraint: formFieldConstraintSchema.nullable().default(null),
    constraintsRead: z.boolean(),
    origin: z.enum(SURFACE_SOURCES),
    evidence: z.string().min(1).max(1_000),
    exercise: surfaceExerciseSchema.nullable().default(null),
    ...cellMeasurement,
  })
  .refine((row) => FORM_DIMENSIONS.includes(CELL_KIND_DIMENSION[row.kind]), {
    message:
      'this cell kind belongs to a state dimension, not a form dimension — see the note on ' +
      'coverageItemStateSchema',
    path: ['kind'],
  })
  .refine(
    (row) => CELL_KIND_DIMENSION[row.kind] !== 'VALIDATION_RULE' || row.parentFieldKey !== null,
    {
      message:
        'a validation rule must name the field it was derived from — a rule with no field is a ' +
        'cell nothing can ever assert against',
      path: ['parentFieldKey'],
    },
  )
  .refine((row) => row.constraintsRead || row.constraint === null, {
    message:
      'constraints that were never read cannot also have been found — set constraintsRead when ' +
      'a reader looked',
    path: ['constraintsRead'],
  })
  .refine((row) => row.tier === null || row.tier === 'DECLARED' || row.lastConfirmedRunId !== null, {
    message: 'a tier above DECLARED must name the run that observed it',
    path: ['lastConfirmedRunId'],
  });

/**
 * "THIS ROUTE OWES AN ACCESSIBILITY TEST" — one obligation, one row.
 *
 * There is no default anywhere in this schema that could MINT an obligation.
 * `obligationsFor` is the one resolver and `DEFAULT_TYPE_OBLIGATIONS` owes
 * nothing, so an obligation reaches this schema only because a declarer said so
 * — which is what keeps nineteen test types from becoming nineteen fabricated
 * denominators per item.
 */
export const coverageTypeObligationSchema = z
  .object({
    itemKey: z.string().min(1).max(500),
    testType: z.enum(TEST_TYPES),
    declaredBy: z.enum(SURFACE_SOURCES),
    evidence: z.string().min(1).max(1_000),
    ...cellMeasurement,
  })
  .refine((row) => row.tier === null || row.tier === 'DECLARED' || row.lastConfirmedRunId !== null, {
    message: 'a tier above DECLARED must name the run that observed it',
    path: ['lastConfirmedRunId'],
  });

/**
 * The write path for `Project.typeObligationPolicy`.
 *
 * A PUT of the whole object, like `updateCoverageConfigSchema`, and for the same
 * reason: an obligation policy is read as a whole, and a partial update that
 * left one axis from one revision beside another from a second would be a debt
 * nobody reviewed together.
 *
 * `.max(TEST_TYPES.length)` per axis, and duplicates refused: an axis declared
 * to owe the same type twice would count one obligation as two and inflate a
 * denominator the customer configured by hand.
 */
export const typeObligationPolicySchema = z.object({
  /*
   * `z.partialRecord` and NOT `z.record`, which is the difference between a
   * policy and a form a customer cannot submit. zod 4's `z.record` produces a
   * TOTAL record, so `{ byKind: { ROUTE: ['E2E'] } }` would be refused for
   * omitting the other eleven axes — and a policy that forces an opinion about
   * DATA_VARIANT in order to say anything about ROUTE is a policy nobody fills
   * in. An axis absent here falls back to `DEFAULT_TYPE_OBLIGATIONS`, which
   * owes nothing.
   */
  byKind: z
    .partialRecord(
      z.enum(SURFACE_KINDS),
      z
        .array(z.enum(TEST_TYPES))
        .max(TEST_TYPES.length)
        .refine((types) => new Set(types).size === types.length, {
          message: 'an axis cannot owe the same test type twice',
        }),
    )
    .default({}),
});

export const updateTypeObligationPolicySchema = typeObligationPolicySchema;

/**
 * ONE FEATURE'S OR ONE TEAM'S PERCENTAGE, WITH ITS OWN ARITHMETIC.
 *
 * `scopeKey` is accepted and the server derives it with `rollupScopeKey` — the
 * same arrangement as `SurfaceItem.origin` being derived from `sources`, and
 * for the same reason: two fields that encode one fact will eventually disagree
 * about a row and only one of them will be on screen. The refinement below
 * holds them together at the door.
 */
export const coverageRollupSchema = z
  .object({
    scopeKey: z.string().min(1).max(500),
    dimension: coverageDimensionSchema.nullable().default(null),
    feature: z.string().min(1).max(200).nullable().default(null),
    /** Null for "not narrowed to a team"; `UNOWNED` for the surface nobody owns. */
    teamId: z.string().min(1).max(64).nullable().default(null),
    numerator: z.number().int().min(0),
    denominator: z.number().int().min(0),
    /** Null when the denominator is zero. Never 0 and never 100. */
    percent: z.number().min(0).max(100).nullable(),
    /** No default: a rollup that does not say which bar it cleared is comparable to nothing. */
    tier: coverageTierSchema,
    unmeasured: z.number().int().min(0).default(0),
    unmeasuredReason: dimensionUnmeasuredReasonSchema.nullable().default(null),
    unmeasuredDetail: z.string().min(1).max(500).nullable().default(null),
    caps: z.array(dimensionCapBiteSchema).max(20).default([]),
    /**
     * Items deliberately excluded from this bucket, as sentences. A rollup whose
     * parts do not reconstruct the whole MUST say which items were excluded and
     * why; without them the only way to notice is to add the buckets up by hand.
     */
    exclusions: z.array(z.string().min(1).max(500)).max(50).default([]),
  })
  .refine((row) => row.numerator <= row.denominator, {
    message:
      'a rollup cannot cover more cells than it has — a numerator above its denominator is the ' +
      'arithmetic a customer reproduces in a spreadsheet and never trusts us again after',
    path: ['numerator'],
  })
  .refine((row) => row.denominator > 0 || row.percent === null, {
    message: 'an empty denominator has no percentage — null is not 0 and it is not 100',
    path: ['percent'],
  })
  .refine((row) => row.unmeasured === 0 || row.unmeasuredReason !== null, {
    message: 'unmeasured cells in a rollup with no reason — the shortfall reads as uncovered',
    path: ['unmeasuredReason'],
  })
  .refine(
    (row) => row.scopeKey === rollupScopeKey({ dimension: row.dimension, feature: row.feature, teamId: row.teamId }),
    {
      message:
        'scopeKey disagrees with the columns it encodes — derive it with rollupScopeKey rather ' +
        'than setting both by hand, or the index and the filters will describe different buckets',
      path: ['scopeKey'],
    },
  );

/**
 * THE DIRECTION OF ONE SUBJECT, AND THE REFUSAL THAT MATTERS MOST IN THIS FILE.
 *
 * A DELTA ACROSS TWO CRAWL FINGERPRINTS IS REFUSED. Subtracting two percentages
 * always succeeds, which is exactly why this has to be a validator and not a
 * convention: two snapshots taken against different crawls measured different
 * applications, and "coverage fell 9 points" across them is an artefact of our
 * own enumeration changing that will be read as a regression by everybody who
 * sees it — in the PR comment, on the badge, in the digest.
 */
export const coverageHistorySchema = z
  .object({
    scopeKey: z.string().min(1).max(500),
    dimension: coverageDimensionSchema.nullable().default(null),
    feature: z.string().min(1).max(200).nullable().default(null),
    teamId: z.string().min(1).max(64).nullable().default(null),
    numerator: z.number().int().min(0),
    denominator: z.number().int().min(0),
    percent: z.number().min(0).max(100).nullable(),
    tier: coverageTierSchema,
    /** Null makes comparability UNPROVABLE rather than true. */
    crawlFingerprint: z.string().min(1).max(200).nullable().default(null),
    previousSnapshotId: z.string().min(1).max(64).nullable().default(null),
    previousPercent: z.number().min(0).max(100).nullable().default(null),
    /** Percentage points. Refused unless `comparability` is COMPARABLE. */
    deltaPercent: z.number().min(-100).max(100).nullable().default(null),
    comparability: snapshotComparabilitySchema,
    comparabilityDetail: z.string().min(1).max(500).nullable().default(null),
  })
  .refine((row) => row.numerator <= row.denominator, {
    message: 'a history row cannot cover more cells than it has',
    path: ['numerator'],
  })
  .refine((row) => row.deltaPercent === null || deltaIsMeaningful(row.comparability), {
    message:
      'a delta across two measurements that are not comparable — two snapshots from different ' +
      'crawl fingerprints measured different applications, so the reason goes where the delta ' +
      'would have been',
    path: ['deltaPercent'],
  })
  .refine((row) => deltaIsMeaningful(row.comparability) || row.comparabilityDetail !== null, {
    message:
      'an uncomparable reading must carry the sentence a reader sees instead of the delta',
    path: ['comparabilityDetail'],
  })
  .refine((row) => row.deltaPercent === null || row.previousPercent !== null, {
    message: 'a delta with nothing to subtract from',
    path: ['previousPercent'],
  })
  .refine(
    (row) => row.scopeKey === rollupScopeKey({ dimension: row.dimension, feature: row.feature, teamId: row.teamId }),
    {
      message: 'scopeKey disagrees with the columns it encodes — see coverageRollupSchema',
      path: ['scopeKey'],
    },
  );

/**
 * WHICH OF THE NINETEEN TYPES THIS DEPLOYMENT CAN EXECUTE.
 *
 * The two refinements are the enum's whole value. A status other than
 * NOT_CHECKED with no `checkedAt` is a verdict about an image nobody looked at;
 * NOT_CHECKED WITH a `checkedAt` is a probe that ran and refused to say what it
 * found. Either one makes "4 of 19 test types are not executable here" a
 * sentence with nothing behind it.
 *
 * `detail` is REQUIRED and is rendered in the coverage report and the preflight
 * summary, so a probe must never put a credential, cookie, storageState value
 * or token in it. Truncated and hashed both count as leaks.
 */
export const deploymentCapabilitySchema = z
  .object({
    /** `<self>` for this image, `pool:<name>` for an on-prem runner pool. */
    deploymentKey: z.string().min(1).max(200).default(SELF_DEPLOYMENT),
    testType: z.enum(TEST_TYPES),
    status: deploymentCapabilityStatusSchema,
    detail: z.string().min(1).max(500),
    remedy: z.string().min(1).max(500).nullable().default(null),
    requiredBinary: z.string().min(1).max(200).nullable().default(null),
    requiredVersion: z.string().min(1).max(100).nullable().default(null),
    /** Null for a probe that could not read a version. Never `0.0.0`. */
    observedVersion: z.string().min(1).max(100).nullable().default(null),
    checkedAtIso: z.string().datetime().nullable().default(null),
  })
  .refine((row) => row.status === 'NOT_CHECKED' || row.checkedAtIso !== null, {
    message:
      'a capability verdict must say when it was probed — a cached AVAILABLE for a binary that ' +
      'has since vanished is the lie this table exists to kill',
    path: ['checkedAtIso'],
  })
  .refine((row) => row.status !== 'NOT_CHECKED' || row.checkedAtIso === null, {
    message: 'NOT_CHECKED means nobody asked, so it cannot carry the time somebody asked',
    path: ['checkedAtIso'],
  })
  .refine((row) => row.status !== 'WRONG_VERSION' || row.requiredVersion !== null, {
    message:
      'WRONG_VERSION with no required range is a refusal a human cannot act on — name the range',
    path: ['requiredVersion'],
  });

// ─── The export envelope ────────────────────────────────────────────────────

/**
 * One axis an attestation did not measure.
 *
 * Both `dimension` and `kind` are nullable and at least one is required,
 * because the two vocabularies name different things and a document has to be
 * able to disclose either: `SURFACE_KINDS` is the inventory axis ("we do not
 * enumerate background jobs") and `COVERAGE_DIMENSIONS` is the breakdown axis
 * ("we do not measure validation rules"). Forcing one would have meant silently
 * dropping half the disclosures.
 */
export const attestationUnmeasuredSchema = z
  .object({
    dimension: coverageDimensionSchema.nullable().default(null),
    kind: z.enum(SURFACE_KINDS).nullable().default(null),
    reason: dimensionUnmeasuredReasonSchema,
    detail: z.string().min(1).max(500),
    /** Cells known to exist and not measured, or null when even the count is unknown. */
    cells: z.number().int().min(0).nullable(),
  })
  .refine((row) => row.dimension !== null || row.kind !== null, {
    message: 'an unmeasured entry must name the axis it is about',
    path: ['dimension'],
  });

/**
 * THE ATTESTATION, AND WHY THREE FIELDS HAVE NO DEFAULT.
 *
 * `scopeStatement`, `unmeasured` and `caps` are REQUIRED with no `.default()`,
 * which is deliberately stricter than `suiteHealthSnapshotSchema.caveats`.
 * There an empty list is a positive and verifiable claim that a scan truncated
 * nothing. Here it would be a claim that nothing was unmeasured, and a reader
 * given a percentage and no scope does not conclude "scope unknown" — they
 * conclude "87% of the application, and the other 13% is ordinary untested
 * code". If nine axes were never measured and a page budget truncated the crawl
 * at 1,000 URLs, that reader has been told something false by a document
 * containing no false sentence. Omission is the lie, so the writer must state
 * the scope or be refused.
 *
 * The TYPE-LEVEL half of the same guarantee lives in
 * packages/shared/src/attestation.ts, where a module-private brand makes
 * `attest()` the only way to construct one. Two mechanisms, because this
 * schema guards the wire and the brand guards the code, and neither sees the
 * other's mistakes.
 */
export const coverageAttestationSchema = z
  .object({
    snapshotId: z.string().min(1).max(64).nullable().default(null),
    issuedAtIso: z.string().datetime(),
    issuedByUserId: z.string().min(1).max(64).nullable().default(null),
    crawlVersion: z.string().min(1).max(200),
    crawlFingerprint: z.string().min(1).max(200).nullable().default(null),
    denominatorDefinition: z.string().min(1).max(2_000),
    percent: z.number().min(0).max(100).nullable(),
    denominator: z.number().int().min(0),
    covered: z.number().int().min(0),
    scopeStatement: z.string().trim().min(1).max(4_000),
    unmeasured: z.array(attestationUnmeasuredSchema).max(60),
    caps: z.array(dimensionCapBiteSchema).max(40),
    fingerprint: z.string().min(1).max(200),
  })
  .refine((row) => row.covered <= row.denominator, {
    message: 'an attestation cannot cover more of the surface than it measured',
    path: ['covered'],
  })
  .refine((row) => row.denominator > 0 || row.percent === null, {
    message: 'an empty denominator has no percentage — null is not 0 and it is not 100',
    path: ['percent'],
  });

// ─── Measuring the measurer ─────────────────────────────────────────────────

/**
 * THE BACK-TEST: does "covered" track escaped defects?
 *
 * The refinements enforce the honesty that matters most here, because this is
 * the number a buyer most wants to be flattering. With fewer than
 * `minimumDefects` the verdict must be INSUFFICIENT_DATA and BOTH rates must be
 * null — a zero escaped-defect rate on covered surface is the single most
 * flattering number this product could print, and it is exactly what a
 * back-test over three tickets produces.
 *
 * `verdictDetail` is required on every verdict including SUFFICIENT, because
 * the sentence has to state the n: "11 defects, below the 30 this comparison
 * needs" is actionable and "INSUFFICIENT_DATA" is not.
 */
export const validityBacktestSchema = z
  .object({
    snapshotId: z.string().min(1).max(64).nullable().default(null),
    windowStartAtIso: z.string().datetime(),
    windowEndAtIso: z.string().datetime(),
    defectCount: z.number().int().min(0),
    coveredSurfaceCount: z.number().int().min(0),
    uncoveredSurfaceCount: z.number().int().min(0),
    defectsOnCovered: z.number().int().min(0),
    defectsOnUncovered: z.number().int().min(0),
    /** Defects per surface. NULL WHEN INSUFFICIENT — never 0. */
    escapedRateCovered: z.number().min(0).nullable(),
    escapedRateUncovered: z.number().min(0).nullable(),
    verdict: validityVerdictSchema,
    verdictDetail: z.string().min(1).max(500),
    /** The threshold that was APPLIED, disclosed rather than implied. */
    minimumDefects: z.number().int().min(1).default(MINIMUM_BACKTEST_DEFECTS),
    /** Which tracker and which query. A rate whose input nobody can name is unreproducible. */
    defectSource: z.string().min(1).max(200),
    fingerprint: z.string().min(1).max(200),
  })
  .refine((row) => row.windowEndAtIso >= row.windowStartAtIso, {
    message: 'the window ends before it starts',
    path: ['windowEndAtIso'],
  })
  .refine((row) => row.defectsOnCovered + row.defectsOnUncovered <= row.defectCount, {
    message:
      'more defects attributed to surfaces than were counted — the parts cannot exceed the whole',
    path: ['defectCount'],
  })
  .refine(
    (row) =>
      row.verdict === 'SUFFICIENT' ||
      (row.escapedRateCovered === null && row.escapedRateUncovered === null),
    {
      message:
        'a rate beside a verdict of INSUFFICIENT_DATA or NOT_ATTEMPTED — the whole point of those ' +
        'two answers is that there is no number',
      path: ['escapedRateCovered'],
    },
  )
  .refine((row) => row.verdict !== 'SUFFICIENT' || row.defectCount >= row.minimumDefects, {
    message:
      'SUFFICIENT below the threshold this row itself declares — the verdict and the n disagree',
    path: ['verdict'],
  });

/**
 * ONE BENCHMARK RUN: what share of SEEDED defects the suite actually caught.
 *
 * The three counts are NULLABLE WITH NO DEFAULT. `0` detected is a result — a
 * terrible one — and "we did not finish" is not a result at all; defaulting
 * them would make a crashed bench report a 0% detection rate against the
 * product's own test suite, which is both false and the most alarming possible
 * false value.
 *
 * `baselineCleanAfter` is nullable for the same reason: a bench that crashed
 * never re-asserted the baseline, and null there means the run did not finish
 * rather than that the baseline was dirty.
 */
export const benchmarkRunSchema = z
  .object({
    /** Taken as an argument, never generated inside the bench: no seed, no benchmark. */
    seed: z.string().min(1).max(200),
    suiteId: z.string().min(1).max(64).nullable().default(null),
    runId: z.string().min(1).max(64).nullable().default(null),
    faultCount: z.number().int().min(0),
    detectedCount: z.number().int().min(0).nullable(),
    missedCount: z.number().int().min(0).nullable(),
    notExercisedCount: z.number().int().min(0).nullable(),
    baselineCleanBefore: z.boolean(),
    baselineCleanAfter: z.boolean().nullable(),
    startedAtIso: z.string().datetime(),
    finishedAtIso: z.string().datetime().nullable().default(null),
    caveats: z.array(z.string().min(1).max(500)).max(40).default([]),
    fingerprint: z.string().min(1).max(200),
  })
  .refine(
    (row) =>
      row.detectedCount === null ||
      row.missedCount === null ||
      row.notExercisedCount === null ||
      row.detectedCount + row.missedCount + row.notExercisedCount <= row.faultCount,
    {
      message:
        'more outcomes than faults — the parts cannot exceed the whole, and a bench that cannot ' +
        'add up is a bench nobody can quote',
      path: ['faultCount'],
    },
  )
  .refine(
    (row) =>
      row.finishedAtIso === null ||
      (row.detectedCount !== null && row.missedCount !== null && row.notExercisedCount !== null),
    {
      message: 'a finished bench must report its counts',
      path: ['detectedCount'],
    },
  )
  .refine((row) => row.finishedAtIso === null || row.baselineCleanAfter !== null, {
    message:
      'a finished bench must re-assert the clean baseline — a fault left switched on makes every ' +
      'later reading meaningless, so the check at the end is not optional',
    path: ['baselineCleanAfter'],
  });

/**
 * ONE SEEDED DEFECT, AND WHAT THE SUITE DID ABOUT IT.
 *
 * `faultClass` is required because the only useful form of this number is per
 * class: "we catch 90% of broken validations and 20% of silent failures" is a
 * finding a team acts on, and one blended percentage is a marketing number.
 *
 * `detail` is required on every outcome including NOT_EXERCISED — especially
 * NOT_EXERCISED, which is the outcome a reader is most likely to misread as a
 * miss and which needs the sentence "no test exercised ROUTE:/refunds".
 */
export const benchmarkFaultResultSchema = z
  .object({
    faultId: z.string().min(1).max(200),
    faultClass: z.string().min(1).max(120),
    /** The `CoverageItem.key` the fault lives on, when the catalogue named one. */
    surfaceItemKey: z.string().min(1).max(500).nullable().default(null),
    outcome: faultDetectionOutcomeSchema,
    detail: z.string().min(1).max(1_000),
    detectedByTestId: z.string().min(1).max(64).nullable().default(null),
  })
  .refine((row) => row.outcome !== 'DETECTED' || row.detectedByTestId !== null, {
    message:
      'DETECTED with no test named — a detection nobody can point at is the claim this whole ' +
      'benchmark exists to replace',
    path: ['detectedByTestId'],
  })
  .refine((row) => row.outcome === 'DETECTED' || row.detectedByTestId === null, {
    message: 'a test is named as having caught a fault that was not recorded as detected',
    path: ['outcome'],
  });


// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO DEPTH: principals, boundaries, synthetic values
//
// Five write paths and five refusals. Each refusal is a defect this round was
// commissioned to prevent, written as a `.refine` rather than as a comment
// asking the next person to remember:
//
//   1. a destructive step bound to a PERSISTENT principal
//   2. a boundary case whose defining constraint was never read
//   3. a synthetic value with no uniqueness scope
//   4. a test bound to an auth profile from a different project
//   5. a catalogue entry with no provenance
//
// The parity tests for every enum below live in `principals.test.ts`,
// `boundaries.test.ts` and `synthetic.contract.test.ts`, which compare each
// schema's `.options` against the list derived from its compile-time presence
// record. Both halves are needed: eight `GateRule` kinds shipped UNSAVEABLE for
// two slices because only one of the two existed, and `check:wiring` cannot see
// that class of defect — a union member with no write path is live code in a
// file that is reached.
// ─────────────────────────────────────────────────────────────────────────────

export const principalKindSchema = z.enum(PRINCIPAL_KINDS);
export const principalLifecycleSchema = z.enum(PRINCIPAL_LIFECYCLES);
export const destructiveStepKindSchema = z.enum(DESTRUCTIVE_STEP_KINDS);

/**
 * A tenant as the application under test names it.
 *
 * `id` is required and `label` is nullable, never the reverse: the id is what a
 * cross-tenant comparison is made on, and a comparison on a human label is a
 * comparison on a value the customer may legitimately duplicate.
 */
export const tenantRefSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(200).nullable().default(null),
});

/**
 * A principal, on the way into a plan item or a test.
 *
 * NOTE WHAT CANNOT BE SENT HERE. There is no field for a password, a TOTP
 * secret, an OTP, a session cookie, a storageState, a bypass token or an API
 * key, and `.strict()` means a client that sends one is REFUSED rather than
 * having it silently dropped. That is the stronger behaviour on purpose: a
 * dropped secret is a secret the sender still believes was stored, and it
 * reaches our logs on the way to being dropped.
 *
 * A credential is named by pointing `authProfileId` at a row whose
 * secret-bearing fields reference `Secret.name` — the pattern already in the
 * schema.
 */
export const principalSchema = z
  .object({
    name: z.string().min(1).max(120),
    kind: principalKindSchema,
    lifecycle: principalLifecycleSchema,
    role: z.string().min(1).max(120).nullable().default(null),
    authProfileId: z.string().min(1).max(64).nullable().default(null),
    authProfileKind: z.enum(AUTH_PROFILE_KINDS).nullable().default(null),
    tenant: tenantRefSchema.nullable().default(null),
    createdByScenario: z.string().min(1).max(200).nullable().default(null),
  })
  .strict()
  .refine((p) => p.kind !== 'ANONYMOUS' || p.authProfileId === null, {
    message:
      'an ANONYMOUS principal names an auth profile — anonymous means no credential, so this row ' +
      'claims two contradictory things and one of them will be silently ignored at run time',
    path: ['authProfileId'],
  })
  .refine((p) => p.kind !== 'DISPOSABLE' || p.createdByScenario !== null, {
    message:
      'a DISPOSABLE principal must name the scenario that created it — only a principal the ' +
      'scenario itself brought into existence may be destroyed, and an unverified disposability ' +
      'claim is how the customer’s own account gets deleted',
    path: ['createdByScenario'],
  });

/**
 * REFUSAL 1 — a destructive step bound to a PERSISTENT principal.
 *
 * The compiler already refuses this in TypeScript: a destructive step takes
 * `DestructiblePrincipal`, which only `proveDisposable` can mint. This schema
 * is the SECOND half, and it is not redundant — it guards the path the compiler
 * cannot see, which is a row arriving over HTTP or out of a model's tool call.
 * The agent validates generated plan items with these schemas, so a model that
 * proposes "log out the admin" against the customer's shared account is
 * refused on the way in rather than at the point it runs.
 *
 * ANONYMOUS is refused too, and for a different reason that matters: it is not
 * dangerous, it is MEANINGLESS. A logout scenario against a principal with no
 * session asserts nothing and would be recorded as a passing destructive test —
 * a pass that means "we did not check".
 */
export const destructiveStepSchema = z
  .object({
    kind: destructiveStepKindSchema,
    /** The principal this step acts on. Must be provably disposable. */
    target: principalSchema,
    /** What the step is for, in the words the test name will use. */
    intent: z.string().min(1).max(300),
  })
  .strict()
  .refine((step) => step.target.kind !== 'PERSISTENT', {
    message:
      'a destructive step is bound to a PERSISTENT principal — that is the customer’s own ' +
      'account and may never be damaged. Create a disposable principal in the scenario (a signup ' +
      'it performs, or an AuthProfile marked DISPOSABLE) and bind the step to that instead',
    path: ['target', 'kind'],
  })
  .refine((step) => step.target.kind !== 'ANONYMOUS', {
    message:
      'a destructive step is bound to an ANONYMOUS principal, which has no session to destroy — ' +
      'the step would assert nothing and be recorded as a passing destructive test',
    path: ['target', 'kind'],
  })
  .refine((step) => step.target.lifecycle !== 'DESTROYED', {
    message: 'the target principal is already destroyed, so this step would report a second success for one act',
    path: ['target', 'lifecycle'],
  });

export const boundaryClassSchema = z.enum(BOUNDARY_CLASSES);
export const boundaryExpectationSchema = z.enum(BOUNDARY_EXPECTATIONS);
export const boundaryRiskSchema = z.enum(BOUNDARY_RISKS);
export const boundaryConstraintSchema = z.enum(BOUNDARY_CONSTRAINTS);

/** The four terms on which a class may or may not be generated. See boundaries.ts. */
export const boundaryApplicabilityStateSchema = z.enum([
  'APPLICABLE',
  'UNBOUNDED',
  'CONSTRAINT_UNREAD',
  'INAPPLICABLE',
]);

/**
 * REFUSAL 2 — a boundary case whose defining constraint was never read.
 *
 * THE DEFECT: "type 300 characters and expect an error" against a field whose
 * `maxlength` nobody captured is a FAILING TEST THAT IS QAAI'S FAULT. The
 * customer investigates, finds their field never claimed a limit, and stops
 * trusting the suite — which costs more than the bug the test might have found.
 *
 * Three refinements, because there are three distinct ways to get this wrong:
 *
 *   · CONSTRAINT_UNREAD must not be stored as a case AT ALL. It is not a case;
 *     it is a gap in our own crawl, and it belongs in the enumeration's
 *     `unreadConstraints` count with the re-crawl remedy beside it. Letting it
 *     through here is how OUR gap gets filed as a fact about the customer.
 *   · INAPPLICABLE likewise — the class could never have applied.
 *   · `assertsRejection` is the dangerous one, and it is refused unless the
 *     state is APPLICABLE *and* the expectation is REJECTED. UNBOUNDED is the
 *     case this catches: the probe is worth running (an unbounded field is
 *     where the interesting failures are) and its outcome may NOT be asserted
 *     as a rejection, because no limit was ever claimed to be enforced.
 */
export const boundaryCaseSchema = z
  .object({
    field: z.string().min(1).max(200),
    klass: boundaryClassSchema,
    applicability: boundaryApplicabilityStateSchema,
    expected: boundaryExpectationSchema,
    risk: boundaryRiskSchema,
    /**
     * The constraint value the case was derived from, as read off the page.
     * Required when APPLICABLE — a case with no basis is a case derived from
     * nothing.
     */
    basis: z.string().min(1).max(500).nullable().default(null),
    /** Does the generated test assert that the application REJECTS this input? */
    assertsRejection: z.boolean(),
  })
  .strict()
  .refine((c) => c.applicability !== 'CONSTRAINT_UNREAD', {
    message:
      'this boundary case rests on a constraint the crawl never read, so the field has no such ' +
      'boundary — it has an unknown one. Generating here asserts a limit the page may never have ' +
      'claimed. Record it in the enumeration’s unreadConstraints count and re-crawl with ' +
      'constraint capture instead',
    path: ['applicability'],
  })
  .refine((c) => c.applicability !== 'INAPPLICABLE', {
    message: 'this boundary class cannot apply to this kind of field, so there is no case to store',
    path: ['applicability'],
  })
  .refine((c) => !c.assertsRejection || (c.applicability === 'APPLICABLE' && c.expected === 'REJECTED'), {
    message:
      'the test asserts a rejection that is not warranted: a rejection may only be asserted when ' +
      'the defining constraint was READ and the class expects REJECTED. On an UNBOUNDED field, or ' +
      'for a class whose correct behaviour is genuinely ambiguous, assert a handled outcome — no ' +
      '500, no silently discarded value — and nothing stronger',
    path: ['assertsRejection'],
  })
  .refine((c) => c.applicability !== 'APPLICABLE' || c.basis !== null, {
    message:
      'an APPLICABLE case must carry the constraint value it was derived from, so a reviewer can ' +
      'see that the 11-character string is 11 characters because the page said 10',
    path: ['basis'],
  })
  .refine((c) => BOUNDARY_DESCRIPTORS[c.klass].constraint !== 'EXISTING_VALUE' || c.basis !== null, {
    message:
      'this class needs a value already in the system before it means anything — "sign up with an ' +
      'existing email" run against an email nobody registered tests the happy path and reports a ' +
      'negative-case pass. Name the established value in `basis`',
    path: ['basis'],
  });

export const uniquenessScopeSchema = z.enum(UNIQUENESS_SCOPES);
export const cleanupObligationSchema = z.enum(CLEANUP_OBLIGATIONS);

/**
 * REFUSAL 3 — a synthetic value with no uniqueness scope.
 *
 * `uniqueness` and `cleanup` are REQUIRED with no default, and the absence of a
 * default is the whole point. A default of REUSABLE would make every value that
 * forgot to declare a scope collide on the unique index it needed, and the
 * failure would read as an application bug; a default of GLOBALLY_UNIQUE would
 * claim a guarantee the generation did not make. There is no safe default, so
 * there is no default.
 *
 * `value` is capped rather than unbounded because a synthetic value that is
 * megabytes long is a generator bug, and storing it would carry that bug into
 * the customer's repository.
 */
export const syntheticValueSchema = z
  .object({
    field: z.string().min(1).max(200),
    semantic: z.string().min(1).max(60),
    value: z.string().max(20_000),
    honoured: z.array(z.string().min(1).max(60)).max(32).default([]),
    unsatisfiable: z.array(z.string().min(1).max(60)).max(32).default([]),
    note: z.string().min(1).max(2_000).nullable().default(null),
    uniqueness: uniquenessScopeSchema,
    cleanup: cleanupObligationSchema,
  })
  .strict()
  .refine((v) => v.cleanup !== 'NONE' || v.uniqueness !== 'GLOBALLY_UNIQUE', {
    message:
      'a globally unique value that obliges no cleanup will exhaust its own namespace: every run ' +
      'consumes an identifier nothing ever releases. Declare the obligation (DELETE_ENTITY or ' +
      'RELEASE_IDENTIFIER), or UNKNOWN if the submission’s effect is genuinely unknown',
    path: ['cleanup'],
  });

/**
 * REFUSAL 4 — a test bound to an auth profile from a different project.
 *
 * THE DEFECT THIS PREVENTS is the quietest one in this file. `AuthProfile`
 * hangs off an `Environment`, which hangs off a `Project`, and nothing in the
 * `Test.authProfileId` foreign key constrains the two to agree. A test bound
 * across that line resolves a storageState for somebody else's application,
 * navigates the customer's base URL with it, gets whatever an unauthenticated
 * visitor gets, and PASSES — while being counted as authenticated coverage of a
 * page it never reached. No error is raised at any layer.
 *
 * The check needs a fact the test row does not carry, so the schema takes it:
 * `authProfileProjectId` is resolved by the caller and compared here. That is
 * deliberate rather than convenient — a refinement that cannot see both sides
 * of the comparison cannot make it, and a comment asking the route to check is
 * what the last three slices proved does not hold.
 */
export const testAuthBindingSchema = z
  .object({
    testId: z.string().min(1).max(64).nullable().default(null),
    projectId: z.string().min(1).max(64),
    authProfileId: z.string().min(1).max(64).nullable().default(null),
    /** The project the named profile actually belongs to. Resolved by the caller. */
    authProfileProjectId: z.string().min(1).max(64).nullable().default(null),
    /** "This test is meaningless signed out." The INTENT, not the binding. */
    authProfileRequired: z.boolean().default(false),
    /** The other actors, when one identity is not enough. */
    principals: z.array(principalSchema).max(16).default([]),
  })
  .strict()
  .refine((b) => b.authProfileId === null || b.authProfileProjectId !== null, {
    message:
      'the named auth profile could not be resolved to a project, so the binding cannot be ' +
      'checked — and an unchecked binding is how a test silently runs as the wrong identity, sees ' +
      'what an anonymous visitor sees, and passes',
    path: ['authProfileProjectId'],
  })
  .refine((b) => b.authProfileProjectId === null || b.authProfileProjectId === b.projectId, {
    message:
      'the test is bound to an auth profile belonging to a DIFFERENT project. Nothing would raise ' +
      'an error: the run would resolve a session for another application, browse this one ' +
      'anonymously, pass, and be counted as authenticated coverage of a page it never reached',
    path: ['authProfileId'],
  })
  .refine(
    (b) =>
      new Set(b.principals.map((p) => p.name)).size === b.principals.length,
    {
      message:
        'two principals share a name, so one would overwrite the other in RunContext.sessions and ' +
        'the test would silently act as a single identity',
      path: ['principals'],
    },
  );

/**
 * REFUSAL 5 — a catalogue entry with no provenance.
 *
 * A WRONG TEST CARD NUMBER IS A SILENT PAYMENT-TEST FAILURE: the charge is
 * declined for the wrong reason, the test asserts a decline, and it passes while
 * proving nothing. So every entry must say which provider published the value
 * and how this repo knows — `evidence` is the KIND of knowledge and
 * `sourceNote` is the sentence a reader acts on, and neither is optional.
 *
 * `.strict()` AND NO SECRET FIELD, which is the structural half of the
 * guarantee. The catalogue is incapable of holding a credential: there is no
 * property for one, and an entry that sends an extra property is refused rather
 * than having it dropped. A published test card number is not a secret — that
 * is precisely what makes it publishable — and anything that IS a secret
 * belongs on an `AuthProfile` row referencing `Secret.name`.
 */
export const testValueEntrySchema = z
  .object({
    id: z.string().min(1).max(120),
    provider: z.enum(TEST_VALUE_PROVIDERS),
    kind: z.enum(TEST_VALUE_KINDS),
    value: z.string().min(1).max(500).nullable(),
    purpose: z.string().min(1).max(300),
    /*
     * The outcome a payment value forces. OPTIONAL, because it is meaningless
     * for the non-payment kinds — a mail sink forces no payment outcome — and
     * `.strict()` means an omission here is a REFUSAL rather than a dropped
     * field. Leaving it out refused every card in the shipped catalogue, which
     * is what the "accepts every entry already in the catalogue" test exists to
     * catch: a write path that rejects the product's own data is a feature
     * nobody can save.
     */
    outcome: z.enum(PAYMENT_OUTCOMES).optional(),
    expected: z.string().min(1).max(500),
    testModeOnly: z.boolean(),
    verified: z.boolean(),
    evidence: z.enum(TEST_VALUE_EVIDENCE),
    sourceNote: z.string().min(1).max(1_000),
  })
  .strict()
  .refine((e) => e.sourceNote.trim().length > 0, {
    message:
      'a catalogue entry with no provenance cannot be acted on: a wrong test card number is a ' +
      'silent payment-test failure, so every value must say where it came from and how to confirm it',
    path: ['sourceNote'],
  })
  .refine((e) => !e.verified || e.evidence !== 'published-recalled', {
    message:
      'an entry recalled from documentation rather than fetched may not be marked verified — ' +
      'recall is the weakest evidence here and claiming otherwise is the one dishonesty this ' +
      'catalogue exists to prevent',
    path: ['verified'],
  });
