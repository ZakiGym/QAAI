/**
 * The ecosystem catalogue — every major test runner, as data.
 *
 * `UI_FRAMEWORKS` in constants.ts answers "what drives the browser". It does
 * not answer the question a repository actually asks: *how do I run the tests
 * that are already here, and where does the report land?* Nothing in QAAI knew
 * that pytest wants `--junitxml=`, that Surefire writes into
 * target/surefire-reports/, that `go test` streams JSON to stdout, or that
 * `dotnet test` wants `--logger trx`. Without that, "we support your framework"
 * means "you configure it yourself".
 *
 * Each record carries the four facts nobody remembers: how to *detect* the
 * runner, how to *invoke* it, which flag makes it emit a *machine-readable*
 * report, and *where that report ends up*.
 *
 * This file is the runner vocabulary for the whole package. `detect.ts` decides
 * *which* runner a repository uses and how sure it is; what that runner is
 * called, what it is written in, how it is invoked and what it can report are
 * answered here and nowhere else. `EcosystemId` is the id type detection
 * returns, so a rule pointing at a record that does not exist is a build error
 * rather than a runtime shrug.
 *
 * Rules for this file:
 *
 *  1. A record is DATA. Adding the 54th runner is a new entry, never a new
 *     branch. Nothing here imports the runner package, and nothing here
 *     executes anything — it is a lookup table with a doc comment.
 *
 *  2. `args` is an argv array, spawned WITHOUT a shell (see
 *     packages/runner/src/plugins/external.ts). There are no pipes, no `&&`,
 *     no quoting. Where a runner only produces a report through a pipe
 *     (`xcodebuild … | xcbeautify`), the record says so in `notes` and does not
 *     pretend the one-command model covers it.
 *
 *  3. Honesty over coverage. A runner that cannot emit a machine-readable
 *     report gets `reportFormat: 'exit-code'` and `reportAvailability: 'none'`
 *     — see `unittest`, `cargo-test`, `xcodebuild`. A green tick derived from
 *     an exit code is worth less than a JUnit file, and the catalogue says
 *     which one you are getting.
 *
 * On `npx`: it resolves the project-local binary, but when the package is
 * *missing* it will fetch it from the registry — arbitrary code, at test time.
 * A worker should prefer `./node_modules/.bin/<bin>`, or pass `--no` so a
 * missing dependency fails loudly instead of installing itself.
 *
 * On `python3`: the records assume a POSIX worker. On Windows images the
 * executable is `python`, and inside an activated venv either name works.
 */

import type { Language, TestType } from './constants';
import type { ExternalReportFormat } from './schemas';

// ─── Report formats ──────────────────────────────────────────────────────────

/**
 * The report shapes the catalogue relies on. These names are deliberately the
 * ones already used by `packages/runner/src/reports/types.ts`, so the parser
 * directory and this catalogue share one vocabulary instead of two.
 *
 * `dart-json` is in this list and has no parser yet. That is the point: the
 * list is the specification, and `ReportParserRegistry` turns the gap into a
 * compile error rather than a silent "0 tests found" at 3am.
 */
export const PARSEABLE_REPORT_FORMATS = [
  'junit-xml',
  'tap',
  'trx',
  'nunit3',
  'jest-json',
  'pytest-json',
  'rspec-json',
  'cucumber-json',
  'go-json',
  'dart-json',
] as const;
export type ParseableReportFormat = (typeof PARSEABLE_REPORT_FORMATS)[number];

/**
 * Everything a record may name, including the absence of a report. 'exit-code'
 * never reaches a parser — it means the runner told us pass/fail and nothing
 * else, and the run detail page will have no per-test rows.
 */
export const ECOSYSTEM_REPORT_FORMATS = [...PARSEABLE_REPORT_FORMATS, 'exit-code'] as const;
export type EcosystemReportFormat = (typeof ECOSYSTEM_REPORT_FORMATS)[number];

/**
 * The exhaustiveness hook. The parser package declares its registry as
 * `ReportParserRegistry<Parser>`; a format added here with no parser written
 * for it fails the build in packages/runner, which is the only place that
 * failure is cheap.
 *
 * ```ts
 * const PARSERS: ReportParserRegistry<(raw: string) => ParsedReport> = {
 *   'junit-xml': parseJUnitXml,
 *   // …one entry per format, or this object does not compile
 * };
 * ```
 */
export type ReportParserRegistry<T> = { readonly [F in ParseableReportFormat]: T };

export interface ReportFormatInfo {
  readonly label: string;
  /** How the bytes are laid out — a parser needs to know before it starts. */
  readonly shape: 'xml' | 'json' | 'ndjson' | 'text' | 'none';
  /**
   * What to put in `externalTestSpecSchema.reportFormat` today, or null when
   * the external plugin has no reader for it yet. Null is not a design gap in
   * the format — it is an honest statement about `runExternal`, which parses
   * everything that is not 'exit-code' as JUnit XML.
   */
  readonly externalSpecFormat: ExternalReportFormat | null;
}

export const REPORT_FORMAT_INFO: Record<EcosystemReportFormat, ReportFormatInfo> = {
  'junit-xml': {
    label: 'JUnit / xUnit XML',
    shape: 'xml',
    externalSpecFormat: 'junit',
  },
  tap: {
    label: 'TAP 13/14',
    shape: 'text',
    externalSpecFormat: null,
  },
  trx: {
    label: 'VSTest TRX',
    shape: 'xml',
    // XML, but <UnitTestResult> — parseJUnit finds no <testcase> and reports zero tests.
    externalSpecFormat: null,
  },
  nunit3: {
    label: 'NUnit 3 result XML',
    shape: 'xml',
    externalSpecFormat: null,
  },
  'jest-json': {
    label: 'Jest JSON (also emitted by Vitest)',
    shape: 'json',
    externalSpecFormat: null,
  },
  'pytest-json': {
    label: 'pytest-json-report JSON',
    shape: 'json',
    externalSpecFormat: null,
  },
  'rspec-json': {
    label: 'RSpec JSON',
    shape: 'json',
    externalSpecFormat: null,
  },
  'cucumber-json': {
    label: 'Cucumber JSON',
    shape: 'json',
    externalSpecFormat: null,
  },
  'go-json': {
    label: '`go test -json` event stream',
    shape: 'ndjson',
    externalSpecFormat: null,
  },
  'dart-json': {
    label: 'package:test JSON event stream',
    shape: 'ndjson',
    externalSpecFormat: null,
  },
  'exit-code': {
    label: 'Exit code only',
    shape: 'none',
    externalSpecFormat: 'exit-code',
  },
};

// ─── Languages & package managers ────────────────────────────────────────────

/**
 * Wider than `LANGUAGES` in constants.ts on purpose. That union mirrors a
 * Postgres enum and describes what the *generator* can write; this one
 * describes what the *catalogue* can run, and a Rust shop should be able to
 * point QAAI at `cargo nextest` without a database migration.
 */
export const ECOSYSTEM_LANGUAGES = [
  'typescript',
  'javascript',
  'python',
  'java',
  'kotlin',
  'groovy',
  'scala',
  'csharp',
  'ruby',
  'go',
  'php',
  'rust',
  'swift',
  'dart',
  'elixir',
] as const;
export type EcosystemLanguage = (typeof ECOSYSTEM_LANGUAGES)[number];

export const ECOSYSTEM_LANGUAGE_LABELS: Record<EcosystemLanguage, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  java: 'Java',
  kotlin: 'Kotlin',
  groovy: 'Groovy',
  scala: 'Scala',
  csharp: 'C#',
  ruby: 'Ruby',
  go: 'Go',
  php: 'PHP',
  rust: 'Rust',
  swift: 'Swift',
  dart: 'Dart',
  elixir: 'Elixir',
};

/** Bridge from the DB-backed `Language` enum to the catalogue's slugs. */
export const LANGUAGE_TO_ECOSYSTEM_LANGUAGE: Record<Language, EcosystemLanguage> = {
  TYPESCRIPT: 'typescript',
  JAVASCRIPT: 'javascript',
  JAVA: 'java',
  PYTHON: 'python',
  CSHARP: 'csharp',
  RUBY: 'ruby',
  KOTLIN: 'kotlin',
  GO: 'go',
  PHP: 'php',
};

/**
 * Not "how you install the runner" — *which manifest the project already has*,
 * named after the command you would type. That is what detection reads, and
 * what tells you whether `npx`, `pnpm exec`, `poetry run`, `bundle exec` or
 * `./vendor/bin/` is the right prefix.
 *
 * One list, two granularities, on purpose. A record names the *coarse* member
 * for its language — a Jest record says `npm`, because every npm-compatible
 * client resolves it the same way — while detection may report the finer client
 * it actually found in the repo (`pnpm`, `yarn`, `poetry`, `uv`, `pipenv`).
 * They are the same vocabulary because they answer the same question; splitting
 * them into a catalogue list and a detection list is what let the two drift.
 *
 * `go` and `dotnet` are named for the tool, not for go.mod or NuGet: nobody
 * types `nuget` any more, and every other member here is already a command.
 */
export const PACKAGE_MANAGERS = [
  // JavaScript / TypeScript. The last three are npm-compatible clients whose
  // *commands* differ (`pnpm exec` vs `yarn` vs `bunx`), which is the only
  // reason detection needs to tell them apart.
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  // Python. pip is the floor; the rest own the virtualenv and want `<pm> run`.
  'pip',
  'poetry',
  'uv',
  'pipenv',
  // JVM
  'maven',
  'gradle',
  'sbt',
  // .NET
  'dotnet',
  'bundler',
  'go',
  'composer',
  'cargo',
  'swiftpm',
  'xcode',
  'pub',
  'hex',
] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/**
 * Which languages a manager serves. Detection uses it to pair a manager it
 * found with a runner it found — a repo with both a Gemfile and a package.json
 * must not run Vitest through `bundle exec`.
 *
 * Not derived from the records: `pnpm`, `poetry` and friends serve languages no
 * record names them for, and a table that only listed the managers some record
 * happened to use would quietly answer "no language" for the rest.
 */
export const PACKAGE_MANAGER_LANGUAGES: Record<PackageManager, readonly EcosystemLanguage[]> = {
  npm: ['typescript', 'javascript'],
  pnpm: ['typescript', 'javascript'],
  yarn: ['typescript', 'javascript'],
  bun: ['typescript', 'javascript'],
  deno: ['typescript', 'javascript'],
  pip: ['python'],
  poetry: ['python'],
  uv: ['python'],
  pipenv: ['python'],
  maven: ['java', 'kotlin', 'groovy'],
  gradle: ['java', 'kotlin', 'groovy', 'scala'],
  sbt: ['scala'],
  dotnet: ['csharp'],
  bundler: ['ruby'],
  go: ['go'],
  composer: ['php'],
  cargo: ['rust'],
  swiftpm: ['swift'],
  xcode: ['swift'],
  pub: ['dart'],
  hex: ['elixir'],
};

