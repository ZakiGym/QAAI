/**
 * Failure injection and race scenarios — the two halves of testing that the
 * prompts cannot ask for.
 *
 * ── THE TWO DEFECTS THIS FIXES ──────────────────────────────────────────────
 *
 * FIRST: nothing in the generation path has ever mentioned request
 * interception. `ecosystem-prompts.ts` asks a model for steps and assertions
 * over a page that always answers 200, so the only thing any generated test
 * can assert is the happy render. The failure half of every screen — the 500,
 * the empty list, the response that never arrives, the 403 a role change
 * produces — is not reported as uncovered. It is not in the plan at all.
 *
 * SECOND: there are ZERO race, replay or double-submit scenarios anywhere in
 * the repository. A submit button is proposed as ONE click, never two in
 * flight. That is where money bugs live: the double charge, the duplicate
 * order, the two rows with the same unique value, the cancel that lands after
 * the confirm. A suite that clicks every button once proves the button works
 * and says nothing about what the application does when a user double-clicks
 * it on a slow connection, which is the ordinary case rather than a rare one.
 *
 * ── WHAT THIS MODULE PRODUCES: PLANS, NOT PROMPT TEXT ───────────────────────
 *
 * Every function here returns a structured scenario carrying three things a
 * generator needs and a model cannot invent: the REQUEST PATTERN to intercept,
 * the RESPONSE to substitute, and the ASSERTION about the application's
 * behaviour under it. The third is the hard part and the reason this module has
 * value. "Shows an error message" is a weak assertion — it passes when the
 * WRONG error appears, and it passes when the error is a stack trace. "Does not
 * lose the values the user typed" is a real requirement. So assertions here
 * carry a {@link AssertionStrength} and a {@link AssertionProvenance}, a
 * scenario whose assertions are all weak is LABELLED weak, and an assertion is
 * only emitted when the evidence it needs was actually observed — see
 * {@link FAULT_ASSERTION_DESCRIPTORS}.
 *
 * ── ONE INTERCEPTION MECHANISM, NAMED ───────────────────────────────────────
 *
 * `packages/runner/src/har.ts` already intercepts requests and already ships
 * itself into the Playwright process, and its `HarRoute` interface
 * (`fulfill` / `abort` / `continue`) is the mechanism every scenario below
 * targets. {@link FaultInterception.mechanismModule} names it explicitly so a
 * generator cannot invent a second route handler, which is how a suite ends up
 * with two interceptors fighting over one request.
 *
 * ── NO CLOCK, ANYWHERE, INCLUDING IN THE PLANS ──────────────────────────────
 *
 * `FAULT_MECHANISMS` in crawl/variants.ts expresses LOADING as a 30-second
 * delay and SLOW as a 3-second one, which is right for a CRAWL: it holds a
 * skeleton on screen long enough to read. It is wrong for a TEST. A test that
 * waits 3 seconds is the slowest possible wait and the least reliable one, and
 * the admission gate's NO_FIXED_SLEEP rule flags exactly that. So a delay
 * mechanism becomes a HELD response released on a CONDITION — the assertion
 * having run, or the second request having been seen — and the millisecond
 * figure the crawl declared is carried through on
 * {@link FaultInterception.declaredDelayMillis} so nothing is lost. A race's
 * interleaving is a gated schedule for the same reason: it is reproducible
 * because it waits for events, not for the clock.
 *
 * ── SAFETY, WHICH IS NOT NEGOTIABLE HERE ────────────────────────────────────
 *
 * A fault is NEVER injected against a non-idempotent request — failing a POST
 * means first issuing it, which can leave a real order and a real charge
 * behind. That rule is `injectionDecision` in crawl/variants.ts and this module
 * calls it rather than restating it.
 *
 * A race scenario, by contrast, MUST mutate: that is what it is for. So every
 * race scenario is admitted only against a principal `proveDisposable` in
 * @qaai/shared vouches for, and one that cannot obtain a disposable principal
 * is REFUSED AND RECORDED AS REFUSED. The two lists are kept separate —
 * {@link RaceScenarioSet.scenarios} and `.refused` — so a caller iterating the
 * runnable ones cannot accidentally run a refused one. Nothing here logs,
 * returns or embeds a password, a session cookie, a storageState or a bypass
 * token: a scenario names a principal and never carries its credential.
 */

import {
  createSyntheticFactory,
  isSafeProbeMethod,
  proveDisposable,
  reachabilityFromPolicy,
  type BotBypassMode,
  type BotProtectionProvider,
  type CapBite,
  type CoverageCellKind,
  type DisposabilityRefusal,
  type Principal,
  type SurfaceExercise,
} from '@qaai/shared';
import { stateCellKey } from './coverage-states.js';
import type { StructuralState } from './crawl/observe.js';
import {
  FAULT_MECHANISMS,
  FAULT_STATES,
  injectionDecision,
  normaliseRequestPath,
  requestMatcherFor,
  type FaultMechanism,
  type FaultState,
  type RequestMatcher,
  type VariantRequestObservation,
} from './crawl/variants.js';

// ─── 1. Assertion vocabulary: strength, provenance, and what each needs ─────

/**
 * How much an assertion proves.
 *
 * Two members and not a score, because the only decision a reader makes is
 * "would this test have caught the bug", and a 0.7 does not answer it. WEAK is
 * kept rather than banned: "an error is shown" is worth asserting when it is
 * all the evidence supports, and the honest thing is to SAY it is weak rather
 * than to drop it and leave the scenario assertionless.
 */
export const ASSERTION_STRENGTHS = ['STRONG', 'WEAK'] as const;
export type AssertionStrength = (typeof ASSERTION_STRENGTHS)[number];

/**
 * Where an assertion's expectation came from.
 *
 * OBSERVED means the crawl drove this exact fault and this is what the
 * application did, so a failure is a REGRESSION. DERIVED means nobody drove it
 * and this is a requirement any application owes, so a failure is a DEFECT the
 * suite is finding for the first time. They are different findings with
 * different confidence and a report that showed them identically would invite
 * the reader to distrust both.
 */
export const ASSERTION_PROVENANCES = ['OBSERVED', 'DERIVED'] as const;
export type AssertionProvenance = (typeof ASSERTION_PROVENANCES)[number];

/**
 * The assertions a failure-injection scenario can make.
 *
 * Nine, and the last one is the weak one the others exist to replace. Each is
 * phrased as a REQUIREMENT the application owes rather than as a thing to look
 * at, because the phrasing is what ends up in the test name and a reviewer
 * deletes a test whose name does not say what it protects.
 */
export const FAULT_ASSERTION_KINDS = [
  /** The user's typed input survives the failure. The real requirement. */
  'NO_INPUT_LOSS',
  /** The application's OWN error words appear, not merely "an error". */
  'ERROR_IS_NAMED',
  /** A failure resolves the loading state instead of spinning forever. */
  'NO_INFINITE_LOADING',
  /** An empty collection renders the empty state, not the error boundary. */
  'EMPTY_IS_NOT_ERROR',
  /** The retry control the application offers actually recovers. */
  'RETRY_RECOVERS',
  /** A truncated response does not render half a screen with holes in it. */
  'NO_PARTIAL_RENDER',
  /** A failed request does not navigate the user somewhere else. */
  'STAYS_ON_ROUTE',
  /** No unhandled error reaches the console. A failure must be HANDLED. */
  'NO_UNHANDLED_RUNTIME_ERROR',
  /** The weak one: something error-shaped is visible. Kept, and labelled. */
  'SOME_ERROR_SHOWN',
] as const;
export type FaultAssertionKind = (typeof FAULT_ASSERTION_KINDS)[number];

/** Compile-time half of the presence guard; the test file holds the other. */
const FAULT_ASSERTION_KIND_PRESENT: Record<FaultAssertionKind, true> = {
  NO_INPUT_LOSS: true,
  ERROR_IS_NAMED: true,
  NO_INFINITE_LOADING: true,
  EMPTY_IS_NOT_ERROR: true,
  RETRY_RECOVERS: true,
  NO_PARTIAL_RENDER: true,
  STAYS_ON_ROUTE: true,
  NO_UNHANDLED_RUNTIME_ERROR: true,
  SOME_ERROR_SHOWN: true,
};

/** Derived, never hand-listed. */
export const FAULT_ASSERTION_KIND_LIST = Object.keys(
  FAULT_ASSERTION_KIND_PRESENT,
) as ReadonlyArray<FaultAssertionKind>;

