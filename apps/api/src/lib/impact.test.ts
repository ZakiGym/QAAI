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
import { analyzeImpact, type ImpactTestInput } from './impact.js';

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
