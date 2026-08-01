/**
 * Tests for the DOM diff.
 *
 * Two properties matter more than any individual finding, and most of what is
 * below is one of the two.
 *
 * **No false positives.** This endpoint exists to tell someone at 2am which
 * element broke their locator. A diff that reports a change nobody made costs
 * more than no diff at all, so: identical input produces an empty result, a
 * bundler rename produces an empty result, and a wrapper div appearing produces
 * an empty result. The volatile-attribute cases are all this property.
 *
 * **No silent losses.** Everything the filter hides has to be countable, and a
 * damaged artifact has to degrade rather than throw — a truncated trace is a
 * normal consequence of killing a worker, not an exceptional one.
 *
 * The raw snapshot literals below are Playwright's real on-disk format, which
 * is why they look the way they do: `["TAG", {attrs}, ...children]` for an
 * element, a bare string for text, and `[[distance, index]]` for "this subtree
 * did not change, reuse node `index` from `distance` snapshots back". That last
 * shape is most of a real trace, and getting its indexing wrong resolves every
 * reference to the wrong element without erroring — hence `describe('back
 * references')`.
 */

import { describe, expect, it } from 'vitest';
import {
  diffSnapshots,
  extractLocators,
  groupByFrame,
  locatorMatches,
  normaliseSnapshot,
  parseTraceSnapshots,
  pickAnchor,
  samePage,
  snapshotFromTrace,
  type DomChangeKind,
  type DomElement,
  type RawFrameSnapshot,
  type RawNode,
} from './dom-diff.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function snapshot(html: RawNode, over: Partial<RawFrameSnapshot> = {}): RawFrameSnapshot {
  return {
    frameId: 'frame@1',
    frameUrl: 'http://localhost:5050/cart',
    isMainFrame: true,
    snapshotName: 'after@call@1',
    wallTime: 1_700_000_000_000,
    html,
    ...over,
  };
}

/** A page body, wrapped in the HTML/BODY the real serializer always emits. */
function page(...body: RawNode[]): RawNode {
  return ['HTML', { lang: 'en' }, ['BODY', {}, ...body]];
}

function one(html: RawNode, over?: Partial<RawFrameSnapshot>) {
  return normaliseSnapshot([snapshot(html, over)], 0);
}

function kinds(changes: Array<{ kind: DomChangeKind }>): DomChangeKind[] {
  return changes.map((change) => change.kind);
}

function find(elements: DomElement[], predicate: (element: DomElement) => boolean): DomElement {
  const hit = elements.find(predicate);
  if (!hit) throw new Error('expected element not found in snapshot');
  return hit;
}

// ─── the snapshot format ─────────────────────────────────────────────────────

describe('back references', () => {
  /**
   * Playwright numbers nodes post-order (children before their parent) and
   * skips reference nodes entirely. An off-by-one here does not throw — it
   * quietly resolves to the neighbouring element — so this pins the numbering
   * against a hand-counted example.
   */
  it('resolves a reference to the right node of an earlier snapshot', () => {
    const first = snapshot(
      page(['BUTTON', { 'data-testid': 'buy' }, 'Buy now'], ['P', {}, 'Free shipping']),
    );
    // Post-order of `first`: 0 "Buy now", 1 BUTTON, 2 "Free shipping", 3 P,
    // 4 BODY, 5 HTML. So [[1, 1]] is the BUTTON as it was one snapshot ago.
    const second = snapshot(['HTML', { lang: 'en' }, ['BODY', {}, [[1, 1]], ['P', {}, 'Now $9']]]);

    const resolved = normaliseSnapshot([first, second], 1);
    const button = find(resolved.elements, (element) => element.tag === 'BUTTON');
    expect(button.testId).toBe('buy');
    expect(button.name).toBe('Buy now');
  });

  it('drops a reference that points outside the trace instead of throwing', () => {
    // A trace truncated mid-write leaves references to snapshots that were
    // never flushed. The surviving markup is still worth showing.
    const only = snapshot(['HTML', {}, ['BODY', {}, [[9, 4]], ['H1', {}, 'Cart']]]);
    const resolved = normaliseSnapshot([only], 0);
    expect(resolved.elements.map((element) => element.tag)).toEqual(['HTML', 'BODY', 'H1']);
  });
});

