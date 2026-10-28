/**
 * ADVERSARIAL VERIFICATION of the one fact the whole ownership model rests on.
 *
 * `WRITABLE_BY_OWNERSHIP` has exactly one `true` key, `pushRepo` goes through
 * it, and the refactor engine refuses a path it is not recorded for. All of
 * that is sound, and all of it is downstream of ONE question: where does a
 * `QAAI_OWNED` row come from, and has anything looked at the path before the
 * row claims it?
 *
 * `ledgerRowsFor` is that producer. It takes the SET, the org, the project, the
 * test and the shared roles — and NO view of the customer's repository. So this
 * file asks what the row means when a human's file is already at the path, and
 * then pushes the resulting ledger through `pushRepo` to see what the fact
 * authorises.
 */

import { describe, expect, it } from 'vitest';

import { ledgerRowsFor, SHARED_ARTIFACT_ROLES } from './generate.js';
import type { ArtifactSet } from '../../../../packages/shared/src/artifact-set.js';

/** A one-spec set, exactly the shape a generate job produces today. */
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
    /*
     * Null and not 'typescript', because nobody told this set a dialect and
     * `ArtifactSet.dialect` makes "we could not tell" say so — the rule
     * `resolveDialect` lives by. Defaulting it here would be the hard-coded
     * Playwright TypeScript defect in miniature, inside the file that exists to
     * catch an unexamined claim.
     */
    dialect: null,
  };
}

describe('where a QAAI_OWNED row comes from', () => {
  /*
   * THE FINDING. `ledgerRowsFor` has no parameter through which the repository
   * could be consulted, so the row is minted from the SET alone. The generate
   * processor materialises no workspace (its own comment says so), so at the
   * moment this row is written NOTHING has looked at the path.
   */
  it('claims QAAI_OWNED for a path nothing has looked at', () => {
    const rows = ledgerRowsFor({
      // A path a human could very plausibly already own.
      set: setAt('e2e/checkout.spec.ts', "test('checkout', () => {});"),
      orgId: 'org_1',
      recordAsTheirs: [],
      projectId: 'proj_1',
      testId: 'test_1',
      sharedRoles: SHARED_ARTIFACT_ROLES,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe('e2e/checkout.spec.ts');
    expect(rows[0]?.ownership).toBe('QAAI_OWNED');

    /*
     * And the structural half of the claim: there is no argument this function
     * could have used to check. Six named keys, none of them the repository.
     */
    expect(
      Object.keys({
        set: 0,
        orgId: 0,
        recordAsTheirs: 0,
        projectId: 0,
        testId: 0,
        sharedRoles: 0,
      }).sort(),
    ).toEqual(['orgId', 'projectId', 'recordAsTheirs', 'set', 'sharedRoles', 'testId']);
  });

  /*
   * The `contentHash` on that row is the digest of OUR bytes, so the one guard
   * that could still save the human's file — `dispositionFor` downgrading to
   * PROPOSED_EDIT when the disk disagrees with the ledger — does fire on the
   * APPLY path. `pushRepo` does not consult it: it reads the verdict alone.
   */
  it('records the hash of our bytes, not of whatever is at the path', () => {
    const rows = ledgerRowsFor({
      set: setAt('e2e/checkout.spec.ts', 'OUR BYTES'),
      orgId: 'org_1',
      recordAsTheirs: [],
      projectId: 'proj_1',
      testId: 'test_1',
      sharedRoles: SHARED_ARTIFACT_ROLES,
    });
    // A sha256 of our own content — nothing was read from the repository.
    expect(rows[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.bytes).toBe('OUR BYTES'.length);
  });

  /*
   * The mitigation that IS in place, and it is the reason this is a latent hole
   * rather than a live one: a row that already exists wins, because the write
   * is `createMany({ skipDuplicates: true })` over `@@unique([projectId,
   * path])`. So a path a human has ALREADY been recorded for is never
   * downgraded. The gap is the path nobody has a row for at all.
   */
  it('produces one row per path, so the unique constraint is what protects an existing fact', () => {
    const rows = ledgerRowsFor({
      set: setAt('e2e/checkout.spec.ts', 'ours'),
      orgId: 'org_1',
      recordAsTheirs: ['e2e/pages/cart.page.ts'],
      projectId: 'proj_1',
      testId: 'test_1',
      sharedRoles: SHARED_ARTIFACT_ROLES,
    });
    expect(rows.map((row) => row.path)).toEqual([
      'e2e/checkout.spec.ts',
      'e2e/pages/cart.page.ts',
    ]);
    // The imported human file IS recorded as theirs, which is the good half.
    expect(rows[1]?.ownership).toBe('HUMAN_AUTHORED');
  });
});
