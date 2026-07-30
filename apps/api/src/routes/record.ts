/**
 * Record mode (§C) — the marquee feature: click through your app, get a test.
 *
 * The recorder opens a real browser window, so it runs on the host that has a
 * screen — the desktop app or local dev — not on a headless worker. The API is
 * that host in both cases, so it spawns codegen directly and tracks the session
 * in memory rather than through the queue.
 *
 * Lifecycle: start → the user clicks through their app → they close the browser
 * → the spec is read, cleaned, and offered back. The client then saves it as a
 * test through the normal create-test path, so a recorded test is an ordinary
 * test with ordinary history from the moment it exists.
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { cleanupRecordedSpec, startRecording, type RecordingSession } from '@qaai/runner';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const recordRouter: Router = Router();

recordRouter.use(requireAuth);

interface Session {
  orgId: string;
  projectId: string;
  baseUrl: string;
  name: string;
  status: 'recording' | 'ready' | 'error';
  code: string | null;
  error: string | null;
  handle: RecordingSession;
  createdAt: number;
}

// In-memory: sessions are bound to one API process with one screen, and a
// recording that survives a restart would be pointing at a browser that is gone.
const sessions = new Map<string, Session>();

/** A recording nobody collected an hour ago is not coming back. */
function sweepStale(): void {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) {
      session.handle.cancel();
      sessions.delete(id);
    }
  }
}

// Sweep on a timer, not only when a new recording arrives — otherwise a
// low-traffic instance where each org records once and stops never reclaims
// completed sessions, and the map grows for the life of the process. `unref`
// so this interval never keeps the process alive on its own.
setInterval(sweepStale, 10 * 60_000).unref();

recordRouter.post('/projects/:projectId/record', requireRole('MEMBER'), async (req, res) => {
  sweepStale();
  const actor = actorOf(req);
  const projectId = String(req.params.projectId);
  const environmentId = String(req.body?.environmentId ?? '');
  const name = String(req.body?.name ?? 'Recorded test').slice(0, 160);
  if (!environmentId) throw badRequest('environmentId is required');

  const environment = await prisma.environment.findUnique({
    where: { id: environmentId },
    select: { id: true, projectId: true, baseUrl: true },
  });
  if (!environment || environment.projectId !== projectId) throw notFound('Environment');

  const handle = startRecording(environment.baseUrl);
  const id = randomUUID();

  const session: Session = {
    orgId: actor.orgId,
    projectId,
    baseUrl: environment.baseUrl,
    name,
    status: 'recording',
    code: null,
    error: null,
    handle,
    createdAt: Date.now(),
  };
  sessions.set(id, session);

  // The promise settles when the user closes the browser; the client polls for
  // it rather than holding a request open for a multi-minute human session.
  handle.done
    .then((raw) => {
      session.code = cleanupRecordedSpec(raw, { name: session.name, baseUrl: session.baseUrl });
      session.status = 'ready';
    })
    .catch((err: Error) => {
      session.error = err.message;
      session.status = 'error';
    });

  await audit({
    actor,
    action: 'record.start',
    targetType: 'Project',
    targetId: projectId,
    metadata: { baseUrl: environment.baseUrl },
  });

  res.status(202).json({ sessionId: id, baseUrl: environment.baseUrl });
});

/** Poll: recording → ready (with code) → the client saves it as a test. */
recordRouter.get('/projects/:projectId/record/:sessionId', (req, res) => {
  const actor = actorOf(req);
  const session = sessions.get(String(req.params.sessionId));
  // Ownership check: a session id is a uuid, but it must still be this org's.
  if (
    !session ||
    session.orgId !== actor.orgId ||
    session.projectId !== String(req.params.projectId)
  ) {
    throw notFound('Recording session');
  }

  res.json({ status: session.status, code: session.code, error: session.error });
});

/** Cancel a recording — closes the browser window. */
recordRouter.delete('/projects/:projectId/record/:sessionId', (req, res) => {
  const actor = actorOf(req);
  const id = String(req.params.sessionId);
  const session = sessions.get(id);
  if (!session || session.orgId !== actor.orgId) throw notFound('Recording session');

  session.handle.cancel();
  sessions.delete(id);
  logger.info({ sessionId: id }, 'recording cancelled');
  res.json({ ok: true });
});
