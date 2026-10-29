/**
 * MULTI-ACTOR SCENARIOS — several identities inside ONE test.
 *
 * ── The defect this module exists to end ────────────────────────────────────
 *
 * `packages/runner/src/playwright-harness.ts` writes ONE storage-state file per
 * run, so every generated test has exactly one identity available to it. That
 * single fact makes a whole class of test inexpressible, and it is the class
 * where the expensive bugs are:
 *
 *   · invite-and-accept has no second actor to accept as;
 *   · submit-and-approve has no approver;
 *   · share-and-open has nobody to share with;
 *   · "an admin is served /admin and a member is refused it IN THE SAME MOMENT"
 *     cannot be asserted, because the two halves are two runs;
 *   · logging anybody out destroys the only way in, so session independence —
 *     does A's logout end B's session? — is never driven at all.
 *
 * `RunContext.sessions` (packages/shared/src/types.ts) and `Principal`
 * (packages/shared/src/principals.ts) made the shape expressible. This module
 * is what actually produces the scenarios: it derives the ACTOR SET from the
 * access matrix the enumerate slice built, matches each pattern against the
 * evidence that pattern needs, and emits a spec that opens one browser context
 * per principal.
 *
 * ── THE RULE THAT SHAPES EVERY DECISION BELOW ───────────────────────────────
 *
 * A PATTERN WHOSE EVIDENCE IS ABSENT IS REPORTED AS UNSUPPORTED, WITH THE
 * REASON AND THE REMEDY. It is never emitted as a scaffold.
 *
 * That is not fastidiousness. A two-actor test that opens two contexts, visits
 * two pages and asserts nothing about the handoff between them is a PASS THAT
 * MEANS "WE DID NOT CHECK" — the first entry on the list of lies this product
 * cannot afford — and it is worse than no test, because it closes the coverage
 * gap that would otherwise have gone on asking for the real one. So every
 * pattern names the evidence it requires, {@link enumerateMultiActorScenarios}
 * counts what it could not build, and {@link MultiActorEnumeration.unsupported}
 * carries one row per refusal with a sentence a customer can act on.
 *
 * ── Determinism ─────────────────────────────────────────────────────────────
 *
 * No `Math.random()`, no `Date.now()`, no ambient clock. The run seed is an
 * argument, scenario ids are a sha256 over (seed, pattern, subject) in the
 * shape `coverage.ts` already uses for gap ids, the comparator is TOTAL, and
 * {@link renderMultiActorSpec} is a pure string function. Two calls with the
 * same inputs produce byte-identical output, which is what makes a failing
 * multi-actor test debuggable at all.
 *
 * ── Security ────────────────────────────────────────────────────────────────
 *
 * NOTHING HERE EVER HOLDS OR EMITS A CREDENTIAL. A scenario names an identity
 * by pointing at an `AuthProfile` id; the emitted spec names an identity by
 * ACTOR NAME and reads that actor's storage state from a file path Playwright's
 * own documented multi-role convention puts it at. A provision field that
 * carries an inline value which LOOKS like a credential is REFUSED and the
 * refusal is recorded — see {@link PROVISION_REFUSALS} — because the one thing
 * worse than a missing signup scenario is a password written into the
 * customer's repository.
 */

import { createHash } from 'node:crypto';
import { ANONYMOUS_ROLE, isRouteAccessMeasured, roleKey } from '@qaai/shared';
import type { PlanItem, Priority, TestType } from '@qaai/shared';
/*
 * The principal vocabulary, through the package barrel.
 *
 * It was a relative path across the workspace boundary for one round — the
 * thing nine files did in one round, and a named lesson of this build, because
 * a relative path compiles while bypassing the package entry point and leaves
 * the keystone's compiler-enforced presence records guarding a file nobody
 * imports as a package. The barrel line landed; the import is ordinary again.
 */
import {
  DEFAULT_PRINCIPAL_NAME,
  bindDestructiveStep,
} from '@qaai/shared';
import type {
  DestructiveStepKind,
  DisposabilityRefusal,
  Principal,
} from '@qaai/shared';
import type { AccessMatrix, AccessMatrixCell } from './access-matrix.js';

// ─── A. The patterns ─────────────────────────────────────────────────────────

/**
 * The multi-actor shapes this module can produce.
 *
 * Five, and the list is short on purpose: every member is a pattern whose
 * evidence the enumerate slice can actually supply, and a sixth that could only
 * be built from a guess about the application would be a scaffold wearing a
 * pattern's name. Concurrency — two actors submitting the same form at once —
 * is deliberately NOT here: a race is a property of one submit button in two
 * flights and belongs with the race scenarios, not with identity.
 */
export const MULTI_ACTOR_PATTERNS = [
  /**
   * One route, two identities, ONE MOMENT. A is served it and B is refused it
   * while both sessions are live.
   *
   * The only pattern the access matrix supports with no further input, and the
   * one that is strictly stronger than what the matrix already says: a matrix
   * cell for A and a cell for B were observed in two passes, minutes or hours
   * apart, so "admin 200, member 403" cannot distinguish a working guard from a
   * route that was deployed between the two passes. Asserting both in one test
   * removes that interval.
   */
  'PRIVILEGE_DIVERGENCE',
  /** An inviter creates an invitation; the invitee signs in and sees it. */
  'INVITE_AND_ACCEPT',
  /** A submitter files something; an approver sees it waiting and acts. */
  'SUBMIT_AND_APPROVE',
  /** An owner shares a resource; the recipient can open it — and nobody else can. */
  'SHARED_RESOURCE_VISIBILITY',
  /**
   * A's session ends and B's must not. DESTRUCTIVE, and the only pattern here
   * that is: it needs a principal the scenario itself created, because the
   * alternative is logging out the customer's shared account and ending the run.
   */
  'SESSION_INDEPENDENCE',
] as const;
export type MultiActorPattern = (typeof MULTI_ACTOR_PATTERNS)[number];

/**
 * The compile-time half of the parity guard, copied from
 * `PRINCIPAL_KIND_PRESENT` in principals.ts and for the reason stated there: a
 * `Record` keyed on the union cannot be written without naming every member,
 * and the run-time half in `multi-actor.test.ts` compares the derived list
 * against {@link PATTERN_DESCRIPTORS}. Two mechanisms because each catches what
 * the other cannot — eight `GateRule` kinds shipped unsaveable for two slices
 * with only one of the two in place.
 */
const MULTI_ACTOR_PATTERN_PRESENT: Record<MultiActorPattern, true> = {
  PRIVILEGE_DIVERGENCE: true,
  INVITE_AND_ACCEPT: true,
  SUBMIT_AND_APPROVE: true,
  SHARED_RESOURCE_VISIBILITY: true,
  SESSION_INDEPENDENCE: true,
};

/** Derived, never hand-listed. See the record above. */
export const MULTI_ACTOR_PATTERN_LIST = Object.keys(
  MULTI_ACTOR_PATTERN_PRESENT,
) as ReadonlyArray<MultiActorPattern>;

/**
 * Where a pattern's evidence comes from. Three sources, and which one a pattern
 * uses decides what happens when nothing supplies it.
 */
export const MULTI_ACTOR_EVIDENCE_SOURCES = [
  /** The access matrix alone: two observed cells that disagree. */
  'ACCESS_MATRIX',
  /** A declared handoff — the crawl cannot infer "this is the invite flow". */
  'DECLARED_HANDOFF',
  /** An offer of a principal the scenario may create and then destroy. */
  'DISPOSABLE_OFFER',
] as const;
export type MultiActorEvidenceSource = (typeof MULTI_ACTOR_EVIDENCE_SOURCES)[number];

/**
 * What one pattern is, what it needs, and what it asserts.
 *
 * A `Record<MultiActorPattern, …>` so a sixth pattern cannot join the union
 * without deciding all six fields — including, deliberately, `destructiveStep`,
 * because "is this pattern allowed to damage an identity?" is the question that
 * must never be answered by omission.
 */
