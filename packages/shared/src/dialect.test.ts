/**
 * Dialect tests — written around the failure that is expensive, not the one
 * that is obvious.
 *
 * The obvious failure is a MISSED assertion: a pattern too narrow, so a correct
 * pytest test is reported as asserting nothing. That one is loud, a customer
 * complains, and it gets fixed.
 *
 * The expensive failure is a SPURIOUS one, and it is silent. `heal-apply` and
 * `inline-edit` compare the assertion count before an edit with the count
 * after, and refuse the edit if it dropped. A pattern that matches something
 * which is not an assertion — a helper DEFINITION named `assertEquals`, a local
 * called `assert_count`, a commented-out `expect()`, the string
 * `getByText('expect(this)')` — hands a model a way to keep that number level
 * while deleting the only assertion in the file. So for all sixteen dialects
 * the table below carries a `silent` snippet that navigates, types, clicks and
 * logs, and whose expected count is 0. Those are the cases that earn their
 * keep; the positives mostly guard against a future "tightening".
 *
 * The other load-bearing case is `resolveDialect` returning **null**. Null
 * means "I cannot read this file", never "this file asserts nothing" — every
 * caller branches on it, so the precedence and the null cases are pinned here
 * rather than left to the callers' own tests.
 */

import { describe, expect, it } from 'vitest';
import {
  DIALECT_IDS,
  assertionExampleFor,
  blankStringsAndComments,
  countAssertions,
  dialect,
  findAssertions,
  findTestBlocks,
  hasAnyAssertion,
  resolveDialect,
  type DialectId,
} from './dialect';

// ─── Fixtures: the same checkout test, sixteen times ─────────────────────────

/*
 * Every snippet is the SAME scenario — pay for a cart, check the confirmation
 * and the total — so a reader can see what each dialect's assertion looks like
 * side by side, and so the `silent` variant is a plausible edit of the
 * asserting one rather than a contrived blank.
 *
 * Both tables are `Record<DialectId, string>`: adding a seventeenth dialect
 * without writing it a positive AND a negative case is a compile error, not a
 * silently uncovered dialect.
 */

/** Exactly two assertion lines each. An exact count catches an over-wide pattern. */
const ASSERTING: Record<DialectId, string> = {
  JS_EXPECT: `await expect(page.getByRole('heading')).toHaveText('Order confirmed');
await expect(page.getByTestId('order-total')).toHaveText('$42.00');`,
  JS_CHAI: `cy.get('[data-cy=total]').should('have.text', '$42.00');
cy.contains('Order confirmed');`,
  PY_ASSERT: `assert order.total == Decimal("42.00")
expect(page.get_by_role("heading")).to_have_text("Order confirmed")`,
  PY_UNITTEST: `        self.assertEqual(response.status_code, 200)
        self.assertIn("Order confirmed", response.content.decode())`,
  ROBOT: `    Page Should Contain Element    css=[data-test="confirmation"]
    Should Be Equal    \${total}    $42.00`,
  JVM: `        assertThat(page.getByTestId("total")).hasText("$42.00");
        assertEquals("Order confirmed", heading.textContent());`,
  DOTNET: `        Assert.Equal("$42.00", total);
        heading.Should().Be("Order confirmed");`,
  RUBY_RSPEC: `    expect(page).to have_text("Order confirmed")
    expect(page.find("[data-test=total]").text).to eq("$42.00")`,
  RUBY_MINITEST: `    assert_equal "$42.00", total_field.value
    refute_nil order.paid_at`,
  GO_TESTING: `	if got != "$42.00" {
		t.Fatalf("order total = %q, want $42.00", got)
	}
	require.Equal(t, "Order confirmed", heading)`,
  PHP_PHPUNIT: `        $this->assertSelectorTextContains(".total", "$42.00");
        self::assertSame("Order confirmed", $heading);`,
  PHP_CODECEPT: `        $I->see("Order confirmed", "h1");
        $I->dontSeeInField("coupon", "EXPIRED");`,
  GHERKIN: `  Scenario: a customer pays
    Given a cart with one item
    When I submit the payment form
    Then the confirmation heading says "Order confirmed"
    And the receipt shows a total of "$42.00"`,
  RUST: `    assert_eq!(order.total, "$42.00");
    assert!(order.paid_at.is_some());`,
  SWIFT: `        XCTAssertEqual(totalLabel.label, "$42.00")
        XCTAssertTrue(app.staticTexts["Order confirmed"].exists)`,
  ELIXIR: `    assert html =~ "Order confirmed"
    refute html =~ "Payment failed"`,
};

