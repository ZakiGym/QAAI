/**
 * Repo detection — "what is this project, and how do you run its tests?" (§7)
 *
 * Today `/import` makes the user declare their language and framework before
 * QAAI will look at anything. That is a form we make people fill in with facts
 * their repo already states out loud: a `pytest.ini` is not ambiguous, and a
 * `pnpm-workspace.yaml` next to a `cypress.config.ts` says more than a dropdown
 * ever will.
 *
 * Three rules shape everything below, and they exist because the failure mode
 * of this module is a *confident wrong answer* that sends the whole import down
 * the wrong path:
 *
 *  1. **Rank, never pick.** A monorepo genuinely has several runners. Returning
 *     the strongest one and hiding the rest is a lie about the repo, so every
 *     candidate that has evidence comes back, ordered.
 *  2. **Evidence, not verdicts.** The import screen already asks "Not right?".
 *     That question is only answerable if we show our work — "found pytest.ini"
 *     lets a user overrule us knowingly, "Python/pytest" only lets them guess.
 *  3. **"No tests" is an answer.** Plenty of repos have none. Detection says so
 *     rather than nominating whichever framework was least implausible.
 *
 * Evidence is tiered, and the tiers are the ranking: a config file beats a
 * dependency entry, which beats a filename convention. `vitest.config.ts` means
 * someone configured Vitest; `"jest": "^29"` in devDependencies means someone
 * installed Jest once; `foo.spec.ts` means someone named a file. Those are three
 * different strengths of claim and the score treats them that way.
 *
 * Nothing here executes anything or touches the filesystem — it is a pure
 * function of a file listing, which is what makes it testable against a repo we
 * do not have to clone.
 *
 * The runner union lives here rather than in constants.ts on purpose: these are
 * *observations about someone else's repo*, not QAAI domain enums, so they have
 * no Prisma mirror and are exempt from the enum-drift check.
 */

import { LANGUAGES, type Language, type TestType } from './constants.js';

// ─── Inputs ──────────────────────────────────────────────────────────────────

/**
 * One entry of a repo listing. `content` is optional because a listing is often
 * cheap (a git tree) while contents are not — and because a manifest can be
 * present and unreadable, which detection has to survive rather than assume.
 */
export interface RepoFile {
  path: string;
  content?: string;
}

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const TEST_RUNNERS = [
  // JavaScript / TypeScript
  'VITEST',
  'JEST',
  'MOCHA',
  'AVA',
  'NODE_TEST',
  'PLAYWRIGHT',
  'CYPRESS',
  'WEBDRIVERIO',
  'NIGHTWATCH',
  'K6',
  'PA11Y',
  'NEWMAN',
  // Python
  'PYTEST',
  'UNITTEST',
  'DJANGO_TEST',
  'BEHAVE',
  'ROBOT',
  // JVM
  'JUNIT5',
  'JUNIT4',
  'TESTNG',
  'KARATE',
  // Ruby
  'RSPEC',
  'MINITEST',
  'CUCUMBER_RUBY',
  // Go
  'GO_TEST',
  // .NET
  'XUNIT',
  'NUNIT',
  'MSTEST',
  // PHP
  'PHPUNIT',
  'PEST',
  // Rust / Swift
  'CARGO_TEST',
  'XCTEST',
] as const;
export type TestRunner = (typeof TEST_RUNNERS)[number];

/**
 * Languages we can *observe*. Deliberately wider than `LANGUAGES` in
 * constants.ts, which is the narrower set the generator can emit: a repo is
 * allowed to be Rust even though QAAI cannot write Rust tests, and saying so is
 * more useful than refusing to name it.
 */
export const DETECTED_LANGUAGES = [
  'TYPESCRIPT',
  'JAVASCRIPT',
  'PYTHON',
  'JAVA',
  'KOTLIN',
  'CSHARP',
  'RUBY',
  'GO',
  'PHP',
  'RUST',
  'SWIFT',
] as const;
export type DetectedLanguage = (typeof DETECTED_LANGUAGES)[number];

export const DETECTED_PACKAGE_MANAGERS = [
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'pip',
  'poetry',
  'uv',
  'pipenv',
  'maven',
  'gradle',
  'bundler',
  'go',
  'dotnet',
  'composer',
  'cargo',
  'swiftpm',
] as const;
export type DetectedPackageManager = (typeof DETECTED_PACKAGE_MANAGERS)[number];

/** Which language family a package manager serves; used to pair it with a runner. */
const PM_FAMILY: Record<DetectedPackageManager, DetectedLanguage[]> = {
  npm: ['TYPESCRIPT', 'JAVASCRIPT'],
  pnpm: ['TYPESCRIPT', 'JAVASCRIPT'],
  yarn: ['TYPESCRIPT', 'JAVASCRIPT'],
  bun: ['TYPESCRIPT', 'JAVASCRIPT'],
  pip: ['PYTHON'],
  poetry: ['PYTHON'],
  uv: ['PYTHON'],
  pipenv: ['PYTHON'],
  maven: ['JAVA', 'KOTLIN'],
  gradle: ['JAVA', 'KOTLIN'],
  bundler: ['RUBY'],
  go: ['GO'],
  dotnet: ['CSHARP'],
  composer: ['PHP'],
  cargo: ['RUST'],
  swiftpm: ['SWIFT'],
};

// ─── Evidence ────────────────────────────────────────────────────────────────

export type EvidenceKind =
  'config-file' | 'toolchain' | 'manifest-config' | 'script' | 'dependency' | 'file-convention';

/**
 * The tier table *is* the ranking policy, stated once.
 *
 * `toolchain` sits just under a config file: for `go test`, `cargo test` or
 * Maven's `src/test/java`, the manifest and the directory layout are the
 * configuration — the runner ships with the toolchain and has no config file to
 * find. Treating that as a mere filename convention would rank real, unambiguous
 * setups below a stray devDependency.
 */
export const EVIDENCE_WEIGHT: Record<EvidenceKind, number> = {
  'config-file': 50,
  toolchain: 45,
  'manifest-config': 40,
  script: 35,
  dependency: 30,
  'file-convention': 15,
};

const KIND_LABEL: Record<EvidenceKind, string> = {
  'config-file': 'config file',
  toolchain: 'toolchain marker',
  'manifest-config': 'config block in a manifest',
  script: 'package script',
  dependency: 'dependency entry',
  'file-convention': 'filename convention',
};

export interface Evidence {
  kind: EvidenceKind;
  /** Reads as a fact, not a conclusion: "found pytest.ini", "jest key in package.json". */
  detail: string;
  /** Repo-relative path the evidence came from, when it came from a file. */
  path: string | null;
  weight: number;
}

// ─── Results ─────────────────────────────────────────────────────────────────

/** How to get JUnit XML out of a runner — the shape `externalTestSpec` wants. */
export interface JUnitPlan {
  /** `none` means the tool has no JUnit path we trust; fall back to the exit code. */
  support: 'built-in' | 'needs-plugin' | 'none';
  /** Appended to `Invocation.args` to make the tool write the report. */
  args: string[];
  env: Record<string, string>;
  /** Report location relative to `Invocation.cwd`, or null when there is no single file. */
  reportPath: string | null;
  /** What is missing or surprising — shown verbatim, never silently assumed away. */
  note: string | null;
}

export interface Invocation {
  /** The executable. argv-style, because the runner spawns without a shell. */
  command: string;
  args: string[];
  /** Working directory relative to the repo root; '.' for the root itself. */
  cwd: string;
  /** The existing package script that already runs this tool, if there is one. */
  script: string | null;
  junit: JUnitPlan;
}

export interface RunnerCandidate {
  runner: TestRunner;
  label: string;
  language: DetectedLanguage;
  /** The QAAI suite type this runner maps onto, so the import screen can pre-fill it. */
  testType: TestType;
  /** Workspace this runner belongs to, relative to the repo root. */
  root: string;
  score: number;
  /** 0–1, saturating. Derived from `score`; the evidence is the real explanation. */
  confidence: number;
  evidence: Evidence[];
  /** Directories its tests actually live in, deepest-common-first. */
  testDirs: string[];
  /** The globs that matched, verbatim, e.g. `e2e/**\/*.spec.ts`. */
  testGlobs: string[];
  testFileCount: number;
  /** A few real paths, so a human can confirm we looked at the right files. */
  sampleTests: string[];
  invocation: Invocation;
  packageManager: DetectedPackageManager | null;
  /** Null when QAAI's generator cannot emit this language — worth admitting early. */
  generatorLanguage: Language | null;
}

