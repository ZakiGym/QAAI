/**
 * MAY WE OPEN THIS CONNECTION, ON WHOSE BEHALF, AND TO WHICH ADDRESS EXACTLY.
 *
 * ─── WHAT WAS MISSING, AS OPPOSED TO WHAT ALREADY EXISTS ────────────────────
 *
 * `packages/shared/src/private-address.ts` can already CLASSIFY a host, and it
 * is good: `classifyIpv4`, `classifyIpv6`, `classifyHost`, `resolvesPublicly`,
 * the alternate-encoding refusals, the embedded-IPv4 cases. It has five
 * production callers (`apps/api/src/lib/pull-request.ts`,
 * `apps/api/src/routes/api-surface.ts` twice, `packages/runner/src/preflight.ts`
 * and `packages/runner/src/plugins/email.ts`), so the pattern is established.
 *
 * What does not exist is a POLICY — "which classes may be reached, by whom, in
 * this deployment" — and a DECISION that can be RECORDED. Without the first,
 * every caller re-derives the rule and they drift; without the second,
 * "enforcing this would have refused 1,204 connections" is unanswerable, so
 * nobody dares turn it on.
 *
 * And the largest outbound surface in the product has neither. `Environment.baseUrl`
 * is validated by `httpUrl` in schemas.ts — `z.string().url()` plus an
 * http/https check and nothing else — so loopback, RFC1918, link-local and the
 * cloud metadata address are all accepted at the door. A MEMBER's FORM_LOGIN
 * profile then drives a real browser at that URL and TYPES VAULT PLAINTEXT into
 * whatever answers, and the crawl's progress events report what it found, which
 * makes the crawler a port-reachability oracle for our own network.
 *
 * ─── WHY THIS FILE HAS NO RESOLVER AND NO CLASSIFIER ───────────────────────
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * It imports from `private-address.ts` with `import type` ONLY, because
 * `schemas.ts` imports this file and `schemas.ts` is re-exported from
 * `packages/shared/src/index.ts`, which is what the web app's bundler consumes.
 * `private-address.ts` reaches for `node:dns`; a value import here would put
 * `node:dns` in the cockpit's bundle. That hazard is written down in
 * `check-wiring.ts`, which once recommended re-exporting that module from the
 * barrel and was telling the reader to break the web build.
 *
 * The second reason: a policy with its own DNS lookup is a policy nobody can
 * test, and a control nobody can test with a fake is a control nobody will
 * trust. So the classifier and the resolver arrive as {@link EgressIo} —
 * `resolvesPublicly` already takes a `LookupFn` for exactly this reason — and
 * every function here is deterministic given its inputs. There is NO NETWORK
 * AND NO DNS in this module or its tests.
 *
 * ─── THE DNS-REBINDING RULE, WHICH IS THE ONE THAT MAKES THIS REAL ─────────
 *
 * CHECKING THE NAME IS WORTHLESS. `resolvesPublicly` says so in its own header
 * and so does `guardProbeHost`: it is a CHECK, not a pin. Whoever opens the
 * connection resolves the name AGAIN, so a record set that answers
 * `93.184.216.34` to the check and `169.254.169.254` to the connection defeats
 * the entire control, and it does not need a sophisticated attacker — a
 * one-second TTL and two A records are enough, and a cache that happens to
 * expire between the two calls will do it by accident.
 *
 * So the decision carries a PINNED ADDRESS SET ({@link PinnedResolution}): the
 * exact addresses that were classified, which are the only addresses the caller
 * may connect to. {@link assertConnectingTo} is the check at the socket, and a
 * caller that resolves the name again instead of using the pin has not applied
 * this control, whatever its logs say. That obligation is stated on the
 * decision type itself so it cannot be missed by someone reading only the
 * signature.
 *
 * ─── NO CONTROL MAY BE AN ORACLE ───────────────────────────────────────────
 *
 * Every refusal reports TWO strings and they have different audiences.
 * `detail` is for the operator, inside their own tenant, and names the class
 * and the address. {@link EGRESS_REFUSAL_SENTENCE} is what a caller may put in
 * a response or a progress event, and it is ONE CONSTANT: identical for a
 * loopback address, a link-local address, an unresolvable name, a host that is
 * not on the allowlist and a context that may not reach outward at all. A
 * refusal that varies tells an attacker which internal hosts exist, and the
 * crawl's progress events are already a reachability oracle without help.
 */

import { CONTROL_MODES, EGRESS_DEPLOYMENT_MODES } from './constants';
import type { ControlMode, EgressDeploymentMode } from './constants';
/*
 * TYPE-ONLY, and the module header says why at length: a value import from
 * private-address.ts would put `node:dns` into the web app's bundle through
 * schemas.ts and the barrel.
 */
import type { AddressClass, HostClass } from './private-address';

// ─── Who is connecting ──────────────────────────────────────────────────────

/**
 * ON WHOSE BEHALF THIS CONNECTION IS BEING MADE. Each has a different
 * legitimate reach, which is the only reason this is not a boolean.
 *
 * The distinction that matters: a CRAWL and a LOGIN are aimed at the
 * customer's own application, so a self-hosted install must be able to point
 * them at `http://localhost:3000` — that is the product working. A
 * WEBHOOK_DELIVERY, a TRACKER_CALL and an SSO_METADATA fetch are aimed at a
 * third party on the internet, so there is no deployment in which they
 * legitimately reach a private address, and they are refused in both modes.
 * One rule for all seven would have had to choose between breaking the
 * self-hosted product and leaving the SSRF open.
 */
export const EGRESS_CONTEXTS = [
  'CRAWL',
  'LOGIN',
  'PLUGIN_HTTP',
  'WEBHOOK_DELIVERY',
  'TRACKER_CALL',
  'SSO_METADATA',
  'DOCUMENT_FETCH',
] as const;
export type EgressContext = (typeof EGRESS_CONTEXTS)[number];

