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
 * WAS a relative path across the workspace boundary, on a comment claiming
 * `packages/shared/src/index.ts` does not export `./style-profile`. It has for
 * two commits (line 237 of that barrel), so the comment had become the kind of
 * doc comment that contradicts the code under it. The module under test carried
 * the same stale note and lost it in the same change.
 */
import { emptyStyleProfile } from '@qaai/shared';
/*
 * TYPE-ONLY, so the module under test is still loaded by the dynamic `import`
 * below — after `vi.mock('../context.js')` has replaced Postgres, Redis and the
 * model, which a top-level value import would defeat.
 */
import type { DiskState, TestFileSource } from '@qaai/agent';
import type { RepoFileView, RepoViewOpener } from './generate.js';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
        /*
         * ECHOING THE PATH THE PROMPT SUGGESTED, when a test asks for it.
         *
         * A well-behaved model writes the file where it was told, and on the
         * multi-file path that is load-bearing rather than polite: the plan
         * computes every page-object import specifier RELATIVE TO the spec path
         * it chose, so a reply at any other path makes `specPathMoved` true and
         * the generator correctly DROPS the whole set. A canned absolute path
         * would therefore exercise the drop branch in every multi-file test
         * instead of the one that is about it — and a test cannot know the
         * planned path in advance, because the plan reads it off the ledger and
         * the profile. The craft suite in packages/agent does this for the same
         * reason and with the same regex.
         */
        const answered = { ...reply };
        if (answered.filePath === FOLLOW_SUGGESTED_PATH) {
          const suggested = /filePath\s+"([^"]+)"/.exec(opts.prompt)?.[1];
          if (suggested === undefined) {
            throw new Error('the prompt did not name a filePath for the fake model to echo');
          }
          answered.filePath = suggested;
        }
        if (answered.code === FOLLOW_BRIEFED_IMPORTS) {
          answered.code = specImporting(opts.prompt);
        }
        return answered;
      },
    },
  };
});

/**
 * The sentinel a canned reply uses to mean "answer at the path you were given".
 *
 * A string nothing could be, so a reply that forgot to replace it fails loudly
 * in the gate rather than quietly becoming a real path.
 */
const FOLLOW_SUGGESTED_PATH = '<<echo the suggested path>>';

/** The sentinel a canned reply uses for "import the files you told me about". */
const FOLLOW_BRIEFED_IMPORTS = '<<import the briefed files>>';

/**
 * A spec that actually imports what `artifactBriefing` named.
 *
 * WHY A CANNED FILE WILL NOT DO, and this cost a debugging pass worth recording:
 * the generator no longer takes the plan's word for what the spec imports. It
 * READS THE BYTES, and a multi-file set whose spec does not mention the fixture
 * or the page object is DROPPED — correctly, because writing files nothing
 * imports would record an import edge that is not there, and the push path reads
 * that edge as the truth about what depends on what. So a fake model that
 * returned a fixed file would exercise the drop branch in every multi-file test
 * and the wiring would look unwired.
 *
 * The specifiers are read out of the briefing's own two line shapes, so this
 * follows the prompt rather than guessing at the plan's layout.
 */
function specImporting(prompt: string): string {
  const imports: string[] = [];
  const fixture = /^- Import test and expect from (\S+) /m.exec(prompt)?.[1];
  imports.push(
    fixture === undefined
      ? "import { test, expect } from '@playwright/test';"
      : `import { test, expect } from '${fixture}';`,
  );
  for (const line of prompt.split('\n')) {
    const page = /^- (\w+) from (\S+?):/.exec(line);
    if (page) imports.push(`import { ${page[1]!} } from '${page[2]!}';`);
  }
  return `${imports.join('\n')}

test('Checkout shows the order total', async ({ page }) => {
  await page.goto('/cart');
  await expect(page.getByTestId('order-total')).toHaveText('$42.00');
});
`;
}

const {
  DUPLICATE_CANDIDATE_CAP,
  DEFAULT_REPO_VIEW_LIMITS,
  GENERATE_AUDIT_ACTIONS,
  LAYOUT_OUTCOMES,
  LAYOUT_SENTENCES,
  SHARED_ARTIFACT_ROLES,
  duplicateCandidates,
  ledgerRowsFor,
  nodeRepoFileView,
  occupancyProbe,
  ownershipClaims,
  processGenerate,
  readFlowGraph,
} = await import('./generate.js');

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
  /**
   * APPROVED, which is the state the processor is now allowed to generate.
   *
   * On the row because the processor filters on it: a fixture with no state
   * would be a fixture no producer ever writes, and the filter exists precisely
   * so an item a human has not approved is not turned into code.
   */
  state: 'APPROVED',
  /**
   * The coverage gap this item was minted to close. Null here, because the one
   * journey these tests generate came off a crawl rather than out of a gap
   * report — the provenance suite below supplies its own item with an id on it.
   */
  gapId: null,
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

/**
 * A row reduced to the fields a `select` asked for.
 *
 * SELECT-BLIND FAKES ARE WHY THIS EXISTS. A fake that returns the whole row
 * makes DELETING A FIELD FROM A QUERY UNDETECTABLE — the assertion downstream
 * still finds the field, because the fake supplied it and the real client would
 * not have. Two defects survived a whole slice behind exactly that.
 */
function selected<T extends Record<string, unknown>>(
  row: T,
  select: Record<string, boolean> | undefined,
): Partial<T> {
  if (!select) return row;
  const out: Record<string, unknown> = {};
  for (const [key, wanted] of Object.entries(select)) {
    if (wanted) out[key] = row[key];
  }
  return out as Partial<T>;
}

