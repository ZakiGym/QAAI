/**
 * PRINCIPALS — who a scenario acts as, and which of them may be damaged.
 *
 * ── The defect this replaces ────────────────────────────────────────────────
 *
 * `RunContext.storageState` is ONE session per run. Everything that needs two
 * identities at once was therefore inexpressible, and the list is not a list of
 * nice-to-haves — it is most of the authorization half of testing:
 *
 *   · "user A can read user B's invoice" cannot be written, so the IDOR check
 *     fetches ids ANONYMOUSLY and asks whether an anonymous visitor is denied.
 *     Anonymous denial is the one thing every application gets right.
 *   · invite-and-accept, submit-and-approve, share-and-open — every two-actor
 *     flow — has no second actor to be.
 *   · nothing can sweep the enumerated endpoints with tenant A's token against
 *     tenant B's ids, which is the bug class that ends a company.
 *   · logout, session expiry, signup, password reset, email verification and
 *     lockout are skip-listed, because there is one shared account and driving
 *     any of those against it destroys the only way in.
 *
 * A `Principal` is the fix: a NAMED actor, with a role, an auth profile, a
 * tenant, a lifecycle, and — the part that matters most — a declaration of
 * whether it may be destroyed.
 *
 * ── Why disposability is a TYPE and not a convention ───────────────────────
 *
 * Six agents are about to write destructive scenarios against this vocabulary,
 * in parallel, and the customer has exactly one real account. A comment saying
 * "only pass disposable principals here" is worth nothing at 3am in the sixth
 * file. So {@link proveDisposable} is the only way to obtain a
 * {@link DestructiblePrincipal}, every destructive step takes that type, and a
 * `Principal` which has not been through the check is not assignable to it.
 * The compiler refuses the mistake instead of a reviewer catching it.
 *
 * Honest about the limit: a `as DestructiblePrincipal` cast defeats this, as a
 * cast defeats every brand in TypeScript. What it buys is that the mistake
 * cannot be made by ACCIDENT and cannot be made INVISIBLY — a cast is a line a
 * reviewer can grep for, and `grep -n 'as DestructiblePrincipal'` returning
 * anything is a finding.
 *
 * ── Why the refusal is a VALUE and not a throw ─────────────────────────────
 *
 * Because "this check was not performed, and here is why" has to reach the
 * report. A destructive scenario that silently declines to run and reports
 * nothing is indistinguishable from one that ran and found no bug, and that is
 * the shape of lie this product cannot afford. {@link proveDisposable} returns
 * a discriminated result whose refusal arm carries a reason the report prints.
 */

import type { AuthProfileKind } from './constants';

// ─── Kind: may this actor be damaged? ────────────────────────────────────────

/**
 * The three answers to "what happens if a scenario destroys this actor?".
 *
 * ── Why three and not a boolean ────────────────────────────────────────────
 *
 * A boolean `disposable` makes ANONYMOUS a lie in both directions. An anonymous
 * principal has no account to destroy, so `disposable: false` reads as "the
 * customer's precious account" and `disposable: true` reads as "go ahead and
 * delete it" — and the honest answer is that the question does not apply.
 * Logging out an anonymous principal is not a destructive step that was
 * refused; it is not a destructive step. Collapsing that into either boolean
 * puts an UNEXERCISABLE surface in the same bucket as an exercisable one.
 *
 * PERSISTENT is the DEFAULT EVERYWHERE, in the Prisma column and in every
 * constructor here, and that asymmetry is deliberate: the cost of wrongly
 * calling the customer's account disposable is their production login, and the
 * cost of wrongly calling a throwaway persistent is one scenario reported as
 * UNEXERCISABLE with a remedy beside it. Those are not comparable, so the
 * default is the one whose failure is cheap.
 */