describe('parseTraceSnapshots', () => {
  it('keeps every good line when the last one is truncated', () => {
    const good = JSON.stringify({ type: 'frame-snapshot', snapshot: snapshot(page(['P', {}, 'a'])) });
    const other = JSON.stringify({ type: 'log', message: 'ignored' });
    const body = `${good}\n${other}\n${good}\n{"type":"frame-snapshot","snapsh`;
    expect(parseTraceSnapshots(body)).toHaveLength(2);
  });

  it('groups by frame, because references never cross a frame boundary', () => {
    const main = JSON.stringify({
      type: 'frame-snapshot',
      snapshot: snapshot(page(['P', {}, 'main']), { frameId: 'frame@main' }),
    });
    const iframe = JSON.stringify({
      type: 'frame-snapshot',
      snapshot: snapshot(page(['P', {}, 'inner']), { frameId: 'frame@inner', isMainFrame: false }),
    });
    const grouped = groupByFrame(parseTraceSnapshots(`${main}\n${iframe}\n${main}`));
    expect([...grouped.keys()].sort()).toEqual(['frame@inner', 'frame@main']);
    expect(grouped.get('frame@main')).toHaveLength(2);
  });
});

describe('pickAnchor', () => {
  it('skips about:blank and takes the last real state of the main frame', () => {
    const blank = snapshot(['HTML', {}, ['BODY']], { frameUrl: 'about:blank' });
    const products = snapshot(page(['H1', {}, 'Products']), {
      frameUrl: 'http://localhost:5050/products',
    });
    const cart = snapshot(page(['H1', {}, 'Cart']), { frameUrl: 'http://localhost:5050/cart' });

    const anchor = pickAnchor([blank, products, cart]);
    expect(anchor?.snapshot.frameUrl).toBe('http://localhost:5050/cart');
  });

  it('lines the baseline up with the page the failing side ended on', () => {
    // The green run carried on to /receipt after /cart. Diffing /cart against
    // /receipt would report every element as changed, which is true and useless.
    const cart = snapshot(page(['H1', {}, 'Cart']), { frameUrl: 'http://localhost:5050/cart' });
    const receipt = snapshot(page(['H1', {}, 'Thanks']), {
      frameUrl: 'http://localhost:5050/receipt',
    });

    const anchor = pickAnchor([cart, receipt], 'http://other-host:9999/cart?session=abc');
    expect(anchor?.snapshot.frameUrl).toBe('http://localhost:5050/cart');
  });

  it('returns null when the trace holds nothing renderable', () => {
    expect(pickAnchor([])).toBeNull();
    expect(pickAnchor([snapshot(['HTML', {}, ['BODY']], { frameUrl: 'about:blank' })])).toBeNull();
  });
});

// ─── roles and names ─────────────────────────────────────────────────────────

describe('roles', () => {
  it('reads implicit roles from the tag, and an explicit role wins', () => {
    const resolved = one(
      page(
        ['BUTTON', {}, 'Save'],
        ['A', { href: '/cart' }, 'Cart'],
        ['A', {}, 'anchor with no href'],
        ['INPUT', { type: 'search' }],
        ['INPUT', { type: 'checkbox' }],
        ['DIV', { role: 'button' }, 'Custom'],
        ['H2', {}, 'Totals'],
      ),
    );
    const roles = Object.fromEntries(
      resolved.elements.map((element) => [describeKey(element), element.role]),
    );
    expect(roles['BUTTON:Save']).toBe('button');
    expect(roles['A:Cart']).toBe('link');
    expect(roles['A:anchor with no href']).toBe('');
    expect(roles['INPUT:']).toBeDefined();
    expect(roles['DIV:Custom']).toBe('button');
    expect(roles['H2:Totals']).toBe('heading');
    expect(find(resolved.elements, (e) => e.attrs.type === 'search').role).toBe('searchbox');
    expect(find(resolved.elements, (e) => e.attrs.type === 'checkbox').role).toBe('checkbox');
  });

  it('treats alt="" as decoration rather than an image', () => {
    const resolved = one(page(['IMG', { alt: '', src: '/divider.svg' }]));
    expect(find(resolved.elements, (e) => e.tag === 'IMG').role).toBe('presentation');
  });
});

