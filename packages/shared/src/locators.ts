/**
 * Turning a crawled Selector into the Playwright call a human would write.
 *
 * This is the bridge between "the Explorer saw a button" and "the editor can
 * complete it". It is deliberately deterministic — no model involved — because
 * the flow map already knows the answer, and a suggestion that is merely
 * plausible is worse than none when the whole point is that the locator exists.
 */

import type { Selector } from './flow-map';

/** JS single-quoted string literal, escaped. */
function q(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * The locator expression, without a leading `page.` — callers prepend whatever
 * root they need (`page.`, `dialog.`, …).
 */
export function locatorExpression(selector: Selector): string {
  const { strategy, value, name, nth } = selector;

  let call: string;
  switch (strategy) {
    case 'ROLE':
      call = name ? `getByRole(${q(value)}, { name: ${q(name)} })` : `getByRole(${q(value)})`;
      break;
    case 'LABEL':
      call = `getByLabel(${q(name ?? value)})`;
      break;
    case 'PLACEHOLDER':
      call = `getByPlaceholder(${q(name ?? value)})`;
      break;
    case 'TEXT':
      call = `getByText(${q(name ?? value)})`;
      break;
    case 'TEST_ID':
      call = `getByTestId(${q(value)})`;
      break;
    case 'CSS':
    default:
      call = `locator(${q(value)})`;
      break;
  }

  return nth === undefined ? call : `${call}.nth(${nth})`;
}

export interface LocatorSuggestion {
  /** Human label from the crawl, e.g. "Add to cart". */
  label: string;
  /**
   * The route the HIGHEST-CONFIDENCE sighting was on, e.g. `/products`.
   *
   * One of possibly many. `routeCount` below says how many — see the note on
   * {@link locatorsFromFlowMap} for why that number has to be on the row.
   */
  route: string;
  kind: 'link' | 'button' | 'input';
  strategy: Selector['strategy'];
  /** 0–1 from the Explorer. Low-confidence locators sort last. */
  confidence: number;
  /** `getByRole('button', { name: 'Add to cart' })` */
  expression: string;
  /**
   * How many DISTINCT routes this expression was seen on.
   *
   * A count rather than the list of routes, deliberately: a nav link on a
   * 2,000-page crawl would otherwise carry 2,000 strings on every row, and the
   * list would then need a cap, and a capped list read as a whole one is the
   * undisclosed cap this codebase keeps finding. The count is exact and cannot
   * be mistaken for an enumeration.
   *
   * Greater than 1 means this suggestion is a shared control — a header, a
   * footer, a table action repeated per row-page. That is the fact a reader
   * needs before concluding anything about it from one page.
   */
  routeCount: number;
}

/**
 * ONE CONTROL IS ONE CONTROL ON ONE PAGE.
 *
 * ── THE LIE THIS EXISTS TO END ──────────────────────────────────────────────
 *
 * `locatorsFromFlowMap` de-duplicates by EXPRESSION alone, and for the editor's
 * suggestion list that is right: offering `getByRole('link', { name: 'Log out'
 * })` twenty times buries everything else. But the coverage denominator read
 * the same list, and there the collapse is a measurement error with a direction.
 *
 * `getByRole('button', { name: 'Save' })` exists on /profile, /billing,
 * /team, /notifications and /api-keys. Those are five controls: five handlers,
 * five payloads, five validations, five ways to lose a customer's data. Keyed
 * by expression they are ONE, so a test that clicks Save on /profile marked all
 * five exercised — a suite covering a fifth of the app reporting 100% of its
 * controls. Every form of this bug moves the number the same way.
 *
 * ── AND THE ONE POINTING THE OTHER WAY ──────────────────────────────────────
 *
 * The reason the collapse was there has not gone away: a header link really is
 * one control, and reporting "nobody clicks Log out" once per page is twenty
 * findings for one fact. So identity is per page and `sharedWithRouteCount`
 * says how many other pages carry the same expression, which lets a caller
 * group what is genuinely one control without the identity having guessed.
 *
 * The number is evidence, not a verdict: QAAI cannot tell a shared header from
 * five independent Save buttons by looking at a selector, so it reports the
 * fact and refuses to collapse on it.
 *
 * ── THERE IS A SECOND FUNCTION OF THIS NAME, AND THE KEYS DO NOT MATCH ──────
 *
 * `controlIdentity` in packages/agent/src/crawl/interact.ts is a DIFFERENT
 * formula over different evidence: `route::landmark::role::label::nth`, every
 * part percent-encoded before the join. It identifies a control the crawl
 * DROVE, where a landmark and an ordinal were observable. This one identifies a
 * control a flow map RECORDED, where the only handle is a Playwright locator
 * expression. Neither can produce the other's string, so:
 *
 *   · a key from one must never be looked up against the other, and
 *   · the two must never be unioned as strings into one denominator — the same
 *     Save button would appear once under each and be counted twice.
 *
 * The names collide and the formats do not, which is the pairing most likely to
 * be mistaken for interchangeable. They live in separate packages and separate
 * barrels (`@qaai/shared` and `@qaai/agent`), so TypeScript will not flag it;
 * this note is the only guard there is. If the two inventories ever have to be
 * reconciled, it goes through `canonicalRoute` and the registry key, not through
 * either of these strings.
 *
 * The separator is a bare `#` and nothing is escaped, unlike the other
 * function. That is safe only because every string `locatorExpression` produces
 * begins with a method name and an open paren, so no expression can carry a
 * route-shaped prefix; locators.identity.test.ts pins that property, because it
 * is the thing a new `Selector` strategy could quietly break.
 */
export function controlIdentity(route: string, expression: string): string {
  return `${route}#${expression}`;
}

export interface ControlSighting {
  /** `{route}#{expression}`. See {@link controlIdentity}. */
  key: string;
  label: string;
  /** The page this control lives on. Part of its identity, not a detail. */
  route: string;
  kind: 'link' | 'button' | 'input';
  strategy: Selector['strategy'];
  confidence: number;
  expression: string;
  /**
   * How many OTHER routes carry the same expression. 0 means this control is
   * unique to its page.
   *
   * Zero is a real measurement here and not a default: every sighting is
   * counted against the same crawl, so "no other page has it" is something we
   * looked for and did not find.
   */
  sharedWithRouteCount: number;
}

/** The shape both readers accept: just the nodes and their affordances. */
export interface FlowMapControlsInput {
  nodes: Array<{
    route: string;
    affordances: Array<{ label: string; selector: Selector; kind: 'link' | 'button' | 'input' }>;
  }>;
}

/**
 * Every control in a flow map, one row per (page, locator).
 *
 * This is the universe a denominator must divide by. De-duplicated within a
 * page — two sightings of the same expression on one route are one control, and
 * the higher-confidence sighting wins its label — and never across pages.
 *
 * Sorted by confidence then route then label, so consecutive runs produce the
 * same order and a diff shows a change in the app rather than in a Map's
 * iteration.
 */
export function controlsFromFlowMap(flowMap: FlowMapControlsInput): ControlSighting[] {
  const byKey = new Map<string, ControlSighting>();
  /** Distinct routes per expression, for `sharedWithRouteCount`. */
  const routesByExpression = new Map<string, Set<string>>();

  for (const node of flowMap.nodes ?? []) {
    for (const affordance of node.affordances ?? []) {
      const expression = locatorExpression(affordance.selector);
      const key = controlIdentity(node.route, expression);

      const routes = routesByExpression.get(expression) ?? new Set<string>();
      routes.add(node.route);
      routesByExpression.set(expression, routes);

      const existing = byKey.get(key);
      // Same control, seen twice on one page: keep the sighting the Explorer
      // was most sure about, which is what the de-duped list already did.
      if (existing && existing.confidence >= affordance.selector.confidence) continue;
      byKey.set(key, {
        key,
        label: affordance.label,
        route: node.route,
        kind: affordance.kind,
        strategy: affordance.selector.strategy,
        confidence: affordance.selector.confidence,
        expression,
        // Filled in below: the full set is not known until every node is read.
        sharedWithRouteCount: 0,
      });
    }
  }

  const controls = [...byKey.values()];
  for (const control of controls) {
    const routes = routesByExpression.get(control.expression);
    control.sharedWithRouteCount = routes ? routes.size - 1 : 0;
  }

  return controls.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.route.localeCompare(b.route) ||
      a.label.localeCompare(b.label),
  );
}

