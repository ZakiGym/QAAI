/**
 * Running somebody else's command, on the customer's own build host.
 *
 * This is the half of the terminal feature that has an actual shell in reach.
 * `apps/api/src/lib/pty.ts` argues why a session is an allowlisted command
 * queue rather than a tty, and `apps/api/src/routes/terminal.ts` is the wire.
 * Read those first; this file is the thing that spawns a process, and it is
 * written on the assumption that everything upstream of it may be wrong.
 *
 * ── Why the allowlist is enforced twice ──────────────────────────────────────
 *
 * The server already validates the command and hands down an argv array. This
 * module validates it AGAIN, against its own copy of the table, and refuses
 * anything that does not match.
 *
 * That is not belt-and-braces politeness. The asymmetry is real: the server is
 * a program on our infrastructure that can be wrong — a bug in `parseCommand`,
 * a bad deploy, an operator with database access, a compromised API — and the
 * agent is the only component in the system that owns a shell on the
 * customer's network. A defence that exists in exactly one place is a defence
 * one bug away from gone, and the blast radius of that particular bug is
 * arbitrary code inside a network we were let into on the promise that this
 * could not happen. So the customer's own process gets the final say about
 * what runs on the customer's own machine, and the answer to "QAAI asked for
 * something outside the list" is a refusal the user can see, not an execution.
 *
 * The two tables are deliberate duplication and they will drift. Drift fails
 * CLOSED in the direction that matters: a command the server adds and the
 * agent does not know about is refused here with a message naming the agent as
 * the refuser, which is a support ticket. The reverse — the agent permitting
 * something the server never sends — cannot execute, because nothing else in
 * this process ever calls `runShellCommand`.
 *
 * ── No shell, ever ───────────────────────────────────────────────────────────
 *
 * `spawn(argv[0], argv.slice(1), { shell: false })`. There is no `sh -c`, no
 * string is ever interpolated into a command line, and no argv element is ever
 * joined. Shell metacharacters are therefore data: a filename containing `;`
 * is a filename, because nothing downstream of here parses it. The character
 * class below is a second fence in front of that, not the fence itself.
 *
 * ── What "bounded" means here ────────────────────────────────────────────────
 *
 * Wall clock, output bytes, and a kill that takes the process tree with it. The
 * last one is the one people get wrong: `child.kill()` on a process that has
 * forked signals the leader only, and a `npm ls` that spawned a resolver — or
 * an operator's `head` on a fifo — leaves children holding the workspace open
 * after the session that started them is gone. So the child is spawned into its
 * own process group and the GROUP is signalled.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import process from 'node:process';

/** What an agent must advertise before the server will open a session on it. */
export const TERMINAL_TOOLCHAIN = 'terminal';

export type OutputStream = 'stdout' | 'stderr';

/**
 * How a command's arguments are checked, mirroring `ArgRule` in lib/pty.ts.
 *
 * The rules here read the EXPANDED argv, not a typed line: the server has
 * already split the line, resolved the command and prepended its own fixed
 * flags (`ls` is always `ls -la`, `head` is always bounded at 200 lines). So
 * `prefix` is asserted to be present rather than added — an `ls` that arrives
 * without `-la` did not come from `parseCommand`, and that is precisely the
 * case this file exists to catch.
 */
type AgentRule =
  | { kind: 'none' }
  | { kind: 'literal'; allowed: readonly (readonly string[])[] }
  | { kind: 'paths'; prefix?: readonly string[]; max: number };

/**
 * The agent's own copy of the allowlist.
 *
 * Transcribed from `ALLOWED_COMMANDS` in apps/api/src/lib/pty.ts. Every entry
 * is a read; nothing here writes, fetches a URL, or prints the environment.
 * When you change one table, change the other — and note that the failure mode
 * of forgetting is a refusal, which is the safe half.
 */
