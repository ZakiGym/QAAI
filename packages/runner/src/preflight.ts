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
import {
  BROWSER_CHANNEL_LIST,
  BROWSER_ENGINE_LIST,
  CHANNEL_ENGINE,
  DEVICE_PRESET_LIST,
  MATRIX_CELL_STATUS_LIST,
  PLAYWRIGHT_CHANNEL,
  PLAYWRIGHT_DEVICE,
  TEST_TYPES,
  resolveMatrixCell,
} from '@qaai/shared';
import type {
  BrowserChannel,
  DeploymentBrowsers,
  DevicePreset,
  MatrixCell,
  MatrixCellResolution,
  MatrixCellStatus,
  NotRunKind,
  TestType,
} from '@qaai/shared';
/*
 * The cell-status → NotRunKind split, imported rather than re-derived.
 *
 * `summariseBrowserMatrix` below has to know which of the six statuses have a
 * remedy somebody can carry out on this machine and which do not, and that
 * decision already exists in ./matrix.ts as `NOT_RUN_KIND_FOR_CELL`. A second
 * copy here is how the matrix planner and the preflight come to disagree about
 * whether NEEDS_BROWSER_GRID is an install problem — and the day they disagreed,
 * one of them would be telling a customer to run `npx playwright install` for a
 * browser build that does not exist. No cycle: matrix.ts imports @qaai/shared
 * and nothing from this file.
 */
import { NOT_RUN_KIND_FOR_CELL } from './matrix.js';

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
 * A version window a plugin needs, and the flag or behaviour that moved.
 *
 * ── Why `below` is nullable and `atLeast` is not ─────────────────────────────
 *
 * A floor is something you learn by reading the plugin: it passes a flag, and
 * that flag landed in some release. A CEILING is something you learn by being
 * broken — a tool removed the flag in a major — and until that has actually
 * happened, asserting one would refuse a newer binary that works fine. So
 * `below: null` means "no upper bound is known", which is a different sentence
 * from "every future version will work", and the detail string says the first.
 *
 * `why` is not decoration: it is what makes a WRONG_VERSION row actionable.
 * "k6 >= 0.40" tells a reader nothing; "`--summary-export` is how plugins/load.ts
 * gets its metrics" tells them what breaks if they pin an older one.
 */
export interface VersionRange {
  /** Lowest version known to work, inclusive. */
  atLeast: string;
  /** First version known NOT to work, exclusive. Null = no ceiling has been established. */
  below: string | null;
  /** The flag, output format or behaviour this plugin depends on. */
  why: string;
}

/**
 * Why a requirement is not satisfied — which is a different question from
 * whether it is.
 *
 * `satisfied: false` alone cannot distinguish "k6 is not installed" from "k6 is
 * installed and is three majors too old", and those map to DIFFERENT capability
 * statuses (MISSING vs WRONG_VERSION) with different remedies: one is an
 * install, the other is an upgrade or a pin. Collapsing them is how a row that
 * says MISSING sends somebody to install a binary that is already on the image.
 *
 * `null` sits beside `satisfied: null`: nothing was established, so there is no
 * reason to give.
 */
export type UnmetReason = 'ABSENT' | 'VERSION' | null;

/**
 * Parse the leading dotted-numeric version out of a tool's `--version` output.
 *
 * Tools do not agree on this and never will: `k6 v0.49.0`, `grpcurl 1.9.1`,
 * `11.7.1` on its own line, `Chromium 121.0.6167.85`.
 *
 * ── THE TOOL'S OWN NAME HAS A DIGIT IN IT ───────────────────────────────────
 *
 * The obvious implementation is `/(\d+(?:\.\d+)*)/`, and it reads `k6 v0.49.0`
 * as version SIX — the `6` in `k6`. That is not a hypothetical: it is the first
 * thing this function did, and the test
 * 'reads the version out of whatever the tool decided to print' caught it. The
 * consequence would have been silent and expensive: `[6]` compares as newer
 * than a `0.40.0` floor, so every k6 on earth would have passed a version check
 * that never looked at a version.
 *
 * So two rules, and both are load-bearing:
 *   · the number may not be preceded by an alphanumeric, with a single `v`
 *     allowed in front of it (`v0.49.0`), which rules out the `6` in `k6`;
 *   · it must contain AT LEAST ONE DOT. A bare integer in a tool's banner is
 *     far more likely to be part of its name, a year or a build counter than a
 *     version, and reading one would be guessing.
 *
 * Returns `null` — never `[0]`, never `[]` — when nothing qualifies. A version
 * that could not be read must stay unreadable all the way to the report:
 * `0.0.0` would compare as "older than everything" and turn an unparseable
 * `--version` into a confident WRONG_VERSION against a binary that may be
 * perfectly current. That is the null-became-zero lie in its most expensive
 * form, because it refuses a working tool.
 */
export function parseVersion(raw: string): number[] | null {
  const match = /(?<![A-Za-z0-9])v?(\d+(?:\.\d+)+)/.exec(raw);
  if (!match) return null;
  const parts = match[1]!.split('.').map((part) => Number.parseInt(part, 10));
  return parts.some((part) => !Number.isFinite(part)) ? null : parts;
}

/**
 * Compare two parsed versions component-wise, treating absent components as 0.
 *
 * `1.2` and `1.2.0` are the same version, which is the behaviour every tool's
 * own `--version` assumes when it prints the short form.
 */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Is this observed `--version` output inside the range?
 *
 * Tri-state on purpose, and the `null` is the whole reason this is a function
 * rather than two comparisons: an output this cannot parse is NOT a failure. It
 * is a tool whose version we could not read, and the only honest answer is "not
 * checked".
 */
export function satisfiesRange(observed: string, range: VersionRange): boolean | null {
  const found = parseVersion(observed);
  if (!found) return null;
  const floor = parseVersion(range.atLeast);
  if (!floor) return null;
  if (compareVersions(found, floor) < 0) return false;
  if (range.below !== null) {
    const ceiling = parseVersion(range.below);
    if (!ceiling) return null;
    if (compareVersions(found, ceiling) >= 0) return false;
  }
  return true;
}

