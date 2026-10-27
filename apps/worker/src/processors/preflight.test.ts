/**
 * Tests for the deployment-capability preflight.
 *
 * Written around the ways this feature becomes the thing it was built to
 * prevent, because every one of them is a number that flatters us:
 *
 *   • AN EMPTY TABLE READ AS A HEALTHY DEPLOYMENT. The dangerous
 *     implementation returns "all nineteen are executable" when nothing has
 *     ever been probed — a pass meaning "we did not check", and the one that
 *     would silently put every unrunnable type back into the denominator.
 *   • NOT_CHECKED COLLAPSING INTO MISSING, or into AVAILABLE. The first is a
 *     claim about an image nobody looked at; the second lets a cached tick
 *     stand in for a binary that has since vanished.
 *   • NOT_CHECKED LEAVING THE DENOMINATOR. If an unprobed type shed its
 *     obligation, the percentage would RISE for a preflight nobody ran.
 *   • A STALE CACHE VOUCHING FOR A REBUILT IMAGE. Someone rebuilds the
 *     container without k6 and the stored row keeps saying AVAILABLE.
 *   • "MISSING" ABOUT AN INSTALLED BINARY, which sends a reader to install
 *     something they already have instead of upgrading it.
 *
 * The Prisma fake HONOURS `select`. That is not politeness: a select-blind fake
 * makes deleting a field from a query undetectable, and two defects have
 * already survived a whole slice behind one in this repository.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probeDeploymentBrowsers } from '@qaai/runner';
import { TEST_TYPES } from '@qaai/shared';
import type { TestType } from '@qaai/shared';
import { DeploymentCapabilityStatus } from '../../../api/src/generated/prisma/enums.js';

// The worker's context opens Postgres, Redis and the LLM at import time, so it
// is replaced wholesale; `h.prisma` and `h.log` are read per test.
const h = vi.hoisted(
  (): {
    prisma: Record<string, unknown>;
    log: Array<{ level: string; msg: string; obj: unknown }>;
  } => ({ prisma: {}, log: [] }),
);

vi.mock('../context.js', () => {
  const record =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      h.log.push({ level, msg: msg ?? '', obj });
    };
  return {
    config: {},
    connection: {},
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
  };
});

const {
  BROWSER_CAPABILITY_ROW_BUDGET,
  CAPABILITY_FRESH_MS,
  CAPABILITY_STATUS_KINDS,
  capabilityFacts,
  declaredTypeRunnability,
  deploymentBrowserCapabilities,
  probeDeploymentBrowserCapability,
  SELF_DEPLOYMENT_KEY,
  capabilityExecutable,
  capabilityRowFor,
  capabilitySentence,
  defaultCapabilityIo,
  deploymentCapabilities,
  ensureDeploymentCapabilities,
  probeDeploymentCapabilities,
} = await import('./preflight.js');

// ─────────────────────────────────────────────────────────────────────────────
// A Prisma fake that honours `select`.
// ─────────────────────────────────────────────────────────────────────────────

interface StoredRow {
  deploymentKey: string;
  testType: TestType;
  status: DeploymentCapabilityStatus;
  detail: string;
  remedy: string | null;
  requiredBinary: string | null;
  requiredVersion: string | null;
  observedVersion: string | null;
  checkedAt: Date | null;
  orgId: string | null;
}

function row(over: Partial<StoredRow> = {}): StoredRow {
  return {
    deploymentKey: SELF_DEPLOYMENT_KEY,
    testType: 'E2E',
    status: DeploymentCapabilityStatus.AVAILABLE,
    detail: 'E2E can run here.',
    remedy: null,
    requiredBinary: null,
    requiredVersion: null,
    observedVersion: null,
    checkedAt: new Date('2026-10-26T12:00:00.000Z'),
    orgId: null,
    ...over,
  };
}

/**
 * The store, with a `findMany` that returns ONLY the selected fields.
 *
 * A fake that ignored `select` would let somebody delete `checkedAt: true` from
 * the reader's query and every test here would still pass — while production
 * silently lost the one field that makes a cached AVAILABLE detectable as
 * stale. So the projection is real, and `selects` records what was asked for.
 */
function store(initial: StoredRow[] = []) {
  const rows = [...initial];
  const selects: Array<Record<string, boolean>> = [];
  const upserts: Array<{
    where: unknown;
    create: Partial<StoredRow>;
    update: Partial<StoredRow>;
  }> = [];

  return {
    rows,
    selects,
    upserts,
    delegate: {
      findMany: async (args: {
        where?: { deploymentKey?: string };
        select?: Record<string, boolean>;
      }) => {
        if (args.select) selects.push(args.select);
        const matched = rows.filter(
          (r) => !args.where?.deploymentKey || r.deploymentKey === args.where.deploymentKey,
        );
        if (!args.select) return matched.map((r) => ({ ...r }));
        return matched.map((r) => {
          const projected: Record<string, unknown> = {};
          for (const [field, wanted] of Object.entries(args.select!)) {
            if (wanted) projected[field] = (r as unknown as Record<string, unknown>)[field];
          }
          return projected;
        });
      },
      upsert: async (args: {
        where: { deploymentKey_testType: { deploymentKey: string; testType: TestType } };
        create: Partial<StoredRow>;
        update: Partial<StoredRow>;
      }) => {
        upserts.push(args);
        const key = args.where.deploymentKey_testType;
        const existing = rows.find(
          (r) => r.deploymentKey === key.deploymentKey && r.testType === key.testType,
        );
        if (existing) Object.assign(existing, args.update);
        else rows.push(row(args.create));
        return existing ?? rows[rows.length - 1]!;
      },
    },
  };
}

/** Everything present, as a healthy image would answer. */
const everything = { onPath: () => true, browserInstalled: () => true, platform: 'linux' };
const NOW = new Date('2026-10-26T12:00:00.000Z');
const io = { now: () => NOW, binaryVersion: async () => null };

beforeEach(() => {
  h.log.length = 0;
  h.prisma = {};
});

// ─────────────────────────────────────────────────────────────────────────────
// The vocabulary, pinned to the column's actual domain.
// ─────────────────────────────────────────────────────────────────────────────

