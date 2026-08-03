import { test as setup, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { API_URL, BASE_URL, DEMO_EMAIL, DEMO_PASSWORD, STORAGE_STATE } from '../playwright.config';

/**
 * Sign in once, and hand the session to every other spec.
 *
 * Through the real form rather than by POSTing to /auth/login: the whole point
 * of a dogfood suite is that the path most people take is the path it exercises,
 * and a setup step that bypasses the login form cannot notice the login form
 * breaking. It costs about a second.
 */
setup('sign in as the demo owner', async ({ page }) => {
  await assertStackIsUp();

  fs.mkdirSync(path.dirname(STORAGE_STATE), { recursive: true });

  await page.goto('/login');

  await page.getByLabel('Email address').fill(DEMO_EMAIL);
  await page.getByLabel('Password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  /*
   * The user-visible outcome of signing in: the runs list, not a URL change.
   *
   * This used to look for a "Projects" heading. The redesign merged the old
   * /dashboard into Runs home, and the project tiles became a FLEET section
   * under an h1 of "Runs" — so the heading it waited for no longer exists. The
   * assertion is the same one, pointed at what the screen says now.
   */
  await expect(page.getByRole('heading', { name: 'Runs', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/runs$/);

  await page.context().storageState({ path: STORAGE_STATE });
});

/**
 * Fail loudly and usefully when the stack is not up.
 *
 * Without this the first symptom is `net::ERR_CONNECTION_REFUSED` on a
 * `page.goto`, repeated once per test, and the actionable sentence — "start the
 * stack" — is nowhere in the output.
 */
async function assertStackIsUp(): Promise<void> {
  const probes: Array<[string, string]> = [
    ['web', BASE_URL],
    ['api', `${API_URL}/health`],
  ];

  for (const [name, url] of probes) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`);
      }
    } catch (cause) {
      throw new Error(
        `The QAAI ${name} service is not answering at ${url} (${(cause as Error).message}). ` +
          `The dogfood suite runs against a live stack — start it with \`npm run dev\` at the repo ` +
          `root, or point the suite elsewhere with E2E_BASE_URL / E2E_API_URL.`,
      );
    }
  }
}
