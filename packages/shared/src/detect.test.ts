/**
 * Detection tests, written as eight repos QAAI will actually be pointed at.
 *
 * The fixtures are synthesized rather than cloned because the interesting cases
 * are the ones a real checkout would not give us on demand: a manifest we cannot
 * read, a monorepo with two runners that genuinely tie, a repo with no tests at
 * all. Each fixture is small but *plausible* — the files a human would find in
 * that project, in the places they live — because detection keys on layout, and
 * a fixture that omits `src/test/java` would prove nothing about Maven.
 *
 * Every case asserts the top candidate **and its evidence**. The evidence is not
 * decoration: it is the whole reason the import screen can offer "Not right?"
 * and get an informed override instead of a shrug. A test that only checked
 * `runner === 'pytest'` would pass just as happily on a lucky guess.
 *
 * A candidate names a runner by its *catalogue id* — 'pytest', 'junit5-maven' —
 * because ecosystems.ts is the only runner vocabulary. The last section of this
 * file is what keeps it that way.
 */

import { describe, expect, it } from 'vitest';
import {
  DETECTABLE_RUNNERS,
  detectProject,
  type RepoFile,
  type RunnerCandidate,
} from './detect';
import {
  ECOSYSTEMS,
  PACKAGE_MANAGER_LANGUAGES,
  ecosystemById,
  ecosystemRunArgs,
  junitPlanFor,
  type Ecosystem,
} from './ecosystems';

const f = (path: string, content?: string): RepoFile =>
  content === undefined ? { path } : { path, content };

const runners = (candidates: RunnerCandidate[]): string[] => candidates.map((c) => c.runner);
const details = (candidate: RunnerCandidate): string[] => candidate.evidence.map((e) => e.detail);
const shows = (candidate: RunnerCandidate, needle: string): boolean =>
  details(candidate).some((detail) => detail.includes(needle));

// ─── 1. Next.js + Playwright ─────────────────────────────────────────────────

const nextPlaywright: RepoFile[] = [
  f(
    'package.json',
    JSON.stringify({
      name: 'acme-web',
      private: true,
      scripts: { dev: 'next dev', build: 'next build', 'test:e2e': 'playwright test' },
      dependencies: { next: '15.1.0', react: '19.0.0', 'react-dom': '19.0.0' },
      devDependencies: { '@playwright/test': '^1.49.0', typescript: '^5.7.2' },
    }),
  ),
  f('package-lock.json'),
  f('next.config.mjs'),
  f('tsconfig.json', '{"compilerOptions":{"strict":true}}'),
  f('app/layout.tsx'),
  f('app/page.tsx'),
  f('components/Button.tsx'),
  f('playwright.config.ts', "import { defineConfig } from '@playwright/test';"),
  f('e2e/home.spec.ts'),
  f('e2e/checkout.spec.ts'),
];

describe('a Next.js app tested with Playwright', () => {
  const result = detectProject(nextPlaywright);
  const top = result.candidates[0]!;

  it('nominates Playwright, and says why', () => {
    expect(top.runner).toBe('playwright');
    expect(top.language).toBe('TYPESCRIPT');
    expect(top.testType).toBe('E2E');

    // The config file leads, because it is the strongest thing the repo says.
    expect(top.evidence[0]?.kind).toBe('config-file');
    expect(shows(top, 'found playwright.config.ts')).toBe(true);
    expect(shows(top, '@playwright/test in devDependencies')).toBe(true);
    expect(shows(top, 'playwright test')).toBe(true);
    expect(shows(top, 'e2e/**/*.{spec,test}.{ts,tsx,js,mjs}')).toBe(true);
    expect(top.confidence).toBeGreaterThan(0.85);
  });

  it('locates the tests and the command that runs them', () => {
    expect(top.testDirs).toEqual(['e2e']);
    expect(top.testFileCount).toBe(2);
    expect(top.packageManager).toBe('npm');
    expect(top.invocation.command).toBe('npx');
    expect(top.invocation.args).toEqual(['playwright', 'test']);
    expect(top.invocation.script).toBe('test:e2e');
    // Playwright can emit JUnit unaided, which is what lets the external runner
    // read per-test results instead of a bare exit code.
    expect(top.invocation.junit.support).toBe('built-in');
    expect(top.invocation.junit.env['PLAYWRIGHT_JUNIT_OUTPUT_NAME']).toBe('reports/junit.xml');
  });

  it('does not invent a unit runner from the .spec.ts files alone', () => {
    // Vitest and Jest both claim `*.spec.ts`, and neither is installed here.
    expect(runners(result.candidates)).toEqual(['playwright']);
    expect(result.languages[0]?.language).toBe('TYPESCRIPT');
    expect(result.hasTests).toBe(true);
    expect(result.monorepo).toBe(false);
  });
});

