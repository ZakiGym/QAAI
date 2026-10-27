/**
 * CHAOS — a dependency misbehaving, and what the application owes its user when
 * it does (§4 CHAOS).
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * `packages/runner/src/har.ts` has had route interception for as long as it has
 * existed — 1,528 lines, written, tested, and shipped into the Playwright
 * process — and NO TEST TYPE USED IT. So the failure half of every screen was
 * not merely untested: it was INEXPRESSIBLE. The 500 from the payment provider,
 * the eight-second wait on the search service, the analytics vendor answering
 * `<!DOCTYPE html>` under an `application/json` content type — every one of
 * those renders something, and nobody had ever seen what.
 *
 * Error paths are most of an application and none of its tests.
 *
 * ── ONE INTERCEPTION MECHANISM, AND IT IS har.ts's ──────────────────────────
 *
 * This file does not open a second route handler. `HarRoute`, `HarRouteRequest`
 * and `HarBrowserContext` are imported from ../har.js and are the whole
 * contract with the browser: `fulfill`, `abort`, `fetch`, `continue`. That is
 * also what `INTERCEPTION_MECHANISM` in packages/agent/src/fault-scenarios.ts
 * names, so the planner that proposes a fault and the plugin that injects it
 * are talking about the same four verbs. Two interceptors fighting over one
 * request is a flake nobody can reproduce, and there is exactly one here.
 *
 * ── WHY THE ASSERTION IS THE PRODUCT ────────────────────────────────────────
 *
 * "Shows an error message" passes when the WRONG error appears, passes when the
 * error is a raw stack trace, and passes when the user's half-finished form was
 * wiped on the way. It will not sell and it should not. So this plugin asserts
 * the INVARIANTS a user is owed under failure — the typed input survives, no
 * write was issued twice, the spinner resolves, the retry control actually
 * re-issues the request, the screen is not a stack trace, and the application
 * did NOT claim success — and {@link CHAOS_INVARIANT_DESCRIPTORS} gates each
 * one on evidence that the crawl actually recorded. Where the evidence is
 * missing the answer is UNDETERMINED with a reason, never a guess and never a
 * pass. See {@link UNDETERMINED_REASONS}.
 *
 * ── THE FALSE GREEN THIS FILE IS BUILT AGAINST ──────────────────────────────
 *
 * "We broke nothing and the application was fine." A glob that matched no
 * request, a dependency the page never called, a pattern written against a URL
 * the app stopped using two deploys ago — all of them produce a run in which
 * nothing was injected, every invariant trivially holds, and the row is green.
 * That is the single most likely lie in this plugin, so it is structurally
 * impossible: {@link OUTCOMES_THAT_MAY_PASS} holds one member, it is derived by
 * exclusion so a sixth outcome defaults to safe, and {@link chaosStatus} asks
 * it before it is allowed to say PASSED. `chaos.test.ts` drives every other
 * outcome and asserts the status is never PASSED.
 *
 * ── SAFETY, WHICH IS NOT A CONVENTION HERE ──────────────────────────────────
 *
 * A fault is NEVER injected against a non-idempotent request. Failing a
 * `POST /orders` means first issuing it, so "fail it" is indistinguishable from
 * "place the order and then lie to the page about the outcome" — a real order,
 * a real charge, a real email, and a UI state nobody can reproduce. The rule is
 * `injectionDecision` in packages/agent/src/crawl/variants.ts; this file
 * restates it (the packages cannot import each other) under the same name and
 * refuses with the same sentence. Writes ARE counted as they pass through, and
 * counting is all that happens to them — see {@link ObservedWrite}.
 *
 * Off-origin is refused for the same reason: failing somebody else's host tests
 * somebody else's surface, and `classifyHost` refuses a private, loopback or
 * link-local target before any connection is attempted.
 *
 * Nothing here logs, returns or embeds a header value, a cookie, a token or a
 * field's contents. {@link NO_INPUT_LOSS} compares field values and reports
 * FIELD NAMES; {@link NO_DUPLICATE_WRITE} compares idempotency keys and reports
 * a GROUP INDEX. Both are deliberate: the assertion needs equality, not the
 * value, and a plugin that prints what it compared is a plugin that prints a
 * session cookie the first time somebody puts one in a form.
 *
 * ── INJECTED SURFACES (rule 8) ──────────────────────────────────────────────
 *
 * There is no browser in a unit test and there will not be one. The page, the
 * route installation, the probe, the retry click and the out-of-band faults are
 * all behind {@link ChaosPageSurface}; the default is
 * {@link unavailableChaosPage}, which reports UNAVAILABLE and measures nothing.
 * No clock is read anywhere in this file: a held response is released on a
 * CONDITION, never after a sleep, which is the same rule
 * `fault-scenarios.ts` enforces and the same rule admission's NO_FIXED_SLEEP
 * gate exists to keep.
 */

import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type {
  ConsoleEntry,
  ExecutableTest,
  NotRunKind,
  RunContext,
  StepResult,
  TestExecution,
  TestMetric,
} from '@qaai/shared';
import { CHAOS_FAULTS, CHAOS_FAULT_LIST, matchesGlob, type ChaosFault } from '@qaai/shared';
/*
 * A SUBPATH, not the barrel, for the reason plugins/sandbox.ts records:
 * private-address.ts reaches for `node:dns` and the barrel is what the web
 * app's bundler consumes. One definition of "is this address inside our
 * network", reachable from the runner, without dragging dns into a browser tab.
 */
import { classifyHost } from '@qaai/shared/private-address';
/*
 * THE one interception contract. Structural interfaces describing Playwright's
 * objects, so this file needs no `Page` and no browser to be tested.
 */
import type { HarRoute } from '../har.js';
import { normalizeSeed, seededShuffle } from '../determinism.js';

// ─── 1. The fault library ────────────────────────────────────────────────────

/**
 * What a route handler does with the request it claims.
 *
 * The first three are `INTERCEPTION_VERBS` in
 * packages/agent/src/fault-scenarios.ts, spelled identically on purpose. The
 * last two are what that vocabulary could not say:
 *
 *   MUTATE_REAL  fetch the dependency's REAL response and substitute a damaged
 *                version of it. A truncation and a shape drift are only
 *                meaningful against the body the application actually gets —
 *                a synthetic `{}` would test the parser, not the deploy.
 *   OUT_OF_BAND  the fault is not a request at all. A dropped websocket, a
 *                skewed clock and a response that stalls after its headers
 *                cannot be expressed by fulfil/abort/continue, so each names
 *                the capability it needs and reports UNAVAILABLE without it.
 */
export const CHAOS_VERBS = ['FULFILL', 'ABORT', 'HOLD', 'MUTATE_REAL', 'OUT_OF_BAND'] as const;
export type ChaosVerb = (typeof CHAOS_VERBS)[number];

/** Compile-time half of the parity guard; chaos.test.ts holds the run-time half. */
const CHAOS_VERB_PRESENT: Record<ChaosVerb, true> = {
  FULFILL: true,
  ABORT: true,
  HOLD: true,
  MUTATE_REAL: true,
  OUT_OF_BAND: true,
};

/** Derived, never hand-listed. */
export const CHAOS_VERB_LIST = Object.keys(CHAOS_VERB_PRESENT) as ReadonlyArray<ChaosVerb>;

/**
 * Something a fault needs beyond route interception.
 *
 * ROUTE_INTERCEPTION is listed even though har.ts has always had it, because a
 * capability that is assumed is a capability nobody probed: a page surface that
 * cannot install a handler must report UNAVAILABLE rather than quietly running
 * a scenario in which no fault was ever armed.
 */
export const CHAOS_CAPABILITIES = [
  'ROUTE_INTERCEPTION',
  /** Headers written, then the body withheld. `fulfill` is atomic and cannot. */
  'RESPONSE_STREAMING',
  'WEBSOCKET_INTERCEPTION',
  'CLOCK_INSTALL',
  /** A named network profile, as `NETWORK_PROFILE_SHAPES` in @qaai/shared defines it. */
  'NETWORK_THROTTLE',
] as const;
export type ChaosCapability = (typeof CHAOS_CAPABILITIES)[number];

const CHAOS_CAPABILITY_PRESENT: Record<ChaosCapability, true> = {
  ROUTE_INTERCEPTION: true,
  RESPONSE_STREAMING: true,
  WEBSOCKET_INTERCEPTION: true,
  CLOCK_INSTALL: true,
  NETWORK_THROTTLE: true,
};

export const CHAOS_CAPABILITY_LIST = Object.keys(
  CHAOS_CAPABILITY_PRESENT,
) as ReadonlyArray<ChaosCapability>;

export const CHAOS_CAPABILITY_REMEDY: Record<ChaosCapability, string> = {
  ROUTE_INTERCEPTION:
    'install a browser context that can route requests — this is `BrowserContext.route`, which every Playwright chromium build has',
  RESPONSE_STREAMING:
    'a stalled response needs a handler that can write headers and withhold the body; `route.fulfill` is atomic, so this needs a local stalling proxy on the run workspace',
  WEBSOCKET_INTERCEPTION:
    'needs a context with websocket routing; Playwright exposes it from 1.48 and the adapter has to opt in',
  CLOCK_INSTALL:
    "needs Playwright's clock API installed before the first navigation; a skew applied after the app has read the time proves nothing",
  NETWORK_THROTTLE:
    'needs a CDP session to apply a named network profile; the profile shapes are NETWORK_PROFILE_SHAPES in packages/shared/src/browser-matrix.ts',
};

/**
 * THE FAULT LIBRARY. Fifteen declared shapes, each with a shape rather than
 * ad-hoc code at the injection site.
 *
 * ── Why fifteen and not thirteen ───────────────────────────────────────────
 *
 * Two pairs that look like one fault each are two faults each, and collapsing
 * either would have made the stored vocabulary lossy:
 *
 *   CONNECTION_REFUSED vs OFFLINE_MID_FLOW — one request is refused, versus the
 *   link going down for the rest of the flow. The first exercises one
 *   component's error branch; the second exercises whether the application can
 *   be used at all once it has started. An app that handles the first
 *   perfectly routinely hangs on the second.
 *
 *   EMPTY_BODY vs EMPTY_COLLECTION — a 200 with ZERO BYTES, versus a 200
 *   carrying a well-formed empty list. The first is the case a `try/catch`
 *   around `JSON.parse` swallows into `undefined`; the second is the
 *   zero-result screen every new account sees. They fail in different files.
 *
 * {@link STORED_FAULT_SPELLING} is therefore total AND injective: every member
 * of `CHAOS_FAULTS` in packages/shared/src/schemas.ts maps to exactly one kind
 * here and no two stored names share a target. A lossy bridge would silently
 * run a different fault from the one the test row asked for, which is
 * indistinguishable from a bug and worse than refusing.
 */
export const CHAOS_FAULT_KINDS = [
  'UPSTREAM_500',
  'SERVICE_UNAVAILABLE',
  'RATE_LIMITED',
  'CONNECTION_REFUSED',
  'NO_RESPONSE',
  'STALLED_RESPONSE',
  'SLOW_RESPONSE',
  'TRUNCATED_BODY',
  'MALFORMED_JSON',
  'EMPTY_BODY',
  'EMPTY_COLLECTION',
  'SHAPE_DRIFT',
  'OFFLINE_MID_FLOW',
  'WEBSOCKET_DROPPED',
  'CLOCK_SKEW',
] as const;
export type ChaosFaultKind = (typeof CHAOS_FAULT_KINDS)[number];

const CHAOS_FAULT_KIND_PRESENT: Record<ChaosFaultKind, true> = {
  UPSTREAM_500: true,
  SERVICE_UNAVAILABLE: true,
  RATE_LIMITED: true,
  CONNECTION_REFUSED: true,
  NO_RESPONSE: true,
  STALLED_RESPONSE: true,
  SLOW_RESPONSE: true,
  TRUNCATED_BODY: true,
  MALFORMED_JSON: true,
  EMPTY_BODY: true,
  EMPTY_COLLECTION: true,
  SHAPE_DRIFT: true,
  OFFLINE_MID_FLOW: true,
  WEBSOCKET_DROPPED: true,
  CLOCK_SKEW: true,
};

export const CHAOS_FAULT_KIND_LIST = Object.keys(
  CHAOS_FAULT_KIND_PRESENT,
) as ReadonlyArray<ChaosFaultKind>;

/** A spec field a fault cannot be injected without. */
export const CHAOS_FAULT_OPTIONS = [
  'retryAfterSeconds',
  'throttleProfile',
  'emptyEnvelope',
  'dropFields',
  'clockSkewSeconds',
  'websocketUrlGlob',
] as const;
export type ChaosFaultOption = (typeof CHAOS_FAULT_OPTIONS)[number];

export interface ChaosFaultDescriptor {
  /** What the USER experiences, which is what goes in the test name. */
  label: string;
  verb: ChaosVerb;
  /** The substituted status, for FULFILL. Null when the status is not the fault. */
  status: number | null;
  /** The capability beyond route interception, or null when there is none. */
  capability: ChaosCapability | null;
  /** Options with no honest default. Absent means the fault cannot be injected. */
  requires: readonly ChaosFaultOption[];
  /** Why this one is worth injecting, for the reviewer deciding to keep the test. */
  why: string;
}

/**
 * Fault → shape, as data.
 *
 * A `Record` keyed on the union so a sixteenth fault cannot join without
 * somebody deciding its verb, its capability and its required options — and in
 * particular without deciding whether it needs something this image does not
 * have, which is the field that decides whether it can report PASSED at all.
 */
