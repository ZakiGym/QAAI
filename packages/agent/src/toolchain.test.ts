/**
 * Toolchain-gate tests.
 *
 * The failure this suite is built around is not "a gate said FAIL when it
 * should have said PASS". It is "a gate said PASS when it never ran".
 *
 * That lie is invisible by construction: a PASS from an uninstalled linter
 * looks exactly like a PASS from a clean file, travels into the admission
 * record, and becomes the evidence that the generated test was reviewed. So the
 * weight here is on the UNAVAILABLE cases — the bare repository, the declared
 * but not installed package, the timeout, the tool that crashed — and every one
 * of them asserts BOTH that the status is UNAVAILABLE and that it is not PASS.
 * The second assertion is not redundant: it is the one that would survive
 * somebody adding a fifth status.
 *
 * The other weighted case is the child environment. The worker running these
 * gates holds VAULT_MASTER_KEY; the binaries they spawn come out of the
 * customer's node_modules. There are two tests for it, on purpose: one asserts
 * the policy object, and one spawns a real stub binary through the real
 * resolution-and-spawn path and reads back the environment the OS actually gave
 * it. The first can pass while the code path quietly bypasses it; the second
 * cannot.
 *
 * Tools that genuinely are not on this machine are SKIPPED, with the reason in
 * the test name, never quietly asserted away. A skipped test is visible in the
 * runner's output; a test that asserts UNAVAILABLE because the tool is missing
 * and calls that a pass is how a suite goes green on a machine where nothing
 * works.
 */

import type { GateOutcome } from './admission.js';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gateChildEnv,
  isForbiddenGateEnvKey,
  toolchainFor,
} from './toolchain.js';

// ─── Where we are ────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/agent/src → the monorepo root. */
const MONOREPO = resolve(HERE, '..', '..', '..');

/** The monorepo's own binaries, used to give a fixture repo real tooling. */
const MONOREPO_BIN = join(MONOREPO, 'node_modules', '.bin');
const HAS_PRETTIER = existsSync(join(MONOREPO_BIN, 'prettier'));
const HAS_ESLINT = existsSync(join(MONOREPO_BIN, 'eslint'));

function onPath(bin: string): boolean {
  const raw = process.env.PATH ?? '';
  return raw.split(delimiter).some((dir) => dir.length > 0 && existsSync(join(dir, bin)));
}

const HAS_PYTHON3 = onPath('python3') && spawnSync('python3', ['--version']).status === 0;
const HAS_RUBY = onPath('ruby') && spawnSync('ruby', ['--version']).status === 0;

// ─── Fixtures ────────────────────────────────────────────────────────────────

let sandbox = '';
/** A TS repo with real, project-local prettier + eslint + tsconfig. */
let tsRepo = '';
/** A repo that DECLARES prettier in devDependencies but has no node_modules. */
let declaredOnlyRepo = '';
/** A Python repo that configures black (which is not installed here). */
let pyRepo = '';
/** Nothing at all, nested deep enough that the upward bin walk stays inside it. */
let bareRepo = '';
/** A repo whose "prettier" is a stub that records the environment it received. */
let stubRepo = '';
let stubEnvDump = '';
/** A repo whose "prettier" never returns. */
let slowRepo = '';

/**
 * The fixture's prettier settings are the OPPOSITE of this monorepo's on every
 * axis that shows up in one line of code: double quotes, no semicolons,
 * four-space indent. If FORMAT returns single-quoted, semicolon-terminated
 * output, it used OUR style instead of the customer's — which is the defect the
 * gate exists to prevent, and this is how the test can tell.
 */
const FIXTURE_PRETTIER = { singleQuote: false, semi: false, tabWidth: 4, printWidth: 80 };

/**
 * espree, ESLint's default parser, cannot read TypeScript type annotations, and
 * this fixture does not install typescript-eslint. So the lint fixtures below
 * are written in annotation-free source. The type-aware case is covered
 * separately, against this monorepo, where a real type-aware config exists.
 */
