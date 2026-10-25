/**
 * Tests for the one module that reports an ABSENCE.
 *
 * A catalogue of expectations is the easiest place in this product to ship a
 * lie, because an UNMET row is generated from NO evidence — it is produced by
 * the absence of evidence, which is also what a failed read, a truncated crawl
 * and a source nobody configured all look like. So the suite is built around
 * the ways a false gap gets manufactured rather than around the functions:
 *
 *   - reporting "you have no 404 page" when no crawl ever requested one
 *   - reporting "you have no password reset" to an SSO-only application
 *   - reporting "you have no signup" to an invite-only application
 *   - concluding NOT_APPLICABLE for everything when nothing was enumerated,
 *     which reads as a clean bill of health
 *   - counting an INDETERMINATE row as a gap
 *   - treating a surface the crawl REFUSED as a surface that does not exist
 *   - giving a truncated enumeration the same confidence as a complete one
 *   - silently omitting an expectation instead of saying it does not apply
 *   - a single-token path rule reporting a reset page the application has not
 *     got (a false MET, which hides a real gap)
 *
 * Each of those is a test below.
 */

import { describe, expect, it } from 'vitest';
import type { SurfaceItem, SurfaceSource } from '@qaai/shared';
import {
  EXPECTATIONS_IN_ORDER,
  EXPECTATION_CONFIDENCES,
  EXPECTATION_IDS,
  EXPECTATION_VERDICTS,
  NOTHING_OBSERVED,
  authKindOfItem,
  downgradeConfidence,
  matchExpectedSurface,
  pathSegmentTokens,
  pathTokens,
  type CatalogueEvidence,
  type CatalogueObservations,
  type ExpectationId,
  type ExpectedSurfaceReport,
} from './surface-catalog.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function route(path: string): SurfaceItem {
  return {
    kind: 'ROUTE',
    key: `ROUTE:${path}`,
    label: path,
    file: 'app/page.tsx',
    line: null,
    origin: 'SOURCE_ONLY',
    evidence: `${path} — directory path is the URL`,
    detector: 'next-app-router',
  };
}

function endpoint(method: string, path: string): SurfaceItem {
  return {
    kind: 'ENDPOINT',
    key: `ENDPOINT:${method} ${path}`,
    label: `${method} ${path}`,
    file: 'app/api/route.ts',
    line: null,
    origin: 'SOURCE_ONLY',
    evidence: 'a route handler exports this verb',
    detector: 'next-app-router',
  };
}

function auth(kind: string, path: string): SurfaceItem {
  return {
    kind: 'AUTH_SURFACE',
    key: `AUTH_SURFACE:${kind}@${path}`,
    label: `${kind.toLowerCase()} at ${path}`,
    file: 'app/login/page.tsx',
    line: null,
    origin: 'SOURCE_ONLY',
    evidence: `the URL names a ${kind.toLowerCase()}`,
    detector: 'auth-vocabulary',
  };
}

function evidence(overrides: Partial<CatalogueEvidence> = {}): CatalogueEvidence {
  return {
    items: [],
    participated: ['SOURCE'],
    observations: NOTHING_OBSERVED,
    enumerationComplete: true,
    atLeastMoreSurfaces: null,
    ...overrides,
  };
}

function observed(overrides: Partial<CatalogueObservations>): CatalogueObservations {
  return { ...NOTHING_OBSERVED, ...overrides };
}

function verdictFor(report: ExpectedSurfaceReport, id: ExpectationId) {
  const row = report.results.find((result) => result.expectation === id);
  if (row === undefined) throw new Error(`no result for ${id}`);
  return row;
}

/** A plain self-service application: login, signup, and a source read. */
function selfServiceApp(extra: SurfaceItem[] = []): CatalogueEvidence {
  return evidence({
    items: [auth('LOGIN', '/login'), auth('SIGNUP', '/signup'), route('/dashboard'), ...extra],
    participated: ['SOURCE', 'CRAWL'],
  });
}

// ─── The two-mechanism guard ─────────────────────────────────────────────────

