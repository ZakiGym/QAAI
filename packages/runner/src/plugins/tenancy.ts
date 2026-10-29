/**
 * MULTI-TENANT ISOLATION — tenant A's token against tenant B's ids, over every
 * operation the enumeration found.
 *
 * ── Why this is the check that matters most in the whole product ────────────
 *
 * Cross-tenant leakage is the bug class that ends a company. One endpoint out
 * of four hundred that forgets its `WHERE orgId = ?` is a breach, a disclosure
 * notice and the end of every enterprise deal in the pipeline — and it is
 * invisible to every other kind of test, because the application works
 * perfectly for one tenant at a time. Nothing in this repository could ask the
 * question: there was ONE storage state per run
 * (`packages/runner/src/playwright-harness.ts`), so "tenant A's token" and
 * "tenant B's ids" could not both exist in one execution, and the nearest thing
 * available — the anonymous IDOR probe in `security-smoke.ts` — asks whether a
 * logged-out visitor is denied, which every application on earth gets right.
 *
 * This plugin sweeps the `ApiOperation` inventory. For each operation it
 * substitutes an identifier observed as belonging to tenant B, asks as a
 * principal in tenant A, and reports what came back — per operation, with every
 * absence named.
 *
 * ── BINDING SAFETY, AND IT IS THE REASON THIS CAN SHIP AT ALL ──────────────
 *
 *  1. READ-ONLY AND SAFE-VERB, ALWAYS. Only the verbs `SAFE_PROBE_METHODS`
 *     names — GET, HEAD, OPTIONS — are swept. A POST, PUT, PATCH or DELETE that
 *     would create, update or delete inside another tenant is REFUSED and
 *     RECORDED AS REFUSED. It is never performed because it would be more
 *     thorough. This does not widen when the environment's crawl policy sets
 *     `allowDestructive: true`: that flag authorises damaging the ENVIRONMENT'S
 *     own data, which is not the same permission as writing across a tenant
 *     boundary, and no field in the policy grants the second.
 *  2. A verb we could not READ is refused too. `ApiOperationMethod` has an
 *     `UNKNOWN` member precisely because a Next `route.ts` nobody could parse
 *     is definitely an endpoint with definitely-unreadable verbs, and treating
 *     UNKNOWN as GET would be a guess that might issue a write.
 *  3. ONE TENANT IS NOT A SWEEP. Where the two principals are in the same
 *     tenant, or either has none, the whole check is UNEXERCISABLE with a
 *     reason — never a pass, and never a zero. "0 cross-tenant leaks" over a
 *     sweep that compared a tenant against itself is the exact lie this file is
 *     built to make impossible.
 *  4. NO PRODUCTION. A cross-tenant probe aimed at production is aimed at real
 *     customers' records, and nothing in `CrawlPolicy` grants permission for
 *     it. So a PRODUCTION environment is UNEXERCISABLE with the remedy stated.
 *  5. NEITHER TENANT'S TOKEN IS EVER SEEN HERE. The prober is handed a
 *     principal NAME and resolves the session itself; the spec schema is
 *     `.strict()` and has no field a credential could occupy. Nothing is
 *     logged, echoed or returned.
 *
 * ── The verdict vocabulary is DELIBERATELY IDENTICAL to a sibling's ────────
 *
 * {@link ISOLATION_VERDICTS} has the same eight members, spelled the same way,
 * as `AUTHZ_VERDICTS` in `packages/agent/src/authz-probe.ts`, and
 * {@link classifyIsolation} implements the same rule — above all the rule that
 * a 401, or a control request that could not be confirmed, is INCONCLUSIVE and
 * NOT a pass.
 *
 * It is duplicated because `packages/runner` and `packages/agent` are siblings
 * whose only common ancestor is `@qaai/shared`, and this round does not own a
 * file there. Spelling the two identically rather than renaming is the point:
 * a drift between them is a one-line diff somebody can see, where a rename
 * would hide it. The consolidation — moving this table into
 * `packages/shared/src/principals.ts` and importing it in both — is named in
 * this slice's handover, and `tenancy.test.ts` pins the list by literal so that
 * a change on either side is visible from this one.
 */

import { z } from 'zod';
import { ENVIRONMENT_KINDS, matchesGlob, resolveCrawlPolicy } from '@qaai/shared';
import type {
  ConsoleEntry,
  ExecutableTest,
  Finding,
  RunContext,
  StepResult,
  TestExecution,
} from '@qaai/shared';
/*
 * `principals.ts` IS on the package barrel now, so this is the ordinary import
 * it should always have been. It was a relative path across the workspace
 * boundary for one round, under protest and with the one-line fix written down;
 * the line landed and the protest came with it, because a comment that still
 * claims a defect somebody closed teaches the next reader the wrong thing about
 * their own repository.
 *
 * What is worth keeping from that note: `isSafeProbeMethod` is ASKED and never
 * re-derived here. A second opinion about which verbs are safe is how a probe
 * that must not mutate customer data ends up mutating it.
 */
import { isSafeProbeMethod } from '@qaai/shared';
import type { SafeProbeMethod } from '@qaai/shared';

// ─── 1. The verdicts ─────────────────────────────────────────────────────────

/**
 * What one operation's probe established.
 *
 * Eight members in three regions, identical to `AUTHZ_VERDICTS` — see the file
 * header for why that duplication is deliberate and where the consolidation
 * goes.
 */
export const ISOLATION_VERDICTS = [
  /** 2xx AND tenant B's own evidence was in the body. A breach. */
  'LEAKED',
  /**
   * 2xx and the body was NOT verified, because no evidence string was observed
   * for that id. A finding, recorded separately: "the request succeeded" is a
   * weaker claim than "we saw the other tenant's data", and the report must not
   * make the stronger one on our behalf.
   */
  'LEAKED_UNVERIFIED',
  /** 2xx and the body provably lacked tenant B's data — correctly scoped. */
  'SERVED_BUT_SCOPED',
  /** 403, 404 or 410. The boundary held. */
  'DENIED',
  /** The holder's session was not established or not accepted. NOT A PASS. */
  'INCONCLUSIVE_SESSION',
  /** 5xx, 429, a 3xx, or nothing answered. Not an answer about isolation. */
  'INCONCLUSIVE_NO_ANSWER',
  /** Nobody asked. Carries a reason. */
  'NOT_PROBED',
  /** Not performed on purpose. Carries a reason. */
  'REFUSED',
] as const;
export type IsolationVerdict = (typeof ISOLATION_VERDICTS)[number];

