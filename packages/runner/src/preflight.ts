/**
 * Preflight (§4/§5) — asking whether this run CAN be attempted, once, before
 * it is attempted.
 *
 * ── The defect this file is the answer to ───────────────────────────────────
 *
 * An expired credential, a staging box that is down, a worker image with no k6:
 * every one of those used to arrive as N failing tests. The board went red, the
 * pass rate dropped, the coverage number dropped, the PR comment named eleven
 * "failures", and the one fact that mattered — *none of this was measured* —
 * appeared nowhere. A red build caused by a dead VPN tunnel was literally
 * indistinguishable from a red build caused by a bug, which is the single most
 * expensive confusion a QA product can create: the team learns to discount red,
 * and then discounts the real one.
 *
 * The plugins each discovered their own half of this, one run at a time and
 * after paying for it: `load.ts` spawns k6 and reads ENOENT, `mutation.ts`
 * spawns Stryker and reads ENOENT, `mobile.ts` tries `xcodebuild` and finds out
 * it is not on macOS. Every one of those is a question that could have been
 * answered before the run started, for free, in one place.
 *
 * ── The two preflights, and why they are different questions ────────────────
 *
 *  1. ENVIRONMENT — is the thing under test usable right now? Does the base URL
 *     answer, does the configured login still work, is there a checkout to run
 *     inside. Per RUN, because the answer changes between runs.
 *
 *  2. RUNNABILITY — can this DEPLOYMENT execute this kind of test at all? Is k6
 *     on PATH, is WebKit installed, is this macOS. Per IMAGE, because the answer
 *     changes when somebody rebuilds the container, not when somebody deploys
 *     their app.
 *
 * Conflating them produces exactly the wrong remedy: "install k6" is useless
 * advice for a down staging box, and "check your VPN" is useless advice for a
 * worker image that never had Lighthouse in it.
 *
 * ── The honesty rules, which are the whole design ───────────────────────────
 *
 *  · A CHECK HAS THREE OUTCOMES, NOT TWO. `UNKNOWN` is a first-class answer and
 *    is never rounded to either of the others. Rounding it to OK invents a
 *    capability nobody verified; rounding it to UNAVAILABLE refuses to run a
 *    test that would have worked. Both are worse than saying "not checked".
 *
 *  · AN HTTP RESPONSE IS REACHABILITY, WHATEVER ITS STATUS. A 500 from the app
 *    under test is very possibly THE BUG, and a preflight that refused to run
 *    on a 5xx would suppress the run that was about to catch an outage. Only a
 *    TRANSPORT failure — DNS, refused, reset, TLS, timeout — means "nothing is
 *    listening", and only that blocks anything.
 *
 *  · A BLOCK IS SCOPED TO WHAT IT ACTUALLY BREAKS. A dead base URL does not
 *    stop a CLI test or a DATABASE test; they never touch it. Blocking the whole
 *    suite on one check is how a preflight starts eating runs it had no business
 *    stopping.
 *
 *  · NOTHING HERE PERFORMS AN EXTRA LOGIN. The login probe is handed in by the
 *    caller and is the run's OWN session resolver, so the probe is the login the
 *    run was going to do anyway. A preflight that doubled every run's logins
 *    would be a tax on every customer to catch an occasional broken credential.
 *
 *  · AND IT NEVER PROBES WHAT IT CANNOT PROBE CHEAPLY. A binary is looked for
 *    on PATH with a `stat`; it is never EXECUTED. "`k6` resolves on PATH" is a
 *    weaker claim than "k6 works", and this file makes the weaker claim in
 *    writing rather than the stronger one by implication.
 */

import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { TEST_TYPES } from '@qaai/shared';
import type { NotRunKind, TestType } from '@qaai/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Tunables. Exported constants, deliberately not environment variables: a brake
// nobody deploying this could discover is not a brake (the same rule
// `QUARANTINE_BUDGET_PERCENT_DEFAULT` is written under in gates.ts).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long one base-URL probe waits.
 *
 * Ten seconds, which is deliberately generous: a cold serverless preview
 * deployment can take most of that to answer its first request, and declaring
 * such an environment dead would block the preview runs this product exists to
 * serve. The cost of being generous is bounded — see `PREFLIGHT_PROBE_ATTEMPTS`,
 * whose worst case is three of these plus the backoff, once per run.
 */
export const PREFLIGHT_TIMEOUT_MS = 10_000;

/**
 * The retry policy, and the reason there is one.
 *
 * A single TCP blip must never be allowed to condemn a run — if one failed
 * request were enough to report ENVIRONMENT_UNAVAILABLE, this file would become
 * the product's most prolific source of false negatives, and a false negative
 * here cancels a whole suite rather than one test. Three attempts with a short
 * backoff is the smallest policy that distinguishes "that packet was unlucky"
 * from "nothing is listening".
 *
 * It retries the PROBE and emphatically not the RUN. A worker-level retry of an
 * unattemptable run would re-enter a dead environment seconds later and burn an
 * attempt to learn the same thing; re-running once somebody has fixed the
 * environment is a deliberate act, and the report says so.
 */
export const PREFLIGHT_PROBE_ATTEMPTS = 3;

/** Pause between probe attempts. Linear, not exponential: this is one run's preflight, not a queue. */
export const PREFLIGHT_PROBE_BACKOFF_MS = 500;

