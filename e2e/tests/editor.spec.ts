import { test as base, expect, API_URL, firstProject, projectTests, shortcut } from '../fixtures/qaai';

/**
 * The editor — open a test, change it, save it.
 *
 * "You keep the code" is one of three promises on the landing page, and this
 * screen is the only place a person exercises it. Monaco is reached by its
 * `code` role rather than by a `.monaco-editor textarea` CSS path that changes
 * with a Monaco upgrade.
 */

interface Scratch {
  id: string;
  name: string;
  filePath: string;
}

/**
 * A test file of this suite's own, created before and deleted after.
 *
 * The alternative — editing one of the seeded tests — writes real content into
 * a file the demo depends on and leaves it changed if the assertion fails
 * halfway. Setup and teardown go through the API on purpose; the UI is what is
 * under test, not what builds the fixture.
 */
const test = base.extend<{ scratch: Scratch }>({
  scratch: async ({ api }, use) => {
    const project = await firstProject(api);
    const stamp = Date.now();
    const filePath = `e2e-scratch/dogfood-${stamp}.spec.ts`;

    const created = await api.post(`${API_URL}/projects/${project.id}/tests`, {
      data: {
        name: `Dogfood scratch ${stamp}`,
        type: 'E2E',
        feature: 'Hand-written',
        priority: 'NICE_TO_HAVE',
        filePath,
        tags: ['e2e-dogfood'],
        code: `import { test, expect } from '@playwright/test';\n\ntest('scratch', async ({ page }) => {\n  await page.goto('/');\n});\n`,
      },
    });
    expect(
      created.ok(),
      `Could not create the scratch test (${created.status()}). The editor spec needs write access to the demo project.`,
    ).toBeTruthy();
    const { test: made } = (await created.json()) as { test: Scratch };

    await use(made);

    /*
     * Deleted whether or not the test passed. QAAI's delete is a soft one
     * (`disabledAt`), so this is not a destructive teardown — it just takes the
     * file back out of the tree and leaves its history alone.
     *
     * Checked, not fired and forgotten: an unchecked teardown that quietly 409s
     * leaves a suite's scratch files piling up in somebody's real project, and
     * the whole point of this wave is not reporting success for work that did
     * not happen. Soft, so a cleanup problem is reported without being
     * mistaken for the failure the test was actually about.
     */
    const removed = await api.delete(`${API_URL}/projects/${project.id}/tests/${made.id}`);
    expect
      .soft(
        removed.ok(),
        `Could not clean up the scratch test ${filePath} (${removed.status()}). Delete it from the editor.`,
      )
      .toBeTruthy();
  },
});

