/**
 * JOURNEY-GROUNDED LOCATOR RETRIEVAL.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * Context was picked by SUBSTRING OVERLAP over the item's title, steps and
 * assertions, keeping the top six nodes by shared >3-character words. It
 * ignored `journeyId`, which the Explorer has always populated, and it ignored
 * edges entirely. The consequence was not a slightly worse prompt: THE PAGE THE
 * ITEM IS ABOUT COULD BE ABSENT FROM IT. An item titled "Check out with two
 * items in the cart" shares no long word with a node routed `/order/confirm`
 * titled "Thanks!", so the only page the assertion is about scored zero, was
 * dropped, and the model invented a locator for it — then flagged the
 * invention, which read as the model being careful rather than as retrieval
 * being blind.
 */

import { describe, expect, it } from 'vitest';
import { contextReviewFlags, relevantContext } from './generator.js';
import type { FlowMap, PlanItem } from '@qaai/shared';

const sel = (value: string) => ({
  strategy: 'ROLE' as const,
  value: 'button',
  name: value,
  confidence: 0.9,
});

const node = (id: string, route: string, title: string) => ({
  id,
  route,
  title,
  stateKey: route,
  behindAuth: false,
  forms: [],
  affordances: [{ label: `${title} button`, selector: sel(title), kind: 'BUTTON' as const }],
  requiresRoles: [],
});

const flowMap = {
  version: 1,
  baseUrl: 'https://shop.example.com',
  nodes: [
    node('n_cart', '/cart', 'Your basket'),
    node('n_pay', '/pay', 'Payment'),
    /*
     * The node whose words share NOTHING with the item below — and getting this
     * fixture right mattered. My first version routed it `/order/confirm`, and
     * substring overlap FOUND it, because the item's assertion says "The order
     * total…" and `hay.includes('order')` is true of that route. The fixture
     * has to be genuinely disjoint to demonstrate the defect at all, and a real
     * confirmation page routed `/receipt` titled "All done" is exactly the
     * shape that loses: nothing a PM writes about a checkout mentions either
     * word.
     */
    node('n_thanks', '/receipt', 'All done'),
    node('n_blog', '/blog', 'Checkout tips and checkout advice'),
    node('n_a', '/a', 'A'),
    node('n_b', '/b', 'B'),
    node('n_c', '/c', 'C'),
    node('n_d', '/d', 'D'),
  ],
  edges: [
    { id: 'e_1', from: 'n_cart', to: 'n_pay', action: 'click "Checkout"', selector: sel('Checkout') },
    { id: 'e_2', from: 'n_pay', to: 'n_thanks', action: 'submit payment form', selector: sel('Pay now'), formId: 'f_pay' },
  ],
  journeys: [
    {
      id: 'j_checkout',
      name: 'Checkout',
      description: 'basket to confirmation',
      edgeIds: ['e_1', 'e_2'],
      priority: 'CRITICAL_PATH' as const,
      roles: [],
    },
  ],
  features: [],
} as unknown as FlowMap;

const item = (over: Partial<PlanItem> = {}): PlanItem => ({
  id: 'pi_1',
  title: 'Check out with two items in the cart',
  rationale: 'revenue',
  feature: 'Checkout',
  priority: 'CRITICAL_PATH',
  testType: 'E2E',
  steps: ['Add two items', 'Complete the purchase'],
  assertions: ['The order total equals subtotal plus shipping plus tax'],
  journeyId: null,
  authProfileId: null,
  ...over,
});

describe('tier 3 alone: the defect, pinned', () => {
  const selection = relevantContext(flowMap, item());

  it('MISSES the confirmation page when nothing grounds the item', () => {
    /*
     * The baseline this whole change exists to beat. If this ever starts
     * including `n_thanks`, substring overlap got better and these tests should
     * be re-read — but it should never REGRESS to this being the only tier.
     */
    expect(selection.grounding).toBe('NONE');
    expect(selection.nodeIds).not.toContain('n_thanks');
  });

  it('describes no transitions at all, because it reads no edges', () => {
    expect(selection.edgeIds).toEqual([]);
    expect(selection.text).not.toContain('TRANSITIONS');
  });
});

describe('tier 2: journey grounding, which needed no schema change', () => {
  const selection = relevantContext(flowMap, item({ journeyId: 'j_checkout' }));

  it('PINS every state the journey traverses, in traversal order', () => {
    expect(selection.grounding).toBe('JOURNEY');
    expect(selection.nodeIds.slice(0, 3)).toEqual(['n_cart', 'n_pay', 'n_thanks']);
  });

  it('puts the page the item is ABOUT into the prompt', () => {
    // `/receipt` titled "All done" — zero word overlap with the item.
    expect(selection.text).toContain('/receipt');
    expect(selection.nodeIds).toContain('n_thanks');
  });

  it('marks the pinned states so the model knows which pages matter', () => {
    expect(selection.text).toContain('*THIS ITEM IS ABOUT THIS STATE*');
  });

  it('describes the TRANSITIONS, which were absent from this prompt entirely', () => {
    expect(selection.edgeIds).toEqual(['e_1', 'e_2']);
    expect(selection.text).toContain('TRANSITIONS');
    expect(selection.text).toContain('/cart → /pay');
    expect(selection.text).toContain('click "Checkout"');
    // The edge's own locator, which the crawler proved by traversing it.
    expect(selection.text).toContain("getByRole('button', { name: \"Checkout\" })");
    // And the form that has to be filled first, which a step needs to know.
    expect(selection.text).toContain('fill form "f_pay"');
  });

  it('still fills the remaining budget by word overlap', () => {
    // Tier 2 and tier 3 compose; grounding does not switch tier 3 off.
    expect(selection.nodeIds).toContain('n_blog');
  });

  it('owes no review flag when grounding worked', () => {
    expect(contextReviewFlags(selection)).toEqual([]);
  });
});