// ─── The record ──────────────────────────────────────────────────────────────

/**
 * Evidence that a runner is in use. Any single hit is a signal; a scanner is
 * free to weight them. Every field is optional so a new record only fills in
 * what actually applies to it.
 *
 * Deliberately coarse, and deliberately not what detect.ts runs on. Detection
 * ranks — a config file outranks a dependency outranks a filename — and that
 * needs tiers, dependency patterns, manifest sections and workspace scoping
 * that do not belong in a lookup table. These hints are the starting point for
 * the runners detection has no rule for yet, and the record is still the only
 * place that says how to *invoke* any of them.
 */
export interface EcosystemDetect {
  /** Paths or globs, relative to the repo root. */
  readonly files?: readonly string[];
  /** Dependency names as they appear in the manifest of `packageManager`. */
  readonly dependencies?: readonly string[];
  /** Dotted keys inside a structured manifest — 'scripts.test', 'tool.pytest.ini_options'. */
  readonly manifestKeys?: readonly string[];
  /** Literal text in a build file no dotted key can address (pom.xml, build.gradle, Gemfile). */
  readonly manifestContains?: readonly string[];
  /** Import lines inside test sources. Weakest signal, last resort. */
  readonly imports?: readonly string[];
}

/**
 * Where QAAI reads results from after the command exits.
 *
 *  - 'file'   one file at `reportPath`.
 *  - 'glob'   several files; `reportPath` is the pattern (Surefire writes one
 *             XML per class, Cucumber one per feature).
 *  - 'stdout' nothing is written to disk; the child's stdout *is* the report.
 *  - 'none'   there is nothing to read.
 */
export type ReportTarget = 'file' | 'glob' | 'stdout' | 'none';

/**
 *  - 'native' a flag on the runner itself.
 *  - 'config' the runner can emit it, but only from a config file — no flag.
 *  - 'plugin' an extra package must be installed first (`reporterPackage`).
 *  - 'none'   the runner cannot emit a machine-readable report at all.
 */
export type ReportAvailability = 'native' | 'config' | 'plugin' | 'none';

/** Substituted into `args` by `resolveEcosystemCommand`. */
export const REPORT_PATH_PLACEHOLDER = '{{reportPath}}';

/**
 * Substituted the same way, for the handful of runners that take the test file
 * itself as a positional argument (`k6 run script.js`). `defaultTestPath` is
 * what it falls back to when the caller has no concrete file yet — a literal
 * `{{testPath}}` must never reach a spawn.
 */
export const TEST_PATH_PLACEHOLDER = '{{testPath}}';

/**
 * How to get JUnit XML out of a runner whose own report is something else.
 *
 * `runExternal` reads JUnit XML or an exit code, and nothing in between (see
 * `REPORT_FORMAT_INFO[…].externalSpecFormat`). So a record whose `reportFormat`
 * is jest-json, rspec-json, trx or go-json has a second, worse route to a
 * report QAAI can actually parse, and that route is data too — writing it out
 * in prose in `notes` is how detection ended up hand-rolling its own copy.
 */
export interface JUnitRoute {
  /** Appended to the plain run. Empty when the route is a config file or another tool. */
  readonly args?: readonly string[];
  /** Env the route needs, e.g. where jest-junit writes. */
  readonly env?: Readonly<Record<string, string>>;
  /** The package that must be installed first. Absent when nothing is missing. */
  readonly requires?: string;
  /** Where the XML lands. Absent when it is a glob, or when there is no single file. */
  readonly reportPath?: string;
  /** Said in full, because this is the part a user has to act on. */
  readonly note: string;
}

export interface Ecosystem {
  readonly id: string;
  readonly label: string;
  readonly languages: readonly EcosystemLanguage[];
  readonly packageManager: PackageManager;
  /** Which QAAI test type a run from this runner files under. A hint, not a constraint. */
  readonly defaultTestType: TestType;
  readonly detect: EcosystemDetect;
  /** argv[0]. Never interpolated, never passed to a shell. */
  readonly command: string;
  /**
   * argv[1..] for the *whole* command, report flags included, in the order the
   * runner needs them — `robot` wants `--xunit` before its test directory, and
   * `gotestsum` wants `--junitfile` before the `--`. This is the authoritative
   * invocation; `reportArgs` says which of these tokens are only here for the
   * report, so a caller that just wants the tests run can drop them.
   */
  readonly args: readonly string[];
  /**
   * The subset of `args` that exists solely to produce `reportFormat`, in the
   * same order — an in-order subsequence, checked by `ecosystemRunArgs`.
   * Removing it leaves a command that still runs the suite and reports nothing.
   */
  readonly reportArgs: readonly string[];
  /** Env the runner needs for an ordinary run. */
  readonly env?: Readonly<Record<string, string>>;
  /** Env that exists only to place the report — Playwright takes its path this way. */
  readonly reportEnv?: Readonly<Record<string, string>>;
  /** Stands in for TEST_PATH_PLACEHOLDER when the caller has no file to name. */
  readonly defaultTestPath?: string;
  readonly reportFormat: EcosystemReportFormat;
  readonly reportAvailability: ReportAvailability;
  /** What the placeholder stands for — pytest takes a file, behave a directory. */
  readonly reportFlagTakes: 'file' | 'directory' | 'none';
  readonly reportTarget: ReportTarget;
  /** Where the report lands. A glob when `reportTarget` is 'glob'; '' when there is none. */
  readonly reportPath: string;
  /** Other shapes this runner can produce, if a caller prefers one. */
  readonly alternateReportFormats?: readonly EcosystemReportFormat[];
  /** The package that has to exist for `reportAvailability: 'plugin'`. */
  readonly reporterPackage?: string;
  /** Set when `reportFormat` is not junit-xml but JUnit XML is reachable anyway. */
  readonly junitRoute?: JUnitRoute;
  readonly installHint: string;
  readonly notes: string;
}

// ─── The catalogue ───────────────────────────────────────────────────────────

