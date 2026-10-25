/**
 * The control identity, checked against the behaviour it replaced.
 *
 * locators.test.ts asserts what `controlsFromFlowMap` does. This file asserts
 * that it DIFFERS from what the code did before — by computing the old collapse
 * beside the new universe in the same test and comparing the two numbers. A
 * test that only states the new answer passes just as happily on a reader that
 * never changed, and the change here is a coverage number moving from 100% to
 * 20% on a real application, so it is worth a test that cannot pass on the old
 * behaviour.
 *
 * The old behaviour, in one line: de-duplicate every affordance in the
 * application by LOCATOR EXPRESSION and hand that list to the denominator. It
 * is reproduced below as `collapsedByExpression` — not imported, because
 * nothing in the repository should offer it any more.
 */

import { describe, expect, it } from 'vitest';
import type { Selector } from './flow-map';
import {
  controlIdentity,
  controlsFromFlowMap,
  locatorExpression,
  locatorsFromFlowMap,
  type FlowMapControlsInput,
} from './locators';

function button(name: string, confidence = 0.9): Selector {
  return { strategy: 'ROLE', value: 'button', name, confidence };
}

/**
 * THE OLD UNIVERSE, reconstructed so the comparison is in the test and not in a
 * comment. One row per distinct locator expression, across the whole app.
 */
function collapsedByExpression(input: FlowMapControlsInput): string[] {
  const seen = new Set<string>();
  for (const node of input.nodes) {
    for (const affordance of node.affordances) seen.add(locatorExpression(affordance.selector));
  }
  return [...seen];
}

/** The two pages the task names, each with its own Save button and handler. */
const PROFILE_AND_BILLING: FlowMapControlsInput = {
  nodes: [
    { route: '/profile', affordances: [{ label: 'Save', selector: button('Save'), kind: 'button' }] },
    { route: '/billing', affordances: [{ label: 'Save', selector: button('Save'), kind: 'button' }] },
  ],
};

describe('"Save" on /profile and "Save" on /billing', () => {
  it('are TWO controls, where the old reader had one', () => {
    /*
     * The assertion that fails against the old behaviour. Two pages, two Save
     * buttons, two handlers, two payloads, two validations — and one locator
     * expression. The old universe had one row, so a test clicking Save on
     * /profile reported both exercised.
     */
    const old = collapsedByExpression(PROFILE_AND_BILLING);
    const now = controlsFromFlowMap(PROFILE_AND_BILLING);

    expect(old).toHaveLength(1);
    expect(now).toHaveLength(2);
    expect(now.length).toBeGreaterThan(old.length);
  });

  it('carry the page in their identity, so neither can be ticked by the other', () => {
    const now = controlsFromFlowMap(PROFILE_AND_BILLING);
    const keys = now.map((control) => control.key).sort();

    expect(keys).toEqual([
      `/billing#getByRole('button', { name: 'Save' })`,
      `/profile#getByRole('button', { name: 'Save' })`,
    ]);
    // Two distinct keys is the whole fix. One key for two controls is the lie.
    expect(new Set(keys).size).toBe(2);
    // And the key is derived by the exported function, not spelled inline, so a
    // caller resolving a stored key cannot disagree with the producer.
    expect(keys).toContain(
      controlIdentity('/profile', `getByRole('button', { name: 'Save' })`),
    );
  });

  it('each report that the other exists, rather than guessing they are one', () => {
    /*
     * The fact, not a verdict. QAAI cannot tell a shared header from two
     * independent Save buttons by looking at a selector, so it counts the other
     * pages and refuses to collapse on the number.
     */
    const now = controlsFromFlowMap(PROFILE_AND_BILLING);
    expect(now.map((control) => control.sharedWithRouteCount)).toEqual([1, 1]);
  });

  it('still collapse to ONE suggestion for the editor, with the count of what collapsed', () => {
    // The direction that justified the old collapse has to keep working:
    // offering the same locator twice buries everything else in the list.
    const suggestions = locatorsFromFlowMap(PROFILE_AND_BILLING);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.routeCount).toBe(2);
    // `routeCount` is the disclosure. A collapse with no count on the row is the
    // old reader with a different name.
    expect(suggestions[0]?.routeCount).toBe(collapsedByExpression(PROFILE_AND_BILLING).length + 1);
  });
});

