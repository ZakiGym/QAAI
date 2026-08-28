/**
 * A shell on a run — the wire.
 *
 * Read `apps/api/src/lib/pty.ts` first; it carries the argument for why this is
 * an allowlisted command channel rather than a pty, and the two architectural
 * facts that decide it (our worker container is shared across tenants; a
 * customer's runner is never dialed, only answered). This file is the transport
 * and the authorisation around that.
 *
 * ── Two audiences, deliberately separated ────────────────────────────────────
 *
 *  - `/terminal/agent/*` is spoken by the agent inside the customer's network.
 *    It authenticates with a runner token and presents the fencing lease for
 *    the job it holds, exactly as `/runners/agent/*` does. It cannot open a
 *    session, cannot name a run, and cannot ask about any session that was not
 *    bound to its own runner id at open time.
 *  - Everything else is the cockpit: session cookie or API key, tenant-scoped,
 *    role-gated, audited.
 *
 * As in routes/runners.ts, the agent half is mounted first and terminates its
 * own 404s, so a malformed agent path cannot fall through into the user half
 * and be answered with a 401 that implies the route exists.
 *
 * ── Transport: SSE down, POST up ─────────────────────────────────────────────
 *
 * This reuses the mechanism the cockpit already streams runs over (see
 * `lib/events.ts` and `GET /runs/:runId/events`) rather than adding a websocket
 * stack. A websocket would be justified if the shell needed bidirectional
 * framing on one connection, and it does not — because the agent is not
 * connected to us at all. It polls. Input therefore cannot travel down a socket
 * to the executing host no matter what socket we open; it waits for the next
 * poll either way. Adding a second real-time stack to move a keystroke into a
 * queue the agent drains would buy latency we cannot spend and cost a whole new
 * class of connection bugs.
 *
 * ── Why MEMBER ───────────────────────────────────────────────────────────────
 *
 * MEMBER is the same gate as `POST /runs` — starting a run. A session here can
 * only run commands the allowlist permits, on a machine the org already chose
 * to execute its suite on, in a workspace that suite already created. That is
 * strictly less than the run itself did, so requiring more than the run
 * required would be theatre. VIEWER is excluded because a VIEWER is read-only
 * on QAAI's data and this is execution on the customer's infrastructure —
 * different kind of thing, not a smaller amount of the same thing. ADMIN would
 * be wrong in the other direction: the person who needs to know why a test
 * failed is the person who wrote it, and a debugging tool only admins can open
 * is a debugging tool nobody uses.
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { prisma, unscoped, withTenant } from '../lib/prisma.js';
import { hashToken } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, unauthorized, unprocessable } from '../lib/errors.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import {
  RUNNER_HEARTBEAT_MS,
  looksLikeRunnerToken,
  parseCapabilities,
  requireLease,
} from '../lib/runners.js';
import {
  TERMINAL_CAPABILITY,
  TERMINAL_COMMAND_TIMEOUT_MS,
  TERMINAL_MAX_OUTPUT_BYTES,
  TERMINAL_MAX_SESSIONS_PER_ORG,
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
  sessionLimits,
  sessionsForOrg,
  subscribe,
  sweep,
  touch,
} from '../lib/pty.js';
import type { TerminalEvent, TerminalSession } from '../lib/pty.js';

export const terminalRouter: Router = Router();
const agentRouter: Router = Router();

/** The fencing token, spelled exactly as routes/runners.ts spells it. */
const LEASE_HEADER = 'x-qaai-lease';

/**
 * The session key, in a header rather than the URL.
 *
 * A key in a query string is a key in the access log, the browser history and
 * every Referer the page ever sends. The SSE stream below therefore does NOT
 * take one — EventSource cannot set headers, and rather than smuggle the key
 * through the URL, the stream is authorised by the caller's own session plus
 * ownership of the terminal session. The key guards the two calls that act
 * (run a command, kill), which is where it earns its keep.
 */
const KEY_HEADER = 'x-qaai-terminal-key';