/** One line describing the window, for a refusal a human has to act on. */
export function describeRange(range: VersionRange): string {
  return range.below === null
    ? `>= ${range.atLeast} (no upper bound established)`
    : `>= ${range.atLeast} and < ${range.below}`;
}

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
  | {
      kind: 'BINARY';
      scope: 'TYPE' | 'SPEC';
      name: string;
      install: string;
      why?: string;
      /**
       * The window this plugin needs, when one has been ESTABLISHED.
       *
       * Absent on every entry in `TYPE_REQUIREMENTS` today, and that is a
       * deliberate empty default rather than an oversight — see the note on
       * `TYPE_REQUIREMENTS`. A range nobody has verified, asserted here, would
       * refuse a working binary, and "QAAI refused my k6" is a worse defect
       * than "QAAI did not check my k6's version and said so".
       */
      version?: VersionRange;
    }
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
  /**
   * WHY it is unsatisfied, when it is. Always `null` when `satisfied` is not
   * `false` — there is no reason to give for a requirement that was met or was
   * never established. This is what separates MISSING from WRONG_VERSION
   * downstream; see `UnmetReason`.
   */
  unmet: UnmetReason;
  /** One clause, for the report. Says what was looked at, not what was assumed. */
  detail: string;
  /**
   * What the version probe actually read back, when it read anything.
   *
   * `null` means no version was read — because no range is declared, because
   * the binary is absent, or because the probe could not tell. All three are
   * "not measured", and none of them may be rendered as a version.
   */
  observedVersion: string | null;
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
  /**
   * TYPE-scoped requirements that are PRESENT and outside their declared
   * window. Non-empty ⇒ refuse, exactly like `missing` — but kept apart from it
   * because the remedy is an upgrade, not an install, and a row that says
   * "missing" about an installed binary sends a reader to do the wrong thing.
   */
  wrongVersion: readonly Requirement[];
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
 *
 * ── NOT ONE ENTRY DECLARES A `version`, AND THAT IS THE HONEST DEFAULT ──────
 *
 * The WRONG_VERSION machinery is built, probed and reported — and no
 * requirement here uses it, because no minimum version for k6, Lighthouse,
 * grpcurl or any mobile driver has ever been ESTABLISHED in this repository.
 * There is no such figure in the Dockerfile, in docs/, or in the plugins
 * themselves; `plugins/load.ts` passes `--summary-export` and nobody has
 * recorded which k6 releases accept it.
 *
 * Writing a plausible floor here would be the worst available outcome. It reads
 * as measurement, it would fire on a customer's working binary, and the row it
 * produced ("WRONG_VERSION: k6 0.38 is outside >= 0.40") would be a number this
 * product invented about a tool it never tested. A requirement with no declared
 * window reports that its version was NOT READ — which is true, and which is a
 * different sentence from "any version works".
 *
 * So this list stays version-free until somebody pins a flag to a release and
 * can say how they know. The same empty-on-purpose idiom, for the same reason,
 * as `DEFAULT_TYPE_OBLIGATIONS` and `EXTRACTED_COVERAGE_DIMENSIONS` in
 * packages/shared/src/coverage-dimensions.ts.
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
  /**
   * The raw `--version` output of a binary, or `null` for "could not tell".
   *
   * ── There is deliberately NO DEFAULT for this one ──────────────────────────
   *
   * Reading a version means EXECUTING the binary, and this module's standing
   * promise (see the header: "it never probes what it cannot probe cheaply") is
   * that it does not. A default implementation here would quietly spawn up to
   * nineteen processes inside a function whose documented contract is a `stat`,
   * and several of these tools take seconds to print a version.
   *
   * So the logic lives here and the one thin adapter that spawns lives in the
   * worker (apps/worker/src/processors/preflight.ts), which already has a
   * process budget and a timeout to put around it. Absent this probe, a
   * requirement with a declared range reports `satisfied: null` and
   * NOT_CHECKED — never AVAILABLE, and never WRONG_VERSION.
   */
  binaryVersion?: (binary: string) => string | null;
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

/**
 * Check ONE requirement. Exported so its tri-state can be tested directly
 * rather than inferred from a `TypeRunnability` three layers up — the
 * `satisfied`/`unmet`/`observedVersion` combinations are the part of this file
 * most likely to be collapsed by a later edit, and a test that can only see the
 * aggregate cannot tell which of them moved.
 */
export async function checkRequirement(
  requirement: Requirement,
  probes: RunnabilityProbes,
): Promise<RequirementStatus> {
  switch (requirement.kind) {
    case 'BINARY': {
      const onPath = probes.onPath ?? onPathDefault;
      const found = onPath(requirement.name);
      if (found === null) {
        return {
          requirement,
          satisfied: null,
          unmet: null,
          observedVersion: null,
          detail: `whether \`${requirement.name}\` is on PATH could not be determined on this platform, so it is not counted either way`,
        };
      }
      if (!found) {
        return {
          requirement,
          satisfied: false,
          unmet: 'ABSENT',
          // Absent, so there is no version. Reporting one here would be reporting
          // a reading taken from a binary that is not there.
          observedVersion: null,
          detail: `\`${requirement.name}\` is not on PATH — install it with: ${requirement.install}`,
        };
      }

      /*
       * On PATH. Whether that is ENOUGH depends on whether a window has been
       * declared, and the three outcomes below are all genuinely different:
       *
       *   no range declared      → satisfied, and the detail says the version
       *                            was NOT looked at. "We did not check" must
       *                            never read as "any version works".
       *   range, no probe        → satisfied: null. The binary is here and its
       *                            version is unknown, so nothing is claimed in
       *                            either direction — not AVAILABLE (that would
       *                            vouch for a version nobody read) and not
       *                            WRONG_VERSION (that would refuse it blind).
       *   range, probe answered  → the comparison, with `null` from an
       *                            unparseable output staying null.
       */
      if (!requirement.version) {
        return {
          requirement,
          satisfied: true,
          unmet: null,
          observedVersion: null,
          detail: `\`${requirement.name}\` resolves on PATH (not executed, so "it runs" is not claimed; no version window is declared for it, so its version was not read)`,
        };
      }

      const range = requirement.version;
      const raw = probes.binaryVersion?.(requirement.name) ?? null;
      if (raw === null) {
        return {
          requirement,
          satisfied: null,
          unmet: null,
          observedVersion: null,
          detail: `\`${requirement.name}\` resolves on PATH, but its version could not be read, and this plugin needs ${describeRange(range)} — so neither its presence nor its suitability is claimed`,
        };
      }

      const verdict = satisfiesRange(raw, range);
      if (verdict === null) {
        return {
          requirement,
          satisfied: null,
          unmet: null,
          // Unparseable is not a version. See `parseVersion` on why this is not
          // allowed to become "0.0.0".
          observedVersion: null,
          detail: `\`${requirement.name}\` resolves on PATH and answered \`--version\` with something this build cannot parse as a version, so it is not counted either way (needs ${describeRange(range)})`,
        };
      }
      return {
        requirement,
        satisfied: verdict,
        unmet: verdict ? null : 'VERSION',
        observedVersion: raw,
        detail: verdict
          ? `\`${requirement.name}\` resolves on PATH and reports ${raw}, inside the ${describeRange(range)} this plugin needs`
          : `\`${requirement.name}\` is installed and reports ${raw}, which is outside the ${describeRange(range)} this plugin needs — ${range.why}. Upgrade it rather than installing it: ${requirement.install}`,
      };
    }
    case 'BROWSER': {
      const installed = probes.browserInstalled
        ? probes.browserInstalled(requirement.name)
        : await browserInstalledDefault(requirement.name);
      return {
        requirement,
        satisfied: installed,
        /*
         * A browser is either downloaded or it is not; Playwright pins the
         * build to the library version, so there is no "installed but wrong
         * version" state to report. Hence ABSENT or nothing, never VERSION.
         */
        unmet: installed === false ? 'ABSENT' : null,
        observedVersion: null,
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
        // A wrong operating system is a thing that is absent, not a thing that
        // is out of date. Nobody upgrades their way from Linux to darwin.
        unmet: ok ? null : 'ABSENT',
        observedVersion: null,
        detail: ok
          ? `this worker is ${platform}`
          : `this worker is ${platform}, not ${requirement.platform} — ${requirement.why}`,
      };
    }
    case 'UNPROBED':
      return {
        requirement,
        satisfied: null,
        unmet: null,
        observedVersion: null,
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
  options: {
    probes?: RunnabilityProbes;
    pluginless?: (type: TestType) => string | null;
    /**
     * Override what a type requires, per type.
     *
     * The production caller never passes this — `TYPE_REQUIREMENTS` is the
     * answer. It exists so the version machinery can be exercised against a
     * declared window without one being typed into the shipped table, where it
     * would fire on a customer's working binary. See the note on
     * `TYPE_REQUIREMENTS` about why that table is deliberately version-free.
     */
    requirements?: Partial<Record<TestType, readonly Requirement[]>>;
  } = {},
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
        wrongVersion: [],
        degraded: [],
        requirements: [],
        reason: noPlugin,
      });
      continue;
    }

    const requirements: RequirementStatus[] = [];
    for (const requirement of options.requirements?.[type] ?? TYPE_REQUIREMENTS[type]) {
      requirements.push(await checkRequirement(requirement, probes));
    }

    const unmetAtType = (reason: UnmetReason): Requirement[] =>
      requirements
        .filter((r) => r.satisfied === false && r.unmet === reason && r.requirement.scope === 'TYPE')
        .map((r) => r.requirement);

    const missing = unmetAtType('ABSENT');
    const wrongVersion = unmetAtType('VERSION');
    const degraded = requirements
      .filter((r) => r.satisfied === false && r.requirement.scope === 'SPEC')
      .map((r) => r.requirement);
    const checked = requirements.filter((r) => r.satisfied !== null);

    /*
     * The tri-state, spelled out so nobody has to reconstruct it:
     *   something definitively missing OR out of range → false
     *   nothing unmet and something checked → true
     *   nothing checkable at all (every requirement SPEC-named, or a declared
     *     version window with no version probe) → null
     * A type with no requirements lands in `true` through the empty-checked
     * arm below, which is correct and is its own case: API needs nothing.
     */
    const runnable =
      missing.length > 0 || wrongVersion.length > 0
        ? false
        : checked.length > 0 || requirements.length === 0
          ? true
          : null;

    out.push({
      type,
      runnable,
      missing,
      wrongVersion,
      degraded,
      requirements,
      reason: runnabilitySentence(type, runnable, requirements, missing, wrongVersion, degraded),
    });
  }

  return out;
}

