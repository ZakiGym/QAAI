/**
 * The Generator's per-type honesty contract (§3.2), enforced.
 *
 * The bug this file pins shut: the Generator wrote Playwright prose for every
 * TestType, and for the fourteen spec-driven types the plugin's validate()
 * rejected the null spec — FAILED "invalid spec" on the first run of a test
 * the product itself authored. The fix routes each type through a strategy in
 * @qaai/agent's spec-strategies, and this suite holds every strategy to the
 * only standard that matters: THE TYPE'S OWN PLUGIN, imported from
 * @qaai/runner, must accept what the Generator emits. This is the one package
 * that depends on both sides, which is why the test lives here and not in
 * packages/agent.
 *
 * Two properties are proven, one per mode of the no-key deployment this
 * product currently ships on:
 *   1. Deterministic scaffolds (no model) parse under plugin.validate() — for
 *      a rich crawl, and for an empty one.
 *   2. Types that cannot scaffold refuse with the standing no-key sentence,
 *      never with a stored-but-unrunnable row.
 * The with-model path is validated structurally: each strategy's schema must
 * accept the editor's NEW_TEST_TEMPLATES spec for that type, which
 * packages/runner/src/plugins/new-test-templates.test.ts already holds to
 * plugin.validate() — so "schema-valid implies plugin-valid" is closed as a
 * triangle rather than asserted.
 */

import { describe, expect, it } from 'vitest';
import {
  LlmService,
  NO_KEY_SENTENCE,
  canScaffoldWithoutModel,
  generateTest,
  generationStrategyFor,
  scaffoldSpec,
  specFilePathFor,
  specPointerCode,
} from '@qaai/agent';
import { MODEL_FREE_TEST_TYPES, NEW_TEST_TEMPLATES, TEST_TYPES } from '@qaai/shared';
import type { ExecutableTest, FlowMap, PlanItem, TestType } from '@qaai/shared';
import { pluginFor } from '@qaai/runner';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function node(route: string, behindAuth = false): FlowMap['nodes'][number] {
  return {
    id: `node:${route}`,
    route,
    url: `https://shop.example${route}`,
    title: route,
    stateKey: 'default',
    requiresRoles: [],
    behindAuth,
    forms: [],
    affordances: [],
    screenshotKey: null,
    a11yViolationCount: 0,
  };
}

/** A crawl like the demo store's: public pages, a dynamic route, an auth wall. */
const crawledFlowMap: FlowMap = {
  projectId: 'p1',
  environmentId: 'e1',
  version: 1,
  baseUrl: 'https://shop.example',
  nodes: [
    node('/'),
    node('/products'),
    node('/products'), // duplicate state on one route — must not double-list
    node('/orders/:id'), // dynamic — no real id exists to substitute
    node('/cart'),
    node('/admin', true),
    node('/account', true),
  ],
  edges: [],
  journeys: [],
  features: [],
  exploredAt: new Date().toISOString(),
  truncatedReason: null,
};

/** The worst case: a crawl that saw nothing. Scaffolds must still be runnable. */
const emptyFlowMap: FlowMap = { ...crawledFlowMap, nodes: [] };

function planItem(testType: TestType): PlanItem {
  return {
    id: 'item-1',
    title: 'The storefront answers honestly',
    rationale: 'Because the survey said so.',
    feature: 'Storefront',
    priority: 'IMPORTANT',
    testType,
    steps: ['Open the storefront'],
    assertions: ['The storefront responds'],
    journeyId: null,
    authProfileId: null,
  };
}

/** Exactly the row the worker would store, run through the plugin's eyes. */
function executable(type: TestType, spec: unknown): ExecutableTest {
  return {
    id: 'generated-under-test',
    name: 'The storefront answers honestly',
    type,
    code: specPointerCode(type),
    filePath: specFilePathFor(type, 'The storefront answers honestly'),
    spec,
    timeoutMs: 60_000,
    quarantined: false,
    tags: [],
  };
}

/** A no-key LlmService — the deployment this product currently runs on. */
const noKeyLlm = new LlmService({
  apiKey: '',
  cheapModel: 'cheap-model',
  strongModel: 'strong-model',
  maxRetries: 0,
  monthlyTokenBudget: 0,
});

const SCAFFOLDABLE = TEST_TYPES.filter((t) => canScaffoldWithoutModel(t));

// ─── 1. Scaffolds parse under the plugin's own loader ────────────────────────

