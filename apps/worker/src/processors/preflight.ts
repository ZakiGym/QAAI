/**
 * What this deployment can actually EXECUTE, written down.
 *
 * ── The lie this file exists to kill ────────────────────────────────────────
 *
 * The worker image has no k6, no Lighthouse, no Stryker, no Maestro, no Firefox
 * and no WebKit. The plugins for those types do not crash — they degrade to
 * SKIPPED and say so politely, once, in a result row nobody aggregates. So a
 * pass rate could be computed over tests that CANNOT FAIL, and a coverage
 * percentage could count obligations this deployment has no way of discharging.
 * Nothing anywhere said which of the nineteen types this image can run, which
 * means the headline number had tests in it that were never going to execute,
 * and the customer had no way to find that out.
 *
 * `packages/runner/src/preflight.ts` already answers the question per run, for
 * the types that run happens to contain, in memory, and throws the answer away.
 * This file is the half that was missing: it asks about ALL NINETEEN, writes the
 * answer to `DeploymentCapability` with the time it was taken, and hands the
 * coverage denominator a set it can subtract from — with a reason per
 * subtraction, so the report says "4 of 19 test types are not executable here"
 * instead of quietly dividing by a smaller number.
 *
 * ── Why a function and not a queue ──────────────────────────────────────────
 *
 * There is no `new Queue(...)` here, deliberately. A producer in this file with
 * no `register(...)` in apps/worker/src/index.ts — a file this slice does not
 * own — would be a queue whose jobs wait forever, and `npm run check:wiring`
 * reports exactly that as a failure. So the entry point is an ordinary async
 * function the run processor calls, and the enqueue-and-register pair is named
 * in the handover rather than half-built here.
 *
 * ── The cache, and the cache's own failure mode ─────────────────────────────
 *
 * Probing is cheap (a `stat` per PATH entry, plus at most one `--version` per
 * binary that has a declared window) but it is not free, and 500 tests must not
 * pay for it 500 times. So the rows are cached and `checkedAt` is part of the
 * answer.
 *
 * And a cache is precisely how this feature becomes the thing it was built to
 * prevent: A CACHED `AVAILABLE` FOR A BINARY THAT HAS SINCE VANISHED IS A LIE
 * ABOUT THE IMAGE. Someone rebuilds the container without k6 and the stored row
 * keeps vouching for it. That is why the window is short, why the probe is kept
 * cheap enough to repeat, and why a row with no `checkedAt` is NOT_CHECKED
 * rather than anything else — the age of the answer is part of the answer.
 *
 * ── What may never happen here ──────────────────────────────────────────────
 *
 *  · NOT_CHECKED IS NOT MISSING. A type nobody probed is not a verdict about
 *    the image. Writing MISSING for it is a claim we never looked at; writing
 *    AVAILABLE is worse.
 *  · NOT_CHECKED STAYS IN THE DENOMINATOR. Dropping it would let a deployment
 *    that never ran a preflight shed every obligation it could not prove it
 *    could run, and the percentage would RISE for a preflight nobody executed.
 *  · A CAP THAT BIT IS REPORTED. The version probe has a timeout. When it
 *    fires, the row says the version was not read and why — it never falls back
 *    to "looks fine".
 *  · NO CREDENTIALS, EVER. `detail` is rendered into coverage reports and PR
 *    comments. Nothing from an auth profile, a cookie, a storageState or an OTP
 *    reaches it — not truncated, not hashed, not down an error path.
 */

import {
  ALL_TEST_TYPES,
  CHANNEL_REQUIREMENTS_DEMOTED,
  checkRunnability,
  declaredRequirements,
  declaredRunnability,
  isBrowserCapabilityAxis,
  probeDeploymentBrowsers,
  requirementParity,
  resolveDeploymentCells,
  summariseBrowserMatrix,
  undeclaredPluginTypes,
} from '@qaai/runner';
import type {
  BrowserCapabilityAxis,
  BrowserCapabilityProbes,
  BrowserCapabilityReading,
  BrowserMatrixSummary,
  RunnabilityProbes,
  TypeRunnability,
} from '@qaai/runner';
import {
  BROWSER_CHANNEL_LIST,
  BROWSER_ENGINE_LIST,
  DEVICE_PRESET_LIST,
  PENDING_TEST_TYPES,
  SELF_DEPLOYMENT,
  TEST_TYPES,
  capabilityCounts,
  isTestType,
} from '@qaai/shared';
import type { DeploymentBrowsers, MatrixCellResolution, TestType } from '@qaai/shared';
import { DeploymentCapabilityStatus } from '../../../api/src/generated/prisma/enums.js';
import { logger, prisma } from '../context.js';

/**
 * The capability status vocabulary, as the GENERATED PRISMA CLIENT types it.
 *
 * The status TYPE comes from the generated client because that is the actual
 * domain of the column this file writes, and importing the generated client is
 * the established way this app reaches Prisma types (apps/worker/src/context.ts
 * does the same). The DECISION about which statuses count is NOT duplicated
 * here — see `capabilityExecutable`.
 */
export type CapabilityStatus = DeploymentCapabilityStatus;

/**
 * Every status, as a compiler-enforced presence record.
 *
 * This is the first half of the pattern this codebase enforces for a vocabulary
 * with a write path: adding a member to the Prisma enum fails to compile HERE
 * until somebody has looked at it. The run-time half is in the test beside it,
 * which compares these keys against the generated enum's own — and that pairing
 * catches something `apps/api/scripts/check-enums.ts` structurally cannot, since
 * it compares schema.prisma's TEXT to the shared const and would not notice a
 * GENERATED CLIENT that is stale relative to either.
 */
const CAPABILITY_STATUS_PRESENT: Record<CapabilityStatus, true> = {
  AVAILABLE: true,
  MISSING: true,
  WRONG_VERSION: true,
  NOT_CHECKED: true,
};

export const CAPABILITY_STATUS_KINDS = Object.keys(
  CAPABILITY_STATUS_PRESENT,
) as ReadonlyArray<CapabilityStatus>;

/**
 * Whether an obligation of this type can be executed here, and therefore scored.
 *
 * DELEGATES to `capabilityCounts` in packages/shared/src/coverage-dimensions.ts
 * rather than re-deciding. That function is the one place the
 * MISSING/WRONG_VERSION-leave, NOT_CHECKED-stays rule lives, and it is also what
 * `coverageMatrix` in packages/agent consults — so a second copy here would be
 * two implementations of one exclusion rule, and the day they disagreed the
 * denominator and the report would disagree about the same deployment.
 *
 * It exists as a named wrapper only so this module reads in its own vocabulary;
 * it adds no logic, and a test asserts it agrees with the shared function on
 * every member of the enum.
 */
