#!/usr/bin/env node
/**
 * The QAAI on-prem runner agent (ENTERPRISE) — the process a customer runs.
 *
 * It exists because of one fact about enterprise networks: the staging
 * environment worth testing is the one that never faces the internet. QAAI
 * cannot reach it, and no amount of orchestration changes that. So the
 * execution moves to where the application already is, and only the
 * orchestration, the history and the triage stay with us.
 *
 * ── The rules this file is built around ─────────────────────────────────────
 *
 * 1. **It only ever dials out.** There is no listener here, no port, no inbound
 *    anything. It long-polls for work and streams results back over the same
 *    request/response channel it opened itself. A design that needed a firewall
 *    hole would never be deployed, so this one does not have the option.
 *
 * 2. **One host, pinned at startup.** The API origin is validated once
 *    (`pinEndpoint`) and every subsequent request is built from the frozen
 *    origin. Redirects are refused rather than followed — a 3xx while holding a
 *    runner token is how a token walks out of the building, and the same bug
 *    has already been paid for once in `apps/api/src/lib/issues.ts`. Nothing
 *    the server sends can name a host, because no field in any response is ever
 *    treated as a URL.
 *
 * 3. **It never evaluates what the server sends.** No `eval`, no `Function`,
 *    no dynamic import, and — the one that actually matters — the command it
 *    spawns comes from the operator's local config file and nowhere else. The
 *    server supplies test SOURCE, which is written to disk and handed to the
 *    customer's own installed test runner; it never supplies an argv. Spawns
 *    are `shell: false` with args as an array, so no server-supplied string is
 *    ever parsed by a shell.
 *
 * 4. **A missing tool is a SKIP, not a failure.** If the executor is not
 *    installed, every test in the slice comes back SKIPPED with a sentence
 *    naming what to install. Reporting FAILED would send someone hunting a bug
 *    in an application that was never contacted.
 *
 * 5. **A lease is a promise with an expiry.** Work is held under a fencing
 *    token, renewed by heartbeat. Lose the lease and this process stops
 *    immediately — the server has already given the job to somebody else, and
 *    anything written afterwards is refused. That is what makes a job
 *    reclaimable from a dead runner without ever executing twice.
 *
 * No dependencies beyond Node built-ins and @qaai/shared TYPES (erased at
 * compile time). An agent that drags a package tree into a customer's build
 * host is an agent that does not get installed.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { argv, env, exit, stderr, stdout } from 'node:process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { StepStatus, TestResultStatus, TestType } from '@qaai/shared';
import { TERMINAL_TOOLCHAIN, runShellCommand } from './shell.js';
import type { OutputStream } from './shell.js';

// ─── Errors ──────────────────────────────────────────────────────────────────

/** A message already fit to print. Anything else is a bug and prints a stack. */
export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerError';
  }
}

/**
 * The server says this agent no longer holds the job.
 *
 * Always fatal to the current job and never retried: the work is being done by
 * another runner right now, and every further write would be refused anyway.
 */
export class LeaseLostError extends RunnerError {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseLostError';
  }
}

// ─── The pinned endpoint ─────────────────────────────────────────────────────

export interface PinnedEndpoint {
  /** `https://qaai.acme.com` — scheme, host and port, frozen at startup. */
  readonly origin: string;
  /** The normalised hostname, with any trailing dot already removed. */
  readonly host: string;
  /** Build an absolute URL for a path on the pinned origin. Nothing else can. */
  url(path: string): string;
}

/** Hosts where plain http cannot leave the machine, so the token cannot either. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Validate the API origin once, and never take a host from anywhere else.
 *
 * This is the `jiraSite` problem in the other direction: we cannot pin a
 * constant hostname, because a self-hosted QAAI is on the customer's own
 * domain. So the host is pinned to whatever the OPERATOR typed, at startup,
 * and everything after that is a path. In particular:
 *
 *  - The trailing dot is stripped BEFORE any check and the normalised host is
 *    what gets used. `https://qaai.acme.com.` resolves identically to
 *    `https://qaai.acme.com` in DNS, and one character silently defeating a
 *    hostname guard is exactly the SSRF this codebase has already shipped once.
 *  - Embedded credentials are refused. A token pasted into a URL ends up in
 *    logs, in `ps`, and in a shell history.
 *  - https is required, with one exception that cannot leak: loopback. `npm run
 *    dev` serves the API on http://localhost:4000, and refusing that would mean
 *    nobody could try the agent before buying it.
 */
export function pinEndpoint(raw: string): PinnedEndpoint {
  const trimmed = raw.trim();
  if (!trimmed) throw new RunnerError('An API URL is required (--api-url or QAAI_API_URL).');

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Deliberately does NOT echo the input: an unparseable value is exactly
    // where a pasted `https://user:qaai_rt_…@host` lands.
    throw new RunnerError('That API URL could not be parsed.');
  }

  if (parsed.username || parsed.password) {
    throw new RunnerError(
      'Remove the credentials from the API URL — the runner token is passed separately, in an env var.',
    );
  }

  const host = parsed.hostname.replace(/\.+$/, '').toLowerCase();
  if (!host) throw new RunnerError('That API URL has no host.');

  const loopback = LOOPBACK.has(host);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new RunnerError(
      `The API URL must be https (${parsed.protocol}//${host} is not) — the runner token travels in every request. ` +
        'Plain http is accepted only for localhost, where it cannot leave the machine.',
    );
  }

  const port = parsed.port ? `:${parsed.port}` : '';
  const origin = `${parsed.protocol}//${host}${port}`;

  return {
    origin,
    host,
    url(path: string): string {
      if (!path.startsWith('/')) throw new RunnerError(`Refusing to build a URL from "${path}".`);
      /*
       * `//evil.example.com/x` concatenated onto an origin stays on the pinned
       * host — it becomes a path beginning with two slashes — but it is the
       * classic protocol-relative shape, it is never something this file
       * builds, and the next person to concatenate it somewhere else will not
       * be so lucky. Refused on sight.
       */
      if (path.startsWith('//')) {
        throw new RunnerError('Refusing to send the runner token to a host other than the pinned one.');
      }
      const built = new URL(origin + path);
      /*
       * Belt and braces. Nothing in this file passes a server-supplied string
       * here, and this assertion is what keeps that true if somebody later
       * does: a path that somehow re-hosts the request dies here instead of
       * carrying the token to a stranger.
       */
      if (built.hostname.replace(/\.+$/, '').toLowerCase() !== host) {
        throw new RunnerError('Refusing to send the runner token to a host other than the pinned one.');
      }
      return built.toString();
    },
  };
}

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * How to execute a workspace.
 *
 * Read from the operator's file on the operator's machine. This is the ONLY
 * source of an argv in this program, and the reason it is a separate type with
 * its own validator: the moment a command could arrive from the server, the
 * agent stops being something a security team will allow inside the network.
 */
export interface ExecutorSpec {
  /** The binary. Never from a job payload. */
  command: string;
  /** Fixed arguments. The workspace directory is appended as the cwd, not an arg. */
  args: string[];
  /** JUnit XML the executor writes, relative to the workspace. */
  report: string;
  /** Extra environment for the child. Secrets are merged in separately. */
  env?: Record<string, string>;
  /** Hard ceiling per job, independent of any test's own timeout. */
  timeoutMs?: number;
}