const FIXTURE_ESLINT_CONFIG = `module.exports = [
  {
    files: ['**/*.ts', '**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      'no-unused-vars': 'error',
      'no-console': 'warn',
      'no-undef': 'off',
    },
  },
];
`;

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** A tiny executable shell script. Used for the stubs; never for real tooling. */
async function writeExecutable(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, 'utf8');
  await chmod(path, 0o755);
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'qaai-toolchain-'));

  // ── A TypeScript repo with its own tooling ────────────────────────────────
  tsRepo = join(sandbox, 'ts-repo');
  await mkdir(join(tsRepo, 'src'), { recursive: true });
  await writeJson(join(tsRepo, 'package.json'), {
    name: 'fixture-ts',
    private: true,
    devDependencies: { prettier: '^3.0.0', eslint: '^10.0.0', typescript: '^6.0.0' },
    scripts: { lint: 'eslint .', format: 'prettier --write .' },
  });
  await writeJson(join(tsRepo, '.prettierrc.json'), FIXTURE_PRETTIER);
  await writeFile(join(tsRepo, 'eslint.config.js'), FIXTURE_ESLINT_CONFIG, 'utf8');
  await writeJson(join(tsRepo, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
  });
  // Project-local binaries, symlinked to the ones this monorepo installed. A
  // symlink into node_modules/.bin is exactly what npm itself creates, so the
  // resolver is being exercised, not fooled.
  await mkdir(join(tsRepo, 'node_modules', '.bin'), { recursive: true });
  if (HAS_PRETTIER) {
    await symlink(join(MONOREPO_BIN, 'prettier'), join(tsRepo, 'node_modules', '.bin', 'prettier'));
  }
  if (HAS_ESLINT) {
    await symlink(join(MONOREPO_BIN, 'eslint'), join(tsRepo, 'node_modules', '.bin', 'eslint'));
  }

  // ── Declared, not installed ───────────────────────────────────────────────
  declaredOnlyRepo = join(sandbox, 'declared-only');
  await mkdir(join(declaredOnlyRepo, 'src'), { recursive: true });
  await writeJson(join(declaredOnlyRepo, 'package.json'), {
    name: 'fixture-declared',
    private: true,
    devDependencies: { prettier: '^3.0.0', eslint: '^10.0.0' },
  });
  await writeJson(join(declaredOnlyRepo, '.prettierrc.json'), FIXTURE_PRETTIER);
  await writeFile(join(declaredOnlyRepo, 'eslint.config.js'), FIXTURE_ESLINT_CONFIG, 'utf8');

  // ── A Python repo ─────────────────────────────────────────────────────────
  pyRepo = join(sandbox, 'py-repo');
  await mkdir(join(pyRepo, 'tests'), { recursive: true });
  await writeFile(
    join(pyRepo, 'pyproject.toml'),
    '[project]\nname = "fixture"\nversion = "0.1.0"\n\n[tool.black]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n',
    'utf8',
  );

  // ── Nothing at all ────────────────────────────────────────────────────────
  // Nested five deep so the resolver's bounded upward walk for node_modules
  // ends inside this sandbox and cannot reach a stray install in TMPDIR.
  bareRepo = join(sandbox, 'a', 'b', 'c', 'd', 'bare');
  await mkdir(bareRepo, { recursive: true });
  await writeFile(join(bareRepo, 'README'), 'no tooling here\n', 'utf8');

  // ── The environment-recording stub ────────────────────────────────────────
  stubRepo = join(sandbox, 'stub-repo');
  stubEnvDump = join(sandbox, 'child-env.dump');
  await mkdir(join(stubRepo, 'src'), { recursive: true });
  await writeJson(join(stubRepo, 'package.json'), { name: 'fixture-stub', private: true });
  /*
   * Behaves like `prettier --stdin-filepath`: writes the formatted source to
   * stdout (here, unchanged) and exits 0. On the way through it records its own
   * environment.
   *
   * The dump path is BAKED IN rather than passed as an environment variable.
   * packages/runner/src/child-env.ts keeps a `QAAI_STUB_` prefix on its
   * allowlist for the same job, gated on NODE_ENV — a standing hole, however
   * small. Baking the path in means this stub needs no hole at all, which is
   * also what makes the assertion below meaningful: the child is given nothing
   * by this test.
   */
  await writeExecutable(
    join(stubRepo, 'node_modules', '.bin', 'prettier'),
    `#!/bin/sh\n/usr/bin/env > '${stubEnvDump}'\nexec /bin/cat\n`,
  );

  // ── The stub that never finishes ──────────────────────────────────────────
  slowRepo = join(sandbox, 'slow-repo');
  await mkdir(join(slowRepo, 'src'), { recursive: true });
  await writeJson(join(slowRepo, 'package.json'), { name: 'fixture-slow', private: true });
  // `exec` so the process we signal IS the sleep, not a shell holding it.
  await writeExecutable(
    join(slowRepo, 'node_modules', '.bin', 'prettier'),
    '#!/bin/sh\nexec sleep 30\n',
  );
});

