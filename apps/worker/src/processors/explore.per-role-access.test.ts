/**
 * THE THREE-ROLE FIXTURE: the per-role path driven end to end, adversarially.
 *
 * WHY A SECOND FILE AND NOT MORE CASES IN explore.test.ts
 *
 * Because that file's `pass()` helper can only produce two answers — ALLOWED
 * with a 200, or REDIRECTED with a 302 to /login. It cannot produce a 403 at
 * all, so FORBIDDEN, the single most valuable cell this axis has, is never
 * exercised through the real path there. Nor can it produce a role that probed
 * a route and a role that did NOT, which is the difference between NOT_PROBED
 * and ALLOWED and is this round's worst available defect.
 *
 * So this file builds the whole scenario from an INJECTED crawl surface and
 * runs `runRolePasses` -> `mergeRolePasses` -> `buildAccessMatrix` ->
 * `accessMatrixFindings` in sequence, which is exactly the chain
 * `processExplore` runs between the browser and the database. Playwright cannot
 * drive a browser here; the point of the injection is that it does not need to.
 *
 *   admin   sees 10 routes
 *   member  sees 6, is FORBIDDEN on 3 and bounced to the login on 1
 *   viewer  sees 4 and NEVER ASKS about the other 6
 */
import { describe, expect, it, vi } from 'vitest';
import type { CrawlOutcome } from '@qaai/agent';
import { EMPTY_FRONTIER, lowerBoundMoreUrls } from '@qaai/shared';
import type { AccessOutcome, FlowMap, FlowNode } from '@qaai/shared';

vi.mock('../context.js', () => ({
  config: { anthropicApiKey: '' },
  connection: {},
  llm: {},
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  prisma: {},
  publishEvent: () => {},
}));
vi.mock('../vault.js', () => ({ secretsFor: async () => ({}) }));
vi.mock('../queues.js', () => ({ enqueueGenerate: async () => {} }));

const { adjudicateUnion, mergeRolePasses, planRolePasses, runRolePasses } = await import(
  './explore.js'
);
const { buildAccessMatrix, accessMatrixFindings } = await import('@qaai/agent');
const { ANONYMOUS_ROLE } = await import('@qaai/shared');

// ─── The application the fixture describes ───────────────────────────────────

const ALL_ROUTES = [
  '/',
  '/login',
  '/dashboard',
  '/profile',
  '/orders',
  '/reports',
  '/settings',
  '/admin',
  '/admin/users',
  '/admin/billing',
];

/** One probe result, as a crawl would have recorded it on the node. */
interface Probe {
  route: string;
  observed: AccessOutcome;
  status: number;
  destinationRoute?: string | null;
}

function allowed(route: string): Probe {
  return { route, observed: 'ALLOWED', status: 200 };
}
function forbidden(route: string): Probe {
  // A 403 page RENDERS, so the crawler's coarse label is ALLOWED and the status
  // is the only evidence. This is the combination the shared table deliberately
  // permits, and the one the sibling fixture cannot express.
  return { route, observed: 'ALLOWED', status: 403 };
}
function bouncedToLogin(route: string): Probe {
  return { route, observed: 'REDIRECTED', status: 302, destinationRoute: '/login' };
}

function nodeFor(role: string, probe: Probe, stateKey: string): FlowNode {
  const walled = probe.destinationRoute === '/login';
  return {
    id: `${role}-${probe.route}`,
    route: probe.route,
    url: `https://app.test${probe.route}`,
    title: probe.route,
    stateKey,
    requiresRoles: [],
    behindAuth: walled,
    forms: [],
    affordances: [],
    screenshotKey: null,
    a11yViolationCount: 0,
    access: [
      {
        role: role === ANONYMOUS_ROLE ? null : role,
        outcome: probe.observed,
        status: probe.status,
        destinationRoute: probe.destinationRoute ?? null,
        basis: 'OBSERVED' as const,
        observedAtIso: '2026-10-24T10:00:00.000Z',
      },
    ],
  };
}

