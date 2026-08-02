/**
 * Async contract tests, run against real transports on localhost.
 *
 * Three things have to be true or this feature is worse than not shipping it:
 *
 *   - a provider that emits the event the consumer declared must PASS, matching
 *     rules and all. An async contract that goes red on a timestamp is an async
 *     contract nobody keeps.
 *   - a provider that renamed a field, changed a type, or emitted on a channel
 *     its own document never declared must FAIL, with expected vs actual.
 *   - publishing to a broker must NEVER be the reason a test is red, and must
 *     never be able to send the broker token anywhere but the configured broker.
 *
 * The last one is the security boundary and gets the most assertions: this repo
 * has already shipped a credential-exfiltration bug of exactly this shape twice.
 */

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutableTest, RunContext } from '@qaai/shared';
import { contractPlugin } from './plugins/contract.js';
import { brokerOrigin, publishVerification, verificationResultsUrl } from './contract-broker.js';
import { collectMessages } from './contract-events.js';

let server: Server;
let baseUrl: string;
/** Upgraded sockets, so the suite can tear the server down deterministically. */
const upgraded: Duplex[] = [];
/** Flipped by a test to make the provider break the contract. */
let carrier = 'Demo Post';
/** What the SSE stream emits, so a test can plant an undeclared channel. */
let extraEvent: [string, unknown] | null = null;

// ─── A provider that speaks all four transports ──────────────────────────────

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function writeTextFrame(socket: Duplex, text: string): void {
  const payload = Buffer.from(text, 'utf8');
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.concat([
          Buffer.from([0x81, 126]),
          Buffer.from([payload.length >> 8, payload.length & 0xff]),
        ]);
  socket.write(Buffer.concat([header, payload]));
}

function readTextFrame(buf: Buffer): string | null {
  if (buf.length < 2) return null;
  if ((buf[0]! & 0x0f) !== 0x1) return null;
  const masked = (buf[1]! & 0x80) !== 0;
  let length = buf[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = buf.readUInt16BE(2);
    offset = 4;
  }
  if (!masked) return buf.subarray(offset, offset + length).toString('utf8');
  const mask = buf.subarray(offset, offset + 4);
  const data = buf.subarray(offset + 4, offset + 4 + length);
  return Buffer.from(data.map((b, i) => b ^ mask[i % 4]!)).toString('utf8');
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    const readBody = async (): Promise<string> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    };

    // A stream that opens and then says nothing, so an empty window is testable.
    if (url.pathname === '/events/silent') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': waiting\n\n');
      return;
    }

    // Server-sent events: the order lifecycle, named.
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (event: string, data: unknown, id?: string): void => {
        res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      send('order.placed', { id: 'ORD-1001', total: 4297 }, 'e1');
      send('order.shipped', { id: 'ORD-1001', carrier, attempts: 1 }, 'e2');
      if (extraEvent !== null) send(extraEvent[0], extraEvent[1]);
      res.end();
      return;
    }

    // Pact message provider: hand back the message for a description.
    if (url.pathname === '/pact/messages') {
      void readBody().then((body) => {
        const parsed = JSON.parse(body) as { description?: string };
        if (parsed.description !== 'an order shipped event') {
          res.writeHead(404).end();
          return;
        }
        const metadata = Buffer.from(
          JSON.stringify({ topic: 'order.shipped', contentType: 'application/json' }),
        ).toString('base64');
        res.writeHead(200, {
          'content-type': 'application/json',
          'pact-message-metadata': metadata,
        });
        res.end(JSON.stringify({ id: 'ORD-1001', carrier, attempts: 1 }));
      });
      return;
    }

    if (url.pathname === '/pact/state') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }

    // The application delivers a webhook when asked to.
    if (url.pathname === '/trigger') {
      void readBody().then(async (body) => {
        const parsed = JSON.parse(body) as { callback?: string };
        if (typeof parsed.callback !== 'string') {
          res.writeHead(400).end();
          return;
        }
        res.writeHead(202).end();
        await fetch(parsed.callback, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-event-name': 'order.shipped',
            // A sender's own credential must never survive into a step.
            authorization: 'Bearer sender-secret-value',
          },
          body: JSON.stringify({ id: 'ORD-1001', carrier, attempts: 1 }),
        }).catch(() => undefined);
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no route"}');
  });

  server.on('upgrade', (req, socket: Duplex) => {
    upgraded.push(socket);
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    writeTextFrame(socket, JSON.stringify({ type: 'welcome' }));
    socket.on('data', (buf: Buffer) => {
      const text = readTextFrame(buf);
      if (text === null) return;
      writeTextFrame(
        socket,
        JSON.stringify({ type: 'order.shipped', id: 'ORD-1001', carrier, attempts: 1 }),
      );
    });
    socket.on('error', () => socket.destroy());
  });

  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // The hand-rolled WebSocket endpoint has no close handshake, so an upgraded
  // socket would hold `close()` open forever.
  for (const socket of upgraded) socket.destroy();
  server.closeAllConnections();
  await new Promise<void>((closed) => server.close(() => closed()));
});

