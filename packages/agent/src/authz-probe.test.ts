/**
 * Tests for cross-user authorization probes.
 *
 * The first describe block below is the most important in this file, and the
 * rest of the module is only worth having if it keeps passing. A cross-user
 * sweep has ONE catastrophic failure mode: the holder's session is not actually
 * working, every endpoint refuses the request for that reason, and the report
 * renders "40 endpoints, 0 leaks". That is not a wrong number — it is a whole
 * bug class marked checked, on the strength of a broken cookie. So:
 *
 *   · a refuted control makes EVERY verdict inconclusive, whatever the status;
 *   · a 401 is inconclusive even under a live control;
 *   · no control attempt is NOT_ATTEMPTED and not a fourth kind of pass;
 *   · `authzFindings` produces nothing when the control is not live, so a
 *     broken login cannot manufacture a CRITICAL security finding;
 *   · `summariseAuthzSweep` is incapable of saying "no leaks found" when
 *     nothing was measured.
 *
 * The rest is the honesty accounting this round is bound by: an anonymous
 * holder is REFUSED BY NAME (it is the check this module replaces), every
 * refusal is recorded rather than skipped, and every cap is a count and a
 * reason.
 *
 * No network: the transport is an injected table, so the whole sweep runs with
 * no socket and no credential anywhere in the file.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTHZ_REFUSAL_LIST,
  AUTHZ_VERDICT_LABELS,
  AUTHZ_VERDICT_LIST,
  CONTROL_STATE_LIST,
  FINDING_VERDICTS,
  ID_BASIS_LIST,
  INCONCLUSIVE_VERDICTS,
  PASSING_VERDICTS,
  admitAuthzProbe,
  authzFindings,
  classifyAuthzOutcome,
  controlFrom,
  planAuthzProbes,
  runAuthzSweep,
  summariseAuthzSweep,
  type AuthzObservation,
  type AuthzTransport,
  type ObservedId,
  type ReadEndpoint,
} from './authz-probe.js';
import type { Principal } from '@qaai/shared';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const HOLDER: Principal = {
  name: 'userA',
  kind: 'PERSISTENT',
  lifecycle: 'ACTIVE',
  role: 'member',
  authProfileId: 'prof_a',
  authProfileKind: null,
  tenant: null,
  createdByScenario: null,
};

const ANON: Principal = { ...HOLDER, name: 'guest', kind: 'ANONYMOUS', authProfileId: null };

function id(value: string, owner: string, overrides: Partial<ObservedId> = {}): ObservedId {
  return {
    value,
    owner,
    observedIn: `/invoices/${value}`,
    basis: 'URL_PATH',
    ownerEvidence: null,
    ...overrides,
  };
}

const INVOICES: ReadEndpoint = {
  method: 'GET',
  template: '/api/invoices/{id}',
  label: 'read one invoice',
};

/** Every verdict at zero, for hand-assembling a report the sweep would not build. */
const EMPTY_COUNT_SHAPE = Object.fromEntries(
  AUTHZ_VERDICT_LIST.map((verdict) => [verdict, 0]),
) as Record<(typeof AUTHZ_VERDICT_LIST)[number], number>;

/** A transport answering from a table, recording every path it was asked for. */
function fakeTransport(
  table: Record<string, Partial<AuthzObservation>>,
  fallback: Partial<AuthzObservation> = { status: 403 },
): AuthzTransport & { readonly asked: Array<{ path: string; asPrincipal: string }> } {
  const asked: Array<{ path: string; asPrincipal: string }> = [];
  return {
    asked,
    read(request) {
      asked.push({ path: request.path, asPrincipal: request.asPrincipal });
      const hit = table[request.path] ?? fallback;
      return Promise.resolve({
        status: hit.status ?? null,
        ownerEvidenceFound: hit.ownerEvidenceFound ?? null,
      });
    },
  };
}

/** The usual plan: A asks for B's invoice, and owns invoice a1 itself. */
function standardPlan(ids: readonly ObservedId[] = [id('a1', 'userA'), id('b1', 'userB')]) {
  return planAuthzProbes({
    holder: HOLDER,
    holderHasSession: true,
    endpoints: [INVOICES],
    ids,
  });
}

