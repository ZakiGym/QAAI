/**
 * Tests for the import processor, written around the two lies it used to tell.
 *
 * ── LIE ONE: A JAVA SHOP GETS A TYPESCRIPT REWRITE ──────────────────────────
 *
 * `convertSuiteWithLlm` was called with no `targetEcosystem`, so it fell back
 * to Playwright TypeScript for every customer. The importer's own ecosystem
 * machinery existed and nothing reached it.
 *
 * ── LIE TWO: THE BETTER DEFAULT WAS UNREACHABLE ─────────────────────────────
 *
 * `planSuiteImport` and `decideDisposition` had no production caller.
 * INDEX_AS_EXISTING_COVERAGE — read the suite, count it, write nothing — could
 * not happen at all, because the only caller of the planner was the converter
 * and it hard-codes `requested: 'CONVERT_TO_PROJECT_ECOSYSTEM'`.
 *
 * ── WHY THESE RUN THE REAL PROCESSOR AND THE REAL PLANNER ───────────────────
 *
 * Only `../context.js` is replaced: Postgres, Redis and the model open at its
 * import. `planSuiteImport`, `convertSuiteWithLlm`, the prompt fence and
 * `resolveEcosystem` are the real ones, so a test here fails when the WIRING is
 * removed rather than when a mock's expectations change. The model is a
 * function that returns a literal — rule thirteen: the deterministic path is
 * the one that must work, and the INDEX path below reaches a verdict without
 * the model being called at all.
 *
 * The Prisma fake HONOURS `select`, and the delegates used inside
 * `$transaction` are on its `tx` object rather than the top level, because a
 * select-blind fake makes deleting a field from a query undetectable.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmError } from '@qaai/agent';
import type { ImportJob } from '@qaai/shared';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  events: Row[];
  log: Array<{ level: string; msg: string }>;
  /** Every `llm.structured` call, so "was the model asked at all" is decidable. */
  llmCalls: Row[];
  llmAnswer: { summary: string; tests: Array<{ name: string; code: string; notes: string[] }> };
  llmThrows: Error | null;
}

const h = vi.hoisted(
  (): Hoisted => ({
    prisma: {},
    events: [],
    log: [],
    llmCalls: [],
    llmAnswer: { summary: 'converted', tests: [] },
    llmThrows: null,
  }),
);

vi.mock('../context.js', () => {
  const record =
    (level: string) =>
    (_obj: unknown, msg?: string): void => {
      h.log.push({ level, msg: msg ?? '' });
    };
  return {
    config: {},
    connection: {},
    storage: {},
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
    publishEvent: (orgId: string, event: Row) => {
      h.events.push({ orgId, ...event });
    },
    llm: {
      structured: async (_ctx: unknown, args: Row) => {
        h.llmCalls.push(args);
        if (h.llmThrows) throw h.llmThrows;
        return h.llmAnswer;
      },
    },
  };
});

const { processImport, importSummary } = await import('./import.js');

// ─── The world ───────────────────────────────────────────────────────────────

/**
 * The mixed upload a verifier used against the previous round: one real test
 * and eight build, dependency and runner manifests from five ecosystems.
 *
 * The point of it is that A BUILD MANIFEST IS NOT AN UNPARSEABLE TEST. Before
 * the planner's `CONFIG_FILE` covered more than `*.config.ts`, six of these
 * were read as unreadable tests and then QUOTED TO THE MODEL, which converted
 * `pom.xml` into "tests" and wrote them into a Java shop's repository.
 */
const MIXED: Array<{ path: string; content: string }> = [
  {
    path: 'src/test/java/CartTest.java',
    content:
      'import org.junit.jupiter.api.Test;\n' +
      'class CartTest {\n' +
      '  @Test void addsToCart() { assertEquals(1, cart.size()); }\n' +
      '}\n',
  },
  { path: 'pom.xml', content: '<project/>' },
  { path: 'build.gradle', content: 'plugins {}' },
  { path: 'pytest.ini', content: '[pytest]' },
  { path: 'tests/conftest.py', content: 'import pytest\n' },
  { path: 'go.mod', content: 'module example.com/x' },
  { path: 'Gemfile', content: "source 'https://rubygems.org'" },
  { path: 'playwright.config.ts', content: 'export default {};' },
  { path: 'jest.config.js', content: 'module.exports = {};' },
];

