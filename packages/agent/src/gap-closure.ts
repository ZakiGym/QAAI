/**
 * SESSION-AWARE GAP CLOSURE — the loop that could not converge.
 *
 * ── The defect, exactly ─────────────────────────────────────────────────────
 *
 * An UNREACHED_AUTH_ROUTE gap says "no authenticated test reaches /admin/users".
 * `planItemForGap` answered it with a SECURITY_SMOKE, whose schema can express
 * ONE assertion — that an anonymous visitor is refused. So the test was written,
 * it passed, it covered the WALL and never the page, and the next analysis
 * reported the identical gap. Closing the gap RE-CREATED the gap, for ever, and
 * nothing anywhere noticed that the same gap had now been "closed" four times.
 *
 * Two things were missing, and they are both in this file:
 *
 *   1. THE ROLE WAS NEVER CARRIED. The gap knew the route. Nothing knew WHICH
 *      IDENTITY gets in, so the item could not ask for a session and the test
 *      could not be bound to one. {@link bindRoleForGap} reads that off the
 *      route × role access matrix — a measurement, where one exists — and
 *      {@link closeGapAsRole} carries it onto the plan item as a principal.
 *
 *   2. COVERAGE WAS ATTRIBUTED TO THE ROUTE. One admin test on /admin/users
 *      marked the route covered, which makes "a member is refused here" and "a
 *      viewer is refused here" inexpressible — the cells where the expensive
 *      defects live. {@link roleCoverageCells} attributes to the (route, role)
 *      CELL instead, and counts the cells nobody probed SEPARATELY, because a
 *      cell nobody asked about is not a hole in the customer's suite and
 *      reporting it as one manufactures a denominator.
 *
 * ── Why convergence is ASSERTED and not hoped for ──────────────────────────
 *
 * `rankGapsForClosure` already refuses to retry a gap recorded NOT_CLOSED,
 * which stops the runaway — but stopping a loop is not the same as closing one.
 * {@link verifyConvergence} is the part that makes the loop a loop: it takes the
 * closure this round proposes, PROJECTS what the resulting test will look like
 * to the next analysis, re-runs that analysis through an injected function, and
 * reports whether the gap actually goes away. A closure that would not converge
 * is now a finding BEFORE a generation is spent on it, rather than a gap that
 * comes back next week looking new.
 *
 * It reports UNVERIFIABLE — never CONVERGES, never a zero — when the re-analysis
 * could not see the application or handed back a ranked page instead of the full
 * list. Same rule as `verifyClosure`, and for the same reason: an absent gap is
 * not a closed gap.
 *
 * ── NO MODEL, NO BROWSER, NO CLOCK ──────────────────────────────────────────
 *
 * Every decision here is a rule over facts somebody else measured. The one
 * place a choice among equals is made (which scenario name a closure runs
 * under) takes the RUN SEED and is derived through `createSyntheticFactory`, so
 * the same seed produces byte-identical output and two gaps closing in the same
 * run cannot collide on a name. `Math.random`, `Date.now` and `new Date()` do
 * not appear in this file, and `gap-closure.test.ts` asserts that over its
 * source rather than trusting the reader to notice.
 */

import {
  ANONYMOUS_ROLE,
  createSyntheticFactory,
  isRouteAccessMeasured,
  roleKey,
} from '@qaai/shared';
import type { ExecutableTest, TestType } from '@qaai/shared';
import type { AccessMatrix, AccessMatrixCell } from './access-matrix.js';
import type { CoverageGap, CoverageTestInput, GapKind } from './coverage.js';
import { routeVisits } from './coverage.js';

/*
 * ── DERIVED, NOT IMPORTED, AND THAT IS DELIBERATE ──────────────────────────
 *
 * `Principal` lives in packages/shared/src/principals.ts and that module is NOT
 * on the @qaai/shared barrel yet (the line is owed — see this round's handover).
 * The two ways to reach it today are both worse than this one: a relative
 * import across the workspace boundary compiles and then bypasses the package
 * entry point, which is the defect lesson B exists to stop; and a hand-written
 * copy of the interface is a second declaration that can drift from the first.
 *
 * An indexed-access type off `ExecutableTest` — the contract this module
 * produces FOR — cannot drift by construction: if `principals` changes shape,
 * this changes with it and the compiler says so here.
 *
 * OBSERVED DURING THIS ROUND, and the reason this is not provisional: the
 * `export * from './principals'` line APPEARED in the shared barrel mid-round
 * and was GONE from the file twenty minutes later, overwritten by another
 * agent's write to the same index.ts. A module that imports through a barrel
 * line six parallel agents are racing on does not compile reliably; a module
 * that derives from a type it already consumes compiles either way. When the
 * line is settled, the right-hand sides below become imports and nothing else
 * in this file changes.
 */
export type ClosurePrincipal = NonNullable<ExecutableTest['principals']>[number];

/**
 * The name the run's single session is filed under — `DEFAULT_PRINCIPAL_NAME`
 * from principals.ts, which this package cannot import yet (see above).
 *
 * A duplicated constant with no guard is how two spellings of one identity get
 * into a codebase, so there is a guard: `gap-closure.test.ts` asserts this
 * equals the key `runSessions()` actually synthesises. If principals.ts renames
 * the default, that test goes red here rather than a closure quietly binding a
 * session nothing resolves.
 */
export const CLOSURE_DEFAULT_PRINCIPAL_NAME = 'default';

// ─── Which identity can reach the route ──────────────────────────────────────

/**
 * An auth profile a closure could bind, as the caller holds it.
 *
 * `role` is `AuthProfile.role` — the role the customer said this profile signs
 * in as. Null is common and is not an error; see {@link ROLE_SOURCES} for what
 * happens then. No secret-bearing field, for the same reason
 * `AuthProfileChoice` has none: choosing an identity does not require knowing
 * its password, and this struct travels into text people read.
 */
