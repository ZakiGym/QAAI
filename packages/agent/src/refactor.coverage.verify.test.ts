/**
 * ADVERSARIAL VERIFICATION, SECOND PASS — the two defects the first pass left,
 * and the end-to-end proof the engine's own comment said was unreachable.
 *
 * `refactor.test.ts` tests the coverage invariant DIRECTLY and records, in
 * `__internal`, that "there is no legal input that makes COVERAGE_LOST fire
 * from the outside". That claim is false, and this file holds the input that
 * disproves it — which matters, because a gate whose failure path is only ever
 * reached through a test-only export is a gate nobody has watched refuse a real
 * operation.
 *
 * The two defects both had the same shape: a check that reads the right thing
 * and a REWRITE that can change something the check cannot see.
 *
 *   A MERGE WHOSE FIRST BODY ENDS THE RUN was proposed with a clean delta. The
 *   merged file still CONTAINED every assertion, so the invariant — a text
 *   scanner — reported no loss, while the second body never ran.
 *
 *   A FIXTURE EXTRACTION normalised setup with `/\s+/g → ' '`, which collapses
 *   whitespace inside a STRING LITERAL, so a dependent that filled
 *   `'4242  4242'` was judged byte-identical to one filling `'4242 4242'` and
 *   rewritten to the canonical fixture. Silently: it was then listed as
 *   extracted rather than excluded.
 *
 * Nothing here calls a model, a process, the filesystem or the network.
 */

import { describe, expect, it } from 'vitest';

import { APPLYABLE_STATES } from '@qaai/shared';
import { suiteChangeProposalSchema } from '@qaai/shared';
import type { SuiteHealthTestInput } from './suite-health.js';
import {
  PROBLEM_BLOCKS_REFACTOR,
  __internal,
  extractFixture,
  mergeNearDuplicates,
  refactorBlocked,
  strengthenAssertions,
} from './refactor.js';
import type { RefactorContext } from './refactor.js';

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

const FILE = 'tests/rows.spec.ts';

/** One file, two near-duplicates, and `prelude` injected into the first body. */
function fileWithPrelude(prelude: string): string {
  return `import { expect, test } from '@playwright/test';

test('alpha', async ({ page }) => {
${prelude}  await page.goto('/alpha');
  await expect(page.getByTestId('alpha')).toBeVisible();
});

test('beta', async ({ page }) => {
  await page.goto('/beta');
  await expect(page.getByTestId('beta')).toBeVisible();
});
`;
}

function membersOf(code: string): Array<{ test: SuiteHealthTestInput }> {
  return [
    { test: testRow({ id: 'a', name: 'alpha', filePath: FILE, code }) },
    { test: testRow({ id: 'b', name: 'beta', filePath: FILE, code }) },
  ];
}

// ── A merge whose first body never reaches the second ───────────────────────

