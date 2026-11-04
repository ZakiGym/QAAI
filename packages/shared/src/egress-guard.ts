/**
 * THE WRAPPER EVERY OUTBOUND PATH CALLS, AND THE ADDRESS IT HANDS BACK.
 *
 * ─── WHAT EXISTS ABOVE THIS FILE, AND THE ONE THING IT CANNOT DO ────────────
 *
 * `private-address.ts` CLASSIFIES a host. `egress.ts` applies a POLICY to a
 * classified host and records a DECISION with a pinned address set. Both are
 * good and both are about ONE HOST.
 *
 * A caller does not have a host. A caller has a URL, a scheme, a port, a
 * userinfo field, and — the part that gets people — a REDIRECT. Everything
 * above this file is defeated by a 302, because `decideEgress` was asked about
 * `example.com` and the connection ends up at `169.254.169.254`. That is not an
 * exotic bypass; it is how most real SSRF gets in, because it needs no control
 * over DNS and no race — just a page on the public internet that answers
 * `Location: http://169.254.169.254/latest/meta-data/`.
 *
 * So this file is the part that turns a host decision into a CONNECTION
 * decision: parse, refuse the schemes and the userinfo, decide, and then decide
 * AGAIN at every hop, with a cap that is REPORTED when it bites.
 *
 * ─── WHY IT HAS NO NODE IMPORT AND NO TRANSPORT ─────────────────────────────
 *
 * Same reason `egress.ts` has none, stated there at length: `private-address.ts`
 * reaches for `node:dns`, and anything the web app's bundler consumes may not.
 * This file imports `private-address.ts` TYPE-ONLY and takes the classifier,
 * the resolver, the clock and the SLEEP as {@link EgressGuardIo} — so a unit
 * test drives a six-hop redirect chain through a public host, a loopback host
 * and the metadata address without a socket, a resolver or a real millisecond.
 *
 * It also has no transport. {@link guardRedirectChain} takes a {@link HopFn}
 * and hands it a {@link EgressPermit}, never a URL string. That is deliberate
 * and it is the whole ergonomic argument of this file: the easy thing to do
 * with a permit is to read its pinned addresses, and the thing a caller CANNOT
 * do is receive a bare URL and connect to it by name.
 *
 * ─── THE PINNING, WHICH IS THE SUBSTANCE ───────────────────────────────────
 *
 * `resolvesPublicly` says of itself that it is a CHECK and not a PIN, and the
 * four production callers that use it today (`apps/api/src/lib/pull-request.ts`,
 * `apps/api/src/routes/api-surface.ts` twice, `packages/runner/src/preflight.ts`
 * and `packages/runner/src/plugins/email.ts`) all inherit that limitation and
 * all say so. Checking the name and letting the stack resolve it again is a
 * control a one-second TTL walks through.
 *
 * {@link EgressPermit} closes it, and the three adapters below are the point of
 * this file rather than an afterthought:
 *
 *   {@link pinnedLookup}              a `lookup` for a Node http/https Agent
 *   {@link chromiumHostResolverRules} the `--host-resolver-rules` the browser needs
 *   {@link pinnedRequestTarget}       the IP-form URL with the Host header kept
 *
 * The third one is HTTP-ONLY and refuses to produce an https target, and that
 * refusal is not timidity: rewriting `https://app.example.com/` to
 * `https://93.184.216.34/` changes the SNI name and the certificate the peer
 * presents, so it either fails verification or — far worse — gets "fixed" by
 * somebody disabling verification, which trades an SSRF for a MITM. For https
 * the answer is `pinnedLookup` (Node) or `chromiumHostResolverRules` (browser),
 * both of which pin the ADDRESS while leaving the NAME intact.
 *
 * ─── THE THIRD-PARTY CONTEXT RULE, AND WHERE IT LIVES NOW ──────────────────
 *
 * IT LIVES IN THE POLICY. `decidePinned` in `egress.ts` permits a third-party
 * context — WEBHOOK_DELIVERY, TRACKER_CALL, SSO_METADATA, DOCUMENT_FETCH —
 * `public` AND NOTHING ELSE, whatever the deployment's class list says, so
 * `decideEgress` refuses `10.0.0.5` for all four on its own. The copy of the
 * rule in {@link guardUrl} is now DEFENCE IN DEPTH and is no longer
 * load-bearing; its arm says so.
 *
 * It is worth knowing why it was here first, because the shape recurs. For one
 * round this file was the ONLY enforcing caller: `decidePinned` consulted the
 * context only after an address had already failed `permittedClasses`, and a
 * SELF_HOSTED policy permits `private`, so all four contexts came back ALLOWED
 * for an internal host and `EGRESS_CONTEXT_RULES`'s own sentence — "they are
 * refused in both modes" — was a doc comment contradicting the code under it.
 * A rule enforced at one caller is a rule the next caller does not get: this
 * round adds `decideEgress` callers for Jira, SSO and webhooks, each of them a
 * third-party context, and each would have landed in that hole.
 *
 * ADVERSARIAL RE-MEASUREMENT, 2026-10-30, kept because it is the sharper
 * lesson. While the rule was enforced HERE it was also SWITCHABLE FROM
 * OUTSIDE, and the hole was in the field it reads rather than in the branch.
 * `decidePinned` set `decidedByClass` from `pinned.addresses[0]` — address ZERO
 * of a record set whose ORDER belongs to whoever runs the zone. So on
 * SELF_HOSTED a host answering [93.184.216.34, 10.0.0.5] reported class
 * `public`, this branch did not fire, and the PINNED permit handed the caller
 * both addresses: `assertConnectingTo(decision, '10.0.0.5')` returned ok.
 * Reversing the two records refused it. A compensating control that reads one
 * field of somebody else's decision inherits every way that field can be
 * wrong, which is the argument for the rule living in the decision.
 *
 * ─── NOT AN ORACLE, AND WHAT THAT HONESTLY BUYS ────────────────────────────
 *
 * Two different leaks, handled separately, because conflating them is how one
 * of them gets missed.
 *
 * THE MESSAGE. {@link refusalForCaller} returns {@link EGRESS_REFUSAL_SENTENCE}
 * and NOTHING ELSE — no host, no address class, no refusal code, no hop number,
 * no cap. "that is a loopback address", "that host did not resolve" and "that
 * redirect left the allowlist" are three different facts about the inside of a
 * network, and a typed code is as much of a tell as a sentence. The operator's
 * copy (`operatorDetail`, the tallies) says all of it, inside the install.
 *
 * THE CLOCK. A refusal that happens in 0.2ms when the policy refuses the class
 * and in 90ms when the resolver has to answer tells an attacker whether an
 * internal name exists, whatever the message says. {@link EGRESS_REFUSAL_FLOOR_MS}
 * pads EVERY refusal to one floor through `io.delay`, and the floor is above a
 * normal resolver round trip so the padded paths are indistinguishable.
 *
 * What that honestly buys, because overstating it would be worse than not doing
 * it: it is a FLOOR, not constant time. A refusal that takes LONGER than the
 * floor — a resolver that times out at three seconds — still stands out, and
 * the remedy for that one is a resolver timeout shorter than the floor, which
 * belongs to the caller that owns the resolver. And ALLOWED is deliberately NOT
 * padded, because an attacker who is allowed through learns that from the
 * response body; the leak worth closing is the one BETWEEN TWO REFUSALS.
 * `egress-guard.test.ts` measures the pad rather than assuming it.
 */