export interface MultiActorDescriptor {
  /** How many distinct actors the pattern needs. Never fewer than two. */
  readonly actors: number;
  readonly evidence: MultiActorEvidenceSource;
  /**
   * How many of the actors must hold a real session. Two for every handoff
   * pattern: an anonymous visitor cannot accept an invitation, and generating
   * one that tries would assert the login wall rather than the handoff.
   */
  readonly sessionedActors: number;
  /** The destructive step this pattern performs, or null when it performs none. */
  readonly destructiveStep: DestructiveStepKind | null;
  readonly priority: Priority;
  /** The sentence the generated test's assertion means. */
  readonly asserts: string;
  /** Why this pattern is worth a human's review time. */
  readonly rationale: string;
}

export const PATTERN_DESCRIPTORS: Record<MultiActorPattern, MultiActorDescriptor> = {
  PRIVILEGE_DIVERGENCE: {
    actors: 2,
    evidence: 'ACCESS_MATRIX',
    // ONE, not two: the refused actor may legitimately be the anonymous
    // visitor, and "anonymous is refused while the admin is served" is a weaker
    // but still real statement. The HOLDER must be sessioned; the subject need
    // not be.
    sessionedActors: 1,
    destructiveStep: null,
    priority: 'CRITICAL_PATH',
    asserts:
      'the route is served to the privileged actor and refused to the other one, with both ' +
      'sessions live at the same instant',
    rationale:
      'the access matrix holds these two facts from two separate passes, so it cannot tell a ' +
      'working authorization guard from a route that changed between them. One test with two ' +
      'contexts removes the interval.',
  },
  INVITE_AND_ACCEPT: {
    actors: 2,
    evidence: 'DECLARED_HANDOFF',
    sessionedActors: 2,
    destructiveStep: null,
    priority: 'CRITICAL_PATH',
    asserts: "the invitee sees the invitation the inviter created, and sees it as theirs",
    rationale:
      'the whole flow spans two identities, so with one session per run it has never been driven ' +
      'end to end — the half that creates the invite is tested and the half that accepts it is not.',
  },
  SUBMIT_AND_APPROVE: {
    actors: 2,
    evidence: 'DECLARED_HANDOFF',
    sessionedActors: 2,
    destructiveStep: null,
    priority: 'CRITICAL_PATH',
    asserts: "the approver sees the submitter's item waiting for a decision",
    rationale:
      'an approval queue that never shows the submitted item is a silent workflow failure: the ' +
      'submitter gets a success message and nothing ever happens. Neither half of the flow can see ' +
      'it alone.',
  },
  SHARED_RESOURCE_VISIBILITY: {
    actors: 2,
    evidence: 'DECLARED_HANDOFF',
    sessionedActors: 2,
    destructiveStep: null,
    priority: 'IMPORTANT',
    asserts: 'the recipient can open the shared resource',
    rationale:
      'sharing is the feature customers notice breaking, and it is exactly the feature a ' +
      'one-session suite cannot observe: the owner always sees their own resource.',
  },
  SESSION_INDEPENDENCE: {
    actors: 2,
    evidence: 'DISPOSABLE_OFFER',
    sessionedActors: 2,
    destructiveStep: 'LOGOUT',
    priority: 'IMPORTANT',
    asserts:
      "one actor's logout ends that actor's session and leaves the other actor's session working",
    rationale:
      'a logout that invalidates every session for a user — or, worse, a shared server-side ' +
      'session store that signs everybody out — is undriveable today because /logout is ' +
      'skip-listed and there is one account to lose.',
  },
};

// ─── B. Actors, derived from the access matrix ───────────────────────────────

/**
 * Why a role in the matrix cannot be an actor.
 *
 * Each is RECORDED rather than filtered silently, because "we generated no
 * multi-actor tests" and "we generated no multi-actor tests because the admin
 * login failed" have different remedies and only the second one has a fix in it.
 */
export const ACTOR_REJECTIONS = [
  /**
   * Every cell in this role's column is NOT_PROBED or DECLARED — nothing was
   * ever actually driven as this role. Using it as an actor would generate a
   * test against a session we have no evidence can be established, and the
   * failure would be filed against the customer's application.
   */
  'NO_MEASURED_CELL',
  /**
   * A credentialed role whose observed cells name no `AuthProfile`. The run has
   * nothing to resolve a session from, so the test would run anonymously and —
   * this is the defect — PASS, while being counted as role coverage.
   */
  'NO_AUTH_PROFILE',
  /**
   * The role is spelled the same as the run's default principal, so making it a
   * second actor would file the shared session under two names and the test
   * would act as one identity twice while reading as two.
   */
  'COLLIDES_WITH_DEFAULT',
] as const;
export type ActorRejection = (typeof ACTOR_REJECTIONS)[number];

/** Compile-time half of the parity guard. */
const ACTOR_REJECTION_PRESENT: Record<ActorRejection, true> = {
  NO_MEASURED_CELL: true,
  NO_AUTH_PROFILE: true,
  COLLIDES_WITH_DEFAULT: true,
};

/** Derived, never hand-listed. */
export const ACTOR_REJECTION_LIST = Object.keys(
  ACTOR_REJECTION_PRESENT,
) as ReadonlyArray<ActorRejection>;

const ACTOR_REJECTION_DETAIL: Record<ActorRejection, string> = {
  NO_MEASURED_CELL:
    'nothing in the access matrix was ever observed as this role, so there is no evidence a ' +
    "session for it can be established — re-run the role-aware crawl and check this role's " +
    'login before generating tests that act as it',
  NO_AUTH_PROFILE:
    'no auth profile is named on any observed cell for this role, so a run has nothing to resolve ' +
    'a session from. A test bound to it would browse anonymously and pass while being counted as ' +
    'coverage of this role',
  COLLIDES_WITH_DEFAULT:
    "this role is spelled exactly like the run's default principal, so a scenario naming it as a " +
    'second actor would file one session under two names and silently act as a single identity',
};

/**
 * One identity a scenario may act as.
 *
 * `name` is the SCENARIO'S name for the actor and is derived from the role, so
 * two enumerations over one matrix produce the same names — which is what makes
 * a stored scenario comparable to the next one. It is not an identifier of
 * anything in the customer's database; see the note on `Principal.name`.
 */
export interface ActorCandidate {
  readonly name: string;
  /** `roleKey()`-spelled, exactly as the matrix spells it. */
  readonly role: string;
  readonly authProfileId: string | null;
  /** True for the matrix's anonymous column. An actor with no credential. */
  readonly anonymous: boolean;
  /** Cells in this column that `isRouteAccessMeasured` accepts. */
  readonly measuredCells: number;
  /** Route templates this role was ALLOWED, sorted. */
  readonly allowed: readonly string[];
  /** Route templates this role was refused — FORBIDDEN or NOT_FOUND — sorted. */
  readonly refused: readonly string[];
}

export interface ActorDerivation {
  readonly actors: readonly ActorCandidate[];
  readonly rejected: ReadonlyArray<{
    readonly role: string;
    readonly reason: ActorRejection;
    readonly detail: string;
  }>;
}

/**
 * Turn the role columns of an access matrix into actors.
 *
 * ── Why the actor set is derived and not configured ────────────────────────
 *
 * Because a configured actor set is a guess about what roles exist, and the
 * guess is wrong in the direction that matters: it names the roles somebody
 * thought of, which is precisely the set already covered. The matrix's columns
 * are the roles that were actually driven, so deriving from it means a role
 * nobody remembered still gets scenarios — and a role that was configured but
 * whose crawl was held gets REJECTED with the reason instead of generating
 * tests against a session that does not work.
 *
 * Sorted by measured-cell count descending, then by role name, so the order is
 * stated rather than inherited from `Object.keys` iteration.
 */
