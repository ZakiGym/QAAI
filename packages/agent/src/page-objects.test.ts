import { describe, expect, it } from 'vitest';
import {
  LOCATOR_REVIEW_CONFIDENCE,
  MAX_ACCESSORS_PER_PAGE,
  MAX_LITERAL_CHARS,
  PAGE_OBJECT_REFUSALS,
  PAGE_OBJECT_RENDERERS,
  PREFERRED_SIGHTING_STRATEGY,
  REFUSAL_IS_APPLICATION_FINDING,
  STRATEGY_IS_BRITTLE,
  STRATEGY_RESILIENCE_RANK,
  chooseSighting,
  classNameFrom,
  identifierFrom,
  pageSourcesFrom,
  preferredStrategy,
  pyLiteral,
  routeSlug,
  synthesisePageObject,
  toSnake,
  tsLiteral,
  type PageSource,
  type SightedAffordance,
} from './page-objects.js';
import { ECOSYSTEM_IDS, ECOSYSTEMS, type EcosystemId } from './ecosystem-prompts.js';
import { SELECTOR_STRATEGIES, blankStringsAndComments, countAssertions } from '@qaai/shared';
import type { FormModel, Selector } from '@qaai/shared';
import {
  LOCATOR_STRATEGIES,
  emptyStyleProfile,
  observed,
  type LocatorStrategy,
  type StyleProfile,
} from '@qaai/shared';

/**
 * ── What these tests are for ────────────────────────────────────────────────
 *
 * Three things, and they are not of equal weight.
 *
 * ONE, the SECURITY properties, which are pinned as PROPERTIES over hostile
 * inputs rather than as examples. Every string this module handles — a route, a
 * label, a field name, a select option — is page content, and the output is
 * written into the customer's repository. The tests under "untrusted text" are
 * the ones that must not be allowed to go green by accident, so they assert on
 * the rendered source with its string literals BLANKED by the repository's own
 * `blankStringsAndComments`: if a payload survives blanking it is outside a
 * literal, which is the definition of having escaped.
 *
 * TWO, the REFUSALS. A page object over nothing but CSS selectors is the defect
 * this module exists to avoid producing, so the test for it checks the count as
 * well as the refusal — `ALL_LOCATORS_BRITTLE` is a measurement, not an
 * adjective.
 *
 * THREE, the parity halves. Every `satisfies Record<K, V>` in page-objects.ts is
 * the compile-time half of a presence check; the tests in the first describe are
 * the run-time half, which is what catches a member added to a list and
 * forgotten in a record whose keys are inferred.
 */

const sel = (over: Partial<Selector> = {}): Selector => ({
  strategy: 'ROLE',
  value: 'button',
  name: 'Add to cart',
  confidence: 0.95,
  ...over,
});

const affordance = (over: Partial<SightedAffordance> = {}): SightedAffordance => ({
  label: 'Add to cart',
  kind: 'button',
  selector: sel(),
  ...over,
});

const page = (over: Partial<PageSource> = {}): PageSource => ({
  route: '/cart',
  affordances: [affordance()],
  forms: [],
  navigations: [],
  ...over,
});

const form = (over: Partial<FormModel> = {}): FormModel => ({
  id: 'signup',
  name: 'Sign up',
  selector: sel({ strategy: 'CSS', value: 'form#signup', confidence: 0.5 }),
  fields: [
    {
      name: 'email',
      label: 'Email address',
      inputType: 'email',
      required: true,
      semantic: 'email',
      // `name` is cleared deliberately: `locatorExpression` renders LABEL as
      // `getByLabel(name ?? value)`, so a fixture that left the shared default
      // in place would silently test the wrong string.
      selector: { strategy: 'LABEL', value: 'Email address', confidence: 0.9 },
    },
  ],
  submit: sel({ strategy: 'ROLE', value: 'button', name: 'Create account' }),
  ...over,
});

function profileWith(over: Partial<StyleProfile> = {}): StyleProfile {
  return { ...emptyStyleProfile(), filesRead: 20, ...over };
}

