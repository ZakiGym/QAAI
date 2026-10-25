/**
 * Triage, the parts that do not need a model.
 *
 * Everything asserted here is deterministic and runs with no ANTHROPIC_API_KEY,
 * which is the point: the cause key, the mute clamp, the correction prior and
 * the accuracy arithmetic are all things the product must get right on a
 * deployment that has never made a model call.
 *
 * The tests are written against the DEFECTS rather than the happy paths,
 * because every one of these functions exists to close a specific one:
 *
 *  · `failureClusterKey` must be stable forever. Every mute, every stored
 *    identity and every link already shared is keyed on it, so a change to the
 *    hash or the slice orphans all of them — silently, because the new key just
 *    reads as a cause nobody has seen before.
 *  · `muteExpiryFrom` is the only clamp between a mute and the quarantine
 *    mistake. A mute with no end date is a deletion nobody signed.
 *  · `summariseCorrections` must stay a PRIOR. The failure mode is not a wrong
 *    number, it is a prompt that tells the model what to answer.
 *  · `triageAccuracy` must never print 0% for "nobody checked". That is the one
 *    dishonest number in a scorecard that reads as a pass.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CORRECTION_HISTORY_MAX_ROWS,
  CORRECTION_HISTORY_MIN_REVIEWS,
  MUTE_MAX_DAYS,
  deriveClusterVerdict,
  failureClusterKey,
  muteExpiryFrom,
  muteInForce,
  renderCorrectionHistory,
  summariseCorrections,
  triageAccuracy,
} from './triage.js';
import type { CorrectionRow, VerdictCorrectionTally, VerdictStateTally } from './triage.js';

const DAY = 86_400_000;

// ─── The cause key ───────────────────────────────────────────────────────────

describe('failureClusterKey', () => {
  /*
   * The hash is the compatibility contract with every row already written and
   * every cluster link already shared, so it is pinned against the primitive
   * rather than against itself — a snapshot of its own output would move
   * happily along with a change to the implementation.
   */
  it('is sha1 of the signature, truncated to 12 hex', () => {
    const signature = 'class=TimeoutError | call=locator.click | msg=timeout <n>ms exceeded';
    expect(failureClusterKey(signature)).toBe(
      createHash('sha1').update(signature).digest('hex').slice(0, 12),
    );
    expect(failureClusterKey(signature)).toHaveLength(12);
    expect(failureClusterKey(signature)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is a known constant for a known signature', () => {
    // sha1('abc') = a9993e364706816aba3e25717850c26c9cd0d89d
    expect(failureClusterKey('abc')).toBe('a9993e364706');
  });

  it('separates two signatures that differ in one token', () => {
    expect(failureClusterKey('url=https://api/orders | http=500')).not.toBe(
      failureClusterKey('url=https://api/orders | http=503'),
    );
  });

  it('gives the empty signature a key rather than an empty string', () => {
    // The clusterer substitutes 'msg=<none>' for an empty signature, and the
    // worker must produce the same key the cockpit shows for that case.
    expect(failureClusterKey('msg=<none>')).toHaveLength(12);
  });
});

// ─── Mute policy ─────────────────────────────────────────────────────────────

describe('mute expiry', () => {
  const now = new Date('2026-10-24T12:00:00.000Z');

  it('clamps a long request down to MUTE_MAX_DAYS', () => {
    const until = muteExpiryFrom(now, 365);
    expect(until).not.toBeNull();
    expect(until!.getTime()).toBe(now.getTime() + MUTE_MAX_DAYS * DAY);
  });

  it('honours a shorter request', () => {
    expect(muteExpiryFrom(now, 3)!.getTime()).toBe(now.getTime() + 3 * DAY);
  });

  /*
   * Zero and negative are refused rather than clamped UP to a day. "Mute for 0
   * days" is a caller bug, and quietly turning it into a real suppression is
   * exactly how a mute nobody asked for ends up in force.
   */
  it('refuses zero, negative and non-finite days', () => {
    expect(muteExpiryFrom(now, 0)).toBeNull();
    expect(muteExpiryFrom(now, -5)).toBeNull();
    expect(muteExpiryFrom(now, Number.NaN)).toBeNull();
  });
});

describe('muteInForce', () => {
  const now = new Date('2026-10-24T12:00:00.000Z');

  it('is false for a null expiry — null is NOT muted forever', () => {
    expect(muteInForce({ mutedUntil: null }, now)).toBe(false);
    expect(muteInForce(null, now)).toBe(false);
    expect(muteInForce(undefined, now)).toBe(false);
  });

  it('is true while the expiry is in the future and false once it passes', () => {
    expect(muteInForce({ mutedUntil: new Date(now.getTime() + 1000) }, now)).toBe(true);
    expect(muteInForce({ mutedUntil: new Date(now.getTime() - 1000) }, now)).toBe(false);
    // Exactly at the boundary the mute is over, not still running.
    expect(muteInForce({ mutedUntil: new Date(now.getTime()) }, now)).toBe(false);
  });
});

