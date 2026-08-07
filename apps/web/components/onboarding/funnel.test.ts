import { describe, expect, it } from 'vitest';
import {
  CREATABLE_TEST_TYPES,
  FRAMEWORKS_BY_LANGUAGE,
  LANGUAGES,
  createProjectSchema,
  detectProject,
  isSupportedPair,
  type RepoFile,
} from '@qaai/shared';
import {
  MAX_LISTED_FILES,
  UPLOAD_MAX_CONTENT_BYTES,
  UPLOAD_MAX_FILES,
  uploadPayload,
  PATH_CHOICES,
  DEFAULT_TEST_TYPES,
  frameworksFor,
  nameFromPaths,
  readRepo,
  reconcileFramework,
  shouldList,
  shouldRead,
  splitByModelNeed,
  suggestStack,
  testTypeChoices,
  type RepoPick,
} from './funnel';

/**
 * The first-run funnel's decisions.
 *
 * The screen this replaces shipped a first-screen option that could not be
 * submitted — Selenium, with the language defaulted to TypeScript, which
 * `createProjectSchema` rejects. So the load-bearing test here is not that the
 * dropdowns render: it is that every pair the funnel can produce SURVIVES the
 * schema the API validates with. That is asserted against the real schema, not
 * against a copy of its rule.
 */

/** A File stand-in — jsdom is not installed and this needs three properties. */
function fakeFile(content: string): File {
  return { size: content.length, __content: content } as unknown as File;
}

const readFake = (file: File) =>
  Promise.resolve((file as unknown as { __content: string }).__content);

const pick = (path: string, content = ''): RepoPick => ({ path, file: fakeFile(content) });

describe('step 1 — the four paths', () => {
  it('offers exactly one headline path', () => {
    expect(PATH_CHOICES.filter((choice) => choice.headline)).toHaveLength(1);
    expect(PATH_CHOICES.find((choice) => choice.headline)?.id).toBe('codebase');
  });

  it('has a distinct id per choice', () => {
    expect(new Set(PATH_CHOICES.map((c) => c.id)).size).toBe(PATH_CHOICES.length);
  });
});

describe('shouldList — what a folder pick hands to detection', () => {
  it('keeps ordinary source files', () => {
    expect(shouldList('src/app/page.tsx')).toBe(true);
    expect(shouldList('package.json')).toBe(true);
    expect(shouldList('services/api/pyproject.toml')).toBe(true);
  });

  it('drops dependency and build directories at any depth', () => {
    expect(shouldList('node_modules/react/index.js')).toBe(false);
    expect(shouldList('apps/web/node_modules/react/index.js')).toBe(false);
    expect(shouldList('packages/ui/dist/bundle.js')).toBe(false);
    expect(shouldList('.git/config')).toBe(false);
    expect(shouldList('services/api/.venv/lib/foo.py')).toBe(false);
  });

  it('drops lockfiles, whose contents detection never reads', () => {
    expect(shouldList('package-lock.json')).toBe(false);
    expect(shouldList('pnpm-lock.yaml')).toBe(false);
    expect(shouldList('Gemfile.lock')).toBe(false);
    // The manifest beside it stays — the lockfile is the derived one.
    expect(shouldList('Gemfile')).toBe(true);
  });

  it('drops binaries, which read as text produce nothing but noise', () => {
    expect(shouldList('public/logo.png')).toBe(false);
    expect(shouldList('assets/font.woff2')).toBe(false);
    expect(shouldList('vendor.zip')).toBe(false);
  });
});

describe('shouldRead — content only where detection needs it', () => {
  it('reads manifests', () => {
    expect(shouldRead('package.json')).toBe(true);
    expect(shouldRead('apps/api/pom.xml')).toBe(true);
    expect(shouldRead('go.mod')).toBe(true);
    expect(shouldRead('pytest.ini')).toBe(true);
  });

  it('does not read application source', () => {
    expect(shouldRead('src/app/page.tsx')).toBe(false);
    expect(shouldRead('playwright.config.ts')).toBe(false);
  });
});

