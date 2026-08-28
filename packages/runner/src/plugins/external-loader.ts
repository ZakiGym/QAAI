/**
 * Turning an installed third-party plugin into a `RunnerPlugin`, or refusing to.
 *
 * The registry decides what is installed and records a content hash for it.
 * That hash is worth nothing until something checks it before executing, which
 * is this file: nothing here runs a byte of plugin code until the code in hand
 * hashes to the value the registry stored. An attacker who can write to the
 * plugin blob store but not to the database gets a refusal instead of
 * execution, and an operator who can read the audit log can tell the two apart.
 *
 * The other half of the job is attribution, and it is the half the product's
 * credibility rests on. When a plugin throws, hangs, blows its memory limit or
 * returns nonsense, the result must say THE PLUGIN broke. A run that reports
 * "your checkout is broken" because somebody's plugin threw a TypeError is the
 * worst bug this feature can have: it destroys trust in every other result on
 * the page, including the true ones. So every fault path in here produces
 * SKIPPED with a sentence naming the plugin, and the words "not a failure of
 * the application under test" appear in the message rather than being implied.
 *
 * SKIPPED specifically, not FAILED: the worker's gate counts FAILED against the
 * build. A broken plugin must not block a customer's merge, for the same reason
 * a missing Firefox binary must not — a precedent this repo has had to
 * re-establish four times (see external.ts).
 *
 * `validate()` therefore never throws either. The worker wraps `validate` and
 * `execute` in one try/catch that records a throw as FAILED with the thrown
 * message (apps/worker/src/processors/run.ts), so throwing out of here is
 * exactly the mis-attribution above, arriving by a side door.
 *
 * What the plugin can reach, and what it cannot, is sandbox.ts's problem and is
 * documented there. This file's contribution to that model is the mediation:
 * every capability call is performed BY THE HOST, against the run's own
 * context, with the plugin's declarations as the allowlist.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { TEST_TYPES, maskDeep, maskUrl } from '@qaai/shared';
import type {
  ConsoleEntry,
  ExecutableTest,
  Finding,
  NetworkEntry,
  RunContext,
  RunnerPlugin,
  StepResult,
  TestExecution,
  TestResultStatus,
  TestType,
} from '@qaai/shared';
import {
  DEFAULT_SANDBOX_LIMITS,
  clampLimits,
  classifyCapability,
  isPluginAtFault,
  runInSandbox,
} from './sandbox.js';
import type {
  Capability,
  PluginFault,
  SandboxHostCall,
  SandboxLimits,
  SandboxUsage,
} from './sandbox.js';

/** Plugin source is a text file a human wrote; anything past this is not that. */
const MAX_CODE_BYTES = 2 * 1024 * 1024;

/** Response bodies are truncated before they are stored or shown to the model. */
const BODY_SNIPPET_LIMIT = 2000;

/** A mediated request body a plugin may send. Bounded so one call cannot be a payload. */
const MAX_REQUEST_BODY = 64 * 1024;

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/**
 * A name or path from the plugin, or the empty string.
 *
 * Not `String(value)`: an object arriving where a secret name belongs would
 * stringify to "[object Object]", and an allowlist lookup for that is a
 * question nobody meant to ask. Anything that is not already a string is not a
 * name, and gets refused on the empty string.
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * What the registry hands the runtime.
 *
 * Deliberately a plain structural type rather than an import from the registry:
 * the runner must be able to refuse a record whose shape it does not recognise,
 * and sharing the manifest type would make "the registry said so" the check.
 */
export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  /** The TestType this plugin claims to implement. */
  testType: string;
  /** ESM source. Must export `execute(api, request)`. */
  code: string;
  /** `sha256:<hex>` (bare hex accepted) recorded by the registry at install. */
  contentHash: string;
  /** Capability names from the manifest. Anything unmediated is refused. */
  capabilities: readonly string[];
  /** Secret names the plugin may ask for. A name outside this list is refused. */
  secretNames?: readonly string[];
  /** Fixture paths the plugin may read. Same rule. */
  fixturePaths?: readonly string[];
  /** Extra origins `http` may reach, beyond the environment's own baseUrl. */
  httpOrigins?: readonly string[];
  /** A REQUEST for tighter limits. It can only lower the ceiling, never raise it. */
  limits?: Partial<SandboxLimits>;
}