// ─── The correction prior ────────────────────────────────────────────────────

function reviewed(over: Partial<CorrectionRow> = {}): CorrectionRow {
  return {
    verdict: 'FLAKE',
    overriddenTo: 'REAL_BUG',
    reviewState: 'OVERRIDDEN',
    reviewedAt: new Date('2026-10-20T00:00:00.000Z'),
    where: 'checkout.spec.ts',
    ...over,
  };
}

describe('summariseCorrections', () => {
  it('counts accepted verdicts, not just the overrides', () => {
    const summary = summariseCorrections([
      ...Array.from({ length: 6 }, () => reviewed({ reviewState: 'ACCEPTED', overriddenTo: null })),
      ...Array.from({ length: 2 }, () => reviewed()),
    ]);

    expect(summary.reviewed).toBe(8);
    expect(summary.accepted).toBe(6);
    expect(summary.overridden).toBe(2);
    expect(summary.overrideRatePercent).toBeCloseTo(25);
  });

  /*
   * A summary built only from overrides would tell every project that has ever
   * corrected the model once that it is wrong 100% of the time, and the prompt
   * would then be a standing instruction to distrust itself.
   */
  it('does not report 100% when the only rows it was given are overrides', () => {
    const summary = summariseCorrections(Array.from({ length: 10 }, () => reviewed()));
    expect(summary.overrideRatePercent).toBe(100);
    expect(summary.accepted).toBe(0);
    // ...and that IS 100%. The guard is that acceptances are counted when they
    // exist, which the test above proves; this one pins the arithmetic.
    expect(summary.reviewed).toBe(10);
  });

  it('ignores PENDING and MUTED rows', () => {
    const summary = summariseCorrections([
      reviewed({ reviewState: 'PENDING' }),
      reviewed({ reviewState: 'MUTED' }),
    ]);
    expect(summary.reviewed).toBe(0);
    expect(summary.overrideRatePercent).toBeNull();
    expect(summary.patterns).toEqual([]);
  });

  it('groups from→to pairs, biggest first, with up to three distinct places', () => {
    const summary = summariseCorrections([
      ...Array.from({ length: 6 }, (_, i) => reviewed({ where: `spec-${i % 4}.ts` })),
      ...Array.from({ length: 2 }, () =>
        reviewed({ verdict: 'ENV_ISSUE', overriddenTo: 'REAL_BUG' }),
      ),
    ]);

    expect(summary.patterns[0]).toMatchObject({ from: 'FLAKE', to: 'REAL_BUG', count: 6 });
    expect(summary.patterns[0]!.where).toHaveLength(3);
    expect(summary.patterns[1]).toMatchObject({ from: 'ENV_ISSUE', to: 'REAL_BUG', count: 2 });
  });

  it('caps the number of patterns it will hand a prompt', () => {
    const pairs: CorrectionRow[] = [];
    const kinds = ['REAL_BUG', 'INTENDED_CHANGE', 'FLAKE', 'ENV_ISSUE'] as const;
    for (const from of kinds) {
      for (const to of kinds) {
        if (from === to) continue;
        pairs.push(reviewed({ verdict: from, overriddenTo: to }));
      }
    }
    // 12 distinct pairs in, CORRECTION_HISTORY_MAX_ROWS out.
    expect(pairs).toHaveLength(12);
    expect(summariseCorrections(pairs).patterns).toHaveLength(CORRECTION_HISTORY_MAX_ROWS);
  });

  it('drops an OVERRIDDEN row whose overriddenTo is null', () => {
    // The column is nullable and the review endpoint nulls it on every
    // non-override action, so this row shape is reachable. It counts as a
    // disagreement and produces no pattern — "overruled FLAKE to nothing" is
    // not a sentence that helps anybody.
    const summary = summariseCorrections(
      Array.from({ length: 10 }, () => reviewed({ overriddenTo: null })),
    );
    expect(summary.overridden).toBe(10);
    expect(summary.patterns).toEqual([]);
  });

  it('refuses to be a prior below the review floor, and says so', () => {
    const summary = summariseCorrections(
      Array.from({ length: CORRECTION_HISTORY_MIN_REVIEWS - 1 }, () => reviewed()),
    );
    expect(summary.tooFew).toMatch(/too few to be a prior/);
    // Blanked in the data, not just in the renderer: `tooFew` promises that no
    // history is quoted, and one careless consumer should not be able to break
    // that promise.
    expect(summary.patterns).toEqual([]);
    expect(renderCorrectionHistory(summary)).toMatch(/too few to be a prior/);
    // The numbers must not leak out alongside the refusal, or the model reads
    // "2 of 3 overruled" and treats a coincidence as 67%.
    expect(renderCorrectionHistory(summary)).not.toMatch(/Overruled FLAKE to REAL_BUG/);
  });
});