// ─── 2. Django + pytest ──────────────────────────────────────────────────────

const djangoPytest: RepoFile[] = [
  f('manage.py', '#!/usr/bin/env python\nimport django\n'),
  f(
    'requirements.txt',
    'Django==5.0.6\npsycopg[binary]==3.2.1\npytest==8.3.2\npytest-django==4.9.0\n',
  ),
  f('pytest.ini', '[pytest]\nDJANGO_SETTINGS_MODULE = config.settings\n'),
  f('config/__init__.py'),
  f('config/settings.py'),
  f('config/urls.py'),
  f('polls/__init__.py'),
  f('polls/models.py'),
  f('polls/views.py'),
  f('polls/tests/__init__.py'),
  f('polls/tests/test_models.py'),
  f('polls/tests/test_views.py'),
];

describe('a Django project tested with pytest', () => {
  const result = detectProject(djangoPytest);
  const top = result.candidates[0]!;

  it('nominates pytest on its config file', () => {
    expect(top.runner).toBe('pytest');
    expect(top.language).toBe('PYTHON');
    expect(shows(top, 'found pytest.ini')).toBe(true);
    expect(shows(top, 'pytest in requirements.txt')).toBe(true);
    expect(shows(top, '**/test_*.py')).toBe(true);
    expect(top.testDirs).toEqual(['polls/tests']);
    // `python3 -m pytest`, not a bare `pytest`: the catalogue record spells it
    // that way so the interpreter that owns the venv is the one that runs, and
    // a `pytest` on PATH can belong to a different environment entirely.
    expect(top.invocation.command).toBe('python3');
    expect(top.invocation.args).toEqual(['-m', 'pytest', '-q']);
    expect(top.invocation.junit.args).toContain('--junitxml=reports/junit.xml');
    expect(top.packageManager).toBe('pip');
  });

  it('still offers the Django runner, ranked below and explained', () => {
    // `python3 manage.py test` genuinely works here. Hiding it would be a lie
    // about the repo; ranking it above pytest.ini would be a worse one.
    const django = result.candidates.find((c) => c.runner === 'django-test')!;
    expect(django).toBeDefined();
    expect(django.score).toBeLessThan(top.score);
    expect(shows(django, 'manage.py')).toBe(true);
    expect(django.invocation.command).toBe('python3');
    expect(django.invocation.args).toEqual(['manage.py', 'test']);

    const conflict = result.notes.find((note) => note.includes('pytest.ini'));
    expect(conflict).toBeDefined();
    expect(conflict).toContain('config file');
    expect(conflict).toContain('Django test runner');
  });
});

// ─── 3. Spring Boot + JUnit 5 on Maven ───────────────────────────────────────

const springBootMaven: RepoFile[] = [
  f(
    'pom.xml',
    `<project>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-test</artifactId>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin><artifactId>maven-surefire-plugin</artifactId></plugin>
    </plugins>
  </build>
</project>`,
  ),
  f('mvnw'),
  f('mvnw.cmd'),
  f('.mvn/wrapper/maven-wrapper.properties'),
  f('src/main/java/com/example/demo/DemoApplication.java'),
  f('src/main/java/com/example/demo/GreetingController.java'),
  f('src/main/resources/application.properties'),
  f('src/test/java/com/example/demo/DemoApplicationTests.java'),
  f('src/test/java/com/example/demo/GreetingControllerTest.java'),
];