export interface ClosureAuthProfile {
  id: string;
  name: string;
  /** `AuthProfile.role`. Null means nobody declared one. */
  role: string | null;
}

/**
 * WHERE THE EVIDENCE THAT THIS ROLE GETS IN CAME FROM.
 *
 * Three members and they are not interchangeable — the whole value of the
 * access matrix is that a DECLARATION the application does not honour is itself
 * the defect, so a role taken from a declaration must never be reported as a
 * role we watched walk through the door.
 */
export const ROLE_BINDING_SOURCES = [
  /** The matrix OBSERVED this role being served this route. The only measurement. */
  'OBSERVED_ALLOWED',
  /** A source CLAIMS this role is allowed here. Nobody asked. */
  'DECLARED_ALLOWED',
  /**
   * No matrix evidence either way. The profile is the one `chooseAuthProfile`
   * named from the route's and the profile's own words — a deterministic rule
   * over somebody else's naming, which is the weakest of the three and is still
   * far better than proposing a test that runs as nobody.
   */
  'CHOSEN_PROFILE',
] as const;
export type RoleBindingSource = (typeof ROLE_BINDING_SOURCES)[number];

/** Compile-time half of the parity guard; the run-time half is in the test file. */
const ROLE_BINDING_SOURCE_PRESENT: Record<RoleBindingSource, true> = {
  OBSERVED_ALLOWED: true,
  DECLARED_ALLOWED: true,
  CHOSEN_PROFILE: true,
};

/** Derived, never hand-listed. */
export const ROLE_BINDING_SOURCE_LIST = Object.keys(
  ROLE_BINDING_SOURCE_PRESENT,
) as ReadonlyArray<RoleBindingSource>;

/** True only for the one source that is a measurement. */
export const MEASURED_ROLE_BINDING_SOURCES: ReadonlyArray<RoleBindingSource> =
  ROLE_BINDING_SOURCE_LIST.filter((source) => source === 'OBSERVED_ALLOWED');

/**
 * WHERE THE ROLE STRING CAME FROM, which is a different question from where the
 * access evidence came from and has to be answered separately.
 *
 * Most profiles declare no role. Attributing such a profile's coverage to
 * `roleKey(null)` — `<anonymous>` — would file an authenticated session under
 * the logged-out column, which is the worst available defect on this axis. And
 * refusing to close the gap would re-create the non-convergence this file
 * exists to remove, for the overwhelmingly common case.
 *
 * So the profile's NAME becomes the role, and the binding says so out loud: a
 * profile called "Admin" is the admin role as far as anything here can tell,
 * and a team that disagrees reads one sentence and sets `AuthProfile.role`.
 */
export const ROLE_SOURCES = ['DECLARED_ROLE', 'PROFILE_NAME'] as const;
export type RoleSource = (typeof ROLE_SOURCES)[number];

/** Compile-time half of the parity guard. */
const ROLE_SOURCE_PRESENT: Record<RoleSource, true> = {
  DECLARED_ROLE: true,
  PROFILE_NAME: true,
};

/** Derived, never hand-listed. */
export const ROLE_SOURCE_LIST = Object.keys(ROLE_SOURCE_PRESENT) as ReadonlyArray<RoleSource>;

/**
 * The role a profile signs in as, and where that answer came from.
 *
 * Exported because the attribution in {@link roleCoverageCells} has to spell a
 * role the same way the binding does, and one spelling means one function.
 */
export function roleOfProfile(profile: ClosureAuthProfile): {
  role: string;
  roleSource: RoleSource;
} {
  const declared = typeof profile.role === 'string' ? profile.role.trim() : '';
  if (declared.length > 0) return { role: roleKey(declared), roleSource: 'DECLARED_ROLE' };
  return { role: roleKey(profile.name), roleSource: 'PROFILE_NAME' };
}

/**
 * Why no role could be bound. Every member is a sentence the report prints
 * beside the gap it left open, and NONE of them is a pass.
 */
export const ROLE_BINDING_REFUSALS = [
  /** The gap is not behind an auth wall. Not a refusal — not a question. */
  'NOT_AN_AUTH_GAP',
  /** No route to look up in the matrix, so there is nothing to ask about. */
  'NO_ROUTE',
  /** The project has configured no auth profile. The gap stays open and says so. */
  'NO_PROFILE_CONFIGURED',
  /**
   * We asked, as every identity we could bind, and every one was refused. A
   * signed-in test would assert a page no configured identity can reach, so it
   * would fail for a reason that is not a defect — or worse, be "fixed" by
   * weakening the assertion until it passed.
   */
  'NO_ROLE_REACHES_IT',
] as const;
export type RoleBindingRefusal = (typeof ROLE_BINDING_REFUSALS)[number];

/** Compile-time half of the parity guard. */
const ROLE_BINDING_REFUSAL_PRESENT: Record<RoleBindingRefusal, true> = {
  NOT_AN_AUTH_GAP: true,
  NO_ROUTE: true,
  NO_PROFILE_CONFIGURED: true,
  NO_ROLE_REACHES_IT: true,
};

/** Derived, never hand-listed. */
export const ROLE_BINDING_REFUSAL_LIST = Object.keys(
  ROLE_BINDING_REFUSAL_PRESENT,
) as ReadonlyArray<RoleBindingRefusal>;