/**
 * Drives the app and proves nothing. Navigating, typing, clicking and logging
 * are not assertions in any of these dialects, and a pattern that counts one of
 * them is a pattern a model can pad the count with.
 */
const SILENT: Record<DialectId, string> = {
  JS_EXPECT: `await page.goto('/checkout');
await page.getByLabel('Card number').fill('4242424242424242');
await page.getByRole('button', { name: 'Pay now' }).click();
console.log('submitted the payment form');`,
  JS_CHAI: `cy.visit('/checkout');
cy.get('[data-cy=card]').type('4242424242424242');
cy.get('[data-cy=pay]').click();
cy.log('submitted the payment form');`,
  PY_ASSERT: `page.goto("/checkout")
page.get_by_label("Card number").fill("4242424242424242")
page.get_by_role("button", name="Pay now").click()
print("submitted the payment form")`,
  PY_UNITTEST: `        self.client.get("/checkout")
        self.driver.find_element(By.ID, "pay").click()
        print(self.driver.title)`,
  ROBOT: `    Open Browser    \${URL}/checkout    chromium
    Input Text      id=card    4242424242424242
    Click Button    id=pay
    Log             submitted the payment form`,
  JVM: `        page.navigate("/checkout");
        page.getByLabel("Card number").fill("4242424242424242");
        page.getByRole(AriaRole.BUTTON).click();
        System.out.println("submitted the payment form");`,
  DOTNET: `        await page.GotoAsync("/checkout");
        await page.GetByLabel("Card number").FillAsync("4242424242424242");
        await page.GetByRole(AriaRole.Button).ClickAsync();
        Console.WriteLine("submitted the payment form");`,
  RUBY_RSPEC: `    visit "/checkout"
    fill_in "Card number", with: "4242424242424242"
    click_button "Pay now"
    puts page.current_path`,
  RUBY_MINITEST: `    visit "/checkout"
    fill_in "Card number", with: "4242424242424242"
    click_button "Pay now"
    puts page.current_path`,
  GO_TESTING: `	if _, err := page.Goto("/checkout"); err != nil {
		t.Log("could not reach the checkout page")
	}
	page.GetByLabel("Card number").Fill("4242424242424242")
	page.GetByRole("button").Click()`,
  PHP_PHPUNIT: `        $client = static::createClient();
        $client->request("GET", "/checkout");
        $client->submitForm("Pay now", ["card" => "4242424242424242"]);`,
  PHP_CODECEPT: `        $I->amOnPage("/checkout");
        $I->fillField("Card number", "4242424242424242");
        $I->click("Pay now");`,
  GHERKIN: `  Scenario: a customer opens the checkout page
    Given a cart with one item
    When I open the checkout page
    And I fill in the card number
    * I submit the form`,
  RUST: `    let page = browser.new_page().await?;
    page.goto("/checkout").await?;
    page.click("#pay").await?;
    println!("submitted the payment form");`,
  SWIFT: `        app.launch()
        app.textFields["Card number"].typeText("4242424242424242")
        app.buttons["Pay now"].tap()`,
  ELIXIR: `    {:ok, view, _html} = live(conn, "/checkout")
    view |> element("#card") |> render_change(%{card: "4242424242424242"})
    view |> element("#pay") |> render_click()`,
};