export function capabilityExecutable(status: CapabilityStatus): boolean {
  return capabilityCounts(status);
}

/**
 * The deployment whose image this process IS.
 *
 * Re-exported from `SELF_DEPLOYMENT` in @qaai/shared rather than retyped, so
 * this writer and every reader agree on the sentinel. It is a sentinel rather
 * than a nullable column because the unique key is (deploymentKey, testType)
 * and PostgreSQL treats NULLs there as DISTINCT — a null would let the same
 * probe be written twice and the upsert would stop being idempotent.
 */
export const SELF_DEPLOYMENT_KEY: string = SELF_DEPLOYMENT;

/**
 * How long a probe's answer is trusted.
 *
 * Ten minutes. The number is a trade between two failure modes and is set
 * closer to the expensive one: too long and a rebuilt image keeps a stale
 * AVAILABLE (the lie this table exists to kill); too short and a 500-test suite
 * re-stats PATH repeatedly for no new information. Ten minutes is far shorter
 * than the interval between container rebuilds and far longer than a suite, so
 * in practice a run probes once and a rebuild is noticed on its first run.
 *
 * Not an environment variable: a brake nobody deploying this could discover is
 * not a brake (the same rule `PREFLIGHT_TIMEOUT_MS` is written under).
 */
export const CAPABILITY_FRESH_MS = 600_000;

/**
 * How long one `--version` call gets.
 *
 * Three seconds. Several of these tools are slow to print a version and one of
 * them hanging must not hold a run's first test. When it bites, the row says
 * the version was NOT READ and names the timeout — it never degrades to a
 * cheerful AVAILABLE, which would be a pass meaning "we did not check".
 */
export const VERSION_PROBE_TIMEOUT_MS = 3_000;

// ─── The I/O, injected ───────────────────────────────────────────────────────

/**
 * The one piece of real I/O this module adds, behind a narrow interface.
 *
 * `binaryVersion` is here and NOT in packages/runner/src/preflight.ts because
 * reading a version means EXECUTING a binary, and that module's standing
 * promise is that it only ever `stat`s. This is the thin adapter that breaks
 * the promise on purpose, in one place, with a timeout around it.
 */
export interface CapabilityIo {
  /** Raw `--version` output, or null for "could not tell". Must never throw. */
  binaryVersion: (binary: string) => Promise<string | null>;
  now: () => Date;
}

/**
 * The real adapter. `node:child_process` is imported LAZILY so a unit test that
 * injects its own `CapabilityIo` never loads it — the same shape, and the same
 * reason, as `defaultHostGuardIo` in the runner's preflight.
 */
export function defaultCapabilityIo(): CapabilityIo {
  return {
    now: () => new Date(),
    binaryVersion: async (binary) => {
      /*
       * Anything that is not a bare command name is refused rather than run.
       * This function's argument comes from `TYPE_REQUIREMENTS`, which is a
       * literal table in this repository and not customer input — but it is one
       * refactor away from not being, and the cost of the guard is a regex.
       * `execFile` with an argument array never involves a shell, so there is no
       * metacharacter to worry about either way.
       */
      if (!/^[A-Za-z0-9._+-]+$/.test(binary)) return null;
      try {
        const { execFile } = await import('node:child_process');
        return await new Promise<string | null>((resolve) => {
          const child = execFile(
            binary,
            ['--version'],
            { timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true },
            (err, stdout, stderr) => {
              /*
               * A non-zero exit is NOT a failure to read a version. Several
               * tools print their version and exit 1, or print it to stderr. So
               * the output is what matters, and only genuinely empty output is
               * "could not tell".
               */
              const out = `${stdout ?? ''}${stderr ?? ''}`.trim();
              if (out.length > 0) return resolve(out);
              return resolve(err ? null : null);
            },
          );
          child.on('error', () => resolve(null));
        });
      } catch {
        // A spawn that could not even be attempted is "could not tell", which
        // refuses nothing and claims nothing.
        return null;
      }
    },
  };
}

// ─── Mapping a runnability verdict onto a stored status ──────────────────────

/** What one type's row will say, before it is written. */
export interface CapabilityRow {
  testType: TestType;
  status: CapabilityStatus;
  /** Printable verbatim. Install lines included. Never a credential. */
  detail: string;
  /** The exact command this image would need. Null when there is nothing to run. */
  remedy: string | null;
  requiredBinary: string | null;
  /** The window the plugin needs. NULL means no window is declared, NOT "any version". */
  requiredVersion: string | null;
  /** What was read back. NULL means no version was read, NOT "0". */
  observedVersion: string | null;
}

/**
 * Turn the runner's tri-state into the stored four-state.
 *
 * The two vocabularies are not the same shape and the gap between them is the
 * whole reason this function is worth reading:
 *
 *   runnable === false, something ABSENT        → MISSING
 *   runnable === false, something out of range  → WRONG_VERSION
 *   runnable === true                           → AVAILABLE
 *   runnable === null                            → NOT_CHECKED
 *
 * That last line is the one to get right. `null` from the runner means "nothing
 * about this type could be established" — every requirement is named by a
 * test's own spec, or a declared version window had no probe behind it. Calling
 * that MISSING would be a claim about an image nobody looked at; calling it
 * AVAILABLE would vouch for tooling nobody found. It is NOT_CHECKED, and
 * NOT_CHECKED keeps its obligation in the denominator.
 *
 * ABSENT is reported before out-of-range when both apply, for the reason the
 * runner's own sentence builder gives: the install has to happen before the
 * upgrade can.
 */
