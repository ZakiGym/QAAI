/**
 * Generator (§3.2) — turns an approved plan item into real test code.
 *
 * Two hard requirements from the spec shape everything here:
 *   1. The output is standard code the customer owns. No QAAI imports, no
 *      proprietary helpers — a generated spec must run under plain
 *      `npx playwright test` with QAAI uninstalled.
 *   2. Selectors are resilient and assertions check meaning. The Flow Map hands
 *      the model real locators with confidence scores so it does not invent
 *      brittle CSS, and anything low-confidence comes back as a review flag.
 */

import { FIXTURE_PREFIX, generatedTestSchema } from '@qaai/shared';
import type { FlowMap, Language, PlanItem, UiFramework } from '@qaai/shared';
import type { CallContext, LlmService } from './llm.js';

export interface GeneratedTest {
  name: string;
  filePath: string;
  code: string;
  reviewFlags: string[];
}

const PLAYWRIGHT_TS_RULES = `Write a TypeScript spec for @playwright/test.

Required shape:
  import { test, expect } from '@playwright/test';

  test('<name>', async ({ page }) => {
    await test.step('<step title>', async () => { ... });
  });

Rules:
- One test() per file. Every plan step becomes exactly one test.step() whose
  title is that step in plain English — the cockpit renders these as the
  timeline, so they must read like a human wrote them.
- Locators, in order of preference:
    page.getByRole('button', { name: 'Add to cart' })
    page.getByLabel('Email address')
    page.getByPlaceholder(...)  /  page.getByText(...)
    page.getByTestId('order-total')
  Use a raw CSS or XPath selector only if nothing else can work, and say so in
  reviewFlags.
- Never use waitForTimeout or any fixed sleep. Playwright auto-waits; if you
  need to wait for something specific, assert on it.
- Use relative paths with page.goto('/cart') — baseURL is configured.
- Secrets come from process.env, never literals.
- Assertions must check meaning. Parsing a rendered money string and checking
  the arithmetic is good. expect(page.getByText('Cart')).toBeVisible() is not.
- Prefer web-first assertions (await expect(locator).toHaveText(...)) over
  reading values into variables, except where you need arithmetic.
- No comments explaining what a line does. A comment is only worth writing when
  it explains something the code cannot show — e.g. why a value is expected.`;

const FRAMEWORK_RULES: Partial<Record<UiFramework, string>> = {
  PLAYWRIGHT: PLAYWRIGHT_TS_RULES,
  CYPRESS: `Write a Cypress spec (TypeScript).
- describe/it blocks; one it() per plan item.
- cy.findByRole / cy.contains for locators; avoid brittle CSS.
- No cy.wait with a fixed number — wait on aliases or assertions.
- Assertions check meaning, not presence.`,
  SELENIUM: `Write a Selenium test in the project's language using the standard
test runner for that language (JUnit 5 for Java, pytest for Python, NUnit for
C#). Use explicit waits, never Thread.sleep. Use a page-object where the
project convention calls for one.`,
};

const SYSTEM = `You are the Generator agent inside QAAI, an AI QA engineer.

You turn one approved test plan item into working test code. The code you write
is committed to the customer's own repository and must run without QAAI
installed — it is their code, not ours. Never import anything from a "qaai"
package and never reference QAAI in the source.

You are given the exact locators a crawler found on the real page, each with a
confidence score. Use them. Do not invent selectors for elements that are not in
the list; if the plan needs an element you were not given, use the most robust
role- or text-based locator you can and add a reviewFlag saying it was inferred.

Put anything a human should look at into reviewFlags: inferred locators,
low-confidence locators (below 0.6), assumptions about test data, or steps you
could not express faithfully.`;