/** One test-case declaration per dialect, with the name the syntax carries. */
const DECLARING: Record<DialectId, { code: string; blocks: number; name: string | null }> = {
  JS_EXPECT: {
    code: `test('checkout charges the right total', async ({ page }) => {`,
    blocks: 1,
    name: 'checkout charges the right total',
  },
  JS_CHAI: { code: `  it('shows the order total', () => {`, blocks: 1, name: 'shows the order total' },
  PY_ASSERT: { code: `def test_total_is_shown(page):`, blocks: 1, name: 'test_total_is_shown' },
  PY_UNITTEST: {
    code: `    def test_total_is_shown(self):`,
    blocks: 1,
    name: 'test_total_is_shown',
  },
  ROBOT: {
    code: `*** Test Cases ***
Checkout charges the right total
    Page Should Contain    Order confirmed`,
    blocks: 1,
    name: 'Checkout charges the right total',
  },
  // A JUnit test's name is on the next line and the annotation is the anchor,
  // so `name` is honestly null rather than guessed from the following line.
  JVM: { code: `    @Test\n    void totalIsShown() {`, blocks: 1, name: null },
  DOTNET: {
    code: `    public async Task TotalIsShownTest()`,
    blocks: 1,
    name: 'TotalIsShownTest',
  },
  RUBY_RSPEC: { code: `  it "shows the order total" do`, blocks: 1, name: 'shows the order total' },
  RUBY_MINITEST: {
    code: `  test "shows the order total" do`,
    blocks: 1,
    name: 'shows the order total',
  },
  GO_TESTING: {
    code: `func TestTotalIsShown(t *testing.T) {`,
    blocks: 1,
    name: 'TestTotalIsShown',
  },
  // `#[Test]` is a PHP 8 attribute, not a comment. See the blanking tests.
  PHP_PHPUNIT: { code: `    #[Test]`, blocks: 1, name: null },
  PHP_CODECEPT: {
    code: `    public function totalIsShown(AcceptanceTester $I)`,
    blocks: 1,
    name: 'totalIsShown',
  },
  GHERKIN: { code: `  Scenario: a customer pays`, blocks: 1, name: 'a customer pays' },
  RUST: { code: `    #[test]\n    fn total_is_shown() {`, blocks: 1, name: null },
  SWIFT: { code: `    func testTotalIsShown() {`, blocks: 1, name: 'testTotalIsShown' },
  ELIXIR: { code: `  test "shows the order total" do`, blocks: 1, name: 'shows the order total' },
};

// ─── Every dialect, both ways ────────────────────────────────────────────────

describe.each(DIALECT_IDS)('%s', (id) => {
  it('counts the assertions in a test that asserts', () => {
    const hits = findAssertions(ASSERTING[id], id);

    expect(hits).toHaveLength(2);
    expect(countAssertions(ASSERTING[id], id)).toBe(2);
    expect(hasAnyAssertion(ASSERTING[id], id)).toBe(true);
    // Every hit names the pattern that matched, so a false positive can be
    // traced to one line of the record instead of bisected.
    for (const hit of hits) expect(hit.pattern.length).toBeGreaterThan(0);
  });

  it('counts zero in a test that navigates, types and clicks but asserts nothing', () => {
    expect(findAssertions(SILENT[id], id)).toEqual([]);
    expect(countAssertions(SILENT[id], id)).toBe(0);
    expect(hasAnyAssertion(SILENT[id], id)).toBe(false);
  });

  it('finds the test-case declaration and its name', () => {
    const blocks = findTestBlocks(DECLARING[id].code, id);

    expect(blocks).toHaveLength(DECLARING[id].blocks);
    expect(blocks[0]!.name).toBe(DECLARING[id].name);
  });

  it('quotes the ORIGINAL line, not the blanked one', () => {
    // The match runs against source with strings blanked; the evidence shown to
    // a human has to be what they wrote, or a finding cannot be checked by eye.
    const hits = findAssertions(ASSERTING[id], id);

    for (const hit of hits) {
      const original = ASSERTING[id].split('\n')[hit.line - 1]!.trim();
      expect(hit.quote).toBe(original);
    }
  });
});

// ─── The dialect records themselves ──────────────────────────────────────────

