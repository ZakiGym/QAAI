/**
 * `GET` and `PUT /coverage/:projectId/obligations` — THE OBLIGATION AUDIT'S
 * ONLY PRODUCTION DOOR.
 *
 * ── The defect these tests exist for ────────────────────────────────────────
 *
 * `auditObligationPolicy` in packages/agent/src/coverage.ts was correct,
 * exhaustively proven by packages/agent/src/coverage.obligations.test.ts, and
 * reached by NOTHING ELSE. No coverage report, no endpoint and no screen asked
 * it anything, so the one fact it exists to surface — an obligation that NO
 * test type can ever satisfy — was computable and never computed. That is this
 * repository's signature defect: a barrel export plus a colocated test
 * satisfies the package-exports ratchet, check-wiring cannot see a surface
 * reached only by its own test, and every gate reports green on a module called
 * by nobody.
 *
 * `Project.typeObligationPolicy` had the mirror-image hole: a column with a
 * zod schema, a resolver and a reader, and no write path anywhere in the
 * product — so the audit's only input was one a customer could not produce.
 * These tests drive both halves over a real socket, which is the only thing
 * that proves the routes answer at the URL the web app uses rather than at a
 * prefix a comment swears they are mounted on.
 *
 * Harness: the same shape as coverage.test.ts — a mocked prisma module with a
 * REAL AsyncLocalStorage tenant scope, and the real router driven over a
 * loopback socket. The ADJUDICATION is real, deliberately: it calls no model,
 * and a stubbed audit would make the thing under test unobservable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACE_KINDS } from '@qaai/shared';
import { OBLIGATION_REFUSAL_LIST, OBLIGATION_REFUSALS_OUT_OF_DENOMINATOR } from '@qaai/agent';
import type { ObligationRefusal } from '@qaai/agent';

/**
 * THE COMPILER-ENFORCED PRESENCE RECORD for the refusal union, plus the
 * run-time parity check that keeps it honest.
 *
 * It lives in the test and not in the route deliberately: it has no runtime job
 * — the route publishes `OBLIGATION_REFUSAL_LIST` and
 * `OBLIGATION_REFUSALS_OUT_OF_DENOMINATOR`, both derived in packages/agent from
 * its own presence record — and a constant sitting in a route that nothing
 * reads is the precise defect this whole round exists to remove.
 *
 * What it buys is the thing a list cannot: a FIFTH refusal added in
 * packages/agent fails to TYPECHECK here until somebody states whether it
 * leaves the denominator, and the parity test below fails if the stated answer
 * disagrees with the agent's own. The web panel's four groups, and the
 * "counted / not shed" line on each of them, hang off that one decision.
 */
const REFUSAL_LEAVES_DENOMINATOR: Record<ObligationRefusal, boolean> = {
  IMPOSSIBLE_FOR_AXIS: true,
  NOT_A_DECLARED_TYPE: true,
  UNRUNNABLE_HERE: true,
  /** OURS, so it stays: shedding it would raise a customer's number for our gap. */
  NO_PRODUCER: false,
};

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
  env: Row;
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null },
  audits: [],
  env: {
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    /*
     * EMPTY, and every assertion below holds with it empty. The obligation
     * audit is a total function of the policy, the type declarations and the
     * capability map — no model is invited anywhere on this path, so a
     * deployment with no model key gets the identical answer.
     */
    ANTHROPIC_API_KEY: '',
  },
}));

vi.mock('../env.js', () => ({ env: h.env, isProd: false }));

vi.mock('../lib/logger.js', () => ({
  logger: {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  },
  currentRequestId: () => 'req_test',
  setRequestActor: () => {},
  runWithRequestContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  registerRequestSecrets: () => {},
}));

