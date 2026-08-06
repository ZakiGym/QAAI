/**
 * Delivery tests for the notify processor (§7).
 *
 * The property under test is not "the POST happens" — it is that every attempt
 * leaves a record a customer can read. A notification that silently failed is
 * indistinguishable from one that was never sent, so nearly every test here
 * ends by looking at what landed on the WebhookDelivery row: the attempt
 * count, the status, and an error string that never echoes the webhook URL —
 * because the URL IS the credential.
 *
 * The retry contract matters most at its two edges, and both get their own
 * tests: a failure with retries remaining must re-throw (that throw is what
 * makes the QUEUE schedule the retry), and the LAST attempt must swallow the
 * throw and flip the row to FAILED — the row is the dead letter, and a job
 * that kept failing after the dead letter was written would be a second,
 * disagreeing record of the same event.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The worker's context opens Postgres, Redis and the LLM at import time, so it
// is replaced wholesale; `h.prisma` is swapped per test through the proxy.
const h = vi.hoisted(
  (): { prisma: Record<string, unknown>; log: string[]; enqueued: unknown[] } => ({
    prisma: {},
    log: [],
    enqueued: [],
  }),
);

vi.mock('../context.js', () => ({
  config: { artifactsLocal: true },
  connection: {},
  logger: {
    debug: () => {},
    info: (_o: unknown, msg?: string) => h.log.push(`info:${msg ?? ''}`),
    warn: (_o: unknown, msg?: string) => h.log.push(`warn:${msg ?? ''}`),
    error: (_o: unknown, msg?: string) => h.log.push(`error:${msg ?? ''}`),
  },
  prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
}));

// The producer half is queue plumbing; these tests only care WHAT was asked
// for. The delivery jobs themselves are driven by calling processDelivery
// directly with the attempt metadata index.ts would pass.
vi.mock('../queues.js', () => ({
  enqueueDelivery: async (job: unknown) => {
    h.enqueued.push(job);
  },
}));

// The vault stand-in unwraps anything this file sealed with `sealed()` below
// and fails closed on everything else — the same two outcomes the real
// AES-GCM open has.
vi.mock('../vault.js', () => ({
  open: (enc: string): string => {
    if (enc.startsWith('sealed:')) return enc.slice('sealed:'.length);
    throw new Error('wrong key version');
  },
}));

const { processDelivery, processNotify } = await import('./notify.js');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SLACK_URL = 'https://hooks.slack.com/services/T0/B0/secret-token';

/**
 * `configEnc` as the API's chat CRUD writes it: the credential envelope —
 * the URL, plus the WEBHOOK signing secret when one exists — vault-sealed.
 * The URL is the credential, so it never appears in `config`.
 */
const sealed = (url: string, secret?: string): string =>
  `sealed:${JSON.stringify(secret ? { url, secret } : { url })}`;

interface IntegrationRow {
  id: string;
  kind: string;
  config: Record<string, unknown>;
  configEnc?: string | null;
  enabled?: boolean;
}

const slack = (over: Partial<IntegrationRow> = {}): IntegrationRow => ({
  id: 'int1',
  kind: 'SLACK',
  config: {},
  configEnc: sealed(SLACK_URL),
  enabled: true,
  ...over,
});

/** What `integration.findMany` returns to the fan-out. */
function fanOutDb(integrations: IntegrationRow[]): {
  created: Array<Record<string, unknown>>;
  updatedIds: string[];
} {
  const byId = new Map<string, Record<string, unknown>>();
  const created: Array<Record<string, unknown>> = [];
  const updatedIds: string[] = [];

  h.prisma = {
    integration: { findMany: async () => integrations },
    webhookDelivery: {
      upsert: async (args: {
        where: { id: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        if (byId.has(args.where.id)) {
          updatedIds.push(args.where.id);
          return byId.get(args.where.id);
        }
        byId.set(args.where.id, args.create);
        created.push(args.create);
        return args.create;
      },
    },
  };

  return { created, updatedIds };
}

/** One delivery row and its integration, as processDelivery re-reads them. */
function deliveryDb(opts: {
  row?: Record<string, unknown> | null;
  integration?: IntegrationRow | null;
  updateThrows?: boolean;
}): { updates: Array<Record<string, unknown>> } {
  const updates: Array<Record<string, unknown>> = [];
  h.prisma = {
    webhookDelivery: {
      findFirst: async () => opts.row ?? null,
      update: async (args: { data: Record<string, unknown> }) => {
        if (opts.updateThrows) throw new Error('database is on fire');
        updates.push(args.data);
        return args.data;
      },
    },
    integration: { findFirst: async () => opts.integration ?? null },
  };
  return { updates };
}

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'wd-1',
  integrationId: 'int1',
  status: 'PENDING',
  payload: { text: 'hello' },
  event: 'run.finished',
  ...over,
});