export const ECOSYSTEMS = [
  // ── JavaScript / TypeScript ────────────────────────────────────────────────
  {
    id: 'jest',
    label: 'Jest',
    languages: ['typescript', 'javascript'],
    packageManager: 'npm',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs'],
      dependencies: ['jest', 'ts-jest', '@jest/globals'],
      manifestKeys: ['jest'],
    },
    command: 'npx',
    args: ['jest', '--ci', '--json', `--outputFile=${REPORT_PATH_PLACEHOLDER}`],
    reportArgs: ['--json', `--outputFile=${REPORT_PATH_PLACEHOLDER}`],
    reportFormat: 'jest-json',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'reports/jest.json',
    alternateReportFormats: ['junit-xml'],
    reporterPackage: 'jest-junit',
    junitRoute: {
      args: ['--reporters=default', '--reporters=jest-junit'],
      env: { JEST_JUNIT_OUTPUT_FILE: REPORT_PATH_PLACEHOLDER },
      requires: 'jest-junit',
      reportPath: REPORT_PATH_PLACEHOLDER,
      note: 'Jest needs the `jest-junit` reporter installed before it can emit JUnit XML, and jest-junit takes its path from JEST_JUNIT_OUTPUT_FILE rather than from a flag — without the env var it writes ./junit.xml wherever the run started.',
    },
    installHint: 'npm install --save-dev jest',
    notes:
      "`--json --outputFile` is built in and needs no extra package, which is why it is the default here. The junit alternative takes its path from an env var, not a flag: `--reporters=jest-junit` plus JEST_JUNIT_OUTPUT_FILE. `--ci` stops Jest writing new snapshots on a mismatch — without it a snapshot test can 'pass' by rewriting the thing it was checking.",
  },
  {
    id: 'vitest',
    label: 'Vitest',
    languages: ['typescript', 'javascript'],
    packageManager: 'npm',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.workspace.ts'],
      dependencies: ['vitest', '@vitest/ui'],
      imports: ["from 'vitest'"],
    },
    command: 'npx',
    args: ['vitest', 'run', '--reporter=junit', `--outputFile=${REPORT_PATH_PLACEHOLDER}`],
    reportArgs: ['--reporter=junit', `--outputFile=${REPORT_PATH_PLACEHOLDER}`],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'reports/vitest-junit.xml',
    alternateReportFormats: ['jest-json'],
    installHint: 'npm install --save-dev vitest',
    notes:
      '`run` is not optional — plain `vitest` starts a watcher and the run never ends. With more than one reporter the flag becomes `--outputFile.junit=…`, because a single `--outputFile` cannot address two of them. Its JSON reporter emits the Jest shape.',
  },
  {
    id: 'mocha',
    label: 'Mocha',
    languages: ['typescript', 'javascript'],
    packageManager: 'npm',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['.mocharc.json', '.mocharc.yml', '.mocharc.yaml', '.mocharc.js', '.mocharc.cjs'],
      dependencies: ['mocha'],
      manifestKeys: ['mocha'],
    },
    command: 'npx',
    args: [
      'mocha',
      '--reporter',
      'xunit',
      '--reporter-option',
      `output=${REPORT_PATH_PLACEHOLDER}`,
    ],
    reportArgs: ['--reporter', 'xunit', '--reporter-option', `output=${REPORT_PATH_PLACEHOLDER}`],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'reports/mocha-junit.xml',
    reporterPackage: 'mocha-junit-reporter',
    installHint: 'npm install --save-dev mocha',
    notes:
      "The bundled `xunit` reporter avoids a dependency; mocha-junit-reporter produces richer classnames and suite nesting if you already have it. Mocha's own `json` reporter writes to stdout, so it cannot be used by anything that reads a file.",
  },
  {
    id: 'ava',
    label: 'AVA',
    languages: ['typescript', 'javascript'],
    packageManager: 'npm',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['ava.config.js', 'ava.config.cjs', 'ava.config.mjs'],
      dependencies: ['ava'],
      manifestKeys: ['ava'],
    },
    command: 'npx',
    args: ['ava', '--tap'],
    reportArgs: ['--tap'],
    reportFormat: 'tap',
    reportAvailability: 'native',
    reportFlagTakes: 'none',
    reportTarget: 'stdout',
    reportPath: '',
    installHint: 'npm install --save-dev ava',
    notes:
      'AVA has no reporter that writes a file — TAP goes to stdout and that is the whole story. Converting to JUnit means piping into tap-junit, which the no-shell spawn cannot do, so the caller must capture stdout instead. `runExternal` reads a file today, so AVA needs the stdout path before this record works end to end.',
  },
  {
    id: 'node-test',
    label: 'node:test',
    languages: ['typescript', 'javascript'],
    packageManager: 'npm',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['test/**/*.test.js', 'test/**/*.test.mjs', 'test/**/*.test.ts'],
      imports: ["from 'node:test'", "require('node:test')"],
      manifestKeys: ['scripts.test'],
    },
    command: 'node',
    args: [
      '--test',
      '--test-reporter=junit',
      `--test-reporter-destination=${REPORT_PATH_PLACEHOLDER}`,
    ],
    reportArgs: ['--test-reporter=junit', `--test-reporter-destination=${REPORT_PATH_PLACEHOLDER}`],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'reports/node-test.xml',
    alternateReportFormats: ['tap'],
    installHint: 'built into Node — nothing to install',
    notes:
      'Reporter and destination are two separate flags and both are required; with only the first, the XML goes to stdout. Detection is awkward on purpose — there is no dependency to find, so it comes down to the `node:test` import. Node ≤ 18 has no junit reporter, only TAP.',
  },
  {
    id: 'bun-test',
    label: 'bun test',
    languages: ['typescript', 'javascript'],
    packageManager: 'bun',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['bun.lockb', 'bun.lock', 'bunfig.toml'],
      imports: ["from 'bun:test'"],
    },
    command: 'bun',
    args: ['test', '--reporter=junit', `--reporter-outfile=${REPORT_PATH_PLACEHOLDER}`],
    reportArgs: ['--reporter=junit', `--reporter-outfile=${REPORT_PATH_PLACEHOLDER}`],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'reports/bun-junit.xml',
    installHint: 'curl -fsSL https://bun.sh/install | bash',
    notes:
      "Bun's own runner, not Jest — the API is Jest-compatible but the flags are not. The junit reporter arrived in Bun 1.1; older Bun has no machine-readable output at all. A repo with bun.lockb may still run its tests with Jest or Vitest, so check the dependencies before assuming this record applies.",
  },
  {
    id: 'deno-test',
    label: 'deno test',
    languages: ['typescript', 'javascript'],
    packageManager: 'deno',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['deno.json', 'deno.jsonc', 'deno.lock'],
      imports: ['jsr:@std/assert', 'https://deno.land/std'],
    },
    command: 'deno',
    args: ['test', '--allow-all', `--junit-path=${REPORT_PATH_PLACEHOLDER}`],
    reportArgs: [`--junit-path=${REPORT_PATH_PLACEHOLDER}`],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'reports/deno-junit.xml',
    installHint: 'curl -fsSL https://deno.land/install.sh | sh',
    notes:
      '`--allow-all` is a blunt instrument — it hands the suite the whole machine. Narrow it to the permissions the tests actually need (`--allow-net=localhost --allow-read`). Deno before 1.39 could only send junit to stdout via `--reporter=junit`.',
  },
  {
    id: 'cypress',
    label: 'Cypress',
    languages: ['typescript', 'javascript'],
    packageManager: 'npm',
    defaultTestType: 'E2E',
    detect: {
      files: ['cypress.config.ts', 'cypress.config.js', 'cypress.json', 'cypress/**/*.cy.ts'],
      dependencies: ['cypress'],
    },
    command: 'npx',
    args: [
      'cypress',
      'run',
      '--reporter',
      'junit',
      '--reporter-options',
      `mochaFile=${REPORT_PATH_PLACEHOLDER}`,
    ],
    reportArgs: [
      '--reporter',
      'junit',
      '--reporter-options',
      `mochaFile=${REPORT_PATH_PLACEHOLDER}`,
    ],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'glob',
    reportPath: 'reports/cypress-[hash].xml',
    installHint: 'npm install --save-dev cypress',
    notes:
      'Cypress bundles mocha-junit-reporter, so no extra package. One caveat that bites everyone: with several spec files a fixed mochaFile is overwritten by each spec — put `[hash]` in the name and read the directory as a glob. Cypress also needs a browser on the worker image.',
  },
  {
    id: 'playwright',
    label: 'Playwright Test',
    languages: ['typescript', 'javascript'],
    packageManager: 'npm',
    defaultTestType: 'E2E',
    detect: {
      files: ['playwright.config.ts', 'playwright.config.js'],
      dependencies: ['@playwright/test'],
      imports: ["from '@playwright/test'"],
    },
    command: 'npx',
    args: ['playwright', 'test', '--reporter=junit'],
    reportEnv: { PLAYWRIGHT_JUNIT_OUTPUT_NAME: REPORT_PATH_PLACEHOLDER },
    reportArgs: ['--reporter=junit'],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'reports/playwright-junit.xml',
    installHint: 'npm install --save-dev @playwright/test && npx playwright install --with-deps',
    notes:
      'The path is an env var, not a flag — without PLAYWRIGHT_JUNIT_OUTPUT_NAME the XML goes to stdout and mixes with the test output. QAAI runs Playwright natively for its own E2E tests; this record is for a repo that already owns a Playwright suite and wants it run as-is.',
  },
  {
    id: 'webdriverio',
    label: 'WebdriverIO',
    languages: ['typescript', 'javascript'],
    packageManager: 'npm',
    defaultTestType: 'E2E',
    detect: {
      files: ['wdio.conf.js', 'wdio.conf.ts'],
      dependencies: ['@wdio/cli', 'webdriverio'],
    },
    command: 'npx',
    args: ['wdio', 'run', 'wdio.conf.js'],
    reportArgs: [],
    reportFormat: 'junit-xml',
    reportAvailability: 'plugin',
    reportFlagTakes: 'none',
    reportTarget: 'glob',
    reportPath: 'reports/junit/*.xml',
    reporterPackage: '@wdio/junit-reporter',
    installHint: 'npm install --save-dev @wdio/cli @wdio/junit-reporter',
    notes:
      "Reporters cannot be set from the CLI — the `reporters` array in wdio.conf.js is the only switch, and its `outputDir` decides the path. One XML per capability, so read it as a glob. This is the record most likely to need a human: QAAI cannot add the reporter without editing the user's config.",
  },
  {
    id: 'nightwatch',
    label: 'Nightwatch',
    languages: ['typescript', 'javascript'],
    packageManager: 'npm',
    defaultTestType: 'E2E',
    detect: {
      files: ['nightwatch.conf.js', 'nightwatch.json'],
      dependencies: ['nightwatch'],
    },
    command: 'npx',
    args: ['nightwatch', '--output', REPORT_PATH_PLACEHOLDER],
    reportArgs: ['--output', REPORT_PATH_PLACEHOLDER],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'directory',
    reportTarget: 'glob',
    reportPath: 'tests_output/*.xml',
    installHint: 'npm install --save-dev nightwatch',
    notes:
      'One of the few runners that writes JUnit XML by default with no flag at all — `--output` only moves the directory (tests_output/ otherwise). Set `output_folder: false` in the config to turn it off, which is worth checking before concluding the reports are missing.',
  },
  {
    id: 'testcafe',
    label: 'TestCafe',
    languages: ['typescript', 'javascript'],
    packageManager: 'npm',
    defaultTestType: 'E2E',
    detect: {
      files: ['.testcaferc.json', '.testcaferc.js'],
      dependencies: ['testcafe'],
    },
    command: 'npx',
    args: [
      'testcafe',
      'chrome:headless',
      'tests/',
      '--reporter',
      `xunit:${REPORT_PATH_PLACEHOLDER}`,
    ],
    reportArgs: ['--reporter', `xunit:${REPORT_PATH_PLACEHOLDER}`],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'reports/testcafe-xunit.xml',
    installHint: 'npm install --save-dev testcafe',
    notes:
      'The reporter argument is `name:path` in one token — a space between them makes the path a test file and TestCafe fails with a confusing "cannot find tests" error. The browser is a mandatory positional argument; `chrome:headless` needs Chrome on the image.',
  },
  {
    id: 'jasmine',
    label: 'Jasmine',
    languages: ['typescript', 'javascript'],
    packageManager: 'npm',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['spec/support/jasmine.json', 'spec/support/jasmine.mjs'],
      dependencies: ['jasmine', 'jasmine-core'],
    },
    command: 'npx',
    args: ['jasmine'],
    reportArgs: [],
    reportFormat: 'junit-xml',
    reportAvailability: 'plugin',
    reportFlagTakes: 'none',
    reportTarget: 'glob',
    reportPath: 'junitresults-*.xml',
    reporterPackage: 'jasmine-reporters',
    installHint: 'npm install --save-dev jasmine jasmine-reporters',
    notes:
      'The CLI has no reporter flag. `new JUnitXmlReporter({ savePath })` has to be registered in a helper file loaded by spec/support/jasmine.json, and it writes one junitresults-<suite>.xml per suite. Standalone Jasmine is mostly legacy now; in Angular it usually arrives via Karma.',
  },
  {
    id: 'karma',
    label: 'Karma',
    languages: ['typescript', 'javascript'],
    packageManager: 'npm',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['karma.conf.js', 'karma.conf.ts'],
      dependencies: ['karma', 'karma-jasmine'],
    },
    command: 'npx',
    args: ['karma', 'start', '--single-run', '--reporters', 'junit'],
    reportArgs: ['--reporters', 'junit'],
    reportFormat: 'junit-xml',
    reportAvailability: 'plugin',
    reportFlagTakes: 'none',
    reportTarget: 'glob',
    reportPath: 'test-results/**/*.xml',
    reporterPackage: 'karma-junit-reporter',
    installHint: 'npm install --save-dev karma karma-junit-reporter',
    notes:
      "Karma was deprecated by its team in 2023 — a repo on Karma is a migration candidate (Vitest, Web Test Runner, or Angular's esbuild builder). `--single-run` is essential or the browser stays open forever. The path comes from `junitReporter.outputDir`/`outputFile` in karma.conf.js, and it defaults to one file per browser.",
  },
  {
    id: 'k6',
    label: 'k6',
    languages: ['typescript', 'javascript'],
    packageManager: 'npm',
    defaultTestType: 'LOAD',
    detect: {
      files: ['load/**/*.js', 'k6/**/*.js', 'perf/**/*.js'],
      dependencies: ['k6', '@types/k6'],
      imports: ["from 'k6'", "from 'k6/http'"],
    },
    command: 'k6',
    args: ['run', TEST_PATH_PLACEHOLDER],
    reportArgs: [],
    defaultTestPath: 'script.js',
    reportFormat: 'exit-code',
    reportAvailability: 'none',
    reportFlagTakes: 'none',
    reportTarget: 'none',
    reportPath: '',
    installHint: 'brew install k6  # or https://grafana.com/docs/k6/latest/set-up/install-k6/',
    notes:
      'The script is a positional argument, and there is one per run — k6 has no `./...`. The verdict lives in the *thresholds* the script declares: a breach exits 99, and a run with no thresholds is green no matter how slow it was. Reports come from `handleSummary()` inside the script, so a repo that has not written one cannot be flagged into producing a file. k6 is a Go binary despite the JavaScript, so `npm install k6` does not put it on PATH.',
  },
  {
    id: 'newman',
    label: 'Newman (Postman)',
    languages: ['typescript', 'javascript'],
    packageManager: 'npm',
    defaultTestType: 'API',
    detect: {
      files: ['**/*.postman_collection.json'],
      dependencies: ['newman'],
    },
    command: 'npx',
    args: [
      'newman',
      'run',
      TEST_PATH_PLACEHOLDER,
      '-r',
      'junit',
      `--reporter-junit-export=${REPORT_PATH_PLACEHOLDER}`,
    ],
    reportArgs: ['-r', 'junit', `--reporter-junit-export=${REPORT_PATH_PLACEHOLDER}`],
    defaultTestPath: 'collection.json',
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'reports/newman-junit.xml',
    installHint: 'npm install --save-dev newman',
    notes:
      'The collection file is positional and mandatory. `-r junit` replaces the console reporter outright; `-r cli,junit` keeps both. A collection that reads variables needs `-e environment.json` or every request 404s against a placeholder host, which surfaces as dozens of assertion failures rather than as a configuration error.',
  },
  {
    id: 'pa11y-ci',
    label: 'Pa11y CI',
    languages: ['typescript', 'javascript'],
    packageManager: 'npm',
    defaultTestType: 'ACCESSIBILITY',
    detect: {
      files: ['.pa11yci', '.pa11yci.json', '.pa11yci.js', 'pa11y.json'],
      dependencies: ['pa11y', 'pa11y-ci'],
    },
    command: 'npx',
    args: ['pa11y-ci'],
    reportArgs: [],
    reportFormat: 'exit-code',
    reportAvailability: 'none',
    reportFlagTakes: 'none',
    reportTarget: 'none',
    reportPath: '',
    installHint: 'npm install --save-dev pa11y-ci',
    notes:
      'The URLs come from .pa11yci, never from the CLI, so a run against a repo without that file checks nothing and still exits 0. `--json` puts a summary on stdout; no reporter writes a file, and none of them emit JUnit, so per-issue rows need a converter QAAI does not have. Chrome is required on the worker image.',
  },

  // ── Python ─────────────────────────────────────────────────────────────────
  {
    id: 'pytest',
    label: 'pytest',
    languages: ['python'],
    packageManager: 'pip',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['pytest.ini', 'conftest.py', 'tox.ini', 'setup.cfg', 'tests/test_*.py'],
      dependencies: ['pytest'],
      manifestKeys: ['tool.pytest.ini_options'],
    },
    command: 'python3',
    args: ['-m', 'pytest', '-q', `--junitxml=${REPORT_PATH_PLACEHOLDER}`],
    reportArgs: [`--junitxml=${REPORT_PATH_PLACEHOLDER}`],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'reports/pytest-junit.xml',
    alternateReportFormats: ['pytest-json'],
    reporterPackage: 'pytest-json-report',
    installHint: 'python3 -m pip install pytest',
    notes:
      '`python3 -m pytest` rather than bare `pytest`, so the interpreter that owns the venv is the one that runs: a bare `pytest` on PATH can belong to a different environment entirely and fail on imports that work by hand. Emits xunit2 by default; `-o junit_family=legacy` for consumers stuck on the old schema. pytest also runs plain unittest classes, which is the usual escape route from the record below.',
  },
  {
    id: 'django-test',
    label: 'Django test runner',
    languages: ['python'],
    packageManager: 'pip',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['manage.py', '**/tests.py', '**/tests/test_*.py'],
      dependencies: ['django'],
      imports: ['from django.test import'],
    },
    command: 'python3',
    args: ['manage.py', 'test'],
    reportArgs: [],
    reportFormat: 'exit-code',
    reportAvailability: 'none',
    reportFlagTakes: 'none',
    reportTarget: 'none',
    reportPath: '',
    junitRoute: {
      requires: 'unittest-xml-reporting',
      note: "Django's runner is unittest's, so it reports nothing either. unittest-xml-reporting adds one through settings — `TEST_RUNNER = 'xmlrunner.extra.djangotestrunner.XMLTestRunner'` plus TEST_OUTPUT_DIR — which is a change to the project's own configuration, not a flag QAAI can pass.",
    },
    installHint: 'ships with Django — python3 -m pip install django',
    notes:
      'manage.py is the entry point and it must run from the directory that holds it, because DJANGO_SETTINGS_MODULE is resolved relative to there. The runner creates and destroys a test database on every run, so it needs a reachable server and credentials — a failure here is usually infrastructure, not a test. Most Django projects with a pytest.ini have moved to pytest-django and this record is the older path they still support.',
  },
  {
    id: 'unittest',
    label: 'unittest (stdlib)',
    languages: ['python'],
    packageManager: 'pip',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['tests/test_*.py', 'test/test_*.py'],
      imports: ['import unittest'],
    },
    command: 'python3',
    args: ['-m', 'unittest', 'discover', '-v'],
    reportArgs: [],
    reportFormat: 'exit-code',
    reportAvailability: 'none',
    reportFlagTakes: 'none',
    reportTarget: 'none',
    reportPath: '',
    junitRoute: {
      requires: 'unittest-xml-reporting',
      note: 'No flag can make the stdlib runner report. unittest-xml-reporting replaces the command outright — `python3 -m xmlrunner discover -o reports/` — and running the same tests under pytest is the other honest fix.',
    },
    installHint: 'built into Python — nothing to install',
    notes:
      'The stdlib runner has no XML, no JSON, no report of any kind — `python3 -m unittest --help` offers verbosity and nothing else. Do not pretend otherwise: this record gives a pass/fail and no per-test rows. Two honest fixes, both changing the command: run the same tests under pytest (`python3 -m pytest --junitxml=…`, no code changes needed), or install unittest-xml-reporting and run `python3 -m xmlrunner discover -o reports/`.',
  },
  {
    id: 'nose2',
    label: 'nose2',
    languages: ['python'],
    packageManager: 'pip',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['nose2.cfg', 'unittest.cfg'],
      dependencies: ['nose2'],
    },
    command: 'python3',
    args: ['-m', 'nose2', '--plugin', 'nose2.plugins.junitxml', '--junit-xml'],
    reportArgs: ['--plugin', 'nose2.plugins.junitxml', '--junit-xml'],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'none',
    reportTarget: 'file',
    reportPath: 'nose2-junit.xml',
    installHint: 'python3 -m pip install nose2',
    notes:
      'The junitxml plugin ships with nose2 but is off until `--plugin` loads it. The path is not a flag — it is `[junit-xml] path=` in unittest.cfg, defaulting to nose2-junit.xml in the working directory. nose2 is the successor to the abandoned `nose`; new projects should be on pytest.',
  },
  {
    id: 'robot-framework',
    label: 'Robot Framework',
    languages: ['python'],
    packageManager: 'pip',
    defaultTestType: 'E2E',
    detect: {
      files: ['**/*.robot', '**/*.resource'],
      dependencies: ['robotframework', 'robotframework-seleniumlibrary'],
    },
    command: 'python3',
    args: ['-m', 'robot', '--xunit', REPORT_PATH_PLACEHOLDER, 'tests'],
    reportArgs: ['--xunit', REPORT_PATH_PLACEHOLDER],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'xunit.xml',
    installHint: 'python3 -m pip install robotframework',
    notes:
      "`--xunit` is resolved *inside* `--outputdir`, so passing an absolute-looking path plus an outputdir puts the file somewhere neither of you expected. Robot's own output.xml is far richer (keyword-level detail, screenshots) but is a Robot-specific schema; xunit is the interop format. The final trailing argument is the test directory.",
  },
  {
    id: 'behave',
    label: 'behave',
    languages: ['python'],
    packageManager: 'pip',
    defaultTestType: 'E2E',
    detect: {
      files: ['features/**/*.feature', 'features/environment.py', 'features/steps/*.py'],
      dependencies: ['behave'],
    },
    command: 'python3',
    args: ['-m', 'behave', '--junit', '--junit-directory', REPORT_PATH_PLACEHOLDER],
    reportArgs: ['--junit', '--junit-directory', REPORT_PATH_PLACEHOLDER],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'directory',
    reportTarget: 'glob',
    reportPath: 'reports/TESTS-*.xml',
    alternateReportFormats: ['cucumber-json'],
    installHint: 'python3 -m pip install behave',
    notes:
      'One TESTS-<feature>.xml per feature file, so always a glob. `--junit` on its own writes into reports/. For the Cucumber JSON shape instead: `-f json -o cucumber.json`. Step definitions must live under features/steps/ — behave finds them by directory, not by import.',
  },

  // ── Java / Kotlin / Groovy / Scala ─────────────────────────────────────────
  {
    id: 'junit4-maven',
    label: 'JUnit 4 (Maven Surefire)',
    languages: ['java', 'kotlin'],
    packageManager: 'maven',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['pom.xml', 'src/test/java/**/*Test.java'],
      dependencies: ['junit:junit'],
      manifestContains: ['<artifactId>junit</artifactId>'],
      imports: ['import org.junit.Test;'],
    },
    command: 'mvn',
    args: ['-B', 'test'],
    reportArgs: [],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'none',
    reportTarget: 'glob',
    reportPath: 'target/surefire-reports/TEST-*.xml',
    installHint:
      'add junit:junit:4.13.2 with <scope>test</scope> to pom.xml (no install command — Maven resolves it on the next build)',
    notes:
      'Surefire writes the XML with no flag; the path is fixed and there is one file per test class, hence the glob. `-B` (batch mode) drops the ANSI progress spinner that otherwise fills the log. The report is written before the build fails, so a non-zero exit still leaves results to read — add -Dmaven.test.failure.ignore=true if the exit code is getting in the way.',
  },
  {
    id: 'junit4-gradle',
    label: 'JUnit 4 (Gradle)',
    languages: ['java', 'kotlin'],
    packageManager: 'gradle',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['build.gradle', 'build.gradle.kts', 'gradlew'],
      dependencies: ['junit:junit'],
      manifestContains: ['junit:junit'],
      imports: ['import org.junit.Test;'],
    },
    command: './gradlew',
    args: ['test', '--no-daemon'],
    reportArgs: [],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'none',
    reportTarget: 'glob',
    reportPath: 'build/test-results/test/TEST-*.xml',
    installHint: 'add testImplementation("junit:junit:4.13.2") to build.gradle',
    notes:
      'The counterpart to junit5-gradle, and the reason both exist: the runner is the same but the report lands somewhere completely different from Maven, so a candidate that names the wrong one sends a reader to an empty directory. JUnit 4 is what Gradle runs *without* `useJUnitPlatform()`, so a build file that has that line is a junit5-gradle project no matter which junit artifact is on the classpath. Android modules are the common case and they use `./gradlew testDebugUnitTest`, writing to build/test-results/testDebugUnitTest/.',
  },
  {
    id: 'junit5-maven',
    label: 'JUnit 5 (Maven Surefire)',
    languages: ['java', 'kotlin'],
    packageManager: 'maven',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['pom.xml', 'src/test/java/**/*Test.java'],
      dependencies: ['org.junit.jupiter:junit-jupiter'],
      manifestContains: ['junit-jupiter', 'junit-bom'],
      imports: ['import org.junit.jupiter.api.Test;'],
    },
    command: 'mvn',
    args: ['-B', 'test'],
    reportArgs: [],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'none',
    reportTarget: 'glob',
    reportPath: 'target/surefire-reports/TEST-*.xml',
    installHint:
      'add org.junit.jupiter:junit-jupiter:5.11.x with <scope>test</scope> to pom.xml, and Surefire ≥ 2.22.0',
    notes:
      'Surefire below 2.22.0 has no JUnit Platform provider and will silently run zero tests — a green build with an empty report is the classic symptom. Integration tests named *IT.java belong to Failsafe (`mvn -B verify`) and land in target/failsafe-reports/ instead, which is a second glob worth checking when a suite "disappears".',
  },
  {
    id: 'junit5-gradle',
    label: 'JUnit 5 (Gradle)',
    languages: ['java', 'kotlin'],
    packageManager: 'gradle',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['build.gradle', 'build.gradle.kts', 'gradlew'],
      manifestContains: ['useJUnitPlatform()', 'junit-jupiter'],
    },
    command: './gradlew',
    args: ['test', '--no-daemon'],
    reportArgs: [],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'none',
    reportTarget: 'glob',
    reportPath: 'build/test-results/test/TEST-*.xml',
    installHint: 'add testImplementation("org.junit.jupiter:junit-jupiter:5.11.x") to build.gradle',
    notes:
      'Without `test { useJUnitPlatform() }` Gradle runs the JUnit 4 engine and finds none of the Jupiter tests. Use the wrapper (./gradlew), never a system gradle — the wrapper pins the version the build expects. `--no-daemon` keeps a container from leaving a JVM behind. Multi-module builds write one directory per module, so the real glob is **/build/test-results/test/TEST-*.xml.',
  },
  {
    id: 'testng',
    label: 'TestNG',
    languages: ['java', 'kotlin'],
    packageManager: 'maven',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['testng.xml', 'pom.xml'],
      dependencies: ['org.testng:testng'],
      imports: ['import org.testng.annotations.Test;'],
    },
    command: 'mvn',
    args: ['-B', 'test'],
    reportArgs: [],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'none',
    reportTarget: 'glob',
    reportPath: 'target/surefire-reports/TEST-*.xml',
    installHint: 'add org.testng:testng:7.x with <scope>test</scope> to pom.xml',
    notes:
      "Surefire's JUnit-shaped XML is the interop path. TestNG also writes its own target/surefire-reports/testng-results.xml, which carries groups, dependencies and data-provider parameters the JUnit schema cannot express — richer, but a different schema with no parser here. Standalone: `java -cp … org.testng.TestNG testng.xml -d out`.",
  },
  {
    id: 'testng-gradle',
    label: 'TestNG (Gradle)',
    languages: ['java', 'kotlin'],
    packageManager: 'gradle',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['testng.xml', 'build.gradle', 'build.gradle.kts'],
      dependencies: ['org.testng:testng'],
      manifestContains: ['useTestNG()', 'org.testng:testng'],
      imports: ['import org.testng.annotations.Test;'],
    },
    command: './gradlew',
    args: ['test', '--no-daemon'],
    reportArgs: [],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'none',
    reportTarget: 'glob',
    reportPath: 'build/test-results/test/TEST-*.xml',
    installHint: 'add testImplementation("org.testng:testng:7.x") and `test { useTestNG() }`',
    notes:
      'Without `test { useTestNG() }` Gradle runs the JUnit engine, finds none of the TestNG annotations, and reports a green build with zero tests — the same silent failure as Surefire below 2.22.0. The XML is Gradle\'s own JUnit-shaped output, not Surefire\'s, which is why this is a separate record from `testng`; the suite file goes in as `useTestNG { suites("src/test/resources/testng.xml") }`.',
  },
  {
    id: 'spock',
    label: 'Spock',
    languages: ['groovy', 'java'],
    packageManager: 'gradle',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['src/test/groovy/**/*Spec.groovy'],
      dependencies: ['org.spockframework:spock-core'],
      manifestContains: ['spock-core'],
    },
    command: './gradlew',
    args: ['test', '--no-daemon'],
    reportArgs: [],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'none',
    reportTarget: 'glob',
    reportPath: 'build/test-results/test/TEST-*.xml',
    installHint: 'add testImplementation("org.spockframework:spock-core:2.3-groovy-4.0")',
    notes:
      'Spock 2.x runs on the JUnit Platform, so it needs `useJUnitPlatform()` and produces ordinary Gradle test XML; Spock 1.x rides JUnit 4 instead. Data-driven `where:` blocks appear as separate iterations in the XML only when `@Unroll` is in play (default in 2.x), which is why one spec sometimes becomes twelve rows.',
  },
  {
    id: 'kotest',
    label: 'Kotest',
    languages: ['kotlin'],
    packageManager: 'gradle',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['src/test/kotlin/**/*Spec.kt', 'src/test/kotlin/**/*Test.kt'],
      dependencies: ['io.kotest:kotest-runner-junit5'],
      manifestContains: ['kotest'],
    },
    command: './gradlew',
    args: ['test', '--no-daemon'],
    reportArgs: [],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'none',
    reportTarget: 'glob',
    reportPath: 'build/test-results/test/TEST-*.xml',
    installHint: 'add testImplementation("io.kotest:kotest-runner-junit5:5.9.x")',
    notes:
      'kotest-runner-junit5 is what makes the JUnit Platform (and therefore the XML) work — the assertion libraries alone produce nothing runnable. Nested specs flatten into the XML with the parent context in the test name, so names are long and duplicates across contexts are common.',
  },
  {
    id: 'cucumber-jvm',
    label: 'Cucumber JVM',
    languages: ['java', 'kotlin'],
    packageManager: 'maven',
    defaultTestType: 'E2E',
    detect: {
      files: ['src/test/resources/**/*.feature'],
      dependencies: ['io.cucumber:cucumber-java', 'io.cucumber:cucumber-junit-platform-engine'],
      manifestContains: ['io.cucumber'],
    },
    command: 'mvn',
    args: ['-B', 'test'],
    reportArgs: [],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'none',
    reportTarget: 'glob',
    reportPath: 'target/surefire-reports/TEST-*.xml',
    alternateReportFormats: ['cucumber-json'],
    installHint: 'add io.cucumber:cucumber-java and io.cucumber:cucumber-junit-platform-engine',
    notes:
      'With cucumber-junit-platform-engine each scenario is a JUnit test and Surefire covers it with no extra configuration. The older route — `--plugin junit:target/cucumber.xml` on a standalone CLI — still exists but is legacy; `--plugin json:target/cucumber.json` gives the Cucumber JSON shape, and `message` NDJSON is what the Cucumber project itself now recommends.',
  },
  {
    id: 'karate',
    label: 'Karate',
    languages: ['java'],
    packageManager: 'maven',
    defaultTestType: 'API',
    detect: {
      files: ['src/test/**/*.feature', 'karate-config.js'],
      dependencies: ['com.intuit.karate:karate-junit5', 'com.intuit.karate:karate-core'],
      manifestContains: ['karate-junit5', 'karate-core'],
    },
    command: 'mvn',
    args: ['-B', 'test'],
    reportArgs: [],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'none',
    reportTarget: 'glob',
    reportPath: 'target/karate-reports/*.xml',
    installHint: 'add com.intuit.karate:karate-junit5 with <scope>test</scope> to pom.xml',
    notes:
      'Karate writes its own target/karate-reports/*.xml (one per feature, alongside an HTML report) *and*, because the features are launched from a JUnit 5 runner class, Surefire writes target/surefire-reports for that one class — read the karate-reports glob or you get a single row called "runner". The environment comes from karate-config.js and is switched with `-Dkarate.env=`; the wrong one usually looks like a wall of connection failures.',
  },
  {
    id: 'scalatest',
    label: 'ScalaTest',
    languages: ['scala'],
    packageManager: 'sbt',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['build.sbt', 'src/test/scala/**/*Spec.scala'],
      manifestContains: ['org.scalatest'],
    },
    command: 'sbt',
    args: ['-batch', 'test'],
    reportArgs: [],
    reportFormat: 'junit-xml',
    reportAvailability: 'config',
    reportFlagTakes: 'none',
    reportTarget: 'glob',
    reportPath: 'target/test-reports/*.xml',
    installHint: 'add "org.scalatest" %% "scalatest" % "3.2.19" % Test to build.sbt',
    notes:
      'sbt writes no XML on its own. It needs `Test / testOptions += Tests.Argument(TestFrameworks.ScalaTest, "-u", "target/test-reports")` in build.sbt — and it has to go there rather than on the command line, because `sbt test` takes no test-runner arguments. `-batch` stops sbt opening an interactive shell when something fails. Under Maven or Gradle instead, the usual surefire/test-results paths apply.',
  },

  // ── C# / .NET ──────────────────────────────────────────────────────────────
  {
    id: 'nunit',
    label: 'NUnit',
    languages: ['csharp'],
    packageManager: 'dotnet',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['**/*.csproj'],
      dependencies: ['NUnit', 'NUnit3TestAdapter'],
      manifestContains: ['<PackageReference Include="NUnit"'],
    },
    command: 'dotnet',
    args: ['test', '--logger', `trx;LogFileName=${REPORT_PATH_PLACEHOLDER}`],
    reportArgs: ['--logger', `trx;LogFileName=${REPORT_PATH_PLACEHOLDER}`],
    reportFormat: 'trx',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'TestResults/report.trx',
    alternateReportFormats: ['nunit3', 'junit-xml'],
    reporterPackage: 'JunitXml.TestLogger',
    junitRoute: {
      args: ['--logger', `junit;LogFilePath=${REPORT_PATH_PLACEHOLDER}`],
      requires: 'JunitXml.TestLogger',
      reportPath: REPORT_PATH_PLACEHOLDER,
      note: '`dotnet test` writes TRX with no extra package; the JunitXml.TestLogger package adds a `junit` logger that writes JUnit XML instead. LogFilePath is resolved inside --results-directory, same as the TRX one.',
    },
    installHint: 'dotnet add package NUnit && dotnet add package NUnit3TestAdapter',
    notes:
      'LogFileName is resolved *inside* --results-directory (./TestResults by default), so substituting `report.trx` yields TestResults/report.trx — pass --results-directory to move it, not a path in LogFileName. Without a LogFileName, dotnet invents a machine-and-timestamp name and you are left globbing. NUnit3TestAdapter is what makes `dotnet test` see the tests at all; a project with only the NUnit package finds zero.',
  },
  {
    id: 'xunit',
    label: 'xUnit.net',
    languages: ['csharp'],
    packageManager: 'dotnet',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['**/*.csproj'],
      dependencies: ['xunit', 'xunit.runner.visualstudio'],
      manifestContains: ['<PackageReference Include="xunit"'],
    },
    command: 'dotnet',
    args: ['test', '--logger', `trx;LogFileName=${REPORT_PATH_PLACEHOLDER}`],
    reportArgs: ['--logger', `trx;LogFileName=${REPORT_PATH_PLACEHOLDER}`],
    reportFormat: 'trx',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'TestResults/report.trx',
    alternateReportFormats: ['junit-xml'],
    reporterPackage: 'JunitXml.TestLogger',
    junitRoute: {
      args: ['--logger', `junit;LogFilePath=${REPORT_PATH_PLACEHOLDER}`],
      requires: 'JunitXml.TestLogger',
      reportPath: REPORT_PATH_PLACEHOLDER,
      note: '`dotnet test` writes TRX with no extra package; the JunitXml.TestLogger package adds a `junit` logger that writes JUnit XML instead. LogFilePath is resolved inside --results-directory, same as the TRX one.',
    },
    installHint: 'dotnet add package xunit && dotnet add package xunit.runner.visualstudio',
    notes:
      'Same VSTest plumbing as NUnit and MSTest — the runner differs, the report does not. xUnit v3 adds a standalone executable runner with its own `--report` options; under `dotnet test` the visualstudio adapter is still doing the work. Theories appear as one row per data case.',
  },
  {
    id: 'mstest',
    label: 'MSTest',
    languages: ['csharp'],
    packageManager: 'dotnet',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['**/*.csproj'],
      dependencies: ['MSTest.TestAdapter', 'MSTest.TestFramework'],
      manifestContains: ['<PackageReference Include="MSTest'],
    },
    command: 'dotnet',
    args: ['test', '--logger', `trx;LogFileName=${REPORT_PATH_PLACEHOLDER}`],
    reportArgs: ['--logger', `trx;LogFileName=${REPORT_PATH_PLACEHOLDER}`],
    reportFormat: 'trx',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'TestResults/report.trx',
    alternateReportFormats: ['junit-xml'],
    reporterPackage: 'JunitXml.TestLogger',
    junitRoute: {
      args: ['--logger', `junit;LogFilePath=${REPORT_PATH_PLACEHOLDER}`],
      requires: 'JunitXml.TestLogger',
      reportPath: REPORT_PATH_PLACEHOLDER,
      note: '`dotnet test` writes TRX with no extra package; the JunitXml.TestLogger package adds a `junit` logger that writes JUnit XML instead. LogFilePath is resolved inside --results-directory, same as the TRX one.',
    },
    installHint: 'dotnet add package MSTest.TestAdapter && dotnet add package MSTest.TestFramework',
    notes:
      'TRX is MSTest\'s native shape — it is the one .NET format that needs no extra package, which is why all three .NET records default to it. Every one of them needs Microsoft.NET.Test.Sdk in the project or `dotnet test` reports "no test is available".',
  },
  {
    id: 'specflow',
    label: 'SpecFlow / Reqnroll',
    languages: ['csharp'],
    packageManager: 'dotnet',
    defaultTestType: 'E2E',
    detect: {
      files: ['**/*.feature', 'specflow.json', 'reqnroll.json'],
      dependencies: ['SpecFlow', 'SpecFlow.NUnit', 'SpecFlow.MsTest', 'Reqnroll'],
    },
    command: 'dotnet',
    args: ['test', '--logger', `trx;LogFileName=${REPORT_PATH_PLACEHOLDER}`],
    reportArgs: ['--logger', `trx;LogFileName=${REPORT_PATH_PLACEHOLDER}`],
    reportFormat: 'trx',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'TestResults/report.trx',
    junitRoute: {
      args: ['--logger', `junit;LogFilePath=${REPORT_PATH_PLACEHOLDER}`],
      requires: 'JunitXml.TestLogger',
      reportPath: REPORT_PATH_PLACEHOLDER,
      note: '`dotnet test` writes TRX with no extra package; the JunitXml.TestLogger package adds a `junit` logger that writes JUnit XML instead. LogFilePath is resolved inside --results-directory, same as the TRX one.',
    },
    installHint:
      'dotnet add package Reqnroll.NUnit  # SpecFlow is end-of-life; Reqnroll succeeds it',
    notes:
      'SpecFlow was discontinued in 2024 and its drop-in successor is Reqnroll (same Gherkin, Reqnroll.* packages) — detect both, recommend the move. The .feature files are code-generated into ordinary NUnit/xUnit/MSTest classes at build time, so the report comes from whichever unit runner is bound; there is no SpecFlow-specific report to look for.',
  },

  // ── Ruby ───────────────────────────────────────────────────────────────────
  {
    id: 'rspec',
    label: 'RSpec',
    languages: ['ruby'],
    packageManager: 'bundler',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['.rspec', 'spec/spec_helper.rb', 'spec/**/*_spec.rb'],
      dependencies: ['rspec', 'rspec-rails'],
      manifestContains: ["gem 'rspec'", 'gem "rspec"'],
    },
    command: 'bundle',
    args: ['exec', 'rspec', '--format', 'json', '--out', REPORT_PATH_PLACEHOLDER],
    reportArgs: ['--format', 'json', '--out', REPORT_PATH_PLACEHOLDER],
    reportFormat: 'rspec-json',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'reports/rspec.json',
    alternateReportFormats: ['junit-xml'],
    reporterPackage: 'rspec_junit_formatter',
    junitRoute: {
      args: ['--format', 'RspecJunitFormatter', '--out', REPORT_PATH_PLACEHOLDER],
      requires: 'rspec_junit_formatter',
      reportPath: REPORT_PATH_PLACEHOLDER,
      note: 'RSpec needs the `rspec_junit_formatter` gem before it can emit JUnit XML. Its own JSON formatter is built in and needs nothing, but no parser here reads that shape yet.',
    },
    installHint: 'add gem "rspec" to the Gemfile, then bundle install',
    notes:
      'The JSON formatter is built in and needs no gem, so it is the default here; for JUnit add rspec_junit_formatter and use `--format RspecJunitFormatter --out report.xml`. Formatters can be stacked (`--format progress --format json --out …`) to keep human output alongside the file. `bundle exec` matters — a bare `rspec` can resolve to a different gem version than the lockfile pins.',
  },
  {
    id: 'minitest',
    label: 'Minitest',
    languages: ['ruby'],
    packageManager: 'bundler',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['test/test_helper.rb', 'test/**/*_test.rb'],
      dependencies: ['minitest', 'minitest-reporters'],
      manifestContains: ["gem 'minitest'"],
    },
    command: 'bundle',
    args: ['exec', 'rake', 'test'],
    reportArgs: [],
    reportFormat: 'junit-xml',
    reportAvailability: 'plugin',
    reportFlagTakes: 'none',
    reportTarget: 'glob',
    reportPath: 'test/reports/TEST-*.xml',
    reporterPackage: 'minitest-reporters',
    installHint: 'add gem "minitest-reporters" to the Gemfile, then bundle install',
    notes:
      'Plain Minitest prints dots and returns an exit code — nothing machine-readable. minitest-reporters has to be wired up in test_helper.rb (`Minitest::Reporters.use! [Minitest::Reporters::JUnitReporter.new]`), which QAAI cannot do without editing the repo. Rails projects use `bin/rails test`; the rake task above is the plain-Ruby equivalent.',
  },
  {
    id: 'cucumber-ruby',
    label: 'Cucumber (Ruby)',
    languages: ['ruby'],
    packageManager: 'bundler',
    defaultTestType: 'E2E',
    detect: {
      files: ['features/**/*.feature', 'features/support/env.rb', 'cucumber.yml'],
      dependencies: ['cucumber'],
      manifestContains: ["gem 'cucumber'"],
    },
    command: 'bundle',
    args: ['exec', 'cucumber', '--format', 'junit', '--out', REPORT_PATH_PLACEHOLDER],
    reportArgs: ['--format', 'junit', '--out', REPORT_PATH_PLACEHOLDER],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'directory',
    reportTarget: 'glob',
    reportPath: 'reports/TEST-*.xml',
    alternateReportFormats: ['cucumber-json'],
    installHint: 'add gem "cucumber" to the Gemfile, then bundle install',
    notes:
      '`--out` must be a *directory* for the junit formatter — hand it a filename and Cucumber either errors or writes a file where you wanted a folder. One XML per feature. The `json` formatter still works but has been deprecated in favour of `message` (NDJSON) for several majors now. Cucumber usually drives Capybara here, so a browser is needed on the worker.',
  },

  // ── Go ─────────────────────────────────────────────────────────────────────
  {
    id: 'go-test',
    label: 'go test',
    languages: ['go'],
    packageManager: 'go',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['go.mod', '**/*_test.go'],
    },
    command: 'go',
    args: ['test', './...', '-json', '-count=1'],
    reportArgs: ['-json'],
    reportFormat: 'go-json',
    reportAvailability: 'native',
    reportFlagTakes: 'none',
    reportTarget: 'stdout',
    reportPath: '',
    junitRoute: {
      requires: 'gotestsum',
      note: '`go test -json` is an event stream on stdout and has no JUnit mode at all; gotestsum wraps the same run and writes the XML (`gotestsum --junitfile`, the gotestsum record below).',
    },
    installHint: 'built into the Go toolchain — install Go from https://go.dev/dl',
    notes:
      '`-json` is a stream of events on stdout, not a document, and there is no flag that writes it to a file. `-count=1` defeats the test cache: without it Go replays a previous PASS without running anything, and a "0.00s" suite that never executed looks exactly like a fast one. A package that fails to *compile* appears as a fail action with no test names attached, which a parser has to handle or the failure vanishes.',
  },
  {
    id: 'gotestsum',
    label: 'gotestsum',
    languages: ['go'],
    packageManager: 'go',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['go.mod', 'tools.go'],
      dependencies: ['gotest.tools/gotestsum'],
      manifestContains: ['gotest.tools/gotestsum'],
    },
    command: 'gotestsum',
    args: ['--junitfile', REPORT_PATH_PLACEHOLDER, '--', './...', '-count=1'],
    reportArgs: ['--junitfile', REPORT_PATH_PLACEHOLDER],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'reports/gotestsum-junit.xml',
    alternateReportFormats: ['go-json'],
    installHint: 'go install gotest.tools/gotestsum@latest',
    notes:
      'A wrapper around `go test -json` that turns the stream into JUnit XML — the shortest path from Go to a file QAAI can read today. Everything after `--` goes to go test verbatim. Detection is weak: it usually appears only in tools.go or a CI workflow, so a Go repo without it should fall back to the go-test record.',
  },
  {
    id: 'ginkgo',
    label: 'Ginkgo',
    languages: ['go'],
    packageManager: 'go',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['**/*_suite_test.go'],
      dependencies: ['github.com/onsi/ginkgo/v2', 'github.com/onsi/gomega'],
      imports: ['github.com/onsi/ginkgo'],
    },
    command: 'ginkgo',
    args: ['-r', '--output-dir', 'reports', `--junit-report=${REPORT_PATH_PLACEHOLDER}`],
    reportArgs: ['--output-dir', 'reports', `--junit-report=${REPORT_PATH_PLACEHOLDER}`],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'glob',
    reportPath: 'reports/*.xml',
    installHint: 'go install github.com/onsi/ginkgo/v2/ginkgo@latest',
    notes:
      'Ginkgo v2 only — v1 spelled it `--reportFile` and is no longer maintained. With `-r` the report is written per suite *into each suite directory* unless `--output-dir` collects them, in which case the filenames are prefixed with the suite name; either way, read it as a glob. Ginkgo suites are ordinary `go test` binaries, so gotestsum also works on them.',
  },

  // ── PHP ────────────────────────────────────────────────────────────────────
  {
    id: 'phpunit',
    label: 'PHPUnit',
    languages: ['php'],
    packageManager: 'composer',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['phpunit.xml', 'phpunit.xml.dist', 'tests/**/*Test.php'],
      dependencies: ['phpunit/phpunit'],
    },
    command: './vendor/bin/phpunit',
    args: ['--log-junit', REPORT_PATH_PLACEHOLDER],
    reportArgs: ['--log-junit', REPORT_PATH_PLACEHOLDER],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'reports/phpunit-junit.xml',
    installHint: 'composer require --dev phpunit/phpunit',
    notes:
      'Run the vendored binary rather than a global phpunit — the global one is routinely a major version out of step with the project. `--log-junit` survived the PHPUnit 10 option cull; the same thing can be set as <junit outputFile="…"> in phpunit.xml, and the CLI flag wins.',
  },
  {
    id: 'pest',
    label: 'Pest',
    languages: ['php'],
    packageManager: 'composer',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['tests/Pest.php', 'Pest.php'],
      dependencies: ['pestphp/pest'],
    },
    command: './vendor/bin/pest',
    args: ['--log-junit', REPORT_PATH_PLACEHOLDER],
    reportArgs: ['--log-junit', REPORT_PATH_PLACEHOLDER],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'reports/pest-junit.xml',
    installHint: 'composer require --dev pestphp/pest --with-all-dependencies',
    notes:
      "Pest is a front-end over PHPUnit, so PHPUnit flags pass straight through and the XML is PHPUnit's. A Pest project still has a phpunit.xml. `--parallel` (pest-plugin-parallel) splits the run across processes and the JUnit output is merged afterwards — verify the merge before trusting per-test timings.",
  },
  {
    id: 'behat',
    label: 'Behat',
    languages: ['php'],
    packageManager: 'composer',
    defaultTestType: 'E2E',
    detect: {
      files: ['behat.yml', 'behat.yml.dist', 'features/**/*.feature'],
      dependencies: ['behat/behat'],
    },
    command: './vendor/bin/behat',
    args: ['--format', 'junit', '--out', REPORT_PATH_PLACEHOLDER],
    reportArgs: ['--format', 'junit', '--out', REPORT_PATH_PLACEHOLDER],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'directory',
    reportTarget: 'glob',
    reportPath: 'reports/*.xml',
    installHint: 'composer require --dev behat/behat',
    notes:
      'Like Cucumber-Ruby, `--out` is a directory for the junit formatter and one XML lands per suite. Pair it with `--format progress --out std` to keep readable console output — formatters and outputs are positional pairs, so the order of the two --format flags decides which --out belongs to which.',
  },

  // ── Rust ───────────────────────────────────────────────────────────────────
  {
    id: 'cargo-test',
    label: 'cargo test',
    languages: ['rust'],
    packageManager: 'cargo',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['Cargo.toml', 'tests/*.rs'],
      manifestContains: ['[dev-dependencies]'],
    },
    command: 'cargo',
    args: ['test', '--all-features'],
    reportArgs: [],
    reportFormat: 'exit-code',
    reportAvailability: 'none',
    reportFlagTakes: 'none',
    reportTarget: 'none',
    reportPath: '',
    junitRoute: {
      requires: 'cargo-nextest',
      note: 'Stable `cargo test` has no machine-readable output, and cargo2junit needs a pipe the no-shell spawn cannot give. cargo-nextest (the record below) is the realistic route to JUnit XML.',
    },
    installHint: 'built into cargo — install Rust from https://rustup.rs',
    notes:
      "Stable Rust has no machine-readable test output. libtest's `--format json` still requires nightly and `-Z unstable-options`, so a stable toolchain gives an exit code and human text, and this record says so rather than inventing per-test rows. The realistic fix is cargo-nextest (below); cargo2junit can convert the nightly JSON but needs a pipe, which the no-shell spawn cannot provide.",
  },
  {
    id: 'cargo-nextest',
    label: 'cargo nextest',
    languages: ['rust'],
    packageManager: 'cargo',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['Cargo.toml', '.config/nextest.toml'],
      manifestContains: ['[profile.ci]'],
    },
    command: 'cargo',
    args: ['nextest', 'run', '--profile', 'ci'],
    reportArgs: ['--profile', 'ci'],
    reportFormat: 'junit-xml',
    reportAvailability: 'config',
    reportFlagTakes: 'none',
    reportTarget: 'file',
    reportPath: 'target/nextest/ci/junit.xml',
    installHint: 'cargo install cargo-nextest --locked',
    notes:
      'JUnit output is a profile setting, not a flag: `[profile.ci.junit] path = "junit.xml"` in .config/nextest.toml, and the file lands at target/nextest/<profile>/<path>. Without that stanza the run is silent and the path above will not exist. nextest runs each test in its own process — suites that share global state may fail here and pass under `cargo test` — and it does not run doctests, which have to stay on `cargo test --doc`.',
  },

  // ── Swift ──────────────────────────────────────────────────────────────────
  {
    id: 'swift-test',
    label: 'swift test (SwiftPM)',
    languages: ['swift'],
    packageManager: 'swiftpm',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['Package.swift', 'Tests/**/*.swift'],
      imports: ['import XCTest', 'import Testing'],
    },
    command: 'swift',
    args: ['test', '--parallel', '--xunit-output', REPORT_PATH_PLACEHOLDER],
    reportArgs: ['--parallel', '--xunit-output', REPORT_PATH_PLACEHOLDER],
    reportFormat: 'junit-xml',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'reports/swift-xunit.xml',
    installHint: 'ships with the Swift toolchain (Xcode, or swift.org for Linux)',
    notes:
      '`--xunit-output` historically only produced a file in combination with `--parallel`, which is why both are here. Swift 6 runs swift-testing (`import Testing`) and XCTest in the same invocation and reports both. This is the only Apple-platform record that yields a report from one command — see xcodebuild for why the app case is harder.',
  },
  {
    id: 'xcodebuild',
    label: 'xcodebuild test',
    languages: ['swift'],
    packageManager: 'xcode',
    defaultTestType: 'E2E',
    detect: {
      files: ['*.xcodeproj', '*.xcworkspace', '*.xctestplan'],
    },
    command: 'xcodebuild',
    args: [
      'test',
      '-scheme',
      'YourScheme',
      '-destination',
      'platform=iOS Simulator,name=iPhone 15',
      '-resultBundlePath',
      REPORT_PATH_PLACEHOLDER,
    ],
    reportArgs: ['-resultBundlePath', REPORT_PATH_PLACEHOLDER],
    reportFormat: 'exit-code',
    reportAvailability: 'none',
    reportFlagTakes: 'file',
    reportTarget: 'none',
    reportPath: 'build/TestResults.xcresult',
    installHint: 'ships with Xcode (xcode-select --install for the command line tools)',
    notes:
      'The .xcresult bundle is machine-readable but it is a directory in an Apple-private format, and nothing here parses it — so this record claims an exit code only. Converting it takes a second command (`xcrun xcresulttool get --format json`, or xcresultparser -o junit), and the popular `| xcbeautify --report junit` needs a pipe the no-shell spawn cannot give. The scheme and destination are project-specific and must be edited before this runs; a wrong destination fails with a device-matching error, not a test failure. macOS worker required.',
  },

  // ── Dart / Flutter ─────────────────────────────────────────────────────────
  {
    id: 'flutter-test',
    label: 'flutter test',
    languages: ['dart'],
    packageManager: 'pub',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['pubspec.yaml', 'test/**/*_test.dart'],
      manifestContains: ['sdk: flutter', 'flutter_test:'],
    },
    command: 'flutter',
    args: ['test', `--file-reporter=json:${REPORT_PATH_PLACEHOLDER}`],
    reportArgs: [`--file-reporter=json:${REPORT_PATH_PLACEHOLDER}`],
    reportFormat: 'dart-json',
    reportAvailability: 'native',
    reportFlagTakes: 'file',
    reportTarget: 'file',
    reportPath: 'reports/flutter-test.json',
    junitRoute: {
      requires: 'junitreport',
      note: 'The package:test JSON stream becomes JUnit XML only through a second command (`tojunit`, from the junitreport package), so one invocation cannot produce it.',
    },
    installHint: 'ships with the Flutter SDK (https://docs.flutter.dev/get-started/install)',
    notes:
      '`--file-reporter=json:<path>` writes the event stream to a file while the console keeps its normal output; `--machine` is the same stream on stdout. It is newline-delimited events (testStart, testDone, done), not a single document, and a parser must fold them — the last `done` event carries the real verdict. Pure-Dart packages use `dart test` with the same flags. JUnit needs the junitreport package and a second command (`tojunit`).',
  },

  // ── Elixir ─────────────────────────────────────────────────────────────────
  {
    id: 'mix-test',
    label: 'mix test (ExUnit)',
    languages: ['elixir'],
    packageManager: 'hex',
    defaultTestType: 'UNIT_GEN',
    detect: {
      files: ['mix.exs', 'test/test_helper.exs', 'test/**/*_test.exs'],
      manifestContains: [':junit_formatter'],
    },
    command: 'mix',
    args: ['test'],
    env: { MIX_ENV: 'test' },
    reportArgs: [],
    reportFormat: 'junit-xml',
    reportAvailability: 'plugin',
    reportFlagTakes: 'none',
    reportTarget: 'glob',
    reportPath: '_build/test/lib/*/test-junit-report.xml',
    reporterPackage: 'junit_formatter',
    installHint: 'add {:junit_formatter, "~> 3.4", only: [:test]} to mix.exs, then mix deps.get',
    notes:
      'ExUnit has no built-in machine-readable formatter — without junit_formatter, `mix test` gives dots and an exit code. The formatter is registered in config/test.exs (`config :ex_unit, formatters: [JUnitFormatter]`) and its report_dir defaults inside _build, one file per app, so an umbrella project produces several. Dependencies must be compiled first (`mix deps.get`) or the run fails before any test starts.',
  },
] as const satisfies readonly Ecosystem[];