vi.mock('../lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();
  h.currentOrg = () => store.getStore()?.orgId ?? null;

  return {
    prisma: new Proxy({}, { get: (_t, key: string) => (h.prisma as Row)[key] }),
    withTenant: <T>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

vi.mock('../lib/queues.js', () => ({
  enqueue: async () => 'job_1',
}));

vi.mock('../lib/audit.js', () => ({
  audit: async (input: Row) => {
    h.audits.push(input);
  },
}));

vi.mock('../middleware/auth.js', async () => {
  const { ROLE_RANK } = await import('@qaai/shared');
  const { withTenant } = await import('../lib/prisma.js');
  return {
    requireAuth: (req: Row, _res: Row, next: () => void) => {
      req.actor = { ...h.actor };
      void withTenant(h.actor.orgId, () => next());
    },
    requireRole: (minimum: keyof typeof ROLE_RANK) => (req: Row, res: Row, next: () => void) => {
      if (ROLE_RANK[req.actor.role as keyof typeof ROLE_RANK] < ROLE_RANK[minimum]) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: `Requires ${minimum}` } });
        return;
      }
      next();
    },
    requireScope: () => (_req: Row, _res: Row, next: () => void) => next(),
    actorOf: (req: Row) => req.actor,
  };
});

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

interface Store {
  project: Row[];
  /** `DeploymentCapability` rows, or null to make the table unreadable. */
  capability: Row[] | null;
  /** Every `select` the route asked a project query for, in order. */
  projectSelects: Array<Record<string, true>>;
  /** Every `project.update` the route performed. Empty is the assertion. */
  updates: Row[];
}

let store: Store;

/**
 * `select`, honoured. Returns the whole row when no select is given, exactly as
 * Prisma does, and ONLY the named keys when one is.
 *
 * A select-blind fake makes deleting a field from a query UNDETECTABLE: the
 * loader reads `row.typeObligationPolicy`, a blind fake hands back every column
 * it holds, and a select that no longer asks for it passes anyway. The test
 * `asks the database for the policy column` below leans on this directly.
 */
function pick(row: Row, select: Record<string, true> | undefined): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const key of Object.keys(select)) {
    if (select[key] === true) out[key] = row[key];
  }
  return out;
}

function install(over: Partial<Store> = {}): void {
  store = {
    project: [{ id: 'proj_1', orgId: 'org_1', typeObligationPolicy: null }],
    capability: null,
    projectSelects: [],
    updates: [],
    ...over,
  };

  h.prisma = {
    project: {
      findUnique: async (args: Row = {}) => {
        if (args.select) store.projectSelects.push(args.select as Record<string, true>);
        const orgId = h.currentOrg();
        const found = store.project.find((row) => row.id === args.where?.id);
        if (!found) return null;
        // The tenant extension's job, stood in for here: a row from another org
        // must be indistinguishable from one that does not exist.
        if (orgId && found.orgId !== orgId) return null;
        return pick(found, args.select as Record<string, true> | undefined);
      },
      update: async (args: Row) => {
        const found = store.project.find((row) => row.id === args.where?.id);
        if (!found) throw new Error('P2025');
        store.updates.push(args);
        Object.assign(found, args.data);
        return { ...found };
      },
    },
    deploymentCapability: {
      findMany: async () => {
        /*
         * THROWS when `capability` is null, which is the real shape of the
         * "migration not applied" branch: `deploymentCapabilityFacts` wraps the
         * query in a try/catch and returns null, every type becomes NOT_CHECKED
         * and every obligation STAYS in the denominator. A fake that returned
         * `[]` instead would exercise the wrong branch — an empty table is a
         * probed deployment with no answers, not an absent one.
         */
        if (store.capability === null) throw new Error('relation does not exist');
        return store.capability.map((row) => ({ ...row }));
      },
    },
  };
}