describe('a merge whose first body ends or inverts the run', () => {
  /*
   * THE COUNTER-EXAMPLE FIRST, because a refusal list that refuses everything
   * is a feature nobody switches on. The same two tests with no prelude merge,
   * and the delta is MEASURED and clean.
   */
  it('is still merged when nothing in the body ends the run', () => {
    const outcome = mergeNearDuplicates({ members: membersOf(fileWithPrelude('')), finding: 'c' }, CTX);
    expect(outcome.proposal).not.toBeNull();
    expect(outcome.coverage.state).toBe('MEASURED');
    expect(outcome.problems).toEqual([]);
  });

  /*
   * `test.skip(browserName === 'firefox')` is the ordinary Playwright idiom for
   * a platform-gated duplicate, which is exactly the shape a near-duplicate
   * cluster is made of — so this is the common case, not a contrived one. The
   * merged file would still contain `getByTestId('beta')`, which is why the
   * coverage invariant cannot catch it and the refusal has to be on the text.
   */
  it('is refused when the first body calls test.skip(), which the invariant cannot see', () => {
    const outcome = mergeNearDuplicates(
      { members: membersOf(fileWithPrelude("  test.skip(browserName === 'firefox');\n")), finding: 'c' },
      CTX,
    );
    expect(outcome.problems.map((problem) => problem.kind)).toEqual(['MERGE_BODY_ABORTS']);
    expect(outcome.proposal).toBeNull();
    expect(refactorBlocked(outcome)).toBe(true);
    expect(PROBLEM_BLOCKS_REFACTOR.MERGE_BODY_ABORTS).toBe(true);
    // The reason names the mechanism, so a reviewer is not told "refused".
    expect(outcome.problems[0]?.why).toContain('test.skip()');
  });

  it.each([
    ['test.fixme()', '  test.fixme();\n'],
    ['test.fail()', '  test.fail();\n'],
    ['this.skip()', '  this.skip();\n'],
    ['a conditional throw', "  if (!process.env.FLAG) throw new Error('no');\n"],
  ])('is refused when the first body uses %s', (_label, prelude) => {
    const outcome = mergeNearDuplicates({ members: membersOf(fileWithPrelude(prelude)), finding: 'c' }, CTX);
    expect(outcome.problems.map((problem) => problem.kind)).toEqual(['MERGE_BODY_ABORTS']);
    expect(outcome.proposal).toBeNull();
  });

  /*
   * `test.fail()` INVERTS the outcome rather than ending the run, so its reason
   * must say that and not "a body appended after it would not run" — a refusal
   * that gives the wrong mechanism is the report being wrong out loud.
   */
  it('tells a reviewer that test.fail() inverts the outcome rather than ending the run', () => {
    const outcome = mergeNearDuplicates(
      { members: membersOf(fileWithPrelude('  test.fail();\n')), finding: 'c' },
      CTX,
    );
    expect(outcome.problems[0]?.why).toContain('INVERTS the expected outcome');
  });

  /*
   * `return` keeps its OWN refusal kind. Folding the two together would lose
   * the distinction a reviewer acts on, and this is the test that notices.
   */
  it('keeps MERGE_EARLY_RETURN distinct from the forms that are not a return', () => {
    const outcome = mergeNearDuplicates(
      { members: membersOf(fileWithPrelude('  if (!process.env.FLAG) return;\n')), finding: 'c' },
      CTX,
    );
    expect(outcome.problems.map((problem) => problem.kind)).toEqual(['MERGE_EARLY_RETURN']);
  });

  /*
   * The scan runs over a comment-stripped, string-blanked body, so prose about
   * skipping is not a refusal. Without this the refusal fires on any spec whose
   * comments discuss `test.skip`, which is a false refusal nobody can act on.
   */
  it('is not triggered by a mention of one of those forms in a comment or a locator', () => {
    const prelude =
      '  // we used to test.skip() here, and we do not any more\n' +
      "  await page.getByText('throw it away').click();\n";
    const outcome = mergeNearDuplicates({ members: membersOf(fileWithPrelude(prelude)), finding: 'c' }, CTX);
    expect(outcome.problems).toEqual([]);
    expect(outcome.proposal).not.toBeNull();
  });
});

// ── The invariant refusing a REAL merge, end to end ─────────────────────────

