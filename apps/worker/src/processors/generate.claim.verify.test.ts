/**
 * ADVERSARIAL VERIFICATION, END TO END: can QAAI CLAIM a human's file?
 *
 * `refactor.adversarial.verify.test.ts` asks this of `resolveOwnership`, which
 * takes a ledger and a path and therefore has no parameter an attacker could
 * aim at. That is a true answer to a smaller question. The question with a
 * write at the end of it is about the PRODUCER of those rows — `ledgerRowsFor`,
 * which mints `QAAI_OWNED` from the generated set alone — and about what the
 * row it produces then authorises.
 *
 * So this file joins the two halves with the REAL code on both ends: the real
 * `ledgerRowsFor` produces the row, and the real `replaceDecision` from
 * apps/api/src/lib/git.ts — the gate both of `pushRepo`'s passes go through —
 * consumes it. Lesson H: a test over a producer must end at the validator the
 * write path actually runs, and a test that asserts a value's SPELLING does not
 * assert what that value permits.
 *
 * Nothing here calls a model, a network or a git remote.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ledgerRowsFor, SHARED_ARTIFACT_ROLES } from './generate.js';
import { replaceDecision } from '../../../api/src/lib/git.js';
import type { ArtifactSet } from '../../../../packages/shared/src/artifact-set.js';

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
  it('earns a row at any generated-looking path, and a write at none of them', () => {
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
   * ── ATTACK 2: PUT A QAAI HEADER COMMENT IN IT ──────────────────────────
   *
   * There is no parameter to aim at: `ledgerRowsFor` is handed the SET and
   * never the repository, so the bytes at the path are not an input to the
   * claim — and `replaceDecision` reads them only through a digest it compares
   * against the recorded one. A header that says "Generated by QAAI" changes
   * the digest and therefore makes the refusal MORE certain, not less.
   */
  it('does not transfer by a QAAI header comment, in either direction', () => {
    const forged = `/* Generated by QAAI. ownership: QAAI_OWNED. */\n${THEIRS}`;
    const [row] = rowsFor('e2e/checkout.spec.ts', OURS);
    expect(mayReplace(row!, forged)).toEqual({ allowed: false, reason: 'BYTES_DIVERGED' });
    // And the row's own hash is not derivable from the file's content at all:
    // it is the digest of what the SET holds.
    expect(row?.contentHash).toBe(sha256(OURS));
    expect(row?.contentHash).not.toBe(sha256(forged));
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