export const PRINCIPAL_KINDS = ['PERSISTENT', 'DISPOSABLE', 'ANONYMOUS'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/**
 * The compile-time half of the parity guard.
 *
 * A `Record` keyed on the union cannot be written without naming every member,
 * and naming one that does not exist is an excess property. The run-time half
 * lives in `principals.test.ts`, which compares `principalKindSchema.options`
 * against this list — because zod's options exist only at run time and a
 * hand-written list would drift from the union.
 *
 * Two mechanisms rather than one because each catches what the other cannot,
 * and because the class of defect is proven here: eight `GateRule` kinds
 * shipped UNSAVEABLE for two slices — present in the union, absent from the
 * zod write path — and `check:wiring` cannot see it, since a union member with
 * no write path is live code in a file that is reached.
 */
const PRINCIPAL_KIND_PRESENT: Record<PrincipalKind, true> = {
  PERSISTENT: true,
  DISPOSABLE: true,
  ANONYMOUS: true,
};

/** Derived, never hand-listed. See the note on the record above. */
export const PRINCIPAL_KIND_LIST = Object.keys(PRINCIPAL_KIND_PRESENT) as ReadonlyArray<PrincipalKind>;

// ─── Lifecycle: what state is this actor in right now? ───────────────────────

/**
 * Where a principal is in its life. Ten members, and every one is a state some
 * scenario must be able to tell apart from its neighbours.
 *
 * The three that exist purely to stop a lie:
 *
 *   · PROVISION_FAILED is NOT `DECLARED`. A signup that could not complete is
 *     a check that did not happen; a principal still waiting to be created is
 *     a check that has not happened YET. Recording the first as the second
 *     makes a broken signup flow look like a queue.
 *   · DESTRUCTION_REFUSED is NOT `ACTIVE`. When {@link proveDisposable} says
 *     no, the principal is intact — but the scenario did not run, and the
 *     report must say so. An intact principal whose destructive scenario was
 *     refused, recorded as ACTIVE, is a surface silently absent from the
 *     report.
 *   · UNAVAILABLE is NOT `PROVISION_FAILED`. Bot protection standing in front
 *     of the signup form is not a failure of the application and not a failure
 *     of ours; it is a configuration the customer can fix, and it carries a
 *     different remedy. See `BOT_BYPASS_MODES` in auth-profiles.ts.
 *
 * SIGNED_OUT and SESSION_EXPIRED are separate for the same reason they are
 * separate bugs: one is a user action the application performed, the other is
 * time passing, and an application that handles the first and not the second
 * is the ordinary case rather than a rare one.
 */
export const PRINCIPAL_LIFECYCLES = [
  /** Named by the scenario; nothing has been created or signed in yet. */
  'DECLARED',
  /** Creation is in flight — a signup form submitted, an invite being accepted. */
  'PROVISIONING',
  /** Creation was attempted and did not complete. A check that did NOT happen. */
  'PROVISION_FAILED',
  /** Has a live session. The only state most scenarios need. */
  'ACTIVE',
  /** Had a session and gave it up deliberately. Distinct from DECLARED: it existed. */
  'SIGNED_OUT',
  /** The session is no longer accepted, and nobody asked for that. */
  'SESSION_EXPIRED',
  /** The application locked the account — failed attempts, or an admin action. */
  'LOCKED_OUT',
  /** Gone, by this scenario's own hand. Terminal. */
  'DESTROYED',
  /** A destructive step was REFUSED. The principal is intact and the check did not run. */
  'DESTRUCTION_REFUSED',
  /** Could not be reached at all — bot protection, an unreachable environment. */
  'UNAVAILABLE',
] as const;
export type PrincipalLifecycle = (typeof PRINCIPAL_LIFECYCLES)[number];

/** Compile-time half of the parity guard. See {@link PRINCIPAL_KIND_PRESENT}. */
const PRINCIPAL_LIFECYCLE_PRESENT: Record<PrincipalLifecycle, true> = {
  DECLARED: true,
  PROVISIONING: true,
  PROVISION_FAILED: true,
  ACTIVE: true,
  SIGNED_OUT: true,
  SESSION_EXPIRED: true,
  LOCKED_OUT: true,
  DESTROYED: true,
  DESTRUCTION_REFUSED: true,
  UNAVAILABLE: true,
};

/** Derived, never hand-listed. */
export const PRINCIPAL_LIFECYCLE_LIST = Object.keys(
  PRINCIPAL_LIFECYCLE_PRESENT,
) as ReadonlyArray<PrincipalLifecycle>;

/**
 * Lifecycles in which the principal HAS a usable session right now.
 *
 * Derived by exclusion rather than listed, so an eleventh lifecycle is usable
 * only if someone decides it is, instead of defaulting into this set because
 * they forgot this line existed.
 */
export const SESSIONED_LIFECYCLES: ReadonlyArray<PrincipalLifecycle> =
  PRINCIPAL_LIFECYCLE_LIST.filter((state) => state === 'ACTIVE');

/**
 * Lifecycles that mean "we never got to ask the question".
 *
 * THE RULE THIS SERVES: a scenario whose principal is in one of these states
 * reports UNAVAILABLE or REFUSED, never PASS and never a count of zero. A pass
 * that means "we did not check" is the first lie on the list this product
 * cannot afford.
 */
export const UNMEASURED_LIFECYCLES: ReadonlyArray<PrincipalLifecycle> = [
  'DECLARED',
  'PROVISIONING',
  'PROVISION_FAILED',
  'DESTRUCTION_REFUSED',
  'UNAVAILABLE',
];

/**
 * Did this principal ever hold a session? Separates "the scenario did not get
 * started" from "the scenario ran and ended the session on purpose".
 *
 * SESSION_EXPIRED and LOCKED_OUT count as having held one, because they are the
 * OUTCOME of holding one. DESTRUCTION_REFUSED does not, because nothing about a
 * refusal says whether the sign-in ever happened.
 */
export function hadSession(state: PrincipalLifecycle): boolean {
  return (
    state === 'ACTIVE' ||
    state === 'SIGNED_OUT' ||
    state === 'SESSION_EXPIRED' ||
    state === 'LOCKED_OUT' ||
    state === 'DESTROYED'
  );
}

// ─── Tenancy ─────────────────────────────────────────────────────────────────

/**
 * A tenant, as the APPLICATION UNDER TEST spells it — never as QAAI spells it.
 *
 * ── Why this is its own type and not a string on the principal ─────────────
 *
 * Because the tenancy sweep needs tenant A's TOKEN and tenant B's IDS to be two
 * separately addressable facts. The sweep is: hold principal A (tenant A), take
 * every id the enumeration harvested while acting as principal B (tenant B),
 * and ask A for each one. Written with a bare `tenantId: string` on the
 * principal, the id harvest has nowhere to live and the sweep collapses into
 * "ask for some ids and see" — which is what the anonymous IDOR check already
 * does badly.
 *
 * `label` is for the report and `id` is for comparison. They are separate
 * because a report that says "tenant clx7a… may read tenant clx9f…'s invoices"
 * is unreadable, and a comparison on a human label is a comparison on a value
 * the customer may legitimately duplicate.
 */
export interface TenantRef {
  /** The application's own identifier for the tenant. Compared, never shown alone. */
  readonly id: string;
  /** What a human calls it. Shown in the report; never used for comparison. */
  readonly label: string | null;
}

/**
 * Two principals that must be in different tenants for a cross-tenant check to
 * mean anything, plus whether they actually are.
 *
 * `distinct: false` is a REAL and common answer — a customer with one sandbox
 * tenant cannot run a cross-tenant sweep, and the honest report is
 * "not performed: both principals are in tenant acme" rather than a sweep that
 * compares a tenant against itself and passes. The second is the lie: every
 * request succeeds, nothing is denied, and it renders as "no cross-tenant
 * leakage found".
 */
export interface TenantPair {
  readonly holder: TenantRef;
  readonly subject: TenantRef;
  readonly distinct: boolean;
}

export function tenantPair(holder: TenantRef, subject: TenantRef): TenantPair {
  return { holder, subject, distinct: holder.id !== subject.id };
}

// ─── The principal ──────────────────────────────────────────────────────────

/**
 * A named actor in a scenario.
 *
 * `name` is the SCENARIO'S name for it — "admin", "memberA", "victim",
 * "invitee" — and it is the key in {@link RunPrincipalSessions}. It is not an
 * identifier of anything in the customer's database, which is why it is a
 * scenario-local string and why two runs may both have a "memberA".
 *
 * Note what is NOT on this type, and cannot be added to it: no password, no
 * TOTP secret, no OTP, no session cookie, no storageState, no bypass token, no
 * API key. A principal NAMES a credential by pointing at an `AuthProfile`
 * (`authProfileId`) whose secret-bearing fields reference `Secret.name` — the
 * pattern already in the schema. The credential itself is resolved by the
 * worker, lives in {@link PrincipalSession}, and never enters a plan item, a
 * generated test, a fixture file or a log line.
 */
export interface Principal<K extends PrincipalKind = PrincipalKind> {
  /** The scenario's own name for this actor. Stable within one scenario. */
  readonly name: string;
  /** May this actor be damaged? See {@link PRINCIPAL_KINDS}. */
  readonly kind: K;
  /** Where it is in its life. */
  readonly lifecycle: PrincipalLifecycle;
  /**
   * The role as the APPLICATION spells it, or null.
   *
   * Null is not anonymous — `AuthProfile.role` draws the same distinction and
   * for the same reason. Null means nobody said what this actor is; ANONYMOUS
   * is a `kind`, and it is a claim about a logged-out visitor, which is the
   * opposite of an unlabelled logged-in one.
   */
  readonly role: string | null;
  /**
   * The `AuthProfile.id` this actor signs in through, or null for ANONYMOUS and
   * for a DISPOSABLE actor the scenario has not created yet.
   */
  readonly authProfileId: string | null;
  /** Which kind of door it goes through, when the profile is known. For reporting. */
  readonly authProfileKind: AuthProfileKind | null;
  /** The tenant this actor belongs to, or null when the application has no tenancy. */
  readonly tenant: TenantRef | null;
  /**
   * The scenario that CREATED this actor, for a DISPOSABLE one.
   *
   * Required for disposability — see {@link proveDisposable}. "Disposable"
   * without a creator is a claim nobody made: the only principal a scenario may
   * destroy is one it brought into existence, and this field is what makes that
   * checkable rather than asserted.
   */
  readonly createdByScenario: string | null;
}

/** A principal with no credential at all. The baseline every probe compares against. */
export const ANONYMOUS_PRINCIPAL: Principal<'ANONYMOUS'> = {
  name: '<anonymous>',
  kind: 'ANONYMOUS',
  lifecycle: 'ACTIVE',
  role: null,
  authProfileId: null,
  authProfileKind: null,
  tenant: null,
  createdByScenario: null,
};

/**
 * The name under which the run's existing single session is filed.
 *
 * This is the compatibility hinge. `RunContext.storageState` keeps meaning
 * exactly what it meant, and it is also reachable as
 * `sessions['default']` — so every caller that has never heard of principals
 * keeps working and keeps being right, while a two-actor scenario adds names
 * beside this one. See the comment on `RunContext.sessions` in types.ts.
 */
export const DEFAULT_PRINCIPAL_NAME = 'default';

/**
 * Build a principal. PERSISTENT and DECLARED unless told otherwise, for the
 * reason given on {@link PRINCIPAL_KINDS}: the safe default is the one whose
 * failure costs a skipped scenario rather than the customer's login.
 */
export function principal(input: {
  name: string;
  kind?: PrincipalKind;
  lifecycle?: PrincipalLifecycle;
  role?: string | null;
  authProfileId?: string | null;
  authProfileKind?: AuthProfileKind | null;
  tenant?: TenantRef | null;
  createdByScenario?: string | null;
}): Principal {
  return {
    name: input.name,
    kind: input.kind ?? 'PERSISTENT',
    lifecycle: input.lifecycle ?? 'DECLARED',
    role: input.role ?? null,
    authProfileId: input.authProfileId ?? null,
    authProfileKind: input.authProfileKind ?? null,
    tenant: input.tenant ?? null,
    createdByScenario: input.createdByScenario ?? null,
  };
}

// ─── Sessions: the map that replaces one storageState ───────────────────────

/**
 * One resolved session. SECRET-BEARING, and the only secret-bearing type here.
 *
 * `storageState` is an opaque `unknown` for the same reason
 * `RunContext.storageState` is: it is Playwright's JSON and nothing in this
 * package parses it. It must never be logged, echoed, returned from an API
 * route, embedded in generated code or written into a fixture — the artifact
 * writer and log serialiser mask it, and {@link describePrincipal} exists so
 * that reporting code has something safe to print instead.
 */
export interface PrincipalSession {
  readonly principal: Principal;
  /** Playwright storageState JSON. Opaque, secret-bearing, never serialised to a report. */
  readonly storageState: unknown | null;
  /**
   * When the session stops being accepted, ISO-8601, or null when unknown.
   *
   * Null is "nobody told us", NOT "never expires". A session-expiry scenario
   * that reads null as "never" waits forever; one that reads it as unknown
   * reports UNAVAILABLE and names the missing fact.
   */
  readonly expiresAtIso: string | null;
}

/**
 * Principal name → session. This is what `RunContext.sessions` holds.
 *
 * A plain readonly record rather than a `Map`, because it has to survive
 * `structuredClone` across the worker boundary and be a plain object in the
 * run record. `DEFAULT_PRINCIPAL_NAME` is present whenever the run resolved any
 * session at all.
 */
export type RunPrincipalSessions = Readonly<Record<string, PrincipalSession>>;

/**
 * The one safe rendering of a principal: identity and state, no credential.
 *
 * Reporting code should call this rather than interpolating a principal, so
 * that adding a field to {@link Principal} cannot leak one by accident. The
 * tenant is named by LABEL where there is one, because an opaque id tells a
 * reader nothing.
 */
export function describePrincipal(p: Principal): string {
  const where = p.tenant === null ? '' : ` in ${p.tenant.label ?? p.tenant.id}`;
  const as = p.role === null ? p.kind.toLowerCase() : p.role;
  return `${p.name} (${as}${where}, ${p.lifecycle})`;
}

// ─── Disposability, enforced by the compiler ────────────────────────────────

/**
 * The witness. A real runtime symbol, module-private, never exported — which is
 * the whole mechanism: no other module can name this key, so the only way to
 * hold a {@link DisposabilityProof} is to have been given one by
 * {@link proveDisposable}.
 *
 * `const ... : unique symbol = Symbol(...)` and NOT `declare const`. An earlier
 * draft used `declare`, which type-checks perfectly and has NO RUNTIME VALUE —
 * so `{ [DISPOSABILITY_WITNESS]: true }` threw `ReferenceError` on the first
 * call, and `tsc --noEmit` was clean the whole time. The brand has to exist at
 * run time because the object literal that carries it does.
 */
const DISPOSABILITY_WITNESS: unique symbol = Symbol('qaai.principals.disposability');

/**
 * Evidence that a principal was created by the scenario about to destroy it.
 *
 * Carries the facts the report needs when a destructive scenario DID run, so
 * that "we deleted an account" is always accompanied by which account, created
 * by what, when, and in which tenant.
 */
export interface DisposabilityProof {
  readonly [DISPOSABILITY_WITNESS]: true;
  readonly principalName: string;
  readonly createdByScenario: string;
  readonly tenantId: string | null;
}

/**
 * A principal a destructive step may act on. THE type every destructive step
 * must take.
 *
 * A bare `Principal` is not assignable to it: `kind` is narrowed to
 * 'DISPOSABLE' and `disposability` cannot be constructed outside this module.
 * So `logout(p)` where `p: Principal` does not compile, and the author has to
 * route through {@link proveDisposable} and handle its refusal.
 */
export type DestructiblePrincipal = Principal<'DISPOSABLE'> & {
  readonly disposability: DisposabilityProof;
};

/**
 * Why a principal may not be destroyed. Every member is a sentence the report
 * prints verbatim beside the scenario it stopped.
 */
export const DISPOSABILITY_REFUSAL_REASONS = [
  /** The customer's own account. The one this whole file exists to protect. */
  'PERSISTENT_PRINCIPAL',
  /** No account to destroy. Not a refused check — not a check. */
  'ANONYMOUS_PRINCIPAL',
  /** Claims DISPOSABLE and names no creating scenario, so the claim is unverified. */
  'NO_CREATING_SCENARIO',
  /** It is the run's default session, i.e. the shared account under another name. */
  'IS_RUN_DEFAULT',
  /** Already gone; destroying it again would report a second success for one act. */
  'ALREADY_DESTROYED',
  /** Never came into existence, so there is nothing to destroy and nothing to conclude. */
  'NEVER_PROVISIONED',
] as const;
export type DisposabilityRefusalReason = (typeof DISPOSABILITY_REFUSAL_REASONS)[number];

/** Compile-time half of the parity guard. */
const DISPOSABILITY_REFUSAL_REASON_PRESENT: Record<DisposabilityRefusalReason, true> = {
  PERSISTENT_PRINCIPAL: true,
  ANONYMOUS_PRINCIPAL: true,
  NO_CREATING_SCENARIO: true,
  IS_RUN_DEFAULT: true,
  ALREADY_DESTROYED: true,
  NEVER_PROVISIONED: true,
};

/** Derived, never hand-listed. */
export const DISPOSABILITY_REFUSAL_REASON_LIST = Object.keys(
  DISPOSABILITY_REFUSAL_REASON_PRESENT,
) as ReadonlyArray<DisposabilityRefusalReason>;

/**
 * A destructive step that did NOT run, and why — a record, not an exception.
 *
 * It is a value because it has to reach the report. A refusal that throws is
 * caught somewhere and becomes a skipped test, and a skipped destructive
 * scenario is indistinguishable from one that found nothing. The product's own
 * rule: a REFUSED surface must not be recorded the same way as one that does
 * not exist.
 */
export interface DisposabilityRefusal {
  readonly ok: false;
  readonly principalName: string;
  readonly reason: DisposabilityRefusalReason;
  /** One sentence for a human, naming the principal and the remedy. */
  readonly detail: string;
}

export type DisposabilityResult =
  | { readonly ok: true; readonly principal: DestructiblePrincipal }
  | DisposabilityRefusal;

/** The sentence for each reason. Exhaustive by `Record`, so a seventh reason breaks here. */
const REFUSAL_DETAIL: Record<DisposabilityRefusalReason, string> = {
  PERSISTENT_PRINCIPAL:
    'this is the customer\'s own account and may never be damaged — configure a disposable ' +
    'principal (a signup the scenario performs, or a second AuthProfile marked DISPOSABLE) and ' +
    'the scenario will run',
  ANONYMOUS_PRINCIPAL:
    'an anonymous principal has no account, so this step is not applicable rather than refused',
  NO_CREATING_SCENARIO:
    'marked DISPOSABLE but names no creating scenario, so nothing proves it is a throwaway — ' +
    'only a principal the scenario itself created may be destroyed',
  IS_RUN_DEFAULT:
    'this is the run\'s default session, which is the shared account under another name',
  ALREADY_DESTROYED: 'already destroyed earlier in this scenario',
  NEVER_PROVISIONED:
    'was never provisioned, so there is nothing to destroy and nothing to conclude from trying',
};

/**
 * The ONLY way to obtain a {@link DestructiblePrincipal}.
 *
 * Five checks, and the order is chosen so the refusal a reader sees is the most
 * specific true one. ANONYMOUS before PERSISTENT, because "not applicable"
 * beats "forbidden" when both are true of an anonymous actor; terminal
 * lifecycle states before the creator check, because "already destroyed" is
 * more useful than "unverified claim" on a principal that was verified a moment
 * ago.
 *
 * `runDefaultName` defaults to {@link DEFAULT_PRINCIPAL_NAME}. Pass it
 * explicitly when a run files its shared session under another name; the check
 * exists because the fastest way to destroy the customer's account is to copy
 * the default session into a principal and label it DISPOSABLE.
 */
/**
 * Are these two principal names the same identity?
 *
 * Trimmed and case-folded, because the names being compared are a CLAIM made
 * by whoever wrote the plan item — a model, an HTTP client, a producer in
 * another workspace — and not an interned identifier this module issued. See
 * the comment at the call site in {@link proveDisposable} for the hole this
 * closed.
 */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function proveDisposable(
  candidate: Principal,
  runDefaultName: string = DEFAULT_PRINCIPAL_NAME,
): DisposabilityResult {
  const refuse = (reason: DisposabilityRefusalReason): DisposabilityRefusal => ({
    ok: false,
    principalName: candidate.name,
    reason,
    detail: `${candidate.name}: ${REFUSAL_DETAIL[reason]}`,
  });

  if (candidate.kind === 'ANONYMOUS') return refuse('ANONYMOUS_PRINCIPAL');
  if (candidate.kind === 'PERSISTENT') return refuse('PERSISTENT_PRINCIPAL');
  /*
   * COMPARED NORMALISED, AND THAT IS NOT TIDINESS — IT WAS A HOLE.
   *
   * `candidate.name === runDefaultName` is an exact comparison, and
   * `principalSchema` does NOT trim a name, so `'Default'`, `' default'`,
   * `'default '` and `'default\t'` all slipped past this check and were handed
   * back as a DestructiblePrincipal. A plan item from a model, or a row posted
   * over HTTP, reaches this function with whatever spelling it was written
   * with — so the one check standing between a destructive step and the
   * customer's shared session could be defeated by a capital letter.
   *
   * Normalising can only ever add refusals, never remove one, which is the
   * direction a guard is allowed to be wrong in. The cost is that a principal
   * genuinely named `'Default-2'` is unaffected (it does not normalise equal)
   * while a deliberate `'DEFAULT'` is refused with a sentence telling the
   * author to rename it.
   */
  if (sameName(candidate.name, runDefaultName)) return refuse('IS_RUN_DEFAULT');
  if (candidate.lifecycle === 'DESTROYED') return refuse('ALREADY_DESTROYED');
  if (candidate.lifecycle === 'PROVISION_FAILED' || candidate.lifecycle === 'UNAVAILABLE') {
    return refuse('NEVER_PROVISIONED');
  }
  if (candidate.createdByScenario === null || candidate.createdByScenario.trim() === '') {
    return refuse('NO_CREATING_SCENARIO');
  }

  return {
    ok: true,
    principal: {
      ...candidate,
      kind: 'DISPOSABLE',
      disposability: {
        [DISPOSABILITY_WITNESS]: true,
        principalName: candidate.name,
        createdByScenario: candidate.createdByScenario,
        tenantId: candidate.tenant?.id ?? null,
      },
    },
  };
}

// ─── Destructive steps ──────────────────────────────────────────────────────

/**
 * The steps that can end an identity. Every one of them is currently
 * skip-listed and undriven, and every one is among the highest-risk flows any
 * application has.
 */
export const DESTRUCTIVE_STEP_KINDS = [
  'LOGOUT',
  'SESSION_EXPIRY',
  'PASSWORD_RESET',
  'EMAIL_CHANGE',
  'LOCKOUT',
  'ACCOUNT_DELETION',
  'REVOKE_ALL_SESSIONS',
] as const;
export type DestructiveStepKind = (typeof DESTRUCTIVE_STEP_KINDS)[number];

/** Compile-time half of the parity guard. */
const DESTRUCTIVE_STEP_KIND_PRESENT: Record<DestructiveStepKind, true> = {
  LOGOUT: true,
  SESSION_EXPIRY: true,
  PASSWORD_RESET: true,
  EMAIL_CHANGE: true,
  LOCKOUT: true,
  ACCOUNT_DELETION: true,
  REVOKE_ALL_SESSIONS: true,
};

/** Derived, never hand-listed. */
export const DESTRUCTIVE_STEP_KIND_LIST = Object.keys(
  DESTRUCTIVE_STEP_KIND_PRESENT,
) as ReadonlyArray<DestructiveStepKind>;

/**
 * The signature every destructive step must have. Written as a type so the six
 * parallel scenario builders cannot each invent their own and get the parameter
 * wrong in one of them.
 *
 * The parameter is {@link DestructiblePrincipal}, not {@link Principal}. That
 * single choice is what makes the compiler refuse a destructive step aimed at
 * the customer's account.
 */
export type DestructiveStep<T> = (target: DestructiblePrincipal) => T;

/**
 * A destructive step, bound to a target, with the refusal case already decided.
 *
 * `run` is present exactly when `refusal` is null, and the discriminant is
 * `permitted`. The point of the shape is that a caller cannot reach `run`
 * without having dealt with `refusal` — which is what stops a refusal being
 * dropped on the floor and the scenario reported as a pass.
 */
export type BoundDestructiveStep<T> =
  | { readonly permitted: true; readonly kind: DestructiveStepKind; readonly run: () => T }
  | {
      readonly permitted: false;
      readonly kind: DestructiveStepKind;
      readonly refusal: DisposabilityRefusal;
    };

/**
 * Bind a destructive step to a candidate principal, proving disposability on
 * the way through.
 *
 * This is the function the six scenario builders should call. It is a thin
 * wrapper over {@link proveDisposable} on purpose: the proving is the valuable
 * part, and having one named place to do it means a reviewer can check every
 * destructive step in the repo by grepping for this name.
 */
export function bindDestructiveStep<T>(
  kind: DestructiveStepKind,
  candidate: Principal,
  step: DestructiveStep<T>,
  runDefaultName: string = DEFAULT_PRINCIPAL_NAME,
): BoundDestructiveStep<T> {
  const proof = proveDisposable(candidate, runDefaultName);
  if (!proof.ok) return { permitted: false, kind, refusal: proof };
  return { permitted: true, kind, run: () => step(proof.principal) };
}

// ─── Cross-tenant and authorization probes ──────────────────────────────────

/**
 * HTTP methods a probe may use without changing anything.
 *
 * ── Why this list is shorter than "the safe methods" ───────────────────────
 *
 * HEAD and OPTIONS are in. GET is in. DELETE, PUT, PATCH and POST are out, and
 * POST is out even though a great many read-only endpoints are POST in
 * practice (every GraphQL query, every search-with-a-body). That is a
 * deliberate false negative: a POST this module cannot distinguish from a
 * mutating one is reported as a probe that was NOT PERFORMED, with the reason,
 * and the customer can tell us it is safe. The alternative is a cross-tenant
 * sweep that writes to another tenant's data, and there is no report format
 * that makes that acceptable.
 */
export const SAFE_PROBE_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;
export type SafeProbeMethod = (typeof SAFE_PROBE_METHODS)[number];

export function isSafeProbeMethod(method: string): method is SafeProbeMethod {
  return (SAFE_PROBE_METHODS as readonly string[]).includes(method.toUpperCase());
}

/**
 * Why a cross-tenant or authorization probe was not performed. Not a failure
 * and not a pass: an absence, with a reason, which the report must print.
 */
export const PROBE_REFUSAL_REASONS = [
  /** The verb would or might mutate the other tenant's data. See {@link SAFE_PROBE_METHODS}. */
  'UNSAFE_VERB',
  /** Both principals are in the same tenant, so the comparison is vacuous. */
  'SAME_TENANT',
  /** One side has no tenant, so there is no boundary to cross. */
  'NO_TENANCY',
  /** The holder has no usable session, so a denial would prove nothing. */
  'NO_HOLDER_SESSION',
  /** Nothing was harvested to ask for; a sweep over zero ids is not a sweep. */
  'NO_SUBJECT_IDS',
] as const;
export type ProbeRefusalReason = (typeof PROBE_REFUSAL_REASONS)[number];

/** Compile-time half of the parity guard. */
const PROBE_REFUSAL_REASON_PRESENT: Record<ProbeRefusalReason, true> = {
  UNSAFE_VERB: true,
  SAME_TENANT: true,
  NO_TENANCY: true,
  NO_HOLDER_SESSION: true,
  NO_SUBJECT_IDS: true,
};

/** Derived, never hand-listed. */
export const PROBE_REFUSAL_REASON_LIST = Object.keys(
  PROBE_REFUSAL_REASON_PRESENT,
) as ReadonlyArray<ProbeRefusalReason>;

/** A probe this module will perform, or a recorded refusal. Never an exception. */
export type ProbeAdmission =
  | { readonly admitted: true; readonly method: SafeProbeMethod; readonly tenants: TenantPair }
  | { readonly admitted: false; readonly reason: ProbeRefusalReason; readonly detail: string };

const PROBE_REFUSAL_DETAIL: Record<ProbeRefusalReason, string> = {
  UNSAFE_VERB:
    'the probe would use a verb that may change the other tenant\'s data, so it was not ' +
    'performed — only GET, HEAD and OPTIONS are swept automatically',
  SAME_TENANT:
    'both principals are in the same tenant, so a successful read proves nothing about ' +
    'cross-tenant access — configure a second tenant and the sweep becomes meaningful',
  NO_TENANCY: 'at least one principal has no tenant, so there is no boundary to cross',
  NO_HOLDER_SESSION:
    'the asking principal has no usable session, so a denial would be indistinguishable from ' +
    'being signed out',
  NO_SUBJECT_IDS:
    'no identifiers were harvested for the other tenant, so there was nothing to ask for — a ' +
    'sweep over zero ids is not a sweep',
};

/**
 * Decide whether a cross-tenant probe may run, READ-ONLY and SAFE-VERB by
 * default.
 *
 * Every arm that says no is a surface recorded as NOT PERFORMED with its
 * reason. None of them is a pass, and none of them is a zero: "0 cross-tenant
 * leaks" over a sweep that never ran is the exact lie this function exists to
 * make impossible.
 */
export function admitCrossTenantProbe(input: {
  method: string;
  holder: Principal;
  subject: Principal;
  subjectIdCount: number;
}): ProbeAdmission {
  const deny = (reason: ProbeRefusalReason): ProbeAdmission => ({
    admitted: false,
    reason,
    detail: PROBE_REFUSAL_DETAIL[reason],
  });

  if (!isSafeProbeMethod(input.method)) return deny('UNSAFE_VERB');
  if (input.holder.tenant === null || input.subject.tenant === null) return deny('NO_TENANCY');

  const tenants = tenantPair(input.holder.tenant, input.subject.tenant);
  if (!tenants.distinct) return deny('SAME_TENANT');
  if (!SESSIONED_LIFECYCLES.includes(input.holder.lifecycle)) return deny('NO_HOLDER_SESSION');
  if (input.subjectIdCount <= 0) return deny('NO_SUBJECT_IDS');

  return { admitted: true, method: input.method.toUpperCase() as SafeProbeMethod, tenants };
}