afterAll(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true }).catch(() => {});
});

// ─── Shared expectations ─────────────────────────────────────────────────────

/**
 * The assertion this whole file is for. Stated as a helper so that every
 * "we could not check" site makes the same two claims, and so that `never PASS`
 * is asserted explicitly rather than implied by asserting UNAVAILABLE.
 */
function expectCouldNotCheck(o: GateOutcome, mentioning?: RegExp): void {
  expect(o.status).toBe('UNAVAILABLE');
  expect(o.status).not.toBe('PASS');
  // `why` is the audit trail. An UNAVAILABLE without a reason is unactionable.
  expect(o.why.length).toBeGreaterThan(10);
  if (mentioning) expect(o.why).toMatch(mentioning);
}

// ─── SYNTAX ──────────────────────────────────────────────────────────────────

describe('SYNTAX', () => {
  const gates = () => toolchainFor({ repoRoot: tsRepo });

  it('finds the missing brace, and names the line', async () => {
    /*
     * The literal defect from the register: a generated spec with an unbalanced
     * paren. Before this gate it was stored, pushed, queued, run, and reported
     * as "Playwright produced no report" — an infrastructure message for a
     * one-character mistake.
     */
    const code = [
      "import { test, expect } from '@playwright/test';",
      '',
      "test('checkout', async ({ page }) => {",
      "  await page.goto('/cart');",
      "  await expect(page.getByRole('heading')).toBeVisible();",
      ');', // ← should be `});`
      '',
    ].join('\n');

    const out = await gates().syntax({ code, filePath: 'src/checkout.spec.ts' });

    expect(out.gate).toBe('SYNTAX');
    expect(out.status).toBe('FAIL');
    expect(out.line).toBe(6);
    expect(out.detail.join('\n')).toMatch(/TS\d+/);
    // The tool and how it was resolved, every time.
    expect(out.why).toMatch(/typescript/i);
  });

  it('passes a well-formed spec', async () => {
    const code = [
      "import { test, expect } from '@playwright/test';",
      '',
      "test('checkout', async ({ page }) => {",
      "  await page.goto('/cart');",
      "  await expect(page.getByRole('heading')).toBeVisible();",
      '});',
      '',
    ].join('\n');

    const out = await gates().syntax({ code, filePath: 'src/checkout.spec.ts' });

    expect(out.status).toBe('PASS');
    expect(out.detail).toEqual([]);
    expect(out.line).toBeNull();
  });

  it('parses .tsx without calling JSX a syntax error', async () => {
    const out = await gates().syntax({
      code: 'export const Hi = () => <div className="x">hi</div>;\n',
      filePath: 'src/Hi.tsx',
    });
    expect(out.status).toBe('PASS');
  });

  it('needs no repository tooling at all: the parser ships with us', async () => {
    /*
     * SYNTAX is the one gate that works in a repository with nothing installed,
     * because the parser is the `typescript` package in OUR dependency tree,
     * not the customer's. Worth asserting rather than assuming: it is the
     * reason the bare-repo test below treats TypeScript separately.
     */
    const out = await toolchainFor({ repoRoot: bareRepo }).syntax({
      code: 'export const x = 1;\n',
      filePath: 'anything.ts',
    });
    expect(out.status).toBe('PASS');
  });

  it.skipIf(!HAS_PYTHON3)('finds a Python syntax error with its line (python3)', async () => {
    const out = await toolchainFor({ repoRoot: pyRepo }).syntax({
      code: 'def test_login():\n    assert True\n     assert False\n',
      filePath: 'tests/test_login.py',
    });

    expect(out.status).toBe('FAIL');
    expect(out.line).toBe(3);
    expect(out.why).toMatch(/python3/);
    // The scratch path must not leak into something a human reads.
    expect(out.detail.join('\n')).not.toMatch(/qaai-gate-/);
  });

  it.skipIf(!HAS_PYTHON3)('passes well-formed Python (python3)', async () => {
    const out = await toolchainFor({ repoRoot: pyRepo }).syntax({
      code: 'def test_login():\n    assert True\n',
      filePath: 'tests/test_login.py',
    });
    expect(out.status).toBe('PASS');
  });

  it.skipIf(HAS_PYTHON3)('skipped: python3 is not installed on this machine', () => {
    expect(HAS_PYTHON3).toBe(false);
  });

  it.skipIf(!HAS_RUBY)('finds a Ruby syntax error with its line (ruby -c)', async () => {
    const out = await toolchainFor({ repoRoot: bareRepo }).syntax({
      code: 'def login\n  puts "hi"\n',
      filePath: 'login_spec.rb',
    });
    expect(out.status).toBe('FAIL');
    expect(out.line).toBeGreaterThan(0);
    expect(out.why).toMatch(/ruby/);
  });

  it.skipIf(HAS_RUBY)('skipped: ruby is not installed on this machine', () => {
    expect(HAS_RUBY).toBe(false);
  });

  it('says it did not check, rather than guessing, for a language it cannot parse', async () => {
    const out = await toolchainFor({ repoRoot: bareRepo }).syntax({
      code: 'public class Thing { }\n',
      filePath: 'Thing.java',
    });
    expectCouldNotCheck(out, /classpath/);
  });
});

