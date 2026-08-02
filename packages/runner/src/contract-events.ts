/**
 * Async contract testing — the transports, and the specs that describe them.
 *
 * `plugins/contract.ts` verifies what a provider ANSWERS: replay a pact's HTTP
 * interactions, or call the operations an OpenAPI document declares. Everything
 * a modern backend does asynchronously was invisible to it — the events it
 * emits, the messages a consumer says it can handle — and an event contract
 * breaks exactly the same way a REST contract does: a field is renamed, a type
 * changes, a channel stops firing, and the consumer finds out in production.
 *
 * This module is the half that has nothing to do with matching. It:
 *
 *   - owns the HTTP `send` the pact replay already used, so the async transports
 *     and the sync ones share one timeout/cancellation/redirect policy;
 *   - COLLECTS messages off the three transports QAAI can already receive — an
 *     SSE stream, a WebSocket, and a webhook QAAI hosts itself — and hands them
 *     back as plain text plus metadata;
 *   - asks a pact message provider to produce one message on demand;
 *   - reads the channels an AsyncAPI document declares.
 *
 * The matching stays in contract.ts, deliberately: the pact matching-rule engine
 * there is the only matcher in this codebase and a second one would drift from
 * it. Everything here returns data for that engine to judge, which is also why
 * `asyncApiMessages` takes a `deref` callback rather than resolving `$ref`
 * itself — contract.ts already knows how, and one JSON-pointer resolver is
 * enough.
 *
 * Nothing here decides a verdict. A transport that cannot be reached returns a
 * sentence for the caller to turn into a step; a dependency this worker does not
 * have throws `MissingToolError`, which the plugin reports as SKIPPED with the
 * fix — never as a provider failure.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { pactContractSpecSchema } from '@qaai/shared';
import type { NetworkEntry, RunContext } from '@qaai/shared';

/** Response bodies are truncated before they are stored or shown to the model. */
export const BODY_SNIPPET_LIMIT = 2000;

/**
 * A webhook receiver is an open door for as long as it is listening. It binds
 * loopback only and it refuses to buffer more than this per delivery, so a
 * misconfigured (or hostile) sender cannot turn a contract test into an OOM.
 */
const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

/**
 * A gap in how the test is configured — an unreachable pact file, a secret that
 * is not set. These become SKIPPED, never FAILED: reporting a setup problem as
 * a failure blames the application under test for the test's own configuration.
 */
export class ContractConfigError extends Error {}

/** A dependency this worker does not have. Also SKIPPED, with the install command. */
export class MissingToolError extends Error {}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─── HTTP, shared with the synchronous modes ─────────────────────────────────

/**
 * One request budget that also honours run cancellation. Built by hand rather
 * than with `AbortSignal.any` so the cleanup is explicit and no listener is left
 * on the run-wide signal after a request settles.
 */
export function withTimeout(
  ctx: RunContext,
  timeoutMs: number,
): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const onAbort = () => controller.abort();

  if (ctx.signal.aborted) controller.abort();
  else ctx.signal.addEventListener('abort', onAbort, { once: true });

  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    },
  };
}

/** Preserves a base path: `https://api.example.com/v1` + `/orders` → `/v1/orders`. */
export function resolveUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\/+/, ''), base).toString();
}

/** `http(s)://host/base` + `/ws` → `ws(s)://host/base/ws`. */
export function resolveWsUrl(baseUrl: string, path: string): string {
  if (/^wss?:\/\//i.test(path)) return path;
  const absolute = resolveUrl(baseUrl, path);
  return absolute.replace(/^http/i, (scheme) => (scheme === 'HTTP' ? 'WS' : 'ws'));
}

export interface SentRequest {
  status: number | null;
  headers: Record<string, string>;
  text: string;
  durationMs: number;
  transportError: string | null;
}

export async function send(
  ctx: RunContext,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
): Promise<SentRequest> {
  const started = Date.now();
  const { signal, done } = withTimeout(ctx, timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal,
      // Never follow redirects: a provider that started 302-ing a documented
      // endpoint has changed its contract, and following the hop would hide it.
      // On the broker publisher the same flag is load-bearing for a different
      // reason — see contract-broker.ts.
      redirect: 'manual',
    });
    const text = await response.text();
    const received: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      received[key.toLowerCase()] = value;
    });
    return {
      status: response.status,
      headers: received,
      text,
      durationMs: Date.now() - started,
      transportError: null,
    };
  } catch (err) {
    return {
      status: null,
      headers: {},
      text: '',
      durationMs: Date.now() - started,
      transportError: messageOf(err),
    };
  } finally {
    done();
  }
}

export function toNetworkEntry(method: string, url: string, sent: SentRequest): NetworkEntry {
  return {
    method,
    url,
    status: sent.status,
    durationMs: sent.durationMs,
    responseBodySnippet:
      sent.status === null || sent.status >= 400 ? sent.text.slice(0, BODY_SNIPPET_LIMIT) : null,
  };
}

// ─── Spec: how a message is obtained ─────────────────────────────────────────

/*
 * The four common fields (`providerBaseUrl`, `headers`, `auth`,
 * `requestTimeoutSeconds`) and the document reference are PROJECTED off the
 * pact spec in @qaai/shared rather than retyped. Retyping them would be a second
 * definition of `auth`, and the day someone widened one and not the other a
 * contract test would start reading a secret that does not exist.
 */
