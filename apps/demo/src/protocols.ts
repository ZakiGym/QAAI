/**
 * GraphQL, SSE and WebSocket endpoints for the demo store.
 *
 * QAAI can now test these protocols, and a capability nobody can point at a
 * running example of is a capability nobody trusts. The demo store exists to be
 * the thing under test, so it has to speak everything QAAI claims to test.
 *
 * Hand-rolled rather than pulling in Apollo and `ws`. The GraphQL surface here
 * is four fields; a spec-compliant server would be several hundred kilobytes of
 * dependency to exercise a client that only needs to send a query and read
 * `data` and `errors`. The WebSocket handshake is ~30 lines of RFC 6455 and is
 * worth owning for the same reason.
 *
 * Two behaviours are deliberate and are the interesting cases to test against:
 *   1. A GraphQL error comes back with HTTP 200. Any client asserting on status
 *      codes alone will call a failed query a success.
 *   2. `order(id:)` inherits the same missing ownership check as the REST
 *      route — the IDOR is reachable over GraphQL too.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Express, Request, Response } from 'express';
import { PRODUCTS, findProduct, type DemoState } from './store.js';

interface GraphQLBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

/** GraphQL errors are a 200 with an `errors` array — never an HTTP error. */
function gqlError(res: Response, message: string, path?: string[]): void {
  res.status(200).json({ data: null, errors: [{ message, ...(path ? { path } : {}) }] });
}

/**
 * A deliberately tiny query reader.
 *
 * It understands `{ field(arg: value) { ... } }` and named queries with
 * variables, which is the whole surface below. It is not a GraphQL parser and
 * does not pretend to be — anything it cannot read comes back as a GraphQL
 * error, which is exactly how a real server answers a malformed query.
 */
function readOperation(query: string): { field: string; args: Record<string, string> } | null {
  const body = query.replace(/^\s*(query|mutation)\s+\w*\s*(\([^)]*\))?\s*/i, '').trim();
  const match = /^\{\s*(\w+)\s*(?:\(([^)]*)\))?/.exec(body);
  if (!match) return null;

  const args: Record<string, string> = {};
  for (const pair of (match[2] ?? '').split(',')) {
    const kv = /^\s*(\w+)\s*:\s*(.+?)\s*$/.exec(pair);
    if (kv) args[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '');
  }
  return { field: match[1]!, args };
}

export function mountProtocols(app: Express, state: () => DemoState): void {
  // ── GraphQL ───────────────────────────────────────────────────────────────
  app.post('/graphql', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as GraphQLBody;
    const query = typeof body.query === 'string' ? body.query : '';
    if (!query.trim()) return gqlError(res, 'No query supplied.');

    const op = readOperation(query);
    if (!op) return gqlError(res, 'Could not parse the query.');

    const vars = (body.variables ?? {}) as Record<string, unknown>;
    const arg = (name: string): string | undefined => {
      const raw = op.args[name];
      if (raw === undefined) return undefined;
      // `$id` refers to a variable; anything else is an inline literal.
      return raw.startsWith('$') ? String(vars[raw.slice(1)] ?? '') : raw;
    };

    switch (op.field) {
      case 'products':
        return res.json({ data: { products: PRODUCTS } });

      case 'product': {
        const id = arg('id');
        if (!id) return gqlError(res, 'Field "product" requires an "id" argument.', ['product']);
        const product = findProduct(id);
        // A missing product is `null` data plus an error — not a 404.
        return product
          ? res.json({ data: { product } })
          : gqlError(res, `No product with id "${id}".`, ['product']);
      }

      case 'cart': {
        // Keyed by session, the same way GET /cart reads it. A GraphQL cart
        // that ignored the session would be a different cart from the REST one,
        // which is exactly the inconsistency a contract test should catch.
        const sid = (req as Request & { sessionId?: string }).sessionId ?? '';
        const lines = state().carts.get(sid) ?? [];
        return res.json({
          data: {
            cart: { lines, count: lines.reduce((n, l) => n + l.quantity, 0) },
          },
        });
      }

      case 'order': {
        const id = arg('id');
        if (!id) return gqlError(res, 'Field "order" requires an "id" argument.', ['order']);
        // NO OWNERSHIP CHECK — the same planted IDOR as GET /orders/:id, so the
        // security runner can find it over GraphQL too. Intentional.
        const order = state().orders.find((o) => o.id === id);
        return order
          ? res.json({ data: { order } })
          : gqlError(res, `No order with id "${id}".`, ['order']);
      }

      default:
        return gqlError(res, `Cannot query field "${op.field}".`);
    }
  });

  // ── Server-sent events ────────────────────────────────────────────────────
  /**
   * Emits the lifecycle of an order as named events. Named rather than
   * anonymous because a client asserting "I received `order.shipped`" is the
   * realistic shape of an SSE test.
   */
  app.get('/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // Without this a proxy will buffer the stream and the client sees nothing
      // until it closes — which looks exactly like a broken endpoint.
      'x-accel-buffering': 'no',
    });

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('open', { at: new Date().toISOString() });

    const stages: Array<[string, Record<string, unknown>]> = [
      ['order.placed', { id: 'ORD-1001', total: 4297 }],
      ['order.packed', { id: 'ORD-1001' }],
      ['order.shipped', { id: 'ORD-1001', carrier: 'Demo Post' }],
    ];

    let i = 0;
    const timer = setInterval(() => {
      const stage = stages[i++];
      if (!stage) {
        send('done', { count: stages.length });
        clearInterval(timer);
        res.end();
        return;
      }
      send(stage[0], stage[1]);
    }, 300);

    req.on('close', () => clearInterval(timer));
  });
}

// ── WebSocket ───────────────────────────────────────────────────────────────

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** RFC 6455 frame writer for short text frames — enough for an echo endpoint. */
function writeTextFrame(socket: Duplex, text: string): void {
  const payload = Buffer.from(text, 'utf8');
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.concat([Buffer.from([0x81, 126]), (() => {
          const b = Buffer.alloc(2);
          b.writeUInt16BE(payload.length);
          return b;
        })()]);
  socket.write(Buffer.concat([header, payload]));
}

/** Reads one masked client text frame. Returns null if it is not one. */
function readTextFrame(buf: Buffer): string | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0f;
  if (opcode === 0x8) return null; // close
  if (opcode !== 0x1) return null; // only text
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

/**
 * An echo endpoint at `ws://…/ws`.
 *
 * Echo plus a greeting is enough to exercise the three things a WebSocket test
 * has to do: connect, send, and wait for a message that matches a predicate
 * rather than merely the next one — the greeting arrives unprompted, so a
 * client that assumes "first message = my reply" fails here, correctly.
 */
export function attachWebSocket(server: {
  on(event: 'upgrade', cb: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void;
}): void {
  server.on('upgrade', (req, socket) => {
    if (!req.url?.startsWith('/ws')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    writeTextFrame(socket, JSON.stringify({ type: 'welcome', store: 'Ground Coffee Co.' }));

    socket.on('data', (buf: Buffer) => {
      const text = readTextFrame(buf);
      if (text === null) {
        socket.end();
        return;
      }
      writeTextFrame(socket, JSON.stringify({ type: 'echo', message: text }));
    });

    socket.on('error', () => socket.destroy());
  });
}
