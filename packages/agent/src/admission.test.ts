/**
 * Admission tests.
 *
 * This module decides whether a generated test is allowed to exist, so its
 * mistakes are not symmetrical and the suite is weighted accordingly.
 *
 *   A FALSE REFUSAL is loud and cheap once: somebody re-runs generation. But
 *   a refused test covers nothing at all, and a gate that refuses correct code
 *   gets switched off — and a switched-off gate is the original defect back.
 *   So every FAIL case here has a COUNTER-EXAMPLE next to it: a pytest file
 *   that is not accused of having no assertions, a route string that is not
 *   accused of being an XPath, an ARIA role name that is not accused of being
 *   a brittle CSS selector, a QAAI mention in a URL that is not accused of
 *   being an import.
 *
 *   A FALSE ADMISSION is silent and permanent: the test is stored, the coverage
 *   number moves, and a human reads "admitted" as "checked". So the UNAVAILABLE
 *   cases assert not just the status but that the sentence reaches
 *   `reviewFlags`, because that is the only place a person sees it.
 *
 * Nothing here calls a model, starts a process or touches the filesystem —
 * `admit` is pure and the four toolchain gates are injected, which is what
 * makes a verdict table this consequential cheap enough to keep correct.
 */

import { describe, expect, it } from 'vitest';
import type { PlanItem } from '@qaai/shared';
import { FINAL_ATTEMPT, __internal, admit, verdictFor } from './admission.js';
import type {
  AdmissionInput,
  AdmissionReport,
  GateId,
  GateOutcome,
  GateStatus,
  ToolchainGates,
} from './admission.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CHECKOUT_ITEM: PlanItem = {
  id: 'item-1',
  title: 'Pay for an order with a saved card',
  rationale: 'Payment is the one flow whose failure costs money the same day.',
  feature: 'Checkout',
  priority: 'CRITICAL_PATH',
  testType: 'E2E',
  steps: ['Open the checkout page', 'Fill in the card number', 'Press Pay now'],
  assertions: ['The order confirmation heading is shown', 'The order total is $42.00'],
  journeyId: null,
  authProfileId: null,
};

/** A test that does the job: role/label locators, two real assertions. */
const GOOD_PLAYWRIGHT = `import { expect, test } from '@playwright/test';

test('pay for an order with a saved card', async ({ page }) => {
  await page.goto('/checkout');
  await page.getByLabel('Card number').fill('4242424242424242');
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
  await expect(page.getByTestId('order-total')).toHaveText('$42.00');
});
`;

/**
 * The defect, in one file. It navigates, it fills, it clicks, it waits for the
 * confirmation heading — and it asserts nothing. Before admission existed this
 * was stored, counted as coverage, and shown to a human with nothing checked.
 */
const PLAUSIBLE_BUT_ASSERTS_NOTHING = `import { test } from '@playwright/test';

test('pay for an order with a saved card', async ({ page }) => {
  await page.goto('/checkout');
  await page.getByLabel('Card number').fill('4242424242424242');
  await page.getByRole('button', { name: 'Pay now' }).click();
  await page.getByRole('heading', { name: 'Order confirmed' }).waitFor();
});
`;

const BRITTLE_LOCATORS = `import { expect, test } from '@playwright/test';

test('pay for an order with a saved card', async ({ page }) => {
  await page.goto('/checkout');
  await page.locator('div.sc-x7f2 > span:nth-child(3)').click();
  await page.locator('.flex.items-center.gap-2 > button').click();
  await expect(page.locator('//html/body/div[2]/main/section[1]/p')).toHaveText('$42.00');
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
});
`;

/** pytest. Zero `expect(` calls and two perfectly good assertions. */
const PYTEST = `from playwright.sync_api import Page, expect


def test_pay_for_an_order_with_a_saved_card(page: Page) -> None:
    page.goto("/checkout")
    page.get_by_label("Card number").fill("4242424242424242")
    page.get_by_role("button", name="Pay now").click()
    expect(page.get_by_role("heading", name="Order confirmed")).to_be_visible()
    assert page.get_by_test_id("order-total").inner_text() == "$42.00"
`;

/** Go. No assertion library at all — failing the test IS the assertion. */
const GO_TEST = `package checkout

import (
	"testing"
)

func TestPayForAnOrderWithASavedCard(t *testing.T) {
	page := newPage(t)
	if _, err := page.Goto("/checkout"); err != nil {
		t.Fatalf("goto checkout: %v", err)
	}
	if err := page.GetByLabel("Card number").Fill("4242424242424242"); err != nil {
		t.Fatalf("fill card number: %v", err)
	}
	total, err := page.GetByTestId("order-total").InnerText()
	if err != nil {
		t.Fatalf("read order total: %v", err)
	}
	if total != "$42.00" {
		t.Errorf("order total = %q, want $42.00", total)
	}
}
`;

/** No file extension this repo has a dialect for. Unreadable, not empty. */
const UNKNOWN_DIALECT = `Open the checkout page
Fill in the card number
Press Pay now
The order confirmation heading is shown and the order total is $42.00
`;

function input(over: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    code: GOOD_PLAYWRIGHT,
    filePath: 'tests/checkout/pay-for-an-order-with-a-saved-card.spec.ts',
    testType: 'E2E',
    item: CHECKOUT_ITEM,
    language: 'TYPESCRIPT',
    ecosystemId: 'PLAYWRIGHT_TS',
    ...over,
  };
}

/** A plan item differing from the fixture only where a test says it does. */
function planItem(over: Partial<PlanItem> = {}): PlanItem {
  return { ...CHECKOUT_ITEM, ...over };
}

function gateOf(report: AdmissionReport, id: GateId): GateOutcome {
  const found = report.gates.find((gate) => gate.gate === id);
  if (!found) throw new Error(`the report carries no ${id} gate at all`);
  return found;
}

function statusOf(report: AdmissionReport, id: GateId): GateStatus {
  return gateOf(report, id).status;
}

function outcome(gate: GateId, status: GateStatus, why = `${gate} ${status}`): GateOutcome {
  return { gate, status, why, detail: [], line: null };
}

type ToolchainOverrides = Partial<{
  syntax: GateOutcome;
  typecheck: GateOutcome;
  lint: GateOutcome;
  format: GateOutcome & { code?: string };
}>;

function toolchain(over: ToolchainOverrides = {}, calls: GateId[] = []): ToolchainGates {
  return {
    syntax: async () => {
      calls.push('SYNTAX');
      return over.syntax ?? outcome('SYNTAX', 'PASS');
    },
    typecheck: async () => {
      calls.push('TYPECHECK');
      return over.typecheck ?? outcome('TYPECHECK', 'PASS');
    },
    format: async () => {
      calls.push('FORMAT');
      return over.format ?? outcome('FORMAT', 'PASS');
    },
    lint: async () => {
      calls.push('LINT');
      return over.lint ?? outcome('LINT', 'PASS');
    },
  };
}

