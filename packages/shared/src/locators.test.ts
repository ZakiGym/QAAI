import { describe, expect, it } from 'vitest';
import type { Selector } from './flow-map';
import {
  controlIdentity,
  controlsFromFlowMap,
  locatorExpression,
  locatorsFromFlowMap,
  type FlowMapControlsInput,
} from './locators';

/**
 * The control identity, and the 100%-at-20% lie it was hiding.
 *
 * `locatorsFromFlowMap` de-duplicated the whole application's controls by
 * LOCATOR EXPRESSION, and the coverage denominator read that list as its
 * universe. So `getByRole('button', { name: 'Save' })` on /profile, /billing,
 * /team, /notifications and /api-keys was ONE control, and a single test
 * clicking Save on /profile reported every one of them exercised: five
 * handlers, five payloads, five validations, one tick.
 *
 * Every assertion below that mentions five is checking the same thing from a
 * different side, because the fix has to hold in both directions — five
 * independent Save buttons must not collapse, and one shared header link must
 * still be reportable as one finding rather than twenty.
 */

function role(name: string, confidence = 0.9): Selector {
  return { strategy: 'ROLE', value: 'button', name, confidence };
}

function link(name: string, confidence = 0.95): Selector {
  return { strategy: 'ROLE', value: 'link', name, confidence };
}

/** Five settings pages, each with its own Save button. The real-world shape. */
const FIVE_SAVES: FlowMapControlsInput = {
  nodes: ['/profile', '/billing', '/team', '/notifications', '/api-keys'].map((route) => ({
    route,
    affordances: [{ label: 'Save', selector: role('Save'), kind: 'button' as const }],
  })),
};

/** One header link, repeated on every page. The shape that justified the collapse. */
const SHARED_HEADER: FlowMapControlsInput = {
  nodes: ['/', '/orders', '/orders/:param'].map((route) => ({
    route,
    affordances: [{ label: 'Log out', selector: link('Log out'), kind: 'link' as const }],
  })),
};

describe('control identity', () => {
  it('keeps "Save" on five routes as five controls', () => {
    const controls = controlsFromFlowMap(FIVE_SAVES);

    expect(controls).toHaveLength(5);
    expect(controls.map((control) => control.route).sort()).toEqual([
      '/api-keys',
      '/billing',
      '/notifications',
      '/profile',
      '/team',
    ]);
    // Five distinct keys, which is what makes five distinct denominator entries
    // possible. The old implementation returned one row for all five.
    expect(new Set(controls.map((control) => control.key)).size).toBe(5);
  });

  it('puts the page in the key, so one page cannot answer for another', () => {
    const [first] = controlsFromFlowMap(FIVE_SAVES);

    expect(first).toBeDefined();
    expect(first!.key).toBe(
      controlIdentity(first!.route, `getByRole('button', { name: 'Save' })`),
    );
    // The expression alone is NOT the key. Asserted as a non-equality because
    // that is precisely the equality the defect rested on.
    expect(first!.key).not.toBe(first!.expression);
  });

  it('counts the other pages a shared control appears on, rather than hiding them', () => {
    const controls = controlsFromFlowMap(SHARED_HEADER);

    expect(controls).toHaveLength(3);
    // Three sightings, each reporting the two others. A caller that wants to
    // report one finding for a header can group on this; the identity has not
    // guessed on its behalf.
    expect(controls.map((control) => control.sharedWithRouteCount)).toEqual([2, 2, 2]);
  });

  it('reports zero shared pages as a measurement, for a control unique to its page', () => {
    const controls = controlsFromFlowMap({
      nodes: [
        {
          route: '/profile',
          affordances: [
            { label: 'Delete account', selector: role('Delete account'), kind: 'button' },
          ],
        },
      ],
    });

    expect(controls).toHaveLength(1);
    expect(controls[0]!.sharedWithRouteCount).toBe(0);
  });

  it('folds two sightings of one control on one page, keeping the surer one', () => {
    const controls = controlsFromFlowMap({
      nodes: [
        {
          route: '/profile',
          affordances: [
            { label: 'Save draft', selector: role('Save', 0.4), kind: 'button' },
            { label: 'Save changes', selector: role('Save', 0.95), kind: 'button' },
          ],
        },
      ],
    });

    // One page, one expression: one control. The label comes from the sighting
    // the Explorer was most sure about, which is what the de-duped list did.
    expect(controls).toHaveLength(1);
    expect(controls[0]!.label).toBe('Save changes');
    expect(controls[0]!.confidence).toBe(0.95);
    expect(controls[0]!.sharedWithRouteCount).toBe(0);
  });

  it('is deterministic in order, so a diff shows a change in the app', () => {
    const once = controlsFromFlowMap(FIVE_SAVES).map((control) => control.key);
    const again = controlsFromFlowMap(FIVE_SAVES).map((control) => control.key);

    expect(once).toEqual(again);
    expect(once).toEqual([
      '/api-keys#getByRole(\'button\', { name: \'Save\' })',
      '/billing#getByRole(\'button\', { name: \'Save\' })',
      '/notifications#getByRole(\'button\', { name: \'Save\' })',
      '/profile#getByRole(\'button\', { name: \'Save\' })',
      '/team#getByRole(\'button\', { name: \'Save\' })',
    ]);
  });
});

