/**
 * E2E plugin tests — WHERE a routed test executes.
 *
 * The Playwright route is covered by the harness's own tests and needs a
 * browser; nothing here touches it. What is pinned here is the two non-browser
 * routes, because both of them resolved their working directory from
 * `process.cwd()` — which on the cloud worker is QAAI'S OWN CHECKOUT:
 *
 *  1. **A declared external spec** (`{command, args, cwd}`) ran the customer's
 *     own command with no workspace at all, so `npx cypress run` ran whatever
 *     QAAI's directory happened to hold and the result was filed as the
 *     customer's. It now runs inside the run's materialised repository, and
 *     without one it says so rather than producing a verdict about the wrong
 *     tree.
 *  2. **A catalogue-routed test** materialised its scratch tree at
 *     `join(process.cwd(), '.qaai-external', slug)` — INSIDE THE WORKER'S OWN
 *     SOURCE TREE. It now lives under the OS temp directory and is removed on
 *     every exit path.
 *
 * Both routes are driven through real child processes: a `node -e` command for
 * the declared route, and a stub `python3` on PATH for the catalogue route. A
 * stub that records its own `pwd` is the only way to assert where a run actually
 * happened, which is the entire subject of this file.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArtifactSink, ExecutableTest, RunContext } from '@qaai/shared';
import { e2ePlugin } from './e2e.js';
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
    workspaceRoot === null
      ? null
      : { root: workspaceRoot, source: 'acme/shop@main', fileCount: 31 },
  );
}

const PASSING_JUNIT =
  '<?xml version="1.0"?><testsuites><testsuite name="s" tests="1"><testcase name="t"/></testsuite></testsuites>';

function makeTest(over: Partial<ExecutableTest> = {}): ExecutableTest {
  return {
    id: 'test_1',
    name: 'checkout journey',
    type: 'E2E',
    code: '# a pytest module, not a Playwright spec\ndef test_checkout():\n    assert True\n',
    filePath: 'tests/test_checkout.py',
    spec: {},
    timeoutMs: 60_000,
    quarantined: false,
    tags: [],
    ...over,
  };
}

/** Where `.qaai-external` used to be written: beside this package's source. */
const OLD_SCRATCH_ROOT = join(process.cwd(), '.qaai-external');

let workspace = '';

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'qaai-e2e-repo-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('a test with its own command and cwd', () => {
  /** Writes a marker in its cwd, then the report the plugin reads. */
  const script = [
    'const fs = require("fs");',
    'fs.writeFileSync("qaai-where-am-i", process.cwd());',
    `fs.writeFileSync("report.xml", ${JSON.stringify(PASSING_JUNIT)});`,
  ].join('\n');

  const declared = (over: Record<string, unknown> = {}): ExecutableTest =>
    makeTest({
      spec: {
        command: process.execPath,
        args: ['-e', script],
        reportPath: 'report.xml',
        reportFormat: 'junit-xml',
        timeoutSeconds: 60,
        ...over,
      },
    });

  it('runs inside the materialised repository', async () => {
    const execution = await e2ePlugin.execute(makeContext(workspace), declared());

    expect(execution.status).toBe('PASSED');
    // The command recorded its own cwd, so this is proof rather than inference.
    // Compared by suffix because macOS resolves /var through /private/var, and
    // the point of the assertion is the directory, not the symlink spelling.
    const ranIn = await readFile(join(workspace, 'qaai-where-am-i'), 'utf8');
    expect(ranIn.endsWith(basename(workspace))).toBe(true);
    expect(ranIn.startsWith(process.cwd())).toBe(false);
    expect(existsSync(join(process.cwd(), 'qaai-where-am-i'))).toBe(false);
  });

  it('is not evaluated when the run has no checkout of the repository', async () => {
    const execution = await e2ePlugin.execute(makeContext(null), declared());

    // SKIPPED: no connected repository is a configuration gap, not a verdict on
    // the application.
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toMatch(/no checkout of it/);
    expect(execution.errorMessage).toMatch(/Connect the project to its repository/);
    // The old behaviour: this ran in QAAI's own checkout.
    expect(existsSync(join(process.cwd(), 'qaai-where-am-i'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'report.xml'))).toBe(false);
  });

  it('fails, rather than skips, on a cwd that climbs out of the repository', async () => {
    const execution = await e2ePlugin.execute(
      makeContext(workspace),
      declared({ cwd: '../..' }),
    );

    // FAILED: a test that can never run as written is not an environment gap,
    // and a skip would keep the gate green forever.
    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toMatch(/not inside the repository/);
    expect(existsSync(join(workspace, '..', '..', 'qaai-where-am-i'))).toBe(false);
  });
});

describe('a test routed to its ecosystem’s own runner', () => {
  const originalPath = process.env.PATH;
  let binDir = '';
  let cwdFile = '';

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'qaai-e2e-bin-'));
    cwdFile = join(binDir, 'cwd.txt');

    // A stub `python3`: records where it ran, then writes the JUnit report at
    // the path pytest was told to use (relative to its own cwd).
    const stub = `#!/bin/sh
pwd > "$QAAI_STUB_CWD"
mkdir -p reports
cat > reports/pytest-junit.xml <<'XML'
${PASSING_JUNIT}
XML
exit 0
`;
    await writeFile(join(binDir, 'python3'), stub, { mode: 0o755 });
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    process.env.QAAI_STUB_CWD = cwdFile;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    delete process.env.QAAI_STUB_CWD;
    await rm(binDir, { recursive: true, force: true });
  });

  it('materialises its scratch tree under the temp directory, not in QAAI’s source', async () => {
    const existingScratch = existsSync(OLD_SCRATCH_ROOT);

    const execution = await e2ePlugin.execute(
      makeContext(workspace),
      makeTest({ spec: { ecosystem: 'pytest' } }),
    );

    expect(execution.status).toBe('PASSED');

    const ranIn = (await readFile(cwdFile, 'utf8')).trim();
    expect(ranIn.startsWith(process.cwd())).toBe(false);
    expect(ranIn).not.toContain('.qaai-external');
    // Cleaned up on the way out, whatever the outcome — the `finally`.
    expect(existsSync(ranIn)).toBe(false);
    // And the directory it used to be written into was never created.
    expect(existsSync(OLD_SCRATCH_ROOT)).toBe(existingScratch);
  });

  it('refuses a test path that climbs out of the scratch workspace', async () => {
    const execution = await e2ePlugin.execute(
      makeContext(workspace),
      makeTest({ spec: { ecosystem: 'pytest' }, filePath: '../escaped_test.py' }),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toMatch(/must not climb out of it/);
    // Nothing was spawned, so the stub never recorded a directory.
    expect(existsSync(cwdFile)).toBe(false);
  });
});
