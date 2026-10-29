/**
 * Tests for the house-style profile writer.
 *
 * Written around the ways this can be WRONG rather than around its lines,
 * because every one of them is a way the product lies rather than a way it
 * crashes:
 *
 *   • A PROFILE STORED FOR A REPOSITORY NOBODY READ. `emptyStyleProfile` in
 *     that column is a profile that confidently reports no conventions, which
 *     is a different and FALSE claim from NULL's "nobody has measured this" —
 *     and the generator states a stored profile to the model as a measured
 *     rule. So an unreachable repository must write NOTHING.
 *   • A PROFILE STORED THAT THE READ PATH REFUSES. `readStyleProfile` parses
 *     this column with `styleProfileSchema` and turns a failure into a review
 *     flag blaming the stored data, so a producer that stores what that parser
 *     refuses converts its own bug into an accusation.
 *   • THE TWO COLUMNS DISAGREEING. `readStyleProfile` refuses a profile with no
 *     date outright, so a blob written without one is a project that is
 *     permanently profile-less AND flagged.
 *   • A JOB ID RETAINED AFTER A FAILURE, which would freeze one project's
 *     conventions for ever with no error anywhere.
 *   • A REQUEST THAT THROWS, taking a finished generate batch down with it and
 *     replacing the error it actually failed with.
 *   • A REFUSED DIRECTORY REPORTED AS AN ABSENCE, which is the same number as
 *     "this repository has no tests" and a completely different fact.
 *
 * Nothing here opens a network, a disk or Redis: the filesystem is the
 * processor's own injected {@link RepoTree} / {@link OpenedTestFiles} seam, and
 * the Prisma fake HONOURS `select` — a select-blind fake makes deleting a field
 * from a query undetectable, which is how `styleProfileComputedAt` could stop
 * being read with nothing going red.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { styleProfileSchema } from '@qaai/shared';
import { learnStyle, type TestFileSource } from '@qaai/agent';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/*
 * TYPE-ONLY, and load-bearing. `verbatimModuleSyntax` erases an `import type`
 * entirely, so this line couples the two modules at typecheck time and not at
 * run time — the module itself is still reached through the `await import`
 * below, AFTER `vi.mock` has replaced the worker context it would otherwise
 * open Postgres and Redis to build.
 */
import type {
  OpenedTestFiles,
  RepoTree,
  RepoTreeEntry,
  StyleProfileJob,
} from './style-profile.js';

// The worker's context opens Postgres, Redis and the LLM at import time, so it
// is replaced wholesale; `h.prisma` and `h.log` are read per test.
const h = vi.hoisted(
  (): {
    prisma: Record<string, unknown>;
    log: Array<{ level: string; msg: string; obj: unknown }>;
    queueAdds: Array<{ queue: string; name: string; data: unknown; opts: Record<string, unknown> }>;
    addThrows: Error | null;
  } => ({ prisma: {}, log: [], queueAdds: [], addThrows: null }),
);

vi.mock('../context.js', () => {
  const record =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      h.log.push({ level, msg: msg ?? '', obj });
    };
  return {
    config: {},
    connection: {},
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
  };
});

// A Queue stand-in that records every add() with its options, so the coalescing
// test can assert the one fact BullMQ's dedupe rests on: a stable job id with
// both removals.
vi.mock('bullmq', () => ({
  Queue: class {
    constructor(
      public queueName: string,
      _opts: unknown,
    ) {}
    async add(name: string, data: unknown, opts: Record<string, unknown>): Promise<{ id: string }> {
      if (h.addThrows) throw h.addThrows;
      h.queueAdds.push({ queue: this.queueName, name, data, opts });
      return { id: typeof opts.jobId === 'string' ? opts.jobId : name };
    }
    async close(): Promise<void> {}
  },
}));

// The vault and the materialiser are only reached by the DEFAULT `open`, which
// no test here uses — they are mocked so importing this module cannot try to
// read a sealed key or a GitHub App config at import time.
vi.mock('../vault.js', () => ({ open: () => '' }));
vi.mock('../repo-materialise.js', () => ({
  materialiseRepoWorkspace: () =>
    Promise.resolve({ kind: 'unavailable', why: 'not reachable from a unit test.' }),
}));

