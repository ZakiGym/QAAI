/**
 * Native HTTP runner (§4 API tests).
 *
 * No browser. Chained requests with variable extraction, and assertions on
 * status, latency, and body shape. Each request in the chain becomes a cockpit
 * step so a failing chain shows exactly which hop broke.
 */

import { apiTestSpecSchema, maskDeep } from '@qaai/shared';
import type {
  ExecutableTest,
  NetworkEntry,
  RunContext,
  RunnerPlugin,
  StepResult,
  TestExecution,
} from '@qaai/shared';

/** Response bodies are truncated before they are stored or shown to the model. */
const BODY_SNIPPET_LIMIT = 2000;

/** Substitutes {{var}} from the running variable bag. Unknown names are left alone. */
function interpolate(input: string, vars: Record<string, string>): string {
  return input.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => vars[name] ?? whole);
}

/** Dotted-path read with array-index support: `data.items.0.id`. */
function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node)) return node[Number(key)];
    if (typeof node === 'object') return (node as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

function resolveUrl(baseUrl: string, path: string): string {
  return /^https?:\/\//i.test(path) ? path : new URL(path, baseUrl).toString();
}

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
  },

  async execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const spec = apiTestSpecSchema.parse(test.spec);
    const startedAt = Date.now();

    // Secrets are addressable as {{SECRET_NAME}} without ever being written
    // into the test file the customer keeps in their repo.
    const vars: Record<string, string> = { ...ctx.secrets, ...spec.variables };

    const steps: StepResult[] = [];
    const network: NetworkEntry[] = [];
    let failed = false;

    for (const [index, step] of spec.steps.entries()) {
      if (ctx.signal.aborted) {
        steps.push({
          index,
          title: step.name,
          status: 'SKIPPED',
          startedAt: new Date().toISOString(),
          durationMs: 0,
          screenshotKey: null,
          error: null,
        });
        continue;
      }

      // Once a hop fails the chain's variables are unreliable, so the rest is
      // skipped rather than run against half-populated state.
      if (failed) {
        steps.push({
          index,
          title: step.name,
          status: 'SKIPPED',
          startedAt: new Date().toISOString(),
          durationMs: 0,
          screenshotKey: null,
          error: null,
        });
        continue;
      }

      const stepStarted = Date.now();
      const stepStartedAt = new Date().toISOString();
      const url = resolveUrl(ctx.baseUrl, interpolate(step.path, vars));
      const headers = Object.fromEntries(
        Object.entries(step.headers).map(([k, v]) => [k, interpolate(v, vars)]),
      );

      let body: string | undefined;
      if (step.body !== undefined) {
        body = interpolate(JSON.stringify(step.body), vars);
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

      network.push({
        method: step.method,
        url,
        status: responseStatus,
        durationMs,
        responseBodySnippet:
          responseStatus === null || responseStatus >= 400
            ? responseText.slice(0, BODY_SNIPPET_LIMIT)
            : null,
      });

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

        if (a.bodyContains !== undefined && !responseText.includes(a.bodyContains)) {
          problems.push(`Response body does not contain ${JSON.stringify(a.bodyContains)}`);
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

        for (const [path, want] of Object.entries(a.bodyMatches ?? {})) {
          const got = readPath(parsedBody, path);
          if (JSON.stringify(got) !== JSON.stringify(want)) {
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

      const stepFailed = problems.length > 0;
      if (stepFailed) failed = true;

      ctx.logger.step({
        testId: test.id,
        index,
        title: step.name,
        status: stepFailed ? 'FAILED' : 'PASSED',
      });

      steps.push({
        index,
        title: `${step.method} ${step.path} — ${step.name}`,
        status: stepFailed ? 'FAILED' : 'PASSED',
        startedAt: stepStartedAt,
        durationMs,
        screenshotKey: null,
        error: stepFailed
          ? { message: problems.join('; '), stack: null, selector: null, expected, actual }
          : null,
      });
    }

    return {
      testId: test.id,
      status: failed ? 'FAILED' : 'PASSED',
      durationMs: Date.now() - startedAt,
      steps,
      // Masked here rather than at write time: URLs and bodies routinely carry
      // tokens that were interpolated in from the vault.
      network: maskDeep(network, Object.values(ctx.secrets)),
      console: [],
      videoKey: null,
      traceKey: null,
      errorMessage: failed
        ? (steps.find((s) => s.error)?.error?.message ?? 'API test failed')
        : null,
      retriedAndPassed: false,
      findings: [],
    };
  },
};
