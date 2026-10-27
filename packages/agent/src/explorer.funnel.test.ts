/**
 * THE TYPE FUNNEL — the round's headline register item, and its counter-tests.
 *
 * The crawl path could propose FIVE test types and the deterministic path TWO,
 * against nineteen minted types and thirty declared ones. Nine MINTED types had
 * a working plugin and no producer anywhere in the product. These tests pin the
 * widening and — more of them — pin the two ways widening goes wrong:
 *
 *   1. PROPOSING A TYPE THE APPLICATION DID NOT EARN. Thirty items per crawl
 *      about surfaces that do not exist turns the review queue into noise and
 *      the customer stops reading it, which is worse than fourteen unreachable
 *      types. Most of this file is about refusals.
 *   2. REPORTING "WE DID NOT LOOK" AS "IT IS NOT THERE". A crawl cannot see a
 *      database, a CLI or a native build. A funnel that reported those as
 *      ABSENT would be telling a customer their application has no database
 *      because nobody asked.
 *
 * MODEL-FREE. There is no `LlmService` in this file, because the path under
 * test has no model in it.
 */

import { describe, expect, it } from 'vitest';
import {
  ANY_TEST_TYPES,
  PENDING_TEST_TYPES,
  TEST_TYPES,
  declarationFor,
  planItemSchema,
} from '@qaai/shared';
import type { FlowMap, FormField, FormModel, FlowNode } from '@qaai/shared';
import {
  DELEGATED_TO_CRAWL,
  PLAN_ITEM_ASSERTION_LIMIT,
  PRECONDITIONS_ARE_NON_EMPTY,
  SCENARIO_KINDS,
  SCENARIO_KIND_RISK,
  TYPE_PRECONDITIONS,
  TYPE_SIGNALS,
  TYPE_SIGNAL_LIST,
  earnsType,
  proposeScenarioPlan,
  proposeTypeCoverage,
  reading,
  signalsFromFlowMap,
  summariseProposableTypes,
} from './explorer.js';
import type { TypeSignals } from './explorer.js';

const SEED = 'seed-funnel';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const field = (over: Partial<FormField> = {}): FormField => ({
  name: 'f',
  label: 'F',
  inputType: 'text',
  required: true,
  selector: { strategy: 'CSS', value: '#f', confidence: 1 },
  semantic: 'freeform',
  ...over,
});

const form = (fields: FormField[]): FormModel => ({
  id: 'form1',
  name: 'Form',
  selector: { strategy: 'CSS', value: 'form', confidence: 1 },
  fields,
  submit: { strategy: 'CSS', value: 'button', confidence: 1 },
});

const node = (over: Partial<FlowNode> = {}): FlowNode => ({
  id: 'n1',
  route: '/',
  url: 'https://app.test/',
  title: 'Home',
  stateKey: 'default',
  requiresRoles: [],
  behindAuth: false,
  forms: [],
  affordances: [],
  screenshotKey: null,
  a11yViolationCount: 0,
  ...over,
});

const flowMap = (nodes: FlowNode[], over: Partial<FlowMap> = {}): FlowMap => ({
  projectId: 'p',
  environmentId: 'e',
  version: 1,
  baseUrl: 'https://app.test',
  nodes,
  edges: [],
  journeys: [],
  features: [],
  exploredAt: '2026-01-01T00:00:00.000Z',
  truncatedReason: null,
  ...over,
});

// ─── The table itself ────────────────────────────────────────────────────────

