/**
 * QAAI API server.
 *
 * Middleware order matters and is deliberate:
 *   request context (so every log line has an id) → security headers → CORS →
 *   body parsing → rate limit → routes → 404 → error handler.
 */

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env, isProd } from './env.js';
import { controlEnforces, controlMode } from '@qaai/shared';
import { csrfGuard, parseOrigin } from './middleware/csrf.js';
import { logger, runWithRequestContext } from './lib/logger.js';
import { disconnectPrisma, prisma, unscoped } from './lib/prisma.js';
import { installKeyringAtBoot } from './lib/vault.js';
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
import { sourceRouter } from './routes/source.js';
import { suitesRouter } from './routes/suites.js';
import { schedulesRouter } from './routes/schedules.js';
import { badgesRouter } from './routes/badges.js';
import { terminalRouter } from './routes/terminal.js';
import { shareRouter } from './routes/share.js';
import { pluginsRouter } from './routes/plugins.js';
import { webhooksRouter } from './routes/webhooks.js';
import { clustersRouter } from './routes/clusters.js';
import { triageRouter } from './routes/triage.js';
import { compareRouter } from './routes/compare.js';
import { impactRouter } from './routes/impact.js';
import { issuesRouter } from './routes/issues.js';
import { testsRouter } from './routes/tests.js';
import { bisectRouter } from './routes/bisect.js';
import { coverageRouter } from './routes/coverage.js';
import { surfaceRouter } from './routes/surface.js';
import { apiSurfaceRouter } from './routes/api-surface.js';
import { requirementsRouter } from './routes/requirements.js';
import { manualCasesRouter } from './routes/manual-cases.js';
import { codeCoverageRouter } from './routes/code-coverage.js';
import { measurementsRouter } from './routes/measurements.js';
import { domDiffRouter } from './routes/dom-diff.js';
import { reproRouter } from './routes/repro.js';
import { suiteHealthRouter } from './routes/suite-health.js';
import { reportsRouter } from './routes/reports.js';
import { traceRouter } from './routes/trace.js';
import { trafficRouter } from './routes/traffic.js';
import { healthRouter, queueHealthRouter } from './routes/health.js';
import { retentionRouter } from './routes/retention.js';
import { exportOrgRouter } from './routes/export-org.js';
import { observabilityMiddleware, rateLimitKey } from './lib/metrics.js';

/**
 * EXPORTED so a test can drive a REQUEST through this stack rather than assert
 * that a line of wiring exists.
 *
 * Nothing about the mounted order changes by exporting it; what changes is that
 * the two side effects at the bottom of this file — `app.listen` and the Redis
 * event relay — are behind a guard, so importing the composition root does not
 * bind a port or dial Redis. `middleware/csrf.ts`'s header records the cost of
 * the old shape: "a control whose decision cannot be driven by a test is a
 * control nobody can trust", and it had to move its decision into a separate
 * module to get one. The headers below cannot move anywhere — a header is set
 * by a mount, and the mount IS the control — so the file became importable
 * instead.
 */
export const app = express();

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
/*
 * The line-coverage ingest, and the only route with its own body limit.
 *
 * body-parser skips once `req._body` is set, so a router-level parser mounted
 * AFTER the global one below cannot raise the limit — it has to be ahead of it.
 * A real Istanbul `coverage-final.json` for a mid-sized application is well
 * over 2mb, so without this line `CODE_COVERAGE_CAPS.payloadBytes` (16MB) is an
 * allowance nobody could use and the ingest's true ceiling would be 2mb while
 * advertising eight times that.
 */
app.use('/code-coverage', express.json({ limit: '16mb' }));
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

// ─── CSRF, and the headers (§ the security round) ────────────────────────────

/*
 * THE CSRF GUARD. The decision is `middleware/csrf.ts` and the reasoning lives
 * there with it; this line is the mount, and the mount is the control.
 *
 * MOUNTED IMMEDIATELY AFTER `attachActor`, which is load-bearing in both
 * directions. After, because the check only applies to a request whose
 * credential the BROWSER attached, and `attachActor` is what knows whether this
 * is a session or an API key. Before every router below, because a guard
 * mounted per-router is a guard the next router forgets — the single mount here
 * covers /projects, /settings, /integrations and everything else at once,
 * including a router added next round.
 */
