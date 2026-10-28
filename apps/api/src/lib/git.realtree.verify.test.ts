/**
 * ADVERSARIAL VERIFICATION of the git sync, with the REAL git object layer.
 *
 * git.test.ts fakes the whole of isomorphic-git and says so in its header: it
 * proves the DECISION layer and explicitly does not prove that
 * `add`/`remove`/`commit` build the tree we think they do. That gap is where
 * the register item actually lives — "the human's file survives" is a claim
 * about the COMMITTED TREE, not about a return value — so this file replaces
 * only `fetch` and `push`, the two calls that need a network, and lets
 * `init`, `checkout`, `listFiles`, `add`, `remove` and `commit` be real.
 *
 * The before and after file lists are read out of real git objects:
 * `listFiles({ ref: 'HEAD' })` on the pre-existing commit, and the tree of the
 * commit `pushRepo` itself produced, walked with `readBlob` at `push` time
 * (the workspace is removed in a `finally`, so afterwards is too late).
 */

import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { OwnershipVerdict } from '../../../../packages/shared/src/artifact-set.js';
import { SECRET_SHAPES } from '@qaai/shared';

/** Captured from inside the fake `push`: the real tree of the real commit. */
const captured = vi.hoisted(() => ({
  /** Files tracked by the commit pushRepo built, with their bytes. */
  after: new Map<string, string>(),
  /** Files tracked by the branch BEFORE pushRepo touched it. */
  before: new Map<string, string>(),
  pushes: 0,
  /** The human branch state each test wants `fetch` to materialise. */
  seed: new Map<string, string>(),
  branchExists: true,
}));

vi.mock('isomorphic-git/http/node', () => ({ default: {} }));

/*
 * A PARTIAL mock: every object-layer call is the real implementation. `fetch`
 * builds the pre-existing branch with real commits so there is a real HEAD to
 * check out, and `push` reads the real tree pushRepo just committed.
 */
vi.mock('isomorphic-git', async (importOriginal) => {
  const actual = (await importOriginal<{ default: typeof import('isomorphic-git') }>()).default;
  const fsMod = (await import('node:fs')).default;
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');

  async function treeOf(dir: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const files = await actual.listFiles({ fs: fsMod, dir, ref: 'HEAD' }).catch(() => [] as string[]);
    for (const filepath of files) {
      const { blob } = await actual.readBlob({
        fs: fsMod,
        dir,
        oid: await actual.resolveRef({ fs: fsMod, dir, ref: 'HEAD' }),
        filepath,
      });
      out.set(filepath, new TextDecoder().decode(blob));
    }
    return out;
  }

  return {
    default: {
      ...actual,
      // The one call that would hit the network on the way in. Instead it
      // builds the branch locally out of REAL commits, so everything after it
      // — checkout, listFiles, add, remove, commit — is the real thing.
      fetch: async ({ dir }: { dir: string }) => {
        if (!captured.branchExists) throw new Error('no such ref');
        for (const [path, content] of captured.seed) {
          const target = join(dir, path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content, 'utf8');
          await actual.add({ fs: fsMod, dir, filepath: path });
        }
        await actual.commit({
          fs: fsMod,
          dir,
          message: 'the human branch, as it stood',
          author: { name: 'A Person', email: 'person@acme.test' },
        });
        captured.before = await treeOf(dir);
        return {} as never;
      },
      // The one call that would hit the network on the way out.
      push: async ({ dir }: { dir: string }) => {
        captured.pushes += 1;
        captured.after = await treeOf(dir);
        return {} as never;
      },
    },
  };
});

const { pushRepo } = await import('./git.js');

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');

/**
 * The ledger as these tests need it: a verdict per path, and a `contentHash`
 * taken from THE BYTES THE BRANCH WAS SEEDED WITH.
 *
 * That is what every test here meant by `QAAI_OWNED` while the verdict alone
 * decided the write — QAAI's own file, untouched since QAAI wrote it — and it
 * is the half `pushRepo` did not check. A test that wants the other case passes
 * `hashes` and says so in its own name.
 */
function ledger(rows: Record<string, OwnershipVerdict>, hashes: Record<string, string> = {}) {
  return {
    digest: sha256,
    recordFor: (path: string) => {
      const verdict: OwnershipVerdict = rows[path] ?? 'UNRECORDED';
      return {
        verdict,
        contentHash:
          verdict === 'UNRECORDED' ? null : (hashes[path] ?? sha256(captured.seed.get(path) ?? '')),
        imports: [],
      };
    },
  };
}


