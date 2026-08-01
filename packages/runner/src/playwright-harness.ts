/**
 * Executes generated Playwright specs with the real Playwright test runner.
 *
 * Why shell out instead of driving `page` in-process: the tests QAAI writes are
 * standard `@playwright/test` files the customer owns and can run in their own
 * CI with no QAAI installed (§7 "no lock-in"). If we executed them through a
 * bespoke harness, that promise would be false — the code would only run here.
 * The cost is a subprocess and JSON-reporter parsing, which is what this file is.
 *
 * Everything the cockpit renders — steps, screenshots, video, trace, network,
 * console — comes out of the reporter and the artifacts directory below.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import type {
  ConsoleEntry,
  ExecutableTest,
  NetworkEntry,
  RunContext,
  StepResult,
  TestExecution,
  TestResultStatus,
} from '@qaai/shared';
import {
  determinismRecord,
  planDeterminism,
  reproduceHint,
  resolveDeterminism,
  type DeterminismOptions,
  type DeterminismPlan,
} from './determinism.js';

/** Hard ceiling for a whole spec file, independent of per-test timeouts. */
const PROCESS_TIMEOUT_MS = 10 * 60_000;

const localRequire = createRequire(import.meta.url);

/**
 * Where generated specs are written, and which Playwright binary runs them.
 *
 * Both are derived from the installed `@playwright/test`, not from `os.tmpdir()`
 * and not from `npx`. Two reasons, and the first one bites immediately:
 *
 *  - A workspace under /tmp has no `node_modules` above it, so the spec's
 *    `import { test } from '@playwright/test'` cannot resolve. Placing the
 *    workspace beside the installed package lets Node's normal upward lookup
 *    find it, with no NODE_PATH tricks.
 *  - `npx playwright` resolves against the npx cache and can silently fetch a
 *    *different* Playwright than the one whose browsers were installed. Running
 *    the local binary keeps the runner and its browsers in lockstep.
 */
function resolvePlaywrightLayout(): { runsRoot: string; cliPath: string } {
  const entry = localRequire.resolve('@playwright/test');
  const marker = `${sep}node_modules${sep}`;
  const index = entry.lastIndexOf(marker);
  if (index === -1) {
    throw new Error('Could not locate node_modules for @playwright/test');
  }

  const nodeModulesDir = entry.slice(0, index + marker.length - 1);
  const installRoot = dirname(nodeModulesDir);

  return {
    runsRoot: join(installRoot, '.qaai-runs'),
    cliPath: join(nodeModulesDir, '.bin', 'playwright'),
  };
}

const { runsRoot, cliPath } = resolvePlaywrightLayout();

/** The Playwright binary the runner drives; record mode uses it too. */
export const playwrightCliPath = cliPath;

// ─── Playwright JSON reporter shapes (the subset we consume) ─────────────────

interface PwErrorish {
  message?: string;
  stack?: string;
  location?: { file: string; line: number; column: number };
}

interface PwStep {
  title: string;
  duration: number;
  error?: PwErrorish;
  steps?: PwStep[];
  /** 'test.step' for user steps; 'pw:api'/'hook'/'expect' for machinery. */
  category?: string;
  startTime?: string;
}

interface PwAttachment {
  name: string;
  path?: string;
  contentType: string;
}

interface PwResult {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  duration: number;
  retry: number;
  steps?: PwStep[];
  errors?: PwErrorish[];
  attachments?: PwAttachment[];
  stdout?: Array<{ text?: string }>;
  stderr?: Array<{ text?: string }>;
}

interface PwTest {
  title: string;
  results: PwResult[];
}

interface PwSpec {
  title: string;
  tests: PwTest[];
}

interface PwSuite {
  title: string;
  specs: PwSpec[];
  suites?: PwSuite[];
}

interface PwReport {
  suites?: PwSuite[];
  errors?: PwErrorish[];
}

function flattenSpecs(suites: PwSuite[] | undefined): PwSpec[] {
  const out: PwSpec[] = [];
  for (const suite of suites ?? []) {
    out.push(...suite.specs);
    out.push(...flattenSpecs(suite.suites));
  }
  return out;
}

