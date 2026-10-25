/**
 * Tests for the route × role access matrix.
 *
 * Every test below is one way the matrix could report something nobody
 * measured, because that is the only failure mode on this axis that matters: a
 * matrix that is merely incomplete is the product working, and a matrix that is
 * confidently wrong about who can reach what is a security report built on
 * nothing.
 *
 *   - a role whose login FAILED presented as a role with no extra surface
 *   - a crawl that was HELD (bot wall, expired session) presented as a wall of
 *     authorization facts, because every route in it answered "login"
 *   - a (route, role) cell nobody asked about rendering as anything but
 *     NOT_PROBED, and rendering without the reason it was not probed
 *   - a role's denominator being its own reachable set rather than the union,
 *     which is how authorization coverage becomes 100% of nothing
 *   - a DECLARATION overwriting an OBSERVATION, which erases the one finding
 *     the two bases exist to produce
 *   - a stored measurement being overwritten by "nobody asked" on the next
 *     crawl, which the upsert would do on its own
 *   - a soft redirect to the login wall counted as a route that was served
 *   - the login page itself reported as a security finding, which every
 *     application on earth would produce
 *   - a 404 counted as a refusal on identity grounds
 *   - the finding-kind vocabulary drifting from its label record
 */

import { describe, expect, it } from 'vitest';
import {
  ACCESS_FINDING_KINDS,
  ACCESS_FINDING_KIND_LABELS,
  NOT_PROBED_NOT_DISCOVERED,
  accessMatrixFindings,
  buildAccessMatrix,
  shouldReplaceCell,
  type AccessMatrixCell,
  type RoleProbe,
  type RouteProbeObservation,
} from './access-matrix.js';
import { ANONYMOUS_ROLE } from '@qaai/shared';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AT = '2026-10-24T10:00:00.000Z';

function seen(
  routeTemplate: string,
  status: number | null,
  overrides: Partial<RouteProbeObservation> = {},
): RouteProbeObservation {
  return {
    routeTemplate,
    observed: 'ALLOWED',
    status,
    finalUrl: `https://app.test${routeTemplate}`,
    observedAtIso: AT,
    ...overrides,
  };
}

function probe(role: string, observations: RouteProbeObservation[], overrides: Partial<RoleProbe> = {}): RoleProbe {
  return {
    role,
    authProfileId: role === ANONYMOUS_ROLE ? null : `profile-${role}`,
    attemptId: `attempt-${role}`,
    outcome: 'CRAWLED',
    contributed: true,
    detail: null,
    observations,
    ...overrides,
  };
}

function cellFor(
  cells: readonly AccessMatrixCell[],
  routeTemplate: string,
  role: string,
): AccessMatrixCell {
  const found = cells.find((cell) => cell.routeTemplate === routeTemplate && cell.role === role);
  if (!found) throw new Error(`no cell for ${routeTemplate} × ${role}`);
  return found;
}

// ─── The denominator is the union ────────────────────────────────────────────

describe('buildAccessMatrix — the denominator is the union, not each role’s reach', () => {
  it('gives a role a NOT_PROBED cell for a route only another role reached', () => {
    const matrix = buildAccessMatrix({
      routes: ['/', '/admin'],
      probes: [probe(ANONYMOUS_ROLE, [seen('/', 200)]), probe('admin', [seen('/', 200), seen('/admin', 200)])],
    });

    expect(matrix.counts.cells).toBe(4);
    const cell = cellFor(matrix.cells, '/admin', ANONYMOUS_ROLE);
    expect(cell.outcome).toBe('NOT_PROBED');
    expect(cell.notProbedBecause).toBe(NOT_PROBED_NOT_DISCOVERED);
    // The one thing it may never be.
    expect(cell.outcome).not.toBe('ALLOWED');
  });

  it('never puts a status or a timestamp on a cell nobody asked about', () => {
    const matrix = buildAccessMatrix({
      routes: ['/', '/admin'],
      probes: [probe('member', [seen('/', 200)])],
    });

    const cell = cellFor(matrix.cells, '/admin', 'member');
    expect(cell.status).toBeNull();
    expect(cell.probedAtIso).toBeNull();
    expect(cell.finalUrl).toBeNull();
  });

  it('counts measured, declared and not-probed separately and never folds them', () => {
    const matrix = buildAccessMatrix({
      routes: ['/', '/admin', '/billing'],
      probes: [probe('admin', [seen('/', 200), seen('/admin', 403, { observed: 'DENIED' })])],
      declarations: [
        { routeTemplate: '/billing', role: 'admin', outcome: 'FORBIDDEN', source: 'middleware.ts' },
      ],
    });

    expect(matrix.counts).toEqual({
      measured: 2,
      erroredObserved: 0,
      declared: 1,
      notProbed: 0,
      cells: 3,
    });
  });
});