// ─── TYPECHECK ───────────────────────────────────────────────────────────────

describe('TYPECHECK', () => {
  it("uses the repository's tsconfig and catches a type error on its line", async () => {
    const out = await toolchainFor({ repoRoot: tsRepo }).typecheck({
      code: 'export const port: string = 3000;\n',
      filePath: 'src/config.ts',
    });

    expect(out.status).toBe('FAIL');
    expect(out.line).toBe(1);
    expect(out.detail.join('\n')).toMatch(/TS2322/);
    expect(out.why).toMatch(/tsconfig\.json/);
    // The limitation must be stated where the result is read, not only in a
    // doc comment nobody opens.
    expect(out.why).toMatch(/one file only/);
  });

  it('passes a file that is consistent with what it imports', async () => {
    const out = await toolchainFor({ repoRoot: tsRepo }).typecheck({
      code: 'export const port: number = 3000;\nexport const name = `port ${port}`;\n',
      filePath: 'src/config.ts',
    });
    expect(out.status).toBe('PASS');
  });

  it("honours the repository's strictness rather than its own", async () => {
    /*
     * `noUncheckedIndexedAccess` is on in the fixture's tsconfig. If the gate
     * typechecked with its own defaults this would pass — and the customer's
     * own `tsc` would then fail on a file we certified.
     */
    const out = await toolchainFor({ repoRoot: tsRepo }).typecheck({
      code: 'export function first(xs: string[]): string {\n  return xs[0];\n}\n',
      filePath: 'src/first.ts',
    });
    expect(out.status).toBe('FAIL');
    expect(out.line).toBe(2);
  });

  it('resolves the real dependency types through the in-memory overlay', async () => {
    /*
     * Against this monorepo, where `diff` is a genuine dependency with its own
     * type declarations in node_modules.
     *
     * The assertion that matters is the NEGATIVE one. If the overlay sat
     * anywhere but the file's real path, module resolution would walk up from
     * the wrong directory, miss node_modules, and report TS2307 "Cannot find
     * module" — which is a FAIL, so a test that only checked the status would
     * be green while the gate rejected every spec that imports anything.
     */
    const out = await toolchainFor({ repoRoot: MONOREPO }).typecheck({
      code: "import { diffLines } from 'diff';\nexport const n: string = diffLines('a', 'b').length;\n",
      filePath: 'packages/agent/src/__gate_probe_overlay__.ts',
    });

    expect(out.status).toBe('FAIL');
    expect(out.line).toBe(2);
    // The real type came from node_modules: a number is not a string…
    expect(out.detail.join('\n')).toMatch(/TS2322/);
    // …and the import itself resolved.
    expect(out.detail.join('\n')).not.toMatch(/TS2307/);
    expect(out.detail.join('\n')).not.toMatch(/Cannot find module/);
  });

  it('returns a GateOutcome when the in-process typecheck runs out of time', async () => {
    /*
     * A synchronous typecheck cannot be killed from outside, so the deadline is
     * enforced from inside with a TypeScript CancellationToken. This asserts
     * the token is actually honoured — and that cancellation surfaces as
     * UNAVAILABLE rather than escaping as `OperationCanceledException`, which
     * is not an Error and would abort a generation in a way nothing upstream
     * knows how to report.
     */
    const out = await toolchainFor({ repoRoot: MONOREPO, timeoutMs: 1 }).typecheck({
      code: "import { diffLines } from 'diff';\nexport const n = diffLines('a', 'b').length;\n",
      filePath: 'packages/agent/src/__gate_probe_timeout__.ts',
    });

    expectCouldNotCheck(out, /did not finish within 1ms/);
  });

  it('never writes the candidate into the checkout', async () => {
    const target = join(tsRepo, 'src', 'never-written.ts');
    await toolchainFor({ repoRoot: tsRepo }).typecheck({
      code: 'export const x: number = 1;\n',
      filePath: 'src/never-written.ts',
    });
    // The whole point of the in-memory overlay: a generation that replaces a
    // file must not destroy the working version to find out whether the
    // replacement compiles.
    expect(existsSync(target)).toBe(false);
  });

  it('reports UNAVAILABLE when no tsconfig governs the path', async () => {
    const out = await toolchainFor({ repoRoot: bareRepo }).typecheck({
      code: 'export const x: number = 1;\n',
      filePath: 'src/x.ts',
    });
    expectCouldNotCheck(out, /tsconfig/);
  });

  it('declines to typecheck Python unless the repository adopted a checker', async () => {
    // The fixture pyproject.toml DOES configure mypy — but mypy is not
    // installed here, so the honest answer is still "we did not check".
    const out = await toolchainFor({ repoRoot: pyRepo }).typecheck({
      code: 'def f(x: int) -> str:\n    return x\n',
      filePath: 'tests/test_f.py',
    });
    expectCouldNotCheck(out);
  });

  it('declines to typecheck a language with no cheap single-file check', async () => {
    const out = await toolchainFor({ repoRoot: bareRepo }).typecheck({
      code: 'package main\n',
      filePath: 'main.go',
    });
    expectCouldNotCheck(out, /cheap enough/);
  });
});

