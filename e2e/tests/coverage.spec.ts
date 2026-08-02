import type { APIRequestContext } from '@playwright/test';
import { test, expect, API_URL, firstProject } from '../fixtures/qaai';

/**
 * Coverage gaps — the screen that says "nobody tests this", and why.
 *
 * The whole feature turns on the evidence. A ranked list of untested surfaces
 * with no support for the claim is a list nobody acts on, and the code goes to
 * some trouble to keep the evidence out from behind a disclosure. If that ever
 * regresses to a bare list of titles, the screen is still "working" and has
 * stopped being worth opening — which is exactly the sort of failure a
 * screenshot review misses and this catches.
 */

interface CoverageReport {
  crawled: boolean;
  gaps: Array<{
    id: string;
    title: string;
    evidence: string[];
    score: number;
    scoreWhy: string[];
    confidence: string;
  }>;
  totals: { tests: number; gaps: number };
}

async function coverage(api: APIRequestContext, projectId: string): Promise<CoverageReport> {
  const response = await api.get(`${API_URL}/coverage/${projectId}`);
  expect(response.ok(), `GET /coverage answered ${response.status()}`).toBeTruthy();
  return (await response.json()) as CoverageReport;
}

const NOT_CRAWLED =
  'This app has never been crawled, so there is no coverage report to render. Run the Explorer ' +
  'from /flow-map first.';

test.describe('coverage gaps', () => {
  test('the headline counts the suite against the untested surfaces', async ({ page, api }) => {
    const project = await firstProject(api);
    const report = await coverage(api, project.id);
    test.skip(!report.crawled, NOT_CRAWLED);

    await page.goto('/insights/coverage');

    await expect(page.getByRole('heading', { name: 'Coverage gaps', level: 1 })).toBeVisible();
    await expect(
      page.getByText(
        `You have ${report.totals.tests} tests and ${report.totals.gaps} untested surfaces`,
      ),
    ).toBeVisible();
  });

  test('every gap carries its evidence on the same screen', async ({ page, api }) => {
    const project = await firstProject(api);
    const report = await coverage(api, project.id);
    test.skip(!report.crawled, NOT_CRAWLED);
    test.skip(report.gaps.length === 0, 'This app has no coverage gaps — nothing to render.');

    await page.goto('/insights/coverage');

    const top = report.gaps[0]!;
    await expect(page.getByRole('heading', { name: top.title })).toBeVisible();

    // The claim, and the support for it, side by side. Never behind a toggle.
    await expect(page.getByText('Why we think so', { exact: true }).first()).toBeVisible();
    for (const line of top.evidence.slice(0, 2)) {
      await expect(page.getByText(line, { exact: false }).first()).toBeVisible();
    }

    /*
     * Every gap on the page has an evidence block, not just the first — a gap
     * with no support for its claim is a gap nobody can act on.
     *
     * Counted against the cards ON SCREEN rather than against the number the
     * API returned a moment earlier. Coverage is recomputed from the current
     * suite on every request, so a test created between the two calls moves
     * that number and the mismatch says nothing about the screen.
     */
    const cards = page.getByRole('checkbox', { name: /^Select: / });
    const shown = await cards.count();
    expect(shown).toBeGreaterThan(0);
    // `exact` matters: without it the substring match also picks up a wrapper
    // element, and the count is one too many for reasons that have nothing to
    // do with the screen.
    await expect(page.getByText('Why we think so', { exact: true })).toHaveCount(shown);
  });

  test('a gap explains its own rank when you open it', async ({ page, api }) => {
    const project = await firstProject(api);
    const report = await coverage(api, project.id);
    test.skip(!report.crawled, NOT_CRAWLED);
    test.skip(report.gaps.length === 0, 'This app has no coverage gaps — nothing to render.');

    const top = report.gaps[0]!;
    await page.goto('/insights/coverage');

    const disclosure = page
      .getByRole('button', { name: 'What the crawl saw, and what a test would do' })
      .first();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await disclosure.click();
    await expect(
      page.getByRole('button', { name: 'Hide' }).first(),
    ).toHaveAttribute('aria-expanded', 'true');

    await expect(page.getByText(`Ranked ${top.score} because`)).toBeVisible();
    await expect(page.getByText(top.scoreWhy[0]!, { exact: false })).toBeVisible();
  });

  test('selecting gaps offers to turn them into a plan', async ({ page, api }) => {
    const project = await firstProject(api);
    const report = await coverage(api, project.id);
    test.skip(!report.crawled, NOT_CRAWLED);
    test.skip(report.gaps.length === 0, 'This app has no coverage gaps — nothing to select.');

    await page.goto('/insights/coverage');

    // Stops short of pressing Propose: that writes plan items into the demo
    // project, and what must never break is the offer — the count, and the
    // button that names what it is about to do.
    await page.getByRole('checkbox', { name: `Select: ${report.gaps[0]!.title}` }).check();

    await expect(page.getByText('1 gap selected')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Propose 1 test' })).toBeEnabled();

    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByText('1 gap selected')).toHaveCount(0);
  });
});