export function capabilityRowFor(runnability: TypeRunnability): CapabilityRow {
  const { type, missing, wrongVersion, runnable } = runnability;

  const absent = missing[0];
  if (absent) {
    return {
      testType: type,
      status: DeploymentCapabilityStatus.MISSING,
      detail: runnability.reason,
      remedy:
        absent.kind === 'BINARY' || absent.kind === 'BROWSER'
          ? absent.install
          : absent.kind === 'PLATFORM'
            ? `run this test type on a ${absent.platform} worker`
            : null,
      requiredBinary: absent.kind === 'BINARY' ? absent.name : null,
      requiredVersion:
        absent.kind === 'BINARY' && absent.version ? describeWindow(absent.version) : null,
      // It is absent, so no version was read off it. See CapabilityRow.
      observedVersion: null,
    };
  }

  const stale = wrongVersion[0];
  if (stale) {
    const observed = runnability.requirements.find(
      (r) => r.requirement === stale,
    )?.observedVersion;
    return {
      testType: type,
      status: DeploymentCapabilityStatus.WRONG_VERSION,
      detail: runnability.reason,
      remedy: stale.kind === 'BINARY' || stale.kind === 'BROWSER' ? stale.install : null,
      requiredBinary: stale.kind === 'BINARY' ? stale.name : null,
      requiredVersion:
        stale.kind === 'BINARY' && stale.version ? describeWindow(stale.version) : null,
      observedVersion: observed ?? null,
    };
  }

  /*
   * `runnable === false` with neither bucket populated is the pluginless case:
   * the registry has no plugin for this type at all. MISSING is right — the
   * capability is genuinely absent — and the remedy is null because no install
   * fixes it. Falling through to AVAILABLE here would report a type with no
   * implementation as executable, which is the worst single mistake available
   * in this function.
   */
  if (runnable === false) {
    return {
      testType: type,
      status: DeploymentCapabilityStatus.MISSING,
      detail: runnability.reason,
      remedy: null,
      requiredBinary: null,
      requiredVersion: null,
      observedVersion: null,
    };
  }

  if (runnable === null) {
    return {
      testType: type,
      status: DeploymentCapabilityStatus.NOT_CHECKED,
      detail: runnability.reason,
      remedy: null,
      requiredBinary: null,
      requiredVersion: null,
      observedVersion: null,
    };
  }

  const versioned = runnability.requirements.find((r) => r.observedVersion !== null);
  return {
    testType: type,
    status: DeploymentCapabilityStatus.AVAILABLE,
    detail: runnability.reason,
    remedy: null,
    requiredBinary: null,
    requiredVersion: null,
    observedVersion: versioned?.observedVersion ?? null,
  };
}

function describeWindow(range: { atLeast: string; below: string | null }): string {
  return range.below === null ? `>= ${range.atLeast}` : `>= ${range.atLeast} and < ${range.below}`;
}

// ─── The write path ─────────────────────────────────────────────────────────

export interface ProbeCapabilitiesArgs {
  /** `'<self>'` for this image; `pool:<name>` for a customer's own runner pool. */
  deploymentKey?: string;
  /** Null for the cloud image, which belongs to no org. A runner pool belongs to one. */
  orgId?: string | null;
  io?: CapabilityIo;
  /*
   * The probes for BOTH halves of the preflight: the tool/engine lookups
   * `checkRunnability` makes and the channel and device-registry lookups the
   * browser capability makes. One object rather than two, because
   * `BrowserCapabilityProbes` extends `RunnabilityProbes` precisely so an
   * injected engine answer cannot differ between the two halves — a deployment
   * reporting chromium present to one probe and absent to the other is a pair of
   * stored rows that contradict each other.
   */
  probes?: BrowserCapabilityProbes;
  /** Bypass the freshness window. The run processor never passes this; an operator can. */
  force?: boolean;
  freshMs?: number;
  /**
   * Where the two requirement tables disagree, injected so both branches can be
   * driven.
   *
   * Defaults to `requirementParity` from the registry's declaration bridge,
   * which compares `TYPE_REQUIREMENTS` (what this probe reads) against
   * `TEST_TYPE_DECLARATIONS` (what the keystone says a type needs) and is empty
   * today. It is consulted HERE, at the moment the rows are written, because a
   * disagreement means the stored capability for that type was computed from one
   * of two tables and the other one says something else — and whichever is wrong
   * is the one the reader is not looking at. A test asserts the list is empty; an
   * operator needs to be told the day it is not.
   */
  parity?: () => Array<{ type: TestType; only: string[] }>;
}

export interface ProbeCapabilitiesResult {
  deploymentKey: string;
  rows: readonly CapabilityRow[];
  /** True when the cache answered and nothing was probed. */
  fromCache: boolean;
  checkedAt: Date | null;
  /** Why the cache was or was not used — logged, so a surprising row is traceable. */
  why: string;
}

/**
 * Probe all nineteen types and write a row each.
 *
 * ── No `$transaction`, on purpose ───────────────────────────────────────────
 *
 * Nineteen independent upserts, each keyed on (deploymentKey, testType). A
 * partial write is not a corrupt state here: every row carries its OWN
 * `checkedAt`, so twelve fresh rows beside seven stale ones is a readable and
 * honest picture, and the reader already has to handle a row that was never
 * written at all. Wrapping them would buy atomicity nothing needs and would put
 * the delegate on a transaction client, which is a different (and easily
 * mis-faked) shape.
 */
