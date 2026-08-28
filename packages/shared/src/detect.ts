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
 * What this file does *not* own is the runner vocabulary. A candidate's id,
 * label, suite type, command, arguments and report plan all come from the
 * catalogue in ecosystems.ts, because a detector that also describes how to run
 * things is a second copy of the same facts — and this repo has already been
 * bitten twice by the copies disagreeing. Every rule below names an
 * `EcosystemId`, so a rule pointing at a runner the catalogue does not have is
 * a compile error, not a candidate with no command.
 *
 * Detection's own concern is what is left: what the repo *says*, how strongly,
 * where its workspaces are, and how sure any of it makes us. Those observations
 * live here rather than in constants.ts on purpose — they are facts about
 * someone else's repo, not QAAI domain enums, so they have no Prisma mirror and
 * are exempt from the enum-drift check.
 */

import { LANGUAGES, type Language, type TestType } from './constants';
import {
  ECOSYSTEM_LANGUAGES,
  PACKAGE_MANAGERS,
  PACKAGE_MANAGER_LANGUAGES,
  ecosystemById,
  ecosystemRunArgs,
  junitPlanFor,
  type Ecosystem,
  type EcosystemId,
  type EcosystemLanguage,
  type JUnitPlan,
  type PackageManager,
} from './ecosystems';

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

/**
 * The runners detection can nominate are catalogue records, named by their
 * catalogue id. There is no second list here to fall out of step with the first
 * one — `DETECTABLE_RUNNERS` below is derived from the rule table, and the rule
 * table cannot name a runner ecosystems.ts does not define.
 */
export type { EcosystemId } from './ecosystems';

/**
 * Languages we can *observe*, in the SHOUTING spelling the DB-backed `Language`
 * enum uses. The same list as the catalogue's `ECOSYSTEM_LANGUAGES`, cased
 * differently and derived from it rather than retyped — this is exactly the
 * kind of "two lists of the same thing" that drifts.
 *
 * Deliberately wider than `LANGUAGES` in constants.ts, which is the narrower set
 * the generator can emit: a repo is allowed to be Rust even though QAAI cannot
 * write Rust tests, and saying so is more useful than refusing to name it.
 */
export type DetectedLanguage = Uppercase<EcosystemLanguage>;

const asDetected = (slug: EcosystemLanguage): DetectedLanguage =>
  slug.toUpperCase() as DetectedLanguage;

export const DETECTED_LANGUAGES: readonly DetectedLanguage[] = ECOSYSTEM_LANGUAGES.map(asDetected);

/**
 * Which languages a package manager serves; used to pair one found in a repo
 * with a runner found in the same repo. The pairing is the catalogue's —
 * detection only recases it.
 */
const familyOf = (pm: PackageManager): DetectedLanguage[] =>
  PACKAGE_MANAGER_LANGUAGES[pm].map(asDetected);

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

export interface Invocation {
  /** The executable. argv-style, because the runner spawns without a shell. */
  command: string;
  args: string[];
  /** Working directory relative to the repo root; '.' for the root itself. */
  cwd: string;
  /** Env the runner needs for an ordinary run — `mix test` wants MIX_ENV=test. */
  env: Record<string, string>;
  /** The existing package script that already runs this tool, if there is one. */
  script: string | null;
  /**
   * What it takes to get a report QAAI can read, from the catalogue record.
   * `JUnitPlan` is defined in ecosystems.ts because it is an answer about the
   * runner, not about this repo — every repo running Jest gets the same one.
   */
  junit: JUnitPlan;
}