const {
  MAX_TREE_DEPTH,
  MAX_TREE_ENTRIES,
  STYLE_PROFILE_ATTEMPTS,
  STYLE_PROFILE_FRESH_MS,
  STYLE_PROFILE_OUTCOMES,
  STYLE_PROFILE_OUTCOME_WHY,
  STYLE_PROFILE_QUEUE,
  STYLE_PROFILE_REASONS,
  STYLE_PROFILE_WINDOW_MS,
  closeStyleProfileQueue,
  enqueueStyleProfile,
  processStyleProfile,
  requestStyleProfile,
  styleProfileFacts,
  styleProfileIsFresh,
  styleProfileJobId,
  styleProfileJobOptions,
  nodeRepoTree,
  openWorkspaceTestFiles,
  styleProfileSentence,
  walkRepoTree,
} = await import('./style-profile.js');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = new Date('2026-10-28T12:00:00.000Z');

interface ProjectRow {
  id: string;
  orgId: string;
  repoFullName: string | null;
  repoInstallationId: string | null;
  defaultBranch: string;
  primaryLanguage: string;
  styleProfile: unknown;
  styleProfileComputedAt: Date | null;
}

function projectRow(over: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: 'proj_1',
    orgId: 'org_1',
    repoFullName: 'acme/shop',
    repoInstallationId: 'inst_1',
    defaultBranch: 'main',
    // Present in the fixture and absent from the processor's `select`, so the
    // select-honouring fake below proves the query is narrow.
    primaryLanguage: 'TYPESCRIPT',
    styleProfile: null,
    styleProfileComputedAt: null,
    ...over,
  };
}

type Select = Record<string, unknown>;

/**
 * Project a fixture row through the `select` the processor actually asked for,
 * the way Prisma does.
 *
 * This is not tidiness. A fake that shrugs at `select` cannot fail the test
 * that proves the `select` is there — and `styleProfileComputedAt` dropping out
 * of this query would silently make every stored profile look dateless, which
 * `readStyleProfile` turns into a review flag on every generated test.
 */
function applySelect(value: unknown, select: Select | undefined): unknown {
  if (!select || value === null || value === undefined) return value;
  const out: Record<string, unknown> = {};
  for (const [key, want] of Object.entries(select)) {
    if (want === true) out[key] = (value as Record<string, unknown>)[key];
  }
  return out;
}

interface Updated {
  where: { id: string };
  data: { styleProfile?: unknown; styleProfileComputedAt?: Date };
}

let rows: ProjectRow[] = [];
let updates: Updated[] = [];
let findArgs: Array<{ where: Record<string, unknown>; select?: Select }> = [];
let updateThrows: Error | null = null;

function installPrisma(): void {
  h.prisma.project = {
    findFirst: (args: { where: Record<string, unknown>; select?: Select }) => {
      findArgs.push(args);
      const found = rows.find(
        (row) => row.id === args.where.id && row.orgId === args.where.orgId,
      );
      return Promise.resolve(found ? applySelect(found, args.select) : null);
    },
    update: (args: Updated) => {
      if (updateThrows) throw updateThrows;
      updates.push(args);
      const row = rows.find((candidate) => candidate.id === args.where.id);
      if (!row) throw new Error('update of a row that does not exist');
      if ('styleProfile' in args.data) row.styleProfile = args.data.styleProfile;
      if (args.data.styleProfileComputedAt) {
        row.styleProfileComputedAt = args.data.styleProfileComputedAt;
      }
      return Promise.resolve(row);
    },
  };
}

beforeEach(() => {
  h.log = [];
  h.queueAdds = [];
  h.addThrows = null;
  rows = [projectRow()];
  updates = [];
  findArgs = [];
  updateThrows = null;
  installPrisma();
});

/** A Playwright spec in the house style these fixtures establish. */
function playwrightSpec(name: string): string {
  return [
    "import { test, expect } from '@playwright/test';",
    '',
    `test.describe('${name}', () => {`,
    '  test.beforeEach(async ({ page }) => {',
    "    await page.goto('/');",
    '  });',
    '',
    `  test('${name} works', async ({ page }) => {`,
    "    await page.getByRole('button', { name: 'Submit' }).click();",
    "    await expect(page.getByText('Done')).toBeVisible();",
    '  });',
    '});',
    '',
  ].join('\n');
}

function playwrightRepo(count: number): Record<string, string> {
  const files: Record<string, string> = { 'playwright.config.ts': 'export default {};\n' };
  for (let index = 0; index < count; index += 1) {
    files[`tests/e2e/feature-${index}.spec.ts`] = playwrightSpec(`feature ${index}`);
  }
  return files;
}

