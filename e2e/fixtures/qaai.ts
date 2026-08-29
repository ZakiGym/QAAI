import { test as base, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { API_URL } from '../playwright.config';

export { expect, API_URL };

/**
 * Shared fixtures for the dogfood suite.
 *
 * Two things every spec here wants and Playwright does not give for free:
 *
 *  • `consoleErrors` — a live array of everything the page logged at error
 *    level plus every uncaught exception. A screen that renders but throws is
 *    a broken screen, and it is invisible to an assertion on the DOM alone.
 *
 *  • `api` — the same API the cockpit talks to, already carrying the session
 *    cookie, used ONLY to find fixtures (which run has a failure? which test
 *    can I open?). Assertions stay on the UI; the API is how the suite avoids
 *    hard-coding cuids that differ on every machine.
 */

/**
 * Console noise that is not the application's fault, and would otherwise make
 * the "no console errors" test useless.
 *
 * Kept deliberately tiny and specific. Every entry here is a claim that the
 * message cannot indicate a real defect — anything broader would be a filter
 * that hides exactly what this suite exists to catch, and the house rule is
 * that nothing suppresses a signal quietly.
 */
const IGNORED_CONSOLE = [
  // Next's dev server streams HMR over a websocket that closes on navigation.
  /websocket connection to 'ws:\/\/localhost:\d+\/_next\/webpack-hmr'/i,
  // React DevTools nag, logged at error level by React in development.
  /download the react devtools/i,
  // /favicon.ico is not served in dev; the browser logs the 404 itself.
  /favicon\.ico/i,
];

export interface ConsoleProblem {
  kind: 'console.error' | 'pageerror';
  text: string;
  url: string;
}

interface QaaiFixtures {
  consoleErrors: ConsoleProblem[];
  api: APIRequestContext;
}

export const test = base.extend<QaaiFixtures>({
  consoleErrors: async ({ page }, use) => {
    const problems: ConsoleProblem[] = [];

    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return;
      problems.push({ kind: 'console.error', text, url: page.url() });
    });

    page.on('pageerror', (error) => {
      problems.push({ kind: 'pageerror', text: `${error.name}: ${error.message}`, url: page.url() });
    });

    await use(problems);
  },

  api: async ({ request }, use) => {
    await use(request);
  },
});

// ─── Reading fixtures out of the live app ────────────────────────────────────

export interface ProjectLite {
  id: string;
  name: string;
  environments: Array<{ id: string; name: string }>;
  _count: { tests: number; runs: number };
}

export interface RunLite {
  id: string;
  status: string;
  failedCount: number;
  environment: { name: string };
}

export interface TestLite {
  id: string;
  name: string;
  filePath: string;
  type: string;
}

async function getJson<T>(api: APIRequestContext, path: string): Promise<T> {
  const response = await api.get(`${API_URL}${path}`);
  expect(
    response.ok(),
    `GET ${path} answered ${response.status()} — the suite reads fixtures from the live API, so this ` +
      `is either an unmounted route or an expired session.`,
  ).toBeTruthy();
  return (await response.json()) as T;
}

export async function firstProject(api: APIRequestContext): Promise<ProjectLite> {
  const { projects } = await getJson<{ projects: ProjectLite[] }>(api, '/projects');
  expect(
    projects.length,
    'No projects in this org. Seed the demo data with `npm run db:seed` before running the dogfood suite.',
  ).toBeGreaterThan(0);
  return projects[0]!;
}

export async function recentRuns(api: APIRequestContext, limit = 50): Promise<RunLite[]> {
  const { runs } = await getJson<{ runs: RunLite[] }>(api, `/runs?limit=${limit}`);
  return runs;
}

/** A finished run that actually contains a failed test — what the cockpit is for. */
export async function runWithAFailure(api: APIRequestContext): Promise<{
  runId: string;
  failingTestName: string;
} | null> {
  for (const run of await recentRuns(api)) {
    if (run.failedCount === 0) continue;
    const { run: full } = await getJson<{
      run: { results?: Array<{ status: string; test: { name: string } }> };
    }>(api, `/runs/${run.id}`);
    const failing = (full.results ?? []).find((result) => result.status === 'FAILED');
    if (failing) return { runId: run.id, failingTestName: failing.test.name };
  }
  return null;
}

export interface FailingStepFixture {
  runId: string;
  testName: string;
  /** The cockpit auto-selects this step, and its index is on the button. */
  stepIndex: number;
  stepTitle: string;
  stepError: string;
  findingCount: number;
}

/**
 * A run containing a test that failed ON A STEP.
 *
 * Distinct from `runWithAFailure`: a result can fail with no steps at all (the
 * runner blew up before the first one), and that renders a bare error block
 * rather than the step scrubber. The cockpit's whole reason to exist is the
 * scrubber, so the test that covers it needs a failure that actually has one.
 */