/** Statuses in which a runner job is actually holding a machine for us. */
const HELD_JOB = ['CLAIMED', 'RUNNING'] as const;

// ─── Agent authentication ────────────────────────────────────────────────────

interface RunnerActor {
  id: string;
  orgId: string;
  name: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    terminalRunner?: RunnerActor;
  }
}

/**
 * Resolve a runner token, or refuse.
 *
 * This is a narrowed copy of `requireRunner` in routes/runners.ts, which is
 * private to that module. It is duplicated rather than exported-and-shared for
 * one release only: `requireRunner` also stamps `lastSeenAt` and parses
 * capabilities onto the request, neither of which this router wants, and
 * widening its export surface is the parent's call rather than this group's.
 * If the two ever drift, THIS one is the copy and should be deleted in favour
 * of the original — a second implementation of token authentication is a second
 * place for it to be wrong.
 *
 * The reasoning it inherits verbatim: a runner is not a user. It gets no
 * ActorContext, no role and no membership, so it is never one `requireRole`
 * mistake away from the rest of the API. `unscoped` on the lookup is necessary
 * because no tenant is in scope until the token says which org this is; every
 * query after it runs inside `withTenant`.
 */
async function requireRunner(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const raw = header?.startsWith('Bearer ')
    ? header.slice(7).trim()
    : typeof req.headers['x-runner-token'] === 'string'
      ? req.headers['x-runner-token'].trim()
      : '';

  if (!raw || !looksLikeRunnerToken(raw)) {
    next(unauthorized('A runner token is required'));
    return;
  }

  const runner = await unscoped(() =>
    prisma.runner.findUnique({
      where: { tokenHash: hashToken(raw) },
      select: { id: true, orgId: true, name: true, revokedAt: true },
    }),
  );

  // Revoked reads exactly like unknown, so a revoked token cannot confirm it
  // was ever real.
  if (!runner || runner.revokedAt) {
    next(unauthorized('That runner token is not valid'));
    return;
  }

  req.terminalRunner = { id: runner.id, orgId: runner.orgId, name: runner.name };
  void withTenant(runner.orgId, () => next());
}

function runnerOf(req: Request): RunnerActor {
  if (!req.terminalRunner) throw unauthorized('A runner token is required');
  return req.terminalRunner;
}

function leaseOf(req: Request): string {
  const lease = req.headers[LEASE_HEADER];
  const value = typeof lease === 'string' ? lease.trim() : '';
  if (!value) throw badRequest(`Send the lease you were given in the ${LEASE_HEADER} header`);
  return value;
}

agentRouter.use(requireRunner);

// ─── Agent: pick up work for a session ───────────────────────────────────────

/**
 * "Is anyone shelled into the job I am holding?"
 *
 * The agent asks about its own job id and presents its own lease; it never
 * names a session, an org or a run. `requireLease` re-asserts that this runner
 * still holds this job before anything is handed over, which means a runner
 * whose VM was paused and has since lost the work cannot pick up commands for a
 * session that now belongs to somebody else's execution.
 *
 * Answering with `null` is the normal case and must stay cheap: an agent
 * holding a job polls this alongside its heartbeat, and almost no run ever has
 * a shell open on it.
 */