/** An `open` that hands the learner a Map, and records that it was closed. */
function opened(
  files: Record<string, string | null>,
  over: Partial<{ directoriesRefused: number; linksRefused: number }> = {},
): {
  open: NonNullable<Parameters<typeof processStyleProfile>[1]>['open'];
  source: TestFileSource;
  closed: () => number;
} {
  let closes = 0;
  const source: TestFileSource = {
    list: () => Promise.resolve(Object.keys(files)),
    read: (path) => Promise.resolve(path in files ? files[path] ?? null : null),
  };
  return {
    source,
    open: () =>
      Promise.resolve({
        kind: 'ready',
        source,
        provenance: 'acme/shop@main',
        listing: {
          paths: Object.keys(files),
          directoriesRefused: over.directoriesRefused ?? 0,
          directoriesUnlistable: 0,
          linksRefused: over.linksRefused ?? 0,
          entriesOmitted: 0,
          directoriesTooDeep: 0,
        },
        close: () => {
          closes += 1;
          return Promise.resolve();
        },
      } satisfies OpenedTestFiles),
    closed: () => closes,
  };
}

const job = (over: Partial<StyleProfileJob> = {}): StyleProfileJob => ({
  orgId: 'org_1',
  projectId: 'proj_1',
  reason: 'generate',
  ...over,
});

// ─── Closed vocabularies ─────────────────────────────────────────────────────

describe('the closed vocabularies', () => {
  /*
   * The compile-time half is `satisfies Record<StyleProfileOutcomeKind, string>`
   * on the record. This is the run-time half: a member added to the list and
   * forgotten in the record would be `undefined` interpolated into the sentence
   * an operator reads.
   *
   * THERE IS NO ZOD PARITY TEST HERE AND THE MODULE SAYS WHY: nothing stores
   * this union, so a schema would exist only to be tested. Saying that is the
   * point — the previous round shipped a parity test whose `.options` was
   * DERIVED from the same array, which could not disagree and read as though it
   * were checking something.
   */
  it('gives every outcome a sentence, and no outcome a sentence it does not have', () => {
    expect(Object.keys(STYLE_PROFILE_OUTCOME_WHY).sort()).toEqual([...STYLE_PROFILE_OUTCOMES].sort());
    for (const kind of STYLE_PROFILE_OUTCOMES) {
      expect(STYLE_PROFILE_OUTCOME_WHY[kind].length).toBeGreaterThan(0);
    }
    // The two that store nothing have to SAY they store nothing: the sentence
    // is the only place an operator learns that the column was left alone.
    expect(STYLE_PROFILE_OUTCOME_WHY.UNAVAILABLE).toContain('NOTHING was stored');
    expect(STYLE_PROFILE_OUTCOME_WHY.REFUSED).toContain('NOTHING was stored');
  });

  it('names a reason for every trigger it has', () => {
    expect([...STYLE_PROFILE_REASONS]).toEqual(['generate', 'source-analysis', 'requested']);
  });
});

// ─── The producer ────────────────────────────────────────────────────────────

describe('the producer, whose job id is a Redis key', () => {
  it('coalesces by project and sets BOTH removals', async () => {
    await enqueueStyleProfile(job());
    await enqueueStyleProfile(job({ reason: 'source-analysis' }));

    expect(h.queueAdds).toHaveLength(2);
    for (const add of h.queueAdds) {
      expect(add.queue).toBe(STYLE_PROFILE_QUEUE);
      expect(add.opts.jobId).toBe('style-profile-proj_1');
      expect(add.opts.delay).toBe(STYLE_PROFILE_WINDOW_MS);
      expect(add.opts.attempts).toBe(STYLE_PROFILE_ATTEMPTS);
      /*
       * BOTH, and neither is housekeeping. A retained completed — or worse,
       * FAILED — job holds the job id, so every later add() for this project
       * collapses onto the corpse and returns a Job carrying the new data with
       * nothing enqueued. "One computation per project in flight" would become
       * "one per project EVER", freezing the repository's conventions at
       * whatever they were the first time anybody generated a test.
       */
      expect(add.opts.removeOnComplete).toBe(true);
      expect(add.opts.removeOnFail).toBe(true);
    }
    await closeStyleProfileQueue();
  });

  it('keeps two projects apart, because one key per project is the whole mechanism', () => {
    expect(styleProfileJobId('proj_1')).not.toBe(styleProfileJobId('proj_2'));
    // And the REASON is deliberately not in the key: a generate finishing and an
    // analysis landing share nothing except the project they are both about.
    expect(styleProfileJobOptions('proj_1').jobId).toBe('style-profile-proj_1');
  });

  it('never throws, because every caller is a finally block around somebody else job', async () => {
    h.addThrows = new Error('redis is gone');
    const asked = await requestStyleProfile(job());

    expect(asked).toBeNull();
    const complaint = h.log.find((entry) => entry.level === 'error');
    expect(complaint?.msg).toContain('could not request a house-style profile');
    // The stored profile is left alone and the message says so, rather than
    // implying the project now has none.
    expect(complaint?.msg).toContain('stays as it is');
    await closeStyleProfileQueue();
  });
});

