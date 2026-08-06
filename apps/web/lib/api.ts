/**
 * Thin API client. Every call carries the session cookie, so the browser and
 * the API share one auth mechanism and the cockpit needs no token handling.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? `Request failed with ${response.status}`,
    );
  }

  return (await response.json()) as T;
}

// ─── Shapes the cockpit renders ──────────────────────────────────────────────

export interface Step {
  id: string;
  index: number;
  title: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  durationMs: number;
  screenshotKey: string | null;
  errorMessage: string | null;
  selector: string | null;
  expected: string | null;
  actual: string | null;
}

export interface Finding {
  id: string;
  kind: string;
  severity: 'CRITICAL' | 'SERIOUS' | 'MODERATE' | 'MINOR';
  code: string;
  message: string;
  location: string;
  helpUrl: string | null;
}

export interface Verdict {
  id: string;
  verdict: 'REAL_BUG' | 'INTENDED_CHANGE' | 'FLAKE' | 'ENV_ISSUE';
  confidence: number;
  explanation: string;
  evidence: Array<{ kind: string; ref: string; detail: string }>;
  reviewState: 'PENDING' | 'ACCEPTED' | 'OVERRIDDEN' | 'MUTED';
  model: string;
}

export interface TestResult {
  id: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED' | 'FLAKY' | 'TIMED_OUT';
  durationMs: number;
  errorMessage: string | null;
  retriedAndPassed: boolean;
  videoKey: string | null;
  traceKey: string | null;
  test: {
    id: string;
    name: string;
    type: string;
    priority: string;
    filePath: string;
    quarantined: boolean;
  };
  steps: Step[];
  findings: Finding[];
  verdict: Verdict | null;
}

export interface Run {
  id: string;
  environmentId: string;
  status: 'QUEUED' | 'RUNNING' | 'PASSED' | 'FAILED' | 'CANCELLED' | 'ERRORED';
  trigger: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  totalCount: number;
  passedCount: number;
  failedCount: number;
  flakyCount: number;
  skippedCount: number;
  gateResult: {
    passed: boolean;
    evaluations: Array<{ passed: boolean; action: string; detail: string }>;
  } | null;
  environment: { name: string; kind: string; baseUrl?: string };
  results?: TestResult[];
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  primaryFramework: string;
  environments: Array<{ id: string; name: string; kind: string; baseUrl: string }>;
  _count: { tests: number; runs: number };
}

// ─── Environments, secrets, integrations, git ────────────────────────────────

export interface Environment {
  id: string;
  name: string;
  kind: 'LOCAL' | 'PREVIEW' | 'STAGING' | 'PRODUCTION';
  baseUrl: string;
  createdAt?: string;
  _count?: { secrets: number };
}

/** The API never returns a plaintext value — only the name and a masked hint. */
export interface Secret {
  id: string;
  name: string;
  hint: string | null;
  updatedAt: string;
  value: string; // always the mask (••••••••+last4)
}

export interface Integration {
  id: string;
  kind: 'GITHUB' | 'GITLAB' | 'BITBUCKET';
  name: string;
  repo: string;
  defaultBranch: string;
  enabled: boolean;
  /** True once a token is stored; the token itself is never returned. */
  hasToken: boolean;
  updatedAt: string;
}

// ─── Chat & webhook integrations + the delivery log (/integrations/chat) ─────

export type ChatIntegrationKind = 'SLACK' | 'MSTEAMS' | 'DISCORD' | 'WEBHOOK';

/** off — nothing about runs · failures — failing runs only · all — every run. */
export type RunFinishedPref = 'off' | 'failures' | 'all';

export interface NotifyPrefs {
  runFinished: RunFinishedPref;
  digest: boolean;
}

/**
 * The webhook URL is the credential and is never returned by any endpoint:
 * `host` and `urlHint` (host + last four characters of the path) are all a
 * screen gets, and all it needs to tell two hooks apart.
 */
export interface ChatIntegration {
  id: string;
  kind: ChatIntegrationKind;
  name: string;
  host: string;
  urlHint: string;
  enabled: boolean;
  hasUrl: boolean;
  /** WEBHOOK only: whether the sealed envelope carries an HMAC signing secret. */
  hasSecret: boolean;
  notify: NotifyPrefs;
  createdAt: string;
  updatedAt: string;
}

/** PENDING — queued, a send is coming · SENT — the provider took it · FAILED — retries exhausted. */
export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED';