function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl,
    secrets: {},
    fixtures: {},
    grid: null,
    visualBaseline: null,
    storageState: null,
    artifacts: {
      put: async () => '',
      putFile: async () => '',
      get: async () => null,
      putPersistent: async () => '',
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, step: () => {} },
    signal: new AbortController().signal,
    determinism: {
      freezeClockAt: null,
      randomSeed: 1,
      waitForNetworkIdle: false,
      retryOnce: false,
    },
    ...overrides,
  };
}

function test(spec: unknown): ExecutableTest {
  return {
    id: 'test_1',
    name: 'orders events',
    type: 'CONTRACT',
    code: '',
    filePath: 'contracts/orders.json',
    spec,
    timeoutMs: 30_000,
    quarantined: false,
    tags: [],
  };
}

/** A message pact: one event, with the ORD id pinned and `attempts` by type. */
const MESSAGE_PACT = JSON.stringify({
  consumer: { name: 'shipping-ui' },
  provider: { name: 'orders-api' },
  messages: [
    {
      description: 'an order shipped event',
      providerStates: [{ name: 'an order has shipped' }],
      metadata: { topic: 'order.shipped', contentType: 'application/json' },
      contents: { id: 'ORD-1001', carrier: 'Demo Post', attempts: 99 },
      // `attempts` is matched by type; `carrier` is not, so changing it breaks.
      matchingRules: { body: { '$.attempts': { matchers: [{ match: 'type' }] } } },
    },
  ],
});

const ASYNCAPI = JSON.stringify({
  asyncapi: '2.6.0',
  info: { title: 'orders', version: '1' },
  channels: {
    'order.placed': {
      subscribe: {
        message: {
          name: 'OrderPlaced',
          payload: {
            type: 'object',
            required: ['id', 'total'],
            properties: { id: { type: 'string' }, total: { type: 'integer' } },
          },
        },
      },
    },
    'order.shipped': {
      subscribe: {
        message: {
          name: 'OrderShipped',
          payload: {
            type: 'object',
            required: ['id', 'carrier'],
            properties: {
              id: { type: 'string' },
              carrier: { type: 'string', minLength: 3 },
              attempts: { type: 'integer' },
            },
          },
        },
      },
    },
  },
});

// ─── Transports ──────────────────────────────────────────────────────────────