export interface RunnerConfig {
  apiUrl: string;
  /** Where workspaces are materialised. Wiped per job. */
  workspaceRoot: string;
  /** `default`, plus optional per-TestType overrides keyed by TestType. */
  executors: Record<string, ExecutorSpec>;
  /**
   * Whether this host will pick up terminal commands while it holds a job.
   *
   * On by default, and the default is a judgement call worth stating. Against
   * it: a version upgrade that silently opens a command channel into a build
   * host is a change of posture nobody consented to. For it, and decisive: the
   * channel only exists while this agent is executing a job the org already
   * chose to send here, it runs nothing but the read-only allowlist in
   * `shell.ts`, every command is audited server-side against a named user, and
   * the alternative default makes the server's own refusal message ("upgrade
   * the agent") false. An operator who disagrees turns it off in one line, and
   * the startup log says which way it is set rather than leaving them to find
   * out from a screenshot.
   */
  terminal: { enabled: boolean };
  /** Reported to the server; empty lists mean "did not say", not "cannot". */
  capabilities: {
    browsers?: string[];
    testTypes?: string[];
    languages?: string[];
    toolchains?: string[];
    maxConcurrency?: number;
  };
}

/**
 * The out-of-the-box executor: Playwright, reporting JUnit.
 *
 * JUnit rather than Playwright's JSON on purpose — it is the one report format
 * every runner in every language can emit, so an operator who swaps Playwright
 * for pytest or Cypress changes two lines of config and nothing here.
 */
export const DEFAULT_EXECUTOR: ExecutorSpec = {
  command: 'npx',
  args: ['playwright', 'test', '--reporter=junit'],
  report: 'junit.xml',
  env: { PLAYWRIGHT_JUNIT_OUTPUT_NAME: 'junit.xml' },
  timeoutMs: 60 * 60_000,
};

function stringArray(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
    throw new RunnerError(`${field} must be an array of strings.`);
  }
  return raw as string[];
}

function parseExecutor(raw: unknown, where: string): ExecutorSpec {
  if (!raw || typeof raw !== 'object') throw new RunnerError(`${where} must be an object.`);
  const e = raw as Record<string, unknown>;

  if (typeof e.command !== 'string' || !e.command.trim()) {
    throw new RunnerError(`${where}.command must name a binary to run.`);
  }
  if (typeof e.report !== 'string' || !e.report.trim()) {
    throw new RunnerError(`${where}.report must name the JUnit file the command writes.`);
  }

  const extraEnv: Record<string, string> = {};
  if (e.env && typeof e.env === 'object') {
    for (const [key, value] of Object.entries(e.env as Record<string, unknown>)) {
      if (typeof value === 'string') extraEnv[key] = value;
    }
  }

  return {
    command: e.command.trim(),
    args: stringArray(e.args, `${where}.args`),
    report: e.report.trim(),
    env: extraEnv,
    timeoutMs:
      typeof e.timeoutMs === 'number' && e.timeoutMs > 0 ? e.timeoutMs : DEFAULT_EXECUTOR.timeoutMs,
  };
}

/**
 * Is the terminal on, given the config value and the environment override?
 *
 * Accepts `"terminal": false` and `"terminal": { "enabled": false }`, because
 * both are what people write, and `QAAI_TERMINAL` as the switch a systemd unit
 * can flip without editing a config file that was baked into an image. The env
 * var wins when it is set to something recognisable and is ignored otherwise:
 * a typo must not be read as "off" (which would be a silent feature loss) nor
 * as "on" (which would be a silent posture change), so an unrecognised value
 * leaves the config's answer alone.
 */
export function terminalEnabled(configured: unknown, override?: string): boolean {
  const fromConfig =
    configured === false
      ? false
      : configured && typeof configured === 'object'
        ? (configured as { enabled?: unknown }).enabled !== false
        : true;

  const flag = (override ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(flag)) return false;
  if (['1', 'true', 'on', 'yes'].includes(flag)) return true;
  return fromConfig;
}

/**
 * Read the operator's config.
 *
 * A `token` field is refused rather than ignored. Config files get committed,
 * copied between hosts and pasted into support tickets; a credential belongs in
 * an env var or a file with its own permissions, and silently accepting one
 * here would teach exactly the wrong habit.
 */
export function parseRunnerConfig(raw: unknown, source: string): RunnerConfig {
  if (!raw || typeof raw !== 'object') throw new RunnerError(`${source} must contain a JSON object.`);
  const c = raw as Record<string, unknown>;

  if ('token' in c) {
    throw new RunnerError(
      `Remove "token" from ${source} — pass the runner token in QAAI_RUNNER_TOKEN or --token-file so it is not stored beside the config.`,
    );
  }

  const executors: Record<string, ExecutorSpec> = { default: { ...DEFAULT_EXECUTOR } };
  if (c.executors && typeof c.executors === 'object') {
    for (const [key, value] of Object.entries(c.executors as Record<string, unknown>)) {
      executors[key] = parseExecutor(value, `executors.${key}`);
    }
  }

  const capabilities = (c.capabilities ?? {}) as Record<string, unknown>;

  return {
    apiUrl: typeof c.apiUrl === 'string' ? c.apiUrl : '',
    workspaceRoot: typeof c.workspaceRoot === 'string' ? c.workspaceRoot : '.qaai-runner',
    executors,
    terminal: { enabled: terminalEnabled(c.terminal, env.QAAI_TERMINAL) },
    capabilities: {
      browsers: stringArray(capabilities.browsers, 'capabilities.browsers'),
      testTypes: stringArray(capabilities.testTypes, 'capabilities.testTypes'),
      languages: stringArray(capabilities.languages, 'capabilities.languages'),
      toolchains: stringArray(capabilities.toolchains, 'capabilities.toolchains'),
      ...(typeof capabilities.maxConcurrency === 'number'
        ? { maxConcurrency: capabilities.maxConcurrency }
        : {}),
    },
  };
}

/** Pick the executor for a slice: a per-type override, or the default. */
export function executorFor(config: RunnerConfig, types: readonly string[]): ExecutorSpec {
  for (const type of types) {
    const override = config.executors[type];
    if (override) return override;
  }
  return config.executors.default ?? DEFAULT_EXECUTOR;
}

// ─── The workspace ───────────────────────────────────────────────────────────

/**
 * Resolve a server-supplied file path inside the workspace, or refuse.
 *
 * `filePath` comes off the wire. It is the only server-controlled string this
 * program ever turns into a filesystem path, so it gets the full treatment:
 * no absolute paths, no drive letters, no null bytes, and — after
 * normalisation, which is where `a/../../b` becomes `../b` — the result must
 * still be inside the root. Checking for the literal `..` instead would miss
 * `a/%2e%2e/b` on one platform and accept `..foo` on all of them.
 */
export function resolveWorkspacePath(root: string, filePath: string): string {
  if (!filePath || filePath.includes('\0')) {
    throw new RunnerError('Refusing a test file path that is empty or contains a null byte.');
  }
  if (isAbsolute(filePath) || /^[a-zA-Z]:[\\/]/.test(filePath)) {
    throw new RunnerError(`Refusing an absolute test file path: ${filePath}`);
  }

  const rootAbs = resolve(root);
  const target = resolve(rootAbs, normalize(filePath));
  const rel = relative(rootAbs, target);

  /*
   * `rel.startsWith('..')` would be wrong, and the test that says so is not
   * hypothetical: `..hidden.spec.ts` is a perfectly ordinary filename and a
   * prefix test rejects it. What actually means "outside" is a `..` SEGMENT —
   * the whole relative path being `..`, or it beginning with `../`.
   */
  const segments = rel.split(sep);
  if (rel === '' || isAbsolute(rel) || rel === '..' || segments.includes('..')) {
    throw new RunnerError(`Refusing a test file path that escapes the workspace: ${filePath}`);
  }
  return target;
}