/** Exhaustive by `Record`, so a fifth refusal cannot ship without a sentence. */
const REFUSAL_DETAIL: Record<RoleBindingRefusal, string> = {
  NOT_AN_AUTH_GAP:
    'this gap is not behind an auth wall, so there is no role to assume — the anonymous ' +
    'proposal is the correct one',
  NO_ROUTE:
    'this gap names no route, so the access matrix has no cell to look up and no role can be ' +
    'read off it',
  NO_PROFILE_CONFIGURED:
    'no auth profile is configured on this environment, so there is no session a test could be ' +
    'bound to — configure one and this gap closes with a test of the page rather than a test ' +
    'of the wall',
  NO_ROLE_REACHES_IT:
    'every auth profile configured here was measured against this route and every one was ' +
    'refused, so a signed-in test would assert a page none of them can reach — either the route ' +
    'needs a role nobody has configured, or the crawl recorded the wall and not the page',
};

/** The role a gap's test must assume, with the evidence behind it. */
export interface RoleBinding {
  /** `roleKey()`-spelled, so it joins to an access-matrix column. */
  readonly role: string;
  readonly authProfileId: string;
  readonly authProfileName: string;
  /** Where the evidence that this role gets in came from. */
  readonly source: RoleBindingSource;
  /** Where the role STRING came from. A different question; see {@link ROLE_SOURCES}. */
  readonly roleSource: RoleSource;
  /**
   * TRUE only for OBSERVED_ALLOWED.
   *
   * Stored rather than re-derived at every read site for the reason
   * `CoverageGap.requiresAuth` is stored: a property recomputed downstream is a
   * property that can disagree with itself. A reader that groups by `source`
   * alone and counts DECLARED_ALLOWED as evidence would report a claim as a
   * check, which is the lie this flag is shaped to prevent.
   */
  readonly measured: boolean;
  /** One sentence naming the evidence and the alternatives. Printed verbatim. */
  readonly why: string;
}

export type RoleBindingResult =
  | { readonly bound: true; readonly binding: RoleBinding }
  | { readonly bound: false; readonly refusal: RoleBindingRefusal; readonly detail: string };

/** The subset of a gap this module reads. Narrow on purpose: it is also the test fixture. */
export type ClosureGap = Pick<
  CoverageGap,
  'id' | 'kind' | 'route' | 'requiresAuth' | 'authProfile'
>;

/**
 * Which identity should the test for this gap sign in as?
 *
 * ── The order of precedence, and why it is not negotiable ──────────────────
 *
 *   1. A MEASURED ALLOWED CELL. The matrix watched this role be served this
 *      route. Nothing else available here is a measurement, so nothing else may
 *      outrank it.
 *   2. A DECLARED ALLOWED CELL. A source claims it. Weaker, marked as such, and
 *      still a statement somebody made about this exact (route, role) pair.
 *   3. THE PROFILE THE GAP ALREADY NAMED. `chooseAuthProfile` in coverage.ts
 *      picked it deterministically from the route's and the profile's own words.
 *      No access evidence either way — which is the ordinary state of a project
 *      with no per-role crawl yet, and is not a reason to leave the gap open.
 *   4. REFUSE, with the reason, and leave the gap open.
 *
 * `NO_ROLE_REACHES_IT` is checked between 2 and 3 rather than last, because it
 * is the one refusal that OUTRANKS a guess: if we asked every identity we could
 * bind and every one was refused, then the profile rule 3 would pick is one we
 * have already watched bounce off this route. Proposing it anyway produces a
 * test that cannot pass, and a test that cannot pass gets its assertion
 * weakened until it does.
 *
 * Ties inside a rule are broken by role then profile id, so the same matrix and
 * the same profiles always bind the same identity. A gap id is stable across
 * recomputation; the role behind it has to be too, or the ledger is comparing
 * two different closures under one name.
 */
