/**
 * The coverage screen's obligation panel, grouped.
 *
 * The contract under test is a VOCABULARY one: `OBLIGATION_REFUSALS` lives in
 * packages/agent/src/coverage.ts, apps/web cannot import from packages/agent,
 * and the four names are therefore written out here as literals. That is
 * deliberate — a contract whose two halves are both asserted against the same
 * constant is asserted against nothing. The server half is pinned in
 * apps/api/src/routes/coverage.obligations.test.ts, which drives the real
 * adjudicator, so a refusal added or renamed in packages/agent shows up there
 * and the missing group shows up here.
 */

import { describe, expect, it } from 'vitest';
import {
  OBLIGATION_GROUPS,
  groupObligations,
  obligationHeading,
  obligationsNeedSaying,
  ungroupedRefusals,
  type ObligationAuditView,
  type ObligationVerdict,
} from './obligation-audit';

/** `type` is a string on purpose: a stored policy can name something that is not a test type. */
function verdict(over: Partial<ObligationVerdict> = {}): ObligationVerdict {
  return {
    kind: 'ROUTE',
    type: 'E2E',
    counts: true,
    refusal: null,
    why: 'A ROUTE owes an E2E test, and one can be proposed, run and scored.',
    ...over,
  };
}

function audit(over: Partial<ObligationAuditView> = {}): ObligationAuditView {
  const verdicts = over.verdicts ?? [];
  return {
    projectId: 'proj_1',
    policy: { declared: true, unreadable: false, byKind: { ROUTE: ['E2E'] }, why: 'declared' },
    counted: verdicts.filter((row) => row.counts).length,
    verdicts,
    excluded: verdicts.filter((row) => !row.counts),
    impossible: verdicts.filter((row) => row.refusal === 'IMPOSSIBLE_FOR_AXIS'),
    refusals: ['IMPOSSIBLE_FOR_AXIS', 'NOT_A_DECLARED_TYPE', 'UNRUNNABLE_HERE', 'NO_PRODUCER'],
    outOfDenominator: ['IMPOSSIBLE_FOR_AXIS', 'NOT_A_DECLARED_TYPE', 'UNRUNNABLE_HERE'],
    axes: [],
    capability: { probed: false, measuredAtIso: null, why: 'nothing probed' },
    why: 'impossible is the number to read first',
    ...over,
  };
}

describe('the group vocabulary', () => {
  it('covers all four refusals the adjudicator can produce, exactly once each', () => {
    /*
     * THE FOUR NAMES, WRITTEN OUT. If packages/agent adds a fifth refusal this
     * list is the thing that has to change, and until it does the new refusal's
     * obligations would be dropped from the panel silently — which is the
     * failure mode this assertion exists for.
     */
    expect(OBLIGATION_GROUPS.map((group) => group.refusal)).toEqual([
      'IMPOSSIBLE_FOR_AXIS',
      'NOT_A_DECLARED_TYPE',
      'UNRUNNABLE_HERE',
      'NO_PRODUCER',
    ]);
    expect(new Set(OBLIGATION_GROUPS.map((group) => group.label)).size).toBe(4);
    for (const group of OBLIGATION_GROUPS) {
      expect(group.label.length).toBeGreaterThan(10);
      expect(group.note.length).toBeGreaterThan(30);
    }
  });

  /*
   * THE ONE FACT THAT MUST NOT MERGE. Three of the four refusals take the
   * obligation OUT of the coverage denominator and so raise the percentage;
   * NO_PRODUCER does not, because the missing piece is ours and shedding it
   * would raise a customer's number for a shortfall in this product. A panel
   * that got this backwards would print "we already accounted for this" over
   * genuinely uncovered debt.
   */
  it('marks NO_PRODUCER, and only NO_PRODUCER, as still counted', () => {
    const counted = OBLIGATION_GROUPS.filter((group) => group.countsInDenominator);
    expect(counted.map((group) => group.refusal)).toEqual(['NO_PRODUCER']);
  });

  it('puts the policy errors before the ones nobody here can fix', () => {
    // Reading order is the editorial decision: IMPOSSIBLE_FOR_AXIS is the only
    // group a person on this screen can act on, so it is first.
    expect(OBLIGATION_GROUPS[0].refusal).toBe('IMPOSSIBLE_FOR_AXIS');
    expect(OBLIGATION_GROUPS[3].refusal).toBe('NO_PRODUCER');
  });
});