import {
  EGRESS_CONTEXT_RULES,
  EGRESS_REFUSALS,
  EGRESS_REFUSAL_SENTENCE,
  assertConnectingTo,
  decideEgress,
} from './egress';
import type {
  EgressContext,
  EgressDecision,
  EgressIo,
  EgressOutcome,
  EgressPolicy,
  EgressRefusal,
  PinnedResolution,
} from './egress';
/*
 * TYPE-ONLY. A value import would put `node:dns` into the cockpit's bundle
 * through the barrel — the hazard `private-address.ts` and `egress.ts` both
 * write down, and the one `scripts/check-wiring.ts` once recommended creating.
 */
import type { AddressClass } from './private-address';

// ─── What a URL can be refused for, before any host is decided ──────────────

/**
 * The refusals that belong to the URL and to the CHAIN rather than to the host.
 *
 * None of these can be expressed as an {@link EgressRefusal}, and that is why
 * the union below is wider rather than these being squeezed into
 * `CLASS_NOT_PERMITTED`: a URL that does not parse has NO HOST, so recording it
 * as a class refusal would mean inventing a host for the tally — a measured
 * value that was never measured, which is the first of the lies this product
 * cannot afford.
 *
 * `REDIRECT_CAP` is the one with an extra obligation attached. A cap that is
 * applied without being counted and reported is the third lie on that list, so
 * {@link EgressChain} carries `cap` and `cappedAtHop` and the chain's tally
 * records it like any other refusal.
 */
export const EGRESS_GUARD_REFUSALS = [
  /** `new URL()` threw. Not a URL this product will guess at. */
  'URL_UNPARSEABLE',
  /** Not http or https. `file:`, `gopher:` and `data:` are not pages. */
  'SCHEME_NOT_PERMITTED',
  /**
   * `http://user:pass@host/`. The userinfo is a credential heading for a log,
   * a progress event and a tally label, and `http://trusted.example.com@10.0.0.1/`
   * is the oldest confusion in the list.
   */
  'CREDENTIALS_IN_URL',
  /** A redirect chain longer than the cap. Reported with the cap — see the type. */
  'REDIRECT_CAP',
  /** A hop pointed back at an origin the chain already visited. */
  'REDIRECT_LOOP',
  /** A 3xx with no `Location`. We do not guess where it meant. */
  'REDIRECT_NO_LOCATION',
  /** A `Location` that is not a URL, absolute or relative to the hop. */
  'REDIRECT_UNRESOLVABLE',
  /**
   * `https://` → `http://`. Refused for EVERY context, and the cost is stated
   * rather than hidden: a self-hosted app that genuinely redirects its own
   * https to http becomes uncrawlable past that hop, and the remedy is to point
   * the environment at the http origin directly rather than to widen this.
   * The reason it is not negotiable is that QAAI's LOGIN context TYPES VAULT
   * PLAINTEXT into whatever answers the end of the chain, and a downgrade is an
   * invitation to read it off the wire.
   */
  'SCHEME_DOWNGRADE',
] as const;
export type EgressGuardRefusal = (typeof EGRESS_GUARD_REFUSALS)[number];

/** Every reason this file declines to open a connection, host-level and URL-level. */
export type GuardRefusal = EgressRefusal | EgressGuardRefusal;

/**
 * The compiler-enforced presence record over the WHOLE union.
 *
 * A `Record<GuardRefusal, …>` cannot be written without naming every member, so
 * a tenth guard refusal is a type error here rather than a refusal with no
 * operator sentence — and a refusal read through `undefined` would print
 * `undefined` to an operator at the one moment they need to know what happened.
 *
 * Both halves, because one without the other passes while the two disagree:
 * this is the compile-time half and `egress-guard.test.ts` holds the run-time
 * half, which checks that the keys are exactly `EGRESS_REFUSALS` plus
 * `EGRESS_GUARD_REFUSALS` with nothing extra and nothing missing.
 */
export const GUARD_REFUSAL_RULES = {
  CLASS_NOT_PERMITTED: { urlLevel: false, what: 'the host classified as a class this deployment does not reach' },
  AMBIGUOUS_HOST: { urlLevel: false, what: 'the host is an IP address written in a form QAAI will not guess at' },
  UNRESOLVED: { urlLevel: false, what: 'the name did not resolve' },
  NO_ADDRESSES: { urlLevel: false, what: 'the name resolved to no addresses' },
  NOT_ALLOWLISTED: { urlLevel: false, what: 'the class needs an owned allowlist entry and has none' },
  CONTEXT_NOT_PERMITTED: { urlLevel: false, what: 'this context may never reach a private address' },
  RESOLUTION_NOT_PINNED: { urlLevel: false, what: 'the caller held no pinned address set' },
  PINNED_SET_CHANGED: { urlLevel: false, what: 'the connection address was never classified' },
  POLICY_UNRESOLVED: { urlLevel: false, what: 'no egress policy could be resolved' },
  URL_UNPARSEABLE: { urlLevel: true, what: 'the URL did not parse' },
  SCHEME_NOT_PERMITTED: { urlLevel: true, what: 'the scheme is not http or https' },
  CREDENTIALS_IN_URL: { urlLevel: true, what: 'the URL carried a username or password' },
  REDIRECT_CAP: { urlLevel: true, what: 'the redirect chain was longer than the cap' },
  REDIRECT_LOOP: { urlLevel: true, what: 'a hop returned to an origin the chain had visited' },
  REDIRECT_NO_LOCATION: { urlLevel: true, what: 'a 3xx carried no Location header' },
  REDIRECT_UNRESOLVABLE: { urlLevel: true, what: 'a Location header was not a resolvable URL' },
  SCHEME_DOWNGRADE: { urlLevel: true, what: 'a hop redirected from https to http' },
} as const satisfies Record<GuardRefusal, { readonly urlLevel: boolean; readonly what: string }>;

