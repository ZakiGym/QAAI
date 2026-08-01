/**
 * Mobile native testing (§4 MOBILE).
 *
 * `UI_FRAMEWORKS` has listed APPIUM, MAESTRO, DETOX, ESPRESSO and XCUITEST since
 * the beginning and not one of them had a plugin, so QAAI advertised mobile and
 * could not run a single mobile test. This is that plugin.
 *
 * Two execution models, chosen per driver for the same reason the rest of the
 * runner chooses them:
 *
 *  - **APPIUM is driven directly.** Its protocol is W3C WebDriver — JSON over
 *    HTTP — so a client is a fetch call and a session id, not a dependency. That
 *    buys per-step results: each tap, each assertion, each screenshot is its own
 *    cockpit step, so a broken checkout names the button that never appeared.
 *  - **The other four shell out to their own CLI.** Nobody should reimplement
 *    `xcodebuild`, Gradle's instrumentation runner, or Maestro's flow
 *    interpreter, and the report those tools already write is the one their
 *    users trust. Same build-vs-buy call the LOAD plugin makes with k6.
 *
 * **The skip paths are the feature.** A worker with no device attached is the
 * normal state of a CI box, and every one of these tools fails loudly and
 * ambiguously when it cannot find one. Every environment gap this plugin can
 * recognise — no Appium server listening, no device or simulator, a driver or
 * CLI that is not installed, capabilities that name no app, a farm credential
 * missing from the vault — is reported SKIPPED with a sentence naming the exact
 * thing to fix. Never FAILED: a mobile test that reports "your app is broken"
 * because the emulator was not running is worse than no mobile test at all.
 *
 * Security: farm credentials are read from the vault BY NAME and injected into
 * the capabilities blob, never into the endpoint URL, and the hub host is pinned
 * per provider (see `deviceFarmHub`) so a spec can never redirect an access key
 * to a host it names. CLI drivers are spawned WITHOUT a shell with args as an
 * array — a spec is org-authored data, and `shell: true` would make it RCE.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { MOBILE_DRIVERS, createMasker, maskDeep, mobileTestSpecSchema } from '@qaai/shared';
import type {
  AppiumMobileSpec,
  AppiumStep,
  ConsoleEntry,
  DetoxMobileSpec,
  EspressoMobileSpec,
  ExecutableTest,
  MaestroMobileSpec,
  MobileDeviceFarm,
  MobileDriver,
  MobileSelector,
  RunContext,
  RunnerPlugin,
  StepResult,
  TestExecution,
  TestResultStatus,
  XcuitestMobileSpec,
} from '@qaai/shared';
import { parseReport, summariseReport, toStepResults } from '../reports/index.js';
import type { ParsedReport, ReportTest } from '../reports/index.js';

/** Per-stream capture cap, matching the CLI and external plugins. */
const OUTPUT_LIMIT = 200_000;
/** One transcript line. Appium responses and Gradle logs are both chatty. */
const LOG_SNIPPET_LIMIT = 600;
const MAX_TRANSCRIPT_ENTRIES = 300;
/** How often an element lookup is retried while its timeout runs down. */
const POLL_INTERVAL_MS = 250;
/** Appium's own default bind address, which is what `appium` prints on start. */
const DEFAULT_APPIUM_SERVER = 'http://127.0.0.1:4723';

// ─── Small shared helpers ────────────────────────────────────────────────────