/** One row of GET /integrations/:id/deliveries — newest first. */
export interface WebhookDelivery {
  id: string;
  event: string;
  status: DeliveryStatus;
  responseStatus: number | null;
  attempts: number;
  deliveredAt: string | null;
  lastError: string | null;
  createdAt: string;
}

/** The honest outcome of POST /integrations/chat/:id/test. */
export interface ChatTestResult {
  ok: boolean;
  responseStatus: number | null;
  error: string | null;
  deliveryId: string;
}

export interface GitPreviewFile {
  path: string;
  bytes: number;
}

export interface GitPreview {
  files: GitPreviewFile[];
  totalFiles: number;
  totalBytes: number;
}

/** A Healer proposal, with the patched result the server computed for review. */
export interface Heal {
  id: string;
  testId: string;
  diff: string;
  explanation: string;
  riskLevel: 'SELECTOR_ONLY' | 'ASSERTION_CHANGE' | 'STRUCTURAL';
  confidence: number;
  state: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'APPLIED' | 'AUTO_APPLIED';
  createdAt: string;
  test: { id: string; name: string; filePath: string; code: string };
  /** Applying the diff server-side, so the UI can show a true before/after. */
  preview: {
    applies: boolean;
    code: string | null;
    reason: string | null;
    fuzz: number | null;
  };
}

// ─── Insights: coverage gaps (GET/POST /coverage) ────────────────────────────

export type GapKind =
  | 'UNVISITED_ROUTE'
  | 'UNREACHED_AUTH_ROUTE'
  | 'UNWALKED_JOURNEY'
  | 'UNSUBMITTED_FORM'
  | 'UNUSED_AFFORDANCE'
  | 'NO_NEGATIVE_CASE';

/** How much of the claim rests on something the report can point at. */
export type GapConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface CoverageFormSummary {
  name: string;
  submitLabel: string | null;
  fields: Array<{ label: string; required: boolean; semantic: string }>;
}

/** Everything the proposer needs, carried on the gap so it survives the round trip. */
export type CoverageGapSubject =
  | {
      kind: 'route';
      route: string;
      title: string;
      behindAuth: boolean;
      forms: CoverageFormSummary[];
      entryActions: string[];
    }
  | {
      kind: 'journey';
      journeyId: string;
      name: string;
      description: string;
      priority: string;
      steps: string[];
      routes: string[];
    }
  | { kind: 'form'; route: string; form: CoverageFormSummary; behindAuth: boolean }
  | {
      kind: 'affordance';
      route: string;
      label: string;
      expression: string;
      controlKind: 'link' | 'button' | 'input';
    }
  | {
      kind: 'negative';
      feature: string;
      routes: string[];
      forms: CoverageFormSummary[];
      testIds: string[];
    };

/** The plan item a gap would become — written from the crawl, before any model runs. */
export interface CoveragePlanItemPreview {
  id: string;
  title: string;
  rationale: string;
  feature: string;
  priority: string;
  testType: string;
  steps: string[];
  assertions: string[];
  journeyId: string | null;
  authProfileId: string | null;
}

export interface CoverageGap {
  id: string;
  kind: GapKind;
  title: string;
  route: string | null;
  feature: string | null;
  /** The support for the claim, in plain English. Never empty — it is the point. */
  evidence: string[];
  confidence: GapConfidence;
  reachability: number;
  blastRadius: number;
  score: number;
  scoreWhy: string[];
  relatedTestIds: string[];
  subject: CoverageGapSubject;
  /** Only with `?proposals=true`; null when the planner cannot express this gap. */
  proposal?: CoveragePlanItemPreview | null;
}

/** A test whose coverage could not be read — neither a gap nor coverage. */
export interface CoverageUnknown {
  testId: string;
  name: string;
  filePath: string;
  reason: string;
  sample: string | null;
}

export interface CoverageReport {
  /** False when there is no readable flow map — then we know nothing about the app. */
  crawled: boolean;
  flowMapId: string | null;
  flowMapVersion: number | null;
  baseUrl: string | null;
  gaps: CoverageGap[];
  unknowns: CoverageUnknown[];
  unreadable: string[];
  caveats: string[];
  totals: {
    tests: number;
    testsWithReadableRoutes: number;
    routes: number;
    routesVisited: number;
    journeys: number;
    journeysWalked: number;
    forms: number;
    formsExercised: number;
    affordances: number;
    affordancesUsed: number;
    gaps: number;
    gapsReturned: number;
  };
  fingerprint: string;
  filtered: boolean;
  limits: { maxProposalsPerRequest: number };
}

