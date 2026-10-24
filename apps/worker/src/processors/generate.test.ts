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
 *
 * ── The second half of this file: the PROCESSOR ─────────────────────────────
 *
 * `processGenerate` is where a generated test becomes a row that coverage
 * counts, so it is where the two numerator lies have to be stopped: a test that
 * failed the generation gate getting stored anyway, and a plan item approved
 * twice minting two tests. Those tests drive the real `generateTest` through a
 * fake model — no ANTHROPIC_API_KEY, deliberately — against a fake Prisma, so
 * what is being proven is the WIRING end to end rather than a mock of it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { CallContext, StructuredOptions } from '@qaai/agent';

/*
 * The worker's context opens Postgres, Redis and the LLM at import time, so it
 * is replaced wholesale — the same shape processors/recompute-coverage.test.ts
 * uses. `h.prisma` and `h.llmReplies` are rebuilt per test.
 */
const h = vi.hoisted(
  (): {
    prisma: Record<string, unknown>;
    prompts: string[];
    llmReplies: Array<Record<string, unknown>>;
    log: Array<{ level: string; msg: string; obj: unknown }>;
  } => ({ prisma: {}, prompts: [], llmReplies: [], log: [] }),
);

vi.mock('../context.js', () => {
  const record =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      h.log.push({ level, msg: msg ?? '', obj });
    };
  return {
    config: { vaultMasterKey: '' },
    connection: {},
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
    publishEvent: () => {},
    // A model that answers with the canned files for this test and keeps every
    // prompt it was given.
    llm: {
      configured: true,
      structured: async (_ctx: CallContext, opts: StructuredOptions<never>) => {
        h.prompts.push(opts.prompt);
        const reply = h.llmReplies[Math.min(h.prompts.length - 1, h.llmReplies.length - 1)];
        if (!reply) throw new Error('the fake model was called with no reply configured');
        return reply;
      },
    },
  };
});

const { DUPLICATE_CANDIDATE_CAP, GENERATE_AUDIT_ACTIONS, duplicateCandidates, processGenerate } =
  await import('./generate.js');

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

// ─── 4. The processor: what reaches the database ─────────────────────────────

/** The one journey these tests generate, and the plan item it was approved as. */
const CHECKOUT_ITEM = {
  id: 'item-checkout',
  orgId: 'org1',
  testPlanId: 'plan1',
  title: 'Checkout shows the order total',
  rationale: 'The survey said the total was wrong at checkout.',
  feature: 'checkout',
  priority: 'IMPORTANT',
  testType: 'E2E',
  steps: ['Open the cart page', 'Press the checkout button'],
  assertions: ['The order total reads $42.00'],
  journeyId: null,
  authProfileId: null,
};

const CHECKOUT_PATH = 'checkout/checkout-shows-the-order-total.spec.ts';

const CHECKOUT_CODE = `import { test, expect } from '@playwright/test';

test('Checkout shows the order total', async ({ page }) => {
  await page.goto('/cart');
  await page.getByRole('button', { name: 'Checkout' }).click();
  await expect(page.getByTestId('order-total')).toHaveText('$42.00');
});
`;

interface FakeTest {
  id: string;
  orgId: string;
  projectId: string;
  planItemId: string | null;
  name: string;
  filePath: string;
  code: string;
  spec: unknown;
  type: string;
  feature: string | null;
  createdAt: Date;
  /** Set when a human switched the test off; never a reason to mint a new one. */
  disabledAt?: Date | null;
}

/**
 * Enough of Prisma to answer the four queries this processor makes, and no
 * more. It understands scalar equality, `{ not: … }` and `OR`, because those
 * are exactly the shapes `duplicateCandidates` builds — a new filter there
 * must be taught here, which is the point of keeping it small rather than
 * stubbing `findMany` to a constant.
 */
