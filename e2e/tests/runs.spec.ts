import {
  test as base,
  expect,
  API_URL,
  firstProject,
  recentRuns,
  type ProjectLite,
} from '../fixtures/qaai';

/**
 * A project with no tests at all — the state every new customer is in for the
 * first few minutes, and the one nothing in the suite covered.
 *
 * Created and deleted through the API, like the editor spec's scratch file: the
 * card on /runs is what is under test, not the machinery that makes one.
 */
const test = base.extend<{ emptyProject: ProjectLite }>({
  emptyProject: async ({ api }, use) => {
    const stamp = Date.now();
    const created = await api.post(`${API_URL}/projects`, {
      data: { name: `Dogfood empty ${stamp}`, primaryFramework: 'PLAYWRIGHT' },
    });
    expect(
      created.ok(),
      `Could not create an empty project (${created.status()}). If this is a plan limit, the demo org has run out of project slots.`,
    ).toBeTruthy();
    const { project } = (await created.json()) as { project: ProjectLite };

    /*
     * POST /projects deliberately creates no environment, but the state under
     * test is the one onboarding leaves people in: somewhere to run, and nothing
     * to run there. Without this the card has no run triggers at all and the
     * assertion about them would pass by having nothing to check.
     */
    const env = await api.post(`${API_URL}/projects/${project.id}/environments`, {
      data: { name: 'staging', kind: 'STAGING', baseUrl: 'http://localhost:5050' },
    });
    expect(env.ok(), `Could not add an environment (${env.status()})`).toBeTruthy();
    const { environment } = (await env.json()) as { environment: { id: string; name: string } };

    await use({ ...project, environments: [environment] });

    const removed = await api.delete(`${API_URL}/projects/${project.id}`);
    expect
      .soft(
        removed.ok(),
        `Could not clean up ${project.name} (${removed.status()}). Archive it from Settings.`,
      )
      .toBeTruthy();
  },
});

/**
 * The runs list — the screen the product opens on, and the one that starts work.
 */

