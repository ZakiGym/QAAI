/**
 * Tests for the multi-tenant isolation sweep.
 *
 * This is the check whose false NEGATIVES end companies and whose false
 * POSITIVES end the customer's trust in the product, so almost every test below
 * is about one of the two:
 *
 *  1. NOTHING MEASURED MUST NEVER READ AS A CLEAN SWEEP. One tenant, no
 *     tenancy, no session, no prober, no operations, a production environment,
 *     or a holder session that is not being accepted — each produces an
 *     UNEXERCISABLE or inconclusive report with a reason, `measured: 0`, and a
 *     SKIPPED result carrying `notRun`, so no aggregation can score it.
 *  2. A BROKEN LOGIN MUST NEVER MANUFACTURE A BREACH. With the control refuted,
 *     a 200 on the other tenant's record produces NO finding at all.
 *
 * Then the safety rules, which are not negotiable: a mutating verb is REFUSED
 * and RECORDED, an unreadable verb likewise, and `allowDestructive: true` does
 * not widen either — the policy authorises damaging the environment's own data,
 * not writing across a tenant boundary.
 *
 * And the drift guard: {@link ISOLATION_VERDICTS} is pinned by literal here
 * because the same eight members exist in `packages/agent/src/authz-probe.ts`
 * and the two packages cannot import each other. A change on either side shows
 * up as a one-line diff in this file.
 *
 * No network and no browser: the prober is injected, so the whole sweep runs
 * from a literal table with no socket and no credential anywhere in the file.
 */

import { describe, expect, it } from 'vitest';
import type { ArtifactSink, ExecutableTest, RunContext } from '@qaai/shared';
import {
  CONTROL_STATES,
  ISOLATION_FINDINGS,
  ISOLATION_INCONCLUSIVE,
  ISOLATION_PASSES,
  ISOLATION_VERDICTS,
  ISOLATION_VERDICT_LABELS,
  ISOLATION_VERDICT_LIST,
  NOT_PROBED_REASON_LIST,
  TENANCY_REFUSAL_REASON_LIST,
  UNEXERCISABLE_REASON_LIST,
  classifyIsolation,
  controlStateFrom,
  hasAnyParameter,
  holderHasSession,
  measureTenancy,
  runTenancyTest,
  substituteId,
  summariseTenancy,
  tenancyFindings,
  tenancyPlugin,
  tenancySweepSpecSchema,
  unavailableTenancyProber,
  type TenancyObservation,
  type TenancyProber,
  type TenancySweepSpec,
} from './tenancy.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function spec(overrides: Partial<TenancySweepSpec> = {}): TenancySweepSpec {
  return tenancySweepSpecSchema.parse({
    holder: { principal: 'tenantAAdmin', tenantId: 'org_a', tenantLabel: 'Acme' },
    subject: { principal: 'tenantBAdmin', tenantId: 'org_b', tenantLabel: 'Globex' },
    operations: [
      { method: 'GET', pathTemplate: '/api/invoices/{invoiceId}' },
      { method: 'GET', pathTemplate: '/api/orders/:orderId' },
    ],
    subjectIds: [
      {
        parameter: 'invoiceId',
        value: 'inv_b1',
        observedIn: 'GET /api/invoices as tenantBAdmin',
        evidence: 'Globex Industries',
      },
      { parameter: 'orderId', value: 'ord_b7', observedIn: 'GET /api/orders as tenantBAdmin' },
    ],
    controlId: {
      parameter: 'invoiceId',
      value: 'inv_a1',
      observedIn: 'GET /api/invoices as tenantAAdmin',
      evidence: 'Acme Corp',
    },
    environmentKind: 'STAGING',
    ...overrides,
  });
}

/** A prober answering from a table, recording what it was asked and as whom. */
function fakeProber(
  table: Record<string, Partial<TenancyObservation>>,
  fallback: Partial<TenancyObservation> = { status: 403 },
): TenancyProber & { readonly asked: Array<{ path: string; asPrincipal: string }> } {
  const asked: Array<{ path: string; asPrincipal: string }> = [];
  return {
    asked,
    probe(request) {
      asked.push({ path: request.path, asPrincipal: request.asPrincipal });
      const hit = table[request.path] ?? fallback;
      return Promise.resolve({
        status: hit.status ?? null,
        evidenceFound: hit.evidenceFound ?? null,
      });
    },
  };
}