describe('a Spring Boot service on Maven with JUnit 5', () => {
  const result = detectProject(springBootMaven);
  const top = result.candidates[0]!;

  it('nominates JUnit 5 from the POM and the standard layout', () => {
    // The Maven record, specifically: JUnit 5 under Gradle is a different
    // record because it writes its reports somewhere else entirely, and a
    // candidate that named the wrong one would point at an empty directory.
    expect(top.runner).toBe('junit5-maven');
    expect(top.language).toBe('JAVA');
    expect(shows(top, 'junit-jupiter in dependencies (pom.xml)')).toBe(true);
    expect(shows(top, 'src/test/java')).toBe(true);
    expect(top.testDirs).toEqual(['src/test/java/com/example/demo']);
    expect(top.testFileCount).toBe(2);
    expect(top.confidence).toBeGreaterThan(0.8);
  });

  it('runs it through the wrapper the repo ships', () => {
    // ./mvnw over mvn: the wrapper pins the version the project expects, and it
    // is the one command guaranteed to exist on a fresh worker. Re-pointing the
    // command is all detection does — `-B` comes from the catalogue record,
    // which wants batch mode so the ANSI progress spinner stays out of the log.
    expect(top.invocation.command).toBe('./mvnw');
    expect(top.invocation.args).toEqual(['-B', 'test']);
    expect(top.packageManager).toBe('maven');
    // Surefire writes one XML per class, so there is no single reportPath to
    // hand the external runner. Saying so beats inventing a path.
    expect(top.invocation.junit.reportPath).toBeNull();
    expect(top.invocation.junit.note).toContain('surefire');
  });

  it('does not also claim JUnit 4 just because the filenames fit', () => {
    expect(runners(result.candidates)).not.toContain('junit4-maven');
    expect(runners(result.candidates)).not.toContain('junit4-gradle');
  });
});

// ─── 4. Rails + RSpec ────────────────────────────────────────────────────────

const railsRspec: RepoFile[] = [
  f(
    'Gemfile',
    `source 'https://rubygems.org'
gem 'rails', '~> 7.2.0'
gem 'pg', '~> 1.5'
group :development, :test do
  gem 'rspec-rails', '~> 7.1'
end
`,
  ),
  f('Gemfile.lock'),
  f('Rakefile'),
  f('.rspec', '--require spec_helper\n'),
  f('config/application.rb'),
  f('config/routes.rb'),
  f('app/models/user.rb'),
  f('app/controllers/users_controller.rb'),
  f('spec/rails_helper.rb'),
  f('spec/spec_helper.rb'),
  f('spec/models/user_spec.rb'),
  f('spec/requests/users_spec.rb'),
];

describe('a Rails app tested with RSpec', () => {
  const result = detectProject(railsRspec);
  const top = result.candidates[0]!;

  it('nominates RSpec on .rspec and the gem', () => {
    expect(top.runner).toBe('rspec');
    expect(top.language).toBe('RUBY');
    expect(shows(top, 'found .rspec')).toBe(true);
    expect(shows(top, 'rspec-rails in Gemfile')).toBe(true);
    expect(shows(top, 'spec/**/*_spec.rb')).toBe(true);
    expect(top.testDirs).toEqual(['spec/models', 'spec/requests']);
    expect(top.invocation.command).toBe('bundle');
    expect(top.invocation.args).toEqual(['exec', 'rspec']);
    expect(top.packageManager).toBe('bundler');
  });

  it('admits RSpec needs a gem before it can report JUnit', () => {
    expect(top.invocation.junit.support).toBe('needs-plugin');
    expect(top.invocation.junit.note).toContain('rspec_junit_formatter');
  });

  it('does not nominate Minitest, which this repo does not use', () => {
    expect(runners(result.candidates)).not.toContain('minitest');
  });
});

// ─── 5. A Go module ──────────────────────────────────────────────────────────

