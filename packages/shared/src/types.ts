/**
 * Cross-cutting domain types. Anything that crosses a package boundary lives
 * here so `api`, `worker`, `runner`, `agent`, and `web` agree on one shape.
 */

import type {
  EnvironmentKind,
  Language,
  NotRunKind,
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
/*
 * TYPE-ONLY, for the same reason as the `PerformanceMetric` import below:
 * `schemas.ts` imports values out of this file, so a value import from a module
 * that `schemas.ts` also imports would close the cycle. `verbatimModuleSyntax`
 * erases this line, and the graph that executes stays schemas → flow-map →
 * surface → constants with no edge back into here.
 */
import type { AppliedCrawlPolicy } from './flow-map';
/*
 * The principal vocabulary. No cycle is possible: principals.ts imports nothing
 * from here.
 *
 * `DEFAULT_PRINCIPAL_NAME` is imported as a VALUE rather than copied, which is
 * safe because this module is not declaration-only — it already exports
 * `GATE_RULE_KINDS`, `METRIC_UNITS` and others at run time. An earlier draft
 * duplicated the literal to keep the import type-only and that was a second
 * source of truth about the one name every session lookup keys on.
 */
import { DEFAULT_PRINCIPAL_NAME } from './principals';
import type { Principal, PrincipalSession, RunPrincipalSessions } from './principals';
/*
 * The vitals vocabulary, imported rather than restated: `MAX_VITAL_BREACHES`
 * names a metric, and a gate that spelled its own six metric names would drift
 * from the plugin that measures them the first time a seventh is added.
 *
 * THIS IMPORT MUST STAY TYPE-ONLY, and the reason changed: `schemas.ts` now
 * imports `FINDING_KINDS` and `FINDING_SEVERITIES` back out of this file as
 * VALUES, because `gateRuleSchema` validates a `MAX_FINDINGS` rule and a
 * hand-written `z.enum([...])` there would be a third copy of a vocabulary
 * that already exists twice. `import type` is erased by `verbatimModuleSyntax`,
 * so the module graph that actually executes is schemas → types → constants and
 * there is no cycle. A plain `import { PERFORMANCE_METRICS }` here would close
 * it, and in ESM the loser of that race reads an uninitialised binding — so if
 * this file ever needs a VALUE from schemas.ts, the vocabulary moves down to
 * constants.ts instead.
 */
import type { PerformanceMetric } from './schemas';

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
  /**
   * The scope a crawl of this environment is permitted, resolved over the
   * build's defaults — see `resolveCrawlPolicy` in flow-map.ts.
   *
   * On the SUMMARY and not only on the panel that edits it, because the one
   * question a reader of a coverage number asks is "what was it allowed to
   * look at", and until now the answer lived in five hard-coded regexes in
   * packages/agent/src/crawler.ts that no customer could see, review or change.
   * `CrawlOptions.excludePatterns` has existed the whole time and is passed by
   * no caller.
   *
   * Optional, with the usual three states: absent means this payload predates
   * the policy (an older API, a cached response), `defaulted: true` inside it
   * means the environment never chose one, and anything else is a decision
   * somebody made and can be held to.
   */
  crawlPolicy?: AppliedCrawlPolicy | null;
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
  /**
   * Why this result has nothing measured in it, when the PLUGIN is the one that
   * knows.
   *
   * The worker already classifies the skips it decides itself — no checkout, a
   * dead base URL, no plugin for the type — and writes them as
   * `notRunMessage(kind, why)` into `errorMessage`. A plugin could not: it
   * returns SKIPPED with a plain English sentence ("k6 is not installed on this
   * image"), the tag is absent, and `parseNotRun` correctly reads that back as
   * null — "not recorded". So the one party that actually knows WHICH of the
   * four reasons applies was the one party with no way to say it, and every
   * tool-missing skip in the product reached the database untyped.
   *
   * Optional and nullable like `newBaseline` and `mutation` above, for the same
   * reason: it is a plugin-produced extra that the WORKER persists, and every
   * existing plugin that leaves it undefined keeps compiling and keeps meaning
   * exactly what it meant.
   *
   * ABSENT IS NOT `NOT_RUN`. Undefined means the plugin made no claim about
   * why, which is the fifth state `parseNotRun` and `TestResult.notRunKind`
   * both spell NULL. `NOT_RUN` is a claim — the weakest of the four, but still a
   * claim — and defaulting to it would put a sentence in the database that no
   * plugin wrote.
   */
  notRun?: { kind: NotRunKind; why: string } | null;
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

  /**
   * EVERY OTHER NUMBER THIS RUN PRODUCED, as data rather than as prose.
   *
   * ── The defect, which `mutation` above only half fixed ────────────────────
   *
   * The mutation score got five scalar columns because it is the one metric no
   * competitor ships. Every OTHER number a plugin produces still survives only
   * interpolated into a step TITLE: LCP, CLS and INP from the performance
   * plugin, k6's p95 and error rate, the visual plugin's diff ratio, the
   * accessibility plugin's violation count. "Is this project's LCP getting
   * worse?" is unanswerable without a regex over a string column, so none of
   * them can be trended, gated on or alerted on — and `MAX_VITAL_BREACHES` and
   * `MAX_P95_LATENCY_MS` are gate rules that exist, are saveable, and have no
   * stored number to read.
   *
   * A LIST AND NOT A FIXED SET OF COLUMNS, which is the opposite choice to
   * `mutation` and deliberately so. The mutation score is ONE known metric with
   * a known denominator and a trend query the `(testId, createdAt)` index
   * already serves. This is an open channel for whatever a plugin measures —
   * including plugins that do not exist yet — so the shape has to be a row per
   * reading. `TestMetricSample` is where they land.
   *
   * Optional and nullable, exactly like `mutation` and `newBaseline` above and
   * for the same reason: it is a plugin-produced extra the WORKER persists,
   * because the runner has no database access by design. Every plugin that
   * measures nothing leaves it undefined and keeps compiling.
   */
  metrics?: TestMetric[] | null;

  /**
   * ONE ROW PER (BROWSER × VIEWPORT × LOCALE × ROLE × ENVIRONMENT) THIS TEST
   * ACTUALLY RAN IN.
   *
   * ── The defect ────────────────────────────────────────────────────────────
   *
   * `TestResult` is unique on `(runId, testId)` and the harness reduces a
   * multi-variant execution WORST-WINS into that single row. So "this test
   * passes in Chromium and fails in WebKit" is stored as "this test failed",
   * and the sentence "covered in WebKit and in de-DE" is not merely unsaid, it
   * is unmeasurable. The `DEVICE_LOCALE` and `ROLE_CELL` axes of the
   * denominator have no per-variant evidence to rest on at all.
   *
   * THE WORST-WINS ROLL-UP STAYS EXACTLY AS IT IS. Every existing reader of
   * `TestResult.status` keeps the contract it was written against; this is
   * ADDITIONAL evidence underneath it, not a replacement. A run with no
   * variation leaves this undefined rather than writing one variant row that
   * duplicates the result — absent means "this execution was not varied", and
   * a single synthetic row would make an unvaried run indistinguishable from a
   * one-browser matrix somebody configured on purpose.
   */
  variants?: TestResultVariant[] | null;
}