/**
 * What evidence an assertion needs before it may be written.
 *
 * This is the mechanism that stops this module generating confident nonsense.
 * "Does not lose the user's typed input" is only assertable on a page where the
 * crawl SAW fields a user types into; on a read-only dashboard it is a sentence
 * about nothing. "The retry control recovers" needs a retry control to have
 * been observed — inventing one produces a test that fails on a locator that
 * never existed, which is the failure mode a reviewer reads as "the tool is
 * broken".
 */
export const FAULT_EVIDENCE_NEEDS = [
  /** None. The requirement holds on any page. */
  'NONE',
  /** The crawl saw at least one field a user types into. */
  'TYPED_FIELDS',
  /** The crawl captured the application's own error text. */
  'OWN_ERROR_TEXT',
  /** The crawl saw this page in a LOADING state, so it has one. */
  'LOADING_STATE_SEEN',
  /** The crawl saw this page POPULATED, so an empty render is a change. */
  'POPULATED_STATE_SEEN',
  /** The crawl saw a control offered as a retry. */
  'RETRY_CONTROL',
  /** The crawl recorded console errors for this page, so the channel works. */
  'CONSOLE_CHANNEL',
] as const;
export type FaultEvidenceNeed = (typeof FAULT_EVIDENCE_NEEDS)[number];

export interface FaultAssertionDescriptor {
  /** The requirement, in the words that go in the test name. */
  claim: string;
  strength: AssertionStrength;
  /** The evidence that must exist before this may be asserted. */
  needs: FaultEvidenceNeed;
  /** Why this is worth asserting, for the reviewer deciding whether to keep it. */
  why: string;
  /** The fault states it applies to. Empty means every state. */
  states: readonly FaultState[];
}

/**
 * Assertion → claim, strength, evidence and applicability, as data.
 *
 * A `Record` keyed on the union, so a tenth assertion cannot join without
 * somebody deciding all five — and specifically without deciding whether it is
 * STRONG, which is the field that decides whether a scenario carrying only it
 * is reported as proving anything.
 */
export const FAULT_ASSERTION_DESCRIPTORS: Record<FaultAssertionKind, FaultAssertionDescriptor> = {
  NO_INPUT_LOSS: {
    claim: 'the values the user typed are still in the form after the request fails',
    strength: 'STRONG',
    needs: 'TYPED_FIELDS',
    why:
      'the commonest and most expensive failure-path bug: the request fails, the component ' +
      'remounts, and the user retypes a long form. It is invisible to a happy-path test and ' +
      'obvious to every user who hits it',
    states: [],
  },
  ERROR_IS_NAMED: {
    claim: "the application's own error message appears, verbatim",
    strength: 'STRONG',
    needs: 'OWN_ERROR_TEXT',
    why:
      'asserting the exact words the application chose is the only form of error assertion that ' +
      'fails when the WRONG error appears — and the wrong error, or a raw stack trace, is a real ' +
      'defect that "an error is shown" passes straight over',
    states: ['ERROR', 'FORBIDDEN', 'NOT_FOUND', 'RATE_LIMITED'],
  },
  NO_INFINITE_LOADING: {
    claim: 'the loading state resolves — the page does not spin forever',
    strength: 'STRONG',
    needs: 'LOADING_STATE_SEEN',
    why:
      'a request that never answers is the one case almost no front end handles: there is no ' +
      'error boundary for "still waiting", so the skeleton stays up and the user has nothing to ' +
      'read and nothing to click',
    states: ['LOADING', 'SLOW'],
  },
  EMPTY_IS_NOT_ERROR: {
    claim: 'an empty collection renders the empty state, not the error boundary',
    strength: 'STRONG',
    needs: 'POPULATED_STATE_SEEN',
    why:
      'a list that throws on zero rows is the first screen every new account sees, and it is ' +
      'only reachable with a fixture nobody has — which is why it ships broken so often',
    states: ['EMPTY'],
  },
  RETRY_RECOVERS: {
    claim: 'the retry control the application offers recovers once the request succeeds',
    strength: 'STRONG',
    needs: 'RETRY_CONTROL',
    why:
      'a retry button that re-renders the error without re-issuing the request is a dead control ' +
      'that looks alive, and nothing short of failing then succeeding can catch it',
    states: ['ERROR', 'SLOW', 'RATE_LIMITED'],
  },
  NO_PARTIAL_RENDER: {
    claim: 'a response missing fields does not render a screen with holes in it',
    strength: 'STRONG',
    needs: 'POPULATED_STATE_SEEN',
    why:
      'this is what a rolling deploy looks like from the browser, and "undefined" rendered into ' +
      'a price or a name is a defect users screenshot',
    states: ['PARTIAL'],
  },
  STAYS_ON_ROUTE: {
    claim: 'the failure leaves the user on the same route',
    strength: 'STRONG',
    needs: 'NONE',
    why:
      'a failed request that bounces the user to a dashboard or a login page destroys their work ' +
      'and hides the cause; it is also the shape an over-eager 401 interceptor produces',
    states: [],
  },
  NO_UNHANDLED_RUNTIME_ERROR: {
    claim: 'no unhandled error reaches the console',
    strength: 'STRONG',
    needs: 'CONSOLE_CHANNEL',
    why:
      'a handled failure and an uncaught exception can look identical on screen; the console is ' +
      'the only place the difference shows, and the difference decides whether the rest of the ' +
      'page still works',
    states: [],
  },
  SOME_ERROR_SHOWN: {
    claim: 'something error-shaped becomes visible',
    strength: 'WEAK',
    needs: 'NONE',
    why:
      'DELIBERATELY WEAK and kept for the pages where nothing stronger is supported: it passes ' +
      'when the wrong error appears and when the error is a stack trace, so a scenario carrying ' +
      'only this one is reported as WEAK rather than as a check that proves something',
    states: ['ERROR', 'FORBIDDEN', 'NOT_FOUND', 'RATE_LIMITED', 'PARTIAL'],
  },
};

export interface FaultAssertion {
  kind: FaultAssertionKind;
  /** The claim, with the page's own specifics folded in where there are any. */
  claim: string;
  strength: AssertionStrength;
  provenance: AssertionProvenance;
  /** What makes this assertable here: the observed fact, or the requirement. */
  basis: string;
}

// ─── 2. What the crawl observed, narrowly ───────────────────────────────────

/**
 * One control the crawl saw, narrowed to what an assertion needs.
 *
 * Identity and label only. No selector, because a scenario plan is not a
 * locator strategy — the generator resolves that from the crawl's own
 * `ControlSighting`, and a second copy of a selector here would be a second
 * thing to keep in step.
 */
export interface ObservedControl {
  identity: string;
  label: string;
}

/**
 * What the crawl observed about ONE page, as this module needs it.
 *
 * Every member is optional and follows the three-state convention the rest of
 * this repo uses: ABSENT means this crawl did not capture it, NULL means it
 * looked and there was nothing, a value is the fact. That distinction is the
 * whole evidence gate — reading an absent `typedFieldNames` as "no fields"
 * would silently drop the NO_INPUT_LOSS assertion from every page on a crawl
 * that merely predates the capture, and the scenario would be left with only
 * the weak assertion while reporting nothing about why.
 */
export interface ObservedPageBehaviour {
  /** The structural verdict's state, when the read ran. */
  structural?: StructuralState | null;
  /** Names of fields the crawl saw a user can type into. Names only, never values. */
  typedFieldNames?: readonly string[];
  /** The application's own error text, when the crawl captured one. */
  ownErrorText?: string | null;
  /** A control the application offers as a retry, when one was seen. */
  retryControl?: ObservedControl | null;
  /**
   * True when the crawl's console channel recorded anything for this page.
   *
   * It is a claim about OUR instrumentation, not about the application: a page
   * with no console errors and a page whose console was never read are the same
   * silence, and only the first supports NO_UNHANDLED_RUNTIME_ERROR.
   */
  consoleChannelWorked?: boolean | null;
  /**
   * What the crawl saw when it DROVE a fault variant here.
   *
   * Present only for the states `planFaultVariants` actually ran. A state in
   * this map produces OBSERVED assertions pinned to the behaviour; a state
   * absent from it produces DERIVED ones. An empty object means the drives ran
   * and read nothing, which is different from no drives.
   */
  underFault?: Partial<Record<FaultState, ObservedFaultResponse>>;
}

