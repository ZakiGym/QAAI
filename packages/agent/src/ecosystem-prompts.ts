/**
 * What "idiomatic" means in each test ecosystem (§3.2, §7b).
 *
 * The Generator's job is not to emit code that compiles — it is to emit code the
 * team would have written themselves, because a test they would not have written
 * is a test they will not maintain. Those two things differ per ecosystem in
 * ways no generic instruction covers: a pytest test that uses setUp instead of a
 * fixture runs green and still reads as foreign; a JUnit 5 test written with
 * JUnit 4 annotations does not run at all.
 *
 * So each ecosystem gets a real fragment carrying its own idioms, its own
 * assertion library, its own way of waiting, and its own file-naming rule. The
 * rules that are genuinely universal — no fixed sleeps, resilient locators, one
 * behaviour per test, assert the user-visible outcome — live once in
 * UNIVERSAL_RULES and are stated to the model as system context, not repeated 39
 * times here.
 *
 * The path convention is part of the ecosystem, not a detail: QAAI writes the
 * file, and a Go test that is not named `*_test.go`, or a Java class whose name
 * does not match its file, is invisible to the runner. That failure is silent —
 * a green run over zero collected tests — which is why `filePattern` exists and
 * why the generator falls back to the conventional path rather than trusting a
 * model-authored one that cannot be collected.
 */

import { FIXTURE_PREFIX, FRAMEWORKS_BY_LANGUAGE } from '@qaai/shared';
import type { Language, TestType, UiFramework } from '@qaai/shared';

// ─── The universal rules ─────────────────────────────────────────────────────

/**
 * Carried over from the Playwright prompt, which is the quality bar. These hold
 * in every language, so they are stated once — the ecosystem fragment below
 * says only what that ecosystem does differently.
 */
export const UNIVERSAL_RULES = `HOW TO WRITE A TEST, IN ANY LANGUAGE

- One behaviour per test. Each plan step becomes one named step, block, or
  section whose title is that step in plain English — the cockpit renders those
  titles as the timeline, so they must read like a human wrote them.
- Locators, in order of preference: role + accessible name, then label, then
  visible text, then an explicit test id. Reach for CSS or XPath only when
  nothing else can work, and say so in reviewFlags.
- Never sleep for a fixed duration. Wait for the thing you actually care about —
  an element state, a response, a computed value — and let the framework's own
  waiting do it wherever the framework has one.
- Assert the user-visible outcome, and assert meaning. Parsing a rendered total
  and checking the arithmetic is an assertion; "the word Cart appears somewhere"
  is not.
- Tests are independent and re-runnable: no ordering between tests, no shared
  mutable state, and no data left behind that a second run would trip over.
- Secrets are read from the environment, never written as literals.
- The suite's base URL is configured, so navigate with relative paths.
- No comments explaining what a line does. A comment is only worth writing when
  it explains something the code cannot show — e.g. why a value is expected.
- Use only the ecosystem's own libraries and whatever the plan names. Nothing
  from QAAI, and no helper module you did not write inside this one file.`;

// ─── Naming ──────────────────────────────────────────────────────────────────

const MAX_SEGMENT = 60;

/** Split on case boundaries and separators so "addToCart" and "add-to-cart" agree. */
function words(input: string, fallback: string): string[] {
  const parts = input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return parts.length > 0 ? parts : [fallback];
}

function kebab(input: string, fallback: string): string {
  return words(input, fallback).join('-').toLowerCase().slice(0, MAX_SEGMENT);
}

function snake(input: string, fallback: string): string {
  return words(input, fallback).join('_').toLowerCase().slice(0, MAX_SEGMENT);
}

function pascal(input: string, fallback: string): string {
  return words(input, fallback)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('')
    .slice(0, MAX_SEGMENT);
}

/**
 * A type name for the languages that require the file to be named after it.
 * Leading digits are legal in a slug and illegal in an identifier, so "2fa
 * login" becomes TestTwoFaLogin's less pretty cousin rather than a broken class.
 */
function className(input: string, suffix: string, fallback: string): string {
  const base = pascal(input, fallback);
  return `${/^[A-Za-z]/.test(base) ? base : `Test${base}`}${suffix}`;
}

/** A single lowercase package/namespace segment (Java, Kotlin, Go directories). */
function pkgSegment(input: string, fallback: string): string {
  const base = words(input, fallback).join('').toLowerCase().slice(0, MAX_SEGMENT);
  return /^[a-z]/.test(base) ? base : `t${base}`;
}

/** The two pieces every path convention is built from. */
export interface TestNameParts {
  /** The plan item's feature, e.g. "Checkout". */
  feature: string;
  /** The plan item's title, e.g. "Adds an item to the cart". */
  title: string;
}

// ─── The ecosystem shape ─────────────────────────────────────────────────────

export interface Ecosystem {
  readonly id: EcosystemId;
  /** Human label, used in prompts and review flags. */
  readonly label: string;
  /**
   * The language the generated code must be written in, or null when the
   * artifact is a DSL of its own — a .feature file is Gherkin, not Java, whoever
   * ends up writing the step definitions.
   */
  readonly language: Language | null;
  /** The prompt fragment: this ecosystem's idioms, and nothing universal. */
  readonly rules: string;
  /** Stated to the model, because in half these ecosystems the path is load-bearing. */
  readonly pathRule: string;
  /** A path the runner can actually collect. Anything else silently never runs. */
  readonly filePattern: RegExp;
  /** The conventional path for one generated test. */
  readonly path: (parts: TestNameParts) => string;
}

export const ECOSYSTEM_IDS = [
  // JavaScript / TypeScript
  'PLAYWRIGHT_TS',
  'CYPRESS',
  'WEBDRIVERIO',
  'PUPPETEER',
  'NIGHTWATCH',
  'TESTCAFE',
  'JEST',
  'VITEST',
  // Python
  'PLAYWRIGHT_PYTHON',
  'SELENIUM_PYTHON',
  'APPIUM_PYTHON',
  'PYTEST',
  'UNITTEST',
  'ROBOT',
  // Java
  'PLAYWRIGHT_JAVA',
  'SELENIUM_JAVA',
  'APPIUM_JAVA',
  'JUNIT5',
  'TESTNG',
  // Kotlin
  'PLAYWRIGHT_KOTLIN',
  'SELENIUM_KOTLIN',
  'ESPRESSO',
  'JUNIT5_KOTLIN',
  // C#
  'PLAYWRIGHT_CSHARP',
  'SELENIUM_CSHARP',
  'NUNIT',
  'XUNIT',
  // Ruby
  'CAPYBARA_RSPEC',
  'SELENIUM_RUBY',
  'RSPEC',
  'MINITEST',
  // Go
  'PLAYWRIGHT_GO',
  'CHROMEDP',
  'GO_TEST',
  // PHP
  'PANTHER',
  'CODECEPTION',
  'PHPUNIT',
  'PEST',
  // Cross-language
  'CUCUMBER',
] as const;
export type EcosystemId = (typeof ECOSYSTEM_IDS)[number];

// ─── Runner bases, shared by the drivers that sit on them ────────────────────
//
// A Selenium/Java test IS a JUnit 5 test that happens to drive a browser, so the
// JUnit 5 idioms are written once and composed in. Composition here, not
// abstraction in the prompt: the model still receives one flat, self-contained
// fragment.

const PYTEST_BASE = `pytest idioms:
- Plain functions named test_*, snake_case, type-hinted. No unittest.TestCase,
  no setUp/tearDown — fixtures instead, and in conftest.py once more than one
  module needs them.
- Bare \`assert\` on a meaningful expression; never self.assertEqual. pytest
  rewrites assertions, so the diff comes for free.
- @pytest.mark.parametrize for an input table, never a loop inside one test.
- pytest.raises as a context manager for error cases, asserting the message.
- monkeypatch / tmp_path fixtures over hand-rolled patching and temp dirs.`;

const JUNIT5_BASE = `JUnit 5 idioms:
- org.junit.jupiter.api: @Test, @BeforeEach/@AfterEach, @DisplayName carrying a
  sentence a non-engineer can read. Never @RunWith, @Before, or
  org.junit.Assert — that is JUnit 4 and it will not run here.
- Test classes and test methods are package-private; JUnit 5 needs no public.
- AssertJ: assertThat(actual).isEqualTo(expected) / .contains(...) — fluent, and
  its failure message names the difference. Fall back to Assertions.assertEquals
  only if AssertJ is not available, and say so in reviewFlags.
- @ParameterizedTest with @CsvSource/@MethodSource for tables; @Nested plus
  @DisplayName to group related cases.
- assertThrows for error cases, asserting on the exception message.`;