export type LoadedPlugin =
  | {
      ok: true;
      plugin: RunnerPlugin;
      granted: ReadonlySet<Capability>;
      limits: SandboxLimits;
    }
  | { ok: false; fault: PluginFault };

// ─── Content hash ────────────────────────────────────────────────────────────

/**
 * The one hash function the registry and the runtime must agree on. Exported so
 * the install path computes it with this code rather than with its own copy —
 * two implementations of "the content hash" is how a verification step quietly
 * starts passing on everything.
 */
export function pluginContentHash(code: string): string {
  return `sha256:${createHash('sha256').update(code, 'utf8').digest('hex')}`;
}

function normaliseHash(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const hex = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  return /^[0-9a-f]{64}$/.test(hex) ? `sha256:${hex}` : null;
}

/**
 * Returns a fault when the code does not hash to what was recorded, null when
 * it does.
 *
 * Compared with `timingSafeEqual` rather than `===`. A content hash is not
 * secret, so this buys nothing today — but the field is the natural place a
 * signature over the code will live, and a comparison that is already constant
 * time cannot be the thing that was forgotten on the day it starts mattering.
 */
export function verifyContentHash(code: string, expected: string): PluginFault | null {
  const want = normaliseHash(expected);
  if (!want) {
    return {
      kind: 'HASH_MISMATCH',
      message: `the recorded content hash "${expected.slice(0, 80)}" is not a sha256 digest, so the code could not be verified`,
    };
  }
  const got = pluginContentHash(code);
  const a = Buffer.from(want, 'utf8');
  const b = Buffer.from(got, 'utf8');
  if (a.length === b.length && timingSafeEqual(a, b)) return null;
  return {
    kind: 'HASH_MISMATCH',
    message: `the plugin's code does not match the hash recorded at install (expected ${want.slice(0, 23)}…, got ${got.slice(0, 23)}…). Nothing was executed.`,
  };
}

// ─── Attribution ─────────────────────────────────────────────────────────────

/**
 * The result a fault becomes.
 *
 * One step, so the cockpit has something to render rather than an empty test,
 * and a message that says out loud whose fault this is. Never FAILED — see the
 * file header.
 */
export function pluginFaultExecution(
  testId: string,
  plugin: { name: string; version: string },
  fault: PluginFault,
  durationMs = 0,
): TestExecution {
  const label = `${plugin.name}@${plugin.version}`;
  const message = isPluginAtFault(fault)
    ? `The "${label}" plugin did not produce a result: ${fault.message}. ` +
      'This is a fault in the plugin, not a failure of the application under test — ' +
      'the application was not evaluated.'
    : `The run was cancelled before the "${label}" plugin finished; the application was not evaluated.`;

  return {
    testId,
    status: 'SKIPPED',
    durationMs,
    steps: [
      {
        index: 0,
        title: `Plugin ${label} (${fault.kind})`,
        status: 'SKIPPED',
        startedAt: new Date().toISOString(),
        durationMs,
        screenshotKey: null,
        error: {
          message,
          stack: fault.stack ?? null,
          selector: null,
          expected: null,
          actual: null,
        },
      },
    ],
    network: [],
    console: [],
    videoKey: null,
    traceKey: null,
    errorMessage: message,
    retriedAndPassed: false,
    findings: [],
  };
}

// ─── The report a plugin returns ─────────────────────────────────────────────

const FINDING_KINDS = new Set([
  'ACCESSIBILITY',
  'SECURITY',
  'PERFORMANCE',
  'LOCALIZATION',
  'VISUAL',
]);
const SEVERITIES = new Set(['CRITICAL', 'SERIOUS', 'MODERATE', 'MINOR']);
const REPORT_STATUSES = new Set(['PASSED', 'FAILED', 'SKIPPED']);

interface RawStep {
  title: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  durationMs: number;
  error: { message: string; expected: string | null; actual: string | null } | null;
}