export async function probeDeploymentCapabilities(
  args: ProbeCapabilitiesArgs = {},
): Promise<ProbeCapabilitiesResult> {
  const deploymentKey = args.deploymentKey ?? SELF_DEPLOYMENT_KEY;
  const io = args.io ?? defaultCapabilityIo();
  const freshMs = args.freshMs ?? CAPABILITY_FRESH_MS;
  const now = io.now();

  if (!args.force) {
    const cached = await readCapabilityRows(deploymentKey);
    /*
     * The cache answers only when it covers EVERY type and every row is inside
     * the window. A partial cache must re-probe: answering from twelve rows
     * would silently report the other seven as absent from the set, and a
     * reader cannot tell "we have no row" from "there is no such type".
     */
    const complete = cached.length === TEST_TYPES.length;
    const oldest = cached.reduce<Date | null>(
      (acc, row) =>
        row.checkedAt === null ? acc : acc === null || row.checkedAt < acc ? row.checkedAt : acc,
      null,
    );
    const anyUnchecked = cached.some((row) => row.checkedAt === null);
    const fresh =
      complete && !anyUnchecked && oldest !== null && now.getTime() - oldest.getTime() < freshMs;

    if (fresh) {
      return {
        deploymentKey,
        rows: cached.map(toCapabilityRow),
        fromCache: true,
        checkedAt: oldest,
        why: `Every one of the ${TEST_TYPES.length} capability rows was probed within the last ${Math.round(freshMs / 1000)}s, so nothing was re-probed.`,
      };
    }
  }

  const runnability = await checkRunnability(ALL_TEST_TYPES, {
    probes: {
      ...args.probes,
      /*
       * The thin adapter, bridged into the runner's synchronous probe shape.
       * It is resolved up front — once per binary that has a declared window —
       * rather than called from inside `checkRunnability`, because that
       * interface is synchronous by design (it is a `stat` everywhere else).
       */
      binaryVersion: args.probes?.binaryVersion ?? versionLookup(await readVersions(io)),
    },
  });

  const rows = runnability.map(capabilityRowFor);

  for (const row of rows) {
    /*
     * `checkedAt` is written on every row in this pass, including NOT_CHECKED
     * ones — and that is correct rather than contradictory. "We asked about
     * this type at 12:04 and could not establish anything" is a different fact
     * from "nobody has ever asked", and the second is what a MISSING ROW means.
     * The schema's comment says a status other than NOT_CHECKED may not sit
     * beside a null `checkedAt`; this writer never produces that combination in
     * either direction.
     */
    await prisma.deploymentCapability.upsert({
      where: { deploymentKey_testType: { deploymentKey, testType: row.testType } },
      create: {
        deploymentKey,
        orgId: args.orgId ?? null,
        testType: row.testType,
        status: row.status,
        detail: row.detail,
        remedy: row.remedy,
        requiredBinary: row.requiredBinary,
        requiredVersion: row.requiredVersion,
        observedVersion: row.observedVersion,
        checkedAt: now,
      },
      update: {
        status: row.status,
        detail: row.detail,
        remedy: row.remedy,
        requiredBinary: row.requiredBinary,
        requiredVersion: row.requiredVersion,
        observedVersion: row.observedVersion,
        checkedAt: now,
      },
    });
  }

  const counts = rows.filter((row) => !capabilityExecutable(row.status)).length;
  logger.info(
    { deploymentKey, probed: rows.length, nonExecutable: counts },
    'deployment capabilities probed',
  );

  /*
   * The rows above were computed from `TYPE_REQUIREMENTS`. If the declaration
   * says something different for the same type, one of the two is wrong and this
   * deployment now holds a stored verdict derived from the one nobody is reading.
   * Bounded at three names plus a count, the shape `names()` in gates.ts uses: a
   * warning nobody can read is not a warning.
   */
  const disagreements = (args.parity ?? requirementParity)();
  if (disagreements.length > 0) {
    const named = disagreements.slice(0, 3).map((entry) => `${entry.type} (${entry.only.join(', ')})`);
    logger.warn(
      {
        deploymentKey,
        types: disagreements.length,
        disagreements: named,
      },
      'the prober’s requirement table and the type declarations disagree, so these capability rows ' +
        'were written from one of two answers',
    );
  }

  return {
    deploymentKey,
    rows,
    fromCache: false,
    checkedAt: now,
    why: args.force
      ? 'A re-probe was requested explicitly, so the freshness window was not consulted.'
      : `The stored capability rows were missing, incomplete or older than ${Math.round(freshMs / 1000)}s, so all ${TEST_TYPES.length} types were re-probed.`,
  };
}

/**
 * Read every binary that has a DECLARED window, once.
 *
 * Only those: executing a tool to read a version nobody is going to compare
 * against would be spending a process to learn nothing. Today that set is
 * EMPTY, because no entry in `TYPE_REQUIREMENTS` declares a window (see its
 * header for why that is the honest default) — so in the shipped configuration
 * this spawns nothing at all, and the version machinery costs zero processes
 * until somebody establishes a real floor.
 */
async function readVersions(io: CapabilityIo): Promise<Map<string, string | null>> {
  const { TYPE_REQUIREMENTS } = await import('@qaai/runner');
  const wanted = new Set<string>();
  for (const requirements of Object.values(TYPE_REQUIREMENTS)) {
    for (const requirement of requirements) {
      if (requirement.kind === 'BINARY' && requirement.version) wanted.add(requirement.name);
    }
  }
  const out = new Map<string, string | null>();
  for (const binary of wanted) {
    out.set(binary, await io.binaryVersion(binary));
  }
  return out;
}

const versionLookup =
  (versions: Map<string, string | null>) =>
  (binary: string): string | null =>
    versions.get(binary) ?? null;

// ─── The read path: what the coverage denominator asks ──────────────────────

/** One stored row, as the reader sees it. */
export interface StoredCapability extends CapabilityRow {
  /** NULL means NEVER PROBED. The age of the answer is part of the answer. */
  checkedAt: Date | null;
}

/**
 * What a deployment can run, and — the half that matters — what it cannot.
 *
 * `percentOfTypes` is absent on purpose. This is a SET, not a figure; the one
 * place a coverage figure may be produced is the dimension measurement in
 * packages/shared, and a second percentage computed here would be a second
 * denominator.
 */
export interface CapabilitySet {
  deploymentKey: string;
  byType: ReadonlyMap<TestType, StoredCapability>;
  /** Types whose obligations may be scored. Includes NOT_CHECKED — see the header. */
  executable: readonly TestType[];
  /** Types whose obligations leave the denominator, each with its reason. */
  nonExecutable: readonly { testType: TestType; status: CapabilityStatus; reason: string }[];
  /** Probed and inconclusive, or never probed. Reported, and still in the denominator. */
  notChecked: readonly TestType[];
  /** Types with no stored row at all. Nobody has ever asked about these. */
  unprobed: readonly TestType[];
  /** Oldest `checkedAt` across the set, or NULL when nothing has ever been probed. */
  measuredAt: Date | null;
  /** "4 of 19 test types are not executable here", with the reasons. Printable verbatim. */
  sentence: string;
}

async function readCapabilityRows(deploymentKey: string): Promise<StoredCapability[]> {
  const rows = await prisma.deploymentCapability.findMany({
    where: { deploymentKey },
    select: {
      testType: true,
      status: true,
      detail: true,
      remedy: true,
      requiredBinary: true,
      requiredVersion: true,
      observedVersion: true,
      checkedAt: true,
    },
  });
  return rows.map((row) => ({
    testType: row.testType,
    status: row.status,
    detail: row.detail,
    remedy: row.remedy,
    requiredBinary: row.requiredBinary,
    requiredVersion: row.requiredVersion,
    observedVersion: row.observedVersion,
    checkedAt: row.checkedAt,
  }));
}

function toCapabilityRow(row: StoredCapability): CapabilityRow {
  const { checkedAt: _checkedAt, ...rest } = row;
  return rest;
}

