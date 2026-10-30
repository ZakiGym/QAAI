/**
 * Safety tests for test impact analysis.
 *
 * This module decides which tests NOT to run, so its failure mode is unlike
 * anything else in the codebase: a bug here does not surface as an error, it
 * surfaces as a green check on a broken build. The contract — stated in
 * impact.ts and enforced here — is that **"I don't know" must resolve to RUN,
 * never to SKIP.**
 *
 * Every case below is a fail-open violation that an adversarial review actually
 * reproduced. They are kept as tests rather than as a fixed changelog entry
 * because each one was a *plausible* reading of the code: the analysis was
 * confident and wrong, which is the only dangerous state this module has.
 */

import { describe, expect, it } from 'vitest';
import {
  analyzeImpact,
  patchCoverage,
  type ImpactTestInput,
  type PatchCoverageRow,
} from './impact.js';

const t = (over: Partial<ImpactTestInput> & { id: string }): ImpactTestInput => ({
  name: over.id,
  filePath: `specs/${over.id}.spec.ts`,
  code: null,
  spec: null,
  tags: [],
  feature: null,
  priority: 'IMPORTANT',
  ...over,
});

const checkout = t({
  id: 'checkout',
  name: 'Checkout completes',
  code: "await page.goto('/checkout'); await expect(page).toHaveURL(/\\/checkout\\/success/);",
  feature: 'Checkout',
  priority: 'CRITICAL_PATH',
});
const about = t({ id: 'about', name: 'About renders', code: "page.goto('/about')" });

function runIds(changedPaths: string[], tests: ImpactTestInput[]): string[] {
  return analyzeImpact({ changedPaths, tests }).run.map((r) => r.testId);
}

describe('a confident-but-wrong attribution never parks a test', () => {
  it('runs the checkout test when an API handler changes', () => {
    // The file layout proves which URL SERVES the handler, and says nothing
    // about which pages CALL it. Breaking order creation is the archetypal
    // change that breaks checkout without touching a checkout file.
    expect(runIds(['app/api/orders/route.ts'], [checkout, about])).toContain('checkout');
    expect(runIds(['src/pages/api/orders.ts'], [checkout, about])).toContain('checkout');
  });

  it('never skips a test whose only declaration is a tag', () => {
    // A tag is not a coverage claim. This test navigates inside an imported
    // helper, so no route can be extracted and there is nothing to check the
    // diff against.
    const blind = t({
      id: 'blind',
      code: "import {startSession} from './helpers'; await startSession(page);",
      tags: ['smoke'],
      priority: 'CRITICAL_PATH',
    });
    expect(runIds(['app/checkout/page.tsx'], [blind, about])).toContain('blind');
  });

  it('does not read a page-object directory as a framework router', () => {
    // Playwright and Cypress projects conventionally call this `pages/`, which
    // the Pages Router regex matches. `support/pages/LoginPage.ts` is the
    // shared login helper, not "the /loginpage route".
    const booking = t({
      id: 'booking',
      code: "await auth.signIn(page); await page.goto('/classes');",
      priority: 'CRITICAL_PATH',
    });
    expect(
      runIds(['support/pages/LoginPage.ts', 'app/about/page.tsx'], [booking, about]),
    ).toContain('booking');
  });

  it('runs a test whose declared coverage was truncated', () => {
    // Losing evidence must move a test toward RUN. The route cap would
    // otherwise drop this test's 205th route and make it look uncovered.
    const sweep = t({
      id: 'sweep',
      code: Array.from({ length: 205 }, (_, i) => `await page.goto('/p${i}');`).join('\n'),
      priority: 'CRITICAL_PATH',
    });
    expect(runIds(['app/p204/page.tsx'], [sweep, about])).toContain('sweep');
  });

  it('treats docs/ as the product when the suite stands on that route', () => {
    // On Docusaurus/Nextra/VitePress, docs/ IS the routed product.
    const docs = t({ id: 'docs', code: "page.goto('/docs/getting-started')" });
    const home = t({ id: 'home', code: "page.goto('/')", priority: 'CRITICAL_PATH' });
    expect(runIds(['docs/getting-started.md'], [docs, home])).toContain('docs');
  });
});

