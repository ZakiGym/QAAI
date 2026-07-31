/**
 * Selection and path tests for the ecosystem registry.
 *
 * These cover the two ways multilingual generation fails silently — silently
 * being the operative word, because neither shows up as an error anywhere:
 *
 *   1. **Wrong ecosystem.** A Python project gets a fragment describing
 *      Playwright's TypeScript API. The model dutifully writes something
 *      plausible in Python, it reads as machine-written to the team that owns
 *      it, and nothing in the pipeline objects.
 *   2. **Uncollectable path.** Go compiles test files only when they are named
 *      `*_test.go`; pytest collects only `test_*.py`; a Java class must match
 *      its file name. Get it wrong and the runner reports a green suite over a
 *      file it never executed — the single worst outcome this product has.
 *
 * The prompt text itself cannot be tested without a model, so what is asserted
 * here is what is deterministic: which fragment a project resolves to, that the
 * fragment names the idioms that ecosystem is defined by, and that the path it
 * produces is one the ecosystem's own runner will pick up.
 */

import { FRAMEWORKS_BY_LANGUAGE } from '@qaai/shared';
import type { Language, UiFramework } from '@qaai/shared';
import { describe, expect, it } from 'vitest';
import {
  ECOSYSTEMS,
  ECOSYSTEM_IDS,
  findsFixedSleep,
  resolveEcosystem,
  testFilePath,
} from './ecosystem-prompts.js';
import type { EcosystemId } from './ecosystem-prompts.js';

const PARTS = { feature: 'Checkout', title: 'Adds an item to the cart' };

const pairs: Array<[Language, UiFramework]> = Object.entries(FRAMEWORKS_BY_LANGUAGE).flatMap(
  ([language, frameworks]) =>
    frameworks.map((framework): [Language, UiFramework] => [language as Language, framework]),
);

describe('every project the product can be configured as gets a real ecosystem', () => {
  // FRAMEWORKS_BY_LANGUAGE is what the project schema validates against, so
  // these pairs are exactly the reachable configurations. A gap here is a
  // customer quietly generated for in the wrong dialect.
  it.each(pairs)('%s + %s resolves to an ecosystem in that language', (language, framework) => {
    const ecosystem = resolveEcosystem({ language, framework });

    expect(ECOSYSTEM_IDS).toContain(ecosystem.id);
    expect(ecosystem.language).toBe(language);
  });

  it('keeps every id and its registry key in agreement', () => {
    for (const [key, ecosystem] of Object.entries(ECOSYSTEMS)) {
      expect(ecosystem.id).toBe(key);
    }
  });
});