/** What the application did when one fault was driven. Every member nullable. */
export interface ObservedFaultResponse {
  /** What the page structurally became. Null = the drive ran and read nothing. */
  structural: StructuralState | null;
  /** The error text that appeared. Never a secret; the crawl's redactor ran first. */
  errorText: string | null;
  /** Whether typed values survived. NULL is not false — it means nobody checked. */
  inputPreserved: boolean | null;
  /** The route the browser ended on, when it was recorded. */
  finalRoute: string | null;
}

/** One route's worth of input to {@link planFaultScenarios}. */
export interface FaultTarget {
  /** The normalised route template. */
  route: string;
  /** `CoverageItem.key` for this route, when the inventory holds one. */
  coverageItemKey?: string | null;
  /** Requests this route's page was OBSERVED to issue. Nothing else may be failed. */
  requests: readonly VariantRequestObservation[];
  observed: ObservedPageBehaviour;
  /**
   * The state cell this route's fault drives, when a caller can name one.
   *
   * Supplied rather than derived: coverage-states.ts owns the fault-state → cell
   * mapping and this module does not fork it. Pass its `FAULT_STATE_CELL`
   * straight in — the value type admits `null` for exactly that reason, because
   * that table is `Record<FaultState, CoverageCellKind | null>` and a caller
   * forced to convert it would be a caller writing a second mapping.
   *
   * All three states are distinct and all three are honest: a MISSING key means
   * nobody supplied a mapping, a NULL means the mapping exists and says this
   * fault has no cell of its own, and a value is the cell. All three claim no
   * cell, and all three are counted — see {@link FaultScenarioSet.cellsUnclaimed}.
   */
  cellKindForState?: Partial<Record<FaultState, CoverageCellKind | null>>;
}

// ─── 3. Interception ────────────────────────────────────────────────────────

/**
 * How a held response is let go.
 *
 * Both members are CONDITIONS, which is the point: a schedule that waits for an
 * event is reproducible and a schedule that waits for 3000ms is a coin flip on
 * a busy machine. See the module header on why the crawl's millisecond figures
 * do not survive into a test.
 */
export const RELEASE_CONDITIONS = ['AFTER_ASSERTION', 'AFTER_SECOND_REQUEST_SEEN'] as const;
export type ReleaseCondition = (typeof RELEASE_CONDITIONS)[number];

/** What the route handler does with the request it claims. */
export const INTERCEPTION_VERBS = ['FULFILL', 'ABORT', 'HOLD'] as const;
export type InterceptionVerb = (typeof INTERCEPTION_VERBS)[number];

export interface FaultInterception {
  method: string;
  /** Path glob only. No query, ever — see `normaliseRequestPath`. */
  pathGlob: string;
  verb: InterceptionVerb;
  /** The substituted status, for FULFILL. Null for ABORT and HOLD. */
  status: number | null;
  /** The substituted body shape, for FULFILL. Null when the status is the whole fault. */
  body: 'EMPTY_COLLECTION' | 'TRUNCATED' | null;
  /** For HOLD: when the response is released. Null for the other two verbs. */
  releaseOn: ReleaseCondition | null;
  /**
   * The delay the CRAWL declared for this state, carried through so nothing is
   * lost when it is converted to a condition. Null for the non-delay states.
   */
  declaredDelayMillis: number | null;
  /** The one interception mechanism, named, so a generator cannot invent a second. */
  mechanismModule: string;
}

/** The one mechanism. A literal so a rename of har.ts breaks a test, not a run. */
export const INTERCEPTION_MECHANISM =
  'packages/runner/src/har.ts — HarRoute.fulfill / abort / continue, installed per browser context';

function interceptionFor(matcher: RequestMatcher, state: FaultState): FaultInterception {
  const mechanism: FaultMechanism = FAULT_MECHANISMS[state];
  const base = {
    method: matcher.method,
    pathGlob: matcher.pathGlob,
    declaredDelayMillis: mechanism.delayMillis,
    mechanismModule: INTERCEPTION_MECHANISM,
  };
  switch (mechanism.kind) {
    case 'DELAY':
      return {
        ...base,
        verb: 'HOLD',
        status: null,
        body: null,
        /*
         * LOADING holds until the assertion has looked at the skeleton; SLOW
         * holds until a SECOND request has been seen, which is the condition
         * that gives a double-submit guard its chance to be wrong. Both replace
         * the crawl's millisecond figure with an event, and both keep that
         * figure above in `declaredDelayMillis`.
         */
        releaseOn: state === 'SLOW' ? 'AFTER_SECOND_REQUEST_SEEN' : 'AFTER_ASSERTION',
      };
    case 'ABORT':
      return { ...base, verb: 'ABORT', status: null, body: null, releaseOn: null };
    case 'STATUS':
      return { ...base, verb: 'FULFILL', status: mechanism.status, body: null, releaseOn: null };
    case 'BODY':
      return {
        ...base,
        verb: 'FULFILL',
        status: mechanism.status,
        body: mechanism.body,
        releaseOn: null,
      };
  }
}

// ─── 4. The fault scenario ──────────────────────────────────────────────────

export interface FaultScenario {
  /** Content-derived: `FAULT:<state>:<method>:<glob>@<route>`. Stable across runs. */
  id: string;
  route: string;
  itemKey: string;
  state: FaultState;
  match: RequestMatcher;
  interception: FaultInterception;
  assertions: FaultAssertion[];
  /**
   * WEAK when every assertion is weak, STRONG when at least one is not.
   *
   * A scenario is never emitted with no assertions at all — see
   * {@link FAULT_ASSERTION_DESCRIPTORS.SOME_ERROR_SHOWN}, which needs no
   * evidence and is therefore always available as a floor. The floor is the
   * reason this field exists: a scenario with only the floor runs, and the
   * report has to be able to say it proves very little.
   */
  assertionStrength: AssertionStrength;
  /** The state cell this scenario drives, or null when no caller named one. */
  cellKey: string | null;
  /** The cell kind, or null for the same reason. */
  cellKind: CoverageCellKind | null;
  /** Set when the request may not be injected against. Null when it may. */
  exercise: SurfaceExercise | null;
  /** One sentence for a reviewer. */
  why: string;
}

/**
 * This module's budget vocabulary, separate from `CRAWL_CAPS` for the reason
 * `OBSERVATION_CAPS` in crawl/observe.ts gives: those are the traversal's caps
 * and these are generation's, and a `cap` value the shared list does not hold
 * would produce a `CapBite` whose label lookup is `undefined`.
 */
export const FAULT_BUDGETS = [
  'SCENARIOS_TOTAL',
  'REQUESTS_PER_ROUTE',
  'STATES_PER_REQUEST',
  'RACE_KINDS_PER_ROUTE',
  'RELEASE_ORDERS_PER_SCENARIO',
] as const;
export type FaultBudget = (typeof FAULT_BUDGETS)[number];

export const FAULT_BUDGET_LABELS: Record<FaultBudget, string> = {
  SCENARIOS_TOTAL: 'the whole-plan scenario limit',
  REQUESTS_PER_ROUTE: 'the per-route request limit',
  STATES_PER_REQUEST: 'the per-request fault-state limit',
  RACE_KINDS_PER_ROUTE: 'the per-route race-scenario-kind limit',
  RELEASE_ORDERS_PER_SCENARIO: 'the per-scenario release-order limit',
};

/** `CapBite` with this module's cap vocabulary. */
export type FaultCapBite = Omit<CapBite, 'cap'> & { cap: FaultBudget };

export interface FaultBudgets {
  scenariosTotal: number;
  requestsPerRoute: number;
  statesPerRequest: number;
  raceKindsPerRoute: number;
  releaseOrdersPerScenario: number;
}

/**
 * The defaults.
 *
 * `statesPerRequest: 3` matches `DEFAULT_FAULT_STATES` — ERROR, EMPTY, SLOW are
 * the three a reviewer can always justify, and the other five are disclosed as
 * a bite rather than being absent. `releaseOrdersPerScenario: 1` because the
 * orders are genuinely different bugs and taking all of them triples the race
 * suite; the seed picks which one, and the ones not taken are disclosed.
 */