agentRouter.post('/jobs/:jobId/next', async (req, res) => {
  const runner = runnerOf(req);
  const job = await requireLease(String(req.params.jobId), leaseOf(req));

  const now = Date.now();
  sweep(now);

  /*
   * A session on this job that belongs to a DIFFERENT runner is provably
   * orphaned: this caller passed `requireLease`, so it is the one holding the
   * job now, and the machine the session was opened against has lost it — to a
   * reap, a restart, or a paused VM. The container that session points at is
   * gone. Closing it here is the only moment we learn that, because nothing
   * else in the system tells the API a job changed hands, and the alternative
   * is a user watching a live-looking prompt swallow commands until the idle
   * timeout.
   *
   * It is emphatically NOT handed to the new runner. The workspace, the
   * environment and the processes are different ones.
   */
  for (const orphan of sessionsForOrg(runner.orgId, now)) {
    if (orphan.jobId === job.id && orphan.runnerId !== runner.id) {
      killSession(
        orphan.id,
        'The runner this session was opened on lost the job; another machine is running it now.',
        now,
      );
    }
  }

  const session = sessionsForOrg(runner.orgId, now).find(
    (candidate) => candidate.jobId === job.id && candidate.runnerId === runner.id,
  );
  if (!session) {
    res.json({ session: null, command: null, pollSeconds: Math.round(RUNNER_HEARTBEAT_MS / 1000) });
    return;
  }

  const command = claimNextCommand(session, now);
  res.json({
    session: { id: session.id, expiresAt: new Date(session.expiresAt).toISOString() },
    command: command
      ? {
          id: command.id,
          /*
           * argv, never a string. The agent must spawn this without a shell —
           * it is already an array so there is nothing for it to re-split, and
           * every element was validated against the allowlist here.
           */
          argv: command.argv,
          timeoutSeconds: Math.round(TERMINAL_COMMAND_TIMEOUT_MS / 1000),
          maxOutputBytes: TERMINAL_MAX_OUTPUT_BYTES,
        }
      : null,
    pollSeconds: Math.round(RUNNER_HEARTBEAT_MS / 1000),
  });
});

const outputSchema = z.object({
  stream: z.enum(['stdout', 'stderr']),
  // Bounded here as well as by the byte cap: one call must not be able to hand
  // us a 64MB string to measure before we refuse it.
  chunk: z.string().max(64 * 1024),
});

/**
 * Output from a command, on its way to whoever is watching.
 *
 * The session is found from the command id and then re-checked against THIS
 * runner — a second agent in the same org, holding a perfectly valid runner
 * token, cannot write into a session bound to a different machine.
 */
agentRouter.post('/jobs/:jobId/commands/:commandId/output', async (req, res) => {
  const runner = runnerOf(req);
  await requireLease(String(req.params.jobId), leaseOf(req));
  const input = outputSchema.parse(req.body ?? {});

  const { session, command } = await commandForRunner(req, runner);
  appendOutput(session, command, input.stream, input.chunk);
  res.json({ ok: true, truncated: command.truncated });
});

const exitSchema = z.object({
  exitCode: z.number().int().min(-1).max(255).nullable(),
});

agentRouter.post('/jobs/:jobId/commands/:commandId/exit', async (req, res) => {
  const runner = runnerOf(req);
  await requireLease(String(req.params.jobId), leaseOf(req));
  const input = exitSchema.parse(req.body ?? {});

  const { session, command } = await commandForRunner(req, runner);
  finishCommand(session, command, input.exitCode);
  res.json({ ok: true });
});

/** Shared resolution for the two agent write paths. */
async function commandForRunner(req: Request, runner: RunnerActor) {
  const commandId = String(req.params.commandId);
  const sessionId = sessionIdForCommand(commandId);
  if (!sessionId) throw notFound('Command');

  const lookup = sessionForRunner({ sessionId, orgId: runner.orgId, runnerId: runner.id });
  if (!lookup.ok) throw notFound('Command');

  /*
   * The lease is for the job in the URL; this asserts the SESSION is too.
   *
   * Both callers `requireLease(req.params.jobId, …)` first, which proves the
   * runner still holds THAT job — but not that the session it is writing into
   * belongs to it. A runner holding two jobs that has LOST the first (reaped,
   * or reclaimed by another worker) could present its still-valid lease for the
   * second and post output, or an exit code, into a session bound to the first:
   * fabricated output in a terminal pointed at a container it no longer has.
   *
   * Same org and same runner throughout, so nothing crosses a tenant boundary —
   * but the file's own comment claims requireLease "re-asserts that this runner
   * still holds this job", and without this line that is only true of the job
   * the caller named, not of the one the session is about.
   */
  if (lookup.session.jobId !== String(req.params.jobId)) throw notFound('Command');

  const command = findCommand(lookup.session, commandId);
  if (!command) throw notFound('Command');
  return { session: lookup.session, command };
}

