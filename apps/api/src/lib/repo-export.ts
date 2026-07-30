/**
 * Materialise a project into a real, committable Playwright repo.
 *
 * The tests live in the database; this turns them back into the tree a human
 * would have written by hand — `tests/**`, `fixtures/**`, a config, a package
 * manifest, a README — so "your tests are yours" is literally true. The exact
 * same tree backs both the credential-free zip export and the git push, so what
 * you download is byte-for-byte what would be pushed.
 *
 * Nothing secret is ever emitted. Secret NAMES appear in `.env.example` so a
 * reader knows what to supply; values stay in the vault, and `.gitignore` blocks
 * the files that would carry them.
 */

import { extname } from 'node:path';
import { FIXTURE_PREFIX } from '@qaai/shared';
import { prisma } from './prisma.js';

/** Path → file contents. A plain map keeps this trivially testable and diffable. */
export type RepoTree = Map<string, string>;

/** Spec-driven types keep their config in `spec`; there is no runnable source. */
const SPEC_DRIVEN = new Set(['API', 'ACCESSIBILITY', 'SECURITY_SMOKE', 'VISUAL', 'LOAD']);

/**
 * Normalise a DB filePath into a safe repo-relative path. filePath is partly
 * model-authored, so it is untrusted: anything that climbs out of the tree, is
 * absolute, or is a Windows drive path is rejected by the caller's guard.
 */
function safeRelPath(filePath: string): string | null {
  const cleaned = filePath.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  if (!cleaned || cleaned.includes('..') || /^[a-zA-Z]:/.test(cleaned)) return null;
  const segments = cleaned.split('/').filter((s) => s && s !== '.');
  if (segments.length === 0) return null;
  return segments.join('/');
}

/**
 * Force a path to be a file Playwright will actually collect.
 *
 * `testDir` only picks up `*.spec.ts` / `*.test.ts`, so anything else has the
 * suffix appended rather than trusted. This matters for the spec-driven types:
 * their stems look like `storefront.a11y`, whose `.a11y` reads as an extension —
 * appending unconditionally is what keeps those tests discoverable.
 */
function withSpecExt(path: string): string {
  return /\.(spec|test)\.[cm]?[jt]sx?$/.test(path) ? path : `${path}.spec.ts`;
}

/**
 * Ensure two tests never collide on one path: `a.spec.ts` → `a-2.spec.ts`.
 *
 * The compound suffix has to be treated as one unit. `extname` only sees the
 * last dot, so splitting on it would yield `a.spec-2.ts` — which no longer
 * matches Playwright's `*.spec.ts` collection pattern, silently dropping the
 * de-duplicated test from the exported repo.
 */
function uniquePath(tree: RepoTree, path: string): string {
  if (!tree.has(path)) return path;

  const compound = /(\.(?:spec|test)\.[cm]?[jt]sx?)$/.exec(path);
  const ext = compound ? compound[1]! : extname(path);
  const stem = ext ? path.slice(0, -ext.length) : path;

  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!tree.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

const PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test';

/**
 * Environment-agnostic on purpose: the base URL comes from QAAI_BASE_URL, so the
 * same repo runs against local, staging, or production without an edit.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  use: {
    baseURL: process.env.QAAI_BASE_URL ?? 'http://localhost:3000',
    storageState: process.env.QAAI_STORAGE_STATE || undefined,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
});
`;

const GITIGNORE = `node_modules/
test-results/
playwright-report/
artifacts/

# Runtime credentials — never commit these.
.env
storage-state.json
`;

function packageJson(slug: string): string {
  return `${JSON.stringify(
    {
      name: `${slug}-tests`,
      private: true,
      type: 'module',
      scripts: {
        test: 'playwright test',
        'test:headed': 'playwright test --headed',
        report: 'playwright show-report',
      },
      devDependencies: {
        '@playwright/test': '^1.56.0',
        '@axe-core/playwright': '^4.10.0',
      },
    },
    null,
    2,
  )}\n`;
}

function readme(projectName: string, secretNames: string[]): string {
  const secretLines = secretNames.length
    ? secretNames.map((n) => `- \`${n}\``).join('\n')
    : '_none configured_';
  return `# ${projectName} — tests

Exported from QAAI. These are plain Playwright tests with no QAAI runtime
dependency: clone, install, run.

\`\`\`bash
npm install
npx playwright install
QAAI_BASE_URL=https://your-app.example.com npm test
\`\`\`

## Layout

| Path | What |
| --- | --- |
| \`tests/\` | The test specs. |
| \`fixtures/\` | Test data the specs read. |
| \`playwright.config.ts\` | Reads \`QAAI_BASE_URL\`, so one repo serves every environment. |

## Credentials

No secret values are in this repo. Tests read them from the environment; the
names they expect are:

${secretLines}

See \`.env.example\`. Values live in the QAAI vault (encrypted) — supply them via
your CI secret store or a local \`.env\`, which \`.gitignore\` already excludes.
`;
}

function envExample(secretNames: string[]): string {
  const lines = [
    '# Copy to .env and fill in. Never commit the filled-in file.',
    'QAAI_BASE_URL=http://localhost:3000',
    '# Optional: a Playwright storageState JSON path for pre-authenticated runs.',
    '# QAAI_STORAGE_STATE=./storage-state.json',
    '',
    ...secretNames.map((n) => `${n}=`),
  ];
  return `${lines.join('\n')}\n`;
}

export interface BuildRepoOptions {
  projectId: string;
}

export interface RepoBuild {
  tree: RepoTree;
  projectName: string;
  /** Secret names referenced by the project's environments (values excluded). */
  secretNames: string[];
  skipped: Array<{ filePath: string; why: string }>;
}