function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (key === 'OR') {
      const branches = expected as Array<Record<string, unknown>>;
      if (!branches.some((branch) => matchesWhere(row, branch))) return false;
      continue;
    }
    const actual = row[key];
    if (expected !== null && typeof expected === 'object') {
      const filter = expected as { not?: unknown; in?: unknown[] };
      if ('in' in filter && !filter.in!.includes(actual)) return false;
      if ('not' in filter) {
        if (filter.not === null ? actual === null : actual === filter.not) return false;
      }
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function fakeWorld(options: { items?: Array<Record<string, unknown>>; tests?: FakeTest[] } = {}): {
  tests: FakeTest[];
  created: Array<Record<string, unknown>>;
  planItemUpdates: Array<{ id: string; data: Record<string, unknown> }>;
  audits: Array<Record<string, unknown>>;
  candidateQueries: Array<Record<string, unknown>>;
} {
  const tests: FakeTest[] = options.tests ? [...options.tests] : [];
  const created: Array<Record<string, unknown>> = [];
  const planItemUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const candidateQueries: Array<Record<string, unknown>> = [];
  let clock = Date.parse('2026-10-01T00:00:00.000Z');

  h.prisma = {
    project: {
      findFirst: async () => ({
        id: 'p1',
        primaryLanguage: 'TYPESCRIPT',
        primaryFramework: 'PLAYWRIGHT',
      }),
    },
    testPlan: { findFirst: async () => ({ id: 'plan1', flowMapId: 'fm1' }) },
    flowMap: {
      findUnique: async () => ({ id: 'fm1', environmentId: 'env1', graph: crawledFlowMap }),
    },
    // No environment row, so no secrets are read: the vault is not what these
    // tests are about.
    environment: { findFirst: async () => null },
    planItem: {
      findMany: async () => options.items ?? [CHECKOUT_ITEM],
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        planItemUpdates.push({ id: where.id, data });
        return { id: where.id, ...data };
      },
    },
    suite: { upsert: async () => ({ id: 'suite1' }) },
    test: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        tests.find((row) => matchesWhere(row as unknown as Record<string, unknown>, where)) ?? null,
      findMany: async ({ where, take }: { where: Record<string, unknown>; take: number }) => {
        candidateQueries.push({ where, take });
        return tests
          .filter((row) => matchesWhere(row as unknown as Record<string, unknown>, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, take);
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        clock += 1_000;
        const row: FakeTest = {
          id: `test-${created.length}`,
          orgId: String(data.orgId),
          projectId: String(data.projectId),
          planItemId: (data.planItemId as string | null) ?? null,
          name: String(data.name),
          filePath: String(data.filePath),
          code: String(data.code),
          spec: data.spec ?? null,
          type: String(data.type),
          feature: (data.feature as string | null) ?? null,
          createdAt: new Date(clock),
        };
        tests.push(row);
        return row;
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      },
    },
  };

  return { tests, created, planItemUpdates, audits, candidateQueries };
}

function existingTest(over: Partial<FakeTest> = {}): FakeTest {
  return {
    id: 'test-existing',
    orgId: 'org1',
    projectId: 'p1',
    planItemId: null,
    name: 'Checkout shows the order total',
    filePath: CHECKOUT_PATH,
    code: CHECKOUT_CODE,
    spec: null,
    type: 'E2E',
    feature: 'checkout',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...over,
  };
}

const job = {
  orgId: 'org1',
  projectId: 'p1',
  testPlanId: 'plan1',
  planItemIds: ['item-checkout'],
  requestedBy: 'user-who-approved-the-plan',
};