const JUNIT5_KOTLIN_BASE = `JUnit 5 in Kotlin idioms:
- @Test on a function whose name is a backticked sentence —
  fun \`adds an item to the cart\`() — with @BeforeEach/@AfterEach. Never JUnit 4.
- AssertJ's assertThat(...), or kotlin.test's assertEquals(expected, actual).
- val by default; lateinit var only for state that @BeforeEach assigns.
- @ParameterizedTest with @CsvSource/@MethodSource for tables; @Nested with
  @DisplayName for grouping.
- assertThrows<T> { ... } for error cases.`;

const NUNIT_BASE = `NUnit idioms:
- [TestFixture] class, [Test] methods, [SetUp]/[TearDown], [OneTimeSetUp] only
  for genuinely shared, read-only cost.
- The constraint model, always: Assert.That(actual, Is.EqualTo(expected)),
  Does.Contain, Is.True, Throws.TypeOf<T>(). Never the classic Assert.AreEqual.
- [TestCase(...)] for input tables, [TestCaseSource] when the data needs code.
- Async tests return Task — never async void, which the runner cannot await.
- Environment.GetEnvironmentVariable("NAME") for secrets.`;

const RSPEC_BASE = `RSpec idioms:
- describe for the thing, context for the condition ("when ...", "with ..."),
  it for one behaviour, phrased as a sentence and never containing "should".
- let / let! for lazily-built state; never an instance variable assigned in a
  before block.
- The expect syntax only: expect(actual).to eq(expected). Never should.
- Matchers that read as English: include, match, have_attributes, raise_error,
  change { ... }.by(1).
- One expectation per example, or aggregate_failures when a single outcome
  genuinely needs several checks.`;

const GO_TEST_BASE = `go test idioms:
- Table-driven: a []struct{name string; ...; want ...} literal, then
  for _, tt := range tests { t.Run(tt.name, func(t *testing.T) { ... }) }.
  t.Parallel() in the subtest when the cases share nothing.
- Assume no assertion library. Compare directly (or with cmp.Diff) and report
  with t.Errorf("Total() = %v, want %v", got, want) — got before want, always.
- t.Fatalf only where continuing would panic; t.Errorf everywhere else so one
  run reports every failure it found.
- t.Cleanup for teardown, t.Helper() in any helper that reports failures.
- Never time.Sleep: poll against a deadline, or wait on a channel/context.`;

const PHPUNIT_BASE = `PHPUnit idioms:
- declare(strict_types=1), a final class extending PHPUnit\\Framework\\TestCase,
  and a class name that matches the file name exactly (PSR-4).
- assertSame over assertEquals for scalars — assertEquals coerces, so "1080"
  would pass for 1080.
- #[DataProvider] attributes for input tables, not a foreach inside one test.
- expectException immediately before the call that throws, plus the message.
- setUp/tearDown for fixtures; no logic in the constructor.`;

const JEST_BASE = `Jest idioms:
- describe/it, one behaviour per it, described as a sentence.
- expect(x).toBe(...) for primitives, toEqual for structures, toMatchObject for
  a subset. Never expect(a === b).toBe(true) — it throws the diff away.
- await expect(promise).rejects.toThrow(...) for async errors, and always
  return or await the assertion so a rejection cannot escape the test.
- jest.fn()/jest.spyOn with a restore in afterEach; never leave a global patched.
- beforeEach for state, not beforeAll — beforeAll state leaks between tests.
- jest.useFakeTimers() instead of waiting on real time.
- No snapshot where a direct assertion would say more.`;

// ─── The registry ────────────────────────────────────────────────────────────

const TS_SPEC = /\.(spec|test)\.[cm]?[jt]sx?$/;
const PY_TEST = /(^|\/)(test_[^/]+|[^/]+_test)\.py$/;