interface RawReport {
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  errorMessage: string | null;
  steps: RawStep[];
  findings: Finding[];
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  return value.length > max ? value.slice(0, max) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parses and validates the plugin's report, refusing anything it cannot vouch
 * for.
 *
 * Written by hand rather than with zod because the count caps have to be
 * checked BEFORE the elements are: a plugin that emits a million findings must
 * be refused on `length`, not after a validator has walked a million objects.
 * That ordering is the difference between a cap and a slower way to fill the
 * database.
 *
 * A plugin's status is narrowed to the three verdicts it is entitled to.
 * FLAKY is the platform's judgement across runs and TIMED_OUT is the sandbox's,
 * so a plugin cannot award itself either.
 */
export function parsePluginReport(
  json: string,
  limits: SandboxLimits,
): { ok: true; report: RawReport } | { ok: false; fault: PluginFault } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, fault: { kind: 'BAD_SHAPE', message: 'the report is not valid JSON' } };
  }

  if (!isRecord(raw)) {
    return { ok: false, fault: { kind: 'BAD_SHAPE', message: 'the report is not an object' } };
  }

  if (typeof raw.status !== 'string' || !REPORT_STATUSES.has(raw.status)) {
    return {
      ok: false,
      fault: {
        kind: 'BAD_SHAPE',
        message: 'the report has no status of PASSED, FAILED or SKIPPED',
      },
    };
  }

  const rawSteps = raw.steps === undefined ? [] : raw.steps;
  const rawFindings = raw.findings === undefined ? [] : raw.findings;
  if (!Array.isArray(rawSteps) || !Array.isArray(rawFindings)) {
    return {
      ok: false,
      fault: { kind: 'BAD_SHAPE', message: 'the report\'s steps and findings must be arrays' },
    };
  }
  if (rawSteps.length > limits.maxSteps) {
    return {
      ok: false,
      fault: {
        kind: 'TOO_MANY_EMITTED',
        message: `the plugin emitted ${rawSteps.length} steps, over the limit of ${limits.maxSteps}`,
      },
    };
  }
  if (rawFindings.length > limits.maxFindings) {
    return {
      ok: false,
      fault: {
        kind: 'TOO_MANY_EMITTED',
        message: `the plugin emitted ${rawFindings.length} findings, over the limit of ${limits.maxFindings}`,
      },
    };
  }

  const steps: RawStep[] = [];
  for (const item of rawSteps) {
    if (!isRecord(item)) continue;
    const title = str(item.title, 300);
    if (title === null) continue;
    const status =
      typeof item.status === 'string' && REPORT_STATUSES.has(item.status)
        ? (item.status as RawStep['status'])
        : 'PASSED';
    const err = isRecord(item.error) ? item.error : null;
    steps.push({
      title,
      status,
      durationMs:
        typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) && item.durationMs >= 0
          ? Math.min(Math.floor(item.durationMs), 24 * 60 * 60 * 1000)
          : 0,
      error: err
        ? {
            message: str(err.message, 2000) ?? 'the step failed',
            expected: str(err.expected, 1000),
            actual: str(err.actual, 1000),
          }
        : null,
    });
  }

  const findings: Finding[] = [];
  for (const item of rawFindings) {
    if (!isRecord(item)) continue;
    const message = str(item.message, 1000);
    const code = str(item.code, 200);
    if (message === null || code === null) continue;
    findings.push({
      kind:
        typeof item.kind === 'string' && FINDING_KINDS.has(item.kind)
          ? (item.kind as Finding['kind'])
          : 'SECURITY',
      severity:
        typeof item.severity === 'string' && SEVERITIES.has(item.severity)
          ? (item.severity as Finding['severity'])
          : 'MODERATE',
      code,
      message,
      location: str(item.location, 500) ?? '',
      helpUrl: str(item.helpUrl, 500),
    });
  }

  return {
    ok: true,
    report: {
      status: raw.status as RawReport['status'],
      errorMessage: str(raw.errorMessage, 4000),
      steps,
      findings,
    },
  };
}

// ─── Loading ─────────────────────────────────────────────────────────────────

