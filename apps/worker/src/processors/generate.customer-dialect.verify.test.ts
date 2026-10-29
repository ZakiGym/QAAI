/**
 * ADVERSARIAL VERIFICATION — DOES A CUSTOMER ACTUALLY GET MULTI-FILE TESTS IN
 * THEIR OWN DIALECT?
 *
 * Two rounds claimed this. The builders of this round claim it again, and their
 * proof uses `emptyStyleProfile('')` — a profile that measured NOTHING — so
 * what it proves is "four files in QAAI's dialect", not "four files in the
 * customer's". This file closes the gap between those two sentences by driving
 * BOTH real processors over ONE real repository on disk:
 *
 *   1. `processStyleProfile` with the REAL `learnStyle` over a fixture
 *      repository whose dialect is deliberately NOT QAAI's — tests under
 *      `tests/acceptance/`, page objects under `tests/acceptance/page-objects/`,
 *      `*.e2e.ts` rather than `*.spec.ts`. The profile it STORES is captured.
 *   2. `processGenerate` reading THAT STORED VALUE back out of the Project row,
 *      with the REAL `nodeRepoFileView` over the SAME tree — not an in-memory
 *      fake view — and the real `planArtifacts`/`page-objects.ts`/`admitSet`.
 *
 * What is asserted is therefore the whole chain a customer travels, and what is
 * PRINTED is the literal artifact set, so the judgement about dialect is made
 * against bytes rather than against a call graph.
 *
 * NO MODEL. NO NETWORK. NO DATABASE. The model is a canned reply, Prisma is a
 * select-honouring fake, and the repository is `mkdtempSync`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlowMap } from '@qaai/shared';
import type { CallContext, StructuredOptions } from '@qaai/agent';
import type { RepoViewOpener } from './generate.js';

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
    llm: {
      configured: true,
      structured: async (_ctx: CallContext, opts: StructuredOptions<never>) => {
        h.prompts.push(opts.prompt);
        const reply = h.llmReplies[Math.min(h.prompts.length - 1, h.llmReplies.length - 1)];
        if (!reply) throw new Error('the fake model was called with no reply configured');
        /*
         * The same two echoes the craft suite uses, and for the same reason: a
         * reply at any other path makes `specPathMoved` true and the generator
         * correctly DROPS the set, so a canned path would exercise the drop
         * branch in every test instead of the one that is about it.
         */
        const out: Record<string, unknown> = { ...reply };
        if (out.filePath === FOLLOW_SUGGESTED_PATH) {
          const suggested = /filePath\s+"([^"]+)"/.exec(opts.prompt)?.[1];
          if (suggested === undefined) {
            throw new Error('the prompt did not name a filePath for the fake model to echo');
          }
          out.filePath = suggested;
        }
        if (out.filePath === OBEY_MEASURED_FILENAME) {
          const suggested = /filePath\s+"([^"]+)"/.exec(opts.prompt)?.[1] ?? '';
          out.filePath = suggested.replace(/\.spec\.ts$/, '.e2e.ts');
        }
        if (out.code === FOLLOW_BRIEFED_IMPORTS) out.code = specImporting(opts.prompt);
        return out;
      },
    },
  };
});

const FOLLOW_SUGGESTED_PATH = '<<echo the suggested path>>';
const FOLLOW_BRIEFED_IMPORTS = '<<import the briefed files>>';
/** "Answer at the path the MEASURED house style asked for, not the ecosystem's." */
const OBEY_MEASURED_FILENAME = '<<obey the measured filename>>';

