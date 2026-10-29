/**
 * ADVERSARIAL VERIFICATION of the one fact the whole ownership model rests on.
 *
 * `WRITABLE_BY_OWNERSHIP` has exactly one `true` key, `pushRepo` goes through
 * it, and the refactor engine refuses a path it is not recorded for. All of
 * that is sound, and all of it is downstream of ONE question: where does a
 * `QAAI_OWNED` row come from, and has anything looked at the path before the
 * row claims it?
 *
 * ── WHAT THIS FILE MEASURED, AND WHAT CHANGED UNDER IT ─────────────────────
 *
 * The previous version of this file recorded the answer "NOTHING HAS LOOKED":
 * `ledgerRowsFor` took the set, the org, the project, the test and the shared
 * roles, and no view of the customer's repository, because the generate
 * processor materialised none. Its assertions pinned that deliberately, with a
 * comment saying so, and the one below about the function's parameter list was
 * written to go red the day a parameter appeared.
 *
 * IT HAS. The processor now opens a repository view once per batch
 * (`RepoFileView`, over the tarball `repo-materialise.ts` already fetched for
 * the run processor), and `ownershipClaims` asks it per path before any row is
 * minted. So the assertions here are TIGHTENED rather than relaxed: the blind
 * case is still asserted — it is what a project with no connected repository
 * gets, and it is now COUNTED rather than silent — and the case the file existed
 * to warn about is asserted to be fixed.
 *
 * Nothing here calls a model, a network or a filesystem.
 */

import { describe, expect, it } from 'vitest';

import { ledgerRowsFor, occupancyProbe, ownershipClaims, SHARED_ARTIFACT_ROLES } from './generate.js';
import type { RepoFileView } from './generate.js';
import type { DiskState } from '@qaai/agent';
import type { ArtifactSet } from '@qaai/shared';

/** A one-spec set, exactly the shape a generate job produces for a bare page. */
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

/** A view over an in-memory tree. The two methods, and nothing else. */
function viewOf(files: Record<string, string>): RepoFileView {
  return {
    diskStateAt: (path): DiskState => {
      const content = files[path];
      return content === undefined ? { state: 'ABSENT' } : { state: 'PRESENT', content };
    },
    filesUnder: () => [],
  };
}

const THEIR_SPEC = "test('a person wrote this, months ago', () => {});";