/** The synthesised source, or a thrown failure — so a test never asserts on a refusal by mistake. */
function sourceOf(args: Parameters<typeof synthesisePageObject>[0]): string {
  const result = synthesisePageObject(args);
  if (result.state !== 'SYNTHESISED') {
    throw new Error(`expected a page object, got ${result.reason}: ${result.why}`);
  }
  return result.source;
}

describe('vocabulary parity: the run-time half', () => {
  it.each([
    ['STRATEGY_IS_BRITTLE', STRATEGY_IS_BRITTLE],
    ['STRATEGY_RESILIENCE_RANK', STRATEGY_RESILIENCE_RANK],
  ])('%s is keyed on exactly the crawl’s selector strategies', (_name, record) => {
    expect(Object.keys(record).sort()).toEqual([...SELECTOR_STRATEGIES].sort());
  });

  it('PREFERRED_SIGHTING_STRATEGY is keyed on the profile vocabulary and maps into the crawl’s', () => {
    expect(Object.keys(PREFERRED_SIGHTING_STRATEGY).sort()).toEqual([...LOCATOR_STRATEGIES].sort());
    for (const [key, value] of Object.entries(PREFERRED_SIGHTING_STRATEGY)) {
      if (value === null) continue;
      expect(SELECTOR_STRATEGIES, `${key} maps to a strategy the crawl can emit`).toContain(value);
      // The one rule style-profile.ts states about this collision: the gate wins
      // on CSS chains, so a preference can never promote a brittle strategy.
      expect(STRATEGY_IS_BRITTLE[value], `${key} is not a brittle preference`).toBe(false);
    }
  });

  it('REFUSAL_IS_APPLICATION_FINDING decides every refusal, and our own limit is not a finding', () => {
    expect(Object.keys(REFUSAL_IS_APPLICATION_FINDING).sort()).toEqual(
      [...PAGE_OBJECT_REFUSALS].sort(),
    );
    const ours = Object.entries(REFUSAL_IS_APPLICATION_FINDING)
      .filter(([, isFinding]) => !isFinding)
      .map(([kind]) => kind);
    expect(ours).toEqual(['NO_RENDERER']);
  });

  /**
   * THE ANTI-HARD-CODING GUARD.
   *
   * `CONVERT_SYSTEM` in importer.ts hard-codes Playwright TypeScript, so a Java
   * shop that imports its suite gets a rewrite into a language it does not use.
   * A `Partial<Record<...>>` here would reproduce that defect by omission: the
   * 40th ecosystem would simply be absent and the lookup would return
   * undefined, which this module would then have to interpret. A TOTAL record
   * means adding an ecosystem fails to compile until somebody decides, and this
   * test is the run-time half of that.
   */
  it('every ecosystem has a decision about whether it gets a page object', () => {
    expect(Object.keys(PAGE_OBJECT_RENDERERS).sort()).toEqual([...ECOSYSTEM_IDS].sort());
  });

  it('a renderer’s file extension belongs to its ecosystem’s language', () => {
    const extensionFor: Record<string, string> = {
      TYPESCRIPT: '.ts',
      JAVASCRIPT: '.js',
      PYTHON: '.py',
      JAVA: '.java',
      KOTLIN: '.kt',
      CSHARP: '.cs',
      RUBY: '.rb',
      GO: '.go',
      PHP: '.php',
    };
    for (const [id, renderer] of Object.entries(PAGE_OBJECT_RENDERERS)) {
      if (!renderer) continue;
      const language = ECOSYSTEMS[id as EcosystemId].language;
      expect(language, `${id} has a language`).not.toBeNull();
      expect(renderer.fileName('cart'), `${id} writes its own language’s files`).toMatch(
        new RegExp(`${extensionFor[language!]!.replace('.', '\\.')}$`),
      );
    }
  });
});

