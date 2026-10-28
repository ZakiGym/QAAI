/**
 * ADVERSARIAL VERIFICATION of the refactor engine and the ownership model.
 *
 * Six agents built this round and each reported success. These are the attacks,
 * not a re-reading: every test here tries to make the engine destroy human work
 * or delete coverage, and asserts the refusal rather than the happy path.
 *
 * Nothing here calls a model, a process, the filesystem or the network.
 */

import { describe, expect, it } from 'vitest';

import {
  WRITABLE_BY_DISPOSITION,
  WRITABLE_BY_OWNERSHIP,
  dispositionFor,
  mayWriteDirectly,
  resolveOwnership,
  type ArtifactLedgerEntry,
} from '@qaai/shared';
import type { SuiteHealthTestInput } from './suite-health.js';
import {
  coverageDelta,
  coverageRegressed,
  coverageSurface,
  extractFixture,
  mergeNearDuplicates,
  strengthenAssertions,
  verifyStrengthening,
} from './refactor.js';
import type { AssertionVerifier, RefactorContext } from './refactor.js';

const digest = (input: string): string => `h${input.length}:${input.slice(0, 8).replace(/\s/g, '_')}`;
const CTX: RefactorContext = { digest, ledger: null, knownPaths: [] };

function testRow(over: Partial<SuiteHealthTestInput> & { id: string }): SuiteHealthTestInput {
  return {
    name: 'a test',
    filePath: 'tests/checkout.spec.ts',
    type: 'E2E',
    priority: 'IMPORTANT',
    feature: 'Checkout',
    tags: [],
    code: null,
    spec: null,
    flakeRate: 0,
    quarantined: false,
    consecutiveFailures: 0,
    ...over,
  };
}

// ── ITEM 2: ownership is a RECORDED FACT, never inferred ────────────────────

describe('ownership cannot be transferred by how a file looks', () => {
  /** A human's page object. No row anywhere claims it. */
  const HUMAN_PATH = 'tests/pages/cart.page.ts';

  it('does not transfer by NAMING the file like a generated one', () => {
    /*
     * Every naming convention QAAI itself emits, against an EMPTY ledger. If
     * ownership were inferred from the path, one of these would come back
     * writable.
     */
    const generatedLookingPaths = [
      'tests/generated/checkout.spec.ts',
      'qaai/tests/checkout.spec.ts',
      '.qaai/checkout.spec.ts',
      'tests/__generated__/cart.page.ts',
      'e2e/qaai-checkout.spec.ts',
      'tests/checkout.qaai.spec.ts',
    ];
    for (const path of generatedLookingPaths) {
      expect(resolveOwnership([], path)).toBe('UNRECORDED');
      expect(WRITABLE_BY_OWNERSHIP[resolveOwnership([], path)]).toBe(false);
    }
  });

  it('does not transfer by putting a QAAI HEADER COMMENT in the content', () => {
    /*
     * `resolveOwnership` takes no content at all, which is the structural
     * answer: there is no parameter an attacker could aim at. Asserted rather
     * than assumed, because the same claim made about `pushRepo` was false for
     * a whole release.
     */
    const ledger: readonly ArtifactLedgerEntry[] = [];
    expect(resolveOwnership(ledger, HUMAN_PATH)).toBe('UNRECORDED');
    // The one function that answers "may we write" reads a verdict and a
    // disposition, and neither is derivable from bytes.
    expect(resolveOwnership.length).toBe(2);
  });

  it('does not transfer by placing the file in the generated DIRECTORY', () => {
    const ledger: readonly ArtifactLedgerEntry[] = [
      {
        path: 'tests/generated/other.spec.ts',
        role: 'SPEC',
        ownership: 'QAAI_OWNED',
        contentHash: digest('ours'),
        imports: [],
      },
    ];
    // A sibling in the very same directory QAAI owns files in is still theirs.
    expect(resolveOwnership(ledger, 'tests/generated/theirs.spec.ts')).toBe('UNRECORDED');
  });

  it('does not transfer by a near-miss SPELLING of a path QAAI owns', () => {
    const ledger: readonly ArtifactLedgerEntry[] = [
      {
        path: 'tests/checkout.spec.ts',
        role: 'SPEC',
        ownership: 'QAAI_OWNED',
        contentHash: digest('ours'),
        imports: [],
      },
    ];
    /*
     * A lookup that normalised would make two spellings resolve to one verdict
     * and the PERMISSIVE one would win. These must all stay UNRECORDED.
     */
    for (const near of [
      './tests/checkout.spec.ts',
      'tests//checkout.spec.ts',
      'Tests/checkout.spec.ts',
      'tests/checkout.spec.ts ',
      'tests/./checkout.spec.ts',
    ]) {
      expect(resolveOwnership(ledger, near)).toBe('UNRECORDED');
    }
  });

  it('needs BOTH halves of the permission, so a stale disposition is not a write', () => {
    // A disposition that says "write" against a verdict that says "theirs".
    expect(
      mayWriteDirectly({
        role: 'SPEC',
        path: HUMAN_PATH,
        content: 'x',
        disposition: 'UPDATE_OWNED',
        ownership: 'UNRECORDED',
        imports: [],
        basedOnHash: digest('x'),
        why: 'forged',
      }),
    ).toBe(false);
    // And the reverse: we own it, but the disposition is a proposal.
    expect(
      mayWriteDirectly({
        role: 'SPEC',
        path: HUMAN_PATH,
        content: 'x',
        disposition: 'PROPOSED_EDIT',
        ownership: 'QAAI_OWNED',
        imports: [],
        basedOnHash: digest('x'),
        why: 'forged',
      }),
    ).toBe(false);
    expect(WRITABLE_BY_DISPOSITION.PROPOSED_EDIT).toBe(false);
  });

  it("downgrades our own file the moment a human's bytes are at it", () => {
    // The ledger says QAAI_OWNED; the disk disagrees with what we wrote.
    expect(
      dispositionFor({
        verdict: 'QAAI_OWNED',
        ledgerHash: digest('what we wrote'),
        onDiskHash: digest('what they changed it to'),
      }),
    ).toBe('PROPOSED_EDIT');
  });
});

