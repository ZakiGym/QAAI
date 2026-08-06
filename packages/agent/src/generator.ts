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

import { z } from 'zod';
import { NEW_TEST_TEMPLATES, TEST_TYPE_LABELS, generatedTestSchema } from '@qaai/shared';
import type { FlowMap, Language, PlanItem, UiFramework } from '@qaai/shared';
import type { EcosystemId } from './ecosystem-prompts.js';
import {
  ECOSYSTEMS,
  UNIVERSAL_RULES,
  findsFixedSleep,
  resolveEcosystem,
  testFilePath,
} from './ecosystem-prompts.js';
import { LlmError, NO_KEY_SENTENCE } from './llm.js';
import type { CallContext, LlmService } from './llm.js';
import {
  generationStrategyFor,
  specFilePathFor,
  specPointerCode,
  specSchemaText,
} from './spec-strategies.js';
import type { HybridStrategy, SpecDrivenStrategy } from './spec-strategies.js';

export interface GeneratedTest {
  name: string;
  filePath: string;
  code: string;
  reviewFlags: string[];
  /**
   * The plugin-validated JSON for spec-driven and hybrid types; null for the
   * pure code types, whose plugins never read it. Persisted as `Test.spec`.
   */
  spec: unknown;
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

export interface GenerateTestArgs {
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
}

/**
 * One entry point, three shapes out — decided by the TYPE's strategy, which is
 * decided by what the type's plugin executes. The old behaviour (Playwright
 * prose for every type) shipped tests whose own plugin rejected them at
 * validate(); now a spec-driven item produces a spec the plugin's schema has
 * already accepted, or nothing at all.
 */
export async function generateTest(
  llm: LlmService,
  ctx: CallContext,
  args: GenerateTestArgs,
): Promise<GeneratedTest> {
  const strategy = generationStrategyFor(args.item.testType);
  if (strategy.mode === 'spec') return generateSpecDriven(llm, ctx, args, strategy);
  return generateCodeTest(llm, ctx, args, strategy);
}

async function generateCodeTest(
  llm: LlmService,
  ctx: CallContext,
  args: GenerateTestArgs,
  strategy: { mode: 'code'; seededSpec?: unknown; forcePlaywright?: boolean } | HybridStrategy,
): Promise<GeneratedTest> {
  const { item, flowMap, language, framework } = args;

  // Test code has no deterministic fallback: a placeholder journey that
  // ignores the plan's steps would go green over nothing, which is worse than
  // this refusal. The sentence is THE no-key sentence, so every surface that
  // already explains the fix explains this too.
  if (!llm.configured) {
    throw new LlmError(
      `${NO_KEY_SENTENCE}. A ${item.testType} test is a journey only a model (or a human in the editor) can write.`,
      'AUTH',
    );
  }

  const projectEcosystem = resolveEcosystem({
    language,
    framework,
    testType: item.testType,
    runner: args.runner ?? null,
  });
  // CROSS_BROWSER and LOCALIZATION execute through the matrix plugin, which
  // drives Playwright itself per engine/locale — their code must be a
  // Playwright TypeScript spec no matter what dialect the project writes.
  const ecosystem = strategy.forcePlaywright ? ECOSYSTEMS.PLAYWRIGHT_TS : projectEcosystem;
  const suggestedPath = testFilePath(ecosystem, { feature: item.feature, title: item.title });

  const hybridReturnLines =
    strategy.mode === 'hybrid'
      ? `\n  spec         the runner configuration described under THE SPEC below`
      : '';
  const hybridSpecSection =
    strategy.mode === 'hybrid'
      ? `

THE SPEC
${strategy.specNotes}

Its JSON Schema:
${specSchemaText(strategy.schema)}`
      : '';

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
  code         the complete file contents${hybridReturnLines}
  reviewFlags  anything a human should check before trusting this test${hybridSpecSection}`;

  // Hybrids validate the spec against the plugin's own schema in the same
  // structured call — a near-miss shape gets the one repair retry, and a
  // second miss throws rather than storing a spec the plugin would reject.
  const generated = (await llm.structured(ctx, {
    tier: 'strong',
    effort: 'high',
    system: SYSTEM,
    prompt,
    schema:
      strategy.mode === 'hybrid'
        ? generatedTestSchema.extend({ spec: strategy.schema })
        : generatedTestSchema,
    schemaName: strategy.mode === 'hybrid' ? `Generated${item.testType}Test` : 'GeneratedTest',
    maxTokens: 16000,
    cacheSystem: true,
  })) as z.infer<typeof generatedTestSchema> & { spec?: unknown };

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

  // The forced dialect deserves the same honesty as the paragraph above: a
  // Python shop should know why this one file is TypeScript.
  if (strategy.forcePlaywright && projectEcosystem.id !== 'PLAYWRIGHT_TS') {
    flags.push(
      `Written as Playwright TypeScript rather than ${projectEcosystem.label}: the ${item.testType} runner executes Playwright specs itself, once per ${
        item.testType === 'LOCALIZATION' ? 'locale' : 'browser engine'
      }.`,
    );
  }

  // A UNIT_GEN spec whose command does not name the generated file runs
  // something else and reports on that instead — flag it against the FINAL
  // path, which may differ from the one the model wrote the command around.
  if (
    strategy.mode === 'hybrid' &&
    item.testType === 'UNIT_GEN' &&
    !JSON.stringify(generated.spec ?? null).includes(filePath)
  ) {
    flags.push(
      `The external command spec does not reference "${filePath}" — check its args actually run the generated file.`,
    );
  }

  return {
    ...generated,
    filePath,
    reviewFlags: flags,
    spec: strategy.mode === 'hybrid' ? generated.spec : (strategy.seededSpec ?? null),
  };
}

// ─── Spec-driven types (§3.2) ────────────────────────────────────────────────

const SPEC_SYSTEM = `You are the Generator agent inside QAAI, an AI QA engineer.

You turn one approved test plan item into a machine-readable test SPEC — a JSON
document a purpose-built runner executes directly. There is no code to write:
the spec IS the test, and it is validated against a strict schema before it is
stored. A spec that does not parse is discarded, so obey the schema exactly —
no extra keys, no prose in value positions, no placeholders like "<fill me in>".

Ground the spec in the crawl data you are given: real routes, real selectors,
real form fields. Do not invent endpoints or selectors that are not in the
material; when the plan needs something the crawl did not capture, choose the
most plausible value and add a reviewFlag saying it was inferred.

Secrets are referenced BY NAME (the runner resolves them from a vault at
execution time). Never place a credential value, a token, or a DSN in the spec.

Put anything a human should check into reviewFlags: inferred routes or
selectors, assumptions about test data, thresholds chosen without evidence.`;

/**
 * A spec-driven item becomes a JSON spec validated against the PLUGIN's own
 * schema — with a model when a key exists, from the deterministic scaffold
 * when the strategy has one, and an honest refusal otherwise. In no branch can
 * a test row appear whose spec its plugin rejects: `llm.structured` parses the
 * response with the plugin schema (one repair retry, then throw), and the
 * scaffolds are pinned to `plugin.validate()` by the worker's unit tests.
 */
async function generateSpecDriven(
  llm: LlmService,
  ctx: CallContext,
  args: GenerateTestArgs,
  strategy: SpecDrivenStrategy,
): Promise<GeneratedTest> {
  const { item, flowMap } = args;
  const filePath = specFilePathFor(item.testType, item.title);
  const code = specPointerCode(item.testType);

  if (!llm.configured) {
    if (strategy.scaffold) {
      const { spec, reviewFlags } = strategy.scaffold({ item, flowMap });
      return { name: item.title, filePath, code, spec, reviewFlags };
    }
    // The per-type justification lives on the strategy; the sentence in front
    // of it is THE no-key sentence, unchanged, so the fix reads the same on
    // every surface that reports this.
    throw new LlmError(
      `${NO_KEY_SENTENCE}. A ${item.testType} test cannot be scaffolded without a model because ${strategy.refuseBecause}.`,
      'AUTH',
    );
  }

  const template = NEW_TEST_TEMPLATES[item.testType];

  const prompt = `TEST PLAN ITEM
  title:      ${item.title}
  rationale:  ${item.rationale}
  feature:    ${item.feature}
  priority:   ${item.priority}
  type:       ${item.testType} — ${TEST_TYPE_LABELS[item.testType]}

  steps:
${item.steps.map((s, i) => `    ${i + 1}. ${s}`).join('\n')}

  assertions:
${item.assertions.map((a) => `    - ${a}`).join('\n')}

PAGES AND REAL LOCATORS FROM THE CRAWL
Selectors are written in Playwright's role/label vocabulary because that is how
the crawler records them; where the spec takes CSS selectors, translate to the
most stable equivalent and flag anything you had to infer.
${relevantContext(flowMap, item) || '  (no matching states — infer carefully and flag it)'}

BASE URL: ${flowMap.baseUrl} (paths in the spec resolve against it)
${
  args.availableSecretNames?.length
    ? `AVAILABLE SECRETS (reference by name, never by value):
  ${args.availableSecretNames.join(', ')}`
    : ''
}

THE SPEC
${strategy.specNotes}

Its JSON Schema (your "spec" field must satisfy it):
${specSchemaText(strategy.schema)}
${
  template?.spec
    ? `
A MINIMAL VALID EXAMPLE (shape reference only — write the real thing from the plan):
${JSON.stringify(template.spec, null, 2)}`
    : ''
}

Return:
  name         the test's name as a human reads it in the suite
  spec         the complete spec object
  reviewFlags  anything a human should check before trusting this test`;

  const generated = await llm.structured(ctx, {
    tier: 'strong',
    effort: 'high',
    system: SPEC_SYSTEM,
    prompt,
    schema: z.object({
      name: z.string().min(1).max(160),
      spec: strategy.schema,
      reviewFlags: z.array(z.string()).default([]),
    }),
    schemaName: `${item.testType}TestSpec`,
    maxTokens: 16000,
    cacheSystem: true,
  });

  return {
    name: generated.name,
    filePath,
    code,
    spec: generated.spec,
    reviewFlags: generated.reviewFlags,
  };
}