// ─── The end-to-end case this module was built for ───────────────────────────

describe('the defect: a plausible test that asserts nothing', () => {
  it('comes back REVISE with a prompt that names the missing assertion', async () => {
    const report = await admit(
      input({ code: PLAUSIBLE_BUT_ASSERTS_NOTHING, toolchain: toolchain() }),
    );

    expect(report.verdict).toBe('REVISE');
    expect(statusOf(report, 'ASSERTIONS')).toBe('FAIL');
    expect(gateOf(report, 'ASSERTIONS').why).toMatch(/makes no assertion anywhere/i);

    const prompt = report.revisePrompt;
    expect(prompt).not.toBeNull();
    // It must read as instructions, not as a report: the model gets it verbatim.
    expect(prompt).toMatch(/Add assertions that prove the behaviour under test actually happened/);
    // It must name the approved assertion that is missing, in the plan's words.
    expect(prompt).toContain('The order total is $42.00');
    // And it must suggest the shape, in this file's own dialect.
    expect(prompt).toMatch(/toHaveText/);
    expect(prompt).toMatch(/Return the whole file, not a patch/);
  });

  it('admits the same journey once it actually asserts something', async () => {
    const report = await admit(input({ toolchain: toolchain() }));

    expect(report.verdict).toBe('ADMIT');
    expect(report.revisePrompt).toBeNull();
    expect(statusOf(report, 'ASSERTIONS')).toBe('PASS');
    expect(statusOf(report, 'FIDELITY')).toBe('PASS');
    expect(statusOf(report, 'LOCATORS')).toBe('PASS');
    expect(statusOf(report, 'NO_LOCK_IN')).toBe('PASS');
    expect(statusOf(report, 'NO_FIXED_SLEEP')).toBe('PASS');
    expect(statusOf(report, 'PATH_CONVENTION')).toBe('PASS');
  });
});

// ─── ASSERTIONS ──────────────────────────────────────────────────────────────

