/**
 * Worker metrics (§11) — the producing half of the observability story.
 *
 * The worker has no HTTP listener and should not grow one. An extra port means
 * an extra thing to bind, firewall, health-check and accidentally expose, and
 * the on-prem tier is precisely where "one more open port" is a procurement
 * conversation. So instead of serving metrics, the worker PUBLISHES them: a JSON
 * snapshot written to a short-lived Redis key every few seconds, which the API
 * reads and renders at /metrics alongside its own.
 *
 * That choice buys liveness for free. The key carries a TTL of a few publish
 * intervals, so a worker that dies — cleanly, by SIGKILL, or by having its
 * machine unplugged — stops having a key, and its series vanish from the next
 * scrape. Nothing has to observe the death and record it, which matters because
 * the only process in a position to write "I am down" is the one that just went
 * down. This is the same reasoning as `Runner.lastSeenAt` in the schema: derive
 * liveness from the last sign of life, never store a status.
 *
 * NOTHING TENANT-DERIVED IS PUBLISHED. /metrics is unauthenticated, so no org
 * id, no project, no test name, no URL and no branch may appear here. The only
 * labels are queue names (our constants), test types (a closed 19-member set)
 * and a random per-process instance id.
 */

import { randomBytes } from 'node:crypto';
import { TEST_TYPES } from '@qaai/shared';
import { config, connection, logger } from './context.js';

/**
 * Wire contract with apps/api/src/lib/metrics.ts.
 *
 * Duplicated rather than imported, and the duplication is the point: the API's
 * metrics module imports express-rate-limit, which is not a worker dependency,
 * and pulling it into this process's module graph to share an interface would be
 * a real cost for a compile-time convenience. The API validates every field it
 * reads (`parseWorkerSnapshot`), so a drift between these two files degrades to
 * "that worker's metrics are missing" rather than to a corrupt scrape body.
 *
 * Bump VERSION on any shape change. The reader discards snapshots whose version
 * it does not recognise, which is what makes a rolling deploy — old workers and
 * a new API running side by side for a few minutes — safe.
 */
export const WORKER_SNAPSHOT_VERSION = 1;
export const WORKER_METRICS_KEY_PREFIX = 'qaai:metrics:worker:';

interface WireHistogram {
  le: number[];
  counts: number[];
  sum: number;
  count: number;
}

interface WorkerMetricsSnapshot {
  v: number;
  instance: string;
  startedAtMs: number;
  publishedAtMs: number;
  concurrency: number;
  jobs: Record<string, Record<string, number>>;
  active: Record<string, number>;
  jobDuration: Record<string, WireHistogram>;
  pluginDuration: Record<string, WireHistogram>;
}

/**
 * A random id, deliberately NOT the hostname.
 *
 * The API publishes this label on an unauthenticated endpoint, and a customer's
 * host naming ("acme-prod-worker-01", "eu-west-payments-runner-3") is itself
 * information about their infrastructure. A random id identifies the process
 * just as well for the one thing the label is for — keeping each process's
 * counters on their own monotonic series — and reveals nothing.
 */
const INSTANCE = randomBytes(8).toString('hex');

const STARTED_AT_MS = Date.now();

/**
 * Job durations, in seconds. The top bucket is an hour because a run job holds a
 * browser for the whole of a customer's suite, and a suite that takes 40 minutes
 * is normal rather than pathological.
 */
const JOB_DURATION_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1_800, 3_600] as const;

/** Per-test execution, in seconds. Finer at the bottom: most tests are seconds. */
const PLUGIN_DURATION_BUCKETS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300] as const;

/**
 * Ceilings on distinct label values. Both label sets are closed by construction
 * (queue names and TEST_TYPES), so these can only be reached by a bug — and when
 * one is, the process keeps running with an incomplete metric instead of growing
 * a map without bound inside a long-lived worker.
 */