export const CHAOS_FAULT_DESCRIPTORS: Record<ChaosFaultKind, ChaosFaultDescriptor> = {
  UPSTREAM_500: {
    label: 'the dependency returns 500',
    verb: 'FULFILL',
    status: 500,
    capability: null,
    requires: [],
    why: 'the error-boundary half of the screen, and the only fault most applications have ever seen in staging',
  },
  SERVICE_UNAVAILABLE: {
    label: 'the dependency returns 503 with Retry-After',
    verb: 'FULFILL',
    status: 503,
    capability: null,
    requires: ['retryAfterSeconds'],
    why:
      'a 503 carrying Retry-After is an instruction, and a client that ignores it hammers a ' +
      'service that just told it to wait — which is how one slow dependency becomes an outage',
  },
  RATE_LIMITED: {
    label: 'the dependency returns 429',
    verb: 'FULFILL',
    status: 429,
    capability: null,
    requires: ['retryAfterSeconds'],
    why: 'throttling is the state almost no UI handles and every API produces under load',
  },
  CONNECTION_REFUSED: {
    label: 'the connection to the dependency is refused',
    verb: 'ABORT',
    status: null,
    capability: null,
    requires: [],
    why:
      'not the same as a 5xx: there is no response object, no status and no body, so a client ' +
      'that reads `response.status` to decide what to show throws instead of rendering',
  },
  NO_RESPONSE: {
    label: 'the dependency never answers at all',
    verb: 'HOLD',
    status: null,
    capability: null,
    requires: [],
    why:
      'the one case almost no front end handles: there is no error boundary for "still waiting", ' +
      'so the skeleton stays up and the user has nothing to read and nothing to click',
  },
  STALLED_RESPONSE: {
    label: 'the dependency sends headers and then nothing',
    verb: 'OUT_OF_BAND',
    status: null,
    capability: 'RESPONSE_STREAMING',
    requires: [],
    why:
      'the response "started", so every readyState check and every `response.ok` says yes while ' +
      'the body never arrives — a loading state that cannot be distinguished from success',
  },
  SLOW_RESPONSE: {
    label: 'the dependency answers late, at a named throttle profile',
    verb: 'HOLD',
    status: null,
    capability: null,
    requires: ['throttleProfile'],
    why:
      'late is where the double-submit lives: a user who has waited four seconds clicks again, ' +
      'and whether that charges them twice is decided here',
  },
  TRUNCATED_BODY: {
    label: 'the response is cut off mid-body',
    verb: 'MUTATE_REAL',
    status: null,
    capability: null,
    requires: [],
    why:
      'a short read under an honest Content-Length is what a dropped connection looks like to a ' +
      'parser, and half a rendered screen with holes in it is what the user sees',
  },
  MALFORMED_JSON: {
    label: 'the dependency returns something that is not the JSON it promised',
    verb: 'FULFILL',
    status: 200,
    capability: null,
    requires: [],
    why:
      'a 200 with an HTML error page under an application/json content type is what every proxy, ' +
      'captive portal and WAF in the world produces, and `await res.json()` throws inside a ' +
      'success branch nobody wrapped',
  },
  EMPTY_BODY: {
    label: 'the dependency returns 200 with no body at all',
    verb: 'FULFILL',
    status: 200,
    capability: null,
    requires: [],
    why: 'zero bytes parse to nothing, and the `undefined` that results is read as data one line later',
  },
  EMPTY_COLLECTION: {
    label: 'the dependency returns an empty collection',
    verb: 'FULFILL',
    status: 200,
    capability: null,
    requires: ['emptyEnvelope'],
    why:
      'a list that throws on zero rows is the first screen every new account sees, and it is only ' +
      'reachable with a fixture nobody has — which is why it ships broken so often',
  },
  SHAPE_DRIFT: {
    label: 'the dependency succeeds and returns a different shape than it declared',
    verb: 'MUTATE_REAL',
    status: null,
    capability: null,
    requires: ['dropFields'],
    why:
      'this is what a rolling deploy looks like from the browser, and "undefined" rendered into a ' +
      'price or a name is the defect users screenshot',
  },
  OFFLINE_MID_FLOW: {
    label: 'the network goes away in the middle of the flow',
    verb: 'ABORT',
    status: null,
    capability: null,
    requires: [],
    why:
      'every request after this point fails, which is the lift, the tunnel and the hotel wifi — ' +
      'and an application that recovers from one failed request often cannot recover from all of them',
  },
  WEBSOCKET_DROPPED: {
    label: 'the websocket closes and does not come back',
    verb: 'OUT_OF_BAND',
    status: null,
    capability: 'WEBSOCKET_INTERCEPTION',
    requires: ['websocketUrlGlob'],
    why:
      'a live-updating screen whose socket died looks identical to one with no news, so the user ' +
      'reads stale data as current — and the reconnect path is almost never exercised',
  },
  CLOCK_SKEW: {
    label: "the browser's clock disagrees with the server's",
    verb: 'OUT_OF_BAND',
    status: null,
    capability: 'CLOCK_INSTALL',
    requires: ['clockSkewSeconds'],
    why:
      'a token that is "not yet valid", a signature window that rejects, a cache that never ' +
      'expires: skew failures are reported by users as "it just logged me out" and reproduce nowhere',
  },
};

/**
 * The stored vocabulary → this one. TOTAL and INJECTIVE; see the note on
 * {@link CHAOS_FAULT_KINDS}.
 *
 * `CHAOS_FAULTS` in packages/shared/src/schemas.ts is what a Test row can hold
 * today. It is a `Record` over that union rather than a lookup with a fallback,
 * so a ninth stored member cannot arrive without a decision here — a default
 * would run UPSTREAM_500 under another fault's name.
 */
export const STORED_FAULT_SPELLING: Record<ChaosFault, ChaosFaultKind> = {
  HTTP_500: 'UPSTREAM_500',
  HTTP_503: 'SERVICE_UNAVAILABLE',
  HTTP_429: 'RATE_LIMITED',
  CONNECTION_REFUSED: 'CONNECTION_REFUSED',
  SLOW_RESPONSE: 'SLOW_RESPONSE',
  MALFORMED_BODY: 'MALFORMED_JSON',
  EMPTY_BODY: 'EMPTY_BODY',
  TRUNCATED_BODY: 'TRUNCATED_BODY',
};

/**
 * Faults with no stored spelling, so NO Test ROW CAN ASK FOR THEM yet.
 *
 * Derived by exclusion and exported because this is the round's own headline
 * defect reappearing one level down: a plugin wider than the vocabulary that
 * feeds it is a plugin whose extra capability is unreachable, which is exactly
 * what fourteen unreachable test types were. `registry.ts`'s `pendingTypes()`
 * makes the same gap sayable for types; this makes it sayable for faults, and a
 * report can COUNT it instead of a reader discovering it.
 *
 * The remedy is named in this file's handover: widen `CHAOS_FAULTS` in
 * packages/shared/src/schemas.ts and the fields those faults require.
 */
export const FAULTS_WITHOUT_A_STORED_SPELLING: readonly ChaosFaultKind[] =
  CHAOS_FAULT_KIND_LIST.filter(
    (kind) => !CHAOS_FAULT_LIST.some((stored) => STORED_FAULT_SPELLING[stored] === kind),
  );

/**
 * The methods a fault may be injected against. NEVER anything else.
 *
 * Restated from `IDEMPOTENT_METHODS` in packages/agent/src/crawl/variants.ts
 * rather than imported, for the reason har.ts's `CREDENTIAL_HEADERS` gives
 * about its own duplication: @qaai/runner does not depend on @qaai/agent, and a
 * safety rule that cannot be reached is a safety rule that is not applied. The
 * two lists must stay identical; `chaos.test.ts` pins the sentence so a change
 * on either side is visible in a diff.
 */
export const IDEMPOTENT_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS', 'TRACE'];

export const NON_IDEMPOTENT_RULE =
  'faults: a non-idempotent request is never injected against — failing a POST means first issuing it';

// ─── 2. The invariants ───────────────────────────────────────────────────────

/** How much a held invariant proves. The planner's `ASSERTION_STRENGTHS`. */
export const INVARIANT_STRENGTHS = ['STRONG', 'WEAK'] as const;
export type InvariantStrength = (typeof INVARIANT_STRENGTHS)[number];

/**
 * THE ASSERTIONS. Twelve.
 *
 * The first nine are `FAULT_ASSERTION_KINDS` in
 * packages/agent/src/fault-scenarios.ts, spelled identically — ONE vocabulary
 * across the planner that proposes an assertion and the plugin that evaluates
 * it, even though the packages cannot import each other.
 *
 * The last three are the ones this round asked for that the planner has no
 * spelling for, and they are listed in
 * {@link INVARIANTS_THE_PLANNER_CANNOT_PROPOSE} rather than silently added:
 * an invariant only this plugin knows about is an invariant no producer can
 * ever emit, which is the same unreachability defect one level down again.
 */
export const CHAOS_INVARIANTS = [
  'NO_INPUT_LOSS',
  'ERROR_IS_NAMED',
  'NO_INFINITE_LOADING',
  'EMPTY_IS_NOT_ERROR',
  'RETRY_RECOVERS',
  'NO_PARTIAL_RENDER',
  'STAYS_ON_ROUTE',
  'NO_UNHANDLED_RUNTIME_ERROR',
  'SOME_ERROR_SHOWN',
  'NO_DUPLICATE_WRITE',
  'NO_RAW_STACK_TRACE',
  'NO_FALSE_SUCCESS',
] as const;
export type ChaosInvariant = (typeof CHAOS_INVARIANTS)[number];

const CHAOS_INVARIANT_PRESENT: Record<ChaosInvariant, true> = {
  NO_INPUT_LOSS: true,
  ERROR_IS_NAMED: true,
  NO_INFINITE_LOADING: true,
  EMPTY_IS_NOT_ERROR: true,
  RETRY_RECOVERS: true,
  NO_PARTIAL_RENDER: true,
  STAYS_ON_ROUTE: true,
  NO_UNHANDLED_RUNTIME_ERROR: true,
  SOME_ERROR_SHOWN: true,
  NO_DUPLICATE_WRITE: true,
  NO_RAW_STACK_TRACE: true,
  NO_FALSE_SUCCESS: true,
};

export const CHAOS_INVARIANT_LIST = Object.keys(
  CHAOS_INVARIANT_PRESENT,
) as ReadonlyArray<ChaosInvariant>;

/** The nine the planner already has a spelling for. */
export const PLANNER_INVARIANTS: readonly ChaosInvariant[] = [
  'NO_INPUT_LOSS',
  'ERROR_IS_NAMED',
  'NO_INFINITE_LOADING',
  'EMPTY_IS_NOT_ERROR',
  'RETRY_RECOVERS',
  'NO_PARTIAL_RENDER',
  'STAYS_ON_ROUTE',
  'NO_UNHANDLED_RUNTIME_ERROR',
  'SOME_ERROR_SHOWN',
];

/**
 * Invariants no producer can propose yet. Derived by exclusion, so a thirteenth
 * invariant lands in here by default rather than silently claiming the planner
 * supports it.
 */
export const INVARIANTS_THE_PLANNER_CANNOT_PROPOSE: readonly ChaosInvariant[] =
  CHAOS_INVARIANT_LIST.filter((kind) => !PLANNER_INVARIANTS.includes(kind));

/**
 * What must have been OBSERVED before an invariant may be asserted.
 *
 * The first seven are `FAULT_EVIDENCE_NEEDS` in fault-scenarios.ts. The last
 * two are what the three new invariants need. This is the mechanism that stops
 * the plugin asserting confident nonsense: "the typed input survives" is a
 * sentence about nothing on a read-only dashboard, and "the application did not
 * claim success" cannot be checked without knowing what this application's
 * success looks like.
 */
export const CHAOS_EVIDENCE_NEEDS = [
  'NONE',
  'TYPED_FIELDS',
  'OWN_ERROR_TEXT',
  'LOADING_STATE_SEEN',
  'POPULATED_STATE_SEEN',
  'RETRY_CONTROL',
  'CONSOLE_CHANNEL',
  /** The interceptor can see the writes the flow issues, so duplicates are countable. */
  'WRITE_REQUESTS_OBSERVABLE',
  /** The crawl captured the application's own success wording. */
  'OWN_SUCCESS_TEXT',
] as const;
export type ChaosEvidenceNeed = (typeof CHAOS_EVIDENCE_NEEDS)[number];

export interface ChaosInvariantDescriptor {
  /** The requirement, in the words that go in the step title. */
  claim: string;
  strength: InvariantStrength;
  needs: ChaosEvidenceNeed;
  /** Why it is worth asserting, for the reviewer deciding whether to keep it. */
  why: string;
  /** Faults this bears on. EMPTY MEANS EVERY FAULT, as in fault-scenarios.ts. */
  faults: readonly ChaosFaultKind[];
}