describe('processGenerate stores what admission admitted', () => {
  beforeEach(() => {
    h.prompts.length = 0;
    h.llmReplies.length = 0;
    h.log.length = 0;
  });

  it('stores the admitted code, path and flags, and marks the item GENERATED', async () => {
    const world = fakeWorld();
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: ['The order total locator was inferred.'],
    });

    await processGenerate(job);

    expect(world.created).toHaveLength(1);
    const row = world.created[0]!;
    expect(row.code).toBe(CHECKOUT_CODE);
    expect(row.filePath).toBe(CHECKOUT_PATH);
    expect(row.planItemId).toBe('item-checkout');
    // The audit trail the editor reads is the v1 TestVersion, unchanged.
    expect(row.versions).toMatchObject({ create: { version: 1, source: 'GENERATOR' } });

    /*
     * THE REVIEW FLAGS ARE PERSISTED, and they include every gate that could
     * not run. Without a repository on disk there is no prettier, eslint or
     * tsc to run, and a row that did not say so would be a test nobody checked
     * wearing the badge of one that passed.
     */
    const flags = (row.reviewFlags as string[]).join('\n');
    expect(flags).toContain('The order total locator was inferred.');
    expect(flags).toContain('no syntax checker was wired in');
    expect(flags).toContain('no typechecker was wired in');
    expect(flags).toContain('no formatter was wired in');
    expect(flags).toContain('no linter was wired in');
    // …and MUTATION, which can never run here, is still not on the row.
    expect(flags).not.toContain('mutated build');

    expect(world.planItemUpdates).toEqual([
      { id: 'item-checkout', data: { state: 'GENERATED', generatedTestId: 'test-1' } },
    ]);
    expect(world.audits).toHaveLength(0);
  });

  /*
   * THE ROLE REACHES THE TEST ROW.
   *
   * This is the last link in a chain that is useless if any one of them is
   * missing: an UNREACHED_AUTH_ROUTE gap names an auth profile, the plan item
   * carries it, and the Test row has to carry it too — otherwise the runner
   * executes the test as a signed-out visitor, it passes whatever that visitor
   * can see, and the page behind the wall is counted as covered. The column
   * existed and this processor did not copy it.
   */
  it('copies the plan item\'s auth profile onto the test, with the intent beside it', async () => {
    const world = fakeWorld({
      items: [{ ...CHECKOUT_ITEM, authProfileId: 'profile-admin' }],
    });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job);

    const row = world.created[0]!;
    expect(row.authProfileId).toBe('profile-admin');
    /*
     * The INTENT, stored apart from the binding. The foreign key is SetNull, so
     * deleting the profile leaves `(required: true, id: null)` — a state
     * nothing else in the system can produce, and the only way coverage
     * analysis can tell "never needed a role" from "its role was deleted".
     */
    expect(row.authProfileRequired).toBe(true);
  });

  it('leaves an unbound test unbound, and says so when it meant to sign in', async () => {
    const world = fakeWorld({
      items: [
        {
          ...CHECKOUT_ITEM,
          authProfileId: null,
          steps: ['Sign in as the admin auth profile', 'Open /admin/users'],
        },
      ],
    });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job);

    const row = world.created[0]!;
    expect(row.authProfileId).toBeNull();
    expect(row.authProfileRequired).toBe(false);
    // The test describes signing in and has nothing to sign in as. It will run
    // anonymously, so a human has to be told before trusting a pass.
    expect((row.reviewFlags as string[]).join('\n')).toContain('bound to no auth profile');
  });

  it('stores the CORRECTED path, not the one the model asked for', async () => {
    const world = fakeWorld();
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      // A path Playwright does not collect: the suite would go green over a
      // file nobody ever executed.
      filePath: 'checkout/notes.txt',
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job);

    expect(world.created[0]!.filePath).toBe(CHECKOUT_PATH);
    expect((world.created[0]!.reviewFlags as string[]).join(' ')).toContain('checkout/notes.txt');
  });

  it('passes the project\'s own tests in, same type and same feature first', async () => {
    const world = fakeWorld({ tests: [existingTest({ feature: 'cart', code: 'other' })] });
    h.llmReplies.push({ filePath: CHECKOUT_PATH, code: CHECKOUT_CODE, reviewFlags: [] });

    await processGenerate(job);

    expect(world.candidateQueries.length).toBeGreaterThanOrEqual(1);
    const first = world.candidateQueries[0]!.where as Record<string, unknown>;
    expect(first).toMatchObject({ orgId: 'org1', projectId: 'p1', type: 'E2E', feature: 'checkout' });
    // The comparison happened, so nothing on the row says it did not.
    expect((world.created[0]!.reviewFlags as string[]).join(' ')).not.toContain(
      'no existing tests were supplied',
    );
  });
});