describe('the catalogue cannot drift out of its own vocabulary', () => {
  /*
   * The run-time half of the pattern this codebase requires. The compiler
   * enforces the `Record<ExpectationId, ...>` so a missing definition will not
   * build; this catches the other direction — a definition whose `id` does not
   * match its key, which compiles and then produces a row labelled as the wrong
   * expectation.
   */
  it('has exactly one definition per id, keyed by its own id', () => {
    expect(EXPECTATIONS_IN_ORDER).toHaveLength(EXPECTATION_IDS.length);
    for (const [index, definition] of EXPECTATIONS_IN_ORDER.entries()) {
      expect(definition.id).toBe(EXPECTATION_IDS[index]);
    }
  });

  it('gives every expectation at least one way to be satisfied', () => {
    for (const definition of EXPECTATIONS_IN_ORDER) {
      const mechanisms = [
        definition.satisfiedByAuthKind,
        definition.satisfiedByPath,
        definition.satisfiedByObservation,
      ].filter((mechanism) => mechanism !== undefined);
      expect(mechanisms.length, `${definition.id} can never be MET`).toBeGreaterThan(0);
    }
  });

  it('gives every expectation at least one declarer that could evidence it', () => {
    for (const definition of EXPECTATIONS_IN_ORDER) {
      expect(definition.detectableBy.length, `${definition.id} is undetectable`).toBeGreaterThan(0);
    }
  });

  it('declares a confidence from the published vocabulary', () => {
    for (const definition of EXPECTATIONS_IN_ORDER) {
      expect(EXPECTATION_CONFIDENCES).toContain(definition.confidence);
    }
  });
});

describe('every expectation gets a verdict, always', () => {
  /*
   * The anti-omission test. A silently dropped expectation and one we judged
   * inapplicable look identical to a reader, and only one of them is a
   * judgement we are prepared to defend.
   */
  it('returns one row per expectation even for an empty application', () => {
    const report = matchExpectedSurface(evidence());
    expect(report.results).toHaveLength(EXPECTATION_IDS.length);
    expect(new Set(report.results.map((result) => result.expectation))).toEqual(
      new Set(EXPECTATION_IDS),
    );
    for (const result of report.results) {
      expect(EXPECTATION_VERDICTS).toContain(result.verdict);
      expect(result.why.length).toBeGreaterThan(0);
    }
  });

  it('never leaves a why blank, whatever the verdict', () => {
    const report = matchExpectedSurface(selfServiceApp());
    for (const result of report.results) {
      expect(result.why.trim(), `${result.expectation} has no reason`).not.toBe('');
    }
  });
});

// ─── The false gaps ──────────────────────────────────────────────────────────

describe('a silence is never reported as an answer', () => {
  it('will not claim a missing 404 page when no crawl participated', () => {
    const report = matchExpectedSurface(
      evidence({ items: [route('/dashboard')], participated: ['SOURCE'] }),
    );
    const row = verdictFor(report, 'NOT_FOUND_PAGE');
    expect(row.verdict).toBe('INDETERMINATE');
    expect(row.missingDeclarers).toEqual(['CRAWL']);
    expect(report.unmet.map((result) => result.expectation)).not.toContain('NOT_FOUND_PAGE');
  });

  it('separates "we did not look" from "we looked and found none"', () => {
    const base = { items: [route('/dashboard')], participated: ['CRAWL'] as SurfaceSource[] };
    const notLooked = matchExpectedSurface(
      evidence({ ...base, observations: observed({ notFoundPage: null }) }),
    );
    const looked = matchExpectedSurface(
      evidence({ ...base, observations: observed({ notFoundPage: false }) }),
    );

    expect(verdictFor(notLooked, 'NOT_FOUND_PAGE').verdict).toBe('INDETERMINATE');
    expect(verdictFor(looked, 'NOT_FOUND_PAGE').verdict).toBe('UNMET');
  });

  it('reports an observed 404 page as MET', () => {
    const report = matchExpectedSurface(
      evidence({
        items: [route('/dashboard')],
        participated: ['CRAWL'],
        observations: observed({ notFoundPage: true }),
      }),
    );
    expect(verdictFor(report, 'NOT_FOUND_PAGE').verdict).toBe('MET');
  });

  it('does not conclude NOT_APPLICABLE for everything when nothing was enumerated', () => {
    /*
     * The worst possible output: an application nobody looked at reading as
     * "nothing is expected of you", which is a clean bill of health drawn
     * entirely from our own silence.
     */
    const report = matchExpectedSurface(evidence({ items: [], participated: [] }));
    expect(report.counts.notApplicable).toBe(0);
    expect(report.counts.unmet).toBe(0);
    expect(report.counts.indeterminate).toBe(EXPECTATION_IDS.length);
    expect(report.caveats.join(' ')).toContain('no declarer participated');
  });

  it('names the declarers that would decide an indeterminate row', () => {
    const report = matchExpectedSurface(evidence({ items: [], participated: [] }));
    expect(report.absentDeclarers).toContain('CRAWL');
    expect(report.absentDeclarers).toContain('SOURCE');
    // Deduplicated: fifteen expectations share a handful of declarers.
    expect(new Set(report.absentDeclarers).size).toBe(report.absentDeclarers.length);
  });
});