export const CHAOS_INVARIANT_DESCRIPTORS: Record<ChaosInvariant, ChaosInvariantDescriptor> = {
  NO_INPUT_LOSS: {
    claim: 'the values the user typed are still in the form after the request fails',
    strength: 'STRONG',
    needs: 'TYPED_FIELDS',
    why:
      'the commonest and most expensive failure-path bug: the request fails, the component ' +
      'remounts, and the user retypes a long form. Invisible to a happy-path test and obvious to ' +
      'every user who hits it',
    faults: [],
  },
  ERROR_IS_NAMED: {
    claim: "the application's own error message appears, verbatim",
    strength: 'STRONG',
    needs: 'OWN_ERROR_TEXT',
    why:
      'asserting the exact words the application chose is the only form of error assertion that ' +
      'fails when the WRONG error appears — and the wrong error is a real defect that "an error ' +
      'is shown" passes straight over',
    faults: [
      'UPSTREAM_500',
      'SERVICE_UNAVAILABLE',
      'RATE_LIMITED',
      'CONNECTION_REFUSED',
      'MALFORMED_JSON',
      'EMPTY_BODY',
      'TRUNCATED_BODY',
      'OFFLINE_MID_FLOW',
    ],
  },
  NO_INFINITE_LOADING: {
    claim: 'the loading state resolves — the page does not spin forever',
    strength: 'STRONG',
    needs: 'LOADING_STATE_SEEN',
    why:
      'a request that never answers is the one case almost no front end handles: there is no ' +
      'error boundary for "still waiting", so the skeleton stays up for ever',
    faults: ['NO_RESPONSE', 'SLOW_RESPONSE', 'STALLED_RESPONSE', 'OFFLINE_MID_FLOW'],
  },
  EMPTY_IS_NOT_ERROR: {
    claim: 'an empty collection renders the empty state, not the error boundary',
    strength: 'STRONG',
    needs: 'POPULATED_STATE_SEEN',
    why:
      'a list that throws on zero rows is the first screen every new account sees, and it is only ' +
      'reachable with a fixture nobody has',
    faults: ['EMPTY_COLLECTION', 'EMPTY_BODY'],
  },
  RETRY_RECOVERS: {
    claim: 'the retry control the application offers recovers once the request succeeds',
    strength: 'STRONG',
    needs: 'RETRY_CONTROL',
    why:
      'a retry button that re-renders the error without re-issuing the request is a dead control ' +
      'that looks alive, and nothing short of failing then succeeding can catch it',
    faults: [],
  },
  NO_PARTIAL_RENDER: {
    claim: 'a response missing fields does not render a screen with holes in it',
    strength: 'STRONG',
    needs: 'POPULATED_STATE_SEEN',
    why:
      'this is what a rolling deploy looks like from the browser, and "undefined" rendered into a ' +
      'price or a name is a defect users screenshot',
    faults: ['SHAPE_DRIFT', 'TRUNCATED_BODY', 'EMPTY_BODY'],
  },
  STAYS_ON_ROUTE: {
    claim: 'the failure leaves the user on the same route',
    strength: 'STRONG',
    needs: 'NONE',
    why:
      'a failed request that bounces the user to a dashboard or a login page destroys their work ' +
      'and hides the cause; it is also the shape an over-eager 401 interceptor produces',
    faults: [],
  },
  NO_UNHANDLED_RUNTIME_ERROR: {
    claim: 'no unhandled error reaches the console',
    strength: 'STRONG',
    needs: 'CONSOLE_CHANNEL',
    why:
      'a handled failure and an uncaught exception can look identical on screen; the console is ' +
      'the only place the difference shows, and the difference decides whether the rest of the ' +
      'page still works',
    faults: [],
  },
  SOME_ERROR_SHOWN: {
    claim: 'something error-shaped becomes visible',
    strength: 'WEAK',
    needs: 'NONE',
    why:
      'DELIBERATELY WEAK and kept as the floor for pages where nothing stronger is supported: it ' +
      'passes when the wrong error appears and when the error is a stack trace, so a scenario ' +
      'carrying only this one proves very little and is reported that way',
    faults: [
      'UPSTREAM_500',
      'SERVICE_UNAVAILABLE',
      'RATE_LIMITED',
      'CONNECTION_REFUSED',
      'MALFORMED_JSON',
      'TRUNCATED_BODY',
      'SHAPE_DRIFT',
      'OFFLINE_MID_FLOW',
      'WEBSOCKET_DROPPED',
      'CLOCK_SKEW',
    ],
  },
  NO_DUPLICATE_WRITE: {
    claim: 'the failure did not cause the same write to be issued twice unkeyed',
    strength: 'STRONG',
    needs: 'WRITE_REQUESTS_OBSERVABLE',
    why:
      'THE money defect. A request that fails or answers late invites the application, or the ' +
      'user, to send it again — and whether that is a retry or a second charge is decided by ' +
      'whether the two carry the same idempotency key. Nothing the application SHOWS can tell you ' +
      'which happened; only the requests can',
    faults: [],
  },
  NO_RAW_STACK_TRACE: {
    claim: 'the failure is not reported to the user as a stack trace',
    strength: 'STRONG',
    needs: 'NONE',
    why:
      'a stack trace on screen is two defects at once: the user cannot act on it, and it hands a ' +
      'stranger the file layout, the framework versions and often the query that failed. It also ' +
      'passes every "an error is shown" assertion ever written',
    faults: [],
  },
  NO_FALSE_SUCCESS: {
    claim: 'the application did not report success',
    strength: 'STRONG',
    needs: 'OWN_SUCCESS_TEXT',
    why:
      'the worst outcome available under a fault, and the quietest: the dependency failed, the ' +
      'optimistic UI said "Saved", and the user walks away believing it. Nothing else in a suite ' +
      'looks for this',
    faults: [],
  },
};

/**
 * Why an invariant could not be decided. FIVE reasons, and the first two are
 * deliberately distinct.
 *
 * "Nobody captured whether this page has typed fields" and "we looked and this
 * page has none" are different facts with different remedies — the first is a
 * crawl that predates the capture and is fixed by re-crawling, the second is a
 * page on which the assertion is meaningless for ever. Reporting both as one
 * reason sends somebody to re-crawl a read-only dashboard.
 */
export const UNDETERMINED_REASONS = [
  'EVIDENCE_NOT_CAPTURED',
  'EVIDENCE_ABSENT',
  'NOT_APPLICABLE_TO_FAULT',
  'PROBE_UNAVAILABLE',
  /** NO_DUPLICATE_WRITE with no write in the flow: nothing could have duplicated. */
  'NO_WRITE_IN_FLOW',
] as const;
export type UndeterminedReason = (typeof UNDETERMINED_REASONS)[number];

const UNDETERMINED_REASON_PRESENT: Record<UndeterminedReason, true> = {
  EVIDENCE_NOT_CAPTURED: true,
  EVIDENCE_ABSENT: true,
  NOT_APPLICABLE_TO_FAULT: true,
  PROBE_UNAVAILABLE: true,
  NO_WRITE_IN_FLOW: true,
};

export const UNDETERMINED_REASON_LIST = Object.keys(
  UNDETERMINED_REASON_PRESENT,
) as ReadonlyArray<UndeterminedReason>;

export const UNDETERMINED_REASON_DETAIL: Record<UndeterminedReason, string> = {
  EVIDENCE_NOT_CAPTURED:
    'no crawl recorded the evidence this assertion needs, so it could not be decided — re-crawl this route with the behaviour capture on',
  EVIDENCE_ABSENT:
    'the crawl looked and this page does not have what the assertion needs, so the assertion is meaningless here rather than failing',
  NOT_APPLICABLE_TO_FAULT:
    'this assertion does not bear on the fault that was injected, so holding it would prove nothing about it',
  PROBE_UNAVAILABLE: 'the page probe could not answer, so nothing was observed either way',
  NO_WRITE_IN_FLOW:
    'no write request was issued during this flow, so there was nothing that could have been duplicated',
};

/** HELD, VIOLATED, or we could not tell — and the third is never a pass. */
export const INVARIANT_VERDICTS = ['HELD', 'VIOLATED', 'UNDETERMINED'] as const;
export type InvariantVerdict = (typeof INVARIANT_VERDICTS)[number];

export interface ChaosInvariantResult {
  invariant: ChaosInvariant;
  verdict: InvariantVerdict;
  strength: InvariantStrength;
  /** Printable verbatim. Never carries a field value, a header or a key. */
  detail: string;
  /** Required exactly when the verdict is UNDETERMINED, null otherwise. */
  undetermined: UndeterminedReason | null;
}

// ─── 3. Injection outcomes, and the one that may pass ────────────────────────

/**
 * What happened to the fault itself, which is a different question from what
 * happened to the application.
 *
 * NOT_INJECTED is the reason this vocabulary exists. A glob that matched
 * nothing, a dependency the page no longer calls, a request that happens only
 * on a tab the flow did not open — all of them leave the application untouched,
 * every invariant trivially holding, and a green row that says the error path
 * is covered. It is a pass that means "we did not check", and it is the
 * likeliest false green in this plugin.
 */
export const CHAOS_INJECTION_OUTCOMES = [
  /** The pattern claimed at least one request and the fault was applied to it. */
  'INJECTED',
  /** Nothing matched. No evidence in either direction. NEVER a pass. */
  'NOT_INJECTED',
  /** A rule forbade it: non-idempotent, off-origin, or a private target. */
  'REFUSED',
  /** The pattern matched and applying the fault threw, or the upstream fetch failed. */
  'INJECTION_FAILED',
  /** The capability this fault needs is not on this deployment. */
  'UNAVAILABLE',
] as const;
export type ChaosInjectionOutcome = (typeof CHAOS_INJECTION_OUTCOMES)[number];

const CHAOS_INJECTION_OUTCOME_PRESENT: Record<ChaosInjectionOutcome, true> = {
  INJECTED: true,
  NOT_INJECTED: true,
  REFUSED: true,
  INJECTION_FAILED: true,
  UNAVAILABLE: true,
};

export const CHAOS_INJECTION_OUTCOME_LIST = Object.keys(
  CHAOS_INJECTION_OUTCOME_PRESENT,
) as ReadonlyArray<ChaosInjectionOutcome>;

/**
 * The ONE outcome from which a PASSED result may be produced.
 *
 * A list rather than a boolean so it can be read, printed and tested, and the
 * complement below is DERIVED BY EXCLUSION so that a sixth outcome is
 * un-passable by default. That ordering matters: the alternative is a list of
 * outcomes that may not pass, where a new member defaults to PASSABLE and the
 * mistake is silent and green.
 */
export const OUTCOMES_THAT_MAY_PASS: readonly ChaosInjectionOutcome[] = ['INJECTED'];

export const OUTCOMES_THAT_MAY_NOT_PASS: readonly ChaosInjectionOutcome[] =
  CHAOS_INJECTION_OUTCOME_LIST.filter((outcome) => !OUTCOMES_THAT_MAY_PASS.includes(outcome));

/**
 * Which of the four `NOT_RUN_KINDS` each outcome is, and the three distinctions
 * are each load-bearing.
 *
 * NOT_INJECTED is NOT_RUN and not BLOCKED_BY_ENV: the environment may be
 * perfectly healthy and the pattern simply stale, and blaming the environment
 * for a wrong glob sends the customer to check a firewall. NOT_RUN is the
 * honest weakest reading — no evidence in either direction.
 *
 * REFUSED is UNSUPPORTED: this test, as written, may not be performed here, and
 * no install changes that. Nothing about a deployment turns a POST into an
 * idempotent request.
 *
 * INJECTED is null, because an injected fault produced a measurement and there
 * is no not-run to report. Null is a real member of this table rather than a
 * missing key, so a caller cannot read the absence as NOT_RUN — which would put
 * a claim in the database that no plugin made.
 */
export const OUTCOME_NOT_RUN_KIND: Record<ChaosInjectionOutcome, NotRunKind | null> = {
  INJECTED: null,
  NOT_INJECTED: 'NOT_RUN',
  REFUSED: 'UNSUPPORTED',
  INJECTION_FAILED: 'BLOCKED_BY_ENV',
  UNAVAILABLE: 'BLOCKED_BY_ENV',
};

/** Why one scenario was refused. Each is a deliberate non-performance. */
export const CHAOS_REFUSAL_REASONS = [
  'NON_IDEMPOTENT_TARGET',
  'OFF_ORIGIN_TARGET',
  'PRIVATE_TARGET',
  'UNREADABLE_TARGET',
] as const;
export type ChaosRefusalReason = (typeof CHAOS_REFUSAL_REASONS)[number];

const CHAOS_REFUSAL_REASON_PRESENT: Record<ChaosRefusalReason, true> = {
  NON_IDEMPOTENT_TARGET: true,
  OFF_ORIGIN_TARGET: true,
  PRIVATE_TARGET: true,
  UNREADABLE_TARGET: true,
};

export const CHAOS_REFUSAL_REASON_LIST = Object.keys(
  CHAOS_REFUSAL_REASON_PRESENT,
) as ReadonlyArray<ChaosRefusalReason>;

export interface ChaosRefusal {
  reason: ChaosRefusalReason;
  /** The rule that decided, printable verbatim. */
  rule: string;
}

// ─── 4. The spec ─────────────────────────────────────────────────────────────

const originSchema = z.string().min(1).max(300);

export const chaosTargetSchema = z
  .object({
    /**
     * The methods this fault may claim. A LIST and not one method, because a
     * stored spec names none and the only safe reading of silence is "the
     * idempotent ones" — which is a fact, where a fabricated `'GET'` would be a
     * guess that quietly stops matching a HEAD-driven prefetch.
     */
    methods: z.array(z.string().min(1).max(10)).min(1).max(8),
    /** Path glob only. NO QUERY, EVER — see {@link requestPathOf}. */
    pathGlob: z.string().min(1).max(500),
  })
  .strict()
  .refine((t) => t.pathGlob.indexOf('?') < 0 && t.pathGlob.indexOf('#') < 0, {
    message:
      'a path glob may not carry a query or a fragment: a matcher is stored, rendered in a panel ' +
      'and exported, and `?token=…`, `?email=…` and `?q=my+diagnosis` are all equally ' +
      'unacceptable there',
    path: ['pathGlob'],
  });

/**
 * The evidence the crawl recorded, as this plugin needs it.
 *
 * Every member is optional and follows the three-state convention the rest of
 * this repo uses: ABSENT means no crawl captured it, NULL means it looked and
 * there was nothing, a value is the fact. Collapsing the first two would drop
 * an assertion from every page on a crawl that merely predates the capture,
 * while reporting the reason as "this page has none".
 */
export const chaosEvidenceSchema = z
  .object({
    /** Field NAMES only. A value here would be a form's contents in a stored spec. */
    typedFieldNames: z.array(z.string().min(1).max(120)).max(50).optional(),
    ownErrorText: z.string().min(1).max(300).nullable().optional(),
    ownSuccessText: z.string().min(1).max(300).nullable().optional(),
    retryControl: z
      .object({ identity: z.string().min(1).max(200), label: z.string().max(200) })
      .strict()
      .nullable()
      .optional(),
    loadingStateSeen: z.boolean().nullable().optional(),
    populatedStateSeen: z.boolean().nullable().optional(),
    /** A claim about OUR instrumentation, not about the application. */
    consoleChannelWorked: z.boolean().nullable().optional(),
    writeRequestsObservable: z.boolean().nullable().optional(),
  })
  .strict();
export type ChaosEvidence = z.infer<typeof chaosEvidenceSchema>;

export const chaosFaultOptionsSchema = z
  .object({
    retryAfterSeconds: z.number().int().min(0).max(86_400).nullable().default(null),
    /**
     * A profile NAME, carried verbatim. This file does not hold a second table
     * of kilobits: `NETWORK_PROFILE_SHAPES` in
     * packages/shared/src/browser-matrix.ts owns the shapes, and the throttle
     * adapter resolves the name against it. Typing this as
     * `z.enum(NETWORK_PROFILES)` is the follow-up named in the handover and
     * needs that module on the @qaai/shared barrel first.
     */
    throttleProfile: z.string().min(1).max(40).nullable().default(null),
    /** The body EMPTY_COLLECTION serves, as the application's own envelope. */
    emptyEnvelope: z.string().min(2).max(2_000).nullable().default(null),
    /** Field names SHAPE_DRIFT removes from the real response. */
    dropFields: z.array(z.string().min(1).max(120)).max(50).default([]),
    clockSkewSeconds: z.number().int().min(-31_536_000).max(31_536_000).nullable().default(null),
    websocketUrlGlob: z.string().min(1).max(500).nullable().default(null),
  })
  .strict();