function fakeWorld(
  options: {
    items?: Array<Record<string, unknown>>;
    tests?: FakeTest[];
    /** `Project.styleProfile`, as a Json column holds it — anything at all. */
    styleProfile?: unknown;
    styleProfileComputedAt?: Date | null;
    /** Rows in the correction corpus for this project. */
    corrections?: Array<Record<string, unknown>>;
    /** Ownership rows already in the ledger, which an insert must not overwrite. */
    artifacts?: Array<Record<string, unknown>>;
    /**
     * `FlowMap.graph`, as a Json column holds it — ANYTHING AT ALL.
     *
     * `unknown` and not `FlowMap`, because the processor's job at that boundary
     * is to parse a column a previous writer filled, and a fixture the compiler
     * had already proved well-formed could not exercise the refusal.
     */
    flowMapGraph?: unknown;
  } = {},
): {
  tests: FakeTest[];
  created: Array<Record<string, unknown>>;
  planItemUpdates: Array<{ id: string; data: Record<string, unknown> }>;
  audits: Array<Record<string, unknown>>;
  candidateQueries: Array<Record<string, unknown>>;
  /** Every ownership row the processor asked to create. */
  artifactWrites: Array<Record<string, unknown>>;
  /** The corpus queries, so the project boundary can be asserted on. */
  correctionQueries: Array<Record<string, unknown>>;
} {
  const tests: FakeTest[] = options.tests ? [...options.tests] : [];
  const created: Array<Record<string, unknown>> = [];
  const planItemUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const candidateQueries: Array<Record<string, unknown>> = [];
  const artifactWrites: Array<Record<string, unknown>> = [];
  const correctionQueries: Array<Record<string, unknown>> = [];
  const ledger: Array<Record<string, unknown>> = options.artifacts ? [...options.artifacts] : [];
  let clock = Date.parse('2026-10-01T00:00:00.000Z');

  h.prisma = {
    project: {
      findFirst: async ({ select }: { select?: Record<string, boolean> } = {}) =>
        selected(
          {
            id: 'p1',
            primaryLanguage: 'TYPESCRIPT',
            primaryFramework: 'PLAYWRIGHT',
            styleProfile: options.styleProfile ?? null,
            /*
             * `in` and not `??`: `null` is a MEANING here — "stored with no
             * date", which the processor must refuse — and `null ?? default`
             * would silently replace it with a date, making that branch
             * untestable.
             */
            styleProfileComputedAt:
              'styleProfileComputedAt' in options
                ? options.styleProfileComputedAt
                : options.styleProfile === undefined || options.styleProfile === null
                  ? null
                  : new Date('2026-10-20T00:00:00.000Z'),
            /*
             * WHICH REPOSITORY, AND ON WHICH BRANCH. On the row because the
             * processor `select`s them and {@link selected} honours `select` —
             * so dropping one from that query makes the opener receive
             * `undefined` and a test below go red, which is exactly what a
             * select-blind fake would have hidden.
             */
            repoFullName: 'acme/shop',
            repoInstallationId: 'inst_1',
            defaultBranch: 'main',
          },
          select,
        ),
    },
    /*
     * The correction corpus. `select` is honoured, so a field dropped from the
     * processor's query stops arriving here.
     */
    testCorrection: {
      findMany: async ({
        where,
        take,
        select,
      }: {
        where: Record<string, unknown>;
        take?: number;
        select?: Record<string, boolean>;
      }) => {
        correctionQueries.push({ where, take });
        return (options.corrections ?? [])
          .filter((row) => matchesWhere(row, where ?? {}))
          .slice(0, take ?? undefined)
          .map((row) => selected(row, select));
      },
    },
    /*
     * The ownership ledger. `skipDuplicates` is MODELLED rather than ignored:
     * the existing fact at a path must win over a later generation, and an
     * upsert-shaped fake would hide a processor that downgraded a HUMAN_EDITED
     * row back to QAAI_OWNED.
     */
    generatedArtifact: {
      /*
       * `take` AND `orderBy` ARE HONOURED, not only `select`.
       *
       * A take-blind fake is the same class of defect as a select-blind one and
       * it survived a mutation here: `readArtifactLedger` reads `cap + 1` rows
       * so that "there are more of these" is a FACT rather than an inference
       * from a full page, and a fake that returned every row regardless made
       * `cap + 1` indistinguishable from `cap`. Dropping the `+ 1` is caught now.
       */
      findMany: async ({
        where,
        take,
        orderBy,
        select,
      }: {
        where: Record<string, unknown>;
        take?: number;
        orderBy?: { path?: 'asc' | 'desc' };
        select?: Record<string, boolean>;
      }) => {
        const rows = ledger.filter((row) => matchesWhere(row, where ?? {}));
        if (orderBy?.path !== undefined) {
          rows.sort((a, b) => String(a.path).localeCompare(String(b.path)));
          if (orderBy.path === 'desc') rows.reverse();
        }
        return rows.slice(0, take ?? undefined).map((row) => selected(row, select));
      },
      createMany: async ({
        data,
        skipDuplicates,
      }: {
        data: Array<Record<string, unknown>>;
        skipDuplicates?: boolean;
      }) => {
        let count = 0;
        for (const row of data) {
          artifactWrites.push(row);
          const clash = ledger.some(
            (existing) => existing.projectId === row.projectId && existing.path === row.path,
          );
          if (clash && skipDuplicates) continue;
          if (clash) throw new Error('unique constraint on (projectId, path)');
          ledger.push(row);
          count += 1;
        }
        return { count };
      },
    },
    testPlan: { findFirst: async () => ({ id: 'plan1', flowMapId: 'fm1' }) },
    flowMap: {
      findUnique: async () => ({
        id: 'fm1',
        environmentId: 'env1',
        graph: 'flowMapGraph' in options ? options.flowMapGraph : crawledFlowMap,
      }),
    },
    // No environment row, so no secrets are read: the vault is not what these
    // tests are about.
    environment: { findFirst: async () => null },
    planItem: {
      /*
       * The `where` is HONOURED, and that is the whole value of it here: the
       * processor's state filter is what stops an item nobody approved being
       * handed to a strong-tier model, and a fake that returned every row it
       * was given would pass whether the filter was there or not. (Confirmed by
       * mutation: dropping the filter from the processor is caught below.)
       */
      findMany: async ({ where }: { where: Record<string, unknown> } = { where: {} }) =>
        (options.items ?? [CHECKOUT_ITEM]).filter((row) => matchesWhere(row, where ?? {})),
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

  return {
    tests,
    created,
    planItemUpdates,
    audits,
    candidateQueries,
    artifactWrites,
    correctionQueries,
  };
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

// ─── 6. Provenance, and the approval the generator has to respect ────────────

/**
 * Two properties of the LANDING, both of which were missing and neither of
 * which a careless edit would notice.
 *
 * `Test.gapId` is how the closure ledger names the test written for a gap. It
 * was stamped by the close-loop tick, which walks the plan item — so it worked
 * for a campaign's items and for nothing else, and every test generated from a
 * human clicking POST /coverage/:id/propose landed with no provenance at all.
 * The ledger could then never say "this gap is closed by this test", and — much
 * worse — could never notice that it is NOT.
 *
 * The state filter is the other half. A closure campaign on a HUMAN_REVIEW
 * policy mints its items PROPOSED precisely so a person decides; the processor
 * generated whatever ids its job named, so an item waiting on the approval
 * screen could be turned into code and stored.
 */
describe('the provenance a generated test is born with', () => {
  beforeEach(() => {
    h.prompts.length = 0;
    h.llmReplies.length = 0;
    h.log.length = 0;
  });

  const admitted = (): void => {
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });
  };

  it('copies the gap id from the plan item onto the test row', async () => {
    const world = fakeWorld({
      items: [{ ...CHECKOUT_ITEM, gapId: 'gap_8f2c1d', gapKind: 'UNVISITED_ROUTE' }],
    });
    admitted();

    await processGenerate(job);

    const row = world.created[0]!;
    expect(row.gapId).toBe('gap_8f2c1d');
    // In the same write that creates the row, so the provenance does not
    // depend on a later tick, on a campaign existing, or on the plan surviving.
    expect(row.planItemId).toBe('item-checkout');
    expect(world.planItemUpdates).toEqual([
      { id: 'item-checkout', data: { state: 'GENERATED', generatedTestId: 'test-1' } },
    ]);
  });

  it('leaves it NULL for a cold plan, rather than inventing one', async () => {
    /*
     * The Explorer proposes from a crawl with no gap behind it. NULL is the
     * ordinary case and always will be; a back-filled id would claim a
     * provenance that never existed, and the ledger would then name a test for
     * a gap nobody ever reported.
     */
    const world = fakeWorld();
    admitted();

    await processGenerate(job);

    expect(world.created[0]!.gapId).toBeNull();
  });

  it('refuses to generate an item a human has not approved', async () => {
    const world = fakeWorld({ items: [{ ...CHECKOUT_ITEM, state: 'PROPOSED' }] });
    admitted();

    await processGenerate(job);

    // Nothing stored, nothing transitioned, and the model was never asked.
    expect(world.created).toHaveLength(0);
    expect(world.planItemUpdates).toEqual([]);
    expect(h.prompts).toHaveLength(0);
    /*
     * And it is REPORTED, at warn: a batch of one that produced none must not
     * read as a batch of none, and the counts say how many of the ids the job
     * named were generable.
     */
    const warned = h.log.find((line) => line.level === 'warn' && /not approved/.test(line.msg));
    expect(warned).toBeDefined();
    expect(warned!.obj).toMatchObject({ requested: 1, generating: 0 });
  });

  it('refuses to generate an item a human REJECTED', async () => {
    const world = fakeWorld({ items: [{ ...CHECKOUT_ITEM, state: 'REJECTED' }] });
    admitted();

    await processGenerate(job);

    expect(world.created).toHaveLength(0);
    expect(h.prompts).toHaveLength(0);
  });

  it('generates the approved items in a batch that also names unapproved ones', async () => {
    /*
     * The mixed batch, which is the one the filter has to get right: a job over
     * a HUMAN_REVIEW campaign's items, half of them ticked. Eight approved
     * items must still be generated, and the two that were not must still be
     * left alone.
     */
    const world = fakeWorld({
      items: [
        { ...CHECKOUT_ITEM, state: 'PROPOSED' },
        { ...CHECKOUT_ITEM, id: 'item-delivery', title: 'Delivery shows the ETA', gapId: 'gap_eta' },
      ],
    });
    h.llmReplies.push({
      name: 'Delivery shows the ETA',
      filePath: 'delivery/delivery-shows-the-eta.spec.ts',
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate({ ...job, planItemIds: ['item-checkout', 'item-delivery'] });

    expect(world.created).toHaveLength(1);
    expect(world.created[0]!.planItemId).toBe('item-delivery');
    expect(world.created[0]!.gapId).toBe('gap_eta');
  });

  it('still honours a redelivered job over work that already landed', async () => {
    /*
     * GENERATED is admitted alongside APPROVED on purpose: that state means a
     * previous job already stored the test, and the duplicate guard answers it
     * honestly by pointing the item at the test it already has. Excluding it
     * would leave a redelivered job with nothing to repair the pointer with.
     */
    const world = fakeWorld({
      items: [{ ...CHECKOUT_ITEM, state: 'GENERATED' }],
      tests: [existingTest({ id: 'already', planItemId: 'item-checkout' })],
    });
    admitted();

    await processGenerate(job);

    expect(world.created).toHaveLength(0);
    expect(world.planItemUpdates).toEqual([
      { id: 'item-checkout', data: { state: 'GENERATED', generatedTestId: 'already' } },
    ]);
  });
});

// ─── The craft: ownership, house style, and the project boundary ─────────────

/*
 * THE THREE SURFACES THIS ROUND MINTED AND NOTHING WROTE TO.
 *
 * `GeneratedArtifact`, `Project.styleProfile` and `TestCorrection` all landed as
 * schema with no writer and no reader, which is this codebase's signature
 * defect. These tests are about the WIRING of each one, and every one is
 * written so that unwiring it turns the test red.
 */
describe('the ownership ledger a generated test is born with', () => {
  beforeEach(() => {
    h.prompts.length = 0;
    h.llmReplies.length = 0;
    h.log.length = 0;
  });

  /*
   * THE SINGLE FACT `pushRepo` LACKED. Without a row here the next git sync
   * resolves this path UNRECORDED, refuses to write it and refuses to delete it
   * — safe, and useless: a test QAAI generated would never reach the branch.
   */
  it('records the generated spec as QAAI_OWNED, with its hash and its bytes', async () => {
    const world = fakeWorld();
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job);

    expect(world.artifactWrites).toHaveLength(1);
    const row = world.artifactWrites[0]!;
    expect(row.path).toBe(CHECKOUT_PATH);
    expect(row.role).toBe('SPEC');
    expect(row.ownership).toBe('QAAI_OWNED');
    expect(row.testId).toBe('test-1');
    expect(row.orgId).toBe('org1');
    expect(row.projectId).toBe('p1');
    // The hash is the optimistic-concurrency token: it is what makes "the bytes
    // on disk are still the bytes we wrote" decidable at all.
    expect(String(row.contentHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(row.bytes).toBe(CHECKOUT_CODE.length);
  });

  /*
   * THE WORST FAILURE AVAILABLE IN THIS SCHEMA. A human took our file over, the
   * row says HUMAN_EDITED, and a later generation at the same path must NOT
   * downgrade it — because the next sync would then overwrite their edit.
   */
  it('never downgrades an existing ownership row, and says it kept it', async () => {
    const world = fakeWorld({
      artifacts: [
        {
          orgId: 'org1',
          projectId: 'p1',
          path: CHECKOUT_PATH,
          role: 'SPEC',
          ownership: 'HUMAN_EDITED',
          contentHash: 'theirs',
          imports: [],
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

    // The test row was still created — nothing about the ledger stops that.
    expect(world.created).toHaveLength(1);
    // And the existing fact survived, with the shortfall reported as a count.
    const kept = h.log.find((line) => /the existing fact was kept/.test(line.msg));
    expect(kept).toBeDefined();
    expect((kept?.obj as { planned: number; recorded: number }).planned).toBe(1);
    expect((kept?.obj as { planned: number; recorded: number }).recorded).toBe(0);
  });
});

describe("the project's own house style", () => {
  beforeEach(() => {
    h.prompts.length = 0;
    h.llmReplies.length = 0;
    h.log.length = 0;
  });

  it('is read from the cache and reaches the prompt', async () => {
    /*
     * A profile with ONE measured field, and the evidence counts that justify
     * its confidence — `styleProfileSchema` re-derives the confidence from those
     * counts and refuses a mismatch, so a hand-written profile has to be
     * arithmetically honest to parse at all.
     */
    const profile = {
      ...emptyStyleProfile(''),
      filesRead: 5,
      testIdAttribute: {
        value: 'data-qa',
        confidence: 'HIGH' as const,
        filesSeen: 5,
        filesConsidered: 5,
        examples: [],
        deferredTo: null,
      },
    };
    fakeWorld({ styleProfile: profile });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job);

    expect(h.prompts[0]).toContain('data-qa');
  });

  /*
   * A stored blob that does not validate is a blob whose confidences somebody
   * CHOSE rather than computed, and stating it would tell the model a
   * HIGH-confidence convention over one file. So it becomes NO profile plus a
   * flag — the same shape an unreadable actor list already gets.
   */
  it('becomes a review flag, not a throw, when the stored blob does not validate', async () => {
    const world = fakeWorld({ styleProfile: { scopeRoot: '', filesRead: 'five' } });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job);

    expect(world.created).toHaveLength(1);
    const flags = (world.created[0]!.reviewFlags as string[]).join('\n');
    expect(flags).toMatch(/stored house-style profile and it did not validate/);
    expect(flags).toMatch(/Nothing from that column was passed through unchecked/);
  });

  it('refuses a profile whose age cannot be answered', async () => {
    const world = fakeWorld({
      styleProfile: emptyStyleProfile(''),
      styleProfileComputedAt: null,
    });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job);

    expect((world.created[0]!.reviewFlags as string[]).join('\n')).toMatch(
      /no computed-at date/,
    );
  });

  it('says on the test that nobody has measured this repository', async () => {
    const world = fakeWorld();
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job);

    const flags = (world.created[0]!.reviewFlags as string[]).join('\n');
    expect(flags).toMatch(/nobody has computed this repository's own/);
    expect(flags).toMatch(/setup is inline rather than extracted/);
  });
});

describe('the correction corpus', () => {
  beforeEach(() => {
    h.prompts.length = 0;
    h.llmReplies.length = 0;
    h.log.length = 0;
  });

  /*
   * THE PROJECT BOUNDARY. `corpusWhere` is the only way to build this
   * where-clause and both ids are required, so a query that could cross
   * projects does not compile — and this asserts the clause that reaches Prisma
   * really does carry both, with no symbol key on it.
   */
  it('is queried inside one project, newest first, within a window', async () => {
    const world = fakeWorld({ corrections: [] });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job);

    expect(world.correctionQueries).toHaveLength(1);
    const query = world.correctionQueries[0]!;
    expect(query.where).toEqual({ orgId: 'org1', projectId: 'p1' });
    expect(Object.getOwnPropertySymbols(query.where as object)).toEqual([]);
    expect(query.take).toBeGreaterThan(0);
  });

  it('reports that nothing was supplied, rather than looking like a clean suite', async () => {
    const world = fakeWorld({ corrections: [] });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job);

    expect((world.created[0]!.reviewFlags as string[]).join('\n')).toMatch(
      /What reviewers in this project keep changing/,
    );
  });
});


// ─── The ledger rows one set owes ───────────────────────────────────────────

/*
 * TESTED DIRECTLY, AND THE REASON HAS CHANGED, SO THE COMMENT HAS.
 *
 * It used to say `processGenerate` passes no `repository`, so a multi-artifact
 * set was unreachable through it and these invariants had to be pinned on the
 * pure function. The processor opens a repository view per batch now and section
 * 5 below drives a four-file set through it end to end, so these are no longer
 * the only cover for them — they are the UNIT, kept because the shared-role rule
 * and the imported-human-file rule are properties of this function and a test
 * that has to generate a whole batch to assert one of them is a test that fails
 * for ten reasons.
 */
describe('ledgerRowsFor', () => {
  const set = {
    dialect: 'JS_EXPECT' as const,
    artifacts: [
      {
        role: 'PAGE_OBJECT' as const,
        path: 'pages/cart.page.ts',
        content: 'export class CartPage {}',
        disposition: 'NEW' as const,
        ownership: 'QAAI_OWNED' as const,
        imports: [],
        basedOnHash: null,
        why: 'the page object',
      },
      {
        role: 'SPEC' as const,
        path: 'tests/cart.spec.ts',
        content: 'test("x", () => {});',
        disposition: 'NEW' as const,
        ownership: 'QAAI_OWNED' as const,
        imports: ['pages/cart.page.ts'],
        basedOnHash: null,
        why: 'the spec',
      },
    ],
  };

  /*
   * A page object two specs import belongs to NEITHER. Attaching it to the
   * first spec that happened to need it would make deleting that test look like
   * permission to delete the page object.
   */
  it('attaches a shared role to no test at all', () => {
    const rows = ledgerRowsFor({
      set,
      recordAsTheirs: [],
      orgId: 'org1',
      projectId: 'p1',
      testId: 'test_1',
      sharedRoles: SHARED_ARTIFACT_ROLES,
    });

    expect(rows.find((row) => row.role === 'PAGE_OBJECT')?.testId).toBeNull();
    expect(rows.find((row) => row.role === 'SPEC')?.testId).toBe('test_1');
  });

  /*
   * THE ROWS THE APPLY PATH OWES FOR SOMEBODY ELSE'S FILES. Without them
   * `artifactSetProblems` refuses a spec that imports a human's page object
   * with UNRESOLVED_IMPORT for ever — the import resolves against the set or
   * against the LEDGER, and a file that plainly exists is in neither. Worse and
   * slower: with no row, a later run resolves that path UNRECORDED, and
   * UNRECORDED is the state a reservation may CLAIM.
   */
  it('records a human file this set imports as theirs, so a reservation cannot claim it', () => {
    const rows = ledgerRowsFor({
      set,
      recordAsTheirs: ['pages/their-login.page.ts'],
      orgId: 'org1',
      projectId: 'p1',
      testId: 'test_1',
      sharedRoles: SHARED_ARTIFACT_ROLES,
    });

    const theirs = rows.find((row) => row.path === 'pages/their-login.page.ts');
    expect(theirs).toBeDefined();
    expect(theirs?.ownership).toBe('HUMAN_AUTHORED');
    expect(theirs?.testId).toBeNull();
    // Their bytes were never read, so nothing claims to have hashed them.
    expect(theirs?.bytes).toBe(0);
  });

  it('derives the shared roles from the vocabulary rather than listing them again', () => {
    // A SPEC is not shared — nothing imports a spec — and a SNAPSHOT belongs to
    // exactly the spec that compares against it.
    expect(SHARED_ARTIFACT_ROLES.has('PAGE_OBJECT')).toBe(true);
    expect(SHARED_ARTIFACT_ROLES.has('FIXTURE')).toBe(true);
    expect(SHARED_ARTIFACT_ROLES.has('SPEC')).toBe(false);
    expect(SHARED_ARTIFACT_ROLES.has('SNAPSHOT')).toBe(false);
  });
});

// ─── 5. THE REPOSITORY THIS BATCH PLANNED AGAINST ────────────────────────────

/**
 * A crawled cart page WITH A FORM, which is what makes a page object worth
 * minting.
 *
 * A node with no affordances and no forms yields no page object at all — the
 * plan is then correctly a set of one — so the shared `crawledFlowMap` above
 * cannot prove multi-file generation and a fixture with real controls on it has
 * to exist. The route is `/cart` because the plan item's own steps say "Open
 * the cart page", and tier-3 retrieval is word overlap: a page the item does not
 * mention is not in the prompt and is therefore not in the plan.
 */
const cartWithForm: FlowMap['nodes'][number] = {
  ...node('/cart'),
  title: 'Your cart',
  affordances: [
    {
      kind: 'button',
      label: 'Checkout',
      selector: { strategy: 'ROLE', value: 'button', name: 'Checkout', confidence: 0.95 },
    },
  ],
  forms: [
    {
      id: 'form:promo',
      name: 'promo',
      selector: { strategy: 'CSS', value: 'form#promo', confidence: 0.7 },
      submit: { strategy: 'ROLE', value: 'button', name: 'Apply', confidence: 0.9 },
      fields: [
        {
          name: 'code',
          label: 'Promo code',
          inputType: 'text',
          required: true,
          semantic: 'freeform',
          selector: { strategy: 'LABEL', value: 'Promo code', confidence: 0.9 },
        },
        {
          name: 'email',
          label: 'Email for the receipt',
          inputType: 'email',
          required: false,
          semantic: 'email',
          selector: { strategy: 'LABEL', value: 'Email for the receipt', confidence: 0.9 },
        },
      ],
    },
  ],
};

/** The crawl the multi-file tests generate against. */
const cartFlowMap: FlowMap = {
  ...crawledFlowMap,
  nodes: [node('/'), cartWithForm, node('/checkout')],
};

/**
 * A style profile that parses, which is the OTHER half of the gate in
 * `generateTest`: `args.repository && args.styleProfile`.
 *
 * `emptyStyleProfile('')` is the canonical "measured nothing anywhere" value and
 * `styleProfileSchema` accepts it — every confidence in it is NONE, which is
 * arithmetically consistent with `filesRead: 0`, and the schema re-derives them.
 * So this is a profile that is HONEST about knowing nothing rather than a
 * fabricated one, and the layout the plan then chooses comes from the ecosystem
 * and the ledger instead.
 */
const measuredNothing = emptyStyleProfile('');

/** A view over an in-memory tree. No disk, no network, no checkout. */
function fakeView(files: Map<string, string>, unreadable: Set<string> = new Set()): RepoFileView {
  return {
    diskStateAt: (path): DiskState => {
      if (unreadable.has(path)) return { state: 'UNREADABLE', why: 'the fake declined it' };
      const content = files.get(path);
      return content === undefined ? { state: 'ABSENT' } : { state: 'PRESENT', content };
    },
    filesUnder: (directory) =>
      [...files.keys()].filter((path) => {
        const slash = path.lastIndexOf('/');
        return (slash === -1 ? '' : path.slice(0, slash)) === directory;
      }),
  };
}

/** An opener that answers READABLE over `files`, and records that it was asked. */
function readableOpener(
  files: Map<string, string> = new Map(),
  unreadable?: Set<string>,
  /*
   * The EXISTING TESTS this checkout holds, which is a different question from
   * the one `fakeView` answers: a view lists one directory and reports what is
   * at a path, and a style learner walks the tree and reads whole bodies. Null
   * by default, which every test that is not about exemplars wants.
   */
  houseStyleSource: TestFileSource | null = null,
): { open: RepoViewOpener; asked: Array<Record<string, unknown>>; cleanups: number } {
  const asked: Array<Record<string, unknown>> = [];
  const state = { cleanups: 0 };
  return {
    asked,
    get cleanups() {
      return state.cleanups;
    },
    open: async (args) => {
      asked.push({ ...args });
      return {
        kind: 'READABLE',
        // Null unless a test asks for exemplars — no real directory is behind
        // this view, and `houseStyleFlags` reports that as "none was read"
        // rather than as 0 of 0.
        houseStyleSource,
        view: fakeView(files, unreadable),
        source: 'acme/shop@main',
        files: files.size,
        cleanup: async () => {
          state.cleanups += 1;
        },
      };
    },
  };
}

describe('a multi-file set reaches a customer', () => {
  beforeEach(() => {
    h.prompts.length = 0;
    h.llmReplies.length = 0;
    h.log.length = 0;
  });

  /**
   * THE ITEM TWO ROUNDS FAILED TO LAND, driven through the real
   * `processGenerate` over a real `generateTest` with a fake model.
   *
   * Nothing here is a mock of the thing being proven: the plan is computed by
   * the real `planArtifacts`, the page object is rendered by the real
   * `page-objects.ts`, the set is admitted by the real `admitSet`, and what is
   * asserted is the row that reaches `prisma.test.create` plus the ownership
   * rows beside it. The only injected surfaces are the model, Prisma and the
   * repository view — the three things that would otherwise need a key, a
   * database and a checkout.
   */
  it('writes more than one artifact, a page object among them, and the spec imports it', async () => {
    const repo = readableOpener();
    const world = fakeWorld({ styleProfile: measuredNothing, flowMapGraph: cartFlowMap });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      // Echoed from the prompt: the plan's import specifiers are relative to
      // the path it chose, so a reply anywhere else correctly drops the set.
      filePath: FOLLOW_SUGGESTED_PATH,
      // And the file IMPORTS what the briefing named — the generator reads the
      // bytes rather than trusting the plan, and drops a set that does not.
      code: FOLLOW_BRIEFED_IMPORTS,
      reviewFlags: [],
    });

    await processGenerate(job, { openRepoView: repo.open });

    /*
     * The repository was asked for, with the three facts the materialiser needs
     * — and this assertion is only meaningful because the Prisma fake honours
     * `select`: drop `defaultBranch` from the processor's query and these
     * arrive `undefined`.
     */
    expect(repo.asked).toHaveLength(1);
    expect(repo.asked[0]).toMatchObject({
      repoFullName: 'acme/shop',
      repoInstallationId: 'inst_1',
      defaultBranch: 'main',
    });

    /*
     * FOUR FILES, not one — the measured shape of this crawl: the page object
     * for the cart, the fixture that constructs it, the dataset the form's
     * fields are filled from, and the spec.
     */
    expect(world.artifactWrites.map((row) => row.role)).toEqual([
      'DATASET',
      'FIXTURE',
      'PAGE_OBJECT',
      'SPEC',
    ]);
    const roleOf = (role: string) => world.artifactWrites.find((row) => row.role === role)!;
    const pageObject = roleOf('PAGE_OBJECT');
    const fixture = roleOf('FIXTURE');
    const spec = roleOf('SPEC');

    /*
     * AND THE SPEC REACHES THE PAGE OBJECT, which is the point of the whole
     * exercise: a file in the set that nothing imports is a file nobody loads.
     * The chain is spec → fixture → page object, and it is asserted as a CHAIN
     * rather than as "the spec names the page object", because the fixture is
     * what constructs page objects and a spec that imported the class directly
     * would be the un-extended `test` with no fixtures. `imports` is the column
     * `dependentsOf` and the shared-surface rule read, so a wrong value here is
     * a wrong blast radius on the push path.
     */
    expect(spec.imports as string[]).toEqual([fixture.path]);
    expect(fixture.imports as string[]).toEqual([pageObject.path]);
    // And the spec's own bytes mention it, which is what the generator checked.
    expect(world.created[0]!.code as string).toContain('pages.fixture');

    /*
     * The page object and the fixture belong to NO single test — two specs may
     * import either — and the spec belongs to this one. Attaching a shared file
     * to the first spec that needed it would make deleting that test look like
     * permission to delete the page object.
     */
    expect(pageObject.testId).toBeNull();
    expect(fixture.testId).toBeNull();
    expect(spec.testId).toBe('test-1');
    // The workspace was removed on the way out.
    expect(repo.cleanups).toBe(1);
  });

  /**
   * THE NEGATIVE, AND IT IS HALF THE ITEM. "One file because we could not look"
   * and "one file because the page needed nothing else" are different outcomes,
   * and before this round the product said the first about both.
   */
  it('falls back to one file with the materialiser’s own reason when the view is unavailable', async () => {
    const world = fakeWorld({ styleProfile: measuredNothing, flowMapGraph: cartFlowMap });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job, {
      openRepoView: async () => ({
        kind: 'UNAVAILABLE',
        why: 'This project has no connected repository: install the QAAI GitHub App on the repo.',
      }),
    });

    expect(world.artifactWrites).toHaveLength(1);
    const flags = (world.created[0]!.reviewFlags as string[]).join('\n');
    // The reason that ACTUALLY BIT, in the materialiser's own words.
    expect(flags).toMatch(/could not read the repository/);
    expect(flags).toMatch(/no connected repository/);
    // And NOT the sentence for a different branch.
    expect(flags).not.toMatch(/the page needed nothing else|planned against the repository itself/);
  });

  /**
   * THE OTHER ONE-FILE OUTCOME, which only exists because the pair does.
   *
   * A page with no controls on it needs no page object, so a PLANNED batch can
   * still produce a set of one — and that must not read as "we could not look".
   */
  it('says the repository WAS read when the page simply needed nothing else', async () => {
    const repo = readableOpener();
    const world = fakeWorld({
      styleProfile: measuredNothing,
      // The bare `/cart` node: no affordances, no forms, nothing to extract.
      flowMapGraph: { ...crawledFlowMap, nodes: [node('/'), node('/cart')] },
    });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: FOLLOW_SUGGESTED_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job, { openRepoView: repo.open });

    expect(world.artifactWrites).toHaveLength(1);
    const flags = (world.created[0]!.reviewFlags as string[]).join('\n');
    expect(flags).toMatch(/planned against the repository itself/);
    expect(flags).toMatch(/acme\/shop@main/);
    expect(flags).not.toMatch(/could not read the repository/);
  });

  /**
   * NO TARBALL FOR A QUESTION A TARBALL CANNOT ANSWER.
   *
   * With no style profile the plan cannot be computed WHATEVER the repository
   * says, so the download is not paid for — and the reported reason is the one
   * that actually bit rather than "the repository was unreadable", which would
   * be a reason for a thing nobody tried.
   */
  it('does not open the repository at all when nobody has measured the project', async () => {
    const repo = readableOpener();
    const world = fakeWorld({ flowMapGraph: cartFlowMap });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job, { openRepoView: repo.open });

    expect(repo.asked).toHaveLength(0);
    const flags = (world.created[0]!.reviewFlags as string[]).join('\n');
    expect(flags).toMatch(/the repository was not downloaded at all/);
    expect(flags).not.toMatch(/could not read the repository/);
  });

  /**
   * THE DEFECT THAT BECOMES LIVE THE MOMENT THIS IS WIRED.
   *
   * `howToFill` in packages/agent/src/page-objects.ts does
   * `field.inputType.toLowerCase()` and throws a bare `TypeError` on a form
   * field that has none. Every current producer sets the field, so it was latent
   * — and reachable from a stored row the instant a plan is computed over one.
   * The boundary parse is what keeps it unreachable: the graph is refused, the
   * plan is withheld, generation still happens single-file, and the reason is on
   * the test.
   */
  it('withholds the plan when the stored crawl does not validate, and still generates', async () => {
    const fieldWithNoType = {
      ...cartWithForm,
      forms: [
        {
          ...cartWithForm.forms[0]!,
          fields: [
            // `inputType` deleted, which is exactly the row `howToFill` throws on.
            {
              name: 'code',
              label: 'Promo code',
              required: true,
              semantic: 'freeform',
              selector: { strategy: 'LABEL', value: 'Promo code', confidence: 0.9 },
            },
          ],
        },
      ],
    };
    const repo = readableOpener();
    const world = fakeWorld({
      styleProfile: measuredNothing,
      flowMapGraph: { ...cartFlowMap, nodes: [node('/'), fieldWithNoType] },
    });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job, { openRepoView: repo.open });

    // A test was still stored: an older crawl must not cost a generation.
    expect(world.created).toHaveLength(1);
    expect(world.artifactWrites).toHaveLength(1);
    // The repository was never opened, because the graph was refused first.
    expect(repo.asked).toHaveLength(0);
    const flags = (world.created[0]!.reviewFlags as string[]).join('\n');
    expect(flags).toMatch(/the stored crawl this plan was generated from did not validate/);
    // The zod PATH, and never the customer-authored value beside it.
    expect(flags).toMatch(/nodes\.1\.forms\.0\.fields\.0\.inputType/);
    expect(flags).not.toMatch(/Promo code/);
  });

  /**
   * THE FIFTH BRANCH, AND IT IS RULE 12'S MIRROR.
   *
   * The repository WAS read and the generator still declined its own plan — here
   * because the model answered at a path the plan did not choose, which makes
   * every import specifier in the plan resolve from the wrong directory. Saying
   * "no repository ledger was available" about that outcome would be reporting
   * as UNMEASURED a thing that was measured, which is the defect this round was
   * convened over.
   *
   * Found by mutation, not by reasoning: collapsing this branch back into the
   * batch-level reason left all 92 tests green, so the case had no cover at all.
   */
  it('does not blame the repository when the repository was read and the plan was declined', async () => {
    const repo = readableOpener();
    const world = fakeWorld({ styleProfile: measuredNothing, flowMapGraph: cartFlowMap });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      // NOT the planned path, which is what drops the set.
      filePath: 'tests/somewhere-else.spec.ts',
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job, { openRepoView: repo.open });

    expect(repo.asked).toHaveLength(1);
    expect(world.artifactWrites).toHaveLength(1);
    const flags = (world.created[0]!.reviewFlags as string[]).join('\n');
    expect(flags).toMatch(/The repository WAS read for this test/);
    expect(flags).toMatch(/This is not "we could not look"/);
    // And never the sentence for a branch that did not happen.
    expect(flags).not.toMatch(/could not read the repository|was not downloaded at all/);
  });

  /**
   * A BATCH WITH NOTHING TO GENERATE DOWNLOADS NOTHING, and the recorded reason
   * is its own rather than borrowed from the style profile.
   *
   * The first version of this reused `NO_STYLE_PROFILE` for this branch, which
   * put a token saying "nobody measured the conventions" on a batch where
   * nobody looked at the conventions either — a log line whose token
   * contradicts its own reason.
   */
  it('reads nothing at all for a batch whose items a human has not approved', async () => {
    const repo = readableOpener();
    const world = fakeWorld({
      styleProfile: measuredNothing,
      flowMapGraph: cartFlowMap,
      items: [{ ...CHECKOUT_ITEM, state: 'PROPOSED' }],
    });

    await processGenerate(job, { openRepoView: repo.open });

    expect(repo.asked).toHaveLength(0);
    expect(world.created).toHaveLength(0);
    const line = h.log.find((entry) => entry.msg.startsWith('the layout this batch'));
    expect(line).toBeDefined();
    expect(line!.obj).toMatchObject({
      layout: 'NOTHING_TO_GENERATE',
      why: 'this batch named no item it was allowed to generate',
    });
  });

  /**
   * A PARTIAL LEDGER REFUSES THE PLAN RATHER THAN SHORTENING IT.
   *
   * A plan computed over part of the recorded artifacts would reuse the page
   * objects it happened to read and mint second copies of the rest, which the
   * artifact rules call worse than minting none. So the cap does not truncate
   * the answer, it withdraws it — and says which cap bit.
   */
  it('refuses to plan over a ledger longer than one job reads, and names the cap', async () => {
    const repo = readableOpener();
    const world = fakeWorld({
      styleProfile: measuredNothing,
      flowMapGraph: cartFlowMap,
      // One past the cap, which is exactly what `take: cap + 1` exists to see.
      artifacts: Array.from({ length: 5_001 }, (_row, index) => ({
        orgId: 'org1',
        projectId: 'p1',
        path: `e2e/recorded-${index}.spec.ts`,
        role: 'SPEC',
        ownership: 'QAAI_OWNED',
        contentHash: 'h',
        imports: [],
      })),
    });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job, { openRepoView: repo.open });

    // The download was never paid for, because the ledger question came first.
    expect(repo.asked).toHaveLength(0);
    expect(world.artifactWrites).toHaveLength(1);
    const flags = (world.created[0]!.reviewFlags as string[]).join('\n');
    expect(flags).toMatch(/more recorded generated files than one job reads \(more than the 5000/);
    expect(flags).toMatch(/mint second copies of the rest/);
  });

  /**
   * THE WORKSPACE IS REMOVED WHEN THE BATCH THROWS, which is what `finally` is
   * for: a worker that leaks one extracted repository per failed batch fills its
   * disk and then fails every job for an unrelated reason.
   */
  it('removes the checkout even when the batch produced nothing', async () => {
    const repo = readableOpener();
    fakeWorld({
      styleProfile: measuredNothing,
      flowMapGraph: cartFlowMap,
      // A duplicate of the item being generated, which the gate refuses.
      tests: [existingTest()],
    });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await expect(processGenerate(job, { openRepoView: repo.open })).rejects.toThrow(
      'Generation produced no tests',
    );
    expect(repo.cleanups).toBe(1);
  });
});

