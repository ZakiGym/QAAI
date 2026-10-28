/**
 * ADVERSARIAL VERIFICATION: a SHARED artifact with three dependent specs, and
 * the half-written branch that is the whole reason the round's rule 11 exists.
 *
 * `git.realtree.verify.test.ts` proves the per-path decision over real git
 * objects. This file is about the decision that no single path can make: a page
 * object whose method is renamed is ONE change across four files, and a sync
 * that applies three of them leaves the customer a suite that does not compile.
 * `pushRepo` takes a flat `RepoTree` with no notion of a set, so the question is
 * whether the ledger's own `imports` edges are enough to stop it.
 *
 * ── WHAT IS REAL AND WHAT IS NOT ───────────────────────────────────────────
 *
 * Only `fetch` and `push` are faked — the two calls that need a network.
 * `init`, `checkout`, `listFiles`, `add`, `remove` and `commit` are
 * isomorphic-git's own, and the before/after file lists are read out of real git
 * objects: `listFiles({ ref: 'HEAD' })` on the pre-existing commit, and the tree
 * of the commit `pushRepo` itself produced, walked with `readBlob` at `push`
 * time (the workspace is removed in a `finally`, so afterwards is too late).
 *
 * No network, no model, no `ANTHROPIC_API_KEY`.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { OwnershipVerdict } from '../../../../packages/shared/src/artifact-set.js';
import { SECRET_SHAPES } from '@qaai/shared';

/** Captured from inside the fake `push`: the real tree of the real commit. */
const captured = vi.hoisted(() => ({
  after: new Map<string, string>(),
  before: new Map<string, string>(),
  pushes: 0,
  seed: new Map<string, string>(),
  branchExists: true,
  /**
   * An extra step the fake `fetch` runs inside the workspace, for the one case
   * a map of path → bytes cannot express: a branch entry that is a SYMLINK.
   * Null for every other test.
   */
  seedExtra: null as null | ((dir: string) => Promise<void>),
}));

vi.mock('isomorphic-git/http/node', () => ({ default: {} }));

vi.mock('isomorphic-git', async (importOriginal) => {
  const actual = (await importOriginal<{ default: typeof import('isomorphic-git') }>()).default;
  const fsMod = (await import('node:fs')).default;
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');

  async function treeOf(dir: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const files = await actual
      .listFiles({ fs: fsMod, dir, ref: 'HEAD' })
      .catch(() => [] as string[]);
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
      fetch: async ({ dir }: { dir: string }) => {
        if (!captured.branchExists) throw new Error('no such ref');
        if (captured.seedExtra) await captured.seedExtra(dir);
        for (const [path, content] of captured.seed) {
          const target = join(dir, path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content, 'utf8');
          await actual.add({ fs: fsMod, dir, filepath: path });
        }
        await actual.commit({
          fs: fsMod,
          dir,
          message: 'the branch, as the team left it',
          author: { name: 'A Person', email: 'person@acme.test' },
        });
        captured.before = await treeOf(dir);
        return {} as never;
      },
      push: async ({ dir }: { dir: string }) => {
        captured.pushes += 1;
        captured.after = await treeOf(dir);
        return {} as never;
      },
    },
  };
});

const { pushRepo, replaceDecision } = await import('./git.js');

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');


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
  captured.seedExtra = null;
}

/** One ledger row, exactly the projection `ArtifactLedgerEntry` carries. */
interface Row {
  readonly verdict: OwnershipVerdict;
  /** The digest of the bytes QAAI WROTE — never of the bytes on the branch. */
  readonly ourBytes?: string;
  readonly imports?: readonly string[];
}

/**
 * The injected ledger reader.
 *
 * `contentHash` is the digest of `ourBytes`, which is what `ledgerRowsFor`
 * records: `digest(artifact.content)`. Deriving it from the branch instead
 * would make every test here agree with itself — the hash would match whatever
 * is there, including a human's file, and the gate it exercises would never
 * fire.
 */
