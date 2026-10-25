/**
 * Tests for the deflaker.
 *
 * The dangerous failure here is not "no fix proposed" — that is an honest
 * outcome and half this file asserts it happens loudly. The dangerous failure is
 * a patch that makes a test pass by testing less, because that is invisible: the
 * board goes green, the review queue empties, and the suite has quietly stopped
 * asserting something. So every case below is either
 *
 *   (a) a deterministic fix that must be produced with no model call, or
 *   (b) a repair that must be DESCRIBED and not applied, or
 *   (c) an attempt to get this module to weaken an assertion, which must fail.
 */

import { describe, expect, it } from 'vitest';
import { applyHealDiff } from './heal-apply.js';
import { DEFLAKE_CONFIDENCE, elementExpressionOf, proposeDeflake } from './deflake.js';

const FILE = 'tests/checkout.spec.ts';

const lines = (...rows: string[]): string => rows.join('\n');

const propose = (code: string, over: Partial<Parameters<typeof proposeDeflake>[0]> = {}) =>
  proposeDeflake({ testName: 'checkout completes', filePath: FILE, code, ...over });

describe('the model-free half: a fixed sleep is a deterministic fix', () => {
  it('replaces a sleep with a wait on the element the next line touches', () => {
    const code = lines(
      "import { test, expect } from '@playwright/test';",
      '',
      "test('checkout completes', async ({ page }) => {",
      "  await page.goto('/checkout');",
      '  await page.waitForTimeout(500);',
      "  await page.getByRole('button', { name: 'Pay' }).click();",
      "  await expect(page.getByTestId('receipt')).toHaveText('Paid');",
      '});',
      '',
    );

    const proposal = propose(code);
    expect(proposal.fixable).toBe(true);
    expect(proposal.confidence).toBe(DEFLAKE_CONFIDENCE.RETARGETED_SLEEP);

    // The patch is the product, so the patch is what gets asserted — applied
    // through the same applier the approval route uses.
    const applied = applyHealDiff(code, proposal.diff, { filePath: FILE });
    expect(applied.ok).toBe(true);
    expect(applied.code).not.toContain('waitForTimeout');
    expect(applied.code).toContain(
      "await expect(page.getByRole('button', { name: 'Pay' })).toBeVisible();",
    );
    // The original assertion is untouched: a deflake adds waits, it does not
    // trade an assertion for one.
    expect(applied.code).toContain("await expect(page.getByTestId('receipt')).toHaveText('Paid');");
    expect(proposal.assertionsAfter!).toBeGreaterThan(proposal.assertionsBefore!);
  });

  it('just deletes a sleep that sits in front of a web-first assertion', () => {
    const code = lines(
      "import { test, expect } from '@playwright/test';",
      '',
      "test('receipt appears', async ({ page }) => {",
      "  await page.goto('/checkout');",
      '  await page.waitForTimeout(2000);',
      "  await expect(page.getByTestId('receipt')).toBeVisible();",
      '});',
      '',
    );

    const proposal = propose(code);
    expect(proposal.fixable).toBe(true);
    expect(proposal.confidence).toBe(DEFLAKE_CONFIDENCE.REDUNDANT_SLEEP);
    expect(proposal.findings[0]!.repair).toMatch(/already polls/);

    const applied = applyHealDiff(code, proposal.diff, { filePath: FILE });
    expect(applied.code).not.toContain('waitForTimeout');
    // Nothing was added: the assertion was already the wait.
    expect(proposal.assertionsAfter).toBe(proposal.assertionsBefore);
  });

  it('uses locator.waitFor when the file has no expect in scope, so the patch still parses', () => {
    const code = lines(
      "import { test } from '@playwright/test';",
      '',
      "test('nav works', async ({ page }) => {",
      "  await page.goto('/');",
      '  await page.waitForTimeout(300);',
      "  await page.getByRole('link', { name: 'Orders' }).click();",
      '});',
      '',
    );

    const proposal = propose(code);
    expect(proposal.fixable).toBe(true);
    const applied = applyHealDiff(code, proposal.diff, { filePath: FILE });
    expect(applied.code).toContain(
      "await page.getByRole('link', { name: 'Orders' }).waitFor({ state: 'visible' });",
    );
    // An `expect` this file does not import would not parse, and the post-heal
    // SYNTAX gate is the one gate that refuses a heal outright.
    expect(applied.code).not.toContain('expect(');
  });

  it('adds a missing await, which is a race by construction', () => {
    const code = lines(
      "import { test, expect } from '@playwright/test';",
      '',
      "test('search', async ({ page }) => {",
      "  await page.goto('/');",
      "  page.getByPlaceholder('Search').fill('shoes');",
      "  await expect(page.getByTestId('results')).toHaveCount(3);",
      '});',
      '',
    );

    const proposal = propose(code);
    expect(proposal.fixable).toBe(true);
    expect(proposal.findings[0]!.kind).toBe('UNAWAITED_ACTION');
    const applied = applyHealDiff(code, proposal.diff, { filePath: FILE });
    expect(applied.code).toContain("  await page.getByPlaceholder('Search').fill('shoes');");
  });

  it('reports the lowest confidence of the fixes it applied, not the best', () => {
    const code = lines(
      "import { test, expect } from '@playwright/test';",
      '',
      "test('two problems', async ({ page }) => {",
      "  await page.goto('/checkout');",
      '  await page.waitForTimeout(500);',
      "  await page.getByRole('button', { name: 'Pay' }).click();",
      "  page.getByPlaceholder('Note').fill('hi');",
      "  await expect(page.getByTestId('receipt')).toBeVisible();",
      '});',
      '',
    );

    const proposal = propose(code);
    expect(proposal.fixable).toBe(true);
    // A patch is approved as a whole, so it is described by its weakest part.
    expect(proposal.confidence).toBe(
      Math.min(DEFLAKE_CONFIDENCE.RETARGETED_SLEEP, DEFLAKE_CONFIDENCE.MISSING_AWAIT),
    );
  });
});