describe('the dialect records', () => {
  /*
   * The point of this block is the SEVENTEENTH dialect. Adding an id to
   * DIALECT_IDS with a half-filled record would otherwise ship a dialect that
   * resolves, counts 0 assertions on every file, and reports every test in that
   * language as asserting nothing — the exact defect this module was written to
   * delete. An empty pattern list must fail the build instead.
   */
  it.each(DIALECT_IDS)('%s has patterns, a label and an example', (id) => {
    const record = dialect(id);

    expect(record.id).toBe(id);
    expect(record.label.trim()).not.toBe('');
    expect(record.assertion.length).toBeGreaterThan(0);
    expect(record.testBlock.length).toBeGreaterThan(0);
    expect(record.example.trim()).not.toBe('');
    expect(assertionExampleFor(id)).toBe(record.example);
  });

  it.each(DIALECT_IDS)('%s recognises its own example as an assertion', (id) => {
    // The example is what a review flag or a prompt tells someone to write. If
    // this module would not count it, we are suggesting a fix we then report as
    // no fix at all.
    expect(countAssertions(assertionExampleFor(id), id)).toBe(1);
  });

  it('exposes one record per id and no duplicates', () => {
    expect(new Set(DIALECT_IDS).size).toBe(DIALECT_IDS.length);
    expect(DIALECT_IDS).toHaveLength(16);
  });
});

// ─── Strings and comments are not code ───────────────────────────────────────