describe('collectMessages reads the transports QAAI already speaks', () => {
  it('reads named SSE events, their ids and their payloads', async () => {
    const collection = await collectMessages(
      context(),
      { transport: 'sse', path: '/events', method: 'GET', listenSeconds: 5, maxMessages: 50 },
      baseUrl,
      {},
    );

    expect(collection.transportError).toBeNull();
    expect(collection.messages.map((m) => m.name)).toEqual(['order.placed', 'order.shipped']);
    expect(JSON.parse(collection.messages[1]!.text)).toMatchObject({ carrier: 'Demo Post' });
    expect(collection.messages[1]!.metadata['id']).toBe('e2');
    // The channel is the topic, so a pact asserting `metadata.topic` matches.
    expect(collection.messages[1]!.metadata['topic']).toBe('order.shipped');
  });

  it('sends and reads WebSocket frames, naming them from the payload', async () => {
    const collection = await collectMessages(
      context(),
      {
        transport: 'websocket',
        url: '/ws',
        subprotocols: [],
        send: [{ subscribe: 'orders' }],
        listenSeconds: 5,
        maxMessages: 2,
        eventNamePath: 'type',
      },
      baseUrl,
      {},
    );

    expect(collection.transportError).toBeNull();
    expect(collection.messages.map((m) => m.name)).toEqual(['welcome', 'order.shipped']);
  });

  it('receives a webhook it hosts itself, and never keeps the sender credential', async () => {
    const collection = await collectMessages(
      context(),
      {
        transport: 'webhook',
        path: '/qaai/webhook',
        port: 0,
        eventNameHeader: 'x-event-name',
        respondStatus: 200,
        listenSeconds: 10,
        maxMessages: 1,
        trigger: {
          method: 'POST',
          url: '/trigger',
          headers: {},
          body: { callback: '{{callbackUrl}}' },
        },
      },
      baseUrl,
      {},
    );

    expect(collection.transportError).toBeNull();
    expect(collection.target).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/qaai\/webhook$/);
    expect(collection.messages).toHaveLength(1);
    expect(collection.messages[0]!.name).toBe('order.shipped');
    expect(Object.keys(collection.messages[0]!.metadata)).not.toContain('authorization');
    expect(JSON.stringify(collection.messages[0]!.metadata)).not.toContain('sender-secret-value');
  });

  it('reports an unreachable stream as a transport error rather than throwing', async () => {
    const collection = await collectMessages(
      context(),
      { transport: 'sse', path: '/nope', method: 'GET', listenSeconds: 2, maxMessages: 5 },
      baseUrl,
      {},
    );
    expect(collection.transportError).toMatch(/answered HTTP 404/);
  });
});

// ─── Message pacts ───────────────────────────────────────────────────────────