/**
 * A spec that imports exactly what `artifactBriefing` named, read off the
 * briefing's own two line shapes. The generator READS THE BYTES and drops a set
 * whose spec does not mention its fixture, so a fixed canned file would
 * exercise the drop branch in every test instead of the one about it.
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

const { processGenerate, nodeRepoFileView } = await import('./generate.js');
const { processStyleProfile, openWorkspaceTestFiles } = await import('./style-profile.js');

// ─── The fixture repository: a dialect that is NOT QAAI's ───────────────────

/**
 * Five Playwright specs in a dialect QAAI does not use, so "it matched" cannot
 * be an accident of the two conventions coinciding:
 *   · directory      `tests/acceptance/`      (QAAI writes `<feature>/`)
 *   · spec suffix    `.e2e.ts`                (QAAI writes `.spec.ts`)
 *   · page objects   `tests/acceptance/page-objects/*.po.ts`
 *   · fixtures       `tests/acceptance/support/world.ts`
 *   · naming         snake_case file names
 *   · assertions     `expect(...).toHaveText` via a fixture parameter
 */
function fixtureRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'qaai-dialect-'));
  mkdirSync(join(root, 'tests', 'acceptance', 'page-objects'), { recursive: true });
  mkdirSync(join(root, 'tests', 'acceptance', 'support'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'shop', devDependencies: { '@playwright/test': '^1.49.0' } }, null, 2),
  );
  writeFileSync(join(root, 'playwright.config.ts'), `export default { testDir: './tests/acceptance' };\n`);
  writeFileSync(
    join(root, 'tests', 'acceptance', 'support', 'world.ts'),
    `import { test as base } from '@playwright/test';\nimport { SearchPage } from '../page-objects/search.po';\n\nexport const test = base.extend<{ searchPage: SearchPage }>({\n  searchPage: async ({ page }, use) => {\n    await use(new SearchPage(page));\n  },\n});\nexport { expect } from '@playwright/test';\n`,
  );
  writeFileSync(
    join(root, 'tests', 'acceptance', 'page-objects', 'search.po.ts'),
    `import type { Page, Locator } from '@playwright/test';\n\nexport class SearchPage {\n  readonly results: Locator;\n  constructor(private readonly page: Page) {\n    this.results = page.getByTestId('results');\n  }\n  async open(): Promise<void> {\n    await this.page.goto('/search');\n  }\n}\n`,
  );
  const spec = (name: string, title: string): string =>
    `import { test, expect } from '../support/world';\n\ntest.describe('${title}', () => {\n  test('${title} renders', async ({ searchPage }) => {\n    await searchPage.open();\n    await expect(searchPage.results).toHaveText('ready');\n  });\n\n  test('${title} survives a reload', async ({ searchPage, page }) => {\n    await searchPage.open();\n    await page.reload();\n    await expect(searchPage.results).toBeVisible();\n  });\n});\n// ${name}: padding so this file clears MIN_EXEMPLAR_CHARS and is a usable\n// worked example rather than a snippet below the floor. ${'x'.repeat(420)}\n`;
  for (const [file, title] of [
    ['product_search.e2e.ts', 'Product search'],
    ['cart_totals.e2e.ts', 'Cart totals'],
    ['checkout_flow.e2e.ts', 'Checkout flow'],
    ['account_login.e2e.ts', 'Account login'],
    ['order_history.e2e.ts', 'Order history'],
  ] as const) {
    writeFileSync(join(root, 'tests', 'acceptance', file), spec(file, title));
  }
  return root;
}

// ─── The crawl: a page with a login form on it ──────────────────────────────

function node(route: string): FlowMap['nodes'][number] {
  return {
    id: `node:${route}`,
    route,
    url: `https://shop.example${route}`,
    title: route,
    stateKey: 'default',
    requiresRoles: [],
    behindAuth: false,
    forms: [],
    affordances: [],
    screenshotKey: null,
    a11yViolationCount: 0,
  };
}

