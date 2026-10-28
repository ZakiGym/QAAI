/**
 * The git sync, and the one thing it must never do.
 *
 * `pushRepo` used to `git remove` every tracked file absent from the tree it
 * was handed, and to write every file in that tree over whatever was at the
 * path. Both INFER OWNERSHIP FROM ABSENCE, and the inference erases a human's
 * work in the same branch: their own test file is absent from QAAI's tree
 * because QAAI never had it. "Your tests are yours" is the promise, and that
 * made it false.
 *
 * So the first three tests in this file are the register item: a human-edited
 * file in the branch, and it survives — in the index, in the report, and on
 * disk. Everything after them is the honesty of the report: a refusal or a
 * budget that BIT, disclosed as a count AND a reason.
 *
 * ── WHY ISOMORPHIC-GIT IS FAKED AND WHAT THAT COSTS ─────────────────────────
 *
 * `pushRepo` fetches and pushes over HTTP, and no test in this repository
 * touches a network. The fake below models the four facts the decisions under
 * test actually read — what the branch tracks, what the branch holds at each
 * path, what was added to the index and what was removed from it — and nothing
 * else.
 *
 * What it does NOT prove, said plainly rather than left for a reader to assume:
 * that isomorphic-git's own `add`/`remove`/`commit` build the tree we think
 * they do. What it DOES prove is the whole decision layer, which is where the
 * defect was — and the assertions read the fake's index and its working tree
 * rather than this module's own return value, so a module that reported a
 * refusal and staged the file anyway would fail here.
 */

import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnershipVerdict } from '../../../../packages/shared/src/artifact-set.js';
import { SECRET_SHAPES } from '@qaai/shared';

/**
 * The fake git's whole state, in a `vi.hoisted` block.
 *
 * Hoisted because `vi.mock`'s factory is lifted above every import in this
 * file: a plain `const` declared in the module body is in the temporal dead
 * zone when the factory runs, which fails as "cannot access before
 * initialization" and reads like a bug in the module under test.
 *
 * `tracked` is what HEAD holds and `branch` is what it holds AT each path;
 * `added` and `removed` are the index operations the module asked for, in
 * order. The index is deliberately separate from the working tree on disk — a
 * module that wrote a file and forgot to stage it would push nothing, and
 * conflating the two would hide that.
 */
const state = vi.hoisted(() => ({
  tracked: [] as string[],
  branch: new Map<string, string>(),
  /** When false, `fetch` throws and the branch is treated as new. */
  branchExists: true,
  added: [] as string[],
  removed: [] as string[],
  commits: 0,
  pushes: 0,
  checkedOut: false,
  /**
   * The working tree as it stood at COMMIT time, captured from inside the fake.
   *
   * It has to be read there and not after `pushRepo` returns: the workspace is
   * removed in a `finally`, so a test that read the directory afterwards would
   * be asserting on an empty path and passing for the wrong reason.
   */
  onDiskAtCommit: new Map<string, string>(),
}));

vi.mock('isomorphic-git/http/node', () => ({ default: {} }));

vi.mock('isomorphic-git', async () => {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  return {
    default: {
      init: async () => {},
      addRemote: async () => {},
      fetch: async () => {
        if (!state.branchExists) throw new Error('no such ref');
      },
      checkout: async ({ dir }: { dir: string }) => {
        state.checkedOut = true;
        // What `git checkout` does: the branch's files land on disk. This is the
        // only reason `pushRepo` can read a refused path's remote bytes at all.
        for (const [path, content] of state.branch) {
          const target = join(dir, path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content, 'utf8');
        }
      },
      listFiles: async () => [...state.tracked],
      add: async ({ filepath }: { filepath: string }) => {
        state.added.push(filepath);
      },
      remove: async ({ filepath }: { filepath: string }) => {
        state.removed.push(filepath);
      },
      commit: async ({ dir }: { dir: string }) => {
        state.commits += 1;
        for (const path of new Set([...state.branch.keys(), ...state.tracked])) {
          const raw = await readFile(join(dir, path), 'utf8').catch(() => null);
          if (raw !== null) state.onDiskAtCommit.set(path, raw);
        }
        return 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
      },
      push: async () => {
        state.pushes += 1;
      },
    },
  };
});

