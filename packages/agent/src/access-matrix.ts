/**
 * The route × role access matrix: half the app, per identity.
 *
 * WHY THIS FILE EXISTS
 *
 * `reconcile.ts` says "your source declares 412 routes, the crawl reached 25".
 * That sentence has no ROLE in it, and the role is where the expensive defects
 * are. Until this module there was no axis at all to put one on: the explore
 * processor took `authProfile.findFirst({ orderBy: { createdAt: 'asc' } })` —
 * ONE identity for an entire crawl — and `crawler.ts` writes
 * `requiresRoles: []` unconditionally, so admin, member and viewer surfaces
 * were not uncovered, they were ABSENT. Authorization coverage had no
 * denominator, and "a member gets 403 on /admin" was unsayable.
 *
 * This module turns the per-role passes the processor now runs into the cells
 * that make it sayable, and into the two findings that make computing them
 * worth the browser time:
 *
 *   · the SECURITY finding — a route served to an identity that another
 *     identity is refused on, or served against a declaration that says it
 *     should not be;
 *   · the HONESTY finding — a (route, role) cell nobody asked about, which must
 *     render as NOT_PROBED and must never, under any aggregation, render as
 *     ALLOWED. The product's claim is "412 routes, 25 covered, here are the
 *     387"; on this axis the same claim is "this role was never asked about
 *     these 94 routes", and a matrix that silently filled them in would make
 *     the whole axis worthless.
 *
 * ── IT IS PURE, AND THAT IS THE POINT ───────────────────────────────────────
 *
 * No browser, no Prisma, no clock. Every input is an observation somebody else
 * made; every output is a row somebody else stores. Playwright cannot drive a
 * browser in a unit test, so the module that decides what a crawl MEANT has to
 * be separable from the one that ran it — and the decisions here are exactly
 * the ones that can turn into a lie.
 *
 * ── THE VOCABULARY IS NOT RESTATED ──────────────────────────────────────────
 *
 * `RouteAccessOutcome`, `RouteAccessBasis`, `routeAccessOutcomeFrom`,
 * `roleKey`, `ANONYMOUS_ROLE`, `RoleCrawlOutcome` and `CRAWLED_ROLE_OUTCOMES`
 * all come from packages/shared/src/auth-profiles.ts, which owns them and is
 * mirrored by the Prisma enums. Nothing here re-decides what a status means:
 * `routeAccessOutcomeFrom` is the single derivation and this file calls it.
 *
 * ── WHY NO CELL IS EVER INFERRED FROM A CRAWL ───────────────────────────────
 *
 * {@link AccessMatrixCell.inferredFrom} exists and is populated only from
 * {@link RouteRoleDeclaration} — a source that CLAIMS something about a role.
 * Two crawl-derived inferences were considered and both were rejected, because
 * each manufactures a measurement:
 *
 *   · "role R's crawl CONVERGED and never discovered /admin, so /admin is not
 *     R's surface". A route nobody linked to for R is a route nobody asked
 *     about as R. Not discovering a link is not a measurement of access, and
 *     calling it NOT_FOUND would invent a 404 the application never sent.
 *   · "role R got ALLOWED on /orders/1, so R is ALLOWED on /orders/2". The
 *     cells are keyed on the TEMPLATE for exactly this reason, so there is
 *     nothing to infer — and per-instance authorization (R owns order 1 and not
 *     order 2) is a real defect class that an inference like this would hide.
 *
 * So a cell is OBSERVED, DECLARED, or NOT_PROBED with the reason it was not,
 * and the counts of all three are reported side by side.
 */

import { matchesGlob } from '@qaai/shared';
import type { AccessOutcome } from '@qaai/shared';
import {
  ANONYMOUS_ROLE,
  CRAWLED_ROLE_OUTCOMES,
  isRouteAccessMeasured,
  roleKey,
  routeAccessOutcomeFrom,
} from '@qaai/shared';
import type {
  RoleCrawlOutcome,
  RouteAccessBasis,
  RouteAccessOutcome,
} from '@qaai/shared';

// ─── What one pass contributed ───────────────────────────────────────────────

