/**
 * Protocol testing (§4 PROTOCOL) — GraphQL, WebSocket, SSE and gRPC.
 *
 * The API plugin covers REST, which is most of what a backend exposes and none
 * of what it streams. This plugin covers the rest of the surface a modern
 * service actually speaks. Four protocols share one plugin because they share
 * one shape: open a connection, drive an ordered sequence of messages, assert on
 * what comes back before a deadline. Each message and each assertion is a STEP,
 * so a broken subscription shows exactly which frame never arrived.
 *
 * Dependencies: GraphQL and SSE use `fetch`, WebSocket uses the runtime's own
 * `WebSocket` (Node 22+), and gRPC shells out to `grpcurl`. Anything missing is
 * reported SKIPPED with the command that installs it — a worker without grpcurl
 * is a configuration gap, and reporting it as FAILED would blame the customer's
 * service for our own missing binary.
 *
 * Secrets never appear in a spec. `{{NAME}}` resolves against `ctx.secrets`
 * first, so a spec committed to the customer's repo references a token by name
 * and the value only ever exists in the worker's memory. Everything that leaves
 * this plugin — steps, frames, network entries — goes through `maskDeep`.
 */

import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import {
  PROTOCOL_KINDS,
  SELF_HOSTED_EGRESS_POLICY,
  guardUrl,
  maskDeep,
  protocolTestSpecSchema,
  refusalForCaller,
  resolveEgressPolicy,
} from '@qaai/shared';
import { childEnv } from '../child-env.js';
import { resolveInsideWorkspace, runWorkspaceOf } from '../run-workspace.js';
import type {
  ConsoleEntry,
  EgressGuardIo,
  EgressGuardVerdict,
  EgressPolicy,
  ExecutableTest,
  GraphqlProtocolSpec,
  GrpcProtocolSpec,
  NetworkEntry,
  RunContext,
  RunnerPlugin,
  SseProtocolSpec,
  StepResult,
  TestExecution,
  TestResultStatus,
  WebsocketProtocolSpec,
} from '@qaai/shared';

/** Response bodies are truncated before they are stored or shown to the model. */
const BODY_SNIPPET_LIMIT = 2000;
/** One frame or event in the transcript. Sockets are chatty; whole frames are not. */
const FRAME_SNIPPET_LIMIT = 600;
/** Cap on transcript entries, so a firehose subscription cannot fill the database. */
const MAX_TRANSCRIPT_ENTRIES = 300;

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Substitutes {{var}} from the running variable bag. Unknown names are left alone. */
function interpolate(input: string, vars: Record<string, string>): string {
  return input.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => vars[name] ?? whole);
}

/**
 * Interpolates every string leaf of a structure.
 *
 * Deliberately not `JSON.parse(interpolate(JSON.stringify(v)))`: substituting
 * into already-encoded JSON corrupts the document the moment a secret contains a
 * quote or a backslash. Substituting first and encoding after cannot.
 */
function interpolateDeep(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string') return interpolate(value, vars);
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, vars));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = interpolateDeep(item, vars);
    }
    return out;
  }
  return value;
}