// ─── THE CORE: a broken session can never read as a pass ─────────────────────

describe('a broken session is INCONCLUSIVE and never a pass', () => {
  it('makes every verdict inconclusive when the control was REFUTED, whatever the status', () => {
    for (const status of [200, 204, 301, 401, 403, 404, 410, 429, 500, null]) {
      const verdict = classifyAuthzOutcome({
        control: 'REFUTED',
        observation: { status, ownerEvidenceFound: status === 200 ? true : null },
      });
      // Even a 200 with the other user's data in it. We cannot attribute that
      // read to anybody, because we could not establish who we were.
      expect(verdict, `status ${String(status)}`).toBe('INCONCLUSIVE_SESSION');
    }
  });

  it('makes every verdict inconclusive when no control was attempted', () => {
    for (const status of [200, 403, 404]) {
      expect(
        classifyAuthzOutcome({
          control: 'NOT_ATTEMPTED',
          observation: { status, ownerEvidenceFound: false },
        }),
        `status ${status}`,
      ).toBe('INCONCLUSIVE_SESSION');
    }
  });

  it('treats a 401 as inconclusive even under a live control', () => {
    // The session was accepted a moment ago and is not being accepted now, so
    // this probe tells us about the session and not about authorization.
    expect(
      classifyAuthzOutcome({
        control: 'CONFIRMED_LIVE',
        observation: { status: 401, ownerEvidenceFound: null },
      }),
    ).toBe('INCONCLUSIVE_SESSION');
    expect(INCONCLUSIVE_VERDICTS).toContain('INCONCLUSIVE_SESSION');
    expect(PASSING_VERDICTS).not.toContain('INCONCLUSIVE_SESSION');
  });

  it('confirms the control only on a 2xx, never on a redirect to the login page', () => {
    expect(controlFrom({ status: 200 }).state).toBe('CONFIRMED_LIVE');
    // A 302 to /login is the classic shape of an expired session; following it
    // would land on a page that renders perfectly.
    expect(controlFrom({ status: 302 }).state).toBe('REFUTED');
    expect(controlFrom({ status: 403 }).state).toBe('REFUTED');
    expect(controlFrom(null).state).toBe('NOT_ATTEMPTED');
  });

  it('REFUSES to produce a finding when the control is not live', async () => {
    const transport = fakeTransport({
      // The control fails...
      '/api/invoices/a1': { status: 401 },
      // ...and the probe "succeeds" with the other user's data in it.
      '/api/invoices/b1': { status: 200, ownerEvidenceFound: true },
    });
    const report = await runAuthzSweep({ plan: standardPlan(), transport });
    expect(report.control.state).toBe('REFUTED');
    expect(report.results[0]?.verdict).toBe('INCONCLUSIVE_SESSION');
    // A CRITICAL security finding manufactured out of a broken login is the
    // fastest way for a customer to stop trusting the product.
    expect(authzFindings(report)).toEqual([]);
    expect(report.measured).toBe(0);
  });

  it('REFUSES a finding on a report whose control and verdicts DISAGREE', () => {
    /*
     * The guard in `authzFindings` is a SECOND line of defence and this is the
     * only test that reaches it. `classifyAuthzOutcome` already refuses to
     * produce LEAKED under a refuted control, so a report built by
     * `runAuthzSweep` can never hold this combination — but an
     * `AuthzSweepReport` is a plain serialisable object that crosses the worker
     * boundary, and a report assembled or deserialised anywhere else can. A
     * mutation that deleted the guard survived the whole file until this test
     * existed, which is exactly how defence in depth rots into decoration.
     */
    const inconsistent = {
      control: controlFrom({ status: 401 }),
      results: [
        {
          probe: {
            method: 'GET' as const,
            path: '/api/invoices/b1',
            endpointLabel: 'read one invoice',
            holder: 'userA',
            owner: 'userB',
            id: id('b1', 'userB'),
          },
          verdict: 'LEAKED' as const,
          status: 200,
          detail: 'hand-assembled report',
        },
      ],
      counts: { ...EMPTY_COUNT_SHAPE, LEAKED: 1 },
      refusals: [],
      considered: 1,
      notProbed: 0,
      notProbedReason: null,
      measured: 1,
    };
    expect(authzFindings(inconsistent)).toEqual([]);
  });

  it('cannot say "no leaks" when nothing was measured', async () => {
    const transport = fakeTransport({ '/api/invoices/a1': { status: 401 } });
    const report = await runAuthzSweep({ plan: standardPlan(), transport });
    const summary = summariseAuthzSweep(report);
    expect(summary).toContain('No cross-user authorization was measured');
    expect(summary).toContain('every one of them is inconclusive');
    expect(summary).not.toMatch(/0 (?:leak|cross-user)/i);
  });

  it('names the remedy on the control, not just the failure', () => {
    expect(controlFrom({ status: 401 }).detail).toContain('Re-establish the session');
    expect(controlFrom(null).detail).toContain('supply one id the holder owns');
  });
});

