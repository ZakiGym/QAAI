import { describe, expect, it } from 'vitest';
import { DEFAULT_PRINCIPAL_NAME, principal, type Principal } from '@qaai/shared';
import { FAULT_STATE_CELL, stateCellKey } from './coverage-states';
import {
  FAULT_MECHANISMS,
  FAULT_STATES,
  IDEMPOTENT_METHODS,
  type FaultState,
  type VariantRequestObservation,
} from './crawl/variants';
import {
  ASSERTION_PROVENANCES,
  ASSERTION_STRENGTHS,
  DEFAULT_FAULT_BUDGETS,
  FAULT_ASSERTION_DESCRIPTORS,
  FAULT_ASSERTION_KINDS,
  FAULT_ASSERTION_KIND_LIST,
  FAULT_BUDGETS,
  FAULT_BUDGET_LABELS,
  FAULT_EVIDENCE_NEEDS,
  INTERCEPTION_MECHANISM,
  INTERLEAVING_ACTIONS,
  INTERLEAVING_ACTION_LIST,
  RACE_INVARIANTS,
  RACE_INVARIANT_DESCRIPTORS,
  RACE_PRINCIPALS_NEEDED,
  RACE_REFUSAL_REASONS,
  RACE_REFUSAL_REASON_LIST,
  RACE_SCENARIO_INVARIANT,
  RACE_SCENARIO_KINDS,
  RACE_SCENARIO_KIND_LIST,
  RELEASE_CONDITIONS,
  RELEASE_ORDERS,
  RELEASE_ORDER_LABELS,
  planFaultScenarios,
  planRaceScenarios,
  type FaultScenario,
  type FaultTarget,
  type ObservedPageBehaviour,
  type RaceRefusalReason,
  type RaceScenarioKind,
  type RaceTarget,
} from './fault-scenarios';

/**
 * What this file is actually checking.
 *
 * Two defects, so two sets of properties.
 *
 * FAILURE INJECTION: the prompts never mentioned `page.route`, so only the
 * happy render was ever asserted. The tests that matter are not "does it emit
 * scenarios" but:
 *
 *   1. An assertion whose EVIDENCE is missing is not emitted. A page with no
 *      typed fields gets no "does not lose your input" claim, because that
 *      claim would be a sentence about nothing.
 *   2. The strong assertions quote the application's OWN words, and a scenario
 *      left with only the weak floor is LABELLED weak and counted.
 *   3. A delay becomes a HELD response released on a CONDITION, never a sleep —
 *      and the millisecond figure the crawl declared survives.
 *   4. A non-idempotent or off-origin request is RECORDED as refused, with the
 *      rule, never silently skipped.
 *
 * RACES: there are zero race scenarios in the repository today. So:
 *
 *   5. Nothing runs without a principal `proveDisposable` vouched for, and the
 *      refusal reaches the report with the underlying reason.
 *   6. The runnable and refused lists are SEPARATE, so a caller cannot run a
 *      refused scenario against the customer's own account.
 *   7. The interleaving has no clock in it and names its release order, so a
 *      failure re-runs.
 *   8. A bot defence is reported, never bypassed.
 */

// ─── Fixtures ───────────────────────────────────────────────────────────────

const request = (
  over: Partial<VariantRequestObservation> & Pick<VariantRequestObservation, 'method' | 'path'>,
): VariantRequestObservation => ({
  issuedFromRoute: '/orders',
  origin: 'https://app.test',
  resourceType: 'fetch',
  occurrences: 1,
  status: 200,
  ...over,
});

const OWN_ORIGINS = ['https://app.test'];

const target = (over: Partial<FaultTarget> = {}): FaultTarget => ({
  route: '/orders',
  requests: [request({ method: 'GET', path: '/api/orders' })],
  observed: {},
  ...over,
});

const RICH_OBSERVATION: ObservedPageBehaviour = {
  structural: 'POPULATED',
  typedFieldNames: ['search', 'dateFrom'],
  ownErrorText: 'We could not load your orders.',
  retryControl: { identity: 'btn:retry', label: 'Try again' },
  consoleChannelWorked: true,
};

const plan = (over: Partial<Parameters<typeof planFaultScenarios>[0]> = {}) =>
  planFaultScenarios({ targets: [target()], ownOrigins: OWN_ORIGINS, seed: 'seed-1', ...over });

const kindsOf = (scenario: FaultScenario | undefined): string[] =>
  (scenario?.assertions ?? []).map((assertion) => assertion.kind);

const scenarioFor = (
  set: ReturnType<typeof planFaultScenarios>,
  state: FaultState,
): FaultScenario | undefined => set.scenarios.find((candidate) => candidate.state === state);

const disposable = (name: string): Principal =>
  principal({
    name,
    kind: 'DISPOSABLE',
    lifecycle: 'ACTIVE',
    createdByScenario: 'race-fixture',
    tenant: { id: 't-1', label: 'Acme' },
  });

const CUSTOMER_ACCOUNT: Principal = principal({
  name: 'owner',
  kind: 'PERSISTENT',
  lifecycle: 'ACTIVE',
});

const raceTarget = (over: Partial<RaceTarget> = {}): RaceTarget => ({
  route: '/checkout',
  requests: [request({ method: 'POST', path: '/api/orders', issuedFromRoute: '/checkout' })],
  controls: [{ identity: 'btn:place', label: 'Place order' }],
  ...over,
});