function ledger(rows: Record<string, Row>) {
  return {
    digest: sha256,
    recordFor: (path: string) => {
      const row = rows[path];
      if (!row) return { verdict: 'UNRECORDED' as const, contentHash: null, imports: [] };
      return {
        verdict: row.verdict,
        contentHash: row.ourBytes === undefined ? null : sha256(row.ourBytes),
        imports: row.imports ?? [],
      };
    },
  };
}

// ── The fixture: one page object, three specs that call one of its methods ──

const PAGE = 'e2e/pages/cart.page.ts';
const SPEC_A = 'e2e/cart-add.spec.ts';
const SPEC_B = 'e2e/cart-remove.spec.ts';
const SPEC_C = 'e2e/cart-total.spec.ts';

const PAGE_V1 = [
  'export class CartPage {',
  '  async addToCart(sku: string) { await this.page.click(`[data-sku="${sku}"]`); }',
  '}',
].join('\n');

/** The rename. The CLASS is unchanged, so no EXPORT disappears — only a member. */
const PAGE_V2 = [
  'export class CartPage {',
  '  async addItem(sku: string) { await this.page.click(`[data-sku="${sku}"]`); }',
  '}',
].join('\n');

const specV1 = (name: string): string =>
  `import { CartPage } from './pages/cart.page';\ntest('${name}', async () => { await new CartPage().addToCart('sku-1'); });\n`;
const specV2 = (name: string): string =>
  `import { CartPage } from './pages/cart.page';\ntest('${name}', async () => { await new CartPage().addItem('sku-1'); });\n`;