/** The two schemes a page can be fetched over. Everything else is not a page. */
export const EGRESS_SCHEMES = ['http:', 'https:'] as const;
export type EgressScheme = (typeof EGRESS_SCHEMES)[number];

/**
 * How many hops a chain may take before it is refused AND REPORTED.
 *
 * Five, matching what browsers and `fetch` settle on in practice. A cap this
 * low is also the cheapest defence against a chain that is itself the attack:
 * an endpoint that answers every request with a 302 to itself-plus-one costs
 * nothing to write and a crawl's whole budget to follow.
 */
export const DEFAULT_REDIRECT_CAP = 5;

/**
 * The floor every refusal is padded to, in milliseconds.
 *
 * Above a normal resolver round trip on purpose: the pair this closes is
 * "refused by policy without resolving" (sub-millisecond) against "did not
 * resolve" (one resolver round trip), and a floor between the two would leave
 * the tell intact. See the module header for what a floor does and does not
 * buy — it is not constant time and this file does not claim to be.
 */
export const EGRESS_REFUSAL_FLOOR_MS = 250;

// ─── The parsed target ──────────────────────────────────────────────────────

/**
 * A URL reduced to the parts that may be recorded.
 *
 * NO PATH, NO QUERY AND NO FRAGMENT, and this is not tidiness. For a webhook
 * the path IS the bearer credential — `private-address.ts` says so where it
 * builds its refusal reason — and for a redirect to an identity provider the
 * query carries the tenant, a user hint and a state token, which is the reason
 * `frontier.ts` records an external's origin and path and never its query. A
 * guard that is called on every outbound request in the product is the last
 * place that should be assembling a log line out of someone's credentials.
 */
export interface GuardedTarget {
  readonly scheme: EgressScheme;
  /** Normalised: lower-case, no trailing dot, no port, no brackets stripped. */
  readonly host: string;
  /** The explicit port, or '' when the URL used the scheme's default. */
  readonly port: string;
  /** `scheme//host:port`. The only rendering of a URL this file will emit. */
  readonly origin: string;
}

// ─── The permit ─────────────────────────────────────────────────────────────

/**
 * PERMISSION TO CONNECT, AND TO WHAT EXACTLY.
 *
 * Two members, because an OBSERVE-mode pass and an ENFORCE-mode pass are not
 * the same permission and a single shape would have made them look like one.
 *
 * PINNED carries the addresses. The caller connects to those and to nothing
 * else; {@link pinnedLookup} and {@link chromiumHostResolverRules} are how.
 *
 * OBSERVED is the brake. The policy WOULD have refused this, the mode is
 * OBSERVE, so the connection happens exactly as it did before this control
 * existed — BY NAME, with the rebinding window open, because that is what
 * "observe" means. It carries NO PIN at all (`decideEgress` refuses to issue
 * one on an observed refusal, and the adapters below refuse an OBSERVED
 * permit), so no caller can claim a closed window for a connection nobody
 * authorised. It also carries `wouldRefuse`, so the count and the operator's
 * report can say which refusal was skipped.
 */
export type EgressPermit =
  | {
      readonly kind: 'PINNED';
      readonly context: EgressContext;
      readonly target: GuardedTarget;
      readonly decision: EgressDecision;
      readonly pinned: PinnedResolution;
      readonly wouldRefuse: null;
    }
  | {
      readonly kind: 'OBSERVED';
      readonly context: EgressContext;
      readonly target: GuardedTarget;
      /**
       * The POLICY's answer. Today it is always WOULD_REFUSE on an observed
       * permit — see `observedBy` below for the one arm that could make it
       * ALLOWED and why nothing reaches that arm any more.
       */
      readonly decision: EgressDecision;
      readonly pinned: null;
      readonly wouldRefuse: GuardRefusal;
      /**
       * WHICH DECIDER WOULD HAVE REFUSED, because there are two and they can
       * legitimately disagree.
       *
       * POLICY means `decideEgress` returned WOULD_REFUSE, so
       * `decision.outcome` is WOULD_REFUSE and the two agree. Since the
       * third-party-context rule moved into `decidePinned`, this is the only
       * value any path produces, and `egress-guard.test.ts` asserts that for
       * all four third-party contexts in both record orders.
       *
       * GUARD means `decideEgress` returned ALLOWED and the defence-in-depth
       * copy of the rule in {@link guardUrl} is what would have refused it —
       * the policy's answer beside the guard's, which is not a contradiction.
       * It was the real answer for one round, while the policy consulted the
       * context only after an address had already failed the deployment's class
       * list. The member is kept because that arm is kept: recording WHICH
       * decider refused is what stops the day they disagree again from being
       * two facts in one field, the way a `verified` flag in this codebase was
       * once true for a heal that left the test red.
       */
      readonly observedBy: 'POLICY' | 'GUARD';
    };

/**
 * The answer to "may I open this URL".
 *
 * `operatorDetail` is for the install's own eyes and names the host, the class
 * and the address. It MUST NOT reach a response body, a progress event, a
 * metric label or a tenant-visible ledger; {@link refusalForCaller} is what
 * goes there. For the CRAWL context that distinction is sharper than it looks,
 * because the tenant who set the base URL IS the adversary the control exists
 * for — see `packages/agent/src/crawl/egress.ts`.
 */
