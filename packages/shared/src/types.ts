/**
 * Cross-cutting domain types. Anything that crosses a package boundary lives
 * here so `api`, `worker`, `runner`, `agent`, and `web` agree on one shape.
 */

import type {
  EnvironmentKind,
  Language,
  OrgRole,
  Plan,
  Priority,
  RunStatus,
  StepStatus,
  TestResultStatus,
  TestType,
  UiFramework,
  Verdict,
} from './constants';
import type { RunJob } from './jobs';

// ─── Identity & tenancy ──────────────────────────────────────────────────────

/**
 * Every authenticated request resolves to one of these. `orgId` is what the
 * Prisma tenancy middleware scopes on — no query is trusted to scope itself.
 */
export interface ActorContext {
  userId: string;
  orgId: string;
  role: OrgRole;
  /** Set when the caller authenticated with an API key rather than a session. */
  apiKeyId: string | null;
  /** Scopes granted to the API key; a session actor has all scopes for its role. */
  scopes: string[];
  /** Superuser acting as another org (§11 impersonation). Always audit-logged. */
  impersonatedBy: string | null;
  ip: string | null;
}

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  role: OrgRole;
}

// ─── Projects & environments (§2) ────────────────────────────────────────────

export interface ProjectSummary {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  repoUrl: string | null;
  /** Drives every generated test, PR commit, and export (§7b). */
  primaryLanguage: Language;
  primaryFramework: UiFramework;
  environments: EnvironmentSummary[];
}

export interface EnvironmentSummary {
  id: string;
  name: string;
  kind: EnvironmentKind;
  baseUrl: string;
}

// ─── Runner contract (packages/runner) ───────────────────────────────────────

/** One recorded step inside a test — the unit the cockpit's scrubber renders. */
export interface StepResult {
  index: number;
  title: string;
  status: StepStatus;
  startedAt: string;
  durationMs: number;
  /** Artifact keys, resolved to signed URLs by the API. */
  screenshotKey: string | null;
  /** Present on failure. */
  error: {
    message: string;
    stack: string | null;
    /** The locator that failed, when the failure was a locator failure. */
    selector: string | null;
    /** What the test expected vs what it saw — feeds the Triage prompt. */
    expected: string | null;
    actual: string | null;
  } | null;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  /** Bodies are captured only for non-2xx by default, and always secret-masked. */
  responseBodySnippet: string | null;
}

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  at: string;
}

/** What every runner plugin returns for a single test. */
export interface TestExecution {
  testId: string;
  status: TestResultStatus;
  durationMs: number;
  steps: StepResult[];
  network: NetworkEntry[];
  console: ConsoleEntry[];
  /** Artifact keys for the whole test. */
  videoKey: string | null;
  traceKey: string | null;
  /** Top-level failure message when the test failed outside a named step. */
  errorMessage: string | null;
  /**
   * True when the test failed then passed on retry. Per §5 a retry that passes
   * is NOT a pass — it is a flake candidate and the gate treats it as such.
   */
  retriedAndPassed: boolean;
  /** Findings that are first-class results rather than pass/fail (a11y, security). */
  findings: Finding[];
  /**
   * Set by the visual plugin when it captured a NEW baseline (first run for this
   * test/viewport). The worker persists the VisualBaseline row; the plugin
   * cannot, because the runner has no database access by design.
   */
  newBaseline?: { imageKey: string; viewport: string; browser: string } | null;
  /**
   * The numbers a MUTATION run produced, as DATA rather than as prose.
   *
   * ── The defect this field exists to prevent ─────────────────────────────
   *
   * The mutation score — the only honest answer to "do these tests actually
   * assert anything?" — existed ONLY interpolated into a step's title
   * ("Mutation score 72.4% — 89 of 123 mutants killed"). Nothing outside
   * `packages/runner/src/plugins/mutation.ts` could read it. "Is this project's
   * mutation score going up?" could not be asked without a regex over a string
   * column, so the number could not be trended, gated on, or alerted on, and
   * the one metric no competitor ships was thrown away once per run.
   *
   * Optional and nullable, exactly like `newBaseline` above and for the same
   * reason: it is a plugin-produced extra the WORKER persists, because the
   * runner has no database access by design. Every plugin that is not MUTATION
   * leaves it undefined and every existing construction site keeps compiling.
   *
   * ABSENT IS NOT ZERO. Undefined/null means "mutation testing did not run
   * here"; `score: 0` means every single mutant survived, which is the worst
   * result a suite can produce. The worker writes the columns NULL for the
   * first and 0 for the second — see `mutationColumns` in
   * apps/worker/src/processors/run.ts.
   */
  mutation?: MutationRunData | null;
}