// ─── Freshness ───────────────────────────────────────────────────────────────

describe('what stale means, and the pair that has to agree', () => {
  it('believes a profile inside the window and recomputes one outside it', () => {
    const profile = { filesRead: 1 };
    expect(
      styleProfileIsFresh(
        { styleProfile: profile, styleProfileComputedAt: new Date(NOW.getTime() - 60_000) },
        NOW,
      ),
    ).toBe(true);
    expect(
      styleProfileIsFresh(
        {
          styleProfile: profile,
          styleProfileComputedAt: new Date(NOW.getTime() - STYLE_PROFILE_FRESH_MS),
        },
        NOW,
      ),
    ).toBe(false);
  });

  /*
   * THE PAIR, NOT THE DATE. The column's schema comment says
   * `styleProfileComputedAt` is NULL exactly when `styleProfile` is NULL. A row
   * where one is set and the other is not is drift, and `readStyleProfile`
   * refuses such a row outright — so calling it fresh would leave the project
   * permanently profile-less while this job kept reporting it up to date.
   */
  it.each([
    ['a blob with no date', { styleProfile: { filesRead: 1 }, styleProfileComputedAt: null }],
    ['a date with no blob', { styleProfile: null, styleProfileComputedAt: NOW }],
  ])('recomputes %s rather than trusting half a pair', (_what, row) => {
    expect(styleProfileIsFresh(row, NOW)).toBe(false);
  });

  it('skips the download for a fresh project and leaves the row untouched', async () => {
    rows = [
      projectRow({
        styleProfile: { filesRead: 4 },
        styleProfileComputedAt: new Date(NOW.getTime() - 60_000),
      }),
    ];
    const seam = opened(playwrightRepo(4));

    const outcome = await processStyleProfile(job(), { open: seam.open, now: () => NOW });

    expect(outcome.kind).toBe('FRESH');
    expect(outcome.profile).toBeNull();
    expect(updates).toEqual([]);
    // Nothing was opened, which is the cost this branch exists to avoid.
    expect(seam.closed()).toBe(0);
  });

  it('honours force by recomputing a profile that was still fresh', async () => {
    rows = [
      projectRow({
        styleProfile: { filesRead: 4 },
        styleProfileComputedAt: new Date(NOW.getTime() - 60_000),
      }),
    ];
    const seam = opened(playwrightRepo(4));

    const outcome = await processStyleProfile(job({ force: true }), {
      open: seam.open,
      now: () => NOW,
    });

    expect(outcome.kind).toBe('STORED');
    expect(updates).toHaveLength(1);
  });
});

// ─── The write ───────────────────────────────────────────────────────────────

