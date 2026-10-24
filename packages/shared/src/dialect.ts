/**
 * What counts as an assertion, in whatever language the test is written in.
 *
 * Three modules independently decided that an assertion is `expect(`:
 * suite-health's weak-assertion report, heal-apply's never-weaken guard, and
 * inline-edit's. All three are right about JavaScript and wrong about the other
 * thirteen languages QAAI generates for. The consequences are not symmetrical:
 *
 *   - suite-health reports a correct pytest test as NO_ASSERTIONS at HIGH
 *     severity. The customer reads one obviously wrong finding and stops
 *     trusting the page.
 *   - heal-apply counts `expect(` before and after a heal and refuses the heal
 *     if the count dropped. In a Go repository the count is 0 both times, so
 *     the guard that exists to stop a model deleting assertions to make a test
 *     pass is a no-op precisely where nobody is watching.
 *
 * So: one lexicon, keyed by dialect, used by every gate.
 *
 * The rules this file lives by:
 *
 *  1. **Unknown is not zero.** `resolveDialect` returns null when it cannot
 *     tell, and every function here takes a non-null dialect. A caller holding
 *     null must say "could not read this test", never "this test asserts
 *     nothing". Absence of evidence is the bug this file exists to fix; it must
 *     not reintroduce it one level up.
 *
 *  2. **Strings and comments are not code.** `page.getByText('assert ready')`
 *     is not an assertion and `// assert the total` is not either. Both are
 *     blanked before matching, per the language's own comment and string
 *     syntax, and the quote returned to the caller is still the ORIGINAL line
 *     so a finding can be checked by eye.
 *
 *  3. **Data, not branches.** A new dialect is a new record. Nothing here
 *     executes anything, imports a runner, or knows about test types.
 *
 * It deliberately does NOT answer "is this assertion strong", "is it inside a
 * try that swallows it", or "is the expected value volatile". Those live in
 * suite-health, need a real understanding of one language's control flow, and
 * are honest about applying to JavaScript only. This file answers the question
 * that has to be answered in every language before any of those can be asked:
 * *where are the assertions, and are there any at all?*
 */

import type { Language } from './constants';
import type { EcosystemLanguage } from './ecosystems';

// ─── The dialects ────────────────────────────────────────────────────────────

/**
 * An assertion dialect is a (language, assertion-library) family, not a runner.
 * Playwright-TS, Jest and Vitest all write `expect(x).toBe(y)`, so they are one
 * dialect; Cypress writes `.should('have.text', …)` on a chained subject, which
 * no `expect(` regex finds, so it is another.
 */
export const DIALECT_IDS = [
  /** expect(…) with a matcher: Jest, Vitest, Playwright, WebdriverIO, Pest, Dart. */
  'JS_EXPECT',
  /** Chained Chai: cy.get(…).should(…), x.should.equal(y), assert.isTrue(x). */
  'JS_CHAI',
  /** Bare `assert` on an expression: pytest, playwright-python, behave. */
  'PY_ASSERT',
  /** self.assertEqual(…) and friends: unittest, Django's TestCase. */
  'PY_UNITTEST',
  /** Robot Framework keywords: Should Be Equal, Page Should Contain. */
  'ROBOT',
  /** The JVM: assertThat, assertEquals, assertTrue, Truth, Hamcrest, Kotest. */
  'JVM',
  /** .NET: Assert.Equal, Assert.That, Shouldly's ShouldBe, FluentAssertions. */
  'DOTNET',
  /** RSpec: expect(…).to eq(…), subject.should be_valid. */
  'RUBY_RSPEC',
  /** Minitest: assert_equal, refute_nil, assert_predicate. */
  'RUBY_MINITEST',
  /** Go: t.Error/t.Fatal, testify's require./assert., gotest.tools. */
  'GO_TESTING',
  /** PHPUnit: $this->assertSame, static::assertTrue. */
  'PHP_PHPUNIT',
  /** Codeception: $I->see, $I->dontSeeInField, $I->seeResponseCodeIs. */
  'PHP_CODECEPT',
  /** Gherkin: a Then/And step. The assertion is the step, not its definition. */
  'GHERKIN',
  /** Rust: assert!, assert_eq!, debug_assert!. */
  'RUST',
  /** Swift: XCTAssertEqual, #expect (swift-testing). */
  'SWIFT',
  /** Elixir: assert, refute, assert_receive. */
  'ELIXIR',
] as const;
export type DialectId = (typeof DIALECT_IDS)[number];

