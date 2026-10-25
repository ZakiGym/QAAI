/**
 * `PATCH /projects/:projectId` — THE AUTOPILOT'S ON SWITCH, and the gate rules
 * door beside it.
 *
 * ── The two defects these tests exist for ───────────────────────────────────
 *
 *  1. `Project.coverageTargetPercent` is what arms a closure campaign: the
 *     close-loop sweep looks for projects that have one and ignores every
 *     project that does not. Nothing in the API could set it, so campaigns,
 *     budgets, the closure ledger and the nightly tick were reachable only from
 *     a seed script or a psql prompt. The same was true of
 *     `closureApprovalPolicy` — which decides whether the loop writes code
 *     unattended — and of `closureItemBudget`, which is the money cap.
 *
 *  2. `PUT /projects/:projectId/gate-rules` parses through `gateRuleSchema`,
 *     and that schema was FOUR KINDS BEHIND the TypeScript union: eight of the
 *     twelve `GateRule` kinds could not be saved by any customer. "The rule
 *     exists but cannot be saved" is how that feature shipped broken, so every
 *     kind is round-tripped here — the door is the only place a customer meets
 *     the vocabulary.
 *
 * Harness: the same shape as projects.quarantine.test.ts — a mocked prisma
 * module with a REAL AsyncLocalStorage tenant scope, and the real router driven
 * over a loopback socket. The scope is real because the route's queries run in
 * the async continuation of `withTenant(orgId, () => next())`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSURE_APPROVAL_POLICIES, GATE_RULE_KINDS } from '@qaai/shared';
import type { GateRule } from '@qaai/shared';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null },
  audits: [],
}));

vi.mock('../env.js', () => ({
  env: {
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  },
  isProd: false,
}));

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

/* queues.ts opens an ioredis connection at import time; nothing here enqueues. */
vi.mock('../lib/queues.js', () => ({ enqueue: async () => {} }));

/*
 * Captured, not discarded. Arming the autopilot is the moment a project starts
 * spending model calls with nobody watching, and an audit row that records the
 * rename and not that is not a record of the decision.
 */
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

/**
 * One `Project` row, in the shape this route reads and writes.
 *
 * The three autopilot columns default to NULL, which is the state every
 * existing install is in: nullable rather than defaulted so "this project never
 * asked for an autopilot" and "this project chose 80" stay distinguishable.
 */
function seedProject(over: Row = {}): Row {
  return {
    id: 'proj_1',
    orgId: 'org_1',
    name: 'Storefront',
    slug: 'storefront',
    primaryLanguage: 'TYPESCRIPT',
    primaryFramework: 'PLAYWRIGHT',
    archivedAt: null,
    gateRules: [],
    coverageTargetPercent: null,
    closureApprovalPolicy: null,
    closureItemBudget: null,
    ...over,
  };
}

let store: Row[] = [];

function install(projects: Row[] = [seedProject()]): void {
  store = projects;
  const project = {
    /*
     * A unique lookup cannot carry an extra filter, so — exactly like the real
     * extension — ownership is checked on the RESULT and a row from another org
     * is reported as absent rather than refused. The API must not become an
     * existence oracle.
     */
    findUnique: async (args: Row = {}) => {
      const orgId = h.currentOrg();
      const found = store.find((row) => row.id === args.where?.id);
      if (!found) return null;
      if (orgId && found.orgId !== orgId) return null;
      if (!args.select) return { ...found };
      const out: Row = {};
      for (const [key, want] of Object.entries(args.select))
        if (want === true) out[key] = found[key];
      return out;
    },
    update: async (args: Row = {}) => {
      const orgId = h.currentOrg();
      const found = store.find((row) => row.id === args.where?.id);
      if (!found) throw new Error('fake prisma: no project');
      if (orgId && found.orgId !== orgId) throw new Error('fake prisma: no project found');
      /*
       * Assigned key by key, so a key the route did NOT send is left alone and
       * a key it sent as null is written as null. A fake that merged a whole
       * fixed object would hide the difference between "absent" and "null",
       * which is the difference between "leave the autopilot as it is" and
       * "switch it off".
       */
      Object.assign(found, args.data);
      return { ...found, environments: [], _count: { tests: 0, runs: 0 } };
    },
  };
  h.prisma = { project };
}