const asyncCommonShape = pactContractSpecSchema.pick({
  providerBaseUrl: true,
  headers: true,
  auth: true,
  requestTimeoutSeconds: true,
}).shape;

const contractDocumentRef = pactContractSpecSchema.shape.pactPath;

/** Knobs every streaming source shares: how long to listen, and when to stop early. */
const listenShape = {
  /** How long to hold the transport open. The test's own timeout still applies. */
  listenSeconds: z.number().int().min(1).max(300).default(15),
  /** Stop as soon as this many messages have arrived. */
  maxMessages: z.number().int().min(1).max(500).default(50),
  /**
   * Dotted path into a JSON payload that carries the event name, when the
   * transport does not carry one of its own (`type`, `eventType`, `data.kind`).
   */
  eventNamePath: z.string().max(200).optional(),
};

const sseSourceSchema = z.object({
  transport: z.literal('sse'),
  /** Absolute URL, or a path resolved against `providerBaseUrl`. */
  path: z.string().min(1).max(2000).default('/events'),
  method: z.enum(['GET', 'POST']).default('GET'),
  body: z.unknown().optional(),
  ...listenShape,
});

const websocketSourceSchema = z.object({
  transport: z.literal('websocket'),
  /** `ws(s)://…`, or a path resolved against `providerBaseUrl` and upgraded. */
  url: z.string().min(1).max(2000).default('/ws'),
  subprotocols: z.array(z.string().min(1).max(100)).max(8).default([]),
  /** Frames sent once the socket is open — a subscribe, or the request half. */
  send: z
    .array(z.union([z.string(), z.record(z.string(), z.unknown())]))
    .max(20)
    .default([]),
  ...listenShape,
});

const webhookSourceSchema = z.object({
  transport: z.literal('webhook'),
  /** Path the receiver answers on. Anything else gets a 404. */
  path: z.string().min(1).max(200).default('/qaai/webhook'),
  /** Port to bind on loopback. 0 lets the OS pick, which is what you want. */
  port: z.number().int().min(0).max(65535).default(0),
  /**
   * What to tell the application to deliver to, when the receiver is not
   * directly reachable (a tunnel, a docker host alias). Defaults to the
   * loopback URL the receiver actually bound.
   */
  callbackUrl: z.string().max(2000).optional(),
  /** The request that makes the application deliver. `{{callbackUrl}}` is substituted. */
  trigger: z
    .object({
      method: z.string().min(1).max(10).default('POST'),
      /** Absolute URL, or a path resolved against `providerBaseUrl`. */
      url: z.string().min(1).max(2000),
      headers: z.record(z.string(), z.string()).default({}),
      body: z.unknown().optional(),
    })
    .optional(),
  /** Header carrying the event name — `x-github-event`, `x-event-name`. */
  eventNameHeader: z.string().min(1).max(120).default('x-event-name'),
  /** What the receiver answers. Some senders retry anything that is not a 2xx. */
  respondStatus: z.number().int().min(200).max(299).default(200),
  ...listenShape,
});

/** Asking a pact message provider to produce one message, on demand. */
const messageProviderSourceSchema = z.object({
  transport: z.literal('http'),
  /**
   * Pact's message-provider endpoint. QAAI POSTs
   * `{ description, providerStates }` and the body that comes back is the
   * message the provider would have published.
   */
  url: z.string().min(1).max(2000),
  method: z.string().min(1).max(10).default('POST'),
});

export const eventSourceSchema = z.discriminatedUnion('transport', [
  sseSourceSchema,
  websocketSourceSchema,
  webhookSourceSchema,
]);
export type EventSource = z.infer<typeof eventSourceSchema>;

export const messageSourceSchema = z.discriminatedUnion('transport', [
  messageProviderSourceSchema,
  sseSourceSchema,
  websocketSourceSchema,
  webhookSourceSchema,
]);
export type MessageSource = z.infer<typeof messageSourceSchema>;

// ─── Spec: publishing back to a broker ───────────────────────────────────────

/**
 * Where verification results go, and how that request is authenticated.
 *
 * The URL is an origin the operator configures and the token is a vault name,
 * never a value. contract-broker.ts is where both are validated; the schema only
 * refuses the shapes that can be refused without a URL parser.
 */
export const brokerPublishSchema = z.object({
  /** The broker's origin — `https://acme.pactflow.io`. https only, see contract-broker.ts. */
  brokerUrl: z.string().min(1).max(2000),
  /** Vault secret holding the broker credential. Bearer by default. */
  auth: z
    .object({
      scheme: z.enum(['bearer', 'basic']).default('bearer'),
      /** For `basic`, the secret's value is `user:password`. */
      secretName: z.string().min(1).max(120),
    })
    .optional(),
  /** The provider version these results belong to — a commit sha, a release. */
  providerVersion: z.string().min(1).max(200),
  /** Branch the provider version was built from, for can-i-deploy. */
  providerVersionBranch: z.string().max(200).optional(),
  buildUrl: z.string().max(2000).optional(),
  /**
   * Which pact the results are for. The broker addresses a pact either by the
   * SHA of its content or by the consumer version that published it, and QAAI
   * refuses to guess: exactly one of these must be set. Deriving it from a HAL
   * link inside the fetched document would let the document choose the request
   * URL, which is the one thing the publisher must never allow.
   */
  pactVersion: z.string().max(200).optional(),
  consumerVersion: z.string().max(200).optional(),
  /** Overrides the provider name in the pact, when the broker knows it by another. */
  providerName: z.string().max(200).optional(),
});
export type BrokerPublishConfig = z.infer<typeof brokerPublishSchema>;

