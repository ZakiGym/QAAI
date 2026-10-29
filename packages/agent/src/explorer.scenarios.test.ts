/**
 * THE DETERMINISTIC SCENARIO PRODUCER.
 *
 * Six scenario modules landed correct, tested and CALLED BY NOTHING. These
 * tests are the other half of connecting them: the barrel line makes them
 * public, the adapters here make them reached, and these assertions pin the
 * three things the register asked for — that the new kinds are emitted, that
 * they are RANKED against each other, and that work the suite already has is
 * REFUSED rather than minted twice.
 *
 * MODEL-FREE. There is no `LlmService` anywhere in this file, because the path
 * under test has no model in it.
 */

import { describe, expect, it } from 'vitest';
import {
  PROPOSAL_DUPLICATE_THRESHOLD,
  SCENARIO_KINDS,
  SCENARIO_KIND_LIST,
  SCENARIO_KIND_RISK,
  SUPPRESSION_REASON_LIST,
  behaviorOfPlanItem,
  proposeScenarioPlan,
  rankProposal,
  suppressKnownWork,
  summariseExistingSuite,
  summariseGapReport,
  summariseScenarioPlan,
  boundaryProposals,
  walkProposals,
} from './explorer.js';
import type { ScenarioProposal } from './explorer.js';
import { BOUNDARY_DESCRIPTORS, BOUNDARY_CLASS_LIST } from '@qaai/shared';
import { WALK_SHAPE_DESCRIPTORS } from './walks.js';
import type { Walk, WalkSelection, WalkShape } from './walks.js';

const walk = (id: string, shape: WalkShape, rank: number): Walk => ({
  id,
  shape,
  targetNodeId: `n_${id}`,
  steps: [
    { kind: 'GOTO', target: `n_${id}`, expectedNodeId: `n_${id}`, label: `open /${id}` },
    { kind: 'TRAVERSE', target: `e_${id}`, expectedNodeId: `n_${id}2`, label: 'click Next' },
    { kind: 'BACK', target: null, expectedNodeId: null, label: 'press back' },
  ],
  expectedStates: [
    {
      nodeId: `n_${id}`,
      route: `/${id}`,
      itemKey: `/${id}`,
      cellKey: `cell_${id}`,
      kind: null,
      why: 'classified by the fixture',
    },
  ],
  revisits: [{ route: `/${id}`, visits: 2, states: ['s1', 's2'] }],
  rank,
  rankBasis: ['shape points'],
  why: `A ${shape} over /${id}`,
  needs: WALK_SHAPE_DESCRIPTORS[shape].needs,
});

/*
 * NO `as unknown as` CAST. The first version of this fixture used one and the
 * compiler therefore did not notice that its shape names ('RE_ENTRY',
 * 'BACK') are not members of `WALK_SHAPES` at all — the suite failed at
 * run time inside the adapter instead. A cast in a fixture is an assertion that
 * the fixture matches the real type, and it is exactly the assertion worth
 * having the compiler check.
 */
const selection = (walks: Walk[]): WalkSelection => ({
  walks,
  notProduced: [],
  notProducedDiscarded: 0,
  caps: [],
  atLeastMoreWalks: 0,
  statesUnclassified: 0,
  walksWithUncapturedEdgeKinds: 0,
  rule: 'test',
  seed: 'seed-1',
});

const proposal = (over: Partial<ScenarioProposal> & { sourceId: string }): ScenarioProposal => ({
  kind: 'WALK',
  item: {
    id: over.sourceId,
    title: over.sourceId,
    rationale: 'because',
    feature: 'f',
    priority: 'IMPORTANT',
    testType: 'E2E',
    steps: ['open /a'],
    assertions: ['something is true'],
    journeyId: null,
    authProfileId: null,
  },
  principals: [],
  producerRank: 0,
  why: 'why',
  gapId: null,
  refusal: null,
  ...over,
});