export function deriveActors(matrix: AccessMatrix): ActorDerivation {
  const byRole = new Map<string, AccessMatrixCell[]>();
  for (const cell of matrix.cells) {
    const bucket = byRole.get(cell.role);
    if (bucket === undefined) byRole.set(cell.role, [cell]);
    else bucket.push(cell);
  }

  const actors: ActorCandidate[] = [];
  const rejected: Array<{ role: string; reason: ActorRejection; detail: string }> = [];

  const reject = (role: string, reason: ActorRejection): void => {
    rejected.push({ role, reason, detail: `${role}: ${ACTOR_REJECTION_DETAIL[reason]}` });
  };

  for (const role of [...matrix.roles].sort()) {
    const cells = byRole.get(role) ?? [];
    const measured = cells.filter((cell) => isRouteAccessMeasured(cell));
    if (measured.length === 0) {
      reject(role, 'NO_MEASURED_CELL');
      continue;
    }

    const anonymous = role === ANONYMOUS_ROLE;
    /*
     * The profile is read from the OBSERVED cells rather than taken as an
     * argument, because the cell is where the evidence is: a cell says "this
     * profile asked and this is what came back". A profile supplied beside the
     * matrix could name an identity no cell was produced under, which is the
     * cross-binding defect `testAuthBindingSchema` refuses one layer down.
     */
    const profile = measured.find((cell) => cell.authProfileId !== null)?.authProfileId ?? null;
    if (!anonymous && profile === null) {
      reject(role, 'NO_AUTH_PROFILE');
      continue;
    }

    const name = actorName(role);
    if (name === DEFAULT_PRINCIPAL_NAME) {
      reject(role, 'COLLIDES_WITH_DEFAULT');
      continue;
    }

    actors.push({
      name,
      role,
      authProfileId: profile,
      anonymous,
      measuredCells: measured.length,
      allowed: measured
        .filter((cell) => cell.outcome === 'ALLOWED')
        .map((cell) => cell.routeTemplate)
        .sort(),
      refused: measured
        .filter((cell) => cell.outcome === 'FORBIDDEN' || cell.outcome === 'NOT_FOUND')
        .map((cell) => cell.routeTemplate)
        .sort(),
    });
  }

  actors.sort((a, b) =>
    b.measuredCells !== a.measuredCells
      ? b.measuredCells - a.measuredCells
      : a.role.localeCompare(b.role),
  );

  return { actors, rejected };
}

/**
 * The scenario-local name for a role.
 *
 * Deterministic, and deliberately not the raw role: a role is customer text and
 * ends up in a TypeScript identifier and a filename in the generated spec. The
 * anonymous column gets `anonymous` rather than `<anonymous>`, because the
 * angle brackets are there to make {@link ANONYMOUS_ROLE} uncollidable with a
 * real role and they are not legal in either place.
 */
export function actorName(role: string): string {
  if (role === ANONYMOUS_ROLE) return 'anonymous';
  const cleaned = role
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'actor' : cleaned;
}

// ─── C. Declared evidence the matrix cannot produce ──────────────────────────

/** A locator the generated spec may use. ROLE+NAME only — see the note below. */
export interface ActorLocator {
  /** An ARIA role: 'button', 'link', 'textbox'. */
  readonly role: string;
  /** The accessible name, as a human reads it off the page. */
  readonly name: string;
}

/**
 * The three declared handoffs, one per handoff pattern.
 *
 * ── Why a handoff must be DECLARED and is never inferred ───────────────────
 *
 * Because "this is the invite flow" is not something a crawl observes. A
 * crawler sees `/team/members` and a button called "Invite"; calling that an
 * invite-and-accept handoff is a guess, and the test built on the guess asserts
 * a workflow the application may not have. So the evidence comes in from a
 * caller that read it — a journey a human approved, an API operation pair, a
 * requirement — and when nothing supplies it the pattern is reported as
 * UNSUPPORTED with that exact remedy.
 */
export const HANDOFF_KINDS = ['INVITE', 'APPROVAL', 'SHARE'] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];

/**
 * Which pattern each handoff kind produces.
 *
 * A `Record` rather than a `switch`, so a fourth handoff kind cannot be added
 * without naming the pattern it builds — and so the pattern list and the
 * handoff list cannot drift into "a kind nothing consumes".
 */
export const HANDOFF_PATTERN: Record<HandoffKind, MultiActorPattern> = {
  INVITE: 'INVITE_AND_ACCEPT',
  APPROVAL: 'SUBMIT_AND_APPROVE',
  SHARE: 'SHARED_RESOURCE_VISIBILITY',
};

export interface ActorHandoff {
  readonly kind: HandoffKind;
  /** The role that acts first. `roleKey()`-spelled, as the matrix spells it. */
  readonly producerRole: string;
  /** The role that must then observe the result. */
  readonly consumerRole: string;
  /** The route the producer acts on. A concrete path, not a template. */
  readonly producerRoute: string;
  /**
   * The affordance the producer activates, or null when nobody captured one.
   *
   * Null is a REFUSAL, not a default: a handoff test whose producer half clicks
   * nothing observes a page and calls it a workflow.
   */
  readonly producerAffordance: ActorLocator | null;
  /** The route the consumer checks. A concrete path, not a template. */
  readonly consumerRoute: string;
  /**
   * The text the consumer must see for the handoff to have happened, or null.
   *
   * Null is a REFUSAL for the same reason: "the page loaded" is not evidence
   * that an invitation arrived, and a test that asserts only the load is the
   * pass-that-means-nothing this module refuses to emit.
   */
  readonly consumerSignal: string | null;
  /** Where this claim came from, so it can be disputed. Never empty. */
  readonly evidence: string;
}

/**
 * One field of the signup the scenario performs to create its disposable
 * principal.
 *
 * EXACTLY ONE of `value` and `secretName` is set, and the asymmetry is the
 * security guarantee: a non-secret field carries its value and is inlined in
 * the spec; a credential names a vault entry and the spec reads it out of the
 * child's own environment, which `childEnv` already fills from `ctx.secrets`.
 * Nothing else is accepted — see {@link PROVISION_REFUSALS}.
 */
export interface ProvisionField {
  readonly locator: ActorLocator;
  readonly value: string | null;
  /** The customer's own vault entry name. A NAME, never a value. */
  readonly secretName: string | null;
}

/**
 * An offer of a principal this scenario may create and then destroy.
 *
 * The scenario CREATES it — that is what makes it destroyable. `proveDisposable`
 * refuses a principal with no `createdByScenario` precisely so that a
 * long-lived account the customer happened to mark disposable cannot be
 * logged out by a generated test, and this type is the shape that satisfies it
 * honestly: a route, an affordance and the data to fill the form.
 */
export interface DisposableActorOffer {
  /** The role the created principal will hold, as the application spells it. */
  readonly role: string;
  /** Where the scenario signs up. A concrete path. */
  readonly provisionRoute: string;
  /** The submit affordance on the signup form. */
  readonly provisionAffordance: ActorLocator | null;
  /** The fields to fill. Empty is a refusal: a signup that fills nothing is not one. */
  readonly provisionFields: readonly ProvisionField[];
  /** The log-out affordance, which is the destructive step itself. */
  readonly logoutAffordance: ActorLocator | null;
  readonly evidence: string;
}

/**
 * Why a provision field cannot be used.
 *
 * `CREDENTIAL_INLINED` is the one that matters and it is a hard refusal in both
 * directions: a field whose locator names a password, secret, token or OTP may
 * not carry an inline value, and a field carrying an inline value that is
 * itself shaped like a credential may not be emitted. The generated spec goes
 * into the customer's repository; a password in it outlives every rotation
 * policy they have.
 */
export const PROVISION_REFUSALS = [
  'NO_VALUE_SOURCE',
  'BOTH_VALUE_AND_SECRET',
  'CREDENTIAL_INLINED',
] as const;
export type ProvisionRefusal = (typeof PROVISION_REFUSALS)[number];

/** Compile-time half of the parity guard. */
const PROVISION_REFUSAL_PRESENT: Record<ProvisionRefusal, true> = {
  NO_VALUE_SOURCE: true,
  BOTH_VALUE_AND_SECRET: true,
  CREDENTIAL_INLINED: true,
};

/** Derived, never hand-listed. */
export const PROVISION_REFUSAL_LIST = Object.keys(
  PROVISION_REFUSAL_PRESENT,
) as ReadonlyArray<ProvisionRefusal>;

const PROVISION_REFUSAL_DETAIL: Record<ProvisionRefusal, string> = {
  NO_VALUE_SOURCE:
    'names neither a value nor a vault entry, so the signup form cannot be filled and the ' +
    'disposable principal cannot be created',
  BOTH_VALUE_AND_SECRET:
    'names both an inline value and a vault entry, and nothing decides which one wins — a field ' +
    'that resolves differently in two runs is a flake with a credential in it',
  CREDENTIAL_INLINED:
    'is a credential field with an inline value. A password, secret, token or one-time code may ' +
    'never be written into a generated spec: the file goes into the customer’s repository and ' +
    'outlives every rotation policy they have. Name a vault entry instead',
};