// ─── Spec: the three async contract kinds ────────────────────────────────────

/**
 * Verify a message pact.
 *
 * The consumer half of a message pact declares the shape of an event it can
 * handle; the provider is verified by getting it to produce that message and
 * checking the shape against the same matching rules an HTTP pact uses. The
 * message can come from the provider's own pact message endpoint, or — for the
 * many providers that never implemented that shim — straight off the wire.
 */
export const messageContractSpecSchema = z.object({
  kind: z.literal('message'),
  pactPath: contractDocumentRef,
  /** When the document holds several consumers, verify only this one. */
  consumer: z.string().max(200).optional(),
  /** Verify only messages whose description or provider state matches this regex. */
  only: z.string().max(300).optional(),
  source: messageSourceSchema,
  /** Pact's provider-state hook, same protocol as the HTTP mode. */
  stateChangeUrl: z.string().max(2000).optional(),
  publish: brokerPublishSchema.optional(),
  ...asyncCommonShape,
});
export type MessageContractSpec = z.infer<typeof messageContractSpecSchema>;

/**
 * One expected event, written the way a pact writes one: a body the consumer
 * needs plus the matching rules that say which parts are literal.
 */
const eventExpectationSchema = z.object({
  /** What the step is called. Defaults to the event name. */
  name: z.string().max(200).optional(),
  /** Transport event/channel name — SSE `event:`, the webhook's event header. */
  event: z.string().max(200).optional(),
  /** The shape the consumer needs. Omit to assert only that the event fired. */
  contents: z.unknown().optional(),
  /** Pact matching rules, both dialects, exactly as in a pact file. */
  matchingRules: z.unknown().optional(),
  /** Expected transport metadata: an SSE `id`, a webhook header. */
  metadata: z.record(z.string(), z.string()).default({}),
  /** How many matching messages the window must contain. */
  min: z.number().int().min(1).max(500).default(1),
});
export type EventExpectation = z.infer<typeof eventExpectationSchema>;

/**
 * Check the events a provider actually emits against shapes declared inline.
 *
 * The pact modes need a pact file. This one is for the far more common case: a
 * team that has an event stream, no broker, and wants the shape pinned.
 */
export const eventsContractSpecSchema = z.object({
  kind: z.literal('events'),
  source: eventSourceSchema,
  expect: z.array(eventExpectationSchema).min(1).max(100),
  ...asyncCommonShape,
});
export type EventsContractSpec = z.infer<typeof eventsContractSpecSchema>;

/**
 * The async equivalent of the OpenAPI mode: validate the messages a provider
 * emits against the channel schemas its AsyncAPI document declares.
 */
export const asyncApiContractSpecSchema = z.object({
  kind: z.literal('asyncapi'),
  specPath: contractDocumentRef,
  source: eventSourceSchema,
  /** Check only these channels (by address or by message name). Empty means all. */
  channels: z.array(z.string().min(1).max(300)).max(200).default([]),
  /**
   * A message on a channel the document does not declare is drift by default —
   * that IS the contract. Turn it off for a stream that also carries transport
   * control frames the document was never meant to describe.
   */
  allowUndeclaredChannels: z.boolean().default(false),
  /** The window must produce at least one message, or there was nothing to check. */
  requireMessages: z.boolean().default(true),
  ...asyncCommonShape,
});
export type AsyncApiContractSpec = z.infer<typeof asyncApiContractSpecSchema>;

export const asyncContractSpecSchema = z.discriminatedUnion('kind', [
  messageContractSpecSchema,
  eventsContractSpecSchema,
  asyncApiContractSpecSchema,
]);
export type AsyncContractSpec = z.infer<typeof asyncContractSpecSchema>;

/** The kinds this module adds, for the "invalid spec" sentence. */
export const ASYNC_CONTRACT_KINDS = ['message', 'events', 'asyncapi'] as const;

// ─── Collecting messages off a transport ─────────────────────────────────────

export interface CollectedMessage {
  /** Arrival order within the window. */
  index: number;
  /** Event/channel name the transport carried, or '' when it carried none. */
  name: string;
  /** The raw payload. */
  text: string;
  /** Transport metadata: SSE `id`, webhook headers, the frame's origin. */
  metadata: Record<string, string>;
  /** Milliseconds after the transport opened. */
  atMs: number;
}

export interface Collection {
  messages: CollectedMessage[];
  /** Set when the transport itself never worked. The caller makes it a step. */
  transportError: string | null;
  /** What was listened to, already safe to put in a step title. */
  target: string;
  /** Things worth saying that are not failures: the stream closed, a body was capped. */
  notes: string[];
  network: NetworkEntry[];
  durationMs: number;
}