describe('groupObligations', () => {
  it('separates an impossible obligation from a merely-unrunnable one', () => {
    const sections = groupObligations(
      audit({
        verdicts: [
          verdict({ type: 'DATABASE', counts: false, refusal: 'IMPOSSIBLE_FOR_AXIS' }),
          verdict({ type: 'LOAD', counts: false, refusal: 'UNRUNNABLE_HERE', kind: 'ENDPOINT' }),
        ],
      }),
    );

    // TWO sections, not one list of two. The first is a configuration error
    // here; the second is a missing binary on the image.
    expect(sections).toHaveLength(2);
    expect(sections[0]!.refusal).toBe('IMPOSSIBLE_FOR_AXIS');
    expect(sections[0]!.entries.map((row) => row.type)).toEqual(['DATABASE']);
    expect(sections[1]!.refusal).toBe('UNRUNNABLE_HERE');
    expect(sections[1]!.entries.map((row) => row.type)).toEqual(['LOAD']);
  });

  /*
   * READS `verdicts`, NOT `excluded`. NO_PRODUCER stays in the denominator, so
   * it is absent from `excluded` by design — a reader of that field alone would
   * silently drop the one group whose owner is us, which is the honest half of
   * the audit and the easiest thing in it to lose.
   */
  it('includes NO_PRODUCER, which the excluded list deliberately omits', () => {
    const view = audit({
      verdicts: [verdict({ type: 'MUTATION', counts: true, refusal: 'NO_PRODUCER' })],
    });
    expect(view.excluded).toEqual([]);

    const sections = groupObligations(view);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.refusal).toBe('NO_PRODUCER');
    expect(sections[0]!.countsInDenominator).toBe(true);
  });

  it('drops the ordinary closeable obligations, which are not refusals', () => {
    const sections = groupObligations(
      audit({ verdicts: [verdict(), verdict({ kind: 'FORM', type: 'ACCESSIBILITY' })] }),
    );
    expect(sections).toEqual([]);
  });

  it('omits an empty group rather than rendering an empty heading', () => {
    const sections = groupObligations(
      audit({ verdicts: [verdict({ counts: false, refusal: 'UNRUNNABLE_HERE' })] }),
    );
    expect(sections.map((section) => section.refusal)).toEqual(['UNRUNNABLE_HERE']);
  });

  it('preserves the server order within a group', () => {
    const sections = groupObligations(
      audit({
        verdicts: [
          verdict({
            kind: 'ROUTE',
            type: 'DATABASE',
            counts: false,
            refusal: 'IMPOSSIBLE_FOR_AXIS',
          }),
          verdict({
            kind: 'FORM',
            type: 'DATABASE',
            counts: false,
            refusal: 'IMPOSSIBLE_FOR_AXIS',
          }),
          verdict({
            kind: 'ENDPOINT',
            type: 'VISUAL',
            counts: false,
            refusal: 'IMPOSSIBLE_FOR_AXIS',
          }),
        ],
      }),
    );
    // The audit iterates SURFACE_KINDS, a constant, so its order is stable and
    // a panel that re-sorted would make two reads of one policy disagree.
    expect(sections[0]!.entries.map((row) => row.kind)).toEqual(['ROUTE', 'FORM', 'ENDPOINT']);
  });

  it('is total: null, and an audit with no verdicts, both group to nothing', () => {
    expect(groupObligations(null)).toEqual([]);
    expect(groupObligations(audit())).toEqual([]);
  });
});

describe('ungroupedRefusals', () => {
  /*
   * THE ONE-WAY DRIFT THIS GUARDS. `OBLIGATION_REFUSALS` lives in
   * packages/agent, apps/web cannot import it, and the API publishes whatever
   * the agent declares — so a fifth refusal reaches this reader with NO code
   * change on either side of the wire. Dropping its obligations would shorten
   * the list with no indication that anything was left out.
   *
   * The cast is the point: a deployed web build is routinely older than the API
   * it talks to, so this is the shape of a real response and not an impossible
   * one. If it ever stops needing a cast, a group for that name is overdue.
   */
  it('reports a refusal this build has no group for, rather than dropping it', () => {
    const view = audit({
      verdicts: [
        verdict({ counts: false, refusal: 'NEWLY_INVENTED' as unknown as 'NO_PRODUCER' }),
        verdict({ kind: 'FORM', counts: false, refusal: 'IMPOSSIBLE_FOR_AXIS' }),
      ],
    });

    expect(ungroupedRefusals(view)).toEqual(['NEWLY_INVENTED']);
    // The groups it DOES know still render — an unknown name must not take the
    // rest of the panel down with it.
    expect(groupObligations(view).map((section) => section.refusal)).toEqual([
      'IMPOSSIBLE_FOR_AXIS',
    ]);
    // And the panel renders, because it can no longer claim to be complete.
    expect(obligationsNeedSaying(view)).toBe(true);
  });

  it('is empty when every refusal on the wire has a group', () => {
    expect(
      ungroupedRefusals(
        audit({ verdicts: [verdict({ counts: false, refusal: 'UNRUNNABLE_HERE' })] }),
      ),
    ).toEqual([]);
    expect(ungroupedRefusals(null)).toEqual([]);
  });

  /*
   * Checked against the WIRE's own `outOfDenominator`, not against the four
   * literals above — so the hand-written booleans in this file cannot disagree
   * with the list packages/agent derives from its own presence record.
   */
  it('agrees with the server about which refusals leave the denominator', () => {
    const view = audit();
    for (const group of OBLIGATION_GROUPS) {
      expect(group.countsInDenominator).toBe(!view.outOfDenominator.includes(group.refusal));
    }
  });
});