export const DEFAULT_FAULT_BUDGETS: FaultBudgets = {
  scenariosTotal: 300,
  requestsPerRoute: 4,
  statesPerRequest: 3,
  raceKindsPerRoute: 3,
  releaseOrdersPerScenario: 1,
};

function faultCapBite(
  cap: FaultBudget,
  limit: number,
  bites: number,
  discarded: number,
  scope: string | null,
  reason: string,
): FaultCapBite {
  return { cap, limit, bites, discarded, scope, reason };
}

export interface FaultScenarioInput {
  targets: readonly FaultTarget[];
  /** Origins that are this application's own. A fault is never injected off-origin. */
  ownOrigins: readonly string[];
  /** The states to plan. Defaults to ERROR, EMPTY, SLOW; the rest are disclosed. */
  states?: readonly FaultState[];
  budgets?: Partial<FaultBudgets>;
  /**
   * The run seed. Used ONLY to order equal-ranked scenarios, through the same
   * mechanism `selectWalks` uses. No `Math.random()`, no clock.
   */
  seed: string | number;
}

export interface FaultScenarioSet {
  scenarios: FaultScenario[];
  caps: FaultCapBite[];
  /** Scenarios whose route named no state cell, so they claim none. Counted. */
  cellsUnclaimed: number;
  /**
   * Scenarios whose ONLY assertion is the weak floor, so they prove very little.
   *
   * EXPECTED TO BE ZERO with the current descriptor table, and that zero is
   * MEASURED rather than assumed — which is why the field exists at all.
   * `STAYS_ON_ROUTE` needs no evidence and applies to every state, so every
   * planned scenario is guaranteed one strong assertion; the guarantee is a
   * property of DATA, not of code, and a tenth state or a narrowed `states`
   * list on that descriptor would break it silently. This counter is the alarm,
   * and `fault-scenarios.test.ts` pins the invariant beside it.
   */
  weakOnly: number;
  /** The sentence the report prints above the list. */
  rule: string;
  seed: string;
}

/**
 * Which assertions this page's evidence supports, for one state.
 *
 * The ONE function in this module that decides what a test will claim, so it is
 * the one with no default arm: an assertion whose evidence is missing is not
 * emitted, and the floor assertion is appended last so the list is never empty.
 */
function assertionsFor(
  target: FaultTarget,
  state: FaultState,
): { assertions: FaultAssertion[]; strength: AssertionStrength } {
  const observed = target.observed;
  const drive = observed.underFault?.[state];
  const out: FaultAssertion[] = [];

  const has = (need: FaultEvidenceNeed): boolean => {
    switch (need) {
      case 'NONE':
        return true;
      case 'TYPED_FIELDS':
        return (observed.typedFieldNames?.length ?? 0) > 0;
      case 'OWN_ERROR_TEXT':
        // The driven error text beats the baseline one: it is what the page
        // says IN THIS STATE, and asserting the baseline text under a fault
        // would be asserting the wrong sentence.
        return (drive?.errorText ?? observed.ownErrorText ?? null) !== null;
      case 'LOADING_STATE_SEEN':
        return observed.structural === 'LOADING' || drive?.structural === 'LOADING';
      case 'POPULATED_STATE_SEEN':
        return observed.structural === 'POPULATED';
      case 'RETRY_CONTROL':
        return (observed.retryControl ?? null) !== null;
      case 'CONSOLE_CHANNEL':
        return observed.consoleChannelWorked === true;
    }
  };

  for (const kind of FAULT_ASSERTION_KIND_LIST) {
    if (kind === 'SOME_ERROR_SHOWN') continue; // the floor; appended below
    const descriptor = FAULT_ASSERTION_DESCRIPTORS[kind];
    if (descriptor.states.length > 0 && !descriptor.states.includes(state)) continue;
    if (!has(descriptor.needs)) continue;

    const provenance: AssertionProvenance = drive === undefined ? 'DERIVED' : 'OBSERVED';
    let claim = descriptor.claim;
    let basis =
      provenance === 'OBSERVED'
        ? `the crawl drove the ${state} state here and this is what the application did`
        : `nobody drove the ${state} state here, so this is the requirement rather than a regression`;

    if (kind === 'ERROR_IS_NAMED') {
      const text = drive?.errorText ?? observed.ownErrorText;
      if (text !== null && text !== undefined) {
        claim = `the message "${text}" appears, verbatim`;
        basis = `${basis}; the text is the application's own, captured by the crawl`;
      }
    }
    if (kind === 'NO_INPUT_LOSS') {
      const fields = observed.typedFieldNames ?? [];
      claim = `${descriptor.claim} (${fields.join(', ')})`;
      if (drive?.inputPreserved === false) {
        basis = `${basis} — and the crawl ALREADY saw the input lost here, so this scenario pins a known defect`;
      }
    }
    if (kind === 'RETRY_RECOVERS' && observed.retryControl) {
      claim = `clicking "${observed.retryControl.label}" re-issues the request and the page recovers`;
    }
    if (kind === 'STAYS_ON_ROUTE') {
      claim = `${descriptor.claim} (${target.route})`;
      if (drive?.finalRoute !== null && drive?.finalRoute !== undefined) {
        basis = `${basis}; the crawl ended on ${drive.finalRoute}`;
      }
    }

    out.push({ kind, claim, strength: descriptor.strength, provenance, basis });
  }

  const floor = FAULT_ASSERTION_DESCRIPTORS.SOME_ERROR_SHOWN;
  if (floor.states.includes(state)) {
    out.push({
      kind: 'SOME_ERROR_SHOWN',
      claim: floor.claim,
      strength: floor.strength,
      provenance: 'DERIVED',
      basis:
        out.length === 0
          ? 'the only assertion this page supports: nothing stronger has the evidence it needs, ' +
            'so this scenario is reported WEAK'
          : 'the floor, kept beside the stronger assertions so a failure always has something to show',
    });
  }

  const strength: AssertionStrength = out.some((assertion) => assertion.strength === 'STRONG')
    ? 'STRONG'
    : 'WEAK';
  return { assertions: out, strength };
}

/**
 * Plan failure-injection scenarios for every observed request on every target.
 *
 * Pure and deterministic. Nothing is injected against a non-idempotent request
 * or an off-origin one; both refusals are RECORDED on the scenario's
 * `exercise`, with the rule `injectionDecision` named, rather than silently
 * skipped — a refused surface and a surface that does not exist must never be
 * recorded the same way.
 */