/** Matches the blank line that terminates an SSE record, in any line ending. */
const SSE_RECORD_BOUNDARY = /\r\n\r\n|\n\n|\r\r/;

interface ParsedSse {
  event: string;
  data: string;
  id: string | null;
}

/**
 * Parses one SSE record.
 *
 * One deviation from the WHATWG algorithm, on purpose: a record carrying only an
 * `event:` name and no `data:` is dispatched here, where a browser would drop
 * it. A contract that says "a `heartbeat` event fires" is a contract, and a
 * dropped keepalive would look like the provider stopped sending one.
 */
function parseSseRecord(record: string): ParsedSse | null {
  let event = '';
  let id: string | null = null;
  const data: string[] = [];

  for (const line of record.split(/\r\n|\n|\r/)) {
    if (line === '' || line.startsWith(':')) continue; // comment / keepalive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
    // `retry` and unknown fields are ignored, per the spec.
  }

  if (data.length === 0 && event === '') return null;
  return { event, data: data.join('\n'), id };
}

/** Dotted-path read with array-index support: `data.items.0.type`. */
function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node)) return node[Number(key)];
    if (typeof node === 'object') return (node as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

/** The name a payload carries at `eventNamePath`, when it carries one. */
function nameFromPayload(text: string, path: string | undefined): string | null {
  if (path === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const found = readPath(parsed, path);
  return typeof found === 'string' || typeof found === 'number' ? String(found) : null;
}

/**
 * A promise that a listener can wake early.
 *
 * Every transport here is "wait until enough arrived, the window closed, or the
 * peer went away"; polling that with a timer would either burn CPU or add
 * latency to every message.
 */
function createGate(): { wait: (ms: number) => Promise<void>; notify: () => void } {
  let wake: (() => void) | null = null;
  return {
    wait: (ms: number) =>
      new Promise<void>((done) => {
        const timer = setTimeout(() => {
          wake = null;
          done();
        }, ms);
        wake = () => {
          clearTimeout(timer);
          wake = null;
          done();
        };
      }),
    notify: () => wake?.(),
  };
}

/** Remaining budget, so a window is a window and not a per-message timeout. */
function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function collectSse(
  ctx: RunContext,
  source: z.infer<typeof sseSourceSchema>,
  baseUrl: string,
  headers: Record<string, string>,
): Promise<Collection> {
  const started = Date.now();
  const url = resolveUrl(baseUrl, source.path);
  const notes: string[] = [];
  const messages: CollectedMessage[] = [];
  const network: NetworkEntry[] = [];

  const controller = new AbortController();
  const onRunAbort = (): void => controller.abort();
  ctx.signal.addEventListener('abort', onRunAbort, { once: true });
  // The connect deadline aborts the request; it must not also cap the stream,
  // which is expected to stay open for the whole window.
  const connectTimer = setTimeout(() => controller.abort(), source.listenSeconds * 1000);

  const requestHeaders: Record<string, string> = {
    accept: 'text/event-stream',
    'cache-control': 'no-cache',
    ...headers,
  };
  let body: string | undefined;
  if (source.body !== undefined) {
    body = typeof source.body === 'string' ? source.body : JSON.stringify(source.body);
    requestHeaders['content-type'] ??= 'application/json';
  }

  let response: Response | null = null;
  let transportError: string | null = null;
  try {
    response = await fetch(url, {
      method: source.method,
      headers: requestHeaders,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
      redirect: 'manual',
    });
  } catch (err) {
    transportError = ctx.signal.aborted ? 'the run was cancelled' : messageOf(err);
  } finally {
    clearTimeout(connectTimer);
  }

  network.push({
    method: source.method,
    url,
    status: response?.status ?? null,
    durationMs: Date.now() - started,
    responseBodySnippet: transportError,
  });

  if (transportError !== null) {
    ctx.signal.removeEventListener('abort', onRunAbort);
    return {
      messages,
      transportError: `the stream at ${url} could not be opened — ${transportError}`,
      target: url,
      notes,
      network,
      durationMs: Date.now() - started,
    };
  }
  if (response === null || response.status >= 300 || response.body === null) {
    ctx.signal.removeEventListener('abort', onRunAbort);
    controller.abort();
    return {
      messages,
      transportError:
        response !== null && response.status >= 300
          ? `the stream at ${url} answered HTTP ${response.status}`
          : `the stream at ${url} returned no body to read`,
      target: url,
      notes,
      network,
      durationMs: Date.now() - started,
    };
  }

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  if (contentType !== '' && contentType !== 'text/event-stream') {
    // Reported, not failed: proxies rewrite this, and the events are the thing
    // under test.
    notes.push(`the stream declared ${contentType} rather than text/event-stream`);
  }

  const deadline = started + source.listenSeconds * 1000;
  const gate = createGate();
  let ended: string | null = null;
  const reader = response.body.getReader();

  const pump = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          ended = 'the server closed the stream';
          gate.notify();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const boundary = SSE_RECORD_BOUNDARY.exec(buffer);
          if (boundary === null) break;
          const record = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const parsed = parseSseRecord(record);
          if (parsed === null) continue;
          messages.push({
            index: messages.length,
            name: parsed.event || nameFromPayload(parsed.data, source.eventNamePath) || '',
            text: parsed.data,
            metadata: parsed.id === null ? {} : { id: parsed.id },
            atMs: Date.now() - started,
          });
          gate.notify();
        }
        if (messages.length >= source.maxMessages) return;
      }
    } catch (err) {
      ended = ctx.signal.aborted ? 'the run was cancelled' : messageOf(err);
      gate.notify();
    }
  })();

  while (messages.length < source.maxMessages && ended === null && remaining(deadline) > 0) {
    await gate.wait(Math.min(remaining(deadline), 250));
    if (ctx.signal.aborted) break;
  }

  controller.abort();
  ctx.signal.removeEventListener('abort', onRunAbort);
  // `reader.read()` rejects once the request is aborted; that is the intended
  // way out of the pump, so the rejection is expected rather than a problem.
  await pump.catch(() => undefined);

  if (ended !== null) notes.push(ended);
  return {
    messages,
    transportError: null,
    target: url,
    notes,
    network,
    durationMs: Date.now() - started,
  };
}