describe('obligationsNeedSaying', () => {
  it('is silent for a project that never stated its obligations', () => {
    // The common case, and the reason this predicate exists: a panel that
    // appeared on every coverage screen to report that nothing is owed teaches
    // people to skip the one time it says something.
    expect(
      obligationsNeedSaying(
        audit({
          policy: { declared: false, unreadable: false, byKind: null, why: 'never stated' },
        }),
      ),
    ).toBe(false);
  });

  it('is silent for a declared policy whose every obligation can be closed', () => {
    expect(obligationsNeedSaying(audit({ verdicts: [verdict()] }))).toBe(false);
  });

  it('speaks when a stored policy cannot be read, even with no verdicts', () => {
    /*
     * A policy IS stored and does not parse, so the server read it as none and
     * there is nothing to adjudicate — which means the refusal groups are all
     * empty and the only signal left is this flag. Staying silent here would
     * report a denominator the customer did not configure as the one they did.
     */
    expect(
      obligationsNeedSaying(
        audit({
          policy: { declared: false, unreadable: true, byKind: null, why: 'does not parse' },
          verdicts: [],
        }),
      ),
    ).toBe(true);
  });

  it('speaks for an impossible obligation', () => {
    expect(
      obligationsNeedSaying(
        audit({
          verdicts: [verdict({ type: 'DATABASE', counts: false, refusal: 'IMPOSSIBLE_FOR_AXIS' })],
        }),
      ),
    ).toBe(true);
  });

  it('is silent when there is no audit at all', () => {
    // The fetch is a courtesy on the coverage screen — a deployment that cannot
    // answer must not break the gap list, and must not claim a clean policy.
    expect(obligationsNeedSaying(null)).toBe(false);
  });
});

describe('obligationHeading', () => {
  it('counts the obligations when there are any', () => {
    expect(
      obligationHeading(
        audit({
          verdicts: [
            verdict({ type: 'DATABASE', counts: false, refusal: 'IMPOSSIBLE_FOR_AXIS' }),
            verdict({
              kind: 'FORM',
              type: 'DATABASE',
              counts: false,
              refusal: 'IMPOSSIBLE_FOR_AXIS',
            }),
          ],
        }),
      ),
    ).toBe('2 declared obligation(s) no test can close today');
  });

  /*
   * THE CASE A TEMPLATE IN THE COMPONENT GOT WRONG. The panel also renders for
   * a policy that does not PARSE — the server read it as none, so there is
   * nothing to adjudicate and nothing to list — and "0 declared obligation(s)
   * no test can close today" over that paragraph reads as an all-clear on the
   * one screen that exists to say something is wrong.
   */
  it('never prints a count of zero', () => {
    const unreadable = audit({
      policy: { declared: false, unreadable: true, byKind: null, why: 'does not parse' },
      verdicts: [],
    });
    expect(obligationHeading(unreadable)).toBe('This obligation policy could not be read');
    expect(obligationHeading(unreadable)).not.toContain('0 ');

    const unknown = audit({
      verdicts: [verdict({ counts: false, refusal: 'NEWLY_INVENTED' as unknown as 'NO_PRODUCER' })],
    });
    expect(obligationHeading(unknown)).toBe('Obligations this page cannot explain yet');
  });

  it('says so rather than lying when a caller skipped the predicate', () => {
    // Unreachable from the panel, which checks `obligationsNeedSaying` first.
    // A heading is not worth a crash, and a blank one would look like a bug.
    expect(obligationHeading(audit())).toBe('Nothing to report about this obligation policy');
  });
});