export function bindRoleForGap(input: {
  gap: ClosureGap;
  /** Omit or pass null for a project with no per-role crawl. */
  matrix?: Pick<AccessMatrix, 'cells'> | null;
  profiles: readonly ClosureAuthProfile[];
}): RoleBindingResult {
  const refuse = (refusal: RoleBindingRefusal): RoleBindingResult => ({
    bound: false,
    refusal,
    detail: REFUSAL_DETAIL[refusal],
  });

  if (!input.gap.requiresAuth) return refuse('NOT_AN_AUTH_GAP');
  const route = input.gap.route;
  if (route === null || route === '') return refuse('NO_ROUTE');
  if (input.profiles.length === 0) return refuse('NO_PROFILE_CONFIGURED');

  /*
   * Profiles sorted once, by the role they resolve to and then by id. Sorting
   * by NAME would be the obvious thing and the wrong one: two profiles can
   * share a name, the role is what the matrix is keyed on, and a tiebreak on a
   * field the lookup does not use is a tiebreak that can reorder between runs.
   */
  const candidates = input.profiles
    .map((profile) => ({ profile, ...roleOfProfile(profile) }))
    .sort((a, b) => a.role.localeCompare(b.role) || a.profile.id.localeCompare(b.profile.id));

  const cells = (input.matrix?.cells ?? []).filter((cell) => cell.routeTemplate === route);
  const cellFor = (role: string): AccessMatrixCell | undefined =>
    cells.find((cell) => cell.role === role);

  const bind = (
    candidate: (typeof candidates)[number],
    source: RoleBindingSource,
    why: string,
  ): RoleBindingResult => ({
    bound: true,
    binding: {
      role: candidate.role,
      authProfileId: candidate.profile.id,
      authProfileName: candidate.profile.name,
      source,
      roleSource: candidate.roleSource,
      measured: (MEASURED_ROLE_BINDING_SOURCES as readonly string[]).includes(source),
      why: candidate.roleSource === 'PROFILE_NAME' ? `${why} ${ROLE_FROM_NAME_CAVEAT}` : why,
    },
  });

  // 1. A measurement.
  for (const candidate of candidates) {
    const cell = cellFor(candidate.role);
    if (cell && cell.outcome === 'ALLOWED' && isRouteAccessMeasured(cell)) {
      return bind(
        candidate,
        'OBSERVED_ALLOWED',
        `The access matrix observed the role "${candidate.role}" being served ${route}, so the auth profile "${candidate.profile.name}" is an identity that demonstrably gets in.`,
      );
    }
  }

  // 2. A declaration about this exact cell.
  for (const candidate of candidates) {
    const cell = cellFor(candidate.role);
    if (cell && cell.outcome === 'ALLOWED' && cell.basis === 'DECLARED') {
      return bind(
        candidate,
        'DECLARED_ALLOWED',
        `${cell.inferredFrom ?? 'A source'} declares the role "${candidate.role}" is allowed on ${route} and nobody has asked — so this binding rests on the claim, not on a measurement, and a test that fails here may be the enforcement gap rather than a broken test.`,
      );
    }
  }

  /*
   * 3's precondition: did we already measure every identity we could bind, and
   * were they all refused? `measuredRefusals === candidates.length` is the
   * whole test — a single NOT_PROBED or missing cell among the candidates makes
   * this inconclusive and we fall through to the name-match rather than
   * refusing on incomplete evidence.
   */
  const measuredRefusals = candidates.filter((candidate) => {
    const cell = cellFor(candidate.role);
    return cell !== undefined && isRouteAccessMeasured(cell) && cell.outcome !== 'ALLOWED';
  }).length;
  if (measuredRefusals > 0 && measuredRefusals === candidates.length) {
    return refuse('NO_ROLE_REACHES_IT');
  }

  // 3. The profile the gap already named, from coverage.ts's deterministic rule.
  const chosen = input.gap.authProfile;
  if (chosen) {
    const candidate =
      candidates.find((c) => c.profile.id === chosen.id) ??
      /*
       * The gap named a profile this caller did not pass. That is a real state
       * — the gap travels out through GET /coverage and comes back through
       * POST /propose, and a profile can be deleted in between — and the honest
       * handling is to bind what the gap says with the role taken from its own
       * name, rather than to drop the binding and re-open the gap.
       */
      ({
        profile: { id: chosen.id, name: chosen.name, role: null },
        ...roleOfProfile({ id: chosen.id, name: chosen.name, role: null }),
      } satisfies (typeof candidates)[number]);
    return bind(
      candidate,
      'CHOSEN_PROFILE',
      `Nothing has measured who gets into ${route}. ${chosen.why}`,
    );
  }

  /*
   * Profiles exist, none matched a cell, and the gap named none either —
   * `chooseAuthProfile` rule 4, which refuses rather than guessing between
   * several colleagues' accounts. Reported as NO_PROFILE_CONFIGURED would be
   * wrong (profiles ARE configured), so it is the same refusal the matrix
   * produces: no identity we can bind is known to reach it.
   */
  return refuse('NO_ROLE_REACHES_IT');
}

/** Appended to a binding whose role came from a profile NAME. One sentence, always the same. */
const ROLE_FROM_NAME_CAVEAT =
  'The role was taken from the profile\'s NAME because the profile declares none, so coverage ' +
  'is attributed to that role — set AuthProfile.role if it is wrong.';

// ─── The closure ─────────────────────────────────────────────────────────────

/** A (route, role) cell. The grain coverage is attributed at, instead of the route. */
export interface RoleCoverageKey {
  readonly route: string;
  readonly role: string;
}

/**
 * The cell key, as a string a `Map` can hold.
 *
 * NUL-separated rather than joined on a character a route or a role could
 * contain: `('/a', 'b/c')` and `('/a/b', 'c')` must not collide, and a slash
 * separator makes them collide silently. A role is customer-supplied text.
 */
export function roleCoverageCellKey(key: RoleCoverageKey): string {
  return `${key.route}\u0000${key.role}`;
}

/**
 * Everything a session-aware closure adds to the plan item `planItemForGap`
 * already produces — as a PATCH, not a replacement.
 *
 * ── Why a patch ────────────────────────────────────────────────────────────
 *
 * `planItemForGap` owns the title, steps, assertions and rationale, and it is
 * another file. A second producer of whole plan items would be a second place
 * the wording can drift and a second thing to keep in step with the approval
 * screen. So this carries only the fields that are about IDENTITY, the caller
 * spreads it, and there is exactly one producer of each field.
 *
 * `PlanItem` in packages/shared/src/flow-map.ts has `authProfileId` and does NOT
 * yet have `principals` or `gapId`, though the Prisma columns for both exist.
 * Those three type fields are in this round's handover; until they land a caller
 * spreads what it can hold and the rest reaches the database through the
 * writer, which is the shape the two existing writers already use for `gapId`.
 */
export interface SessionBoundPlanItemPatch {
  /** The session the runner must inject before the first navigation. */
  readonly authProfileId: string;
  /**
   * The actors, as `Test.principals` will hold them.
   *
   * One entry for an UNREACHED_AUTH_ROUTE closure, named
   * {@link CLOSURE_DEFAULT_PRINCIPAL_NAME}, because this test needs ONE
   * identity and that identity IS the run's default session. Naming it anything
   * else would put a principal in the list that `RunContext.sessions` has no
   * entry for, and the resolver in packages/runner/src/principals.ts would
   * correctly refuse to run it.
   */
  readonly principals: readonly ClosurePrincipal[];
  /** `PlanItem.gapId` — the provenance the closure ledger joins on. */
  readonly gapId: string;
  /** `PlanItem.gapKind`, kept beside the id because the id is a hash. */
  readonly gapKind: GapKind;
}