export type GuardVerdict =
  | { readonly ok: true; readonly permit: EgressPermit }
  | {
      readonly ok: false;
      readonly refusal: GuardRefusal;
      readonly operatorDetail: string;
      readonly context: EgressContext;
      /** Null when the refusal happened before a host was decided (a URL-level one). */
      readonly decision: EgressDecision | null;
      /** Null when no host was parsed at all. Never carries a path. */
      readonly target: GuardedTarget | null;
      /** How long the refusal was padded by, so a test can measure the floor. */
      readonly paddedMs: number;
    };

/**
 * WHAT A CALLER MAY SAY OUT LOUD. One sentence, no code, no host, no class.
 *
 * Returning an object rather than the bare string so that adding a second
 * field is a change somebody has to make on purpose and review; today there is
 * exactly one field and `egress-guard.test.ts` asserts that every one of the
 * seventeen refusals produces an identical object, which is the test that stops
 * a well-meant "more helpful" message being added at one call site.
 */
export function refusalForCaller(_verdict: GuardVerdict): { readonly sentence: string } {
  /*
   * The verdict is deliberately UNUSED. A function that branched on the refusal
   * is one edit away from being an oracle, and a parameter that is read is one
   * edit away from being branched on. It is in the signature because every call
   * site should be handed the verdict and get back only this.
   */
  return { sentence: EGRESS_REFUSAL_SENTENCE };
}

// ─── The injected world ─────────────────────────────────────────────────────

/**
 * Everything this file would otherwise reach for, injected.
 *
 * Extends the keystone's {@link EgressIo} — the classifier, the resolver and
 * the wall clock — with the two things a CHAIN and a TIMING FLOOR need. A
 * control that cannot be tested with a fake is a control nobody will trust, and
 * a timing control that cannot be tested with a fake clock is one nobody can
 * even measure.
 */
export interface EgressGuardIo extends EgressIo {
  /**
   * A monotonic millisecond counter, NOT the wall clock.
   *
   * `io.now()` is the wall clock and it is already spoken for: it stamps
   * `PinnedResolution.pinnedAt`, which is a recorded fact about when a decision
   * was made. Measuring an elapsed interval with it would be two facts in one
   * field, and worse, an NTP step backwards mid-refusal would make the elapsed
   * time negative, the pad negative, the pad therefore zero — and a refusal
   * that skipped its pad is the oracle this is here to close.
   */
  readonly monotonicMs: () => number;
  /** Sleep. Injected so the floor is measurable without a real millisecond passing. */
  readonly delay: (ms: number) => Promise<void>;
}

// ─── One URL ────────────────────────────────────────────────────────────────

/** Split a URL into the parts that may be recorded, or say why it cannot be. */
function parseTarget(
  url: string,
): { ok: true; target: GuardedTarget } | { ok: false; refusal: EgressGuardRefusal; what: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, refusal: 'URL_UNPARSEABLE', what: 'it is not a URL this product can open' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    /*
     * Refused BEFORE the host is looked at, and the order matters. The reason
     * is not only that userinfo is a credential: `http://trusted.example.com@10.0.0.1/`
     * reads as a trusted host to a human and to every log line, and the WHATWG
     * parser correctly calls the host `10.0.0.1`. Refusing the shape outright
     * means nobody downstream has to be right about which half is the host.
     */
    return {
      ok: false,
      refusal: 'CREDENTIALS_IN_URL',
      what: 'it carried a username or password in the URL',
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      refusal: 'SCHEME_NOT_PERMITTED',
      what: `${parsed.protocol} is not a scheme QAAI fetches`,
    };
  }
  const scheme: EgressScheme = parsed.protocol === 'https:' ? 'https:' : 'http:';
  /*
   * `URL.hostname` strips the brackets off an IPv6 literal, and `classifyHost`
   * reads both forms. The bracketed form is kept for the ORIGIN only, because
   * that is what has to be re-assemblable into a URL.
   */
  const host = parsed.hostname.trim().toLowerCase().replace(/\.+$/, '');
  /*
   * The origin is REBUILT from the normalised host and NOT taken from
   * `URL.origin`, because `URL.origin` keeps a trailing dot:
   * `http://example.com./` has origin `http://example.com.` while
   * `http://example.com/` has `http://example.com`. The chain's loop detector
   * keys on this string, so taking the parser's spelling would let a redirect
   * alternate between the two forms forever — caught by the cap, but caught by
   * the wrong rule, and a loop reported as a cap is a cap that did not bite.
   */
  const origin = parsed.port === '' ? `${scheme}//${host}` : `${scheme}//${host}:${parsed.port}`;
  return { ok: true, target: { scheme, host, port: parsed.port, origin } };
}

/** How long a refusal must sleep for to land on the floor. Never negative. */
function padFor(io: EgressGuardIo, startedAt: number, floorMs: number): number {
  const elapsed = io.monotonicMs() - startedAt;
  if (!Number.isFinite(elapsed)) return floorMs;
  const pad = floorMs - elapsed;
  // Clamped at zero: a refusal that already took longer than the floor is not
  // sped up, and a clock that went backwards does not produce a negative sleep.
  return pad > 0 ? pad : 0;
}

/**
 * MAY WE OPEN THIS URL, AND TO WHICH ADDRESS.
 *
 * The single-hop guard. {@link guardRedirectChain} is this function applied at
 * every hop, which is the only correct way to treat a redirect: a public URL
 * that answers `Location: http://169.254.169.254/` has not been made safe by
 * the decision that was made about the public URL.
 *
 * FAILS CLOSED AT EVERY STEP. There is no arm of this function that returns a
 * permit on an exception — `decideEgress` refuses an ambiguous host, a failed
 * lookup, an empty answer and a thrown resolver, and everything above it here
 * refuses before a host is even derived.
 */