const races = (over: Partial<Parameters<typeof planRaceScenarios>[0]> = {}) =>
  planRaceScenarios({
    targets: [raceTarget()],
    principals: [disposable('shopperA'), disposable('shopperB')],
    seed: 'seed-1',
    ...over,
  });

const refusalFor = (
  set: ReturnType<typeof planRaceScenarios>,
  kind: RaceScenarioKind,
): RaceRefusalReason | undefined =>
  set.refused.find((candidate) => candidate.kind === kind)?.refusal?.reason;

// ─── Vocabulary parity ──────────────────────────────────────────────────────

describe('vocabulary parity', () => {
  it('derives every list from its presence record, so a member cannot go unsaveable', () => {
    expect(FAULT_ASSERTION_KIND_LIST).toEqual([...FAULT_ASSERTION_KINDS]);
    expect(RACE_SCENARIO_KIND_LIST).toEqual([...RACE_SCENARIO_KINDS]);
    expect(RACE_REFUSAL_REASON_LIST).toEqual([...RACE_REFUSAL_REASONS]);
    expect(INTERLEAVING_ACTION_LIST).toEqual([...INTERLEAVING_ACTIONS]);
  });

  it('describes every assertion kind, so none can be emitted with no strength', () => {
    for (const kind of FAULT_ASSERTION_KINDS) {
      const descriptor = FAULT_ASSERTION_DESCRIPTORS[kind];
      expect(ASSERTION_STRENGTHS).toContain(descriptor.strength);
      expect(FAULT_EVIDENCE_NEEDS).toContain(descriptor.needs);
      expect(descriptor.claim.length).toBeGreaterThan(0);
      expect(descriptor.why.length).toBeGreaterThan(0);
      for (const state of descriptor.states) expect(FAULT_STATES).toContain(state);
    }
  });

  it('has exactly ONE weak assertion, and it needs no evidence so it is always a floor', () => {
    const weak = FAULT_ASSERTION_KINDS.filter(
      (kind) => FAULT_ASSERTION_DESCRIPTORS[kind].strength === 'WEAK',
    );
    expect(weak).toEqual(['SOME_ERROR_SHOWN']);
    expect(FAULT_ASSERTION_DESCRIPTORS.SOME_ERROR_SHOWN.needs).toBe('NONE');
  });

  it('gives every race kind an invariant and a principal count', () => {
    for (const kind of RACE_SCENARIO_KINDS) {
      expect(RACE_INVARIANTS).toContain(RACE_SCENARIO_INVARIANT[kind]);
      expect([1, 2]).toContain(RACE_PRINCIPALS_NEEDED[kind]);
    }
    for (const invariant of RACE_INVARIANTS) {
      expect(RACE_INVARIANT_DESCRIPTORS[invariant].claim.length).toBeGreaterThan(0);
      expect(RACE_INVARIANT_DESCRIPTORS[invariant].why.length).toBeGreaterThan(0);
    }
  });

  it('labels every budget and every release order', () => {
    for (const budget of FAULT_BUDGETS) expect(FAULT_BUDGET_LABELS[budget].length).toBeGreaterThan(0);
    for (const order of RELEASE_ORDERS) expect(RELEASE_ORDER_LABELS[order].length).toBeGreaterThan(0);
    for (const provenance of ASSERTION_PROVENANCES) expect(provenance.length).toBeGreaterThan(0);
  });
});

// ─── 1. Evidence gates the assertion ────────────────────────────────────────

describe('an assertion whose evidence is missing is not emitted', () => {
  it('writes no input-loss claim on a page with no typed fields', () => {
    const bare = plan();
    expect(kindsOf(scenarioFor(bare, 'ERROR'))).not.toContain('NO_INPUT_LOSS');
  });

  it('writes the input-loss claim, naming the fields, when the crawl saw them', () => {
    const rich = plan({ targets: [target({ observed: RICH_OBSERVATION })] });
    const assertion = scenarioFor(rich, 'ERROR')?.assertions.find(
      (candidate) => candidate.kind === 'NO_INPUT_LOSS',
    );
    expect(assertion).toBeDefined();
    // Naming the fields is what makes the generated test writable at all: a
    // claim about "the user's input" has no locator behind it.
    expect(assertion?.claim).toContain('search, dateFrom');
    expect(assertion?.strength).toBe('STRONG');
  });

  it("quotes the application's own error text verbatim rather than asserting 'an error'", () => {
    const rich = plan({ targets: [target({ observed: RICH_OBSERVATION })] });
    const named = scenarioFor(rich, 'ERROR')?.assertions.find(
      (candidate) => candidate.kind === 'ERROR_IS_NAMED',
    );
    expect(named?.claim).toBe('the message "We could not load your orders." appears, verbatim');
  });

  it('omits the named-error claim when nothing captured the text', () => {
    const bare = plan();
    expect(kindsOf(scenarioFor(bare, 'ERROR'))).not.toContain('ERROR_IS_NAMED');
  });

  it('omits the retry claim rather than inventing a control that never existed', () => {
    const noRetry = plan({
      targets: [target({ observed: { ...RICH_OBSERVATION, retryControl: null } })],
    });
    expect(kindsOf(scenarioFor(noRetry, 'ERROR'))).not.toContain('RETRY_RECOVERS');

    const withRetry = plan({ targets: [target({ observed: RICH_OBSERVATION })] });
    const retry = scenarioFor(withRetry, 'ERROR')?.assertions.find(
      (candidate) => candidate.kind === 'RETRY_RECOVERS',
    );
    expect(retry?.claim).toContain('"Try again"');
  });

  it('treats an unread console channel as unread, not as a silent application', () => {
    const unread = plan({
      targets: [target({ observed: { ...RICH_OBSERVATION, consoleChannelWorked: undefined } })],
    });
    expect(kindsOf(scenarioFor(unread, 'ERROR'))).not.toContain('NO_UNHANDLED_RUNTIME_ERROR');

    const read = plan({ targets: [target({ observed: RICH_OBSERVATION })] });
    expect(kindsOf(scenarioFor(read, 'ERROR'))).toContain('NO_UNHANDLED_RUNTIME_ERROR');
  });

  it('applies a state-specific assertion only in its own state', () => {
    const rich = plan({
      targets: [target({ observed: RICH_OBSERVATION })],
      states: ['ERROR', 'EMPTY', 'PARTIAL'],
    });
    expect(kindsOf(scenarioFor(rich, 'EMPTY'))).toContain('EMPTY_IS_NOT_ERROR');
    expect(kindsOf(scenarioFor(rich, 'ERROR'))).not.toContain('EMPTY_IS_NOT_ERROR');
    expect(kindsOf(scenarioFor(rich, 'PARTIAL'))).toContain('NO_PARTIAL_RENDER');
  });
});