describe('the ownership claim a generated set earns', () => {
  beforeEach(() => {
    h.prompts.length = 0;
    h.llmReplies.length = 0;
    h.log.length = 0;
  });

  /**
   * ITEM 4, END TO END. `ledgerRowsFor` minted `QAAI_OWNED` for every artifact
   * path having examined no repository, and the two `*.verify.test.ts` files
   * beside this one recorded that as the measured behaviour. With the view in
   * hand it is fixable, and this is the proof through the processor rather than
   * through the pure function alone.
   */
  it('does not claim a path the repository already has a file of theirs at', async () => {
    const theirs = "test('a person wrote this months ago', () => {});";
    const repo = readableOpener(new Map([[CHECKOUT_PATH, theirs]]));
    const world = fakeWorld({ styleProfile: measuredNothing, flowMapGraph: cartFlowMap });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      // Deliberately NOT echoed: the model answers at the path their file is
      // at, which is the collision this rule exists for.
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job, { openRepoView: repo.open });

    const row = world.artifactWrites.find((entry) => entry.path === CHECKOUT_PATH);
    expect(row).toBeDefined();
    expect(row!.ownership).toBe('HUMAN_AUTHORED');
    // And the human is TOLD, because a file that silently never syncs is the
    // other half of this defect.
    const flags = (world.created[0]!.reviewFlags as string[]).join('\n');
    expect(flags).toMatch(/were NOT claimed by QAAI/);
    expect(flags).toMatch(/will NOT be pushed to your branch/);
  });

  /**
   * THE OTHER DIRECTION, WHICH IS WHY `recorded` IS AN ARGUMENT. A path is
   * occupied BECAUSE QAAI pushed a file there last sync; ownership is read from
   * the recorded fact and never inferred from the file at the path.
   */
  it('keeps a path QAAI already has a row for, even though a file is there', async () => {
    const repo = readableOpener(new Map([[CHECKOUT_PATH, CHECKOUT_CODE]]));
    const world = fakeWorld({
      styleProfile: measuredNothing,
      flowMapGraph: cartFlowMap,
      artifacts: [
        {
          orgId: 'org1',
          projectId: 'p1',
          path: CHECKOUT_PATH,
          role: 'SPEC',
          ownership: 'QAAI_OWNED',
          contentHash: 'whatever-we-wrote-last-time',
          imports: [],
        },
      ],
    });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: CHECKOUT_PATH,
      code: CHECKOUT_CODE,
      reviewFlags: [],
    });

    await processGenerate(job, { openRepoView: repo.open });

    const row = world.artifactWrites.find((entry) => entry.path === CHECKOUT_PATH);
    expect(row!.ownership).toBe('QAAI_OWNED');
    const flags = (world.created[0]!.reviewFlags as string[]).join('\n');
    expect(flags).not.toMatch(/were NOT claimed by QAAI/);
  });

  /** The rule, at the unit the rule lives in. */
  it('reads UNREADABLE as UNKNOWN, which claims and COUNTS rather than refusing', () => {
    const set = {
      dialect: null,
      artifacts: [
        {
          role: 'SPEC' as const,
          path: 'e2e/checkout.spec.ts',
          content: 'ours',
          disposition: 'NEW' as const,
          ownership: 'QAAI_OWNED' as const,
          imports: [],
          basedOnHash: null,
          why: 'the spec',
        },
      ],
    };
    const declined = ownershipClaims({
      set,
      occupancy: occupancyProbe(fakeView(new Map(), new Set(['e2e/checkout.spec.ts']))),
    });
    expect(declined.verdictFor('e2e/checkout.spec.ts')).toBe('QAAI_OWNED');
    expect(declined.notOurs).toEqual([]);
    // The disclosure: a claim nothing looked at is COUNTED, not assumed absent.
    expect(declined.unexamined).toEqual(['e2e/checkout.spec.ts']);

    // And with no probe at all, which is the old blind behaviour plus the count.
    const blind = ownershipClaims({ set });
    expect(blind.verdictFor('e2e/checkout.spec.ts')).toBe('QAAI_OWNED');
    expect(blind.unexamined).toEqual(['e2e/checkout.spec.ts']);

    // An ABSENT path is FREE and is claimed with nothing counted.
    const free = ownershipClaims({ set, occupancy: occupancyProbe(fakeView(new Map())) });
    expect(free.verdictFor('e2e/checkout.spec.ts')).toBe('QAAI_OWNED');
    expect(free.unexamined).toEqual([]);
  });
});