/**
 * Every distinct locator in a flow map, best-first — the EDITOR'S list.
 *
 * De-duplicated by expression, because the same nav link appears on every page
 * and offering it twenty times would bury everything else, and sorted by
 * confidence so a stable `getByRole` outranks a brittle CSS fallback.
 *
 * DERIVED from `controlsFromFlowMap` rather than computed beside it. Two
 * traversals of one flow map is two answers to "what controls does this app
 * have", and the whole reason the coverage denominator was wrong is that it
 * read the suggestion list as though it were the inventory. There is now one
 * traversal, one identity, and this function is the collapse — named, with the
 * count of what it collapsed on every row it returns.
 */
export function locatorsFromFlowMap(flowMap: FlowMapControlsInput): LocatorSuggestion[] {
  const byExpression = new Map<string, LocatorSuggestion>();

  for (const control of controlsFromFlowMap(flowMap)) {
    const existing = byExpression.get(control.expression);
    if (!existing) {
      byExpression.set(control.expression, {
        label: control.label,
        route: control.route,
        kind: control.kind,
        strategy: control.strategy,
        confidence: control.confidence,
        expression: control.expression,
        // One sighting so far. `controlsFromFlowMap` already counted the rest
        // on the row, so this agrees with it by construction.
        routeCount: control.sharedWithRouteCount + 1,
      });
      continue;
    }
    // Keep the sighting with the highest confidence, so the route shown is the
    // one the Explorer was most sure about. `routeCount` is a property of the
    // expression, not of the winning sighting, so it does not change here.
    if (existing.confidence >= control.confidence) continue;
    byExpression.set(control.expression, {
      label: control.label,
      route: control.route,
      kind: control.kind,
      strategy: control.strategy,
      confidence: control.confidence,
      expression: control.expression,
      routeCount: existing.routeCount,
    });
  }

  return [...byExpression.values()].sort(
    (a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label),
  );
}