describe('a page object renamed under three dependent specs', () => {
  /**
   * THE ATTACK. Two of the three specs are QAAI's own; the third was taken over
   * by a human in the repository, which produces no `TestVersion` and therefore
   * no HUMAN_EDITED flip — the ledger still says QAAI_OWNED and only the hash
   * disagrees. QAAI holds a new version of all four files.
   *
   * A per-path gate writes three of them. The branch then holds `addItem` in two
   * specs, `addToCart` in the third, and whichever page object won — a suite
   * that does not compile, committed atomically, attributed to nobody.
   */
  it('writes NONE of the four when one dependent is refused', async () => {
    reset({
      [PAGE]: PAGE_V1,
      [SPEC_A]: specV1('add'),
      [SPEC_B]: specV1('remove'),
      // Their version. Same path, bytes that are not ours.
      [SPEC_C]: `${specV1('total')}// a person added this assertion\n`,
    });

    const result = await pushRepo(
      new Map([
        [PAGE, PAGE_V2],
        [SPEC_A, specV2('add')],
        [SPEC_B, specV2('remove')],
        [SPEC_C, specV2('total')],
      ]),
      {
        ...OPTS,
        ownership: ledger({
          [PAGE]: { verdict: 'QAAI_OWNED', ourBytes: PAGE_V1 },
          [SPEC_A]: { verdict: 'QAAI_OWNED', ourBytes: specV1('add'), imports: [PAGE] },
          [SPEC_B]: { verdict: 'QAAI_OWNED', ourBytes: specV1('remove'), imports: [PAGE] },
          // The row still says ours; the hash is of OUR bytes, and the branch moved.
          [SPEC_C]: { verdict: 'QAAI_OWNED', ourBytes: specV1('total'), imports: [PAGE] },
        }),
      },
    );

    // The committed tree is byte-identical to the branch we started from.
    expect([...captured.after.entries()].sort()).toEqual([...captured.before.entries()].sort());
    expect(result.filesWritten).toBe(0);
    expect(result.refusedCount).toBe(4);

    const byPath = new Map(result.filesRefused.map((row) => [row.path, row]));
    // The human's file, refused on the bytes.
    expect(byPath.get(SPEC_C)?.reason).toBe('BYTES_DIVERGED');
    // The page object, withheld because a file that IMPORTS it was refused.
    expect(byPath.get(PAGE)?.reason).toBe('DEPENDENT_REFUSED');
    /*
     * And the two specs QAAI does own, withheld because the page object they
     * IMPORT was withheld. This is the direction a one-way rule misses: without
     * it, `addItem()` lands in two specs against a `CartPage` that still only
     * offers `addToCart()`.
     */
    expect(byPath.get(SPEC_A)?.reason).toBe('DEPENDENT_REFUSED');
    expect(byPath.get(SPEC_B)?.reason).toBe('DEPENDENT_REFUSED');
    // Still exactly one commit and one push: withholding is not an exception.
    expect(captured.pushes).toBe(1);
  });

  /**
   * THE NON-VACUOUS HALF. The same four files, the same rename, and the third
   * spec is QAAI's own and untouched — so the whole set lands, atomically, and
   * the branch holds a suite that compiles. Without this the test above would
   * pass for a `pushRepo` that had simply stopped writing.
   */
  it('writes ALL four when every member of the group is ours and unchanged', async () => {
    reset({
      [PAGE]: PAGE_V1,
      [SPEC_A]: specV1('add'),
      [SPEC_B]: specV1('remove'),
      [SPEC_C]: specV1('total'),
    });

    const result = await pushRepo(
      new Map([
        [PAGE, PAGE_V2],
        [SPEC_A, specV2('add')],
        [SPEC_B, specV2('remove')],
        [SPEC_C, specV2('total')],
      ]),
      {
        ...OPTS,
        ownership: ledger({
          [PAGE]: { verdict: 'QAAI_OWNED', ourBytes: PAGE_V1 },
          [SPEC_A]: { verdict: 'QAAI_OWNED', ourBytes: specV1('add'), imports: [PAGE] },
          [SPEC_B]: { verdict: 'QAAI_OWNED', ourBytes: specV1('remove'), imports: [PAGE] },
          [SPEC_C]: { verdict: 'QAAI_OWNED', ourBytes: specV1('total'), imports: [PAGE] },
        }),
      },
    );

    expect(result.filesWritten).toBe(4);
    expect(result.refusedCount).toBe(0);
    // The renamed member and all three callers of it, in the real tree.
    expect(captured.after.get(PAGE)).toBe(PAGE_V2);
    for (const spec of [SPEC_A, SPEC_B, SPEC_C]) {
      expect(captured.after.get(spec)).toContain('addItem');
      expect(captured.after.get(spec)).not.toContain('addToCart');
    }
  });

  /**
   * A REFUSAL TWO EDGES AWAY. A base page object the cart page imports, so the
   * chain is spec → cart page → base page. One round of the rule would withhold
   * the cart page and ship the base, leaving the branch with a changed base
   * class under an unchanged subclass.
   */
  it('withholds a file two import edges from the refusal', async () => {
    const BASE = 'e2e/pages/base.page.ts';
    reset({
      [BASE]: 'export class BasePage { async go() {} }',
      [PAGE]: PAGE_V1,
      // Theirs: the bytes are not the bytes we recorded.
      [SPEC_A]: `${specV1('add')}// their edit\n`,
    });

    const result = await pushRepo(
      new Map([
        [BASE, 'export class BasePage { async navigate() {} }'],
        [PAGE, PAGE_V2],
        [SPEC_A, specV2('add')],
      ]),
      {
        ...OPTS,
        ownership: ledger({
          [BASE]: { verdict: 'QAAI_OWNED', ourBytes: 'export class BasePage { async go() {} }' },
          [PAGE]: { verdict: 'QAAI_OWNED', ourBytes: PAGE_V1, imports: [BASE] },
          [SPEC_A]: { verdict: 'QAAI_OWNED', ourBytes: specV1('add'), imports: [PAGE] },
        }),
      },
    );

    expect(result.filesWritten).toBe(0);
    const byPath = new Map(result.filesRefused.map((row) => [row.path, row]));
    expect(byPath.get(SPEC_A)?.reason).toBe('BYTES_DIVERGED');
    expect(byPath.get(PAGE)?.reason).toBe('DEPENDENT_REFUSED');
    expect(byPath.get(BASE)?.reason).toBe('DEPENDENT_REFUSED');
    expect(captured.after.get(BASE)).toBe('export class BasePage { async go() {} }');
  });

  /**
   * THE RULE IS NOT "ANY REFUSAL ANYWHERE STOPS EVERYTHING". Two specs that
   * share a page object QAAI is NOT touching are not adjacent: nothing about
   * rewriting one can break the other, and withholding an unrelated update
   * because some other file is a human's would make the sync useless and would
   * be reported as a refusal nobody can act on.
   */
  it('does not withhold an update that shares only a file nobody is changing', async () => {
    reset({
      [PAGE]: PAGE_V1,
      [SPEC_A]: specV1('add'),
      [SPEC_C]: `${specV1('total')}// theirs\n`,
    });

    const result = await pushRepo(
      new Map([
        [SPEC_A, `${specV1('add')}// one more assertion from QAAI\n`],
        [SPEC_C, specV1('total')],
      ]),
      {
        ...OPTS,
        ownership: ledger({
          [PAGE]: { verdict: 'QAAI_OWNED', ourBytes: PAGE_V1 },
          [SPEC_A]: { verdict: 'QAAI_OWNED', ourBytes: specV1('add'), imports: [PAGE] },
          [SPEC_C]: { verdict: 'QAAI_OWNED', ourBytes: specV1('total'), imports: [PAGE] },
        }),
      },
    );

    expect(result.filesWritten).toBe(1);
    expect(captured.after.get(SPEC_A)).toContain('one more assertion');
    // Theirs is untouched, and the page object nobody changed is untouched.
    expect(captured.after.get(SPEC_C)).toContain('// theirs');
    expect(captured.after.get(PAGE)).toBe(PAGE_V1);
  });
});

