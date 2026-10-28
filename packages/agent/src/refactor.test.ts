/**
 * Refactor-engine tests.
 *
 * This module REWRITES TESTS A HUMAN WROTE, so its mistakes are not
 * symmetrical and the suite is weighted accordingly.
 *
 *   A FALSE REFUSAL costs a reviewer nothing. The copy-pasted setup stays
 *   copy-pasted, somebody runs the engine again next week, and the coverage
 *   number is unchanged. Every refusal and every exclusion below therefore has
 *   a COUNTER-EXAMPLE beside it — a dependent that IS extracted, a merge that
 *   IS proposed — because a refusal list that refuses everything is a feature
 *   nobody switches on, and a feature nobody switches on is the original defect
 *   back.
 *
 *   A FALSE PROPOSAL is silent and expensive. A merge that drops one assertion
 *   leaves the coverage number flat while the guarantee is gone, which is the
 *   exact dishonesty this product exists to prevent. So the coverage invariant
 *   is tested FIRST, directly, in both directions, and the thing that cannot be
 *   proven by a test — that each operation is actually wired to the gate — is
 *   pinned by mutation and reported as a count.
 *
 * Nothing here calls a model, starts a process, touches the filesystem or
 * reaches the network. The two capabilities this module cannot have — hashing
 * and running a test — are injected, which is what makes a table this
 * consequential cheap enough to keep correct without an API key.
 */

import { describe, expect, it } from 'vitest';
import { DIALECT_IDS, suiteChangeProposalSchema } from '@qaai/shared';
/*
 * Reached by relative path for the reason refactor.ts records above its own
 * import: `artifact-set.ts` is not in packages/shared/src/index.ts yet, so
 * `@qaai/shared` does not provide these names at run time. The ONE name that
 * does come through the front door is `suiteChangeProposalSchema`, because
 * schemas.ts is in that barrel — which is why the parse test above is the one
 * that proves the write path agrees with this producer.
 */
import {
  APPLYABLE_STATES,
  WRITABLE_BY_OWNERSHIP,
  mayWriteDirectly,
  proposalProblems,
  type ArtifactLedgerEntry,
} from '@qaai/shared';
import type { SuiteHealthTestInput } from './suite-health.js';
import {
  DIALECT_IS_JS,
  EXCLUSION_REASONS,
  FACET_IN_INVARIANT,
  INVARIANT_FACETS,
  MAX_FIXTURE_DEPENDENTS,
  MIN_FIXTURE_DEPENDENTS,
  PROBLEM_BLOCKS_REFACTOR,
  REFACTOR_PROBLEMS,
  __internal,
  codeComment,
  codeString,
  coverageDelta,
  coverageRegressed,
  coverageSurface,
  extractFixture,
  mergeNearDuplicates,
  pathIsSafe,
  refactorBlocked,
  safeIdentifier,
  strengthenAssertions,
  verifyStrengthening,
} from './refactor.js';
import type { AssertionTrial, AssertionVerifier, RefactorContext } from './refactor.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A digest that is injected rather than imported, for the reason
 * artifact-set.ts records about `node:crypto` in this package. Content-sensitive
 * because `dispositionFor` compares it against a ledger hash, and a constant
 * would make "a human changed our file" indistinguishable from "they did not".
 */
const digest = (input: string): string => `h${input.length}:${input.slice(0, 8).replace(/\s/g, '_')}`;

/**
 * The ordinary context: QAAI has no ownership record of these files, and the
 * working tree has been listed and holds nothing at the paths an extraction
 * would create. `knownPaths: []` is a FACT ("we looked, it is free"), which is
 * why it is not the same thing as `null` ("nobody looked") — the test
 * `'refuses to create a file when nobody said what is in the tree'` pins the
 * difference.
 */
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

/** Two specs in two files, sharing a setup block byte for byte. */
const SHARED_SETUP = `  await page.goto('/checkout');
  await page.getByLabel('Card number').fill('4242424242424242');
`;

function specWithSetup(name: string, setup: string, assertion: string): string {
  return `import { expect, test } from '@playwright/test';

test('${name}', async ({ page }) => {
${setup}  ${assertion}
});
`;
}

const CARD_ASSERT = `await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();`;
const TOTAL_ASSERT = `await expect(page.getByTestId('total')).toHaveText('$42.00');`;

function fixtureCandidates(): Array<{ test: SuiteHealthTestInput }> {
  return [
    {
      test: testRow({
        id: 't1',
        name: 'confirms the order',
        filePath: 'tests/confirm.spec.ts',
        code: specWithSetup('confirms the order', SHARED_SETUP, CARD_ASSERT),
      }),
    },
    {
      test: testRow({
        id: 't2',
        name: 'shows the total',
        filePath: 'tests/total.spec.ts',
        code: specWithSetup('shows the total', SHARED_SETUP, TOTAL_ASSERT),
      }),
    },
  ];
}

/** One file holding two near-duplicate tests, which is the only shape a merge accepts. */
const TWO_IN_ONE_FILE = `import { expect, test } from '@playwright/test';

test('checkout shows the heading', async ({ page }) => {
  await page.goto('/checkout');
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
});

test('checkout shows the total', async ({ page }) => {
  await page.goto('/checkout');
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByTestId('total')).toHaveText('$42.00');
});
`;

function mergeMembers(code = TWO_IN_ONE_FILE): Array<{ test: SuiteHealthTestInput }> {
  return [
    {
      test: testRow({
        id: 'm1',
        name: 'checkout shows the heading',
        filePath: 'tests/checkout.spec.ts',
        code,
      }),
    },
    {
      test: testRow({
        id: 'm2',
        name: 'checkout shows the total',
        filePath: 'tests/checkout.spec.ts',
        code,
      }),
    },
  ];
}

const WEAK_SPEC = `import { expect, test } from '@playwright/test';

test('order page loads', async ({ page }) => {
  await page.goto('/orders');
  await expect(page.getByTestId('order-list')).toBeTruthy();
  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();
});
`;

function weakSubject(code = WEAK_SPEC): { test: SuiteHealthTestInput } {
  return {
    test: testRow({
      id: 'w1',
      name: 'order page loads',
      filePath: 'tests/orders.spec.ts',
      code,
    }),
  };
}

const verifierSaying = (trial: AssertionTrial): AssertionVerifier => async () => trial;

// ─── The coverage invariant ──────────────────────────────────────────────────