describe('the scenario vocabulary', () => {
  it('derives its list from the presence record rather than hand-listing it', () => {
    expect([...SCENARIO_KIND_LIST].sort()).toEqual([...SCENARIO_KINDS].sort());
  });

  it('gives every kind a risk tier and an argument for it', () => {
    // A tenth kind cannot be generated without deciding both.
    for (const kind of SCENARIO_KIND_LIST) {
      expect(SCENARIO_KIND_RISK[kind].points).toBeGreaterThan(0);
      expect(SCENARIO_KIND_RISK[kind].why.length).toBeGreaterThan(40);
    }
  });

  it('declares every suppression reason it can produce', () => {
    expect(SUPPRESSION_REASON_LIST.length).toBe(6);
  });
});

describe('ranking puts what finds bugs at the top', () => {
  it('ranks a cross-tenant sweep above a walk, which was the whole complaint', () => {
    expect(rankProposal(proposal({ sourceId: 'a', kind: 'TENANCY' }))).toBeGreaterThan(
      rankProposal(proposal({ sourceId: 'b', kind: 'WALK' })),
    );
    expect(rankProposal(proposal({ sourceId: 'a', kind: 'RACE' }))).toBeGreaterThan(
      rankProposal(proposal({ sourceId: 'b', kind: 'BOUNDARY' })),
    );
  });

  it('never lets a producer rank jump a risk tier', () => {
    // The bump is bounded at 9 and the closest tiers are 10 apart after scaling.
    const bestWalk = rankProposal(proposal({ sourceId: 'a', kind: 'WALK', producerRank: 10_000 }));
    const worstBoundary = rankProposal(
      proposal({ sourceId: 'b', kind: 'BOUNDARY', producerRank: 0 }),
    );
    expect(worstBoundary).toBeGreaterThan(bestWalk);
  });

  it('orders kin against each other by the producer signal', () => {
    expect(rankProposal(proposal({ sourceId: 'a', kind: 'WALK', producerRank: 7 }))).toBeGreaterThan(
      rankProposal(proposal({ sourceId: 'b', kind: 'WALK', producerRank: 2 })),
    );
  });

  it('ignores a negative or non-finite producer rank rather than inverting the order', () => {
    expect(rankProposal(proposal({ sourceId: 'a', kind: 'WALK', producerRank: -5 }))).toBe(
      rankProposal(proposal({ sourceId: 'b', kind: 'WALK', producerRank: 0 })),
    );
    expect(
      rankProposal(proposal({ sourceId: 'a', kind: 'WALK', producerRank: Number.NaN })),
    ).toBe(rankProposal(proposal({ sourceId: 'b', kind: 'WALK', producerRank: 0 })));
  });
});

describe('the walk adapter names the nodes and edges its item is about', () => {
  const proposals = walkProposals(selection([walk('cart', 'RE_ENTRY', 5)]));

  it('pins the target node and every traversed edge onto the item', () => {
    // This is what makes `relevantContext` put the right page in the prompt
    // instead of guessing from wording.
    expect(proposals[0]!.item.targets?.nodeIds).toEqual(['n_cart']);
    expect(proposals[0]!.item.targets?.edgeIds).toEqual(['e_cart']);
  });

  it('asserts something about the RE-ENTRY, which is the walk’s whole claim', () => {
    expect(proposals[0]!.item.assertions.join(' ')).toContain('Re-entering');
  });
});