describe('message pacts are verified, not skipped', () => {
  const messageSpec = (source: unknown): unknown => ({
    kind: 'message',
    pactPath: 'contracts/orders-message.json',
    source,
    stateChangeUrl: '/pact/state',
    requestTimeoutSeconds: 10,
  });

  const fixtures = { 'fixtures/contracts/orders-message.json': MESSAGE_PACT };
  const withPact = (spec: unknown): ExecutableTest =>
    test({ ...(spec as object), pactPath: 'fixtures/contracts/orders-message.json' });

  it('verifies a message off the provider’s pact message endpoint', async () => {
    const result = await contractPlugin.execute(
      context({ fixtures }),
      withPact(messageSpec({ transport: 'http', url: '/pact/messages', method: 'POST' })),
    );

    expect(result.status).toBe('PASSED');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.title).toContain('an order shipped event');
  });

  it('verifies the same pact off an SSE stream, with the same matching rules', async () => {
    const result = await contractPlugin.execute(
      context({ fixtures }),
      withPact(messageSpec({ transport: 'sse', path: '/events', listenSeconds: 5 })),
    );

    // `attempts: 99` in the pact vs `1` on the wire is fine — it is matched by
    // type. Nothing else moved, so this is a pass.
    expect(result.status).toBe('PASSED');
    expect(result.steps[0]!.status).toBe('PASSED');
  });

  it('fails, with expected vs actual, when the provider changes a pinned value', async () => {
    carrier = 'Other Post';
    try {
      const result = await contractPlugin.execute(
        context({ fixtures }),
        withPact(messageSpec({ transport: 'sse', path: '/events', listenSeconds: 5 })),
      );

      expect(result.status).toBe('FAILED');
      expect(result.steps[0]!.status).toBe('FAILED');
      expect(result.steps[0]!.error?.message).toContain('carrier');
      expect(result.steps[0]!.error?.expected).toContain('Demo Post');
      expect(result.steps[0]!.error?.actual).toContain('Other Post');
    } finally {
      carrier = 'Demo Post';
    }
  });

  it('fails when the declared event never arrives, saying what did', async () => {
    const pact = JSON.parse(MESSAGE_PACT) as Record<string, unknown>;
    (pact.messages as Array<Record<string, unknown>>)[0]!.metadata = { topic: 'order.refunded' };
    const result = await contractPlugin.execute(
      context({ fixtures: { 'fixtures/contracts/absent.json': JSON.stringify(pact) } }),
      test({
        ...(messageSpec({ transport: 'sse', path: '/events', listenSeconds: 2 }) as object),
        pactPath: 'fixtures/contracts/absent.json',
      }),
    );

    expect(result.status).toBe('FAILED');
    expect(result.steps[0]!.error?.message).toContain('order.refunded');
    expect(result.steps[0]!.error?.message).toContain('order.shipped');
  });

  it('points a message-only pact run in "pact" mode at the mode that verifies it', async () => {
    const result = await contractPlugin.execute(
      context({ fixtures }),
      test({ kind: 'pact', pactPath: 'fixtures/contracts/orders-message.json' }),
    );

    expect(result.status).toBe('SKIPPED');
    expect(result.errorMessage).toContain('"message"');
  });

  it('never lets the "pact" mode hide a message interaction it did not replay', async () => {
    const mixed = JSON.stringify({
      consumer: { name: 'shipping-ui' },
      provider: { name: 'orders-api' },
      interactions: [
        {
          description: 'the events stream',
          request: { method: 'GET', path: '/pact/state' },
          response: { status: 200, body: { ok: true } },
        },
      ],
      messages: [{ description: 'an order shipped event', contents: {} }],
    });

    const result = await contractPlugin.execute(
      context({ fixtures: { 'fixtures/contracts/mixed.json': mixed } }),
      test({ kind: 'pact', pactPath: 'fixtures/contracts/mixed.json' }),
    );

    expect(result.status).toBe('PASSED');
    const skipped = result.steps.find((step) => step.status === 'SKIPPED');
    expect(skipped?.title).toContain('an order shipped event');
    expect(skipped?.error?.message).toContain('"message"');
  });
});

// ─── Event shapes ────────────────────────────────────────────────────────────

describe('event shapes declared inline', () => {
  it('passes when the declared event arrives in the declared shape', async () => {
    const result = await contractPlugin.execute(
      context(),
      test({
        kind: 'events',
        source: { transport: 'sse', path: '/events', listenSeconds: 5 },
        expect: [
          {
            name: 'the shipped event',
            event: 'order.shipped',
            contents: { id: 'ORD-1001', carrier: 'Demo Post' },
          },
          { name: 'the placed event', event: 'order.placed' },
        ],
      }),
    );

    expect(result.status).toBe('PASSED');
    // A listen step plus one per expectation.
    expect(result.steps).toHaveLength(3);
  });

  it('fails when nothing on the stream matches, and says what arrived', async () => {
    const result = await contractPlugin.execute(
      context(),
      test({
        kind: 'events',
        source: { transport: 'sse', path: '/events', listenSeconds: 2 },
        expect: [{ event: 'order.cancelled' }],
      }),
    );

    expect(result.status).toBe('FAILED');
    expect(result.steps[1]!.error?.actual).toContain('order.shipped');
  });

  it('fails the whole test when the transport itself cannot be opened', async () => {
    const result = await contractPlugin.execute(
      context(),
      test({
        kind: 'events',
        source: { transport: 'sse', path: '/nope', listenSeconds: 2 },
        expect: [{ event: 'order.shipped' }],
      }),
    );

    expect(result.status).toBe('FAILED');
    expect(result.steps[0]!.error?.message).toContain('404');
  });
});

