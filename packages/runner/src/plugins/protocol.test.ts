/**
 * Protocol plugin tests.
 *
 * Everything here runs against a real server on a real socket — an http server
 * for GraphQL and SSE, and a hand-rolled RFC 6455 endpoint for WebSocket. The
 * point of this plugin is wire behaviour (a GraphQL error arriving with HTTP
 * 200, a heartbeat interleaved with the message under test, a stream that goes
 * quiet), and none of that is exercised by a mocked transport.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, RequestListener, Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SECRET_MASK } from '@qaai/shared';
import type { ExecutableTest, RunContext, TestExecution } from '@qaai/shared';
import { protocolPlugin } from './protocol.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
    ),
  );
});

async function listen(server: Server): Promise<string> {
  openServers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

function httpServer(handler: RequestListener): Promise<string> {
  return listen(createServer(handler));
}

function makeTest(spec: unknown, name = 'protocol test'): ExecutableTest {
  return {
    id: 'test_1',
    name,
    type: 'PROTOCOL',
    code: '',
    filePath: 'protocol/spec.json',
    spec,
    timeoutMs: 30_000,
    quarantined: false,
    tags: [],
  };
}

function makeCtx(baseUrl: string, secrets: Record<string, string> = {}): RunContext {
  return {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl,
    secrets,
    storageState: null,
    artifacts: {
      put: async () => 'key',
      putFile: async () => 'key',
      get: async () => null,
      putPersistent: async () => 'key',
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

/** Titles + statuses, which is what the cockpit renders. */
function outline(execution: TestExecution): string[] {
  return execution.steps.map((step) => `${step.status} ${step.title}`);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((done) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      try {
        done(JSON.parse(raw || '{}') as Record<string, unknown>);
      } catch {
        done({});
      }
    });
  });
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ─── A minimal RFC 6455 server ───────────────────────────────────────────────
//
// `ws` is not a dependency of this repo and the plugin deliberately uses the
// runtime's own client, so the server side is 60 lines of framing here rather
// than a new package in the runner's dependency tree.

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

/** Decodes complete client frames out of `buffer`; returns the unconsumed tail. */
function decodeFrames(buffer: Buffer, onFrame: (opcode: number, payload: string) => void): Buffer {
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const opcode = (buffer[offset] ?? 0) & 0x0f;
    const second = buffer[offset + 1] ?? 0;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (buffer.length < cursor + 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length < cursor + 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }

    const maskKey = masked ? buffer.subarray(cursor, cursor + 4) : null;
    if (masked) cursor += 4;
    if (buffer.length < cursor + length) break;

    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (maskKey) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] = (payload[i] ?? 0) ^ (maskKey[i % 4] ?? 0);
      }
    }
    cursor += length;
    offset = cursor;
    onFrame(opcode, payload.toString('utf8'));
  }
  return buffer.subarray(offset);
}

interface WsConnection {
  send(text: string): void;
  headers: IncomingMessage['headers'];
  close(): void;
}

/** `onConnection` receives the accepted connection and returns its message handler. */
async function websocketServer(
  onConnection: (conn: WsConnection) => (text: string) => void,
): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(426);
    res.end('upgrade required');
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const key = req.headers['sec-websocket-key'] ?? '';
    const accept = createHash('sha1')
      .update(`${key}${WS_GUID}`)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'),
    );

    const conn: WsConnection = {
      headers: req.headers,
      send: (text) => socket.write(encodeTextFrame(text)),
      close: () => socket.end(),
    };
    const handler = onConnection(conn);

    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = decodeFrames(Buffer.concat([pending, chunk]), (opcode, payload) => {
        if (opcode === 0x8) socket.end();
        else if (opcode === 0x1) handler(payload);
      });
    });
    socket.on('error', () => socket.destroy());
  });

  return listen(server);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// ─── GraphQL ─────────────────────────────────────────────────────────────────