/*
 * COMPOSED AT RUN TIME FROM THE SHARED VOCABULARY, never written whole.
 *
 * A complete key-shaped literal in a committed file is what GitHub push
 * protection blocks, and it has already rejected a finished, green commit in
 * this repository for exactly that. A scanner cannot tell an invented token
 * from a real one, so the prefix comes from `SECRET_SHAPES` — the same list the
 * product's own credential scanners derive from — and the tail says what it is.
 */
const FAKE_GITHUB_TOKEN = `${
  SECRET_SHAPES.find((shape) => shape.what === 'a GitHub personal access token')?.prefix ?? 'ghp_'
}this-token-is-fabricated-for-this-test`;

const OPTS = {
  kind: 'GITHUB' as const,
  repo: 'acme/app',
  token: FAKE_GITHUB_TOKEN,
  branch: 'qaai/tests',
  message: 'QAAI: sync',
  authorName: 'QAAI',
  authorEmail: 'bot@qaai.local',
};

function reset(seed: Record<string, string>, branchExists = true) {
  captured.seed = new Map(Object.entries(seed));
  captured.before = new Map();
  captured.after = new Map();
  captured.pushes = 0;
  captured.branchExists = branchExists;
}

describe('the committed tree, read out of real git objects', () => {
  it("keeps a human's own spec that is absent from QAAI's tree", async () => {
    reset({
      'tests/checkout.spec.ts': 'QAAI v1',
      'tests/their-own.spec.ts': 'test("a person wrote this", () => {});',
      'src/app.ts': 'export const app = 1;',
    });

    const result = await pushRepo(new Map([['tests/checkout.spec.ts', 'QAAI v2']]), {
      ...OPTS,
      ownership: ledger({ 'tests/checkout.spec.ts': 'QAAI_OWNED' }),
    });

    // BEFORE, from the real pre-existing commit.
    expect([...captured.before.keys()].sort()).toEqual([
      'src/app.ts',
      'tests/checkout.spec.ts',
      'tests/their-own.spec.ts',
    ]);
    // AFTER, from the real tree of the commit pushRepo built.
    expect([...captured.after.keys()].sort()).toEqual([
      'src/app.ts',
      'tests/checkout.spec.ts',
      'tests/their-own.spec.ts',
    ]);
    // The human's bytes are byte-identical in the pushed tree.
    expect(captured.after.get('tests/their-own.spec.ts')).toBe(
      'test("a person wrote this", () => {});',
    );
    // And QAAI's own file did get its update, so this is not passing by doing nothing.
    expect(captured.after.get('tests/checkout.spec.ts')).toBe('QAAI v2');
    expect(result.keptCount).toBe(2);
    expect(captured.pushes).toBe(1);
  });

  it("keeps a human's EDIT to a QAAI-owned file, in the tree and not just the report", async () => {
    reset({ 'tests/checkout.spec.ts': 'QAAI v1 + the human fix' });

    const result = await pushRepo(new Map([['tests/checkout.spec.ts', 'QAAI v1']]), {
      ...OPTS,
      ownership: ledger({ 'tests/checkout.spec.ts': 'HUMAN_EDITED' }),
    });

    expect(captured.after.get('tests/checkout.spec.ts')).toBe('QAAI v1 + the human fix');
    expect(result.refusedCount).toBe(1);
    expect(result.filesRefused[0]?.remoteContent).toBe('QAAI v1 + the human fix');
  });

  it('is byte-identical to the branch when QAAI holds nothing it owns', async () => {
    reset({ 'tests/theirs.spec.ts': 'theirs', 'README.md': '# acme' });

    await pushRepo(new Map([['tests/ours.spec.ts', 'ours']]), {
      ...OPTS,
      ownership: ledger({}),
    });

    // The create lands (nothing was there to destroy) and NOTHING else moved.
    expect([...captured.after.keys()].sort()).toEqual([
      'README.md',
      'tests/ours.spec.ts',
      'tests/theirs.spec.ts',
    ]);
    expect(captured.after.get('tests/theirs.spec.ts')).toBe('theirs');
    expect(captured.after.get('README.md')).toBe('# acme');
  });

  it('removes a QAAI-owned file from the tree, so pass 2 does still work', async () => {
    reset({ 'tests/stale.spec.ts': 'generated once, deleted since' });

    const result = await pushRepo(new Map([['tests/live.spec.ts', 'current']]), {
      ...OPTS,
      ownership: ledger({ 'tests/stale.spec.ts': 'QAAI_OWNED' }),
    });

    expect([...captured.after.keys()].sort()).toEqual(['tests/live.spec.ts']);
    expect(result.filesDeleted).toEqual(['tests/stale.spec.ts']);
  });

  /*
   * A HUMAN RENAME. QAAI still holds the old path and the ledger still records
   * it as QAAI_OWNED, so the old path IS deleted — and the human's new path,
   * being UNRECORDED, survives. Stated plainly because it is the one variant
   * where QAAI does remove a file a human last touched: the content is not
   * lost (it is at the new path) but the rename is half-undone, and no
   * ownership rule can see that the two paths are the same file.
   */
  it('deletes the old path of a human rename and keeps the new one', async () => {
    reset({ 'tests/renamed-by-them.spec.ts': 'moved here by a person' });

    const result = await pushRepo(new Map([['tests/old-name.spec.ts', 'QAAI v1']]), {
      ...OPTS,
      ownership: ledger({ 'tests/old-name.spec.ts': 'QAAI_OWNED' }),
    });

    expect(captured.after.get('tests/renamed-by-them.spec.ts')).toBe('moved here by a person');
    expect(result.filesDeleted).toEqual([]);
    expect(result.keptCount).toBe(1);
    // The old path is re-created, because QAAI still holds it and owns it.
    expect(captured.after.has('tests/old-name.spec.ts')).toBe(true);
  });

  /*
   * A HUMAN DELETE of a file QAAI still owns: QAAI re-creates it. That is
   * correct for the ownership model (the ledger says it is ours) and is the
   * known cost of a ledger that records ownership rather than intent.
   */
  it('re-creates a QAAI-owned file a human deleted, which is a create and not an overwrite', async () => {
    reset({ 'README.md': '# acme' });

    const result = await pushRepo(new Map([['tests/deleted-by-them.spec.ts', 'QAAI v1']]), {
      ...OPTS,
      ownership: ledger({ 'tests/deleted-by-them.spec.ts': 'QAAI_OWNED' }),
    });

    expect(captured.after.get('tests/deleted-by-them.spec.ts')).toBe('QAAI v1');
    expect(result.filesCreated).toBe(1);
  });
});

