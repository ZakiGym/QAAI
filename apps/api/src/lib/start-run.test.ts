/**
 * The run toll (§9): the free-tier ceiling, and the counter the billing screen
 * reads back.
 *
 * ─── What went wrong, and what these tests pin ──────────────────────────────
 *
 * Seven places in this product create a Run. Two of them — POST /runs and
 * POST /repro — consulted the plan and incremented `UsageRecord('runs')`. The
 * other five did neither: the pull-request webhook, the GitHub App re-run
 * button, the scheduler, the bisect prober, the flake confirmer and the
 * copilot's `run_tests` tool. So:
 *
 *   • the FREE tier's only real ceiling was bypassed permanently by anyone who
 *     made a schedule instead of pressing Run — and because the counter never
 *     moved on that path, POST /runs never refused them either;
 *   • `usage.runsThisMonth` on every paying customer's billing screen was short
 *     by however much of their testing was automated.
 *
 * `startRun` is now the only way to bring a Run into existence, so the tests
 * below are written against it directly rather than through seven route
 * harnesses. That is the point of the refactor: there is one toll to test.
 *
 * Everything here is honest about a refusal costing NOTHING — no row, no count.
 * A counter that climbed on refusals would be a different lie in the same
 * column.
 *
 * No mocking. `startRun` takes its Prisma client as an argument (so apps/worker
 * can call it), which means the store below is passed in rather than injected
 * over a module boundary, and nothing in this file can accidentally be testing
 * a stub of the code under test.
 */

import { describe, expect, it } from 'vitest';
import { PLAN_LIMITS, type Plan } from '@qaai/shared';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ApiError } from './errors.js';
import { RUNS_METRIC, currentPeriod, effectivePlan, runQuota, startRun } from './start-run.js';
import type { RunCreateData, RunStore } from './start-run.js';

const FREE_CAP = PLAN_LIMITS.FREE.maxRunsPerMonth!;

/**
 * `any` is allowed in tests (see eslint.config.js). Used only for in-memory
 * rows, because a hand-written Prisma row type would be a second copy of the
 * schema that can drift from it.
 */
type Row = Record<string, any>;

interface Scenario {
  /** The Subscription row, or none at all — a seeded or self-hosted org. */
  subscription?: { plan: Plan; status: string } | null;
  /** Organization.plan. FREE unless a test says otherwise. */
  orgPlan?: Plan;
  /** Runs already spent this billing month. */
  used?: number;
  /** Runs spent in an earlier month, which must not count against this one. */
  usedLastMonth?: number;
}

function usageKey(orgId: string, metric: string, period: Date): string {
  return `${orgId}|${metric}|${period.toISOString()}`;
}

function lastPeriod(): Date {
  const p = currentPeriod();
  return new Date(Date.UTC(p.getUTCFullYear(), p.getUTCMonth() - 1, 1));
}

/**
 * The smallest store `startRun` can run against, and loud about anything it is
 * asked for that it does not model — a silently-undefined delegate is how a
 * toll stops being paid without any test noticing.
 */
function fakeStore(scenario: Scenario = {}) {
  const orgId = 'org-1';
  const created: Row[] = [];
  const usage = new Map<string, bigint>();

  usage.set(usageKey(orgId, RUNS_METRIC, currentPeriod()), BigInt(scenario.used ?? 0));
  if (scenario.usedLastMonth !== undefined) {
    usage.set(usageKey(orgId, RUNS_METRIC, lastPeriod()), BigInt(scenario.usedLastMonth));
  }

  const db = {
    run: {
      create: async ({ data }: { data: Row }) => {
        created.push(data);
        return { id: `run-${created.length}`, ...data };
      },
    },
    usageRecord: {
      findUnique: async ({ where }: { where: Row }) => {
        const k = where.orgId_metric_period;
        const q = usage.get(usageKey(k.orgId, k.metric, k.period));
        return q === undefined ? null : { quantity: q };
      },
      upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        const k = where.orgId_metric_period;
        const key = usageKey(k.orgId, k.metric, k.period);
        const existing = usage.get(key);
        if (existing === undefined) usage.set(key, create.quantity as bigint);
        else usage.set(key, existing + (update.quantity.increment as bigint));
        return {};
      },
    },
    subscription: {
      findUnique: async () => scenario.subscription ?? null,
    },
    organization: {
      findUnique: async () => ({ plan: scenario.orgPlan ?? 'FREE' }),
    },
  } as unknown as RunStore;

  return {
    orgId,
    db,
    created,
    /** What `GET /billing` would report as `usage.runsThisMonth`. */
    counter: () => Number(usage.get(usageKey(orgId, RUNS_METRIC, currentPeriod())) ?? 0n),
  };
}