/** `/cart`, with a two-field sign-in form — the deliverable's "login form". */
const cartWithLogin: FlowMap['nodes'][number] = {
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
      id: 'form:signin',
      name: 'signin',
      selector: { strategy: 'CSS', value: 'form#signin', confidence: 0.7 },
      submit: { strategy: 'ROLE', value: 'button', name: 'Sign in', confidence: 0.9 },
      fields: [
        {
          name: 'email',
          label: 'Email',
          inputType: 'email',
          required: true,
          semantic: 'email',
          selector: { strategy: 'LABEL', value: 'Email', confidence: 0.9 },
        },
        {
          name: 'password',
          label: 'Password',
          inputType: 'password',
          required: true,
          semantic: 'password',
          selector: { strategy: 'LABEL', value: 'Password', confidence: 0.9 },
        },
      ],
    },
  ],
};

const cartFlowMap: FlowMap = {
  projectId: 'p1',
  environmentId: 'e1',
  version: 1,
  baseUrl: 'https://shop.example',
  nodes: [node('/'), cartWithLogin, node('/checkout')],
  edges: [],
  journeys: [],
  features: [],
  exploredAt: new Date().toISOString(),
  truncatedReason: null,
};

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
  state: 'APPROVED',
  gapId: null,
};

/** Mutable so one test can make the plan item's feature a deny-listed segment. */
const FEATURE = { value: 'checkout' };

const job = {
  orgId: 'org1',
  projectId: 'p1',
  testPlanId: 'plan1',
  planItemIds: ['item-checkout'],
  requestedBy: 'user-who-approved-the-plan',
};

// ─── My own Prisma fake. It honours `select`, `take` and `orderBy`. ─────────

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
      if ('not' in filter && (filter.not === null ? actual === null : actual === filter.not)) {
        return false;
      }
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

/** Rule 9: a select-blind fake makes deleting a field from a query invisible. */
function selected<T extends Record<string, unknown>>(
  row: T,
  select: Record<string, boolean> | undefined,
): Partial<T> {
  if (!select) return row;
  const out: Record<string, unknown> = {};
  for (const [key, wanted] of Object.entries(select)) if (wanted) out[key] = row[key];
  return out as Partial<T>;
}

interface World {
  readonly project: Record<string, unknown>;
  readonly created: Array<Record<string, unknown>>;
  readonly artifactWrites: Array<Record<string, unknown>>;
  readonly projectUpdates: Array<Record<string, unknown>>;
}

function world(options: { styleProfile?: unknown; styleProfileComputedAt?: Date | null } = {}): World {
  const project: Record<string, unknown> = {
    id: 'p1',
    primaryLanguage: 'TYPESCRIPT',
    primaryFramework: 'PLAYWRIGHT',
    repoFullName: 'acme/shop',
    repoInstallationId: 'inst_1',
    defaultBranch: 'main',
    styleProfile: options.styleProfile ?? null,
    styleProfileComputedAt:
      'styleProfileComputedAt' in options ? options.styleProfileComputedAt : null,
  };
  const created: Array<Record<string, unknown>> = [];
  const artifactWrites: Array<Record<string, unknown>> = [];
  const projectUpdates: Array<Record<string, unknown>> = [];
  const ledger: Array<Record<string, unknown>> = [];
  const tests: Array<Record<string, unknown>> = [];
  let clock = Date.parse('2026-10-01T00:00:00.000Z');

  h.prisma = {
    project: {
      findFirst: async ({ select }: { select?: Record<string, boolean> } = {}) =>
        selected(project, select),
      update: async ({ data }: { where: unknown; data: Record<string, unknown> }) => {
        projectUpdates.push(data);
        Object.assign(project, data);
        return project;
      },
    },
    testCorrection: { findMany: async () => [] },
    generatedArtifact: {
      findMany: async ({
        where,
        take,
        orderBy,
        select,
      }: {
        where?: Record<string, unknown>;
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
            (e) => e.projectId === row.projectId && e.path === row.path,
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
      findUnique: async () => ({ id: 'fm1', environmentId: 'env1', graph: cartFlowMap }),
    },
    environment: { findFirst: async () => null },
    planItem: {
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        [{ ...CHECKOUT_ITEM, feature: FEATURE.value }].filter((row) =>
          matchesWhere(row, where ?? {}),
        ),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: where.id,
        ...data,
      }),
    },
    suite: { upsert: async () => ({ id: 'suite1' }) },
    test: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        tests.find((row) => matchesWhere(row, where)) ?? null,
      findMany: async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
        tests.filter((row) => matchesWhere(row, where)).slice(0, take),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        clock += 1_000;
        const row = { ...data, id: `test-${created.length}`, createdAt: new Date(clock) };
        tests.push(row);
        return row;
      },
    },
    auditLog: { create: async ({ data }: { data: unknown }) => data },
  };

  return { project, created, artifactWrites, projectUpdates };
}