describe('readFlowGraph', () => {
  it('accepts the crawl shape the Explorer stores, and keeps the optional fields', () => {
    const read = readFlowGraph({
      ...cartFlowMap,
      nodes: [
        {
          ...cartWithForm,
          /*
           * The honesty fields. `looseObject` is what keeps them: a schema that
           * listed only the required members would STRIP these, and `status`
           * absent means "this crawl could not ask" while `status: null` means
           * "it asked and the page declares nothing" — a distinction FlowMap's
           * own header calls load-bearing.
           */
          status: null,
          access: [],
        },
      ],
    });
    expect(read.graph).not.toBeNull();
    expect(read.refused).toEqual([]);
    expect(read.refusedCount).toBe(0);
    const first = read.graph!.nodes[0]!;
    expect(first.status).toBeNull();
    expect(first.access).toEqual([]);
    expect(first.forms[0]!.fields[0]!.inputType).toBe('text');
  });

  it('refuses a form field with no inputType, reporting the PATH and not the value', () => {
    const read = readFlowGraph({
      ...cartFlowMap,
      nodes: [
        {
          ...cartWithForm,
          forms: [
            {
              ...cartWithForm.forms[0]!,
              fields: [{ ...cartWithForm.forms[0]!.fields[0]!, inputType: undefined }],
            },
          ],
        },
      ],
    });
    expect(read.graph).toBeNull();
    expect(read.refusedCount).toBeGreaterThan(0);
    expect(read.refused.join(' ')).toContain('nodes.0.forms.0.fields.0.inputType');
    // Customer-authored text never travels in the report.
    expect(read.refused.join(' ')).not.toContain('Promo code');
  });

  it('refuses a selector the shared schema refuses, rather than keeping a second opinion', () => {
    const read = readFlowGraph({
      ...cartFlowMap,
      nodes: [
        {
          ...cartWithForm,
          affordances: [
            {
              kind: 'button',
              label: 'Checkout',
              // `selectorSchema` floors `confidence` at 0 and ceilings it at 1.
              selector: { strategy: 'ROLE', value: 'button', confidence: 1.5 },
            },
          ],
        },
      ],
    });
    expect(read.graph).toBeNull();
    expect(read.refused.join(' ')).toContain('nodes.0.affordances.0.selector.confidence');
  });

  it('caps the reported issues and says how many there were in all', () => {
    const broken = { ...cartFlowMap, nodes: [1, 2, 3, 4, 5, 6, 7, 8] };
    const read = readFlowGraph(broken);
    expect(read.graph).toBeNull();
    // A capped list that cannot read as the whole list.
    expect(read.refused).toHaveLength(5);
    expect(read.refusedCount).toBe(8);
  });

  it('hands back the raw value either way, which is what the single-file path reads', () => {
    const read = readFlowGraph({ nodes: 'not a list' });
    expect(read.graph).toBeNull();
    expect(read.unvalidated).toEqual({ nodes: 'not a list' });
  });
});