/** Substitutes {{NAME}} from the running variable bag. Unknown names are left alone. */
function interpolate(input: string, vars: Record<string, string>): string {
  return input.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => vars[name] ?? whole);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (+${text.length - limit} chars)`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The errno buried in a fetch failure, which is where the useful part lives. */
function errnoOf(err: unknown): string | null {
  const cause = (err as { cause?: unknown } | null)?.cause;
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** Guard: a spec-supplied path must stay inside the run workspace. */
function safeWorkspacePath(workspace: string, relPath: string): string {
  if (isAbsolute(relPath)) throw new Error(`"${relPath}" must be relative to the workspace`);
  const full = resolve(join(workspace, relPath));
  const root = resolve(workspace);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`"${relPath}" escapes the workspace`);
  }
  return full;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((done) => {
    const onAbort = () => {
      clearTimeout(timer);
      done();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      done();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ─── Step recording ──────────────────────────────────────────────────────────

/**
 * Accumulates steps and a transcript.
 *
 * `broken` is what stops a driver: once a tap has failed, the app is on an
 * unknown screen and every later assertion measures our own confusion, so the
 * remaining steps are recorded SKIPPED rather than run.
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

  /** Returns the step it recorded, so a caller can attach a screenshot to it. */
  record(
    title: string,
    startedAtMs: number,
    problems: string[],
    detail: { expected?: string | null; actual?: string | null } = {},
  ): StepResult {
    const failed = problems.length > 0;
    if (failed) this.failedAlready = true;
    const index = this.steps.length;
    const status = failed ? 'FAILED' : 'PASSED';
    this.ctx.logger.step({ testId: this.testId, index, title, status });
    const step: StepResult = {
      index,
      title,
      status,
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
    };
    this.steps.push(step);
    return step;
  }

  /**
   * A step that was not evaluated. The reason rides in the title because
   * `error` on a StepResult means "this failed", and none of these did.
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

  /** `↑` sent, `↓` received, `•` lifecycle. */
  log(direction: '↑' | '↓' | '•', text: string): void {
    if (this.transcript.length >= MAX_TRANSCRIPT_ENTRIES) return;
    this.transcript.push({
      level: 'log',
      text: `${direction} ${truncate(text, LOG_SNIPPET_LIMIT)}`,
      at: new Date().toISOString(),
    });
  }
}

function finish(
  test: ExecutableTest,
  startedAt: number,
  recorder: StepRecorder,
  secrets: Readonly<Record<string, string>>,
  extraSecretValues: string[] = [],
  override?: { status?: TestResultStatus; errorMessage?: string },
): TestExecution {
  // Farm credentials are resolved at run time and are not in `ctx.secrets` under
  // the name the spec used, so they are masked explicitly alongside the vault.
  const secretValues = [...Object.values(secrets), ...extraSecretValues];
  const steps = maskDeep(recorder.steps, secretValues);
  const firstFailure = steps.find((step) => step.status === 'FAILED');
  const ran = steps.some((step) => step.status !== 'SKIPPED');

  return {
    testId: test.id,
    status: override?.status ?? (firstFailure ? 'FAILED' : ran ? 'PASSED' : 'SKIPPED'),
    durationMs: Date.now() - startedAt,
    steps,
    network: [],
    console: maskDeep(recorder.transcript, secretValues),
    videoKey: null,
    traceKey: null,
    errorMessage: override?.errorMessage
      ? maskDeep(override.errorMessage, secretValues)
      : (firstFailure?.error?.message ?? null),
    retriedAndPassed: false,
    findings: [],
  };
}

// ─── Appium: the W3C wire ────────────────────────────────────────────────────

/**
 * The W3C element-id key. It is a literal UUID string in the spec, chosen to be
 * impossible to collide with; the older JSONWP key `ELEMENT` is still what some
 * drivers return, so both are read.
 */
export const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

/** Pulls an element id out of a find response in either protocol dialect. */
export function elementIdOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const w3c = record[W3C_ELEMENT_KEY];
  if (typeof w3c === 'string' && w3c !== '') return w3c;
  const legacy = record.ELEMENT;
  if (typeof legacy === 'string' && legacy !== '') return legacy;
  return null;
}

/**
 * The session id from a new-session response.
 *
 * W3C puts it at `value.sessionId`; JSONWP put it at the top level and used
 * `value` for the capabilities. Appium 2 speaks W3C, but a device farm's proxy
 * may still answer in the old shape and there is no cost to reading both.
 */
export function sessionIdOf(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const value = record.value;
  if (value !== null && typeof value === 'object') {
    const nested = (value as Record<string, unknown>).sessionId;
    if (typeof nested === 'string' && nested !== '') return nested;
  }
  const top = record.sessionId;
  return typeof top === 'string' && top !== '' ? top : null;
}

export interface WireError {
  /** The W3C error code, e.g. `no such element`, `session not created`. */
  error: string;
  message: string;
}

/**
 * Reads the error out of a WebDriver response.
 *
 * A W3C error is `{ value: { error, message, stacktrace } }` with a 4xx/5xx
 * status. JSONWP used a numeric `status` and put the human text in
 * `value.message`, which is still what a few farm proxies return.
 */
export function webdriverErrorOf(status: number, body: unknown): WireError | null {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const value =
    record.value !== null && typeof record.value === 'object'
      ? (record.value as Record<string, unknown>)
      : null;

  const code = value && typeof value.error === 'string' ? value.error : null;
  const message = value && typeof value.message === 'string' ? value.message : '';

  if (code) return { error: code, message };

  // JSONWP: any non-zero `status` is a failure, whatever the HTTP code says.
  const legacyStatus = typeof record.status === 'number' ? record.status : null;
  if (legacyStatus !== null && legacyStatus !== 0) {
    return { error: `status ${legacyStatus}`, message };
  }

  if (status >= 400) {
    return { error: `http ${status}`, message: message || JSON.stringify(body).slice(0, 300) };
  }
  return null;
}

interface WireResult {
  status: number | null;
  body: unknown;
  /** Set when the request never got an answer: connection refused, DNS, timeout. */
  transportError: string | null;
  durationMs: number;
}

/** One WebDriver request. Never throws — a transport failure is a result. */
async function wire(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body: unknown,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WireResult> {
  const began = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        accept: 'application/json',
      },
      body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      // A hub that redirects is a hub sending the session elsewhere; follow
      // nothing, because the next hop is where a credential would leak.
      redirect: 'manual',
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      // Some proxies answer HTML on an error. Keep it readable rather than
      // pretending the body was JSON.
      parsed = { value: { error: `http ${response.status}`, message: text.slice(0, 500) } };
    }
    return {
      status: response.status,
      body: parsed,
      transportError: null,
      durationMs: Date.now() - began,
    };
  } catch (err) {
    return {
      status: null,
      body: null,
      transportError: errnoOf(err) ?? errorText(err),
      durationMs: Date.now() - began,
    };
  }
}

// ─── Appium: endpoint and capabilities ───────────────────────────────────────

/**
 * Each provider's Appium hub, host-pinned.
 *
 * The host is NOT read from the spec. A spec is org-authored data that lives in
 * the customer's repo, and the vault access key travels in the capabilities of
 * the very first request — so an endpoint taken from the spec would be a
 * credential handed to whatever host the spec named. Same discipline
 * `apps/api/src/lib/git.ts` applies before it decrypts a push token.
 */
const DEVICE_FARM_HUBS: Record<MobileDeviceFarm['provider'], string | null> = {
  BROWSERSTACK: 'https://hub-cloud.browserstack.com/wd/hub',
  SAUCE_LABS: 'https://ondemand.us-west-1.saucelabs.com/wd/hub',
  LAMBDATEST: 'https://mobile-hub.lambdatest.com/wd/hub',
  // Perfecto's host is the customer's own cloud name; see `deviceFarmHub`.
  PERFECTO: null,
};

/** A single DNS label: what a Perfecto cloud name is allowed to be. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The hub URL for a provider.
 *
 * Perfecto is the one provider whose host varies per customer — it is
 * `<cloud>.perfectomobile.com`, and the cloud name is held in the username
 * secret exactly as `apps/worker/src/grids.ts` does it. That value is
 * interpolated into a hostname, so it is validated as a bare DNS label first:
 * a name containing a dot, a slash or an `@` would move the endpoint to another
 * domain entirely and take the security token with it.
 */
export function deviceFarmHub(provider: MobileDeviceFarm['provider'], username: string): string {
  const pinned = DEVICE_FARM_HUBS[provider];
  if (pinned) return pinned;

  const cloud = username.trim();
  if (!DNS_LABEL.test(cloud)) {
    throw new Error(
      `"${cloud}" is not a valid Perfecto cloud name — it must be the bare subdomain of your cloud, e.g. "acme" for acme.perfectomobile.com`,
    );
  }
  return `https://${cloud}.perfectomobile.com/nexperience/perfectomobile/wd/hub`;
}

/**
 * A self-hosted Appium server URL, validated.
 *
 * Credentials in the URL are refused rather than accepted quietly: putting
 * `https://user:key@…` in a spec is how an access key ends up committed to a
 * repository, and the vault exists so it does not have to be.
 */