describe('an application that deliberately lacks a feature is not told it has a gap', () => {
  it('does not expect password reset from an SSO-only application', () => {
    const report = matchExpectedSurface(
      evidence({
        items: [auth('SSO', '/auth/sso'), route('/dashboard')],
        participated: ['SOURCE', 'CRAWL'],
      }),
    );
    const row = verdictFor(report, 'PASSWORD_RESET');
    expect(row.verdict).toBe('NOT_APPLICABLE');
    expect(row.why).toContain('identity provider');
  });

  it('still expects password reset when a local login exists beside SSO', () => {
    const report = matchExpectedSurface(
      evidence({
        items: [auth('SSO', '/auth/sso'), auth('LOGIN', '/login'), route('/dashboard')],
        participated: ['SOURCE', 'CRAWL'],
      }),
    );
    expect(verdictFor(report, 'PASSWORD_RESET').verdict).toBe('UNMET');
  });

  it('does not expect a signup page from an invite-only application', () => {
    const report = matchExpectedSurface(
      evidence({
        items: [auth('LOGIN', '/login')],
        participated: ['SOURCE', 'CRAWL'],
        observations: observed({ inviteOnlyAccounts: true }),
      }),
    );
    const row = verdictFor(report, 'SIGNUP');
    expect(row.verdict).toBe('NOT_APPLICABLE');
    expect(row.why).toContain('invitation');
  });

  it('does not expect MFA without privileged surface', () => {
    const report = matchExpectedSurface(
      evidence({
        items: [auth('LOGIN', '/login'), route('/profile')],
        participated: ['SOURCE', 'CRAWL'],
      }),
    );
    const row = verdictFor(report, 'MFA');
    expect(row.verdict).toBe('NOT_APPLICABLE');
    expect(row.why).toContain('privileged');
  });

  it('expects MFA once an admin area is enumerated, and quotes it', () => {
    const report = matchExpectedSurface(
      evidence({
        items: [auth('LOGIN', '/login'), route('/admin/billing')],
        participated: ['SOURCE', 'CRAWL'],
      }),
    );
    const row = verdictFor(report, 'MFA');
    expect(row.verdict).toBe('UNMET');
    expect(row.why).toContain('/admin/billing');
  });

  it('never invents a search gap, and reports search as present when it exists', () => {
    const without = matchExpectedSurface(selfServiceApp());
    expect(verdictFor(without, 'SEARCH').verdict).toBe('NOT_APPLICABLE');

    const with_ = matchExpectedSurface(selfServiceApp([route('/search')]));
    expect(verdictFor(with_, 'SEARCH').verdict).toBe('MET');
  });

  it('does not expect email verification without a self-service signup', () => {
    const report = matchExpectedSurface(
      evidence({ items: [auth('LOGIN', '/login')], participated: ['SOURCE', 'CRAWL'] }),
    );
    const row = verdictFor(report, 'EMAIL_VERIFICATION');
    expect(row.verdict).toBe('NOT_APPLICABLE');
    expect(row.why).toContain('signup');
  });

  it('does not expect consent handling when only session cookies were observed', () => {
    const report = matchExpectedSurface(
      evidence({
        items: [route('/dashboard')],
        participated: ['CRAWL'],
        observations: observed({ nonEssentialCookies: false }),
      }),
    );
    expect(verdictFor(report, 'CONSENT_COOKIE').verdict).toBe('NOT_APPLICABLE');
  });

  it('cannot tell whether consent is owed when nothing established the cookies', () => {
    const report = matchExpectedSurface(
      evidence({
        items: [route('/dashboard')],
        participated: ['CRAWL'],
        observations: observed({ nonEssentialCookies: null }),
      }),
    );
    const row = verdictFor(report, 'CONSENT_COOKIE');
    expect(row.verdict).toBe('INDETERMINATE');
    expect(row.why).toContain('nothing established');
  });
});

