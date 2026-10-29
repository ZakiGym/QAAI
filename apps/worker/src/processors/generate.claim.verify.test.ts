/**
 * ADVERSARIAL VERIFICATION, END TO END: can QAAI CLAIM a human's file?
 *
 * `refactor.adversarial.verify.test.ts` asks this of `resolveOwnership`, which
 * takes a ledger and a path and therefore has no parameter an attacker could
 * aim at. That is a true answer to a smaller question. The question with a
 * write at the end of it is about the PRODUCER of those rows — `ledgerRowsFor` —
 * and about what the row it produces then authorises.
 *
 * So this file joins the two halves with the REAL code on both ends: the real
 * `ledgerRowsFor` produces the row, and the real `replaceDecision` from
 * apps/api/src/lib/git.ts — the gate both of `pushRepo`'s passes go through —
 * consumes it. Lesson H: a test over a producer must end at the validator the
 * write path actually runs, and a test that asserts a value's SPELLING does not
 * assert what that value permits.
 *
 * ── WHAT CHANGED UNDER THIS FILE, AND WHY THE ASSERTIONS TIGHTENED ─────────
 *
 * It was written when `ledgerRowsFor` minted `QAAI_OWNED` from the generated set
 * ALONE, and its assertions pinned that: "earns a row at any generated-looking
 * path, and a write at none of them" was the honest two-part answer — naming was
 * enough to be CLAIMED and never enough to be OVERWRITTEN.
 *
 * The processor now opens a repository view once per batch and `ownershipClaims`
 * asks it per path, so the first half of that answer is no longer true WHEN
 * THERE IS A VIEW: a path occupied by a file QAAI has no row for earns no claim
 * at all. Both branches are asserted below, because both are live — a project
 * with no connected repository still generates, and its rows are still minted
 * unexamined and still permit nothing. The bound that made the blind row safe is
 * unchanged and is still what the second half of every case proves.
 *
 * Nothing here calls a model, a network or a git remote.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ledgerRowsFor, occupancyProbe, ownershipClaims, SHARED_ARTIFACT_ROLES } from './generate.js';
import type { RepoFileView } from './generate.js';
import { replaceDecision } from '../../../api/src/lib/git.js';
import type { DiskState } from '@qaai/agent';
import type { ArtifactSet } from '@qaai/shared';

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');

/** A one-spec set, the shape a generate job produces in production today. */
function setAt(path: string, content: string): ArtifactSet {
  return {
    artifacts: [
      {
        role: 'SPEC',
        path,
        content,
        disposition: 'NEW',
        ownership: 'QAAI_OWNED',
        imports: [],
        basedOnHash: null,
        why: 'generated from a plan item',
      },
    ],
    // Null and not 'typescript': nobody told this set a dialect.
    dialect: null,
  };
}

/**
 * The rows for one set, with NOTHING having looked at the repository.
 *
 * The default, and it is the shape a project with no connected repository
 * produces today — so these cases are not historical, they are the live
 * unexamined branch.
 */
function rowsFor(path: string, content: string, recordAsTheirs: readonly string[] = []) {
  return ledgerRowsFor({
    set: setAt(path, content),
    orgId: 'org_1',
    recordAsTheirs,
    projectId: 'proj_1',
    testId: 'test_1',
    sharedRoles: SHARED_ARTIFACT_ROLES,
  });
}

/**
 * A view that says one named path holds a file, and nothing else does.
 *
 * `null` for `content` means ABSENT, and the distinction is load-bearing rather
 * than a convenience: an EMPTY FILE is a file, so `''` must come back PRESENT.
 * A fake that collapsed the two would have made the "nothing is there" branch
 * untestable, which is how this helper's first version failed.
 */
function viewHolding(path: string, content: string | null): RepoFileView {
  return {
    diskStateAt: (asked): DiskState =>
      asked === path && content !== null ? { state: 'PRESENT', content } : { state: 'ABSENT' },
    filesUnder: () => [],
  };
}

/** The rows for one set, WITH the repository consulted at every path. */
function rowsSeeing(path: string, content: string, onDisk: string | null) {
  const set = setAt(path, content);
  return ledgerRowsFor({
    set,
    orgId: 'org_1',
    recordAsTheirs: [],
    projectId: 'proj_1',
    testId: 'test_1',
    sharedRoles: SHARED_ARTIFACT_ROLES,
    claims: ownershipClaims({ set, occupancy: occupancyProbe(viewHolding(path, onDisk)) }),
  });
}

/**
 * The row, handed to the gate the write path runs, against the bytes that are
 * actually at the path. This is the only question that matters.
 */