app.use(
  csrfGuard({
    webOrigin: parseOrigin(env.WEB_PUBLIC_URL),
    log: (fields, message) => logger.warn(fields, message),
  }),
);

/**
 * ── THE SECURITY HEADERS helmet WAS NOT SENDING ────────────────────────────
 *
 * `contentSecurityPolicy: false` above is kept, and the comment beside it is
 * accurate about WHY — the API serves JSON and artifact bytes, and helmet's
 * default policy breaks inline artifact rendering. What it concluded from that
 * was wrong: "CSP has nothing to protect here" is only true until this API
 * serves one byte a browser will treat as a document, and it serves artifacts.
 * An uploaded HTML artifact rendered inline from this origin is stored XSS
 * against the cockpit's own domain.
 *
 * So the policy is the JSON-API one — `default-src 'none'` — which permits
 * nothing at all: no script, no style, no frame, no form target. That is
 * correct for every JSON response and it is correct for an artifact too, which
 * should render no script of its own.
 *
 * MODE: `CONTENT_SECURITY_POLICY` defaults to OBSERVE, and OBSERVE here is
 * `Content-Security-Policy-Report-Only` — a real header with a real report
 * endpoint below, not a disabled feature. ENFORCE sends the same policy in the
 * enforcing header.
 *
 * ── THE BRAKE NOBODY COULD ARM, AND WHAT ENFORCING ACTUALLY BREAKS ─────────
 *
 * This read was `controlMode('CONTENT_SECURITY_POLICY', null)` with the null
 * written in. A stored mode cannot be reached from a hardcoded null, so the
 * only value this control could ever have was its own default and there was no
 * path from OBSERVE to ENFORCE short of editing the table — an on-switch
 * nobody can reach, which is the same defect as a brake that does not brake
 * with the sign flipped. The paragraph above named the consequence of leaving
 * it at OBSERVE ("stored XSS against the cockpit's own domain") while the code
 * under it made ENFORCE unreachable.
 *
 * THE NULL HAD A REAL REASON, which is why the fix is a lookup and not a
 * deletion: this header is set for unauthenticated requests too, so there is
 * not always an org in hand. The answer is per-request rather than per-process:
 * the mount sits AFTER `attachActor`, so a cookie- or key-authenticated request
 * knows its org, and an anonymous one gets the control's own fallback. That is
 * coherent for this header specifically, because the policy rides on ONE
 * RESPONSE and a response belongs to one tenant — an artifact uploaded by org B
 * is served to org B, so org B's mode is the one that should govern it.
 *
 * AND THE BRAKE TABLE'S SENTENCE IS WRONG, which matters more than the lookup.
 * `SECURITY_CONTROL_BRAKES.CONTENT_SECURITY_POLICY.enforcingBreaks` says "the
 * cockpit, until its inline styles and scripts are accounted for" — but the
 * cockpit is Next on another origin and never receives this header. What
 * enforcing actually breaks is this API's own `text/html` responses, and there
 * is one today: `GET /coverage/:projectId/attestation?format=html`
 * (apps/api/src/routes/coverage.ts) is a print-ready document with an inline
 * `<style>`, and `default-src 'none'` blocks it, so the page renders unstyled.
 * That is a small, real, named cost against stored XSS on this origin — the
 * trade an operator is entitled to make per org. packages/shared is not this
 * file's to edit, so the replacement sentence is in the handover; this
 * paragraph is the half that can be true today.
 *
 * The three headers after it are unconditional because none of them can break
 * a JSON client: they constrain framing, referrer leakage and MIME sniffing.
 */
const API_CSP = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'report-uri /csp-report',
].join('; ');

/**
 * How long one org's stored modes are reused for.
 *
 * A header is set on every response, and a database round trip per response for
 * a brake that changes a few times a year is a cost nobody would accept — so
 * the read is cached per process, and the limit is stated rather than implied:
 * arming or releasing the brake takes effect within a minute, and each API
 * replica holds its own copy. `middleware/csrf.ts` makes the same admission
 * about its observe counts for the same reason.
 */