describe('the coverage invariant', () => {
  /*
   * THE TEST THAT MAKES THIS FEATURE SAFE. Without it a refactor engine is a
   * coverage-deleting machine with a nice name, so it is written first and it is
   * the one to read if anything else here is confusing.
   */
  it('refuses a refactor that reduces the covered surface', () => {
    const before = [
      testRow({
        id: 'a',
        name: 'two things',
        code: specWithSetup('two things', SHARED_SETUP, `${CARD_ASSERT}\n  ${TOTAL_ASSERT}`),
      }),
    ];
    const after = [
      testRow({
        id: 'a',
        name: 'two things',
        code: specWithSetup('two things', SHARED_SETUP, CARD_ASSERT),
      }),
    ];

    const { problems, coverage, assertions } = __internal.checkInvariants({
      beforeTests: before,
      afterTests: after,
    });

    expect(coverage.state).toBe('MEASURED');
    expect(coverageRegressed(coverage)).toBe(true);
    expect(problems.map((problem) => problem.kind)).toContain('COVERAGE_LOST');
    expect(problems.map((problem) => problem.kind)).toContain('ASSERTION_DROPPED');
    // The sets are STATED, which is what the register asks a merge to do.
    expect(assertions.before.length).toBeGreaterThan(assertions.after.length);
    expect(assertions.dropped.some((token) => token.includes('tohavetext'))).toBe(true);
    // Every blocking problem must actually block.
    expect(problems.every((problem) => PROBLEM_BLOCKS_REFACTOR[problem.kind])).toBe(true);
  });

  it('admits a refactor that preserves the surface exactly', () => {
    const rows = [
      testRow({ id: 'a', name: 'x', code: specWithSetup('x', SHARED_SETUP, CARD_ASSERT) }),
    ];
    const { problems, coverage } = __internal.checkInvariants({
      beforeTests: rows,
      afterTests: rows,
    });
    expect(coverage.state).toBe('MEASURED');
    expect(coverageRegressed(coverage)).toBe(false);
    expect(problems).toEqual([]);
  });

  /*
   * The invariant is CONTAINMENT and not a count. A swap keeps the number and
   * loses the guarantee, which is the shape of the dishonesty this product
   * exists to prevent.
   */
  it('treats a one-for-one assertion swap as a loss, because it is containment and not a count', () => {
    const before = [
      testRow({ id: 'a', name: 'x', code: specWithSetup('x', SHARED_SETUP, TOTAL_ASSERT) }),
    ];
    const after = [
      testRow({
        id: 'a',
        name: 'x',
        code: specWithSetup(
          'x',
          SHARED_SETUP,
          `await expect(page.getByTestId('total')).toHaveText('$0.00');`,
        ),
      }),
    ];

    const { problems, coverage, assertions } = __internal.checkInvariants({
      beforeTests: before,
      afterTests: after,
    });

    expect(assertions.before).toHaveLength(assertions.after.length);
    expect(coverage.state === 'MEASURED' && coverage.lost.length).toBeGreaterThan(0);
    expect(problems.map((problem) => problem.kind)).toContain('COVERAGE_LOST');
    expect(problems.map((problem) => problem.kind)).toContain('ASSERTION_DROPPED');
  });

  /*
   * UNREADABLE IS NOT UNCHANGED. An unterminated string makes the whole surface
   * a guess, and a guess reported as a clean delta is the null that became
   * zero, in the one place where it would license a coverage-deleting write.
   */
  it('reports UNMEASURABLE rather than a clean delta when a test could not be read', () => {
    const unreadable = testRow({
      id: 'a',
      name: 'x',
      // An unterminated template literal: `stripComments` ends inside a string.
      code: 'test("x", async ({ page }) => { await page.goto(`/checkout); });',
    });

    const surface = coverageSurface([unreadable]);
    expect(surface.unreadable).toHaveLength(1);
    expect(surface.unreadable[0]?.reason).toBeTruthy();

    const delta = coverageDelta(surface, surface);
    expect(delta.state).toBe('UNMEASURABLE');
    expect(coverageRegressed(delta)).toBe(true);
    // And it must not be possible to read "no tokens lost" off it.
    expect(delta).not.toHaveProperty('lost');

    const { problems } = __internal.checkInvariants({
      beforeTests: [unreadable],
      afterTests: [unreadable],
    });
    expect(problems.map((problem) => problem.kind)).toContain('COVERAGE_UNMEASURABLE');
    expect(PROBLEM_BLOCKS_REFACTOR.COVERAGE_UNMEASURABLE).toBe(true);
  });

  it('does not let the expected-change predicate excuse an unrelated loss', () => {
    const before = [
      testRow({
        id: 'a',
        name: 'x',
        code: specWithSetup('x', SHARED_SETUP, `await expect(page.getByTestId('t')).toBeTruthy();`),
      }),
    ];
    // The strengthening happened AND a navigation disappeared with it.
    const after = [
      testRow({
        id: 'a',
        name: 'x',
        code: specWithSetup(
          'x',
          `  await page.getByLabel('Card number').fill('4242424242424242');\n`,
          `await expect(page.getByTestId('t')).toBeVisible();`,
        ),
      }),
    ];

    const { problems } = __internal.checkInvariants({
      beforeTests: before,
      afterTests: after,
      expectedChange: (token) => token.startsWith('assert:tobetruthy:testid=t:'),
    });

    const kinds = problems.map((problem) => problem.kind);
    // The deliberate swap is excused…
    expect(kinds).not.toContain('ASSERTION_DROPPED');
    // …and the route that vanished with it is NOT.
    expect(kinds).toContain('COVERAGE_LOST');
    expect(problems.find((problem) => problem.kind === 'COVERAGE_LOST')?.why).toContain('nav:/checkout');
  });

  it('counts routes, actions and assertions and deliberately does not count data', () => {
    expect(FACET_IN_INVARIANT.data).toBe(false);
    expect(INVARIANT_FACETS).toEqual(['routes', 'actions', 'assertions']);

    // The same test with a different typed literal loses a `data:` token and nothing else.
    const before = [
      testRow({
        id: 'a',
        name: 'x',
        code: specWithSetup('x', SHARED_SETUP, CARD_ASSERT),
      }),
    ];
    const after = [
      testRow({
        id: 'a',
        name: 'x',
        code: specWithSetup(
          'x',
          `  await page.goto('/checkout');\n  await page.getByLabel('Card number').fill(CARDS.visa);\n`,
          CARD_ASSERT,
        ),
      }),
    ];
    const { problems } = __internal.checkInvariants({ beforeTests: before, afterTests: after });
    expect(problems).toEqual([]);
  });
});

// ─── Merge ───────────────────────────────────────────────────────────────────