describe('the capability status vocabulary', () => {
  it('classifies every status the database can hold, and no others', () => {
    /*
     * The run-time half of the pattern this codebase enforces for a vocabulary
     * with a write path. The compiler-enforced half is the
     * `Record<CapabilityStatus, boolean>` in the module itself, which fails to
     * build if the Prisma enum grows a member nobody classified; this catches
     * the reverse — a member classified here that the column cannot store.
     *
     * Both halves are needed. Eight GateRule kinds shipped unsaveable for two
     * slices because only one of them existed.
     */
    const fromDatabase = Object.keys(DeploymentCapabilityStatus).sort();
    expect(fromDatabase).toEqual(['AVAILABLE', 'MISSING', 'NOT_CHECKED', 'WRONG_VERSION']);
    for (const status of fromDatabase) {
      expect(typeof capabilityExecutable(status as DeploymentCapabilityStatus)).toBe('boolean');
    }
  });

  it('takes exactly MISSING and WRONG_VERSION out of the denominator', () => {
    const excluded = Object.keys(DeploymentCapabilityStatus)
      .filter((s) => !capabilityExecutable(s as DeploymentCapabilityStatus))
      .sort();
    // Mirrors NON_EXECUTABLE_CAPABILITY_STATUSES in @qaai/shared's
    // coverage-dimensions.ts, which this file cannot import (see its header).
    expect(excluded).toEqual(['MISSING', 'WRONG_VERSION']);
  });

  it('keeps NOT_CHECKED in the denominator, which is the whole argument', () => {
    /*
     * If this flipped, a deployment that never ran a preflight would shed every
     * obligation it could not prove it could run, and the coverage percentage
     * would rise for a preflight nobody executed.
     */
    expect(capabilityExecutable(DeploymentCapabilityStatus.NOT_CHECKED)).toBe(true);
    expect(capabilityExecutable(DeploymentCapabilityStatus.AVAILABLE)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mapping a runnability verdict onto a stored status.
// ─────────────────────────────────────────────────────────────────────────────

describe('turning a runnability verdict into a stored status', () => {
  const k6 = {
    kind: 'BINARY' as const,
    scope: 'TYPE' as const,
    name: 'k6',
    install: 'brew install k6',
  };

  it('calls an absent binary MISSING and carries the install line', () => {
    const mapped = capabilityRowFor({
      type: 'LOAD',
      runnable: false,
      missing: [k6],
      wrongVersion: [],
      degraded: [],
      requirements: [],
      reason: 'This deployment cannot execute LOAD tests: it is missing `k6`.',
    });
    expect(mapped.status).toBe('MISSING');
    expect(mapped.remedy).toBe('brew install k6');
    expect(mapped.requiredBinary).toBe('k6');
    // Absent, so no version was read off it. A version here would be a reading
    // taken from a binary that is not there.
    expect(mapped.observedVersion).toBeNull();
  });

  it('calls an out-of-range binary WRONG_VERSION, never MISSING', () => {
    const ranged = {
      ...k6,
      version: { atLeast: '0.40.0', below: null, why: 'needs --summary-export' },
    };
    const mapped = capabilityRowFor({
      type: 'LOAD',
      runnable: false,
      missing: [],
      wrongVersion: [ranged],
      degraded: [],
      requirements: [
        {
          requirement: ranged,
          satisfied: false,
          unmet: 'VERSION',
          observedVersion: 'k6 v0.30.0',
          detail: 'too old',
        },
      ],
      reason: 'This deployment cannot execute LOAD tests: it HAS `k6` …',
    });
    /*
     * The distinction that makes the row actionable. "MISSING" about an
     * installed binary sends a reader to install something they already have.
     */
    expect(mapped.status).toBe('WRONG_VERSION');
    expect(mapped.observedVersion).toBe('k6 v0.30.0');
    expect(mapped.requiredVersion).toBe('>= 0.40.0');
  });

  it('calls a type with nothing establishable NOT_CHECKED, never MISSING', () => {
    const mapped = capabilityRowFor({
      type: 'MOBILE',
      runnable: null,
      missing: [],
      wrongVersion: [],
      degraded: [],
      requirements: [],
      reason: 'Whether MOBILE tests can run here depends on each test’s own spec.',
    });
    expect(mapped.status).toBe('NOT_CHECKED');
    expect(mapped.remedy).toBeNull();
  });

  it('calls a type with no plugin MISSING, with no remedy, rather than AVAILABLE', () => {
    /*
     * `runnable: false` with both buckets empty is the pluginless case. Falling
     * through to AVAILABLE here would report a type with no implementation as
     * executable, which is the worst single mistake available in that function.
     */
    const mapped = capabilityRowFor({
      type: 'PROTOCOL',
      runnable: false,
      missing: [],
      wrongVersion: [],
      degraded: [],
      requirements: [],
      reason: 'No plugin is registered for PROTOCOL.',
    });
    expect(mapped.status).toBe('MISSING');
    expect(mapped.remedy).toBeNull();
  });

  it('calls a satisfied type AVAILABLE', () => {
    const mapped = capabilityRowFor({
      type: 'API',
      runnable: true,
      missing: [],
      wrongVersion: [],
      degraded: [],
      requirements: [],
      reason: 'API needs nothing beyond the environment under test.',
    });
    expect(mapped.status).toBe('AVAILABLE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The write path.
// ─────────────────────────────────────────────────────────────────────────────

describe('probing and writing the capability rows', () => {
  it('writes one row per test type, all nineteen of them', async () => {
    const db = store();
    h.prisma = { deploymentCapability: db.delegate };

    const result = await probeDeploymentCapabilities({ io, probes: everything });

    expect(result.rows).toHaveLength(TEST_TYPES.length);
    expect(db.upserts).toHaveLength(TEST_TYPES.length);
    // The denominator's ceiling comes from the one list, not from however many
    // rows happened to be written.
    expect(new Set(db.upserts.map((u) => u.create.testType))).toEqual(
      new Set(TEST_TYPES),
    );
  });

  it('stamps every row it writes with the time the probe was taken', async () => {
    const db = store();
    h.prisma = { deploymentCapability: db.delegate };

    await probeDeploymentCapabilities({ io, probes: everything });

    /*
     * The age of the answer is part of the answer. A row with no `checkedAt` is
     * indistinguishable from one nobody has ever probed, and the cache below
     * relies on this field to notice a rebuilt image.
     */
    for (const upsert of db.upserts) {
      expect(upsert.create.checkedAt).toEqual(NOW);
      expect(upsert.update.checkedAt).toEqual(NOW);
    }
  });

  it('keys the upsert on (deploymentKey, testType) so a re-probe is idempotent', async () => {
    const db = store();
    h.prisma = { deploymentCapability: db.delegate };

    await probeDeploymentCapabilities({ io, probes: everything });
    await probeDeploymentCapabilities({ io, probes: everything, force: true });

    // Two passes, nineteen rows — not thirty-eight.
    expect(db.rows.filter((r) => r.deploymentKey === SELF_DEPLOYMENT_KEY)).toHaveLength(
      TEST_TYPES.length,
    );
    expect(db.upserts[0]!.where).toEqual({
      deploymentKey_testType: { deploymentKey: SELF_DEPLOYMENT_KEY, testType: 'E2E' },
    });
  });

  it('records a MISSING row for a type whose binary is not on the image', async () => {
    const db = store();
    h.prisma = { deploymentCapability: db.delegate };

    const result = await probeDeploymentCapabilities({
      io,
      // The real worker image: no k6.
      probes: { ...everything, onPath: (binary: string) => binary !== 'k6' },
    });

    const load = result.rows.find((r) => r.testType === 'LOAD');
    expect(load).toMatchObject({ status: 'MISSING', requiredBinary: 'k6' });
    expect(load!.remedy).toContain('k6');
  });

  it('writes a row per runner pool, not one global answer', async () => {
    /*
     * A customer's on-prem pool genuinely has different binaries from the cloud
     * image, so one global row would report one of them wrongly.
     */
    const db = store();
    h.prisma = { deploymentCapability: db.delegate };

    await probeDeploymentCapabilities({ io, probes: everything });
    await probeDeploymentCapabilities({
      io,
      probes: { ...everything, onPath: () => false },
      deploymentKey: 'pool:acme',
      orgId: 'org_1',
    });

    expect(db.rows.filter((r) => r.deploymentKey === 'pool:acme')).toHaveLength(TEST_TYPES.length);
    expect(db.rows.find((r) => r.deploymentKey === 'pool:acme')!.orgId).toBe('org_1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The cache, and the lie it would otherwise tell.
// ─────────────────────────────────────────────────────────────────────────────

describe('re-probing a deployment whose image may have changed', () => {
  const fullSet = (over: Partial<StoredRow> = {}): StoredRow[] =>
    TEST_TYPES.map((testType) => row({ testType, ...over }));

  it('answers from the cache when every row is inside the window', async () => {
    const db = store(fullSet({ checkedAt: new Date(NOW.getTime() - 1_000) }));
    h.prisma = { deploymentCapability: db.delegate };

    const result = await probeDeploymentCapabilities({ io, probes: everything });

    expect(result.fromCache).toBe(true);
    // Nothing was re-probed, so nothing was written.
    expect(db.upserts).toHaveLength(0);
  });

  it('re-probes once the oldest row falls outside the window', async () => {
    /*
     * THE LIE THIS WHOLE FEATURE EXISTS TO KILL. Somebody rebuilds the
     * container without k6 and a cached AVAILABLE keeps vouching for it. The
     * probe is kept cheap precisely so this can be repeated.
     */
    const db = store(fullSet({ checkedAt: new Date(NOW.getTime() - CAPABILITY_FRESH_MS - 1) }));
    h.prisma = { deploymentCapability: db.delegate };

    const result = await probeDeploymentCapabilities({ io, probes: everything });

    expect(result.fromCache).toBe(false);
    expect(db.upserts).toHaveLength(TEST_TYPES.length);
    expect(result.why).toContain('re-probed');
  });

  it('re-probes a partially-cached deployment rather than answering from part of it', async () => {
    /*
     * Answering from twelve rows would silently report the other seven as
     * absent from the set, and a reader cannot tell "we have no row" from
     * "there is no such type".
     */
    const db = store(fullSet().slice(0, 12));
    h.prisma = { deploymentCapability: db.delegate };

    const result = await probeDeploymentCapabilities({ io, probes: everything });

    expect(result.fromCache).toBe(false);
    expect(db.upserts).toHaveLength(TEST_TYPES.length);
  });

  it('never treats a row that was never probed as fresh', async () => {
    // A complete set, all inside the window by date — except one row has no
    // date at all, which is "nobody ever asked" and cannot age into freshness.
    const rows = fullSet({ checkedAt: new Date(NOW.getTime() - 1_000) });
    rows[5]!.checkedAt = null;
    const db = store(rows);
    h.prisma = { deploymentCapability: db.delegate };

    const result = await probeDeploymentCapabilities({ io, probes: everything });

    expect(result.fromCache).toBe(false);
  });

  it('re-probes on request without consulting the window', async () => {
    const db = store(fullSet({ checkedAt: new Date(NOW.getTime() - 1_000) }));
    h.prisma = { deploymentCapability: db.delegate };

    const result = await probeDeploymentCapabilities({ io, probes: everything, force: true });

    expect(result.fromCache).toBe(false);
    expect(result.why).toContain('explicitly');
  });

  it('asks the database for `checkedAt`, because the cache cannot work without it', async () => {
    const db = store(fullSet());
    h.prisma = { deploymentCapability: db.delegate };

    await probeDeploymentCapabilities({ io, probes: everything });

    /*
     * The fake honours `select`, so this is a real assertion rather than a
     * restatement: delete `checkedAt: true` from the reader's query and the
     * projected rows lose the field, every freshness decision becomes "never
     * probed", and this test goes red.
     */
    expect(db.selects[0]).toMatchObject({ checkedAt: true, status: true, testType: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The read path: the door the coverage denominator knocks on.
// ─────────────────────────────────────────────────────────────────────────────

describe('what the coverage denominator is told', () => {
  it('refuses to call an unprobed deployment healthy', async () => {
    /*
     * The dangerous implementation returns "all nineteen are executable" here,
     * because that is what an empty `nonExecutable` list looks like from
     * outside. It would be a pass meaning "we did not check".
     */
    const db = store();
    h.prisma = { deploymentCapability: db.delegate };

    const set = await deploymentCapabilities();

    expect(set.measuredAt).toBeNull();
    expect(set.nonExecutable).toEqual([]);
    expect(set.unprobed).toHaveLength(TEST_TYPES.length);
    expect(set.notChecked).toHaveLength(TEST_TYPES.length);
    expect(set.sentence).toContain('NOT MEASURED');
    // And they all still count: an unprobed type must not shed an obligation.
    expect(set.executable).toHaveLength(TEST_TYPES.length);
  });

  it('counts the nineteen from the type list, not from however many rows exist', async () => {
    const db = store([row({ testType: 'LOAD', status: DeploymentCapabilityStatus.MISSING })]);
    h.prisma = { deploymentCapability: db.delegate };

    const set = await deploymentCapabilities();

    /*
     * One row in the table, nineteen types in the world. A loop over the rows
     * would report a half-probed deployment as complete, and the denominator in
     * "1 of 19" would have been 1.
     */
    expect(set.executable.length + set.nonExecutable.length).toBe(TEST_TYPES.length);
    expect(set.sentence).toContain(`of ${TEST_TYPES.length}`);
  });

  it('takes a MISSING type out of the denominator WITH its reason', async () => {
    const db = store(
      TEST_TYPES.map((testType) =>
        testType === 'LOAD'
          ? row({
              testType,
              status: DeploymentCapabilityStatus.MISSING,
              detail: 'This deployment cannot execute LOAD tests: it is missing `k6`.',
            })
          : row({ testType }),
      ),
    );
    h.prisma = { deploymentCapability: db.delegate };

    const set = await deploymentCapabilities();

    expect(set.executable).not.toContain('LOAD');
    expect(set.nonExecutable).toEqual([
      { testType: 'LOAD', status: 'MISSING', reason: expect.stringContaining('k6') },
    ]);
    // Never silently dropped, and never counted as covered: it is named.
    expect(set.sentence).toContain('not executable here');
    expect(set.sentence).toContain('LOAD');
  });

  it('keeps a NOT_CHECKED type in the denominator and still reports it', async () => {
    const db = store(
      TEST_TYPES.map((testType) =>
        row({
          testType,
          status:
            testType === 'MOBILE'
              ? DeploymentCapabilityStatus.NOT_CHECKED
              : DeploymentCapabilityStatus.AVAILABLE,
        }),
      ),
    );
    h.prisma = { deploymentCapability: db.delegate };

    const set = await deploymentCapabilities();

    expect(set.executable).toContain('MOBILE');
    expect(set.notChecked).toEqual(['MOBILE']);
    expect(set.nonExecutable).toEqual([]);
    expect(set.sentence).toContain('could not be established either way');
  });

  it('reports the oldest reading, so freshness cannot be read off the newest row', async () => {
    const old = new Date('2026-10-20T00:00:00.000Z');
    const db = store([
      row({ testType: 'E2E', checkedAt: new Date('2026-10-26T00:00:00.000Z') }),
      row({ testType: 'API', checkedAt: old }),
    ]);
    h.prisma = { deploymentCapability: db.delegate };

    const set = await deploymentCapabilities();

    // "Measured at" has to be the weakest claim in the set, not the strongest.
    expect(set.measuredAt).toEqual(old);
  });

  it('says all nineteen are executable only when they actually are', async () => {
    const db = store(TEST_TYPES.map((testType) => row({ testType })));
    h.prisma = { deploymentCapability: db.delegate };

    const set = await deploymentCapabilities();

    expect(set.nonExecutable).toEqual([]);
    expect(set.sentence).toContain(`All ${TEST_TYPES.length} test types are executable`);
    expect(set.sentence).toContain('Measured at');
  });

  it('probes before reading, so a cold deployment is not reported as unmeasured', async () => {
    const db = store();
    h.prisma = { deploymentCapability: db.delegate };

    const { probe, capabilities } = await ensureDeploymentCapabilities({ io, probes: everything });

    expect(probe.fromCache).toBe(false);
    // The ordering is the point: read-then-probe would return the honest but
    // useless "nothing has been probed" set for the run that triggered it.
    expect(capabilities.measuredAt).toEqual(NOW);
    expect(capabilities.unprobed).toEqual([]);
  });
});

describe('the sentence a report prints', () => {
  const nonExec = (testType: TestType) => ({
    testType,
    status: DeploymentCapabilityStatus.MISSING,
    reason: 'no binary',
  });

  it('names the count, the types and the fact that they left the denominator', () => {
    const sentence = capabilitySentence({
      nonExecutable: [nonExec('LOAD'), nonExec('MUTATION'), nonExec('MOBILE'), nonExec('PERFORMANCE')],
      notChecked: [],
      unprobed: [],
      measuredAt: NOW,
    });
    expect(sentence).toContain(`4 of ${TEST_TYPES.length} test types are not executable here`);
    expect(sentence).toContain('leave the coverage denominator');
    expect(sentence).toContain('not silently dropped');
  });

  it('keeps the unresolved count as its own fact rather than folding it in', () => {
    /*
     * A reader given only "4 are not executable" reads silence on the rest as
     * "everything else is fine". Three facts, three clauses.
     */
    const sentence = capabilitySentence({
      nonExecutable: [nonExec('LOAD')],
      notChecked: ['MOBILE', 'CONTRACT'],
      unprobed: ['CONTRACT'],
      measuredAt: NOW,
    });
    expect(sentence).toContain('1 of');
    expect(sentence).toContain('2 type(s) could not be established');
    expect(sentence).toContain('1 of them never probed at all');
    expect(sentence).toContain('stay IN the denominator');
  });

  it('never prints a measurement date it does not have', () => {
    const sentence = capabilitySentence({
      nonExecutable: [],
      notChecked: [...TEST_TYPES],
      unprobed: [...TEST_TYPES],
      measuredAt: null,
    });
    expect(sentence).not.toContain('Measured at');
    expect(sentence).toContain('NOT MEASURED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The one piece of real I/O.
// ─────────────────────────────────────────────────────────────────────────────

describe('the version adapter', () => {
  it('refuses anything that is not a bare command name, without spawning it', async () => {
    /*
     * The requirement table is a literal in this repository today, so this is
     * defence in depth rather than a live hole — but it is one refactor away
     * from taking customer input, and the guard costs a regex. It returns
     * before `node:child_process` is even imported.
     */
    const adapter = defaultCapabilityIo();
    expect(await adapter.binaryVersion('k6; rm -rf /')).toBeNull();
    expect(await adapter.binaryVersion('/usr/local/bin/k6')).toBeNull();
    expect(await adapter.binaryVersion('../k6')).toBeNull();
  });

  it('answers null rather than throwing for a binary that is not there', async () => {
    const adapter = defaultCapabilityIo();
    // "Could not tell" is the one answer that never refuses a test and never
    // claims one will work.
    expect(await adapter.binaryVersion('qaai-no-such-binary-xyz')).toBeNull();
  });

  it('spawns nothing at all in the shipped configuration', async () => {
    /*
     * No entry in TYPE_REQUIREMENTS declares a version window (that table is
     * deliberately version-free until a real floor is established), so the
     * write path reads zero versions. This pins that cost at zero: if somebody
     * adds a window, this test tells them they have also added a process per
     * probe.
     */
    const spawned: string[] = [];
    const db = store();
    h.prisma = { deploymentCapability: db.delegate };

    await probeDeploymentCapabilities({
      io: {
        now: () => NOW,
        binaryVersion: async (binary) => {
          spawned.push(binary);
          return null;
        },
      },
      probes: everything,
    });

    expect(spawned).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The seam into the coverage denominator.
// ─────────────────────────────────────────────────────────────────────────────

describe('handing the capability set to the coverage denominator', () => {
  it('agrees with @qaai/shared about which statuses count, on every member', async () => {
    const { capabilityCounts } = await import('@qaai/shared');
    /*
     * `capabilityExecutable` is a named wrapper over the shared function and
     * must stay one. Two implementations of one exclusion rule means that the
     * day they disagree, the denominator and the report disagree about the same
     * deployment — and nothing would say which was right.
     */
    for (const status of CAPABILITY_STATUS_KINDS) {
      expect(capabilityExecutable(status)).toBe(capabilityCounts(status));
    }
  });

  it('pins the generated client to the vocabulary this module classifies', () => {
    /*
     * check-enums.ts compares schema.prisma's TEXT to the shared const, so it
     * structurally cannot notice a GENERATED CLIENT that is stale relative to
     * either. This can, and the failure it catches is a probe writing a status
     * the client does not know.
     */
    expect([...CAPABILITY_STATUS_KINDS].sort()).toEqual(
      Object.keys(DeploymentCapabilityStatus).sort(),
    );
  });

  it('emits a fact for all nineteen types, not just the rows that exist', async () => {
    const db = store([row({ testType: 'LOAD', status: DeploymentCapabilityStatus.MISSING })]);
    h.prisma = { deploymentCapability: db.delegate };

    const facts = capabilityFacts(await deploymentCapabilities());

    // The two modules cannot disagree about how many types there are.
    expect(facts).toHaveLength(TEST_TYPES.length);
    expect(facts.map((f) => f.testType)).toEqual([...TEST_TYPES]);
  });

  it('carries the reason, so the report can say WHY a type was excluded', async () => {
    const db = store([
      row({
        testType: 'LOAD',
        status: DeploymentCapabilityStatus.MISSING,
        detail: 'it is missing `k6`',
      }),
    ]);
    h.prisma = { deploymentCapability: db.delegate };

    const facts = capabilityFacts(await deploymentCapabilities());

    expect(facts.find((f) => f.testType === 'LOAD')).toEqual({
      testType: 'LOAD',
      status: 'MISSING',
      detail: 'it is missing `k6`',
    });
  });

  it('calls an unprobed type NOT_CHECKED and says it stays in the denominator', async () => {
    const db = store();
    h.prisma = { deploymentCapability: db.delegate };

    const facts = capabilityFacts(await deploymentCapabilities());

    // Not MISSING — that would be a claim about an image nobody looked at — and
    // not silently absent, which would leave the reason untravelled.
    expect(facts.every((f) => f.status === 'NOT_CHECKED')).toBe(true);
    expect(facts[0]!.detail).toContain('stays in the coverage denominator');
    expect(facts.every((f) => capabilityExecutable(f.status))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The browser capability — the half `resolveMatrixCell` had nothing to resolve
// against.
// ─────────────────────────────────────────────────────────────────────────────

/*
 * The trap here is the mirror image of the one above, and it is worth naming
 * because the two pull in opposite directions:
 *
 *   · For the TYPE rows, the dangerous read of an empty table is "all nineteen
 *     are executable" — a pass meaning "we did not check".
 *   · For the BROWSER rows, the dangerous read of an empty table is "no engine
 *     is installed" — a refusal of the whole matrix on a perfectly healthy
 *     image, with an install line attached.
 *
 * Both are the same defect: a missing measurement rendered as a measurement. So
 * these tests assert the ABSENCE of a key, not a status three layers up, and
 * they assert that a row which can no longer be answered for is REMOVED rather
 * than left vouching for a browser nobody can see any more.
 */

interface BrowserRow {
  deploymentKey: string;
  orgId: string | null;
  axis: string;
  name: string;
  installed: boolean;
  detail: string;
  checkedAt: Date;
}

function browserRow(over: Partial<BrowserRow> = {}): BrowserRow {
  return {
    deploymentKey: SELF_DEPLOYMENT_KEY,
    orgId: null,
    axis: 'ENGINE',
    name: 'chromium',
    installed: true,
    detail: "Playwright's chromium is on disk",
    checkedAt: new Date('2026-10-26T12:00:00.000Z'),
    ...over,
  };
}

/**
 * The browser store, which HONOURS `select`, `orderBy` and `take`.
 *
 * `select` for the reason the store above gives: a select-blind fake makes
 * deleting `checkedAt: true` from the reader's query undetectable, and
 * `checkedAt` is the field that makes a stale reading visible as stale. `take`
 * because the reader's budget is a real behaviour — a fake that ignored it would
 * let the truncation branch rot — and `orderBy` because a budget without an
 * order is a capability assembled out of whatever sorted first.
 */
function browserStore(initial: BrowserRow[] = []) {
  const rows = [...initial];
  const selects: Array<Record<string, boolean>> = [];
  const upserts: Array<{ axis: string; name: string; installed: boolean }> = [];
  const deletes: Array<{ axis: string; name: string }> = [];

  return {
    rows,
    selects,
    upserts,
    deletes,
    delegate: {
      findMany: async (args: {
        where?: { deploymentKey?: string };
        select?: Record<string, boolean>;
        orderBy?: unknown;
        take?: number;
      }) => {
        if (args.select) selects.push(args.select);
        let matched = rows.filter(
          (r) => !args.where?.deploymentKey || r.deploymentKey === args.where.deploymentKey,
        );
        matched = [...matched].sort(
          (a, b) => a.axis.localeCompare(b.axis) || a.name.localeCompare(b.name),
        );
        if (args.take !== undefined) matched = matched.slice(0, args.take);
        if (!args.select) return matched.map((r) => ({ ...r }));
        return matched.map((r) => {
          const projected: Record<string, unknown> = {};
          for (const [field, wanted] of Object.entries(args.select!)) {
            if (wanted) projected[field] = (r as unknown as Record<string, unknown>)[field];
          }
          return projected;
        });
      },
      upsert: async (args: {
        where: { deploymentKey_axis_name: { deploymentKey: string; axis: string; name: string } };
        create: Partial<BrowserRow>;
        update: Partial<BrowserRow>;
      }) => {
        const key = args.where.deploymentKey_axis_name;
        upserts.push({ axis: key.axis, name: key.name, installed: args.create.installed === true });
        const existing = rows.find(
          (r) =>
            r.deploymentKey === key.deploymentKey && r.axis === key.axis && r.name === key.name,
        );
        if (existing) Object.assign(existing, args.update);
        else rows.push(browserRow(args.create));
        return existing ?? rows[rows.length - 1]!;
      },
      deleteMany: async (args: {
        where: { deploymentKey?: string; OR?: Array<{ axis: string; name: string }> };
      }) => {
        const wanted = args.where.OR ?? [];
        const doomed = rows.filter(
          (r) =>
            (!args.where.deploymentKey || r.deploymentKey === args.where.deploymentKey) &&
            wanted.some((w) => w.axis === r.axis && w.name === r.name),
        );
        for (const row of doomed) {
          deletes.push({ axis: row.axis, name: row.name });
          rows.splice(rows.indexOf(row), 1);
        }
        return { count: doomed.length };
      },
    },
  };
}

/** Engines answered, channels and devices unanswerable. The common shape. */
const enginesOnly = {
  ...everything,
  channelResolves: () => null,
  devicePresetKnown: () => null,
};

describe('writing what this deployment has to launch with', () => {
  it('writes a row only for a member the probe actually answered for', async () => {
    const db = browserStore();
    h.prisma = { deploymentBrowserCapability: db.delegate };

    const result = await probeDeploymentBrowserCapability({ io, probes: enginesOnly });

    expect(result.written.map((r) => `${r.axis}/${r.name}`).sort()).toEqual([
      'ENGINE/chromium',
      'ENGINE/firefox',
      'ENGINE/webkit',
    ]);
    // Not a row saying `installed: false` for every channel and preset, which
    // would refuse the whole matrix on an image that has the browsers.
    expect(db.rows.every((r) => r.axis === 'ENGINE')).toBe(true);
    expect(result.notProbed.length).toBeGreaterThan(0);
  });

  it('removes a stored reading the moment nothing can answer for it any more', async () => {
    /*
     * THE ANTI-STALENESS HALF, and it only works by deleting. A retained
     * `installed = true` for a browser that has since been removed from the
     * image would keep vouching for it for ever, because the probe that used to
     * answer no longer writes anything at all for that member. Leaving it is
     * exactly the cached AVAILABLE this whole file argues against.
     */
    const db = browserStore([browserRow({ axis: 'ENGINE', name: 'webkit', installed: true })]);
    h.prisma = { deploymentBrowserCapability: db.delegate };

    const result = await probeDeploymentBrowserCapability({
      io,
      probes: { ...enginesOnly, browserInstalled: (engine) => (engine === 'webkit' ? null : true) },
    });

    expect(result.cleared).toBe(1);
    expect(db.deletes).toEqual(expect.arrayContaining([{ axis: 'ENGINE', name: 'webkit' }]));
    expect(db.rows.find((r) => r.name === 'webkit')).toBeUndefined();
  });

  it('writes the reading it took, with the time it took it', async () => {
    const db = browserStore();
    h.prisma = { deploymentBrowserCapability: db.delegate };

    await probeDeploymentBrowserCapability({
      io,
      probes: { ...enginesOnly, browserInstalled: (engine) => engine === 'chromium' },
    });

    const chromium = db.rows.find((r) => r.name === 'chromium');
    const firefox = db.rows.find((r) => r.name === 'firefox');
    expect(chromium?.installed).toBe(true);
    expect(chromium?.checkedAt).toEqual(NOW);
    // A real `false` IS written: "Playwright's firefox is not downloaded" is a
    // measurement, and its remedy is an install that works.
    expect(firefox?.installed).toBe(false);
    expect(firefox?.detail).toContain('not downloaded');
  });
});

describe('reading the browser capability back', () => {
  it('treats an empty table as nobody having probed, not as an image with no browsers', async () => {
    const db = browserStore();
    h.prisma = { deploymentBrowserCapability: db.delegate };

    const set = await deploymentBrowserCapabilities();

    expect(set.measuredAt).toBeNull();
    expect(set.browsers.engines).toEqual({});
    // The dangerous implementation refuses the whole matrix here, with an
    // install line attached to every cell.
    expect(set.summary.installable).toEqual([]);
    expect(set.summary.impossibleHere).toEqual([]);
    expect(set.summary.notChecked.length).toBe(set.cells.length);
    expect(set.sentence).toContain('No engine, channel or device preset has been probed');
    expect(set.sentence).toContain('stay IN the denominator');
  });

  it('rebuilds the exact shape resolveMatrixCell consumes', async () => {
    const db = browserStore([
      browserRow({ axis: 'ENGINE', name: 'chromium', installed: true }),
      browserRow({ axis: 'ENGINE', name: 'webkit', installed: false }),
      browserRow({ axis: 'CHANNEL', name: 'CHROME', installed: true }),
      browserRow({ axis: 'DEVICE_PRESET', name: 'IPHONE_14', installed: true }),
    ]);
    h.prisma = { deploymentBrowserCapability: db.delegate };

    const set = await deploymentBrowserCapabilities();

    expect(set.browsers).toEqual({
      engines: { chromium: true, webkit: false },
      channels: { CHROME: true },
      devicePresets: { IPHONE_14: true },
    });
    const statusOf = (
      predicate: (cell: (typeof set.cells)[number]['cell']) => boolean,
    ): string | undefined => set.cells.find((resolution) => predicate(resolution.cell))?.status;
    const bare = (engine: string) => (cell: (typeof set.cells)[number]['cell']) =>
      cell.engine === engine && cell.channel === undefined && cell.device === undefined;

    expect(statusOf(bare('chromium'))).toBe('AVAILABLE');
    expect(statusOf(bare('webkit'))).toBe('MISSING');
    expect(statusOf((cell) => cell.channel === 'CHROME')).toBe('AVAILABLE');
    // Never probed, so never a verdict — not MISSING, which would refuse it.
    expect(statusOf(bare('firefox'))).toBe('NOT_CHECKED');
    expect(set.summary.byStatus.MISSING).toBe(1);
  });

  it('asks for the fields it reads, so deleting one from the query is detectable', async () => {
    const db = browserStore([browserRow()]);
    h.prisma = { deploymentBrowserCapability: db.delegate };

    await deploymentBrowserCapabilities();

    // `checkedAt` especially: without it `measuredAt` is silently null and a
    // stale reading becomes indistinguishable from a fresh one.
    expect(db.selects[0]).toEqual({
      axis: true,
      name: true,
      installed: true,
      detail: true,
      checkedAt: true,
    });
  });

  it('reports the oldest reading, so freshness cannot be read off the newest row', async () => {
    const old = new Date('2026-10-20T00:00:00.000Z');
    const db = browserStore([
      browserRow({ name: 'chromium', checkedAt: new Date('2026-10-26T00:00:00.000Z') }),
      browserRow({ name: 'firefox', checkedAt: old }),
    ]);
    h.prisma = { deploymentBrowserCapability: db.delegate };

    expect((await deploymentBrowserCapabilities()).measuredAt).toEqual(old);
  });

  it('rejects a stored reading this build cannot interpret rather than coercing it', async () => {
    /*
     * `axis` and `name` are TEXT, so a newer build — or a renamed device preset
     * — can leave a row no vocabulary here contains. Coercing it would put a
     * reading under a key that means something else; dropping it in silence
     * would make the capability look complete while one of its members was
     * quietly unprobed.
     */
    const db = browserStore([
      browserRow({ axis: 'ENGINES', name: 'chromium' }),
      browserRow({ axis: 'ENGINE', name: 'netscape' }),
      browserRow({ axis: 'ENGINE', name: 'chromium' }),
    ]);
    h.prisma = { deploymentBrowserCapability: db.delegate };

    const set = await deploymentBrowserCapabilities();

    expect(set.rejected).toHaveLength(2);
    expect(set.browsers.engines).toEqual({ chromium: true });
    expect(set.sentence).toContain('REJECTED rather than interpreted');
    expect(set.sentence).toContain('read as NOT PROBED');
  });

  it('says the read budget bit instead of assembling a capability out of a prefix', async () => {
    const db = browserStore(
      Array.from({ length: BROWSER_CAPABILITY_ROW_BUDGET + 1 }, (_unused, i) =>
        browserRow({ axis: 'ENGINE', name: `pad-${String(i).padStart(4, '0')}` }),
      ),
    );
    h.prisma = { deploymentBrowserCapability: db.delegate };

    const set = await deploymentBrowserCapabilities();

    expect(set.truncated).toBe(true);
    expect(set.sentence).toContain('INCOMPLETE');
    expect(set.sentence).toContain('rather than as absent');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The declaration bridge: the eleven types the prober's own table cannot hold.
// ─────────────────────────────────────────────────────────────────────────────

describe('probing the types the requirement table cannot hold', () => {
  it('answers for the pending types whose plugins shipped', async () => {
    /*
     * Before this, `TYPE_REQUIREMENTS` being a `Record` over the nineteen minted
     * types meant `checkRunnability` could not be ASKED about CHAOS, DOCUMENT,
     * PWA or PUSH — not "unknown", not "pending": the call did not typecheck,
     * while each of those had a registered plugin.
     */
    const declared = await declaredTypeRunnability({ probes: everything });

    const names = declared.answered.map((entry) => entry.type);
    expect(names).toEqual(expect.arrayContaining(['CHAOS', 'DOCUMENT', 'PWA', 'PUSH']));
    for (const entry of declared.answered) expect(entry.reason.length).toBeGreaterThan(0);
  });

  it('asks about the minted nineteen nowhere, because the other half owns them', async () => {
    // Two answers to one question is how one of them starts being wrong, and the
    // wrong one is whichever the reader is not looking at. `requirementParity`
    // is the guard that the two tables agree about the nineteen.
    const declared = await declaredTypeRunnability({ probes: everything });
    for (const minted of TEST_TYPES) {
      expect(declared.answered.map((entry) => entry.type)).not.toContain(minted);
    }
  });

  it('refuses a registered plugin with no declaration, and says what is missing', async () => {
    const declared = await declaredTypeRunnability({ probes: everything });

    const email = declared.refused.find((entry) => entry.type === 'EMAIL');
    expect(email).toBeDefined();
    // UNKNOWN rather than nothing: API and SECURITY_SMOKE genuinely need
    // nothing, and reporting the two the same way would hide a real gap.
    expect(email?.why).toContain('PENDING_TEST_TYPES');
  });

  it('stores nothing for a pending type, and says that in the sentence', async () => {
    const declared = await declaredTypeRunnability({ probes: everything });

    expect(declared.sentence).toContain('No row is stored');
    expect(declared.sentence).toContain('in a coverage denominator');
  });

  it('discloses a demoted channel and points at the thing that does answer for it', async () => {
    /*
     * `asProbeRequirement` demotes a declared CHANNEL requirement to UNPROBED
     * because this prober asks Playwright which ENGINES are installed. The
     * demotion is only honest if the thing it points at can answer — so every
     * demoted channel must be a member the browser capability probe asks about.
     * A channel demoted to a prober that does not cover it is a disclosure
     * pointing at nobody.
     */
    const declared = await declaredTypeRunnability({ probes: everything });
    const probe = await probeDeploymentBrowsers(enginesOnly);
    const asked = new Set(
      probe.readings.filter((r) => r.axis === 'CHANNEL').map((reading) => reading.name),
    );

    expect(declared.demotedChannels.length).toBeGreaterThan(0);
    for (const entry of declared.demotedChannels) {
      expect(entry.channels.length).toBeGreaterThan(0);
      for (const channel of entry.channels) expect(asked.has(channel)).toBe(true);
    }
    expect(declared.sentence).toContain('declare a browser CHANNEL this prober cannot see');
  });

  it('never writes a type the TestType column cannot hold', async () => {
    const db = store();
    h.prisma = { deploymentCapability: db.delegate };

    await probeDeploymentCapabilities({ io, probes: everything });

    // The enum holds the nineteen. A pending type has no value to be stored
    // under, by design, and inventing one is the first step toward counting a
    // test nobody can create.
    const written = db.upserts.map((u) => u.create.testType as TestType);
    expect(written.length).toBe(TEST_TYPES.length);
    for (const testType of written) expect(TEST_TYPES).toContain(testType);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The one line an operator reads.
// ─────────────────────────────────────────────────────────────────────────────

describe('the sentence the preflight job logs', () => {
  it('carries all three facts, because its one caller logs one string', async () => {
    const types = store();
    const browsers = browserStore();
    h.prisma = {
      deploymentCapability: types.delegate,
      deploymentBrowserCapability: browsers.delegate,
    };

    const result = await ensureDeploymentCapabilities({ io, probes: enginesOnly });

    expect(result.browsers).not.toBeNull();
    expect(result.capabilities.sentence).toContain('test types');
    expect(result.capabilities.sentence).toContain('browser/device cells');
    expect(result.capabilities.sentence).toContain('declared-but-unminted test type');
    expect(result.declared.answered.length).toBeGreaterThan(0);
  });

  it('keeps the nineteen type rows when the browser store cannot be reached', async () => {
    /*
     * The table arrives in a migration this round WRITES and does not APPLY, so
     * a worker on this build against a database where `prisma migrate deploy`
     * has not run throws on the first browser upsert. Losing the type rows over
     * that would be far worse than not having the browser capability — and the
     * report must say NOT MEASURED rather than anything about the image.
     */
    const types = store();
    h.prisma = { deploymentCapability: types.delegate };

    const result = await ensureDeploymentCapabilities({ io, probes: enginesOnly });

    expect(result.probe.rows.length).toBe(TEST_TYPES.length);
    expect(result.browsers).toBeNull();
    expect(result.capabilities.sentence).toContain('NOT MEASURED');
    expect(h.log.some((entry) => entry.level === 'error')).toBe(true);
    // The database's own error text never reaches a string that is rendered into
    // a coverage report or a PR comment.
    expect(result.capabilities.sentence).not.toContain('deploymentBrowserCapability');
  });

  it('warns when the two requirement tables disagree about a minted type', async () => {
    const types = store();
    const browsers = browserStore();
    h.prisma = {
      deploymentCapability: types.delegate,
      deploymentBrowserCapability: browsers.delegate,
    };

    await probeDeploymentCapabilities({
      io,
      probes: everything,
      parity: () => [{ type: 'LOAD', only: ['preflight:BINARY:k6'] }],
    });

    const warned = h.log.find((entry) => entry.level === 'warn');
    expect(warned?.msg).toContain('disagree');
    // A capability row computed from one of two answers is exactly the state
    // where the wrong one is whichever the reader is not looking at.
    expect(JSON.stringify(warned?.obj)).toContain('LOAD');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The migration.
// ─────────────────────────────────────────────────────────────────────────────

describe('the migration that adds the browser capability table', () => {
  /*
   * ── ASSERTED AGAINST A PREDECESSOR PINNED BY NAME, NEVER BY POSITION ──────
   *
   * A test that reads the migrations folder and expects its own to sort LAST
   * goes red the moment the next round lands one, and a red check with no
   * available remedy is a check people start skipping.
   */
  const MIGRATIONS = fileURLToPath(new URL('../../../api/prisma/migrations', import.meta.url));
  const PREDECESSOR = '20261027090000_browser_matrix_cells_and_unasserted_honesty';
  const MINE = '20261027120000_deployment_browser_capability';

  it('sorts after the migration that added the cells it resolves', () => {
    const dirs = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/.test(name));
    expect(dirs).toContain(PREDECESSOR);
    expect(dirs).toContain(MINE);
    // Prisma applies in lexicographic order, and this table is useless before
    // the MatrixCellStatus enum and the cell columns exist.
    expect(MINE > PREDECESSOR).toBe(true);
  });

  it('shares its timestamp with no other migration', () => {
    // Two directories on one timestamp is an ordering nobody controls: which
    // applies first depends on the rest of the name.
    const stamps = readdirSync(MIGRATIONS)
      .filter((name) => /^\d{14}_/.test(name))
      .map((name) => name.slice(0, 14));
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it('creates the table with the columns that make absence mean "not probed"', () => {
    const sql = readFileSync(join(MIGRATIONS, MINE, 'migration.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE "DeploymentBrowserCapability"');
    // Both NOT NULL: a row exists only when the probe answered, so there is no
    // third state in either column — the missing row is the third state.
    expect(sql).toContain('"installed" BOOLEAN NOT NULL');
    expect(sql).toContain('"checkedAt" TIMESTAMP(3) NOT NULL');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "DeploymentBrowserCapability_deploymentKey_axis_name_key"',
    );
    // No new enum: a Prisma value with no TypeScript twin fails `check:enums`,
    // and the twin lives in a file this slice does not own.
    expect(sql).not.toContain('CREATE TYPE');
  });
});