export async function buildRepoTree({ projectId }: BuildRepoOptions): Promise<RepoBuild> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, slug: true },
  });
  if (!project) throw new Error('Project not found');

  const [tests, environments] = await Promise.all([
    prisma.test.findMany({
      where: { projectId, disabledAt: null },
      orderBy: { filePath: 'asc' },
      select: { id: true, name: true, type: true, code: true, spec: true, filePath: true },
    }),
    prisma.environment.findMany({
      where: { projectId },
      select: { secrets: { select: { name: true } } },
    }),
  ]);

  const secretNames = [
    ...new Set(environments.flatMap((e) => e.secrets.map((s) => s.name))),
  ].sort();

  const tree: RepoTree = new Map();
  const skipped: Array<{ filePath: string; why: string }> = [];

  for (const test of tests) {
    const rel = safeRelPath(test.filePath);
    if (!rel) {
      skipped.push({ filePath: test.filePath, why: 'unsafe path' });
      continue;
    }

    // Fixtures keep their own top-level folder and their literal content.
    if (rel.startsWith(FIXTURE_PREFIX)) {
      const body =
        test.spec !== null && test.spec !== undefined
          ? `${JSON.stringify(test.spec, null, 2)}\n`
          : test.code;
      tree.set(uniquePath(tree, rel), body);
      continue;
    }

    if (SPEC_DRIVEN.has(test.type)) {
      // Config as JSON under fixtures/, plus a loader so `playwright test` still
      // exercises it rather than the export quietly losing the test.
      const jsonPath = uniquePath(tree, `fixtures/${rel.replace(/\.[^./]+$/, '')}.json`);
      tree.set(jsonPath, `${JSON.stringify(test.spec ?? {}, null, 2)}\n`);
      const specPath = uniquePath(tree, `tests/${withSpecExt(rel.replace(/\.[^./]+$/, ''))}`);
      tree.set(specPath, specLoader(specPath, jsonPath, test.name, test.type));
      continue;
    }

    tree.set(uniquePath(tree, `tests/${withSpecExt(rel)}`), test.code);
  }

  tree.set('playwright.config.ts', PLAYWRIGHT_CONFIG);
  tree.set('package.json', packageJson(project.slug));
  tree.set('.gitignore', GITIGNORE);
  tree.set('.env.example', envExample(secretNames));
  tree.set('README.md', readme(project.name, secretNames));

  return { tree, projectName: project.name, secretNames, skipped };
}

/**
 * A generated spec that loads a JSON config and asserts it. Deliberately simple
 * and dependency-free: it documents the intent and keeps the test runnable
 * outside QAAI, rather than pretending to reimplement the plugin.
 */
function specLoader(specPath: string, jsonPath: string, testName: string, type: string): string {
  const depth = specPath.split('/').length - 1;
  const toRoot = '../'.repeat(depth);
  return `import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ${type} test exported from QAAI. Its configuration lives in
 * ${jsonPath} — QAAI runs this with its ${type} plugin; here it is executed as a
 * plain HTTP/assertion check so the repo stands on its own.
 */
const spec = JSON.parse(
  readFileSync(fileURLToPath(new URL('${toRoot}${jsonPath}', import.meta.url)), 'utf8'),
);

test(${JSON.stringify(testName)}, async ({ request, baseURL }) => {
  const steps = Array.isArray(spec.steps) ? spec.steps : [];
  test.skip(steps.length === 0, 'No steps in the exported spec');

  for (const step of steps) {
    const url = String(step.path ?? '/').startsWith('http')
      ? String(step.path)
      : new URL(String(step.path ?? '/'), baseURL ?? 'http://localhost:3000').toString();

    const response = await request.fetch(url, {
      method: String(step.method ?? 'GET'),
      headers: step.headers ?? {},
      ...(step.body === undefined ? {} : { data: step.body }),
    });

    if (step.assertions?.status !== undefined) {
      expect(response.status(), step.name ?? url).toBe(step.assertions.status);
    }
  }
});
`;
}
