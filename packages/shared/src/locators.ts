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
  /** Route the element was seen on, e.g. `/products`. */
  route: string;
  kind: 'link' | 'button' | 'input';
  strategy: Selector['strategy'];
  /** 0–1 from the Explorer. Low-confidence locators sort last. */
  confidence: number;
  /** `getByRole('button', { name: 'Add to cart' })` */
  expression: string;
}

/**
 * Every distinct locator in a flow map, best-first.
 *
 * De-duplicated by expression: the same nav link appears on every page, and
 * offering it twenty times would bury everything else. Sorted by confidence so
 * a stable `getByRole` outranks a brittle CSS fallback.
 */
export function locatorsFromFlowMap(flowMap: {
  nodes: Array<{
    route: string;
    affordances: Array<{ label: string; selector: Selector; kind: 'link' | 'button' | 'input' }>;
  }>;
}): LocatorSuggestion[] {
  const byExpression = new Map<string, LocatorSuggestion>();

  for (const node of flowMap.nodes ?? []) {
    for (const affordance of node.affordances ?? []) {
      const expression = locatorExpression(affordance.selector);
      const existing = byExpression.get(expression);
      // Keep the sighting with the highest confidence, so the route shown is the
      // one the Explorer was most sure about.
      if (existing && existing.confidence >= affordance.selector.confidence) continue;
      byExpression.set(expression, {
        label: affordance.label,
        route: node.route,
        kind: affordance.kind,
        strategy: affordance.selector.strategy,
        confidence: affordance.selector.confidence,
        expression,
      });
    }
  }

  return [...byExpression.values()].sort(
    (a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label),
  );
}