describe('readRepo', () => {
  it('reads manifests and lists everything else by path alone', async () => {
    const result = await readRepo(
      [
        pick('package.json', '{"name":"shop","devDependencies":{"vitest":"^2"}}'),
        pick('src/index.ts', 'export const a = 1;'),
        pick('src/index.test.ts', 'it("works", () => {});'),
      ],
      readFake,
    );

    expect(result.read).toBe(1);
    expect(result.files).toHaveLength(3);
    expect(result.files.find((f) => f.path === 'package.json')?.content).toContain('vitest');
    expect(result.files.find((f) => f.path === 'src/index.ts')?.content).toBeUndefined();
  });

  it('never opens a file inside a skipped directory', async () => {
    const result = await readRepo(
      [pick('package.json', '{}'), pick('node_modules/left-pad/package.json', '{}')],
      readFake,
    );

    expect(result.files.map((f) => f.path)).toEqual(['package.json']);
    expect(result.read).toBe(1);
    expect(result.seen).toBe(2);
  });

  /*
   * The truncation bug this guards: an alphabetical cut at the cap can drop a
   * repo's package.json, and detection then reports a JavaScript repo with no
   * package manager and no dependencies. Manifests are taken before the cap.
   */
  it('keeps manifests even when the listing is truncated', async () => {
    const many = Array.from({ length: MAX_LISTED_FILES + 50 }, (_, i) =>
      pick(`src/zz-${String(i).padStart(6, '0')}.ts`),
    );
    const result = await readRepo([...many, pick('package.json', '{"name":"big"}')], readFake);

    expect(result.truncated).toBe(true);
    expect(result.files.some((f) => f.path === 'package.json' && f.content === '{"name":"big"}')).toBe(
      true,
    );
    expect(result.files).toHaveLength(MAX_LISTED_FILES + 1);
  });
});

describe('suggestStack — the pre-selection, and the reason for it', () => {
  it('takes the configured runner over a raw file count', () => {
    const files: RepoFile[] = [
      { path: 'package.json', content: '{"devDependencies":{"cypress":"^13"}}' },
      { path: 'cypress.config.ts', content: '' },
      { path: 'cypress/e2e/checkout.cy.ts', content: '' },
      { path: 'src/app.ts', content: '' },
    ];
    const suggestion = suggestStack(detectProject(files));

    expect(suggestion).not.toBeNull();
    expect(suggestion!.framework).toBe('CYPRESS');
    // The "why" has to be a fact from the repo, not the word "detected".
    expect(suggestion!.why).toMatch(/cypress\.config\.ts|cypress/i);
  });

  it('falls back to the dominant language when no runner is configured', () => {
    const files: RepoFile[] = [
      { path: 'pyproject.toml', content: '[project]\nname = "shop"\n' },
      { path: 'shop/views.py', content: '' },
      { path: 'shop/models.py', content: '' },
    ];
    const suggestion = suggestStack(detectProject(files));

    expect(suggestion?.language).toBe('PYTHON');
    expect(suggestion?.framework).toBe('PLAYWRIGHT');
  });

  it('suggests nothing for a repo in a language the generator cannot emit', () => {
    const files: RepoFile[] = [
      { path: 'Cargo.toml', content: '[package]\nname = "engine"\n' },
      { path: 'src/main.rs', content: '' },
      { path: 'src/lib.rs', content: '' },
    ];
    // Silence, not a confident TypeScript guess with a sentence under it.
    expect(suggestStack(detectProject(files))).toBeNull();
  });

  it('never suggests a pair the API would refuse', () => {
    const repos: RepoFile[][] = [
      [{ path: 'Gemfile', content: "source 'https://rubygems.org'\ngem 'rspec'\n" }],
      [{ path: 'go.mod', content: 'module shop\n' }, { path: 'main_test.go', content: '' }],
      [{ path: 'composer.json', content: '{"require-dev":{"phpunit/phpunit":"^11"}}' }],
      [{ path: 'pom.xml', content: '<project><artifactId>shop</artifactId></project>' }],
    ];

    for (const files of repos) {
      const suggestion = suggestStack(detectProject(files));
      if (!suggestion) continue;
      expect(isSupportedPair(suggestion.language, suggestion.framework)).toBe(true);
    }
  });
});

describe('the pair rule, mirrored client-side', () => {
  /*
   * The bug on the screen this replaces: the framework list was a local const
   * of three entries including SELENIUM, the request omitted the language, the
   * schema defaulted it to TYPESCRIPT, and the pair rule rejected it. One of
   * three options on the product's first screen was unsubmittable.
   */
  it('every offered pair passes createProjectSchema', () => {
    for (const language of LANGUAGES) {
      for (const framework of frameworksFor(language)) {
        const parsed = createProjectSchema.safeParse({
          name: 'Acme',
          primaryLanguage: language,
          primaryFramework: framework,
        });
        expect(parsed.success, `${language} + ${framework}`).toBe(true);
      }
    }
  });

  it('offers at least one framework for every language', () => {
    for (const language of LANGUAGES) expect(frameworksFor(language).length).toBeGreaterThan(0);
  });

  it('moves the framework when the language stops supporting it', () => {
    expect(reconcileFramework('RUBY', 'PLAYWRIGHT')).toBe('CAPYBARA');
    expect(reconcileFramework('TYPESCRIPT', 'CYPRESS')).toBe('CYPRESS');
    // The default is the language's own first entry, not a hard-coded one.
    expect(reconcileFramework('PHP', 'PLAYWRIGHT')).toBe(FRAMEWORKS_BY_LANGUAGE.PHP[0]);
  });
});