/**
 * A mutant the suite did not catch — the actionable half of a mutation run.
 *
 * "We changed `>` to `>=` on line 42 and every test still passed" names one
 * missing assertion, which is why the survivors travel with the score instead
 * of being summarised into it.
 *
 * Structurally identical to `SurvivingMutant` in
 * packages/runner/src/plugins/mutation.ts, which is where these are produced.
 * Restated here rather than imported because @qaai/shared must not depend on
 * @qaai/runner (the dependency runs the other way); the plugin should import
 * THIS declaration and delete its own, which is a one-line change to a file
 * this change does not own.
 */
export interface SurvivingMutant {
  /** Path or class the tool named, as the tool named it. */
  file: string;
  line: number | null;
  /** The mutation operator: `ArithmeticOperator`, `ConditionalsBoundary`, … */
  mutator: string;
  /** What the tool says it changed, when it says. */
  detail: string | null;
  /** `no-coverage` is a survivor no test even executed. */
  reason: 'survived' | 'no-coverage';
}

/**
 * One mutation run's numbers, built from the tool's report by
 * `mutationRunData` in packages/runner/src/plugins/mutation.ts — the same
 * record the plugin renders its headline FROM, so the stored number and the
 * printed sentence cannot drift apart.
 */
export interface MutationRunData {
  /**
   * Percentage killed, 0-100 — or null when no valid mutant ran, so there was
   * no denominator to divide by. NEVER 0 as a stand-in for "unknown": 0 means
   * every mutant survived.
   */
  score: number | null;
  /** Mutants the suite killed, including ones it killed by timing out. */
  detected: number;
  /** Mutants that lived: survived outright, or were never covered. */
  undetected: number;
  /**
   * Mutants that never really ran — compile errors, non-viable mutations.
   * Excluded from BOTH sides of the score, because an inflated mutation score
   * is worse than no score.
   */
  excluded: number;
  /** The denominator the score was computed over: detected + undetected. */
  valid: number;
  /** The threshold this run was judged against. */
  minScore: number;
  /** False when the score is null: an unevaluated suite has not passed anything. */
  passed: boolean;
  /**
   * Every survivor the tool named, uncapped. The worker caps what it STORES
   * (see `MAX_PERSISTED_SURVIVORS`) while keeping the counts above exact, so a
   * truncated list can never falsify the number.
   */
  survivors: SurvivingMutant[];
}

export interface Finding {
  kind: 'ACCESSIBILITY' | 'SECURITY' | 'PERFORMANCE' | 'LOCALIZATION' | 'VISUAL';
  severity: 'CRITICAL' | 'SERIOUS' | 'MODERATE' | 'MINOR';
  /** Stable id so the same violation dedupes across runs: axe rule id, check name. */
  code: string;
  message: string;
  /** Where: a selector, a URL, or a route. */
  location: string;
  helpUrl: string | null;
}

/** Everything a plugin needs to execute. Assembled by the worker, never by the plugin. */
/**
 * A materialised repository, as a plugin sees it.
 *
 * `source` is a human sentence naming where the tree came from
 * (`owner/name@abc1234`), because a verdict that cannot name the checkout it
 * was produced against is a verdict nobody can reproduce.
 *
 * Declared here rather than in packages/runner so that `RunContext` can carry
 * it as a field. It was a cast through a side-channel interface for exactly as
 * long as this type lived in the runner, and a context field that only exists
 * at a cast is a field the next caller does not know about.
 */
export interface RunWorkspace {
  /** Absolute path to the repository root inside this run's temp directory. */
  readonly root: string;
  /** `owner/name@ref`, for messages and logs. Never credential-bearing. */
  readonly source: string;
  /** Files written, after the materialiser's caps were applied. */
  readonly fileCount: number;
}