export interface LanguageDetection {
  language: DetectedLanguage;
  fileCount: number;
  evidence: Evidence[];
  supportedByGenerator: boolean;
}

export interface PackageManagerDetection {
  manager: DetectedPackageManager;
  root: string;
  evidence: Evidence[];
}

export interface ProjectDetection {
  /** Ranked. Empty means "found no runner", never "detection gave up". */
  candidates: RunnerCandidate[];
  languages: LanguageDetection[];
  packageManagers: PackageManagerDetection[];
  /** True only when files matched a runner's test conventions — not when one is merely installed. */
  hasTests: boolean;
  monorepo: boolean;
  /** Project roots found, repo-relative. */
  roots: string[];
  /** Sentences for the "Not right?" affordance: conflicts resolved, gaps admitted. */
  notes: string[];
  /** What could not be read. A gap in the input, stated rather than papered over. */
  warnings: string[];
}

// ─── Glob matching ───────────────────────────────────────────────────────────

const globCache = new Map<string, RegExp>();

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A four-feature glob (`**`, `*`, `?`, `{a,b}`) rather than a dependency.
 * The patterns are ours, they all live in this file, and the compiled form is
 * cached — but the real reason is that the glob string is also the *evidence
 * string* shown to the user, so it has to stay human-readable.
 */
function globToRe(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;

  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        // `**/` spans zero or more directories, so `**/x` also matches a bare `x`.
        if (glob[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        out += '\\{';
      } else {
        const alts = glob
          .slice(i + 1, end)
          .split(',')
          .map((alt) => escapeRe(alt));
        out += `(?:${alts.join('|')})`;
        i = end;
      }
    } else {
      out += escapeRe(char);
    }
  }

  const re = new RegExp(`^${out}$`);
  globCache.set(glob, re);
  return re;
}

// ─── Rules ───────────────────────────────────────────────────────────────────

interface InvokeCtx {
  pm: DetectedPackageManager | null;
  /** Root-relative existence check. */
  has: (relPath: string) => boolean;
  testFiles: string[];
}

interface ToolchainRule {
  detail: string;
  /** Root-relative path that must exist for the marker to count. */
  file?: string;
  /** Extra condition, e.g. "this .csproj is a test project". */
  when?: (ctx: RuleCtx) => boolean;
}

interface RuleCtx {
  has: (relPath: string) => boolean;
  hasDep: (name: string) => boolean;
  testFiles: string[];
}

interface RunnerRule {
  runner: TestRunner;
  label: string;
  language: DetectedLanguage;
  testType: TestType;
  /** Root-relative globs whose presence is the strongest signal there is. */
  configGlobs?: string[];
  /** Top-level package.json keys that carry this runner's config. */
  pkgKeys?: string[];
  /** Config sections inside a text manifest, e.g. `[tool.pytest.ini_options]`. */
  manifestSections?: Array<{ file: string; re: RegExp; detail: string }>;
  /** Exact dependency names (case-insensitive). */
  deps?: string[];
  /** Dependency name patterns, for scoped or versioned families. */
  depPatterns?: RegExp[];
  /** CLI name as it appears in a package script, used for `script` evidence. */
  bin?: string;
  toolchain?: ToolchainRule[];
  /** Ordered most-specific-first; a file counts once, for the first glob it matches. */
  testGlobs?: string[];
  /**
   * True when the runner ships with the language toolchain. Only these may be
   * nominated on filename evidence alone — you cannot run Vitest without
   * installing Vitest, so a stray `foo.spec.ts` is not evidence that you do.
   */
  builtin?: boolean;
  /** For JVM rules: pick the language from the test files actually found. */
  languageByExt?: Record<string, DetectedLanguage>;
  invoke: (ctx: InvokeCtx) => { command: string; args: string[] };
  junit: JUnitPlan;
}

const REPORT = 'reports/junit.xml';

function jsExec(
  pm: DetectedPackageManager | null,
  bin: string,
  args: string[],
): {
  command: string;
  args: string[];
} {
  switch (pm) {
    case 'pnpm':
      return { command: 'pnpm', args: ['exec', bin, ...args] };
    case 'yarn':
      return { command: 'yarn', args: [bin, ...args] };
    case 'bun':
      return { command: 'bunx', args: [bin, ...args] };
    default:
      return { command: 'npx', args: [bin, ...args] };
  }
}

function pyExec(
  pm: DetectedPackageManager | null,
  command: string,
  args: string[],
): {
  command: string;
  args: string[];
} {
  if (pm === 'poetry' || pm === 'uv' || pm === 'pipenv') {
    return { command: pm, args: ['run', command, ...args] };
  }
  return { command, args };
}

/** Maven and Gradle both run tests through the build tool; the wrapper wins when present. */
function jvmExec(ctx: InvokeCtx): { command: string; args: string[] } {
  if (ctx.has('mvnw')) return { command: './mvnw', args: ['test'] };
  if (ctx.has('gradlew')) return { command: './gradlew', args: ['test'] };
  if (ctx.has('pom.xml')) return { command: 'mvn', args: ['test'] };
  return { command: 'gradle', args: ['test'] };
}

const BUILT_IN = (
  args: string[],
  reportPath: string | null,
  env: Record<string, string> = {},
  note: string | null = null,
): JUnitPlan => ({ support: 'built-in', args, env, reportPath, note });

const NEEDS = (note: string, args: string[] = [], reportPath: string | null = null): JUnitPlan => ({
  support: 'needs-plugin',
  args,
  env: {},
  reportPath,
  note,
});

const NO_JUNIT = (note: string): JUnitPlan => ({
  support: 'none',
  args: [],
  env: {},
  reportPath: null,
  note,
});

/**
 * The rule table. Ordering is irrelevant — ranking comes from evidence, not from
 * position — so entries are grouped by language for reading, not for precedence.
 */