/**
 * Which cell of the matrix one result came from.
 *
 * ── EVERY FIELD IS REQUIRED, AND NONE OF THEM IS NULLABLE ───────────────────
 *
 * Five dimensions, five strings, and the absence of a dimension is spelled with
 * a SENTINEL rather than with null. The reason is the same one
 * `RouteAccessCell.role` records and is worth restating because it is the
 * quietest possible database defect: the persisted row's identity is a unique
 * index over these five columns, PostgreSQL treats every NULL as DISTINCT from
 * every other NULL, and so a nullable dimension would make the row that matters
 * most — the default cell, the one almost every test runs in — re-insert on
 * every single run and be counted once per run.
 *
 * {@link UNVARIED} is that sentinel. `role` has a SECOND legitimate one,
 * `'<anonymous>'`, which is `ANONYMOUS_ROLE` in auth-profiles.ts and is NOT
 * redeclared here — "nobody varied the role" and "this ran as a logged-out
 * visitor" are different facts, only one of them is a claim about the
 * application, and the second one already has an owner that `roleKey` and every
 * `RouteAccessCell` row agree on. A second constant with the same value would
 * be two vocabularies for one sentinel, which is how the two halves of a key
 * come to disagree.
 */
export interface TestVariantKey {
  /** `chromium`, `webkit`, `firefox` — the runner's own spelling. */
  browser: string;
  /** `1280x720`, `iphone-14` — whatever the harness was told to emulate. */
  viewport: string;
  /** BCP-47 as the app spells it: `pt-BR`, not `pt_br`. */
  locale: string;
  /** The role the test executed as. {@link ANONYMOUS_ROLE} for logged out. */
  role: string;
  /** The environment id this cell ran against. */
  environment: string;
}

/**
 * "This dimension was not varied."
 *
 * Angle brackets because no browser, locale or environment id can contain them,
 * so the sentinel cannot collide with a real value — the same trick, and the
 * same reasoning, as `'<anonymous>'`.
 */
export const UNVARIED = '<unvaried>';

/**
 * One cell of the matrix, with its own status and its own numbers.
 *
 * `status` here is the status of THAT CELL, not of the test. The worst of these
 * is what `TestResult.status` holds, and the two must never be reconciled by
 * overwriting one with the other: a reader asking "did this pass?" wants the
 * roll-up, and a reader asking "where did this pass?" wants these rows.
 */
export interface TestResultVariant {
  key: TestVariantKey;
  status: TestResultStatus;
  durationMs: number;
  /** The cell's own failure, when this cell is the one that failed. */
  errorMessage: string | null;
  /** §5 — a retry that passes is not a pass, per cell as well as per test. */
  retriedAndPassed: boolean;
  /**
   * Why this cell has nothing measured in it. Same four reasons and the same
   * fifth state as `TestExecution.notRun`: ABSENT IS NOT `NOT_RUN`, and
   * defaulting it would put a claim in the database that no plugin made.
   */
  notRun?: { kind: NotRunKind; why: string } | null;
  /**
   * Numbers measured in THIS cell. A p95 from a de-DE WebKit run and one from a
   * Chromium en-US run are two measurements, and averaging them produces a
   * figure neither cell ever reported.
   */
  metrics?: TestMetric[] | null;
}

/**
 * Which way is better for a metric.
 *
 * A `Record`-keyed union rather than a sign convention or a boolean named
 * `higherIsBetter`, because a gate has to be able to say "fail if this got
 * worse" for both kinds of number without a caller remembering which way round
 * CLS runs. Stored per sample and not looked up from a table of known metric
 * names: the channel is open, a plugin that does not exist yet will emit a
 * metric this repo has never heard of, and a lookup table would default it to
 * one direction and gate the wrong way.
 */
export const METRIC_DIRECTIONS = ['HIGHER_IS_BETTER', 'LOWER_IS_BETTER'] as const;
export type MetricDirection = (typeof METRIC_DIRECTIONS)[number];

/**
 * What a metric's number is measured in.
 *
 * Deliberately a short, closed list of UNITS rather than of metric names. Nine
 * units cover every number the plugins produce today and leave the metric NAME
 * free-form, which is the split that lets a new plugin add a reading without a
 * migration while still making the value comparable and renderable. A unitless
 * reading is `RATIO` (CLS, a visual diff fraction) or `SCORE` (a Lighthouse-style
 * index) — never an empty string, because "unit unknown" renders as a bare
 * number beside numbers that have units, and a bare number is the thing a
 * reader misreads.
 */
export const METRIC_UNITS = [
  'MILLISECONDS',
  'SECONDS',
  'BYTES',
  'COUNT',
  'PERCENT',
  'RATIO',
  'SCORE',
  'REQUESTS_PER_SECOND',
  'PIXELS',
] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

/**
 * One numeric reading, from one plugin, about one test — or one cell of it.
 *
 * ── `value: number | null`, AND NULL IS THE WHOLE POINT ───────────────────
 *
 * Null means WE TRIED TO MEASURE THIS AND COULD NOT: the tool was absent, the
 * trace had no entry for the metric, the k6 summary was truncated. It does NOT
 * mean zero. The distinction is the same one `mutationScore` already draws and
 * it inverts the signal in exactly the same way — an LCP of 0 ms is a page that
 * painted instantly, a p95 of 0 is a load test that never ran, and a visual
 * diff ratio of 0 is a pixel-perfect match. A product that writes 0 for "not
 * measured" reports its own blind spots as its best results.
 *
 * So a null value carries a REQUIRED reason. A null with no reason would be a
 * row nobody can act on and nobody can distinguish from a writer's bug, which
 * is why `testMetricSchema` refuses it.
 */