export const AGENT_ALLOWED_COMMANDS: ReadonlyMap<string, AgentRule> = new Map<string, AgentRule>([
  ['node', { kind: 'literal', allowed: [['--version'], ['-v']] }],
  ['npm', { kind: 'literal', allowed: [['--version'], ['ls', '--depth=0']] }],
  ['npx', { kind: 'literal', allowed: [['playwright', '--version']] }],
  ['pwd', { kind: 'none' }],
  ['ls', { kind: 'paths', prefix: ['-la'], max: 4 }],
  ['cat', { kind: 'paths', max: 1 }],
  ['head', { kind: 'paths', prefix: ['-n', '200'], max: 1 }],
  ['tail', { kind: 'paths', prefix: ['-n', '200'], max: 1 }],
  ['uname', { kind: 'literal', allowed: [['-a']] }],
  ['df', { kind: 'literal', allowed: [['-h']] }],
  ['ps', { kind: 'literal', allowed: [['aux']] }],
  [
    'git',
    {
      kind: 'literal',
      allowed: [
        ['rev-parse', 'HEAD'],
        ['status', '--porcelain'],
        ['log', '-1', '--oneline'],
      ],
    },
  ],
]);

/** Most elements any allowlisted command can legitimately have. */
const MAX_ARGV_LENGTH = 8;

/** Longest single element. Longer than any real path in a test workspace. */
const MAX_ARG_CHARS = 256;

/**
 * The character class, copied from lib/pty.ts and for the same reason: a fixed
 * test, never a regex built from input. Note that a SPACE is absent — the argv
 * arrives already split, so an element containing one could not have come from
 * the server's parser.
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

/**
 * A workspace-relative path argument, or the reason it is refused.
 *
 * Same three rules as `checkPath` in lib/pty.ts, and the same reasoning: an
 * absolute path leaves the workspace outright, `..` leaves it a segment at a
 * time, and a leading `-` is read as an option by every binary in the table —
 * which is how `cat -v` would smuggle a flag past a rule that thinks it is
 * looking at a filename.
 *
 * This is the argument check, not a filesystem check. The agent does not
 * resolve the path against the workspace root the way `resolveWorkspacePath`
 * does for server-supplied test files, because the command's cwd IS the
 * workspace and a relative path with no `..` segment cannot address anything
 * above it. A symlink inside the workspace can, and that is the customer's own
 * workspace pointing at the customer's own filesystem, read by the customer's
 * own user — the same reach the test run already had.
 */
function checkPathArg(arg: string): string | null {
  if (arg.startsWith('/')) return 'a path must be relative to the run workspace';
  if (arg.startsWith('-')) return 'a path may not start with "-"';
  if (arg === '..' || arg.startsWith('../') || arg.includes('/../') || arg.endsWith('/..')) {
    return 'a path may not walk out of the run workspace with ".."';
  }
  if (arg.length > 200) return 'that path is too long';
  return null;
}

export type ArgvCheck = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether this agent will run this argv at all.
 *
 * Every refusal names what was refused rather than saying "not allowed",
 * because the user reading it on the panel needs to be able to tell a typo
 * from the far more interesting case: QAAI asking for something the agent's
 * own list does not contain.
 */
export function checkArgv(argv: readonly string[]): ArgvCheck {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { ok: false, reason: 'an empty command was sent' };
  }
  if (argv.length > MAX_ARGV_LENGTH) {
    return { ok: false, reason: `a command may have at most ${MAX_ARGV_LENGTH} arguments` };
  }

  for (const part of argv) {
    if (typeof part !== 'string' || part.length === 0) {
      return { ok: false, reason: 'a command may not contain an empty argument' };
    }
    if (part.length > MAX_ARG_CHARS) {
      return { ok: false, reason: 'an argument is longer than this agent will accept' };
    }
    for (const ch of part) {
      if (isSafeChar(ch)) continue;
      // Spelled with the codepoint because the offending character is often
      // invisible — a NUL, a newline, or a right-to-left override.
      return {
        ok: false,
        reason: `an argument contains U+${part.codePointAt(part.indexOf(ch))!
          .toString(16)
          .toUpperCase()
          .padStart(4, '0')}, which this agent will not pass to a process`,
      };
    }
  }

  const name = argv[0]!;
  const rule = AGENT_ALLOWED_COMMANDS.get(name);
  if (!rule) {
    return {
      ok: false,
      reason: `"${name}" is not on this agent's allowlist (${[...AGENT_ALLOWED_COMMANDS.keys()].join(', ')})`,
    };
  }

  const args = argv.slice(1);

  if (rule.kind === 'none') {
    if (args.length > 0) return { ok: false, reason: `${name} takes no arguments` };
    return { ok: true };
  }

  if (rule.kind === 'literal') {
    const matched = rule.allowed.some(
      (candidate) => candidate.length === args.length && candidate.every((part, i) => part === args[i]),
    );
    if (!matched) {
      const forms = rule.allowed.map((candidate) => `${name} ${candidate.join(' ')}`).join(', ');
      return { ok: false, reason: `${name} is accepted by this agent only as: ${forms}` };
    }
    return { ok: true };
  }

  const prefix = rule.prefix ?? [];
  if (args.length < prefix.length || prefix.some((part, i) => part !== args[i])) {
    return {
      ok: false,
      reason: `${name} must arrive as "${[name, ...prefix].join(' ')}" — this agent does not choose those flags and will not run it without them`,
    };
  }

  const paths = args.slice(prefix.length);
  if (paths.length > rule.max) {
    return { ok: false, reason: `${name} takes at most ${rule.max} path${rule.max === 1 ? '' : 's'}` };
  }
  for (const path of paths) {
    const problem = checkPathArg(path);
    if (problem) return { ok: false, reason: problem };
  }
  return { ok: true };
}