// ── ITEM 3: the coverage invariant ──────────────────────────────────────────

describe('the coverage invariant actually runs, and refuses a loss', () => {
  const FILE = 'tests/checkout.spec.ts';
  /**
   * Two near-duplicates that assert DIFFERENT things. Merging them while
   * dropping either body deletes a guarantee and leaves the count flat.
   */
  const TWO_DUPES = `import { expect, test } from '@playwright/test';

test('shows the total', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.getByTestId('total')).toHaveText('$42.00');
});

test('shows the tax', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.getByTestId('tax')).toHaveText('$3.36');
});
`;

  const members = [
    { test: testRow({ id: 't1', name: 'shows the total', filePath: FILE, code: TWO_DUPES }) },
    { test: testRow({ id: 't2', name: 'shows the tax', filePath: FILE, code: TWO_DUPES }) },
  ];

  it('is MEASURED before and after a real merge, and keeps both assertions', () => {
    const outcome = mergeNearDuplicates({ members, finding: 'near-duplicate cluster' }, CTX);

    // The comparison RAN — not a default, not an assumption.
    expect(outcome.coverage.state).toBe('MEASURED');
    if (outcome.coverage.state !== 'MEASURED') throw new Error('unreachable');
    expect(outcome.coverage.lost).toEqual([]);
    expect(outcome.coverage.kept).toBeGreaterThan(0);
    // Both assertions survive, and the accounting says so.
    expect(outcome.assertions.dropped).toEqual([]);
    expect(outcome.proposal).not.toBeNull();
    // And the merged file really does still contain both.
    const merged = outcome.proposal?.after.artifacts.find((a) => a.path === FILE)?.content ?? '';
    expect(merged).toContain("getByTestId('total')");
    expect(merged).toContain("getByTestId('tax')");
  });

  it('refuses a comparison it could not make, rather than reporting no loss', () => {
    /*
     * UNMEASURABLE is a THIRD state. A caller reading `lost.length === 0` off a
     * comparison that never happened is the null-that-became-zero, in the one
     * place where it licenses a coverage-deleting write.
     */
    const delta = coverageDelta(
      { tokens: ['assert:total'], unreadable: [] },
      { tokens: [], unreadable: [{ testId: 't9', filePath: FILE, reason: 'truncated' }] },
    );
    expect(delta.state).toBe('UNMEASURABLE');
    expect(coverageRegressed(delta)).toBe(true);
    // There is no `lost` to read at all, so the type stops the mistake too.
    expect('lost' in delta).toBe(false);
  });

  it('is SET CONTAINMENT and not a count, so a swap is a loss', () => {
    const before = coverageSurface([
      testRow({
        id: 'a',
        name: 'a',
        code: `import { expect, test } from '@playwright/test';
test('a', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.getByTestId('total')).toHaveText('$42.00');
});
`,
      }),
    ]);
    const after = coverageSurface([
      testRow({
        id: 'a',
        name: 'a',
        code: `import { expect, test } from '@playwright/test';
test('a', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.getByTestId('tax')).toHaveText('$3.36');
});
`,
      }),
    ]);
    const delta = coverageDelta(before, after);
    if (delta.state !== 'MEASURED') throw new Error('expected a measurable delta');
    // Same number of tokens, a guarantee gone.
    expect(before.tokens.length).toBe(after.tokens.length);
    expect(delta.lost.length).toBeGreaterThan(0);
    expect(coverageRegressed(delta)).toBe(true);
  });
});