// ─── The verdict table ───────────────────────────────────────────────────────

describe('classifyAuthzOutcome under a live control', () => {
  const live = (observation: AuthzObservation) =>
    classifyAuthzOutcome({ control: 'CONFIRMED_LIVE', observation });

  it('a 200 with the owner’s data in it is a LEAK', () => {
    expect(live({ status: 200, ownerEvidenceFound: true })).toBe('LEAKED');
  });

  it('a 200 with the body UNCHECKED is a leak we do not overclaim', () => {
    // Recorded separately, because "we saw B's data" is a stronger claim than
    // "the request succeeded" and the report must not make it for us.
    expect(live({ status: 200, ownerEvidenceFound: null })).toBe('LEAKED_UNVERIFIED');
    expect(FINDING_VERDICTS).toContain('LEAKED_UNVERIFIED');
  });

  it('a 200 whose body provably lacks the owner’s data is correct behaviour', () => {
    expect(live({ status: 200, ownerEvidenceFound: false })).toBe('SERVED_BUT_SCOPED');
    expect(PASSING_VERDICTS).toContain('SERVED_BUT_SCOPED');
  });

  it('a 403, 404 or 410 is a pass', () => {
    for (const status of [403, 404, 410]) {
      expect(live({ status, ownerEvidenceFound: null }), String(status)).toBe('DENIED');
    }
  });

  it('a 429 or a 5xx is not an answer about authorization', () => {
    for (const status of [429, 500, 502, 503]) {
      expect(live({ status, ownerEvidenceFound: null }), String(status)).toBe(
        'INCONCLUSIVE_NO_ANSWER',
      );
    }
  });

  it('a 3xx is inconclusive rather than a pass, because it could be either', () => {
    expect(live({ status: 302, ownerEvidenceFound: null })).toBe('INCONCLUSIVE_NO_ANSWER');
  });

  it('nothing answering is our silence, recorded as such', () => {
    expect(live({ status: null, ownerEvidenceFound: null })).toBe('INCONCLUSIVE_NO_ANSWER');
  });

  it('partitions every verdict into exactly one of finding, pass and inconclusive', () => {
    for (const verdict of AUTHZ_VERDICT_LIST) {
      const regions = [
        (FINDING_VERDICTS as readonly string[]).includes(verdict),
        (PASSING_VERDICTS as readonly string[]).includes(verdict),
        (INCONCLUSIVE_VERDICTS as readonly string[]).includes(verdict),
      ].filter(Boolean);
      expect(regions, verdict).toHaveLength(1);
      expect(AUTHZ_VERDICT_LABELS[verdict].length, verdict).toBeGreaterThan(10);
    }
  });

  it('keeps NOT_PROBED and REFUSED out of the passing set', () => {
    // "Nobody asked" and "we chose not to ask" must never be averaged with a
    // denial — that is the pass-that-means-nothing this product exists to end.
    expect(PASSING_VERDICTS).not.toContain('NOT_PROBED');
    expect(PASSING_VERDICTS).not.toContain('REFUSED');
  });
});

