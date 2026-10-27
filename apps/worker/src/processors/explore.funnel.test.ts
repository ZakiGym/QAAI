/**
 * THE SEAM: does the no-model crawl plan actually CARRY the type funnel?
 *
 * Everything else about the funnel is asserted in packages/agent — the
 * precondition table, the three-valued signal, the resolution rule. None of it
 * is worth anything if no processor calls it, and `proposeScenarioPlan` is the
 * cautionary tale: a correct, tested deterministic producer with NO PRODUCTION
 * CALLER at all, which `check:wiring` cannot see because the module it lives in
 * is imported for a different function.
 *
 * So these tests are about this file's call site and nothing else: that
 * `planFromCrawl` proposes the earned types, that it REFUSES the ones the
 * application did not earn, that an earned-but-unstorable type is named with
 * its remedy instead of being emitted into a validator that would reject it,
 * and that the summary's count matches the list under it.
 *
 * MODEL-FREE. There is no LLM, no browser, no network and no database here: the
 * function is pure and takes the FlowMap.
 */

import { describe, expect, it } from 'vitest';
import { planItemSchema, testPlanSchema } from '@qaai/shared';
import type { FlowMap, FlowNode, FormField, FormModel } from '@qaai/shared';
import { planFromCrawl } from './explore.js';

const REASON = 'no key on this deployment';

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
  name: 'Checkout',
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
  projectId: 'proj_1',
  environmentId: 'env_1',
  version: 7,
  baseUrl: 'https://app.test',
  nodes,
  edges: [],
  journeys: [],
  features: [],
  exploredAt: '2026-01-01T00:00:00.000Z',
  truncatedReason: null,
  ...over,
});

