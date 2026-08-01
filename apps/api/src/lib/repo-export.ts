/**
 * Materialise a project into a real, committable repo — in the ecosystem the
 * tests were actually written in.
 *
 * The tests live in the database; this turns them back into the tree a human
 * would have written by hand — the runner's own test root, its manifest, its
 * config, a README — so "your tests are yours" is literally true. The exact same
 * tree backs both the credential-free zip export and the git push, so what you
 * download is byte-for-byte what would be pushed.
 *
 * QAAI writes tests for 39 ecosystems, so "a repo" cannot mean "a Playwright
 * repo". A pytest project wants tests/…/test_x.py beside a requirements.txt, a
 * Maven project wants src/test/java beside a pom.xml, and prefixing either with
 * `tests/` and dropping a playwright.config.ts next to it produces a tree that
 * cannot run. Two rules keep this honest:
 *
 *  1. The path convention is READ from the generator, never restated here. The
 *     same function that decided what is in `Test.filePath` decides where the
 *     file goes and whether it already carries its root — a second copy of those
 *     rules in this file is exactly how the `tests/tests/` bug happened.
 *  2. A manifest we cannot produce faithfully is not produced at all. The README
 *     says what is missing and how to supply it, because an export that looks
 *     complete and is not is worse than one that admits the gap.
 *
 * Nothing secret is ever emitted. Secret NAMES appear in `.env.example` so a
 * reader knows what to supply; values stay in the vault, and `.gitignore` blocks
 * the files that would carry them.
 */

import { extname } from 'node:path';
import { ECOSYSTEMS as GENERATOR_ECOSYSTEMS, resolveEcosystem } from '@qaai/agent';
import type {
  Ecosystem as GeneratorEcosystem,
  EcosystemId as GeneratorEcosystemId,
} from '@qaai/agent';
import { FIXTURE_PREFIX, ecosystemById, resolveEcosystemCommand } from '@qaai/shared';
import type {
  Ecosystem as RunnerEcosystem,
  EcosystemId as RunnerEcosystemId,
  Language,
  PackageManager,
  TestType,
  UiFramework,
} from '@qaai/shared';
import { prisma } from './prisma.js';

/** Path → file contents. A plain map keeps this trivially testable and diffable. */
export type RepoTree = Map<string, string>;

/** Spec-driven types keep their config in `spec`; there is no runnable source. */
const SPEC_DRIVEN = new Set<TestType>(['API', 'ACCESSIBILITY', 'SECURITY_SMOKE', 'VISUAL', 'LOAD']);

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

// ─── The convention, read from the generator ─────────────────────────────────

/**
 * Where an ecosystem's tests live, and what its filenames end with.
 *
 * Both facts already exist — `ECOSYSTEMS[id].path` in @qaai/agent produced every
 * path in the database — so they are derived from that function rather than
 * written down a second time. Everything a generated path does NOT owe to the
 * feature is the root; everything it does not owe to the title is the suffix.
 * Two probe names with no characters in common answer both questions, and a new
 * ecosystem is covered the day it is added instead of the day someone notices.
 */
interface Convention {
  /** '' for an ecosystem whose tests sit at the repo root (Go, Playwright TS). */
  root: string;
  /** '.spec.ts', '_test.go', 'Test.java' — whatever the runner collects. */
  suffix: string;
}

const PROBE_A = 'aaa';
const PROBE_B = 'zzz';

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  // Cut back to a directory boundary: half a segment is not a root.
  return a.slice(0, a.lastIndexOf('/', i - 1) + 1);
}

function commonSuffix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  const tail = a.slice(a.length - i);
  // A suffix never spans a directory boundary; a shared parent dir is not one.
  const slash = tail.lastIndexOf('/');
  return slash === -1 ? tail : tail.slice(slash + 1);
}

function conventionOf(ecosystem: GeneratorEcosystem): Convention {
  const base = ecosystem.path({ feature: PROBE_A, title: PROBE_A });
  return {
    root: commonPrefix(base, ecosystem.path({ feature: PROBE_B, title: PROBE_A })),
    suffix: commonSuffix(base, ecosystem.path({ feature: PROBE_A, title: PROBE_B })),
  };
}

/**
 * Every root any ecosystem uses. A path that already starts with one of these
 * carries its own convention, and prefixing it again would bury it a level
 * deeper — which is the failure this whole file exists to fix.
 */
const ALL_ROOTS: readonly string[] = [
  ...new Set(
    Object.values(GENERATOR_ECOSYSTEMS)
      .map((e) => conventionOf(e).root)
      .filter((root) => root !== ''),
  ),
];

/**
 * Ensure two tests never collide on one path: `a.spec.ts` → `a-2.spec.ts`.
 *
 * The convention suffix has to be treated as one unit. `extname` only sees the
 * last dot, so splitting on it would yield `a.spec-2.ts` — which no longer
 * matches the runner's collection pattern, silently dropping the de-duplicated
 * test from the exported repo.
 */