/** One route, as one identity saw it. The raw observation, before derivation. */
export interface RouteProbeObservation {
  /**
   * The normalised route template, spelled as the identity half of
   * `CoverageItem.key` spells it. A second spelling would make this axis
   * unjoinable to the denominator it is supposed to be an axis OF.
   */
  routeTemplate: string;
  /** The coarse crawl outcome, or null when the navigation produced none. */
  observed: AccessOutcome | null;
  /** The HTTP status, or null when no response came back. Never 0. */
  status: number | null;
  finalUrl: string | null;
  observedAtIso: string;
}

/**
 * One identity's whole attempt, as the matrix needs it.
 *
 * `contributed` IS THE FIELD THAT PREVENTS THE WORST LIE AVAILABLE HERE. A
 * crawl that was held — a bot wall, a site that was down, a session that had
 * expired — produces observations that look exactly like access facts: every
 * route REDIRECTED_TO_LOGIN, or every route ERRORED. Storing them would turn
 * one bad afternoon into a wall of fabricated authorization findings. So a pass
 * that did not contribute has every cell written as NOT_PROBED with its
 * outcome as the reason, which is the honest form of the same information:
 * nobody asked, and here is why.
 */
export interface RoleProbe {
  /** `roleKey()`-spelled. {@link ANONYMOUS_ROLE} for the logged-out pass. */
  role: string;
  /** Null for the anonymous pass, which needs no profile. */
  authProfileId: string | null;
  /** The stored `RoleCrawlAttempt.id`, when the row was written. */
  attemptId: string | null;
  outcome: RoleCrawlOutcome;
  /**
   * Whether this pass's observations may be trusted as access facts. False for
   * every outcome outside {@link CRAWLED_ROLE_OUTCOMES}, and the caller may set
   * it false for a crawl those outcomes cover whose ACCEPTANCE was degraded —
   * see `roleProbeFrom`.
   */
  contributed: boolean;
  /** Why not, when `contributed` is false. Rendered; never a credential. */
  detail: string | null;
  observations: readonly RouteProbeObservation[];
}

/**
 * A claim about a role, from a source rather than from a request.
 *
 * The enforcement half of the product: a declaration the application does not
 * actually honour is the defect, and the only way to find it is to hold the
 * declaration and the observation up next to each other. Nothing in the repo
 * declares route roles yet — `route-manifest.ts` extracts templates and no
 * role guard — so this arrives EMPTY today and {@link AccessMatrix.counts}
 * says so rather than leaving a reader to assume the column was checked.
 */
export interface RouteRoleDeclaration {
  routeTemplate: string;
  /** `roleKey()`-spelled, like every other role in this module. */
  role: string;
  /** What the source says this role gets. */
  outcome: RouteAccessOutcome;
  /** Where the claim came from: a file and a matcher, or a document. */
  source: string;
}

// ─── The cell ────────────────────────────────────────────────────────────────

/**
 * One (route, role) cell, shaped as `RouteAccessCell` stores it.
 *
 * `basis` is the durable two-member enum and is not widened here: an inferred
 * cell IS a declared one — we did not ask — and giving inference its own basis
 * would create a third thing the stored column cannot hold.
 * {@link inferredFrom} carries the derivation beside it so the report can mark
 * the cell, which is the requirement.
 *
 * ── `basis` CARRIES NO MEANING WHEN `outcome` IS NOT_PROBED ─────────────────
 *
 * A NOT_PROBED cell is written with basis OBSERVED, and that pair reads as a
 * contradiction on its own: OBSERVED means "we asked as that role and this is
 * what came back", which is the opposite of "nobody asked". There is no third
 * member to write and DECLARED would be a worse lie — it claims a source said
 * so — so the invariant is stated here instead of being left for a reader to
 * infer: ON A NOT_PROBED CELL, `basis` IS UNDEFINED AND MUST NOT BE READ.
 * `isRouteAccessMeasured` enforces it by requiring both halves, and every
 * reader in the repo pairs them the same way. A reader that groups by `basis`
 * ALONE to count "cells we asked about" would count every gap as a probe,
 * which is this axis's worst available defect wearing an aggregation's hat.
 */