export const ECOSYSTEMS: Record<EcosystemId, Ecosystem> = {
  // ── JavaScript / TypeScript ────────────────────────────────────────────────

  PLAYWRIGHT_TS: {
    id: 'PLAYWRIGHT_TS',
    label: 'Playwright (TypeScript)',
    language: 'TYPESCRIPT',
    rules: `Write a TypeScript spec for @playwright/test.

  import { test, expect } from '@playwright/test';

  test('<name>', async ({ page }) => {
    await test.step('<step title>', async () => { ... });
  });

- One test() per file, one test.step() per plan step.
- Locators:
    page.getByRole('button', { name: 'Add to cart' })
    page.getByLabel('Email address')
    page.getByPlaceholder(...)  /  page.getByText(...)
    page.getByTestId('order-total')
- Playwright auto-waits, so waitForTimeout is never needed and never allowed. If
  you need to wait for something specific, assert on it.
- page.goto('/cart') — baseURL is configured.
- Web-first assertions (await expect(locator).toHaveText(...)) over reading a
  value into a variable, except where you need arithmetic.
- process.env.NAME for secrets.`,
    pathRule: 'a feature directory plus <kebab-title>.spec.ts',
    filePattern: TS_SPEC,
    // No `tests/` prefix: the repo exporter adds it, and the fixtures guard in
    // the generator reads the first segment.
    path: ({ feature, title }) => `${kebab(feature, 'general')}/${kebab(title, 'test')}.spec.ts`,
  },

  CYPRESS: {
    id: 'CYPRESS',
    label: 'Cypress',
    language: 'TYPESCRIPT',
    rules: `Write a Cypress spec in TypeScript.

  describe('<feature>', () => {
    it('<name>', () => { ... });
  });

- cy.visit('/cart'); baseUrl lives in cypress.config.ts.
- Locators: cy.findByRole / cy.findByLabelText when Testing Library is present,
  otherwise cy.contains('button', 'Add to cart') and a data-cy attribute.
- Never cy.wait(<number>). Use cy.intercept() with an alias, then cy.wait('@alias').
- Retry-ability lives in .should(), so chain assertions off the subject —
  cy.get(...).should('have.text', ...) — and never assign a subject to a
  variable to assert on later.
- Prefer .should() over .then(); reach for .then() only for genuine JS work.
- Cypress.env('NAME') for secrets.`,
    pathRule: 'cypress/e2e/<feature>/<kebab-title>.cy.ts',
    filePattern: /\.cy\.[jt]sx?$/,
    path: ({ feature, title }) =>
      `cypress/e2e/${kebab(feature, 'general')}/${kebab(title, 'test')}.cy.ts`,
  },

  WEBDRIVERIO: {
    id: 'WEBDRIVERIO',
    label: 'WebdriverIO',
    language: 'TYPESCRIPT',
    rules: `Write a WebdriverIO (v8+) spec in TypeScript, Mocha style.

  describe('<feature>', () => {
    it('<name>', async () => {
      await browser.url('/cart');
      await $('button=Add to cart').click();
      await expect($('[data-test="cart-count"]')).toHaveText('1 item');
    });
  });

- Every command is awaited; the async API is the only supported one.
- Locators: accessibility id (~add-to-cart) first, then link/button text
  ($('button=Add to cart')), then a data attribute. Avoid deep CSS chains.
- expect-webdriverio matchers poll: await expect(el).toBeDisplayed() /
  toHaveText(...). browser.pause() is never acceptable.
- browser.waitUntil(fn, { timeoutMsg }) for a condition of your own, with a
  message that says what was being waited for.
- baseUrl is in wdio.conf.ts, so browser.url() takes a path.`,
    pathRule: 'test/specs/<feature>/<kebab-title>.spec.ts',
    filePattern: TS_SPEC,
    path: ({ feature, title }) =>
      `test/specs/${kebab(feature, 'general')}/${kebab(title, 'test')}.spec.ts`,
  },

  PUPPETEER: {
    id: 'PUPPETEER',
    label: 'Puppeteer (Jest)',
    language: 'TYPESCRIPT',
    rules: `Write a Puppeteer test in TypeScript, run by Jest.

- Launch and close the browser in beforeAll/afterAll; open a fresh page in
  beforeEach so no test inherits another's state.
- page.locator(...) (Puppeteer 20+) auto-waits and is the first choice. Where you
  must use the older API, await page.waitForSelector(sel, { visible: true })
  before interacting, and page.waitForFunction for a computed condition.
- Puppeteer has only CSS/XPath, so prefer a data attribute and put any
  structural selector in reviewFlags.
- Read what the user sees with page.$eval(sel, (el) => el.textContent) and assert
  on that value.
- There is no baseURL: build the URL from process.env.QAAI_BASE_URL.
- Never page.waitForTimeout, never a bare setTimeout.

${JEST_BASE}`,
    pathRule: 'a feature directory plus <kebab-title>.test.ts',
    filePattern: TS_SPEC,
    path: ({ feature, title }) => `${kebab(feature, 'general')}/${kebab(title, 'test')}.test.ts`,
  },

  NIGHTWATCH: {
    id: 'NIGHTWATCH',
    label: 'Nightwatch',
    language: 'TYPESCRIPT',
    rules: `Write a Nightwatch test in TypeScript.

  describe('<feature>', function () {
    it('<name>', function (browser) {
      browser
        .navigateTo('/cart')
        .click('button[data-test="add-to-cart"]')
        .waitForElementVisible('[data-test="cart-count"]')
        .assert.textContains('[data-test="cart-count"]', '1 item');
    });
  });

- The command chain is the test. Assertions are browser.assert.* or
  browser.expect.element(...).text.to.contain(...).
- waitForElementVisible / waitForElementPresent are the waits; browser.pause(ms)
  is never acceptable.
- Page objects in page_objects/ once more than one page is involved, using
  elements and sections rather than repeated selectors.
- launch_url is configured, so navigateTo() takes a path.
- The runner ends the session; do not call browser.end() in the test body.`,
    pathRule: 'tests/<feature>/<kebab-title>.test.ts',
    filePattern: TS_SPEC,
    path: ({ feature, title }) =>
      `tests/${kebab(feature, 'general')}/${kebab(title, 'test')}.test.ts`,
  },

  TESTCAFE: {
    id: 'TESTCAFE',
    label: 'TestCafe',
    language: 'TYPESCRIPT',
    rules: `Write a TestCafe test in TypeScript.

  import { Selector } from 'testcafe';

  fixture('<feature>').page('/cart');

  test('<name>', async (t) => {
    await t.click(Selector('button').withText('Add to cart'));
    await t.expect(Selector('[data-test="cart-count"]').innerText).contains('1 item');
  });

- fixture(...).page(...) at the top of the file; one test() per behaviour.
- Selector(...).withText / withAttribute / nth. TestCafe has no role engine, so
  flag any structural selector in reviewFlags.
- t.expect(...) assertions carry TestCafe's smart wait — t.wait(ms) is never
  acceptable.
- Selector properties (innerText, exists, visible) are awaited implicitly inside
  t.expect; do not await them into a variable and assert later, which freezes the
  value and loses the retry.
- Role(...) for authenticated setup instead of repeating a login flow per test.`,
    pathRule: 'tests/<feature>/<kebab-title>.test.ts',
    filePattern: TS_SPEC,
    path: ({ feature, title }) =>
      `tests/${kebab(feature, 'general')}/${kebab(title, 'test')}.test.ts`,
  },

  JEST: {
    id: 'JEST',
    label: 'Jest',
    language: 'TYPESCRIPT',
    rules: `Write a Jest test in TypeScript.

  describe('<unit under test>', () => {
    it('<behaviour>', () => {
      expect(total(items)).toBe(1080);
    });
  });

${JEST_BASE}`,
    pathRule: 'tests/<feature>/<kebab-title>.test.ts',
    filePattern: TS_SPEC,
    path: ({ feature, title }) =>
      `tests/${kebab(feature, 'general')}/${kebab(title, 'test')}.test.ts`,
  },

  VITEST: {
    id: 'VITEST',
    label: 'Vitest',
    language: 'TYPESCRIPT',
    rules: `Write a Vitest test in TypeScript.

  import { describe, expect, it } from 'vitest';

- Import describe/it/expect explicitly from 'vitest'; do not rely on globals
  being enabled.
- One behaviour per it(), named as a sentence.
- expect(x).toBe / toEqual / toMatchObject; await expect(p).rejects.toThrow(...).
- vi.fn / vi.spyOn / vi.mock, with vi.restoreAllMocks() in afterEach.
- vi.useFakeTimers() with await vi.advanceTimersByTimeAsync(...) instead of
  waiting on real time.
- it.each for an input table.
- No snapshot where a direct assertion would say more.`,
    pathRule: 'tests/<feature>/<kebab-title>.test.ts',
    filePattern: TS_SPEC,
    path: ({ feature, title }) =>
      `tests/${kebab(feature, 'general')}/${kebab(title, 'test')}.test.ts`,
  },

  // ── Python ────────────────────────────────────────────────────────────────

  PLAYWRIGHT_PYTHON: {
    id: 'PLAYWRIGHT_PYTHON',
    label: 'Playwright (Python, pytest)',
    language: 'PYTHON',
    rules: `Write a pytest test driving the sync Playwright API (pytest-playwright).

  from playwright.sync_api import Page, expect

  def test_adds_item_to_cart(page: Page) -> None:
      page.goto("/cart")
      page.get_by_role("button", name="Add to cart").click()
      expect(page.get_by_test_id("cart-count")).to_have_text("1 item")

- The \`page\` fixture comes from pytest-playwright. Never launch a browser,
  create a context, or write a setUp — a fixture in conftest.py is the way to
  share anything.
- Locators: page.get_by_role / get_by_label / get_by_placeholder / get_by_text /
  get_by_test_id, in that order.
- expect() imported from playwright.sync_api retries; a bare assert on a locator
  does not, and is the single most common cause of a flaky Python suite.
- page.wait_for_timeout and time.sleep are never acceptable.
- base_url is configured, so goto() takes a path.
- os.environ["NAME"] for secrets.
- pytest has no test.step equivalent: keep the body in plan-step order rather
  than inventing a step helper.

${PYTEST_BASE}`,
    pathRule: 'tests/<feature>/test_<snake_title>.py — pytest only collects test_*.py',
    filePattern: PY_TEST,
    path: ({ feature, title }) =>
      `tests/${snake(feature, 'general')}/test_${snake(title, 'case')}.py`,
  },

  SELENIUM_PYTHON: {
    id: 'SELENIUM_PYTHON',
    label: 'Selenium (Python, pytest)',
    language: 'PYTHON',
    rules: `Write a Selenium WebDriver test in Python, run by pytest.

  @pytest.fixture
  def driver() -> Iterator[WebDriver]:
      driver = webdriver.Chrome()
      yield driver
      driver.quit()

- The driver is a fixture that yields and quits in teardown, so a failing test
  cannot leak a browser.
- Explicit waits only:
  WebDriverWait(driver, 10).until(EC.element_to_be_clickable((By.CSS_SELECTOR, ...))).
  Never time.sleep, and never combine an implicit wait with explicit waits — the
  two together produce timeouts nobody can predict.
- Locators: By.CSS_SELECTOR with a stable data attribute; XPath last, and flagged.
- Assert on element.text or a parsed value, not on presence alone.
- Page objects as plain classes once more than one page is involved; assertions
  stay in the test, never inside the page object.

${PYTEST_BASE}`,
    pathRule: 'tests/<feature>/test_<snake_title>.py — pytest only collects test_*.py',
    filePattern: PY_TEST,
    path: ({ feature, title }) =>
      `tests/${snake(feature, 'general')}/test_${snake(title, 'case')}.py`,
  },

  APPIUM_PYTHON: {
    id: 'APPIUM_PYTHON',
    label: 'Appium (Python, pytest)',
    language: 'PYTHON',
    rules: `Write an Appium mobile test in Python, run by pytest.

- A fixture builds the driver from UiAutomator2Options/XCUITestOptions, yields
  it, and quits it in teardown.
- Locators: AppiumBy.ACCESSIBILITY_ID first — it is the one that survives both
  platforms and a redesign — then ANDROID_UIAUTOMATOR / IOS_CLASS_CHAIN. XPath is
  a last resort and slow enough to be worth a reviewFlag.
- WebDriverWait(driver, 10).until(EC.visibility_of_element_located(...)) before
  every interaction; time.sleep is never acceptable.
- Assert on the text the user reads, not on an element existing in the tree.

${PYTEST_BASE}`,
    pathRule: 'tests/<feature>/test_<snake_title>.py — pytest only collects test_*.py',
    filePattern: PY_TEST,
    path: ({ feature, title }) =>
      `tests/${snake(feature, 'general')}/test_${snake(title, 'case')}.py`,
  },

  PYTEST: {
    id: 'PYTEST',
    label: 'pytest',
    language: 'PYTHON',
    rules: `Write a pytest module.

  import pytest

  @pytest.fixture
  def cart() -> Cart:
      return Cart()

  @pytest.mark.parametrize(("quantity", "expected"), [(1, 1080), (2, 2160)])
  def test_total_includes_tax(cart: Cart, quantity: int, expected: int) -> None:
      cart.add(item, quantity)
      assert cart.total() == expected

${PYTEST_BASE}`,
    pathRule: 'tests/<feature>/test_<snake_title>.py — pytest only collects test_*.py',
    filePattern: PY_TEST,
    path: ({ feature, title }) =>
      `tests/${snake(feature, 'general')}/test_${snake(title, 'case')}.py`,
  },

  UNITTEST: {
    id: 'UNITTEST',
    label: 'unittest (stdlib)',
    language: 'PYTHON',
    rules: `Write a unittest module. The project asked for the standard library
runner, so use no pytest-only features (no bare-assert rewriting, no fixtures,
no parametrize).

  import unittest

  class CartTotals(unittest.TestCase):
      def setUp(self) -> None:
          self.cart = Cart()

      def test_total_includes_tax(self) -> None:
          self.assertEqual(self.cart.total(), 1080)

- One TestCase class per behaviour cluster; methods named test_*.
- Always the specific assertion — assertEqual, assertIn, assertIsNone,
  assertAlmostEqual. assertTrue(a == b) reports "False is not true", which tells
  a future reader nothing.
- setUp/tearDown, and addCleanup for anything that must be undone: cleanups still
  run when setUp raises halfway through.
- with self.subTest(...) for table cases, so one failing row does not hide the rest.
- with self.assertRaises(...) as ctx for error cases, then assert the message.
- No "if __name__ == '__main__'" block unless the plan says the file is run directly.`,
    pathRule: 'tests/<feature>/test_<snake_title>.py',
    filePattern: PY_TEST,
    path: ({ feature, title }) =>
      `tests/${snake(feature, 'general')}/test_${snake(title, 'case')}.py`,
  },

  ROBOT: {
    id: 'ROBOT',
    label: 'Robot Framework',
    language: null,
    rules: `Write a Robot Framework suite file.

  *** Settings ***
  Library           Browser
  Suite Setup       New Browser    chromium
  Test Setup        New Context    baseURL=%{QAAI_BASE_URL}

  *** Variables ***
  \${CART_COUNT}     [data-test="cart-count"]

  *** Test Cases ***
  Adds An Item To The Cart
      [Documentation]    A shopper adds one item and the cart count updates.
      New Page      /cart
      Click         role=button[name="Add to cart"]
      Get Text      \${CART_COUNT}    ==    1 item

- Keyword-driven: a test case body is a list of keyword calls, each one plan step
  in English. Anything procedural moves into a *** Keywords *** section under a
  business-readable name — that reusable vocabulary is the whole point of Robot.
- Arguments are separated from the keyword by at least two spaces (four by
  convention). One space is a syntax error, and it is the mistake generators make.
- Waits: Browser library keywords auto-wait; with SeleniumLibrary use
  Wait Until Element Is Visible. The Sleep keyword is never acceptable.
- Assertions are keywords too: Get Text ... == expected, Should Be Equal,
  Should Contain, and Wait Until Keyword Succeeds for genuinely eventual state.
- %{ENV_VAR} for secrets, \${VARIABLE} for suite data, [Tags] instead of ordering.`,
    pathRule: 'tests/<feature>/<snake_title>.robot',
    filePattern: /\.robot$/,
    path: ({ feature, title }) =>
      `tests/${snake(feature, 'general')}/${snake(title, 'case')}.robot`,
  },

  // ── Java ──────────────────────────────────────────────────────────────────

  PLAYWRIGHT_JAVA: {
    id: 'PLAYWRIGHT_JAVA',
    label: 'Playwright (Java, JUnit 5)',
    language: 'JAVA',
    rules: `Write a Playwright for Java test on JUnit 5.

  import com.microsoft.playwright.Page;
  import com.microsoft.playwright.junit.UsePlaywright;
  import com.microsoft.playwright.options.AriaRole;
  import static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat;

  @UsePlaywright
  class AddsItemToCartTest {
    @Test
    @DisplayName("Adds an item to the cart")
    void addsItemToCart(Page page) { ... }
  }

- @UsePlaywright injects Page/BrowserContext per test. Never create a Playwright
  instance, browser, or context by hand — the fixture closes them for you.
- Locators: page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("Add to cart")),
  getByLabel, getByText, getByTestId.
- assertThat(locator).hasText(...) from PlaywrightAssertions retries;
  Assertions.assertEquals on a locator's text does not.
- page.navigate("/cart") — the base URL is configured on the context.
- Thread.sleep and page.waitForTimeout are never acceptable.
- System.getenv("NAME") for secrets.
- The file's package declaration must match its directory.

${JUNIT5_BASE}`,
    pathRule:
      'src/test/java/tests/<feature>/<ClassName>Test.java — the class name, file name, and package must agree',
    filePattern: /(Test|Tests|IT)\.java$/,
    path: ({ feature, title }) =>
      `src/test/java/tests/${pkgSegment(feature, 'general')}/${className(title, 'Test', 'Case')}.java`,
  },

  SELENIUM_JAVA: {
    id: 'SELENIUM_JAVA',
    label: 'Selenium (Java, JUnit 5)',
    language: 'JAVA',
    rules: `Write a Selenium WebDriver test in Java, run by JUnit 5.

  class CheckoutTest {
    private WebDriver driver;
    private WebDriverWait wait;

    @BeforeEach
    void setUp() {
      driver = new ChromeDriver();
      wait = new WebDriverWait(driver, Duration.ofSeconds(10));
    }

    @AfterEach
    void tearDown() {
      if (driver != null) driver.quit();
    }
  }

- Explicit waits only:
  wait.until(ExpectedConditions.elementToBeClickable(By.cssSelector(...))).
  Thread.sleep is never acceptable, and an implicit wait must never be combined
  with explicit waits — together they produce timeouts nobody can predict.
- Locators: By.id, then By.cssSelector with a stable data attribute. XPath is a
  last resort, and a text-derived XPath breaks on the first copy edit.
- driver.quit() in @AfterEach, null-guarded, so a failed setup cannot leak a
  browser process.
- A Page Object once the plan touches more than one page — but assertions stay in
  the test, never inside the page object.
- driver.get(System.getenv("QAAI_BASE_URL") + "/cart").
- The file's package declaration must match its directory.

${JUNIT5_BASE}`,
    pathRule:
      'src/test/java/tests/<feature>/<ClassName>Test.java — the class name, file name, and package must agree',
    filePattern: /(Test|Tests|IT)\.java$/,
    path: ({ feature, title }) =>
      `src/test/java/tests/${pkgSegment(feature, 'general')}/${className(title, 'Test', 'Case')}.java`,
  },

  APPIUM_JAVA: {
    id: 'APPIUM_JAVA',
    label: 'Appium (Java, JUnit 5)',
    language: 'JAVA',
    rules: `Write an Appium mobile test in Java, run by JUnit 5.

- Build the driver from UiAutomator2Options / XCUITestOptions in @BeforeEach and
  driver.quit() in @AfterEach, null-guarded.
- Locators: AppiumBy.accessibilityId first — it is the one that survives both
  platforms — then AppiumBy.androidUIAutomator / iOSClassChain. XPath is a last
  resort, slow enough on a device to be worth a reviewFlag.
- WebDriverWait with ExpectedConditions before every interaction. Thread.sleep is
  never acceptable.
- Assert on the text the user reads, not on presence in the element tree.
- The file's package declaration must match its directory.

${JUNIT5_BASE}`,
    pathRule:
      'src/test/java/tests/<feature>/<ClassName>Test.java — the class name, file name, and package must agree',
    filePattern: /(Test|Tests|IT)\.java$/,
    path: ({ feature, title }) =>
      `src/test/java/tests/${pkgSegment(feature, 'general')}/${className(title, 'Test', 'Case')}.java`,
  },

  JUNIT5: {
    id: 'JUNIT5',
    label: 'JUnit 5',
    language: 'JAVA',
    rules: `Write a JUnit 5 test class.

  class CartTotalsTest {
    @Test
    @DisplayName("The total includes tax")
    void totalIncludesTax() {
      assertThat(cart.total()).isEqualTo(1080);
    }
  }

${JUNIT5_BASE}
- The file's package declaration must match its directory.`,
    pathRule:
      'src/test/java/tests/<feature>/<ClassName>Test.java — the class name, file name, and package must agree',
    filePattern: /(Test|Tests|IT)\.java$/,
    path: ({ feature, title }) =>
      `src/test/java/tests/${pkgSegment(feature, 'general')}/${className(title, 'Test', 'Case')}.java`,
  },

  TESTNG: {
    id: 'TESTNG',
    label: 'TestNG',
    language: 'JAVA',
    rules: `Write a TestNG test class.

  public class CheckoutTest {
    @BeforeMethod
    public void setUp() { ... }

    @Test(description = "Adds an item to the cart")
    public void addsItemToCart() { ... }
  }

- org.testng.annotations only: @Test, @BeforeMethod/@AfterMethod. @BeforeClass is
  for genuinely shared, read-only setup — TestNG reuses ONE instance across
  methods, so any per-test state built there leaks between tests.
- org.testng.Assert takes (actual, expected) — the opposite order to JUnit — and
  always pass the message argument: assertEquals(actual, expected, "cart total").
- @DataProvider for an input table, never a loop inside one test.
- description = "..." on every @Test so the report reads as English.
- groups for selection. Never dependsOnMethods to sequence unrelated tests: that
  turns one failure into a cascade of skips.
- expectedExceptions for error cases.
- The file's package declaration must match its directory.`,
    pathRule:
      'src/test/java/tests/<feature>/<ClassName>Test.java — the class name, file name, and package must agree',
    filePattern: /(Test|Tests|IT)\.java$/,
    path: ({ feature, title }) =>
      `src/test/java/tests/${pkgSegment(feature, 'general')}/${className(title, 'Test', 'Case')}.java`,
  },

  // ── Kotlin ────────────────────────────────────────────────────────────────

  PLAYWRIGHT_KOTLIN: {
    id: 'PLAYWRIGHT_KOTLIN',
    label: 'Playwright (Kotlin, JUnit 5)',
    language: 'KOTLIN',
    rules: `Write a Playwright for Java test in Kotlin, run by JUnit 5.

  @UsePlaywright
  class AddsItemToCartTest {
    @Test
    fun \`adds an item to the cart\`(page: Page) {
      page.navigate("/cart")
      page.getByRole(AriaRole.BUTTON, Page.GetByRoleOptions().setName("Add to cart")).click()
      assertThat(page.getByTestId("cart-count")).hasText("1 item")
    }
  }

- @UsePlaywright injects the Page; never build a browser or context by hand.
- Kotlin can drop \`new\`, so option objects read as Page.GetByRoleOptions().setName(...).
- assertThat(locator) from PlaywrightAssertions retries; a kotlin.test assertion
  on a locator's text does not.
- page.navigate("/cart") — the base URL is configured on the context.
- Thread.sleep and page.waitForTimeout are never acceptable.

${JUNIT5_KOTLIN_BASE}`,
    pathRule: 'src/test/kotlin/tests/<feature>/<ClassName>Test.kt',
    filePattern: /(Test|Tests)\.kt$/,
    path: ({ feature, title }) =>
      `src/test/kotlin/tests/${pkgSegment(feature, 'general')}/${className(title, 'Test', 'Case')}.kt`,
  },

  SELENIUM_KOTLIN: {
    id: 'SELENIUM_KOTLIN',
    label: 'Selenium (Kotlin, JUnit 5)',
    language: 'KOTLIN',
    rules: `Write a Selenium WebDriver test in Kotlin, run by JUnit 5.

- lateinit var driver: WebDriver built in @BeforeEach; driver.quit() in
  @AfterEach so a failure cannot leak a browser.
- Explicit waits only: WebDriverWait(driver, Duration.ofSeconds(10))
  .until(ExpectedConditions.elementToBeClickable(By.cssSelector(...))).
  Thread.sleep is never acceptable, and implicit waits must not be mixed in.
- Locators: By.id, then By.cssSelector on a stable data attribute; XPath last.
- Use \`apply\`/\`also\` for driver setup rather than a builder class nobody asked
  for, and keep assertions in the test rather than in a page object.

${JUNIT5_KOTLIN_BASE}`,
    pathRule: 'src/test/kotlin/tests/<feature>/<ClassName>Test.kt',
    filePattern: /(Test|Tests)\.kt$/,
    path: ({ feature, title }) =>
      `src/test/kotlin/tests/${pkgSegment(feature, 'general')}/${className(title, 'Test', 'Case')}.kt`,
  },

  ESPRESSO: {
    id: 'ESPRESSO',
    label: 'Espresso (Android, Kotlin)',
    language: 'KOTLIN',
    rules: `Write an Espresso instrumentation test in Kotlin.

  @RunWith(AndroidJUnit4::class)
  class CheckoutTest {
    @get:Rule
    val activityRule = ActivityScenarioRule(MainActivity::class.java)

    @Test
    fun addsItemToCart() {
      onView(withId(R.id.add_to_cart)).perform(click())
      onView(withId(R.id.cart_count)).check(matches(withText("1 item")))
    }
  }

- onView(matcher).perform(action) and onView(matcher).check(matches(matcher)) are
  the entire API. Never walk the view hierarchy yourself.
- Espresso synchronises with the main looper, so Thread.sleep is never
  acceptable. For work it cannot see — your own threads, network clients — register
  an IdlingResource and say so in reviewFlags.
- Interact by withId or withContentDescription; assert on withText, because that
  is what the user actually reads.
- onData for AdapterView content, RecyclerViewActions for a RecyclerView.
- ActivityScenarioRule, never the deprecated ActivityTestRule.
- @RunWith(AndroidJUnit4::class) is required here — this is the one place JUnit 4
  runner syntax is correct rather than a mistake.`,
    pathRule: 'app/src/androidTest/java/tests/<feature>/<ClassName>Test.kt',
    filePattern: /(Test|Tests)\.kt$/,
    path: ({ feature, title }) =>
      `app/src/androidTest/java/tests/${pkgSegment(feature, 'general')}/${className(title, 'Test', 'Case')}.kt`,
  },

  JUNIT5_KOTLIN: {
    id: 'JUNIT5_KOTLIN',
    label: 'JUnit 5 (Kotlin)',
    language: 'KOTLIN',
    rules: `Write a JUnit 5 test class in Kotlin.

  class CartTotalsTest {
    @Test
    fun \`the total includes tax\`() {
      assertThat(cart.total()).isEqualTo(1080)
    }
  }

${JUNIT5_KOTLIN_BASE}`,
    pathRule: 'src/test/kotlin/tests/<feature>/<ClassName>Test.kt',
    filePattern: /(Test|Tests)\.kt$/,
    path: ({ feature, title }) =>
      `src/test/kotlin/tests/${pkgSegment(feature, 'general')}/${className(title, 'Test', 'Case')}.kt`,
  },

  // ── C# ────────────────────────────────────────────────────────────────────

  PLAYWRIGHT_CSHARP: {
    id: 'PLAYWRIGHT_CSHARP',
    label: 'Playwright (.NET, NUnit)',
    language: 'CSHARP',
    rules: `Write a Playwright for .NET test on NUnit.

  using Microsoft.Playwright;
  using Microsoft.Playwright.NUnit;

  [Parallelizable(ParallelScope.Self)]
  public class AddsItemToCartTests : PageTest
  {
      [Test]
      public async Task Adds_item_to_cart()
      {
          await Page.GotoAsync("/cart");
          await Page.GetByRole(AriaRole.Button, new() { Name = "Add to cart" }).ClickAsync();
          await Expect(Page.GetByTestId("cart-count")).ToHaveTextAsync("1 item");
      }
  }

- Inherit PageTest and use the inherited Page. Never create a browser or context
  yourself — the base class owns their lifetime.
- Expect(locator).ToHaveTextAsync(...) retries. Assert.That is for values that
  are not locators.
- Every Playwright call is awaited and ends in Async; a missing await is a test
  that passes before the page has done anything.
- Page.WaitForTimeoutAsync, Task.Delay, and Thread.Sleep are never acceptable.
- BaseURL comes from the run settings, so GotoAsync takes a path.

${NUNIT_BASE}`,
    pathRule: 'Tests/<Feature>/<ClassName>Tests.cs — the class name matches the file name',
    filePattern: /(Test|Tests)\.cs$/,
    path: ({ feature, title }) =>
      `Tests/${pascal(feature, 'General')}/${className(title, 'Tests', 'Case')}.cs`,
  },

  SELENIUM_CSHARP: {
    id: 'SELENIUM_CSHARP',
    label: 'Selenium (C#, NUnit)',
    language: 'CSHARP',
    rules: `Write a Selenium WebDriver test in C#, run by NUnit.

- IWebDriver created in [SetUp]; Quit() in [TearDown] behind a null check so a
  failed setup cannot leak a browser process.
- Explicit waits only: new WebDriverWait(driver, TimeSpan.FromSeconds(10))
  .Until(d => d.FindElement(By.CssSelector(...)).Displayed). Thread.Sleep and
  Task.Delay are never acceptable, and implicit waits must not be mixed with
  explicit ones.
- Locators: By.Id, then By.CssSelector on a stable data attribute; XPath last.
- Page Objects once more than one page is involved; assertions stay in the test.
- Assert on the element's Text, not on FindElement not throwing.

${NUNIT_BASE}`,
    pathRule: 'Tests/<Feature>/<ClassName>Tests.cs — the class name matches the file name',
    filePattern: /(Test|Tests)\.cs$/,
    path: ({ feature, title }) =>
      `Tests/${pascal(feature, 'General')}/${className(title, 'Tests', 'Case')}.cs`,
  },

  NUNIT: {
    id: 'NUNIT',
    label: 'NUnit',
    language: 'CSHARP',
    rules: `Write an NUnit test fixture.

  [TestFixture]
  public class CartTotalsTests
  {
      [SetUp]
      public void SetUp() => _cart = new Cart();

      [TestCase(1, 1080)]
      [TestCase(2, 2160)]
      public void Total_includes_tax(int quantity, int expected)
      {
          _cart.Add(Item, quantity);
          Assert.That(_cart.Total, Is.EqualTo(expected));
      }
  }

${NUNIT_BASE}`,
    pathRule: 'Tests/<Feature>/<ClassName>Tests.cs — the class name matches the file name',
    filePattern: /(Test|Tests)\.cs$/,
    path: ({ feature, title }) =>
      `Tests/${pascal(feature, 'General')}/${className(title, 'Tests', 'Case')}.cs`,
  },

  XUNIT: {
    id: 'XUNIT',
    label: 'xUnit.net',
    language: 'CSHARP',
    rules: `Write an xUnit.net test class.

  public class CartTotalsTests
  {
      private readonly Cart _cart = new();

      [Fact]
      public void Total_includes_tax() => Assert.Equal(1080, _cart.Total);

      [Theory]
      [InlineData(1, 1080)]
      [InlineData(2, 2160)]
      public void Total_scales_with_quantity(int quantity, int expected) { ... }
  }

- [Fact] for one case, [Theory] with [InlineData]/[MemberData] for a table.
- There is no [SetUp] in xUnit: the constructor is per-test setup and
  IDisposable.Dispose is teardown, because xUnit builds a new instance per test.
  IClassFixture<T> is for something genuinely expensive and shared.
- Assert.Equal(expected, actual) — expected FIRST, the opposite of NUnit's
  constraint model. Assert.Contains, Assert.Throws<T>, await Assert.ThrowsAsync<T>.
- Never Assert.True(a == b): it throws away the diff and reports only "false".
- Async tests return Task.
- ITestOutputHelper for diagnostics; Console.WriteLine goes nowhere in xUnit.`,
    pathRule: 'Tests/<Feature>/<ClassName>Tests.cs — the class name matches the file name',
    filePattern: /(Test|Tests)\.cs$/,
    path: ({ feature, title }) =>
      `Tests/${pascal(feature, 'General')}/${className(title, 'Tests', 'Case')}.cs`,
  },

  // ── Ruby ──────────────────────────────────────────────────────────────────

  CAPYBARA_RSPEC: {
    id: 'CAPYBARA_RSPEC',
    label: 'Capybara (RSpec feature spec)',
    language: 'RUBY',
    rules: `Write a Capybara feature spec, run by RSpec.

  RSpec.feature "Checkout", type: :feature do
    scenario "adds an item to the cart" do
      visit "/cart"
      click_button "Add to cart"
      expect(page).to have_text("1 item")
    end
  end

- Capybara's matchers wait on their own — have_text, have_selector,
  have_current_path all retry. Never sleep, and never assert on page.text, which
  is a plain String snapshot with no retry and is the classic source of a flaky
  Ruby suite.
- Semantic helpers over selectors: click_button "Add to cart", click_link,
  fill_in "Email", with: ..., check, select ... from: ..., and
  within("#cart") { ... } to scope.
- For absence use the negative matcher — expect(page).to have_no_text(...) —
  which waits for the thing to go away instead of racing it.
- Capybara's app host is configured, so visit takes a path.

${RSPEC_BASE}`,
    pathRule: 'spec/features/<feature>/<snake_title>_spec.rb — RSpec collects *_spec.rb',
    filePattern: /_spec\.rb$/,
    path: ({ feature, title }) =>
      `spec/features/${snake(feature, 'general')}/${snake(title, 'case')}_spec.rb`,
  },

  SELENIUM_RUBY: {
    id: 'SELENIUM_RUBY',
    label: 'Selenium (Ruby, RSpec)',
    language: 'RUBY',
    rules: `Write a Selenium WebDriver test in Ruby, run by RSpec.

  let(:driver) { Selenium::WebDriver.for :chrome }
  after { driver.quit }

- Explicit waits only:
  Selenium::WebDriver::Wait.new(timeout: 10).until { driver.find_element(css: ...).displayed? }.
  sleep is never acceptable, and implicit waits must not be mixed in.
- driver.quit in an after hook so a failing example cannot leak a browser.
- Locators: find_element(css: '[data-test="add-to-cart"]'); XPath last, flagged.
- Assert on element.text through RSpec's expect, not on find_element not raising.

${RSPEC_BASE}`,
    pathRule: 'spec/<feature>/<snake_title>_spec.rb — RSpec collects *_spec.rb',
    filePattern: /_spec\.rb$/,
    path: ({ feature, title }) =>
      `spec/${snake(feature, 'general')}/${snake(title, 'case')}_spec.rb`,
  },

  RSPEC: {
    id: 'RSPEC',
    label: 'RSpec',
    language: 'RUBY',
    rules: `Write an RSpec spec.

  RSpec.describe Cart do
    subject(:cart) { described_class.new }
    let(:item) { Item.new(price: 1000) }

    context "when the item is taxable" do
      it "adds tax to the total" do
        cart.add(item)
        expect(cart.total).to eq(1080)
      end
    end
  end

${RSPEC_BASE}`,
    pathRule: 'spec/<feature>/<snake_title>_spec.rb — RSpec collects *_spec.rb',
    filePattern: /_spec\.rb$/,
    path: ({ feature, title }) =>
      `spec/${snake(feature, 'general')}/${snake(title, 'case')}_spec.rb`,
  },

  MINITEST: {
    id: 'MINITEST',
    label: 'Minitest',
    language: 'RUBY',
    rules: `Write a Minitest test.

  class CartTest < Minitest::Test
    def setup
      @cart = Cart.new
    end

    def test_total_includes_tax
      assert_equal 1080, @cart.total
    end
  end

- Methods named test_*, or Minitest::Spec's it blocks if the project already uses
  the spec DSL — never both styles in one file.
- assert_equal expected, actual (expected FIRST), assert_includes, assert_nil,
  assert_raises. Never assert a == b, whose failure message is literally "false".
- setup/teardown for fixtures. let and before are RSpec, not Minitest.
- Pass the message argument on any assertion whose failure would be cryptic.
- Tests run in random order by design: never depend on another test having run.`,
    pathRule: 'test/<feature>/<snake_title>_test.rb — Minitest collects *_test.rb',
    filePattern: /_test\.rb$/,
    path: ({ feature, title }) =>
      `test/${snake(feature, 'general')}/${snake(title, 'case')}_test.rb`,
  },

  // ── Go ────────────────────────────────────────────────────────────────────

  PLAYWRIGHT_GO: {
    id: 'PLAYWRIGHT_GO',
    label: 'Playwright (Go)',
    language: 'GO',
    rules: `Write a Go test driving playwright-go
(github.com/playwright-community/playwright-go).

  func TestAddsItemToCart(t *testing.T) {
      pw, err := playwright.Run()
      if err != nil {
          t.Fatalf("launch playwright: %v", err)
      }
      t.Cleanup(func() { _ = pw.Stop() })
      ...
  }

- Every playwright call returns an error. Check it and t.Fatalf with context —
  an ignored error here surfaces later as a nil-pointer panic that hides the real
  failure.
- Locators: page.GetByRole(playwright.AriaRoleButton,
  playwright.PageGetByRoleOptions{Name: "Add to cart"}), GetByLabel, GetByText,
  GetByTestId.
- Assertions retry through playwright.NewPlaywrightAssertions(): check the error
  it returns and report with t.Errorf.
- Close the browser and stop playwright in t.Cleanup, not at the end of the body,
  so a t.Fatalf still tears them down.
- time.Sleep is never acceptable.

${GO_TEST_BASE}`,
    pathRule: 'e2e/<feature>/<snake_title>_test.go — Go only compiles *_test.go as tests',
    filePattern: /_test\.go$/,
    path: ({ feature, title }) =>
      `e2e/${pkgSegment(feature, 'general')}/${snake(title, 'case')}_test.go`,
  },

  CHROMEDP: {
    id: 'CHROMEDP',
    label: 'chromedp (Go)',
    language: 'GO',
    rules: `Write a Go test driving chromedp.

  ctx, cancel := chromedp.NewContext(allocCtx)
  defer cancel()
  ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
  defer cancel()

  var count string
  err := chromedp.Run(ctx,
      chromedp.Navigate(baseURL+"/cart"),
      chromedp.Click(\`[data-test="add-to-cart"]\`, chromedp.ByQuery),
      chromedp.WaitVisible(\`[data-test="cart-count"]\`, chromedp.ByQuery),
      chromedp.Text(\`[data-test="cart-count"]\`, &count, chromedp.NodeVisible, chromedp.ByQuery),
  )

- One chromedp.Run holding an ordered list of actions per plan step. Always wrap
  the context in a timeout, or a hung page hangs the whole suite instead of
  failing one test.
- WaitVisible / WaitReady are the wait. chromedp.Sleep and time.Sleep are never
  acceptable.
- chromedp has only CSS/XPath, no role engine: prefer a data attribute and put
  any structural selector in reviewFlags.
- Values come back through pointers passed into the actions; assert on them in Go
  after Run returns.

${GO_TEST_BASE}`,
    pathRule: 'e2e/<feature>/<snake_title>_test.go — Go only compiles *_test.go as tests',
    filePattern: /_test\.go$/,
    path: ({ feature, title }) =>
      `e2e/${pkgSegment(feature, 'general')}/${snake(title, 'case')}_test.go`,
  },

  GO_TEST: {
    id: 'GO_TEST',
    label: 'go test',
    language: 'GO',
    rules: `Write a Go test.

  func TestCartTotal(t *testing.T) {
      tests := []struct {
          name  string
          items []Item
          want  int
      }{
          {name: "empty cart", want: 0},
          {name: "one taxable item", items: []Item{{Price: 1000}}, want: 1080},
      }
      for _, tt := range tests {
          t.Run(tt.name, func(t *testing.T) {
              t.Parallel()
              if got := Total(tt.items); got != tt.want {
                  t.Errorf("Total() = %d, want %d", got, tt.want)
              }
          })
      }
  }

${GO_TEST_BASE}
- The file sits beside the code it tests, in the same package — or package foo_test
  when the test should see only the exported API.`,
    pathRule: '<feature>/<snake_title>_test.go — Go only compiles *_test.go as tests',
    filePattern: /_test\.go$/,
    path: ({ feature, title }) =>
      `${pkgSegment(feature, 'general')}/${snake(title, 'case')}_test.go`,
  },

  // ── PHP ───────────────────────────────────────────────────────────────────

  PANTHER: {
    id: 'PANTHER',
    label: 'Symfony Panther (PHP)',
    language: 'PHP',
    rules: `Write a Symfony Panther test — a real browser, PHPUnit underneath.

  final class CheckoutTest extends PantherTestCase
  {
      public function testAddsItemToCart(): void
      {
          $client = static::createPantherClient();
          $client->request('GET', '/cart');
          $client->clickLink('Add to cart');
          $client->waitForVisibility('[data-test="cart-count"]');

          self::assertSelectorTextContains('[data-test="cart-count"]', '1 item');
      }
  }

- static::createPantherClient() owns the browser; never instantiate a driver.
- $client->waitFor / waitForVisibility / waitForElementToContain are the waits.
  sleep() and usleep() are never acceptable.
- Assert through the Panther assertions — assertSelectorTextContains,
  assertSelectorExists, assertPageTitleContains — which carry the user-visible
  meaning and the retry.
- $client->submitForm('Sign in', [...]) for forms rather than filling fields one
  at a time.
- The base URI is configured, so request() takes a path.

${PHPUNIT_BASE}`,
    pathRule: 'tests/E2E/<Feature>/<ClassName>Test.php — the class name matches the file name',
    filePattern: /Test\.php$/,
    path: ({ feature, title }) =>
      `tests/E2E/${pascal(feature, 'General')}/${className(title, 'Test', 'Case')}.php`,
  },

  CODECEPTION: {
    id: 'CODECEPTION',
    label: 'Codeception (PHP)',
    language: 'PHP',
    rules: `Write a Codeception acceptance test as a Cest class.

  final class CheckoutCest
  {
      public function _before(AcceptanceTester $I): void
      {
          $I->amOnPage('/cart');
      }

      public function addsItemToCart(AcceptanceTester $I): void
      {
          $I->click('Add to cart');
          $I->waitForText('1 item', 10, '[data-test="cart-count"]');
          $I->see('1 item', '[data-test="cart-count"]');
      }
  }

- Cest classes, not Cept scripts: one public method per behaviour, named as the
  behaviour, taking the AcceptanceTester as its only argument.
- $I->waitForElement / waitForText with an explicit timeout. $I->wait(n) as a
  blind pause is never acceptable.
- $I->see / dontSee / seeInField / seeCurrentUrlEquals carry the assertion —
  they are what makes the scenario readable as a user story.
- _before(AcceptanceTester $I) for shared setup, _after for cleanup.
- Locators: link/button text and named fields first; a strict locator array
  (['css' => '[data-test="..."]']) when the text is ambiguous.
- declare(strict_types=1) at the top.`,
    pathRule: 'tests/Acceptance/<ClassName>Cest.php — Codeception collects *Cest.php',
    filePattern: /Cest\.php$/,
    path: ({ feature, title }) =>
      `tests/Acceptance/${pascal(feature, 'General')}/${className(title, 'Cest', 'Case')}.php`,
  },

  PHPUNIT: {
    id: 'PHPUNIT',
    label: 'PHPUnit',
    language: 'PHP',
    rules: `Write a PHPUnit test.

  declare(strict_types=1);

  final class CartTest extends TestCase
  {
      protected function setUp(): void
      {
          $this->cart = new Cart();
      }

      public function testTotalIncludesTax(): void
      {
          self::assertSame(1080, $this->cart->total());
      }
  }

${PHPUNIT_BASE}`,
    pathRule: 'tests/<Feature>/<ClassName>Test.php — the class name matches the file name',
    filePattern: /Test\.php$/,
    path: ({ feature, title }) =>
      `tests/${pascal(feature, 'General')}/${className(title, 'Test', 'Case')}.php`,
  },

  PEST: {
    id: 'PEST',
    label: 'Pest (PHP)',
    language: 'PHP',
    rules: `Write a Pest test.

  it('adds an item to the cart', function () {
      $cart = new Cart();
      $cart->add($item);

      expect($cart->total())->toBe(1080);
  });

- Pest's function API only: it() / test(), beforeEach(), describe() for grouping.
  No class, no "extends TestCase" in the file — that is PHPUnit style and defeats
  the point of Pest.
- The description completes the sentence: "it adds an item to the cart".
- expect($actual)->toBe($expected) is strict; ->toEqual for loose, ->toContain,
  ->toThrow(Exception::class). Chain them: expect($n)->toBeInt()->toBeGreaterThan(0).
- ->with([...]) datasets for input tables, named when the rows deserve names.
- ->group('smoke') for selection rather than any ordering assumption.
- declare(strict_types=1) at the top.`,
    pathRule: 'tests/Feature/<Feature>/<ClassName>Test.php',
    filePattern: /Test\.php$/,
    path: ({ feature, title }) =>
      `tests/Feature/${pascal(feature, 'General')}/${className(title, 'Test', 'Case')}.php`,
  },

  // ── Cross-language ────────────────────────────────────────────────────────

  CUCUMBER: {
    id: 'CUCUMBER',
    label: 'Cucumber / Gherkin',
    language: null,
    rules: `Write a Gherkin feature file.

  Feature: Checkout
    Scenario: Adds an item to the cart
      Given I am viewing the cart
      When I add "Blue mug" to the cart
      Then the cart shows 1 item

- Declarative, never imperative. 'When I add "Blue mug" to the cart' is a
  specification; "When I click the element with id add-btn" is automation detail
  that belongs in a step definition and rots on the next redesign.
- One Given/When/Then arc per scenario, And/But for continuation. Background is
  for setup shared by every scenario in the file, and nothing else.
- Scenario Outline with an Examples table for input variants; quote the
  parameters so a step definition can capture them.
- Reuse existing step phrasing wherever it fits — every new phrasing is another
  step definition somebody has to write and maintain.
- @tags for selection instead of ordering assumptions.
- This file contains no automation, so list in reviewFlags every step phrase you
  introduced that the project would have to implement as a step definition.`,
    pathRule: 'features/<feature>/<snake_title>.feature',
    filePattern: /\.feature$/,
    path: ({ feature, title }) =>
      `features/${snake(feature, 'general')}/${snake(title, 'case')}.feature`,
  },
};

