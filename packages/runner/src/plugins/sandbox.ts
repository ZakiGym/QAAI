/**
 * The sandbox third-party plugin code executes in (§4, plugin runtime).
 *
 * A plugin is untrusted even when the customer installed it themselves. It runs
 * against their application, with their secrets within reach, on infrastructure
 * we operate and share between tenants. So this file's job is not "run the
 * plugin" — that part is easy — it is to state exactly what the plugin can and
 * cannot touch, enforce the half that Node can enforce, and REFUSE the half it
 * cannot rather than pretending.
 *
 * ─── What is actually enforced ───────────────────────────────────────────────
 *
 * The plugin runs in a `worker_threads` Worker: a separate V8 isolate in the
 * same OS process. From that we get four real properties, each verified by a
 * test in sandbox.test.ts rather than assumed from the docs:
 *
 *   1. CPU. `worker.terminate()` kills the isolate mid-instruction, so a plugin
 *      spinning in `for(;;){}` is stopped. A `Promise.race` timeout in-process
 *      cannot do this — the loop never yields, so the timer never fires.
 *
 *   2. HEAP GROWTH. `resourceLimits.maxOldGenerationSizeMb` makes V8 kill the
 *      worker with ERR_WORKER_OUT_OF_MEMORY when the plugin grows the heap past
 *      the cap. It bounds incremental growth; see the honest caveat below.
 *
 *   3. ENVIRONMENT. `env: {}` gives the worker its own, EMPTY `process.env`.
 *      The plugin cannot read DATABASE_URL, the S3 credentials, or the vault
 *      key by name, because in its isolate those names do not exist.
 *
 *   4. MODULE REACH. The code is imported from a `data:` URL, and Node refuses
 *      to resolve bare specifiers from one. `import 'playwright'`, `import
 *      '@prisma/client'`, `import '@qaai/storage'` all fail at load. A plugin
 *      cannot pick our own dependencies up off the worker's disk and use them.
 *
 * On top of those the host enforces, entirely on its own side of the boundary:
 * the capability grant set, the number of host calls, the shape of the report,
 * and its size. None of that asks the plugin to cooperate.
 *
 * ─── What is NOT enforced, and is therefore refused ──────────────────────────
 *
 * A worker thread is a RESOURCE boundary, not a SYSCALL boundary. `node:`
 * specifiers still resolve from a data: URL, so plugin code can reach
 * `node:fs`, `node:net`, `node:child_process` and `node:worker_threads`
 * directly. Nothing in this file changes that, and a capability model that
 * claimed to gate the filesystem while `readFileSync` sat one import away would
 * be worse than none — it would be a lie an operator relies on.
 *
 * So the rule this file is built around: QAAI grants only capabilities it
 * MEDIATES — the host performs the effect and the plugin never holds the
 * handle. Everything else is refused by name at load time, with a reason, and
 * the refusal is what an operator reads instead of a false assurance. Real
 * containment against a hostile plugin has to come from outside the process:
 * a container with no egress, or Node's own permission model. When the latter
 * is switched on, `containmentTier()` reports it, because the permission model
 * IS per-process and therefore does cover worker threads.
 *
 * ─── The one capability that leaves the process: `http` ──────────────────────
 *
 * `http` is mediated rather than granted precisely so that QAAI, and not the
 * plugin, decides where the connection goes. That argument only holds if this
 * file actually decides. It did not: the destination check lived entirely on
 * the host's side of `onCall`, where it compared the URL against a SET of
 * allowed origins that the installed record could extend — so an origin list
 * reading `["http://169.254.169.254"]` was honoured verbatim, and the mediated
 * capability became an SSRF primitive pointed at our own network.
 *
 * `checkHttpDestination` moves the rule to the boundary the plugin crosses,
 * ahead of `onCall`, and states it as the capability's own copy states it to
 * the person approving the install: the environment under test's own origin,
 * scheme host and port, and nothing else. A host may narrow that; it cannot
 * widen it. An off-origin request is a refusal the plugin observes; a request
 * aimed INSIDE our network ends the run, because that is a boundary probe and
 * not a bug.
 *
 * ─── The one that bites: giant strings ───────────────────────────────────────
 *
 * Measured on Node 25, not inferred. `'x'.repeat(300 * 1024 * 1024)` inside a
 * worker capped at 32 MB old-generation does NOT trip the resource limit: V8
 * represents it as a rope and the bytes are never materialised. Pass that value
 * to `JSON.stringify` and the flatten it forces blows the heap limit as a FATAL
 * error, which aborts the whole process — every other tenant's test on that
 * worker dies with it. That is not a hypothetical; it killed the probe that
 * found it.
 *
 * Two consequences, both load-bearing:
 *   - the worker NEVER calls `JSON.stringify` on a plugin value until a walk
 *     has proved the result fits the budget, and that walk measures strings by
 *     `.length` (O(1) on a rope) without ever reading them.
 *   - the report crosses the boundary as a fixed-size byte buffer, so the size
 *     cap is a property of the transport rather than a check the host performs
 *     after it has already been handed the bytes.
 */