/** Node's built-in WebSocket takes custom headers as an undici extension. */
type WebSocketInit = { protocols?: string[]; headers?: Record<string, string> };

async function collectWebSocket(
  ctx: RunContext,
  source: z.infer<typeof websocketSourceSchema>,
  baseUrl: string,
  headers: Record<string, string>,
): Promise<Collection> {
  const started = Date.now();
  const notes: string[] = [];
  const messages: CollectedMessage[] = [];
  const network: NetworkEntry[] = [];

  if (typeof globalThis.WebSocket !== 'function') {
    throw new MissingToolError(
      'This worker has no global WebSocket, so no message could be received. Run the worker on Node 22 or newer (nvm install 22) — the contract was not verified.',
    );
  }

  let url: string;
  try {
    url = resolveWsUrl(baseUrl, source.url);
  } catch (err) {
    return {
      messages,
      transportError: `could not build a WebSocket URL from "${source.url}" — ${messageOf(err)}`,
      target: source.url,
      notes,
      network,
      durationMs: Date.now() - started,
    };
  }

  const SocketCtor = globalThis.WebSocket as unknown as new (
    url: string,
    init?: WebSocketInit,
  ) => WebSocket;
  const socket = new SocketCtor(url, { protocols: source.subprotocols, headers });
  socket.binaryType = 'arraybuffer';

  const gate = createGate();
  const decoder = new TextDecoder();
  let closed: string | null = null;

  socket.addEventListener('message', (event) => {
    const data: unknown = (event as MessageEvent).data;
    const text =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? decoder.decode(new Uint8Array(data))
          : String(data);
    messages.push({
      index: messages.length,
      name: nameFromPayload(text, source.eventNamePath) ?? '',
      text,
      metadata: {},
      atMs: Date.now() - started,
    });
    gate.notify();
  });
  socket.addEventListener('close', (close) => {
    closed ??= `the socket closed (code ${close.code}${close.reason ? ` — ${close.reason}` : ''})`;
    gate.notify();
  });
  socket.addEventListener('error', (event) => {
    // `||`, not `??`: undici's ErrorEvent carries an EMPTY message rather than
    // an absent one, and an empty reason reads as "no problem" downstream.
    closed ??= (event as unknown as { message?: string }).message || 'connection error';
    gate.notify();
  });

  const openTimeoutMs = Math.min(source.listenSeconds * 1000, 15_000);
  const openProblem = await new Promise<string | null>((done) => {
    const timer = setTimeout(() => done(`did not open within ${openTimeoutMs}ms`), openTimeoutMs);
    const settle = (reason: string | null): void => {
      clearTimeout(timer);
      done(reason);
    };
    socket.addEventListener('open', () => settle(null), { once: true });
    socket.addEventListener('error', () => settle(closed || 'connection error'), { once: true });
    socket.addEventListener(
      'close',
      (close) => settle(`closed before opening (code ${close.code})`),
      {
        once: true,
      },
    );
    ctx.signal.addEventListener('abort', () => settle('the run was cancelled'), { once: true });
  });

  network.push({
    method: 'WS',
    url,
    // 101 Switching Protocols is what a successful upgrade actually returns.
    status: openProblem === null ? 101 : null,
    durationMs: Date.now() - started,
    responseBodySnippet: openProblem,
  });

  if (openProblem !== null) {
    try {
      socket.close();
    } catch {
      /* the socket never opened; nothing to close */
    }
    return {
      messages,
      transportError: `the WebSocket at ${url} ${openProblem}`,
      target: url,
      notes,
      network,
      durationMs: Date.now() - started,
    };
  }

  for (const frame of source.send) {
    socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  const deadline = started + source.listenSeconds * 1000;
  while (messages.length < source.maxMessages && closed === null && remaining(deadline) > 0) {
    await gate.wait(Math.min(remaining(deadline), 250));
    if (ctx.signal.aborted) break;
  }

  try {
    socket.close();
  } catch {
    /* already closing */
  }
  if (closed !== null) notes.push(closed);

  return {
    messages,
    transportError: null,
    target: url,
    notes,
    network,
    durationMs: Date.now() - started,
  };
}

/**
 * Receive webhooks the application delivers.
 *
 * The receiver binds LOOPBACK ONLY and lives exactly as long as the window. It
 * is an unauthenticated endpoint by nature — a webhook sender has no QAAI
 * credential — so the two things that keep it honest are that nothing outside
 * this host can reach it and that it holds nothing after the test.
 */
async function collectWebhook(
  ctx: RunContext,
  source: z.infer<typeof webhookSourceSchema>,
  baseUrl: string,
  headers: Record<string, string>,
): Promise<Collection> {
  const started = Date.now();
  const notes: string[] = [];
  const messages: CollectedMessage[] = [];
  const network: NetworkEntry[] = [];
  const gate = createGate();
  const wantedPath = source.path.startsWith('/') ? source.path : `/${source.path}`;

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path !== wantedPath) {
      res.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let capped = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_WEBHOOK_BODY_BYTES) {
        if (!capped) {
          capped = true;
          notes.push(`a delivery larger than ${MAX_WEBHOOK_BODY_BYTES} bytes was truncated`);
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const metadata: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        const name = key.toLowerCase();
        // A sender's own credential is not contract data and must not end up in
        // a step, a network entry or the database.
        if (name === 'authorization' || name === 'cookie' || name === 'proxy-authorization') {
          continue;
        }
        if (typeof value === 'string') metadata[name] = value;
        else if (Array.isArray(value)) metadata[name] = value.join(', ');
      }
      messages.push({
        index: messages.length,
        name:
          metadata[source.eventNameHeader.toLowerCase()] ??
          nameFromPayload(text, source.eventNamePath) ??
          '',
        text,
        metadata,
        atMs: Date.now() - started,
      });
      res.writeHead(source.respondStatus).end();
      gate.notify();
    });
    req.on('error', () => res.writeHead(400).end());
  };

  let server: Server;
  try {
    server = createServer(handle);
    await new Promise<void>((ready, failed) => {
      server.once('error', failed);
      server.listen(source.port, '127.0.0.1', ready);
    });
  } catch (err) {
    return {
      messages,
      transportError: `the webhook receiver could not bind 127.0.0.1:${source.port} — ${messageOf(err)}`,
      target: `127.0.0.1:${source.port}`,
      notes,
      network,
      durationMs: Date.now() - started,
    };
  }

  const bound = server.address() as AddressInfo;
  const localUrl = `http://127.0.0.1:${bound.port}${wantedPath}`;
  const callbackUrl = source.callbackUrl ?? localUrl;

  /*
   * Every exit from here on goes through `close()`. A receiver that outlived its
   * test would be an unauthenticated port left open on the worker, which is a
   * far worse outcome than any failure this function can report.
   */
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  };

  try {
    if (source.trigger !== undefined) {
      const triggerUrl = resolveUrl(baseUrl, source.trigger.url);
      const raw = source.trigger.body;
      let triggerBody: string | undefined;
      if (raw !== undefined) {
        const encoded = typeof raw === 'string' ? raw : JSON.stringify(raw);
        triggerBody = encoded?.replaceAll('{{callbackUrl}}', callbackUrl);
      }
      const triggerHeaders: Record<string, string> = {
        ...headers,
        ...source.trigger.headers,
      };
      if (triggerBody !== undefined && typeof raw !== 'string') {
        triggerHeaders['content-type'] ??= 'application/json';
      }
      const sent = await send(
        ctx,
        triggerUrl.replaceAll('{{callbackUrl}}', encodeURIComponent(callbackUrl)),
        source.trigger.method.toUpperCase(),
        triggerHeaders,
        triggerBody,
        Math.min(source.listenSeconds, 60) * 1000,
      );
      network.push(toNetworkEntry(source.trigger.method.toUpperCase(), triggerUrl, sent));
      if (sent.transportError !== null || sent.status === null || sent.status >= 400) {
        return {
          messages,
          transportError:
            sent.transportError !== null
              ? `the trigger request to ${triggerUrl} failed — ${sent.transportError}`
              : `the trigger request to ${triggerUrl} answered HTTP ${sent.status}, so nothing was delivered`,
          target: localUrl,
          notes,
          network,
          durationMs: Date.now() - started,
        };
      }
    }

    const deadline = started + source.listenSeconds * 1000;
    while (messages.length < source.maxMessages && remaining(deadline) > 0) {
      await gate.wait(Math.min(remaining(deadline), 250));
      if (ctx.signal.aborted) break;
    }

    notes.push(`received ${messages.length} delivery(ies) on ${localUrl}`);

    return {
      messages,
      transportError: null,
      target: localUrl,
      notes,
      network,
      durationMs: Date.now() - started,
    };
  } finally {
    await close();
  }
}

