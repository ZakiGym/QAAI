import type { Page } from '@playwright/test';
import { test, expect, firstProject, projectTests, recentRuns, runWithAFailure } from '../fixtures/qaai';

/**
 * Every screen loads, renders something real, and logs nothing at error level.
 *
 * The cheapest test in the suite and, on a codebase whose characteristic defect
 * is code that was never wired to anything, probably the most valuable: a
 * screen that throws during render, calls an unmounted route, or reads a field
 * the API stopped sending shows up here and nowhere else.
 *
 * Each case asserts a piece of the screen a person would look for — not just a
 * 200. A Next.js error page is still a 200, and an empty <main> is still a
 * successful navigation.
 */

interface Screen {
  path: string;
  /** What the user should be able to see once this screen has rendered. */
  ready: (page: Page) => ReturnType<Page['locator']>;
}

/**
 * The active tab in a section's strip.
 *
 * Every one of these screens used to have an h1 of its own, and this list
 * asserted on it. The redesign grouped sixteen routes into six sections, so the
 * h1 is now the SECTION — /traffic, /repro and /import all say "Tests" — and a
 * heading no longer identifies a screen.
 *
 * The active tab does, and it is a better assertion than the heading ever was:
 * it proves the route rendered, that the shell put it in the right section, AND
 * that the right tab is marked current. A screen that loads under the wrong tab
 * is a real bug this now catches and the old heading check could not.
 */
const activeTab = (page: Page, section: string, tab: string) =>
  page.locator(`nav[aria-label="${section} views"] a[aria-current="page"]`, { hasText: tab });

const SHELL_SCREENS: Screen[] = [
  // Runs has no tab strip — one screen, and the h1 identifies it outright.
  { path: '/runs', ready: (p) => p.getByRole('heading', { name: 'Runs', level: 1 }) },
  // /dashboard was merged into Runs home and redirects; landing on that h1 is
  // exactly what proves the redirect still works.
  { path: '/dashboard', ready: (p) => p.getByRole('heading', { name: 'Runs', level: 1 }) },

  { path: '/triage', ready: (p) => activeTab(p, 'Triage', 'Verdicts') },
  { path: '/heals', ready: (p) => activeTab(p, 'Triage', 'Heals') },
  { path: '/quality', ready: (p) => activeTab(p, 'Triage', 'Quality') },

  { path: '/editor', ready: (p) => activeTab(p, 'Tests', 'Editor') },
  { path: '/flow-map', ready: (p) => activeTab(p, 'Tests', 'Flow map') },
  { path: '/import', ready: (p) => activeTab(p, 'Tests', 'Import') },
  { path: '/repro', ready: (p) => activeTab(p, 'Tests', 'From a bug') },
  { path: '/traffic', ready: (p) => activeTab(p, 'Tests', 'From traffic') },

  { path: '/insights', ready: (p) => activeTab(p, 'Insights', 'Coverage') },
  { path: '/insights/coverage', ready: (p) => activeTab(p, 'Insights', 'Coverage') },
  { path: '/insights/health', ready: (p) => activeTab(p, 'Insights', 'Suite health') },
  { path: '/insights/impact', ready: (p) => activeTab(p, 'Insights', 'Impact') },

  { path: '/environments', ready: (p) => activeTab(p, 'Setup', 'Environments') },
  { path: '/source-control', ready: (p) => activeTab(p, 'Setup', 'Source control') },
  { path: '/settings/runners', ready: (p) => activeTab(p, 'Setup', 'Runners') },
  { path: '/onboarding', ready: (p) => activeTab(p, 'Setup', 'Add app') },

  { path: '/settings', ready: (p) => activeTab(p, 'Settings', 'Organization') },
  { path: '/settings/billing', ready: (p) => activeTab(p, 'Settings', 'Billing') },

  /*
   * The GitHub App screen is reached FROM the Runners tab rather than being a
   * tab itself, so it keeps a heading of its own and is asserted on that.
   */
  { path: '/settings/github', ready: (p) => p.getByRole('heading', { name: 'GitHub App', level: 1 }) },
];

/*
 * Marketing and auth stand outside the app shell (nav.ts SHELL_EXCLUDED), so
 * they are listed separately — a sidebar rendered on the landing page would be
 * a bug, and the assertion below would not catch it if they were mixed in.
 */
const STANDALONE_SCREENS: Screen[] = [
  { path: '/', ready: (p) => p.getByRole('heading', { name: /Your AI QA engineer/, level: 1 }) },
  { path: '/login', ready: (p) => p.getByRole('heading', { name: 'Sign in to QAAI' }) },
  { path: '/signup', ready: (p) => p.getByRole('heading', { name: 'Create your QAAI account' }) },
];

/** The failure report every one of these tests produces, in one readable block. */
function report(problems: Array<{ kind: string; text: string; url: string }>): string[] {
  return problems.map((p) => `[${p.kind}] ${p.text}  (at ${p.url})`);
}