describe('a refusal is recorded, not dropped', () => {
  beforeEach(() => {
    h.prompts.length = 0;
    h.llmReplies.length = 0;
    h.log.length = 0;
  });

  it('stores nothing for a duplicate, leaves the item un-generated, and says why', async () => {
    const world = fakeWorld({ tests: [existingTest()] });
    h.llmReplies.push({ filePath: CHECKOUT_PATH, code: CHECKOUT_CODE, reviewFlags: [] });

    // Every item refused means the batch produced nothing, which must look like
    // a job failure rather than a successful no-op.
    await expect(processGenerate(job)).rejects.toThrow('Generation produced no tests');

    expect(world.created).toHaveLength(0);
    // The plan item is NOT marked GENERATED — the approval screen still shows
    // it as approved and waiting, and re-approving tries again.
    expect(world.planItemUpdates).toHaveLength(0);

    expect(world.audits).toHaveLength(1);
    const audit = world.audits[0]!;
    expect(audit.action).toBe(GENERATE_AUDIT_ACTIONS.refused);
    expect(audit.targetType).toBe('PlanItem');
    expect(audit.targetId).toBe('item-checkout');
    // Attributed to whoever approved the plan: this is their refusal to read.
    expect(audit.userId).toBe('user-who-approved-the-plan');

    const metadata = audit.metadata as Record<string, unknown>;
    expect(metadata.verdict).toBe('REFUSE');
    expect(metadata.failedGates).toEqual(['DUPLICATE']);
    expect(metadata.planItemTitle).toBe('Checkout shows the order total');
    expect(metadata.wouldHaveBeenStoredAt).toBe(CHECKOUT_PATH);
    expect(JSON.stringify(metadata.reasons)).toContain('The suite already has this test');
    // Every gate that could not run, so the row cannot be read as "the rest
    // was fine".
    expect(metadata.notChecked).toContain('SYNTAX');
    expect(metadata.notChecked).toContain('MUTATION');

    const logged = h.log.find((line) => line.msg.startsWith('generation refused'));
    expect(logged?.level).toBe('error');
  });

  it('refuses one item and still generates the rest of the batch', async () => {
    const other = {
      ...CHECKOUT_ITEM,
      id: 'item-delivery',
      title: 'Checkout shows the delivery date',
      assertions: ['The delivery date reads Tomorrow'],
    };
    const world = fakeWorld({ items: [CHECKOUT_ITEM, other], tests: [existingTest()] });
    const deliveryCode = CHECKOUT_CODE.replace(
      "await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
      "await expect(page.getByTestId('delivery-date')).toHaveText('Tomorrow');",
    ).replace('Checkout shows the order total', 'Checkout shows the delivery date');
    // Call 1 is the first item (a duplicate of the test already in the suite),
    // call 2 is the second item (a different assertion, so a different test).
    h.llmReplies.push(
      { name: CHECKOUT_ITEM.title, filePath: CHECKOUT_PATH, code: CHECKOUT_CODE, reviewFlags: [] },
      {
        name: 'Checkout shows the delivery date',
        filePath: 'checkout/checkout-shows-the-delivery-date.spec.ts',
        code: deliveryCode,
        reviewFlags: [],
      },
    );

    await processGenerate({ ...job, planItemIds: ['item-checkout', 'item-delivery'] });

    expect(world.created).toHaveLength(1);
    expect(world.created[0]!.name).toBe('Checkout shows the delivery date');
    expect(world.audits).toHaveLength(1);
    expect((world.audits[0]!.metadata as Record<string, unknown>).failedGates).toEqual([
      'DUPLICATE',
    ]);
    // A duplicate is terminal, so the refused item cost ONE model call, not two.
    expect(h.prompts).toHaveLength(2);
    expect(world.planItemUpdates).toEqual([
      { id: 'item-delivery', data: { state: 'GENERATED', generatedTestId: 'test-1' } },
    ]);
  });

  it('refuses the second of two identical items in ONE approval', async () => {
    /*
     * The candidate set is read per item rather than once per batch for exactly
     * this: the first item's test is in the database by the time the second is
     * generated, so one approval cannot mint the same test twice.
     */
    const twin = { ...CHECKOUT_ITEM, id: 'item-twin' };
    const world = fakeWorld({ items: [CHECKOUT_ITEM, twin] });
    h.llmReplies.push({ filePath: CHECKOUT_PATH, code: CHECKOUT_CODE, reviewFlags: [] });

    await processGenerate({ ...job, planItemIds: ['item-checkout', 'item-twin'] });

    expect(world.created).toHaveLength(1);
    expect(world.audits).toHaveLength(1);
    expect((world.audits[0]!.metadata as Record<string, unknown>).failedGates).toEqual([
      'DUPLICATE',
    ]);
  });
});

