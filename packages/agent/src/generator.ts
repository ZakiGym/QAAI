/**
 * Generator (§3.2) — turns an approved plan item into real test code.
 *
 * Three hard requirements from the spec shape everything here:
 *   1. The output is standard code the customer owns. No QAAI imports, no
 *      proprietary helpers — a generated test must run under the ecosystem's own
 *      command (`npx playwright test`, `pytest`, `go test ./...`) with QAAI
 *      uninstalled.
 *   2. Selectors are resilient and assertions check meaning. The Flow Map hands
 *      the model real locators with confidence scores so it does not invent
 *      brittle CSS, and anything low-confidence comes back as a review flag.
 *   3. It is written in the team's OWN dialect. "Correct Python" is not the bar;
 *      a pytest fixture rather than a setUp method is. Everything that makes
 *      code idiomatic per ecosystem lives in `ecosystem-prompts.ts`, and this
 *      file's job is to pick the right one and hold it to the universal rules.
 */

import { generatedTestSchema } from '@qaai/shared';
import type { FlowMap, Language, PlanItem, UiFramework } from '@qaai/shared';
import type { EcosystemId } from './ecosystem-prompts.js';
import {
  UNIVERSAL_RULES,
  findsFixedSleep,
  resolveEcosystem,
  testFilePath,
} from './ecosystem-prompts.js';
import type { CallContext, LlmService } from './llm.js';

export interface GeneratedTest {
  name: string;
  filePath: string;
  code: string;
  reviewFlags: string[];
}

const SYSTEM = `You are the Generator agent inside QAAI, an AI QA engineer.

You turn one approved test plan item into working test code. The code you write
is committed to the customer's own repository and must run without QAAI
installed — it is their code, not ours. Never import anything from a "qaai"
package and never reference QAAI in the source.

You write in whatever language and framework the project uses, and you write it
the way that ecosystem's own engineers would. Code that merely compiles is not
the bar: a test that reads as foreign is a test nobody on the team will maintain.

You are given the exact locators a crawler found on the real page, each with a
confidence score. Use them. Do not invent selectors for elements that are not in
the list; if the plan needs an element you were not given, use the most robust
role- or text-based locator you can and add a reviewFlag saying it was inferred.

Put anything a human should look at into reviewFlags: inferred locators,
low-confidence locators (below 0.6), assumptions about test data, or steps you
could not express faithfully.

${UNIVERSAL_RULES}`;

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
    /**
     * Overrides the (language, framework) default — a Java shop on TestNG, a
     * team that writes Gherkin. Nothing in the product sets this yet; the
     * project model carries no runner preference.
     */
    runner?: EcosystemId | null;
  },
): Promise<GeneratedTest> {
  const { item, flowMap, language, framework } = args;

  const ecosystem = resolveEcosystem({
    language,
    framework,
    testType: item.testType,
    runner: args.runner ?? null,
  });
  const suggestedPath = testFilePath(ecosystem, { feature: item.feature, title: item.title });

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
These are written in Playwright's role/label vocabulary because that is how the
crawler records them. Translate each one into ${ecosystem.label}'s own locator
API, keeping the same target. Where that ecosystem has no equivalent — no role
engine, CSS only — pick the most stable selector it does have and add a
reviewFlag saying what was lost.
${relevantContext(flowMap, item) || '  (no matching states — infer carefully and flag it)'}

BASE URL: ${flowMap.baseUrl} (configured for the suite; navigate with relative paths)
${
  args.availableSecretNames?.length
    ? `AVAILABLE SECRETS (read from the environment, never inline the value):
  ${args.availableSecretNames.join(', ')}`
    : ''
}

ECOSYSTEM: ${ecosystem.label}

${ecosystem.rules}

Return:
  name         the test name as it appears in the test declaration
  filePath     "${suggestedPath}". The convention is ${ecosystem.pathRule}, and the
               runner collects by that pattern — a path outside it is a test that
               silently never runs. Deviate only to satisfy the same convention
               better (a package or class name the code requires).
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
  if (findsFixedSleep(generated.code)) {
    flags.push('Generated code contains a fixed sleep, which is a flake source');
  }

  /**
   * A path the ecosystem's runner cannot collect is worse than a wrong path: the
   * suite goes green over a file nobody executed. The convention is mechanical,
   * so prefer the computed path over the model's and say that we did.
   */
  let filePath = generated.filePath;
  if (!ecosystem.filePattern.test(filePath)) {
    flags.push(
      `The model proposed "${filePath}", which ${ecosystem.label} does not collect (${ecosystem.pathRule}). Saved as "${suggestedPath}" — check any package, namespace, or class declaration in the code still matches.`,
    );
    filePath = suggestedPath;
  }

  // E2E and SMOKE execute through QAAI's Playwright harness, which only knows
  // how to run a Playwright TypeScript spec. Everything else is real, ownable
  // code that this worker cannot execute in-process — say so at generation time
  // rather than letting it surface as a confusing validation error at run time.
  if (ecosystem.id !== 'PLAYWRIGHT_TS' && (item.testType === 'E2E' || item.testType === 'SMOKE')) {
    flags.push(
      `Written for ${ecosystem.label}. QAAI runs E2E/SMOKE natively only for Playwright TypeScript — run this through an INTEGRATION test that invokes the suite's own command, or export the repo and run it in your CI.`,
    );
  }

  return { ...generated, filePath, reviewFlags: flags };
}