describe('merging near-duplicates', () => {
  it('merges two tests in one file and preserves the union of their assertions', () => {
    const outcome = mergeNearDuplicates(
      { members: mergeMembers(), finding: 'cluster of 2, score 0.84' },
      CTX,
    );

    expect(outcome.problems).toEqual([]);
    expect(outcome.proposal).not.toBeNull();
    expect(outcome.assertions.dropped).toEqual([]);
    expect(outcome.assertions.after.some((token) => token.includes('tobevisible'))).toBe(true);
    expect(outcome.assertions.after.some((token) => token.includes('tohavetext'))).toBe(true);

    const merged = outcome.proposal!.after.artifacts[0]!.content;
    // ONE test block, both bodies verbatim, each in its own scope.
    expect(merged.match(/\btest\(/g)).toHaveLength(1);
    expect(merged).toContain(`getByRole('heading', { name: 'Order confirmed' })`);
    expect(merged).toContain(`getByTestId('total')`);
    expect(merged).toContain('// merged from: checkout shows the heading');

    // The register asks the proposal to STATE the assertion sets. It does.
    expect(outcome.proposal!.rationale).toContain('ASSERTIONS BEFORE');
    expect(outcome.proposal!.rationale).toContain('ASSERTIONS AFTER');
    expect(outcome.proposal!.rationale).toContain('the union is preserved');
  });

  it('keeps both navigations rather than de-duplicating them', () => {
    const outcome = mergeNearDuplicates({ members: mergeMembers(), finding: 'f' }, CTX);
    const merged = outcome.proposal!.after.artifacts[0]!.content;
    /*
     * The tempting merge drops the second `goto`. It is also wrong: the first
     * body may have navigated away, and the failure is a test that passes while
     * checking the wrong page. Two gotos is the correct output.
     */
    expect(merged.match(/goto\('\/checkout'\)/g)).toHaveLength(2);
  });

  it('refuses a merge whose members live in different files', () => {
    const members = mergeMembers();
    const outcome = mergeNearDuplicates(
      {
        members: [
          members[0]!,
          { test: { ...members[1]!.test, filePath: 'tests/other.spec.ts' } },
        ],
        finding: 'f',
      },
      CTX,
    );
    expect(outcome.proposal).toBeNull();
    expect(outcome.problems.map((problem) => problem.kind)).toEqual(['FILES_DISAGREE']);
    expect(outcome.problems[0]?.why).toContain('no DELETE');
  });

  it('refuses a merge when two rows claim one path and disagree about its bytes', () => {
    const members = mergeMembers();
    const outcome = mergeNearDuplicates(
      {
        members: [
          members[0]!,
          { test: { ...members[1]!.test, code: `${TWO_IN_ONE_FILE}\n// a human edited this\n` } },
        ],
        finding: 'f',
      },
      CTX,
    );
    expect(outcome.proposal).toBeNull();
    expect(outcome.problems[0]?.kind).toBe('FILES_DISAGREE');
    expect(outcome.problems[0]?.why).toContain('stale');
  });

  it('refuses a merge across test types', () => {
    const members = mergeMembers();
    const outcome = mergeNearDuplicates(
      { members: [members[0]!, { test: { ...members[1]!.test, type: 'API' } }], finding: 'f' },
      CTX,
    );
    expect(outcome.problems[0]?.kind).toBe('MIXED_TEST_TYPES');
  });

  /*
   * The subtle one. A body that returns early would not run the body appended
   * after it, so the merged test silently stops making the second test's
   * assertions — a merge that deletes coverage while the count stays flat.
   */
  it('refuses a merge when a body returns early, which would skip the other body', () => {
    const code = TWO_IN_ONE_FILE.replace(
      `  await page.goto('/checkout');\n  await page.getByRole('button', { name: 'Pay now' }).click();\n  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();`,
      `  if (!process.env.CI) return;\n  await page.goto('/checkout');\n  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();`,
    );
    const outcome = mergeNearDuplicates({ members: mergeMembers(code), finding: 'f' }, CTX);
    expect(outcome.proposal).toBeNull();
    expect(outcome.problems[0]?.kind).toBe('MERGE_EARLY_RETURN');
    expect(outcome.problems[0]?.why).toContain('deletes coverage');
  });

  it('refuses a merge whose callbacks take positional parameters', () => {
    const code = TWO_IN_ONE_FILE.replace(/async \(\{ page \}\)/g, 'async (page)');
    const outcome = mergeNearDuplicates({ members: mergeMembers(code), finding: 'f' }, CTX);
    expect(outcome.problems[0]?.kind).toBe('MERGE_PARAMS_UNREADABLE');
  });

  it('refuses when two blocks share a name, so the row does not identify one', () => {
    const code = TWO_IN_ONE_FILE.replace('checkout shows the total', 'checkout shows the heading');
    const outcome = mergeNearDuplicates(
      {
        members: [
          mergeMembers(code)[0]!,
          { test: { ...mergeMembers(code)[1]!.test, name: 'checkout shows the heading' } },
        ],
        finding: 'f',
      },
      CTX,
    );
    expect(outcome.proposal).toBeNull();
    expect(outcome.problems[0]?.kind).toBe('TEST_BLOCK_NOT_FOUND');
    expect(outcome.problems[0]?.why).toContain('2 blocks');
  });

  it('refuses a file whose comment stripping ended inside a string', () => {
    const outcome = mergeNearDuplicates(
      { members: mergeMembers(`${TWO_IN_ONE_FILE}\nconst unterminated = 'oops`), finding: 'f' },
      CTX,
    );
    expect(outcome.proposal).toBeNull();
    expect(outcome.problems[0]?.kind).toBe('SOURCE_UNREADABLE');
  });

  it('refuses a non-JavaScript dialect rather than rewriting a language it cannot read', () => {
    const members = mergeMembers().map(({ test }) => ({
      test: { ...test, filePath: 'tests/checkout_spec.py' },
    }));
    const outcome = mergeNearDuplicates({ members, finding: 'f' }, CTX);
    expect(outcome.proposal).toBeNull();
    expect(outcome.problems[0]?.kind).toBe('DIALECT_UNSUPPORTED');
  });
});

// ─── Extraction ──────────────────────────────────────────────────────────────

describe('extracting a fixture', () => {
  it('hoists setup two tests share and rewrites both to call it', () => {
    const outcome = extractFixture(
      { candidates: fixtureCandidates(), finding: 'duplicate setup in 2 files' },
      CTX,
    );

    expect(outcome.problems).toEqual([]);
    expect(outcome.excluded).toEqual([]);
    expect(outcome.proposal).not.toBeNull();

    const paths = outcome.proposal!.after.artifacts.map((artifact) => artifact.path);
    expect(paths).toContain('tests/Checkout.qaai-setup.ts');
    expect(paths).toHaveLength(3);

    // The helper is applied FIRST: a dependency on disk before the file that imports it.
    expect(outcome.proposal!.after.artifacts[0]!.role).toBe('HELPER');

    const helper = outcome.proposal!.after.artifacts[0]!.content;
    expect(helper).toContain('export async function setUpCheckout(page)');
    expect(helper).toContain(`page.goto('/checkout')`);

    const spec = outcome.proposal!.after.artifacts.find(
      (artifact) => artifact.path === 'tests/confirm.spec.ts',
    )!;
    expect(spec.content).toContain('await setUpCheckout(page);');
    expect(spec.content).not.toContain(`getByLabel('Card number').fill`);
    expect(spec.imports).toEqual(['tests/Checkout.qaai-setup.ts']);
  });

  /*
   * THE DESIGN DECISION A REVIEWER SHOULD PUSH ON, pinned.
   *
   * The extracted `goto` and `fill` leave the spec, so a surface computed from
   * the spec alone would report them LOST and the invariant would refuse every
   * legitimate extraction. The surface spans the helper, so it does not.
   */
  it('does not report the extracted setup as lost, because the surface spans the helper', () => {
    const outcome = extractFixture({ candidates: fixtureCandidates(), finding: 'f' }, CTX);
    expect(outcome.coverage.state).toBe('MEASURED');
    expect(outcome.coverage.state === 'MEASURED' && outcome.coverage.lost).toEqual([]);
    expect(outcome.coverage.state === 'MEASURED' && outcome.coverage.kept).toBeGreaterThan(2);

    // And the proof that it is the SPAN doing the work, not a disabled invariant:
    // the spec alone does lose those tokens.
    const specOnly = outcome.proposal!.after.artifacts.find(
      (artifact) => artifact.path === 'tests/confirm.spec.ts',
    )!.content;
    const naive = coverageDelta(
      coverageSurface([fixtureCandidates()[0]!.test]),
      coverageSurface([{ ...fixtureCandidates()[0]!.test, code: specOnly }]),
    );
    expect(naive.state === 'MEASURED' && naive.lost).toContain('nav:/checkout');
  });

  it('puts the helper ahead of the spec when measuring, so a moved binding still resolves', () => {
    const spanned = __internal.spanningCode('const inSpec = 1;', [
      { role: 'HELPER', content: 'const inHelper = 1;' },
      { role: 'DATASET', content: 'const inDataset = 1;' },
    ]);
    // DATASET (rank 0) then HELPER (rank 1) then the spec. Apply order, not authoring order.
    expect(spanned.indexOf('inDataset')).toBeLessThan(spanned.indexOf('inHelper'));
    expect(spanned.indexOf('inHelper')).toBeLessThan(spanned.indexOf('inSpec'));
  });

  /*
   * THE DANGER THE REGISTER NAMES: a dependent that relied on a difference in
   * its own setup now silently tests something else. Equivalence is PROVEN, and
   * where it cannot be, the dependent is excluded and the reason is named.
   */
  it('excludes a dependent whose setup differs by one literal, and says why', () => {
    const candidates = fixtureCandidates();
    const divergent = {
      test: testRow({
        id: 't3',
        name: 'declines a bad card',
        filePath: 'tests/declined.spec.ts',
        code: specWithSetup(
          'declines a bad card',
          `  await page.goto('/checkout');\n  await page.getByLabel('Card number').fill('4000000000000002');\n`,
          CARD_ASSERT,
        ),
      }),
    };

    const outcome = extractFixture(
      { candidates: [...candidates, divergent], finding: 'f' },
      CTX,
    );

    expect(outcome.proposal).not.toBeNull();
    expect(outcome.excluded).toHaveLength(1);
    expect(outcome.excluded[0]).toMatchObject({
      reason: 'SETUP_NOT_IDENTICAL',
      testId: 't3',
    });
    expect(outcome.excluded[0]?.why).toContain('relied on a difference');
    // The excluded dependent is UNTOUCHED, so its coverage cannot be affected.
    expect(outcome.proposal!.after.artifacts.map((artifact) => artifact.path)).not.toContain(
      'tests/declined.spec.ts',
    );
    expect(outcome.proposal!.rationale).toContain('1 candidate(s) were EXCLUDED');
  });

  it('excludes a dependent whose setup reads a name from file scope', () => {
    const candidates = fixtureCandidates();
    const setup = `  await page.goto(CHECKOUT_URL);\n  await page.getByLabel('Card number').fill('4242424242424242');\n`;
    const outcome = extractFixture(
      {
        candidates: [
          {
            test: testRow({
              id: 't4',
              name: 'uses a constant',
              filePath: 'tests/const.spec.ts',
              code: `const CHECKOUT_URL = '/checkout';\n${specWithSetup('uses a constant', setup, CARD_ASSERT)}`,
            }),
          },
          ...candidates,
        ],
        finding: 'f',
      },
      CTX,
    );

    const excluded = outcome.excluded.find((item) => item.testId === 't4');
    expect(excluded?.reason).toBe('FREE_IDENTIFIER');
    expect(excluded?.why).toContain('CHECKOUT_URL');
    expect(excluded?.why).toContain('a helper file would not have it');
  });

  /*
   * The fail-open this closed. `${BASE}/orders` is the normal spelling in a
   * generated spec, and blanking the whole template literal hides `BASE` — a
   * file-scope read that would make the extracted helper fail to compile.
   */
  it('sees a file-scope name used inside a template interpolation', () => {
    const owned = new Set(['page']);
    const free = __internal.freeIdentifiers(
      "await page.goto(`${BASE}/orders`); await page.click('#go');",
      owned,
    );
    expect(free).toContain('BASE');
    // …and does not invent a name out of the string's own text.
    expect(free).not.toContain('orders');
    expect(free).not.toContain('go');
  });

  it('excludes a dependent in another directory, because one specifier cannot serve both', () => {
    const outcome = extractFixture(
      {
        candidates: [
          ...fixtureCandidates(),
          {
            test: testRow({
              id: 't5',
              name: 'elsewhere',
              filePath: 'e2e/deep/elsewhere.spec.ts',
              code: specWithSetup('elsewhere', SHARED_SETUP, CARD_ASSERT),
            }),
          },
        ],
        finding: 'f',
      },
      CTX,
    );
    expect(outcome.excluded.find((item) => item.testId === 't5')?.reason).toBe(
      'DIFFERENT_DIRECTORY',
    );
    expect(outcome.proposal).not.toBeNull();
  });

  it('excludes a test with no assertion, because where its setup ends is not knowable', () => {
    const outcome = extractFixture(
      {
        candidates: [
          ...fixtureCandidates(),
          {
            test: testRow({
              id: 't6',
              name: 'asserts nothing',
              filePath: 'tests/nothing.spec.ts',
              code: `import { test } from '@playwright/test';\n\ntest('asserts nothing', async ({ page }) => {\n${SHARED_SETUP}});\n`,
            }),
          },
        ],
        finding: 'f',
      },
      CTX,
    );
    expect(outcome.excluded.find((item) => item.testId === 't6')?.reason).toBe(
      'NO_ASSERTION_BOUNDARY',
    );
  });

  it('refuses when fewer than two dependents survive the equivalence proof', () => {
    const outcome = extractFixture(
      { candidates: [fixtureCandidates()[0]!], finding: 'f' },
      CTX,
    );
    expect(outcome.proposal).toBeNull();
    expect(outcome.problems[0]?.kind).toBe('NOT_ENOUGH_DEPENDENTS');
    expect(outcome.problems[0]?.why).toContain('a shared helper with one caller is a rename');
    expect(MIN_FIXTURE_DEPENDENTS).toBe(2);
  });

  /*
   * A CAP THAT BIT, reported as a count AND a reason. Rule twelve: a budget
   * applied without being disclosed is one of the lies this product cannot
   * afford, and the number here is forced by the artifact-set ceiling rather
   * than chosen.
   */
  it('discloses the dependent cap as a count and a reason, and leaves the rest untouched', () => {
    const many = Array.from({ length: MAX_FIXTURE_DEPENDENTS + 3 }, (_, index) => ({
      test: testRow({
        id: `cap${index}`,
        name: `case ${index}`,
        filePath: `tests/cap${index}.spec.ts`,
        code: specWithSetup(`case ${index}`, SHARED_SETUP, CARD_ASSERT),
      }),
    }));

    const outcome = extractFixture({ candidates: many, finding: 'f' }, CTX);

    expect(outcome.proposal).not.toBeNull();
    expect(outcome.caps).toHaveLength(1);
    expect(outcome.caps[0]).toMatchObject({
      cap: 'MAX_FIXTURE_DEPENDENTS',
      limit: MAX_FIXTURE_DEPENDENTS,
      dropped: 3,
    });
    expect(outcome.caps[0]?.why).toContain('left untouched rather than silently dropped');
    expect(outcome.excluded.filter((item) => item.reason === 'OVER_DEPENDENT_CAP')).toHaveLength(3);
    // And the set is storable, which is what the cap exists for.
    expect(outcome.proposal!.after.artifacts).toHaveLength(MAX_FIXTURE_DEPENDENTS + 1);
  });

  it('learns the import extension from the spec, and discloses the assumption when it cannot', () => {
    expect(__internal.observedRelativeExtension(`import { a } from './b.js';`)).toBe('.js');
    expect(__internal.observedRelativeExtension(`import { a } from '../b';`)).toBe('');
    expect(__internal.observedRelativeExtension(`import { test } from '@playwright/test';`)).toBeNull();

    // Our fixtures have no relative import, so the assumption is stated out loud.
    const outcome = extractFixture({ candidates: fixtureCandidates(), finding: 'f' }, CTX);
    expect(outcome.proposal!.rationale).toContain('That is an assumption, stated here');
  });

  it('hands bound names back out of the helper rather than leaving the spec undefined', () => {
    const setup = `  await page.goto('/checkout');\n  const total = page.getByTestId('total');\n`;
    const candidates = ['a', 'b'].map((suffix) => ({
      test: testRow({
        id: `bind-${suffix}`,
        name: `binds ${suffix}`,
        filePath: `tests/bind-${suffix}.spec.ts`,
        code: specWithSetup(`binds ${suffix}`, setup, `await expect(total).toHaveText('$42.00');`),
      }),
    }));

    const outcome = extractFixture({ candidates, finding: 'f' }, CTX);
    expect(outcome.problems).toEqual([]);
    expect(outcome.proposal!.after.artifacts[0]!.content).toContain('return { total };');
    const spec = outcome.proposal!.after.artifacts[1]!.content;
    expect(spec).toContain('const { total } = await setUpCheckout(page);');
  });

  it('excludes a declaration form it will not guess at', () => {
    const setup = `  await page.goto('/checkout');\n  const [first, second] = await page.$$('.row');\n`;
    const candidates = ['a', 'b'].map((suffix) => ({
      test: testRow({
        id: `arr-${suffix}`,
        name: `arr ${suffix}`,
        filePath: `tests/arr-${suffix}.spec.ts`,
        code: specWithSetup(`arr ${suffix}`, setup, `await expect(first).toBeVisible();`),
      }),
    }));
    const outcome = extractFixture({ candidates, finding: 'f' }, CTX);
    expect(outcome.excluded.every((item) => item.reason === 'BINDING_UNREADABLE')).toBe(true);
    expect(outcome.proposal).toBeNull();
  });
});

// ─── Strengthening ───────────────────────────────────────────────────────────

describe('strengthening an assertion', () => {
  it('computes the rewrite with no verifier and REFUSES to call it applyable', () => {
    const outcome = strengthenAssertions({ subject: weakSubject(), finding: 'EXISTENCE_ONLY' }, CTX);

    // The deterministic, key-free, runner-free path produced the plan…
    expect(outcome.pending).not.toBeNull();
    expect(outcome.pending!.after.artifacts[0]!.content).toContain('toBeVisible()');
    expect(outcome.pending!.after.artifacts[0]!.content).not.toContain('toBeTruthy()');

    // …and the plan is NOT a proposal, because nobody ran it.
    expect(outcome.proposal).toBeNull();
    expect(outcome.trial?.state).toBe('UNAVAILABLE');
    expect(outcome.problems.map((problem) => problem.kind)).toContain('STRENGTHENING_UNVERIFIED');
    expect(PROBLEM_BLOCKS_REFACTOR.STRENGTHENING_UNVERIFIED).toBe(true);
    expect(refactorBlocked(outcome)).toBe(true);
  });

  it('does not report the strengthened matcher as a dropped assertion', () => {
    const outcome = strengthenAssertions({ subject: weakSubject(), finding: 'f' }, CTX);
    // The token DID change, and it IS reported in the accounting…
    expect(outcome.assertions.dropped.some((token) => token.includes('tobetruthy'))).toBe(true);
    // …and it is not a refusal, because it is the intended effect.
    expect(outcome.problems.map((problem) => problem.kind)).not.toContain('ASSERTION_DROPPED');
    expect(outcome.problems.map((problem) => problem.kind)).not.toContain('COVERAGE_LOST');
  });

  it('a passing trial yields a proposal whose title says it passes', async () => {
    const outcome = await verifyStrengthening(
      { subject: weakSubject(), finding: 'f' },
      CTX,
      verifierSaying({ state: 'PASSED', why: 'the run was green', detail: ['1 passed'] }),
    );

    expect(outcome.trial?.state).toBe('PASSED');
    expect(outcome.proposal).not.toBeNull();
    expect(outcome.proposal!.title).toContain('verified: passes');
    expect(outcome.proposal!.rationale).toContain('PASSES against the application');
    expect(refactorBlocked(outcome)).toBe(false);
  });

  /*
   * The case the register is most careful about. A stronger assertion that goes
   * red is frequently the most valuable thing this engine produces — a weak
   * assertion was hiding a real defect — so suppressing it would be a failure
   * suppressed without being counted. It REACHES A HUMAN and says what it is.
   */
  it('a failing trial still reaches a human, and the proposal says it fails', async () => {
    const outcome = await verifyStrengthening(
      { subject: weakSubject(), finding: 'f' },
      CTX,
      verifierSaying({
        state: 'FAILED',
        why: 'order-list was not visible',
        detail: ['expected visible, got hidden'],
      }),
    );

    expect(outcome.trial?.state).toBe('FAILED');
    expect(outcome.proposal).not.toBeNull();
    expect(outcome.proposal!.title).toContain('FAILS');
    expect(outcome.proposal!.rationale).toContain('only a human can tell those apart');
    expect(outcome.proposal!.rationale).toContain('expected visible, got hidden');
    expect(outcome.problems.map((problem) => problem.kind)).toContain('STRENGTHENING_FAILED');
    // The ONE non-blocking problem, which is why the proposal survives.
    expect(PROBLEM_BLOCKS_REFACTOR.STRENGTHENING_FAILED).toBe(false);
    expect(refactorBlocked(outcome)).toBe(false);
  });

  it('a verifier that could not run blocks, exactly like never having asked', async () => {
    const outcome = await verifyStrengthening(
      { subject: weakSubject(), finding: 'f' },
      CTX,
      verifierSaying({ state: 'UNAVAILABLE', why: 'no checkout was available', detail: [] }),
    );
    expect(outcome.proposal).toBeNull();
    expect(outcome.problems.map((problem) => problem.kind)).toContain('STRENGTHENING_UNVERIFIED');
  });

  it('a verifier that THREW did not report a pass', async () => {
    const outcome = await verifyStrengthening({ subject: weakSubject(), finding: 'f' }, CTX, () => {
      throw new Error('the runner container died');
    });
    expect(outcome.trial?.state).toBe('UNAVAILABLE');
    expect(outcome.trial?.why).toContain('the runner container died');
    expect(outcome.proposal).toBeNull();
  });

  /*
   * The honest half of a short strengthening list. suite-health can SEE a
   * transport-only or volatile assertion and the stronger version is a claim
   * about the application that is not in the test, so it is reported rather
   * than guessed at.
   */
  it('reports a weakness it will not guess a fix for, rather than inventing one', () => {
    const volatileSpec = `import { expect, test } from '@playwright/test';

test('shows the time', async ({ page }) => {
  await page.goto('/orders');
  await expect(page.getByTestId('stamp')).toHaveText(new Date().toISOString());
});
`;
    const outcome = strengthenAssertions(
      { subject: weakSubject(volatileSpec), finding: 'VOLATILE_ASSERTION' },
      CTX,
    );

    expect(outcome.proposal).toBeNull();
    expect(outcome.pending).toBeNull();
    expect(outcome.problems[0]?.kind).toBe('NOTHING_TO_DO');
    expect(outcome.notStrengthened).toHaveLength(1);
    expect(outcome.notStrengthened[0]?.why).toContain('QAAI will not invent it');
    expect(outcome.problems[0]?.why).toContain('deliberately not guessed at');
  });

  it('leaves a negated truthy matcher alone, because the opposite is not stronger', () => {
    const negated = WEAK_SPEC.replace('.toBeTruthy()', '');
    const spec = negated.replace(
      `await expect(page.getByTestId('order-list'))`,
      `await expect(page.getByTestId('order-list')).not.toBeTruthy()`,
    );
    const outcome = strengthenAssertions({ subject: weakSubject(spec), finding: 'f' }, CTX);
    expect(outcome.pending).toBeNull();
    expect(outcome.problems[0]?.kind).toBe('NOTHING_TO_DO');
  });

  it('declines a multi-line assertion rather than corrupting it with a one-line rewrite', () => {
    const multiline = `import { expect, test } from '@playwright/test';

test('order page loads', async ({ page }) => {
  await page.goto('/orders');
  await expect(
    page.getByTestId('order-list')
  ).toBeTruthy();
});
`;
    const outcome = strengthenAssertions({ subject: weakSubject(multiline), finding: 'f' }, CTX);
    expect(outcome.pending).toBeNull();
    expect(outcome.notStrengthened[0]?.why).toContain('spans lines');
  });
});

// ─── Never destroy human work ────────────────────────────────────────────────

describe('ownership and reversibility', () => {
  it('is always PROPOSED, and PROPOSED is not applyable', () => {
    const outcomes = [
      mergeNearDuplicates({ members: mergeMembers(), finding: 'f' }, CTX),
      extractFixture({ candidates: fixtureCandidates(), finding: 'f' }, CTX),
    ];
    for (const outcome of outcomes) {
      expect(outcome.proposal!.state).toBe('PROPOSED');
    }
    /*
     * The structural half: the producer cannot emit an applyable state, because
     * exactly one state is applyable and it is not the one a producer writes.
     */
    expect(APPLYABLE_STATES.PROPOSED).toBe(false);
    expect(Object.entries(APPLYABLE_STATES).filter(([, applyable]) => applyable)).toEqual([
      ['APPROVED', true],
    ]);
  });

  it('proposes and never writes, when QAAI has no record of the files', () => {
    const outcome = extractFixture({ candidates: fixtureCandidates(), finding: 'f' }, CTX);
    for (const artifact of outcome.proposal!.after.artifacts) {
      expect(artifact.ownership).toBe('UNRECORDED');
      expect(WRITABLE_BY_OWNERSHIP[artifact.ownership]).toBe(false);
      expect(mayWriteDirectly(artifact)).toBe(false);
    }
  });

  it('downgrades to PROPOSED_EDIT when a human has changed a file QAAI wrote', () => {
    const [candidate] = fixtureCandidates();
    const ledger: ArtifactLedgerEntry[] = [
      {
        path: candidate!.test.filePath,
        role: 'SPEC',
        ownership: 'QAAI_OWNED',
        // A hash that is NOT the digest of the bytes on disk: a human edited it.
        contentHash: 'h0:stale',
        imports: [],
      },
    ];
    const outcome = extractFixture(
      { candidates: fixtureCandidates(), finding: 'f' },
      { digest, ledger, knownPaths: [] },
    );
    const artifact = outcome.proposal!.after.artifacts.find(
      (item) => item.path === candidate!.test.filePath,
    )!;
    expect(artifact.disposition).toBe('PROPOSED_EDIT');
    expect(mayWriteDirectly(artifact)).toBe(false);
  });

  it('records the bytes needed to put every touched file back', () => {
    const outcome = extractFixture({ candidates: fixtureCandidates(), finding: 'f' }, CTX);
    const proposal = outcome.proposal!;

    // An entry for every path, and nothing the proposal does not touch.
    const touched = new Set(proposal.after.artifacts.map((artifact) => artifact.path));
    expect(new Set(proposal.revert.paths)).toEqual(touched);
    expect(proposal.revert.entries).toHaveLength(touched.size);

    // The created helper has no prior bytes; the rewritten specs carry theirs.
    const helper = proposal.revert.entries.find((entry) =>
      entry.path.endsWith('.qaai-setup.ts'),
    )!;
    expect(helper.existed).toBe(false);

    const spec = proposal.revert.entries.find((entry) => entry.path === 'tests/confirm.spec.ts')!;
    expect(spec.existed).toBe(true);
    expect(spec.existed === true && spec.priorContent).toBe(fixtureCandidates()[0]!.test.code);
    expect(spec.existed === true && spec.priorHash).toBe(digest(fixtureCandidates()[0]!.test.code!));

    // And the keystone's own refusal list agrees it is complete.
    expect(proposalProblems(proposal)).toEqual([]);
  });

  /*
   * The hole neither the ledger nor `artifactSetProblems` closes. An extraction
   * records `{ existed: false }` for the helper it creates, and that record is
   * what licenses a revert to DELETE the file. If a human's file was already
   * there, the apply overwrites it and the revert destroys it — and
   * `artifactSetProblems` cannot say so, because it skips the surface check for
   * a NEW artifact and never reads prior bytes at a NEW path.
   */
  it('refuses to create a file when nobody said what is in the tree', () => {
    const outcome = extractFixture(
      { candidates: fixtureCandidates(), finding: 'f' },
      { digest, ledger: null, knownPaths: null },
    );
    expect(outcome.proposal).toBeNull();
    expect(outcome.problems[0]?.kind).toBe('TREE_UNKNOWN');
    expect(outcome.problems[0]?.why).toContain('what lets a revert delete it');
    // Null is not empty: the SAME inputs with a listing go through.
    expect(extractFixture({ candidates: fixtureCandidates(), finding: 'f' }, CTX).proposal).not.toBeNull();
  });

  it('refuses to create a file where one already is', () => {
    const outcome = extractFixture(
      { candidates: fixtureCandidates(), finding: 'f' },
      { digest, ledger: null, knownPaths: ['tests/Checkout.qaai-setup.ts'] },
    );
    expect(outcome.proposal).toBeNull();
    expect(outcome.problems[0]?.kind).toBe('PATH_OCCUPIED');
    expect(outcome.problems[0]?.why).toContain('reverting would delete it');
  });

  /*
   * Merging and strengthening create nothing, so they rewrite only a path a
   * test row already points at and an unlisted tree cannot hurt them. Pinned
   * because the easy mistake is to make the precondition global and refuse two
   * operations that do not need it.
   */
  it('lets the operations that create nothing work without a tree listing', () => {
    const blind: RefactorContext = { digest, ledger: null, knownPaths: null };
    expect(mergeNearDuplicates({ members: mergeMembers(), finding: 'f' }, blind).proposal).not.toBeNull();
    expect(strengthenAssertions({ subject: weakSubject(), finding: 'f' }, blind).pending).not.toBeNull();
  });

  it('touches nothing but the files it names', () => {
    const outcome = extractFixture(
      {
        candidates: [
          ...fixtureCandidates(),
          {
            test: testRow({
              id: 'untouched',
              name: 'untouched',
              filePath: 'tests/untouched.spec.ts',
              code: specWithSetup('untouched', `  await page.goto('/elsewhere');\n`, CARD_ASSERT),
            }),
          },
        ],
        finding: 'f',
      },
      CTX,
    );
    const paths = outcome.proposal!.after.artifacts.map((artifact) => artifact.path);
    expect(paths).not.toContain('tests/untouched.spec.ts');
    expect(outcome.proposal!.revert.paths).not.toContain('tests/untouched.spec.ts');
  });
});

// ─── Through the validator the write path actually runs ──────────────────────

describe('what the write path will accept', () => {
  /*
   * A test over a producer that ends at the producer proves the SPELLING of a
   * value and not that the value can be STORED. Eight producer-versus-validator
   * disagreements in this codebase were each found after the previous one was
   * declared the last, and every one wrote zero rows for a whole run behind one
   * `logger.warn`. So every proposal this module can emit is pushed through
   * `suiteChangeProposalSchema` — the validator the write path runs.
   */
  it('every proposal this module emits parses under suiteChangeProposalSchema', async () => {
    const strengthened = await verifyStrengthening(
      { subject: weakSubject(), finding: 'f' },
      CTX,
      verifierSaying({ state: 'PASSED', why: 'green', detail: [] }),
    );
    const proposals = [
      extractFixture({ candidates: fixtureCandidates(), finding: 'f' }, CTX).proposal,
      mergeNearDuplicates({ members: mergeMembers(), finding: 'f' }, CTX).proposal,
      strengthened.proposal,
    ];

    expect(proposals.every((proposal) => proposal !== null)).toBe(true);
    for (const proposal of proposals) {
      const parsed = suiteChangeProposalSchema.safeParse(proposal);
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [], null, 2)).toBe(true);
    }
  });

  /*
   * The worst case derived from the SCHEMA'S OWN CEILINGS rather than from an
   * invented awkward shape: `title` is max 200 and `rationale` max 2000, and a
   * test name is customer text with no bound at all.
   */
  it('stays inside the schema ceilings when the customer text is enormous', () => {
    const giant = 'z'.repeat(5_000);
    const code = TWO_IN_ONE_FILE.replace('checkout shows the total', giant);
    const outcome = mergeNearDuplicates(
      {
        members: [
          mergeMembers(code)[0]!,
          { test: { ...mergeMembers(code)[1]!.test, name: giant } },
        ],
        finding: giant,
      },
      CTX,
    );

    expect(outcome.proposal).not.toBeNull();
    expect(outcome.proposal!.title.length).toBeLessThanOrEqual(200);
    expect(outcome.proposal!.rationale.length).toBeLessThanOrEqual(2_000);
    expect(suiteChangeProposalSchema.safeParse(outcome.proposal).success).toBe(true);
  });

  /* The floor, not just the ceiling: `content` is `min(1)`, so no artifact may be empty. */
  it('never emits an empty artifact, which the schema floor would refuse', () => {
    const outcome = extractFixture({ candidates: fixtureCandidates(), finding: '' }, CTX);
    for (const artifact of outcome.proposal!.after.artifacts) {
      expect(artifact.content.length).toBeGreaterThan(0);
      expect(artifact.why.length).toBeGreaterThan(0);
    }
    expect(outcome.proposal!.rationale.length).toBeGreaterThan(0);
  });
});