/** The control succeeds; everything else refuses. The healthy baseline. */
const HEALTHY = { '/api/invoices/inv_a1': { status: 200, evidenceFound: true } };

function sweep(
  overrides: Partial<TenancySweepSpec> = {},
  table: Record<string, Partial<TenancyObservation>> = HEALTHY,
  options: { holderHasSession?: boolean; proberConfigured?: boolean; cancelled?: () => boolean } = {},
) {
  return measureTenancy(spec(overrides), {
    prober: fakeProber(table),
    proberConfigured: options.proberConfigured ?? true,
    holderHasSession: options.holderHasSession ?? true,
    cancelled: options.cancelled,
  });
}

const artifacts: ArtifactSink = {
  put: async () => 'key',
  putFile: async () => 'key',
  get: async () => null,
  putPersistent: async () => 'key',
};

/**
 * A session for one principal. The storage state is an empty cookie jar: what
 * matters to this plugin is only whether a session EXISTS, since the prober
 * resolves the real one from the principal's name.
 */
function session(name: string, tenantId: string) {
  return {
    principal: {
      name,
      kind: 'PERSISTENT' as const,
      lifecycle: 'ACTIVE' as const,
      role: 'admin',
      authProfileId: `prof_${tenantId}`,
      authProfileKind: null,
      tenant: { id: tenantId, label: null },
      createdByScenario: null,
    },
    storageState: { cookies: [] },
    expiresAtIso: null,
  };
}

function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl: 'https://staging.app.test',
    secrets: {},
    storageState: { cookies: [] },
    /*
     * TWO sessions, which is the whole reason this plugin can exist. The legacy
     * single `storageState` above is kept and is NOT what the sweep reads: a
     * holder named `tenantAAdmin` must resolve from the principal map, or the
     * sweep would run as whichever identity the run happened to have.
     */
    sessions: {
      tenantAAdmin: session('tenantAAdmin', 'org_a'),
      tenantBAdmin: session('tenantBAdmin', 'org_b'),
    },
    artifacts,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      step: () => undefined,
    },
    signal: new AbortController().signal,
    determinism: {
      freezeClockAt: null,
      randomSeed: 1,
      waitForNetworkIdle: false,
      retryOnce: false,
    },
    ...overrides,
  };
}

function test(specValue: unknown): ExecutableTest {
  return {
    id: 'test_1',
    name: 'tenant isolation across the invoice API',
    type: 'API',
    code: '',
    filePath: 'specs/tenancy.json',
    spec: specValue,
    timeoutMs: 60_000,
    quarantined: false,
    tags: [],
  };
}

// ─── The drift guard ─────────────────────────────────────────────────────────

describe('the verdict vocabulary', () => {
  it('is pinned by literal, because the agent holds a second copy of it', () => {
    /*
     * `AUTHZ_VERDICTS` in packages/agent/src/authz-probe.ts has these eight
     * members, spelled identically. packages/runner and packages/agent cannot
     * import each other, so this literal is the only place a drift between them
     * becomes visible. If this test is edited, edit the sibling too — or do the
     * consolidation into packages/shared/src/principals.ts that the handover
     * names.
     */
    expect([...ISOLATION_VERDICTS]).toEqual([
      'LEAKED',
      'LEAKED_UNVERIFIED',
      'SERVED_BUT_SCOPED',
      'DENIED',
      'INCONCLUSIVE_SESSION',
      'INCONCLUSIVE_NO_ANSWER',
      'NOT_PROBED',
      'REFUSED',
    ]);
    expect(ISOLATION_VERDICT_LIST).toEqual([...ISOLATION_VERDICTS]);
    expect([...CONTROL_STATES]).toEqual(['CONFIRMED_LIVE', 'REFUTED', 'NOT_ATTEMPTED']);
  });

  it('partitions every verdict into exactly one of finding, pass and inconclusive', () => {
    for (const verdict of ISOLATION_VERDICT_LIST) {
      const regions = [
        (ISOLATION_FINDINGS as readonly string[]).includes(verdict),
        (ISOLATION_PASSES as readonly string[]).includes(verdict),
        (ISOLATION_INCONCLUSIVE as readonly string[]).includes(verdict),
      ].filter(Boolean);
      expect(regions, verdict).toHaveLength(1);
      expect(ISOLATION_VERDICT_LABELS[verdict].length, verdict).toBeGreaterThan(10);
    }
  });

  it('keeps NOT_PROBED and REFUSED out of the passing set', () => {
    expect(ISOLATION_PASSES).toEqual(['DENIED', 'SERVED_BUT_SCOPED']);
    expect(ISOLATION_PASSES).not.toContain('NOT_PROBED');
    expect(ISOLATION_PASSES).not.toContain('REFUSED');
  });
});