/**
 * The door the coverage denominator reads.
 *
 * ── AN EMPTY TABLE IS NOT A HEALTHY DEPLOYMENT ──────────────────────────────
 *
 * The dangerous implementation of this function returns "all nineteen are
 * executable" when nothing has ever been probed, because that is what an empty
 * `nonExecutable` list looks like from the outside. It would be a pass meaning
 * "we did not check", and it would make the headline percentage quietly include
 * every type this image cannot run.
 *
 * So a type with no row is NOT_CHECKED and appears in BOTH `notChecked` and
 * `unprobed`, `measuredAt` is NULL rather than a date, and the sentence says so
 * in words. It still counts toward the denominator — an unprobed type must not
 * be allowed to shed its obligation — but nobody reading this can mistake it
 * for a measurement.
 */
export async function deploymentCapabilities(
  args: { deploymentKey?: string } = {},
): Promise<CapabilitySet> {
  const deploymentKey = args.deploymentKey ?? SELF_DEPLOYMENT_KEY;
  const stored = await readCapabilityRows(deploymentKey);
  const byType = new Map<TestType, StoredCapability>(stored.map((row) => [row.testType, row]));

  const executable: TestType[] = [];
  const nonExecutable: { testType: TestType; status: CapabilityStatus; reason: string }[] = [];
  const notChecked: TestType[] = [];
  const unprobed: TestType[] = [];

  /*
   * Iterating TEST_TYPES rather than the rows is the point. A loop over what the
   * table happens to contain can only report types somebody already wrote a row
   * for, so a half-probed deployment would look complete — and the nineteen in
   * "4 of 19" would be however many rows existed.
   */
  for (const testType of TEST_TYPES) {
    const row = byType.get(testType);
    if (!row) {
      unprobed.push(testType);
      notChecked.push(testType);
      executable.push(testType);
      continue;
    }
    if (!capabilityExecutable(row.status)) {
      nonExecutable.push({ testType, status: row.status, reason: row.detail });
      continue;
    }
    if (row.status === DeploymentCapabilityStatus.NOT_CHECKED) notChecked.push(testType);
    if (row.checkedAt === null) unprobed.push(testType);
    executable.push(testType);
  }

  const measuredAt = stored.reduce<Date | null>(
    (acc, row) =>
      row.checkedAt === null ? acc : acc === null || row.checkedAt < acc ? row.checkedAt : acc,
    null,
  );

  return {
    deploymentKey,
    byType,
    executable,
    nonExecutable,
    notChecked,
    unprobed,
    measuredAt,
    sentence: capabilitySentence({
      nonExecutable,
      notChecked,
      unprobed,
      measuredAt,
    }),
  };
}

/**
 * The sentence a report prints verbatim.
 *
 * Three facts, never folded into one: how many types cannot execute here, how
 * many are unresolved, and when (or whether) any of it was measured. A reader
 * given only the first would read silence on the other two as "everything else
 * is fine".
 */
export function capabilitySentence(args: {
  nonExecutable: readonly { testType: TestType; status: CapabilityStatus; reason: string }[];
  notChecked: readonly TestType[];
  unprobed: readonly TestType[];
  measuredAt: Date | null;
}): string {
  const total = TEST_TYPES.length;

  if (args.measuredAt === null) {
    return (
      `None of the ${total} test types has been probed on this deployment, so which of them it ` +
      'can execute is NOT MEASURED. Every type stays in the coverage denominator: an unprobed ' +
      'type must not be able to shed an obligation it never proved it could run.'
    );
  }

  const head =
    args.nonExecutable.length === 0
      ? `All ${total} test types are executable on this deployment.`
      : `${args.nonExecutable.length} of ${total} test types are not executable here: ` +
        `${args.nonExecutable.map((n) => `${n.testType} (${n.status})`).join(', ')}. ` +
        'Their obligations leave the coverage denominator with this reason — they are not ' +
        'counted as covered, and they are not silently dropped.';

  const unresolved =
    args.notChecked.length === 0
      ? ''
      : ` ${args.notChecked.length} type(s) could not be established either way` +
        `${args.unprobed.length > 0 ? ` (${args.unprobed.length} of them never probed at all)` : ''}` +
        ': NOT_CHECKED is not a verdict about this image, and those stay IN the denominator.';

  return `${head}${unresolved} Measured at ${args.measuredAt.toISOString()}.`;
}

/**
 * The capability set, in the shape the coverage denominator consumes.
 *
 * `coverageMatrix` in packages/agent/src/coverage-matrix.ts takes a
 * `DeploymentCapabilityFact[]` — `{ testType, status, detail }` — and runs every
 * obligation through `capabilityCounts`. This produces exactly that, so the
 * seam is one call rather than a mapping each caller writes for itself. The
 * return type is declared structurally and NOT imported from @qaai/agent: the
 * worker already depends on that package, but a type-only import for three
 * fields would couple the write path to the matrix's module graph for nothing.
 *
 * ── Every type appears, including the ones that could not be probed ─────────
 *
 * All nineteen are emitted, not just the rows that exist. A type omitted here
 * is NOT_CHECKED to the matrix by its own documented default, which is the same
 * answer — but emitting it explicitly means the two modules cannot disagree
 * about how many types there are, and the `detail` travels with it so the
 * report can say WHY a type was excluded rather than just that it was.
 */
export function capabilityFacts(
  set: CapabilitySet,
): readonly { testType: TestType; status: CapabilityStatus; detail: string }[] {
  return TEST_TYPES.map((testType) => {
    const row = set.byType.get(testType);
    return {
      testType,
      status: row?.status ?? DeploymentCapabilityStatus.NOT_CHECKED,
      detail:
        row?.detail ??
        'No capability probe has ever run for this type on this deployment, so whether it can be executed here is not measured. It stays in the coverage denominator.',
    };
  });
}

// ─── The browser capability: the second thing nothing collected ─────────────