/** Dotted-path read with array-index support: `data.items.0.id`. */
function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node)) return node[Number(key)];
    if (typeof node === 'object') return (node as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

/**
 * An absolute URL in the spec PASSES THROUGH; a path inherits the base URL.
 *
 * THAT IS DELIBERATE AND IT STAYS. An off-base-URL endpoint is the documented
 * legitimate case for this plugin — `preflight.ts` keeps PROTOCOL out of
 * `BASE_URL_DEPENDENT_TEST_TYPES` for exactly this reason ("a gRPC or WebSocket
 * endpoint is named by the test's own spec") — so a same-origin check like the
 * one `plugins/api.ts` applies would refuse working customer tests, and this
 * function is not where the decision belongs.
 *
 * What it does mean is that `spec.endpoint` chooses an arbitrary HOST, from a
 * file in the customer's own repository, which the worker then fetches from
 * inside our network. Before {@link guardProtocolTarget} nothing classified it:
 * measured on this tree, zero occurrences of a pin, a resolve or a name-level
 * check anywhere in this file. `fetch` answered `http://169.254.169.254/`, the
 * status went into a `NetworkEntry` (a reachability oracle) and 300 characters
 * of the body came back in a step. The guard is the control; this function only
 * builds the string.
 */
function resolveUrl(baseUrl: string, path: string): string {
  return /^https?:\/\//i.test(path) ? path : new URL(path, baseUrl).toString();
}

/** `ws(s)://` passes through; a path inherits the environment's host, http→ws. */
function resolveWsUrl(baseUrl: string, path: string): string {
  if (/^wss?:\/\//i.test(path)) return path;
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

// ─── The egress guard, at every seam this plugin opens a connection from ────

/**
 * MAY THIS PLUGIN OPEN THIS URL, AND TO WHICH ADDRESS.
 *
 * The context is `PLUGIN_HTTP` and it is not a label: `EGRESS_CONTEXT_RULES`
 * describes it as "a mediated HTTP call made by plugin code, which is untrusted
 * by definition", gives it `targetsApplicationUnderTest: true` — so a
 * self-hosted install may legitimately reach its own private hosts — and
 * `allowlistApplies: true`, so an operator can name one internal host with
 * their own email against it. Naming `WEBHOOK_DELIVERY` here instead would
 * refuse every self-hosted endpoint in every deployment.
 */
export type ProtocolEgressGuard = (url: string) => Promise<EgressGuardVerdict>;

/**
 * WHAT THIS CONTROL DOES NOT DO.
 *
 * `guardUrl` hands back a PINNED ADDRESS SET, and the pin is the half that
 * turns a check into a control. The transports here are Node's GLOBAL `fetch`
 * (GraphQL, SSE) and the runtime's GLOBAL `WebSocket`, and MEASURED on Node
 * v25.6.1: `fetch(url, { agent: new http.Agent({ lookup }) })` answered 200
 * and NEVER CALLED THE LOOKUP, while `{ dispatcher: … }` threw. Neither global
 * takes a resolver, and `undici` — which has `connect: { lookup }` — is present
 * in the tree but is not a declared dependency of any workspace.
 *
 * So every address the name answers with is classified and THE PIN IS NOT
 * ENFORCED AT THE SOCKET. The residual hole is exactly one race: a record set
 * answering a public address to this guard and a private one to the transport.
 * It is named rather than papered over, the same way `REFRESH_PIN_LIMITATION`
 * names it on the auth-refresh path.
 */
export const PROTOCOL_PIN_LIMITATION =
  'The endpoint host was resolved and every address it answered with was classified, but neither ' +
  'Node’s global fetch nor its global WebSocket can be handed a resolver, so the pinned address ' +
  'set is not enforced at the socket.';

/**
 * THE POLICY A PROTOCOL ENDPOINT IS DECIDED UNDER, AND THE ONE PLACE THE
 * UNTHREADED CASE IS DECIDED.
 *
 * ── Why an absent policy is NOT read as HOSTED here, unlike everywhere else ─
 *
 * `signInWithProfile` reads an absent `egressPolicy` as HOSTED — PUBLIC ONLY —
 * and that is right for a LOGIN, because a login URL that was never classified
 * was never permitted either. It would be WRONG here, and the difference is the
 * whole of rule 13.
 *
 * `RunContext` does not carry `Environment.egressPolicy` yet (threading it is
 * one line in `packages/shared/src/types.ts` and one in the worker's run
 * processor; both are in the handover). So "absent" today means "this
 * deployment could not tell us", NOT "this deployment is hosted". Reading it as
 * HOSTED would refuse `http://localhost:4000/graphql` for EVERY self-hosted
 * install at once — a brake nobody can arm, taking away traffic that works
 * today, which is the regression this round exists to stop rather than cause.
 *
 * So the unthreaded case is {@link SELF_HOSTED_EGRESS_POLICY}, which is an
 * EXISTING named constant and not a new one, and it still bites hard:
 * `NEVER_PERMITTED_BY_DEFAULT` — link-local, multicast, unspecified and
 * unparseable — is refused in it, so 169.254.169.254 and `0177.0.0.1` are
 * refused, as are a non-http(s) scheme, userinfo in the URL and a name that
 * does not resolve. What it permits that a hosted policy would not is a
 * private, loopback or reserved address, and the decision then carries
 * {@link SELF_HOSTED_EGRESS_WARNING}, which {@link guardProtocolTarget} writes
 * into the transcript — because a check that was skipped must be NAMED rather
 * than silently not performed.
 *
 * The moment the field is threaded, a stored policy decides and a HOSTED
 * deployment narrows to public-only with no change here.
 */
export function protocolEgressPolicy(raw: unknown): EgressPolicy {
  return raw === undefined || raw === null ? SELF_HOSTED_EGRESS_POLICY : resolveEgressPolicy(raw);
}

/**
 * `Environment.egressPolicy`, as the run context carries it.
 *
 * Read STRUCTURALLY because `RunContext` does not declare the field yet — see
 * {@link protocolEgressPolicy}. The day it lands this keeps working.
 */
function egressPolicyOf(ctx: RunContext): unknown {
  return (ctx as RunContext & { readonly egressPolicy?: unknown }).egressPolicy;
}

/**
 * THE REAL GUARD, BUILT LAZILY.
 *
 * `private-address.ts` reaches for `node:dns`, so it is imported through the
 * package SUBPATH and DYNAMICALLY — the same arrangement `defaultCrawlEgressIo`
 * and `defaultHostGuardIo` use, and it means a test that injects a guard never
 * loads a resolver at all.
 */
export async function defaultProtocolEgressGuard(policy?: unknown): Promise<ProtocolEgressGuard> {
  const [addresses, dns] = await Promise.all([
    import('@qaai/shared/private-address'),
    import('node:dns'),
  ]);
  const resolved = protocolEgressPolicy(policy);
  const io: EgressGuardIo = {
    classifyHost: (host) => addresses.classifyHost(host),
    classifyAddress: (address) => addresses.classifyAddress(address),
    /*
     * EVERY address the name has, not the first — a record set mixing one
     * routable address with 169.254.169.254 is the attack written down — and
     * `verbatim: true` so the OS does not reorder and hide one.
     */
    lookup: (host) => dns.promises.lookup(host, { all: true, verbatim: true, family: 0 }),
    now: () => new Date(),
    // Monotonic, NOT the wall clock: an NTP step backwards mid-refusal would
    // make the pad negative and therefore zero, and a refusal that skipped its
    // pad is the timing oracle the floor exists to close.
    monotonicMs: () => performance.now(),
    delay: (ms) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        // Unreffed: a draining worker must not be held open by a refusal's pad.
        timer.unref?.();
      }),
  };
  return (url) => guardUrl({ url, context: 'PLUGIN_HTTP', policy: resolved, io });
}

/**
 * THE URL THE GUARD IS ASKED ABOUT, WHICH IS NOT ALWAYS THE URL WE CONNECT TO.
 *
 * `guardUrl` refuses any scheme that is not http or https, because `file:`,
 * `gopher:` and `data:` are not pages. A WebSocket URL is `ws:` or `wss:` and
 * would therefore be refused as SCHEME_NOT_PERMITTED — which would break every
 * WebSocket test in the product and would be a refusal for the wrong reason.
 *
 * But a `ws://` URL STILL RESOLVES A HOST and still opens a TCP connection to
 * it: `ws://169.254.169.254/` reaches the cloud metadata service exactly as
 * `http://169.254.169.254/` does, and the WebSocket handshake is an HTTP
 * Upgrade over the same port. So the scheme is mapped to the one the guard
 * reads — `ws:`→`http:`, `wss:`→`https:` — and the host, the port and the
 * userinfo, which is all this guard looks at, are untouched. Anything else
 * (`file:`, a relative string that somehow survived) is handed over AS IT IS,
 * so the guard refuses it rather than this function guessing.
 */
function egressUrlFor(url: string): string {
  if (/^ws:\/\//i.test(url)) return `http://${url.slice('ws://'.length)}`;
  if (/^wss:\/\//i.test(url)) return `https://${url.slice('wss://'.length)}`;
  return url;
}

/**
 * ASK THE GUARD, AND RECORD WHAT IT ANSWERED.
 *
 * ── The refusal is ONE SENTENCE, and the reason is this plugin specifically ─
 *
 * {@link refusalForCaller} returns {@link EGRESS_REFUSAL_SENTENCE} for all
 * seventeen refusals. The step list of a run is read by whoever wrote the spec,
 * and the spec's `endpoint` is the thing being refused — so a message that
 * distinguished "that is a link-local address" from "that host did not resolve"
 * from "that host is not on the allowlist" would turn a PROTOCOL test into a
 * port scanner for OUR network with a readable report, which is what
 * `NetworkEntry.status` and the 300-character body snippet already half were.
 * `verdict.operatorDetail` holds the class, the address and the refusal code,
 * and it is deliberately NOT recorded here.
 *
 * ── The SELF_HOSTED warning is written down rather than skipped silently ────
 *
 * A guard that passes silently in the one mode where it does nothing is
 * indistinguishable from a guard that ran. So when the decision permitted a
 * non-public target under a self-hosted class list, the sentence saying so goes
 * into the transcript. It names no address and no class, so it is safe where
 * the refusal sentence is safe.
 */
async function guardProtocolTarget(
  guard: ProtocolEgressGuard,
  recorder: StepRecorder,
  url: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly sentence: string }> {
  const verdict = await guard(egressUrlFor(url));
  if (!verdict.ok) return { ok: false, sentence: refusalForCaller(verdict).sentence };

  if (verdict.permit.decision.warning !== null) {
    recorder.log('•', verdict.permit.decision.warning);
  }
  if (verdict.permit.kind === 'OBSERVED') {
    /*
     * The brake let this through and it must be VISIBLE, not merely counted
     * somewhere an operator has to go looking. A mode that nobody can see the
     * effect of is an off switch with a reassuring name.
     */
    recorder.log(
      '•',
      'This connection would have been refused by the egress policy; the policy is in OBSERVE ' +
        'mode, so it was allowed and counted.',
    );
  }
  return { ok: true };
}

/**
 * A target this plugin will not open. Never a FAILED test and never a PASSED
 * one.
 *
 * SKIPPED for the same reason {@link skippedForMissingTool} is: the customer's
 * service was not evaluated, so calling it FAILED blames their code for our
 * refusal. And emphatically not PASSED — a refused endpoint reported as a pass
 * is "a pass that means we did not check", which is the lie this product cannot
 * afford, and on this surface it would mean an unreachable service looking
 * tested.
 */
function refusedByEgress(
  test: ExecutableTest,
  startedAt: number,
  recorder: StepRecorder,
  secrets: Readonly<Record<string, string>>,
  sentence: string,
): TestExecution {
  recorder.skip('Open the endpoint', sentence);
  return finish(test, startedAt, recorder, [], secrets, {
    status: 'SKIPPED',
    errorMessage: sentence,
  });
}

/** Structural equality good enough for assertion literals, as in the API plugin. */
function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (+${text.length - limit} more chars)`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function headerBag(
  source: Record<string, string>,
  vars: Record<string, string>,
  defaults: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = { ...defaults };
  for (const [key, value] of Object.entries(source)) out[key] = interpolate(value, vars);
  return out;
}

/**
 * Guard: a spec-supplied path must stay inside the run workspace.
 *
 * Delegates to the one shared guard (`resolveInsideWorkspace`) rather than
 * repeating its logic — that version also refuses Windows separators and drive
 * letters, which this one did not. Still THROWS, because the gRPC caller below
 * turns the throw into a FAILED step naming the path, which is the right
 * verdict: a proto path that leaves the repository is a broken spec, not an
 * environment gap.
 *
 * The root is checked too: `resolve('')` is `process.cwd()`, so an empty or
 * relative workspace root would silently resolve back into QAAI's own checkout,
 * which is the defect this whole change removes.
 */
function safeWorkspacePath(workspace: string, relPath: string): string {
  const full =
    workspace && isAbsolute(workspace) ? resolveInsideWorkspace(workspace, relPath) : null;
  if (full === null) throw new Error(`"${relPath}" is not a path inside the repository`);
  return full;
}

/** An unconditional pause that still gives up when the run is cancelled. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((done) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      done();
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      done();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wakes a single waiting assertion when data arrives, a deadline passes, or the
 * stream ends — whichever lands first — and always clears its own timer. A
 * `setTimeout` left behind by every assertion in a long subscription test keeps
 * the worker's event loop alive well past the run.
 *
 * Single-consumer by construction: steps run in sequence, so there is never more
 * than one assertion waiting on a connection.
 */
interface Gate {
  /** Called by the producer whenever new data (or an end-of-stream) arrives. */
  notify(): void;
  wait(ms: number): Promise<void>;
}

function createGate(): Gate {
  let pending: (() => void) | null = null;
  return {
    notify() {
      const fire = pending;
      pending = null;
      if (fire) fire();
    },
    wait(ms: number) {
      return new Promise<void>((done) => {
        let timer: ReturnType<typeof setTimeout>;
        const fire = () => {
          clearTimeout(timer);
          if (pending === fire) pending = null;
          done();
        };
        timer = setTimeout(fire, ms);
        pending = fire;
      });
    },
  };
}

// ─── Step recording ──────────────────────────────────────────────────────────

/**
 * Accumulates steps and the message transcript.
 *
 * `broken` is what stops a driver: once a step fails, the connection's state is
 * unreliable and every later assertion would be measuring our own confusion, so
 * the remaining steps are recorded SKIPPED rather than run.
 */
class StepRecorder {
  readonly steps: StepResult[] = [];
  readonly transcript: ConsoleEntry[] = [];
  private failedAlready = false;

  constructor(
    private readonly ctx: RunContext,
    private readonly testId: string,
  ) {}

  get broken(): boolean {
    return this.failedAlready;
  }

  record(
    title: string,
    startedAtMs: number,
    problems: string[],
    detail: { expected?: string | null; actual?: string | null } = {},
  ): void {
    const failed = problems.length > 0;
    if (failed) this.failedAlready = true;
    const index = this.steps.length;
    this.ctx.logger.step({
      testId: this.testId,
      index,
      title,
      status: failed ? 'FAILED' : 'PASSED',
    });
    this.steps.push({
      index,
      title,
      status: failed ? 'FAILED' : 'PASSED',
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: Math.max(0, Date.now() - startedAtMs),
      screenshotKey: null,
      error: failed
        ? {
            message: problems.join('; '),
            stack: null,
            selector: null,
            expected: detail.expected ?? null,
            actual: detail.actual ?? null,
          }
        : null,
    });
  }

  /**
   * A step that could not be evaluated — a schema the server will not disclose,
   * a step after a failure. The reason rides in the title because `error` on a
   * StepResult means "this failed", and none of these did.
   */
  skip(title: string, reason?: string): void {
    const index = this.steps.length;
    this.ctx.logger.step({ testId: this.testId, index, title, status: 'SKIPPED' });
    this.steps.push({
      index,
      title: reason ? `${title} — ${reason}` : title,
      status: 'SKIPPED',
      startedAt: new Date().toISOString(),
      durationMs: 0,
      screenshotKey: null,
      error: null,
    });
  }

  /** `↑` sent, `↓` received, `•` connection lifecycle. */
  log(direction: '↑' | '↓' | '•', text: string): void {
    if (this.transcript.length >= MAX_TRANSCRIPT_ENTRIES) return;
    this.transcript.push({
      level: 'log',
      text: `${direction} ${truncate(text, FRAME_SNIPPET_LIMIT)}`,
      at: new Date().toISOString(),
    });
  }
}

function finish(
  test: ExecutableTest,
  startedAt: number,
  recorder: StepRecorder,
  network: NetworkEntry[],
  secrets: Readonly<Record<string, string>>,
  override?: { status?: TestResultStatus; errorMessage?: string },
): TestExecution {
  const secretValues = Object.values(secrets);
  // Masked here rather than at write time: frames, URLs and headers routinely
  // carry tokens that were interpolated in from the vault.
  const steps = maskDeep(recorder.steps, secretValues);
  const firstFailure = steps.find((step) => step.status === 'FAILED');
  const ran = steps.some((step) => step.status !== 'SKIPPED');

  return {
    testId: test.id,
    status: override?.status ?? (firstFailure ? 'FAILED' : ran ? 'PASSED' : 'SKIPPED'),
    durationMs: Date.now() - startedAt,
    steps,
    network: maskDeep(network, secretValues),
    console: maskDeep(recorder.transcript, secretValues),
    videoKey: null,
    traceKey: null,
    errorMessage: override?.errorMessage ?? firstFailure?.error?.message ?? null,
    retriedAndPassed: false,
    findings: [],
  };
}

/** A dependency the worker does not have. Never a FAILED test. */
function skippedForMissingTool(
  test: ExecutableTest,
  startedAt: number,
  recorder: StepRecorder,
  secrets: Readonly<Record<string, string>>,
  message: string,
): TestExecution {
  return finish(test, startedAt, recorder, [], secrets, {
    status: 'SKIPPED',
    errorMessage: message,
  });
}

// ─── GraphQL ─────────────────────────────────────────────────────────────────

type OperationKind = 'query' | 'mutation' | 'subscription';

interface SchemaRootFields {
  query: Set<string>;
  mutation: Set<string>;
  subscription: Set<string>;
}

const INTROSPECTION_QUERY = `query QaaiIntrospection {
  __schema {
    queryType { name fields { name } }
    mutationType { name fields { name } }
    subscriptionType { name fields { name } }
  }
}`;

/** Removes `#` comments without touching `#` inside a string or block string. */
function stripGraphqlComments(document: string): string {
  let out = '';
  let inString = false;
  let inBlockString = false;

  for (let i = 0; i < document.length; i += 1) {
    const char = document[i];
    if (char === undefined) break;

    if (inBlockString) {
      if (document.startsWith('"""', i)) {
        out += '"""';
        i += 2;
        inBlockString = false;
      } else {
        out += char;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === '\\') {
        const next = document[i + 1];
        if (next !== undefined) {
          out += next;
          i += 1;
        }
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (document.startsWith('"""', i)) {
      out += '"""';
      i += 2;
      inBlockString = true;
      continue;
    }
    if (char === '"') {
      out += char;
      inString = true;
      continue;
    }
    if (char === '#') {
      while (i < document.length && document[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += char;
  }
  return out;
}

/** Index of the delimiter closing the one at `start`, or -1. String-aware. */
function matchDelimiter(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  let inBlockString = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (char === undefined) break;

    if (inBlockString) {
      if (text.startsWith('"""', i)) {
        i += 2;
        inBlockString = false;
      }
      continue;
    }
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (text.startsWith('"""', i)) {
      i += 2;
      inBlockString = true;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Field names at the top level of a selection set.
 *
 * Returns null — meaning "do not validate" — for anything it cannot read with
 * certainty, including a fragment spread at the root. A heuristic that failed a
 * perfectly good operation would be worse than no check at all, so every
 * ambiguity resolves to silence rather than to a verdict.
 */
function topLevelFields(body: string): string[] | null {
  const fields: string[] = [];
  let i = 0;

  while (i < body.length) {
    const char = body[i];
    if (char === undefined) break;
    if (/[\s,]/.test(char)) {
      i += 1;
      continue;
    }
    // A root fragment spread can contribute fields we cannot resolve from here.
    if (body.startsWith('...', i)) return null;
    if (char === '@') {
      i += 1;
      i += /^[A-Za-z_]\w*/.exec(body.slice(i))?.[0].length ?? 0;
      continue;
    }
    if (char === '(') {
      const close = matchDelimiter(body, i, '(', ')');
      if (close < 0) return null;
      i = close + 1;
      continue;
    }
    if (char === '{') {
      const close = matchDelimiter(body, i, '{', '}');
      if (close < 0) return null;
      i = close + 1;
      continue;
    }
    const word = /^[A-Za-z_]\w*/.exec(body.slice(i))?.[0];
    if (!word) return null;
    i += word.length;

    // `alias: field` — the word we just read was the alias, not the field.
    let after = i;
    while (after < body.length && /\s/.test(body[after] ?? '')) after += 1;
    if (body[after] === ':') {
      i = after + 1;
      continue;
    }
    fields.push(word);
  }
  return fields;
}

/** The operation a request will actually execute, or null when unreadable. */
function rootSelection(
  document: string,
  operationName?: string,
): { kind: OperationKind; fields: string[] } | null {
  const text = stripGraphqlComments(document);
  const operations: Array<{ kind: OperationKind; name: string | null; open: number; close: number }> =
    [];
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    if (char === undefined) break;
    if (/[\s,]/.test(char)) {
      i += 1;
      continue;
    }
    // `{ ... }` with no keyword is anonymous query shorthand.
    if (char === '{') {
      const close = matchDelimiter(text, i, '{', '}');
      if (close < 0) return null;
      operations.push({ kind: 'query', name: null, open: i, close });
      i = close + 1;
      continue;
    }

    const word = /^[A-Za-z_]\w*/.exec(text.slice(i))?.[0];
    if (!word) return null;
    i += word.length;

    if (word === 'fragment') {
      const brace = text.indexOf('{', i);
      if (brace < 0) return null;
      const close = matchDelimiter(text, brace, '{', '}');
      if (close < 0) return null;
      i = close + 1;
      continue;
    }
    if (word !== 'query' && word !== 'mutation' && word !== 'subscription') return null;

    const named = /^\s*([A-Za-z_]\w*)?/.exec(text.slice(i));
    const name = named?.[1] ?? null;
    i += named?.[0].length ?? 0;

    // Variable definitions and directives may contain object literals, so their
    // braces must not be mistaken for the operation's selection set.
    for (;;) {
      const paren = text.indexOf('(', i);
      const brace = text.indexOf('{', i);
      if (paren >= 0 && (brace < 0 || paren < brace)) {
        const close = matchDelimiter(text, paren, '(', ')');
        if (close < 0) return null;
        i = close + 1;
        continue;
      }
      break;
    }

    const brace = text.indexOf('{', i);
    if (brace < 0) return null;
    const close = matchDelimiter(text, brace, '{', '}');
    if (close < 0) return null;
    operations.push({ kind: word, name, open: brace, close });
    i = close + 1;
  }

  const chosen = operationName
    ? operations.find((op) => op.name === operationName)
    : operations.length === 1
      ? operations[0]
      : undefined;
  if (!chosen) return null;

  const fields = topLevelFields(text.slice(chosen.open + 1, chosen.close));
  return fields ? { kind: chosen.kind, fields } : null;
}

function parseIntrospection(payload: unknown): SchemaRootFields | null {
  const schema = readPath(payload, 'data.__schema');
  if (schema === null || typeof schema !== 'object') return null;

  const names = (key: string): Set<string> => {
    const fields = readPath(schema, `${key}.fields`);
    if (!Array.isArray(fields)) return new Set();
    return new Set(
      fields
        .map((field) => (field as { name?: unknown } | null)?.name)
        .filter((name): name is string => typeof name === 'string'),
    );
  };

  return {
    query: names('queryType'),
    mutation: names('mutationType'),
    subscription: names('subscriptionType'),
  };
}

async function runGraphql(
  ctx: RunContext,
  test: ExecutableTest,
  spec: GraphqlProtocolSpec,
  startedAt: number,
  egress: ProtocolEgressGuard,
): Promise<TestExecution> {
  const vars: Record<string, string> = { ...ctx.secrets, ...spec.variables };
  const endpoint = resolveUrl(ctx.baseUrl, interpolate(spec.endpoint, vars));
  const headers = headerBag(spec.headers, vars, {
    'content-type': 'application/json',
    accept: 'application/json',
  });
  const recorder = new StepRecorder(ctx, test.id);
  const network: NetworkEntry[] = [];

  /*
   * BEFORE THE FIRST REQUEST, AND BEFORE THE INTROSPECTION ONE.
   *
   * `spec.endpoint` may be an absolute URL — that is the documented legitimate
   * case — so it chooses the host, from a file in the customer's repository,
   * and the introspection POST below is the FIRST thing that would reach it.
   * Interpolated headers carry vault secrets, so a refusal after this point
   * would already have sent them.
   */
  const allowed = await guardProtocolTarget(egress, recorder, endpoint);
  if (!allowed.ok) {
    return refusedByEgress(test, startedAt, recorder, ctx.secrets, allowed.sentence);
  }

  const post = async (
    body: string,
  ): Promise<{ status: number | null; text: string; durationMs: number; error: string | null }> => {
    const began = Date.now();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(spec.timeoutMs)]),
        redirect: 'manual',
      });
      const text = await response.text();
      return { status: response.status, text, durationMs: Date.now() - began, error: null };
    } catch (err) {
      return { status: null, text: '', durationMs: Date.now() - began, error: errorText(err) };
    }
  };

  let schema: SchemaRootFields | null = null;
  if (spec.introspect) {
    const began = Date.now();
    const result = await post(JSON.stringify({ query: INTROSPECTION_QUERY }));
    network.push({
      method: 'POST',
      url: endpoint,
      status: result.status,
      durationMs: result.durationMs,
      responseBodySnippet: null,
    });
    try {
      schema = result.error ? null : parseIntrospection(JSON.parse(result.text));
    } catch {
      schema = null;
    }
    if (schema) {
      recorder.record(
        `Introspect schema — ${schema.query.size} query, ${schema.mutation.size} mutation, ${schema.subscription.size} subscription fields`,
        began,
        [],
      );
    } else {
      // Introspection is switched off in most production deployments. That is a
      // hardening decision, not a broken operation, so it must not fail a test.
      recorder.skip(
        'Introspect schema',
        `not available at ${endpoint}; operations were sent without schema validation`,
      );
    }
  }

  for (const operation of spec.operations) {
    if (ctx.signal.aborted || recorder.broken) {
      recorder.skip(`${operation.name}`);
      continue;
    }

    if (schema) {
      const began = Date.now();
      const selection = rootSelection(operation.query, operation.operationName);
      if (!selection) {
        recorder.skip(
          `Validate "${operation.name}" against schema`,
          'the document uses a construct this check does not read (root fragment spread, or several unnamed operations)',
        );
      } else {
        const available = schema[selection.kind];
        const missing = selection.fields.filter((field) => !available.has(field));
        recorder.record(
          `Validate "${operation.name}" against schema`,
          began,
          missing.length === 0
            ? []
            : [
                `The schema's ${selection.kind} type exposes no field named ${missing.map((f) => `"${f}"`).join(', ')}`,
              ],
          {
            expected: missing.length ? `${selection.kind} fields on the schema` : null,
            actual: missing.length ? missing.join(', ') : null,
          },
        );
        // The operation was never sent, so it still needs a step of its own —
        // otherwise the cockpit shows a failed validation followed by silence.
        if (recorder.broken) {
          recorder.skip(`${operation.name} (GraphQL)`, 'not sent, the schema check failed');
          continue;
        }
      }
    }

    const began = Date.now();
    const requestBody = JSON.stringify({
      query: interpolate(operation.query, vars),
      variables: interpolateDeep(operation.variables, vars),
      ...(operation.operationName ? { operationName: operation.operationName } : {}),
    });
    recorder.log('↑', `${operation.name}: ${requestBody}`);

    const result = await post(requestBody);
    recorder.log('↓', `${operation.name}: ${result.text}`);

    const assertions = operation.assertions;
    const problems: string[] = [];
    let expected: string | null = null;
    let actual: string | null = null;

    if (result.error) {
      problems.push(`Request failed: ${result.error}`);
    } else {
      let payload: unknown;
      try {
        payload = JSON.parse(result.text);
      } catch {
        payload = undefined;
        problems.push(
          `Response was not valid JSON (HTTP ${result.status}): ${truncate(result.text, 300)}`,
        );
      }

      if (payload !== undefined) {
        const envelope = (payload ?? {}) as Record<string, unknown>;
        const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
        const data = envelope.data;
        const messages = errors
          .map((entry) => String((entry as { message?: unknown } | null)?.message ?? entry))
          .join(' | ');

        // NOTE: there is deliberately no HTTP status assertion here. A GraphQL
        // server answers a failed resolver with HTTP 200 and an `errors` array,
        // so `status === 200` passes on exactly the responses a test exists to
        // catch. The `errors` array is the status code for this protocol.
        const wantsErrors = assertions.expectErrors || assertions.errorMessageContains !== undefined;

        if (!wantsErrors && errors.length > 0) {
          problems.push(
            `GraphQL returned ${errors.length} error(s) with HTTP ${result.status}: ${truncate(messages, 500)}`,
          );
          expected = 'no errors';
          actual = truncate(messages, 500);
        }
        if (wantsErrors && errors.length === 0) {
          problems.push(`Expected the operation to return errors, but "errors" was empty`);
          expected ??= 'a non-empty errors array';
          actual ??= 'no errors';
        }
        if (
          assertions.errorMessageContains !== undefined &&
          !messages.includes(assertions.errorMessageContains)
        ) {
          problems.push(
            `No GraphQL error message contains ${JSON.stringify(assertions.errorMessageContains)}`,
          );
        }
        if (errors.length === 0 && !('data' in envelope)) {
          problems.push('Response carried neither "data" nor "errors"');
        }
        if (assertions.maxLatencyMs !== undefined && result.durationMs > assertions.maxLatencyMs) {
          problems.push(`Took ${result.durationMs}ms, budget is ${assertions.maxLatencyMs}ms`);
        }
        if (
          assertions.dataContains !== undefined &&
          !JSON.stringify(data ?? null).includes(assertions.dataContains)
        ) {
          problems.push(`"data" does not contain ${JSON.stringify(assertions.dataContains)}`);
        }
        for (const [path, want] of Object.entries(assertions.dataMatches ?? {})) {
          const got = readPath(data, path);
          if (!jsonEq(got, want)) {
            problems.push(
              `data at "${path}" was ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
            );
            expected ??= JSON.stringify(want);
            actual ??= JSON.stringify(got);
          }
        }
        for (const [name, path] of Object.entries(operation.extract)) {
          const got = readPath(data, path);
          if (got === undefined) problems.push(`Could not extract "${name}" from data."${path}"`);
          else vars[name] = typeof got === 'string' ? got : JSON.stringify(got);
        }
      }
    }

    network.push({
      method: 'POST',
      url: endpoint,
      status: result.status,
      durationMs: result.durationMs,
      responseBodySnippet: problems.length > 0 ? result.text.slice(0, BODY_SNIPPET_LIMIT) : null,
    });

    recorder.record(`${operation.name} (GraphQL)`, began, problems, { expected, actual });
  }

  return finish(test, startedAt, recorder, network, ctx.secrets);
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

/** Node's built-in WebSocket takes custom headers as an undici extension. */
type WebSocketInit = { protocols?: string[]; headers?: Record<string, string> };

interface FramePredicate {
  contains?: string;
  regex: RegExp | null;
  jsonMatches?: Record<string, unknown>;
}

function frameMatches(text: string, predicate: FramePredicate): boolean {
  if (predicate.contains !== undefined && !text.includes(predicate.contains)) return false;
  if (predicate.regex && !predicate.regex.test(text)) return false;
  if (predicate.jsonMatches) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return false;
    }
    for (const [path, want] of Object.entries(predicate.jsonMatches)) {
      if (!jsonEq(readPath(parsed, path), want)) return false;
    }
  }
  return true;
}

function describePredicate(predicate: FramePredicate): string {
  const parts: string[] = [];
  if (predicate.contains !== undefined) parts.push(`contains ${JSON.stringify(predicate.contains)}`);
  if (predicate.regex) parts.push(`matches /${predicate.regex.source}/`);
  if (predicate.jsonMatches) {
    for (const [path, want] of Object.entries(predicate.jsonMatches)) {
      parts.push(`${path} = ${JSON.stringify(want)}`);
    }
  }
  return parts.length > 0 ? parts.join(' and ') : 'any message';
}

async function runWebSocket(
  ctx: RunContext,
  test: ExecutableTest,
  spec: WebsocketProtocolSpec,
  startedAt: number,
  egress: ProtocolEgressGuard,
): Promise<TestExecution> {
  const vars: Record<string, string> = { ...ctx.secrets, ...spec.variables };
  const recorder = new StepRecorder(ctx, test.id);
  const network: NetworkEntry[] = [];

  if (typeof globalThis.WebSocket !== 'function') {
    return skippedForMissingTool(
      test,
      startedAt,
      recorder,
      ctx.secrets,
      'This worker has no global WebSocket. Run the worker on Node 22 or newer (nvm install 22) — the test itself was not evaluated.',
    );
  }

  let url: string;
  try {
    url = resolveWsUrl(ctx.baseUrl, interpolate(spec.url, vars));
  } catch (err) {
    recorder.record('Connect', Date.now(), [`Could not build a WebSocket URL: ${errorText(err)}`]);
    return finish(test, startedAt, recorder, network, ctx.secrets);
  }

  /*
   * GATED BEFORE THE SOCKET IS CONSTRUCTED. `new WebSocket(url)` connects
   * immediately — there is no later seam — and `headerBag` above has already
   * interpolated vault secrets into the handshake headers, so a refusal after
   * this point would have sent them. `ws://` is mapped to `http://` for the
   * guard by `egressUrlFor`, because a ws URL resolves a host exactly like an
   * http one and the guard reads only the host, the port and the userinfo.
   */
  const allowed = await guardProtocolTarget(egress, recorder, url);
  if (!allowed.ok) {
    return refusedByEgress(test, startedAt, recorder, ctx.secrets, allowed.sentence);
  }

  const frames: string[] = [];
  let cursor = 0;
  let closedReason: string | null = null;
  const gate = createGate();

  const SocketCtor = globalThis.WebSocket as unknown as new (
    url: string,
    init?: WebSocketInit,
  ) => WebSocket;
  const socket = new SocketCtor(url, {
    protocols: spec.subprotocols,
    headers: headerBag(spec.headers, vars),
  });
  socket.binaryType = 'arraybuffer';

  const decoder = new TextDecoder();
  socket.addEventListener('message', (event) => {
    const data: unknown = (event as MessageEvent).data;
    const text =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? decoder.decode(new Uint8Array(data))
          : String(data);
    frames.push(text);
    recorder.log('↓', text);
    gate.notify();
  });
  socket.addEventListener('close', (event) => {
    const closeEvent = event as CloseEvent;
    closedReason ??= `code ${closeEvent.code}${closeEvent.reason ? ` — ${closeEvent.reason}` : ''}`;
    recorder.log('•', `closed (${closedReason})`);
    gate.notify();
  });
  socket.addEventListener('error', (event) => {
    // `||`, not `??`: undici's ErrorEvent carries an EMPTY message rather than
    // an absent one, and an empty reason reads as "no problem" downstream.
    closedReason ??= (event as unknown as { message?: string }).message || 'connection error';
    gate.notify();
  });

  const connectBegan = Date.now();
  const openProblem = await new Promise<string | null>((done) => {
    const timer = setTimeout(
      () => done(`did not open within ${spec.openTimeoutMs}ms`),
      spec.openTimeoutMs,
    );
    const settle = (reason: string | null) => {
      clearTimeout(timer);
      done(reason);
    };
    socket.addEventListener('open', () => settle(null), { once: true });
    socket.addEventListener('error', () => settle(closedReason || 'connection error'), {
      once: true,
    });
    socket.addEventListener(
      'close',
      (event) => settle(`closed before opening (code ${(event as CloseEvent).code})`),
      { once: true },
    );
    ctx.signal.addEventListener('abort', () => settle('the run was cancelled'), { once: true });
  });

  const connectDuration = Date.now() - connectBegan;
  network.push({
    method: 'WS',
    url,
    // 101 Switching Protocols is what a successful upgrade actually returns.
    status: openProblem === null ? 101 : null,
    durationMs: connectDuration,
    responseBodySnippet: openProblem,
  });
  recorder.record(
    `Connect to ${url}`,
    connectBegan,
    openProblem === null ? [] : [`WebSocket ${openProblem}`],
  );
  if (openProblem !== null) {
    try {
      socket.close();
    } catch {
      /* the socket never opened; nothing to close */
    }
    return finish(test, startedAt, recorder, network, ctx.secrets);
  }
  recorder.log('•', `connected to ${url}`);

  try {
    for (const step of spec.steps) {
      if (ctx.signal.aborted || recorder.broken) {
        recorder.skip(step.name);
        continue;
      }
      const began = Date.now();

      if (step.action === 'WAIT') {
        // Deliberately NOT the gate: a WAIT means "give the server this long",
        // and an unrelated heartbeat waking it early makes the script racy.
        await sleep(step.ms, ctx.signal);
        recorder.record(`Wait ${step.ms}ms — ${step.name}`, began, []);
        continue;
      }

      if (step.action === 'CLOSE') {
        socket.close(step.code);
        recorder.record(`Close (${step.code}) — ${step.name}`, began, []);
        continue;
      }

      if (step.action === 'SEND') {
        const payload =
          typeof step.payload === 'string'
            ? interpolate(step.payload, vars)
            : JSON.stringify(interpolateDeep(step.payload ?? null, vars));
        if (socket.readyState !== 1) {
          recorder.record(`Send — ${step.name}`, began, [
            `Socket is not open (${closedReason || `readyState ${socket.readyState}`}), so nothing was sent`,
          ]);
          continue;
        }
        socket.send(payload);
        recorder.log('↑', payload);
        recorder.record(`Send — ${step.name}`, began, []);
        continue;
      }

      // EXPECT.
      let regex: RegExp | null = null;
      if (step.matchesRegex !== undefined) {
        try {
          regex = new RegExp(step.matchesRegex);
        } catch (err) {
          recorder.record(`Expect — ${step.name}`, began, [
            `matchesRegex is not a valid regular expression: ${errorText(err)}`,
          ]);
          continue;
        }
      }
      const predicate: FramePredicate = {
        ...(step.contains !== undefined ? { contains: step.contains } : {}),
        regex,
        ...(step.jsonMatches ? { jsonMatches: step.jsonMatches } : {}),
      };

      const deadline = Date.now() + step.timeoutMs;
      const passedOver: string[] = [];
      let matched: string | null = null;
      let problem: string | null = null;

      for (;;) {
        while (cursor < frames.length) {
          const frame = frames[cursor];
          cursor += 1;
          if (frame === undefined) continue;
          // NEXT asserts on the very next frame; MATCH scans past the
          // heartbeats and unrelated subscription traffic in between.
          if (step.mode === 'NEXT' || frameMatches(frame, predicate)) {
            matched = frame;
            break;
          }
          passedOver.push(frame);
        }
        if (matched !== null) break;
        if (closedReason !== null) {
          problem = `Socket closed while waiting (${closedReason})`;
          break;
        }
        if (ctx.signal.aborted) {
          problem = 'The run was cancelled while waiting for a message';
          break;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          problem =
            step.mode === 'NEXT'
              ? `No message arrived within ${step.timeoutMs}ms`
              : `No message matching the predicate arrived within ${step.timeoutMs}ms`;
          break;
        }
        await gate.wait(remaining);
      }

      const problems: string[] = [];
      if (problem) {
        problems.push(problem);
      } else if (matched !== null) {
        if (step.mode === 'NEXT' && !frameMatches(matched, predicate)) {
          problems.push('The next message did not match');
        }
        if (problems.length === 0) {
          for (const [name, path] of Object.entries(step.extract)) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(matched);
            } catch {
              problems.push(`Cannot extract "${name}": the message is not JSON`);
              break;
            }
            const got = readPath(parsed, path);
            if (got === undefined) problems.push(`Could not extract "${name}" from "${path}"`);
            else vars[name] = typeof got === 'string' ? got : JSON.stringify(got);
          }
        }
      }

      recorder.record(`Expect — ${step.name}`, began, problems, {
        expected: problems.length > 0 ? describePredicate(predicate) : null,
        actual:
          problems.length === 0
            ? null
            : matched !== null
              ? truncate(matched, FRAME_SNIPPET_LIMIT)
              : passedOver.length > 0
                ? `saw ${passedOver.length} other message(s): ${truncate(passedOver.join(' | '), FRAME_SNIPPET_LIMIT)}`
                : 'no messages were received',
      });
    }
  } finally {
    // readyState 0 CONNECTING, 1 OPEN — anything else is already going away.
    if (socket.readyState === 0 || socket.readyState === 1) {
      try {
        socket.close(1000);
      } catch {
        /* closing a socket that is already gone is not an error worth losing the run over */
      }
    }
  }

  return finish(test, startedAt, recorder, network, ctx.secrets);
}

// ─── Server-sent events ──────────────────────────────────────────────────────

interface SseEvent {
  event: string;
  data: string;
  id: string | null;
}

/** Matches the blank line that terminates an SSE record, in any line ending. */
const SSE_RECORD_BOUNDARY = /\r\n\r\n|\n\n|\r\r/;

/**
 * Parses one SSE record.
 *
 * One deviation from the WHATWG algorithm, on purpose: a record carrying only an
 * `event:` name and no `data:` is dispatched here, where a browser would drop
 * it. Servers do send bare `event: ping` keepalives, and a test that wants to
 * assert one arrived should be able to.
 */
function parseSseRecord(record: string): SseEvent | null {
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

function sseMatches(event: SseEvent, expectation: SseProtocolSpec['expect'][number]): boolean {
  if (expectation.event !== undefined && event.event !== expectation.event) return false;
  if (expectation.dataContains !== undefined && !event.data.includes(expectation.dataContains)) {
    return false;
  }
  if (expectation.jsonMatches) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return false;
    }
    for (const [path, want] of Object.entries(expectation.jsonMatches)) {
      if (!jsonEq(readPath(parsed, path), want)) return false;
    }
  }
  return true;
}

async function runSse(
  ctx: RunContext,
  test: ExecutableTest,
  spec: SseProtocolSpec,
  startedAt: number,
  egress: ProtocolEgressGuard,
): Promise<TestExecution> {
  const vars: Record<string, string> = { ...ctx.secrets, ...spec.variables };
  const recorder = new StepRecorder(ctx, test.id);
  const network: NetworkEntry[] = [];
  const url = resolveUrl(ctx.baseUrl, interpolate(spec.path, vars));
  const headers = headerBag(spec.headers, vars, {
    accept: 'text/event-stream',
    'cache-control': 'no-cache',
  });

  // `spec.path` takes an absolute URL exactly as `spec.endpoint` does, so this
  // is the same door and it is gated before the stream is opened.
  const allowed = await guardProtocolTarget(egress, recorder, url);
  if (!allowed.ok) {
    return refusedByEgress(test, startedAt, recorder, ctx.secrets, allowed.sentence);
  }

  const controller = new AbortController();
  const onRunAbort = () => controller.abort();
  ctx.signal.addEventListener('abort', onRunAbort, { once: true });

  const connectBegan = Date.now();
  // The connect deadline aborts the request; it must not also cap the stream,
  // which is expected to stay open for the whole test.
  const connectTimer = setTimeout(() => controller.abort(), spec.connectTimeoutMs);

  let response: Response | null = null;
  let transportError: string | null = null;
  try {
    let body: string | undefined;
    if (spec.body !== undefined) {
      const interpolated = interpolateDeep(spec.body, vars);
      body = typeof interpolated === 'string' ? interpolated : JSON.stringify(interpolated);
      headers['content-type'] ??= 'application/json';
    }
    response = await fetch(url, {
      method: spec.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
      redirect: 'manual',
    });
  } catch (err) {
    transportError = ctx.signal.aborted
      ? 'the run was cancelled'
      : controller.signal.aborted
        ? `did not respond within ${spec.connectTimeoutMs}ms`
        : errorText(err);
  } finally {
    clearTimeout(connectTimer);
  }

  const contentType = response?.headers.get('content-type') ?? '';
  network.push({
    method: spec.method,
    url,
    status: response?.status ?? null,
    durationMs: Date.now() - connectBegan,
    responseBodySnippet: transportError,
  });

  const connectProblems: string[] = [];
  if (transportError) connectProblems.push(`Could not open the stream: ${transportError}`);
  else if (response && !response.ok) {
    connectProblems.push(`Stream returned HTTP ${response.status}`);
  } else if (!response?.body) {
    connectProblems.push('The response had no body to read');
  }

  // A wrong content-type is reported, not failed: proxies rewrite it, and the
  // events themselves are the thing under test.
  recorder.record(
    `Open ${spec.method} ${url}${contentType ? ` (${contentType})` : ''}`,
    connectBegan,
    connectProblems,
  );
  if (connectProblems.length > 0 || !response?.body) {
    ctx.signal.removeEventListener('abort', onRunAbort);
    controller.abort();
    for (const expectation of spec.expect) recorder.skip(expectation.name);
    return finish(test, startedAt, recorder, network, ctx.secrets);
  }

  const events: SseEvent[] = [];
  let streamEnded: string | null = null;
  const gate = createGate();
  const reader = response.body.getReader();

  const pump = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          streamEnded = 'the server closed the stream';
          gate.notify();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const boundary = SSE_RECORD_BOUNDARY.exec(buffer);
          if (!boundary) break;
          const record = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const parsed = parseSseRecord(record);
          if (parsed) {
            events.push(parsed);
            recorder.log('↓', `${parsed.event || '(unnamed)'}: ${parsed.data}`);
          }
        }
        gate.notify();
      }
    } catch (err) {
      streamEnded = ctx.signal.aborted ? 'the run was cancelled' : errorText(err);
      gate.notify();
    }
  })();

  let cursor = 0;
  try {
    for (const expectation of spec.expect) {
      if (ctx.signal.aborted || recorder.broken) {
        recorder.skip(expectation.name);
        continue;
      }
      const began = Date.now();
      const deadline = began + expectation.timeoutMs;
      const matches: SseEvent[] = [];
      const passedOver: string[] = [];
      let problem: string | null = null;

      for (;;) {
        while (cursor < events.length && matches.length < expectation.count) {
          const event = events[cursor];
          cursor += 1;
          if (event === undefined) continue;
          if (sseMatches(event, expectation)) matches.push(event);
          else passedOver.push(`${event.event || '(unnamed)'}: ${event.data}`);
        }
        if (matches.length >= expectation.count) break;
        if (streamEnded !== null) {
          problem = `The stream ended after ${matches.length} of ${expectation.count} matching event(s) — ${streamEnded}`;
          break;
        }
        if (ctx.signal.aborted) {
          problem = 'The run was cancelled while waiting for events';
          break;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          problem = `Only ${matches.length} of ${expectation.count} matching event(s) arrived within ${expectation.timeoutMs}ms`;
          break;
        }
        await gate.wait(remaining);
      }

      const problems: string[] = [];
      if (problem) problems.push(problem);
      const last = matches[matches.length - 1];
      if (problems.length === 0 && last) {
        for (const [name, path] of Object.entries(expectation.extract)) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(last.data);
          } catch {
            problems.push(`Cannot extract "${name}": the event data is not JSON`);
            break;
          }
          const got = readPath(parsed, path);
          if (got === undefined) problems.push(`Could not extract "${name}" from "${path}"`);
          else vars[name] = typeof got === 'string' ? got : JSON.stringify(got);
        }
      }

      const wanted = [
        expectation.event !== undefined ? `event "${expectation.event}"` : 'any event',
        expectation.dataContains !== undefined
          ? `data containing ${JSON.stringify(expectation.dataContains)}`
          : null,
        expectation.count > 1 ? `×${expectation.count}` : null,
      ]
        .filter(Boolean)
        .join(', ');

      recorder.record(
        `Expect ${wanted} — ${expectation.name}`,
        began,
        problems,
        problems.length === 0
          ? {}
          : {
              expected: wanted,
              actual:
                passedOver.length > 0
                  ? `saw ${passedOver.length} other event(s): ${truncate(passedOver.join(' | '), FRAME_SNIPPET_LIMIT)}`
                  : 'no events were received',
            },
      );
    }
  } finally {
    ctx.signal.removeEventListener('abort', onRunAbort);
    controller.abort();
    await reader.cancel().catch(() => {});
    await pump.catch(() => {});
  }

  return finish(test, startedAt, recorder, network, ctx.secrets);
}