// ─── FORMAT ──────────────────────────────────────────────────────────────────

describe('FORMAT', () => {
  it.skipIf(!HAS_PRETTIER)(
    "returns source rewritten in the repository's style, not ours",
    async () => {
      const out = await toolchainFor({ repoRoot: tsRepo }).format({
        code: "const greeting = 'hello';\nexport  default   greeting;\n",
        filePath: 'src/greeting.ts',
      });

      expect(out.status).toBe('PASS');
      expect(out.code).toBeDefined();

      /*
       * The fixture's .prettierrc.json asks for double quotes and no
       * semicolons — the opposite of this monorepo's own config on both counts.
       * So this assertion fails if the gate used a default, a guess, or our
       * style instead of the customer's, which is the single reason a generated
       * file arrives with a reformatting diff attached.
       */
      expect(out.code).toContain('"hello"');
      expect(out.code).not.toContain("'hello'");
      expect(out.code?.trimEnd().endsWith(';')).toBe(false);

      // And it must say what it did, with a number.
      expect(out.why).toMatch(/prettier/);
      expect(out.why).toMatch(/rewrote \d+ of \d+ lines/);
    },
  );

  it.skipIf(!HAS_PRETTIER)('still PASSes when there was nothing to change', async () => {
    const already = 'const greeting = "hello"\n\nexport default greeting\n';
    const out = await toolchainFor({ repoRoot: tsRepo }).format({
      code: already,
      filePath: 'src/greeting.ts',
    });

    expect(out.status).toBe('PASS');
    expect(out.code).toBe(already);
    // "ran and changed nothing" must be distinguishable from "ran and rewrote
    // the file", because the second is a signal about the generator.
    expect(out.why).toMatch(/already formatted/);
  });

  it.skipIf(HAS_PRETTIER)('skipped: prettier is not installed in this monorepo', () => {
    expect(HAS_PRETTIER).toBe(false);
  });

  it('will not fetch a declared-but-missing package (the npx hazard)', async () => {
    /*
     * This repo DECLARES prettier in devDependencies and has no node_modules.
     * `npx prettier` would resolve that by downloading and executing whatever
     * is published under that name — arbitrary code, on the worker, at
     * generation time. packages/shared/src/ecosystems.ts documents the same
     * hazard for test invocation. So the only acceptable answer is UNAVAILABLE.
     */
    const out = await toolchainFor({ repoRoot: declaredOnlyRepo }).format({
      code: "const x = 'a';\n",
      filePath: 'src/x.ts',
    });

    expectCouldNotCheck(out, /not installed/);
    // And critically: no `code`. Returning a half-answer here would have the
    // caller store something nothing produced.
    expect(out.code).toBeUndefined();
    expect(out.why).toMatch(/stored exactly as generated/);
  });

  it('returns no formatted code for a repository with no formatter', async () => {
    const out = await toolchainFor({ repoRoot: bareRepo }).format({
      code: 'export const x = 1;\n',
      filePath: 'src/x.ts',
    });
    expectCouldNotCheck(out);
    expect(out.code).toBeUndefined();
  });

  it('explains why C# gets no formatter instead of silently skipping it', async () => {
    const out = await toolchainFor({ repoRoot: bareRepo }).format({
      code: 'class Thing { }\n',
      filePath: 'Thing.cs',
    });
    expectCouldNotCheck(out, /dotnet format/);
  });

  it('returns a GateOutcome on timeout rather than throwing', async () => {
    /*
     * A gate that throws takes the generation down with it — trading a
     * formatting nit for a lost run. The stub here never returns, so this
     * exercises the real spawn, the real timer and the real kill path.
     */
    const started = Date.now();
    const out = await toolchainFor({ repoRoot: slowRepo, timeoutMs: 250 }).format({
      code: 'export const x = 1;\n',
      filePath: 'src/x.ts',
    });
    const elapsed = Date.now() - started;

    expectCouldNotCheck(out, /did not finish/);
    expect(out.code).toBeUndefined();
    // It really was stopped, not waited out.
    expect(elapsed).toBeLessThan(10_000);
  });
});

