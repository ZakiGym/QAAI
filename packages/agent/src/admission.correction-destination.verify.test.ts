/**
 * ADVERSARIAL: `PATH_CONVENTION`'S OWN CORRECTION NEVER FACES THE ONE RULE.
 *
 * The gate's header says question 1 — `destinationDecision`, "the one rule in
 * the product about whether a repo-relative path is a legal destination" — "runs
 * FIRST and runs on EVERY call". It runs on the path the MODEL supplied. When
 * that path fails the ecosystem's suffix pattern the gate computes a REPLACEMENT
 * from `testFilePath(ecosystem, { feature: item.feature, title: item.title })`
 * and returns it as `correctedFilePath` WITHOUT asking question 1 about it.
 *
 * So the corrected path is the one destination in the product that is written
 * without ever being judged, and `item.feature` is the text that chooses its
 * first segment. Two consequences, both measured below:
 *
 *   1. A FORBIDDEN DIRECTORY. `feature: 'dist'` produces `dist/<title>.spec.ts`,
 *      which the previous commit verified FAILS the real `admit` when a model
 *      asks for it — and which PASSES when the gate itself asks for it.
 *   2. OUTSIDE THE MEASURED LAYOUT. With a usable layout whose root is
 *      `tests/acceptance`, a corrected path under `checkout/` is admitted,
 *      although the identical path proposed by the model is refused
 *      `OUTSIDE_LEARNED_LAYOUT`.
 *
 * Both end at a `Test.filePath` and a `GeneratedArtifact` row the push path
 * writes into the customer's branch, so this is a write primitive and not a
 * cosmetic disagreement.
 */

import { describe, expect, it } from 'vitest';
import { admit } from './admission.js';
import type { PlanItem, StyleObservation, FileLayout } from '@qaai/shared';

function item(feature: string): PlanItem {
  return {
    id: 'item-1',
    title: 'Checkout shows the order total',
    rationale: 'The survey said the total was wrong at checkout.',
    feature,
    priority: 'IMPORTANT',
    testType: 'E2E',
    steps: ['Open the cart page'],
    assertions: ['The order total reads $42.00'],
    journeyId: null,
    authProfileId: null,
  };
}

const CODE = `import { test, expect } from '@playwright/test';

test('Checkout shows the order total', async ({ page }) => {
  await page.goto('/cart');
  await expect(page.getByTestId('order-total')).toHaveText('$42.00');
});
`;

/** A usable measured layout: `tests/acceptance`, not colocated. */
const MEASURED: StyleObservation<FileLayout> = {
  value: { root: 'tests/acceptance', filename: '{name}.e2e.ts', colocated: false },
  confidence: 'HIGH',
  filesSeen: 5,
  filesConsidered: 5,
  examples: [],
  deferredTo: null,
};

const base = {
  code: CODE,
  testType: 'E2E' as const,
  language: 'TYPESCRIPT' as const,
  ecosystemId: 'playwright',
};

function gateOf(report: Awaited<ReturnType<typeof admit>>, id: string) {
  return report.gates.find((gate) => gate.gate === id)!;
}

describe("the corrected path PATH_CONVENTION substitutes", () => {
  it('faces the deny list, so it cannot be admitted into a directory the model is refused at', async () => {
    /*
     * THE CONTROL. The model asks for `dist/…` directly. This is the case the
     * previous commit verified, and it must stay refused.
     */
    const asked = await admit({
      ...base,
      filePath: 'dist/checkout.spec.ts',
      item: item('checkout'),
    });
    expect(gateOf(asked, 'PATH_CONVENTION').status).toBe('FAIL');
    expect(gateOf(asked, 'PATH_CONVENTION').detail[0]).toContain('FORBIDDEN_DIRECTORY');

    /*
     * THE ATTACK. The model's path fails the suffix pattern, so the gate
     * computes a replacement from `item.feature` — and `feature: 'dist'`
     * kebab-cases to the deny-listed segment unchanged.
     */
    const corrected = await admit({
      ...base,
      // Not a path Playwright collects, so the correction branch is taken.
      filePath: 'checkout/order-total.ts',
      item: item('dist'),
    });
    const gate = gateOf(corrected, 'PATH_CONVENTION');

    console.log(
      '\n=== CORRECTION INTO A FORBIDDEN DIRECTORY ===\n' +
        `status: ${gate.status}\ncorrectedFilePath: ${String(corrected.correctedFilePath)}\nwhy: ${gate.why}`,
    );

    /*
     * FIXED IN THIS CHANGE. Before it, `correctedFilePath` came back
     * `dist/checkout-shows-the-order-total.spec.ts` at status WARN, and the
     * processor stored a test row and a QAAI_OWNED ledger row at that path.
     */
    expect(gate.status).toBe('FAIL');
    expect(gate.detail[0]).toContain('FORBIDDEN_DIRECTORY');
    expect(gate.detail[1]).toContain('dist');
    // And NOT silently swapped for a tidy path.
    expect(corrected.correctedFilePath).toBeNull();
    // The refused PATH is never interpolated into the sentence a human reads.
    expect(gate.why).not.toContain('dist/checkout-shows-the-order-total.spec.ts');
  });

  /**
   * STILL OPEN, AND REPORTED RATHER THAN NARROWED. The layout half of
   * `destinationDecision` is deliberately NOT re-asked about the replacement —
   * see the comment at the call site for why failing here would refuse
   * generation in every repository whose tests are not at the ecosystem
   * default. This test pins TODAY'S behaviour so the gap is visible and so the
   * day somebody teaches `testFilePath` the measured root, this test is the one
   * that says what changed.
   */
  it('CAN still land outside a measured layout root, which is the half this change does not close', async () => {
    // THE CONTROL: the model asking for `checkout/…` under this layout is refused.
    const asked = await admit({
      ...base,
      filePath: 'checkout/checkout-shows-the-order-total.spec.ts',
      item: item('checkout'),
      layout: MEASURED,
    });
    expect(gateOf(asked, 'PATH_CONVENTION').status).toBe('FAIL');
    expect(gateOf(asked, 'PATH_CONVENTION').detail[0]).toContain('OUTSIDE_LEARNED_LAYOUT');

    /*
     * THE ATTACK: a path INSIDE the measured root that the runner would not
     * collect. The gate corrects it to the ecosystem default, which is outside
     * the root, and does not re-ask.
     */
    const corrected = await admit({
      ...base,
      filePath: 'tests/acceptance/checkout_shows_the_order_total.e2e.ts',
      item: item('checkout'),
      layout: MEASURED,
    });
    const gate = gateOf(corrected, 'PATH_CONVENTION');

    console.log(
      '\n=== CORRECTION OUTSIDE THE MEASURED ROOT ===\n' +
        `status: ${gate.status}\ncorrectedFilePath: ${String(corrected.correctedFilePath)}\nwhy: ${gate.why}`,
    );

    expect(corrected.correctedFilePath).toBe('checkout/checkout-shows-the-order-total.spec.ts');
    expect(gate.status).not.toBe('FAIL');
  });
});
