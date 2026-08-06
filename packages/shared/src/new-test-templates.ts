/**
 * What "+ new test" actually creates, per type (§8 editor).
 *
 * The registry implements a plugin for every TestType and the create API has
 * always accepted all nineteen — but the editor could only mint E2E, and a
 * naive picker over the enum would offer nineteen entries backed by nothing
 * but the enum's word. This module is the honest middle: a type appears in
 * the picker only when there is a template here, and
 * `packages/runner/src/plugins/new-test-templates.test.ts` holds each entry
 * to the only standard that matters — the type's own plugin must accept the
 * template's spec and code in `validate()`. The runnable truth is the plugin,
 * not the enum, and a scaffold the plugin rejects is a test that cannot run.
 *
 * Spec templates are minimal-but-real: the golden shapes the seed data uses
 * where one exists (API, ACCESSIBILITY, SECURITY_SMOKE), and the smallest
 * spec each plugin's schema accepts everywhere else. Values are ones that can
 * execute against a plain web app; where a type needs something the app
 * cannot supply — k6, a vault secret, a Maestro flow — the hint says so
 * before the file exists, instead of the first run saying it as a failure.
 */

import { TEST_TYPES, type TestType } from './constants';

export interface NewTestTemplate {
  /**
   * What the editor buffer holds and saves for this type: Playwright source
   * (`code`), or the JSON spec the plugin executes (`spec`). The hybrids
   * (CROSS_BROWSER, LOCALIZATION) are `code` — their source is what a person
   * iterates on, and their spec is seeded at create time because the editor's
   * one-buffer model cannot show both.
   */
  buffer: 'code' | 'spec';
  /** Appended to the slug: `.spec.ts` for code, a typed `.json` for specs. */
  fileSuffix: string;
  /** One honest line under the picker: what it does, and what it needs. */
  hint: string;
  /** Stored `code`. For spec-driven types this is a pointer, not a program. */
  code: string;
  /** Stored `spec`. Present exactly when the plugin's validate needs one. */
  spec?: unknown;
}

/** The scaffold every Playwright-driven type starts from. */
export const PLAYWRIGHT_NEW_TEST_CODE = `import { test, expect } from '@playwright/test';

test('describe what must be true', async ({ page }) => {
  await test.step('Set up the state under test', async () => {
    await page.goto('/');
  });

  await test.step('Assert something that could actually be wrong', async () => {
    await expect(page.getByRole('heading')).toBeVisible();
  });
});
`;

/** The seed data's voice for spec-driven placeholders, kept so the two agree. */
const specPointer = (label: string) =>
  `// ${label} tests are driven by \`spec\`, not source code.\n`;

/**
 * INTEGRATION and UNIT_GEN share the external-command plugin, so they share a
 * scaffold: run the project's own unit runner and read the JUnit it emits.
 */
const EXTERNAL_COMMAND_SPEC = {
  command: 'npx',
  args: ['vitest', 'run', '--reporter=junit', '--outputFile=report.xml'],
  reportPath: 'report.xml',
  reportFormat: 'junit-xml',
};