describe('a plan item that already has a test', () => {
  beforeEach(() => {
    h.prompts.length = 0;
    h.llmReplies.length = 0;
    h.log.length = 0;
  });

  it('does not generate a second one, and repairs the item\'s pointer', async () => {
    const world = fakeWorld({
      tests: [existingTest({ id: 'test-existing', planItemId: 'item-checkout' })],
    });

    await processGenerate(job);

    // Not one model call: this costs nothing, which is the point of checking
    // before generating rather than after.
    expect(h.prompts).toHaveLength(0);
    expect(world.created).toHaveLength(0);
    expect(world.planItemUpdates).toEqual([
      { id: 'item-checkout', data: { state: 'GENERATED', generatedTestId: 'test-existing' } },
    ]);
    // Nothing was produced, but nothing needed producing — not a job failure.
    expect(world.audits).toHaveLength(0);
  });

  it('counts a DISABLED test as already having one', async () => {
    /*
     * "You already have this test" is true of a test someone switched off, and
     * generating another would bring it back under a new id — with the old row
     * still disabled, so the suite now has two and runs one.
     */
    const world = fakeWorld({
      tests: [
        existingTest({
          id: 'test-off',
          planItemId: 'item-checkout',
          disabledAt: new Date('2026-09-15T00:00:00.000Z'),
        }),
      ],
    });

    await processGenerate(job);

    expect(h.prompts).toHaveLength(0);
    expect(world.created).toHaveLength(0);
    expect(world.planItemUpdates[0]!.data.generatedTestId).toBe('test-off');
  });
});

describe('duplicateCandidates', () => {
  it('fills the budget from other features, and admits when it had to truncate', async () => {
    const many: FakeTest[] = [];
    for (let i = 0; i < DUPLICATE_CANDIDATE_CAP + 5; i += 1) {
      many.push(
        existingTest({
          id: `test-${i}`,
          feature: 'checkout',
          createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000),
        }),
      );
    }
    fakeWorld({ tests: many });

    const capped = await duplicateCandidates({
      orgId: 'org1',
      projectId: 'p1',
      type: 'E2E',
      feature: 'checkout',
    });
    expect(capped.existing).toHaveLength(DUPLICATE_CANDIDATE_CAP);
    // The caller is told, so the one test whose comparison was partial says so.
    expect(capped.truncated).toBe(true);

    fakeWorld({
      tests: [
        existingTest({ id: 'same', feature: 'checkout' }),
        existingTest({ id: 'other', feature: 'cart' }),
        existingTest({ id: 'none', feature: null }),
        existingTest({ id: 'wrong-type', feature: 'checkout', type: 'API' }),
      ],
    });
    const mixed = await duplicateCandidates({
      orgId: 'org1',
      projectId: 'p1',
      type: 'E2E',
      feature: 'checkout',
    });
    expect(mixed.truncated).toBe(false);
    // Same feature first, then the rest — including the featureless tests an
    // imported suite arrives as, which a bare `not` would have dropped.
    expect(mixed.existing.map((row) => row.id)).toEqual(['same', 'other', 'none']);
  });
});