/** What one context is for, and how far it may legitimately reach. */
export interface EgressContextRule {
  /**
   * True when this context aims at the application under test, which is the
   * only kind of target a self-hosted install may legitimately have inside its
   * own network.
   *
   * WHERE IT IS APPLIED: `decidePinned` in this file, which permits a
   * third-party context `public` AND NOTHING ELSE whatever the deployment's
   * class list says. It is checked a second time in `guardUrl`
   * (egress-guard.ts) and that copy is now defence in depth rather than the
   * enforcement — it was the enforcement for one round, while this flag was
   * read only after an address had already failed the deployment's class list,
   * so a SELF_HOSTED policy answered ALLOWED for `10.0.0.5` on all four.
   */
  readonly targetsApplicationUnderTest: boolean;
  /**
   * True when an explicit allowlist entry may widen this context. False for the
   * third-party contexts: an operator who allowlists an internal host for
   * webhook delivery has built an SSRF with paperwork.
   */
  readonly allowlistApplies: boolean;
  /** One sentence naming what this context does, for the refusal an operator reads. */
  readonly what: string;
}

/**
 * The compiler-enforced presence record. A `Record<EgressContext, …>` cannot be
 * written without naming every member, so an eighth context is a type error
 * here rather than a context with no rule — and a context with no rule read
 * through `undefined` would be a context with no allowlist and no reach, i.e.
 * a feature that silently stops working, or worse, one whose `undefined` is
 * read as permissive.
 *
 * Both halves, because one without the other passes while the two disagree:
 * this is the compile-time half and `egressContextSchema.options` in schemas.ts
 * is the run-time half. Eight `GateRule` kinds shipped UNSAVEABLE for two
 * slices because only one of the two existed.
 */
export const EGRESS_CONTEXT_RULES = {
  CRAWL: {
    targetsApplicationUnderTest: true,
    allowlistApplies: true,
    what: "Enumerating the customer's own application with a browser.",
  },
  LOGIN: {
    targetsApplicationUnderTest: true,
    allowlistApplies: true,
    what: "Signing in to the customer's own application, which TYPES VAULT PLAINTEXT into whatever answers.",
  },
  PLUGIN_HTTP: {
    targetsApplicationUnderTest: true,
    allowlistApplies: true,
    what: 'A mediated HTTP call made by plugin code, which is untrusted by definition.',
  },
  WEBHOOK_DELIVERY: {
    targetsApplicationUnderTest: false,
    allowlistApplies: false,
    what: 'Delivering an event to a customer-registered URL on the internet.',
  },
  TRACKER_CALL: {
    targetsApplicationUnderTest: false,
    allowlistApplies: false,
    what: 'Calling an issue tracker — Jira, Linear, GitHub — at a customer-named base URL.',
  },
  SSO_METADATA: {
    targetsApplicationUnderTest: false,
    allowlistApplies: false,
    what: "Fetching an identity provider's metadata document at a customer-named URL.",
  },
  DOCUMENT_FETCH: {
    targetsApplicationUnderTest: false,
    allowlistApplies: false,
    what: 'Fetching an OpenAPI or Postman document at a URL supplied in a request body.',
  },
} as const satisfies Record<EgressContext, EgressContextRule>;

// ─── The refusals ───────────────────────────────────────────────────────────

/**
 * Every reason a connection is not made. Closed, because each is a case a
 * caller must handle and because the OBSERVE-mode count is grouped by it.
 *
 * `RESOLUTION_NOT_PINNED` and `PINNED_SET_CHANGED` are the rebinding pair and
 * they are the two nobody thinks to write down: the first is a caller that
 * asked for a decision and then connected by name anyway, the second is a
 * caller that connected to an address which was not in the set that was
 * classified. Both are OUR bug rather than the customer's, and both have to be
 * refusals rather than warnings, because the whole control collapses to a
 * logging statement without them.
 */
export const EGRESS_REFUSALS = [
  /** The host classified as a non-permitted class (loopback, private, link-local, …). */
  'CLASS_NOT_PERMITTED',
  /** `classifyHost` returned `ambiguous`. Treated exactly as loopback. */
  'AMBIGUOUS_HOST',
  /** The name did not resolve. A name we cannot vouch for is not a name we connect to. */
  'UNRESOLVED',
  /** The name resolved to an empty answer. No addresses is not "no problem". */
  'NO_ADDRESSES',
  /** A private-class target in a deployment where only the allowlist may permit one. */
  'NOT_ALLOWLISTED',
  /** This context may never reach outward on a private address, allowlist or not. */
  'CONTEXT_NOT_PERMITTED',
  /** The caller connected without the pinned address set. Our bug; still a refusal. */
  'RESOLUTION_NOT_PINNED',
  /** The caller connected to an address that was not the one classified. Rebinding. */
  'PINNED_SET_CHANGED',
  /** No policy could be resolved at all. Refuse; a missing policy is not an open one. */
  'POLICY_UNRESOLVED',
] as const;
export type EgressRefusal = (typeof EGRESS_REFUSALS)[number];

/**
 * WHAT HAPPENED TO ONE EGRESS DECISION. Mirrors the `EgressOutcome` Prisma
 * enum; `check:enums` diffs them.
 *
 * Three, and the third is the entire reason this feature can be switched on.
 * WOULD_REFUSE is an OBSERVE-mode refusal: the connection WAS made, and the
 * decision was recorded as one enforcement would have stopped. "We would have
 * refused 1,204 connections, 1,198 of them loopback from CRAWL" is a
 * `GROUP BY outcome, context, addressClass` over these rows, and it is the
 * answer an operator needs before they dare enforce.
 *
 * Two members would have been the usual mistake: an observed refusal recorded
 * as ALLOWED is a cap applied-or-not without being counted, which is one of the
 * lies this product cannot afford.
 */
export const EGRESS_OUTCOMES = ['ALLOWED', 'REFUSED', 'WOULD_REFUSE'] as const;
export type EgressOutcome = (typeof EGRESS_OUTCOMES)[number];

/**
 * THE ONE SENTENCE A REFUSAL MAY SHOW A CALLER.
 *
 * A single constant and not a function of the refusal, because the moment it
 * varies it becomes an oracle: "that is a loopback address" and "that host did
 * not resolve" and "that host is not on the allowlist" are three different
 * facts about the inside of a network, handed to whoever typed the URL. The
 * operator's own copy of the decision carries {@link EgressDecision.detail},
 * which says all of it — inside their tenant, where they are entitled to know.
 *
 * `egress.test.ts` asserts that every member of {@link EGRESS_REFUSALS}
 * produces this exact string, so a well-meant "more helpful" message cannot be
 * added at one call site.
 */