/** A Run shaped like the one whichever path is being stood in for would write. */
function runData(orgId: string, over: Row = {}): RunCreateData {
  return {
    orgId,
    projectId: 'proj-1',
    environmentId: 'env-1',
    trigger: 'MANUAL',
    totalCount: 1,
    results: { create: [{ orgId, testId: 'test-1', status: 'SKIPPED' }] },
    ...over,
  };
}

// ─── The plan an org is actually metered at ──────────────────────────────────

describe('which plan the limits come from', () => {
  it('honours Organization.plan when no subscription was ever bought', () => {
    // A seeded org, a self-hosted install, an enterprise contract signed
    // offline. None of them went through Stripe, and all of them were once
    // silently metered at FREE.
    expect(effectivePlan(null, 'BUSINESS')).toEqual({
      plan: 'BUSINESS',
      effective: 'BUSINESS',
      paying: false,
    });
  });

  it('meters a past-due paid org at free limits but keeps its label', () => {
    // The label is what lets the UI say "your Team plan is past due" instead of
    // pretending the customer was always free.
    expect(effectivePlan({ plan: 'TEAM', status: 'past_due' }, 'FREE')).toEqual({
      plan: 'TEAM',
      effective: 'FREE',
      paying: false,
    });
  });

  it('treats trialing as paying', () => {
    expect(effectivePlan({ plan: 'TEAM', status: 'trialing' }, 'FREE').effective).toBe('TEAM');
  });
});

describe('runQuota', () => {
  it('allows the run that lands exactly on the cap', async () => {
    const { db, orgId } = fakeStore({ used: FREE_CAP - 1 });
    const quota = await runQuota(db, orgId);
    expect(quota).toMatchObject({ allowed: true, cap: FREE_CAP, used: FREE_CAP - 1 });
  });

  it('refuses the one after it, and says how to fix it', async () => {
    const { db, orgId } = fakeStore({ used: FREE_CAP });
    const quota = await runQuota(db, orgId);
    expect(quota.allowed).toBe(false);
    expect(quota.reason).toContain(`all ${FREE_CAP} runs`);
    expect(quota.reason).toContain('Free');
  });

  it('never refuses a paid plan — maxRunsPerMonth is null on every one', async () => {
    const { db, orgId } = fakeStore({
      subscription: { plan: 'TEAM', status: 'active' },
      used: 100_000,
    });
    const quota = await runQuota(db, orgId);
    expect(quota).toMatchObject({ allowed: true, cap: null, used: 100_000 });
  });

  it('names the plan the customer bought, not the one they are metered at', async () => {
    const { db, orgId } = fakeStore({
      subscription: { plan: 'TEAM', status: 'past_due' },
      used: FREE_CAP,
    });
    const quota = await runQuota(db, orgId);
    // Metered at FREE, told about Team. Being told "you have used all 100 runs
    // included with Free" while paying for Team is how a support ticket starts.
    expect(quota).toMatchObject({ allowed: false, plan: 'TEAM', effective: 'FREE' });
    expect(quota.reason).toContain('Team');
  });

  it('counts this billing month only', async () => {
    const { db, orgId } = fakeStore({ used: 0, usedLastMonth: FREE_CAP * 5 });
    expect((await runQuota(db, orgId)).allowed).toBe(true);
  });
});