function mayReplace(row: { ownership: string; contentHash: string }, onBranch: string) {
  return replaceDecision({
    record: {
      verdict: row.ownership as 'QAAI_OWNED' | 'HUMAN_EDITED' | 'HUMAN_AUTHORED',
      contentHash: row.contentHash,
      imports: [],
    },
    branchBytes: onBranch,
    digest: sha256,
  });
}

const THEIRS = 'test("a person wrote this, months ago", () => { expect(total).toBe(42); });';
const OURS = 'test("checkout", async ({ page }) => { await expect(page).toHaveURL(/done/); });';

describe('the row a generate job mints for a path nothing examined', () => {
  /*
   * CONFIRMED, not re-derived: `generate.ownership.verify.test.ts` already
   * records that `ledgerRowsFor` has no parameter through which the repository
   * could be consulted. This asserts the one fact that decides whether that is
   * a hole or a note — what the row PERMITS.
   */
  it('still says QAAI_OWNED, and that is the half that is minted blind', () => {
    const [row] = rowsFor('e2e/checkout.spec.ts', OURS);
    expect(row?.ownership).toBe('QAAI_OWNED');
    // And the hash is of OUR bytes. Nothing was read from the repository.
    expect(row?.contentHash).toBe(sha256(OURS));
  });

  /*
   * AND WITH A VIEW IN HAND IT IS NOT MINTED AT ALL. The row records THEIRS,
   * which is the fix this file's warning was about — and the join still holds:
   * the verdict permits nothing, now for the stronger reason NOT_OURS rather
   * than the hash comparison.
   */
  it('records THEIRS instead when the repository was consulted and held their file', () => {
    const [row] = rowsSeeing('e2e/checkout.spec.ts', OURS, THEIRS);
    expect(row?.ownership).toBe('HUMAN_AUTHORED');
    expect(mayReplace(row!, THEIRS)).toEqual({ allowed: false, reason: 'NOT_OURS' });
    /*
     * THE NON-VACUOUS HALF. The refusal is not simply "every row refuses": the
     * same producer over the same path with NOTHING at it claims the path and
     * permits the write of its own bytes.
     */
    const [free] = rowsSeeing('e2e/checkout.spec.ts', OURS, null);
    expect(free?.ownership).toBe('QAAI_OWNED');
    expect(mayReplace(free!, OURS)).toEqual({ allowed: true, reason: null });
  });

  it('does NOT permit replacing the human bytes that are at that path', () => {
    const [row] = rowsFor('e2e/checkout.spec.ts', OURS);
    expect(row).toBeDefined();
    /*
     * THE JOIN. The verdict is ours and the gate still refuses, because
     * QAAI_OWNED means "QAAI wrote the bytes that are there" — which is what
     * `ARTIFACT_OWNERSHIPS` says it means — and the recorded hash is the only
     * thing that can carry that claim.
     */
    expect(mayReplace(row!, THEIRS)).toEqual({ allowed: false, reason: 'BYTES_DIVERGED' });
  });

  it('DOES permit replacing bytes that are the bytes it recorded', () => {
    // The non-vacuous half: a row minted blind is not inert, it is bounded.
    const [row] = rowsFor('e2e/checkout.spec.ts', OURS);
    expect(mayReplace(row!, OURS)).toEqual({ allowed: true, reason: null });
  });
});

