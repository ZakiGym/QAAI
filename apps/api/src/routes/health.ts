/**
 * Health probes and the metrics endpoint (§11).
 *
 * ─── LIVENESS vs READINESS, and why they must stay different ────────────────
 *
 * They answer two different questions and are consumed by two different things,
 * and collapsing them is one of the classic ways to turn a small outage into a
 * large one.
 *
 *   GET /health, GET /health/live   — "is this process alive?"
 *       Touches NOTHING. No database, no Redis, no filesystem. It returns 200
 *       if the event loop can still run a handler, and that is the entire
 *       contract. Kubernetes RESTARTS a container that fails its liveness
 *       probe, so a liveness probe that checks Postgres means: Postgres has a
 *       three-second blip → every API pod fails its probe at once → the
 *       orchestrator kills all of them → they come back cold, with empty
 *       connection pools, and hammer the database that was already struggling.
 *       A recoverable database hiccup becomes a full outage, caused entirely by
 *       the health check. DO NOT ADD A DEPENDENCY CHECK HERE.
 *
 *   GET /health/ready               — "can this process serve traffic?"
 *       Checks the things a request actually needs: the database is reachable,
 *       Redis is reachable, and the schema has been migrated. Kubernetes pulls a
 *       failing pod out of the load balancer but LEAVES IT RUNNING, which is the
 *       correct response to a dependency being down — the pod recovers on its
 *       own when the dependency does, with a warm pool.
 *
 * If you are here because "the health check doesn't catch database outages":
 * that is /health/ready, and it does. Please do not "fix" /health/live.
 *
 * ─── /metrics ───────────────────────────────────────────────────────────────
 *
 * Unauthenticated, because a Prometheus scrape config has no session and giving
 * it a credential means writing a credential into a scrape config. That makes
 * everything here public, so it publishes only aggregates over our own closed
 * vocabularies — never an org, project, test, branch or URL. See
 * ../lib/metrics.ts, where every label choice is justified.
 *
 * ─── Where this router must be mounted ──────────────────────────────────────
 *
 * BEFORE the rate limiter. Not a preference — a rate-limited liveness probe is
 * a self-inflicted outage: kubelet gets a 429, reads it as a failed probe, and
 * restarts a perfectly healthy container. The same applies to the scraper, which
 * goes blind exactly when traffic is high enough to be worth watching. Probes
 * and scrapes come from the cluster, not the internet, and they are cheap and
 * cached here, so they belong in front of the limiter rather than behind it.
 */

import { Router } from 'express';
import IORedis from 'ioredis';
import { QUEUE_NAMES, RUN_STATUSES } from '@qaai/shared';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { prisma, unscoped } from '../lib/prisma.js';
import { pingRedis, queueDepths } from '../lib/queues.js';
import { subscriberCount } from '../lib/events.js';
import { RUNNER_ONLINE_MS } from '../lib/runners.js';
import {
  WORKER_METRICS_KEY_PREFIX,
  collectErrors,
  collectProcessMetrics,
  llmCallsMonth,
  llmCostCentsMonth,
  llmTokensMonth,
  oldestQueuedRunAge,
  parseWorkerSnapshot,
  queueDepth,
  queueOldestAge,
  registry,
  renderWorkerSnapshots,
  runnersOnline,
  runnersRegistered,
  runsByStatus,
  sseSubscribers,
  startProcessCollectors,
  type WorkerMetricsSnapshot,
} from '../lib/metrics.js';

export const SERVICE_NAME = 'qaai-api';

/**
 * Overridable so a container image can stamp the build it was cut from without
 * a code change. Not a secret and not tenant data — it names our software.
 */
const VERSION = process.env.QAAI_VERSION?.trim() || '0.1.0';

export const healthRouter = Router();

// ─── Liveness ────────────────────────────────────────────────────────────────

/**
 * Deliberately synchronous and dependency-free. Read the header comment before
 * adding an `await` to this handler.
 */