// ─── AsyncAPI ────────────────────────────────────────────────────────────────

describe('AsyncAPI conformance', () => {
  const fixtures = { 'fixtures/asyncapi.json': ASYNCAPI };
  const spec = (extra: Record<string, unknown> = {}): unknown => ({
    kind: 'asyncapi',
    specPath: 'fixtures/asyncapi.json',
    source: { transport: 'sse', path: '/events', listenSeconds: 5 },
    ...extra,
  });

  it('passes when every emitted message conforms to its channel schema', async () => {
    const result = await contractPlugin.execute(context({ fixtures }), test(spec()));
    expect(result.status).toBe('PASSED');
    expect(result.steps.filter((step) => step.status === 'PASSED')).toHaveLength(3);
  });

  it('fails a payload that violates the declared schema', async () => {
    carrier = 'X';
    try {
      const result = await contractPlugin.execute(context({ fixtures }), test(spec()));
      expect(result.status).toBe('FAILED');
      const failed = result.steps.find((step) => step.status === 'FAILED');
      expect(failed?.error?.message).toContain('minimum is 3');
    } finally {
      carrier = 'Demo Post';
    }
  });

  it('treats a message on an undeclared channel as drift', async () => {
    extraEvent = ['order.refunded', { id: 'ORD-1001' }];
    try {
      const result = await contractPlugin.execute(context({ fixtures }), test(spec()));
      expect(result.status).toBe('FAILED');
      const failed = result.steps.find((step) => step.status === 'FAILED');
      expect(failed?.error?.message).toContain('does not declare');
    } finally {
      extraEvent = null;
    }
  });

  it('lets a stream carry control frames the document was never meant to describe', async () => {
    extraEvent = ['keepalive', { at: 1 }];
    try {
      const result = await contractPlugin.execute(
        context({ fixtures }),
        test(spec({ allowUndeclaredChannels: true })),
      );
      expect(result.status).toBe('PASSED');
    } finally {
      extraEvent = null;
    }
  });

  it('reports an Avro payload as not verified rather than passing it', async () => {
    const avro = JSON.parse(ASYNCAPI) as Record<string, unknown>;
    const channels = avro.channels as Record<string, Record<string, Record<string, unknown>>>;
    channels['order.shipped']!.subscribe!.message = {
      name: 'OrderShipped',
      schemaFormat: 'application/vnd.apache.avro;version=1.9.0',
      payload: { type: 'record' },
    };

    const result = await contractPlugin.execute(
      context({ fixtures: { 'fixtures/avro.json': JSON.stringify(avro) } }),
      test(spec({ specPath: 'fixtures/avro.json' })),
    );

    const skipped = result.steps.filter((step) => step.status === 'SKIPPED');
    expect(skipped.some((step) => step.error?.message?.includes('avro'))).toBe(true);
    expect(result.status).toBe('PASSED');
  });

  it('does not call a silent stream a pass', async () => {
    const result = await contractPlugin.execute(
      context({ fixtures }),
      test(spec({ source: { transport: 'sse', path: '/events/silent', listenSeconds: 1 } })),
    );
    expect(result.status).toBe('SKIPPED');
    expect(result.errorMessage).toContain('No message arrived');
  });

  it('does not call "none of the requested channels fired" a pass either', async () => {
    const result = await contractPlugin.execute(
      context({ fixtures }),
      test(spec({ channels: ['order.cancelled'] })),
    );
    expect(result.status).toBe('SKIPPED');
    expect(result.errorMessage).toContain('order.cancelled');
  });
});

// ─── Publishing to a broker ──────────────────────────────────────────────────