agentRouter.use((_req, _res, next) => next(notFound('Terminal endpoint')));

terminalRouter.use('/agent', agentRouter);

// ─── The cockpit half ────────────────────────────────────────────────────────

terminalRouter.use(requireAuth);

/**
 * Open a shell on a run.
 *
 * Every refusal below names its reason, because each of them is a different
 * situation with a different thing to do about it, and "could not open a
 * terminal" is the message that sends someone to support.
 */
terminalRouter.post('/runs/:runId/sessions', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const now = Date.now();

  // Tenant-scoped by the ambient `withTenant` opened in requireAuth — there is
  // deliberately no orgId in this where. Another org's run reads as not found.
  const run = await prisma.run.findUnique({
    where: { id: String(req.params.runId) },
    select: { id: true, status: true, runnerPool: true, projectId: true },
  });
  if (!run) throw notFound('Run');

  if (!run.runnerPool) {
    /*
     * The cloud path, refused outright. This run executed in QAAI's own worker
     * container, which drains a queue shared by every organisation in the
     * deployment and holds the vault master key — a shell in it is a shell over
     * every other customer. There is no per-run container to attach to instead.
     * Said plainly rather than as "not supported", because the honest answer
     * tells the reader what to do: run the suite on your own runners.
     */
    throw unprocessable(
      'This run executed on QAAI’s shared workers, where there is no per-run container to ' +
        'attach a shell to. Point this environment at your own runner pool and a session can be ' +
        'opened on the machine that actually runs the tests.',
    );
  }

  const job = await prisma.runnerJob.findFirst({
    where: { runId: run.id, status: { in: [...HELD_JOB] } },
    orderBy: { claimedAt: 'desc' },
    select: { id: true, runnerId: true, leaseExpiresAt: true, status: true },
  });

  /*
   * The constraint this whole feature is shaped around, enforced rather than
   * described: a session can only exist while a runner is holding the job. Once
   * the lease lapses the workspace, the environment and the processes are gone,
   * and a shell opened against that would answer questions about a machine in a
   * different state — which is worse than no shell at all.
   */
  if (!job || !job.runnerId) {
    throw unprocessable(
      'No runner is holding this run right now, so there is no live container to open a shell in. ' +
        'A terminal session exists only while the run is executing.',
    );
  }
  if (job.leaseExpiresAt && job.leaseExpiresAt.getTime() <= now) {
    throw unprocessable(
      'The runner holding this run has gone silent and its lease has expired. Whatever it was ' +
        'running is no longer reachable.',
    );
  }

  const runner = await prisma.runner.findUnique({
    where: { id: job.runnerId },
    select: { id: true, name: true, capabilities: true, agentVersion: true, revokedAt: true },
  });
  if (!runner || runner.revokedAt) throw unprocessable('That runner has been revoked.');

  /*
   * The capability gate, and the reason this feature is not a lie today.
   *
   * The agent in packages/cli does not yet poll for terminal commands. Until it
   * advertises the capability, opening a session would produce a prompt that
   * accepts input and streams nothing back forever — a shell-shaped thing that
   * is not a shell. So the refusal happens at the door, and it names the
   * upgrade rather than the internal reason.
   */
  const capabilities = parseCapabilities(runner.capabilities);
  if (!capabilities.toolchains.includes(TERMINAL_CAPABILITY)) {
    throw unprocessable(
      `The runner "${runner.name}" does not support terminal sessions. Upgrade the QAAI agent on ` +
        'that host; it advertises the "terminal" capability once it can pick up shell commands.',
    );
  }

  if (countOpenSessions(actor.orgId, now) >= TERMINAL_MAX_SESSIONS_PER_ORG) {
    throw unprocessable(
      `Your organisation already has ${TERMINAL_MAX_SESSIONS_PER_ORG} terminal sessions open. ` +
        'Close one before opening another.',
    );
  }

  const { session, key } = openSession({
    orgId: actor.orgId,
    runId: run.id,
    jobId: job.id,
    // Resolved from the job, on the server. Nothing the client sent chose this
    // host, and there is no request field through which it could.
    runnerId: job.runnerId,
    userId: actor.userId,
    now,
  });

  await audit({
    actor,
    action: 'terminal.session.opened',
    targetType: 'Run',
    targetId: run.id,
    metadata: {
      sessionId: session.id,
      runnerId: runner.id,
      runnerName: runner.name,
      jobId: job.id,
      expiresAt: new Date(session.expiresAt).toISOString(),
    },
  });

  res.status(201).json({
    session: {
      id: session.id,
      runId: run.id,
      runnerName: runner.name,
      openedAt: new Date(session.openedAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
    },
    // Once. It is never returned again and never written down in plaintext.
    key,
    limits: sessionLimits(),
    allowlist: describeAllowlist(),
  });
});