interface JobTest {
  id: string;
  name: string;
  type: TestType;
  code: string;
  filePath: string;
  spec: unknown;
  timeoutMs: number;
  quarantined: boolean;
  tags: string[];
}

interface JobAssignment {
  jobId: string;
  leaseId: string;
  runId: string;
  shardIndex: number | null;
  attempt: number;
  leaseSeconds: number;
  heartbeatSeconds: number;
  projectId: string;
  environment: { id: string; name: string; baseUrl: string };
  tests: JobTest[];
  secrets: Record<string, string>;
  fixtures: Record<string, string>;
  determinism: { randomSeed: number; waitForNetworkIdle: boolean; retryOnce: boolean };
}

/**
 * Write the slice to disk.
 *
 * Every path goes through `resolveWorkspacePath`, including the fixtures, which
 * are just as server-supplied as the specs. The directory is created fresh per
 * job so a previous job's leftovers can never be picked up by a glob.
 */
export async function materialiseWorkspace(
  root: string,
  job: Pick<JobAssignment, 'tests' | 'fixtures'>,
): Promise<Map<string, string>> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  /** filePath (workspace-relative, posix-ish) → testId, for report mapping. */
  const byPath = new Map<string, string>();

  for (const test of job.tests) {
    const target = resolveWorkspacePath(root, test.filePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, test.code, 'utf8');
    byPath.set(test.filePath.replace(/\\/g, '/'), test.id);
  }

  for (const [path, contents] of Object.entries(job.fixtures ?? {})) {
    const target = resolveWorkspacePath(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }

  return byPath;
}

// ─── JUnit ───────────────────────────────────────────────────────────────────

export interface JunitCase {
  name: string;
  classname: string;
  file: string;
  durationMs: number;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  message: string | null;
  detail: string | null;
}

const XML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&amp;': '&',
};

export function decodeXml(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    // `&amp;` last, so `&amp;lt;` decodes to the literal `&lt;` and not to `<`.
    .replace(/&lt;|&gt;|&quot;|&apos;/g, (m) => XML_ENTITIES[m] ?? m)
    .replace(/&amp;/g, '&');
}

function attributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of raw.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
    out[match[1]!] = decodeXml(match[2]!);
  }
  return out;
}

/**
 * Read a JUnit report without a parser dependency.
 *
 * Regex over XML is normally a mistake, and it is defensible here for one
 * reason: this is a machine-written report from a test runner, not arbitrary
 * markup, and the alternative is putting an XML library into an agent whose
 * whole pitch is that it has no dependencies. The shapes are fixed —
 * `<testcase .../>` or `<testcase ...>` with a `<failure>`, `<error>` or
 * `<skipped>` child.
 *
 * Anything it cannot understand becomes zero cases, and the caller turns that
 * into SKIPPED-with-a-reason rather than a silent pass. A report we cannot read
 * must never look like a report that said everything was fine.
 */
export function parseJunitXml(xml: string): JunitCase[] {
  const cases: JunitCase[] = [];

  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase\s*>)/g)) {
    const attrs = attributes(match[1] ?? '');
    const body = match[3] ?? '';

    const failure = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/.exec(body);
    const skipped = /<skipped\b([^>]*?)(?:\/>|>([\s\S]*?)<\/skipped\s*>)/.exec(body);

    const seconds = Number(attrs.time ?? '0');
    const status: JunitCase['status'] = failure ? 'FAILED' : skipped ? 'SKIPPED' : 'PASSED';

    const failureAttrs = failure ? attributes(failure[2] ?? '') : {};
    const skippedAttrs = skipped ? attributes(skipped[1] ?? '') : {};

    cases.push({
      name: attrs.name ?? '',
      classname: attrs.classname ?? '',
      file: (attrs.file ?? '').replace(/\\/g, '/'),
      durationMs: Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : 0,
      status,
      message: failure ? (failureAttrs.message ?? null) : (skippedAttrs.message ?? null),
      detail: failure ? decodeXml((failure[3] ?? '').trim()) || null : null,
    });
  }

  return cases;
}

// ─── Report → results ────────────────────────────────────────────────────────

export interface ExecutionReport {
  testId: string;
  status: TestResultStatus;
  durationMs: number;
  errorMessage: string | null;
  retriedAndPassed: boolean;
  steps: Array<{
    index: number;
    title: string;
    status: StepStatus;
    durationMs: number;
    error: { message: string; stack: string | null } | null;
  }>;
  network: never[];
  console: never[];
  videoKey: null;
  traceKey: null;
  findings: never[];
}

function skeleton(testId: string): ExecutionReport {
  return {
    testId,
    status: 'SKIPPED',
    durationMs: 0,
    errorMessage: null,
    retriedAndPassed: false,
    steps: [],
    network: [],
    console: [],
    videoKey: null,
    traceKey: null,
    findings: [],
  };
}

/**
 * Match report cases back to tests, and account for every test either way.
 *
 * The accounting is the point. A test the report never mentions is reported
 * SKIPPED with a sentence saying the executor produced no result for it —
 * never dropped, and never left as a pass. Silence from a test runner is the
 * most dangerous input this function gets: dropping the row would leave the
 * placeholder result in the database looking like a clean skip that somebody
 * chose, and marking it passed would be a green build over a test that may
 * never have been collected at all.
 *
 * Matching is by file first (`file` or `classname`, both of which runners fill
 * with a path) and by name second, because a Playwright `describe` block turns
 * one file into many cases with the same file and different names.
 */