/**
 * Only user-authored `test.step()` calls become cockpit steps; auto-generated
 * `expect` and `pw:api` entries are machinery and would bury the timeline.
 *
 * The JSON reporter is inconsistent about `category`: it omits the field
 * entirely and already returns just the user steps at the top level, while the
 * richer in-process reporters do set it. Handle both — an absent category at
 * the root means "this is a user step", and a present one is trusted.
 */
function collectUserSteps(steps: PwStep[] | undefined, into: PwStep[] = []): PwStep[] {
  for (const step of steps ?? []) {
    if (step.category === undefined || step.category === 'test.step') into.push(step);
    else collectUserSteps(step.steps, into);
  }
  return into;
}

// ─── Workspace ───────────────────────────────────────────────────────────────

interface Workspace {
  dir: string;
  specPath: string;
  outputDir: string;
  reportPath: string;
  cleanup: () => Promise<void>;
}

/**
 * Refuses any path that escapes the workspace. `test.filePath` originates from
 * the Generator (a model), so it is untrusted input that ends up as a real path.
 */
function safeSpecPath(dir: string, filePath: string): string {
  const cleaned = filePath.replace(/^[/\\]+/, '');
  const withExt = extname(cleaned) ? cleaned : `${cleaned}.spec.ts`;
  const full = resolve(join(dir, 'tests', withExt));
  const root = resolve(join(dir, 'tests'));
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`Refusing to write test outside the workspace: ${filePath}`);
  }
  return full;
}

/**
 * Same guard for a fixture, resolved against the workspace root rather than
 * `tests/` — fixture paths already start with `fixtures/`, and a spec reads them
 * relative to the workspace it runs in.
 */
function safeFixturePath(dir: string, filePath: string): string {
  const cleaned = filePath.replace(/^[/\\]+/, '');
  const full = resolve(join(dir, cleaned));
  const root = resolve(dir);
  if (!full.startsWith(root + sep)) {
    throw new Error(`Refusing to write fixture outside the workspace: ${filePath}`);
  }
  return full;
}

/** Playwright's device preset for a browser engine. */
function deviceFor(browserName: string): string {
  switch (browserName) {
    case 'firefox':
      return 'Desktop Firefox';
    case 'webkit':
      return 'Desktop Safari';
    default:
      return 'Desktop Chrome';
  }
}

const CONFIG_TEMPLATE = (opts: {
  baseUrl: string;
  timeoutMs: number;
  retryOnce: boolean;
  outputDir: string;
  /** Cloud grid websocket endpoint. Credential-bearing — never logged. */
  gridWsEndpoint?: string | null;
  /**
   * One Playwright project per browser or locale. Cross-browser and
   * localisation are the same mechanism — run the identical spec under a
   * different `use` block — so they share this rather than forking the harness.
   */
  projects?: Array<{ name: string; browserName?: string; locale?: string; timezoneId?: string }>;
  /**
   * Determinism's timezone/locale pinning. It goes in the top-level `use` block
   * rather than into every project, so a localisation matrix that names its own
   * locale still wins — Playwright merges project `use` over the root, and a
   * run that deliberately varies locale must not be flattened by a knob whose
   * job is only to stop the *ambient* machine leaking in.
   */
  timezoneId?: string | null;
  locale?: string | null;
}) => `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: true,
  // One retry, always — but a retry that passes is reported as FLAKY, never as
  // a pass (§5). The gate treats it accordingly.
  retries: ${opts.retryOnce ? 1 : 0},
  workers: 1,
  reporter: [['json', { outputFile: 'report.json' }]],
  timeout: ${opts.timeoutMs},
  outputDir: ${JSON.stringify(opts.outputDir)},${
    opts.projects?.length
      ? `
  projects: [
${opts.projects
  .map(
    (p) =>
      `    { name: ${JSON.stringify(p.name)}, use: { ${[
        p.browserName ? `...devices[${JSON.stringify(deviceFor(p.browserName))}]` : null,
        p.locale ? `locale: ${JSON.stringify(p.locale)}` : null,
        p.timezoneId ? `timezoneId: ${JSON.stringify(p.timezoneId)}` : null,
      ]
        .filter(Boolean)
        .join(', ')} } },`,
  )
  .join('\n')}
  ],`
      : ''
  }
  use: {
    baseURL: ${JSON.stringify(opts.baseUrl)},${
      opts.timezoneId
        ? `
    // Pinned by the determinism kit — the worker's own zone must not decide
    // whether a date rolls over mid-suite.
    timezoneId: ${JSON.stringify(opts.timezoneId)},`
        : ''
    }${
      opts.locale
        ? `
    locale: ${JSON.stringify(opts.locale)},`
        : ''
    }${
      opts.gridWsEndpoint
        ? `
    // Runs on a cloud grid instead of this machine's browser (§6).
    connectOptions: { wsEndpoint: ${JSON.stringify(opts.gridWsEndpoint)} },`
        : ''
    }
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
});
`;