function uniquePath(tree: RepoTree, path: string, suffix: string): string {
  if (!tree.has(path)) return path;

  const ext = suffix && path.endsWith(suffix) ? suffix : extname(path);
  const stem = ext ? path.slice(0, -ext.length) : path;

  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!tree.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/**
 * The repo-relative home of one test, in its own ecosystem's terms.
 *
 * `filePattern` is the generator's own answer to "will the runner collect this",
 * so a path that fails it gets the convention suffix appended rather than
 * trusted. That matters for the spec-driven types, whose stems look like
 * `storefront.a11y` — `.a11y` reads as an extension, and appending
 * unconditionally is what keeps those tests discoverable.
 */
function repoPath(
  rel: string,
  ecosystem: GeneratorEcosystem,
  convention: Convention,
  root: string,
): string {
  const collectable = ecosystem.filePattern.test(rel) ? rel : `${rel}${convention.suffix}`;
  if (!root || collectable.startsWith(root)) return collectable;
  if (ALL_ROOTS.some((other) => collectable.startsWith(other))) return collectable;
  return `${root}${collectable}`;
}

/** The layout row a written path belongs under: its root, or its own top folder. */
function layoutRoot(path: string, root: string): string {
  if (root && path.startsWith(root)) return root;
  const slash = path.indexOf('/');
  return slash === -1 ? '' : `${path.slice(0, slash)}/`;
}

// ─── Export profiles ─────────────────────────────────────────────────────────

interface Dependency {
  /** Manifest-native name: `vitest`, `org.junit.jupiter:junit-jupiter`, `rspec`. */
  readonly name: string;
  /** Empty where the manifest is conventionally unpinned (requirements.txt). */
  readonly version: string;
}

/**
 * What an exported repo needs, per ecosystem the generator can write.
 *
 * `runner` points at the @qaai/shared catalogue, which owns the facts nobody
 * remembers — how to invoke the tool, which flag makes it emit a report, where
 * that report lands, how to install it. This table adds only what the catalogue
 * cannot know: which packages the generated code imports, and where a manifest
 * would be a lie.
 */
interface ExportProfile {
  /** The catalogue record whose invocation and install hint this export uses. */
  readonly runner: RunnerEcosystemId | null;
  readonly deps: readonly Dependency[];
  /** Overrides the derived root; for ecosystems whose paths start at the repo root. */
  readonly root?: string;
  /** Stated in the README verbatim — a gap, a prerequisite, or a second step. */
  readonly note?: string;
  /** Set when a manifest cannot be produced faithfully; the reason is the value. */
  readonly manifestBlocked?: string;
}

const dep = (name: string, version = ''): Dependency => ({ name, version });

const TS_TOOLING = [dep('typescript', '^5.6.0'), dep('@types/node', '^22.0.0')];
const JUNIT_JVM = [dep('org.junit.jupiter:junit-jupiter', '5.11.4'), dep('org.assertj:assertj-core', '3.26.3')];
const DOTNET_SDK = dep('Microsoft.NET.Test.Sdk', '17.12.0');
const NUNIT_PKGS = [DOTNET_SDK, dep('NUnit', '4.2.2'), dep('NUnit3TestAdapter', '4.6.0')];

const EXPORT_PROFILES: Record<GeneratorEcosystemId, ExportProfile> = {
  // ── JavaScript / TypeScript ────────────────────────────────────────────────
  PLAYWRIGHT_TS: {
    runner: 'playwright',
    // The generator deliberately emits `<feature>/<title>.spec.ts` and leaves the
    // root to the exporter; `tests/` is what its config has always pointed at.
    root: 'tests/',
    deps: [dep('@playwright/test', '^1.56.0'), dep('@axe-core/playwright', '^4.10.0')],
  },
  CYPRESS: { runner: 'cypress', deps: [dep('cypress', '^13.15.0')] },
  WEBDRIVERIO: {
    runner: 'webdriverio',
    deps: [
      dep('@wdio/cli', '^9.0.0'),
      dep('@wdio/local-runner', '^9.0.0'),
      dep('@wdio/mocha-framework', '^9.0.0'),
      dep('@wdio/spec-reporter', '^9.0.0'),
      dep('@wdio/junit-reporter', '^9.0.0'),
      dep('ts-node', '^10.9.2'),
      ...TS_TOOLING,
    ],
  },
  PUPPETEER: {
    runner: 'jest',
    root: 'tests/',
    deps: [
      dep('puppeteer', '^23.0.0'),
      dep('jest', '^29.7.0'),
      dep('ts-jest', '^29.2.0'),
      dep('@types/jest', '^29.5.0'),
      ...TS_TOOLING,
    ],
  },
  NIGHTWATCH: {
    runner: 'nightwatch',
    deps: [dep('nightwatch', '^3.8.0'), ...TS_TOOLING],
    note: 'Nightwatch needs a browser driver on the machine that runs it — `npx nightwatch --env chrome` expects Chrome and a matching chromedriver.',
  },
  TESTCAFE: { runner: 'testcafe', deps: [dep('testcafe', '^3.6.0')] },
  JEST: {
    runner: 'jest',
    deps: [dep('jest', '^29.7.0'), dep('ts-jest', '^29.2.0'), dep('@types/jest', '^29.5.0'), ...TS_TOOLING],
  },
  VITEST: { runner: 'vitest', deps: [dep('vitest', '^2.1.0'), ...TS_TOOLING] },

  // ── Python ─────────────────────────────────────────────────────────────────
  PLAYWRIGHT_PYTHON: {
    runner: 'pytest',
    deps: [dep('pytest'), dep('pytest-playwright'), dep('playwright')],
    note: 'Playwright for Python installs its browsers separately: `python3 -m playwright install`.',
  },
  SELENIUM_PYTHON: {
    runner: 'pytest',
    deps: [dep('pytest'), dep('pytest-base-url'), dep('selenium')],
  },
  APPIUM_PYTHON: {
    runner: 'pytest',
    deps: [dep('pytest'), dep('Appium-Python-Client'), dep('selenium')],
    note: 'Appium tests need a running Appium server and a device or emulator; neither is part of this repo.',
  },
  PYTEST: { runner: 'pytest', deps: [dep('pytest')] },
  UNITTEST: {
    runner: 'unittest',
    deps: [],
    note: 'The stdlib runner emits no machine-readable report — the exit code is the whole result. `python3 -m pip install pytest` and `python3 -m pytest` runs the same files and does produce one.',
  },
  ROBOT: { runner: 'robot-framework', deps: [dep('robotframework'), dep('robotframework-browser')] },

  // ── Java ───────────────────────────────────────────────────────────────────
  PLAYWRIGHT_JAVA: {
    runner: 'junit5-maven',
    deps: [...JUNIT_JVM, dep('com.microsoft.playwright:playwright', '1.49.0')],
  },
  SELENIUM_JAVA: {
    runner: 'junit5-maven',
    deps: [...JUNIT_JVM, dep('org.seleniumhq.selenium:selenium-java', '4.27.0')],
  },
  APPIUM_JAVA: {
    runner: 'junit5-maven',
    deps: [...JUNIT_JVM, dep('io.appium:java-client', '9.3.0')],
    note: 'Appium tests need a running Appium server and a device or emulator; neither is part of this repo.',
  },
  JUNIT5: { runner: 'junit5-maven', deps: JUNIT_JVM },
  TESTNG: {
    runner: 'testng',
    deps: [dep('org.testng:testng', '7.10.2'), dep('org.assertj:assertj-core', '3.26.3')],
  },

  // ── Kotlin ─────────────────────────────────────────────────────────────────
  PLAYWRIGHT_KOTLIN: {
    runner: 'junit5-gradle',
    deps: [...JUNIT_JVM, dep('com.microsoft.playwright:playwright', '1.49.0')],
  },
  SELENIUM_KOTLIN: {
    runner: 'junit5-gradle',
    deps: [...JUNIT_JVM, dep('org.seleniumhq.selenium:selenium-java', '4.27.0')],
  },
  ESPRESSO: {
    runner: null,
    deps: [],
    manifestBlocked:
      'Espresso tests are part of an Android application module. A build.gradle written without the app — its Android Gradle plugin version, compileSdk, applicationId and AndroidManifest — would not build, so none is included here.',
    note: 'Copy `app/src/androidTest/…` into your Android project and run `./gradlew connectedAndroidTest` there.',
  },
  JUNIT5_KOTLIN: { runner: 'junit5-gradle', deps: JUNIT_JVM },

  // ── C# ─────────────────────────────────────────────────────────────────────
  PLAYWRIGHT_CSHARP: {
    runner: 'nunit',
    deps: [...NUNIT_PKGS, dep('Microsoft.Playwright.NUnit', '1.49.0')],
    note: 'Playwright for .NET installs its browsers separately: `pwsh bin/Debug/net8.0/playwright.ps1 install` after the first build.',
  },
  SELENIUM_CSHARP: {
    runner: 'nunit',
    deps: [...NUNIT_PKGS, dep('Selenium.WebDriver', '4.27.0')],
  },
  NUNIT: { runner: 'nunit', deps: NUNIT_PKGS },
  XUNIT: {
    runner: 'xunit',
    deps: [DOTNET_SDK, dep('xunit', '2.9.2'), dep('xunit.runner.visualstudio', '2.8.2')],
  },

  // ── Ruby ───────────────────────────────────────────────────────────────────
  CAPYBARA_RSPEC: {
    runner: 'rspec',
    deps: [dep('rspec', '~> 3.13'), dep('capybara', '~> 3.40'), dep('selenium-webdriver', '~> 4.27')],
  },
  SELENIUM_RUBY: {
    runner: 'rspec',
    deps: [dep('rspec', '~> 3.13'), dep('selenium-webdriver', '~> 4.27')],
  },
  RSPEC: { runner: 'rspec', deps: [dep('rspec', '~> 3.13')] },
  MINITEST: {
    runner: 'minitest',
    deps: [dep('minitest', '~> 5.25'), dep('minitest-reporters', '~> 1.7'), dep('rake', '~> 13.2')],
  },

  // ── Go ─────────────────────────────────────────────────────────────────────
  PLAYWRIGHT_GO: {
    runner: 'go-test',
    deps: [dep('github.com/playwright-community/playwright-go')],
  },
  CHROMEDP: { runner: 'go-test', deps: [dep('github.com/chromedp/chromedp')] },
  GO_TEST: { runner: 'go-test', deps: [] },

  // ── PHP ────────────────────────────────────────────────────────────────────
  PANTHER: {
    runner: 'phpunit',
    deps: [dep('phpunit/phpunit', '^11.0'), dep('symfony/panther', '^2.1')],
    note: 'Panther drives a real browser: `composer require --dev dbrekelmans/bdi && vendor/bin/bdi detect drivers` puts chromedriver where it looks for it.',
  },
  CODECEPTION: {
    runner: null,
    deps: [dep('codeception/codeception', '^5.1')],
    note: 'Codeception has no record in the QAAI runner catalogue, so no invocation is claimed for it here. `vendor/bin/codecept bootstrap` writes codeception.yml, then `vendor/bin/codecept run Acceptance --xml` produces JUnit XML.',
  },
  PHPUNIT: { runner: 'phpunit', deps: [dep('phpunit/phpunit', '^11.0')] },
  PEST: { runner: 'pest', deps: [dep('pestphp/pest', '^3.0')] },

  // ── Cross-language ─────────────────────────────────────────────────────────
  CUCUMBER: {
    runner: null,
    deps: [],
    manifestBlocked:
      'A .feature file is Gherkin — it runs only once step definitions exist in a host language, and which language that is decides the manifest. Pick your Cucumber implementation (cucumber-ruby, cucumber-jvm, behave, behat) and add its manifest.',
  },
};

/** The manifest family a language lives in, for the profiles with no runner record. */
const LANGUAGE_PACKAGE_MANAGER: Record<Language, PackageManager> = {
  TYPESCRIPT: 'npm',
  JAVASCRIPT: 'npm',
  PYTHON: 'pip',
  JAVA: 'maven',
  KOTLIN: 'gradle',
  CSHARP: 'dotnet',
  RUBY: 'bundler',
  GO: 'go',
  PHP: 'composer',
};

// ─── Manifests ───────────────────────────────────────────────────────────────

interface ManifestContext {
  slug: string;
  deps: readonly Dependency[];
  /** npm only: `scripts.test`, so `npm test` does the obvious thing. */
  testScript: string | null;
}

/** A manifest, or an honest refusal that the README repeats. */
type Manifest = { path: string; contents: string } | { path: null; why: string };

/** The plain, human invocation for `npm test` — the CI form lives in the README. */
const NPM_TEST_SCRIPT: Partial<Record<RunnerEcosystemId, string>> = {
  playwright: 'playwright test',
  cypress: 'cypress run',
  webdriverio: 'wdio run wdio.conf.ts',
  nightwatch: 'nightwatch',
  testcafe: 'testcafe chrome tests/',
  jest: 'jest',
  vitest: 'vitest run',
};

/**
 * Partial on purpose. The catalogue's manager list is wider than the set QAAI
 * generates code for, and it grows; a total Record would turn "someone added
 * Cargo to the catalogue" into a build break here, and the honest answer for a
 * manager with no writer is already implemented — the README says so.
 */
const MANIFESTS: Partial<Record<PackageManager, (ctx: ManifestContext) => Manifest>> = {
  npm: ({ slug, deps, testScript }) => ({
    path: 'package.json',
    contents: `${JSON.stringify(
      {
        name: `${slug}-tests`,
        private: true,
        type: 'module',
        scripts: { test: testScript ?? 'echo "no test runner configured" && exit 1' },
        devDependencies: Object.fromEntries(deps.map((d) => [d.name, d.version || '*'])),
      },
      null,
      2,
    )}\n`,
  }),

  pip: ({ deps }) => ({
    path: 'requirements.txt',
    // Unpinned on purpose: a pinned version invented by an exporter is a lie
    // about what the tests were verified against. `pip freeze` after the first
    // green run is how a real lockfile gets written.
    contents: `${['# Versions are deliberately unpinned — pin them from `pip freeze` once the suite is green.', ...deps.map((d) => d.name)].join('\n')}\n`,
  }),

  maven: ({ slug, deps }) => ({
    path: 'pom.xml',
    contents: `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <groupId>com.qaai.tests</groupId>
  <artifactId>${slug}-tests</artifactId>
  <version>1.0.0-SNAPSHOT</version>

  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>

  <dependencies>
${deps
  .map((d) => {
    const [groupId = '', artifactId = ''] = d.name.split(':');
    return `    <dependency>
      <groupId>${groupId}</groupId>
      <artifactId>${artifactId}</artifactId>
      <version>${d.version}</version>
      <scope>test</scope>
    </dependency>`;
  })
  .join('\n')}
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <!-- Below 2.22.0 there is no JUnit Platform provider: the build goes
             green having run zero tests. -->
        <version>3.5.2</version>
      </plugin>
    </plugins>
  </build>
</project>
`,
  }),

  gradle: ({ deps }) => ({
    path: 'build.gradle.kts',
    contents: `plugins {
    kotlin("jvm") version "2.0.21"
}

repositories {
    mavenCentral()
}

dependencies {
${deps.map((d) => `    testImplementation("${d.name}:${d.version}")`).join('\n')}
}

kotlin {
    jvmToolchain(17)
}

// Without this Gradle runs the JUnit 4 engine and collects none of these tests.
tasks.test {
    useJUnitPlatform()
}
`,
  }),

  dotnet: ({ slug, deps }) => ({
    path: `${slug}-tests.csproj`,
    contents: `<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <IsPackable>false</IsPackable>
  </PropertyGroup>

  <ItemGroup>
${deps.map((d) => `    <PackageReference Include="${d.name}" Version="${d.version}" />`).join('\n')}
  </ItemGroup>

</Project>
`,
  }),

  bundler: ({ deps }) => ({
    path: 'Gemfile',
    contents: `source "https://rubygems.org"

${deps.map((d) => `gem "${d.name}", "${d.version}"`).join('\n')}
`,
  }),

  go: ({ slug, deps }) => ({
    path: 'go.mod',
    // Requires are left out on purpose: a `require` without the matching go.sum
    // entry fails the build, and this exporter cannot know the module versions
    // or their hashes. `go mod tidy` writes both, correctly, in one command.
    contents: `module qaai/${slug}-tests

go 1.22
${deps.length ? `\n// Run \`go mod tidy\` to add these and their checksums:\n${deps.map((d) => `//   ${d.name}`).join('\n')}\n` : ''}`,
  }),

  composer: ({ slug, deps }) => ({
    path: 'composer.json',
    contents: `${JSON.stringify(
      {
        name: `qaai/${slug}-tests`,
        type: 'project',
        require: { php: '>=8.2' },
        'require-dev': Object.fromEntries(deps.map((d) => [d.name, d.version || '*'])),
        autoload: { 'psr-4': { 'Tests\\': 'tests/' } },
        config: { 'sort-packages': true },
      },
      null,
      2,
    )}\n`,
  }),
};

/**
 * What the manifest alone does not give you. Only Gradle has one: its own
 * catalogue record invokes `./gradlew`, and the wrapper is a jar plus a shell
 * script that no exporter can write — saying so beats a repo whose documented
 * first command is `no such file or directory`.
 */
const MANAGER_NOTES: Partial<Record<PackageManager, string>> = {
  gradle:
    'There is no Gradle wrapper in this export — `gradlew` is a generated script and a jar. Run `gradle wrapper` once here, or copy `gradlew`, `gradlew.bat` and `gradle/wrapper/` from the project these tests belong to.',
};

/** What a reader types once, before the first run. */
const INSTALL_COMMAND: Partial<Record<PackageManager, string>> = {
  npm: 'npm install',
  pip: 'python3 -m pip install -r requirements.txt',
  maven: 'mvn -B dependency:resolve',
  gradle: './gradlew --refresh-dependencies',
  dotnet: 'dotnet restore',
  bundler: 'bundle install',
  go: 'go mod tidy',
  composer: 'composer install',
};

/** Build output, per manifest family. */
const MANAGER_IGNORES: Partial<Record<PackageManager, readonly string[]>> = {
  npm: ['node_modules/'],
  pip: ['__pycache__/', '.pytest_cache/', '.venv/', '*.pyc'],
  maven: ['target/'],
  gradle: ['build/', '.gradle/'],
  dotnet: ['bin/', 'obj/', 'TestResults/'],
  bundler: ['.bundle/', 'vendor/bundle/'],
  composer: ['vendor/', '.phpunit.result.cache'],
};

/** What a runner leaves behind, listed only when that runner is in the repo. */
const RUNNER_IGNORES: Partial<Record<RunnerEcosystemId, readonly string[]>> = {
  playwright: ['playwright-report/', 'test-results/'],
  cypress: ['cypress/videos/', 'cypress/screenshots/'],
  nightwatch: ['tests_output/'],
  minitest: ['test/reports/'],
};

// ─── Runner configuration ────────────────────────────────────────────────────

/**
 * The config that makes a suite runnable and environment-agnostic — every one
 * of these reads QAAI_BASE_URL, so the same repo runs against local, staging or
 * production without an edit.
 *
 * Keyed by the runner, not by the driver: a Selenium/pytest suite and a
 * Playwright/pytest suite share pytest's config exactly.
 */
type ConfigWriter = () => ReadonlyArray<readonly [string, string]>;

const RUNNER_CONFIGS: Partial<Record<RunnerEcosystemId, ConfigWriter>> = {
  playwright: () => [
    [
      'playwright.config.ts',
      `import { defineConfig } from '@playwright/test';

/**
 * Environment-agnostic on purpose: the base URL comes from QAAI_BASE_URL, so the
 * same repo runs against local, staging, or production without an edit.
 */
export default defineConfig({
  testDir: '.',
  // Only Playwright's own specs: a repo can hold a second runner's *.test.ts,
  // and Playwright's default testMatch would try to run those too.
  testMatch: '**/*.spec.ts',
  testIgnore: ['**/node_modules/**'],
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
`,
    ],
  ],

  cypress: () => [
    [
      'cypress.config.ts',
      `import { defineConfig } from 'cypress';

export default defineConfig({
  e2e: {
    baseUrl: process.env.QAAI_BASE_URL ?? 'http://localhost:3000',
    specPattern: 'cypress/e2e/**/*.cy.{js,jsx,ts,tsx}',
    supportFile: false,
    video: false,
  },
});
`,
    ],
  ],

  webdriverio: () => [
    [
      'wdio.conf.ts',
      `export const config: WebdriverIO.Config = {
  runner: 'local',
  tsConfigPath: './tsconfig.json',
  specs: ['./test/specs/**/*.spec.ts'],
  maxInstances: 1,
  capabilities: [{ browserName: 'chrome' }],
  baseUrl: process.env.QAAI_BASE_URL ?? 'http://localhost:3000',
  framework: 'mocha',
  // Reporters cannot be set from the CLI — this array is the only switch, and
  // outputDir below is what decides where the XML lands.
  reporters: ['spec', ['junit', { outputDir: './reports/junit', outputFileFormat: (o: { cid: string }) => \`results-\${o.cid}.xml\` }]],
  mochaOpts: { ui: 'bdd', timeout: 60000 },
};
`,
    ],
    [
      'tsconfig.json',
      `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            types: ['node', '@wdio/globals/types', '@wdio/mocha-framework'],
            strict: true,
            skipLibCheck: true,
          },
        },
        null,
        2,
      )}\n`,
    ],
  ],

  nightwatch: () => [
    [
      'nightwatch.conf.js',
      `module.exports = {
  src_folders: ['tests'],
  // Nightwatch writes JUnit XML here with no flag at all; output_folder: false
  // is what turns it off, which is worth knowing before concluding it is broken.
  output_folder: 'tests_output',
  test_settings: {
    default: {
      launch_url: process.env.QAAI_BASE_URL || 'http://localhost:3000',
      desiredCapabilities: { browserName: 'chrome' },
    },
  },
};
`,
    ],
  ],

  testcafe: () => [
    [
      '.testcaferc.json',
      `${JSON.stringify({ src: 'tests/', browsers: ['chrome:headless'], skipJsErrors: false }, null, 2)}\n`,
    ],
  ],

  jest: () => [
    [
      'jest.config.mjs',
      `export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  // A browser-driving test is not a unit test: one worker, and time to start.
  maxWorkers: 1,
  testTimeout: 60_000,
};
`,
    ],
  ],

  vitest: () => [
    [
      'vitest.config.ts',
      `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
  },
});
`,
    ],
  ],

  pytest: () => [
    [
      'pytest.ini',
      `[pytest]
testpaths = tests
python_files = test_*.py
addopts = -q
`,
    ],
    [
      'conftest.py',
      `import os

import pytest


@pytest.fixture(scope="session")
def base_url() -> str:
    """The address under test.

    Overrides the fixture pytest-base-url (and therefore pytest-playwright)
    reads, so page.goto("/cart") resolves without any test knowing which
    environment it is pointed at.
    """
    return os.environ.get("QAAI_BASE_URL", "http://localhost:3000")
`,
    ],
  ],

  phpunit: () => [
    [
      'phpunit.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<phpunit xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         bootstrap="vendor/autoload.php"
         colors="true"
         failOnWarning="true">
  <testsuites>
    <testsuite name="tests">
      <directory>tests</directory>
    </testsuite>
  </testsuites>
  <php>
    <env name="QAAI_BASE_URL" value="http://localhost:3000"/>
  </php>
</phpunit>
`,
    ],
  ],

  rspec: () => [
    ['.rspec', "--require spec_helper\n--format progress\n"],
    [
      'spec/spec_helper.rb',
      `RSpec.configure do |config|
  config.expect_with(:rspec) { |expectations| expectations.syntax = :expect }
  config.disable_monkey_patching!
end

# Only the Capybara suites need this, and they are the only ones that will have
# the gem — so ask, rather than making every RSpec export depend on a browser.
begin
  require "capybara/rspec"
  Capybara.app_host = ENV.fetch("QAAI_BASE_URL", "http://localhost:3000")
  Capybara.default_driver = :selenium_headless
rescue LoadError
  nil
end
`,
    ],
  ],

  minitest: () => [
    [
      'Rakefile',
      `require "rake/testtask"

Rake::TestTask.new(:test) do |t|
  t.libs << "test"
  t.test_files = FileList["test/**/*_test.rb"]
end

task default: :test
`,
    ],
    [
      'test/test_helper.rb',
      `require "minitest/autorun"
require "minitest/reporters"

# Plain Minitest prints dots and returns an exit code; the JUnit reporter is the
# only way this suite produces something a CI system can read.
Minitest::Reporters.use! [
  Minitest::Reporters::ProgressReporter.new,
  Minitest::Reporters::JUnitReporter.new("test/reports"),
]

BASE_URL = ENV.fetch("QAAI_BASE_URL", "http://localhost:3000")
`,
    ],
  ],
};

// ─── The static files ────────────────────────────────────────────────────────

function gitignore(managers: readonly PackageManager[], runners: readonly RunnerEcosystem[]): string {
  const extra = [
    ...new Set([
      ...managers.flatMap((m) => MANAGER_IGNORES[m] ?? []),
      ...runners.flatMap((r) => RUNNER_IGNORES[r.id as RunnerEcosystemId] ?? []),
    ]),
  ];
  return `${['reports/', 'artifacts/', ...extra, '', '# Runtime credentials — never commit these.', '.env', 'storage-state.json'].join('\n')}\n`;
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

/** The exact argv QAAI runs, rendered for a human to copy. */
function invocationOf(entry: RunnerEcosystem): { line: string; env: string[] } {
  try {
    const resolved = resolveEcosystemCommand(entry, entry.reportPath || null);
    return {
      line: [resolved.command, ...resolved.args].join(' '),
      env: Object.entries(resolved.env).map(([k, v]) => `${k}=${v}`),
    };
  } catch {
    // A record that needs a report path and has no default location. The bare
    // command still runs the suite; it just will not write a report.
    return { line: [entry.command, ...entry.args].join(' '), env: [] };
  }
}

interface ReadmeContext {
  projectName: string;
  secretNames: string[];
  /** Every runner represented in the tree, primary first. */
  runners: Array<{ ecosystem: GeneratorEcosystem; profile: ExportProfile; entry: RunnerEcosystem | null }>;
  manifests: Manifest[];
  roots: string[];
  configFiles: string[];
  /** Spec-driven tests exported as data because this ecosystem has no loader. */
  dataOnly: string[];
  installCommands: string[];
  hasFixtures: boolean;
  /** Prerequisites the manifest itself cannot carry — see MANAGER_NOTES. */
  managerNotes: string[];
}

function readme(ctx: ReadmeContext): string {
  const primary = ctx.runners[0];
  const label = primary ? primary.ecosystem.label : 'test';

  // One section per RUNNER, not per ecosystem: a Playwright/pytest suite and a
  // pytest unit suite are one `python3 -m pytest` invocation, and printing it
  // twice under two headings reads as two things to do.
  const byRunner = new Map<string, ReadmeContext['runners']>();
  for (const runner of ctx.runners) {
    const key = runner.entry?.id ?? `ecosystem:${runner.ecosystem.id}`;
    byRunner.set(key, [...(byRunner.get(key) ?? []), runner]);
  }

  const runSections = [...byRunner.values()].map((group) => {
    const heading = group.map((g) => g.ecosystem.label).join(' + ');
    const notes = group.flatMap((g) => g.profile.note ?? []);
    const entry = group[0]?.entry ?? null;
    const tail = notes.length ? `\n\n${notes.join('\n\n')}` : '';

    if (!entry) {
      return `### ${heading}

QAAI has no runner record for ${heading}, so no invocation is claimed for it
here.${tail}`;
    }
    const { line, env } = invocationOf(entry);
    return `### ${heading} — run with ${entry.label}

\`\`\`bash
${env.map((e) => `export ${e}`).join('\n')}${env.length ? '\n' : ''}${line}
\`\`\`

Report: ${entry.reportPath ? `\`${entry.reportPath}\` (${entry.reportFormat})` : `none — ${entry.label} reports through its exit code only`}.
Install: \`${entry.installHint}\`${tail}`;
  });

  const layout = [
    ...ctx.roots.map((r) => `| \`${r}\` | The tests. |`),
    ...(ctx.hasFixtures ? [`| \`${FIXTURE_PREFIX}\` | Test data the tests read. |`] : []),
    ...ctx.configFiles.map((f) => `| \`${f}\` | Runner configuration — reads \`QAAI_BASE_URL\`. |`),
    ...ctx.manifests.flatMap((m) => (m.path ? [`| \`${m.path}\` | Dependencies. |`] : [])),
  ];

  const gaps = [
    ...ctx.manifests.flatMap((m) => (m.path === null ? [`- ${m.why}`] : [])),
    ...ctx.managerNotes.map((n) => `- ${n}`),
    ...(ctx.dataOnly.length
      ? [
          `- ${ctx.dataOnly.length} configuration-driven test(s) — API, accessibility, visual, load — are exported as JSON under \`${FIXTURE_PREFIX}\` rather than as ${label} source. QAAI executes them with its own plugins; there is no faithful single-file equivalent in this ecosystem, and a stub that pretended otherwise would be worse than the data.`,
        ]
      : []),
  ];

  return `# ${ctx.projectName} — tests

Exported from QAAI. These are plain ${label} tests with no QAAI runtime
dependency: clone, install, run.

\`\`\`bash
${ctx.installCommands.join('\n')}
export QAAI_BASE_URL=https://your-app.example.com
\`\`\`

${runSections.join('\n\n')}

Dependency versions are a working starting point, not a lockfile — this export
never saw your resolved tree. Install once, commit the lockfile your package
manager writes, and move on.

## Layout

| Path | What |
| --- | --- |
${layout.join('\n')}

## Credentials

No secret values are in this repo. Tests read them from the environment; the
names they expect are:

${ctx.secretNames.length ? ctx.secretNames.map((n) => `- \`${n}\``).join('\n') : '_none configured_'}