function describeKey(element: DomElement): string {
  return `${element.tag}:${element.text || element.name}`;
}

describe('accessible name', () => {
  it('follows the precedence a getByRole name option resolves in', () => {
    const resolved = one(
      page(
        ['SPAN', { id: 'lbl' }, 'Labelled by this'],
        ['BUTTON', { 'aria-labelledby': 'lbl', 'aria-label': 'ignored' }, 'also ignored'],
        ['BUTTON', { 'aria-label': 'From aria-label' }, 'ignored too'],
        ['BUTTON', {}, 'From content'],
        ['BUTTON', { title: '' }],
      ),
    );
    const buttons = resolved.elements.filter((element) => element.tag === 'BUTTON');
    expect(buttons.map((b) => b.name)).toEqual([
      'Labelled by this',
      'From aria-label',
      'From content',
      '',
    ]);
    expect(buttons[0]!.nameSource).toBe('aria-labelledby');
    expect(buttons[2]!.nameSource).toBe('text content');
  });

  it('names a form control from its <label for>, then its placeholder', () => {
    const resolved = one(
      page(
        ['LABEL', { for: 'q' }, 'Search products'],
        ['INPUT', { id: 'q', type: 'search' }],
        ['INPUT', { type: 'text', placeholder: 'Coupon code' }],
        ['LABEL', {}, 'Wrapped', ['INPUT', { type: 'text' }]],
      ),
    );
    const inputs = resolved.elements.filter((element) => element.tag === 'INPUT');
    expect(inputs.map((i) => [i.name, i.nameSource])).toEqual([
      ['Search products', '<label for>'],
      ['Coupon code', 'placeholder'],
      ['Wrapped', 'wrapping <label>'],
    ]);
  });

  it('prefers the live value Playwright recorded over the server-rendered one', () => {
    // The `value` attribute is what the server sent; __playwright_value_ is what
    // the field actually held when the action ran. Only the second one explains
    // a failed assertion on user input.
    const resolved = one(page(['INPUT', { type: 'text', value: '', __playwright_value_: 'typed' }]));
    expect(find(resolved.elements, (e) => e.tag === 'INPUT').attrs.value).toBe('typed');
  });
});

// ─── the volatile-attribute filter ───────────────────────────────────────────