const MAX_QUEUE_SERIES = 32;
const MAX_PLUGIN_SERIES = 64;

class Histogram {
  private readonly counts: number[];
  private sum = 0;
  private count = 0;

  constructor(private readonly buckets: readonly number[]) {
    this.counts = new Array<number>(buckets.length).fill(0);
  }

  observe(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.count += 1;
    this.sum += seconds;
    for (let i = 0; i < this.buckets.length; i++) {
      if (seconds <= this.buckets[i]!) this.counts[i] = (this.counts[i] ?? 0) + 1;
    }
  }

  toWire(): WireHistogram {
    return { le: [...this.buckets], counts: [...this.counts], sum: this.sum, count: this.count };
  }
}

const jobCounts = new Map<string, Map<string, number>>();
const activeJobs = new Map<string, number>();
const jobDurations = new Map<string, Histogram>();
const pluginDurations = new Map<string, Histogram>();

/** Label values we will publish, from a closed set. Anything else folds here. */
const UNKNOWN_LABEL = 'unknown';

function boundedLabel(raw: string, allowed: ReadonlySet<string> | null, seen: number, max: number): string {
  if (allowed && !allowed.has(raw)) return UNKNOWN_LABEL;
  if (!/^[A-Za-z0-9_.:-]{1,48}$/.test(raw)) return UNKNOWN_LABEL;
  if (seen >= max) return UNKNOWN_LABEL;
  return raw;
}

const TEST_TYPE_SET: ReadonlySet<string> = new Set<string>(TEST_TYPES);

/**
 * Every queue label this process has ever recorded. Kept separately from the
 * three maps below so the ceiling is counted once — checking `jobDurations.size`
 * from `jobStarted` would let the active-jobs map grow past the cap while the
 * duration map was still empty.
 */
const knownQueues = new Set<string>();

function queueLabel(queue: string): string {
  if (knownQueues.has(queue)) return queue;
  const label = boundedLabel(queue, null, knownQueues.size, MAX_QUEUE_SERIES);
  if (label !== UNKNOWN_LABEL) knownQueues.add(label);
  return label;
}

// ─── Recording ───────────────────────────────────────────────────────────────

/** Call when a job begins executing. Pair with `jobFinished` in a finally. */
export function jobStarted(queue: string): void {
  const q = queueLabel(queue);
  activeJobs.set(q, (activeJobs.get(q) ?? 0) + 1);
}

/**
 * Call when a job stops executing, whichever way it stopped.
 *
 * `outcome` is a closed vocabulary rather than free text: "completed" and
 * "failed" are what an alert is written against, and letting a caller pass an
 * error message here would put a customer's URL into a public metric label.
 */
export function jobFinished(queue: string, outcome: 'completed' | 'failed', seconds: number): void {
  const q = queueLabel(queue);

  const active = (activeJobs.get(q) ?? 0) - 1;
  // Clamped at zero: a `finally` that runs without a matching `jobStarted` (a
  // handler that threw during setup) must not drive the gauge negative and make
  // the fleet look idle while it is saturated.
  activeJobs.set(q, Math.max(0, active));

  let byOutcome = jobCounts.get(q);
  if (!byOutcome) {
    byOutcome = new Map();
    jobCounts.set(q, byOutcome);
  }
  byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);

  let hist = jobDurations.get(q);
  if (!hist) {
    hist = new Histogram(JOB_DURATION_BUCKETS);
    jobDurations.set(q, hist);
  }
  hist.observe(seconds);
}

/**
 * Record one test's execution time through a plugin.
 *
 * Labelled by TEST TYPE, never by test id or test name. Two independent reasons
 * and either alone would be sufficient: a label per test is one Prometheus
 * series per test, which does not survive a customer with 20,000 of them; and a
 * test name is customer data ("checkout with saved Amex fails on staging"),
 * which has no business on an unauthenticated endpoint.
 */