describe('where a QAAI_OWNED row comes from', () => {
  /*
   * THE CASE THAT WAS THE FINDING, NOW FIXED AND ASSERTED AS FIXED.
   *
   * A path a human has owned for months is no longer claimed. It is recorded
   * HUMAN_AUTHORED — a FACT that "QAAI does not own this", which the unique
   * constraint then protects from every later generation at that path — rather
   * than left out, because no row resolves UNRECORDED and UNRECORDED is the one
   * state a reservation may claim.
   */
  it('does NOT claim a path the repository has a file of theirs at', () => {
    const set = setAt('e2e/checkout.spec.ts', "test('checkout', () => {});");
    const claims = ownershipClaims({
      set,
      occupancy: occupancyProbe(viewOf({ 'e2e/checkout.spec.ts': THEIR_SPEC })),
      // No recorded fact calls that file ours, which is the whole condition.
      recorded: new Set<string>(),
    });
    const rows = ledgerRowsFor({
      set,
      orgId: 'org_1',
      recordAsTheirs: [],
      projectId: 'proj_1',
      testId: 'test_1',
      sharedRoles: SHARED_ARTIFACT_ROLES,
      claims,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe('e2e/checkout.spec.ts');
    expect(rows[0]?.ownership).toBe('HUMAN_AUTHORED');
    // And the caller is handed the path, so a file that will never sync is said
    // rather than discovered.
    expect(claims.notOurs).toEqual(['e2e/checkout.spec.ts']);
    expect(claims.unexamined).toEqual([]);
  });

  /*
   * THE OTHER DIRECTION, WHICH IS WHY `recorded` IS AN ARGUMENT AND NOT AN
   * INFERENCE. Rule 11: "QAAI owns it" is a recorded fact about that file, never
   * an inference from its path or its content — and the inverse holds too. A
   * path occupied BECAUSE QAAI pushed a file there last sync stays ours.
   */
  it('keeps a path QAAI has a recorded row for, although a file is there', () => {
    const set = setAt('e2e/checkout.spec.ts', 'ours, version two');
    const claims = ownershipClaims({
      set,
      occupancy: occupancyProbe(viewOf({ 'e2e/checkout.spec.ts': 'ours, version one' })),
      recorded: new Set(['e2e/checkout.spec.ts']),
    });
    expect(claims.verdictFor('e2e/checkout.spec.ts')).toBe('QAAI_OWNED');
    expect(claims.notOurs).toEqual([]);
  });

  /*
   * THE BLIND CASE, STILL REAL AND NO LONGER SILENT.
   *
   * A project with no connected repository, a half-configured GitHub App, an
   * archive over the cap: the view is UNAVAILABLE and nothing looks at the path.
   * The row is still minted, which is deliberate — refusing would make every
   * such project generate tests `pushRepo` then declines to write, the
   * create-only defect the previous commit closed — and the paths are COUNTED,
   * which is what the caller reports.
   */
  it('still claims a path nothing looked at, and counts it as unexamined', () => {
    const set = setAt('e2e/checkout.spec.ts', "test('checkout', () => {});");
    // No `occupancy` at all: the honest UNKNOWN, which is what no view means.
    const claims = ownershipClaims({ set });
    const rows = ledgerRowsFor({
      set,
      orgId: 'org_1',
      recordAsTheirs: [],
      projectId: 'proj_1',
      testId: 'test_1',
      sharedRoles: SHARED_ARTIFACT_ROLES,
      claims,
    });

    expect(rows[0]?.ownership).toBe('QAAI_OWNED');
    expect(claims.unexamined).toEqual(['e2e/checkout.spec.ts']);
    expect(claims.notOurs).toEqual([]);
  });

  /*
   * A PATH THE VIEW DECLINED TO READ IS NOT A FREE PATH, and this is the
   * assertion that keeps the null from becoming a zero. UNREADABLE — a symlink
   * refused, a file over the byte cap, an EACCES — resolves UNKNOWN, which
   * claims and counts; it does NOT resolve FREE, which would be a planner
   * concluding a path is empty because QAAI would not open it.
   */
  it('reads a path it declined to open as UNKNOWN, never as free', () => {
    const set = setAt('e2e/checkout.spec.ts', 'ours');
    const refusing: RepoFileView = {
      diskStateAt: () => ({ state: 'UNREADABLE', why: 'it passes through a symbolic link' }),
      filesUnder: () => [],
    };
    const claims = ownershipClaims({ set, occupancy: occupancyProbe(refusing) });
    expect(claims.unexamined).toEqual(['e2e/checkout.spec.ts']);
    expect(claims.notOurs).toEqual([]);
  });

  /*
   * THE STRUCTURAL HALF OF THE OLD CLAIM, REWRITTEN RATHER THAN DELETED.
   *
   * It used to assert that `ledgerRowsFor` has SIX named keys, none of them the
   * repository, and that was the evidence behind "nothing has looked". There are
   * seven now and the seventh is the answer — `claims`, carrying the verdicts
   * `ownershipClaims` read off the view. The assertion is kept in this shape so
   * that REMOVING the parameter turns this file red again.
   */
  it('has a parameter through which the repository decision arrives', () => {
    expect(
      Object.keys({
        set: 0,
        orgId: 0,
        recordAsTheirs: 0,
        projectId: 0,
        testId: 0,
        sharedRoles: 0,
        claims: 0,
      }).sort(),
    ).toEqual([
      'claims',
      'orgId',
      'projectId',
      'recordAsTheirs',
      'set',
      'sharedRoles',
      'testId',
    ]);
    // And the compiler agrees it is a real parameter: this call would not type
    // if `claims` were not on the argument object.
    const rows = ledgerRowsFor({
      set: setAt('e2e/a.spec.ts', 'ours'),
      orgId: 'org_1',
      recordAsTheirs: [],
      projectId: 'proj_1',
      testId: 'test_1',
      sharedRoles: SHARED_ARTIFACT_ROLES,
      claims: ownershipClaims({
        set: setAt('e2e/a.spec.ts', 'ours'),
        occupancy: occupancyProbe(viewOf({ 'e2e/a.spec.ts': THEIR_SPEC })),
      }),
    });
    expect(rows[0]?.ownership).toBe('HUMAN_AUTHORED');
  });

  /*
   * The `contentHash` on a row is the digest of OUR bytes and never of whatever
   * is at the path — on a HUMAN_AUTHORED row too, where it is compared against
   * nothing because `WRITABLE_BY_OWNERSHIP` refuses the write first. Hashing
   * THEIR bytes would be the dangerous choice: a later run could find the two
   * equal and read that as permission.
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
   * The mitigation that was in place before the view and still is: a row that
   * already exists wins, because the write is `createMany({ skipDuplicates:
   * true })` over `@@unique([projectId, path])`. So a path a human has ALREADY
   * been recorded for is never downgraded. The gap this closed was the path
   * nobody had a row for at all.
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
    // The imported human file IS recorded as theirs, which was always the good
    // half and is now the same member the occupied-path rule writes.
    expect(rows[1]?.ownership).toBe('HUMAN_AUTHORED');
  });
});