describe('the driver and the language both count', () => {
  const cases: Array<[Language, UiFramework, EcosystemId]> = [
    ['TYPESCRIPT', 'PLAYWRIGHT', 'PLAYWRIGHT_TS'],
    ['TYPESCRIPT', 'CYPRESS', 'CYPRESS'],
    ['TYPESCRIPT', 'WEBDRIVERIO', 'WEBDRIVERIO'],
    ['TYPESCRIPT', 'PUPPETEER', 'PUPPETEER'],
    ['TYPESCRIPT', 'NIGHTWATCH', 'NIGHTWATCH'],
    ['TYPESCRIPT', 'TESTCAFE', 'TESTCAFE'],
    ['JAVASCRIPT', 'PLAYWRIGHT', 'PLAYWRIGHT_TS'],
    ['PYTHON', 'PLAYWRIGHT', 'PLAYWRIGHT_PYTHON'],
    ['PYTHON', 'SELENIUM', 'SELENIUM_PYTHON'],
    ['PYTHON', 'APPIUM', 'APPIUM_PYTHON'],
    ['JAVA', 'PLAYWRIGHT', 'PLAYWRIGHT_JAVA'],
    ['JAVA', 'SELENIUM', 'SELENIUM_JAVA'],
    ['JAVA', 'APPIUM', 'APPIUM_JAVA'],
    ['CSHARP', 'PLAYWRIGHT', 'PLAYWRIGHT_CSHARP'],
    ['CSHARP', 'SELENIUM', 'SELENIUM_CSHARP'],
    ['RUBY', 'CAPYBARA', 'CAPYBARA_RSPEC'],
    ['RUBY', 'SELENIUM', 'SELENIUM_RUBY'],
    ['KOTLIN', 'PLAYWRIGHT', 'PLAYWRIGHT_KOTLIN'],
    ['KOTLIN', 'SELENIUM', 'SELENIUM_KOTLIN'],
    ['KOTLIN', 'ESPRESSO', 'ESPRESSO'],
    ['GO', 'PLAYWRIGHT', 'PLAYWRIGHT_GO'],
    ['GO', 'CHROMEDP', 'CHROMEDP'],
    ['PHP', 'PANTHER', 'PANTHER'],
    ['PHP', 'CODECEPTION', 'CODECEPTION'],
  ];

  it.each(cases)('%s + %s → %s', (language, framework, expected) => {
    expect(resolveEcosystem({ language, framework }).id).toBe(expected);
  });

  it('writes .js, not .ts, for a JavaScript project', () => {
    // The runners are identical; the artifact is not. A .ts file with type
    // annotations dropped into a JS repo does not run at all.
    const ecosystem = resolveEcosystem({ language: 'JAVASCRIPT', framework: 'PLAYWRIGHT' });

    expect(ecosystem.id).toBe('PLAYWRIGHT_TS');
    expect(ecosystem.language).toBe('JAVASCRIPT');
    expect(ecosystem.label).toBe('Playwright (JavaScript)');
    expect(ecosystem.rules).toMatch(/no type\s*\n?annotations/);
    expect(testFilePath(ecosystem, PARTS)).toBe('checkout/adds-an-item-to-the-cart.spec.js');
  });

  it('carries the JavaScript dialect through an explicit runner too', () => {
    const ecosystem = resolveEcosystem({
      language: 'JAVASCRIPT',
      framework: 'PLAYWRIGHT',
      runner: 'JEST',
    });

    expect(testFilePath(ecosystem, PARTS)).toBe('tests/checkout/adds-an-item-to-the-cart.test.js');
  });

  it('lets the language win when the two contradict', () => {
    // The project schema rejects this pair, but an API caller can still send it.
    // Writing Ruby is not negotiable for a Ruby team; the driver is.
    const ecosystem = resolveEcosystem({ language: 'RUBY', framework: 'PLAYWRIGHT' });

    expect(ecosystem.language).toBe('RUBY');
    expect(ecosystem.id).toBe('CAPYBARA_RSPEC');
  });
});

describe('a unit test has no browser in it', () => {
  const cases: Array<[Language, EcosystemId]> = [
    ['TYPESCRIPT', 'VITEST'],
    ['JAVASCRIPT', 'VITEST'],
    ['PYTHON', 'PYTEST'],
    ['JAVA', 'JUNIT5'],
    ['KOTLIN', 'JUNIT5_KOTLIN'],
    ['CSHARP', 'XUNIT'],
    ['RUBY', 'RSPEC'],
    ['GO', 'GO_TEST'],
    ['PHP', 'PHPUNIT'],
  ];

  it.each(cases)('UNIT_GEN in %s uses %s, whatever the UI framework is', (language, expected) => {
    const framework = FRAMEWORKS_BY_LANGUAGE[language][0] as UiFramework;
    expect(resolveEcosystem({ language, framework, testType: 'UNIT_GEN' }).id).toBe(expected);
  });
});

describe('an explicit runner reaches what the matrix cannot express', () => {
  // The (language, framework) matrix has one slot per driver, so a Java shop on
  // TestNG or a team writing Gherkin is only reachable by naming the runner.
  const overrides: EcosystemId[] = [
    'PYTEST',
    'UNITTEST',
    'JUNIT5',
    'TESTNG',
    'NUNIT',
    'XUNIT',
    'RSPEC',
    'MINITEST',
    'GO_TEST',
    'PHPUNIT',
    'PEST',
    'JEST',
    'VITEST',
    'ROBOT',
    'CUCUMBER',
  ];

  it.each(overrides)('%s can be selected explicitly', (runner) => {
    const ecosystem = resolveEcosystem({
      language: 'TYPESCRIPT',
      framework: 'PLAYWRIGHT',
      runner,
    });
    expect(ecosystem.id).toBe(runner);
  });

  it('ignores a runner it does not recognise rather than generating nothing', () => {
    // The override is the kind of value that arrives from a config column, so it
    // is not necessarily one of ours.
    const ecosystem = resolveEcosystem({
      language: 'PYTHON',
      framework: 'PLAYWRIGHT',
      runner: 'PYTEST_BDD' as EcosystemId,
    });
    expect(ecosystem.id).toBe('PLAYWRIGHT_PYTHON');
  });
});