// ─── enforce: the HTTP paths ─────────────────────────────────────────────────

describe('enforce mode — POST /runs and POST /repro', () => {
  it('a FREE org at the cap is refused 402 PLAN_LIMIT', async () => {
    const store = fakeStore({ used: FREE_CAP });

    const thrown = await startRun({
      db: store.db,
      orgId: store.orgId,
      mode: 'enforce',
      data: runData(store.orgId),
    }).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(ApiError);
    const err = thrown as ApiError;
    expect(err.status).toBe(402);
    expect(err.code).toBe('PLAN_LIMIT');
    expect(err.details).toEqual({ limit: 'maxRunsPerMonth', plan: 'FREE' });
    expect(err.message).toContain(`all ${FREE_CAP} runs`);
  });

  it('a refusal writes nothing and costs nothing', async () => {
    const store = fakeStore({ used: FREE_CAP });
    await startRun({
      db: store.db,
      orgId: store.orgId,
      mode: 'enforce',
      data: runData(store.orgId),
    }).catch(() => {});

    // No row, and — just as important — no count. A counter that ticked on
    // refusals would report more runs than were ever executed.
    expect(store.created).toEqual([]);
    expect(store.counter()).toBe(FREE_CAP);
  });

  it('appends the caller note, so /repro can say what survived the refusal', async () => {
    const store = fakeStore({ used: FREE_CAP });
    const thrown = (await startRun({
      db: store.db,
      orgId: store.orgId,
      mode: 'enforce',
      note: 'The reproduction was written (test test-1) but not run.',
      data: runData(store.orgId),
    }).catch((err: unknown) => err)) as ApiError;

    expect(thrown.message).toMatch(/runs.*reset on the 1st.*reproduction was written/s);
  });

  it('the last run under the cap is allowed, and is the one that closes it', async () => {
    const store = fakeStore({ used: FREE_CAP - 1 });

    const first = await startRun({
      db: store.db,
      orgId: store.orgId,
      mode: 'enforce',
      data: runData(store.orgId),
    });
    expect(first.created).toBe(true);
    expect(store.counter()).toBe(FREE_CAP);

    // And the next one is refused, using the count the previous call wrote.
    await expect(
      startRun({
        db: store.db,
        orgId: store.orgId,
        mode: 'enforce',
        data: runData(store.orgId),
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(store.created).toHaveLength(1);
  });
});

// ─── advisory: the background paths ──────────────────────────────────────────

describe('advisory mode — the scheduler, bisect, flake, the copilot, the webhooks', () => {
  it('hands the refusal back instead of throwing', async () => {
    // A cron tick that throws vanishes into the queue's failed set and the
    // customer's nightly silently stops. That is a worse bug than the unlimited
    // free runs this closes, so the refusal has to be a value the caller can
    // report.
    const store = fakeStore({ used: FREE_CAP });

    const result = await startRun({
      db: store.db,
      orgId: store.orgId,
      mode: 'advisory',
      data: runData(store.orgId, { trigger: 'SCHEDULE' }),
    });

    expect(result.created).toBe(false);
    expect(result.run).toBeNull();
    expect(result.quota.allowed).toBe(false);
    expect(result.quota.reason).toContain(`all ${FREE_CAP} runs`);
    expect(store.created).toEqual([]);
    expect(store.counter()).toBe(FREE_CAP);
  });

  it('respects the same ceiling the HTTP paths do, to the run', async () => {
    const store = fakeStore({ used: FREE_CAP - 1 });

    const allowed = await startRun({
      db: store.db,
      orgId: store.orgId,
      mode: 'advisory',
      data: runData(store.orgId, { trigger: 'MONITOR' }),
    });
    expect(allowed.created).toBe(true);

    const refused = await startRun({
      db: store.db,
      orgId: store.orgId,
      mode: 'advisory',
      data: runData(store.orgId, { trigger: 'MONITOR' }),
    });
    expect(refused.created).toBe(false);
  });
});

// ─── metering is unconditional ───────────────────────────────────────────────

describe('every run that is created is counted', () => {
  /*
   * One case per previously-unmetered path, named by the trigger and
   * `triggeredBy` that path actually writes. Five of these produced runs that
   * `GET /billing` never saw.
   */
  const paths: Array<{ name: string; mode: 'enforce' | 'advisory'; over: Row }> = [
    { name: 'POST /runs', mode: 'enforce', over: { trigger: 'MANUAL' } },
    { name: 'POST /repro', mode: 'enforce', over: { trigger: 'MANUAL' } },
    { name: 'the pull-request webhook', mode: 'advisory', over: { trigger: 'WEBHOOK' } },
    {
      name: 'the GitHub App re-run button',
      mode: 'advisory',
      over: { trigger: 'WEBHOOK', triggeredBy: 'github-app:rerun' },
    },
    { name: 'a cron schedule', mode: 'advisory', over: { trigger: 'SCHEDULE' } },
    { name: 'a monitor check', mode: 'advisory', over: { trigger: 'MONITOR' } },
    {
      name: 'a bisect probe',
      mode: 'advisory',
      over: { trigger: 'MANUAL', triggeredBy: 'bisect:test-1:b1', commitSha: 'abc1234' },
    },
    {
      name: 'a flake confirmation run',
      mode: 'advisory',
      over: { trigger: 'MANUAL', triggeredBy: 'flake-radar:test-1:inv12345' },
    },
    { name: "the copilot's run_tests", mode: 'advisory', over: { trigger: 'MANUAL' } },
  ];

  for (const path of paths) {
    it(`${path.name} moves the counter`, async () => {
      const store = fakeStore({ used: 7 });

      const result = await startRun({
        db: store.db,
        orgId: store.orgId,
        mode: path.mode as 'advisory',
        data: runData(store.orgId, path.over),
      });

      expect(result.created).toBe(true);
      expect(store.created).toHaveLength(1);
      expect(store.counter()).toBe(8);
    });
  }

  it('counts on paid plans too — the billing screen is the whole reason', async () => {
    // A TEAM org can never be refused, which is exactly why it was easy to
    // forget to count it. Its usage number is what it is charged against.
    const store = fakeStore({ subscription: { plan: 'TEAM', status: 'active' }, used: 5000 });

    await startRun({
      db: store.db,
      orgId: store.orgId,
      mode: 'advisory',
      data: runData(store.orgId, { trigger: 'SCHEDULE' }),
    });

    expect(store.counter()).toBe(5001);
  });

  it('starts the month at one when no UsageRecord row exists yet', async () => {
    const store = fakeStore();
    await startRun({
      db: store.db,
      orgId: store.orgId,
      mode: 'advisory',
      data: runData(store.orgId, { trigger: 'WEBHOOK' }),
    });
    expect(store.counter()).toBe(1);
  });

  it('counts each of a bisect probe’s repeats separately', async () => {
    // A probe is N real runs at one commit. Counting the probe once would
    // under-report by a factor of the repeat count on the single path that
    // creates the most runs per request.
    const store = fakeStore();
    for (let i = 0; i < 3; i++) {
      await startRun({
        db: store.db,
        orgId: store.orgId,
        mode: 'advisory',
        data: runData(store.orgId, { triggeredBy: 'bisect:test-1:b1' }),
      });
    }
    expect(store.counter()).toBe(3);
  });
});

// ─── the wiring ──────────────────────────────────────────────────────────────

/**
 * The toll can only be paid once by everyone if nobody creates a Run any other
 * way.
 *
 * Asserted against the source text, deliberately, and in the same spirit as
 * the literal check in apps/worker/src/processors/retention.test.ts: the whole
 * defect being fixed here is that five files reached for `prisma.run.create`
 * directly, and a behavioural test of `startRun` cannot notice a sixth one
 * appearing next to it.
 */
describe('every path that creates a Run goes through startRun', () => {
  /*
   * The mode is part of the wiring, not a detail of it.
   *
   * `enforce` throws a 402 the caller can render. On a background path there is
   * nobody to render it: a cron that throws into BullMQ retries a few times and
   * then vanishes, so a user's nightly suite stops with no cap message anywhere
   * — worse than the unmetered bug this replaced. So the request paths enforce
   * and the queue paths are advisory, and which is which is asserted here
   * because a one-word edit silently converts one into the other.
   */
  const CREATORS: Array<{ file: string; mode: 'enforce' | 'advisory' }> = [
    // A person is waiting on an HTTP response, so a refusal has somewhere to go.
    { file: 'apps/api/src/routes/runs.ts', mode: 'enforce' },
    { file: 'apps/api/src/routes/repro.ts', mode: 'enforce' },
    // Fired by GitHub or a timer. Nobody is holding a response open.
    { file: 'apps/api/src/routes/webhooks.ts', mode: 'advisory' },
    { file: 'apps/api/src/routes/github.ts', mode: 'advisory' },
    { file: 'apps/worker/src/processors/schedule.ts', mode: 'advisory' },
    { file: 'apps/worker/src/processors/bisect.ts', mode: 'advisory' },
    { file: 'apps/worker/src/processors/flake.ts', mode: 'advisory' },
    { file: 'apps/worker/src/copilot-tools.ts', mode: 'advisory' },
  ];

  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const read = (rel: string) => readFileSync(`${repoRoot}${rel}`, 'utf8');

  for (const { file, mode } of CREATORS) {
    it(`${file} calls startRun in ${mode} mode and never prisma.run.create`, () => {
      const source = read(file);
      // Strip comments so the prose in them cannot satisfy or break this.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');

      // Asserted as objects rather than string containment so a failure prints
      // one line about the file instead of diffing the whole module.
      expect({ file, createsRunsDirectly: code.includes('prisma.run.create') }).toEqual({
        file,
        createsRunsDirectly: false,
      });
      expect({ file, paysTheToll: code.includes('startRun(') }).toEqual({
        file,
        paysTheToll: true,
      });

      // Every mode literal in the file, so flipping a cron to `enforce` — which
      // is the edit that makes it throw into a queue and disappear — fails here
      // rather than in production three weeks later.
      const modes = [...code.matchAll(/mode:\s*'(enforce|advisory)'/g)].map((m) => m[1]);
      expect({ file, modes: [...new Set(modes)] }).toEqual({ file, modes: [mode] });
    });
  }

  /**
   * A ninth creator, in a file nobody listed.
   *
   * The list above is hand-maintained, which makes it exactly as good as
   * somebody's memory — and the defect being fixed here is that five call sites
   * were forgotten. This sweeps the tree instead, so a new `prisma.run.create`
   * anywhere is a failure whether or not the list was updated.
   */
  it('no other first-party file creates a Run directly', () => {
    const skip = new Set(['node_modules', 'dist', '.next', 'generated']);
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full, out);
        else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)) out.push(full);
      }
      return out;
    };

    const offenders = [...walk(`${repoRoot}apps`), ...walk(`${repoRoot}packages`)]
      .filter((f) => {
        const code = readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .filter((line) => !line.trim().startsWith('//'))
          .join('\n');
        return code.includes('prisma.run.create') || code.includes('tx.run.create');
      })
      .map((f) => f.slice(repoRoot.length));

    // start-run.ts is the one place allowed to do it — it IS the toll booth.
    expect(offenders.filter((f) => f !== 'apps/api/src/lib/start-run.ts')).toEqual([]);
  });
});
