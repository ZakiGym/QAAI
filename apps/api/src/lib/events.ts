/**
 * Server-sent events for the cockpit's live view (§8 right pane).
 *
 * A single in-process hub. That is correct for one API instance and explicitly
 * not correct for several — a horizontally scaled deployment needs a Redis
 * pub/sub fan-out behind this same interface, which is why publishing goes
 * through `publish()` rather than callers touching the subscriber list.
 */

import type { Response } from 'express';
import { logger } from './logger.js';

export interface RunEvent {
  runId: string;
  type:
    'run.started' | 'run.finished' | 'test.started' | 'test.finished' | 'step' | 'verdict' | 'log';
  data: Record<string, unknown>;
  at: string;
}

interface Subscriber {
  orgId: string;
  runId: string;
  res: Response;
}

const subscribers = new Set<Subscriber>();

/** Heartbeat interval — proxies commonly drop an idle SSE stream at 60s. */
const KEEPALIVE_MS = 25_000;

export function subscribe(orgId: string, runId: string, res: Response): () => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);

  const subscriber: Subscriber = { orgId, runId, res };
  subscribers.add(subscriber);

  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, KEEPALIVE_MS);

  return () => {
    clearInterval(keepalive);
    subscribers.delete(subscriber);
  };
}

export function publish(orgId: string, event: RunEvent): void {
  for (const subscriber of subscribers) {
    // Org check is not decoration: run ids are cuids, but a subscriber must
    // never receive another tenant's stream even if one is guessed.
    if (subscriber.orgId !== orgId || subscriber.runId !== event.runId) continue;
    try {
      subscriber.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      logger.warn({ err }, 'sse write failed; dropping subscriber');
      subscribers.delete(subscriber);
    }
  }
}

export function subscriberCount(): number {
  return subscribers.size;
}

/**
 * Relay from the worker.
 *
 * Runs execute in the worker process, so their progress events arrive over a
 * Redis channel rather than through a direct `publish()` call. This subscriber
 * is what makes the cockpit's live view work at all — without it, a run only
 * appears to update when the page is refreshed.
 */
export function startWorkerEventRelay(redisUrl: string): void {
  // Lazy import keeps ioredis out of the module graph for tests that never
  // touch the relay.
  void import('ioredis').then(({ default: IORedis }) => {
    const subscriber = new IORedis(redisUrl, { maxRetriesPerRequest: null });

    subscriber.on('error', (err) => logger.warn({ err }, 'event relay redis error'));

    subscriber.subscribe('qaai:events', (err) => {
      if (err) logger.error({ err }, 'could not subscribe to the worker event channel');
      else logger.info('worker event relay connected');
    });

    subscriber.on('message', (_channel, raw) => {
      try {
        const { orgId, event } = JSON.parse(raw) as { orgId: string; event: RunEvent };
        publish(orgId, event);
      } catch (err) {
        logger.warn({ err }, 'malformed event on the worker channel');
      }
    });
  });
}