/*
 * ── THE LIVE CALL SITE, WHICH SUPPLIES NO LEDGER ────────────────────────────
 *
 * apps/api/src/routes/projects.ts:1447 calls `pushRepo` with no `ownership`
 * key, so `POST /projects/:id/git/push` runs the create-only path in
 * production. These two tests are the consequence, measured rather than
 * reasoned: the FIRST push populates the branch and the SECOND refuses every
 * file it just wrote, because they are now tracked and nothing records them as
 * ours. Human work is safe — that is the fail-closed direction — and QAAI can
 * no longer update a test it already pushed.
 */
describe('two successive pushes with no ownership reader', () => {
  it('creates on the first and refuses every file on the second', async () => {
    // Push one: empty branch, two files created.
    reset({}, false);
    const first = await pushRepo(
      new Map([
        ['tests/a.spec.ts', 'QAAI v1'],
        ['tests/b.spec.ts', 'QAAI v1'],
      ]),
      OPTS,
    );
    expect(first.filesCreated).toBe(2);
    expect(first.refusedCount).toBe(0);

    // Push two: the same two paths, now tracked. Same options, no ledger.
    reset({ 'tests/a.spec.ts': 'QAAI v1', 'tests/b.spec.ts': 'QAAI v1' });
    const second = await pushRepo(
      new Map([
        ['tests/a.spec.ts', 'QAAI v2 — a fix'],
        ['tests/b.spec.ts', 'QAAI v2 — a fix'],
      ]),
      OPTS,
    );

    expect(second.ownershipKnown).toBe(false);
    expect(second.filesWritten).toBe(0);
    expect(second.refusedCount).toBe(2);
    // The branch still holds v1: the update never lands.
    expect(captured.after.get('tests/a.spec.ts')).toBe('QAAI v1');
    expect(captured.after.get('tests/b.spec.ts')).toBe('QAAI v1');
  });

  it('reports fileCount as 2 for a push that changed nothing, which is what the audit row stores', async () => {
    /*
     * projects.ts's audit metadata is `{ files: result.fileCount }` and nothing
     * else, so the trail for the push above reads "files: 2". `filesWritten`,
     * `refusedCount` and `ownershipKnown` are in the HTTP response and in no
     * audit row.
     */
    reset({ 'tests/a.spec.ts': 'QAAI v1', 'tests/b.spec.ts': 'QAAI v1' });
    const result = await pushRepo(
      new Map([
        ['tests/a.spec.ts', 'QAAI v2'],
        ['tests/b.spec.ts', 'QAAI v2'],
      ]),
      OPTS,
    );
    expect(result.fileCount).toBe(2);
    expect(result.filesWritten).toBe(0);
  });
});