// ─── The findings that should fire ───────────────────────────────────────────

describe('a real gap is reported, with the evidence that triggered it', () => {
  /*
   * The blanket invariant, because a row whose verdict a reader cannot check is
   * the shape every false gap arrives in. Asserted across four applications so
   * one scenario cannot carry it: an empty one, a self-service one, an SSO one
   * and an invite-only one.
   */
  it('gives every row a reason, and every finding something to do about it', () => {
    const scenarios: CatalogueEvidence[] = [
      evidence({ items: [], participated: [] }),
      selfServiceApp(),
      evidence({
        items: [auth('SSO', '/login'), route('/dashboard')],
        participated: ['SOURCE', 'CRAWL'],
        observations: observed({ inviteOnlyAccounts: true }),
      }),
      evidence({
        items: [auth('LOGIN', '/login'), route('/admin/billing'), endpoint('GET', '/api/orders')],
        participated: ['SOURCE', 'OPENAPI'],
        enumerationComplete: false,
        atLeastMoreSurfaces: 12,
      }),
    ];

    for (const scenario of scenarios) {
      const report = matchExpectedSurface(scenario);
      for (const row of report.results) {
        expect(row.why.length, `${row.expectation} has no reason`).toBeGreaterThan(10);
        if (row.verdict === 'UNMET') {
          // A finding with nothing to do about it is a finding a reader can
          // only distrust.
          expect(row.remedy, `${row.expectation} is a finding with no remedy`).not.toBeNull();
        }
        if (row.verdict === 'INDETERMINATE' && row.metBy.length === 0) {
          // Either we name the declarer that would decide it, or the reason
          // says what was inconclusive. Never a bare blank.
          expect(
            row.missingDeclarers.length > 0 || row.why.length > 10,
            `${row.expectation} is undecidable for no stated reason`,
          ).toBe(true);
        }
      }
      // An UNMET is the only verdict allowed to be a finding.
      expect(report.counts.unmet).toBe(report.unmet.length);
    }
  });

  it('reports the missing password reset behind a login, naming the login', () => {
    const report = matchExpectedSurface(selfServiceApp());
    const row = verdictFor(report, 'PASSWORD_RESET');
    expect(row.verdict).toBe('UNMET');
    expect(row.confidence).toBe('HIGH');
    expect(row.why).toContain('login surface was enumerated');
    expect(row.remedy).not.toBeNull();
  });

  it('finds the password reset when the route exists, and names the path', () => {
    const report = matchExpectedSurface(selfServiceApp([route('/auth/forgot-password')]));
    const row = verdictFor(report, 'PASSWORD_RESET');
    expect(row.verdict).toBe('MET');
    expect(row.metBy).toContain('ROUTE:/auth/forgot-password');
    expect(row.why).toContain('/auth/forgot-password');
  });

  it('accepts a classified auth surface as satisfaction, not only a path', () => {
    const report = matchExpectedSurface(selfServiceApp([auth('PASSWORD_RESET', '/recover')]));
    const row = verdictFor(report, 'PASSWORD_RESET');
    expect(row.verdict).toBe('MET');
    expect(row.metBy).toContain('AUTH_SURFACE:PASSWORD_RESET@/recover');
  });

  it('orders the findings strongest-confidence first', () => {
    const report = matchExpectedSurface(selfServiceApp());
    const ranks = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
    const seen = report.unmet.map((result) => ranks[result.confidence]);
    expect(seen).toEqual([...seen].sort((left, right) => left - right));
  });

  it('expects a health endpoint only once endpoints exist', () => {
    const noApi = matchExpectedSurface(selfServiceApp());
    expect(verdictFor(noApi, 'HEALTH_CHECK').verdict).toBe('NOT_APPLICABLE');

    const withApi = matchExpectedSurface(selfServiceApp([endpoint('GET', '/api/orders')]));
    expect(verdictFor(withApi, 'HEALTH_CHECK').verdict).toBe('UNMET');

    const healthy = matchExpectedSurface(
      selfServiceApp([endpoint('GET', '/api/orders'), endpoint('GET', '/healthz')]),
    );
    expect(verdictFor(healthy, 'HEALTH_CHECK').verdict).toBe('MET');
  });
});