import { Worker } from 'node:worker_threads';
/*
 * A SUBPATH, not the barrel: private-address.ts reaches for `node:dns`, and the
 * barrel is what the web app's bundler consumes. The subpath keeps one
 * definition of "is this address inside our network" reachable from the worker
 * and the runner without dragging dns into a browser tab.
 */
import { classifyHost } from '@qaai/shared/private-address';

// ─── Capability model ────────────────────────────────────────────────────────

/**
 * The capabilities QAAI will grant, which is exactly the set it mediates: for
 * each one the HOST performs the effect and hands back a value. The plugin
 * never receives a file handle, a socket, a browser page, or the RunContext.
 */
/*
 * The vocabulary is @qaai/shared's, not this file's.
 *
 * It was declared here AND in the registry's manifest, with only `secrets` in
 * common: this file granted what it could mediate, and the manifest offered the
 * raw list a plugin might want. An org could therefore install a plugin
 * declaring `network`, be told it was fine, and watch this loader refuse it on
 * every run afterwards — closed, but broken, and discovered by a customer
 * rather than at install time.
 *
 * The argument in this file won, so it moved to where the install screen and
 * the API can read it too. The refusal sentences moved with it: they are what
 * the person installing needs, and they were only ever printed here.
 */
import {
  PLUGIN_CAPABILITIES,
  REFUSED_CAPABILITIES,
  capabilityRefusal,
  type PluginCapability,
} from '@qaai/shared';

/** Kept under this package's original names so existing callers do not move. */
export const MEDIATED_CAPABILITIES = PLUGIN_CAPABILITIES;
export type Capability = PluginCapability;
export { REFUSED_CAPABILITIES, capabilityRefusal };

const MEDIATED = new Set<string>(PLUGIN_CAPABILITIES);


export type CapabilityDecision =
  | { granted: true; capability: Capability }
  | { granted: false; reason: string };

/**
 * Fail closed on anything unrecognised. A capability QAAI has never heard of
 * cannot have been mediated, so "unknown" and "refused" must land in the same
 * place — a default-allow here would make every future manifest field a hole.
 */
export function classifyCapability(name: string): CapabilityDecision {
  if (MEDIATED.has(name)) return { granted: true, capability: name as Capability };
  const known = REFUSED_CAPABILITIES[name];
  if (known) return { granted: false, reason: known };
  return {
    granted: false,
    reason: `QAAI grants only the capabilities it mediates (${MEDIATED_CAPABILITIES.join(', ')}); "${name}" is not one of them.`,
  };
}

// ─── Containment tiers ───────────────────────────────────────────────────────

/**
 * `isolate` is what this file can achieve on its own; `isolate+os` is what the
 * operator adds by starting the worker under Node's permission model, which is
 * per-PROCESS and so covers worker threads too. Reported on every result so the
 * tier a plugin actually ran under is a recorded fact rather than a deployment
 * assumption.
 */
export type ContainmentTier = 'isolate' | 'isolate+os';

interface PermissionApi {
  has(scope: string, reference?: string): boolean;
}

/**
 * `process.permission` exists only when Node was started with `--permission`.
 * Taken as an argument so the decision is testable without re-executing the
 * suite under a different flag.
 */
export function containmentTier(
  permission: PermissionApi | undefined = (process as { permission?: PermissionApi }).permission,
): ContainmentTier {
  if (!permission || typeof permission.has !== 'function') return 'isolate';
  // Only the tiers that actually deny something count. A permission model with
  // blanket fs read AND write allowed is the default surface wearing a hat.
  const denied = !permission.has('fs.write') || !permission.has('child');
  return denied ? 'isolate+os' : 'isolate';
}