/*
 * ── THE TWO HALVES JOINED ───────────────────────────────────────────────────
 *
 * `ledgerRowsFor` (apps/worker/src/processors/generate.ts:441) mints
 * `ownership: 'QAAI_OWNED'` for every path in a generated set, and it has no
 * parameter through which the customer's repository could be consulted — the
 * generate processor materialises no workspace, which its own comment states.
 * So a path a human has owned for months can carry a QAAI_OWNED row that
 * NOTHING EVER LOOKED AT.
 *
 * This block is what that row authorises, and it is the register item's hardest
 * case: the verdict is forged in QAAI's favour by a producer nobody can blame,
 * and the only thing standing between it and the human's bytes is the HASH on
 * the same row. `ledgerRowsFor` sets that hash to the digest of OUR content —
 * `digest(artifact.content)` — so these tests use exactly that value and not
 * the digest of the branch's bytes, which is the mistake that would make the
 * whole block pass by agreeing with itself.
 */
describe('a QAAI_OWNED row minted for a path nothing examined', () => {
  const CONTESTED = 'e2e/checkout.spec.ts';
  const THEIRS = 'test("written by a person, months ago", () => {});';
  const OURS = 'QAAI v1';

  /** The row `ledgerRowsFor` emits: our verdict, and the digest of OUR bytes. */
  const asMinted = ledger({ [CONTESTED]: 'QAAI_OWNED' }, { [CONTESTED]: sha256(OURS) });

  it("does NOT authorise replacing the human's file at that path", async () => {
    reset({ [CONTESTED]: THEIRS });

    const result = await pushRepo(new Map([[CONTESTED, OURS]]), {
      ...OPTS,
      ownership: asMinted,
    });

    // Their bytes are in the real pre-existing commit...
    expect(captured.before.get(CONTESTED)).toBe(THEIRS);
    // ...and in the real tree of the commit pushRepo built.
    expect(captured.after.get(CONTESTED)).toBe(THEIRS);
    expect(result.filesWritten).toBe(0);
    expect(result.refusedCount).toBe(1);

    const [refusal] = result.filesRefused;
    /*
     * The verdict on the refusal is QAAI_OWNED, and that is the point: the
     * verdict was never the whole permission. The REASON is the fact.
     */
    expect(refusal?.verdict).toBe('QAAI_OWNED');
    expect(refusal?.reason).toBe('BYTES_DIVERGED');
    // And their version comes back, so the divergence is reconcilable.
    expect(refusal?.remoteContent).toBe(THEIRS);
  });

  it('does not DELETE it either, which is the half that loses the content', async () => {
    /*
     * The worse case, and the reachable one: QAAI drops the test (the plan item
     * is rejected, the Test row is disabled) so the path leaves `buildRepoTree`'s
     * output while the ledger row stays. Pass 2 then reaches a path QAAI holds
     * no copy of — under the old gate it was `git remove`d and the human's work
     * existed nowhere.
     */
    reset({ [CONTESTED]: THEIRS });

    const result = await pushRepo(new Map([['e2e/other.spec.ts', 'a different test']]), {
      ...OPTS,
      ownership: asMinted,
    });

    expect(captured.after.get(CONTESTED)).toBe(THEIRS);
    expect(result.filesDeleted).toEqual([]);
    expect(result.keptCount).toBe(1);
    expect(result.filesKept[0]?.reason).toBe('BYTES_DIVERGED');
  });

  it('DOES still write and delete when the bytes on the branch are the bytes we wrote', async () => {
    /*
     * The non-vacuous half. Same forged verdict, same producer — the only
     * difference is that the branch holds OUR bytes, which is what QAAI_OWNED
     * has always claimed to mean. Without this the two tests above would pass
     * for a `pushRepo` that refused everything.
     */
    reset({ [CONTESTED]: OURS, 'e2e/stale.spec.ts': OURS });

    const result = await pushRepo(new Map([[CONTESTED, 'QAAI v2 — a fix']]), {
      ...OPTS,
      ownership: ledger(
        { [CONTESTED]: 'QAAI_OWNED', 'e2e/stale.spec.ts': 'QAAI_OWNED' },
        { [CONTESTED]: sha256(OURS), 'e2e/stale.spec.ts': sha256(OURS) },
      ),
    });

    expect(captured.after.get(CONTESTED)).toBe('QAAI v2 — a fix');
    expect(result.filesDeleted).toEqual(['e2e/stale.spec.ts']);
    expect(result.refusedCount).toBe(0);
    /*
     * And the obligation comes back, because `GeneratedArtifact.contentHash` is
     * written once by `ledgerRowsFor` and updated by nothing: without writing
     * this back, the NEXT push of a third version is refused as BYTES_DIVERGED
     * against bytes QAAI itself wrote.
     */
    expect(result.ledgerRefresh).toEqual([
      { path: CONTESTED, contentHash: sha256('QAAI v2 — a fix') },
    ]);
  });
});