describe('refusing work that already exists', () => {
  it('refuses a proposal whose id an existing plan item already has', () => {
    const { kept, suppressed } = suppressKnownWork({
      proposals: [proposal({ sourceId: 's1' })],
      priorItems: [
        { id: 's1', title: 'anything', testType: 'E2E', steps: ['x'], assertions: ['y'] },
      ],
    });
    expect(kept).toEqual([]);
    expect(suppressed[0]!.reason).toBe('ALREADY_PROPOSED_SAME_ID');
  });

  it('refuses a near-duplicate of an existing plan item, prose against prose', () => {
    const { kept, suppressed } = suppressKnownWork({
      proposals: [
        proposal({
          sourceId: 's2',
          item: {
            id: 's2',
            title: 'Walk the cart to checkout',
            rationale: 'r',
            feature: 'f',
            priority: 'IMPORTANT',
            testType: 'E2E',
            steps: ['open /cart', 'click checkout'],
            assertions: ['the order total equals subtotal plus shipping'],
            journeyId: null,
            authProfileId: null,
          },
        }),
      ],
      priorItems: [
        {
          id: 'existing',
          title: 'Walk the cart to checkout',
          testType: 'E2E',
          steps: ['open /cart', 'click checkout'],
          assertions: ['the order total equals subtotal plus shipping'],
        },
      ],
    });
    expect(kept).toEqual([]);
    expect(suppressed[0]!.reason).toBe('ALREADY_PROPOSED_NEAR_DUPLICATE');
    expect(suppressed[0]!.detail).toContain('existing');
  });

  it('keeps an item of a DIFFERENT test type over the same thing', () => {
    // An API test and an E2E test over one journey are two tests of it, not one
    // test twice. Same rule `duplicateCandidates` applies in the worker.
    const { kept } = suppressKnownWork({
      proposals: [proposal({ sourceId: 's3' })],
      priorItems: [
        { id: 'other', title: 's3', testType: 'API', steps: ['open /a'], assertions: ['something is true'] },
      ],
    });
    expect(kept).toHaveLength(1);
  });

  it('dedups ACROSS producers and keeps the higher-ranked one', () => {
    const high = proposal({ sourceId: 'race-x', kind: 'RACE' });
    const low = { ...proposal({ sourceId: 'walk-x', kind: 'WALK' }), item: high.item };
    // The pipeline sorts before suppressing, so RACE arrives first.
    const { kept, suppressed } = suppressKnownWork({ proposals: [high, low] });
    expect(kept.map((k) => k.kind)).toEqual(['RACE']);
    expect(suppressed[0]!.reason).toBe('DUPLICATE_ACROSS_PRODUCERS');
  });

  it('carries a producer refusal into `suppressed` rather than running it', () => {
    const { kept, suppressed } = suppressKnownWork({
      proposals: [proposal({ sourceId: 's4', refusal: 'could not prove the target disposable' })],
    });
    expect(kept).toEqual([]);
    expect(suppressed[0]!.reason).toBe('REFUSED_BY_PRODUCER');
    expect(suppressed[0]!.detail).toContain('disposable');
  });

  it('refuses a WALK whose routes the suite already covers', () => {
    const { kept, suppressed } = suppressKnownWork({
      proposals: [
        proposal({
          sourceId: 'w1',
          kind: 'WALK',
          item: {
            id: 'w1',
            title: 'walk',
            rationale: 'r',
            feature: 'f',
            priority: 'IMPORTANT',
            testType: 'E2E',
            steps: ['open /cart'],
            assertions: ['it is fine'],
            journeyId: null,
            authProfileId: null,
          },
        }),
      ],
      existingTests: [
        {
          id: 't1',
          name: 'cart',
          filePath: 'tests/cart.spec.ts',
          type: 'E2E',
          priority: 'IMPORTANT',
          feature: null,
          tags: [],
          code: "await page.goto('/cart'); await expect(page.getByText('Cart')).toBeVisible();",
          spec: null,
          flakeRate: 0,
          quarantined: false,
          consecutiveFailures: 0,
        },
      ],
    });
    expect(kept).toEqual([]);
    expect(suppressed[0]!.reason).toBe('SUITE_ALREADY_COVERS_ROUTES');
  });

  it('does NOT let route coverage refuse a RACE over the same route', () => {
    /*
     * THE JUDGEMENT THIS WHOLE SPLIT EXISTS FOR. A race on /cart is not made
     * redundant by an E2E walk of /cart, and refusing it on route evidence
     * would silently delete the only check that could ever find a double
     * charge. Prose-vs-code evidence may not refuse anything but a WALK.
     */
    const { kept } = suppressKnownWork({
      proposals: [
        proposal({
          sourceId: 'r1',
          kind: 'RACE',
          item: {
            id: 'r1',
            title: 'double submit on /cart',
            rationale: 'r',
            feature: 'f',
            priority: 'CRITICAL_PATH',
            testType: 'E2E',
            steps: ['open /cart'],
            assertions: ['exactly one order exists'],
            journeyId: null,
            authProfileId: null,
          },
        }),
      ],
      existingTests: [
        {
          id: 't1',
          name: 'cart',
          filePath: 'tests/cart.spec.ts',
          type: 'E2E',
          priority: 'IMPORTANT',
          feature: null,
          tags: [],
          code: "await page.goto('/cart');",
          spec: null,
          flakeRate: 0,
          quarantined: false,
          consecutiveFailures: 0,
        },
      ],
    });
    expect(kept).toHaveLength(1);
  });

  it('never treats a test it could not read fully as evidence of coverage', () => {
    const { kept } = suppressKnownWork({
      proposals: [
        proposal({
          sourceId: 'w2',
          kind: 'WALK',
          item: {
            id: 'w2',
            title: 'walk',
            rationale: 'r',
            feature: 'f',
            priority: 'IMPORTANT',
            testType: 'E2E',
            steps: ['open /cart'],
            assertions: ['fine'],
            journeyId: null,
            authProfileId: null,
          },
        }),
      ],
      existingTests: [
        {
          id: 't_big',
          name: 'huge',
          filePath: 'tests/huge.spec.ts',
          type: 'E2E',
          priority: 'IMPORTANT',
          feature: null,
          tags: [],
          // Oversized source makes `extractBehavior` report `incomplete`, and a
          // partial reading can only make two tests look MORE alike.
          code: `await page.goto('/cart');${'/* x */'.repeat(100_000)}`,
          spec: null,
          flakeRate: 0,
          quarantined: false,
          consecutiveFailures: 0,
        },
      ],
    });
    expect(kept).toHaveLength(1);
  });

  it('uses the threshold it declares', () => {
    expect(PROPOSAL_DUPLICATE_THRESHOLD).toBeGreaterThan(0.5);
    expect(PROPOSAL_DUPLICATE_THRESHOLD).toBeLessThanOrEqual(1);
  });
});