// ─── False METs, which hide real gaps ────────────────────────────────────────

describe('a single word never satisfies an expectation on its own', () => {
  /*
   * codebase.ts already records that `/reset` matches
   * `/settings/reset-onboarding`. A single-token rule would report a
   * password-reset page this application has not got, which hides the gap
   * instead of inventing one — the same lie in the other direction.
   */
  it('does not read /settings/reset-onboarding as a password reset', () => {
    const report = matchExpectedSurface(selfServiceApp([route('/settings/reset-onboarding')]));
    expect(verdictFor(report, 'PASSWORD_RESET').verdict).toBe('UNMET');
  });

  it('does not read /orders/:id/confirm as email verification', () => {
    const report = matchExpectedSurface(selfServiceApp([route('/orders/:id/confirm')]));
    expect(verdictFor(report, 'EMAIL_VERIFICATION').verdict).toBe('UNMET');
  });

  /*
   * The describe block above claims a single word never satisfies an
   * expectation on its own, and the two tests before this one only proved it
   * for the expectations that HAVE a second word. A third of the groups in the
   * catalogue hold one token, because the thing is named by one word or not at
   * all — and against a fixture app three false METs were demonstrable:
   * /glossary/search-terms satisfied TERMS_OF_SERVICE and SEARCH, and
   * /health-coach/sessions satisfied HEALTH_CHECK. A fitness application was
   * told it has a health endpoint because it has a health coach.
   */
  it('does not read a health coach as a health endpoint', () => {
    const report = matchExpectedSurface(
      selfServiceApp([route('/health-coach/sessions'), endpoint('GET', '/api/orders')]),
    );
    expect(verdictFor(report, 'HEALTH_CHECK').verdict).toBe('UNMET');
  });

  it('does not read /glossary/search-terms as terms of service', () => {
    const report = matchExpectedSurface(selfServiceApp([route('/glossary/search-terms')]));
    expect(verdictFor(report, 'TERMS_OF_SERVICE').verdict).toBe('UNMET');
    // SEARCH can never be UNMET by design, so the false MET showed up there as
    // a "present" row instead of a gap. It must not be present either.
    expect(verdictFor(report, 'SEARCH').verdict).toBe('NOT_APPLICABLE');
  });

  /*
   * The other half of the same fix, and the expensive direction: tightening a
   * one-token rule must not manufacture a gap for the ordinary hyphenated
   * spellings. Each of these is the thing it names.
   */
  it('still finds the thing when the segment carries a qualifier beside the word', () => {
    const cases: Array<[SurfaceItem, ExpectationId]> = [
      [route('/privacy-policy'), 'PRIVACY_POLICY'],
      [route('/legal/privacy-notice'), 'PRIVACY_POLICY'],
      [route('/terms-of-service'), 'TERMS_OF_SERVICE'],
      [route('/terms-and-conditions'), 'TERMS_OF_SERVICE'],
      [route('/legal/terms'), 'TERMS_OF_SERVICE'],
      [route('/signup-complete'), 'SIGNUP'],
      [route('/logout-success'), 'LOGOUT'],
      [route('/products/search-results'), 'SEARCH'],
      [endpoint('GET', '/internal/health-check'), 'HEALTH_CHECK'],
      [endpoint('GET', '/healthz'), 'HEALTH_CHECK'],
    ];
    for (const [item, expectation] of cases) {
      /*
       * Deliberately NOT `selfServiceApp`: its SIGNUP and LOGOUT auth surfaces
       * would satisfy two of these rows by auth kind, which is the stronger
       * evidence and therefore wins first — and this test is about the path
       * matcher. The login is here only so the triggers fire.
       */
      const report = matchExpectedSurface(
        evidence({
          items: [auth('LOGIN', '/login'), item, endpoint('GET', '/api/orders')],
          participated: ['SOURCE', 'CRAWL', 'OPENAPI'],
        }),
      );
      const row = verdictFor(report, expectation);
      expect(row.verdict, `${item.key} should satisfy ${expectation}`).toBe('MET');
      expect(row.metBy, `${item.key} should be the evidence for ${expectation}`).toContain(
        item.key,
      );
    }
  });

  it('finds a second factor at /settings/mfa-setup, which is where it usually lives', () => {
    const report = matchExpectedSurface(
      selfServiceApp([route('/admin/billing'), route('/settings/mfa-setup')]),
    );
    expect(verdictFor(report, 'MFA').verdict).toBe('MET');
  });

  it('keeps a parameter segment out of the per-segment match as well', () => {
    // `:param` is our placeholder, so a parameter segment contributes nothing
    // to either arity of the rule.
    expect(pathSegmentTokens('/users/:param/terms')).toEqual([
      new Set(['users']),
      new Set(),
      new Set(['terms']),
    ]);
  });

  it('does not let a parameter segment satisfy a token group', () => {
    // `:param` canonicalises every dialect of "a value here"; it is our
    // placeholder, not a word the application chose.
    expect(pathTokens('/users/:param')).not.toContain('param');
    expect([...pathTokens('/auth/forgot-password')].sort()).toEqual([
      'auth',
      'forgot',
      'password',
    ]);
  });

  it('does not read an HTTP verb in an endpoint identity as a path token', () => {
    const report = matchExpectedSurface(
      evidence({
        items: [auth('LOGIN', '/login'), endpoint('POST', '/orders')],
        participated: ['SOURCE', 'CRAWL'],
      }),
    );
    // 'post' is a verb here, not a path word, so nothing should match on it.
    expect(verdictFor(report, 'LOGOUT').verdict).toBe('UNMET');
  });
});