/** A probed deployment: every type AVAILABLE except the ones named. */
function capabilityRows(over: Record<string, string> = {}): Row[] {
  return Object.entries(over).map(([testType, status]) => ({
    testType,
    status,
    detail: `${testType} is ${status} on this image`,
    checkedAt: new Date('2026-10-20T00:00:00.000Z'),
  }));
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { coverageRouter } = await import('./coverage.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

/**
 * MOUNTED AT `/coverage`, exactly as apps/api/src/index.ts mounts it.
 *
 * Driven over a real socket rather than by calling the handler, because a
 * router that declares a relative path and is mounted at the wrong prefix is a
 * 404 with a comment swearing it works — and a direct handler call cannot tell
 * the difference. `mountedElsewhere` below drives the SAME router at a second
 * prefix to prove the relative path is what makes the URL, so the mount line in
 * index.ts is load-bearing rather than decorative.
 */
const app = express();
app.use(express.json());
app.use('/coverage', coverageRouter);
app.use('/elsewhere', coverageRouter);
app.use(notFoundHandler);
app.use(errorHandler);

let baseUrl = '';
let server: import('node:http').Server;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Row }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

const get = (projectId = 'proj_1') => call('GET', `/coverage/${projectId}/obligations`);
const put = (body: unknown, projectId = 'proj_1') =>
  call('PUT', `/coverage/${projectId}/obligations`, body);

/** The same router at a second prefix. Proves the declared path is relative. */
const mountedElsewhere = () => call('GET', '/elsewhere/proj_1/obligations');

const axis = (body: Row, kind: string): Row =>
  (body.axes as Row[]).find((entry) => entry.kind === kind) as Row;

beforeEach(() => {
  h.actor = { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null };
  h.audits.length = 0;
  install();
});

// ─── The mount ───────────────────────────────────────────────────────────────

describe('the mount', () => {
  it('answers under /coverage, which is where the web app asks', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.projectId).toBe('proj_1');
  });

  /*
   * Driven BOTH WAYS, as the register demands before believing a mount: the
   * path these routes declare is relative, so the same router answers at
   * whatever prefix mounts it. If somebody "fixes" the declaration to
   * '/coverage/:projectId/obligations' this goes red at /coverage with a 404
   * while /elsewhere keeps working, which is the exact failure a 404-with-a-
   * confident-comment presents as.
   */
  it('is reachable at any prefix, because its path is relative', async () => {
    const { status, body } = await mountedElsewhere();
    expect(status).toBe(200);
    expect(body.projectId).toBe('proj_1');
  });

  it('404s for a project that is not this org, with no existence oracle', async () => {
    const other = await get('proj_nope');
    expect(other.status).toBe(404);

    store.project[0]!.orgId = 'org_2';
    const foreign = await get();
    expect(foreign.status).toBe(404);
    // Identical envelopes: "not yours" must not be distinguishable from "gone".
    expect(foreign.body).toEqual(other.body);
  });
});

// ─── GET: the audit ──────────────────────────────────────────────────────────