const stored = (id = 'proj_1'): Row => store.find((row) => row.id === id)!;

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { projectsRouter } = await import('./projects.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/projects', projectsRouter);
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

const patch = (body: unknown, projectId = 'proj_1') =>
  call('PATCH', `/projects/${projectId}`, body);

const putRules = (rules: unknown, projectId = 'proj_1') =>
  call('PUT', `/projects/${projectId}/gate-rules`, { rules });

beforeEach(() => {
  h.actor = { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null };
  h.audits.length = 0;
  install();
});

// ─── (a) Arming the autopilot ────────────────────────────────────────────────

describe('the closure autopilot, as a setting a customer can reach', () => {
  it('stores all three columns, so the feature is reachable without psql', async () => {
    const { status, body } = await patch({
      coverageTargetPercent: 80,
      closureApprovalPolicy: 'AUTO_APPROVE',
      closureItemBudget: 12,
    });

    expect(status).toBe(200);
    // Echoed…
    expect(body.project).toMatchObject({
      coverageTargetPercent: 80,
      closureApprovalPolicy: 'AUTO_APPROVE',
      closureItemBudget: 12,
    });
    // …and STORED, which is the half that arms the sweep.
    expect(stored()).toMatchObject({
      coverageTargetPercent: 80,
      closureApprovalPolicy: 'AUTO_APPROVE',
      closureItemBudget: 12,
    });
  });

  it('accepts the target on its own, without a name or a language beside it', async () => {
    /*
     * The shared `updateProjectSchema` carries a `.refine` that rejects a body
     * with none of ITS three fields in it. The local schema EXTENDS it rather
     * than restating it, so that refinement now sees all six fields — and a
     * request that only arms the autopilot is a complete request.
     */
    const { status } = await patch({ coverageTargetPercent: 65 });

    expect(status).toBe(200);
    expect(stored().coverageTargetPercent).toBe(65);
    // The rest of the row is untouched.
    expect(stored().name).toBe('Storefront');
    expect(stored().closureItemBudget).toBeNull();
  });

  it('switches the autopilot off on an explicit null', async () => {
    install([seedProject({ coverageTargetPercent: 80, closureItemBudget: 12 })]);

    const { status } = await patch({ coverageTargetPercent: null });

    expect(status).toBe(200);
    // Null is how it is disarmed: the sweep ignores a project without a target.
    expect(stored().coverageTargetPercent).toBeNull();
    // And only the field that was named changed.
    expect(stored().closureItemBudget).toBe(12);
  });

  it('leaves an armed project armed when the body is only a rename', async () => {
    /*
     * The absent-versus-null distinction, from the other side. A spread of
     * `{ coverageTargetPercent: input.coverageTargetPercent }` would clear the
     * target on every rename, which would silently switch the autopilot off for
     * a project whose name somebody tidied up.
     */
    install([
      seedProject({
        coverageTargetPercent: 80,
        closureApprovalPolicy: 'AUTO_APPROVE',
        closureItemBudget: 12,
      }),
    ]);

    const { status } = await patch({ name: 'Storefront (EU)' });

    expect(status).toBe(200);
    expect(stored().name).toBe('Storefront (EU)');
    expect(stored().coverageTargetPercent).toBe(80);
    expect(stored().closureApprovalPolicy).toBe('AUTO_APPROVE');
    expect(stored().closureItemBudget).toBe(12);
  });

  it('still answers "nothing to update" to an empty body', async () => {
    const { status, body } = await patch({});

    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/nothing to update/);
  });
});

// ─── (b) The refusals, each one a way to spend somebody's money ──────────────