describe('the write, which three rounds of readers were waiting for', () => {
  it('stores a profile and its date in ONE update', async () => {
    const seam = opened(playwrightRepo(8));
    const outcome = await processStyleProfile(job(), { open: seam.open, now: () => NOW });

    expect(outcome.kind).toBe('STORED');
    expect(updates).toHaveLength(1);
    const [update] = updates;
    expect(update?.where).toEqual({ id: 'proj_1' });
    /*
     * BOTH COLUMNS IN ONE UPDATE. `readStyleProfile` cross-checks the pair and
     * refuses a profile with no date, so two updates could leave exactly that
     * row behind if the second failed — and the project would then be
     * permanently profile-less with a review flag blaming its stored data.
     */
    expect(update?.data.styleProfileComputedAt).toEqual(NOW);
    expect(update?.data.styleProfile).toBeTruthy();
    expect(seam.closed()).toBe(1);
  });

  /*
   * THE PRODUCER ENDS AT THE VALIDATOR THE READ PATH RUNS. A test that asserts
   * a value's spelling does not assert that the value can be STORED, and eight
   * producer-versus-validator disagreements in this repository were found one at
   * a time. So the bytes that went into the column are pushed back through the
   * same schema `readStyleProfile` uses.
   */
  it('stores exactly what the read path will accept', async () => {
    const seam = opened(playwrightRepo(8));
    await processStyleProfile(job(), { open: seam.open, now: () => NOW });

    const stored = updates[0]?.data.styleProfile;
    expect(() => styleProfileSchema.parse(stored)).not.toThrow();
    // And it is the real measurement, not a placeholder: eight Playwright specs
    // in one directory establish a layout and a runner.
    const parsed = styleProfileSchema.parse(stored);
    expect(parsed.filesRead).toBe(8);
    expect(parsed.runner.value).toBe('playwright');
    expect(parsed.fileLayout.value?.root).toBe('tests/e2e');
  });

  it('writes nothing at all for a repository it could not materialise', async () => {
    const outcome = await processStyleProfile(job(), {
      now: () => NOW,
      open: () =>
        Promise.resolve({
          kind: 'unavailable',
          why: 'This project has no connected repository.',
        } satisfies OpenedTestFiles),
    });

    expect(outcome.kind).toBe('UNAVAILABLE');
    expect(outcome.profile).toBeNull();
    /*
     * NOT an empty profile. `emptyStyleProfile` in this column reports UNKNOWN
     * for every field with `filesRead: 0`, which is what an actual scan of
     * nothing produces — storing it here would claim we read the repository and
     * found no conventions, when we never opened it. NULL is "nobody has
     * measured this", and that is the true statement.
     */
    expect(updates).toEqual([]);
    expect(rows[0]?.styleProfile).toBeNull();
    expect(rows[0]?.styleProfileComputedAt).toBeNull();
    const warned = h.log.find((entry) => entry.level === 'warn');
    expect(warned?.msg).toContain('NOTHING was stored');
    expect(warned?.msg).toContain('no connected repository');
  });

  /*
   * THE REFUSAL BRANCH, EXERCISED AGAINST THE REAL SCHEMA.
   *
   * The real `learnStyle` cannot produce a profile `styleProfileSchema`
   * refuses, which is why `StyleProfileDeps.learn` is a seam: without it this
   * guard would be code with no test, and a guard with no test is how a
   * producer-versus-validator disagreement ships. The injected profile differs
   * from a real one in exactly one field — a helper NAME with a space in it,
   * which `repositoryHelperSchema` refuses because a helper name is
   * interpolated into generated code.
   */
  it('refuses to store a profile the read path would reject, and names the FIELD not the value', async () => {
    const seam = opened(playwrightRepo(4));
    const real = await learnStyle(seam.source);
    const outcome = await processStyleProfile(job(), {
      open: seam.open,
      now: () => NOW,
      learn: () =>
        Promise.resolve({
          ...real,
          profile: {
            ...real.profile,
            helpers: [
              {
                name: 'login as member',
                path: 'tests/helpers/auth.ts',
                signature: 'login as member(page)',
                usedInFiles: 4,
              },
            ],
          },
        }),
    });

    expect(outcome.kind).toBe('REFUSED');
    expect(outcome.profile).toBeNull();
    // NOTHING WAS STORED. A profile the read path refuses turns into a review
    // flag on every test in the next batch blaming the stored data, so storing
    // one converts this producer's bug into an accusation.
    expect(updates).toEqual([]);

    const complaint = h.log.find((entry) => entry.level === 'error');
    expect(complaint?.msg).toContain('NOTHING was stored');
    // THE PATH, NEVER THE VALUE. Every leaf of this document is
    // customer-authored, and zod puts the offending value in `message` for
    // several of its checks.
    expect(complaint?.msg).toContain('helpers');
    /*
     * MEASURED, NOT FEARED. `styleProfileProblems` reports a bad helper under
     * the field `helpers.<the helper's own name>`, so a describer that simply
     * joined `issue.path` put a customer identifier in the line an operator
     * reads — which is what this assertion failed on before the describer
     * clipped each path to its first segment and whitelisted it.
     */
    expect(complaint?.msg).not.toContain('login as member');
    expect(complaint?.msg).not.toContain('login');
  });

  it('throws for a project that is not in this org, because that is drift an operator must see', async () => {
    await expect(
      processStyleProfile(job({ orgId: 'org_2' }), { open: opened({}).open, now: () => NOW }),
    ).rejects.toThrow('not found for org org_2');
    expect(updates).toEqual([]);
  });

  it('asks the database for the columns it reads and nothing else', async () => {
    const seam = opened(playwrightRepo(2));
    await processStyleProfile(job(), { open: seam.open, now: () => NOW });

    const [asked] = findArgs;
    expect(asked?.where).toEqual({ id: 'proj_1', orgId: 'org_1' });
    expect(Object.keys(asked?.select ?? {}).sort()).toEqual([
      'defaultBranch',
      'id',
      'repoFullName',
      'repoInstallationId',
      'styleProfile',
      'styleProfileComputedAt',
    ]);
  });

  it('closes the workspace even when the write fails, because it is half a gigabyte', async () => {
    const seam = opened(playwrightRepo(2));
    updateThrows = new Error('postgres went away');

    await expect(
      processStyleProfile(job(), { open: seam.open, now: () => NOW }),
    ).rejects.toThrow('postgres went away');
    // The `finally` is what makes a throw above cost disk rather than leak it.
    expect(seam.closed()).toBe(1);
  });
});