describe('strings and comments', () => {
  it('does not count an assertion written inside a string', () => {
    // A locator can legitimately contain the text `expect(`. Counting it lets a
    // model replace a real assertion with a getByText and keep the number.
    const code = `await page.getByText('expect(this)').click();
await page.getByText("assert the total").click();`;

    expect(findAssertions(code, 'JS_EXPECT')).toEqual([]);
  });

  it('does not count a commented-out assertion', () => {
    const code = `// expect(page.getByTestId('total')).toHaveText('$42.00');
await page.goto('/checkout');`;

    expect(findAssertions(code, 'JS_EXPECT')).toEqual([]);
  });

  it('does not count an assertion inside a block comment, and keeps later lines in place', () => {
    const code = `await page.goto('/checkout');
/*
 * Disabled while the pricing migration runs:
 * await expect(page.getByTestId('total')).toHaveText('$42.00');
 */
await expect(page.getByRole('heading')).toHaveText('Order confirmed');`;
    const hits = findAssertions(code, 'JS_EXPECT');

    expect(hits).toHaveLength(1);
    // Line 6, not line 4: the block comment must not shift the offsets.
    expect(hits[0]!.line).toBe(6);
    expect(hits[0]!.quote).toContain('Order confirmed');
  });

  it('does not count a Python # comment', () => {
    const code = `# assert order.total == Decimal("42.00")
page.goto("/checkout")`;

    expect(findAssertions(code, 'PY_ASSERT')).toEqual([]);
  });

  it('does not mistake an identifier that merely starts with assert', () => {
    // `assertion_count` is a variable. Both halves matter: the Python record
    // requires whitespace after the keyword, and the Minitest/Elixir records
    // reject an assignment.
    expect(countAssertions('assertion_count = 0\nassertions = []', 'PY_ASSERT')).toBe(0);
    expect(countAssertions('assert_count = 3\nassertions = 0', 'RUBY_MINITEST')).toBe(0);
    expect(countAssertions('assert_count = 3\nassertions = 0', 'ELIXIR')).toBe(0);
    // …while the real forms, which also begin with the keyword plus a space,
    // still count. A fix that silenced these would be worse than the defect.
    expect(countAssertions('assert_equal "$42.00", total', 'RUBY_MINITEST')).toBe(1);
    expect(countAssertions('assert html =~ "ok"', 'ELIXIR')).toBe(1);
    expect(countAssertions('refute_receive {:error, _}', 'ELIXIR')).toBe(1);
  });

  it('does not count a method DEFINITION named like an assertion', () => {
    /*
     * The gaming vector the header warns about, written out: a model deletes the
     * assertEquals call and adds a method of the same name, and a count-based
     * guard sees no change. A definition has a type token before the name and
     * its parameter list is followed by `{`; a call never is.
     */
    const definitions = `  void assertEquals(String expected, String actual) {
  private void assertThat(Order order) {
  public static void assertTrue(boolean flag) {}
  private void fail(String why) {`;

    expect(findAssertions(definitions, 'JVM')).toEqual([]);
    // The calls those definitions are impersonating still count.
    expect(
      countAssertions(
        `        assertEquals("Order confirmed", heading);
        assertThat(order).isNotNull();
        assertTrue(order.isPaid());
        assertThrows(IllegalStateException.class, () -> service.pay());
        assertAll(() -> assertEquals(1, a), () -> assertEquals(2, b));
        fail("unreachable");`,
        'JVM',
      ),
    ).toBe(6);
  });

  it('treats a PHP #[Test] attribute as code, not as a comment', () => {
    /*
     * `#` opens a comment in PHP and also opens an attribute. Blanking `#[Test]`
     * would lose every test-case declaration in a modern PHPUnit suite — and
     * since `findTestBlocks` is how a finding gets anchored on the right test,
     * that is a whole file reported as having no tests.
     */
    const code = `<?php
class CheckoutTest extends WebTestCase
{
    #[Test]
    public function totalIsShown(): void
    {
        # the next line is the assertion, this is not
        $this->assertSame("Order confirmed", $heading);
    }
}`;
    const blanked = blankStringsAndComments(code, 'PHP_PHPUNIT');

    expect(blanked.split('\n')[3]).toContain('#[Test]');
    // The real `#` comment on line 7 is blanked, attribute syntax or not.
    expect(blanked.split('\n')[6]!.trim()).toBe('');
    expect(findTestBlocks(code, 'PHP_PHPUNIT').map((b) => b.line)).toContain(4);
    expect(findAssertions(code, 'PHP_PHPUNIT')).toHaveLength(1);
    expect(findAssertions(code, 'PHP_PHPUNIT')[0]!.line).toBe(8);
  });

  it('preserves length, line count and offsets when blanking', () => {
    /*
     * Every caller matches against the blanked text and then indexes the
     * ORIGINAL by the same line number. If blanking changed the length or the
     * line count, every quote in every report would be off by some amount that
     * depends on the file.
     */
    const code = `const expected = 'Order confirmed'; // or "Order placed", historically
/* a block
   over two lines */
await expect(page.getByRole('heading')).toHaveText(expected);
`;
    const blanked = blankStringsAndComments(code, 'JS_EXPECT');

    expect(blanked).toHaveLength(code.length);
    expect(blanked.split('\n')).toHaveLength(code.split('\n').length);
    for (let i = 0; i < code.length; i += 1) {
      // Newlines are never blanked — that is what keeps the offsets aligned.
      if (code[i] === '\n') expect(blanked[i]).toBe('\n');
    }
    expect(blanked).toContain("const expected = '");
    expect(blanked).not.toContain('historically');
    expect(blanked).not.toContain('over two lines');
  });

  it('does not let an unterminated string swallow the rest of the file', () => {
    // A single-quoted string never spans lines, so a missing quote must cost one
    // line, not every assertion below it.
    const code = `const broken = 'never closed
await expect(page.getByRole('heading')).toHaveText('Order confirmed');`;

    expect(countAssertions(code, 'JS_EXPECT')).toBe(1);
  });
});

// ─── Gherkin: the keyword a step inherits ────────────────────────────────────

