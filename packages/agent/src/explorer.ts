/**
 * Explorer (§3.1) — turns a Flow Map into a plain-English test plan a human
 * approves before any code is written.
 *
 * The crawl is deterministic (crawler.ts). This file is the judgement half:
 * given what exists, what is worth testing, at what priority, and why.
 */

import { testPlanSchema } from '@qaai/shared';
import type { FlowMap, TestPlan } from '@qaai/shared';
import type { AuthProfileChoice } from './coverage.js';
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
- A page marked BEHIND AUTH cannot be tested by a signed-out visitor. If an auth
  profile is offered below, name it on the item so the test runs as that role;
  the runner injects the session, so the test must NOT contain a login form.
  Where a page lists REQUIRES ROLES, pick the profile that matches it. If no
  profile fits, set authProfileId to null and say in the rationale that the item
  only proves the wall holds — never claim to cover the page itself.
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

/**
 * The roles on offer, rendered for the prompt.
 *
 * Names and ids only. A model choosing which role a test assumes has no need of
 * a credential, and a prompt is the last place to put one — `llm.ts` masks
 * secrets on the way out, and the way to keep that true is not to hand it any.
 */
function summariseAuthProfiles(profiles: AuthProfileChoice[]): string {
  if (profiles.length === 0) {
    return `AUTH PROFILES
  (none configured on this environment — every item's authProfileId must be null,
   and anything behind an auth wall can only be tested as a signed-out visitor)`;
  }
  return `AUTH PROFILES
${profiles
  .map((profile) => `  ${profile.id} — "${profile.name}"${profile.kind ? ` (${profile.kind})` : ''}`)
  .join('\n')}`;
}

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

      /*
       * `requiresRoles` is the application's own statement about who may see
       * this state — the best evidence there is for which profile an item
       * should name, and leaving it out of the prompt was half of why the
       * Explorer had nothing to go on and was told to answer null.
       *
       * Guarded because this FlowMap is typed on the way in but deserialised
       * from a Json column on the way here, and a crawl written before the
       * field existed has no array to filter.
       */
      const roles = Array.isArray(node.requiresRoles) ? node.requiresRoles.filter(Boolean) : [];

      return [
        `  ${node.route} — "${node.title}" [state: ${node.stateKey}]${
          node.behindAuth ? ' (BEHIND AUTH)' : ''
        }${roles.length > 0 ? ` (REQUIRES ROLES: ${roles.join(', ')})` : ''}`,
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
  opts: { maxItems?: number; authProfiles?: AuthProfileChoice[] } = {},
): Promise<ExploreResult> {
  const maxItems = opts.maxItems ?? 12;
  const authProfiles = opts.authProfiles ?? [];
  const profileIds = new Set(authProfiles.map((profile) => profile.id));

  const prompt = `${summariseFlowMap(flowMap)}

${summariseAuthProfiles(authProfiles)}

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
  authProfileId  the id of the auth profile this test must run as, copied
                 EXACTLY from the AUTH PROFILES list above, or null for a test
                 that runs as a signed-out visitor. Required for anything
                 BEHIND AUTH; invented ids are discarded.

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

  /*
   * EVERY PROFILE ID THE MODEL RETURNED IS CHECKED AGAINST THE LIST WE GAVE IT.
   *
   * `PlanItem.authProfileId` has no foreign key (it is a loose column on the
   * PlanItem table), so a plausible-looking id the model invented would be
   * stored without complaint, travel to the Generator, and produce a test bound
   * to a profile that does not exist. Where that lands depends on the runner:
   * at best a hard failure a long way from here, at worst a test that quietly
   * runs anonymously and passes — which is the exact defect this whole change
   * exists to remove, re-introduced by the one producer that cannot be checked
   * by a database constraint.
   *
   * So an unrecognised id becomes null, and the plan says so in `skipped`
   * rather than dropping it silently: a plan whose items lost their roles with
   * no explanation reads as the Explorer's judgement.
   */
  const invented: string[] = [];
  const items = plan.items.map((item) => {
    if (item.authProfileId === null || profileIds.has(item.authProfileId)) return item;
    invented.push(`${item.title} → ${item.authProfileId}`);
    return { ...item, authProfileId: null };
  });

  return {
    plan: {
      ...plan,
      items,
      skipped: [
        ...plan.skipped,
        ...(invented.length > 0
          ? [
              {
                what: 'Auth profile bindings on ' + invented.length + ' item(s)',
                why:
                  'The Explorer named auth profile id(s) that do not exist on this environment (' +
                  invented.slice(0, 5).join('; ') +
                  '), so those items were left unbound and will run as a signed-out visitor. If any of them is behind an auth wall, bind a real profile before generating it.',
              },
            ]
          : []),
      ],
      flowMapVersion: flowMap.version,
    },
  };
}
