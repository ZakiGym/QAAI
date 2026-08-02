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
  ready: (page: Page) => ReturnType<Page['getByRole']>;
}

const SHELL_SCREENS: Screen[] = [
  { path: '/runs', ready: (p) => p.getByRole('heading', { name: 'Projects', level: 1 }) },
  { path: '/dashboard', ready: (p) => p.getByRole('heading', { name: 'Dashboard', level: 1 }) },
  { path: '/flow-map', ready: (p) => p.getByRole('heading', { level: 1 }) },
  { path: '/triage', ready: (p) => p.getByRole('heading', { name: 'Triage', level: 1 }) },
  { path: '/quality', ready: (p) => p.getByRole('heading', { name: 'Quality', level: 1 }) },
  { path: '/insights', ready: (p) => p.getByRole('heading', { name: 'Insights', level: 1 }) },
  { path: '/insights/coverage', ready: (p) => p.getByRole('heading', { name: 'Coverage gaps', level: 1 }) },
  { path: '/insights/health', ready: (p) => p.getByRole('heading', { name: 'Suite health', level: 1 }) },
  { path: '/insights/impact', ready: (p) => p.getByRole('heading', { name: 'Impact analysis', level: 1 }) },
  { path: '/heals', ready: (p) => p.getByRole('heading', { name: 'Self-healing', level: 1 }) },
  { path: '/environments', ready: (p) => p.getByRole('heading', { name: 'Environments', level: 1 }) },
  { path: '/source-control', ready: (p) => p.getByRole('heading', { name: 'Source control', level: 1 }) },
  { path: '/traffic', ready: (p) => p.getByRole('heading', { name: 'Traffic', level: 1 }) },
  { path: '/repro', ready: (p) => p.getByRole('heading', { name: 'Reproduce a bug', level: 1 }) },
  { path: '/import', ready: (p) => p.getByRole('heading', { name: 'Import an existing suite', level: 1 }) },
  { path: '/onboarding', ready: (p) => p.getByRole('heading', { name: 'Add your app', level: 1 }) },
  { path: '/settings', ready: (p) => p.getByRole('heading', { name: 'Settings', level: 1 }) },
  { path: '/settings/runners', ready: (p) => p.getByRole('heading', { name: 'Infrastructure', level: 1 }) },
  { path: '/settings/github', ready: (p) => p.getByRole('heading', { name: 'Infrastructure', level: 1 }) },
  { path: '/settings/billing', ready: (p) => p.getByRole('heading', { name: 'Billing', level: 1 }) },
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