// ─── LINT ────────────────────────────────────────────────────────────────────

describe('LINT', () => {
  it.skipIf(!HAS_ESLINT)("grades by the linter's own severity: error → FAIL", async () => {
    const out = await toolchainFor({ repoRoot: tsRepo }).lint({
      // `no-unused-vars` is an ERROR in the fixture config.
      code: 'const unusedHelper = 1\nexport default 2\n',
      filePath: 'src/thing.ts',
    });

    expect(out.status).toBe('FAIL');
    expect(out.line).toBe(1);
    expect(out.detail.join('\n')).toMatch(/no-unused-vars/);
    expect(out.why).toMatch(/eslint/);
    expect(out.why).toMatch(/1 error/);
  });

  it.skipIf(!HAS_ESLINT)("grades by the linter's own severity: warning → WARN", async () => {
    const out = await toolchainFor({ repoRoot: tsRepo }).lint({
      // `no-console` is a WARNING in the fixture config. A generated test that
      // trips a style rule is something a human can accept; throwing it away
      // would be the gate overruling the project's own grading.
      code: 'export default function run() {\n    console.log("hi")\n}\n',
      filePath: 'src/thing.ts',
    });

    expect(out.status).toBe('WARN');
    expect(out.line).toBe(2);
    expect(out.why).toMatch(/1 warning/);
  });

  it.skipIf(!HAS_ESLINT)('passes a file the repository has no complaint about', async () => {
    const out = await toolchainFor({ repoRoot: tsRepo }).lint({
      code: 'export default function run() {\n    return 1\n}\n',
      filePath: 'src/thing.ts',
    });
    expect(out.status).toBe('PASS');
    expect(out.detail).toEqual([]);
  });

  it.skipIf(!HAS_ESLINT)(
    'reports UNAVAILABLE — not FAIL — when eslint itself cannot lint the path',
    async () => {
      /*
       * Run against this monorepo, whose eslint config is type-aware. A file
       * that is not on disk yet belongs to no tsconfig project, so
       * typescript-eslint refuses it with a fatal "not found by the project
       * service" message and no line number.
       *
       * That is ESLINT failing, not the candidate failing. Reporting it as FAIL
       * would block correct generated code with a message about tsconfig
       * includes, which is the kind of finding that gets a gate switched off.
       */
      const out = await toolchainFor({ repoRoot: MONOREPO }).lint({
        code: 'export const x = 1;\n',
        filePath: 'packages/agent/src/__gate_probe_not_on_disk__.ts',
      });

      expect(out.status).not.toBe('FAIL');
      expect(out.status).not.toBe('PASS');
      expect(out.status).toBe('UNAVAILABLE');
      expect(out.line).toBeNull();
    },
  );

  it.skipIf(HAS_ESLINT)('skipped: eslint is not installed in this monorepo', () => {
    expect(HAS_ESLINT).toBe(false);
  });

  it('reports UNAVAILABLE for a repository with no linter', async () => {
    const out = await toolchainFor({ repoRoot: bareRepo }).lint({
      code: 'export const x = 1;\n',
      filePath: 'src/x.ts',
    });
    expectCouldNotCheck(out);
  });

  it('declines Go rather than running a project-wide linter per file', async () => {
    const out = await toolchainFor({ repoRoot: bareRepo }).lint({
      code: 'package main\n',
      filePath: 'main.go',
    });
    expectCouldNotCheck(out, /go vet|golangci/);
  });
});