/** Compile-time half of the parity guard; the run-time half is in the test. */
const ISOLATION_VERDICT_PRESENT: Record<IsolationVerdict, true> = {
  LEAKED: true,
  LEAKED_UNVERIFIED: true,
  SERVED_BUT_SCOPED: true,
  DENIED: true,
  INCONCLUSIVE_SESSION: true,
  INCONCLUSIVE_NO_ANSWER: true,
  NOT_PROBED: true,
  REFUSED: true,
};

/** Derived, never hand-listed. */
export const ISOLATION_VERDICT_LIST = Object.keys(
  ISOLATION_VERDICT_PRESENT,
) as ReadonlyArray<IsolationVerdict>;

/** Verdicts that are a finding about the application. */
export const ISOLATION_FINDINGS: ReadonlyArray<IsolationVerdict> = ['LEAKED', 'LEAKED_UNVERIFIED'];

/**
 * Verdicts that are evidence the tenant boundary HELD.
 *
 * Listed and not derived, because membership here is the most consequential
 * claim in the file. A verdict wrongly in this list is a pass that means "we
 * did not check", on the one axis where that costs a company.
 */
export const ISOLATION_PASSES: ReadonlyArray<IsolationVerdict> = ['DENIED', 'SERVED_BUT_SCOPED'];

/** Everything else. DERIVED BY EXCLUSION, so a ninth member defaults to safe. */
export const ISOLATION_INCONCLUSIVE: ReadonlyArray<IsolationVerdict> =
  ISOLATION_VERDICT_LIST.filter(
    (verdict) =>
      !(ISOLATION_FINDINGS as readonly string[]).includes(verdict) &&
      !(ISOLATION_PASSES as readonly string[]).includes(verdict),
  );

export const ISOLATION_VERDICT_LABELS: Record<IsolationVerdict, string> = {
  LEAKED: "served the other tenant's record, and their data was in the response",
  LEAKED_UNVERIFIED: "answered successfully for the other tenant's id; the body was not verified",
  SERVED_BUT_SCOPED: "answered without returning the other tenant's data",
  DENIED: "refused or hid the other tenant's record",
  INCONCLUSIVE_SESSION: 'the holder’s session was not established, so nothing was learned',
  INCONCLUSIVE_NO_ANSWER: 'nothing usable answered, so nothing was learned',
  NOT_PROBED: 'nobody asked',
  REFUSED: 'not performed, on purpose',
};

// ─── 2. Why an operation was not probed, or was refused ──────────────────────

/**
 * Why one operation was NOT_PROBED.
 *
 * Distinct from REFUSED throughout: NOT_PROBED means we had nothing to ask
 * with, and REFUSED means we had it and chose not to. They have different
 * remedies — the first is "observe an id for this parameter", the second is
 * "this verb is never swept" — and collapsing them loses the one that a
 * customer can act on.
 */
export const NOT_PROBED_REASONS = [
  /**
   * The operation's path carries no parameter to substitute an id into. A
   * collection endpoint can still leak across tenants through a query
   * parameter, so this is OUR gap and not a clean result.
   */
  'NO_PARAMETER_TO_SUBSTITUTE',
  /** The path has a parameter and nothing was observed as tenant B's for it. */
  'NO_SUBJECT_ID_FOR_PARAMETER',
  /** A crawl-policy glob excluded this path. We did not look, on purpose. */
  'EXCLUDED_BY_POLICY',
  /** The per-run probe budget was spent before this operation was reached. */
  'BUDGET_SPENT',
  /** The run was cancelled before this operation was reached. */
  'CANCELLED',
] as const;
export type TenancyNotProbedReason = (typeof NOT_PROBED_REASONS)[number];

/** Compile-time half of the parity guard. */
const NOT_PROBED_REASON_PRESENT: Record<TenancyNotProbedReason, true> = {
  NO_PARAMETER_TO_SUBSTITUTE: true,
  NO_SUBJECT_ID_FOR_PARAMETER: true,
  EXCLUDED_BY_POLICY: true,
  BUDGET_SPENT: true,
  CANCELLED: true,
};

/** Derived, never hand-listed. */
export const NOT_PROBED_REASON_LIST = Object.keys(
  NOT_PROBED_REASON_PRESENT,
) as ReadonlyArray<TenancyNotProbedReason>;

export const NOT_PROBED_REASON_DETAIL: Record<TenancyNotProbedReason, string> = {
  NO_PARAMETER_TO_SUBSTITUTE:
    'this operation’s path has no parameter to put the other tenant’s identifier into. A ' +
    'collection endpoint can still leak across tenants through a query parameter, so this is a ' +
    'gap in what QAAI observed rather than a clean result',
  NO_SUBJECT_ID_FOR_PARAMETER:
    'nothing was observed as belonging to the other tenant for this operation’s parameter, so ' +
    'there was no identifier to ask for — crawl as the second tenant to harvest some',
  EXCLUDED_BY_POLICY:
    'a crawl-policy glob excludes this path, so it was never requested. That is a scope decision ' +
    'the customer made and can change, not a measurement',
  BUDGET_SPENT:
    'the probe budget was spent before this operation was reached — at least this many more ' +
    'operations remain unchecked',
  CANCELLED: 'the run was cancelled before this operation was reached',
};

