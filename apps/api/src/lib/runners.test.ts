/**
 * Tests for the pool arithmetic in lib/runners.ts — the part that decides
 * whether an on-prem run is going to happen, and what to say when it is not.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. `assessPool` asks its four questions IN ORDER. Reordering them is a very
 *      easy edit and produces confidently wrong advice: check capabilities
 *      before liveness and a dead agent is reported as "install chromium",
 *      sending someone to the wrong box. Each case below is a fleet that is
 *      broken in exactly one way, and asserts the diagnosis names that one.
 *
 *   2. It FAILS OPEN. One capable online runner is enough, even standing next
 *      to nine that cannot serve the job — because the alternative is
 *      suppressing tests that would have run. The `.some`/`.every` mistake is
 *      one character and changes suppression from "nobody can" to "somebody
 *      cannot", so it gets its own test.
 *
 *   3. `describeUnservable` and `describeDispatch` never disagree about the
 *      FACTS. They are written for different moments — one explains tests that
 *      were already skipped, the other warns about a run that was just queued —
 *      and if they can reach different verdicts then the screen and the API
 *      contradict each other about whether a pool works.
 *
 *   4. `summarisePools` shows a pool that has an environment pointed at it and
 *      no runner serving it. That configuration renders as *nothing at all* on
 *      a list of runners, and it is the single most common shape of "I
 *      registered a runner and nothing happens" — so it is the case the row
 *      exists for.
 *
 * Pure functions only: no database, no clock of its own. Every `now` is passed
 * in, so a test that depends on liveness cannot become flaky at 60 seconds.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * lib/runners.ts reaches for the Prisma singleton, the queue's ioredis
 * connection and the vault's master key at import time. None of the functions
 * under test touch any of them — they take everything as arguments — but the
 * module still has to load.
 */
vi.mock('../env.js', () => ({
  env: {
    // hashToken() is an HMAC keyed on this; without it every token
    // digest throws. A fixed value keeps the digests stable across runs.
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    DATABASE_URL: 'postgres://localhost/none',
  },
  isProd: false,
}));

vi.mock('./prisma.js', () => ({
  prisma: new Proxy({}, { get: () => new Proxy({}, { get: () => () => {
    throw new Error('these tests must not touch the database');
  } }) }),
  unscoped: <T,>(fn: () => T) => fn(),
  withTenant: <T,>(_orgId: string, fn: () => T) => fn(),
  currentTenant: () => null,
}));