/**
 * Fill in the two metadata keys a message pact routinely asserts on but a
 * transport expresses some other way.
 *
 * A pact says `metadata: { topic: "order.shipped", contentType:
 * "application/json" }`. SSE carries the topic as its `event:` field and the
 * content type in the stream's own header, not per message; a WebSocket carries
 * neither. Without this, verifying a perfectly correct provider would fail on
 * "metadata topic is missing" — a false accusation, and the reason a team stops
 * trusting contract tests. Nothing is overwritten: a transport that really did
 * carry the key keeps its own value.
 */
function annotate(collection: Collection): Collection {
  for (const message of collection.messages) {
    if (message.name.length > 0) message.metadata['topic'] ??= message.name;
    if (message.metadata['contentType'] === undefined) {
      let json = true;
      try {
        JSON.parse(message.text);
      } catch {
        json = false;
      }
      message.metadata['contentType'] = json ? 'application/json' : 'text/plain';
    }
  }
  return collection;
}

/**
 * Open the transport, listen for the window, and hand back what arrived.
 *
 * Never throws for a transport that misbehaved — that is a `transportError` the
 * caller reports as a failing step. It throws only `MissingToolError`, which is
 * this worker's problem and is reported as SKIPPED.
 */
export async function collectMessages(
  ctx: RunContext,
  source: EventSource,
  baseUrl: string,
  headers: Record<string, string>,
): Promise<Collection> {
  if (source.transport === 'sse') return annotate(await collectSse(ctx, source, baseUrl, headers));
  if (source.transport === 'websocket') {
    return annotate(await collectWebSocket(ctx, source, baseUrl, headers));
  }
  return annotate(await collectWebhook(ctx, source, baseUrl, headers));
}