export const EGRESS_REFUSAL_SENTENCE =
  'QAAI will not open a connection to that host. If it is an internal host you intend to test, ' +
  'add it to this environment\'s egress allowlist with an owner and a reason.';

// ─── The allowlist ──────────────────────────────────────────────────────────

/**
 * THE SELF-HOSTED CUSTOMER'S LEGITIMATE ESCAPE: one internal host they intend
 * to test, named on purpose.
 *
 * ── Why an owner and a reason are required rather than nice to have ────────
 *
 * Because an allowlist entry is a permanent hole in the one control standing
 * between a customer-supplied string and our own network, and an entry nobody
 * owns is an entry nobody will ever remove. The write path REFUSES an entry
 * with no owner and no reason (`egressAllowlistEntrySchema` in schemas.ts); it
 * is not a convention, because conventions are what produced the five expiring
 * suppressions that never expired.
 *
 * `expiresAt` is nullable and that is a deliberate difference from a
 * suppression, where an expiry is non-nullable at the type level. A test
 * environment pointed at `app.internal` is a permanent fact about the
 * install, not a temporary accommodation, and forcing a date onto it would
 * produce an annual outage and a renewal nobody reads. The equivalent of the
 * expiry here is the OWNER: a named human, in a table an auditor can read.
 */
export interface EgressAllowlistEntry {
  /**
   * The host, already normalised (lower-case, no trailing dot). Matched
   * EXACTLY — never as a suffix and never as a pattern. A `*.internal` entry
   * would be a wildcard over a namespace an attacker can register names in, and
   * the exact-match rule is the same one that makes a mute safe.
   */
  readonly host: string;
  /** Which contexts this entry widens. Empty means NONE, never "all" — see the schema. */
  readonly contexts: readonly EgressContext[];
  /** A person. Required. */
  readonly ownerEmail: string;
  /** Why this host is reachable on purpose. Required. */
  readonly reason: string;
  /** Null is legal here, unlike a suppression. See the type's own comment. */
  readonly expiresAt: string | null;
}

// ─── The policy ─────────────────────────────────────────────────────────────

/**
 * WHICH HOST CLASSES MAY BE REACHED, IN THIS DEPLOYMENT, FOR THIS ENVIRONMENT.
 *
 * ── THE DEFAULT, WHICH IS THE FIELD THAT DECIDES WHETHER THE PRODUCT IS SAFE
 *    OUT OF THE BOX ───────────────────────────────────────────────────────────
 *
 * HOSTED: PUBLIC ONLY. {@link HOSTED_EGRESS_POLICY} permits exactly one class,
 * `public`, and its allowlist is empty. In QAAI's own cloud a tenant who sets
 * their base URL to `http://169.254.169.254/` has arranged for our worker to
 * fetch the cloud metadata endpoint, and the crawl's progress events would tell
 * them what it said. There is no reading of that which is acceptable, so the
 * default refuses it and an operator must add an allowlist entry — with their
 * name on it — to change that for one host.
 *
 * SELF_HOSTED: PERMISSIVE, WITH A WARNING, AND WITH ONE LINE THAT DOES NOT MOVE.
 * {@link SELF_HOSTED_EGRESS_POLICY} permits `public`, `private`, `loopback` and
 * `reserved`, because a self-hosted QAAI exists precisely to test
 * `http://localhost:3000` and `https://app.internal` and refusing those would
 * break the install for every customer behind their own firewall — they are not
 * attacking themselves. {@link EgressDecision.warning} carries the sentence
 * saying so, because a check that was skipped must be NAMED rather than
 * silently not performed.
 *
 * `link-local` IS REFUSED IN BOTH MODES, and this is stricter than "permissive"
 * would suggest. 169.254.169.254 is the cloud metadata service on AWS, GCP and
 * Azure alike; it is never an application under test, in anybody's deployment,
 * and a self-hosted QAAI running on an EC2 instance has an instance role worth
 * stealing exactly like ours does. `multicast`, `unspecified` and `unparseable`
 * are refused in both modes for the reason `private-address.ts` gives: there is
 * no reading of an ambiguous literal worth the range of ways it can be wrong.
 * An operator who genuinely needs one of these has the allowlist, which costs
 * them a name and a sentence.
 *
 * ── THE LIMITATION OF THAT SENTENCE, MEASURED RATHER THAN ASSUMED ──────────
 *
 * It is about the link-local CLASS and it does NOT amount to "no metadata
 * endpoint is reachable in SELF_HOSTED mode". The IPv6 metadata address on EC2
 * is `fd00:ec2::254`, which is `fc00::/7` unique-local and therefore classifies
 * `private` — the same class as `10.0.0.5`, which is the address a self-hosted
 * customer's internal app legitimately has. So in SELF_HOSTED mode, with the
 * default class list, `fd00:ec2::254` IS REACHABLE, exactly as `10.0.0.1` is.
 * `egress.test.ts` asserts that as the measured behaviour rather than claiming
 * otherwise.
 *
 * This is stated and not patched, because the only two patches available are
 * both worse. A TEXTUAL denylist of metadata addresses is bypassed by writing
 * `fd00:0ec2::254`, and a check that can be defeated by an alternate spelling
 * is a pass that means "we did not check" — the exact lie this product may not
 * ship. Expanding an IPv6 literal properly means a value import of
 * `private-address.ts`, which puts `node:dns` in the web app's bundle through
 * this file and `schemas.ts` (see the module header). The remedy available to a
 * self-hosted operator today is to NARROW `permittedClasses` — `['public',
 * 'loopback']` is honoured, and narrowing is the one direction a stored policy
 * may always move — and the remedy available to this codebase is a
 * `classifyAddress`-based metadata check at the point where the classifier is
 * already imported. That belongs in `private-address.ts`, which this round does
 * not own.
 */