export interface CoverageProposeResult {
  jobId?: string;
  testPlanId: string;
  items: Array<{ id: string; title: string; priority: string; testType: string }>;
  mapping: Array<{ gapId: string; planItemId: string }>;
  skippedGapIds: string[];
  /** `queued: false` with a reason is a missing tool, not a failure. */
  generation: { queued: boolean; reason?: string };
  fingerprint: string;
}

// ─── Insights: suite health (GET /suite-health) ──────────────────────────────

export type HealthGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface HealthComponent {
  key: string;
  label: string;
  /** False when unmeasurable: dropped from the total, its weight redistributed. */
  available: boolean;
  score: number | null;
  weight: number;
  effectiveWeight: number;
  contribution: number;
  detail: string;
  evidence: Record<string, unknown>;
}

export type WeakAssertionKind =
  | 'NO_ASSERTIONS'
  | 'TRANSPORT_ONLY'
  | 'EXISTENCE_ONLY'
  | 'VOLATILE_ASSERTION'
  | 'SWALLOWED_ASSERTION'
  | 'NO_NEGATIVE_PATH';

export type WeakSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

export interface WeakAssertion {
  kind: WeakAssertionKind;
  severity: WeakSeverity;
  testId: string;
  testName: string;
  filePath: string;
  feature: string | null;
  line: number | null;
  /** The real source line, so the finding can be checked without opening the file. */
  quote: string;
  why: string;
  assertInstead: string;
}

export interface DuplicateRef {
  testId: string;
  name: string;
  filePath: string;
  feature: string | null;
  priority: string;
}

export interface FacetComparison {
  score: number | null;
  shared: string[];
  onlyInA: string[];
  onlyInB: string[];
}

export interface DuplicatePair {
  a: DuplicateRef;
  b: DuplicateRef;
  score: number;
  verdict: 'IDENTICAL' | 'NEAR_DUPLICATE' | 'OVERLAPPING';
  facets: {
    routes: FacetComparison;
    actions: FacetComparison;
    assertions: FacetComparison;
    data: FacetComparison;
  };
  identicalFacets: string[];
  differingFacets: string[];
  /** True when the two check different things — the reason to keep both. */
  assertionsDiffer: boolean;
  /** Always false. Nothing in the analysis can establish that a test is disposable. */
  safeToDelete: false;
  recommendation: string;
}

export interface DuplicateCluster {
  testIds: string[];
  size: number;
  members: DuplicateRef[];
  sharedRoutes: string[];
  sharedActions: string[];
  sharedAssertions: string[];
  membersDiffer: boolean;
  recommendation: string;
}

export interface JourneyCoverage {
  journeyId: string;
  name: string;
  routes: string[];
  bestRatio: number;
  status: 'COVERED' | 'PARTIAL' | 'UNCOVERED';
  coveringTestIds: string[];
  onlyQuarantined: boolean;
}

export interface SuiteHealthReport {
  projectId: string;
  score: number;
  grade: HealthGrade;
  components: HealthComponent[];
  /** The arithmetic, written out. */
  formula: string;
  duplicates: DuplicatePair[];
  duplicateClusters: DuplicateCluster[];
  weakAssertions: WeakAssertion[];
  criticalPaths: JourneyCoverage[];
  totals: {
    tests: number;
    analyzed: number;
    unanalyzed: number;
    duplicatePairs: number;
    duplicateClusters: number;
    weakAssertions: number;
    weakAssertionsBySeverity: Record<WeakSeverity, number>;
  };
  unanalyzed: Array<{ testId: string; name: string; filePath: string; reason: string }>;
  limits: {
    /** False when a cap bit — then an empty duplicate list is NOT "no duplicates". */
    duplicateScanComplete: boolean;
    duplicateScanNote: string | null;
    pairsCompared: number;
    omittedPairs: number;
    omittedClusters: number;
    skippedCommonTokens: string[];
    minSimilarity: number;
    findingsCapped: boolean;
    partial: boolean;
    maxTests: number;
    testsAnalyzed: number;
    testsMatching: number;
    note: string | null;
    flowMapVersion: number | null;
    scope: string;
  };
}

export const gitExportUrl = (projectId: string) => `${API_URL}/projects/${projectId}/git/export`;