const goModule: RepoFile[] = [
  f(
    'go.mod',
    'module github.com/acme/widget\n\ngo 1.23\n\nrequire (\n\tgithub.com/stretchr/testify v1.9.0\n)\n',
  ),
  f('go.sum'),
  f('main.go'),
  f('internal/api/handler.go'),
  f('internal/api/handler_test.go'),
  f('internal/store/store.go'),
  f('internal/store/store_test.go'),
];

describe('a Go module', () => {
  const result = detectProject(goModule);
  const top = result.candidates[0]!;

  it('nominates go test from the toolchain, not from a config file it has none of', () => {
    expect(top.runner).toBe('go-test');
    expect(top.language).toBe('GO');
    expect(top.evidence[0]?.kind).toBe('toolchain');
    expect(shows(top, 'go.mod')).toBe(true);
    expect(shows(top, '**/*_test.go')).toBe(true);
    expect(top.testDirs).toEqual(['internal/api', 'internal/store']);
    expect(top.invocation.command).toBe('go');
    // `-count=1` rides along from the catalogue record, and it is load-bearing:
    // without it Go replays a cached PASS without running anything, and a suite
    // that never executed looks exactly like a fast one.
    expect(top.invocation.args).toEqual(['test', './...', '-count=1']);
    expect(top.packageManager).toBe('go');
  });

  it('is confident, but not certain, from a listing alone', () => {
    expect(top.confidence).toBeGreaterThan(0.7);
    expect(top.confidence).toBeLessThan(1);
  });

  it('is honest that `go test` has no JUnit output of its own', () => {
    expect(top.invocation.junit.support).toBe('needs-plugin');
    expect(top.invocation.junit.note).toContain('gotestsum');
  });
});

// ─── 6. A .NET solution ──────────────────────────────────────────────────────

const dotnetSolution: RepoFile[] = [
  f('MyApp.sln', 'Microsoft Visual Studio Solution File, Format Version 12.00\n'),
  f(
    'src/MyApp/MyApp.csproj',
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>',
  ),
  f('src/MyApp/Program.cs'),
  f('src/MyApp/Services/OrderService.cs'),
  f(
    'tests/MyApp.Tests/MyApp.Tests.csproj',
    `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
    <PackageReference Include="xunit" Version="2.9.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
  </ItemGroup>
</Project>`,
  ),
  f('tests/MyApp.Tests/OrderServiceTests.cs'),
];

describe('a .NET solution tested with xUnit', () => {
  const result = detectProject(dotnetSolution);
  const top = result.candidates[0]!;

  it('nominates xUnit from the test project, not from the solution file', () => {
    expect(top.runner).toBe('xunit');
    expect(top.language).toBe('CSHARP');
    expect(shows(top, 'xunit in PackageReference')).toBe(true);
    expect(shows(top, 'Microsoft.NET.Test.Sdk')).toBe(true);
    expect(top.testDirs).toEqual(['tests/MyApp.Tests']);
  });

  it('runs at the solution, where `dotnet test` belongs', () => {
    expect(top.root).toBe('.');
    expect(top.invocation.command).toBe('dotnet');
    expect(top.invocation.args).toEqual(['test']);
    expect(top.invocation.cwd).toBe('.');
    expect(top.packageManager).toBe('dotnet');
  });

  it('does not also claim NUnit and MSTest off the same filenames', () => {
    expect(runners(result.candidates)).toEqual(['xunit']);
  });
});

// ─── 7. A pnpm monorepo with two runners ─────────────────────────────────────