// ─── Selection ───────────────────────────────────────────────────────────────

/**
 * The (language, framework) matrix. Every pair FRAMEWORKS_BY_LANGUAGE permits
 * appears here — a project can only be configured with one of those, so a gap
 * would silently downgrade a real customer to a fallback prompt.
 */
const BY_LANGUAGE: Record<Language, Partial<Record<UiFramework, EcosystemId>>> = {
  TYPESCRIPT: {
    PLAYWRIGHT: 'PLAYWRIGHT_TS',
    CYPRESS: 'CYPRESS',
    WEBDRIVERIO: 'WEBDRIVERIO',
    PUPPETEER: 'PUPPETEER',
    NIGHTWATCH: 'NIGHTWATCH',
    TESTCAFE: 'TESTCAFE',
  },
  JAVASCRIPT: {
    PLAYWRIGHT: 'PLAYWRIGHT_TS',
    CYPRESS: 'CYPRESS',
    WEBDRIVERIO: 'WEBDRIVERIO',
    PUPPETEER: 'PUPPETEER',
    NIGHTWATCH: 'NIGHTWATCH',
    TESTCAFE: 'TESTCAFE',
  },
  JAVA: { PLAYWRIGHT: 'PLAYWRIGHT_JAVA', SELENIUM: 'SELENIUM_JAVA', APPIUM: 'APPIUM_JAVA' },
  PYTHON: { PLAYWRIGHT: 'PLAYWRIGHT_PYTHON', SELENIUM: 'SELENIUM_PYTHON', APPIUM: 'APPIUM_PYTHON' },
  CSHARP: { PLAYWRIGHT: 'PLAYWRIGHT_CSHARP', SELENIUM: 'SELENIUM_CSHARP' },
  RUBY: { CAPYBARA: 'CAPYBARA_RSPEC', SELENIUM: 'SELENIUM_RUBY' },
  KOTLIN: { PLAYWRIGHT: 'PLAYWRIGHT_KOTLIN', SELENIUM: 'SELENIUM_KOTLIN', ESPRESSO: 'ESPRESSO' },
  GO: { PLAYWRIGHT: 'PLAYWRIGHT_GO', CHROMEDP: 'CHROMEDP' },
  PHP: { PANTHER: 'PANTHER', CODECEPTION: 'CODECEPTION' },
};