/**
 * Types whose execution goes through the environment's base URL.
 *
 * The list is the scope of a dead-base-URL block, so a membership mistake is
 * directly a run eaten or a run wasted. Everything that drives a browser or
 * issues an HTTP request at the app under test is in; everything that runs a
 * command, opens a database, or talks to a device farm or a broker is out,
 * because those reach their target by a route this check never looked at.
 *
 * EMAIL_OTP is in: it drives a browser at the app's own sign-in page and only
 * then reads the mail catcher.
 *
 * PROTOCOL is OUT, and it is the one worth stating: a gRPC or WebSocket
 * endpoint is named by the test's own spec, so "the base URL did not answer"
 * says nothing about whether the endpoint under test did.
 */
export const BASE_URL_DEPENDENT_TEST_TYPES: ReadonlySet<TestType> = new Set<TestType>([
  'E2E',
  'SMOKE',
  'API',
  'VISUAL',
  'ACCESSIBILITY',
  'LOAD',
  'SECURITY_SMOKE',
  'CROSS_BROWSER',
  'LOCALIZATION',
  'EMAIL_OTP',
  'PERFORMANCE',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Runnability: what a test TYPE needs from the machine it runs on.
// ─────────────────────────────────────────────────────────────────────────────

export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

/**
 * One thing a type needs, and — the field that matters — WHO decides whether
 * this particular test needs it.
 *
 *   scope 'TYPE' — every test of this type needs it. Missing means the type
 *                  cannot execute on this deployment, and the run may refuse
 *                  its tests up front.
 *   scope 'SPEC' — only some tests of this type need it, and which ones is in
 *                  their spec (which tool, which browsers, which driver).
 *                  Missing is REPORTED and never blocks: refusing every MOBILE
 *                  test because `maestro` is absent would refuse the Appium
 *                  tests that have no use for it.
 *
 * `install` is not decoration. A refusal that does not say what to install is a
 * wall, and this product's own plugins already learned that the hard way —
 * every ENOENT path in packages/runner/src/plugins ends in an install line.
 */
export type Requirement =
  | { kind: 'BINARY'; scope: 'TYPE' | 'SPEC'; name: string; install: string; why?: string }
  | { kind: 'BROWSER'; scope: 'TYPE' | 'SPEC'; name: BrowserEngine; install: string; why?: string }
  | { kind: 'PLATFORM'; scope: 'TYPE' | 'SPEC'; platform: string; why: string }
  /** Something only the test's own spec names, or only the tenant's network can reach. */
  | { kind: 'UNPROBED'; scope: 'SPEC'; what: string; why: string };

export interface RequirementStatus {
  requirement: Requirement;
  /**
   * `null` means NOT CHECKED, and it is never silently turned into either
   * boolean. See the honesty rules in this file's header.
   */
  satisfied: boolean | null;
  /** One clause, for the report. Says what was looked at, not what was assumed. */
  detail: string;
}

export interface TypeRunnability {
  type: TestType;
  /**
   * `true`  — every requirement that could be checked is satisfied.
   * `false` — a TYPE-scoped requirement is definitively absent.
   * `null`  — nothing about this type could be checked, so nothing is claimed.
   */
  runnable: boolean | null;
  /** TYPE-scoped requirements that are definitively absent. Non-empty ⇒ refuse. */
  missing: readonly Requirement[];
  /** SPEC-scoped requirements that are absent: reported, never a refusal. */
  degraded: readonly Requirement[];
  requirements: readonly RequirementStatus[];
  /** Printable verbatim, install lines included. */
  reason: string;
}

const PLAYWRIGHT_INSTALL = 'npx playwright install';

/**
 * What each of the 19 types needs. The answer to "which of these can this
 * image actually execute", expressed once instead of nineteen times inside
 * nineteen plugins' ENOENT branches.
 *
 * An empty list is a real and common answer — API and SECURITY_SMOKE need
 * nothing but the environment itself — and it is NOT the same as an unknown
 * one: those two report `runnable: true` because there is genuinely nothing
 * left to check, while a type whose only requirements are SPEC-scoped reports
 * `null`, because what it needs depends on a test nobody has read yet.
 */
export const TYPE_REQUIREMENTS: Readonly<Record<TestType, readonly Requirement[]>> = {
  E2E: [
    {
      kind: 'BROWSER',
      scope: 'TYPE',
      name: 'chromium',
      install: PLAYWRIGHT_INSTALL,
      why: "QAAI's own Playwright harness drives Chromium",
    },
  ],
  SMOKE: [{ kind: 'BROWSER', scope: 'TYPE', name: 'chromium', install: PLAYWRIGHT_INSTALL }],
  VISUAL: [
    {
      kind: 'BROWSER',
      scope: 'TYPE',
      name: 'chromium',
      install: PLAYWRIGHT_INSTALL,
      why: 'a screenshot needs a browser to take it',
    },
  ],
  ACCESSIBILITY: [
    { kind: 'BROWSER', scope: 'TYPE', name: 'chromium', install: PLAYWRIGHT_INSTALL },
  ],
  LOCALIZATION: [{ kind: 'BROWSER', scope: 'TYPE', name: 'chromium', install: PLAYWRIGHT_INSTALL }],
  /*
   * Chromium is TYPE-scoped because `browserProjects` in plugins/matrix.ts
   * always includes it ("a matrix without the default browser hides
   * regressions"). The other two are SPEC-scoped: which engines a given test
   * wants is in its own spec, so a missing WebKit is reported against the
   * deployment and never refuses a chromium+firefox matrix.
   */
  CROSS_BROWSER: [
    { kind: 'BROWSER', scope: 'TYPE', name: 'chromium', install: PLAYWRIGHT_INSTALL },
    { kind: 'BROWSER', scope: 'SPEC', name: 'firefox', install: PLAYWRIGHT_INSTALL },
    { kind: 'BROWSER', scope: 'SPEC', name: 'webkit', install: PLAYWRIGHT_INSTALL },
  ],
  EMAIL_OTP: [
    { kind: 'BROWSER', scope: 'TYPE', name: 'chromium', install: PLAYWRIGHT_INSTALL },
    {
      kind: 'UNPROBED',
      scope: 'SPEC',
      what: 'a mail catcher the test can read the message out of',
      why: "it is named by the test and lives on the tenant's network, so probing it from here would be probing the wrong host",
    },
  ],
  API: [],
  SECURITY_SMOKE: [],
  LOAD: [
    {
      kind: 'BINARY',
      scope: 'TYPE',
      name: 'k6',
      install: 'brew install k6 (or https://k6.io/docs/get-started/installation/)',
      why: 'plugins/load.ts shells out to the real k6 binary rather than reimplementing a load generator',
    },
  ],
  /*
   * Lighthouse is SPEC-scoped and OPTIONAL. plugins/performance.ts falls back
   * to its own in-browser collector and says so — "which costs the audit detail
   * and nothing else" — so a PERFORMANCE test on an image with no Lighthouse
   * still produces Core Web Vitals against its budget. Reporting it as
   * unrunnable would refuse a test that works.
   */
  PERFORMANCE: [
    { kind: 'BROWSER', scope: 'TYPE', name: 'chromium', install: PLAYWRIGHT_INSTALL },
    {
      kind: 'BINARY',
      scope: 'SPEC',
      name: 'lighthouse',
      install: 'npm i -g lighthouse',
      why: 'without it the plugin uses its own collector, which costs the audit detail and nothing else',
    },
  ],
  MUTATION: [
    {
      kind: 'UNPROBED',
      scope: 'SPEC',
      what: 'the mutation tool the spec names (Stryker, PITest, mutmut, …) and the project it runs in',
      why: "the tool is chosen per test and is usually a dev dependency of the customer's repository, not a binary on this image",
    },
  ],
  INTEGRATION: [
    {
      kind: 'UNPROBED',
      scope: 'SPEC',
      what: 'the command the test declares, inside the project checkout',
      why: "it is the customer's own runner — Vitest, Jest, pytest, go test — so this image cannot know its name in advance",
    },
  ],
  UNIT_GEN: [
    {
      kind: 'UNPROBED',
      scope: 'SPEC',
      what: 'the command the test declares, inside the project checkout',
      why: 'same external-command route as INTEGRATION',
    },
  ],
  CLI: [
    {
      kind: 'UNPROBED',
      scope: 'SPEC',
      what: 'the command under test',
      why: 'the command IS the subject of a CLI test, so it is named by the spec and resolved at execution',
    },
  ],
  DATABASE: [
    {
      kind: 'UNPROBED',
      scope: 'SPEC',
      what: "a database the environment's secrets can reach",
      why: 'connecting from here would open a tenant database on a preflight, which is both a side effect and a credential use nobody asked for',
    },
  ],
  CONTRACT: [
    {
      kind: 'UNPROBED',
      scope: 'SPEC',
      what: 'a pact file in the checkout, or a reachable Pact broker',
      why: 'the spec chooses between a committed document and a broker URL, and only one of those is a local fact',
    },
  ],
  PROTOCOL: [
    {
      kind: 'BINARY',
      scope: 'SPEC',
      name: 'grpcurl',
      install: 'brew install grpcurl',
      why: 'only the gRPC specs shell out to it; a WebSocket or SSE test needs nothing but a socket',
    },
  ],
  MOBILE: [
    {
      kind: 'UNPROBED',
      scope: 'SPEC',
      what: 'the driver the spec names (an Appium server, or the Maestro / Detox / Gradle / xcodebuild CLI) and a device',
      why: "five transports behind one plugin, chosen per test — and a device farm is somebody else's machine",
    },
    {
      kind: 'PLATFORM',
      scope: 'SPEC',
      platform: 'darwin',
      why: 'XCUITest runs through xcodebuild, which only exists on macOS; the other four drivers do not care',
    },
  ],
};

/**
 * The probes, injectable so this module is testable without a filesystem and
 * without Playwright, and cached so a run pays for each lookup once.
 */
export interface RunnabilityProbes {
  /** Does this bare command name resolve to an executable on PATH? `null` = could not tell. */
  onPath?: (binary: string) => boolean | null;
  /** Is this Playwright engine's browser actually on disk? `null` = could not tell. */
  browserInstalled?: (engine: BrowserEngine) => boolean | null;
  platform?: string;
}

/*
 * Process-lifetime caches. PATH and the browser install do not change under a
 * running worker, and a 500-test suite must not stat the same eleven PATH
 * directories 500 times. Deliberately not invalidatable: a cache with a reset
 * function nothing calls is a reset function nothing calls, and the tests here
 * inject their own probes rather than reaching for one.
 */
const pathCache = new Map<string, boolean | null>();
const browserCache = new Map<BrowserEngine, boolean | null>();

/**
 * Is `binary` an executable on PATH?
 *
 * A `stat` per PATH entry, and NEVER a spawn. Executing a candidate would be
 * the stronger check and is the wrong trade twice over: it costs a process per
 * tool per run, several of these tools take seconds to print their version, and
 * `--version` is itself a command this file would be choosing to run. So the
 * claim stays the weaker, true one: "it resolves on PATH".
 *
 * Anything that is not a bare command name answers false. A value with a path
 * separator in it is a path, not a PATH lookup, and this function's entire
 * contract is the second thing.
 *
 * ── Windows answers `null`, on purpose ──────────────────────────────────────
 *
 * There is no executable bit on Windows: resolution goes through PATHEXT and a
 * per-extension search, and `X_OK` there means nothing. Rather than implement
 * and never exercise that path — the worker image is Linux and the only other
 * platform this product reasons about is macOS, for `xcodebuild` — a win32
 * worker gets "could not tell", which refuses nothing and claims nothing. That
 * is the third outcome existing for exactly this case, instead of a guess that
 * would either refuse every tool-dependent test or vouch for all of them.
 */
function onPathDefault(binary: string): boolean | null {
  const cached = pathCache.get(binary);
  if (cached !== undefined) return cached;

  let found: boolean | null = false;
  if (process.platform === 'win32') {
    found = null;
  } else if (/^[A-Za-z0-9._+-]+$/.test(binary)) {
    const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    for (const dir of dirs) {
      try {
        accessSync(join(dir, binary), fsConstants.X_OK);
        found = true;
        break;
      } catch {
        // Not here. The next directory is not an error.
      }
    }
  }

  pathCache.set(binary, found);
  return found;
}

/**
 * Is this Playwright engine downloaded?
 *
 * `executablePath()` is a pure path computation — it does not launch anything —
 * so this is a path lookup plus an `existsSync`. A throw (an old Playwright, a
 * channel-configured browser with no bundled binary, a bundler that stubbed the
 * module) answers `null`: "could not tell", which is the one answer that never
 * refuses a test and never claims one will work.
 */
async function browserInstalledDefault(engine: BrowserEngine): Promise<boolean | null> {
  const cached = browserCache.get(engine);
  if (cached !== undefined) return cached;

  let answer: boolean | null = null;
  try {
    const playwright = (await import('playwright')) as unknown as Record<
      BrowserEngine,
      { executablePath: () => string }
    >;
    const path = playwright[engine].executablePath();
    answer = typeof path === 'string' && path !== '' ? existsSync(path) : null;
  } catch {
    answer = null;
  }

  browserCache.set(engine, answer);
  return answer;
}

async function checkRequirement(
  requirement: Requirement,
  probes: RunnabilityProbes,
): Promise<RequirementStatus> {
  switch (requirement.kind) {
    case 'BINARY': {
      const onPath = probes.onPath ?? onPathDefault;
      const found = onPath(requirement.name);
      return {
        requirement,
        satisfied: found,
        detail:
          found === null
            ? `whether \`${requirement.name}\` is on PATH could not be determined on this platform, so it is not counted either way`
            : found
              ? `\`${requirement.name}\` resolves on PATH (not executed, so "it runs" is not claimed)`
              : `\`${requirement.name}\` is not on PATH — install it with: ${requirement.install}`,
      };
    }
    case 'BROWSER': {
      const installed = probes.browserInstalled
        ? probes.browserInstalled(requirement.name)
        : await browserInstalledDefault(requirement.name);
      return {
        requirement,
        satisfied: installed,
        detail:
          installed === null
            ? `whether Playwright's ${requirement.name} is installed could not be determined here, so it is not counted either way`
            : installed
              ? `Playwright's ${requirement.name} is installed`
              : `Playwright's ${requirement.name} is not installed — run: ${requirement.install}`,
      };
    }
    case 'PLATFORM': {
      const platform = probes.platform ?? process.platform;
      const ok = platform === requirement.platform;
      return {
        requirement,
        satisfied: ok,
        detail: ok
          ? `this worker is ${platform}`
          : `this worker is ${platform}, not ${requirement.platform} — ${requirement.why}`,
      };
    }
    case 'UNPROBED':
      return {
        requirement,
        satisfied: null,
        detail: `${requirement.what} is not checked here: ${requirement.why}`,
      };
  }
}

/**
 * What this deployment can execute, for the types asked about.
 *
 * `pluginless` is the caller's answer to "does a plugin exist for this type at
 * all" — the registry owns that question and this module must not import the
 * registry back (that is an import cycle, and the registry is what re-exports
 * this file). A type with no plugin is unrunnable for a reason no amount of
 * installing fixes, so it short-circuits with its own sentence.
 */
export async function checkRunnability(
  types: readonly TestType[],
  options: { probes?: RunnabilityProbes; pluginless?: (type: TestType) => string | null } = {},
): Promise<TypeRunnability[]> {
  const probes = options.probes ?? {};
  const out: TypeRunnability[] = [];

  for (const type of [...new Set(types)]) {
    const noPlugin = options.pluginless?.(type) ?? null;
    if (noPlugin !== null) {
      out.push({
        type,
        runnable: false,
        missing: [],
        degraded: [],
        requirements: [],
        reason: noPlugin,
      });
      continue;
    }

    const requirements: RequirementStatus[] = [];
    for (const requirement of TYPE_REQUIREMENTS[type]) {
      requirements.push(await checkRequirement(requirement, probes));
    }

    const missing = requirements
      .filter((r) => r.satisfied === false && r.requirement.scope === 'TYPE')
      .map((r) => r.requirement);
    const degraded = requirements
      .filter((r) => r.satisfied === false && r.requirement.scope === 'SPEC')
      .map((r) => r.requirement);
    const checked = requirements.filter((r) => r.satisfied !== null);

    /*
     * The tri-state, spelled out so nobody has to reconstruct it:
     *   something definitively missing → false
     *   nothing missing and something checked → true
     *   nothing checkable at all (every requirement SPEC-named) → null
     * A type with no requirements lands in `true` through the empty-checked
     * arm below, which is correct and is its own case: API needs nothing.
     */
    const runnable =
      missing.length > 0 ? false : checked.length > 0 || requirements.length === 0 ? true : null;

    out.push({
      type,
      runnable,
      missing,
      degraded,
      requirements,
      reason: runnabilitySentence(type, runnable, requirements, missing, degraded),
    });
  }

  return out;
}

function describeRequirement(requirement: Requirement): string {
  switch (requirement.kind) {
    case 'BINARY':
      return `\`${requirement.name}\` (${requirement.install})`;
    case 'BROWSER':
      return `Playwright's ${requirement.name} (${requirement.install})`;
    case 'PLATFORM':
      return `a ${requirement.platform} worker`;
    case 'UNPROBED':
      return requirement.what;
  }
}

function runnabilitySentence(
  type: TestType,
  runnable: boolean | null,
  requirements: readonly RequirementStatus[],
  missing: readonly Requirement[],
  degraded: readonly Requirement[],
): string {
  if (missing.length > 0) {
    return (
      `This deployment cannot execute ${type} tests: it is missing ` +
      `${missing.map(describeRequirement).join(' and ')}. ` +
      'Nothing here is a verdict on your application.'
    );
  }
  if (runnable === null) {
    return (
      `Whether ${type} tests can run here depends on each test's own spec — ` +
      `${requirements.map((r) => r.detail).join('; ')}. Not claimed either way.`
    );
  }
  /*
   * Worded to cover both kinds of absence this can describe, because they are
   * genuinely different: a missing Lighthouse costs a PERFORMANCE test its
   * audit detail and nothing else, while a missing macOS worker means an
   * XCUITest spec will refuse itself. Claiming "reduced detail" for the second
   * would promise a result that is not coming.
   */
  const note =
    degraded.length > 0
      ? ` Not present on this worker: ${degraded.map(describeRequirement).join(', ')}. ` +
        'A test whose spec asks for one of those will say so itself.'
      : '';
  return requirements.length === 0
    ? `${type} needs nothing beyond the environment under test.${note}`
    : `${type} can run here.${note}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment preflight: once per run, before any test.
// ─────────────────────────────────────────────────────────────────────────────

export type PreflightOutcome = 'OK' | 'UNAVAILABLE' | 'UNKNOWN';
export type PreflightCheckName = 'BASE_URL' | 'LOGIN' | 'REPO_WORKSPACE' | 'TOOLING';

export interface PreflightCheck {
  name: PreflightCheckName;
  outcome: PreflightOutcome;
  /** One sentence, printable verbatim onto a result row or a gate detail. */
  detail: string;
  /**
   * What this check's failure makes unattemptable. Two addressing modes because
   * the checks genuinely differ: a dead base URL is a fact about TYPES, while a
   * broken login or a missing checkout is a fact about the specific TESTS that
   * named that identity or needed that tree. Both empty on an OK or UNKNOWN
   * check — an unknown answer blocks nothing, by rule.
   */
  blocksTypes: readonly TestType[];
  blocksTestIds: readonly string[];
  /** The typed not-run kind a blocked test carries. */
  kind: NotRunKind;
}

export interface EnvironmentPreflight {
  checks: readonly PreflightCheck[];
  /**
   * The first thing that is wrong, as one sentence, or null when nothing is.
   * This is what `Run.errorMessage` carries for an unattemptable run.
   */
  reason: string | null;
  durationMs: number;
}

export interface UrlProbeResult {
  /** Did the host ANSWER? A 500 answers; a refused connection does not. */
  reached: boolean;
  status: number | null;
  /** Failure class, never the URL — a base URL can carry a token in a query. */
  detail: string;
}

export type UrlProbe = (url: string, timeoutMs: number) => Promise<UrlProbeResult>;

/**
 * The default prober: one GET, any response counts.
 *
 * GET rather than HEAD, because a surprising number of application servers and
 * CDNs answer HEAD with 405 or with nothing at all, and a preflight that read
 * that as "unreachable" would block runs against perfectly healthy hosts. The
 * body is cancelled immediately, so the cost is the headers.
 *
 * `redirect: 'manual'`: a 301 to a login page is a host that answered, and
 * following it would turn one probe into a crawl.
 */
export const fetchProbe: UrlProbe = async (url, timeoutMs) => {
  const controller = new AbortController();
  /*
   * Cleared in the `finally`, and that is not tidiness. An uncleared timer
   * holds the event loop open for up to PREFLIGHT_TIMEOUT_MS after a probe that
   * already succeeded, so a worker draining on SIGTERM would sit for ten
   * seconds per probe it had made — and the abort would fire on a controller
   * whose request is long finished, for nothing.
   */
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    // Nothing reads the body; releasing it keeps the socket from being held.
    await response.body?.cancel().catch(() => {});
    return { reached: true, status: response.status, detail: `answered HTTP ${response.status}` };
  } catch (err) {
    /*
     * Deliberately NOT `err.message`: fetch embeds the URL in its message and a
     * base URL can carry a token in its query string. The failure CLASS is the
     * diagnosis anyway — refused, DNS, TLS, timeout — and it is what a reader
     * acts on. (Same reasoning as `describeWebhookFailure` in @qaai/shared.)
     */
    const code =
      (err as { cause?: { code?: string }; code?: string } | null)?.cause?.code ??
      (err as { code?: string } | null)?.code ??
      null;
    const aborted = (err as { name?: string } | null)?.name === 'AbortError';
    const detail = aborted
      ? `did not answer within ${Math.round(timeoutMs / 1000)}s`
      : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
        ? 'its hostname does not resolve'
        : code === 'ECONNREFUSED'
          ? 'the connection was refused'
          : code === 'ECONNRESET'
            ? 'the connection was reset'
            : code && /CERT|TLS|SSL/i.test(code)
              ? `its TLS certificate was rejected (${code})`
              : `the request failed${code ? ` (${code})` : ''}`;
    return { reached: false, status: null, detail };
  } finally {
    clearTimeout(timer);
  }
};

const sleepDefault = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A preflight backoff must never be the reason a worker refuses to exit.
    timer.unref?.();
  });

/**
 * Is the environment's base URL answering?
 *
 * Retried, and the retry is the point — see `PREFLIGHT_PROBE_ATTEMPTS`. The
 * FIRST success wins and the remaining attempts are not made, so a healthy
 * environment pays for exactly one request.
 *
 * Returns UNKNOWN, blocking nothing, when the suite has no base-URL-dependent
 * test in it (there is nothing to be right or wrong about) or when the URL
 * cannot even be parsed — a malformed base URL is a configuration error the
 * environment screen should catch, and inferring "the environment is down"
 * from it would send somebody to check a VPN over a typo.
 */
export async function probeBaseUrl(args: {
  baseUrl: string;
  types: readonly TestType[];
  probe?: UrlProbe;
  timeoutMs?: number;
  attempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PreflightCheck> {
  const dependent = [...new Set(args.types)].filter((t) => BASE_URL_DEPENDENT_TEST_TYPES.has(t));
  const base = {
    name: 'BASE_URL' as const,
    blocksTypes: [],
    blocksTestIds: [],
    kind: 'BLOCKED_BY_ENV' as const,
  };

  if (dependent.length === 0) {
    return {
      ...base,
      outcome: 'UNKNOWN',
      detail:
        'No test in this run reaches the environment over HTTP, so the base URL was not probed.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(args.baseUrl);
  } catch {
    return {
      ...base,
      outcome: 'UNKNOWN',
      detail:
        "This environment's base URL is not a URL, so it could not be probed. Fix it on the environment rather than reading this as an outage.",
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ...base,
      outcome: 'UNKNOWN',
      detail: `This environment's base URL is ${parsed.protocol} rather than http(s), so it could not be probed.`,
    };
  }

  const probe = args.probe ?? fetchProbe;
  const timeoutMs = args.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  const attempts = Math.max(1, args.attempts ?? PREFLIGHT_PROBE_ATTEMPTS);
  const backoffMs = Math.max(0, args.backoffMs ?? PREFLIGHT_PROBE_BACKOFF_MS);
  const sleep = args.sleep ?? sleepDefault;

  let last: UrlProbeResult = { reached: false, status: null, detail: 'was not probed' };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      last = await probe(parsed.toString(), timeoutMs);
    } catch (err) {
      /*
       * A prober that THROWS is a bug in the prober, not evidence about the
       * environment — and this function must never be the reason a run fails to
       * start. It is recorded as a failed attempt with the class, and if every
       * attempt throws the outcome below is still a reachability verdict rather
       * than an exception escaping into the run processor.
       */
      last = {
        reached: false,
        status: null,
        detail: `the probe itself failed (${err instanceof Error ? err.name : 'unknown error'})`,
      };
    }
    if (last.reached) {
      return {
        ...base,
        outcome: 'OK',
        detail: `${parsed.origin} ${last.detail}${attempt > 1 ? ` on attempt ${attempt} of ${attempts}` : ''}. Any status counts: a 5xx may be the bug under test.`,
      };
    }
    if (attempt < attempts) await sleep(backoffMs);
  }

  return {
    name: 'BASE_URL',
    outcome: 'UNAVAILABLE',
    kind: 'BLOCKED_BY_ENV',
    blocksTypes: dependent,
    blocksTestIds: [],
    detail:
      `${parsed.origin} ${last.detail} on all ${attempts} attempts, so the ${dependent.length} ` +
      `test type(s) in this run that reach it over HTTP were not executed. ` +
      'This is a verdict on the environment, not on your application.',
  };
}