export type EcosystemId = (typeof ECOSYSTEMS)[number]['id'];

/**
 * The runner vocabulary, as values. `EcosystemId` is the same list as a type —
 * anything that names a runner (detection included) uses one of these and gets
 * a compile error for a name that is not here.
 */
export const ECOSYSTEM_IDS: readonly EcosystemId[] = ECOSYSTEMS.map((e) => e.id);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * `ECOSYSTEMS` is `as const` so `EcosystemId` can be a literal union, which
 * makes every field a literal type too — `languages.includes(slug)` on a
 * readonly tuple of one string does not compile. The helpers work through this
 * widened view; callers that iterate `ECOSYSTEMS` directly and hit the same
 * wall should annotate their own binding as `readonly Ecosystem[]`.
 */
const ALL: readonly Ecosystem[] = ECOSYSTEMS;

const BY_ID: ReadonlyMap<string, Ecosystem> = new Map(ALL.map((e) => [e.id, e]));

/**
 * Lookup by id. Takes a plain string because the id usually arrives from a
 * database column or an API body, where the literal union does not survive.
 */
export function ecosystemById(id: string): Ecosystem | undefined {
  return BY_ID.get(id);
}

/**
 * Every runner for a language. Accepts either the catalogue slug ('python') or
 * the DB-backed `Language` enum ('PYTHON'), because both are in circulation and
 * making callers convert is how the two drift apart.
 */