export function planFaultScenarios(input: FaultScenarioInput): FaultScenarioSet {
  const budgets: FaultBudgets = { ...DEFAULT_FAULT_BUDGETS, ...input.budgets };
  const seed = String(input.seed);
  const states = input.states ?? (['ERROR', 'EMPTY', 'SLOW'] as readonly FaultState[]);
  const caps: FaultCapBite[] = [];
  const scenarios: FaultScenario[] = [];

  let requestBites = 0;
  let requestsDiscarded = 0;
  let stateBites = 0;
  let statesDiscarded = 0;

  const chosenStates = states.slice(0, Math.max(0, budgets.statesPerRequest));

  for (const target of [...input.targets].sort((left, right) => left.route.localeCompare(right.route))) {
    const itemKey = target.coverageItemKey ?? target.route;

    /*
     * Requests are sorted by path then method so the plan is a property of the
     * crawl and not of the order the observer happened to see them. Occurrence
     * count is NOT the sort key here — unlike `planFaultVariants`, which is
     * sampling for a crawl budget. A scenario plan is reviewed by a human, and
     * a list that reorders itself between runs is one nobody can diff.
     */
    const ordered = [...target.requests].sort((left, right) => {
      const path = normaliseRequestPath(left.path).localeCompare(normaliseRequestPath(right.path));
      return path !== 0 ? path : left.method.localeCompare(right.method);
    });

    const admitted: Array<{ request: VariantRequestObservation; rule: string | null }> = [];
    for (const request of ordered) {
      const decision = injectionDecision(request, input.ownOrigins);
      admitted.push({ request, rule: decision.admitted ? null : decision.rule });
    }

    const injectable = admitted.filter((entry) => entry.rule === null);
    const refused = admitted.filter((entry) => entry.rule !== null);
    const taken = injectable.slice(0, Math.max(0, budgets.requestsPerRoute));
    if (injectable.length > taken.length) {
      requestBites += 1;
      requestsDiscarded += injectable.length - taken.length;
    }
    if (states.length > chosenStates.length) {
      stateBites += 1;
      statesDiscarded += (states.length - chosenStates.length) * taken.length;
    }

    /*
     * A REFUSED request gets ONE recorded scenario rather than one per state.
     * The refusal is a property of the request — failing a POST means issuing
     * it, whatever status you were going to substitute — so five copies of the
     * same sentence would inflate the report without adding a fact. The state
     * is named as ERROR because that is the fault the refusal denied first.
     */
    for (const entry of refused) {
      const matcher = requestMatcherFor(entry.request);
      scenarios.push({
        id: `FAULT:REFUSED:${matcher.method}:${matcher.pathGlob}@${target.route}`,
        route: target.route,
        itemKey,
        state: 'ERROR',
        match: matcher,
        interception: interceptionFor(matcher, 'ERROR'),
        assertions: [],
        assertionStrength: 'WEAK',
        cellKey: null,
        cellKind: null,
        exercise: {
          state: 'REFUSED',
          reason: null,
          rule: entry.rule,
          detail:
            `${matcher.method} ${matcher.pathGlob} was never failed: ${entry.rule}. None of its ` +
            'failure states were exercised here, which is not the same as the page having none.',
        },
        why: `the failure states behind ${matcher.method} ${matcher.pathGlob} are not exercisable here`,
      });
    }

    for (const entry of taken) {
      const matcher = requestMatcherFor(entry.request);
      for (const state of chosenStates) {
        const { assertions, strength } = assertionsFor(target, state);
        const cellKind = target.cellKindForState?.[state] ?? null;
        scenarios.push({
          id: `FAULT:${state}:${matcher.method}:${matcher.pathGlob}@${target.route}`,
          route: target.route,
          itemKey,
          state,
          match: matcher,
          interception: interceptionFor(matcher, state),
          assertions,
          assertionStrength: strength,
          cellKey: cellKind === null ? null : stateCellKey({ itemKey, kind: cellKind }),
          cellKind,
          exercise: null,
          why:
            `${target.route} with ${matcher.method} ${matcher.pathGlob} in its ${state} state: ` +
            `${FAULT_MECHANISMS[state].detail}`,
        });
      }
    }
  }

  if (requestsDiscarded > 0) {
    caps.push(
      faultCapBite(
        'REQUESTS_PER_ROUTE',
        budgets.requestsPerRoute,
        requestBites,
        requestsDiscarded,
        'injectable requests per route',
        `${requestsDiscarded} injectable request(s) across ${requestBites} route(s) were not ` +
          'planned; they were below the per-route limit, not found absent',
      ),
    );
  }
  if (statesDiscarded > 0) {
    caps.push(
      faultCapBite(
        'STATES_PER_REQUEST',
        budgets.statesPerRequest,
        stateBites,
        statesDiscarded,
        'fault states per request',
        `${statesDiscarded} failure state(s) were not planned; of the ${FAULT_STATES.length} ` +
          `states this repo can produce, ${budgets.statesPerRequest} were taken per request`,
      ),
    );
  }

  const total = scenarios.slice(0, Math.max(0, budgets.scenariosTotal));
  if (scenarios.length > total.length) {
    caps.push(
      faultCapBite(
        'SCENARIOS_TOTAL',
        budgets.scenariosTotal,
        1,
        scenarios.length - total.length,
        null,
        `${scenarios.length - total.length} planned scenario(s) exceeded the whole-plan limit of ` +
          `${budgets.scenariosTotal} and were dropped`,
      ),
    );
  }

  const cellsUnclaimed = total.filter(
    (scenario) => scenario.cellKey === null && scenario.exercise === null,
  ).length;
  const weakOnly = total.filter(
    (scenario) => scenario.exercise === null && scenario.assertionStrength === 'WEAK',
  ).length;

  return {
    scenarios: total,
    caps,
    cellsUnclaimed,
    weakOnly,
    seed,
    rule:
      `${total.length} failure-injection scenario(s) over ${input.targets.length} route(s), from ` +
      `the OBSERVED request inventory only — a request nothing was seen to make cannot be failed. ` +
      `${weakOnly} of them carry only the weak floor assertion and prove very little (a measured ` +
      `count, not an assumed zero); ` +
      `${cellsUnclaimed} claim no state cell because no caller named one. Every state not planned ` +
      `is disclosed in caps. The interception mechanism is ${INTERCEPTION_MECHANISM}; a delay is ` +
      `expressed as a held response released on a condition, never as a sleep.`,
  };
}

// ─── 5. Races, replays and double submits ───────────────────────────────────

/**
 * The five race scenarios, and the money bug each one finds.
 *
 * Every one of them mutates. None of them is reachable from a plan that
 * proposes one click per button, which is why there are currently zero of them
 * in the repository.
 */
export const RACE_SCENARIO_KINDS = [
  /** Two clicks before the first resolves. The double charge. */
  'DOUBLE_SUBMIT',
  /** The same mutation replayed with the same idempotency key. */
  'IDEMPOTENT_REPLAY',
  /** Two principals editing one record. Silent last-write-wins. */
  'CONCURRENT_EDIT',
  /** Create, then create again with the same unique value. */
  'DUPLICATE_UNIQUE_CREATE',
  /** A cancel racing a confirm. Two terminal states for one thing. */
  'CANCEL_RACES_CONFIRM',
] as const;
export type RaceScenarioKind = (typeof RACE_SCENARIO_KINDS)[number];

/** Compile-time half of the presence guard. */
const RACE_SCENARIO_KIND_PRESENT: Record<RaceScenarioKind, true> = {
  DOUBLE_SUBMIT: true,
  IDEMPOTENT_REPLAY: true,
  CONCURRENT_EDIT: true,
  DUPLICATE_UNIQUE_CREATE: true,
  CANCEL_RACES_CONFIRM: true,
};

/** Derived, never hand-listed. */
export const RACE_SCENARIO_KIND_LIST = Object.keys(
  RACE_SCENARIO_KIND_PRESENT,
) as ReadonlyArray<RaceScenarioKind>;

/**
 * The invariants, which are what a race scenario actually asserts.
 *
 * An invariant and not a message, and that is the whole design of this half of
 * the module. "An error is shown when you double-click" is not the requirement:
 * an application may legitimately show nothing, disable the button, or queue the
 * second click. What it may NOT do is take the money twice. So the assertion is
 * about the COUNT of effects, which holds however the UI chooses to behave.
 */
export const RACE_INVARIANTS = [
  'EXACTLY_ONE_EFFECT',
  'SECOND_ANSWERS_FROM_FIRST',
  'CONFLICT_IS_VISIBLE',
  'UNIQUE_IS_ENFORCED',
  'EXACTLY_ONE_TERMINAL_STATE',
] as const;
export type RaceInvariant = (typeof RACE_INVARIANTS)[number];

export interface RaceInvariantDescriptor {
  claim: string;
  /** Why the invariant, and not a message, is the assertion. */
  why: string;
}

/** Invariant → claim and justification. A `Record`, so a sixth needs both. */
export const RACE_INVARIANT_DESCRIPTORS: Record<RaceInvariant, RaceInvariantDescriptor> = {
  EXACTLY_ONE_EFFECT: {
    claim: 'exactly one effect exists afterwards — one row, one charge, one email',
    why:
      'however the UI reacts to the second click, the application may not perform the work twice; ' +
      'the count is the requirement and the message is a preference',
  },
  SECOND_ANSWERS_FROM_FIRST: {
    claim: "the replay returns the first attempt's result and performs no second effect",
    why:
      'that is what an idempotency key is FOR; an endpoint that accepts the key and does the work ' +
      'again is worse than one that has no key, because the client trusts it',
  },
  CONFLICT_IS_VISIBLE: {
    claim: 'the second writer is told their edit conflicted, rather than silently overwriting',
    why:
      'silent last-write-wins loses a human being\'s work with no trace; it is the one concurrency ' +
      'bug users cannot even report, because nothing told them it happened',
  },
  UNIQUE_IS_ENFORCED: {
    claim: 'only one record with that value exists, and the second attempt is refused by name',
    why:
      'a uniqueness rule enforced only in the UI is not enforced; two tabs, or one slow network, ' +
      'is enough to produce the duplicate that every downstream join then multiplies',
  },
  EXACTLY_ONE_TERMINAL_STATE: {
    claim: 'the record ends in exactly one terminal state, and it is the one that won',
    why:
      'a thing that is both cancelled and confirmed is a refund dispute; which one wins matters ' +
      'less than that only one does',
  },
};