/**
 * Whether a field holds a credential, judged from the locator a human reads.
 *
 * Deliberately broad, and deliberately applied to BOTH halves: the locator name
 * decides whether an inline value is allowed at all, and the value is checked
 * for looking like a secret regardless of what the locator is called. A false
 * positive costs one field that has to name a vault entry; a false negative
 * costs a password in a git repository, and those are not comparable.
 */
const CREDENTIAL_WORDS =
  /\b(?:pass(?:word|phrase)?|pwd|secret|token|api[-\s]?key|otp|one[-\s]?time|2fa|mfa|totp|cvv|pin)\b/i;

function isCredentialField(field: ProvisionField): boolean {
  return (
    CREDENTIAL_WORDS.test(field.locator.name) ||
    CREDENTIAL_WORDS.test(field.locator.role) ||
    (field.value !== null && CREDENTIAL_WORDS.test(field.value))
  );
}

/**
 * Check every provision field, returning the refusals rather than throwing.
 *
 * A value, because it has to reach the report. A throw here becomes a caught
 * exception somewhere and then a scenario that silently is not in the list,
 * which is indistinguishable from an application with no signup form.
 */
export function checkProvisionFields(
  fields: readonly ProvisionField[],
): ReadonlyArray<{ readonly field: string; readonly reason: ProvisionRefusal; readonly detail: string }> {
  const refusals: Array<{ field: string; reason: ProvisionRefusal; detail: string }> = [];
  for (const field of fields) {
    const label = `${field.locator.role} "${field.locator.name}"`;
    const push = (reason: ProvisionRefusal): void => {
      refusals.push({ field: label, reason, detail: `${label} ${PROVISION_REFUSAL_DETAIL[reason]}` });
    };
    if (field.value !== null && field.secretName !== null) push('BOTH_VALUE_AND_SECRET');
    else if (field.value === null && field.secretName === null) push('NO_VALUE_SOURCE');
    else if (field.value !== null && isCredentialField(field)) push('CREDENTIAL_INLINED');
  }
  return refusals;
}

// ─── D. The scenario ─────────────────────────────────────────────────────────

/**
 * What one step does, in a form the emitter can turn into code.
 *
 * A closed vocabulary rather than free text, because free text is what the
 * model-backed generator takes and this module is the MODEL-FREE path: a step
 * the emitter cannot express must be impossible to construct, not merely
 * unlikely. Every member here has exactly one rendering in
 * {@link renderMultiActorSpec}.
 */
export const MULTI_ACTOR_STEP_KINDS = [
  /** Navigate and assert the actor was served the page. */
  'VISIT_EXPECT_SERVED',
  /** Navigate and assert the actor was NOT served it. */
  'VISIT_EXPECT_REFUSED',
  /** Activate an affordance. */
  'ACTIVATE',
  /** Fill one field. */
  'FILL',
  /** Assert text is present for this actor. */
  'EXPECT_TEXT',
  /** Assert text is absent for this actor. */
  'EXPECT_NO_TEXT',
] as const;
export type MultiActorStepKind = (typeof MULTI_ACTOR_STEP_KINDS)[number];

/** Compile-time half of the parity guard. */
const MULTI_ACTOR_STEP_KIND_PRESENT: Record<MultiActorStepKind, true> = {
  VISIT_EXPECT_SERVED: true,
  VISIT_EXPECT_REFUSED: true,
  ACTIVATE: true,
  FILL: true,
  EXPECT_TEXT: true,
  EXPECT_NO_TEXT: true,
};

/** Derived, never hand-listed. */
export const MULTI_ACTOR_STEP_KIND_LIST = Object.keys(
  MULTI_ACTOR_STEP_KIND_PRESENT,
) as ReadonlyArray<MultiActorStepKind>;

/**
 * One step, and it NAMES ITS ACTOR.
 *
 * That field is the whole point of this module. A step list with no actor on it
 * can only be executed by one identity, which is the state the product was in.
 */
export interface MultiActorStep {
  /** The {@link ActorCandidate.name} this step is performed as. */
  readonly actor: string;
  readonly kind: MultiActorStepKind;
  /** The path to navigate, for the two VISIT kinds. Null otherwise. */
  readonly route: string | null;
  /** The element to act on, for ACTIVATE and FILL. Null otherwise. */
  readonly locator: ActorLocator | null;
  /** The text to assert, or the literal to type. Null when neither applies. */
  readonly text: string | null;
  /** The vault entry whose value to type, for a credential FILL. A name only. */
  readonly secretName: string | null;
  /** Plain English, for the plan item a human approves. Never empty. */
  readonly description: string;
}

export interface MultiActorScenario {
  /** Deterministic: sha256 over (seed, pattern, subject). Stable across runs. */
  readonly id: string;
  readonly pattern: MultiActorPattern;
  readonly title: string;
  /** The actors this scenario needs, in the order they first act. */
  readonly principals: readonly Principal[];
  readonly steps: readonly MultiActorStep[];
  /** Plain-English assertions for the plan item. Never empty. */
  readonly assertions: readonly string[];
  readonly priority: Priority;
  /** The evidence this scenario rests on, so a reviewer can dispute it. */
  readonly evidence: string;
  /**
   * The destructive step, when the pattern has one, together with whether it was
   * PERMITTED. A refusal is carried here rather than suppressing the scenario,
   * so the report can say "this check was not performed, and why".
   */
  readonly destructive: {
    readonly kind: DestructiveStepKind;
    readonly permitted: boolean;
    readonly refusal: DisposabilityRefusal | null;
  } | null;
}

// ─── E. Enumeration ──────────────────────────────────────────────────────────

/**
 * Why a pattern produced no scenario.
 *
 * Every member is a sentence the report prints beside the pattern it stopped,
 * and none of them is a zero: "0 multi-actor tests" over an application with
 * four roles is a number that reads as a clean bill of health.
 */
export const UNSUPPORTED_REASONS = [
  /** Fewer actors than the pattern needs survived {@link deriveActors}. */
  'TOO_FEW_ACTORS',
  /** The pattern needs two sessioned actors and only one is credentialed. */
  'TOO_FEW_SESSIONED_ACTORS',
  /** No (route, pair) where one actor is served and the other refused. */
  'NO_DIVERGENT_ROUTE',
  /**
   * A divergent route exists and its template carries a parameter nobody
   * supplied an instance for, so there is no URL to navigate. OUR gap.
   */
  'TEMPLATE_NOT_INSTANTIABLE',
  /** Nothing declared a handoff of this kind. */
  'NO_DECLARED_HANDOFF',
  /** A handoff was declared and carries no producer affordance to activate. */
  'NO_PRODUCER_AFFORDANCE',
  /** A handoff was declared and names no signal the consumer could observe. */
  'NO_CONSUMER_SIGNAL',
  /** A handoff names a role that is not an actor. */
  'HANDOFF_ROLE_NOT_AN_ACTOR',
  /** No offer of a principal the scenario may create, so nothing may be destroyed. */
  'NO_DISPOSABLE_OFFER',
  /** The offer is missing the affordances or the data the signup needs. */
  'DISPOSABLE_OFFER_INCOMPLETE',
  /** A provision field was refused — most seriously, a credential inlined. */
  'PROVISION_FIELD_REFUSED',
] as const;
export type UnsupportedReason = (typeof UNSUPPORTED_REASONS)[number];

/** Compile-time half of the parity guard. */
const UNSUPPORTED_REASON_PRESENT: Record<UnsupportedReason, true> = {
  TOO_FEW_ACTORS: true,
  TOO_FEW_SESSIONED_ACTORS: true,
  NO_DIVERGENT_ROUTE: true,
  TEMPLATE_NOT_INSTANTIABLE: true,
  NO_DECLARED_HANDOFF: true,
  NO_PRODUCER_AFFORDANCE: true,
  NO_CONSUMER_SIGNAL: true,
  HANDOFF_ROLE_NOT_AN_ACTOR: true,
  NO_DISPOSABLE_OFFER: true,
  DISPOSABLE_OFFER_INCOMPLETE: true,
  PROVISION_FIELD_REFUSED: true,
};