// ─── The honest sentence ─────────────────────────────────────────────────────

describe('the sentence an operator reads, where the reason must be the one that bit', () => {
  it('names the configuration when the files themselves never named a runner', async () => {
    const files: Record<string, string> = { 'conftest.py': 'import pytest\n' };
    for (let index = 0; index < 5; index += 1) {
      files[`tests/test_feature_${index}.py`] =
        `import pytest\n\ndef test_feature_${index}():\n    assert True\n`;
    }
    const seam = opened(files);

    const outcome = await processStyleProfile(job(), { open: seam.open, now: () => NOW });
    expect(outcome.kind).toBe('STORED');
    expect(outcome.learned).not.toBeNull();

    const sentence = styleProfileSentence(outcome.learned!, outcome.listing!);
    expect(sentence).toContain('the runner is pytest');
    // THE MISSING CLAUSE. All six votes came from conftest.py, not from the
    // files' own imports, and a sentence that said "6 of 6 files" without this
    // would be true and misleading.
    expect(sentence).toContain("repository's own configuration rather than by their own imports");
  });

  it('says the files named it themselves when they did', async () => {
    const seam = opened(playwrightRepo(6));
    const outcome = await processStyleProfile(job(), { open: seam.open, now: () => NOW });

    const sentence = styleProfileSentence(outcome.learned!, outcome.listing!);
    expect(sentence).toContain("the runner is playwright, from the files' own imports");
    expect(sentence).not.toContain('own configuration rather than');
  });

  it('emits a clause for each cap that bit and no clause for one that did not', async () => {
    const seam = opened(
      {
        'node_modules/@acme/suite/tests/cart.spec.ts': playwrightSpec('cart'),
        ...playwrightRepo(3),
      },
      { directoriesRefused: 1, linksRefused: 2 },
    );
    const outcome = await processStyleProfile(job(), { open: seam.open, now: () => NOW });
    const sentence = styleProfileSentence(outcome.learned!, outcome.listing!);

    expect(sentence).toContain('1 path(s) were not read because FORBIDDEN_DIRECTORY');
    expect(sentence).toContain('2 link or device entry(ies) were refused');
    // Neither cap was touched, so neither is mentioned — a reader told a cap bit
    // raises it and sees no change.
    expect(sentence).not.toContain('walk cap');
    expect(sentence).not.toContain('could not be listed');
  });

  it('reports a runner nobody established as null rather than as zero', async () => {
    const seam = opened({
      'tests/a.spec.ts': "test('a', () => {});\n",
      'tests/b.spec.ts': "test('b', () => {});\n",
    });
    const outcome = await processStyleProfile(job(), { open: seam.open, now: () => NOW });
    const facts = styleProfileFacts(outcome.learned!, outcome.listing!);

    expect(facts.runner).toBeNull();
    /*
     * NULL AND NEVER 0. `runnerFromRepository: 0` beside a null runner reads as
     * "every vote was the file's own", which is the most flattering possible
     * reading of a field nobody established.
     */
    expect(facts.runnerFromRepository).toBeNull();
    expect(facts.filesRead).toBe(2);
  });
});

// ─── The walk ────────────────────────────────────────────────────────────────

/**
 * A tree over a flat map of directory to entries. `null` means "could not be
 * listed", which is NOT an empty directory.
 */