/**
 * Remove known secret VALUES from text on its way out of the building.
 *
 * Literal substring replacement over a fixed list — never a regex, and never
 * anything derived from what the process printed. Two things it is actually
 * for, both of which are real rather than theoretical:
 *
 *  - `ps aux` prints every command line on the host. The runner's own help text
 *    warns that `--token` on a command line is visible to every process on the
 *    machine; the terminal makes that warning reachable from our API by anyone
 *    with MEMBER, so the token is scrubbed rather than trusted to nobody having
 *    used the flag.
 *  - A test that echoes an injected secret into a file leaves it where `cat`
 *    can reach it, and the panel is not where a credential should be re-shown.
 *
 * Short values are skipped: replacing a two-character secret would carpet-bomb
 * ordinary output and hide more than it protects. Longest first, so a value
 * that contains another is not left half-replaced.
 */
export const MIN_REDACTABLE_LENGTH = 8;

/** The values `redactSecrets` will actually act on, longest first. */
function redactable(secrets: readonly string[]): string[] {
  return [
    ...new Set(
      secrets.filter(
        (value) => typeof value === 'string' && value.length >= MIN_REDACTABLE_LENGTH,
      ),
    ),
  ].sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const value of redactable(secrets)) {
    if (out.includes(value)) out = out.split(value).join('[redacted by the QAAI agent]');
  }
  return out;
}

/**
 * Redaction that survives a chunk boundary.
 *
 * `redactSecrets` on its own is only correct when it can see a whole secret at
 * once, and a stream cannot promise that. A pipe read lands wherever the
 * kernel put it: anything longer than a pipe buffer, or written by a process in
 * two `write` calls, arrives split — and a secret split across two reads was
 * passing through as two halves that reassemble perfectly in the browser. Each
 * half is unrecognisable to a substring search and the pair is the credential.
 * That is the exact scenario `redactSecrets` exists to prevent, so per-chunk
 * redaction was not a weaker version of the guarantee; it was none of it.
 *
 * The fix is a BOUNDARY WINDOW. Everything seen so far but not yet released is
 * redacted as one string, and the last `longest secret - 1` characters are held
 * back rather than released, because a secret that begins inside them cannot
 * yet be recognised. Any occurrence starting before that point is wholly
 * present and therefore already replaced; any occurrence starting at or after
 * it lies entirely inside what is still held. So one character of a secret can
 * never leave ahead of the rest, however the reads fall.
 *
 * With no eligible secrets the window is zero and text passes straight through
 * — the terminal is a live one, and holding output back for a session with
 * nothing to redact would buy latency for nothing.
 *
 * `flush()` releases the tail. It MUST be called when the stream ends, or the
 * last few characters of a command's output are silently eaten.
 */
export interface Redactor {
  push(text: string): string;
  flush(): string;
}

export function createRedactor(secrets: readonly string[]): Redactor {
  const values = redactable(secrets);
  const longest = values.reduce((max, value) => Math.max(max, value.length), 0);
  const window = longest > 0 ? longest - 1 : 0;

  let held = '';

  return {
    push(text: string): string {
      if (window === 0) return redactSecrets(text, values);
      if (!text) return '';
      const pending = redactSecrets(held + text, values);
      const keep = Math.min(pending.length, window);
      held = pending.slice(pending.length - keep);
      return pending.slice(0, pending.length - keep);
    },
    flush(): string {
      if (!held) return '';
      const tail = redactSecrets(held, values);
      held = '';
      return tail;
    },
  };
}