export const artifactUrl = (runId: string, key: string) =>
  `${API_URL}/runs/${runId}/artifacts/${key.split('/').map(encodeURIComponent).join('/')}`;

// ─── Build bisect — "which commit turned this test red?" ─────────────────────
//
// Mirrors apps/api/src/lib/bisect.ts, which is the source of truth. Two
// endpoints: POST /bisect starts an investigation, GET /bisect/:id reports its
// progress and then its report.
//
// The shapes below are deliberately faithful rather than convenient. Every
// count, every flag and every caveat the API computes is carried through,
// because the point of this feature is that a person can disagree with its
// conclusion — and you cannot disagree with a suspect commit whose workings
// were dropped on the way to the screen.

/**
 * ANSWERED names a commit. The other three name nothing, and each for a
 * different, non-error reason:
 *
 *   REFUSED       the question cannot be asked of this test — most importantly
 *                 when it is too flaky to bisect, which is the feature working
 *   INCONCLUSIVE  probing started and ran out of budget, time or reachable
 *                 commits; the range is narrowed, not resolved
 *   NEEDS_PROBES  planning only — never appears on a concluded report, but the
 *                 API's own type allows it, so the UI handles it rather than
 *                 falling through to a blank panel
 */
export type BisectStatus = 'ANSWERED' | 'REFUSED' | 'NEEDS_PROBES' | 'INCONCLUSIVE';

/** Only ever `confirmed`/`probable` on an ANSWERED report; `none` otherwise. */
export type BisectConfidence = 'confirmed' | 'probable' | 'none';

/** MIXED is the fatal one: the test gave both answers on identical code. */
export type BisectCommitVerdict = 'GREEN' | 'RED' | 'MIXED' | 'UNUSABLE';

/**
 * How often this test contradicted itself at a single commit.
 *
 * `measured: false` is NOT the same as a zero rate, and the UI must never let
 * it read as one — it means too few commits were ever run twice for the
 * question to have been asked.
 */
export interface BisectFlakeEvidence {
  /** Commits with two or more usable samples — the only ones that can disagree. */
  repeatedCommits: number;
  /** Of those, the ones that produced both a pass and a failure. */
  disagreeingCommits: number;
  ratePercent: number;
  measured: boolean;
  usableSamples: number;
}

/** One commit on QAAI's timeline, with the evidence behind its verdict. */
export interface BisectTimelineEntry {
  commitSha: string;
  verdict: BisectCommitVerdict;
  passed: number;
  failed: number;
  /** Samples that measured nothing: the run errored, was cancelled, or skipped. */
  discarded: number;
  /** The runs behind the usable samples — the evidence, by id. */
  runIds: string[];
  /** False when no run at this commit recorded a commit-pinned URL to re-run against. */
  probeable: boolean;
  /** Its runs interleave with a neighbour's, so its position is inferred. */
  reordered: boolean;
  /** A probe from this investigation contributed a sample. */
  probed: boolean;
}

export interface BisectReport {
  bisectId: string;
  testId: string;
  status: BisectStatus;
  /** The accused commit. Null unless `status` is ANSWERED. */
  suspectCommit: string | null;
  lastGoodCommit: string | null;
  confidence: BisectConfidence;
  /** One paragraph: what was concluded and on what evidence. Always present. */
  summary: string;
  source: 'history' | 'history+probes';
  flake: BisectFlakeEvidence;
  probes: {
    budget: number;
    used: number;
    repeats: number;
    /** Steps where the repeats disagreed with each other. The test moved. */
    ambiguous: number;
    runIds: string[];
  };
  boundary: {
    lastGreen: string | null;
    firstRed: string | null;
    unknownBetween: number;
    priorRegressions: number;
  };
  /** Every commit considered, oldest first. */
  timeline: BisectTimelineEntry[];
  /** Everything that makes the answer weaker than it looks. Never empty. */
  caveats: string[];
}

/** A run this investigation created to test one commit. */
export interface BisectProbeRun {
  runId: string;
  commitSha: string | null;
  status: string;
  /** The test's own result inside that run. Null while it is still queued. */
  result: string | null;
  retriedAndPassed: boolean;
  queuedAt: string;
  finishedAt: string | null;
}

export interface BisectProgress {
  phase: 'reading history' | 'probing' | 'concluded';
  /** Null until a plan exists — which is most of a bisect's life. Not zero. */
  probeBudget: number | null;
  probeRepeats: number | null;
  probesDone: number;
  runsQueued: number;
  runsFinished: number;
}

