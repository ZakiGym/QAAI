/**
 * Native HTTP runner (§4 API tests).
 *
 * No browser. Chained requests with variable extraction, and assertions on
 * status, latency, and body shape. Each request in the chain becomes a cockpit
 * step so a failing chain shows exactly which hop broke.
 *
 * An API test is the likeliest thing in the product to leave residue: a POST
 * that creates an order is a passing test whether or not anything ever deletes
 * the order. When a spec opts in with a `leakCheck` block, the chain runs inside
 * a leak watch and anything it left behind is reported as a FINDING — never as a
 * failure, and never at the cost of the run's own result. See `../leaks.ts`.
 *
 * A spec may also opt in to a `dataset` block, and then the same chain runs once
 * per row with that row's values interpolated (§4 data-driven testing). The unit
 * of reporting changes when it does: a data-driven test reports ONE STEP PER
 * ROW, so `case 17 of 30 — "SAVE10"` is red and the other twenty-nine are green,
 * instead of a single red "the test failed" that says nothing about which of the
 * thirty discount codes is broken. Rows are independent — one failing never
 * stops the rest — and the summary names the failures by their key column. See
 * `../data-driven.ts`, which owns every rule about how a row becomes a request.
 */

import { apiTestSpecSchema, maskDeep } from '@qaai/shared';
import type {
  ApiTestSpec,
  ExecutableTest,
  Finding,
  NetworkEntry,
  RunContext,
  RunnerPlugin,
  StepResult,
  TestExecution,
} from '@qaai/shared';
import { beginLeakWatch, parseLeakConfig } from '../leaks.js';
import type { LeakWatch } from '../leaks.js';
import {
  DatasetConfigError,
  collectPlaceholders,
  expectationMatches,
  formatDatasetSummary,
  interpolateByName,
  interpolateJsonValue,
  interpolateTracked,
  loadDataset,
  parseDatasetConfig,
  rowStepTitle,
  summariseDataset,
  unresolvedPlaceholders,
} from '../data-driven.js';
import type { DatasetRow, DatasetRowOutcome } from '../data-driven.js';

/** Response bodies are truncated before they are stored or shown to the model. */
const BODY_SNIPPET_LIMIT = 2000;

/**
 * How many network entries a data-driven test keeps.
 *
 * A thousand rows times a four-hop chain is four thousand entries on one result
 * row, which is a payload problem rather than a reporting one. When the cap
 * bites, entries from failing and unevaluated rows are kept first: those are the
 * ones anybody opens.
 */
const MAX_DATASET_NETWORK_ENTRIES = 300;