function liveness(): {
  ok: true;
  status: 'ok';
  service: string;
  version: string;
  uptimeSeconds: number;
} {
  return {
    // `ok` is redundant next to `status`, and it stays because this router
    // REPLACES an endpoint that is already live and already answers `{ok:true}`.
    // Nothing in this repo reads it, but a load balancer config or an uptime
    // monitor outside the repo might, and a health check is the last thing that
    // should break during the deploy that adds better health checks.
    ok: true,
    status: 'ok',
    service: SERVICE_NAME,
    version: VERSION,
    uptimeSeconds: Math.round(process.uptime()),
  };
}

healthRouter.get('/health', (_req, res) => {
  res.json(liveness());
});

// The explicit name, for probe configs that want to be unambiguous about which
// of the two semantics they asked for.
healthRouter.get('/health/live', (_req, res) => {
  res.json(liveness());
});

// ─── Readiness ───────────────────────────────────────────────────────────────

/**
 * Stop waiting after `ms`.
 *
 * The underlying query is NOT cancelled — it cannot be, portably — we simply
 * stop blocking the probe on it. That is the right trade: a readiness probe that
 * hangs on a wedged connection tells the orchestrator nothing until its own
 * timeout fires, whereas a fast 503 takes the pod out of rotation immediately.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

const READINESS_TIMEOUT_MS = 2_000;

/**
 * How long a readiness answer is reused.
 *
 * This endpoint is unauthenticated, so without a cache anyone on the internet
 * can make the API issue a database round trip per request — a readiness probe
 * turned into an amplification vector. One second is far below any sane probe
 * interval, so a real orchestrator never notices the cache exists.
 */
const READINESS_CACHE_MS = 1_000;

type MigrationState = 'applied' | 'pending' | 'absent' | 'unknown';

interface Readiness {
  ok: boolean;
  checks: { database: boolean; redis: boolean; migrations: MigrationState };
}

let readinessCache: { at: number; value: Readiness } | null = null;

/**
 * Has the schema this build expects actually been applied?
 *
 * A pod whose database is reachable but un-migrated is the worst kind of ready:
 * it accepts traffic and then 500s on the first query touching a new column.
 * Prisma records every migration in `_prisma_migrations`, and a row with no
 * `finished_at` and no `rolled_back_at` is one that started and never completed
 * — a failed or in-flight migration. Either way this process must not serve.
 *
 * `absent` means the table does not exist at all: a database that has never been
 * migrated. Also not ready, and reported distinctly because the fix is different
 * ("run migrate deploy" versus "your last migration failed, look at its logs").
 */
async function migrationState(): Promise<MigrationState> {
  try {
    const rows = await unscoped(
      () =>
        prisma.$queryRaw<{ unfinished: bigint }[]>`
          SELECT count(*) AS unfinished
          FROM "_prisma_migrations"
          WHERE finished_at IS NULL AND rolled_back_at IS NULL
        `,
    );
    const unfinished = Number(rows[0]?.unfinished ?? 0);
    return unfinished > 0 ? 'pending' : 'applied';
  } catch (err) {
    // 42P01 is undefined_table. Anything else is a database problem the
    // `database` check will already have reported.
    const code = (err as { code?: unknown }).code;
    if (code === '42P01' || String(err).includes('_prisma_migrations')) return 'absent';
    return 'unknown';
  }
}

async function gatherReadiness(): Promise<Readiness> {
  const [database, redis, migrations] = await Promise.all([
    withTimeout(
      unscoped(() => prisma.$queryRaw`SELECT 1`),
      READINESS_TIMEOUT_MS,
      'database check',
    )
      .then(() => true)
      .catch(() => false),
    withTimeout(pingRedis(), READINESS_TIMEOUT_MS, 'redis check').catch(() => false),
    withTimeout(migrationState(), READINESS_TIMEOUT_MS, 'migration check').catch(
      (): MigrationState => 'unknown',
    ),
  ]);

  return { ok: database && redis && migrations === 'applied', checks: { database, redis, migrations } };
}