describe('the weak floor, and the invariant that keeps it from standing alone', () => {
  it('EVERY planned scenario carries at least one STRONG assertion', () => {
    /*
     * The invariant, and the reason `weakOnly` is expected to be zero. It holds
     * because STAYS_ON_ROUTE needs no evidence and declares no state list, so
     * it applies everywhere — a property of the DESCRIPTOR TABLE rather than of
     * any code, which is exactly why it needs a test. Narrow that descriptor's
     * `states`, or add a state no strong assertion covers, and this goes red
     * instead of shipping scenarios that prove nothing.
     */
    for (const state of FAULT_STATES) {
      const set = planFaultScenarios({
        targets: [target({ observed: {} })],
        ownOrigins: OWN_ORIGINS,
        seed: 's',
        states: [state],
        budgets: { statesPerRequest: 1 },
      });
      const scenario = scenarioFor(set, state);
      expect(scenario, `no scenario planned for ${state}`).toBeDefined();
      expect(
        scenario?.assertions.some((assertion) => assertion.strength === 'STRONG'),
        `${state} has only weak assertions`,
      ).toBe(true);
      expect(scenario?.assertionStrength).toBe('STRONG');
      expect(set.weakOnly).toBe(0);
    }
  });

  it('keeps the floor BESIDE the strong assertions, never instead of them', () => {
    const bare = plan({ states: ['ERROR'], budgets: { statesPerRequest: 1 } });
    const kinds = kindsOf(scenarioFor(bare, 'ERROR'));
    expect(kinds).toContain('STAYS_ON_ROUTE');
    expect(kinds).toContain('SOME_ERROR_SHOWN');
    expect(kinds.at(-1)).toBe('SOME_ERROR_SHOWN');
    const floor = scenarioFor(bare, 'ERROR')?.assertions.at(-1);
    expect(floor?.basis).toContain('kept beside the stronger assertions');
  });

  it('omits the floor in a state where an error is not what should appear', () => {
    // EMPTY is a SUCCESSFUL response with nothing in it. An error-shaped thing
    // appearing there is the DEFECT, so asserting one would be backwards.
    const empty = plan({ states: ['EMPTY'], budgets: { statesPerRequest: 1 } });
    expect(kindsOf(scenarioFor(empty, 'EMPTY'))).not.toContain('SOME_ERROR_SHOWN');
  });

  it('never emits a scenario with no assertions at all', () => {
    const bare = plan({ states: [...FAULT_STATES], budgets: { statesPerRequest: 8 } });
    for (const scenario of bare.scenarios) {
      if (scenario.exercise !== null) continue; // a refusal asserts nothing, by design
      expect(scenario.assertions.length, `${scenario.state} asserts nothing`).toBeGreaterThan(0);
    }
  });

  it('reports the weak-floor count as a measured number in the rule', () => {
    expect(plan().rule).toContain('a measured count, not an assumed zero');
  });
});