export function mapReport(
  tests: readonly Pick<JobTest, 'id' | 'name' | 'filePath'>[],
  cases: readonly JunitCase[],
  note: string,
): ExecutionReport[] {
  const byPath = new Map<string, Pick<JobTest, 'id' | 'name' | 'filePath'>[]>();
  const byName = new Map<string, Pick<JobTest, 'id' | 'name' | 'filePath'>>();

  for (const test of tests) {
    const path = test.filePath.replace(/\\/g, '/');
    byPath.set(path, [...(byPath.get(path) ?? []), test]);
    byName.set(test.name, test);
  }

  const reports = new Map<string, ExecutionReport>();

  for (const testCase of cases) {
    const candidatePaths = [testCase.file, testCase.classname]
      .map((v) => v.replace(/\\/g, '/'))
      .filter(Boolean);

    let test = byName.get(testCase.name);
    if (!test) {
      for (const path of candidatePaths) {
        const matches = byPath.get(path) ?? byPath.get(path.replace(/^\.\//, ''));
        if (matches && matches.length > 0) {
          test = matches[0];
          break;
        }
      }
    }
    if (!test) continue; // a case for something we did not send; the server drops it

    const existing = reports.get(test.id);
    const status: TestResultStatus =
      testCase.status === 'PASSED' ? 'PASSED' : testCase.status === 'SKIPPED' ? 'SKIPPED' : 'FAILED';

    if (!existing) {
      reports.set(test.id, {
        ...skeleton(test.id),
        status,
        durationMs: testCase.durationMs,
        errorMessage: testCase.message ?? testCase.detail,
        steps:
          testCase.status === 'FAILED'
            ? [
                {
                  index: 0,
                  title: testCase.name || test.name,
                  status: 'FAILED',
                  durationMs: testCase.durationMs,
                  error: {
                    message: testCase.message ?? 'The test failed.',
                    stack: testCase.detail,
                  },
                },
              ]
            : [],
      });
      continue;
    }

    /*
     * A second case for the same test is a retry (Playwright emits one per
     * attempt). Per §5 a retry that passes is NOT a pass — it is a flake
     * candidate — so the pass is recorded with the flag set rather than
     * quietly overwriting the failure that preceded it.
     */
    existing.durationMs += testCase.durationMs;
    if (existing.status === 'FAILED' && status === 'PASSED') {
      existing.status = 'PASSED';
      existing.retriedAndPassed = true;
    } else if (status === 'FAILED') {
      existing.status = 'FAILED';
      existing.errorMessage = testCase.message ?? testCase.detail ?? existing.errorMessage;
    }
  }

  return tests.map((test) => {
    const reported = reports.get(test.id);
    if (reported) return reported;
    return { ...skeleton(test.id), errorMessage: note };
  });
}

// ─── Capability probing ──────────────────────────────────────────────────────

/** Binaries worth asking about, named as the server's requirements name them. */
const PROBE_BINARIES = ['node', 'npx', 'k6', 'psql', 'appium', 'python3', 'java', 'docker'];

/** Run `<binary> --version` and answer only "is it there". */
async function hasBinary(binary: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    // No shell. `binary` comes from the constant above, but the habit is the
    // point: a shell here would make every future addition an injection risk.
    const child = spawn(binary, ['--version'], { shell: false, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveProbe(false);
    }, 5_000);
    timer.unref?.();

    child.on('error', () => {
      clearTimeout(timer);
      resolveProbe(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveProbe(code === 0);
    });
  });
}

/**
 * Which Playwright browsers are actually installed.
 *
 * Read off the browser cache directory rather than by asking Playwright,
 * because asking would mean depending on it. The directory names are
 * `chromium-1234`, `firefox-5678`, `webkit-9012` and have been for years.
 */
export function browsersFromCacheEntries(entries: readonly string[]): string[] {
  const found = new Set<string>();
  for (const entry of entries) {
    const match = /^(chromium|firefox|webkit)(?:_headless_shell)?-\d+$/.exec(entry);
    if (match) found.add(match[1]!);
  }
  return [...found];
}

function playwrightCacheDir(): string {
  const override = env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== '0') return override;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return join(homedir(), 'AppData', 'Local', 'ms-playwright');
  return join(homedir(), '.cache', 'ms-playwright');
}

export interface ReportedCapabilities {
  browsers: string[];
  testTypes?: string[];
  languages?: string[];
  toolchains: string[];
  maxConcurrency: number;
}

/**
 * What this host can do, discovered locally.
 *
 * Everything here is measured on this machine. Nothing the server said is
 * consulted, because capabilities are the input to the server's decision about
 * what to send — a runner that could describe itself from a server-supplied
 * list would be a runner that could be told it supports something it does not.
 */
export async function probeCapabilities(config: RunnerConfig): Promise<ReportedCapabilities> {
  const declared = config.capabilities;

  let browsers = declared.browsers ?? [];
  if (browsers.length === 0) {
    const entries = await readdir(playwrightCacheDir()).catch(() => [] as string[]);
    browsers = browsersFromCacheEntries(entries);
  }

  let toolchains = declared.toolchains ?? [];
  if (toolchains.length === 0) {
    const present = await Promise.all(
      PROBE_BINARIES.map(async (binary) => ((await hasBinary(binary)) ? binary : null)),
    );
    toolchains = present.filter((v): v is string => v !== null);
  }

  /*
   * The terminal capability is DERIVED, never declared.
   *
   * The server opens a session only if this list contains `terminal`, and it
   * does that because a session on an agent that will not poll for commands is
   * a prompt that hangs forever — the exact fake shell the whole feature was
   * not allowed to be. So the flag has to mean "this process will pick up
   * commands", which is a fact about the code and the config, not a string an
   * operator can put in `capabilities.toolchains`. It is therefore added when
   * the terminal is on and REMOVED when it is off, even if it was declared:
   * declaring it while it is disabled recreates precisely the hang the gate
   * exists to prevent.
   */
  toolchains = toolchains.filter((tool) => tool !== TERMINAL_TOOLCHAIN);
  if (config.terminal.enabled) toolchains = [...toolchains, TERMINAL_TOOLCHAIN];

  return {
    browsers,
    // Omitted unless configured. The server reads an empty testTypes list as
    // "did not say" rather than "refuses everything", which is what lets an
    // agent be useful before anyone has tuned it.
    ...(declared.testTypes && declared.testTypes.length > 0
      ? { testTypes: declared.testTypes }
      : {}),
    ...(declared.languages && declared.languages.length > 0
      ? { languages: declared.languages }
      : {}),
    toolchains,
    maxConcurrency: declared.maxConcurrency ?? 1,
  };
}

// ─── Backoff ─────────────────────────────────────────────────────────────────

/**
 * How long to wait after a failed poll.
 *
 * Exponential with a ceiling and full jitter. The jitter is not decoration: a
 * fleet of forty agents that all lost the API during a deploy would otherwise
 * come back in lockstep and hold it down.
 */
export function backoffMs(consecutiveFailures: number, random = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, consecutiveFailures - 1));
  return Math.round(base / 2 + random() * (base / 2));
}

// ─── The HTTP channel ────────────────────────────────────────────────────────

export interface ApiResponse {
  status: number;
  json: unknown;
}

/**
 * One request to the pinned origin.
 *
 * Two non-negotiables, both learned the expensive way elsewhere in this
 * codebase: a 3xx is an error rather than a hop (following it would re-send the
 * Authorization header to whatever Location named), and no response body is
 * ever logged.
 */