healthRouter.get('/health/ready', async (_req, res) => {
  const now = Date.now();
  if (!readinessCache || now - readinessCache.at > READINESS_CACHE_MS) {
    readinessCache = { at: now, value: await gatherReadiness() };
  }
  const value = readinessCache.value;

  // The body names WHICH dependency is down — that is the whole diagnostic
  // value of the endpoint — but it carries no connection string, no host and no
  // error text. "database": false is actionable; the DSN in the exception is a
  // credential.
  res.status(value.ok ? 200 : 503).json(value);
});

// ─── Redis handle for metric collection ──────────────────────────────────────

/**
 * A connection of its own, separate from the queue producer's.
 *
 * ioredis multiplexes every command onto one socket, so a SCAN issued for a
 * scrape would sit in front of the enqueues a customer's CI run is waiting on.
 * Metrics collection must never be able to slow down the thing it measures.
 *
 * Created lazily so importing this module — in a test, or in a process that
 * never scrapes — does not open a socket.
 */
let metricsRedis: IORedis | null = null;

function redisForMetrics(): IORedis {
  if (metricsRedis) return metricsRedis;
  const client = new IORedis(env.REDIS_URL, {
    // A scrape is disposable, so it must fail fast rather than pile up — but
    // the bound belongs on the COLLECTOR, not on the socket. `enableOfflineQueue:
    // false` looks like the fast-fail knob and is a trap: because this client is
    // created lazily, the very first command of the very first scrape races the
    // TCP connect and throws "Stream isn't writeable". Observed exactly that —
    // every worker metric missing from the first scrape after boot, and again
    // after any Redis blip, because during a reconnect every command is refused
    // instead of waiting.
    //
    // So the offline queue stays on (its default) and `collect()` puts a hard
    // COLLECT_TIMEOUT_MS around each collector. One bound, in one place, that
    // covers connecting and querying alike.
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
  });
  // Without a listener, ioredis emits 'error' as an unhandled event and takes
  // the process down — the monitoring killing the service it monitors.
  client.on('error', (err) => logger.debug({ err }, 'metrics redis error'));
  metricsRedis = client;
  return client;
}

/** Release the metrics connection. For graceful shutdown; see needsOwnerDecision. */
export async function closeMetricsRedis(): Promise<void> {
  metricsRedis?.disconnect();
  metricsRedis = null;
}

// ─── Collectors ──────────────────────────────────────────────────────────────

/**
 * The single deadline every collector runs under — covering connecting to a
 * dependency as well as querying it, which is why no collector needs a timeout
 * knob of its own.
 */
const COLLECT_TIMEOUT_MS = 3_000;

/**
 * Run one collector, swallowing its failure.
 *
 * A scrape is all-or-nothing to Prometheus: if this endpoint 500s because one
 * aggregate was slow, the operator loses every metric, including the ones that
 * would have explained why. So each collector fails alone, increments
 * `qaai_metrics_collect_errors_total`, and leaves its gauges at their last
 * value — which the counter is there to warn you about.
 */
async function collect(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await withTimeout(fn(), COLLECT_TIMEOUT_MS, `${name} collector`);
  } catch (err) {
    collectErrors.inc({ collector: name });
    logger.debug({ err, collector: name }, 'metrics collector failed');
  }
}

async function collectRuns(): Promise<void> {
  const grouped = await unscoped(() =>
    prisma.run.groupBy({ by: ['status'], _count: { _all: true } }),
  );

  // Zero every status first. A gauge keeps its last value forever, so a status
  // that drops out of the result set would otherwise stay frozen at whatever it
  // was — and "5 runs stuck in RUNNING" that is actually stale is worse than no
  // metric, because someone will page on it.
  for (const status of RUN_STATUSES) runsByStatus.set(0, { status });
  for (const row of grouped) runsByStatus.set(row._count._all, { status: row.status });

  const oldest = await unscoped(() =>
    prisma.run.findFirst({
      where: { status: 'QUEUED' },
      orderBy: { queuedAt: 'asc' },
      select: { queuedAt: true },
    }),
  );
  oldestQueuedRunAge.set(oldest ? Math.max(0, (Date.now() - oldest.queuedAt.getTime()) / 1000) : 0);
}