export const NEW_TEST_TEMPLATES: Partial<Record<TestType, NewTestTemplate>> = {
  E2E: {
    buffer: 'code',
    fileSuffix: '.spec.ts',
    hint: 'Playwright in a real browser — the default. Steps, then assertions.',
    code: PLAYWRIGHT_NEW_TEST_CODE,
  },
  SMOKE: {
    buffer: 'code',
    fileSuffix: '.spec.ts',
    hint: 'A fast Playwright check with a short timeout ceiling — is the app up at all?',
    code: PLAYWRIGHT_NEW_TEST_CODE,
  },
  INTEGRATION: {
    buffer: 'spec',
    fileSuffix: '.external.json',
    hint: 'Runs your own test tool (Vitest, pytest, Newman…) and reads its report. The command must exist on the runner.',
    code: specPointer('Integration'),
    spec: EXTERNAL_COMMAND_SPEC,
  },
  API: {
    buffer: 'spec',
    fileSuffix: '.api.json',
    hint: 'A JSON chain of HTTP requests with status, latency and body assertions. No browser.',
    code: specPointer('API'),
    spec: {
      variables: {},
      steps: [
        {
          name: 'The root responds',
          method: 'GET',
          path: '/',
          headers: {},
          assertions: { status: 200, maxLatencyMs: 2000 },
          extract: {},
        },
      ],
    },
  },
  VISUAL: {
    buffer: 'spec',
    fileSuffix: '.visual.json',
    hint: 'Screenshot a route and diff it against the stored baseline.',
    code: specPointer('Visual'),
    spec: {
      path: '/',
      fullPage: true,
      viewport: { width: 1280, height: 800 },
      maxDiffRatio: 0.002,
    },
  },
  ACCESSIBILITY: {
    buffer: 'spec',
    fileSuffix: '.a11y.json',
    hint: 'axe-core WCAG 2.1 AA scan over the routes you list.',
    code: specPointer('Accessibility'),
    spec: { routes: ['/'] },
  },
  LOAD: {
    buffer: 'spec',
    fileSuffix: '.load.json',
    hint: 'A k6 scenario gated on p95 latency and error rate. Needs k6 on the runner.',
    code: specPointer('Load'),
    spec: {
      scenario: { path: '/', method: 'GET', vus: 5, durationSeconds: 30 },
      thresholds: { p95Ms: 800, errorRate: 0.01 },
    },
  },
  SECURITY_SMOKE: {
    buffer: 'spec',
    fileSuffix: '.security.json',
    hint: 'Auth walls, IDOR probes and security headers — at least one list must be non-empty.',
    code: specPointer('Security smoke'),
    // headerPaths is the one check that runs against any app unmodified; the
    // other two lists are shown empty so their shape is discoverable in the
    // buffer rather than in the docs.
    spec: { authRequiredPaths: [], idorProbes: [], headerPaths: ['/'] },
  },
  UNIT_GEN: {
    buffer: 'spec',
    fileSuffix: '.unit.json',
    hint: 'Unit tests through your own runner — an external command plus the report it writes.',
    code: specPointer('Unit'),
    spec: EXTERNAL_COMMAND_SPEC,
  },
  CROSS_BROWSER: {
    buffer: 'code',
    fileSuffix: '.spec.ts',
    hint: 'This Playwright spec, run on Chromium, Firefox and WebKit.',
    code: PLAYWRIGHT_NEW_TEST_CODE,
    // The plugin defaults a missing spec to all three engines; seeding the
    // list anyway makes it visible and editable over the API.
    spec: { browsers: ['chromium', 'firefox', 'webkit'] },
  },
  LOCALIZATION: {
    buffer: 'code',
    fileSuffix: '.spec.ts',
    hint: 'This Playwright spec, run per locale and timezone. Seeded with en-US and de-DE — edit the locales via the API or CLI.',
    code: PLAYWRIGHT_NEW_TEST_CODE,
    // Required by the plugin (min 1 locale) and invisible in the code buffer,
    // so it is seeded here or the created test could never run.
    spec: { locales: [{ tag: 'en-US' }, { tag: 'de-DE', timezone: 'Europe/Berlin' }] },
  },
  EMAIL_OTP: {
    buffer: 'spec',
    fileSuffix: '.otp.json',
    hint: 'A real email-code sign-in. Needs a test mail sink (the demo store exposes /__mail).',
    code: specPointer('Email/OTP'),
    spec: {
      requestUrl: '/login',
      emailSelector: 'input[type=email]',
      requestSubmitSelector: 'button[type=submit]',
      mailboxUrl: '/__mail',
      codeSelector: 'input[name=code]',
      verifySubmitSelector: 'button[type=submit]',
      successSelector: '[data-testid=account]',
    },
  },
  DATABASE: {
    buffer: 'spec',
    fileSuffix: '.db.json',
    hint: 'SQL steps against Postgres, rolled back afterwards. Needs a DATABASE_URL vault secret.',
    code: specPointer('Database'),
    spec: {
      connectionSecretName: 'DATABASE_URL',
      steps: [
        {
          kind: 'sql',
          name: 'The database answers',
          sql: 'SELECT 1',
          expect: { rowCount: 1 },
        },
      ],
    },
  },
  CLI: {
    buffer: 'spec',
    fileSuffix: '.cli.json',
    hint: 'Spawn a command (never through a shell) and assert on exit code and output.',
    code: specPointer('CLI'),
    spec: {
      command: 'node',
      args: ['--version'],
      expect: { exitCode: 0, stdout: { matches: 'v\\d+' } },
    },
  },
  PROTOCOL: {
    buffer: 'spec',
    fileSuffix: '.protocol.json',
    hint: 'GraphQL, WebSocket, SSE or gRPC conversations — switch with the "protocol" field.',
    code: specPointer('Protocol'),
    spec: {
      protocol: 'GRAPHQL',
      endpoint: '/graphql',
      operations: [
        {
          name: 'The schema answers a trivial query',
          query: 'query { __typename }',
          assertions: { dataMatches: { __typename: 'Query' } },
        },
      ],
    },
  },
  CONTRACT: {
    buffer: 'spec',
    fileSuffix: '.contract.json',
    hint: 'Verify a live provider against a pact or its own OpenAPI document.',
    code: specPointer('Contract'),
    // Workspace-relative on purpose: the document ref rejects absolute paths,
    // and an https URL is the thing a person edits in, not a default.
    spec: { kind: 'openapi', specPath: 'openapi.json', methods: ['GET'] },
  },
  MUTATION: {
    buffer: 'spec',
    fileSuffix: '.mutation.json',
    hint: 'Runs the ecosystem’s mutation tool (Stryker by default) and gates on the score. Slow — scope it.',
    code: specPointer('Mutation'),
    spec: { tool: 'stryker', scope: [], minScore: 60 },
  },
  MOBILE: {
    buffer: 'spec',
    fileSuffix: '.mobile.json',
    hint: 'Native app flows via Maestro, Appium, Detox, Espresso or XCUITest — switch with "driver".',
    code: specPointer('Mobile'),
    spec: { driver: 'MAESTRO', flowPath: 'flows/smoke.yaml' },
  },
  PERFORMANCE: {
    buffer: 'spec',
    fileSuffix: '.perf.json',
    hint: 'Core Web Vitals against budgets — the median of several loads, not one sample.',
    code: specPointer('Performance'),
    spec: { path: '/', iterations: 5, budgets: { lcpMs: 2500, clsScore: 0.1 } },
  },
};

/**
 * What the picker offers, in the enum's own order. Derived, not listed twice:
 * a type is creatable exactly when it has a template above, and the runner's
 * template test fails the build if any entry's plugin is missing or rejects it.
 */
export const CREATABLE_TEST_TYPES: readonly TestType[] = TEST_TYPES.filter(
  (t) => t in NEW_TEST_TEMPLATES,
);

/**
 * Types whose editor buffer is the JSON spec rather than source. Typed as a
 * set of strings because the UI holds `test.type` as a string off the wire.
 */
export const SPEC_DRIVEN_TEST_TYPES: ReadonlySet<string> = new Set(
  CREATABLE_TEST_TYPES.filter((t) => NEW_TEST_TEMPLATES[t]!.buffer === 'spec'),
);

/** The tree-safe slug of a test name — one implementation for the dialog's preview and the create call. */
export const testFileSlug = (name: string, fallback = 'test'): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || fallback;