const RULES: RunnerRule[] = [
  // ── JavaScript / TypeScript: unit ─────────────────────────────────────────
  {
    runner: 'VITEST',
    label: 'Vitest',
    language: 'TYPESCRIPT',
    testType: 'UNIT_GEN',
    configGlobs: ['vitest.config.{ts,js,mts,mjs,cts,cjs}', 'vitest.workspace.{ts,js,json}'],
    deps: ['vitest', '@vitest/ui', '@vitest/coverage-v8'],
    bin: 'vitest',
    testGlobs: [
      'test/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs}',
      'tests/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs}',
      '**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs}',
    ],
    invoke: (ctx) => jsExec(ctx.pm, 'vitest', ['run']),
    junit: BUILT_IN(['--reporter=junit', `--outputFile=${REPORT}`], REPORT),
  },
  {
    runner: 'JEST',
    label: 'Jest',
    language: 'TYPESCRIPT',
    testType: 'UNIT_GEN',
    configGlobs: ['jest.config.{ts,js,mjs,cjs,json}', 'jest.setup.{ts,js}'],
    pkgKeys: ['jest'],
    deps: ['jest', 'ts-jest', 'babel-jest', 'jest-environment-jsdom', '@jest/globals'],
    bin: 'jest',
    testGlobs: [
      '**/__tests__/**/*.{ts,tsx,js,jsx}',
      'test/**/*.{test,spec}.{ts,tsx,js,jsx}',
      'tests/**/*.{test,spec}.{ts,tsx,js,jsx}',
      '**/*.{test,spec}.{ts,tsx,js,jsx}',
    ],
    invoke: (ctx) => jsExec(ctx.pm, 'jest', ['--ci']),
    junit: NEEDS(
      'Jest needs the `jest-junit` reporter installed before it can emit JUnit XML.',
      ['--reporters=default', '--reporters=jest-junit'],
      REPORT,
    ),
  },
  {
    runner: 'MOCHA',
    label: 'Mocha',
    language: 'JAVASCRIPT',
    testType: 'UNIT_GEN',
    configGlobs: ['.mocharc.{json,jsonc,yml,yaml,js,cjs}'],
    pkgKeys: ['mocha'],
    deps: ['mocha'],
    bin: 'mocha',
    testGlobs: ['test/**/*.{js,mjs,cjs,ts}'],
    invoke: (ctx) => jsExec(ctx.pm, 'mocha', []),
    junit: NEEDS(
      'Mocha needs `mocha-junit-reporter` installed before it can emit JUnit XML.',
      ['--reporter', 'mocha-junit-reporter'],
      REPORT,
    ),
  },
  {
    runner: 'AVA',
    label: 'AVA',
    language: 'JAVASCRIPT',
    testType: 'UNIT_GEN',
    configGlobs: ['ava.config.{js,cjs,mjs}'],
    pkgKeys: ['ava'],
    deps: ['ava'],
    bin: 'ava',
    testGlobs: ['test/**/*.{js,mjs,cjs,ts}', '**/*.test.{js,mjs,cjs,ts}'],
    invoke: (ctx) => jsExec(ctx.pm, 'ava', []),
    junit: NO_JUNIT(
      'AVA reports TAP; converting it to JUnit needs a pipe, so QAAI reads the exit code.',
    ),
  },
  {
    runner: 'NODE_TEST',
    label: 'node:test',
    language: 'JAVASCRIPT',
    testType: 'UNIT_GEN',
    builtin: true,
    // Narrow on purpose: `**/*.test.js` alone is far more often Jest or Vitest,
    // and nominating node:test for every such file would be noise, not detection.
    testGlobs: ['test/**/*.{test,spec}.{js,mjs,cjs}', '**/*.test.{mjs,mts}'],
    invoke: () => ({ command: 'node', args: ['--test'] }),
    junit: BUILT_IN(['--test-reporter=junit', `--test-reporter-destination=${REPORT}`], REPORT),
  },
  // ── JavaScript / TypeScript: browser ──────────────────────────────────────
  {
    runner: 'PLAYWRIGHT',
    label: 'Playwright',
    language: 'TYPESCRIPT',
    testType: 'E2E',
    configGlobs: ['playwright.config.{ts,js,mts,mjs,cts,cjs}', 'playwright-ct.config.{ts,js}'],
    deps: ['@playwright/test', 'playwright'],
    depPatterns: [/^@playwright\//],
    bin: 'playwright',
    testGlobs: [
      'e2e/**/*.{spec,test}.{ts,tsx,js,mjs}',
      'tests/**/*.{spec,test}.{ts,tsx,js,mjs}',
      'playwright/**/*.{spec,test}.{ts,js}',
      '**/*.{spec,test}.{ts,tsx,js,mjs}',
    ],
    invoke: (ctx) => jsExec(ctx.pm, 'playwright', ['test']),
    junit: BUILT_IN(['--reporter=junit'], REPORT, { PLAYWRIGHT_JUNIT_OUTPUT_NAME: REPORT }),
  },
  {
    runner: 'CYPRESS',
    label: 'Cypress',
    language: 'TYPESCRIPT',
    testType: 'E2E',
    configGlobs: ['cypress.config.{ts,js,mjs,cjs}', 'cypress.json'],
    deps: ['cypress'],
    depPatterns: [/^@cypress\//],
    bin: 'cypress',
    testGlobs: [
      'cypress/e2e/**/*.cy.{ts,tsx,js,jsx}',
      'cypress/integration/**/*.{spec,test}.{ts,js}',
      'cypress/**/*.cy.{ts,tsx,js,jsx}',
      '**/*.cy.{ts,tsx,js,jsx}',
    ],
    invoke: (ctx) => jsExec(ctx.pm, 'cypress', ['run']),
    junit: NEEDS(
      'Cypress needs `mocha-junit-reporter` installed before it can emit JUnit XML.',
      ['--reporter', 'junit', '--reporter-options', `mochaFile=${REPORT}`],
      REPORT,
    ),
  },
  {
    runner: 'WEBDRIVERIO',
    label: 'WebdriverIO',
    language: 'TYPESCRIPT',
    testType: 'E2E',
    configGlobs: ['wdio.conf.{ts,js,mjs,cjs}', '**/wdio.conf.{ts,js}'],
    depPatterns: [/^@wdio\//],
    deps: ['webdriverio'],
    bin: 'wdio',
    testGlobs: ['test/specs/**/*.{ts,js}', '**/*.e2e.{ts,js}'],
    invoke: (ctx) =>
      jsExec(ctx.pm, 'wdio', ['run', ctx.has('wdio.conf.ts') ? 'wdio.conf.ts' : 'wdio.conf.js']),
    junit: NEEDS(
      'WebdriverIO needs `@wdio/junit-reporter` configured before it can emit JUnit XML.',
    ),
  },
  {
    runner: 'NIGHTWATCH',
    label: 'Nightwatch',
    language: 'JAVASCRIPT',
    testType: 'E2E',
    configGlobs: ['nightwatch.conf.{ts,js,cjs}', 'nightwatch.json'],
    deps: ['nightwatch'],
    bin: 'nightwatch',
    testGlobs: ['tests/**/*.{ts,js}', 'nightwatch/**/*.{ts,js}'],
    invoke: (ctx) => jsExec(ctx.pm, 'nightwatch', []),
    junit: {
      support: 'built-in',
      args: [],
      env: {},
      reportPath: null,
      note: 'Nightwatch writes one XML per suite into tests_output/; point reportPath at the file you want.',
    },
  },
  {
    runner: 'K6',
    label: 'k6',
    language: 'JAVASCRIPT',
    testType: 'LOAD',
    deps: ['k6'],
    depPatterns: [/^@?k6(\/|$)/],
    bin: 'k6',
    testGlobs: ['load/**/*.{js,ts}', 'k6/**/*.{js,ts}', 'perf/**/*.{js,ts}'],
    invoke: (ctx) => ({ command: 'k6', args: ['run', ctx.testFiles[0] ?? 'script.js'] }),
    junit: NO_JUNIT(
      'k6 reports through handleSummary(); QAAI reads its thresholds via the exit code.',
    ),
  },
  {
    runner: 'PA11Y',
    label: 'Pa11y',
    language: 'JAVASCRIPT',
    testType: 'ACCESSIBILITY',
    configGlobs: ['.pa11yci', '.pa11yci.json', 'pa11y.json', '.pa11yci.js'],
    deps: ['pa11y', 'pa11y-ci'],
    bin: 'pa11y-ci',
    invoke: (ctx) => jsExec(ctx.pm, 'pa11y-ci', []),
    junit: NEEDS(
      'pa11y-ci reports JSON; a JUnit reporter has to be added before QAAI can read cases.',
    ),
  },
  {
    runner: 'NEWMAN',
    label: 'Newman (Postman)',
    language: 'JAVASCRIPT',
    testType: 'API',
    deps: ['newman'],
    bin: 'newman',
    testGlobs: ['**/*.postman_collection.json'],
    invoke: (ctx) => jsExec(ctx.pm, 'newman', ['run', ctx.testFiles[0] ?? 'collection.json']),
    junit: BUILT_IN(['-r', 'junit', `--reporter-junit-export=${REPORT}`], REPORT),
  },
  // ── Python ────────────────────────────────────────────────────────────────
  {
    runner: 'PYTEST',
    label: 'pytest',
    language: 'PYTHON',
    testType: 'UNIT_GEN',
    configGlobs: ['pytest.ini', 'conftest.py', '**/conftest.py'],
    manifestSections: [
      {
        file: 'pyproject.toml',
        re: /\[tool\.pytest\.ini_options\]/,
        detail: '[tool.pytest.ini_options] in pyproject.toml',
      },
      { file: 'setup.cfg', re: /\[tool:pytest\]/, detail: '[tool:pytest] in setup.cfg' },
      { file: 'tox.ini', re: /\[pytest\]/, detail: '[pytest] in tox.ini' },
    ],
    deps: ['pytest'],
    depPatterns: [/^pytest[-_]/],
    testGlobs: ['tests/**/test_*.py', 'test/**/test_*.py', '**/test_*.py', '**/*_test.py'],
    invoke: (ctx) => pyExec(ctx.pm, 'pytest', []),
    junit: BUILT_IN([`--junitxml=${REPORT}`], REPORT),
  },
  {
    runner: 'DJANGO_TEST',
    label: 'Django test runner',
    language: 'PYTHON',
    testType: 'UNIT_GEN',
    toolchain: [
      {
        detail: 'manage.py at the project root (Django ships its own test runner)',
        file: 'manage.py',
      },
    ],
    deps: ['django'],
    testGlobs: ['**/tests/test_*.py', '**/tests.py', '**/test_*.py'],
    invoke: (ctx) => pyExec(ctx.pm, 'python3', ['manage.py', 'test']),
    junit: NEEDS('The Django runner needs `unittest-xml-reporting` before it can emit JUnit XML.'),
  },
  {
    runner: 'UNITTEST',
    label: 'unittest (stdlib)',
    language: 'PYTHON',
    testType: 'UNIT_GEN',
    builtin: true,
    testGlobs: ['tests/**/test_*.py', 'test/**/test_*.py', '**/test_*.py'],
    invoke: (ctx) => pyExec(ctx.pm, 'python3', ['-m', 'unittest', 'discover']),
    junit: NEEDS('unittest needs `unittest-xml-reporting` before it can emit JUnit XML.'),
  },
  {
    runner: 'BEHAVE',
    label: 'behave',
    language: 'PYTHON',
    testType: 'E2E',
    configGlobs: ['behave.ini'],
    deps: ['behave'],
    testGlobs: ['features/**/*.feature'],
    invoke: (ctx) => pyExec(ctx.pm, 'behave', []),
    junit: BUILT_IN(
      ['--junit', '--junit-directory', 'reports'],
      null,
      {},
      'behave writes one XML per feature into reports/; point reportPath at the file you want.',
    ),
  },
  {
    runner: 'ROBOT',
    label: 'Robot Framework',
    language: 'PYTHON',
    testType: 'E2E',
    deps: ['robotframework'],
    depPatterns: [/^robotframework-/],
    testGlobs: ['**/*.robot'],
    invoke: (ctx) => pyExec(ctx.pm, 'robot', ['--outputdir', 'reports', 'tests']),
    junit: NEEDS('Robot writes its own output.xml; converting it to JUnit needs an external step.'),
  },
  // ── JVM ───────────────────────────────────────────────────────────────────
  {
    runner: 'JUNIT5',
    label: 'JUnit 5',
    language: 'JAVA',
    testType: 'UNIT_GEN',
    languageByExt: { '.kt': 'KOTLIN', '.java': 'JAVA' },
    deps: [
      'junit-jupiter',
      'junit-jupiter-api',
      'junit-jupiter-engine',
      'spring-boot-starter-test',
    ],
    depPatterns: [/^junit-jupiter/, /^junit-platform/],
    toolchain: [
      {
        detail: 'src/test/java is the standard test source root the build tool already runs',
        when: (ctx) => ctx.testFiles.some((f) => f.startsWith('src/test/')),
      },
    ],
    configGlobs: ['src/test/resources/junit-platform.properties'],
    testGlobs: [
      'src/test/java/**/*{Test,Tests,IT}.{java,kt}',
      'src/test/kotlin/**/*{Test,Tests}.kt',
      '**/src/test/java/**/*{Test,Tests}.{java,kt}',
    ],
    invoke: jvmExec,
    junit: {
      support: 'built-in',
      args: [],
      env: {},
      reportPath: null,
      note: 'Surefire/Gradle write one XML per class under target/surefire-reports or build/test-results/test.',
    },
  },
  {
    runner: 'JUNIT4',
    label: 'JUnit 4',
    language: 'JAVA',
    testType: 'UNIT_GEN',
    languageByExt: { '.kt': 'KOTLIN', '.java': 'JAVA' },
    deps: ['junit', 'junit-vintage-engine'],
    testGlobs: ['src/test/java/**/*{Test,Tests}.java'],
    invoke: jvmExec,
    junit: {
      support: 'built-in',
      args: [],
      env: {},
      reportPath: null,
      note: 'Surefire/Gradle write one XML per class under target/surefire-reports or build/test-results/test.',
    },
  },
  {
    runner: 'TESTNG',
    label: 'TestNG',
    language: 'JAVA',
    testType: 'UNIT_GEN',
    configGlobs: ['testng.xml', 'src/test/resources/testng.xml'],
    deps: ['testng'],
    testGlobs: ['src/test/java/**/*{Test,Tests}.java'],
    invoke: jvmExec,
    junit: {
      support: 'built-in',
      args: [],
      env: {},
      reportPath: null,
      note: 'TestNG writes JUnit-compatible XML under target/surefire-reports.',
    },
  },
  {
    runner: 'KARATE',
    label: 'Karate',
    language: 'JAVA',
    testType: 'API',
    deps: ['karate-junit5', 'karate-core'],
    depPatterns: [/^karate-/],
    testGlobs: ['src/test/**/*.feature'],
    invoke: jvmExec,
    junit: {
      support: 'built-in',
      args: [],
      env: {},
      reportPath: null,
      note: 'Karate writes JUnit XML under target/karate-reports.',
    },
  },
  // ── Ruby ──────────────────────────────────────────────────────────────────
  {
    runner: 'RSPEC',
    label: 'RSpec',
    language: 'RUBY',
    testType: 'UNIT_GEN',
    configGlobs: ['.rspec', 'spec/spec_helper.rb', 'spec/rails_helper.rb'],
    deps: ['rspec', 'rspec-rails', 'rspec-core'],
    testGlobs: ['spec/**/*_spec.rb'],
    invoke: () => ({ command: 'bundle', args: ['exec', 'rspec'] }),
    junit: NEEDS(
      'RSpec needs the `rspec_junit_formatter` gem before it can emit JUnit XML.',
      ['--format', 'RspecJunitFormatter', '--out', REPORT],
      REPORT,
    ),
  },
  {
    runner: 'MINITEST',
    label: 'Minitest',
    language: 'RUBY',
    testType: 'UNIT_GEN',
    builtin: true,
    configGlobs: ['test/test_helper.rb'],
    deps: ['minitest', 'minitest-reporters'],
    testGlobs: ['test/**/*_test.rb'],
    invoke: () => ({ command: 'bundle', args: ['exec', 'rake', 'test'] }),
    junit: NEEDS('Minitest needs `minitest-reporters` before it can emit JUnit XML.'),
  },
  {
    runner: 'CUCUMBER_RUBY',
    label: 'Cucumber (Ruby)',
    language: 'RUBY',
    testType: 'E2E',
    deps: ['cucumber', 'cucumber-rails'],
    testGlobs: ['features/**/*.feature'],
    invoke: () => ({ command: 'bundle', args: ['exec', 'cucumber'] }),
    junit: BUILT_IN(
      ['--format', 'junit', '--out', 'reports'],
      null,
      {},
      'Cucumber writes one XML per feature into reports/; point reportPath at the file you want.',
    ),
  },
  // ── Go ────────────────────────────────────────────────────────────────────
  {
    runner: 'GO_TEST',
    label: 'go test',
    language: 'GO',
    testType: 'UNIT_GEN',
    builtin: true,
    toolchain: [{ detail: 'go.mod (the Go toolchain runs tests with `go test`)', file: 'go.mod' }],
    testGlobs: ['**/*_test.go'],
    invoke: () => ({ command: 'go', args: ['test', './...'] }),
    junit: NEEDS(
      '`go test` prints text; `gotestsum --junitfile` is the usual way to get JUnit XML.',
    ),
  },
  // ── .NET ──────────────────────────────────────────────────────────────────
  {
    runner: 'XUNIT',
    label: 'xUnit.net',
    language: 'CSHARP',
    testType: 'UNIT_GEN',
    deps: ['xunit', 'xunit.runner.visualstudio', 'xunit.v3'],
    depPatterns: [/^xunit(\.|$)/],
    toolchain: [
      {
        detail: 'Microsoft.NET.Test.Sdk marks a project `dotnet test` will run',
        when: (ctx) => ctx.hasDep('microsoft.net.test.sdk'),
      },
    ],
    testGlobs: ['**/*Tests/**/*.cs', 'tests/**/*.cs', 'test/**/*.cs'],
    invoke: () => ({ command: 'dotnet', args: ['test'] }),
    junit: NEEDS(
      '`dotnet test` writes TRX; the JUnitTestLogger package adds a JUnit logger.',
      ['--logger', `junit;LogFilePath=${REPORT}`],
      REPORT,
    ),
  },
  {
    runner: 'NUNIT',
    label: 'NUnit',
    language: 'CSHARP',
    testType: 'UNIT_GEN',
    deps: ['nunit', 'nunit3testadapter', 'nunit.analyzers'],
    testGlobs: ['**/*Tests/**/*.cs', 'tests/**/*.cs'],
    invoke: () => ({ command: 'dotnet', args: ['test'] }),
    junit: NEEDS('`dotnet test` writes TRX; the JUnitTestLogger package adds a JUnit logger.'),
  },
  {
    runner: 'MSTEST',
    label: 'MSTest',
    language: 'CSHARP',
    testType: 'UNIT_GEN',
    deps: ['mstest', 'mstest.testframework', 'mstest.testadapter'],
    testGlobs: ['**/*Tests/**/*.cs', 'tests/**/*.cs'],
    invoke: () => ({ command: 'dotnet', args: ['test'] }),
    junit: NEEDS('`dotnet test` writes TRX; the JUnitTestLogger package adds a JUnit logger.'),
  },
  // ── PHP ───────────────────────────────────────────────────────────────────
  {
    runner: 'PHPUNIT',
    label: 'PHPUnit',
    language: 'PHP',
    testType: 'UNIT_GEN',
    configGlobs: ['phpunit.xml', 'phpunit.xml.dist', 'phpunit.dist.xml'],
    deps: ['phpunit/phpunit'],
    depPatterns: [/^phpunit\//],
    testGlobs: ['tests/**/*Test.php', 'test/**/*Test.php'],
    invoke: () => ({ command: './vendor/bin/phpunit', args: [] }),
    junit: BUILT_IN(['--log-junit', REPORT], REPORT),
  },
  {
    runner: 'PEST',
    label: 'Pest',
    language: 'PHP',
    testType: 'UNIT_GEN',
    configGlobs: ['tests/Pest.php'],
    deps: ['pestphp/pest'],
    depPatterns: [/^pestphp\//],
    testGlobs: ['tests/**/*Test.php'],
    invoke: () => ({ command: './vendor/bin/pest', args: [] }),
    junit: BUILT_IN(['--log-junit', REPORT], REPORT),
  },
  // ── Rust / Swift ──────────────────────────────────────────────────────────
  {
    runner: 'CARGO_TEST',
    label: 'cargo test',
    language: 'RUST',
    testType: 'UNIT_GEN',
    builtin: true,
    toolchain: [
      {
        detail: 'Cargo.toml (the Rust toolchain runs tests with `cargo test`)',
        file: 'Cargo.toml',
      },
    ],
    testGlobs: ['tests/**/*.rs'],
    invoke: () => ({ command: 'cargo', args: ['test'] }),
    junit: NEEDS('`cargo test` prints text; `cargo2junit` converts it to JUnit XML.'),
  },
  {
    runner: 'XCTEST',
    label: 'XCTest (SwiftPM)',
    language: 'SWIFT',
    testType: 'UNIT_GEN',
    builtin: true,
    toolchain: [
      { detail: 'Package.swift (SwiftPM runs tests with `swift test`)', file: 'Package.swift' },
    ],
    testGlobs: ['Tests/**/*.swift'],
    invoke: () => ({ command: 'swift', args: ['test'] }),
    junit: BUILT_IN(['--xunit-output', REPORT], REPORT),
  },
];

// ─── Manifests ───────────────────────────────────────────────────────────────

interface DepEntry {
  name: string;
  /** Repo-relative manifest the dependency was declared in. */
  file: string;
  /** Where inside it, e.g. `devDependencies` — null for formats without sections. */
  section: string | null;
}

/** Files that make a directory a project root, and the manager they imply. */
const ROOT_MARKERS: Array<{ name: string; pm: DetectedPackageManager | null }> = [
  { name: 'package.json', pm: null },
  { name: 'pyproject.toml', pm: null },
  { name: 'setup.py', pm: 'pip' },
  { name: 'setup.cfg', pm: 'pip' },
  { name: 'requirements.txt', pm: 'pip' },
  { name: 'Pipfile', pm: 'pipenv' },
  { name: 'manage.py', pm: null },
  { name: 'pom.xml', pm: 'maven' },
  { name: 'build.gradle', pm: 'gradle' },
  { name: 'build.gradle.kts', pm: 'gradle' },
  { name: 'Gemfile', pm: 'bundler' },
  { name: 'go.mod', pm: 'go' },
  { name: 'composer.json', pm: 'composer' },
  { name: 'Cargo.toml', pm: 'cargo' },
  { name: 'Package.swift', pm: 'swiftpm' },
];

const LOCKFILE_PM: Array<{ name: string; pm: DetectedPackageManager }> = [
  { name: 'pnpm-lock.yaml', pm: 'pnpm' },
  { name: 'pnpm-workspace.yaml', pm: 'pnpm' },
  { name: 'yarn.lock', pm: 'yarn' },
  { name: 'bun.lockb', pm: 'bun' },
  { name: 'bun.lock', pm: 'bun' },
  { name: 'package-lock.json', pm: 'npm' },
  { name: 'npm-shrinkwrap.json', pm: 'npm' },
  { name: 'poetry.lock', pm: 'poetry' },
  { name: 'uv.lock', pm: 'uv' },
  { name: 'Gemfile.lock', pm: 'bundler' },
  { name: 'composer.lock', pm: 'composer' },
  { name: 'Cargo.lock', pm: 'cargo' },
  { name: 'go.sum', pm: 'go' },
];

/** Vendored and generated trees never describe the project, and they drown it. */
const IGNORED_SEGMENT =
  /^(node_modules|vendor|\.git|\.venv|venv|dist|build|out|target|bin|obj|coverage|\.next|__pycache__|site-packages|Pods|\.gradle|\.idea|\.tox)$/;

function isIgnored(path: string): boolean {
  return path.split('/').some((seg) => IGNORED_SEGMENT.test(seg));
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
}

function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i);
}

/** Normalise a listing entry: strip `./`, collapse separators, drop trailing slashes. */
function normalisePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
}

interface ParsedJson {
  ok: boolean;
  value: Record<string, unknown> | null;
}

function parseJson(content: string): ParsedJson {
  try {
    const value: unknown = JSON.parse(content);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown> };
    }
    return { ok: false, value: null };
  } catch {
    return { ok: false, value: null };
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Strip a version specifier off a requirement token: `pytest>=8.0` → `pytest`,
 * `@playwright/test` → `@playwright/test`. The leading `@` matters — dropping it
 * would silently lose every scoped npm package, which is most of them.
 */
function bareName(token: string): string {
  return (/^[@A-Za-z0-9][\w.\-/]*/.exec(token.trim())?.[0] ?? '').replace(/\[.*$/, '');
}

/**
 * Dependency extraction, per manifest format.
 *
 * Deliberately shallow — regexes over a narrow surface, the same trade external.ts
 * makes with JUnit XML. A dependency list is a flat set of names; adding a TOML
 * parser, an XML parser and a Ruby DSL evaluator to read three lines out of each
 * would be more risk than the parsing is worth, and every extracted name is
 * shown back to the user with the file it came from.
 */
function extractDeps(path: string, content: string, into: Map<string, DepEntry>): void {
  const base = basename(path);
  const add = (name: string, section: string | null) => {
    const clean = bareName(name);
    if (!clean) return;
    const key = clean.toLowerCase();
    if (!into.has(key)) into.set(key, { name: clean, file: path, section });
  };

  if (base === 'package.json' || base === 'composer.json') {
    const parsed = parseJson(content);
    if (!parsed.value) return;
    for (const section of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
      'require',
      'require-dev',
    ]) {
      for (const name of Object.keys(record(parsed.value[section]))) add(name, section);
    }
    return;
  }

  if (/^(requirements.*\.txt|constraints\.txt)$/.test(base)) {
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
      add(trimmed, null);
    }
    return;
  }

  if (base === 'pyproject.toml' || base === 'Pipfile' || base === 'Cargo.toml') {
    let section = '';
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      const header = /^\[([^\]]+)\]/.exec(trimmed);
      if (header) {
        section = header[1] ?? '';
        continue;
      }
      const inDeps = /dependencies|packages|dev-packages/i.test(section);
      // `name = "^1.2"` inside a dependency table.
      const keyed = /^([A-Za-z][\w.-]*)\s*=/.exec(trimmed);
      if (inDeps && keyed?.[1]) add(keyed[1], section);
      // `"pytest>=8.0",` inside a dependency array — either style is legal TOML.
      for (const quoted of trimmed.matchAll(/["']([A-Za-z][\w.\-[\]]*)[^"']*["']/g)) {
        if (quoted[1]) add(quoted[1], section || null);
      }
    }
    return;
  }

  if (base === 'Gemfile' || base.endsWith('.gemspec')) {
    for (const m of content.matchAll(/(?:^|\s)gem\s+["']([\w.-]+)["']/g))
      add(m[1] ?? '', 'Gemfile');
    for (const m of content.matchAll(
      /add_(?:development_)?dependency\s*\(?\s*["']([\w.-]+)["']/g,
    )) {
      add(m[1] ?? '', 'gemspec');
    }
    return;
  }

  if (base === 'pom.xml') {
    for (const m of content.matchAll(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/g)) {
      add(m[1] ?? '', 'dependencies');
    }
    return;
  }

  if (/\.(csproj|fsproj|vbproj)$/.test(base)) {
    for (const m of content.matchAll(/<PackageReference\s+Include="([^"]+)"/g)) {
      add(m[1] ?? '', 'PackageReference');
    }
    return;
  }

  if (base === 'build.gradle' || base === 'build.gradle.kts') {
    for (const m of content.matchAll(/["']([\w.-]+):([\w.-]+)(?::[^"']*)?["']/g)) {
      add(m[2] ?? '', 'dependencies');
    }
    return;
  }

  if (base === 'go.mod') {
    for (const m of content.matchAll(/^\s*([\w.\-/]+)\s+v\d[\w.\-+]*/gm)) {
      const modulePath = m[1] ?? '';
      add(modulePath, 'require');
      const last = modulePath.split('/').pop();
      if (last) add(last, 'require');
    }
  }
}

const MANIFEST_RE =
  /^(package\.json|composer\.json|pyproject\.toml|Pipfile|Cargo\.toml|Gemfile|.*\.gemspec|pom\.xml|build\.gradle(\.kts)?|go\.mod|requirements.*\.txt|constraints\.txt|setup\.cfg|tox\.ini|.*\.(csproj|fsproj|vbproj))$/;

// ─── Roots ───────────────────────────────────────────────────────────────────

/** A manifest we were told about but could not use, and why. */
interface Unreadable {
  path: string;
  reason: string;
}

interface Root {
  dir: string;
  /** True when this directory carried a root marker, as opposed to being the fallback. */
  declared: boolean;
  /** Root-relative paths, for glob matching. */
  rel: Set<string>;
  deps: Map<string, DepEntry>;
  pkgJson: Record<string, unknown> | null;
  scripts: Record<string, string>;
  /** Manifest text kept for section matching, keyed by basename. */
  texts: Map<string, string>;
  /** Manifests that exist but could not be read or parsed. */
  unreadable: Unreadable[];
  pms: PackageManagerDetection[];
}

function emptyRoot(dir: string, declared: boolean): Root {
  return {
    dir,
    declared,
    rel: new Set(),
    deps: new Map(),
    pkgJson: null,
    scripts: {},
    texts: new Map(),
    unreadable: [],
    pms: [],
  };
}

function relativeTo(root: string, path: string): string {
  return root === '.' ? path : path.slice(root.length + 1);
}

/** How a root reads in a sentence. */
function rootLabel(dir: string): string {
  return dir === '.' ? 'the repo root' : dir;
}

/** The deepest declared root that contains `path`; '.' when none does. */
function nearestRoot(path: string, dirs: string[]): string {
  let best = '.';
  for (const dir of dirs) {
    if (dir === '.') continue;
    if (path.startsWith(dir + '/') && dir.length > best.length) best = dir;
  }
  return best;
}

/** Roots inherit from their ancestors: monorepos hoist devDependencies to the top. */
function ancestorsOf(dir: string, roots: Map<string, Root>): Root[] {
  const out: Root[] = [];
  let current = dir;
  while (current !== '.') {
    current = dirname(current);
    const root = roots.get(current);
    if (root) out.push(root);
  }
  return out;
}

// ─── Detection ───────────────────────────────────────────────────────────────

const GENERATOR_LANGUAGES = new Set<string>(LANGUAGES);

const EXT_LANGUAGE: Record<string, DetectedLanguage> = {
  '.ts': 'TYPESCRIPT',
  '.tsx': 'TYPESCRIPT',
  '.mts': 'TYPESCRIPT',
  '.cts': 'TYPESCRIPT',
  '.js': 'JAVASCRIPT',
  '.jsx': 'JAVASCRIPT',
  '.mjs': 'JAVASCRIPT',
  '.cjs': 'JAVASCRIPT',
  '.py': 'PYTHON',
  '.java': 'JAVA',
  '.kt': 'KOTLIN',
  '.kts': 'KOTLIN',
  '.cs': 'CSHARP',
  '.rb': 'RUBY',
  '.go': 'GO',
  '.php': 'PHP',
  '.rs': 'RUST',
  '.swift': 'SWIFT',
};

/** Manifests that name a language outright, independent of how many files exist. */
const LANGUAGE_MARKERS: Array<{ file: RegExp; language: DetectedLanguage; detail: string }> = [
  { file: /^tsconfig(\..+)?\.json$/, language: 'TYPESCRIPT', detail: 'found tsconfig.json' },
  { file: /^go\.mod$/, language: 'GO', detail: 'found go.mod' },
  { file: /^pom\.xml$/, language: 'JAVA', detail: 'found pom.xml' },
  { file: /^Gemfile$/, language: 'RUBY', detail: 'found Gemfile' },
  { file: /^Cargo\.toml$/, language: 'RUST', detail: 'found Cargo.toml' },
  { file: /^Package\.swift$/, language: 'SWIFT', detail: 'found Package.swift' },
  { file: /^composer\.json$/, language: 'PHP', detail: 'found composer.json' },
  { file: /^pyproject\.toml$/, language: 'PYTHON', detail: 'found pyproject.toml' },
  { file: /\.sln$/, language: 'CSHARP', detail: 'found a .sln solution file' },
];

/**
 * score → 0–1, halving distance to 1 every 30 points.
 *
 * The number is a convenience for sorting UI, not a probability, and it is
 * capped below 1 on purpose: a static read of a file listing is never certain,
 * and a "100%" badge would invite people to stop reading the evidence.
 */
function toConfidence(score: number): number {
  return Math.min(0.97, Math.round((1 - 0.5 ** (score / 30)) * 100) / 100);
}

interface CandidateDraft {
  rule: RunnerRule;
  root: string;
  evidence: Evidence[];
  testFiles: string[];
  testGlobs: string[];
  language: DetectedLanguage;
}

/** An explicit `packageManager` field is a decision; a lockfile is a side effect of one. */
function pmRank(detection: PackageManagerDetection): number {
  const declared = detection.evidence.some((e) => e.kind === 'manifest-config') ? 5 : 0;
  return Math.max(...detection.evidence.map((e) => e.weight), 0) + declared;
}

function detectRoots(files: RepoFile[]): {
  roots: Map<string, Root>;
  all: string[];
  unreadableAll: Unreadable[];
} {
  const contents = new Map<string, string>();
  const all: string[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (!file || typeof file.path !== 'string') continue;
    const path = normalisePath(file.path);
    if (!path || isIgnored(path) || seen.has(path)) continue;
    seen.add(path);
    all.push(path);
    if (typeof file.content === 'string') contents.set(path, file.content);
  }
  // Sorted so the answer depends on the repo, never on the order the listing
  // happened to arrive in.
  all.sort();

  // A directory becomes a root when it carries a marker. A .sln promotes its own
  // directory so `dotnet test` runs at the solution, not inside one test project.
  const rootDirs = new Set<string>();
  for (const path of all) {
    const base = basename(path);
    if (ROOT_MARKERS.some((marker) => marker.name === base) || base.endsWith('.sln')) {
      rootDirs.add(dirname(path));
    }
  }
  if (!all.some((path) => path.endsWith('.sln'))) {
    for (const path of all) {
      if (/\.(csproj|fsproj|vbproj)$/.test(path)) rootDirs.add(dirname(path));
    }
  }

  const roots = new Map<string, Root>();
  for (const dir of rootDirs.size > 0 ? [...rootDirs] : ['.']) {
    roots.set(dir, emptyRoot(dir, rootDirs.has(dir)));
  }
  // Files above every declared root still need somewhere to live.
  if (!roots.has('.')) roots.set('.', emptyRoot('.', false));

  const dirList = [...roots.keys()];
  const unreadableAll: Unreadable[] = [];

  for (const path of all) {
    const dir = roots.has(dirname(path)) ? dirname(path) : nearestRoot(path, dirList);
    const root = roots.get(dir)!;
    root.rel.add(relativeTo(dir, path));

    const base = basename(path);
    const content = contents.get(path);
    const isManifest = MANIFEST_RE.test(base) || base.endsWith('.sln');

    const flag = (reason: string) => {
      const entry = { path, reason };
      root.unreadable.push(entry);
      unreadableAll.push(entry);
    };

    if (isManifest && content === undefined) {
      flag('its contents were not provided');
      continue;
    }
    if (content === undefined) continue;

    if (base === 'package.json' || base === 'composer.json') {
      const parsed = parseJson(content);
      if (!parsed.ok) {
        flag('it is not valid JSON');
        continue;
      }
      if (base === 'package.json' && parsed.value) {
        root.pkgJson = parsed.value;
        for (const [name, value] of Object.entries(record(parsed.value['scripts']))) {
          if (typeof value === 'string') root.scripts[name] = value;
        }
      }
    }
    if (isManifest || /^(pytest\.ini|setup\.cfg|tox\.ini)$/.test(base)) {
      root.texts.set(base, content);
      extractDeps(path, content, root.deps);
    }
  }

  for (const root of roots.values()) {
    const found = new Map<DetectedPackageManager, Evidence[]>();
    const abs = (rel: string) => (root.dir === '.' ? rel : `${root.dir}/${rel}`);
    const note = (pm: DetectedPackageManager, evidence: Evidence) => {
      found.set(pm, [...(found.get(pm) ?? []), evidence]);
    };

    const pmField = root.pkgJson?.['packageManager'];
    if (typeof pmField === 'string') {
      const name = pmField.split('@')[0] ?? '';
      if ((DETECTED_PACKAGE_MANAGERS as readonly string[]).includes(name)) {
        note(name as DetectedPackageManager, {
          kind: 'manifest-config',
          detail: `packageManager: "${pmField}" in package.json`,
          path: abs('package.json'),
          weight: EVIDENCE_WEIGHT['manifest-config'],
        });
      }
    }

    for (const rel of root.rel) {
      if (rel.includes('/')) continue;
      for (const marker of LOCKFILE_PM) {
        if (rel === marker.name) {
          note(marker.pm, {
            kind: 'config-file',
            detail: `found ${abs(rel)}`,
            path: abs(rel),
            weight: EVIDENCE_WEIGHT['config-file'],
          });
        }
      }
      for (const marker of ROOT_MARKERS) {
        if (rel === marker.name && marker.pm) {
          note(marker.pm, {
            kind: 'toolchain',
            detail: `found ${abs(rel)}`,
            path: abs(rel),
            weight: EVIDENCE_WEIGHT.toolchain,
          });
        }
      }
      if (rel.endsWith('.sln') || /\.(csproj|fsproj|vbproj)$/.test(rel)) {
        note('dotnet', {
          kind: 'toolchain',
          detail: `found ${abs(rel)}`,
          path: abs(rel),
          weight: EVIDENCE_WEIGHT.toolchain,
        });
      }
    }

    const pyproject = root.texts.get('pyproject.toml');
    if (pyproject && /\[tool\.poetry\]/.test(pyproject)) {
      note('poetry', {
        kind: 'manifest-config',
        detail: '[tool.poetry] in pyproject.toml',
        path: abs('pyproject.toml'),
        weight: EVIDENCE_WEIGHT['manifest-config'],
      });
    }

    root.pms = [...found.entries()]
      .map(([manager, evidence]) => ({ manager, root: root.dir, evidence }))
      .sort((a, b) => pmRank(b) - pmRank(a) || a.manager.localeCompare(b.manager));
  }

  return { roots, all, unreadableAll };
}

function pmForLanguage(
  root: Root,
  roots: Map<string, Root>,
  language: DetectedLanguage,
): DetectedPackageManager | null {
  const chain = [root, ...ancestorsOf(root.dir, roots)];
  for (const candidate of chain) {
    for (const detection of candidate.pms) {
      if (PM_FAMILY[detection.manager].includes(language)) return detection.manager;
    }
  }
  return null;
}

/** Collapse test-file paths into the directories a human would name. */
function testDirsOf(paths: string[]): string[] {
  const dirs = new Set(paths.map((p) => dirname(p)));
  const sorted = [...dirs].sort();
  // Drop any directory nested inside another one already listed.
  return sorted.filter(
    (dir) => !sorted.some((other) => other !== dir && dir.startsWith(other + '/')),
  );
}

function buildCandidate(
  draft: CandidateDraft,
  root: Root,
  roots: Map<string, Root>,
): RunnerCandidate {
  const evidence = [...draft.evidence].sort((a, b) => b.weight - a.weight);
  const score = evidence.reduce((sum, e) => sum + e.weight, 0);
  const pm = pmForLanguage(root, roots, draft.language);
  const relTests = draft.testFiles.map((p) => relativeTo(root.dir, p));

  const scriptName = draft.rule.bin ? findScript(root.scripts, draft.rule.bin) : null;

  const { command, args } = draft.rule.invoke({
    pm,
    has: (rel) => root.rel.has(rel),
    testFiles: relTests,
  });

  return {
    runner: draft.rule.runner,
    label: draft.rule.label,
    language: draft.language,
    testType: draft.rule.testType,
    root: root.dir,
    score,
    confidence: toConfidence(score),
    evidence,
    testDirs: testDirsOf(draft.testFiles),
    testGlobs: draft.testGlobs,
    testFileCount: draft.testFiles.length,
    sampleTests: draft.testFiles.slice(0, 3),
    invocation: {
      command,
      args,
      cwd: root.dir,
      script: scriptName,
      junit: draft.rule.junit,
    },
    packageManager: pm,
    generatorLanguage: GENERATOR_LANGUAGES.has(draft.language)
      ? (draft.language as Language)
      : null,
  };
}

/** The script that already runs this binary — 'test' wins, then the first by name. */
function findScript(scripts: Record<string, string>, bin: string): string | null {
  const re = new RegExp(`(?:^|[\\s/"'])${escapeRe(bin)}(?:[\\s"']|$)`);
  const matches = Object.keys(scripts)
    .filter((name) => re.test(scripts[name] ?? ''))
    .sort();
  if (matches.includes('test')) return 'test';
  return matches[0] ?? null;
}

/**
 * Detect a project's languages, test runners, package managers, test locations
 * and invocations from a file listing.
 *
 * Returns ranked candidates with the evidence for each. An empty `candidates`
 * list is a real answer — "this repo has no tests" — not a failure.
 */
export function detectProject(files: RepoFile[]): ProjectDetection {
  const input = Array.isArray(files) ? files : [];
  const { roots, all, unreadableAll } = detectRoots(input);

  const notes: string[] = [];
  const warnings: string[] = unreadableAll.map(
    (entry) => `${entry.path} is present but ${entry.reason}, so nothing could be read from it.`,
  );

  const drafts: CandidateDraft[] = [];

  for (const root of roots.values()) {
    const relPaths = [...root.rel];
    const degraded = root.unreadable.length > 0;
    const hasDep = (name: string) => root.deps.has(name.toLowerCase());

    for (const rule of RULES) {
      const evidence: Evidence[] = [];
      const abs = (rel: string) => (root.dir === '.' ? rel : `${root.dir}/${rel}`);

      // 1. Config files — the strongest claim a repo can make.
      for (const glob of rule.configGlobs ?? []) {
        const re = globToRe(glob);
        const hit = relPaths.find((rel) => re.test(rel));
        if (hit && evidence.filter((e) => e.kind === 'config-file').length < 2) {
          evidence.push({
            kind: 'config-file',
            detail: `found ${abs(hit)}`,
            path: abs(hit),
            weight: EVIDENCE_WEIGHT['config-file'],
          });
        }
      }

      // 2. Config carried inside a manifest.
      for (const key of rule.pkgKeys ?? []) {
        if (root.pkgJson && key in root.pkgJson) {
          evidence.push({
            kind: 'manifest-config',
            detail: `${key} key in package.json`,
            path: abs('package.json'),
            weight: EVIDENCE_WEIGHT['manifest-config'],
          });
        }
      }
      for (const section of rule.manifestSections ?? []) {
        const text = root.texts.get(section.file);
        if (text && section.re.test(text)) {
          evidence.push({
            kind: 'manifest-config',
            detail: section.detail,
            path: abs(section.file),
            weight: EVIDENCE_WEIGHT['manifest-config'],
          });
        }
      }

      // 3. Test files. Each file counts once, for the first glob it matches, so a
      //    single spec cannot be double-counted by three overlapping patterns.
      const matchedFiles: string[] = [];
      const matchedGlobs: string[] = [];
      const claimed = new Set<string>();
      for (const glob of rule.testGlobs ?? []) {
        const re = globToRe(glob);
        const hits = relPaths.filter((rel) => !claimed.has(rel) && re.test(rel));
        if (hits.length === 0) continue;
        for (const hit of hits) claimed.add(hit);
        matchedGlobs.push(glob);
        matchedFiles.push(...hits.map((rel) => abs(rel)));
        if (matchedGlobs.length <= 3) {
          const sample = hits
            .slice(0, 2)
            .map((rel) => abs(rel))
            .join(', ');
          const counted = hits.length === 1 ? '1 file matches' : `${hits.length} files match`;
          evidence.push({
            kind: 'file-convention',
            detail: `${counted} ${glob} (${sample}${hits.length > 2 ? ', …' : ''})`,
            path: abs(hits[0]!),
            // Volume corroborates a convention a little, but never enough to
            // outrank a config file — 400 spec files still only say "someone
            // named files this way".
            weight: EVIDENCE_WEIGHT['file-convention'] + Math.min(10, hits.length - 1),
          });
        }
      }
      matchedFiles.sort();

      // 4. Toolchain markers: the manifest or layout the runner ships with.
      for (const marker of rule.toolchain ?? []) {
        const fileOk = marker.file ? root.rel.has(marker.file) : true;
        const whenOk = marker.when
          ? marker.when({
              has: (rel) => root.rel.has(rel),
              hasDep,
              testFiles: matchedFiles.map((p) => relativeTo(root.dir, p)),
            })
          : true;
        if (fileOk && whenOk) {
          evidence.push({
            kind: 'toolchain',
            detail: marker.detail,
            path: marker.file ? abs(marker.file) : null,
            weight: EVIDENCE_WEIGHT.toolchain,
          });
        }
      }

      // 5. Package scripts that already run the tool.
      if (rule.bin) {
        const scriptName = findScript(root.scripts, rule.bin);
        if (scriptName) {
          const value = root.scripts[scriptName] ?? '';
          evidence.push({
            kind: 'script',
            detail: `"${scriptName}": "${value.slice(0, 60)}" in package.json`,
            path: abs('package.json'),
            weight: EVIDENCE_WEIGHT.script,
          });
        }
      }

      // 6. Dependencies. Local first; a hoisted one only counts as corroboration,
      //    because "installed at the monorepo root" says nothing about which
      //    workspace uses it.
      const localDeps: DepEntry[] = [];
      const inheritedDeps: DepEntry[] = [];
      const wanted = (name: string) =>
        (rule.deps ?? []).includes(name) || (rule.depPatterns ?? []).some((re) => re.test(name));

      for (const [key, entry] of root.deps) {
        if (wanted(key)) localDeps.push(entry);
      }
      if (localDeps.length === 0) {
        for (const ancestor of ancestorsOf(root.dir, roots)) {
          for (const [key, entry] of ancestor.deps) {
            if (wanted(key)) inheritedDeps.push(entry);
          }
        }
      }
      const depsToCredit =
        localDeps.length > 0 ? localDeps : evidence.length > 0 ? inheritedDeps : [];
      for (const dep of depsToCredit.slice(0, 2)) {
        evidence.push({
          kind: 'dependency',
          detail: dep.section
            ? `${dep.name} in ${dep.section} (${dep.file})`
            : `${dep.name} in ${dep.file}`,
          path: dep.file,
          weight: EVIDENCE_WEIGHT.dependency,
        });
      }

      if (evidence.length === 0) continue;

      // A runner you have not installed is not a runner you use. Only toolchain
      // runners — and roots whose manifest we could not read — may be nominated
      // on filename evidence alone.
      const onlyConventions = evidence.every((e) => e.kind === 'file-convention');
      if (onlyConventions && !rule.builtin && !degraded) continue;

      let language = rule.language;
      if (rule.languageByExt) {
        const counts = new Map<DetectedLanguage, number>();
        for (const file of matchedFiles) {
          const mapped = rule.languageByExt[extname(file)];
          if (mapped) counts.set(mapped, (counts.get(mapped) ?? 0) + 1);
        }
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        if (top) language = top[0];
      }

      drafts.push({
        rule,
        root: root.dir,
        evidence,
        testFiles: matchedFiles,
        testGlobs: matchedGlobs,
        language,
      });
    }
  }

  const candidates = drafts
    .map((draft) => buildCandidate(draft, roots.get(draft.root)!, roots))
    // Total and input-independent: score, then root, then runner name. Two
    // runners really can tie — in a monorepo they routinely do — and when they
    // do the order must still not depend on the order the listing arrived in.
    .sort(
      (a, b) =>
        b.score - a.score || a.root.localeCompare(b.root) || a.runner.localeCompare(b.runner),
    );

  // ── Languages ─────────────────────────────────────────────────────────────
  const langCounts = new Map<DetectedLanguage, number>();
  const langEvidence = new Map<DetectedLanguage, Evidence[]>();
  for (const path of all) {
    const language = EXT_LANGUAGE[extname(path)];
    if (language) langCounts.set(language, (langCounts.get(language) ?? 0) + 1);
    const base = basename(path);
    for (const marker of LANGUAGE_MARKERS) {
      if (marker.file.test(base)) {
        const list = langEvidence.get(marker.language) ?? [];
        if (!list.some((e) => e.detail === marker.detail)) {
          list.push({
            kind: 'config-file',
            detail: marker.detail,
            path,
            weight: EVIDENCE_WEIGHT['config-file'],
          });
        }
        langEvidence.set(marker.language, list);
        langCounts.set(marker.language, langCounts.get(marker.language) ?? 0);
      }
    }
  }

  const languages: LanguageDetection[] = [...langCounts.entries()]
    .map(([language, fileCount]) => {
      const evidence = [...(langEvidence.get(language) ?? [])];
      if (fileCount > 0) {
        evidence.push({
          kind: 'file-convention',
          detail: `${fileCount} source file${fileCount === 1 ? '' : 's'} for ${language.toLowerCase()}`,
          path: null,
          weight: EVIDENCE_WEIGHT['file-convention'],
        });
      }
      return {
        language,
        fileCount,
        evidence,
        supportedByGenerator: GENERATOR_LANGUAGES.has(language),
      };
    })
    .sort((a, b) => b.fileCount - a.fileCount || a.language.localeCompare(b.language));

  const packageManagers = [...roots.values()]
    .flatMap((root) => root.pms)
    .sort((a, b) => pmRank(b) - pmRank(a) || a.root.localeCompare(b.root));

  // ── Notes ─────────────────────────────────────────────────────────────────
  const declaredRoots = [...roots.values()]
    .filter((root) => root.declared)
    .map((root) => root.dir)
    .sort();
  const workspaceDeclared = all.some((path) =>
    /^(pnpm-workspace\.yaml|lerna\.json|turbo\.json|nx\.json|rush\.json)$/.test(basename(path)),
  );
  const monorepo = declaredRoots.length > 1 || workspaceDeclared;
  const hasTests = candidates.some((c) => c.testFileCount > 0);

  if (all.length === 0) {
    notes.push('No files were given, so there is nothing to detect.');
  } else if (candidates.length === 0) {
    notes.push(
      'No test runner detected. Nothing matched a runner config file, dependency, or test-file ' +
        'convention — this looks like a repo with no tests, so QAAI is not guessing a framework for it.',
    );
  }

  if (candidates.length > 0 && !hasTests) {
    const top = candidates[0]!;
    notes.push(
      `${top.label} is configured in ${rootLabel(top.root)} but no files matched its test ` +
        'conventions — the runner is installed and the suite is empty, or its tests live somewhere ' +
        'unusual. QAAI is not claiming this repo has tests.',
    );
  }

  // Conflicts, explained. Only runners competing for the same job in the same
  // workspace conflict; Vitest in one package and Cypress in another do not.
  const byRootAndType = new Map<string, RunnerCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.root}::${candidate.testType}`;
    const list = byRootAndType.get(key) ?? [];
    list.push(candidate);
    byRootAndType.set(key, list);
  }
  for (const group of byRootAndType.values()) {
    const [winner, loser] = group;
    if (!winner || !loser) continue;
    const top = winner.evidence[0];
    const next = loser.evidence[0];
    if (!top || !next || top.weight <= next.weight) continue;
    notes.push(
      `${winner.label} and ${loser.label} both look present in ${rootLabel(winner.root)}. ` +
        `Ranked ${winner.label} first: "${top.detail}" is a ${KIND_LABEL[top.kind]}, while ` +
        `${loser.label}'s strongest signal is "${next.detail}" — only a ${KIND_LABEL[next.kind]}.`,
    );
  }

  const workspacesWithTests = new Set(candidates.map((c) => c.root));
  if (monorepo && candidates.length > 1) {
    notes.push(
      `Found ${candidates.length} runners across ${workspacesWithTests.size} workspace` +
        `${workspacesWithTests.size === 1 ? '' : 's'}. All are listed — a monorepo genuinely has ` +
        'several, so pick one per suite rather than assuming a single winner.',
    );
  }

  for (const root of roots.values()) {
    if (root.unreadable.length > 0) {
      notes.push(
        `${root.unreadable.map((entry) => entry.path).join(', ')} could not be read, so ranking in ` +
          `${rootLabel(root.dir)} fell back to filename conventions alone. Confidence there is ` +
          'lower than it would be with the manifest, and a runner may be missing entirely.',
      );
    }
  }

  return {
    candidates,
    languages,
    packageManagers,
    hasTests,
    monorepo,
    roots: declaredRoots.length > 0 ? declaredRoots : ['.'],
    notes,
    warnings,
  };
}