export function appiumServerBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid Appium server URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('An Appium server URL must be http or https');
  }
  if (url.username || url.password) {
    throw new Error(
      'Remove the credentials from serverUrl — use deviceFarm with the vault secret names instead',
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Capabilities the W3C protocol defines for every driver. Everything else is a
 * vendor capability, and Appium rejects an unprefixed one outright — which is
 * the single most common reason a hand-written session never starts. So anything
 * unrecognised and unprefixed gets `appium:` rather than a confusing refusal.
 */
const W3C_STANDARD_CAPABILITIES = new Set([
  'browserName',
  'browserVersion',
  'platformName',
  'acceptInsecureCerts',
  'pageLoadStrategy',
  'proxy',
  'setWindowRect',
  'timeouts',
  'strictFileInteractability',
  'unhandledPromptBehavior',
  'webSocketUrl',
]);

export interface FarmCredentials {
  username: string;
  accessKey: string;
}

/**
 * The `alwaysMatch` capability blob for a session.
 *
 * Farm credentials go in the capabilities, never in the URL: process arguments
 * and URLs end up in logs, dashboards and error messages, and this way the one
 * place the key exists is a request body that is masked on the way out.
 */
export function buildCapabilities(
  spec: AppiumMobileSpec,
  vars: Record<string, string>,
  farm: { config: MobileDeviceFarm; credentials: FarmCredentials } | null,
): Record<string, unknown> {
  const caps: Record<string, unknown> = {
    platformName: spec.platform === 'IOS' ? 'iOS' : 'Android',
  };

  for (const [key, value] of Object.entries(spec.capabilities)) {
    const name = key.includes(':') || W3C_STANDARD_CAPABILITIES.has(key) ? key : `appium:${key}`;
    caps[name] = typeof value === 'string' ? interpolate(value, vars) : value;
  }

  if (spec.app !== undefined) caps['appium:app'] = interpolate(spec.app, vars);

  if (farm) {
    const { config, credentials } = farm;
    const existing = (key: string): Record<string, unknown> => {
      const current = caps[key];
      return current !== null && typeof current === 'object'
        ? { ...(current as Record<string, unknown>) }
        : {};
    };

    switch (config.provider) {
      case 'BROWSERSTACK': {
        caps['bstack:options'] = {
          ...existing('bstack:options'),
          userName: credentials.username,
          accessKey: credentials.accessKey,
          buildName: config.buildName,
          projectName: config.projectName,
        };
        break;
      }
      case 'SAUCE_LABS': {
        caps['sauce:options'] = {
          ...existing('sauce:options'),
          username: credentials.username,
          accessKey: credentials.accessKey,
          build: config.buildName,
          name: config.projectName,
        };
        break;
      }
      case 'LAMBDATEST': {
        caps['lt:options'] = {
          ...existing('lt:options'),
          user: credentials.username,
          accessKey: credentials.accessKey,
          build: config.buildName,
          project: config.projectName,
          isRealMobile: true,
        };
        break;
      }
      case 'PERFECTO': {
        // Perfecto authenticates with the token alone; the username is the cloud
        // name and has already been spent on the hostname.
        caps['perfecto:options'] = {
          ...existing('perfecto:options'),
          securityToken: credentials.accessKey,
        };
        break;
      }
    }
  }

  return caps;
}

/** Every capability key, including the ones nested in a `vendor:options` blob. */
function capabilityKeys(caps: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(caps)) {
    keys.push(key);
    if (key.endsWith(':options') && value !== null && typeof value === 'object') {
      keys.push(...Object.keys(value as Record<string, unknown>));
    }
  }
  return keys;
}

/**
 * Is there enough here to start a session at all?
 *
 * Checked before the request rather than after the refusal, because "session not
 * created" from a real server is a paragraph of driver internals, and the answer
 * — you did not say which device, or which app — is one sentence.
 */
export function missingCapabilityHint(caps: Record<string, unknown>): string | null {
  const keys = capabilityKeys(caps);
  const has = (pattern: RegExp): boolean => keys.some((key) => pattern.test(key));

  const hasApp = has(/(^|:)app$|appPackage|appActivity|bundleId|browserName/i);
  const hasDevice = has(/device|udid|avd|platformVersion/i);

  if (hasApp && hasDevice) return null;

  // Phrased as what is absent, not as a list of nouns: "the capabilities name a
  // device and an app" reads as the opposite of what happened.
  const missing: string[] = [];
  if (!hasDevice) missing.push('no device (`appium:deviceName`, or `appium:udid`)');
  if (!hasApp) missing.push('no app (`appium:app`, or `appium:appPackage` / `appium:bundleId`)');
  return `The capabilities name ${missing.join(' and ')}, so there is nothing to start a session on. Add ${missing.length > 1 ? 'them' : 'it'} to the spec's \`capabilities\` and re-run.`;
}

/**
 * Was the session refused because this worker has nothing to run on, or because
 * the app itself is broken?
 *
 * This is the judgement call the whole plugin turns on. An absent emulator, an
 * uninstalled driver and a farm credential that does not authenticate are all
 * configuration gaps: nothing about the customer's app was evaluated, so the
 * honest verdict is SKIPPED with the fix. Anything else — the app crashed on
 * launch, the install failed — is a real finding and stays FAILED.
 */
export function classifySessionFailure(error: WireError): {
  status: 'SKIPPED' | 'FAILED';
  message: string;
} {
  const text = `${error.error} ${error.message}`;
  const detail = truncate(error.message.trim() || error.error, 500);

  const gaps: Array<{ pattern: RegExp; hint: string }> = [
    {
      pattern:
        /could not find a connected|no devices? (are |is )?(connected|found|available)|no connected devices|device is not connected|adb devices/i,
      hint: 'No Android device is attached to the Appium server. Start an emulator (`emulator -avd <name>`) or connect a device (`adb devices` should list one), then re-run.',
    },
    {
      pattern:
        /unable to find an? (active )?(device|simulator)|no simulator|simulator .*not (found|booted)|could not find (a )?simulator|instruments|devicectl/i,
      hint: 'No iOS simulator or device is available to the Appium server. Boot one (`xcrun simctl list devices`, then `xcrun simctl boot <udid>`) and re-run.',
    },
    {
      pattern:
        /unknown automation name|automationname|could not (find|load) (a |the )?driver|driver .*(is )?not installed|no driver (found|installed)/i,
      hint: 'The Appium server has no driver for this automation. Install it on the server — `appium driver install uiautomator2` for Android, `appium driver install xcuitest` for iOS — and re-run.',
    },
    {
      pattern:
        /the app(lication)? at .* (does not exist|is not accessible)|app file .* (does not exist|not found)|could not find (the )?app(lication)? (at|file)|no such file or directory.*\.(apk|app|ipa)/i,
      hint: 'The app binary the capabilities point at is not on this worker. Build or download it into the workspace first, then re-run.',
    },
    {
      pattern:
        /(invalid or unsupported|missing|required).{0,30}capabilit|the following required capabilit/i,
      hint: 'The Appium server refused these capabilities. Fix the spec’s `capabilities` to match what the driver requires and re-run.',
    },
    {
      pattern:
        /authoriz|authenticat|invalid (username|credentials|access key)|access[_ ]?key|forbidden|401|403/i,
      hint: 'The device farm rejected the credentials. Check the values behind the secret names in the spec’s `deviceFarm` and re-run.',
    },
  ];

  for (const gap of gaps) {
    if (gap.pattern.test(text)) {
      return { status: 'SKIPPED', message: `${gap.hint} The server said: ${detail}` };
    }
  }

  // Not a gap we recognise. The app or its build is implicated, so this is a
  // real result — refusing to guess is better than a false SKIPPED that hides a
  // launch crash.
  return {
    status: 'FAILED',
    message: `Appium could not start a session (${error.error}): ${detail}`,
  };
}

// ─── Appium: the session driver ──────────────────────────────────────────────

/** A live session, plus everything a step needs to talk to it. */
interface Session {
  base: string;
  id: string;
  timeoutMs: number;
  signal: AbortSignal;
}

function sessionUrl(session: Session, path: string): string {
  return `${session.base}/session/${encodeURIComponent(session.id)}${path}`;
}

interface Found {
  id: string | null;
  error: WireError | null;
  transportError: string | null;
}

/**
 * Find an element, retrying until the deadline.
 *
 * Polling rather than the driver's implicit wait: an implicit wait is a session
 * setting that leaks into every later command, and a test that sets it once has
 * no way to say "this element should be gone" without waiting the full timeout.
 */
async function findElement(
  session: Session,
  selector: MobileSelector,
  vars: Record<string, string>,
  timeoutMs: number,
): Promise<Found> {
  const deadline = Date.now() + timeoutMs;
  const body = { using: selector.using, value: interpolate(selector.value, vars) };
  let last: Found = { id: null, error: null, transportError: null };

  for (;;) {
    const result = await wire(
      'POST',
      sessionUrl(session, '/element'),
      body,
      session.timeoutMs,
      session.signal,
    );
    if (result.transportError !== null) {
      return { id: null, error: null, transportError: result.transportError };
    }

    const failure = webdriverErrorOf(result.status ?? 0, result.body);
    if (!failure) {
      const id = elementIdOf((result.body as { value?: unknown } | null)?.value);
      if (id) return { id, error: null, transportError: null };
      last = {
        id: null,
        error: { error: 'no such element', message: 'the driver returned no element id' },
        transportError: null,
      };
    } else {
      last = { id: null, error: failure, transportError: null };
      // A stale session or a dead driver will not fix itself; only keep
      // retrying the one error that means "not on screen yet".
      if (!/no such element|element not found/i.test(failure.error)) return last;
    }

    if (Date.now() + POLL_INTERVAL_MS >= deadline || session.signal.aborted) return last;
    await sleep(POLL_INTERVAL_MS, session.signal);
  }
}

/** Renders a selector the way a person wrote it, for step titles and errors. */
function describeSelector(selector: MobileSelector): string {
  return `${selector.using}=${selector.value}`;
}

/** A one-line summary of why a wire call failed, for a step's error message. */
function wireProblem(result: WireResult, what: string): string | null {
  if (result.transportError !== null) {
    return `${what} could not reach the Appium server (${result.transportError})`;
  }
  const failure = webdriverErrorOf(result.status ?? 0, result.body);
  if (failure) {
    return `${what} failed: ${failure.error}${failure.message ? ` — ${truncate(failure.message, 300)}` : ''}`;
  }
  return null;
}

/** The `value` of a successful response. */
function wireValue(result: WireResult): unknown {
  return (result.body as { value?: unknown } | null)?.value ?? null;
}

async function captureScreenshot(
  ctx: RunContext,
  session: Session,
  name: string,
): Promise<string | null> {
  const result = await wire(
    'GET',
    sessionUrl(session, '/screenshot'),
    undefined,
    session.timeoutMs,
    session.signal,
  );
  const value = wireValue(result);
  if (typeof value !== 'string' || value === '') return null;
  try {
    return await ctx.artifacts.put(name, Buffer.from(value, 'base64'), 'image/png');
  } catch {
    // A screenshot is evidence, not the result. Losing one must never change a
    // verdict or take the run down with it.
    return null;
  }
}

/** Screen size in pixels, so a spec can express a swipe in fractions. */
async function windowSize(session: Session): Promise<{ width: number; height: number } | null> {
  const result = await wire(
    'GET',
    sessionUrl(session, '/window/rect'),
    undefined,
    session.timeoutMs,
    session.signal,
  );
  const value = wireValue(result);
  if (value === null || typeof value !== 'object') return null;
  const { width, height } = value as { width?: unknown; height?: unknown };
  return typeof width === 'number' && typeof height === 'number' ? { width, height } : null;
}

async function runAppiumStep(
  ctx: RunContext,
  session: Session,
  step: AppiumStep,
  vars: Record<string, string>,
  recorder: StepRecorder,
): Promise<void> {
  const began = Date.now();

  if (step.action === 'WAIT') {
    await sleep(step.ms, session.signal);
    recorder.record(`${step.name} — wait ${step.ms}ms`, began, []);
    return;
  }

  if (step.action === 'PRESS_BACK') {
    const result = await wire(
      'POST',
      sessionUrl(session, '/back'),
      {},
      session.timeoutMs,
      session.signal,
    );
    const problem = wireProblem(result, 'Pressing back');
    recorder.record(`${step.name} — press back`, began, problem ? [problem] : []);
    return;
  }

  if (step.action === 'SCREENSHOT') {
    const key = await captureScreenshot(ctx, session, `mobile-${step.name}.png`);
    const recorded = recorder.record(
      `${step.name} — screenshot`,
      began,
      key ? [] : ['The driver returned no screenshot'],
    );
    recorded.screenshotKey = key;
    return;
  }

  if (step.action === 'SWIPE') {
    const size = await windowSize(session);
    if (!size) {
      recorder.record(`${step.name} — swipe`, began, [
        'Could not read the screen size from the driver, so the swipe had no coordinates',
      ]);
      return;
    }
    const at = (fx: number, fy: number) => ({
      x: Math.round(fx * size.width),
      y: Math.round(fy * size.height),
    });
    const from = at(step.fromX, step.fromY);
    const to = at(step.toX, step.toY);
    // The W3C actions API, which is the only gesture protocol both drivers
    // implement the same way — `mobile: swipe` differs per platform.
    const result = await wire(
      'POST',
      sessionUrl(session, '/actions'),
      {
        actions: [
          {
            type: 'pointer',
            id: 'finger1',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x: from.x, y: from.y },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: 100 },
              { type: 'pointerMove', duration: step.durationMs, x: to.x, y: to.y },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      },
      session.timeoutMs,
      session.signal,
    );
    const problem = wireProblem(result, 'The swipe');
    recorder.record(
      `${step.name} — swipe (${from.x},${from.y}) → (${to.x},${to.y})`,
      began,
      problem ? [problem] : [],
    );
    return;
  }

  // Everything below targets an element.
  const where = describeSelector(step.selector);
  const found = await findElement(session, step.selector, vars, step.timeoutMs);

  if (found.transportError !== null) {
    recorder.record(`${step.name} — ${where}`, began, [
      `Lost the Appium server while looking for ${where} (${found.transportError})`,
    ]);
    return;
  }

  if (step.action === 'ASSERT_VISIBLE' && !step.visible) {
    // "Should be gone" is satisfied by an element that is absent OR present and
    // not displayed; both are what a person means by "not on screen". An absent
    // element costs the full timeout, because the only way to know a thing did
    // not appear is to have waited for it.
    if (found.id === null) {
      recorder.record(`${step.name} — ${where} is not visible`, began, []);
      return;
    }
    const shown = await wire(
      'GET',
      sessionUrl(session, `/element/${encodeURIComponent(found.id)}/displayed`),
      undefined,
      session.timeoutMs,
      session.signal,
    );
    const displayed = wireValue(shown) === true;
    recorder.record(
      `${step.name} — ${where} is not visible`,
      began,
      displayed ? [`${where} is still on screen`] : [],
      { expected: 'not visible', actual: displayed ? 'visible' : 'not visible' },
    );
    return;
  }

  if (found.id === null) {
    const detail = found.error
      ? `${found.error.error}${found.error.message ? ` — ${truncate(found.error.message, 300)}` : ''}`
      : 'no element matched';
    recorder.record(
      `${step.name} — ${where}`,
      began,
      [`No element matched ${where} within ${step.timeoutMs}ms (${detail})`],
      { expected: `an element matching ${where}`, actual: 'nothing on screen matched' },
    );
    return;
  }

  const elementPath = `/element/${encodeURIComponent(found.id)}`;

  switch (step.action) {
    case 'TAP': {
      const result = await wire(
        'POST',
        sessionUrl(session, `${elementPath}/click`),
        {},
        session.timeoutMs,
        session.signal,
      );
      const problem = wireProblem(result, `Tapping ${where}`);
      recorder.record(`${step.name} — tap ${where}`, began, problem ? [problem] : []);
      return;
    }

    case 'TYPE': {
      const problems: string[] = [];
      if (step.clearFirst) {
        const cleared = await wire(
          'POST',
          sessionUrl(session, `${elementPath}/clear`),
          {},
          session.timeoutMs,
          session.signal,
        );
        const problem = wireProblem(cleared, `Clearing ${where}`);
        if (problem) problems.push(problem);
      }
      if (problems.length === 0) {
        const text = interpolate(step.text, vars);
        const result = await wire(
          'POST',
          sessionUrl(session, `${elementPath}/value`),
          // `text` is the W3C field; `value` is what older Appium drivers read.
          // Sending both is what every mainstream client does.
          { text, value: [...text] },
          session.timeoutMs,
          session.signal,
        );
        const problem = wireProblem(result, `Typing into ${where}`);
        if (problem) problems.push(problem);
      }
      recorder.record(`${step.name} — type into ${where}`, began, problems);
      return;
    }

    case 'ASSERT_VISIBLE': {
      const shown = await wire(
        'GET',
        sessionUrl(session, `${elementPath}/displayed`),
        undefined,
        session.timeoutMs,
        session.signal,
      );
      const transport = wireProblem(shown, `Reading the visibility of ${where}`);
      const displayed = wireValue(shown) === true;
      recorder.record(
        `${step.name} — ${where} is visible`,
        began,
        transport ? [transport] : displayed ? [] : [`${where} is present but not displayed`],
        { expected: 'visible', actual: displayed ? 'visible' : 'not displayed' },
      );
      return;
    }

    case 'ASSERT_TEXT': {
      const result = await wire(
        'GET',
        sessionUrl(session, `${elementPath}/text`),
        undefined,
        session.timeoutMs,
        session.signal,
      );
      const transport = wireProblem(result, `Reading the text of ${where}`);
      if (transport) {
        recorder.record(`${step.name} — text of ${where}`, began, [transport]);
        return;
      }
      const value = wireValue(result);
      const actual = typeof value === 'string' ? value : String(value ?? '');
      const problems: string[] = [];
      let expected: string | null = null;

      if (step.equals !== undefined) {
        const want = interpolate(step.equals, vars);
        if (actual !== want) {
          problems.push(
            `${where} reads ${JSON.stringify(actual)}, expected ${JSON.stringify(want)}`,
          );
          expected = want;
        }
      }
      if (step.contains !== undefined) {
        const want = interpolate(step.contains, vars);
        if (!actual.includes(want)) {
          problems.push(`${where} does not contain ${JSON.stringify(want)}`);
          expected ??= `text containing ${want}`;
        }
      }
      recorder.record(`${step.name} — text of ${where}`, began, problems, {
        expected,
        actual: problems.length > 0 ? actual : null,
      });
      return;
    }
  }
}

async function runAppium(
  ctx: RunContext,
  test: ExecutableTest,
  spec: AppiumMobileSpec,
  startedAt: number,
): Promise<TestExecution> {
  const recorder = new StepRecorder(ctx, test.id);
  const vars: Record<string, string> = { ...ctx.secrets, ...spec.variables };
  const farmSecrets: string[] = [];

  const skipped = (message: string): TestExecution =>
    finish(test, startedAt, recorder, ctx.secrets, farmSecrets, {
      status: 'SKIPPED',
      errorMessage: message,
    });

  // ─ Endpoint and credentials, before anything is sent ─────────────────────
  let base: string;
  let farm: { config: MobileDeviceFarm; credentials: FarmCredentials } | null = null;

  if (spec.deviceFarm) {
    const config = spec.deviceFarm;
    const username = ctx.secrets[config.usernameSecretName];
    const accessKey = ctx.secrets[config.accessKeySecretName];

    if (username === undefined || accessKey === undefined) {
      const missing = [
        username === undefined ? config.usernameSecretName : null,
        accessKey === undefined ? config.accessKeySecretName : null,
      ].filter((name): name is string => name !== null);
      return skipped(
        `The ${config.provider} credentials are not on this environment: add ${missing.join(' and ')} as secret${missing.length > 1 ? 's' : ''} and re-run. No session was started.`,
      );
    }

    farmSecrets.push(username, accessKey);
    farm = { config, credentials: { username, accessKey } };

    try {
      base = deviceFarmHub(config.provider, username);
    } catch (err) {
      return skipped(errorText(err));
    }
  } else {
    try {
      base = appiumServerBase(spec.serverUrl ?? DEFAULT_APPIUM_SERVER);
    } catch (err) {
      return skipped(errorText(err));
    }
  }

  const capabilities = buildCapabilities(spec, vars, farm);
  const capabilityGap = missingCapabilityHint(capabilities);
  if (capabilityGap) return skipped(capabilityGap);

  // ─ Session ───────────────────────────────────────────────────────────────
  const openedAt = Date.now();
  recorder.log('•', `POST ${base}/session`);
  const created = await wire(
    'POST',
    `${base}/session`,
    { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } },
    spec.newSessionTimeoutMs,
    ctx.signal,
  );

  if (created.transportError !== null) {
    const how = spec.deviceFarm
      ? `The ${spec.deviceFarm.provider} hub at ${base} did not answer`
      : `No Appium server answered at ${base}`;
    const fix = spec.deviceFarm
      ? 'Check the worker’s outbound network access to the provider and re-run.'
      : 'Start one with `npx appium` (or point serverUrl at the server you run) and re-run.';
    return skipped(`${how} (${created.transportError}). ${fix} The test was not evaluated.`);
  }

  const refusal = webdriverErrorOf(created.status ?? 0, created.body);
  if (refusal) {
    const verdict = classifySessionFailure(refusal);
    if (verdict.status === 'SKIPPED') return skipped(verdict.message);
    recorder.record('Start the Appium session', openedAt, [verdict.message]);
    return finish(test, startedAt, recorder, ctx.secrets, farmSecrets);
  }

  const sessionId = sessionIdOf(created.body);
  if (sessionId === null) {
    return skipped(
      `The Appium server at ${base} answered the new-session request without a session id, so nothing could be driven. Check that it is an Appium server and not a proxy in front of one.`,
    );
  }

  const session: Session = {
    base,
    id: sessionId,
    timeoutMs: spec.requestTimeoutMs,
    signal: ctx.signal,
  };
  recorder.record(`Start the ${spec.platform} session`, openedAt, []);
  recorder.log('•', `session ${sessionId}`);

  try {
    for (const step of spec.steps) {
      if (ctx.signal.aborted) {
        recorder.skip(step.name, 'the run was cancelled');
        continue;
      }
      if (recorder.broken) {
        recorder.skip(step.name, 'an earlier step failed, so the app is on an unknown screen');
        continue;
      }

      const before = recorder.steps.length;
      await runAppiumStep(ctx, session, step, vars, recorder);

      const recorded = recorder.steps[before];
      if (spec.screenshotOnFailure && recorded && recorded.status === 'FAILED') {
        // The screen at the moment of failure is the single most useful thing
        // triage can be handed, and it is gone the instant the session ends.
        recorded.screenshotKey = await captureScreenshot(
          ctx,
          session,
          `mobile-failure-${recorded.index}.png`,
        );
      }
    }
  } finally {
    // Always. An Appium session holds a real device — on a farm it holds a paid
    // slot until the idle timeout — so leaking one costs the next run its device.
    //
    // Deliberately NOT ctx.signal: a cancelled run is exactly when the session
    // most needs closing, and an already-aborted signal would skip the cleanup.
    await wire(
      'DELETE',
      `${base}/session/${encodeURIComponent(sessionId)}`,
      undefined,
      15_000,
      new AbortController().signal,
    );
  }

  return finish(test, startedAt, recorder, ctx.secrets, farmSecrets);
}

