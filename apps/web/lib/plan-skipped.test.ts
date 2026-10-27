/**
 * The plan screen's skipped list, grouped.
 *
 * The contract under test is a PROSE one — the worker tags `what` with a
 * suffix because `testPlanSchema.skipped` has no typed field for the kind — so
 * the tests that matter most are the ones that would catch the two halves
 * drifting apart. The producer side is pinned in
 * apps/worker/src/processors/explore.funnel.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { SKIPPED_TAGS, groupSkipped } from './plan-skipped';

describe('the tag contract', () => {
  it('declares three tags, each with a distinct suffix, label and note', () => {
    expect(SKIPPED_TAGS).toHaveLength(3);
    expect(new Set(SKIPPED_TAGS.map((tag) => tag.suffix)).size).toBe(3);
    expect(new Set(SKIPPED_TAGS.map((tag) => tag.group)).size).toBe(3);
    for (const tag of SKIPPED_TAGS) {
      expect(tag.label.length).toBeGreaterThan(10);
      expect(tag.note.length).toBeGreaterThan(30);
    }
  });

  it('matches the suffixes the worker actually writes', () => {
    /*
     * HARD-CODED HERE ON PURPOSE, as the literal strings rather than by
     * importing the worker: apps/web cannot import from apps/worker, and a
     * prose contract whose two halves are each asserted against the same
     * constant would be asserted against nothing. If the worker changes a
     * suffix, its own test and this one both go red.
     */
    expect(SKIPPED_TAGS.map((tag) => tag.suffix)).toEqual([
      ' — earned, not yet storable',
      ' — not enumerated',
      ' — not applicable',
    ]);
  });

  it('puts the group somebody must ACT on first', () => {
    expect(SKIPPED_TAGS[0]?.group).toBe('EARNED_NOT_STORABLE');
    expect(SKIPPED_TAGS[2]?.group).toBe('NOT_APPLICABLE');
  });
});

describe('grouping', () => {
  it('keeps the untagged entries FIRST, so the funnel cannot bury them', () => {
    /*
     * THE DEFECT THIS IS ABOUT. "Model-written test proposals" is the sentence
     * telling a reader their plan has no model behind it. Thirty tagged type
     * verdicts rendered above it would hide the one line that explains the
     * whole screen.
     */
    const sections = groupSkipped([
      { what: 'DATABASE tests — not enumerated', why: 'nobody looked' },
      { what: 'Model-written test proposals', why: 'no API key' },
      { what: 'PAYMENTS tests — earned, not yet storable', why: 'mint it' },
    ]);
    expect(sections[0]?.group).toBe('OTHER');
    expect(sections[0]?.entries.map((entry) => entry.what)).toEqual([
      'Model-written test proposals',
    ]);
  });

  it('orders the tagged groups by what needs acting on', () => {
    const sections = groupSkipped([
      { what: 'A tests — not applicable', why: 'x' },
      { what: 'B tests — not enumerated', why: 'y' },
      { what: 'C tests — earned, not yet storable', why: 'z' },
    ]);
    expect(sections.map((section) => section.group)).toEqual([
      'EARNED_NOT_STORABLE',
      'NOT_ENUMERATED',
      'NOT_APPLICABLE',
    ]);
  });

  it('strips the tag so the heading is not repeated on every row', () => {
    const sections = groupSkipped([
      { what: 'PAYMENTS tests — earned, not yet storable', why: 'z' },
    ]);
    expect(sections[0]?.entries[0]?.what).toBe('PAYMENTS tests');
    expect(sections[0]?.entries[0]?.why).toBe('z');
  });

  it('OMITS an empty group rather than rendering an empty heading', () => {
    // An empty "Not applicable to this application" heading reads as a claim
    // that every type applies to this application.
    const sections = groupSkipped([{ what: 'X tests — not enumerated', why: 'y' }]);
    expect(sections.map((section) => section.group)).toEqual(['NOT_ENUMERATED']);
  });

  it('returns nothing for an empty list', () => {
    expect(groupSkipped([])).toEqual([]);
  });

  it('loses no entry, whatever the mix', () => {
    const input = [
      { what: 'Enumeration caveat', why: 'truncated' },
      { what: 'A tests — not applicable', why: '1' },
      { what: 'B tests — not applicable', why: '2' },
      { what: 'C tests — not enumerated', why: '3' },
      { what: 'D tests — earned, not yet storable', why: '4' },
      { what: 'Some gap', why: 'below budget' },
    ];
    const sections = groupSkipped(input);
    expect(sections.flatMap((section) => section.entries)).toHaveLength(input.length);
  });

  it('preserves the producer order inside a group, so the render is stable', () => {
    const sections = groupSkipped([
      { what: 'Z tests — not applicable', why: '1' },
      { what: 'A tests — not applicable', why: '2' },
    ]);
    expect(sections[0]?.entries.map((entry) => entry.what)).toEqual(['Z tests', 'A tests']);
  });

  it('does not mistake an untagged entry that merely mentions a tag word', () => {
    // Matched on `endsWith`, not `includes`: a reason or title that happens to
    // contain "not applicable" mid-sentence is not a tagged entry.
    const sections = groupSkipped([
      { what: 'Why some tests are not applicable here, in general', why: 'prose' },
    ]);
    expect(sections[0]?.group).toBe('OTHER');
  });
});