async function createWorkspace(
  ctx: RunContext,
  test: ExecutableTest,
  plan: DeterminismPlan,
  projects?: HarnessOptions['projects'],
): Promise<Workspace> {
  await mkdir(runsRoot, { recursive: true });
  const dir = await mkdtemp(join(runsRoot, 'run-'));
  const outputDir = join(dir, 'artifacts');
  await mkdir(join(dir, 'tests'), { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const specPath = safeSpecPath(dir, test.filePath);
  await mkdir(dirname(specPath), { recursive: true });
  // `plan.code` is `test.code` verbatim unless the run asked for determinism.
  await writeFile(specPath, plan.code, 'utf8');

  await writeFile(
    join(dir, 'playwright.config.ts'),
    CONFIG_TEMPLATE({
      baseUrl: ctx.baseUrl,
      timeoutMs: test.timeoutMs,
      retryOnce: ctx.determinism.retryOnce,
      outputDir,
      gridWsEndpoint: ctx.grid?.wsEndpoint ?? null,
      projects,
      timezoneId: plan.determinism.timezoneId,
      locale: plan.determinism.locale,
    }),
    'utf8',
  );

  // Test data, so a spec can read `fixtures/users.json` off disk. Written into
  // every workspace: each run gets a fresh temp dir holding only its own spec,
  // so a fixture that is not copied in simply would not exist at run time.
  for (const [fixturePath, content] of Object.entries(ctx.fixtures ?? {})) {
    const target = safeFixturePath(dir, fixturePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  // Storage state from the environment's auth profile, when one applies (§2).
  if (ctx.storageState) {
    await writeFile(join(dir, 'storage-state.json'), JSON.stringify(ctx.storageState), 'utf8');
  }

  return {
    dir,
    specPath,
    outputDir,
    reportPath: join(dir, 'report.json'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// ─── Execution ───────────────────────────────────────────────────────────────

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runPlaywright(ws: Workspace, ctx: RunContext, plan: DeterminismPlan): Promise<SpawnOutcome> {
  return new Promise((resolvePromise) => {
    const d = plan.determinism;
    const child = spawn(cliPath, ['test', '--config', 'playwright.config.ts'], {
      cwd: ws.dir,
      env: {
        ...process.env,
        // Secrets reach the test process as env vars — never inlined into the
        // generated source, which gets committed to the customer's repo.
        ...ctx.secrets,
        QAAI_BASE_URL: ctx.baseUrl,
        QAAI_RUN_ID: ctx.runId,
        QAAI_STORAGE_STATE: ctx.storageState ? join(ws.dir, 'storage-state.json') : '',
        // The seed the run actually used, so a spec that generates its own data
        // reads the same number that decided the test order.
        QAAI_SEED: String(d.seed),
        QAAI_DETERMINISM_SEED: String(d.seed),
        ...(d.clockAtIso ? { QAAI_FROZEN_CLOCK: d.clockAtIso } : {}),
        // Node reads TZ at startup, and the test process formats dates too —
        // pinning only the browser would leave the assertions in a different
        // zone from the page they are asserting on.
        ...(d.timezoneId ? { TZ: d.timezoneId } : {}),
        CI: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, PROCESS_TIMEOUT_MS);

    // Cooperative cancellation from the queue (§5).
    const onAbort = () => child.kill('SIGTERM');
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      resolvePromise({ exitCode, stdout, stderr, timedOut });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      resolvePromise({ exitCode: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
  });
}

/** Uploads everything Playwright dropped in the output dir and returns the keys. */
async function uploadArtifacts(
  ws: Workspace,
  ctx: RunContext,
  testId: string,
): Promise<{ videoKey: string | null; traceKey: string | null; screenshotKeys: string[] }> {
  let videoKey: string | null = null;
  let traceKey: string | null = null;
  const screenshotKeys: string[] = [];

  const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await walk(full)));
      else files.push(full);
    }
    return files;
  };

  for (const file of await walk(ws.outputDir)) {
    const rel = relative(ws.outputDir, file).replace(/[/\\]/g, '_');
    const name = `${testId}_${rel}`;
    try {
      if (file.endsWith('.webm')) {
        videoKey = await ctx.artifacts.putFile(name, file, 'video/webm');
      } else if (file.endsWith('.zip')) {
        traceKey = await ctx.artifacts.putFile(name, file, 'application/zip');
      } else if (file.endsWith('.png')) {
        screenshotKeys.push(await ctx.artifacts.putFile(name, file, 'image/png'));
      }
    } catch (err) {
      ctx.logger.warn('artifact upload failed', { file, err: String(err) });
    }
  }

  return { videoKey, traceKey, screenshotKeys };
}

/**
 * One test's verdict: its final attempt, and whether it needed a retry to pass.
 *
 * `retry` is per TEST in Playwright's report, and a spec file holds many tests.
 * Flattening every result in the file into one list and asking "did the last one
 * pass after an earlier one failed" answers a different question — with two
 * tests where the FIRST fails and the second passes, that list is
 * [failed, passed] and the run is reported FLAKY. A real, deterministic,
 * repeatable failure downgraded to a flake, which is precisely the signal §5
 * exists to protect. Order randomisation makes it routine: shuffling only means
 * anything in a file with several tests, and it moves the failing one off the
 * end on purpose.
 */
interface TestOutcome {
  final: PwResult | undefined;
  retriedAndPassed: boolean;
}

function outcomeFor(test: PwTest): TestOutcome {
  const results = test.results;
  const final = results[results.length - 1];
  return {
    final,
    // §5: a retry that passes is a flake candidate, not a pass.
    retriedAndPassed:
      results.length > 1 &&
      final?.status === 'passed' &&
      results.some((r) => r.status === 'failed' || r.status === 'timedOut'),
  };
}

/** Worst-wins, so one failing test is never masked by the ones that passed. */
const STATUS_SEVERITY: Record<TestResultStatus, number> = {
  TIMED_OUT: 4,
  FAILED: 3,
  FLAKY: 2,
  PASSED: 1,
  SKIPPED: 0,
};

function mapStatus(result: PwResult | undefined, retriedAndPassed: boolean): TestResultStatus {
  if (retriedAndPassed) return 'FLAKY';
  switch (result?.status) {
    case 'passed':
      return 'PASSED';
    case 'timedOut':
      return 'TIMED_OUT';
    case 'skipped':
      return 'SKIPPED';
    case 'interrupted':
    case 'failed':
      return 'FAILED';
    default:
      return 'FAILED';
  }
}

function toStepResults(
  steps: PwStep[],
  screenshotKeys: string[],
  failingIndex: number | null,
): StepResult[] {
  return steps.map((step, index) => {
    const failed = Boolean(step.error);
    return {
      index,
      title: step.title,
      status: failed ? 'FAILED' : 'PASSED',
      startedAt: step.startTime ?? new Date().toISOString(),
      durationMs: Math.round(step.duration ?? 0),
      // Playwright only screenshots on failure, so the one capture we have
      // belongs to the failing step. Full per-step frames live in the trace.
      screenshotKey: index === failingIndex ? (screenshotKeys[0] ?? null) : null,
      error: failed ? parseStepError(step.error!) : null,
    };
  });
}

/**
 * Pulls expected/actual and the failing locator out of Playwright's error text.
 * These feed the Triage prompt, which is far more accurate when it can see what
 * the test wanted versus what it got instead of just a stack trace.
 */
function parseStepError(err: PwErrorish): NonNullable<StepResult['error']> {
  const message = stripAnsi(err.message ?? 'Step failed');
  return {
    message,
    stack: err.stack ? stripAnsi(err.stack) : null,
    selector: /(?:locator|getBy\w+)\((.*?)\)/.exec(message)?.[0] ?? null,
    expected: /Expected(?: string| value| pattern)?:\s*(.+)/.exec(message)?.[1]?.trim() ?? null,
    actual: /Received(?: string| value)?:\s*(.+)/.exec(message)?.[1]?.trim() ?? null,
  };
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex -- stripping terminal colour codes
  return input.replace(/\[[0-9;]*m/g, '');
}

/**
 * Playwright writes console and network into the trace, not the JSON report.
 * Rather than unzip the trace on every run, we surface stdout/stderr the test
 * produced and leave the full record to the embedded trace viewer.
 */
function toConsoleEntries(result: PwResult | undefined): ConsoleEntry[] {
  const at = new Date().toISOString();
  const out: ConsoleEntry[] = [];
  for (const line of result?.stdout ?? []) {
    if (line.text?.trim()) out.push({ level: 'log', text: stripAnsi(line.text).trim(), at });
  }
  for (const line of result?.stderr ?? []) {
    if (line.text?.trim()) out.push({ level: 'error', text: stripAnsi(line.text).trim(), at });
  }
  return out;
}

export interface HarnessOptions {
  /** Reported on the TestExecution; lets smoke reuse this harness verbatim. */
  network?: NetworkEntry[];
  /** Run the spec once per entry — a browser matrix, or a locale matrix. */
  projects?: Array<{ name: string; browserName?: string; locale?: string; timezoneId?: string }>;
  /**
   * Build determinism controls — order randomisation, clock, seeded randomness,
   * timezone/locale. Every knob is off unless named here, because each one
   * changes what the suite exercises and that is the run owner's decision.
   */
  determinism?: DeterminismOptions;
}

/**
 * Writes the seed, and the order it produced, somewhere it will outlive the run
 * log — a shuffled failure is only actionable if the order can be replayed, and
 * a seed that exists solely in a log line is a seed nobody will find.
 *
 * Wrapped, because a reporting problem must never lose a run: if the artifact
 * store is unavailable the test result still stands, and the seed is still in
 * the failure message and the log.
 */
async function recordDeterminism(
  ctx: RunContext,
  test: ExecutableTest,
  plan: DeterminismPlan,
): Promise<void> {
  const record = determinismRecord(plan);
  ctx.logger.info('determinism', { testId: test.id, ...record });
  try {
    await ctx.artifacts.put(
      `${test.id}_determinism.json`,
      Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'),
      'application/json',
    );
  } catch (err) {
    ctx.logger.warn('determinism record upload failed', { testId: test.id, err: String(err) });
  }
}

/** Runs one generated spec file and maps the result into QAAI's shape. */
export async function runPlaywrightSpec(
  ctx: RunContext,
  test: ExecutableTest,
  options: HarnessOptions = {},
): Promise<TestExecution> {
  const plan = planDeterminism(
    test.code,
    resolveDeterminism(ctx.determinism, options.determinism),
  );
  const hint = reproduceHint(plan);

  /**
   * Determinism metadata rides on the console pane rather than a new field on
   * TestExecution: the reader looking at a red run needs the seed in front of
   * them, and this is the channel that already reaches them. Notes appear even
   * on a pass, because "the shuffle declined and why" is exactly the thing that
   * would otherwise be silent.
   */
  const determinismConsole: ConsoleEntry[] = plan.determinism.enabled
    ? [
        ...(hint ? [{ level: 'log' as const, text: hint, at: new Date().toISOString() }] : []),
        ...plan.notes.map((text) => ({
          level: 'warn' as const,
          text: `Determinism: ${text}`,
          at: new Date().toISOString(),
        })),
      ]
    : [];

  const ws = await createWorkspace(ctx, test, plan, options.projects);
  const startedAt = Date.now();

  /** Appends the seed to whatever the failure already said, never replacing it. */
  const withHint = (message: string | null): string | null => {
    if (!hint) return message;
    return message ? `${message}\n\n${hint}` : hint;
  };

  try {
    if (plan.determinism.enabled) await recordDeterminism(ctx, test, plan);
    ctx.logger.info('running spec', { testId: test.id, file: test.filePath });
    const outcome = await runPlaywright(ws, ctx, plan);

    let report: PwReport | null = null;
    try {
      report = JSON.parse(await readFile(ws.reportPath, 'utf8')) as PwReport;
    } catch {
      report = null;
    }

    const { videoKey, traceKey, screenshotKeys } = await uploadArtifacts(ws, ctx, test.id);

    /**
     * A browser engine that was never installed is an environment gap, not a
     * failing test. Reporting it as FAILED would say the customer's app is
     * broken when the truth is `npx playwright install` was never run — the
     * same distinction k6 makes when its binary is missing.
     */
    const combinedOutput = `${outcome.stderr}\n${outcome.stdout}`;
    if (/Executable doesn't exist at|browserType\.launch: Executable/.test(combinedOutput)) {
      const engine = /(chromium|firefox|webkit)-\d+/.exec(combinedOutput)?.[1] ?? 'a browser';
      return {
        testId: test.id,
        status: 'SKIPPED',
        durationMs: Date.now() - startedAt,
        steps: [],
        network: options.network ?? [],
        console: determinismConsole,
        videoKey,
        traceKey,
        // No determinism hint here on purpose: nothing was evaluated, so a seed
        // would be inviting someone to "reproduce" a missing browser.
        errorMessage:
          `${engine} is not installed on this worker, so the test was not evaluated. ` +
          `Run \`npx playwright install ${engine === 'a browser' ? '' : engine}\`.`,
        retriedAndPassed: false,
        findings: [],
      };
    }

    // No report at all means the spec did not compile or Playwright itself
    // failed — an ENV_ISSUE in triage terms, not a test failure.
    if (!report) {
      return {
        testId: test.id,
        status: outcome.timedOut ? 'TIMED_OUT' : 'FAILED',
        durationMs: Date.now() - startedAt,
        steps: [],
        network: options.network ?? [],
        console: determinismConsole,
        videoKey,
        traceKey,
        errorMessage: withHint(
          outcome.timedOut
            ? `Playwright did not finish within ${PROCESS_TIMEOUT_MS / 1000}s`
            : `Playwright produced no report.\n${stripAnsi(outcome.stderr || outcome.stdout).slice(0, 4000)}`,
        ),
        retriedAndPassed: false,
        findings: [],
      };
    }

    const specs = flattenSpecs(report.suites);
    const outcomes = specs.flatMap((s) => s.tests).map(outcomeFor);

    // The reported test is the worst one in the file, not the last one to run.
    // Steps, error and screenshot all come from it, so the cockpit opens on the
    // thing that broke rather than on whatever happened to finish last.
    let worst: TestOutcome | undefined = outcomes[0];
    let status: TestResultStatus = mapStatus(worst?.final, worst?.retriedAndPassed ?? false);
    for (const candidate of outcomes.slice(1)) {
      const candidateStatus = mapStatus(candidate.final, candidate.retriedAndPassed);
      if (STATUS_SEVERITY[candidateStatus] > STATUS_SEVERITY[status]) {
        worst = candidate;
        status = candidateStatus;
      }
    }

    const last = worst?.final;
    // Reported for the whole file: a retry that passed anywhere in it is still
    // a flake candidate, even when another test failed outright.
    const retriedAndPassed = outcomes.some((o) => o.retriedAndPassed);

    const userSteps = collectUserSteps(last?.steps);
    const failingIndex = userSteps.findIndex((s) => Boolean(s.error));

    const topLevelError =
      last?.errors?.[0]?.message ??
      report.errors?.[0]?.message ??
      (last?.status === 'failed' && userSteps.every((s) => !s.error)
        ? stripAnsi(outcome.stderr || outcome.stdout).slice(0, 2000)
        : undefined);

    const errorMessage = topLevelError ? stripAnsi(topLevelError) : null;

    return {
      testId: test.id,
      status,
      durationMs: Date.now() - startedAt,
      steps: toStepResults(userSteps, screenshotKeys, failingIndex === -1 ? null : failingIndex),
      network: options.network ?? [],
      console: [...determinismConsole, ...toConsoleEntries(last)],
      videoKey,
      traceKey,
      // "Your suite fails in THIS order, here is the seed" is the whole feature.
      // A green run does not need it; a red one is useless without it.
      errorMessage: status === 'PASSED' ? errorMessage : withHint(errorMessage),
      retriedAndPassed,
      findings: [],
    };
  } finally {
    await ws.cleanup();
  }
}