/** GET /bisect/:id */
export interface BisectView {
  id: string;
  testId: string | null;
  state: 'QUEUED' | 'PROBING' | 'DONE';
  requestedAt: string | null;
  finishedAt: string | null;
  progress: BisectProgress;
  /** Present only once concluded. Until then there is no answer, not a partial one. */
  result: BisectReport | null;
  probeRuns: BisectProbeRun[];
}

/** POST /bisect — 202 either way; `reused` means an investigation was already open. */
export interface BisectStart {
  id: string;
  testId: string;
  status: 'QUEUED' | 'RUNNING';
  reused: boolean;
  message: string;
}

// ─── Infrastructure: on-prem runners and the GitHub App ──────────────────────

/**
 * What an agent says it can do, as re-validated by the API.
 *
 * Every list can be empty, and empty is meaningful: it means the agent has not
 * introduced itself yet, NOT that it can do nothing. A screen that renders
 * "browsers: none" for a runner that has simply never connected is lying about
 * the one thing an operator is looking for.
 */
export interface RunnerCapabilities {
  browsers: string[];
  testTypes: string[];
  languages: string[];
  toolchains: string[];
  maxConcurrency: number;
}

/** GET /runners — one registered agent. The token itself is never returned. */
export interface Runner {
  id: string;
  name: string;
  /** `qaai_rt_a1b2c3d4` — identifies a token without being able to authenticate. */
  tokenPrefix: string;
  pools: string[];
  capabilities: RunnerCapabilities;
  agentVersion: string | null;
  platform: string | null;
  /** Stamped on every authenticated call. Null means it has never connected. */
  lastSeenAt: string | null;
  lastClaimAt: string | null;
  tokenRotatedAt: string | null;
  createdAt: string;
  /** Server-derived: a call within the last 60 seconds. */
  online: boolean;
}

export type RunnerJobStatus =
  'QUEUED' | 'CLAIMED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'ABANDONED' | 'SKIPPED';

/** GET /runners/queue — a slice of a run waiting for, or held by, an agent. */
export interface RunnerJob {
  id: string;
  runId: string;
  shardIndex: number | null;
  status: RunnerJobStatus;
  pool: string | null;
  requirements: { testTypes?: string[]; browsers?: string[]; toolchains?: string[] };
  runnerId: string | null;
  attempt: number;
  maxAttempts: number;
  queuedAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  leaseExpiresAt: string | null;
  errorMessage: string | null;
}

/** POST /runners and POST /runners/:id/rotate — the one and only sight of a token. */
export interface MintedRunner {
  runner: { id: string; name: string; tokenPrefix: string; pools?: string[] };
  token: string;
}

// ─── GET /health/queues — the install's own BullMQ queues (ADMIN+) ───────────
//
// Mirrors apps/api/src/lib/queue-health.ts, which is the source of truth. This
// is the report that tells a dead queue from an idle one: both sit at zero
// active, but only the dead one accumulates failed jobs — and the newest
// failure's error text is what says why. Org-agnostic install infrastructure,
// so the endpoint answers 403 below ADMIN and the runners screen hides the
// block rather than erroring.

export interface WorkerQueueFailure {
  jobId: string | null;
  /** The BullMQ job name (a QAAI constant like 'qaai.run' or 'tick'). */
  name: string;
  /** First line of the failure reason, capped server-side. */
  error: string;
  failedAt: string | null;
  attemptsMade: number;
}

export interface WorkerQueueHealth {
  queue: string;
  /** Null when the queue could not be read — unknown, never zeros standing in. */
  counts: { waiting: number; delayed: number; active: number; failed: number } | null;
  newestFailure: WorkerQueueFailure | null;
}

export interface WorkerQueueHealthReport {
  generatedAt: string;
  queues: WorkerQueueHealth[];
}

/** GET /github/app — is the app set up, and where may it act? */
export interface GithubApp {
  configured: boolean;
  appId: string | null;
  webhookConfigured: boolean;
  /** What still delivers PR feedback when the app is not configured. */
  fallback: string;
  projects: Array<{
    id: string;
    name: string;
    repoFullName: string | null;
    installed: boolean;
  }>;
}

// ─── Production traffic → tests (POST /traffic/:projectId/analyze|propose) ───

export type TrafficFormat = 'HAR' | 'ACCESS_LOG' | 'OTLP';