export function ecosystemsForLanguage(
  language: EcosystemLanguage | Language,
): readonly Ecosystem[] {
  const slug =
    language in LANGUAGE_TO_ECOSYSTEM_LANGUAGE
      ? LANGUAGE_TO_ECOSYSTEM_LANGUAGE[language as Language]
      : (language as EcosystemLanguage);
  return ALL.filter((e) => e.languages.includes(slug));
}

/**
 * The runners a repository scan *could* find — anything with a file, dependency
 * or manifest signal. Import signals alone do not count: they need the source of
 * every test file, which a manifest-level scan does not have.
 *
 * Not the same question as `DETECTABLE_RUNNERS` in detect.ts, which is the
 * narrower "what does detection have a ranked rule for today". This one is the
 * ceiling; that one is the coverage.
 *
 * Today every record qualifies. The filter exists so that a future entry with
 * no evidence behind it stays out of the scanner instead of being guessed at.
 */
export function detectableEcosystems(): readonly Ecosystem[] {
  return ALL.filter(
    (e) =>
      (e.detect.files?.length ?? 0) > 0 ||
      (e.detect.dependencies?.length ?? 0) > 0 ||
      (e.detect.manifestKeys?.length ?? 0) > 0 ||
      (e.detect.manifestContains?.length ?? 0) > 0,
  );
}