const SECURITY_MODE_TTL_MS = 60_000;
/** Bounded: an unbounded map keyed by anything a request carries is a leak. */
const SECURITY_MODE_CACHE_CAP = 1_000;
const securityModeCache = new Map<string, { readonly modes: unknown; readonly readAt: number }>();

/** Test-only reset, so one test's cached org cannot answer for the next. */
export function resetSecurityModeCache(): void {
  securityModeCache.clear();
}

/**
 * `Organization.securityControlModes` for one org, cached.
 *
 * Unscoped because this runs before any tenancy scope is open — the same reason
 * `middleware/auth.ts` reads the session unscoped — and it reads ONE column of
 * ONE row by primary key.
 */
async function storedSecurityControlModes(orgId: string): Promise<unknown> {
  const now = Date.now();
  const cached = securityModeCache.get(orgId);
  if (cached !== undefined && now - cached.readAt < SECURITY_MODE_TTL_MS) return cached.modes;

  const org = await unscoped(() =>
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { securityControlModes: true },
    }),
  );
  const modes = org?.securityControlModes ?? null;
  // Cleared rather than evicted one-by-one: this is a cache, the cap is far
  // above any real tenant count on one replica, and an LRU here would be more
  // machinery than the thing it protects.
  if (securityModeCache.size >= SECURITY_MODE_CACHE_CAP) securityModeCache.clear();
  securityModeCache.set(orgId, { modes, readAt: now });
  return modes;
}

/**
 * THE SECURITY HEADERS, AND THE ONE OF THEM THAT HAS A MODE.
 *
 * Exported and parameterised on the lookup for one reason: a header this
 * process sets on every response is testable by driving a request through
 * {@link app}, and the lookup is the only thing in it that would otherwise need
 * a database.
 *
 * FAILS TO THE CONTROL'S OWN FALLBACK. A lookup that throws — the database is
 * down, the row is gone — resolves the mode as though nothing were stored,
 * which is what `controlMode` itself does for a value it cannot parse. For this
 * control the fallback is OBSERVE, so a failed read sends Report-Only rather
 * than an enforcing header: the failure cannot wedge a tenant's own API on a
 * header they did not choose, and it is recorded here rather than left to be
 * inferred from the code.
 */
export function securityHeaders(input: {
  /** `Organization.securityControlModes` for the actor's org. */
  readonly modesFor: (orgId: string) => Promise<unknown>;
}) {
  return async function securityHeadersMiddleware(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): Promise<void> {
    const orgId = req.actor?.orgId;
    let stored: unknown = null;
    if (orgId !== undefined && orgId !== '') {
      try {
        stored = await input.modesFor(orgId);
      } catch (err) {
        // No org id, no stored value and no host in the log line: this is our
        // own read failing, and the mode it produces is the fallback.
        logger.warn({ err, control: 'CONTENT_SECURITY_POLICY' }, 'could not read the stored security control modes');
        stored = null;
      }
    }

    const mode = controlMode('CONTENT_SECURITY_POLICY', stored);
    res.setHeader(
      controlEnforces(mode) ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
      API_CSP,
    );
    // Not framed, by anyone. `frame-ancestors` above covers modern browsers;
    // this covers the ones that do not implement it.
    res.setHeader('X-Frame-Options', 'DENY');
    // A referrer carries the path, and a path can carry an id or a token.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    next();
  };
}

app.use(securityHeaders({ modesFor: storedSecurityControlModes }));

/**
 * WHERE A CSP VIOLATION REPORT LANDS.
 *
 * This endpoint is what makes OBSERVE mode a measurement rather than a
 * promise — `SECURITY_CONTROL_BRAKES.CONTENT_SECURITY_POLICY.observeCounts`
 * says "every violation report, by directive, so the policy can be tightened on
 * evidence", and without somewhere to send them that sentence would be a doc
 * comment contradicting the code under it.
 *
 * UNAUTHENTICATED, because a browser posts it with no credential, and mounted
 * behind the rate limiter above so it cannot be used as an amplifier. Only the
 * DIRECTIVE is kept: a report also carries the blocked URI and the document
 * URI, and those are a page's full URLs, which are the thing a log must not
 * accumulate. 204 with no body, always — a report is fire-and-forget and a
 * reporter must learn nothing from it.
 */