export interface EgressPolicy {
  readonly deployment: EgressDeploymentMode;
  /** OBSERVE counts what ENFORCE would have refused. The brake; see SECURITY_CONTROL_BRAKES. */
  readonly mode: ControlMode;
  /** Classes this deployment permits WITHOUT an allowlist entry. */
  readonly permittedClasses: readonly AddressClass[];
  readonly allowlist: readonly EgressAllowlistEntry[];
}

/** Classes no deployment may reach without an explicit, owned allowlist entry. */
export const NEVER_PERMITTED_BY_DEFAULT: readonly AddressClass[] = [
  'link-local',
  'multicast',
  'unspecified',
  'unparseable',
];

export const HOSTED_EGRESS_POLICY: EgressPolicy = {
  deployment: 'HOSTED',
  mode: 'ENFORCE',
  permittedClasses: ['public'],
  allowlist: [],
};

export const SELF_HOSTED_EGRESS_POLICY: EgressPolicy = {
  deployment: 'SELF_HOSTED',
  mode: 'ENFORCE',
  permittedClasses: ['public', 'private', 'loopback', 'reserved'],
  allowlist: [],
};

/**
 * The sentence a SELF_HOSTED decision carries when it permitted a private
 * target. Not an error and not optional: `guardProbeHost` already established
 * that a guard which passes silently in the one mode where it does nothing is
 * indistinguishable from a guard that ran, and that is the "pass that means we
 * did not check" this product may never print.
 */
export const SELF_HOSTED_EGRESS_WARNING =
  'This deployment is self-hosted, so a private, loopback or reserved target was permitted ' +
  'without being checked against the public-address rules. A hosted deployment would have ' +
  'refused it.';

/**
 * Read a policy out of whatever `Environment.egressPolicy` holds, plus the
 * `EgressAllowlistEntry` ROWS a caller has read for that environment.
 *
 * NEVER THROWS, and the fallback is the SAFE one: an unparseable policy
 * resolves to {@link HOSTED_EGRESS_POLICY}, which permits `public` and nothing
 * else. A malformed JSON column must not be the way a deployment becomes
 * permissive — that is an exception handler falling through to "allow", which
 * is the defect pattern this round is hunting.
 *
 * A stored policy may NARROW but never widen past the class list for its
 * deployment mode: `permittedClasses` is intersected with the base policy's, so
 * a row that lists `link-local` does not get it. The one way to widen is an
 * allowlist entry, which has an owner.
 *
 * ── WHY THE ENTRIES ARE A PARAMETER AND NOT A READ ─────────────────────────
 *
 * Because this module does no I/O at all and must not start: it is reachable
 * from `schemas.ts` and therefore from the cockpit's bundle, which is the same
 * reason the classifier and the resolver arrive as {@link EgressIo}. The rows
 * are read by whoever owns a Prisma client and handed in.
 *
 * ── WHY THE PARAMETER HAD TO EXIST AT ALL ──────────────────────────────────
 *
 * The product has two allowlist stores and this function could only see the
 * one nobody writes. `Environment.egressPolicy.allowlist` has NO WRITER
 * anywhere — measured 2026-10-30 — while the OWNER-only route
 * (`apps/api/src/routes/settings.ts`) upserts rows into the
 * `EgressAllowlistEntry` TABLE, whose only reader was the GET that lists them
 * back. So `allowlistEntryFor` could never return non-null in production: the
 * route answered 201, the page rendered the entry with its owner and its
 * reason, and the host stayed refused. That is a cap applied without being
 * reported, inverted — a grant recorded without being applied — and the
 * customer's only honest escape from a PUBLIC-ONLY default was inert.
 *
 * ── AND WHAT STAYS TRUE WITH NO ENTRIES ────────────────────────────────────
 *
 * Omitting the parameter, or passing an empty array, is byte-identical to the
 * previous behaviour, including the identity of the two base-policy constants.
 * Widening is opt-in per call site, so a caller that has not read the rows
 * cannot accidentally be the one that widens.
 */
export function resolveEgressPolicy(
  raw: unknown,
  /** `EgressAllowlistEntry` rows, as read. Anything unreadable is DROPPED. */
  storedEntries?: readonly unknown[],
): EgressPolicy {
  const stored = readAllowlistEntries(storedEntries);

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    /*
     * THE PATH PRODUCTION ACTUALLY TAKES, which is why the entries are applied
     * here and not only below: `Environment.egressPolicy` has no writer, so the
     * column is NULL for every environment in every install, and an earlier
     * draft of this parameter that merged the rows after the object branch
     * widened nothing at all. The constant itself is returned when there is
     * nothing to add, so the no-entries case is unchanged down to identity.
     */
    return stored.length === 0
      ? HOSTED_EGRESS_POLICY
      : { ...HOSTED_EGRESS_POLICY, allowlist: stored };
  }
  const o = raw as Record<string, unknown>;

  /*
   * OWN PROPERTIES ONLY, because `o.deployment` WALKS THE PROTOTYPE CHAIN and
   * this function is the single place the product decides whether a deployment
   * is the permissive one.
   *
   * MEASURED 2026-10-30: `resolveEgressPolicy(Object.create({ deployment:
   * 'SELF_HOSTED' }))` returned the SELF_HOSTED policy — public, private,
   * loopback AND reserved — for an object with NO own properties, whose
   * `Object.keys` is `[]` and whose `JSON.stringify` is `{}`. That directly
   * contradicts the paragraph above, which promises the fallback is the safe
   * one, and in a security file the comment is what the next reviewer trusts.
   *
   * ALSO MEASURED, so this is recorded as hardening and not as a live hole:
   * the vector is NOT reachable from `Environment.egressPolicy` today.
   * `JSON.parse('{"__proto__":{…}}')` keeps `__proto__` as an OWN property
   * rather than installing a prototype, and `Object.assign` copies it the same
   * way, so a JSONB column cannot produce the object above. What can is any
   * future caller that hands this a class instance or a defaults-merged object
   * built with `Object.create` — and "the permissive policy, from an object
   * that looks empty" is not a failure mode worth leaving one refactor away.
   */
  const own = (key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);

  const deployment = (EGRESS_DEPLOYMENT_MODES as readonly string[]).includes(
    own('deployment') as string,
  )
    ? (own('deployment') as EgressDeploymentMode)
    : 'HOSTED';
  const base = deployment === 'SELF_HOSTED' ? SELF_HOSTED_EGRESS_POLICY : HOSTED_EGRESS_POLICY;

  const mode = (CONTROL_MODES as readonly string[]).includes(own('mode') as string)
    ? (own('mode') as ControlMode)
    : base.mode;

  const requestedRaw = own('permittedClasses');
  const requested = Array.isArray(requestedRaw) ? requestedRaw : null;
  const permittedClasses =
    requested === null
      ? base.permittedClasses
      : base.permittedClasses.filter((cls) => requested.includes(cls));

  return {
    deployment,
    mode,
    permittedClasses,
    /*
     * The column's own list first, then the rows. Order decides only which
     * entry is REPORTED through `allowlistedBy` when two name the same host,
     * and the column keeps precedence so adding the rows cannot change what an
     * existing install reports.
     */
    allowlist: [
      ...readAllowlistEntries(Array.isArray(own('allowlist')) ? (own('allowlist') as unknown[]) : []),
      ...stored,
    ],
  };
}