describe('the coverage invariant refuses a real merge, not only a crafted delta', () => {
  /**
   * THE INPUT `refactor.ts`'s `__internal` COMMENT SAYS DOES NOT EXIST.
   *
   * `gamma` sits BETWEEN the two merge members in document order and binds the
   * same name. `locatorBindings` is built over the whole file and the LAST
   * binding of a name wins, so before the merge `row` resolves to beta's
   * locator and after it — beta's body having moved up to alpha's position —
   * it resolves to gamma's. A token that was covered is not covered any more.
   *
   * THE PROPERTY THIS PINS is "a measured loss is refused by the operation",
   * not "locatorBindings is file-global and last-wins". If that extractor ever
   * becomes scope-aware this input stops producing a loss, and the right
   * response is to re-engineer the input — never to delete the test, because
   * then nothing watches the gate refuse through the public API again.
   */
  const SHADOWED = `import { expect, test } from '@playwright/test';

test('alpha', async ({ page }) => {
  await page.goto('/alpha');
  const row = page.getByTestId('row-alpha');
  await expect(row).toBeVisible();
});

test('gamma', async ({ page }) => {
  await page.goto('/gamma');
  const row = page.getByTestId('row-gamma');
  await expect(row).toBeVisible();
});

test('beta', async ({ page }) => {
  await page.goto('/beta');
  const row = page.getByTestId('row-beta');
  await expect(row).toBeVisible();
});
`;

  it('measures the surface before and after, and names the token it would stop covering', () => {
    const outcome = mergeNearDuplicates({ members: membersOf(SHADOWED), finding: 'cluster' }, CTX);

    // The comparison RAN. This is the state a refusal must not be read off.
    expect(outcome.coverage.state).toBe('MEASURED');
    if (outcome.coverage.state !== 'MEASURED') throw new Error('unreachable');
    expect(outcome.coverage.lost).toEqual(['assert:tobevisible:testid=row-beta:']);
    // A gain does not offset a loss, and both are reported.
    expect(outcome.coverage.gained).toEqual(['assert:tobevisible:testid=row-gamma:']);
    expect(outcome.coverage.kept).toBeGreaterThan(0);
  });

  it('REFUSES it — no proposal, not a warning beside one', () => {
    const outcome = mergeNearDuplicates({ members: membersOf(SHADOWED), finding: 'cluster' }, CTX);

    expect(outcome.proposal).toBeNull();
    expect(refactorBlocked(outcome)).toBe(true);
    /*
     * BOTH refusals fire, and that is not redundancy: COVERAGE_LOST is about
     * the whole surface and ASSERTION_DROPPED is about the assertion union, so
     * a change to either facet's bookkeeping leaves the other one holding.
     */
    expect(outcome.problems.map((problem) => problem.kind).sort()).toEqual([
      'ASSERTION_DROPPED',
      'COVERAGE_LOST',
    ]);
    expect(outcome.assertions.dropped).toEqual(['assert:tobevisible:testid=row-beta:']);
  });
});

// ── A dependent that relied on a difference INSIDE a literal ───────────────