/**
 * The categories the ingest redactor removes, mirrored from the agent package.
 * A count of 0 is a real answer — "we looked for these and this upload had
 * none" — so the screen renders every key, not only the non-zero ones.
 */
export type RedactionKind =
  | 'REQUEST_BODY'
  | 'RESPONSE_BODY'
  | 'HEADER'
  | 'COOKIE'
  | 'QUERY_VALUE'
  | 'URL_CREDENTIALS'
  | 'IP_ADDRESS'
  | 'USER_AGENT'
  | 'USER_IDENTIFIER'
  | 'EMAIL'
  | 'PHONE'
  | 'CARD_NUMBER'
  | 'NATIONAL_ID'
  | 'JWT'
  | 'OPAQUE_TOKEN'
  | 'PATH_IDENTIFIER';

export interface RedactionReport {
  /** Says in its own words that this is a stripping pass, not a display filter. */
  when: string;
  counts: Record<RedactionKind, number>;
  /** Never read at all — a stronger guarantee than "read and masked". */
  neverRead: string[];
  identityHashing: string;
  /** Parameter names retained; their values were not. */
  queryParamNamesKept: string[];
  note: string;
}

export interface TrafficJourneyStep {
  method: string;
  route: string;
  status: number | null;
  errorRate: number;
  count: number;
  /** Consecutive repeats collapsed into this step (polling, retries). */
  repeats: number;
}

export interface TrafficJourneyCoverage {
  status: 'COVERED' | 'PARTIAL' | 'UNCOVERED';
  matchedRatio: number;
  matchedTests: Array<{ id: string; name: string; matchedSteps: number }>;
  missingSteps: string[];
  /** Why the reader should not over-trust this. Shown verbatim. */
  basis: string;
}

export interface TrafficJourney {
  /** Hash of the step sequence. /propose recomputes it, so it must round-trip. */
  id: string;
  name: string;
  feature: string;
  steps: TrafficJourneyStep[];
  sessionCount: number;
  /** Share of all sessions, 0–1. The headline number on the screen. */
  sessionShare: number;
  containingSessionCount: number;
  containingSessionShare: number;
  requestCount: number;
  medianDurationMs: number | null;
  errorRate: number;
  firstSeen: string;
  lastSeen: string;
  contentKind: 'html' | 'json' | 'other' | 'mixed' | 'unknown';
  identitySources: string[];
  suggestedTestType: string;
  suggestedPriority: string;
  coverage: TrafficJourneyCoverage;
}

export interface TrafficParameterisationNote {
  template: string;
  distinctValues: number;
  observations: number;
  reason: string;
}

export interface TrafficTotals {
  parsed: number;
  skipped: number;
  skippedReasons: Record<string, number>;
  /** Line numbers only — the content of a malformed line is never echoed. */
  unparsedLineNumbers: number[];
  requests: number;
  staticAssetsFiltered: number;
  botRequestsFiltered: number;
  sessions: number;
  truncated: boolean;
}

export interface TrafficAnalysis {
  format: TrafficFormat;
  window: { from: string; to: string } | null;
  totals: TrafficTotals;
  redaction: RedactionReport;
  parameterisation: TrafficParameterisationNote[];
  identityBreakdown: Record<string, number>;
  warnings: string[];
  journeys: TrafficJourney[];
}

/** 202 with a plan, or 200 with `accepted: 0` when everything was covered. */
export interface TrafficProposal {
  jobId: string | null;
  testPlanId: string | null;
  accepted: number;
  planItemIds: string[];
  items?: Array<{ id: string; title: string; journeyId: string | null }>;
  skipped: Array<{ what: string; why: string }>;
  message?: string;
  /**
   * `queued: false` with a reason is a missing tool, not a failure — the plan
   * items exist either way. Absent on the "everything was already covered"
   * response, where no plan was created and there was nothing to generate.
   */
  generation?: { queued: boolean; reason?: string };
}

// ─── Reproduce a bug report (POST /repro/:projectId) ─────────────────────────

export type ReproStepsFormat =
  'ORDERED' | 'STEP_N' | 'GHERKIN' | 'BULLET' | 'INLINE' | 'LINES' | 'NONE';