export interface AccessMatrixCell {
  routeTemplate: string;
  role: string;
  outcome: RouteAccessOutcome;
  basis: RouteAccessBasis;
  /** NULL when `basis` is DECLARED or `outcome` is NOT_PROBED. */
  status: number | null;
  finalUrl: string | null;
  /** NULL when nothing asked. A timestamp would make the cell look measured. */
  probedAtIso: string | null;
  authProfileId: string | null;
  attemptId: string | null;
  /** NULL when observed; the derivation and its source when not. */
  inferredFrom: string | null;
  /**
   * Why nobody asked. Non-null EXACTLY when `outcome` is NOT_PROBED, which the
   * parity test asserts in both directions — a NOT_PROBED cell with no reason
   * is the gap this product sells rendered as a shrug.
   */
  notProbedBecause: string | null;
}

/** How many cells each basis accounts for, and the ones nobody asked about. */
export interface AccessMatrixCounts {
  /** OBSERVED and a measurement of authorization. `isRouteAccessMeasured`. */
  measured: number;
  /** OBSERVED, asked, and no answer about authorization came back: ERRORED. */
  erroredObserved: number;
  /** DECLARED: a source said so and nobody asked. Never counted as measured. */
  declared: number;
  notProbed: number;
  /** routes × roles. The denominator this axis finally has. */
  cells: number;
}

export interface AccessMatrix {
  /** Every route template in the union, sorted. */
  routes: readonly string[];
  /** Every role the matrix has a column for, sorted, anonymous included. */
  roles: readonly string[];
  cells: readonly AccessMatrixCell[];
  counts: AccessMatrixCounts;
  /**
   * The NOT_PROBED cells grouped by reason, largest first.
   *
   * A COUNT AND A REASON, per the disclosure rule: "94 cells were not probed"
   * is a number nobody can act on, and "the admin login failed, so 94 cells
   * were not probed" is a sentence with a fix in it.
   */
  gaps: ReadonlyArray<{ reason: string; cells: number }>;
}

// ─── Building it ─────────────────────────────────────────────────────────────

/**
 * The reason a cell is NOT_PROBED when the pass ran and simply never went
 * there.
 *
 * Its own constant because it is the COMMON case and it has to read the same
 * way everywhere: a role's crawl follows the links that role was shown, so a
 * route another identity reached is routinely one this identity never had
 * offered to it. That is a gap in our enumeration, stated plainly, and not a
 * fact about the application.
 */
export const NOT_PROBED_NOT_DISCOVERED =
  "this role's crawl never reached this route, and QAAI does not yet re-probe a " +
  'route a role was not shown — so nobody asked what this role gets here';

/**
 * Builds the matrix.
 *
 * ── ORDER OF PRECEDENCE, AND WHY IT IS NOT NEGOTIABLE ──────────────────────
 *
 *   1. an OBSERVED cell from a contributing pass;
 *   2. a DECLARED cell from a source;
 *   3. NOT_PROBED with a reason.
 *
 * A measurement always beats a declaration, because the whole value of holding
 * the two side by side is detecting where they DISAGREE — and a declaration
 * allowed to overwrite the observation would erase the finding it exists to
 * produce. Downward is equally forbidden: nothing here may turn an observation
 * into "nobody asked", which is `ACCESS_OUTCOME_TO_ROUTE_ACCESS`'s rule one
 * level up and is the same rule.
 *
 * `routes` is supplied rather than derived from the probes, because the
 * denominator is the UNION — a route only the admin pass reached is a route the
 * member pass must have a NOT_PROBED cell for. Deriving the route list per role
 * would make every role's denominator its own reachable set, which is precisely
 * how authorization coverage came to be 100% of nothing.
 */