/** An opener that answers READABLE over a REAL tree through the REAL adapter. */
function realTreeOpener(root: string): { open: RepoViewOpener; asked: number; cleanups: number } {
  const state = { asked: 0, cleanups: 0 };
  return {
    get asked() {
      return state.asked;
    },
    get cleanups() {
      return state.cleanups;
    },
    open: async () => {
      state.asked += 1;
      return {
        kind: 'READABLE',
        // No real directory behind this view, so no exemplars — which
        // `houseStyleFlags` reports as "none was read" rather than 0 of 0.
        houseStyleSource: null,
        view: nodeRepoFileView(root),
        source: 'acme/shop@main',
        files: 9,
        cleanup: async () => {
          state.cleanups += 1;
        },
      };
    },
  };
}

// ─── The chain ──────────────────────────────────────────────────────────────

describe('the whole chain a customer travels', () => {
  beforeEach(() => {
    h.prompts.length = 0;
    h.llmReplies.length = 0;
    h.log.length = 0;
    /*
     * The feature knob is SHARED STATE, so it is reset here and not at the end
     * of the one test that changes it: a test that fails mid-way never reaches
     * its own cleanup, and a mutation run proved the leak — killing the fix
     * turned a THIRD, unrelated test red because `dist` survived into it.
     */
    FEATURE.value = 'checkout';
  });

  it('learns the dialect, STORES it, and the next generate job writes a set against it', async () => {
    const root = fixtureRepository();

    // ── 1. THE PROFILE IS COMPUTED AND STORED ──────────────────────────────
    const w = world();
    const computedAt = new Date('2026-10-28T09:00:00.000Z');
    const opened = await openWorkspaceTestFiles(root);
    const outcome = await processStyleProfile(
      { orgId: 'org1', projectId: 'p1', reason: 'source-analysis' },
      {
        now: () => computedAt,
        open: async () => ({
          kind: 'ready',
          source: opened.source,
          listing: opened.listing,
          provenance: 'acme/shop@main',
          close: async () => {},
        }),
      },
    );

    expect(outcome.kind).toBe('STORED');
    // ONE update, BOTH columns, and the date is the real one.
    expect(w.projectUpdates).toHaveLength(1);
    expect(w.projectUpdates[0]!.styleProfileComputedAt).toBe(computedAt);
    const stored = w.projectUpdates[0]!.styleProfile as Record<string, unknown>;
    expect(stored).toBeTruthy();

    console.log(
      '\n=== 1. WHAT WAS STORED ON Project.styleProfile ===\n' +
        JSON.stringify(
          {
            filesRead: stored.filesRead,
            scopeRoot: stored.scopeRoot,
            runner: stored.runner,
            fileLayout: stored.fileLayout,
            naming: stored.naming,
            fixtureMechanism: stored.fixtureMechanism,
            assertionStyle: stored.assertionStyle,
            locatorStrategy: stored.locatorStrategy,
            importAlias: stored.importAlias,
          },
          null,
          2,
        ),
    );

    // ── 2. THE NEXT GENERATE JOB READS IT ──────────────────────────────────
    const w2 = world({ styleProfile: stored, styleProfileComputedAt: computedAt });
    const repo = realTreeOpener(root);
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: FOLLOW_SUGGESTED_PATH,
      code: FOLLOW_BRIEFED_IMPORTS,
      reviewFlags: [],
    });

    try {
      await processGenerate(job, { openRepoView: repo.open });
    } catch (err) {
      console.log(
        '\n=== THE BATCH THREW ===\n' +
          String((err as Error).message) +
          '\n=== THE PATH THE PLAN SUGGESTED, off the prompt ===\n' +
          (/^\s*PATH\s+(.+)$/m.exec(h.prompts[0] ?? '')?.[1] ??
            /filePath\s+"([^"]+)"/.exec(h.prompts[0] ?? '')?.[1] ??
            '(not found in prompt)') +
          '\n=== THE ARTIFACT BRIEFING, off the prompt ===\n' +
          (h.prompts[0] ?? '').slice(
            Math.max(0, (h.prompts[0] ?? '').indexOf('THE FILES')),
            Math.max(0, (h.prompts[0] ?? '').indexOf('THE FILES')) + 2200,
          ),
      );
      throw err;
    }

    expect(repo.asked).toBe(1);
    expect(repo.cleanups).toBe(1);

    console.log(
      '\n=== 2. THE ARTIFACT SET THE CUSTOMER GETS ===\n' +
        w2.artifactWrites
          .map(
            (row) =>
              `--- ${String(row.role)}  ${String(row.path)}  imports=${JSON.stringify(row.imports)}  ownership=${String(row.ownership)}\n${String(row.bytes)}`,
          )
          .join('\n'),
    );
    console.log(
      '\n=== 2b. THE ARTIFACT ROW KEYS ===\n' +
        JSON.stringify(Object.keys(w2.artifactWrites[0] ?? {})) +
        '\n=== 2c. WHAT THE MODEL WAS TOLD ABOUT THIS REPOSITORY ===\n' +
        (h.prompts[0] ?? '').slice(
          (h.prompts[0] ?? '').indexOf("TEST CONVENTIONS"),
          (h.prompts[0] ?? '').indexOf("TEST CONVENTIONS") + 1800,
        ),
    );
    console.log(
      '\n=== 3. THE REVIEW FLAGS ON THE TEST ROW ===\n' +
        JSON.stringify(w2.created[0]?.reviewFlags, null, 2),
    );

    /*
     * THE HEADLINE: more than one artifact, a page object among them, and the
     * spec importing it through the fixture.
     */
    const roles = w2.artifactWrites.map((row) => String(row.role));
    expect(roles.length).toBeGreaterThan(1);
    expect(roles).toContain('PAGE_OBJECT');
    expect(roles).toContain('SPEC');
    const roleOf = (role: string) => w2.artifactWrites.find((row) => String(row.role) === role)!;
    expect(roleOf('SPEC').imports as string[]).toEqual([roleOf('FIXTURE').path]);
    expect(roleOf('FIXTURE').imports as string[]).toEqual([roleOf('PAGE_OBJECT').path]);
  });
});

