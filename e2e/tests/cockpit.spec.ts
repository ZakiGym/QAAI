import { test, expect, recentRuns, runWithAFailingStep } from '../fixtures/qaai';

/**
 * The cockpit — where a failure is read.
 *
 * The claim this product makes is "it tells you WHY", and the cockpit is where
 * that claim is cashed: the failing test, the step it died on, the message, and
 * the findings underneath. If any of those stop rendering, the product still
 * runs tests and stops being worth anything.
 */

const NO_FAILURE =
  'No recent run has a test that failed on a step. Start a run against the demo app from /runs ' +
  'and let it finish, then run this spec again.';

test.describe('reading a real failure', () => {
  test('the failing test is listed, and selecting it shows the step that broke', async ({
    page,
    api,
  }) => {
    const failure = await runWithAFailingStep(api);
    test.skip(!failure, NO_FAILURE);
    const { runId, testName, stepIndex, stepTitle, stepError } = failure!;

    await page.goto(`/runs/${runId}`);

    // The suite list on the left. Every result is a button carrying the test's
    // name, which is what a person scans for.
    const inSuiteList = page.getByRole('button', { name: new RegExp(escapeRe(testName)) });
    await expect(inSuiteList.first()).toBeVisible();
    await inSuiteList.first().click();

    // The middle column heads with the selected test...
    await expect(page.getByRole('heading', { name: testName })).toBeVisible();
    /*
     * ...and the step timeline names the step that failed. The redesign dropped
     * the numeric index from the step rows — the accessible name is now
     * `title duration` — so the anchor against prefix-ambiguous titles
     * ("Headers and cookies: /" vs ".../products") is the whitespace that must
     * follow the full title before the duration starts.
     */
    void stepIndex;
    await expect(
      page.getByRole('button', {
        name: new RegExp(`^${escapeRe(stepTitle)}\\s`),
      }),
    ).toBeVisible();

    // Selecting the test auto-selects its first failing step, so the reason is
    // on screen without a second click. That behaviour is the point of the
    // screen and it is what this asserts.
    await expect(page.getByText(stepError, { exact: false }).first()).toBeVisible();
  });

  test('the findings behind a failure are listed with their severity', async ({ page, api }) => {
    const failure = await runWithAFailingStep(api);
    test.skip(!failure, NO_FAILURE);
    test.skip(
      failure!.findingCount === 0,
      'That failure carried no findings — nothing for the findings list to render.',
    );

    await page.goto(`/runs/${failure!.runId}`);
    await page.getByRole('button', { name: new RegExp(escapeRe(failure!.testName)) }).first().click();

    // The redesign dropped the parentheses: the heading is `Findings 12`, with
    // the count in tabular figures. Same claim — the count is ON the heading.
    await expect(
      page.getByRole('heading', { name: `Findings ${failure!.findingCount}` }),
    ).toBeVisible();
  });

  test('the header states the counts and the gate decision', async ({ page, api }) => {
    /*
     * The newest FINISHED run, not simply the newest.
     *
     * Counts and a gate decision are things a run has once it has stopped, and
     * this suite itself queues runs it deliberately does not wait for — so
     * `recentRuns(api, 1)` regularly hands back something still QUEUED and the
     * test fails on data it created two files earlier.
     */
    const run = (await recentRuns(api, 25)).find((r) =>
      ['PASSED', 'FAILED', 'ERRORED', 'CANCELLED'].includes(r.status),
    );
    test.skip(!run, 'No finished runs in this org yet. Let one complete, or seed the demo data.');

    await page.goto(`/runs/${run!.id}`);

    await expect(page.getByText(/\d+ passed/)).toBeVisible();
    // A finished run can always be run again — and that control is how anybody
    // asks "is this failure still there?".
    await expect(page.getByRole('button', { name: /Re-run|Cancel/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Compare' })).toBeVisible();
  });

  /*
   * This used to assert the evidence rail could be collapsed and brought back.
   * The redesign replaced that rail with the always-visible TRIAGE rail — the
   * three-column cockpit sizes it with minmax() instead of hiding it — so the
   * collapse affordance no longer exists ON PURPOSE. What must now be true is
   * that both rails are really there and the right one carries the evidence.
   */
  test('the causes rail and the triage rail are both on screen with the evidence', async ({
    page,
    api,
  }) => {
    // A run WITH a failure — on a green run there is no failure story and the
    // rail rightly shows no evidence, which would vacuously fail this.
    const failure = await runWithAFailingStep(api);
    test.skip(!failure, NO_FAILURE);

    await page.goto(`/runs/${failure!.runId}`);

    await expect(page.getByRole('complementary', { name: 'What broke' })).toBeVisible();
    const triage = page.getByRole('complementary', { name: 'Triage' });
    await expect(triage).toBeVisible();
    /*
     * Console and network sections render only when the result actually carries
     * that evidence, so they cannot anchor this test. What the rail must ALWAYS
     * do for a selected failure is speak about triage: either the verdict chip,
     * or the honest sentence about why there is no verdict yet. Silence — a
     * rail that renders and says nothing — is the failure being pinned.
     */
    await expect(
      triage.getByText(/REAL BUG|INTENDED CHANGE|FLAKE|ENVIRONMENT|has not produced a verdict/),
    ).toBeVisible();
  });
});

/** Test names and step titles are data — they can contain regex metacharacters. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