// ─── A failed login is not an empty role ─────────────────────────────────────

describe('buildAccessMatrix — a role whose crawl failed is not a role with no surface', () => {
  it('records the login failure as the reason for every cell in that column', () => {
    const matrix = buildAccessMatrix({
      routes: ['/', '/admin'],
      probes: [
        probe(ANONYMOUS_ROLE, [seen('/', 200)]),
        probe('admin', [], {
          outcome: 'LOGIN_FAILED',
          contributed: false,
          detail: 'the success locator never appeared',
        }),
      ],
    });

    const cells = matrix.cells.filter((cell) => cell.role === 'admin');
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.outcome).toBe('NOT_PROBED');
      expect(cell.notProbedBecause).toContain('LOGIN_FAILED');
      expect(cell.notProbedBecause).toContain('the success locator never appeared');
    }
  });

  it('refuses the observations of a crawl that RAN and was not accepted', () => {
    /*
     * The dangerous shape: a bot wall answers 200 on every route and the
     * navigation "succeeded", so these look exactly like access facts. Stored,
     * they are a wall of fabricated findings.
     */
    const matrix = buildAccessMatrix({
      routes: ['/admin'],
      probes: [
        probe('admin', [seen('/admin', 200, { finalUrl: 'https://app.test/challenge' })], {
          outcome: 'CRAWLED',
          contributed: false,
          detail: 'held as REJECTED: a bot challenge was classified',
        }),
      ],
    });

    const cell = cellFor(matrix.cells, '/admin', 'admin');
    expect(cell.outcome).toBe('NOT_PROBED');
    expect(cell.notProbedBecause).toContain('not accepted as a denominator');
    expect(cell.notProbedBecause).toContain('evidence about the crawl and not about authorization');
  });

  it('distinguishes a crawl that ran from one that never got in', () => {
    const ran = buildAccessMatrix({
      routes: ['/x'],
      probes: [probe('a', [seen('/x', 200)], { contributed: false, outcome: 'CRAWLED_PARTIAL' })],
    });
    const never = buildAccessMatrix({
      routes: ['/x'],
      probes: [probe('b', [], { contributed: false, outcome: 'LOGIN_UNAVAILABLE' })],
    });

    expect(cellFor(ran.cells, '/x', 'a').notProbedBecause).toContain('ran and was not accepted');
    expect(cellFor(never.cells, '/x', 'b').notProbedBecause).toContain('no crawl as this role contributed');
  });

  it('reports every not-probed reason as a count AND a reason', () => {
    const matrix = buildAccessMatrix({
      routes: ['/', '/admin', '/billing'],
      probes: [
        probe('admin', [], { contributed: false, outcome: 'LOGIN_FAILED', detail: 'bad password' }),
        probe('member', [seen('/', 200)]),
      ],
    });

    expect(matrix.gaps[0]?.cells).toBe(3);
    expect(matrix.gaps[0]?.reason).toContain('LOGIN_FAILED');
    expect(matrix.gaps[0]?.reason).toContain('bad password');
    expect(matrix.gaps.reduce((total, gap) => total + gap.cells, 0)).toBe(matrix.counts.notProbed);
  });
});

// ─── Status derivation is not re-decided here ────────────────────────────────

describe('buildAccessMatrix — the status, not the coarse label, decides', () => {
  it('reads a soft redirect to the login wall as REDIRECTED_TO_LOGIN, not ALLOWED', () => {
    const matrix = buildAccessMatrix({
      routes: ['/admin'],
      probes: [
        probe(ANONYMOUS_ROLE, [
          // A single-page app: 200, navigation succeeded, login form rendered.
          seen('/admin', 200, { finalUrl: 'https://app.test/login?next=%2Fadmin' }),
        ]),
      ],
      loginRoutes: ['/login'],
    });

    expect(cellFor(matrix.cells, '/admin', ANONYMOUS_ROLE).outcome).toBe('REDIRECTED_TO_LOGIN');
  });

  it('keeps a 403 and a 404 apart, because one confirms the route exists', () => {
    const matrix = buildAccessMatrix({
      routes: ['/admin', '/secret'],
      probes: [
        probe('member', [
          seen('/admin', 403, { observed: 'DENIED' }),
          seen('/secret', 404, { observed: 'DENIED' }),
        ]),
      ],
    });

    expect(cellFor(matrix.cells, '/admin', 'member').outcome).toBe('FORBIDDEN');
    expect(cellFor(matrix.cells, '/secret', 'member').outcome).toBe('NOT_FOUND');
  });

  it('counts an ERRORED cell as observed-but-unmeasured, never as a refusal', () => {
    const matrix = buildAccessMatrix({
      routes: ['/admin'],
      probes: [probe('member', [seen('/admin', 429, { observed: 'DENIED' })])],
    });

    const cell = cellFor(matrix.cells, '/admin', 'member');
    expect(cell.outcome).toBe('ERRORED');
    expect(matrix.counts.measured).toBe(0);
    expect(matrix.counts.erroredObserved).toBe(1);
  });

  it('drops the status when the navigation taught us nothing', () => {
    const matrix = buildAccessMatrix({
      routes: ['/x'],
      probes: [probe('a', [seen('/x', 200, { observed: 'UNKNOWN' })])],
    });

    const cell = cellFor(matrix.cells, '/x', 'a');
    expect(cell.outcome).toBe('NOT_PROBED');
    expect(cell.status).toBeNull();
    expect(cell.notProbedBecause).toContain('nothing was learned about authorization');
  });
});