describe('the settings a project is not allowed to choose', () => {
  it('refuses a coverage target of zero, which every project already meets', async () => {
    /*
     * A target of 0 is met by every project on earth, so a campaign armed on it
     * would arm and settle in the same tick — indistinguishable from a broken
     * loop. Null is how you mean "no target"; 0 is how you mean nothing.
     */
    const { status, body } = await patch({ coverageTargetPercent: 0 });

    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(stored().coverageTargetPercent).toBeNull();
  });

  it('refuses a coverage target above 100', async () => {
    expect((await patch({ coverageTargetPercent: 101 })).status).toBe(400);
    expect(stored().coverageTargetPercent).toBeNull();
  });

  it('refuses a misspelled approval policy rather than falling back to safe', async () => {
    /*
     * The column is TEXT, so a typo is not a value the database refuses — it is
     * a value `approvalPolicyOf` does not recognise, which falls back to
     * HUMAN_REVIEW. The fallback is the safe direction and that is exactly why
     * it must not be reachable: a team that typed this would believe they had
     * switched unattended generation ON.
     */
    const { status, body } = await patch({ closureApprovalPolicy: 'AUTO_APPROVVE' });

    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(stored().closureApprovalPolicy).toBeNull();
  });

  it.each(CLOSURE_APPROVAL_POLICIES)('accepts the real policy %s', async (policy) => {
    // Validated against the shared vocabulary, so a member added there cannot
    // be a member this door refuses.
    expect((await patch({ closureApprovalPolicy: policy })).status).toBe(200);
    expect(stored().closureApprovalPolicy).toBe(policy);
  });

  it('refuses an item budget of zero or an unbounded one', async () => {
    // The money cap: every item is a model call and eventually a browser, so
    // there is no setting that means "as many as it takes".
    expect((await patch({ closureItemBudget: 0 })).status).toBe(400);
    expect((await patch({ closureItemBudget: 201 })).status).toBe(400);
    expect((await patch({ closureItemBudget: 1.5 })).status).toBe(400);
    expect(stored().closureItemBudget).toBeNull();
  });

  it('refuses a MEMBER: arming an unattended loop is an admin act', async () => {
    h.actor = { userId: 'user_2', orgId: 'org_1', role: 'MEMBER', ip: null };

    expect((await patch({ coverageTargetPercent: 80 })).status).toBe(403);
    expect(stored().coverageTargetPercent).toBeNull();
  });

  it("cannot arm another organisation's project", async () => {
    install([seedProject({ orgId: 'org_2' })]);

    const { status } = await patch({ coverageTargetPercent: 80 });

    // Absent, not refused: the API must not become an existence oracle.
    expect(status).toBe(404);
    expect(stored().coverageTargetPercent).toBeNull();
  });
});

// ─── (c) The audit row ───────────────────────────────────────────────────────

describe('the record of arming the autopilot', () => {
  it('names the change in both directions and flags the arming', async () => {
    await patch({ coverageTargetPercent: 80, closureApprovalPolicy: 'AUTO_APPROVE' });

    expect(h.audits).toHaveLength(1);
    const row = h.audits[0]!;
    expect(row.action).toBe('project.update');
    expect(row.targetId).toBe('proj_1');
    // BEFORE as well as after: "it used to have no target" is the question
    // somebody asks the morning after a night of unattended generation.
    expect(row.metadata.from.coverageTargetPercent).toBeNull();
    expect(row.metadata.to.coverageTargetPercent).toBe(80);
    /*
     * And the moment itself, as its own boolean. An audit log somebody has to
     * diff two numbers in to spot the most consequential change in it is not an
     * audit log.
     */
    expect(row.metadata.closureAutopilot).toMatchObject({
      armed: true,
      disarmed: false,
      approvalPolicy: 'AUTO_APPROVE',
    });
  });

  it('does not claim a project was armed when it already was', async () => {
    install([seedProject({ coverageTargetPercent: 50 })]);

    await patch({ coverageTargetPercent: 80 });

    expect(h.audits[0]!.metadata.closureAutopilot).toMatchObject({
      armed: false,
      disarmed: false,
    });
    expect(h.audits[0]!.metadata.from.coverageTargetPercent).toBe(50);
  });

  it('records the disarming too, and names the default policy by name', async () => {
    install([seedProject({ coverageTargetPercent: 80 })]);

    await patch({ coverageTargetPercent: null });

    expect(h.audits[0]!.metadata.closureAutopilot).toMatchObject({
      armed: false,
      disarmed: true,
      // Null means the documented default rather than "no policy", and the row
      // says which one so a reader does not have to go and look it up.
      approvalPolicy: 'HUMAN_REVIEW (default)',
    });
  });

  it('writes no audit row for a request it refused', async () => {
    await patch({ coverageTargetPercent: 0 });

    expect(h.audits).toEqual([]);
  });
});

// ─── (d) The gate-rules door, now that the schema knows every kind ───────────

/**
 * One minimal valid rule per kind.
 *
 * Written out by hand rather than generated, because the POINT is the shape a
 * customer actually sends: the schema was four kinds behind the union, so eight
 * of these were unsaveable and nothing anywhere said so.
 */