export interface RunContext {
  runId: string;
  orgId: string;
  projectId: string;
  environmentId: string;
  baseUrl: string;
  /**
   * The customer's repository on disk for this run, or null when none was
   * materialised. INTEGRATION, UNIT_GEN and MUTATION cannot run without it, and
   * CONTRACT, PROTOCOL, MOBILE and declared-command E2E need it whenever their
   * spec names a path — see `testNeedsRepository`. A plugin that resolves a
   * spec-supplied path against `process.cwd()` instead is resolving it against
   * QAAI's own checkout and reporting a verdict about the wrong tree.
   */
  workspace?: RunWorkspace | null;
  /**
   * Whose session this test executes under, when it named one. The worker
   * resolves the profile to a storageState before building the context; this id
   * is here so the harness can say WHICH identity failed to sign in rather than
   * falling back to anonymous and reporting a pass.
   */
  authProfileId?: string | null;
  /**
   * Decrypted secrets for this environment, keyed by name. Plugins may use these
   * freely; the artifact writer and log serialiser mask any value that appears here.
   */
  secrets: Readonly<Record<string, string>>;
  /**
   * Test data, keyed by path relative to the workspace root (e.g.
   * `fixtures/users.json`). Written into every run workspace so a spec can read
   * its data off disk. Not secret — fixtures are committed alongside the tests.
   */
  fixtures?: Readonly<Record<string, string>>;
  /**
   * A cloud browser grid to run against instead of the worker's local browser
   * (§6). Already carries the provider's credentials in the URL, so it is
   * secret-bearing and must never be logged or written into an exported repo.
   */
  grid?: { provider: string; wsEndpoint: string } | null;
  /**
   * The approved visual baseline for the test being executed, when one exists.
   * Resolved by the worker so the plugin never touches the database.
   */
  visualBaseline?: {
    imageKey: string;
    ignoreRegions: Array<{ x: number; y: number; width: number; height: number }>;
  } | null;
  /** Playwright storageState JSON from the auth profile, when one applies (§2). */
  storageState: unknown | null;
  /** Where the plugin writes screenshots/videos/traces. */
  artifacts: ArtifactSink;
  logger: RunLogger;
  /** Cooperative cancellation — plugins should poll this between steps. */
  signal: AbortSignal;
  /** Determinism kit knobs (§5). */
  determinism: {
    freezeClockAt: string | null;
    randomSeed: number;
    waitForNetworkIdle: boolean;
    retryOnce: boolean;
  };
}

export interface ArtifactSink {
  /** Returns the storage key. */
  put(name: string, body: Buffer | Uint8Array, contentType: string): Promise<string>;
  putFile(name: string, absolutePath: string, contentType: string): Promise<string>;
  /**
   * Read a previously stored artifact by its key. Visual regression needs it:
   * the baseline was written by an earlier run and has to be fetched back to
   * diff against. Returns null when the key is gone (retention, or a first run).
   */
  get(key: string): Promise<Buffer | null>;
  /**
   * Store something that must OUTLIVE this run, like an approved baseline.
   * Normal artifacts are keyed by run and swept on retention; this is not.
   */
  putPersistent(name: string, body: Buffer | Uint8Array, contentType: string): Promise<string>;
}

export interface RunLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  /** Streams a live step event to the cockpit's right pane over SSE. */
  step(event: { testId: string; index: number; title: string; status: StepStatus }): void;
}

/** A test as the runner sees it — code plus the metadata needed to execute it. */
export interface ExecutableTest {
  id: string;
  name: string;
  type: TestType;
  /** Source code in the project's primary language/framework. */
  code: string;
  filePath: string;
  /** Free-form, validated by the plugin. API tests put their request chain here. */
  spec: unknown;
  timeoutMs: number;
  /** Quarantined tests run but never gate (§5). */
  quarantined: boolean;
  tags: string[];
  /**
   * The role this test executes as (§2) — the AuthProfile whose cached
   * storageState the runner injects before the first navigation. Null or absent
   * means anonymous, which is the right answer for most tests.
   *
   * `RunContext.storageState` is per-RUN and stays what it is; this is per-TEST
   * and is what lets an admin test and a member test sit in the same suite.
   * When both are present the test's own profile wins, because a value set on
   * the test is a more specific statement than a default set on the run.
   *
   * Optional rather than required so that every existing construction site
   * keeps compiling and keeps meaning what it meant: a caller that has never
   * heard of auth profiles produces anonymous tests, exactly as before.
   */
  authProfileId?: string | null;
  /**
   * "This test is meaningless signed out." Carried to the runner so that a test
   * which asked for a role and arrived without one FAILS with that sentence
   * rather than running anonymously and passing — the quiet pass is the defect,
   * not the missing session. Set when a profile was deleted out from under the
   * test (the foreign key nulls the binding and leaves this true).
   */
  authProfileRequired?: boolean;
}

