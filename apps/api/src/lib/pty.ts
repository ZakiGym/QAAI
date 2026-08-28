/**
 * Shell sessions on a run — and the honest account of what a shell can be here.
 *
 * This file is called `pty.ts` and it does not allocate a pty. That is the
 * finding, not an omission, so it is written down at the top rather than
 * discovered by whoever reads it next.
 *
 * ── Why there is no pty ──────────────────────────────────────────────────────
 *
 * A run executes in exactly one of two places, and neither of them can hold an
 * interactive terminal for a customer:
 *
 *  1. **Our queue.** `apps/worker/src/processors/run.ts` executes tests
 *     IN-PROCESS in a long-lived `worker` container that drains a cross-org
 *     queue (see the `unscoped` drain, and `docker-compose.yml`: one worker
 *     service, not one per run). There is no per-run container to attach to.
 *     The container that ran your test is also running four other tenants'
 *     tests and holds VAULT_MASTER_KEY, so a shell in it is a shell over every
 *     customer in the deployment. This is refused outright, and the refusal
 *     names the reason instead of pretending the feature is coming.
 *
 *  2. **The customer's own runner.** `apps/api/src/lib/runners.ts` states the
 *     rule its whole design rests on: *the agent polls out, we never dial a
 *     runner*, and "there is no 'dispatch to runner' call anywhere in this
 *     codebase, and there must never be". A customer's staging network is
 *     unreachable from ours. So there is no socket to open, no port to forward
 *     and no exec API to call — not as a limitation of this file, but as the
 *     premise of the product.
 *
 * The second case is nonetheless where a shell legitimately belongs: it is the
 * customer's machine, their network, their tests, and the environment the
 * failure actually happened in. The only channel that exists is the one the
 * agent already opens — it long-polls for work while holding a fenced lease.
 * So a session here is **a queue of allowlisted commands the agent picks up on
 * its own poll, executes locally, and streams output back from.** Round-trip
 * latency is a poll interval, not a keystroke. That is not a tty and this
 * module never calls it one.
 *
 * ── The constraint that shapes everything else ───────────────────────────────
 *
 * **A session can only exist while the run's runner job holds a live lease.**
 * When the lease lapses or the job reaches a terminal status, the process, its
 * working directory and its environment are gone — the agent has moved on or
 * died. A session that outlived that would be a session pointed at nothing,
 * answering "why did this fail" with output from a machine in a different
 * state. So sessions are opened against a live-leased job and killed the moment
 * that stops being true.
 *
 * That is also why sessions live in memory here rather than in a table. They
 * cannot outlive the job, the job cannot outlive its lease, and a lease is
 * ninety seconds. `lib/events.ts` makes the same call for the same reason and
 * carries the same caveat, which applies verbatim: **this is correct for one
 * API instance and explicitly not correct for several.** Behind more than one
 * API replica a session opened on instance A is invisible to the agent poll
 * that lands on instance B, and the fix is the same Redis fan-out that file
 * needs — not a second, subtly different one bolted on here.
 *
 * ── Why an allowlist and not a shell ─────────────────────────────────────────
 *
 * `sh -c "<whatever the client sent>"` on a customer's build machine, reachable
 * from our API, is a remote code execution service with a login page. The
 * allowlist below is what makes this a debugging tool rather than that: a fixed
 * set of commands, each with its own argument rule, argv assembled here and
 * never a shell string. Nothing the client sends becomes a host, a path outside
 * the workspace, or a shell metacharacter, and the target — which runner, which
 * job, which working directory — is resolved from the run on the server and is
 * not in the request at all.
 */

import { randomBytes } from 'node:crypto';
import { hashToken, safeEqual } from './crypto.js';

// ─── Timings, all of them stated to the user ─────────────────────────────────

/**
 * The hard ceiling on a session, regardless of activity.
 *
 * Ten minutes because that is the length of a debugging thought, and because a
 * session cannot usefully outlive its job anyway — a runner lease is renewed
 * every 15s and a suite that is still executing ten minutes after you opened a
 * shell on it has other problems. The number is returned from the open call and
 * rendered as a countdown, because an expiry the user cannot see is an expiry
 * they experience as a bug.
 */