/**
 * What a unit test is written with when there is no browser in the picture.
 * Where an ecosystem has two live conventions the more common modern default
 * wins, and the caller can override it with `runner`.
 */
const UNIT_RUNNER: Record<Language, EcosystemId> = {
  TYPESCRIPT: 'VITEST',
  JAVASCRIPT: 'VITEST',
  JAVA: 'JUNIT5',
  PYTHON: 'PYTEST',
  CSHARP: 'XUNIT',
  RUBY: 'RSPEC',
  KOTLIN: 'JUNIT5_KOTLIN',
  GO: 'GO_TEST',
  PHP: 'PHPUNIT',
};

/**
 * TypeScript and JavaScript share every runner and every idiom in this file, so
 * they share the fragment rather than duplicating six of them. What they do not
 * share is the part that breaks a repo: a .ts file full of type annotations
 * landing in a JavaScript project. That difference is mechanical, so it is
 * applied mechanically.
 */
const JAVASCRIPT_NOTE = `
This project is JavaScript, not TypeScript. Write plain .js — no type
annotations, no interfaces, no \`import type\`, no generics, and the file
extension is .js. Reach for a JSDoc type only where it genuinely helps a reader.`;

function asJavaScript(ecosystem: Ecosystem): Ecosystem {
  return {
    ...ecosystem,
    language: 'JAVASCRIPT',
    label: ecosystem.label.includes('TypeScript')
      ? ecosystem.label.replace('TypeScript', 'JavaScript')
      : `${ecosystem.label} — JavaScript`,
    rules: `${ecosystem.rules}\n${JAVASCRIPT_NOTE}`,
    pathRule: ecosystem.pathRule.replace(/\.tsx?\b/g, '.js'),
    path: (parts) => ecosystem.path(parts).replace(/\.tsx?$/, '.js'),
  };
}