describe('setup equivalence over string literals', () => {
  const spec = (name: string, setup: string, assertion: string): string =>
    `import { expect, test } from '@playwright/test';\n\ntest('${name}', async ({ page }) => {\n${setup}  ${assertion}\n});\n`;

  const ONE_SPACE =
    "  await page.goto('/checkout');\n  await page.getByLabel('Card number').fill('4242 4242');\n";
  /** The same lines, with a doubled space INSIDE the literal. Different data. */
  const TWO_SPACES =
    "  await page.goto('/checkout');\n  await page.getByLabel('Card number').fill('4242  4242');\n";
  /**
   * The same lines, differing only in INDENTATION.
   *
   * Not reflowed across the member access: a line break before `.fill(`
   * normalises to a space, so `) .fill(` and `).fill(` are unequal here and
   * were unequal before this fix too. That is the operation's standing
   * behaviour and not something this round changed — recorded because it is the
   * obvious counter-example to reach for and it does not hold.
   */
  const REFLOWED =
    "      await page.goto('/checkout');\n        await page.getByLabel('Card number').fill('4242 4242');\n";

  function candidatesFor(third: string): Array<{ test: SuiteHealthTestInput }> {
    return [
      { test: testRow({ id: 'c1', name: 'one', filePath: 'tests/one.spec.ts', code: spec('one', ONE_SPACE, "await expect(page.getByTestId('ok')).toBeVisible();") }) },
      { test: testRow({ id: 'c2', name: 'two', filePath: 'tests/two.spec.ts', code: spec('two', ONE_SPACE, "await expect(page.getByTestId('total')).toHaveText('$1.00');") }) },
      { test: testRow({ id: 'c3', name: 'three', filePath: 'tests/three.spec.ts', code: spec('three', third, "await expect(page.getByTestId('err')).toBeVisible();") }) },
    ];
  }

  /*
   * THE DEFECT. `/\s+/g → ' '` made these two setups one string, so the
   * dependent that supplied the doubled space was INCLUDED and rewritten to
   * call a helper that supplies the other value — and it was then reported as
   * extracted, which is why nothing would have surfaced it.
   */
  it('EXCLUDES a dependent whose setup differs only inside a literal, and says why', () => {
    const outcome = extractFixture({ candidates: candidatesFor(TWO_SPACES), finding: 'dup setup' }, CTX);

    expect(outcome.excluded.map((item) => [item.testId, item.reason])).toEqual([
      ['c3', 'SETUP_NOT_IDENTICAL'],
    ]);
    expect(outcome.proposal?.dependentTestIds).toEqual(['c1', 'c2']);
    // Its own file is not in the proposal at all, so nothing rewrote it.
    const paths = outcome.proposal?.after.artifacts.map((artifact) => artifact.path) ?? [];
    expect(paths).not.toContain('tests/three.spec.ts');
    expect(outcome.proposal?.revert.paths).not.toContain('tests/three.spec.ts');
  });

  /*
   * THE COUNTER-EXAMPLE, and the reason the fix is not "compare the bytes".
   * Indentation and line breaks are exactly the differences the proof must
   * ignore, or the operation never fires and the copy-pasted setup stays.
   */
  it('still includes a dependent whose setup differs only in indentation and line breaks', () => {
    const outcome = extractFixture({ candidates: candidatesFor(REFLOWED), finding: 'dup setup' }, CTX);

    expect(outcome.excluded).toEqual([]);
    expect(outcome.proposal?.dependentTestIds).toEqual(['c1', 'c2', 'c3']);
  });

  it('collapses whitespace in code and preserves it inside a literal, including a template', () => {
    const { collapseOutsideStrings } = __internal;

    expect(collapseOutsideStrings("  await  page .fill( 'a  b' ) ;\n")).toBe(
      "await page .fill( 'a  b' ) ;",
    );
    // Two literals that differ only inside the quotes stay different.
    expect(collapseOutsideStrings("fill('a  b')")).not.toBe(collapseOutsideStrings("fill('a b')"));
    // A newline inside a template literal is data and survives.
    expect(collapseOutsideStrings('fill(`a\nb`)')).toBe('fill(`a\nb`)');
    expect(collapseOutsideStrings('fill(`a\nb`)')).not.toBe(collapseOutsideStrings('fill(`a b`)'));
    /*
     * An interpolation is CODE and collapses like code, for the reason
     * `blankStrings` records: `${BASE}` is where the real identifiers live.
     * "Like code" means a RUN of whitespace becomes one space — not that it
     * disappears, which is the same thing `/\s+/g → ' '` did and is why
     * `${ BASE }` and `${BASE}` were never equal here.
     */
    expect(collapseOutsideStrings('goto(`${  BASE  }/orders`)')).toBe(
      collapseOutsideStrings('goto(`${ BASE }/orders`)'),
    );
    expect(collapseOutsideStrings('goto(`${ BASE }/orders`)')).toBe('goto(`${ BASE }/orders`)');
    // The surrounding literal is still data: a run there does NOT collapse.
    expect(collapseOutsideStrings('goto(`${BASE}/a  b`)')).toBe('goto(`${BASE}/a  b`)');
    // An escaped quote does not end the literal, so the bytes after it are data.
    expect(collapseOutsideStrings("fill('a\\'b  c')")).toBe("fill('a\\'b  c')");
  });
});

// ── An unverified strengthening cannot be promoted by its own producer ──────

describe('an unverified strengthening reaching the store', () => {
  const WEAK = `import { expect, test } from '@playwright/test';

test('order page loads', async ({ page }) => {
  await page.goto('/orders');
  await expect(page.getByTestId('order-list')).toBeTruthy();
});
`;

  /*
   * `refactor.adversarial.verify.test.ts` proves the outcome hands over no
   * proposal. This is the next question: the `pending` object IS shaped like a
   * proposal, so what happens when somebody stores it anyway. It must land in a
   * state nothing may apply — the producer's own opinion is not an approval.
   */
  it('parses, and lands in a state nothing may apply', () => {
    const outcome = strengthenAssertions(
      { subject: { test: testRow({ id: 'w1', name: 'order page loads', filePath: 'tests/orders.spec.ts', code: WEAK }) }, finding: 'weak' },
      CTX,
    );

    expect(outcome.proposal).toBeNull();
    expect(outcome.problems.map((problem) => problem.kind)).toContain('STRENGTHENING_UNVERIFIED');
    expect(outcome.trial?.state).toBe('UNAVAILABLE');

    const parsed = suiteChangeProposalSchema.safeParse(outcome.pending);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.state).toBe('PROPOSED');
    expect(APPLYABLE_STATES[parsed.data.state]).toBe(false);
  });
});