// ─── Observation beats declaration ───────────────────────────────────────────

describe('buildAccessMatrix — a declaration never overwrites a measurement', () => {
  it('keeps the observation and marks only the unobserved cell as inferred', () => {
    const matrix = buildAccessMatrix({
      routes: ['/admin', '/billing'],
      probes: [probe('member', [seen('/admin', 200)])],
      declarations: [
        { routeTemplate: '/admin', role: 'member', outcome: 'FORBIDDEN', source: 'middleware.ts' },
        { routeTemplate: '/billing', role: 'member', outcome: 'FORBIDDEN', source: 'middleware.ts' },
      ],
    });

    const observed = cellFor(matrix.cells, '/admin', 'member');
    expect(observed.basis).toBe('OBSERVED');
    expect(observed.outcome).toBe('ALLOWED');
    expect(observed.inferredFrom).toBeNull();

    const inferred = cellFor(matrix.cells, '/billing', 'member');
    expect(inferred.basis).toBe('DECLARED');
    expect(inferred.inferredFrom).toBe('middleware.ts');
    expect(inferred.status).toBeNull();
    expect(inferred.probedAtIso).toBeNull();
  });
});

// ─── The findings ────────────────────────────────────────────────────────────

describe('accessMatrixFindings — the two findings worth computing a matrix for', () => {
  const contradiction = () =>
    buildAccessMatrix({
      routes: ['/reports'],
      probes: [
        probe(ANONYMOUS_ROLE, [seen('/reports', 200)]),
        probe('member', [seen('/reports', 403, { observed: 'DENIED' })]),
      ],
    });

  it('reports a route served to a logged-out visitor and refused to a role', () => {
    const findings = accessMatrixFindings(contradiction());
    const security = findings.filter((finding) => finding.kind === 'ANONYMOUS_ALLOWED_BEHIND_WALL');

    expect(security).toHaveLength(1);
    expect(security[0]?.severity).toBe('SECURITY');
    expect(security[0]?.routeTemplate).toBe('/reports');
    expect(security[0]?.detail).toContain('public by accident');
    // The evidence, not just the verdict.
    expect(security[0]?.evidence).toContain('status 200');
    expect(security[0]?.evidence).toContain('status 403');
  });

  it('does NOT report the login page, where the contradiction is correct', () => {
    const matrix = buildAccessMatrix({
      routes: ['/login'],
      probes: [
        probe(ANONYMOUS_ROLE, [seen('/login', 200)]),
        probe('member', [seen('/login', 403, { observed: 'DENIED' })]),
      ],
    });

    const findings = accessMatrixFindings(matrix, { loginRoutes: ['/login'] });
    expect(findings.filter((f) => f.kind === 'ANONYMOUS_ALLOWED_BEHIND_WALL')).toHaveLength(0);
  });

  it('does not raise the finding from a NOT_PROBED cell', () => {
    const matrix = buildAccessMatrix({
      routes: ['/reports'],
      probes: [
        probe(ANONYMOUS_ROLE, [seen('/reports', 200)]),
        probe('member', [], { contributed: false, outcome: 'LOGIN_FAILED' }),
      ],
    });

    expect(
      accessMatrixFindings(matrix).filter((f) => f.kind === 'ANONYMOUS_ALLOWED_BEHIND_WALL'),
    ).toHaveLength(0);
  });

  it('does not treat a 404 as the refusal half of the contradiction', () => {
    const matrix = buildAccessMatrix({
      routes: ['/reports'],
      probes: [
        probe(ANONYMOUS_ROLE, [seen('/reports', 200)]),
        probe('member', [seen('/reports', 404, { observed: 'DENIED' })]),
      ],
    });

    expect(
      accessMatrixFindings(matrix).filter((f) => f.kind === 'ANONYMOUS_ALLOWED_BEHIND_WALL'),
    ).toHaveLength(0);
  });

  it('reports a declared restriction the application does not enforce', () => {
    const declarations = [
      { routeTemplate: '/admin', role: 'member', outcome: 'FORBIDDEN' as const, source: 'middleware.ts' },
    ];
    const matrix = buildAccessMatrix({
      routes: ['/admin'],
      probes: [probe('member', [seen('/admin', 200)])],
      declarations,
    });

    const findings = accessMatrixFindings(matrix, { declarations });
    const gap = findings.find((f) => f.kind === 'DECLARED_ROLE_NOT_ENFORCED');
    expect(gap?.severity).toBe('SECURITY');
    expect(gap?.detail).toContain('is not enforced');
    expect(gap?.evidence).toContain('middleware.ts');
  });

  it('reports the not-probed count per role as an HONESTY finding with its reason', () => {
    const matrix = buildAccessMatrix({
      routes: ['/', '/admin'],
      probes: [
        probe('member', [seen('/', 200)]),
        probe('admin', [], { contributed: false, outcome: 'LOGIN_UNAVAILABLE', detail: 'no adapter' }),
      ],
    });

    const findings = accessMatrixFindings(matrix);
    const member = findings.find((f) => f.kind === 'ROLE_NOT_PROBED' && f.role === 'member');
    const admin = findings.find((f) => f.kind === 'ROLE_NOT_PROBED' && f.role === 'admin');

    expect(member?.cells).toBe(1);
    expect(member?.severity).toBe('HONESTY');
    expect(admin?.cells).toBe(2);
    expect(admin?.evidence).toContain('LOGIN_UNAVAILABLE');
  });

  it('raises no honesty finding for a role every route was measured for', () => {
    const matrix = buildAccessMatrix({
      routes: ['/'],
      probes: [probe('member', [seen('/', 200)])],
    });

    expect(accessMatrixFindings(matrix).filter((f) => f.kind === 'ROLE_NOT_PROBED')).toHaveLength(0);
  });
});