function tree(dirs: Record<string, readonly RepoTreeEntry[] | null>): RepoTree {
  /*
   * `directory in dirs` and not `?? []`: a declared `null` means "could not be
   * listed", and `null ?? []` would turn it into an EMPTY DIRECTORY — the one
   * distinction the walk keeps apart. The fake made exactly that mistake and the
   * test below caught it.
   */
  return {
    entries: (directory) =>
      Promise.resolve(directory in dirs ? (dirs[directory] ?? null) : []),
  };
}

const file = (name: string): RepoTreeEntry => ({ name, kind: 'FILE' });
const dir = (name: string): RepoTreeEntry => ({ name, kind: 'DIRECTORY' });
const link = (name: string): RepoTreeEntry => ({ name, kind: 'OTHER' });

describe('the walk, whose refusals must appear in the profile and not only in a count', () => {
  it('lists a tree in one sorted order, whatever order the filesystem answered in', async () => {
    const listing = await walkRepoTree(
      tree({
        '': [dir('tests'), file('package.json')],
        tests: [file('zebra.spec.ts'), file('alpha.spec.ts'), dir('e2e')],
        'tests/e2e': [file('cart.spec.ts')],
      }),
    );

    expect(listing.paths).toEqual([
      'package.json',
      'tests/alpha.spec.ts',
      'tests/e2e/cart.spec.ts',
      'tests/zebra.spec.ts',
    ]);
  });

  /*
   * THE REFUSAL HAS TO SURVIVE INTO THE STORED PROFILE. Pruning `node_modules`
   * silently is correct for cost and wrong for honesty: a repository whose only
   * tests live in a refused directory would then be byte-identical, in the
   * stored row, to a repository with no tests. Offering the directory's OWN
   * path is what makes `learnStyle` refuse it for itself and record it in
   * `StyleProfile.filesSkipped` with its reason.
   */
  it('offers a refused directory as a path and does not descend into it', async () => {
    const listing = await walkRepoTree(
      tree({
        '': [dir('node_modules'), dir('tests'), dir('.github')],
        node_modules: [dir('.bin'), file('payload.spec.ts')],
        'node_modules/.bin': [file('payload.spec.ts')],
        '.github': [dir('workflows')],
        tests: [file('cart.spec.ts')],
      }),
    );

    expect(listing.paths).toEqual(['.github', 'node_modules', 'tests/cart.spec.ts']);
    expect(listing.directoriesRefused).toBe(2);
    // The descent never happened, so nothing under them is in the list.
    expect(listing.paths.some((path) => path.startsWith('node_modules/'))).toBe(false);
  });

  it('refuses a link rather than following it, and counts the refusal', async () => {
    const listing = await walkRepoTree(
      tree({
        '': [link('anywhere'), dir('tests')],
        tests: [file('cart.spec.ts'), link('fixtures.json')],
      }),
    );

    expect(listing.paths).toEqual(['tests/cart.spec.ts']);
    expect(listing.linksRefused).toBe(2);
    // `anywhere -> /` is the cheaper escape: a path with no `..` in it that is
    // inside the root by every string check and resolves outside it.
    expect(listing.paths).not.toContain('anywhere');
  });

  it('tells a directory it could not list from an empty one', async () => {
    const listing = await walkRepoTree(
      tree({ '': [dir('locked'), dir('empty')], locked: null, empty: [] }),
    );

    expect(listing.directoriesUnlistable).toBe(1);
    expect(listing.paths).toEqual([]);
  });

  it('stops at the depth cap and counts the directories it did not descend', async () => {
    const dirs: Record<string, readonly RepoTreeEntry[]> = {};
    let path = '';
    for (let depth = 0; depth <= MAX_TREE_DEPTH + 2; depth += 1) {
      dirs[path] = [dir('down'), file(`at-${depth}.spec.ts`)];
      path = path === '' ? 'down' : `${path}/down`;
    }

    const listing = await walkRepoTree(tree(dirs));
    expect(listing.directoriesTooDeep).toBe(1);
    expect(listing.paths).toHaveLength(MAX_TREE_DEPTH);
    // The cap is a cap, not a hang: the walk terminated.
    expect(listing.paths[0]).toBe('at-0.spec.ts');
  });

  it('stops at the entry cap and counts what it would not look at', async () => {
    const entries: RepoTreeEntry[] = [];
    for (let index = 0; index <= MAX_TREE_ENTRIES; index += 1) {
      entries.push(file(`f-${String(index).padStart(6, '0')}.spec.ts`));
    }

    const listing = await walkRepoTree(tree({ '': entries }));
    expect(listing.paths).toHaveLength(MAX_TREE_ENTRIES);
    expect(listing.entriesOmitted).toBe(1);
  });
});