/** Substitutions a record's argv may need before it can be spawned. */
export interface EcosystemPaths {
  /** Where the report should land. */
  readonly reportPath?: string | null;
  /** The test file a runner takes as a positional argument (k6, Newman). */
  readonly testPath?: string | null;
}

function filler(entry: Ecosystem, paths: EcosystemPaths): (value: string) => string {
  const testPath = paths.testPath ?? entry.defaultTestPath ?? null;
  return (value) => {
    let out = value;
    if (paths.reportPath != null) out = out.split(REPORT_PATH_PLACEHOLDER).join(paths.reportPath);
    if (testPath != null) out = out.split(TEST_PATH_PLACEHOLDER).join(testPath);
    return out;
  };
}

/**
 * Fill in the report path. Returns argv and env ready for `spawn` — still no
 * shell, still an array, and the substitution happens inside a single argv
 * element (`--junitxml=<path>`) so it can never split into two arguments.
 *
 * Throws when a record wants a path and none was given: a runner told to write
 * `{{reportPath}}` literally would "pass" while writing to a file nobody reads.
 */
export function resolveEcosystemCommand(
  entry: Ecosystem,
  reportPath: string | null,
  testPath?: string | null,
): { command: string; args: string[]; env: Record<string, string> } {
  const env = { ...entry.env, ...entry.reportEnv };
  const needsPath =
    entry.args.some((a) => a.includes(REPORT_PATH_PLACEHOLDER)) ||
    Object.values(env).some((v) => v.includes(REPORT_PATH_PLACEHOLDER));

  if (needsPath && !reportPath) {
    throw new Error(`${entry.id} needs a report path — its command has no default location`);
  }

  const fill = filler(entry, { reportPath, testPath });

  return {
    command: entry.command,
    args: entry.args.map(fill),
    env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, fill(v)])),
  };
}

