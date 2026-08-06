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
export interface RunContext {
  runId: string;
  orgId: string;
  projectId: string;
  environmentId: string;
  baseUrl: string;
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
  counts: { total: number; passed: number; failed: number; flaky: number; skipped: number };
  /** Populated once triage completes. */
  verdictCounts: Record<Verdict, number>;
  gateResult: GateResult | null;
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
  | { kind: 'MIN_PASS_RATE'; ratePercent: number; action: 'WARN' | 'BLOCK' };

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