// ─── Limits ──────────────────────────────────────────────────────────────────

/**
 * Every one of these is enforced by the host or by V8. There is deliberately no
 * limit here that depends on the plugin behaving, because a limit a plugin can
 * ignore is documentation.
 */
export interface SandboxLimits {
  /** Hard: exceeded means `terminate()`, which stops a non-yielding loop. */
  wallClockMs: number;
  /** V8 old-generation cap. Bounds heap GROWTH; see the rope caveat up top. */
  memoryMb: number;
  /** Size of the buffer the report crosses in. The transport cannot exceed it. */
  maxOutputBytes: number;
  /** Caps on what may reach the database, checked before anything is parsed. */
  maxSteps: number;
  maxFindings: number;
  maxLogLines: number;
  maxNetworkEntries: number;
  /** Bounds the mediated bridge, so a plugin cannot DoS the host with calls. */
  maxHostCalls: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  wallClockMs: 120_000,
  memoryMb: 128,
  maxOutputBytes: 512 * 1024,
  maxSteps: 500,
  maxFindings: 500,
  maxLogLines: 500,
  maxNetworkEntries: 500,
  maxHostCalls: 2_000,
};

/**
 * A manifest may ask for LESS than the ceiling and never more.
 *
 * Taking the minimum of every field is the whole point: the limits arrive
 * inside the same installed record the plugin author wrote, so treating them as
 * a request rather than a setting is the difference between a cap and a
 * suggestion. Non-finite and non-positive values fall back to the ceiling
 * rather than to zero — a NaN that silently became a 0 ms deadline would look
 * exactly like a plugin that always times out.
 */
export function clampLimits(
  requested: Partial<SandboxLimits> | undefined,
  ceiling: SandboxLimits = DEFAULT_SANDBOX_LIMITS,
): SandboxLimits {
  const pick = (key: keyof SandboxLimits): number => {
    const want = requested?.[key];
    if (typeof want !== 'number' || !Number.isFinite(want) || want <= 0) return ceiling[key];
    return Math.min(Math.floor(want), ceiling[key]);
  };
  return {
    wallClockMs: pick('wallClockMs'),
    memoryMb: pick('memoryMb'),
    maxOutputBytes: pick('maxOutputBytes'),
    maxSteps: pick('maxSteps'),
    maxFindings: pick('maxFindings'),
    maxLogLines: pick('maxLogLines'),
    maxNetworkEntries: pick('maxNetworkEntries'),
    maxHostCalls: pick('maxHostCalls'),
  };
}

// ─── Faults ──────────────────────────────────────────────────────────────────

/**
 * Every way a plugin can fail to produce a trustworthy result.
 *
 * These exist as a closed set so the caller can say "the PLUGIN broke" with a
 * specific reason, and never has to fall back on the customer's application
 * being at fault. `CANCELLED` is the one member that is not the plugin's doing;
 * it is here because it arrives down the same path and the caller must be able
 * to tell it apart rather than reporting a cancelled run as a broken plugin.
 */
export type PluginFaultKind =
  | 'HASH_MISMATCH'
  | 'REFUSED_CAPABILITY'
  | 'UNDECLARED_CAPABILITY'
  | 'CODE_TOO_LARGE'
  | 'LOAD_ERROR'
  | 'MISSING_ENTRY'
  | 'THREW'
  | 'TIMEOUT'
  | 'OUT_OF_MEMORY'
  | 'CRASHED'
  | 'OUTPUT_TOO_LARGE'
  | 'BAD_SHAPE'
  | 'TOO_MANY_EMITTED'
  | 'HOST_CALL_LIMIT'
  | 'EGRESS_REFUSED'
  | 'CANCELLED';

export interface PluginFault {
  kind: PluginFaultKind;
  /** A sentence an operator can act on. Never contains a secret value. */
  message: string;
  /** Plugin stack when we have one; truncated. */
  stack?: string | null;
}

/** True for everything that is the plugin's fault — i.e. everything but cancellation. */
export function isPluginAtFault(fault: PluginFault): boolean {
  return fault.kind !== 'CANCELLED';
}

// ─── Host-side request/response types ────────────────────────────────────────