describe('GET /coverage/:projectId/obligations', () => {
  it('tells "never stated" apart from "considered it and owes nothing"', async () => {
    const { body } = await get();
    expect(body.policy).toMatchObject({ declared: false, unreadable: false, byKind: null });
    expect(body.counted).toBe(0);
    expect(body.verdicts).toEqual([]);
    expect(String(body.policy.why)).toContain('never stated');
    // The remedy for recording the OTHER decision is on the payload, because
    // null and {} are different facts and only one of them is a choice.
    expect(String(body.policy.why)).toContain('"byKind":{}');
  });

  it('asks the database for the policy column', async () => {
    await get();
    /*
     * Lesson F, pinned: the fake honours `select`, so if the loader stops
     * selecting `typeObligationPolicy` the audit silently reads `undefined` as
     * "no policy" and every assertion about a declared policy below passes for
     * the wrong reason. This asserts the query that makes them mean anything.
     */
    expect(store.projectSelects).toEqual(expect.arrayContaining([{ typeObligationPolicy: true }]));
  });

  it('reports ROUTE owing a DATABASE test as IMPOSSIBLE, out of the denominator', async () => {
    store.project[0]!.typeObligationPolicy = { byKind: { ROUTE: ['DATABASE'] } };
    const { status, body } = await get();

    expect(status).toBe(200);
    // THE WHOLE POINT. One obligation, permanently un-closeable, and the
    // denominator it would otherwise have grown is 0.
    expect(body.counted).toBe(0);
    expect(body.impossible).toHaveLength(1);
    expect(body.impossible[0]).toMatchObject({
      kind: 'ROUTE',
      type: 'DATABASE',
      counts: false,
      refusal: 'IMPOSSIBLE_FOR_AXIS',
    });
    expect(String(body.impossible[0].why)).toContain('correct the policy');
    // Also in `excluded` — one verdict, two lists, never a silent drop.
    expect((body.excluded as Row[]).map((row) => row.refusal)).toEqual(['IMPOSSIBLE_FOR_AXIS']);
  });

  it('counts an obligation the right type could close, with no capability probe', async () => {
    store.project[0]!.typeObligationPolicy = { byKind: { ROUTE: ['E2E'] } };
    const { body } = await get();

    expect(body.counted).toBe(1);
    expect(body.impossible).toEqual([]);
    expect((body.verdicts as Row[])[0]).toMatchObject({ refusal: null, counts: true });
    // NULL IS NOT ZERO, and NOT_CHECKED is not AVAILABLE: an unprobed
    // deployment keeps the obligation and says the figure is unmeasured.
    expect(body.capability).toMatchObject({ probed: false, measuredAtIso: null });
    expect(String(body.capability.why)).toContain('NOT_CHECKED');
  });

  /*
   * THE SEPARATION THIS SLICE IS FOR. An UNRUNNABLE_HERE obligation leaves the
   * denominator too — same arithmetic as an impossible one — and it is NOT our
   * configuration error: the type is right for the axis, the remedy is to
   * install the tool, and rendering it beside the impossible one would send
   * somebody to edit a policy that is correct.
   */
  it('keeps a type this image cannot run OUT of `impossible`', async () => {
    store.project[0]!.typeObligationPolicy = { byKind: { ROUTE: ['E2E'] } };
    store.capability = capabilityRows({ E2E: 'MISSING' });
    const { body } = await get();

    expect(body.counted).toBe(0);
    expect(body.impossible).toEqual([]);
    expect((body.excluded as Row[]).map((row) => row.refusal)).toEqual(['UNRUNNABLE_HERE']);
    expect(body.capability).toMatchObject({ probed: true });
    expect(body.capability.measuredAtIso).toBe('2026-10-20T00:00:00.000Z');
  });

  it('reads an unparseable stored policy as NO policy and says so', async () => {
    store.project[0]!.typeObligationPolicy = { byKind: 'not an object' };
    const { body } = await get();

    expect(body.policy).toMatchObject({ declared: false, unreadable: true, byKind: null });
    expect(body.counted).toBe(0);
    // Half a policy is a denominator the customer did not configure, so the
    // failure is disclosed rather than partially honoured.
    expect(String(body.policy.why)).toContain('does not parse');
  });

  it('names all four refusals, and which of them leave the denominator', async () => {
    const { body } = await get();
    expect(Object.keys(REFUSAL_LEAVES_DENOMINATOR).sort()).toEqual(
      [...OBLIGATION_REFUSAL_LIST].sort(),
    );
    for (const [refusal, leaves] of Object.entries(REFUSAL_LEAVES_DENOMINATOR)) {
      // Asserted against the WIRE as well as the agent's own list: a payload
      // that re-derived this for itself is caught here rather than on a screen
      // that printed "already accounted for" over genuinely uncovered debt.
      expect(OBLIGATION_REFUSALS_OUT_OF_DENOMINATOR.includes(refusal as ObligationRefusal)).toBe(
        leaves,
      );
      expect((body.outOfDenominator as string[]).includes(refusal)).toBe(leaves);
    }
  });

  it('publishes the whole refusal vocabulary, so a zero is a real zero', async () => {
    const { body } = await get();
    expect(body.refusals).toEqual([...OBLIGATION_REFUSAL_LIST]);
    expect(body.outOfDenominator).toEqual([...OBLIGATION_REFUSALS_OUT_OF_DENOMINATOR]);
    // NO_PRODUCER stays IN the denominator: the gap is ours, and shedding it
    // would raise the customer's number for a shortfall in this product.
    expect(body.outOfDenominator).not.toContain('NO_PRODUCER');
  });
});