/**
 * At most `maxBytes` of `text`, cut on a character boundary.
 *
 * Same fix, and the same reason, as `sliceUtf8` in lib/pty.ts: cutting a buffer
 * mid-codepoint decodes the tail as U+FFFD, so a truncated log ends in a
 * replacement character that reads as corruption in the customer's own program
 * rather than as our limit.
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
 * Characters per POST.
 *
 * The server bounds one chunk at 64Ki characters and the whole body at 2MB.
 * JSON escaping is what decides this number rather than either of those: test
 * output is full of ANSI escapes, and every control character costs six
 * characters once encoded. At 16k characters a chunk is at most ~200KB on the
 * wire however hostile its contents, which is nowhere near either cap.
 */
const CHUNK_CHARS = 16_000;

/** How long a process gets to die politely before it is killed outright. */
const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * How long we keep waiting for `close` after a SIGKILL to the group.
 *
 * A process in uninterruptible sleep — an NFS mount that went away is the
 * classic one — cannot be killed at all, and something has to give up so the
 * session is not held by a command that will never end. The child is
 * abandoned, loudly, rather than silently waited on forever.
 */
const REAP_TIMEOUT_MS = 5_000;

export type CommandEnding =
  | 'exit'
  | 'refused'
  | 'not-installed'
  | 'spawn-failed'
  | 'timeout'
  | 'output-cap'
  | 'aborted'
  /** The far end stopped accepting output, so the command was killed. */
  | 'sink-closed'
  | 'abandoned';

export interface ShellCommandOutcome {
  /** What to report to the server. `null` whenever the process did not choose it. */
  exitCode: number | null;
  ended: CommandEnding;
  bytes: number;
  truncated: boolean;
  /** The sentence already emitted on stderr, kept for the agent's own log. */
  notice: string | null;
}

export interface ShellCommandRequest {
  argv: readonly string[];
  /** The run's workspace. The command sees exactly what the test saw. */
  cwd: string;
  /** Already stripped of the run's injected secrets by the caller. */
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Values scrubbed from output. See `redactSecrets`. */
  redact?: readonly string[];
  /**
   * Ship a chunk. Awaited, so output cannot outrun the upload and pile up in
   * this process's heap — the queue on a chatty command is bounded by the
   * output cap either way, but the backpressure is what keeps memory flat.
   *
   * Returning `'stop'` means the far end has stopped accepting (the session was
   * closed, or the server hit its own cap) and the command is killed — process
   * group and all — rather than left running to produce output with no reader.
   * A thrown error is treated the same way.
   */
  onOutput: (stream: OutputStream, chunk: string) => Promise<void | 'stop'> | void | 'stop';
  /** Stopping the agent, or losing the job, kills whatever is running. */
  signal?: AbortSignal;
  killGraceMs?: number;
}

/**
 * Signal a process and everything it started.
 *
 * On POSIX the child was spawned `detached`, which gives it a process group of
 * its own; a negative pid signals that whole group, so a command that forked is
 * not left with orphans holding the workspace open. Windows has no process
 * groups to signal, so `taskkill /T` is the equivalent, and it is spawned
 * without a shell like everything else here.
 *
 * Exported for its test. The allowlist has nothing in it that forks, so the
 * only way to prove the GROUP is signalled — rather than just the leader — is
 * to point this at a process that has children and check the children died.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  // pid 1 and 0 are the init process and "my own group". Signalling either
  // because a spawn failed would be a self-inflicted outage.
  if (!pid || pid <= 1) return;

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        shell: false,
      });
      killer.on('error', () => {});
      killer.unref();
    } catch {
      // Nothing further to try; the reap timeout below is the backstop.
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone, or the spawn never got far enough to
    // make one. Fall back to the child itself, which may still exist.
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
  }
}

/**
 * Run one allowlisted command to completion, or kill it trying.
 *
 * Returns rather than throws for every outcome a user could cause, because
 * every one of them has a sentence the panel should show — a refusal, a missing
 * binary and a timeout are three different things to do about it, and
 * "something went wrong" is the message that sends someone to support.
 */
