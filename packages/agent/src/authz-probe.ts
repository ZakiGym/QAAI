/**
 * CROSS-USER AUTHORIZATION PROBES — can user A read user B's object?
 *
 * ── What was here before, and why it tested nothing ─────────────────────────
 *
 * `packages/runner/src/plugins/security-smoke.ts` has an `idor` check. It
 * fetches each candidate id with a PLAIN UNAUTHENTICATED GET and reports a 2xx
 * as a finding. Anonymous denial is the one thing every application on earth
 * gets right, so the check passes everywhere and finds nothing — while reading,
 * on the report, as though the IDOR class had been covered. That is the most
 * expensive shape of lie this product can tell: not a wrong number, but a
 * whole bug class marked checked.
 *
 * The real question is whether user A, FULLY AUTHENTICATED, can read user B's
 * object. It was inexpressible because a run had one session
 * (`playwright-harness.ts` writes one storage state), so there was no "user B"
 * for an id to belong to. `Principal` and `RunContext.sessions` fixed the
 * shape; this module asks the question.
 *
 * ── THE CORE OF THIS MODULE IS THE THREE-WAY VERDICT ────────────────────────
 *
 * A 200 is a FINDING. A 403 or a 404 is a pass. A 401 IS NEITHER — it means the
 * session was not what we thought, and a broken session silently turning every
 * authorization probe green is the worst available failure mode for this
 * feature. It is worse than the old anonymous check, because the old check was
 * at least honestly useless; a sweep of forty endpoints that all 401 because
 * the holder's cookie expired renders as "40 endpoints, 0 leaks" and would be
 * believed.
 *
 * So the verdict set has THREE regions — finding, pass, and inconclusive — and
 * {@link INCONCLUSIVE_VERDICTS} is derived by exclusion so that a ninth verdict
 * has to argue its way into one of them.
 *
 * ── AND THE CONTROL REQUEST, WHICH IS STRONGER THAN THE 401 RULE ────────────
 *
 * Rejecting 401s is not enough. A dead session can produce a 403 just as
 * easily — an application that resolves no user and then checks ownership
 * answers "forbidden", not "unauthorised" — and that would be scored as a
 * clean pass on every endpoint in the sweep. So before any probe is believed,
 * the holder reads ITS OWN object: a 2xx on that proves the session is live and
 * the credential is being accepted. Without a CONFIRMED_LIVE control, every
 * verdict in the sweep is INCONCLUSIVE_SESSION regardless of status. See
 * {@link controlFrom} and the first branch of {@link classifyAuthzOutcome}.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *
 * SAFE-VERB AND READ-ONLY. `admitAuthzProbe` accepts only the methods
 * `SAFE_PROBE_METHODS` names (GET, HEAD, OPTIONS); anything that could change
 * another user's data is REFUSED and the refusal is RECORDED, so the report
 * says "this check was not performed and why" instead of a probe that was
 * silently skipped or — far worse — performed because it would be more
 * thorough.
 *
 * NO CREDENTIAL EVER ENTERS THIS MODULE. A probe names its principal by NAME;
 * {@link AuthzTransport} is the seam where an adapter resolves that name to a
 * session. Nothing here holds, logs or returns a cookie, a token or a storage
 * state — which is also what makes the whole file testable with a fake and no
 * network.
 */

import { isSafeProbeMethod } from '../../shared/src/principals';
import type { Principal, SafeProbeMethod } from '../../shared/src/principals';
import type { Finding } from '@qaai/shared';

/*
 * The two imports above cross the workspace boundary, which is a defect and is
 * recorded as one. `packages/shared/src/principals.ts` is not on its package
 * barrel — `packages/shared/src/index.ts` has no `export * from './principals'`
 * — so none of the principal vocabulary is reachable through `@qaai/shared`.
 * `index.ts` belongs to another change in this round; the one-line fix is in
 * this slice's handover, and when it lands both lines become `@qaai/shared`.
 */

// ─── 1. Where an id came from ────────────────────────────────────────────────

/**
 * How an identifier was observed. It decides nothing about the probe and
 * everything about whether a FINDING is defensible: "the id was in the URL
 * while signed in as B" is evidence a reviewer accepts, and "the id was a
 * number we incremented" is a guess, which is why there is no member for one.
 */