/** Derived, never hand-listed. */
export const UNSUPPORTED_REASON_LIST = Object.keys(
  UNSUPPORTED_REASON_PRESENT,
) as ReadonlyArray<UnsupportedReason>;

const UNSUPPORTED_DETAIL: Record<UnsupportedReason, string> = {
  TOO_FEW_ACTORS:
    'fewer than two identities survived derivation from the access matrix, so there is no second ' +
    'actor to be — check the rejected roles for the reason',
  TOO_FEW_SESSIONED_ACTORS:
    'this pattern needs two identities that actually hold a session, and only one credentialed ' +
    'role was derivable. An anonymous visitor cannot accept an invitation or approve a submission',
  NO_DIVERGENT_ROUTE:
    'no route was observed as served to one actor and refused to another, so there is no ' +
    'authorization boundary to assert. That is not a clean bill of health: it most often means ' +
    'only one role was ever crawled',
  TEMPLATE_NOT_INSTANTIABLE:
    'the only divergent routes are parameterised templates and no concrete instance was supplied, ' +
    'so there is no URL to navigate. Supply an instance the crawl actually visited',
  NO_DECLARED_HANDOFF:
    'nothing declared a handoff of this kind. A crawl cannot infer that a button called "Invite" ' +
    'begins an invite-and-accept flow, and generating one from the guess would assert a workflow ' +
    'the application may not have — declare the handoff from a journey or an API operation pair',
  NO_PRODUCER_AFFORDANCE:
    'the declared handoff names no affordance for the producer to activate, so the first half of ' +
    'the flow would do nothing and the test would observe a page and call it a workflow',
  NO_CONSUMER_SIGNAL:
    'the declared handoff names nothing the consumer could observe, so the test could only assert ' +
    'that a page loaded — which is a pass that means "we did not check"',
  HANDOFF_ROLE_NOT_AN_ACTOR:
    'the declared handoff names a role that did not survive derivation from the access matrix, so ' +
    'one side of the flow has no identity to be',
  NO_DISPOSABLE_OFFER:
    'no disposable principal was offered. A destructive scenario runs only against an identity the ' +
    'scenario itself created, so without a signup it can reach there is nothing it may damage — ' +
    "and the customer's own account may never be it",
  DISPOSABLE_OFFER_INCOMPLETE:
    'the disposable offer is missing the signup affordance, the logout affordance or the fields to ' +
    'fill, so the scenario could not create the principal it is required to create before ' +
    'destroying anything',
  PROVISION_FIELD_REFUSED:
    'a signup field was refused, so the disposable principal cannot be created — see the field ' +
    'refusals for which one and why',
};

/**
 * What the enumeration produced, and everything it did not.
 *
 * `considered`, `unsupported` and `omittedByCap` exist so the parts sum to the
 * whole: a reader can check that every pattern is accounted for exactly once,
 * which is what stops a silently dropped pattern reading as an application with
 * nothing to test.
 */
export interface MultiActorEnumeration {
  readonly scenarios: readonly MultiActorScenario[];
  /** How many (pattern, actor-pair) combinations were examined. */
  readonly considered: number;
  /** The actors, so a caller can render the columns the scenarios act on. */
  readonly actors: readonly ActorCandidate[];
  /** Roles the matrix had that could not be actors, with the reason. */
  readonly rejectedActors: ActorDerivation['rejected'];
  /** One row per pattern that produced nothing, with the reason and remedy. */
  readonly unsupported: ReadonlyArray<{
    readonly pattern: MultiActorPattern;
    readonly reason: UnsupportedReason;
    readonly detail: string;
  }>;
  /** Refused provision fields, so a credential refusal is visible, not swallowed. */
  readonly provisionRefusals: ReturnType<typeof checkProvisionFields>;
  /** Suppressed by `limit`. Zero when no cap bit. */
  readonly omittedByCap: number;
  /**
   * Why the cap bit, or null when it did not. Non-null EXACTLY when
   * `omittedByCap > 0`, so a reader never sees a shortfall with no reason.
   */
  readonly capReason: string | null;
}

export interface MultiActorInput {
  readonly matrix: AccessMatrix;
  /**
   * The run seed. Mixed into every scenario id, so two projects crawling the
   * same open-source application do not collide, and one project re-running the
   * same crawl produces the same ids.
   */
  readonly seed: string;
  /** Concrete paths for parameterised templates: template → a visited instance. */
  readonly routeInstances?: Readonly<Record<string, string>>;
  readonly handoffs?: readonly ActorHandoff[];
  readonly disposable?: DisposableActorOffer | null;
  /** Caps the scenarios returned. Reported as a count and a reason when it bites. */
  readonly limit?: number;
}

/**
 * Enumerate every pattern against the actors the matrix supports.
 *
 * DETERMINISTIC: the seed is an argument, there is no clock and no randomness,
 * and the output order is the declared order of {@link MULTI_ACTOR_PATTERNS}
 * then of the actor pairs, which `deriveActors` has already sorted totally.
 *
 * ── What `considered` counts, precisely ────────────────────────────────────
 *
 * One per (pattern, candidate subject) examined — the actor PAIRS for the
 * matrix pattern, the declared handoffs for the handoff patterns, and one for
 * the disposable pattern whether an offer exists or not. It is an accounting
 * number, not a measurement of the application, and the test that holds the
 * parts to the whole is what keeps it honest.
 */
