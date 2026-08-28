import { test, expect, shortcut, firstProject, projectTests, shellReady, openTab } from '../fixtures/qaai';

/**
 * The keyboard — ⌘K, ⌘P, ⌘\ and ⌘/.
 *
 * QAAI is a cockpit for people who live in an editor, and the palette is how
 * they are meant to move around it. It is also the least clickable surface in
 * the app, so it is the one most likely to rot unnoticed: nothing on screen
 * changes when a global keydown listener stops being installed.
 *
 * The modifier comes from `shortcut()`, which asks the PAGE which platform it
 * is on. AppShell binds ⌘ when navigator.userAgent looks like a Mac and Ctrl
 * otherwise — Ctrl-K and Ctrl-P are the OS's own text bindings on a Mac and the
 * app deliberately does not steal them — and the emulated Desktop Chrome
 * profile these tests run under reports Windows even on a Mac.
 */

test.describe('the command palette', () => {
  test('⌘K opens it, and typing narrows the commands', async ({ page }) => {
    await page.goto('/runs');
    await shellReady(page);

    await shortcut(page, 'k');

    const palette = page.getByRole('dialog', { name: 'Run a command' });
    await expect(palette).toBeVisible();
    await expect(palette.getByPlaceholder('Run a command…')).toBeFocused();

    await palette.getByPlaceholder('Run a command…').fill('triage');
    /*
     * `.first()`, because "Go to Triage" is now three commands, not one — the
     * palette gained an entry per section tab (Verdicts / Heals / Quality) when
     * the nav grew tab strips. More matches is the feature working; the
     * assertion is that narrowing kept Triage and dropped Settings.
     */
    await expect(palette.getByRole('button', { name: /Go to Triage/ }).first()).toBeVisible();
    await expect(palette.getByRole('button', { name: /Go to Settings/ })).toHaveCount(0);
  });

  test('choosing a command from the palette goes there', async ({ page }) => {
    await page.goto('/runs');
    await shellReady(page);

    await shortcut(page, 'k');
    await page.getByPlaceholder('Run a command…').fill('triage');
    // .first() — see above; the top match is the section's own first tab.
    await page.getByRole('button', { name: /Go to Triage/ }).first().click();

    await expect(page.getByRole('heading', { name: 'Triage', level: 1 })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Run a command' })).toHaveCount(0);
  });

  test('a search that matches nothing says so rather than showing everything', async ({ page }) => {
    await page.goto('/runs');
    await shellReady(page);

    await shortcut(page, 'k');
    await page.getByPlaceholder('Run a command…').fill('zzzzzzzz');

    await expect(page.getByText('No matches')).toBeVisible();
  });

  test('Escape closes it without navigating', async ({ page }) => {
    await page.goto('/runs');
    await shellReady(page);

    await shortcut(page, 'k');
    await expect(page.getByRole('dialog', { name: 'Run a command' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Run a command' })).toHaveCount(0);
    await expect(page).toHaveURL(/\/runs$/);
  });
});

test.describe('quick-open', () => {
  test('⌘P lists the selected project’s test files', async ({ page, api }) => {
    const project = await firstProject(api);
    const tests = await projectTests(api, project.id);
    test.skip(tests.length === 0, 'This project has no tests to quick-open. Seed the demo data.');

    await page.goto('/runs');
    await shellReady(page);

    await shortcut(page, 'p');

    const palette = page.getByRole('dialog', { name: 'Go to file' });
    await expect(palette).toBeVisible();

    /*
     * TYPE the name, the way a person does — do not expect it to be on screen
     * already.
     *
     * With no query the palette renders the first 60 entries, and the demo
     * project has 326. Whether `tests[0]` was among them depended on the API's
     * `feature asc, name asc` and the palette's own order agreeing, which they
     * need not: this test failed intermittently for exactly that reason and the
     * flake said nothing about quick-open being broken.
     *
     * Typing is also the real feature. "Is my file in the first sixty" is not
     * what anybody uses ⌘P for; "can I find my file" is.
     */
    const target = tests[0]!;
    await palette.getByRole('textbox').fill(target.name.slice(0, 24));
    await expect(palette.getByRole('button', { name: new RegExp(escapeRe(target.name)) })).toBeVisible();
  });

  test('picking a file opens it in the editor', async ({ page, api }) => {
    const project = await firstProject(api);
    const tests = await projectTests(api, project.id);
    /*
     * A target whose name is not a substring of any other test's, so the
     * fuzzy-narrowed list's FIRST entry is provably the one this test means —
     * `.first()` on an ambiguous name can click a lookalike and then wait
     * forever for the wrong file's close button.
     */
    const target =
      tests.find(
        (t) =>
          t.filePath.endsWith('.spec.ts') &&
          tests.every((o) => o === t || !o.name.includes(t.name)),
      ) ?? tests.find((t) => t.filePath.endsWith('.spec.ts'));
    test.skip(!target, 'This project has no tests to open. Seed the demo data.');

    await page.goto('/runs');
    await shellReady(page);

    await shortcut(page, 'p');
    const palette = page.getByRole('dialog', { name: 'Go to file' });
    await palette.getByPlaceholder('Go to file…').fill(target!.name);
    /*
     * Wait for the entry BEFORE clicking. The files list loads lazily on first
     * open, and under full-suite load that fetch can be slow — a bare .click()
     * waits for it invisibly and then dies as an opaque test timeout, where the
     * expect names what was actually missing.
     */
    const entry = palette.getByRole('button', { name: new RegExp(escapeRe(target!.name)) }).first();
    await expect(entry).toBeVisible({ timeout: 15_000 });
    await entry.click();

    /*
     * The user-visible outcome is the file open in the editor, not the URL.
     *
     * This used to look for the full filePath as text. The redesigned editor
     * never renders the full path anywhere — the tree is basenames with
     * ellipsis and the open-file chips are basenames too, both per the design —
     * so the proof is now the file's own tab chip, which only exists once a
     * file is actually open.
     */
    // The close button is the one control that only exists once the file is
    // truly open — the tree row's text is ALSO the basename, so any basename
    // match can pass with nothing open at all.
    await expect(
      openTab(page, target!.filePath),
    ).toBeVisible();
  });
});

test.describe('the rest of the keyboard', () => {
  test('⌘/ opens the shortcuts sheet and Escape closes it', async ({ page }) => {
    await page.goto('/runs');
    await shellReady(page);

    await shortcut(page, '/');

    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toBeVisible();
    // The sheet has to actually list the bindings — an empty sheet is worse
    // than none, because it says the shortcuts do not exist.
    await expect(sheet.getByText('Command palette').first()).toBeVisible();
    await expect(sheet.getByText('Go to file')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });

  test('the shortcuts sheet is reachable from the palette too', async ({ page }) => {
    await page.goto('/runs');
    await shellReady(page);

    await shortcut(page, 'k');
    await page.getByRole('button', { name: /Keyboard shortcuts/ }).click();

    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  });

  test('⌘\\ collapses the sidebar and brings it back', async ({ page }) => {
    await page.goto('/runs');
    await shellReady(page);

    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();

    await shortcut(page, '\\');
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();

    await shortcut(page, '\\');
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
  });
});

/** Test names are data — they can contain regex metacharacters. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