describe('Gherkin', () => {
  const feature = `Feature: checkout
  Scenario: a customer pays
    Given a cart with one item
    When I submit the payment form
    And I accept the terms
    Then the confirmation heading says "Order confirmed"
    But no error banner is shown
    * the receipt shows a total of "$42.00"
  Scenario: a customer browses
    And I open the cart
    When I scroll the list
    * I wait for the images`;

  it('counts a Then, and an And/But/* that follows one', () => {
    expect(findAssertions(feature, 'GHERKIN').map((hit) => hit.line)).toEqual([6, 7, 8]);
  });

  it('does not count an And that follows a When — that is an action', () => {
    // Line 5 is `And I accept the terms`, under a When. The whole reason
    // Gherkin needs its own pass: the line itself does not say which it is.
    expect(findAssertions(feature, 'GHERKIN').map((hit) => hit.quote)).not.toContain(
      'And I accept the terms',
    );
  });

  it('stops counting when a scenario goes back to acting after a Then', () => {
    /*
     * A two-phase scenario — assert, act again, assert again — is the case the
     * Given/When reset exists for, and the case this suite did not have until a
     * mutation run proved that deleting the reset changed nothing it tested.
     * Without the reset every step after the first Then inherits its Then-ness
     * for the rest of the scenario, so a scenario asserting twice reads as
     * asserting four times — and a step count that goes UP when a step is
     * deleted is how the never-weaken guard gets gamed.
     */
    const twoPhase = `Scenario: a customer downloads the receipt
    When I submit the payment form
    Then the confirmation heading says "Order confirmed"
    When I click "Download receipt"
    And I choose the PDF format
    Then the downloaded file is a PDF`;

    expect(findAssertions(twoPhase, 'GHERKIN').map((hit) => hit.quote)).toEqual([
      'Then the confirmation heading says "Order confirmed"',
      'Then the downloaded file is a PDF',
    ]);
  });

  it('resets at a new Scenario, so a stray And does not inherit the previous Then', () => {
    // Line 10's `And` opens the second scenario. Without the reset it would
    // inherit scenario one's Then and the scenario would read as asserting.
    const hits = findAssertions(feature, 'GHERKIN');

    expect(hits.every((hit) => hit.line <= 8)).toBe(true);
    expect(findTestBlocks(feature, 'GHERKIN').map((block) => block.name)).toEqual([
      'a customer pays',
      'a customer browses',
    ]);
  });

  it('ignores a commented step', () => {
    const commented = `Scenario: a customer pays
    When I submit the payment form
#   Then the confirmation heading says "Order confirmed"`;

    expect(findAssertions(commented, 'GHERKIN')).toEqual([]);
  });
});

// ─── Robot: column one, inside the right section ─────────────────────────────

describe('Robot Framework', () => {
  const suite = `*** Settings ***
Library    Browser
Suite Setup    Log In As A Buyer

*** Variables ***
\${URL}    https://example.test

*** Test Cases ***
Checkout charges the right total
    Open Browser    \${URL}/checkout    chromium
    Page Should Contain Element    css=[data-test="confirmation"]

Receipt shows the total
    Should Be Equal    \${total}    $42.00

*** Keywords ***
Log In As A Buyer
    Fill Text    id=email    buyer@example.com
    Click    id=submit`;

  it('reads only column-one lines inside *** Test Cases *** as test blocks', () => {
    const blocks = findTestBlocks(suite, 'ROBOT');

    expect(blocks.map((block) => block.name)).toEqual([
      'Checkout charges the right total',
      'Receipt shows the total',
    ]);
  });

  it('does not read a *** Keywords *** definition as a test block', () => {
    // `Log In As A Buyer` is in column one too. A generic ^\S pattern reports
    // every settings line, every variable and every keyword as a test case,
    // which inflates the suite's test count with things that cannot fail.
    expect(findTestBlocks(suite, 'ROBOT').map((block) => block.name)).not.toContain(
      'Log In As A Buyer',
    );
    expect(findTestBlocks(suite, 'ROBOT').map((block) => block.name)).not.toContain('Library');
  });

  it('still counts a Should keyword wherever it appears', () => {
    // Assertions are not section-scoped: a keyword body is where a shared
    // assertion usually lives, and it asserts for whichever test calls it.
    expect(countAssertions(suite, 'ROBOT')).toBe(2);
  });
});

// ─── resolveDialect: precedence, and null ────────────────────────────────────