/** Why one operation was REFUSED. Each is a deliberate non-performance. */
export const TENANCY_REFUSAL_REASONS = [
  /**
   * The verb could create, update or delete inside the other tenant. Never
   * performed, whatever the policy says about destruction — see safety rule 1
   * in the file header.
   */
  'UNSAFE_VERB',
  /**
   * The verb could not be read from the source or document at all
   * (`ApiOperationMethod` 'UNKNOWN'). Treating it as GET would be a guess that
   * might issue a write into another tenant.
   */
  'UNREADABLE_VERB',
] as const;
export type TenancyRefusalReason = (typeof TENANCY_REFUSAL_REASONS)[number];

/** Compile-time half of the parity guard. */
const TENANCY_REFUSAL_PRESENT: Record<TenancyRefusalReason, true> = {
  UNSAFE_VERB: true,
  UNREADABLE_VERB: true,
};

/** Derived, never hand-listed. */
export const TENANCY_REFUSAL_REASON_LIST = Object.keys(
  TENANCY_REFUSAL_PRESENT,
) as ReadonlyArray<TenancyRefusalReason>;

export const TENANCY_REFUSAL_DETAIL: Record<TenancyRefusalReason, string> = {
  UNSAFE_VERB:
    'this verb could create, update or delete inside the other tenant, so the probe was NOT ' +
    'performed. A cross-tenant sweep is read-only: being more thorough here would mean writing to ' +
    'another tenant’s data, and no report format makes that acceptable',
  UNREADABLE_VERB:
    'the verb for this operation could not be read from the source or its document, so it is ' +
    'unknown whether a request would read or write. It was not performed: assuming GET is a guess ' +
    'that could issue a write into another tenant',
};

/**
 * Why the WHOLE check could not run. Not a failure and not a pass — an absence
 * with a reason, which the report prints in place of a number.
 */
export const UNEXERCISABLE_REASONS = [
  /** Both principals are in the same tenant, so the comparison is vacuous. */
  'SINGLE_TENANT',
  /** One or both principals have no tenant, so there is no boundary to cross. */
  'NO_TENANCY',
  /** The holder has no session, so a refusal would prove nothing. */
  'NO_HOLDER_SESSION',
  /** A cross-tenant probe aimed at production is aimed at real customers' records. */
  'PRODUCTION_NOT_PERMITTED',
  /** The inventory is empty, so there was nothing to sweep. */
  'NO_OPERATIONS',
  /** No prober is configured for this environment, so nothing was requested. */
  'NO_PROBER',
] as const;
export type UnexercisableReason = (typeof UNEXERCISABLE_REASONS)[number];

/** Compile-time half of the parity guard. */
const UNEXERCISABLE_REASON_PRESENT: Record<UnexercisableReason, true> = {
  SINGLE_TENANT: true,
  NO_TENANCY: true,
  NO_HOLDER_SESSION: true,
  PRODUCTION_NOT_PERMITTED: true,
  NO_OPERATIONS: true,
  NO_PROBER: true,
};

/** Derived, never hand-listed. */
export const UNEXERCISABLE_REASON_LIST = Object.keys(
  UNEXERCISABLE_REASON_PRESENT,
) as ReadonlyArray<UnexercisableReason>;

export const UNEXERCISABLE_DETAIL: Record<UnexercisableReason, string> = {
  SINGLE_TENANT:
    'both principals are in the same tenant, so a successful read proves nothing about ' +
    'cross-tenant access. Seed a second tenant with its own records and this sweep becomes the ' +
    'most valuable check in the suite',
  NO_TENANCY:
    'at least one principal has no tenant, so there is no boundary to cross. If this application ' +
    'is multi-tenant, configure the tenant each auth profile belongs to',
  NO_HOLDER_SESSION:
    'the asking principal holds no session, so every refusal would be indistinguishable from ' +
    'being signed out and the sweep would report a boundary that was never tested',
  PRODUCTION_NOT_PERMITTED:
    'this is a PRODUCTION environment. A cross-tenant probe aimed at production is aimed at real ' +
    'customers’ records, and nothing in the environment’s crawl policy grants permission for it. ' +
    'Run this sweep against a staging environment holding two seeded tenants',
  NO_OPERATIONS:
    'the API operation inventory for this project is empty, so there was nothing to sweep. Import ' +
    'an OpenAPI document or run source enumeration first',
  NO_PROBER:
    'no HTTP prober is configured for this environment, so no request was made. Nothing was ' +
    'measured — this is not a clean result',
};

// ─── 3. The spec ─────────────────────────────────────────────────────────────

/**
 * One principal and the tenant it belongs to.
 *
 * `.strict()`, and NOTE WHAT HAS NO FIELD HERE: no password, no token, no
 * cookie, no storage state. A principal is named, and the PROBER resolves the
 * session from the name. That is the structural half of safety rule 5 — the
 * spec is incapable of holding a credential, so a client that sends one is
 * refused rather than having it quietly dropped on the way through our logs.
 */
const tenantPrincipalSchema = z
  .object({
    /** The principal's name, as `RunContext.sessions` keys it. */
    principal: z.string().min(1).max(120),
    /** The application's own id for this principal's tenant. */
    tenantId: z.string().min(1).max(200).nullable(),
    /** What a human calls it. Shown; never compared. */
    tenantLabel: z.string().min(1).max(200).nullable().default(null),
  })
  .strict();