/** Kind → invariant. A `Record` so a sixth kind cannot be added without one. */
export const RACE_SCENARIO_INVARIANT: Record<RaceScenarioKind, RaceInvariant> = {
  DOUBLE_SUBMIT: 'EXACTLY_ONE_EFFECT',
  IDEMPOTENT_REPLAY: 'SECOND_ANSWERS_FROM_FIRST',
  CONCURRENT_EDIT: 'CONFLICT_IS_VISIBLE',
  DUPLICATE_UNIQUE_CREATE: 'UNIQUE_IS_ENFORCED',
  CANCEL_RACES_CONFIRM: 'EXACTLY_ONE_TERMINAL_STATE',
};

/** How many distinct principals a kind needs. Two means a second identity. */
export const RACE_PRINCIPALS_NEEDED: Record<RaceScenarioKind, 1 | 2> = {
  DOUBLE_SUBMIT: 1,
  IDEMPOTENT_REPLAY: 1,
  CONCURRENT_EDIT: 2,
  DUPLICATE_UNIQUE_CREATE: 1,
  CANCEL_RACES_CONFIRM: 1,
};

// ─── 6. The interleaving, which is why a race is reproducible ───────────────

/**
 * In what order the two held responses are let go.
 *
 * Three members, and they are three DIFFERENT bugs rather than three samples of
 * one. Last-write-wins shows up when the second write lands last and not when
 * it lands first; an idempotency cache that is written after the effect rather
 * than before fails only in SECOND_THEN_FIRST. So the seed picks one, the plan
 * NAMES the one it picked, and the two it did not take are disclosed as a cap
 * bite — otherwise a report would claim a race was tested when one third of it
 * was.
 */
export const RELEASE_ORDERS = ['FIRST_THEN_SECOND', 'SECOND_THEN_FIRST', 'BOTH_AT_ONCE'] as const;
export type ReleaseOrder = (typeof RELEASE_ORDERS)[number];

export const RELEASE_ORDER_LABELS: Record<ReleaseOrder, string> = {
  FIRST_THEN_SECOND: 'release the first request, then the second',
  SECOND_THEN_FIRST: 'release the second request, then the first',
  BOTH_AT_ONCE: 'release both requests together',
};

/**
 * What one step of a race does.
 *
 * Every member is either an ACTION or a WAIT FOR AN EVENT. There is no "wait
 * N milliseconds", and that absence is the reproducibility guarantee: a
 * schedule built from events replays identically on a loaded machine, and one
 * built from sleeps is the flaky test this product exists to eliminate. It is
 * also what keeps the generated code past the admission gate's NO_FIXED_SLEEP
 * rule.
 */
export const INTERLEAVING_ACTIONS = [
  /** Install the interceptor that will hold the named request. Always first. */
  'ARM_GATE',
  /** The actor performs the mutation. Does not wait for it. */
  'SUBMIT',
  /** Block until the gate has seen N requests. A condition, never a clock. */
  'AWAIT_IN_FLIGHT',
  /** Let a held response through. */
  'RELEASE',
  /** Block until the application has settled: no request in flight. */
  'AWAIT_SETTLED',
  /** Read the invariant. Always last. */
  'CHECK_INVARIANT',
] as const;
export type InterleavingAction = (typeof INTERLEAVING_ACTIONS)[number];

/** Compile-time half of the presence guard. */
const INTERLEAVING_ACTION_PRESENT: Record<InterleavingAction, true> = {
  ARM_GATE: true,
  SUBMIT: true,
  AWAIT_IN_FLIGHT: true,
  RELEASE: true,
  AWAIT_SETTLED: true,
  CHECK_INVARIANT: true,
};

/** Derived, never hand-listed. */
export const INTERLEAVING_ACTION_LIST = Object.keys(
  INTERLEAVING_ACTION_PRESENT,
) as ReadonlyArray<InterleavingAction>;

export interface InterleavingStep {
  /** 1-based. The order is the schedule. */
  order: number;
  action: InterleavingAction;
  /**
   * The principal performing it, or null for a step the harness performs.
   *
   * A NAME, never a credential. See the note on `Principal` in principals.ts:
   * nothing in a plan may carry a password, a cookie or a storageState.
   */
  actor: string | null;
  /** For AWAIT_IN_FLIGHT: how many requests the gate must have seen. */
  count: number | null;
  /** What a human reads, and what the generated step's comment says. */
  detail: string;
}

export interface Interleaving {
  order: ReleaseOrder;
  steps: InterleavingStep[];
  /**
   * The seeded token this order was chosen by, so a failure can be re-run.
   *
   * It is the REPLAY KEY: given the seed and this token a reader can see, by
   * hand, which of the three orders the selection took. Without it "the race
   * failed" is a report nobody can act on.
   */
  derivedFrom: string;
  /** The sentence a human needs to reproduce this by hand. */
  rule: string;
}

/**
 * Why a race scenario was not run. Every member is a sentence the report prints.
 *
 * NONE of them is a pass and none of them is a zero. "0 double-charge bugs"
 * over a scenario that never ran is the exact lie these reasons exist to make
 * impossible.
 */
export const RACE_REFUSAL_REASONS = [
  /** No principal the scenario itself created, so nothing may be mutated. */
  'NO_DISPOSABLE_PRINCIPAL',
  /** The kind needs two identities and only one was supplied. */
  'NEEDS_SECOND_PRINCIPAL',
  /** Nothing mutating was observed on this route, so there is no race to run. */
  'NO_MUTATING_REQUEST',
  /** A bot defence stands in front of the form. Never bypassed; reported. */
  'UNREACHABLE_BEHIND_BOT_PROTECTION',
  /** No field on this route carries a uniqueness requirement to collide on. */
  'NO_UNIQUE_FIELD',
  /** No control was observed that could cancel, so nothing can race a confirm. */
  'NO_CANCEL_CONTROL',
] as const;
export type RaceRefusalReason = (typeof RACE_REFUSAL_REASONS)[number];

/** Compile-time half of the presence guard. */
const RACE_REFUSAL_REASON_PRESENT: Record<RaceRefusalReason, true> = {
  NO_DISPOSABLE_PRINCIPAL: true,
  NEEDS_SECOND_PRINCIPAL: true,
  NO_MUTATING_REQUEST: true,
  UNREACHABLE_BEHIND_BOT_PROTECTION: true,
  NO_UNIQUE_FIELD: true,
  NO_CANCEL_CONTROL: true,
};

/** Derived, never hand-listed. */
export const RACE_REFUSAL_REASON_LIST = Object.keys(
  RACE_REFUSAL_REASON_PRESENT,
) as ReadonlyArray<RaceRefusalReason>;

export interface RaceRefusal {
  reason: RaceRefusalReason;
  /** One sentence naming the scenario and the remedy. */
  detail: string;
  /**
   * The disposability refusal underneath, when there was one.
   *
   * Carried through rather than flattened into a sentence, because
   * `proveDisposable` distinguishes six causes and the remedy differs: "this is
   * the customer's own account" and "marked disposable but names no creating
   * scenario" are two different things for a customer to fix.
   */
  disposability: DisposabilityRefusal | null;
}

export interface RaceAssertion {
  invariant: RaceInvariant;
  claim: string;
  /** Always STRONG: an invariant over a count is not a look-and-see. */
  strength: AssertionStrength;
  /** Why this invariant rather than a message. */
  basis: string;
}

export interface RaceScenario {
  /** Content-derived: `RACE:<kind>:<method>:<glob>@<route>`. */
  id: string;
  route: string;
  kind: RaceScenarioKind;
  invariant: RaceInvariant;
  /** The mutating request being raced. Path only, never a query value. */
  match: RequestMatcher;
  /** The control the actor clicks, when the crawl saw one. */
  control: ObservedControl | null;
  /** Principal NAMES, in the order the interleaving uses them. Never credentials. */
  principals: string[];
  interleaving: Interleaving;
  assertions: RaceAssertion[];
  /**
   * The idempotency key header the crawl observed, or null.
   *
   * NULL IS ITSELF A FINDING and is reported as one: an endpoint that takes
   * money and declares no idempotency key cannot be safely retried by anybody,
   * including the customer's own client. The scenario still runs — the
   * EXACTLY_ONE_EFFECT invariant does not need a key — and the note says so.
   */
  idempotencyKeyHeader: string | null;
  /** Null for a runnable scenario; the record for a refused one. */
  refusal: RaceRefusal | null;
  why: string;
}