export function buildAccessMatrix(input: {
  routes: readonly string[];
  probes: readonly RoleProbe[];
  declarations?: readonly RouteRoleDeclaration[];
  /** Login route globs, so a soft redirect to the wall is not read as served. */
  loginRoutes?: readonly string[];
}): AccessMatrix {
  const loginRoutes = input.loginRoutes ?? [];
  const routes = [...new Set(input.routes)].sort();
  const roles = [...new Set(input.probes.map((probe) => roleKey(probe.role)))].sort();

  const observed = new Map<string, AccessMatrixCell>();
  const skipReason = new Map<string, string>();

  for (const probe of input.probes) {
    const role = roleKey(probe.role);
    if (!probe.contributed) {
      /*
       * The whole pass is a non-measurement. Recorded ONCE as the reason for
       * every cell in the column rather than per observation, because the
       * observations are the thing being refused: a held crawl's statuses are
       * evidence about the crawl and not about authorization.
       */
      skipReason.set(role, reasonForUncontributedPass(probe));
      continue;
    }
    for (const observation of probe.observations) {
      const outcome = routeAccessOutcomeFrom({
        observed: observation.observed,
        status: observation.status,
        finalUrl: observation.finalUrl,
        loginRoutes,
      });
      const key = cellKey(observation.routeTemplate, role);
      const cell: AccessMatrixCell = {
        routeTemplate: observation.routeTemplate,
        role,
        outcome,
        basis: 'OBSERVED',
        // NOT_PROBED is what `routeAccessOutcomeFrom` returns for an UNKNOWN
        // coarse outcome: we drove the navigation and learned nothing. The
        // status goes to null with it, because a status beside "nobody asked"
        // reads as a measurement.
        status: outcome === 'NOT_PROBED' ? null : observation.status,
        finalUrl: outcome === 'NOT_PROBED' ? null : observation.finalUrl,
        probedAtIso: outcome === 'NOT_PROBED' ? null : observation.observedAtIso,
        authProfileId: probe.authProfileId,
        attemptId: probe.attemptId,
        inferredFrom: null,
        notProbedBecause:
          outcome === 'NOT_PROBED'
            ? 'the navigation produced no outcome we could read, so nothing was learned about ' +
              'authorization here'
            : null,
      };
      const existing = observed.get(key);
      /*
       * Two states of one route in one pass: keep the one that is a
       * measurement, and otherwise the FIRST one.
       *
       * A 403 and a 200 on the same template from ONE identity is per-instance
       * authorization — R owns order 1 and not order 2 — and the template cell
       * cannot hold both. An earlier draft of this comment said the finding set
       * reports it. IT DOES NOT: {@link ACCESS_FINDING_KINDS} has three members
       * and none of them is about two instances of one template disagreeing, so
       * the divergence is currently DISCARDED here and reported nowhere. It is
       * named in the slice's open problems rather than left as a claim in a
       * comment, because a reader who believed the claim would stop looking.
       *
       * The surviving cell is therefore whichever instance the crawl reached
       * first, which also means this cell is not reproducible across crawls
       * that visit instances in a different order. Picking a policy instead —
       * the refusal always wins, or the grant always wins — is a decision about
       * what the product CLAIMS on this axis and is deliberately not made as a
       * side effect of a de-duplication branch.
       */
      if (existing === undefined || preferFresh(existing, cell)) observed.set(key, cell);
    }
  }

  const declared = new Map<string, RouteRoleDeclaration>();
  for (const declaration of input.declarations ?? []) {
    declared.set(cellKey(declaration.routeTemplate, roleKey(declaration.role)), declaration);
  }

  const cells: AccessMatrixCell[] = [];
  for (const routeTemplate of routes) {
    for (const role of roles) {
      const key = cellKey(routeTemplate, role);
      const measured = observed.get(key);
      if (measured) {
        cells.push(measured);
        continue;
      }
      const claim = declared.get(key);
      if (claim) {
        cells.push({
          routeTemplate,
          role,
          outcome: claim.outcome,
          basis: 'DECLARED',
          // Both null by the column's contract: a declaration carries no
          // status and no destination, and writing one would be inventing a
          // measurement out of a claim.
          status: null,
          finalUrl: null,
          probedAtIso: null,
          authProfileId: profileForRole(input.probes, role),
          attemptId: attemptForRole(input.probes, role),
          inferredFrom: claim.source,
          notProbedBecause: null,
        });
        continue;
      }
      cells.push({
        routeTemplate,
        role,
        outcome: 'NOT_PROBED',
        basis: 'OBSERVED',
        status: null,
        finalUrl: null,
        probedAtIso: null,
        authProfileId: profileForRole(input.probes, role),
        attemptId: attemptForRole(input.probes, role),
        inferredFrom: null,
        notProbedBecause: skipReason.get(role) ?? NOT_PROBED_NOT_DISCOVERED,
      });
    }
  }

  const gapCounts = new Map<string, number>();
  let measured = 0;
  let erroredObserved = 0;
  let declaredCount = 0;
  let notProbed = 0;
  for (const cell of cells) {
    if (cell.outcome === 'NOT_PROBED') {
      notProbed += 1;
      const reason = cell.notProbedBecause ?? NOT_PROBED_NOT_DISCOVERED;
      gapCounts.set(reason, (gapCounts.get(reason) ?? 0) + 1);
      continue;
    }
    if (cell.basis === 'DECLARED') {
      declaredCount += 1;
      continue;
    }
    if (isRouteAccessMeasured(cell)) measured += 1;
    else erroredObserved += 1;
  }

  return {
    routes,
    roles,
    cells,
    counts: {
      measured,
      erroredObserved,
      declared: declaredCount,
      notProbed,
      cells: routes.length * roles.length,
    },
    gaps: [...gapCounts.entries()]
      .map(([reason, count]) => ({ reason, cells: count }))
      .sort((a, b) => b.cells - a.cells || a.reason.localeCompare(b.reason)),
  };
}