/** Turn a lookup refusal into the response the user should see. */
function refuse(refusal: 'not-found' | 'expired' | 'idle' | 'bad-key' | 'wrong-user'): never {
  if (refusal === 'expired') {
    throw unprocessable('That terminal session has reached its time limit and has been closed.');
  }
  if (refusal === 'idle') {
    throw unprocessable('That terminal session was closed after being idle.');
  }
  // A key that does not match, and a session belonging to someone else, are
  // both answered as not-found. Distinguishing them would tell a caller which
  // session ids are real.
  throw notFound('Terminal session');
}

function requireKey(req: Request): string {
  const raw = req.headers[KEY_HEADER];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw badRequest(`Send the session key in the ${KEY_HEADER} header`);
  return value;
}

/**
 * Live output.
 *
 * Same shape as `GET /runs/:runId/events`: headers written immediately, a retry
 * hint, a keepalive under the 60s most proxies drop an idle stream at.
 */
terminalRouter.get('/sessions/:sessionId/stream', requireRole('MEMBER'), (req, res) => {
  const actor = actorOf(req);
  const lookup = resolveSession({
    sessionId: String(req.params.sessionId),
    orgId: actor.orgId,
    userId: actor.userId,
  });
  if (!lookup.ok) refuse(lookup.refusal);
  const session = lookup.session;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const write = (event: TerminalEvent): void => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  const unsubscribe = subscribe(session, write);

  /*
   * A stream that opens is itself activity. Without this a user watching a long
   * command — or simply reading what came back — has their session reaped by
   * the idle sweep while they are looking at it.
   */
  const keepalive = setInterval(() => {
    touch(session);
    res.write(': keepalive\n\n');
  }, 20_000);

  req.on('close', () => {
    clearInterval(keepalive);
    unsubscribe();
  });
});

const runSchema = z.object({ command: z.string().max(1024) });

/**
 * Run one command.
 *
 * The audit row is written BEFORE the command is queued and records the parsed
 * argv rather than the typed line, so what is logged is exactly what will be
 * executed. "Who opened a shell on what, when" is the question this feature
 * has to be able to answer under scrutiny, and an audit written afterwards is
 * an audit that a crash loses.
 */