// ── ITEM 4: fixture extraction equivalence ──────────────────────────────────

describe('a dependent that relied on a difference in its own setup', () => {
  const SETUP_A = `  await page.goto('/checkout');
  await page.getByLabel('Card number').fill('4242424242424242');
`;
  /** The SAME shape, one literal different. A declined card is a different test. */
  const SETUP_B = `  await page.goto('/checkout');
  await page.getByLabel('Card number').fill('4000000000000002');
`;

  function spec(name: string, setup: string, assertion: string): string {
    return `import { expect, test } from '@playwright/test';

test('${name}', async ({ page }) => {
${setup}  ${assertion}
});
`;
  }

  it('is EXCLUDED with a reason, never rewritten to the shared fixture', () => {
    const candidates = [
      {
        test: testRow({
          id: 'c1',
          name: 'accepts a good card',
          filePath: 'tests/a.spec.ts',
          code: spec('accepts a good card', SETUP_A, "await expect(page.getByTestId('ok')).toBeVisible();"),
        }),
      },
      {
        test: testRow({
          id: 'c2',
          name: 'also accepts it',
          filePath: 'tests/b.spec.ts',
          code: spec('also accepts it', SETUP_A, "await expect(page.getByTestId('receipt')).toBeVisible();"),
        }),
      },
      {
        // The odd one out: a DECLINED card number.
        test: testRow({
          id: 'c3',
          name: 'declines a bad card',
          filePath: 'tests/c.spec.ts',
          code: spec('declines a bad card', SETUP_B, "await expect(page.getByTestId('declined')).toBeVisible();"),
        }),
      },
    ];

    const outcome = extractFixture({ candidates, finding: 'duplicate setup' }, CTX);

    // The divergent dependent is named, with a reason — not silently included.
    const excludedPaths = outcome.excluded.map((e) => e.path);
    expect(excludedPaths).toContain('tests/c.spec.ts');
    const reason = outcome.excluded.find((e) => e.path === 'tests/c.spec.ts');
    /*
     * THE SPECIFIC reason, pinned. An earlier draft of this test passed on
     * `BLOCK_NOT_LOCATABLE` — the rows carried no `name`, so NO dependent was
     * locatable and the exclusion had nothing to do with the setup. A truthy
     * check would have kept passing while testing nothing.
     */
    expect(reason?.reason).toBe('SETUP_NOT_IDENTICAL');
    expect(reason?.why).toBeTruthy();
    // And the two that DO agree were extracted, so this is not a blanket refusal.
    expect(outcome.proposal).not.toBeNull();
    expect(outcome.excluded).toHaveLength(1);

    // And its file is NOT among the files the proposal would rewrite.
    const rewritten = outcome.proposal?.after.artifacts.map((a) => a.path) ?? [];
    expect(rewritten).toContain('tests/a.spec.ts');
    expect(rewritten).toContain('tests/b.spec.ts');
    expect(rewritten).not.toContain('tests/c.spec.ts');
    // Its declined-card literal is nowhere in the extracted helper.
    const helperBodies = (outcome.proposal?.after.artifacts ?? []).map((a) => a.content).join('\n');
    expect(helperBodies).not.toContain('4000000000000002');
  });

  it('refuses to invent a helper path when nobody said what is in the tree', () => {
    /*
     * NULL IS NOT EMPTY. An extraction's revert entry CLAIMS nothing was at the
     * helper path, and reverting that claim DELETES the file. With no listing,
     * the claim is unfounded.
     */
    const candidates = [
      { test: testRow({ id: 'c1', name: 'a', filePath: 'tests/a.spec.ts', code: spec('a', SETUP_A, "await expect(page.getByTestId('ok')).toBeVisible();") }) },
      { test: testRow({ id: 'c2', name: 'b', filePath: 'tests/b.spec.ts', code: spec('b', SETUP_A, "await expect(page.getByTestId('receipt')).toBeVisible();") }) },
    ];
    const blind: RefactorContext = { digest, ledger: null, knownPaths: null };
    const outcome = extractFixture({ candidates, finding: 'duplicate setup' }, blind);

    expect(outcome.proposal).toBeNull();
    expect(outcome.problems.map((p) => p.kind)).toContain('TREE_UNKNOWN');
  });

  it("refuses to invent a helper path a human's file already occupies", () => {
    const candidates = [
      { test: testRow({ id: 'c1', name: 'a', filePath: 'tests/a.spec.ts', code: spec('a', SETUP_A, "await expect(page.getByTestId('ok')).toBeVisible();") }) },
      { test: testRow({ id: 'c2', name: 'b', filePath: 'tests/b.spec.ts', code: spec('b', SETUP_A, "await expect(page.getByTestId('receipt')).toBeVisible();") }) },
    ];
    // First find out where it WANTS to write, then put a human there.
    const free = extractFixture({ candidates, finding: 'f' }, CTX);
    const helperPath = free.proposal?.after.artifacts.find((a) => a.role !== 'SPEC')?.path;
    expect(helperPath).toBeTruthy();

    const occupied: RefactorContext = { digest, ledger: null, knownPaths: [helperPath!] };
    const outcome = extractFixture({ candidates, finding: 'f' }, occupied);

    expect(outcome.proposal).toBeNull();
    expect(outcome.problems.length).toBeGreaterThan(0);
  });
});