function cellKey(routeTemplate: string, role: string): string {
  return `${role}\u0000${routeTemplate}`;
}

/** A measurement beats a non-measurement; otherwise the first one stands. */
function preferFresh(existing: AccessMatrixCell, fresh: AccessMatrixCell): boolean {
  const had = existing.outcome !== 'NOT_PROBED';
  const has = fresh.outcome !== 'NOT_PROBED';
  return !had && has;
}

function profileForRole(probes: readonly RoleProbe[], role: string): string | null {
  return probes.find((probe) => roleKey(probe.role) === role)?.authProfileId ?? null;
}

function attemptForRole(probes: readonly RoleProbe[], role: string): string | null {
  return probes.find((probe) => roleKey(probe.role) === role)?.attemptId ?? null;
}

/**
 * The sentence a whole refused column carries.
 *
 * It names the OUTCOME, because that is what distinguishes the two facts rule
 * ten is about: LOGIN_FAILED is "we could not get in as this role" and
 * CRAWLED-but-held is "we got in and the crawl was not trustworthy". Both
 * produce zero measured cells and they are not the same problem.
 */
function reasonForUncontributedPass(probe: RoleProbe): string {
  const ran = (CRAWLED_ROLE_OUTCOMES as readonly string[]).includes(probe.outcome);
  const detail = probe.detail === null || probe.detail === '' ? '' : ` — ${probe.detail}`;
  return ran
    ? `the crawl as this role ran and was not accepted as a denominator (${probe.outcome})${detail}, ` +
        'so its statuses are evidence about the crawl and not about authorization'
    : `no crawl as this role contributed (${probe.outcome})${detail}, so nobody asked what this ` +
        'role gets here';
}

// ─── The findings ────────────────────────────────────────────────────────────

/**
 * What the matrix is FOR. Three kinds, and the third is not a consolation.
 *
 *   ANONYMOUS_ALLOWED_BEHIND_WALL  a logged-out visitor was served a route that
 *                                  an authenticated identity is REFUSED on.
 *                                  The application's own two answers contradict
 *                                  each other, which needs no declaration to be
 *                                  a finding and no model to detect.
 *   DECLARED_ROLE_NOT_ENFORCED     a source says this role does not get this
 *                                  route and the route was served to it. The
 *                                  enforcement gap — the reason OBSERVED and
 *                                  DECLARED are different bases.
 *   ROLE_NOT_PROBED                this role was never asked about N routes.
 *                                  Reported as a finding rather than left as an
 *                                  absence, because an absence renders as a
 *                                  clean column and a clean column is the lie.
 */
export const ACCESS_FINDING_KINDS = [
  'ANONYMOUS_ALLOWED_BEHIND_WALL',
  'DECLARED_ROLE_NOT_ENFORCED',
  'ROLE_NOT_PROBED',
] as const;
export type AccessFindingKind = (typeof ACCESS_FINDING_KINDS)[number];

/**
 * COMPILER-ENFORCED PRESENCE, with a run-time parity test beside it.
 *
 * Both halves, because each catches what the other cannot: a fourth kind added
 * to the union breaks this line, and the test asserts the keys are exactly the
 * union at run time, which the compiler cannot do for a list. Eight `GateRule`
 * kinds shipped unusable for two slices because only one of the two existed.
 */