const pnpmMonorepo: RepoFile[] = [
  f('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n  - 'apps/*'\n"),
  f('pnpm-lock.yaml'),
  f(
    'package.json',
    JSON.stringify({
      name: 'acme',
      private: true,
      packageManager: 'pnpm@9.12.0',
      scripts: { test: 'pnpm -r test' },
      devDependencies: { typescript: '^5.7.2' },
    }),
  ),
  f('tsconfig.base.json'),
  f(
    'packages/core/package.json',
    JSON.stringify({
      name: '@acme/core',
      scripts: { test: 'vitest run' },
      devDependencies: { vitest: '^2.1.8' },
    }),
  ),
  f('packages/core/vitest.config.ts'),
  f('packages/core/src/money.ts'),
  f('packages/core/src/money.test.ts'),
  f(
    'apps/web/package.json',
    JSON.stringify({
      name: '@acme/web',
      scripts: { e2e: 'cypress run' },
      devDependencies: { cypress: '^13.17.0' },
    }),
  ),
  f('apps/web/cypress.config.ts'),
  f('apps/web/cypress/e2e/login.cy.ts'),
  f('apps/web/cypress/support/e2e.ts'),
  f('apps/web/src/main.ts'),
];

describe('a pnpm monorepo running Vitest in one package and Cypress in another', () => {
  const result = detectProject(pnpmMonorepo);

  it('returns both runners rather than picking one', () => {
    expect(runners(result.candidates).sort()).toEqual(['cypress', 'vitest']);
    expect(result.monorepo).toBe(true);
    expect(result.roots).toEqual(['.', 'apps/web', 'packages/core']);
    expect(result.notes.some((note) => note.includes('All are listed'))).toBe(true);
  });

  it('scopes each runner to its own workspace, with its own evidence', () => {
    const cypress = result.candidates.find((c) => c.runner === 'cypress')!;
    const vitest = result.candidates.find((c) => c.runner === 'vitest')!;

    expect(cypress.root).toBe('apps/web');
    expect(shows(cypress, 'found apps/web/cypress.config.ts')).toBe(true);
    expect(cypress.testDirs).toEqual(['apps/web/cypress/e2e']);
    expect(cypress.invocation.cwd).toBe('apps/web');
    expect(cypress.testType).toBe('E2E');

    expect(vitest.root).toBe('packages/core');
    expect(shows(vitest, 'found packages/core/vitest.config.ts')).toBe(true);
    expect(vitest.testDirs).toEqual(['packages/core/src']);
    expect(vitest.invocation.cwd).toBe('packages/core');
    expect(vitest.testType).toBe('UNIT_GEN');
  });

  it('finds the package manager the workspaces inherit rather than declare', () => {
    // Neither workspace has a lockfile; both run under the root's pnpm.
    for (const candidate of result.candidates) {
      expect(candidate.packageManager).toBe('pnpm');
      expect(candidate.invocation.command).toBe('pnpm');
      expect(candidate.invocation.args[0]).toBe('exec');
    }
    expect(result.packageManagers[0]?.manager).toBe('pnpm');
  });

  it('orders tied candidates by the repo, not by the order files arrived in', () => {
    // Both score identically — a real tie, and the honest one. What must not
    // happen is the ranking shifting under a reshuffled listing, because then
    // "the top candidate" would mean nothing.
    const shuffled = [...pnpmMonorepo].reverse();
    expect(runners(detectProject(shuffled).candidates)).toEqual(runners(result.candidates));
    expect(result.candidates[0]?.score).toBe(result.candidates[1]?.score);
  });
});

// ─── 8. An empty repo, and a repo with no tests ──────────────────────────────

describe('a repo with nothing to detect', () => {
  it('says so for an empty listing instead of guessing', () => {
    const result = detectProject([]);
    expect(result.candidates).toEqual([]);
    expect(result.languages).toEqual([]);
    expect(result.packageManagers).toEqual([]);
    expect(result.hasTests).toBe(false);
    expect(result.monorepo).toBe(false);
    expect(result.roots).toEqual(['.']);
    expect(result.notes.join(' ')).toContain('nothing to detect');
  });

  it('says "no tests" for a real app that has none', () => {
    const result = detectProject([
      f(
        'package.json',
        JSON.stringify({
          name: 'api',
          scripts: { start: 'node src/server.js' },
          dependencies: { express: '^5.0.1' },
        }),
      ),
      f('package-lock.json'),
      f('README.md'),
      f('src/server.js'),
      f('src/routes/users.js'),
    ]);

    // A framework nominated here would be pure invention: nothing in this repo
    // mentions one.
    expect(result.candidates).toEqual([]);
    expect(result.hasTests).toBe(false);
    expect(result.notes.join(' ')).toContain('no tests');
    // Everything else it can honestly answer, it still answers.
    expect(result.languages[0]?.language).toBe('JAVASCRIPT');
    expect(result.packageManagers[0]?.manager).toBe('npm');
  });

  it('is not fooled by runners vendored into node_modules', () => {
    const result = detectProject([
      f('package.json', JSON.stringify({ name: 'api', dependencies: { express: '^5.0.1' } })),
      f('src/server.js'),
      f('node_modules/jest/package.json', JSON.stringify({ name: 'jest' })),
      f('node_modules/jest/build/index.test.js'),
      f('node_modules/mocha/.mocharc.json', '{}'),
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.hasTests).toBe(false);
  });

  it('reports a configured runner with an empty suite as configured, not as tested', () => {
    const result = detectProject([
      f('package.json', JSON.stringify({ name: 'api', devDependencies: { vitest: '^2.1.8' } })),
      f('vitest.config.ts'),
      f('src/server.ts'),
    ]);
    expect(result.candidates[0]?.runner).toBe('vitest');
    expect(result.candidates[0]?.testFileCount).toBe(0);
    expect(result.hasTests).toBe(false);
    expect(result.notes.join(' ')).toContain('no files matched its test conventions');
  });
});

// ─── Conflicting signals ─────────────────────────────────────────────────────

describe('conflicting signals in one package', () => {
  const result = detectProject([
    f(
      'package.json',
      JSON.stringify({
        name: 'acme-lib',
        scripts: { test: 'vitest run' },
        // The classic leftover: Jest was installed once, Vitest is what runs.
        devDependencies: { jest: '^29.7.0', vitest: '^2.1.8' },
      }),
    ),
    f('vitest.config.ts'),
    f('src/sum.ts'),
    f('src/sum.test.ts'),
  ]);

  it('ranks Vitest above Jest because a config file outranks a dependency', () => {
    expect(result.candidates[0]?.runner).toBe('vitest');
    expect(runners(result.candidates)).toContain('jest');

    const vitest = result.candidates[0]!;
    const jest = result.candidates.find((c) => c.runner === 'jest')!;
    expect(vitest.evidence[0]?.kind).toBe('config-file');
    expect(jest.evidence[0]?.kind).toBe('dependency');
    expect(vitest.score).toBeGreaterThan(jest.score);
  });

  it('explains the ranking in words the user can overrule', () => {
    const note = result.notes.find((n) => n.includes('Vitest') && n.includes('Jest'));
    expect(note).toBeDefined();
    expect(note).toContain('vitest.config.ts');
    expect(note).toContain('config file');
    expect(note).toContain('dependency entry');
  });

  it('still returns Jest, with the files it would claim', () => {
    // Keeping the loser visible is the point: if this repo really is mid-
    // migration, the user knows more than the file listing does.
    const jest = result.candidates.find((c) => c.runner === 'jest')!;
    expect(jest.testFileCount).toBe(1);
    expect(jest.invocation.args).toEqual(['jest', '--ci']);
  });
});

// ─── A manifest that is present but unreadable ───────────────────────────────

describe('a manifest that is present but unreadable', () => {
  it('warns, then falls back to filename conventions at lower confidence', () => {
    const result = detectProject([
      f('package.json'), // listed by the git tree, contents never fetched
      f('package-lock.json'),
      f('src/sum.ts'),
      f('src/sum.test.ts'),
    ]);

    expect(result.warnings.join(' ')).toContain('package.json is present but');
    expect(result.notes.join(' ')).toContain('fell back to filename conventions');

    // Without the manifest, `sum.test.ts` fits Vitest and Jest equally well, so
    // both are offered — and neither is offered confidently.
    expect(runners(result.candidates)).toContain('vitest');
    expect(runners(result.candidates)).toContain('jest');
    for (const candidate of result.candidates) {
      expect(candidate.confidence).toBeLessThan(0.5);
      expect(candidate.evidence.every((e) => e.kind === 'file-convention')).toBe(true);
    }
  });

  it('treats an unparseable manifest the same way, and names the reason', () => {
    const result = detectProject([
      f('package.json', '{ "name": "acme", oops }'),
      f('playwright.config.ts'),
      f('e2e/home.spec.ts'),
    ]);

    expect(result.warnings.join(' ')).toContain('not valid JSON');
    // The config file is still a fact, so Playwright is still the answer — it
    // just cannot be corroborated by a dependency any more.
    expect(result.candidates[0]?.runner).toBe('playwright');
    expect(result.candidates[0]?.evidence.some((e) => e.kind === 'dependency')).toBe(false);
  });
});

// ─── The catalogue command, pointed at what the repo actually has ────────────

describe('adapting a catalogue command to the repo it will run in', () => {
  it('runs the WebdriverIO config that exists, not the one the record names', () => {
    // The record says `wdio run wdio.conf.js` because that is the common case.
    // This repo is TypeScript, and the .js file is not there at all — running it
    // would fail with "config not found" rather than with a test failure.
    const result = detectProject([
      f(
        'package.json',
        JSON.stringify({
          name: 'acme-e2e',
          devDependencies: { '@wdio/cli': '^9.4.1', '@wdio/junit-reporter': '^9.4.0' },
        }),
      ),
      f('package-lock.json'),
      f('wdio.conf.ts'),
      f('test/specs/login.e2e.ts'),
    ]);

    const top = result.candidates[0]!;
    expect(top.runner).toBe('webdriverio');
    expect(top.invocation.args).toEqual(['wdio', 'run', 'wdio.conf.ts']);
    // And it still admits the reporter has to be configured by a human.
    expect(top.invocation.junit.support).toBe('needs-plugin');
    expect(top.invocation.junit.note).toContain('@wdio/junit-reporter');
  });
});

// ─── Cross-cutting invariants ────────────────────────────────────────────────

describe('invariants that hold for every fixture', () => {
  const fixtures: Array<[string, RepoFile[]]> = [
    ['next + playwright', nextPlaywright],
    ['django + pytest', djangoPytest],
    ['spring boot + maven', springBootMaven],
    ['rails + rspec', railsRspec],
    ['go module', goModule],
    ['dotnet solution', dotnetSolution],
    ['pnpm monorepo', pnpmMonorepo],
    ['empty', []],
  ];

  it.each(fixtures)('%s: candidates are ranked and every one carries evidence', (_name, files) => {
    const result = detectProject(files);
    for (const [index, candidate] of result.candidates.entries()) {
      expect(candidate.evidence.length).toBeGreaterThan(0);
      expect(candidate.confidence).toBeGreaterThan(0);
      expect(candidate.confidence).toBeLessThan(1);
      const previous = result.candidates[index - 1];
      if (previous) expect(previous.score).toBeGreaterThanOrEqual(candidate.score);
    }
  });

  it.each(fixtures)('%s: every invocation is argv-safe, never a shell string', (_name, files) => {
    // The runner spawns without a shell (see plugins/external.ts). A command
    // with a space in it would be a bug that only shows up at run time.
    for (const candidate of detectProject(files).candidates) {
      expect(candidate.invocation.command).not.toMatch(/\s/);
      expect(candidate.invocation.command.length).toBeGreaterThan(0);
      for (const arg of [...candidate.invocation.args, ...candidate.invocation.junit.args]) {
        expect(typeof arg).toBe('string');
      }
    }
  });

  it.each(fixtures)('%s: detection is a pure function of the listing', (_name, files) => {
    const once = detectProject(files);
    const twice = detectProject([...files].reverse());
    expect(runners(twice.candidates)).toEqual(runners(once.candidates));
    expect(twice.candidates.map((c) => c.score)).toEqual(once.candidates.map((c) => c.score));
  });

  it.each(fixtures)('%s: every candidate is a catalogue record, not a name', (_name, files) => {
    // The point of the whole reconciliation: a candidate's runner is an id you
    // can look up, and what comes back agrees with what was reported.
    for (const candidate of detectProject(files).candidates) {
      const entry = ecosystemById(candidate.runner);
      expect(entry, `${candidate.runner} is not in the catalogue`).toBeDefined();
      expect(candidate.label).toBe(entry!.label);
      expect(candidate.testType).toBe(entry!.defaultTestType);
      expect(entry!.languages).toContain(candidate.language.toLowerCase());
    }
  });
});

// ─── One vocabulary, and the checks that keep it that way ────────────────────

/**
 * These are the tests that would have caught the drift twice already: a runner
 * detection knows and the catalogue does not, a manager whose languages nobody
 * agreed on, a record whose command cannot actually be assembled.
 *
 * The strongest check is not here at all — `RunnerRule.ecosystem` is typed
 * `EcosystemId`, so a rule naming a runner the catalogue lacks fails `tsc`
 * before any of this runs. What is left is everything a type cannot say.
 */
describe('the ecosystem catalogue is the only runner vocabulary', () => {
  const all: readonly Ecosystem[] = ECOSYSTEMS;

  it('has a record for every runner detection can nominate', () => {
    expect(DETECTABLE_RUNNERS.length).toBeGreaterThan(0);
    for (const id of DETECTABLE_RUNNERS) {
      expect(ecosystemById(id), `${id} has a detection rule but no catalogue record`).toBeDefined();
    }
  });

  it('gives every record a runnable command, report flags removed', () => {
    for (const entry of all) {
      // Throws when reportArgs is not an in-order subsequence of args, which is
      // the one way these two fields can silently disagree.
      const plain = ecosystemRunArgs(entry, entry.defaultTestPath ?? 'tests');
      expect(plain.length + entry.reportArgs.length).toBe(entry.args.length);
      expect(entry.command).not.toMatch(/\s/);
      for (const arg of plain) {
        expect(arg).not.toContain('{{');
      }
    }
  });

  it('never leaves a placeholder in a report plan', () => {
    for (const entry of all) {
      const plan = junitPlanFor(entry, { file: 'reports/junit.xml', directory: 'reports' });
      for (const value of [...plan.args, ...Object.values(plan.env)]) {
        expect(value, `${entry.id} left a placeholder in its JUnit plan`).not.toContain('{{');
      }
      // A path is only claimed when there is a single file to read; a glob or a
      // stdout stream gets null and a note saying so.
      if (plan.reportPath === null) expect(plan.note).not.toBeNull();
    }
  });

  it('keeps the runners that cannot report honest about it', () => {
    const plans = new Map(
      all.map((entry) => [
        entry.id,
        junitPlanFor(entry, { file: 'reports/junit.xml', directory: 'reports' }),
      ]),
    );

    // Named individually on purpose: these are the records whose whole value is
    // that they refuse to claim per-test results, and a refactor that quietly
    // promoted one to "built-in" would produce green runs with no test rows.
    for (const id of ['ava', 'xcodebuild', 'k6', 'pa11y-ci']) {
      expect(plans.get(id)?.support, `${id} should not claim JUnit support`).toBe('none');
      expect(plans.get(id)?.reportPath).toBeNull();
    }
    for (const id of [
      'jest',
      'rspec',
      'go-test',
      'unittest',
      'django-test',
      'minitest',
      'cargo-test',
    ]) {
      expect(plans.get(id)?.support, `${id} needs something installed first`).toBe('needs-plugin');
    }
    expect(plans.get('go-test')?.note).toContain('gotestsum');
    expect(plans.get('unittest')?.note).toContain('unittest-xml-reporting');
  });

  it('agrees with itself about which languages a package manager serves', () => {
    for (const entry of all) {
      const served = PACKAGE_MANAGER_LANGUAGES[entry.packageManager];
      for (const language of entry.languages) {
        expect(served, `${entry.id}: ${entry.packageManager} does not serve ${language}`).toContain(
          language,
        );
      }
    }
  });

  it('has no two records claiming the same id', () => {
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
  });
});