/**
 * Verifies an installed plugin and returns something satisfying the existing
 * `RunnerPlugin` interface, or the fault that stopped it.
 *
 * Every check here happens before any plugin code is executed, so an install
 * that should never have happened costs a hash and a set lookup rather than a
 * sandbox. The order matters: the hash is checked FIRST, because the
 * capabilities and limits in the record describe code we have not yet confirmed
 * we are holding.
 */
export function loadExternalPlugin(
  installed: InstalledPlugin,
  ceiling: SandboxLimits = DEFAULT_SANDBOX_LIMITS,
): LoadedPlugin {
  if (typeof installed.code !== 'string' || installed.code.length === 0) {
    return { ok: false, fault: { kind: 'LOAD_ERROR', message: 'the plugin has no code' } };
  }
  if (Buffer.byteLength(installed.code, 'utf8') > MAX_CODE_BYTES) {
    return {
      ok: false,
      fault: {
        kind: 'CODE_TOO_LARGE',
        message: `the plugin's code is larger than the ${MAX_CODE_BYTES}-byte limit`,
      },
    };
  }

  const hashFault = verifyContentHash(installed.code, installed.contentHash ?? '');
  if (hashFault) return { ok: false, fault: hashFault };

  if (!(TEST_TYPES as readonly string[]).includes(installed.testType)) {
    return {
      ok: false,
      fault: {
        kind: 'LOAD_ERROR',
        message: `"${String(installed.testType).slice(0, 40)}" is not a QAAI test type`,
      },
    };
  }

  const granted = new Set<Capability>();
  const declared = Array.isArray(installed.capabilities) ? installed.capabilities : [];
  for (const name of declared) {
    const decision = classifyCapability(String(name));
    if (!decision.granted) {
      return {
        ok: false,
        fault: {
          kind: 'REFUSED_CAPABILITY',
          message: `the plugin declares the capability "${String(name).slice(0, 40)}", which QAAI refuses to grant: ${decision.reason}`,
        },
      };
    }
    granted.add(decision.capability);
  }

  const limits = clampLimits(installed.limits, ceiling);
  const plugin = buildPlugin(installed, granted, limits);
  return { ok: true, plugin, granted, limits };
}

function buildPlugin(
  installed: InstalledPlugin,
  granted: ReadonlySet<Capability>,
  limits: SandboxLimits,
): RunnerPlugin {
  return {
    type: installed.testType as TestType,

    /**
     * Intentionally empty. An external plugin owns its own spec vocabulary, so
     * the only party that can validate it is the plugin — inside the sandbox,
     * where a throw is attributable. Throwing here would be recorded by the
     * worker as the customer's application failing.
     */
    validate(): void {},

    execute: (ctx, test) => executeExternal(installed, granted, limits, ctx, test),
  };
}

// ─── Mediated capabilities ───────────────────────────────────────────────────

interface Mediation {
  onCall: (call: SandboxHostCall) => Promise<unknown>;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  /** Requests for things the plugin never declared, reported alongside the result. */
  refusals: string[];
}

/**
 * Builds the host side of every capability the plugin was granted.
 *
 * "Mediated" is doing real work in each of these: the plugin names a secret and
 * gets a value, names a fixture and gets its text, names a URL and gets a
 * response. It never holds the vault, the workspace, or a socket. What it
 * cannot do is un-know a secret once it has one — a plugin granted `secrets`
 * can exfiltrate the value over `node:net`, which no in-process control
 * prevents. That is why the manifest names each secret individually and why
 * approving them is a human decision at install time, not a runtime check.
 */