describe('protocol plugin — GraphQL', () => {
  it('asserts on data and chains extracted variables between operations', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const baseUrl = await httpServer(async (req, res) => {
      const body = await readJsonBody(req);
      seen.push(body);
      const query = String(body.query ?? '');
      if (query.includes('viewer')) {
        sendJson(res, { data: { viewer: { id: 'u_42', email: 'ada@example.com' } } });
      } else {
        sendJson(res, { data: { user: { name: `user ${String(body.variables)}` } } });
      }
    });

    const execution = await protocolPlugin.execute(
      makeCtx(baseUrl),
      makeTest({
        protocol: 'GRAPHQL',
        operations: [
          {
            name: 'who am I',
            query: 'query Viewer { viewer { id email } }',
            assertions: { dataMatches: { 'viewer.email': 'ada@example.com' } },
            extract: { userId: 'viewer.id' },
          },
          {
            name: 'load that user',
            query: 'query User($id: ID!) { user(id: $id) { name } }',
            variables: { id: '{{userId}}' },
          },
        ],
      }),
    );

    expect(outline(execution)).toEqual([
      'PASSED who am I (GraphQL)',
      'PASSED load that user (GraphQL)',
    ]);
    expect(execution.status).toBe('PASSED');
    // The id extracted from operation 1 was substituted into operation 2.
    expect(seen[1]?.variables).toEqual({ id: 'u_42' });
  });

  it('fails on a GraphQL error even though the transport said HTTP 200', async () => {
    const baseUrl = await httpServer((_req, res) => {
      sendJson(res, { data: null, errors: [{ message: 'Field "ghost" does not exist' }] }, 200);
    });

    const execution = await protocolPlugin.execute(
      makeCtx(baseUrl),
      makeTest({
        protocol: 'GRAPHQL',
        operations: [{ name: 'broken query', query: '{ ghost }' }],
      }),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toContain('HTTP 200');
    expect(execution.errorMessage).toContain('does not exist');
    expect(execution.network[0]?.status).toBe(200);
  });

  it('passes when the errors were the point of the test', async () => {
    const baseUrl = await httpServer((_req, res) => {
      sendJson(res, { data: null, errors: [{ message: 'Not authorised' }] });
    });

    const execution = await protocolPlugin.execute(
      makeCtx(baseUrl),
      makeTest({
        protocol: 'GRAPHQL',
        operations: [
          {
            name: 'anonymous read is rejected',
            query: '{ secrets }',
            assertions: { expectErrors: true, errorMessageContains: 'Not authorised' },
          },
        ],
      }),
    );

    expect(execution.status).toBe('PASSED');
  });

  it('catches a root field the schema does not expose, via introspection', async () => {
    const baseUrl = await httpServer(async (req, res) => {
      const body = await readJsonBody(req);
      if (String(body.query ?? '').includes('__schema')) {
        sendJson(res, {
          data: {
            __schema: {
              queryType: { name: 'Query', fields: [{ name: 'viewer' }, { name: 'orders' }] },
              mutationType: { name: 'Mutation', fields: [{ name: 'signIn' }] },
              subscriptionType: null,
            },
          },
        });
        return;
      }
      sendJson(res, { data: {} });
    });

    const execution = await protocolPlugin.execute(
      makeCtx(baseUrl),
      makeTest({
        protocol: 'GRAPHQL',
        introspect: true,
        operations: [
          { name: 'good', query: 'query Good { viewer { id } }' },
          { name: 'typo', query: 'query Typo { vewier { id } }' },
        ],
      }),
    );

    expect(outline(execution)).toEqual([
      'PASSED Introspect schema — 2 query, 1 mutation, 0 subscription fields',
      'PASSED Validate "good" against schema',
      'PASSED good (GraphQL)',
      'FAILED Validate "typo" against schema',
      'SKIPPED typo (GraphQL) — not sent, the schema check failed',
    ]);
    expect(execution.errorMessage).toContain('vewier');
  });

  it('skips — never fails — schema validation when introspection is closed', async () => {
    const baseUrl = await httpServer(async (req, res) => {
      const body = await readJsonBody(req);
      if (String(body.query ?? '').includes('__schema')) {
        sendJson(res, { errors: [{ message: 'introspection is disabled' }] }, 200);
        return;
      }
      sendJson(res, { data: { ping: 'pong' } });
    });

    const execution = await protocolPlugin.execute(
      makeCtx(baseUrl),
      makeTest({
        protocol: 'GRAPHQL',
        introspect: true,
        operations: [
          { name: 'ping', query: '{ ping }', assertions: { dataMatches: { ping: 'pong' } } },
        ],
      }),
    );

    expect(execution.steps[0]?.status).toBe('SKIPPED');
    expect(execution.steps[0]?.title).toContain('not available');
    expect(execution.status).toBe('PASSED');
  });
});

