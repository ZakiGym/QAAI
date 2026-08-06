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
import { disconnectPrisma } from './lib/prisma.js';
import { closeQueues } from './lib/queues.js';
import { startWorkerEventRelay } from './lib/events.js';
import { attachActor } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { authRouter } from './routes/auth.js';
import { projectsRouter } from './routes/projects.js';
import { agentRouter } from './routes/agent.js';
import { runsRouter } from './routes/runs.js';
import { copilotRouter } from './routes/copilot.js';
import { billingRouter, registerStripeWebhook } from './routes/billing.js';
import { settingsRouter } from './routes/settings.js';
import { ssoRouter } from './routes/sso.js';
import { registerSamlVerifier } from './lib/sso.js';
import { xmlCryptoSamlVerifier } from './lib/saml-verifier.js';
import { githubRouter, githubWebhooksRouter } from './routes/github.js';
import { runnersRouter } from './routes/runners.js';
import { teamRouter } from './routes/team.js';
import { integrationsRouter } from './routes/integrations.js';
import { recordRouter } from './routes/record.js';
import { importRouter } from './routes/import.js';
import { webhooksRouter } from './routes/webhooks.js';
import { clustersRouter } from './routes/clusters.js';
import { compareRouter } from './routes/compare.js';
import { impactRouter } from './routes/impact.js';
import { issuesRouter } from './routes/issues.js';
import { testsRouter } from './routes/tests.js';
import { bisectRouter } from './routes/bisect.js';
import { coverageRouter } from './routes/coverage.js';
import { domDiffRouter } from './routes/dom-diff.js';
import { reproRouter } from './routes/repro.js';
import { suiteHealthRouter } from './routes/suite-health.js';
import { traceRouter } from './routes/trace.js';
import { trafficRouter } from './routes/traffic.js';
import { healthRouter, queueHealthRouter } from './routes/health.js';
import { retentionRouter } from './routes/retention.js';
import { exportOrgRouter } from './routes/export-org.js';
import { observabilityMiddleware, rateLimitKey } from './lib/metrics.js';

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

// Request/duration metrics for every route below. Placed ahead of the health
// router so a scrape can see its own probe traffic.
app.use(observabilityMiddleware);

// ─── Health & metrics (§11) ──────────────────────────────────────────────────
//
// AHEAD OF THE RATE LIMITER, deliberately — see the header of routes/health.ts.
// A rate-limited liveness probe is a self-inflicted outage: the kubelet reads a
// 429 as a failed probe and restarts a healthy container, and the Prometheus
// scraper goes blind exactly when traffic is high enough to be worth watching.
// Both handlers are cheap and cached, so they belong in front of the limiter.
//
// This router also REPLACES the inline /health and /health/ready that used to
// live here; it serves the same shapes plus /health/live and /metrics.
app.use(healthRouter);

app.use(
  rateLimit({
    windowMs: 60_000,
    limit: isProd ? 300 : 5000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Per org where we know it, per client NETWORK otherwise. Not `req.ip`:
    // an IPv6 caller holds a whole delegated prefix, so keying on the full
    // address hands it a fresh budget per request. See lib/metrics.ts.
    keyGenerator: rateLimitKey,
  }),
);

app.use(attachActor);

// ─── Routes ──────────────────────────────────────────────────────────────────

// Queue health lives in routes/health.ts beside /metrics but is mounted HERE,
// behind the limiter, not with its siblings in front of it: it requires a
// session (its payload carries failed-job error text, which the unauthenticated
// surface may never serve) and nothing in a cluster probes it. See the router's
// comment for the full reasoning.
app.use(queueHealthRouter);

app.use('/auth', authRouter);
// SSO sits beside /auth rather than inside it: most of its endpoints are
// anonymous by necessity (the browser arriving from an IdP has no session yet),
// and mixing those into the router that owns password login would put an
// unauthenticated surface behind a file whose every other route is guarded.
/*
 * SAML signature verification is a PORT with no default implementation, and the
 * ACS route refuses every assertion until one is registered — the safe failure
 * for an unauthenticated endpoint that issues sessions. Registered here, at the
 * composition root, so the security-critical wiring is visible in one place
 * rather than buried in a module's import side effects.
 */
registerSamlVerifier(xmlCryptoSamlVerifier);

app.use('/sso', ssoRouter);
app.use('/projects', projectsRouter);
app.use('/runs', runsRouter);
app.use('/copilot', copilotRouter);
app.use('/settings', settingsRouter);
app.use('/billing', billingRouter);
app.use('/integrations', integrationsRouter);
app.use('/webhooks', webhooksRouter);
// The GitHub App's inbound half. MUST be under '/webhooks' — that is the only
// prefix parsed with express.raw(), and the HMAC is computed over the raw bytes
// GitHub signed. It is mounted after webhooksRouter because that router owns
// '/github' (pull requests) and this one owns '/github-app'; the paths do not
// collide, and keeping the existing router first means no PR webhook changes
// hands.
app.use('/webhooks', githubWebhooksRouter);
app.use('/github', githubRouter);
// On-prem runner agents. The router mounts its own '/agent' sub-router first
// and terminates its own 404s, so an agent path never falls through into the
// session-authenticated admin half.
app.use('/runners', runnersRouter);
app.use('/team', teamRouter);
app.use('/clusters', clustersRouter);
app.use('/compare', compareRouter);
app.use('/impact', impactRouter);
app.use('/issues', issuesRouter);
app.use('/tests', testsRouter);
app.use('/bisect', bisectRouter);
app.use('/coverage', coverageRouter);
app.use('/dom-diff', domDiffRouter);
app.use('/repro', reproRouter);
app.use('/suite-health', suiteHealthRouter);
app.use('/trace', traceRouter);
// Retention: /retention/usage (MEMBER), /preview (ADMIN), /sweep (OWNER).
app.use('/retention', retentionRouter);
// Org export declares `/org` and `/org/preview`; OWNER-only, enforced inside.
app.use('/export', exportOrgRouter);
// Traffic declares its own `/traffic/...` paths (it installs a text body parser
// on the analyze path), so it mounts at the root like record/import/agent.
app.use('/', trafficRouter);
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