/**
 * What the caller's session resolver reports back.
 *
 * `fault` is the field that matters and it is required on a refusal, with no
 * default: a resolver that cannot say which kind of fault it hit must say so by
 * choosing, rather than have this module guess — and guessing "environment"
 * would quietly stop a broken test binding from gating, while guessing
 * "configuration" would report an outage as a wall of failing tests.
 */
export type SessionProbeResult =
  | { ok: true }
  | {
      ok: false;
      /**
       * CONFIG      — the binding is wrong: the profile was deleted, belongs to
       *               another environment, or is of a kind that cannot produce
       *               a browser session. Nothing was asked of the environment.
       * ENVIRONMENT — the credential was offered and the application refused
       *               it, or the attempt could not be made at all.
       */
      fault: 'CONFIG' | 'ENVIRONMENT';
      why?: string;
    };

/** An identity the suite needs, and the tests that are meaningless without it. */
export interface RequiredIdentity {
  profileId: string;
  /** For the sentence; never a credential. */
  label: string;
  testIds: readonly string[];
}

/**
 * Probe the identities this run needs, using the run's OWN session resolver.
 *
 * The resolver is injected rather than implemented here for two reasons, and
 * the first one is the expensive one: a preflight that logged in separately
 * would double every authenticated run's logins — thirty seconds of browser per
 * profile, paid by every customer, to catch an occasional rotated password.
 * Handing in the run's cached resolver means the probe IS the login the run was
 * about to perform, and the suite then finds the session already in the cache.
 *
 * The second is that signing in needs a database (the profile row) and a vault
 * (the secret), and this package has neither.
 */