/** Read a list of entries, dropping every one that cannot be read. */
function readAllowlistEntries(values: readonly unknown[] | undefined): EgressAllowlistEntry[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  const entries: EgressAllowlistEntry[] = [];
  for (const value of values) {
    const entry = readAllowlistEntry(value);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/**
 * One stored allowlist entry, structurally. Anything missing an owner or a
 * reason is DROPPED rather than repaired — a half-read entry is a hole somebody
 * believes is documented.
 *
 * ── THE EXPIRY IS READ HERE, AND AN UNREADABLE ONE DROPS THE ENTRY ─────────
 *
 * It used to be ignored entirely, which was fail-OPEN once the shape could come
 * from somewhere other than this file's own type. `allowlistEntryFor` compares
 * `new Date(entry.expiresAt).getTime()` against now, and `new Date('soon')` is
 * `NaN`, so `NaN <= now` is false and an entry with an expiry nobody can read
 * never expired. An allowlist entry is a permanent hole in the one control
 * between a customer-supplied string and our own network; "we could not read
 * the expiry, so it is still valid" is the arm that must not allow.
 *
 * A `Date` is accepted beside an ISO string because `EgressAllowlistEntry.expiresAt`
 * is a `DateTime?` COLUMN at the other end of this parameter and Prisma hands
 * back a `Date`. Normalising it here rather than requiring the caller to is the
 * forgiving direction on the SHAPE while staying strict on the MEANING: an
 * entry an operator wrote with an owner and a reason must not be silently
 * dropped, because a dropped entry is the inert-allowlist defect again — 201,
 * rendered on the page, host still refused.
 */
function readAllowlistEntry(value: unknown): EgressAllowlistEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.host !== 'string' || o.host.length === 0) return null;
  if (!Array.isArray(o.contexts)) return null;
  if (typeof o.ownerEmail !== 'string' || o.ownerEmail.length === 0) return null;
  if (typeof o.reason !== 'string' || o.reason.length === 0) return null;

  const expiresAt = readExpiry(o.expiresAt);
  if (expiresAt === UNREADABLE_EXPIRY) return null;

  return {
    host: o.host,
    /*
     * Filtered to the members this build knows, so the declared type is TRUE
     * rather than asserted. `contexts: ['*']` is not a wildcard — it is a list
     * naming no context, which is what an empty list means too: NOTHING.
     */
    contexts: o.contexts.filter((context): context is EgressContext =>
      (EGRESS_CONTEXTS as readonly string[]).includes(context as string),
    ),
    ownerEmail: o.ownerEmail,
    reason: o.reason,
    expiresAt,
  };
}

/** Distinguishes "no expiry" (legal, and permanent) from "unreadable" (dropped). */
const UNREADABLE_EXPIRY = Symbol('unreadable expiry');

function readExpiry(value: unknown): string | null | typeof UNREADABLE_EXPIRY {
  // Absent or explicitly null: legal, and permanent. See `EgressAllowlistEntry`.
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : UNREADABLE_EXPIRY;
  }
  if (typeof value !== 'string') return UNREADABLE_EXPIRY;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : UNREADABLE_EXPIRY;
}

// ─── The pinned resolution ──────────────────────────────────────────────────

/** One address, and what it classified as. Both, so a decision can say which decided it. */
export interface PinnedAddress {
  readonly address: string;
  readonly class: AddressClass;
}

/**
 * THE ADDRESSES THE CALLER MUST CONNECT TO — not the name, the addresses.
 *
 * This type is the answer to the honest limitation `resolvesPublicly` records
 * about itself. The classification happened on THESE addresses; connecting to
 * anything else is connecting to something nobody classified, whether because a
 * record set changed, a TTL expired or a resolver was poisoned.
 *
 * `pinnedAt` is an ISO string rather than a `Date` because a decision is
 * recorded, serialised and read back, and a `Date` that has been through JSON
 * is a string wearing a `Date` type.
 */
export interface PinnedResolution {
  /** The normalised host these addresses were resolved from. */
  readonly host: string;
  readonly addresses: readonly PinnedAddress[];
  readonly pinnedAt: string;
  /**
   * True when the host was an IP literal, so no resolver was consulted and the
   * pin cannot go stale. Distinct from a resolved pin because the rebinding
   * risk is simply absent, and reporting "pinned" for both would overstate what
   * was done for one of them.
   */
  readonly fromLiteral: boolean;
}

// ─── The decision ───────────────────────────────────────────────────────────

/**
 * WHAT WAS DECIDED, WHY, UNDER WHICH MODE, AND WHICH ADDRESSES IT AUTHORISES.
 *
 * ── The caller's obligation, stated here because this is what gets read ────
 *
 * `allowed === true` is NOT permission to connect to `host`. It is permission
 * to connect to the addresses in {@link PinnedResolution.addresses}, and
 * nothing else. A caller that takes `allowed` and then hands the hostname to
 * `fetch` has resolved the name a second time and has not applied this control.
 * {@link assertConnectingTo} is the check; `RESOLUTION_NOT_PINNED` is what it
 * answers when the caller never had a pin at all.
 */