describe('the plan-item projection', () => {
  it('normalises routes the same way suite-health does, so the facets join', () => {
    const behavior = behaviorOfPlanItem({
      id: 'x',
      title: 'open /orders/42 and then /orders/99',
      testType: 'E2E',
      steps: [],
      assertions: [],
    });
    // Both concrete ids collapse onto one parameterised route.
    expect(new Set(behavior.routes).size).toBe(1);
  });

  it('is not marked incomplete, because a plan item is all prose', () => {
    expect(
      behaviorOfPlanItem({ id: 'x', title: 't', testType: 'E2E', steps: [], assertions: [] })
        .incomplete,
    ).toBe(false);
  });
});

describe('the plan as a whole', () => {
  const input = {
    seed: 'seed-1',
    walks: selection([walk('cart', 'RE_ENTRY', 5), walk('orders', 'BACK', 3)]),
  };

  it('is byte-identical for one input', () => {
    expect(JSON.stringify(proposeScenarioPlan(input))).toBe(
      JSON.stringify(proposeScenarioPlan(input)),
    );
  });

  it('accounts for everything it considered', () => {
    const plan = proposeScenarioPlan(input);
    expect(plan.considered).toBe(2);
    expect(plan.items.length + plan.suppressed.length).toBe(plan.considered);
  });

  it('DISCLOSES the cap as a count AND a reason, and never one without the other', () => {
    const capped = proposeScenarioPlan({ ...input, maxItems: 1 });
    expect(capped.omittedByCap).toBe(1);
    expect(capped.capReason).toContain('at least 1 more');
    expect(capped.suppressed.some((s) => s.reason === 'BUDGET')).toBe(true);

    const uncapped = proposeScenarioPlan(input);
    expect(uncapped.omittedByCap).toBe(0);
    expect(uncapped.capReason).toBeNull();
  });

  it('distinguishes a kind NOBODY LOOKED FOR from one that found nothing', () => {
    /*
     * The honesty rule that matters most here. "0 race tests" over an
     * application nobody looked for races in reads as a clean bill of health.
     */
    const plan = proposeScenarioPlan(input);
    expect(plan.notEnumerated).toContain('RACE');
    expect(plan.notEnumerated).toContain('TENANCY');
    expect(plan.byKind.RACE).toBe(0);

    const looked = proposeScenarioPlan({
      ...input,
      races: { scenarios: [], refused: [], caps: [], rule: 'r', seed: 's' },
    });
    expect(looked.notEnumerated).not.toContain('RACE');
    expect(looked.byKind.RACE).toBe(0);
  });

  it('echoes the seed, so a plan can be reproduced', () => {
    expect(proposeScenarioPlan(input).seed).toBe('seed-1');
  });

  it('ranks the plan highest-risk first', () => {
    const plan = proposeScenarioPlan(input);
    const ranks = plan.items.map((item) => rankProposal(item));
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
  });
});

