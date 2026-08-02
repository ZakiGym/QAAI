import { test as base, expect } from '../fixtures/qaai';
import { NO_DATABASE, reviewStateOf, seedPendingVerdicts, type SeededVerdict } from '../fixtures/db';

/**
 * Triage — reading a verdict, and disagreeing with it.
 *
 * "You get the last word" is the promise printed at the top of the screen. The
 * endpoints behind it existed for a long time with nothing rendering them,
 * which meant the AI's call on every failure was recorded and never
 * challengeable — so this is precisely the kind of surface that needs a test
 * standing on it.
 *
 * The verdicts are seeded by the spec (see fixtures/db.ts): with no
 * ANTHROPIC_API_KEY on this deployment nothing writes them, and asserting
 * against an empty screen would prove nothing.
 */

const test = base.extend<{ pending: SeededVerdict[] }>({
  pending: async ({}, use) => {
    const seeded = await seedPendingVerdicts(2);
    // Skipping, not failing: no database (or no failed result to hang a verdict
    // on) is a missing prerequisite, not a defect in the product.
    base.skip(
      seeded === null,
      `${NO_DATABASE} It also needs two FAILED test results with no verdict yet.`,
    );
    await use(seeded!.verdicts);
    await seeded!.cleanup();
  },
});

test.describe('one verdict at a time', () => {
  test('the verdict, its confidence and the evidence behind it are all on screen', async ({
    page,
    pending,
  }) => {
    const target = pending[0]!;

    await page.goto('/triage');

    await page.getByRole('button', { name: new RegExp(escapeRe(target.testName)) }).first().click();

    await expect(page.getByRole('heading', { name: target.testName })).toBeVisible();
    await expect(page.getByText('Real bug').first()).toBeVisible();
    await expect(page.getByText('91% confident')).toBeVisible();
    await expect(page.getByText(target.explanation)).toBeVisible();

    // The evidence is the reason this screen is trustworthy at all — a verdict
    // with nothing to point at is an opinion.
    await expect(page.getByText('Evidence it used')).toBeVisible();
    await expect(page.getByText(target.evidenceDetail)).toBeVisible();
    await expect(page.getByText(/Decided by e2e-dogfood-fixture/)).toBeVisible();
  });

  test('overriding the verdict records the human’s call, not the model’s', async ({
    page,
    pending,
  }) => {
    const target = pending[0]!;

    await page.goto('/triage');
    await page.getByRole('button', { name: new RegExp(escapeRe(target.testName)) }).first().click();

    await expect(page.getByText('Do you agree?')).toBeVisible();
    // The model said REAL_BUG. The human says it was the environment.
    await page.getByRole('button', { name: 'Environment issue' }).click();

    await expect(
      page.getByRole('status').filter({ hasText: 'Overridden to Environment issue.' }),
    ).toBeVisible();

    // It left the pending queue, which is the visible consequence of deciding.
    await expect(
      page.getByRole('button', { name: new RegExp(escapeRe(target.testName)) }),
    ).toHaveCount(0);

    // And it is a fact in the database, not a hopeful toast. This is the
    // failure this codebase has already shipped once — a success message for
    // work that did not happen.
    expect(await reviewStateOf(target.id)).toBe('OVERRIDDEN:ENV_ISSUE');
  });

  test('a reviewed verdict comes back with Include reviewed, and cannot be decided twice', async ({
    page,
    pending,
  }) => {
    const target = pending[0]!;

    await page.goto('/triage');
    await page.getByRole('button', { name: new RegExp(escapeRe(target.testName)) }).first().click();
    await page.getByRole('button', { name: 'Agree', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Verdict accepted.' })).toBeVisible();

    await page.getByRole('checkbox', { name: 'Include reviewed' }).check();

    const row = page.getByRole('button', { name: new RegExp(escapeRe(target.testName)) }).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByText('Already reviewed — accepted.')).toBeVisible();
    await expect(page.getByText('Do you agree?')).toHaveCount(0);
  });
});

test.describe('deciding in bulk', () => {
  test('a batch is reversible, and the undo is still there when you want it', async ({
    page,
    pending,
  }) => {
    await page.goto('/triage');

    await page.getByRole('checkbox', { name: 'Select every failure awaiting review' }).check();
    await expect(page.getByText(`${pending.length} selected`)).toBeVisible();

    // The honest description of what the server does, printed next to the
    // button. If that ever stops being true the sentence has to change too.
    await expect(
      page.getByText(`Recorded as ${pending.length} separate decisions, and reversible.`),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Agree with all' }).click();

    const undoStrip = page.getByRole('status').filter({ hasText: 'in one go' });
    await expect(undoStrip).toBeVisible();
    for (const verdict of pending) {
      expect(await reviewStateOf(verdict.id)).toBe('ACCEPTED');
    }

    /*
     * The undo strip is deliberately persistent — a four-second toast is not an
     * undo. Asserting it is still there after the app has had time to settle is
     * the closest a test can get to "still there when you realise you were
     * wrong", and it is done by re-asserting rather than by sleeping.
     */
    await expect(undoStrip.getByRole('button', { name: 'Undo' })).toBeVisible();
    await undoStrip.getByRole('button', { name: 'Undo' }).click();

    await expect(
      page.getByRole('status').filter({ hasText: `Put ${pending.length} back for review.` }),
    ).toBeVisible();
    for (const verdict of pending) {
      expect(await reviewStateOf(verdict.id)).toBe('PENDING');
    }
  });
});

/** Test names are data — they can contain regex metacharacters. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