export interface EcosystemSelection {
  language: Language;
  framework: UiFramework;
  /** UNIT_GEN has no browser, so it resolves to the language's unit runner. */
  testType?: TestType;
  /**
   * An explicit ecosystem, when the project knows better than the matrix does —
   * a Java shop on TestNG, a Python shop on Robot, a team writing Gherkin.
   */
  runner?: EcosystemId | null;
}

export function isEcosystemId(value: unknown): value is EcosystemId {
  return typeof value === 'string' && value in ECOSYSTEMS;
}

/**
 * Resolve one (language, framework) pair — plus any override — to the ecosystem
 * whose idioms the generated code must follow.
 *
 * When the two disagree (a Ruby project asking for Playwright, which the project
 * schema rejects but an API caller could still send) the LANGUAGE wins. Writing
 * Ruby is not negotiable for a Ruby team; which browser driver they use is.
 */
export function resolveEcosystem(selection: EcosystemSelection): Ecosystem {
  const { language, framework, testType, runner } = selection;

  // Applied to every branch, including an explicit runner: a JavaScript shop
  // that asks for Jest still wants .js.
  const dialect = (ecosystem: Ecosystem): Ecosystem =>
    language === 'JAVASCRIPT' && ecosystem.language === 'TYPESCRIPT'
      ? asJavaScript(ecosystem)
      : ecosystem;

  if (runner && isEcosystemId(runner)) return dialect(ECOSYSTEMS[runner]);

  // A unit/component test never drives a browser, so the UI framework is
  // irrelevant to it and the language's own runner is the whole answer.
  if (testType === 'UNIT_GEN') return dialect(ECOSYSTEMS[UNIT_RUNNER[language]]);

  const exact = BY_LANGUAGE[language][framework];
  if (exact) return dialect(ECOSYSTEMS[exact]);

  const fallbackFramework = FRAMEWORKS_BY_LANGUAGE[language][0];
  const byLanguage = fallbackFramework ? BY_LANGUAGE[language][fallbackFramework] : undefined;
  return dialect(ECOSYSTEMS[byLanguage ?? UNIT_RUNNER[language]]);
}

