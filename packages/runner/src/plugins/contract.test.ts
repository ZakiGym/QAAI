/**
 * Contract plugin tests, run against a real HTTP provider on localhost.
 *
 * Contract testing's whole value is that it fails when — and only when — the
 * provider actually broke a consumer. Both halves of that are load-bearing:
 *
 *   - a pact that matches by type must NOT fail because an id is a different
 *     UUID this time. That false positive is why teams abandon Pact, and it is
 *     what the matching-rule engine exists to prevent.
 *   - a genuinely changed value must fail, with expected vs actual, or the test
 *     is decoration.
 *
 * So these tests assert on both directions, plus the "not evaluated" paths that
 * must never be reported as a provider failure.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutableTest, RunContext } from '@qaai/shared';
import { contractPlugin } from './contract.js';

let server: Server;
let baseUrl: string;
/** What `/echo` returns, so a matching rule can be pointed at any shape. */
let echo: unknown = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && url.pathname === '/_pact/state') return json(200, { ok: true });

    switch (url.pathname) {
      // A fresh id and a different total on every call — legal under a pact
      // that matches by type, which is the point.
      case '/orders':
        return json(200, {
          orders: [
            { id: 'c0ffee00-dead-beef-cafe-000000000001', total: 99.95, status: 'PAID' },
            { id: 'c0ffee00-dead-beef-cafe-000000000002', total: 12.5, status: 'PAID' },
          ],
          count: 2,
        });
      case '/orders/count':
        return json(200, { count: 2 });
      case '/orders/missing':
        return json(404, { error: 'not found' });
      case '/pets':
        return json(200, [{ id: 1, name: 'Rex' }]);
      case '/pets/7':
        // `id` is a string here; the document says integer.
        return json(200, { id: 'seven', name: 'Rex' });
      case '/health':
        return json(503, { status: 'down' });
      case '/echo':
        return json(200, echo);
      default:
        return json(404, { error: 'no route' });
    }
  });

  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((closed) => server.close(() => closed()));
});

function context(fixtures: Record<string, string> = {}): RunContext {
  return {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl,
    secrets: {},
    fixtures,
    grid: null,
    visualBaseline: null,
    storageState: null,
    artifacts: {
      put: async () => '',
      putFile: async () => '',
      get: async () => null,
      putPersistent: async () => '',
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      step: () => {},
    },
    signal: new AbortController().signal,
    determinism: {
      freezeClockAt: null,
      randomSeed: 1,
      waitForNetworkIdle: false,
      retryOnce: false,
    },
  };
}

function test(spec: unknown): ExecutableTest {
  return {
    id: 'test_1',
    name: 'orders contract',
    type: 'CONTRACT',
    code: '',
    filePath: 'contracts/orders.json',
    spec,
    timeoutMs: 30_000,
    quarantined: false,
    tags: [],
  };
}

const PACT = JSON.stringify({
  consumer: { name: 'web' },
  provider: { name: 'orders-api' },
  interactions: [
    {
      description: 'a request for orders',
      providerState: 'orders exist',
      request: { method: 'GET', path: '/orders' },
      response: {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          orders: [{ id: '00000000-0000-0000-0000-000000000000', total: 1.0, status: 'PAID' }],
          count: 1,
        },
        // v2 matching rules — still what pact-js writes by default.
        matchingRules: {
          '$.body.orders': { match: 'type', min: 1 },
          '$.body.orders[*].id': { match: 'regex', regex: '^[0-9a-f]{8}-[0-9a-f-]{27}$' },
          '$.body.count': { match: 'type' },
        },
      },
    },
    {
      description: 'the order count',
      request: { method: 'GET', path: '/orders/count' },
      // No matching rules: the consumer pinned the value, so 2 must fail.
      response: { status: 200, body: { count: 1 } },
    },
    {
      description: 'a missing order',
      request: { method: 'GET', path: '/orders/missing' },
      response: { status: 404, body: { error: 'not found' } },
    },
  ],
});

const OPENAPI = JSON.stringify({
  openapi: '3.0.3',
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } },
              },
            },
          },
        },
      },
    },
    '/pets/{petId}': {
      get: {
        operationId: 'getPet',
        parameters: [
          { name: 'petId', in: 'path', required: true, schema: { type: 'integer', example: 7 } },
        ],
        responses: {
          '200': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
          },
        },
      },
    },
    '/health': {
      get: { operationId: 'health', responses: { '200': { description: 'ok' } } },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        required: ['id', 'name'],
        properties: { id: { type: 'integer' }, name: { type: 'string' } },
      },
    },
  },
});