// ─── CLI drivers: spawning ───────────────────────────────────────────────────

interface ToolRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  spawnError: string | null;
  timedOut: boolean;
}

function runTool(
  ctx: RunContext,
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutSeconds: number },
): Promise<ToolRun> {
  const startedAt = Date.now();

  return new Promise<ToolRun>((done) => {
    // Never a shell: a spec is org-authored data, and interpolating it into a
    // shell command would turn a test definition into remote code execution.
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout?.on('data', (b: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += b.toString();
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += b.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // SIGTERM is a request. A Gradle daemon that ignores it must not hold the
      // run open forever.
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, options.timeoutSeconds * 1000);

    const onAbort = () => child.kill('SIGTERM');
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    const settle = (result: Omit<ToolRun, 'durationMs' | 'stdout' | 'stderr'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      done({
        ...result,
        stdout: stdout.slice(0, OUTPUT_LIMIT),
        stderr: stderr.slice(0, OUTPUT_LIMIT),
        durationMs: Date.now() - startedAt,
      });
    };

    child.on('error', (err) =>
      settle({
        code: null,
        signal: null,
        spawnError: (err as NodeJS.ErrnoException).code ?? err.message,
        timedOut,
      }),
    );
    child.on('close', (code, signal) => settle({ code, signal, spawnError: null, timedOut }));
  });
}

/**
 * Where a locally-installed CLI would be.
 *
 * Walks up from the working directory because a monorepo hoists dev
 * dependencies to the root `node_modules/.bin` while the app being tested lives
 * several directories below. Resolved directly rather than through `npx` for the
 * reason `visual-services.ts` gives: npx hides a missing dependency behind its
 * own exit 1, and on a machine with a network it will install the package
 * mid-run, which is not a thing a test may do.
 */
function resolveLocalBin(cwd: string, bin: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, 'node_modules', '.bin', bin);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ─── CLI drivers: reading the environment's answer ───────────────────────────

/** Install lines, kept beside the driver they belong to. */
const INSTALL_HINTS: Record<MobileDriver, string> = {
  APPIUM: 'npm i -g appium',
  MAESTRO: 'curl -fsSL https://get.maestro.mobile.dev | bash',
  DETOX: 'npm i -D detox && npm i -g detox-cli',
  ESPRESSO: 'install Gradle, or commit the Gradle wrapper (`gradle wrapper`) to the project',
  XCUITEST: 'install Xcode and select it with `sudo xcode-select -s /Applications/Xcode.app`',
};

/**
 * Signatures of "this worker cannot run the test", per driver.
 *
 * Matched against the tool's own output, and deliberately matched BEFORE the
 * exit code is consulted: every one of these tools exits non-zero when it cannot
 * find a device, and taking that at face value is how a missing emulator gets
 * reported as a failing app. The hint names the command that fixes it.
 */
const ENVIRONMENT_GAPS: Record<MobileDriver, Array<{ pattern: RegExp; hint: string }>> = {
  APPIUM: [],
  MAESTRO: [
    {
      pattern:
        /no devices?[^.\n]{0,20}(connected|found|available)|no running devices|connect a device/i,
      hint: 'Maestro found no device to run the flow on. Start an emulator (`emulator -avd <name>`) or boot a simulator (`xcrun simctl boot <udid>`), then re-run.',
    },
    {
      pattern:
        /(app|package) .{0,80}(is )?not installed|unable to launch app|failed to launch app/i,
      hint: 'The app under test is not installed on the device. Install the build (`adb install app.apk`, or `xcrun simctl install booted App.app`) and re-run.',
    },
    {
      pattern: /flow file .{0,120}(not found|does not exist)|no flows? found/i,
      hint: 'Maestro found no flow at the path in `flowPath`. Point it at the committed flow YAML (or the directory holding them) and re-run.',
    },
  ],
  DETOX: [
    {
      pattern:
        /cannot find app binary|app binary (is )?not found|could not find .{0,120}\.(app|apk)/i,
      hint: 'Detox has no app binary to install. Build it first (`detox build --configuration <name>`) so the binary exists in the workspace, then re-run.',
    },
    {
      pattern:
        /could not find a device by type|no device .{0,40}(matching|found)|failed to find a device|no connected devices/i,
      hint: 'Detox found no device matching the configuration. Create or boot the simulator/emulator it names (`applesimutils --list`, or `avdmanager list avd`) and re-run.',
    },
    {
      pattern:
        /cannot run detox without a configuration|configuration .{0,80}(not found|does not exist)|no configuration was specified/i,
      hint: 'The .detoxrc in this workspace has no configuration by that name. Set `configuration` to one it defines and re-run.',
    },
  ],
  ESPRESSO: [
    {
      pattern:
        /no connected devices|DeviceException: No connected devices|no online devices|device .{0,20}offline/i,
      hint: 'Gradle found no connected Android device. Start an emulator (`emulator -avd <name>`) or attach a device (`adb devices` should list one), then re-run.',
    },
    {
      pattern: /SDK location not found|ANDROID_HOME|ANDROID_SDK_ROOT|local\.properties/i,
      hint: 'The Android SDK is not configured on this worker. Set ANDROID_HOME (or add local.properties with sdk.dir) and re-run.',
    },
    {
      pattern: /task '.{0,80}' not found|cannot locate tasks that match/i,
      hint: 'Gradle has no such task in this project. Set `gradleTask` (and `module`) to a task the project defines — `./gradlew tasks` lists them — and re-run.',
    },
  ],
  XCUITEST: [
    {
      pattern:
        /xcode-select: error|requires Xcode|unable to find utility|Xcode\.app.{0,40}(not|cannot)/i,
      hint: 'Xcode is not installed or not selected on this worker. Install it and run `sudo xcode-select -s /Applications/Xcode.app`, then re-run.',
    },
    {
      pattern:
        /unable to find a destination matching|available destinations|does not support the destination|requested device could not be found|unable to boot/i,
      hint: 'No simulator matches the `destination` in the spec. List what exists with `xcrun simctl list devices`, set `destination` to one of them, and re-run.',
    },
    {
      pattern:
        /is not currently configured for the test action|does not contain a scheme|scheme .{0,80}not found/i,
      hint: 'That scheme has no test action in this project. Point `scheme` at one that does (`xcodebuild -list`) and re-run.',
    },
    {
      pattern:
        /does not exist.{0,40}\.xcodeproj|cannot be opened because it does not exist|no such file or directory.{0,60}\.xcworkspace/i,
      hint: 'The project or workspace path in the spec does not exist in this workspace. Fix `project`/`workspace` and re-run.',
    },
  ],
};

/**
 * Does the tool's output say the environment is missing something?
 *
 * Returns the sentence to report, or null when the output describes a genuine
 * test result.
 */
export function environmentGap(driver: MobileDriver, output: string): string | null {
  for (const gap of ENVIRONMENT_GAPS[driver]) {
    if (gap.pattern.test(output)) return gap.hint;
  }
  return null;
}

// ─── CLI drivers: reports ────────────────────────────────────────────────────

/** Counted from the tests themselves, so no caller can miscount them. */
function totalsOf(tests: ReportTest[], durationMs: number): ParsedReport['totals'] {
  return {
    tests: tests.length,
    passed: tests.filter((t) => t.status === 'passed').length,
    failed: tests.filter((t) => t.status === 'failed').length,
    skipped: tests.filter((t) => t.status === 'skipped').length,
    durationMs,
  };
}

/** Sums several JUnit files into one report — a multi-device run writes one each. */
export function mergeReports(reports: ParsedReport[]): ParsedReport {
  const tests = reports.flatMap((report) => report.tests);
  return {
    format: 'junit-xml',
    presence: reports.some((r) => r.presence === 'ok') ? 'ok' : (reports[0]?.presence ?? 'empty'),
    suiteName: reports.find((r) => r.suiteName !== null)?.suiteName ?? null,
    tests,
    totals: totalsOf(
      tests,
      reports.reduce((sum, r) => sum + r.totals.durationMs, 0),
    ),
    truncated: reports.some((r) => r.truncated),
    diagnostics: reports.flatMap((r) => r.diagnostics),
  };
}

/**
 * Wraps a hand-parsed test list in the shape every report consumer expects.
 *
 * Labelled `junit-xml` because `ReportFormat` has no member for "we read the
 * tool's console output", and the label only ever appears in messages about a
 * report that was empty or unreadable — which this never is, since it is built
 * from tests that were found.
 */
export function reportFromTests(tests: ReportTest[], diagnostics: string[] = []): ParsedReport {
  return {
    format: 'junit-xml',
    presence: 'ok',
    suiteName: null,
    tests,
    totals: totalsOf(
      tests,
      tests.reduce((sum, t) => sum + t.durationMs, 0),
    ),
    truncated: false,
    diagnostics,
  };
}

/**
 * Every `*.xml` under `dir`, two directories deep — Gradle writes
 * `androidTest-results/connected/<flavour>/TEST-<device>.xml`, one per device.
 */
async function xmlFilesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (at: string, depth: number): Promise<void> => {
    const entries = await readdir(at, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(at, entry.name);
      if (entry.isDirectory() && depth > 0) await walk(full, depth - 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) found.push(full);
    }
  };
  await walk(dir, 2);
  return found.sort();
}