function crawlFor(input: {
  role: string;
  probes: Probe[];
  converged?: boolean;
  unvisitedQueued?: number;
  authWallBounces?: number;
}): CrawlOutcome {
  const frontier = { ...EMPTY_FRONTIER, unvisitedQueued: input.unvisitedQueued ?? 0 };
  const flowMap: FlowMap = {
    projectId: 'p',
    environmentId: 'e',
    version: 1,
    baseUrl: 'https://app.test/',
    // A distinct state digest per role: an admin and a member see different
    // content on /dashboard, so the merge must keep both states of one route.
    nodes: input.probes.map((probe) => nodeFor(input.role, probe, `state-${input.role}`)),
    edges: [],
    journeys: [],
    features: [],
    exploredAt: '2026-10-24T10:00:00.000Z',
    truncatedReason: null,
    frontier: { ...frontier, atLeastMoreUrls: lowerBoundMoreUrls(frontier) },
  };
  return {
    flowMap,
    outcome: input.converged === false ? 'STOPPED' : 'CONVERGED',
    saturation: [],
    interstitial: null,
    stoppedBecause: input.converged === false ? 'the page budget' : null,
    degradationCounts: {
      errorNodeCount: 0,
      loadFailureCount: 0,
      throttledCount: 0,
      tlsFailureCount: 0,
      authWallBounces: input.authWallBounces ?? 0,
    },
  } as unknown as CrawlOutcome;
}

/** What each identity is shown, keyed by the role the pass runs as. */
const SCRIPT: Record<string, Probe[]> = {
  [ANONYMOUS_ROLE]: [allowed('/'), allowed('/login'), bouncedToLogin('/dashboard')],
  admin: ALL_ROUTES.map(allowed),
  member: [
    allowed('/'),
    allowed('/login'),
    allowed('/dashboard'),
    allowed('/profile'),
    allowed('/orders'),
    allowed('/reports'),
    bouncedToLogin('/settings'),
    forbidden('/admin'),
    forbidden('/admin/users'),
    forbidden('/admin/billing'),
  ],
  // Four routes, and the OTHER SIX ARE NEVER ASKED ABOUT. Not refused: not
  // asked. That distinction is the whole point of the fixture.
  viewer: [allowed('/'), allowed('/login'), allowed('/dashboard'), allowed('/profile')],
};

const PROFILES = [
  { id: 'p-admin', name: 'Admin login', kind: 'FORM_LOGIN' as const, role: 'admin' },
  { id: 'p-member', name: 'Member login', kind: 'FORM_LOGIN' as const, role: 'member' },
  { id: 'p-viewer', name: 'Viewer login', kind: 'FORM_LOGIN' as const, role: 'viewer' },
];

/** Runs the real chain. `failLoginFor` makes exactly one role's sign-in fail. */
async function runFixture(
  options: {
    failLoginFor?: string;
    maxRolePasses?: number;
    profiles?: typeof PROFILES;
    stopFor?: string;
  } = {},
) {
  const plan = planRolePasses({
    profiles: options.profiles ?? PROFILES,
    ...(options.maxRolePasses === undefined ? {} : { maxRolePasses: options.maxRolePasses }),
  });
  const passes = await runRolePasses(
    {
      crawl: async (input) => {
        const role = input.role ?? ANONYMOUS_ROLE;
        return crawlFor({
          role,
          probes: SCRIPT[role] ?? [],
          converged: options.stopFor === role ? false : true,
          unvisitedQueued: options.stopFor === role ? 7 : 0,
        });
      },
      signIn: async (identity) =>
        identity.role === options.failLoginFor
          ? {
              ok: false,
              storageState: null,
              message: 'the success locator never appeared',
              failure: {
                kind: 'REJECTED',
                step: 'CREDENTIAL',
                fault: 'THEIRS',
                detail: 'the success locator never appeared',
                unavailable: null,
              },
            }
          : { ok: true, storageState: { cookies: [] }, message: 'signed in', failure: null },
    },
    plan,
  );

  const { merged, report, probes } = mergeRolePasses(passes, passes[0]!.crawl!.flowMap);
  const loginRoutes = ['/login'];
  const matrix = buildAccessMatrix({
    routes: merged.nodes.map((n) => n.route),
    probes,
    loginRoutes,
  });
  const findings = accessMatrixFindings(matrix, { loginRoutes });
  return { plan, passes, merged, report, probes, matrix, findings, loginRoutes };
}

type Matrix = ReturnType<typeof buildAccessMatrix>;

const cellFor = (matrix: Matrix, route: string, role: string) =>
  matrix.cells.find((c) => c.routeTemplate === route && c.role === role);

// ─── Q1: is the union 10 routes with attribution, 10 without, or 20? ─────────