describe('the generated path is one the ecosystem actually collects', () => {
  it.each(ECOSYSTEM_IDS)('%s produces a path matching its own collection pattern', (id) => {
    const ecosystem = ECOSYSTEMS[id];
    const path = testFilePath(ecosystem, PARTS);

    expect(path).toMatch(ecosystem.filePattern);
    expect(path.startsWith('/')).toBe(false);
    expect(path).not.toContain('..');
  });

  const cases: Array<[EcosystemId, string]> = [
    ['PLAYWRIGHT_TS', 'checkout/adds-an-item-to-the-cart.spec.ts'],
    ['CYPRESS', 'cypress/e2e/checkout/adds-an-item-to-the-cart.cy.ts'],
    ['VITEST', 'tests/checkout/adds-an-item-to-the-cart.test.ts'],
    ['PYTEST', 'tests/checkout/test_adds_an_item_to_the_cart.py'],
    ['PLAYWRIGHT_PYTHON', 'tests/checkout/test_adds_an_item_to_the_cart.py'],
    ['UNITTEST', 'tests/checkout/test_adds_an_item_to_the_cart.py'],
    ['JUNIT5', 'src/test/java/tests/checkout/AddsAnItemToTheCartTest.java'],
    ['SELENIUM_JAVA', 'src/test/java/tests/checkout/AddsAnItemToTheCartTest.java'],
    ['JUNIT5_KOTLIN', 'src/test/kotlin/tests/checkout/AddsAnItemToTheCartTest.kt'],
    ['ESPRESSO', 'app/src/androidTest/java/tests/checkout/AddsAnItemToTheCartTest.kt'],
    ['NUNIT', 'Tests/Checkout/AddsAnItemToTheCartTests.cs'],
    ['XUNIT', 'Tests/Checkout/AddsAnItemToTheCartTests.cs'],
    ['RSPEC', 'spec/checkout/adds_an_item_to_the_cart_spec.rb'],
    ['CAPYBARA_RSPEC', 'spec/features/checkout/adds_an_item_to_the_cart_spec.rb'],
    ['MINITEST', 'test/checkout/adds_an_item_to_the_cart_test.rb'],
    ['GO_TEST', 'checkout/adds_an_item_to_the_cart_test.go'],
    ['CHROMEDP', 'e2e/checkout/adds_an_item_to_the_cart_test.go'],
    ['PHPUNIT', 'tests/Checkout/AddsAnItemToTheCartTest.php'],
    ['PEST', 'tests/Feature/Checkout/AddsAnItemToTheCartTest.php'],
    ['CODECEPTION', 'tests/Acceptance/Checkout/AddsAnItemToTheCartCest.php'],
    ['ROBOT', 'tests/checkout/adds_an_item_to_the_cart.robot'],
    ['CUCUMBER', 'features/checkout/adds_an_item_to_the_cart.feature'],
  ];

  it.each(cases)('%s → %s', (id, expected) => {
    expect(testFilePath(ECOSYSTEMS[id], PARTS)).toBe(expected);
  });

  it('names the file after the class in the languages that require it', () => {
    // Java, Kotlin, C# and PSR-4 PHP all refuse to load a class whose name does
    // not match its file, so the stem IS the class name the model must declare.
    const stems: Array<[EcosystemId, string]> = [
      ['JUNIT5', 'AddsAnItemToTheCartTest'],
      ['PLAYWRIGHT_KOTLIN', 'AddsAnItemToTheCartTest'],
      ['XUNIT', 'AddsAnItemToTheCartTests'],
      ['PHPUNIT', 'AddsAnItemToTheCartTest'],
    ];

    for (const [id, stem] of stems) {
      const path = testFilePath(ECOSYSTEMS[id], PARTS);
      expect(path.split('/').at(-1)?.split('.')[0]).toBe(stem);
    }
  });

  it('keeps a real test out of the reserved fixtures directory', () => {
    // `fixtures/` is excluded from run selection, so a shop whose app has a
    // top-level /fixtures route would otherwise generate tests that never run.
    const path = testFilePath(ECOSYSTEMS.PLAYWRIGHT_TS, {
      feature: 'Fixtures',
      title: 'Shows the league fixture list',
    });

    expect(path.startsWith('fixtures/')).toBe(false);
    expect(path).toBe('fixtures-feature/shows-the-league-fixture-list.spec.ts');
  });

  it('still produces a usable path when the plan item names are junk', () => {
    // Feature comes from a crawled URL segment and title from a model, so
    // neither is guaranteed to contain a single alphanumeric character.
    for (const id of ECOSYSTEM_IDS) {
      const ecosystem = ECOSYSTEMS[id];
      const path = testFilePath(ecosystem, { feature: '///', title: '2fa!' });

      expect(path).toMatch(ecosystem.filePattern);
      expect(path.startsWith('/')).toBe(false);
      expect(path).not.toContain('//');
    }
  });
});

