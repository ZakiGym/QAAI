import { describe, expect, it } from 'vitest';
import { fuzzyMatch, matchTree } from './filter';
import { allDirIds, buildTree, findNode, flattenTree, type TreeNode, type TreeTest } from './model';

function mk(filePath: string, extra: Partial<TreeTest> = {}): TreeTest {
  return {
    id: extra.id ?? filePath,
    name: extra.name ?? (filePath.split('/').pop() as string),
    type: extra.type ?? 'E2E',
    filePath,
    reviewFlags: extra.reviewFlags ?? [],
    ...(extra.feature !== undefined ? { feature: extra.feature } : {}),
  };
}

/** The matched substrings, so an expectation reads as what would be underlined. */
function hits(text: string, query: string): string[] | null {
  const match = fuzzyMatch(text, query);
  if (!match) return null;
  return match.ranges.map((r) => text.slice(r.start, r.end));
}

function shape(nodes: readonly TreeNode[]): string[] {
  return flattenTree(nodes, new Set(allDirIds(nodes))).map((row) => `${row.depth}:${row.node.name}`);
}

describe('fuzzyMatch', () => {
  it.each([
    ['an exact name', 'card.spec.ts', 'card.spec.ts', ['card.spec.ts']],
    ['a plain substring', 'order-total.spec.ts', 'total', ['total']],
    ['a subsequence with gaps', 'order-total.spec.ts', 'odr', ['o', 'd', 'r']],
    ['regardless of case', 'Order Total.spec.ts', 'ORDER', ['Order']],
    ['a query that is the whole name', 'a', 'a', ['a']],
  ])('matches %s', (_label, text, query, expected) => {
    expect(hits(text, query)).toEqual(expected);
  });

  it.each([
    ['a letter that is not there', 'card.spec.ts', 'z'],
    ['letters in the wrong order', 'card.spec.ts', 'drac'],
    ['a query longer than the name', 'a.ts', 'aaaaaaaaaa'],
    ['an empty query', 'card.spec.ts', ''],
    ['a whitespace-only query', 'card.spec.ts', '   '],
  ])('returns null for %s', (_label, text, query) => {
    expect(fuzzyMatch(text, query)).toBeNull();
  });

  it('prefers the contiguous run over the earlier scattered one', () => {
    // The bug a greedy left-to-right scan has: it takes the `a` at index 0 and
    // is then stuck spelling the query out of the hyphens. The highlight lands
    // on the wrong letters, which is the one thing a reader notices instantly.
    expect(hits('a-b-c-abc', 'abc')).toEqual(['abc']);
    expect(fuzzyMatch('a-b-c-abc', 'abc')?.ranges).toEqual([{ start: 6, end: 9 }]);
  });

  it('prefers word starts when there is no contiguous run', () => {
    expect(hits('order-total.spec.ts', 'ot')).toEqual(['o', 't']);
    expect(fuzzyMatch('order-total.spec.ts', 'ot')?.ranges).toEqual([
      { start: 0, end: 1 },
      { start: 6, end: 7 },
    ]);
  });

  it('reads a camelCase seam as a word start', () => {
    expect(fuzzyMatch('orderTotal', 'ot')?.ranges).toEqual([
      { start: 0, end: 1 },
      { start: 5, end: 6 },
    ]);
  });

  it('scores a contiguous match above a scattered one of the same length', () => {
    const tight = fuzzyMatch('checkout.spec.ts', 'check');
    const loose = fuzzyMatch('c-h-e-c-k.spec.ts', 'check');
    expect(tight!.score).toBeGreaterThan(loose!.score);
  });

  it('scores a longer match above a shorter one of the same shape', () => {
    expect(fuzzyMatch('card.spec.ts', 'card')!.score).toBeGreaterThan(
      fuzzyMatch('card.spec.ts', 'car')!.score,
    );
  });

  it('merges adjacent characters into one range and leaves gaps as separate ones', () => {
    expect(fuzzyMatch('abcdef', 'abef')?.ranges).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ]);
  });

  it('takes the leftmost of two equally good matches', () => {
    expect(fuzzyMatch('ab-ab', 'ab')?.ranges).toEqual([{ start: 0, end: 2 }]);
  });

  it('falls back to a substring hit rather than refusing an outsized input', () => {
    // Past the table size a plain scan is the honest answer; returning null
    // would make a long generated name unsearchable.
    const long = `${'x'.repeat(600)}needle${'y'.repeat(50)}`;
    expect(fuzzyMatch(long, 'needle')?.ranges).toEqual([{ start: 600, end: 606 }]);
    expect(fuzzyMatch(long, 'nedle')).toBeNull();
    const longQuery = 'q'.repeat(80);
    expect(fuzzyMatch(`a-${longQuery}-b`, longQuery)?.ranges).toEqual([{ start: 2, end: 82 }]);
  });

  it('does not desync its indices on a character whose lowercase is longer', () => {
    // 'İ'.toLowerCase() is two UTF-16 units. Lowercasing the whole string would
    // shift every index after it and underline the wrong letters.
    const text = 'İstanbul-card.spec.ts';
    expect(hits(text, 'card')).toEqual(['card']);
  });
});

