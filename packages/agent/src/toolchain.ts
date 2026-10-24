/**
 * The toolchain gates: parse, typecheck, format and lint a GENERATED file
 * before anything stores it.
 *
 * ── The two defects this file closes ────────────────────────────────────────
 *
 *  1. NOTHING IN THIS REPO PARSED GENERATED CODE. A model that dropped a
 *     closing brace produced a file that was written to the customer's branch,
 *     queued, run, and reported as "Playwright produced no report" — an
 *     infrastructure-shaped error message for a one-character syntax mistake.
 *     The run cost minutes, the message pointed at the wrong layer, and the
 *     person reading it had no reason to suspect the generator. A parse costs
 *     milliseconds and names the line.
 *
 *  2. NOTHING RAN THE REPOSITORY'S OWN FORMATTER OR LINTER. The product promise
 *     is "code we'd have written". A file with double quotes in a single-quote
 *     repo, or a four-space indent in a two-space repo, breaks that promise in
 *     the first second of code review — and a reformatting diff is the single
 *     commonest reason a generated test is deleted rather than fixed. Running
 *     the repo's *own* prettier/black/gofmt, with the repo's *own* config, is
 *     what makes the file look like it belongs there.
 *
 * ── The one rule that governs every return value ────────────────────────────
 *
 * "We could not check" and "we checked and it is fine" must never be the same
 * value. A tool that is not installed returns UNAVAILABLE, never PASS. A
 * timeout returns UNAVAILABLE, never PASS. `why` always names the tool that
 * ran and how it was resolved, because "LINT: PASS" from a linter that was
 * never installed is precisely the lie this file exists to prevent — and it is
 * a lie that gets *more* convincing the further it travels from here.
 *
 * Nothing here throws. Every failure mode — a missing binary, a timeout, a
 * crashed process, output that does not parse — is a GateOutcome. A gate that
 * throws takes the whole generation down, which trades a formatting nit for a
 * lost run.
 *
 * ── Why there are two child-environment allowlists in this repo ─────────────
 *
 * This file spawns tenant-adjacent tools (the customer's prettier, the
 * customer's eslint plugins — arbitrary code from their node_modules) from a
 * worker that holds VAULT_MASTER_KEY, DATABASE_URL, SESSION_SECRET,
 * S3_SECRET_ACCESS_KEY and STRIPE_SECRET_KEY. A single `...process.env` here
 * would hand every tenant's vault key to code the tenant installed.
 *
 * `packages/runner/src/child-env.ts` already solved this, and its doc comment
 * is the canonical explanation — read it. It cannot be imported: `@qaai/agent`
 * does not depend on `@qaai/runner`, and adding that dependency is a
 * package.json change that is not this file's to make. So the discipline is
 * MIRRORED below, deliberately and visibly:
 *
 *   - an ALLOWLIST, never a denylist. A denylist fails the moment someone adds
 *     an environment variable and forgets to deny it, and the cost of
 *     forgetting is total;
 *   - plus a second screen on anything a caller passes, by substring, so a
 *     merged config object cannot widen the list by accident.
 *
 * If you are changing either list, change both: this one and
 * `packages/runner/src/child-env.ts`. They are two copies of one decision, and
 * this paragraph exists so the next person finds the other one.
 *
 * NOT copied from that file: its `QAAI_STUB_` test hook. The tests here bake
 * their fixture paths into the stub scripts themselves, so there is no name
 * that a production deployment could be talked into setting.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { diffLines } from 'diff';
import ts from 'typescript';

// ─── The contract ────────────────────────────────────────────────────────────

/*
 * The gate vocabulary is `admission.ts`'s, not this file's.
 *
 * This file declared its own open `GateId` first, which read as the
 * conservative choice and was the wrong one: the pipeline keys
 * HARD_FAIL_GATES, SOFT_FAIL_GATES and GATE_ORDER on that union, and it is the
 * union's CLOSEDNESS that makes "a gate was added without anyone deciding what
 * a failure of it means" a compile error rather than a silent no-op. Two
 * definitions of the same four statuses is the shape of a drift bug, so there
 * is one, and it lives with the code that reasons about it.
 *
 * Type-only, so nothing is imported at runtime and the cycle
 * (admission → toolchain → admission) never exists outside the type checker.
 * Not re-exported either: the package barrel would then export `GateId` from
 * two modules, which is a duplicate-export error. Consumers import the gate
 * vocabulary from `admission.ts`, where it is defined.
 */
import type { GateId, GateOutcome, GateStatus } from './admission.js';

export interface ToolchainGates {
  syntax(input: GateInput): Promise<GateOutcome>;
  typecheck(input: GateInput): Promise<GateOutcome>;
  /**
   * Returns the FORMATTED source in `code` when a formatter ran, so the caller
   * stores the formatted version rather than the model's. `code` is absent
   * when no formatter ran (UNAVAILABLE) — the caller must then store what it
   * had, and must not treat a missing `code` as "no changes needed".
   */
  format(input: GateInput): Promise<GateOutcome & { code?: string }>;
  lint(input: GateInput): Promise<GateOutcome>;
}

export interface GateInput {
  /** The candidate source. Never written to `filePath`; see {@link toolchainFor}. */
  code: string;
  /**
   * Where the file WILL live, absolute or relative to the repo root. It is used
   * for three things and never opened for writing: to pick the language, to let
   * a tool resolve the config that applies at that path (prettier `overrides`,
   * an eslint flat-config `files` block, the nearest tsconfig), and to let
   * module resolution behave as it will once the file is really there.
   */
  filePath: string;
}

export interface ToolchainOptions {
  /** The customer's checkout. Every child runs with this as cwd. */
  repoRoot: string;
  /**
   * Hard ceiling per gate. 20s is chosen to be longer than any single-file
   * invocation observed (prettier ~300ms, eslint ~2s cold with type-aware
   * rules, a single-file tsc program ~250ms) and far shorter than a generation
   * is willing to wait.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** Caps so a chatty tool cannot exhaust the worker's memory or a DB column. */
const MAX_CAPTURED_OUTPUT = 200_000;
const MAX_DETAIL_LINES = 40;
const MAX_DETAIL_LINE_CHARS = 300;

// ─── Child environment: the mirrored allowlist ───────────────────────────────

/**
 * Everything a child may inherit. Mirrors `PASSTHROUGH` in
 * packages/runner/src/child-env.ts, minus the Playwright and X11 entries that
 * only a browser run needs — a formatter does not open a display.
 *
 * The bar for a new entry is "what breaks without it". If the answer is
 * "nothing", it does not belong here.
 */
const PASSTHROUGH = [
  // Binary resolution. Without PATH nothing we spawn can be found at all.
  'PATH',
  'Path', // Windows casing: Node normalises reads, but not an explicit env object.

  // Tool caches live under HOME — eslint's cache, ruff's, go's build cache.
  'HOME',
  'USERPROFILE',

  // Temp directories. Formatters and compilers write scratch files through these.
  'TMPDIR',
  'TMP',
  'TEMP',

  // Node refuses to start on Windows without these.
  'SystemRoot',
  'windir',
  'COMSPEC',

  // Locale. Affects how a linter sorts and reports; harmless, and omitting it
  // makes some Python tooling fall back to ASCII and mangle non-ASCII source.
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',

  // A self-hosted runner behind a corporate proxy. Nothing here should need the
  // network, but a Go toolchain consults these before deciding that.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',

  // Where a Go/Python/Ruby toolchain keeps its own installation. A worker image
  // that installs Go outside /usr/local cannot find its own stdlib without these.
  'GOROOT',
  'GOPATH',
  'GOCACHE',
  'GOFLAGS',
  'VIRTUAL_ENV',
  'PYTHONPATH',
  'GEM_HOME',
  'GEM_PATH',
] as const;

/**
 * Names that must never reach a child whatever else happens. The allowlist
 * above already excludes them — this is the second lock, for a caller that
 * builds `extra` from something wider than it realised. Matched
 * case-insensitively and by substring, because a leak through
 * `MY_APP_SECRET_KEY` is the same leak.
 *
 * Kept in step with `FORBIDDEN_SUBSTRINGS` in packages/runner/src/child-env.ts.
 */
const FORBIDDEN_SUBSTRINGS = [
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'TOKEN',
  'APIKEY',
  'API_KEY',
  'PRIVATE_KEY',
  'ACCESS_KEY',
  'CREDENTIAL',
  'MASTER_KEY',
  'DATABASE_URL',
  'REDIS_URL',
  'DSN',
  'SESSION',
  'ANTHROPIC',
  'STRIPE',
  'AWS_',
  'S3_',
  'SMTP_',
  'GITHUB_',
  'NPM_',
] as const;

/** True when a variable name is one no gate child may ever receive. */
export function isForbiddenGateEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return FORBIDDEN_SUBSTRINGS.some((bad) => upper.includes(bad));
}

/**
 * The environment for a spawned gate: the allowlist, then screened extras.
 *
 * Exported so the tests can assert on the object directly as well as on a real
 * child's observed environment. Both assertions are worth having — one proves
 * the policy, the other proves the policy is actually on the code path.
 *
 * There is no `secrets` parameter, unlike the runner's version. A formatter has
 * no business holding a credential, not even the tenant's own.
 */
export function gateChildEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  for (const [key, value] of Object.entries(extra)) {
    // A caller passing a platform secret through `extra` is a bug in the
    // caller. Dropping it silently would hide that, but throwing would fail a
    // generation for something the tenant did not do, so: drop, and leave the
    // assertion to the test suite.
    if (isForbiddenGateEnvKey(key)) continue;
    env[key] = value;
  }

  return env;
}

/**
 * Colour off, everywhere. Every parser below reads line-oriented text or JSON,
 * and an ANSI escape in the middle of a filename turns a precise error into an
 * unparseable one.
 */
const NO_COLOUR = { NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' };

// ─── Spawning ────────────────────────────────────────────────────────────────

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Set when the binary could not be executed at all (ENOENT, EACCES). */
  spawnError: string | null;
  timedOut: boolean;
  ms: number;
}