// ─── WebSocket ───────────────────────────────────────────────────────────────

describe('protocol plugin — WebSocket', () => {
  it('scans past interleaved traffic to find the message under test', async () => {
    const baseUrl = await websocketServer((conn) => (text) => {
      const request = JSON.parse(text) as { type?: string };
      if (request.type !== 'subscribe') return;
      // Exactly the interleaving that breaks an "assert on the next frame" test.
      conn.send(JSON.stringify({ type: 'heartbeat', n: 1 }));
      conn.send(JSON.stringify({ type: 'presence', user: 'someone else' }));
      setTimeout(() => conn.send(JSON.stringify({ type: 'order', id: 'ord_9', total: 42 })), 25);
    });

    const execution = await protocolPlugin.execute(
      makeCtx(baseUrl),
      makeTest({
        protocol: 'WEBSOCKET',
        url: '/ws',
        steps: [
          { action: 'SEND', name: 'subscribe to orders', payload: { type: 'subscribe' } },
          {
            action: 'EXPECT',
            name: 'the order arrives',
            jsonMatches: { type: 'order' },
            extract: { orderId: 'id' },
            timeoutMs: 3000,
          },
        ],
      }),
    );

    expect(execution.status).toBe('PASSED');
    expect(outline(execution)).toEqual([
      expect.stringContaining('PASSED Connect to ws://'),
      'PASSED Send — subscribe to orders',
      'PASSED Expect — the order arrives',
    ]);
    // The heartbeat and presence frames were passed over, not asserted on.
    expect(execution.console.map((entry) => entry.text)).toEqual([
      expect.stringContaining('• connected'),
      expect.stringContaining('↑ {"type":"subscribe"}'),
      expect.stringContaining('↓ {"type":"heartbeat"'),
      expect.stringContaining('↓ {"type":"presence"'),
      expect.stringContaining('↓ {"type":"order"'),
    ]);
  });

  it('NEXT mode asserts on the very next frame and fails on the heartbeat', async () => {
    const baseUrl = await websocketServer((conn) => () => {
      conn.send(JSON.stringify({ type: 'heartbeat' }));
      conn.send(JSON.stringify({ type: 'order' }));
    });

    const execution = await protocolPlugin.execute(
      makeCtx(baseUrl),
      makeTest({
        protocol: 'WEBSOCKET',
        steps: [
          { action: 'SEND', name: 'subscribe', payload: '{"type":"subscribe"}' },
          {
            action: 'EXPECT',
            name: 'order is first',
            mode: 'NEXT',
            jsonMatches: { type: 'order' },
            timeoutMs: 2000,
          },
        ],
      }),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toBe('The next message did not match');
    expect(execution.steps[2]?.error?.actual).toContain('heartbeat');
  });

  it('reports what it did see when nothing matches before the deadline', async () => {
    const baseUrl = await websocketServer((conn) => () => {
      conn.send(JSON.stringify({ type: 'heartbeat', n: 1 }));
      conn.send(JSON.stringify({ type: 'heartbeat', n: 2 }));
    });

    const execution = await protocolPlugin.execute(
      makeCtx(baseUrl),
      makeTest({
        protocol: 'WEBSOCKET',
        steps: [
          { action: 'SEND', name: 'subscribe', payload: '{}' },
          {
            action: 'EXPECT',
            name: 'an order eventually',
            jsonMatches: { type: 'order' },
            timeoutMs: 250,
          },
        ],
      }),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toContain('No message matching the predicate arrived within 250ms');
    expect(execution.steps[2]?.error?.actual).toContain('saw 2 other message(s)');
    expect(execution.steps[2]?.error?.expected).toBe('type = "order"');
  });

  it('sends vault secrets as upgrade headers and masks them on the way out', async () => {
    const token = 'supersecret-token-abcdef';
    const baseUrl = await websocketServer((conn) => () => {
      conn.send(JSON.stringify({ type: 'auth', saw: conn.headers.authorization ?? null }));
    });

    const execution = await protocolPlugin.execute(
      makeCtx(baseUrl, { API_TOKEN: token }),
      makeTest({
        protocol: 'WEBSOCKET',
        headers: { authorization: 'Bearer {{API_TOKEN}}' },
        steps: [
          { action: 'SEND', name: 'hello', payload: '{}' },
          {
            action: 'EXPECT',
            name: 'server saw the bearer token',
            contains: `Bearer ${token}`,
            timeoutMs: 3000,
          },
          { action: 'CLOSE', name: 'done' },
        ],
      }),
    );

    expect(execution.status).toBe('PASSED');
    const transcript = execution.console.map((entry) => entry.text).join('\n');
    expect(transcript).not.toContain(token);
    expect(transcript).toContain(SECRET_MASK);
  });

  it('WAIT holds for its full duration even while frames are arriving', async () => {
    const baseUrl = await websocketServer((conn) => () => {
      // A chatty server: without a dedicated timer the WAIT below would be woken
      // by the first heartbeat and return almost immediately.
      const timer = setInterval(() => conn.send(JSON.stringify({ type: 'heartbeat' })), 10);
      setTimeout(() => clearInterval(timer), 600);
    });

    const began = Date.now();
    const execution = await protocolPlugin.execute(
      makeCtx(baseUrl),
      makeTest({
        protocol: 'WEBSOCKET',
        steps: [
          { action: 'SEND', name: 'subscribe', payload: '{}' },
          { action: 'WAIT', name: 'let the server settle', ms: 200 },
        ],
      }),
    );

    expect(execution.status).toBe('PASSED');
    expect(Date.now() - began).toBeGreaterThanOrEqual(195);
  });

  it('fails the connect step rather than hanging when nothing is listening', async () => {
    const execution = await protocolPlugin.execute(
      makeCtx('http://127.0.0.1:1'),
      makeTest({
        protocol: 'WEBSOCKET',
        openTimeoutMs: 1500,
        steps: [{ action: 'EXPECT', name: 'anything', timeoutMs: 500 }],
      }),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.steps).toHaveLength(1);
    expect(execution.steps[0]?.status).toBe('FAILED');
    expect(execution.steps[0]?.error?.message).toBe('WebSocket connection error');
  });
});

// ─── SSE ─────────────────────────────────────────────────────────────────────

describe('protocol plugin — SSE', () => {
  it('waits for named events, counts them, and extracts from the payload', async () => {
    const baseUrl = await httpServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
      res.write(': keepalive\n\n');
      res.write('event: tick\ndata: {"n":1}\n\n');
      await sleep(20);
      res.write('event: noise\ndata: ignore me\n\n');
      res.write('event: tick\ndata: {"n":2}\n\n');
      await sleep(20);
      res.write('event: done\ndata: {"status":"complete"}\n\n');
    });

    const execution = await protocolPlugin.execute(
      makeCtx(baseUrl),
      makeTest({
        protocol: 'SSE',
        path: '/events',
        expect: [
          { name: 'two ticks', event: 'tick', count: 2, timeoutMs: 3000 },
          {
            name: 'completion',
            event: 'done',
            jsonMatches: { status: 'complete' },
            extract: { finalStatus: 'status' },
            timeoutMs: 3000,
          },
        ],
      }),
    );

    expect(execution.status).toBe('PASSED');
    expect(outline(execution)).toEqual([
      expect.stringContaining('PASSED Open GET'),
      'PASSED Expect event "tick", ×2 — two ticks',
      'PASSED Expect event "done" — completion',
    ]);
    // The `: keepalive` comment was not dispatched as an event.
    expect(execution.console.every((entry) => !entry.text.includes('keepalive'))).toBe(true);
  });

  it('fails the expectation that ran out of time, and says how far it got', async () => {
    const baseUrl = await httpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: tick\ndata: 1\n\n');
      // …and then goes quiet, which is the bug this test exists to catch.
    });

    const execution = await protocolPlugin.execute(
      makeCtx(baseUrl),
      makeTest({
        protocol: 'SSE',
        expect: [{ name: 'three ticks', event: 'tick', count: 3, timeoutMs: 300 }],
      }),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toBe(
      'Only 1 of 3 matching event(s) arrived within 300ms',
    );
  });

  it('fails to connect on a non-2xx and skips the expectations', async () => {
    const baseUrl = await httpServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('nope');
    });

    const execution = await protocolPlugin.execute(
      makeCtx(baseUrl),
      makeTest({
        protocol: 'SSE',
        expect: [{ name: 'a tick', event: 'tick' }],
      }),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toContain('HTTP 503');
    expect(execution.steps[1]?.status).toBe('SKIPPED');
  });

  it('parses CRLF streams and events split across TCP chunks', async () => {
    const baseUrl = await httpServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: split\r\ndata: {"half"');
      await sleep(30);
      res.write(':"two"}\r\n\r\n');
    });

    const execution = await protocolPlugin.execute(
      makeCtx(baseUrl),
      makeTest({
        protocol: 'SSE',
        expect: [
          {
            name: 'reassembled event',
            event: 'split',
            jsonMatches: { half: 'two' },
            timeoutMs: 3000,
          },
        ],
      }),
    );

    expect(execution.status).toBe('PASSED');
  });
});