describe('what reaches the model prompt', () => {
  it('says an empty suite is empty rather than saying nothing', () => {
    expect(summariseExistingSuite([])).toContain('none');
  });

  it('refuses to let an empty gap list read as a covered application', () => {
    expect(summariseGapReport([])).toContain('do not read an empty list');
  });

  it('tells the model NOT to re-propose what the deterministic plan already has', () => {
    const plan = proposeScenarioPlan({
      seed: 's',
      walks: selection([walk('cart', 'RE_ENTRY', 5)]),
    });
    const text = summariseScenarioPlan(plan);
    expect(text).toContain('Do NOT propose any of these again');
    expect(text).toContain('[WALK]');
  });

  it('names the unenumerated kinds as uncovered rather than clean', () => {
    const plan = proposeScenarioPlan({ seed: 's', walks: selection([walk('a', 'BACK', 1)]) });
    expect(summariseScenarioPlan(plan)).toContain('NOT ENUMERATED AT ALL');
  });

  it('calls out a gap behind a wall with no profile, in its own words', () => {
    const text = summariseGapReport([
      { id: 'g1', kind: 'UNREACHED_AUTH_ROUTE', route: '/admin', feature: null, requiresAuth: true, authProfileName: null },
    ]);
    expect(text).toContain('BEHIND AUTH AND NO PROFILE FITS');
    expect(text).toContain('would run as nobody and pass');
  });

  /*
   * The profile NAME moved out of the crawl block and into a span of its own
   * under `CUSTOMER_CONFIGURATION`, because a cockpit field is not crawl
   * output and the crawl header was only approximately true of it. So the
   * assertion is the reference AND the referent, which is what a model needs
   * to resolve "#1" at all — asserting only that the name appears somewhere
   * would pass on a report whose numbering had come apart.
   */
  it('names a bound gap by reference, resolves it, and carries no credential', () => {
    const text = summariseGapReport([
      { id: 'g2', kind: 'UNREACHED_AUTH_ROUTE', route: '/admin', feature: null, requiresAuth: true, authProfileName: 'Admin' },
    ]);
    expect(text).toContain('run as profile #1');
    expect(text).toContain('#1 — "Admin"');
    expect(text).not.toMatch(/password|secret|token|cookie/i);
  });

  /*
   * ONE NAME, ONCE, however many gaps run as it. The numbering is ours and the
   * deduplication is what keeps a hundred gaps from quoting the same two
   * cockpit strings a hundred times into a prompt with a character budget.
   */
  it('quotes a repeated profile name once and keeps the two numbers apart', () => {
    const gap = (id: string, name: string) => ({
      id,
      kind: 'UNREACHED_AUTH_ROUTE',
      route: `/${id}`,
      feature: null,
      requiresAuth: true,
      authProfileName: name,
    });
    const text = summariseGapReport([gap('g1', 'Admin'), gap('g2', 'Shopper'), gap('g3', 'Admin')]);
    expect(text).toContain('/g1 — run as profile #1');
    expect(text).toContain('/g2 — run as profile #2');
    expect(text).toContain('/g3 — run as profile #1');
    expect(text.match(/"Admin"/g)).toHaveLength(1);
  });

  /*
   * AND NO SECOND BLOCK WHEN NOTHING NAMES A PROFILE. A span whose header
   * announces customer configuration and holds none teaches the model to look
   * for a convention that is not there.
   */
  it('emits no configuration block when no shown gap names a profile', () => {
    const text = summariseGapReport([
      { id: 'g1', kind: 'UNREACHED_ROUTE', route: '/pricing', feature: null },
    ]);
    expect(text).not.toContain('TYPED BY A CUSTOMER');
  });
});