/**
 * ── WHY THIS IS A SECOND TABLE AND NOT A COLUMN ─────────────────────────────
 *
 * `DeploymentCapability` answers "can this image run a VISUAL test at all".
 * This answers "can it run that test in Chrome Beta, on an iPhone 14, pinned to
 * a released Safari version" — the axes of `resolveMatrixCell`, which is a
 * different grain and a different vocabulary. Nothing collected it: every
 * `resolveMatrixCell` call in the product resolved against an empty
 * `DeploymentBrowsers`, so NOT_CHECKED was not merely the usual answer — it was
 * the only answer six statuses could ever produce.
 *
 * ── A ROW EXISTS ONLY WHEN THE PROBE ANSWERED ───────────────────────────────
 *
 * The opposite arrangement from the type rows above, and deliberately so. There,
 * all nineteen types get a row every pass, NOT_CHECKED included, because the
 * denominator must always be complete. Here the missing row IS the NOT_CHECKED:
 * `DeploymentBrowsers` documents "EVERY FIELD IS OPTIONAL AND ABSENT MEANS NOT
 * PROBED", and most of the 27 axis members are genuinely unanswerable on a given
 * host — Playwright resolves a browser channel by absolute per-platform paths, so
 * a PATH miss is not evidence of absence. Writing `installed = false` for those
 * would REFUSE a cell on a machine that has the browser.
 *
 * ── AND A READING THAT STOPPED BEING ANSWERABLE IS DELETED ──────────────────
 *
 * Not left to rot. A retained `installed = true` for a browser that has since
 * been removed from the image is exactly the stale AVAILABLE this whole file
 * argues against, and here it would survive indefinitely because the probe that
 * used to answer no longer writes anything. So an unanswered member's row is
 * removed in the same pass, which turns it back into the honest NOT_CHECKED.
 *
 * ── NO FRESHNESS CACHE, ON PURPOSE ──────────────────────────────────────────
 *
 * The type probe has one because it may spawn a `--version` per binary. This
 * probe is an `existsSync` per engine, a `stat` per PATH entry per channel, and
 * one property lookup per device preset in a module that is already imported —
 * cheaper than the cache check it would be skipping. A cache is this feature's
 * documented failure mode, so the half that does not need one does not get one.
 */

/** How many rows one deployment's capability read will look at. */
export const BROWSER_CAPABILITY_ROW_BUDGET = 256;

/** The vocabulary each axis's `name` must belong to, on the way in and out. */
const AXIS_VOCABULARY: Record<BrowserCapabilityAxis, readonly string[]> = {
  ENGINE: BROWSER_ENGINE_LIST,
  CHANNEL: BROWSER_CHANNEL_LIST,
  DEVICE_PRESET: DEVICE_PRESET_LIST,
};

export interface BrowserProbeResult {
  deploymentKey: string;
  /** The answered readings, each of which was written. */
  written: readonly BrowserCapabilityReading[];
  /** Readings that came back `null`: no row, and any previous row removed. */
  notProbed: readonly BrowserCapabilityReading[];
  /** How many stale rows were removed because nothing can answer for them now. */
  cleared: number;
  checkedAt: Date;
  why: string;
}

/**
 * Probe the browser axes and write a row per ANSWERED member.
 *
 * No `$transaction`, for the same reason the type rows have none: every row
 * carries its own `checkedAt`, a partial write is a readable picture rather than
 * a corrupt one, and wrapping them would put the delegate on a transaction
 * client — a different and easily mis-faked shape.
 */
export async function probeDeploymentBrowserCapability(
  args: ProbeCapabilitiesArgs = {},
): Promise<BrowserProbeResult> {
  const deploymentKey = args.deploymentKey ?? SELF_DEPLOYMENT_KEY;
  const io = args.io ?? defaultCapabilityIo();
  const checkedAt = io.now();

  const probe = await probeDeploymentBrowsers(args.probes ?? {});

  for (const reading of probe.readings) {
    // `null` is not a reading. It is the absence of one, and the absence of a
    // row is how this table says so.
    if (reading.installed === null) continue;
    await prisma.deploymentBrowserCapability.upsert({
      where: {
        deploymentKey_axis_name: { deploymentKey, axis: reading.axis, name: reading.name },
      },
      create: {
        deploymentKey,
        orgId: args.orgId ?? null,
        axis: reading.axis,
        name: reading.name,
        installed: reading.installed,
        detail: reading.detail,
        checkedAt,
      },
      update: {
        installed: reading.installed,
        detail: reading.detail,
        checkedAt,
      },
    });
  }

  let cleared = 0;
  if (probe.notProbed.length > 0) {
    /*
     * The anti-staleness half. Scoped to this deployment key and to the exact
     * (axis, name) pairs this pass could not answer for — never a blanket
     * delete, which would wipe a reading another build of this image legitimately
     * took.
     */
    const removed = await prisma.deploymentBrowserCapability.deleteMany({
      where: {
        deploymentKey,
        OR: probe.notProbed.map((reading) => ({ axis: reading.axis, name: reading.name })),
      },
    });
    cleared = removed.count;
  }

  const written = probe.readings.filter((reading) => reading.installed !== null);
  logger.info(
    { deploymentKey, written: written.length, notProbed: probe.notProbed.length, cleared },
    'deployment browser capability probed',
  );

  return {
    deploymentKey,
    written,
    notProbed: probe.notProbed,
    cleared,
    checkedAt,
    why: probe.why,
  };
}

/** A stored reading that no vocabulary in this build can interpret. */
export interface RejectedBrowserRow {
  axis: string;
  name: string;
  why: string;
}

export interface BrowserCapabilitySet {
  deploymentKey: string;
  /** Exactly what was stored, in the shape `resolveMatrixCell` consumes. */
  browsers: DeploymentBrowsers;
  /** The probe's own cells, resolved against it. */
  cells: readonly MatrixCellResolution[];
  summary: BrowserMatrixSummary;
  /** Oldest `checkedAt` across the rows, or NULL when nothing has been probed. */
  measuredAt: Date | null;
  /** Rows this build cannot interpret. Reported, never silently skipped. */
  rejected: readonly RejectedBrowserRow[];
  /** True when the row budget bit, so the capability below is INCOMPLETE. */
  truncated: boolean;
  /** Printable verbatim. */
  sentence: string;
}

/**
 * The door `resolveMatrixCell` is fed from.
 *
 * ── AN EMPTY TABLE IS NOT A DEPLOYMENT WITH NO BROWSERS ─────────────────────
 *
 * Same trap as `deploymentCapabilities` above, with the opposite sign. There the
 * dangerous implementation reports everything executable; here it would be
 * reporting every engine ABSENT, which refuses the whole matrix on a healthy
 * image. Neither happens, because the maps are built only from rows that exist:
 * no row means the key is absent, an absent key means NOT_CHECKED, and
 * NOT_CHECKED refuses nothing and claims nothing.
 *
 * ── A ROW THIS BUILD CANNOT READ IS REJECTED, NOT COERCED ───────────────────
 *
 * `axis` is TEXT and `name` is TEXT (see the model's note on why), so a row
 * written by a newer build — or by a renamed device preset — can hold a name no
 * vocabulary here contains. Such a row is REPORTED in `rejected` and left out of
 * the capability. Coercing it would put a reading under a key that means
 * something else; dropping it silently would make a capability look complete
 * while a member of it was quietly unprobed.
 */