describe('provenance: a regression and a first finding are not the same', () => {
  it('marks an assertion OBSERVED when the crawl drove that exact fault', () => {
    const driven = plan({
      targets: [
        target({
          observed: {
            ...RICH_OBSERVATION,
            underFault: {
              ERROR: {
                structural: 'ERROR',
                errorText: 'Something went wrong',
                inputPreserved: false,
                finalRoute: '/orders',
              },
            },
          },
        }),
      ],
    });
    const scenario = scenarioFor(driven, 'ERROR');
    /*
     * Every assertion EXCEPT the floor. The floor is deliberately always
     * DERIVED: "something error-shaped becomes visible" is a requirement and
     * not a reading, so marking it OBSERVED would claim the crawl confirmed a
     * sentence it never evaluated.
     */
    const pinned = (scenario?.assertions ?? []).filter(
      (assertion) => assertion.kind !== 'SOME_ERROR_SHOWN',
    );
    expect(pinned.length).toBeGreaterThan(0);
    expect(pinned.every((assertion) => assertion.provenance === 'OBSERVED')).toBe(true);
    expect(
      scenario?.assertions.find((assertion) => assertion.kind === 'SOME_ERROR_SHOWN')?.provenance,
    ).toBe('DERIVED');
    // The DRIVEN text beats the baseline one: it is what the page says in this
    // state, and asserting the baseline sentence under a fault is the wrong
    // assertion.
    const named = scenario?.assertions.find((candidate) => candidate.kind === 'ERROR_IS_NAMED');
    expect(named?.claim).toContain('Something went wrong');
    // And a fault the crawl ALREADY saw lose the input is pinned as such.
    const loss = scenario?.assertions.find((candidate) => candidate.kind === 'NO_INPUT_LOSS');
    expect(loss?.basis).toContain('pins a known defect');
  });

  it('marks it DERIVED when nobody drove it, so a failure reads as a new finding', () => {
    const rich = plan({ targets: [target({ observed: RICH_OBSERVATION })] });
    const scenario = scenarioFor(rich, 'ERROR');
    expect(scenario?.assertions.every((assertion) => assertion.provenance === 'DERIVED')).toBe(true);
    expect(scenario?.assertions[0]?.basis).toContain('requirement rather than a regression');
  });

  it('distinguishes "the drive ran and read nothing" from "no drive"', () => {
    /*
     * An empty `underFault` entry is a drive that happened: the assertions are
     * OBSERVED even though the reading was null, because the crawl DID reach
     * this state. An absent entry is no drive at all. Collapsing the two would
     * report a drive that read nothing as a requirement nobody has checked.
     */
    const readNothing = plan({
      targets: [
        target({
          observed: {
            ...RICH_OBSERVATION,
            underFault: {
              ERROR: { structural: null, errorText: null, inputPreserved: null, finalRoute: null },
            },
          },
        }),
      ],
    });
    const loss = scenarioFor(readNothing, 'ERROR')?.assertions.find(
      (assertion) => assertion.kind === 'NO_INPUT_LOSS',
    );
    expect(loss?.provenance).toBe('OBSERVED');
    // A null reading is not a confirmed loss, so the known-defect note is absent.
    expect(loss?.basis).not.toContain('pins a known defect');
  });
});

// ─── 3. No clock, and the crawl's figure survives ───────────────────────────

describe('a delay becomes a held response, never a sleep', () => {
  it('converts both DELAY states to HOLD with a release CONDITION', () => {
    const slow = plan({ states: ['SLOW', 'LOADING'] });
    const slowScenario = scenarioFor(slow, 'SLOW');
    const loadingScenario = scenarioFor(slow, 'LOADING');

    expect(slowScenario?.interception.verb).toBe('HOLD');
    expect(loadingScenario?.interception.verb).toBe('HOLD');
    expect(RELEASE_CONDITIONS).toContain(slowScenario?.interception.releaseOn);
    // SLOW's whole point is giving a double-submit guard a chance to be wrong,
    // so it releases on the SECOND request rather than on the assertion.
    expect(slowScenario?.interception.releaseOn).toBe('AFTER_SECOND_REQUEST_SEEN');
    expect(loadingScenario?.interception.releaseOn).toBe('AFTER_ASSERTION');
  });

  it("carries the crawl's declared millisecond figure through, so nothing is lost", () => {
    const slow = plan({ states: ['SLOW', 'LOADING'] });
    expect(scenarioFor(slow, 'SLOW')?.interception.declaredDelayMillis).toBe(
      FAULT_MECHANISMS.SLOW.delayMillis,
    );
    expect(scenarioFor(slow, 'LOADING')?.interception.declaredDelayMillis).toBe(
      FAULT_MECHANISMS.LOADING.delayMillis,
    );
  });

  it('turns a STATUS mechanism into a FULFILL with that status', () => {
    const errors = plan({
      states: ['ERROR', 'FORBIDDEN', 'NOT_FOUND', 'RATE_LIMITED'],
      budgets: { statesPerRequest: 4 },
    });
    expect(scenarioFor(errors, 'ERROR')?.interception.status).toBe(500);
    expect(scenarioFor(errors, 'FORBIDDEN')?.interception.status).toBe(403);
    expect(scenarioFor(errors, 'NOT_FOUND')?.interception.status).toBe(404);
    expect(scenarioFor(errors, 'RATE_LIMITED')?.interception.status).toBe(429);
    expect(scenarioFor(errors, 'ERROR')?.interception.verb).toBe('FULFILL');
  });

  it('turns a BODY mechanism into a FULFILL with the body shape', () => {
    const bodies = plan({ states: ['EMPTY', 'PARTIAL'] });
    expect(scenarioFor(bodies, 'EMPTY')?.interception.body).toBe('EMPTY_COLLECTION');
    expect(scenarioFor(bodies, 'PARTIAL')?.interception.body).toBe('TRUNCATED');
  });

  it('names ONE interception mechanism, so a generator cannot invent a second', () => {
    for (const scenario of plan({ states: [...FAULT_STATES] }).scenarios) {
      expect(scenario.interception.mechanismModule).toBe(INTERCEPTION_MECHANISM);
    }
    expect(INTERCEPTION_MECHANISM).toContain('har.ts');
  });

  it('never puts a query string in an intercepted path', () => {
    const noisy = plan({
      targets: [
        target({
          requests: [request({ method: 'GET', path: '/api/orders?token=abc123&q=diagnosis#frag' })],
        }),
      ],
    });
    for (const scenario of noisy.scenarios) {
      expect(scenario.interception.pathGlob).toBe('/api/orders');
      expect(scenario.match.pathGlob).not.toContain('?');
      expect(scenario.match.pathGlob).not.toContain('token');
    }
  });
});