// ─── Refused is not absent ───────────────────────────────────────────────────

describe('a surface the harness refused still proves the surface exists', () => {
  /*
   * /logout is the canonical case. Every crawl policy refuses it, because
   * driving it makes the rest of the crawl anonymous. If a refusal removed the
   * item from satisfaction we would report a missing logout to every customer
   * whose policy excluded it — which is all of them.
   */
  it('counts a REFUSED logout route as MET', () => {
    const refused: SurfaceItem = {
      ...route('/logout'),
      exercise: {
        state: 'REFUSED',
        rule: 'session-ending-paths',
        detail: 'the crawl policy excludes /logout so the session survives the crawl',
      },
    };
    const report = matchExpectedSurface(selfServiceApp([refused]));
    const row = verdictFor(report, 'LOGOUT');
    expect(row.verdict).toBe('MET');
    expect(row.metBy).toContain('ROUTE:/logout');
  });

  it('counts an UNEXERCISABLE account deletion as MET', () => {
    const unexercisable: SurfaceItem = {
      ...route('/settings/delete-account'),
      exercise: {
        state: 'UNEXERCISABLE',
        reason: 'DESTRUCTIVE',
        detail: 'no disposable account is provisioned in this environment',
      },
    };
    const report = matchExpectedSurface(selfServiceApp([unexercisable]));
    expect(verdictFor(report, 'ACCOUNT_DELETION').verdict).toBe('MET');
  });
});

// ─── Caps and confidence ─────────────────────────────────────────────────────