// ─── Admission ───────────────────────────────────────────────────────────────

describe('admitAuthzProbe', () => {
  const base = { holder: HOLDER, endpoint: INVOICES, holderHasSession: true };

  it('admits a safe read of another user’s object', () => {
    const admission = admitAuthzProbe({ ...base, id: id('b1', 'userB') });
    expect(admission).toEqual({
      admitted: true,
      method: 'GET',
      path: '/api/invoices/b1',
    });
  });

  it('REFUSES every verb that could change the other user’s data', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const admission = admitAuthzProbe({
        ...base,
        endpoint: { ...INVOICES, method },
        id: id('b1', 'userB'),
      });
      expect(admission.admitted, method).toBe(false);
      if (!admission.admitted) expect(admission.reason).toBe('UNSAFE_VERB');
    }
  });

  it('REFUSES an anonymous holder BY NAME, because that is the check it replaces', () => {
    const admission = admitAuthzProbe({ ...base, holder: ANON, id: id('b1', 'userB') });
    expect(admission.admitted).toBe(false);
    if (!admission.admitted) {
      expect(admission.reason).toBe('ANONYMOUS_HOLDER');
      // The sentence has to say why the old check was worthless, or somebody
      // will "fix" this by allowing it again.
      expect(admission.detail).toContain('every application gets right');
    }
  });

  it('REFUSES the holder asking for its own object, which is correct behaviour', () => {
    const admission = admitAuthzProbe({ ...base, id: id('a1', 'userA') });
    expect(admission.admitted).toBe(false);
    if (!admission.admitted) expect(admission.reason).toBe('SAME_PRINCIPAL');
  });

  it('REFUSES a template with no single {id} hole', () => {
    for (const template of ['/api/invoices', '/api/{id}/items/{id}']) {
      const admission = admitAuthzProbe({
        ...base,
        endpoint: { ...INVOICES, template },
        id: id('b1', 'userB'),
      });
      expect(admission.admitted, template).toBe(false);
      if (!admission.admitted) expect(admission.reason).toBe('TEMPLATE_HAS_NO_ID');
    }
  });

  it('encodes the id, so a path-traversal value cannot change which endpoint is asked', () => {
    const admission = admitAuthzProbe({ ...base, id: id('../../admin', 'userB') });
    expect(admission.admitted).toBe(true);
    if (admission.admitted) {
      expect(admission.path).toBe('/api/invoices/..%2F..%2Fadmin');
      expect(admission.path).not.toContain('/../');
    }
  });

  it('can actually produce every refusal it declares', () => {
    const produced = new Set<string>();
    const collect = (args: Parameters<typeof admitAuthzProbe>[0]): void => {
      const admission = admitAuthzProbe(args);
      if (!admission.admitted) produced.add(admission.reason);
    };
    collect({ ...base, endpoint: { ...INVOICES, method: 'DELETE' }, id: id('b1', 'userB') });
    collect({ ...base, holder: ANON, id: id('b1', 'userB') });
    collect({ ...base, holderHasSession: false, id: id('b1', 'userB') });
    collect({ ...base, id: id('a1', 'userA') });
    collect({ ...base, endpoint: { ...INVOICES, template: '/x' }, id: id('b1', 'userB') });
    expect([...produced].sort()).toEqual([...AUTHZ_REFUSAL_LIST].sort());
  });

  it('describes every id basis and every control state', () => {
    expect(ID_BASIS_LIST).toHaveLength(5);
    expect(CONTROL_STATE_LIST).toEqual(['CONFIRMED_LIVE', 'REFUTED', 'NOT_ATTEMPTED']);
  });
});

// ─── Planning ────────────────────────────────────────────────────────────────