describe('the two readers cannot drift into two answers', () => {
  /*
   * `locatorsFromFlowMap` is DERIVED from `controlsFromFlowMap` — one traversal,
   * one identity — and these are the properties that make that checkable from
   * the outside. Two traversals of one flow map is two answers to "what controls
   * does this app have", which is how the denominator came to read the
   * suggestion list as the inventory in the first place.
   */
  const MIXED: FlowMapControlsInput = {
    nodes: [
      {
        route: '/profile',
        affordances: [
          { label: 'Save', selector: button('Save', 0.9), kind: 'button' },
          { label: 'Log out', selector: button('Log out', 0.95), kind: 'button' },
          // The same control sighted twice on one page: ONE control, and the
          // Explorer's more confident reading wins.
          { label: 'Save (again)', selector: button('Save', 0.4), kind: 'button' },
        ],
      },
      {
        route: '/billing',
        affordances: [
          { label: 'Save', selector: button('Save', 0.7), kind: 'button' },
          { label: 'Log out', selector: button('Log out', 0.95), kind: 'button' },
        ],
      },
    ],
  };

  it('every suggestion names a route that really carries it', () => {
    const controls = controlsFromFlowMap(MIXED);
    for (const suggestion of locatorsFromFlowMap(MIXED)) {
      const carrying = controls.filter((c) => c.expression === suggestion.expression);
      expect(carrying.map((c) => c.route)).toContain(suggestion.route);
      // The suggestion shows the sighting the Explorer was most sure about.
      expect(suggestion.confidence).toBe(Math.max(...carrying.map((c) => c.confidence)));
    }
  });

  it('routeCount equals the number of control rows for that expression', () => {
    const controls = controlsFromFlowMap(MIXED);
    for (const suggestion of locatorsFromFlowMap(MIXED)) {
      const rows = controls.filter((c) => c.expression === suggestion.expression);
      expect(suggestion.routeCount).toBe(rows.length);
    }
  });

  it('de-duplicates within a page and never across pages', () => {
    const controls = controlsFromFlowMap(MIXED);
    // Three sightings of Save, on two pages: two controls, not three and not one.
    expect(controls.filter((c) => c.label.startsWith('Save'))).toHaveLength(2);
    // The within-page winner is the confident sighting, so the label a reader
    // is shown is the one the Explorer actually read.
    const profileSave = controls.find(
      (c) => c.route === '/profile' && c.expression.includes("'Save'"),
    );
    expect(profileSave?.confidence).toBe(0.9);
    expect(profileSave?.label).toBe('Save');
  });

  it('is deterministic, so a diff shows a change in the app and not in a Map', () => {
    expect(controlsFromFlowMap(MIXED).map((c) => c.key)).toEqual(
      controlsFromFlowMap(MIXED).map((c) => c.key),
    );
    expect(locatorsFromFlowMap(MIXED).map((s) => s.expression)).toEqual(
      locatorsFromFlowMap(MIXED).map((s) => s.expression),
    );
  });
});

describe('the identity separator', () => {
  /*
   * `controlIdentity` joins on a bare `#` and escapes nothing, unlike
   * `crawl/interact.ts`'s identity, which encodes every part before joining on
   * `::`. That asymmetry is worth a test rather than an assumption: an
   * ambiguous key is a control silently ticked by a different control.
   *
   * It holds, and the reason is a property of the OTHER half of the key: every
   * string `locatorExpression` can produce begins with a method name and an
   * open paren, so no expression can start with a route-shaped prefix and
   * donate the rest to a route. The cases below are the ones that would break
   * it if that ever stopped being true — a hash-routed page and a CSS locator
   * full of `#`.
   */
  it('does not let a hash route and a CSS locator produce one key for two controls', () => {
    const hashRouted: FlowMapControlsInput = {
      nodes: [
        {
          route: '/#/orders',
          affordances: [
            { label: 'Save', selector: { strategy: 'CSS', value: '#save', confidence: 0.4 }, kind: 'button' },
          ],
        },
        {
          route: '/#/orders/#save',
          affordances: [
            { label: 'Save', selector: { strategy: 'CSS', value: 'x', confidence: 0.4 }, kind: 'button' },
          ],
        },
      ],
    };
    const keys = controlsFromFlowMap(hashRouted).map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps every locatorExpression shaped so the join stays unambiguous', () => {
    // The property the paragraph above depends on. If a future strategy
    // produces an expression that does not start with `name(`, the separator
    // needs escaping and this test is where that is noticed.
    const strategies: Selector[] = [
      { strategy: 'ROLE', value: 'button', name: 'a#b', confidence: 1 },
      { strategy: 'LABEL', value: 'x', name: '#y', confidence: 1 },
      { strategy: 'PLACEHOLDER', value: 'x', name: '#y', confidence: 1 },
      { strategy: 'TEXT', value: 'x', name: 'a#b', confidence: 1 },
      { strategy: 'TEST_ID', value: '#save', confidence: 1 },
      { strategy: 'CSS', value: '#save', confidence: 1 },
    ];
    for (const selector of strategies) {
      expect(locatorExpression(selector)).toMatch(/^[A-Za-z]+\(/);
    }
  });
});