describe('deleting a shared file out from under a spec that remains', () => {
  /**
   * The mirror of the rule above. QAAI drops the last spec it generated for the
   * cart page, so the page object leaves `buildRepoTree`'s output — but a
   * human's spec on the branch still imports it. `git remove` there leaves a
   * file importing nothing.
   */
  it('keeps the page object, because a file that imports it is staying', async () => {
    reset({
      [PAGE]: PAGE_V1,
      [SPEC_C]: `${specV1('total')}// theirs, and it imports the page object\n`,
    });

    const result = await pushRepo(new Map([[SPEC_A, specV1('add')]]), {
      ...OPTS,
      ownership: ledger({
        [PAGE]: { verdict: 'QAAI_OWNED', ourBytes: PAGE_V1 },
        // Theirs by record this time, so the refusal is NOT_OURS and the
        // deletion rule is the only thing that can save the page object.
        [SPEC_C]: { verdict: 'HUMAN_AUTHORED', ourBytes: '', imports: [PAGE] },
      }),
    });

    expect(result.filesDeleted).toEqual([]);
    const kept = new Map(result.filesKept.map((row) => [row.path, row]));
    expect(kept.get(PAGE)?.reason).toBe('DEPENDENT_REMAINS');
    expect(kept.get(SPEC_C)?.reason).toBe('NOT_OURS');
    expect(captured.after.get(PAGE)).toBe(PAGE_V1);
  });

  /**
   * And it DOES delete when the dependent goes with it, in the same push. Both
   * are ours and both are gone from our tree, so nothing is left importing
   * anything.
   */
  it('deletes both when the only dependent is deleted too', async () => {
    reset({ [PAGE]: PAGE_V1, [SPEC_A]: specV1('add') });

    const result = await pushRepo(new Map([['e2e/other.spec.ts', 'unrelated']]), {
      ...OPTS,
      ownership: ledger({
        [PAGE]: { verdict: 'QAAI_OWNED', ourBytes: PAGE_V1 },
        [SPEC_A]: { verdict: 'QAAI_OWNED', ourBytes: specV1('add'), imports: [PAGE] },
      }),
    });

    expect([...result.filesDeleted].sort()).toEqual([SPEC_A, PAGE].sort());
    expect([...captured.after.keys()]).toEqual(['e2e/other.spec.ts']);
  });
});