describe('what it refuses to do', () => {
  it('will not rewrite an eager read into a web-first assertion, and says why', () => {
    const code = lines(
      "import { test, expect } from '@playwright/test';",
      '',
      "test('total', async ({ page }) => {",
      "  await page.goto('/checkout');",
      "  const total = await page.getByTestId('total').textContent();",
      "  expect(total).toBe('$42.00');",
      '});',
      '',
    );

    const proposal = propose(code);
    expect(proposal.fixable).toBe(false);
    expect(proposal.diff).toBe('');
    const finding = proposal.findings.find((f) => f.kind === 'EAGER_READ_ASSERTION');
    expect(finding).toBeDefined();
    expect(finding!.patched).toBe(false);
    // The reason is the whole point: the substitution would change what is
    // asserted, and loosening an assertion to stabilise a test is refused.
    expect(finding!.repair).toMatch(/normalises whitespace/);
    expect(proposal.recommendations.join(' ')).toMatch(/retries/);
  });

  it('names a shared fixture as the cause when the failure says it already exists', () => {
    const code = lines(
      "import { test, expect } from '@playwright/test';",
      '',
      "test('sign up', async ({ page }) => {",
      "  await page.goto('/signup');",
      "  await page.getByLabel('Email').fill('user@example.com');",
      "  await page.getByRole('button', { name: 'Create' }).click();",
      "  await expect(page.getByTestId('welcome')).toBeVisible();",
      '});',
      '',
    );

    const proposal = propose(code, {
      evidence: { failureMessage: 'Error: that email is already registered' },
    });
    const finding = proposal.findings.find((f) => f.kind === 'SHARED_FIXTURE');
    expect(finding).toBeDefined();
    expect(finding!.why).toMatch(/collides with its own previous run/);
    expect(finding!.patched).toBe(false);
    expect(proposal.fixable).toBe(false);
  });

  it('names randomness as unreproducible rather than patching a seed in', () => {
    const code = lines(
      "import { test, expect } from '@playwright/test';",
      '',
      "test('note', async ({ page }) => {",
      "  await page.goto('/notes');",
      '  const body = `note-${Math.random()}`;',
      "  await page.getByLabel('Body').fill(body);",
      "  await expect(page.getByTestId('saved')).toBeVisible();",
      '});',
      '',
    );

    const proposal = propose(code);
    const finding = proposal.findings.find((f) => f.kind === 'NONDETERMINISTIC_DATA');
    expect(finding).toBeDefined();
    expect(finding!.repair).toMatch(/Seed it/);
    expect(proposal.fixable).toBe(false);
  });

  it('detects a sleep in a language it cannot rewrite, and refuses to emit a patch', () => {
    const code = lines(
      'def test_checkout(page):',
      '    page.goto("/checkout")',
      '    time.sleep(0.5)',
      '    page.get_by_role("button", name="Pay").click()',
      '    expect(page.get_by_test_id("receipt")).to_be_visible()',
      '',
    );

    const proposal = proposeDeflake({
      testName: 'checkout',
      filePath: 'tests/test_checkout.py',
      code,
    });
    expect(proposal.findings.map((f) => f.kind)).toContain('FIXED_SLEEP');
    expect(proposal.fixable).toBe(false);
    expect(proposal.diff).toBe('');
    expect(String(proposal.unfixableReason)).toMatch(/only rewrites Playwright/);
  });

  it('refuses to touch a Cypress spec, where awaiting a command is actively wrong', () => {
    const code = lines(
      "describe('checkout', () => {",
      "  it('pays', () => {",
      "    cy.visit('/checkout');",
      '    cy.wait(500);',
      "    cy.contains('Pay').click();",
      "    cy.get('[data-testid=receipt]').should('be.visible');",
      '  });',
      '});',
      '',
    );

    const proposal = proposeDeflake({
      testName: 'pays',
      filePath: 'cypress/e2e/checkout.cy.js',
      code,
      ecosystemId: 'cypress',
    });
    expect(proposal.findings.map((f) => f.kind)).toContain('FIXED_SLEEP');
    expect(proposal.fixable).toBe(false);
    expect(proposal.findings[0]!.repair).toMatch(/queued rather than awaited/);
  });

  it('says nothing was scanned when the source could not be read reliably', () => {
    // An unterminated template literal: comment stripping ends inside a string,
    // so every absence-based claim about this file is worthless.
    const code = lines(
      "import { test } from '@playwright/test';",
      "test('broken', async ({ page }) => {",
      '  const x = `unterminated',
      '  await page.waitForTimeout(500);',
      '});',
    );

    const proposal = propose(code);
    expect(proposal.fixable).toBe(false);
    expect(String(proposal.unfixableReason)).toMatch(/not a clean bill of health/);
  });

  it('reports no findings as a measurement gap, never as a clean bill of health', () => {
    const code = lines(
      "import { test, expect } from '@playwright/test';",
      '',
      "test('clean', async ({ page }) => {",
      "  await page.goto('/checkout');",
      "  await expect(page.getByTestId('total')).toHaveText('$42.00');",
      '});',
      '',
    );

    const proposal = propose(code, { evidence: { measured: { failed: 4, of: 10 } } });
    expect(proposal.fixable).toBe(false);
    expect(proposal.findings).toEqual([]);
    expect(proposal.explanation).toContain('failed 4 of 10');
    expect(proposal.explanation).toMatch(/no fix to propose and is saying so/);
    expect(String(proposal.unfixableReason)).toMatch(/somewhere QAAI cannot see/);
    /*
     * There is no fix, so there is nothing to be confident IN. A non-zero
     * confidence beside an empty diff is a number a review screen will render
     * as "QAAI is 80% sure" about a proposal that proposes nothing — and no
     * assertion anywhere pinned it, so moving it broke nothing.
     */
    expect(proposal.confidence).toBe(0);
    expect(proposal.diff).toBe('');
    // STRUCTURAL on every path, including this one: the unattended lane is
    // gated on SELECTOR_ONLY and a deflake is never that.
    expect(proposal.riskLevel).toBe('STRUCTURAL');
  });
});