/** What the plugin is handed. Deliberately data only — no functions, no handles. */
export interface SandboxRequest {
  baseUrl: string;
  /** The test's `spec`, which is org-authored and already validated as JSON. */
  spec: unknown;
  test: { id: string; name: string; filePath: string; tags: string[] };
}

export interface SandboxHostCall {
  capability: Capability;
  method: string;
  args: unknown[];
}

export interface SandboxOptions {
  code: string;
  request: SandboxRequest;
  /** Exactly the capabilities the manifest declared and `classifyCapability` allowed. */
  granted: ReadonlySet<Capability>;
  limits: SandboxLimits;
  /**
   * Performs one mediated effect. Throwing is a refusal the plugin observes as
   * a rejected promise — the plugin keeps running, because a plugin asking for
   * a fixture it did not declare is a bug in the plugin, not an attack on the
   * host.
   */
  onCall: (call: SandboxHostCall) => Promise<unknown>;
  signal: AbortSignal;
}

export interface SandboxUsage {
  hostCalls: number;
  durationMs: number;
  containment: ContainmentTier;
  outputBytes: number;
}

export type SandboxOutcome =
  | { ok: true; json: string; usage: SandboxUsage }
  | { ok: false; fault: PluginFault; usage: SandboxUsage };

// ─── The worker bootstrap ────────────────────────────────────────────────────

/**
 * Runs inside the isolate. Kept as a string, and started with `eval: true`, so
 * there is no second entry file whose path has to survive tsx, vitest and a
 * built worker image — three resolution schemes that have each broken a
 * different worker entry point in this repo before.
 *
 * It is not a security control. A plugin can `import('node:worker_threads')`
 * and talk to `parentPort` itself, bypassing the `api` object entirely; that is
 * precisely why the grant check lives on the HOST side of every message and is
 * tested by a plugin that does exactly this.
 */
const BOOTSTRAP = String.raw`
import { workerData, parentPort } from 'node:worker_threads';

const port = parentPort;
const { code, request, granted, limits } = workerData;

function fault(kind, message) {
  const err = new Error(message);
  err.qaaiKind = kind;
  return err;
}

/** Slicing a huge rope flattens it, so refuse to look at one at all. */
function short(value, max) {
  if (typeof value !== 'string') return '';
  if (value.length > 1_000_000) return '(message too large to report)';
  return value.length > max ? value.slice(0, max) : value;
}

let seq = 0;
const pending = new Map();
port.on('message', (msg) => {
  const entry = msg && pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  if (msg.error) entry.reject(new Error(String(msg.error)));
  else entry.resolve(msg.value);
});

const call = (capability, method, args) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    port.postMessage({ type: 'call', id, capability, method, args });
  });

const FACTORIES = {
  log: () => ({ line: (text) => call('log', 'line', [String(text)]) }),
  http: () => ({ request: (init) => call('http', 'request', [init]) }),
  secrets: () => ({ get: (name) => call('secrets', 'get', [String(name)]) }),
  fixtures: () => ({ read: (path) => call('fixtures', 'read', [String(path)]) }),
};

const api = { baseUrl: request.baseUrl };
for (const name of granted) if (FACTORIES[name]) api[name] = FACTORIES[name]();
Object.freeze(api);

/**
 * Upper bound on the JSON size of a value, abandoned the moment it passes the
 * budget. Strings are charged by .length and never read, because reading one
 * is what flattens a rope and aborts the process.
 */
function bound(value, budget) {
  const seen = new Set();
  let used = 0;
  const spend = (n) => {
    used += n;
    if (used > budget) {
      throw fault('OUTPUT_TOO_LARGE', 'the report is larger than the ' + budget + '-byte budget');
    }
  };
  const walk = (v, depth) => {
    if (depth > 16) throw fault('BAD_SHAPE', 'the report nests deeper than 16 levels');
    if (v === null || typeof v !== 'object') {
      // \uXXXX escaping can sextuple a character; over-charging only makes the
      // cap conservative, and being conservative is the correct direction here.
      spend(typeof v === 'string' ? v.length * 6 + 2 : 24);
      return;
    }
    if (seen.has(v)) throw fault('BAD_SHAPE', 'the report contains a reference cycle');
    seen.add(v);
    spend(2);
    if (Array.isArray(v)) {
      for (const item of v) { spend(1); walk(item, depth + 1); }
    } else {
      for (const key of Object.keys(v)) { spend(key.length * 6 + 4); walk(v[key], depth + 1); }
    }
    seen.delete(v);
  };
  walk(value, 0);
}

async function main() {
  let mod;
  try {
    const url = 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64');
    mod = await import(url);
  } catch (err) {
    throw fault('LOAD_ERROR', short(err && err.message, 1000) || String(err));
  }

  if (!mod || typeof mod.execute !== 'function') {
    throw fault('MISSING_ENTRY', 'the plugin module does not export an execute() function');
  }

  let report;
  try {
    report = await mod.execute(api, request);
  } catch (err) {
    const wrapped = fault('THREW', short(err && err.message, 1000) || String(err));
    wrapped.qaaiStack = short(err && err.stack, 4000);
    throw wrapped;
  }

  bound(report, limits.maxOutputBytes);

  // Safe now, and only now: bound() proved the flattened form fits.
  const json = JSON.stringify(report === undefined ? null : report);
  if (typeof json !== 'string') {
    throw fault('BAD_SHAPE', 'the report is not JSON-serialisable');
  }
  const bytes = new Uint8Array(limits.maxOutputBytes);
  const { written } = new TextEncoder().encodeInto(json, bytes);
  if (written < Buffer.byteLength(json, 'utf8')) {
    throw fault('OUTPUT_TOO_LARGE', 'the report is larger than the ' + limits.maxOutputBytes + '-byte budget');
  }
  port.postMessage({ type: 'result', len: written, bytes: bytes.buffer }, [bytes.buffer]);
}

main().catch((err) => {
  port.postMessage({
    type: 'fault',
    kind: (err && err.qaaiKind) || 'THREW',
    message: short(err && err.message, 2000) || String(err),
    stack: (err && err.qaaiStack) || short(err && err.stack, 4000) || null,
  });
});
`;

