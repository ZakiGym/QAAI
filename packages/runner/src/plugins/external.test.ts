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
import { externalPlugin } from './external.js';
import { attachRunWorkspace } from '../run-workspace.js';

const artifacts: ArtifactSink = {
  put: async () => 'key',
  putFile: async () => 'key',
  get: async () => null,
  putPersistent: async () => 'key',
};

function makeContext(workspaceRoot: string | null): RunContext {
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
  return attachRunWorkspace(
    ctx,
    workspaceRoot ? { root: workspaceRoot, source: 'acme/app@main', fileCount: 1 } : null,
  );
}

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
      command: process.execPath,
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
          command: process.execPath,
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
          command: process.execPath,
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
        command: process.execPath,
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
