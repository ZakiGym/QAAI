import { test, expect } from '../fixtures/qaai';
import { DEMO_EMAIL, DEMO_PASSWORD } from '../playwright.config';

/**
 * Getting in, and being kept out.
 *
 * These run in the `guest` project — no stored session — because every one of
 * them is about somebody who is not signed in yet, and inheriting the shared
 * session would make them all pass without proving anything.
 */

test.describe('signing in', () => {
  test('a signed-out visitor asking for the runs list is sent to sign in', async ({ page }) => {
    await page.goto('/runs');

    // The screens guard themselves client-side: /runs asks the API, gets a 401
    // and pushes to /login. The user-visible outcome is the sign-in form.
    await expect(page.getByRole('heading', { name: 'Sign in to QAAI' })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('the demo account signs in and lands on the runs list', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel('Email address').fill(DEMO_EMAIL);
    await page.getByLabel('Password').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    /*
     * Runs home absorbed /dashboard in the redesign: the "Projects" and "Recent
     * runs" headings became a FLEET section and a RUN LOG section under one h1.
     * Still asserting two things — you landed on Runs, and the run log is really
     * there — against what the screen renders now.
     */
    await expect(page.getByRole('heading', { name: 'Runs', level: 1 })).toBeVisible();
    await expect(page.getByText('RUN LOG')).toBeVisible();
  });

  test('a wrong password is reported and does not let anybody through', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel('Email address').fill(DEMO_EMAIL);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // Announced, not just coloured red — the form marks it role="alert".
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('signing out', () => {
  test('signing out ends the session and the runs list is closed again', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email address').fill(DEMO_EMAIL);
    await page.getByLabel('Password').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Runs', level: 1 })).toBeVisible();

    /*
     * The account menu moved. It hung off an "Account" button in the top bar;
     * the redesign deleted the top bar entirely and put the user row at the
     * foot of the sidebar, which is what opens the same menu now.
     */
    await page.getByRole('button', { name: /Demo Owner|Account/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();

    await expect(page.getByRole('heading', { name: 'Sign in to QAAI' })).toBeVisible();

    // Signed out means signed out: coming back to a protected screen must not
    // work. A sign-out that only navigates away leaves the session alive.
    await page.goto('/runs');
    await expect(page.getByRole('heading', { name: 'Sign in to QAAI' })).toBeVisible();
  });
});