describe('the three-role fixture — the union and its attribution', () => {
  it('is 10 ROUTES with per-role attribution, not 20 and not unattributed', async () => {
        const { merged, matrix } = await runFixture();

    expect(matrix.routes).toEqual([...ALL_ROUTES].sort());
    expect(matrix.routes).toHaveLength(10);
    expect(matrix.roles).toEqual(['<anonymous>', 'admin', 'member', 'viewer']);
    // 10 routes x 4 roles. The denominator this axis finally has.
    expect(matrix.counts.cells).toBe(40);
    expect(matrix.cells).toHaveLength(40);

    // Per-role attribution survives on the nodes: four identities saw
    // /dashboard, so it carries four STATES, and the roles are named.
    const dashboard = merged.nodes.filter((n) => n.route === '/dashboard');
    expect(dashboard.length).toBeGreaterThan(1);
    expect(new Set(merged.nodes.flatMap((n) => n.requiresRoles)).size).toBeGreaterThan(0);
  });

  it('attributes /admin to admin and member only — the viewer never asked', async () => {
    const { matrix } = await runFixture();

    expect(cellFor(matrix, '/admin', 'admin')?.outcome).toBe('ALLOWED');
    expect(cellFor(matrix, '/admin', 'member')?.outcome).toBe('FORBIDDEN');
    expect(cellFor(matrix, '/admin', 'viewer')?.outcome).toBe('NOT_PROBED');
  });
});

// ─── Q2: FORBIDDEN, and NOT_PROBED that must never read as ALLOWED ──────────

describe('a 403 is FORBIDDEN, and a route nobody asked about is NOT_PROBED', () => {
  it('records all three member 403s as FORBIDDEN with the status kept', async () => {
    const { matrix } = await runFixture();

    for (const route of ['/admin', '/admin/users', '/admin/billing']) {
      const cell = cellFor(matrix, route, 'member');
      expect(cell?.outcome).toBe('FORBIDDEN');
      expect(cell?.status).toBe(403);
      expect(cell?.basis).toBe('OBSERVED');
      expect(cell?.probedAtIso).not.toBeNull();
    }
  });

  it('records the one member bounce as REDIRECTED_TO_LOGIN, not FORBIDDEN', async () => {
    const { matrix } = await runFixture();

    const cell = cellFor(matrix, '/settings', 'member');
    expect(cell?.outcome).toBe('REDIRECTED_TO_LOGIN');
    expect(cell?.status).toBe(302);
  });

  it('leaves the SIX routes the viewer never asked about NOT_PROBED — never ALLOWED', async () => {
    const { matrix } = await runFixture();

    const never = ['/orders', '/reports', '/settings', '/admin', '/admin/users', '/admin/billing'];
    for (const route of never) {
      const cell = cellFor(matrix, route, 'viewer');
      expect(cell?.outcome).toBe('NOT_PROBED');
      // THE CELL THAT MUST NOT RENDER AS A VERIFIED BOUNDARY: no status, no
      // destination, no timestamp, and a reason a human can act on.
      expect(cell?.status).toBeNull();
      expect(cell?.finalUrl).toBeNull();
      expect(cell?.probedAtIso).toBeNull();
      expect(cell?.notProbedBecause).not.toBeNull();
    }
    expect(
      matrix.cells
        .filter((c) => c.role === 'viewer' && c.outcome === 'ALLOWED')
        .map((c) => c.routeTemplate),
    ).toEqual(['/', '/dashboard', '/login', '/profile']);
  });

  it('counts the viewer gap and names its reason, rather than leaving a clean column', async () => {
    const { findings } = await runFixture();

    const gap = findings.find((f) => f.kind === 'ROLE_NOT_PROBED' && f.role === 'viewer');
    expect(gap?.severity).toBe('HONESTY');
    expect(gap?.cells).toBe(6);
    expect(gap?.detail).toContain('6 of 10');
  });
});

// ─── Q3: one role's login FAILS ─────────────────────────────────────────────

describe('a login that FAILED is not a role that found no extra surface', () => {
  it('records the failed role as LOGIN_FAILED with a reason and contributes nothing', async () => {
    const { passes, report } = await runFixture({ failLoginFor: 'admin' });

    const admin = passes.find((p) => p.role === 'admin');
    expect(admin?.outcome).toBe('LOGIN_FAILED');
    expect(admin?.contributed).toBe(false);
    expect(admin?.detail).toContain('the success locator never appeared');
    expect(admin?.remedy).not.toBeNull();
    // NOT ZERO. A zero here is the measurement the failure did not make.
    expect(admin?.routesReached).toBeNull();
    expect(report.rolesRefused).toBeGreaterThan(0);
  });

  it('gives the failed role a FULL column of NOT_PROBED cells blaming the login', async () => {
    const { matrix } = await runFixture({ failLoginFor: 'admin' });

    const adminCells = matrix.cells.filter((c) => c.role === 'admin');
    expect(adminCells).toHaveLength(matrix.routes.length);
    expect(adminCells.every((c) => c.outcome === 'NOT_PROBED')).toBe(true);
    expect(adminCells.every((c) => c.notProbedBecause?.includes('LOGIN_FAILED'))).toBe(true);
    expect(adminCells.every((c) => c.notProbedBecause?.includes('undefined'))).toBe(false);
    // And the column is still THERE: dropping it would shrink the denominator
    // so the remaining roles' measured fraction rose on a failed login.
    expect(matrix.roles).toContain('admin');
  });

  it('THE PERCENTAGE TEST: a failed login cannot raise the measured fraction', async () => {
    const healthy = await runFixture();
    const broken = await runFixture({ failLoginFor: 'admin' });

    const fraction = (m: Matrix) => m.counts.measured / m.counts.cells;

    expect(broken.matrix.counts.cells).toBe(healthy.matrix.counts.cells);
    expect(broken.matrix.counts.measured).toBeLessThan(healthy.matrix.counts.measured);
    expect(fraction(broken.matrix)).toBeLessThan(fraction(healthy.matrix));
  });
});