// ─── Untrusted customer text ─────────────────────────────────────────────────

describe('customer text is data, and this module writes code', () => {
  /*
   * THE SECURITY CENTRE OF THIS FILE. A test name comes out of the customer's
   * repository and is interpolated into a string literal in code written BACK
   * into that repository, so a name that closes the literal is a write
   * primitive with nothing after it but `git push`.
   */
  it('a test name cannot close the string literal it is written into', () => {
    /*
     * The name is held in the file as a well-formed DOUBLE-quoted literal, so
     * the file still parses and the only question left is what this module does
     * when it writes that name back out. A single-quoted fixture would change
     * the file's own structure and the refusal under test would be
     * TEST_BLOCK_NOT_FOUND — a pass for the wrong reason.
     */
    const hostile = `x'); process.exit(1); test('`;
    const code = `import { expect, test } from '@playwright/test';

test("x'); process.exit(1); test('", async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.getByTestId('total')).toHaveText('$42.00');
});

test('checkout shows the heading', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
});
`;
    const outcome = mergeNearDuplicates(
      {
        members: [
          { test: { ...mergeMembers(code)[0]!.test, name: hostile } },
          { test: { ...mergeMembers(code)[1]!.test, name: 'checkout shows the heading' } },
        ],
        finding: 'f',
      },
      CTX,
    );

    const merged = outcome.proposal!.after.artifacts[0]!.content;
    // The payload survives only as DATA inside a literal, never as a statement.
    expect(merged).toContain('process.exit(1)');
    expect(merged).not.toMatch(/^\s*process\.exit\(1\);/m);
    // Exactly one test block: nothing broke out and opened another.
    expect(merged.match(/^test\(/gm)).toHaveLength(1);
    // And the result still reads as the file it is: balanced, parseable structure.
    expect(__internal.balanced(merged)).toBe(true);
    expect(__internal.testBlocks(merged).blocks).toHaveLength(1);
  });

  it('writes an untrusted name as a literal that re-reads to exactly itself', () => {
    /*
     * The property, rather than a spelling: whatever goes in comes back out of
     * `JSON.parse` unchanged, and the literal contains no raw character that
     * can end it. Asserting the escape SPELLING would pin `JSON.stringify`'s
     * choices; asserting the round trip pins the thing that matters.
     */
    for (const raw of [
      `a'b`,
      'a"b',
      'a\\b',
      'a\nb',
      'a\u2028b',
      'a\u2029b',
      '`${x}`',
      '*/ //',
      '\u0000',
    ]) {
      const literal = codeString(raw);
      /*
       * A successful round trip is what proves there is no UNESCAPED quote or
       * backslash: an unescaped one would either fail the parse or come back as
       * something else. The separate check below is for the characters
       * `JSON.parse` is HAPPY to accept raw and JavaScript is not.
       */
      expect(JSON.parse(literal)).toBe(raw);
      expect(literal).not.toMatch(/[\r\n\u2028\u2029]/);
    }
    /*
     * U+2028 and U+2029 are LEGAL inside a JSON string and are LINE TERMINATORS
     * in JavaScript source — the single hole a bare `JSON.stringify` leaves, so
     * it is pinned by spelling as well as by the round trip.
     */
    expect(codeString('a\u2028b')).toBe('"a\\u2028b"');
    expect(codeString('a\u2029b')).toBe('"a\\u2029b"');
    expect(codeString('a'.repeat(10_000)).length).toBeLessThan(200);
  });

  it('a name cannot end the comment it is written into', () => {
    expect(codeComment('ok\n*/ process.exit(1)')).not.toContain('*/');
    expect(codeComment('ok\nnext line')).not.toContain('\n');
    expect(codeComment('ok\u2028next')).not.toContain('\u2028');

    const hostile = '*/\nprocess.exit(1);\n/*';
    const code = TWO_IN_ONE_FILE.replace('checkout shows the heading', hostile);
    const outcome = mergeNearDuplicates(
      {
        members: [
          { test: { ...mergeMembers(code)[0]!.test, name: hostile } },
          mergeMembers(code)[1]!,
        ],
        finding: 'f',
      },
      CTX,
    );
    const merged = outcome.proposal!.after.artifacts[0]!.content;
    for (const line of merged.split('\n')) {
      if (line.includes('merged from:')) expect(line).not.toContain('*/');
    }
  });

  it('an identifier is built from an allow-list, so no input reaches an identifier position', () => {
    expect(safeIdentifier('Check out!', 'shared')).toBe('Checkout');
    expect(safeIdentifier('../../etc/passwd', 'shared')).toBe('etcpasswd');
    expect(safeIdentifier('2fa', 'shared')).toBe('_2fa');
    expect(safeIdentifier('!!!', 'shared')).toBe('shared');
    expect(safeIdentifier('', 'shared')).toBe('shared');
    expect(safeIdentifier('a'.repeat(500), 'shared')).toHaveLength(40);
  });

  /*
   * Untrusted text must never decide a FILE PATH. A feature name is customer
   * text and it contributes the helper's basename, so the traversal has to die
   * in the sanitiser and the guard has to agree.
   */
  it('a feature name cannot escape the directory it is written into', () => {
    const hostile = '../../../../etc/cron.d/x';
    const candidates = fixtureCandidates().map(({ test }) => ({
      test: { ...test, feature: hostile },
    }));
    const outcome = extractFixture({ candidates, finding: 'f' }, CTX);

    const helperPath = outcome.proposal!.after.artifacts[0]!.path;
    expect(helperPath).toBe('tests/etccrondx.qaai-setup.ts');
    expect(helperPath).not.toContain('..');
    expect(pathIsSafe(helperPath)).toBe(true);
  });

  it('refuses a path that is not repo-relative', () => {
    expect(pathIsSafe('tests/a.spec.ts')).toBe(true);
    expect(pathIsSafe('../a.spec.ts')).toBe(false);
    expect(pathIsSafe('/etc/passwd')).toBe(false);
    expect(pathIsSafe('tests\\a.ts')).toBe(false);
    expect(pathIsSafe('C:/a.ts')).toBe(false);
    expect(pathIsSafe('tests/a\nb.ts')).toBe(false);
    expect(pathIsSafe('')).toBe(false);
    expect(pathIsSafe(`${'a'.repeat(400)}.ts`)).toBe(false);
  });
});

// ─── The vocabularies, checked rather than claimed ───────────────────────────

describe('the closed unions', () => {
  /*
   * A compiler-enforced presence record and a run-time parity check, because one
   * without the other passes while the two disagree — the defect that shipped
   * eight GateRule kinds UNSAVEABLE for two slices.
   */
  it('declares a blocking decision for every problem kind, and no others', () => {
    expect(Object.keys(PROBLEM_BLOCKS_REFACTOR).sort()).toEqual([...REFACTOR_PROBLEMS].sort());
    expect(new Set(REFACTOR_PROBLEMS).size).toBe(REFACTOR_PROBLEMS.length);
  });

  it('blocks everything except the one failure that must reach a human', () => {
    const nonBlocking = REFACTOR_PROBLEMS.filter((kind) => !PROBLEM_BLOCKS_REFACTOR[kind]);
    expect(nonBlocking).toEqual(['STRENGTHENING_FAILED']);
  });

  /*
   * The record was first written as a SET OF STRINGS holding `'playwright-ts'`,
   * a spelling no dialect has — so every operation refused every file and a
   * test over the set would have agreed with it. A record cannot hold a name
   * that is not a dialect, and this is the run-time half that stops the two
   * lists drifting.
   */
  it('decides JavaScript-or-not for every dialect that exists', () => {
    expect(Object.keys(DIALECT_IS_JS).sort()).toEqual([...DIALECT_IDS].sort());
    expect(DIALECT_IDS.filter((id) => DIALECT_IS_JS[id])).toEqual(['JS_EXPECT', 'JS_CHAI']);
    // Null is not JavaScript: absence of evidence is not evidence.
    expect(__internal.readsAsJavaScript(null)).toBe(false);
    expect(__internal.readsAsJavaScript('PY_ASSERT')).toBe(false);
    expect(__internal.readsAsJavaScript('JS_EXPECT')).toBe(true);
  });

  it('has no DELETE operation, because a suite-change vocabulary may not have one', () => {
    const kinds = [
      extractFixture({ candidates: fixtureCandidates(), finding: 'f' }, CTX).kind,
      mergeNearDuplicates({ members: mergeMembers(), finding: 'f' }, CTX).kind,
      strengthenAssertions({ subject: weakSubject(), finding: 'f' }, CTX).kind,
    ];
    expect(kinds).toEqual(['EXTRACT_FIXTURE', 'MERGE_NEAR_DUPLICATES', 'STRENGTHEN_ASSERTION']);
    for (const kind of kinds) expect(kind).not.toContain('DELETE');
  });

  it('names a distinct exclusion reason for each thing it cannot prove', () => {
    expect(new Set(EXCLUSION_REASONS).size).toBe(EXCLUSION_REASONS.length);
  });

  /*
   * The biconditional every caller relies on: a non-null proposal means no
   * blocking problem. The alternative is a caller that reads a proposal as
   * "safe" while a blocking problem sits beside it in a field nobody
   * destructured.
   */
  it('hands back a proposal exactly when nothing blocks', async () => {
    const outcomes = [
      extractFixture({ candidates: fixtureCandidates(), finding: 'f' }, CTX),
      extractFixture({ candidates: [], finding: 'f' }, CTX),
      extractFixture({ candidates: [fixtureCandidates()[0]!], finding: 'f' }, CTX),
      extractFixture(
        { candidates: fixtureCandidates(), finding: 'f' },
        { digest, ledger: null, knownPaths: null },
      ),
      mergeNearDuplicates({ members: mergeMembers(), finding: 'f' }, CTX),
      mergeNearDuplicates({ members: [], finding: 'f' }, CTX),
      strengthenAssertions({ subject: weakSubject(), finding: 'f' }, CTX),
      await verifyStrengthening(
        { subject: weakSubject(), finding: 'f' },
        CTX,
        verifierSaying({ state: 'PASSED', why: 'green', detail: [] }),
      ),
      await verifyStrengthening(
        { subject: weakSubject(), finding: 'f' },
        CTX,
        verifierSaying({ state: 'FAILED', why: 'red', detail: [] }),
      ),
      await verifyStrengthening(
        { subject: weakSubject(), finding: 'f' },
        CTX,
        verifierSaying({ state: 'UNAVAILABLE', why: 'nothing to run on', detail: [] }),
      ),
    ];

    expect(outcomes).toHaveLength(10);
    for (const outcome of outcomes) {
      expect((outcome.proposal !== null) !== refactorBlocked(outcome)).toBe(true);
    }
  });
});

// ─── The scanners ────────────────────────────────────────────────────────────

describe('reading structure without a parser', () => {
  it('matches a delimiter past a quote that holds its twin', () => {
    const src = `f('}', "{", \`)\`)`;
    expect(__internal.matchDelim(src, 1)).toBe(src.length - 1);
    expect(__internal.matchDelim('{ a: { b: 1 } }', 0)).toBe(14);
    expect(__internal.matchDelim('{ unterminated', 0)).toBe(-1);
    expect(__internal.matchDelim('abc', 0)).toBe(-1);
  });

  it('reports an unbalanced block rather than guessing where it ends', () => {
    expect(__internal.balanced('a(b); c(d);')).toBe(true);
    expect(__internal.balanced('a(b;')).toBe(false);
    expect(__internal.balanced(`a('(');`)).toBe(true);
    expect(__internal.balanced(`a('`)).toBe(false);
  });

  it('reads a flat destructuring and refuses anything it would have to guess', () => {
    expect(__internal.paramNames('{ page, request }')).toEqual(['page', 'request']);
    expect(__internal.paramNames('{ page: p }')).toEqual(['p']);
    expect(__internal.paramNames('')).toEqual([]);
    expect(__internal.paramNames('page')).toEqual(['page']);
    expect(__internal.paramNames('{ page = null }')).toBeNull();
    expect(__internal.paramNames('{ ...rest }')).toBeNull();
    expect(__internal.paramNames('{ a: { b } }')).toBeNull();
  });

  it('reads the names a block declares, and refuses the forms it will not guess', () => {
    expect(__internal.blockBindings('const a = 1; let b = 2;').names).toEqual(['a', 'b']);
    expect(__internal.blockBindings('const { a, b: c } = x;').names).toEqual(['a', 'c']);
    expect(__internal.blockBindings('const [a] = x;').readable).toBe(false);
    expect(__internal.blockBindings('const { a: { b } } = x;').readable).toBe(false);
    expect(__internal.blockBindings('const { a = 1 } = x;').readable).toBe(false);
    expect(__internal.blockBindings('await page.goto("/x");').names).toEqual([]);
  });

  it('finds every locatable test block and skips the ones it cannot name', () => {
    const { blocks, readable } = __internal.testBlocks(TWO_IN_ONE_FILE);
    expect(readable).toBe(true);
    expect(blocks.map((block) => block.name)).toEqual([
      'checkout shows the heading',
      'checkout shows the total',
    ]);
    expect(blocks[0]!.params).toBe('{ page }');

    // `test.only(` is not `test(`: invisible here, which is the conservative direction.
    const only = __internal.testBlocks(`test.only('x', async ({ page }) => { await page.goto('/'); });`);
    expect(only.blocks).toEqual([]);

    // A dynamic name is a block we will not rewrite.
    const dynamic = __internal.testBlocks('test(name, async () => {});');
    expect(dynamic.blocks).toEqual([]);
  });

  it('blanks a string literal but keeps the code inside an interpolation', () => {
    const blanked = __internal.blankStrings("a('hello'); b(`x${y}z`);");
    expect(blanked).not.toContain('hello');
    expect(blanked).toContain('y');
    expect(blanked).toHaveLength("a('hello'); b(`x${y}z`);".length);
    // A newline inside a template literal survives, so line numbers still map.
    expect(__internal.blankStrings('`a\nb`')).toContain('\n');
  });

  it('keeps relative indentation when it re-indents a hoisted block', () => {
    const out = __internal.reindent('    a();\n      b();\n', '  ');
    expect(out).toBe('  a();\n    b();');
  });
});