export const ID_BASES = [
  /** A path segment of a URL the owner's session visited. */
  'URL_PATH',
  /** A query parameter on such a URL. */
  'QUERY_PARAM',
  /** A field of a response body the owner's session received. */
  'RESPONSE_BODY',
  /** An href the owner's session was shown. */
  'LINK_HREF',
  /** A value in a form the owner's session was served. */
  'FORM_VALUE',
] as const;
export type IdBasis = (typeof ID_BASES)[number];

/** Compile-time half of the parity guard; see the records in principals.ts. */
const ID_BASIS_PRESENT: Record<IdBasis, true> = {
  URL_PATH: true,
  QUERY_PARAM: true,
  RESPONSE_BODY: true,
  LINK_HREF: true,
  FORM_VALUE: true,
};

/** Derived, never hand-listed. */
export const ID_BASIS_LIST = Object.keys(ID_BASIS_PRESENT) as ReadonlyArray<IdBasis>;

/**
 * One identifier, and WHOSE it is.
 *
 * `owner` is the load-bearing field and it is a principal NAME, not a boolean
 * "someone else's". The old check had no owner at all — ids were harvested
 * anonymously and belonged to nobody — which is exactly why it could only ever
 * ask the anonymous question.
 */
export interface ObservedId {
  readonly value: string;
  /** The {@link Principal.name} whose session this id was observed under. */
  readonly owner: string;
  /** The route or endpoint it appeared in, for the report. */
  readonly observedIn: string;
  readonly basis: IdBasis;
  /**
   * A string that appears in the OWNER'S rendering of this object and would not
   * appear in an empty or scoped response — their email, their company name.
   *
   * Null means nobody supplied one, and null is handled honestly everywhere: a
   * 2xx with no evidence to check is {@link AuthzVerdict} LEAKED_UNVERIFIED,
   * never LEAKED, because claiming we saw B's data when we did not read the
   * body is the same class of lie as claiming we checked when we did not.
   */
  readonly ownerEvidence: string | null;
}

/** One read endpoint, as a template with a single `{id}` hole. */
export interface ReadEndpoint {
  readonly method: string;
  /** Must contain `{id}` exactly once. Checked by {@link admitAuthzProbe}. */
  readonly template: string;
  /** What this endpoint is, for the report. Never empty. */
  readonly label: string;
}

// ─── 2. The control request ──────────────────────────────────────────────────

/**
 * Whether the holder's session is actually working.
 *
 * Three states, and the third is not a nicety: a sweep with NO control attempt
 * is a sweep whose passes mean nothing, and recording that as a fourth kind of
 * pass is how the feature would quietly stop working the day somebody forgot to
 * supply the holder's own id.
 */
export const CONTROL_STATES = [
  /** The holder read its OWN object successfully. The session is live. */
  'CONFIRMED_LIVE',
  /**
   * The holder could NOT read its own object. The session is not what we
   * thought, so no denial in this sweep is evidence of authorization.
   */
  'REFUTED',
  /** No own-object id was supplied, so the session was never established. */
  'NOT_ATTEMPTED',
] as const;
export type ControlState = (typeof CONTROL_STATES)[number];

/** Compile-time half of the parity guard. */
const CONTROL_STATE_PRESENT: Record<ControlState, true> = {
  CONFIRMED_LIVE: true,
  REFUTED: true,
  NOT_ATTEMPTED: true,
};

/** Derived, never hand-listed. */
export const CONTROL_STATE_LIST = Object.keys(
  CONTROL_STATE_PRESENT,
) as ReadonlyArray<ControlState>;

export const CONTROL_STATE_DETAIL: Record<ControlState, string> = {
  CONFIRMED_LIVE:
    "the holder read its own object, so its session is live and its credential is being accepted — " +
    'a denial on another user’s object is therefore evidence about authorization',
  REFUTED:
    'the holder could NOT read its own object, so its session is not being accepted. Every ' +
    'refusal in this sweep is indistinguishable from being signed out, and NONE of them is ' +
    'evidence that authorization works. Re-establish the session and run the sweep again',
  NOT_ATTEMPTED:
    'no object belonging to the holder was supplied, so there was no way to prove the holder’s ' +
    'session works. The sweep was performed and its refusals prove nothing — supply one id the ' +
    'holder owns and every verdict becomes meaningful',
};