export interface EgressDecision {
  readonly context: EgressContext;
  /** Normalised host, as classified. Never a URL: a path can be a bearer credential. */
  readonly host: string;
  /** May the caller connect? True for ALLOWED and for WOULD_REFUSE (observe mode). */
  readonly allowed: boolean;
  readonly outcome: EgressOutcome;
  /** Null exactly when `outcome` is ALLOWED. */
  readonly refusal: EgressRefusal | null;
  /** The class that decided it, or null when no address was classified at all. */
  readonly decidedByClass: AddressClass | null;
  /** The allowlist host that permitted it, or null. */
  readonly allowlistedBy: string | null;
  readonly mode: ControlMode;
  /** Non-null exactly when a connection is authorised. The addresses, not the name. */
  readonly pinned: PinnedResolution | null;
  /**
   * For the OPERATOR, inside their own tenant. Names the class and may name the
   * address. NEVER goes in a response, a progress event or a metric label —
   * {@link EGRESS_REFUSAL_SENTENCE} is what goes there.
   */
  readonly detail: string;
  /** The named skipped check, for SELF_HOSTED. Null when nothing was skipped. */
  readonly warning: string | null;
}

/** The classifier and resolver, injected. No DNS in a unit test. */
export interface EgressIo {
  /** `classifyHost` from private-address.ts. */
  readonly classifyHost: (host: string) => HostClass;
  /** `classifyAddress` from private-address.ts. */
  readonly classifyAddress: (address: string) => AddressClass;
  /** Must answer for EVERY address the name has, not the first. */
  readonly lookup: (host: string) => Promise<ReadonlyArray<{ address: string }>>;
  /** Injected so a decision's `pinnedAt` is deterministic in a test. */
  readonly now: () => Date;
}

function allowlistEntryFor(
  policy: EgressPolicy,
  context: EgressContext,
  host: string,
  now: Date,
): EgressAllowlistEntry | null {
  if (!EGRESS_CONTEXT_RULES[context].allowlistApplies) return null;
  for (const entry of policy.allowlist) {
    // EXACT match, never a suffix and never a pattern. See the type's comment.
    if (entry.host !== host) continue;
    if (!entry.contexts.includes(context)) continue;
    if (entry.expiresAt !== null && new Date(entry.expiresAt).getTime() <= now.getTime()) continue;
    return entry;
  }
  return null;
}

/**
 * Apply the mode. The ONE place OBSERVE turns a refusal into a counted pass, so
 * there is no call site at which the brake can be forgotten.
 */
function refuse(
  base: Omit<EgressDecision, 'allowed' | 'outcome' | 'pinned'>,
  refusal: EgressRefusal,
  detail: string,
): EgressDecision {
  const enforcing = base.mode === 'ENFORCE';
  return {
    ...base,
    refusal,
    detail,
    allowed: !enforcing,
    outcome: enforcing ? 'REFUSED' : 'WOULD_REFUSE',
    /*
     * NO PIN ON A REFUSAL, INCLUDING AN OBSERVED ONE. An observed refusal lets
     * the connection happen, and the caller connects the way it did before this
     * control existed — by name. Handing back a pin here would claim the
     * rebinding window was closed for a connection nobody authorised, which is
     * a worse lie than the hole OBSERVE deliberately leaves open.
     */
    pinned: null,
  };
}

/**
 * MAY WE CONNECT, AND TO WHAT.
 *
 * Resolves the host through the injected `io` and decides. The resolution it
 * returns is the resolution it classified — that identity is the control, and
 * it is why this function resolves rather than taking a verdict from a caller
 * who might have resolved something else.
 *
 * FAILS CLOSED AT EVERY STEP. An ambiguous host, a failed lookup, an empty
 * answer and a thrown resolver are all refusals. There is no arm that returns
 * `allowed: true` on an exception, which is the defect pattern worth hunting in
 * one's own work.
 */
export async function decideEgress(input: {
  readonly context: EgressContext;
  readonly host: string;
  readonly policy: EgressPolicy;
  readonly io: EgressIo;
}): Promise<EgressDecision> {
  const { context, policy, io } = input;
  const now = io.now();
  const verdict = io.classifyHost(input.host);
  const host = verdict.host;

  const base: Omit<EgressDecision, 'allowed' | 'outcome' | 'pinned'> = {
    context,
    host,
    refusal: null,
    decidedByClass: null,
    allowlistedBy: null,
    mode: policy.mode,
    detail: '',
    warning: null,
  };

  if (policy.permittedClasses.length === 0) {
    /*
     * An empty permitted list is not "permit nothing by policy" — it is a
     * policy that failed to resolve, because every real policy permits at least
     * `public`. Refused by name so it cannot be mistaken for a deliberate
     * lockdown that somebody would then "fix" by widening it.
     */
    return refuse(
      base,
      'POLICY_UNRESOLVED',
      'No egress policy could be resolved for this environment, so no class is permitted. ' +
        'A missing policy is not an open one.',
    );
  }

  if (verdict.kind === 'ambiguous') {
    /*
     * Treated exactly as loopback, which is the contract `classifyHost` states
     * and the one a caller gets wrong: `0177.0.0.1`, `0x7f.0.0.1` and
     * `2130706433` are all 127.0.0.1 to something downstream, and handing one
     * to a resolver gives the octal form a second chance.
     */
    return refuse(base, 'AMBIGUOUS_HOST', `Refusing ${host}: ${verdict.why}.`);
  }

  const allowlisted = allowlistEntryFor(policy, context, host, now);

  // ── An IP literal. No resolver is consulted and the pin cannot go stale. ──
  if (verdict.kind === 'address') {
    const pinned: PinnedResolution = {
      host,
      addresses: [{ address: host, class: verdict.class }],
      pinnedAt: now.toISOString(),
      fromLiteral: true,
    };
    return decidePinned({ base, policy, context, pinned, allowlisted });
  }

  let answers: ReadonlyArray<{ address: string }>;
  try {
    answers = await io.lookup(host);
  } catch {
    // A name we could not resolve is a name we cannot vouch for. There is no
    // reading of a failed lookup that makes the destination safer.
    return refuse(base, 'UNRESOLVED', `Refusing ${host}: it could not be resolved.`);
  }

  const addresses = answers
    .map((answer) => answer.address)
    .filter((address): address is string => typeof address === 'string' && address.length > 0)
    .map((address) => ({ address, class: io.classifyAddress(address) }));

  if (addresses.length === 0) {
    return refuse(base, 'NO_ADDRESSES', `Refusing ${host}: it resolved to no addresses.`);
  }

  const pinned: PinnedResolution = {
    host,
    addresses,
    pinnedAt: now.toISOString(),
    fromLiteral: false,
  };
  return decidePinned({ base, policy, context, pinned, allowlisted });
}