/**
 * Read a JUnit report from a file — or from a directory of them.
 *
 * Returns null when there is nothing there, which is a different answer from an
 * empty report and must stay that way: "the tool wrote nothing" may never be
 * rendered as "nothing failed".
 */
async function readJUnit(absolutePath: string): Promise<ParsedReport | null> {
  let isDirectory = false;
  try {
    isDirectory = (await stat(absolutePath)).isDirectory();
  } catch {
    return null;
  }

  if (!isDirectory) {
    try {
      return parseReport('junit-xml', await readFile(absolutePath, 'utf8'));
    } catch {
      return null;
    }
  }

  const files = await xmlFilesUnder(absolutePath).catch(() => [] as string[]);
  if (files.length === 0) return null;

  const parsed: ParsedReport[] = [];
  for (const file of files) {
    try {
      parsed.push(parseReport('junit-xml', await readFile(file, 'utf8')));
    } catch {
      // One unreadable file must not discard the devices that did report.
    }
  }
  return parsed.length === 0 ? null : mergeReports(parsed);
}

/**
 * xcodebuild's own test log.
 *
 * xcodebuild writes no machine-readable report of its own — teams pipe it
 * through xcbeautify or xcpretty to get JUnit — but it has printed these lines
 * unchanged for a decade, so a project with no formatter still gets per-test
 * results instead of a bare exit code:
 *
 *     Test Case '-[CheckoutUITests testApplePay]' passed (3.412 seconds).
 *     Test Case 'CheckoutUITests.testApplePay()' failed (1.002 seconds).
 */