export async function probeIdentities(args: {
  identities: readonly RequiredIdentity[];
  signIn: (profileId: string) => Promise<SessionProbeResult>;
}): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  for (const identity of args.identities) {
    if (identity.testIds.length === 0) continue;
    let resolved: SessionProbeResult;
    try {
      resolved = await args.signIn(identity.profileId);
    } catch (err) {
      resolved = {
        ok: false,
        fault: 'ENVIRONMENT',
        why: `signing in threw (${err instanceof Error ? err.message : 'unknown error'})`,
      };
    }

    if (resolved.ok) {
      checks.push({
        name: 'LOGIN',
        outcome: 'OK',
        kind: 'BLOCKED_BY_ENV',
        detail: `The session for "${identity.label}" is usable.`,
        blocksTypes: [],
        blocksTestIds: [],
      });
      continue;
    }

    /*
     * ── A broken BINDING is not a broken ENVIRONMENT ────────────────────────
     *
     * "The password rotated" and "this test points at a profile somebody
     * deleted" both arrive here as "could not sign in", and they are opposite
     * facts with opposite remedies. The first is an outage: nothing was
     * measured, and recording a failure would blame the application for a
     * credential. The second is a DEFECT IN THE SUITE — a test that claims a
     * role it cannot have — and it has to gate, because a permission test that
     * quietly stopped running is the exact silence this product exists to
     * break.
     *
     * So a configuration fault is reported and blocks NOTHING: the run's own
     * session path records those tests as failures, with the reason, as it did
     * before any of this existed. The outcome is UNKNOWN rather than
     * UNAVAILABLE because this check genuinely learned nothing about the
     * environment — it never got as far as asking it.
     */
    if (resolved.fault === 'CONFIG') {
      checks.push({
        name: 'LOGIN',
        outcome: 'UNKNOWN',
        kind: 'BLOCKED_BY_ENV',
        detail:
          `The binding for "${identity.label}" is broken rather than the environment: ` +
          `${resolved.why ?? 'no reason was reported'}. The ${identity.testIds.length} test(s) ` +
          'that claim that role are reported as failures, because a test asking for a role it ' +
          'cannot have is a defect in the suite and not an outage.',
        blocksTypes: [],
        blocksTestIds: [],
      });
      continue;
    }

    checks.push({
      name: 'LOGIN',
      outcome: 'UNAVAILABLE',
      kind: 'BLOCKED_BY_ENV',
      detail:
        `The configured login for "${identity.label}" no longer works, so the ` +
        `${identity.testIds.length} test(s) that run as that role could not be attempted. ` +
        `${resolved.why ?? 'No reason was reported.'} Nothing here is a verdict on your application.`,
      blocksTypes: [],
      blocksTestIds: identity.testIds,
    });
  }
  return checks;
}