export interface AuthzControl {
  readonly state: ControlState;
  /** The status the control request got, or null when none was made. */
  readonly status: number | null;
  /** The sentence the report prints. Always written, never defaulted to ''. */
  readonly detail: string;
}

/**
 * Judge the control request.
 *
 * A 2xx is the ONLY confirmation. A 3xx is not: a redirect to the login page is
 * the classic shape of an expired session, and following it would land on a
 * page that renders perfectly — which is how a dead session comes to look
 * healthy.
 */
export function controlFrom(observation: { status: number | null } | null): AuthzControl {
  if (observation === null) {
    return { state: 'NOT_ATTEMPTED', status: null, detail: CONTROL_STATE_DETAIL.NOT_ATTEMPTED };
  }
  const status = observation.status;
  const live = status !== null && status >= 200 && status < 300;
  const state: ControlState = live ? 'CONFIRMED_LIVE' : 'REFUTED';
  return {
    state,
    status,
    detail:
      state === 'CONFIRMED_LIVE'
        ? CONTROL_STATE_DETAIL.CONFIRMED_LIVE
        : `${CONTROL_STATE_DETAIL.REFUTED} (the control request answered ${status === null ? 'nothing' : String(status)})`,
  };
}

// ─── 3. The verdicts ─────────────────────────────────────────────────────────

/**
 * What one probe established. Eight members, in three regions.
 *
 * The regions matter more than the members: a consumer that groups these into
 * "pass" and "fail" has thrown away the only distinction this module exists to
 * draw, so {@link PASSING_VERDICTS}, {@link FINDING_VERDICTS} and
 * {@link INCONCLUSIVE_VERDICTS} are exported and the third is DERIVED BY
 * EXCLUSION — a ninth verdict defaults into "inconclusive", which is the safe
 * direction, rather than into "pass".
 */
export const AUTHZ_VERDICTS = [
  /** 2xx AND the owner's evidence was in the body. A's session read B's data. */
  'LEAKED',
  /**
   * 2xx and the body was NOT verified, because no owner evidence was supplied.
   * A finding — a successful read of another user's object id is not normal —
   * but recorded separately, because "we saw B's data" is a stronger claim than
   * the evidence supports.
   */
  'LEAKED_UNVERIFIED',
  /**
   * 2xx and the body provably did NOT contain the owner's data: the endpoint
   * answered and returned a scoped or empty result. Correct behaviour, and NOT
   * the same fact as a refusal, so it is not folded into DENIED.
   */
  'SERVED_BUT_SCOPED',
  /** 403, 404 or 410. The application refused or hid it. A pass. */
  'DENIED',
  /**
   * The holder's session was not established or not accepted. NOT A PASS. This
   * is the verdict the whole module is shaped around.
   */
  'INCONCLUSIVE_SESSION',
  /** 5xx, 429, or nothing answered. Not an answer about authorization. */
  'INCONCLUSIVE_NO_ANSWER',
  /** Nobody asked — a cap bit, or the sweep was cancelled. Carries a reason. */
  'NOT_PROBED',
  /** Admission refused it — an unsafe verb, a vacuous pair. Carries a reason. */
  'REFUSED',
] as const;
export type AuthzVerdict = (typeof AUTHZ_VERDICTS)[number];