// ─── Running one plugin ──────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The only fault kinds the bootstrap is allowed to name for itself. */
const BOOTSTRAP_FAULT_KINDS = new Set<string>([
  'LOAD_ERROR',
  'MISSING_ENTRY',
  'THREW',
  'OUTPUT_TOO_LARGE',
  'BAD_SHAPE',
]);

// ─── Egress policy for the mediated `http` capability ────────────────────────

/**
 * What the host is allowed to do with one `http` request the plugin asked for.
 *
 * Three outcomes rather than two, and the third one is the whole point:
 *
 *  - `allow` — the destination is the environment under test. Go.
 *  - `refuse` — the plugin asked for somewhere it is not entitled to reach, and
 *    that is a BUG IN THE PLUGIN. It observes a rejected promise and keeps
 *    running, exactly like asking for a fixture it never declared.
 *  - `probe` — the plugin asked QAAI to open a connection INSIDE QAAI'S OWN
 *    NETWORK: the cloud metadata service, a database port on loopback, a
 *    cluster-internal name, or an address written in a form chosen so that two
 *    parsers would read it differently. That is not a bug, it is somebody using
 *    the mediated capability as an SSRF primitive, and it ends the run — the
 *    same treatment `UNDECLARED_CAPABILITY` already gets, for the same reason:
 *    a boundary probe must not be a retryable error the caller can swallow.
 */
export type HttpDestination =
  | { verdict: 'allow'; url: string }
  | { verdict: 'refuse'; reason: string }
  | { verdict: 'probe'; reason: string };

/**
 * Decide where a plugin's `http` call may go.
 *
 * ─── Why this lives HERE and not only in the mediation ───────────────────────
 *
 * The host's `onCall` builds the request, so the obvious place for this check
 * is there — and there is one there. It compares the destination against a SET
 * of allowed origins: the environment's baseUrl plus whatever extra origins the
 * installed record carries. That set is data, and the moment anything ever
 * populates the extra half, `http` becomes an SSRF primitive with no address
 * classification anywhere behind it: an origin list reading
 * `["http://169.254.169.254"]` was, when this was written, accepted verbatim
 * and the request attempted, from our network, with the body handed back.
 *
 * So the rule the CAPABILITY'S OWN COPY promises the person installing the
 * plugin — "QAAI makes the request, against the environment's own origin" — is
 * enforced at the boundary the plugin actually crosses, before `onCall` is
 * consulted at all. A host may be more restrictive than this; it cannot be less.
 *
 * ─── Same origin, exactly ────────────────────────────────────────────────────
 *
 * `url.origin === base.origin` is scheme, host AND port. It is the strongest
 * rule available and it needs no resolver: the operator pointed this run at
 * this origin, so it is the environment by definition — including when it is
 * `http://127.0.0.1:3000`, which is what a local run looks like and which no
 * address-classification rule could admit without admitting every loopback
 * port on the box.
 *
 * That leaves classification with exactly one job, and it is the one that
 * matters: deciding whether an OFF-origin destination is merely wrong or is
 * pointed at our insides.
 *
 * ─── Redirects ───────────────────────────────────────────────────────────────
 *
 * A redirect is not followed by anybody: the host fetches with
 * `redirect: 'manual'`, so a 3xx comes back to the plugin as a status and a
 * Location header. If the plugin wants the next hop it must ask for it, and the
 * ask arrives here — so "starts public, lands private" is refused on the hop
 * that lands, not trusted because the first hop looked fine.
 */