describe('resolveDialect', () => {
  it('prefers the runner id over everything else', () => {
    // The runner is the only hint that can tell Cypress from Jest or Minitest
    // from RSpec, and in both pairs the file name and extension agree with the
    // wrong answer.
    expect(resolveDialect({ filePath: 'tests/checkout.spec.ts', ecosystemId: 'cypress' })).toBe(
      'JS_CHAI',
    );
    expect(resolveDialect({ filePath: 'spec/checkout_spec.rb', ecosystemId: 'minitest' })).toBe(
      'RUBY_MINITEST',
    );
    expect(resolveDialect({ filePath: 'tests/test_checkout.py', ecosystemId: 'unittest' })).toBe(
      'PY_UNITTEST',
    );
    // Either vocabulary, either case, either separator.
    expect(resolveDialect({ ecosystemId: 'CUCUMBER-JS' })).toBe('GHERKIN');
    expect(resolveDialect({ ecosystemId: 'playwright_python' })).toBe('PY_ASSERT');
  });

  it('prefers a filename convention over the extension', () => {
    expect(resolveDialect({ filePath: 'cypress/e2e/checkout.cy.ts' })).toBe('JS_CHAI');
    expect(resolveDialect({ filePath: 'spec/models/order_spec.rb' })).toBe('RUBY_RSPEC');
    expect(resolveDialect({ filePath: 'test/models/order_test.rb' })).toBe('RUBY_MINITEST');
    expect(resolveDialect({ filePath: 'tests/acceptance/LoginCest.php' })).toBe('PHP_CODECEPT');
    expect(resolveDialect({ filePath: 'tests/test_checkout.py' })).toBe('PY_ASSERT');
  });

  it('prefers the extension over the declared language', () => {
    // A polyglot repo's `language` is the project default, and one Go test in a
    // Python project is still a Go test.
    expect(resolveDialect({ filePath: 'internal/checkout_test.go', language: 'PYTHON' })).toBe(
      'GO_TESTING',
    );
    expect(resolveDialect({ filePath: 'features/checkout.feature', language: 'JAVA' })).toBe(
      'GHERKIN',
    );
  });

  it('falls back to the language when the path says nothing', () => {
    expect(resolveDialect({ language: 'RUBY' })).toBe('RUBY_RSPEC');
    expect(resolveDialect({ language: 'rust' })).toBe('RUST');
    expect(resolveDialect({ filePath: 'tests/checkout', language: 'GO' })).toBe('GO_TESTING');
  });

  it('returns null when nothing settles it — which means "cannot read", not "asserts nothing"', () => {
    /*
     * Load-bearing. Every caller must branch on null and say it could not read
     * the file. A default here — "assume JavaScript" — would quietly restore the
     * original defect: a Go test counted with the JS lexicon reads as 0
     * assertions before and 0 after, so the never-weaken guard passes whatever
     * the edit did.
     */
    expect(resolveDialect({})).toBeNull();
    expect(resolveDialect({ filePath: 'docs/checkout.md' })).toBeNull();
    expect(resolveDialect({ filePath: 'tests/smoke.api.json' })).toBeNull();
    expect(resolveDialect({ filePath: 'Makefile' })).toBeNull();
    expect(resolveDialect({ filePath: null, ecosystemId: null, language: null })).toBeNull();
    expect(resolveDialect({ ecosystemId: 'some-runner-we-have-never-heard-of' })).toBeNull();
  });

  it('resolves every extension it claims to know', () => {
    const byExtension: Array<[string, DialectId]> = [
      ['tests/a.spec.ts', 'JS_EXPECT'],
      ['tests/a.spec.js', 'JS_EXPECT'],
      ['test/a_test.dart', 'JS_EXPECT'],
      ['a.feature', 'GHERKIN'],
      ['suite.robot', 'ROBOT'],
      ['common.resource', 'ROBOT'],
      ['test_a.py', 'PY_ASSERT'],
      ['CheckoutTest.java', 'JVM'],
      ['CheckoutTest.kt', 'JVM'],
      ['CheckoutSpec.groovy', 'JVM'],
      ['CheckoutSpec.scala', 'JVM'],
      ['CheckoutTests.cs', 'DOTNET'],
      ['checkout_test.go', 'GO_TESTING'],
      ['CheckoutTest.php', 'PHP_PHPUNIT'],
      ['checkout.rs', 'RUST'],
      ['CheckoutUITests.swift', 'SWIFT'],
      ['checkout_test.exs', 'ELIXIR'],
      ['checkout.ex', 'ELIXIR'],
    ];

    for (const [filePath, expected] of byExtension) {
      expect(resolveDialect({ filePath }), filePath).toBe(expected);
    }
  });
});