/** A gap this round will close, bound to an identity. */
export interface SessionBoundClosure {
  readonly gapId: string;
  readonly gapKind: GapKind;
  readonly route: string;
  readonly binding: RoleBinding;
  readonly planItemPatch: SessionBoundPlanItemPatch;
  /**
   * The cell this closure covers. NOT the route.
   *
   * This is the second half of the fix. A closure recorded against the route
   * marks /admin/users covered and silently answers "what does a member get
   * here?" with "covered" — and that question is where the expensive defects
   * are. Recorded against the cell, the admin cell closes and the member cell
   * stays open, which is the true state.
   */
  readonly attribution: RoleCoverageKey;
  /**
   * ALWAYS 'E2E' for a bound auth closure, and the constant is the point.
   *
   * SECURITY_SMOKE's schema can assert exactly one thing — that an anonymous
   * visitor is refused — which is the assertion that made this loop
   * non-convergent. A closure that has a session must not propose it, and
   * `gap-closure.test.ts` pins that rather than leaving it to a reader.
   */
  readonly testType: TestType;
  /** The scenario this closure runs under. Seeded; see {@link closureScenarioName}. */
  readonly scenarioName: string;
}

/**
 * The scenario name a closure runs under: stable for a (seed, gapId), different
 * for a different gap in the same run.
 *
 * ── Why it is seeded at all ────────────────────────────────────────────────
 *
 * Because the name reaches generated code and `Principal.createdByScenario`,
 * and two closures in one run that produce the same name are two scenarios that
 * cannot be told apart in a report or in a ledger row. Derived through
 * `createSyntheticFactory`'s token — the repo's one seeded, tested, clockless
 * derivation — so the same run seed yields byte-identical output for ever and a
 * fresh run yields a fresh name without a counter or a clock anywhere.
 */
export function closureScenarioName(seed: string | number, gapId: string): string {
  const token = createSyntheticFactory({ seed, scope: `gap-closure/${gapId}` }).token;
  return `close-${token}`;
}

/**
 * Bind a gap to an identity and produce the patch that carries it.
 *
 * Returns the refusal unchanged when no role could be bound: the caller records
 * it and leaves the gap open, which is what keeps "we could not check this, and
 * here is why" in the report instead of a silently anonymous test.
 */
export function closeGapAsRole(input: {
  gap: ClosureGap;
  matrix?: Pick<AccessMatrix, 'cells'> | null;
  profiles: readonly ClosureAuthProfile[];
  /** The run seed. The ONLY source of variation in this module. */
  seed: string | number;
}):
  | { readonly closed: true; readonly closure: SessionBoundClosure }
  | { readonly closed: false; readonly refusal: RoleBindingRefusal; readonly detail: string } {
  const result = bindRoleForGap(input);
  if (!result.bound) return { closed: false, refusal: result.refusal, detail: result.detail };

  const binding = result.binding;
  // `bindRoleForGap` refuses NO_ROUTE before this point, so the route is a string.
  const route = input.gap.route as string;
  const scenarioName = closureScenarioName(input.seed, input.gap.id);

  /*
   * PERSISTENT, and that is not a default taken lazily. This principal IS the
   * customer's configured account: the one thing in the schema that must never
   * be destroyed. `proveDisposable` refuses a PERSISTENT principal, so a
   * destructive step aimed at a closure's principal does not compile — which is
   * exactly the protection wanted here, since a closure is generated code
   * nobody reviews line by line.
   *
   * `createdByScenario: null` for the same reason: this actor was not created by
   * the scenario, it was configured by the customer, and claiming otherwise
   * would hand `proveDisposable` the one fact it uses to permit destruction.
   */
  const actor: ClosurePrincipal = {
    name: CLOSURE_DEFAULT_PRINCIPAL_NAME,
    kind: 'PERSISTENT',
    lifecycle: 'DECLARED',
    role: binding.role === ANONYMOUS_ROLE ? null : binding.role,
    authProfileId: binding.authProfileId,
    authProfileKind: null,
    tenant: null,
    createdByScenario: null,
  };

  return {
    closed: true,
    closure: {
      gapId: input.gap.id,
      gapKind: input.gap.kind,
      route,
      binding,
      planItemPatch: {
        authProfileId: binding.authProfileId,
        principals: [actor],
        gapId: input.gap.id,
        gapKind: input.gap.kind,
      },
      attribution: { route, role: binding.role },
      testType: 'E2E',
      scenarioName,
    },
  };
}

// ─── (route, role) attribution ───────────────────────────────────────────────

/**
 * What one (route, role) cell's coverage is.
 *
 * COVERED and UNCOVERED are the two a reader expects. The other two are the
 * reason this module exists:
 *
 *   ROLE_REFUSED  the matrix measured this role being refused here. The cell is
 *                 not a hole — the correct test for it asserts the REFUSAL, and
 *                 counting it as uncovered would ask a team to write a test
 *                 that signs in as somebody who cannot get in.
 *   NOT_PROBED    nobody asked what this role gets here. NOT a hole in the
 *                 customer's suite, and reporting it as one manufactures a
 *                 denominator — the exact failure access-matrix.ts refuses one
 *                 level down.
 */
export const ROLE_COVERAGE_STATES = [
  'COVERED',
  'UNCOVERED',
  'ROLE_REFUSED',
  'NOT_PROBED',
] as const;
export type RoleCoverageState = (typeof ROLE_COVERAGE_STATES)[number];

/** Compile-time half of the parity guard. */
const ROLE_COVERAGE_STATE_PRESENT: Record<RoleCoverageState, true> = {
  COVERED: true,
  UNCOVERED: true,
  ROLE_REFUSED: true,
  NOT_PROBED: true,
};

/** Derived, never hand-listed. */
export const ROLE_COVERAGE_STATE_LIST = Object.keys(
  ROLE_COVERAGE_STATE_PRESENT,
) as ReadonlyArray<RoleCoverageState>;