describe('the funnel is a declared table, and the table is total', () => {
  it('declares a rule for every one of the thirty types', () => {
    expect(Object.keys(TYPE_PRECONDITIONS).sort()).toEqual([...ANY_TEST_TYPES].sort());
    expect(ANY_TEST_TYPES.length).toBe(TEST_TYPES.length + PENDING_TEST_TYPES.length);
  });

  it('refuses a row that would fire against every application for ever', () => {
    // The module-load guard already ran; this asserts what it checked, so a
    // reader can see the condition rather than trusting that it exists.
    expect(PRECONDITIONS_ARE_NON_EMPTY.length).toBe(ANY_TEST_TYPES.length);
    for (const type of ANY_TEST_TYPES) {
      const rule = TYPE_PRECONDITIONS[type];
      expect(
        rule.all.length + rule.any.length,
        `${type} declares no signal, so it would be proposed unconditionally`,
      ).toBeGreaterThan(0);
    }
  });

  it('names only signals the vocabulary declares', () => {
    for (const type of ANY_TEST_TYPES) {
      for (const signal of [...TYPE_PRECONDITIONS[type].all, ...TYPE_PRECONDITIONS[type].any]) {
        expect(TYPE_SIGNAL_LIST).toContain(signal);
      }
    }
    expect(TYPE_SIGNAL_LIST).toEqual([...TYPE_SIGNALS]);
  });

  it('gives every type a rule a reviewer can dispute on its own', () => {
    for (const type of ANY_TEST_TYPES) {
      const rule = TYPE_PRECONDITIONS[type];
      expect(rule.rule.length, `${type} has no rule sentence`).toBeGreaterThan(40);
      expect(rule.assertions.length, `${type} proposes nothing to assert`).toBeGreaterThan(0);
      expect(rule.steps.length).toBeGreaterThan(0);
    }
  });

  it('gives TYPE_COVERAGE a tier that cannot overtake the kind above it', () => {
    expect(SCENARIO_KINDS).toContain('TYPE_COVERAGE');
    const own = SCENARIO_KIND_RISK.TYPE_COVERAGE.points;
    expect(own).toBeLessThan(SCENARIO_KIND_RISK.MULTI_ACTOR.points);
    expect(own).toBeGreaterThan(SCENARIO_KIND_RISK.FAULT_INJECTION.points);
  });
});

// ─── The three-valued signal ─────────────────────────────────────────────────

describe('an absent key means NOT PROBED, never ABSENT', () => {
  it('reads a key nobody set as NOT_PROBED', () => {
    expect(reading({}, 'DATABASE_REACHABLE')).toBe('NOT_PROBED');
    expect(reading({ DATABASE_REACHABLE: 'ABSENT' }, 'DATABASE_REACHABLE')).toBe('ABSENT');
  });

  it('is UNKNOWN, not "no such surface", when nothing was enumerated', () => {
    const verdict = earnsType('DATABASE', {});
    expect(verdict.decision).toBe('NOT_PROBED');
    if (verdict.decision !== 'NOT_PROBED') throw new Error('unreachable');
    expect(verdict.unprobed).toEqual(['DATABASE_REACHABLE']);
    expect(verdict.why).toContain('hole in the enumeration');
    /*
     * The message QUOTES the reading it forbids, so asserting the absence of
     * that phrase was the wrong test (it failed on the warning itself). What
     * matters is that the sentence says the two are different, and that it
     * never claims the surface is absent.
     */
    expect(verdict.why).toContain('NOT a fact about the application');
    expect(verdict.why).not.toMatch(/this application has no/);
  });

  it('is a FINISHED answer when the enumeration looked and found nothing', () => {
    const verdict = earnsType('DATABASE', { DATABASE_REACHABLE: 'ABSENT' });
    expect(verdict.decision).toBe('NOT_WARRANTED');
    if (verdict.decision !== 'NOT_WARRANTED') throw new Error('unreachable');
    expect(verdict.why).toContain('looked');
    expect(verdict.absent).toEqual(['DATABASE_REACHABLE']);
  });
});

describe('the resolution rule', () => {
  it('settles a conjunction on ONE definitive absence, whatever else was probed', () => {
    // UNIT_GEN needs UNIT_RUNNER and TESTABLE_LOGIC. No runner is enough.
    const verdict = earnsType('UNIT_GEN', { UNIT_RUNNER: 'ABSENT' });
    expect(verdict.decision).toBe('NOT_WARRANTED');
  });

  it('leaves a conjunction OPEN when a member is merely unprobed', () => {
    const verdict = earnsType('UNIT_GEN', { UNIT_RUNNER: 'PRESENT' });
    expect(verdict.decision).toBe('NOT_PROBED');
    if (verdict.decision !== 'NOT_PROBED') throw new Error('unreachable');
    expect(verdict.unprobed).toEqual(['TESTABLE_LOGIC']);
  });

  it('needs EVERY member of a disjunction absent before it is settled', () => {
    // DOCUMENT is any: [DOCUMENT_OUTPUT, FILE_INPUT].
    expect(earnsType('DOCUMENT', { DOCUMENT_OUTPUT: 'ABSENT' }).decision).toBe('NOT_PROBED');
    expect(
      earnsType('DOCUMENT', { DOCUMENT_OUTPUT: 'ABSENT', FILE_INPUT: 'ABSENT' }).decision,
    ).toBe('NOT_WARRANTED');
  });

  it('is satisfied by ONE member of a disjunction', () => {
    const verdict = earnsType('DOCUMENT', { FILE_INPUT: 'PRESENT' });
    expect(verdict.decision).toBe('UNMINTED');
    if (verdict.decision !== 'UNMINTED') throw new Error('unreachable');
    expect(verdict.evidence).toEqual(['FILE_INPUT']);
  });
});