describe('the comparison that could not be made', () => {
  /**
   * UNAVAILABLE IS NEVER A PASS, and this is the branch a real git tree cannot
   * be made to produce — `checkout` materialises everything `listFiles` reports
   * — so it is asserted against the decision function directly rather than left
   * as a claim about an untested line.
   */
  it('refuses a QAAI_OWNED path whose branch bytes could not be read', () => {
    expect(
      replaceDecision({
        record: { verdict: 'QAAI_OWNED', contentHash: sha256('ours'), imports: [] },
        branchBytes: null,
        digest: sha256,
      }),
    ).toEqual({ allowed: false, reason: 'COMPARISON_UNAVAILABLE' });
  });

  it('refuses a QAAI_OWNED path with no recorded hash to compare against', () => {
    expect(
      replaceDecision({
        record: { verdict: 'QAAI_OWNED', contentHash: null, imports: [] },
        branchBytes: 'whatever is there',
        digest: sha256,
      }),
    ).toEqual({ allowed: false, reason: 'COMPARISON_UNAVAILABLE' });
  });

  it('does not treat an EMPTY file as unreadable, because empty is a value', () => {
    expect(
      replaceDecision({
        record: { verdict: 'QAAI_OWNED', contentHash: sha256(''), imports: [] },
        branchBytes: '',
        digest: sha256,
      }),
    ).toEqual({ allowed: true, reason: null });
  });
});

/*
 * ── A PATH WHOSE DIRECTORY COMPONENT IS A SYMLINK ON THE BRANCH ────────────
 *
 * `safeJoin` was `resolve(join(root, relPath))` compared against `root`: a
 * LEXICAL check, which answers "does this string stay inside the workspace" and
 * cannot answer "do the bytes". A directory component that is a SYMLINK is
 * invisible to it, and `checkout` recreates the symlinks the branch holds
 * because git stores one as a file mode and isomorphic-git honours it.
 *
 * Nothing untrusted chose the path here — `buildRepoTree` did — but the BRANCH
 * chose where it lands, and a branch is attacker-influenced in a real
 * deployment. The damage is to the container rather than to the customer's
 * repository, so this is not the register item; it is the same guard one layer
 * down, and it was open.
 */
describe('a directory component on the branch that is a symlink', () => {
  it('is refused rather than followed out of the workspace', async () => {
    const { mkdtemp, mkdir, symlink, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    // Somewhere a push has no business writing. Created and removed by the test.
    const outside = await mkdtemp(join(tmpdir(), 'qaai-outside-'));
    try {
      reset({});
      captured.seedExtra = async (dir: string): Promise<void> => {
        // A real symlink in the workspace, which is what mode 120000 becomes.
        await mkdir(join(dir, 'placeholder'), { recursive: true });
        await symlink(outside, join(dir, 'e2e'), 'dir');
      };

      await expect(
        pushRepo(new Map([['e2e/escaped.spec.ts', 'this must never leave the workspace']]), {
          ...OPTS,
          ownership: ledger({}),
        }),
      ).rejects.toThrow(/Refusing to write outside the repo workspace/);

      // And the bytes are not there, which is the assertion the message cannot make.
      const landed = await readFile(join(outside, 'escaped.spec.ts'), 'utf8').catch(() => null);
      expect(landed).toBeNull();
      // Nothing was pushed: the refusal aborts rather than committing a subset.
      expect(captured.pushes).toBe(0);
    } finally {
      captured.seedExtra = null;
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('still writes an ordinary nested path, so the guard did not refuse everything', async () => {
    /*
     * The non-vacuous half, and it is the one that matters on macOS: the
     * workspace is an `mkdtemp` under `/var/folders`, which is itself reached
     * through a `/private/var` symlink. A guard that compared a resolved path
     * against an unresolved root would refuse every path on this platform and
     * the test above would pass for the wrong reason.
     */
    reset({});
    const result = await pushRepo(new Map([['e2e/pages/deep/cart.page.ts', 'ok']]), {
      ...OPTS,
      ownership: ledger({}),
    });
    expect(result.filesCreated).toBe(1);
    expect(captured.after.get('e2e/pages/deep/cart.page.ts')).toBe('ok');
  });
});