/**
 * The class rule, applied to EVERY address in the pinned set — not the first,
 * and not any.
 *
 * A record set that mixes one routable address with `169.254.169.254` is not a
 * misconfiguration, it is the attack written down. `resolvesPublicly` takes the
 * same position for the same reason, and this function is where that rule meets
 * the per-deployment class list, the CONTEXT and the allowlist.
 */
function decidePinned(args: {
  base: Omit<EgressDecision, 'allowed' | 'outcome' | 'pinned'>;
  policy: EgressPolicy;
  context: EgressContext;
  pinned: PinnedResolution;
  allowlisted: EgressAllowlistEntry | null;
}): EgressDecision {
  const { base, policy, context, pinned, allowlisted } = args;
  const rule = EGRESS_CONTEXT_RULES[context];
  /*
   * ─── THE THIRD-PARTY CONTEXT RULE, IN THE POLICY RATHER THAN IN ONE CALLER ─
   *
   * `EGRESS_CONTEXTS` promises of WEBHOOK_DELIVERY, TRACKER_CALL, SSO_METADATA
   * and DOCUMENT_FETCH that "there is no deployment in which they legitimately
   * reach a private address, and they are refused in both modes". Until this
   * line the code under that sentence did not do it, and the gap was exactly
   * the one shape of defect this file warns about elsewhere: the permitted set
   * was read from the DEPLOYMENT alone, so a SELF_HOSTED policy — which permits
   * `private`, `loopback` and `reserved` so a customer can crawl their own app
   * — left no offending address to find, the context branch below was never
   * reached, and `decideEgress` answered ALLOWED with a pin that INCLUDED
   * `10.0.0.5`. MEASURED at HEAD 37498c1 for all four contexts.
   *
   * `egress-guard.ts` compensated for it in `guardUrl` and said so, which held
   * the product shut through exactly one caller. That is the weaker half of the
   * fix: `decideEgress` is exported and this round adds callers for Jira, SSO
   * and webhooks, each of which is a third-party context, and any one of them
   * that reaches for the policy decision directly would have reopened the hole.
   * So the permitted set for a third-party context is `public` AND NOTHING
   * ELSE, decided here, where every caller passes.
   *
   * It keys on `targetsApplicationUnderTest` and not on `allowlistApplies`
   * although the two coincide for all seven contexts today: the question being
   * asked is "may this context point at our own network at all", which is the
   * first flag's meaning. The second flag only answers whether an entry could
   * widen it.
   */
  const offending = rule.targetsApplicationUnderTest
    ? pinned.addresses.find((candidate) => !policy.permittedClasses.includes(candidate.class))
    : /*
       * The FIRST non-public address, which is the same choice `nonPublic`
       * below makes, so a split answer decides identically whichever order the
       * zone's owner sends the records in.
       */
      pinned.addresses.find((candidate) => candidate.class !== 'public');

  if (!offending) {
    const nonPublic = pinned.addresses.find((candidate) => candidate.class !== 'public');
    return {
      ...base,
      allowed: true,
      outcome: 'ALLOWED',
      /*
       * THE LEAST PUBLIC ADDRESS IN THE SET, NOT THE FIRST ONE.
       *
       * This field used to read `pinned.addresses[0]?.class`, which is the
       * class of whichever address the resolver happened to list first — and a
       * record set's ORDER is chosen by whoever runs the zone. That made the
       * field two facts in one: `detail` and `warning` directly below both
       * describe `nonPublic`, while `decidedByClass` described address zero, so
       * for a split answer the three disagreed about the same decision.
       *
       * It is a live hole and not a cosmetic one, because the third-party
       * context rule in `egress-guard.ts` (`guardUrl`, the one that keeps
       * WEBHOOK_DELIVERY, TRACKER_CALL, SSO_METADATA and DOCUMENT_FETCH off
       * private addresses in every deployment) branches on EXACTLY this field.
       * MEASURED on a SELF_HOSTED policy, which permits `private`: a webhook
       * host answering [93.184.216.34, 10.0.0.5] reported class `public`, the
       * context rule did not fire, and the permit handed the caller a pin that
       * INCLUDED 10.0.0.5 — `assertConnectingTo(decision, '10.0.0.5')` returned
       * ok. Reversing the two A records refused it. A control an attacker
       * switches off by reordering their own DNS answer is not a control.
       *
       * `offending` above already scans EVERY address rather than the first for
       * the same reason; this is that rule applied to the field the decision is
       * reported through.
       */
      decidedByClass: nonPublic?.class ?? pinned.addresses[0]?.class ?? null,
      allowlistedBy: allowlisted?.host ?? null,
      pinned,
      detail:
        nonPublic === undefined
          ? `${pinned.host} resolves only to public addresses.`
          : `${pinned.host} resolves to ${nonPublic.address}, a ${nonPublic.class} address, which this deployment permits.`,
      warning:
        nonPublic !== undefined && policy.deployment === 'SELF_HOSTED'
          ? SELF_HOSTED_EGRESS_WARNING
          : null,
    };
  }

  const withClass = { ...base, decidedByClass: offending.class };

  if (!rule.targetsApplicationUnderTest) {
    /*
     * The third-party contexts. There is no deployment in which delivering a
     * webhook or fetching SSO metadata legitimately reaches a private address,
     * so this is refused ahead of NOT_ALLOWLISTED — "add it to the allowlist"
     * would be advice to build an SSRF with paperwork.
     *
     * AHEAD OF THE ALLOWLIST BRANCH, which is a reordering and not a behaviour
     * change: `allowlistEntryFor` already returns null for a context whose
     * `allowlistApplies` is false, so `allowlisted` cannot be set here for any
     * of today's four. It is ordered this way so that the refusal does not
     * depend on two separate flags agreeing — an eighth context declared
     * `targetsApplicationUnderTest: false` with `allowlistApplies: true` would
     * otherwise be widened by an entry, which is the thing the sentence in
     * `EgressContextRule.allowlistApplies` says may never happen.
     */
    return refuse(
      withClass,
      'CONTEXT_NOT_PERMITTED',
      `Refusing ${pinned.host}: it resolves to ${offending.address}, a ${offending.class} ` +
        `address, and ${context} (${rule.what}) may never reach one — ` +
        'not in any deployment and not through the allowlist.',
    );
  }

  if (allowlisted) {
    return {
      ...withClass,
      allowed: true,
      outcome: 'ALLOWED',
      allowlistedBy: allowlisted.host,
      pinned,
      detail:
        `${pinned.host} resolves to ${offending.address}, a ${offending.class} address, which ` +
        `this deployment does not permit by default. It is allowlisted by ${allowlisted.ownerEmail}: ` +
        allowlisted.reason,
      warning: null,
    };
  }

  if (NEVER_PERMITTED_BY_DEFAULT.includes(offending.class)) {
    return refuse(
      withClass,
      'NOT_ALLOWLISTED',
      `Refusing ${pinned.host}: it resolves to ${offending.address}, a ${offending.class} ` +
        'address. No deployment permits that class by default — 169.254.169.254 is the cloud ' +
        'metadata service in every cloud — so it needs an allowlist entry with an owner.',
    );
  }

  return refuse(
    withClass,
    'CLASS_NOT_PERMITTED',
    `Refusing ${pinned.host}: it resolves to ${offending.address}, a ${offending.class} address, ` +
      `and this ${policy.deployment} deployment permits ${policy.permittedClasses.join(', ')}.`,
  );
}