/** One operation out of the enumerated inventory. */
const tenancyOperationSchema = z
  .object({
    /** As `ApiOperationMethod` spells it, 'UNKNOWN' included. */
    method: z.string().min(1).max(20),
    pathTemplate: z.string().min(1).max(2_000).regex(/^\//, 'a path template must start with "/"'),
    /** The document's own operationId, or null. For the report. */
    operationId: z.string().min(1).max(300).nullable().default(null),
  })
  .strict();

/** One identifier observed as belonging to the SUBJECT tenant. */
const subjectIdSchema = z
  .object({
    /** The path-parameter name this id fits: `id`, `invoiceId`, `orgId`. */
    parameter: z.string().min(1).max(200),
    value: z.string().min(1).max(500),
    /** Where it was seen while acting as the subject principal. */
    observedIn: z.string().min(1).max(2_000),
    /**
     * A string that appears in the SUBJECT tenant's rendering of this record
     * and would not appear in an empty or scoped response.
     *
     * Null means nobody supplied one, and null is handled honestly: a 2xx with
     * nothing to check is LEAKED_UNVERIFIED, never LEAKED and never a pass.
     */
    evidence: z.string().min(1).max(500).nullable().default(null),
  })
  .strict();

export const tenancySweepSpecSchema = z
  .object({
    holder: tenantPrincipalSchema,
    subject: tenantPrincipalSchema,
    operations: z.array(tenancyOperationSchema).max(5_000),
    subjectIds: z.array(subjectIdSchema).max(5_000).default([]),
    /**
     * An identifier the HOLDER owns, used for the control request.
     *
     * Required for any verdict to mean anything — see {@link controlStateFrom}.
     * Null is accepted and produces NOT_ATTEMPTED, which makes every verdict
     * inconclusive; refusing it at the schema would turn a degraded check into
     * a missing one, and a missing check is the thing nobody notices.
     */
    controlId: subjectIdSchema.nullable().default(null),
    environmentKind: z.enum(ENVIRONMENT_KINDS),
    /** `Environment.crawlPolicy` as stored. Resolved with the build's defaults. */
    crawlPolicy: z.unknown().nullable().default(null),
    /** Caps the operations probed. Disclosed as a count and a reason when it bites. */
    limit: z.number().int().min(1).max(5_000).nullable().default(null),
  })
  .strict();
export type TenancySweepSpec = z.infer<typeof tenancySweepSpecSchema>;

// ─── 4. The prober ───────────────────────────────────────────────────────────

/** What one probe saw. Every field that could be a guess is nullable. */
export interface TenancyObservation {
  /** The HTTP status, or null when nothing answered. Never 0. */
  readonly status: number | null;
  /**
   * Whether the subject tenant's evidence was in the body.
   *
   * NULL MEANS NOT DETERMINED — no evidence string was observed, or the body
   * could not be read. It does not mean absent. A null read as `false` turns a
   * breach into SERVED_BUT_SCOPED, which is a finding deleted by a default.
   */
  readonly evidenceFound: boolean | null;
}

/**
 * The one piece of I/O, as a narrow injected interface.
 *
 * NOT a playwright `Page` and NOT a top-level `fetch`. `asPrincipal` is a NAME;
 * the adapter resolves the session. That is what keeps every decision in this
 * file testable from a literal table with no socket — and it means the only
 * code that touches a credential is an adapter with no decisions in it.
 */
export interface TenancyProber {
  probe(request: {
    readonly asPrincipal: string;
    readonly method: SafeProbeMethod;
    readonly path: string;
    /** The string to look for in the body, or null when none was observed. */
    readonly lookFor: string | null;
  }): Promise<TenancyObservation>;
}

/**
 * The prober used when nothing configured one.
 *
 * NOT BUILT, AND REPORTED AS NOT BUILT. Reaching a customer's API means their
 * allow-list, their proxy and two of their sessions, none of which is a
 * `process.env` entry. A stub returning `{ status: 403 }` would declare every
 * tenant boundary in the product sound on the strength of a fake, which is
 * worse than having no plugin: it would move the one number that must never be
 * wrong in the optimistic direction.
 */
export const unavailableTenancyProber: TenancyProber = {
  probe() {
    return Promise.resolve({
      status: null,
      evidenceFound: null,
    });
  },
};

export interface TenancyDeps {
  prober: TenancyProber;
  /** True when a real prober is installed. Separates "refused" from "not built". */
  proberConfigured: boolean;
}

let deps: TenancyDeps = { prober: unavailableTenancyProber, proberConfigured: false };

/** Install the prober. Returns the previous set, so a test restores it. */
export function setTenancyDeps(next: TenancyDeps): TenancyDeps {
  const previous = deps;
  deps = next;
  return previous;
}

// ─── 5. Classification ──────────────────────────────────────────────────────

/**
 * Whether the holder's session is actually working.
 *
 * Same three states as `CONTROL_STATES` in the agent's `authz-probe.ts`, and
 * the same reason: rejecting 401s is not enough on its own, because a dead
 * session produces a 403 just as easily — an application that resolves no user
 * and then checks ownership answers "forbidden" — and that would be scored as a
 * clean pass on every operation in the sweep. So the holder reads its OWN
 * record first, and only a 2xx on that makes any later refusal meaningful.
 */
export const CONTROL_STATES = ['CONFIRMED_LIVE', 'REFUTED', 'NOT_ATTEMPTED'] as const;
export type ControlState = (typeof CONTROL_STATES)[number];

export const CONTROL_STATE_DETAIL: Record<ControlState, string> = {
  CONFIRMED_LIVE:
    'the holder read its own record, so its session is live and its credential is being accepted ' +
    '— a refusal on the other tenant’s record is therefore evidence about isolation',
  REFUTED:
    'the holder could NOT read its own record, so its session is not being accepted. Every ' +
    'refusal in this sweep is indistinguishable from being signed out and NONE of them is ' +
    'evidence that tenant isolation works. Re-establish the session and sweep again',
  NOT_ATTEMPTED:
    'no record belonging to the holder was supplied, so there was no way to prove the holder’s ' +
    'session works. The sweep ran and its refusals prove nothing — supply one id the holder owns ' +
    'and every verdict becomes meaningful',
};

/** A 2xx is the ONLY confirmation; a 3xx to a login page is an expired session. */
export function controlStateFrom(observation: TenancyObservation | null): {
  readonly state: ControlState;
  readonly status: number | null;
  readonly detail: string;
} {
  if (observation === null) {
    return { state: 'NOT_ATTEMPTED', status: null, detail: CONTROL_STATE_DETAIL.NOT_ATTEMPTED };
  }
  const live =
    observation.status !== null && observation.status >= 200 && observation.status < 300;
  const state: ControlState = live ? 'CONFIRMED_LIVE' : 'REFUTED';
  return {
    state,
    status: observation.status,
    detail:
      state === 'CONFIRMED_LIVE'
        ? CONTROL_STATE_DETAIL.CONFIRMED_LIVE
        : `${CONTROL_STATE_DETAIL.REFUTED} (the control request answered ${observation.status === null ? 'nothing' : String(observation.status)})`,
  };
}

/**
 * The one derivation from an observation to a verdict.
 *
 * THE CONTROL IS CHECKED FIRST, before the status is looked at. Moving that
 * branch below "403 means denied" is the single change that would turn this
 * sweep back into the thing it replaced: forty operations, every one refusing
 * an unaccepted session, rendering as "no cross-tenant leakage found".
 *
 * Identical in behaviour to `classifyAuthzOutcome` in the agent's
 * `authz-probe.ts`. See the file header for why there are two of it and where
 * the one is going.
 */
export function classifyIsolation(input: {
  readonly control: ControlState;
  readonly observation: TenancyObservation;
}): IsolationVerdict {
  if (input.control !== 'CONFIRMED_LIVE') return 'INCONCLUSIVE_SESSION';

  const { status, evidenceFound } = input.observation;
  if (status === null) return 'INCONCLUSIVE_NO_ANSWER';
  if (status === 401) return 'INCONCLUSIVE_SESSION';
  if (status === 403 || status === 404 || status === 410) return 'DENIED';
  if (status >= 200 && status < 300) {
    if (evidenceFound === true) return 'LEAKED';
    if (evidenceFound === false) return 'SERVED_BUT_SCOPED';
    return 'LEAKED_UNVERIFIED';
  }
  // A 3xx lands here on purpose: a redirect to a login page and a redirect to a
  // tenant's own dashboard are indistinguishable from outside without following
  // it, and a followed redirect renders a page that looks like success.
  return 'INCONCLUSIVE_NO_ANSWER';
}

// ─── 6. Path substitution ────────────────────────────────────────────────────

/**
 * Put one id into one operation's path, or report that there is nowhere to put
 * it.
 *
 * Both dialects, because the inventory holds both: an OpenAPI document writes
 * `/invoices/{invoiceId}` and a source detector reading an Express or Next
 * route writes `/invoices/:invoiceId`. A substituter that knew only one would
 * silently report every operation from the other source as
 * NO_PARAMETER_TO_SUBSTITUTE — a whole source's worth of unchecked endpoints
 * rendering as a gap in the customer's crawl rather than a gap in our parser.
 *
 * The value is URL-encoded, so an id containing `../` cannot change which
 * endpoint is asked for.
 */
export function substituteId(
  pathTemplate: string,
  parameter: string,
  value: string,
): string | null {
  const encoded = encodeURIComponent(value);
  const braced = `{${parameter}}`;
  if (pathTemplate.includes(braced)) return pathTemplate.split(braced).join(encoded);

  const colon = new RegExp(`:${parameter}(?![A-Za-z0-9_])`);
  if (colon.test(pathTemplate)) return pathTemplate.replace(colon, encoded);

  return null;
}

/** Does this template carry ANY parameter, whichever dialect it is written in? */
export function hasAnyParameter(pathTemplate: string): boolean {
  return /\{[^}]+\}|:[A-Za-z0-9_]+/.test(pathTemplate);
}