/*
 * ── THE BOUNDARY ADAPTER CARRIES THE CLASS'S DECLARED RISK ──────────────────
 *
 * `BOUNDARY_DESCRIPTORS` decides a `risk` for every one of the 27 classes,
 * beside the constraint that defines the class and the sentence saying why it
 * is worth a test. This adapter stamped `IMPORTANT` on all 27 and read none of
 * it, so EMPTY and WHITESPACE_ONLY — declared HIGH, and the two that actually
 * catch a naive `!value` check — ranked level with the weakest class in the
 * set. A risk decided in one file and discarded in the next is worse than no
 * risk field at all: the approval screen shows a priority that looks considered
 * and is not.
 *
 * There were no tests for this adapter. These are them.
 */
describe('the boundary adapter carries the class risk', () => {
  const caseFor = (klass: string): Parameters<typeof boundaryProposals>[0][number] => ({
    id: `c_${klass}`,
    field: 'email',
    klass,
    expectation: 'rejected',
    expected: `the form rejects a ${klass} email`,
    formName: 'Sign up',
  });

  it('gives a HIGH-risk class a higher priority than a LOW-risk one', () => {
    const high = BOUNDARY_CLASS_LIST.find((k) => BOUNDARY_DESCRIPTORS[k].risk === 'HIGH');
    const low = BOUNDARY_CLASS_LIST.find((k) => BOUNDARY_DESCRIPTORS[k].risk === 'LOW');
    expect(high).toBeDefined();
    expect(low).toBeDefined();
    const [a, b] = boundaryProposals([caseFor(high!), caseFor(low!)]);
    expect(a?.item.priority).toBe('CRITICAL_PATH');
    expect(b?.item.priority).toBe('NICE_TO_HAVE');
    expect(a?.item.priority).not.toBe(b?.item.priority);
  });

  /*
   * The assertion that would have caught the flattening: if every class maps to
   * one priority, this is 1 and the adapter is discarding the risk field. It
   * does NOT pin a particular number of tiers, so adding a class is not a
   * failure — only collapsing them is.
   */
  it('does not flatten all 27 classes onto one priority', () => {
    const proposals = boundaryProposals(BOUNDARY_CLASS_LIST.map(caseFor));
    expect(proposals).toHaveLength(BOUNDARY_CLASS_LIST.length);
    expect(new Set(proposals.map((p) => p.item.priority)).size).toBeGreaterThan(1);
  });

  it('maps every declared risk to a priority, so no class lands on the fallback', () => {
    const proposals = boundaryProposals(BOUNDARY_CLASS_LIST.map(caseFor));
    for (const [i, klass] of BOUNDARY_CLASS_LIST.entries()) {
      const risk = BOUNDARY_DESCRIPTORS[klass].risk;
      const expected =
        risk === 'CRITICAL' || risk === 'HIGH'
          ? 'CRITICAL_PATH'
          : risk === 'MEDIUM'
            ? 'IMPORTANT'
            : 'NICE_TO_HAVE';
      expect(proposals[i]?.item.priority, `${klass} is declared ${risk}`).toBe(expected);
    }
  });

  /*
   * `klass` arrives as a plain string because ScenarioPlanInput takes the
   * expansion structurally, so an unrecognised class is REACHABLE. It must get
   * the adapter's declared default rather than a guessed middle tier or an
   * `undefined` that renders as a blank priority on the approval screen.
   */
  it('falls back to the adapter default for a class it does not recognise', () => {
    const [only] = boundaryProposals([caseFor('NOT_A_BOUNDARY_CLASS')]);
    expect(only?.item.priority).toBe('IMPORTANT');
  });
});