// ─── A broken session can never read as a verified boundary ──────────────────

describe('a refuted control makes the whole sweep inconclusive', () => {
  it('marks every verdict INCONCLUSIVE_SESSION whatever the status', () => {
    for (const status of [200, 204, 302, 401, 403, 404, 429, 500, null]) {
      expect(
        classifyIsolation({
          control: 'REFUTED',
          observation: { status, evidenceFound: status === 200 ? true : null },
        }),
        `status ${String(status)}`,
      ).toBe('INCONCLUSIVE_SESSION');
    }
  });

  it('confirms the control only on a 2xx, never on a redirect to a login page', () => {
    expect(controlStateFrom({ status: 200, evidenceFound: true }).state).toBe('CONFIRMED_LIVE');
    expect(controlStateFrom({ status: 302, evidenceFound: null }).state).toBe('REFUTED');
    expect(controlStateFrom(null).state).toBe('NOT_ATTEMPTED');
    expect(controlStateFrom(null).detail).toContain('supply one id the holder owns');
  });

  it('produces NO FINDING when the control is refuted and the probe "succeeded"', async () => {
    const measurement = await sweep({}, {
      // The control fails...
      '/api/invoices/inv_a1': { status: 401 },
      // ...and the other tenant's record comes back with their data in it.
      '/api/invoices/inv_b1': { status: 200, evidenceFound: true },
    });
    expect(measurement.control?.state).toBe('REFUTED');
    expect(measurement.operations[0]?.verdict).toBe('INCONCLUSIVE_SESSION');
    // A CRITICAL breach manufactured out of a broken login is how a customer
    // stops believing the whole product.
    expect(tenancyFindings(measurement)).toEqual([]);
    expect(measurement.measured).toBe(0);
  });

  it('cannot say the boundary held when nothing was measured', async () => {
    const measurement = await sweep({}, { '/api/invoices/inv_a1': { status: 401 } });
    const summary = summariseTenancy(measurement);
    expect(summary).toContain('Tenant isolation was NOT measured');
    expect(summary).toContain('every verdict is inconclusive');
    expect(summary).not.toMatch(/held|verified/i);
  });

  it('still sweeps every operation, so the report says WHY forty times', async () => {
    const measurement = await sweep({}, { '/api/invoices/inv_a1': { status: 401 } });
    expect(measurement.operations).toHaveLength(2);
    expect(measurement.operations.every((row) => row.verdict === 'INCONCLUSIVE_SESSION')).toBe(
      true,
    );
    expect(measurement.operations[0]?.detail).toContain('Re-establish the session');
  });

  it('runs no sweep at all with NO control id, and says the session was never proved', async () => {
    const measurement = await sweep({ controlId: null });
    expect(measurement.control?.state).toBe('NOT_ATTEMPTED');
    expect(measurement.measured).toBe(0);
    expect(summariseTenancy(measurement)).toContain('NOT measured');
  });

  it('exercises the control against a real record endpoint, not a health check', async () => {
    const prober = fakeProber(HEALTHY);
    await measureTenancy(spec(), {
      prober,
      proberConfigured: true,
      holderHasSession: true,
    });
    // The control has to go through the same authorization code the sweep will,
    // or a 200 on /health would "confirm" a session that can read nothing.
    expect(prober.asked[0]).toEqual({
      path: '/api/invoices/inv_a1',
      asPrincipal: 'tenantAAdmin',
    });
  });
});

// ─── Nothing measured never reads as a clean sweep ───────────────────────────