export interface ReproExtracted {
  title: string | null;
  steps: string[];
  stepsFormat: ReproStepsFormat;
  expected: string | null;
  actual: string | null;
  environment: {
    browser: string | null;
    os: string | null;
    device: string | null;
    appVersion: string | null;
    envName: string | null;
    raw: string | null;
  };
  urls: string[];
  paths: string[];
  selectors: string[];
  errorStrings: string[];
  codeBlocks: string[];
  found: string[];
  /** 0–1. How much of the work the reporter's prose did. */
  structureScore: number;
  narrative: string;
  enrichedFields: string[];
}

export interface ReproRouteMatch {
  reported: string;
  route: string | null;
  nodeId: string | null;
  how: 'EXACT' | 'PARAMETERISED' | 'NORMALISED' | 'FUZZY' | 'NONE';
  offEnvironment: boolean;
}

export interface ReproFlowMatch {
  matches: ReproRouteMatch[];
  startRoute: string | null;
  nodeIds: string[];
  feature: string | null;
  warnings: string[];
}

export interface ReproDuplicate {
  testId: string;
  name: string;
  filePath: string;
  score: number;
  reasons: string[];
}

export interface ReproPlanItem {
  id: string;
  title: string;
  rationale: string;
  feature: string | null;
  priority: string;
  testType: string;
  steps: string[];
  /** Always the EXPECTED behaviour — asserting the observed one proves nothing. */
  assertions: string[];
}

export interface ReproVerdict {
  outcome: 'REPRODUCED' | 'NOT_REPRODUCED' | 'INCONCLUSIVE';
  headline: string;
  detail: string;
  matchedReportedError: string | null;
  /** True only when the run failed AND failed for the reported reason. */
  confirmed: boolean;
}

export interface ReproResponse {
  source: { kind: 'TEXT' } | { kind: 'ISSUE'; provider: string; key: string; url: string };
  extracted: ReproExtracted;
  flowMatch: ReproFlowMatch;
  duplicate: ReproDuplicate | null;
  duplicateCandidates: ReproDuplicate[];
  planItem: ReproPlanItem;
  notes: string[];
  test: {
    id: string;
    name: string;
    filePath: string;
    code: string;
    reviewFlags: string[];
    /** False until the run has been SEEN to fail. */
    enabled: boolean;
  } | null;
  run: {
    id: string;
    status: string;
    finished: boolean;
    waitedMs: number;
    result?: { status: string; errorMessage: string | null; durationMs: number } | null;
  } | null;
  reproduction: ReproVerdict | null;
  /** Present when the deterministic half ran but no test was written. */
  generation?: { skipped: true; reason: string };
}

// ─── Failure clusters (GET /clusters/run/:runId) ─────────────────────────────
//
// APPENDED. Mirrors apps/api/src/lib/cluster.ts, which is the source of truth.
//
// The endpoint has been mounted and answering since failure clustering shipped
// and nothing in the web app had ever called it. The cockpit lists failures one
// per row, which is right for three and useless for forty; this is the answer
// to "how many *causes* am I looking at", which is the question a red build
// actually raises.

export interface ClusterFacets {
  /** `TimeoutError`, `net::ERR_CONNECTION_REFUSED`, … */
  errorClass: string | null;
  /** The call that threw: `page.goto`, `locator.click`. */
  call: string | null;
  /** The matcher that failed: `toBeVisible`, `http-status`. */
  assertion: string | null;
  selector: string | null;
  /** Failing URL, with dynamic segments and query values already removed. */
  endpoint: string | null;
  httpStatus: number | null;
  message: string;
}

export interface ClusterMember {
  testResultId: string;
  testId: string;
  testName: string;
  filePath: string | null;
  status: string;
  retriedAndPassed: boolean;
  /** The verdict already on this result, so an override stays visible. */
  verdict: Verdict['verdict'] | null;
}

/**
 * A recommendation attached to a group — never a decision. `basis` is carried
 * so the UI can say where it came from rather than presenting a guess as a
 * finding; accepting it stays a human action on the triage screen.
 */
export interface ClusterSuggestion {
  verdict: Verdict['verdict'];
  basis: 'HUMAN_OVERRIDE' | 'TRIAGE_MAJORITY' | 'SIGNATURE';
  reason: string;
}

export interface FailureCluster {
  id: string;
  signature: string;
  /** What a person would call this cause, in a sentence they could say aloud. */
  label: string;
  count: number;
  facets: ClusterFacets;
  members: ClusterMember[];
  suggested: ClusterSuggestion;
  /** One member's untouched error text, so the grouping can be audited. */
  sample: string;
}