export async function guardUrl(input: {
  readonly url: string;
  readonly context: EgressContext;
  readonly policy: EgressPolicy;
  readonly io: EgressGuardIo;
  /** Override for a caller with a resolver slower than the default floor. */
  readonly floorMs?: number;
}): Promise<GuardVerdict> {
  const { context, policy, io } = input;
  const floorMs = input.floorMs ?? EGRESS_REFUSAL_FLOOR_MS;
  const startedAt = io.monotonicMs();

  const refuse = async (
    refusal: GuardRefusal,
    operatorDetail: string,
    target: GuardedTarget | null,
    decision: EgressDecision | null,
  ): Promise<GuardVerdict> => {
    const paddedMs = padFor(io, startedAt, floorMs);
    if (paddedMs > 0) await io.delay(paddedMs);
    return { ok: false, refusal, operatorDetail, context, decision, target, paddedMs };
  };

  const parsed = parseTarget(input.url);
  if (!parsed.ok) {
    return refuse(parsed.refusal, `Refusing a ${context} connection: ${parsed.what}.`, null, null);
  }
  const target = parsed.target;

  const decision = await decideEgress({ context, host: target.host, policy, io });

  if (decision.outcome === 'REFUSED') {
    return refuse(decision.refusal ?? 'CLASS_NOT_PERMITTED', decision.detail, target, decision);
  }

  if (decision.outcome === 'WOULD_REFUSE') {
    /*
     * The brake, and the ONE place it turns a refusal into a counted pass.
     * `decideEgress` already decided that; this arm only has to not invent a
     * pin, and the type makes that impossible rather than merely unlikely.
     */
    return {
      ok: true,
      permit: {
        kind: 'OBSERVED',
        context,
        target,
        decision,
        pinned: null,
        wouldRefuse: decision.refusal ?? 'CLASS_NOT_PERMITTED',
        observedBy: 'POLICY',
      },
    };
  }

  /*
   * ─── THE THIRD-PARTY-CONTEXT RULE: DEFENCE IN DEPTH, NOT LOAD-BEARING ──────
   *
   * `decidePinned` in egress.ts now applies this rule itself — a third-party
   * context is permitted `public` and nothing else, whatever the deployment's
   * class list says — so `decideEgress` returns REFUSED (or WOULD_REFUSE in
   * OBSERVE) before this branch is reached, and the two arms above are what
   * answer today. This branch is UNREACHABLE THROUGH `decideEgress` as a
   * result, and it stays for two reasons rather than out of sentiment: a future
   * widening of `permittedClasses` or of `EGRESS_CONTEXT_RULES` would meet it
   * on the way out, and a permit is the only thing in this file that hands a
   * caller an address to connect to, so the last word on "may this context
   * reach that class" belongs beside the permit as well as in the policy.
   *
   * The history is in the module header and is worth reading before anyone
   * deletes it: for one round this WAS the enforcement, because the policy
   * reached the context rule only after an address had already failed the class
   * list and a SELF_HOSTED policy permits `private` — so all four third-party
   * contexts answered ALLOWED for `http://10.0.0.5:6379/`.
   *
   * THE MODE IS HONOURED rather than overridden, for the same reason as in the
   * policy: a self-hosted install delivering a webhook to an internal endpoint
   * is traffic that works today, and taking it away without a brake would be
   * the silent behaviour change rule 13 forbids. `observedBy: 'GUARD'` records
   * that this branch and not the policy is what would have refused it — which
   * is now a fact no path produces, and that is the point of recording it
   * rather than inferring it.
   */
  if (
    !EGRESS_CONTEXT_RULES[context].targetsApplicationUnderTest &&
    decision.decidedByClass !== null &&
    decision.decidedByClass !== 'public'
  ) {
    const detail =
      `Refusing ${target.host}: it resolves to a ${decision.decidedByClass} address, and ` +
      `${context} (${EGRESS_CONTEXT_RULES[context].what}) may never reach one — not in any ` +
      'deployment and not through the allowlist.';
    if (policy.mode === 'ENFORCE') {
      return refuse('CONTEXT_NOT_PERMITTED', detail, target, decision);
    }
    return {
      ok: true,
      permit: {
        kind: 'OBSERVED',
        context,
        target,
        decision,
        pinned: null,
        wouldRefuse: 'CONTEXT_NOT_PERMITTED',
        observedBy: 'GUARD',
      },
    };
  }

  if (decision.pinned === null) {
    /*
     * ALLOWED with no pin. `decideEgress` does not produce this today — every
     * ALLOWED arm sets `pinned` — and that is exactly why it is handled: the
     * day it does, the safe reading is a refusal, not a permit whose `pinned`
     * is `null` and whose adapters then quietly connect by name. An exception
     * arm that falls through to "allow" is the defect pattern this round hunts,
     * and so is a success arm that falls through to "unpinned".
     */
    return refuse(
      'RESOLUTION_NOT_PINNED',
      `${target.host} was allowed with no pinned address set, so there is nothing to connect to.`,
      target,
      decision,
    );
  }

  return {
    ok: true,
    permit: { kind: 'PINNED', context, target, decision, pinned: decision.pinned, wouldRefuse: null },
  };
}

// ─── The chain ──────────────────────────────────────────────────────────────

/** What one hop did, with no path and no query — see {@link GuardedTarget}. */
export interface EgressChainHop {
  /** 0 for the URL the caller asked for. */
  readonly index: number;
  readonly origin: string;
  /** Null when the hop was refused before a permit existed. */
  readonly permit: EgressPermit | null;
  /** The transport's status, or null when the hop never ran. */
  readonly status: number | null;
  /** The origin this hop redirected to, or null when it did not redirect. */
  readonly redirectedTo: string | null;
}

/** One 3xx (or not), as the injected transport reports it. */
export interface RedirectHop {
  readonly status: number;
  /** Absolute or relative to the hop's URL. Null when the response had none. */
  readonly location: string | null;
}

/**
 * The transport, injected, and it is handed a PERMIT and never a URL.
 *
 * That signature is the ergonomic half of this control. A caller holding a
 * permit has the pinned addresses right there and {@link pinnedLookup} one line
 * away; a caller handed a URL string would have to go out of its way to pin,
 * and in four rounds of this codebase the thing nobody does is the extra step.
 */
export type HopFn = (permit: EgressPermit) => Promise<RedirectHop>;

/**
 * WHAT THE WHOLE CHAIN DID, INCLUDING THE CAP.
 *
 * `cap` and `cappedAtHop` are both here because a cap that applied without
 * being reported is one of the lies this product cannot afford, and because the
 * two are different facts: `cap` is the limit that was in force (always), and
 * `cappedAtHop` is non-null EXACTLY when the cap is what stopped the chain. A
 * single nullable integer would have conflated "the cap was five" with "the cap
 * bit at five".
 */