// ─── 7. The measurement ──────────────────────────────────────────────────────

/** One operation's row in the report. */
export interface OperationResult {
  readonly method: string;
  readonly pathTemplate: string;
  readonly operationId: string | null;
  readonly verdict: IsolationVerdict;
  /** The status, or null when nothing was asked or nothing answered. */
  readonly status: number | null;
  /**
   * Why, in one sentence. Always written. For NOT_PROBED and REFUSED this is
   * the reason's own sentence, so a reader never sees a bare verdict.
   */
  readonly detail: string;
  /** Set exactly when the verdict is NOT_PROBED. */
  readonly notProbedReason: TenancyNotProbedReason | null;
  /** Set exactly when the verdict is REFUSED. */
  readonly refusalReason: TenancyRefusalReason | null;
}

export interface TenancyMeasurement {
  /** Non-null when the whole check could not run. Then `operations` is empty. */
  readonly unexercisable: {
    readonly reason: UnexercisableReason;
    readonly detail: string;
  } | null;
  readonly control: ReturnType<typeof controlStateFrom> | null;
  readonly operations: readonly OperationResult[];
  /** One count per verdict. Every verdict present, zeros included. */
  readonly counts: Readonly<Record<IsolationVerdict, number>>;
  /**
   * Operations whose verdict is evidence about isolation — a finding or a pass.
   * This, and never `operations.length`, is the denominator for a percentage.
   */
  readonly measured: number;
  /** How many operations the inventory offered, before any cap. */
  readonly considered: number;
  /** Suppressed by the limit. Zero when no cap bit. */
  readonly omittedByCap: number;
  /** Non-null EXACTLY when `omittedByCap > 0`. */
  readonly capReason: string | null;
  /** Crawl-policy fields the environment actually chose, for the disclosure line. */
  readonly policyOverrides: readonly string[];
}

const EMPTY_COUNTS = (): Record<IsolationVerdict, number> => {
  const counts = {} as Record<IsolationVerdict, number>;
  for (const verdict of ISOLATION_VERDICT_LIST) counts[verdict] = 0;
  return counts;
};

function unexercisable(reason: UnexercisableReason): TenancyMeasurement {
  return {
    unexercisable: { reason, detail: UNEXERCISABLE_DETAIL[reason] },
    control: null,
    operations: [],
    counts: EMPTY_COUNTS(),
    // ZERO MEASURED, and no pass anywhere. An unexercisable check is an absence
    // with a reason, and the one thing it must never look like is a clean
    // sweep.
    measured: 0,
    considered: 0,
    omittedByCap: 0,
    capReason: null,
    policyOverrides: [],
  };
}