/** Dotted-path read with array-index support: `data.items.0.id`. */
function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node)) return node[Number(key)];
    if (typeof node === 'object') return (node as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

/**
 * Where a hop's request actually goes.
 *
 * Absolute-vs-relative is decided from the RAW path — the spec author's intent —
 * and not from the text after interpolation, because those are two different
 * questions once values arrive from somewhere other than the spec. A relative
 * path whose placeholder happens to hold `https://elsewhere.example` is a
 * request leaving the environment under test, and when the value came from a
 * dataset row or from a response body (`extract`) rather than from the spec, the
 * thing choosing the destination is data. So that combination is refused and the
 * request is never made.
 *
 * Spec-authored variables and vault secrets keep working exactly as before,
 * including the `path: "{{apiBase}}/orders"` pattern: the spec is allowed to
 * point a test wherever it likes. Only values the spec did not write are pinned.
 */
function resolveUrl(
  baseUrl: string,
  rawPath: string,
  interpolatedPath: string,
  untrusted: ReadonlySet<string>,
): string {
  if (/^https?:\/\//i.test(rawPath)) return interpolatedPath;

  const url = new URL(interpolatedPath, baseUrl);
  if (url.origin !== new URL(baseUrl).origin) {
    const culprits = [...collectPlaceholders(rawPath)].filter((name) => untrusted.has(name));
    if (culprits.length > 0) {
      throw new OffOriginError(
        `The path "${rawPath}" interpolated to ${url.origin}, which is not this environment's base URL (${new URL(baseUrl).origin}). ` +
          `${culprits.map((c) => `"${c}"`).join(', ')} comes from test data rather than from the spec, so the request was not sent.`,
      );
    }
  }
  return url.toString();
}

/** A request that was refused before it was sent. Reported as the hop's problem. */
class OffOriginError extends Error {}

// ─── One hop ─────────────────────────────────────────────────────────────────

interface HopOutcome {
  problems: string[];
  expected: string | null;
  actual: string | null;
  startedAt: string;
  durationMs: number;
  entry: NetworkEntry;
}

/**
 * Execute one request in the chain and evaluate its assertions.
 *
 * Mutates `vars` with anything the step extracts — the chain's whole point — and
 * never throws for anything the application did: a transport error is a problem
 * on the hop, not an exception, so the rest of the run keeps its shape.
 */
async function runHop(
  ctx: RunContext,
  step: ApiTestSpec['steps'][number],
  vars: Record<string, string>,
  untrusted: ReadonlySet<string>,
): Promise<HopOutcome> {
  const stepStarted = Date.now();
  const stepStartedAt = new Date().toISOString();

  let url: string;
  try {
    url = resolveUrl(ctx.baseUrl, step.path, interpolateByName(step.path, vars), untrusted);
  } catch (err) {
    if (!(err instanceof OffOriginError)) throw err;
    return {
      problems: [err.message],
      expected: null,
      actual: null,
      startedAt: stepStartedAt,
      durationMs: 0,
      entry: {
        method: step.method,
        url: step.path,
        status: null,
        durationMs: 0,
        responseBodySnippet: null,
      },
    };
  }

  const headers = Object.fromEntries(
    Object.entries(step.headers).map(([k, v]) => [k, interpolateByName(v, vars)]),
  );

  let body: string | undefined;
  if (step.body !== undefined) {
    // Structural, not textual: see `interpolateJsonValue`. A value carrying a
    // quote must not be able to add fields to the document it lands in.
    body = JSON.stringify(interpolateJsonValue(step.body, vars));
    headers['content-type'] ??= 'application/json';
  }

  let responseStatus: number | null = null;
  let responseText = '';
  let transportError: string | null = null;

  try {
    const response = await fetch(url, {
      method: step.method,
      headers,
      body,
      signal: ctx.signal,
      redirect: 'manual',
    });
    responseStatus = response.status;
    responseText = await response.text();
  } catch (err) {
    transportError = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - stepStarted;

  const entry: NetworkEntry = {
    method: step.method,
    url,
    status: responseStatus,
    durationMs,
    responseBodySnippet:
      responseStatus === null || responseStatus >= 400
        ? responseText.slice(0, BODY_SNIPPET_LIMIT)
        : null,
  };

  const problems: string[] = [];
  let expected: string | null = null;
  let actual: string | null = null;

  if (transportError) {
    problems.push(`Request failed: ${transportError}`);
  } else {
    const a = step.assertions;

    if (a.status !== undefined && responseStatus !== a.status) {
      problems.push(`Expected HTTP ${a.status}, got ${responseStatus}`);
      expected = `HTTP ${a.status}`;
      actual = `HTTP ${responseStatus}`;
    }

    if (a.maxLatencyMs !== undefined && durationMs > a.maxLatencyMs) {
      problems.push(`Took ${durationMs}ms, budget is ${a.maxLatencyMs}ms`);
    }

    // Assertions are interpolated too, and have to be: a dataset that can only
    // vary the INPUT is half a feature. "code SAVE10 shows 10% off" is one row
    // with two columns, and it is the shape every real data table has. (A
    // non-data-driven test is unaffected in practice — an unknown name is left
    // alone, exactly as it always was.)
    if (a.bodyContains !== undefined) {
      const wanted = interpolateByName(a.bodyContains, vars);
      if (!responseText.includes(wanted)) {
        problems.push(`Response body does not contain ${JSON.stringify(wanted)}`);
        expected ??= wanted;
      }
    }

    let parsedBody: unknown;
    const needsJson = a.bodyMatches !== undefined || Object.keys(step.extract).length > 0;
    if (needsJson) {
      try {
        parsedBody = JSON.parse(responseText);
      } catch {
        problems.push('Response was not valid JSON');
      }
    }

    for (const [rawPath, rawWant] of Object.entries(a.bodyMatches ?? {})) {
      const path = interpolateByName(rawPath, vars);
      // Only string expectations can carry a placeholder; a number or a boolean
      // in the spec is already the value it means.
      const filled = typeof rawWant === 'string' ? interpolateTracked(rawWant, vars) : null;
      const want = filled ? filled.text : rawWant;

      const got = readPath(parsedBody, path);
      if (!expectationMatches(got, want, filled?.substituted ?? false)) {
        problems.push(
          `Body at "${path}" was ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
        );
        expected ??= JSON.stringify(want);
        actual ??= JSON.stringify(got);
      }
    }

    for (const [name, path] of Object.entries(step.extract)) {
      const got = readPath(parsedBody, path);
      if (got === undefined) problems.push(`Could not extract "${name}" from "${path}"`);
      else vars[name] = typeof got === 'string' ? got : JSON.stringify(got);
    }
  }

  return { problems, expected, actual, startedAt: stepStartedAt, durationMs, entry };
}

// ─── The chain ───────────────────────────────────────────────────────────────

/** `null` where a hop was not executed: the run was cancelled, or an earlier hop failed. */
type ChainResult = Array<HopOutcome | null>;

/**
 * Run the whole chain once with one variable bag.
 *
 * Once a hop fails the chain's variables are unreliable, so the rest is skipped
 * rather than run against half-populated state. That is a statement about ONE
 * chain and does not travel: in a data-driven test the next ROW starts clean and
 * runs regardless, because which cases fail is the entire product of the feature.
 */
async function runChain(
  ctx: RunContext,
  spec: ApiTestSpec,
  vars: Record<string, string>,
  untrusted: ReadonlySet<string>,
  /** Called the moment a hop finishes, so the cockpit's live pane stays live. */
  onHop?: (index: number, outcome: HopOutcome) => void,
): Promise<ChainResult> {
  const outcomes: ChainResult = [];
  let failed = false;

  for (const [index, step] of spec.steps.entries()) {
    if (ctx.signal.aborted || failed) {
      outcomes.push(null);
      continue;
    }
    const outcome = await runHop(ctx, step, vars, untrusted);
    if (outcome.problems.length > 0) failed = true;
    outcomes.push(outcome);
    onHop?.(index, outcome);
  }

  return outcomes;
}

function skippedStep(index: number, title: string): StepResult {
  return {
    index,
    title,
    status: 'SKIPPED',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    screenshotKey: null,
    error: null,
  };
}

/** The variable bag a chain starts from. Secrets first so a spec cannot shadow one by accident. */
function baseVars(ctx: RunContext, spec: ApiTestSpec): Record<string, string> {
  // Secrets are addressable as {{SECRET_NAME}} without ever being written
  // into the test file the customer keeps in their repo.
  return { ...ctx.secrets, ...spec.variables };
}

/** Names whose values do not come from the spec: response bodies, and dataset cells. */
function untrustedNames(spec: ApiTestSpec, columns: readonly string[] = []): Set<string> {
  const names = new Set<string>(columns);
  for (const step of spec.steps) for (const name of Object.keys(step.extract)) names.add(name);
  return names;
}

// ─── The plain (single-case) path ────────────────────────────────────────────

function plainSteps(
  spec: ApiTestSpec,
  outcomes: ChainResult,
): { steps: StepResult[]; network: NetworkEntry[]; failed: boolean } {
  const steps: StepResult[] = [];
  const network: NetworkEntry[] = [];
  let failed = false;

  for (const [index, step] of spec.steps.entries()) {
    const outcome = outcomes[index];
    if (!outcome) {
      steps.push(skippedStep(index, step.name));
      continue;
    }
    network.push(outcome.entry);

    const stepFailed = outcome.problems.length > 0;
    if (stepFailed) failed = true;

    steps.push({
      index,
      title: `${step.method} ${step.path} — ${step.name}`,
      status: stepFailed ? 'FAILED' : 'PASSED',
      startedAt: outcome.startedAt,
      durationMs: outcome.durationMs,
      screenshotKey: null,
      error: stepFailed
        ? {
            message: outcome.problems.join('; '),
            stack: null,
            selector: null,
            expected: outcome.expected,
            actual: outcome.actual,
          }
        : null,
    });
  }

  return { steps, network, failed };
}

// ─── The data-driven path ────────────────────────────────────────────────────

/**
 * Refuse a spec whose placeholders no row can fill, before anything is sent.
 *
 * The most common data-driven mistake by a wide margin is a column called
 * `discount_code` and a URL saying `{{discountCode}}`. Every row then requests
 * the literal `/discounts/%7B%7BdiscountCode%7D%7D`, every row 404s, and thirty
 * red cases accuse the application of a bug it does not have. One sentence
 * naming the placeholder and the columns that exist is worth thirty of those.
 */
function assertPlaceholdersResolvable(
  ctx: RunContext,
  spec: ApiTestSpec,
  columns: readonly string[],
): void {
  const available = new Set([
    ...Object.keys(ctx.secrets),
    ...Object.keys(spec.variables),
    ...columns,
  ]);
  const used = new Set<string>();

  for (const step of spec.steps) {
    // Assertions included: a column that only ever fills an expected value is
    // just as easy to misspell, and gets exactly as far — every row red against
    // the literal text `{{expected}}`, which is how this check earned its keep.
    const here = collectPlaceholders({
      path: step.path,
      headers: step.headers,
      assertions: step.assertions,
      ...(step.body === undefined ? {} : { body: step.body }),
    });
    for (const name of here) used.add(name);

    const missing = unresolvedPlaceholders(here, available);
    if (missing.length > 0) {
      throw new DatasetConfigError(
        `Step "${step.name}" uses ${missing.map((m) => `{{${m}}}`).join(', ')}, which no dataset column, variable, secret or earlier extraction provides — no case was executed. The dataset has ${columns.map((c) => `"${c}"`).join(', ')}.`,
      );
    }
    // Available only to LATER steps, which is what makes a chain a chain.
    for (const name of Object.keys(step.extract)) available.add(name);
  }

  const unused = columns.filter((column) => !used.has(column));
  if (unused.length === columns.length) {
    ctx.logger.warn('dataset columns are never interpolated', { columns: unused });
  }
}

/** Keep failing rows' traffic first when a large dataset overruns the entry cap. */
function boundedNetwork(
  byRow: Array<{ failed: boolean; entries: NetworkEntry[] }>,
): NetworkEntry[] {
  const total = byRow.reduce((n, row) => n + row.entries.length, 0);
  if (total <= MAX_DATASET_NETWORK_ENTRIES) return byRow.flatMap((row) => row.entries);

  const kept: NetworkEntry[] = [];
  for (const pass of [true, false]) {
    for (const row of byRow) {
      if (row.failed !== pass) continue;
      for (const entry of row.entries) {
        if (kept.length >= MAX_DATASET_NETWORK_ENTRIES) return kept;
        kept.push(entry);
      }
    }
  }
  return kept;
}

async function runDataset(
  ctx: RunContext,
  test: ExecutableTest,
  spec: ApiTestSpec,
  rows: readonly DatasetRow[],
  untrusted: ReadonlySet<string>,
): Promise<{ steps: StepResult[]; network: NetworkEntry[]; outcomes: DatasetRowOutcome[] }> {
  const steps: StepResult[] = [];
  const byRow: Array<{ failed: boolean; entries: NetworkEntry[] }> = [];
  const outcomes: DatasetRowOutcome[] = [];

  for (const row of rows) {
    const title = rowStepTitle(row, rows.length);

    if (ctx.signal.aborted) {
      steps.push(skippedStep(row.index, `${title} — cancelled before it ran`));
      outcomes.push({ index: row.index, key: row.key, status: 'SKIPPED' });
      byRow.push({ failed: false, entries: [] });
      continue;
    }

    // A FRESH bag per row. Sharing one would let row 1's extracted order id
    // satisfy row 2's assertions, which turns a dataset into a single test with
    // extra steps and hides exactly the failures it exists to find.
    const chain = await runChain(ctx, spec, { ...baseVars(ctx, spec), ...row.values }, untrusted);

    const entries: NetworkEntry[] = [];
    const problems: string[] = [];
    let expected: string | null = null;
    let actual: string | null = null;
    let durationMs = 0;
    let startedAt: string | null = null;

    for (const [index, outcome] of chain.entries()) {
      if (!outcome) continue;
      entries.push(outcome.entry);
      durationMs += outcome.durationMs;
      startedAt ??= outcome.startedAt;
      if (outcome.problems.length > 0) {
        // Name the hop: a row's step is the whole chain, so "step 2 of the
        // chain broke" has to survive the collapse.
        problems.push(`step "${spec.steps[index]!.name}": ${outcome.problems.join('; ')}`);
        expected ??= outcome.expected;
        actual ??= outcome.actual;
      }
    }

    const failed = problems.length > 0;
    // A chain cut short with nothing wrong was cancelled mid-row, and a row
    // whose assertions never all ran has not passed. Calling it green because
    // no request happened to fail is the suppression this file must not ship.
    const cancelled = !failed && chain.includes(null);
    const status: StepResult['status'] = failed ? 'FAILED' : cancelled ? 'SKIPPED' : 'PASSED';

    byRow.push({ failed, entries });
    outcomes.push({ index: row.index, key: row.key, status });

    ctx.logger.step({ testId: test.id, index: row.index, title, status });

    steps.push({
      index: row.index,
      title: cancelled ? `${title} — cancelled part-way` : title,
      status,
      startedAt: startedAt ?? new Date().toISOString(),
      durationMs,
      screenshotKey: null,
      error: failed
        ? { message: problems.join(' | '), stack: null, selector: null, expected, actual }
        : null,
    });
  }

  return { steps, network: boundedNetwork(byRow), outcomes };
}

/**
 * The last step of a data-driven test: the summary, as a step.
 *
 * A step rather than a log line because a step is what the cockpit renders and
 * what an exported report carries; `28 of 30 cases passed` is the first thing
 * anyone wants and it should not require expanding thirty rows to reconstruct.
 */
function summaryStep(index: number, summary: ReturnType<typeof summariseDataset>): StepResult {
  // Not PASSED while any case went unevaluated: "27 of 30 passed" with three
  // cases never asked is not a green test, and the status is the only part of
  // this a gate reads.
  const status: StepResult['status'] =
    summary.failed > 0 ? 'FAILED' : summary.skipped > 0 ? 'SKIPPED' : 'PASSED';

  const counts = [
    `${summary.passed} of ${summary.total} cases passed`,
    ...(summary.failed > 0 ? [`${summary.failed} failed`] : []),
    ...(summary.skipped > 0 ? [`${summary.skipped} not evaluated`] : []),
  ].join(', ');

  return {
    index,
    title: counts,
    status,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    screenshotKey: null,
    error:
      status === 'FAILED'
        ? {
            // The names, not the indices: "row 17" means nothing to a human.
            message: formatDatasetSummary(summary),
            stack: null,
            selector: null,
            expected: `${summary.total} passing cases`,
            actual: `${summary.passed} passing, ${summary.failed} failing`,
          }
        : null,
  };
}

// ─── The plugin ──────────────────────────────────────────────────────────────

export const apiPlugin: RunnerPlugin = {
  type: 'API',

  validate(test: ExecutableTest): void {
    const parsed = apiTestSpecSchema.safeParse(test.spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`API test "${test.name}" has an invalid spec — ${issues}`);
    }
    // A malformed `dataset` block is deliberately NOT thrown from here. The
    // worker records a validate() throw as FAILED, and every dataset problem is
    // a configuration gap: it is reported as SKIPPED from execute, with the
    // sentence that fixes it. Same treatment `leakCheck` gets, for the same
    // reason — a spec we could not run is not an application that misbehaved.
  },

  async execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const spec = apiTestSpecSchema.parse(test.spec);

    const steps: StepResult[] = [];
    let network: NetworkEntry[] = [];
    let failed = false;
    /** Set when nothing was evaluated, which can never be a pass. */
    let notEvaluated: string | null = null;
    let summaryLine: string | null = null;

    // Read off the RAW spec: `apiTestSpecSchema` strips keys it does not know
    // about, so by this point `spec` no longer has the block. Off unless the
    // spec says otherwise — `parseLeakConfig` returns null for every test that
    // has not opted in.
    const leakConfig = parseLeakConfig(test.spec);
    let watch: LeakWatch | null = null;
    if (leakConfig) {
      try {
        watch = await beginLeakWatch(leakConfig, {
          secrets: ctx.secrets,
          baseUrl: ctx.baseUrl,
          logger: ctx.logger,
        });
      } catch (err) {
        // Documented not to throw; if it ever does, the test still runs.
        ctx.logger.warn('leak check could not start', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let findings: Finding[] = [];
    // The clock starts after the leak snapshot and stops before the leak
    // comparison: our instrumentation must not show up in the customer's
    // duration, which is the number a latency gate reads.
    const startedAt = Date.now();
    let durationMs = 0;

    try {
      // Same raw-spec reasoning as `leakCheck`. Null for every test that has no
      // dataset, which is every test that existed before this feature.
      const dataset = parseDatasetConfig(test.spec);

      if (dataset === null) {
        const outcomes = await runChain(
          ctx,
          spec,
          baseVars(ctx, spec),
          untrustedNames(spec),
          // Streamed as each hop lands, exactly as before the chain was
          // factored out: the cockpit's right pane is a live pane.
          (index, outcome) =>
            ctx.logger.step({
              testId: test.id,
              index,
              title: spec.steps[index]!.name,
              status: outcome.problems.length > 0 ? 'FAILED' : 'PASSED',
            }),
        );
        const plain = plainSteps(spec, outcomes);
        steps.push(...plain.steps);
        network = plain.network;
        failed = plain.failed;
      } else {
        const rows = loadDataset(dataset, ctx.fixtures);
        const columns = Object.keys(rows[0]!.values);
        assertPlaceholdersResolvable(ctx, spec, columns);

        ctx.logger.info('running a data-driven test', {
          testId: test.id,
          cases: rows.length,
          columns,
        });

        const run = await runDataset(ctx, test, spec, rows, untrustedNames(spec, columns));
        const summary = summariseDataset(run.outcomes);
        summaryLine = formatDatasetSummary(summary);

        const tail = summaryStep(rows.length, summary);
        ctx.logger.step({
          testId: test.id,
          index: tail.index,
          title: tail.title,
          status: tail.status,
        });
        ctx.logger.info('data-driven test finished', { testId: test.id, ...summary });

        steps.push(...run.steps, tail);
        network = run.network;
        failed = summary.failed > 0;
        // Every row cancelled means every row unanswered. Green here would be
        // the most expensive kind of lie, so it fails open instead.
        if (summary.passed + summary.failed === 0) notEvaluated = summaryLine;
      }
    } catch (err) {
      if (!(err instanceof DatasetConfigError)) throw err;
      // The dataset could not be turned into cases: a malformed CSV with its
      // line number, a missing fixture, a range that would generate 100,000
      // rows. Nothing was sent, so nothing failed — this is SKIPPED with the
      // sentence that fixes it, never a red mark on the application.
      notEvaluated = err.detail;
      ctx.logger.warn('dataset could not be loaded, so no case ran', {
        testId: test.id,
        error: err.detail,
      });
    } finally {
      durationMs = Date.now() - startedAt;

      // In a finally so an aborted or throwing chain is still checked — the
      // requests it did make can leave residue whether or not it finished. A
      // reporting problem must never lose a run, so a detector that explodes
      // costs its findings and nothing else.
      if (watch) {
        try {
          findings = await watch.finish();
        } catch (err) {
          ctx.logger.warn('leak check could not be completed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // Logged here rather than after the block, so the findings of a chain
        // that threw are on the record even though the execution they would
        // have been attached to never gets returned.
        if (findings.length > 0) {
          ctx.logger.warn('leak check reported findings', {
            testId: test.id,
            findings: findings.length,
            codes: [...new Set(findings.map((f) => f.code))],
          });
        }
      }
    }

    const status: TestExecution['status'] =
      notEvaluated !== null ? 'SKIPPED' : failed ? 'FAILED' : 'PASSED';

    return {
      testId: test.id,
      status,
      durationMs,
      steps,
      // Masked here rather than at write time: URLs and bodies routinely carry
      // tokens that were interpolated in from the vault.
      network: maskDeep(network, Object.values(ctx.secrets)),
      console: [],
      videoKey: null,
      traceKey: null,
      errorMessage:
        notEvaluated !== null
          ? notEvaluated
          : failed
            ? // The summary first: which cases failed is the headline, and the
              // first failing case's message is the detail under it.
              [summaryLine, steps.find((s) => s.error)?.error?.message]
                .filter(Boolean)
                .join(' ')
                .trim() || 'API test failed'
            : null,
      retriedAndPassed: false,
      // A leak is a real problem and a different kind of problem from a failing
      // assertion, so it rides along as a finding and leaves `status` alone. A
      // passing test that leaks stays passing.
      findings,
    };
  },
};