describe('the editor’s suggestion list', () => {
  it('still offers one suggestion per expression, so a header link is not offered twenty times', () => {
    const suggestions = locatorsFromFlowMap(SHARED_HEADER);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.expression).toBe(`getByRole('link', { name: 'Log out' })`);
  });

  it('says on the row how many pages it collapsed, so the collapse is not silent', () => {
    expect(locatorsFromFlowMap(SHARED_HEADER)[0]!.routeCount).toBe(3);
    expect(locatorsFromFlowMap(FIVE_SAVES)[0]!.routeCount).toBe(5);
  });

  it('agrees with the control universe it is derived from', () => {
    const input: FlowMapControlsInput = {
      nodes: [
        {
          route: '/profile',
          affordances: [
            { label: 'Save', selector: role('Save'), kind: 'button' },
            { label: 'Log out', selector: link('Log out'), kind: 'link' },
          ],
        },
        {
          route: '/billing',
          affordances: [
            { label: 'Save', selector: role('Save'), kind: 'button' },
            { label: 'Log out', selector: link('Log out'), kind: 'link' },
          ],
        },
      ],
    };

    const controls = controlsFromFlowMap(input);
    const suggestions = locatorsFromFlowMap(input);

    expect(controls).toHaveLength(4);
    expect(suggestions).toHaveLength(2);
    // The two numbers have to reconcile or the suggestion list is claiming a
    // different application from the one the denominator divides by.
    for (const suggestion of suggestions) {
      const sightings = controls.filter(
        (control) => control.expression === suggestion.expression,
      );
      expect(suggestion.routeCount).toBe(sightings.length);
      expect(suggestion.routeCount).toBe(sightings[0]!.sharedWithRouteCount + 1);
    }
  });

  it('shows the route of the sighting the Explorer was surest about', () => {
    const suggestions = locatorsFromFlowMap({
      nodes: [
        {
          route: '/weak',
          affordances: [{ label: 'Save', selector: role('Save', 0.3), kind: 'button' }],
        },
        {
          route: '/strong',
          affordances: [{ label: 'Save', selector: role('Save', 0.99), kind: 'button' }],
        },
      ],
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.route).toBe('/strong');
    expect(suggestions[0]!.confidence).toBe(0.99);
    // The count survives the swap. It is a property of the expression, not of
    // whichever sighting happened to win.
    expect(suggestions[0]!.routeCount).toBe(2);
  });

  it('sorts best-first, as every caller that slices it assumes', () => {
    const suggestions = locatorsFromFlowMap({
      nodes: [
        {
          route: '/one',
          affordances: [
            { label: 'Brittle', selector: { strategy: 'CSS', value: '.btn', confidence: 0.2 }, kind: 'button' },
            { label: 'Stable', selector: role('Stable', 0.95), kind: 'button' },
          ],
        },
      ],
    });

    expect(suggestions.map((suggestion) => suggestion.label)).toEqual(['Stable', 'Brittle']);
  });

  it('survives a flow map with no nodes, rather than throwing on the empty case', () => {
    expect(locatorsFromFlowMap({ nodes: [] })).toEqual([]);
    expect(controlsFromFlowMap({ nodes: [] })).toEqual([]);
  });
});

describe('the locator expression', () => {
  it('escapes a quote, so a label cannot break out of the generated call', () => {
    expect(locatorExpression({ strategy: 'TEXT', value: "It's here", confidence: 1 })).toBe(
      "getByText('It\\'s here')",
    );
  });

  it('keeps nth, because the second row of a table is not the first', () => {
    expect(
      locatorExpression({ strategy: 'ROLE', value: 'row', name: 'Order', confidence: 1, nth: 2 }),
    ).toBe("getByRole('row', { name: 'Order' }).nth(2)");
  });
});