/** Only the states this plan item touches — the whole map would blow the budget. */
function relevantContext(flowMap: FlowMap, item: PlanItem): string {
  const words = new Set(
    `${item.title} ${item.steps.join(' ')} ${item.assertions.join(' ')}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );

  const scored = flowMap.nodes
    .map((node) => {
      const hay = `${node.route} ${node.title} ${node.forms
        .map((f) => f.fields.map((x) => `${x.name} ${x.label ?? ''}`).join(' '))
        .join(' ')} ${node.affordances.map((a) => a.label).join(' ')}`.toLowerCase();
      const score = [...words].filter((w) => hay.includes(w)).length;
      return { node, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .filter((entry) => entry.score > 0 || flowMap.nodes.length <= 6);

  return scored
    .map(({ node }) => {
      const locators = [
        ...node.affordances.map((a) => ({ label: a.label, sel: a.selector })),
        ...node.forms.flatMap((f) =>
          f.fields.map((x) => ({ label: x.label ?? x.name, sel: x.selector })),
        ),
      ]
        .map(
          (entry) =>
            `      ${describeSelector(entry.sel)}  [confidence ${entry.sel.confidence.toFixed(2)}]`,
        )
        .join('\n');

      return `  ${node.route} — "${node.title}"${node.behindAuth ? ' (behind auth)' : ''}
${locators || '      (no locators captured)'}`;
    })
    .join('\n\n');
}

function describeSelector(sel: { strategy: string; value: string; name?: string }): string {
  switch (sel.strategy) {
    case 'ROLE':
      return `getByRole('${sel.value}', { name: ${JSON.stringify(sel.name ?? '')} })`;
    case 'LABEL':
      return `getByLabel(${JSON.stringify(sel.value)})`;
    case 'PLACEHOLDER':
      return `getByPlaceholder(${JSON.stringify(sel.value)})`;
    case 'TEXT':
      return `getByText(${JSON.stringify(sel.value)})`;
    case 'TEST_ID':
      return `getByTestId(${JSON.stringify(sel.value)})`;
    default:
      return `locator(${JSON.stringify(sel.value)})`;
  }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export async function generateTest(
  llm: LlmService,
  ctx: CallContext,
  args: {
    item: PlanItem;
    flowMap: FlowMap;
    language: Language;
    framework: UiFramework;
    /** Secret names available as env vars — values are never sent to the model. */
    availableSecretNames?: string[];
  },
): Promise<GeneratedTest> {
  const { item, flowMap, framework } = args;
  const rules = FRAMEWORK_RULES[framework] ?? PLAYWRIGHT_TS_RULES;

  /**
   * `fixtures/` is reserved for test data — anything under it is excluded from run
   * selection. Features come from the crawl's first URL segment, so an app with a
   * top-level `/fixtures` route (a league site, a lighting store) would otherwise
   * put a real test somewhere it can never run.
   */
  const featureDir = slugify(item.feature);
  const suggestedPath = `${
    featureDir === FIXTURE_PREFIX.slice(0, -1) ? `${featureDir}-feature` : featureDir
  }/${slugify(item.title)}.spec.ts`;

  const prompt = `TEST PLAN ITEM
  title:      ${item.title}
  rationale:  ${item.rationale}
  feature:    ${item.feature}
  priority:   ${item.priority}
  type:       ${item.testType}

  steps:
${item.steps.map((s, i) => `    ${i + 1}. ${s}`).join('\n')}

  assertions:
${item.assertions.map((a) => `    - ${a}`).join('\n')}

PAGES AND REAL LOCATORS FROM THE CRAWL
${relevantContext(flowMap, item) || '  (no matching states — infer carefully and flag it)'}

BASE URL: ${flowMap.baseUrl} (configured as baseURL; use relative paths)
${
  args.availableSecretNames?.length
    ? `AVAILABLE SECRETS (read via process.env, never inline the value):
  ${args.availableSecretNames.join(', ')}`
    : ''
}

${rules}

Return:
  name         the test name as it appears in test('...')
  filePath     a repo-relative path; use "${suggestedPath}" unless you have a reason not to
  code         the complete file contents
  reviewFlags  anything a human should check before trusting this test`;

  const generated = await llm.structured(ctx, {
    tier: 'strong',
    effort: 'high',
    system: SYSTEM,
    prompt,
    schema: generatedTestSchema,
    schemaName: 'GeneratedTest',
    maxTokens: 16000,
    cacheSystem: true,
  });

  // Belt and braces on the no-lock-in promise: if the model reached for a QAAI
  // import despite the instruction, that is a review flag rather than a silent
  // dependency in the customer's repo.
  const flags = [...generated.reviewFlags];
  if (/@qaai\//.test(generated.code)) {
    flags.push(
      'Generated code imports from @qaai — it must be standalone; rewrite before committing',
    );
  }
  if (/waitForTimeout|Thread\.sleep|time\.sleep/.test(generated.code)) {
    flags.push('Generated code contains a fixed sleep, which is a flake source');
  }

  return { ...generated, reviewFlags: flags };
}