terminalRouter.post('/sessions/:sessionId/commands', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const key = requireKey(req);
  const input = runSchema.parse(req.body ?? {});

  const lookup = resolveSession({
    sessionId: String(req.params.sessionId),
    orgId: actor.orgId,
    userId: actor.userId,
    key,
  });
  if (!lookup.ok) refuse(lookup.refusal);
  const session = lookup.session;

  /*
   * Re-check that the machine is still there, on every command.
   *
   * The session was opened against a live-leased job, but that was up to ten
   * minutes ago and a runner can die at any point in between. Nothing pushes
   * that fact to the API — a runner behind a firewall that stops breathing
   * gives us no signal at all (see lib/runners.ts), so the absence of one is
   * not evidence. One indexed read per typed command is the price of telling
   * the user "the runner is gone" instead of queueing a command into a session
   * nothing will ever poll.
   */
  const job = await prisma.runnerJob.findFirst({
    where: { id: session.jobId, runnerId: session.runnerId, status: { in: [...HELD_JOB] } },
    select: { id: true, leaseExpiresAt: true },
  });
  if (!job || (job.leaseExpiresAt && job.leaseExpiresAt.getTime() <= Date.now())) {
    killSession(
      session.id,
      'The runner holding this run stopped, so there is nothing left to run commands on.',
    );
    throw unprocessable(
      'The runner holding this run has stopped. A terminal session exists only while the run is ' +
        'executing, so this one has been closed.',
    );
  }

  const parsed = parseCommand(input.command);
  if (!parsed.ok) {
    // A refusal is still an attempt, and an attempt to run something outside
    // the allowlist is the single most interesting line in this audit log.
    await audit({
      actor,
      action: 'terminal.command.refused',
      targetType: 'Run',
      targetId: session.runId,
      metadata: { sessionId: session.id, attempted: input.command.slice(0, 256), reason: parsed.reason },
    });
    throw badRequest(parsed.reason);
  }

  await audit({
    actor,
    action: 'terminal.command',
    targetType: 'Run',
    targetId: session.runId,
    metadata: { sessionId: session.id, runnerId: session.runnerId, argv: parsed.argv },
  });

  const queued = enqueueCommand(session, parsed.argv);
  if (!queued.ok) throw unprocessable(queued.reason);

  res.status(202).json({
    command: { id: queued.command.id, argv: queued.command.argv, status: queued.command.status },
    expiresAt: new Date(session.expiresAt).toISOString(),
  });
});

/**
 * Close a session.
 *
 * Killable by the person who opened it, and by any ADMIN in the org — a
 * command channel into the customer's own network that only its opener can
 * close is one an administrator cannot stop. The ADMIN path is why this looks
 * the session up by id first and checks ownership second.
 */
terminalRouter.delete('/sessions/:sessionId', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const sessionId = String(req.params.sessionId);

  const session = sessionsForOrg(actor.orgId).find((candidate) => candidate.id === sessionId);
  if (!session) throw notFound('Terminal session');

  const isOwner = session.userId === actor.userId;
  const isAdmin = actor.role === 'ADMIN' || actor.role === 'OWNER';
  if (!isOwner && !isAdmin) throw notFound('Terminal session');
  // An owner must still present the key; an administrator overriding somebody
  // else's session is doing something different and is audited as such.
  if (isOwner && !isAdmin) {
    const lookup = resolveSession({
      sessionId,
      orgId: actor.orgId,
      userId: actor.userId,
      key: requireKey(req),
    });
    if (!lookup.ok) refuse(lookup.refusal);
  }

  await audit({
    actor,
    action: isOwner ? 'terminal.session.closed' : 'terminal.session.killed',
    targetType: 'Run',
    targetId: session.runId,
    metadata: {
      sessionId: session.id,
      openedBy: session.userId,
      runnerId: session.runnerId,
      commands: session.commands.length,
    },
  });

  killSession(sessionId, isOwner ? 'You closed this session' : 'An administrator closed this session');
  res.json({ closed: true });
});

/** Every open session in the org — what an administrator kills from. */
terminalRouter.get('/sessions', requireRole('ADMIN'), (req, res) => {
  const actor = actorOf(req);
  res.json({
    sessions: sessionsForOrg(actor.orgId).map((session: TerminalSession) => ({
      id: session.id,
      runId: session.runId,
      runnerId: session.runnerId,
      openedBy: session.userId,
      openedAt: new Date(session.openedAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      commands: session.commands.length,
    })),
  });
});

/**
 * What a session may run, readable without opening one.
 *
 * The allowlist is a security boundary, and a security boundary the customer
 * cannot read is one they have to take on trust.
 */
terminalRouter.get('/allowlist', (_req, res) => {
  res.json({ allowlist: describeAllowlist(), limits: sessionLimits() });
});

terminalRouter.use((_req, _res, next) => next(notFound('Terminal endpoint')));