export const TERMINAL_MAX_SESSION_MS = 10 * 60_000;

/**
 * Idle timeout. Two minutes of no command and no output ends the session.
 *
 * Shorter than the hard cap on purpose: the common way a shell is left open is
 * a browser tab someone walked away from, and an abandoned command channel into
 * a customer's network should close itself rather than wait out the full ten
 * minutes.
 */
export const TERMINAL_IDLE_MS = 2 * 60_000;

/**
 * How long a single command may run before the agent is told to abandon it.
 *
 * The allowlist contains nothing that should take thirty seconds; anything that
 * does is hung, and a hung command must not hold the session's only execution
 * slot until the session itself expires.
 */
export const TERMINAL_COMMAND_TIMEOUT_MS = 30_000;

/** Commands per session. A debugging session is not a build script. */
export const TERMINAL_MAX_COMMANDS = 50;

/**
 * Output per command. Past this the stream is cut and the truncation is
 * reported — the buffer on the other end is bounded too, so anything beyond
 * this would be transferred across a customer's egress only to be dropped.
 */
export const TERMINAL_MAX_OUTPUT_BYTES = 256 * 1024;

/** Live sessions per org. A ceiling on how much of this can be held open at once. */
export const TERMINAL_MAX_SESSIONS_PER_ORG = 5;

/**
 * What an agent must advertise in `capabilities.toolchains` before a session can
 * be opened against it.
 *
 * This gate is the difference between shipping a feature and shipping a screen
 * that hangs. The agent in `packages/cli/src/runner.ts` does not yet poll for
 * commands, so until it does, every open refuses with a sentence naming the
 * agent version needed. A terminal that opens and then produces nothing forever
 * is exactly the fake shell this was not allowed to be.
 */
export const TERMINAL_CAPABILITY = 'terminal';

/** Session keys are visibly not API keys or runner tokens. */
export const TERMINAL_KEY_PREFIX = 'qaai_sh_';

// ─── The allowlist ───────────────────────────────────────────────────────────

/**
 * How a command's arguments are checked. Every entry gets its own rule, because
 * "safe arguments" is a per-command question: `ls somedir` is fine and
 * `git push somewhere` is not.
 */
type ArgRule =
  /** No arguments at all. */
  | { kind: 'none' }
  /** Exactly one of these literal argument vectors. */
  | { kind: 'literal'; allowed: readonly (readonly string[])[] }
  /** Zero or more workspace-relative paths, plus an optional literal prefix. */
  | { kind: 'paths'; prefix?: readonly string[]; max: number };

interface AllowedCommand {
  rule: ArgRule;
  /** Shown in the UI so the user can see the whole surface without guessing. */
  why: string;
}

/**
 * Everything a session may run, and nothing else.
 *
 * Chosen against one question: does this help answer "why did this fail HERE
 * and not on my laptop?" Every entry is a read. Between them they cover the
 * four things that actually differ between a runner and a developer machine —
 * the toolchain versions, the workspace contents, what else is on the box, and
 * which commit is checked out.
 *
 * Three deliberate exclusions, each of which someone will ask for:
 *
 *   `env` / `printenv` — the run's environment is where the vault injects the
 *   customer's secrets (see `secretsFor` in the worker). Dumping it down a
 *   channel we log and audit would put live credentials in an audit row and a
 *   browser tab. The environment is exactly what the person debugging wants to
 *   see, and it is exactly what they may not have; the answer is the secrets
 *   panel, which shows names without values.
 *
 *   `curl` / `wget` — a request-forgery primitive aimed at the inside of a
 *   customer's network, driven from our API. That it is their network does not
 *   make it ours to point.
 *
 *   Anything that writes. A debugging session that can mutate the workspace can
 *   change the answer to the question it was opened to ask.
 */
export const ALLOWED_COMMANDS: ReadonlyMap<string, AllowedCommand> = new Map<
  string,
  AllowedCommand