describe('tier 1: explicit targets win and are never evicted', () => {
  it('pins the nodes the producer named, in that order', () => {
    const selection = relevantContext(
      flowMap,
      { ...item(), targets: { nodeIds: ['n_thanks', 'n_pay'] } },
    );
    expect(selection.grounding).toBe('EXPLICIT');
    expect(selection.nodeIds.slice(0, 2)).toEqual(['n_thanks', 'n_pay']);
  });

  it('pins BOTH endpoints of a named edge, so a step can be written for it', () => {
    const selection = relevantContext(flowMap, { ...item(), targets: { edgeIds: ['e_2'] } });
    expect(selection.nodeIds).toContain('n_pay');
    expect(selection.nodeIds).toContain('n_thanks');
    expect(selection.edgeIds).toEqual(['e_2']);
  });

  it('cannot be evicted by the node budget', () => {
    /*
     * THE ASSERTION THAT MATTERS MOST. A cap that silently drops the page the
     * item names would re-create the exact bug this function removes, so the
     * pinned set is allowed to exceed the budget and SAYS that it did.
     */
    const all = flowMap.nodes.map((n) => n.id);
    const selection = relevantContext(flowMap, { ...item(), targets: { nodeIds: all } });
    expect(selection.nodeIds).toEqual(all);
    expect(selection.pinnedOverflow).toBe(true);
  });

  it('takes precedence over the journey, because the producer knows more', () => {
    const selection = relevantContext(flowMap, {
      ...item({ journeyId: 'j_checkout' }),
      targets: { nodeIds: ['n_blog'] },
    });
    expect(selection.grounding).toBe('EXPLICIT');
    expect(selection.nodeIds[0]).toBe('n_blog');
    // And the journey still contributes — explicit is a floor, not a filter.
    expect(selection.nodeIds).toContain('n_thanks');
  });
});

describe('every drift and every cap is reported as a count AND a reason', () => {
  it('names a journeyId this flow map does not have', () => {
    const selection = relevantContext(flowMap, item({ journeyId: 'j_gone' }));
    expect(selection.unknownJourneyId).toBe('j_gone');
    expect(selection.grounding).toBe('NONE');
    const flags = contextReviewFlags(selection);
    expect(flags.join(' ')).toContain('older than the crawl');
  });

  it('names target node ids the flow map does not contain', () => {
    const selection = relevantContext(flowMap, { ...item(), targets: { nodeIds: ['n_ghost'] } });
    expect(selection.missingNodeIds).toEqual(['n_ghost']);
    expect(contextReviewFlags(selection).join(' ')).toContain('n_ghost');
  });

  it('names an edge a journey claims and the graph does not hold', () => {
    const broken = {
      ...flowMap,
      journeys: [{ ...flowMap.journeys[0]!, edgeIds: ['e_1', 'e_missing'] }],
    } as FlowMap;
    const selection = relevantContext(broken, item({ journeyId: 'j_checkout' }));
    expect(selection.missingEdgeIds).toEqual(['e_missing']);
    expect(contextReviewFlags(selection).join(' ')).toContain('inferred rather than given');
  });

  it('reports the states that matched and did not fit, never silently', () => {
    const selection = relevantContext(
      flowMap,
      item({ steps: ['open /a', 'open /b', 'open /c', 'open /d', 'open /cart', 'open /pay', 'open /blog'] }),
    );
    if (selection.omittedNodes > 0) {
      expect(contextReviewFlags(selection).join(' ')).toContain('at least');
    }
    // The parts sum to the whole whichever way the budget fell.
    expect(selection.nodeIds.length).toBeLessThanOrEqual(6);
  });

  it('says so out loud when nothing matched at all', () => {
    const empty = { ...flowMap, nodes: [], edges: [], journeys: [] } as unknown as FlowMap;
    const selection = relevantContext(empty, item());
    expect(selection.nodeIds).toEqual([]);
    expect(contextReviewFlags(selection).join(' ')).toContain('every locator in this test was inferred');
  });

  it('never reports a flag with no shortfall behind it', () => {
    expect(contextReviewFlags(relevantContext(flowMap, item({ journeyId: 'j_checkout' })))).toEqual(
      [],
    );
  });
});

describe('determinism', () => {
  it('is byte-identical for one item and one flow map', () => {
    const a = relevantContext(flowMap, item({ journeyId: 'j_checkout' }));
    const b = relevantContext(flowMap, item({ journeyId: 'j_checkout' }));
    expect(a.text).toBe(b.text);
    expect(a.nodeIds).toEqual(b.nodeIds);
  });

  it('de-duplicates a node reached through two edges', () => {
    const selection = relevantContext(flowMap, {
      ...item(),
      targets: { nodeIds: ['n_pay'], edgeIds: ['e_1', 'e_2'] },
    });
    expect(selection.nodeIds.filter((id) => id === 'n_pay')).toHaveLength(1);
  });
});