export function pluginExecuted(testType: string, seconds: number): void {
  const label = boundedLabel(testType, TEST_TYPE_SET, pluginDurations.size, MAX_PLUGIN_SERIES);
  let hist = pluginDurations.get(label);
  if (!hist) {
    hist = new Histogram(PLUGIN_DURATION_BUCKETS);
    pluginDurations.set(label, hist);
  }
  hist.observe(seconds);
}

/** Time `fn` and record it as a plugin execution, whatever the outcome. */
export async function timePluginExecution<T>(testType: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    // A test that threw still consumed the time, and a duration histogram that
    // silently omits failures makes a broken suite look fast.
    pluginExecuted(testType, (Date.now() - started) / 1000);
  }
}

// ─── Publishing ──────────────────────────────────────────────────────────────

/** How often the snapshot is written. */
export const PUBLISH_INTERVAL_MS = 10_000;

/**
 * How long the key survives without a refresh.
 *
 * Three intervals, not one. A single missed publish is a GC pause or a Redis
 * blip; declaring a worker dead for that would page somebody at 3am about a
 * process that is fine. Three consecutive misses is a real signal.
 */
export const PUBLISH_TTL_SECONDS = (PUBLISH_INTERVAL_MS / 1000) * 3;

export function metricsKey(): string {
  return WORKER_METRICS_KEY_PREFIX + INSTANCE;
}

export function snapshot(): WorkerMetricsSnapshot {
  const jobs: Record<string, Record<string, number>> = {};
  for (const [queue, byOutcome] of jobCounts) jobs[queue] = Object.fromEntries(byOutcome);

  const jobDuration: Record<string, WireHistogram> = {};
  for (const [queue, hist] of jobDurations) jobDuration[queue] = hist.toWire();

  const pluginDuration: Record<string, WireHistogram> = {};
  for (const [plugin, hist] of pluginDurations) pluginDuration[plugin] = hist.toWire();

  return {
    v: WORKER_SNAPSHOT_VERSION,
    instance: INSTANCE,
    startedAtMs: STARTED_AT_MS,
    publishedAtMs: Date.now(),
    concurrency: config.concurrency,
    jobs,
    active: Object.fromEntries(activeJobs),
    jobDuration,
    pluginDuration,
  };
}

type MetricsRedis = Pick<typeof connection, 'set' | 'del'>;

let timer: NodeJS.Timeout | null = null;

async function publishOnce(redis: MetricsRedis): Promise<void> {
  await redis.set(metricsKey(), JSON.stringify(snapshot()), 'EX', PUBLISH_TTL_SECONDS);
}

/**
 * Begin publishing. Idempotent; safe to call from the worker's boot path.
 *
 * Every failure is swallowed at debug level. This is monitoring, and monitoring
 * that can take down the thing it monitors is worse than no monitoring at all —
 * a Redis hiccup must never fail a customer's run because the metrics writer
 * threw inside an unhandled rejection.
 */
export function startMetricsPublisher(redis: MetricsRedis = connection): void {
  if (timer) return;

  void publishOnce(redis).catch(() => {});
  timer = setInterval(() => {
    void publishOnce(redis).catch((err) => {
      logger.debug({ err }, 'could not publish worker metrics');
    });
  }, PUBLISH_INTERVAL_MS);

  // Unref'd so the publisher can never be the reason the process refuses to
  // exit. A metrics timer that blocks a graceful shutdown turns a routine
  // deploy into a stuck rollout.
  timer.unref();
}

/**
 * Stop publishing and remove this worker's key.
 *
 * Called on shutdown so a worker that exits cleanly disappears from /metrics
 * immediately rather than lingering for the TTL. The delete is best-effort —
 * the TTL is the real guarantee, and this is only the courtesy that keeps a
 * rolling deploy from showing thirty seconds of phantom workers.
 */
export async function stopMetricsPublisher(redis: MetricsRedis = connection): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await redis.del(metricsKey()).catch(() => {});
}