/**
 * Spawn one tool. Never rejects, never throws, never uses a shell.
 *
 * `shell: false` is the important word. Several arguments below are built from
 * a path the customer chose; through a shell, a repository directory called
 * `x; rm -rf ~` executes. An argv array means it can only ever be an argument.
 */
async function runTool(
  bin: string,
  args: readonly string[],
  opts: { cwd: string; stdin?: string; timeoutMs: number },
): Promise<RunResult> {
  const startedAt = Date.now();

  return new Promise<RunResult>((done) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const finish = (partial: Partial<RunResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(softKill);
      clearTimeout(hardKill);
      done({
        code: null,
        signal: null,
        stdout,
        stderr,
        spawnError: null,
        timedOut,
        ms: Date.now() - startedAt,
        ...partial,
      });
    };

    let child;
    try {
      child = spawn(bin, [...args], {
        cwd: opts.cwd,
        // Allowlisted, not inherited. See the file header and child-env.ts.
        env: gateChildEnv(NO_COLOUR),
        shell: false,
        stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      // spawn() throws synchronously on a malformed argv or an unusable cwd.
      // A gate must never let that escape.
      finish({ spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }

    const softKill = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs);

    // A tool that ignores SIGTERM must not pin the worker forever.
    const hardKill = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs + 2_000);

    child.stdout?.on('data', (b: Buffer) => {
      if (stdout.length < MAX_CAPTURED_OUTPUT) stdout += b.toString('utf8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (stderr.length < MAX_CAPTURED_OUTPUT) stderr += b.toString('utf8');
    });

    if (opts.stdin !== undefined && child.stdin) {
      // EPIPE: a tool that rejects the input and exits before reading all of it
      // makes this stream emit 'error'. Unhandled, that is an uncaught
      // exception in the worker — a crash caused by a formatter's opinion.
      child.stdin.on('error', () => {});
      child.stdin.end(opts.stdin, 'utf8');
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ spawnError: err.code ?? err.message });
    });

    child.on('close', (code, signal) => {
      finish({ code, signal });
    });
  });
}

// ─── Resolving a tool ────────────────────────────────────────────────────────

/** Where a binary came from. The `how` string lands verbatim in `why`. */
interface ResolvedTool {
  bin: string;
  /** Human-readable provenance, e.g. "<repo>/node_modules/.bin/prettier". */
  how: string;
  /** True when the binary lives inside the checkout — evidence by itself. */
  repoLocal: boolean;
}

/**
 * The project-local Node binary, and NEVER `npx`.
 *
 * `npx <pkg>` resolves the local binary when it exists — and FETCHES AND
 * EXECUTES the package from the registry when it does not. On a generation gate
 * that means a typo'd package name, or a package the customer removed, becomes
 * arbitrary code execution on the worker at test time, pulled from whoever
 * registered that name. packages/shared/src/ecosystems.ts documents the same
 * hazard for test invocation. So: look for the file, and if it is not there,
 * say UNAVAILABLE.
 *
 * The walk upward is npm's own resolution, not laxity: a customer repo is
 * frequently a sub-package of a monorepo (`repos/acme/packages/web`), where the
 * binary is hoisted to the workspace root. `maxUp` bounds it so a gate cannot
 * wander to `/`.
 */
function resolveNodeBin(repoRoot: string, bin: string, maxUp = 4): ResolvedTool | null {
  let dir = resolve(repoRoot);
  for (let i = 0; i <= maxUp; i++) {
    const candidate = join(dir, 'node_modules', '.bin', bin);
    if (existsSync(candidate)) {
      return {
        bin: candidate,
        how: i === 0 ? `${bin} at <repo>/node_modules/.bin/${bin}` : `${bin} at ${candidate}`,
        repoLocal: true,
      };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * A binary inside the checkout that is not a Node one: a Python virtualenv, a
 * Composer vendor dir, a Ruby `bin/` binstub. Repo-local, so its presence is
 * evidence that the repo uses it.
 *
 * Deliberately NOT `bundle exec` / `poetry run` / `pipenv run`: those resolve a
 * lockfile and, depending on configuration, install what is missing — the same
 * fetch-and-execute hazard as `npx`, wearing a different name.
 */
const VENDOR_BIN_DIRS = ['.venv/bin', 'venv/bin', 'env/bin', 'vendor/bin', 'bin'] as const;

function resolveVendorBin(repoRoot: string, bin: string): ResolvedTool | null {
  for (const dir of VENDOR_BIN_DIRS) {
    const candidate = join(repoRoot, ...dir.split('/'), bin);
    if (existsSync(candidate)) {
      return { bin: candidate, how: `${bin} at <repo>/${dir}/${bin}`, repoLocal: true };
    }
  }
  return null;
}

/**
 * A binary on PATH. Resolved by hand rather than left to `spawn`, so `why` can
 * name the absolute path that ran and so "not installed" is known BEFORE a
 * process exists — an ENOENT inferred from an exit code is indistinguishable
 * from a tool that ran and failed.
 *
 * Reads the same PATH the child will get, which is the allowlisted one.
 *
 * The two spellings are read through an indexed lookup rather than
 * `process.env.Path`, because `check:wiring` scans for `process.env.<NAME>`
 * and reads the uppercase prefix of that one as an undocumented variable
 * called `P`. The variable is of course PATH and is as documented as a
 * variable gets — but a checker that reports a phantom is a checker people
 * learn to skim, so it is cheaper to spell this in a way that cannot confuse
 * it than to teach everyone to ignore one line.
 */
const PATH_VARIABLES = ['PATH', 'Path'] as const;

function resolvePathBin(bin: string): ResolvedTool | null {
  for (const name of PATH_VARIABLES) {
    const raw = process.env[name];
    if (!raw) continue;
    for (const dir of raw.split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, bin);
      if (existsSync(candidate)) {
        return { bin: candidate, how: `${bin} on PATH (${candidate})`, repoLocal: false };
      }
    }
  }
  return null;
}

// ─── What this repository actually uses ──────────────────────────────────────

/**
 * The facts about one checkout, read once.
 *
 * Read, not assumed. The point of every field is that the answer belongs to the
 * CUSTOMER's repository: their formatter, their config, their style. Guessing
 * "it's TypeScript so it's prettier with default options" is how a generated
 * file arrives with a reformatting diff attached.
 *
 * Manifests are kept as raw text and matched with narrow patterns rather than
 * parsed. There is no TOML or YAML parser in this package's dependency set and
 * adding one is not this file's to do, so a text scan is the honest option —
 * with the honest limitation that a tool named inside a comment in pyproject.toml
 * counts as configured. That errs toward *looking for* the customer's tool,
 * which is the safe direction: the worst case is a resolution attempt that finds
 * nothing and reports UNAVAILABLE.
 */
interface RepoFacts {
  repoRoot: string;
  /** devDependencies + dependencies, flattened to a name set. */
  nodeDeps: ReadonlySet<string>;
  /** Every package.json script body, concatenated. */
  nodeScripts: string;
  /** Basenames present at the repo root (one readdir, not N stats). */
  rootFiles: ReadonlySet<string>;
  pyprojectText: string;
  setupCfgText: string;
  toxIniText: string;
  gemfileText: string;
  composerText: string;
  hasGoMod: boolean;
}

const EMPTY_FACTS: Omit<RepoFacts, 'repoRoot'> = {
  nodeDeps: new Set<string>(),
  nodeScripts: '',
  rootFiles: new Set<string>(),
  pyprojectText: '',
  setupCfgText: '',
  toxIniText: '',
  gemfileText: '',
  composerText: '',
  hasGoMod: false,
};

async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    // Missing, unreadable, or a directory. All three mean "this repo does not
    // tell us anything through this file", which is the empty string.
    return '';
  }
}

async function discoverRepo(repoRoot: string): Promise<RepoFacts> {
  const root = resolve(repoRoot);

  let rootFiles = new Set<string>();
  try {
    rootFiles = new Set(await readdir(root));
  } catch {
    // An unreadable repo root is a configuration problem, not a gate failure.
    // Every gate below will then resolve nothing and report UNAVAILABLE, which
    // is the correct answer for "we cannot see the repository".
    return { repoRoot: root, ...EMPTY_FACTS };
  }

  const [pkgRaw, pyprojectText, setupCfgText, toxIniText, gemfileText, composerText] =
    await Promise.all([
      readTextOrEmpty(join(root, 'package.json')),
      readTextOrEmpty(join(root, 'pyproject.toml')),
      readTextOrEmpty(join(root, 'setup.cfg')),
      readTextOrEmpty(join(root, 'tox.ini')),
      readTextOrEmpty(join(root, 'Gemfile')),
      readTextOrEmpty(join(root, 'composer.json')),
    ]);

  const nodeDeps = new Set<string>();
  let nodeScripts = '';
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      for (const name of Object.keys(pkg.devDependencies ?? {})) nodeDeps.add(name);
      for (const name of Object.keys(pkg.dependencies ?? {})) nodeDeps.add(name);
      nodeScripts = Object.values(pkg.scripts ?? {}).join('\n');
    } catch {
      // A package.json that does not parse is the customer's problem and not
      // one a generation gate should fail on. Binary resolution below does not
      // depend on this having worked.
    }
  }

  return {
    repoRoot: root,
    nodeDeps,
    nodeScripts,
    rootFiles,
    pyprojectText,
    setupCfgText,
    toxIniText,
    gemfileText,
    composerText,
    hasGoMod: rootFiles.has('go.mod'),
  };
}

function hasAnyRootFile(facts: RepoFacts, names: readonly string[]): boolean {
  return names.some((n) => facts.rootFiles.has(n));
}

/** Declared in package.json, or named by a script (`npm run lint` → eslint). */
function declaresNodeTool(facts: RepoFacts, pkg: string): boolean {
  return facts.nodeDeps.has(pkg) || facts.nodeScripts.includes(pkg);
}

/**
 * The config files that say "this repository has adopted this tool", by the
 * name the gate uses for it.
 *
 * Read for one purpose: to make the UNAVAILABLE message actionable. "prettier
 * is not installed" and "the repository has .prettierrc.json and declares
 * prettier in package.json, but node_modules is empty" are the same verdict and
 * very different pieces of advice — the second one says `npm ci` and the first
 * one says there is nothing to run. It is deliberately NOT used to decide
 * whether to run a tool: a config file is not an executable, and the only
 * honest way to get one is for it to be installed. That is the whole npx rule.
 */