describe('deterministic scaffolds', () => {
  it('exist for exactly the types whose spec a crawl can fill', () => {
    // The list is a design decision, so a change to it must be a conscious
    // diff here: these are the types whose required fields the crawl supplies.
    expect(SCAFFOLDABLE.sort()).toEqual(
      ['ACCESSIBILITY', 'API', 'LOAD', 'PERFORMANCE', 'SECURITY_SMOKE', 'VISUAL'].sort(),
    );
  });

  /*
   * The first-run funnel tells someone choosing test types which ones this
   * deployment can produce with no ANTHROPIC_API_KEY, and it reads that from
   * @qaai/shared because the browser bundle cannot import @qaai/agent. This is
   * what stops the two drifting: add a scaffold without listing it and the
   * funnel understates what a key-less deployment can do; list one that does
   * not exist and it promises a test nothing will ever write.
   */
  it('are exactly what MODEL_FREE_TEST_TYPES tells the web app they are', () => {
    expect([...MODEL_FREE_TEST_TYPES].sort()).toEqual(SCAFFOLDABLE.sort());
  });

  for (const type of SCAFFOLDABLE) {
    it(`${type}: the plugin accepts the scaffold from a real crawl`, () => {
      const scaffold = scaffoldSpec(type, { item: planItem(type), flowMap: crawledFlowMap });
      expect(scaffold).not.toBeNull();
      const plugin = pluginFor(type);
      expect(plugin).not.toBeNull();
      expect(() => plugin!.validate(executable(type, scaffold!.spec))).not.toThrow();
      // The scaffold must announce itself — the UI's review queue is the
      // whole reason shipping it without a model is honest.
      expect(scaffold!.reviewFlags.length).toBeGreaterThan(0);
      expect(scaffold!.reviewFlags.join(' ')).toContain('Scaffolded without a model');
    });

    it(`${type}: the plugin accepts the scaffold from an EMPTY crawl`, () => {
      const scaffold = scaffoldSpec(type, { item: planItem(type), flowMap: emptyFlowMap });
      expect(() => pluginFor(type)!.validate(executable(type, scaffold!.spec))).not.toThrow();
    });

    it(`${type}: the file path is storable`, () => {
      // createTestSchema's traversal guard, restated: relative, no dot-dot.
      const path = specFilePathFor(type, planItem(type).title);
      expect(path.startsWith('/')).toBe(false);
      expect(path.includes('..')).toBe(false);
    });
  }

  it('SECURITY_SMOKE: lists exactly the auth-walled routes the crawler saw', () => {
    const scaffold = scaffoldSpec('SECURITY_SMOKE', {
      item: planItem('SECURITY_SMOKE'),
      flowMap: crawledFlowMap,
    })!;
    const spec = scaffold.spec as { authRequiredPaths: string[]; headerPaths: string[] };
    expect(spec.authRequiredPaths).toEqual(['/admin', '/account']);
    // Public routes only, deduplicated, dynamic segments excluded.
    expect(spec.headerPaths).toEqual(['/', '/products', '/cart']);
  });

  it('ACCESSIBILITY: scans public crawled routes, never the ones behind auth', () => {
    const scaffold = scaffoldSpec('ACCESSIBILITY', {
      item: planItem('ACCESSIBILITY'),
      flowMap: crawledFlowMap,
    })!;
    expect((scaffold.spec as { routes: string[] }).routes).toEqual(['/', '/products', '/cart']);
  });
});

// ─── 2. The with-model schemas agree with the plugins ────────────────────────

describe('strategy schemas', () => {
  // Every spec/hybrid strategy validates the model's output with `schema`.
  // The editor's template for the same type is already proven against the
  // plugin (new-test-templates.test.ts), so `schema.parse(template)` passing
  // closes the triangle: what the Generator's validation accepts, the plugin
  // accepts. A schema stricter than the plugin is fine; looser is the bug.
  for (const type of TEST_TYPES) {
    const strategy = generationStrategyFor(type);
    if (strategy.mode === 'code') continue;
    const template = NEW_TEST_TEMPLATES[type];

    it(`${type}: the strategy schema accepts the plugin-blessed template spec`, () => {
      expect(template?.spec, `${type} has no editor template to pin against`).toBeDefined();
      const parsed = strategy.schema.safeParse(template!.spec);
      expect(
        parsed.success,
        parsed.success ? undefined : JSON.stringify(parsed.error?.issues, null, 2),
      ).toBe(true);
    });
  }

  it('every TestType has a strategy and a plugin', () => {
    for (const type of TEST_TYPES) {
      expect(generationStrategyFor(type), `${type} has no generation strategy`).toBeDefined();
      expect(pluginFor(type), `${type} has no plugin`).not.toBeNull();
    }
  });
});

// ─── 3. generateTest without a model: scaffold or the standing sentence ──────

describe('generateTest with no ANTHROPIC_API_KEY', () => {
  const args = (type: TestType) => ({
    item: planItem(type),
    flowMap: crawledFlowMap,
    language: 'TYPESCRIPT' as const,
    framework: 'PLAYWRIGHT' as const,
  });

  it('scaffolds a spec-driven type into a row its plugin accepts', async () => {
    const generated = await generateTest(noKeyLlm, ctx(), args('API'));
    expect(generated.filePath).toBe('api/the-storefront-answers-honestly.api.json');
    expect(generated.code).toContain('driven by `spec`');
    expect(() =>
      pluginFor('API')!.validate({ ...executable('API', generated.spec), code: generated.code }),
    ).not.toThrow();
    expect(generated.reviewFlags.join(' ')).toContain('Scaffolded without a model');
  });

  it('refuses a spec type the crawl cannot fill, with the standing sentence', async () => {
    await expect(generateTest(noKeyLlm, ctx(), args('DATABASE'))).rejects.toThrow(NO_KEY_SENTENCE);
  });

  it('refuses code types with the standing sentence rather than a placeholder journey', async () => {
    await expect(generateTest(noKeyLlm, ctx(), args('E2E'))).rejects.toThrow(NO_KEY_SENTENCE);
    await expect(generateTest(noKeyLlm, ctx(), args('UNIT_GEN'))).rejects.toThrow(NO_KEY_SENTENCE);
  });

  function ctx() {
    return { orgId: 'org1', projectId: 'p1', agent: 'GENERATOR' as const, subjectId: 'item-1' };
  }
});
