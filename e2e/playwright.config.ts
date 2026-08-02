import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * QAAI's dogfood suite.
 *
 * QAAI's own cockpit is a web application with a login, forms, tables, empty
 * states, keyboard shortcuts and 29 screens, and nothing tested any of it. This
 * is the suite that does — written the way the product's own generator prompt
 * says to write one: role- and label-based locators, no fixed sleeps, one
 * behaviour per test, assertions on what the user can actually see.
 *
 * It runs against a LIVE stack (web :3000, api :4000, demo :5050, Postgres,
 * Redis, worker), because a mocked cockpit proves nothing about the product.
 * `npm run dev` at the repo root brings all of it up.
 *
 * `__dirname`, not `import.meta.url`: the repo root has no "type": "module", so
 * Playwright loads this config as CommonJS and import.meta is a syntax error
 * there. Paths are absolute so the suite behaves the same from any CWD.
 */

const here = __dirname;

/** Where the cockpit is served. Override for a staging or container run. */
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
/** Where the API is served — the suite talks to it directly to find fixtures. */
export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4000';

/** The seeded demo account. Overridable so this can point at any environment. */
export const DEMO_EMAIL = process.env.E2E_EMAIL ?? 'owner@qaai.local';
export const DEMO_PASSWORD = process.env.E2E_PASSWORD ?? 'qaai-demo-password-1';

/** Signed-in browser state, produced once by fixtures/auth.setup.ts. */
export const STORAGE_STATE = path.join(here, '.auth', 'owner.json');

const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } };

export default defineConfig({
  testDir: here,
  outputDir: path.join(here, '.artifacts', 'test-results'),

  /*
   * One worker, deliberately.
   *
   * Every test in here shares ONE Postgres and ONE demo application. Saving a
   * test file, starting a run and overriding a verdict all mutate state another
   * spec can see, so parallel workers would produce exactly the kind of
   * order-dependent flake this product exists to diagnose. Correct and a little
   * slow beats fast and lying.
   */
  workers: 1,
  fullyParallel: false,

  // A dogfood suite that has to be retried to go green is telling you something.
  // Retries stay at zero locally so a flake is visible as a flake.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,

  // The cockpit polls several endpoints every 4s; this is generous for anything
  // genuinely working and short enough that a hang is reported, not sat on.
  timeout: 45_000,
  expect: { timeout: 10_000 },

  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(here, '.artifacts', 'html'), open: 'never' }],
  ],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // QAAI is a desktop cockpit — three-column grids, a resizable evidence
    // rail. Testing it at 1280x800 tests the layout people actually use.
    viewport: { width: 1280, height: 800 },
  },

  projects: [
    {
      name: 'setup',
      testDir: path.join(here, 'fixtures'),
      testMatch: /auth\.setup\.ts/,
      use: desktop,
    },
    {
      /*
       * Signed-out journeys. No storageState on purpose: these tests are about
       * what happens to somebody who is NOT signed in, and inheriting the
       * session would quietly make every one of them vacuous.
       */
      name: 'guest',
      testDir: path.join(here, 'tests'),
      testMatch: /auth\.spec\.ts/,
      use: desktop,
    },
    {
      name: 'app',
      testDir: path.join(here, 'tests'),
      testIgnore: /auth\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...desktop, storageState: STORAGE_STATE },
    },
  ],
});