See \`.env.example\`. Values live in the QAAI vault (encrypted) — supply them via
your CI secret store or a local \`.env\`, which \`.gitignore\` already excludes.
${gaps.length ? `\n## What this export does not include\n\n${gaps.join('\n')}\n` : ''}`;
}

// ─── Building the tree ───────────────────────────────────────────────────────

export interface BuildRepoOptions {
  projectId: string;
}

export interface RepoBuild {
  tree: RepoTree;
  projectName: string;
  /** Secret names referenced by the project's environments (values excluded). */
  secretNames: string[];
  skipped: Array<{ filePath: string; why: string }>;
  /** The ecosystem this repo was written for, primary first. */
  ecosystems: string[];
}

export async function buildRepoTree({ projectId }: BuildRepoOptions): Promise<RepoBuild> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, slug: true, primaryLanguage: true, primaryFramework: true },
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

  const secretNames = [...new Set(environments.flatMap((e) => e.secrets.map((s) => s.name)))].sort();

  // The same resolution the generator used when it wrote these files, so the
  // export mirrors the database rather than reinterpreting it. A unit test never
  // drove a browser, so it belongs to the language's unit runner, not the
  // project's UI framework — exactly the split resolveEcosystem() makes.
  const language = project.primaryLanguage as Language;
  const framework = project.primaryFramework as UiFramework;
  const uiEcosystem = resolveEcosystem({ language, framework });
  const unitEcosystem = resolveEcosystem({ language, framework, testType: 'UNIT_GEN' });
  const ecosystemFor = (type: TestType): GeneratorEcosystem =>
    type === 'UNIT_GEN' ? unitEcosystem : uiEcosystem;

  const tree: RepoTree = new Map();
  const skipped: Array<{ filePath: string; why: string }> = [];
  const used = new Map<GeneratorEcosystemId, GeneratorEcosystem>();
  const roots = new Set<string>();
  const dataOnly: string[] = [];

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
      tree.set(uniquePath(tree, rel, extname(rel)), body);
      continue;
    }

    const ecosystem = ecosystemFor(test.type as TestType);
    const profile = EXPORT_PROFILES[ecosystem.id];
    const convention = conventionOf(ecosystem);
    const root = profile.root ?? convention.root;
    used.set(ecosystem.id, ecosystem);

    if (SPEC_DRIVEN.has(test.type as TestType)) {
      /*
       * Strip the ecosystem's own test root before prefixing `fixtures/`.
       *
       * The stored path already carries the root for ecosystems whose
       * convention includes one — a pytest test is `tests/api/test_health.py`
       * where the Playwright TS equivalent is `api/health.api.json`. Prefixing
       * blindly gave `fixtures/tests/api/…` for one and `fixtures/api/…` for
       * the other: the same doubled-root family as the `tests/tests/` bug this
       * file exists to have fixed.
       */
      const stem = rel
        .replace(/\.[^./]+$/, '')
        .replace(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), '');
      const jsonPath = uniquePath(tree, `${FIXTURE_PREFIX}${stem}.json`, '.json');
      tree.set(jsonPath, `${JSON.stringify(test.spec ?? {}, null, 2)}\n`);

      // A loader is only honest where it actually runs. In a Playwright repo the
      // exported spec executes the same request chain; anywhere else a generated
      // stub would be a file that compiles, runs nothing, and reads as coverage.
      if (ecosystem.id === 'PLAYWRIGHT_TS') {
        const specPath = uniquePath(
          tree,
          repoPath(`${stem}.spec.ts`, ecosystem, convention, root),
          convention.suffix,
        );
        tree.set(specPath, specLoader(specPath, jsonPath, test.name, test.type));
        roots.add(layoutRoot(specPath, root));
      } else {
        dataOnly.push(jsonPath);
      }
      continue;
    }

    if (!test.code.trim()) {
      skipped.push({ filePath: test.filePath, why: 'no source to export' });
      continue;
    }

    const path = uniquePath(tree, repoPath(rel, ecosystem, convention, root), convention.suffix);
    tree.set(path, test.code);
    roots.add(layoutRoot(path, root));
  }

  // Primary first: the UI ecosystem is what the project is, and the README's
  // opening command should be the one most readers want.
  const ordered = [uiEcosystem, unitEcosystem].filter(
    (e, i, all) => used.has(e.id) && all.findIndex((o) => o.id === e.id) === i,
  );
  const runners = (ordered.length > 0 ? ordered : [uiEcosystem]).map((ecosystem) => {
    const profile = EXPORT_PROFILES[ecosystem.id];
    return {
      ecosystem,
      profile,
      entry: profile.runner ? (ecosystemById(profile.runner) ?? null) : null,
    };
  });

  const configFiles: string[] = [];
  for (const { entry } of runners) {
    const write = entry ? RUNNER_CONFIGS[entry.id as RunnerEcosystemId] : undefined;
    for (const [path, contents] of write?.() ?? []) {
      // A generated test never owns a config path, but it is cheap to be sure:
      // clobbering a test with a config file would lose the test silently.
      if (tree.has(path)) continue;
      tree.set(path, contents);
      configFiles.push(path);
    }
  }

  // One manifest per package manager. Every language QAAI generates for has
  // exactly one, so this is a set of one in practice and correct if that changes.
  const managers = new Map<PackageManager, Dependency[]>();
  const blocked: Manifest[] = [];
  for (const { ecosystem, profile, entry } of runners) {
    if (profile.manifestBlocked) {
      blocked.push({ path: null, why: profile.manifestBlocked });
      continue;
    }
    const manager =
      entry?.packageManager ?? (ecosystem.language ? LANGUAGE_PACKAGE_MANAGER[ecosystem.language] : null);
    if (!manager) {
      blocked.push({
        path: null,
        why: `${ecosystem.label} has no single manifest — its tests are a DSL, and the manifest belongs to whichever host language implements the steps.`,
      });
      continue;
    }
    managers.set(manager, [...(managers.get(manager) ?? []), ...profile.deps]);
  }

  const manifests: Manifest[] = [...blocked];
  for (const [manager, deps] of managers) {
    const write = MANIFESTS[manager];
    const unique = [...new Map(deps.map((d) => [d.name, d])).values()];
    if (!write) {
      manifests.push({
        path: null,
        why: `QAAI does not write a ${manager} manifest yet. The suite still runs once you add one with: ${unique.map((d) => d.name).join(', ') || 'the runner itself'}.`,
      });
      continue;
    }
    const primaryRunner = runners.find((r) => r.entry?.packageManager === manager)?.entry ?? null;
    const manifest = write({
      slug: project.slug,
      deps: unique,
      testScript: primaryRunner ? (NPM_TEST_SCRIPT[primaryRunner.id as RunnerEcosystemId] ?? null) : null,
    });
    manifests.push(manifest);
    if (manifest.path) tree.set(manifest.path, manifest.contents);
  }

  const installCommands = [
    ...new Set([
      ...[...managers.keys()].flatMap((m) => INSTALL_COMMAND[m] ?? []),
      // A runner with no manifest command of its own is the other half of
      // "install once": its tool has to be on PATH before anything runs.
      ...runners.flatMap(({ entry }) =>
        entry && !INSTALL_COMMAND[entry.packageManager] ? [entry.installHint] : [],
      ),
    ]),
  ];

  tree.set(
    '.gitignore',
    gitignore(
      [...managers.keys()],
      runners.flatMap((r) => r.entry ?? []),
    ),
  );
  tree.set('.env.example', envExample(secretNames));
  tree.set(
    'README.md',
    readme({
      projectName: project.name,
      secretNames,
      runners,
      manifests,
      roots: [...roots].filter(Boolean).sort(),
      configFiles,
      dataOnly,
      installCommands: installCommands.length ? installCommands : ['# nothing to install'],
      hasFixtures: [...tree.keys()].some((p) => p.startsWith(FIXTURE_PREFIX)),
      managerNotes: [...managers.keys()].flatMap((m) => MANAGER_NOTES[m] ?? []),
    }),
  );

  return {
    tree,
    projectName: project.name,
    secretNames,
    skipped,
    ecosystems: runners.map((r) => r.ecosystem.id),
  };
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