export function parseXcodebuildTests(output: string): ReportTest[] {
  const tests: ReportTest[] = [];
  const lines = output.split(/\r?\n/);

  // Failure detail arrives on its own line, before the verdict:
  //   /path/CheckoutTests.swift:42: error: -[Suite testX] : XCTAssertEqual failed
  const failures = new Map<string, string>();
  const failureLine = /error:\s*-?\[?([\w.]+)[ .]([\w]+)\)?\]?\s*:?\s*(.*)$/;
  const caseLine =
    /^\s*Test Case\s+'-?\[?([\w.]+)[ .]([\w]+)(?:\(\))?\]?'\s+(passed|failed|skipped)(?:\s+\(([\d.]+)\s+seconds?\))?/;

  for (const line of lines) {
    const failure = failureLine.exec(line);
    if (failure) {
      const key = `${failure[1]}.${failure[2]}`;
      // Keep the FIRST assertion for a test: later lines are usually the
      // teardown noise that followed it.
      if (!failures.has(key)) failures.set(key, failure[3]?.trim() || line.trim());
      continue;
    }

    const match = caseLine.exec(line);
    if (!match) continue;
    const suite = match[1] ?? '';
    const name = match[2] ?? '';
    const verdict = match[3] as 'passed' | 'failed' | 'skipped';
    const seconds = Number(match[4] ?? '0');

    tests.push({
      suite,
      name,
      status: verdict,
      durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
      failureMessage: verdict === 'failed' ? (failures.get(`${suite}.${name}`) ?? 'failed') : null,
      stack: null,
    });
  }

  return tests;
}