const PLAYWRIGHT_SUITE = [
  {
    path: 'tests/cart.spec.ts',
    content:
      "import { test, expect } from '@playwright/test';\n" +
      "test('adds to cart', async ({ page }) => {\n" +
      "  await page.goto('/cart');\n" +
      "  await expect(page.getByTestId('count')).toHaveText('1');\n" +
      '});\n',
  },
];

const POSTMAN_COLLECTION = JSON.stringify({
  info: { name: 'orders', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [{ name: 'get orders', request: { method: 'GET', url: { raw: 'https://api.test/orders' } } }],
});

let batch: Row;
let project: Row;
let created: Row[] = [];
let suiteUpserts: Row[] = [];
let batchUpdates: Row[] = [];

/** A row reduced to the fields a `select` asked for. See the header. */
function selected(row: Row | null, select?: Record<string, boolean>): Row | null {
  if (row === null) return null;
  if (!select) return row;
  const out: Row = {};
  for (const [key, wanted] of Object.entries(select)) if (wanted) out[key] = row[key];
  return out;
}

const JOB: ImportJob = {
  orgId: 'org_1',
  projectId: 'proj_1',
  importBatchId: 'batch_1',
  requestedBy: 'user_1',
};

beforeEach(() => {
  h.events = [];
  h.log = [];
  h.llmCalls = [];
  h.llmThrows = null;
  h.llmAnswer = {
    summary: 'one test converted',
    tests: [{ name: 'adds to cart', code: '// converted', notes: [] }],
  };
  created = [];
  suiteUpserts = [];
  batchUpdates = [];

  batch = {
    id: 'batch_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    framework: 'SELENIUM_JAVA',
    files: MIXED,
    state: 'DETECTED',
  };
  project = {
    id: 'proj_1',
    primaryLanguage: 'JAVA',
    primaryFramework: 'SELENIUM',
  };

  h.prisma = {
    importBatch: {
      findFirst: async () => batch,
      update: async ({ where, data }: Row) => {
        batchUpdates.push({ where, data });
        Object.assign(batch, data);
        return batch;
      },
    },
    project: {
      findFirst: async ({ select }: { select?: Record<string, boolean> }) =>
        selected(project, select),
    },
    flowMap: { findFirst: async () => null },
    /*
     * The delegates the processor uses INSIDE the transaction live on `tx` and
     * nowhere else, so a write that escaped the transaction would throw here
     * rather than quietly succeed.
     */
    $transaction: async (fn: (tx: Row) => Promise<void>) =>
      fn({
        suite: {
          upsert: async (args: Row) => {
            suiteUpserts.push(args);
            return { id: 'suite_1' };
          },
        },
        test: {
          create: async ({ data }: Row) => {
            created.push(data);
            return { id: `test_${created.length}` };
          },
        },
      }),
  };
});

function finished(): Row | undefined {
  return h.events.find((event) => event.type === 'run.finished');
}

// ─── The disposition is now DECIDED rather than assumed ─────────────────────

describe('the planner on the production import path', () => {
  /*
   * THE HEADLINE. A Java project uploading a JUnit suite is READ, not rewritten.
   * `decideDisposition`'s same-dialect branch is what produces this, and before
   * this round it was unreachable because the only caller of the planner told
   * it the answer.
   */
  it('reads a Java shop’s suite as existing coverage instead of rewriting it', async () => {
    await processImport(JOB);

    expect(finished()?.data.disposition).toBe('INDEX_AS_EXISTING_COVERAGE');
    expect(finished()?.data.convertedCount).toBe(0);
    // Nothing was written: no suite, no test row, no version.
    expect(created).toEqual([]);
    expect(suiteUpserts).toEqual([]);
    // And the model was never asked, so this verdict needs no key at all.
    expect(h.llmCalls).toEqual([]);
    expect(batch.state).toBe('DONE');
    expect(String(batch.summary)).toContain('wrote NOTHING');
  });

  /*
   * THE REASON TRAVELS WITH THE DECISION. A disposition with no sentence beside
   * it is a choice the customer cannot argue with.
   */
  it('prints the reason the disposition was chosen, naming the dialect', async () => {
    await processImport(JOB);
    expect(String(batch.summary)).toContain('already written in this project’s own dialect');
    expect(String(batch.summary)).toContain('JVM');
  });

  /*
   * THE OTHER HALF OF THE SAME DECISION. Flip the project's language and the
   * same upload converts — so the test above is not passing because the
   * processor always indexes.
   */
  it('converts the same upload when the project writes a different dialect', async () => {
    project = { id: 'proj_1', primaryLanguage: 'TYPESCRIPT', primaryFramework: 'PLAYWRIGHT' };
    await processImport(JOB);

    expect(finished()?.data.disposition).toBe('CONVERT_TO_PROJECT_ECOSYSTEM');
    expect(h.llmCalls.length).toBeGreaterThan(0);
    /*
     * TWO files were attempted, not one: `conftest.py` is UNPARSEABLE and the
     * converter ATTEMPTS an unparseable file on purpose rather than dropping
     * whole frameworks whose dialect this repository cannot resolve yet. The
     * fake answers one test per call, so two rows land — and both facts are
     * disclosed, which is the next assertion.
     */
    expect(h.llmCalls.length).toBe(2);
    expect(created.length).toBe(2);
  });
});

// ─── The target ecosystem ───────────────────────────────────────────────────

describe('the ecosystem a conversion writes into', () => {
  /*
   * A RUBY SHOP IS NOT HANDED TYPESCRIPT. The system prompt is built by
   * `convertSystemPrompt(ecosystem)` from the ecosystem this processor passed,
   * so asserting on the prompt proves the argument arrived — and the argument
   * is the entire fix.
   */
  it('passes the project’s own ecosystem, so the prompt names it', async () => {
    project = { id: 'proj_1', primaryLanguage: 'RUBY', primaryFramework: 'CAPYBARA' };
    await processImport(JOB);

    expect(h.llmCalls.length).toBeGreaterThan(0);
    const system = String(h.llmCalls[0]!.system);
    expect(system).toMatch(/You migrate an existing automated test into /);
    expect(system).not.toContain('Playwright (TypeScript');
    expect(system.toLowerCase()).toContain('ruby');
  });

  /*
   * THE DEFAULT IS NO LONGER REACHABLE FROM HERE, AND THE SUMMARY PROVES IT.
   * `convertSuiteWithLlm` appends a paragraph beginning "The project's own
   * ecosystem was not supplied" when `targetEcosystem` is absent. Its presence
   * is exactly the old defect, so its absence is the assertion.
   */
  it('never reports a defaulted target ecosystem on this path', async () => {
    project = { id: 'proj_1', primaryLanguage: 'TYPESCRIPT', primaryFramework: 'PLAYWRIGHT' };
    await processImport(JOB);

    expect(String(batch.summary)).not.toContain('was not supplied');
    expect(finished()?.data.targetEcosystemId).toBe('PLAYWRIGHT_TS');
  });
});

// ─── The counts a human reads ───────────────────────────────────────────────

describe('honest counts over the mixed upload', () => {
  /*
   * A BUILD MANIFEST IS NOT AN UNPARSEABLE TEST. Seven of the nine files are
   * manifests and they are SKIPPED with that reason; the only unreadable one is
   * `conftest.py`, which the planner deliberately keeps on the read path
   * because it declares FIXTURES a conversion needs to see.
   */
  it('skips build manifests and never counts them as unreadable tests', async () => {
    await processImport(JOB);
    const data = finished()!.data;

    expect(data.skippedCount).toBe(7);
    expect(data.unreadableCount).toBe(1);
    expect(data.indexedCount).toBe(1);
    expect(String(batch.summary)).toContain('config, build or dependency manifests');
    // Named, with a path a human can open, and not summed into "skipped".
    expect(String(batch.summary)).toContain('tests/conftest.py');
    expect(String(batch.summary)).toContain('[READING]');
  });

  /*
   * EVERY FILE IS IN EXACTLY ONE BUCKET. A total that does not reconcile is how
   * a dropped file becomes invisible — it stops being unconverted and becomes
   * absent, and absent costs nothing.
   */
  it('accounts for every file handed in, with no file in two buckets', async () => {
    await processImport(JOB);
    const data = finished()!.data;

    expect(data.filesHandedIn).toBe(MIXED.length);
    expect(
      data.indexedCount + data.convertibleCount + data.skippedCount + data.unreadableCount,
    ).toBe(MIXED.length);
  });

  /*
   * THE SAME IDENTITY ON THE PATH THAT WRITES FILES, and it is a separate test
   * because the version above held VACUOUSLY.
   *
   * On INDEX every readable file is INDEXED and `convertible` is 0, so
   * `indexed + skipped + unreadable` reconciled whether or not the convertible
   * bucket was reported at all. On CONVERT the arithmetic inverts — `indexed`
   * is 0 and every readable file is CONVERTIBLE — and the sum the event payload
   * offered a consumer came back 2 against `filesHandedIn: 3`, missing the one
   * file the whole migration was about. A reconciliation asserted on one
   * disposition is an identity that holds where it was tested.
   */
  it('reconciles on the CONVERT path too, where the convertible bucket is the suite', async () => {
    batch.framework = 'CYPRESS';
    batch.files = [
      {
        path: 'cypress/e2e/cart.cy.js',
        content: "describe('cart', () => {\n  it('adds', () => { cy.visit('/cart'); });\n});\n",
      },
      { path: 'cypress.config.js', content: 'module.exports = {};' },
      { path: 'README.md', content: '# not a test' },
    ];

    await processImport(JOB);
    const data = finished()!.data;

    // Cross-dialect, so this really is the writing path.
    expect(data.disposition).toBe('CONVERT_TO_PROJECT_ECOSYSTEM');
    expect(data.indexedCount).toBe(0);
    expect(data.convertibleCount).toBe(1);
    expect(data.filesHandedIn).toBe(3);
    expect(
      data.indexedCount + data.convertibleCount + data.skippedCount + data.unreadableCount,
    ).toBe(data.filesHandedIn);
  });

  /*
   * AN UNREAD SUITE IS NOT AN EMPTY ONE. With nothing readable, the summary
   * must refuse to claim a count rather than printing zero.
   */
  it('refuses to claim a test count over a suite it could not read', async () => {
    batch.files = [{ path: 'tests/thing.weird', content: 'nobody knows' }];
    await processImport(JOB);

    expect(String(batch.summary)).toContain('that is an unread suite, not an empty one');
    expect(finished()!.data.testsRead).toBe(0);
  });
});

describe('"N of M", with both numbers', () => {
  /*
   * A COUNT WITH NOTHING TO DIVIDE BY IS NOT A COUNT. "Converted 7 test(s)"
   * over a suite that declared 12 reads exactly like a complete migration.
   * Asserted over the STRING a customer sees, because that is where the second
   * number can go missing while every field is still correct.
   */
  it('reports what was converted against what was handed in', async () => {
    project = { id: 'proj_1', primaryLanguage: 'TYPESCRIPT', primaryFramework: 'PLAYWRIGHT' };
    await processImport(JOB);

    expect(String(batch.summary)).toContain(`from ${MIXED.length} uploaded file(s)`);
    expect(String(batch.summary)).toMatch(/Converted 2 test\(s\)/);
    /*
     * AND THE DENOMINATOR FROM THE READING, which is the honest one — and which
     * here does NOT equal the numerator. The reading found one test block;
     * the migration produced two, because one came out of a file QAAI could not
     * parse. Both numbers are printed and the unparseable file is named, so the
     * discrepancy is readable rather than hidden by printing only one of them.
     */
    expect(String(batch.summary)).toContain('declared 1 test(s) and this migration produced 2');
    expect(String(batch.summary)).toContain('tests/conftest.py');
  });

  it('reports both numbers when it indexed rather than converted', () => {
    const summary = importSummary({
      disposition: 'INDEX_AS_EXISTING_COVERAGE',
      dispositionReason: 'the suite is already in this dialect',
      targetEcosystemId: 'PLAYWRIGHT_TS',
      filesHandedIn: 9,
      converted: 0,
      indexed: 4,
      convertible: 0,
      skipped: 5,
      testsRead: 31,
      unreadable: [],
    });

    expect(summary).toContain('Read 4 of 9 uploaded file(s)');
    expect(summary).toContain('declare 31 test(s)');
  });
});

// ─── Postman: the failure that used to vanish ───────────────────────────────

describe('a Postman collection that will not parse', () => {
  beforeEach(() => {
    batch.framework = 'POSTMAN';
    batch.files = [
      { path: 'orders.postman_collection.json', content: POSTMAN_COLLECTION },
      { path: 'broken.postman_collection.json', content: '{ not json' },
      { path: 'package.json', content: '{}' },
    ];
  });

  /*
   * COUNTED, WITH THE REASON THAT ACTUALLY BIT. This was an `emit` and a
   * `logger.warn`: the file left no trace in any number the batch row carried,
   * so four unparseable collections out of five reported one success and zero
   * failures. The reading stage cannot know this — a Postman file is
   * CONVERTIBLE until it is parsed — so the entry is stamped CONVERSION.
   */
  it('counts it as unparseable with its own reason rather than dropping it', async () => {
    await processImport(JOB);
    const data = finished()!.data;

    expect(data.unreadableCount).toBe(1);
    expect(String(batch.summary)).toContain('broken.postman_collection.json');
    expect(String(batch.summary)).toContain('[CONVERSION]');
    expect(String(batch.summary)).toContain('not a valid Postman / Newman collection');
    // And it is NOT counted as imported.
    expect(data.convertedCount).toBeGreaterThan(0);
    expect(created.length).toBe(data.convertedCount);
  });

  /*
   * The plan's SKIPPED verdicts drive the deterministic loop too, so a
   * `package.json` in a Postman upload is not parsed as a collection and does
   * not land in the unreadable list.
   */
  it('skips a manifest in a Postman upload instead of failing to parse it', async () => {
    await processImport(JOB);

    expect(finished()!.data.skippedCount).toBe(1);
    expect(String(batch.summary)).not.toContain('package.json [CONVERSION]');
  });

  /*
   * And no model was asked, which is the Postman promise: it is data, not code.
   */
  it('needs no model at all', async () => {
    await processImport(JOB);
    expect(h.llmCalls).toEqual([]);
  });
});

// ─── Failure keeps the honest half ──────────────────────────────────────────

describe('when the conversion fails', () => {
  beforeEach(() => {
    project = { id: 'proj_1', primaryLanguage: 'TYPESCRIPT', primaryFramework: 'PLAYWRIGHT' };
    batch.files = PLAYWRIGHT_SUITE.map((file) => ({ ...file, path: 'tests/cart.java' }));
  });

  /*
   * THE READING SURVIVES. It cost no key and no model, so it is still true
   * after a conversion failed — and it is the half that tells a customer what
   * their suite contains. An AUTH failure is the one the converter rethrows,
   * because it will hit every remaining file identically.
   */
  it('keeps the reading on the row rather than replacing it with the error', async () => {
    h.llmThrows = new LlmError('no API key configured', 'AUTH');
    await expect(processImport(JOB)).rejects.toThrow('no API key configured');

    expect(batch.state).toBe('ERRORED');
    expect(String(batch.summary)).toContain('uploaded file(s)');
    expect(String(batch.summary)).toContain('tests/cart.java');
    /*
     * The AUTH cause is named rather than buried under "nothing converted" —
     * and the sentence says which paths still work without a key, because that
     * is the actionable half.
     */
    expect(String(batch.error)).toContain('existing coverage');
  });

  /*
   * A FAILED FILE IS COUNTED. `convertSuiteWithLlm` catches a NON-AUTH failure
   * per file and names it in `failedSources`; the processor folds that into the
   * one unreadable list rather than letting `tests.length` fall silently to
   * zero with nothing anywhere saying why.
   */
  it('counts a per-file conversion failure instead of letting the test count fall silently', async () => {
    h.llmThrows = new Error('the model returned nonsense');
    await processImport(JOB);

    expect(batch.state).toBe('DONE');
    expect(finished()!.data.convertedCount).toBe(0);
    /*
     * ONE FILE, TWO REASONS. `tests/cart.java` is unreadable at READING (no JVM
     * test block) and then FAILS at CONVERSION, so it earns two entries and is
     * still one file. Reporting the entry count as a file count made
     * indexed + skipped + unreadable exceed filesHandedIn — a total that no
     * longer reconciles, which is the defect this pair of numbers now prevents.
     */
    expect(finished()!.data.unreadableCount).toBe(1);
    expect(finished()!.data.unreadableReasonCount).toBe(2);
    expect(String(batch.summary)).toContain('[CONVERSION]');
    expect(String(batch.summary)).toContain('the model returned nonsense');
    expect(String(batch.summary)).toContain('can fail twice');
  });

  /*
   * THE RECONCILIATION, OVER THE CASE THAT BROKE IT. One file in, and the three
   * buckets still sum to one.
   */
  it('keeps the buckets reconcilable when one file fails at both stages', async () => {
    h.llmThrows = new Error('the model returned nonsense');
    await processImport(JOB);
    const data = finished()!.data;

    expect(data.filesHandedIn).toBe(1);
    expect(data.indexedCount + data.skippedCount + data.unreadableCount).toBe(1);
  });
});

// ─── Zero is a result, not a failure ────────────────────────────────────────

describe('an upload with nothing in it to import', () => {
  it('finishes DONE with the same counts a non-empty run reports', async () => {
    project = { id: 'proj_1', primaryLanguage: 'TYPESCRIPT', primaryFramework: 'PLAYWRIGHT' };
    batch.framework = 'POSTMAN';
    batch.files = [{ path: 'package.json', content: '{}' }];
    await processImport(JOB);

    expect(batch.state).toBe('DONE');
    expect(batch.convertedCount).toBe(0);
    const data = finished()!.data;
    expect(data.filesHandedIn).toBe(1);
    expect(data.skippedCount).toBe(1);
    expect(data.unreadableCount).toBe(0);
  });
});

// ─── The project has to exist ───────────────────────────────────────────────

describe('the project read the whole decision rests on', () => {
  it('refuses rather than defaulting the ecosystem when the project is gone', async () => {
    h.prisma = { ...h.prisma, project: { findFirst: async () => null } };
    await expect(processImport(JOB)).rejects.toThrow(/Project proj_1 not found/);
    expect(h.llmCalls).toEqual([]);
  });

  /*
   * THE SELECT IS ASSERTED, because the fake honours it: dropping
   * `primaryLanguage` from the query would silently resolve every project to
   * the ecosystem default, which is the defect this round fixed.
   */
  it('asks for the two columns the ecosystem is resolved from', async () => {
    let seen: Row | null = null;
    h.prisma = {
      ...h.prisma,
      project: {
        findFirst: async (args: Row) => {
          seen = args;
          return selected(project, args.select);
        },
      },
    };
    await processImport(JOB);

    expect(seen!.select).toMatchObject({ primaryLanguage: true, primaryFramework: true });
    expect(seen!.where).toMatchObject({ id: 'proj_1', orgId: 'org_1' });
  });
});