// ─── Q4: the per-role budget, run until it BITES ─────────────────────────────

describe('the per-role budget is disclosed as a COUNT and a REASON', () => {
  it('reports the cap, the overflow count and the reason when the role cap bites', async () => {
    const { plan } = await runFixture({
      profiles: [
        ...PROFILES,
        { id: 'p-owner', name: 'Owner login', kind: 'FORM_LOGIN' as const, role: 'owner' },
        { id: 'p-support', name: 'Support login', kind: 'FORM_LOGIN' as const, role: 'support' },
      ],
      maxRolePasses: 2,
    });

    expect(plan.disclosure.rolesProbed).toBe(2);
    expect(plan.disclosure.rolesDeclared).toBe(5);
    // A FLOOR and never an estimate, plus the lever that produced it.
    expect(plan.disclosure.atLeastMoreRoles).toBe(3);
    expect(plan.disclosure.cappedBy).toBe('MAX_ROLE_PASSES=2');
    expect(plan.disclosure.why).toContain('at least 3 more role(s) exist');
  });

  it('gives every capped-out role a column of NOT_PROBED cells naming the policy', async () => {
    const { matrix } = await runFixture({
      profiles: [
        ...PROFILES,
        { id: 'p-owner', name: 'Owner login', kind: 'FORM_LOGIN' as const, role: 'owner' },
        { id: 'p-support', name: 'Support login', kind: 'FORM_LOGIN' as const, role: 'support' },
      ],
      maxRolePasses: 2,
    });

    for (const role of ['viewer', 'owner', 'support']) {
      const cells = matrix.cells.filter((c) => c.role === role);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.every((c) => c.outcome === 'NOT_PROBED')).toBe(true);
      expect(cells.every((c) => c.notProbedBecause?.includes('SKIPPED_BY_POLICY'))).toBe(true);
    }
  });

  it('discloses a per-role PAGE budget that bit, as a count and a reason', async () => {
    const { passes } = await runFixture({ stopFor: 'member' });

    const member = passes.find((p) => p.role === 'member');
    expect(member?.outcome).toBe('CRAWLED_PARTIAL');
    expect(member?.atLeastMoreRoutes).toBe(7);
    expect(member?.cappedBy).not.toBeNull();
  });
});

// ─── Q5: the two-pass fact ──────────────────────────────────────────────────

describe('THE TWO-PASS TEST: both the anonymous and the authenticated fact', () => {
  it('keeps the anonymous wall evidence AND the authenticated reach for /dashboard', async () => {
    const { merged, matrix } = await runFixture();

    // The anonymous pass was bounced off /dashboard; three identities reached it.
    expect(cellFor(matrix, '/dashboard', ANONYMOUS_ROLE)?.outcome).toBe('REDIRECTED_TO_LOGIN');
    expect(cellFor(matrix, '/dashboard', 'admin')?.outcome).toBe('ALLOWED');

    // behindAuth is true on POSITIVE anonymous evidence, on every state of the
    // route — not false everywhere, which is what a storageState used to cause.
    const dashboard = merged.nodes.filter((n) => n.route === '/dashboard');
    expect(dashboard.length).toBeGreaterThan(1);
    expect(dashboard.every((n) => n.behindAuth)).toBe(true);
    // And a route the anonymous pass was SERVED is not walled.
    expect(merged.nodes.filter((n) => n.route === '/').every((n) => !n.behindAuth)).toBe(true);
  });

  it('does not invent an anonymous refusal for a route the anonymous pass never asked about', async () => {
    const { matrix } = await runFixture();

    const cell = cellFor(matrix, '/admin', ANONYMOUS_ROLE);
    expect(cell?.outcome).toBe('NOT_PROBED');
    expect(cell?.status).toBeNull();
  });
});