const RULE_BY_KIND: Record<GateRule['kind'], GateRule> = {
  // The four that always existed, and were the only four this door could save.
  BLOCK_ON_VERDICT: { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] },
  MAX_FLAKE_RATE: { kind: 'MAX_FLAKE_RATE', ratePercent: 5, action: 'WARN' },
  MAX_P95_LATENCY_MS: { kind: 'MAX_P95_LATENCY_MS', ms: 600_000, action: 'WARN' },
  MIN_PASS_RATE: { kind: 'MIN_PASS_RATE', ratePercent: 95, action: 'BLOCK' },
  // And the eight that could not be saved by any customer.
  MAX_QUARANTINE_PERCENT: { kind: 'MAX_QUARANTINE_PERCENT', percent: 5, action: 'BLOCK' },
  MIN_COVERAGE: { kind: 'MIN_COVERAGE', percent: 70, action: 'WARN' },
  MIN_PATCH_COVERAGE: { kind: 'MIN_PATCH_COVERAGE', percent: 80, action: 'BLOCK' },
  MIN_MUTATION_SCORE: { kind: 'MIN_MUTATION_SCORE', percent: 60, action: 'WARN' },
  NO_NEW_UNCOVERED_ROUTES: { kind: 'NO_NEW_UNCOVERED_ROUTES', action: 'BLOCK' },
  MAX_FINDINGS: {
    kind: 'MAX_FINDINGS',
    atOrAbove: 'CRITICAL',
    // Empty means every kind, which is why the default is `[]` and not null.
    onlyKinds: [],
    max: 0,
    action: 'BLOCK',
  },
  MAX_VITAL_BREACHES: { kind: 'MAX_VITAL_BREACHES', metric: 'lcpMs', max: 0, action: 'WARN' },
  ENVIRONMENT_AVAILABLE: { kind: 'ENVIRONMENT_AVAILABLE', action: 'WARN' },
};

describe('PUT /projects/:projectId/gate-rules', () => {
  it.each(GATE_RULE_KINDS)('accepts a %s rule and stores it', async (kind) => {
    const rule = RULE_BY_KIND[kind];

    const { status, body } = await putRules([rule]);

    expect(status).toBe(200);
    expect(body.rules).toEqual([rule]);
    // Stored, not only echoed: a door that validates and drops is the same
    // defect wearing a 200.
    expect(stored().gateRules).toEqual([rule]);
  });

  it('has a case here for every kind in the union', async () => {
    /*
     * The guard on this suite itself. A thirteenth kind added to `GateRule`
     * without a rule in `RULE_BY_KIND` fails to COMPILE (the record is keyed on
     * the union), and this assertion catches the other direction — a kind the
     * runtime vocabulary carries that the union does not name.
     */
    expect(Object.keys(RULE_BY_KIND).sort()).toEqual([...GATE_RULE_KINDS].sort());
  });

  it('stores a whole rule list in one request, every kind at once', async () => {
    const rules = GATE_RULE_KINDS.map((kind) => RULE_BY_KIND[kind]);

    const { status, body } = await putRules(rules);

    expect(status).toBe(200);
    expect(body.rules).toHaveLength(rules.length);
    expect(h.audits[0]!.metadata.kinds).toEqual([...GATE_RULE_KINDS]);
  });

  it('refuses a rule whose numbers are out of range rather than storing it', async () => {
    /*
     * A malformed rule must not reach the column: a gate that throws at
     * evaluation time would fail OPEN, which is the one behaviour a deploy gate
     * may never have.
     */
    expect((await putRules([{ kind: 'MIN_COVERAGE', percent: 101, action: 'WARN' }])).status).toBe(
      400,
    );
    expect(
      (await putRules([{ kind: 'MAX_FINDINGS', atOrAbove: 'NOPE', max: 0, action: 'WARN' }]))
        .status,
    ).toBe(400);
    expect(
      (await putRules([{ kind: 'MAX_VITAL_BREACHES', metric: 'LCP', max: 0, action: 'WARN' }]))
        .status,
    ).toBe(400);
    expect((await putRules([{ kind: 'NOT_A_RULE', action: 'BLOCK' }])).status).toBe(400);
    expect(stored().gateRules).toEqual([]);
  });
});