// ─── gRPC ────────────────────────────────────────────────────────────────────

/**
 * gRPC runs through `grpcurl` rather than a Node gRPC client.
 *
 * Same build-vs-buy call the LOAD plugin makes with k6: grpcurl already does
 * server reflection, `.proto` compilation, TLS and status decoding, and adding
 * `@grpc/grpc-js` plus `@grpc/proto-loader` to the runner would ship a protobuf
 * compiler to every worker for a test type most orgs never enable.
 */
const GRPC_STATUS_NAMES = [
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
] as const;

const GRPCURL_INSTALL_HINT =
  'grpcurl is not installed on this worker. Install it (brew install grpcurl, or see https://github.com/fullstorydev/grpcurl) and re-run — the test itself was not evaluated.';

/** Reads the status out of grpcurl's stderr, in either of the shapes it emits. */
function parseGrpcStatus(stderr: string): { code: string; message: string } {
  // `-format-error` prints the status as JSON when the format is json.
  const jsonStart = stderr.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(stderr.slice(jsonStart)) as { code?: unknown; message?: unknown };
      const code =
        typeof parsed.code === 'number'
          ? (GRPC_STATUS_NAMES[parsed.code] ?? `CODE_${parsed.code}`)
          : typeof parsed.code === 'string'
            ? parsed.code.toUpperCase()
            : null;
      if (code) return { code, message: String(parsed.message ?? '') };
    } catch {
      /* fall through to the human-readable shape below */
    }
  }
  const code = /^\s*Code:\s*(\w+)/m.exec(stderr)?.[1];
  const message = /^\s*Message:\s*(.*)$/m.exec(stderr)?.[1] ?? '';
  if (code) {
    // grpcurl prints Go-style names (`NotFound`); assertions use the wire names.
    const upper = code.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    return { code: upper, message: message.trim() };
  }
  return { code: 'UNKNOWN', message: stderr.trim() };
}