/**
 * The repository checkout, as a preflight check.
 *
 * The materialiser in the worker already produces a typed outcome and a
 * sentence; this only re-files it so the repo gap sits in the same report as
 * the base URL and the tooling instead of being a separate concept the run
 * processor tracks on the side.
 */
export function repoWorkspaceCheck(args: {
  available: boolean;
  why: string;
  testIds: readonly string[];
}): PreflightCheck {
  return args.available
    ? {
        name: 'REPO_WORKSPACE',
        outcome: 'OK',
        kind: 'BLOCKED_BY_ENV',
        detail: 'The project repository was materialised for this run.',
        blocksTypes: [],
        blocksTestIds: [],
      }
    : {
        name: 'REPO_WORKSPACE',
        outcome: 'UNAVAILABLE',
        kind: 'BLOCKED_BY_ENV',
        detail: args.why,
        blocksTypes: [],
        blocksTestIds: args.testIds,
      };
}

/**
 * The tooling half, as a preflight check per unrunnable type.
 *
 * Kind `UNSUPPORTED`, not `BLOCKED_BY_ENV`, and the difference is the whole
 * reason the vocabulary exists: one is fixed by installing something on this
 * image and the other by fixing the thing under test. A reader who cannot tell
 * them apart cannot act on either.
 */