// ─── Overwriting a stored cell ───────────────────────────────────────────────

describe('shouldReplaceCell — an observation is never overwritten with "nobody asked"', () => {
  it('keeps the stored measurement when this crawl did not probe the cell', () => {
    const verdict = shouldReplaceCell(
      { outcome: 'FORBIDDEN', basis: 'OBSERVED' },
      { outcome: 'NOT_PROBED', basis: 'OBSERVED' },
    );

    expect(verdict.replace).toBe(false);
    expect(verdict.why).toContain('kept rather than overwritten');
  });

  it('keeps the stored measurement against a mere declaration', () => {
    expect(
      shouldReplaceCell(
        { outcome: 'ALLOWED', basis: 'OBSERVED' },
        { outcome: 'FORBIDDEN', basis: 'DECLARED' },
      ).replace,
    ).toBe(false);
  });

  it('lets a fresh observation replace anything', () => {
    for (const existing of [
      { outcome: 'NOT_PROBED' as const, basis: 'OBSERVED' as const },
      { outcome: 'FORBIDDEN' as const, basis: 'DECLARED' as const },
      { outcome: 'ALLOWED' as const, basis: 'OBSERVED' as const },
    ]) {
      expect(shouldReplaceCell(existing, { outcome: 'FORBIDDEN', basis: 'OBSERVED' }).replace).toBe(
        true,
      );
    }
  });

  it('writes a cell that is not there yet', () => {
    expect(shouldReplaceCell(null, { outcome: 'NOT_PROBED', basis: 'OBSERVED' }).replace).toBe(true);
  });

  it('lets a declaration replace a stored NOT_PROBED', () => {
    expect(
      shouldReplaceCell(
        { outcome: 'NOT_PROBED', basis: 'OBSERVED' },
        { outcome: 'FORBIDDEN', basis: 'DECLARED' },
      ).replace,
    ).toBe(true);
  });
});

// ─── The vocabulary cannot drift ─────────────────────────────────────────────

describe('the finding vocabulary', () => {
  it('has a label for exactly the kinds that exist, and no others', () => {
    expect(Object.keys(ACCESS_FINDING_KIND_LABELS).sort()).toEqual([...ACCESS_FINDING_KINDS].sort());
  });

  it('emits only kinds the vocabulary names', () => {
    const matrix = buildAccessMatrix({
      routes: ['/reports'],
      probes: [
        probe(ANONYMOUS_ROLE, [seen('/reports', 200)]),
        probe('member', [seen('/reports', 403, { observed: 'DENIED' })]),
      ],
    });

    for (const finding of accessMatrixFindings(matrix)) {
      expect(ACCESS_FINDING_KINDS).toContain(finding.kind);
    }
  });
});