export interface Dialect {
  readonly id: DialectId;
  readonly label: string;
  /**
   * Lines matching any of these are assertions. Written against a line with
   * strings and comments blanked (rule 2), so a pattern may be loose about
   * what is inside the parentheses but must be tight about the call shape.
   */
  readonly assertion: readonly RegExp[];
  /**
   * The declaration of one test case. Used to anchor a finding on the right
   * line and to count test cases without parsing.
   */
  readonly testBlock: readonly RegExp[];
  /** How a line comment starts. Everything after the first unquoted hit is blanked. */
  readonly lineComment: readonly string[];
  /** Block comment delimiters, if the language has them. */
  readonly blockComment: readonly (readonly [string, string])[];
  /** Quote characters that open a string literal. */
  readonly quotes: readonly string[];
  /** One real example, for a prompt or a review flag that has to suggest a fix. */
  readonly example: string;
}

/*
 * On the patterns themselves. Two mistakes are easy here and both are costly:
 *
 * A pattern that is too NARROW under-reports, and under-reporting is what this
 * file exists to stop. Hence the alternatives: a JVM shop may use JUnit's
 * assertEquals, AssertJ's assertThat, Truth's assertWithMessage, Hamcrest's
 * assertThat(…, is(…)) or Kotest's shouldBe — all five are in the JVM record.
 *
 * A pattern that is too WIDE over-reports, which is worse than it sounds: the
 * never-weaken guard compares a count before and after an edit, so a pattern
 * that matches a helper DEFINITION as well as a call lets a model delete a real
 * assertion and add a helper to keep the number level. So every pattern anchors
 * on a CALL — an identifier immediately followed by `(`, or an operator form
 * the language only writes at a call site — and the JVM/dotnet/PHP records
 * deliberately do not match `void assertEquals(` style definitions, which have
 * a type token before the name and a `)` followed by `{`.
 */
