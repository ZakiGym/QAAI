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
import {
  EGRESS_REFUSAL_SENTENCE,
  SECRET_MASK,
  SELF_HOSTED_EGRESS_POLICY,
  guardUrl,
  resolveEgressPolicy,
} from '@qaai/shared';
import type { EgressGuardIo, ExecutableTest, RunContext, TestExecution } from '@qaai/shared';
import { classifyAddress, classifyHost } from '@qaai/shared/private-address';
import { protocolPlugin } from './protocol.js';
import type { ProtocolEgressGuard } from './protocol.js';
import { attachRunWorkspace } from '../run-workspace.js';

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

/**
 * Every handler in this file is `async` — it reads a JSON body, or writes an SSE
 * frame after a tick — and `RequestListener` declares a VOID return, so each
 * call site raised `no-misused-promises`. The handler's promise is genuinely
 * not awaited (node fires the event and moves on), which is correct here and is
 * what the wider type says out loud; `void` at the single seam is the honest
 * spelling of "this result is deliberately dropped", and it says so once rather
 * than at nine call sites.
 */
type AsyncRequestListener = (
  ...args: Parameters<RequestListener>
) => void | Promise<void>;

function httpServer(handler: AsyncRequestListener): Promise<string> {
  return listen(
    createServer((req, res) => {
      void handler(req, res);
    }),
  );
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

/**
 * `workspaceRoot` is the run's materialised repository, and it defaults to
 * ABSENT: most protocol tests touch no file at all, and that has to keep working
 * without a checkout. Only the gRPC schema paths need one — see the gRPC block.
 */
function makeCtx(
  baseUrl: string,
  secrets: Record<string, string> = {},
  workspaceRoot: string | null = null,
): RunContext {
  const ctx: RunContext = {
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
  return attachRunWorkspace(
    ctx,
    workspaceRoot === null
      ? null
      : { root: workspaceRoot, source: 'acme/svc@main', fileCount: 4 },
  );
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
    //
    // The first line is the egress guard's own: this harness targets
    // 127.0.0.1, the run context carries no `egressPolicy`, so the endpoint
    // was decided under the self-hosted class list and the decision carries
    // SELF_HOSTED_EGRESS_WARNING. It is asserted rather than filtered out,
    // because a check that was skipped must be NAMED — a guard that passes
    // silently in the one mode where it does nothing is indistinguishable from
    // a guard that ran.
    expect(execution.console.map((entry) => entry.text)).toEqual([
      expect.stringContaining('• This deployment is self-hosted'),
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

    /*
     * ── Where a proto comes from ────────────────────────────────────────────
     *
     * `-proto` and `-import-path` resolved against `process.cwd()` — QAAI's own
     * checkout — so the customer's `proto/orders.proto` was unopenable, and a
     * name that happened to exist in OUR tree got compiled and called against
     * THEIR service. The stub records its argv, so these assert on the exact
     * paths the plugin hands grpcurl.
     */
    it('resolves -proto and -import-path inside the materialised repository', async () => {
      const repo = await mkdtemp(join(tmpdir(), 'qaai-grpc-repo-'));
      try {
        const execution = await protocolPlugin.execute(
          makeCtx('http://svc.internal:50051', {}, repo),
          makeTest({
            protocol: 'GRPC',
            plaintext: true,
            protoPath: 'proto/health.proto',
            importPaths: ['proto'],
            calls: [{ name: 'health', method: 'grpc.health.v1.Health/Check' }],
          }),
        );

        expect(execution.status).toBe('PASSED');
        const argv = (await readFile(argsFile, 'utf8')).trimEnd().split('\n');
        expect(argv).toContain(join(repo, 'proto'));
        expect(argv).toContain(join(repo, 'proto', 'health.proto'));
        // The old behaviour, pinned as absent: nothing is resolved against the
        // worker's own directory any more.
        expect(argv.some((arg) => arg.startsWith(process.cwd()))).toBe(false);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it('is not evaluated when a proto is named and there is no checkout', async () => {
      const execution = await protocolPlugin.execute(
        makeCtx('http://svc.internal:50051'),
        makeTest({
          protocol: 'GRPC',
          plaintext: true,
          protoPath: 'proto/health.proto',
          calls: [{ name: 'health', method: 'grpc.health.v1.Health/Check' }],
        }),
      );

      // SKIPPED, with both ways out named, and nothing spawned.
      expect(execution.status).toBe('SKIPPED');
      expect(execution.errorMessage).toMatch(/no checkout of it/);
      expect(execution.errorMessage).toContain('proto/health.proto');
      expect(execution.errorMessage).toMatch(/reflection/);
      expect(execution.steps.some((step) => step.status === 'FAILED')).toBe(false);
    });

    /*
     * A drive letter, because `relativeFilePath` already refuses `..` and a
     * leading `/`: on POSIX `C:\…` is a plain relative name, so the schema lets
     * it through and the runtime guard is what has to catch it.
     */
    it('fails, rather than skips, on a proto path outside the repository', async () => {
      const repo = await mkdtemp(join(tmpdir(), 'qaai-grpc-repo-'));
      try {
        const execution = await protocolPlugin.execute(
          makeCtx('http://svc.internal:50051', {}, repo),
          makeTest({
            protocol: 'GRPC',
            plaintext: true,
            protoPath: 'C:\\proto\\health.proto',
            calls: [{ name: 'health', method: 'grpc.health.v1.Health/Check' }],
          }),
        );

        expect(execution.status).toBe('FAILED');
        expect(execution.errorMessage).toMatch(/not a path inside the repository/);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
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

// ─────────────────────────────────────────────────────────────────────────────
// The egress guard on a customer-controlled absolute endpoint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE HOLE THESE CLOSE, AND HOW IT WAS MEASURED.
 *
 * `resolveUrl` passes an absolute URL in `spec.endpoint` straight through, and
 * before this change nothing anywhere in the plugin classified it: no pin, no
 * resolve, no name-level check. `plugins/api.ts` has a same-origin check and
 * this file deliberately does not — an off-base-URL endpoint is the documented
 * legitimate case, and PROTOCOL is kept out of
 * `BASE_URL_DEPENDENT_TEST_TYPES` for that reason — so the preflight guard that
 * saves every other test type never applied here either. The result was
 * `fetch(endpoint)` against any host a spec in the customer's repository named,
 * from inside our network, with the status recorded in a `NetworkEntry` (a
 * reachability oracle) and 300 characters of the answer returned in a step.
 *
 * So the rule is the CLASS rule and not a same-origin rule: a different PUBLIC
 * host keeps working, a private or link-local one does not.
 *
 * EVERY CASE BELOW USES AN IP LITERAL OR AN INJECTED RESOLVER. `classifyHost`
 * answers `kind: 'address'` for a literal and `decideEgress` consults no
 * resolver at all for one, so the blocks that go through the real default
 * guard make NO DNS QUERY; the split-answer cases inject a fake zone. Nothing
 * here resolves a name for real.
 */
describe('a PROTOCOL endpoint is classified before it is opened', () => {
  /** The real guard over a fake zone, so a NAME can be tested without DNS. */
  function guardWith(
    zone: Readonly<Record<string, readonly string[]>>,
    policy = SELF_HOSTED_EGRESS_POLICY,
  ): ProtocolEgressGuard {
    const io: EgressGuardIo = {
      classifyHost: (host) => classifyHost(host),
      classifyAddress: (address) => classifyAddress(address),
      lookup: async (host) => {
        const answers = zone[host];
        if (answers === undefined) {
          throw new Error(`fakeIo was asked to resolve ${host}, which this test never declared`);
        }
        return answers.map((address) => ({ address }));
      },
      now: () => new Date('2026-10-30T00:00:00.000Z'),
      monotonicMs: () => 0,
      // The 250ms refusal floor belongs to `egress-guard`'s own tests; a real
      // sleep per refusal would cost this file seconds.
      delay: async () => {},
    };
    return (url) => guardUrl({ url, context: 'PLUGIN_HTTP', policy, io });
  }

  const graphqlAt = (endpoint: string) =>
    makeTest({
      protocol: 'GRAPHQL',
      endpoint,
      /*
       * A SHORT deadline, deliberately. 169.254.169.254 has no route from a
       * test host, so with the schema default this fixture would hang until
       * vitest's own 5s limit — and a test that times out is indistinguishable
       * from an unrelated hang, which is a NON-RESULT when it is the thing a
       * mutation run is reading. With 400ms a removed guard fails as the
       * assertion it is.
       */
      timeoutMs: 400,
      operations: [{ name: 'read orders', query: '{ orders { id } }' }],
    });

  const sseAt = (path: string) =>
    makeTest({
      protocol: 'SSE',
      path,
      connectTimeoutMs: 400,
      expect: [{ name: 'first event', event: 'tick', count: 1, timeoutMs: 400 }],
    });

  const wsAt = (url: string) =>
    makeTest({
      protocol: 'WEBSOCKET',
      url,
      connectTimeoutMs: 400,
      steps: [{ action: 'EXPECT', name: 'first frame', timeoutMs: 400 }],
    });

  /*
   * 169.254.169.254 is the cloud metadata service on AWS, GCP and Azure alike,
   * and it is in NEVER_PERMITTED_BY_DEFAULT — refused under every deployment
   * mode, including the self-hosted class list this plugin falls back to when
   * the run context carries no policy. These three go through the REAL default
   * guard, which is what production gets.
   */
  it('refuses a GraphQL endpoint at the cloud metadata address', async () => {
    const execution = await protocolPlugin.execute(
      makeCtx('https://app.example.com'),
      graphqlAt('http://169.254.169.254/latest/meta-data/'),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toBe(EGRESS_REFUSAL_SENTENCE);
    // Not PASSED: a refused endpoint reported as a pass is a pass that means
    // "we did not check". Not FAILED either: the customer's service was never
    // evaluated, so blaming their code would be a lie in the other direction.
    expect(execution.status).not.toBe('PASSED');
    // And no answer came back — the reachability oracle is closed with it.
    expect(execution.network).toEqual([]);
  });

  it('refuses an SSE stream at the cloud metadata address', async () => {
    const execution = await protocolPlugin.execute(
      makeCtx('https://app.example.com'),
      sseAt('http://169.254.169.254/latest/meta-data/'),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toBe(EGRESS_REFUSAL_SENTENCE);
    expect(execution.network).toEqual([]);
  });

  it('refuses a WebSocket at the cloud metadata address, ws:// scheme and all', async () => {
    /*
     * `guardUrl` refuses any scheme that is not http(s), so a `ws://` URL has
     * to be mapped before it is asked about — otherwise every WebSocket test in
     * the product is refused as SCHEME_NOT_PERMITTED, which is a refusal for
     * the wrong reason. A ws URL still resolves a host and still opens a TCP
     * connection to it, which is the whole point.
     */
    const execution = await protocolPlugin.execute(
      makeCtx('https://app.example.com'),
      wsAt('ws://169.254.169.254/'),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toBe(EGRESS_REFUSAL_SENTENCE);
  });

  it('refuses an octal-spelt loopback endpoint under a hosted policy', async () => {
    /*
     * MEASURED rather than assumed, and the measurement changes what this test
     * can claim: `new URL('http://0177.0.0.1/graphql').hostname` is
     * `'127.0.0.1'` — the WHATWG parser normalises octal and decimal IPv4
     * forms itself, and so does `http://2130706433/x`. So the guard never sees
     * the octal spelling and `AMBIGUOUS_HOST` is NOT what refuses this; the
     * LOOPBACK CLASS is, once a policy says loopback is not reachable. The
     * alternate-encoding arm in `decideEgress` still matters for a caller that
     * passes a bare host rather than a URL — it is simply not this path.
     */
    const execution = await protocolPlugin.execute(
      {
        ...makeCtx('https://app.example.com'),
        egressPolicy: { deployment: 'HOSTED' },
      } as RunContext,
      graphqlAt('http://0177.0.0.1/graphql'),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toBe(EGRESS_REFUSAL_SENTENCE);
  });

  it('refuses an endpoint carrying userinfo, before it looks at the host', async () => {
    // `http://app.example.com@93.184.216.34/` reads as a trusted host to a
    // human and to every log line; the parser correctly calls the host the IP.
    const execution = await protocolPlugin.execute(
      makeCtx('https://app.example.com'),
      graphqlAt('http://app.example.com@93.184.216.34/graphql'),
    );
    expect(execution.status).toBe('SKIPPED');
  });

  it('refuses a name whose records point inside — public record FIRST', async () => {
    /*
     * The ORDER is the attack. A positional read of the first address lets
     * whoever runs the zone choose the outcome by reordering their own answer,
     * and an adversary found exactly that last round. Both orders must refuse,
     * and this plugin's fallback policy permits `private`, so what refuses here
     * is the LINK-LOCAL address in the set — which no deployment reaches.
     */
    const execution = await protocolPlugin.execute(
      makeCtx('https://app.example.com'),
      graphqlAt('http://graphql.attacker.test/graphql'),
      guardWith({ 'graphql.attacker.test': ['93.184.216.34', '169.254.169.254'] }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.network).toEqual([]);
  });

  it('refuses a name whose records point inside — link-local record FIRST', async () => {
    const execution = await protocolPlugin.execute(
      makeCtx('https://app.example.com'),
      graphqlAt('http://graphql.attacker.test/graphql'),
      guardWith({ 'graphql.attacker.test': ['169.254.169.254', '93.184.216.34'] }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.network).toEqual([]);
  });

  it('refuses an endpoint whose name does not resolve', async () => {
    // A name we cannot vouch for is not a name we connect to.
    const execution = await protocolPlugin.execute(
      makeCtx('https://app.example.com'),
      graphqlAt('http://graphql.attacker.test/graphql'),
      guardWith({}),
    );
    expect(execution.status).toBe('SKIPPED');
  });

  it('says the SAME sentence whatever the reason, so a spec is not a port scanner', async () => {
    /*
     * The step list is read by whoever wrote the spec, and the spec's endpoint
     * is what is being refused. "that is a link-local address" / "that host did
     * not resolve" / "that host is not on the allowlist" are three different
     * facts about the inside of OUR network.
     */
    const zones: Array<Record<string, readonly string[]>> = [
      { 'graphql.attacker.test': ['169.254.169.254'] },
      { 'graphql.attacker.test': ['224.0.0.1'] },
      { 'graphql.attacker.test': [] },
      {},
    ];
    const messages = new Set<string | null>();
    for (const zone of zones) {
      const execution = await protocolPlugin.execute(
        makeCtx('https://app.example.com'),
        graphqlAt('http://graphql.attacker.test/graphql'),
        guardWith(zone),
      );
      messages.add(execution.errorMessage);
    }
    expect(messages).toEqual(new Set([EGRESS_REFUSAL_SENTENCE]));
  });

  it('refuses a private endpoint when the environment policy says HOSTED', async () => {
    /*
     * The brake, armed. Once `Environment.egressPolicy` is threaded into
     * `RunContext`, a hosted deployment narrows to PUBLIC ONLY and a
     * `http://10.0.0.5/graphql` endpoint — which the unthreaded fallback
     * permits, because a self-hosted install legitimately has one — is refused.
     */
    const execution = await protocolPlugin.execute(
      {
        ...makeCtx('https://app.example.com'),
        egressPolicy: { deployment: 'HOSTED' },
      } as RunContext,
      graphqlAt('http://10.0.0.5/graphql'),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toBe(EGRESS_REFUSAL_SENTENCE);
  });

  it('COUNTS and allows in OBSERVE instead of refusing, and says it did', async () => {
    /*
     * Rule 13: a brake that does not brake is worse than no brake. OBSERVE must
     * let today's behaviour continue AND make the fact visible, so the
     * transcript carries the line. The connection is then ATTEMPTED and fails
     * because nothing is listening on port 1 — which is exactly the point: the
     * guard did not stop it, and under ENFORCE the test above shows it does.
     *
     * The target is loopback:1 rather than an RFC1918 address because a
     * connection to 10.0.0.5 has no route and hangs until the TCP timeout,
     * which timed this test out at 5s. Loopback on a closed port refuses
     * immediately and is refused by the same HOSTED class rule.
     */
    const execution = await protocolPlugin.execute(
      {
        ...makeCtx('https://app.example.com'),
        egressPolicy: { deployment: 'HOSTED', mode: 'OBSERVE' },
      } as RunContext,
      graphqlAt('http://127.0.0.1:1/graphql'),
    );
    expect(execution.status).not.toBe('SKIPPED');
    expect(execution.console.map((entry) => entry.text).join('\n')).toContain(
      'would have been refused by the egress policy',
    );
  });

  it('still reaches a DIFFERENT public host, which is the documented legitimate case', async () => {
    /*
     * A guard that refuses everything passes an attack suite and breaks the
     * product. `spec.endpoint` naming another public origin is what this plugin
     * is FOR, so the rule is the class rule and emphatically not same-origin:
     * the base URL here is one host and the endpoint is a real server on
     * another, and it must still run.
     */
    const elsewhere = await httpServer(async (req, res) => {
      expect(req.url).toBe('/graphql');
      sendJson(res, { data: { orders: [{ id: 'ord_1' }] } });
    });

    const execution = await protocolPlugin.execute(
      makeCtx('http://127.0.0.2:1/'),
      graphqlAt(`${elsewhere}/graphql`),
    );

    expect(execution.status).toBe('PASSED');
    // One entry: the operation. Introspection is off in this fixture.
    expect(execution.network).toHaveLength(1);
    expect(execution.network[0]!.url).toBe(`${elsewhere}/graphql`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The pin, at the socket
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * A string that exists only inside the internal server's answer, so "did any
   * of its body reach the tenant" is one assertion and not a guess.
   */
  const INTERNAL_BODY_MARKER = 'INTERNAL-ONLY-BODY-6f2a91';

  /**
   * A loopback server that is the INTERNAL host, and counts what reached it.
   *
   * It records the PRESENCE of the authorization header, never its value: a
   * credential must not be in a test's memory any more than in a log line.
   */
  async function internalHost(): Promise<{
    port: number;
    hits: Array<{ method: string; path: string; host: string; authPresent: boolean }>;
  }> {
    const hits: Array<{ method: string; path: string; host: string; authPresent: boolean }> = [];
    const base = await httpServer((req, res) => {
      hits.push({
        method: req.method ?? '',
        path: req.url ?? '',
        host: req.headers.host ?? '',
        authPresent: typeof req.headers.authorization === 'string',
      });
      sendJson(res, { data: { secret: INTERNAL_BODY_MARKER } });
    });
    return { port: Number(new URL(base).port), hits };
  }

  /** Everything the tenant who wrote the spec can read back. */
  const tenantVisible = (execution: TestExecution): string =>
    JSON.stringify({
      steps: execution.steps,
      network: execution.network,
      console: execution.console,
      errorMessage: execution.errorMessage,
    });

  const credentialled = (endpoint: string) =>
    makeTest({
      protocol: 'GRAPHQL',
      endpoint,
      // The credential this path carries, interpolated from `ctx.secrets` the
      // way a vault-backed spec does.
      headers: { authorization: 'Bearer {{PROBE_CREDENTIAL}}' },
      timeoutMs: 400,
      operations: [{ name: 'read secret', query: '{ secret }' }],
    });

  it('REFUSES when the endpoint name is rebound between the guard and the socket', async () => {
    /*
     * ── THE DEFECT, MEASURED ON THIS PATH AND THEN CLOSED ─────────────────────
     *
     * `guardUrl` pins the addresses it approved, and until this round `runGraphql`
     * read `verdict.ok`, threw the permit away and called `fetch(endpoint)` by
     * NAME. Two resolutions per request, no cache between them, so whoever owns
     * the zone answers the second one differently. Run against this very
     * fixture before the change:
     *
     *   INTERNAL SERVER RECEIVED: POST /graphql
     *   host: localhost:PORT | authorization present: true
     *   status PASSED, and the server's body came back in the transcript
     *
     * THE HOST NAME IS `localhost` ON PURPOSE and the test is vacuous without
     * it. A `.invalid` or `.test` name never resolves, so the request would fail
     * whether the pin was honoured or not — `pinned-request.test.ts` records a
     * version of itself that was vacuous for exactly that reason. `localhost`
     * DOES resolve, to 127.0.0.1, everywhere: so the guard is handed a zone that
     * answers a PUBLIC unroutable address (192.0.2.1, RFC 5737 TEST-NET-1) —
     * the attacker's first answer, which the policy permits and pins — and the
     * real resolver is the attacker's second answer, pointing at the loopback
     * server below. A transport that re-resolves reaches it. One that honours
     * the pin cannot. Nothing but `localhost` is resolved and nothing leaves
     * the machine.
     */
    const internal = await internalHost();

    const execution = await protocolPlugin.execute(
      makeCtx('https://app.example.com', { PROBE_CREDENTIAL: 'probe-value-not-a-credential' }),
      credentialled(`http://localhost:${internal.port}/graphql`),
      guardWith({ localhost: ['192.0.2.1'] }),
    );

    // THE ASSERTION THIS ROUND EXISTS FOR: the internal server was never reached,
    // so the credential in the header never left for it.
    expect(internal.hits).toEqual([]);
    // Not PASSED. A rebound endpoint reported as a pass is the worst outcome.
    expect(execution.status).toBe('FAILED');
    /*
     * And no part of the internal server's body reached the tenant who chose
     * the host — this path logs the whole response into the transcript and
     * returns 300 characters of it in a step, so the body is an exfiltration
     * channel and not only the status an oracle.
     */
    expect(tenantVisible(execution)).not.toContain(INTERNAL_BODY_MARKER);
    // The reachability oracle is closed with it: no status came back.
    expect(execution.network[0]?.status).toBeNull();
    /*
     * The refusal says the same thing whatever went wrong. `operatorDetail`
     * from the transport names the host and the socket error — `connect
     * ECONNREFUSED 10.0.0.5:80` was rendered verbatim here before — and it is
     * deliberately not read.
     */
    expect(execution.errorMessage).toBe('Request failed: The endpoint did not answer.');
  });

  it('still reaches a pinned NAME, with the name intact in the Host header', async () => {
    /*
     * The other half, and without it the test above is satisfied by a plugin
     * that refuses everything. The same `localhost` endpoint, pinned to the
     * address it really has: the request must go through, AND the Host header
     * must still be the NAME — which is why the pin is on the resolver rather
     * than a rewrite of the URL to an address literal. On https that header is
     * also the SNI name and what the certificate is checked against.
     */
    const internal = await internalHost();

    const execution = await protocolPlugin.execute(
      makeCtx('https://app.example.com', { PROBE_CREDENTIAL: 'probe-value-not-a-credential' }),
      credentialled(`http://localhost:${internal.port}/graphql`),
      guardWith({ localhost: ['127.0.0.1'] }),
    );

    expect(execution.status).toBe('PASSED');
    expect(internal.hits).toHaveLength(1);
    expect(internal.hits[0]?.host).toBe(`localhost:${internal.port}`);
    expect(internal.hits[0]?.path).toBe('/graphql');
    // The credential still arrives: pinning the address must not drop a header.
    expect(internal.hits[0]?.authPresent).toBe(true);
  });

  it('does not follow a redirect away from the pinned host', async () => {
    /*
     * Following one would re-send this body and this `authorization` header to
     * whatever `Location` names, which is a host nothing classified — the same
     * reason the old code passed `redirect: 'manual'`, now enforced by a
     * transport where it is not configurable.
     */
    const elsewhere = await internalHost();
    const redirector = await httpServer((_req, res) => {
      res.writeHead(302, { location: `http://localhost:${elsewhere.port}/graphql` });
      res.end();
    });

    const execution = await protocolPlugin.execute(
      makeCtx('https://app.example.com', { PROBE_CREDENTIAL: 'probe-value-not-a-credential' }),
      credentialled(`http://localhost:${Number(new URL(redirector).port)}/graphql`),
      guardWith({ localhost: ['127.0.0.1'] }),
    );

    // The 302 came back as a 302 and the credential went nowhere else.
    expect(elsewhere.hits).toEqual([]);
    expect(execution.network[0]?.status).toBe(302);
  });

  it('in OBSERVE mode connects by NAME as before, and says that it did', async () => {
    /*
     * An OBSERVED permit authorised NO address, so `pinnedRequest` refuses it
     * with NOT_PINNED. Fail-closed is the wrong reading of that here: OBSERVE
     * promises that today's traffic keeps flowing, so this path must connect
     * the way it did before the control existed — and must SAY so, because a
     * connection that went out unpinned and silently is the limitation nobody
     * ever reads about in the comment.
     */
    const internal = await internalHost();

    const execution = await protocolPlugin.execute(
      makeCtx('https://app.example.com', { PROBE_CREDENTIAL: 'probe-value-not-a-credential' }),
      credentialled(`http://localhost:${internal.port}/graphql`),
      // 10.0.0.5 is private, HOSTED permits public only, the mode is OBSERVE.
      guardWith({ localhost: ['10.0.0.5'] }, resolveEgressPolicy({ deployment: 'HOSTED', mode: 'OBSERVE' })),
    );

    // The brake did not brake, which is what OBSERVE means: it connected.
    expect(internal.hits).toHaveLength(1);
    expect(execution.status).toBe('PASSED');
    const transcript = execution.console.map((entry) => entry.text).join('\n');
    expect(transcript).toContain('would have been refused by the egress policy');
    expect(transcript).toContain('resolved the endpoint name again at the socket');
  });

  it('says the SSE and WebSocket streams were not pinned, rather than implying they were', async () => {
    /*
     * `PROTOCOL_PIN_LIMITATION` used to say the pin could not be enforced
     * ANYWHERE in this plugin, and that claim is now false for GraphQL and
     * still true for these two — SSE is read incrementally and the pinned
     * transport answers a whole body, and the global `WebSocket` takes no
     * resolver at all. A limitation that lives only in a comment is one the
     * reader of a run never sees, so each such connection writes a line.
     */
    const internal = await internalHost();
    const sse = await protocolPlugin.execute(
      makeCtx('https://app.example.com'),
      makeTest({
        protocol: 'SSE',
        path: `http://localhost:${internal.port}/events`,
        connectTimeoutMs: 400,
        expect: [{ name: 'first event', event: 'tick', count: 1, timeoutMs: 400 }],
      }),
      guardWith({ localhost: ['127.0.0.1'] }),
    );
    expect(sse.console.map((e) => e.text).join('\n')).toContain(
      'resolved the endpoint name again at the socket',
    );

    /*
     * And it is SILENT for a numeric host, because there is no name for a
     * nameserver to answer differently — a warning there would simply be false.
     * MEASURED rather than reasoned: the global `fetch` DOES call `dns.lookup`
     * for `127.0.0.1`, so it is the absence of a NAME and not of a lookup that
     * shuts the window.
     */
    const literal = await protocolPlugin.execute(
      makeCtx('https://app.example.com'),
      makeTest({
        protocol: 'SSE',
        path: `http://127.0.0.1:${internal.port}/events`,
        connectTimeoutMs: 400,
        expect: [{ name: 'first event', event: 'tick', count: 1, timeoutMs: 400 }],
      }),
    );
    expect(literal.console.map((e) => e.text).join('\n')).not.toContain(
      'resolved the endpoint name again at the socket',
    );
  });
});