export function enumerateMultiActorScenarios(input: MultiActorInput): MultiActorEnumeration {
  const { actors, rejected } = deriveActors(input.matrix);
  const scenarios: MultiActorScenario[] = [];
  const unsupported: Array<{
    pattern: MultiActorPattern;
    reason: UnsupportedReason;
    detail: string;
  }> = [];
  let considered = 0;

  const unsupport = (pattern: MultiActorPattern, reason: UnsupportedReason): void => {
    unsupported.push({ pattern, reason, detail: `${pattern}: ${UNSUPPORTED_DETAIL[reason]}` });
  };

  const sessioned = actors.filter((actor) => !actor.anonymous);
  const instances = input.routeInstances ?? {};

  // ── PRIVILEGE_DIVERGENCE, from the matrix alone ──────────────────────────
  {
    const pattern: MultiActorPattern = 'PRIVILEGE_DIVERGENCE';
    /*
     * The sessioned check comes FIRST, and the order is a correctness decision
     * rather than a style one. A matrix with only the anonymous column has one
     * actor AND no session, and both sentences are true — but "no credentialed
     * role was derivable" names the fix (check the login) while "fewer than two
     * identities" sends the reader looking for a second role they may well
     * have. Asking the other way round also leaves this arm UNREACHABLE: there
     * is exactly one anonymous role, so two actors always include one
     * credentialed one, and a guard that cannot fire is a guard nobody can test.
     */
    if (sessioned.length < 1) {
      considered += 1;
      unsupport(pattern, 'TOO_FEW_SESSIONED_ACTORS');
    } else if (actors.length < 2) {
      considered += 1;
      unsupport(pattern, 'TOO_FEW_ACTORS');
    } else {
      let found = 0;
      let templateBlocked = 0;
      for (const holder of sessioned) {
        for (const subject of actors) {
          if (subject.name === holder.name) continue;
          considered += 1;
          const divergent = holder.allowed.filter((route) => subject.refused.includes(route));
          if (divergent.length === 0) continue;
          /*
           * The FIRST divergent route in sorted order, not all of them. One
           * scenario per actor pair, because a pair that diverges on forty
           * admin routes produces forty near-identical tests, and a review
           * queue nobody clears is a queue that gets dismissed wholesale —
           * taking the one test that mattered with it.
           */
          const navigable = divergent.find((route) => resolveRoute(route, instances) !== null);
          if (navigable === undefined) {
            templateBlocked += 1;
            continue;
          }
          const url = resolveRoute(navigable, instances)!;
          scenarios.push(
            privilegeDivergenceScenario(input.seed, holder, subject, navigable, url),
          );
          found += 1;
        }
      }
      if (found === 0) {
        unsupport(pattern, templateBlocked > 0 ? 'TEMPLATE_NOT_INSTANTIABLE' : 'NO_DIVERGENT_ROUTE');
      }
    }
  }

  // ── The three declared handoffs ──────────────────────────────────────────
  const byActorName = new Map(actors.map((actor) => [actor.role, actor]));
  const handoffs = input.handoffs ?? [];
  for (const kind of HANDOFF_KINDS) {
    const pattern = HANDOFF_PATTERN[kind];
    const declared = handoffs.filter((handoff) => handoff.kind === kind);
    if (declared.length === 0) {
      considered += 1;
      unsupport(pattern, 'NO_DECLARED_HANDOFF');
      continue;
    }
    let found = 0;
    let lastReason: UnsupportedReason = 'NO_DECLARED_HANDOFF';
    for (const handoff of declared) {
      considered += 1;
      const producer = byActorName.get(roleKey(handoff.producerRole));
      const consumer = byActorName.get(roleKey(handoff.consumerRole));
      if (
        producer === undefined ||
        consumer === undefined ||
        producer.name === consumer.name
      ) {
        lastReason = 'HANDOFF_ROLE_NOT_AN_ACTOR';
        continue;
      }
      if (producer.anonymous || consumer.anonymous) {
        lastReason = 'TOO_FEW_SESSIONED_ACTORS';
        continue;
      }
      if (handoff.producerAffordance === null) {
        lastReason = 'NO_PRODUCER_AFFORDANCE';
        continue;
      }
      if (handoff.consumerSignal === null) {
        lastReason = 'NO_CONSUMER_SIGNAL';
        continue;
      }
      scenarios.push(handoffScenario(input.seed, handoff, producer, consumer));
      found += 1;
    }
    if (found === 0) unsupport(pattern, lastReason);
  }

  // ── SESSION_INDEPENDENCE, the destructive one ────────────────────────────
  const provisionRefusals = checkProvisionFields(input.disposable?.provisionFields ?? []);
  {
    const pattern: MultiActorPattern = 'SESSION_INDEPENDENCE';
    considered += 1;
    const offer = input.disposable ?? null;
    const survivor = sessioned[0];
    if (offer === null) unsupport(pattern, 'NO_DISPOSABLE_OFFER');
    else if (survivor === undefined) unsupport(pattern, 'TOO_FEW_SESSIONED_ACTORS');
    else if (
      offer.provisionAffordance === null ||
      offer.logoutAffordance === null ||
      offer.provisionFields.length === 0
    ) {
      unsupport(pattern, 'DISPOSABLE_OFFER_INCOMPLETE');
    } else if (provisionRefusals.length > 0) {
      unsupport(pattern, 'PROVISION_FIELD_REFUSED');
    } else {
      /*
       * Every surviving route is one the SURVIVOR was observed ALLOWED on. The
       * assertion "B's session still works" is only meaningful against a page B
       * can only see while signed in, and an allowed cell is the only evidence
       * of that we hold.
       */
      const survivingRoute = survivor.allowed
        .map((route) => resolveRoute(route, instances))
        .find((url): url is string => url !== null);
      if (survivingRoute === undefined) unsupport(pattern, 'TEMPLATE_NOT_INSTANTIABLE');
      else {
        scenarios.push(sessionIndependenceScenario(input.seed, offer, survivor, survivingRoute));
      }
    }
  }

  const base = {
    actors,
    rejectedActors: rejected,
    unsupported,
    provisionRefusals,
    considered,
  };

  const limit = input.limit;
  if (limit === undefined || scenarios.length <= limit) {
    return { ...base, scenarios, omittedByCap: 0, capReason: null };
  }
  const omittedByCap = scenarios.length - limit;
  return {
    ...base,
    scenarios: scenarios.slice(0, limit),
    omittedByCap,
    capReason:
      `a limit of ${limit} multi-actor scenarios was applied, so at least ${omittedByCap} more ` +
      'that this matrix supports were not proposed — raise the limit to see them',
  };
}

/**
 * A concrete path for a route template, or null when there is none.
 *
 * A template with a `:param` or a `{param}` segment is NOT navigable: visiting
 * `/orders/:id` literally asks for an order whose id is the string ":id", and
 * the 404 that comes back would be reported as an authorization finding. Null
 * is therefore the honest answer, and the caller turns it into
 * TEMPLATE_NOT_INSTANTIABLE rather than into a test.
 */
export function resolveRoute(
  template: string,
  instances: Readonly<Record<string, string>>,
): string | null {
  const supplied = instances[template];
  if (typeof supplied === 'string' && supplied !== '') return supplied;
  return /:[A-Za-z0-9_]+|\{[^}]+\}|\*/.test(template) ? null : template;
}

/**
 * A stable scenario id.
 *
 * sha256 over NUL-separated parts, exactly as `gapId` in coverage.ts does and
 * for the same reason: NUL cannot occur in a route, a role or a seed, so
 * `scenarioId(s, 'P', 'a b')` and `scenarioId(s, 'P', 'a', 'b')` can never
 * collide onto one id.
 */
export function scenarioId(seed: string, pattern: MultiActorPattern, ...parts: string[]): string {
  const digest = createHash('sha256')
    .update([seed, pattern, ...parts].join('\u0000'))
    .digest('hex');
  return `ma_${digest.slice(0, 16)}`;
}

/** A principal for an actor. PERSISTENT unless the scenario creates it. */
function principalFor(actor: ActorCandidate): Principal {
  return {
    name: actor.name,
    kind: actor.anonymous ? 'ANONYMOUS' : 'PERSISTENT',
    lifecycle: 'DECLARED',
    role: actor.anonymous ? null : actor.role,
    authProfileId: actor.anonymous ? null : actor.authProfileId,
    authProfileKind: null,
    tenant: null,
    createdByScenario: null,
  };
}

function privilegeDivergenceScenario(
  seed: string,
  holder: ActorCandidate,
  subject: ActorCandidate,
  template: string,
  url: string,
): MultiActorScenario {
  const id = scenarioId(seed, 'PRIVILEGE_DIVERGENCE', holder.role, subject.role, template);
  return {
    id,
    pattern: 'PRIVILEGE_DIVERGENCE',
    title: `${holder.role} is served ${template} while ${subject.role} is refused it`,
    principals: [principalFor(holder), principalFor(subject)],
    steps: [
      {
        actor: holder.name,
        kind: 'VISIT_EXPECT_SERVED',
        route: url,
        locator: null,
        text: null,
        secretName: null,
        description: `as ${holder.role}, open ${url} and confirm it is served`,
      },
      {
        actor: subject.name,
        kind: 'VISIT_EXPECT_REFUSED',
        route: url,
        locator: null,
        text: null,
        secretName: null,
        description: `as ${subject.role}, open ${url} and confirm it is refused`,
      },
    ],
    assertions: [
      `${holder.role} receives a successful response for ${url}`,
      `${subject.role} does not receive a successful response for ${url}, in the same test run`,
    ],
    priority: PATTERN_DESCRIPTORS.PRIVILEGE_DIVERGENCE.priority,
    evidence:
      `the access matrix observed ${template} as ALLOWED for ${holder.role} and refused for ` +
      `${subject.role}, in two separate passes`,
    destructive: null,
  };
}