// ─── Pact message providers ──────────────────────────────────────────────────

/** What a pact message provider gave back for one description. */
export interface ProducedMessage {
  message: CollectedMessage | null;
  /** Sentence describing why nothing usable came back. */
  problem: string | null;
  network: NetworkEntry;
  durationMs: number;
}

/**
 * Ask a pact message provider to produce one message.
 *
 * Pact's own protocol: POST `{ description, providerStates }` and the response
 * body IS the message. Metadata rides in the `Pact-Message-Metadata` header as
 * base64 JSON, which is where the topic/content-type live.
 */
export async function requestPactMessage(
  ctx: RunContext,
  source: Extract<MessageSource, { transport: 'http' }>,
  baseUrl: string,
  headers: Record<string, string>,
  description: string,
  states: Array<{ name: string; params: Record<string, unknown> }>,
  timeoutMs: number,
): Promise<ProducedMessage> {
  const url = resolveUrl(baseUrl, source.url);
  const method = source.method.toUpperCase();
  const sent = await send(
    ctx,
    url,
    method,
    { ...headers, 'content-type': 'application/json', accept: '*/*' },
    JSON.stringify({
      description,
      providerStates: states,
      // pact-jvm's message shim reads `providerState`; pact-js reads the array.
      // Sending both costs nothing and covers every provider harness in the wild.
      ...(states[0] !== undefined ? { providerState: states[0].name } : {}),
    }),
    timeoutMs,
  );
  const network = toNetworkEntry(method, url, sent);

  if (sent.transportError !== null) {
    return {
      message: null,
      problem: `the message provider at ${url} could not be reached — ${sent.transportError}`,
      network,
      durationMs: sent.durationMs,
    };
  }
  if (sent.status === null || sent.status >= 300) {
    return {
      message: null,
      problem: `the message provider at ${url} answered HTTP ${sent.status} for "${description}"`,
      network,
      durationMs: sent.durationMs,
    };
  }

  const metadata: Record<string, string> = {};
  const encoded = sent.headers['pact-message-metadata'] ?? sent.headers['pact_message_metadata'];
  if (encoded !== undefined) {
    try {
      const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      if (isRecord(decoded)) {
        for (const [key, value] of Object.entries(decoded)) {
          metadata[key] = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
        }
      }
    } catch {
      // A provider that cannot encode its own metadata has not broken the
      // message contract; the payload is still checked.
      metadata['qaai.metadataDecodeFailed'] = 'true';
    }
  }
  const contentType = sent.headers['content-type'];
  if (contentType !== undefined) metadata['contentType'] ??= contentType;

  return {
    message: {
      index: 0,
      name: metadata['topic'] ?? metadata['destination'] ?? '',
      text: sent.text,
      metadata,
      atMs: sent.durationMs,
    },
    problem: null,
    network,
    durationMs: sent.durationMs,
  };
}

// ─── Pact message pacts ──────────────────────────────────────────────────────

export interface PactMessage {
  description: string;
  states: Array<{ name: string; params: Record<string, unknown> }>;
  /** The shape the consumer declared. `undefined` when the pact declared none. */
  contents: unknown;
  metadata: Record<string, string>;
  /**
   * Matching rules with the message dialects folded into the HTTP one, so
   * contract.ts's single rule collector reads them unchanged.
   */
  matchingRules: unknown;
}

function stateList(raw: unknown): Array<{ name: string; params: Record<string, unknown> }> {
  if (Array.isArray(raw)) {
    return raw
      .filter(isRecord)
      .map((state) => ({
        name: typeof state.name === 'string' ? state.name : '',
        params: isRecord(state.params) ? state.params : {},
      }))
      .filter((state) => state.name.length > 0);
  }
  if (typeof raw === 'string' && raw.length > 0) return [{ name: raw, params: {} }];
  return [];
}

/**
 * Normalise a message's matching rules onto the categories the HTTP matcher
 * already understands.
 *
 * pact-jvm writes message body rules under `body`; pact-js writes them under
 * `content`, and v2 spells the same rules as flat `$.body.…` keys. Renaming the
 * category here is the whole adaptation — the rules themselves are handed to the
 * one matcher in contract.ts untouched, so a message pact and an HTTP pact
 * cannot disagree about what `match: "type"` means.
 */