export async function deploymentBrowserCapabilities(
  args: { deploymentKey?: string } = {},
): Promise<BrowserCapabilitySet> {
  const deploymentKey = args.deploymentKey ?? SELF_DEPLOYMENT_KEY;

  /*
   * `take` one over the budget so the truncation is DETECTABLE. The real
   * vocabulary is 27 members, so this bites only if something has written rows
   * under names this build does not know — and a capability silently assembled
   * from the first 256 of 9,000 rows would be a measurement of whatever sorted
   * first.
   */
  const rows = await prisma.deploymentBrowserCapability.findMany({
    where: { deploymentKey },
    select: { axis: true, name: true, installed: true, detail: true, checkedAt: true },
    orderBy: [{ axis: 'asc' }, { name: 'asc' }],
    take: BROWSER_CAPABILITY_ROW_BUDGET + 1,
  });
  const truncated = rows.length > BROWSER_CAPABILITY_ROW_BUDGET;
  const considered = truncated ? rows.slice(0, BROWSER_CAPABILITY_ROW_BUDGET) : rows;

  const engines: Record<string, boolean> = {};
  const channels: Record<string, boolean> = {};
  const devicePresets: Record<string, boolean> = {};
  const rejected: RejectedBrowserRow[] = [];
  let measuredAt: Date | null = null;

  for (const row of considered) {
    if (!isBrowserCapabilityAxis(row.axis)) {
      rejected.push({
        axis: row.axis,
        name: row.name,
        why: 'the axis is not one this build knows about (ENGINE, CHANNEL, DEVICE_PRESET)',
      });
      continue;
    }
    if (!AXIS_VOCABULARY[row.axis].includes(row.name)) {
      rejected.push({
        axis: row.axis,
        name: row.name,
        why: `no ${row.axis} by that name exists in this build's browser vocabulary`,
      });
      continue;
    }
    const target =
      row.axis === 'ENGINE' ? engines : row.axis === 'CHANNEL' ? channels : devicePresets;
    target[row.name] = row.installed;
    if (measuredAt === null || row.checkedAt < measuredAt) measuredAt = row.checkedAt;
  }

  const browsers: DeploymentBrowsers = {
    engines,
    channels,
    devicePresets,
    /*
     * `versions` is deliberately absent rather than `{}`: no browser version is
     * read anywhere in this product (reading one means launching a browser — see
     * `probeDeploymentBrowsers`), so a cell that PINS a version must resolve
     * NOT_CHECKED. An empty map and an absent one resolve identically here, and
     * the absent one is the one that cannot be mistaken for a reading.
     */
  };

  const cells = resolveDeploymentCells(browsers);
  const summary = summariseBrowserMatrix(cells);

  const head =
    measuredAt === null
      ? 'No engine, channel or device preset has been probed on this deployment, so every ' +
        'browser-matrix cell resolves NOT_CHECKED. That is not a verdict about this image in ' +
        'either direction, and those cells stay IN the denominator.'
      : `${summary.sentence} Measured at ${measuredAt.toISOString()}.`;
  const caveats = [
    rejected.length > 0
      ? ` ${rejected.length} stored reading(s) were REJECTED rather than interpreted: ` +
        `${rejected
          .slice(0, 3)
          .map((entry) => `${entry.axis}/${entry.name}`)
          .join(', ')}. Those axis members read as NOT PROBED.`
      : '',
    truncated
      ? ` The ${BROWSER_CAPABILITY_ROW_BUDGET}-row read budget bit, so this capability is ` +
        'INCOMPLETE and the members it did not reach read as NOT PROBED rather than as absent.'
      : '',
  ].join('');

  return {
    deploymentKey,
    browsers,
    cells,
    summary,
    measuredAt,
    rejected,
    truncated,
    sentence: `${head}${caveats}`,
  };
}

// ─── The declaration bridge: the eleven types the prober could not see ──────

/**
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * `TYPE_REQUIREMENTS` in packages/runner/src/preflight.ts is a `Record` over the
 * nineteen MINTED types, so `checkRunnability` — the call above, the one that
 * writes every stored row — cannot be ASKED about CHAOS, DOCUMENT, PWA, PUSH,
 * EMAIL or the six other pending types. Each of those shipped a registered
 * plugin, and the prober could not see any of them: not "unknown", not
 * "pending", the call did not typecheck. The registry's declaration bridge
 * (`declaredRunnability`, `declaredRequirements`, `CHANNEL_REQUIREMENTS_DEMOTED`)
 * answers for all thirty by reading the keystone's declarations instead, and
 * before this function existed every one of those exports was called from a test
 * file and nowhere else — correct, tested, and reached by nothing in production,
 * which is this codebase's signature defect.
 *
 * ── WHY NOTHING HERE IS STORED ──────────────────────────────────────────────
 *
 * `DeploymentCapability.testType` is the Prisma `TestType` enum, which holds the
 * nineteen. A pending type has no value to be stored under, by design — minting
 * one is a four-edit change in files this slice does not own, and the three
 * guards that make a half-mint unshippable are the reason the eleven are pending
 * rather than broken. So this is a REPORT, not a write: the runnability of a
 * pending type is logged with the rest of the preflight and travels to an
 * operator in the capability sentence. It deliberately does NOT enter a
 * denominator — these types are not in `TEST_TYPES`, so no obligation anywhere
 * is counted against them, and inventing a row for one would be the first step
 * toward counting a test nobody can create.
 *
 * ── AND THE MINTED NINETEEN ARE NOT ASKED TWICE ─────────────────────────────
 *
 * Only the not-minted names go through here. The nineteen are answered by
 * `checkRunnability` above, and `requirementParity` is the guard that the two
 * tables agree about them; asking both would be two answers to one question, and
 * the day they differed this file would hold both.
 */
export interface DeclaredTypeReadiness {
  /** A pending or unregistered type NAME. Never a minted `TestType`. */
  type: string;
  runnable: boolean | null;
  reason: string;
}

export interface DeclaredRunnabilitySet {
  /** Types with a declaration, probed against this image. */
  answered: readonly DeclaredTypeReadiness[];
  /** Types with a registered plugin and NO declaration, with the reason. */
  refused: readonly { type: string; why: string }[];
  /**
   * Declared CHANNEL requirements the prober cannot see, per type.
   *
   * The disclosure half of `asProbeRequirement`'s demotion: the prober asks
   * Playwright which ENGINES are installed, so a declared "needs Chrome Beta" is
   * demoted to UNPROBED rather than refused. Surfaced HERE, beside the browser
   * capability above, because that capability is the thing that DOES answer for
   * a channel — the two halves of one question, which were in two files with no
   * caller in common.
   */
  demotedChannels: readonly { type: string; channels: readonly string[] }[];
  sentence: string;
}