>([
  [
    'node',
    { rule: { kind: 'literal', allowed: [['--version'], ['-v']] }, why: 'Node version' },
  ],
  [
    'npm',
    {
      rule: { kind: 'literal', allowed: [['--version'], ['ls', '--depth=0']] },
      why: 'npm version and top-level dependencies',
    },
  ],
  [
    'npx',
    {
      rule: { kind: 'literal', allowed: [['playwright', '--version']] },
      why: 'Playwright version',
    },
  ],
  ['pwd', { rule: { kind: 'none' }, why: 'The working directory the run used' }],
  ['ls', { rule: { kind: 'paths', prefix: ['-la'], max: 4 }, why: 'Workspace contents' }],
  ['cat', { rule: { kind: 'paths', max: 1 }, why: 'Read a file in the workspace' }],
  ['head', { rule: { kind: 'paths', prefix: ['-n', '200'], max: 1 }, why: 'First lines of a file' }],
  ['tail', { rule: { kind: 'paths', prefix: ['-n', '200'], max: 1 }, why: 'Last lines of a file' }],
  ['uname', { rule: { kind: 'literal', allowed: [['-a']] }, why: 'Kernel and architecture' }],
  ['df', { rule: { kind: 'literal', allowed: [['-h']] }, why: 'Disk space — a full disk fails oddly' }],
  ['ps', { rule: { kind: 'literal', allowed: [['aux']] }, why: 'Leftover browsers and stray processes' }],
  [
    'git',
    {
      rule: {
        kind: 'literal',
        allowed: [
          ['rev-parse', 'HEAD'],
          ['status', '--porcelain'],
          ['log', '-1', '--oneline'],
        ],
      },
      why: 'Which commit the workspace is actually on',
    },
  ],
]);

/**
 * Characters a command line may contain.
 *
 * Deliberately a fixed character-class test and NOT a regex built from input —
 * this codebase does not compile a regex from anything a caller sends. Shell
 * metacharacters are absent by construction rather than by blocklist, which is
 * the difference between "we thought of `$()`" and "nothing but these can get
 * through". The argv is handed to the agent as an array and never joined, so
 * this is defence in depth rather than the only defence.
 */
function isSafeChar(ch: string): boolean {
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '.' ||
    ch === '-' ||
    ch === '_' ||
    ch === '/' ||
    ch === '@' ||
    ch === '+' ||
    ch === '='
  );
}

/** The longest command line accepted, before any of it is looked at. */
const MAX_COMMAND_CHARS = 512;

export type ParsedCommand =
  | { ok: true; argv: string[] }
  | { ok: false; reason: string };

/**
 * A workspace-relative path, or a refusal.
 *
 * Three rules, and the reasons are not interchangeable. Absolute paths escape
 * the workspace outright. `..` escapes it one segment at a time and is the
 * classic way an allowlist that only checks the prefix is defeated. A leading
 * `-` is read by every one of these binaries as an option, so `cat -v` would
 * smuggle a flag through the path rule that the literal rule exists to control.
 */
function checkPath(arg: string): string | null {
  if (arg.startsWith('/')) return 'Paths must be relative to the run workspace';
  if (arg.startsWith('-')) return 'A path may not start with "-"';
  if (arg === '..' || arg.startsWith('../') || arg.includes('/../') || arg.endsWith('/..')) {
    return 'Paths may not walk out of the run workspace with ".."';
  }
  if (arg.length > 200) return 'That path is too long';
  return null;
}

/**
 * Turn a typed line into an argv the agent may execute, or say why not.
 *
 * Splitting is on whitespace only. There is no quoting and no escaping, which
 * means there are no quoting bugs: a filename with a space in it cannot be
 * addressed, and that is a price worth paying for a parser with no state.
 */