export function normaliseMessageRules(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'content') {
      out['body'] = value;
      continue;
    }
    if (key.startsWith('$.content')) {
      out[`$.body${key.slice('$.content'.length)}`] = value;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** The message half of a pact document, in the shape the verifier needs. */
export function pactMessages(document: Record<string, unknown>): PactMessage[] {
  const raw = Array.isArray(document.messages) ? document.messages : [];
  return raw.filter(isRecord).map((message, index) => {
    const metadata: Record<string, string> = {};
    const rawMetadata = isRecord(message.metadata)
      ? message.metadata
      : isRecord(message.metaData)
        ? message.metaData
        : {};
    for (const [key, value] of Object.entries(rawMetadata)) {
      metadata[key] = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
    }
    return {
      description:
        typeof message.description === 'string' ? message.description : `message ${index + 1}`,
      states: stateList(message.providerStates ?? message.providerState ?? message.provider_state),
      // `contents` is v3; `content` is what several v2 writers emit.
      contents: 'contents' in message ? message.contents : message.content,
      metadata,
      matchingRules: normaliseMessageRules(message.matchingRules),
    };
  });
}

// ─── AsyncAPI ────────────────────────────────────────────────────────────────

export interface AsyncApiMessage {
  /** The address a message is matched against: the channel address, or its key. */
  channel: string;
  /** The key in the `channels` map, which is what the document is indexed by. */
  channelKey: string;
  /** The declared message name, when the document names it. */
  name: string;
  /** Raw schema node — contract.ts resolves `$ref` and validates against it. */
  payloadSchema: unknown;
  /** `subscribe`/`publish` (2.x) or `send`/`receive` (3.x). */
  direction: string;
  /**
   * Set when the payload is declared in something that is not JSON Schema
   * (Avro, Protobuf). Those are reported as not verified rather than passed.
   */
  unverifiableFormat: string | null;
}

/** `application/vnd.aai.asyncapi;version=2.6.0` and friends all mean JSON Schema. */
function isJsonSchemaFormat(format: unknown): boolean {
  if (typeof format !== 'string' || format.length === 0) return true;
  const lower = format.toLowerCase();
  return (
    lower.includes('asyncapi') || lower.includes('jsonschema') || lower.includes('json-schema')
  );
}

function messageEntries(
  node: unknown,
  deref: (value: unknown) => unknown,
): Array<Record<string, unknown>> {
  const resolved = deref(node);
  if (!isRecord(resolved)) return [];
  if (Array.isArray(resolved.oneOf)) {
    return resolved.oneOf.map(deref).filter(isRecord);
  }
  return [resolved];
}

/**
 * Every message an AsyncAPI document declares, flattened.
 *
 * Both major versions are read, because both are in the wild and a customer
 * should not have to migrate their document to be verified:
 *
 *   2.x  `channels: { "order.shipped": { subscribe: { message: {...} } } }`
 *        — the channel key IS the address.
 *   3.x  `channels: { orderShipped: { address: "order.shipped",
 *                                     messages: { OrderShipped: {...} } } }`
 *        — the address is explicit and the key is just an id.
 *
 * `deref` is the caller's JSON-pointer resolver. Passing it in rather than
 * writing another one keeps `$ref` resolution identical to the OpenAPI mode's.
 */
export function asyncApiMessages(
  document: unknown,
  deref: (value: unknown) => unknown,
): { messages: AsyncApiMessage[]; notes: string[] } {
  const notes: string[] = [];
  const messages: AsyncApiMessage[] = [];
  if (!isRecord(document)) return { messages, notes };

  const channels = isRecord(document.channels) ? document.channels : null;
  if (channels === null) return { messages, notes };

  for (const [key, rawChannel] of Object.entries(channels)) {
    const channel = deref(rawChannel);
    if (!isRecord(channel)) continue;
    const address = typeof channel.address === 'string' ? channel.address : key;

    const push = (entry: Record<string, unknown>, direction: string, name: string): void => {
      const format = entry.schemaFormat;
      messages.push({
        channel: address,
        channelKey: key,
        name: typeof entry.name === 'string' ? entry.name : name,
        payloadSchema: entry.payload,
        direction,
        unverifiableFormat: isJsonSchemaFormat(format) ? null : String(format),
      });
    };

    // 3.x — a map of named messages on the channel itself.
    if (isRecord(channel.messages)) {
      for (const [name, rawMessage] of Object.entries(channel.messages)) {
        for (const entry of messageEntries(rawMessage, deref)) push(entry, 'message', name);
      }
    }

    // 2.x — one operation object per direction, each with a `message`.
    for (const direction of ['subscribe', 'publish'] as const) {
      const operation = deref(channel[direction]);
      if (!isRecord(operation)) continue;
      for (const entry of messageEntries(operation.message, deref)) push(entry, direction, '');
    }
  }

  for (const message of messages) {
    if (message.unverifiableFormat !== null) {
      notes.push(
        `${message.channel} declares its payload as ${message.unverifiableFormat}, which is not JSON Schema`,
      );
    }
  }

  return { messages, notes };
}