export async function declaredTypeRunnability(
  args: { probes?: RunnabilityProbes } = {},
): Promise<DeclaredRunnabilitySet> {
  /*
   * Every type name that is NOT minted: the eleven pending ones plus any plugin
   * whose type string no declaration describes at all (`'EMAIL'` is exactly that
   * today). Deduplicated, and filtered through `isTestType` so a name that gets
   * minted later leaves this list the moment it does, rather than being answered
   * twice.
   */
  const asked = [...new Set([...PENDING_TEST_TYPES, ...undeclaredPluginTypes()])].filter(
    (type) => !isTestType(type),
  );

  const report = await declaredRunnability(asked, { probes: args.probes });
  const answered: DeclaredTypeReadiness[] = report.map((entry) => ({
    // `entry.type` is typed `TestType` by a cast the registry documents as
    // narrow and load-bearing; for these names it holds a pending string. It is
    // read here as the string it is, and never written to a typed column.
    type: entry.type,
    runnable: entry.runnable,
    reason: entry.reason,
  }));

  /*
   * What `declaredRunnability` DROPPED. It answers only for names with a
   * declaration and returns the rest silently, so the difference is computed
   * here rather than inferred — a type that vanishes between the question and
   * the answer is the kind of gap that reads as "fine".
   */
  const answeredNames = new Set(answered.map((entry) => entry.type));
  const refused = asked
    .filter((type) => !answeredNames.has(type))
    .map((type) => ({ type, why: declaredRequirements(type).why }));

  const demotedChannels = CHANNEL_REQUIREMENTS_DEMOTED();

  const runnable = answered.filter((entry) => entry.runnable === true).length;
  const blocked = answered.filter((entry) => entry.runnable === false).length;
  const unresolved = answered.filter((entry) => entry.runnable === null).length;

  const parts = [
    `${answered.length} declared-but-unminted test type(s) were probed on this deployment: ` +
      `${runnable} runnable, ${blocked} blocked, ${unresolved} not established either way. ` +
      'No row is stored for any of them — the Prisma `TestType` enum does not hold a pending ' +
      'type — and none of them is in a coverage denominator, so nothing is counted against a ' +
      'test nobody can create yet.',
  ];
  if (refused.length > 0) {
    parts.push(
      `${refused.length} registered plugin type(s) could not be probed at all: ` +
        `${refused
          .slice(0, 3)
          .map((entry) => entry.type)
          .join(', ')}. What they need is UNKNOWN rather than nothing.`,
    );
  }
  if (demotedChannels.length > 0) {
    parts.push(
      `${demotedChannels.length} type(s) declare a browser CHANNEL this prober cannot see ` +
        `(${demotedChannels
          .slice(0, 3)
          .map((entry) => `${entry.type}: ${entry.channels.join(', ')}`)
          .join('; ')}): it asks Playwright which ENGINES are installed. The browser capability ` +
        'above is what answers for a channel.',
    );
  }

  return { answered, refused, demotedChannels, sentence: parts.join(' ') };
}

// ─── The one call the job makes ─────────────────────────────────────────────

/**
 * Probe if stale, probe the browsers, then read both sets back.
 *
 * Exists so the ordering cannot be got wrong at the call site. Reading before
 * probing on a cold deployment returns the honest-but-useless "nothing has been
 * probed" set, and the run that triggered it would then count obligations it
 * could have excluded.
 *
 * ── THE SENTENCE IS COMPOSED HERE, AND THAT IS NOT COSMETIC ─────────────────
 *
 * `capabilities.sentence` comes back carrying all three facts — the test types,
 * the browser matrix, the declared-but-unminted types — because this function's
 * one production caller (the `PREFLIGHT_QUEUE` registration in
 * apps/worker/src/index.ts) logs exactly one string, and a fact returned in a
 * field nobody prints is a fact nobody has. `deploymentCapabilities` and
 * `deploymentBrowserCapabilities` each keep their own single-purpose sentence
 * for callers that want one of the two.
 *
 * ── THE BROWSER HALF MAY NOT TAKE THE TYPE HALF DOWN ────────────────────────
 *
 * Its table arrives in a migration this round WRITES and does not APPLY, so a
 * worker running this build against a database where `prisma migrate deploy` has
 * not run yet will throw on the first upsert. Losing the nineteen type rows over
 * that would be a far worse outcome than not having the browser capability, so
 * the failure is caught, reported as NOT MEASURED — never as a verdict about the
 * image — and the error goes to the log and NOT into the sentence, which is
 * rendered into reports.
 */
export async function ensureDeploymentCapabilities(args: ProbeCapabilitiesArgs = {}): Promise<{
  probe: ProbeCapabilitiesResult;
  capabilities: CapabilitySet;
  browsers: BrowserCapabilitySet | null;
  declared: DeclaredRunnabilitySet;
}> {
  const probe = await probeDeploymentCapabilities(args);
  const capabilities = await deploymentCapabilities({ deploymentKey: probe.deploymentKey });

  let browsers: BrowserCapabilitySet | null = null;
  let browserSentence =
    'The browser-matrix capability was NOT MEASURED on this deployment: its store could not be ' +
    'reached. Every matrix cell therefore resolves NOT_CHECKED, which is not a verdict about this ' +
    'image in either direction.';
  try {
    await probeDeploymentBrowserCapability(args);
    browsers = await deploymentBrowserCapabilities({ deploymentKey: probe.deploymentKey });
    browserSentence = browsers.sentence;
  } catch (err) {
    // The error class and message go to the operator's log. They do not go into
    // the sentence: that string is rendered into coverage reports and PR
    // comments, and a database error text is neither a fact about the image nor
    // something this file controls the contents of.
    logger.error(
      { err, deploymentKey: probe.deploymentKey },
      'the browser-matrix capability could not be probed or read; the test-type capability rows ' +
        'were written and are unaffected',
    );
  }

  const declared = await declaredTypeRunnability({
    ...(args.probes === undefined ? {} : { probes: args.probes }),
  });

  return {
    probe,
    capabilities: {
      ...capabilities,
      sentence: [capabilities.sentence, browserSentence, declared.sentence].join(' '),
    },
    browsers,
    declared,
  };
}