export interface EgressChain {
  readonly ok: boolean;
  readonly hops: readonly EgressChainHop[];
  /** Null exactly when `ok` is true. */
  readonly refusal: GuardRefusal | null;
  /** For the install's own eyes. Never a response, a progress event or a tenant ledger. */
  readonly operatorDetail: string;
  readonly cap: number;
  /** Non-null exactly when `refusal` is `REDIRECT_CAP`. */
  readonly cappedAtHop: number | null;
  /** The permit for the final hop, when the chain finished. */
  readonly final: EgressPermit | null;
  /** EVERY decision on the chain, allowed ones included. See {@link countGuard}. */
  readonly tallies: readonly GuardTally[];
}

/**
 * FOLLOW A REDIRECT CHAIN, DECIDING AT EVERY HOP.
 *
 * ── Why every hop and not just the first ───────────────────────────────────
 *
 * Because the first hop is the one the attacker gives away. `example.com` is
 * public, resolves public and passes; its 302 to `http://169.254.169.254/` is
 * the request that actually happens. Guarding the first URL and following the
 * rest is not a weaker version of this control, it is the absence of it.
 *
 * ── What stops a chain ─────────────────────────────────────────────────────
 *
 *   • any hop's own egress decision (public→private, public→loopback, →IMDS)
 *   • an origin the chain has already visited — a loop
 *   • https→http, for every context; see `SCHEME_DOWNGRADE`
 *   • the cap, which is REPORTED with `cap` and `cappedAtHop`
 *   • a 3xx with no Location, or a Location that will not resolve
 *
 * A port change is NOT on that list and the omission is deliberate: a hop to a
 * different port on the same host gets a FRESH decision and a FRESH pin, which
 * is the correct treatment, but the egress policy is about address CLASSES and
 * a port is not one. So in a SELF_HOSTED deployment, which permits `private`,
 * `http://app.internal/` redirecting to `http://app.internal:5432/` IS followed
 * — exactly as `http://app.internal:5432/` would have been if it were typed in.
 * `egress-guard.test.ts` asserts that as measured behaviour rather than
 * implying otherwise, and the remedy available to an operator is to narrow
 * `permittedClasses`, which is the direction a stored policy may always move.
 */
export async function guardRedirectChain(input: {
  readonly url: string;
  readonly context: EgressContext;
  readonly policy: EgressPolicy;
  readonly io: EgressGuardIo;
  readonly hop: HopFn;
  readonly cap?: number;
  readonly floorMs?: number;
}): Promise<EgressChain> {
  const cap = input.cap ?? DEFAULT_REDIRECT_CAP;
  const hops: EgressChainHop[] = [];
  const tallies = new Map<string, GuardTally>();
  const seen = new Set<string>();

  let url = input.url;
  let previousScheme: EgressScheme | null = null;

  const stop = (
    refusal: GuardRefusal,
    operatorDetail: string,
    cappedAtHop: number | null = null,
  ): EgressChain => ({
    ok: false,
    hops,
    refusal,
    operatorDetail,
    cap,
    cappedAtHop,
    final: null,
    tallies: [...tallies.values()],
  });

  for (let index = 0; ; index += 1) {
    if (index > cap) {
      /*
       * REPORTED, not silently truncated. `cappedAtHop` is what makes "the
       * chain was cut at five hops" a fact in the record rather than a
       * difference somebody notices in a byte count six months later.
       */
      const refusal: GuardRefusal = 'REDIRECT_CAP';
      countRefusal(tallies, input.context, refusal);
      return stop(
        refusal,
        `Refusing a ${input.context} connection: the redirect chain passed the cap of ${cap} hops ` +
          `at hop ${index}. An endpoint that answers every request with another redirect costs ` +
          'nothing to write and a whole crawl budget to follow.',
        index,
      );
    }

    const verdict = await guardUrl({
      url,
      context: input.context,
      policy: input.policy,
      io: input.io,
      ...(input.floorMs === undefined ? {} : { floorMs: input.floorMs }),
    });
    countGuard(tallies, verdict);

    if (!verdict.ok) {
      hops.push({
        index,
        origin: verdict.target?.origin ?? '(unparseable)',
        permit: null,
        status: null,
        redirectedTo: null,
      });
      return stop(verdict.refusal, verdict.operatorDetail);
    }

    const permit = verdict.permit;
    const origin = permit.target.origin;

    if (previousScheme === 'https:' && permit.target.scheme === 'http:') {
      const refusal: GuardRefusal = 'SCHEME_DOWNGRADE';
      countRefusal(tallies, input.context, refusal);
      hops.push({ index, origin, permit: null, status: null, redirectedTo: null });
      return stop(
        refusal,
        `Refusing a ${input.context} connection: hop ${index} redirected from https to http ` +
          `at ${origin}. QAAI's LOGIN context types vault plaintext into whatever answers the ` +
          'end of a chain, so a downgrade is not followed in any context.',
      );
    }

    if (seen.has(origin)) {
      const refusal: GuardRefusal = 'REDIRECT_LOOP';
      countRefusal(tallies, input.context, refusal);
      hops.push({ index, origin, permit, status: null, redirectedTo: null });
      return stop(
        refusal,
        `Refusing a ${input.context} connection: hop ${index} returned to ${origin}, which this ` +
          'chain had already visited.',
      );
    }
    seen.add(origin);
    previousScheme = permit.target.scheme;

    const response = await input.hop(permit);
    const redirecting = response.status >= 300 && response.status <= 399;

    if (!redirecting) {
      hops.push({ index, origin, permit, status: response.status, redirectedTo: null });
      return {
        ok: true,
        hops,
        refusal: null,
        operatorDetail: `${origin} answered ${response.status} after ${index} redirect(s).`,
        cap,
        cappedAtHop: null,
        final: permit,
        tallies: [...tallies.values()],
      };
    }

    if (response.location === null || response.location.trim() === '') {
      const refusal: GuardRefusal = 'REDIRECT_NO_LOCATION';
      countRefusal(tallies, input.context, refusal);
      hops.push({ index, origin, permit, status: response.status, redirectedTo: null });
      return stop(
        refusal,
        `Refusing a ${input.context} connection: ${origin} answered ${response.status} with no ` +
          'Location header, and QAAI does not guess where a redirect meant to go.',
      );
    }

    let next: string;
    try {
      // Resolved against the hop's own URL, because `Location: /admin` is legal
      // and common. The base is the URL we just connected to, not the original.
      next = new URL(response.location, url).toString();
    } catch {
      const refusal: GuardRefusal = 'REDIRECT_UNRESOLVABLE';
      countRefusal(tallies, input.context, refusal);
      hops.push({ index, origin, permit, status: response.status, redirectedTo: null });
      return stop(
        refusal,
        `Refusing a ${input.context} connection: ${origin} answered ${response.status} with a ` +
          'Location header that is not a resolvable URL.',
      );
    }

    const nextOrigin = parseTarget(next);
    hops.push({
      index,
      origin,
      permit,
      status: response.status,
      redirectedTo: nextOrigin.ok ? nextOrigin.target.origin : null,
    });
    url = next;
  }
}