async function collectRunners(): Promise<void> {
  const since = new Date(Date.now() - RUNNER_ONLINE_MS);
  const [registered, online] = await Promise.all([
    unscoped(() => prisma.runner.count({ where: { revokedAt: null } })),
    unscoped(() => prisma.runner.count({ where: { revokedAt: null, lastSeenAt: { gt: since } } })),
  ]);
  runnersRegistered.set(registered);
  runnersOnline.set(online);
}

async function collectQueues(): Promise<void> {
  const depths = await queueDepths();
  for (const [queue, depth] of Object.entries(depths)) queueDepth.set(depth, { queue });

  /*
   * Queue AGE, which depth alone cannot give you: a queue sitting at 40 because
   * it is busy looks identical to one sitting at 40 because nothing is draining
   * it, and only the second is an incident.
   *
   * BullMQ's public API for this needs a Queue instance per queue, each opening
   * its own connection — ten more sockets on every API process to read ten
   * numbers. So this reads the list layout directly: standard jobs are LPUSHed
   * onto `<prefix>:<queue>:wait` and workers RPOPLPUSH from the tail, so index
   * -1 is the oldest waiting job, and its hash carries `timestamp` in epoch ms.
   *
   * That is an internal layout, so it is treated as one: two pipelines, no
   * assumptions beyond those two keys, and any surprise leaves the gauge alone
   * and increments the collector's error counter rather than failing the scrape.
   */
  const redis = redisForMetrics();
  const queues = Object.values(QUEUE_NAMES);

  const headPipeline = redis.pipeline();
  for (const queue of queues) headPipeline.lindex(`bull:${queue}:wait`, -1);
  const heads = await headPipeline.exec();

  const pending: { queue: string; jobId: string }[] = [];
  queues.forEach((queue, i) => {
    const entry = heads?.[i];
    const jobId = entry && !entry[0] && typeof entry[1] === 'string' ? entry[1] : null;
    if (jobId) pending.push({ queue, jobId });
    // An empty queue has no oldest job; zero is the honest reading.
    else queueOldestAge.set(0, { queue });
  });

  if (pending.length === 0) return;

  const tsPipeline = redis.pipeline();
  for (const { queue, jobId } of pending) tsPipeline.hget(`bull:${queue}:${jobId}`, 'timestamp');
  const stamps = await tsPipeline.exec();

  const now = Date.now();
  pending.forEach(({ queue }, i) => {
    const entry = stamps?.[i];
    const raw = entry && !entry[0] && typeof entry[1] === 'string' ? Number(entry[1]) : NaN;
    // A job whose hash vanished between the two pipelines was just picked up.
    queueOldestAge.set(Number.isFinite(raw) ? Math.max(0, (now - raw) / 1000) : 0, { queue });
  });
}

/**
 * LLM spend for the current billing month.
 *
 * Cached far longer than the rest. `AgentCall` has no global `createdAt` index
 * (it is indexed per org, which is what the product queries), so this aggregate
 * is a range scan and must not run once per scrape. Spend is a number that
 * moves in dollars per hour; a minute of staleness costs nothing, and a scan
 * every fifteen seconds on a large install costs a lot.
 */
const LLM_CACHE_MS = 60_000;
let llmCollectedAt = 0;

async function collectLlmSpend(): Promise<void> {
  if (Date.now() - llmCollectedAt < LLM_CACHE_MS) return;

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [totals, failed] = await Promise.all([
    unscoped(() =>
      prisma.agentCall.aggregate({
        where: { createdAt: { gte: monthStart } },
        _sum: {
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          costCents: true,
        },
        _count: { _all: true },
      }),
    ),
    unscoped(() =>
      prisma.agentCall.count({ where: { createdAt: { gte: monthStart }, error: { not: null } } }),
    ),
  ]);

  llmTokensMonth.set(totals._sum.inputTokens ?? 0, { kind: 'input' });
  llmTokensMonth.set(totals._sum.outputTokens ?? 0, { kind: 'output' });
  llmTokensMonth.set(totals._sum.cacheReadTokens ?? 0, { kind: 'cache_read' });
  llmTokensMonth.set(totals._sum.cacheWriteTokens ?? 0, { kind: 'cache_write' });
  llmCostCentsMonth.set(totals._sum.costCents ?? 0);
  llmCallsMonth.set(Math.max(0, totals._count._all - failed), { outcome: 'ok' });
  llmCallsMonth.set(failed, { outcome: 'error' });

  llmCollectedAt = Date.now();
}