export type ChaosFaultOptions = z.infer<typeof chaosFaultOptionsSchema>;

/** The cap vocabulary. One member today, and it is disclosed when it bites. */
export const CHAOS_CAPS = ['INTERCEPTIONS'] as const;
export type ChaosCap = (typeof CHAOS_CAPS)[number];

export const CHAOS_CAP_LABELS: Record<ChaosCap, string> = {
  INTERCEPTIONS: 'the per-scenario limit on how many requests one fault may claim',
};

export interface ChaosCapBite {
  cap: ChaosCap;
  limit: number;
  /** How many times the cap was reached. */
  bites: number;
  /** How many matching requests were let through unfaulted because of it. */
  discarded: number;
  /** Printable verbatim, and it says how to raise the cap. */
  reason: string;
}

export const DEFAULT_MAX_INTERCEPTIONS = 10;

/**
 * The scenario, as this plugin executes it.
 *
 * ── `assertInvariants`, AND THE NAME IS LOAD-BEARING ───────────────────────
 *
 * `specAssertions` in packages/agent/src/suite-health.ts decides whether a
 * spec-driven test declares anything to check, and it does so by matching
 * `/(expect|assert|schema|jsonpath|contains|match|equals|…)/` against the spec's
 * KEY NAMES. A field called `invariants` matches none of them, so every correct
 * CHAOS spec would have been reported as asserting nothing — and generation
 * REFUSES a test that asserts nothing. The field is called `assertInvariants`
 * for that reason and no other, which is exactly the trap that file's own
 * comment records about `budget`.
 */
export const chaosScenarioSpecSchema = z
  .object({
    /** The in-app route the flow runs on. */
    path: z.string().min(1).max(500).default('/'),
    target: chaosTargetSchema,
    fault: z.enum(CHAOS_FAULT_KINDS),
    assertInvariants: z
      .array(z.enum(CHAOS_INVARIANTS))
      .min(1)
      .max(CHAOS_INVARIANTS.length),
    evidence: chaosEvidenceSchema.default({}),
    options: chaosFaultOptionsSchema.default({
      retryAfterSeconds: null,
      throttleProfile: null,
      emptyEnvelope: null,
      dropFields: [],
      clockSkewSeconds: null,
      websocketUrlGlob: null,
    }),
    /** This application's own origins. A fault is never injected off-origin. */
    ownOrigins: z.array(originSchema).min(1).max(20),
    /**
     * The run seed. REQUIRED, with no default: it decides which matching
     * requests are faulted when the cap bites, and a default would make that
     * choice un-reproducible across two runs of the same suite.
     */
    seed: z.string().min(1).max(120),
    maxInterceptions: z.number().int().min(1).max(100).default(DEFAULT_MAX_INTERCEPTIONS),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const descriptor = CHAOS_FAULT_DESCRIPTORS[spec.fault];

    for (const option of descriptor.requires) {
      const value = spec.options[option];
      const missing = value === null || (Array.isArray(value) && value.length === 0);
      if (missing) {
        ctx.addIssue({
          code: 'custom',
          path: ['options', option],
          message:
            `${spec.fault} needs \`${option}\`, and with none the fault cannot be injected — ` +
            'which would be reported as NOT_INJECTED after a run rather than as the typo it is',
        });
      }
    }

    /*
     * Options set on a fault that does not read them. A silently ignored
     * instruction is how a test asserts less than its spec says: a
     * `throttleProfile` on an UPSTREAM_500 reads as "this was tested slowly"
     * and nothing slow happened.
     */
    for (const option of CHAOS_FAULT_OPTIONS) {
      if (descriptor.requires.includes(option)) continue;
      const value = spec.options[option];
      const set = Array.isArray(value) ? value.length > 0 : value !== null;
      if (set) {
        ctx.addIssue({
          code: 'custom',
          path: ['options', option],
          message:
            `\`${option}\` is set on ${spec.fault}, which does not read it, so the instruction ` +
            'would be silently ignored',
        });
      }
    }

    /*
     * A method this plugin may not fault. Caught at VALIDATE time rather than
     * at run time on purpose: a test author who learns about it from a REFUSED
     * result has waited for a run to be told their spec can never do anything.
     */
    const forbidden = spec.target.methods.filter(
      (method) => !IDEMPOTENT_METHODS.includes(method.toUpperCase()),
    );
    if (forbidden.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['target', 'methods'],
        message: `${forbidden.join(', ')} — ${NON_IDEMPOTENT_RULE}`,
      });
    }

    /*
     * An invariant that does not bear on the fault. It would be reported
     * UNDETERMINED for ever, and a spec full of permanently undecidable
     * assertions is a spec that looks thorough and proves nothing.
     */
    const inapplicable = spec.assertInvariants.filter(
      (invariant) => !invariantApplies(invariant, spec.fault),
    );
    if (inapplicable.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['assertInvariants'],
        message:
          `${inapplicable.join(', ')} do not bear on ${spec.fault}, so they could only ever be ` +
          'reported UNDETERMINED — drop them or change the fault',
      });
    }
  });
export type ChaosScenarioSpec = z.infer<typeof chaosScenarioSpecSchema>;

/**
 * The two invariants a lifted spec gains, and WHY it is not silent.
 *
 * `chaosTestSpecSchema` in packages/shared/src/schemas.ts carries
 * `expectVisible` and `expectNotVisible` — two text assertions — and cannot
 * express an invariant at all. Both of these need NO evidence and apply to
 * every fault, so they are assertable on any lifted spec, and both catch
 * defects the stored pair passes straight over: a stack trace satisfies
 * `expectVisible` whenever it contains the expected word, and a bounce to the
 * dashboard satisfies it on the next page.
 *
 * Exported, and recorded as a step on every lifted run, because adding an
 * assertion the author did not write is a surprise if it is quiet. It must be
 * readable in the result, not inferred from this file.
 */
export const LIFT_ADDED_INVARIANTS: readonly ChaosInvariant[] = [
  'STAYS_ON_ROUTE',
  'NO_RAW_STACK_TRACE',
];

export interface LiftedChaosSpec {
  spec: ChaosScenarioSpec;
  /** What the lift had to decide, printable verbatim. Never empty. */
  notes: string[];
}

/**
 * Does this invariant bear on this fault?
 *
 * EMPTY MEANS EVERY FAULT, the same convention
 * `FAULT_ASSERTION_DESCRIPTORS.states` uses in fault-scenarios.ts. One function
 * rather than the three-line check written out at each site: it was written out
 * twice, the schema's copy and the lift's copy disagreed about the empty case,
 * and the lift produced specs the schema refused.
 */
export function invariantApplies(invariant: ChaosInvariant, fault: ChaosFaultKind): boolean {
  const faults = CHAOS_INVARIANT_DESCRIPTORS[invariant].faults;
  return faults.length === 0 || faults.includes(fault);
}

/**
 * Lift a STORED chaos spec into the scenario this plugin executes.
 *
 * The stored shape is narrower in four ways, and each one is resolved from a
 * FACT rather than from a default:
 *
 *   · no method          → the idempotent set, which is the injection rule
 *                          itself and the only safe reading of silence.
 *   · no origin list     → the run's own base URL origin, passed in by the
 *                          caller. Invented origins are how a fault escapes
 *                          onto somebody else's host.
 *   · a URL glob, not a  → the path portion only, because a stored pattern may
 *     path glob             carry a query and a matcher may not hold one.
 *   · text assertions    → `expectVisible` IS `ERROR_IS_NAMED` with the text
 *                          supplied by the author instead of by a crawl, and
 *                          `expectNotVisible` IS `NO_FALSE_SUCCESS`. The lift
 *                          is exact, not approximate.
 *
 * `seed` comes from the run's determinism block, so two runs of the same suite
 * make the same choices.
 */
export function liftStoredChaosSpec(
  stored: {
    path: string;
    urlPattern: string;
    fault: ChaosFault;
    delayMs: number | null;
    expectVisible: string;
    expectNotVisible?: string | undefined;
  },
  context: { baseUrlOrigin: string; seed: string },
): LiftedChaosSpec {
  const fault = STORED_FAULT_SPELLING[stored.fault];
  const notes: string[] = [];
  const invariants = new Set<ChaosInvariant>();

  invariants.add('ERROR_IS_NAMED');
  notes.push(
    `expectVisible became ERROR_IS_NAMED — the application's own wording, asserted verbatim.`,
  );
  if (stored.expectNotVisible !== undefined) {
    invariants.add('NO_FALSE_SUCCESS');
    notes.push('expectNotVisible became NO_FALSE_SUCCESS — the application must not claim success.');
  }
  for (const added of LIFT_ADDED_INVARIANTS) {
    if (CHAOS_INVARIANT_DESCRIPTORS[added].needs !== 'NONE') continue;
    invariants.add(added);
  }
  notes.push(
    `This stored spec also gained ${LIFT_ADDED_INVARIANTS.join(' and ')}: both need no evidence, ` +
      'both apply to every fault, and the stored spec cannot express either.',
  );

  /*
   * ERROR_IS_NAMED does not bear on every fault — a held response shows a
   * spinner, not an error — so a lift onto such a fault drops it and says so
   * rather than producing a spec `chaosScenarioSpecSchema` refuses.
   *
   * THE FLOOR IS NOT ADDED BLINDLY. The first version fell back to
   * SOME_ERROR_SHOWN unconditionally, and SOME_ERROR_SHOWN does not bear on a
   * HOLD fault either, so a lifted SLOW_RESPONSE spec was refused by the very
   * schema that produced it. Where no error-shaped assertion applies the lift
   * SAYS the stored text assertion could not be converted, which is the honest
   * answer: the remaining invariants are the ones that need no evidence.
   */
  if (!invariantApplies('ERROR_IS_NAMED', fault)) {
    invariants.delete('ERROR_IS_NAMED');
    notes.push(
      `ERROR_IS_NAMED was dropped: ${fault} is not an error from the application's point of view, ` +
        'so the assertion could only ever be UNDETERMINED here.',
    );
    if (invariantApplies('SOME_ERROR_SHOWN', fault)) {
      invariants.add('SOME_ERROR_SHOWN');
      notes.push('The WEAK floor SOME_ERROR_SHOWN was put in its place, and it proves very little.');
    } else {
      notes.push(
        `No error-shaped assertion bears on ${fault}, so this stored spec's expectVisible text ` +
          'could not be converted into one at all. What is left is what needs no evidence.',
      );
    }
  }

  const options: ChaosFaultOptions = {
    retryAfterSeconds: null,
    throttleProfile: null,
    emptyEnvelope: null,
    dropFields: [],
    clockSkewSeconds: null,
    websocketUrlGlob: null,
  };
  for (const option of CHAOS_FAULT_DESCRIPTORS[fault].requires) {
    if (option === 'throttleProfile') {
      /*
       * The stored spec's `delayMs` is a NUMBER and this plugin holds the
       * response on a CONDITION, so the figure is not converted into a sleep.
       * It is carried as the profile's name so the report still says what the
       * author asked for — the same choice `FaultInterception.declaredDelayMillis`
       * makes in fault-scenarios.ts.
       */
      options.throttleProfile = stored.delayMs === null ? 'NO_THROTTLING' : `DECLARED_${stored.delayMs}MS`;
      notes.push(
        `delayMs ${String(stored.delayMs)} became the declared profile ` +
          `"${options.throttleProfile}": the response is released on a condition, never after a ` +
          'fixed sleep, and the figure is kept so the report says what was asked for.',
      );
      continue;
    }
    if (option === 'emptyEnvelope') {
      options.emptyEnvelope = '[]';
      notes.push(
        'emptyEnvelope defaulted to `[]`: the stored spec cannot name the application\'s own ' +
          'empty envelope, so a shape-specific one has to come from a widened spec.',
      );
      continue;
    }
  }

  const spec = chaosScenarioSpecSchema.parse({
    path: stored.path,
    target: { methods: [...IDEMPOTENT_METHODS], pathGlob: requestPathOf(stored.urlPattern) },
    fault,
    assertInvariants: CHAOS_INVARIANT_LIST.filter((kind) => invariants.has(kind)),
    evidence: {
      ownErrorText: stored.expectVisible,
      ...(stored.expectNotVisible === undefined
        ? {}
        : { ownSuccessText: stored.expectNotVisible }),
    },
    options,
    ownOrigins: [context.baseUrlOrigin],
    seed: context.seed,
  });

  notes.push(
    `The matcher is the path portion of "${stored.urlPattern}" and the methods are the idempotent ` +
      `set; the origin is the run's own (${context.baseUrlOrigin}).`,
  );
  return { spec, notes };
}

// ─── 5. Matching ─────────────────────────────────────────────────────────────

/**
 * The path a matcher compares against: no query, no fragment.
 *
 * NOT `normaliseUrl` from ../har.js, and the difference is deliberate. That
 * function builds a RECORDING KEY — it keeps the host, sorts the surviving
 * query parameters and drops only the volatile ones, because a replay has to
 * serve the same response for the same request. A fault matcher is a stored,
 * rendered, exported pattern, and the privacy rule `normaliseRequestPath` in
 * packages/agent/src/crawl/variants.ts enforces says it may never hold a query
 * value. Two functions, two jobs, three lines each.
 */
export function requestPathOf(raw: string): string {
  const withoutFragment = raw.split('#')[0] ?? '';
  const withoutQuery = withoutFragment.split('?')[0] ?? '';
  if (!withoutQuery.includes('://')) return withoutQuery;
  try {
    return new URL(withoutQuery).pathname;
  } catch {
    return withoutQuery;
  }
}

/** The origin of a URL, or null when it is relative or unreadable. */
export function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export interface ChaosRequest {
  method: string;
  url: string;
  headers: Readonly<Record<string, string>>;
}

/**
 * Does this scenario claim this request?
 *
 * Origin is checked as well as path, and not as a formality: a glob like
 * `/api/*` matches the application's own call AND the third-party analytics
 * call that happens to share the shape. Failing the second tests somebody
 * else's surface.
 */
export function claimsRequest(spec: ChaosScenarioSpec, request: ChaosRequest): boolean {
  const method = request.method.toUpperCase();
  if (!spec.target.methods.some((m) => m.toUpperCase() === method)) return false;
  const origin = originOf(request.url);
  if (origin !== null && !spec.ownOrigins.includes(origin)) return false;
  return matchesGlob(spec.target.pathGlob, requestPathOf(request.url));
}