describe('nodeRepoFileView', () => {
  /*
   * THE ONE ADAPTER, against a real temp directory — which is the only way to
   * test it. Every rule above it is pure and takes a fake; this is the piece
   * where `lstat` either refuses a link or does not, and a fake reader cannot
   * answer that. No network, and nothing is written outside `mkdtemp`.
   */
  const root = mkdtempSync(join(tmpdir(), 'qaai-generate-view-'));
  mkdirSync(join(root, 'e2e', 'pages'), { recursive: true });
  writeFileSync(join(root, 'e2e', 'pages', 'cart.page.ts'), 'export class CartPage {}');
  writeFileSync(join(root, 'e2e', 'checkout.spec.ts'), 'ours');

  it('lists the files directly under a directory, repo-relative and sorted', () => {
    const view = nodeRepoFileView(root);
    expect(view.filesUnder('e2e/pages')).toEqual(['e2e/pages/cart.page.ts']);
    // Directly under, so the nested directory is not flattened in.
    expect(view.filesUnder('e2e')).toEqual(['e2e/checkout.spec.ts']);
    expect(view.filesUnder('nowhere')).toEqual([]);
  });

  it('answers PRESENT with the bytes, and ABSENT for a path their tree has not got', () => {
    const view = nodeRepoFileView(root);
    const present = view.diskStateAt('e2e/pages/cart.page.ts');
    expect(present).toEqual({ state: 'PRESENT', content: 'export class CartPage {}' });
    expect(view.diskStateAt('e2e/nope.spec.ts')).toEqual({ state: 'ABSENT' });
    // A directory is not a file, and it is not an absence either.
    expect(view.diskStateAt('e2e')).toEqual({
      state: 'UNREADABLE',
      why: 'a directory is there, not a file',
    });
  });

  /*
   * THE ESCAPE. `lstat` on a full path inspects only the FINAL component, so one
   * symlinked DIRECTORY makes `vendor/etc/hosts` a path with no `..` in it,
   * inside the root by every string check, resolving outside it. This is the
   * hole apps/worker/src/lib/workspace.ts's own test found in its first version.
   */
  it('refuses to follow a symlinked DIRECTORY, which is the cheaper escape', () => {
    symlinkSync('/', join(root, 'vendor'));
    const view = nodeRepoFileView(root);
    const state = view.diskStateAt('vendor/etc/hosts');
    expect(state.state).toBe('UNREADABLE');
    expect(state.state === 'UNREADABLE' && state.why).toMatch(/symbolic link/);
    // And the message names the SEGMENT, never the worker's temp-directory path.
    expect(state.state === 'UNREADABLE' && state.why).not.toContain(root);
  });

  it('refuses a path that climbs out, and a NUL byte, through the one path rule', () => {
    const view = nodeRepoFileView(root);
    for (const attempt of ['../../etc/passwd', '/etc/passwd', 'e2e/\0.spec.ts']) {
      const state = view.diskStateAt(attempt);
      expect(state.state).toBe('UNREADABLE');
      expect(state.state === 'UNREADABLE' && state.why).toMatch(/inside the checkout/);
    }
  });

  /*
   * A CAP THAT BIT, REPORTED AS THE CAP THAT BIT — and UNREADABLE rather than
   * ABSENT, because a planner that read "nothing is there" would conclude the
   * path is free and plan a write over a file QAAI declined to open.
   */
  it('reports a file over the byte cap as UNREADABLE with the cap named', () => {
    writeFileSync(join(root, 'big.spec.ts'), 'x'.repeat(64));
    const view = nodeRepoFileView(root, { ...DEFAULT_REPO_VIEW_LIMITS, fileBytes: 32 });
    const state = view.diskStateAt('big.spec.ts');
    expect(state.state).toBe('UNREADABLE');
    expect(state.state === 'UNREADABLE' && state.why).toMatch(/reads at most 32 from one file/);
  });

  it('stops a directory listing at the entry cap', () => {
    mkdirSync(join(root, 'many'), { recursive: true });
    for (const n of [1, 2, 3, 4]) writeFileSync(join(root, 'many', `f${n}.ts`), '');
    const view = nodeRepoFileView(root, { ...DEFAULT_REPO_VIEW_LIMITS, entriesPerDirectory: 2 });
    expect(view.filesUnder('many')).toHaveLength(2);
  });
});