// ─── Q6: the acceptance gate was not bypassed ───────────────────────────────

describe('THE ACCEPTANCE GATE: a degraded per-role crawl must not replace a good denominator', () => {
  it('holds the union when it collapses against the last accepted map', async () => {
    const { passes, merged } = await runFixture({ failLoginFor: 'admin' });

    const acceptance = adjudicateUnion({
      passes,
      nodeCount: merged.nodes.length,
      previous: { version: 7, nodeCount: 200 },
    });
    expect(acceptance.state).not.toBe('ACCEPTED');
    expect(acceptance.reasons.join(' ')).not.toBe('');
  });

  it('a pass held on its own contributes no nodes and no cells to the union', async () => {
    const { passes } = await runFixture();
    const held = passes.map((p) =>
      p.role === 'admin' ? { ...p, contributed: false, outcome: 'CRAWLED' as const } : p,
    );

    const { merged, probes } = mergeRolePasses(held, held[0]!.crawl!.flowMap);
    // Not "/admin/billing is absent" — the MEMBER pass reached it with a 403,
    // which is the point of a union. What must be absent is the held pass's own
    // contribution: its distinct state, and every observation it made.
    expect(merged.nodes.some((n) => n.stateKey === 'state-admin')).toBe(false);
    expect(probes.find((p) => p.role === 'admin')?.observations).toHaveLength(0);

    const matrix = buildAccessMatrix({
      routes: merged.nodes.map((n) => n.route),
      probes,
      loginRoutes: ['/login'],
    });
    expect(matrix.cells.filter((c) => c.role === 'admin').every((c) => c.outcome === 'NOT_PROBED'))
      .toBe(true);
  });
});

// ─── Q7: the security finding, and the login route that must not produce one ─

describe('the findings the matrix is FOR', () => {
  it('does NOT report the login page as served-anonymously-refused-to-a-role', async () => {
    const { findings } = await runFixture();

    expect(
      findings.filter(
        (f) => f.kind === 'ANONYMOUS_ALLOWED_BEHIND_WALL' && f.routeTemplate === '/login',
      ),
    ).toHaveLength(0);
  });
});

// ─── The false measurement this round introduced on every login page ─────────

describe('the login page was SERVED, and must not be stored as a bounce to it', () => {
  /*
   * THE DEFECT, NAMED. `mergeRolePasses` fed `cell.destinationRoute ?? node.url`
   * in as the observation's landing URL. `node.url` is `nav.finalUrl` and
   * `loginRoutesFrom` puts every `looksLikeAuthPath` route into the login globs,
   * so a 200 at /login requested AS /login matched the glob and
   * `routeAccessOutcomeFrom` applied its soft-redirect rule: the cell said this
   * role was SENT TO THE LOGIN WALL about the one route that had just been
   * served to it. Every role, every application with a /login — which is every
   * application that has a wall to enumerate behind.
   */
  it('stores /login as ALLOWED for every role that was served it', async () => {
    const { matrix, loginRoutes } = await runFixture();
    expect(loginRoutes).toContain('/login');

    for (const role of [ANONYMOUS_ROLE, 'admin', 'member', 'viewer']) {
      const cell = cellFor(matrix, '/login', role);
      expect(cell?.outcome, `${role} asked for /login and was served it`).toBe('ALLOWED');
      expect(cell?.status).toBe(200);
    }
    expect(matrix.cells.filter((c) => c.routeTemplate === '/login')).toHaveLength(4);
  });

  it('still reads a REAL bounce to the login wall as REDIRECTED_TO_LOGIN', async () => {
    const { matrix } = await runFixture();

    // The anonymous pass asked for /dashboard and landed on /login: a different
    // route, a recorded destination, and the glob test must fire here.
    const anonymous = cellFor(matrix, '/dashboard', ANONYMOUS_ROLE);
    expect(anonymous?.outcome).toBe('REDIRECTED_TO_LOGIN');
    expect(anonymous?.finalUrl).toBe('/login');

    const member = cellFor(matrix, '/settings', 'member');
    expect(member?.outcome).toBe('REDIRECTED_TO_LOGIN');
    expect(member?.finalUrl).toBe('/login');
  });

  it('reports no landing URL on a cell where the browser never moved', async () => {
    const { matrix } = await runFixture();

    // Honest: there is no SECOND url to report, and writing the requested one
    // there is what let the glob test misfire.
    const served = cellFor(matrix, '/profile', 'admin');
    expect(served?.outcome).toBe('ALLOWED');
    expect(served?.finalUrl).toBeNull();
  });
});
