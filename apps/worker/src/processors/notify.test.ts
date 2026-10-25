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

const {
  blockingGateRules,
  failureOwnerKey,
  processDelivery,
  processNotify,
  renderMonitorAlert,
  renderRunAlert,
  suppressedCauseCount,
} = await import('./notify.js');

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
    /*
     * Routing defaults: a run with no failing results to route. The tests that
     * are ABOUT routing replace these through routingDb() below. Without them
     * the pre-routing tests would exercise the degradation path instead of the
     * real one, which would pass for the wrong reason.
     */
    ownershipRule: { findMany: async () => [] },
    testResult: { findMany: async () => [] },
    triageVerdict: { update: async () => ({}), updateMany: async () => ({ count: 0 }) },
    user: { findMany: async () => [] },
    team: { findMany: async () => [] },
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
  vi.unstubAllEnvs();
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

// ─────────────────────────────────────────────────────────────────────────────
// The message itself
//
// An alert is only worth sending if the person reading it on a phone can act on
// it, so these assert the four things this file's messages used to omit: what
// happened, WHERE, which tests, and a link. The expectations are written out by
// hand rather than rebuilt from the renderer — a test that formats the string
// the same way the code does proves only that the code is self-consistent.
// ─────────────────────────────────────────────────────────────────────────────

const alertRun = (over: Record<string, unknown> = {}) => ({
  id: 'run1',
  passedCount: 41,
  failedCount: 2,
  flakyCount: 1,
  gateResult: null as unknown,
  project: { name: 'Storefront' } as { name: string } | null,
  environment: { name: 'staging' } as { name: string } | null,
  results: [
    {
      status: 'FAILED',
      test: { name: 'checkout applies a promo code', filePath: 'specs/checkout.spec.ts' },
    },
    { status: 'PASSED', test: { name: 'home renders', filePath: 'specs/home.spec.ts' } },
  ],
  ...over,
});

/** A gate result as evaluateGates writes it: BLOCK is the only paging action. */
const gate = (evaluations: Array<{ action: string; detail: string }>) => ({
  passed: evaluations.every((e) => e.action !== 'BLOCK'),
  evaluations,
});

describe('a run alert names what broke, where, and how to open it', () => {
  beforeEach(() => {
    vi.stubEnv('WEB_PUBLIC_URL', 'https://app.qaai.test');
  });

  it('leads with the counts, then the project and environment, then the failing tests', () => {
    const text = renderRunAlert(alertRun());
    const lines = text.split('\n');

    expect(lines[0]).toBe('❌ QAAI — 2 failed, 41 passed, 1 flaky');
    expect(lines[1]).toBe('Storefront · staging');
    expect(text).toContain('• checkout applies a promo code — specs/checkout.spec.ts');
    // Passing tests are not the alert. Listing them is how a page becomes a wall.
    expect(text).not.toContain('home renders');
  });

  it('always ends in a link to the run', () => {
    const lines = renderRunAlert(alertRun()).split('\n');
    expect(lines[lines.length - 1]).toBe('https://app.qaai.test/runs/run1');
  });

  it('names five failing tests and counts the rest, so a broken suite is not a wall of text', () => {
    const results = Array.from({ length: 7 }, (_, i) => ({
      status: 'FAILED',
      test: { name: `test ${i}`, filePath: `specs/${i}.spec.ts` },
    }));
    const text = renderRunAlert(alertRun({ failedCount: 7, results }));

    expect(text).toContain('• test 4 — specs/4.spec.ts');
    expect(text).not.toContain('• test 5 —');
    expect(text).toContain('• …and 2 more');
  });

  it('says a green run was blocked by the gate, and by WHICH rule', () => {
    const text = renderRunAlert(
      alertRun({
        failedCount: 0,
        flakyCount: 4,
        results: [],
        gateResult: gate([
          { action: 'BLOCK', detail: 'Flake rate under 5% — 8.0% flaky (4/50)' },
          { action: 'WARN', detail: 'p95 under 2000ms — p95 was 3100ms' },
        ]),
      }),
    );

    expect(text.split('\n')[0]).toBe(
      '⛔ QAAI — the quality gate blocked this run (41 passed, 4 flaky)',
    );
    expect(text).toContain('⛔ Flake rate under 5% — 8.0% flaky (4/50)');
    // A WARN is the rule the team decided not to be woken for.
    expect(text).not.toContain('p95 was 3100ms');
  });

  it('reads a green, unblocked run as green', () => {
    const text = renderRunAlert(alertRun({ failedCount: 0, flakyCount: 0, results: [] }));
    expect(text.split('\n')[0]).toBe('✅ QAAI — 41 passed');
  });

  it('survives a gateResult that is not a gate result — the column is Json', () => {
    // A run finalised by an older worker, or one still in flight. An alert must
    // not throw on the way out.
    expect(blockingGateRules(null)).toEqual([]);
    expect(blockingGateRules({})).toEqual([]);
    expect(blockingGateRules({ evaluations: 'nope' })).toEqual([]);
    expect(blockingGateRules(gate([{ action: 'PASS', detail: 'fine' }]))).toEqual([]);
  });
});