export function toolingChecks(runnability: readonly TypeRunnability[]): PreflightCheck[] {
  return runnability
    .filter((r) => r.runnable === false)
    .map((r) => ({
      name: 'TOOLING' as const,
      outcome: 'UNAVAILABLE' as const,
      kind: 'UNSUPPORTED' as const,
      detail: r.reason,
      blocksTypes: [r.type],
      blocksTestIds: [],
    }));
}

/**
 * The whole environment preflight, in the order the questions get cheaper to
 * answer wrongly.
 *
 * Tooling first (local, free, and an answer that does not change), then the
 * base URL (one request), then the identities — and the identities are probed
 * ONLY when the base URL answered. Driving a login at a host that is not
 * listening measures the host a second time and reports it as a credential
 * problem, which sends the reader to rotate a password that was never broken.
 *
 * The repository check is passed in rather than performed: the materialiser
 * lives in the worker, needs a vault and a GitHub token, and has already run by
 * the time this is called.
 */
export async function environmentPreflight(args: {
  baseUrl: string;
  types: readonly TestType[];
  identities?: readonly RequiredIdentity[];
  signIn?: (profileId: string) => Promise<SessionProbeResult>;
  /** Already-decided checks — today the repository checkout. */
  contributed?: readonly PreflightCheck[];
  runnability?: readonly TypeRunnability[];
  probes?: RunnabilityProbes;
  pluginless?: (type: TestType) => string | null;
  probe?: UrlProbe;
  timeoutMs?: number;
  attempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<EnvironmentPreflight> {
  const now = args.now ?? Date.now;
  const startedAt = now();

  const runnability =
    args.runnability ??
    (await checkRunnability(args.types, { probes: args.probes, pluginless: args.pluginless }));

  const checks: PreflightCheck[] = [...toolingChecks(runnability)];

  const baseUrl = await probeBaseUrl({
    baseUrl: args.baseUrl,
    types: args.types,
    probe: args.probe,
    timeoutMs: args.timeoutMs,
    attempts: args.attempts,
    backoffMs: args.backoffMs,
    sleep: args.sleep,
  });
  checks.push(baseUrl);

  if (args.signIn && args.identities && args.identities.length > 0) {
    if (baseUrl.outcome === 'UNAVAILABLE') {
      checks.push({
        name: 'LOGIN',
        outcome: 'UNKNOWN',
        kind: 'BLOCKED_BY_ENV',
        detail:
          'The configured logins were not probed because the environment itself did not answer. ' +
          'A failed login against a host that is not listening is a measurement of the host.',
        blocksTypes: [],
        blocksTestIds: [],
      });
    } else {
      checks.push(...(await probeIdentities({ identities: args.identities, signIn: args.signIn })));
    }
  }

  if (args.contributed) checks.push(...args.contributed);

  const firstBad = checks.find((c) => c.outcome === 'UNAVAILABLE') ?? null;

  return { checks, reason: firstBad?.detail ?? null, durationMs: Math.max(0, now() - startedAt) };
}

/**
 * Was this test blocked by the preflight, and by what?
 *
 * The single question the run loop asks per test. TYPE blocks and TEST blocks
 * are consulted together; the first UNAVAILABLE check that covers this test
 * wins, which makes the order of `checks` the order of explanation — tooling
 * before the base URL before the login — and that is the order a reader can act
 * on, because an image with no k6 will still have no k6 after the VPN is fixed.
 */
export function environmentBlock(
  pre: EnvironmentPreflight,
  test: { id: string; type: TestType },
): { kind: NotRunKind; why: string; check: PreflightCheckName } | null {
  for (const check of pre.checks) {
    if (check.outcome !== 'UNAVAILABLE') continue;
    const byType = check.blocksTypes.includes(test.type);
    const byId = check.blocksTestIds.includes(test.id);
    if (byType || byId) return { kind: check.kind, why: check.detail, check: check.name };
  }
  return null;
}

/**
 * Could ANY of these tests have been attempted?
 *
 * The gate on the whole run, and it is deliberately "every one of them is
 * blocked" rather than "something is blocked". A suite in which one role's
 * password rotated still has 400 tests worth running, and refusing to run them
 * would turn a small environment fault into a total loss of signal. A suite in
 * which nothing can run is a different animal: there is no verdict to be had,
 * and executing it would manufacture failures.
 */
export function unattemptable(
  pre: EnvironmentPreflight,
  tests: readonly { id: string; type: TestType }[],
): boolean {
  return tests.length > 0 && tests.every((test) => environmentBlock(pre, test) !== null);
}

/**
 * One line per blocked test type / identity, for a log line and a gate detail.
 *
 * Bounded at three names plus a count, the same shape `names()` in gates.ts
 * uses: a warning nobody can read is not a warning.
 */
export function preflightSummary(pre: EnvironmentPreflight): string {
  const bad = pre.checks.filter((c) => c.outcome === 'UNAVAILABLE');
  if (bad.length === 0) return 'Environment preflight passed.';
  const head = bad.slice(0, 3).map((c) => c.detail);
  return bad.length > 3 ? `${head.join(' ')} …and ${bad.length - 3} more.` : head.join(' ');
}

/**
 * Every type this build knows about, for the deployment-wide report.
 *
 * Exported as a frozen copy of `TEST_TYPES` rather than re-derived, so the
 * runnability report can never silently describe eighteen of nineteen types.
 */
export const ALL_TEST_TYPES: readonly TestType[] = TEST_TYPES;