// ─── CLI drivers: one shared execution path ──────────────────────────────────

interface CliPlan {
  command: string;
  args: string[];
  /** Absolute path to the report the tool will write, when it writes one. */
  reportPath: string | null;
  /** How the report path reads in the spec, for the message when it is missing. */
  reportLabel: string | null;
  /** Read results out of stdout when there is no report file. */
  parseOutput?: (output: string) => ReportTest[];
  /**
   * The process's own exit code is the verdict when it produced no report.
   *
   * True only where "no report" is the tool's normal mode rather than a missing
   * file: Detox reports through its runner's exit code unless the project wires
   * up a JUnit reporter. Everywhere else a missing report is an absence, and an
   * absence may never be rendered as a pass.
   */
  exitCodeIsVerdict?: boolean;
}

/**
 * Everything after the command line is identical for all four CLI drivers:
 * spawn, classify the environment, read the report, and never let a
 * configuration gap masquerade as a failing app.
 */
async function runCliDriver(
  ctx: RunContext,
  test: ExecutableTest,
  driver: MobileDriver,
  spec: {
    env: Record<string, string>;
    secretNames: string[];
    timeoutSeconds: number;
  },
  plan: CliPlan,
  cwd: string,
  startedAt: number,
): Promise<TestExecution> {
  const recorder = new StepRecorder(ctx, test.id);
  const mask = createMasker(Object.values(ctx.secrets));

  const skipped = (message: string): TestExecution =>
    finish(test, startedAt, recorder, ctx.secrets, [], {
      status: 'SKIPPED',
      errorMessage: message,
    });

  // Only the secrets the spec names, so a test cannot hand the whole vault to a
  // third-party process.
  const exposed: Record<string, string> = {};
  const missingSecrets: string[] = [];
  for (const name of spec.secretNames) {
    const value = ctx.secrets[name];
    if (value === undefined) missingSecrets.push(name);
    else exposed[name] = value;
  }
  if (missingSecrets.length > 0) {
    return skipped(
      `The secret${missingSecrets.length > 1 ? 's' : ''} ${missingSecrets.join(', ')} ${missingSecrets.length > 1 ? 'are' : 'is'} not set on this environment, so ${plan.command} was not run.`,
    );
  }

  if (ctx.signal.aborted) {
    return skipped('The run was cancelled before the mobile test started.');
  }

  const began = Date.now();
  recorder.log('•', `${plan.command} ${plan.args.join(' ')}`);

  const result = await runTool(ctx, plan.command, plan.args, {
    cwd,
    env: {
      ...(process.env as Record<string, string>),
      ...spec.env,
      ...exposed,
      QAAI_BASE_URL: ctx.baseUrl,
      CI: '1',
    },
    timeoutSeconds: spec.timeoutSeconds,
  });

  const output = `${result.stdout}\n${result.stderr}`;
  recorder.log('↓', truncate(output.trim().split('\n').slice(-12).join('\n'), LOG_SNIPPET_LIMIT));

  if (result.spawnError === 'ENOENT') {
    return skipped(
      `\`${plan.command}\` is not installed on this worker, so the test was not evaluated. Install it with: ${INSTALL_HINTS[driver]}.`,
    );
  }
  if (result.spawnError === 'EACCES') {
    return skipped(
      `\`${plan.command}\` is present but not executable on this worker (EACCES). Fix its permissions (\`chmod +x ${plan.command}\`) and re-run.`,
    );
  }
  if (result.spawnError !== null) {
    return finish(test, startedAt, recorder, ctx.secrets, [], {
      status: 'FAILED',
      errorMessage: `Could not run \`${plan.command}\`: ${result.spawnError}`,
    });
  }

  // Before the exit code, always. Every one of these tools exits non-zero when
  // it cannot find a device, and reading that as a failing app is the bug this
  // whole plugin is written to avoid.
  const gap = environmentGap(driver, output);
  if (gap) return skipped(`${gap} The test itself was not evaluated.`);

  if (result.timedOut) {
    return finish(test, startedAt, recorder, ctx.secrets, [], {
      status: 'TIMED_OUT',
      errorMessage: mask(
        `\`${plan.command}\` exceeded ${spec.timeoutSeconds}s and was stopped. Last output: ${truncate(output.trim().slice(-600), 600)}`,
      ),
    });
  }

  const report = plan.reportPath === null ? null : await readJUnit(plan.reportPath);
  const fromOutput = report === null && plan.parseOutput ? plan.parseOutput(output) : [];
  const resolved = report ?? (fromOutput.length > 0 ? reportFromTests(fromOutput) : null);

  if (resolved === null) {
    if (plan.exitCodeIsVerdict) {
      const passed = result.code === 0;
      recorder.record(
        `${plan.command} ${plan.args.join(' ')}`,
        began,
        passed ? [] : [mask(truncate(output.trim().slice(-1500), 1500)) || `exit ${result.code}`],
      );
      return finish(test, startedAt, recorder, ctx.secrets, []);
    }

    // No report and no parseable output. The exit code is all that is left, and
    // a clean exit with no results is not a pass — it is a run that reported
    // nothing, which is what it will say.
    if (result.code === 0) {
      return skipped(
        plan.reportLabel
          ? `${plan.command} exited cleanly but wrote no report at ${plan.reportLabel}, so no test results were read. Point reportPath at the file (or directory) your setup writes.`
          : `${plan.command} exited cleanly but reported no test cases, so nothing was evaluated.`,
      );
    }
    return finish(test, startedAt, recorder, ctx.secrets, [], {
      status: 'FAILED',
      errorMessage: mask(truncate(output.trim().slice(-2000), 2000) || `exit ${result.code}`),
    });
  }

  const summary = summariseReport(resolved, plan.reportLabel ?? undefined);
  for (const step of toStepResults(resolved, new Date(began))) {
    recorder.steps.push(step);
    ctx.logger.step({
      testId: test.id,
      index: step.index,
      title: step.title,
      status: step.status,
    });
  }

  // A report we could not read, from a process that said it failed, is a
  // failure — the exit code is the evidence we still have. The reverse never
  // applies: a clean exit cannot turn an unreadable report into a pass.
  const status: TestResultStatus =
    summary.status === 'SKIPPED' && result.code !== 0 && resolved.presence !== 'ok'
      ? 'FAILED'
      : summary.status;

  return finish(test, startedAt, recorder, ctx.secrets, [], {
    status,
    ...(summary.errorMessage ? { errorMessage: mask(summary.errorMessage) } : {}),
  });
}