/**
 * Read every live worker's published snapshot.
 *
 * SCAN, never KEYS. This Redis also holds BullMQ's job data, and KEYS walks the
 * entire keyspace in one blocking call — on a busy install that stalls every
 * worker in the fleet for as long as it takes, which would make the metrics
 * endpoint the single biggest source of latency in the system.
 */
async function readWorkerSnapshots(): Promise<WorkerMetricsSnapshot[]> {
  const redis = redisForMetrics();
  const pattern = `${WORKER_METRICS_KEY_PREFIX}*`;
  const keys: string[] = [];

  let cursor = '0';
  // Bounded two ways: a key ceiling and an iteration ceiling. A SCAN loop that
  // trusts the cursor to terminate is a scrape that can hang forever.
  for (let i = 0; i < 64 && keys.length < 512; i++) {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    for (const key of batch) keys.push(key);
    cursor = next;
    if (cursor === '0') break;
  }

  if (keys.length === 0) return [];

  const raw = await redis.mget(...keys);
  const snapshots: WorkerMetricsSnapshot[] = [];
  let unreadable = 0;
  for (const value of raw) {
    if (value === null) continue; // expired between SCAN and MGET: that worker is gone
    const parsed = parseWorkerSnapshot(value);
    if (parsed) snapshots.push(parsed);
    else unreadable += 1;
  }
  // Its own collector label, distinct from the one `collect()` uses when this
  // function throws. "Redis is unreachable" and "a worker is publishing a shape
  // I do not recognise" have different fixes, and one counter for both would
  // make a rolling deploy look like an outage.
  if (unreadable > 0) collectErrors.inc({ collector: 'worker_snapshot_parse' }, unreadable);

  return snapshots;
}

// ─── /metrics ────────────────────────────────────────────────────────────────

/**
 * How long a rendered scrape is reused.
 *
 * Same reasoning as readiness, with more teeth: this endpoint runs several
 * database aggregates, and it is unauthenticated. Two seconds is well under any
 * scrape interval anyone configures, so a real Prometheus always gets fresh
 * numbers, while a flood gets one collection.
 */
const METRICS_CACHE_MS = 2_000;

let metricsCache: { at: number; body: string } | null = null;

async function renderMetrics(): Promise<string> {
  startProcessCollectors();
  collectProcessMetrics(SERVICE_NAME, VERSION);
  sseSubscribers.set(subscriberCount());

  let workers: WorkerMetricsSnapshot[] = [];

  await Promise.all([
    collect('runs', collectRuns),
    collect('runners', collectRunners),
    collect('queues', collectQueues),
    collect('llm_spend', collectLlmSpend),
    collect('worker_snapshots', async () => {
      workers = await readWorkerSnapshots();
    }),
  ]);

  return registry.render() + renderWorkerSnapshots(workers);
}

healthRouter.get('/metrics', async (_req, res) => {
  const now = Date.now();
  if (!metricsCache || now - metricsCache.at > METRICS_CACHE_MS) {
    try {
      metricsCache = { at: now, body: await renderMetrics() };
    } catch (err) {
      // Should be unreachable — every collector already fails alone — but a
      // metrics endpoint that can 500 is a metrics endpoint that goes dark
      // exactly when it is needed. Serve whatever the registry holds.
      logger.error({ err }, 'metrics render failed');
      collectErrors.inc({ collector: 'render' });
      metricsCache = { at: now, body: registry.render() };
    }
  }

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  // A scrape is a point-in-time reading; a cached one is a lie about "now".
  res.setHeader('Cache-Control', 'no-store');
  res.send(metricsCache.body);
});