/**
 * THE COUNT, which is the half that makes OBSERVE a measurement.
 *
 * In memory and per process, which is the honest limit — a restart loses them
 * and two replicas each hold their own; the log line beside each increment is
 * what survives. `csrfObserved` in middleware/csrf.ts takes the same position
 * for the same reason, and the brake table's `observeCounts` sentence for this
 * control ("every violation report, by directive, so the policy can be
 * tightened on evidence") is only answerable with something to read.
 *
 * CAPPED ON DISTINCT DIRECTIVES, because the key comes out of a request body:
 * a reporter can post any string it likes, and a map keyed on that is a memory
 * leak with a security-sounding name. Past the cap everything lands under
 * {@link CSP_DIRECTIVE_OVERFLOW}, so the total is never understated — a cap
 * that bit without being counted is one of the lies this product cannot
 * afford.
 */
const CSP_DIRECTIVE_CAP = 32;
export const CSP_DIRECTIVE_OVERFLOW = 'other';
const cspViolations = new Map<string, number>();

export function cspObserved(): Readonly<Record<string, number>> {
  return Object.fromEntries(cspViolations);
}

/** Test-only reset, so one test's counts cannot leak into the next. */
export function resetCspObserved(): void {
  cspViolations.clear();
}

app.post('/csp-report', express.json({ type: ['json', 'application/csp-report'] }), (req, res) => {
  const body = req.body as { 'csp-report'?: { 'violated-directive'?: unknown } } | undefined;
  const reported = body?.['csp-report']?.['violated-directive'];
  const named = typeof reported === 'string' && reported.length > 0 ? reported.slice(0, 80) : 'unknown';
  const directive =
    cspViolations.has(named) || cspViolations.size < CSP_DIRECTIVE_CAP
      ? named
      : CSP_DIRECTIVE_OVERFLOW;
  const observed = (cspViolations.get(directive) ?? 0) + 1;
  cspViolations.set(directive, observed);

  logger.warn(
    {
      control: 'CONTENT_SECURITY_POLICY',
      directive,
      observed,
    },
    'a content security policy violation was reported',
  );
  res.status(204).end();
});

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
/*
 * THE REPORTER REGISTRY'S DOOR, AND WHY IT IS ABOVE `runsRouter`.
 *
 * `reports.ts` declares `/:runId/report`, NOT the full `/runs/:runId/report`,
 * so it has to be mounted at `/runs` — and reports.ts's own header says so:
 * "MOUNT THIS ROUTER AT `/runs` AHEAD OF `runsRouter`."
 *
 * It was mounted at `/` instead, under a comment claiming it declared the full
 * path. It does not, so the door opened on the WRONG URL: `/runs/:runId/report`
 * fell through `runsRouter` (which declares no `:runId/report`) and then missed
 * `/:runId/report` at the root, because `/runs/run_1/report` is three segments
 * and that route matches two — a flat 404 on the only URL every comment, the
 * test file and any client uses, while the router squatted on `/:runId/report`
 * at the root where nothing asks for it. Driven both ways:
 * `GET /runs/run_1/report` → 404, `GET /run_1/report` → 200.
 *
 * AHEAD of `runsRouter` rather than after it, which is the part that is easy to
 * get wrong in the other direction: `runsRouter.use(requireAuth)` is a
 * ROUTER-level guard, so mounting below it would run `requireAuth` once there,
 * fall through for want of a matching route, and run it again on this router's
 * own route. `runsRouter` declares no `:runId/report`, so mounting above
 * shadows nothing of it.
 *
 * Five finished, tested reporters sat behind `REPORTERS` and `renderReport`
 * with no caller outside their own tests for several slices. Correct code with
 * no door is indistinguishable from code that does not exist — and a door at a
 * URL that 404s is the same thing with a line of wiring to point at.
 */
app.use('/runs', reportsRouter);
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

/*
 * The sidebar's two badge counts, on their own prefix.
 *
 * They used to come from `/verdicts` and `/heals` — two full list payloads,
 * polled from every open tab every ten to fifteen seconds, for two numbers.
 */