describe('the two filename rules one prompt carries', () => {
  beforeEach(() => {
    h.prompts.length = 0;
    h.llmReplies.length = 0;
    h.log.length = 0;
    /*
     * The feature knob is SHARED STATE, so it is reset here and not at the end
     * of the one test that changes it: a test that fails mid-way never reaches
     * its own cleanup, and a mutation run proved the leak — killing the fix
     * turned a THIRD, unrelated test red because `dist` survived into it.
     */
    FEATURE.value = 'checkout';
  });

  /**
   * THE PROMPT TELLS THE MODEL TWO DIFFERENT THINGS ABOUT THE FILENAME.
   *
   * `styleProfileBriefing` states `fileLayout: ... filename={name}.e2e.ts
   * (5 of 7 files)` under the header "Match them", and forty lines later the
   * return block names `filePath "…/checkout_shows_the_order_total.spec.ts"`.
   * `FileLayout.filename` has no consumer anywhere, so the planner cannot have
   * used it.
   *
   * This pins what the customer gets when the model follows the FIRST of those
   * two rules, which is the one stated as a repository fact with its evidence
   * fraction beside it.
   */
  it('costs the customer the whole multi-file set when the model obeys the measured one', async () => {
    const root = fixtureRepository();
    const w = world();
    const computedAt = new Date('2026-10-28T09:00:00.000Z');
    const opened = await openWorkspaceTestFiles(root);
    await processStyleProfile(
      { orgId: 'org1', projectId: 'p1', reason: 'source-analysis' },
      {
        now: () => computedAt,
        open: async () => ({
          kind: 'ready',
          source: opened.source,
          listing: opened.listing,
          provenance: 'acme/shop@main',
          close: async () => {},
        }),
      },
    );
    const stored = w.projectUpdates[0]!.styleProfile;

    const w2 = world({ styleProfile: stored, styleProfileComputedAt: computedAt });
    const repo = realTreeOpener(root);
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      // The measured convention, obeyed: `{name}.e2e.ts` under the measured root.
      filePath: OBEY_MEASURED_FILENAME,
      code: FOLLOW_BRIEFED_IMPORTS,
      reviewFlags: [],
    });

    await processGenerate(job, { openRepoView: repo.open });

    console.log(
      '\n=== OBEYING THE MEASURED FILENAME ===\npath stored: ' +
        String(w2.created[0]?.filePath) +
        '\nartifacts: ' +
        JSON.stringify(w2.artifactWrites.map((r) => [String(r.role), String(r.path)])) +
        '\nthe flag that explains it: ' +
        JSON.stringify(
          (w2.created[0]?.reviewFlags as string[]).filter(
            (f) => f.includes('inline') || f.includes('moved') || f.includes('import'),
          ),
          null,
          2,
        ),
    );

    // ONE FILE. The set was dropped, and the setup is back inline.
    expect(w2.artifactWrites).toHaveLength(1);
    expect(w2.artifactWrites[0]!.role).toBe('SPEC');
  });
});