describe('UNEXERCISABLE is an absence with a reason, never a pass', () => {
  it('refuses a sweep of one tenant against itself', async () => {
    const measurement = await sweep({
      subject: { principal: 'other', tenantId: 'org_a', tenantLabel: 'Acme' },
    });
    expect(measurement.unexercisable?.reason).toBe('SINGLE_TENANT');
    expect(measurement.operations).toEqual([]);
    expect(measurement.measured).toBe(0);
    expect(measurement.unexercisable?.detail).toContain('Seed a second tenant');
  });

  it('refuses when either side has no tenant at all', async () => {
    const measurement = await sweep({
      subject: { principal: 'other', tenantId: null, tenantLabel: null },
    });
    expect(measurement.unexercisable?.reason).toBe('NO_TENANCY');
  });

  it('refuses a production environment outright', async () => {
    const measurement = await sweep({ environmentKind: 'PRODUCTION' });
    expect(measurement.unexercisable?.reason).toBe('PRODUCTION_NOT_PERMITTED');
    // The remedy, and the reason: a cross-tenant probe on production is aimed
    // at real customers' records.
    expect(measurement.unexercisable?.detail).toContain('real customers');
    expect(measurement.unexercisable?.detail).toContain('staging');
  });

  it('refuses when the holder has no session', async () => {
    const measurement = await sweep({}, HEALTHY, { holderHasSession: false });
    expect(measurement.unexercisable?.reason).toBe('NO_HOLDER_SESSION');
  });

  it('reports an empty inventory rather than a clean sweep of nothing', async () => {
    const measurement = await sweep({ operations: [] });
    expect(measurement.unexercisable?.reason).toBe('NO_OPERATIONS');
  });

  it('reports a missing prober BEFORE anything else, because every verdict would be a fake', async () => {
    const measurement = await sweep({}, HEALTHY, { proberConfigured: false });
    expect(measurement.unexercisable?.reason).toBe('NO_PROBER');
    expect(measurement.unexercisable?.detail).toContain('not a clean result');
  });

  it('ships a prober that measures nothing and says so, rather than faking a refusal', async () => {
    const observation = await unavailableTenancyProber.probe({
      asPrincipal: 'tenantAAdmin',
      method: 'GET',
      path: '/api/invoices/inv_b1',
      lookFor: null,
    });
    // `{ status: 403 }` would have declared every tenant boundary in the
    // product sound on the strength of a stub.
    expect(observation.status).toBeNull();
    expect(observation.evidenceFound).toBeNull();
  });

  it('can actually produce every unexercisable reason it declares', async () => {
    const produced = new Set<string>();
    const collect = async (
      overrides: Partial<TenancySweepSpec>,
      options?: Parameters<typeof sweep>[2],
    ): Promise<void> => {
      const measurement = await sweep(overrides, HEALTHY, options);
      if (measurement.unexercisable !== null) produced.add(measurement.unexercisable.reason);
    };
    await collect({}, { proberConfigured: false });
    await collect({ environmentKind: 'PRODUCTION' });
    await collect({ subject: { principal: 'o', tenantId: null, tenantLabel: null } });
    await collect({ subject: { principal: 'o', tenantId: 'org_a', tenantLabel: null } });
    await collect({}, { holderHasSession: false });
    await collect({ operations: [] });
    expect([...produced].sort()).toEqual([...UNEXERCISABLE_REASON_LIST].sort());
  });
});

// ─── Safety: read-only, safe-verb, always ────────────────────────────────────