describe('untrusted text', () => {
  /*
   * A label, a route and a field name are page content. The payloads below are
   * the real shapes: closing a string, closing a block comment, opening a
   * template interpolation, and the invisible characters that let a diff read
   * one way and execute another.
   */
  const payloads = [
    "'); process.exit(1); //",
    '*/ process.exit(1) /*',
    '`${process.exit(1)}`',
    'back\\slash "double" \'single\'',
    'line\nbreak\rreturn',
    'zero​width‮override',
    '"; DROP TABLE tests; --',
  ];

  it.each(payloads)('a label cannot escape the literal it is rendered into: %j', (payload) => {
    const source = sourceOf({
      page: page({ affordances: [affordance({ label: payload, selector: sel({ name: payload }) })] }),
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    /*
     * Blanking replaces every string literal's CONTENTS and every comment with
     * spaces. Anything from the payload still visible afterwards is CODE, which
     * is the definition of having escaped — and this uses the repository's own
     * scanner rather than a regex written here, so the two cannot disagree.
     */
    const blanked = blankStringsAndComments(source, 'JS_EXPECT');
    expect(blanked).not.toContain('process.exit');
    expect(blanked).not.toContain('DROP TABLE');
    expect(blanked).not.toContain('${');
    // The source still has to be a page object rather than a blank file.
    expect(source).toContain('export class');
  });

  it.each(payloads)('the same holds for the Python renderer: %j', (payload) => {
    const source = sourceOf({
      page: page({ affordances: [affordance({ label: payload, selector: sel({ name: payload }) })] }),
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_PYTHON',
    });
    const blanked = blankStringsAndComments(source, 'PY_ASSERT');
    expect(blanked).not.toContain('process.exit');
    expect(blanked).not.toContain('DROP TABLE');
    expect(source).toContain('class ');
  });

  it('never puts a crawled label in a comment, where a close-comment would end it', () => {
    const source = sourceOf({
      page: page({
        affordances: [
          affordance({
            label: '*/ this is code now',
            selector: sel({ strategy: 'CSS', value: 'div > span:nth-child(3)', confidence: 0.4 }),
          }),
          affordance({ label: 'Fine', kind: 'link', selector: sel({ strategy: 'ROLE', value: 'link', name: 'Fine' }) }),
        ],
      }),
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    // The accessor IS flagged for review — the brittleness is reported — and
    // the note is OUR words, so the label appears nowhere outside a literal.
    expect(source).toContain('REVIEW: reached by CSS');
    const comments = source.split('\n').filter((line) => line.trim().startsWith('/*') || line.trim().startsWith('*') || line.includes('/**'));
    expect(comments.join('\n')).not.toContain('this is code now');
  });

  it('identifierFrom emits an identifier and nothing else, for every payload', () => {
    for (const payload of [...payloads, '', '   ', '2 day shipping', '----', '​']) {
      const identifier = identifierFrom(payload, 'fallbackName');
      expect(identifier, `from ${JSON.stringify(payload)}`).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
    }
  });

  it('a route that could decide a file name is refused, and the refusal does not quote it', () => {
    for (const route of ['/../../etc/passwd', '/a`whoami`', '/a${x}', 'cart', '/a\\b', '/a"b']) {
      const result = synthesisePageObject({
        page: page({ route }),
        profile: profileWith(),
        ecosystemId: 'PLAYWRIGHT_TS',
      });
      expect(result.state, `route ${route}`).toBe('REFUSED');
      if (result.state !== 'REFUSED') continue;
      expect(result.reason).toBe('UNSAFE_ROUTE');
      /*
       * The reason travels into logs and review text. A refusal is not a place
       * to carry the payload that caused it, so the route's LENGTH is reported
       * and the route is not.
       */
      expect(result.why).not.toContain(route);
      expect(result.why).toContain(`${route.length} character(s)`);
    }
  });

  it('drops a navigation whose destination is not a plain relative path, and counts it', () => {
    const result = synthesisePageObject({
      page: page({
        navigations: [
          { action: 'click', selector: sel({ strategy: 'ROLE', value: 'link', name: 'Ok' }), toRoute: '/ok' },
          { action: 'click', selector: sel({ strategy: 'ROLE', value: 'link', name: 'Bad' }), toRoute: '/a`id`' },
        ],
      }),
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    expect(result.state).toBe('SYNTHESISED');
    if (result.state !== 'SYNTHESISED') return;
    expect(result.model.navigations.map((navigation) => navigation.toRoute)).toEqual(['/ok']);
    expect(
      result.model.omitted.find((omission) => omission.what.includes('not a plain relative path')),
    ).toMatchObject({ count: 1 });
  });

  it('escapes a quote rather than dropping it, in both quoters', () => {
    expect(tsLiteral("O'Brien")).toBe("'O\\'Brien'");
    expect(pyLiteral('say "hi"')).toBe('"say \\"hi\\""');
    // Backslash first, or `\\'` would re-escape into a closing quote.
    expect(tsLiteral("a\\'b")).toBe("'a\\\\\\'b'");
  });
});

describe('brittle locators are reported, not wrapped', () => {
  const cssOnly = page({
    affordances: [
      affordance({ label: 'One', selector: sel({ strategy: 'CSS', value: '.sc-x7f2 > span', confidence: 0.4 }) }),
      affordance({ label: 'Two', selector: sel({ strategy: 'CSS', value: 'div:nth-child(3)', confidence: 0.4 }) }),
    ],
  });

  it('refuses a page whose every sighted locator is brittle, and counts them', () => {
    const result = synthesisePageObject({
      page: cssOnly,
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    expect(result.state).toBe('REFUSED');
    if (result.state !== 'REFUSED') return;
    expect(result.reason).toBe('ALL_LOCATORS_BRITTLE');
    // The count, not the adjective: `brittle: 2 of 2` is a measurement.
    expect(result.brittleness).toMatchObject({ total: 2, brittle: 2, ratio: 1 });
    expect(result.brittleness.causes).toEqual([
      { cause: 'LOW_CONFIDENCE', count: 2 },
      { cause: 'STRATEGY', count: 2 },
    ]);
    expect(REFUSAL_IS_APPLICATION_FINDING[result.reason]).toBe(true);
  });

  it('still writes a page object when one locator among several is brittle, and flags that one', () => {
    const result = synthesisePageObject({
      page: page({
        affordances: [
          affordance({ label: 'Good', selector: sel({ strategy: 'ROLE', value: 'button', name: 'Good' }) }),
          affordance({ label: 'Also good', kind: 'link', selector: sel({ strategy: 'LABEL', value: 'Also good' }) }),
          affordance({ label: 'Ugly', selector: sel({ strategy: 'CSS', value: '.sc-x7f2', confidence: 0.3 }) }),
        ],
      }),
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    expect(result.state).toBe('SYNTHESISED');
    if (result.state !== 'SYNTHESISED') return;
    expect(result.model.brittleness).toMatchObject({ total: 3, brittle: 1 });
    const flagged = result.model.accessors.filter((accessor) => accessor.brittleCauses.length > 0);
    expect(flagged).toHaveLength(1);
    expect(result.source).toContain('REVIEW: reached by CSS');
  });

  it('counts a low-confidence sighting as needing review even when its strategy is resilient', () => {
    const result = synthesisePageObject({
      page: page({
        affordances: [
          affordance({ label: 'Sure', selector: sel({ confidence: 0.95 }) }),
          affordance({
            label: 'Unsure',
            kind: 'link',
            selector: sel({ strategy: 'ROLE', value: 'link', name: 'Unsure', confidence: LOCATOR_REVIEW_CONFIDENCE - 0.01 }),
          }),
        ],
      }),
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    expect(result.state).toBe('SYNTHESISED');
    if (result.state !== 'SYNTHESISED') return;
    expect(result.model.brittleness.causes).toEqual([{ cause: 'LOW_CONFIDENCE', count: 1 }]);
    expect(result.source).toContain(`below ${LOCATOR_REVIEW_CONFIDENCE}`);
  });

  it('a sighting exactly at the review confidence is not flagged', () => {
    // The boundary, derived from the constant rather than from a literal, so a
    // change to the floor moves the test with it.
    const result = synthesisePageObject({
      page: page({ affordances: [affordance({ selector: sel({ confidence: LOCATOR_REVIEW_CONFIDENCE }) })] }),
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    expect(result.state).toBe('SYNTHESISED');
    if (result.state !== 'SYNTHESISED') return;
    expect(result.model.brittleness.brittle).toBe(0);
  });
});

describe('the one choice: which sighting wins', () => {
  const both: SightedAffordance[] = [
    affordance({ selector: sel({ strategy: 'ROLE', value: 'button', name: 'Add to cart', confidence: 0.9 }) }),
    affordance({ selector: sel({ strategy: 'TEST_ID', value: 'add-to-cart', confidence: 0.9 }) }),
  ];

  it('prefers the project’s own strategy over the more resilient one', () => {
    const chosen = chooseSighting(both, 'TEST_ID');
    expect(chosen.selector.strategy).toBe('TEST_ID');
    // And with no preference, resilience decides.
    expect(chooseSighting(both, null).selector.strategy).toBe('ROLE');
  });

  it('the preference reaches the rendered source', () => {
    const profile = profileWith({
      locatorStrategy: observed({ value: 'TEST_ID', filesSeen: 9, filesConsidered: 10 }),
    });
    const source = sourceOf({
      page: page({ affordances: both }),
      profile,
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    expect(source).toContain("getByTestId('add-to-cart')");
    expect(source).not.toContain('getByRole');
  });

  it('never prefers a brittle strategy, however strongly the project prefers it', () => {
    const profile = profileWith({
      locatorStrategy: observed({ value: 'CSS', filesSeen: 10, filesConsidered: 10 }),
    });
    expect(profile.locatorStrategy.confidence).toBe('HIGH');
    expect(preferredStrategy(profile)).toBeNull();
    const source = sourceOf({
      page: page({
        affordances: [
          ...both,
          affordance({ selector: sel({ strategy: 'CSS', value: '.add-to-cart', confidence: 0.9 }) }),
        ],
      }),
      profile,
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    expect(source).toContain('getByRole');
    expect(source).not.toContain(".locator('.add-to-cart')");
  });

  it('ignores a preference the profile only weakly attests', () => {
    // LOW: two agreeing files out of twenty. A value is kept — it is evidence —
    // and CONFIDENCE_IS_USABLE refuses to state it as a rule.
    const profile = profileWith({
      locatorStrategy: observed({ value: 'TEST_ID', filesSeen: 2, filesConsidered: 20 }),
    });
    expect(profile.locatorStrategy.confidence).toBe('LOW');
    expect(profile.locatorStrategy.value).toBe('TEST_ID');
    expect(preferredStrategy(profile)).toBeNull();
  });

  it('ignores a PAGE_OBJECT or XPATH preference, which name no sighting', () => {
    for (const value of ['PAGE_OBJECT', 'XPATH'] as LocatorStrategy[]) {
      const profile = profileWith({
        locatorStrategy: observed({ value, filesSeen: 9, filesConsidered: 10 }),
      });
      expect(preferredStrategy(profile), value).toBeNull();
    }
  });

  it('collapses duplicate sightings of one control and discloses how many', () => {
    const result = synthesisePageObject({
      page: page({ affordances: both }),
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    expect(result.state).toBe('SYNTHESISED');
    if (result.state !== 'SYNTHESISED') return;
    expect(result.model.accessors).toHaveLength(1);
    expect(
      result.model.omitted.find((omission) => omission.what.includes('duplicate sightings')),
    ).toMatchObject({ count: 1 });
  });

  it('is byte-identical on two runs over the same page', () => {
    const args = { page: page({ affordances: both }), profile: profileWith(), ecosystemId: 'PLAYWRIGHT_TS' } as const;
    expect(sourceOf(args)).toBe(sourceOf(args));
  });

  it('does not depend on the order the crawl happened to list the controls in', () => {
    const forward = sourceOf({ page: page({ affordances: both }), profile: profileWith(), ecosystemId: 'PLAYWRIGHT_TS' });
    const reversed = sourceOf({
      page: page({ affordances: [...both].reverse() }),
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    expect(reversed).toBe(forward);
  });
});

describe('what a page object contains', () => {
  it('contains no assertion, measured in the dialect its own renderer names', () => {
    /*
     * Every one of the five page-object prompts says the same thing:
     * "assertions stay in the test, never inside the page object". A page object
     * that asserts produces a failure message that names the page object rather
     * than the behaviour. Measured with the repository's own assertion lexicon,
     * which blanks strings and comments first — so a crawled label reading
     * `expect(x).toBe(1)` is correctly not an assertion.
     */
    const hostile = page({
      affordances: [
        affordance({ label: 'expect(page).toHaveText("x")', selector: sel({ name: 'expect(total).toBe(5)' }) }),
      ],
      forms: [form()],
    });
    for (const [id, renderer] of Object.entries(PAGE_OBJECT_RENDERERS)) {
      if (!renderer) continue;
      const source = sourceOf({ page: hostile, profile: profileWith(), ecosystemId: id as EcosystemId });
      expect(countAssertions(source, renderer.dialect), `${id} asserts nothing`).toBe(0);
    }
  });

  it('carries a dynamic route segment into a parameter rather than a literal', () => {
    const ts = sourceOf({ page: page({ route: '/orders/:id' }), profile: profileWith(), ecosystemId: 'PLAYWRIGHT_TS' });
    expect(ts).toContain('async goto(params: { id: string }): Promise<void>');
    expect(ts).toContain('await this.page.goto(`/orders/${params.id}`);');

    const py = sourceOf({ page: page({ route: '/orders/:id' }), profile: profileWith(), ecosystemId: 'PLAYWRIGHT_PYTHON' });
    expect(py).toContain('def goto(self, id: str) -> None:');
    expect(py).toContain('self.page.goto(f"/orders/{id}")');
  });

  it('renders a form filler with the field semantics attached', () => {
    const source = sourceOf({
      page: page({ forms: [form()] }),
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    expect(source).toContain('/** Field semantics: email=email (required). */');
    expect(source).toContain('async fillSignUpForm(values: { email: string }): Promise<void>');
    expect(source).toContain("await this.page.getByLabel('Email address').fill(values.email);");
    expect(source).toContain('async submitSignUpForm(): Promise<void>');
  });

  it('drives a select and a checkbox with the call each one needs', () => {
    const source = sourceOf({
      page: page({
        forms: [
          form({
            fields: [
              {
                name: 'country',
                label: 'Country',
                inputType: 'select',
                required: false,
                semantic: 'country',
                options: ['GB', 'US'],
                selector: { strategy: 'LABEL', value: 'Country', confidence: 0.9 },
              },
              {
                name: 'terms',
                label: 'Accept',
                inputType: 'checkbox',
                required: true,
                semantic: 'unknown',
                selector: { strategy: 'LABEL', value: 'Accept', confidence: 0.9 },
              },
            ],
          }),
        ],
      }),
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    expect(source).toContain('.selectOption(values.country);');
    expect(source).toContain(".setChecked(values.terms === 'true');");
  });

  it('reports a file input as undrivable rather than inventing a path for it', () => {
    const result = synthesisePageObject({
      page: page({
        forms: [
          form({
            fields: [
              ...form().fields,
              {
                name: 'avatar',
                label: 'Avatar',
                inputType: 'file',
                required: false,
                semantic: 'unknown',
                selector: { strategy: 'LABEL', value: 'Avatar', confidence: 0.9 },
              },
            ],
          }),
        ],
      }),
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    expect(result.state).toBe('SYNTHESISED');
    if (result.state !== 'SYNTHESISED') return;
    expect(result.model.fillers[0]!.fields.map((field) => field.fieldName)).toEqual(['email']);
    expect(
      result.model.omitted.find((omission) => omission.what.includes('cannot drive')),
    ).toMatchObject({ count: 1 });
    expect(result.source).not.toContain('setInputFiles');
  });

  it('refuses a page the crawl found nothing on, rather than writing an empty class', () => {
    const result = synthesisePageObject({
      page: page({ affordances: [], forms: [], navigations: [] }),
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    expect(result.state).toBe('REFUSED');
    if (result.state !== 'REFUSED') return;
    expect(result.reason).toBe('NO_CONTROLS');
    // `total: 0` is reported rather than a clean `brittle: 0` on nothing.
    expect(result.brittleness).toMatchObject({ total: 0, brittle: 0 });
  });

  it('refuses rather than writing TypeScript for a shop that does not use it', () => {
    const result = synthesisePageObject({
      page: page(),
      profile: profileWith(),
      ecosystemId: 'JUNIT5',
    });
    expect(result.state).toBe('REFUSED');
    if (result.state !== 'REFUSED') return;
    expect(result.reason).toBe('NO_RENDERER');
    expect(result.why).toContain(ECOSYSTEMS.JUNIT5.label);
    // Our reach, not their application: this is an UNAVAILABLE and must not be
    // reported to the customer as a finding about their page.
    expect(REFUSAL_IS_APPLICATION_FINDING[result.reason]).toBe(false);
  });

  it('accepts an injected renderer for an ecosystem with none built in', () => {
    const result = synthesisePageObject({
      page: page(),
      profile: profileWith(),
      ecosystemId: 'JUNIT5',
      renderers: {
        JUNIT5: {
          dialect: 'JVM',
          fileName: (stem) => `${stem}Page.java`,
          render: (model) => `class ${model.className} {}\n`,
        },
      },
    });
    expect(result.state).toBe('SYNTHESISED');
    if (result.state !== 'SYNTHESISED') return;
    expect(result.fileName).toBe('cartPage.java');
    expect(result.source).toBe('class CartPage {}\n');
  });

  it('discloses the accessor cap as a count and a reason', () => {
    const many = Array.from({ length: MAX_ACCESSORS_PER_PAGE + 7 }, (_unused, index) =>
      affordance({
        label: `Control ${index}`,
        selector: sel({ strategy: 'ROLE', value: 'button', name: `Control ${index}` }),
      }),
    );
    const result = synthesisePageObject({
      page: page({ affordances: many }),
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    expect(result.state).toBe('SYNTHESISED');
    if (result.state !== 'SYNTHESISED') return;
    expect(result.model.accessors).toHaveLength(MAX_ACCESSORS_PER_PAGE);
    const omission = result.model.omitted.find((entry) => entry.what.includes('accessor cap'));
    expect(omission).toMatchObject({ count: 7 });
    expect(omission?.why).toContain(String(MAX_ACCESSORS_PER_PAGE));
  });

  it('counts a locator string it had to shorten, because a prefix does not match', () => {
    const long = `Add ${'x'.repeat(MAX_LITERAL_CHARS)} to cart`;
    const result = synthesisePageObject({
      page: page({ affordances: [affordance({ label: long, selector: sel({ name: long }) })] }),
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    expect(result.state).toBe('SYNTHESISED');
    if (result.state !== 'SYNTHESISED') return;
    const omission = result.model.omitted.find((entry) => entry.what.includes('literal cap'));
    expect(omission).toMatchObject({ count: 1 });
    expect(omission?.why).toContain(String(MAX_LITERAL_CHARS));
    // And the literal really IS a prefix, which is what makes the count honest.
    expect(result.source).toContain('x'.repeat(10));
    expect(result.source).not.toContain('to cart');
  });

  it('lets no raw control or direction-override character reach a generated file', () => {
    /*
     * THE DEFECT THIS PINS. The TypeScript renderer quotes through
     * `locatorExpression` in @qaai/shared, which escapes a quote and a
     * backslash and bounds nothing — so until `boundedSelector` existed, a
     * label containing a newline produced an UNTERMINATED STRING LITERAL and a
     * generated file that does not parse, and a label with a right-to-left
     * override produced a diff that reads one way and runs another. Both
     * passed the escape tests, because neither is an escape.
     */
    const nasty = 'Add\n to\u202e cart\u200b now';
    for (const [id, renderer] of Object.entries(PAGE_OBJECT_RENDERERS)) {
      if (!renderer) continue;
      const source = sourceOf({
        page: page({
          affordances: [affordance({ label: nasty, selector: sel({ name: nasty }) })],
          navigations: [{ action: 'x', selector: sel({ name: nasty }), toRoute: '/ok' }],
        }),
        profile: profileWith(),
        ecosystemId: id as EcosystemId,
      });
      /*
       * Scanned by CODE POINT rather than matched by a regex: a regex literal
       * containing these characters is itself a `no-control-regex` lint error,
       * and the failure message is better this way — it names the character
       * that got through rather than saying a pattern matched.
       */
      const offending = [...source].filter((character) => {
        const point = character.codePointAt(0) ?? 0;
        // Newline is the line separator and is allowed; nothing else is.
        if (point === 0x0a) return false;
        if (point < 0x20 || (point >= 0x7f && point <= 0x9f)) return true;
        return (
          (point >= 0x200b && point <= 0x200f) ||
          point === 0x2028 ||
          point === 0x2029 ||
          (point >= 0x202a && point <= 0x202e) ||
          (point >= 0x2066 && point <= 0x2069) ||
          point === 0xfeff
        );
      });
      expect(
        offending.map((character) => `U+${(character.codePointAt(0) ?? 0).toString(16)}`),
        `${id} carries a character a label cannot contain`,
      ).toEqual([]);
    }
  });

  it('counts a locator it had to strip, not only one it had to shorten', () => {
    const result = synthesisePageObject({
      page: page({ affordances: [affordance({ selector: sel({ name: 'Add\u200b to cart' }) })] }),
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    expect(result.state).toBe('SYNTHESISED');
    if (result.state !== 'SYNTHESISED') return;
    expect(result.model.omitted.find((entry) => entry.what.includes('literal cap'))).toMatchObject({
      count: 1,
    });
  });

  it('resolves two controls whose labels derive one identifier, deterministically', () => {
    const result = synthesisePageObject({
      page: page({
        affordances: [
          affordance({ label: 'add to cart', selector: sel({ name: 'a' }) }),
          affordance({ label: 'Add-To-Cart', selector: sel({ name: 'b' }) }),
        ],
      }),
      profile: profileWith(),
      ecosystemId: 'PLAYWRIGHT_TS',
    });
    expect(result.state).toBe('SYNTHESISED');
    if (result.state !== 'SYNTHESISED') return;
    expect(result.model.accessors.map((accessor) => accessor.name)).toEqual([
      'addToCartButton',
      'addToCartButton2',
    ]);
  });
});

describe('pageSourcesFrom', () => {
  it('joins a node to its outgoing edges, by route', () => {
    const sources = pageSourcesFrom({
      nodes: [
        { id: 'n1', route: '/cart', affordances: [affordance()], forms: [] },
        { id: 'n2', route: '/checkout', affordances: [], forms: [] },
      ],
      edges: [{ from: 'n1', to: 'n2', action: 'click Checkout', selector: sel({ value: 'link' }) }],
    });
    expect(sources[0]!.navigations).toEqual([
      { action: 'click Checkout', selector: sel({ value: 'link' }), toRoute: '/checkout' },
    ]);
    expect(sources[1]!.navigations).toEqual([]);
  });

  it('drops an edge whose destination the map does not contain, rather than pointing it at itself', () => {
    const sources = pageSourcesFrom({
      nodes: [{ id: 'n1', route: '/cart', affordances: [], forms: [] }],
      edges: [{ from: 'n1', to: 'gone', action: 'click', selector: null }],
    });
    expect(sources[0]!.navigations).toEqual([]);
  });
});

describe('naming helpers', () => {
  it('breaks a run of capitals before the last one', () => {
    expect(toSnake('oBrienSBill')).toBe('o_brien_s_bill');
    expect(toSnake('goToCheckout')).toBe('go_to_checkout');
    expect(toSnake('addToCartButton')).toBe('add_to_cart_button');
  });

  it('turns a route into a slug and a class name', () => {
    expect(routeSlug('/orders/:id')).toBe('orders-id');
    expect(routeSlug('/')).toBe('root');
    expect(classNameFrom(routeSlug('/orders/:id'), 'page')).toBe('OrdersId');
  });
});