/** A failure that matched nothing else — same shape minus the plural claims. */
export interface UnclusteredFailure {
  id: string;
  signature: string;
  label: string;
  facets: ClusterFacets;
  member: ClusterMember;
  sample: string;
  /** NO_SIGNAL means the error carried nothing to group on — not "it is unique". */
  reason: 'ONLY_OCCURRENCE' | 'NO_SIGNAL';
}

export interface ClusterReport {
  run: {
    id: string;
    projectId: string;
    status: string;
    totalCount: number;
    failedCount: number;
    flakyCount: number;
    finishedAt: string | null;
  };
  clusters: FailureCluster[];
  unclustered: UnclusteredFailure[];
  /**
   * `failures` counts what was CLUSTERABLE, which can be lower than the run's
   * failedCount when a result carried no error text. Both are returned so the
   * UI never has to explain a number it cannot reconcile.
   */
  summary: { failures: number; clustered: number; clusters: number; largestCluster: number };
}

// ─── Impact analysis (POST /impact/analyze, GET /impact/signals) ─────────────
//
// APPENDED. Mirrors apps/api/src/lib/impact.ts. Also never called from the web
// until now: the endpoints shipped with a curl recipe in their own doc comment
// and no screen.

export type ImpactConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
export type ImpactStrategy = 'RUN_EVERYTHING' | 'SELECTIVE' | 'SMOKE_FLOOR';

export interface ImpactRouteRef {
  route: string;
  /** True for layouts/templates: the change lands on everything BELOW this route. */
  subtree: boolean;
}

export interface ImpactAttribution {
  path: string;
  kind:
    | 'test-file'
    | 'test-support'
    | 'framework-page'
    | 'framework-layout'
    | 'server-route'
    | 'named-source'
    | 'global'
    | 'documentation'
    | 'unattributable';
  routes: ImpactRouteRef[];
  tokens: string[];
  confidence: ImpactConfidence;
  why: string;
  /** True when this file alone forces the whole suite. */
  blastRadius: boolean;
  /** True when the file cannot affect the running app at all. */
  ignored: boolean;
}

export interface ImpactDecision {
  testId: string;
  name: string;
  filePath: string;
  priority: string;
  feature: string | null;
  decision: 'run' | 'skip';
  /** One sentence per test — the point of the feature is that this is readable. */
  reason: string;
  confidence: ImpactConfidence;
  signals: string[];
  matchedPaths: string[];
}

export interface ImpactAnalysis {
  strategy: ImpactStrategy;
  reason: string;
  confidence: ImpactConfidence;
  savedPercent: number;
  run: ImpactDecision[];
  skip: ImpactDecision[];
  /** Ready to POST as `testIds` to /runs — no other endpoint has to change. */
  testIds: string[];
  attributions: ImpactAttribution[];
  totals: { tests: number; run: number; skip: number; changedPaths: number };
  /** Null when the app has never been crawled — then only route literals count. */
  flowMapVersion: number | null;
  limits: { maxChangedPaths: number };
}

export interface ImpactSignal {
  testId: string;
  name: string;
  filePath: string;
  priority: string;
  feature: string | null;
  tags: string[];
  routes: string[];
  tokens: string[];
  /** False when the test declares nothing a diff can be checked against. */
  known: boolean;
  coverageTruncated: boolean;
}

export interface ImpactSignals {
  signals: ImpactSignal[];
  flowMapVersion: number | null;
  unknownCount: number;
}

// ─── One test's behaviour (GET /suite-health/:projectId/tests/:testId) ───────
//
// APPENDED. The per-test half of the suite-health report. The project-wide
// report has had a screen since Insights shipped; this one answers "is THIS
// test any good", which is the question you have while looking at a flaky one.

export interface AssertionSite {
  line: number;
  /** The real source line, so the finding can be checked without opening the file. */
  quote: string;
  target: string;
  matcher: string;
  negated: boolean;
  arg: string;
  argKind: string;
  kind: string;
  volatile: boolean;
  volatileReason: string | null;
  /** True when a try/catch swallows the failure — the assertion cannot fail. */
  swallowed: boolean;
  swallowLine: number | null;
}

export interface TestBehavior {
  testId: string;
  name: string;
  behavior: {
    routes: string[];
    actions: string[];
    assertions: string[];
    data: string[];
    assertionSites: AssertionSite[];
  };
  weakAssertions: WeakAssertion[];
  /** True when the parse gave up — an empty finding list then means nothing. */
  incomplete: boolean;
  incompleteReason: string | null;
}