// ─── 4. Refusals are recorded, not skipped ──────────────────────────────────

describe('a request that may not be failed is RECORDED as refused', () => {
  it('refuses a non-idempotent request with the rule, once — not once per state', () => {
    const mutating = plan({
      targets: [
        target({
          requests: [
            request({ method: 'POST', path: '/api/orders' }),
            request({ method: 'GET', path: '/api/orders' }),
          ],
        }),
      ],
      states: ['ERROR', 'EMPTY', 'SLOW'],
    });
    const refused = mutating.scenarios.filter((scenario) => scenario.exercise !== null);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.exercise?.state).toBe('REFUSED');
    expect(refused[0]?.exercise?.rule).toContain('non-idempotent');
    expect(refused[0]?.exercise?.detail).toContain('not the same as the page having none');
    // The safe sibling is still planned, three states' worth.
    expect(mutating.scenarios.filter((scenario) => scenario.exercise === null)).toHaveLength(3);
  });

  it('refuses an off-origin request, because failing it tests somebody else’s surface', () => {
    const external = plan({
      targets: [
        target({
          requests: [request({ method: 'GET', path: '/v1/charges', origin: 'https://api.stripe.com' })],
        }),
      ],
    });
    const refused = external.scenarios.filter((scenario) => scenario.exercise !== null);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.exercise?.rule).toContain('stripe.com');
  });

  it('partitions the observed requests: faults take the idempotent half, races the rest', () => {
    /*
     * A property worth pinning because the two halves of this module must not
     * overlap: a fault injected against a POST would ISSUE the POST, and a race
     * against a GET would race nothing. `IDEMPOTENT_METHODS` and
     * `isSafeProbeMethod` are the two gates, and this asserts they agree.
     */
    const observed = [
      request({ method: 'GET', path: '/api/orders' }),
      request({ method: 'POST', path: '/api/orders' }),
      request({ method: 'DELETE', path: '/api/orders/1' }),
    ];
    const faults = plan({ targets: [target({ requests: observed })], states: ['ERROR'] });
    const faulted = faults.scenarios
      .filter((scenario) => scenario.exercise === null)
      .map((scenario) => scenario.match.method);
    expect(faulted).toEqual(['GET']);
    for (const method of faulted) expect(IDEMPOTENT_METHODS).toContain(method);

    const raced = races({
      targets: [raceTarget({ requests: observed.map((r) => ({ ...r, issuedFromRoute: '/checkout' })) })],
    });
    expect(raced.scenarios.every((scenario) => !IDEMPOTENT_METHODS.includes(scenario.match.method))).toBe(
      true,
    );
  });
});

describe('every cap is a count and a reason', () => {
  it('DISCLOSES the states it did not plan, naming how many exist', () => {
    const three = plan({ states: [...FAULT_STATES], budgets: { statesPerRequest: 3 } });
    const bite = three.caps.find((cap) => cap.cap === 'STATES_PER_REQUEST');
    expect(bite?.limit).toBe(3);
    expect(bite?.discarded).toBe(FAULT_STATES.length - 3);
    expect(bite?.reason).toContain(`${FAULT_STATES.length}`);
  });

  it('DISCLOSES the per-route request cap', () => {
    const many = plan({
      targets: [
        target({
          requests: [
            request({ method: 'GET', path: '/api/a' }),
            request({ method: 'GET', path: '/api/b' }),
            request({ method: 'GET', path: '/api/c' }),
          ],
        }),
      ],
      budgets: { requestsPerRoute: 1, statesPerRequest: 1 },
      states: ['ERROR'],
    });
    const bite = many.caps.find((cap) => cap.cap === 'REQUESTS_PER_ROUTE');
    expect(bite?.discarded).toBe(2);
    expect(many.scenarios.filter((scenario) => scenario.exercise === null)).toHaveLength(1);
  });

  it('DISCLOSES the whole-plan cap', () => {
    const capped = plan({ states: [...FAULT_STATES], budgets: { scenariosTotal: 2, statesPerRequest: 8 } });
    expect(capped.scenarios).toHaveLength(2);
    expect(capped.caps.find((cap) => cap.cap === 'SCENARIOS_TOTAL')?.discarded).toBeGreaterThan(0);
  });
});