describe('the sweep is read-only and safe-verb, always', () => {
  it('REFUSES and RECORDS every verb that could change the other tenant’s data', async () => {
    const measurement = await sweep({
      operations: [
        { method: 'POST', pathTemplate: '/api/invoices/{invoiceId}', operationId: null },
        { method: 'PUT', pathTemplate: '/api/invoices/{invoiceId}', operationId: null },
        { method: 'PATCH', pathTemplate: '/api/invoices/{invoiceId}', operationId: null },
        { method: 'DELETE', pathTemplate: '/api/invoices/{invoiceId}', operationId: null },
      ],
    });
    expect(measurement.operations.map((row) => row.verdict)).toEqual([
      'REFUSED',
      'REFUSED',
      'REFUSED',
      'REFUSED',
    ]);
    for (const row of measurement.operations) {
      expect(row.refusalReason).toBe('UNSAFE_VERB');
      // RECORDED, so the report says "this check was not performed and why"
      // rather than the operation silently vanishing from the sweep.
      expect(row.detail).toContain('NOT');
      expect(row.detail).toContain('read-only');
    }
    expect(measurement.counts.REFUSED).toBe(4);
    expect(measurement.measured).toBe(0);
  });

  it('does NOT widen when the crawl policy allows destructive steps', async () => {
    const measurement = await sweep({
      operations: [{ method: 'DELETE', pathTemplate: '/api/invoices/{invoiceId}', operationId: null }],
      crawlPolicy: { allowDestructive: true, destructiveAllowGlobs: ['/api/**'] },
    });
    // The policy authorises damaging THIS environment's data. It is not a
    // permission to write across a tenant boundary, and no field grants that.
    expect(measurement.operations[0]?.verdict).toBe('REFUSED');
    expect(measurement.operations[0]?.refusalReason).toBe('UNSAFE_VERB');
  });

  it('REFUSES a verb it could not read, rather than assuming GET', async () => {
    const measurement = await sweep({
      operations: [{ method: 'UNKNOWN', pathTemplate: '/api/invoices/{invoiceId}', operationId: null }],
    });
    expect(measurement.operations[0]?.refusalReason).toBe('UNREADABLE_VERB');
    expect(measurement.operations[0]?.detail).toContain('could issue a write');
  });

  it('can actually produce every refusal reason it declares', async () => {
    const measurement = await sweep({
      operations: [
        { method: 'DELETE', pathTemplate: '/api/invoices/{invoiceId}', operationId: null },
        { method: 'UNKNOWN', pathTemplate: '/api/invoices/{invoiceId}', operationId: null },
      ],
    });
    const produced = measurement.operations
      .map((row) => row.refusalReason)
      .filter((reason): reason is NonNullable<typeof reason> => reason !== null);
    expect([...new Set(produced)].sort()).toEqual([...TENANCY_REFUSAL_REASON_LIST].sort());
  });

  it('never asks as the subject principal, and never holds a token', async () => {
    const prober = fakeProber(HEALTHY);
    const measurement = await measureTenancy(spec(), {
      prober,
      proberConfigured: true,
      holderHasSession: true,
    });
    expect(prober.asked.every((request) => request.asPrincipal === 'tenantAAdmin')).toBe(true);

    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        keys.add(key.toLowerCase());
        walk(child);
      }
    };
    walk(measurement);
    for (const forbidden of ['token', 'cookie', 'cookies', 'storagestate', 'password', 'secret', 'headers']) {
      expect([...keys], forbidden).not.toContain(forbidden);
    }
  });

  it('is INCAPABLE of carrying a credential in its spec', () => {
    const parsed = tenancySweepSpecSchema.safeParse({
      ...JSON.parse(JSON.stringify(spec())),
      holderToken: 'eyJhbGciOi',
    });
    // `.strict()` REFUSES rather than dropping. A dropped secret is a secret the
    // sender still believes was stored, and it reached our logs on the way out.
    expect(parsed.success).toBe(false);
  });
});

// ─── NOT_PROBED is distinct from PASSED, and always carries a reason ─────────