// ─── The per-axis view: what could ever discharge an obligation ──────────────

describe('axes', () => {
  it('names every surface kind exactly once', async () => {
    const { body } = await get();
    expect((body.axes as Row[]).map((entry) => entry.kind)).toEqual([...SURFACE_KINDS]);
  });

  /*
   * A DEFECT THIS ENDPOINT FOUND. `typesCovering` answers over
   * `ANY_TEST_TYPES` (thirty, eleven of them pending), and a policy is
   * validated against `TEST_TYPES` (twenty). An editor offered the raw list
   * would offer JOBS and PUSH for a background job and then reject the PUT, so
   * the two lists are kept apart on the wire.
   */
  it('separates the types a policy can name from the ones that only cover the axis', async () => {
    const { body } = await get();
    const job = axis(body, 'BACKGROUND_JOB');
    expect(job.satisfiable).toEqual(['INTEGRATION']);
    expect(job.coversButNotStorable).toEqual(['JOBS', 'PUSH']);
    expect(job.closeable).toBe(true);
    // Disjoint by construction: a type cannot be both offerable and not.
    for (const entry of body.axes as Row[]) {
      for (const type of entry.satisfiable as string[]) {
        expect(entry.coversButNotStorable).not.toContain(type);
      }
    }
  });

  it('marks an axis NO type covers as un-closeable', async () => {
    const { body } = await get();
    // FLAG_COMBINATION is the live example: nothing in the declaration set
    // covers it, so any obligation declared there is eternal debt on day one.
    expect(axis(body, 'FLAG_COMBINATION')).toMatchObject({
      satisfiable: [],
      coversButNotStorable: [],
      closeable: false,
    });
  });

  it('echoes what the policy declared, per axis', async () => {
    store.project[0]!.typeObligationPolicy = { byKind: { ROUTE: ['E2E', 'VISUAL'] } };
    const { body } = await get();
    expect(axis(body, 'ROUTE').declared).toEqual(['E2E', 'VISUAL']);
    expect(axis(body, 'FORM').declared).toEqual([]);
  });
});

// ─── PUT: the door ───────────────────────────────────────────────────────────