describe('state cells: one format, and no guesses', () => {
  it('claims the cell the caller named, spelled by stateCellKey', () => {
    const named = plan({
      targets: [
        target({
          coverageItemKey: 'ROUTE:/orders',
          cellKindForState: { ERROR: 'ERROR_SERVER' },
        }),
      ],
      states: ['ERROR'],
    });
    const scenario = scenarioFor(named, 'ERROR');
    expect(scenario?.cellKind).toBe('ERROR_SERVER');
    expect(scenario?.cellKey).toBe(stateCellKey({ itemKey: 'ROUTE:/orders', kind: 'ERROR_SERVER' }));
  });

  it("accepts coverage-states' own FAULT_STATE_CELL table with no conversion", () => {
    /*
     * A COMPILE-TIME check as much as a run-time one: `FAULT_STATE_CELL` is
     * `Record<FaultState, CoverageCellKind | null>`, and if this input ever
     * narrows to exclude null, the caller has to write a second mapping — which
     * is how two tables for one question come to disagree.
     */
    const set = plan({
      targets: [target({ coverageItemKey: 'ROUTE:/orders', cellKindForState: FAULT_STATE_CELL })],
      states: ['ERROR', 'EMPTY', 'LOADING'],
      budgets: { statesPerRequest: 3 },
    });
    expect(scenarioFor(set, 'ERROR')?.cellKind).toBe(FAULT_STATE_CELL.ERROR);
    expect(scenarioFor(set, 'ERROR')?.cellKey).toBe(
      stateCellKey({ itemKey: 'ROUTE:/orders', kind: 'ERROR_SERVER' }),
    );
    expect(scenarioFor(set, 'EMPTY')?.cellKind).toBe(FAULT_STATE_CELL.EMPTY);
  });

  it('treats a NULL mapping as "this fault has no cell", not as an unasked question', () => {
    const nulled = plan({
      targets: [target({ cellKindForState: { ERROR: null } })],
      states: ['ERROR'],
      budgets: { statesPerRequest: 1 },
    });
    expect(scenarioFor(nulled, 'ERROR')?.cellKey).toBeNull();
    expect(scenarioFor(nulled, 'ERROR')?.cellKind).toBeNull();
    // Counted either way, so the report can never imply a cell was driven.
    expect(nulled.cellsUnclaimed).toBe(1);
  });

  it('claims NO cell when no caller named one, and counts the gap', () => {
    const unnamed = plan({ states: ['ERROR'] });
    expect(scenarioFor(unnamed, 'ERROR')?.cellKey).toBeNull();
    expect(unnamed.cellsUnclaimed).toBe(1);
    expect(unnamed.rule).toContain('claim no state cell');
  });
});

describe('fault-plan determinism', () => {
  it('is byte-identical for the same seed', () => {
    const once = JSON.stringify(plan({ targets: [target({ observed: RICH_OBSERVATION })] }));
    const twice = JSON.stringify(plan({ targets: [target({ observed: RICH_OBSERVATION })] }));
    expect(once).toBe(twice);
  });

  it('is byte-identical regardless of the order the requests and targets arrive in', () => {
    const requests = [
      request({ method: 'GET', path: '/api/b' }),
      request({ method: 'GET', path: '/api/a' }),
    ];
    const forward = planFaultScenarios({
      targets: [target({ route: '/a', requests }), target({ route: '/b', requests })],
      ownOrigins: OWN_ORIGINS,
      seed: 's',
    });
    const reversed = planFaultScenarios({
      targets: [target({ route: '/b', requests: [...requests].reverse() }), target({ route: '/a', requests: [...requests].reverse() })],
      ownOrigins: OWN_ORIGINS,
      seed: 's',
    });
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });
});

// ─── 5–8. Races ─────────────────────────────────────────────────────────────

describe('nothing mutates without a principal proveDisposable vouched for', () => {
  it("REFUSES every race against the customer's own account, and says why", () => {
    const set = races({ principals: [CUSTOMER_ACCOUNT] });
    expect(set.scenarios).toEqual([]);
    expect(set.refused.length).toBeGreaterThan(0);

    const refusal = set.refused[0]?.refusal;
    expect(refusal?.reason).toBe('NO_DISPOSABLE_PRINCIPAL');
    // The UNDERLYING reason is carried through, not flattened: "this is the
    // customer's own account" and "names no creating scenario" are two
    // different things for a customer to fix.
    expect(refusal?.disposability?.reason).toBe('PERSISTENT_PRINCIPAL');
    expect(refusal?.disposability?.detail).toContain('may never be damaged');
  });

  it('REFUSES the run default even when it is labelled disposable', () => {
    const copiedSession = principal({
      name: DEFAULT_PRINCIPAL_NAME,
      kind: 'DISPOSABLE',
      lifecycle: 'ACTIVE',
      createdByScenario: 'pretending',
    });
    const set = races({ principals: [copiedSession] });
    expect(set.scenarios).toEqual([]);
    expect(set.refused[0]?.refusal?.disposability?.reason).toBe('IS_RUN_DEFAULT');
  });

  it('refuses a disposable principal that names no creating scenario', () => {
    const unverified = principal({ name: 'ghost', kind: 'DISPOSABLE', lifecycle: 'ACTIVE' });
    const set = races({ principals: [unverified] });
    expect(set.refused[0]?.refusal?.disposability?.reason).toBe('NO_CREATING_SCENARIO');
  });

  it('refuses no principal at all with a sentence that says so', () => {
    const set = races({ principals: [] });
    expect(set.refused[0]?.refusal?.detail).toContain('No principal was supplied at all');
    expect(set.refused[0]?.refusal?.disposability).toBeNull();
  });

  it('keeps the runnable and refused lists SEPARATE, so a refusal cannot be run', () => {
    const set = races({ principals: [CUSTOMER_ACCOUNT] });
    // The one mistake this module may not make possible.
    expect(set.scenarios.every((scenario) => scenario.refusal === null)).toBe(true);
    expect(set.refused.every((scenario) => scenario.refusal !== null)).toBe(true);
    expect(set.refused.every((scenario) => scenario.assertions.length === 0)).toBe(true);
    expect(set.rule).toContain('RECORDED REFUSAL');
  });

  it('refuses a two-actor scenario when the run has one disposable principal', () => {
    const set = races({ principals: [disposable('solo')] });
    expect(refusalFor(set, 'CONCURRENT_EDIT')).toBe('NEEDS_SECOND_PRINCIPAL');
    // The one-actor kinds still run.
    expect(set.scenarios.map((scenario) => scenario.kind)).toContain('DOUBLE_SUBMIT');
  });

  it('never puts a credential in a scenario — only principal NAMES', () => {
    const set = races();
    const serialised = JSON.stringify(set);
    expect(serialised).not.toContain('storageState');
    expect(serialised).not.toContain('password');
    for (const scenario of set.scenarios) {
      expect(scenario.principals.every((name) => typeof name === 'string')).toBe(true);
      expect(scenario.principals).toEqual(['shopperA', 'shopperB'].slice(0, scenario.principals.length));
    }
  });
});

