import { describe, expect, it } from 'vitest';
import { accuracyHeadline, capNote, ratePercentLabel } from './health';

/**
 * Two numbers that do not exist, and the two ways a screen lies about them.
 */

describe('ratePercentLabel', () => {
  it('never prints 0% for a rate nobody can compute', () => {
    // `overrideRatePercent` is null when nothing was reviewed. "This verdict has
    // never been overruled" and "nobody has ever checked it" are opposite
    // claims, and 0% reads as the first — a pass produced out of silence.
    expect(ratePercentLabel(null)).toBe('unmeasured');
    expect(ratePercentLabel(null)).not.toContain('0');
  });

  it('prints a real zero as 0%', () => {
    // A measured zero is a fact and must not be hidden behind the same word.
    expect(ratePercentLabel(0)).toBe('0%');
  });

  it('rounds the way the server’s own sentence does', () => {
    // The endpoint writes the prose with toFixed(0); a table that rounded
    // differently would disagree with the sentence beside it.
    expect(ratePercentLabel(33.333)).toBe('33%');
    expect(ratePercentLabel(66.666)).toBe('67%');
    expect(ratePercentLabel(100)).toBe('100%');
  });
});

describe('capNote', () => {
  it('discloses the cap when the page is full', () => {
    // `returned === limit` means there may be more. A roster that rendered the
    // rows and not the cap would be a cap applied without being disclosed.
    expect(capNote({ returned: 100, limit: 100 })).toContain('may be more');
  });

  it('says nothing when the list is complete', () => {
    expect(capNote({ returned: 3, limit: 100 })).toBeNull();
  });

  it('discloses it for an empty page limit too, rather than assuming', () => {
    // Defensive on purpose: `returned >= limit` is the condition, so a limit of
    // 0 (or a server that returned more than it was asked for) still discloses.
    expect(capNote({ returned: 0, limit: 0 })).not.toBeNull();
  });
});

describe('accuracyHeadline', () => {
  const totals = (over: Partial<Parameters<typeof accuracyHeadline>[0]> = {}) => ({
    minted: 12,
    reviewed: 4,
    overridden: 1,
    overrideRatePercent: 25,
    ...over,
  });

  it('says accuracy is UNMEASURED when nobody has reviewed a verdict', () => {
    // The dangerous case. "0% overruled" here would read as a model that has
    // never been wrong, out of a project that has never checked.
    const sentence = accuracyHeadline(
      totals({ reviewed: 0, overridden: 0, overrideRatePercent: null }),
      30,
    );
    expect(sentence).toContain('nobody has reviewed one');
    expect(sentence).toContain('unmeasured, not good');
    expect(sentence).not.toContain('0%');
  });

  it('does not score a project that has produced no verdicts', () => {
    const sentence = accuracyHeadline(
      totals({ minted: 0, reviewed: 0, overridden: 0, overrideRatePercent: null }),
      30,
    );
    expect(sentence).toContain('nothing to score');
    expect(sentence).not.toContain('%');
  });

  it('reports the rate once there is a denominator', () => {
    expect(accuracyHeadline(totals(), 30)).toBe(
      'Humans overruled 1 of the 4 verdicts they reviewed — 25% over 30 days.',
    );
  });
});