vi.mock('./queues.js', () => ({ enqueue: async () => {} }));
vi.mock('./events.js', () => ({ publish: () => {} }));
vi.mock('./audit.js', () => ({ audit: async () => {} }));
vi.mock('./logger.js', () => ({
  logger: { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const {
  RUNNER_ONLINE_MS,
  assessPool,
  describeDispatch,
  describeUnservable,
  requirementsForTests,
  servesPool,
  summarisePools,
} = await import('./runners.js');

type Runner = Parameters<typeof assessPool>[2][number];

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const fresh = new Date(NOW - 5_000);
const silent = new Date(NOW - RUNNER_ONLINE_MS - 1_000);

function runner(over: Partial<Runner> & { name: string }): Runner {
  return {
    id: `runner_${over.name}`,
    pools: [],
    capabilities: { browsers: ['chromium'], toolchains: ['node'], testTypes: [] },
    lastSeenAt: fresh,
    revokedAt: null,
    ...over,
  };
}

/** A browser job — what nearly every suite needs. */
const BROWSER = requirementsForTests([{ type: 'E2E' }]);
/** A job that shells out to a binary instead. */
const LOAD = requirementsForTests([{ type: 'LOAD' }]);

describe('assessPool asks its questions in order', () => {
  it('reports an org with no runners at all, not a pool problem', () => {
    const state = assessPool(BROWSER, 'eu', [], NOW);
    expect(state.code).toBe('no-runners');
    expect(state.ready).toBe(false);
  });

  /*
   * The fleet is healthy, online and fully equipped — it just serves a
   * different segment. Telling this operator to install chromium would send
   * them to a machine that already has it.
   */
  it('reports a pool nobody serves, even when the fleet is otherwise perfect', () => {
    const state = assessPool(BROWSER, 'eu', [runner({ name: 'us-01', pools: ['us'] })], NOW);
    expect(state.code).toBe('no-pool-runners');
    expect(state.serving).toEqual([]);
  });

  it('reports silence before it reports missing tools', () => {
    const state = assessPool(
      BROWSER,
      'eu',
      // Offline AND missing chromium. Liveness is the one to say, because
      // installing a browser on a box that is not running fixes nothing.
      [runner({ name: 'eu-01', pools: ['eu'], lastSeenAt: silent, capabilities: {} })],
      NOW,
    );
    expect(state.code).toBe('none-online');
    expect(state.missing).toEqual([]);
    expect(state.serving.map((r) => r.name)).toEqual(['eu-01']);
  });

  it('reports what is missing only once everything else is right', () => {
    const state = assessPool(
      LOAD,
      'eu',
      [runner({ name: 'eu-01', pools: ['eu'], capabilities: { toolchains: ['node'] } })],
      NOW,
    );
    expect(state.code).toBe('missing-capabilities');
    expect(state.missing).toEqual(['the k6 binary']);
  });

  it('is ready when one online runner in the pool can serve the work', () => {
    const state = assessPool(BROWSER, 'eu', [runner({ name: 'eu-01', pools: ['eu'] })], NOW);
    expect(state).toMatchObject({ code: 'ready', ready: true, online: 1, missing: [] });
  });

  /*
   * A revoked runner still has a row — revocation is a timestamp so the audit
   * trail keeps pointing at something — and counting it would tell an org whose
   * only agent was decommissioned that its pool is fine.
   */
  it('ignores revoked runners entirely', () => {
    const state = assessPool(
      BROWSER,
      'eu',
      [runner({ name: 'eu-01', pools: ['eu'], revokedAt: new Date(NOW - 1000) })],
      NOW,
    );
    expect(state.code).toBe('no-runners');
  });
});

describe('fail open', () => {
  /*
   * Nine runners that cannot serve the job and one that can. The whole point of
   * the suppression machinery is that it only fires on positive evidence that
   * NOBODY can — flipping `.some` to `.every` here would start skipping tests
   * that were about to run perfectly well on eu-10.
   */
  it('one capable runner is enough, however many cannot serve', () => {
    const fleet = [
      ...Array.from({ length: 9 }, (_, i) =>
        runner({ name: `eu-0${i}`, pools: ['eu'], capabilities: { browsers: [] } }),
      ),
      runner({ name: 'eu-10', pools: ['eu'], capabilities: { browsers: ['chromium'] } }),
    ];
    expect(assessPool(BROWSER, 'eu', fleet, NOW).code).toBe('ready');
    expect(describeUnservable(BROWSER, 'eu', fleet, NOW)).toBeNull();
    expect(describeDispatch(BROWSER, 'eu', fleet, NOW)).toBeNull();
  });

  /*
   * A runner that names no pools serves every pool in its org. The common
   * deployment is one agent and one pool, and requiring the strings to match on
   * both sides is how a customer's first runner sits idle next to work it could
   * have done.
   */
  it('a runner naming no pools serves a named pool', () => {
    expect(servesPool([], 'eu')).toBe(true);
    expect(assessPool(BROWSER, 'eu', [runner({ name: 'any' })], NOW).code).toBe('ready');
  });

  it('a runner that names pools serves only those', () => {
    expect(servesPool(['us'], 'eu')).toBe(false);
    expect(servesPool(['us', 'eu'], 'eu')).toBe(true);
  });
});

describe('the two sentences never disagree about the facts', () => {
  const fleets: Array<[string, Runner[]]> = [
    ['empty', []],
    ['wrong pool', [runner({ name: 'us-01', pools: ['us'] })]],
    ['offline', [runner({ name: 'eu-01', pools: ['eu'], lastSeenAt: silent })]],
    ['never seen', [runner({ name: 'eu-01', pools: ['eu'], lastSeenAt: null })]],
    ['unequipped', [runner({ name: 'eu-01', pools: ['eu'], capabilities: {} })]],
    ['healthy', [runner({ name: 'eu-01', pools: ['eu'] })]],
  ];

  /*
   * The verdict — "can this pool take this work" — has to be one judgement
   * rendered twice. Two independent implementations would drift, and the drift
   * shows up as an API that warns about a run while the runners screen calls
   * the same pool healthy.
   */
  it.each(fleets)('%s: both agree on whether the pool can take the work', (_label, fleet) => {
    const skipped = describeUnservable(BROWSER, 'eu', fleet, NOW);
    const warned = describeDispatch(BROWSER, 'eu', fleet, NOW);
    expect(warned === null).toBe(skipped === null);
  });

  /*
   * ...and they must still be different sentences. The skip message is written
   * for tests that have already been suppressed; using it at dispatch time
   * would tell someone their brand new run had already failed to execute.
   */
  it('speaks about a queued run in the present, not about tests that never ran', () => {
    const fleet = [runner({ name: 'us-01', pools: ['us'] })];
    const warned = describeDispatch(BROWSER, 'eu', fleet, NOW)!;
    expect(warned).not.toContain('never ran');
    expect(warned).toContain('"eu"');
    // The fix, and the promise that the run will not simply hang.
    expect(warned).toContain('Settings → Runners');
    expect(warned).toContain('15 minutes');

    expect(describeUnservable(BROWSER, 'eu', fleet, NOW)).toContain('never ran');
  });

  it('names what to install rather than which host lacks it', () => {
    const fleet = [
      runner({ name: 'eu-01', pools: ['eu'], capabilities: { toolchains: [] } }),
      runner({ name: 'eu-02', pools: ['eu'], capabilities: { toolchains: [] } }),
    ];
    const warned = describeDispatch(LOAD, 'eu', fleet, NOW)!;
    expect(warned).toContain('the k6 binary');
    // Naming a box invites installing it on the wrong one.
    expect(warned).not.toContain('eu-01');
  });
});

describe('summarisePools', () => {
  const environment = (name: string, runnerPool: string | null) => ({
    id: `env_${name}`,
    projectId: 'proj_1',
    name,
    runnerPool,
  });
  const member = (over: Partial<Runner> & { name: string }) => ({
    ...runner(over),
    lastClaimAt: null as Date | null,
  });

  /*
   * THE case. An environment points at "eu", nothing serves it, and the org's
   * one runner is happily online in another pool. On a list of runners this
   * looks like a healthy fleet; the pool is the only row that can say the run
   * is going nowhere.
   */
  it('shows a pool an environment points at that no runner serves', () => {
    const [pool] = summarisePools({
      runners: [member({ name: 'us-01', pools: ['us'] })],
      environments: [environment('staging', 'eu')],
      jobs: [],
      now: NOW,
    });

    expect(pool!.pool).toBe('eu');
    expect(pool!.ready).toBe(false);
    expect(pool!.runners).toEqual([]);
    expect(pool!.environments.map((e) => e.name)).toEqual(['staging']);
    expect(pool!.note).toContain('No runner serves the "eu" pool');
    expect(pool!.note).toContain('skipped after 15 minutes');
  });

  /*
   * The mirror image, and the state an operator reaches by registering their
   * first runner and stopping. Everything is green and nothing will ever run.
   */
  it('says so when a served pool has nothing routed to it', () => {
    const [pool] = summarisePools({
      runners: [member({ name: 'eu-01', pools: ['eu'] })],
      environments: [environment('staging', null)],
      jobs: [],
      now: NOW,
    });

    expect(pool!.ready).toBe(true);
    expect(pool!.note).toContain('No environment points at the "eu" pool');
  });

  it('counts jobs from the grouped counts, not from the number of groups', () => {
    const [pool] = summarisePools({
      runners: [member({ name: 'eu-01', pools: ['eu'] })],
      environments: [environment('staging', 'eu')],
      jobs: [
        { pool: 'eu', status: 'QUEUED', count: 7 },
        { pool: 'eu', status: 'RUNNING', count: 2 },
        { pool: 'eu', status: 'CLAIMED', count: 1 },
        // Another pool's backlog must not leak into this row.
        { pool: 'us', status: 'QUEUED', count: 99 },
      ],
      now: NOW,
    });

    expect(pool!.pool).toBe('eu');
    expect(pool!.queued).toBe(7);
    expect(pool!.inFlight).toBe(3);
    expect(pool!.note).toContain('7 jobs waiting and 3 in flight');
  });

  /*
   * `lastClaimAt` is the fact the screen had no way to show: online means a
   * process is up, this means it is actually asking for work. An agent wedged
   * after a bad deploy heartbeats and claims nothing.
   */
  it('reports the newest claim across every runner serving the pool', () => {
    const older = new Date(NOW - 600_000);
    const newer = new Date(NOW - 30_000);
    const [pool] = summarisePools({
      runners: [
        { ...member({ name: 'eu-01', pools: ['eu'] }), lastClaimAt: older },
        { ...member({ name: 'eu-02', pools: ['eu'] }), lastClaimAt: newer },
        // Serves everything, so it counts here too.
        { ...member({ name: 'any' }), lastClaimAt: null },
      ],
      environments: [environment('staging', 'eu')],
      jobs: [],
      now: NOW,
    });

    expect(pool!.lastClaimAt).toEqual(newer);
    expect(pool!.runners.map((r) => r.name).sort()).toEqual(['any', 'eu-01', 'eu-02']);
    expect(pool!.runners.find((r) => r.name === 'any')!.servesAll).toBe(true);
  });

  /*
   * The default pool has no name and no environment can point at it, so a row
   * for it is only meaningful once something is actually queued there — an org
   * that has never used on-prem should not be shown an empty row about it.
   */
  it('shows the default pool only when work is queued for it', () => {
    const runners = [member({ name: 'eu-01', pools: ['eu'] })];
    const environments = [environment('staging', 'eu')];

    expect(summarisePools({ runners, environments, jobs: [], now: NOW }).map((p) => p.pool)).toEqual(
      ['eu'],
    );

    expect(
      summarisePools({
        runners,
        environments,
        jobs: [{ pool: null, status: 'QUEUED', count: 1 }],
        now: NOW,
      }).map((p) => p.pool),
    ).toEqual(['eu', null]);

    // A group that exists but is empty is not work.
    expect(
      summarisePools({
        runners,
        environments,
        jobs: [{ pool: null, status: 'QUEUED', count: 0 }],
        now: NOW,
      }).map((p) => p.pool),
    ).toEqual(['eu']);
  });

  it('names every pool anything knows about, from whichever side names it', () => {
    const pools = summarisePools({
      runners: [member({ name: 'us-01', pools: ['us'] })],
      environments: [environment('staging', 'eu')],
      jobs: [{ pool: 'legacy', status: 'QUEUED', count: 1 }],
      now: NOW,
    }).map((p) => p.pool);

    // Sorted, so the screen does not reshuffle on every poll.
    expect(pools).toEqual(['eu', 'legacy', 'us']);
  });

  it('treats a silent runner as a pool nothing is claiming in', () => {
    const [pool] = summarisePools({
      runners: [member({ name: 'eu-01', pools: ['eu'], lastSeenAt: silent })],
      environments: [environment('staging', 'eu')],
      jobs: [{ pool: 'eu', status: 'QUEUED', count: 3 }],
      now: NOW,
    });

    expect(pool!.code).toBe('none-online');
    expect(pool!.online).toBe(0);
    expect(pool!.note).toContain('eu-01');
    expect(pool!.note).toContain('3 jobs are waiting');
  });
});

describe('requirementsForTests', () => {
  /*
   * The requirement is what stops a job being offered to a runner that cannot
   * run it. Getting it wrong in the generous direction sends the job somewhere
   * it reports SKIPPED; in the strict direction it strands the job forever.
   */
  it('asks for a browser for browser-driven types and not for others', () => {
    expect(requirementsForTests([{ type: 'E2E' }]).browsers).toEqual(['chromium']);
    expect(requirementsForTests([{ type: 'API' }]).browsers).toEqual([]);
  });

  it('asks for the binary a type shells out to, named as it is on PATH', () => {
    expect(requirementsForTests([{ type: 'LOAD' }]).toolchains).toEqual(['k6']);
    expect(requirementsForTests([{ type: 'DATABASE' }]).toolchains).toEqual(['psql']);
  });

  it('unions a mixed slice', () => {
    const requirements = requirementsForTests([{ type: 'E2E' }, { type: 'LOAD' }, { type: 'E2E' }]);
    expect(requirements.browsers).toEqual(['chromium']);
    expect(requirements.toolchains).toEqual(['k6']);
    expect([...requirements.testTypes].sort()).toEqual(['E2E', 'LOAD']);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
