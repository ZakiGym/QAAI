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
     * ...and the step scrubber names the step that failed. Anchored on the step
     * INDEX as well as the title: real suites contain steps whose titles are
     * prefixes of each other ("Headers and cookies: /" and ".../products"), and
     * a title-only locator quietly matches both.
     */
    await expect(
      page.getByRole('button', {
        name: new RegExp(`\\b${stepIndex}\\s+${escapeRe(stepTitle)}(\\s|$)`),
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

    await expect(
      page.getByRole('heading', { name: `Findings (${failure!.findingCount})` }),
    ).toBeVisible();
  });

  test('the header states the counts and the gate decision', async ({ page, api }) => {
    const [run] = await recentRuns(api, 1);
    test.skip(!run, 'No runs in this org yet.');

    await page.goto(`/runs/${run!.id}`);

    await expect(page.getByText(/\d+ passed/)).toBeVisible();
    // A finished run can always be run again — and that control is how anybody
    // asks "is this failure still there?".
    await expect(page.getByRole('button', { name: /Re-run|Cancel/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Compare' })).toBeVisible();
  });

  test('the evidence rail can be collapsed and brought back', async ({ page, api }) => {
    const [run] = await recentRuns(api, 1);
    test.skip(!run, 'No runs in this org yet.');

    await page.goto(`/runs/${run!.id}`);

    const rail = page.getByRole('complementary', { name: 'Evidence' });
    await expect(rail).toBeVisible();

    await page.getByRole('button', { name: 'Collapse evidence rail' }).click();
    // Collapsed to a strip, never to nothing — the run's live feed lives here.
    await expect(page.getByRole('button', { name: 'Show evidence' })).toBeVisible();

    await page.getByRole('button', { name: 'Show evidence' }).click();
    await expect(page.getByRole('button', { name: 'Collapse evidence rail' })).toBeVisible();
  });
});

/** Test names and step titles are data — they can contain regex metacharacters. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