test.describe('the editor', () => {
  test('clicking a file in the tree switches the editor to it', async ({ page, api }) => {
    const project = await firstProject(api);
    const specs = (await projectTests(api, project.id)).filter((t) =>
      t.filePath.endsWith('.spec.ts'),
    );
    test.skip(
      specs.length < 2,
      'Needs two .spec.ts tests to prove the tree switches between them. Seed the demo data.',
    );
    const [open, target] = specs;

    // Start with a KNOWN file open, so clicking the other one is a real switch.
    // (A bare /editor restores a file of its own choosing, which would make an
    // assertion about "the file I clicked" pass without the click.)
    await page.goto(`/editor?test=${open!.id}`);
    // The full path never renders in the redesigned editor (tree and tabs are
    // basenames); the close button's label is where the full path lives.
    await expect(page.getByRole('button', { name: `Close ${open!.filePath}` })).toBeVisible();

    /*
     * The tree row, addressed by its tooltip — the test's NAME. Its file name
     * alone is ambiguous: the open-file tab above the editor carries the same
     * text, and the two are different controls doing different things.
     */
    await page.getByTitle(target!.name, { exact: true }).click();

    await expect(page.getByRole('button', { name: `Close ${target!.filePath}` })).toBeVisible();
    await expect(page.getByRole('code')).toBeVisible();
  });

  test('an edit is saved, and it is still there when the file is reopened', async ({
    page,
    scratch,
  }) => {
    const marker = `//qaai-dogfood-${Date.now()}`;

    await page.goto(`/editor?test=${scratch.id}`);

    /*
     * Monaco's own `textbox` (aria-label "Editor content") is the element a
     * screen reader talks to, but it is visually hidden — so the surface a
     * person actually clicks is the rendered `code` region. Assertions about
     * the text go through that.
     */
    const code = page.getByRole('code');
    await expect(code).toBeVisible();

    await code.click();
    await shortcut(page, 'a');
    /*
     * insertText, not keyboard.type. Both are things a person does — this is a
     * paste — but only one is deterministic: typing 30 keystrokes at machine
     * speed into Monaco while the box is under load drops the occasional
     * character, and the assertion below is about persistence, not about how
     * fast the editor can take input. The assertion itself is unchanged: the
     * exact text has to survive a round trip.
     */
    await page.keyboard.insertText(marker);

    // Save is only offered once there is something to save — that is the
    // dirty-state contract, and it is worth asserting before pressing it.
    const save = page.getByRole('button', { name: /^Save/ });
    await expect(save).toBeEnabled();
    await save.click();

    await expect(page.getByText('Saved')).toBeVisible();

    // The real proof: come back to it. A "Saved" label is a claim; the file
    // still holding the edit after a reload is the fact.
    await page.goto(`/editor?test=${scratch.id}`);
    await expect(page.getByText(marker)).toBeVisible();
  });

  test('⌘S saves too, not just the button', async ({ page, scratch }) => {
    const marker = `//qaai-dogfood-keyboard-${Date.now()}`;

    await page.goto(`/editor?test=${scratch.id}`);
    const code = page.getByRole('code');
    await expect(code).toBeVisible();

    await code.click();
    await shortcut(page, 'a');
    await page.keyboard.insertText(marker);
    await shortcut(page, 's');

    await expect(page.getByText('Saved')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Save/ })).toBeDisabled();
  });

  /*
   * The regression this exists for: ?test= resolved with
   * `loaded.find(...) || loaded[0]`, so a link to a test that is not in the tree
   * — deleted, archived, or belonging to another app — opened an UNRELATED file
   * instead. The tab showed that file's real name, nothing said a substitution
   * had happened, and the person who followed "open the failing test" from
   * triage started editing something else.
   *
   * `|| loaded[0]` is still right for a bare /editor visit; the test below pins
   * that half so the fix cannot be undone by deleting the fallback outright.
   */
  test('a deep link to a test that is not here says so instead of opening another file', async ({
    page,
    api,
  }) => {
    const project = await firstProject(api);
    const existing = await projectTests(api, project.id);
    expect(existing.length, 'the demo project needs at least one test').toBeGreaterThan(0);

    // Well-formed and absent, so this exercises the not-found path rather than
    // an id the API rejects outright.
    await page.goto('/editor?test=clzzzzzzzzzzzzzzzzzzzzzzz');

    await expect(page.getByText(/That test is not in this app/)).toBeVisible();

    // Nothing was opened in its place — that is the whole point.
    await expect(page.getByRole('button', { name: /^Close / })).toHaveCount(0);
    for (const t of existing.slice(0, 5)) {
      await expect(page.getByRole('button', { name: `Close ${t.filePath}` })).toHaveCount(0);
    }
  });

  test('a bare /editor still opens something rather than sitting empty', async ({ page, api }) => {
    const project = await firstProject(api);
    const existing = await projectTests(api, project.id);
    expect(existing.length, 'the demo project needs at least one test').toBeGreaterThan(0);

    await page.goto('/editor');

    await expect(page.getByRole('code')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Close / })).toHaveCount(1);
    await expect(page.getByText(/That test is not in this app/)).toHaveCount(0);
  });

  /*
   * The regression this exists for: the "New test" dialog asked for a name and
   * hardcoded `type: 'E2E'` with a Playwright template — the API accepted every
   * test type and the UI could mint exactly one. The picker now offers the
   * types with a plugin behind them, and a spec-driven choice must open as its
   * golden JSON spec, not as a TypeScript stub the plugin would never read.
   */
  test('the new-test dialog creates the type it was asked for, spec-first', async ({
    page,
    api,
  }) => {
    const project = await firstProject(api);
    const stamp = Date.now();
    const name = `Dogfood a11y ${stamp}`;

    await page.goto('/editor');
    await page.getByRole('button', { name: '+ new test' }).click();

    const dialog = page.getByRole('dialog', { name: 'New test' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Test name').fill(name);
    await dialog.getByLabel('Type').selectOption('ACCESSIBILITY');
    await dialog.getByRole('button', { name: 'Create' }).click();

    // The file lands with the type's own extension, not .spec.ts…
    const filePath = `hand-written/dogfood-a11y-${stamp}.a11y.json`;
    await expect(page.getByRole('button', { name: `Close ${filePath}` })).toBeVisible();
    // …and the buffer holds the runnable JSON spec — the routes axe will scan —
    // rather than a Playwright stub the accessibility plugin would never read.
    await expect(page.getByRole('code')).toContainText('routes');

    // Clean up through the API, same soft contract as the scratch fixture.
    const created = (await projectTests(api, project.id)).find((t) => t.filePath === filePath);
    expect(created, 'the created test should be in the project tree').toBeDefined();
    if (created) {
      const removed = await api.delete(`${API_URL}/projects/${project.id}/tests/${created.id}`);
      expect
        .soft(removed.ok(), `Could not clean up ${filePath} (${removed.status()}).`)
        .toBeTruthy();
    }
  });

  test('closing a file with unsaved changes asks first', async ({ page, scratch }) => {
    await page.goto(`/editor?test=${scratch.id}`);

    const code = page.getByRole('code');
    await expect(code).toBeVisible();
    await code.click();
    await page.keyboard.type('//dirty');

    await page.getByRole('button', { name: `Close ${scratch.filePath}` }).click();

    const dialog = page.getByRole('dialog', { name: 'Unsaved changes' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(scratch.filePath)).toBeVisible();

    await dialog.getByRole('button', { name: 'Close anyway' }).click();
    await expect(page.getByRole('button', { name: `Close ${scratch.filePath}` })).toHaveCount(0);
  });
});