function handoffScenario(
  seed: string,
  handoff: ActorHandoff,
  producer: ActorCandidate,
  consumer: ActorCandidate,
): MultiActorScenario {
  const pattern = HANDOFF_PATTERN[handoff.kind];
  const affordance = handoff.producerAffordance!;
  const signal = handoff.consumerSignal!;
  const id = scenarioId(
    seed,
    pattern,
    producer.role,
    consumer.role,
    handoff.producerRoute,
    handoff.consumerRoute,
  );
  return {
    id,
    pattern,
    title: `${producer.role} acts on ${handoff.producerRoute} and ${consumer.role} sees it on ${handoff.consumerRoute}`,
    principals: [principalFor(producer), principalFor(consumer)],
    steps: [
      {
        actor: producer.name,
        kind: 'VISIT_EXPECT_SERVED',
        route: handoff.producerRoute,
        locator: null,
        text: null,
        secretName: null,
        description: `as ${producer.role}, open ${handoff.producerRoute}`,
      },
      {
        actor: producer.name,
        kind: 'ACTIVATE',
        route: null,
        locator: affordance,
        text: null,
        secretName: null,
        description: `as ${producer.role}, activate "${affordance.name}"`,
      },
      {
        actor: consumer.name,
        kind: 'VISIT_EXPECT_SERVED',
        route: handoff.consumerRoute,
        locator: null,
        text: null,
        secretName: null,
        description: `as ${consumer.role}, open ${handoff.consumerRoute}`,
      },
      {
        actor: consumer.name,
        kind: 'EXPECT_TEXT',
        route: null,
        locator: null,
        text: signal,
        secretName: null,
        description: `as ${consumer.role}, confirm "${signal}" is present`,
      },
    ],
    assertions: [
      `${consumer.role} sees "${signal}" after ${producer.role} activated "${affordance.name}"`,
    ],
    priority: PATTERN_DESCRIPTORS[pattern].priority,
    evidence: handoff.evidence,
    destructive: null,
  };
}

/**
 * The destructive scenario, with disposability PROVED rather than assumed.
 *
 * `bindDestructiveStep` is called here, in the generator, and its verdict is
 * carried on the scenario — so a refusal becomes a scenario the report shows as
 * NOT PERFORMED with the reason, instead of a scenario that is quietly absent.
 * The binding is lazy: nothing is destroyed by enumerating.
 */
function sessionIndependenceScenario(
  seed: string,
  offer: DisposableActorOffer,
  survivor: ActorCandidate,
  survivingUrl: string,
): MultiActorScenario {
  const id = scenarioId(seed, 'SESSION_INDEPENDENCE', offer.role, survivor.role, survivingUrl);
  const doomedName = `${actorName(offer.role)}-disposable`;
  const doomed: Principal = {
    name: doomedName,
    kind: 'DISPOSABLE',
    lifecycle: 'DECLARED',
    role: offer.role,
    /*
     * NULL, and that is correct rather than an omission: this principal does
     * not exist yet. The scenario creates it by filling the signup form, so
     * there is no `AuthProfile` row to point at — and claiming one would be a
     * binding to an identity nothing resolved.
     */
    authProfileId: null,
    authProfileKind: null,
    tenant: null,
    // THE FIELD THAT MAKES IT DESTROYABLE. `proveDisposable` refuses a
    // disposable principal with no creating scenario, which is what stops a
    // long-lived account the customer marked disposable from being logged out.
    createdByScenario: id,
  };

  const bound = bindDestructiveStep('LOGOUT', doomed, () => undefined);

  const steps: MultiActorStep[] = [
    {
      actor: doomedName,
      kind: 'VISIT_EXPECT_SERVED',
      route: offer.provisionRoute,
      locator: null,
      text: null,
      secretName: null,
      description: `open ${offer.provisionRoute} to create the throwaway account this scenario destroys`,
    },
    ...offer.provisionFields.map(
      (field): MultiActorStep => ({
        actor: doomedName,
        kind: 'FILL',
        route: null,
        locator: field.locator,
        text: field.value,
        secretName: field.secretName,
        description:
          field.secretName === null
            ? `fill "${field.locator.name}"`
            : `fill "${field.locator.name}" from the vault entry ${field.secretName}`,
      }),
    ),
    {
      actor: doomedName,
      kind: 'ACTIVATE',
      route: null,
      locator: offer.provisionAffordance!,
      text: null,
      secretName: null,
      description: `submit the signup as "${offer.provisionAffordance!.name}"`,
    },
    {
      actor: survivor.name,
      kind: 'VISIT_EXPECT_SERVED',
      route: survivingUrl,
      locator: null,
      text: null,
      secretName: null,
      description: `as ${survivor.role}, confirm ${survivingUrl} is served before the logout`,
    },
    {
      actor: doomedName,
      kind: 'ACTIVATE',
      route: null,
      locator: offer.logoutAffordance!,
      text: null,
      secretName: null,
      description: `log the throwaway account out via "${offer.logoutAffordance!.name}"`,
    },
    {
      actor: survivor.name,
      kind: 'VISIT_EXPECT_SERVED',
      route: survivingUrl,
      locator: null,
      text: null,
      secretName: null,
      description: `as ${survivor.role}, confirm ${survivingUrl} is STILL served after the other actor logged out`,
    },
  ];

  return {
    id,
    pattern: 'SESSION_INDEPENDENCE',
    title: `a throwaway ${offer.role} logging out does not end ${survivor.role}'s session`,
    principals: [doomed, principalFor(survivor)],
    steps,
    assertions: [
      `the throwaway account is created by this scenario and is the only identity it damages`,
      `${survivor.role} is still served ${survivingUrl} after the throwaway account logs out`,
    ],
    priority: PATTERN_DESCRIPTORS.SESSION_INDEPENDENCE.priority,
    evidence: offer.evidence,
    destructive: {
      kind: 'LOGOUT',
      permitted: bound.permitted,
      refusal: bound.permitted ? null : bound.refusal,
    },
  };
}

// ─── F. The plan item ────────────────────────────────────────────────────────

/**
 * A scenario as a plan item, plus the actors it needs.
 *
 * ── Why `principals` is beside the item and not on it ──────────────────────
 *
 * `PlanItem` in packages/shared/src/flow-map.ts has `authProfileId` and no
 * `principals` field, while the Prisma `PlanItem` model HAS a `principals` Json
 * column (added by the keystone). So the row can hold the actors and the TS
 * type cannot yet express them. Returning a pair rather than casting keeps the
 * gap visible: the exact one-line edit to flow-map.ts is in this slice's
 * handover, and until it lands a writer can still persist both halves without
 * anybody pretending the type says something it does not.
 */
export interface MultiActorPlanItem {
  readonly item: PlanItem;
  readonly principals: readonly Principal[];
}

/**
 * The test type a multi-actor scenario becomes.
 *
 * E2E, because the scenario drives a browser per actor and E2E is the only type
 * whose plugin opens one. Stated as a constant rather than inlined so that the
 * day a MULTI_ACTOR type is minted there is one line to change and one place to
 * read the current answer.
 */
export const MULTI_ACTOR_TEST_TYPE: TestType = 'E2E';

export function multiActorPlanItem(scenario: MultiActorScenario): MultiActorPlanItem {
  return {
    item: {
      id: scenario.id,
      title: scenario.title,
      rationale: `${PATTERN_DESCRIPTORS[scenario.pattern].rationale} Evidence: ${scenario.evidence}.`,
      feature: `Authorization — ${scenario.pattern}`,
      priority: scenario.priority,
      testType: MULTI_ACTOR_TEST_TYPE,
      steps: scenario.steps.map((step) => `[${step.actor}] ${step.description}`),
      assertions: [...scenario.assertions],
      journeyId: null,
      /*
       * NULL on purpose, and it is the most important null in this file. A
       * multi-actor scenario has no single identity, so naming one here would
       * be a claim that the test runs as that actor — which is exactly the
       * single-session assumption this module exists to escape. The actors are
       * in `principals`, and a consumer that reads only `authProfileId` sees
       * "anonymous", which is wrong in the SAFE direction: it under-claims
       * rather than binding the test to the wrong identity.
       */
      authProfileId: null,
    },
    principals: scenario.principals,
  };
}

// ─── G. The spec ─────────────────────────────────────────────────────────────

/**
 * Where one actor's storage state lives, relative to the test run's root.
 *
 * ── Why Playwright's own convention and not an environment variable ────────
 *
 * The generated spec is the CUSTOMER'S code: it lives in their repository, it
 * is reviewed by their engineers, and admission's NO_LOCK_IN gate fails any
 * file that cannot run with QAAI uninstalled. `playwright/.auth/<actor>.json`
 * is the path Playwright's own multi-role documentation uses, so a customer who
 * writes a setup project satisfies it with no QAAI in the loop, and the QAAI
 * harness satisfies it by writing the same filenames into the run workspace.
 * An env var would have put the string "QAAI" into the file as an identifier,
 * which NO_LOCK_IN reads — correctly — as a dependency.
 *
 * Exported because the harness has to write exactly these names; the handover
 * names the one-line change in playwright-harness.ts that does it.
 */