/** Compile-time half of the parity guard. */
const AUTHZ_VERDICT_PRESENT: Record<AuthzVerdict, true> = {
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
export const AUTHZ_VERDICT_LIST = Object.keys(
  AUTHZ_VERDICT_PRESENT,
) as ReadonlyArray<AuthzVerdict>;

/** Verdicts that are a finding about the application. */
export const FINDING_VERDICTS: ReadonlyArray<AuthzVerdict> = ['LEAKED', 'LEAKED_UNVERIFIED'];

/**
 * Verdicts that are evidence the boundary HELD.
 *
 * Listed rather than derived, because membership here is the most consequential
 * claim in the file: a verdict wrongly in this list becomes a pass that means
 * "we did not check". Two members, both of which required a live control.
 */
export const PASSING_VERDICTS: ReadonlyArray<AuthzVerdict> = ['DENIED', 'SERVED_BUT_SCOPED'];

/**
 * Everything else. DERIVED BY EXCLUSION, so a ninth verdict lands here by
 * default — which is the only safe direction for a default to point.
 */
export const INCONCLUSIVE_VERDICTS: ReadonlyArray<AuthzVerdict> = AUTHZ_VERDICT_LIST.filter(
  (verdict) =>
    !(FINDING_VERDICTS as readonly string[]).includes(verdict) &&
    !(PASSING_VERDICTS as readonly string[]).includes(verdict),
);

export const AUTHZ_VERDICT_LABELS: Record<AuthzVerdict, string> = {
  LEAKED: "read another user's object, and their data was in the response",
  LEAKED_UNVERIFIED: "read another user's object id successfully; the body was not verified",
  SERVED_BUT_SCOPED: 'answered without returning the other user’s data',
  DENIED: 'refused or hid the other user’s object',
  INCONCLUSIVE_SESSION: 'the holder’s session was not established, so nothing was learned',
  INCONCLUSIVE_NO_ANSWER: 'nothing usable answered, so nothing was learned',
  NOT_PROBED: 'nobody asked',
  REFUSED: 'not performed, on purpose',
};

/** What one read returned. Every field that could be a guess is nullable. */
export interface AuthzObservation {
  /** The HTTP status, or null when nothing answered. Never 0. */
  readonly status: number | null;
  /**
   * Whether the owner's evidence string was present in the body.
   *
   * NULL MEANS NOT DETERMINED — no evidence string was supplied, or the body
   * could not be read. It does not mean absent. A null read as `false` turns a
   * leak into SERVED_BUT_SCOPED, which is a finding deleted by a default.
   */
  readonly ownerEvidenceFound: boolean | null;
}

/**
 * The one derivation from an observation to a verdict.
 *
 * ── Order of the branches, and why it is not negotiable ────────────────────
 *
 *  1. THE CONTROL FIRST, before the status is even looked at. A 403 under a
 *     refuted session is not a pass; it is the sweep telling us about our own
 *     session. Putting this branch second — after "403 means denied" — is the
 *     single change that would turn this module back into the thing it
 *     replaced, and it is why the test for it is the first test in the file.
 *  2. No answer, which is our silence and not theirs.
 *  3. 401 — the application saying the credential was not accepted, which is
 *     the same conclusion as (1) arrived at from the other side.
 *  4. The refusals.
 *  5. The successes, split by what the body actually showed.
 *
 * Everything that is not one of those is INCONCLUSIVE_NO_ANSWER rather than a
 * pass: a 429 is rate limiting and a 500 is a broken box, and neither is an
 * answer about authorization.
 */
export function classifyAuthzOutcome(input: {
  readonly control: ControlState;
  readonly observation: AuthzObservation;
}): AuthzVerdict {
  if (input.control !== 'CONFIRMED_LIVE') return 'INCONCLUSIVE_SESSION';

  const { status, ownerEvidenceFound } = input.observation;
  if (status === null) return 'INCONCLUSIVE_NO_ANSWER';
  if (status === 401) return 'INCONCLUSIVE_SESSION';
  if (status === 403 || status === 404 || status === 410) return 'DENIED';
  if (status >= 200 && status < 300) {
    if (ownerEvidenceFound === true) return 'LEAKED';
    if (ownerEvidenceFound === false) return 'SERVED_BUT_SCOPED';
    return 'LEAKED_UNVERIFIED';
  }
  /*
   * A 3xx lands here on purpose. A redirect to a login page is the shape of an
   * expired session and a redirect to a dashboard is the shape of a scoped
   * refusal, and from outside we cannot tell them apart without following it —
   * which this module does not do, because a followed redirect renders a page
   * and a rendered page looks like success.
   */
  return 'INCONCLUSIVE_NO_ANSWER';
}

// ─── 4. Admission ────────────────────────────────────────────────────────────

/**
 * Why a cross-user probe was not performed.
 *
 * Distinct from `PROBE_REFUSAL_REASONS` in principals.ts, which governs
 * cross-TENANT probes: that one asks whether two principals are in different
 * tenants, and this one asks whether they are different USERS. Both are needed
 * and conflating them would mean a single-tenant application — which is most of
 * them — could never have its per-user authorization checked at all.
 */
export const AUTHZ_REFUSALS = [
  /** The verb could change the other user's data. See `SAFE_PROBE_METHODS`. */
  'UNSAFE_VERB',
  /** Holder and owner are the same principal, so a 200 is correct behaviour. */
  'SAME_PRINCIPAL',
  /**
   * The holder is ANONYMOUS. This is the OLD check, and it is refused by name:
   * anonymous denial is the one thing every application gets right, so a sweep
   * of it reads as covered and establishes nothing.
   */
  'ANONYMOUS_HOLDER',
  /** The holder has no session at all, so a denial would prove nothing. */
  'NO_HOLDER_SESSION',
  /** The template has no single `{id}` hole, so no id can be substituted. */
  'TEMPLATE_HAS_NO_ID',
] as const;
export type AuthzRefusal = (typeof AUTHZ_REFUSALS)[number];

/** Compile-time half of the parity guard. */
const AUTHZ_REFUSAL_PRESENT: Record<AuthzRefusal, true> = {
  UNSAFE_VERB: true,
  SAME_PRINCIPAL: true,
  ANONYMOUS_HOLDER: true,
  NO_HOLDER_SESSION: true,
  TEMPLATE_HAS_NO_ID: true,
};

/** Derived, never hand-listed. */
export const AUTHZ_REFUSAL_LIST = Object.keys(
  AUTHZ_REFUSAL_PRESENT,
) as ReadonlyArray<AuthzRefusal>;

export const AUTHZ_REFUSAL_DETAIL: Record<AuthzRefusal, string> = {
  UNSAFE_VERB:
    'the verb could change the other user’s data, so the probe was not performed — a cross-user ' +
    'sweep is read-only, and only GET, HEAD and OPTIONS are swept automatically',
  SAME_PRINCIPAL:
    'the asking principal owns this object, so a successful read is correct behaviour and proves ' +
    'nothing about authorization',
  ANONYMOUS_HOLDER:
    'the asking principal is anonymous. Anonymous denial is the one thing every application gets ' +
    'right, so this probe would pass everywhere and establish nothing — which is exactly what the ' +
    'check it replaces did. Supply a signed-in holder',
  NO_HOLDER_SESSION:
    'the asking principal holds no session, so a refusal would be indistinguishable from being ' +
    'signed out',
  TEMPLATE_HAS_NO_ID:
    'the endpoint template has no single {id} placeholder, so there is nowhere to substitute the ' +
    'other user’s identifier',
};

export type AuthzAdmission =
  | { readonly admitted: true; readonly method: SafeProbeMethod; readonly path: string }
  | { readonly admitted: false; readonly reason: AuthzRefusal; readonly detail: string };

/** Exactly one `{id}` hole, and nothing else that looks like one. */
const ID_HOLE = /\{id\}/g;

/**
 * Decide whether one (holder, endpoint, id) probe may run.
 *
 * READ-ONLY AND SAFE-VERB BY DEFAULT, and every arm that says no returns a
 * RECORDED refusal rather than a throw or a skip. None of them is a pass and
 * none of them is a zero: "0 cross-user leaks" over a sweep that refused every
 * probe is the lie this function exists to make impossible.
 */
export function admitAuthzProbe(input: {
  readonly holder: Principal;
  readonly endpoint: ReadEndpoint;
  readonly id: ObservedId;
  /** Whether the holder has a usable session. Resolved by the caller. */
  readonly holderHasSession: boolean;
}): AuthzAdmission {
  const deny = (reason: AuthzRefusal): AuthzAdmission => ({
    admitted: false,
    reason,
    detail: AUTHZ_REFUSAL_DETAIL[reason],
  });

  if (!isSafeProbeMethod(input.endpoint.method)) return deny('UNSAFE_VERB');
  if (input.holder.kind === 'ANONYMOUS') return deny('ANONYMOUS_HOLDER');
  if (!input.holderHasSession) return deny('NO_HOLDER_SESSION');
  if (input.holder.name === input.id.owner) return deny('SAME_PRINCIPAL');

  const holes = [...input.endpoint.template.matchAll(ID_HOLE)];
  if (holes.length !== 1) return deny('TEMPLATE_HAS_NO_ID');

  return {
    admitted: true,
    method: input.endpoint.method.toUpperCase() as SafeProbeMethod,
    path: input.endpoint.template.replace('{id}', encodeURIComponent(input.id.value)),
  };
}

// ─── 5. The plan ─────────────────────────────────────────────────────────────

/** One probe this module intends to perform. */
export interface PlannedAuthzProbe {
  readonly method: SafeProbeMethod;
  readonly path: string;
  readonly endpointLabel: string;
  /** The principal that asks. A NAME — never a credential. */
  readonly holder: string;
  /** The principal that owns the object. A NAME. */
  readonly owner: string;
  readonly id: ObservedId;
}

export interface AuthzPlan {
  /**
   * The control probe: the holder reading its OWN object. Null when no
   * holder-owned id was supplied, which {@link controlFrom} reports as
   * NOT_ATTEMPTED rather than letting the sweep proceed as though confirmed.
   */
  readonly control: Omit<PlannedAuthzProbe, 'owner'> | null;
  readonly probes: readonly PlannedAuthzProbe[];
  /** How many (endpoint, id) pairs were considered. */
  readonly considered: number;
  readonly refusals: ReadonlyArray<{
    readonly endpointLabel: string;
    readonly owner: string;
    readonly reason: AuthzRefusal;
    readonly detail: string;
  }>;
}

/**
 * Build the probe list. DETERMINISTIC and PURE — no clock, no randomness, and
 * the order is (endpoint as given) × (ids sorted by owner then value), so two
 * runs over the same crawl probe the same things in the same order.
 *
 * ── Why the control probe is planned here rather than in the sweep ─────────
 *
 * Because it must be impossible to run the sweep without it. A sweep function
 * that optionally takes a control argument will be called without one, and the
 * day it is, every refusal in the report becomes a pass. Planning it means the
 * absence is a VALUE — `control: null` — that `controlFrom` turns into
 * NOT_ATTEMPTED, and NOT_ATTEMPTED makes every verdict in the sweep
 * INCONCLUSIVE. The feature degrades to "we could not check", which is the
 * honest degradation.
 */
export function planAuthzProbes(input: {
  readonly holder: Principal;
  readonly holderHasSession: boolean;
  readonly endpoints: readonly ReadEndpoint[];
  /** Every id observed, whoever it belongs to. The holder's own are the control. */
  readonly ids: readonly ObservedId[];
}): AuthzPlan {
  const sortedIds = [...input.ids].sort(
    (a, b) => a.owner.localeCompare(b.owner) || a.value.localeCompare(b.value),
  );
  const probes: PlannedAuthzProbe[] = [];
  const refusals: Array<{
    endpointLabel: string;
    owner: string;
    reason: AuthzRefusal;
    detail: string;
  }> = [];
  let considered = 0;
  let control: Omit<PlannedAuthzProbe, 'owner'> | null = null;

  for (const endpoint of input.endpoints) {
    for (const id of sortedIds) {
      considered += 1;
      const admission = admitAuthzProbe({
        holder: input.holder,
        endpoint,
        id,
        holderHasSession: input.holderHasSession,
      });

      if (!admission.admitted) {
        /*
         * SAME_PRINCIPAL is the one refusal that is also an OPPORTUNITY: an id
         * the holder owns is exactly what the control request needs. So it is
         * recorded as a refusal — the probe genuinely was not performed, and
         * pretending otherwise would inflate the probe count — and the first
         * such id becomes the control.
         */
        if (admission.reason === 'SAME_PRINCIPAL' && control === null) {
          const path = endpoint.template.replace('{id}', encodeURIComponent(id.value));
          control = {
            method: endpoint.method.toUpperCase() as SafeProbeMethod,
            path,
            endpointLabel: endpoint.label,
            holder: input.holder.name,
            id,
          };
        }
        refusals.push({
          endpointLabel: endpoint.label,
          owner: id.owner,
          reason: admission.reason,
          detail: admission.detail,
        });
        continue;
      }

      probes.push({
        method: admission.method,
        path: admission.path,
        endpointLabel: endpoint.label,
        holder: input.holder.name,
        owner: id.owner,
        id,
      });
    }
  }

  return { control, probes, considered, refusals };
}

// ─── 6. The sweep ────────────────────────────────────────────────────────────

/**
 * The one piece of I/O this module needs, as a narrow injected interface.
 *
 * NOT a playwright `Page` and NOT a top-level `fetch`. The request names its
 * principal and the ADAPTER resolves the session — so this module's logic is
 * testable with a literal table, and the one place a credential exists is the
 * adapter, which is three lines long and holds no decisions.
 */
export interface AuthzTransport {
  read(request: {
    /** The principal to act as. A NAME; the adapter resolves the session. */
    readonly asPrincipal: string;
    readonly method: SafeProbeMethod;
    readonly path: string;
    /** The string to look for in the body, or null when none was supplied. */
    readonly lookFor: string | null;
  }): Promise<AuthzObservation>;
}

export interface AuthzProbeResult {
  readonly probe: PlannedAuthzProbe;
  readonly verdict: AuthzVerdict;
  readonly status: number | null;
  /** Why, in one sentence. Always written; never defaulted to ''. */
  readonly detail: string;
}

export interface AuthzSweepReport {
  readonly control: AuthzControl;
  readonly results: readonly AuthzProbeResult[];
  /** One count per verdict. Every verdict is present, including the zeros. */
  readonly counts: Readonly<Record<AuthzVerdict, number>>;
  readonly refusals: AuthzPlan['refusals'];
  readonly considered: number;
  /**
   * Probes that were planned and not performed, because a cap bit or the sweep
   * was cancelled. Zero when neither happened.
   */
  readonly notProbed: number;
  /** Non-null EXACTLY when `notProbed > 0`. A count with no reason is not a disclosure. */
  readonly notProbedReason: string | null;
  /**
   * How many probes produced a verdict that is evidence about authorization —
   * a finding or a pass. This, and NOT `results.length`, is the denominator any
   * percentage must be computed over.
   */
  readonly measured: number;
}

const EMPTY_COUNTS = (): Record<AuthzVerdict, number> => {
  const counts = {} as Record<AuthzVerdict, number>;
  for (const verdict of AUTHZ_VERDICT_LIST) counts[verdict] = 0;
  return counts;
};

/**
 * Run the sweep: control first, then every admitted probe.
 *
 * ── The control is sent FIRST and the sweep still runs when it fails ───────
 *
 * Deliberate, and the alternative was considered and rejected. Aborting on a
 * refuted control produces an empty report, and an empty report is read as
 * "nothing to see". Running the sweep and marking every verdict
 * INCONCLUSIVE_SESSION produces a report that says, forty times, "the holder's
 * session was not accepted" — which is a sentence with a fix in it, and which
 * cannot be mistaken for a clean bill of health.
 *
 * `limit` and `cancelled` are both DISCLOSED as a count and a reason. A sweep
 * that silently stopped at fifty endpoints on a four-hundred-endpoint API is
 * the cap-without-disclosure defect, and on this axis it would read as "no
 * cross-user leaks in your API".
 */
export async function runAuthzSweep(input: {
  readonly plan: AuthzPlan;
  readonly transport: AuthzTransport;
  readonly limit?: number;
  /** Cooperative cancellation, polled between probes. */
  readonly cancelled?: () => boolean;
}): Promise<AuthzSweepReport> {
  const { plan, transport } = input;

  const controlObservation =
    plan.control === null
      ? null
      : await transport.read({
          asPrincipal: plan.control.holder,
          method: plan.control.method,
          path: plan.control.path,
          lookFor: plan.control.id.ownerEvidence,
        });
  const control = controlFrom(controlObservation);

  const counts = EMPTY_COUNTS();
  const results: AuthzProbeResult[] = [];
  const limit = input.limit ?? plan.probes.length;
  let cancelledAt: number | null = null;

  for (const [index, probe] of plan.probes.entries()) {
    if (index >= limit) break;
    if (input.cancelled?.() === true) {
      cancelledAt = index;
      break;
    }
    const observation = await transport.read({
      asPrincipal: probe.holder,
      method: probe.method,
      path: probe.path,
      lookFor: probe.id.ownerEvidence,
    });
    const verdict = classifyAuthzOutcome({ control: control.state, observation });
    counts[verdict] += 1;
    results.push({
      probe,
      verdict,
      status: observation.status,
      detail: detailFor(verdict, probe, observation, control),
    });
  }

  const performed = results.length;
  const notProbed = plan.probes.length - performed;
  counts.NOT_PROBED += notProbed;
  counts.REFUSED += plan.refusals.length;

  const measured = results.filter(
    (result) =>
      (FINDING_VERDICTS as readonly string[]).includes(result.verdict) ||
      (PASSING_VERDICTS as readonly string[]).includes(result.verdict),
  ).length;

  return {
    control,
    results,
    counts,
    refusals: plan.refusals,
    considered: plan.considered,
    notProbed,
    notProbedReason:
      notProbed === 0
        ? null
        : cancelledAt === null
          ? `a limit of ${limit} probes was applied, so ${notProbed} planned probe(s) were not ` +
            'performed — at least that many more cross-user reads exist to check'
          : `the sweep was cancelled after ${performed} probe(s), so ${notProbed} planned ` +
            'probe(s) were not performed',
    measured,
  };
}

function detailFor(
  verdict: AuthzVerdict,
  probe: PlannedAuthzProbe,
  observation: AuthzObservation,
  control: AuthzControl,
): string {
  const where = `${probe.method} ${probe.path} (${probe.endpointLabel}), asked as ${probe.holder} for an object owned by ${probe.owner}`;
  const answered = observation.status === null ? 'nothing answered' : `answered ${observation.status}`;
  if (verdict === 'INCONCLUSIVE_SESSION' && control.state !== 'CONFIRMED_LIVE') {
    // The control's own sentence, not a restatement: the reader needs the
    // REASON the sweep is inconclusive, which lives on the control.
    return `${where}: ${control.detail}`;
  }
  return `${where}: ${answered} — ${AUTHZ_VERDICT_LABELS[verdict]}`;
}

// ─── 7. Findings and the honest summary ──────────────────────────────────────

/**
 * The findings, and NOTHING when the control was not live.
 *
 * A refuted control cannot produce a finding either: a 200 under a session we
 * could not establish is a 200 we cannot attribute, and filing it as a
 * cross-user leak would be a CRITICAL security finding manufactured out of a
 * broken login. {@link summariseAuthzSweep} is what carries that state to the
 * reader instead.
 */
export function authzFindings(report: AuthzSweepReport): Finding[] {
  if (report.control.state !== 'CONFIRMED_LIVE') return [];
  return report.results
    .filter((result) => (FINDING_VERDICTS as readonly string[]).includes(result.verdict))
    .map((result) => ({
      kind: 'SECURITY' as const,
      /*
       * CRITICAL for a verified leak and SERIOUS for an unverified one. The gap
       * is deliberate: an unverified leak is a successful read of another
       * user's object id with the body unchecked, which is worth waking
       * somebody for but is not yet "their data was on our screen".
       */
      severity: result.verdict === 'LEAKED' ? ('CRITICAL' as const) : ('SERIOUS' as const),
      code: result.verdict === 'LEAKED' ? 'cross-user-read' : 'cross-user-read-unverified',
      message: result.detail,
      location: result.probe.path,
      helpUrl: null,
    }));
}

/**
 * The sentence a report prints. It is a function rather than a template in a
 * UI because the one thing it must never say is "no cross-user leaks found"
 * when nothing was measured, and that judgement belongs next to the verdicts.
 */
export function summariseAuthzSweep(report: AuthzSweepReport): string {
  const parts: string[] = [];
  if (report.control.state !== 'CONFIRMED_LIVE') {
    return (
      `No cross-user authorization was measured: ${report.control.detail}. ` +
      `${report.results.length} probe(s) ran and every one of them is inconclusive.`
    );
  }
  const leaked = report.counts.LEAKED + report.counts.LEAKED_UNVERIFIED;
  if (leaked > 0) parts.push(`${leaked} cross-user read(s) succeeded`);
  if (report.measured - leaked > 0) parts.push(`${report.measured - leaked} denial(s) confirmed`);
  const inconclusive = report.results.length - report.measured;
  if (inconclusive > 0) parts.push(`${inconclusive} inconclusive`);
  if (report.refusals.length > 0) {
    parts.push(`${report.refusals.length} not performed on purpose`);
  }
  if (report.notProbed > 0) parts.push(`${report.notProbed} not probed`);
  const disclosure = report.notProbedReason === null ? '' : ` ${report.notProbedReason}.`;
  return `${parts.join(', ')}.${disclosure}`;
}