// ─── The bare repository: every gate, and never a PASS ───────────────────────

describe('a repository with no tooling at all', () => {
  it('returns UNAVAILABLE for every gate, and PASS for none', async () => {
    /*
     * C# on purpose. For TypeScript, SYNTAX legitimately passes in an empty
     * repo because the parser is ours (asserted above) — so a language where
     * every gate needs the customer's toolchain is the one that proves the
     * rule. If any of these four ever says PASS, a generated file that nothing
     * looked at has an admission record saying four checks were made.
     */
    const gates = toolchainFor({ repoRoot: bareRepo });
    const input = { code: 'public class Thing { }\n', filePath: 'Thing.cs' };

    const outcomes = [
      await gates.syntax(input),
      await gates.typecheck(input),
      await gates.format(input),
      await gates.lint(input),
    ];

    for (const out of outcomes) {
      expectCouldNotCheck(out);
      expect(out.detail.join('\n')).not.toMatch(/\bPASS\b/);
    }
    expect(outcomes.map((o) => o.gate)).toEqual(['SYNTAX', 'TYPECHECK', 'FORMAT', 'LINT']);
  });

  it('never claims a tool ran: every `why` names what was missing', async () => {
    const gates = toolchainFor({ repoRoot: bareRepo });
    const input = { code: 'export const x = 1;\n', filePath: 'src/x.ts' };

    const format = await gates.format(input);
    const lint = await gates.lint(input);

    for (const out of [format, lint]) {
      expect(out.status).toBe('UNAVAILABLE');
      // "not formatted" / "not linted", then the reason. A bare status with a
      // cheerful `why` is how "LINT: PASS" from an uninstalled linter happens.
      expect(out.why).toMatch(/^not (formatted|linted):/);
    }
  });

  it('survives a repoRoot that does not exist, without throwing', async () => {
    const gates = toolchainFor({ repoRoot: join(sandbox, 'does', 'not', 'exist') });
    const input = { code: 'export const x = 1;\n', filePath: 'src/x.ts' };

    // Discovery reads nothing, every resolution fails, and all four answer
    // honestly. The alternative — an ENOENT escaping from readdir — would abort
    // a generation because of a misconfigured path.
    expectCouldNotCheck(await gates.typecheck(input));
    expectCouldNotCheck(await gates.format(input));
    expectCouldNotCheck(await gates.lint(input));
    // SYNTAX still works: it needs no repository at all.
    expect((await gates.syntax(input)).status).toBe('PASS');
  });
});