describe('NOT_PROBED, with the reason', () => {
  it('names an operation with no parameter as OUR gap, not a clean result', async () => {
    const measurement = await sweep({
      operations: [{ method: 'GET', pathTemplate: '/api/invoices', operationId: null }],
    });
    const row = measurement.operations[0];
    expect(row?.verdict).toBe('NOT_PROBED');
    expect(row?.notProbedReason).toBe('NO_PARAMETER_TO_SUBSTITUTE');
    expect(row?.detail).toContain('gap in what QAAI observed');
    expect(measurement.measured).toBe(0);
  });

  it('names an operation with no observed id for its parameter', async () => {
    const measurement = await sweep({
      operations: [{ method: 'GET', pathTemplate: '/api/widgets/{widgetId}', operationId: null }],
    });
    expect(measurement.operations[0]?.notProbedReason).toBe('NO_SUBJECT_ID_FOR_PARAMETER');
    expect(measurement.operations[0]?.detail).toContain('crawl as the second tenant');
  });

  it('honours the crawl policy’s exclude globs and says it did', async () => {
    const measurement = await sweep({ crawlPolicy: { excludeGlobs: ['/api/orders/**'] } });
    const orders = measurement.operations.find((row) =>
      row.pathTemplate.startsWith('/api/orders'),
    );
    expect(orders?.notProbedReason).toBe('EXCLUDED_BY_POLICY');
    expect(orders?.detail).toContain('not a measurement');
    expect(measurement.policyOverrides).toContain('excludeGlobs');
  });

  it('honours an include list, and treats an empty one as everything', async () => {
    const narrowed = await sweep({ crawlPolicy: { includeGlobs: ['/api/invoices/**'] } });
    expect(
      narrowed.operations.find((row) => row.pathTemplate.startsWith('/api/orders'))
        ?.notProbedReason,
    ).toBe('EXCLUDED_BY_POLICY');

    const wide = await sweep();
    expect(wide.operations.every((row) => row.notProbedReason !== 'EXCLUDED_BY_POLICY')).toBe(
      true,
    );
  });

  it('DISCLOSES a budget cap as a count and a reason', async () => {
    const uncapped = await sweep();
    expect(uncapped.omittedByCap).toBe(0);
    expect(uncapped.capReason).toBeNull();

    const capped = await sweep({ limit: 1 });
    expect(capped.omittedByCap).toBe(1);
    expect(capped.capReason).toContain('at least that many more');
    expect(capped.operations.filter((row) => row.notProbedReason === 'BUDGET_SPENT')).toHaveLength(
      1,
    );
    expect(summariseTenancy(capped)).toContain('not probed');
  });

  it('records a cancellation as NOT_PROBED on the operations it never reached', async () => {
    let calls = 0;
    const measurement = await sweep({}, HEALTHY, {
      cancelled: () => {
        calls += 1;
        return calls > 1;
      },
    });
    const cancelledRows = measurement.operations.filter(
      (row) => row.notProbedReason === 'CANCELLED',
    );
    expect(cancelledRows.length).toBeGreaterThan(0);
  });

  it('can actually produce every not-probed reason it declares', async () => {
    const produced = new Set<string>();
    const collect = async (
      overrides: Partial<TenancySweepSpec>,
      options?: Parameters<typeof sweep>[2],
    ): Promise<void> => {
      const measurement = await sweep(overrides, HEALTHY, options);
      for (const row of measurement.operations) {
        if (row.notProbedReason !== null) produced.add(row.notProbedReason);
      }
    };
    await collect({ operations: [{ method: 'GET', pathTemplate: '/api/invoices', operationId: null }] });
    await collect({
      operations: [{ method: 'GET', pathTemplate: '/api/widgets/{widgetId}', operationId: null }],
    });
    await collect({ crawlPolicy: { excludeGlobs: ['/api/**'] } });
    await collect({ limit: 1 });
    let calls = 0;
    await collect({}, {
      cancelled: () => {
        calls += 1;
        return calls > 1;
      },
    });
    expect([...produced].sort()).toEqual([...NOT_PROBED_REASON_LIST].sort());
  });

  it('writes a reason on EXACTLY the NOT_PROBED and REFUSED rows, in both directions', async () => {
    const measurement = await sweep({
      operations: [
        { method: 'GET', pathTemplate: '/api/invoices/{invoiceId}', operationId: null },
        { method: 'GET', pathTemplate: '/api/invoices', operationId: null },
        { method: 'DELETE', pathTemplate: '/api/invoices/{invoiceId}', operationId: null },
      ],
    });
    for (const row of measurement.operations) {
      expect(row.notProbedReason === null, row.pathTemplate).toBe(row.verdict !== 'NOT_PROBED');
      expect(row.refusalReason === null, row.pathTemplate).toBe(row.verdict !== 'REFUSED');
      // And no row is ever a bare verdict: a gap with no sentence beside it is
      // the thing this product sells rendered as a shrug.
      expect(row.detail.length, row.pathTemplate).toBeGreaterThan(20);
    }
  });
});

// ─── The leak itself ─────────────────────────────────────────────────────────

