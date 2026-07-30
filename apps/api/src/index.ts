/**
 * QAAI API server.
 *
 * Middleware order matters and is deliberate:
 *   request context (so every log line has an id) → security headers → CORS →
 *   body parsing → rate limit → routes → 404 → error handler.
 */

import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env, isProd } from './env.js';
import { logger, runWithRequestContext } from './lib/logger.js';
import { disconnectPrisma, prisma, unscoped } from './lib/prisma.js';
import { closeQueues, pingRedis, queueDepths } from './lib/queues.js';
import { startWorkerEventRelay, subscriberCount } from './lib/events.js';
import { attachActor } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { authRouter } from './routes/auth.js';
import { projectsRouter } from './routes/projects.js';
import { agentRouter } from './routes/agent.js';
import { runsRouter } from './routes/runs.js';
import { copilotRouter } from './routes/copilot.js';
import { settingsRouter } from './routes/settings.js';
import { integrationsRouter } from './routes/integrations.js';
import { recordRouter } from './routes/record.js';
import { importRouter } from './routes/import.js';
import { webhooksRouter } from './routes/webhooks.js';

const app = express();

app.disable('x-powered-by');
// Trust exactly one proxy hop, so req.ip is the client and not the load balancer.
app.set('trust proxy', 1);

// Request context first — everything downstream logs with the same request id.
app.use((req, res, next) => {
  const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
  res.setHeader('x-request-id', requestId);
  runWithRequestContext({ requestId }, () => next());
});

app.use(
  helmet({
    // The API serves JSON and artifact bytes, never HTML, so CSP has nothing to
    // protect here — and the default policy breaks inline artifact rendering.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);

app.use(
  cors({
    origin: [env.WEB_PUBLIC_URL],
    credentials: true,
  }),
);

// The GitHub webhook is HMAC-verified over the RAW body, so it must not be
// JSON-parsed first. Mounted ahead of the global parser for that reason alone.
app.use('/webhooks', express.raw({ type: 'application/json', limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

app.use(
  rateLimit({
    windowMs: 60_000,
    limit: isProd ? 300 : 5000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Rate limit per org where we know it, per IP otherwise — one noisy tenant
    // must not exhaust the budget for everyone behind the same egress IP.
    keyGenerator: (req) => req.actor?.orgId ?? req.ip ?? 'anonymous',
  }),
);

app.use(attachActor);

// ─── Health (§11) ────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'qaai-api', version: '0.1.0' });
});

app.get('/health/ready', async (_req, res) => {
  const [db, redis] = await Promise.all([
    unscoped(() => prisma.$queryRaw`SELECT 1`)
      .then(() => true)
      .catch(() => false),
    pingRedis(),
  ]);

  const ok = db && redis;
  res.status(ok ? 200 : 503).json({
    ok,
    checks: { database: db, redis },
    sseSubscribers: subscriberCount(),
    queues: ok ? await queueDepths().catch(() => ({})) : {},
  });
});

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use('/auth', authRouter);
app.use('/projects', projectsRouter);
app.use('/runs', runsRouter);
app.use('/copilot', copilotRouter);
app.use('/settings', settingsRouter);
app.use('/integrations', integrationsRouter);
app.use('/webhooks', webhooksRouter);
app.use('/', recordRouter);
app.use('/', importRouter);
app.use('/', agentRouter);

app.use(notFoundHandler);
app.use(errorHandler);

startWorkerEventRelay(env.REDIS_URL);

const server = app.listen(env.API_PORT, () => {
  logger.info({ port: env.API_PORT }, 'qaai api listening');
});

/** Graceful shutdown (§11): stop accepting, drain, then release handles. */
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    server.close(async () => {
      await closeQueues().catch(() => {});
      await disconnectPrisma().catch(() => {});
      process.exit(0);
    });

    // Backstop: an SSE stream holds the server open indefinitely.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