/**
 * The repo-relative path a generated test belongs at.
 *
 * `fixtures/` is reserved for test data — anything under it is excluded from run
 * selection. Features come from the crawl's first URL segment, so an app with a
 * top-level `/fixtures` route (a league site, a lighting store) would otherwise
 * put a real test somewhere it can never run.
 */
export function testFilePath(ecosystem: Ecosystem, parts: TestNameParts): string {
  const path = ecosystem.path(parts);
  const [head, ...rest] = path.split('/');
  const reserved = FIXTURE_PREFIX.slice(0, -1);
  return head === reserved ? [`${head}-feature`, ...rest].join('/') : path;
}

// ─── Cross-ecosystem code smells ─────────────────────────────────────────────

/**
 * Every way "just wait a bit" is spelled across these ecosystems.
 *
 * The rule is universal and so is the failure it causes: a fixed sleep is both
 * the slowest possible wait and the least reliable one. Checked after generation
 * because the instruction not to is the kind a model quietly ignores when it
 * cannot see another way to wait.
 */
export const FIXED_SLEEP_PATTERNS: RegExp[] = [
  /\bwaitForTimeout\s*\(/, // Playwright JS/Java
  /\bwait_for_timeout\s*\(/, // Playwright Python
  /\bWaitForTimeoutAsync\s*\(/, // Playwright .NET
  /\bThread\.sleep\s*\(/, // Java, Kotlin
  /\bTimeUnit\.\w+\.sleep\s*\(/, // Java
  /\bThread\.Sleep\s*\(/, // C#
  /\bTask\.Delay\s*\(/, // C#
  /\btime\.sleep\s*\(/, // Python
  /\btime\.Sleep\s*\(/, // Go
  /\bchromedp\.Sleep\s*\(/, // Go
  /\bcy\.wait\s*\(\s*\d/, // Cypress, numeric form only — an alias wait is correct
  /\bbrowser\.pause\s*\(/, // WebdriverIO, Nightwatch
  /\bt\.wait\s*\(/, // TestCafe
  /\bpage\.waitForTimeout\s*\(/, // Puppeteer
  /\bsleep\s*[( ]\s*\d/, // Ruby, PHP
  /\busleep\s*\(/, // PHP
  /^\s*Sleep\s+\d/m, // Robot Framework keyword
];

export function findsFixedSleep(code: string): boolean {
  return FIXED_SLEEP_PATTERNS.some((pattern) => pattern.test(code));
}