// ─── The nine minted types nothing proposed ──────────────────────────────────

describe('the nine MINTED types with no producer are now proposable', () => {
  const EARNED: ReadonlyArray<[string, TypeSignals]> = [
    ['LOCALIZATION', { MULTIPLE_LOCALES: 'PRESENT', RENDERED_ROUTE: 'PRESENT' }],
    ['CROSS_BROWSER', { MULTIPLE_BROWSERS: 'PRESENT', RENDERED_ROUTE: 'PRESENT' }],
    ['MOBILE', { NATIVE_APP_BUILD: 'PRESENT' }],
    ['EMAIL_OTP', { EMAIL_SIGN_IN: 'PRESENT' }],
    ['DATABASE', { DATABASE_REACHABLE: 'PRESENT' }],
    ['CLI', { CLI_ENTRYPOINT: 'PRESENT' }],
    ['INTEGRATION', { PROJECT_TEST_COMMAND: 'PRESENT' }],
    ['UNIT_GEN', { UNIT_RUNNER: 'PRESENT', TESTABLE_LOGIC: 'PRESENT' }],
    ['LOAD', { THROUGHPUT_BUDGET: 'PRESENT' }],
  ];

  it.each(EARNED)('proposes %s when its signal is present', (type, signals) => {
    const verdict = earnsType(type as (typeof ANY_TEST_TYPES)[number], signals);
    expect(verdict.decision).toBe('PROPOSE');
  });

  it.each(EARNED)('does NOT propose %s when the signal is absent', (type, signals) => {
    const absent = Object.fromEntries(
      Object.keys(signals).map((key) => [key, 'ABSENT' as const]),
    ) as TypeSignals;
    expect(earnsType(type as (typeof ANY_TEST_TYPES)[number], absent).decision).toBe(
      'NOT_WARRANTED',
    );
  });

  it('proposes the money path from a card field the crawl actually read', () => {
    const verdict = earnsType('PAYMENTS', { PAYMENT_FIELD: 'PRESENT' });
    // UNMINTED rather than PROPOSE: PAYMENTS is not in TEST_TYPES, so an item
    // carrying it would be REJECTED by planItemSchema. The gap is nameable, not
    // a parse error somebody has to debug.
    expect(verdict.decision).toBe('UNMINTED');
    if (verdict.decision !== 'UNMINTED') throw new Error('unreachable');
    expect(verdict.remedy).toContain('TEST_TYPES');
    expect(verdict.remedy).toContain('schema.prisma');
  });

  it('does not propose the money path against an application with no card field', () => {
    expect(earnsType('PAYMENTS', { PAYMENT_FIELD: 'ABSENT' }).decision).toBe('NOT_WARRANTED');
  });

  it('delegates the five the crawl path already proposes, rather than duplicating them', () => {
    for (const type of DELEGATED_TO_CRAWL) {
      const all = Object.fromEntries(
        [...TYPE_PRECONDITIONS[type].all, ...TYPE_PRECONDITIONS[type].any].map((signal) => [
          signal,
          'PRESENT' as const,
        ]),
      ) as TypeSignals;
      const verdict = earnsType(type, all);
      expect(verdict.decision, `${type} should be DELEGATED`).toBe('DELEGATED');
    }
  });
});

// ─── The proposals are storable, which is the whole point ────────────────────