// ─── gRPC ────────────────────────────────────────────────────────────────────

describe('protocol plugin — gRPC', () => {
  it('reports a missing grpcurl as SKIPPED with the install command', async () => {
    // grpcurl is genuinely absent from this machine, so this is the real path
    // rather than a stub. If it is ever installed, the assertion below tells you.
    const execution = await protocolPlugin.execute(
      makeCtx('http://127.0.0.1:50051'),
      makeTest({
        protocol: 'GRPC',
        plaintext: true,
        calls: [{ name: 'health check', method: 'grpc.health.v1.Health/Check' }],
      }),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('grpcurl is not installed');
    expect(execution.errorMessage).toContain('brew install grpcurl');
    // A missing tool must never be reported as a failing test.
    expect(execution.steps.some((step) => step.status === 'FAILED')).toBe(false);
  });

  // The tests below put a STUB `grpcurl` on PATH. They cover this plugin's half
  // of the contract — the argv it builds and the status text it reads back — and
  // nothing about a real gRPC server, which would need the actual binary.
  describe('against a stubbed grpcurl', () => {
    const originalPath = process.env.PATH;
    let binDir = '';
    let argsFile = '';

    beforeEach(async () => {
      binDir = await mkdtemp(join(tmpdir(), 'qaai-grpcurl-'));
      argsFile = join(binDir, 'argv.txt');
      const script = `#!/bin/sh
printf '%s\\n' "$@" > "$QAAI_STUB_ARGS"
if [ "$QAAI_STUB_MODE" = "json-error" ]; then
  echo '{"code":5,"message":"account not found"}' >&2
  exit 1
fi
if [ "$QAAI_STUB_MODE" = "text-error" ]; then
  printf 'ERROR:\\n  Code: PermissionDenied\\n  Message: caller lacks scope\\n' >&2
  exit 1
fi
echo '{"status":"SERVING","details":{"uptime":42}}'
`;
      await writeFile(join(binDir, 'grpcurl'), script, { mode: 0o755 });
      process.env.PATH = `${binDir}:${originalPath ?? ''}`;
      process.env.QAAI_STUB_ARGS = argsFile;
      process.env.QAAI_STUB_MODE = 'ok';
    });

    afterEach(async () => {
      process.env.PATH = originalPath;
      delete process.env.QAAI_STUB_ARGS;
      delete process.env.QAAI_STUB_MODE;
      await rm(binDir, { recursive: true, force: true });
    });

    it('builds the argv with reflection, metadata from the vault, and the request', async () => {
      const execution = await protocolPlugin.execute(
        makeCtx('http://svc.internal:50051', { GRPC_TOKEN: 'tok-1234567890' }),
        makeTest({
          protocol: 'GRPC',
          plaintext: true,
          timeoutSeconds: 12,
          calls: [
            {
              name: 'health',
              method: 'grpc.health.v1.Health/Check',
              request: { service: 'orders' },
              metadata: { authorization: 'Bearer {{GRPC_TOKEN}}' },
              assertions: { responseMatches: { status: 'SERVING' } },
              extract: { uptime: 'details.uptime' },
            },
          ],
        }),
      );

      expect(execution.status).toBe('PASSED');
      const argv = (await readFile(argsFile, 'utf8')).trimEnd().split('\n');
      expect(argv).toEqual([
        '-plaintext',
        '-format-error',
        '-max-time',
        '12',
        '-H',
        'authorization: Bearer tok-1234567890',
        '-d',
        '{"service":"orders"}',
        // No -proto, so grpcurl falls back to server reflection.
        'svc.internal:50051',
        'grpc.health.v1.Health/Check',
      ]);
      // The token was interpolated for the child but masked on the way out.
      expect(JSON.stringify(execution.console)).not.toContain('tok-1234567890');
    });

    it('reads a JSON status back as a named gRPC code', async () => {
      process.env.QAAI_STUB_MODE = 'json-error';
      const execution = await protocolPlugin.execute(
        makeCtx('http://svc.internal:50051'),
        makeTest({
          protocol: 'GRPC',
          plaintext: true,
          calls: [{ name: 'missing account', method: 'billing.v1.Accounts/Get' }],
        }),
      );

      expect(execution.status).toBe('FAILED');
      expect(execution.errorMessage).toBe(
        'Expected gRPC status OK, got NOT_FOUND (account not found)',
      );
      expect(execution.network[0]?.status).toBe(5);
    });

    it("reads grpcurl's Go-style status names as wire names", async () => {
      process.env.QAAI_STUB_MODE = 'text-error';
      const execution = await protocolPlugin.execute(
        makeCtx('http://svc.internal:50051'),
        makeTest({
          protocol: 'GRPC',
          plaintext: true,
          calls: [
            {
              name: 'denied on purpose',
              method: 'billing.v1.Accounts/Get',
              assertions: { status: 'PERMISSION_DENIED' },
            },
          ],
        }),
      );

      expect(execution.status).toBe('PASSED');
    });
  });
});

// ─── validate() ──────────────────────────────────────────────────────────────

describe('protocol plugin — validate', () => {
  it('names the discriminator when the protocol is unknown', () => {
    expect(() => protocolPlugin.validate(makeTest({ protocol: 'MQTT' }, 'my test'))).toThrow(
      /"protocol" to one of GRAPHQL, WEBSOCKET, SSE, GRPC — got "MQTT"/,
    );
  });

  it('names the offending field on a malformed spec', () => {
    let message = '';
    try {
      protocolPlugin.validate(
        makeTest({ protocol: 'SSE', expect: [{ name: 'x', count: 0 }] }, 'sse test'),
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('sse test');
    expect(message).toContain('expect.0.count');
  });

  it('rejects an unparseable matchesRegex instead of letting it never match', () => {
    expect(() =>
      protocolPlugin.validate(
        makeTest(
          {
            protocol: 'WEBSOCKET',
            steps: [{ action: 'EXPECT', name: 'bad pattern', matchesRegex: '([unclosed' }],
          },
          'ws test',
        ),
      ),
    ).toThrow(/steps\.0\.matchesRegex on step "bad pattern"/);
  });

  it('accepts a well-formed spec of each protocol', () => {
    const specs = [
      { protocol: 'GRAPHQL', operations: [{ name: 'q', query: '{ ping }' }] },
      { protocol: 'WEBSOCKET', steps: [{ action: 'SEND', name: 's', payload: 'hi' }] },
      { protocol: 'SSE', expect: [{ name: 'e', event: 'tick' }] },
      { protocol: 'GRPC', calls: [{ name: 'c', method: 'pkg.Svc/Method' }] },
    ];
    for (const spec of specs) {
      expect(() => protocolPlugin.validate(makeTest(spec))).not.toThrow();
    }
  });
});