describe('the never-weaken rule, as arithmetic', () => {
  it('refuses its own patch when the rewrite would delete an assertion', () => {
    /*
     * A real way for this to happen, not a contrived one: the sleep detector is
     * a line scanner over source with STRINGS PRESERVED (it has to be — a sleep
     * is a function call with a literal in it), so an assertion about the words
     * "sleep 5" matches `/\bsleep\s*[( ]\s*\d/`. The redundant-sleep branch
     * would then delete a line carrying an assertion, which is precisely the one
     * thing this product must never do to a customer's test.
     *
     * The self-check catches it, the patch is thrown away, and the reason is
     * recorded — rather than the suite quietly asserting one thing less.
     */
    const code = lines(
      "import { test, expect } from '@playwright/test';",
      '',
      "test('timer copy', async ({ page }) => {",
      "  await page.goto('/timer');",
      "  await expect(page.getByText('sleep 5 minutes')).toBeVisible();",
      "  await expect(page.getByTestId('timer')).toBeVisible();",
      '});',
      '',
    );

    const proposal = propose(code);
    expect(proposal.fixable).toBe(false);
    expect(proposal.diff).toBe('');
    expect(String(proposal.unfixableReason)).toMatch(/would remove 1 assertion/);
    expect(String(proposal.unfixableReason)).toMatch(/will not make/);
    // The findings survive, demoted to unpatched: they are still what the
    // scanner saw, and a reader deserves to know the scanner fired.
    expect(proposal.findings.every((finding) => !finding.patched)).toBe(true);
    expect(proposal.explanation).toMatch(/REFUSED ITS OWN FIX/);
  });


  it('reports NULL assertion counts when there is no dialect to count in, never 0', () => {
    /*
     * THE LIE THIS CATCHES: `assertionsBefore: dialect ? countAssertions(…) :
     * null` reading `: 0` instead. Nothing fails, nothing throws, and the field
     * that decides whether a deflake weakened a test now says "this test
     * asserted nothing" about a file nobody could count — which, next to an
     * `assertionsAfter` of 0, reads as a comparison that was made and came out
     * even. A survived mutation here is the difference between "we could not
     * check" and "we checked and it is fine".
     *
     * An unknown file extension and no ecosystem id is the real way to get
     * here: `resolveDialect` has a lexicon for seventeen of them and null for
     * everything else, and the findings are still reported — the sleep scanner
     * is multilingual — so this is a case with real output and no counts.
     */
    const code = lines(
      'test checkout:',
      '    visit "/checkout"',
      '    sleep 5',
      '    click "Pay"',
      '    assert visible "receipt"',
      '',
    );

    const proposal = proposeDeflake({
      testName: 'checkout',
      filePath: 'tests/checkout.qatest',
      code,
    });

    expect(proposal.dialect).toBeNull();
    // The scan still happened and still found something.
    expect(proposal.findings.map((f) => f.kind)).toContain('FIXED_SLEEP');
    expect(proposal.fixable).toBe(false);
    // The two that matter. `toBeNull` rather than `toBeFalsy`: 0 is falsy and 0
    // is the lie.
    expect(proposal.assertionsBefore).toBeNull();
    expect(proposal.assertionsAfter).toBeNull();
  });

  it('counts assertions in the test’s own dialect and reports both numbers', () => {
    const code = lines(
      "import { test, expect } from '@playwright/test';",
      '',
      "test('two assertions', async ({ page }) => {",
      "  await page.goto('/checkout');",
      '  await page.waitForTimeout(500);',
      "  await page.getByRole('button', { name: 'Pay' }).click();",
      "  await expect(page.getByTestId('receipt')).toBeVisible();",
      "  await expect(page.getByTestId('total')).toHaveText('$42.00');",
      '});',
      '',
    );

    const proposal = propose(code);
    expect(proposal.assertionsBefore).toBe(2);
    expect(proposal.assertionsAfter).toBe(3); // the added web-first wait
    expect(proposal.explanation).toContain('No assertion was removed or loosened');
  });

  it('never proposes a risk level an unattended path would accept', () => {
    const code = lines(
      "import { test, expect } from '@playwright/test';",
      "test('x', async ({ page }) => {",
      "  await page.goto('/');",
      '  await page.waitForTimeout(500);',
      "  await page.getByRole('button', { name: 'Go' }).click();",
      "  await expect(page.getByTestId('done')).toBeVisible();",
      '});',
      '',
    );
    // SELECTOR_ONLY is the only level `isAutoApprovable` will pass, and a
    // deflake rewrites how a test waits — a bigger claim than a rename.
    expect(propose(code).riskLevel).toBe('STRUCTURAL');
  });
});

describe('elementExpressionOf', () => {
  it('reads the receiver of an action, including modifiers', () => {
    expect(
      elementExpressionOf("await page.getByRole('row').nth(2).getByRole('button').click();"),
    ).toBe("page.getByRole('row').nth(2).getByRole('button')");
  });

  it('refuses an expression that names no element', () => {
    expect(elementExpressionOf('await submitButton.click();')).toBeNull();
    expect(elementExpressionOf('await page.keyboard.press("Enter");')).toBeNull();
  });

  it('refuses a statement that also assigns, so a half-read locator is never used', () => {
    expect(elementExpressionOf("const x = page.locator('#a').click();")).toBeNull();
  });

  it('refuses an unbalanced expression rather than guessing where it ends', () => {
    expect(elementExpressionOf("await page.getByRole('button', { name: 'Pay' .click();")).toBeNull();
  });
});