/**
 * Whether this scenario may be run at all, and WHICH rule decided.
 *
 * Checked BEFORE the browser is touched and before any connection is made,
 * which is the point: `classifyHost` exists so a private, loopback or
 * link-local target is refused rather than resolved.
 */
export function injectionRefusal(spec: ChaosScenarioSpec): ChaosRefusal | null {
  const forbidden = spec.target.methods.filter(
    (method) => !IDEMPOTENT_METHODS.includes(method.toUpperCase()),
  );
  if (forbidden.length > 0) {
    return {
      reason: 'NON_IDEMPOTENT_TARGET',
      rule: `${forbidden.join(', ')} — ${NON_IDEMPOTENT_RULE}`,
    };
  }

  for (const origin of spec.ownOrigins) {
    const parsed = originOf(origin) === null ? null : new URL(origin);
    if (parsed === null) {
      return {
        reason: 'UNREADABLE_TARGET',
        rule: `"${origin.slice(0, 120)}" is not an origin QAAI can read, so it cannot be classified before connecting`,
      };
    }
    const host = classifyHost(parsed.hostname);
    if (host.kind === 'ambiguous') {
      return {
        reason: 'UNREADABLE_TARGET',
        rule: `${parsed.origin.slice(0, 120)} — ${host.why}`,
      };
    }
    if (host.kind === 'address' && host.class !== 'public') {
      return {
        reason: 'PRIVATE_TARGET',
        rule: `${parsed.origin.slice(0, 120)} resolves to a ${host.class} address, which a hosted run may not reach`,
      };
    }
    if (host.kind === 'name' && host.internal) {
      return {
        reason: 'PRIVATE_TARGET',
        rule: `${parsed.origin.slice(0, 120)} is an internal network name, which a hosted run may not reach`,
      };
    }
  }
  return null;
}

// ─── 6. What the route handler does ──────────────────────────────────────────

/**
 * A write the interceptor SAW. Counting is all that happens to it.
 *
 * `keyGroup` is an INDEX and never the key. Two requests carrying the same
 * idempotency key share a group number; a request with no key has group null.
 * That is everything {@link NO_DUPLICATE_WRITE} needs — equality — and it keeps
 * a client-generated value out of the result, the logs and the artifacts. A
 * digest would have been reversible for a short key; an index is not a function
 * of the value at all.
 */
export interface ObservedWrite {
  method: string;
  path: string;
  /** Null when the request carried no idempotency key. */
  keyGroup: number | null;
}

/**
 * Headers that carry a client-supplied idempotency key.
 *
 * Only the presence and the equality of the value is ever read. `x-request-id`
 * is deliberately NOT here: a trace id changes per attempt by design, and
 * reading one as an idempotency key would report every correct retry as keyed.
 */
export const IDEMPOTENCY_HEADERS: readonly string[] = [
  'idempotency-key',
  'x-idempotency-key',
  'idempotency_key',
];

export interface ChaosInjectionState {
  /** Requests the pattern claimed AND the fault was applied to. */
  claimed: number;
  /** Matching requests let through because the cap had bitten. */
  overCap: number;
  writes: ObservedWrite[];
  /** Set when applying the fault threw or the upstream fetch failed. */
  failure: string | null;
  /** False once the orchestrator disarms the fault, for the retry leg. */
  armed: boolean;
}

export function emptyInjectionState(): ChaosInjectionState {
  return { claimed: 0, overCap: 0, writes: [], failure: null, armed: true };
}

/** A held response, released on a CONDITION. No clock is read anywhere. */
export interface ChaosHold {
  /** Resolves when {@link release} is called. */
  wait(): Promise<void>;
  release(): void;
  /** How many requests are currently held. */
  pending(): number;
}