const JOB = { orgId: 'org1', deliveryId: 'wd-1' };
const FIRST_OF_FIVE = { attempt: 1, maxAttempts: 5 };
const LAST_OF_FIVE = { attempt: 5, maxAttempts: 5 };

interface FetchCall {
  url: string;
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: string;
    signal?: unknown;
  };
}

/** Replaces global fetch; the responder decides status or throws. */
function stubFetch(
  respond: (url: string) => { status: number } | Error = () => ({ status: 200 }),
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', async (url: string, init: FetchCall['init']) => {
    calls.push({ url, init });
    const out = respond(url);
    if (out instanceof Error) throw out;
    return { status: out.status, ok: out.status >= 200 && out.status < 300 };
  });
  return calls;
}

const monitorDown = {
  orgId: 'org1',
  event: 'monitor.down',
  payload: { name: 'checkout', streak: 3, runId: 'run9' },
};

beforeEach(() => {
  h.prisma = {};
  h.log = [];
  h.enqueued = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the fan-out records and enqueues; it sends nothing itself', () => {
  it('writes one PENDING row and queues one delivery job per usable destination', async () => {
    const fetches = stubFetch();
    const db = fanOutDb([
      slack(),
      slack({
        id: 'int2',
        kind: 'DISCORD',
        configEnc: sealed('https://discord.com/api/webhooks/1/t'),
      }),
    ]);

    await processNotify(monitorDown, 'job7');

    expect(db.created).toHaveLength(2);
    for (const created of db.created) {
      expect(created).toMatchObject({ status: 'PENDING', attempts: 0, event: 'monitor.down' });
      expect(String((created.payload as { text: string }).text)).toContain('checkout');
    }
    expect(h.enqueued).toEqual([
      { orgId: 'org1', deliveryId: 'wd-job7-int1' },
      { orgId: 'org1', deliveryId: 'wd-job7-int2' },
    ]);
    // The POST belongs to the delivery job, with the queue's retries behind it.
    expect(fetches).toHaveLength(0);
  });

  it('dead-letters a destination with no sealed credential, without queueing a job', async () => {
    // The URL lives in the vault now, so "no configEnc" is the one static
    // fact the fan-out can still check; everything about the URL itself is
    // the delivery job's to judge, after unsealing.
    const db = fanOutDb([slack({ id: 'c', configEnc: null })]);

    await processNotify(monitorDown, 'job7');

    expect(db.created).toHaveLength(1);
    expect(db.created[0]).toMatchObject({ status: 'FAILED', attempts: 0 });
    expect(db.created[0]!.lastError).toBeTruthy();
    expect(h.enqueued).toEqual([]);
  });

  it('fans out a generic WEBHOOK to a customer-chosen https host — the deliberate difference from the digest', async () => {
    const db = fanOutDb([
      slack({
        id: 'w1',
        kind: 'WEBHOOK',
        configEnc: sealed('https://ci.customer.example/hooks/qaai'),
      }),
    ]);

    await processNotify(monitorDown, 'job7');

    expect(db.created[0]).toMatchObject({ status: 'PENDING' });
    expect(h.enqueued).toEqual([{ orgId: 'org1', deliveryId: 'wd-job7-w1' }]);
  });

  it('re-claims the same rows and jobs when the notify job retries, instead of paging twice', async () => {
    stubFetch();
    const db = fanOutDb([slack()]);

    await processNotify(monitorDown, 'job7');
    await processNotify(monitorDown, 'job7');

    // Second pass upserted into the existing row rather than creating another…
    expect(db.created).toHaveLength(1);
    expect(db.updatedIds).toEqual(['wd-job7-int1']);
    // …and asked for the same delivery job, which enqueueDelivery's jobId
    // collapses onto the first.
    expect(h.enqueued).toEqual([
      { orgId: 'org1', deliveryId: 'wd-job7-int1' },
      { orgId: 'org1', deliveryId: 'wd-job7-int1' },
    ]);
  });

  it('does not let one unrecordable destination cost the others their page', async () => {
    const db = fanOutDb([slack(), slack({ id: 'int2' })]);
    const upsert = (h.prisma as { webhookDelivery: { upsert: (a: never) => unknown } })
      .webhookDelivery.upsert;
    (h.prisma as { webhookDelivery: { upsert: unknown } }).webhookDelivery.upsert = async (
      args: never,
    ) => {
      if ((args as { where: { id: string } }).where.id.endsWith('int1')) {
        throw new Error('deadlock detected');
      }
      return upsert(args);
    };

    await processNotify(monitorDown, 'job7');

    expect(db.created.map((c) => c.integrationId)).toEqual(['int2']);
    expect(h.enqueued).toEqual([{ orgId: 'org1', deliveryId: 'wd-job7-int2' }]);
    expect(h.log.some((l) => l.startsWith('error:could not record'))).toBe(true);
  });
});