function buildMediation(
  installed: InstalledPlugin,
  ctx: RunContext,
  limits: SandboxLimits,
): Mediation {
  const secretValues = Object.values(ctx.secrets);
  const mask = (text: string): string => maskDeep(text, secretValues);

  const allowedSecrets = new Set(installed.secretNames ?? []);
  const allowedFixtures = new Set(installed.fixturePaths ?? []);
  const allowedOrigins = new Set<string>();
  try {
    allowedOrigins.add(new URL(ctx.baseUrl).origin);
  } catch {
    // A malformed baseUrl is the environment's problem; http then allows only
    // whatever the manifest listed, which may be nothing. Fail closed.
  }
  for (const origin of installed.httpOrigins ?? []) {
    try {
      allowedOrigins.add(new URL(origin).origin);
    } catch {
      // An unparseable origin grants nothing rather than everything.
    }
  }

  const consoleEntries: ConsoleEntry[] = [];
  const network: NetworkEntry[] = [];
  const refusals: string[] = [];

  const refuse = (message: string): never => {
    if (refusals.length < 50) refusals.push(message);
    throw new Error(message);
  };

  const onCall = async (call: SandboxHostCall): Promise<unknown> => {
    switch (call.capability) {
      case 'log': {
        const text = mask(asString(call.args[0])).slice(0, 2000);
        if (consoleEntries.length < limits.maxLogLines) {
          consoleEntries.push({ level: 'info', text, at: new Date().toISOString() });
        }
        ctx.logger.debug(text, { plugin: installed.name });
        return null;
      }

      case 'secrets': {
        const name = asString(call.args[0]);
        if (!allowedSecrets.has(name)) {
          return refuse(
            `the plugin asked for the secret "${name.slice(0, 60)}", which its manifest does not declare`,
          );
        }
        // A declared name that the environment does not define is a null, not
        // a refusal: the plugin is entitled to ask and entitled to know.
        return ctx.secrets[name] ?? null;
      }

      case 'fixtures': {
        const path = asString(call.args[0]);
        if (!allowedFixtures.has(path)) {
          return refuse(
            `the plugin asked for the fixture "${path.slice(0, 120)}", which its manifest does not declare`,
          );
        }
        return ctx.fixtures?.[path] ?? null;
      }

      case 'http': {
        const init = isRecord(call.args[0]) ? call.args[0] : {};
        const method = (asString(init.method) || 'GET').toUpperCase();
        if (!HTTP_METHODS.has(method)) refuse(`"${method.slice(0, 20)}" is not an allowed method`);

        let url: URL;
        try {
          url = new URL(asString(init.url), ctx.baseUrl);
        } catch {
          return refuse('the plugin asked for a URL QAAI could not parse');
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          refuse(`"${url.protocol}" is not an allowed scheme`);
        }
        if (!allowedOrigins.has(url.origin)) {
          refuse(
            `the plugin asked to reach ${url.origin}, which is neither the environment under test nor an origin its manifest declares`,
          );
        }

        const headers: Record<string, string> = {};
        if (isRecord(init.headers)) {
          for (const [key, value] of Object.entries(init.headers).slice(0, 32)) {
            if (typeof value === 'string') headers[key] = value;
          }
        }
        const body = typeof init.body === 'string' ? init.body.slice(0, MAX_REQUEST_BODY) : undefined;

        const startedAt = Date.now();
        try {
          const response = await fetch(url, {
            method,
            headers,
            body: method === 'GET' || method === 'HEAD' ? undefined : body,
            redirect: 'manual',
            signal: AbortSignal.any([
              ctx.signal,
              AbortSignal.timeout(Math.min(limits.wallClockMs, 30_000)),
            ]),
          });
          const text = (await response.text()).slice(0, BODY_SNIPPET_LIMIT);
          const durationMs = Date.now() - startedAt;
          if (network.length < limits.maxNetworkEntries) {
            network.push({
              method,
              url: maskUrl(url.toString()),
              status: response.status,
              durationMs,
              responseBodySnippet: response.ok ? null : mask(text),
            });
          }
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: text,
            durationMs,
          };
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          if (network.length < limits.maxNetworkEntries) {
            network.push({
              method,
              url: maskUrl(url.toString()),
              status: null,
              durationMs,
              responseBodySnippet: null,
            });
          }
          throw new Error(mask(err instanceof Error ? err.message : String(err)), { cause: err });
        }
      }

      default:
        // Unreachable while `granted` only ever holds mediated names, but a
        // default that threw "unknown" beats one that returned undefined and
        // let a future capability arrive un-mediated.
        return refuse('that capability is not mediated by QAAI');
    }
  };

  return { onCall, console: consoleEntries, network, refusals };
}