describe('each fragment carries the idioms that ecosystem is defined by', () => {
  // Not a proxy for output quality — no model runs here. It is a regression
  // guard on the fragments: an edit that drops "t.Run" from the Go prompt is an
  // edit that quietly stops producing subtests.
  const idioms: Array<[EcosystemId, RegExp[]]> = [
    [
      'PYTEST',
      [/fixture/i, /parametrize/, /conftest\.py/, /never self\.assertEqual|no unittest\.TestCase/i],
    ],
    ['UNITTEST', [/unittest\.TestCase/, /setUp/, /assertEqual/, /subTest/]],
    ['JUNIT5', [/@Test/, /@DisplayName/, /@BeforeEach/, /AssertJ/, /JUnit 4/]],
    ['TESTNG', [/@DataProvider/, /@BeforeMethod/, /\(actual, expected\)/]],
    ['NUNIT', [/\[Test\]/, /\[SetUp\]/, /Assert\.That/, /Is\.EqualTo/]],
    ['XUNIT', [/\[Fact\]/, /\[Theory\]/, /constructor/, /IDisposable/]],
    ['RSPEC', [/describe/, /context/, /\blet\b/, /expect\(actual\)\.to eq/]],
    ['MINITEST', [/assert_equal/, /setup/, /test_\*/]],
    ['GO_TEST', [/t\.Run/, /t\.Parallel/, /Table-driven/i, /no assertion library/i]],
    ['PHPUNIT', [/assertSame/, /DataProvider/, /strict_types/]],
    ['PEST', [/\bit\(/, /->toBe/, /No class/i]],
    ['ROBOT', [/\*\*\* Settings \*\*\*/, /\*\*\* Test Cases \*\*\*/, /[Kk]eyword-driven/]],
    ['CUCUMBER', [/Scenario Outline/, /Background/, /Declarative/i]],
    ['CYPRESS', [/cy\.intercept/, /\.should\(/, /Never cy\.wait\(<number>\)/]],
    ['PLAYWRIGHT_TS', [/getByRole/, /test\.step/, /web-first/i]],
    ['PLAYWRIGHT_PYTHON', [/get_by_role/, /pytest-playwright/, /fixture/]],
    ['SELENIUM_JAVA', [/WebDriverWait/, /ExpectedConditions/, /implicit wait/]],
    ['CAPYBARA_RSPEC', [/click_button/, /have_text/, /within\(/]],
  ];

  it.each(idioms)('%s', (id, patterns) => {
    for (const pattern of patterns) {
      expect(ECOSYSTEMS[id].rules).toMatch(pattern);
    }
  });

  it('tells the model what the path convention is, in every ecosystem', () => {
    for (const id of ECOSYSTEM_IDS) {
      expect(ECOSYSTEMS[id].pathRule.length).toBeGreaterThan(10);
    }
  });
});

describe('the no-fixed-sleep rule is enforced in every language', () => {
  const sleeps: string[] = [
    'await page.waitForTimeout(500);',
    'page.wait_for_timeout(500)',
    'await Page.WaitForTimeoutAsync(500);',
    'Thread.sleep(2000);',
    'TimeUnit.SECONDS.sleep(2);',
    'Thread.Sleep(2000);',
    'await Task.Delay(500);',
    'time.sleep(2)',
    'time.Sleep(2 * time.Second)',
    'chromedp.Sleep(2*time.Second),',
    'cy.wait(500);',
    'browser.pause(1000);',
    'await t.wait(500);',
    'sleep 2',
    'usleep(500000);',
    '    Sleep    2s',
  ];

  it.each(sleeps)('flags %s', (code) => {
    expect(findsFixedSleep(code)).toBe(true);
  });

  const legitimate: string[] = [
    "cy.intercept('POST', '/api/orders').as('order'); cy.wait('@order');",
    'wait.until(ExpectedConditions.elementToBeClickable(By.id("pay")));',
    "await expect(page.getByTestId('cart-count')).toHaveText('1 item');",
    'browser.waitUntil(() => cart.isDisplayed(), { timeoutMsg: "cart never appeared" });',
    'Wait Until Element Is Visible    ${CART}    10s',
  ];

  it.each(legitimate)('does not flag %s', (code) => {
    expect(findsFixedSleep(code)).toBe(false);
  });
});
