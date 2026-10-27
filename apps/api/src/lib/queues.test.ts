/**
 * `enqueue` — the API's only producer, and the one every route goes through.
 *
 * It had no test, so the options it forwards were unguarded. That matters more
 * than it looks: each option is spread conditionally, and a route can pass one
 * perfectly and have it dropped here without anything failing. The route tests
 * mock this module, so they assert what the ROUTE asked for and can say nothing
 * about what BullMQ received — this file is the other half of that, and the only
 * place the two meet.
 *
 * The conditional spreads are also the reason `removeOnComplete: false` has to
 * be tested separately from `removeOnComplete: true`: a truthiness check reads
 * the two the same way and silently falls back to the queue default, which
 * retains the job for 24 hours and turns a per-project job id into a 24-hour
 * swallow. See `analyzeSourceJobOptions` in packages/shared/src/jobs.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface QueueAdd {
  queue: string;
  name: string;
  data: unknown;
  opts: Record<string, unknown>;
}

interface QueueBuild {
  name: string;
  opts: Record<string, unknown>;
}

const h = vi.hoisted((): { queueAdds: QueueAdd[]; builds: QueueBuild[] } => ({
  queueAdds: [],
  builds: [],
}));

vi.mock('../env.js', () => ({
  env: { REDIS_URL: 'redis://127.0.0.1:6379', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
  isProd: false,
}));

vi.mock('./logger.js', () => ({
  logger: {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  },
}));

// No socket is opened: the producer builds one shared connection at import time.
vi.mock('ioredis', () => ({
  default: class {
    on(): this {
      return this;
    }
    async ping(): Promise<string> {
      return 'PONG';
    }
    disconnect(): void {}
  },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(
      public queueName: string,
      opts: Record<string, unknown>,
    ) {
      h.builds.push({ name: queueName, opts });
    }
    async add(
      name: string,
      data: unknown,
      opts: Record<string, unknown>,
    ): Promise<{ id: string }> {
      h.queueAdds.push({ queue: this.queueName, name, data, opts });
      return { id: typeof opts.jobId === 'string' ? opts.jobId : `${name}-1` };
    }
    async getWaitingCount(): Promise<number> {
      return 0;
    }
    async close(): Promise<void> {}
  },
}));

const { enqueue } = await import('./queues.js');
const { analyzeSourceJobOptions } = await import('@qaai/shared');

const PAYLOAD = {
  orgId: 'org_1',
  projectId: 'proj_1',
  requestedBy: 'user_1',
  autoApprove: false,
};

const lastOpts = (): Record<string, unknown> => h.queueAdds.at(-1)!.opts;

beforeEach(() => {
  h.queueAdds.length = 0;
});

describe('enqueue', () => {
  it('adds to the queue named by the job, and returns the job id', async () => {
    const id = await enqueue('qaai.analyze-source', PAYLOAD);
    expect(h.queueAdds.at(-1)?.queue).toBe('qaai.analyze-source');
    expect(h.queueAdds.at(-1)?.data).toEqual(PAYLOAD);
    expect(id).toBe('qaai.analyze-source-1');
  });

  it('passes nothing it was not given, so the queue defaults still apply', async () => {
    await enqueue('qaai.analyze-source', PAYLOAD);
    expect(lastOpts()).toEqual({});
  });

  /*
   * THE PASSTHROUGH THE ANALYZE-SOURCE FIX RESTS ON. The route hands over
   * `analyzeSourceJobOptions(projectId)`; if any one of the four is dropped
   * here, the route's own test still passes — it mocks this module — and the
   * job silently reverts to three attempts and a 24-hour retained id.
   */
  it('forwards every option the analyze-source producer depends on', async () => {
    await enqueue('qaai.analyze-source', PAYLOAD, analyzeSourceJobOptions('proj_1'));
    expect(lastOpts()).toEqual({
      jobId: 'analyze-source-proj_1',
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });
  });

  it('forwards a delay as BullMQ spells it', async () => {
    await enqueue('qaai.analyze-source', PAYLOAD, { delayMs: 5_000 });
    expect(lastOpts()).toEqual({ delay: 5_000 });
  });

  /*
   * `false` is a real answer and must reach BullMQ. A truthiness check would
   * drop it and fall back to the queue default — which RETAINS the job, the
   * exact condition a per-project job id must never meet.
   */
  it('forwards removeOnComplete: false rather than treating it as unset', async () => {
    await enqueue('qaai.analyze-source', PAYLOAD, {
      removeOnComplete: false,
      removeOnFail: false,
    });
    expect(lastOpts()).toEqual({ removeOnComplete: false, removeOnFail: false });
  });

  it('reuses one Queue per name, because a client per enqueue exhausts Redis', async () => {
    const before = h.builds.filter((b) => b.name === 'qaai.generate').length;
    await enqueue('qaai.generate', { orgId: 'org_1', planItemIds: ['pi_1'] } as never);
    await enqueue('qaai.generate', { orgId: 'org_1', planItemIds: ['pi_2'] } as never);
    expect(h.builds.filter((b) => b.name === 'qaai.generate').length).toBe(before + 1);
  });

  /*
   * The default this file's conditional spreads fall back to. A non-idempotent
   * processor that forgets `attempts: 1` inherits three, which is how
   * analyze-source came to propose a plan twice.
   */
  it('builds every queue with three attempts by default', async () => {
    await enqueue('qaai.notify', { orgId: 'org_1', event: 'x', payload: {} } as never);
    const built = h.builds.find((b) => b.name === 'qaai.notify');
    expect(built?.opts.defaultJobOptions).toMatchObject({ attempts: 3 });
  });
});
