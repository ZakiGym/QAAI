/**
 * Explorer (§3.1) — turns a Flow Map into a plain-English test plan a human
 * approves before any code is written.
 *
 * The crawl is deterministic (crawler.ts). This file is the judgement half:
 * given what exists, what is worth testing, at what priority, and why.
 */

import { testPlanSchema } from '@qaai/shared';
import type { FlowMap, TestPlan } from '@qaai/shared';
import type { CallContext, LlmService } from './llm.js';

const SYSTEM = `You are the Explorer agent inside QAAI, an AI QA engineer.

You are given a Flow Map: a graph of the pages, states, forms, and journeys a
crawler discovered in a web application. Your job is to propose a test plan that
a staff QA engineer would recognise as sensible, and that a product manager
could read without knowing any code.

How to think about it:

- Test what a user is trying to accomplish, not what a page contains. "Check out
  with two items in the cart" is a test. "Check the cart page renders" is not.
- Assert meaning, never pixels. A good assertion is "the order total equals
  subtotal plus shipping plus tax" — something that can be wrong while the page
  still looks perfectly fine. A bad one is "the heading says Cart".
- Arithmetic, state transitions, and permission boundaries are where real bugs
  live. Prefer them over presence checks.
- Cover the unhappy paths the crawler found: out-of-stock items, empty states,
  validation failures, pages behind an auth wall.
- Priority means: CRITICAL_PATH is revenue or access — if it breaks, the
  business stops. IMPORTANT is a real feature users touch daily. NICE_TO_HAVE is
  everything else. Be honest; a plan where everything is critical is useless.
- Steps are imperative and concrete ("Add the Burr Grinder to the cart"), so the
  Generator can turn each one into a single action.

Choose the test type per item:
  E2E            multi-step user journeys through the UI
  SMOKE          one or two steps proving a critical path is alive
  API            when the check is about a response, not a screen
  ACCESSIBILITY  a page whose markup is worth an axe scan
  SECURITY_SMOKE auth walls and ids in URLs

Also report what you deliberately skipped and why. A plan that silently omits a
whole feature is worse than one that says "skipped payments — no test card".`;

function summariseFlowMap(flowMap: FlowMap): string {
  const nodes = flowMap.nodes
    .map((node) => {
      const forms = node.forms
        .map(
          (form) =>
            `      form "${form.name}": ${form.fields
              .map((f) => `${f.name}(${f.semantic}${f.required ? ', required' : ''})`)
              .join(', ')}`,
        )
        .join('\n');
      const actions = node.affordances
        .slice(0, 8)
        .map((a) => a.label)
        .join(', ');

      return [
        `  ${node.route} — "${node.title}" [state: ${node.stateKey}]${
          node.behindAuth ? ' (BEHIND AUTH)' : ''
        }`,
        actions ? `      buttons: ${actions}` : null,
        forms || null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  const journeys = flowMap.journeys
    .map((j) => `  ${j.id}: ${j.name} — ${j.description} [${j.priority}]`)
    .join('\n');

  const features = flowMap.features
    .map((f) => `  ${f.name} (${f.nodeIds.length} states)`)
    .join('\n');

  return `Base URL: ${flowMap.baseUrl}
Crawled: ${flowMap.nodes.length} states, ${flowMap.edges.length} transitions
${flowMap.truncatedReason ? `NOTE: the crawl was truncated — ${flowMap.truncatedReason}\n` : ''}
FEATURES
${features || '  (none inferred)'}

STATES
${nodes || '  (none)'}

JOURNEYS
${journeys || '  (none derived)'}`;
}

export interface ExploreResult {
  plan: TestPlan;
}

export async function proposePlan(
  llm: LlmService,
  ctx: CallContext,
  flowMap: FlowMap,
  opts: { maxItems?: number } = {},
): Promise<ExploreResult> {
  const maxItems = opts.maxItems ?? 12;

  const prompt = `${summariseFlowMap(flowMap)}

Propose at most ${maxItems} test items for this application.

Every item needs:
  title       one line a PM would understand
  rationale   one or two sentences on why this is worth testing
  feature     which feature group above it belongs to
  priority    CRITICAL_PATH | IMPORTANT | NICE_TO_HAVE
  testType    E2E | SMOKE | API | ACCESSIBILITY | SECURITY_SMOKE
  steps       ordered imperative steps
  assertions  what must be true at the end, in terms of meaning
  journeyId   the journey id this came from, or null
  authProfileId  always null (auth profiles are wired up separately)

Set "id" on each item to a short kebab-case slug derived from the title.
Give at least one item per feature group where a meaningful test exists.`;

  const plan = await llm.structured(ctx, {
    tier: 'cheap',
    effort: 'medium',
    system: SYSTEM,
    prompt,
    schema: testPlanSchema,
    schemaName: 'TestPlan',
    maxTokens: 16000,
    // The system prompt is identical across every project, so caching it pays
    // for itself the second time anyone runs the Explorer.
    cacheSystem: true,
  });

  return { plan: { ...plan, flowMapVersion: flowMap.version } };
}