app.use('/badges', badgesRouter);

/*
 * A shell in the container the run executed in. The router declares its own
 * `/agent/...` half for the runner and a cockpit half behind requireAuth, so it
 * mounts after attachActor like every other authenticated surface.
 */
app.use('/terminal', terminalRouter);

/* The plugin registry: what an org has installed, and who it trusts to sign. */
app.use('/plugins', pluginsRouter);

/*
 * Public, read-only run reports.
 *
 * Mounted at the ROOT because the router declares both halves of its own
 * surface — `/share/:token` for the public page and `/runs/:runId/share` for
 * the owner minting the link — the way sourceRouter and suitesRouter do. The
 * public half deliberately carries no requireAuth: its credential is the token.
 */
app.use('/', shareRouter);

/* Schedules and monitors: the read/update/delete half the POSTs never had. */
app.use('/automation', schedulesRouter);
app.use('/team', teamRouter);
app.use('/clusters', clustersRouter);
app.use('/triage', triageRouter);
app.use('/compare', compareRouter);
app.use('/impact', impactRouter);
app.use('/issues', issuesRouter);
app.use('/tests', testsRouter);
app.use('/bisect', bisectRouter);
app.use('/coverage', coverageRouter);
// Mounted at the root: surfaceRouter declares its own `/surface/...` paths.
app.use(surfaceRouter);
/*
 * The three newest halves of the surface denominator, mounted at the ROOT for
 * the same reason surfaceRouter is: each declares its own full paths
 * (`/api-surface/:projectId`, `/requirements/:projectId`,
 * `/manual-cases/:projectId`), so a prefix here would serve them at
 * `/api-surface/api-surface/:projectId`.
 */
app.use(apiSurfaceRouter);
app.use(requirementsRouter);
app.use(manualCasesRouter);
/*
 * Line coverage from the customer's own CI. Root-mounted for the same reason
 * as the four above: `code-coverage.ts` declares its own full paths
 * (`/code-coverage/:projectId`, `/files`, `/uncovered`, `/patch`), so a prefix
 * here would serve them at `/code-coverage/code-coverage/:projectId`.
 *
 * This is the OTHER HALF of the measurement. Everything else in this process
 * answers "which crawled surface does a test MENTION"; these four paths answer
 * "which lines did a suite EXECUTE", which is what a buyer means by coverage.
 */
app.use(codeCoverageRouter);
/*
 * The READ side of the two measurement tables, beside the other measurement
 * routers. Prefix-mounted (unlike codeCoverageRouter just above) because
 * `measurements.ts` declares bare paths — `/:projectId/matrix`,
 * `/:projectId/metrics` — so the prefix is what gives them a namespace at all.
 *
 * The variant matrix and the metric trend are the two reads `TestResultVariant`
 * and `TestMetricSample` were shipped without: both tables and four indexes
 * existed with nothing selecting from them, which `scripts/check-wiring.ts`
 * reported as DISCONNECTED.
 */
app.use('/measurements', measurementsRouter);
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
// Declares '/projects/:projectId/source', so it mounts at the root beside
// importRouter rather than inside projectsRouter — same reason: the path is
// owned by the file that serves it. projectsRouter has no ':projectId/source'
// route, so nothing shadows this one on the way past.
app.use('/', sourceRouter);
/*
 * Declares its own full `/projects/:projectId/suites` paths, the way
 * sourceRouter does, so it mounts at the root. projectsRouter owns no
 * `:projectId/suites` route, so nothing above shadows it.
 */
app.use('/', suitesRouter);
app.use('/', agentRouter);

app.use(notFoundHandler);
app.use(errorHandler);