describe('an absence found through a truncated enumeration is a weaker claim', () => {
  it('lowers every UNMET confidence by one step when the enumeration stopped early', () => {
    const complete = matchExpectedSurface(selfServiceApp());
    const truncated = matchExpectedSurface({
      ...selfServiceApp(),
      enumerationComplete: false,
      atLeastMoreSurfaces: 240,
    });

    expect(verdictFor(complete, 'PASSWORD_RESET').confidence).toBe('HIGH');
    expect(verdictFor(truncated, 'PASSWORD_RESET').confidence).toBe('MEDIUM');
  });

  it('reports the cap as a count and as a reason, not as an adjective', () => {
    const report = matchExpectedSurface({
      ...selfServiceApp(),
      enumerationComplete: false,
      atLeastMoreSurfaces: 240,
    });
    const caveats = report.caveats.join(' ');
    expect(caveats).toContain('at least 240 more');
    expect(caveats).toContain('stopped early');
  });

  it('treats an enumeration that never accounted for completeness as not complete', () => {
    const report = matchExpectedSurface({ ...selfServiceApp(), enumerationComplete: null });
    expect(verdictFor(report, 'PASSWORD_RESET').confidence).toBe('MEDIUM');
    expect(report.caveats.join(' ')).toContain('did not account for its own completeness');
  });

  it('does not lower the confidence of a MET or a NOT_APPLICABLE row', () => {
    const report = matchExpectedSurface({
      ...selfServiceApp([route('/auth/forgot-password')]),
      enumerationComplete: false,
      atLeastMoreSurfaces: 5,
    });
    const met = verdictFor(report, 'PASSWORD_RESET');
    expect(met.verdict).toBe('MET');
    expect(met.confidence).toBe('HIGH');
  });

  it('floors the downgrade at LOW', () => {
    expect(downgradeConfidence('HIGH')).toBe('MEDIUM');
    expect(downgradeConfidence('MEDIUM')).toBe('LOW');
    expect(downgradeConfidence('LOW')).toBe('LOW');
  });

  it('always carries at least the sentence that says what the catalogue is', () => {
    const report = matchExpectedSurface(selfServiceApp());
    expect(report.caveats.length).toBeGreaterThan(0);
    expect(report.caveats.join(' ')).toContain('not a compliance checklist');
  });
});

// ─── Counting ────────────────────────────────────────────────────────────────

describe('the counts cannot disagree with the rows', () => {
  it('sums to the number of expectations, with indeterminate excluded from gaps', () => {
    for (const fixture of [
      evidence(),
      selfServiceApp(),
      selfServiceApp([route('/admin'), route('/search'), endpoint('GET', '/health')]),
      evidence({ items: [], participated: [] }),
    ]) {
      const report = matchExpectedSurface(fixture);
      const { met, unmet, notApplicable, indeterminate } = report.counts;
      expect(met + unmet + notApplicable + indeterminate).toBe(EXPECTATION_IDS.length);
      expect(report.unmet).toHaveLength(unmet);
      for (const result of report.unmet) expect(result.verdict).toBe('UNMET');
    }
  });

  it('puts no metBy keys on a row that is not MET', () => {
    const report = matchExpectedSurface(selfServiceApp());
    for (const result of report.results) {
      if (result.verdict === 'MET') continue;
      expect(result.metBy, `${result.expectation} claims evidence`).toEqual([]);
    }
  });
});

// ─── Auth-kind reading ───────────────────────────────────────────────────────

describe('the auth kind is read off the identity, not off optional meta', () => {
  it('reads a kind out of a key with no meta at all', () => {
    expect(authKindOfItem({ kind: 'AUTH_SURFACE', key: 'AUTH_SURFACE:LOGIN@/login' })).toBe('LOGIN');
  });

  it('refuses a kind it does not recognise rather than forging one', () => {
    expect(authKindOfItem({ kind: 'AUTH_SURFACE', key: 'AUTH_SURFACE:MAGIC@/magic' })).toBeNull();
  });

  it('returns null for an item that is not an auth surface', () => {
    expect(authKindOfItem({ kind: 'ROUTE', key: 'ROUTE:/login' })).toBeNull();
  });
});