export function actorStateFile(actorName: string): string {
  const safe = actorName.replace(/[^A-Za-z0-9._-]/g, '_');
  return `playwright/.auth/${safe}.json`;
}

/** A legal, deterministic JS identifier for an actor. */
function identifier(actorName: string): string {
  const camel = actorName.replace(/[^A-Za-z0-9]+(.)?/g, (_, next: string | undefined) =>
    next === undefined ? '' : next.toUpperCase(),
  );
  const head = camel.replace(/^[^A-Za-z_]+/, '');
  return head === '' ? 'actor' : head;
}

function locatorCall(locator: ActorLocator): string {
  return `getByRole(${JSON.stringify(locator.role)}, { name: ${JSON.stringify(locator.name)} })`;
}

/**
 * Emit the spec. PURE, DETERMINISTIC, and MODEL-FREE.
 *
 * ── What the emitted file does that no generated test could before ─────────
 *
 * It opens ONE BROWSER CONTEXT PER PRINCIPAL. That is the whole feature: two
 * contexts means two cookie jars, which means two identities genuinely live at
 * the same moment, which is what makes "A is served and B is refused" a single
 * assertion instead of two runs that cannot be compared.
 *
 * ── Why it throws when a session file is missing ───────────────────────────
 *
 * Because the alternative is every actor sharing the run's one session and the
 * test passing. A privilege-divergence test in which both contexts are the
 * admin asserts that the admin is served the page and then that the admin is
 * refused it, which FAILS — so that case is loud. A handoff test in which both
 * contexts are the same identity PASSES, having proved nothing: the producer
 * creates the invitation and then sees it themselves. A loud failure naming the
 * missing actor is the only honest behaviour, and it is why the guard is in the
 * emitted code rather than in a comment asking the harness to be correct.
 *
 * The gates this output is written to clear, each deliberately:
 *   · ASSERTIONS — every scenario emits at least one `expect`.
 *   · LOCATORS   — role+name locators only; no CSS ever reaches this function,
 *                  because {@link ActorLocator} cannot carry one.
 *   · NO_FIXED_SLEEP — no `waitForTimeout`; Playwright's auto-waiting and
 *                  `expect` do the waiting.
 *   · NO_LOCK_IN — nothing from `@qaai/`, and no QAAI identifier.
 */
export function renderMultiActorSpec(scenario: MultiActorScenario): string {
  const names = [...new Set(scenario.principals.map((p) => p.name))];
  const lines: string[] = [];

  lines.push("import { expect, test } from '@playwright/test';");
  lines.push("import { existsSync } from 'node:fs';");
  lines.push('');
  lines.push('/*');
  lines.push(` * ${scenario.title}`);
  lines.push(' *');
  lines.push(` * Pattern: ${scenario.pattern}`);
  lines.push(` * Evidence: ${scenario.evidence}`);
  lines.push(' *');
  lines.push(' * This test acts as more than one identity at once, so it opens one browser');
  lines.push(' * context per actor. Each actor needs its own storage state at');
  lines.push(' * playwright/.auth/<actor>.json — write them from a setup project.');
  lines.push(' */');
  lines.push('');
  lines.push('const SESSIONS: Record<string, string> = {');
  for (const name of names) {
    lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(actorStateFile(name))},`);
  }
  lines.push('};');
  lines.push('');
  lines.push('function sessionFor(actor: string): string {');
  lines.push('  const file = SESSIONS[actor];');
  lines.push('  if (file === undefined || !existsSync(file)) {');
  /*
   * The message is long on purpose. It is the sentence somebody reads at the
   * point the multi-actor seam is not wired, and "storage state not found" sends
   * them looking for a Playwright bug.
   */
  lines.push('    throw new Error(');
  lines.push('      `No signed-in session for the actor "${actor}". This test needs one storage ` +');
  lines.push(
    '        `state per actor (${Object.keys(SESSIONS).join(", ")}); running every actor under ` +',
  );
  lines.push(
    '        \'one session would let this test pass while proving nothing about the second identity.\',',
  );
  lines.push('    );');
  lines.push('  }');
  lines.push('  return file;');
  lines.push('}');
  lines.push('');
  lines.push(`test(${JSON.stringify(scenario.title)}, async ({ browser }) => {`);
  for (const name of names) {
    lines.push(
      `  const ${identifier(name)}Context = await browser.newContext({ storageState: sessionFor(${JSON.stringify(name)}) });`,
    );
  }
  lines.push('  try {');
  for (const name of names) {
    lines.push(`    const ${identifier(name)} = await ${identifier(name)}Context.newPage();`);
  }
  /*
   * The index is threaded through so every `const` the emitter declares is
   * unique. Two VISIT steps in one test both wanted to be called `served`,
   * which redeclares a binding in one block — the generated file would not
   * compile, and admission's SYNTAX gate would refuse a test this module had
   * every other reason to be proud of.
   */
  scenario.steps.forEach((step, index) => {
    lines.push('');
    lines.push(`    // [${step.actor}] ${step.description}`);
    lines.push(...renderStep(step, index).map((line) => `    ${line}`));
  });
  lines.push('  } finally {');
  for (const name of names) {
    lines.push(`    await ${identifier(name)}Context.close();`);
  }
  lines.push('  }');
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

/**
 * One step, as code. Exhaustive over {@link MultiActorStepKind} by `switch`, so
 * a seventh kind cannot ship with no rendering — it fails `tsc` here.
 */
function renderStep(step: MultiActorStep, index: number): string[] {
  const page = identifier(step.actor);
  switch (step.kind) {
    case 'VISIT_EXPECT_SERVED':
      return [
        `const served${index} = await ${page}.goto(${JSON.stringify(step.route ?? '/')});`,
        `expect(served${index}?.status(), ${JSON.stringify(`${step.actor} receives a successful response for ${step.route ?? '/'}`)}).toBeLessThan(400);`,
      ];
    case 'VISIT_EXPECT_REFUSED':
      return [
        `const refused${index} = await ${page}.goto(${JSON.stringify(step.route ?? '/')});`,
        /*
         * `toBeGreaterThanOrEqual(400)` and NOT `not.toBe(200)`. A soft login
         * wall answers 200 and renders a sign-in form, so "not 200" would fail
         * on an application that is behaving correctly — and a 3xx to the login
         * page is a refusal, not a service. The status floor is the one
         * assertion that is true of every genuine refusal and false of every
         * genuine service.
         */
        `expect(refused${index}?.status(), ${JSON.stringify(`${step.actor} does not receive a successful response for ${step.route ?? '/'}, in the same test run`)}).toBeGreaterThanOrEqual(400);`,
      ];
    case 'ACTIVATE':
      return step.locator === null
        ? []
        : [`await ${page}.${locatorCall(step.locator)}.click();`];
    case 'FILL': {
      if (step.locator === null) return [];
      if (step.secretName !== null) {
        /*
         * The value is read from the child's own environment, which `childEnv`
         * already fills from `ctx.secrets`. The spec names the VAULT ENTRY and
         * never the value, so nothing secret is written into the customer's
         * repository — and a missing entry throws instead of typing the empty
         * string and reporting the signup as broken.
         */
        return [
          `const secret${index} = process.env[${JSON.stringify(step.secretName)}];`,
          `if (secret${index} === undefined || secret${index} === '') {`,
          `  throw new Error(${JSON.stringify(`the vault entry ${step.secretName} is not available to this run, so the signup cannot be completed`)});`,
          `}`,
          `await ${page}.${locatorCall(step.locator)}.fill(secret${index});`,
        ];
      }
      return [`await ${page}.${locatorCall(step.locator)}.fill(${JSON.stringify(step.text ?? '')});`];
    }
    case 'EXPECT_TEXT':
      return [
        `await expect(${page}.getByText(${JSON.stringify(step.text ?? '')})).toBeVisible();`,
      ];
    case 'EXPECT_NO_TEXT':
      return [
        `await expect(${page}.getByText(${JSON.stringify(step.text ?? '')})).toHaveCount(0);`,
      ];
  }
}