const DIALECTS: Record<DialectId, Dialect> = {
  JS_EXPECT: {
    id: 'JS_EXPECT',
    label: 'expect(…) with matchers',
    assertion: [
      // expect(x), expect.soft(x), expect.poll(…), await expect(…)
      /\bexpect(?:\.soft|\.poll|\.element|\.extend)?\s*\(/,
      // Playwright/WDIO assertion helpers that are not spelled expect
      /\bassert(?:Equal|Equals|True|False|Ok|Deep\w*)?\s*\(/,
      // node:assert in a test: assert(x), assert.strictEqual(…)
      /\bassert\s*\.\s*\w+\s*\(/,
      // Vitest/Jest snapshot shorthand on a subject
      /\.\s*toMatch(?:Snapshot|InlineSnapshot|FileSnapshot)\s*\(/,
    ],
    testBlock: [
      /\b(?:it|test)(?:\.(?:only|skip|concurrent|each|fails|failing|todo|fixme|serial|parallel))*\s*(?:\(|`)/,
      /\btest\s*\.\s*step\s*\(/,
    ],
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    quotes: ['"', "'", '`'],
    example: 'await expect(page.getByRole("heading")).toHaveText("Order confirmed")',
  },
  JS_CHAI: {
    id: 'JS_CHAI',
    label: 'Chai / Cypress chained assertions',
    assertion: [
      // cy.get('x').should('have.text', 'y') — the assertion IS the .should
      /\.\s*should\s*\(/,
      // x.should.equal(y) / x.should.be.true  (property form, no call on should)
      /\.\s*should\s*\.\s*\w/,
      /\.\s*(?:to|and)\s*\.\s*(?:be|have|equal|eql|include|contain|match|exist)\b/,
      /\bexpect\s*\(/,
      /\bassert\s*\.\s*\w+\s*\(/,
      /\bcy\s*\.\s*(?:contains|url|title|location)\s*\(/,
    ],
    testBlock: [/\b(?:it|test|specify)(?:\.(?:only|skip|each))*\s*\(/],
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    quotes: ['"', "'", '`'],
    example: "cy.get('[data-cy=total]').should('have.text', '$42.00')",
  },
  PY_ASSERT: {
    id: 'PY_ASSERT',
    label: 'pytest bare assert',
    assertion: [
      // `assert expr` — a statement, so it is at the start of a logical line.
      // Requires something after it, so a bare `assert` (a syntax error) and
      // the word inside an identifier (`assertion_count`) are both excluded.
      /(?:^|[;:])\s*assert\s+\S/,
      // pytest.raises / pytest.warns as a context manager IS the assertion
      /\bpytest\s*\.\s*(?:raises|warns|deprecated_call)\s*\(/,
      // playwright-python's expect(locator).to_have_text(…)
      /\bexpect\s*\(/,
      // unittest-style helpers reached through a fixture rather than self
      /\b\w+\s*\.\s*assert(?:_\w+|[A-Z]\w*)\s*\(/,
    ],
    testBlock: [/^\s*(?:async\s+)?def\s+test_?\w*\s*\(/m],
    lineComment: ['#'],
    blockComment: [],
    quotes: ['"', "'"],
    example: 'assert order.total == Decimal("42.00")',
  },
  PY_UNITTEST: {
    id: 'PY_UNITTEST',
    label: 'unittest self.assertX',
    assertion: [
      /\bself\s*\.\s*assert\w*\s*\(/,
      /\bself\s*\.\s*(?:fail|assertRaises|assertWarns|assertLogs)\s*\(/,
      /(?:^|[;:])\s*assert\s+\S/,
    ],
    testBlock: [/^\s*(?:async\s+)?def\s+test_?\w*\s*\(/m],
    lineComment: ['#'],
    blockComment: [],
    quotes: ['"', "'"],
    example: 'self.assertEqual(response.status_code, 200)',
  },
  ROBOT: {
    id: 'ROBOT',
    label: 'Robot Framework keywords',
    assertion: [
      // Robot's assertions are keywords, and the convention is total: the
      // keyword contains "Should", "Must" or is an explicit Fail.
      /\bShould\s+(?:Be|Not|Contain|Match|Exist|Start|End)\b/i,
      /\bPage\s+Should\b/i,
      /\bElement\s+(?:Should|Text\s+Should)\b/i,
      /\bResponse\s+Should\b/i,
      /^\s*(?:Fail|Should\s+Be\s+Equal)\b/i,
      /\bStatus\s+Should\s+Be\b/i,
    ],
    testBlock: [/^\S.*$/m],
    lineComment: ['#'],
    blockComment: [],
    quotes: [],
    example: 'Page Should Contain Element    css=[data-test="confirmation"]',
  },
  JVM: {
    id: 'JVM',
    label: 'JUnit / AssertJ / Truth / Hamcrest / Kotest',
    assertion: [
      /*
       * `(?![^()]*\)\s*\{)` is what keeps these off a method DEFINITION.
       *
       * The comment above this record always claimed they did not match
       * `void assertEquals(String a, String b) {` — they did, because the
       * `(?<![\w.])` lookbehind only rejects a preceding identifier character
       * and a space is not one. That is the precise shape of the gaming vector
       * the comment describes: a model deletes the assertEquals CALL, adds a
       * method of the same name, and the never-weaken guard sees the count
       * hold. A definition's parameter list is followed by `{`; a call's never
       * is, and a call whose arguments contain parentheses (`assertThat(x(y))`,
       * `assertAll(() -> …)`) cannot match the lookahead at all.
       */
      // assertThat(x).isEqualTo(y) — AssertJ, Truth, Playwright-Java
      /\bassert(?:That|ThatCode|ThatThrownBy|ThatObject|WithMessage|ThatNoException)\s*\((?![^()]*\)\s*\{)/,
      // JUnit / TestNG: assertEquals, assertTrue, assertAll, assertThrows…
      // `(?<![\w.])` keeps it off `this.assertEquals`, which is a helper of the
      // test's own.
      /(?<![\w.])assert(?:Equals|NotEquals|Same|NotSame|True|False|Null|NotNull|Throws|All|DoesNotThrow|Timeout|ArrayEquals|Iterable\w*|Lines\w*)\s*\((?![^()]*\)\s*\{)/,
      // Kotest / Strikt infix and extension forms
      /\bshould(?:Be|NotBe|Contain|NotContain|Throw|HaveSize|StartWith|EndWith|MatchJson)\b/,
      /\bexpectThat\s*\(/,
      // Hamcrest's bare assertThat is covered above; fail() is an assertion too
      /(?<![\w.])fail\s*\((?![^()]*\)\s*\{)/,
      // Playwright-Java static assertThat(locator)
      /\bPlaywrightAssertions\s*\.\s*assertThat\s*\(/,
    ],
    testBlock: [
      /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/,
      /\b(?:fun|void)\s+(?:`[^`]+`|\w*[Tt]est\w*)\s*\(/,
    ],
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    quotes: ['"', "'"],
    example: 'assertThat(page.getByTestId("total")).hasText("$42.00");',
  },
  DOTNET: {
    id: 'DOTNET',
    label: 'NUnit / xUnit / Shouldly / FluentAssertions',
    assertion: [
      /\bAssert\s*\.\s*\w+\s*\(/,
      /\bStringAssert\s*\.\s*\w+\s*\(/,
      /\bCollectionAssert\s*\.\s*\w+\s*\(/,
      // FluentAssertions: x.Should().Be(y)
      /\.\s*Should\s*\(\s*\)\s*\./,
      // Shouldly: x.ShouldBe(y)
      /\.\s*Should(?:Be|NotBe|Contain|NotContain|Throw|Satisfy|StartWith|EndWith|BeNull|BeTrue|BeFalse)\w*\s*\(/,
      // Playwright .NET
      /\bExpect\s*\(/,
    ],
    testBlock: [/\[(?:Test|Fact|Theory|TestCase|TestMethod)\b/, /\bpublic\s+(?:async\s+)?\w[\w<>,\s[\]]*\s+\w*Test\w*\s*\(/],
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    quotes: ['"', "'"],
    example: 'await Expect(page.GetByTestId("total")).ToHaveTextAsync("$42.00");',
  },
  RUBY_RSPEC: {
    id: 'RUBY_RSPEC',
    label: 'RSpec expect(…).to',
    assertion: [
      /\bexpect\s*[({]/,
      /\bexpect\s*\(/,
      /\.\s*should(?:_not)?\b/,
      /\bis_expected\s*\.\s*to\b/,
      // Capybara's own assertions
      /\bassert_(?:selector|text|current_path|no_selector)\b/,
      /\bhave_(?:content|text|selector|css|current_path|field|button)\b/,
    ],
    testBlock: [/^\s*(?:it|specify|example|scenario)\b/m],
    lineComment: ['#'],
    blockComment: [['=begin', '=end']],
    quotes: ['"', "'"],
    example: 'expect(page).to have_text("Order confirmed")',
  },
  RUBY_MINITEST: {
    id: 'RUBY_MINITEST',
    label: 'Minitest assert_*',
    assertion: [
      /*
       * The trailing negative lookahead rejects an ASSIGNMENT. `assert_count =
       * 3` declares a local, and counting it gives a model a one-line way to
       * keep the assertion count level while deleting a real assert_equal. The
       * exclusion is deliberately narrow — a bare or compound `=` only, never
       * `==` or `=~` — because `assert_equal <<~TEXT, actual` is real Minitest
       * and starts with `<`.
       */
      /(?<![\w.])(?:assert|refute)(?:_\w+)?\s*(?:\(|\s+(?![-+*/|&]?=[^=~]))/,
      /\.\s*must_\w+\b/,
      /\.\s*wont_\w+\b/,
      /\bflunk\b/,
    ],
    testBlock: [/^\s*def\s+test_\w+/m, /^\s*test\s+["']/m],
    lineComment: ['#'],
    blockComment: [['=begin', '=end']],
    quotes: ['"', "'"],
    example: 'assert_equal "$42.00", page.text_field("total").value',
  },
  GO_TESTING: {
    id: 'GO_TESTING',
    label: 'Go testing / testify',
    assertion: [
      // The standard library has no assertions — failing the test IS asserting.
      /\bt\s*\.\s*(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/,
      // testify
      /\b(?:require|assert)\s*\.\s*\w+\s*\(/,
      // gotest.tools / is-style helpers
      /\bis\s*\.\s*(?:Equal|Nil|NoError|True)\s*\(/,
      /\bassert\s*\.\s*(?:Assert|Check|Equal|NilError)\s*\(/,
      // Playwright-Go
      /\b(?:expect|Expect)\s*\(/,
    ],
    testBlock: [/^\s*func\s+(?:Test|Example|Benchmark|Fuzz)\w*\s*\(/m],
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    quotes: ['"', '`'],
    example: 'if got != "$42.00" { t.Fatalf("total = %q, want $42.00", got) }',
  },
  PHP_PHPUNIT: {
    id: 'PHP_PHPUNIT',
    label: 'PHPUnit / Pest',
    assertion: [
      /\$this\s*->\s*assert\w+\s*\(/,
      /(?:self|static|Assert)\s*::\s*assert\w+\s*\(/,
      // Pest: expect($x)->toBe($y)
      /\bexpect\s*\(/,
      /\$this\s*->\s*(?:fail|expectException|expectExceptionMessage)\s*\(/,
      // Symfony Panther / WebTestCase
      /\bassert(?:SelectorTextContains|ResponseIsSuccessful|ResponseStatusCodeSame|PageTitleContains|SelectorExists)\s*\(/,
    ],
    testBlock: [/\bfunction\s+test\w*\s*\(/, /#\[Test\]/, /@test\b/, /\bit\s*\(/, /\btest\s*\(/],
    lineComment: ['//', '#'],
    blockComment: [['/*', '*/']],
    quotes: ['"', "'"],
    example: '$this->assertSelectorTextContains(".total", "$42.00");',
  },
  PHP_CODECEPT: {
    id: 'PHP_CODECEPT',
    label: 'Codeception $I->see',
    assertion: [
      // $I->see / dontSee / seeInField carry the assertion; $I->click does not.
      /\$\w+\s*->\s*(?:see|dontSee|cantSee|canSee)\w*\s*\(/,
      /\$\w+\s*->\s*assert\w*\s*\(/,
      /\$\w+\s*->\s*(?:expect|expectTo)\w*\s*\(/,
    ],
    testBlock: [/\bfunction\s+\w+\s*\(\s*\\?\w*Tester/, /\bfunction\s+test\w*\s*\(/],
    lineComment: ['//', '#'],
    blockComment: [['/*', '*/']],
    quotes: ['"', "'"],
    example: '$I->see("Order confirmed", "h1");',
  },
  GHERKIN: {
    id: 'GHERKIN',
    label: 'Gherkin Then steps',
    assertion: [
      // In a .feature file the assertion is a Then (or an And after one). An
      // `And` following a When is an action, which this cannot tell apart from
      // one line — `findAssertions` resolves it with the preceding keyword.
      /^\s*(?:Then|\*)\s+\S/,
    ],
    testBlock: [/^\s*(?:Scenario|Scenario Outline|Example)\s*:/m],
    lineComment: ['#'],
    blockComment: [],
    quotes: ['"'],
    example: 'Then the order confirmation shows a total of "$42.00"',
  },
  RUST: {
    id: 'RUST',
    label: 'Rust assert! macros',
    assertion: [
      /(?<![\w.])(?:assert|assert_eq|assert_ne|debug_assert|debug_assert_eq|debug_assert_ne|matches)\s*!/,
      /(?<![\w.])panic\s*!/,
      /\.\s*(?:unwrap|expect)\s*\(/,
    ],
    testBlock: [/#\[\s*(?:tokio::)?test\b/, /^\s*(?:async\s+)?fn\s+\w*test\w*\s*\(/m],
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    quotes: ['"'],
    example: 'assert_eq!(order.total, "$42.00");',
  },
  SWIFT: {
    id: 'SWIFT',
    label: 'XCTest / swift-testing',
    assertion: [
      /\bXCTAssert\w*\s*\(/,
      /\bXCTFail\s*\(/,
      /\bXCTUnwrap\s*\(/,
      /#(?:expect|require)\s*\(/,
    ],
    testBlock: [/\bfunc\s+test\w*\s*\(/, /@Test\b/],
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    quotes: ['"'],
    example: 'XCTAssertEqual(totalLabel.label, "$42.00")',
  },
  ELIXIR: {
    id: 'ELIXIR',
    label: 'ExUnit assert / refute',
    assertion: [
      // Same assignment exclusion as the Minitest record, for the same reason:
      // `assert_count = 3` is a local, not an assertion.
      /(?<![\w.])(?:assert|refute)(?:_\w+)?\s+(?![-+*/|&]?=[^=~])\S/,
      /(?<![\w.])(?:assert|refute)(?:_\w+)?\s*\(/,
      /(?<![\w.])flunk\s*[( ]/,
    ],
    testBlock: [/^\s*test\s+["']/m],
    lineComment: ['#'],
    blockComment: [],
    quotes: ['"'],
    example: 'assert html =~ "Order confirmed"',
  },
};

export function dialect(id: DialectId): Dialect {
  return DIALECTS[id];
}

/** One real assertion in this dialect, for a prompt or a review flag. */
export function assertionExampleFor(id: DialectId): string {
  return DIALECTS[id].example;
}

// ─── Resolving a dialect ─────────────────────────────────────────────────────

/**
 * Extension → dialect, for the cases where the extension settles it. A `.py`
 * file could be pytest or unittest, so it is deliberately absent: a caller with
 * only a path gets PY_ASSERT, whose patterns include the unittest forms, rather
 * than a wrong guess between the two.
 */
const BY_EXTENSION: Record<string, DialectId> = {
  '.feature': 'GHERKIN',
  '.robot': 'ROBOT',
  '.resource': 'ROBOT',
  '.py': 'PY_ASSERT',
  '.java': 'JVM',
  '.kt': 'JVM',
  '.kts': 'JVM',
  '.groovy': 'JVM',
  '.scala': 'JVM',
  '.cs': 'DOTNET',
  '.rb': 'RUBY_RSPEC',
  '.go': 'GO_TESTING',
  '.php': 'PHP_PHPUNIT',
  '.rs': 'RUST',
  '.swift': 'SWIFT',
  '.ex': 'ELIXIR',
  '.exs': 'ELIXIR',
  '.dart': 'JS_EXPECT',
  '.ts': 'JS_EXPECT',
  '.tsx': 'JS_EXPECT',
  '.js': 'JS_EXPECT',
  '.jsx': 'JS_EXPECT',
  '.mjs': 'JS_EXPECT',
  '.cjs': 'JS_EXPECT',
  '.mts': 'JS_EXPECT',
};

const BY_LANGUAGE: Record<Language, DialectId> = {
  TYPESCRIPT: 'JS_EXPECT',
  JAVASCRIPT: 'JS_EXPECT',
  PYTHON: 'PY_ASSERT',
  JAVA: 'JVM',
  KOTLIN: 'JVM',
  CSHARP: 'DOTNET',
  RUBY: 'RUBY_RSPEC',
  GO: 'GO_TESTING',
  PHP: 'PHP_PHPUNIT',
};

const BY_ECOSYSTEM_LANGUAGE: Record<EcosystemLanguage, DialectId> = {
  typescript: 'JS_EXPECT',
  javascript: 'JS_EXPECT',
  python: 'PY_ASSERT',
  java: 'JVM',
  kotlin: 'JVM',
  groovy: 'JVM',
  scala: 'JVM',
  csharp: 'DOTNET',
  ruby: 'RUBY_RSPEC',
  go: 'GO_TESTING',
  php: 'PHP_PHPUNIT',
  rust: 'RUST',
  swift: 'SWIFT',
  dart: 'JS_EXPECT',
  elixir: 'ELIXIR',
};

/**
 * The runner ids from the shared ecosystem catalogue whose dialect is NOT the
 * one its language implies. Cypress is JavaScript and writes no `expect(`;
 * Codeception is PHP and writes no `assert`; a Ruby suite could be either of
 * two. Everything else falls through to the language.
 */
const BY_RUNNER: Record<string, DialectId> = {
  cypress: 'JS_CHAI',
  nightwatch: 'JS_CHAI',
  codeception: 'PHP_CODECEPT',
  minitest: 'RUBY_MINITEST',
  rails: 'RUBY_MINITEST',
  unittest: 'PY_UNITTEST',
  django: 'PY_UNITTEST',
  robot: 'ROBOT',
  behave: 'PY_ASSERT',
  cucumber: 'GHERKIN',
  'cucumber-js': 'GHERKIN',
  'cucumber-jvm': 'GHERKIN',
  godog: 'GHERKIN',
  // The agent package's own prompt-ecosystem ids, lower-cased, so a caller
  // holding either vocabulary resolves to the same dialect.
  playwright_ts: 'JS_EXPECT',
  playwright_python: 'PY_ASSERT',
  playwright_java: 'JVM',
  playwright_kotlin: 'JVM',
  playwright_csharp: 'DOTNET',
  playwright_go: 'GO_TESTING',
  selenium_python: 'PY_ASSERT',
  selenium_java: 'JVM',
  selenium_kotlin: 'JVM',
  selenium_csharp: 'DOTNET',
  selenium_ruby: 'RUBY_RSPEC',
  capybara_rspec: 'RUBY_RSPEC',
  appium_python: 'PY_ASSERT',
  appium_java: 'JVM',
  espresso: 'JVM',
  junit5: 'JVM',
  junit5_kotlin: 'JVM',
  testng: 'JVM',
  nunit: 'DOTNET',
  xunit: 'DOTNET',
  rspec: 'RUBY_RSPEC',
  pytest: 'PY_ASSERT',
  go_test: 'GO_TESTING',
  chromedp: 'GO_TESTING',
  panther: 'PHP_PHPUNIT',
  phpunit: 'PHP_PHPUNIT',
  pest: 'PHP_PHPUNIT',
  jest: 'JS_EXPECT',
  vitest: 'JS_EXPECT',
  puppeteer: 'JS_EXPECT',
  webdriverio: 'JS_EXPECT',
  testcafe: 'JS_EXPECT',
};

export interface DialectHints {
  /** The test's own path. The strongest single signal and usually enough. */
  filePath?: string | null;
  /** A runner id from either ecosystem vocabulary (case-insensitive). */
  ecosystemId?: string | null;
  /** The project's language, when the path does not say. */
  language?: Language | EcosystemLanguage | null;
}

/**
 * Filename conventions that settle a dialect the extension cannot. `.cy.ts` is
 * Cypress and `_spec.rb` is RSpec by convention so strong that the convention
 * is how the runners themselves collect files — which makes these as reliable
 * as the extension and more specific, so they are consulted first.
 */
const BY_FILENAME: readonly (readonly [RegExp, DialectId])[] = [
  [/\.cy\.[cm]?[jt]sx?$/i, 'JS_CHAI'],
  [/\.feature$/i, 'GHERKIN'],
  [/_spec\.rb$/i, 'RUBY_RSPEC'],
  [/_test\.rb$/i, 'RUBY_MINITEST'],
  [/Cest\.php$/i, 'PHP_CODECEPT'],
  [/(?:^|[\\/])test_\w+\.py$/i, 'PY_ASSERT'],
];

function extensionOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/**
 * Null when nothing in the hints settles it. A caller MUST treat null as "I
 * cannot read this test" — see rule 1 at the top of the file.
 *
 * The runner id is consulted BEFORE the path, because the runner is the only
 * signal that distinguishes Cypress from Jest or Minitest from RSpec, and both
 * of those pairs share an extension.
 */
export function resolveDialect(hints: DialectHints): DialectId | null {
  const runner = hints.ecosystemId?.toLowerCase().replace(/-/g, '_');
  if (runner) {
    const byRunner = BY_RUNNER[runner] ?? BY_RUNNER[runner.replace(/_/g, '-')];
    if (byRunner) return byRunner;
  }
  if (hints.filePath) {
    const byFilename = BY_FILENAME.find(([pattern]) => pattern.test(hints.filePath!));
    if (byFilename) return byFilename[1];
    const byExtension = BY_EXTENSION[extensionOf(hints.filePath)];
    if (byExtension) return byExtension;
  }
  if (hints.language) {
    const upper = hints.language.toUpperCase() as Language;
    if (upper in BY_LANGUAGE) return BY_LANGUAGE[upper];
    const lower = hints.language.toLowerCase() as EcosystemLanguage;
    if (lower in BY_ECOSYSTEM_LANGUAGE) return BY_ECOSYSTEM_LANGUAGE[lower];
  }
  return null;
}

// ─── Blanking strings and comments ───────────────────────────────────────────

/**
 * Replaces every string literal's CONTENTS and every comment with spaces,
 * preserving line count, offsets and the delimiters themselves.
 *
 * Preserving offsets is what lets a caller match against the blanked text and
 * quote the original line (rule 2). Preserving the delimiters means a pattern
 * can still tell `getByText("")` from `getByText()` if it ever needs to.
 *
 * This is a scanner, not a parser: it does not understand template-literal
 * interpolation (`${expect(x)}` inside a template is blanked, which is the
 * conservative direction), nor Python's triple quotes beyond treating them as
 * three single-character strings, nor regex literals containing a quote. Each
 * of those makes it blank slightly more than a parser would, and blanking more
 * can only cost a missed assertion in code no reviewer would defend.
 */
export interface BlankOptions {
  /**
   * Keep string CONTENTS, blank only comments.
   *
   * Two kinds of gate need this: a locator's value and an expected value both
   * live inside a string literal, so blanking them hides the very evidence the
   * gate is reading. The comments still have to go, and for the opposite
   * reason — `// assert the total is $42` would otherwise let prose satisfy a
   * check that nothing was asserted.
   *
   * A `//` inside a string is still not a comment either way: the scanner
   * walks the literal, it just does not overwrite it.
   */
  keepStrings?: boolean;
}

export function blankStringsAndComments(
  code: string,
  id: DialectId,
  options: BlankOptions = {},
): string {
  const d = DIALECTS[id];
  const out = code.split('');
  let i = 0;
  const n = code.length;

  while (i < n) {
    const rest = code.slice(i, i + 8);

    // Block comment
    const block = d.blockComment.find((pair) => rest.startsWith(pair[0]));
    if (block) {
      const end = code.indexOf(block[1], i + block[0].length);
      const stop = end === -1 ? n : end + block[1].length;
      for (let j = i; j < stop; j += 1) if (out[j] !== '\n') out[j] = ' ';
      i = stop;
      continue;
    }

    // Line comment. `#` is a line comment in PHP and also the start of an
    // attribute (`#[Test]`), so a `#` immediately followed by `[` is not one.
    const line = d.lineComment.find((marker) => rest.startsWith(marker));
    if (line && !(line === '#' && code[i + 1] === '[')) {
      let stop = code.indexOf('\n', i);
      if (stop === -1) stop = n;
      for (let j = i; j < stop; j += 1) out[j] = ' ';
      i = stop;
      continue;
    }

    // String literal
    const quote = d.quotes.find((q) => code[i] === q);
    if (quote) {
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code[j] === quote) break;
        // An unterminated literal must not swallow the rest of the file: a
        // single-quoted string never spans lines in any dialect here, and a
        // backtick that does is the one case worth the extra scan.
        if (code[j] === '\n' && quote !== '`') break;
        j += 1;
      }
      const stop = Math.min(j, n);
      if (!options.keepStrings) {
        for (let k = i + 1; k < stop; k += 1) if (out[k] !== '\n') out[k] = ' ';
      }
      i = code[stop] === quote ? stop + 1 : stop;
      continue;
    }

    i += 1;
  }

  return out.join('');
}

// ─── Finding assertions ──────────────────────────────────────────────────────

export interface DialectHit {
  /** 1-based, in the code as passed in. */
  line: number;
  /** The ORIGINAL line, trimmed — so a finding can be checked without the file. */
  quote: string;
  /** Which pattern matched, as its source, for debugging a false positive. */
  pattern: string;
}

export interface TestBlockHit extends DialectHit {
  /** The test's declared name, when the dialect's syntax carries one. */
  name: string | null;
}

function hitsFor(
  code: string,
  id: DialectId,
  patterns: readonly RegExp[],
): { lines: string[]; blanked: string[]; hits: DialectHit[] } {
  const lines = code.split('\n');
  const blanked = blankStringsAndComments(code, id).split('\n');
  const hits: DialectHit[] = [];

  for (let index = 0; index < blanked.length; index += 1) {
    const candidate = blanked[index] ?? '';
    if (candidate.trim().length === 0) continue;
    for (const pattern of patterns) {
      // The multiline patterns are written with ^…$m against a whole file; on a
      // single line they behave the same way, so matching line-by-line is safe
      // and gives the line number for free.
      if (!pattern.test(candidate)) continue;
      hits.push({
        line: index + 1,
        quote: (lines[index] ?? '').trim(),
        pattern: pattern.source,
      });
      break;
    }
  }

  return { lines, blanked, hits };
}

/**
 * Every line that asserts something, in the dialect's own terms.
 *
 * Gherkin is the one dialect where a line is not self-describing: an `And`
 * belongs to whichever keyword came before it, so the Then-ness has to be
 * carried down the file. Everything else is decided per line.
 */
export function findAssertions(code: string, id: DialectId): DialectHit[] {
  if (id === 'GHERKIN') return gherkinAssertions(code);
  return hitsFor(code, id, DIALECTS[id].assertion).hits;
}

function gherkinAssertions(code: string): DialectHit[] {
  const hits: DialectHit[] = [];
  let inThen = false;
  const lines = code.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const text = raw.trim();
    if (text.length === 0 || text.startsWith('#')) continue;
    const keyword = /^(Given|When|Then|And|But|\*)\s+(\S.*)$/i.exec(text);
    if (!keyword) {
      // A Scenario/Feature/Examples line ends the current step group.
      if (/^(Feature|Scenario|Background|Examples|Rule)\b/i.test(text)) inThen = false;
      continue;
    }
    const word = keyword[1]!.toLowerCase();
    if (word === 'then') inThen = true;
    else if (word === 'given' || word === 'when') inThen = false;
    // `And`, `But` and `*` inherit, which is the whole reason for this function.
    if (!inThen) continue;
    hits.push({ line: index + 1, quote: text, pattern: 'gherkin-then' });
  }

  return hits;
}

export function countAssertions(code: string, id: DialectId): number {
  return findAssertions(code, id).length;
}

export function hasAnyAssertion(code: string, id: DialectId): boolean {
  return findAssertions(code, id).length > 0;
}

/** Every test-case declaration, with its name where the syntax carries one. */
export function findTestBlocks(code: string, id: DialectId): TestBlockHit[] {
  if (id === 'ROBOT') return robotTestBlocks(code);
  const { hits } = hitsFor(code, id, DIALECTS[id].testBlock);
  return hits.map((hit) => ({ ...hit, name: testNameFrom(hit.quote, id) }));
}

/**
 * Robot's test cases are lines that start in column one inside the `*** Test
 * Cases ***` section — there is no keyword to match, so the section has to be
 * tracked. A generic `^\S` pattern would otherwise report every settings and
 * keyword line as a test.
 */
function robotTestBlocks(code: string): TestBlockHit[] {
  const hits: TestBlockHit[] = [];
  let inTestSection = false;
  const lines = code.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const text = raw.trim();
    if (text.length === 0 || text.startsWith('#')) continue;
    if (/^\*\*\*/.test(text)) {
      inTestSection = /\*\*\*\s*(test cases|tasks)\s*\*\*\*/i.test(text);
      continue;
    }
    if (!inTestSection) continue;
    if (/^\s/.test(raw)) continue;
    hits.push({ line: index + 1, quote: text, name: text, pattern: 'robot-test-case' });
  }

  return hits;
}

function testNameFrom(quote: string, id: DialectId): string | null {
  if (id === 'GHERKIN') {
    const scenario = /^\s*(?:Scenario(?:\s+Outline)?|Example)\s*:\s*(.+)$/i.exec(quote);
    return scenario?.[1]?.trim() ?? null;
  }
  // A quoted first argument: it('does the thing'), test("…"), describe(`…`).
  const quoted = /["'`]([^"'`]{2,})["'`]/.exec(quote);
  if (quoted) return quoted[1]!.trim();
  // A declaration: def test_total_is_shown, func TestTotal, fun `shows total`
  const declared = /(?:def|func|fun|function|void|Task|public)\s+`?([A-Za-z_]\w*)`?\s*\(/.exec(quote);
  return declared?.[1] ?? null;
}