/**
 * Sweep the inventory.
 *
 * ── The admission order, and why each gate is before the next ─────────────
 *
 *  1. No prober → nothing was requested. Reported before anything else,
 *     because every other verdict would be a fact about a fake.
 *  2. PRODUCTION → refused outright. Before the tenancy checks, so that a
 *     production environment is never even described in terms of which tenants
 *     it has.
 *  3. Tenancy → same tenant or no tenant is a vacuous comparison.
 *  4. Empty inventory → nothing to sweep.
 *
 * Then the control request, then the operations. The sweep RUNS even when the
 * control is refuted, marking every verdict INCONCLUSIVE_SESSION, for the
 * reason given on `runAuthzSweep`: an empty report reads as "nothing to see",
 * and forty rows each naming the broken session is a sentence with a fix in it.
 */
export async function measureTenancy(
  spec: TenancySweepSpec,
  options: {
    readonly prober: TenancyProber;
    readonly proberConfigured: boolean;
    readonly holderHasSession: boolean;
    readonly cancelled?: () => boolean;
  },
): Promise<TenancyMeasurement> {
  if (!options.proberConfigured) return unexercisable('NO_PROBER');
  if (spec.environmentKind === 'PRODUCTION') return unexercisable('PRODUCTION_NOT_PERMITTED');
  if (spec.holder.tenantId === null || spec.subject.tenantId === null) {
    return unexercisable('NO_TENANCY');
  }
  if (spec.holder.tenantId === spec.subject.tenantId) return unexercisable('SINGLE_TENANT');
  if (!options.holderHasSession) return unexercisable('NO_HOLDER_SESSION');
  if (spec.operations.length === 0) return unexercisable('NO_OPERATIONS');

  const applied = resolveCrawlPolicy(spec.crawlPolicy);
  const policy = applied.policy;

  const control =
    spec.controlId === null
      ? controlStateFrom(null)
      : await (async () => {
          /*
           * The control uses the FIRST operation whose path the holder's own id
           * fits. Not an arbitrary path: the control has to exercise the same
           * authorization code the sweep will, or a 200 on `/health` would
           * "confirm" a session that cannot read a single record.
           */
          const target = spec.operations
            .map((operation) =>
              isSafeProbeMethod(operation.method)
                ? substituteId(operation.pathTemplate, spec.controlId!.parameter, spec.controlId!.value)
                : null,
            )
            .find((path): path is string => path !== null);
          if (target === undefined) return controlStateFrom(null);
          const observation = await options.prober.probe({
            asPrincipal: spec.holder.principal,
            method: 'GET',
            path: target,
            lookFor: spec.controlId!.evidence,
          });
          return controlStateFrom(observation);
        })();

  const counts = EMPTY_COUNTS();
  const operations: OperationResult[] = [];
  const limit = spec.limit ?? spec.operations.length;
  let probesSpent = 0;
  let cancelled = false;

  const idsByParameter = new Map<string, TenancySweepSpec['subjectIds'][number]>();
  for (const id of spec.subjectIds) {
    if (!idsByParameter.has(id.parameter)) idsByParameter.set(id.parameter, id);
  }

  const record = (
    operation: TenancySweepSpec['operations'][number],
    verdict: IsolationVerdict,
    status: number | null,
    detail: string,
    reasons: {
      notProbedReason?: TenancyNotProbedReason;
      refusalReason?: TenancyRefusalReason;
    } = {},
  ): void => {
    counts[verdict] += 1;
    operations.push({
      method: operation.method,
      pathTemplate: operation.pathTemplate,
      operationId: operation.operationId,
      verdict,
      status,
      detail,
      notProbedReason: reasons.notProbedReason ?? null,
      refusalReason: reasons.refusalReason ?? null,
    });
  };

  for (const operation of spec.operations) {
    if (cancelled || options.cancelled?.() === true) {
      cancelled = true;
      record(operation, 'NOT_PROBED', null, NOT_PROBED_REASON_DETAIL.CANCELLED, {
        notProbedReason: 'CANCELLED',
      });
      continue;
    }

    if (operation.method.toUpperCase() === 'UNKNOWN') {
      record(operation, 'REFUSED', null, TENANCY_REFUSAL_DETAIL.UNREADABLE_VERB, {
        refusalReason: 'UNREADABLE_VERB',
      });
      continue;
    }
    if (!isSafeProbeMethod(operation.method)) {
      record(operation, 'REFUSED', null, TENANCY_REFUSAL_DETAIL.UNSAFE_VERB, {
        refusalReason: 'UNSAFE_VERB',
      });
      continue;
    }

    /*
     * The policy's own globs, applied with the policy's own dialect
     * (`matchesGlob`), so the panel's preview and this sweep cannot disagree
     * about what is in scope. An `includeGlobs` list that is empty means
     * EVERYTHING, which is what `DEFAULT_CRAWL_POLICY` documents.
     */
    const included =
      policy.includeGlobs.length === 0 ||
      policy.includeGlobs.some((glob) => matchesGlob(glob, operation.pathTemplate));
    const excluded = policy.excludeGlobs.some((glob) =>
      matchesGlob(glob, operation.pathTemplate),
    );
    if (!included || excluded) {
      record(operation, 'NOT_PROBED', null, NOT_PROBED_REASON_DETAIL.EXCLUDED_BY_POLICY, {
        notProbedReason: 'EXCLUDED_BY_POLICY',
      });
      continue;
    }

    if (!hasAnyParameter(operation.pathTemplate)) {
      record(
        operation,
        'NOT_PROBED',
        null,
        NOT_PROBED_REASON_DETAIL.NO_PARAMETER_TO_SUBSTITUTE,
        { notProbedReason: 'NO_PARAMETER_TO_SUBSTITUTE' },
      );
      continue;
    }

    const match = [...idsByParameter.values()]
      .map((id) => ({ id, path: substituteId(operation.pathTemplate, id.parameter, id.value) }))
      .find((candidate): candidate is { id: typeof candidate.id; path: string } =>
        candidate.path !== null,
      );
    if (match === undefined) {
      record(
        operation,
        'NOT_PROBED',
        null,
        NOT_PROBED_REASON_DETAIL.NO_SUBJECT_ID_FOR_PARAMETER,
        { notProbedReason: 'NO_SUBJECT_ID_FOR_PARAMETER' },
      );
      continue;
    }

    if (probesSpent >= limit) {
      record(operation, 'NOT_PROBED', null, NOT_PROBED_REASON_DETAIL.BUDGET_SPENT, {
        notProbedReason: 'BUDGET_SPENT',
      });
      continue;
    }

    probesSpent += 1;
    const observation = await options.prober.probe({
      asPrincipal: spec.holder.principal,
      method: operation.method.toUpperCase() as SafeProbeMethod,
      path: match.path,
      lookFor: match.id.evidence,
    });
    const verdict = classifyIsolation({ control: control.state, observation });
    const where = `${operation.method} ${match.path}, asked as ${spec.holder.principal} (tenant ${describeTenant(spec.holder)}) for a record in tenant ${describeTenant(spec.subject)}`;
    const detail =
      verdict === 'INCONCLUSIVE_SESSION' && control.state !== 'CONFIRMED_LIVE'
        ? `${where}: ${control.detail}`
        : `${where}: ${observation.status === null ? 'nothing answered' : `answered ${observation.status}`} — ${ISOLATION_VERDICT_LABELS[verdict]}`;
    record(operation, verdict, observation.status, detail);
  }

  /*
   * Counted from the ROWS and not from a separate tally, so the disclosed
   * number and the rows a reader can click cannot disagree. Only BUDGET_SPENT
   * counts: an operation with no identifier to ask for was not suppressed by
   * the cap, and folding it in here would blame our limit for a gap in the
   * crawl.
   */
  const omittedByCap = operations.filter(
    (row) => row.notProbedReason === 'BUDGET_SPENT',
  ).length;

  return {
    unexercisable: null,
    control,
    operations,
    counts,
    measured: operations.filter(
      (row) =>
        (ISOLATION_FINDINGS as readonly string[]).includes(row.verdict) ||
        (ISOLATION_PASSES as readonly string[]).includes(row.verdict),
    ).length,
    considered: spec.operations.length,
    omittedByCap,
    capReason:
      omittedByCap === 0
        ? null
        : `a limit of ${limit} probes was applied, so ${omittedByCap} operation(s) with an ` +
          'identifier to ask for were not probed — at least that many more cross-tenant reads ' +
          'exist to check',
    policyOverrides: applied.overridden.map(String),
  };
}