interface GrpcurlResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

function runGrpcurl(
  args: string[],
  signal: AbortSignal,
  timeoutSeconds: number,
  cwd?: string,
): Promise<GrpcurlResult> {
  return new Promise<GrpcurlResult>((done) => {
    // Never a shell: a spec is org-authored data, and string interpolation into
    // a shell here would turn a test definition into remote code execution.
    // `env` is explicit because omitting it inherits the worker's entire
    // environment, which is the same leak by default. See child-env.ts.
    //
    // `cwd` is the run's repository when there is one. Every path QAAI passes
    // on the command line is already absolute, so this changes nothing for a
    // legal spec — but without it the child runs in the WORKER'S OWN directory,
    // and any relative path grpcurl resolves for itself would resolve there.
    const child = spawn('grpcurl', args, {
      ...(cwd === undefined ? {} : { cwd }),
      env: childEnv(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString().slice(0, 200_000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString().slice(0, 200_000);
    });

    // grpcurl's own -max-time should fire first; this is the backstop for a
    // process that hangs before it ever starts the call.
    const timer = setTimeout(() => child.kill('SIGTERM'), (timeoutSeconds + 5) * 1000);
    const onAbort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) =>
      done({ code: null, stdout, stderr, spawnError: (err as NodeJS.ErrnoException).code }),
    );
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      done({ code, stdout, stderr });
    });
  });
}