export function checkHttpDestination(rawUrl: unknown, baseUrl: string): HttpDestination {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    // No environment origin means there is nothing a plugin is entitled to
    // reach. Refusing everything is the only reading that fails closed.
    return {
      verdict: 'refuse',
      reason: 'this run has no usable environment URL, so `http` can reach nothing',
    };
  }

  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return { verdict: 'refuse', reason: 'the plugin asked for a URL QAAI could not parse' };
  }

  let url: URL;
  try {
    url = new URL(rawUrl, base);
  } catch {
    return { verdict: 'refuse', reason: 'the plugin asked for a URL QAAI could not parse' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { verdict: 'refuse', reason: `"${url.protocol}" is not an allowed scheme` };
  }
  if (url.username || url.password) {
    return {
      verdict: 'refuse',
      reason: 'a mediated request may not carry credentials embedded in the URL',
    };
  }

  if (url.origin === base.origin) return { verdict: 'allow', url: url.toString() };

  const host = classifyHost(url.hostname);
  const label = url.origin.slice(0, 120);

  /*
   * `ambiguous` is a probe and never a refusal. `0177.0.0.1`, `2130706433` and
   * `0x7f.0.0.1` are all loopback to something in the stack below us and a
   * hostname to something else; nobody types one by accident, and the only
   * reason to write an address that way is that some check in between reads it
   * differently from the socket that opens.
   */
  if (host.kind === 'ambiguous') {
    return { verdict: 'probe', reason: `${label} — ${host.why}` };
  }
  if (host.kind === 'address' && host.class !== 'public') {
    return {
      verdict: 'probe',
      reason: `${label} is a ${host.class} address, which is inside QAAI's own network`,
    };
  }
  if (host.kind === 'name' && host.internal) {
    return {
      verdict: 'probe',
      reason: `${label} is a name that resolves inside a private network`,
    };
  }

  /*
   * Off-origin but plausibly on the public internet. This is the exfiltration
   * shape — a plugin holding a response body and wanting to POST it somewhere
   * it chose — and it is a refusal rather than a probe because the run is not
   * being used to reach anything of ours. The plugin sees it and can carry on.
   *
   * NOTE what is deliberately NOT done: the name is not resolved. Every
   * off-origin destination is refused whatever it resolves to, so a lookup
   * would change no outcome while turning the refusal path into an outbound
   * DNS request a plugin can aim. `resolvesPublicly` in the shared module is
   * for callers that will actually connect.
   */
  return {
    verdict: 'refuse',
    reason: `the plugin asked to reach ${label}, which is not the environment under test (${base.origin})`,
  };
}

/** Bounds what an untrusted argument can cost us before we look at it. */
const MAX_CALL_ARGS = 8;
const MAX_CALL_STRING = 8192;

function argsAreSane(args: unknown): args is unknown[] {
  if (!Array.isArray(args) || args.length > MAX_CALL_ARGS) return false;
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > 8) return false;
    if (typeof v === 'string') return v.length <= MAX_CALL_STRING;
    if (v === null || typeof v !== 'object') return true;
    if (seen.has(v)) return false;
    seen.add(v);
    const entries = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
    if (entries.length > 64) return false;
    return entries.every((item) => walk(item, depth + 1));
  };
  return args.every((arg) => walk(arg, 0));
}

