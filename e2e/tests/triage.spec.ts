import { test as base, expect } from '../fixtures/qaai';
import {
  NO_DATABASE,
  reviewStateOf,
  seedClusteredVerdicts,
  seedPendingVerdicts,
  type SeededVerdict,
} from '../fixtures/db';

/**
 * Triage — reading a verdict, and disagreeing with it.
 *
 * "You get the last word" is the promise printed at the top of the screen. The
 * endpoints behind it existed for a long time with nothing rendering them,
 * which meant the AI's call on every failure was recorded and never
 * challengeable — so this is precisely the kind of surface that needs a test
 * standing on it.
 *
 * ─── Rewritten for the cause-grouped redesign ───────────────────────────────
 *
 * The screen used to be a flat queue with a detail pane: click a row, read the
 * verdict on the right, answer "Do you agree?" with one of five buttons. It is
 * now grouped by cause, evidence expands inline under the failure, and the
 * decision is `Agree` / `override ▾` on the group or the row. Every assertion
 * below is the same CLAIM as before — the verdict is visible, evidence is
 * attached, overriding records the human's call, deciding twice is impossible,
 * bulk is N decisions and reversible — re-pointed at the new affordances.
 *
 * The seeded verdicts are created on a run of the fixture's own with DISTINCT
 * error strings, so the clusterer provably cannot group them and they render
 * as "causes of one". That path is worth pinning on
 * its own merits: a single's controls nearly shipped as agree-only for mouse
 * users, which these tests were what caught.
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
      `${NO_DATABASE} It also needs a run to model the fixture's own on, and two live tests.`,
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

    // A cause of one is titled by its test's name, and the title is the
    // disclosure: clicking it opens the evidence inline beneath.
    const row = page.getByRole('button', { name: new RegExp(escapeRe(target.testName)) }).first();
    await row.click();

    // The verdict chip: REAL BUG · 0.91. Confidence moved from "91% confident"
    // prose into the chip, to two decimals.
    await expect(page.getByText('REAL BUG').first()).toBeVisible();
    await expect(page.getByText('0.91').first()).toBeVisible();
    // The agent's sentence — now set in serif italic, still the same words.
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

    /*
     * The override lives behind `override ▾` next to the group's Agree button.
     * Scoped to the section that carries this failure's name, because every
     * pending single renders the same control.
     */
    // Scoped by the fixture's own explanation — unique per seeding, where a
    // test NAME recurs across the demo data and other specs' runs.
    const section = page.locator('section', { hasText: target.explanation }).first();
    await section.getByRole('button', { name: 'override ▾' }).click();
    // The model said REAL_BUG. The human says it was the environment.
    await section.getByRole('menuitem', { name: 'Environment issue' }).click();

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

    const section = page.locator('section', { hasText: target.explanation }).first();
    await section.getByRole('button', { name: 'Agree', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Verdict accepted.' })).toBeVisible();

    await page.getByRole('checkbox', { name: 'Include reviewed' }).check();

    /*
     * Decided rows come back marked with their outcome and stripped of their
     * controls — "cannot be decided twice" is the ABSENCE of Agree and
     * override, not a sentence. The old screen printed "Already reviewed —
     * accepted."; the new one shows the state on the row's meta line.
     */
    const reviewed = page.locator('section', { hasText: target.explanation }).first();
    await expect(reviewed).toBeVisible();
    await expect(reviewed.getByText(/accepted/)).toBeVisible();
    await expect(reviewed.getByRole('button', { name: 'Agree', exact: true })).toHaveCount(0);
    await expect(reviewed.getByRole('button', { name: 'override ▾' })).toHaveCount(0);
  });
});

test.describe('deciding in bulk', () => {
  /*
   * Bulk is per-CAUSE now — "Agree all N" on a group — so this test seeds a
   * fixture that is GUARANTEED to render as one ×2 group (see
   * seedClusteredVerdicts: same run, identical error message, deterministic
   * signature). Hoping the demo data happens to cluster would be a flake.
   */
  const grouped = base.extend<{ cluster: SeededVerdict[] }>({
    cluster: async ({}, use) => {
      const seeded = await seedClusteredVerdicts(2);
      base.skip(
        seeded === null,
        `${NO_DATABASE} It also needs a run to model the fixture's own on, and two live tests.`,
      );
      await use(seeded!.verdicts);
      await seeded!.cleanup();
    },
  });

  grouped('a batch is reversible, and the undo is still there when you want it', async ({
    page,
    cluster,
  }) => {
    await page.goto('/triage');

    // The honest description of what the server does, printed under the group.
    // If that ever stops being true the sentence has to change too.
    await expect(page.getByText('recorded as 2 separate decisions · reversible')).toBeVisible();

    await page.getByRole('button', { name: /Agree all 2/ }).click();

    const undoStrip = page.getByRole('status').filter({ hasText: 'in one go' });
    await expect(undoStrip).toBeVisible();
    for (const verdict of cluster) {
      expect(await reviewStateOf(verdict.id)).toBe('ACCEPTED');
    }

    /*
     * The undo strip is deliberately persistent — a four-second toast is not an
     * undo. Outlasting a toast's lifetime is the regression test for that.
     */
    await page.waitForTimeout(5_000);
    await expect(undoStrip).toBeVisible();

    // And it undoes what it says: both verdicts back to PENDING in Postgres,
    // not merely on screen.
    await undoStrip.getByRole('button', { name: 'Undo' }).click();
    await expect(async () => {
      for (const verdict of cluster) {
        expect(await reviewStateOf(verdict.id)).toBe('PENDING');
      }
    }).toPass({ timeout: 5_000 });
  });
});

/** Test names are data — they can contain regex metacharacters. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