// ─── The count ──────────────────────────────────────────────────────────────

/**
 * ONE BUCKET OF COUNTED GUARD DECISIONS.
 *
 * Widens the keystone's `EgressTally` in exactly one field — `refusal` is a
 * {@link GuardRefusal} rather than an `EgressRefusal` — because a redirect cap
 * and an unparseable URL have to be counted somewhere and the alternative was
 * recording them under a host-level reason they are not. `egress-guard.test.ts`
 * asserts the two unions nest, so a tally written here is still readable by
 * anything that understands the narrower one.
 *
 * Keyed on (context, outcome, class, refusal) and nothing finer, for the reason
 * the keystone gives: a row per connection would be an inventory of every
 * internal hostname a crawl touched, which is the thing an attacker would most
 * like to read.
 */
export interface GuardTally {
  readonly context: EgressContext;
  readonly outcome: EgressOutcome;
  /** Null when nothing was classified — an unparseable URL, a redirect cap. */
  readonly addressClass: AddressClass | null;
  readonly refusal: GuardRefusal | null;
  readonly count: number;
}

/** The identity of a bucket. One definition, so two writers cannot disagree. */
export function guardTallyKey(tally: Omit<GuardTally, 'count'>): string {
  return [
    tally.context,
    tally.outcome,
    tally.addressClass ?? 'none',
    tally.refusal ?? 'none',
  ].join('\u001f');
}

function add(into: Map<string, GuardTally>, tally: Omit<GuardTally, 'count'>): void {
  const key = guardTallyKey(tally);
  const existing = into.get(key);
  into.set(key, { ...tally, count: (existing?.count ?? 0) + 1 });
}

/**
 * Count one verdict.
 *
 * EVERY verdict, not only the refusals. "We would have refused 1,204
 * connections" is only interesting beside how many there were, and a refusal
 * count with no denominator is the kind of number that gets quoted at a
 * customer and cannot be defended.
 */
export function countGuard(
  into: Map<string, GuardTally>,
  verdict: GuardVerdict,
): Map<string, GuardTally> {
  if (verdict.ok) {
    const permit = verdict.permit;
    add(into, {
      context: permit.context,
      outcome: permit.kind === 'OBSERVED' ? 'WOULD_REFUSE' : 'ALLOWED',
      addressClass: permit.decision.decidedByClass,
      refusal: permit.wouldRefuse,
    });
    return into;
  }
  add(into, {
    context: verdict.context,
    /*
     * An OBSERVE-mode refusal never arrives here: `guardUrl` returns it as an
     * OBSERVED permit, counted WOULD_REFUSE above. A refusal that reached this
     * arm was enforced — except for the URL-level ones, which are refused in
     * both modes because there is no "observe" reading of a URL that does not
     * parse, and that is recorded as REFUSED rather than dressed up as a mode
     * decision.
     */
    outcome: 'REFUSED',
    addressClass: verdict.decision?.decidedByClass ?? null,
    refusal: verdict.refusal,
  });
  return into;
}

/** Count a chain-level refusal, which has no verdict of its own. */
function countRefusal(
  into: Map<string, GuardTally>,
  context: EgressContext,
  refusal: GuardRefusal,
): void {
  add(into, { context, outcome: 'REFUSED', addressClass: null, refusal });
}

