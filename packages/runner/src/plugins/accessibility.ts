/**
 * Accessibility plugin (§4) — axe-core WCAG 2.1 AA scan, plus the behavioural
 * checks axe cannot perform.
 *
 * Violations are Findings, not pass/fail noise: a page with three moderate
 * issues is information, and whether it blocks a merge is a quality-gate
 * decision (§4), not the runner's call. The test only *fails* when a critical
 * violation is present, which is the one severity nobody argues about.
 *
 * ── The deep checks (`spec.deep`) ────────────────────────────────────────────
 *
 * axe reads markup, and roughly two thirds of the barriers that stop people
 * using a product are not in the markup — they are in what happens when you
 * press Tab. `../a11y-deep.ts` drives the same page with a real keyboard and
 * reports the ones axe is structurally unable to see: a control that never
 * receives focus, a focus ring nobody can see, a widget that swallows Tab, a
 * dialog that loses focus on open or close, motion that ignores
 * prefers-reduced-motion.
 *
 * Three properties of that addition matter more than the checks themselves:
 *
 *  1. THE AXE PATH IS UNCHANGED. A spec with no `deep` block scans, reports and
 *     steps exactly as it did before, down to the step indices.
 *  2. EVERY CHECK IS OPT-IN BY NAME (`deep: { keyboardTraps: true }`), so a team
 *     adopts them one at a time instead of inheriting a wall of findings.
 *  3. Only ONE deep finding is CRITICAL — a keyboard trap confirmed to be
 *     inescapable — and so only that one can turn a passing test red. Everything
 *     else rides along as a finding, at an honest severity, for the gate to
 *     decide on.
 */

import { AxeBuilder } from '@axe-core/playwright';
import { createMasker } from '@qaai/shared';
import { acquireBrowser } from '../browser-pool.js';
import type {
  ExecutableTest,
  Finding,
  RunContext,
  RunnerPlugin,
  StepResult,
  TestExecution,
} from '@qaai/shared';
import { deepA11yCheckLabel, parseDeepA11yConfig, runDeepA11yChecks } from '../a11y-deep.js';

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

  // A malformed `deep` block deliberately does NOT fail validation: it is
  // reported at run time as an `a11y.inconclusive.config` finding instead. A
  // typo in an opt-in check must not cost the team the axe scan the test was
  // already doing — the same call the leak checker makes for its own block.
  validate(test: ExecutableTest): void {
    parseSpec(test);
  },

  async execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const { routes, tags } = parseSpec(test);
    const deepConfig = parseDeepA11yConfig(test.spec);
    const mask = createMasker(Object.values(ctx.secrets ?? {}));
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
    // A running counter rather than the route index: the deep checks add steps
    // of their own, and a spec without them still gets 0..routes.length-1.
    let stepIndex = 0;

    try {
      for (const route of routes) {
        const stepStarted = Date.now();
        const stepStartedAt = new Date().toISOString();
        const url = new URL(route, ctx.baseUrl).toString();
        let error: StepResult['error'] = null;

        const navigate = async (): Promise<void> => {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          if (ctx.determinism.waitForNetworkIdle) {
            await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
          }
        };

        try {
          await navigate();

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
        ctx.logger.step({ testId: test.id, index: stepIndex, title: `Scan ${route}`, status });

        steps.push({
          index: stepIndex++,
          title: `Scan ${route}`,
          status,
          startedAt: stepStartedAt,
          durationMs: Date.now() - stepStarted,
          screenshotKey: null,
          error,
        });

        // Deep checks run on the page the scan just loaded. Skipped when the
        // route could not be reached at all — there is nothing to tab through,
        // and re-reporting one navigation failure as six is noise.
        if (!deepConfig || error || ctx.signal.aborted) continue;

        const deepStarted = Date.now();
        const deepStartedAt = new Date().toISOString();
        const deep = await runDeepA11yChecks({
          page,
          route,
          config: deepConfig,
          navigate,
          signal: ctx.signal,
          logger: ctx.logger,
          mask,
        });
        findings.push(...deep.findings);

        for (const outcome of deep.outcomes) {
          const title = `${deepA11yCheckLabel(outcome.check)} ${route}`;
          // A check that could not run is SKIPPED, never FAILED: the reason is
          // ours (a budget, a selector, a browser that will not emulate), and
          // reporting it as a failure would blame the application under test.
          const outcomeStatus =
            outcome.status === 'RAN' ? ('PASSED' as const) : ('SKIPPED' as const);
          ctx.logger.step({ testId: test.id, index: stepIndex, title, status: outcomeStatus });
          steps.push({
            index: stepIndex++,
            title: `${title} — ${outcome.detail}`,
            status: outcomeStatus,
            startedAt: deepStartedAt,
            durationMs: Date.now() - deepStarted,
            screenshotKey: null,
            error: null,
          });
        }
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