describe('volatile attributes', () => {
  it('ignores generated ids and hashed classes, and says that it did', () => {
    const before = one(
      page(['BUTTON', { id: ':r1:', class: 'css-1a2b3c btn-primary', nonce: 'aaa' }, 'Pay']),
    );
    const after = one(
      page(['BUTTON', { id: ':r9:', class: 'css-9z8y7x btn-primary', nonce: 'bbb' }, 'Pay']),
    );

    const result = diffSnapshots(before, after);
    expect(result.changes).toEqual([]);

    // Hidden, but never silently: the caller can render exactly what was
    // dropped and why.
    expect(result.ignoredAttributes.map((entry) => entry.attribute).sort()).toEqual([
      'class',
      'id',
      'nonce',
    ]);
    expect(result.ignoredAttributes.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it('keeps a class attribute that is entirely human-written', () => {
    const resolved = one(page(['DIV', { class: 'card featured' }, 'x']));
    expect(find(resolved.elements, (e) => e.tag === 'DIV').attrs.class).toBe('card featured');
    expect(resolved.ignoredAttributes).toEqual([]);
  });

  it('keeps the readable half of a mixed class list', () => {
    const resolved = one(page(['DIV', { class: 'sc-hJRrtL product-card' }, 'x']));
    expect(find(resolved.elements, (e) => e.tag === 'DIV').attrs.class).toBe('product-card');
  });

  it('keeps a hand-written id, because a locator can legitimately use it', () => {
    const resolved = one(page(['DIV', { id: 'order-summary' }, 'x']));
    expect(find(resolved.elements, (e) => e.tag === 'DIV').id).toBe('order-summary');
  });

  it('compares asset paths without their cache-busting query', () => {
    const before = one(page(['IMG', { alt: 'Logo', src: '/logo.svg?v=8f2a1c' }]));
    const after = one(page(['IMG', { alt: 'Logo', src: '/logo.svg?v=b31d90' }]));
    expect(diffSnapshots(before, after).changes).toEqual([]);
  });

  it('still resolves aria-labelledby through an id it is about to ignore', () => {
    // Order matters: names are computed on the raw attributes, and only then
    // are volatile ones stripped. Doing it the other way round loses the name.
    const resolved = one(
      page(['SPAN', { id: ':r4:' }, 'Total due'], ['DIV', { role: 'status', 'aria-labelledby': ':r4:' }]),
    );
    expect(find(resolved.elements, (e) => e.role === 'status').name).toBe('Total due');
    expect(find(resolved.elements, (e) => e.role === 'status').id).toBeNull();
  });
});

// ─── the diff itself ─────────────────────────────────────────────────────────

describe('diffSnapshots', () => {
  it('reports nothing when the page is unchanged', () => {
    const html = page(
      ['NAV', {}, ['A', { href: '/cart' }, 'Cart (0)']],
      ['MAIN', {}, ['BUTTON', { 'data-testid': 'pay' }, 'Pay now']],
    );
    const result = diffSnapshots(one(html), one(html));
    expect(result.changes).toEqual([]);
    expect(result.counts.matched).toBe(result.counts.before);
  });

  it('catches the case the whole feature exists for: same button, new name', () => {
    const before = one(page(['MAIN', {}, ['BUTTON', { class: 'buy' }, 'Add to cart']]));
    const after = one(page(['MAIN', {}, ['BUTTON', { class: 'buy' }, 'Add to bag']]));

    const locators = extractLocators(
      "await page.getByRole('button', { name: 'Add to cart' }).click();",
    );
    const result = diffSnapshots(before, after, { locators });

    const rename = result.changes.find((change) => change.kind === 'NAME_CHANGED');
    expect(rename?.summary).toContain('"Add to cart" → "Add to bag"');
    // The test's own locator names it, so it leads the list rather than sitting
    // in the context pile.
    expect(result.changes[0]).toBe(rename);
    expect(rename?.touchedByTest).toBe(true);
    expect(rename?.matchedLocators).toEqual(["getByRole('button', { name: 'Add to cart' })"]);
    expect(result.findingCount).toBe(1);
  });

  it('reports a control that lost its accessible name entirely', () => {
    const before = one(page(['BUTTON', { 'data-testid': 'pay', 'aria-label': 'Pay now' }]));
    const after = one(page(['BUTTON', { 'data-testid': 'pay' }]));

    const [change] = diffSnapshots(before, after).changes;
    expect(change?.kind).toBe('NAME_CHANGED');
    expect(change?.summary).toContain('unreachable by name');
  });

  it('reports a renamed test id — the loudest break with the quietest symptom', () => {
    // Same element, same name, same place. getByTestId returns nothing and the
    // screenshot looks identical, which is why this needs saying out loud.
    const before = one(page(['SPAN', { 'data-testid': 'order-total' }, '$44.28']));
    const after = one(page(['SPAN', { 'data-testid': 'cart-total' }, '$44.28']));

    const result = diffSnapshots(before, after, {
      locators: extractLocators("page.getByTestId('order-total')"),
    });
    expect(kinds(result.changes)).toEqual(['TESTID_CHANGED']);
    expect(result.changes[0]!.summary).toContain("getByTestId('order-total') no longer resolves");
    expect(result.changes[0]!.touchedByTest).toBe(true);
  });

  it('reports a hand-written id changing, but not a generated one', () => {
    const before = one(page(['DIV', { id: 'order-summary' }, 'x'], ['P', { id: ':r1:' }, 'y']));
    const after = one(page(['DIV', { id: 'summary' }, 'x'], ['P', { id: ':r7:' }, 'y']));

    expect(kinds(diffSnapshots(before, after).changes)).toEqual(['ID_CHANGED']);
  });

  it('reports a role change, which is what silently breaks getByRole', () => {
    const before = one(page(['BUTTON', { 'data-testid': 'menu' }, 'Menu']));
    const after = one(page(['A', { 'data-testid': 'menu', href: '#' }, 'Menu']));

    const change = diffSnapshots(before, after).changes.find((c) => c.kind === 'ROLE_CHANGED');
    expect(change?.summary).toContain('from button to link');
  });

  it('reports a move when the element changed parent', () => {
    const before = one(page(['HEADER', {}, ['BUTTON', { 'data-testid': 'pay' }, 'Pay']]));
    const after = one(page(['HEADER', {}], ['FOOTER', {}, ['BUTTON', { 'data-testid': 'pay' }, 'Pay']]));

    const change = diffSnapshots(before, after).changes.find((c) => c.kind === 'MOVED');
    expect(change?.summary).toMatch(/moved/);
    expect(change?.before?.path).toContain('header');
    expect(change?.after?.path).toContain('footer');
  });

  it('separates hidden from removed, because they fail differently', () => {
    const before = one(page(['DIV', { 'data-testid': 'banner' }, 'Free shipping']));
    const after = one(page(['DIV', { 'data-testid': 'banner', hidden: '' }, 'Free shipping']));

    const change = diffSnapshots(before, after).changes.find((c) => c.kind === 'HIDDEN');
    expect(change?.summary).toContain('in the DOM but not visible');
  });

  it('treats display:none in a style attribute as hidden, and inherits it', () => {
    const before = one(page(['DIV', {}, ['BUTTON', { 'data-testid': 'pay' }, 'Pay']]));
    const after = one(
      page(['DIV', { style: 'display: none' }, ['BUTTON', { 'data-testid': 'pay' }, 'Pay']]),
    );
    const hidden = diffSnapshots(before, after).changes.filter((c) => c.kind === 'HIDDEN');
    // Both the container and the button it swallowed.
    expect(hidden.map((c) => c.after?.testId)).toContain('pay');
  });

  it('reports a newly disabled control, which times out rather than 404s', () => {
    const before = one(page(['BUTTON', { 'data-testid': 'pay' }, 'Pay']));
    const after = one(page(['BUTTON', { 'data-testid': 'pay', disabled: '' }, 'Pay']));

    const change = diffSnapshots(before, after).changes.find((c) => c.kind === 'DISABLED');
    expect(change?.summary).toContain('will time out');
  });

  it('reports changed text once, on the deepest node that changed', () => {
    const before = one(
      page(['MAIN', {}, ['SECTION', {}, ['SPAN', { 'data-testid': 'total' }, '$41.00']]]),
    );
    const after = one(
      page(['MAIN', {}, ['SECTION', {}, ['SPAN', { 'data-testid': 'total' }, '$44.28']]]),
    );

    const changed = diffSnapshots(before, after).changes.filter((c) => c.kind === 'TEXT_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.after?.testId).toBe('total');
  });

  it('ignores a wrapper element appearing around unchanged content', () => {
    // A styling refactor adds hundreds of these. None can break a locator.
    const before = one(page(['MAIN', {}, ['BUTTON', { 'data-testid': 'pay' }, 'Pay']]));
    const after = one(
      page(['MAIN', {}, ['DIV', {}, ['DIV', {}, ['BUTTON', { 'data-testid': 'pay' }, 'Pay']]]]),
    );

    const result = diffSnapshots(before, after);
    // The button moved — that is real and reported. The two anonymous divs are
    // not reported at all.
    expect(kinds(result.changes)).toEqual(['MOVED']);
  });

  it('does not cross-match five identical cards onto each other', () => {
    const card = (id: string, label: string): RawNode => [
      'ARTICLE',
      { 'data-testid': id },
      ['BUTTON', {}, label],
    ];
    const before = one(page(card('p-1', 'Add kettle'), card('p-2', 'Add grinder')));
    const after = one(page(card('p-1', 'Add kettle'), card('p-2', 'Add scale')));

    const result = diffSnapshots(before, after);
    expect(kinds(result.changes)).toEqual(['NAME_CHANGED']);
    expect(result.changes[0]!.before?.name).toBe('Add grinder');
  });

  it('flags the element the failing action targeted even without a locator', () => {
    // Playwright marks it in the trace. A test built from a variable selector
    // yields no parseable locator, and this is what keeps the finding rankable.
    const before = one(page(['BUTTON', { 'data-testid': 'pay' }, 'Pay now']));
    const after = one(page(['BUTTON', { 'data-testid': 'pay', __playwright_target__: '' }, 'Pay']));

    const result = diffSnapshots(before, after);
    expect(result.findingCount).toBe(1);
    expect(result.changes[0]!.actionTarget).toBe(true);
  });

  it('caps context but never drops a finding', () => {
    const noise = (n: number): RawNode[] =>
      Array.from({ length: n }, (_, i) => ['P', { id: `note-${i}` }, `note ${i}`] as RawNode);

    const before = one(page(['BUTTON', { 'data-testid': 'pay' }, 'Pay now']));
    const after = one(page(['BUTTON', { 'data-testid': 'pay' }, 'Pay later'], ...noise(20)));

    const result = diffSnapshots(before, after, {
      locators: extractLocators("page.getByTestId('pay')"),
      maxContext: 5,
    });
    expect(result.findingCount).toBe(1);
    expect(result.changes[0]!.touchedByTest).toBe(true);
    expect(result.contextCount).toBe(5);
    expect(result.truncated).toBe(15);
  });

  it('marks two different pages as not comparable', () => {
    const before = one(page(['H1', {}, 'Cart']), { frameUrl: 'http://localhost:5050/cart' });
    const after = one(page(['H1', {}, 'Login']), { frameUrl: 'http://localhost:5050/login' });
    expect(diffSnapshots(before, after).urlsComparable).toBe(false);
  });
});

describe('samePage', () => {
  it('ignores host, port and query, because only the route is the identity', () => {
    expect(samePage('http://localhost:5050/cart?sid=1', 'http://staging.test/cart')).toBe(true);
    expect(samePage('http://localhost:5050/cart/', 'http://localhost:5050/cart')).toBe(true);
    expect(samePage('http://localhost:5050/cart', 'http://localhost:5050/checkout')).toBe(false);
  });

  it('is false when either side has no url at all', () => {
    expect(samePage('', 'http://localhost:5050/cart')).toBe(false);
  });
});

// ─── locators ────────────────────────────────────────────────────────────────

describe('extractLocators', () => {
  it('reads the locator forms a Playwright spec actually uses', () => {
    const code = `
      await page.goto('/products');
      await page.getByRole('button', { name: 'Add Gooseneck Kettle to cart' }).click();
      await page.getByTestId('order-total').textContent();
      await page.getByLabel('Search products').fill('kettle');
      await page.getByPlaceholder('e.g. grinder').press('Enter');
      await page.locator('[data-testid="shipping"]').textContent();
      await page.locator('#coupon').fill('FREE');
      await page.click('.checkout-cta');
    `;
    const locators = extractLocators(code);
    const byKind = (kind: string) => locators.filter((l) => l.kind === kind).map((l) => l.value);

    expect(byKind('role')).toEqual(['button']);
    expect(locators.find((l) => l.kind === 'role')?.name).toBe('Add Gooseneck Kettle to cart');
    expect(byKind('testid').sort()).toEqual(['order-total', 'shipping']);
    expect(byKind('label')).toEqual(['Search products']);
    expect(byKind('placeholder')).toEqual(['e.g. grinder']);
    expect(byKind('css').sort()).toEqual(['#coupon', '.checkout-cta']);
  });

  it('does not mistake a typed value for a selector', () => {
    // `.fill('kettle')` on a locator types "kettle"; `page.fill('#q', 'kettle')`
    // targets "#q". Confusing the two invents a locator that can match a real
    // element and outrank the actual finding.
    const locators = extractLocators(`
      await page.getByLabel('Search products').fill('kettle');
      await page.getByRole('button', { name: 'Go' }).press('Enter');
      await page.fill('#coupon', 'FREE');
    `);
    expect(locators.filter((l) => l.kind === 'css').map((l) => l.value)).toEqual(['#coupon']);
  });

  it('returns nothing rather than throwing on source it cannot read', () => {
    expect(extractLocators(null, undefined, '')).toEqual([]);
    expect(extractLocators('const sel = buildSelector(x); page.locator(sel)')).toEqual([]);
  });

  it('renders each locator the way it was written, for display', () => {
    const [locator] = extractLocators("page.getByRole('link', { name: 'Cart' })");
    expect(locator?.expression).toBe("getByRole('link', { name: 'Cart' })");
  });
});

describe('locatorMatches', () => {
  const elements = one(
    page(
      ['BUTTON', { 'data-testid': 'pay', class: 'cta primary' }, 'Pay now'],
      ['A', { href: '/cart', id: 'cart-link' }, 'Cart (2)'],
    ),
  ).elements;
  const button = find(elements, (element) => element.testId === 'pay');
  const link = find(elements, (element) => element.tag === 'A');

  it('matches a test id exactly, never loosely', () => {
    expect(locatorMatches({ kind: 'testid', value: 'pay', expression: '' }, button)).toBe(true);
    expect(locatorMatches({ kind: 'testid', value: 'pa', expression: '' }, button)).toBe(false);
  });

  it('matches a role with a name the way Playwright does — loosely', () => {
    expect(
      locatorMatches({ kind: 'role', value: 'button', name: 'pay', expression: '' }, button),
    ).toBe(true);
    expect(
      locatorMatches({ kind: 'role', value: 'link', name: 'Pay now', expression: '' }, button),
    ).toBe(false);
  });

  it('matches the simple css a hand-written locator uses', () => {
    expect(locatorMatches({ kind: 'css', value: '#cart-link', expression: '' }, link)).toBe(true);
    expect(locatorMatches({ kind: 'css', value: '.cta', expression: '' }, button)).toBe(true);
    expect(locatorMatches({ kind: 'css', value: 'nav .cta', expression: '' }, button)).toBe(true);
    expect(locatorMatches({ kind: 'css', value: '.cta', expression: '' }, link)).toBe(false);
  });

  it('declines to guess at css it does not fully understand', () => {
    // Better to leave the change in the context pile than to promote the wrong
    // element to "this is what your test was looking for".
    expect(
      locatorMatches({ kind: 'css', value: 'button:nth-child(2)', expression: '' }, button),
    ).toBe(false);
  });
});

// ─── end to end over a trace body ────────────────────────────────────────────

describe('snapshotFromTrace', () => {
  it('turns a trace body into the state the page ended in', () => {
    const lines = [
      { type: 'context-options', browserName: 'chromium' },
      {
        type: 'frame-snapshot',
        snapshot: snapshot(['HTML', {}, ['BODY']], { frameUrl: 'about:blank' }),
      },
      {
        type: 'frame-snapshot',
        snapshot: snapshot(page(['H1', {}, 'Cart'], ['SPAN', { 'data-testid': 'total' }, '$41.00']), {
          frameUrl: 'http://localhost:5050/cart',
        }),
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n');

    const resolved = snapshotFromTrace(lines);
    expect(resolved?.frameUrl).toBe('http://localhost:5050/cart');
    expect(find(resolved!.elements, (e) => e.testId === 'total').text).toBe('$41.00');
  });

  it('returns null for a trace with no page in it, rather than an empty diff', () => {
    // "No snapshot" and "nothing changed" are different answers and the caller
    // has to be able to tell them apart.
    expect(snapshotFromTrace('')).toBeNull();
    expect(snapshotFromTrace('{"type":"log","message":"hi"}')).toBeNull();
  });
});