describe('a monitor page', () => {
  beforeEach(() => {
    vi.stubEnv('WEB_PUBLIC_URL', 'https://app.qaai.test');
  });

  it('names the monitor, the streak, the environment and the damage', () => {
    const text = renderMonitorAlert({
      name: 'checkout smoke',
      streak: 3,
      runId: 'run9',
      run: {
        failedCount: 2,
        passedCount: 10,
        environment: { name: 'production' },
        results: [
          { status: 'FAILED', test: { name: 'can pay', filePath: 'specs/pay.spec.ts' } },
          { status: 'PASSED', test: { name: 'can browse', filePath: 'specs/browse.spec.ts' } },
        ],
      },
    });
    const lines = text.split('\n');

    expect(lines[0]).toBe('🔴 checkout smoke is down — 3 failed checks in a row');
    expect(lines[1]).toBe('production · 2 of 12 tests failing');
    expect(text).toContain('• can pay — specs/pay.spec.ts');
    expect(lines[lines.length - 1]).toBe('https://app.qaai.test/runs/run9');
  });

  it('degrades to the bare page when the run cannot be read, keeping the link', () => {
    const text = renderMonitorAlert({
      name: 'checkout smoke',
      streak: 1,
      runId: 'run9',
      run: null,
    });

    // Singular, because "1 failed checks" is the kind of detail that makes an
    // alert read like it was written by a machine that does not care.
    expect(text).toBe(
      '🔴 checkout smoke is down — 1 failed check in a row\nhttps://app.qaai.test/runs/run9',
    );
  });
});

describe('a quality gate that blocks is news, even when every test passed', () => {
  const blockedGreenRun = {
    id: 'run1',
    status: 'FAILED',
    prNumber: null,
    passedCount: 50,
    failedCount: 0,
    flakyCount: 4,
    projectId: 'p1',
    project: { name: 'Storefront' },
    environment: { name: 'staging' },
    results: [],
    gateResult: gate([{ action: 'BLOCK', detail: 'Flake rate under 5% — 8.0% flaky (4/50)' }]),
  };
  const finished = { orgId: 'org1', event: 'run.finished', payload: { runId: 'run1' } };

  it('reaches a failures-only channel, which is the channel that exists to catch it', async () => {
    stubFetch();
    const db = fanOutDb([slack()]); // default prefs: failures only
    (h.prisma as Record<string, unknown>).run = { findFirst: async () => blockedGreenRun };

    await processNotify(finished, 'j1');

    /*
     * The regression this test exists for: newsworthiness used to be
     * `failedCount > 0`, so this run — zero failures, merge blocked — was
     * announced as "all 50 passed" and reached only `runFinished: 'all'`.
     */
    expect(db.created).toHaveLength(1);
    expect(String((db.created[0]! as { payload: { text: string } }).payload.text)).toContain(
      'the quality gate blocked this run',
    );
    expect(h.enqueued).toEqual([{ orgId: 'org1', deliveryId: 'wd-j1-int1' }]);
  });

  it('still respects a channel that switched run reports off', async () => {
    stubFetch();
    const db = fanOutDb([slack({ config: { notify: { runFinished: 'off', digest: true } } })]);
    (h.prisma as Record<string, unknown>).run = { findFirst: async () => blockedGreenRun };

    await processNotify(finished, 'j1');

    expect(db.created).toHaveLength(0);
  });

  it('does not page for a gate that only WARNed — that is the muting failure', async () => {
    stubFetch();
    const db = fanOutDb([slack()]);
    (h.prisma as Record<string, unknown>).run = {
      findFirst: async () => ({
        ...blockedGreenRun,
        status: 'PASSED',
        gateResult: gate([{ action: 'WARN', detail: 'p95 under 2000ms — p95 was 3100ms' }]),
      }),
    };

    await processNotify(finished, 'j1');

    expect(db.created).toHaveLength(0);
    expect(h.enqueued).toEqual([]);
  });
});