describe('the run.finished preference is real', () => {
  const run = {
    id: 'run1',
    status: 'FAILED',
    prNumber: null,
    passedCount: 7,
    failedCount: 0,
    flakyCount: 0,
    gateResult: null,
    projectId: 'p1',
    results: [],
  };
  const finished = { orgId: 'org1', event: 'run.finished', payload: { runId: 'run1' } };

  it('notifies nobody about a passing run by default, and fans out for a red one', async () => {
    stubFetch();
    let db = fanOutDb([slack()]);
    (h.prisma as Record<string, unknown>).run = { findFirst: async () => run };

    await processNotify(finished, 'j1');
    expect(db.created).toHaveLength(0);
    expect(h.enqueued).toEqual([]);

    db = fanOutDb([slack()]);
    (h.prisma as Record<string, unknown>).run = {
      findFirst: async () => ({ ...run, failedCount: 2 }),
    };
    await processNotify(finished, 'j1');
    expect(db.created[0]).toMatchObject({ event: 'run.finished', status: 'PENDING' });
    expect(h.enqueued).toHaveLength(1);
  });

  it('sends a green run to an integration that asked for every run, and only to it', async () => {
    stubFetch();
    const db = fanOutDb([
      slack(), // default: failures only — hears nothing about a green run
      slack({ id: 'int2', config: { notify: { runFinished: 'all', digest: true } } }),
    ]);
    (h.prisma as Record<string, unknown>).run = { findFirst: async () => run };

    await processNotify(finished, 'j1');

    expect(db.created).toHaveLength(1);
    expect(String((db.created[0]! as { payload: { text: string } }).payload.text)).toContain('✅');
    expect(h.enqueued).toEqual([{ orgId: 'org1', deliveryId: 'wd-j1-int2' }]);
  });

  it('keeps a red run away from a channel switched off', async () => {
    stubFetch();
    const db = fanOutDb([slack({ config: { notify: { runFinished: 'off', digest: true } } })]);
    (h.prisma as Record<string, unknown>).run = {
      findFirst: async () => ({ ...run, failedCount: 2 }),
    };

    await processNotify(finished, 'j1');

    // No row at all: a preference honoured is not a failed delivery, and it
    // does not belong in the delivery log.
    expect(db.created).toHaveLength(0);
    expect(h.enqueued).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('processDelivery records every attempt on the row', () => {
  it('marks a landed POST SENT, with the response status and a cleared error', async () => {
    const fetches = stubFetch(() => ({ status: 200 }));
    const db = deliveryDb({ row: row(), integration: slack() });

    await processDelivery(JOB, FIRST_OF_FIVE);

    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.url).toBe(SLACK_URL);
    expect(fetches[0]!.init.body).toBe(JSON.stringify({ text: 'hello' }));
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toMatchObject({
      attempts: { increment: 1 },
      status: 'SENT',
      responseStatus: 200,
      lastError: null,
    });
    expect(db.updates[0]!.deliveredAt).toBeInstanceOf(Date);
  });

  it('carries the ported hardening on the request itself: bounded, no redirects, named agent', async () => {
    const fetches = stubFetch();
    deliveryDb({ row: row(), integration: slack() });

    await processDelivery(JOB, FIRST_OF_FIVE);

    const init = fetches[0]!.init;
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toMatchObject({ 'user-agent': 'qaai', 'content-type': 'application/json' });
  });

  it('speaks Discord to Discord', async () => {
    const fetches = stubFetch();
    deliveryDb({
      row: row(),
      integration: slack({
        kind: 'DISCORD',
        configEnc: sealed('https://discord.com/api/webhooks/1/t'),
      }),
    });

    await processDelivery(JOB, FIRST_OF_FIVE);

    expect(fetches[0]!.init.body).toBe(JSON.stringify({ content: 'hello' }));
  });

  it('signs a generic WEBHOOK — with the event alongside — and records the signature it sent', async () => {
    const fetches = stubFetch();
    const db = deliveryDb({
      row: row(),
      integration: slack({
        kind: 'WEBHOOK',
        configEnc: sealed('https://ci.customer.example/hooks/qaai', 'topsecret'),
      }),
    });

    await processDelivery(JOB, FIRST_OF_FIVE);

    // The generic-webhook body names the event so a receiver can route
    // without parsing prose; the signature covers exactly these bytes.
    const body = JSON.stringify({ event: 'run.finished', text: 'hello' });
    expect(fetches[0]!.init.body).toBe(body);
    const expected = `sha256=${createHmac('sha256', 'topsecret').update(body).digest('hex')}`;
    expect(fetches[0]!.init.headers?.['x-qaai-signature-256']).toBe(expected);
    expect(db.updates[0]).toMatchObject({ status: 'SENT', signature: expected });
  });

  it('sends NOTHING when the credential envelope cannot be unsealed, and counts the attempt', async () => {
    const fetches = stubFetch();
    const db = deliveryDb({
      row: row(),
      integration: slack({
        kind: 'WEBHOOK',
        configEnc: 'rotated-away-under-an-old-key',
      }),
    });

    await expect(processDelivery(JOB, FIRST_OF_FIVE)).rejects.toThrow();

    expect(fetches).toHaveLength(0);
    expect(db.updates[0]).toMatchObject({
      attempts: { increment: 1 },
      status: 'PENDING',
      lastError: expect.stringContaining('credentials') as unknown,
    });
  });

  it('refuses a wrong host on the unsealed URL — pinned at delivery, not just at the door', async () => {
    const fetches = stubFetch();
    const db = deliveryDb({
      row: row(),
      integration: slack({
        configEnc: sealed('https://attacker.example.com/services/T0/B0/secret-token'),
      }),
    });

    await expect(processDelivery(JOB, FIRST_OF_FIVE)).rejects.toThrow();

    expect(fetches).toHaveLength(0);
    expect(String(db.updates[0]!.lastError)).toContain('not a SLACK webhook host');
    // The path may be a credential; the recorded reason names the host only.
    expect(String(db.updates[0]!.lastError)).not.toContain('secret-token');
  });

  it('records an unparseable unsealed URL without echoing it', async () => {
    const fetches = stubFetch();
    const db = deliveryDb({
      row: row(),
      integration: slack({ configEnc: sealed('::not a url with a secret-token::') }),
    });

    await expect(processDelivery(JOB, FIRST_OF_FIVE)).rejects.toThrow();

    expect(fetches).toHaveLength(0);
    expect(db.updates[0]!.lastError).toBeTruthy();
    expect(String(db.updates[0]!.lastError)).not.toContain('secret-token');
  });

  it('stays PENDING on a failure with retries remaining, and re-throws so the queue retries', async () => {
    stubFetch(() => ({ status: 500 }));
    const db = deliveryDb({ row: row(), integration: slack() });

    // The throw IS the retry mechanism: BullMQ sees the failure and schedules
    // the next attempt with backoff. Swallowing it here would end the story at
    // one attempt while the row promises five.
    await expect(processDelivery(JOB, FIRST_OF_FIVE)).rejects.toThrow('HTTP 500');

    expect(db.updates[0]).toMatchObject({
      attempts: { increment: 1 },
      status: 'PENDING',
      responseStatus: 500,
      lastError: 'HTTP 500',
    });
  });

  it('treats a 3xx as an error, never as a hop', async () => {
    const fetches = stubFetch(() => ({ status: 302 }));
    const db = deliveryDb({ row: row(), integration: slack() });

    await expect(processDelivery(JOB, FIRST_OF_FIVE)).rejects.toThrow();

    expect(fetches[0]!.init.redirect).toBe('manual');
    expect(db.updates[0]).toMatchObject({ lastError: 'redirected; not followed' });
  });

  it('records a timeout as a bounded sentence', async () => {
    stubFetch(() => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      return err;
    });
    const db = deliveryDb({ row: row(), integration: slack() });

    await expect(processDelivery(JOB, FIRST_OF_FIVE)).rejects.toThrow();

    expect(db.updates[0]).toMatchObject({ lastError: 'no answer within 15s' });
  });

  it('never echoes the runtime error — a fetch failure embeds the URL, and the URL is the credential', async () => {
    stubFetch(() => new Error(`connect ECONNREFUSED ${SLACK_URL}`));
    const db = deliveryDb({ row: row(), integration: slack() });

    await expect(processDelivery(JOB, FIRST_OF_FIVE)).rejects.toThrow();

    expect(db.updates[0]!.lastError).toBe('delivery failed');
  });

  it('re-validates the URL each attempt, so a config gone bad mid-retry is recorded, not sent to', async () => {
    const fetches = stubFetch();
    const db = deliveryDb({
      row: row(),
      integration: slack({ configEnc: sealed('http://hooks.slack.com/services/T/B/x') }),
    });

    await expect(processDelivery(JOB, FIRST_OF_FIVE)).rejects.toThrow();

    expect(fetches).toHaveLength(0);
    expect(db.updates[0]).toMatchObject({ status: 'PENDING' });
  });
});

describe('the dead letter is the row', () => {
  it('flips the row to FAILED with the final error on the last attempt, and stops throwing', async () => {
    stubFetch(() => ({ status: 503 }));
    const db = deliveryDb({ row: row(), integration: slack() });

    /*
     * No rejection on the final attempt, on purpose. The row — FAILED, with
     * the error that killed it — is the dead letter, readable through
     * GET /integrations/:id/deliveries. A BullMQ job left failing on top of it
     * would be a second record of the same event for an operator to reconcile.
     */
    await expect(processDelivery(JOB, LAST_OF_FIVE)).resolves.toBeUndefined();

    expect(db.updates[0]).toMatchObject({
      attempts: { increment: 1 },
      status: 'FAILED',
      responseStatus: 503,
      lastError: 'HTTP 503',
    });
    expect(h.log.some((l) => l.startsWith('error:') && l.includes('dead-letter'))).toBe(true);
  });

  it('never re-sends a delivery that already landed', async () => {
    const fetches = stubFetch();
    const db = deliveryDb({ row: row({ status: 'SENT' }), integration: slack() });

    await processDelivery(JOB, { attempt: 2, maxAttempts: 5 });

    expect(fetches).toHaveLength(0);
    expect(db.updates).toHaveLength(0);
  });

  it('drops the job when the row is gone — deleting an integration cascades its record', async () => {
    const fetches = stubFetch();
    deliveryDb({ row: null });

    await expect(processDelivery(JOB, FIRST_OF_FIVE)).resolves.toBeUndefined();

    expect(fetches).toHaveLength(0);
    expect(h.log.some((l) => l.startsWith('warn:') && l.includes('gone'))).toBe(true);
  });

  it('dead-letters at once when the integration was disabled mid-retry', async () => {
    const fetches = stubFetch();
    const db = deliveryDb({ row: row(), integration: slack({ enabled: false }) });

    await expect(processDelivery(JOB, FIRST_OF_FIVE)).resolves.toBeUndefined();

    expect(fetches).toHaveLength(0);
    expect(db.updates[0]).toMatchObject({
      status: 'FAILED',
      lastError: expect.stringContaining('disabled') as unknown,
    });
  });

  it('does not throw when a landed POST cannot be recorded — a retry would page twice', async () => {
    stubFetch(() => ({ status: 200 }));
    deliveryDb({ row: row(), integration: slack(), updateThrows: true });

    await expect(processDelivery(JOB, FIRST_OF_FIVE)).resolves.toBeUndefined();

    expect(h.log.some((l) => l.startsWith('error:') && l.includes('could not record'))).toBe(true);
  });
});