describe('planAuthzProbes', () => {
  it('makes the holder’s own id the control, and still records it as refused', () => {
    const plan = standardPlan();
    expect(plan.control?.path).toBe('/api/invoices/a1');
    // Recorded as a refusal too: the probe genuinely was not performed, and
    // counting it as one would inflate the probe count.
    expect(plan.refusals.map((r) => r.reason)).toEqual(['SAME_PRINCIPAL']);
    expect(plan.probes.map((p) => p.path)).toEqual(['/api/invoices/b1']);
    expect(plan.considered).toBe(2);
  });

  it('plans NO control when the holder owns nothing we observed', () => {
    const plan = planAuthzProbes({
      holder: HOLDER,
      holderHasSession: true,
      endpoints: [INVOICES],
      ids: [id('b1', 'userB')],
    });
    // And that absence is a VALUE, which `controlFrom` turns into
    // NOT_ATTEMPTED — so the sweep degrades to "we could not check" rather than
    // proceeding as though confirmed.
    expect(plan.control).toBeNull();
    expect(controlFrom(null).state).toBe('NOT_ATTEMPTED');
  });

  it('is deterministic: ids are probed in owner-then-value order', () => {
    const shuffled = [id('b2', 'userB'), id('c1', 'userC'), id('b1', 'userB')];
    const a = planAuthzProbes({
      holder: HOLDER,
      holderHasSession: true,
      endpoints: [INVOICES],
      ids: shuffled,
    });
    const b = planAuthzProbes({
      holder: HOLDER,
      holderHasSession: true,
      endpoints: [INVOICES],
      ids: [...shuffled].reverse(),
    });
    expect(a.probes.map((p) => p.path)).toEqual([
      '/api/invoices/b1',
      '/api/invoices/b2',
      '/api/invoices/c1',
    ]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('sweeps every endpoint against every other user’s id', () => {
    const plan = planAuthzProbes({
      holder: HOLDER,
      holderHasSession: true,
      endpoints: [INVOICES, { method: 'GET', template: '/api/orders/{id}', label: 'read an order' }],
      ids: [id('b1', 'userB'), id('c1', 'userC')],
    });
    expect(plan.probes).toHaveLength(4);
    expect(plan.considered).toBe(4);
  });
});

// ─── The sweep, and its disclosure ───────────────────────────────────────────

describe('runAuthzSweep', () => {
  it('asks as the HOLDER, never anonymously — which is the whole point', async () => {
    const transport = fakeTransport({ '/api/invoices/a1': { status: 200 } });
    await runAuthzSweep({ plan: standardPlan(), transport });
    expect(transport.asked.every((request) => request.asPrincipal === 'userA')).toBe(true);
    expect(transport.asked.map((r) => r.path)).toEqual([
      '/api/invoices/a1',
      '/api/invoices/b1',
    ]);
  });

  it('reports a real leak as a CRITICAL finding under a live control', async () => {
    const transport = fakeTransport({
      '/api/invoices/a1': { status: 200 },
      '/api/invoices/b1': { status: 200, ownerEvidenceFound: true },
    });
    const report = await runAuthzSweep({ plan: standardPlan(), transport });
    expect(report.control.state).toBe('CONFIRMED_LIVE');
    expect(report.results[0]?.verdict).toBe('LEAKED');
    const findings = authzFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('CRITICAL');
    expect(findings[0]?.code).toBe('cross-user-read');
    expect(findings[0]?.message).toContain('owned by userB');
  });

  it('downgrades an unverified leak to SERIOUS rather than overclaiming', async () => {
    const transport = fakeTransport({
      '/api/invoices/a1': { status: 200 },
      '/api/invoices/b1': { status: 200 },
    });
    const report = await runAuthzSweep({ plan: standardPlan(), transport });
    expect(authzFindings(report)[0]?.severity).toBe('SERIOUS');
  });

  it('counts a denial as measured, and says so plainly', async () => {
    const transport = fakeTransport({ '/api/invoices/a1': { status: 200 } }, { status: 403 });
    const report = await runAuthzSweep({ plan: standardPlan(), transport });
    expect(report.results[0]?.verdict).toBe('DENIED');
    expect(report.measured).toBe(1);
    expect(authzFindings(report)).toEqual([]);
    expect(summariseAuthzSweep(report)).toContain('1 denial(s) confirmed');
  });

  it('keeps a count for every verdict, including the zeros', async () => {
    const transport = fakeTransport({ '/api/invoices/a1': { status: 200 } });
    const report = await runAuthzSweep({ plan: standardPlan(), transport });
    for (const verdict of AUTHZ_VERDICT_LIST) {
      expect(report.counts[verdict], verdict).toBeGreaterThanOrEqual(0);
    }
    // Refusals are counted, not dropped: a sweep that refused forty probes must
    // not look like a sweep that had forty fewer to do.
    expect(report.counts.REFUSED).toBe(1);
  });

  it('DISCLOSES a limit as a count and a reason', async () => {
    const plan = planAuthzProbes({
      holder: HOLDER,
      holderHasSession: true,
      endpoints: [INVOICES],
      ids: [id('a1', 'userA'), id('b1', 'userB'), id('b2', 'userB'), id('c1', 'userC')],
    });
    const transport = fakeTransport({ '/api/invoices/a1': { status: 200 } });

    const uncapped = await runAuthzSweep({ plan, transport });
    expect(uncapped.notProbed).toBe(0);
    expect(uncapped.notProbedReason).toBeNull();

    const capped = await runAuthzSweep({ plan, transport, limit: 1 });
    expect(capped.results).toHaveLength(1);
    expect(capped.notProbed).toBe(2);
    expect(capped.notProbedReason).toContain('at least that many more');
    expect(capped.counts.NOT_PROBED).toBe(2);
    expect(summariseAuthzSweep(capped)).toContain('2 not probed');
  });

  it('DISCLOSES a cancellation separately from a cap, because they differ', async () => {
    const plan = planAuthzProbes({
      holder: HOLDER,
      holderHasSession: true,
      endpoints: [INVOICES],
      ids: [id('a1', 'userA'), id('b1', 'userB'), id('b2', 'userB')],
    });
    const transport = fakeTransport({ '/api/invoices/a1': { status: 200 } });
    let seen = 0;
    const report = await runAuthzSweep({
      plan,
      transport,
      cancelled: () => {
        seen += 1;
        return seen > 1;
      },
    });
    expect(report.notProbed).toBeGreaterThan(0);
    expect(report.notProbedReason).toContain('cancelled');
    expect(report.notProbedReason).not.toContain('limit');
  });

  it('runs the whole sweep even when the control failed, rather than reporting nothing', async () => {
    const plan = planAuthzProbes({
      holder: HOLDER,
      holderHasSession: true,
      endpoints: [INVOICES],
      ids: [id('a1', 'userA'), id('b1', 'userB'), id('b2', 'userB')],
    });
    const transport = fakeTransport({ '/api/invoices/a1': { status: 401 } });
    const report = await runAuthzSweep({ plan, transport });
    // An empty report reads as "nothing to see". Two inconclusive rows, each
    // naming the broken session, is a sentence with a fix in it.
    expect(report.results).toHaveLength(2);
    expect(report.results.every((r) => r.verdict === 'INCONCLUSIVE_SESSION')).toBe(true);
    expect(report.results[0]?.detail).toContain('Re-establish the session');
  });

  it('never puts a credential anywhere in the report, because it never holds one', async () => {
    const transport = fakeTransport({ '/api/invoices/a1': { status: 200 } });
    const report = await runAuthzSweep({ plan: standardPlan(), transport });
    /*
     * Asserted on the KEYS and not on the serialised text, because the prose in
     * this module says "authorization" and "credential" constantly — it is what
     * the module is about. The structural claim is the one that matters: the
     * report has no FIELD a cookie, token or storage state could occupy, since
     * the transport is handed a principal NAME and resolves the session itself.
     */
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        keys.add(key.toLowerCase());
        walk(child);
      }
    };
    walk(report);
    for (const forbidden of ['cookie', 'cookies', 'storagestate', 'token', 'password', 'secret', 'authorization', 'headers']) {
      expect([...keys], forbidden).not.toContain(forbidden);
    }
    expect(JSON.stringify(report)).toContain('userA');
  });
});