/** How many connections enforcement stopped, would have stopped, and allowed. */
export function guardTotals(tallies: Iterable<GuardTally>): {
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

// ─── The pinned-connect adapters ────────────────────────────────────────────

/** One answer a `lookup` can give. Structural, so no `node:net` import. */
export interface PinnedLookupAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * Node's `lookup` option, written out structurally.
 *
 * Declared here rather than imported from `node:net` for the reason the whole
 * file gives: a type import would be harmless, but a file that imports from
 * `node:*` at all is one careless edit away from importing a value, and this
 * file is reachable from the cockpit's bundle.
 *
 * Both arities are honoured because Node calls both: `all: true` gets the array
 * form, anything else gets the single-address form. A `lookup` that answered
 * only one of them would silently fall back to the system resolver for the
 * other, which is the pin not applying — the exact failure this adapter exists
 * to prevent.
 */
export type PinnedLookup = (
  hostname: string,
  options: { readonly all?: boolean; readonly family?: number },
  callback: (
    err: Error | null,
    addressOrAddresses?: string | readonly PinnedLookupAddress[],
    family?: number,
  ) => void,
) => void;

/** 4 or 6, from the address itself. A pinned address is already classified. */
function familyOf(address: string): 4 | 6 {
  return address.includes(':') ? 6 : 4;
}

/**
 * A `lookup` FOR A NODE AGENT THAT ANSWERS ONLY THE PINNED ADDRESSES.
 *
 * This is the easy path, and the easy path is the point. Drop it into an
 * `http.Agent`/`https.Agent` (`new Agent({ lookup: pinnedLookup(permit) })`) and
 * the name is never resolved again: the SNI name, the Host header and the
 * certificate check all keep working, and the socket goes to an address that
 * was classified.
 *
 * REFUSES THREE THINGS, all of them by calling back with an error and never by
 * falling through to the system resolver:
 *
 *   • an OBSERVED permit, which authorised no addresses at all. A caller in
 *     observe mode connects the way it did before this control existed; it may
 *     not borrow a pin it was not given.
 *   • a hostname other than the one that was decided. An agent reused across
 *     two hosts would otherwise pin the second to the first's addresses.
 *   • a family the pin cannot satisfy — `family: 6` against an IPv4-only pin is
 *     an empty answer, and an empty answer from a lookup is a connection that
 *     silently does not happen rather than one that goes somewhere unclassified.
 */
export function pinnedLookup(permit: EgressPermit): PinnedLookup {
  return (hostname, options, callback) => {
    const fail = (message: string): void => {
      // An Error, never an empty success. A lookup that calls back with no
      // addresses and no error is a hang in some Node versions and a fallback
      // in others, and "it fell back" is the whole defect.
      callback(new Error(message));
    };

    if (permit.kind === 'OBSERVED') {
      return fail(
        'This egress permit is OBSERVED: the policy would have refused it and the mode is ' +
          'OBSERVE, so no address was authorised. Connect by name as before, or enforce.',
      );
    }

    const asked = hostname.trim().toLowerCase().replace(/\.+$/, '');
    if (asked !== permit.pinned.host) {
      return fail(
        `This egress permit pinned ${permit.pinned.host} and the socket asked for ${asked}.`,
      );
    }

    const wanted = options.family === 4 || options.family === 6 ? options.family : null;
    const answers = permit.pinned.addresses
      .map((pin) => ({ address: pin.address, family: familyOf(pin.address) }))
      .filter((answer) => wanted === null || answer.family === wanted);

    if (answers.length === 0) {
      return fail(
        `This egress permit pinned no IPv${wanted ?? 0} address for ${permit.pinned.host}.`,
      );
    }

    if (options.all === true) {
      callback(null, answers);
      return;
    }
    const first = answers[0];
    if (first === undefined) {
      // Unreachable given the length check above, and handled anyway because
      // `noUncheckedIndexedAccess` is the compiler saying the same thing: a
      // refusal here is safe and a non-null assertion is a habit.
      return fail(`This egress permit pinned no address for ${permit.pinned.host}.`);
    }
    callback(null, first.address, first.family);
  };
}

/**
 * THE BROWSER'S PINNING MECHANISM: `--host-resolver-rules`.
 *
 * Chromium does its own DNS inside the renderer's network service, so a Node
 * `lookup` cannot reach it and neither can `page.route` — by the time a route
 * handler sees a request the name has been resolved. The switch below is the
 * supported way to pin, and it is what `chromium.launch({ args })` takes.
 *
 * `MAP host address` per pinned host, plus `EXCLUDE nothing` so no name escapes
 * the map by matching a default rule. Hosts with no pin are simply absent,
 * which is correct: an absent rule means the browser resolves normally, so the
 * caller must ALSO refuse to navigate to a host it holds no permit for. This
 * function pins; it does not decide. `packages/agent/src/crawl/egress.ts` is
 * the caller that does both, and the ordering matters enough to say twice.
 *
 * An OBSERVED permit contributes NOTHING, for the same reason `pinnedLookup`
 * refuses one: it authorised no address.
 */
export function chromiumHostResolverRules(permits: readonly EgressPermit[]): string {
  const rules: string[] = [];
  const mapped = new Set<string>();
  for (const permit of permits) {
    if (permit.kind !== 'PINNED') continue;
    for (const pin of permit.pinned.addresses) {
      const rule = `MAP ${permit.pinned.host} ${pin.address}`;
      if (mapped.has(rule)) continue;
      mapped.add(rule);
      rules.push(rule);
    }
  }
  return rules.join(',');
}

/**
 * THE IP-FORM URL WITH THE HOST HEADER KEPT — HTTP ONLY, AND IT SAYS SO.
 *
 * For a transport with no `lookup` hook (a bare `fetch`), the only pin
 * available is to put the address in the URL and the name in the Host header.
 * That works over http and it is genuinely how a pinned fetch is done.
 *
 * It returns null for https, and the null is the honest answer rather than a
 * missing feature. Rewriting `https://app.example.com/` to
 * `https://93.184.216.34/` changes the SNI name, so the peer presents a
 * certificate for an address nobody has one for; the request fails, and the
 * next person "fixes" it by turning verification off — trading an SSRF for a
 * MITM on every request the product makes. For https the answer is
 * {@link pinnedLookup} or {@link chromiumHostResolverRules}, both of which pin
 * the address and leave the name alone.
 *
 * It returns null for an OBSERVED permit too: no address was authorised.
 */
export function pinnedRequestTarget(
  permit: EgressPermit,
  url: string,
): { readonly url: string; readonly hostHeader: string } | null {
  if (permit.kind !== 'PINNED') return null;
  if (permit.target.scheme !== 'http:') return null;
  const pin = permit.pinned.addresses[0];
  if (pin === undefined) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // The URL must be the one that was decided about. A caller that pinned
  // `a.example.com` and rewrote a URL for `b.example.com` would be sending
  // b's path to a's address with b's Host header, which is worse than no pin.
  if (parsed.hostname.trim().toLowerCase().replace(/\.+$/, '') !== permit.pinned.host) return null;

  // The Host header keeps the PORT when the URL had one, because a virtual host
  // on a non-default port is addressed by `name:port` and dropping the port
  // changes which server answers.
  const hostHeader = parsed.port === '' ? permit.pinned.host : `${permit.pinned.host}:${parsed.port}`;
  const rewritten = new URL(parsed.toString());
  rewritten.hostname = familyOf(pin.address) === 6 ? `[${pin.address}]` : pin.address;
  return { url: rewritten.toString(), hostHeader };
}

/**
 * THE CHECK AT THE SOCKET, re-exported so one import is enough.
 *
 * `assertConnectingTo` lives in `egress.ts` because the decision type does. It
 * is named here so a caller that imports this file has the whole obligation in
 * front of it: get a permit, pin the lookup, and assert at the socket. A caller
 * that does the first two and not the third has a pin nothing verifies.
 */
export { assertConnectingTo };

/**
 * Every refusal this file can produce, host-level and URL-level, in one list.
 *
 * DERIVED from the two source lists rather than written out, and saying so
 * matters: this constant does not GUARD anything, it just spares seventeen
 * hand-copied strings from drifting. The thing that guards is
 * {@link GUARD_REFUSAL_RULES}, whose `satisfies Record<GuardRefusal, …>` cannot
 * be written without naming every member — a hand-copied list beside a derived
 * one is how a round shipped eight unsaveable enum members.
 */
export const ALL_GUARD_REFUSALS: readonly GuardRefusal[] = [
  ...EGRESS_REFUSALS,
  ...EGRESS_GUARD_REFUSALS,
];