describe('the layout vocabulary', () => {
  /*
   * THE COMPILER-ENFORCED HALF OF RULE D, asserted at run time too — because
   * `LAYOUT_SENTENCES` being a `Record<LayoutOutcome, …>` is checked by tsc and
   * tsc is not what runs in CI for this file.
   *
   * THERE IS NO ZOD PARITY TEST AND NONE IS OWED: this union has no write path.
   * The token is logged and the SENTENCE is what reaches a human, on
   * `Test.reviewFlags`, which is a `String[]` and not an enum — so a
   * `z.enum(LAYOUT_OUTCOMES)` here would guard a validator nothing runs.
   */
  it('has a distinct sentence for every outcome, and none of them is a restatement', () => {
    const rendered = LAYOUT_OUTCOMES.map((outcome) => LAYOUT_SENTENCES[outcome]('BECAUSE'));
    expect(new Set(rendered).size).toBe(LAYOUT_OUTCOMES.length);
    for (const sentence of rendered) {
      expect(sentence.length).toBeGreaterThan(80);
      // Never the bare token: a human reads prose, not a vocabulary member.
      expect(sentence).not.toMatch(/GRAPH_UNPARSED|REPOSITORY_UNREADABLE|PLAN_NOT_USABLE/);
    }
  });

  it('distinguishes the two one-file outcomes in words, not only in a token', () => {
    const couldNotLook = LAYOUT_SENTENCES.REPOSITORY_UNREADABLE('no repository is connected.');
    const nothingNeeded = LAYOUT_SENTENCES.PLANNED('5 file(s) at acme/shop@main');
    expect(couldNotLook).toMatch(/could not read the repository/);
    expect(nothingNeeded).toMatch(/read rather than guessed/);
    expect(couldNotLook).not.toContain(nothingNeeded);
  });
});

