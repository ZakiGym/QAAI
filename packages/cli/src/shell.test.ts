/**
 * The agent's own door, and the four ways a command runner gets people hurt.
 *
 *  1. **Running what it was told to run.** The server validates the command and
 *     the agent validates it again, so these tests are written from the agent's
 *     side of that: everything here asserts a REFUSAL of something the server
 *     would never send. If the API's `parseCommand` is bypassed — a bug, a bad
 *     deploy, a compromised API, someone with the database — this is the code
 *     that decides whether it becomes a process on the customer's build host.
 *     A refusal test that passed by accident would be worthless, so the two
 *     that matter (`cat ../secret`, and an off-list binary) assert the side
 *     effect did not happen, not just that a string came back.
 *
 *  2. **Unbounded output.** Asserted against a real file and a real `cat`, with
 *     the cap counted in bytes on the way out — not by trusting the process to
 *     stop.
 *
 *  3. **A process that will not stop.** The timeout is asserted against a
 *     command that genuinely never returns (a read on a fifo nobody writes to),
 *     not against a sleep we could have mocked away.
 *
 *  4. **Orphans.** `killTree` is tested against a process with a CHILD, and the
 *     assertion is that the child is gone afterwards. `child.kill()` passes
 *     every other test in this file and fails that one, which is the whole
 *     point of it being here.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_ALLOWED_COMMANDS,
  checkArgv,
  killTree,
  redactSecrets,
  runShellCommand,
} from './shell.js';
import type { OutputStream } from './shell.js';

const posix = process.platform !== 'win32';

// ─── 1. The allowlist, enforced agent-side ───────────────────────────────────

describe('checkArgv', () => {
  it('accepts the argvs the server actually produces', () => {
    // Transcribed from `parseCommand` in apps/api/src/lib/pty.ts: the server
    // sends an EXPANDED argv, with its own prefix flags already prepended.
    for (const argv of [
      ['node', '--version'],
      ['npm', 'ls', '--depth=0'],
      ['npx', 'playwright', '--version'],
      ['pwd'],
      ['ls', '-la'],
      ['ls', '-la', 'tests', 'artifacts'],
      ['cat', 'package.json'],
      ['head', '-n', '200', 'junit.xml'],
      ['tail', '-n', '200', 'tests/login.spec.ts'],
      ['uname', '-a'],
      ['df', '-h'],
      ['ps', 'aux'],
      ['git', 'rev-parse', 'HEAD'],
      ['git', 'status', '--porcelain'],
      ['git', 'log', '-1', '--oneline'],
    ]) {
      expect(checkArgv(argv), argv.join(' ')).toEqual({ ok: true });
    }
  });

  it('refuses a binary that is not on the list, however ordinary it looks', () => {
    for (const argv of [['sh'], ['bash', '-c', 'x'], ['curl', 'x.example.com'], ['rm', '-rf'], ['env']]) {
      const verdict = checkArgv(argv);
      expect(verdict.ok, argv.join(' ')).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain("this agent's allowlist");
    }
    // `curl http://x` does not even reach the table: the `:` is outside the
    // character class, so it is refused one step earlier. Worth pinning, since
    // it is the sort of thing that looks like a gap in the allowlist when you
    // read the message.
    expect(checkArgv(['curl', 'http://x'])).toEqual({
      ok: false,
      reason: 'an argument contains U+003A, which this agent will not pass to a process',
    });
  });

  it('refuses a listed binary in an unlisted form', () => {
    // `git push` is the one somebody will try, and it is the reason each entry
    // has its own argument rule rather than the list being of binaries.
    expect(checkArgv(['git', 'push', 'origin', 'main']).ok).toBe(false);
    expect(checkArgv(['npm', 'install']).ok).toBe(false);
    expect(checkArgv(['node', '-e', 'require("fs")']).ok).toBe(false);
    expect(checkArgv(['ps', 'auxe']).ok).toBe(false);
  });

  it('refuses a paths command whose fixed prefix is missing or altered', () => {
    // The prefix is the server's, not the caller's: `ls` is always `ls -la` and
    // `head` is always bounded at 200 lines. An argv without it did not come
    // from `parseCommand`, whatever else is true about it.
    expect(checkArgv(['ls']).ok).toBe(false);
    expect(checkArgv(['ls', 'tests']).ok).toBe(false);
    expect(checkArgv(['head', '-n', '999999', 'big.log']).ok).toBe(false);
    expect(checkArgv(['head', 'big.log']).ok).toBe(false);
  });

  it('refuses a path that leaves the workspace, absolutely or by walking', () => {
    expect(checkArgv(['cat', '/etc/passwd']).ok).toBe(false);
    expect(checkArgv(['cat', '../../etc/passwd']).ok).toBe(false);
    expect(checkArgv(['cat', 'a/../../b']).ok).toBe(false);
    expect(checkArgv(['ls', '-la', '..']).ok).toBe(false);
    // ...but a filename that merely begins with dots is a filename.
    expect(checkArgv(['cat', '..hidden.spec.ts'])).toEqual({ ok: true });
    expect(checkArgv(['cat', '.env.example'])).toEqual({ ok: true });
  });

  it('refuses a path that would be read as a flag', () => {
    // `cat -v` smuggles an option through a rule that thinks it is looking at
    // a filename, which is why the leading dash is a path rule and not a
    // character rule.
    const verdict = checkArgv(['cat', '-v']);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('may not start with "-"');
  });

  it('refuses shell metacharacters, newlines and NUL even though no shell would see them', () => {
    for (const arg of ['a;rm', 'a|b', 'a&b', '$(id)', '`id`', 'a>b', 'a\nb', 'a\0b', 'a b', "a'b"]) {
      expect(checkArgv(['cat', arg]).ok, arg).toBe(false);
    }
  });

  it('refuses an argv that is empty, over-long, or padded out', () => {
    expect(checkArgv([]).ok).toBe(false);
    expect(checkArgv(['ls', '-la', 'a', 'b', 'c', 'd', 'e']).ok).toBe(false);
    expect(checkArgv(['cat', 'a'.repeat(300)]).ok).toBe(false);
    expect(checkArgv(['cat', `${'a/'.repeat(120)}b`]).ok).toBe(false);
  });

  it('lists no command that writes, fetches a URL, or prints the environment', () => {
    // The list is a security boundary; this is the assertion that someone
    // adding a convenience to it has to argue with.
    for (const forbidden of ['env', 'printenv', 'curl', 'wget', 'rm', 'mv', 'cp', 'chmod', 'sh', 'bash', 'tee']) {
      expect(AGENT_ALLOWED_COMMANDS.has(forbidden), forbidden).toBe(false);
    }
  });
});

// ─── 2. Redaction ────────────────────────────────────────────────────────────

describe('redactSecrets', () => {
  it('removes a secret value wherever it appears', () => {
    const out = redactSecrets('token=qaai_rt_abcdefgh1234 and again qaai_rt_abcdefgh1234', [
      'qaai_rt_abcdefgh1234',
    ]);
    expect(out).not.toContain('qaai_rt_abcdefgh1234');
    expect(out.match(/\[redacted by the QAAI agent\]/g)).toHaveLength(2);
  });

  it('leaves short values alone rather than carpet-bombing the output', () => {
    // A two-character "secret" would redact half of `ps aux` and hide far more
    // than it protects.
    expect(redactSecrets('the cat sat on the mat', ['at'])).toBe('the cat sat on the mat');
  });

  it('replaces the longest value first, so one secret cannot half-mask another', () => {
    const out = redactSecrets('value=SUPERSECRET-EXTENDED', ['SUPERSECRET', 'SUPERSECRET-EXTENDED']);
    expect(out).toBe('value=[redacted by the QAAI agent]');
  });
});

// ─── 3. The bounded runner ───────────────────────────────────────────────────

interface Collected {
  chunks: Array<{ stream: OutputStream; chunk: string }>;
  text(stream?: OutputStream): string;
}

function collector(stop?: () => boolean): { sink: Collected; onOutput: (s: OutputStream, c: string) => 'stop' | void } {
  const chunks: Array<{ stream: OutputStream; chunk: string }> = [];
  return {
    sink: {
      chunks,
      text: (stream?: OutputStream) =>
        chunks.filter((c) => !stream || c.stream === stream).map((c) => c.chunk).join(''),
    },
    onOutput: (stream, chunk) => {
      chunks.push({ stream, chunk });
      if (stop?.()) return 'stop';
      return undefined;
    },
  };
}

describe('runShellCommand', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qaai-shell-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (
    argv: string[],
    overrides: Partial<Parameters<typeof runShellCommand>[0]> = {},
    onOutput = collector(),
  ) =>
    runShellCommand({
      argv,
      cwd: dir,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 10_000,
      maxOutputBytes: 256 * 1024,
      onOutput: onOutput.onOutput,
      ...overrides,
    });

  it.skipIf(!posix)('runs an allowlisted command in the workspace and reports its exit code', async () => {
    const sink = collector();
    const outcome = await run(['pwd'], {}, sink);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.ended).toBe('exit');
    // The working directory is the run's workspace — the point of the feature.
    // Compared against the resolved path, because `pwd` reports what getcwd()
    // says and a macOS temp directory is reached through a symlink.
    expect(sink.sink.text('stdout').trim()).toBe(realpathSync(dir));
  });

  it.skipIf(!posix)('reports a non-zero exit and the process’s own stderr', async () => {
    const sink = collector();
    const outcome = await run(['cat', 'nope.txt'], {}, sink);

    expect(outcome.exitCode).toBeGreaterThan(0);
    expect(sink.sink.text('stderr')).toMatch(/nope\.txt/);
  });

  it('refuses an off-list command without spawning it', async () => {
    // The proof is the side effect that did not happen: `touch` would create
    // the file if anything had actually run it.
    const sink = collector();
    const outcome = await run(['touch', 'created.txt'], {}, sink);

    expect(outcome.ended).toBe('refused');
    expect(outcome.exitCode).toBeNull();
    expect(sink.sink.text('stderr')).toContain('this agent refused');
    expect(() => rmSync(join(dir, 'created.txt'))).toThrow();
  });

  it.skipIf(!posix)('refuses to read a file above the workspace, and does not read it', async () => {
    // The file really is one level above the workspace, so a `cat` that ran
    // would print it. The assertion is that nothing did.
    writeFileSync(join(dir, 'above-the-workspace.txt'), 'SENSITIVE-CONTENT');
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);

    const sink = collector();
    const outcome = await runShellCommand({
      argv: ['cat', '../above-the-workspace.txt'],
      cwd: workspace,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
      onOutput: sink.onOutput,
    });

    expect(outcome.ended).toBe('refused');
    expect(sink.sink.text()).not.toContain('SENSITIVE-CONTENT');
  });

  it.skipIf(!posix)('stops at the output cap and kills the command', async () => {
    writeFileSync(join(dir, 'big.txt'), 'a'.repeat(400_000));
    const sink = collector();
    const outcome = await run(['cat', 'big.txt'], { maxOutputBytes: 4_096 }, sink);

    expect(outcome.truncated).toBe(true);
    expect(outcome.ended).toBe('output-cap');
    // Counted on the way out, not trusted to the process: what was streamed is
    // bounded even though `cat` was perfectly willing to keep going.
    expect(outcome.bytes).toBeLessThanOrEqual(4_096);
    expect(sink.sink.text('stdout').length).toBeLessThanOrEqual(4_096);
    expect(sink.sink.text('stderr')).toContain('was stopped here');
  });

  it.skipIf(!posix)('splits a large body into chunks the server will accept', async () => {
    // apps/api/src/routes/terminal.ts bounds one chunk at 64Ki characters. A
    // single 100k-character write from `cat` must not arrive as one POST.
    writeFileSync(join(dir, 'wide.txt'), 'b'.repeat(100_000));
    const sink = collector();
    await run(['cat', 'wide.txt'], {}, sink);

    expect(sink.sink.chunks.length).toBeGreaterThan(1);
    for (const { chunk } of sink.sink.chunks) expect(chunk.length).toBeLessThanOrEqual(64 * 1024);
    expect(sink.sink.text('stdout')).toBe('b'.repeat(100_000));
  });

  it.skipIf(!posix)('stops sending as soon as the far end says stop', async () => {
    writeFileSync(join(dir, 'wide.txt'), 'c'.repeat(200_000));
    let seen = 0;
    const sink = collector(() => (seen += 1) >= 1);
    await run(['cat', 'wide.txt'], {}, sink);

    // One chunk was accepted; the session had gone away, so nothing after it
    // was pushed across the customer's egress.
    expect(sink.sink.chunks).toHaveLength(1);
  });

  it.skipIf(!posix)('redacts a known secret value out of what a command printed', async () => {
    writeFileSync(join(dir, 'leaked.txt'), 'API_KEY=sk-live-0123456789abcdef\n');
    const sink = collector();
    await run(['cat', 'leaked.txt'], { redact: ['sk-live-0123456789abcdef'] }, sink);

    expect(sink.sink.text()).not.toContain('sk-live-0123456789abcdef');
    expect(sink.sink.text()).toContain('[redacted by the QAAI agent]');
  });

  it.skipIf(!posix)('reports a missing binary as not-installed rather than as a failure', async () => {
    // PATH is what `spawn` resolves against, so emptying it is a missing `git`
    // without uninstalling one.
    const outcome = await run(['git', 'rev-parse', 'HEAD'], { env: { PATH: join(dir, 'empty') } });
    expect(outcome.ended).toBe('not-installed');
    expect(outcome.notice).toContain('not installed on this runner host');
  });

  it.skipIf(!posix)('kills a command that never returns, and says so', async () => {
    // A read on a fifo nobody writes to blocks forever — a real hang, not a
    // sleep that could have been faked. If the timeout did not fire, this test
    // does not fail: it never finishes, which is the honest signal.
    const fifo = join(dir, 'hangs');
    const made = spawn('mkfifo', [fifo], { shell: false, stdio: 'ignore' });
    const ok = await new Promise<boolean>((settle) => {
      made.on('error', () => settle(false));
      made.on('close', (code) => settle(code === 0));
    });
    if (!ok) return; // no mkfifo on this host; nothing to assert

    const sink = collector();
    const started = Date.now();
    const outcome = await run(['cat', 'hangs'], { timeoutMs: 1_000, killGraceMs: 200 }, sink);

    expect(outcome.ended).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(9_000);
    // `null`, never 137: nothing exited, we killed it.
    expect(outcome.exitCode).toBeNull();
    expect(sink.sink.text('stderr')).toContain('was still running after 1s and was killed');
  });

  it.skipIf(!posix)('kills a running command when the job it belongs to is abandoned', async () => {
    const fifo = join(dir, 'hangs2');
    const made = spawn('mkfifo', [fifo], { shell: false, stdio: 'ignore' });
    const ok = await new Promise<boolean>((settle) => {
      made.on('error', () => settle(false));
      made.on('close', (code) => settle(code === 0));
    });
    if (!ok) return;

    const aborts = new AbortController();
    const sink = collector();
    const running = run(['cat', 'hangs2'], { timeoutMs: 30_000, killGraceMs: 200, signal: aborts.signal }, sink);
    setTimeout(() => aborts.abort(), 100).unref?.();

    const outcome = await running;
    expect(outcome.ended).toBe('aborted');
    expect(sink.sink.text('stderr')).toContain('no longer holding the job');
  });
});

// ─── 4. The kill that takes the children ─────────────────────────────────────

describe.skipIf(!posix)('killTree', () => {
  it('kills the process group, not just the process it was handed', async () => {
    /*
     * The bug this exists to catch is `child.kill()`: the leader dies, the
     * grandchild survives, and a `npm ls` that forked a resolver is left
     * running on the customer's build host after the session that started it
     * has gone. Nothing on the allowlist forks, so the tree is built here by
     * hand — the grandchild's pid comes from the shell, not from our code, and
     * that is what makes the assertion mean something.
     */
    const child = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const grandchild = await new Promise<number>((settle) => {
      child.stdout?.on('data', (buf: Buffer) => settle(Number(buf.toString('utf8').trim())));
    });
    expect(grandchild).toBeGreaterThan(1);
    // Alive right now: `kill -0` throws only if the process is gone.
    expect(() => process.kill(grandchild, 0)).not.toThrow();

    killTree(child, 'SIGKILL');
    await new Promise<void>((settle) => child.on('close', () => settle()));
    // The signal is delivered to the group asynchronously; give the kernel a
    // beat before asking whether the grandchild is gone.
    await new Promise<void>((settle) => {
      setTimeout(settle, 250).unref?.();
    });

    let orphaned = true;
    try {
      process.kill(grandchild, 0);
    } catch {
      orphaned = false;
    }
    if (orphaned) process.kill(grandchild, 'SIGKILL');
    expect(orphaned, 'the grandchild survived the kill').toBe(false);
  });

  it('refuses to signal pid 0 or 1, whatever it is handed', () => {
    // A negative-pid kill with a pid of 0 signals THIS process's own group. A
    // failed spawn leaves `pid` undefined, and the arithmetic that follows is
    // how an agent kills itself and every test on the host.
    for (const pid of [undefined, 0, 1]) {
      expect(() => killTree({ pid, kill: () => true } as never, 'SIGKILL')).not.toThrow();
    }
  });
});