// ─── Execution ───────────────────────────────────────────────────────────────

async function executeExternal(
  installed: InstalledPlugin,
  granted: ReadonlySet<Capability>,
  limits: SandboxLimits,
  ctx: RunContext,
  test: ExecutableTest,
): Promise<TestExecution> {
  const startedAt = Date.now();
  const mediation = buildMediation(installed, ctx, limits);

  // Re-verified at execute time, not only at load. A loaded plugin can be held
  // across many tests and, on a long-lived worker, across a reinstall; the
  // check is a single sha256 over at most 2MB and it is the entire guarantee.
  const hashFault = verifyContentHash(installed.code, installed.contentHash ?? '');
  if (hashFault) {
    return pluginFaultExecution(test.id, installed, hashFault, Date.now() - startedAt);
  }

  const outcome = await runInSandbox({
    code: installed.code,
    // The plugin gets data, never the RunContext: no artifacts sink, no logger,
    // no secrets bag, no signal it could hold open.
    request: {
      baseUrl: ctx.baseUrl,
      spec: test.spec,
      test: { id: test.id, name: test.name, filePath: test.filePath, tags: test.tags },
    },
    granted,
    limits,
    onCall: mediation.onCall,
    signal: ctx.signal,
  });

  if (!outcome.ok) {
    const execution = pluginFaultExecution(
      test.id,
      installed,
      outcome.fault,
      Date.now() - startedAt,
    );
    return { ...execution, console: mediation.console, network: mediation.network };
  }

  const parsed = parsePluginReport(outcome.json, limits);
  if (!parsed.ok) {
    const execution = pluginFaultExecution(test.id, installed, parsed.fault, Date.now() - startedAt);
    return { ...execution, console: mediation.console, network: mediation.network };
  }

  return toExecution(installed, test, parsed.report, mediation, outcome.usage, startedAt, ctx);
}

function toExecution(
  installed: InstalledPlugin,
  test: ExecutableTest,
  report: RawReport,
  mediation: Mediation,
  usage: SandboxUsage,
  startedAt: number,
  ctx: RunContext,
): TestExecution {
  const secretValues = Object.values(ctx.secrets);
  const at = new Date(startedAt).toISOString();

  // Everything the plugin authored is masked before it becomes a row. A plugin
  // that echoes a secret it was granted into a step title would otherwise put
  // it in the database, the SSE stream and the triage prompt in one move.
  const steps: StepResult[] = maskDeep(
    report.steps.map((step, index) => ({
      index,
      title: step.title,
      status: step.status,
      startedAt: at,
      durationMs: step.durationMs,
      screenshotKey: null,
      error: step.error
        ? {
            message: step.error.message,
            stack: null,
            selector: null,
            expected: step.error.expected,
            actual: step.error.actual,
          }
        : null,
    })),
    secretValues,
  );

  const transcript: ConsoleEntry[] = [...mediation.console];
  // Refusals belong in the transcript: an operator debugging "why does this
  // plugin do nothing" needs to see that it asked for a secret nobody granted.
  for (const refusal of mediation.refusals) {
    transcript.push({ level: 'warn', text: `[qaai] refused: ${refusal}`, at });
  }
  if (usage.containment === 'isolate') {
    transcript.push({
      level: 'debug',
      text:
        `[qaai] ${installed.name}@${installed.version} ran with isolate-level containment ` +
        '(CPU, heap growth, environment and module reach enforced; filesystem and raw sockets are not). ' +
        'Start the worker under Node\'s permission model for OS-level enforcement.',
      at,
    });
  }

  const status: TestResultStatus = report.status;

  return {
    testId: test.id,
    status,
    durationMs: Date.now() - startedAt,
    steps,
    network: mediation.network,
    console: transcript,
    videoKey: null,
    traceKey: null,
    errorMessage: report.errorMessage ? maskDeep(report.errorMessage, secretValues) : null,
    retriedAndPassed: false,
    findings: maskDeep(report.findings, secretValues),
  };
}