describe('matchTree', () => {
  const SUITE = [
    mk('checkout/order-total.spec.ts'),
    mk('checkout/payment/card.spec.ts'),
    mk('checkout/payment/paypal.spec.ts'),
    mk('login.spec.ts'),
    mk('fixtures/users.json'),
  ];

  it.each([
    ['an empty query', ''],
    ['a whitespace-only query', '  \t '],
  ])('returns the very same tree for %s', (_label, query) => {
    const model = buildTree(SUITE);
    const result = matchTree(model.roots, query);
    // Identity, not a rebuild: clearing the search box must not bust the memo
    // the panel holds on these nodes.
    expect(result.roots).toBe(model.roots);
    expect(result.active).toBe(false);
    expect(result.matchCount).toBe(0);
    expect(result.expand.size).toBe(0);
  });

  it('keeps only the matching files and the folders above them', () => {
    const model = buildTree(SUITE);
    const result = matchTree(model.roots, 'card');
    expect(shape(result.roots)).toEqual(['0:checkout', '1:payment', '2:card.spec.ts']);
    expect(result.active).toBe(true);
    expect(result.matchCount).toBe(1);
  });

  it('forces open every folder it kept for a descendant', () => {
    const model = buildTree(SUITE);
    const result = matchTree(model.roots, 'card');
    expect(result.expand).toEqual(new Set(['checkout', 'checkout/payment']));
  });

  it('highlights the matched row and nothing else', () => {
    const model = buildTree(SUITE);
    const result = matchTree(model.roots, 'card');
    expect([...result.ranges.keys()]).toEqual(['checkout/payment/card.spec.ts']);
    expect(result.ranges.get('checkout/payment/card.spec.ts')).toEqual([{ start: 0, end: 4 }]);
  });

  it('keeps a matching folder whole, and does not force it open', () => {
    // Someone typing `payment` at a folder called payment is asking to see the
    // folder — not to have its contents hidden for failing to spell it too.
    const model = buildTree(SUITE);
    const result = matchTree(model.roots, 'payment');
    expect(shape(result.roots)).toEqual([
      '0:checkout',
      '1:payment',
      '2:card.spec.ts',
      '2:paypal.spec.ts',
    ]);
    expect(result.expand).toEqual(new Set(['checkout']));
    expect(result.ranges.has('checkout/payment')).toBe(true);
    expect(result.matchCount).toBe(1);
  });

  it('returns nothing at all when nothing matches', () => {
    const model = buildTree(SUITE);
    const result = matchTree(model.roots, 'zzzz');
    expect(result.roots).toEqual([]);
    expect(result.active).toBe(true);
    expect(result.matchCount).toBe(0);
  });

  it('recounts the folders it filtered so a row cannot claim more than it shows', () => {
    const model = buildTree([
      mk('checkout/card.spec.ts', { reviewFlags: ['selector'] }),
      mk('checkout/other.spec.ts', { reviewFlags: ['selector'] }),
    ]);
    const result = matchTree(model.roots, 'card');
    const checkout = findNode(result.roots, 'checkout');
    expect(checkout?.kind === 'dir' && checkout.fileCount).toBe(1);
    expect(checkout?.kind === 'dir' && checkout.flagCount).toBe(1);
  });

  it('leaves the counters that describe the folder rather than the query alone', () => {
    const model = buildTree([mk('checkout/card.spec.ts'), mk('checkout/noise.log')], { hide: ['*.log'] });
    const result = matchTree(model.roots, 'card');
    const checkout = findNode(result.roots, 'checkout');
    expect(checkout?.kind === 'dir' && checkout.hiddenCount).toBe(1);
  });

  it('does not mutate the tree it filtered', () => {
    const model = buildTree(SUITE);
    const before = JSON.stringify(model.roots);
    matchTree(model.roots, 'card');
    expect(JSON.stringify(model.roots)).toBe(before);
  });

  it('matches a compacted row against its whole label', () => {
    const model = buildTree([mk('hand-written/checkout/deep/case.spec.ts')], { compactFolders: true });
    const result = matchTree(model.roots, 'checkout/deep');
    expect(shape(result.roots)).toEqual(['0:hand-written/checkout/deep', '1:case.spec.ts']);
    expect(result.ranges.get('hand-written')).toEqual([{ start: 13, end: 26 }]);
  });

  it('filters a feature-grouped tree by the test names it shows', () => {
    const model = buildTree(
      [
        mk('a.spec.ts', { name: 'Order total', feature: 'Checkout' }),
        mk('b.spec.ts', { name: 'Signs in', feature: 'Auth' }),
      ],
      { grouping: 'feature' },
    );
    const result = matchTree(model.roots, 'order');
    expect(shape(result.roots)).toEqual(['0:Checkout', '1:Order total']);
    expect(result.expand).toEqual(new Set(['feature:Checkout']));
  });

  it('matches a feature group by its own name and keeps the group whole', () => {
    const model = buildTree(
      [
        mk('a.spec.ts', { name: 'Order total', feature: 'Checkout' }),
        mk('b.spec.ts', { name: 'Coupon', feature: 'Checkout' }),
      ],
      { grouping: 'feature' },
    );
    const result = matchTree(model.roots, 'checkout');
    expect(shape(result.roots)).toEqual(['0:Checkout', '1:Coupon', '1:Order total']);
    expect(result.expand.size).toBe(0);
  });
});