export interface RunnerCandidate {
  /** The catalogue id — `ecosystemById(candidate.runner)` is always a record. */
  runner: EcosystemId;
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
  packageManager: PackageManager | null;
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
  manager: PackageManager;
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

/**
 * Maven and Gradle are separate catalogue records — same runner, same tests,
 * report in a completely different directory — so the repo has to say which one
 * a rule means. Nominating the Maven record for a Gradle project would send a
 * reader to target/surefire-reports and find nothing there.
 */
const byBuildTool =
  (maven: EcosystemId, gradle: EcosystemId) =>
  (has: (relPath: string) => boolean): EcosystemId =>
    has('pom.xml') || has('mvnw') ? maven : gradle;

interface RunnerRule {
  /**
   * The catalogue record this rule detects, and the whole reason detection no
   * longer describes runners itself: the id, label, suite type, command,
   * arguments and report plan are all read from it. A function when one
   * detection covers two records that differ only in how they are built.
   *
   * Typed as `EcosystemId`, so a rule for a runner the catalogue does not carry
   * does not compile.
   */
  ecosystem: EcosystemId | ((has: (relPath: string) => boolean) => EcosystemId);
  /**
   * The language to report for this runner. The catalogue lists every language
   * a runner *can* run; detection has to name the one this repo is in, and
   * `languageByExt` refines it further from the files actually found.
   */
  language: DetectedLanguage;
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
  /**
   * CLI name as it appears in a package script, used for `script` evidence.
   * Only set where a script mentioning it means something: `node` and `python3`
   * appear in scripts that have nothing to do with tests.
   */
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
}

/** Where detection asks for reports. A file for most runners, a directory for a few. */
const REPORT = 'reports/junit.xml';
const REPORT_DIR = 'reports';

/**
 * The rule table. Ordering is irrelevant — ranking comes from evidence, not from
 * position — so entries are grouped by language for reading, not for precedence.
 *
 * Every entry is evidence and nothing else. If you find yourself wanting to add
 * a command, a flag or a report path here, it belongs in the catalogue record
 * this rule points at.
 */
const RULES: RunnerRule[] = [
  // ── JavaScript / TypeScript: unit ─────────────────────────────────────────
  {
    ecosystem: 'vitest',
    language: 'TYPESCRIPT',
    configGlobs: ['vitest.config.{ts,js,mts,mjs,cts,cjs}', 'vitest.workspace.{ts,js,json}'],
    deps: ['vitest', '@vitest/ui', '@vitest/coverage-v8'],
    bin: 'vitest',
    testGlobs: [
      'test/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs}',
      'tests/**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs}',
      '**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs}',
    ],
  },
  {
    ecosystem: 'jest',
    language: 'TYPESCRIPT',
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
  },
  {
    ecosystem: 'mocha',
    language: 'JAVASCRIPT',
    configGlobs: ['.mocharc.{json,jsonc,yml,yaml,js,cjs}'],
    pkgKeys: ['mocha'],
    deps: ['mocha'],
    bin: 'mocha',
    testGlobs: ['test/**/*.{js,mjs,cjs,ts}'],
  },
  {
    ecosystem: 'ava',
    language: 'JAVASCRIPT',
    configGlobs: ['ava.config.{js,cjs,mjs}'],
    pkgKeys: ['ava'],
    deps: ['ava'],
    bin: 'ava',
    testGlobs: ['test/**/*.{js,mjs,cjs,ts}', '**/*.test.{js,mjs,cjs,ts}'],
  },
  {
    ecosystem: 'node-test',
    language: 'JAVASCRIPT',
    builtin: true,
    // Narrow on purpose: `**/*.test.js` alone is far more often Jest or Vitest,
    // and nominating node:test for every such file would be noise, not detection.
    testGlobs: ['test/**/*.{test,spec}.{js,mjs,cjs}', '**/*.test.{mjs,mts}'],
  },
  // ── JavaScript / TypeScript: browser ──────────────────────────────────────
  {
    ecosystem: 'playwright',
    language: 'TYPESCRIPT',
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
  },
  {
    ecosystem: 'cypress',
    language: 'TYPESCRIPT',
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
  },
  {
    ecosystem: 'webdriverio',
    language: 'TYPESCRIPT',
    configGlobs: ['wdio.conf.{ts,js,mjs,cjs}', '**/wdio.conf.{ts,js}'],
    depPatterns: [/^@wdio\//],
    deps: ['webdriverio'],
    bin: 'wdio',
    testGlobs: ['test/specs/**/*.{ts,js}', '**/*.e2e.{ts,js}'],
  },
  {
    ecosystem: 'nightwatch',
    language: 'JAVASCRIPT',
    configGlobs: ['nightwatch.conf.{ts,js,cjs}', 'nightwatch.json'],
    deps: ['nightwatch'],
    bin: 'nightwatch',
    testGlobs: ['tests/**/*.{ts,js}', 'nightwatch/**/*.{ts,js}'],
  },
  {
    ecosystem: 'k6',
    language: 'JAVASCRIPT',
    deps: ['k6'],
    depPatterns: [/^@?k6(\/|$)/],
    bin: 'k6',
    testGlobs: ['load/**/*.{js,ts}', 'k6/**/*.{js,ts}', 'perf/**/*.{js,ts}'],
  },
  {
    ecosystem: 'pa11y-ci',
    language: 'JAVASCRIPT',
    configGlobs: ['.pa11yci', '.pa11yci.json', 'pa11y.json', '.pa11yci.js'],
    deps: ['pa11y', 'pa11y-ci'],
    bin: 'pa11y-ci',
  },
  {
    ecosystem: 'newman',
    language: 'JAVASCRIPT',
    deps: ['newman'],
    bin: 'newman',
    testGlobs: ['**/*.postman_collection.json'],
  },
  // ── Python ────────────────────────────────────────────────────────────────
  {
    ecosystem: 'pytest',
    language: 'PYTHON',
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
  },
  {
    ecosystem: 'django-test',
    language: 'PYTHON',
    toolchain: [
      {
        detail: 'manage.py at the project root (Django ships its own test runner)',
        file: 'manage.py',
      },
    ],
    deps: ['django'],
    testGlobs: ['**/tests/test_*.py', '**/tests.py', '**/test_*.py'],
  },
  {
    ecosystem: 'unittest',
    language: 'PYTHON',
    builtin: true,
    testGlobs: ['tests/**/test_*.py', 'test/**/test_*.py', '**/test_*.py'],
  },
  {
    ecosystem: 'behave',
    language: 'PYTHON',
    configGlobs: ['behave.ini'],
    deps: ['behave'],
    testGlobs: ['features/**/*.feature'],
  },
  {
    ecosystem: 'robot-framework',
    language: 'PYTHON',
    deps: ['robotframework'],
    depPatterns: [/^robotframework-/],
    testGlobs: ['**/*.robot'],
  },
  // ── JVM ───────────────────────────────────────────────────────────────────
  {
    ecosystem: byBuildTool('junit5-maven', 'junit5-gradle'),
    language: 'JAVA',
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
  },
  {
    ecosystem: byBuildTool('junit4-maven', 'junit4-gradle'),
    language: 'JAVA',
    languageByExt: { '.kt': 'KOTLIN', '.java': 'JAVA' },
    deps: ['junit', 'junit-vintage-engine'],
    testGlobs: ['src/test/java/**/*{Test,Tests}.java'],
  },
  {
    ecosystem: byBuildTool('testng', 'testng-gradle'),
    language: 'JAVA',
    configGlobs: ['testng.xml', 'src/test/resources/testng.xml'],
    deps: ['testng'],
    testGlobs: ['src/test/java/**/*{Test,Tests}.java'],
  },
  {
    ecosystem: 'karate',
    language: 'JAVA',
    deps: ['karate-junit5', 'karate-core'],
    depPatterns: [/^karate-/],
    testGlobs: ['src/test/**/*.feature'],
  },
  // ── Ruby ──────────────────────────────────────────────────────────────────
  {
    ecosystem: 'rspec',
    language: 'RUBY',
    configGlobs: ['.rspec', 'spec/spec_helper.rb', 'spec/rails_helper.rb'],
    deps: ['rspec', 'rspec-rails', 'rspec-core'],
    testGlobs: ['spec/**/*_spec.rb'],
  },
  {
    ecosystem: 'minitest',
    language: 'RUBY',
    builtin: true,
    configGlobs: ['test/test_helper.rb'],
    deps: ['minitest', 'minitest-reporters'],
    testGlobs: ['test/**/*_test.rb'],
  },
  {
    ecosystem: 'cucumber-ruby',
    language: 'RUBY',
    deps: ['cucumber', 'cucumber-rails'],
    testGlobs: ['features/**/*.feature'],
  },
  // ── Go ────────────────────────────────────────────────────────────────────
  {
    ecosystem: 'go-test',
    language: 'GO',
    builtin: true,
    toolchain: [{ detail: 'go.mod (the Go toolchain runs tests with `go test`)', file: 'go.mod' }],
    testGlobs: ['**/*_test.go'],
  },
  // ── .NET ──────────────────────────────────────────────────────────────────
  {
    ecosystem: 'xunit',
    language: 'CSHARP',
    deps: ['xunit', 'xunit.runner.visualstudio', 'xunit.v3'],
    depPatterns: [/^xunit(\.|$)/],
    toolchain: [
      {
        detail: 'Microsoft.NET.Test.Sdk marks a project `dotnet test` will run',
        when: (ctx) => ctx.hasDep('microsoft.net.test.sdk'),
      },
    ],
    testGlobs: ['**/*Tests/**/*.cs', 'tests/**/*.cs', 'test/**/*.cs'],
  },
  {
    ecosystem: 'nunit',
    language: 'CSHARP',
    deps: ['nunit', 'nunit3testadapter', 'nunit.analyzers'],
    testGlobs: ['**/*Tests/**/*.cs', 'tests/**/*.cs'],
  },
  {
    ecosystem: 'mstest',
    language: 'CSHARP',
    deps: ['mstest', 'mstest.testframework', 'mstest.testadapter'],
    testGlobs: ['**/*Tests/**/*.cs', 'tests/**/*.cs'],
  },
  // ── PHP ───────────────────────────────────────────────────────────────────
  {
    ecosystem: 'phpunit',
    language: 'PHP',
    configGlobs: ['phpunit.xml', 'phpunit.xml.dist', 'phpunit.dist.xml'],
    deps: ['phpunit/phpunit'],
    depPatterns: [/^phpunit\//],
    testGlobs: ['tests/**/*Test.php', 'test/**/*Test.php'],
  },
  {
    ecosystem: 'pest',
    language: 'PHP',
    configGlobs: ['tests/Pest.php'],
    deps: ['pestphp/pest'],
    depPatterns: [/^pestphp\//],
    testGlobs: ['tests/**/*Test.php'],
  },
  // ── Rust / Swift ──────────────────────────────────────────────────────────
  {
    ecosystem: 'cargo-test',
    language: 'RUST',
    builtin: true,
    toolchain: [
      {
        detail: 'Cargo.toml (the Rust toolchain runs tests with `cargo test`)',
        file: 'Cargo.toml',
      },
    ],
    testGlobs: ['tests/**/*.rs'],
  },
  {
    ecosystem: 'swift-test',
    language: 'SWIFT',
    builtin: true,
    toolchain: [
      { detail: 'Package.swift (SwiftPM runs tests with `swift test`)', file: 'Package.swift' },
    ],
    testGlobs: ['Tests/**/*.swift'],
  },
];

/**
 * Every runner detection can nominate, as catalogue ids. Derived from the rule
 * table so it cannot describe a coverage we do not have.
 */
export const DETECTABLE_RUNNERS: readonly EcosystemId[] = [
  ...new Set(
    RULES.flatMap((rule) =>
      typeof rule.ecosystem === 'function'
        ? [rule.ecosystem(() => true), rule.ecosystem(() => false)]
        : [rule.ecosystem],
    ),
  ),
];

/**
 * The catalogue record a rule means, for this repo. Never undefined while
 * `EcosystemId` types the field — the throw is here because "that cannot
 * happen" is what the last two drifts were called.
 */
function recordFor(
  rule: RunnerRule,
  has: (relPath: string) => boolean,
): { id: EcosystemId; entry: Ecosystem } {
  const id = typeof rule.ecosystem === 'function' ? rule.ecosystem(has) : rule.ecosystem;
  const entry = ecosystemById(id);
  if (!entry) throw new Error(`detect.ts names "${id}", which the ecosystem catalogue does not`);
  return { id, entry };
}

/**
 * The catalogue says how a runner is invoked in general. Detection has read the
 * repo and knows which of its interchangeable front-ends is actually there — so
 * an adapter may only *re-point* a command at the client that will resolve it.
 * It never adds arguments: arguments are the record's, and a second place to
 * keep them is how these two files drifted apart in the first place.
 */
function adaptToRepo(
  base: { command: string; args: string[] },
  pm: PackageManager | null,
  has: (relPath: string) => boolean,
): { command: string; args: string[] } {
  // A config file named in the command has to be the one that is actually
  // there: a TypeScript WebdriverIO project keeps wdio.conf.ts, and the .js
  // name would fail with "config not found" rather than with a test failure.
  // Only fires when the named file is absent and its twin is present.
  const args = base.args.map((arg) => {
    if (!arg.endsWith('.js') || has(arg)) return arg;
    const ts = `${arg.slice(0, -3)}.ts`;
    return has(ts) ? ts : arg;
  });

  // Every npm-compatible client spells "run the project-local binary" its own way.
  if (base.command === 'npx') {
    const [bin, ...rest] = args;
    if (bin) {
      if (pm === 'pnpm') return { command: 'pnpm', args: ['exec', bin, ...rest] };
      if (pm === 'yarn') return { command: 'yarn', args: [bin, ...rest] };
      if (pm === 'bun') return { command: 'bunx', args: [bin, ...rest] };
    }
    return { command: base.command, args };
  }
  // These three own the virtualenv; a bare python3 would be the system one.
  if (base.command === 'python3' && (pm === 'poetry' || pm === 'uv' || pm === 'pipenv')) {
    return { command: pm, args: ['run', base.command, ...args] };
  }
  // The wrapper a repo ships pins the build-tool version the project expects,
  // and is the one command guaranteed to exist on a fresh worker.
  if (base.command === 'mvn' && has('mvnw')) return { command: './mvnw', args };
  if (base.command === './gradlew' && !has('gradlew')) return { command: 'gradle', args };
  return { command: base.command, args };
}

// ─── Manifests ───────────────────────────────────────────────────────────────

interface DepEntry {
  name: string;
  /** Repo-relative manifest the dependency was declared in. */
  file: string;
  /** Where inside it, e.g. `devDependencies` — null for formats without sections. */
  section: string | null;
}

/** Files that make a directory a project root, and the manager they imply. */
const ROOT_MARKERS: Array<{ name: string; pm: PackageManager | null }> = [
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

const LOCKFILE_PM: Array<{ name: string; pm: PackageManager }> = [
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

/** The two ini files that are not manifests but are still read for their text. */
const READ_AS_TEXT_RE = /^(pytest\.ini|setup\.cfg|tox\.ini)$/;

/**
 * Whether detection needs this file's CONTENT, or only its path.
 *
 * `RepoFile.content` is optional because a listing is cheap and contents are
 * not — but which files are worth reading was, until now, knowable only by
 * reading this module. That made the caller guess, and a guess here is not
 * cosmetic: a manifest supplied WITHOUT its content is recorded as unreadable
 * (see `detectRoots`), so under-reading does not merely lose signal, it makes
 * detection warn about files the caller was holding all along.
 *
 * The first-run funnel walks a whole repo in the browser. It reads the ~dozen
 * files this returns true for and passes the other twenty thousand as bare
 * paths, which is the difference between a folder pick that is instant and one
 * that loads a monorepo into a tab as text.
 */
/**
 * Files that plausibly hold a ROUTE TABLE, which must be read as text.
 *
 * Added because the analyser stopped inferring routes from file paths in apps
 * whose routes are declared in code — correctly, since `src/pages/Foo.tsx` is a
 * component there and not a URL. But the funnel was sending bodies for
 * MANIFESTS ONLY, so the route table never arrived, and the honest "I could not
 * read your routes" replaced the dishonest "here are 192 of them" with nothing
 * at all. For a React Router or Vue Router app that is an empty plan, which is
 * the whole product.
 *
 * Deliberately narrow. This list is read in the browser, over a whole repo, and
 * every entry is a file loaded into a tab as text: `routes` and `router` by
 * name catch `crmRoutes.tsx` and `router/index.ts`, and the four entry-point
 * names catch the common `<BrowserRouter>` host. A pattern like `*.tsx` would
 * be every file in the repository.
 */
const ROUTE_TABLE_RE = /^(?:app|main|routes?|router)\.[cm]?[jt]sx?$/i;
const ROUTE_NAMED_RE = /rout(?:e|er)s?\.[cm]?[jt]sx?$/i;
/**
 * `index` is the entry point that hosts `<BrowserRouter>` in a Create React App
 * — and it is also the name of every barrel file in every `src/**` tree ever
 * written. Reading them all would load a large fraction of a repo into the tab
 * to find one router.
 *
 * So it counts only at the top AND only in JSX: `index.tsx` or `src/index.tsx`,
 * never `src/components/button/index.ts` and never a bare `src/index.ts`. An
 * entry point lives at an entrance, and one that mounts a router renders
 * markup — a `.ts` index is a barrel file, which is the thing being avoided.
 */
const ENTRY_INDEX_RE = /^(?:[^/]+\/)?index\.[cm]?[jt]sx$/i;
/**
 * An index whose PARENT is the routing directory, at any depth.
 *
 * `src/router/index.ts` is Vue Router's documented layout and a common React
 * one, and it is a route table wherever it sits — the folder name says so. This
 * is not the barrel-file problem the rule above avoids: `components/index.ts`
 * does not match, only `router/` and `routes/` do.
 */
const ROUTE_DIR_INDEX_RE = /(?:^|\/)rout(?:e|er)s?\/index\.[cm]?[jt]sx?$/i;

export function needsContent(path: string): boolean {
  const normal = normalisePath(path);
  const base = basename(normal);
  if (MANIFEST_RE.test(base) || base.endsWith('.sln') || READ_AS_TEXT_RE.test(base)) return true;
  return (
    ROUTE_TABLE_RE.test(base) ||
    ROUTE_NAMED_RE.test(base) ||
    ENTRY_INDEX_RE.test(normal) ||
    ROUTE_DIR_INDEX_RE.test(normal)
  );
}

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
    if (isManifest || READ_AS_TEXT_RE.test(base)) {
      root.texts.set(base, content);
      extractDeps(path, content, root.deps);
    }
  }

  for (const root of roots.values()) {
    const found = new Map<PackageManager, Evidence[]>();
    const abs = (rel: string) => (root.dir === '.' ? rel : `${root.dir}/${rel}`);
    const note = (pm: PackageManager, evidence: Evidence) => {
      found.set(pm, [...(found.get(pm) ?? []), evidence]);
    };

    const pmField = root.pkgJson?.['packageManager'];
    if (typeof pmField === 'string') {
      const name = pmField.split('@')[0] ?? '';
      if ((PACKAGE_MANAGERS as readonly string[]).includes(name)) {
        note(name as PackageManager, {
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
): PackageManager | null {
  const chain = [root, ...ancestorsOf(root.dir, roots)];
  for (const candidate of chain) {
    for (const detection of candidate.pms) {
      if (familyOf(detection.manager).includes(language)) return detection.manager;
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

  const has = (rel: string): boolean => root.rel.has(rel);
  const scriptName = draft.rule.bin ? findScript(root.scripts, draft.rule.bin) : null;

  // Everything about the runner itself is read from here: what it is called,
  // what it runs, and what it can report. Detection contributes only what it
  // observed — the client that will resolve the binary, the build wrapper the
  // repo ships, and the one test file the runners with a positional argument
  // need.
  const { id, entry } = recordFor(draft.rule, has);
  const { command, args } = adaptToRepo(
    { command: entry.command, args: ecosystemRunArgs(entry, relTests[0] ?? null) },
    pm,
    has,
  );

  return {
    runner: id,
    label: entry.label,
    language: draft.language,
    testType: entry.defaultTestType,
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
      env: { ...entry.env },
      script: scriptName,
      junit: junitPlanFor(entry, { file: REPORT, directory: REPORT_DIR }),
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