describe('ownership cannot be transferred by how a file looks', () => {
  /*
   * ── ATTACK 1: NAME IT LIKE A GENERATED ONE ─────────────────────────────
   *
   * Stated precisely, because the honest answer has two parts. A human file
   * whose path is the one a plan item resolves to DOES get a ledger row, and
   * that row says QAAI_OWNED — the claim is minted from the path alone. What it
   * does not get is a permission: every one of these is refused against the
   * human's bytes. Naming is enough to be CLAIMED and never enough to be
   * OVERWRITTEN.
   */
  it('earns a row at any generated-looking path with no view, and a write at none of them', () => {
    const paths = [
      'e2e/checkout.spec.ts',
      'tests/generated/checkout.spec.ts',
      'qaai/tests/checkout.spec.ts',
      '.qaai/checkout.spec.ts',
      'tests/__generated__/cart.page.ts',
      'e2e/qaai-checkout.spec.ts',
      'tests/checkout.qaai.spec.ts',
    ];
    for (const path of paths) {
      const [row] = rowsFor(path, OURS);
      expect(row?.ownership).toBe('QAAI_OWNED');
      expect(mayReplace(row!, THEIRS)).toEqual({ allowed: false, reason: 'BYTES_DIVERGED' });
    }
  });

  /*
   * ── THE SAME ATTACK WITH THE VIEW OPEN, which is the tightening ────────
   *
   * Naming a human's file like a generated one no longer earns even the CLAIM.
   * Every one of these paths holds their bytes, the view says so, and the row
   * records theirs — so the refusal is NOT_OURS at the verdict rather than
   * BYTES_DIVERGED at the hash, and it would survive a future caller that
   * compared hashes wrongly.
   */
  it('earns no claim at all at those paths once the repository has been read', () => {
    const paths = [
      'e2e/checkout.spec.ts',
      'tests/generated/checkout.spec.ts',
      'qaai/tests/checkout.spec.ts',
      '.qaai/checkout.spec.ts',
      'tests/__generated__/cart.page.ts',
      'e2e/qaai-checkout.spec.ts',
      'tests/checkout.qaai.spec.ts',
    ];
    for (const path of paths) {
      const [row] = rowsSeeing(path, OURS, THEIRS);
      expect(row?.ownership).toBe('HUMAN_AUTHORED');
      expect(mayReplace(row!, THEIRS)).toEqual({ allowed: false, reason: 'NOT_OURS' });
    }
  });

  /*
   * ── ATTACK 2: PUT A QAAI HEADER COMMENT IN IT ──────────────────────────
   *
   * The bytes at the path are an input to WHETHER the path is occupied and to
   * nothing else: `ownershipClaims` reads `diskStateAt(path).state` and never
   * the content, and `replaceDecision` reads the content only through a digest
   * it compares against the recorded one. A header that says "Generated by
   * QAAI" changes the digest and therefore makes the refusal MORE certain, not
   * less — and with the view open it does not even reach that comparison,
   * because a file being there at all is what decides the verdict.
   */
  it('does not transfer by a QAAI header comment, in either direction', () => {
    const forged = `/* Generated by QAAI. ownership: QAAI_OWNED. */\n${THEIRS}`;
    const [row] = rowsFor('e2e/checkout.spec.ts', OURS);
    expect(mayReplace(row!, forged)).toEqual({ allowed: false, reason: 'BYTES_DIVERGED' });
    // And the row's own hash is not derivable from the file's content at all:
    // it is the digest of what the SET holds.
    expect(row?.contentHash).toBe(sha256(OURS));
    expect(row?.contentHash).not.toBe(sha256(forged));

    // With the view open the forged header does not even buy the claim.
    const [seen] = rowsSeeing('e2e/checkout.spec.ts', OURS, forged);
    expect(seen?.ownership).toBe('HUMAN_AUTHORED');
    expect(seen?.contentHash).toBe(sha256(OURS));
  });

  /*
   * ── ATTACK 3: PUT IT IN THE GENERATED DIRECTORY ────────────────────────
   *
   * A row is per PATH, so a sibling in a directory QAAI owns files in gets no
   * row at all from a generation that does not name it — and no row is
   * UNRECORDED, which is not writable.
   */
  it('does not transfer by sharing a directory with a file QAAI does own', () => {
    const rows = rowsFor('tests/generated/ours.spec.ts', OURS);
    expect(rows.map((row) => row.path)).toEqual(['tests/generated/ours.spec.ts']);
    // Their file, in the same directory, is named by nothing.
    expect(rows.some((row) => row.path === 'tests/generated/theirs.spec.ts')).toBe(false);
    expect(
      replaceDecision({
        record: { verdict: 'UNRECORDED', contentHash: null, imports: [] },
        branchBytes: THEIRS,
        digest: sha256,
      }),
    ).toEqual({ allowed: false, reason: 'NOT_OURS' });
  });

  /*
   * ── THE GOOD HALF, AND IT IS THE REASON THE PRODUCER IS NOT ALL BAD ────
   *
   * A human's page object a generated spec IMPORTS is recorded HUMAN_AUTHORED
   * on purpose, so "QAAI does not own this" is a FACT and not the absence of
   * one — and that row is the one state the unique constraint then protects
   * from a later generation at the same path.
   */
  it('records an imported human file as theirs, and that row permits nothing', () => {
    const rows = rowsFor('e2e/checkout.spec.ts', OURS, ['e2e/pages/cart.page.ts']);
    const theirs = rows.find((row) => row.path === 'e2e/pages/cart.page.ts');
    expect(theirs?.ownership).toBe('HUMAN_AUTHORED');
    expect(mayReplace(theirs!, 'export class CartPage {}')).toEqual({
      allowed: false,
      reason: 'NOT_OURS',
    });
  });
});
