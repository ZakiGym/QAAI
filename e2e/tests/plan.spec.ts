import { test as base, expect, API_URL, type ProjectLite } from '../fixtures/qaai';

/**
 * The plan screen when there is no plan.
 *
 * This page is reached three ways — the fleet tile on /runs, a run card, and
 * the editor's "Review the test plan →" — and every one of them is a person who
 * ALREADY has an app. Its 404 branch nevertheless said "Run the Explorer" and
 * linked /onboarding, which is the add-a-NEW-app funnel: the recovery from "this
 * app has no plan" was an invitation to create a second app, and nothing on that
 * path ever comes back here.
 *
 * So the assertions are about where the recovery points. A button labelled "Run
 * the Explorer" is not evidence of anything on its own — the broken version had
 * one — which is why the test follows the click down to the request and reads
 * the project id out of its URL.
 */

interface Scratch extends ProjectLite {
  environmentId: string | null;
}

/**
 * A brand-new project, created and archived through the API.
 *
 * It has no plan for the same reason a real one wouldn't: nothing has crawled
 * it. Making the fixture rather than hunting for a planless project in the demo
 * data matters — every seeded project HAS a plan, so a found-fixture version of
 * this spec would skip itself on every machine and prove nothing.
 *
 * `withEnvironment` is the fork the screen turns on. POST /projects creates no
 * environment, so the two states are one API call apart.
 */
function planlessProject(withEnvironment: boolean) {
  return base.extend<{ scratch: Scratch }>({
    scratch: async ({ api }, use) => {
      const stamp = Date.now();
      const created = await api.post(`${API_URL}/projects`, {
        data: {
          name: `Dogfood planless ${withEnvironment ? 'env' : 'bare'} ${stamp}`,
          primaryFramework: 'PLAYWRIGHT',
        },
      });
      expect(
        created.ok(),
        `Could not create a project (${created.status()}). If this is a plan limit, the demo org has run out of project slots.`,
      ).toBeTruthy();
      const { project } = (await created.json()) as { project: ProjectLite };

      let environmentId: string | null = null;
      if (withEnvironment) {
        // The demo app, which is what the rest of the suite crawls — so if this
        // click really does start the Explorer, it starts it against something
        // real rather than against a URL that would error in the worker.
        const env = await api.post(`${API_URL}/projects/${project.id}/environments`, {
          data: { name: 'staging', kind: 'STAGING', baseUrl: 'http://localhost:5050' },
        });
        expect(env.ok(), `Could not add an environment (${env.status()})`).toBeTruthy();
        const { environment } = (await env.json()) as { environment: { id: string } };
        environmentId = environment.id;
      }

      await use({ ...project, environmentId });

      /*
       * Archived whether or not the test passed, and checked rather than fired
       * and forgotten: an unchecked teardown quietly leaves a throwaway app in
       * somebody's fleet, where it shows up on /runs forever as an app that has
       * never run anything. Soft, so a cleanup problem is reported without
       * being mistaken for the failure the test was about.
       */
      const removed = await api.delete(`${API_URL}/projects/${project.id}`);
      expect
        .soft(
          removed.ok(),
          `Could not clean up ${project.name} (${removed.status()}). Archive it from Settings.`,
        )
        .toBeTruthy();
    },
  });
}

const withEnv = planlessProject(true);
const withoutEnv = planlessProject(false);

withEnv.describe('a project with no plan, but somewhere to crawl', () => {
  withEnv(
    'recovers by exploring THIS project, and never sends you to the add-an-app funnel',
    async ({ page, scratch }) => {
      await page.goto(`/projects/${scratch.id}/plan`);

      /*
       * Scoped to `main`: the sidebar's Setup section carries an "Add app" link
       * to /onboarding, so an unscoped assertion about that href would fail on
       * a page that is behaving perfectly.
       */
      const main = page.getByRole('main');

      const explore = main.getByRole('button', { name: /Run the Explorer/ });
      await expect(explore).toBeVisible();
      await expect(main.locator('a[href="/onboarding"]')).toHaveCount(0);

      /*
       * The claim under test. The old page had a control with this exact label
       * and it went to /onboarding, so the label proves nothing — the request
       * does. Registered before the click, because a 202 can land first.
       */
      const posted = page.waitForRequest(
        (request) =>
          request.method() === 'POST' && /\/projects\/[^/]+\/explore$/.test(request.url()),
      );
      await explore.click();
      const request = await posted;

      expect(
        new URL(request.url()).pathname,
        'The recovery started the Explorer on a different project than the one in the URL.',
      ).toBe(`/projects/${scratch.id}/explore`);
      expect(JSON.parse(request.postData() ?? '{}')).toMatchObject({
        environmentId: scratch.environmentId,
      });

      // Still here, on this project's plan, being told what is happening —
      // rather than parked in a funnel for an app that does not exist yet.
      await expect(page).toHaveURL(new RegExp(`/projects/${scratch.id}/plan`));
      await expect(main.getByRole('status')).toContainText(/Crawling your app/);
    },
  );
});

withoutEnv.describe('a project with no plan and nowhere to crawl', () => {
  withoutEnv('is sent to add an environment, not to add another app', async ({ page, scratch }) => {
    await page.goto(`/projects/${scratch.id}/plan`);

    const main = page.getByRole('main');

    /*
     * The Explorer needs a running copy of the app. Offering to start it here
     * would be the same lie in a new place, so the screen has to ask for the
     * missing piece instead — and the missing piece is an environment for THIS
     * app, which is not what /onboarding creates.
     */
    await expect(main.getByRole('link', { name: 'Add an environment' })).toHaveAttribute(
      'href',
      '/environments',
    );
    await expect(main.getByRole('button', { name: /Run the Explorer/ })).toHaveCount(0);
    await expect(main.locator('a[href="/onboarding"]')).toHaveCount(0);
  });
});