// ── ITEM 5: strengthening is RUN before it can be applied ───────────────────

describe('a strengthening nobody ran', () => {
  const WEAK = `import { expect, test } from '@playwright/test';

test('shows the total', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.getByTestId('total')).toBeTruthy();
});
`;
  const subject = { test: testRow({ id: 's1', name: 'shows the total', code: WEAK }) };

  it('is BLOCKED and hands over no proposal', () => {
    const outcome = strengthenAssertions({ subject, finding: 'weak assertion' }, CTX);

    expect(outcome.proposal).toBeNull();
    expect(outcome.problems.map((p) => p.kind)).toContain('STRENGTHENING_UNVERIFIED');
    // The rewrite exists but is withheld as `pending`, which is not applyable.
    expect(outcome.pending).not.toBeNull();
    /*
     * The trial is UNAVAILABLE WITH A REASON rather than null — the stricter of
     * the two, and the one admission.ts's rule asks for: "we did not run it" is
     * a state, not an absence a caller can read as "nothing to run".
     */
    expect(outcome.trial?.state).toBe('UNAVAILABLE');
    expect(outcome.trial?.why).toMatch(/not been run/);
  });

  it('becomes a DIFFERENT proposal when it passes than when it fails', async () => {
    const passes: AssertionVerifier = async () => ({ state: 'PASSED', why: 'green', detail: ['1 passed'] });
    const fails: AssertionVerifier = async () => ({ state: 'FAILED', why: 'red', detail: ['1 failed'] });

    const ok = await verifyStrengthening({ subject, finding: 'weak' }, CTX, passes);
    const bad = await verifyStrengthening({ subject, finding: 'weak' }, CTX, fails);

    expect(ok.proposal).not.toBeNull();
    expect(bad.proposal).not.toBeNull();
    // Both reach a human, and they do not read the same.
    expect(ok.proposal?.title).not.toBe(bad.proposal?.title);
    expect(ok.trial?.state).toBe('PASSED');
    expect(bad.trial?.state).toBe('FAILED');
    // The failing one is MARKED as failing, so nobody applies it by accident.
    expect(bad.proposal?.title.toLowerCase()).toMatch(/fail/);
  });

  it('is blocked when the trial could not run at all', async () => {
    const cannot: AssertionVerifier = async () => ({
      state: 'UNAVAILABLE',
      why: 'no runner in this environment',
      detail: [],
    });
    const outcome = await verifyStrengthening({ subject, finding: 'weak' }, CTX, cannot);

    // UNAVAILABLE is never PASS. Same as never having asked.
    expect(outcome.proposal).toBeNull();
    expect(outcome.trial?.state).toBe('UNAVAILABLE');
  });

  it('is blocked when the verifier itself throws', async () => {
    const explodes: AssertionVerifier = async () => {
      throw new Error('the runner died');
    };
    const outcome = await verifyStrengthening({ subject, finding: 'weak' }, CTX, explodes);
    expect(outcome.proposal).toBeNull();
  });
});