// ─── The secret that must not reach a child ──────────────────────────────────

describe('child environment', () => {
  const SENTINELS = {
    VAULT_MASTER_KEY: 'sentinel-vault-f0e1d2c3',
    DATABASE_URL: 'postgres://sentinel:db4e5f6a@localhost:5432/qaai',
    SESSION_SECRET: 'sentinel-session-9a8b7c6d',
    STRIPE_SECRET_KEY: 'sk_live_sentinel1234567890',
    S3_SECRET_ACCESS_KEY: 'sentinel-s3-abcdef012345',
    ANTHROPIC_API_KEY: 'sentinel-anthropic-0f1e2d',
  } as const;

  const saved = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const [key, value] of Object.entries(SENTINELS)) {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
  });

  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('builds an environment that contains no secret and still works', () => {
    const env = gateChildEnv();

    for (const [key, value] of Object.entries(SENTINELS)) {
      expect(env[key]).toBeUndefined();
      expect(Object.values(env)).not.toContain(value);
    }

    /*
     * The other half of the assertion, and the one that stops this test from
     * passing vacuously: an EMPTY environment leaks nothing either, and would
     * also break every gate. PATH has to be there, because without it nothing
     * can be spawned at all.
     */
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('screens anything a caller passes, so `extra` cannot widen the allowlist', () => {
    // The second lock from the file header: a caller that builds `extra` from a
    // merged config object must not be able to reopen the hole by accident.
    const env = gateChildEnv({
      MY_APP_SECRET_KEY: 'nope',
      SOME_TOKEN: 'nope',
      TENANT_DATABASE_URL: 'nope',
      QAAI_HARMLESS: 'yes',
    });

    expect(env.MY_APP_SECRET_KEY).toBeUndefined();
    expect(env.SOME_TOKEN).toBeUndefined();
    expect(env.TENANT_DATABASE_URL).toBeUndefined();
    expect(env.QAAI_HARMLESS).toBe('yes');
  });

  it('screens by substring and case, because MY_APP_SECRET_KEY is the same leak', () => {
    for (const key of [
      'VAULT_MASTER_KEY',
      'vault_master_key',
      'DATABASE_URL',
      'MY_APP_SECRET',
      'x_api_key',
      'GITHUB_WEBHOOK_SECRET',
      'STRIPE_SECRET_KEY',
      'SMTP_PASSWORD',
      'AWS_ACCESS_KEY_ID',
      'SESSION_SECRET',
    ]) {
      expect(isForbiddenGateEnvKey(key)).toBe(true);
    }
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'CI', 'GOROOT']) {
      expect(isForbiddenGateEnvKey(key)).toBe(false);
    }
  });

  it('a spawned child really does not receive the secrets', async () => {
    /*
     * The assertion above proves the POLICY. This one proves the policy is on
     * the code path — which is the thing that actually broke in the runner: the
     * allowlist existed and a spawn site started from `...process.env` anyway.
     *
     * So: a stub binary at <repo>/node_modules/.bin/prettier, resolved and
     * spawned by the real FORMAT gate, writes its own environment to a file.
     * What we read back is what the operating system gave the child, not what
     * this test hoped it would.
     */
    const out = await toolchainFor({ repoRoot: stubRepo }).format({
      code: 'export const x = 1;\n',
      filePath: 'src/x.ts',
    });

    // The stub behaves like a formatter that changed nothing.
    expect(out.status).toBe('PASS');
    expect(out.code).toBe('export const x = 1;\n');
    expect(out.why).toContain('node_modules/.bin/prettier');

    expect(existsSync(stubEnvDump)).toBe(true);
    const observed = readFileSync(stubEnvDump, 'utf8');

    for (const [key, value] of Object.entries(SENTINELS)) {
      // Neither the name...
      expect(observed).not.toMatch(new RegExp(`^${key}=`, 'm'));
      // ...nor the value, wherever it might have been smuggled.
      expect(observed).not.toContain(value);
    }

    // And the child was given enough to work: an environment with nothing in it
    // would pass the four assertions above and break every gate.
    expect(observed).toMatch(/^PATH=/m);
  });
});