/**
 * The plugin interface (§4). One plugin per test type; the registry in
 * `packages/runner/src/registry.ts` maps TestType → plugin.
 */
export interface RunnerPlugin {
  readonly type: TestType;
  /** Throws with a readable message when the test's `spec` is malformed. */
  validate(test: ExecutableTest): void;
  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution>;
}

// ─── Runs ────────────────────────────────────────────────────────────────────

export interface RunSummary {
  id: string;
  projectId: string;
  suiteId: string | null;
  environmentId: string;
  status: RunStatus;
  trigger: 'MANUAL' | 'SCHEDULE' | 'CI' | 'WEBHOOK' | 'MONITOR';
  startedAt: string | null;
  finishedAt: string | null;
  counts: {
    total: number;
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
    /**
     * Failures that a quarantine suppressed. A FOURTH counter, not a slice of
     * `failed` and deliberately not folded into `skipped`: a suppressed failure
     * and a deliberate skip are different facts, and this one still failed.
     * `passed + failed + flaky + skipped + quarantinedFailed === total`.
     *
     * Optional only so that a client talking to an older server can tell "zero
     * suppressed" from "this server does not know about suppression".
     */
    quarantinedFailed?: number;
  };
  /** Populated once triage completes. */
  verdictCounts: Record<Verdict, number>;
  gateResult: GateResult | null;
  /**
   * The answer to "did this run pass", computed server-side by the one function
   * allowed to answer it (`runOutcome` in packages/runner/src/gates.ts).
   *
   * It is a field rather than something each client derives because it WAS
   * derived five independent times — the worker, the on-prem finaliser, the
   * CLI's exit code, `qaai status`, and the GitHub check — and four of the five
   * were wrong about quarantine. The CLI in particular cannot import the rule:
   * it ships with zero dependencies by design, so the server has to hand it the
   * verdict.
   *
   * Absent from an older server's response, and a client that finds it absent
   * must say so rather than guessing.
   */
  verdict?: {
    passed: boolean;
    /** Printable verbatim: a run that passed WITH suppressed failures says so. */
    reason: string;
    suppressedFailures: number;
  };
  commitSha: string | null;
  prNumber: number | null;
}

// ─── Billing (§9) ────────────────────────────────────────────────────────────

/**
 * Dunning state of an organisation. Mirrors the `BillingState` enum in
 * `apps/api/prisma/schema.prisma` (`check:enums` diffs them).
 *
 * PAST_DUE means Stripe reported a failed invoice payment and the org's owners
 * were told; OK means the last invoice paid. It is a record, not a gate —
 * nothing may deny a feature off this field without an explicit policy
 * decision first.
 */
export type BillingState = 'OK' | 'PAST_DUE';

// ─── Outbound notifications (§7) ─────────────────────────────────────────────

/**
 * Lifecycle of one outbound webhook/chat delivery. Mirrors the
 * `WebhookDeliveryStatus` enum in `apps/api/prisma/schema.prisma`
 * (`check:enums` diffs them).
 *
 * PENDING while retry attempts remain, SENT on the 2xx that landed, FAILED
 * once the last attempt is spent. A FAILED row holds its final error and IS
 * the dead letter — there is no separate dead-letter store to consult.
 */
export type WebhookDeliveryStatus = 'PENDING' | 'SENT' | 'FAILED';

// ─── Build sharding (§5) ─────────────────────────────────────────────────────

/**
 * Lifecycle of one slice of a sharded run. Mirrors the `RunShardStatus` enum in
 * `apps/api/prisma/schema.prisma`.
 *
 * Terminal means "this shard will not execute another test", which is the only
 * property the completion rule cares about. `ABANDONED` is terminal and means
 * the tests in the slice never ran — see RUN_SHARD_TERMINAL below.
 */
export type RunShardStatus =
  'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'ABANDONED';

/**
 * The statuses that mean a shard is done moving. A run is finished when — and
 * only when — every one of its shards is in this set. Exported so the worker's
 * completion check and any UI agree on the definition rather than each keeping
 * its own list, which is how "the run passed while shard 3 was still running"
 * gets shipped.
 */
export const RUN_SHARD_TERMINAL: readonly RunShardStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'ABANDONED',
];

/** Which slice of a sharded run a job is responsible for. */
export interface RunShardRef {
  /** 0-based, and matches `TestResult.shardIndex`. */
  index: number;
  /** Total shards in this split, so a job can log "2 of 5" without a query. */
  count: number;
}