export const ACCESS_FINDING_KIND_LABELS: Record<AccessFindingKind, string> = {
  ANONYMOUS_ALLOWED_BEHIND_WALL: 'served to a logged-out visitor, refused to a signed-in role',
  DECLARED_ROLE_NOT_ENFORCED: 'a declared restriction the application does not enforce',
  ROLE_NOT_PROBED: 'routes this role was never asked about',
};

export interface AccessFinding {
  kind: AccessFindingKind;
  /** SECURITY for the first two; HONESTY for the third. Not interchangeable. */
  severity: 'SECURITY' | 'HONESTY';
  routeTemplate: string | null;
  role: string;
  /** One sentence a customer can act on. */
  detail: string;
  /** The cells it rests on — status and final url, or the count. */
  evidence: string;
  /** How many cells this finding accounts for. 1 for the per-route kinds. */
  cells: number;
}

/** The outcomes that are a refusal ON IDENTITY GROUNDS. A 404 is not one. */
const REFUSED_OUTCOMES: ReadonlyArray<RouteAccessOutcome> = ['FORBIDDEN', 'REDIRECTED_TO_LOGIN'];

/**
 * Reads the two findings out of the matrix, plus the honesty count.
 *
 * ── WHY LOGIN ROUTES ARE EXCLUDED FROM THE SECURITY FINDING ────────────────
 *
 * Because the login page is the one route where the contradiction is CORRECT: a
 * logged-out visitor is served it and a signed-in one is bounced off it. Left
 * in, every application in the world produces this finding on its first run and
 * the finding becomes noise, which is how a real one gets ignored.
 */
export function accessMatrixFindings(
  matrix: AccessMatrix,
  options?: { loginRoutes?: readonly string[]; declarations?: readonly RouteRoleDeclaration[] },
): AccessFinding[] {
  const loginRoutes = options?.loginRoutes ?? [];
  const findings: AccessFinding[] = [];

  const byRoute = new Map<string, AccessMatrixCell[]>();
  for (const cell of matrix.cells) {
    const list = byRoute.get(cell.routeTemplate);
    if (list) list.push(cell);
    else byRoute.set(cell.routeTemplate, [cell]);
  }

  for (const [routeTemplate, cells] of byRoute) {
    if (loginRoutes.some((glob) => matchesGlob(glob, routeTemplate))) continue;

    const anonymous = cells.find((cell) => cell.role === ANONYMOUS_ROLE);
    const refused = cells.filter(
      (cell) =>
        cell.role !== ANONYMOUS_ROLE &&
        cell.basis === 'OBSERVED' &&
        (REFUSED_OUTCOMES as readonly string[]).includes(cell.outcome),
    );
    if (
      anonymous &&
      anonymous.basis === 'OBSERVED' &&
      anonymous.outcome === 'ALLOWED' &&
      refused.length > 0
    ) {
      findings.push({
        kind: 'ANONYMOUS_ALLOWED_BEHIND_WALL',
        severity: 'SECURITY',
        routeTemplate,
        role: ANONYMOUS_ROLE,
        detail:
          `${routeTemplate} was served to a logged-out visitor and refused to ` +
          `${refused.map((cell) => cell.role).join(', ')}. One of the two answers is wrong, and if ` +
          `the refusal is the intended one this route is public by accident.`,
        evidence: evidenceFor(anonymous, refused),
        cells: 1 + refused.length,
      });
    }
  }

  for (const declaration of options?.declarations ?? []) {
    const role = roleKey(declaration.role);
    const cell = matrix.cells.find(
      (candidate) =>
        candidate.routeTemplate === declaration.routeTemplate && candidate.role === role,
    );
    if (!cell || cell.basis !== 'OBSERVED' || cell.outcome !== 'ALLOWED') continue;
    if (declaration.outcome === 'ALLOWED') continue;
    findings.push({
      kind: 'DECLARED_ROLE_NOT_ENFORCED',
      severity: 'SECURITY',
      routeTemplate: declaration.routeTemplate,
      role,
      detail:
        `${declaration.source} says ${role} should get ${declaration.outcome} on ` +
        `${declaration.routeTemplate}, and the route was served. The declaration is not enforced.`,
      evidence: `observed ${describeCell(cell)}; declared ${declaration.outcome} by ${declaration.source}`,
      cells: 1,
    });
  }

  const notProbedByRole = new Map<string, number>();
  for (const cell of matrix.cells) {
    if (cell.outcome !== 'NOT_PROBED') continue;
    notProbedByRole.set(cell.role, (notProbedByRole.get(cell.role) ?? 0) + 1);
  }
  for (const role of matrix.roles) {
    const count = notProbedByRole.get(role) ?? 0;
    if (count === 0) continue;
    /*
     * The reason is taken from the cells rather than re-derived, so a column
     * refused because the login failed says THAT and not "never discovered".
     * Those are the two opposite facts rule ten is about.
     */
    const reasons = [
      ...new Set(
        matrix.cells
          .filter((cell) => cell.role === role && cell.outcome === 'NOT_PROBED')
          .map((cell) => cell.notProbedBecause ?? NOT_PROBED_NOT_DISCOVERED),
      ),
    ];
    findings.push({
      kind: 'ROLE_NOT_PROBED',
      severity: 'HONESTY',
      routeTemplate: null,
      role,
      detail:
        `${role} was never asked about ${count} of ${matrix.routes.length} route(s) in the ` +
        `denominator, so no authorization claim can be made about them for this role.`,
      evidence: reasons.join('; '),
      cells: count,
    });
  }

  return findings;
}