// ─── The four CLI drivers ────────────────────────────────────────────────────

/**
 * Every spec-supplied path resolves against the WORKSPACE root, not against
 * `cwd`. `cwd` says where the tool runs; a path says where a file is. Keeping
 * those separate means a spec that sets both still points at the file it names.
 */
function maestroPlan(spec: MaestroMobileSpec, workspace: string): CliPlan {
  const reportPath = safeWorkspacePath(workspace, spec.reportPath);
  const args = spec.command
    ? spec.args
    : [
        ...(spec.deviceId ? ['--device', spec.deviceId] : []),
        'test',
        // Maestro speaks JUnit, so the existing parser reads it and each flow
        // shows up as its own result rather than one opaque exit code.
        '--format',
        'junit',
        '--output',
        reportPath,
        ...Object.entries(spec.flowEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        safeWorkspacePath(workspace, spec.flowPath),
        ...spec.extraArgs,
      ];

  return {
    command: spec.command ?? 'maestro',
    args,
    reportPath,
    reportLabel: spec.reportPath,
  };
}

function detoxPlan(spec: DetoxMobileSpec, workspace: string, cwd: string): CliPlan {
  const reportPath = spec.reportPath ? safeWorkspacePath(workspace, spec.reportPath) : null;
  return {
    command: spec.command ?? resolveLocalBin(cwd, 'detox') ?? 'detox',
    args: spec.command
      ? spec.args
      : ['test', '--configuration', spec.configuration, ...spec.extraArgs],
    reportPath,
    reportLabel: spec.reportPath ?? null,
    // Detox's own runner exits non-zero when a test fails, and a project only
    // writes JUnit if it configured a reporter — so without one, that exit code
    // is the result rather than a missing file.
    exitCodeIsVerdict: reportPath === null,
  };
}

function espressoPlan(spec: EspressoMobileSpec, workspace: string, cwd: string): CliPlan {
  const wrapper = join(cwd, 'gradlew');
  const task = spec.module ? `${spec.module}:${spec.gradleTask}` : spec.gradleTask;

  return {
    // The wrapper is the project's own pinned Gradle; the PATH `gradle` is
    // whatever the worker image happens to have, and using it is how a build
    // fails for a reason that has nothing to do with the tests.
    command: spec.command ?? (existsSync(wrapper) ? wrapper : 'gradle'),
    args: spec.command
      ? spec.args
      : [
          task,
          ...(spec.testClass
            ? [`-Pandroid.testInstrumentationRunnerArguments.class=${spec.testClass}`]
            : []),
          // Gradle's rich console writes control codes that make the log
          // unreadable in the cockpit and defeat the gap patterns above.
          '--console=plain',
          ...spec.extraArgs,
        ],
    reportPath: safeWorkspacePath(workspace, spec.reportPath),
    reportLabel: spec.reportPath,
  };
}

function xcuitestPlan(spec: XcuitestMobileSpec, workspace: string): CliPlan {
  const reportPath = spec.reportPath ? safeWorkspacePath(workspace, spec.reportPath) : null;
  return {
    command: spec.command ?? 'xcodebuild',
    args: spec.command
      ? spec.args
      : [
          'test',
          ...(spec.workspace ? ['-workspace', spec.workspace] : []),
          ...(spec.project ? ['-project', spec.project] : []),
          '-scheme',
          spec.scheme,
          '-destination',
          spec.destination,
          ...(spec.testPlan ? ['-testPlan', spec.testPlan] : []),
          ...spec.onlyTesting.map((entry) => `-only-testing:${entry}`),
          ...spec.extraArgs,
        ],
    reportPath,
    reportLabel: spec.reportPath ?? null,
    parseOutput: parseXcodebuildTests,
  };
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export const mobilePlugin: RunnerPlugin = {
  type: 'MOBILE',

  validate(test: ExecutableTest): void {
    const parsed = mobileTestSpecSchema.safeParse(test.spec);
    if (parsed.success) return;

    // A discriminated union reports an unhelpful union error when the
    // discriminator itself is wrong, so name that case before falling back.
    const raw = test.spec;
    const driver =
      raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).driver : undefined;
    if (typeof driver !== 'string' || !(MOBILE_DRIVERS as readonly string[]).includes(driver)) {
      throw new Error(
        `Mobile test "${test.name}" must set "driver" to one of ${MOBILE_DRIVERS.join(', ')} — got ${JSON.stringify(driver)}.`,
      );
    }

    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Mobile test "${test.name}" has an invalid ${driver} spec — ${issues}`);
  },

  async execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const startedAt = Date.now();
    const spec = mobileTestSpecSchema.parse(test.spec);
    const workspace = process.cwd();

    if (spec.driver === 'APPIUM') return runAppium(ctx, test, spec, startedAt);

    // XCUITest needs Xcode, and Xcode needs macOS. Answering that here rather
    // than through a spawn failure is the difference between "xcodebuild is not
    // installed" and a sentence that tells a Linux CI owner what is actually
    // true about their worker.
    if (spec.driver === 'XCUITEST' && process.platform !== 'darwin') {
      const recorder = new StepRecorder(ctx, test.id);
      return finish(test, startedAt, recorder, ctx.secrets, [], {
        status: 'SKIPPED',
        errorMessage: `XCUITest runs through xcodebuild, which only exists on macOS — this worker is ${process.platform}. Route this test to a macOS worker (or use Appium against a device farm) and re-run.`,
      });
    }

    let cwd: string;
    try {
      cwd = safeWorkspacePath(workspace, spec.cwd);
    } catch (err) {
      const recorder = new StepRecorder(ctx, test.id);
      return finish(test, startedAt, recorder, ctx.secrets, [], {
        status: 'FAILED',
        errorMessage: errorText(err),
      });
    }

    let plan: CliPlan;
    try {
      plan =
        spec.driver === 'MAESTRO'
          ? maestroPlan(spec, workspace)
          : spec.driver === 'DETOX'
            ? detoxPlan(spec, workspace, cwd)
            : spec.driver === 'ESPRESSO'
              ? espressoPlan(spec, workspace, cwd)
              : xcuitestPlan(spec, workspace);
    } catch (err) {
      // A path that escapes the workspace is a spec bug, and naming it is more
      // use than letting the tool fail on a path it should never have seen.
      const recorder = new StepRecorder(ctx, test.id);
      return finish(test, startedAt, recorder, ctx.secrets, [], {
        status: 'FAILED',
        errorMessage: errorText(err),
      });
    }

    return runCliDriver(ctx, test, spec.driver, spec, plan, cwd, startedAt);
  },
};