export function createHold(): ChaosHold {
  const waiters: Array<() => void> = [];
  let released = false;
  return {
    wait(): Promise<void> {
      if (released) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    release(): void {
      released = true;
      while (waiters.length > 0) waiters.pop()?.();
    },
    pending(): number {
      return waiters.length;
    },
  };
}

const JSON_CONTENT_TYPE = 'application/json';

/**
 * The body MALFORMED_JSON serves.
 *
 * An HTML error page under a JSON content type, because that is what a proxy, a
 * captive portal and a WAF actually return — not `{`, which only exercises the
 * parser's first character and is not a shape any dependency produces.
 */
export const MALFORMED_JSON_BODY =
  '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>502</body></html>';

/** Drop the named fields from a JSON body, for SHAPE_DRIFT. Nested keys too. */
export function dropJsonFields(body: string, fields: readonly string[]): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const names = new Set(fields);
  const strip = (node: unknown, depth: number): unknown => {
    if (depth > 8 || node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((entry) => strip(entry, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (names.has(key)) continue;
      out[key] = strip(value, depth + 1);
    }
    return out;
  };
  return JSON.stringify(strip(parsed, 0));
}

/**
 * Cut a body in half, keeping the Content-Length the client was promised.
 *
 * The overstated length is the fault: a body that is simply shorter is a
 * well-formed small response, and the defect being hunted is the SHORT READ —
 * the parser that waits for bytes that never come, or takes what arrived as
 * complete.
 */
export function truncateBody(body: string): { body: string; declaredLength: number } {
  const declaredLength = Buffer.byteLength(body, 'utf8');
  return { body: body.slice(0, Math.floor(body.length / 2)), declaredLength };
}

/**
 * Install the fault on one claimed request.
 *
 * NOTHING IN HERE MAY THROW OUT. A bug in QAAI's interception must not become a
 * failing test for the customer's application — the same rule har.ts's
 * `installHar` states. Every failure lands in `state.failure`, which the
 * orchestrator turns into INJECTION_FAILED: an honest "we could not break it",
 * never a verdict.
 */
export async function applyFault(
  route: HarRoute,
  spec: ChaosScenarioSpec,
  state: ChaosInjectionState,
  hold: ChaosHold,
): Promise<void> {
  const descriptor = CHAOS_FAULT_DESCRIPTORS[spec.fault];
  try {
    switch (descriptor.verb) {
      case 'ABORT':
        await route.abort(spec.fault === 'CONNECTION_REFUSED' ? 'connectionrefused' : 'internetdisconnected');
        return;
      case 'HOLD':
        /*
         * Held until the orchestrator has looked at the screen, then released.
         * `NO_RESPONSE` is released the same way and for the same reason: the
         * alternative is a handler that never returns, which leaks a pending
         * route into the next test.
         */
        await hold.wait();
        await route.abort('timedout');
        return;
      case 'FULFILL': {
        const headers: Record<string, string> = {};
        if (spec.options.retryAfterSeconds !== null) {
          headers['retry-after'] = String(spec.options.retryAfterSeconds);
        }
        if (spec.fault === 'MALFORMED_JSON') {
          await route.fulfill({
            status: descriptor.status ?? 200,
            headers: { ...headers, 'content-type': JSON_CONTENT_TYPE },
            body: MALFORMED_JSON_BODY,
          });
          return;
        }
        if (spec.fault === 'EMPTY_BODY') {
          await route.fulfill({
            status: descriptor.status ?? 200,
            headers: { ...headers, 'content-type': JSON_CONTENT_TYPE },
            body: '',
          });
          return;
        }
        if (spec.fault === 'EMPTY_COLLECTION') {
          await route.fulfill({
            status: descriptor.status ?? 200,
            headers: { ...headers, 'content-type': JSON_CONTENT_TYPE },
            body: spec.options.emptyEnvelope ?? '[]',
          });
          return;
        }
        await route.fulfill({
          status: descriptor.status ?? 500,
          headers,
          body: '',
        });
        return;
      }
      case 'MUTATE_REAL': {
        /*
         * The real response is needed first: a truncation and a shape drift are
         * only meaningful against the body the application actually gets. A
         * synthetic one would test the parser rather than the deploy.
         */
        const response = await route.fetch();
        const raw = Buffer.from(await response.body()).toString('utf8');
        if (spec.fault === 'TRUNCATED_BODY') {
          const cut = truncateBody(raw);
          await route.fulfill({
            status: response.status(),
            headers: { ...response.headers(), 'content-length': String(cut.declaredLength) },
            body: cut.body,
          });
          return;
        }
        const drifted = dropJsonFields(raw, spec.options.dropFields);
        if (drifted === null) {
          /*
           * Not a pass and not a failure. The dependency did not answer with
           * JSON, so the fields named in the spec cannot be dropped and the
           * fault was not injected — the request is let through untouched so
           * the application sees its real response rather than a broken one we
           * invented.
           */
          state.failure =
            `${spec.fault} needs a JSON body to remove ${spec.options.dropFields.join(', ')} from, ` +
            'and the dependency answered with something else — nothing was injected';
          await route.continue();
          return;
        }
        await route.fulfill({
          status: response.status(),
          headers: response.headers(),
          body: drifted,
        });
        return;
      }
      case 'OUT_OF_BAND':
        /*
         * Unreachable through the route handler by construction: a fault whose
         * verb is OUT_OF_BAND never gets a handler installed, because
         * `capabilityGap` refuses the scenario first. Written out rather than
         * left to fall through so that a sixteenth fault misfiled as
         * OUT_OF_BAND is recorded instead of silently continuing the request.
         */
        state.failure = `${spec.fault} is an out-of-band fault and has no route handler`;
        await route.continue();
        return;
    }
  } catch (err) {
    state.failure = `applying ${spec.fault} failed: ${errorText(err)}`;
    try {
      await route.continue();
    } catch {
      /* the request is already answered or the context is gone; nothing to do */
    }
  }
}

/**
 * The route handler. ONE of them, built on har.ts's `HarRoute`.
 *
 * Three things happen here and nothing else: a claimed request gets the fault,
 * a non-idempotent request gets COUNTED and continued, and everything else is
 * continued untouched. A handler that aborted what it did not recognise would
 * make the application's own assets fail and every invariant meaningless.
 */
export function chaosRouteHandler(
  spec: ChaosScenarioSpec,
  state: ChaosInjectionState,
  hold: ChaosHold,
): (route: HarRoute) => Promise<void> {
  /*
   * Equality without the value: a key's first sighting gets the next group
   * number and later sightings get the same one. The map holds the key, in
   * memory, for the length of one scenario; nothing derived from it leaves this
   * function except an integer.
   */
  const keyGroups = new Map<string, number>();

  return async (route: HarRoute): Promise<void> => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const url = request.url();
    const headers = request.headers();

    if (!IDEMPOTENT_METHODS.includes(method)) {
      const headerName = IDEMPOTENCY_HEADERS.find(
        (name) => (headers[name] ?? '').trim().length > 0,
      );
      let keyGroup: number | null = null;
      if (headerName !== undefined) {
        const value = (headers[headerName] ?? '').trim();
        const existing = keyGroups.get(value);
        if (existing === undefined) {
          keyGroup = keyGroups.size + 1;
          keyGroups.set(value, keyGroup);
        } else {
          keyGroup = existing;
        }
      }
      state.writes.push({ method, path: requestPathOf(url), keyGroup });
      await route.continue();
      return;
    }

    if (!state.armed || !claimsRequest(spec, { method, url, headers })) {
      await route.continue();
      return;
    }

    if (state.claimed >= spec.maxInterceptions) {
      state.overCap += 1;
      await route.continue();
      return;
    }

    state.claimed += 1;
    await applyFault(route, spec, state, hold);
  };
}

export function capBiteFor(spec: ChaosScenarioSpec, state: ChaosInjectionState): ChaosCapBite | null {
  if (state.overCap === 0) return null;
  return {
    cap: 'INTERCEPTIONS',
    limit: spec.maxInterceptions,
    bites: state.overCap,
    discarded: state.overCap,
    reason:
      `${state.overCap} further request(s) matched this fault and were let through unfaulted ` +
      `because maxInterceptions is ${spec.maxInterceptions}. Raise it on the spec if the flow ` +
      'genuinely makes that many calls.',
  };
}

// ─── 7. The page surface ─────────────────────────────────────────────────────

/**
 * One reading of the screen. Every member nullable, and NULL IS NOT FALSE —
 * it means the probe could not answer, which is UNDETERMINED and never a pass.
 */
export interface ChaosProbeReading {
  /** The route the browser is on. */
  route: string | null;
  /** Visible text, redacted by the adapter before it gets here. */
  visibleText: string | null;
  /** Whether a busy/loading indicator is on screen RIGHT NOW. */
  busyIndicatorVisible: boolean | null;
  /** Field name → current value. Values are compared and never reported. */
  fieldValues: Readonly<Record<string, string | null>> | null;
  /** Unhandled errors the console recorded since the probe was installed. */
  consoleErrors: readonly string[] | null;
  retryControlPresent: boolean | null;
}

export function emptyReading(): ChaosProbeReading {
  return {
    route: null,
    visibleText: null,
    busyIndicatorVisible: null,
    fieldValues: null,
    consoleErrors: null,
    retryControlPresent: null,
  };
}

/**
 * Everything this plugin needs from a browser, as a narrow interface.
 *
 * No `Page`, no `BrowserContext`, no `fetch` and no `child_process`. The route
 * handler it is handed is the one from {@link chaosRouteHandler}, typed in
 * har.ts's own structural terms, so the adapter's only job is to pass
 * Playwright's `Route` object through.
 */
export interface ChaosPageSurface {
  /** What this deployment can actually do. An EMPTY list is honest, not broken. */
  capabilities(): Promise<readonly ChaosCapability[]>;
  goto(path: string): Promise<void>;
  route(pathGlob: string, handler: (route: HarRoute) => Promise<void>): Promise<void>;
  /** Read the screen. `fieldNames` are the ones NO_INPUT_LOSS compares. */
  read(fieldNames: readonly string[]): Promise<ChaosProbeReading>;
  /** Type into the named fields, so there is something to lose. */
  fill(values: Readonly<Record<string, string>>): Promise<void>;
  /** Click the retry control. False when it was not there to click. */
  clickRetry(identity: string): Promise<boolean>;
  /**
   * Apply a fault that is not a request. False when this surface cannot, and
   * false is reported as UNAVAILABLE rather than as a fault that did nothing.
   */
  applyOutOfBand(fault: ChaosFaultKind, options: ChaosFaultOptions): Promise<boolean>;
}

const NO_ADAPTER =
  'No browser adapter is configured for CHAOS on this deployment. The fault library and the ' +
  'invariants are complete and tested; injecting them needs a browser context that can route ' +
  'requests. Nothing was measured.';

/**
 * The surface that cannot see anything.
 *
 * `capabilities()` returns an EMPTY LIST and `read()` returns all-nulls, which
 * together are the only safe default: a stub that reported ROUTE_INTERCEPTION
 * and an empty screen would make every invariant on every CHAOS test resolve
 * against nothing at all, and the percentage would move on the strength of a
 * fake. That is worse than having no plugin.
 */
export const unavailableChaosPage: ChaosPageSurface = {
  capabilities(): Promise<readonly ChaosCapability[]> {
    return Promise.resolve([]);
  },
  goto(): Promise<void> {
    return Promise.reject(new Error(NO_ADAPTER));
  },
  route(): Promise<void> {
    return Promise.reject(new Error(NO_ADAPTER));
  },
  read(): Promise<ChaosProbeReading> {
    return Promise.resolve(emptyReading());
  },
  fill(): Promise<void> {
    return Promise.reject(new Error(NO_ADAPTER));
  },
  clickRetry(): Promise<boolean> {
    return Promise.resolve(false);
  },
  applyOutOfBand(): Promise<boolean> {
    return Promise.resolve(false);
  },
};

export interface ChaosDeps {
  page: ChaosPageSurface;
}

let deps: ChaosDeps = { page: unavailableChaosPage };

/** Install the page surface. Returns the previous set, so a test restores it. */
export function setChaosDeps(next: ChaosDeps): ChaosDeps {
  const previous = deps;
  deps = next;
  return previous;
}

// ─── 8. Evaluating the invariants ────────────────────────────────────────────

/**
 * Text that is a stack trace rather than a message, in five dialects.
 *
 * Deterministic and model-free on purpose: this has to work with no API key,
 * and a regex that recognises `    at Object.<anonymous> (/srv/app/x.js:4:11)`
 * is not the sort of judgement a model improves. Each pattern is anchored on
 * the FRAME syntax rather than on the word "error", because "Error" appears in
 * every well-written error message too.
 */
export const STACK_TRACE_PATTERNS: readonly RegExp[] = [
  /\n\s*at\s+[\w$.<>[\]]+\s*\(/,
  /\n\s*at\s+(?:\/|[A-Za-z]:\\|https?:\/\/)/,
  /Traceback \(most recent call last\)/,
  /\n\s*at\s+[\w.$]+\([\w$]+\.java:\d+\)/,
  /\bgoroutine \d+ \[/,
  /webpack-internal:\/\/\//,
  /\/node_modules\/[\w@./-]+:\d+:\d+/,
];

export function looksLikeStackTrace(text: string): boolean {
  return STACK_TRACE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Tokens that are an unrendered value leaking onto the screen.
 *
 * `undefined`, `NaN` and `[object Object]` are what a missing field becomes
 * when it reaches a template, and all three are visible to a user and invisible
 * to every happy-path test.
 */
export const PARTIAL_RENDER_TOKENS: readonly RegExp[] = [
  /\bundefined\b/,
  /\bNaN\b/,
  /\[object Object\]/,
];

/**
 * Words that make text error-shaped, for the WEAK floor assertion only.
 *
 * ENGLISH-BIASED, AND THAT IS A STATED LIMIT rather than a hidden one: on a
 * non-English application the floor can report VIOLATED against a perfectly
 * good localised error message. It is the reason the floor is WEAK, the reason
 * `ERROR_IS_NAMED` exists, and the reason the handover lists the locale-aware
 * version as a follow-up. A STRONG assertion is never built on this list.
 */
export const ERROR_SHAPED_WORDS: readonly string[] = [
  'error',
  'failed',
  'failure',
  'unavailable',
  'something went wrong',
  'try again',
  'could not',
  "couldn't",
  'unable to',
  'problem',
];

function errorShaped(text: string): boolean {
  const lower = text.toLowerCase();
  return ERROR_SHAPED_WORDS.some((word) => lower.includes(word));
}

/**
 * Whether the evidence an invariant needs is present. THREE answers.
 *
 * `true` the fact was captured and is usable; `false` the crawl looked and this
 * page has none; `null` nobody captured it. The second and third both block the
 * assertion and they are reported with DIFFERENT reasons — see
 * {@link UNDETERMINED_REASONS}.
 */
export function evidenceHeld(
  evidence: ChaosEvidence,
  need: ChaosEvidenceNeed,
): boolean | null {
  switch (need) {
    case 'NONE':
      return true;
    case 'TYPED_FIELDS': {
      const names = evidence.typedFieldNames;
      if (names === undefined) return null;
      return names.length > 0;
    }
    case 'OWN_ERROR_TEXT': {
      if (!('ownErrorText' in evidence)) return null;
      return (evidence.ownErrorText ?? '').length > 0;
    }
    case 'OWN_SUCCESS_TEXT': {
      if (!('ownSuccessText' in evidence)) return null;
      return (evidence.ownSuccessText ?? '').length > 0;
    }
    case 'LOADING_STATE_SEEN':
      return evidence.loadingStateSeen ?? null;
    case 'POPULATED_STATE_SEEN':
      return evidence.populatedStateSeen ?? null;
    case 'RETRY_CONTROL': {
      if (!('retryControl' in evidence)) return null;
      return evidence.retryControl !== null && evidence.retryControl !== undefined;
    }
    case 'CONSOLE_CHANNEL':
      return evidence.consoleChannelWorked ?? null;
    case 'WRITE_REQUESTS_OBSERVABLE':
      return evidence.writeRequestsObservable ?? null;
  }
}

function undetermined(
  invariant: ChaosInvariant,
  reason: UndeterminedReason,
  extra?: string,
): ChaosInvariantResult {
  const base = UNDETERMINED_REASON_DETAIL[reason];
  return {
    invariant,
    verdict: 'UNDETERMINED',
    strength: CHAOS_INVARIANT_DESCRIPTORS[invariant].strength,
    detail: extra === undefined ? base : `${base} — ${extra}`,
    undetermined: reason,
  };
}

function decided(
  invariant: ChaosInvariant,
  verdict: 'HELD' | 'VIOLATED',
  detail: string,
): ChaosInvariantResult {
  return {
    invariant,
    verdict,
    strength: CHAOS_INVARIANT_DESCRIPTORS[invariant].strength,
    detail,
    undetermined: null,
  };
}

/**
 * The duplicate-write verdict, separated out because it is the one with money
 * attached and the one whose arithmetic a reviewer will want to read.
 *
 * Grouped by (method, path). Within a group:
 *   · one request            → HELD. Nothing was repeated.
 *   · repeats, one key       → HELD. That is a KEYED retry, which is correct
 *                              behaviour and the thing a well-built client does.
 *   · repeats, no key        → VIOLATED. Two unkeyed writes are two writes.
 *   · repeats, several keys  → VIOLATED. Distinct keys are distinct operations,
 *                              so the server has no way to collapse them.
 *   · no writes at all       → UNDETERMINED(NO_WRITE_IN_FLOW). There was
 *                              nothing that could have duplicated, and calling
 *                              that a pass would count every read-only page as
 *                              proof that the money path is safe.
 */
export function duplicateWriteVerdict(writes: readonly ObservedWrite[]): ChaosInvariantResult {
  if (writes.length === 0) {
    return undetermined('NO_DUPLICATE_WRITE', 'NO_WRITE_IN_FLOW');
  }
  const groups = new Map<string, ObservedWrite[]>();
  for (const write of writes) {
    const key = `${write.method} ${write.path}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [write]);
    else bucket.push(write);
  }

  const offenders: string[] = [];
  for (const [key, bucket] of groups) {
    if (bucket.length < 2) continue;
    const keyGroups = new Set(bucket.map((write) => write.keyGroup));
    const unkeyed = bucket.some((write) => write.keyGroup === null);
    if (unkeyed) {
      offenders.push(
        `${key} was issued ${bucket.length} times with no idempotency key, so the server cannot ` +
          'tell a retry from a second write',
      );
      continue;
    }
    if (keyGroups.size > 1) {
      offenders.push(
        `${key} was issued ${bucket.length} times under ${keyGroups.size} different idempotency ` +
          'keys, so they are distinct operations rather than one retried',
      );
    }
  }

  if (offenders.length > 0) {
    return decided('NO_DUPLICATE_WRITE', 'VIOLATED', offenders.join('; '));
  }
  const repeated = [...groups.values()].filter((bucket) => bucket.length > 1).length;
  return decided(
    'NO_DUPLICATE_WRITE',
    'HELD',
    repeated === 0
      ? `${writes.length} write(s) observed, none repeated.`
      : `${repeated} write(s) were repeated and every repeat carried the same idempotency key, which is a keyed retry.`,
  );
}

export interface InvariantInput {
  fault: ChaosFaultKind;
  evidence: ChaosEvidence;
  before: ChaosProbeReading;
  /** The screen under the fault. */
  after: ChaosProbeReading;
  /** The screen after the retry control was driven, or null when it was not. */
  afterRetry: ChaosProbeReading | null;
  writes: readonly ObservedWrite[];
}

/**
 * Decide ONE invariant.
 *
 * The order of the guards is the honesty rule: applicability first, then
 * evidence, then the probe. Each of the three produces a DIFFERENT
 * UNDETERMINED reason, and only after all three pass is anything claimed about
 * the application.
 */
export function evaluateInvariant(
  invariant: ChaosInvariant,
  input: InvariantInput,
): ChaosInvariantResult {
  const descriptor = CHAOS_INVARIANT_DESCRIPTORS[invariant];

  if (!invariantApplies(invariant, input.fault)) {
    return undetermined(
      invariant,
      'NOT_APPLICABLE_TO_FAULT',
      `${invariant} does not bear on ${input.fault}`,
    );
  }

  const held = evidenceHeld(input.evidence, descriptor.needs);
  if (held === null) {
    return undetermined(invariant, 'EVIDENCE_NOT_CAPTURED', `it needs ${descriptor.needs}`);
  }
  if (held === false) {
    return undetermined(invariant, 'EVIDENCE_ABSENT', `it needs ${descriptor.needs}`);
  }

  switch (invariant) {
    case 'NO_INPUT_LOSS': {
      const before = input.before.fieldValues;
      const after = input.after.fieldValues;
      if (before === null || after === null) {
        return undetermined(invariant, 'PROBE_UNAVAILABLE', 'the field values could not be read');
      }
      /*
       * FIELD NAMES ONLY in the detail. The values are compared here and never
       * reported: a form holds exactly the things this file may not print.
       */
      const lost = (input.evidence.typedFieldNames ?? []).filter((name) => {
        const was = before[name] ?? '';
        const now = after[name] ?? '';
        return was.length > 0 && now !== was;
      });
      return lost.length > 0
        ? decided(invariant, 'VIOLATED', `these fields no longer hold what was typed: ${lost.join(', ')}`)
        : decided(invariant, 'HELD', 'every field still holds what was typed.');
    }

    case 'ERROR_IS_NAMED': {
      const text = input.after.visibleText;
      if (text === null) {
        return undetermined(invariant, 'PROBE_UNAVAILABLE', 'the screen could not be read');
      }
      const expected = input.evidence.ownErrorText ?? '';
      return text.includes(expected)
        ? decided(invariant, 'HELD', "the application's own error wording appeared.")
        : decided(
            invariant,
            'VIOLATED',
            `the application's own error wording did not appear, so either the wrong error was shown or none was`,
          );
    }

    case 'NO_INFINITE_LOADING': {
      const busy = input.after.busyIndicatorVisible;
      if (busy === null) {
        return undetermined(invariant, 'PROBE_UNAVAILABLE', 'the busy indicator could not be read');
      }
      return busy
        ? decided(invariant, 'VIOLATED', 'the loading indicator was still on screen with the fault settled — the page spins for ever.')
        : decided(invariant, 'HELD', 'the loading state resolved.');
    }

    case 'EMPTY_IS_NOT_ERROR': {
      const text = input.after.visibleText;
      if (text === null) {
        return undetermined(invariant, 'PROBE_UNAVAILABLE', 'the screen could not be read');
      }
      const expectedError = input.evidence.ownErrorText ?? null;
      const showedError =
        looksLikeStackTrace(text) || (expectedError !== null && text.includes(expectedError));
      return showedError
        ? decided(invariant, 'VIOLATED', 'an empty collection rendered the error path rather than the empty state.')
        : decided(invariant, 'HELD', 'an empty collection rendered without the error path.');
    }

    case 'RETRY_RECOVERS': {
      if (input.afterRetry === null) {
        return undetermined(invariant, 'PROBE_UNAVAILABLE', 'the retry control was not driven, so nothing was proved about it');
      }
      const text = input.afterRetry.visibleText;
      if (text === null) {
        return undetermined(invariant, 'PROBE_UNAVAILABLE', 'the screen after the retry could not be read');
      }
      const expectedError = input.evidence.ownErrorText ?? null;
      const stillBroken =
        (expectedError !== null && text.includes(expectedError)) || looksLikeStackTrace(text);
      return stillBroken
        ? decided(invariant, 'VIOLATED', 'the retry control left the error on screen, so it did not re-issue the request.')
        : decided(invariant, 'HELD', 'the retry control recovered once the request succeeded.');
    }

    case 'NO_PARTIAL_RENDER': {
      const text = input.after.visibleText;
      if (text === null) {
        return undetermined(invariant, 'PROBE_UNAVAILABLE', 'the screen could not be read');
      }
      const leaked = PARTIAL_RENDER_TOKENS.filter((pattern) => pattern.test(text));
      return leaked.length > 0
        ? decided(invariant, 'VIOLATED', `an unrendered value reached the screen (${leaked.length} token kind(s) matched).`)
        : decided(invariant, 'HELD', 'no unrendered value reached the screen.');
    }

    case 'STAYS_ON_ROUTE': {
      const before = input.before.route;
      const after = input.after.route;
      if (before === null || after === null) {
        return undetermined(invariant, 'PROBE_UNAVAILABLE', 'the route could not be read');
      }
      return before === after
        ? decided(invariant, 'HELD', 'the failure left the user on the same route.')
        : decided(invariant, 'VIOLATED', `the failure moved the user from ${before} to ${after}.`);
    }

    case 'NO_UNHANDLED_RUNTIME_ERROR': {
      const errors = input.after.consoleErrors;
      if (errors === null) {
        return undetermined(invariant, 'PROBE_UNAVAILABLE', 'the console could not be read');
      }
      return errors.length > 0
        ? decided(
            invariant,
            'VIOLATED',
            `${errors.length} unhandled error(s) reached the console; the first is: ${(errors[0] ?? '').slice(0, 200)}`,
          )
        : decided(invariant, 'HELD', 'no unhandled error reached the console.');
    }

    case 'SOME_ERROR_SHOWN': {
      const text = input.after.visibleText;
      if (text === null) {
        return undetermined(invariant, 'PROBE_UNAVAILABLE', 'the screen could not be read');
      }
      const expectedError = input.evidence.ownErrorText ?? null;
      const shown = (expectedError !== null && text.includes(expectedError)) || errorShaped(text);
      return shown
        ? decided(invariant, 'HELD', 'something error-shaped became visible. This is the WEAK floor and proves very little.')
        : decided(invariant, 'VIOLATED', 'nothing error-shaped became visible, so the failure was swallowed.');
    }

    case 'NO_DUPLICATE_WRITE':
      return duplicateWriteVerdict(input.writes);

    case 'NO_RAW_STACK_TRACE': {
      const text = input.after.visibleText;
      if (text === null) {
        return undetermined(invariant, 'PROBE_UNAVAILABLE', 'the screen could not be read');
      }
      return looksLikeStackTrace(text)
        ? decided(invariant, 'VIOLATED', 'a stack trace was rendered to the user.')
        : decided(invariant, 'HELD', 'the failure was reported without a stack trace.');
    }

    case 'NO_FALSE_SUCCESS': {
      const text = input.after.visibleText;
      if (text === null) {
        return undetermined(invariant, 'PROBE_UNAVAILABLE', 'the screen could not be read');
      }
      const success = input.evidence.ownSuccessText ?? '';
      return text.includes(success)
        ? decided(invariant, 'VIOLATED', 'the application reported success while the dependency was failing.')
        : decided(invariant, 'HELD', 'the application did not report success.');
    }
  }
}

// ─── 9. The status rule ──────────────────────────────────────────────────────

export interface ChaosStatusInput {
  outcome: ChaosInjectionOutcome;
  results: readonly ChaosInvariantResult[];
}

export interface ChaosStatus {
  status: TestExecution['status'];
  notRun: { kind: NotRunKind; why: string } | null;
  /** One sentence, printable verbatim. */
  why: string;
}

/**
 * The status, and this is the function the whole plugin is arranged around.
 *
 *   · outcome not in {@link OUTCOMES_THAT_MAY_PASS} → never PASSED. A violated
 *     invariant still FAILS (a REFUSED scenario that somehow produced one is a
 *     real finding and is not thrown away), but "nothing broke and the app was
 *     fine" cannot become green.
 *   · any VIOLATED                                 → FAILED.
 *   · at least one HELD and nothing VIOLATED        → PASSED, with the
 *     undetermined ones disclosed in their own steps.
 *   · nothing HELD and nothing VIOLATED             → SKIPPED. A result made
 *     entirely of UNDETERMINEDs measured nothing, and this is the line a
 *     hurried implementation crosses.
 */
export function chaosStatus(input: ChaosStatusInput): ChaosStatus {
  const violated = input.results.filter((r) => r.verdict === 'VIOLATED');
  const held = input.results.filter((r) => r.verdict === 'HELD');

  if (violated.length > 0) {
    return {
      status: 'FAILED',
      notRun: null,
      why: violated.map((r) => `${r.invariant}: ${r.detail}`).join(' | '),
    };
  }

  if (!OUTCOMES_THAT_MAY_PASS.includes(input.outcome)) {
    /*
     * `?? 'NOT_RUN'` is reachable only for an outcome that is both outside
     * OUTCOMES_THAT_MAY_PASS and mapped to null — which no member is today, and
     * which a sixteenth outcome added carelessly would be. NOT_RUN is the
     * weakest claim available, so the careless case defaults to saying the
     * least rather than to the strongest reading.
     */
    const kind = OUTCOME_NOT_RUN_KIND[input.outcome] ?? 'NOT_RUN';
    const why = `The fault was ${input.outcome}, so nothing about the application was measured.`;
    return { status: 'SKIPPED', notRun: { kind, why }, why };
  }

  if (held.length === 0) {
    return {
      status: 'SKIPPED',
      notRun: {
        kind: 'NOT_RUN',
        why:
          'The fault was injected and not one invariant could be decided, so nothing was ' +
          'measured. The reasons are on the steps.',
      },
      why: 'nothing was measured',
    };
  }

  return {
    status: 'PASSED',
    notRun: null,
    why: `${held.length} invariant(s) held under ${input.results.length} checked.`,
  };
}

// ─── 10. Running one scenario ────────────────────────────────────────────────

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
}

/**
 * The capability this fault needs and this deployment lacks, or null.
 *
 * A fault whose capability is absent is UNAVAILABLE — reported with the remedy
 * and with every invariant it would have asserted listed as not asserted. It is
 * emphatically NOT skipped silently: a percentage that includes a test which
 * can never run is the lie this product cannot afford, and a CLOCK_SKEW test on
 * an image with no clock API is exactly that test.
 */
export function capabilityGap(
  fault: ChaosFaultKind,
  available: readonly ChaosCapability[],
  options: ChaosFaultOptions,
): { capability: ChaosCapability; remedy: string } | null {
  const needed: ChaosCapability[] = ['ROUTE_INTERCEPTION'];
  const own = CHAOS_FAULT_DESCRIPTORS[fault].capability;
  if (own !== null) needed.push(own);
  /*
   * A throttle profile is only a capability when the author named a real one.
   * NO_THROTTLING is a decision, not a request for CDP, and demanding the
   * capability for it would make every SLOW_RESPONSE test UNAVAILABLE on an
   * image that can hold a response perfectly well.
   */
  if (options.throttleProfile !== null && options.throttleProfile !== 'NO_THROTTLING') {
    needed.push('NETWORK_THROTTLE');
  }
  for (const capability of needed) {
    if (!available.includes(capability)) {
      return { capability, remedy: CHAOS_CAPABILITY_REMEDY[capability] };
    }
  }
  return null;
}

/** An assertion that was not made, and why. The vocabulary is @qaai/shared's. */
export interface NotAsserted {
  assertion: string;
  /** `UnassertedReason` in packages/shared/src/test-type-decl.ts. */
  reason: 'CAPABILITY_ABSENT' | 'SURFACE_UNREACHED' | 'CAP_BIT' | 'NOT_IMPLEMENTED';
}

/**
 * Which UNDETERMINED verdicts are HOLES IN A PASS, and which are not.
 *
 * ── Why a PASSED chaos result has to carry this ────────────────────────────
 *
 * A scenario can hold STAYS_ON_ROUTE, fail to decide NO_INPUT_LOSS because
 * nobody captured the page's fields, and be reported PASSED. That is a correct
 * verdict and an incomplete one, and the difference is invisible unless the
 * hole is a VALUE: `UNASSERTED_REASONS` exists in
 * packages/shared/src/test-type-decl.ts precisely so a gate can refuse to count
 * a pass with a stated hole in it. Writing nothing here is the lie.
 *
 * TWO OF THE FIVE ARE NOT HOLES, and mapping them anyway would be a different
 * dishonesty — inflating our own gap list with assertions nobody owes:
 *
 *   EVIDENCE_ABSENT         the crawl looked and this page has no typed fields,
 *                           no retry control, no loading state. There is
 *                           nothing to assert, now or ever, and reporting it as
 *                           unasserted would send somebody to re-crawl a
 *                           read-only dashboard for ever.
 *   NOT_APPLICABLE_TO_FAULT the assertion does not bear on the fault, which the
 *                           spec schema refuses outright. Not a hole either.
 *
 * Null for those two, so the table is total and a sixth reason cannot default
 * into silence.
 */
export const UNDETERMINED_AS_HOLE: Record<UndeterminedReason, NotAsserted['reason'] | null> = {
  EVIDENCE_NOT_CAPTURED: 'SURFACE_UNREACHED',
  EVIDENCE_ABSENT: null,
  NOT_APPLICABLE_TO_FAULT: null,
  PROBE_UNAVAILABLE: 'CAPABILITY_ABSENT',
  NO_WRITE_IN_FLOW: 'SURFACE_UNREACHED',
};

/** The holes in a decided run, as data the gate can read. */
export function holesIn(results: readonly ChaosInvariantResult[]): NotAsserted[] {
  const holes: NotAsserted[] = [];
  for (const result of results) {
    if (result.undetermined === null) continue;
    const reason = UNDETERMINED_AS_HOLE[result.undetermined];
    if (reason === null) continue;
    holes.push({ assertion: CHAOS_INVARIANT_DESCRIPTORS[result.invariant].claim, reason });
  }
  return holes;
}

export interface ChaosScenarioResult {
  outcome: ChaosInjectionOutcome;
  /** Set when the outcome is REFUSED. */
  refusal: ChaosRefusal | null;
  results: ChaosInvariantResult[];
  capBite: ChaosCapBite | null;
  writes: ObservedWrite[];
  claimed: number;
  notAsserted: NotAsserted[];
  /** Sentences a reader needs: lift notes, capability remedies, injection failures. */
  notes: string[];
}

/**
 * Drive one scenario. The browser is injected; nothing here reads a clock.
 *
 * ── The order, and why it is this order ────────────────────────────────────
 *
 *  1. REFUSE before touching anything. A non-idempotent or private target must
 *     not cause a navigation, let alone a request.
 *  2. Probe capabilities. An absent one is UNAVAILABLE with a remedy.
 *  3. Read the screen CLEAN, then type into the fields. There has to be
 *     something to lose before NO_INPUT_LOSS means anything.
 *  4. Arm the fault, navigate, read the screen WHILE the fault is in force —
 *     a held response is read before it is released, because the skeleton is
 *     the thing being asserted about.
 *  5. Release the hold, then drive the retry with the fault DISARMED. "The
 *     retry recovers" is a claim about what happens when the request succeeds;
 *     retrying into the same fault proves nothing.
 */
export async function runChaosScenario(
  spec: ChaosScenarioSpec,
  page: ChaosPageSurface,
): Promise<ChaosScenarioResult> {
  const notes: string[] = [];
  const notAsserted: NotAsserted[] = [];

  const refusal = injectionRefusal(spec);
  if (refusal !== null) {
    return {
      outcome: 'REFUSED',
      refusal,
      results: [],
      capBite: null,
      writes: [],
      claimed: 0,
      notAsserted: spec.assertInvariants.map((invariant) => ({
        assertion: CHAOS_INVARIANT_DESCRIPTORS[invariant].claim,
        reason: 'SURFACE_UNREACHED' as const,
      })),
      notes: [refusal.rule],
    };
  }

  const available = await page.capabilities();
  const gap = capabilityGap(spec.fault, available, spec.options);
  if (gap !== null) {
    return {
      outcome: 'UNAVAILABLE',
      refusal: null,
      results: [],
      capBite: null,
      writes: [],
      claimed: 0,
      notAsserted: spec.assertInvariants.map((invariant) => ({
        assertion: CHAOS_INVARIANT_DESCRIPTORS[invariant].claim,
        reason: 'CAPABILITY_ABSENT' as const,
      })),
      notes: [
        `${spec.fault} needs ${gap.capability}, which this deployment does not have. ${gap.remedy}`,
      ],
    };
  }

  const state = emptyInjectionState();
  const hold = createHold();
  const fieldNames = spec.evidence.typedFieldNames ?? [];

  try {
    await page.goto(spec.path);
    /*
     * Deterministic field contents: derived from the seed and the field NAME,
     * so two runs of the same spec type the same thing and a diff between two
     * runs is a difference in the application. No clock, no Math.random.
     */
    const typed = typedValuesFor(fieldNames, spec.seed);
    if (fieldNames.length > 0) await page.fill(typed);
    const before = await page.read(fieldNames);

    await page.route(spec.target.pathGlob, chaosRouteHandler(spec, state, hold));
    await page.goto(spec.path);
    const after = await page.read(fieldNames);

    hold.release();

    let afterRetry: ChaosProbeReading | null = null;
    const retry = spec.evidence.retryControl;
    if (spec.assertInvariants.includes('RETRY_RECOVERS') && retry !== null && retry !== undefined) {
      state.armed = false;
      const clicked = await page.clickRetry(retry.identity);
      if (clicked) {
        afterRetry = await page.read(fieldNames);
      } else {
        notes.push(
          `The retry control "${retry.label}" was not there to click, so RETRY_RECOVERS could not be driven.`,
        );
      }
    }

    const capBite = capBiteFor(spec, state);
    if (capBite !== null) notes.push(capBite.reason);

    if (state.claimed === 0) {
      /*
       * THE FALSE GREEN, CAUGHT. Nothing matched, so the application was never
       * put under the fault — and every invariant would hold trivially. The
       * invariants are NOT evaluated: evaluating them would produce a list of
       * HELDs that a later reader, or a later refactor, could mistake for
       * evidence.
       */
      if (state.failure !== null) notes.push(state.failure);
      return {
        outcome: 'NOT_INJECTED',
        refusal: null,
        results: [],
        capBite,
        writes: state.writes,
        claimed: 0,
        notAsserted: spec.assertInvariants.map((invariant) => ({
          assertion: CHAOS_INVARIANT_DESCRIPTORS[invariant].claim,
          reason: 'SURFACE_UNREACHED' as const,
        })),
        notes: [
          `No request matched ${spec.target.methods.join('/')} ${spec.target.pathGlob} on ` +
            `${spec.path}, so no fault was injected and the application was never put under one. ` +
            'Check the pattern against what the page actually requests.',
          ...notes,
        ],
      };
    }

    if (state.failure !== null) {
      return {
        outcome: 'INJECTION_FAILED',
        refusal: null,
        results: [],
        capBite,
        writes: state.writes,
        claimed: state.claimed,
        notAsserted: spec.assertInvariants.map((invariant) => ({
          assertion: CHAOS_INVARIANT_DESCRIPTORS[invariant].claim,
          reason: 'SURFACE_UNREACHED' as const,
        })),
        notes: [state.failure, ...notes],
      };
    }

    const input: InvariantInput = {
      fault: spec.fault,
      evidence: spec.evidence,
      before,
      after,
      afterRetry,
      writes: state.writes,
    };
    const results = spec.assertInvariants.map((invariant) => evaluateInvariant(invariant, input));

    /*
     * The holes in a pass, as data. `notAsserted` was an empty array here and
     * the undecided invariants lived only in their step titles — readable by a
     * human and invisible to the gate, which is the half-fix this round's
     * keystone minted `UNASSERTED_REASONS` to end.
     */
    notAsserted.push(...holesIn(results));
    if (capBite !== null) {
      notAsserted.push({
        assertion: `${capBite.discarded} further matching request(s) were left unfaulted`,
        reason: 'CAP_BIT',
      });
    }

    return {
      outcome: 'INJECTED',
      refusal: null,
      results,
      capBite,
      writes: state.writes,
      claimed: state.claimed,
      notAsserted,
      notes,
    };
  } catch (err) {
    /*
     * The adapter threw. That says nothing about the application, so it is
     * INJECTION_FAILED and not FAILED — reporting a red test here would blame
     * the customer's error handling for our broken navigation.
     */
    hold.release();
    return {
      outcome: 'INJECTION_FAILED',
      refusal: null,
      results: [],
      capBite: capBiteFor(spec, state),
      writes: state.writes,
      claimed: state.claimed,
      notAsserted: spec.assertInvariants.map((invariant) => ({
        assertion: CHAOS_INVARIANT_DESCRIPTORS[invariant].claim,
        reason: 'SURFACE_UNREACHED' as const,
      })),
      notes: [`The browser adapter failed while driving this scenario: ${errorText(err)}`, ...notes],
    };
  }
}

/**
 * What to type into each field, derived from the seed and the field NAME.
 *
 * Deterministic by construction, which NO_INPUT_LOSS needs for a different
 * reason than most generators do: the assertion compares what is on screen
 * AFTER with what was typed BEFORE, and a value that differed between two runs
 * would make a loss report un-reproducible. `seededShuffle` from
 * ../determinism.js is the run's own mixer, so this file does not hold a
 * second PRNG.
 */
export function typedValuesFor(
  fieldNames: readonly string[],
  seed: string,
): Record<string, string> {
  const alphabet = seededShuffle(SEED_ALPHABET.split(''), seedNumberFor(seed));
  const out: Record<string, string> = {};
  fieldNames.forEach((name, index) => {
    /*
     * The field NAME is mixed in as well as the index, so renaming a field
     * changes its value and reordering the list does not. The alternative —
     * index only — made two fields swap values when a third was inserted, and a
     * NO_INPUT_LOSS report would then differ between two runs of specs that
     * only differ in field order.
     */
    const rotated = seedNumberFor(`${seed}:${name}:${index}`) % alphabet.length;
    const slice: string[] = [];
    for (let i = 0; i < 8; i += 1) slice.push(alphabet[(rotated + i) % alphabet.length] ?? 'x');
    out[name] = `qaai-${slice.join('')}`;
  });
  return out;
}

/** No `l`, `o`, `0` or `1`: a value a human may have to read back out of a form. */
const SEED_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/**
 * A uint32 from a seed STRING.
 *
 * ── The determinism defect this exists to fix ──────────────────────────────
 *
 * `normalizeSeed` from ../determinism.js takes "any number in", and a seed here
 * is a STRING because it is also a key the agent-side planner writes. It
 * returns NULL for a non-numeric string, so the obvious `normalizeSeed(seed) ??
 * 1` collapsed EVERY textual seed onto the same number: two runs with different
 * seeds typed identical values, and the seed was decorative. The test
 * 'types byte-identical values for the same seed, and different ones for
 * another' caught it.
 *
 * FNV-1a, 32-bit, then handed to `normalizeSeed` for the uint32 and zero
 * handling it already owns, so there is one rule about a zero seed rather than
 * two. The same ten lines appear in `packages/shared/src/synthetic.ts` and
 * `browser-matrix.ts`; both are private to their modules and @qaai/runner
 * exports no string hasher, so this is the third copy rather than a third
 * algorithm — the constants are the published FNV-1a ones and cannot drift
 * without a test going red.
 */
export function seedNumberFor(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return normalizeSeed(hash >>> 0) ?? 1;
}

// ─── 11. The plugin ──────────────────────────────────────────────────────────

/**
 * Turn a scenario result into a `TestExecution`.
 *
 * One step per invariant, so a reader sees twelve named requirements rather
 * than one sentence; one step for the injection itself, so NOT_INJECTED is on
 * screen and not implied; and one step per not-asserted assertion, because the
 * `TestResultVariant.notAsserted` column this belongs in does not exist yet
 * (named in the handover). A hole stated in a step is visible; a hole stated
 * nowhere is the pass that means "we did not check".
 */
export function chaosExecution(
  test: ExecutableTest,
  spec: ChaosScenarioSpec,
  outcome: ChaosScenarioResult,
  startedAtMs: number,
  logger: RunContext['logger'] | null,
): TestExecution {
  const steps: StepResult[] = [];
  const notes: ConsoleEntry[] = [];
  const at = new Date(startedAtMs).toISOString();

  const push = (title: string, status: StepResult['status'], failure: string | null): void => {
    const index = steps.length;
    logger?.step({ testId: test.id, index, title, status });
    steps.push({
      index,
      title,
      status,
      startedAt: at,
      durationMs: 0,
      screenshotKey: null,
      error:
        failure === null
          ? null
          : { message: failure, stack: null, selector: null, expected: null, actual: null },
    });
  };

  const descriptor = CHAOS_FAULT_DESCRIPTORS[spec.fault];
  push(
    `inject: ${descriptor.label} — ${outcome.outcome} (${outcome.claimed} request(s) claimed)`,
    outcome.outcome === 'INJECTED' ? 'PASSED' : 'SKIPPED',
    null,
  );

  for (const result of outcome.results) {
    const claim = CHAOS_INVARIANT_DESCRIPTORS[result.invariant].claim;
    const label = result.strength === 'WEAK' ? `${result.invariant} (WEAK)` : result.invariant;
    push(
      result.verdict === 'HELD'
        ? `${label}: ${claim}`
        : `${label} — ${result.verdict}: ${result.detail}`,
      result.verdict === 'HELD' ? 'PASSED' : result.verdict === 'VIOLATED' ? 'FAILED' : 'SKIPPED',
      result.verdict === 'VIOLATED' ? `${claim} — ${result.detail}` : null,
    );
  }

  /*
   * A hole gets its own step ONLY when no invariant step already carries it.
   * On a decided run every UNDETERMINED invariant is already a SKIPPED step
   * naming its reason, so writing both produced two lines per hole and a
   * reader counting steps saw twice the gaps that exist. The LIST is still
   * complete on the result — that is the gate's channel — and this is the
   * human's.
   */
  if (outcome.results.length === 0) {
    for (const hole of outcome.notAsserted) {
      push(`not asserted — ${hole.reason}: ${hole.assertion}`, 'SKIPPED', null);
    }
  } else {
    for (const hole of outcome.notAsserted.filter((h) => h.reason === 'CAP_BIT')) {
      push(`not asserted — ${hole.reason}: ${hole.assertion}`, 'SKIPPED', null);
    }
  }

  for (const note of outcome.notes) {
    notes.push({ level: 'warn', text: note, at });
  }

  const verdict = chaosStatus({ outcome: outcome.outcome, results: outcome.results });
  /*
   * The outcome's own first note joins the sentence rather than replacing it:
   * "the fault was NOT_INJECTED" is the verdict and "no request matched GET
   * /api/orders" is the thing the reader can act on, and a result carrying only
   * the first sends somebody to read this file.
   */
  const notRun =
    verdict.notRun === null
      ? null
      : {
          kind: verdict.notRun.kind,
          why:
            outcome.notes.length > 0
              ? `${verdict.notRun.why} ${outcome.notes[0] ?? ''}`.trim()
              : verdict.notRun.why,
        };

  return {
    testId: test.id,
    status: verdict.status,
    durationMs: 0,
    steps,
    network: [],
    console: notes,
    videoKey: null,
    traceKey: null,
    errorMessage: verdict.status === 'FAILED' ? verdict.why : (notRun?.why ?? null),
    retriedAndPassed: false,
    findings: [],
    /*
     * `notRun` BELONGS ON THE RESULT and was built here and then left off it —
     * caught by 'is UNAVAILABLE out of the box'. Without it the worker's
     * `parseNotRun` reads null, which is the fifth state meaning "the plugin
     * made no claim about why", and every UNAVAILABLE, REFUSED and NOT_INJECTED
     * chaos result would have reached the database as an untyped skip. The
     * sentence survived in `errorMessage` the whole time, which is exactly how
     * this defect hides: the row looks informative and cannot be grouped.
     */
    notRun,
    metrics: chaosMetrics(outcome),
  };
}

/**
 * The numbers, as data rather than as prose.
 *
 * NULL MEANS NOT MEASURED and carries its reason, which matters most for
 * `chaos_requests_claimed`: a zero there is "the pattern matched nothing", a
 * real and actionable reading, while a null is "we never got as far as
 * installing the handler". Writing 0 for the second would report a refusal and
 * a stale glob as the same fact.
 */
export function chaosMetrics(outcome: ChaosScenarioResult): TestMetric[] {
  const measured = outcome.outcome === 'INJECTED' || outcome.outcome === 'NOT_INJECTED';
  const unavailable = `the fault was ${outcome.outcome}, so no request was ever claimed`;
  return [
    {
      name: 'chaos_requests_claimed',
      value: measured ? outcome.claimed : null,
      unavailableReason: measured ? null : unavailable,
      unit: 'COUNT',
      direction: 'HIGHER_IS_BETTER',
    },
    {
      name: 'chaos_writes_observed',
      value: measured ? outcome.writes.length : null,
      unavailableReason: measured ? null : unavailable,
      unit: 'COUNT',
      direction: 'LOWER_IS_BETTER',
    },
    {
      name: 'chaos_invariants_held',
      value: outcome.results.filter((r) => r.verdict === 'HELD').length,
      unavailableReason: null,
      unit: 'COUNT',
      direction: 'HIGHER_IS_BETTER',
    },
    {
      name: 'chaos_invariants_undetermined',
      value: outcome.results.filter((r) => r.verdict === 'UNDETERMINED').length,
      unavailableReason: null,
      unit: 'COUNT',
      direction: 'LOWER_IS_BETTER',
    },
    {
      name: 'chaos_requests_over_cap',
      value: outcome.capBite?.discarded ?? 0,
      unavailableReason: null,
      unit: 'COUNT',
      direction: 'LOWER_IS_BETTER',
    },
  ];
}

/**
 * Read a test's spec, in either vocabulary.
 *
 * The rich shape is tried first and the STORED shape is lifted when it is what
 * arrived, so a Test row written against `chaosTestSpecSchema` in
 * packages/shared/src/schemas.ts runs today — a plugin that accepted only its
 * own wider shape would be a plugin no producer could reach, which is the
 * defect this entire round exists to remove.
 */
export function parseChaosSpec(
  raw: unknown,
  context: { baseUrlOrigin: string; seed: string },
): LiftedChaosSpec {
  const rich = chaosScenarioSpecSchema.safeParse(raw);
  if (rich.success) return { spec: rich.data, notes: [] };

  const stored = storedChaosShapeSchema.safeParse(raw);
  if (stored.success) return liftStoredChaosSpec(stored.data, context);

  const issues = rich.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  throw new Error(`invalid CHAOS spec — ${issues}`);
}

/**
 * The stored shape, read structurally.
 *
 * NOT `chaosTestSpecSchema` imported from @qaai/shared, and the reason is worth
 * stating: that schema is `.strict()` and carries its own refinements, so it is
 * the right thing to VALIDATE a stored row with and the wrong thing to
 * DISCRIMINATE with — a row that fails one of its refinements would fall
 * through to "invalid rich spec" and the author would be shown an error about
 * fields their spec does not have. This reads the five fields the lift needs and
 * leaves the verdict on the stored shape to the schema that owns it.
 */
const storedChaosShapeSchema = z.object({
  path: z.string().min(1).default('/'),
  urlPattern: z.string().min(1),
  fault: z.enum(CHAOS_FAULTS),
  delayMs: z.number().int().nullable().default(null),
  expectVisible: z.string().min(1),
  expectNotVisible: z.string().min(1).optional(),
});

/**
 * ── WHERE THIS PLUGIN MUST BE REGISTERED ───────────────────────────────────
 *
 * `type` is the LITERAL `'CHAOS'`, which `TEST_TYPES` does not contain, so this
 * goes in `PENDING_PLUGINS` in packages/runner/src/registry.ts and NOT in
 * `PLUGINS` — `promotePendingPlugins` moves it the day the type is minted, with
 * no second edit here. The exact line is in the handover.
 *
 * It is not forced into `SECURITY_SMOKE` or `E2E` to make it reachable sooner.
 * Either would validate a chaos spec against the wrong schema and report what
 * failed under a name that does not describe it.
 */
export const chaosPlugin = {
  type: 'CHAOS' as const,

  validate(test: ExecutableTest): void {
    /*
     * Validated against BOTH vocabularies, with the origin and seed that
     * `execute` will use left out — neither affects whether the spec is
     * well-formed, and a validate that demanded them would refuse a correct
     * stored row before the run that supplies them has started.
     */
    const rich = chaosScenarioSpecSchema.safeParse(test.spec);
    if (rich.success) return;
    const stored = storedChaosShapeSchema.safeParse(test.spec);
    if (stored.success) return;

    const issues = rich.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Chaos test "${test.name}" has an invalid spec — ${issues}`);
  },

  async execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const startedAtMs = Date.now();
    const origin = originOf(ctx.baseUrl) ?? ctx.baseUrl;
    const lifted = parseChaosSpec(test.spec, {
      baseUrlOrigin: origin,
      /*
       * The RUN's seed, not one this plugin invents. `randomSeed` is a number
       * and the spec's seed is a string because it is also a key the agent-side
       * planner writes; `String()` is the whole conversion.
       */
      seed: String(ctx.determinism.randomSeed),
    });
    const outcome = await runChaosScenario(lifted.spec, deps.page);
    outcome.notes.unshift(...lifted.notes);
    const execution = chaosExecution(test, lifted.spec, outcome, startedAtMs, ctx.logger);
    return { ...execution, durationMs: Math.max(0, Date.now() - startedAtMs) };
  },
};