export interface RoleCoverageCell {
  readonly route: string;
  readonly role: string;
  readonly state: RoleCoverageState;
  /** Test ids bound to a profile of this role that visit this route. */
  readonly testIds: readonly string[];
  /** Why the state is what it is. Non-null for every state except COVERED. */
  readonly why: string | null;
}

export interface RoleCoverageCounts {
  readonly covered: number;
  readonly uncovered: number;
  readonly roleRefused: number;
  readonly notProbed: number;
  /** routes × roles. The parts above sum to this, which the test asserts. */
  readonly cells: number;
}

export interface RoleCoverage {
  readonly cells: readonly RoleCoverageCell[];
  readonly counts: RoleCoverageCounts;
  /**
   * The cells that are not coverage holes, grouped by reason, largest first.
   *
   * A COUNT AND A REASON, per the disclosure rule, and the reason is what makes
   * the number actionable: "61 cells are not probed because the member crawl's
   * login failed" has a fix in it and "61 cells are not probed" does not.
   */
  readonly gaps: ReadonlyArray<{ reason: string; cells: number }>;
}

/** The subset of a test this attribution reads. `CoverageTestInput` satisfies it. */
export interface RoleCoverageTest {
  readonly id: string;
  readonly routes: readonly string[];
  readonly authProfileId?: string | null;
  /**
   * `Test.authProfileRequired`. A test that declares it needs a role and has no
   * binding is running ANONYMOUSLY — the foreign key nulls the binding when the
   * profile is deleted and leaves this true — so it attributes to nothing. Read
   * here only to keep such a test out of a cell it does not cover.
   */
  readonly authProfileRequired?: boolean;
}

/**
 * Attribute every test's coverage to (route, role) cells instead of to routes.
 *
 * ── The denominator is the matrix, not the tests ───────────────────────────
 *
 * Cells come from `matrix.routes × matrix.roles` and never from what the tests
 * happen to mention, for the same reason `buildAccessMatrix` takes its route
 * list as an argument: a denominator derived from the numerator is 100% of
 * nothing. A route only the admin pass reached still owes a member cell.
 *
 * ── A test attributes to AT MOST ONE ROLE ──────────────────────────────────
 *
 * The role of its bound profile, and nothing else. An unbound test covers no
 * cell on this axis — it is not evidence about any identity, and spreading it
 * across every role is how one anonymous smoke test came to mark a whole
 * matrix covered. The anonymous column is a real column and a test earns it by
 * being deliberately anonymous, which this function cannot tell from a test
 * that simply has no profile, so it attributes neither. That is an undercount,
 * it is disclosed in `gaps`, and an undercount on an authorization axis is the
 * error worth having.
 */
export function roleCoverageCells(input: {
  matrix: Pick<AccessMatrix, 'routes' | 'roles' | 'cells'>;
  tests: readonly RoleCoverageTest[];
  profiles: readonly ClosureAuthProfile[];
}): RoleCoverage {
  const roleById = new Map<string, string>();
  for (const profile of input.profiles) roleById.set(profile.id, roleOfProfile(profile).role);

  /*
   * cell key → test ids, built once. Built per cell inside the loop below it
   * would be O(routes × roles × tests), and this axis is the one that finally
   * has a full denominator — a 400-route, 5-role matrix is 2000 cells.
   */
  const covering = new Map<string, string[]>();
  for (const test of input.tests) {
    const profileId = typeof test.authProfileId === 'string' ? test.authProfileId : '';
    /*
     * No binding, no cell. This covers BOTH the ordinary anonymous test and the
     * broken one — `authProfileRequired` true with the binding nulled by the
     * foreign key when its profile was deleted. The second is running
     * anonymously and passing whatever a signed-out visitor sees, so it
     * attributes to nothing here; naming it is `analyzeCoverage`'s job, which
     * reports it as its own gap with the re-bind as the remedy.
     */
    if (profileId === '') continue;
    const role = roleById.get(profileId);
    if (role === undefined) continue;
    for (const route of input.matrix.routes) {
      if (!test.routes.some((testRoute) => routeVisits(testRoute, route))) continue;
      const key = roleCoverageCellKey({ route, role });
      const existing = covering.get(key);
      if (existing) existing.push(test.id);
      else covering.set(key, [test.id]);
    }
  }

  const matrixCell = new Map<string, AccessMatrixCell>();
  for (const cell of input.matrix.cells) {
    matrixCell.set(roleCoverageCellKey({ route: cell.routeTemplate, role: cell.role }), cell);
  }

  const cells: RoleCoverageCell[] = [];
  const reasons = new Map<string, number>();
  const bump = (reason: string): void => {
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  };

  for (const route of input.matrix.routes) {
    for (const role of input.matrix.roles) {
      const key = roleCoverageCellKey({ route, role });
      const testIds = [...(covering.get(key) ?? [])].sort();
      const cell = matrixCell.get(key);

      if (testIds.length > 0) {
        cells.push({ route, role, state: 'COVERED', testIds, why: null });
        continue;
      }

      /*
       * Order matters and it is the honesty order. NOT_PROBED is checked before
       * ROLE_REFUSED because a cell nobody asked about carries no outcome worth
       * reading — `AccessMatrixCell`'s own invariant is that `basis` means
       * nothing on a NOT_PROBED cell — and it is checked before UNCOVERED
       * because an unasked cell is not a hole in anybody's suite.
       */
      if (cell === undefined || cell.outcome === 'NOT_PROBED') {
        const why =
          cell?.notProbedBecause ??
          'No access matrix cell exists for this (route, role) pair, so nobody has asked what this role gets here.';
        bump(why);
        cells.push({ route, role, state: 'NOT_PROBED', testIds: [], why });
        continue;
      }

      if (cell.outcome !== 'ALLOWED') {
        const why = `This role was measured as refused here (${cell.outcome}), so the test this cell wants asserts the refusal rather than the page.`;
        bump(why);
        cells.push({ route, role, state: 'ROLE_REFUSED', testIds: [], why });
        continue;
      }

      cells.push({
        route,
        role,
        state: 'UNCOVERED',
        testIds: [],
        why: `This role is ${cell.basis === 'OBSERVED' ? 'observed to be' : 'declared'} allowed on ${route} and no test bound to a profile of this role visits it.`,
      });
    }
  }

  const counts: RoleCoverageCounts = {
    covered: cells.filter((c) => c.state === 'COVERED').length,
    uncovered: cells.filter((c) => c.state === 'UNCOVERED').length,
    roleRefused: cells.filter((c) => c.state === 'ROLE_REFUSED').length,
    notProbed: cells.filter((c) => c.state === 'NOT_PROBED').length,
    cells: cells.length,
  };

  return {
    cells,
    counts,
    gaps: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, cells: count }))
      .sort((a, b) => b.cells - a.cells || a.reason.localeCompare(b.reason)),
  };
}