describe('pact provider verification', () => {
  it('honours matching rules and fails only on a real change', async () => {
    const spec = {
      kind: 'pact',
      pactPath: 'fixtures/orders.pact.json',
      stateChangeUrl: '/_pact/state',
    };
    const execution = await contractPlugin.execute(
      context({ 'fixtures/orders.pact.json': PACT }),
      test(spec),
    );

    expect(execution.steps).toHaveLength(3);

    // Two extra orders, brand-new UUIDs, a different total and count: all legal
    // under the rules the consumer wrote.
    expect(execution.steps[0]?.status).toBe('PASSED');

    // The pinned count is a real contract break, and it says so with numbers.
    expect(execution.steps[1]?.status).toBe('FAILED');
    expect(execution.steps[1]?.error?.message).toContain('$.count');
    expect(execution.steps[1]?.error?.expected).toBe('1');
    expect(execution.steps[1]?.error?.actual).toBe('2');

    expect(execution.steps[2]?.status).toBe('PASSED');
    expect(execution.status).toBe('FAILED');
    expect(execution.network).toHaveLength(3);
  });

  it('catches a status change', async () => {
    const pact = JSON.parse(PACT) as { interactions: Array<{ response: { status: number } }> };
    const target = pact.interactions[2];
    if (target) target.response.status = 200;

    const execution = await contractPlugin.execute(
      context({ 'fixtures/orders.pact.json': JSON.stringify(pact) }),
      test({ kind: 'pact', pactPath: 'fixtures/orders.pact.json' }),
    );

    expect(execution.steps[2]?.status).toBe('FAILED');
    expect(execution.steps[2]?.error?.expected).toBe('HTTP 200');
    expect(execution.steps[2]?.error?.actual).toBe('HTTP 404');
  });

  it('runs only the interactions the filter selects', async () => {
    const execution = await contractPlugin.execute(
      context({ 'fixtures/orders.pact.json': PACT }),
      test({ kind: 'pact', pactPath: 'fixtures/orders.pact.json', only: 'a request for orders' }),
    );

    expect(execution.status).toBe('PASSED');
    expect(execution.steps.filter((s) => s.status === 'SKIPPED')).toHaveLength(2);
  });

  it('reports a missing pact file as skipped, never as a provider failure', async () => {
    const execution = await contractPlugin.execute(
      context(),
      test({ kind: 'pact', pactPath: 'fixtures/nope.json' }),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('fixtures/nope.json');
  });

  it('reports a missing vault secret as skipped', async () => {
    const execution = await contractPlugin.execute(
      context({ 'fixtures/orders.pact.json': PACT }),
      test({
        kind: 'pact',
        pactPath: 'fixtures/orders.pact.json',
        auth: { secretName: 'PROVIDER_TOKEN' },
      }),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('PROVIDER_TOKEN');
  });
});

describe('openapi conformance', () => {
  it('checks live responses against the declared schema', async () => {
    const execution = await contractPlugin.execute(
      context({ 'fixtures/openapi.json': OPENAPI }),
      test({ kind: 'openapi', specPath: 'fixtures/openapi.json' }),
    );

    expect(execution.steps).toHaveLength(3);

    const pets = execution.steps.find((s) => s.title.includes('listPets'));
    expect(pets?.status).toBe('PASSED');

    // `id` came back as "seven" where the document says integer.
    const pet = execution.steps.find((s) => s.title.includes('getPet'));
    expect(pet?.status).toBe('FAILED');
    expect(pet?.error?.message).toContain('$.id');
    expect(pet?.error?.message).toContain('integer');

    // 503 against a document that only declares 200.
    const health = execution.steps.find((s) => s.title.includes('health'));
    expect(health?.status).toBe('FAILED');
    expect(health?.error?.message).toContain('503');

    expect(execution.status).toBe('FAILED');
  });

  it('checks only the operations the spec names', async () => {
    const execution = await contractPlugin.execute(
      context({ 'fixtures/openapi.json': OPENAPI }),
      test({ kind: 'openapi', specPath: 'fixtures/openapi.json', operations: ['GET /pets'] }),
    );

    expect(execution.steps).toHaveLength(1);
    expect(execution.status).toBe('PASSED');
  });

  it('skips an operation it has no path parameter for', async () => {
    const document = JSON.parse(OPENAPI) as {
      paths: Record<string, { get?: { parameters?: unknown } }>;
    };
    const operation = document.paths['/pets/{petId}']?.get;
    if (operation) delete operation.parameters;

    const execution = await contractPlugin.execute(
      context({ 'fixtures/openapi.json': JSON.stringify(document) }),
      test({
        kind: 'openapi',
        specPath: 'fixtures/openapi.json',
        operations: ['GET /pets/{petId}'],
      }),
    );

    expect(execution.steps[0]?.status).toBe('SKIPPED');
    expect(execution.steps[0]?.error?.message).toContain('petId');
    expect(execution.status).toBe('SKIPPED');
  });
});

describe('matching rules', () => {
  /** One interaction against `/echo`, so a rule can be aimed at any shape. */
  const verify = async (matchingRules: unknown, expectedBody: unknown, actual: unknown) => {
    echo = actual;
    const pact = JSON.stringify({
      consumer: { name: 'web' },
      provider: { name: 'api' },
      interactions: [
        {
          description: 'echo',
          request: { method: 'GET', path: '/echo' },
          response: { status: 200, body: expectedBody, matchingRules },
        },
      ],
    });
    return contractPlugin.execute(
      context({ 'fixtures/echo.pact.json': pact }),
      test({ kind: 'pact', pactPath: 'fixtures/echo.pact.json' }),
    );
  };

  it('passes a different value of the same type', async () => {
    const execution = await verify(
      { '$.body.items': { match: 'type', min: 1 } },
      { items: [{ n: 5 }] },
      { items: [{ n: 9 }, { n: 10 }] },
    );
    expect(execution.status).toBe('PASSED');
  });

  it('fails a changed type', async () => {
    const execution = await verify(
      { '$.body.items': { match: 'type', min: 1 } },
      { items: [{ n: 5 }] },
      { items: [{ n: 'five' }] },
    );
    expect(execution.status).toBe('FAILED');
    expect(execution.steps[0]?.error?.message).toContain('$.items[0].n');
  });

  it('enforces the minimum array length', async () => {
    const execution = await verify(
      { '$.body.items': { match: 'type', min: 2 } },
      { items: [{ n: 5 }, { n: 6 }] },
      { items: [] },
    );
    expect(execution.steps[0]?.error?.message).toContain('at least 2');
  });

  it('fails a value the regex rejects', async () => {
    const execution = await verify(
      { '$.body.id': { match: 'regex', regex: '^\\d+$' } },
      { id: '1' },
      { id: 'zzz' },
    );
    expect(execution.status).toBe('FAILED');
  });

  it('reads v3 matching rules as well as v2', async () => {
    const rules = { body: { '$.id': { matchers: [{ match: 'regex', regex: '^\\d+$' }] } } };
    expect((await verify(rules, { id: '1' }, { id: '4242' })).status).toBe('PASSED');
    expect((await verify(rules, { id: '1' }, { id: 'zzz' })).status).toBe('FAILED');
  });

  it('allows a field the consumer never asked about, and requires one it did', async () => {
    expect((await verify({}, { a: 1 }, { a: 1, added: true })).status).toBe('PASSED');
    const missing = await verify({}, { a: 1, b: 2 }, { a: 1 });
    expect(missing.steps[0]?.error?.message).toContain('$.b');
  });

  it('fails the interaction — not the configuration — when the provider is unreachable', async () => {
    echo = {};
    const pact = JSON.stringify({
      consumer: { name: 'web' },
      provider: { name: 'api' },
      interactions: [
        {
          description: 'echo',
          request: { method: 'GET', path: '/echo' },
          response: { status: 200, body: { a: 1 } },
        },
      ],
    });
    const execution = await contractPlugin.execute(
      { ...context({ 'fixtures/echo.pact.json': pact }), baseUrl: 'http://127.0.0.1:9' },
      test({ kind: 'pact', pactPath: 'fixtures/echo.pact.json' }),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.steps[0]?.error?.message).toContain('could not be reached');
  });
});

describe('spec validation', () => {
  it('names the field that is wrong', () => {
    expect(() => contractPlugin.validate(test({ kind: 'pact' }))).toThrow(/pactPath/);
    expect(() => contractPlugin.validate(test({ pactPath: 'a.json' }))).toThrow(/kind/);
    expect(() =>
      contractPlugin.validate(test({ kind: 'pact', pactPath: '../../etc/passwd' })),
    ).toThrow(/workspace-relative/);
  });
});