function describeCell(cell: AccessMatrixCell): string {
  const status = cell.status === null ? 'no status' : `status ${cell.status}`;
  const url = cell.finalUrl === null ? 'no final url' : `landed on ${cell.finalUrl}`;
  return `${cell.outcome} (${status}, ${url})`;
}

function evidenceFor(anonymous: AccessMatrixCell, refused: readonly AccessMatrixCell[]): string {
  return [
    `${ANONYMOUS_ROLE}: ${describeCell(anonymous)}`,
    ...refused.map((cell) => `${cell.role}: ${describeCell(cell)}`),
  ].join('; ');
}

// ─── Writing a cell over one that is already stored ──────────────────────────

/**
 * Whether a fresh cell may replace the stored one.
 *
 * THE DEFECT THIS PREVENTS, which the upsert would otherwise commit on its
 * own: `RouteAccessCell` is unique on (environment, route, role) and the crawl
 * upserts, so the second crawl overwrites the first. A role whose crawl reached
 * /admin in March and did not reach it in April would have a real FORBIDDEN
 * replaced by NOT_PROBED — an observation refined into "nobody asked", which is
 * the one direction `ACCESS_OUTCOME_TO_ROUTE_ACCESS` forbids outright. The
 * measurement is kept, `probedAt` goes on showing when it was taken, and the
 * staleness is visible instead of the fact being destroyed.
 *
 * A DECLARATION likewise never overwrites a measurement, for the reason the
 * bases exist: the disagreement between them is the finding.
 */
export function shouldReplaceCell(
  existing: { outcome: RouteAccessOutcome; basis: RouteAccessBasis } | null,
  fresh: { outcome: RouteAccessOutcome; basis: RouteAccessBasis },
): { replace: boolean; why: string } {
  if (existing === null) return { replace: true, why: 'no cell was stored for this (route, role)' };

  const existingMeasured = existing.outcome !== 'NOT_PROBED' && existing.basis === 'OBSERVED';
  const freshMeasured = fresh.outcome !== 'NOT_PROBED' && fresh.basis === 'OBSERVED';

  if (freshMeasured) {
    return { replace: true, why: 'a fresh observation always replaces whatever was there' };
  }
  if (existingMeasured) {
    return {
      replace: false,
      why:
        `the stored cell is an observation (${existing.outcome}) and this crawl has no ` +
        `measurement to put in its place, so the measurement is kept rather than overwritten ` +
        `with "nobody asked"`,
    };
  }
  if (fresh.basis === 'DECLARED' && existing.basis === 'OBSERVED') {
    return {
      replace: true,
      why: 'the stored cell was NOT_PROBED and a declaration is more than nothing',
    };
  }
  return { replace: true, why: 'neither cell is a measurement, so the fresher reason wins' };
}