// ─── Convergence ─────────────────────────────────────────────────────────────

/**
 * What the test a closure proposes will look like TO THE NEXT ANALYSIS.
 *
 * ── THIS IS A PROJECTION AND IT IS NEVER A TEST ────────────────────────────
 *
 * It is fed to {@link verifyConvergence} and to nothing else. It must never be
 * persisted as a `Test` row, counted in a suite size, or reported as coverage:
 * no code has been generated, nothing has run, and a projection recorded as a
 * test is the first lie on the list this product cannot afford. The id is
 * prefixed so that a projection which escaped into a store is greppable rather
 * than indistinguishable.
 *
 * `code: null` is the load-bearing field. A test bound to an auth profile has no
 * sign-in text anywhere in its source — the runner injects the session before
 * the first navigation — so `signsIn()` over its code is false, and the ONLY
 * thing that makes the next analysis see an authenticated visitor is
 * `authProfileId`. Projecting a test with plausible sign-in code in it would
 * make convergence pass here through a route the real generated test does not
 * have, which is a green self-check for a loop that still does not converge.
 */
export const PROJECTED_TEST_ID_PREFIX = 'projected-closure:';

export function projectClosedTest(closure: SessionBoundClosure): CoverageTestInput {
  return {
    id: `${PROJECTED_TEST_ID_PREFIX}${closure.gapId}`,
    name: `Reach ${closure.route} as "${closure.binding.authProfileName}"`,
    filePath: `projected/${closure.scenarioName}.spec.ts`,
    feature: null,
    priority: 'IMPORTANT',
    testType: closure.testType,
    tags: [],
    routes: [closure.route],
    code: null,
    authProfileId: closure.planItemPatch.authProfileId,
    authProfileRequired: true,
  };
}

/**
 * The re-analysis, as a narrow injected interface.
 *
 * A function and not `analyzeCoverage` itself, for two reasons that are the same
 * reason: this module must be testable with a fake that returns a fixed answer,
 * and the caller — a worker processor — already holds the crawl, the limit and
 * the profiles that a real re-analysis needs. Passing the analyser's whole input
 * through here would make this module responsible for assembling it.
 *
 * `complete` and `crawled` are not optional and have no defaults. They are the
 * two facts that decide whether an absent gap means anything at all, and a
 * default on either would turn "we could not check" into "it closed".
 */
export interface ClosureReanalysis {
  readonly crawled: boolean;
  /** True ONLY when the report held every gap it found, not a ranked page. */
  readonly complete: boolean;
  readonly openGapIds: ReadonlySet<string>;
}

export type ReanalyzeWithProjections = (
  tests: readonly CoverageTestInput[],
) => ClosureReanalysis;

export const CONVERGENCE_STATES = ['CONVERGES', 'DOES_NOT_CONVERGE', 'UNVERIFIABLE'] as const;
export type ConvergenceState = (typeof CONVERGENCE_STATES)[number];

/** Compile-time half of the parity guard. */
const CONVERGENCE_STATE_PRESENT: Record<ConvergenceState, true> = {
  CONVERGES: true,
  DOES_NOT_CONVERGE: true,
  UNVERIFIABLE: true,
};

/** Derived, never hand-listed. */
export const CONVERGENCE_STATE_LIST = Object.keys(
  CONVERGENCE_STATE_PRESENT,
) as ReadonlyArray<ConvergenceState>;

export interface ConvergenceVerdict {
  readonly state: ConvergenceState;
  /** Gap ids the projection removed, sorted. */
  readonly closedGapIds: readonly string[];
  /** Gap ids still reported with the projection applied, sorted. THE FINDING. */
  readonly stillOpenGapIds: readonly string[];
  /** The sentence behind the state. Printed verbatim. */
  readonly why: string;
}

/**
 * Would the tests these closures ask for actually close these gaps?
 *
 * The question nothing could answer, and the reason the loop ran for four
 * rounds re-closing one gap. It is answerable deterministically and BEFORE a
 * generation is spent, because the thing that makes an auth gap close is a
 * COLUMN — `Test.authProfileId` — and a projection can carry a column.
 *
 * Three verdicts, and UNVERIFIABLE is the one that keeps this honest: a
 * re-analysis that could not read the application, or that handed back a ranked
 * page instead of the full gap list, has not shown that anything closed. Reading
 * either as CONVERGES would mark a project converged the first time the
 * Explorer failed.
 *
 * An empty closure list is UNVERIFIABLE too, not CONVERGES. "Nothing was
 * proposed" is not evidence that the loop terminates; it is the absence of the
 * experiment.
 */