const { pushRepo, mayQaaiReplace, MAX_PULLED_BACK_FILES, MAX_REPORTED_PATHS } = await import(
  './git.js'
);

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');

/**
 * A ledger over a plain record. Absence answers UNRECORDED, which is the point.
 *
 * `contentHash` is the digest of WHAT THE BRANCH CURRENTLY HOLDS, so a recorded
 * row agrees with the branch unless a test says otherwise. That is exactly what
 * every test below meant by `QAAI_OWNED` while the verdict alone decided the
 * write: QAAI's own file, untouched since QAAI wrote it. `hashes` is how a test
 * says the opposite — see the BYTES_DIVERGED cases.
 */
function ledger(rows: Record<string, OwnershipVerdict>, hashes: Record<string, string> = {}) {
  return {
    digest: sha256,
    recordFor: (path: string) => {
      const verdict: OwnershipVerdict = rows[path] ?? 'UNRECORDED';
      return {
        verdict,
        contentHash:
          verdict === 'UNRECORDED' ? null : (hashes[path] ?? sha256(state.branch.get(path) ?? '')),
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

beforeEach(() => {
  state.tracked = [];
  state.branch = new Map();
  state.branchExists = true;
  state.added = [];
  state.removed = [];
  state.commits = 0;
  state.pushes = 0;
  state.checkedOut = false;
  state.onDiskAtCommit = new Map();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a human-edited file in the branch', () => {
  /*
   * THE REGISTER ITEM. Under the old behaviour both halves of this failed: the
   * human's own file was `git remove`d because it was absent from the tree, and
   * the human's edit to a generated file was overwritten because it was present.
   */
  it('is never deleted, however absent it is from our tree', async () => {
    state.tracked = ['tests/checkout.spec.ts', 'tests/their-own.spec.ts'];
    /*
     * BOTH tracked paths are given branch bytes. A path `listFiles` reports and
     * `checkout` does not materialise is a state real git cannot produce, and
     * the decision under test now reads those bytes — so leaving one out would
     * exercise COMPARISON_UNAVAILABLE while claiming to exercise a QAAI-owned
     * replacement.
     */
    state.branch.set('tests/checkout.spec.ts', 'ours');
    state.branch.set('tests/their-own.spec.ts', 'test("written by a person", () => {});');

    const result = await pushRepo(new Map([['tests/checkout.spec.ts', 'ours']]), {
      ...OPTS,
      ownership: ledger({ 'tests/checkout.spec.ts': 'QAAI_OWNED' }),
    });

    expect(state.removed).toEqual([]);
    expect(result.filesDeleted).toEqual([]);
    expect(result.filesKept).toEqual([
      { path: 'tests/their-own.spec.ts', verdict: 'UNRECORDED', reason: 'NOT_OURS' },
    ]);
    expect(result.keptCount).toBe(1);
  });

  it('is never written over, and its own bytes come back', async () => {
    state.tracked = ['tests/checkout.spec.ts'];
    state.branch.set('tests/checkout.spec.ts', 'the human version, with their fix in it');

    const result = await pushRepo(
      new Map([['tests/checkout.spec.ts', 'the stale version out of our database']]),
      { ...OPTS, ownership: ledger({ 'tests/checkout.spec.ts': 'HUMAN_EDITED' }) },
    );

    // Nothing was staged, so no version of it can reach the branch.
    expect(state.added).toEqual([]);
    expect(result.filesWritten).toBe(0);
    expect(result.refusedCount).toBe(1);
    const [refusal] = result.filesRefused;
    expect(refusal?.verdict).toBe('HUMAN_EDITED');
    // The reconciliation channel: their version, not ours.
    expect(refusal?.remoteContent).toBe('the human version, with their fix in it');
    expect(refusal?.why).toMatch(/only ever propose/);
  });

  /*
   * The bytes ON DISK are the other half of "never written over". A module that
   * declined to stage a path but wrote the file anyway would leave our version
   * there for the next command to pick up, and the index assertion above would
   * not notice.
   */
  it('still holds the human bytes on disk when the commit is taken', async () => {
    state.tracked = ['tests/checkout.spec.ts'];
    state.branch.set('tests/checkout.spec.ts', 'HUMAN');

    await pushRepo(new Map([['tests/checkout.spec.ts', 'OURS']]), {
      ...OPTS,
      ownership: ledger({ 'tests/checkout.spec.ts': 'HUMAN_AUTHORED' }),
    });

    expect(state.commits).toBe(1);
    expect(state.onDiskAtCommit.get('tests/checkout.spec.ts')).toBe('HUMAN');
  });
});

describe('a file QAAI owns', () => {
  it('is replaced in place, and deleted when we no longer hold it', async () => {
    state.tracked = ['tests/a.spec.ts', 'tests/gone.spec.ts'];
    state.branch.set('tests/a.spec.ts', 'old');
    state.branch.set('tests/gone.spec.ts', 'old');

    const result = await pushRepo(new Map([['tests/a.spec.ts', 'new']]), {
      ...OPTS,
      ownership: ledger({ 'tests/a.spec.ts': 'QAAI_OWNED', 'tests/gone.spec.ts': 'QAAI_OWNED' }),
    });

    expect(state.added).toEqual(['tests/a.spec.ts']);
    expect(state.removed).toEqual(['tests/gone.spec.ts']);
    expect(state.onDiskAtCommit.get('tests/a.spec.ts')).toBe('new');
    expect(result.filesWritten).toBe(1);
    expect(result.filesCreated).toBe(0);
    expect(result.filesDeleted).toEqual(['tests/gone.spec.ts']);
    expect(result.refusedCount).toBe(0);
  });

  it('exactly one ownership verdict permits a replacement', () => {
    /*
     * The whole security argument as one assertion. `mayQaaiReplace` is this
     * file's only door to the permission and it delegates to the shared record,
     * so a fourth verdict added there cannot default to writable here.
     */
    expect(mayQaaiReplace('QAAI_OWNED')).toBe(true);
    expect(mayQaaiReplace('HUMAN_EDITED')).toBe(false);
    expect(mayQaaiReplace('HUMAN_AUTHORED')).toBe(false);
    expect(mayQaaiReplace('UNRECORDED')).toBe(false);
  });
});

describe('a path that is not on the branch', () => {
  /*
   * A CREATE needs no permission: there is nothing there to destroy, which is
   * the entire question the gate answers. Getting this wrong in the "safe"
   * direction would mean a project could never receive its first test.
   */
  it('is created without a ledger row, because nothing is being destroyed', async () => {
    state.tracked = ['README.md'];
    state.branch.set('README.md', '# their repo');

    const result = await pushRepo(new Map([['tests/new.spec.ts', 'fresh']]), {
      ...OPTS,
      ownership: ledger({}),
    });

    expect(state.added).toEqual(['tests/new.spec.ts']);
    expect(result.filesCreated).toBe(1);
    expect(result.filesWritten).toBe(1);
    // And their README, which we neither own nor hold, survives.
    expect(state.removed).toEqual([]);
    expect(result.keptCount).toBe(1);
  });

  it('is written on a branch that does not exist yet, and nothing is examined', async () => {
    state.branchExists = false;
    state.tracked = ['should-not-be-read.ts'];

    const result = await pushRepo(new Map([['tests/first.spec.ts', 'x']]), OPTS);

    expect(result.basedOnRemote).toBe(false);
    expect(state.checkedOut).toBe(false);
    expect(result.filesCreated).toBe(1);
    /*
     * The empty lists are reported alongside `basedOnRemote: false` precisely so
     * a reader cannot take them as evidence that a populated branch was examined
     * and found to agree.
     */
    expect(result.filesKept).toEqual([]);
    expect(result.refusedCount).toBe(0);
  });
});

describe('with no ownership reader at all', () => {
  /*
   * FAIL CLOSED, AND SAY SO. The old behaviour with no ledger was to overwrite
   * and delete everything; the new one creates what is missing, refuses the
   * rest, and reports `ownershipKnown: false` so a caller cannot read a
   * create-only sync as a full one.
   */
  it('deletes nothing, overwrites nothing, and reports that it did not know', async () => {
    state.tracked = ['tests/a.spec.ts', 'tests/theirs.spec.ts'];
    state.branch.set('tests/a.spec.ts', 'on the branch');
    state.branch.set('tests/theirs.spec.ts', 'theirs');

    const result = await pushRepo(
      new Map([
        ['tests/a.spec.ts', 'ours'],
        ['tests/b.spec.ts', 'ours'],
      ]),
      OPTS,
    );

    expect(result.ownershipKnown).toBe(false);
    expect(state.removed).toEqual([]);
    expect(state.added).toEqual(['tests/b.spec.ts']);
    expect(result.refusedCount).toBe(1);
    expect(result.filesRefused[0]?.verdict).toBe('UNRECORDED');
    expect(result.filesRefused[0]?.why).toMatch(/no recorded permission/);
    expect(result.keptCount).toBe(1);
  });

  it('still reports fileCount as the size of the intent, not of the change', async () => {
    /*
     * `fileCount` is the field the audit row and the HTTP response have always
     * carried, and it never meant "files changed". It is left alone and the
     * honest counts sit beside it — renaming it would have rewritten the meaning
     * of every historical audit row.
     */
    state.tracked = ['tests/a.spec.ts'];
    state.branch.set('tests/a.spec.ts', 'on the branch');

    const result = await pushRepo(new Map([['tests/a.spec.ts', 'ours']]), OPTS);

    expect(result.fileCount).toBe(1);
    expect(result.filesWritten).toBe(0);
  });
});

describe('the caps, each disclosed as a count', () => {
  it('names at most MAX_REPORTED_PATHS refusals and counts all of them', async () => {
    const tree = new Map<string, string>();
    for (let i = 0; i < MAX_REPORTED_PATHS + 7; i += 1) {
      const path = `tests/t${i}.spec.ts`;
      tree.set(path, 'ours');
      state.tracked.push(path);
      state.branch.set(path, 'theirs');
    }

    const result = await pushRepo(tree, { ...OPTS, ownership: ledger({}) });

    expect(result.refusedCount).toBe(MAX_REPORTED_PATHS + 7);
    expect(result.filesRefused).toHaveLength(MAX_REPORTED_PATHS);
  });

  it('counts the refusals whose remote bytes it did not read back', async () => {
    const tree = new Map<string, string>();
    for (let i = 0; i < MAX_PULLED_BACK_FILES + 3; i += 1) {
      const path = `tests/t${i}.spec.ts`;
      tree.set(path, 'ours');
      state.tracked.push(path);
      state.branch.set(path, 'theirs');
    }

    const result = await pushRepo(tree, { ...OPTS, ownership: ledger({}) });

    // A budget that bit, reported as a number rather than as a null that reads
    // like "the file was empty".
    expect(result.contentsOmitted).toBe(3);
    expect(result.filesRefused.filter((r) => r.remoteContent !== null)).toHaveLength(
      MAX_PULLED_BACK_FILES,
    );
    expect(result.filesRefused.filter((r) => r.remoteContent === null)).toHaveLength(3);
  });

  it('discloses a truncated remote file as a character count', async () => {
    state.tracked = ['tests/big.spec.ts'];
    state.branch.set('tests/big.spec.ts', 'x'.repeat(120_000));

    const result = await pushRepo(new Map([['tests/big.spec.ts', 'ours']]), {
      ...OPTS,
      ownership: ledger({}),
    });

    const [refusal] = result.filesRefused;
    expect(refusal?.remoteContent).toHaveLength(100_000);
    expect(refusal?.remoteTruncated).toBe(20_000);
  });
});

describe('the credential', () => {
  it('never reaches the remote URL', async () => {
    const result = await pushRepo(new Map([['tests/a.spec.ts', 'x']]), { ...OPTS, branch: 'main' });
    expect(result.repoUrl).toBe('https://github.com/acme/app.git');
    expect(result.repoUrl).not.toContain(OPTS.token);
  });
});

/*
 * A path-guard regression, kept because `safeJoin` is what stops a tree entry
 * from writing outside the workspace and BOTH passes now call it.
 */
describe('a path that escapes the workspace', () => {
  it('throws rather than writing outside it', async () => {
    await expect(pushRepo(new Map([['../../etc/passwd', 'x']]), OPTS)).rejects.toThrow(
      /outside the repo workspace/,
    );
  });
});