export async function runWithAFailingStep(
  api: APIRequestContext,
): Promise<FailingStepFixture | null> {
  interface FullResult {
    status: string;
    test: { name: string };
    findings: unknown[];
    steps: Array<{ index: number; status: string; title: string; errorMessage: string | null }>;
  }

  for (const run of await recentRuns(api)) {
    if (run.failedCount === 0) continue;
    const { run: full } = await getJson<{ run: { results?: FullResult[] } }>(api, `/runs/${run.id}`);
    for (const result of full.results ?? []) {
      if (result.status !== 'FAILED') continue;
      // The FIRST failed step, because that is the one the cockpit selects for
      // you. Picking a different one here would test a state the app never
      // actually puts a person in.
      const step = result.steps.find((s) => s.status === 'FAILED');
      if (!step?.errorMessage) continue;
      return {
        runId: run.id,
        testName: result.test.name,
        stepIndex: step.index,
        stepTitle: step.title,
        stepError: step.errorMessage,
        findingCount: result.findings.length,
      };
    }
  }
  return null;
}

export async function projectTests(api: APIRequestContext, projectId: string): Promise<TestLite[]> {
  const { tests } = await getJson<{ tests: TestLite[] }>(api, `/projects/${projectId}/tests`);
  return tests;
}

// ─── Interacting with the cockpit ────────────────────────────────────────────

/**
 * Press the app's modifier plus `key`.
 *
 * AppShell decides between ⌘ and Ctrl by reading `navigator.userAgent`, so this
 * asks the page the same question rather than asking Node. That distinction is
 * not academic: Playwright's "Desktop Chrome" descriptor emulates a WINDOWS
 * user agent even on a Mac, so a suite that chose ⌘ from `process.platform`
 * pressed a key the app was not listening for and every palette test failed
 * with the palette working perfectly.
 */
export async function shortcut(page: Page, key: string): Promise<void> {
  const isMac = await page.evaluate(() => /mac/i.test(navigator.userAgent));
  await page.keyboard.press(`${isMac ? 'Meta' : 'Control'}+${key}`);
}

/**
 * Wait for the shell to be interactive before pressing a shortcut at it.
 *
 * AppShell installs its keydown listener in an effect, so a key pressed between
 * first paint and hydration goes nowhere. The collapse control is rendered by
 * that same client component, so waiting for it is the honest signal that the
 * listener is attached — and it replaces the `waitForTimeout` this would
 * otherwise need. The `navigation` landmark would not do: the marketing page
 * has one too, and neither carries an accessible name.
 */
export async function shellReady(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /(Collapse|Expand) sidebar/ })).toBeVisible();

  /*
   * And the project selection has to have resolved, not just the frame.
   *
   * ⌘P asks the SELECTED project for its files, and AppShell's loadFiles()
   * returns early when there is no project yet. It does not retry, and it does
   * not say anything — the palette renders "No matches", which is the same
   * thing it renders for a project that genuinely has no files. Pressing ⌘P
   * within about a second of a page load reproduces it every time. (Reported,
   * not worked around: AppShell is not this suite's file to change.)
   *
   * The top bar is the only thing on screen that says whether the selection has
   * landed, so that is what this waits on.
   */
  await expect(page.getByRole('button', { name: 'No project' })).toHaveCount(0);
}

/**
 * The open-file tab for `filePath`.
 *
 * Addressed by TITLE, not by the close button's name. The strip labels a tab
 * with its BASENAME, the way every editor does — so `Close checkout/a.spec.ts`
 * stopped existing when the panel was rebuilt, and a basename alone is not
 * unique across folders. The tab's `title` is the full path, which is the only
 * thing here that identifies one file and one file only.
 */
export function openTab(page: Page, filePath: string): Locator {
  return page.locator(`[role="tab"][title^="${filePath}"]`);
}

/**
 * The explorer row for `filePath`.
 *
 * By title, which on a file row IS the path. The old tree put the test's NAME
 * there; the rebuilt one puts the path, because a name is neither unique nor
 * stable and the row is a file. Anchored to `[role="treeitem"]` so this cannot
 * accidentally match the tab strip, which also carries paths in titles.
 */
export function treeRow(page: Page, filePath: string): Locator {
  return page.locator(`[role="treeitem"] [title="${filePath}"]`).first();
}

/**
 * The project the UI actually has selected, not the one the API lists first.
 *
 * `firstProject` returns `projects[0]`, and GET /projects is newest-first — so
 * any spec that creates a project changes what it means, mid-suite, for every
 * other spec. The sidebar meanwhile keeps its own choice in localStorage, which
 * the stored auth state carries between runs. The two drift apart, and a test
 * comparing UI content against `firstProject` data then fails for a reason that
 * has nothing to do with what it was testing. This suite has chased that flake
 * three times.
 *
 * Anything asserting on what a SCREEN shows for the current project should ask
 * here. `firstProject` is still right for API-only work.
 */
export async function selectedProject(
  page: Page,
  api: APIRequestContext,
): Promise<ProjectLite> {
  const label = await page
    .getByRole('button', { name: /^Project: / })
    .getAttribute('aria-label');
  const name = (label ?? '').replace(/^Project:\s*/, '').trim();

  const { projects } = await getJson<{ projects: ProjectLite[] }>(api, '/projects');
  const chosen = projects.find((p) => p.name === name);
  expect(
    chosen,
    `The sidebar shows "${name}" and GET /projects does not list it. The UI and the API ` +
      'disagree about which projects exist, which is a real defect and not a flake.',
  ).toBeDefined();
  return chosen!;
}