/** One route's worth of input to {@link planRaceScenarios}. */
export interface RaceTarget {
  route: string;
  /**
   * Requests observed from this route. A race needs a MUTATING one, which is
   * the opposite of the fault half: `isSafeProbeMethod` picks them apart, so
   * there is one definition of "safe verb" in this repo rather than two.
   */
  requests: readonly VariantRequestObservation[];
  /** Controls the crawl saw. Used to name the click; never invented. */
  controls?: readonly ObservedControl[];
  /** The control the crawl saw as a cancel, when there was one. */
  cancelControl?: ObservedControl | null;
  /**
   * Field names on this route whose value must be unique, when something
   * declared it.
   *
   * Absent means nobody classified the fields — distinct from an empty array,
   * which means somebody looked and no field is unique. Only the second
   * supports the NO_UNIQUE_FIELD refusal as a finding rather than a shrug.
   */
  uniqueFieldNames?: readonly string[];
  /** Request header name the crawl saw carrying an idempotency key. */
  idempotencyKeyHeader?: string | null;
  /** This environment's bot-protection posture, when the caller knows it. */
  botProtection?: { provider: BotProtectionProvider; bypassMode: BotBypassMode } | null;
}

export interface RaceScenarioInput {
  targets: readonly RaceTarget[];
  /**
   * The principals available to this run, in preference order.
   *
   * Plain `Principal`s, NOT proofs: `proveDisposable` is called here so the
   * refusal reaches the report, and a `DestructiblePrincipal` cannot be stored
   * in a plan anyway — its witness is a symbol and does not survive JSON. The
   * runner re-proves at execution time, which is the point of the proof being
   * cheap.
   */
  principals: readonly Principal[];
  /** Overridden when a run files its shared session under another name. */
  runDefaultName?: string;
  budgets?: Partial<FaultBudgets>;
  /** The run seed. Chooses the release order, and nothing else. */
  seed: string | number;
}

export interface RaceScenarioSet {
  /**
   * The runnable scenarios. Every one has a disposable principal behind it.
   *
   * Separate from `refused` on purpose: a single list with a `refusal` field
   * would let a caller iterate it and run a refused scenario against the
   * customer's own account, which is the one mistake this module may not make
   * possible. The same reasoning as `BoundDestructiveStep`'s discriminant in
   * principals.ts.
   */
  scenarios: RaceScenario[];
  /** Refused, recorded, and NOT runnable. Never the same shape as "does not exist". */
  refused: RaceScenario[];
  caps: FaultCapBite[];
  rule: string;
  seed: string;
}

/** The 32-bit integer behind a seeded token, for picking one of a small list. */
function seedIndex(token: string, modulus: number): number {
  if (modulus <= 0) return 0;
  const parsed = Number.parseInt(token, 36);
  // A token that is not parseable is a bug in the token source, not a licence
  // to reach for a random number: fall back to 0, which is deterministic and
  // visible in the plan as FIRST_THEN_SECOND.
  return Number.isFinite(parsed) ? Math.abs(parsed) % modulus : 0;
}

/**
 * Build the gated schedule for one race.
 *
 * Six to eight steps, every one of them an action or an event wait. The order
 * the two responses are released in is the seed's only contribution, and it is
 * named on the result so a failure can be re-run by hand.
 */
function interleavingFor(
  kind: RaceScenarioKind,
  order: ReleaseOrder,
  actors: readonly string[],
  matcher: RequestMatcher,
  token: string,
): Interleaving {
  const first = actors[0] ?? 'actor-1';
  const second = actors[1] ?? first;
  const steps: InterleavingStep[] = [];
  const push = (
    action: InterleavingAction,
    actor: string | null,
    detail: string,
    count: number | null = null,
  ): void => {
    steps.push({ order: steps.length + 1, action, actor, count, detail });
  };

  push(
    'ARM_GATE',
    null,
    `hold every ${matcher.method} ${matcher.pathGlob} at the interceptor; nothing is released ` +
      'until this schedule says so',
  );
  push('SUBMIT', first, `${first} submits — and does NOT wait for the response`);
  push('AWAIT_IN_FLIGHT', null, 'wait until the gate holds the first request', 1);
  push(
    'SUBMIT',
    second,
    kind === 'CANCEL_RACES_CONFIRM'
      ? `${second} cancels while the confirm is still in flight`
      : kind === 'CONCURRENT_EDIT'
        ? `${second} saves their own edit of the same record`
        : `${second} submits the same mutation again`,
  );
  push('AWAIT_IN_FLIGHT', null, 'wait until the gate holds both requests', 2);

  if (order === 'BOTH_AT_ONCE') {
    push('RELEASE', null, 'release both held responses together');
  } else if (order === 'FIRST_THEN_SECOND') {
    push('RELEASE', first, "release the first actor's response");
    push('RELEASE', second, "release the second actor's response");
  } else {
    push('RELEASE', second, "release the SECOND actor's response first");
    push('RELEASE', first, "then release the first actor's");
  }

  push('AWAIT_SETTLED', null, 'wait until nothing is in flight');
  push(
    'CHECK_INVARIANT',
    null,
    `read the invariant: ${RACE_INVARIANT_DESCRIPTORS[RACE_SCENARIO_INVARIANT[kind]].claim}`,
  );

  return {
    order,
    steps,
    derivedFrom: token,
    rule:
      `both requests are put in flight and held at the interceptor, then released ` +
      `${RELEASE_ORDER_LABELS[order]}. No step waits for the clock, so this schedule replays ` +
      `identically on a loaded machine. To re-run it by hand, use the run seed and the token ` +
      `${token}, which is what chose this order out of ${RELEASE_ORDERS.length}.`,
  };
}

/**
 * Plan race, replay, double-submit and idempotency scenarios.
 *
 * Every scenario that mutates is admitted only against a principal
 * `proveDisposable` vouches for, and every refusal is RECORDED in `refused`
 * rather than dropped. A bot defence is never bypassed: when one stands in
 * front of the route and no legitimate route past it is configured, the
 * scenario is refused with `reachabilityFromPolicy`'s own remedy.
 */