/** Tenant naming for the report: the label where there is one, never the token. */
function describeTenant(side: TenancySweepSpec['holder']): string {
  return side.tenantLabel ?? side.tenantId ?? 'unknown';
}

// ─── 8. Findings and the honest summary ──────────────────────────────────────

/**
 * The findings, and NOTHING when the control was not live.
 *
 * A 2xx under a session we could not establish is a 2xx we cannot attribute,
 * and filing it as cross-tenant leakage would be a CRITICAL security finding
 * manufactured out of a broken login — on the one axis where a false positive
 * costs a customer's trust in the whole product.
 */
export function tenancyFindings(measurement: TenancyMeasurement): Finding[] {
  if (measurement.control?.state !== 'CONFIRMED_LIVE') return [];
  return measurement.operations
    .filter((row) => (ISOLATION_FINDINGS as readonly string[]).includes(row.verdict))
    .map((row) => ({
      kind: 'SECURITY' as const,
      severity: row.verdict === 'LEAKED' ? ('CRITICAL' as const) : ('SERIOUS' as const),
      code: row.verdict === 'LEAKED' ? 'cross-tenant-read' : 'cross-tenant-read-unverified',
      message: row.detail,
      location: row.pathTemplate,
      helpUrl: null,
    }));
}

/**
 * The sentence the report prints.
 *
 * A function rather than a template in a UI, because the one thing it must
 * never say is "tenant isolation verified" when nothing was measured — and that
 * judgement belongs beside the verdicts rather than in a screen.
 */
export function summariseTenancy(measurement: TenancyMeasurement): string {
  if (measurement.unexercisable !== null) {
    return `Tenant isolation was NOT measured: ${measurement.unexercisable.detail}.`;
  }
  if (measurement.control?.state !== 'CONFIRMED_LIVE') {
    return (
      `Tenant isolation was NOT measured: ${measurement.control?.detail ?? 'no control request was made'}. ` +
      `${measurement.operations.length} operation(s) were swept and every verdict is inconclusive.`
    );
  }

  const leaked = measurement.counts.LEAKED + measurement.counts.LEAKED_UNVERIFIED;
  const held = measurement.measured - leaked;
  const notProbed = measurement.counts.NOT_PROBED;
  const refused = measurement.counts.REFUSED;
  const parts = [
    `${measurement.measured} of ${measurement.considered} operation(s) measured`,
    leaked > 0 ? `${leaked} cross-tenant read(s) SUCCEEDED` : `${held} boundary(ies) held`,
  ];
  if (notProbed > 0) parts.push(`${notProbed} not probed`);
  if (refused > 0) parts.push(`${refused} refused as unsafe to probe`);
  const cap = measurement.capReason === null ? '' : ` ${measurement.capReason}.`;
  return `${parts.join(', ')}.${cap}`;
}

// ─── 9. The plugin ───────────────────────────────────────────────────────────

/**
 * Whether this run holds a session for a named principal.
 *
 * Reads `RunContext.sessions` through the shape `runSessions` normalises, and
 * falls back to the legacy single `storageState` for the default principal. A
 * null storage state is the ANONYMOUS session and is NOT a usable holder
 * session: a sweep whose holder is anonymous would measure anonymous denial,
 * which is the check this plugin replaces.
 */
export function holderHasSession(ctx: RunContext, principalName: string): boolean {
  const sessions = ctx.sessions ?? {};
  const named = sessions[principalName];
  if (named !== undefined) return named.storageState !== null;
  return principalName === 'default' && ctx.storageState !== null;
}