const TOOL_CONFIG_PREFIXES: Record<string, readonly string[]> = {
  prettier: ['.prettierrc', 'prettier.config'],
  eslint: ['eslint.config', '.eslintrc'],
  rubocop: ['.rubocop.yml'],
  'rubocop -a': ['.rubocop.yml'],
  phpcs: ['phpcs.xml', '.phpcs.xml'],
  'php-cs-fixer': ['.php-cs-fixer'],
  'ruff check': ['.ruff.toml', 'ruff.toml'],
  'ruff format': ['.ruff.toml', 'ruff.toml'],
  black: ['pyproject.toml'],
  flake8: ['.flake8', 'setup.cfg'],
  pylint: ['.pylintrc', 'pylintrc'],
  mypy: ['mypy.ini', '.mypy.ini'],
  pyright: ['pyrightconfig.json'],
};

/** "…, although the repository does configure it (.prettierrc.json; package.json)". */
function describeRepoSignals(facts: RepoFacts, label: string): string {
  const signals: string[] = [];

  for (const prefix of TOOL_CONFIG_PREFIXES[label] ?? []) {
    for (const name of facts.rootFiles) {
      if (name.startsWith(prefix) && !signals.includes(name)) signals.push(name);
    }
  }

  // The bare package name, for a label like `ruff check` or `rubocop -a`.
  const pkg = label.split(' ')[0] ?? label;
  if (declaresNodeTool(facts, pkg)) signals.push('declared in package.json');

  if (signals.length === 0) return '';
  return ` — although this repository does configure it (${signals.join('; ')}), so it may just need installing`;
}

/**
 * Does the repository configure this Python tool?
 *
 * This gate matters more than it looks. A worker image with a global `black`
 * would otherwise reformat a repo that uses `ruff format` — producing exactly
 * the reformatting diff that gets generated tests deleted. So a Python tool is
 * only used when the REPO points at it, or when the binary lives in the repo's
 * own virtualenv.
 */
const PYTHON_TOOL_SIGNALS: Record<
  string,
  { files: readonly string[]; sections: readonly string[] }
> = {
  black: { files: [], sections: ['[tool.black]'] },
  ruff: { files: ['.ruff.toml', 'ruff.toml'], sections: ['[tool.ruff]', '[tool.ruff.'] },
  mypy: { files: ['mypy.ini', '.mypy.ini'], sections: ['[tool.mypy]', '[mypy]'] },
  pyright: { files: ['pyrightconfig.json'], sections: ['[tool.pyright]'] },
  flake8: { files: ['.flake8'], sections: ['[flake8]'] },
  pylint: { files: ['.pylintrc', 'pylintrc'], sections: ['[tool.pylint'] },
};

function configuresPythonTool(facts: RepoFacts, tool: keyof typeof PYTHON_TOOL_SIGNALS): boolean {
  const signal = PYTHON_TOOL_SIGNALS[tool];
  if (!signal) return false;
  if (hasAnyRootFile(facts, signal.files)) return true;
  const manifests = `${facts.pyprojectText}\n${facts.setupCfgText}\n${facts.toxIniText}`;
  if (signal.sections.some((s) => manifests.includes(s))) return true;
  // A dependency list naming the tool: `black==24.*` in pyproject's
  // [project.optional-dependencies], or a requirements line pulled in above.
  return new RegExp(`(^|[\\s"'\\[])${tool}([\\s"'\\]=<>~!,;]|$)`, 'm').test(manifests);
}

// ─── Languages ───────────────────────────────────────────────────────────────

type GateLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'ruby'
  | 'php'
  | 'go'
  | 'java'
  | 'kotlin'
  | 'csharp'
  | 'rust'
  | 'swift'
  | 'other';

const EXT_LANGUAGE: Record<string, GateLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.php': 'php',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.cs': 'csharp',
  '.rs': 'rust',
  '.swift': 'swift',
};

function languageOf(filePath: string): GateLanguage {
  return EXT_LANGUAGE[extname(filePath).toLowerCase()] ?? 'other';
}

/**
 * Extensions prettier infers a parser for. A generated fixture (`.json`), a
 * page object in `.vue`, a seeded `.yaml` — all of them are files a reviewer
 * will read, so all of them should arrive formatted even though nothing here
 * can parse or typecheck them.
 */
const PRETTIER_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.json5',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.vue',
  '.svelte',
  '.md',
  '.mdx',
  '.yaml',
  '.yml',
  '.graphql',
  '.gql',
]);

/**
 * Why each of these languages reports UNAVAILABLE for SYNTAX rather than
 * shelling out to its compiler.
 *
 * Every one of them was considered. The test is "cheap and correct on ONE
 * file", and none of them passes it: these compilers resolve the whole module
 * graph before they will say a word about syntax, so on a single generated file
 * they emit a wall of "cannot find symbol" that has nothing to do with whether
 * the braces balance. Reporting that as a syntax failure would block correct
 * code; reporting it as a pass would be worse. So we say we did not check.
 */
const NO_CHEAP_PARSER: Partial<Record<GateLanguage, string>> = {
  java: 'javac cannot parse one file without the project classpath — its errors would be about missing imports, not syntax',
  kotlin: 'kotlinc has no parse-only mode that works on a single file outside its module',
  csharp:
    'the Roslyn CLI compiles a project, not a file; `dotnet build` on one .cs file is not a parse',
  rust: 'rustc needs the crate to resolve a single file, and -Zparse-only is nightly-only',
  swift:
    'swiftc -parse exists but is not installed on a QA worker image, and shipping a code path we never execute is how a gate starts lying',
  other: 'no parser is known for this file type',
};

// ─── Outcome plumbing ────────────────────────────────────────────────────────

function outcome(
  gate: GateId,
  status: GateStatus,
  why: string,
  detail: readonly string[] = [],
  line: number | null = null,
): GateOutcome {
  return { gate, status, why, detail: capDetail(detail), line };
}

function capDetail(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    for (const piece of String(raw).split('\n')) {
      const trimmed = piece.trimEnd();
      if (!trimmed.trim()) continue;
      out.push(
        trimmed.length > MAX_DETAIL_LINE_CHARS
          ? `${trimmed.slice(0, MAX_DETAIL_LINE_CHARS)}…`
          : trimmed,
      );
      if (out.length >= MAX_DETAIL_LINES) return out;
    }
  }
  return out;
}