/**
 * The command that only runs the suite: `args` with `reportArgs` taken back out.
 *
 * Detection shows this on the import screen and keeps the report flags in the
 * JUnit plan beside it, because "how do I run your tests" and "what do I have
 * to add before I can read the results" are two different answers and a user
 * overruling us needs to see which is which.
 *
 * Throws when `reportArgs` is not an in-order subsequence of `args`. That is a
 * malformed record rather than bad input, and it must fail where it is cheap —
 * silently returning the full argv would hand a caller flags it did not ask for.
 */
export function ecosystemRunArgs(entry: Ecosystem, testPath?: string | null): string[] {
  const fill = filler(entry, { testPath });
  const out: string[] = [];
  let next = 0;

  for (const arg of entry.args) {
    if (next < entry.reportArgs.length && arg === entry.reportArgs[next]) {
      next += 1;
      continue;
    }
    out.push(fill(arg));
  }

  if (next < entry.reportArgs.length) {
    throw new Error(
      `${entry.id}: reportArgs is not a subsequence of args — ` +
        `"${entry.reportArgs[next]}" is not there, in that order`,
    );
  }
  return out;
}

/**
 * Can this runner give QAAI a report it can actually parse, and what does that
 * cost?
 *
 * The answer is deliberately about JUnit XML and nothing else: `runExternal`
 * reads JUnit XML or an exit code (see `REPORT_FORMAT_INFO[…].externalSpecFormat`),
 * so a record whose native report is jest-json or TRX is `needs-plugin` here
 * even though it reports perfectly well on its own. Saying "built-in" because
 * *some* machine-readable file appears would produce a run with zero test rows.
 */