/**
 * THE ONE ADAPTER, AGAINST A REAL FILESYSTEM.
 *
 * Everything above tests the walk through a fake, and a guard tested only
 * through a fake is a guard tested against its own assumptions —
 * lib/workspace.ts says exactly that, and its own symlink test is why the
 * reader's per-segment `lstat` exists at all. So the FILE / DIRECTORY / OTHER
 * mapping is checked against a real temp directory containing a real symlink.
 * No network, no fixtures committed: the tree is built and removed here.
 */
describe('nodeRepoTree, against a real directory', () => {
  it('maps a file, a directory and a symlink to the three kinds it has', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qaai-style-tree-'));
    try {
      await mkdir(join(root, 'tests'));
      await writeFile(join(root, 'tests', 'cart.spec.ts'), "test('cart', () => {});\n");
      await writeFile(join(root, 'package.json'), '{}\n');
      // `anywhere -> /` is the cheaper symlink escape: a path with no `..` in it
      // that is inside the root by every string check and resolves outside it.
      await symlink('/', join(root, 'anywhere'), 'dir');

      const entries = await nodeRepoTree(root).entries('');
      expect(entries).not.toBeNull();
      const byName = new Map((entries ?? []).map((entry) => [entry.name, entry.kind]));
      expect(byName.get('package.json')).toBe('FILE');
      expect(byName.get('tests')).toBe('DIRECTORY');
      expect(byName.get('anywhere')).toBe('OTHER');

      // And the walk therefore never offers it, which is the whole point.
      const listing = await walkRepoTree(nodeRepoTree(root));
      expect(listing.paths).toEqual(['package.json', 'tests/cart.spec.ts']);
      expect(listing.linksRefused).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /*
   * THE WHOLE ADAPTER, END TO END, ON A REAL DISK: the walk, the
   * symlink-refusing reader and the real `learnStyle` over a real checkout. The
   * tests above all hand the learner a Map, so this is the one that would catch
   * the two functions being wired to each other wrongly — a `read` that
   * resolved against the wrong root, or a `list` that offered paths the reader
   * then refused.
   */
  it('reads a real checkout into a real profile through openWorkspaceTestFiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qaai-style-repo-'));
    try {
      await mkdir(join(root, 'tests', 'e2e'), { recursive: true });
      await mkdir(join(root, 'node_modules', 'vendored'), { recursive: true });
      await writeFile(join(root, 'playwright.config.ts'), 'export default {};\n');
      // A planted config inside a directory QAAI never writes into. The walk
      // refuses the directory, so this never reaches the declared-runner pass.
      await writeFile(join(root, 'node_modules', 'vendored', 'cypress.config.ts'), 'export default {};\n');
      await symlink('/', join(root, 'anywhere'), 'dir');
      for (let index = 0; index < 6; index += 1) {
        await writeFile(
          join(root, 'tests', 'e2e', `checkout-step-${index}.spec.ts`),
          playwrightSpec(`checkout step ${index}`),
        );
      }

      const { source, listing } = await openWorkspaceTestFiles(root);
      const learned = await learnStyle(source);

      expect(listing.linksRefused).toBe(1);
      expect(listing.directoriesRefused).toBe(1);
      expect(learned.profile.filesRead).toBe(6);
      expect(learned.profile.runner.value).toBe('playwright');
      expect(learned.profile.fileLayout.value?.root).toBe('tests/e2e');
      expect(learned.profile.naming.value).toBe('KEBAB');
      // The vendored cypress config was offered as a DIRECTORY path and refused,
      // so it is a disclosed hole rather than this repository's declaration.
      expect(learned.repositoryRunner.declared).toEqual(['playwright']);
      expect(learned.repositoryRunner.pathsRefused).toBe(1);
      expect(
        learned.profile.filesSkipped.some((entry) => entry.reason.startsWith('FORBIDDEN_DIRECTORY')),
      ).toBe(true);
      expect(() => styleProfileSchema.parse(learned.profile)).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a directory that does not exist as unlistable rather than as empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qaai-style-tree-'));
    try {
      // Our hole, not a fact about the tree: `null`, which the walk counts
      // apart from an empty directory.
      expect(await nodeRepoTree(root).entries('nope')).toBeNull();
      await mkdir(join(root, 'empty'));
      expect(await nodeRepoTree(root).entries('empty')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