async function request(
  endpoint: PinnedEndpoint,
  token: string,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    raw?: Buffer;
    contentType?: string;
    timeoutMs?: number;
    /** Extra headers. Merged first, so nothing here can replace the token. */
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    ...(init.headers ?? {}),
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'user-agent': 'qaai-runner',
  };
  if (init.raw) headers['content-type'] = init.contentType ?? 'application/octet-stream';
  else if (init.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(endpoint.url(path), {
      method: init.method ?? 'POST',
      headers,
      body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
      redirect: 'manual',
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'TimeoutError' ? 'did not answer in time' : 'was unreachable';
    throw new RunnerError(`QAAI at ${endpoint.origin} ${reason}.`);
  }

  if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
    throw new RunnerError(
      `QAAI answered with a redirect, and this agent will not follow one while holding a runner token. ` +
        `Point --api-url straight at ${endpoint.origin}.`,
    );
  }

  let json: unknown = null;
  try {
    const text = await response.text();
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return { status: response.status, json };
}

function errorMessageOf(json: unknown, fallback: string): string {
  const error = json && typeof json === 'object' ? (json as Record<string, unknown>).error : null;
  const message = error && typeof error === 'object' ? (error as Record<string, unknown>).message : null;
  return typeof message === 'string' ? message : fallback;
}

// ─── The terminal channel ────────────────────────────────────────────────────

/** What `POST /terminal/agent/jobs/:jobId/next` hands back. */
interface NextCommandResponse {
  session: { id: string; expiresAt: string } | null;
  command: { id: string; argv: string[]; timeoutSeconds: number; maxOutputBytes: number } | null;
  pollSeconds: number;
}

/**
 * Ceilings the agent applies to whatever the server asks for.
 *
 * The server sends a timeout and an output cap, and today they are 30s and
 * 256KB. They are still clamped here, because "the server said so" is not a
 * reason to let a process run on somebody else's machine for an hour: the
 * numbers arrive over the network from a component that can be wrong, and the
 * agent is the one that has to live with the consequence.
 */
const AGENT_MAX_COMMAND_MS = 60_000;
const AGENT_MAX_OUTPUT_BYTES = 512 * 1024;

export interface TerminalChannelOptions {
  /** Authenticated, lease-stamped POST to the pinned origin. */
  call: (path: string, init?: { body?: unknown; timeoutMs?: number }) => Promise<ApiResponse>;
  jobId: string;
  /** The workspace: the same directory the executor ran in. */
  cwd: string;
  /** Already stripped of the run's secrets — see `terminalEnvironment`. */
  env: Record<string, string>;
  /** Values scrubbed from output on the way out. */
  redact?: readonly string[];
  log: (line: string) => void;
  /** Only tests pass these. */
  sleep?: (ms: number) => Promise<void>;
  idlePollMs?: number;
}

/**
 * Poll for shell commands while this agent holds a job, run them, report back.
 *
 * This is the half the feature was missing: the server has been able to queue a
 * command since the last wave, and nothing was draining the queue. The refusal
 * at the door (`TERMINAL_CAPABILITY` in lib/pty.ts) was honest about that; this
 * class is what makes advertising the capability true.
 *
 * ── Cadence ──────────────────────────────────────────────────────────────────
 *
 * The server suggests 15s, which is the heartbeat interval and the right answer
 * for the common case: almost no run ever has a shell open, and forty agents
 * polling a shell endpoint they will never need is pure cost. So the idle
 * cadence is the server's, and the moment a session appears on this job the
 * cadence drops to one second — somebody is sitting at a prompt, and fifteen
 * seconds to see the output of `pwd` is a tool people stop using. One request
 * per second, for at most ten minutes, for at most five sessions per org, is a
 * cost worth paying for a debugging tool that feels like one. After a command
 * finishes we poll immediately, because the next one is usually already typed.
 *
 * ── Failure is not fatal ─────────────────────────────────────────────────────
 *
 * Nothing this class does may cost the job its results. A poll that fails is
 * retried on the next tick; a poll that comes back 409 means the lease is gone
 * and the channel stops (the executor's own heartbeat is the thing that
 * notices, and it says so once). The one case that stops it permanently is a
 * 401, which will not fix itself.
 */
export class TerminalChannel {
  private stopping = false;
  private readonly aborts = new AbortController();
  private loop: Promise<void> | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private wake: (() => void) | null = null;

  constructor(private readonly options: TerminalChannelOptions) {
    this.sleep = options.sleep ?? sleep;
  }

  start(): void {
    if (this.loop) return;
    this.loop = this.run().catch((err: unknown) => {
      this.options.log(
        `terminal channel stopped: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * Stop, and take any running command with us.
   *
   * Called from the job's `finally`, immediately before the workspace is
   * removed. A command still reading a file in a directory that is about to be
   * deleted is the reason this aborts rather than waits.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.aborts.abort();
    this.wake?.();
    await this.loop?.catch(() => {});
    this.loop = null;
  }

  private async pause(ms: number): Promise<void> {
    // Racing a wake-up against the timer is what makes `stop()` prompt: without
    // it a shutdown waits out a full idle poll before the process can exit.
    await Promise.race([
      this.sleep(ms),
      new Promise<void>((resolveWake) => {
        this.wake = resolveWake;
      }),
    ]);
    this.wake = null;
  }

  private async run(): Promise<void> {
    const idle = Math.max(1_000, this.options.idlePollMs ?? 15_000);
    // The first poll is immediate. A session can only be opened against a job
    // that is already running, so by the time this channel exists somebody may
    // already be waiting at a prompt, and one request per job is a cheap way
    // not to make them wait out a full idle interval for their first command.
    let wait = 0;

    while (!this.stopping) {
      await this.pause(wait);
      if (this.stopping) return;

      let response: ApiResponse;
      try {
        response = await this.options.call(
          `/terminal/agent/jobs/${encodeURIComponent(this.options.jobId)}/next`,
          // Shorter than the default. This endpoint answers out of memory plus
          // one indexed read, so ten seconds is already generous — and it is
          // what bounds how long a finishing job can be held up by a poll that
          // is in flight when the executor finishes.
          { timeoutMs: 10_000 },
        );
      } catch {
        // Unreachable API, a proxy blip, a VPN reconnect. The job's own
        // heartbeat is the thing that decides whether this runner is still
        // alive; a failed shell poll just waits.
        wait = idle;
        continue;
      }

      if (response.status === 401 || response.status === 409) {
        // 401: the token was rotated or revoked. 409: the lease is gone and
        // another runner has this job. Neither improves by asking again, and
        // the session the server had is already being closed on its side.
        return;
      }
      if (response.status !== 200) {
        wait = idle;
        continue;
      }

      const next = (response.json ?? {}) as Partial<NextCommandResponse>;
      const serverIdle = Math.max(1_000, Math.round((next.pollSeconds ?? 15) * 1000));

      if (!next.session) {
        wait = serverIdle;
        continue;
      }
      if (!next.command) {
        // A prompt is open with nothing queued: somebody is typing.
        wait = 1_000;
        continue;
      }

      if (this.stopping) return;
      await this.execute(next.command);
      // Straight back round. The next command is usually already typed.
      wait = 0;
    }
  }

  private async execute(command: NonNullable<NextCommandResponse['command']>): Promise<void> {
    const commandId = String(command.id ?? '');
    if (!commandId) return;

    const base = `/terminal/agent/jobs/${encodeURIComponent(this.options.jobId)}/commands/${encodeURIComponent(commandId)}`;

    const outcome = await runShellCommand({
      argv: Array.isArray(command.argv) ? command.argv : [],
      cwd: this.options.cwd,
      env: this.options.env,
      // Clamped, because these arrived over the network. `Number.isFinite`
      // rather than a default: a NaN would sail through `Math.min` and become
      // NaN, and a NaN timeout is a command with no timeout at all.
      timeoutMs: clamp(command.timeoutSeconds * 1000, 1_000, AGENT_MAX_COMMAND_MS, 30_000),
      maxOutputBytes: clamp(command.maxOutputBytes, 1_024, AGENT_MAX_OUTPUT_BYTES, 256 * 1024),
      ...(this.options.redact ? { redact: this.options.redact } : {}),
      signal: this.aborts.signal,
      onOutput: async (stream: OutputStream, chunk: string) => {
        const posted = await this.options.call(`${base}/output`, { body: { stream, chunk } });
        /*
         * Stop sending on anything but a clean accept. A 404 is the session
         * being gone — closed by its owner, reaped, or handed to another
         * runner — and `truncated` is the server saying it has hit its own cap
         * and is discarding what follows. Both mean the remaining output has
         * no reader, so it is not worth a customer's egress or our ingest.
         */
        if (posted.status !== 200) return 'stop';
        const body = (posted.json ?? {}) as { truncated?: boolean };
        return body.truncated ? 'stop' : undefined;
      },
    });

    // Worth the operator's log as well as the panel: a refusal here means the
    // server asked this host for something its own allowlist does not contain,
    // and that is a line somebody should be able to find later.
    if (outcome.notice) this.options.log(`terminal (${outcome.ended}): ${outcome.notice.trim()}`);

    /*
     * Always report an exit, even for a refusal or a kill.
     *
     * The session runs one command at a time and the server only clears the
     * slot when an exit arrives; a command we ran but never finished leaves the
     * user with a prompt that refuses everything they type until the sweep
     * abandons it thirty seconds later. So this is the one call in the channel
     * that is worth a retry, and it gets exactly one — enough to survive a
     * dropped connection, not enough to sit here while the job waits.
     */
    for (const attempt of [0, 1]) {
      try {
        const posted = await this.options.call(`${base}/exit`, {
          body: { exitCode: outcome.exitCode },
        });
        if (posted.status === 200 || posted.status === 404 || posted.status === 409) return;
      } catch {
        // fall through to the retry
      }
      if (attempt === 0 && !this.stopping) await this.sleep(500);
    }
    this.options.log(`terminal: could not report the exit of command ${commandId}`);
  }
}

/** A finite number in range, or the fallback. NaN never survives this. */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// ─── The agent ───────────────────────────────────────────────────────────────

export interface AgentOptions {
  endpoint: PinnedEndpoint;
  token: string;
  config: RunnerConfig;
  /** Print progress. Off in tests. */
  log?: (line: string) => void;
  /** Stop after this many claim cycles. Only tests pass it. */
  maxCycles?: number;
}

export class RunnerAgent {
  private stopping = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private held: { jobId: string; leaseId: string } | null = null;
  private readonly log: (line: string) => void;

  /**
   * Cached capability probe.
   *
   * Probing spawns a process per candidate binary. Doing that on every poll
   * would mean eight `--version` calls every twenty-five seconds, forever, on
   * a machine whose job is to build software — and the answer changes only
   * when somebody installs something. Five minutes is short enough that
   * `apt install k6` takes effect without a restart.
   */
  private probed: { at: number; capabilities: ReportedCapabilities } | null = null;
  private static readonly PROBE_TTL_MS = 5 * 60_000;

  constructor(private readonly options: AgentOptions) {
    this.log = options.log ?? ((line) => stderr.write(`${line}\n`));
  }

  private call(path: string, init?: Parameters<typeof request>[3]): Promise<ApiResponse> {
    return request(this.options.endpoint, this.options.token, path, init);
  }

  /**
   * A call about a job this agent is holding, fenced with its lease.
   *
   * Every `/runners/agent/jobs/*` and `/terminal/agent/jobs/*` endpoint calls
   * `requireLease`, which reads the lease out of `x-qaai-lease` and refuses
   * without it. This agent held the lease id and never sent it, so every
   * heartbeat, result batch, artifact and completion was answered 400 — the
   * fence the server describes was not being presented by the only process
   * that has one. Sending it here, in one place, rather than at each call site,
   * so a new job-scoped endpoint cannot be added without it.
   */
  private jobCall(
    leaseId: string,
    path: string,
    init?: Parameters<typeof request>[3],
  ): Promise<ApiResponse> {
    return this.call(path, { ...init, headers: { ...(init?.headers ?? {}), 'x-qaai-lease': leaseId } });
  }

  private async capabilities(): Promise<ReportedCapabilities> {
    if (this.probed && Date.now() - this.probed.at < RunnerAgent.PROBE_TTL_MS) {
      return this.probed.capabilities;
    }
    const capabilities = await probeCapabilities(this.options.config);
    this.probed = { at: Date.now(), capabilities };
    return capabilities;
  }

  /** Introduce ourselves and report what this host can do. */
  async hello(): Promise<void> {
    const capabilities = await this.capabilities();
    const response = await this.call('/runners/agent/hello', {
      body: { capabilities, agentVersion: '0.1.0', platform: `${process.platform}-${process.arch}` },
    });

    if (response.status === 401) {
      throw new RunnerError(
        'QAAI rejected the runner token. Check QAAI_RUNNER_TOKEN, or rotate the runner in Settings → Runners.',
      );
    }
    if (response.status !== 200) {
      throw new RunnerError(errorMessageOf(response.json, `QAAI answered ${response.status}.`));
    }

    this.log(
      `connected to ${this.options.endpoint.origin} — browsers: ${
        capabilities.browsers.join(', ') || 'none detected'
      }; tools: ${capabilities.toolchains.join(', ') || 'none detected'}`,
    );

    /*
     * Said out loud, every start, whichever way it is set. This is the one
     * line that tells the person running the agent that people in their QAAI
     * org can execute commands on this host — and the one that tells them the
     * shape of it, so "a shell into our build machine" is met with what it
     * actually is rather than what it sounds like.
     */
    this.log(
      this.options.config.terminal.enabled
        ? 'terminal sessions: ENABLED — while this agent is running a job, a MEMBER of your QAAI ' +
            'org can run read-only allowlisted commands (no writes, no network, no environment ' +
            'dump) in that job’s workspace on this host. Every command is audited. ' +
            'Set "terminal": false in the config, or QAAI_TERMINAL=off, to refuse.'
        : 'terminal sessions: disabled — QAAI will refuse to open a shell on this host.',
    );
  }

  /**
   * Poll, execute, repeat, until asked to stop.
   *
   * A failure to poll is never fatal: the API restarting, a proxy hiccup or a
   * VPN reconnect must not require someone to log into a build host and start a
   * service. Only an invalid token is fatal, because retrying that forever is
   * how an agent locks itself out and nobody notices.
   */
  async loop(): Promise<void> {
    let failures = 0;
    let cycles = 0;

    while (!this.stopping) {
      if (this.options.maxCycles !== undefined && cycles >= this.options.maxCycles) return;
      cycles += 1;

      try {
        const claimed = await this.claim();
        failures = 0;
        if (claimed) await this.execute(claimed);
      } catch (err) {
        if (err instanceof LeaseLostError) {
          // Not a failure of ours. The server reclaimed the work, which is the
          // system behaving exactly as designed.
          this.log(err.message);
          continue;
        }
        failures += 1;
        const wait = backoffMs(failures);
        this.log(
          `${err instanceof Error ? err.message : String(err)} — retrying in ${Math.round(wait / 1000)}s`,
        );
        await sleep(wait);
      }
    }
  }

  private async claim(): Promise<JobAssignment | null> {
    const capabilities = await this.capabilities();
    const response = await this.call('/runners/agent/claim', {
      body: { capabilities },
      // Longer than the server's own long-poll window, so a quiet queue times
      // out server-side with a clean 204 instead of client-side as an error.
      timeoutMs: 60_000,
    });

    if (response.status === 204) return null;
    if (response.status === 401) {
      throw new RunnerError('QAAI rejected the runner token; it may have been rotated or revoked.');
    }
    if (response.status !== 200) {
      throw new RunnerError(errorMessageOf(response.json, `Claim failed with ${response.status}.`));
    }

    const job = (response.json as { job?: JobAssignment } | null)?.job;
    if (!job || !job.jobId || !job.leaseId) throw new RunnerError('QAAI returned a job with no lease.');
    return job;
  }

  /** Execute one job, reporting everything that happens to it. */
  private async execute(job: JobAssignment): Promise<void> {
    this.held = { jobId: job.jobId, leaseId: job.leaseId };
    const root = resolve(this.options.config.workspaceRoot, job.jobId);

    this.startHeartbeat(job);
    this.log(
      `job ${job.jobId}: run ${job.runId}${
        job.shardIndex === null ? '' : ` shard ${job.shardIndex}`
      }, ${job.tests.length} test(s) against ${job.environment.baseUrl}`,
    );

    let completion: 'COMPLETED' | 'FAILED' = 'COMPLETED';
    let completionError: string | null = null;
    let shell: TerminalChannel | null = null;

    try {
      await materialiseWorkspace(root, job);
      const executor = executorFor(this.options.config, [...new Set(job.tests.map((t) => t.type))]);
      const childEnv = executorEnvironment(executor, job);

      /*
       * The shell channel starts AFTER the workspace exists and stops before it
       * is removed, because the workspace is the session's working directory.
       * It runs alongside the executor rather than after it — the whole point
       * is to look at the machine while the suite is on it — and it holds no
       * part of the job's own path: if it throws, the run still reports.
       */
      if (this.options.config.terminal.enabled) {
        shell = new TerminalChannel({
          call: (path, init) => this.jobCall(job.leaseId, path, init),
          jobId: job.jobId,
          cwd: root,
          env: terminalEnvironment(childEnv, Object.keys(job.secrets ?? {})),
          redact: [...Object.values(job.secrets ?? {}), this.options.token],
          log: this.log,
        });
        shell.start();
      }

      const outcome = await this.runExecutor(root, executor, job, childEnv);

      const reports = mapReport(job.tests, outcome.cases, outcome.note);
      await this.reportResults(job, reports);
      await this.uploadArtifacts(job, root);
    } catch (err) {
      if (err instanceof LeaseLostError) {
        this.stopHeartbeat();
        this.held = null;
        throw err;
      }
      completion = 'FAILED';
      completionError = err instanceof Error ? err.message : String(err);
      this.log(`job ${job.jobId} failed locally: ${completionError}`);
    } finally {
      this.stopHeartbeat();
      // Before the rm, always: a command reading a file in a directory that is
      // about to be deleted is how a session outlives the thing it was looking
      // at. `stop()` kills whatever is running, process tree and all.
      await shell?.stop();
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }

    await this.complete(job, completion, completionError);
    this.held = null;
  }

  /**
   * Spawn the operator's executor over the materialised workspace.
   *
   * The three security properties, in the three lines that provide them:
   * `shell: false` (no string is ever parsed by a shell), `command`/`args`
   * straight from the local config (nothing from the job payload is ever an
   * argv element), and secrets in the child's ENVIRONMENT rather than its
   * arguments (arguments are world-readable in `ps`).
   *
   * A missing executor is a SKIP with an actionable sentence, never a failure.
   * The application was never contacted; saying "failed" would send somebody
   * hunting a bug that does not exist.
   */
  private async runExecutor(
    root: string,
    executor: ExecutorSpec,
    job: JobAssignment,
    childEnv: Record<string, string>,
  ): Promise<{ cases: JunitCase[]; note: string }> {
    const result = await spawnExecutor(executor, root, childEnv);

    if (result.missing) {
      return {
        cases: [],
        note:
          `"${executor.command}" is not installed on runner host ${env.HOSTNAME ?? 'this machine'}, ` +
          `so these tests did not run. Install it and restart the agent — nothing about the application was tested.`,
      };
    }

    const reportPath = resolveWorkspacePath(root, executor.report);
    const xml = await readFile(reportPath, 'utf8').catch(() => null);

    if (xml === null) {
      return {
        cases: [],
        note:
          `${executor.command} exited ${result.code ?? 'without a status'} and wrote no report at ` +
          `${executor.report}, so no result could be read for these tests. ` +
          `Last output: ${result.stderr.slice(-500) || '(none)'}`,
      };
    }

    const cases = parseJunitXml(xml);
    return {
      cases,
      note:
        cases.length === 0
          ? `${executor.command} produced a report containing no test cases, so these tests have no result.`
          : `${executor.command} reported ${cases.length} case(s) but none matched this test.`,
    };
  }

  /** Stream results back in batches the API will accept. */
  private async reportResults(job: JobAssignment, reports: ExecutionReport[]): Promise<void> {
    const BATCH = 25;
    for (let i = 0; i < reports.length; i += BATCH) {
      const response = await this.jobCall(
        job.leaseId,
        `/runners/agent/jobs/${encodeURIComponent(job.jobId)}/results`,
        { body: { results: reports.slice(i, i + BATCH) } },
      );
      if (response.status === 409) {
        throw new LeaseLostError(errorMessageOf(response.json, 'The lease for this job was lost.'));
      }
      if (response.status !== 200) {
        throw new RunnerError(
          errorMessageOf(response.json, `Reporting results failed with ${response.status}.`),
        );
      }
    }
  }

  /**
   * Send back whatever the executor left in `artifacts/`.
   *
   * Best effort by design: an artifact that cannot be uploaded must never cost
   * the run its results, which have already been reported by the time this
   * runs. The failure is logged and the job still completes.
   */
  private async uploadArtifacts(job: JobAssignment, root: string): Promise<void> {
    const dir = join(root, 'artifacts');
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    let sent = 0;

    for (const entry of entries) {
      if (!entry.isFile() || sent >= 50) continue;
      const path = join(dir, entry.name);
      const info = await stat(path).catch(() => null);
      if (!info || info.size === 0 || info.size > 64 * 1024 * 1024) continue;

      const body = await readFile(path).catch(() => null);
      if (!body) continue;

      const response = await this.jobCall(
        job.leaseId,
        `/runners/agent/jobs/${encodeURIComponent(job.jobId)}/artifacts?name=${encodeURIComponent(entry.name)}`,
        { raw: body, timeoutMs: 120_000 },
      ).catch((err: unknown) => {
        this.log(`could not upload ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });

      if (response && response.status === 201) sent += 1;
    }
  }

  private async complete(
    job: JobAssignment,
    status: 'COMPLETED' | 'FAILED',
    errorMessage: string | null,
  ): Promise<void> {
    const response = await this.jobCall(
      job.leaseId,
      `/runners/agent/jobs/${encodeURIComponent(job.jobId)}/complete`,
      { body: { status, errorMessage } },
    ).catch((err: unknown) => {
      // The work is done and reported. Failing to say so costs the run its
      // lease timeout, not its results — so this is logged, not thrown.
      this.log(`could not mark job ${job.jobId} complete: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });

    if (response && response.status === 200) this.log(`job ${job.jobId} ${status.toLowerCase()}`);
  }

  private startHeartbeat(job: JobAssignment): void {
    const every = Math.max(5_000, (job.heartbeatSeconds || 15) * 1000);
    this.heartbeat = setInterval(() => {
      void this.jobCall(job.leaseId, `/runners/agent/jobs/${encodeURIComponent(job.jobId)}/heartbeat`)
        .then((response) => {
          if (response.status === 409) {
            /*
             * The lease is gone and another runner has the work. Stop
             * heartbeating immediately — continuing would be this process
             * insisting on a claim the server has already reassigned.
             */
            this.log(`lost the lease on job ${job.jobId}; another runner has it now`);
            this.stopHeartbeat();
          }
        })
        .catch(() => {
          // A missed heartbeat is not fatal on its own; the lease outlives
          // several. Silence here is deliberate — logging every blip on a
          // flaky VPN would bury the message that matters.
        });
    }, every);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /**
   * Stop, handing back anything held.
   *
   * Releasing is what makes a rolling restart cheap: without it every in-flight
   * job waits out a full lease before another agent may touch it.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.stopHeartbeat();
    if (!this.held) return;

    await this.jobCall(
      this.held.leaseId,
      `/runners/agent/jobs/${encodeURIComponent(this.held.jobId)}/release`,
    ).catch(() => {});
    this.log(`released job ${this.held.jobId} on shutdown`);
    this.held = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    timer.unref?.();
  });
}

/**
 * The environment the test runs in.
 *
 * Secrets go last, so a badly-chosen executor env key cannot shadow one, and
 * they go in the ENVIRONMENT rather than the arguments because arguments are
 * world-readable in `ps`.
 */
export function executorEnvironment(
  executor: ExecutorSpec,
  job: Pick<JobAssignment, 'environment' | 'runId' | 'determinism' | 'secrets'>,
  base: Record<string, string | undefined> = env,
): Record<string, string> {
  const childEnv: Record<string, string> = {
    ...(base as Record<string, string>),
    ...(executor.env ?? {}),
    QAAI_BASE_URL: job.environment.baseUrl,
    QAAI_RUN_ID: job.runId,
    QAAI_RANDOM_SEED: String(job.determinism.randomSeed),
  };
  for (const [name, value] of Object.entries(job.secrets ?? {})) childEnv[name] = value;
  return childEnv;
}

/**
 * The environment a TERMINAL command runs in: the test's, minus the credentials.
 *
 * The point of the feature is that the shell sees what the test saw, so this is
 * the executor's environment — the agent's own env, the executor's configured
 * additions, `QAAI_BASE_URL`, `QAAI_RUN_ID`, `QAAI_RANDOM_SEED`, and the
 * workspace as the working directory. Say it exactly, because the difference is
 * the interesting part:
 *
 *  - **The run's injected secrets are removed, by name.** They are the reason
 *    `env` and `printenv` are not on the allowlist at all, and the panel says
 *    so. But an allowlist is a list somebody will add to, and the day a command
 *    that prints an environment is added, the secrets should not be sitting
 *    there waiting. Removing them means the *only* way for a session to read
 *    one is for a test to have written it into the workspace — which is the
 *    customer's own file on the customer's own disk, and is redacted on the way
 *    out anyway.
 *  - **`QAAI_RUNNER_TOKEN` is removed.** It is this agent's credential, not the
 *    test's, and nothing the test does needs it. A shell that could read it
 *    could impersonate the runner.
 *  - **Everything else about the operator's machine is inherited unchanged**,
 *    including whatever else is in the agent's own environment. That is not an
 *    oversight: no allowlisted command prints an environment, and a heuristic
 *    that guessed which of the operator's own variables looked secret would be
 *    a blocklist — wrong in both directions and impossible to reason about.
 */
export function terminalEnvironment(
  full: Record<string, string>,
  secretNames: readonly string[],
): Record<string, string> {
  const hidden = new Set([...secretNames, 'QAAI_RUNNER_TOKEN']);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(full)) if (!hidden.has(name)) out[name] = value;
  return out;
}

export interface ExecutorOutcome {
  code: number | null;
  stderr: string;
  /** True when the binary itself is not installed — a SKIP, never a failure. */
  missing: boolean;
}

/** Spawn the executor. No shell, args as an array, cwd is the workspace. */
export async function spawnExecutor(
  executor: ExecutorSpec,
  cwd: string,
  childEnv: Record<string, string>,
): Promise<ExecutorOutcome> {
  return new Promise((resolveSpawn) => {
    const child = spawn(executor.command, executor.args, {
      cwd,
      env: childEnv,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrText = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      // Bounded: a runaway executor must not be able to exhaust this process's
      // memory with output nobody will read.
      if (stderrText.length < 64_000) stderrText += chunk.toString('utf8');
    });
    child.stdout?.on('data', () => {});

    const timer = setTimeout(
      () => child.kill('SIGKILL'),
      executor.timeoutMs ?? DEFAULT_EXECUTOR.timeoutMs!,
    );
    timer.unref?.();

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolveSpawn({ code: null, stderr: err.message, missing: err.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveSpawn({ code, stderr: stderrText, missing: false });
    });
  });
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export const RUNNER_HELP = `qaai runner — execute QAAI tests inside your own network

Usage:
  qaai runner [--api-url <url>] [--config <path>]

The agent makes only OUTBOUND https to the QAAI URL you give it. Nothing needs
to be opened inbound, and it never accepts an arbitrary command from the server
— it runs the executor named in your own config file.

Terminal sessions:
  While a job is running, a MEMBER of your QAAI org can open a terminal on it.
  That is NOT a shell: it is a fixed list of read-only commands (node/npm/npx
  --version, pwd, ls, cat, head, tail, uname, df, ps, git rev-parse|status|log)
  which this agent checks again itself and runs with no shell involved. Each one
  is bounded at 30s and 256KB of output, killed with its whole process tree, and
  audited against the user who typed it. It runs in that job's workspace, with
  the environment the test had MINUS the run's injected secrets and this agent's
  own token, and known secret values are stripped from the output.
  Turn it off with "terminal": false in the config file, or QAAI_TERMINAL=off.

Options:
  --api-url <url>     Your QAAI URL. Default: $QAAI_API_URL
  --config <path>     Runner config JSON. Default: ./qaai-runner.json
  --token-file <path> Read the runner token from a file
  --once              Claim at most one job, then exit (for cron-style hosts)

Environment:
  QAAI_RUNNER_TOKEN   The runner token. Preferred over a flag — a token on the
                      command line is visible to every process on the host.

Create a runner and its token in Settings → Runners.`;

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function readToken(args: string[]): Promise<string> {
  const file = flagValue(args, '--token-file');
  if (file) {
    const contents = await readFile(file, 'utf8').catch(() => {
      throw new RunnerError(`Could not read the runner token from ${file}.`);
    });
    return contents.trim();
  }

  const inline = flagValue(args, '--token');
  const token = (inline ?? env.QAAI_RUNNER_TOKEN ?? '').trim();
  if (!token) {
    throw new RunnerError(
      'No runner token. Set QAAI_RUNNER_TOKEN, or pass --token-file <path>. Create one in Settings → Runners.',
    );
  }
  return token;
}

export async function runnerMain(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    stdout.write(`${RUNNER_HELP}\n`);
    return 0;
  }

  const configPath = flagValue(args, '--config') ?? 'qaai-runner.json';
  const raw = await readFile(configPath, 'utf8').catch(() => null);
  const config = parseRunnerConfig(raw ? (JSON.parse(raw) as unknown) : {}, configPath);

  const apiUrl = flagValue(args, '--api-url') ?? env.QAAI_API_URL ?? config.apiUrl;
  const endpoint = pinEndpoint(apiUrl);
  const token = await readToken(args);

  const agent = new RunnerAgent({
    endpoint,
    token,
    config,
    ...(args.includes('--once') ? { maxCycles: 1 } : {}),
  });

  // A shutdown that hands its work back is the difference between a rolling
  // restart costing nothing and costing a lease timeout per agent.
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void agent.stop().finally(() => exit(0));
    });
  }

  await agent.hello();
  await agent.loop();
  return 0;
}

/* c8 ignore start — the process entry point, exercised by running the binary. */
const invokedDirectly =
  argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;

if (invokedDirectly) {
  runnerMain(argv.slice(2))
    .then((code) => exit(code))
    .catch((err: unknown) => {
      stderr.write(`${err instanceof RunnerError ? err.message : `Unexpected error: ${String(err)}`}\n`);
      exit(2);
    });
}
/* c8 ignore stop */