/**
 * THE EXEMPLAR HALF OF THE HOUSE STYLE, which had no producer on this path.
 *
 * `GenerateTestArgs.learnedStyle` was declared, read by `selectExemplars` and
 * disclosed by `houseStyleFlags` — and nothing in the product filled it. Every
 * generated test therefore carried `exemplarsShown: 0, exemplarsConsidered: 0`,
 * the shape whose own sentence is "none was read, so there was nothing to
 * quote", about a repository this processor had just downloaded and walked.
 *
 * That is lesson A exactly — correct code connected to nothing — and it is why
 * these assertions are about the FLAG ON THE ROW rather than about a call: a
 * spy proving `learnStyle` ran would have passed in the round that left the
 * field empty too.
 */
describe('the existing tests in the checkout reach the generator', () => {
  beforeEach(() => {
    h.prompts.length = 0;
    h.llmReplies.length = 0;
    h.log.length = 0;
  });

  /** Two real-looking Playwright specs, long enough to survive the excerpt floor. */
  function houseTests(): TestFileSource {
    const body = (surface: string) => `import { test, expect } from '@playwright/test';

test.describe('${surface}', () => {
  test('shows the ${surface} to a signed-in member', async ({ page }) => {
    await page.goto('/${surface}');
    await expect(page.getByTestId('${surface}-heading')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  test('refuses an empty submission', async ({ page }) => {
    await page.goto('/${surface}');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Required')).toBeVisible();
  });
});
`;
    const files = new Map([
      ['e2e/cart.spec.ts', body('cart')],
      ['e2e/checkout.spec.ts', body('checkout')],
      ['e2e/account.spec.ts', body('account')],
    ]);
    return {
      list: () => Promise.resolve([...files.keys()]),
      read: (path) => Promise.resolve(files.get(path) ?? null),
    };
  }

  it('stops claiming nothing was read once the checkout answers with its tests', async () => {
    const withTests = readableOpener(new Map(), undefined, houseTests());
    const world = fakeWorld({ styleProfile: measuredNothing, flowMapGraph: cartFlowMap });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: FOLLOW_SUGGESTED_PATH,
      code: FOLLOW_BRIEFED_IMPORTS,
      reviewFlags: [],
    });

    await processGenerate(job, { openRepoView: withTests.open });

    const flags = (world.created[0]!.reviewFlags as string[]).join('\n');
    /*
     * THE SENTENCE THAT WAS A LIE ABOUT AN OPENED REPOSITORY. Three test files
     * were offered and read, so whatever `selectExemplars` decided to quote,
     * "none was read" is no longer an honest thing to say.
     */
    expect(flags).not.toContain('none was read, so there was nothing to quote');
  });

  it('still says nothing was read when the opener has no tests to offer, which is the honest case', async () => {
    const noTests = readableOpener();
    const world = fakeWorld({ styleProfile: measuredNothing, flowMapGraph: cartFlowMap });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: FOLLOW_SUGGESTED_PATH,
      code: FOLLOW_BRIEFED_IMPORTS,
      reviewFlags: [],
    });

    await processGenerate(job, { openRepoView: noTests.open });

    const flags = (world.created[0]!.reviewFlags as string[]).join('\n');
    expect(flags).toContain('none was read, so there was nothing to quote');
  });

  it('asks the learner once for the batch and not once per test', async () => {
    let listed = 0;
    const counting: TestFileSource = {
      list: () => {
        listed += 1;
        return Promise.resolve([]);
      },
      read: () => Promise.resolve(null),
    };
    const repo = readableOpener(new Map(), undefined, counting);
    fakeWorld({ styleProfile: measuredNothing, flowMapGraph: cartFlowMap });
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: FOLLOW_SUGGESTED_PATH,
      code: FOLLOW_BRIEFED_IMPORTS,
      reviewFlags: [],
    });

    await processGenerate(job, { openRepoView: repo.open });

    /*
     * ONE. It reads whole file bodies, so a per-item call would re-read the
     * suite for every test in the batch — the cost shape `readArtifactLedger`
     * and the view opener are both batch-scoped to avoid.
     */
    expect(listed).toBe(1);
  });
});