describe('the no-model plan reaches the type funnel', () => {
  it('proposes a type the crawl earned, which it could not do before', () => {
    /*
     * A download affordance earns DOCUMENT (unminted) and an id in a route
     * earns nothing new; the storable one here is driven by the externals list,
     * so this case uses the locale-free signals a crawl really has. What
     * matters is that SOME type item appears that is not one of the five the
     * gap path produces.
     */
    const plan = planFromCrawl(
      flowMap([node({ route: '/orders/:id', forms: [form([field({ semantic: 'email' })])] })], {
        externals: [],
      }),
      REASON,
      [],
    );
    expect(testPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('names an EARNED but UNSTORABLE type with its mint steps, and emits no item for it', () => {
    /*
     * THE WHOLE POINT OF THE UNMINTED PATH. `planItemSchema.testType` is
     * `z.enum(TEST_TYPES)`, so a PAYMENTS item would be REJECTED by the
     * validator — turning a nameable gap into a parse error somebody has to
     * debug. It belongs in `skipped`, which is the field the approval screen
     * renders as "deliberately not proposed".
     */
    const plan = planFromCrawl(
      flowMap([node({ forms: [form([field({ semantic: 'credit_card' })])] })]),
      REASON,
      [],
    );
    expect(plan.items.map((item) => item.testType)).not.toContain('PAYMENTS');

    const payments = plan.skipped.find((entry) => entry.what === 'PAYMENTS tests — earned, not yet storable');
    expect(payments).toBeDefined();
    expect(payments?.why).toContain('EARNS');
    expect(payments?.why).toContain('TEST_TYPES');
    expect(payments?.why).toContain('schema.prisma');
  });

  it('does not name PAYMENTS at all when the crawl examined forms and found no card field', () => {
    const plan = planFromCrawl(
      flowMap([node({ forms: [form([field({ semantic: 'email' })])] })]),
      REASON,
      [],
    );
    // Named under the NOT-APPLICABLE tag, which is a FINISHED answer, and NOT
    // under the earned tag. The tags are the contract the plan screen groups on.
    expect(plan.skipped.map((entry) => entry.what)).toContain('PAYMENTS tests — not applicable');
    expect(plan.skipped.map((entry) => entry.what)).not.toContain(
      'PAYMENTS tests — earned, not yet storable',
    );
    const payments = plan.skipped.find((entry) => entry.what === 'PAYMENTS tests — not applicable');
    expect(payments?.why).toContain('looked');
    expect(payments?.why).not.toContain('EARNS');
  });

  it('tells "we looked and it is not there" from "nobody looked" in the skipped list', () => {
    const plan = planFromCrawl(flowMap([node()]), REASON, []);
    const database = plan.skipped.find((entry) => entry.what === 'DATABASE tests — not enumerated');
    expect(database).toBeDefined();
    // A crawl cannot see a database. This MUST read as our hole, not theirs.
    expect(database?.why).toContain('hole in the enumeration');
    expect(database?.why).toContain('NOT a fact about the application');
  });

  it('gives every skipped entry a non-empty reason', () => {
    const plan = planFromCrawl(
      flowMap([node({ forms: [form([field({ semantic: 'card_cvc' })])] })], { externals: [] }),
      REASON,
      [],
    );
    for (const entry of plan.skipped) {
      expect(entry.why, entry.what).not.toBe('');
      expect(entry.why.length, entry.what).toBeGreaterThan(10);
    }
  });

  it('every item it emits is a plan item the validator accepts', () => {
    const plan = planFromCrawl(
      flowMap([node({ route: '/orders/:id', behindAuth: true, forms: [form([field()])] })], {
        externals: [],
      }),
      REASON,
      [],
    );
    for (const item of plan.items) {
      const parsed = planItemSchema.safeParse(item);
      expect(parsed.success, `${item.testType}: ${parsed.error?.message ?? ''}`).toBe(true);
    }
  });

  it('counts in the summary what the list below it actually holds', () => {
    /*
     * The summary used to say `chosen.length`, which was the gap count and is
     * no longer the item count. A headline number that disagrees with the list
     * under it is the cheapest kind of lie to ship and the hardest to notice.
     */
    const plan = planFromCrawl(
      flowMap([node({ forms: [form([field({ semantic: 'credit_card' })])] })]),
      REASON,
      [],
    );
    expect(plan.summary.startsWith(`${plan.items.length} test`)).toBe(true);
  });

  it('is byte-identical for the same map, and reads no clock', () => {
    const map = flowMap([node({ forms: [form([field({ semantic: 'card_expiry' })])] })], {
      externals: [],
    });
    expect(JSON.stringify(planFromCrawl(map, REASON, []))).toBe(
      JSON.stringify(planFromCrawl(map, REASON, [])),
    );
  });

  it('proposes nothing it cannot justify from a bare crawl', () => {
    const plan = planFromCrawl(flowMap([node()]), REASON, []);
    for (const type of ['MOBILE', 'CLI', 'DATABASE', 'UNIT_GEN', 'LOAD', 'MUTATION'] as const) {
      expect(plan.items.map((item) => item.testType)).not.toContain(type);
    }
  });
});

describe('the signals a crawl cannot see arrive through the override', () => {
  /*
   * ── THE MEASUREMENT THAT PUT THESE TESTS HERE ──────────────────────────────
   *
   * Two planted mutants SURVIVED the first version of this file: emptying
   * `typeItems`, and counting gaps instead of items in the summary. Both
   * survived for the same reason, and it is a FINDING rather than a weak test:
   * from crawl signals alone the funnel earns NO storable type, because every
   * minted type it can propose needs a signal a browser cannot observe. So
   * `typeItems` was always empty and both mutations were behaviourally inert.
   *
   * The fix was not a stronger assertion, it was the missing seam: the override
   * through which an environment or source-analysis reading reaches the funnel.
   * These tests drive the item path through it.
   */
  it('proposes a MINTED, storable type once the environment reading is supplied', () => {
    const plan = planFromCrawl(flowMap([node()]), REASON, [], [], {
      MULTIPLE_LOCALES: 'PRESENT',
    });
    expect(plan.items.map((item) => item.testType)).toContain('LOCALIZATION');
    expect(planItemSchema.safeParse(plan.items.find((i) => i.testType === 'LOCALIZATION')).success).toBe(
      true,
    );
  });

  it('counts those items in the summary, so the headline matches the list', () => {
    const plan = planFromCrawl(flowMap([node()]), REASON, [], [], {
      MULTIPLE_LOCALES: 'PRESENT',
      DATABASE_REACHABLE: 'PRESENT',
    });
    expect(plan.summary.startsWith(`${plan.items.length} test`)).toBe(true);
    expect(plan.summary).toContain('cover');
    expect(plan.summary).toContain('LOCALIZATION');
  });

  it("lets the caller's reading win over the crawl's, because it probed and the browser did not", () => {
    // The crawl examined a form with no card field and reported PAYMENT_FIELD
    // ABSENT. A caller that knows better overrides it, and the type is earned.
    const map = flowMap([node({ forms: [form([field({ semantic: 'email' })])] })]);
    expect(
      planFromCrawl(map, REASON, []).skipped.find(
        (e) => e.what === 'PAYMENTS tests — not applicable',
      )?.why,
    ).toContain('looked');
    expect(
      planFromCrawl(map, REASON, [], [], { PAYMENT_FIELD: 'PRESENT' }).skipped.find(
        (e) => e.what === 'PAYMENTS tests — earned, not yet storable',
      )?.why,
    ).toContain('EARNS');
  });

  it('leaves an unsupplied signal NOT_PROBED rather than ABSENT', () => {
    const plan = planFromCrawl(flowMap([node()]), REASON, [], [], {
      MULTIPLE_LOCALES: 'PRESENT',
    });
    // CLI was not supplied and a crawl cannot see one: our hole, not theirs.
    expect(plan.skipped.find((entry) => entry.what === 'CLI tests — not enumerated')?.why).toContain(
      'hole in the enumeration',
    );
  });

  it('emits NO storable item from crawl signals alone, which is the honest floor', () => {
    /*
     * Pinned as a FACT rather than left implicit. It is the limitation the
     * mutants exposed, and if a later change makes a crawl-only run start
     * proposing items this test goes red and somebody has to say which signal
     * a browser can now see.
     */
    const plan = planFromCrawl(
      flowMap([node({ route: '/orders/:id', forms: [form([field({ semantic: 'credit_card' })])] })], {
        externals: [],
      }),
      REASON,
      [],
    );
    const fromFunnel = plan.items.filter((item) => item.id.startsWith('type-'));
    expect(fromFunnel).toHaveLength(0);
    // And the disclosures are NOT empty — the run said plenty, just not items.
    expect(plan.skipped.length).toBeGreaterThan(10);
  });
});