describe('the invariant is the assertion, not the message', () => {
  it('asserts the kind’s invariant and explains why a message would not do', () => {
    const set = races({ budgets: { raceKindsPerRoute: 5 } });
    for (const scenario of set.scenarios) {
      expect(scenario.invariant).toBe(RACE_SCENARIO_INVARIANT[scenario.kind]);
      expect(scenario.assertions[0]?.strength).toBe('STRONG');
      expect(scenario.assertions[0]?.claim).toBe(
        RACE_INVARIANT_DESCRIPTORS[scenario.invariant].claim,
      );
    }
    const double = set.scenarios.find((scenario) => scenario.kind === 'DOUBLE_SUBMIT');
    expect(double?.assertions[0]?.claim).toContain('exactly one');
  });

  it('runs the replay with no idempotency key and reports the missing key as a finding', () => {
    const set = races({ budgets: { raceKindsPerRoute: 5 } });
    const replay = set.scenarios.find((scenario) => scenario.kind === 'IDEMPOTENT_REPLAY');
    expect(replay?.idempotencyKeyHeader).toBeNull();
    const extra = replay?.assertions.find((assertion) => assertion.invariant === 'EXACTLY_ONE_EFFECT');
    expect(extra?.basis).toContain('itself a finding');
  });

  it('records the observed key header when the crawl saw one', () => {
    const set = races({
      targets: [raceTarget({ idempotencyKeyHeader: 'idempotency-key' })],
      budgets: { raceKindsPerRoute: 5 },
    });
    const replay = set.scenarios.find((scenario) => scenario.kind === 'IDEMPOTENT_REPLAY');
    expect(replay?.idempotencyKeyHeader).toBe('idempotency-key');
    expect(replay?.assertions).toHaveLength(1);
  });
});