export async function runShellCommand(request: ShellCommandRequest): Promise<ShellCommandOutcome> {
  const redact = request.redact ?? [];
  const cap = Math.max(0, Math.trunc(request.maxOutputBytes));
  const timeoutMs = Math.max(1_000, Math.trunc(request.timeoutMs));

  let bytes = 0;
  let truncated = false;
  let sinkClosed = false;
  /** Serialises the uploads; each chunk waits for the one before it. */
  let chain: Promise<void> = Promise.resolve();

  /*
   * Set once the process exists, because that is the first moment there is
   * anything to kill. `emit` runs before then — a refused argv and a failed
   * spawn both report through it — and reaching a `const` declared further down
   * this function from inside that path would be a temporal-dead-zone throw on
   * the one code path with no process to signal anyway.
   */
  let onSinkClosed: (() => void) | null = null;

  const closeSink = (): void => {
    if (sinkClosed) return;
    sinkClosed = true;
    onSinkClosed?.();
  };

  const emit = (stream: OutputStream, text: string): void => {
    if (!text) return;
    chain = chain.then(async () => {
      if (sinkClosed) return;
      try {
        const verdict = await request.onOutput(stream, text);
        if (verdict === 'stop') closeSink();
      } catch {
        // The channel is broken — the session was closed, or the API went
        // away. Dropping the rest is right: there is nobody to show it to, and
        // retrying a chunk of a terminal nobody is watching is not worth a
        // round trip. The command is still killed and still reported.
        closeSink();
      }
    });
  };

  const check = checkArgv(request.argv);
  if (!check.ok) {
    const notice =
      `qaai: this agent refused to run the command it was sent — ${check.reason}. ` +
      `The agent enforces its own allowlist independently of the server.\n`;
    emit('stderr', notice);
    await chain;
    return { exitCode: null, ended: 'refused', bytes: 0, truncated: false, notice };
  }

  const shown = request.argv.join(' ');

  let child: ChildProcess;
  try {
    child = spawn(request.argv[0]!, request.argv.slice(1), {
      cwd: request.cwd,
      env: request.env,
      // The three properties this whole file rests on: no shell parses
      // anything, stdin is closed so nothing can block waiting for a keystroke
      // that cannot arrive, and the child leads its own process group so the
      // kill below reaches its children.
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    const notice = `qaai: could not start "${shown}": ${err instanceof Error ? err.message : String(err)}\n`;
    emit('stderr', notice);
    await chain;
    return { exitCode: null, ended: 'spawn-failed', bytes: 0, truncated: false, notice };
  }

  let ending: CommandEnding = 'exit';
  let notice: string | null = null;
  let killing = false;

  const stop = (reason: CommandEnding, message: string | null): void => {
    if (killing) return;
    killing = true;
    ending = reason;
    if (message) {
      notice = message;
      emit('stderr', message);
    }
    killTree(child, 'SIGTERM');
    const hard = setTimeout(() => killTree(child, 'SIGKILL'), request.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    hard.unref?.();
  };

  /*
   * The kill-on-stop half of `onOutput`'s contract.
   *
   * The docs on `ShellCommandRequest.onOutput` have always said that returning
   * `'stop'` kills the command; only the "stop sending" half was implemented,
   * so a `cat` on a huge file whose session had closed went on reading it to
   * the end on the customer's build host, with nobody left to show it to. The
   * notice is recorded for the agent's own log and deliberately not emitted:
   * the thing that would have displayed it is precisely the thing that just
   * said it has stopped accepting output.
   */
  onSinkClosed = (): void => {
    if (killing) return;
    stop('sink-closed', null);
    notice =
      `qaai: "${shown}" was stopped because the far end stopped accepting its output — ` +
      `the session was closed, or the server hit its own cap.\n`;
  };

  /*
   * One redactor per stream, and per stream is the point: stdout and stderr are
   * separate pipes whose reads interleave arbitrarily, so a single shared window
   * would splice one stream's tail onto the other's head and invent matches
   * that were never written next to each other.
   */
  const redactors: Record<OutputStream, Redactor> = {
    stdout: createRedactor(redact),
    stderr: createRedactor(redact),
  };

  /** Send text that has already been through the redactor. */
  const release = (stream: OutputStream, redacted: string): void => {
    if (truncated || !redacted) return;
    // The cap is applied to what redaction produced, so what is counted is what
    // is actually sent.
    let text = redacted;
    const size = Buffer.byteLength(text, 'utf8');

    if (bytes + size > cap) {
      text = sliceUtf8(text, Math.max(0, cap - bytes));
      truncated = true;
    }
    bytes += Buffer.byteLength(text, 'utf8');

    for (let i = 0; i < text.length; i += CHUNK_CHARS) emit(stream, text.slice(i, i + CHUNK_CHARS));

    if (truncated) {
      stop(
        'output-cap',
        `\nqaai: "${shown}" produced more than ${Math.round(cap / 1024)} KB of output, ` +
          `so it was stopped here. The rest was never sent.\n`,
      );
    }
  };

  const deliver = (stream: OutputStream, raw: string): void => {
    if (truncated || !raw) return;
    release(stream, redactors[stream].push(raw));
  };

  /**
   * Release the boundary window each redactor is still holding.
   *
   * Called once the process is over, from every path that ends it. Skipping it
   * would swallow the last few characters of the command's output — which,
   * since the window is only ever as long as the longest secret, is exactly the
   * kind of loss nobody would attribute to redaction.
   */
  const flushRedactors = (): void => {
    for (const stream of ['stdout', 'stderr'] as const) {
      release(stream, redactors[stream].flush());
    }
  };

  const decoders: Record<OutputStream, StringDecoder> = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };

  const attach = (stream: OutputStream): void => {
    // Incremental decoding, not `chunk.toString()`: a pipe read can land in the
    // middle of a multi-byte character, and per-chunk decoding turns that into
    // a pair of replacement characters in the middle of otherwise fine output.
    child[stream]?.on('data', (buf: Buffer) => deliver(stream, decoders[stream].write(buf)));
  };
  attach('stdout');
  attach('stderr');

  const timer = setTimeout(() => {
    stop(
      'timeout',
      `\nqaai: "${shown}" was still running after ${Math.round(timeoutMs / 1000)}s and was killed, ` +
        `along with anything it started.\n`,
    );
  }, timeoutMs);
  timer.unref?.();

  const onAbort = (): void => {
    stop(
      'aborted',
      `\nqaai: "${shown}" was stopped because this runner is no longer holding the job it was ` +
        `opened on.\n`,
    );
  };
  request.signal?.addEventListener('abort', onAbort, { once: true });
  if (request.signal?.aborted) onAbort();

  const outcome = await new Promise<{ code: number | null; ending: CommandEnding }>((settle) => {
    let settled = false;
    const finish = (code: number | null, how: CommandEnding): void => {
      if (settled) return;
      settled = true;
      settle({ code, ending: how });
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        notice = `qaai: "${request.argv[0]}" is not installed on this runner host, so it could not be run.\n`;
        ending = 'not-installed';
      } else {
        notice = `qaai: "${shown}" could not be run: ${err.message}\n`;
        ending = 'spawn-failed';
      }
      emit('stderr', notice);
      finish(null, ending);
    });

    child.on('close', (code) => {
      // The decoders may be holding the tail of a split character.
      deliver('stdout', decoders.stdout.end());
      deliver('stderr', decoders.stderr.end());
      finish(code, ending);
    });

    /*
     * The backstop for a process that cannot be killed. `close` waits for the
     * stdio pipes as well as the exit, so an unkillable child — or one whose
     * grandchild inherited the pipe and is itself stuck — would otherwise hold
     * this promise, and with it the session's only execution slot, forever.
     */
    const reaper = setTimeout(() => {
      if (!killing) return;
      notice =
        `\nqaai: "${shown}" did not die when it was killed and has been abandoned by the agent. ` +
        `It may still be running on this host.\n`;
      emit('stderr', notice);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(null, 'abandoned');
    }, timeoutMs + REAP_TIMEOUT_MS);
    reaper.unref?.();
  });

  clearTimeout(timer);
  request.signal?.removeEventListener('abort', onAbort);
  // After the process is over and before the uploads are awaited: every ending
  // — a clean exit, a kill, an unkillable child — comes through here, so this
  // is the one place the boundary window is guaranteed to be emptied.
  flushRedactors();
  await chain;

  /*
   * A signalled process reports `null`, and `null` is what the server is told.
   *
   * The tempting alternative is the shell convention of 128+signal — 137 for a
   * SIGKILL — and it would be a lie: nothing exited with 137, we killed it, and
   * a number in the exit column reads as the program's own verdict. The stderr
   * notice above says what happened instead. The clamp is defensive: the exit
   * endpoint validates -1..255 and a 400 there would leave the panel with a
   * command that never finishes.
   */
  const exitCode =
    typeof outcome.code === 'number' && Number.isFinite(outcome.code)
      ? Math.max(-1, Math.min(255, Math.trunc(outcome.code)))
      : null;

  return { exitCode, ended: outcome.ending, bytes, truncated, notice };
}