describe('brokerOrigin refuses every destination that is not the customer’s broker', () => {
  const refusals: Array<[string, string, RegExp]> = [
    ['plain http', 'http://broker.example.com', /must be https/],
    [
      'credentials in the URL',
      'https://user:tok@broker.example.com',
      /Remove|remove the credentials/,
    ],
    ['an IPv4 literal', 'https://169.254.169.254/', /refusing to send/],
    ['an IPv6 literal', 'https://[::1]/', /refusing to send/],
    ['loopback by name', 'https://localhost/', /refusing to send/],
    ['a trailing-dot loopback', 'https://localhost./', /refusing to send/],
    ['a trailing-dot metadata host', 'https://metadata.google.internal./', /refusing to send/],
    ['a kubernetes service name', 'https://kubernetes.default.svc/', /refusing to send/],
    ['a single-label host', 'https://broker/', /refusing to send/],
    /*
     * `new URL()` resolves `..` and `%2e%2e` away on its own, but an encoded
     * SLASH hides the segment boundary from it: `/a/..%2f..` survives parsing
     * intact and becomes `/a/../..` on any server that decodes before it
     * resolves. That is why the guard runs on the DECODED path.
     */
    [
      'a traversal hidden behind an encoded slash',
      'https://broker.example.com/a/..%2f..',
      /\.\. path segments/,
    ],
  ];

  for (const [what, url, expected] of refusals) {
    it(`refuses ${what}`, () => {
      const result = brokerOrigin(url);
      expect(result).toHaveProperty('refused');
      expect('refused' in result ? result.refused : '').toMatch(expected);
    });
  }

  it('accepts a real broker, keeping its context path and port', () => {
    expect(brokerOrigin('https://Broker.Example.com:9292/pact/')).toEqual({
      origin: 'https://broker.example.com:9292/pact',
      host: 'broker.example.com',
    });
  });

  it('normalises the trailing dot away rather than re-attaching it to the request', () => {
    expect(brokerOrigin('https://broker.example.com./')).toEqual({
      origin: 'https://broker.example.com',
      host: 'broker.example.com',
    });
  });

  it('resolves literal dot segments away instead of carrying them into the request', () => {
    expect(brokerOrigin('https://broker.example.com/a/../pact')).toEqual({
      origin: 'https://broker.example.com/pact',
      host: 'broker.example.com',
    });
  });
});

describe('the verification-results URL is built, never taken from the document', () => {
  it('addresses a pact by content SHA', () => {
    expect(
      verificationResultsUrl('https://broker.example.com', 'orders-api', 'shipping-ui', {
        pactVersion: 'abc123',
      }),
    ).toEqual({
      url: 'https://broker.example.com/pacts/provider/orders-api/consumer/shipping-ui/pact-version/abc123/verification-results',
    });
  });

  it('addresses a pact by consumer version', () => {
    expect(
      verificationResultsUrl('https://broker.example.com', 'orders-api', 'shipping-ui', {
        consumerVersion: '1.2.3',
      }),
    ).toEqual({
      url: 'https://broker.example.com/pacts/provider/orders-api/consumer/shipping-ui/version/1.2.3/verification-results',
    });
  });

  it('refuses to guess when the pact is not addressed at all', () => {
    expect(verificationResultsUrl('https://broker.example.com', 'p', 'c', {})).toHaveProperty(
      'refused',
    );
  });

  it('refuses both at once', () => {
    expect(
      verificationResultsUrl('https://b.example.com', 'p', 'c', {
        pactVersion: 'a',
        consumerVersion: 'b',
      }),
    ).toHaveProperty('refused');
  });

  it('never lets a name in the pact escape its path segment', () => {
    expect(
      verificationResultsUrl('https://broker.example.com', '../../admin', 'c', {
        pactVersion: 'x',
      }),
    ).toHaveProperty('refused');

    const encoded = verificationResultsUrl('https://broker.example.com', 'orders api', 'c', {
      pactVersion: 'x',
    });
    expect('url' in encoded ? encoded.url : '').toContain('/provider/orders%20api/');
  });
});