test.describe('the runs list', () => {
  test('shows the connected app and its recent runs', async ({ page, api }) => {
    const project = await firstProject(api);

    await page.goto('/runs');

    await expect(page.getByRole('heading', { name: project.name })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recent runs' })).toBeVisible();

    // Runs are links to their own cockpit — that is what makes the list usable.
    await expect(page.getByRole('link', { name: /passed|failed|flaky/ }).first()).toBeVisible();
  });

  test('the Failed filter narrows the list to the runs that failed', async ({ page, api }) => {
    const runs = await recentRuns(api, 25);
    const failed = runs.filter((run) => run.status === 'FAILED' || run.status === 'ERRORED');
    test.skip(
      failed.length === 0 || failed.length === runs.length,
      'This org has no mix of passed and failed runs, so filtering cannot be observed. Run the suite against the demo app until at least one run of each lands.',
    );

    await page.goto('/runs');
    const rows = page.getByRole('link', { name: /passed|failed|flaky/ });
    await expect(rows).toHaveCount(runs.length);

    await page.getByRole('button', { name: `Failed ${failed.length}` }).click();

    // The user-visible outcome: fewer rows, and the button reads as pressed.
    await expect(rows).toHaveCount(failed.length);
    await expect(page.getByRole('button', { name: `Failed ${failed.length}` })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  /*
   * This test used to hardcode the Passed filter and skip when `passed.length >
   * 0` — which is every stack that has ever run anything. It was born
   * unreachable: it reported "skipped" forever and had never once executed, so
   * the empty state it guards was covered by nothing.
   *
   * The state under test is not "Passed is empty", it is "the filter you picked
   * matches nothing, and the screen offers a way out". Any status with zero runs
   * reaches it, so the test finds one instead of assuming which.
   */
  test('a filter that matches nothing offers the way back', async ({ page, api }) => {
    const runs = await recentRuns(api, 25);
    const counts = {
      Failed: runs.filter((r) => r.status === 'FAILED' || r.status === 'ERRORED').length,
      Passed: runs.filter((r) => r.status === 'PASSED').length,
      Running: runs.filter((r) => r.status === 'RUNNING' || r.status === 'QUEUED').length,
    };
    const empty = Object.entries(counts).find(([, n]) => n === 0)?.[0];
    test.skip(
      !empty,
      `This org has runs in every status (${JSON.stringify(counts)}), so no filter can be empty.`,
    );

    await page.goto('/runs');
    await page.getByRole('button', { name: new RegExp(`^${empty}`) }).click();

    await expect(page.getByRole('heading', { name: 'Nothing with that status' })).toBeVisible();
    await page.getByRole('button', { name: 'Show all runs' }).click();
    await expect(page.getByRole('heading', { name: 'Nothing with that status' })).toHaveCount(0);

    // The way back actually went back — every run is on screen again.
    await expect(page.getByRole('link', { name: /passed|failed|flaky/ })).toHaveCount(runs.length);
  });
});

/*
 * The first screen a new customer sees, in the state they see it in.
 *
 * "▶ Run staging" used to be enabled on a project with zero tests — and it was
 * the ONLY enabled control on the page. Pressing it produced a correct toast
 * ("no tests to run") and left the person exactly where they started, with no
 * link anywhere to the plan the Explorer had already written for them.
 */
test.describe('a project with no tests yet', () => {
  test('leads to its plan instead of offering a run that cannot happen', async ({
    page,
    emptyProject,
  }) => {
    await page.goto('/runs');

    /*
     * The deepest div holding BOTH this project's heading and a run trigger is
     * its card. Filtering on the name alone lands on the heading row, which has
     * the name and none of the controls — and the run triggers have to be scoped
     * to this card, because the seeded project's are legitimately enabled.
     */
    const card = page
      .locator('div')
      .filter({ has: page.getByRole('heading', { name: emptyProject.name, exact: true }) })
      .filter({ has: page.getByRole('button', { name: /^▶ Run / }) })
      .last();
    await expect(card.getByRole('heading', { name: emptyProject.name })).toBeVisible();

    // The way forward, addressed to THIS project.
    await expect(card.getByRole('link', { name: /Review the test plan/ })).toHaveAttribute(
      'href',
      `/projects/${emptyProject.id}/plan`,
    );

    // And the trap is closed: every run trigger on this card is disabled, with
    // the reason on the control rather than in a toast after the click.
    const triggers = card.getByRole('button', { name: /^▶ Run / });
    const count = await triggers.count();
    expect(count, 'a new project should still show its environments').toBeGreaterThan(0);
    for (let i = 0; i < count; i++) await expect(triggers.nth(i)).toBeDisabled();

    await expect(card.getByText(/No tests yet, so there is nothing to run/)).toBeVisible();
  });

  test('the plan link lands somewhere that tells you what to do', async ({
    page,
    emptyProject,
  }) => {
    await page.goto(`/projects/${emptyProject.id}/plan`);

    /*
     * A project created through onboarding has a plan; one created any other way
     * has none. Both are real states and neither may be a dead end, so this
     * asserts the weaker, always-true property: whatever is on screen names the
     * next action. Pinning only the happy path would let the empty case rot.
     */
    await expect(
      page.getByRole('heading', { name: 'Proposed test plan' }).or(page.getByText(/No plan yet/)),
    ).toBeVisible();
    await expect(
      page
        .getByRole('button', { name: /^Generate \d+ test/ })
        .or(page.getByRole('link', { name: 'Run the Explorer' })),
    ).toBeVisible();
  });
});

test.describe('starting a run', () => {
  /*
   * This one really starts a run: a row in Postgres, a job on the queue, the
   * worker driving the demo app at :5050. That is the point — a "start a run"
   * test that stubbed the POST would prove only that a button calls fetch.
   *
   * It does NOT wait for the run to finish. What must never break is the
   * hand-off: press Run, and the cockpit for that run is on screen with an id
   * you can quote. Whether the suite goes green afterwards is the demo app's
   * business, not this suite's.
   */
  test('pressing Run opens the cockpit for the run it just queued', async ({ page, api }) => {
    const project = await firstProject(api);
    const environment = project.environments[0];
    test.skip(!environment, `${project.name} has no environment to run against.`);

    await page.goto('/runs');

    const runButton = page.getByRole('button', { name: `▶ Run ${environment!.name}` });
    await expect(runButton).toBeEnabled();
    await runButton.click();

    // The cockpit, addressed by the new run's id.
    await expect(page).toHaveURL(/\/runs\/[a-z0-9]+$/);
    await expect(page.getByRole('link', { name: /Runs/ }).first()).toBeVisible();

    // And the app said what it did. A silent start is the failure mode this
    // codebase already shipped once ("1 test queued" for a job that died).
    await expect(page.getByRole('status').filter({ hasText: /Run queued/ })).toBeVisible();
  });
});