export function verifyConvergence(input: {
  closures: readonly SessionBoundClosure[];
  /** The tests the suite already has. The projections are added to these. */
  existingTests: readonly CoverageTestInput[];
  reanalyze: ReanalyzeWithProjections;
}): ConvergenceVerdict {
  const proposed = [...input.closures.map((c) => c.gapId)].sort();

  if (input.closures.length === 0) {
    return {
      state: 'UNVERIFIABLE',
      closedGapIds: [],
      stillOpenGapIds: [],
      why: 'No closure was proposed, so there is nothing whose convergence could be checked. This is the absence of the experiment, not a result from it.',
    };
  }

  const projections = input.closures.map(projectClosedTest);
  const after = input.reanalyze([...input.existingTests, ...projections]);

  if (!after.crawled) {
    return {
      state: 'UNVERIFIABLE',
      closedGapIds: [],
      stillOpenGapIds: proposed,
      why: 'Convergence could not be checked: the re-analysis has no readable crawl, so its gap list is empty for a reason that has nothing to do with these closures.',
    };
  }
  if (!after.complete) {
    return {
      state: 'UNVERIFIABLE',
      closedGapIds: [],
      stillOpenGapIds: proposed,
      why: 'Convergence could not be checked: the re-analysis returned a ranked page rather than every gap it found, so a gap missing from it means only that it is not in the top slice.',
    };
  }

  const stillOpen = proposed.filter((gapId) => after.openGapIds.has(gapId));
  const closed = proposed.filter((gapId) => !after.openGapIds.has(gapId));

  if (stillOpen.length > 0) {
    return {
      state: 'DOES_NOT_CONVERGE',
      closedGapIds: closed,
      stillOpenGapIds: stillOpen,
      why: `${stillOpen.length} of ${proposed.length} proposed closure(s) would NOT close their gap: ${stillOpen.join(', ')}. The test these items ask for is bound to a session and the gap is still reported with it applied, so generating them would spend a generation and report the same gap again. Do not generate these — the detector and the proposal disagree, and that is the finding.`,
    };
  }

  return {
    state: 'CONVERGES',
    closedGapIds: closed,
    stillOpenGapIds: [],
    why: `All ${proposed.length} proposed closure(s) remove their gap from a complete re-analysis, so generating them closes the loop rather than re-entering it.`,
  };
}

// ─── One round ───────────────────────────────────────────────────────────────

/**
 * How many closures one round may propose.
 *
 * A cap and not a budget: the budget belongs to `rankGapsForClosure`, which
 * already knows the night's share. This is the backstop that stops a caller
 * which forgot to rank from handing a Generator four hundred items, and it is
 * reported when it bites — see {@link ClosureRound.capped}.
 */
export const MAX_CLOSURES_PER_ROUND = 25;

export interface ClosureRound {
  readonly closures: readonly SessionBoundClosure[];
  /**
   * Gaps that could not be bound to an identity, with the reason. NEVER
   * silent, and never folded in with the ones that converged: a gap left open
   * because no profile is configured is a different sentence from a gap nobody
   * looked at, and only one of them has a fix the customer can apply.
   */
  readonly refusals: ReadonlyArray<{
    gapId: string;
    refusal: RoleBindingRefusal;
    detail: string;
  }>;
  /** How many gaps were offered. `closures + refusals + capped.dropped` by construction. */
  readonly considered: number;
  /**
   * The cap, DISCLOSED. `dropped: 0` is the ordinary case and the field is still
   * present — a report that can only say "capped" when it was capped cannot say
   * "not capped" at all, and a reader then cannot tell a complete list from a
   * truncated one.
   */
  readonly capped: { limit: number; dropped: number; reason: string | null };
}

/**
 * Bind every gap in a round, honestly.
 *
 * Deterministic end to end, and the ordering is BY GAP ID rather than by score
 * on purpose: `rankGapsForClosure` has already spent the round's budget and
 * decided which gaps these are, so re-ranking them here would be a second
 * ordering of one decision — and the score is the field that moves as tests
 * land, so it is the wrong key for a tiebreak that must be identical across two
 * ticks. The id is a stable hash of (kind, subject). The only variation in this
 * function is the run seed.
 */
export function closureRound(input: {
  gaps: readonly ClosureGap[];
  matrix?: Pick<AccessMatrix, 'cells'> | null;
  profiles: readonly ClosureAuthProfile[];
  seed: string | number;
  limit?: number;
}): ClosureRound {
  const limit = Math.max(0, Math.min(input.limit ?? MAX_CLOSURES_PER_ROUND, MAX_CLOSURES_PER_ROUND));
  const ordered = [...input.gaps].sort((a, b) => a.id.localeCompare(b.id));

  const closures: SessionBoundClosure[] = [];
  const refusals: Array<{ gapId: string; refusal: RoleBindingRefusal; detail: string }> = [];
  let dropped = 0;

  for (const gap of ordered) {
    const result = closeGapAsRole({
      gap,
      matrix: input.matrix ?? null,
      profiles: input.profiles,
      seed: input.seed,
    });
    if (!result.closed) {
      refusals.push({ gapId: gap.id, refusal: result.refusal, detail: result.detail });
      continue;
    }
    if (closures.length >= limit) {
      dropped += 1;
      continue;
    }
    closures.push(result.closure);
  }

  return {
    closures,
    refusals,
    considered: ordered.length,
    capped: {
      limit,
      dropped,
      reason:
        dropped === 0
          ? null
          : `At least ${dropped} more gap(s) could have been bound to an identity this round and were held back by the per-round cap of ${limit}. They are not closed and not refused — they were not reached.`,
    },
  };
}