describe('detecting the leak', () => {
  it('reports a verified cross-tenant read as CRITICAL', async () => {
    const measurement = await sweep({}, {
      ...HEALTHY,
      '/api/invoices/inv_b1': { status: 200, evidenceFound: true },
    });
    expect(measurement.operations[0]?.verdict).toBe('LEAKED');
    const findings = tenancyFindings(measurement);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('CRITICAL');
    expect(findings[0]?.code).toBe('cross-tenant-read');
    // The message names both tenants by LABEL, because an opaque id tells a
    // reader nothing — and never a token.
    expect(findings[0]?.message).toContain('Globex');
    expect(findings[0]?.message).toContain('Acme');
  });

  it('downgrades an unverified read to SERIOUS rather than overclaiming', async () => {
    const measurement = await sweep({}, {
      ...HEALTHY,
      // No evidence was observed for ord_b7, so the body cannot be checked.
      '/api/orders/ord_b7': { status: 200 },
      '/api/invoices/inv_b1': { status: 403 },
    });
    const row = measurement.operations.find((r) => r.pathTemplate.startsWith('/api/orders'));
    expect(row?.verdict).toBe('LEAKED_UNVERIFIED');
    expect(tenancyFindings(measurement)[0]?.severity).toBe('SERIOUS');
  });

  it('treats a correctly scoped 200 as a pass, distinct from a refusal', async () => {
    const measurement = await sweep({}, {
      ...HEALTHY,
      '/api/invoices/inv_b1': { status: 200, evidenceFound: false },
    });
    expect(measurement.operations[0]?.verdict).toBe('SERVED_BUT_SCOPED');
    expect(tenancyFindings(measurement)).toEqual([]);
    expect(measurement.measured).toBeGreaterThan(0);
  });

  it('counts a denial as measured and says the boundary held', async () => {
    const measurement = await sweep();
    expect(measurement.operations.map((row) => row.verdict)).toEqual(['DENIED', 'DENIED']);
    expect(measurement.measured).toBe(2);
    expect(summariseTenancy(measurement)).toContain('2 of 2 operation(s) measured');
    expect(summariseTenancy(measurement)).toContain('boundary(ies) held');
  });

  it('never counts a 429 or a 5xx as a held boundary', async () => {
    const measurement = await sweep({}, {
      ...HEALTHY,
      '/api/invoices/inv_b1': { status: 429 },
      '/api/orders/ord_b7': { status: 503 },
    });
    expect(measurement.operations.every((r) => r.verdict === 'INCONCLUSIVE_NO_ANSWER')).toBe(true);
    expect(measurement.measured).toBe(0);
  });
});

// ─── Substitution ────────────────────────────────────────────────────────────

describe('substituteId', () => {
  it('handles both dialects the inventory actually holds', () => {
    // An OpenAPI document writes the first and a source detector the second. A
    // substituter that knew only one would report a whole source's worth of
    // endpoints as a gap in the customer's crawl rather than in our parser.
    expect(substituteId('/api/invoices/{invoiceId}', 'invoiceId', 'inv_1')).toBe(
      '/api/invoices/inv_1',
    );
    expect(substituteId('/api/invoices/:invoiceId', 'invoiceId', 'inv_1')).toBe(
      '/api/invoices/inv_1',
    );
  });

  it('does not match a longer parameter that merely starts the same way', () => {
    expect(substituteId('/api/invoices/:invoiceIdentifier', 'invoiceId', 'x')).toBeNull();
  });

  it('returns null when there is nowhere to put the id', () => {
    expect(substituteId('/api/invoices', 'invoiceId', 'inv_1')).toBeNull();
    expect(substituteId('/api/orders/{orderId}', 'invoiceId', 'inv_1')).toBeNull();
  });

  it('encodes the value, so a traversal id cannot change which endpoint is asked', () => {
    expect(substituteId('/api/invoices/{invoiceId}', 'invoiceId', '../../admin')).toBe(
      '/api/invoices/..%2F..%2Fadmin',
    );
  });

  it('knows a template with a parameter from one without', () => {
    expect(hasAnyParameter('/api/invoices/{id}')).toBe(true);
    expect(hasAnyParameter('/api/invoices/:id')).toBe(true);
    expect(hasAnyParameter('/api/invoices')).toBe(false);
  });
});

// ─── The plugin ──────────────────────────────────────────────────────────────