export interface TestMetric {
  /**
   * The metric's identity, in the plugin's own spelling: `lcp`, `cls`, `inp`,
   * `http_req_duration_p95`, `visual_diff_ratio`. Stable across runs or there
   * is no trend, so it is never derived from a step title.
   */
  name: string;
  /** NULL MEANS NOT MEASURED. See the note above; there is no 0 for that. */
  value: number | null;
  /** Required exactly when `value` is null. */
  unavailableReason: string | null;
  unit: MetricUnit;
  direction: MetricDirection;
  /**
   * The cell this reading belongs to, or absent for a reading about the whole
   * test. Absent and {@link UNVARIED}-filled are the same claim here, and the
   * persisted row normalises to the sentinel so its unique index holds.
   */
  variant?: TestVariantKey | null;
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

/**
 * What kind of problem a finding is. Mirrors the `FindingKind` Postgres enum.
 *
 * Named rather than left inline on `Finding` because a gate rule now selects on
 * it (`MAX_FINDINGS.onlyKinds`), and a rule that could only be written as
 * `Finding['kind'][]` would make the gate's configuration shape depend on the
 * shape of a row.
 */
export const FINDING_KINDS = [
  'ACCESSIBILITY',
  'SECURITY',
  'PERFORMANCE',
  'LOCALIZATION',
  'VISUAL',
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/**
 * How bad one finding is, in the plugins' OWN vocabulary.
 *
 * These four words are not a scale this file invented to make gating tidy: they
 * are what the plugins already emit — axe's impact levels pass straight through
 * (`packages/runner/src/plugins/accessibility.ts`), the security smoke test
 * files a missing CSP as SERIOUS and a referrer-policy as MINOR, the performance
 * plugin files a blown budget as SERIOUS and a noisy metric as MINOR. A gate
 * that invented a fifth level, or a 1-10 score, would be gating on a number
 * nothing in the product produces.
 */
/**
 * Worst first, and the ORDER is the contract.
 *
 * `MAX_FINDINGS` is written as "at or above SERIOUS", which only means anything
 * if one list decides what "above" is. Two implementations of that ranking —
 * one in the gate, one in a screen's sort — is how a rule comes to block on a
 * severity the UI shows below the threshold.
 *
 * An `as const` array with the type derived from it, which is this repo's own
 * idiom (see constants.ts) and not decoration: `z.enum()` needs the tuple, and
 * the zod schema that validates a `MAX_FINDINGS` rule on its way into the
 * database is in a different file. A hand-written union there would be a third
 * copy of this vocabulary.
 */
export const FINDING_SEVERITIES = ['CRITICAL', 'SERIOUS', 'MODERATE', 'MINOR'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface Finding {
  kind: FindingKind;
  severity: FindingSeverity;
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
  /**
   * Playwright storageState JSON from the auth profile, when one applies (§2).
   *
   * UNCHANGED, AND IT STAYS UNCHANGED. This is the DEFAULT PRINCIPAL's session,
   * and it keeps meaning exactly what it has always meant: the one identity the
   * run resolved. Every existing plugin, harness and test that reads it keeps
   * working and keeps being right. `sessions` below generalises it; it does not
   * replace it, and nothing should be migrated off this field.
   */
  storageState: unknown | null;
  /**
   * EVERY principal's session, keyed by the scenario's own name for the actor.
   *
   * ── What this makes expressible that `storageState` could not ────────────
   *
   * One session per run made an entire class of test inexpressible, and it is
   * the class where the bugs are: "user A can read user B's invoice" had to be
   * approximated by asking ANONYMOUSLY and checking for a denial, which every
   * application gets right; invite-and-accept and submit-and-approve had no
   * second actor to be; and nothing could sweep the enumerated endpoints with
   * tenant A's token against tenant B's ids.
   *
   * ── Why it is OPTIONAL ──────────────────────────────────────────
   *
   * Same argument as `workspace` and `authProfileId` on this interface: every
   * existing construction site of `RunContext` keeps compiling and keeps
   * meaning what it meant. Absent means "this run resolved at most one
   * session", and {@link runSessions} is the one place that normalises the two
   * representations — so a reader never has to decide which field to trust.
   *
   * SECRET-BEARING, like `storageState` and `secrets`. The artifact writer and
   * log serialiser mask it; use `describePrincipal` from principals.ts for
   * anything a human or a report will read.
   */
  sessions?: RunPrincipalSessions;
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

/**
 * The one place that normalises `storageState` and `sessions` into a single
 * answer to "which sessions does this run have?".
 *
 * ── Why this exists at all ────────────────────────────────────────
 *
 * Because two fields that can both describe the default identity is two fields
 * that can DISAGREE about it, and the way that defect shows up is the worst
 * available: a test runs as the wrong identity, sees less than it should, and
 * PASSES. So no consumer should read either field directly to find a
 * principal's session — they call this, and the precedence is decided once,
 * here, rather than six times in six scenario builders.
 *
 * `sessions` wins where both describe the same name, because a value set per
 * principal is a more specific statement than a run-wide default — the same
 * precedence `ExecutableTest.authProfileId` already has over
 * `RunContext.storageState`, and chosen to match it rather than to be
 * independently reasonable.
 *
 * Returns a plain object, never a `Map`: it has to survive `structuredClone`
 * across the worker boundary.
 */
export function runSessions(ctx: {
  storageState: unknown | null;
  sessions?: RunPrincipalSessions;
  authProfileId?: string | null;
}): RunPrincipalSessions {
  const named = ctx.sessions ?? {};
  if (DEFAULT_PRINCIPAL_NAME in named) return named;
  /*
   * No default entry, so synthesise one from the legacy field. A null
   * storageState is still a session — the ANONYMOUS one — and recording it is
   * what stops a caller reading "no entry" as "we could not sign in". Those are
   * different facts and only one of them is a problem.
   */
  const fallback: PrincipalSession = {
    principal: {
      name: DEFAULT_PRINCIPAL_NAME,
      kind: ctx.storageState === null ? 'ANONYMOUS' : 'PERSISTENT',
      lifecycle: 'ACTIVE',
      role: null,
      authProfileId: ctx.authProfileId ?? null,
      authProfileKind: null,
      tenant: null,
      createdByScenario: null,
    },
    storageState: ctx.storageState,
    expiresAtIso: null,
  };
  return { ...named, [DEFAULT_PRINCIPAL_NAME]: fallback };
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
  /**
   * THE ACTORS THIS TEST NEEDS, when one identity is not enough.
   *
   * `authProfileId` above binds the test to ONE session and is the right answer
   * for most tests. It cannot express a test that needs two — and the tests
   * that need two are the authorization tests: a holder and a subject, an
   * inviter and an invitee, a submitter and an approver, a tenant and another
   * tenant.
   *
   * ── How the two fields relate ────────────────────────────────────
   *
   * They are not alternatives and the test does not choose. `authProfileId` is
   * the DEFAULT principal's binding; this list names the others. A test with
   * `authProfileId` set and this list empty is exactly what it has always been.
   * A test that names principals here gets one session per name in
   * `RunContext.sessions`, and the default one is still `storageState`.
   *
   * Carries no credential: a `Principal` names an `AuthProfile` by id and the
   * worker resolves it. See the note on `Principal` in principals.ts for why
   * that type has no field a secret could sit in.
   */
  principals?: readonly Principal[];
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

/**
 * What one rule's evaluation did about a merge.
 *
 * UNMEASURED is the fourth state and the whole reason this is a named type.
 * A `MIN_COVERAGE` rule on a project that has never computed a coverage
 * snapshot has no answer: PASS would be a claim about the customer's suite made
 * from our own silence, and BLOCK would hold a merge over a measurement WE did
 * not take. Both are lies in opposite directions, so the rule returns neither.
 *
 * An UNMEASURED evaluation never contributes to `GateResult.passed` — it cannot
 * block — and it is always rendered, because the surfaces that show a gate show
 * every evaluation's `detail`. That is deliberate: the alternative (dropping the
 * rule) makes a configured gate silently absent, and absent looks exactly like
 * green.
 */
export type GateAction = 'PASS' | 'WARN' | 'BLOCK' | 'UNMEASURED';

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
  | { kind: 'MAX_QUARANTINE_PERCENT'; percent: number; action: 'WARN' | 'BLOCK' }
  /*
   * ── The measurement rules ─────────────────────────────────────────────────
   *
   * Everything above this line is scored from the run's own result rows, which
   * is why those four rules were the only ones that ever existed: they needed
   * nothing but the suite. The consequence was that a pull request deleting the
   * only checkout test passed every gate in the product — every remaining test
   * passed, the flake rate was zero, p95 was fine, and the thing that had
   * changed (what is tested AT ALL) was not a quantity any rule could read.
   *
   * These five rules gate on what QAAI measures BESIDE the suite: the surface
   * coverage denominator, the changed surface of the diff, the findings the
   * plugins file, the mutation score, and the performance budgets. Each of them
   * can be unmeasured on a given run, and each of them says so rather than
   * passing.
   */
  /**
   * The project's surface-coverage percentage floor (§ coverage denominator).
   *
   * Scored against the most recent stored `CoverageSnapshot`, whose `percent` is
   * NULL — not 0 — when the denominator is zero. A null percentage is an
   * UNMEASURED evaluation, never a 0% failure: "we found nothing to measure" and
   * "nothing you have is covered" are different sentences and only one of them
   * is about the customer.
   */
  | { kind: 'MIN_COVERAGE'; percent: number; action: 'WARN' | 'BLOCK' }
  /**
   * The floor on the part of the surface THIS DIFF touches.
   *
   * The whole-project number moves by tenths and so gates nothing on a normal
   * pull request; patch coverage is the number that can actually refuse a merge,
   * because a change that adds an untested route scores 0% on its own changed
   * surface while the project percentage does not move.
   *
   * What it cannot see is written out in `PatchCoverage.caveats` and carried
   * into the evaluation's detail — a diff that RENAMES a route produces the same
   * evidence as one that adds a route and a stale inventory, and this rule is
   * not allowed to pretend otherwise.
   */
  | { kind: 'MIN_PATCH_COVERAGE'; percent: number; action: 'WARN' | 'BLOCK' }
  /**
   * Refuse a diff that touches a route no test covers.
   *
   * The name is the one in the defect register and it over-promises by one word:
   * NEW cannot be proven from a diff and an inventory. A route absent from the
   * inventory is either brand new or renamed or simply not extracted yet, and
   * those three leave identical evidence — so this rule gates on the routes the
   * inventory DOES know and reports the unrecognised ones as unrecognised. See
   * `PatchCoverage.unrecognised`.
   */
  | { kind: 'NO_NEW_UNCOVERED_ROUTES'; action: 'WARN' | 'BLOCK' }
  /**
   * How many findings at or above a severity a run may carry.
   *
   * This is the rule the accessibility plugin's docstring has always referred
   * to — "whether it blocks a merge is a quality-gate decision (§4), not the
   * runner's call" — and which did not exist, so a PASSED accessibility test
   * with a critical violation gated green.
   *
   * `max: 0` with `atOrAbove: 'CRITICAL'` is the one most teams want. The
   * severities are the plugins' own (`FINDING_SEVERITIES`), and `onlyKinds: []`
   * means every kind.
   */
  | {
      kind: 'MAX_FINDINGS';
      atOrAbove: FindingSeverity;
      /** Empty means every kind. */
      onlyKinds: FindingKind[];
      max: number;
      action: 'WARN' | 'BLOCK';
    }
  /**
   * The mutation-score floor — the only rule in this list that gates on whether
   * the tests ASSERT anything.
   *
   * Scored from the `mutationScore`/`mutationDetected`/`mutationUndetected`
   * columns on TestResult, and the three states those columns encode are kept
   * distinct: every column null means mutation testing did not run (UNMEASURED),
   * counts with a null score means nothing valid ran (UNMEASURED, with the
   * excluded count said out loud), and a score of 0 means every mutant survived,
   * which FAILS.
   */
  | { kind: 'MIN_MUTATION_SCORE'; percent: number; action: 'WARN' | 'BLOCK' }
  /**
   * How many Core Web Vitals budget breaches a run may carry.
   *
   * Read this one carefully, because it is deliberately NOT "LCP under 2500ms".
   * The performance plugin measures six metrics against budgets the test's spec
   * declares, and the only part of that it PERSISTS is the breach — as a
   * `PERFORMANCE` finding with the code `performance.budget-exceeded.<metric>`.
   * The median it measured lives in a step title and nowhere else.
   *
   * So a numeric vitals gate would have to regex a number out of a sentence,
   * which is precisely the defect the mutation columns were added to end. This
   * rule therefore gates on the fact the product stores (a budget was blown,
   * and on which metric) and leaves the THRESHOLD where it already is and where
   * a team can argue about it: the budget in the spec. A run with no performance
   * test in it is UNMEASURED, not a run with zero breaches.
   */
  | {
      kind: 'MAX_VITAL_BREACHES';
      /** A single metric, or every one of them. */
      metric: PerformanceMetric | 'ANY';
      max: number;
      action: 'WARN' | 'BLOCK';
    }
  /**
   * The gate evaluation that is about the ENVIRONMENT rather than about the
   * tests: nothing could be attempted, or some of it could not.
   *
   * Appended by the run finaliser (`ENVIRONMENT_GATE_RULE` in
   * apps/worker/src/processors/run.ts), not configured by a project, for the
   * same reason as `MAX_QUARANTINE_PERCENT` above — a run in which nothing was
   * measured must not be able to merge, and a brake a project can delete is not
   * a brake. It rides the gate result because a gate evaluation already reaches
   * the chat alert, the GitHub check summary, the CLI's BLOCK lines and the run
   * page's gate chip; a fifth notification channel nobody subscribes to is how
   * PAGERDUTY ended up in the Prisma enum and nowhere else.
   *
   * It carries no threshold on purpose. The whole message is in the evaluation's
   * `detail` — which blocked tests, and why — because that is the field every
   * one of those surfaces actually renders.
   */
  | { kind: 'ENVIRONMENT_AVAILABLE'; action: 'WARN' | 'BLOCK' };

/**
 * Every discriminant `GateRule` has, as a runtime value.
 *
 * ── Why this exists, and what it caught ─────────────────────────────────────
 *
 * `gateRuleSchema` in schemas.ts is the ONLY write path to
 * `Project.gateRules` (PUT /projects/:id/gate-rules parses through it). Six
 * measurement rules were added to the union above and not to that schema, so
 * for as long as that lasted no project could save one: the feature was
 * reachable only by hand-editing a database row, and `check:wiring` cannot see
 * this class of break — a union member with no write path is not a disconnected
 * FILE, so nothing flagged it.
 *
 * This list is what makes that checkable. The `Record` below is the
 * compile-time half: a record keyed on the union's own discriminant cannot be
 * written without naming every member, and naming one that does not exist is an
 * excess property, so a seventh kind breaks THIS line rather than quietly
 * shipping unsaveable. `schemas.test.ts` is the run-time half: it asserts the
 * zod union's options are exactly these.
 *
 * Two mechanisms rather than one because each catches what the other cannot. A
 * hand-written list would drift from the union; a list derived from the union
 * with no runtime form could not be compared against zod, whose options exist
 * only at run time.
 */
const GATE_RULE_KIND_PRESENT: Record<GateRule['kind'], true> = {
  BLOCK_ON_VERDICT: true,
  MAX_FLAKE_RATE: true,
  MAX_P95_LATENCY_MS: true,
  MIN_PASS_RATE: true,
  MAX_QUARANTINE_PERCENT: true,
  MIN_COVERAGE: true,
  MIN_PATCH_COVERAGE: true,
  NO_NEW_UNCOVERED_ROUTES: true,
  MAX_FINDINGS: true,
  MIN_MUTATION_SCORE: true,
  MAX_VITAL_BREACHES: true,
  ENVIRONMENT_AVAILABLE: true,
};

export const GATE_RULE_KINDS = Object.keys(GATE_RULE_KIND_PRESENT) as ReadonlyArray<
  GateRule['kind']
>;
export type GateRuleKind = GateRule['kind'];

/**
 * Why a gate result is not the one finalisation wrote, and what it replaced.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * `gateResult` was computed in `finalizeRun`, which runs BEFORE triage: the
 * default rule is `BLOCK_ON_VERDICT REAL_BUG`, no verdict row existed yet, so
 * the rule found no REAL_BUG verdicts, and the gate came back `passed: true` on
 * a run with real failures. The one rule a new project gets could not see the
 * verdicts it is named after.
 *
 * ── What re-scoring may and may not do ──────────────────────────────────────
 *
 * It SUPERSEDES. The evaluations are replaced wholesale and `generation` counts
 * how many times that has happened; nothing is ever appended, so a re-delivered
 * webhook or an overlapping sweep cannot grow the gate. A re-score whose
 * evaluations come out identical is not written at all, which is what makes the
 * operation idempotent rather than merely repeatable.
 *
 * And it says so. `reversedGreen` is set when a build that had already reported
 * a passing gate now blocks — the one transition that costs a team trust if it
 * happens quietly — and `reason` is a sentence written to be printed verbatim.
 */
export interface GateRescore {
  atIso: string;
  /** 1 is the finalisation gate; 2 and up are re-scores. */
  generation: number;
  /** What the superseded result said. */
  previousPassed: boolean;
  /** True when a gate that reported a pass now blocks. Never left implicit. */
  reversedGreen: boolean;
  /** Printable verbatim, and it names the flip when there is one. */
  reason: string;
}

export interface GateResult {
  passed: boolean;
  evaluations: Array<{
    rule: GateRule;
    /**
     * `null` when the rule's input was not measured — see {@link GateAction}.
     * Not `false`: a reader that prints "failed" for a rule nothing measured is
     * inventing a failure, and a reader that prints "passed" is inventing a
     * pass.
     */
    passed: boolean | null;
    action: GateAction;
    detail: string;
  }>;
  /**
   * How many evaluations had no answer. Present on every result the evaluator
   * produces, so a surface can say "4 of 6 rules measured" instead of showing
   * six rules and implying all six were scored.
   */
  unmeasured?: number;
  /** Present only once the gate has been scored again after triage. */
  rescored?: GateRescore;
}

// ─── Patch coverage: the join between a diff and the coverage denominator ────

/**
 * What the coverage inventory knows about one route a diff touched.
 *
 * The first five mirror `SurfaceStatus` exactly, because inventing a second
 * vocabulary for the same fact is how two screens come to disagree about one
 * route. The sixth does not exist there and is the honest part: a changed route
 * the inventory has never heard of.
 */
export type PatchSurfaceState =
  | 'COVERED'
  | 'ASSERTED_NOT_RUN'
  | 'UNCOVERED'
  | 'UNKNOWN'
  | 'WAIVED'
  /**
   * The diff names a route with no `CoverageItem` row.
   *
   * Three different worlds produce this and the evidence cannot tell them apart:
   * the route is new in this very diff, the route was renamed (the old row is
   * retired, the new one does not exist yet), or nobody has recomputed the
   * inventory since the extractor last ran. So it is counted on its own, it is
   * never folded into UNCOVERED, and it never counts as covered.
   */
  | 'NOT_IN_INVENTORY';

export interface PatchCoverageRoute {
  /** Canonical route, dynamic segments collapsed onto `:param`. */
  route: string;
  state: PatchSurfaceState;
  /** The `CoverageItem.key` this resolved to, when it resolved to one. */
  key: string | null;
  /** The changed files that implicated this route. */
  paths: string[];
  /** True when the change was a layout/template — everything BELOW this route. */
  subtree: boolean;
}

/**
 * Coverage of the surface a diff actually touches.
 *
 * `impact.ts` could map a diff to routes and the coverage store could map routes
 * to tests, and nothing joined them, so the product knew both halves of "this
 * change lands on three routes and two of them have no test" and could state
 * neither. This is that join, and the arithmetic is kept as counts so the
 * division is checkable by hand.
 */
export interface PatchCoverage {
  /** Routes in the diff the inventory knows, minus waived ones. */
  denominator: number;
  covered: number;
  assertedNotRun: number;
  uncovered: number;
  unknown: number;
  waived: number;
  /** Changed routes with no inventory row. NOT part of the denominator. */
  unrecognised: number;
  /** `covered / denominator`, one decimal, or null when there is nothing to divide. */
  percent: number | null;
  /** Every route the join considered, with what it concluded and why. */
  routes: PatchCoverageRoute[];
  /** What a reader must know before trusting the number. Never empty by default. */
  caveats: string[];
  /**
   * False when the join had nothing to join against — no coverage rows at all,
   * or a diff from which no route could be derived. A gate rule reading this
   * must report UNMEASURED rather than 0%.
   */
  measured: boolean;
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

  /* ── A verdict is about a CAUSE, not about a result ─────────────────────────
   *
   * The four columns the `20261024030000_triage_per_cause` migration added, and
   * the reason they are on the TYPE and not only in the database: triage now
   * answers once per cause and ATTACHES that answer to every member of the
   * cluster, so the shape every package passes around has to be able to say
   * which cause an answer is about and whether this particular row is the one a
   * model actually looked at. While it could not, the two facts existed only as
   * Prisma columns — so the cockpit, the CLI and the API's own read paths each
   * received a verdict they could not distinguish from a first-hand judgement.
   *
   * Required rather than optional, and that is the point. These are not an older
   * server's missing fields; they are the sentence a writer has to finish. Each
   * one has a value that means "no claim" (`null`, or revision 1) and is
   * cheaper to write than a cast.
   */

  /**
   * The cause this verdict answers — `sha1(signature)[0,12)`, byte-identical to
   * the cluster id the cockpit links on. Null while nothing has clustered this
   * result, which is a real state and not a missing one: a verdict reached
   * before the clusterer ran belongs to no cause yet.
   */
  clusterKey: string | null;

  /**
   * THE HONESTY COLUMN. The `TriageVerdict.id` this row was COPIED from, when
   * it was a copy.
   *
   * NULL means a model read this result itself. Anything else means this
   * classification was reached by looking at a different test in the same
   * cluster, and a reader who cannot tell the two apart will read 200 agreeing
   * verdicts as 200 pieces of evidence when they are one. The `cluster:` prefix
   * on `model` says the same thing to a human; this says it to a query.
   */
  derivedFromId: string | null;

  /**
   * 1 for the first answer, 2 and up after a re-triage. Never 0: there is no
   * such thing as a verdict that was never reached, and a zero here would make
   * "how many times was this re-judged" undercount by one on every row.
   *
   * The superseded contents live in `TriageVerdictRevision`, so an increment
   * here is always matched by exactly one appended revision row.
   */
  revision: number;

  /**
   * The cause this verdict was split OUT of, when a human disagreed that it
   * belonged there.
   *
   * Kept because the split is a correction of OUR clustering, not of the
   * customer's code, and it is the only record that the signature hash put two
   * different failures in one bucket. Null on every verdict nobody split.
   */
  splitFromClusterKey: string | null;
}

/**
 * The cause's identity, as a caller holds it.
 *
 * Read off `FailureSignature` / `RunFailureCluster` (apps/api/src/routes/
 * clusters.ts) and handed to `summariseFailure` in failure-summary.ts, which is
 * why it lives here rather than there: it is a row's shape, and failure-summary
 * is a pure classifier that only consumes it.
 *
 * Dates are ISO STRINGS rather than `Date`, deliberately. The web app receives
 * this off a JSON response, where it is already a string; declaring `Date` would
 * mean every web caller re-hydrating three fields in order to format one
 * sentence, and the first one to forget would be comparing a string to a Date
 * and getting `false` for free.
 */
export interface CauseIdentity {
  /** sha1(signature)[0,12) — the same key the cockpit links on. */
  clusterKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Distinct runs this cause has appeared in. */
  runsSeen: number;
  /**
   * True only when this run is the run that minted the identity. The caller
   * answers it with an equality against `firstSeenRunId`, so it is a fact
   * rather than a "have we seen it lately" heuristic.
   */
  newInThisBuild: boolean;
  /** Non-null while a mute is recorded, expired or not. */
  mutedUntil: string | null;
  mutedReason: string | null;
}

/**
 * Lifecycle of one heal proposal. Mirrors the `HealState` enum in
 * `apps/api/prisma/schema.prisma` (`check:enums` diffs them).
 *
 * It had no TypeScript mirror at all, which is why `OPEN_HEAL_STATES` in
 * packages/agent/src/healer.ts is typed `readonly string[]` and its callers
 * hand Prisma's enum straight in — a list of magic strings compared against
 * another list of magic strings, with nothing anywhere to catch a typo or a
 * seventh state.
 *
 * SUPERSEDED is included and is not optional: it is the state the supersede
 * planner WRITES, so a mirror that left it out would type-check every caller
 * except the one that matters.
 */
export const HEAL_STATES = [
  'PROPOSED',
  'APPROVED',
  'REJECTED',
  'APPLIED',
  'AUTO_APPLIED',
  'SUPERSEDED',
] as const;
export type HealState = (typeof HEAL_STATES)[number];

export interface HealProposal {
  testId: string;
  /** Unified diff against the current test file. */
  diff: string;
  explanation: string;
  /**
   * Selector-only heals are eligible for org-level auto-approve (§3.4); anything
   * touching assertions requires a human regardless of the setting.
   *
   * RETIRE mirrors the `HealRisk` member of the same name and was missing here,
   * so the one risk level that is not a patch at all — "this test should stop
   * existing", applied by disabling the test and carrying no diff — was a value
   * the database accepted and TypeScript could not name. `isAutoApprovable` in
   * packages/agent/src/healer.ts refuses it by name, and `healKindOf` switches
   * on it to tell a RETIREMENT from a PATCH; both were doing so against a
   * string the union said was impossible.
   */
  riskLevel: 'SELECTOR_ONLY' | 'ASSERTION_CHANGE' | 'STRUCTURAL' | 'RETIRE';
  confidence: number;
}

// ─── Ownership: who a failure belongs to, and which kind of nobody (§8) ──────

/**
 * Who owns something. A user or a team, never both and never a bare string.
 *
 * Declared here rather than in apps/api/src/lib/ownership.ts because
 * `OwnerAssignment` below carries one and `@qaai/shared` cannot depend on the
 * API. The matching logic — patterns, precedence, the rule table — stays there;
 * only the shape a reader receives lives here.
 */
export type OwnerRef = { kind: 'USER'; userId: string } | { kind: 'TEAM'; teamId: string };

/**
 * Why a thing has no owner — and the whole reason this is a named vocabulary.
 *
 * `owner: null` covers three situations that must not be confused, because only
 * one of them is benign:
 *
 *   NO_RULES        nobody has written any rules. Expected: ownership is opt-in.
 *   NO_MATCH        rules exist and none cover this. Someone meant to route
 *                   this area and did not.
 *   RULES_UNUSABLE  a rule that COULD have matched could not be evaluated, so
 *                   routing has silently stopped. This is the dangerous one: it
 *                   is indistinguishable from NO_MATCH from the outside, and it
 *                   means a team that believes it is being paged is not.
 *
 * A nullable `assigneeUserId` column alone cannot tell those apart, which is
 * exactly how an unowned failure ends up LOOKING owned — the worse of the two
 * failures, because nobody goes looking for it. `TriageVerdict.ownerState` is
 * the column that stores one of these, and it is a `String?` whose null means a
 * fourth thing again: nothing has tried to route this verdict yet.
 */
export const OWNERSHIP_STATES = ['OWNED', 'NO_RULES', 'NO_MATCH', 'RULES_UNUSABLE'] as const;
export type OwnershipState = (typeof OWNERSHIP_STATES)[number];

/**
 * `OWNERSHIP_STATES` plus the one state only a multi-subject ticket can be in.
 *
 * SPLIT belongs to a thing that covers MANY subjects: one cause spanning forty
 * tests owned by three teams has no single true assignee, and picking one would
 * route the whole ticket to somebody who owns a third of it. It is never
 * written on a single verdict, which is why it is a separate list rather than a
 * fifth member of the one above.
 */
export const ISSUE_OWNER_STATES = [...OWNERSHIP_STATES, 'SPLIT'] as const;
export type IssueOwnerState = (typeof ISSUE_OWNER_STATES)[number];

/** What a tracker issue was filed ABOUT. Mirrors `TrackerIssue.subject`. */
export const ISSUE_SUBJECTS = ['FAILURE', 'COVERAGE_GAP'] as const;
export type IssueSubject = (typeof ISSUE_SUBJECTS)[number];

/**
 * The resolution, in the shape a writer needs rather than a reader.
 *
 * `note` is a sentence written to be stored and shown verbatim, because the
 * person who sees "unowned" on a failure at 3am cannot open the rule list and
 * work out which of the states above they are in.
 */
export interface OwnerAssignment {
  state: OwnershipState;
  owner: OwnerRef | null;
  ruleId: string | null;
  note: string;
  /**
   * Rules that could not be evaluated. Carried even when an owner WAS found: a
   * project can route this test correctly and still have a broken rule that has
   * stopped routing twenty others.
   */
  unusable: Array<{ ruleId: string; reason: string }>;
}

// ─── Closing the coverage loop: the ledger and the campaign ─────────────────

/**
 * The closure ledger's vocabulary — what became of one coverage gap.
 *
 * Seven states, and the two that look redundant are the only reason the ledger
 * is worth building:
 *
 *   NOT_CLOSED    re-measured, a test exists, and the gap is STILL reported.
 *                 This is the FINDING. Folding it into OPEN would lose the fact
 *                 that a generation was already spent on it.
 *   UNVERIFIABLE  closure could not be checked at all — no readable crawl, or
 *                 the gap report was a ranked PAGE and this gap's absence from
 *                 that page is evidence of nothing. A gap that drops off a
 *                 truncated list and is recorded as CLOSED is the easiest way
 *                 for this number to become fiction.
 *
 * `GapClosure.state` is TEXT rather than a Prisma enum (see that migration for
 * why), so this array IS the domain and the writer validates against it at run
 * time — `isClosureState` in packages/agent/src/coverage.ts.
 */
export const CLOSURE_STATES = [
  'OPEN',
  'PROPOSED',
  'TEST_WRITTEN',
  'CLOSED',
  'NOT_CLOSED',
  'REOPENED',
  'UNVERIFIABLE',
] as const;
export type ClosureState = (typeof CLOSURE_STATES)[number];

/**
 * Whether the closure autopilot's plan items land APPROVED or PROPOSED.
 *
 * The domain of `ClosureCampaign.approvalPolicy`. HUMAN_REVIEW is the default
 * and the column carries no database default, so switching this product on for
 * an existing customer cannot also switch on unattended code generation for
 * them.
 */
export const CLOSURE_APPROVAL_POLICIES = ['AUTO_APPROVE', 'HUMAN_REVIEW'] as const;
export type ClosureApprovalPolicy = (typeof CLOSURE_APPROVAL_POLICIES)[number];

/**
 * The domain of `ClosureCampaign.state`. Seven of the eight are terminal, which
 * is the anti-spin argument restated as a type: a campaign can leave RUNNING in
 * seven different ways and re-enter it in none.
 *
 * Here rather than in apps/worker/src/processors/close-loop.ts because the API
 * renders a campaign's state and could not name it without importing a worker
 * PROCESSOR — which would drag the queue, the browser and the Prisma client
 * into an HTTP read path to borrow eight strings.
 */
export const CLOSURE_CAMPAIGN_STATES = [
  'RUNNING',
  'TARGET_MET',
  'SETTLED',
  'BUDGET_SPENT',
  'NOTHING_LEFT',
  'TICK_CEILING',
  'UNMEASURABLE',
  'BLOCKED',
] as const;
export type ClosureCampaignState = (typeof CLOSURE_CAMPAIGN_STATES)[number];

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

// ─── Suite health over time (§ measurement) ──────────────────────────────────

/**
 * One stored reading of how much the suite itself is worth.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * `Test.flakeRate` is a single Float OVERWRITTEN on every run, and the
 * suite-health score is recomputed per request from whatever is current. So rot
 * has no DIRECTION. "Is this suite getting worse?" is the premise of the entire
 * suite-health lens and it was unanswerable: a suite that had been degrading for
 * three weeks looked exactly like one that flaked this morning, and there was
 * nothing for a release to be diffed against.
 *
 * `TestFlakeHistory` fixed the PER-TEST half — one row per test per UTC day. It
 * cannot answer the suite question, and not for want of a GROUP BY: the
 * suite-level numbers are not aggregates of per-test flake at all. Weak
 * assertions, duplicates, obsolete tests and quarantine budget are properties of
 * the SUITE, computed by `packages/agent/src/suite-health.ts` from test SOURCE,
 * and nothing has ever stored one of them.
 *
 * ── EVERY MEASUREMENT HERE IS NULLABLE, AND NONE OF THEM DEFAULTS TO 0 ──────
 *
 * This is the rule the whole file turns on, so it is stated once here and
 * enforced on every field below. A `weakAssertions: 0` means the scanner looked
 * at every test and found none — the best possible result. A snapshot whose
 * scan never ran, or was truncated by a budget, or could not parse the
 * language, has NO number, and writing 0 for that is the single most flattering
 * lie this product could tell about itself. `score` obeys the same rule: null is
 * "not computed", and a 0 would read as a suite with no value whatsoever.
 */
export interface SuiteHealthSnapshotData {
  /** Tests considered. Null when the scan did not complete. */
  testCount: number | null;
  /** Tests currently quarantined — suppressed signal, not absent signal. */
  quarantinedCount: number | null;
  /**
   * Tests over the flake threshold at the moment of the reading. Null when the
   * reading did not look at flake rates, which is NOT "none are flaky".
   */
  flakyCount: number | null;
  /** Tests whose assertions the analyser rated too weak to be evidence. */
  weakAssertionCount: number | null;
  /** Near-duplicate tests: cost with no added coverage. */
  duplicateCount: number | null;
  /** Tests the analyser believes assert against surface that no longer exists. */
  obsoleteCount: number | null;
  /** Pass rate across the run this reading was taken from, 0-100. */
  passRatePercent: number | null;
  /** Median and p95 test duration, for the "is the suite getting slower" read. */
  medianDurationMs: number | null;
  p95DurationMs: number | null;
  /**
   * The composite, 0-100. NULL WHEN IT WAS NOT COMPUTED — see the note above.
   * Carried with its inputs because a composite nobody can decompose is a
   * number nobody can argue with, which is the same as a number nobody
   * believes.
   */
  score: number | null;
}

/**
 * A stored suite-health reading, with everything a reader needs to trust it.
 *
 * `caveats` is not optional and is never defaulted to an empty array by a
 * writer that did not consider it: every cap that BIT — a scan budget, a file
 * take, a parse that failed on a dialect — has to arrive here as a sentence, or
 * the score is a measurement of an unstated subset.
 */
export interface SuiteHealthSnapshot {
  id: string | null;
  projectId: string;
  createdAtIso: string;
  /** The commit this was measured against, when the caller knew it. */
  commitSha: string | null;
  /** The run it was taken from, for the pass-rate and duration halves. */
  runId: string | null;
  data: SuiteHealthSnapshotData;
  /** Things a reader must know before trusting the numbers. */
  caveats: string[];
  /** Changes whenever the answer could change. */
  fingerprint: string;
}

// ─── Owner-declared criticality and scope (§ measurement) ────────────────────

/**
 * How much a surface matters, as its OWNER says rather than as a regex guesses.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * Risk ranking is an English money-word regex, and it is `\b`-bounded, so
 * `/pay_now` and `/checkoutConfirm` both miss — the two highest-risk route
 * spellings in the sample are exactly the two it cannot see. Worse, a code
 * comment invited the customer to "tell us so" with nowhere in the product to
 * do it. This vocabulary is that somewhere.
 *
 * Four levels and not a 1-10 score, because a number invites arithmetic across
 * surfaces and the only question this answers is which list a gap goes on.
 */
export const COVERAGE_CRITICALITIES = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW'] as const;
export type CoverageCriticality = (typeof COVERAGE_CRITICALITIES)[number];

export const COVERAGE_CRITICALITY_LABELS: Record<CoverageCriticality, string> = {
  CRITICAL: 'money, auth or data loss',
  HIGH: 'core workflow',
  NORMAL: 'ordinary surface',
  LOW: 'cosmetic or internal',
};

/** The weight each level contributes when a report ranks gaps. */
export const COVERAGE_CRITICALITY_WEIGHT: Record<CoverageCriticality, number> = {
  CRITICAL: 8,
  HIGH: 4,
  NORMAL: 1,
  LOW: 0.25,
};

/** One owner-declared statement about one glob of surface. */
export interface CoverageScopeRule {
  /**
   * A glob over surface keys or route templates: `ROUTE:/admin/**`,
   * `/checkout*`. Matched against `SurfaceItem.key` and its label, so a
   * customer can write either and does not have to learn our key format to
   * use the feature.
   */
  pattern: string;
  /** Why this rule exists. A scope rule with no reason is a silent exclusion. */
  reason: string;
}

/**
 * What the customer owns about their own measurement.
 *
 * ── OUT OF SCOPE IS NOT WAIVED, AND THE DIFFERENCE IS DELIBERATE ────────────
 *
 * A `CoverageWaiver` is a decision about ONE item, with an owner and an expiry,
 * and it is listed beside the number every time the number is shown.
 * `outOfScope` is a standing statement that a whole region of the application —
 * an internal admin tool, a vendored iframe, a deprecated area behind a flag —
 * is not part of what this project is measuring at all. Both leave the
 * denominator; they leave it for different reasons, and merging them would mean
 * either a per-item waiver with no owner or a glob with a single expiry date.
 *
 * Every rule still carries a reason, every excluded item is still COUNTED and
 * NAMED in the report's held-out lists, and `maxOutOfScopePercent` exists
 * because a scope configuration that can exclude everything is a coverage
 * number its own owner can set to 100.
 */
export interface CoverageConfig {
  /**
   * Per-glob criticality, most specific last — a later rule wins, which is the
   * convention every ignore-file in existence already uses.
   */
  criticality: Array<CoverageScopeRule & { level: CoverageCriticality }>;
  /** Globs the customer declares are not part of this project's surface. */
  outOfScope: CoverageScopeRule[];
  /**
   * Extra weight for a glob when ranking gaps, multiplying the criticality
   * weight. Null for the ordinary case; a number so a team can say "our
   * checkout matters four times as much as the level alone implies".
   */
  weights: Array<CoverageScopeRule & { multiplier: number }>;
  /**
   * The ceiling on how much of the denominator `outOfScope` may remove, as a
   * percentage. The brake on the one setting in this product a customer could
   * otherwise use to make their own coverage number say anything. When the
   * rules would exceed it, the reader reports the cap AS A COUNT AND AS A
   * REASON and keeps the items in the denominator rather than silently applying
   * half the configuration.
   */
  maxOutOfScopePercent: number;
}