export function parseCommand(line: string): ParsedCommand {
  const trimmed = line.trim();
  if (!trimmed) return { ok: false, reason: 'Type a command' };
  if (trimmed.length > MAX_COMMAND_CHARS) {
    return { ok: false, reason: `A command may be at most ${MAX_COMMAND_CHARS} characters` };
  }

  for (const ch of trimmed) {
    if (ch === ' ' || isSafeChar(ch)) continue;
    return {
      ok: false,
      reason: `"${ch}" is not allowed in a command. This is not a shell: there is no piping, redirection or substitution.`,
    };
  }

  const parts = trimmed.split(/\s+/);
  const name = parts[0]!;
  const args = parts.slice(1);

  const entry = ALLOWED_COMMANDS.get(name);
  if (!entry) {
    return {
      ok: false,
      reason: `"${name}" is not one of the commands this session may run. Allowed: ${[...ALLOWED_COMMANDS.keys()].join(', ')}.`,
    };
  }

  const rule = entry.rule;

  if (rule.kind === 'none') {
    if (args.length > 0) return { ok: false, reason: `${name} takes no arguments here` };
    return { ok: true, argv: [name] };
  }

  if (rule.kind === 'literal') {
    for (const candidate of rule.allowed) {
      if (candidate.length === args.length && candidate.every((part, i) => part === args[i])) {
        return { ok: true, argv: [name, ...candidate] };
      }
    }
    const forms = rule.allowed.map((candidate) => `${name} ${candidate.join(' ')}`).join(', ');
    return { ok: false, reason: `${name} is allowed only as: ${forms}` };
  }

  if (args.length > rule.max) {
    return { ok: false, reason: `${name} takes at most ${rule.max} path${rule.max === 1 ? '' : 's'}` };
  }
  for (const arg of args) {
    const problem = checkPath(arg);
    if (problem) return { ok: false, reason: problem };
  }
  // The prefix is OURS, not the caller's — `ls` is always `ls -la`, `head` is
  // always bounded at 200 lines. Prepending it here means the caller cannot
  // choose the flags and cannot omit the bound.
  return { ok: true, argv: [name, ...(rule.prefix ?? []), ...args] };
}