/**
 * Executes plugin code and returns either its raw report JSON or the fault that
 * stopped it. Never throws: a caller that has to wrap this in a try/catch would
 * eventually forget, and the forgotten case gets recorded as the customer's
 * application failing.
 */
export async function runInSandbox(options: SandboxOptions): Promise<SandboxOutcome> {
  const { code, request, granted, limits, onCall, signal } = options;
  const startedAt = Date.now();
  const containment = containmentTier();

  let hostCalls = 0;
  let outputBytes = 0;
  let settled = false;

  const usage = (): SandboxUsage => ({
    hostCalls,
    durationMs: Date.now() - startedAt,
    containment,
    outputBytes,
  });

  if (signal.aborted) {
    return { ok: false, fault: { kind: 'CANCELLED', message: 'the run was cancelled' }, usage: usage() };
  }

  /*
   * From here to the end of the function everything is inside one try, and the
   * catch turns a throw into a FAULT rather than a rejection.
   *
   * The docblock above has always said this function never throws, and the
   * loader's attribution guarantee rests on that sentence: `executeExternal`
   * awaits this and converts a fault into a SKIPPED execution, while a
   * REJECTION propagates out of the plugin's `execute()` and is recorded by
   * apps/worker/src/processors/run.ts as the customer's application failing —
   * the single worst bug this feature can ship.
   *
   * The sentence was not true. `new Worker(...)` runs synchronously, outside
   * the promise below, and it throws: a `request.spec` carrying anything
   * structured-clone cannot copy raises DataCloneError before the isolate
   * exists (`() => 1 could not be cloned.`, verified on Node 25), and thread
   * creation itself fails with EAGAIN on a loaded host. Both came back as
   * "your checkout is broken".
   */
  let started: Worker | null = null;
  try {
    const worker = new Worker(BOOTSTRAP, {
      eval: true,
      workerData: { code, request, granted: [...granted], limits },
      // An empty environment is the strongest single control here: the vault key,
      // the database URL and the S3 credentials are not merely unreadable, they
      // are absent from the isolate.
      env: {},
      argv: [],
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: limits.memoryMb,
        maxYoungGenerationSizeMb: Math.min(16, Math.max(4, Math.floor(limits.memoryMb / 8))),
        stackSizeMb: 4,
      },
      // Detached from the parent's streams, then drained. A plugin that writes a
      // gigabyte to stdout would otherwise either fill the operator's logs or,
      // unread, buffer in the parent's heap.
      stdout: true,
      stderr: true,
    });
    // Recorded for the catch below, which must clean up a worker that was
    // created before the throw rather than leave the thread running.
    started = worker;
    worker.stdout.resume();
    worker.stderr.resume();

    return await new Promise<SandboxOutcome>((resolve) => {
      const finish = (outcome: SandboxOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal.removeEventListener('abort', onAbort);
        // Unconditional: a plugin whose report already arrived may still be
        // holding an interval open, and that keeps the worker's loop — and the
        // run — alive past the test.
        void worker.terminate();
        resolve(outcome);
      };

      const fail = (kind: PluginFaultKind, message: string, stack: string | null = null): void =>
        finish({ ok: false, fault: { kind, message, stack }, usage: usage() });

      const deadline = setTimeout(() => {
        fail(
          'TIMEOUT',
          `the plugin did not finish within ${limits.wallClockMs}ms and was stopped`,
        );
      }, limits.wallClockMs);

      const onAbort = (): void => fail('CANCELLED', 'the run was cancelled');
      signal.addEventListener('abort', onAbort, { once: true });

      const handleCall = (raw: Record<string, unknown>): void => {
        const id = raw.id;
        const capability = raw.capability;
        const method = raw.method;

        // The grant check lives HERE, not in the api object the bootstrap builds,
        // because plugin code can reach parentPort directly and forge this
        // message. Asking for something it never declared is a boundary probe,
        // so it ends the run rather than returning an error the plugin can retry.
        if (typeof capability !== 'string' || !granted.has(capability as Capability)) {
          fail(
            'UNDECLARED_CAPABILITY',
            `the plugin asked the host for "${typeof capability === 'string' ? capability.slice(0, 60) : 'an unnamed capability'}", which its manifest does not declare`,
          );
          return;
        }

        hostCalls += 1;
        if (hostCalls > limits.maxHostCalls) {
          fail('HOST_CALL_LIMIT', `the plugin made more than ${limits.maxHostCalls} host calls`);
          return;
        }

        if (typeof method !== 'string' || method.length > 64 || !argsAreSane(raw.args)) {
          fail('BAD_SHAPE', 'the plugin sent a malformed host call');
          return;
        }

        /*
         * The egress rule is enforced BEFORE the host is asked to perform the
         * effect, so the promise the capability's copy makes ("QAAI makes the
         * request, against the environment's own origin") is a property of this
         * boundary rather than of whatever mediation happens to be wired in. A
         * host may narrow this further; it cannot widen it.
         */
        if (capability === 'http') {
          const args = raw.args as unknown[];
          const init = isRecord(args[0]) ? args[0] : {};
          const destination = checkHttpDestination(init.url, request.baseUrl);
          if (destination.verdict === 'probe') {
            fail(
              'EGRESS_REFUSED',
              `the plugin asked QAAI to make a request inside its own network — ${destination.reason}`,
            );
            return;
          }
          if (destination.verdict === 'refuse') {
            // Observed by the plugin as a rejected promise, the same as any other
            // refusal it can provoke. It keeps running; it just does not get this.
            worker.postMessage({ id, error: destination.reason.slice(0, 500) });
            return;
          }
        }

        void onCall({ capability: capability as Capability, method, args: raw.args })
          .then((value) => {
            if (!settled) worker.postMessage({ id, value });
          })
          .catch((err: unknown) => {
            if (settled) return;
            const message = err instanceof Error ? err.message : String(err);
            worker.postMessage({ id, error: message.slice(0, 500) });
          });
      };

      worker.on('message', (raw: unknown) => {
        if (settled || !isRecord(raw)) return;

        if (raw.type === 'call') return handleCall(raw);

        if (raw.type === 'fault') {
          // The kind arrives from inside the isolate, so it is a claim rather
          // than a fact. Anything outside the set the bootstrap can legitimately
          // raise collapses to THREW — a plugin must not be able to relabel its
          // own crash as, say, CANCELLED and have the run stop blaming it.
          const kind = typeof raw.kind === 'string' ? raw.kind : 'THREW';
          return fail(
            BOOTSTRAP_FAULT_KINDS.has(kind) ? (kind as PluginFaultKind) : 'THREW',
            typeof raw.message === 'string' ? raw.message.slice(0, 2000) : 'the plugin failed',
            typeof raw.stack === 'string' ? raw.stack.slice(0, 4000) : null,
          );
        }

        if (raw.type !== 'result') return;

        // Size is checked against the raw buffer before a single byte is decoded,
        // so a forged oversized payload costs a length comparison, not a decode.
        const buffer = raw.bytes;
        const len = raw.len;
        if (!(buffer instanceof ArrayBuffer) || typeof len !== 'number') {
          return fail('BAD_SHAPE', 'the plugin sent a report QAAI could not read');
        }
        if (
          buffer.byteLength > limits.maxOutputBytes ||
          len > limits.maxOutputBytes ||
          len > buffer.byteLength ||
          len < 0
        ) {
          return fail(
            'OUTPUT_TOO_LARGE',
            `the plugin's report exceeds the ${limits.maxOutputBytes}-byte budget`,
          );
        }
        outputBytes = len;
        const json = new TextDecoder().decode(new Uint8Array(buffer, 0, len));
        return finish({ ok: true, json, usage: usage() });
      });

      worker.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ERR_WORKER_OUT_OF_MEMORY') {
          return fail('OUT_OF_MEMORY', `the plugin exceeded its ${limits.memoryMb}MB memory limit`);
        }
        // A throw at module scope surfaces here rather than as a fault message,
        // because the bootstrap's own catch never gets to run.
        return fail('LOAD_ERROR', err.message.slice(0, 2000), err.stack?.slice(0, 4000) ?? null);
      });

      worker.on('exit', (exitCode) => {
        fail('CRASHED', `the plugin's isolate exited with code ${exitCode} before reporting`);
      });
    });
  } catch (err) {
    if (started) void started.terminate();
    return {
      ok: false,
      fault: {
        kind: 'CRASHED',
        message: `the plugin's isolate could not be started: ${
          err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500)
        }`,
        stack: err instanceof Error ? (err.stack?.slice(0, 4000) ?? null) : null,
      },
      usage: usage(),
    };
  }
}
