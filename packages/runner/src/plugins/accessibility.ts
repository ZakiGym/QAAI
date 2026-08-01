/**
 * Accessibility plugin (§4) — axe-core WCAG 2.1 AA scan.
 *
 * Violations are Findings, not pass/fail noise: a page with three moderate
 * issues is information, and whether it blocks a merge is a quality-gate
 * decision (§4), not the runner's call. The test only *fails* when a critical
 * violation is present, which is the one severity nobody argues about.
 */

import { AxeBuilder } from '@axe-core/playwright';
import { acquireBrowser } from '../browser-pool.js';
import type {
  ExecutableTest,
  Finding,
  RunContext,
  RunnerPlugin,
  StepResult,
  TestExecution,
} from '@qaai/shared';

/** `spec` shape for an accessibility test: the routes to scan. */
interface A11ySpec {
  routes: string[];
  /** axe tags; WCAG 2.1 AA is the spec's stated bar. */
  tags?: string[];
}

const DEFAULT_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

function parseSpec(test: ExecutableTest): A11ySpec {
  const spec = (test.spec ?? {}) as Partial<A11ySpec>;
  const routes = Array.isArray(spec.routes) ? spec.routes.filter((r) => typeof r === 'string') : [];
  if (routes.length === 0) {
    throw new Error(`Accessibility test "${test.name}" lists no routes to scan`);
  }
  return { routes, tags: spec.tags ?? DEFAULT_TAGS };
}

const SEVERITY: Record<string, Finding['severity']> = {
  critical: 'CRITICAL',
  serious: 'SERIOUS',
  moderate: 'MODERATE',
  minor: 'MINOR',
};

export const accessibilityPlugin: RunnerPlugin = {
  type: 'ACCESSIBILITY',

  validate(test: ExecutableTest): void {
    parseSpec(test);
  },

  async execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const { routes, tags } = parseSpec(test);
    const startedAt = Date.now();

    // Borrowed, not launched: the browser process is shared with every other
    // test in this worker. The CONTEXT below is still this test's alone, which
    // is what keeps one scan from seeing another's cookies or storage.
    const lease = await acquireBrowser();
    const context = await lease.browser.newContext(
      ctx.storageState ? { storageState: ctx.storageState as never } : {},
    );
    const page = await context.newPage();

    const steps: StepResult[] = [];
    const findings: Finding[] = [];

    try {
      for (const [index, route] of routes.entries()) {
        const stepStarted = Date.now();
        const stepStartedAt = new Date().toISOString();
        const url = new URL(route, ctx.baseUrl).toString();
        let error: StepResult['error'] = null;

        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          if (ctx.determinism.waitForNetworkIdle) {
            await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
          }

          const results = await new AxeBuilder({ page }).withTags(tags!).analyze();

          for (const violation of results.violations) {
            for (const node of violation.nodes) {
              findings.push({
                kind: 'ACCESSIBILITY',
                severity: SEVERITY[violation.impact ?? 'minor'] ?? 'MINOR',
                code: violation.id,
                message: `${violation.help} (on ${route})`,
                location: node.target.join(' '),
                helpUrl: violation.helpUrl,
              });
            }
          }
        } catch (err) {
          error = {
            message: err instanceof Error ? err.message : String(err),
            stack: null,
            selector: null,
            expected: null,
            actual: null,
          };
        }

        const status = error ? ('FAILED' as const) : ('PASSED' as const);
        ctx.logger.step({ testId: test.id, index, title: `Scan ${route}`, status });

        steps.push({
          index,
          title: `Scan ${route}`,
          status,
          startedAt: stepStartedAt,
          durationMs: Date.now() - stepStarted,
          screenshotKey: null,
          error,
        });
      }
    } finally {
      await context.close().catch(() => {});
      await lease.release();
    }

    const criticals = findings.filter((f) => f.severity === 'CRITICAL');
    const navigationFailed = steps.some((s) => s.status === 'FAILED');
    const failed = navigationFailed || criticals.length > 0;

    return {
      testId: test.id,
      status: failed ? 'FAILED' : 'PASSED',
      durationMs: Date.now() - startedAt,
      steps,
      network: [],
      console: [],
      videoKey: null,
      traceKey: null,
      errorMessage: criticals.length
        ? `${criticals.length} critical accessibility violation(s): ${[
            ...new Set(criticals.map((f) => f.code)),
          ].join(', ')}`
        : navigationFailed
          ? 'One or more routes could not be scanned'
          : null,
      retriedAndPassed: false,
      findings,
    };
  },
};
