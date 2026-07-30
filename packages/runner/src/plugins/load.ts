/**
 * Load testing with k6 (§4 LOAD).
 *
 * QAAI shells out to the real `k6` binary rather than reimplementing a load
 * generator — the same build-vs-buy call as using Playwright's own codegen for
 * record mode. k6 is the industry default, its summary export is stable JSON,
 * and customers can bring scripts they already have.
 *
 * The thresholds are the assertions. A load test that reports throughput without
 * saying what was acceptable always "passes", which is worse than no test — so a
 * spec without thresholds gets defaults, and each threshold becomes a step in
 * the cockpit so a failure points at the number that broke.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTestSpecSchema } from '@qaai/shared';
import type {
  ExecutableTest,
  LoadTestSpec,
  RunContext,
  RunnerPlugin,
  StepResult,
  TestExecution,
} from '@qaai/shared';

/** k6's summary export, narrowed to the metrics we assert on. */
interface K6Summary {
  metrics?: {
    http_req_duration?: { values?: Record<string, number> };
    http_req_failed?: { values?: Record<string, number> };
    http_reqs?: { values?: Record<string, number> };
    iterations?: { values?: Record<string, number> };
    vus_max?: { values?: Record<string, number> };
  };
}

/**
 * Build a k6 script from the declarative scenario.
 *
 * Thresholds are deliberately NOT put in the script's `options`: k6 exits
 * non-zero on a threshold breach, which would be indistinguishable from k6
 * failing to start. We assert them ourselves from the summary so the two cases
 * report differently.
 */
function buildScript(spec: LoadTestSpec, baseUrl: string): string {
  const s = spec.scenario;
  const url = /^https?:\/\//i.test(s.path) ? s.path : new URL(s.path, baseUrl).toString();

  const stages = s.rampUpSeconds
    ? `stages: [
    { duration: '${s.rampUpSeconds}s', target: ${s.vus} },
    { duration: '${s.durationSeconds}s', target: ${s.vus} },
  ],`
    : `vus: ${s.vus},
  duration: '${s.durationSeconds}s',`;

  const body = s.body ? `, ${JSON.stringify(s.body)}` : s.method === 'GET' ? '' : ', null';

  return `import http from 'k6/http';
import { check } from 'k6';

export const options = {
  ${stages}
};

export default function () {
  const res = http.request(${JSON.stringify(s.method)}, ${JSON.stringify(url)}${body}, {
    headers: ${JSON.stringify(s.headers)},
  });
  check(res, { 'status is not 5xx': (r) => r.status < 500 });
}
`;
}

function step(index: number, title: string, ok: boolean, detail: string): StepResult {
  return {
    index,
    title,
    status: ok ? 'PASSED' : 'FAILED',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    screenshotKey: null,
    error: ok ? null : { message: detail, stack: null, selector: null, expected: null, actual: null },
  };
}

export const loadPlugin: RunnerPlugin = {
  type: 'LOAD',

  validate(test: ExecutableTest): void {
    const parsed = loadTestSpecSchema.safeParse(test.spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`Load test "${test.name}" has an invalid spec — ${issues}`);
    }
  },

  async execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const spec = loadTestSpecSchema.parse(test.spec);
    const startedAt = Date.now();
    const dir = await mkdtemp(join(tmpdir(), 'qaai-k6-'));
    const scriptPath = join(dir, 'script.js');
    const summaryPath = join(dir, 'summary.json');

    const base: Omit<TestExecution, 'status' | 'steps' | 'errorMessage'> = {
      testId: test.id,
      durationMs: 0,
      network: [],
      console: [],
      videoKey: null,
      traceKey: null,
      retriedAndPassed: false,
      findings: [],
    };

    try {
      await writeFile(scriptPath, spec.script ?? buildScript(spec, ctx.baseUrl), 'utf8');

      const result = await new Promise<{ code: number | null; stderr: string; spawnError?: string }>(
        (resolve) => {
          const child = spawn(
            'k6',
            ['run', '--summary-export', summaryPath, '--quiet', scriptPath],
            {
              cwd: dir,
              // Secrets reach the script as env vars, never inlined into it.
              env: { ...process.env, ...ctx.secrets, QAAI_BASE_URL: ctx.baseUrl },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );

          let stderr = '';
          child.stderr.on('data', (buf: Buffer) => {
            stderr += buf.toString();
          });
          child.stdout.on('data', () => {});

          const onAbort = () => child.kill('SIGTERM');
          ctx.signal.addEventListener('abort', onAbort, { once: true });

          child.on('error', (err) =>
            resolve({ code: null, stderr, spawnError: (err as NodeJS.ErrnoException).code }),
          );
          child.on('close', (code) => {
            ctx.signal.removeEventListener('abort', onAbort);
            resolve({ code, stderr });
          });
        },
      );

      // k6 missing is an environment gap, not a failing test. Saying so plainly
      // beats reporting the customer's app as broken.
      if (result.spawnError === 'ENOENT') {
        return {
          ...base,
          status: 'SKIPPED',
          durationMs: Date.now() - startedAt,
          steps: [],
          errorMessage:
            'k6 is not installed on this worker. Install it (brew install k6) and re-run — the test itself was not evaluated.',
        };
      }

      let summary: K6Summary | null = null;
      try {
        summary = JSON.parse(await readFile(summaryPath, 'utf8')) as K6Summary;
      } catch {
        summary = null;
      }

      if (!summary) {
        return {
          ...base,
          status: 'FAILED',
          durationMs: Date.now() - startedAt,
          steps: [],
          errorMessage: `k6 produced no summary (exit ${result.code}). ${result.stderr.slice(0, 800)}`,
        };
      }

      const durations = summary.metrics?.http_req_duration?.values ?? {};
      const p95 = durations['p(95)'] ?? durations.p95 ?? 0;
      const errorRate = summary.metrics?.http_req_failed?.values?.rate ?? 0;
      const requests = summary.metrics?.http_reqs?.values?.count ?? 0;

      const steps: StepResult[] = [
        step(
          0,
          `Sent ${Math.round(requests)} requests`,
          requests > 0,
          'k6 sent no requests — check the target URL',
        ),
        step(
          1,
          `p95 response ${Math.round(p95)}ms (threshold ${spec.thresholds.p95Ms}ms)`,
          p95 <= spec.thresholds.p95Ms,
          `p95 was ${Math.round(p95)}ms, over the ${spec.thresholds.p95Ms}ms threshold`,
        ),
        step(
          2,
          `Error rate ${(errorRate * 100).toFixed(2)}% (threshold ${(spec.thresholds.errorRate * 100).toFixed(2)}%)`,
          errorRate <= spec.thresholds.errorRate,
          `${(errorRate * 100).toFixed(2)}% of requests failed, over the ${(spec.thresholds.errorRate * 100).toFixed(2)}% threshold`,
        ),
      ];

      const failed = steps.filter((s) => s.status === 'FAILED');

      return {
        ...base,
        status: failed.length === 0 ? 'PASSED' : 'FAILED',
        durationMs: Date.now() - startedAt,
        steps,
        errorMessage: failed[0]?.error?.message ?? null,
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
};