describe('publishing is never the reason a contract test fails', () => {
  const publishInput = {
    consumerName: 'shipping-ui',
    providerName: 'orders-api',
    success: true,
    results: [{ interactionDescription: 'an order shipped event', success: true }],
  };

  it('skips, with the fix, when the broker URL is one QAAI refuses', async () => {
    const outcome = await publishVerification(
      context(),
      { brokerUrl: 'http://broker.example.com', providerVersion: '1', pactVersion: 'x' },
      publishInput,
    );
    expect(outcome.status).toBe('SKIPPED');
    expect(outcome.detail).toContain('https');
  });

  it('skips, naming the secret, when the broker credential is not set', async () => {
    const outcome = await publishVerification(
      context(),
      {
        brokerUrl: 'https://broker.example.com',
        providerVersion: '1',
        pactVersion: 'x',
        auth: { scheme: 'bearer', secretName: 'PACT_BROKER_TOKEN' },
      },
      publishInput,
    );
    expect(outcome.status).toBe('SKIPPED');
    expect(outcome.detail).toContain('PACT_BROKER_TOKEN');
    // The URL was never built with a token in it, and nothing was requested.
    expect(outcome.network).toBeNull();
  });

  it('skips when the broker cannot be reached, and says the verdict stands', async () => {
    const outcome = await publishVerification(
      context(),
      { brokerUrl: 'https://broker.invalid', providerVersion: '1', pactVersion: 'x' },
      publishInput,
    );
    expect(outcome.status).toBe('SKIPPED');
    expect(outcome.detail).toContain('unaffected');
    expect(outcome.network?.responseBodySnippet).toBe('the broker was unreachable');
  }, 20_000);

  it('leaves a passing verification GREEN when the broker is unusable', async () => {
    const result = await contractPlugin.execute(
      context({
        fixtures: { 'fixtures/contracts/orders-message.json': MESSAGE_PACT },
        secrets: { PACT_BROKER_TOKEN: 'super-secret-broker-token' },
      }),
      test({
        kind: 'message',
        pactPath: 'fixtures/contracts/orders-message.json',
        source: { transport: 'sse', path: '/events', listenSeconds: 5 },
        publish: {
          // Loopback: refused before the token is ever read.
          brokerUrl: 'https://localhost:9292',
          providerVersion: 'deadbee',
          pactVersion: 'abc123',
          auth: { scheme: 'bearer', secretName: 'PACT_BROKER_TOKEN' },
        },
      }),
    );

    expect(result.status).toBe('PASSED');
    const publishStep = result.steps.at(-1)!;
    expect(publishStep.title).toContain('Publish verification results');
    expect(publishStep.status).toBe('SKIPPED');
    expect(publishStep.error?.message).toContain('refusing to send a broker token');
    expect(JSON.stringify(result)).not.toContain('super-secret-broker-token');
  });

  it('reports a `publish` block that does not parse instead of dropping it', async () => {
    const result = await contractPlugin.execute(
      context({
        fixtures: {
          'fixtures/contracts/mixed.json': JSON.stringify({
            consumer: { name: 'c' },
            provider: { name: 'p' },
            interactions: [
              {
                description: 'state',
                request: { method: 'GET', path: '/pact/state' },
                response: { status: 200 },
              },
            ],
          }),
        },
      }),
      test({
        kind: 'pact',
        pactPath: 'fixtures/contracts/mixed.json',
        publish: { brokerUrl: 'https://broker.example.com' },
      }),
    );

    expect(result.status).toBe('PASSED');
    const publishStep = result.steps.at(-1)!;
    expect(publishStep.status).toBe('SKIPPED');
    expect(publishStep.error?.message).toContain('providerVersion');
  });
});

describe('an invalid async spec names the field', () => {
  it('lists every kind when the kind is unknown', () => {
    expect(() => contractPlugin.validate(test({ kind: 'kafka' }))).toThrow(/asyncapi/);
  });

  it('names the missing field on an async spec', () => {
    expect(() => contractPlugin.validate(test({ kind: 'events' }))).toThrow(/source|expect/);
  });
});