describe('PUT /coverage/:projectId/obligations', () => {
  it('stores a policy every obligation of which can be closed', async () => {
    const { status, body } = await put({ byKind: { ROUTE: ['E2E'] } });

    expect(status).toBe(200);
    expect(store.project[0]!.typeObligationPolicy).toEqual({ byKind: { ROUTE: ['E2E'] } });
    expect(body.counted).toBe(1);
    expect(body.policy).toMatchObject({ declared: true, unreadable: false });

    // The write is auditable: it changes a published number for the whole org.
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'coverage.obligations.update',
      targetType: 'Project',
      targetId: 'proj_1',
    });
    // Closed vocabularies only — axis names and type names this server owns.
    expect(h.audits[0]!.metadata).toEqual({
      axes: ['ROUTE'],
      obligations: { ROUTE: ['E2E'] },
      counted: 1,
    });
  });

  it('records "considered it and owes nothing" as a choice', async () => {
    const { status, body } = await put({ byKind: {} });
    expect(status).toBe(200);
    expect(store.project[0]!.typeObligationPolicy).toEqual({ byKind: {} });
    // Declared, therefore NOT the "never stated" sentence — the distinction the
    // nullable column exists for survives the round trip.
    expect(body.policy.declared).toBe(true);
    expect(String(body.policy.why)).not.toContain('never stated');
  });

  /*
   * THE REASON THIS IS A DOOR AND NOT ONLY A REPORT. Telling a customer about
   * eternal debt after they created it is strictly worse than declining to
   * create it, and the refusal has to name WHICH axis and WHICH type or it is a
   * 422 to guess at.
   */
  it('refuses a policy whose obligation no test type could ever satisfy', async () => {
    const { status, body } = await put({ byKind: { ROUTE: ['DATABASE'] } });

    expect(status).toBe(422);
    expect(body.error.code).toBe('UNPROCESSABLE');
    expect(store.updates).toEqual([]);
    expect(store.project[0]!.typeObligationPolicy).toBeNull();

    expect(body.error.details.refused).toHaveLength(1);
    expect(body.error.details.refused[0]).toMatchObject({
      kind: 'ROUTE',
      type: 'DATABASE',
      refusal: 'IMPOSSIBLE_FOR_AXIS',
    });
    // The repair, in the refusal: the types that DO cover a route.
    expect(body.error.details.axes[0].satisfiable).toContain('E2E');
  });

  it('refuses an obligation on an axis no type covers at all', async () => {
    const { status, body } = await put({ byKind: { FLAG_COMBINATION: ['E2E'] } });
    expect(status).toBe(422);
    expect(store.updates).toEqual([]);
    expect(body.error.details.axes[0]).toMatchObject({
      kind: 'FLAG_COMBINATION',
      closeable: false,
    });
  });

  /*
   * THE REFUSAL THAT MUST NOT CLOSE THE DOOR. UNRUNNABLE_HERE is a fact about
   * THIS IMAGE: the type is right for the axis and the obligation returns the
   * moment the tool is installed. Refusing on it would make a policy valid or
   * not depending on which worker answered, and would let a laptop with no
   * browser forbid a policy production can discharge.
   */
  it('accepts a policy this deployment cannot currently run', async () => {
    store.capability = capabilityRows({ E2E: 'MISSING' });
    const { status, body } = await put({ byKind: { ROUTE: ['E2E'] } });

    expect(status).toBe(200);
    expect(store.project[0]!.typeObligationPolicy).toEqual({ byKind: { ROUTE: ['E2E'] } });
    expect((body.excluded as Row[]).map((row) => row.refusal)).toEqual(['UNRUNNABLE_HERE']);
    expect(body.impossible).toEqual([]);
  });

  it('refuses a type that is not a test type, and an axis declared twice over', async () => {
    const unknown = await put({ byKind: { ROUTE: ['NOT_A_TYPE'] } });
    expect(unknown.status).toBe(400);

    // An axis owing the same type twice would count one obligation as two and
    // inflate a denominator the customer configured by hand.
    const duplicate = await put({ byKind: { ROUTE: ['E2E', 'E2E'] } });
    expect(duplicate.status).toBe(400);

    expect(store.updates).toEqual([]);
  });

  it('requires ADMIN, because it moves the number everybody reads', async () => {
    h.actor.role = 'MEMBER';
    const { status } = await put({ byKind: { ROUTE: ['E2E'] } });
    expect(status).toBe(403);
    expect(store.updates).toEqual([]);
  });

  it('404s rather than minting a policy for a project id that is a typo', async () => {
    const { status } = await put({ byKind: { ROUTE: ['E2E'] } }, 'proj_nope');
    expect(status).toBe(404);
    expect(store.updates).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('is deterministic: the same policy audits identically twice', async () => {
    const first = await put({ byKind: { ROUTE: ['E2E'], ENDPOINT: ['API'] } });
    const second = await get();
    // Model-free and total, so the write's own answer and a later read agree
    // field for field — no clock, no cache, no probe in between.
    expect(second.body.verdicts).toEqual(first.body.verdicts);
    expect(second.body.counted).toBe(first.body.counted);
    expect(second.body.counted).toBe(2);
  });
});