async function runGrpc(
  ctx: RunContext,
  test: ExecutableTest,
  spec: GrpcProtocolSpec,
  startedAt: number,
): Promise<TestExecution> {
  const vars: Record<string, string> = { ...ctx.secrets, ...spec.variables };
  const recorder = new StepRecorder(ctx, test.id);
  const network: NetworkEntry[] = [];

  /*
   * ── Where a proto path points, and the defect that was ─────────────────────
   *
   * `const workspace = process.cwd()` — QAAI's own checkout on the worker. A
   * spec naming `proto/orders.proto`, a real file in the CUSTOMER'S repository,
   * resolved to a path in OURS: so either grpcurl reported a file it could not
   * open, or — if the name happened to exist in our tree — it compiled QAAI'S
   * PROTO and called the customer's service with it. The second is worse, and
   * silent.
   *
   * Only `-proto` and `-import-path` touch the filesystem, and both are
   * optional: with neither, grpcurl uses the service's own reflection and needs
   * no checkout at all. So the refusal is conditional on the spec actually
   * naming a file — refusing every gRPC test for a missing repository would
   * break the reflection case, which is the common one.
   *
   * SKIPPED, because no connected repository is a configuration gap: nothing
   * about the service was evaluated, and the message names both ways out.
   */
  const workspace = runWorkspaceOf(ctx);
  const schemaRefs = [...spec.importPaths, ...(spec.protoPath ? [spec.protoPath] : [])];
  if (schemaRefs.length > 0 && !workspace) {
    return finish(test, startedAt, recorder, network, ctx.secrets, {
      status: 'SKIPPED',
      errorMessage: `"${test.name}" compiles its protobuf schema from your repository (${schemaRefs.join(', ')}), and this run has no checkout of it, so no call was made. Connect the project to its repository (Project settings → Repository) and re-run — or remove \`protoPath\` and \`importPaths\` to use the service's own reflection instead.`,
    });
  }

  let target: string;
  const schemaArgs: string[] = [];
  try {
    target = spec.target ? interpolate(spec.target, vars) : new URL(ctx.baseUrl).host;
    // Unreachable with a schema path and no workspace: the refusal above
    // returned. Written as a narrowing check rather than an assertion so the
    // reflection case needs no workspace and no cast.
    if (workspace) {
      for (const importPath of spec.importPaths) {
        schemaArgs.push('-import-path', safeWorkspacePath(workspace.root, importPath));
      }
      // With no -proto, grpcurl uses server reflection. That is the default on
      // purpose: reflection is what a running service already exposes.
      if (spec.protoPath) {
        schemaArgs.push('-proto', safeWorkspacePath(workspace.root, spec.protoPath));
      }
    }
  } catch (err) {
    // FAILED, not SKIPPED: a path that leaves the repository is a broken spec,
    // and a skip does not block a gate. `record` with problems marks the run
    // broken, which `finish` renders as FAILED.
    recorder.record('Resolve gRPC target', Date.now(), [errorText(err)]);
    return finish(test, startedAt, recorder, network, ctx.secrets);
  }

  for (const call of spec.calls) {
    if (ctx.signal.aborted || recorder.broken) {
      recorder.skip(`${call.method} — ${call.name}`);
      continue;
    }

    const began = Date.now();
    const args: string[] = [];
    if (spec.plaintext) args.push('-plaintext');
    args.push('-format-error', '-max-time', String(spec.timeoutSeconds));
    args.push(...schemaArgs);
    for (const [key, value] of Object.entries(call.metadata)) {
      args.push('-H', `${key}: ${interpolate(value, vars)}`);
    }
    const request = JSON.stringify(interpolateDeep(call.request ?? {}, vars));
    args.push('-d', request, target, call.method);

    recorder.log('↑', `${call.method} ${request}`);
    const result = await runGrpcurl(args, ctx.signal, spec.timeoutSeconds, workspace?.root);

    if (result.spawnError === 'ENOENT') {
      return skippedForMissingTool(test, startedAt, recorder, ctx.secrets, GRPCURL_INSTALL_HINT);
    }

    const durationMs = Date.now() - began;
    const status = result.code === 0 ? { code: 'OK', message: '' } : parseGrpcStatus(result.stderr);
    recorder.log('↓', result.code === 0 ? result.stdout : `${status.code}: ${status.message}`);

    const assertions = call.assertions;
    const problems: string[] = [];
    let expected: string | null = null;
    let actual: string | null = null;
    const wantStatus = assertions.status.toUpperCase();

    if (status.code !== wantStatus) {
      problems.push(
        `Expected gRPC status ${wantStatus}, got ${status.code}${status.message ? ` (${truncate(status.message, 300)})` : ''}`,
      );
      expected = wantStatus;
      actual = status.code;
    }
    if (assertions.maxLatencyMs !== undefined && durationMs > assertions.maxLatencyMs) {
      problems.push(`Took ${durationMs}ms, budget is ${assertions.maxLatencyMs}ms`);
    }
    if (
      assertions.responseContains !== undefined &&
      !result.stdout.includes(assertions.responseContains)
    ) {
      problems.push(`Response does not contain ${JSON.stringify(assertions.responseContains)}`);
    }

    const needsJson =
      assertions.responseMatches !== undefined || Object.keys(call.extract).length > 0;
    let payload: unknown;
    if (needsJson && status.code === 'OK') {
      try {
        payload = JSON.parse(result.stdout);
      } catch {
        problems.push('Response was not valid JSON');
      }
    }
    for (const [path, want] of Object.entries(assertions.responseMatches ?? {})) {
      const got = readPath(payload, path);
      if (!jsonEq(got, want)) {
        problems.push(
          `Response at "${path}" was ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
        );
        expected ??= JSON.stringify(want);
        actual ??= JSON.stringify(got);
      }
    }
    for (const [name, path] of Object.entries(call.extract)) {
      const got = readPath(payload, path);
      if (got === undefined) problems.push(`Could not extract "${name}" from "${path}"`);
      else vars[name] = typeof got === 'string' ? got : JSON.stringify(got);
    }

    network.push({
      method: 'GRPC',
      url: `${spec.plaintext ? 'grpc' : 'grpcs'}://${target}/${call.method}`,
      status: GRPC_STATUS_NAMES.indexOf(status.code as (typeof GRPC_STATUS_NAMES)[number]),
      durationMs,
      responseBodySnippet:
        problems.length > 0 ? (result.stdout || result.stderr).slice(0, BODY_SNIPPET_LIMIT) : null,
    });

    recorder.record(`${call.method} — ${call.name}`, began, problems, { expected, actual });
  }

  return finish(test, startedAt, recorder, network, ctx.secrets);
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

/**
 * The plugin, PLUS the one seam a test needs.
 *
 * `RunnerPlugin.execute` takes two parameters, so a `protocolPlugin` typed as
 * `RunnerPlugin` cannot be handed a third even though the function accepts one
 * — the interface narrows the call signature, and a test that injected a guard
 * would be a TS2554. Widening the EXPORTED type rather than `RunnerPlugin`
 * itself keeps the change inside this file: the registry still consumes it as a
 * `RunnerPlugin` (an extra OPTIONAL parameter is assignable), and a test can
 * decide without a resolver.
 *
 * Adding `egress?` to `RunnerPlugin` in `packages/shared/src/types.ts` would be
 * the better home for it once more than one plugin needs it, and the other
 * plugins that fetch — `api.ts`, `email.ts`, `load.ts` — all do. It is in the
 * handover.
 */
export interface ProtocolPlugin extends RunnerPlugin {
  execute(
    ctx: RunContext,
    test: ExecutableTest,
    egress?: ProtocolEgressGuard,
  ): Promise<TestExecution>;
}

export const protocolPlugin: ProtocolPlugin = {
  type: 'PROTOCOL',

  validate(test: ExecutableTest): void {
    const parsed = protocolTestSpecSchema.safeParse(test.spec);

    if (!parsed.success) {
      // A discriminated union reports an unhelpful union error when the
      // discriminator itself is wrong, so name that case before falling back.
      const raw = test.spec;
      const kind =
        raw !== null && typeof raw === 'object'
          ? (raw as Record<string, unknown>).protocol
          : undefined;
      if (typeof kind !== 'string' || !(PROTOCOL_KINDS as readonly string[]).includes(kind)) {
        throw new Error(
          `Protocol test "${test.name}" must set "protocol" to one of ${PROTOCOL_KINDS.join(', ')} — got ${JSON.stringify(kind)}.`,
        );
      }
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Protocol test "${test.name}" has an invalid ${kind} spec — ${issues}`);
    }

    // Patterns are compiled here, not at match time: an unparseable regex is a
    // spec bug that must name itself, rather than quietly never matching and
    // reporting the service as broken.
    const spec = parsed.data;
    if (spec.protocol === 'WEBSOCKET') {
      for (const [index, step] of spec.steps.entries()) {
        if (step.action !== 'EXPECT' || step.matchesRegex === undefined) continue;
        try {
          new RegExp(step.matchesRegex);
        } catch (err) {
          throw new Error(
            `Protocol test "${test.name}" has an invalid steps.${index}.matchesRegex on step "${step.name}" — ${errorText(err)}`,
          );
        }
      }
    }
  },

  async execute(
    ctx: RunContext,
    test: ExecutableTest,
    /**
     * The egress guard, injected. OPTIONAL so `RunnerPlugin.execute` keeps its
     * shape and every production caller keeps compiling — the worker's harness
     * supplies none, so this door builds {@link defaultProtocolEgressGuard}
     * itself and there is no path to a transport without a decision. A test
     * supplies its own and never touches a resolver.
     */
    egress?: ProtocolEgressGuard,
  ): Promise<TestExecution> {
    const startedAt = Date.now();
    const spec = protocolTestSpecSchema.parse(test.spec);

    /*
     * ── THE PRODUCTION DOOR FILLS IN THE GUARD ───────────────────────────────
     *
     * Built HERE, once, rather than inside each of the three drivers, for the
     * reason `signInWithProfile` gives about the same decision: a control each
     * driver has to remember is a control the next driver forgets. The three
     * drivers below take it as a REQUIRED parameter, so a fourth protocol
     * cannot be added without being handed one.
     */
    const guard = egress ?? (await defaultProtocolEgressGuard(egressPolicyOf(ctx)));

    switch (spec.protocol) {
      case 'GRAPHQL':
        return runGraphql(ctx, test, spec, startedAt, guard);
      case 'WEBSOCKET':
        return runWebSocket(ctx, test, spec, startedAt, guard);
      case 'SSE':
        return runSse(ctx, test, spec, startedAt, guard);
      case 'GRPC':
        /*
         * NOT GATED, AND SAYING SO IS THE POINT. gRPC does not use `fetch` or
         * `WebSocket` — it shells out to `grpcurl` with `spec.target`, which is
         * a host:port and not a URL, so neither `guardUrl` nor `egressUrlFor`
         * reads it and a `host:port` handed to `new URL()` parses as a scheme.
         * It is the same hole by a different transport; it is outside this
         * slice's listed items and it is in the handover rather than left
         * unsaid.
         */
        return runGrpc(ctx, test, spec, startedAt);
    }
  },
};