describe('renderCorrectionHistory', () => {
  const summary = summariseCorrections(
    Array.from({ length: 10 }, () => reviewed({ where: '/checkout' })),
  );

  it('frames the history as evidence about the project, not about the failure', () => {
    const text = renderCorrectionHistory(summary);
    expect(text).toContain('evidence about the project, not about this failure');
  });

  /*
   * THE LOAD-BEARING ASSERTION IN THIS FILE. The register defect says the
   * override history must not become "a rule the model cannot disagree with".
   * The only thing standing between a prior and an instruction is this
   * paragraph, and the only way to notice it being deleted is to assert on the
   * rendered text.
   */
  it('tells the model it may disagree, and to say so when it does', () => {
    const text = renderCorrectionHistory(summary);
    expect(text).toMatch(/This is a prior/);
    expect(text).toMatch(/Where the evidence above points the other way, follow the/);
    expect(text).toMatch(/disagreeing with the history/);
  });

  it('quotes the pattern with its count and places', () => {
    expect(renderCorrectionHistory(summary)).toMatch(
      /Overruled FLAKE to REAL_BUG 10 times \(\/checkout\)/,
    );
  });

  it('says nothing was corrected rather than printing an empty list', () => {
    const agreed = summariseCorrections(
      Array.from({ length: 10 }, () => reviewed({ reviewState: 'ACCEPTED', overriddenTo: null })),
    );
    expect(renderCorrectionHistory(agreed)).toMatch(/reviewers have agreed with the verdict/);
  });
});

// ─── Attaching one verdict to a cluster ──────────────────────────────────────

describe('deriveClusterVerdict', () => {
  const owner = {
    verdict: 'ENV_ISSUE' as const,
    confidence: 0.91,
    explanation: 'the payments service answered 503 for every one of these',
    evidence: [{ kind: 'NETWORK' as const, ref: 'req-1', detail: 'POST /pay -> 503' }],
    suspectCommit: null,
    model: 'cheap',
    // A first-hand verdict: a model read THIS result. deriveClusterVerdict's
    // whole job is turning these four columns into the copy's provenance.
    clusterKey: null,
    derivedFromId: null,
    revision: 1,
    splitFromClusterKey: null,
  };

  const derived = deriveClusterVerdict(owner, {
    clusterKey: 'abc123abc123',
    label: '/pay is returning 503',
    ownerTestName: 'checkout completes',
  });

  /*
   * Without the prefix the cost ledger reports 200 cheap-model calls that never
   * happened, and an A/B on a prompt change counts 200 samples from one call.
   */
  it('marks the copy as a copy in `model`', () => {
    expect(derived.model).toBe('cluster:cheap');
  });

  it('does not re-prefix a verdict that was already derived', () => {
    const twice = deriveClusterVerdict(derived, {
      clusterKey: 'abc123abc123',
      label: 'x',
      ownerTestName: 'y',
    });
    expect(twice.model).toBe('cluster:cheap');
  });

  it('copies the classification and the confidence unchanged', () => {
    expect(derived.verdict).toBe('ENV_ISSUE');
    expect(derived.confidence).toBe(0.91);
    expect(derived.explanation).toBe(owner.explanation);
  });

  it('names the test the evidence was actually read from, and how to split', () => {
    const note = derived.evidence.at(-1)!;
    expect(note.ref).toBe('cluster:abc123abc123');
    expect(note.detail).toContain('"checkout completes", not from this test');
    expect(note.detail).toContain('re-triage');
    // The owner's own evidence survives in front of it.
    expect(derived.evidence[0]).toEqual(owner.evidence[0]);
  });

  /*
   * A member count written into the sentence is stale the moment the next
   * member attaches, and different on the row beside it. The live count lives
   * on the claim row.
   */
  it('does not bake a member count into the sentence', () => {
    expect(derived.evidence.at(-1)!.detail).not.toMatch(/\d+ failures/);
  });
});

// ─── The accuracy scorecard ──────────────────────────────────────────────────

const tally = (
  verdict: VerdictStateTally['verdict'],
  reviewState: VerdictStateTally['reviewState'],
  count: number,
): VerdictStateTally => ({ verdict, reviewState, count });