describe('step 3 — the test types', () => {
  it('offers exactly the types the editor can mint', () => {
    expect(testTypeChoices().map((c) => c.type)).toEqual([...CREATABLE_TEST_TYPES]);
  });

  it('gives every choice the template hint that says what it needs', () => {
    for (const choice of testTypeChoices()) expect(choice.hint.length).toBeGreaterThan(0);
  });

  it('defaults to smoke and e2e, and both are creatable', () => {
    expect(DEFAULT_TEST_TYPES).toEqual(['SMOKE', 'E2E']);
    for (const type of DEFAULT_TEST_TYPES) expect(CREATABLE_TEST_TYPES).toContain(type);
  });

  it('marks the six a crawl can fill as model-free and nothing else', () => {
    const free = testTypeChoices()
      .filter((c) => c.modelFree)
      .map((c) => c.type)
      .sort();
    expect(free).toEqual(
      ['ACCESSIBILITY', 'API', 'LOAD', 'PERFORMANCE', 'SECURITY_SMOKE', 'VISUAL'].sort(),
    );
  });

  it('splits a selection into what runs without a key and what waits for one', () => {
    const split = splitByModelNeed(['SMOKE', 'E2E', 'API', 'ACCESSIBILITY']);
    expect(split.modelFree).toEqual(['API', 'ACCESSIBILITY']);
    expect(split.needsModel).toEqual(['SMOKE', 'E2E']);
  });
});

describe('nameFromPaths', () => {
  it('names the app after the dropped folder', () => {
    expect(nameFromPaths(['acme-storefront/package.json'])).toBe('acme storefront');
  });

  it('ignores a flat pick, where the first segment is a filename', () => {
    expect(nameFromPaths(['index.ts', 'README.md'])).toBeNull();
  });
});

/**
 * The upload's caps exist to match limits that live in ANOTHER package, so what
 * is asserted here is the relationship, not the numbers. If someone raises the
 * API's `express.json` limit these can rise with it; if someone lowers the
 * route's MAX_FILES and forgets this file, that is what these catch.
 *
 * The values they are pinned against, in apps/api:
 *   - src/index.ts       express.json({ limit: '2mb' })
 *   - src/routes/source.ts  MAX_FILES = 5000, MAX_TOTAL_BYTES = 5MB
 */
describe('uploadPayload', () => {
  const paths = (n: number, prefix = 'src/file'): RepoFile[] =>
    Array.from({ length: n }, (_, i) => ({ path: `${prefix}${i}.ts` }));

  it('sends a normal repo through untouched', () => {
    const files: RepoFile[] = [
      { path: 'package.json', content: '{"name":"shop"}' },
      ...paths(300),
    ];
    const result = uploadPayload(files);
    expect(result.files).toEqual(files);
    expect(result.droppedFiles).toBe(0);
    expect(result.droppedContent).toBe(0);
  });

  it('never sends more files than the route accepts', () => {
    const result = uploadPayload(paths(40_000));
    expect(result.files.length).toBeLessThanOrEqual(UPLOAD_MAX_FILES);
    expect(result.droppedFiles).toBe(40_000 - result.files.length);
  });

  it('keeps the JSON body clear of the 2MB express limit', () => {
    // Deep paths, because the encoded size is dominated by path length once
    // the count is capped — a flat `a0.ts` listing would pass by luck.
    const deep = Array.from({ length: 40_000 }, (_, i) => ({
      path: `packages/some-workspace/src/components/nested/deeply/Component${i}.tsx`,
    }));
    const encoded = JSON.stringify({ files: uploadPayload(deep).files });
    expect(new TextEncoder().encode(encoded).length).toBeLessThan(2 * 1024 * 1024);
  });

  it('keeps manifests and drops listing, not the other way round', () => {
    // The manifest is LAST, so a naive slice would lose it.
    const files: RepoFile[] = [
      ...paths(10_000),
      { path: 'package.json', content: '{"name":"shop"}' },
    ];
    const result = uploadPayload(files);
    expect(result.files).toContainEqual({ path: 'package.json', content: '{"name":"shop"}' });
  });

  it('degrades an oversized manifest to a path rather than dropping it', () => {
    const huge = 'x'.repeat(UPLOAD_MAX_CONTENT_BYTES + 1);
    const result = uploadPayload([
      { path: 'package.json', content: '{"name":"shop"}' },
      { path: 'generated/schema.json', content: huge },
    ]);
    expect(result.files).toContainEqual({ path: 'generated/schema.json' });
    expect(result.droppedContent).toBe(1);
    // The real manifest still went first, with its content intact.
    expect(result.files[0]).toEqual({ path: 'package.json', content: '{"name":"shop"}' });
  });

  it('reports the trim so the funnel can say so', () => {
    const result = uploadPayload(paths(6_000));
    expect(result.droppedFiles).toBeGreaterThan(0);
  });
});