function parseSpec(test: ExecutableTest): TenancySweepSpec {
  const parsed = tenancySweepSpecSchema.safeParse(test.spec);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Tenancy test "${test.name}" has an invalid spec — ${issues}`);
  }
  return parsed.data;
}

/**
 * Run one tenancy test.
 *
 * ── Why an UNEXERCISABLE check is SKIPPED and not PASSED ───────────────────
 *
 * Because `notRun` is the field that exists for exactly this: a plugin that
 * knows WHY nothing was measured saying so in a machine-readable way, so the
 * coverage denominator can exclude it rather than scoring it. A PASSED result
 * with a note in the error message would be counted as a tested boundary by
 * every aggregation in the product, which on this axis is the difference
 * between "we verified your tenancy" and "nothing ran".
 */
export async function runTenancyTest(
  ctx: RunContext,
  test: ExecutableTest,
  spec: TenancySweepSpec,
  dependencies: TenancyDeps,
): Promise<TestExecution> {
  const startedAt = Date.now();
  const measurement = await measureTenancy(spec, {
    prober: dependencies.prober,
    proberConfigured: dependencies.proberConfigured,
    holderHasSession: holderHasSession(ctx, spec.holder.principal),
    cancelled: () => ctx.signal.aborted,
  });

  const steps: StepResult[] = [];
  const notes: ConsoleEntry[] = [];
  /*
   * durationMs is 0 on every step: these are REPORT ROWS over one measurement,
   * not timed operations. A per-row duration would be a number nothing
   * measured, and this product does not ship those.
   */
  const record = (title: string, status: StepResult['status'], detail: string | null): void => {
    const index = steps.length;
    ctx.logger.step({ testId: test.id, index, title, status });
    steps.push({
      index,
      title: detail === null ? title : `${title} — ${detail}`,
      status,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: 0,
      screenshotKey: null,
      error:
        status === 'FAILED'
          ? { message: detail ?? title, stack: null, selector: null, expected: null, actual: null }
          : null,
    });
  };

  if (measurement.unexercisable !== null) {
    const why = summariseTenancy(measurement);
    record('Tenant isolation sweep', 'SKIPPED', measurement.unexercisable.detail);
    return {
      testId: test.id,
      status: 'SKIPPED',
      durationMs: Date.now() - startedAt,
      steps,
      network: [],
      console: notes,
      videoKey: null,
      traceKey: null,
      errorMessage: why,
      retriedAndPassed: false,
      notRun: {
        // BLOCKED_BY_ENV for everything except an empty inventory, which is a
        // missing input rather than a broken environment. The two have
        // different remedies and both are excluded from the pass rate.
        kind: measurement.unexercisable.reason === 'NO_OPERATIONS' ? 'NOT_RUN' : 'BLOCKED_BY_ENV',
        why,
      },
      findings: [],
    };
  }

  for (const row of measurement.operations) {
    const status: StepResult['status'] = (
      ISOLATION_FINDINGS as readonly string[]
    ).includes(row.verdict)
      ? 'FAILED'
      : (ISOLATION_PASSES as readonly string[]).includes(row.verdict)
        ? 'PASSED'
        : 'SKIPPED';
    record(`${row.method} ${row.pathTemplate}`, status, row.detail);
  }

  const findings = tenancyFindings(measurement);
  const summary = summariseTenancy(measurement);
  notes.push({ level: 'info', text: summary, at: new Date(startedAt).toISOString() });

  /*
   * A sweep that measured NOTHING is SKIPPED, not PASSED, even though no
   * operation failed. Every operation inconclusive because the holder's session
   * was refused is the failure mode this whole file is shaped around, and
   * reporting it as a pass is precisely the lie the shape exists to prevent.
   */
  if (measurement.measured === 0) {
    return {
      testId: test.id,
      status: 'SKIPPED',
      durationMs: Date.now() - startedAt,
      steps,
      network: [],
      console: notes,
      videoKey: null,
      traceKey: null,
      errorMessage: summary,
      retriedAndPassed: false,
      notRun: { kind: 'BLOCKED_BY_ENV', why: summary },
      findings,
    };
  }

  return {
    testId: test.id,
    status: findings.length > 0 ? 'FAILED' : 'PASSED',
    durationMs: Date.now() - startedAt,
    steps,
    network: [],
    console: notes,
    videoKey: null,
    traceKey: null,
    errorMessage: findings.length > 0 ? summary : summary,
    retriedAndPassed: false,
    findings,
  };
}

/**
 * The plugin.
 *
 * `type: 'TENANCY' as const` rather than `RunnerPlugin`, exactly as
 * `linksPlugin` and `seoPlugin` do: `TestType` is the union behind a Postgres
 * enum, and until `TEST_TYPES` and the Prisma enum name TENANCY the literal is
 * not assignable. The registry's `PENDING_PLUGINS` table is where it waits, and
 * `pendingTypes()` is the read path that reports the gap honestly in the
 * meantime. The exact registry edit is in this slice's handover — this file
 * does not own `registry.ts`.
 */
export const tenancyPlugin = {
  type: 'TENANCY' as const,

  validate(test: ExecutableTest): void {
    const spec = parseSpec(test);
    /*
     * Caught HERE rather than at run time, because a test author who learns
     * this from a SKIPPED result has waited for a whole run to be told about a
     * spec that could never measure anything.
     */
    if (spec.holder.tenantId !== null && spec.holder.tenantId === spec.subject.tenantId) {
      throw new Error(
        `Tenancy test "${test.name}" names the same tenant on both sides, so a successful read ` +
          'would prove nothing about cross-tenant access. Name two different tenants.',
      );
    }
    if (spec.holder.principal === spec.subject.principal) {
      throw new Error(
        `Tenancy test "${test.name}" names one principal as both the holder and the subject, so ` +
          'it would ask a principal for its own records.',
      );
    }
  },

  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    return runTenancyTest(ctx, test, parseSpec(test), deps);
  },
};