describe('the interleaving is reproducible, and has no clock in it', () => {
  it('uses only actions and event waits — never a duration', () => {
    const set = races({ budgets: { raceKindsPerRoute: 5 } });
    expect(set.scenarios.length).toBeGreaterThan(0);
    for (const scenario of set.scenarios) {
      for (const step of scenario.interleaving.steps) {
        expect(INTERLEAVING_ACTION_LIST).toContain(step.action);
        // A sleep would be both the slowest wait and the least reliable one,
        // and the admission gate's NO_FIXED_SLEEP rule would flag the code.
        expect(step.detail).not.toMatch(/\d+\s*(ms|milliseconds|seconds|s)\b/);
      }
      const actions = scenario.interleaving.steps.map((step) => step.action);
      expect(actions[0]).toBe('ARM_GATE');
      expect(actions.at(-1)).toBe('CHECK_INVARIANT');
      expect(actions).toContain('AWAIT_SETTLED');
      // Two submissions, both put in flight before anything is released.
      expect(actions.filter((action) => action === 'SUBMIT')).toHaveLength(2);
      const firstRelease = actions.indexOf('RELEASE');
      expect(actions.lastIndexOf('SUBMIT')).toBeLessThan(firstRelease);
    }
  });

  it('waits for BOTH requests to be in flight before releasing either', () => {
    const set = races();
    const steps = set.scenarios[0]?.interleaving.steps ?? [];
    const counts = steps
      .filter((step) => step.action === 'AWAIT_IN_FLIGHT')
      .map((step) => step.count);
    expect(counts).toEqual([1, 2]);
  });

  it('names the release order it took and carries a replay token', () => {
    const set = races({ budgets: { raceKindsPerRoute: 5 } });
    for (const scenario of set.scenarios) {
      expect(RELEASE_ORDERS).toContain(scenario.interleaving.order);
      expect(scenario.interleaving.derivedFrom.length).toBeGreaterThan(0);
      expect(scenario.interleaving.rule).toContain(scenario.interleaving.derivedFrom);
      expect(scenario.interleaving.rule).toContain(RELEASE_ORDER_LABELS[scenario.interleaving.order]);
      expect(scenario.interleaving.rule).toContain('No step waits for the clock');
    }
  });

  it('DISCLOSES the release orders it did not take, because they are different bugs', () => {
    const set = races({ budgets: { releaseOrdersPerScenario: 1, raceKindsPerRoute: 5 } });
    const bite = set.caps.find((cap) => cap.cap === 'RELEASE_ORDERS_PER_SCENARIO');
    expect(bite?.limit).toBe(1);
    expect(bite?.discarded).toBe((RELEASE_ORDERS.length - 1) * 5);
    expect(bite?.reason).toContain('three different bugs');
  });

  it('DISCLOSES the race kinds it did not plan', () => {
    const set = races({ budgets: { raceKindsPerRoute: 2 } });
    const bite = set.caps.find((cap) => cap.cap === 'RACE_KINDS_PER_ROUTE');
    expect(bite?.discarded).toBe(RACE_SCENARIO_KINDS.length - 2);
  });

  it('is byte-identical for the same seed, and the seed picks the order', () => {
    const once = JSON.stringify(races({ budgets: { raceKindsPerRoute: 5 } }));
    const twice = JSON.stringify(races({ budgets: { raceKindsPerRoute: 5 } }));
    expect(once).toBe(twice);

    const orders = new Set(
      ['s1', 's2', 's3', 's4', 's5', 's6'].map(
        (seed) => races({ seed, budgets: { raceKindsPerRoute: 1 } }).scenarios[0]?.interleaving.order,
      ),
    );
    // If the seed could only ever produce one order it would be decoration,
    // and one third of every race would be permanently unreachable.
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('a bot defence is reported, never bypassed', () => {
  it('refuses with the provider’s own remedy and drives nothing', () => {
    const set = races({
      targets: [
        raceTarget({ botProtection: { provider: 'TURNSTILE', bypassMode: 'NOT_CONFIGURED' } }),
      ],
    });
    expect(set.scenarios).toEqual([]);
    expect(refusalFor(set, 'DOUBLE_SUBMIT')).toBe('UNREACHABLE_BEHIND_BOT_PROTECTION');

    const detail = set.refused[0]?.refusal?.detail ?? '';
    expect(detail).toContain('Nothing here solves or evades a challenge');
    expect(detail).toContain('test keys');
  });

  it('runs normally when the customer configured a legitimate route past it', () => {
    const set = races({
      targets: [
        raceTarget({ botProtection: { provider: 'TURNSTILE', bypassMode: 'PROVIDER_TEST_KEYS' } }),
      ],
    });
    expect(set.scenarios.length).toBeGreaterThan(0);
  });
});

describe('a race with nothing to race is refused, not passed', () => {
  it('refuses a route that only reads', () => {
    const set = races({
      targets: [raceTarget({ requests: [request({ method: 'GET', path: '/api/orders' })] })],
    });
    expect(set.scenarios).toEqual([]);
    expect(refusalFor(set, 'DOUBLE_SUBMIT')).toBe('NO_MUTATING_REQUEST');
    expect(set.refused[0]?.refusal?.detail).toContain('cannot double-charge');
  });

  it('distinguishes an UNREAD field classification from a classified-and-none one', () => {
    const unread = races({
      targets: [raceTarget({ uniqueFieldNames: undefined })],
      budgets: { raceKindsPerRoute: 5 },
    });
    const classified = races({
      targets: [raceTarget({ uniqueFieldNames: [] })],
      budgets: { raceKindsPerRoute: 5 },
    });
    const detailOf = (set: ReturnType<typeof planRaceScenarios>): string =>
      set.refused.find((scenario) => scenario.kind === 'DUPLICATE_UNIQUE_CREATE')?.refusal?.detail ??
      '';
    expect(detailOf(unread)).toContain('unread constraint');
    expect(detailOf(classified)).toContain('none carries a uniqueness');
    expect(detailOf(unread)).not.toBe(detailOf(classified));
  });

  it('runs the duplicate-create scenario once a unique field is known', () => {
    const set = races({
      targets: [raceTarget({ uniqueFieldNames: ['email'] })],
      budgets: { raceKindsPerRoute: 5 },
    });
    expect(set.scenarios.map((scenario) => scenario.kind)).toContain('DUPLICATE_UNIQUE_CREATE');
  });

  it('refuses a cancel-races-confirm with no observed cancel control', () => {
    const set = races({ budgets: { raceKindsPerRoute: 5 } });
    expect(refusalFor(set, 'CANCEL_RACES_CONFIRM')).toBe('NO_CANCEL_CONTROL');
    expect(set.refused.find((scenario) => scenario.kind === 'CANCEL_RACES_CONFIRM')?.refusal?.detail)
      .toContain('locator that never existed');
  });

  it('uses the observed cancel control when there is one', () => {
    const set = races({
      targets: [raceTarget({ cancelControl: { identity: 'btn:cancel', label: 'Cancel' } })],
      budgets: { raceKindsPerRoute: 5 },
    });
    const cancel = set.scenarios.find((scenario) => scenario.kind === 'CANCEL_RACES_CONFIRM');
    expect(cancel?.control?.label).toBe('Cancel');
    expect(cancel?.interleaving.steps.some((step) => step.detail.includes('cancels while'))).toBe(
      true,
    );
  });
});

describe('the budget defaults are deliberate', () => {
  it('takes three fault states by default, matching DEFAULT_FAULT_STATES', () => {
    expect(DEFAULT_FAULT_BUDGETS.statesPerRequest).toBe(3);
    expect(DEFAULT_FAULT_BUDGETS.releaseOrdersPerScenario).toBe(1);
    expect(DEFAULT_FAULT_BUDGETS.raceKindsPerRoute).toBeLessThan(RACE_SCENARIO_KINDS.length);
  });

  it('plans ERROR, EMPTY and SLOW when the caller names no states', () => {
    const defaults = plan();
    expect(defaults.scenarios.map((scenario) => scenario.state).sort()).toEqual([
      'EMPTY',
      'ERROR',
      'SLOW',
    ]);
  });
});