describe('the monitor page is enriched from the run, but never blocked by it', () => {
  it('reads the environment and the counts off the run behind the streak', async () => {
    stubFetch();
    const db = fanOutDb([slack()]);
    (h.prisma as Record<string, unknown>).run = {
      findFirst: async () => ({
        failedCount: 2,
        passedCount: 10,
        environment: { name: 'production' },
        results: [{ status: 'FAILED', test: { name: 'can pay', filePath: 'specs/pay.spec.ts' } }],
      }),
    };

    await processNotify(monitorDown, 'job7');

    const text = String((db.created[0]! as { payload: { text: string } }).payload.text);
    expect(text).toContain('production · 2 of 12 tests failing');
    expect(text).toContain('• can pay — specs/pay.spec.ts');
  });

  it('pages anyway when that read fails — a page lost to a JOIN is the worse bug', async () => {
    stubFetch();
    const db = fanOutDb([slack()]);
    (h.prisma as Record<string, unknown>).run = {
      findFirst: async () => {
        throw new Error('connection terminated');
      },
    };

    await processNotify(monitorDown, 'job7');

    expect(db.created).toHaveLength(1);
    expect(String((db.created[0]! as { payload: { text: string } }).payload.text)).toContain(
      '🔴 checkout is down',
    );
    expect(h.log.some((l) => l.startsWith('warn:') && l.includes('paging anyway'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Routing: whose failure is this
//
// Ownership resolved in two READ paths before this (the digest's labels and
// GET /team/ownership/resolve) and was never written onto the failure, so a red
// run landed in a queue that belongs to everybody — which in practice means
// nobody. These tests pin both halves: the label on the line somebody reads at
// 3am, and the assignee on the verdict somebody opens the next morning.
//
// The sharpest assertion in here is the NEGATIVE one: an install that never
// opted into ownership must hear NOTHING about it. A line reading "unowned"
// under every failure is how an alert gets muted, and a muted alert is worse
// than an unrouted one.
// ─────────────────────────────────────────────────────────────────────────────

/** `OwnershipRule` rows, plus the verdict writes they produce. */
function routingDb(opts: {
  rules?: Array<Record<string, unknown>>;
  results?: Array<Record<string, unknown>>;
  teams?: Array<{ id: string; slug: string }>;
  users?: Array<{ id: string; name: string | null; email: string }>;
  throws?: boolean;
  /**
   * `RunFailureCluster.suppressed` count. Absent leaves the model OFF the fake
   * client entirely, which is how "the read failed" is modelled — the
   * processor must then claim nothing rather than report zero.
   */
  suppressed?: number;
}): {
  updates: Array<{ id: string; data: Record<string, unknown> }>;
  manyUpdates: unknown[];
  /** The args the failure read was issued with — the cap and its ordering. */
  resultQuery: Array<Record<string, unknown>>;
} {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const manyUpdates: unknown[] = [];
  const resultQuery: Array<Record<string, unknown>> = [];
  const db = h.prisma as Record<string, unknown>;

  db.ownershipRule = {
    findMany: async () => {
      if (opts.throws) throw new Error('connection terminated');
      return opts.rules ?? [];
    },
  };
  db.testResult = {
    findMany: async (args: Record<string, unknown> = {}) => {
      resultQuery.push(args);
      return opts.results ?? [];
    },
  };
  if (opts.suppressed !== undefined) {
    db.runFailureCluster = { count: async () => opts.suppressed };
  } else {
    delete db.runFailureCluster;
  }
  db.team = { findMany: async () => opts.teams ?? [] };
  db.user = { findMany: async () => opts.users ?? [] };
  db.triageVerdict = {
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push({ id: args.where.id, data: args.data });
      return args.data;
    },
    updateMany: async (args: unknown) => {
      manyUpdates.push(args);
      return { count: 1 };
    },
  };

  return { updates, manyUpdates, resultQuery };
}

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'rule1',
  position: 0,
  pathPattern: null,
  testId: null,
  suiteId: null,
  feature: null,
  ownerUserId: null,
  ownerTeamId: null,
  ...over,
});

const failingResult = (over: Record<string, unknown> = {}) => ({
  id: 'res1',
  test: {
    id: 't1',
    name: 'checkout applies a promo code',
    filePath: 'specs/checkout.spec.ts',
    suiteId: null,
    feature: null,
  },
  verdict: { id: 'v1', ownerState: null },
  ...over,
});

describe('the alert says whose failure it is', () => {
  beforeEach(() => {
    vi.stubEnv('WEB_PUBLIC_URL', 'https://app.qaai.test');
  });

  it('puts the owner on the failure line, where it is read', () => {
    const text = renderRunAlert(
      alertRun({
        owners: new Map([
          [
            failureOwnerKey({
              name: 'checkout applies a promo code',
              filePath: 'specs/checkout.spec.ts',
            }),
            '@payments',
          ],
        ]),
      }),
    );

    expect(text).toContain('• checkout applies a promo code — specs/checkout.spec.ts — @payments');
  });

  it('marks a failure no rule matched as unowned, rather than leaving it looking owned', () => {
    const text = renderRunAlert(
      alertRun({
        failedCount: 2,
        results: [
          { status: 'FAILED', test: { name: 'a', filePath: 'specs/a.spec.ts' } },
          { status: 'FAILED', test: { name: 'b', filePath: 'specs/b.spec.ts' } },
        ],
        owners: new Map([
          [failureOwnerKey({ name: 'a', filePath: 'specs/a.spec.ts' }), '@payments'],
          // PRESENT AND NULL: the rules were evaluated and none matched.
          [failureOwnerKey({ name: 'b', filePath: 'specs/b.spec.ts' }), null],
        ]),
      }),
    );

    expect(text).toContain('• a — specs/a.spec.ts — @payments');
    expect(text).toContain('• b — specs/b.spec.ts — unowned');
  });

  it('says NOT ROUTED, not unowned, for a failure the cap never looked at', () => {
    /*
     * The lie this stops. `routeFailuresToOwners` reads `MAX_FAILURES_ROUTED`
     * failures and writes a key for every one of them — null included — so a
     * key MISSING from the map means that failure was never looked at. Printing
     * "unowned" for it reports a cap as a fact about the project's ownership
     * rules, and the reader's conclusion ("nobody owns this") is the opposite
     * of the truth ("we did not check").
     */
    const text = renderRunAlert(
      alertRun({
        failedCount: 2,
        results: [
          { status: 'FAILED', test: { name: 'a', filePath: 'specs/a.spec.ts' } },
          { status: 'FAILED', test: { name: 'z', filePath: 'specs/z.spec.ts' } },
        ],
        owners: new Map([[failureOwnerKey({ name: 'a', filePath: 'specs/a.spec.ts' }), '@payments']]),
        ownersCapped: true,
      }),
    );

    expect(text).toContain('• z — specs/z.spec.ts — not routed');
    expect(text).not.toContain('• z — specs/z.spec.ts — unowned');
    // And the cap itself is disclosed, or "not routed" reads as a QAAI bug.
    expect(text).toContain('only the first 500 failures were routed to an owner');
  });

  it('names a FLAKY failure and its owner — the status the routing writes but the alert dropped', () => {
    /*
     * THE DEFECT, in one test. `FAILING_STATUSES` includes FLAKY, so a flaky
     * failure had `assigneeUserId` / `ownerState` / `assignedAt` written onto
     * its verdict — and the run alert's own list was `FAILED || TIMED_OUT`, so
     * the owner it had just recorded was never named. The person the row said
     * to wake up was the one person the message did not mention.
     */
    const text = renderRunAlert(
      alertRun({
        failedCount: 0,
        flakyCount: 1,
        results: [{ status: 'FLAKY', test: { name: 'wobbly', filePath: 'specs/w.spec.ts' } }],
        owners: new Map([
          [failureOwnerKey({ name: 'wobbly', filePath: 'specs/w.spec.ts' }), '@payments'],
        ]),
      }),
    );

    // Tagged, because the counts line keeps flakes in their own column.
    expect(text).toContain('• wobbly — specs/w.spec.ts (flaky) — @payments');
  });

  it('a monitor page lists hard failures only, so the bullets cannot outnumber the count', () => {
    /*
     * The one deliberate narrowing in the file, pinned so it cannot drift into
     * the accidental kind. `run.failedCount` excludes FLAKY by construction
     * (`tallyResult`, packages/runner/src/gates.ts), so listing a flaky test
     * under "2 of 12 tests failing" would print three bullets under a two.
     */
    const text = renderMonitorAlert({
      name: 'checkout smoke',
      streak: 2,
      runId: 'run9',
      run: {
        failedCount: 1,
        passedCount: 11,
        environment: { name: 'production' },
        results: [
          { status: 'FAILED', test: { name: 'can pay', filePath: 'specs/pay.spec.ts' } },
          { status: 'FLAKY', test: { name: 'wobbly', filePath: 'specs/w.spec.ts' } },
        ],
      },
    });

    expect(text).toContain('production · 1 of 12 tests failing');
    expect(text).toContain('• can pay — specs/pay.spec.ts');
    expect(text).not.toContain('wobbly');
  });

  it('names muted causes when there are any, and claims nothing when the count is unavailable', () => {
    /*
     * A quiet run and a silenced run look identical in chat, and the second is
     * the dangerous one. The line is a POSITIVE statement only: 0 (nothing
     * muted) and null (the count could not be read) both render as silence, so
     * the alert can never report a suppression number it did not measure.
     */
    const said = renderRunAlert(alertRun({ suppressedCauses: 3 }));
    expect(said).toContain('🔇 3 causes muted — nothing was reported about them');

    const one = renderRunAlert(alertRun({ suppressedCauses: 1 }));
    expect(one).toContain('🔇 1 cause muted — nothing was reported about it');

    for (const quiet of [
      renderRunAlert(alertRun({ suppressedCauses: 0 })),
      renderRunAlert(alertRun({ suppressedCauses: null })),
      renderRunAlert(alertRun()),
    ]) {
      expect(quiet).not.toContain('🔇');
      expect(quiet).not.toContain('muted');
    }
  });

  it('says NOTHING about ownership in an install that never opted in', () => {
    const silent = renderRunAlert(alertRun());
    const alsoSilent = renderRunAlert(alertRun({ owners: new Map() }));

    for (const text of [silent, alsoSilent]) {
      expect(text).toContain('• checkout applies a promo code — specs/checkout.spec.ts');
      // Ownership is opt-in. Nagging about an empty table is how the feature
      // gets switched off.
      expect(text).not.toContain('unowned');
    }
  });
});

describe('processNotify routes a finished run to its owners', () => {
  const run = {
    id: 'run1',
    status: 'FAILED',
    prNumber: null,
    passedCount: 7,
    failedCount: 1,
    flakyCount: 0,
    gateResult: null,
    projectId: 'p1',
    project: { name: 'Storefront' },
    environment: { name: 'staging' },
    results: [
      {
        status: 'FAILED',
        test: { name: 'checkout applies a promo code', filePath: 'specs/checkout.spec.ts' },
      },
    ],
  };
  const finished = { orgId: 'org1', event: 'run.finished', payload: { runId: 'run1' } };

  const textOf = (created: Array<Record<string, unknown>>): string =>
    String((created[0] as { payload: { text: string } }).payload.text);

  it('writes the owner onto the verdict AND names it in the alert', async () => {
    stubFetch();
    const db = fanOutDb([slack()]);
    (h.prisma as Record<string, unknown>).run = { findFirst: async () => run };
    const routing = routingDb({
      rules: [rule({ pathPattern: 'specs/checkout/**', ownerTeamId: 'team_payments' })],
      results: [failingResult()],
      teams: [{ id: 'team_payments', slug: 'payments' }],
    });

    await processNotify(finished, 'j1');

    // `specs/checkout/**` does NOT match `specs/checkout.spec.ts` — one is a
    // directory, the other a file. The alert must therefore say unowned, and
    // the verdict must say NO_MATCH rather than carrying a null that reads as
    // "nobody has looked".
    expect(routing.updates).toHaveLength(1);
    expect(routing.updates[0]!.id).toBe('v1');
    expect(routing.updates[0]!.data).toMatchObject({
      assigneeUserId: null,
      assigneeTeamId: null,
      ownerState: 'NO_MATCH',
    });
    expect(textOf(db.created)).toContain('unowned');
  });

  it('assigns the team whose pattern actually matches', async () => {
    stubFetch();
    const db = fanOutDb([slack()]);
    (h.prisma as Record<string, unknown>).run = { findFirst: async () => run };
    const routing = routingDb({
      rules: [rule({ pathPattern: 'specs/**', ownerTeamId: 'team_payments' })],
      results: [failingResult()],
      teams: [{ id: 'team_payments', slug: 'payments' }],
    });

    await processNotify(finished, 'j1');

    expect(routing.updates[0]!.data).toMatchObject({
      assigneeTeamId: 'team_payments',
      assigneeUserId: null,
      ownerState: 'OWNED',
      ownerRuleId: 'rule1',
    });
    expect(textOf(db.created)).toContain('— @payments');
  });

  it('records NO_RULES in one statement, and leaves the alert quiet', async () => {
    stubFetch();
    const db = fanOutDb([slack()]);
    (h.prisma as Record<string, unknown>).run = { findFirst: async () => run };
    const routing = routingDb({ rules: [], results: [failingResult()] });

    await processNotify(finished, 'j1');

    // One updateMany, not N updates: the assignment is identical for every row
    // and an install with no rules is the common case.
    expect(routing.updates).toHaveLength(0);
    expect(routing.manyUpdates).toHaveLength(1);
    expect(routing.manyUpdates[0]).toMatchObject({
      where: { id: { in: ['v1'] } },
      data: { ownerState: 'NO_RULES', assigneeTeamId: null, assigneeUserId: null },
    });
    expect(textOf(db.created)).not.toContain('unowned');
  });

  it('does not re-stamp a verdict that was already routed', async () => {
    stubFetch();
    fanOutDb([slack()]);
    (h.prisma as Record<string, unknown>).run = { findFirst: async () => run };
    const routing = routingDb({
      rules: [rule({ pathPattern: 'specs/**', ownerTeamId: 'team_payments' })],
      results: [failingResult({ verdict: { id: 'v1', ownerState: 'OWNED' } })],
      teams: [{ id: 'team_payments', slug: 'payments' }],
    });

    await processNotify(finished, 'j1');

    // A notify job is retried. `assignedAt` must record when the failure was
    // routed, not how many times the queue hiccuped.
    expect(routing.updates).toHaveLength(0);
    expect(routing.manyUpdates).toHaveLength(0);
  });

  it('labels a failure whose verdict does not exist yet, and writes nothing for it', async () => {
    stubFetch();
    const db = fanOutDb([slack()]);
    (h.prisma as Record<string, unknown>).run = { findFirst: async () => run };
    const routing = routingDb({
      rules: [rule({ pathPattern: 'specs/**', ownerTeamId: 'team_payments' })],
      results: [failingResult({ verdict: null })],
      teams: [{ id: 'team_payments', slug: 'payments' }],
    });

    await processNotify(finished, 'j1');

    // Triage has not landed yet: there is nowhere to put the assignee. The
    // alert still names the owner, and the gap is logged rather than claimed.
    expect(routing.updates).toHaveLength(0);
    expect(textOf(db.created)).toContain('— @payments');
    expect(h.log.some((l) => l.startsWith('info:') && l.includes('no triage verdict'))).toBe(true);
  });

  it('warns about a rule it could not evaluate instead of reporting unowned in silence', async () => {
    stubFetch();
    fanOutDb([slack()]);
    (h.prisma as Record<string, unknown>).run = { findFirst: async () => run };
    const routing = routingDb({
      // Stored when the validation was looser; it no longer compiles.
      rules: [rule({ pathPattern: 'specs/[a-z]/**', ownerTeamId: 'team_payments' })],
      results: [failingResult()],
    });

    await processNotify(finished, 'j1');

    expect(routing.updates[0]!.data).toMatchObject({ ownerState: 'RULES_UNUSABLE' });
    expect(h.log.some((l) => l.includes('could not be evaluated'))).toBe(true);
  });

  it('pages anyway when the routing read fails — a page lost to a JOIN is the worse bug', async () => {
    stubFetch();
    const db = fanOutDb([slack()]);
    (h.prisma as Record<string, unknown>).run = { findFirst: async () => run };
    routingDb({ throws: true, results: [failingResult()] });

    await processNotify(finished, 'j1');

    expect(db.created).toHaveLength(1);
    expect(textOf(db.created)).toContain('❌ QAAI — 1 failed, 7 passed');
    expect(h.log.some((l) => l.startsWith('warn:') && l.includes('could not route'))).toBe(true);
  });

  it('reads the failures to route in a fixed order, so a retry routes the same ones', async () => {
    /*
     * The cap without an order was the defect: past `MAX_FAILURES_ROUTED`,
     * WHICH failures got an owner written onto their verdict was whatever
     * Postgres returned — a different set on a replica, after a VACUUM, or on
     * the job's second attempt, with the remainder reported to the reader as
     * unowned. Oldest first, tie-broken by id, is what makes the routed set a
     * decision instead of an accident.
     */
    stubFetch();
    fanOutDb([slack()]);
    (h.prisma as Record<string, unknown>).run = { findFirst: async () => run };
    const routing = routingDb({
      rules: [rule({ pathPattern: 'specs/**', ownerTeamId: 'team_payments' })],
      results: [failingResult()],
      teams: [{ id: 'team_payments', slug: 'payments' }],
    });

    await processNotify(finished, 'j1');

    const args = routing.resultQuery[0]!;
    expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(args.take).toBe(500);
    // FLAKY is in the set that gets routed, which is why the alert has to name
    // it too — see the renderer tests above.
    expect(args.where).toMatchObject({ status: { in: ['FAILED', 'TIMED_OUT', 'FLAKY'] } });
  });

  it('counts the causes muted for this run and says so in the alert', async () => {
    stubFetch();
    const db = fanOutDb([slack()]);
    (h.prisma as Record<string, unknown>).run = { findFirst: async () => run };
    routingDb({ results: [failingResult()], suppressed: 2 });

    await processNotify(finished, 'j1');

    expect(textOf(db.created)).toContain('🔇 2 causes muted');
  });

  it('says nothing about muting when that count could not be read', async () => {
    // No `runFailureCluster` on the client at all. The alert still goes out and
    // reports NO suppression number — never zero, which would be a
    // measurement this process did not make.
    stubFetch();
    const db = fanOutDb([slack()]);
    (h.prisma as Record<string, unknown>).run = { findFirst: async () => run };
    routingDb({ results: [failingResult()] });

    await processNotify(finished, 'j1');

    expect(db.created).toHaveLength(1);
    expect(textOf(db.created)).not.toContain('🔇');
    expect(h.log.some((l) => l.includes('could not read how many causes were muted'))).toBe(true);
  });

  it('returns NULL, not 0, when the suppression count could not be read', async () => {
    /*
     * Asserted on the FUNCTION rather than on the rendered text, and that is
     * the point of the test existing at all. The chat line is a positive
     * statement only, so null and 0 render identically — a `return 0` in that
     * catch block would pass every assertion on the message while turning "we
     * could not look" into the measurement "nothing was muted". That is the
     * null-became-0 defect, and this is the only place it is visible.
     */
    (h.prisma as Record<string, unknown>).runFailureCluster = {
      count: async () => {
        throw new Error('connection terminated');
      },
    };
    await expect(suppressedCauseCount('org1', 'run1')).resolves.toBeNull();

    // And a real zero is a real zero, not conflated with the above.
    (h.prisma as Record<string, unknown>).runFailureCluster = { count: async () => 0 };
    await expect(suppressedCauseCount('org1', 'run1')).resolves.toBe(0);
  });
});