export interface JUnitPlan {
  /** `none` means there is no JUnit path we trust; fall back to the exit code. */
  support: 'built-in' | 'needs-plugin' | 'none';
  /** Appended to `ecosystemRunArgs` to make the tool write the report. */
  args: string[];
  env: Record<string, string>;
  /** Report location, or null when there is no single file to read. */
  reportPath: string | null;
  /** What is missing or surprising — shown verbatim, never silently assumed away. */
  note: string | null;
}

/**
 * Where a caller wants reports written. Two paths because runners disagree
 * about what the flag takes: pytest names a file, behave a directory.
 */
export interface ReportDestination {
  readonly file: string;
  readonly directory: string;
}

export function junitPlanFor(entry: Ecosystem, into: ReportDestination): JUnitPlan {
  const target = entry.reportFlagTakes === 'directory' ? into.directory : into.file;
  const fill = (value: string): string => value.split(REPORT_PATH_PLACEHOLDER).join(target);
  const env = (source: Readonly<Record<string, string>> | undefined): Record<string, string> =>
    Object.fromEntries(Object.entries(source ?? {}).map(([k, v]) => [k, fill(v)]));

  // 1. The runner writes JUnit XML itself.
  if (entry.reportFormat === 'junit-xml') {
    // One file, and we can say where: either the flag moves it (`target`) or the
    // runner has a fixed location we cannot move but can still read. A glob is
    // neither, and gets a null path rather than a made-up one that will be empty.
    const fixed = entry.reportFlagTakes === 'none';
    const where = fixed ? entry.reportPath : target;
    const single = entry.reportTarget === 'file';

    let note: string | null = null;
    if (entry.reportAvailability === 'plugin') {
      note =
        `${entry.label} needs \`${entry.reporterPackage ?? 'a JUnit reporter'}\` installed and ` +
        `wired into its config before it writes anything; the reports then land at ${where}.`;
    } else if (entry.reportAvailability === 'config') {
      note =
        `${entry.label} emits JUnit XML only when its config file asks for it — there is no ` +
        `flag — and the file lands at ${where}.`;
    } else if (entry.reportTarget === 'glob' && entry.reportFlagTakes === 'directory') {
      note =
        `${entry.label} writes one report per suite into ${where}/; point reportPath at the ` +
        `one you want.`;
    } else if (entry.reportTarget === 'glob' && entry.reportFlagTakes === 'file') {
      // The trap this case exists for: the flag accepts a filename, so the run
      // looks configured, and then the runner writes one report per suite
      // anyway — Cypress overwrites the name once per spec, Ginkgo prefixes it.
      // Either way a twelve-spec run can end up looking like a suite of one.
      note =
        `${entry.label} takes a filename but writes one report per suite, so ${where} will not ` +
        `hold all of them — read the directory it lives in, and see this runner's notes for ` +
        `what it does to the name.`;
    } else if (entry.reportTarget === 'glob') {
      note =
        `${entry.label} writes one report per suite at ${where}, so there is no single file ` +
        `to read; point reportPath at the one you want.`;
    } else if (fixed) {
      note = `${entry.label} writes its report to ${where} and has no flag to move it.`;
    }

    return {
      support: entry.reportAvailability === 'native' ? 'built-in' : 'needs-plugin',
      args: entry.reportArgs.map(fill),
      env: env(entry.reportEnv),
      reportPath: single ? where : null,
      note,
    };
  }

  // 2. Some other route to JUnit XML exists, and it costs something.
  if (entry.junitRoute) {
    const route = entry.junitRoute;
    return {
      support: route.requires ? 'needs-plugin' : 'built-in',
      args: (route.args ?? []).map(fill),
      env: env(route.env),
      reportPath: route.reportPath ? fill(route.reportPath) : null,
      note: route.note,
    };
  }

  // 3. There is none. Say which, and stop.
  const note =
    entry.reportFormat === 'exit-code'
      ? `${entry.label} has no machine-readable report at all; QAAI reads its exit code.`
      : `${entry.label} reports ${REPORT_FORMAT_INFO[entry.reportFormat].label}, which QAAI ` +
        `cannot parse yet and cannot convert without a pipe, so it reads the exit code.`;

  return { support: 'none', args: [], env: {}, reportPath: null, note };
}