/**
 * ── RUNNING, AS OPPOSED TO BEING IMPORTED ──────────────────────────────────
 *
 * Everything above composes the app; these two lines START it, and they are the
 * reason this file could not be tested. A test that imported it bound
 * `API_PORT` and dialled Redis, so the headers and the mount order — which are
 * the control, not a detail of it — had no test at all, and `middleware/csrf.ts`
 * had to move its decision into another module to get one.
 *
 * ── THE GUARD, AND THE TWO CANDIDATES THAT WOULD HAVE BROKEN A DEPLOYMENT ──
 *
 * It fails in the direction of STARTING, which is the opposite of this round's
 * other defaults and is right for this one decision: a guard that wrongly
 * refuses to listen is a silent outage, and there is no security answer being
 * made here at all.
 *
 * NOT `env.NODE_ENV !== 'test'`, which was the first version of this line and
 * would have broken CI. `.github/workflows/ci.yml` sets `NODE_ENV: test` for
 * the whole dogfood job and then runs `npm run dev` and polls
 * `http://localhost:4000/health/live` — so the API would never have come up,
 * and the failure would have read as "the stack never came up" in a job that
 * has nothing to do with this file.
 *
 * NOT `process.env.VITEST` either, which was the second version. The test
 * runner sets it, so it reads well — and `scripts/check-wiring.ts` refused it
 * on sight: an env var this source reads and `.env.example` does not document
 * is DISCONNECTED, "nobody deploying this can discover it". Documenting it
 * would be worse than the lint, because a value in `.env.example` is a knob an
 * operator may set, and "the API does not start" must never be one.
 *
 * So the guard asks whether this file IS the entry, which needs no variable.
 * MEASURED rather than assumed: `process.argv[1]` is the script's own path
 * under `node dist/index.js` AND under `tsx watch src/index.ts` (this app's dev
 * command, and the one the CI dogfood job starts through `npm run dev`), and it
 * is the runner's entry under vitest.
 *
 * Its one failure mode is named rather than hidden: the comparison is between
 * PATHS, so a path that reaches this file by a route Node spells differently —
 * a symlink, a case-insensitive filesystem — answers "not the entry" and the
 * API does not listen. `realpathSync` closes the symlink half, every arm that
 * cannot answer starts the server, and the skip is LOGGED, so the one
 * deployment that ever hits it says so in its first line of output instead of
 * being a silent port that never opens.
 */
function startedAsTheEntrypoint(): boolean {
  const entry = process.argv[1];
  // No entry at all (`node -e`, an embedder): start. Every arm that cannot
  // answer starts, because the wrong answer in the other direction is an
  // outage with no message attached to it.
  if (entry === undefined || entry === '') return true;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return true;
  }
}
export function startApiServer(): void {
  startWorkerEventRelay(env.REDIS_URL);

  /*
   * THE VAULT KEYRING, BEFORE THE FIRST REQUEST. `seal` and `open` are
   * synchronous and are called from five routes and three worker processors, so
   * the keyring cannot be fetched inside them — it is installed once, here.
   * Without this the IMPLICIT keyring was always in force in this process and
   * the whole `VaultKey` state machine was inert: see `installKeyringAtBoot`,
   * which records what was measured.
   *
   * Awaited through `.then` rather than blocking the listen: a deployment with
   * no registered keys (which is all of them today) resolves immediately on the
   * implicit keyring, and one with MALFORMED rows throws, which takes the
   * process down on purpose rather than serving requests that would seal under
   * the wrong version.
   */
  void installKeyringAtBoot(
    {
      /*
       * The keyring's OWN five columns, not `VAULT_KEY_SELECT` — that one is
       * session-store's three-field projection and `VaultKeyRow` also carries
       * the provider and its reference. Typed `satisfies` so dropping a column
       * is a compile error here rather than a keyring missing a field.
       */
      listVaultKeys: () =>
        prisma.vaultKey.findMany({
          select: { keyId: true, version: true, state: true, provider: true, providerRef: true },
          orderBy: { version: 'asc' },
        }),
    },
    (level, fields, message) => logger[level](fields, message),
  ).catch((err: unknown) => {
    // `installKeyringAtBoot` reports a refused keyring itself and returns the
    // implicit one; this is the unexpected-throw path (a database that cannot be
    // read at all), which must not take the process down either — the first
    // version called `process.exit(1)` here and killed the test runner from
    // inside a module-level import.
    logger.error({ err }, 'the vault keyring could not be installed; running on the implicit keyring');
  });

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
}

if (startedAsTheEntrypoint()) {
  startApiServer();
} else {
  logger.info(
    { module: 'apps/api/src/index.ts' },
    'imported rather than started, so no port is bound and no event relay is running',
  );
}