export function planRaceScenarios(input: RaceScenarioInput): RaceScenarioSet {
  const budgets: FaultBudgets = { ...DEFAULT_FAULT_BUDGETS, ...input.budgets };
  const seed = String(input.seed);
  const tokens = createRaceTokens(seed);
  const caps: FaultCapBite[] = [];
  const scenarios: RaceScenario[] = [];
  const refused: RaceScenario[] = [];

  /*
   * Disposability is decided ONCE per run rather than per scenario, because the
   * answer cannot differ between scenarios and `proveDisposable`'s refusal is
   * the thing a customer acts on. The first principal that proves disposable
   * wins; the refusal kept is the one for the first candidate, which is the
   * most specific true sentence about this run's configuration.
   */
  let disposableNames: string[] = [];
  let disposabilityRefusal: DisposabilityRefusal | null = null;
  for (const candidate of input.principals) {
    const proof = proveDisposable(candidate, input.runDefaultName);
    if (proof.ok) {
      disposableNames.push(proof.principal.name);
      continue;
    }
    if (disposabilityRefusal === null) disposabilityRefusal = proof;
  }
  disposableNames = [...new Set(disposableNames)].sort();

  let kindBites = 0;
  let kindsDiscarded = 0;
  let orderBites = 0;
  let ordersDiscarded = 0;

  for (const target of [...input.targets].sort((left, right) => left.route.localeCompare(right.route))) {
    const mutating = [...target.requests]
      .filter((request) => !isSafeProbeMethod(request.method))
      .sort((left, right) => {
        const path = normaliseRequestPath(left.path).localeCompare(normaliseRequestPath(right.path));
        return path !== 0 ? path : left.method.localeCompare(right.method);
      });

    const bot = target.botProtection
      ? reachabilityFromPolicy(target.botProtection)
      : { reachability: 'NOT_PROBED' as const, remedy: null };

    const taken = RACE_SCENARIO_KIND_LIST.slice(0, Math.max(0, budgets.raceKindsPerRoute));
    if (RACE_SCENARIO_KIND_LIST.length > taken.length) {
      kindBites += 1;
      kindsDiscarded += RACE_SCENARIO_KIND_LIST.length - taken.length;
    }
    if (RELEASE_ORDERS.length > budgets.releaseOrdersPerScenario) {
      orderBites += 1;
      ordersDiscarded += (RELEASE_ORDERS.length - budgets.releaseOrdersPerScenario) * taken.length;
    }

    for (const kind of taken) {
      const matcher = mutating[0] === undefined ? null : requestMatcherFor(mutating[0]);
      const id = `RACE:${kind}:${matcher?.method ?? 'NONE'}:${matcher?.pathGlob ?? target.route}@${target.route}`;
      const token = tokens(id);
      const order = RELEASE_ORDERS[seedIndex(token, RELEASE_ORDERS.length)] ?? 'FIRST_THEN_SECOND';
      const invariant = RACE_SCENARIO_INVARIANT[kind];
      const needed = RACE_PRINCIPALS_NEEDED[kind];
      const actors = disposableNames.slice(0, needed);
      const control =
        target.controls?.find((candidate) => candidate.identity.length > 0) ?? null;

      const refuse = (reason: RaceRefusalReason, detail: string): void => {
        refused.push({
          id,
          route: target.route,
          kind,
          invariant,
          match: matcher ?? { method: 'NONE', pathGlob: target.route, issuedFromRoute: target.route },
          control,
          principals: actors,
          interleaving: interleavingFor(kind, order, actors, matcher ?? {
            method: 'NONE',
            pathGlob: target.route,
            issuedFromRoute: target.route,
          }, token),
          assertions: [],
          idempotencyKeyHeader: target.idempotencyKeyHeader ?? null,
          refusal: {
            reason,
            detail,
            disposability: reason === 'NO_DISPOSABLE_PRINCIPAL' ? disposabilityRefusal : null,
          },
          why:
            `${kind} on ${target.route} was NOT performed. This is a recorded refusal, not a ` +
            'passing check and not an absence of the bug it looks for.',
        });
      };

      // Order matters: the most specific true refusal is the one a reader sees.
      if (bot.reachability === 'UNREACHABLE_BEHIND_BOT_PROTECTION') {
        refuse(
          'UNREACHABLE_BEHIND_BOT_PROTECTION',
          `a bot defence stands in front of ${target.route} and no legitimate route past it is ` +
            `configured, so nothing was driven. Nothing here solves or evades a challenge. ` +
            `${bot.remedy ?? ''}`.trim(),
        );
        continue;
      }
      if (matcher === null) {
        refuse(
          'NO_MUTATING_REQUEST',
          `${target.route} was observed issuing no request with an unsafe verb, so there is no ` +
            'mutation to race. A route that only reads cannot double-charge.',
        );
        continue;
      }
      if (disposableNames.length === 0) {
        refuse(
          'NO_DISPOSABLE_PRINCIPAL',
          `${kind} mutates data and no principal in this run proves disposable, so it was not ` +
            `run against anything. ${disposabilityRefusal?.detail ?? 'No principal was supplied at all.'}`,
        );
        continue;
      }
      if (actors.length < needed) {
        refuse(
          'NEEDS_SECOND_PRINCIPAL',
          `${kind} needs ${needed} distinct disposable principals and this run has ` +
            `${disposableNames.length}. Configure a second disposable principal and the scenario runs.`,
        );
        continue;
      }
      if (kind === 'DUPLICATE_UNIQUE_CREATE' && (target.uniqueFieldNames?.length ?? 0) === 0) {
        refuse(
          'NO_UNIQUE_FIELD',
          target.uniqueFieldNames === undefined
            ? `nothing classified the fields on ${target.route}, so no uniqueness requirement is ` +
                'known to collide on. This is an unread constraint, not a field that may repeat.'
            : `the fields on ${target.route} were classified and none carries a uniqueness ` +
                'requirement, so there is no value to duplicate.',
        );
        continue;
      }
      if (kind === 'CANCEL_RACES_CONFIRM' && (target.cancelControl ?? null) === null) {
        refuse(
          'NO_CANCEL_CONTROL',
          `no control on ${target.route} was observed as a cancel, so there is nothing to race ` +
            'against the confirm. Inventing one would produce a test that fails on a locator ' +
            'that never existed.',
        );
        continue;
      }

      const descriptor = RACE_INVARIANT_DESCRIPTORS[invariant];
      const keyHeader = target.idempotencyKeyHeader ?? null;
      const assertions: RaceAssertion[] = [
        {
          invariant,
          claim: descriptor.claim,
          strength: 'STRONG',
          basis: descriptor.why,
        },
      ];
      if (kind === 'IDEMPOTENT_REPLAY' && keyHeader === null) {
        assertions.push({
          invariant: 'EXACTLY_ONE_EFFECT',
          claim: 'exactly one effect exists afterwards, even with no idempotency key declared',
          strength: 'STRONG',
          basis:
            'the crawl observed no idempotency-key header on this request, which is itself a ' +
            'finding: an endpoint that performs work and offers no key cannot be safely retried ' +
            'by any client. The replay is still run and the count is still the requirement.',
        });
      }

      scenarios.push({
        id,
        route: target.route,
        kind,
        invariant,
        match: matcher,
        control: kind === 'CANCEL_RACES_CONFIRM' ? (target.cancelControl ?? control) : control,
        principals: actors,
        interleaving: interleavingFor(kind, order, actors, matcher, token),
        assertions,
        idempotencyKeyHeader: keyHeader,
        refusal: null,
        why:
          `${kind} on ${target.route}: two ${matcher.method} ${matcher.pathGlob} in flight at ` +
          `once, released ${RELEASE_ORDER_LABELS[order]}. ${descriptor.why}`,
      });
    }
  }

  if (kindsDiscarded > 0) {
    caps.push(
      faultCapBite(
        'RACE_KINDS_PER_ROUTE',
        budgets.raceKindsPerRoute,
        kindBites,
        kindsDiscarded,
        'race kinds per route',
        `${kindsDiscarded} race scenario kind(s) across ${kindBites} route(s) were not planned; ` +
          `of the ${RACE_SCENARIO_KIND_LIST.length} kinds this module can produce, ` +
          `${budgets.raceKindsPerRoute} were taken per route`,
      ),
    );
  }
  if (ordersDiscarded > 0) {
    caps.push(
      faultCapBite(
        'RELEASE_ORDERS_PER_SCENARIO',
        budgets.releaseOrdersPerScenario,
        orderBites,
        ordersDiscarded,
        'release orders per scenario',
        `${ordersDiscarded} release order(s) were not planned across ${orderBites} route(s). The ` +
          `${RELEASE_ORDERS.length} orders are three different bugs, not three samples of one — ` +
          'the seed picked one per scenario and the plan names which',
      ),
    );
  }

  const total = scenarios.slice(0, Math.max(0, budgets.scenariosTotal));
  if (scenarios.length > total.length) {
    caps.push(
      faultCapBite(
        'SCENARIOS_TOTAL',
        budgets.scenariosTotal,
        1,
        scenarios.length - total.length,
        null,
        `${scenarios.length - total.length} runnable race scenario(s) exceeded the whole-plan ` +
          `limit of ${budgets.scenariosTotal} and were dropped`,
      ),
    );
  }

  return {
    scenarios: total,
    refused,
    caps,
    seed,
    rule:
      `${total.length} runnable race scenario(s) and ${refused.length} RECORDED REFUSAL(S) over ` +
      `${input.targets.length} route(s). Every runnable one mutates, so every one of them runs ` +
      `against a principal proveDisposable vouched for — ${disposableNames.length} of the ` +
      `${input.principals.length} principal(s) supplied. A refusal is not a pass and not a zero: ` +
      `the refused list says which check was not performed and why. The interleaving is a gated ` +
      `schedule with no clock in it, and seed ${seed} chose each release order, so a failure ` +
      `re-runs exactly.`,
  };
}

/**
 * The seeded token source — the ONE spelling of determinism in this file.
 *
 * `createSyntheticFactory` from @qaai/shared rather than a local hash, because
 * a second hash implementation in this repo is a second thing that can
 * disagree about what a seed means. A reviewer grepping for the seed's effect
 * finds exactly this function and {@link seedIndex}.
 */
function createRaceTokens(seed: string): (key: string) => string {
  const base = createSyntheticFactory({ seed, scope: 'races' });
  return (key) => base.scoped(key).token;
}