/** The allowlist, in the shape the cockpit renders. */
export function describeAllowlist(): Array<{ command: string; forms: string[]; why: string }> {
  return [...ALLOWED_COMMANDS.entries()].map(([command, entry]) => {
    const rule = entry.rule;
    const forms =
      rule.kind === 'none'
        ? [command]
        : rule.kind === 'literal'
          ? rule.allowed.map((candidate) => `${command} ${candidate.join(' ')}`)
          : [`${command} <path>`];
    return { command, forms, why: entry.why };
  });
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export type CommandStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'ABANDONED';
export type OutputStream = 'stdout' | 'stderr';

export interface TerminalCommand {
  id: string;
  argv: string[];
  status: CommandStatus;
  /** Bytes streamed so far, against TERMINAL_MAX_OUTPUT_BYTES. */
  bytes: number;
  truncated: boolean;
  exitCode: number | null;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** What a subscriber receives. One shape, so the client has one switch. */
export type TerminalEvent =
  | { type: 'command'; commandId: string; argv: string[] }
  | { type: 'output'; commandId: string; stream: OutputStream; chunk: string }
  | { type: 'truncated'; commandId: string; limit: number }
  | { type: 'exit'; commandId: string; exitCode: number | null; status: CommandStatus }
  | { type: 'closed'; reason: string };

type Sink = (event: TerminalEvent) => void;

export interface TerminalSession {
  id: string;
  orgId: string;
  runId: string;
  /** The RunnerJob whose lease this session is parasitic on. */
  jobId: string;
  /** Resolved from the job on the server. Never supplied by a client. */
  runnerId: string;
  /** Who opened it. A second person debugging the same run gets their own. */
  userId: string;
  keyHash: string;
  openedAt: number;
  expiresAt: number;
  lastActivityAt: number;
  closedReason: string | null;
  commands: TerminalCommand[];
  sinks: Set<Sink>;
}

/**
 * In-process, and see the header for why that is a considered choice rather
 * than a shortcut — plus the one deployment shape it is wrong for.
 */
const sessions = new Map<string, TerminalSession>();

/**
 * commandId → sessionId.
 *
 * The agent posts output knowing its job and the command it was handed, not the
 * session — it was never told one. This is what turns that into a session
 * lookup, and it is deliberately not a scan over every session: the alternative
 * is a loop that gets slower as other tenants open shells, which is a side
 * channel as much as it is a performance problem.
 */
const commandIndex = new Map<string, string>();

/** Which session owns this command id, if any is still live. */
export function sessionIdForCommand(commandId: string): string | null {
  return commandIndex.get(commandId) ?? null;
}

export interface OpenedSession {
  session: TerminalSession;
  /** Returned once, never stored in plaintext, never put in a URL. */
  key: string;
}

export function openSession(args: {
  orgId: string;
  runId: string;
  jobId: string;
  runnerId: string;
  userId: string;
  now?: number;
}): OpenedSession {
  const now = args.now ?? Date.now();
  // 32 bytes from the CSPRNG. Guessing one is not a threat model; the key is
  // still only half the check, since every route also re-derives the org from
  // the caller's own credential.
  const key = `${TERMINAL_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;

  const session: TerminalSession = {
    id: `sh_${randomBytes(12).toString('base64url')}`,
    orgId: args.orgId,
    runId: args.runId,
    jobId: args.jobId,
    runnerId: args.runnerId,
    userId: args.userId,
    keyHash: hashToken(key),
    openedAt: now,
    expiresAt: now + TERMINAL_MAX_SESSION_MS,
    lastActivityAt: now,
    closedReason: null,
    commands: [],
    sinks: new Set(),
  };

  sessions.set(session.id, session);
  return { session, key };
}

export function countOpenSessions(orgId: string, now = Date.now()): number {
  sweep(now);
  let count = 0;
  for (const session of sessions.values()) if (session.orgId === orgId) count += 1;
  return count;
}

/** Why a session cannot be used right now, in the words the user should see. */
export type SessionRefusal = 'not-found' | 'expired' | 'idle' | 'bad-key' | 'wrong-user';

export type SessionLookup =
  | { ok: true; session: TerminalSession }
  | { ok: false; refusal: SessionRefusal };

/**
 * Resolve a session for the user who owns it.
 *
 * `orgId` and `userId` come from the caller's authenticated actor, never from
 * the request body — the key alone is deliberately NOT sufficient. A leaked key
 * without a valid session for the right user in the right org opens nothing,
 * and a valid session for the wrong org reads as not-found, so this is never an
 * existence oracle for another tenant's runs.
 */
export function resolveSession(args: {
  sessionId: string;
  orgId: string;
  userId: string;
  key?: string;
  now?: number;
}): SessionLookup {
  const now = args.now ?? Date.now();
  sweep(now);

  const session = sessions.get(args.sessionId);
  if (!session || session.orgId !== args.orgId) return { ok: false, refusal: 'not-found' };
  if (session.expiresAt <= now) return { ok: false, refusal: 'expired' };
  if (now - session.lastActivityAt >= TERMINAL_IDLE_MS) return { ok: false, refusal: 'idle' };
  if (session.userId !== args.userId) return { ok: false, refusal: 'wrong-user' };
  if (args.key !== undefined && !safeEqual(session.keyHash, hashToken(args.key))) {
    return { ok: false, refusal: 'bad-key' };
  }
  return { ok: true, session };
}

/**
 * Resolve a session on behalf of the agent that is executing for it.
 *
 * The agent presents no session key — it never sees one. It is authenticated as
 * a runner and identified by id, and the session is only handed over if this is
 * the very runner the session was bound to at open time. A second runner in the
 * same org, holding a valid runner token, gets nothing.
 */
export function sessionForRunner(args: {
  sessionId: string;
  orgId: string;
  runnerId: string;
  now?: number;
}): SessionLookup {
  const now = args.now ?? Date.now();
  sweep(now);

  const session = sessions.get(args.sessionId);
  if (!session || session.orgId !== args.orgId) return { ok: false, refusal: 'not-found' };
  if (session.runnerId !== args.runnerId) return { ok: false, refusal: 'not-found' };
  if (session.expiresAt <= now) return { ok: false, refusal: 'expired' };
  return { ok: true, session };
}

export function touch(session: TerminalSession, now = Date.now()): void {
  session.lastActivityAt = now;
}

export function subscribe(session: TerminalSession, sink: Sink): () => void {
  session.sinks.add(sink);
  return () => session.sinks.delete(sink);
}

function emit(session: TerminalSession, event: TerminalEvent): void {
  for (const sink of session.sinks) {
    try {
      sink(event);
    } catch {
      // A dead response must not stop the others being written.
      session.sinks.delete(sink);
    }
  }
}

export type EnqueueResult =
  | { ok: true; command: TerminalCommand }
  | { ok: false; reason: string };

export function enqueueCommand(
  session: TerminalSession,
  argv: string[],
  now = Date.now(),
): EnqueueResult {
  if (session.commands.length >= TERMINAL_MAX_COMMANDS) {
    return {
      ok: false,
      reason: `This session has run its ${TERMINAL_MAX_COMMANDS}-command limit. Open a new one.`,
    };
  }
  // One at a time. Two commands in flight on one session would interleave their
  // output on a stream whose only ordering is arrival, and there is no reason a
  // person typing into a terminal needs concurrency.
  const inFlight = session.commands.find(
    (command) => command.status === 'PENDING' || command.status === 'RUNNING',
  );
  if (inFlight) {
    return { ok: false, reason: `"${inFlight.argv.join(' ')}" is still running.` };
  }

  const command: TerminalCommand = {
    id: `cmd_${randomBytes(9).toString('base64url')}`,
    argv,
    status: 'PENDING',
    bytes: 0,
    truncated: false,
    exitCode: null,
    queuedAt: now,
    startedAt: null,
    finishedAt: null,
  };
  session.commands.push(command);
  commandIndex.set(command.id, session.id);
  touch(session, now);
  emit(session, { type: 'command', commandId: command.id, argv });
  return { ok: true, command };
}

/**
 * What the agent's poll returns: the one pending command, marked RUNNING.
 *
 * Handing it out flips the status, so a second poll — a retry, or a duplicate
 * agent process — gets nothing rather than executing the same command twice.
 */
export function claimNextCommand(
  session: TerminalSession,
  now = Date.now(),
): TerminalCommand | null {
  const pending = session.commands.find((command) => command.status === 'PENDING');
  if (!pending) return null;
  pending.status = 'RUNNING';
  pending.startedAt = now;
  touch(session, now);
  return pending;
}

export function findCommand(
  session: TerminalSession,
  commandId: string,
): TerminalCommand | null {
  return session.commands.find((command) => command.id === commandId) ?? null;
}

/**
 * At most `maxBytes` of `text`, cut on a character boundary.
 *
 * `Buffer.subarray(0, n).toString('utf8')` is the obvious version and it is
 * wrong: it lands mid-codepoint and decodes the remainder as U+FFFD, so a
 * truncated log ends in a replacement character that looks like corrupted
 * output from the customer's own program rather than our cut. The walk back
 * over continuation bytes finds the lead byte of the last character and drops
 * it entirely if its full width does not fit.
 */
function sliceUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;

  let end = maxBytes;
  let lead = end - 1;
  while (lead >= 0 && (buf[lead]! & 0xc0) === 0x80) lead -= 1;
  if (lead >= 0) {
    const first = buf[lead]!;
    const width = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
    if (lead + width > end) end = lead;
  }
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Output from the agent, fanned out to whoever is watching.
 *
 * The byte cap is enforced here rather than trusted to the agent: the agent is
 * software running on a machine we do not control, so every limit that matters
 * is re-applied on arrival.
 */
export function appendOutput(
  session: TerminalSession,
  command: TerminalCommand,
  stream: OutputStream,
  chunk: string,
  now = Date.now(),
): void {
  touch(session, now);
  if (command.truncated) return;

  const remaining = TERMINAL_MAX_OUTPUT_BYTES - command.bytes;
  if (remaining <= 0) {
    command.truncated = true;
    emit(session, { type: 'truncated', commandId: command.id, limit: TERMINAL_MAX_OUTPUT_BYTES });
    return;
  }

  const size = Buffer.byteLength(chunk, 'utf8');
  if (size <= remaining) {
    command.bytes += size;
    emit(session, { type: 'output', commandId: command.id, stream, chunk });
    return;
  }

  const kept = sliceUtf8(chunk, remaining);
  command.bytes += Buffer.byteLength(kept, 'utf8');
  command.truncated = true;
  if (kept) emit(session, { type: 'output', commandId: command.id, stream, chunk: kept });
  emit(session, { type: 'truncated', commandId: command.id, limit: TERMINAL_MAX_OUTPUT_BYTES });
}

export function finishCommand(
  session: TerminalSession,
  command: TerminalCommand,
  exitCode: number | null,
  status: CommandStatus = 'DONE',
  now = Date.now(),
): void {
  if (command.status === 'DONE' || command.status === 'ABANDONED') return;
  command.status = status;
  command.exitCode = exitCode;
  command.finishedAt = now;
  touch(session, now);
  emit(session, { type: 'exit', commandId: command.id, exitCode, status });
}

/**
 * End a session from the server, for any reason.
 *
 * Everything that ends a session goes through here — the user pressing stop, an
 * administrator killing someone else's shell, the idle sweep, the run
 * finishing. One function means a session cannot be half-closed: subscribers
 * are always told why, the command index is always cleaned up, and a killed
 * session can never be resolved again.
 */
export function killSession(sessionId: string, reason: string, now = Date.now()): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  session.closedReason = reason;
  session.expiresAt = Math.min(session.expiresAt, now);
  for (const command of session.commands) {
    if (command.status === 'PENDING' || command.status === 'RUNNING') {
      command.status = 'ABANDONED';
      command.finishedAt = now;
    }
    commandIndex.delete(command.id);
  }
  emit(session, { type: 'closed', reason });
  session.sinks.clear();
  sessions.delete(sessionId);
  return true;
}

/** Every live session in an org, for the "who has a shell open" view and for kills. */
export function sessionsForOrg(orgId: string, now = Date.now()): TerminalSession[] {
  sweep(now);
  return [...sessions.values()].filter((session) => session.orgId === orgId);
}

/**
 * Expire what should be gone.
 *
 * Driven by calls rather than by a timer, which is the same choice
 * `lib/runners.ts` makes for its unservable sweep and for the same reason: the
 * thing that reliably happens is requests, and a `setInterval` in a module is a
 * handle that leaks into every test that imports it.
 */
export function sweep(now = Date.now()): number {
  let closed = 0;
  for (const session of [...sessions.values()]) {
    if (session.expiresAt <= now) {
      killSession(session.id, `Session ended after its ${Math.round(TERMINAL_MAX_SESSION_MS / 60_000)}-minute limit`, now);
      closed += 1;
      continue;
    }
    if (now - session.lastActivityAt >= TERMINAL_IDLE_MS) {
      killSession(session.id, `Session ended after ${Math.round(TERMINAL_IDLE_MS / 60_000)} minutes idle`, now);
      closed += 1;
      continue;
    }
    const running = session.commands.find((command) => command.status === 'RUNNING');
    if (running && running.startedAt && now - running.startedAt >= TERMINAL_COMMAND_TIMEOUT_MS) {
      finishCommand(session, running, null, 'ABANDONED', now);
    }
  }
  return closed;
}

/** Test-only reset. Sessions are process state; a test file must start clean. */
export function _resetSessions(): void {
  sessions.clear();
  commandIndex.clear();
}

/** The limits, in the shape the open response returns them. */
export function sessionLimits() {
  return {
    maxSessionSeconds: Math.round(TERMINAL_MAX_SESSION_MS / 1000),
    idleSeconds: Math.round(TERMINAL_IDLE_MS / 1000),
    commandTimeoutSeconds: Math.round(TERMINAL_COMMAND_TIMEOUT_MS / 1000),
    maxCommands: TERMINAL_MAX_COMMANDS,
    maxOutputBytes: TERMINAL_MAX_OUTPUT_BYTES,
  };
}