/** First capture group of the first match, as a 1-based line number. */
function lineFrom(text: string, pattern: RegExp): number | null {
  const m = pattern.exec(text);
  const raw = m?.[1];
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Replace the scratch path with the path the file will really have.
 *
 * Without this, a Ruby syntax error reads
 * `/var/folders/t4/…/T/qaai-gate-Xy9/login_spec.rb:12: syntax error` — a path
 * that does not exist by the time anyone reads it, in a message whose whole
 * value is telling you where to look.
 */
function scrubPaths(text: string, tempPath: string, realPath: string): string {
  return text.split(tempPath).join(realPath).split(dirname(tempPath)).join('<tmp>');
}

/** A spawn that could not start, rendered as the one honest status. */
function unavailableFromSpawn(gate: GateId, tool: ResolvedTool, result: RunResult): GateOutcome {
  if (result.spawnError === 'ENOENT') {
    return outcome(
      gate,
      'UNAVAILABLE',
      `${tool.how} disappeared between resolving it and running it, so nothing was checked`,
    );
  }
  return outcome(
    gate,
    'UNAVAILABLE',
    `${tool.how} could not be started (${result.spawnError ?? 'unknown error'}), so nothing was checked`,
  );
}

/** A timeout, rendered as the one honest status. It is never a PASS. */
function unavailableFromTimeout(gate: GateId, tool: string, timeoutMs: number): GateOutcome {
  // Milliseconds below a second: rounding a 250ms budget to "0s" makes the
  // message read like a bug in the gate rather than a deadline someone set.
  const budget = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
  return outcome(
    gate,
    'UNAVAILABLE',
    `${tool} did not finish within ${budget} and was stopped, so nothing was checked`,
  );
}

// ─── A scratch file we own ───────────────────────────────────────────────────

/**
 * Write the candidate into a temp directory of our own and hand the path to a
 * callback, then remove the directory.
 *
 * The customer's real file is NEVER touched. That is not squeamishness: the
 * generation may be a *replacement* for a file that currently exists and
 * currently passes, and a gate that writes it before deciding whether it is
 * valid has destroyed a working test to check an invalid one. For
 * TypeScript the candidate is never written anywhere at all — see
 * {@link typecheckTypeScript}, which overlays it in memory instead.
 *
 * The basename is preserved, because for most of these tools the extension IS
 * the language selector.
 */
async function withScratchFile<T>(
  code: string,
  filePath: string,
  body: (scratchPath: string, scratchDir: string) => Promise<T>,
  onFailure: (message: string) => T,
): Promise<T> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'qaai-gate-'));
    const scratch = join(dir, basename(filePath) || 'candidate');
    await writeFile(scratch, code, 'utf8');
    return await body(scratch, dir);
  } catch (err) {
    // A full disk or a read-only tmpdir is an environment problem. It must
    // surface as "we could not check", never as a thrown error that aborts a
    // generation and never as a pass.
    return onFailure(err instanceof Error ? err.message : String(err));
  } finally {
    if (dir) {
      // A cleanup failure must not change the verdict we already have.
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ─── SYNTAX ──────────────────────────────────────────────────────────────────

/**
 * TypeScript/JavaScript, parsed IN PROCESS with the `typescript` package.
 *
 * Transpile-only: no Program, no compiler host, no module resolution, no type
 * information. That is the whole point — this gate answers "is this a parseable
 * file", which is the question that was costing a full Playwright run to
 * answer. `transpileModule` with `reportDiagnostics` is the public API for it
 * and returns syntactic diagnostics with offsets; measured at well under 10ms
 * for a generated spec.
 *
 * What it does NOT catch, deliberately: anything needing a type. A spec calling
 * `page.gotoo()` parses perfectly. That is TYPECHECK's job, and keeping the two
 * separate is what lets SYNTAX be cheap enough to run on every candidate.
 */
function syntaxTypeScript(code: string, filePath: string): GateOutcome {
  const why = `parsed in process with the bundled typescript ${ts.version} (transpile-only: no program, no type resolution)`;
  const ext = extname(filePath).toLowerCase();
  const kind =
    ext === '.tsx' || ext === '.jsx'
      ? ts.ScriptKind.TSX
      : ext.startsWith('.j')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    isolatedModules: true,
  };
  // JSX must be *allowed* or every .tsx file is a syntax error. Which transform
  // the repo uses is irrelevant to whether the file parses. Set only for TSX:
  // `jsx: undefined` is not the same as absent — TypeScript validates the
  // option, reports TS6046 ("Argument for '--jsx' option must be…"), and that
  // diagnostic then looks exactly like a syntax error in the customer's file.
  if (kind === ts.ScriptKind.TSX) compilerOptions.jsx = ts.JsxEmit.Preserve;

  let diagnostics: readonly ts.Diagnostic[];
  try {
    const result = ts.transpileModule(code, {
      fileName: basename(filePath),
      reportDiagnostics: true,
      compilerOptions,
    });
    diagnostics = result.diagnostics ?? [];
  } catch (err) {
    return outcome(
      'SYNTAX',
      'UNAVAILABLE',
      `the typescript parser threw instead of reporting (${err instanceof Error ? err.message : String(err)}), so nothing was checked`,
    );
  }

  /*
   * Only diagnostics that point INTO THE SOURCE can be syntax errors.
   *
   * `transpileModule` also returns compiler-OPTION diagnostics, which carry no
   * file and no position. Those are a defect in this function's invocation, not
   * in the candidate — and the TS6046 above is what that looks like when it
   * goes wrong. Counting them as syntax errors would reject correct generated
   * code and explain the rejection with a message about a compiler flag the
   * customer never set, which is the most expensive kind of false positive
   * there is. So they are excluded from the verdict and attached as a note, so
   * they are visible to us without being charged to the file.
   */
  const syntactic = diagnostics.filter((d) => d.file !== undefined && d.start !== undefined);
  const notes = diagnostics
    .filter((d) => d.file === undefined || d.start === undefined)
    .map(
      (d) =>
        `note: the parser was invoked with a bad option — TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
    );

  if (syntactic.length === 0) {
    return outcome('SYNTAX', 'PASS', why, notes);
  }

  const detail: string[] = [...notes];
  let firstLine: number | null = null;
  for (const d of syntactic) {
    const line = d.start === undefined ? null : lineOfOffset(code, d.start);
    if (firstLine === null) firstLine = line;
    const where = line === null ? '' : `line ${line}: `;
    detail.push(`${where}TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  }

  return outcome(
    'SYNTAX',
    'FAIL',
    `${why} — ${syntactic.length} syntax error${syntactic.length === 1 ? '' : 's'}`,
    detail,
    firstLine,
  );
}

/**
 * Offset → 1-based line. Computed from the string rather than from the
 * diagnostic's SourceFile so this cannot depend on which API produced it.
 */
function lineOfOffset(code: string, offset: number): number {
  let line = 1;
  const stop = Math.min(offset, code.length);
  for (let i = 0; i < stop; i++) if (code.charCodeAt(i) === 10 /* \n */) line++;
  return line;
}

/**
 * The spawned single-file parsers.
 *
 * Each of these is the LANGUAGE'S OWN parser invoked in its cheapest mode, so
 * no repo evidence is required to use it: `python3 -m py_compile` is what
 * Python thinks Python is, regardless of whether the repo prefers ruff or
 * flake8. That is why these resolve from PATH without the configuration check
 * the formatters below insist on.
 */
interface SpawnedParser {
  bins: readonly string[];
  /** argv, given the scratch path. */
  args: (scratchPath: string) => readonly string[];
  /** Reads a line number out of the tool's own complaint. */
  linePattern: RegExp;
  /** Which stream carries the complaint. */
  stream: 'stderr' | 'stdout' | 'both';
  /** Set when the tool also prints the file on success (gofmt). */
  quietOnSuccess?: boolean;
}

const SPAWNED_PARSERS: Partial<Record<GateLanguage, SpawnedParser>> = {
  python: {
    bins: ['python3', 'python'],
    args: (p) => ['-m', 'py_compile', p],
    // `Sorry: IndentationError: unexpected indent (bad.py, line 3)` and the
    // traceback form `File "bad.py", line 3`.
    linePattern: /,? line (\d+)/,
    stream: 'both',
  },
  ruby: {
    bins: ['ruby'],
    args: (p) => ['-c', p],
    // `bad.rb:2: syntax error, unexpected end-of-input`
    linePattern: /:(\d+):/,
    stream: 'both',
  },
  php: {
    bins: ['php'],
    args: (p) => ['-l', p],
    // `Parse error: syntax error, unexpected '}' in /tmp/x.php on line 4`
    linePattern: /on line (\d+)/,
    stream: 'both',
  },
  go: {
    // `gofmt -e` parses and reports syntax errors; it is the cheapest correct
    // Go parse available without a package, and unlike `go build` it needs no
    // module graph.
    bins: ['gofmt'],
    args: (p) => ['-e', p],
    linePattern: /:(\d+):\d+:/,
    stream: 'stderr',
    quietOnSuccess: false,
  },
};

// ─── TYPECHECK ───────────────────────────────────────────────────────────────

/**
 * Single-file typecheck, in process, with the repository's own tsconfig.
 *
 * ── Why not `tsc -p tsconfig.json` ─────────────────────────────────────────
 * A full project typecheck on a real customer repo is 10–90 seconds. A
 * generation gate that costs a minute is a gate someone turns off, and a gate
 * someone turns off is the defect this file was written to fix, back again. So
 * we do NOT typecheck the project.
 *
 * ── What we do instead ─────────────────────────────────────────────────────
 * We read the nearest tsconfig the file will actually be governed by (exactly
 * the file the editor would use), take its compilerOptions, and build a Program
 * seeded with ONE root file: this one. Its imports are resolved and loaded, so
 * `page.gotoo()` and a wrong argument to a project helper are both caught — but
 * the other 4,000 files in the repo are never read. `skipLibCheck` is forced on
 * because errors inside the customer's .d.ts files are not this candidate's
 * fault and must not be reported as if they were. Measured ~250ms for a
 * Playwright spec against this monorepo's own tsconfig.
 *
 * The candidate is overlaid IN MEMORY at its real path. Nothing is written to
 * the checkout, and because the overlay sits at the real path, relative imports
 * and node_modules resolve exactly as they will once the file is committed.
 *
 * ── What a single-file typecheck CANNOT catch ──────────────────────────────
 *   - anything in another file that this file breaks. Deleting an export that
 *     three other specs import is invisible here: we never load those specs.
 *   - a duplicate declaration, a merged-interface conflict, or an ambient type
 *     collision contributed by a file outside this one's import graph.
 *   - errors `skipLibCheck` suppresses, including a genuinely broken
 *     node_modules type that would fail the customer's own `tsc`.
 *   - project-wide option errors (an invalid tsconfig): those are the repo's
 *     pre-existing state, not the candidate's, so they are reported as
 *     UNAVAILABLE rather than charged to the generated file.
 * A green TYPECHECK here therefore means "this file is consistent with what it
 * imports", which is the claim the gate makes and no more.
 */
function typecheckTypeScript(
  code: string,
  targetPath: string,
  repoRoot: string,
  timeoutMs: number,
): GateOutcome {
  const configPath = findRepoTsconfig(targetPath, repoRoot);
  if (!configPath) {
    return outcome(
      'TYPECHECK',
      'UNAVAILABLE',
      'no tsconfig.json governs this path, so there are no compiler options to check against',
    );
  }

  // Wrapped rather than passed as `ts.sys.readFile`: an unbound method handed
  // to a callee that may re-invoke it with a different receiver.
  const read = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p));
  if (read.error) {
    return outcome(
      'TYPECHECK',
      'UNAVAILABLE',
      `${relativeTo(repoRoot, configPath)} could not be read, so nothing was checked`,
      [ts.flattenDiagnosticMessageText(read.error.messageText, ' ')],
    );
  }

  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );

  // TS18003 ("no inputs were found") is expected and irrelevant: a config with
  // `files: []` is a legitimate solution-style root, and we supply the root
  // file ourselves. Anything else at Error category means the repo's config is
  // broken, which is not the candidate's fault.
  const configErrors = parsed.errors.filter(
    (e) => e.category === ts.DiagnosticCategory.Error && e.code !== 18003,
  );
  if (configErrors.length > 0) {
    return outcome(
      'TYPECHECK',
      'UNAVAILABLE',
      `${relativeTo(repoRoot, configPath)} does not parse, so nothing was checked — this is the repository's configuration, not the generated file`,
      configErrors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, ' ')),
    );
  }

  const isJs = ['.js', '.jsx', '.mjs', '.cjs'].includes(extname(targetPath).toLowerCase());
  if (isJs && !(parsed.options.checkJs ?? false)) {
    return outcome(
      'TYPECHECK',
      'UNAVAILABLE',
      `${relativeTo(repoRoot, configPath)} does not set checkJs, so this repository does not typecheck JavaScript and neither do we`,
    );
  }

  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    // Not the candidate's fault, and the single biggest cost in the run.
    skipLibCheck: true,
    // A composite/incremental project would try to read or write a build info
    // file for a program that is not the project. Strip all of it.
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    tsBuildInfoFile: undefined,
    allowJs: parsed.options.allowJs ?? isJs,
  };

  const why = `typechecked in process with the bundled typescript ${ts.version} against ${relativeTo(repoRoot, configPath)}, one file only`;

  // Started before program construction on purpose: that phase cannot be
  // cancelled, so the only way it can be held to the budget is to measure it
  // and refuse to claim a result once it has overrun. See the note below.
  const deadline = Date.now() + timeoutMs;

  try {
    const host = ts.createCompilerHost(options, /* setParentNodes */ true);
    const matches = sameFileComparer(targetPath);

    const realGetSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
      matches(name)
        ? ts.createSourceFile(name, code, languageVersion, true, scriptKindOf(name))
        : realGetSourceFile(name, languageVersion, onError, shouldCreate);

    const realFileExists = host.fileExists.bind(host);
    host.fileExists = (name) => matches(name) || realFileExists(name);

    const realReadFile = host.readFile.bind(host);
    host.readFile = (name) => (matches(name) ? code : realReadFile(name));

    // noEmit already prevents this; stated so a future option change cannot
    // turn a gate into a writer inside the customer's checkout.
    host.writeFile = () => {};

    const program = ts.createProgram([targetPath], options, host);
    const sourceFile = program.getSourceFile(targetPath);
    if (!sourceFile) {
      return outcome(
        'TYPECHECK',
        'UNAVAILABLE',
        `${why} — but the compiler did not accept the overlaid file, so nothing was checked`,
      );
    }

    /*
     * A real timeout for in-process work, in two halves.
     *
     * A synchronous typecheck cannot be killed from outside, so the ceiling is
     * enforced from inside — and it takes two mechanisms, because the work has
     * two phases with different cancellability:
     *
     *   1. Program construction (parse + module resolution) is NOT
     *      cancellable. So it is bounded by construction instead: one root
     *      file, skipLibCheck forced on. And when it has already spent the
     *      whole budget, we say so rather than carrying on — a PASS returned
     *      after the caller's hard timeout has elapsed is not a PASS the caller
     *      asked for, and `timeoutMs` would be a suggestion rather than a
     *      ceiling.
     *
     *   2. Checking IS cancellable: TypeScript polls the token below. This is
     *      where the time goes on a large file, and where cancellation
     *      actually bites. On a small file checking can finish before the
     *      first poll, which is exactly why (1) is not optional.
     */
    if (Date.now() > deadline) {
      return unavailableFromTimeout(
        'TYPECHECK',
        'building the single-file program (parse and module resolution, which cannot be interrupted)',
        timeoutMs,
      );
    }

    const token: ts.CancellationToken = {
      isCancellationRequested: () => Date.now() > deadline,
      throwIfCancellationRequested: () => {
        /*
         * `only-throw-error` is right in general and wrong here. TypeScript
         * recognises cancellation by catching this exact class and nothing
         * else, and `ts.OperationCanceledException` deliberately does NOT
         * extend Error — throwing a real Error instead would propagate out of
         * the compiler as a crash rather than being understood as "stop", and
         * the gate would report a broken compiler instead of a timeout.
         */
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        if (Date.now() > deadline) throw new ts.OperationCanceledException();
      },
    };

    const diagnostics = [
      ...program.getSyntacticDiagnostics(sourceFile, token),
      ...program.getSemanticDiagnostics(sourceFile, token),
    ];

    if (diagnostics.length === 0) return outcome('TYPECHECK', 'PASS', why);

    const detail: string[] = [];
    let firstLine: number | null = null;
    for (const d of diagnostics) {
      const line = d.start === undefined ? null : lineOfOffset(code, d.start);
      if (firstLine === null) firstLine = line;
      const where = line === null ? '' : `line ${line}: `;
      detail.push(`${where}TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }

    return outcome(
      'TYPECHECK',
      'FAIL',
      `${why} — ${diagnostics.length} type error${diagnostics.length === 1 ? '' : 's'}`,
      detail,
      firstLine,
    );
  } catch (err) {
    if (err instanceof ts.OperationCanceledException) {
      return unavailableFromTimeout('TYPECHECK', 'the in-process typecheck', timeoutMs);
    }
    // A compiler crash — a circular tsconfig extends, a path mapping the host
    // cannot resolve, a stack overflow on a pathological type. We did not get
    // an answer, and that is all we may claim.
    return outcome(
      'TYPECHECK',
      'UNAVAILABLE',
      `${why} — but the compiler threw (${err instanceof Error ? err.message : String(err)}), so nothing was checked`,
    );
  }
}

function scriptKindOf(name: string): ts.ScriptKind {
  switch (extname(name).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/**
 * Compare two paths the way the host's file system does. TypeScript hands back
 * normalised forward-slash paths; a case-insensitive volume needs the fold.
 */
function sameFileComparer(target: string): (candidate: string) => boolean {
  const norm = (p: string) => {
    const r = resolve(p).replace(/\\/g, '/');
    return ts.sys.useCaseSensitiveFileNames ? r : r.toLowerCase();
  };
  const wanted = norm(target);
  return (candidate) => norm(candidate) === wanted;
}

/**
 * The tsconfig that governs this path — nearest first, exactly as an editor
 * resolves it, then the repo root as a fallback.
 *
 * Bounded to the checkout on purpose: `ts.findConfigFile` walks to `/`, and a
 * tsconfig found in some parent of the customer's checkout belongs to whatever
 * else is on that worker's disk, not to them.
 */
function findRepoTsconfig(targetPath: string, repoRoot: string): string | null {
  const found = ts.findConfigFile(dirname(targetPath), (p) => ts.sys.fileExists(p));
  if (found && isInside(repoRoot, found)) return found;
  const atRoot = join(resolve(repoRoot), 'tsconfig.json');
  return existsSync(atRoot) ? atRoot : null;
}

function isInside(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  return c === r || c.startsWith(r.endsWith('/') ? r : `${r}/`);
}

function relativeTo(root: string, path: string): string {
  const r = resolve(root);
  const p = resolve(path);
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : p;
}

// ─── FORMAT ──────────────────────────────────────────────────────────────────

/**
 * How a formatter is driven.
 *
 * `stdin` is strongly preferred: it is the only mode where the customer's
 * checkout is provably untouched, and both prettier and black apply the config
 * that belongs to `--stdin-filepath` just as if the file were there. `scratch`
 * is for in-place-only tools (rubocop, php-cs-fixer, ktlint), which rewrite the
 * file they are given — so they are given a copy in a directory we own.
 */
type FormatterMode = 'stdin' | 'scratch';

interface Formatter {
  label: string;
  mode: FormatterMode;
  /** Candidate binaries, in preference order. */
  bins: readonly string[];
  /** argv. `target` is the scratch path for `scratch`, unused for `stdin`. */
  args: (ctx: { realPath: string; target: string }) => readonly string[];
  /**
   * What makes this tool the RIGHT one for this repository.
   *
   * 'repo-local'  — only when the binary is inside the checkout. Its presence
   *                 there is the repo choosing it.
   * 'canonical'   — the language has exactly one formatter and everybody uses
   *                 it (gofmt, ktlint). PATH is enough.
   * 'configured'  — a global binary is NOT evidence. A worker image with a
   *                 stray `black` must not reformat a ruff-format repo: that
   *                 produces the whole-file reformatting diff that gets
   *                 generated tests deleted on sight, which is the exact defect
   *                 this gate exists to prevent.
   */
  evidence: 'repo-local' | 'canonical' | 'configured';
  /** For 'configured': does this repo point at the tool? */
  configured?: (facts: RepoFacts) => boolean;
}

const FORMATTERS: Partial<Record<GateLanguage, readonly Formatter[]>> = {
  typescript: [prettierFormatter()],
  javascript: [prettierFormatter()],
  other: [prettierFormatter()],
  python: [
    {
      label: 'black',
      mode: 'stdin',
      bins: ['black'],
      // `-q -` reads stdin and writes the formatted source to stdout.
      // `--stdin-filename` is what makes black apply per-path exclusions and
      // pick the right target version from pyproject.
      args: ({ realPath }) => ['-q', '--stdin-filename', realPath, '-'],
      evidence: 'configured',
      configured: (f) => configuresPythonTool(f, 'black'),
    },
    {
      label: 'ruff format',
      mode: 'stdin',
      bins: ['ruff'],
      args: ({ realPath }) => ['format', '--stdin-filename', realPath, '-'],
      evidence: 'configured',
      configured: (f) => configuresPythonTool(f, 'ruff'),
    },
  ],
  go: [
    {
      label: 'gofmt',
      mode: 'stdin',
      bins: ['gofmt'],
      args: () => [],
      evidence: 'canonical',
    },
  ],
  ruby: [
    {
      label: 'rubocop -a',
      mode: 'scratch',
      bins: ['rubocop'],
      // `-a` is the safe-autocorrect set; `-A` includes corrections rubocop
      // itself calls unsafe, and a gate must not make a semantic change to a
      // test nobody has read yet. `--force-exclusion` is off deliberately: the
      // scratch path is not the real path, so exclusions keyed on it would
      // misfire — the config is still honoured through `--config` resolution
      // from cwd.
      args: ({ target }) => ['-a', '--format', 'quiet', target],
      evidence: 'configured',
      configured: (f) => f.rootFiles.has('.rubocop.yml') || f.gemfileText.includes('rubocop'),
    },
  ],
  php: [
    {
      label: 'php-cs-fixer',
      mode: 'scratch',
      bins: ['php-cs-fixer'],
      args: ({ target }) => ['fix', '--quiet', '--using-cache=no', target],
      evidence: 'repo-local',
    },
    {
      label: 'phpcbf',
      mode: 'scratch',
      bins: ['phpcbf'],
      args: ({ target }) => ['-q', target],
      evidence: 'repo-local',
    },
  ],
  kotlin: [
    {
      label: 'ktlint -F',
      mode: 'scratch',
      bins: ['ktlint'],
      args: ({ target }) => ['-F', '--log-level=none', target],
      evidence: 'canonical',
    },
  ],
  /*
   * C# has no entry, and that is a decision rather than an omission.
   * `dotnet format` operates on a project or solution: it restores, loads the
   * MSBuild graph and formats what the project includes. There is no
   * single-file mode, so the cheapest honest invocation is tens of seconds on a
   * file the project does not yet contain. A gate that costs that much gets
   * disabled. FORMAT therefore returns UNAVAILABLE for .cs with that reason.
   */
};

function prettierFormatter(): Formatter {
  return {
    label: 'prettier',
    mode: 'stdin',
    bins: ['prettier'],
    /*
     * No `--config`: `--stdin-filepath` makes prettier resolve configuration
     * from that path itself, which picks up a nested `.prettierrc`, a
     * `prettier` key in package.json, `.editorconfig`, and any `overrides`
     * block whose glob matches — i.e. the customer's style at the exact
     * location the file will live. Passing a config we found at the repo root
     * would override all of that with a worse guess.
     */
    args: ({ realPath }) => ['--stdin-filepath', realPath],
    evidence: 'repo-local',
  };
}

// ─── LINT ────────────────────────────────────────────────────────────────────

/**
 * How a linter's output is read, and how its severities become a GateStatus.
 *
 * ── The error/warning mapping, and why ─────────────────────────────────────
 * The rule is: a lint complaint is a WARN unless the linter itself grades it as
 * an error. A generated test that trips a style rule should not be thrown away
 * — a human can accept it and move on — but one that trips a rule the project
 * has chosen to call an error would not pass their CI, so admitting it is
 * admitting a known-red file.
 *
 * Which linters grade, and how we read the grade:
 *   eslint   — grades. Exit 1 means "errors present", exit 0 with output means
 *              "warnings only", exit 2 means eslint itself failed. The JSON
 *              formatter carries the same information per message
 *              (severity 2 = error, 1 = warning), so we read it there and get
 *              per-finding precision instead of one bit for the whole file.
 *   pylint   — grades, via an exit-code BITMASK: 1 fatal, 2 error, 4 warning,
 *              8 refactor, 16 convention. Bits 1|2 are FAIL, the rest WARN.
 *   rubocop  — grades in its JSON (`severity`: fatal/error vs
 *              warning/convention/refactor), but NOT in its exit code, which is
 *              1 for any offence at all.
 *   phpcs    — grades in its JSON (errors vs warnings).
 *   ruff     — does NOT grade. Every violation is one severity and exit 1 means
 *              "found something". So everything it reports is a WARN. Calling
 *              it FAIL would be inventing a severity the tool declined to
 *              assign.
 *   flake8   — same as ruff.
 */
interface Linter {
  label: string;
  bins: readonly string[];
  mode: FormatterMode;
  args: (ctx: { realPath: string; target: string }) => readonly string[];
  evidence: 'repo-local' | 'configured';
  configured?: (facts: RepoFacts) => boolean;
  /** Turns a finished process into findings. Never throws. */
  read: (result: RunResult) => LintReading;
}

interface LintReading {
  /** True when the output could not be read at all — UNAVAILABLE, not PASS. */
  unreadable?: string;
  errors: number;
  warnings: number;
  detail: string[];
  line: number | null;
}

const ESLINT_TOOLING_ERROR = [
  // typescript-eslint's project service refusing a path it cannot place. This
  // is the normal case for a NEW generated file: the path is not on disk yet,
  // so no tsconfig include matches it. It is not a defect in the candidate.
  'was not found by the project service',
  'Consider either including it in',
  'parserOptions.project',
  'ESLint configuration',
  'Could not find config file',
  'Failed to load',
  'Cannot find module',
] as const;

function readEslintJson(result: RunResult): LintReading {
  // Exit 2 is "eslint could not run" (no config, a broken plugin). There is no
  // JSON in that case, only a human-readable complaint on stderr.
  if (result.code === 2 || !result.stdout.trim()) {
    return {
      unreadable:
        firstMeaningfulLine(result.stderr) ??
        `eslint exited ${result.code ?? 'on a signal'} with no report`,
      errors: 0,
      warnings: 0,
      detail: capDetail([result.stderr]),
      line: null,
    };
  }

  let files: EslintFileReport[];
  try {
    files = JSON.parse(result.stdout) as EslintFileReport[];
  } catch {
    return {
      unreadable: 'eslint printed output that is not JSON',
      errors: 0,
      warnings: 0,
      detail: capDetail([result.stdout.slice(0, 2_000)]),
      line: null,
    };
  }

  const detail: string[] = [];
  let errors = 0;
  let warnings = 0;
  let line: number | null = null;

  for (const file of files) {
    for (const m of file.messages ?? []) {
      /*
       * A fatal message with no line is eslint failing, not the file failing:
       * a missing config, an unloadable plugin, or the project-service refusal
       * above. A fatal message WITH a line is a genuine parse error in the
       * candidate, which is a real finding (and one SYNTAX already owns).
       */
      if (
        m.fatal &&
        (m.line === undefined || ESLINT_TOOLING_ERROR.some((t) => m.message.includes(t)))
      ) {
        return {
          unreadable: m.message.split('\n')[0] ?? 'eslint could not lint this path',
          errors: 0,
          warnings: 0,
          detail: capDetail([m.message]),
          line: null,
        };
      }

      if (m.severity === 2) errors++;
      else warnings++;
      if (line === null && m.line !== undefined) line = m.line;
      const at = m.line === undefined ? '' : `line ${m.line}: `;
      const rule = m.ruleId ? ` (${m.ruleId})` : '';
      detail.push(`${at}${m.severity === 2 ? 'error' : 'warning'}: ${m.message}${rule}`);
    }
  }

  return { errors, warnings, detail: capDetail(detail), line };
}

interface EslintFileReport {
  messages?: {
    ruleId?: string | null;
    severity?: number;
    message: string;
    line?: number;
    fatal?: boolean;
  }[];
}

/** Every violation at one severity: a WARN, because the tool assigned no other. */
function readUngradedLines(label: string, linePattern: RegExp): (result: RunResult) => LintReading {
  return (result) => {
    const text = `${result.stdout}\n${result.stderr}`;
    const lines = capDetail([text]);
    if (result.code === 0) return { errors: 0, warnings: 0, detail: [], line: null };
    if (lines.length === 0) {
      return {
        unreadable: `${label} exited ${result.code ?? 'on a signal'} without saying anything`,
        errors: 0,
        warnings: 0,
        detail: [],
        line: null,
      };
    }
    return { errors: 0, warnings: lines.length, detail: lines, line: lineFrom(text, linePattern) };
  };
}

const LINTERS: Partial<Record<GateLanguage, readonly Linter[]>> = {
  typescript: [eslintLinter()],
  javascript: [eslintLinter()],
  python: [
    {
      label: 'ruff check',
      bins: ['ruff'],
      mode: 'stdin',
      args: ({ realPath }) => ['check', '--no-cache', '--stdin-filename', realPath, '-'],
      evidence: 'configured',
      configured: (f) => configuresPythonTool(f, 'ruff'),
      read: readUngradedLines('ruff', /:(\d+):\d+:/),
    },
    {
      label: 'flake8',
      bins: ['flake8'],
      mode: 'scratch',
      args: ({ target }) => [target],
      evidence: 'configured',
      configured: (f) => configuresPythonTool(f, 'flake8'),
      read: readUngradedLines('flake8', /:(\d+):\d+:/),
    },
    {
      label: 'pylint',
      bins: ['pylint'],
      mode: 'scratch',
      args: ({ target }) => ['--score=n', target],
      evidence: 'configured',
      configured: (f) => configuresPythonTool(f, 'pylint'),
      read: readPylintBitmask,
    },
  ],
  ruby: [
    {
      label: 'rubocop',
      bins: ['rubocop'],
      mode: 'scratch',
      args: ({ target }) => ['--format', 'json', target],
      evidence: 'configured',
      configured: (f) => f.rootFiles.has('.rubocop.yml') || f.gemfileText.includes('rubocop'),
      read: readRubocopJson,
    },
  ],
  php: [
    {
      label: 'phpcs',
      bins: ['phpcs'],
      mode: 'scratch',
      args: ({ target }) => ['--report=json', target],
      evidence: 'repo-local',
      read: readPhpcsJson,
    },
  ],
  /*
   * Go has no entry. `go vet` analyses a PACKAGE — it will not accept one file
   * outside a module context — and golangci-lint is a whole-project run
   * measured in tens of seconds. Both fail the "cheap, and about this file"
   * test, so LINT reports UNAVAILABLE for Go and says which tool it would have
   * needed. Honest beats present.
   */
};

function eslintLinter(): Linter {
  return {
    label: 'eslint',
    bins: ['eslint'],
    mode: 'stdin',
    /*
     * `--stdin-filename` is the real path, so a flat config's `files` blocks
     * and an eslintrc `overrides` both match the location the file will live
     * at. cwd is the repo root, which is where eslint looks for its config.
     * `--no-color` is redundant with the environment but costs nothing.
     */
    args: ({ realPath }) => [
      '--stdin',
      '--stdin-filename',
      realPath,
      '--format',
      'json',
      '--no-color',
    ],
    evidence: 'repo-local',
    read: readEslintJson,
  };
}

/** pylint's exit code is a bitmask: 1 fatal, 2 error, 4 warning, 8 refactor, 16 convention. */
function readPylintBitmask(result: RunResult): LintReading {
  const text = `${result.stdout}\n${result.stderr}`;
  const detail = capDetail([text]);
  const code = result.code;
  if (code === null) {
    return {
      unreadable: 'pylint was killed before it reported',
      errors: 0,
      warnings: 0,
      detail,
      line: null,
    };
  }
  // Bit 32 is "usage error" — pylint itself failed, so nothing was checked.
  if ((code & 32) !== 0) {
    return {
      unreadable: firstMeaningfulLine(text) ?? 'pylint reported a usage error',
      errors: 0,
      warnings: 0,
      detail,
      line: null,
    };
  }
  const fatalOrError = (code & 3) !== 0;
  const softer = (code & 28) !== 0;
  if (!fatalOrError && !softer) return { errors: 0, warnings: 0, detail: [], line: null };
  return {
    errors: fatalOrError ? Math.max(1, detail.length) : 0,
    warnings: fatalOrError ? 0 : Math.max(1, detail.length),
    detail,
    line: lineFrom(text, /:(\d+):\d+:/),
  };
}

function readRubocopJson(result: RunResult): LintReading {
  if (!result.stdout.trim()) {
    return {
      unreadable:
        firstMeaningfulLine(result.stderr) ??
        `rubocop exited ${result.code ?? 'on a signal'} with no report`,
      errors: 0,
      warnings: 0,
      detail: capDetail([result.stderr]),
      line: null,
    };
  }
  let parsed: {
    files?: {
      offenses?: {
        severity?: string;
        message?: string;
        cop_name?: string;
        location?: { line?: number };
      }[];
    }[];
  };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch {
    return {
      unreadable: 'rubocop printed output that is not JSON',
      errors: 0,
      warnings: 0,
      detail: capDetail([result.stdout.slice(0, 2_000)]),
      line: null,
    };
  }
  const detail: string[] = [];
  let errors = 0;
  let warnings = 0;
  let line: number | null = null;
  for (const file of parsed.files ?? []) {
    for (const o of file.offenses ?? []) {
      const severe = o.severity === 'error' || o.severity === 'fatal';
      if (severe) errors++;
      else warnings++;
      const at = o.location?.line;
      if (line === null && at !== undefined) line = at;
      detail.push(
        `${at === undefined ? '' : `line ${at}: `}${o.severity ?? 'offense'}: ${o.message ?? ''}${o.cop_name ? ` (${o.cop_name})` : ''}`,
      );
    }
  }
  return { errors, warnings, detail: capDetail(detail), line };
}

function readPhpcsJson(result: RunResult): LintReading {
  if (!result.stdout.trim()) {
    return {
      unreadable:
        firstMeaningfulLine(result.stderr) ??
        `phpcs exited ${result.code ?? 'on a signal'} with no report`,
      errors: 0,
      warnings: 0,
      detail: capDetail([result.stderr]),
      line: null,
    };
  }
  let parsed: {
    files?: Record<
      string,
      { messages?: { type?: string; message?: string; line?: number; source?: string }[] }
    >;
  };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch {
    return {
      unreadable: 'phpcs printed output that is not JSON',
      errors: 0,
      warnings: 0,
      detail: capDetail([result.stdout.slice(0, 2_000)]),
      line: null,
    };
  }
  const detail: string[] = [];
  let errors = 0;
  let warnings = 0;
  let line: number | null = null;
  for (const file of Object.values(parsed.files ?? {})) {
    for (const m of file.messages ?? []) {
      if (m.type === 'ERROR') errors++;
      else warnings++;
      if (line === null && m.line !== undefined) line = m.line;
      detail.push(
        `${m.line === undefined ? '' : `line ${m.line}: `}${(m.type ?? 'notice').toLowerCase()}: ${m.message ?? ''}${m.source ? ` (${m.source})` : ''}`,
      );
    }
  }
  return { errors, warnings, detail: capDetail(detail), line };
}

function firstMeaningfulLine(text: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line) return line.slice(0, MAX_DETAIL_LINE_CHARS);
  }
  return null;
}

/**
 * A scratch-file run that may not have happened. `run: null` means the scratch
 * file itself could not be created, and `message` says why — which is an
 * UNAVAILABLE, never a pass.
 */
interface ScratchRun {
  run: RunResult | null;
  scratch: string;
  message?: string;
}

// ─── Picking a tool for this repository ──────────────────────────────────────

interface Choice<T> {
  tool: T;
  resolved: ResolvedTool;
}

/**
 * The first candidate this repository both has and has chosen.
 *
 * `rejections` is returned rather than discarded: when nothing is usable, the
 * UNAVAILABLE message has to say WHY — "black is installed but this repo
 * configures ruff" is actionable, "no formatter" is not.
 */
function chooseTool<
  T extends {
    label: string;
    bins: readonly string[];
    evidence: string;
    configured?: (f: RepoFacts) => boolean;
  },
>(
  candidates: readonly T[],
  facts: RepoFacts,
  nodeTool: boolean,
): { choice: Choice<T> | null; rejections: string[] } {
  const rejections: string[] = [];

  for (const tool of candidates) {
    const resolved = resolveTool(facts.repoRoot, tool.bins, nodeTool);

    if (!resolved) {
      rejections.push(
        `${tool.label} is not installed in this repository or on PATH${describeRepoSignals(facts, tool.label)}`,
      );
      continue;
    }

    if (tool.evidence === 'repo-local' && !resolved.repoLocal) {
      rejections.push(
        `${tool.label} was found at ${resolved.bin} but not inside the checkout, so it is this worker's tool and not the repository's`,
      );
      continue;
    }

    if (
      tool.evidence === 'configured' &&
      !resolved.repoLocal &&
      !(tool.configured?.(facts) ?? false)
    ) {
      rejections.push(
        `${tool.label} is installed on PATH but nothing in this repository configures it, so using it would impose a style the project did not choose`,
      );
      continue;
    }

    return { choice: { tool, resolved }, rejections };
  }

  return { choice: null, rejections };
}

function resolveTool(
  repoRoot: string,
  bins: readonly string[],
  nodeTool: boolean,
): ResolvedTool | null {
  for (const bin of bins) {
    const local = nodeTool ? resolveNodeBin(repoRoot, bin) : resolveVendorBin(repoRoot, bin);
    if (local) return local;
  }
  // Node tools are NEVER taken from PATH: a globally installed prettier is not
  // the repo's prettier, and `npx` would fetch one from the registry. For the
  // rest, PATH is where an interpreter or a system formatter legitimately lives.
  if (nodeTool) return null;
  for (const bin of bins) {
    const onPath = resolvePathBin(bin);
    if (onPath) return onPath;
  }
  return null;
}

// ─── The factory ─────────────────────────────────────────────────────────────

/**
 * Build the gates for one repository checkout.
 *
 * Synchronous and cheap: repository discovery is deferred to the first gate
 * call and then cached for the life of this object, so constructing it costs
 * nothing and a generation that checks four gates reads the manifests once.
 *
 * Nothing returned here writes to `repoRoot`. Children run with it as cwd —
 * which is what lets a tool find its own config — and the candidate itself is
 * either overlaid in memory (TypeScript), piped over stdin (prettier, eslint,
 * black, ruff, gofmt), or written into a temp directory we create and remove
 * (every in-place tool). The customer's file on disk is never the one that gets
 * checked or rewritten.
 */
export function toolchainFor(options: ToolchainOptions): ToolchainGates {
  const repoRoot = resolve(options.repoRoot);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let factsPromise: Promise<RepoFacts> | null = null;
  const facts = (): Promise<RepoFacts> => {
    factsPromise ??= discoverRepo(repoRoot);
    return factsPromise;
  };

  /** The path the file will really have, used for config and module resolution. */
  const targetPath = (filePath: string): string =>
    isAbsolute(filePath) ? filePath : join(repoRoot, filePath);

  return {
    async syntax({ code, filePath }) {
      const language = languageOf(filePath);

      if (language === 'typescript' || language === 'javascript') {
        return syntaxTypeScript(code, filePath);
      }

      const parser = SPAWNED_PARSERS[language];
      if (!parser) {
        const reason = NO_CHEAP_PARSER[language] ?? 'no parser is known for this file type';
        return outcome('SYNTAX', 'UNAVAILABLE', `not parsed: ${reason}`);
      }

      const resolved = resolveTool(repoRoot, parser.bins, false);
      if (!resolved) {
        return outcome(
          'SYNTAX',
          'UNAVAILABLE',
          `not parsed: none of ${parser.bins.join(', ')} is installed on this worker, so the file was stored without a parse`,
        );
      }

      const real = targetPath(filePath);
      return withScratchFile(
        code,
        filePath,
        async (scratch) => {
          const result = await runTool(resolved.bin, parser.args(scratch), {
            cwd: repoRoot,
            timeoutMs,
          });

          if (result.spawnError) return unavailableFromSpawn('SYNTAX', resolved, result);
          if (result.timedOut) return unavailableFromTimeout('SYNTAX', resolved.how, timeoutMs);

          const why = `parsed with ${resolved.how}`;
          if (result.code === 0) return outcome('SYNTAX', 'PASS', why);

          const raw =
            parser.stream === 'stderr'
              ? result.stderr
              : parser.stream === 'stdout'
                ? result.stdout
                : `${result.stderr}\n${result.stdout}`;
          const text = scrubPaths(raw, scratch, real);

          return outcome(
            'SYNTAX',
            'FAIL',
            `${why} — it exited ${result.code} and reported a syntax error`,
            [text],
            lineFrom(text, parser.linePattern),
          );
        },
        (message) =>
          outcome(
            'SYNTAX',
            'UNAVAILABLE',
            `not parsed: a scratch file could not be created (${message}), so nothing was checked`,
          ),
      );
    },

    async typecheck({ code, filePath }) {
      const language = languageOf(filePath);
      const real = targetPath(filePath);

      if (language === 'typescript' || language === 'javascript') {
        return typecheckTypeScript(code, real, repoRoot, timeoutMs);
      }

      if (language === 'python') {
        const repo = await facts();
        /*
         * mypy and pyright only when the REPO already configures one. Running a
         * type checker a project has not adopted on a project that has not
         * annotated its types produces hundreds of findings about the
         * customer's own code, attributed to our generated file. That is worse
         * than not checking.
         */
        const candidates: readonly Linter[] = [
          {
            label: 'mypy',
            bins: ['mypy'],
            mode: 'scratch',
            /*
             * `--follow-imports=skip` keeps this a SINGLE-FILE check, which is
             * the only version cheap enough for a generation gate. The cost is
             * stated plainly: every symbol imported from the project becomes
             * Any, so a wrong argument type to one of the repo's own helpers is
             * NOT caught here. What is caught is the file's internal
             * consistency and its use of annotated stdlib and third-party APIs.
             */
            args: ({ target }) => [
              '--no-error-summary',
              '--no-color-output',
              '--follow-imports=skip',
              '--hide-error-context',
              target,
            ],
            evidence: 'configured',
            configured: (f) => configuresPythonTool(f, 'mypy'),
            read: readUngradedLines('mypy', /:(\d+):/),
          },
          {
            label: 'pyright',
            bins: ['pyright'],
            mode: 'scratch',
            args: ({ target }) => ['--outputjson', target],
            evidence: 'configured',
            configured: (f) => configuresPythonTool(f, 'pyright'),
            read: readUngradedLines('pyright', /:(\d+):\d+/),
          },
        ];

        const { choice, rejections } = chooseTool(candidates, repo, false);
        if (!choice) {
          return outcome(
            'TYPECHECK',
            'UNAVAILABLE',
            `not typechecked: ${
              rejections.length > 0
                ? rejections.join('; ')
                : 'this repository configures neither mypy nor pyright'
            }. Running a type checker a project has not adopted reports ITS code as our file's errors, which is worse than not checking.`,
            rejections,
          );
        }

        const result = await withScratchFile<ScratchRun>(
          code,
          filePath,
          async (scratch) => {
            const run = await runTool(
              choice.resolved.bin,
              choice.tool.args({ realPath: real, target: scratch }),
              { cwd: repoRoot, timeoutMs },
            );
            return { run, scratch };
          },
          (message) => ({ run: null, scratch: '', message }),
        );

        if (!result.run) {
          return outcome(
            'TYPECHECK',
            'UNAVAILABLE',
            `not typechecked: a scratch file could not be created (${result.message}), so nothing was checked`,
          );
        }
        if (result.run.spawnError) {
          return unavailableFromSpawn('TYPECHECK', choice.resolved, result.run);
        }
        if (result.run.timedOut) {
          return unavailableFromTimeout('TYPECHECK', choice.resolved.how, timeoutMs);
        }

        const reading = choice.tool.read(result.run);
        const why = `typechecked with ${choice.resolved.how}, single file only (imports from the project are not followed, so cross-module type errors are NOT caught)`;
        if (reading.unreadable) {
          return outcome(
            'TYPECHECK',
            'UNAVAILABLE',
            `${why} — but ${reading.unreadable}`,
            reading.detail,
          );
        }
        const found = reading.errors + reading.warnings;
        if (found === 0) return outcome('TYPECHECK', 'PASS', why);
        return outcome(
          'TYPECHECK',
          'FAIL',
          `${why} — ${found} type error${found === 1 ? '' : 's'}`,
          reading.detail.map((d) => scrubPaths(d, result.scratch, real)),
          reading.line,
        );
      }

      return outcome(
        'TYPECHECK',
        'UNAVAILABLE',
        `not typechecked: no single-file type check exists for ${language === 'other' ? 'this file type' : language} that is cheap enough for a generation gate`,
      );
    },

    async format({ code, filePath }) {
      const language = languageOf(filePath);
      const real = targetPath(filePath);
      const ext = extname(filePath).toLowerCase();
      const repo = await facts();

      // prettier covers far more than TS/JS, and a generated fixture or page
      // object is read by the same reviewer. Anything prettier can infer a
      // parser for gets offered to it.
      const usePrettier =
        language === 'typescript' || language === 'javascript' || PRETTIER_EXTENSIONS.has(ext);
      const candidates = usePrettier
        ? (FORMATTERS[language] ?? FORMATTERS.other ?? [])
        : (FORMATTERS[language] ?? []);

      if (candidates.length === 0) {
        return outcome(
          'FORMAT',
          'UNAVAILABLE',
          language === 'csharp'
            ? 'not formatted: `dotnet format` operates on a project, not a file — it restores and loads the MSBuild graph, which no generation gate can afford'
            : `not formatted: no single-file formatter is known for ${language === 'other' ? `\`${ext || 'this file type'}\`` : language}`,
        );
      }

      const isNodeTool = candidates.every((c) => c.bins.includes('prettier'));
      const { choice, rejections } = chooseTool(candidates, repo, isNodeTool);

      if (!choice) {
        /*
         * The REASON goes in `why`, not only in `detail`. "no formatter" is not
         * actionable; "prettier is declared in package.json but not installed"
         * tells whoever reads the admission record what to do, and it is the
         * difference between a gate people trust and a gate people route
         * around.
         */
        const reasons =
          rejections.length > 0
            ? rejections.join('; ')
            : `${candidates.map((c) => c.label).join(' / ')} could not be resolved`;
        return outcome(
          'FORMAT',
          'UNAVAILABLE',
          `not formatted: ${reasons}. The file is stored exactly as generated.`,
          rejections,
        );
      }

      const { tool, resolved } = choice;

      const finish = (
        run: RunResult,
        formatted: string | null,
      ): GateOutcome & { code?: string } => {
        if (run.spawnError) return unavailableFromSpawn('FORMAT', resolved, run);
        if (run.timedOut) return unavailableFromTimeout('FORMAT', resolved.how, timeoutMs);

        if (run.code !== 0 || formatted === null) {
          /*
           * A formatter that exits non-zero on one file almost always means it
           * could not parse it — which SYNTAX owns and reports properly. What
           * matters here is that we return NO `code`: handing the caller a
           * half-formatted or empty buffer would store a worse file than the
           * one we were given.
           */
          return outcome(
            'FORMAT',
            'UNAVAILABLE',
            `${resolved.how} exited ${run.code ?? 'on a signal'} without producing a formatted file, so the file is stored exactly as generated`,
            [scrubPaths(`${run.stderr}\n${run.stdout}`, real, real)],
          );
        }

        const changed = formatted !== code;
        const summary = changed ? describeReformat(code, formatted) : 'it was already formatted';
        return {
          ...outcome('FORMAT', 'PASS', `formatted with ${resolved.how} — ${summary}`, [summary]),
          code: formatted,
        };
      };

      if (tool.mode === 'stdin') {
        const run = await runTool(resolved.bin, tool.args({ realPath: real, target: real }), {
          cwd: repoRoot,
          stdin: code,
          timeoutMs,
        });
        // An empty stdout with a zero exit is not "the file is now empty" — it
        // is a tool that did not do what we think it did. Treated as no output.
        return finish(run, run.code === 0 && run.stdout.length > 0 ? run.stdout : null);
      }

      return withScratchFile(
        code,
        filePath,
        async (scratch) => {
          const run = await runTool(resolved.bin, tool.args({ realPath: real, target: scratch }), {
            cwd: repoRoot,
            timeoutMs,
          });
          let formatted: string | null = null;
          try {
            formatted = await readFile(scratch, 'utf8');
          } catch {
            formatted = null;
          }
          return finish(run, formatted);
        },
        (message) =>
          outcome(
            'FORMAT',
            'UNAVAILABLE',
            `not formatted: a scratch file could not be created (${message}), so the file is stored exactly as generated`,
          ),
      );
    },

    async lint({ code, filePath }) {
      const language = languageOf(filePath);
      const real = targetPath(filePath);
      const repo = await facts();

      const candidates = LINTERS[language] ?? [];
      if (candidates.length === 0) {
        return outcome(
          'LINT',
          'UNAVAILABLE',
          language === 'go'
            ? 'not linted: `go vet` analyses a package rather than a file, and golangci-lint is a whole-project run — neither fits a per-file generation gate'
            : `not linted: no single-file linter is known for ${language === 'other' ? 'this file type' : language}`,
        );
      }

      const isNodeTool = candidates.every((c) => c.bins.includes('eslint'));
      const { choice, rejections } = chooseTool(candidates, repo, isNodeTool);

      if (!choice) {
        const reasons =
          rejections.length > 0
            ? rejections.join('; ')
            : `${candidates.map((c) => c.label).join(' / ')} could not be resolved`;
        return outcome(
          'LINT',
          'UNAVAILABLE',
          `not linted: ${reasons}. Nothing was checked.`,
          rejections,
        );
      }

      const { tool, resolved } = choice;
      const why = `linted with ${resolved.how}, this file only`;

      const judge = (run: RunResult, scratch: string): GateOutcome => {
        if (run.spawnError) return unavailableFromSpawn('LINT', resolved, run);
        if (run.timedOut) return unavailableFromTimeout('LINT', resolved.how, timeoutMs);

        const reading = tool.read(run);
        if (reading.unreadable) {
          return outcome(
            'LINT',
            'UNAVAILABLE',
            `${resolved.how} could not lint this file (${reading.unreadable}), so nothing was checked`,
            reading.detail.map((d) => scrubPaths(d, scratch, real)),
            null,
          );
        }

        const detail = reading.detail.map((d) => scrubPaths(d, scratch, real));
        if (reading.errors === 0 && reading.warnings === 0) {
          return outcome('LINT', 'PASS', why, [], null);
        }

        // See the Linter doc comment: the linter's own grading decides. An
        // error is FAIL because the project chose to call it one and their CI
        // will too; everything else is a WARN a human can accept.
        const status: GateStatus = reading.errors > 0 ? 'FAIL' : 'WARN';
        const counts = [
          reading.errors > 0 ? `${reading.errors} error${reading.errors === 1 ? '' : 's'}` : null,
          reading.warnings > 0
            ? `${reading.warnings} warning${reading.warnings === 1 ? '' : 's'}`
            : null,
        ]
          .filter((s): s is string => s !== null)
          .join(' and ');

        return outcome('LINT', status, `${why} — ${counts}`, detail, reading.line);
      };

      if (tool.mode === 'stdin') {
        const run = await runTool(resolved.bin, tool.args({ realPath: real, target: real }), {
          cwd: repoRoot,
          stdin: code,
          timeoutMs,
        });
        return judge(run, real);
      }

      return withScratchFile(
        code,
        filePath,
        async (scratch) => {
          const run = await runTool(resolved.bin, tool.args({ realPath: real, target: scratch }), {
            cwd: repoRoot,
            timeoutMs,
          });
          return judge(run, scratch);
        },
        (message) =>
          outcome(
            'LINT',
            'UNAVAILABLE',
            `not linted: a scratch file could not be created (${message}), so nothing was checked`,
          ),
      );
    },
  };
}

/**
 * "it rewrote 3 of 42 lines" rather than "changed".
 *
 * The number is the point. A formatter that rewrote two lines produced a file a
 * reviewer will accept; one that rewrote forty means the generator's style and
 * the repository's style disagree systematically, which is a prompt problem
 * worth seeing in the record rather than silently absorbing on every file.
 */
function describeReformat(before: string, after: string): string {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  const total = after.split('\n').length;
  return `it rewrote ${Math.max(added, removed)} of ${total} lines (+${added}/-${removed})`;
}