describe('tenancyPlugin', () => {
  it('waits in the registry under a TestType nobody has minted yet', () => {
    expect(tenancyPlugin.type).toBe('TENANCY');
  });

  it('rejects a one-tenant spec at validate, not after a whole run', () => {
    expect(() =>
      tenancyPlugin.validate(
        test({
          ...JSON.parse(JSON.stringify(spec())),
          subject: { principal: 'other', tenantId: 'org_a', tenantLabel: null },
        }),
      ),
    ).toThrow(/same tenant/);
  });

  it('rejects a spec whose holder and subject are one principal', () => {
    expect(() =>
      tenancyPlugin.validate(
        test({
          ...JSON.parse(JSON.stringify(spec())),
          subject: { principal: 'tenantAAdmin', tenantId: 'org_b', tenantLabel: null },
        }),
      ),
    ).toThrow(/both the holder and the subject/);
  });

  it('rejects an unparseable spec with the field that was wrong', () => {
    expect(() => tenancyPlugin.validate(test({ holder: {} }))).toThrow(/invalid spec/);
  });

  it('returns SKIPPED with notRun when the check is UNEXERCISABLE', async () => {
    const execution = await runTenancyTest(
      context(),
      test(spec()),
      spec({ environmentKind: 'PRODUCTION' }),
      { prober: fakeProber(HEALTHY), proberConfigured: true },
    );
    // SKIPPED with a typed `notRun`, so the coverage denominator EXCLUDES it
    // rather than scoring a boundary nothing tested.
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('BLOCKED_BY_ENV');
    expect(execution.notRun?.why).toContain('NOT measured');
    expect(execution.findings).toEqual([]);
  });

  it('calls an empty inventory NOT_RUN, which has a different remedy', async () => {
    const execution = await runTenancyTest(context(), test(spec()), spec({ operations: [] }), {
      prober: fakeProber(HEALTHY),
      proberConfigured: true,
    });
    expect(execution.notRun?.kind).toBe('NOT_RUN');
  });

  it('is SKIPPED and NOT PASSED when every verdict was inconclusive', async () => {
    const execution = await runTenancyTest(
      context(),
      test(spec()),
      spec(),
      { prober: fakeProber({ '/api/invoices/inv_a1': { status: 401 } }), proberConfigured: true },
    );
    // No operation FAILED, and reporting that as a pass is the exact lie this
    // plugin is shaped to prevent.
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('BLOCKED_BY_ENV');
  });

  it('PASSES when the boundary genuinely held, with the summary attached', async () => {
    const execution = await runTenancyTest(context(), test(spec()), spec(), {
      prober: fakeProber(HEALTHY),
      proberConfigured: true,
    });
    expect(execution.status).toBe('PASSED');
    expect(execution.notRun).toBeUndefined();
    expect(execution.console[0]?.text).toContain('measured');
  });

  it('FAILS with a finding when a record crossed the boundary', async () => {
    const execution = await runTenancyTest(context(), test(spec()), spec(), {
      prober: fakeProber({ ...HEALTHY, '/api/invoices/inv_b1': { status: 200, evidenceFound: true } }),
      proberConfigured: true,
    });
    expect(execution.status).toBe('FAILED');
    expect(execution.findings).toHaveLength(1);
    expect(execution.findings[0]?.severity).toBe('CRITICAL');
  });

  it('reads the holder’s session from the principal map, not from the legacy field', () => {
    const ctx = context({
      storageState: null,
      sessions: {
        tenantAAdmin: {
          principal: {
            name: 'tenantAAdmin',
            kind: 'PERSISTENT',
            lifecycle: 'ACTIVE',
            role: 'admin',
            authProfileId: 'prof_a',
            authProfileKind: null,
            tenant: { id: 'org_a', label: 'Acme' },
            createdByScenario: null,
          },
          storageState: { cookies: [] },
          expiresAtIso: null,
        },
      },
    });
    expect(holderHasSession(ctx, 'tenantAAdmin')).toBe(true);
    // A principal with no entry is not a holder, and must not fall back to the
    // run's one session: that is how a sweep comes to run as the wrong identity.
    expect(holderHasSession(ctx, 'tenantBAdmin')).toBe(false);
  });

  it('treats a null storage state as anonymous, which is NOT a usable holder', () => {
    const ctx = context({
      storageState: null,
      sessions: {
        tenantAAdmin: {
          principal: {
            name: 'tenantAAdmin',
            kind: 'ANONYMOUS',
            lifecycle: 'ACTIVE',
            role: null,
            authProfileId: null,
            authProfileKind: null,
            tenant: null,
            createdByScenario: null,
          },
          storageState: null,
          expiresAtIso: null,
        },
      },
    });
    // A sweep whose holder is anonymous measures anonymous denial, which is the
    // check this plugin replaces.
    expect(holderHasSession(ctx, 'tenantAAdmin')).toBe(false);
  });
});

// ─── Determinism ─────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('produces an identical measurement for identical inputs', async () => {
    const a = await sweep();
    const b = await sweep();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('probes operations in the order the inventory gave them', async () => {
    const prober = fakeProber(HEALTHY);
    await measureTenancy(spec(), { prober, proberConfigured: true, holderHasSession: true });
    expect(prober.asked.map((r) => r.path)).toEqual([
      '/api/invoices/inv_a1',
      '/api/invoices/inv_b1',
      '/api/orders/ord_b7',
    ]);
  });
});