function describeRequirement(requirement: Requirement): string {
  switch (requirement.kind) {
    case 'BINARY':
      return requirement.version
        ? `\`${requirement.name}\` ${describeRange(requirement.version)} (${requirement.install})`
        : `\`${requirement.name}\` (${requirement.install})`;
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
  wrongVersion: readonly Requirement[],
  degraded: readonly Requirement[],
): string {
  /*
   * ABSENT is reported BEFORE out-of-range when both apply, because the two
   * remedies are not interchangeable and the install is the one that has to
   * happen first. A reader told to upgrade a tool they have not got installed
   * will go and look for a version of it.
   */
  if (missing.length > 0) {
    return (
      `This deployment cannot execute ${type} tests: it is missing ` +
      `${missing.map(describeRequirement).join(' and ')}. ` +
      'Nothing here is a verdict on your application.'
    );
  }
  if (wrongVersion.length > 0) {
    return (
      `This deployment cannot execute ${type} tests: it HAS ` +
      `${wrongVersion.map(describeRequirement).join(' and ')}, at a version outside the ` +
      'window this plugin needs. That is an upgrade, not an install. ' +
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

// ─────────────────────────────────────────────────────────────────────────────
// Where the preflight is allowed to connect.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who is running this probe, which decides which hosts it may open.
 *
 * ── Why this is a parameter and not a rule ──────────────────────────────────
 *
 * The base URL is a CUSTOMER-NAMED HOST and this function makes our process
 * open it. In QAAI's own cloud that is textbook SSRF: a tenant who sets their
 * base URL to `http://169.254.169.254/` has arranged for our worker to fetch
 * the cloud metadata endpoint, and `probeBaseUrl`'s detail string would tell
 * them whether it answered. So in HOSTED mode a private, loopback, link-local
 * or otherwise non-public target is REFUSED.
 *
 * And a blanket refusal would be its own serious defect, which is why there are
 * two modes rather than one rule. A self-hosted QAAI exists precisely to test
 * `http://localhost:3000` and `https://app.internal`; refusing those would
 * break the install for every customer who runs this behind their own firewall,
 * and they are not attacking themselves — the worker and the target are on the
 * same side of the boundary. SELF_HOSTED therefore probes the host it was
 * given, and the check it skips is NAMED in the result rather than silently not
 * performed.
 *
 * It is a parameter and NOT an environment variable because a new env var is
 * out of scope for this slice (and a security control nobody can discover is
 * not a control). The caller is the run processor, which already knows which
 * deployment it is.
 */
export type ProbeHostMode = 'HOSTED' | 'SELF_HOSTED';

/** How this module classifies and resolves a host. Injected; no DNS in a unit test. */
export interface HostGuardIo {
  classify: (host: string) => { kind: 'address' | 'name' | 'ambiguous'; why?: string };
  /** Must answer for EVERY address the name has, not the first one. */
  resolves: (host: string) => Promise<{ ok: boolean; reason: string }>;
}

export type HostGuardVerdict =
  | { allowed: true; skipped: boolean; detail: string }
  | { allowed: false; reason: string };

/**
 * May this preflight open this host?
 *
 * Returns `skipped: true` when the mode means no check was made, so the caller
 * can SAY that rather than imply a clean bill of health. A guard that passes
 * silently in the one mode where it does nothing is indistinguishable from a
 * guard that ran, and that is the "pass that means we did not check" this
 * product may never print.
 */
export async function guardProbeHost(args: {
  hostname: string;
  mode: ProbeHostMode;
  io: HostGuardIo;
}): Promise<HostGuardVerdict> {
  if (args.mode === 'SELF_HOSTED') {
    return {
      allowed: true,
      skipped: true,
      detail:
        'This deployment is self-hosted, so the base URL was not checked against the private-address rules: ' +
        'a worker inside your own network is expected to reach your own hosts.',
    };
  }

  /*
   * `ambiguous` is treated exactly as a loopback address, which is the contract
   * `classifyHost` states and the one a caller gets wrong: `0177.0.0.1`,
   * `0x7f.0.0.1` and `2130706433` are all 127.0.0.1 to something downstream,
   * and handing one to a resolver gives the octal form a second chance.
   */
  const verdict = args.io.classify(args.hostname);
  if (verdict.kind === 'ambiguous') {
    return {
      allowed: false,
      reason: `Refusing to probe ${args.hostname}: ${verdict.why ?? 'QAAI will not guess at that host'}.`,
    };
  }

  const resolved = await args.io.resolves(args.hostname);
  if (!resolved.ok) return { allowed: false, reason: resolved.reason };

  /*
   * Honest about what this is: a CHECK, not a pin. Whoever opens the connection
   * resolves the name again, so a record set that changes between this call and
   * the fetch (rebinding, a one-second TTL) can still steer the request
   * somewhere this function refused. `resolvesPublicly` says the same thing in
   * its own header, and neither place is allowed to describe it as a guarantee.
   */
  return {
    allowed: true,
    skipped: false,
    detail: 'The base URL resolves to a public address.',
  };
}

/**
 * The real classifier and resolver, from @qaai/shared/private-address.
 *
 * Imported through the package SUBPATH and not the barrel, deliberately:
 * private-address.ts reaches for `node:dns` and the barrel is what the web
 * app's bundler consumes. That is stated in check-wiring.ts, which once
 * recommended re-exporting this module from the barrel and was telling the
 * reader to break the web build.
 *
 * Built lazily so a unit test that injects its own `HostGuardIo` never loads
 * `node:dns` at all.
 */
export async function defaultHostGuardIo(): Promise<HostGuardIo> {
  const mod = await import('@qaai/shared/private-address');
  return {
    classify: (host) => mod.classifyHost(host),
    resolves: async (host) => {
      const verdict = await mod.resolvesPublicly(host);
      return { ok: verdict.ok, reason: verdict.reason };
    },
  };
}

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
  /**
   * Where this is running, which decides whether a private target is refused.
   *
   * Defaults to HOSTED — the SAFE default, so a caller that forgets to pass it
   * gets the refusal rather than the open probe. A self-hosted deployment opts
   * IN to probing its own network, which is the direction a security default
   * has to fail.
   */
  mode?: ProbeHostMode;
  hostGuard?: HostGuardIo;
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

  /*
   * ── THE GUARD GOES HERE: BEFORE THE FIRST CONNECTION, NOT AFTER IT ─────────
   *
   * Everything above this point is parsing. This is the last line before our
   * process opens a host a customer named, so it is the only place the check
   * can be. A guard after the fetch is not a guard.
   */
  const guard = await guardProbeHost({
    hostname: parsed.hostname,
    mode: args.mode ?? 'HOSTED',
    io: args.hostGuard ?? (await defaultHostGuardIo()),
  });
  if (!guard.allowed) {
    return {
      name: 'BASE_URL',
      outcome: 'UNAVAILABLE',
      kind: 'BLOCKED_BY_ENV',
      /*
       * It BLOCKS, and it blocks the same types a dead host does — because the
       * consequence is identical: those tests were not attempted and nothing
       * about the application was measured. What differs is the sentence, and
       * it has to differ: this is a REFUSAL by QAAI, not an outage at the
       * customer, and a reader sent to check their VPN over this would never
       * find anything wrong with it.
       */
      blocksTypes: dependent,
      blocksTestIds: [],
      detail:
        `${guard.reason} A hosted QAAI worker will not open a private, loopback or link-local ` +
        `address, so the ${dependent.length} test type(s) in this run that reach the base URL ` +
        'over HTTP were not attempted. Point the environment at a publicly resolvable host, or ' +
        'run QAAI inside your own network where that target is reachable. ' +
        'This is a refusal by QAAI, not an outage in your environment.',
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
        detail:
          `${parsed.origin} ${last.detail}${attempt > 1 ? ` on attempt ${attempt} of ${attempts}` : ''}. ` +
          `Any status counts: a 5xx may be the bug under test.` +
          // Named, not implied. A degradation that is APPLIED must also be
          // REPORTED, and "the private-address check did not run" is one.
          (guard.skipped ? ` ${guard.detail}` : ''),
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

// ─────────────────────────────────────────────────────────────────────────────
// The stored session, checked without using it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One stored cookie, reduced to the only two fields this check may see.
 *
 * ── WHAT IS NOT IN THIS TYPE IS THE POINT ───────────────────────────────────
 *
 * There is no `value`. A storageState cookie's value IS the session — it is the
 * credential — and this module is the one that writes sentences into run
 * reports, gate comments and PR summaries. A type that cannot hold the secret
 * cannot leak it: not in a detail string, not truncated, not hashed, and not
 * down an error path, because there is no field for it to come from. `name` is
 * kept because "which cookie expired" is the actionable half and a cookie name
 * is not a secret; `expires` is the question being asked.
 *
 * The caller reduces a real Playwright storageState to this. That reduction is
 * the whole security boundary and it belongs at the edge, not in here.
 */
export interface StoredCookie {
  name: string;
  /** Unix SECONDS, as Playwright's storageState writes it. `-1` = a session cookie. */
  expires: number;
}

export type StorageStateVerdict =
  /** Usable as far as this check can tell. */
  | { usable: true; detail: string }
  /** Definitively unusable: an expiry in the past. */
  | { usable: false; detail: string }
  /** Nothing could be established — and this is NOT a refusal. */
  | { usable: null; detail: string };

/**
 * Is this stored session already expired?
 *
 * ── Why this exists next to a login probe that would find out anyway ────────
 *
 * Because it is free and the login is not. `probeIdentities` drives the run's
 * own session resolver, which for an expired state means a full browser login —
 * thirty seconds and a browser — to discover something an integer comparison
 * knew. More importantly it is the difference between a run that reports "your
 * stored session for 'admin' expired four days ago" and one that reports "could
 * not sign in", which sends a reader to check a password that never changed.
 *
 * ── It may only ever say NO, or say NOTHING ─────────────────────────────────
 *
 * An expiry in the past is PROOF of unusability: the browser will not send that
 * cookie. The converse is not proof of anything — a server can revoke a session
 * whose cookie has months left, and a state file full of session cookies
 * (`expires: -1`) carries no expiry to read at all. So `usable: true` is worded
 * as "nothing here says it is stale", never as "it works", and the login probe
 * remains the thing that establishes that.
 *
 * `now` is injected because a test that depends on the wall clock is a test
 * that fails at midnight somewhere.
 */
export function storageStateVerdict(args: {
  cookies: readonly StoredCookie[] | null;
  now: number;
  /**
   * How close to expiry counts as expired. A session with four seconds left
   * will not survive a suite, and reporting it as usable means the run spends
   * its budget discovering that halfway through.
   */
  marginMs?: number;
}): StorageStateVerdict {
  if (args.cookies === null) {
    return {
      usable: null,
      detail:
        'No stored session was available to inspect, so its freshness was not checked. ' +
        'That is not a verdict on the credential.',
    };
  }
  if (args.cookies.length === 0) {
    return {
      usable: null,
      detail:
        'The stored session holds no cookies, so there is no expiry to read. ' +
        'A token-only or origin-storage session is normal and is not checked here.',
    };
  }

  const margin = args.marginMs ?? STORAGE_STATE_MARGIN_MS;
  /*
   * `expires: -1` is Playwright's session cookie — it has no expiry, so it
   * cannot be stale, and including it in the "soonest expiry" arithmetic below
   * would make every session state look like it expired in 1969.
   */
  const dated = args.cookies.filter((cookie) => cookie.expires > 0);
  if (dated.length === 0) {
    return {
      usable: null,
      detail: `All ${args.cookies.length} stored cookie(s) are session cookies with no expiry, so staleness could not be established.`,
    };
  }

  const deadline = (args.now + margin) / 1000;
  const expired = dated.filter((cookie) => cookie.expires <= deadline);
  if (expired.length > 0) {
    const soonest = expired.reduce((a, b) => (a.expires <= b.expires ? a : b));
    return {
      usable: false,
      // The cookie NAME and the date. Never the value — see `StoredCookie`.
      detail:
        `The stored session is stale: ${expired.length} of ${dated.length} dated cookie(s) have ` +
        `expired, the earliest being \`${soonest.name}\` at ` +
        `${new Date(soonest.expires * 1000).toISOString()}. Re-record the session rather than ` +
        'reading the tests that need it as failures.',
    };
  }

  const soonest = dated.reduce((a, b) => (a.expires <= b.expires ? a : b));
  return {
    usable: true,
    detail:
      `Nothing in the stored session says it is stale; its earliest expiry is ` +
      `${new Date(soonest.expires * 1000).toISOString()}. Whether the application still accepts ` +
      'it is a separate question, answered by the login probe.',
  };
}

/**
 * The slack on an expiry check.
 *
 * Two minutes: long enough that a session about to die mid-suite is reported as
 * stale now rather than discovered as a wall of failures in ten minutes' time,
 * short enough that it never condemns a session that would have been fine.
 */
export const STORAGE_STATE_MARGIN_MS = 120_000;

/** An identity the suite needs, and the tests that are meaningless without it. */
export interface RequiredIdentity {
  profileId: string;
  /** For the sentence; never a credential. */
  label: string;
  testIds: readonly string[];
  /**
   * The stored session's cookie EXPIRIES, if the caller has them — reduced to
   * `StoredCookie`, which has no `value` field by construction.
   *
   * `undefined` means the caller did not supply them and the freshness check is
   * skipped; `null` means there is no stored session at all. Both are "not
   * checked", neither is a refusal.
   */
  cookies?: readonly StoredCookie[] | null;
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
  now?: () => number;
}): Promise<PreflightCheck[]> {
  const now = args.now ?? Date.now;
  const checks: PreflightCheck[] = [];
  for (const identity of args.identities) {
    if (identity.testIds.length === 0) continue;

    /*
     * The free check first, and it SHORT-CIRCUITS the login.
     *
     * An expired cookie is proof the stored session cannot work, so driving a
     * browser login to confirm it would spend thirty seconds learning what the
     * integer already said — and would report the result as "could not sign
     * in", which is the wrong diagnosis. Only `usable: false` stops here;
     * `null` and `true` both fall through to the resolver, because neither
     * establishes that the session WORKS.
     */
    if (identity.cookies !== undefined) {
      const freshness = storageStateVerdict({ cookies: identity.cookies, now: now() });
      if (freshness.usable === false) {
        checks.push({
          name: 'LOGIN',
          outcome: 'UNAVAILABLE',
          kind: 'BLOCKED_BY_ENV',
          detail:
            `The stored session for "${identity.label}" cannot be used, so the ` +
            `${identity.testIds.length} test(s) that run as that role were not attempted. ` +
            `${freshness.detail} Nothing here is a verdict on your application.`,
          blocksTypes: [],
          blocksTestIds: identity.testIds,
        });
        continue;
      }
    }

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
  /** Defaults to HOSTED inside `probeBaseUrl` — the safe direction. */
  mode?: ProbeHostMode;
  hostGuard?: HostGuardIo;
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
    mode: args.mode,
    hostGuard: args.hostGuard,
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
      checks.push(
        ...(await probeIdentities({
          identities: args.identities,
          signIn: args.signIn,
          now: args.now,
        })),
      );
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

// ─────────────────────────────────────────────────────────────────────────────
// THE BROWSER CAPABILITY PROBE — the collector `DeploymentBrowsers` was
// declared for and never got.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── THE DEFECT THIS SECTION CLOSES ──────────────────────────────────────────
 *
 * `DeploymentBrowsers` in packages/shared/src/browser-matrix.ts is the fact
 * every browser/device cell is resolved against, and its own header names THIS
 * FILE as the collector: "the one thin adapter that actually stats a browser
 * install lives in packages/runner/src/preflight.ts, which already has a probe
 * budget and a cache around it". That adapter did not exist. Nothing anywhere
 * built a `DeploymentBrowsers`, so every `resolveMatrixCell` call in the product
 * was made against `{}` — and NOT_CHECKED was not merely the usual answer, it
 * was the ONLY answer the function could ever give, for every cell, on every
 * deployment, for ever. A resolver with six statuses and one reachable outcome
 * reports nothing, and the honest-looking word NOT_CHECKED is what hid it.
 *
 * ── THE TWO WAYS TO GET THIS WRONG, WHICH ARE NOT SYMMETRIC ─────────────────
 *
 *  · ABSENT BECOMING AVAILABLE. A probe that could not tell, recorded as "yes",
 *    is a cell this deployment vouches for and cannot run: the test launches,
 *    Playwright throws, and the run reports a failure against the customer's
 *    application for a browser we never had. That is the expensive one.
 *  · ABSENT BECOMING MISSING. A probe that could not tell, recorded as "no", is
 *    a cell REFUSED on this deployment with an install line for something that
 *    may already be installed somewhere this probe does not look. "QAAI refused
 *    my Chrome" is the same class of defect as "QAAI refused my k6", and this
 *    file already made that argument once about version windows.
 *
 * So every reading is TRI-STATE and an unanswered one is OMITTED from the
 * capability rather than defaulted in either direction — which is exactly the
 * contract `DeploymentBrowsers` documents ("EVERY FIELD IS OPTIONAL AND ABSENT
 * MEANS NOT PROBED") and the reason that interface is three optional maps.
 *
 * ── AND IT STILL NEVER LAUNCHES ANYTHING ────────────────────────────────────
 *
 * The standing promise in this file's header holds here: an engine is an
 * `existsSync` against a path Playwright computes, a device preset is a lookup
 * in a registry object Playwright exports, and a channel is a `stat` per PATH
 * entry. No browser is started. Which is also why no version is read — see
 * {@link probeDeploymentBrowsers} on the one field this probe deliberately
 * leaves empty.
 */

/** Which axis of the matrix a single reading is about. */
export type BrowserCapabilityAxis = 'ENGINE' | 'CHANNEL' | 'DEVICE_PRESET';

/*
 * The compiler-enforced presence record, the same half of the pattern every
 * vocabulary with a write path carries in this repository: a fourth axis is a
 * build error here rather than a reading that falls through a `default:` and is
 * stored under a name no reader knows how to interpret. The run-time half is in
 * the test beside this file, which asserts the prober emits every axis.
 *
 * It is NOT a Prisma enum, and that is a decision rather than an omission: a
 * Prisma enum needs its TypeScript twin in packages/shared/src/constants.ts and
 * its pair in apps/api/scripts/check-enums.ts, neither of which this slice owns,
 * and `check:enums` fails a value with no twin. The stored column is TEXT,
 * validated on the way in against this union and on the way out against the
 * shared vocabularies. The exact lines to promote it are in this round's
 * handover.
 */
const BROWSER_CAPABILITY_AXIS_PRESENT: Record<BrowserCapabilityAxis, true> = {
  ENGINE: true,
  CHANNEL: true,
  DEVICE_PRESET: true,
};

export const BROWSER_CAPABILITY_AXES = Object.keys(
  BROWSER_CAPABILITY_AXIS_PRESENT,
) as ReadonlyArray<BrowserCapabilityAxis>;

/** Narrows an untrusted string — a stored row, a payload — to an axis. */
export function isBrowserCapabilityAxis(value: unknown): value is BrowserCapabilityAxis {
  return (
    typeof value === 'string' && (BROWSER_CAPABILITY_AXES as readonly string[]).includes(value)
  );
}

/**
 * One member of one axis, as the probe answered — or did not.
 *
 * `installed: null` is a first-class reading and the one that must survive to
 * storage as an ABSENCE. `detail` says what was looked at, never what was
 * assumed, and carries no path from the environment: a `detail` is rendered into
 * reports beside the capability sentence.
 */
export interface BrowserCapabilityReading {
  readonly axis: BrowserCapabilityAxis;
  /** The name from the SHARED vocabulary — `chromium`, `CHROME_BETA`, `IPHONE_14`. */
  readonly name: string;
  /** `null` means NOT PROBED, and is never rounded to either boolean. */
  readonly installed: boolean | null;
  readonly detail: string;
}

/**
 * The probes, injected, so this is testable with no Playwright and no filesystem.
 *
 * It EXTENDS `RunnabilityProbes` rather than redeclaring `onPath` and
 * `browserInstalled`, so one probe object serves both halves of a preflight and
 * the engine answer a caller injects cannot differ between them.
 */
export interface BrowserCapabilityProbes extends RunnabilityProbes {
  /**
   * Does Playwright's device registry hold this descriptor? `null` = could not
   * tell. A `false` here is a real and useful answer — the remedy is "upgrade
   * Playwright or write an explicit viewport", and `resolveMatrixCell` says so.
   */
  devicePresetKnown?: (preset: DevicePreset) => boolean | null | Promise<boolean | null>;
  /**
   * Does this CHANNEL resolve on this host? `null` = could not tell, which is
   * what the default answers most of the time, on purpose. See
   * {@link CHANNEL_PATH_CANDIDATES}.
   */
  channelResolves?: (channel: BrowserChannel) => boolean | null;
}

export interface BrowserCapabilityProbe {
  /** Every member of every axis, answered or not. The full picture, in order. */
  readonly readings: readonly BrowserCapabilityReading[];
  /** The answered readings only, in the shape `resolveMatrixCell` consumes. */
  readonly browsers: DeploymentBrowsers;
  /** The readings that came back `null`. Reported, so the gap is disclosed. */
  readonly notProbed: readonly BrowserCapabilityReading[];
  /** One sentence for an operator. Printable verbatim. */
  readonly why: string;
}

/**
 * The command names the vendors' own packages put on PATH, per channel.
 *
 * ── WHY A PATH MISS IS `null` AND NOT `false` ───────────────────────────────
 *
 * Playwright does not resolve a channel through PATH. It looks in absolute,
 * per-platform locations — `/Applications/Google Chrome.app/…` on macOS,
 * `/opt/google/chrome/chrome` and `/usr/bin/google-chrome` on Linux, Program
 * Files on Windows — so a channel that is not on PATH is NOT a channel that is
 * absent, and reporting one as MISSING would print an install line to somebody
 * who has the browser installed. A PATH HIT, on the other hand, is real
 * evidence, and the claim stays the weaker true one this file always makes:
 * the command resolves, and nothing was launched.
 *
 * The two CANARY channels have no candidates at all, and that empty list is the
 * sharpest version of the rule: Google and Microsoft publish no Linux canary, so
 * an answer of `false` would make `resolveMatrixCell` emit
 * "Install the chrome-canary browser" for a build that does not exist for this
 * platform — advice that cannot be followed, which is the precise thing
 * UNSUPPORTED_COMBINATION and NEEDS_BROWSER_GRID exist to keep out of the
 * report. Whether a cell naming CANARY is servable at all is a question for a
 * device farm, not for a `stat`, so this probe does not answer it.
 *
 * BUNDLED is empty for a different reason: it is Playwright's own build, not a
 * browser on the host, and `resolveMatrixCell` skips the channel check entirely
 * for it. A reading for BUNDLED would be a reading about nothing.
 */
const CHANNEL_PATH_CANDIDATES: Record<BrowserChannel, readonly string[]> = {
  BUNDLED: [],
  CHROME: ['google-chrome', 'google-chrome-stable'],
  CHROME_BETA: ['google-chrome-beta'],
  CHROME_DEV: ['google-chrome-unstable', 'google-chrome-dev'],
  CHROME_CANARY: [],
  MSEDGE: ['microsoft-edge', 'microsoft-edge-stable'],
  MSEDGE_BETA: ['microsoft-edge-beta'],
  MSEDGE_DEV: ['microsoft-edge-dev'],
  MSEDGE_CANARY: [],
};

/*
 * Process-lifetime cache, for the same reason `browserCache` above has one: the
 * device registry is a frozen object inside an installed module and a 500-test
 * suite must not import Playwright seventeen times to read it. Not
 * invalidatable, like its two neighbours — the tests inject their own probe.
 */
const devicePresetCache = new Map<DevicePreset, boolean | null>();

/**
 * Is this device preset in Playwright's registry?
 *
 * A property lookup on the `devices` object, which is a plain data table in the
 * installed module — no launch, no spawn, no path computation. A throw (no
 * Playwright, a bundler that stubbed it, a version with no `devices` export)
 * answers `null`: the one answer that neither refuses a cell nor vouches for it.
 *
 * `hasOwnProperty` rather than a truthiness check, because `devices` is an
 * ordinary object and a prototype hit would answer `true` for a descriptor named
 * `constructor` — a cell key is customer-supplied text in the general case, and
 * a probe that answered AVAILABLE for `constructor` would be a capability
 * invented out of a prototype chain.
 */
async function devicePresetKnownDefault(preset: DevicePreset): Promise<boolean | null> {
  const cached = devicePresetCache.get(preset);
  if (cached !== undefined) return cached;

  let answer: boolean | null = null;
  try {
    const playwright = (await import('playwright')) as unknown as {
      devices?: Record<string, unknown>;
    };
    const registry = playwright.devices;
    if (registry && typeof registry === 'object') {
      answer = Object.prototype.hasOwnProperty.call(registry, PLAYWRIGHT_DEVICE[preset]);
    }
  } catch {
    answer = null;
  }

  devicePresetCache.set(preset, answer);
  return answer;
}

/** The default channel probe: a PATH hit is `true`, and everything else is `null`. */
function channelResolvesDefault(
  channel: BrowserChannel,
  onPath: (binary: string) => boolean | null,
): boolean | null {
  for (const candidate of CHANNEL_PATH_CANDIDATES[channel]) {
    if (onPath(candidate) === true) return true;
  }
  return null;
}

/**
 * Probe every axis member this build knows about, once.
 *
 * ── `versions` IS LEFT EMPTY, AND THAT IS THE HONEST SHAPE ──────────────────
 *
 * `DeploymentBrowsers.versions` exists and this probe writes nothing into it, so
 * a cell that PINS a browser version resolves NOT_CHECKED with the reason
 * "no version was read for chromium/BUNDLED" — which is true. Reading a browser
 * version means EXECUTING a browser, which this module promises not to do, and
 * the alternative was worse than a gap: a fabricated or mis-parsed reading would
 * produce WRONG_VERSION against a browser that works, and WRONG_VERSION is a
 * REFUSAL. Nobody has established a browser version floor in this repository
 * either — the same empty-on-purpose default, for the same reason, as the
 * version-free `TYPE_REQUIREMENTS` above. When somebody wants it, the adapter
 * belongs beside `binaryVersion` in the worker, which already owns the one place
 * allowed to spawn.
 */
export async function probeDeploymentBrowsers(
  probes: BrowserCapabilityProbes = {},
): Promise<BrowserCapabilityProbe> {
  const readings: BrowserCapabilityReading[] = [];
  const engines: Record<string, boolean> = {};
  const channels: Record<string, boolean> = {};
  const devicePresets: Record<string, boolean> = {};

  for (const engine of BROWSER_ENGINE_LIST) {
    const answer = await (probes.browserInstalled
      ? probes.browserInstalled(engine)
      : browserInstalledDefault(engine));
    if (answer !== null) engines[engine] = answer;
    readings.push({
      axis: 'ENGINE',
      name: engine,
      installed: answer,
      detail:
        answer === null
          ? `whether Playwright's ${engine} is downloaded could not be determined here, so it is not recorded either way`
          : answer
            ? `Playwright's ${engine} is on disk`
            : `Playwright's ${engine} is not downloaded — run: ${PLAYWRIGHT_INSTALL}`,
    });
  }

  const onPath = probes.onPath ?? onPathDefault;
  for (const channel of BROWSER_CHANNEL_LIST) {
    // BUNDLED is Playwright's own build, not a browser on the host. See
    // CHANNEL_PATH_CANDIDATES.
    if (CHANNEL_ENGINE[channel] === null) continue;
    const answer = probes.channelResolves
      ? probes.channelResolves(channel)
      : channelResolvesDefault(channel, onPath);
    if (answer !== null) channels[channel] = answer;
    const launcher = PLAYWRIGHT_CHANNEL[channel] ?? channel;
    readings.push({
      axis: 'CHANNEL',
      name: channel,
      installed: answer,
      detail:
        answer === null
          ? `the ${launcher} channel was not probed: Playwright resolves a channel by absolute per-platform paths, not through PATH, so a PATH miss is not evidence it is absent`
          : answer
            ? `a ${launcher} command resolves on PATH (not launched, so "it runs" is not claimed)`
            : `the ${launcher} channel did not resolve on this host`,
    });
  }

  for (const preset of DEVICE_PRESET_LIST) {
    const answer = await (probes.devicePresetKnown
      ? probes.devicePresetKnown(preset)
      : devicePresetKnownDefault(preset));
    if (answer !== null) devicePresets[preset] = answer;
    readings.push({
      axis: 'DEVICE_PRESET',
      name: preset,
      installed: answer,
      detail:
        answer === null
          ? `Playwright's device registry could not be read here, so "${PLAYWRIGHT_DEVICE[preset]}" is not recorded either way`
          : answer
            ? `"${PLAYWRIGHT_DEVICE[preset]}" is in Playwright's device registry`
            : `Playwright's device registry on this deployment has no descriptor named "${PLAYWRIGHT_DEVICE[preset]}"`,
    });
  }

  const notProbed = readings.filter((reading) => reading.installed === null);
  /*
   * The three maps are accumulated as `Record<string, boolean>` because a key is
   * only ever written from the shared vocabulary lists in the loops above. What
   * a reader has to be able to trust is the SHAPE: only ANSWERED members are
   * present, so an absent key means not probed — which is the contract
   * `DeploymentBrowsers` documents and the reason its three maps are optional.
   */
  const browsers: DeploymentBrowsers = { engines, channels, devicePresets };

  return {
    readings,
    browsers,
    notProbed,
    why:
      `${readings.length - notProbed.length} of ${readings.length} browser-matrix axis members were ` +
      `answered on this deployment; ${notProbed.length} could not be probed and are recorded as ` +
      'ABSENT rather than as a yes or a no. No browser version was read, so a cell that pins one ' +
      'resolves NOT_CHECKED — no browser was launched to ask.',
  };
}

/**
 * The cells this probe can actually answer for, one per axis member.
 *
 * ── EVERY QUESTION IN HERE IS COHERENT, BY CONSTRUCTION ─────────────────────
 *
 * Each channel is paired with the engine it is a build OF (`CHANNEL_ENGINE`),
 * never with an arbitrary one, so no cell this function produces can resolve
 * UNSUPPORTED_COMBINATION — "is there a Firefox beta installed" is a question
 * with no meaningful answer and asking it would put a status in the report that
 * says more about the question than about the deployment. No cell pins a
 * version, so none resolves NEEDS_BROWSER_GRID either. Both statuses are
 * properties of a CUSTOMER's declared cell, which is why
 * {@link summariseBrowserMatrix} still handles them.
 *
 * BUNDLED gets no cell of its own: the bare `{ engine }` cells above already ARE
 * the bundled build, and `resolveMatrixCell` treats an absent channel as BUNDLED.
 */
export function deploymentProbeCells(): readonly MatrixCell[] {
  const cells: MatrixCell[] = BROWSER_ENGINE_LIST.map((engine) => ({ engine }));
  for (const channel of BROWSER_CHANNEL_LIST) {
    const engine = CHANNEL_ENGINE[channel];
    if (engine === null) continue;
    cells.push({ engine, channel });
  }
  for (const preset of DEVICE_PRESET_LIST) {
    cells.push({ device: { kind: 'PRESET', preset } });
  }
  return cells;
}

/**
 * Resolve a cell set against a collected capability.
 *
 * One line, and it exists so there is ONE place the product turns a stored
 * capability into cell verdicts. `resolveMatrixCell` takes a defaulted `{}`
 * second argument, which is the correct and dangerous default: a caller that
 * forgets it gets NOT_CHECKED for everything and a report that looks fine.
 * Requiring it here means a caller has to have the capability in hand.
 */
export function resolveDeploymentCells(
  browsers: DeploymentBrowsers,
  cells: readonly MatrixCell[] = deploymentProbeCells(),
): readonly MatrixCellResolution[] {
  return cells.map((cell) => resolveMatrixCell(cell, browsers));
}

/**
 * What the resolved cells add up to, split by WHAT A READER CAN DO ABOUT IT.
 *
 * ── THE SPLIT IS THE POINT, AND IT IS NOT "PASS / FAIL" ─────────────────────
 *
 * Four buckets, because the six statuses answer to four different sentences:
 *
 *   available      — probed, and this image can run it.
 *   installable    — MISSING or WRONG_VERSION: there is a command somebody can
 *                    run on this machine, and the resolution carries it.
 *   impossibleHere — UNSUPPORTED_COMBINATION or NEEDS_BROWSER_GRID: THERE IS NO
 *                    INSTALL. No build of Firefox has a beta channel, and no
 *                    amount of installing is ever going to be Safari. Printing
 *                    an install line against one of these is advice that cannot
 *                    be followed, and advice that cannot be followed is how a
 *                    reader learns to ignore the whole report.
 *   notChecked     — nobody asked. Not a verdict in either direction, and it
 *                    STAYS IN the denominator: a cell dropped for want of a
 *                    probe would raise a percentage nobody measured. That is the
 *                    rule `UNEXERCISABLE_CELL_STATUSES` states, and this
 *                    function holds no second opinion about it.
 *
 * The classification DELEGATES to `NOT_RUN_KIND_FOR_CELL` in ./matrix.ts rather
 * than re-deciding: that `Record` is already the one place the product decides
 * which statuses have a local remedy, a seventh status is a compile error there,
 * and two copies would eventually disagree.
 */
export interface BrowserMatrixSummary {
  readonly byStatus: Readonly<Record<MatrixCellStatus, number>>;
  readonly available: readonly MatrixCellResolution[];
  /** A remedy a human can carry out HERE. The resolution's own `remedy` says what. */
  readonly installable: readonly MatrixCellResolution[];
  /** No install fixes these. Never reported with an install line. */
  readonly impossibleHere: readonly MatrixCellResolution[];
  readonly notChecked: readonly MatrixCellResolution[];
  /**
   * HOW MANY CELLS THIS IMAGE WOULD REFUSE — and NULL, never 0, when nothing
   * was probed.
   *
   * `installable + impossibleHere` is the number an operator alerts on, and
   * apps/worker/src/index.ts logged exactly that sum as a field. It already
   * logged `null` for the case where the capability store could not be reached,
   * with the right reason attached: a zero there "would read as 'this image
   * refuses nothing', which is the most flattering possible reading of a
   * question nobody got to ask".
   *
   * THE REACHABLE-BUT-EMPTY CASE IS THE SAME QUESTION AND WAS GETTING 0.
   * `resolveMatrixCell` answers NOT_CHECKED for every cell when the deployment
   * reported nothing, so an empty capability table puts every cell in
   * `notChecked` and leaves both refusal buckets at length 0 — and the sum is
   * 0, indistinguishable from an image that was probed and refuses nothing.
   * That is a zero nobody read, and it is the normal state of a deployment
   * between the migration landing and the first sweep running.
   *
   * NULL ONLY WHEN NO CELL CARRIES A READING, which is the other half of the
   * rule and the easier one to get wrong in the opposite direction. If five
   * cells were probed and none of them is refusable, 0 IS a reading — of those
   * five — and nulling it because the other fourteen are unprobed would discard
   * a measurement somebody took. `notChecked` stays in the denominator either
   * way, which is what makes a partial 0 readable: the two fields are only
   * meaningful side by side, and that is why they are logged side by side.
   */
  readonly refusableCells: number | null;
  /** One sentence for an operator, with the counts and the first few names. */
  readonly sentence: string;
}

/** Bounded at three names plus a count — the shape `names()` in gates.ts uses. */
function someNames(resolutions: readonly MatrixCellResolution[]): string {
  const names = resolutions.map((resolution) => resolution.key);
  return names.length > 3
    ? `${names.slice(0, 3).join(', ')} …and ${names.length - 3} more`
    : names.join(', ');
}

export function summariseBrowserMatrix(
  resolutions: readonly MatrixCellResolution[],
): BrowserMatrixSummary {
  /*
   * Seeded from `MATRIX_CELL_STATUS_LIST`, which is itself derived from a
   * compiler-enforced presence record in @qaai/shared — so every status is a key
   * here without this file keeping a parallel list that could go one member
   * stale. A status with no entry would read as `undefined` in a report, which
   * is the kind of blank a reader fills in as zero.
   */
  const byStatus = Object.fromEntries(
    MATRIX_CELL_STATUS_LIST.map((status) => [status, 0]),
  ) as Record<MatrixCellStatus, number>;

  const available: MatrixCellResolution[] = [];
  const installable: MatrixCellResolution[] = [];
  const impossibleHere: MatrixCellResolution[] = [];
  const notChecked: MatrixCellResolution[] = [];

  for (const resolution of resolutions) {
    byStatus[resolution.status] += 1;
    const kind = NOT_RUN_KIND_FOR_CELL[resolution.status];
    if (kind === null) {
      // The two statuses that RUN. AVAILABLE is a measurement; NOT_CHECKED is an
      // attempt made with no evidence behind it, and they may not be added up.
      (resolution.status === 'NOT_CHECKED' ? notChecked : available).push(resolution);
    } else if (kind === 'BLOCKED_BY_ENV') {
      installable.push(resolution);
    } else {
      impossibleHere.push(resolution);
    }
  }

  const parts = [
    `${resolutions.length} browser/device cells were resolved against what this deployment reported: ` +
      `${available.length} available, ${installable.length} fixable here, ` +
      `${impossibleHere.length} that no install on this image can ever serve, ` +
      `${notChecked.length} not probed.`,
  ];
  if (installable.length > 0) {
    parts.push(
      `Fixable here: ${someNames(installable)} — ${installable[0]!.remedy ?? 'see the cell detail'}.`,
    );
  }
  if (impossibleHere.length > 0) {
    /*
     * The resolution's OWN remedy, verbatim, and never an install line: these
     * are the cells whose answer is a hosted grid, a device farm, or a different
     * cell. `resolveMatrixCell` already writes the right sentence for both
     * statuses; repeating it in this file's words is how it would drift into an
     * install.
     */
    parts.push(
      `Not an install: ${someNames(impossibleHere)} — ${impossibleHere[0]!.remedy ?? 'see the cell detail'}.`,
    );
  }
  if (notChecked.length > 0) {
    parts.push(
      `${notChecked.length} cell(s) were never probed: NOT_CHECKED is not a verdict about this ` +
        'image in either direction, and those cells stay IN the denominator — a cell dropped for ' +
        'want of a probe would raise a percentage nobody measured.',
    );
  }

  /*
   * A cell CARRIES A READING when something was concluded about it — available,
   * fixable here, or impossible here. With none of those, every cell is
   * NOT_CHECKED and the refusal count is a zero nobody took; see the field's
   * own note on {@link BrowserMatrixSummary}.
   */
  const read = available.length + installable.length + impossibleHere.length;

  return {
    byStatus,
    available,
    installable,
    impossibleHere,
    notChecked,
    refusableCells: read === 0 ? null : installable.length + impossibleHere.length,
    sentence: parts.join(' '),
  };
}