/**
 * A run job, optionally scoped to one shard.
 *
 * `shard` is absent on every run enqueued today, and its absence is the switch:
 * a job without it executes the whole suite and finalises the run inline,
 * exactly as before sharding existed. Schedules and monitors enqueue that shape.
 */
export interface ShardedRunJob extends RunJob {
  shard?: RunShardRef | null;
}

/** One shard's slice, as decided by the packer before anything is enqueued. */
export interface ShardAssignment {
  index: number;
  testIds: string[];
  /** Predicted wall clock, in ms — the number the packer was balancing. */
  estimatedMs: number;
}

/**
 * What the API decided when asked to shard, and why. Returned on the create-run
 * response so a caller who asked for 20 shards on a plan that allows 5 is told
 * it got 5, rather than quietly getting a quarter of the parallelism it paid a
 * queue's worth of latency to arrange.
 */
export interface ShardPlan {
  requested: number;
  granted: number;
  /** What clamped it: the plan's worker ceiling, or simply having fewer tests. */
  cappedBy: 'plan' | 'tests' | null;
  /** The org's ceiling — PLAN_LIMITS[plan].maxParallelWorkers. */
  maxParallelWorkers: number;
  /** Per-shard slices, longest-first packed by recent duration. */
  assignments: ShardAssignment[];
  /** How many of the tests had duration history; the rest used the fallback. */
  testsWithHistory: number;
}

// ─── Quality gates (§4) ──────────────────────────────────────────────────────

export type GateRule =
  | { kind: 'BLOCK_ON_VERDICT'; verdict: Verdict; onlyPriorities: Priority[] }
  | { kind: 'MAX_FLAKE_RATE'; ratePercent: number; action: 'WARN' | 'BLOCK' }
  | { kind: 'MAX_P95_LATENCY_MS'; ms: number; action: 'WARN' | 'BLOCK' }
  | { kind: 'MIN_PASS_RATE'; ratePercent: number; action: 'WARN' | 'BLOCK' }
  /**
   * How much of a suite may be quarantined. Appended by the gate evaluator
   * itself, after the project's configured rules, and NOT removable by a
   * project writing its own rule list — quarantine is the mechanism that
   * switches a signal off, and a brake a project can delete is not a brake.
   *
   * Declared here rather than in packages/runner/src/gates.ts because a second
   * declaration of a union member is how two parts of a system quietly
   * disagree about what a rule is.
   */
  | { kind: 'MAX_QUARANTINE_PERCENT'; percent: number; action: 'WARN' | 'BLOCK' };

export interface GateResult {
  passed: boolean;
  evaluations: Array<{
    rule: GateRule;
    passed: boolean;
    action: 'WARN' | 'BLOCK' | 'PASS';
    detail: string;
  }>;
}

// ─── Triage & healing (§3.3, §3.4) ───────────────────────────────────────────

export interface TriageVerdict {
  verdict: Verdict;
  /** 0–1. Shown in the cockpit next to the verdict chip. */
  confidence: number;
  /** One paragraph, evidence-backed. Never hand-wavy. */
  explanation: string;
  /** Concrete things the model pointed at: step index, network entry, log line. */
  evidence: Array<{
    kind: 'STEP' | 'NETWORK' | 'CONSOLE' | 'DIFF' | 'HISTORY';
    ref: string;
    detail: string;
  }>;
  /** Populated when the repo is connected and a commit looks responsible. */
  suspectCommit: { sha: string; author: string; message: string; files: string[] } | null;
  /** Which model produced this, for the cost ledger and for A/B on prompt changes. */
  model: string;
}

export interface HealProposal {
  testId: string;
  /** Unified diff against the current test file. */
  diff: string;
  explanation: string;
  /**
   * Selector-only heals are eligible for org-level auto-approve (§3.4); anything
   * touching assertions requires a human regardless of the setting.
   */
  riskLevel: 'SELECTOR_ONLY' | 'ASSERTION_CHANGE' | 'STRUCTURAL';
  confidence: number;
}

// ─── LLM accounting (§0) ─────────────────────────────────────────────────────

export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Cents, computed from the model's published rate at call time. */
  costCents: number;
}

export interface AgentCallRecord extends TokenUsage {
  orgId: string;
  projectId: string | null;
  agent: 'EXPLORER' | 'GENERATOR' | 'TRIAGE' | 'HEALER' | 'CHAT';
  /** Free-form correlation id: runId, planId, chat message id. */
  subjectId: string | null;
  durationMs: number;
  at: string;
}