describe('ASSERTIONS', () => {
  it('passes a test with real assertions', async () => {
    const report = await admit(input());
    expect(statusOf(report, 'ASSERTIONS')).toBe('PASS');
    expect(gateOf(report, 'ASSERTIONS').why).toMatch(/2 assertion\(s\)/);
  });

  it('fails a test with none, and quotes the dialect it should have used', async () => {
    const report = await admit(input({ code: PLAUSIBLE_BUT_ASSERTS_NOTHING }));
    const gate = gateOf(report, 'ASSERTIONS');
    expect(gate.status).toBe('FAIL');
    expect(gate.detail.join(' ')).toMatch(/expect\(page\.getByRole/);
    expect(gate.line).not.toBeNull();
  });

  it('reports UNAVAILABLE — never FAIL — for a file whose dialect it cannot read', async () => {
    const report = await admit(
      input({
        code: UNKNOWN_DIALECT,
        filePath: 'tests/checkout/scenario.txt',
        language: null,
        ecosystemId: null,
      }),
    );
    const gate = gateOf(report, 'ASSERTIONS');
    expect(gate.status).toBe('UNAVAILABLE');
    expect(gate.why).toMatch(/no assertion dialect is known for a "\.txt" file/);
    // Rule 2: unchecked must be visible to the human, not just to the report.
    expect(report.reviewFlags.some((flag) => flag.includes('".txt" file'))).toBe(true);
  });

  it('does NOT accuse a pytest file of having no assertions', async () => {
    const report = await admit(
      input({
        code: PYTEST,
        filePath: 'tests/checkout/test_pay_with_a_saved_card.py',
        language: 'PYTHON',
        ecosystemId: 'PLAYWRIGHT_PYTHON',
      }),
    );
    const gate = gateOf(report, 'ASSERTIONS');
    expect(gate.status).toBe('PASS');
    expect(gate.why).toMatch(/2 pytest bare assert assertion\(s\)/);
    // Honesty: it says what it did NOT check rather than implying it checked.
    expect(gate.detail.join(' ')).toMatch(/Not checked: whether those assertions are strong/);
  });

  it('does NOT accuse a Go test of having no assertions', async () => {
    const report = await admit(
      input({
        code: GO_TEST,
        filePath: 'e2e/checkout/pay_with_a_saved_card_test.go',
        language: 'GO',
        ecosystemId: 'GO_TEST',
      }),
    );
    const gate = gateOf(report, 'ASSERTIONS');
    expect(gate.status).toBe('PASS');
    expect(gate.why).toMatch(/Go testing \/ testify assertion\(s\)/);
  });

  it('does not ask a plugin-asserted type to assert in its own file', async () => {
    const report = await admit(
      input({
        testType: 'ACCESSIBILITY',
        code: '// Accessibility tests are driven by `spec`, not source code.\n',
        filePath: 'specs/accessibility/checkout.a11y.json',
        item: { ...CHECKOUT_ITEM, testType: 'ACCESSIBILITY' },
        spec: { routes: ['/checkout'] },
      }),
    );
    const gate = gateOf(report, 'ASSERTIONS');
    expect(gate.status).toBe('PASS');
    expect(gate.why).toMatch(/does not author assertions/);
  });

  it('reads a spec-driven type’s assertions out of the spec, not the pointer file', async () => {
    const admitted = await admit(
      input({
        testType: 'API',
        code: '// API tests are driven by `spec`, not source code.\n',
        filePath: 'specs/api/create-an-order.json',
        item: { ...CHECKOUT_ITEM, testType: 'API' },
        spec: {
          steps: [
            { method: 'POST', path: '/orders', expectStatus: 201, bodyMatches: { total: '42.00' } },
          ],
        },
      }),
    );
    expect(statusOf(admitted, 'ASSERTIONS')).toBe('PASS');

    const statusOnly = await admit(
      input({
        testType: 'API',
        code: '// API tests are driven by `spec`, not source code.\n',
        filePath: 'specs/api/create-an-order.json',
        item: { ...CHECKOUT_ITEM, testType: 'API' },
        spec: { steps: [{ method: 'POST', path: '/orders', expectStatus: 201 }] },
      }),
    );
    const gate = gateOf(statusOnly, 'ASSERTIONS');
    expect(gate.status).toBe('FAIL');
    expect(gate.why).toMatch(/status code and nothing about the response body/);
  });

  it('warns rather than fails on a weak-but-present assertion', async () => {
    // An existence check on a locator that pins nothing: EXISTENCE_ONLY, MEDIUM.
    const code = `import { expect, test } from '@playwright/test';

test('pay for an order with a saved card', async ({ page }) => {
  await page.goto('/checkout');
  await page.getByLabel('Card number').fill('4242424242424242');
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByTestId('order-total')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
});
`;
    const report = await admit(input({ code }));
    const gate = gateOf(report, 'ASSERTIONS');
    expect(gate.status).toBe('WARN');
    expect(gate.detail.join(' ')).toMatch(/EXISTENCE_ONLY \(MEDIUM\)/);
    expect(report.verdict).toBe('ADMIT_WITH_FLAGS');
  });

  it('never reports NO_NEGATIVE_PATH, which is a judgement about a whole suite', async () => {
    const report = await admit(input());
    expect(gateOf(report, 'ASSERTIONS').detail.join(' ')).not.toMatch(/NO_NEGATIVE_PATH/);
  });
});

// ─── LOCATORS ────────────────────────────────────────────────────────────────

describe('LOCATORS', () => {
  it('passes a file that addresses everything by role, label and test id', async () => {
    const gate = gateOf(await admit(input()), 'LOCATORS');
    expect(gate.status).toBe('PASS');
    expect(gate.why).toMatch(/by role, label, text or test id/);
  });

  it('fails a file whose locators are mostly DOM shape, and names each one', async () => {
    const gate = gateOf(await admit(input({ code: BRITTLE_LOCATORS })), 'LOCATORS');
    expect(gate.status).toBe('FAIL');
    const detail = gate.detail.join('\n');
    expect(detail).toContain('div.sc-x7f2 > span:nth-child(3)');
    expect(detail).toMatch(/generated at build time/);
    expect(detail).toMatch(/selects by position among siblings/);
    expect(detail).toContain('.flex.items-center.gap-2 > button');
    expect(detail).toMatch(/styling utility classes/);
    expect(detail).toContain('//html/body/div[2]/main/section[1]/p');
    expect(detail).toMatch(/absolute XPath/);
    expect(gate.line).not.toBeNull();
  });

  it('warns rather than fails when one locator in a good file is brittle', async () => {
    const code = `import { expect, test } from '@playwright/test';

test('pay for an order with a saved card', async ({ page }) => {
  await page.goto('/checkout');
  await page.getByLabel('Card number').fill('4242424242424242');
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
  await expect(page.locator('tbody tr:nth-child(2) td')).toHaveText('$42.00');
});
`;
    const gate = gateOf(await admit(input({ code })), 'LOCATORS');
    expect(gate.status).toBe('WARN');
    expect(gate.detail.join('\n')).toContain('tbody tr:nth-child(2) td');
  });

  it('passes a test that selects nothing on a page, rather than failing it', async () => {
    const code = `import { expect, test } from 'vitest';
import { subtotal } from '../../src/cart';

test('subtotal sums the line items', () => {
  expect(subtotal([{ price: 2000 }, { price: 2200 }])).toBe(4200);
});
`;
    const gate = gateOf(
      await admit(
        input({
          code,
          testType: 'UNIT_GEN',
          filePath: 'tests/cart/subtotal.test.ts',
          ecosystemId: 'VITEST',
          item: { ...CHECKOUT_ITEM, testType: 'UNIT_GEN' },
        }),
      ),
      'LOCATORS',
    );
    expect(gate.status).toBe('PASS');
    expect(gate.why).toMatch(/addresses no page elements/);
  });

  // ── Counter-examples: the strings that must NOT be read as brittle locators ──

  it('does not read a route as an XPath', () => {
    expect(__internal.looksLikeSelector('/checkout')).toBe(false);
    expect(__internal.looksLikeSelector('/orders/42/confirmation')).toBe(true);
    expect(__internal.classifySelector('/orders/42/confirmation')).toContain('ABSOLUTE_XPATH');
  });

  it('does not read an ARIA role name as a CSS selector', () => {
    // `getByRole('button', …)` is the preferred locator; calling its first
    // argument a brittle element selector would condemn correct code.
    expect(__internal.looksLikeSelector('button')).toBe(false);
    expect(__internal.looksLikeSelector('heading')).toBe(false);
    expect(__internal.looksLikeSelector('div > span')).toBe(true);
  });

  it('does not read prose or test data as a selector', () => {
    for (const value of [
      'Card number',
      'Order confirmed',
      '$42.00',
      '4242424242424242',
      '@playwright/test',
      'https://app.example.com/login',
      'order-total',
    ]) {
      expect(__internal.looksLikeSelector(value), value).toBe(false);
    }
  });

  it('calls a single semantic class or test-id attribute resilient', () => {
    expect(__internal.classifySelector('.product-card')).toEqual([]);
    expect(__internal.classifySelector('[data-testid="order-total"]')).toEqual([]);
    expect(__internal.classifySelector('#order-total')).toEqual([]);
    expect(__internal.classifySelector('//*[@data-testid="order-total"]')).toEqual([]);
  });

  it('knows a generated class and a generated id from a written one', () => {
    expect(__internal.classifySelector('.css-1a2b3c')).toContain('GENERATED_CLASS');
    expect(__internal.classifySelector('.sc-x7f2')).toContain('GENERATED_CLASS');
    expect(__internal.classifySelector('.Button_root__1a2b3')).toContain('GENERATED_CLASS');
    expect(__internal.classifySelector('#:r3:')).toContain('GENERATED_ID');
    expect(__internal.classifySelector('#mui-1234')).toContain('GENERATED_ID');
    // …and leaves a hand-written one alone.
    expect(__internal.classifySelector('.order-summary')).toEqual([]);
    expect(__internal.classifySelector('#checkout-form')).toEqual([]);
  });

  it('knows a styling chain from a semantic one', () => {
    expect(__internal.looksLikeUtilityClass('px-4')).toBe(true);
    expect(__internal.looksLikeUtilityClass('items-center')).toBe(true);
    expect(__internal.looksLikeUtilityClass('md:flex')).toBe(true);
    expect(__internal.looksLikeUtilityClass('product-card')).toBe(false);
    expect(__internal.looksLikeUtilityClass('order-summary')).toBe(false);
    // One utility class is not a chain; two is.
    expect(__internal.classifySelector('.flex')).toEqual([]);
    expect(__internal.classifySelector('.flex.gap-2')).toContain('STYLING_CHAIN');
  });

  it('flags a chain deeper than the stated threshold and not one at it', () => {
    expect(__internal.classifySelector('main .cart .row')).toEqual([]);
    expect(__internal.classifySelector('main .cart .row .cell')).toContain('LONG_CHAIN');
  });
});

// ─── FIDELITY ────────────────────────────────────────────────────────────────

describe('FIDELITY', () => {
  it('passes when every approved assertion and step is traceable', async () => {
    const gate = gateOf(await admit(input()), 'FIDELITY');
    expect(gate.status).toBe('PASS');
    expect(gate.detail.join(' ')).toMatch(/2 of 2 approved assertion\(s\)/);
  });

  it('fails on plan drift — a plausible test for a different scenario', async () => {
    // Correct, well-written code. For the wrong plan item.
    const code = `import { expect, test } from '@playwright/test';

test('removes an item from the cart', async ({ page }) => {
  await page.goto('/cart');
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Your cart is empty')).toBeVisible();
});
`;
    const gate = gateOf(await admit(input({ code })), 'FIDELITY');
    expect(gate.status).toBe('FAIL');
    expect(gate.why).toMatch(/does not implement 2 of the 2 assertion\(s\) a human approved/);
    expect(gate.detail.join('\n')).toContain('The order total is $42.00');
    expect(gate.detail.join('\n')).toMatch(/missing: order, total, 42, 00/);
  });

  it('reports UNAVAILABLE for an edit or a heal, which has no plan item', async () => {
    const gate = gateOf(await admit(input({ item: null })), 'FIDELITY');
    expect(gate.status).toBe('UNAVAILABLE');
    expect(gate.why).toMatch(/no approved plan item to trace this code against/);
  });

  it('reports UNAVAILABLE rather than guessing when the dialect cannot be read', async () => {
    const report = await admit(
      input({
        code: UNKNOWN_DIALECT,
        filePath: 'tests/checkout/scenario.txt',
        language: null,
        ecosystemId: null,
      }),
    );
    const gate = gateOf(report, 'FIDELITY');
    expect(gate.status).toBe('UNAVAILABLE');
    expect(gate.why).toMatch(/would be a number with no meaning behind it/);
  });

  it('is not satisfied by a comment describing the assertion', async () => {
    // The whole reason comments are blanked and strings are kept: prose about
    // an assertion must not count as the assertion.
    const code = `import { test } from '@playwright/test';

test('pay for an order with a saved card', async ({ page }) => {
  // The order confirmation heading is shown and the order total is $42.00.
  await page.goto('/checkout');
  await page.getByLabel('Card number').fill('4242424242424242');
  await page.getByRole('button', { name: 'Pay now' }).click();
});
`;
    const gate = gateOf(await admit(input({ code })), 'FIDELITY');
    expect(gate.status).toBe('FAIL');
    expect(gate.detail.join('\n')).toContain('The order total is $42.00');
  });

  it('warns about a step it cannot trace while the assertions all hold', async () => {
    const item: PlanItem = {
      ...CHECKOUT_ITEM,
      steps: [...CHECKOUT_ITEM.steps, 'Apply the loyalty discount voucher'],
    };
    const gate = gateOf(await admit(input({ item })), 'FIDELITY');
    expect(gate.status).toBe('WARN');
    expect(gate.detail.join('\n')).toContain('Apply the loyalty discount voucher');
  });

  it('says an assertion is too vague to trace rather than blaming the code', async () => {
    const item: PlanItem = { ...CHECKOUT_ITEM, assertions: ['It works'] };
    const gate = gateOf(await admit(input({ item })), 'FIDELITY');
    expect(gate.status).toBe('WARN');
    expect(gate.detail.join('\n')).toMatch(/too vague to trace: "It works"/);
  });

  it('matches an inflection without matching a different word', () => {
    const haystack = new Set(__internal.tokensOf("expect(page.getByText('Order confirmed'))"));
    expect(__internal.tokenOverlap('order confirmation', haystack).matched).toEqual(['order']);
    expect(__internal.tokensOf('OrderConfirmation')).toEqual(['order', 'confirmation']);
  });
});

// ─── NO_LOCK_IN ──────────────────────────────────────────────────────────────

describe('NO_LOCK_IN', () => {
  it('passes a file that references nothing of ours', async () => {
    expect(statusOf(await admit(input()), 'NO_LOCK_IN')).toBe('PASS');
  });

  it('fails an import from @qaai, which cannot run in the customer repo', async () => {
    const code = GOOD_PLAYWRIGHT.replace(
      "import { expect, test } from '@playwright/test';",
      "import { expect, test } from '@playwright/test';\nimport { login } from '@qaai/helpers';",
    );
    const gate = gateOf(await admit(input({ code })), 'NO_LOCK_IN');
    expect(gate.status).toBe('FAIL');
    expect(gate.why).toMatch(/cannot run in the customer's repository/);
    expect(gate.line).toBe(2);
  });

  it('fails a bare qaai identifier in a language that imports without quotes', async () => {
    const code = PYTEST.replace(
      'from playwright.sync_api import Page, expect',
      'from playwright.sync_api import Page, expect\nfrom qaai.helpers import login',
    );
    const gate = gateOf(
      await admit(
        input({
          code,
          filePath: 'tests/checkout/test_pay_with_a_saved_card.py',
          language: 'PYTHON',
          ecosystemId: 'PLAYWRIGHT_PYTHON',
        }),
      ),
      'NO_LOCK_IN',
    );
    expect(gate.status).toBe('FAIL');
  });

  it('only warns when QAAI is test data rather than a dependency', async () => {
    // A test of QAAI's own cockpit navigates to a URL with "qaai" in it.
    // Refusing it would be this gate misfiring on the product it exists for.
    const code = GOOD_PLAYWRIGHT.replace(
      "await page.goto('/checkout');",
      "await page.goto('https://app.qaai.dev/checkout');",
    );
    const gate = gateOf(await admit(input({ code })), 'NO_LOCK_IN');
    expect(gate.status).toBe('WARN');
    expect(gate.why).toMatch(/named in a string/);
  });
});

// ─── NO_FIXED_SLEEP ──────────────────────────────────────────────────────────

describe('NO_FIXED_SLEEP', () => {
  it('passes a test that waits for conditions', async () => {
    expect(statusOf(await admit(input()), 'NO_FIXED_SLEEP')).toBe('PASS');
  });

  it('warns on a fixed sleep and reports the line', async () => {
    const code = GOOD_PLAYWRIGHT.replace(
      "await page.getByRole('button', { name: 'Pay now' }).click();",
      "await page.getByRole('button', { name: 'Pay now' }).click();\n  await page.waitForTimeout(3000);",
    );
    const gate = gateOf(await admit(input({ code })), 'NO_FIXED_SLEEP');
    expect(gate.status).toBe('WARN');
    expect(gate.line).toBe(7);
    expect(gate.detail.join('\n')).toContain('waitForTimeout(3000)');
  });

  it('catches the sleep spelling of a language that is not JavaScript', async () => {
    const code = PYTEST.replace(
      '    page.goto("/checkout")',
      '    page.goto("/checkout")\n    time.sleep(3)',
    );
    const gate = gateOf(
      await admit(
        input({
          code,
          filePath: 'tests/checkout/test_pay_with_a_saved_card.py',
          language: 'PYTHON',
          ecosystemId: 'PLAYWRIGHT_PYTHON',
        }),
      ),
      'NO_FIXED_SLEEP',
    );
    expect(gate.status).toBe('WARN');
  });

  it('does not mistake a commented-out sleep for a real one', async () => {
    const code = GOOD_PLAYWRIGHT.replace(
      "await page.goto('/checkout');",
      "// await page.waitForTimeout(3000);\n  await page.goto('/checkout');",
    );
    expect(statusOf(await admit(input({ code })), 'NO_FIXED_SLEEP')).toBe('PASS');
  });
});

// ─── PATH_CONVENTION ─────────────────────────────────────────────────────────

describe('PATH_CONVENTION', () => {
  it('passes a path the runner collects', async () => {
    const gate = gateOf(await admit(input()), 'PATH_CONVENTION');
    expect(gate.status).toBe('PASS');
    expect(gate.why).toMatch(/Playwright \(TypeScript\) collects/);
  });

  it('corrects a path the runner would never collect, and says so', async () => {
    const report = await admit(input({ filePath: 'tests/checkout/pay-with-a-saved-card.ts' }));
    const gate = gateOf(report, 'PATH_CONVENTION');
    expect(gate.status).toBe('WARN');
    expect(gate.why).toMatch(/a test at the original path would never have run/i);
    expect(report.correctedFilePath).toBe(
      'checkout/pay-for-an-order-with-a-saved-card.spec.ts',
    );
    // Also machine-readable for a caller coding against the agreed report shape.
    expect(gate.detail[0]).toBe(report.correctedFilePath);
    expect(report.verdict).toBe('ADMIT_WITH_FLAGS');
  });

  it('catches the silent-green case in a language where the suffix is load-bearing', async () => {
    const report = await admit(
      input({
        code: GO_TEST,
        filePath: 'e2e/checkout/order_total.go',
        language: 'GO',
        ecosystemId: 'GO_TEST',
        item: { ...CHECKOUT_ITEM, testType: 'E2E' },
      }),
    );
    const gate = gateOf(report, 'PATH_CONVENTION');
    expect(gate.status).toBe('WARN');
    expect(report.correctedFilePath).toMatch(/_test\.go$/);
  });

  it('does not invent a convention for a spec-driven type', async () => {
    const gate = gateOf(
      await admit(
        input({
          testType: 'API',
          code: '// API tests are driven by `spec`, not source code.\n',
          filePath: 'specs/api/create-an-order.json',
          item: { ...CHECKOUT_ITEM, testType: 'API' },
          spec: { steps: [{ assertions: { status: 201, bodyMatches: { total: '42.00' } } }] },
        }),
      ),
      'PATH_CONVENTION',
    );
    expect(gate.status).toBe('PASS');
    expect(gate.why).toMatch(/no file-naming convention applies/);
  });

  it('reports UNAVAILABLE when nothing says which runner collects this', async () => {
    const gate = gateOf(
      await admit(input({ language: null, ecosystemId: null, filePath: 'somewhere/odd.spec.ts' })),
      'PATH_CONVENTION',
    );
    expect(gate.status).toBe('UNAVAILABLE');
    expect(gate.why).toMatch(/neither a language nor a known runner was supplied/);
  });
});

// ─── DUPLICATE ───────────────────────────────────────────────────────────────

describe('DUPLICATE', () => {
  const existingOf = (code: string, over: Record<string, unknown> = {}) => [
    {
      id: 'test-existing',
      name: 'pay for an order with a saved card',
      filePath: 'tests/checkout/existing.spec.ts',
      code,
      type: 'E2E' as const,
      ...over,
    },
  ];

  it('reports UNAVAILABLE when no suite was supplied to compare against', async () => {
    const gate = gateOf(await admit(input()), 'DUPLICATE');
    expect(gate.status).toBe('UNAVAILABLE');
    expect(gate.why).toMatch(/no existing tests were supplied/);
    expect(gateOf(await admit(input()), 'DUPLICATE').status).toBe('UNAVAILABLE');
  });

  it('passes against a suite that covers something else', async () => {
    const other = `import { expect, test } from '@playwright/test';

test('removes an item from the cart', async ({ page }) => {
  await page.goto('/cart');
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Your cart is empty')).toBeVisible();
});
`;
    const gate = gateOf(await admit(input({ existing: existingOf(other) })), 'DUPLICATE');
    expect(gate.status).toBe('PASS');
  });

  it('REFUSES a test the suite already has, naming the test it duplicates', async () => {
    const report = await admit(input({ existing: existingOf(GOOD_PLAYWRIGHT) }));
    const gate = gateOf(report, 'DUPLICATE');
    expect(gate.status).toBe('FAIL');
    expect(gate.why).toMatch(/The suite already has this test/);
    expect(gate.detail.join('\n')).toContain('test-existing');
    expect(gate.detail.join('\n')).toMatch(/IDENTICAL/);
    // Re-prompting cannot fix "you already have this test", so there is nothing
    // to ask for — refused on the FIRST attempt, not the second.
    expect(report.verdict).toBe('REFUSE');
    expect(report.revisePrompt).toBeNull();
  });

  it('only warns when the overlapping test checks something different', async () => {
    // Same journey, one differing assertion. suite-health's own conclusion is
    // "keep both": a differing assertion is usually why the second test exists.
    const other = GOOD_PLAYWRIGHT.replace(
      "await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
      "await expect(page.getByTestId('order-reference')).toHaveText('ORD-1');",
    );
    const report = await admit(input({ existing: existingOf(other) }));
    const gate = gateOf(report, 'DUPLICATE');
    expect(gate.status).toBe('WARN');
    expect(gate.why).toMatch(/checks something they do not/);
    expect(report.verdict).toBe('ADMIT_WITH_FLAGS');
  });

  it('reports UNAVAILABLE when nothing in the suite could be read', async () => {
    const gate = gateOf(
      await admit(input({ existing: existingOf(null as unknown as string) })),
      'DUPLICATE',
    );
    expect(gate.status).toBe('UNAVAILABLE');
    expect(gate.why).toMatch(/none of the 1 existing test\(s\) could be read well enough/);
  });
});

// ─── MUTATION ────────────────────────────────────────────────────────────────

describe('MUTATION', () => {
  it('is always UNAVAILABLE, and is the one UNAVAILABLE kept out of the flags', async () => {
    const report = await admit(input({ toolchain: toolchain() }));
    const gate = gateOf(report, 'MUTATION');
    expect(gate.status).toBe('UNAVAILABLE');
    expect(gate.why).toMatch(/deliberately mutated build/);
    // A flag that appears on every test ever admitted is a flag nobody reads.
    expect(report.reviewFlags.join('\n')).not.toMatch(/mutated build/);
    expect(report.verdict).toBe('ADMIT');
  });

  /*
   * The asymmetry these four pin down is the whole point of the gate's input
   * seam. UNWIRED + UNAVAILABLE is noise on every test ever admitted, so it is
   * suppressed. WIRED + UNAVAILABLE is a fact about THIS test, so suppressing
   * it would make "admitted" quietly mean "unchecked".
   */
  it('flags UNAVAILABLE once a mutation gate IS wired in', async () => {
    const report = await admit(
      input({
        toolchain: toolchain(),
        mutation: async () => ({
          gate: 'MUTATION' as const,
          status: 'UNAVAILABLE' as const,
          why: 'No source file could be identified for this test, so there was nothing to mutate.',
          detail: [],
          line: null,
        }),
      }),
    );
    expect(gateOf(report, 'MUTATION').status).toBe('UNAVAILABLE');
    expect(report.reviewFlags.join('\n')).toMatch(/nothing to mutate/);
    expect(report.verdict).toBe('ADMIT');
  });

  it('admits with flags when the wired gate WARNs', async () => {
    const report = await admit(
      input({
        toolchain: toolchain(),
        mutation: async () => ({
          gate: 'MUTATION' as const,
          status: 'WARN' as const,
          why: 'It killed 1 of 3 mutants: the test still passes when the total is computed with - instead of +.',
          detail: ['survived: SWAP_ARITHMETIC at line 12'],
          line: 12,
        }),
      }),
    );
    expect(report.verdict).toBe('ADMIT_WITH_FLAGS');
    expect(report.reviewFlags.join('\n')).toMatch(/- instead of \+/);
  });

  it('revises when the wired gate FAILs on the first attempt', async () => {
    const report = await admit(
      input({
        attempt: 1,
        toolchain: toolchain(),
        mutation: async () => ({
          gate: 'MUTATION' as const,
          status: 'FAIL' as const,
          why: 'It killed none of 3 mutants: the behaviour it claims to test can be broken without it noticing.',
          detail: ['survived: NEGATE_CONDITIONAL at line 8'],
          line: 8,
        }),
      }),
    );
    expect(report.verdict).toBe('REVISE');
    expect(report.revisePrompt ?? '').toMatch(/NEGATE_CONDITIONAL|without it noticing/);
  });

  it('treats a gate that THREW as unavailable, never as a pass', async () => {
    const report = await admit(
      input({
        toolchain: toolchain(),
        mutation: async () => {
          throw new Error('the trial runner died');
        },
      }),
    );
    const gate = gateOf(report, 'MUTATION');
    expect(gate.status).toBe('UNAVAILABLE');
    expect(gate.why).toMatch(/the trial runner died/);
    expect(report.reviewFlags.join('\n')).toMatch(/the trial runner died/);
  });

  it('overwrites a mislabelled gate id so the verdict arithmetic cannot be fooled', async () => {
    const report = await admit(
      input({
        toolchain: toolchain(),
        mutation: async () => ({
          // Claims to be DUPLICATE, which would REFUSE immediately.
          gate: 'DUPLICATE' as const,
          status: 'FAIL' as const,
          why: 'mislabelled',
          detail: [],
          line: null,
        }),
      }),
    );
    expect(gateOf(report, 'MUTATION').status).toBe('FAIL');
    expect(gateOf(report, 'DUPLICATE').status).not.toBe('FAIL');
    expect(report.verdict).not.toBe('REFUSE');
  });
});

  it('does not call a test-id selector brittle just because a class rode along', () => {
    /*
     * `RESILIENT_ATTRIBUTE` existed in this file and was referenced by nothing,
     * so a selector that NAMES its element was judged only on its SHAPE. A gate
     * that flags `[data-testid="order-total"]` — the one attribute every
     * framework's docs tell people to add — gets switched off, and then it
     * protects nothing.
     */
    expect(__internal.classifySelector('div.sc-x7f2[data-testid="order-total"]')).toEqual([]);
    expect(__internal.classifySelector('[data-cy=total]')).toEqual([]);
    expect(__internal.classifySelector('//*[@data-testid="total"]')).toEqual([]);

    // The class alone, with nothing naming the element, is still brittle.
    expect(__internal.classifySelector('div.sc-x7f2 > span')).toContain('GENERATED_CLASS');

    /*
     * And POSITIONAL survives the rescue, because it is not a complaint about
     * shape: this names a KIND of element and then picks the third one, and
     * which one is third is exactly what a reorder changes.
     */
    expect(__internal.classifySelector('[data-testid="row"]:nth-child(3)')).toEqual(['POSITIONAL']);
  });

// ─── Unrevisable artefacts and spec fidelity ─────────────────────────────────

describe('an artefact nobody can revise', () => {
  it('refuses a hard failure at once instead of asking for a rewrite', async () => {
    const asksNothing = `test('loads', async ({ page }) => {\n  await page.goto('/checkout');\n});`;
    const revisable = await admit(input({ code: asksNothing, attempt: 1, toolchain: toolchain() }));
    expect(revisable.verdict).toBe('REVISE');

    // Same input, same attempt — but there is no model in the loop, so REVISE
    // is a verdict nobody could satisfy and the caller would loop on it.
    const fixed = await admit(
      input({ code: asksNothing, attempt: 1, revisable: false, toolchain: toolchain() }),
    );
    expect(fixed.verdict).toBe('REFUSE');
    expect(fixed.revisePrompt).toBeNull();
  });

  it('admits a soft failure with flags rather than leaving the suite empty', async () => {
    const brittle = `test('shows the total', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.locator('div.sc-x7f2 > span:nth-child(3)')).toHaveText('$42.00');
});`;
    const report = await admit(
      input({
        code: brittle,
        attempt: 1,
        revisable: false,
        toolchain: toolchain(),
        // A plan item this snippet genuinely implements, so LOCATORS is the
        // only thing failing — otherwise FIDELITY fails too and the hard
        // branch is what the verdict is testing, not the soft one.
        item: planItem({
          title: 'The checkout total is shown',
          steps: ['Open the checkout page'],
          assertions: ['The order total is $42.00'],
        }),
      }),
    );
    // A brittle selector in a deterministic scaffold is a template bug worth a
    // human's eye, not a reason to generate nothing at all.
    expect(report.verdict).toBe('ADMIT_WITH_FLAGS');
    expect(report.reviewFlags.length).toBeGreaterThan(0);
  });
});

describe('FIDELITY for a spec-driven type', () => {
  /*
   * Running the ordinary token-overlap trace over JSON.stringify(spec) FAILED
   * five of the six scaffoldable types, every time on a CORRECT spec — the
   * overlap it needs is English and a spec is thresholds and viewports. These
   * pin the replacement: a provable target mismatch fails, and agreement is
   * reported as unmeasured rather than as a pass it cannot justify.
   */
  it('fails a spec generated against a different route than the plan approved', async () => {
    const report = await admit(
      input({
        testType: 'VISUAL',
        filePath: 'visual/checkout-total.visual.json',
        code: '// The spec for this test lives in its spec file.',
        spec: { path: '/dashboard', fullPage: true, maxDiffRatio: 0.01 },
        item: planItem({
          title: 'The checkout page looks right',
          steps: ['Open /checkout'],
          assertions: ['The /checkout page matches its baseline'],
        }),
        toolchain: toolchain(),
      }),
    );
    const gate = gateOf(report, 'FIDELITY');
    expect(gate.status).toBe('FAIL');
    expect(gate.why).toMatch(/different part of the application/);
  });

  it('reports what it could not check when the routes agree', async () => {
    const report = await admit(
      input({
        testType: 'VISUAL',
        filePath: 'visual/checkout-total.visual.json',
        code: '// The spec for this test lives in its spec file.',
        spec: { path: '/checkout', fullPage: true, maxDiffRatio: 0.01 },
        item: planItem({
          title: 'The checkout page looks right',
          steps: ['Open /checkout'],
          assertions: ['The /checkout page matches its baseline'],
        }),
        toolchain: toolchain(),
      }),
    );
    const gate = gateOf(report, 'FIDELITY');
    expect(gate.status).toBe('UNAVAILABLE');
    expect(gate.detail.join(' ')).toMatch(/Checked: the spec targets \/checkout/);
    expect(gate.detail.join(' ')).toMatch(/Not checked/);
    // And it reaches a human, like every other unavailable gate.
    expect(report.reviewFlags.join('\n')).toMatch(/no field prose can live in/);
  });

  it('treats a parameterised route and a concrete one as the same route', async () => {
    const report = await admit(
      input({
        testType: 'ACCESSIBILITY',
        filePath: 'a11y/orders.a11y.json',
        code: '// The spec for this test lives in its spec file.',
        spec: { routes: ['/orders/:orderId'] },
        item: planItem({
          title: 'An order page is accessible',
          steps: ['Open /orders/42'],
          assertions: ['The /orders/42 page has no serious axe violations'],
        }),
        toolchain: toolchain(),
      }),
    );
    expect(gateOf(report, 'FIDELITY').status).toBe('UNAVAILABLE');
    expect(report.verdict).not.toBe('REFUSE');
  });
});

// ─── The injected toolchain ──────────────────────────────────────────────────

describe('the toolchain gates', () => {
  it('reports UNAVAILABLE — never PASS — when no toolchain is wired in', async () => {
    const report = await admit(input());
    for (const id of ['SYNTAX', 'TYPECHECK', 'FORMAT', 'LINT'] as const) {
      expect(statusOf(report, id), id).toBe('UNAVAILABLE');
      expect(report.reviewFlags.some((flag) => flag === gateOf(report, id).why), id).toBe(true);
    }
    // Unchecked is not a failure, but it is never silent.
    expect(report.verdict).toBe('ADMIT');
  });

  it('does not run the other three when the file does not parse', async () => {
    const calls: GateId[] = [];
    const report = await admit(
      input({
        toolchain: toolchain(
          { syntax: { ...outcome('SYNTAX', 'FAIL', 'Unexpected end of input'), line: 9 } },
          calls,
        ),
      }),
    );
    expect(calls).toEqual(['SYNTAX']);
    expect(statusOf(report, 'TYPECHECK')).toBe('UNAVAILABLE');
    expect(statusOf(report, 'FORMAT')).toBe('UNAVAILABLE');
    expect(statusOf(report, 'LINT')).toBe('UNAVAILABLE');
    expect(gateOf(report, 'LINT').why).toMatch(/Fix the syntax first/);
    // …but the pure gates still ran, so one revise prompt carries everything.
    expect(statusOf(report, 'ASSERTIONS')).toBe('PASS');
    expect(report.verdict).toBe('REVISE');
    expect(report.revisePrompt).toMatch(/Fix the syntax error so the file parses/);
  });

  it('runs the pure gates against the code the formatter rewrote', async () => {
    const report = await admit(
      input({
        code: PLAUSIBLE_BUT_ASSERTS_NOTHING,
        toolchain: toolchain({
          format: { ...outcome('FORMAT', 'PASS'), code: GOOD_PLAYWRIGHT },
        }),
      }),
    );
    expect(report.code).toBe(GOOD_PLAYWRIGHT);
    // The gate read the rewritten file, so its line numbers mean something.
    expect(statusOf(report, 'ASSERTIONS')).toBe('PASS');
    expect(report.verdict).toBe('ADMIT');
  });

  it('ignores a rewrite from a formatter that failed', async () => {
    const report = await admit(
      input({
        toolchain: toolchain({
          format: { ...outcome('FORMAT', 'FAIL', 'prettier could not parse'), code: 'garbage' },
        }),
      }),
    );
    expect(report.code).toBe(GOOD_PLAYWRIGHT);
  });

  it('survives an injected gate that throws, rather than taking admission down', async () => {
    const report = await admit(
      input({
        toolchain: {
          syntax: async () => {
            throw new Error('tsc is not installed');
          },
          typecheck: async () => outcome('TYPECHECK', 'PASS'),
          format: async () => {
            throw new Error('prettier exploded');
          },
          lint: async () => outcome('LINT', 'PASS'),
        },
      }),
    );
    expect(statusOf(report, 'SYNTAX')).toBe('UNAVAILABLE');
    expect(gateOf(report, 'SYNTAX').why).toMatch(/tsc is not installed/);
    expect(statusOf(report, 'FORMAT')).toBe('UNAVAILABLE');
    expect(gateOf(report, 'FORMAT').why).toMatch(/prettier exploded/);
    expect(report.verdict).toBe('ADMIT');
  });

  it('relabels a gate that mislabels itself, so the arithmetic cannot be fooled', async () => {
    const report = await admit(
      input({
        toolchain: toolchain({
          // An implementation that returns someone else's gate id would
          // otherwise land a LINT failure in the ASSERTIONS slot.
          lint: outcome('ASSERTIONS', 'FAIL', 'no-floating-promises'),
        }),
      }),
    );
    expect(statusOf(report, 'LINT')).toBe('FAIL');
    expect(statusOf(report, 'ASSERTIONS')).toBe('PASS');
  });
});

// ─── The verdict arithmetic ──────────────────────────────────────────────────

describe('the verdict table', () => {
  const allPass: GateOutcome[] = [
    outcome('SYNTAX', 'PASS'),
    outcome('ASSERTIONS', 'PASS'),
    outcome('FIDELITY', 'PASS'),
  ];
  const withFail = (gate: GateId): GateOutcome[] => [...allPass.slice(1), outcome(gate, 'FAIL')];

  const table: Array<{ gate: GateId; attempt: number; expected: string }> = [
    // Hard: not a test at all. One retry, then an honest refusal.
    { gate: 'SYNTAX', attempt: 1, expected: 'REVISE' },
    { gate: 'SYNTAX', attempt: 2, expected: 'REFUSE' },
    { gate: 'ASSERTIONS', attempt: 1, expected: 'REVISE' },
    { gate: 'ASSERTIONS', attempt: 2, expected: 'REFUSE' },
    { gate: 'FIDELITY', attempt: 1, expected: 'REVISE' },
    { gate: 'FIDELITY', attempt: 2, expected: 'REFUSE' },
    // Soft: real, mechanically fixable, and not worth a test that covers nothing.
    { gate: 'TYPECHECK', attempt: 1, expected: 'REVISE' },
    { gate: 'TYPECHECK', attempt: 2, expected: 'ADMIT_WITH_FLAGS' },
    { gate: 'LINT', attempt: 1, expected: 'REVISE' },
    { gate: 'LINT', attempt: 2, expected: 'ADMIT_WITH_FLAGS' },
    { gate: 'LOCATORS', attempt: 1, expected: 'REVISE' },
    { gate: 'LOCATORS', attempt: 2, expected: 'ADMIT_WITH_FLAGS' },
    { gate: 'NO_LOCK_IN', attempt: 1, expected: 'REVISE' },
    { gate: 'NO_LOCK_IN', attempt: 2, expected: 'ADMIT_WITH_FLAGS' },
    // Terminal: re-prompting cannot fix "you already have this test".
    { gate: 'DUPLICATE', attempt: 1, expected: 'REFUSE' },
    { gate: 'DUPLICATE', attempt: 2, expected: 'REFUSE' },
  ];

  for (const row of table) {
    it(`${row.gate} FAIL on attempt ${row.attempt} → ${row.expected}`, () => {
      expect(verdictFor(withFail(row.gate), row.attempt)).toBe(row.expected);
    });
  }

  it('refuses a duplicate even when a revisable failure is also present', () => {
    expect(
      verdictFor([outcome('ASSERTIONS', 'FAIL'), outcome('DUPLICATE', 'FAIL')], 1),
    ).toBe('REFUSE');
  });

  it('prefers the hard class when both a hard and a soft gate failed', () => {
    const gates = [outcome('FIDELITY', 'FAIL'), outcome('LOCATORS', 'FAIL')];
    expect(verdictFor(gates, 1)).toBe('REVISE');
    expect(verdictFor(gates, FINAL_ATTEMPT)).toBe('REFUSE');
  });

  it('admits with flags on a WARN and plainly on nothing', () => {
    expect(verdictFor(allPass, 1)).toBe('ADMIT');
    expect(verdictFor([...allPass, outcome('NO_FIXED_SLEEP', 'WARN')], 1)).toBe(
      'ADMIT_WITH_FLAGS',
    );
    expect(verdictFor([...allPass, outcome('PATH_CONVENTION', 'WARN')], 1)).toBe(
      'ADMIT_WITH_FLAGS',
    );
  });

  it('admits on UNAVAILABLE — but never silently', async () => {
    expect(verdictFor([...allPass, outcome('TYPECHECK', 'UNAVAILABLE')], 1)).toBe('ADMIT');

    const report = await admit(
      input({
        code: UNKNOWN_DIALECT,
        filePath: 'tests/checkout/scenario.txt',
        language: null,
        ecosystemId: null,
      }),
    );
    expect(report.verdict).toBe('ADMIT');
    // Every gate that could not run for THIS test reaches the human.
    for (const gate of report.gates) {
      if (gate.status !== 'UNAVAILABLE' || gate.gate === 'MUTATION') continue;
      expect(report.reviewFlags, gate.gate).toContain(gate.why);
    }
  });

  it('treats a FAIL on a gate nobody classified as soft rather than ignoring it', () => {
    // A gate added to GateId without a decision must not silently do nothing.
    expect(verdictFor([outcome('NO_FIXED_SLEEP', 'FAIL')], 1)).toBe('REVISE');
    expect(verdictFor([outcome('NO_FIXED_SLEEP', 'FAIL')], FINAL_ATTEMPT)).toBe(
      'ADMIT_WITH_FLAGS',
    );
  });

  it('says out loud when it admitted something that failed a check', async () => {
    const report = await admit(
      input({ code: BRITTLE_LOCATORS, attempt: FINAL_ATTEMPT, toolchain: toolchain() }),
    );
    expect(statusOf(report, 'LOCATORS')).toBe('FAIL');
    expect(report.verdict).toBe('ADMIT_WITH_FLAGS');
    expect(report.reviewFlags.join('\n')).toMatch(
      /Admitted despite failing a check, after 2 attempts/,
    );
  });

  it('turns the same brittle file back on the first attempt', async () => {
    const report = await admit(input({ code: BRITTLE_LOCATORS, toolchain: toolchain() }));
    expect(report.verdict).toBe('REVISE');
    expect(report.revisePrompt).toMatch(/Replace the locators listed below/);
    expect(report.revisePrompt).toContain('div.sc-x7f2 > span:nth-child(3)');
  });
});

// ─── The scanner this file had to copy ───────────────────────────────────────

describe('stripCommentsKeepStrings', () => {
  it('removes a comment and keeps the string a locator lives in', () => {
    const out = __internal.stripCommentsKeepStrings(
      `// getByText('gone')\nawait page.getByText('kept'); // trailing\n`,
      'JS_EXPECT',
    );
    expect(out).not.toContain('gone');
    expect(out).toContain("'kept'");
    expect(out).not.toContain('trailing');
    // Offsets and line count survive, so reported line numbers still line up.
    expect(out.split('\n').length).toBe(3);
  });

  it('does not treat a comment marker inside a string as a comment', () => {
    const out = __internal.stripCommentsKeepStrings(
      `await page.goto('https://example.com/a'); const x = 1;\n`,
      'JS_EXPECT',
    );
    expect(out).toContain('const x = 1');
  });

  it('uses the language’s own comment syntax', () => {
    const out = __internal.stripCommentsKeepStrings('# gone\nassert total == "kept"\n', 'PY_ASSERT');
    expect(out).not.toContain('gone');
    expect(out).toContain('"kept"');
  });

  it('returns the code untouched when the dialect is unknown', () => {
    expect(__internal.stripCommentsKeepStrings('# kept\n', null)).toBe('# kept\n');
  });
});