test.describe('every screen loads clean', () => {
  for (const screen of [...SHELL_SCREENS, ...STANDALONE_SCREENS]) {
    test(`${screen.path} renders and logs no error`, async ({ page, consoleErrors }) => {
      await page.goto(screen.path);
      await expect(screen.ready(page).first()).toBeVisible();
      expect(report(consoleErrors)).toEqual([]);
    });
  }

  test('the app shell is on the app screens and off the marketing ones', async ({ page }) => {
    /*
     * Identified by the sidebar's collapse control, not by the `navigation`
     * landmark: the landing page has a marketing <nav> of its own, and neither
     * it nor the sidebar's <nav> carries an accessible name, so the landmark
     * alone cannot tell the two apart. (That is a finding about the app, not a
     * concession by the test — a screen reader cannot tell them apart either.)
     */
    const sidebar = (p: typeof page) => p.getByRole('button', { name: /(Collapse|Expand) sidebar/ });

    await page.goto('/runs');
    await expect(sidebar(page)).toBeVisible();

    await page.goto('/');
    await expect(sidebar(page)).toHaveCount(0);
  });
});

/*
 * The screens whose URLs contain an id. Resolved from the live API rather than
 * hard-coded, because every environment has different cuids and a suite that
 * only runs on one machine is not a suite.
 */
test.describe('every id-addressed screen loads clean', () => {
  test('the cockpit for a real run renders and logs no error', async ({ page, api, consoleErrors }) => {
    const [run] = await recentRuns(api, 1);
    test.skip(!run, 'No runs in this org yet — start one from /runs, or seed the demo data.');

    await page.goto(`/runs/${run!.id}`);
    await expect(page.getByRole('link', { name: /Runs/ }).first()).toBeVisible();
    expect(report(consoleErrors)).toEqual([]);
  });

  test('the run comparison renders and logs no error', async ({ page, api, consoleErrors }) => {
    const [run] = await recentRuns(api, 1);
    test.skip(!run, 'No runs in this org yet — start one from /runs, or seed the demo data.');

    await page.goto(`/runs/${run!.id}/compare`);
    await expect(page.getByRole('heading', { name: 'Compare', level: 1 })).toBeVisible();
    expect(report(consoleErrors)).toEqual([]);
  });

  test('the trace viewer renders and logs no error', async ({ page, api, consoleErrors }) => {
    const failing = await runWithAFailure(api);
    test.skip(
      !failing,
      'No run in this org has a failed test, so there is no trace to view. Start a run against the demo app first.',
    );

    await page.goto(`/runs/${failing!.runId}/trace`);
    await expect(page.getByRole('link', { name: /Run/ }).first()).toBeVisible();
    expect(report(consoleErrors)).toEqual([]);
  });

  test('a test history page renders and logs no error', async ({ page, api, consoleErrors }) => {
    const project = await firstProject(api);
    const tests = await projectTests(api, project.id);
    test.skip(tests.length === 0, 'This project has no tests. Seed the demo data first.');

    await page.goto(`/tests/${tests[0]!.id}`);
    await expect(page.getByRole('heading', { name: tests[0]!.name, level: 1 })).toBeVisible();
    expect(report(consoleErrors)).toEqual([]);
  });

  test('the plan approval screen renders and logs no error', async ({ page, api, consoleErrors }) => {
    const project = await firstProject(api);

    await page.goto(`/projects/${project.id}/plan`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    expect(report(consoleErrors)).toEqual([]);
  });

  test('a bisect id that does not exist says so instead of breaking', async ({ page, consoleErrors }) => {
    // Deliberately unknown. A bisect only exists for 45 minutes after it is
    // requested, so "the report you bookmarked is gone" is the state this
    // screen is in most of the time, and it has to be a sentence and not a crash.
    await page.goto('/bisect/e2e-no-such-investigation');
    await expect(page.getByRole('heading', { name: 'No investigation with this id' })).toBeVisible();

    /*
     * The 404 IS this screen's subject, and Chrome logs every 404 at error
     * level whether or not the application handled it gracefully. Only that one
     * shape is tolerated here; a 500, a thrown exception or a second failing
     * request would still fail the test.
     */
    const unexpected = consoleErrors.filter((problem) => !/404 \(Not Found\)/.test(problem.text));
    expect(report(unexpected)).toEqual([]);
  });

  test('the editor renders its file tree and logs no error', async ({ page, consoleErrors }) => {
    await page.goto('/editor');
    // The editor has no <h1>; the file tree's "New test" control is the thing
    // that proves the screen came up rather than the "no app connected" state.
    await expect(page.getByRole('button', { name: 'New test' })).toBeVisible();
    expect(report(consoleErrors)).toEqual([]);
  });
});