describe('a proposal is a plan item the validator accepts', () => {
  const everything = Object.fromEntries(
    TYPE_SIGNAL_LIST.map((signal) => [signal, 'PRESENT' as const]),
  ) as TypeSignals;

  it('emits only MINTED types, and every item parses as a PlanItem', () => {
    const result = proposeTypeCoverage({ seed: SEED, signals: everything });
    expect(result.proposals.length).toBeGreaterThan(0);
    for (const proposal of result.proposals) {
      expect(TEST_TYPES as readonly string[]).toContain(proposal.item.testType);
      // The integration proof: the item the funnel emits can actually be
      // STORED. `planItemSchema.testType` is `z.enum(TEST_TYPES)`, so this is
      // what would have rejected a PAYMENTS item.
      const parsed = planItemSchema.safeParse(proposal.item);
      expect(parsed.success, `${proposal.item.testType}: ${parsed.error?.message ?? ''}`).toBe(
        true,
      );
    }
  });

  it('keeps every UNMINTED type out of the items and in its own list, with the mint steps', () => {
    const result = proposeTypeCoverage({ seed: SEED, signals: everything });
    const proposedTypes = result.proposals.map((proposal) => proposal.item.testType);
    for (const entry of result.unminted) {
      expect(proposedTypes).not.toContain(entry.type);
      expect(entry.remedy).toContain('TEST_TYPES');
    }
    expect(result.unminted.map((entry) => entry.type).sort()).toEqual(
      [...PENDING_TEST_TYPES].sort(),
    );
  });

  it('returns a verdict for all thirty types, not only the ones it proposed', () => {
    const result = proposeTypeCoverage({ seed: SEED, signals: {} });
    expect(result.verdicts.length).toBe(ANY_TEST_TYPES.length);
    expect(result.proposals).toHaveLength(0);
  });

  it("carries the type's own knownUnasserted holes onto the item it proposes", () => {
    // MUTATION declares holes in packages/shared/src/test-type-decl.ts; the
    // approval screen must say what the test will NOT prove BEFORE the run.
    const result = proposeTypeCoverage({ seed: SEED, signals: everything });
    const withHoles = result.proposals.filter((proposal) =>
      proposal.item.assertions.some((line) => line.startsWith('NOT ASSERTED by this type yet:')),
    );
    expect(withHoles.length).toBeGreaterThan(0);
  });

  it('ranks a proposal by its own declared priority inside the kind tier', () => {
    const result = proposeTypeCoverage({ seed: SEED, signals: everything });
    const unit = result.proposals.find((proposal) => proposal.item.testType === 'UNIT_GEN');
    const perf = result.proposals.find((proposal) => proposal.item.testType === 'PERFORMANCE');
    expect(unit?.producerRank).toBeGreaterThan(perf?.producerRank ?? 99);
  });

  it('is byte-identical for the same signals and carries no clock', () => {
    const a = proposeTypeCoverage({ seed: SEED, signals: everything });
    const b = proposeTypeCoverage({ seed: 'a-completely-different-seed', signals: everything });
    // The ids are derived from the TYPE and not from the seed on purpose: a
    // seeded id would make every type new every round and inflate the
    // numerator for ever.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ─── What a crawl may and may not claim ──────────────────────────────────────

describe('signalsFromFlowMap claims only what a crawl can see', () => {
  it('reports nothing at all about the repository, the database or a device', () => {
    const signals = signalsFromFlowMap(flowMap([node()]));
    for (const unseeable of [
      'DATABASE_REACHABLE',
      'CLI_ENTRYPOINT',
      'UNIT_RUNNER',
      'TESTABLE_LOGIC',
      'PROJECT_TEST_COMMAND',
      'NATIVE_APP_BUILD',
      'DESKTOP_SHELL',
      'THROUGHPUT_BUDGET',
      'PERFORMANCE_BUDGET',
      'SERVICE_WORKER',
      'PUSH_SENDER',
      'MULTIPLE_LOCALES',
    ] as const) {
      expect(reading(signals, unseeable), `${unseeable} must stay NOT_PROBED`).toBe('NOT_PROBED');
    }
  });

  it('finds the card field a crawl really read', () => {
    const signals = signalsFromFlowMap(
      flowMap([node({ forms: [form([field({ semantic: 'card_cvc' })])] })]),
    );
    expect(reading(signals, 'PAYMENT_FIELD')).toBe('PRESENT');
  });

  it('calls a card field ABSENT only when it examined a form', () => {
    const withForm = signalsFromFlowMap(
      flowMap([node({ forms: [form([field({ semantic: 'email' })])] })]),
    );
    expect(reading(withForm, 'PAYMENT_FIELD')).toBe('ABSENT');

    // THE DEFECT THIS REFUSES: a crawl that reached no form at all has not
    // established that the application takes no payments. It has established
    // nothing about forms.
    const noForm = signalsFromFlowMap(flowMap([node()]));
    expect(reading(noForm, 'PAYMENT_FIELD')).toBe('NOT_PROBED');
    expect(reading(noForm, 'FILE_INPUT')).toBe('NOT_PROBED');
  });

  it('finds a file input, and a download from the affordance a crawl declined to follow', () => {
    const upload = signalsFromFlowMap(
      flowMap([node({ forms: [form([field({ inputType: 'file' })])] })]),
    );
    expect(reading(upload, 'FILE_INPUT')).toBe('PRESENT');

    const download = signalsFromFlowMap(
      flowMap([
        node({
          affordances: [
            {
              label: 'Download invoice',
              selector: { strategy: 'CSS', value: 'a', confidence: 1 },
              kind: 'link',
            },
          ],
        }),
      ]),
    );
    expect(reading(download, 'DOCUMENT_OUTPUT')).toBe('PRESENT');
  });

  it('reads an id in a URL from the NORMALISED route, which is the crawler’s own finding', () => {
    expect(reading(signalsFromFlowMap(flowMap([node({ route: '/orders/:id' })])), 'OWNED_RESOURCE_ID')).toBe(
      'PRESENT',
    );
    expect(reading(signalsFromFlowMap(flowMap([node({ route: '/about' })])), 'OWNED_RESOURCE_ID')).toBe(
      'ABSENT',
    );
  });

  it('tells an unaccounted externals list apart from an empty one', () => {
    // absent → this crawl predates the capture → NOT_PROBED, never "calls nothing"
    expect(
      reading(signalsFromFlowMap(flowMap([node()])), 'INTERCEPTABLE_DEPENDENCY'),
    ).toBe('NOT_PROBED');
    expect(
      reading(signalsFromFlowMap(flowMap([node()], { externals: [] })), 'INTERCEPTABLE_DEPENDENCY'),
    ).toBe('ABSENT');
  });

  it('drives the whole funnel from a crawl and proposes nothing it cannot justify', () => {
    const signals = signalsFromFlowMap(
      flowMap([node({ forms: [form([field({ semantic: 'credit_card' })])] })]),
    );
    const result = proposeTypeCoverage({ seed: SEED, signals });
    // A crawl alone cannot warrant MOBILE, CLI, DATABASE, UNIT_GEN or LOAD.
    for (const type of ['MOBILE', 'CLI', 'DATABASE', 'UNIT_GEN', 'LOAD'] as const) {
      expect(result.proposals.map((p) => p.item.testType)).not.toContain(type);
    }
    // And it DOES warrant the money path, which is the register's first flow.
    expect(result.unminted.map((entry) => entry.type)).toContain('PAYMENTS');
  });
});

// ─── The model prompt is built from the same table ───────────────────────────

describe("the model's offer is the funnel's finding, not a hard-coded five", () => {
  it('falls back to exactly the five the crawl owns when nothing was enumerated', () => {
    const { verdicts } = proposeTypeCoverage({ seed: SEED, signals: {} });
    const offer = summariseProposableTypes(verdicts);
    for (const type of DELEGATED_TO_CRAWL) expect(offer).toContain(type);
    for (const type of ['MOBILE', 'DATABASE', 'LOAD'] as const) {
      expect(offer).not.toContain(type);
    }
    expect(offer).toContain('Do NOT use any other type');
  });

  it('widens the offer to a type the enumeration proved, and says how many it withheld', () => {
    const { verdicts } = proposeTypeCoverage({
      seed: SEED,
      signals: { MULTIPLE_LOCALES: 'PRESENT', RENDERED_ROUTE: 'PRESENT' },
    });
    const offer = summariseProposableTypes(verdicts);
    expect(offer).toContain('LOCALIZATION');
    expect(offer).toMatch(/\d+ further type\(s\) were considered/);
  });

  it('does not offer a crawl type the enumeration RULED OUT, and counts it as withheld', () => {
    /*
     * THE DEFECT, measured. The offer was `[...DELEGATED_TO_CRAWL, ...earned]`
     * unconditionally, so on an application the enumeration fully examined and
     * found to have no API endpoint and no auth wall, the prompt listed `API`
     * and `SECURITY_SMOKE` in the offer line AND counted both inside "25
     * further type(s) ... withheld" seven lines below. The model was invited to
     * propose a test of a surface the funnel had ruled out — the review-queue
     * noise the table exists to prevent — and the stated count was wrong by two.
     *
     * The asymmetry is the fix: NOT_WARRANTED ("we looked, it is not there")
     * drops the type from the offer; NOT_PROBED ("nobody looked") does not,
     * because that is a hole in our enumeration and no basis for narrowing the
     * crawl. The test above pins the NOT_PROBED half.
     */
    const examined = Object.fromEntries(
      TYPE_SIGNAL_LIST.map((signal) => [signal, 'ABSENT' as const]),
    ) as TypeSignals;
    const { verdicts } = proposeTypeCoverage({
      seed: SEED,
      signals: { ...examined, RENDERED_ROUTE: 'PRESENT' },
    });
    const offer = summariseProposableTypes(verdicts);
    const offered = (offer.split('\n')[0] ?? '').replace('  testType    ', '').split(' | ');

    expect(offered).not.toContain('API');
    expect(offered).not.toContain('SECURITY_SMOKE');
    // A rendered route still earns the three that only need one.
    expect(offered).toContain('E2E');
    expect(offered).toContain('SMOKE');
    expect(offered).toContain('ACCESSIBILITY');

    // AND THE COUNT AGREES WITH THE LINE ABOVE IT. Nothing offered may also be
    // counted as withheld, whatever its verdict.
    const stated = Number(/(\d+) further type\(s\)/.exec(offer)?.[1] ?? '0');
    const withheldNames = verdicts
      .filter((v) => v.decision === 'NOT_WARRANTED' || v.decision === 'NOT_PROBED')
      .map((v) => v.type)
      .filter((t) => !offered.includes(t));
    expect(stated).toBe(withheldNames.length);
    for (const name of offered) expect(withheldNames).not.toContain(name);
  });

  it('never offers an UNMINTED type, which the validator would reject', () => {
    const everything = Object.fromEntries(
      TYPE_SIGNAL_LIST.map((signal) => [signal, 'PRESENT' as const]),
    ) as TypeSignals;
    const offer = summariseProposableTypes(
      proposeTypeCoverage({ seed: SEED, signals: everything }).verdicts,
    );
    for (const pending of PENDING_TEST_TYPES) {
      expect(offer.split('\n')[0] ?? '').not.toContain(pending);
    }
  });
});

// ─── The deterministic plan carries it ───────────────────────────────────────

describe('the deterministic plan reports the funnel, or says it did not look', () => {
  it('puts TYPE_COVERAGE in notEnumerated when no signals were supplied', () => {
    const plan = proposeScenarioPlan({ seed: SEED });
    expect(plan.notEnumerated).toContain('TYPE_COVERAGE');
    expect(plan.typeVerdicts).toHaveLength(0);
    expect(plan.typesUnminted).toHaveLength(0);
  });

  it('proposes the earned types and keeps TYPE_COVERAGE out of notEnumerated', () => {
    const plan = proposeScenarioPlan({
      seed: SEED,
      signals: { MULTIPLE_LOCALES: 'PRESENT', RENDERED_ROUTE: 'PRESENT', PAYMENT_FIELD: 'PRESENT' },
    });
    expect(plan.notEnumerated).not.toContain('TYPE_COVERAGE');
    expect(plan.byKind.TYPE_COVERAGE).toBeGreaterThan(0);
    expect(plan.items.map((item) => item.item.testType)).toContain('LOCALIZATION');
    expect(plan.typesUnminted.map((entry) => entry.type)).toContain('PAYMENTS');
    expect(plan.typeVerdicts).toHaveLength(ANY_TEST_TYPES.length);
  });

  it('is byte-identical for the same input', () => {
    const input = { seed: SEED, signals: { RENDERED_ROUTE: 'PRESENT' } } as const;
    expect(JSON.stringify(proposeScenarioPlan(input))).toBe(
      JSON.stringify(proposeScenarioPlan(input)),
    );
  });
});

// ─── The item never promises more than the type can prove ───────────────────

describe('a proposal cannot claim what the type declares it does not assert', () => {
  const everything = Object.fromEntries(
    TYPE_SIGNAL_LIST.map((signal) => [signal, 'PRESENT' as const]),
  ) as TypeSignals;

  it('carries EVERY declared hole, not merely some of them', () => {
    /*
     * THE INVARIANT THAT WOULD HAVE CAUGHT MY OWN DEFECT. The first draft of
     * TYPE_PRECONDITIONS asserted, for LOCALIZATION, all four things that type
     * DECLARES it cannot assert — RTL mirroring, truncation, a missing key and
     * the pseudo-localization round trip — because `localizationPlugin` only
     * re-runs the same spec under another locale. Four claims on an approval
     * screen that nothing would ever check: the "pass that means we did not
     * check" moved one step earlier, where it is harder to spot.
     *
     * Asserted as EVERY hole rather than "at least one", because a partial
     * carry is the same defect wearing a passing test.
     */
    const result = proposeTypeCoverage({ seed: SEED, signals: everything });
    for (const proposal of result.proposals) {
      const declared = declarationFor(proposal.item.testType)?.knownUnasserted ?? [];
      for (const hole of declared) {
        expect(
          proposal.item.assertions.some((line) => line.includes(hole.assertion)),
          `${proposal.item.testType} does not carry its declared hole: ${hole.assertion}`,
        ).toBe(true);
      }
    }
  });

  it('declares a hole for every type whose plugin is known not to assert a claim', () => {
    // The four this round corrected, pinned by NAME so a hole cannot quietly
    // leave the declaration while the plugin stays as it is.
    for (const type of ['LOCALIZATION', 'CROSS_BROWSER', 'MOBILE', 'VISUAL', 'INTEGRATION', 'UNIT_GEN'] as const) {
      expect(
        declarationFor(type)?.knownUnasserted.length ?? 0,
        `${type} claims it asserts everything`,
      ).toBeGreaterThan(0);
    }
  });

  it('keeps the HOLES and drops the CLAIMS when the cap really does bite', () => {
    /*
     * DRIVEN through an injected ceiling, because a planted mutant that made
     * this branch drop the holes instead of the claims SURVIVED the first
     * version of this file: no type declares anything like twenty assertions,
     * so the branch was unreachable from any input a test could build.
     *
     * The direction of the give is the behaviour under test. The entries at the
     * END of the combined list are the HOLES, so a plain `.slice(0, 20)` would
     * have made the one truncation that can ever happen the one that deletes
     * the honesty — a plan item that silently stops saying what the test will
     * not prove.
     */
    const result = proposeTypeCoverage({ seed: SEED, signals: everything, maxAssertions: 2 });
    const localization = result.proposals.find((p) => p.item.testType === 'LOCALIZATION');
    expect(localization).toBeDefined();
    const lines = localization?.item.assertions ?? [];
    expect(lines).toHaveLength(2);
    // One hole survives, and the last line DISCLOSES the loss as a count.
    expect(lines[0]).toContain('NOT ASSERTED by this type yet:');
    expect(lines[1]).toContain('CAP BIT:');
    expect(lines[1]).toMatch(/\d+ further assertion\(s\) and declared hole\(s\)/);
  });

  it('defaults the ceiling to the validator\'s own limit, so the two cannot drift', () => {
    expect(PLAN_ITEM_ASSERTION_LIMIT).toBe(20);
    const result = proposeTypeCoverage({ seed: SEED, signals: everything });
    for (const proposal of result.proposals) {
      expect(planItemSchema.safeParse(proposal.item).success).toBe(true);
    }
  });

  it('does not let the cap bite at all with the table as it stands', () => {
    // No type comes near twenty today; this pins the direction of the give so
    // the one truncation that can happen is not the one that deletes the
    // honesty. See the note in proposeTypeCoverage.
    const result = proposeTypeCoverage({ seed: SEED, signals: everything });
    for (const proposal of result.proposals) {
      expect(proposal.item.assertions.length).toBeLessThanOrEqual(20);
      expect(proposal.item.assertions.join('\n')).not.toContain('CAP BIT:');
    }
  });
});