describe('the corrected path reaches the customer unjudged', () => {
  beforeEach(() => {
    h.prompts.length = 0;
    h.llmReplies.length = 0;
    h.log.length = 0;
    /*
     * The feature knob is SHARED STATE, so it is reset here and not at the end
     * of the one test that changes it: a test that fails mid-way never reaches
     * its own cleanup, and a mutation run proved the leak — killing the fix
     * turned a THIRD, unrelated test red because `dist` survived into it.
     */
    FEATURE.value = 'checkout';
  });

  /**
   * END TO END, through the REAL processor: a plan item whose `feature` is a
   * deny-listed segment, and a model path the runner would not collect, so
   * PATH_CONVENTION takes its correction branch and builds the replacement out
   * of that feature name.
   *
   * BEFORE THE FIX IN packages/agent/src/admission.ts this stored
   * `Test.filePath = dist/checkout-shows-the-order-total.spec.ts` and a
   * `GeneratedArtifact` row at that path marked QAAI_OWNED — a test coverage
   * counted that `pushRepo` then refuses with FORBIDDEN_DESTINATION, so it
   * could never have reached the branch and nothing said so at generation
   * time. Now the batch refuses, and the refusal names the directory.
   */
  it('refuses rather than storing a QAAI_OWNED row inside a deny-listed directory', async () => {
    FEATURE.value = 'dist';
    const w = world();
    const repo = realTreeOpener(fixtureRepository());
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      // Not a path Playwright collects, so the correction branch is taken.
      filePath: 'checkout/order-total.ts',
      code: `import { test, expect } from '@playwright/test';\n\ntest('Checkout shows the order total', async ({ page }) => {\n  await page.goto('/cart');\n  await expect(page.getByTestId('order-total')).toHaveText('$42.00');\n});\n`,
      reviewFlags: [],
    });

    let thrown: string | null = null;
    try {
      await processGenerate(
        { ...job, planItemIds: ['item-checkout'] },
        { openRepoView: repo.open },
      );
    } catch (err) {
      thrown = (err as Error).message;
    }

    console.log(
      '\n=== THE DENY LIST, END TO END ===\nrefusal: ' +
        String(thrown) +
        '\nTest rows written: ' +
        String(w.created.length) +
        '\nGeneratedArtifact rows: ' +
        JSON.stringify(w.artifactWrites.map((r) => [String(r.path), String(r.ownership)])),
    );

    // NOTHING was stored at a path QAAI may not write to.
    expect(w.created).toHaveLength(0);
    expect(w.artifactWrites).toHaveLength(0);
    expect(thrown).toContain('build output');
  });
});

