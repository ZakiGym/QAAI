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

    /*
     * The redesign made the headline a serif percentage — "61% of proven
     * behaviour is asserted." — and moved the screen under the Insights h1.
     * Same claim, new sentence: the suite is counted against the untested
     * surfaces, with the gap total on the RANKED GAPS label.
     */
    await expect(page.getByText('of proven behaviour is asserted.')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: `Ranked gaps · ${report.totals.gaps}` }),
    ).toBeVisible();
  });

  test('every gap carries its evidence on the same screen', async ({ page, api }) => {
    const project = await firstProject(api);
    const report = await coverage(api, project.id);
    test.skip(!report.crawled, NOT_CRAWLED);
    test.skip(report.gaps.length === 0, 'This app has no coverage gaps — nothing to render.');

    await page.goto('/insights/coverage');

    /*
     * The redesign folded each gap's detail behind its title (a disclosure
     * button — the old cards printed evidence inline on every row). The claim
     * this test protects is unchanged: a gap's evidence is ON THIS SCREEN, one
     * click deep at most, never on another page.
     */
    const top = report.gaps[0]!;
    const title = page.getByRole('button', { name: top.title }).first();
    await expect(title).toBeVisible();
    await title.click();

    await expect(page.getByText('Why we think so', { exact: true }).first()).toBeVisible();
    for (const line of top.evidence.slice(0, 2)) {
      await expect(page.getByText(line, { exact: false }).first()).toBeVisible();
    }

    /*
     * Every gap still has evidence BEHIND its disclosure — asserted at the data
     * level now, because closed cards render nothing to count. A gap the API
     * ships without support is a gap nobody can act on, whatever the screen
     * does with it.
     */
    const cards = page.getByRole('checkbox', { name: /^Select: / });
    expect(await cards.count()).toBeGreaterThan(0);
    for (const gap of report.gaps) {
      expect(gap.evidence.length, `gap "${gap.title}" shipped with no evidence`).toBeGreaterThan(0);
    }
  });

  test('a gap explains its own rank when you open it', async ({ page, api }) => {
    const project = await firstProject(api);
    const report = await coverage(api, project.id);
    test.skip(!report.crawled, NOT_CRAWLED);
    test.skip(report.gaps.length === 0, 'This app has no coverage gaps — nothing to render.');

    const top = report.gaps[0]!;
    await page.goto('/insights/coverage');

    // The disclosure is the gap's own title now, and it stays the same control
    // when open — aria-expanded flipping on one element, not two buttons.
    const disclosure = page.getByRole('button', { name: top.title }).first();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');

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