describe('the fail-open paths hold', () => {
  const cases: Array<[string, string]> = [
    ['a lockfile', 'package-lock.json'],
    ['a build config', 'vite.config.ts'],
    ['request middleware', 'src/middleware.ts'],
    ['the root layout', 'app/layout.tsx'],
    ['an auth module', 'src/auth/session.ts'],
    ['a test-support file', 'e2e/support/login.ts'],
    ['an unattributable source file', 'src/lib/mystery.ts'],
  ];

  it.each(cases)('runs everything for %s', (_label, path) => {
    expect(analyzeImpact({ changedPaths: [path], tests: [checkout, about] }).strategy).toBe(
      'RUN_EVERYTHING',
    );
  });

  it('runs everything when no paths are supplied', () => {
    expect(analyzeImpact({ changedPaths: [], tests: [checkout, about] }).strategy).toBe(
      'RUN_EVERYTHING',
    );
  });
});

describe('but it still selects', () => {
  it('skips an unrelated test when one page changes', () => {
    // If safety had made every answer RUN_EVERYTHING the feature would be
    // pointless, so this guards the other direction.
    const result = analyzeImpact({ changedPaths: ['app/about/page.tsx'], tests: [checkout, about] });
    expect(result.strategy).toBe('SELECTIVE');
    expect(result.run.map((r) => r.testId)).toEqual(['about']);
    expect(result.savedPercent).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Patch coverage: the join between a diff and the coverage denominator.
//
// Both halves of this existed for months in different packages — this file maps
// a diff to routes, `coverage-store.ts` maps routes to tests — and nothing
// joined them, so the product knew "this change lands on three routes" and knew
// "two of your routes have no test" and could state neither together. The
// project-wide percentage moves by tenths on a normal pull request and therefore
// gates nothing; this number goes to 0% the moment a change lands on an
// untested route, which is what makes it able to refuse a merge.
//
// The tests that matter most here are the ones where it REFUSES to answer. A
// patch-coverage percentage computed over a surface we did not fully see is a
// passing number on a change that introduced an untested route, and that lie is
// worse than silence.
// ─────────────────────────────────────────────────────────────────────────────

const route = (identity: string, status: PatchCoverageRow['status'] = 'COVERED'): PatchCoverageRow => ({
  key: `ROUTE:${identity}`,
  status,
  label: identity,
});

function join(
  changedPaths: string[],
  rows: PatchCoverageRow[],
  over: Partial<Parameters<typeof patchCoverage>[0]> & { tests?: ImpactTestInput[] } = {},
) {
  const { tests, ...rest } = over;
  const analysis = analyzeImpact({
    changedPaths,
    tests: tests ?? [checkout, about],
    // The inventory is the other witness to "the app serves this route", which
    // is what lets a page with no test be attributed at all.
    knownRoutes: rows.map((row) => row.key.replace(/^ROUTE:/, '')),
  });
  return patchCoverage({
    attributions: analysis.attributions,
    rows,
    changedPathCount: changedPaths.length,
    ...rest,
  });
}

describe('patch coverage answers when it can see the changed surface', () => {
  it('scores a changed page against the route the inventory holds', () => {
    const result = join(['app/checkout/page.tsx'], [route('/checkout'), route('/about')]);

    expect(result.measured).toBe(true);
    expect(result.denominator).toBe(1);
    expect(result.covered).toBe(1);
    expect(result.percent).toBe(100);
    expect(result.routes.map((r) => [r.route, r.state])).toEqual([['/checkout', 'COVERED']]);
  });

  it('names the changed route that has no test, which is the whole point', () => {
    // The archetypal pull request this gate exists for: a new page, no test.
    const result = join(
      ['app/promo/page.tsx'],
      [route('/checkout'), route('/promo', 'UNCOVERED')],
    );

    expect(result.measured).toBe(true);
    expect(result.percent).toBe(0);
    expect(result.uncovered).toBe(1);
    expect(result.routes[0]).toMatchObject({ route: '/promo', state: 'UNCOVERED' });
  });

  it('keeps a waived route out of the denominator and still shows it', () => {
    const result = join(
      ['app/checkout/page.tsx', 'app/legacy/page.tsx'],
      [route('/checkout'), route('/legacy', 'WAIVED')],
    );
    expect(result.denominator).toBe(1);
    expect(result.waived).toBe(1);
    expect(result.percent).toBe(100);
  });

  it('keeps UNKNOWN in the denominator, exactly as the project number does', () => {
    // An item we cannot reason about is a hole in OUR knowledge. Moving it out
    // of the denominator would raise the percentage every time our extractor
    // got worse.
    const result = join(
      ['app/checkout/page.tsx', 'app/about/page.tsx'],
      [route('/checkout'), route('/about', 'UNKNOWN')],
    );
    expect(result.denominator).toBe(2);
    expect(result.percent).toBe(50);
  });

  it('counts a test that exists but has never run as its own state', () => {
    const result = join(['app/checkout/page.tsx'], [route('/checkout', 'ASSERTED_NOT_RUN')]);
    expect(result.assertedNotRun).toBe(1);
    expect(result.covered).toBe(0);
    // And it is NOT an UNCOVERED route: the two are different facts and only
    // one of them means "nobody wrote a test".
    expect(result.uncovered).toBe(0);
  });

  it('expands a nested layout to everything below its route', () => {
    const result = join(
      ['app/shop/layout.tsx'],
      [route('/shop'), route('/shop/cart', 'UNCOVERED'), route('/about')],
    );
    expect(result.routes.map((r) => r.route)).toEqual(['/shop', '/shop/cart']);
    expect(result.routes.every((r) => r.subtree)).toBe(true);
    expect(result.percent).toBe(50);
  });
});

describe('patch coverage refuses to answer rather than divide by a surface it did not see', () => {
  it('reports a lockfile as unscopeable and names it', () => {
    const result = join(['package-lock.json', 'app/checkout/page.tsx'], [route('/checkout')]);
    expect(result.measured).toBe(false);
    expect(result.percent).toBeNull();
    expect(result.caveats[0]).toContain('package-lock.json');
    expect(result.caveats[0]).toContain('project coverage floor');
  });

  it('reports a file nothing could place rather than scoring the rest', () => {
    // The part we cannot see is exactly where an untested route would be.
    // `attribute()` already calls this one blast radius, so it arrives here as
    // an unscopeable change.
    const result = join(['src/lib/mystery.ts', 'app/checkout/page.tsx'], [route('/checkout')]);
    expect(result.measured).toBe(false);
    expect(result.caveats[0]).toContain('src/lib/mystery.ts');
  });

  it('refuses when a changed file maps to a NAME but to no route', () => {
    // `src/lib/checkout-helpers.ts` matches the suite's "checkout" token, so it
    // is attributable — at LOW confidence, to no route at all. There is no
    // honest way to score a changed surface that includes it: whatever it
    // touches is not in the set of routes we are about to divide by.
    const result = join(
      ['src/lib/checkout-helpers.ts', 'app/checkout/page.tsx'],
      [route('/checkout')],
    );
    expect(result.measured).toBe(false);
    expect(result.caveats[0]).toContain('could not be attributed');
    expect(result.caveats[0]).toContain('checkout-helpers.ts');
  });

  it('says so when the project has no inventory to join against', () => {
    const result = join(['app/checkout/page.tsx'], []);
    expect(result.measured).toBe(false);
    expect(result.caveats[0]).toContain('no stored coverage inventory');
  });

  it('refuses when the changed-file list was capped', () => {
    const result = join(['app/checkout/page.tsx'], [route('/checkout')], { diffTruncated: true });
    expect(result.measured).toBe(false);
    expect(result.caveats[0]).toContain('capped before it was read');
  });

  it('refuses when the inventory read was capped', () => {
    // A route with no row cannot be told apart from a route whose row was past
    // the cap.
    const result = join(['app/checkout/page.tsx'], [route('/checkout')], {
      inventoryTruncated: true,
    });
    expect(result.measured).toBe(false);
    expect(result.caveats[0]).toContain('inventory read was capped');
  });

  it('tells a diff too wide to attribute apart from a diff that changed nothing', () => {
    // `analyzeImpact` returns an empty attribution list for both, and reading
    // the second as the first would report a clean changed surface for a
    // 2,000-file merge commit.
    const wide = patchCoverage({
      attributions: [],
      rows: [route('/checkout')],
      changedPathCount: 2_000,
    });
    expect(wide.measured).toBe(false);
    expect(wide.caveats[0]).toContain('attribution limit');

    const nothing = patchCoverage({ attributions: [], rows: [route('/checkout')] });
    expect(nothing.measured).toBe(false);
    expect(nothing.caveats[0]).toContain('resolved to a route');
  });

  it('a diff of nothing but spec files has no changed surface', () => {
    const result = join(['specs/checkout.spec.ts'], [route('/checkout')]);
    expect(result.measured).toBe(false);
  });
});

describe('a lapsed waiver does not shrink the denominator', () => {
  const NOW = new Date('2026-10-29T12:00:00.000Z');
  const waived = (identity: string, waiverExpiresAt: Date | null | undefined): PatchCoverageRow => ({
    key: `ROUTE:${identity}`,
    status: 'WAIVED',
    label: identity,
    waiverExpiresAt,
  });

  /*
   * WHY THIS IS THE PERCENTAGE THAT MATTERS. `CoverageItem.status` is
   * materialised — the waiver door writes WAIVED eagerly — and nothing
   * recomputes the inventory on a clock, so a lapsed exclusion stays in effect
   * for an unbounded time on a quiet project. WAIVED is the only state that
   * LEAVES the denominator, so the number this gate prints on a pull request
   * was higher than the truth, by exactly the lapsed items.
   */
  it('counts a route whose waiver has expired as a GAP, not as excluded', () => {
    const result = join(
      ['app/admin/legacy/page.tsx', 'app/promo/page.tsx'],
      [
        waived('/admin/legacy', new Date(NOW.getTime() - 1_000)),
        route('/promo', 'UNCOVERED'),
      ],
      { now: NOW },
    );

    expect(result.denominator).toBe(2);
    expect(result.waived).toBe(0);
    expect(result.uncovered).toBe(2);
    expect(result.percent).toBe(0);
    expect(result.caveats.join(' ')).toContain('waiver has lapsed');
  });

  it('keeps excluding a route whose waiver is still in force', () => {
    const result = join(
      ['app/admin/legacy/page.tsx', 'app/promo/page.tsx'],
      [
        waived('/admin/legacy', new Date(NOW.getTime() + 30 * 86_400_000)),
        route('/promo', 'UNCOVERED'),
      ],
      { now: NOW },
    );

    expect(result.denominator).toBe(1);
    expect(result.waived).toBe(1);
    expect(result.caveats.join(' ')).not.toContain('waiver has lapsed');
  });

  it('counts a WAIVED row with NO waiver behind it as a gap', () => {
    // `null` is "we read the waiver and there is none" — a status with nothing
    // behind it. It is not the same fact as `undefined`, which is "not read".
    const result = join(['app/admin/legacy/page.tsx'], [waived('/admin/legacy', null)], {
      now: NOW,
    });

    expect(result.denominator).toBe(1);
    expect(result.waived).toBe(0);
    expect(result.uncovered).toBe(1);
  });

  it('takes a WAIVED row at face value when the caller did not read the waiver', () => {
    /*
     * NULL IS NOT ZERO, and absent is not null. A caller that cannot join the
     * waiver must not be silently given a different denominator from the one
     * it had before the join existed — it gets the old answer, and the caveat
     * that would have disclosed a lapse is absent because nothing was measured.
     */
    const result = join(['app/admin/legacy/page.tsx'], [waived('/admin/legacy', undefined)], {
      now: NOW,
    });

    expect(result.denominator).toBe(0);
    expect(result.waived).toBe(1);
    expect(result.percent).toBeNull();
  });

  it('measures the expiry against the injected clock, not the real one', () => {
    // The same row, read at two times. A gate that could not be asked what it
    // would have decided yesterday is a gate nobody can audit.
    const expiry = new Date(NOW.getTime() + 86_400_000);
    const before = join(['app/admin/legacy/page.tsx'], [waived('/admin/legacy', expiry)], {
      now: NOW,
    });
    const after = join(['app/admin/legacy/page.tsx'], [waived('/admin/legacy', expiry)], {
      now: new Date(expiry.getTime() + 1_000),
    });

    expect(before.waived).toBe(1);
    expect(after.waived).toBe(0);
    expect(after.uncovered).toBe(1);
  });
});

describe('patch coverage says what it cannot distinguish', () => {
  it('cannot tell a renamed route from a new one, and refuses to guess', () => {
    // `app/cart/page.tsx` → `app/basket/page.tsx`, with a test that already
    // visits /basket so the route is attributable, and an inventory that has
    // not been recomputed since — so /basket has no row. That is the same
    // evidence as a brand-new /basket page, and the same evidence as an
    // inventory nobody recomputed, and this refuses to pick between them.
    const basket = t({ id: 'basket', code: "page.goto('/basket')" });
    const stale = join(['app/basket/page.tsx', 'app/cart/page.tsx'], [route('/cart')], {
      tests: [basket, about],
    });

    expect(stale.unrecognised).toBe(1);
    expect(stale.routes.find((r) => r.route === '/basket')?.state).toBe('NOT_IN_INVENTORY');
    // Neither covered nor a gap: the denominator holds /cart alone.
    expect(stale.denominator).toBe(1);
    expect(stale.percent).toBe(100);
    expect(stale.caveats.some((c) => c.includes('renames'))).toBe(true);
  });

  it('cannot see a route that is new to BOTH the suite and the inventory', () => {
    // The honest limit of the whole feature, asserted so it cannot be forgotten:
    // a page nothing tests AND nothing has extracted yet cannot be attributed to
    // a route at all — `attribute()` demotes it to a bare name and then to
    // blast radius — so patch coverage reports "not measured" rather than a 0%
    // that happens to be right for the wrong reason. The gate that catches this
    // case is the one on the inventory computed from the PR's own commit.
    const result = join(['app/promo/page.tsx'], [route('/checkout')]);
    expect(result.measured).toBe(false);
    expect(result.caveats[0]).toContain('app/promo/page.tsx');
  });

  it('says how old the inventory is relative to the diff', () => {
    const result = join(['app/checkout/page.tsx'], [route('/checkout')], {
      diffCommitSha: 'bbbbbbbbbb',
      inventoryCommitSha: 'aaaaaaaaaa',
    });
    expect(result.caveats.some((c) => c.includes('aaaaaaa') && c.includes('bbbbbbb'))).toBe(true);
  });

  it('says when the inventory records no commit at all', () => {
    const result = join(['app/checkout/page.tsx'], [route('/checkout')], {
      diffCommitSha: 'bbbbbbbbbb',
      inventoryCommitSha: null,
      inventoryMeasuredAtIso: '2026-10-01T00:00:00.000Z',
    });
    expect(result.caveats.some((c) => c.includes('records no commit'))).toBe(true);
  });

  it('states that endpoints and forms are outside this denominator', () => {
    // A diff cannot be mapped onto an endpoint by this analysis — the file
    // layout proves which URL serves a handler and says nothing about which
    // pages call it — so they are named rather than silently dropped.
    const result = join(
      ['app/checkout/page.tsx'],
      [route('/checkout'), { key: 'ENDPOINT:GET /api/orders', status: 'UNCOVERED', label: 'orders' }],
    );
    expect(result.caveats.some((c) => c.includes('endpoints, forms or auth surfaces'))).toBe(true);
    expect(result.denominator).toBe(1);
  });
});