describe('the honesty properties, after wiring', () => {
  beforeEach(() => {
    h.prompts.length = 0;
    h.llmReplies.length = 0;
    h.log.length = 0;
    /*
     * The feature knob is SHARED STATE, so it is reset here and not at the end
     * of the one test that changes it: a test that fails mid-way never reaches
     * its own cleanup, and a mutation run proved the leak — killing the fix
     * turned a THIRD, unrelated test red because `dist` survived into it.
     */
    FEATURE.value = 'checkout';
  });

  /**
   * A REPOSITORY WITH NO TESTS IS ALL-UNKNOWN, RENDERS AS "not established",
   * AND `layoutChecked` SAYS FALSE — which is the OTHER direction of item 2.
   * The first test in this file holds the true direction.
   */
  it('reports a repository with no tests as unmeasured, in the profile and at the set gate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qaai-no-tests-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bare' }));
    writeFileSync(join(root, 'src', 'cart.ts'), 'export const total = (n: number) => n;\n');

    const w = world();
    const computedAt = new Date('2026-10-28T09:00:00.000Z');
    const opened = await openWorkspaceTestFiles(root);
    const outcome = await processStyleProfile(
      { orgId: 'org1', projectId: 'p1', reason: 'source-analysis' },
      {
        now: () => computedAt,
        open: async () => ({
          kind: 'ready',
          source: opened.source,
          listing: opened.listing,
          provenance: 'acme/shop@main',
          close: async () => {},
        }),
      },
    );
    expect(outcome.kind).toBe('STORED');
    const stored = w.projectUpdates[0]!.styleProfile as Record<string, unknown>;
    // filesRead is 0 and NOT a fabricated count.
    expect(stored.filesRead).toBe(0);
    const layout = stored.fileLayout as { confidence: string; value: unknown };
    expect(layout.confidence).toBe('UNKNOWN');
    expect(layout.value).toBeNull();

    const w2 = world({ styleProfile: stored, styleProfileComputedAt: computedAt });
    const repo = realTreeOpener(root);
    h.llmReplies.push({
      name: 'Checkout shows the order total',
      filePath: FOLLOW_SUGGESTED_PATH,
      code: FOLLOW_BRIEFED_IMPORTS,
      reviewFlags: [],
    });
    await processGenerate(job, { openRepoView: repo.open });

    const prompt = h.prompts[0] ?? '';
    const flags = (w2.created[0]?.reviewFlags as string[]) ?? [];
    console.log(
      '\n=== AN UNMEASURED REPOSITORY ===\nbriefing: ' +
        (/THIS REPOSITORY'S[^\n]*/.exec(prompt)?.[0] ?? '(no conventions block)') +
        '\nlayout flag present: ' +
        String(flags.some((f) => f.includes('No usable test layout was measured'))) +
        '\nartifacts: ' +
        JSON.stringify(w2.artifactWrites.map((r) => [String(r.role), String(r.path)])),
    );

    // "not established", and the honest denominator beside it.
    expect(prompt).toContain("THIS REPOSITORY'S TEST CONVENTIONS: not established");
    expect(prompt).toContain('0 test file(s) were read');
    // And the set gate says the layout was NOT checked, because it was not.
    expect(flags.some((f) => f.includes('No usable test layout was measured'))).toBe(true);
  });
});