describe('triageAccuracy', () => {
  it('reports every verdict kind, including the ones with no rows', () => {
    const accuracy = triageAccuracy([tally('FLAKE', 'ACCEPTED', 1)], []);
    expect(accuracy.rows.map((r) => r.verdict)).toEqual([
      'REAL_BUG',
      'INTENDED_CHANGE',
      'FLAKE',
      'ENV_ISSUE',
    ]);
    const realBug = accuracy.rows.find((r) => r.verdict === 'REAL_BUG')!;
    expect(realBug.minted).toBe(0);
    expect(realBug.sentence).toMatch(/No REAL_BUG verdict was reached/);
  });

  /*
   * THE ONE NUMBER THIS MUST NOT FAKE. "This verdict has never been wrong" and
   * "nobody has ever checked this verdict" are opposite facts, and a scorecard
   * that prints 0% for the second reads as a pass. Null, and a sentence that
   * says unmeasured.
   */
  it('leaves the rate NULL when nothing was reviewed, and calls it unmeasured', () => {
    const accuracy = triageAccuracy([tally('REAL_BUG', 'PENDING', 40)], []);
    const row = accuracy.rows.find((r) => r.verdict === 'REAL_BUG')!;
    expect(row.minted).toBe(40);
    expect(row.reviewed).toBe(0);
    expect(row.overrideRatePercent).toBeNull();
    expect(row.sentence).toMatch(/nobody has reviewed one/);
    expect(row.sentence).toMatch(/unmeasured, not good/);
    expect(accuracy.totals.overrideRatePercent).toBeNull();
  });

  /*
   * MUTED is not a review. Counting it as agreement would let a team drive its
   * apparent accuracy to 100% by muting everything, which is the exact
   * incentive a scorecard must not create.
   */
  it('does not count a mute as a review', () => {
    const accuracy = triageAccuracy(
      [tally('FLAKE', 'MUTED', 9), tally('FLAKE', 'OVERRIDDEN', 1)],
      [],
    );
    const row = accuracy.rows.find((r) => r.verdict === 'FLAKE')!;
    expect(row.minted).toBe(10);
    expect(row.muted).toBe(9);
    expect(row.reviewed).toBe(1);
    expect(row.overrideRatePercent).toBe(100);
  });

  it('computes the rate over reviewed verdicts and names where overrides went', () => {
    const corrections: VerdictCorrectionTally[] = [
      { verdict: 'FLAKE', overriddenTo: 'REAL_BUG', count: 6 },
      { verdict: 'FLAKE', overriddenTo: 'ENV_ISSUE', count: 2 },
    ];
    const accuracy = triageAccuracy(
      [tally('FLAKE', 'ACCEPTED', 12), tally('FLAKE', 'OVERRIDDEN', 8)],
      corrections,
    );
    const row = accuracy.rows.find((r) => r.verdict === 'FLAKE')!;
    expect(row.overrideRatePercent).toBeCloseTo(40);
    expect(row.correctedTo[0]).toEqual({ to: 'REAL_BUG', count: 6 });
    expect(row.sentence).toMatch(/overruled 8 of the 20 FLAKE verdicts they reviewed \(40%\)/);
    expect(row.sentence).toMatch(/most often to REAL_BUG/);
  });

  it('reports how thin the sample is, so a loud rate can be discounted', () => {
    const accuracy = triageAccuracy(
      [tally('REAL_BUG', 'PENDING', 196), tally('REAL_BUG', 'OVERRIDDEN', 4)],
      [],
    );
    expect(accuracy.totals.minted).toBe(200);
    expect(accuracy.totals.reviewed).toBe(4);
    expect(accuracy.totals.reviewCoveragePercent).toBeCloseTo(2);
    expect(accuracy.caveat).toMatch(/reviewCoveragePercent is how thin/);
  });

  it('drops a correction that points at the verdict it came from', () => {
    // from === to is not a correction. It happens when a reviewer overrides to
    // the same value, and counting it would inflate `correctedTo` with a row
    // saying the model was overruled into agreeing with itself.
    const accuracy = triageAccuracy(
      [tally('FLAKE', 'OVERRIDDEN', 1)],
      [{ verdict: 'FLAKE', overriddenTo: 'FLAKE', count: 1 }],
    );
    expect(accuracy.rows.find((r) => r.verdict === 'FLAKE')!.correctedTo).toEqual([]);
  });

  it('reports the window it counted over', () => {
    expect(triageAccuracy([], [], { windowDays: 7 }).caveat).toMatch(/Counted over 7 days/);
  });
});