// ─── The socket-time check ──────────────────────────────────────────────────

/**
 * IS THIS THE ADDRESS WE DECIDED ABOUT?
 *
 * Called with the address the socket is actually about to open. This is the
 * half that turns a check into a pin, and it is the half that is normally
 * missing: everything above it is defeated by a second DNS lookup, so a caller
 * that does not reach this function has not applied the control.
 *
 * Two distinct refusals, because they are two distinct bugs. `RESOLUTION_NOT_PINNED`
 * means the decision carried no pin — the caller is connecting on the strength
 * of a refusal, or of an observed refusal, or of nothing. `PINNED_SET_CHANGED`
 * means the name now answers with an address that was never classified, which
 * is rebinding whether or not anybody meant it.
 */
export function assertConnectingTo(
  decision: EgressDecision,
  address: string,
): { readonly ok: true } | { readonly ok: false; readonly refusal: EgressRefusal; readonly detail: string } {
  if (decision.pinned === null) {
    return {
      ok: false,
      refusal: 'RESOLUTION_NOT_PINNED',
      detail:
        `The egress decision for ${decision.host} authorised no addresses (outcome ` +
        `${decision.outcome}), so there is nothing to connect to. Connecting by name here would ` +
        'resolve it a second time and bypass the check entirely.',
    };
  }
  if (!decision.pinned.addresses.some((pinned) => pinned.address === address)) {
    return {
      ok: false,
      refusal: 'PINNED_SET_CHANGED',
      detail:
        `${decision.host} was classified as ${decision.pinned.addresses
          .map((pinned) => pinned.address)
          .join(', ')} and the connection is being opened to ${address}, which nothing ` +
        'classified. That is DNS rebinding, whether or not anybody intended it.',
    };
  }
  return { ok: true };
}

// ─── The count ──────────────────────────────────────────────────────────────

/**
 * ONE BUCKET OF COUNTED DECISIONS. Rule 13's other half: a mode that does not
 * count is an off switch with a reassuring name.
 *
 * Keyed on (context, outcome, class) and nothing finer. A row per connection
 * would be an inventory of every internal hostname a crawl touched, which is
 * both unbounded and the thing an attacker would most like to read; the HOST
 * belongs on the persisted tally where an operator needs it to write an
 * allowlist entry, and the write path is responsible for capping distinct hosts
 * per bucket (see `EgressDecisionTally` in schema.prisma).
 */
export interface EgressTally {
  readonly context: EgressContext;
  readonly outcome: EgressOutcome;
  /** Null when no address was classified — an unresolvable name, an ambiguous literal. */
  readonly addressClass: AddressClass | null;
  readonly refusal: EgressRefusal | null;
  readonly count: number;
}

/** The identity of a tally bucket. One definition, so two writers cannot disagree. */
export function tallyKey(decision: EgressDecision): string {
  return [
    decision.context,
    decision.outcome,
    decision.decidedByClass ?? 'none',
    decision.refusal ?? 'none',
  ].join('\u001f');
}

/**
 * Add one decision to a tally map.
 *
 * EVERY decision, not only the refusals. "We would have refused 1,204
 * connections" is only interesting beside how many there were, and a count of
 * refusals with no denominator is the kind of number that gets quoted at a
 * customer and cannot be defended.
 */
export function countEgress(
  into: Map<string, EgressTally>,
  decision: EgressDecision,
): Map<string, EgressTally> {
  const key = tallyKey(decision);
  const existing = into.get(key);
  into.set(key, {
    context: decision.context,
    outcome: decision.outcome,
    addressClass: decision.decidedByClass,
    refusal: decision.refusal,
    count: (existing?.count ?? 0) + 1,
  });
  return into;
}

/** How many connections enforcement would have stopped, out of how many there were. */
export function wouldHaveRefused(tallies: Iterable<EgressTally>): {
  readonly wouldRefuse: number;
  readonly refused: number;
  readonly allowed: number;
  readonly total: number;
} {
  let wouldRefuse = 0;
  let refused = 0;
  let allowed = 0;
  for (const tally of tallies) {
    if (tally.outcome === 'WOULD_REFUSE') wouldRefuse += tally.count;
    else if (tally.outcome === 'REFUSED') refused += tally.count;
    else allowed += tally.count;
  }
  return { wouldRefuse, refused, allowed, total: wouldRefuse + refused + allowed };
}
