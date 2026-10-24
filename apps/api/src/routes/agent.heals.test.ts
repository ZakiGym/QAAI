import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  db: Record<string, unknown>;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
}

const h = vi.hoisted(
  (): Hoisted => ({
    db: {},
    actor: { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null },
    audits: [],
  }),
);

vi.mock('../env.js', () => ({
  env: {
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    DATABASE_URL: 'postgres://localhost/none',
    ANTHROPIC_API_KEY: '',
  },
  isProd: false,
}));

vi.mock('../lib/logger.js', () => ({
  logger: { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} },
  currentRequestId: () => 'req_test',
  setRequestActor: () => {},
  runWithRequestContext: <T,>(_ctx: unknown, fn: () => T) => fn(),
  registerRequestSecrets: () => {},
}));

vi.mock('../lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();
  return {
    prisma: new Proxy({}, { get: (_t, key: string) => h.db[key] }),
    withTenant: <T,>(orgId: string, fn: () => T | Promise<T>) => store.run({ orgId }, async () => fn()),
    unscoped: <T,>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

vi.mock('../lib/queues.js', () => ({ enqueue: async () => {} }));
vi.mock('../lib/storage.js', () => ({ storage: {} }));
vi.mock('../lib/events.js', () => ({ publish: () => {}, subscribe: () => () => {} }));
vi.mock('../lib/audit.js', () => ({
  audit: async (entry: Row) => {
    h.audits.push(entry);
  },
}));

vi.mock('../middleware/auth.js', async () => {
  const { withTenant } = await import('../lib/prisma.js');
  return {
    requireAuth: (req: Row, _res: Row, next: () => void) => {
      req.actor = { ...h.actor };
      void withTenant(h.actor.orgId, () => next());
    },
    requireRole: () => (_req: Row, _res: Row, next: () => void) => next(),
    requireScope: () => (_req: Row, _res: Row, next: () => void) => next(),
    actorOf: (req: Row) => req.actor,
  };
});

const express = (await import('express')).default;
const { agentRouter } = await import('./agent.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/agent', agentRouter);
app.use(notFoundHandler);
app.use(errorHandler);

let baseUrl = '';
let server: import('node:http').Server;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: Row }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

const CODE = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test('checkout charges the right total', async ({ page }) => {",
  "  await page.goto('/checkout');",
  "  await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
  '});',
].join('\n');

const SLEEP_DIFF = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -4,1 +4,2 @@',
  "   await page.goto('/checkout');",
  '+  await page.waitForTimeout(500);',
].join('\n');

const BREAK_DIFF = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -6,1 +6,1 @@',
  '-});',
  '+}',
].join('\n');

const CLEAN_DIFF = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -5,1 +5,1 @@',
  "-  await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
  "+  await expect(page.getByTestId('checkout-total')).toHaveText('$42.00');",
].join('\n');

function healRow(diff: string): Row {
  return {
    id: 'heal_1',
    orgId: 'org_1',
    testId: 't1',
    diff,
    explanation: 'retarget the total',
    riskLevel: 'LOW',
    confidence: 0.9,
    state: 'PROPOSED',
    createdAt: new Date(),
    test: { id: 't1', name: 'checkout', filePath: 'tests/checkout.spec.ts', code: CODE, type: 'E2E', spec: null },
  };
}

const testUpdates: Row[] = [];

function install(diff: string): void {
  testUpdates.length = 0;
  h.db = {
    healProposal: {
      findMany: async () => [healRow(diff)],
      findUnique: async () => healRow(diff),
      update: async () => ({ id: 'heal_1', state: 'APPLIED' }),
    },
    testVersion: { findFirst: async () => ({ version: 3 }) },
    test: {
      update: async (args: Row) => {
        testUpdates.push(args);
        return {};
      },
    },
    $transaction: async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
  };
}

beforeEach(() => {
  h.audits.length = 0;
});

describe('GET /agent/heals preview', () => {
  it('carries the gate flags and the checks that ran', async () => {
    install(SLEEP_DIFF);
    const { body } = await call('/agent/heals');

    expect(body.heals[0].preview.applies).toBe(true);
    expect(String(body.heals[0].preview.flags.join(' '))).toMatch(/sleeps for a fixed duration/);
    expect(String(body.heals[0].preview.checks)).toContain('Checked after patching');
  });

  it('marks a heal that does not parse as not applicable, with the reason', async () => {
    install(BREAK_DIFF);
    const { body } = await call('/agent/heals');

    expect(body.heals[0].preview.applies).toBe(false);
    expect(String(body.heals[0].preview.reason)).toMatch(/does not parse/);
  });
});

describe('POST /agent/heals/:id/decide', () => {
  it('422s a heal whose patched file does not parse', async () => {
    install(BREAK_DIFF);
    const { status, body } = await call('/agent/heals/heal_1/decide', {
      method: 'POST',
      body: JSON.stringify({ approve: true }),
    });

    expect(status).toBe(422);
    expect(String(body.error?.message)).toMatch(/does not parse/);
    expect(testUpdates).toHaveLength(0);
  });

  it('applies a flagged heal and records the flags and checks', async () => {
    install(SLEEP_DIFF);
    const { status, body } = await call('/agent/heals/heal_1/decide', {
      method: 'POST',
      body: JSON.stringify({ approve: true }),
    });

    expect(status).toBe(200);
    expect(testUpdates).toHaveLength(1);
    const data = testUpdates[0]!.data;
    expect(String(data.versions.create.message)).toMatch(/sleeps for a fixed duration/);
    expect(String(data.versions.create.message)).toContain('Checked after patching');
    expect(String(data.reviewFlags.join(' '))).toMatch(/sleeps for a fixed duration/);
    expect(String(body.note)).toMatch(/sleeps for a fixed duration/);
    expect(h.audits[0]!.metadata.checks).toContain('Checked after patching');
  });

  it('applies a clean heal with no flags but still records what ran', async () => {
    install(CLEAN_DIFF);
    const { status } = await call('/agent/heals/heal_1/decide', {
      method: 'POST',
      body: JSON.stringify({ approve: true }),
    });

    expect(status).toBe(200);
    const data = testUpdates[0]!.data;
    expect(data.reviewFlags).toEqual([]);
    expect(String(data.versions.create.message)).toContain('Checked after patching');
  });
});
