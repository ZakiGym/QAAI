/**
 * Heal-applier tests, written around the guard that was a no-op.
 *
 * `applyHealDiff` has three jobs and only one of them is "apply a patch". The
 * other two are refusals: a heal may not delete a test, and a heal may not
 * leave the test asserting less than it did. The second refusal counted
 * `expect(` and `assert(`, which is JavaScript — so in a Go, pytest, JUnit or
 * RSpec repository the count was 0 before and 0 after, the comparison held, and
 * the guard reported success about a patch that could have deleted every
 * assertion in the file. A guard that passes everywhere nobody is looking is
 * worse than no guard, because the product claims it ran.
 *
 * So the cases below come in pairs: the same weakening patch in JavaScript
 * (refused before this change and still refused) and in another language
 * (silently accepted before this change, refused now). The last pair is the
 * honest third answer — a file type with no lexicon at all, where the right
 * behaviour is neither "refuse" nor "pass", but "applied, and nobody has
 * checked this".
 */

import { describe, expect, it } from 'vitest';
import {
  applyHealDiff,
  normalizeHunkHeaders,
  postCheckCode,
  postCheckToolchain,
  syntaxIsReachableWithoutACheckout,
} from './heal-apply.js';
import type { ToolchainGates } from './admission.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const JS_TEST = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test('checkout charges the right total', async ({ page }) => {",
  "  await page.goto('/checkout');",
  "  await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
  '});',
].join('\n');

/** The patch the never-weaken guard exists to stop: the assertion becomes a wait. */
const JS_DROPS_THE_ASSERTION = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -4,2 +4,2 @@',
  "   await page.goto('/checkout');",
  "-  await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
  "+  await page.waitForTimeout(500);",
].join('\n');

const JS_FIXES_THE_SELECTOR = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -5,1 +5,1 @@',
  "-  await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
  "+  await expect(page.getByTestId('checkout-total')).toHaveText('$42.00');",
].join('\n');

const GO_TEST = [
  'func TestCheckoutTotal(t *testing.T) {',
  '\tgot := totalFrom(page)',
  '\tif got != "$42.00" {',
  '\t\tt.Fatalf("order total = %q, want $42.00", got)',
  '\t}',
  '}',
].join('\n');

/** Byte-for-byte the same move as JS_DROPS_THE_ASSERTION, in Go. */
const GO_DROPS_THE_ASSERTION = [
  '--- a/internal/checkout_test.go',
  '+++ b/internal/checkout_test.go',
  '@@ -1,6 +1,4 @@',
  ' func TestCheckoutTotal(t *testing.T) {',
  ' \tgot := totalFrom(page)',
  '-\tif got != "$42.00" {',
  '-\t\tt.Fatalf("order total = %q, want $42.00", got)',
  '-\t}',
  '+\t_ = got',
  ' }',
].join('\n');

const PY_TEST = [
  'def test_checkout_charges_the_right_total(page: Page):',
  '    page.goto("/checkout")',
  '    assert page.get_by_test_id("order-total").inner_text() == "$42.00"',
].join('\n');

const PY_DROPS_THE_ASSERTION = [
  '--- a/tests/test_checkout.py',
  '+++ b/tests/test_checkout.py',
  '@@ -2,2 +2,2 @@',
  '     page.goto("/checkout")',
  '-    assert page.get_by_test_id("order-total").inner_text() == "$42.00"',
  '+    page.wait_for_timeout(500)',
].join('\n');

const TWO_GO_TESTS = [
  'func TestCheckoutTotal(t *testing.T) {',
  '\tt.Fatal("not yet")',
  '}',
  '',
  'func TestCheckoutReceipt(t *testing.T) {',
  '\tt.Fatal("not yet either")',
  '}',
].join('\n');

const GO_DELETES_A_TEST = [
  '--- a/internal/checkout_test.go',
  '+++ b/internal/checkout_test.go',
  '@@ -4,4 +4,0 @@',
  '-',
  '-func TestCheckoutReceipt(t *testing.T) {',
  '-\tt.Fatal("not yet either")',
  '-}',
].join('\n');

// ─── The applier itself ──────────────────────────────────────────────────────

describe('applying a heal', () => {
  it('applies a clean selector fix exactly', () => {
    const result = applyHealDiff(JS_TEST, JS_FIXES_THE_SELECTOR, {
      filePath: 'tests/checkout.spec.ts',
    });

    expect(result.ok).toBe(true);
    expect(result.fuzz).toBe(0);
    expect(result.code).toContain('checkout-total');
    // Nothing to review: the dialect was known and the count held.
    expect(result.review).toBeUndefined();
  });

  it('refuses an empty, a no-op and an unplaceable diff', () => {
    expect(applyHealDiff(JS_TEST, '   ').reason).toMatch(/no diff/);
    const stale = [
      '--- a/tests/checkout.spec.ts',
      '+++ b/tests/checkout.spec.ts',
      '@@ -1,1 +1,1 @@',
      '-import { somethingElse } from "nowhere";',
      '+import { test } from "@playwright/test";',
    ].join('\n');
    expect(applyHealDiff(JS_TEST, stale).ok).toBe(false);
    expect(applyHealDiff(JS_TEST, stale).reason).toMatch(/no longer applies/);
  });

  it('repairs a model-miscounted hunk header rather than rejecting the patch', () => {
    // The counts below are wrong on purpose; jsdiff throws on them.
    const wrong = [
      '--- a/tests/checkout.spec.ts',
      '+++ b/tests/checkout.spec.ts',
      '@@ -5,9 +5,9 @@',
      "-  await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
      "+  await expect(page.getByTestId('checkout-total')).toHaveText('$42.00');",
    ].join('\n');

    expect(normalizeHunkHeaders(wrong)).toContain('@@ -5,1 +5,1 @@');
    expect(applyHealDiff(JS_TEST, wrong, { filePath: 'tests/checkout.spec.ts' }).ok).toBe(true);
  });
});

// ─── The never-weaken guard, in every language ───────────────────────────────

describe('the never-weaken guard', () => {
  it('refuses a JavaScript heal that turns an assertion into a wait', () => {
    const result = applyHealDiff(JS_TEST, JS_DROPS_THE_ASSERTION, {
      filePath: 'tests/checkout.spec.ts',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/removes 1 assertion/);
  });

  it('refuses the same heal in JavaScript even when the caller names no file', () => {
    // The pre-dialect behaviour, kept as a floor: the two call sites in apps/
    // do not pass a path yet, and a JavaScript assertion that disappears has to
    // keep being caught until they do.
    const result = applyHealDiff(JS_TEST, JS_DROPS_THE_ASSERTION);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/removes 1 assertion/);
  });

  it('refuses a Go heal that deletes the t.Fatalf — the case that used to pass', () => {
    /*
     * This is the whole point. Go's standard library has no assertion function:
     * failing the test IS the assertion. `expect(`-counting saw 0 before and 0
     * after, so this patch was applied with a clean bill of health, and a
     * repository that opted into auto-apply got a test that can no longer fail.
     */
    const result = applyHealDiff(GO_TEST, GO_DROPS_THE_ASSERTION, {
      filePath: 'internal/checkout_test.go',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/removes 1 assertion/);
  });

  it('refuses a pytest heal that deletes the assert', () => {
    const result = applyHealDiff(PY_TEST, PY_DROPS_THE_ASSERTION, {
      filePath: 'tests/test_checkout.py',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/removes 1 assertion/);
  });

  it('resolves the dialect from a runner id when the path cannot', () => {
    // A Cypress spec is `.ts` and asserts with `.should(...)`, which no
    // `expect(` regex has ever found.
    const cypress = ["cy.visit('/checkout');", "cy.get('[data-cy=total]').should('have.text', '$42.00');"].join(
      '\n',
    );
    const dropsIt = [
      '--- a/cypress/e2e/checkout.ts',
      '+++ b/cypress/e2e/checkout.ts',
      '@@ -2,1 +2,1 @@',
      "-cy.get('[data-cy=total]').should('have.text', '$42.00');",
      "+cy.get('[data-cy=total]');",
    ].join('\n');

    expect(applyHealDiff(cypress, dropsIt, { filePath: 'cypress/e2e/checkout.ts' }).ok).toBe(true);
    expect(
      applyHealDiff(cypress, dropsIt, {
        filePath: 'cypress/e2e/checkout.ts',
        ecosystemId: 'cypress',
      }).ok,
    ).toBe(false);
  });

  it('lets a heal that ADDS an assertion through', () => {
    const adds = [
      '--- a/internal/checkout_test.go',
      '+++ b/internal/checkout_test.go',
      '@@ -5,1 +5,2 @@',
      ' \t}',
      '+\trequire.Equal(t, "Order confirmed", heading)',
    ].join('\n');

    expect(applyHealDiff(GO_TEST, adds, { filePath: 'internal/checkout_test.go' }).ok).toBe(true);
  });

  it('refuses a heal that deletes a whole test case, in Go', () => {
    // The test-block count had the same JavaScript-only hole: `\btest\s*\(`
    // matches nothing in a Go file, so `testsBefore > 0` was false and the
    // guard never ran.
    const result = applyHealDiff(TWO_GO_TESTS, GO_DELETES_A_TEST, {
      filePath: 'internal/checkout_test.go',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/removes 1 test block/);
  });
});

// ─── When the guard cannot run at all ────────────────────────────────────────

describe('a file type with no assertion lexicon', () => {
  const BATS = ['@test "checkout charges the right total" {', '  run pay', '  [ "$status" -eq 0 ]', '}'].join(
    '\n',
  );
  const EDITS_IT = [
    '--- a/tests/checkout.bats',
    '+++ b/tests/checkout.bats',
    '@@ -3,1 +3,1 @@',
    '-  [ "$status" -eq 0 ]',
    '+  sleep 1',
  ].join('\n');

  it('applies the patch but says the assertion count was not verified', () => {
    /*
     * Not a refusal: refusing every heal on an unrecognised file type would
     * brick healing for a whole repository over a file extension. Not silence
     * either — `ok: true` with nothing else said is indistinguishable from "the
     * guard ran and the test is fine", which is the exact dishonesty the
     * dialect work exists to remove.
     */
    const result = applyHealDiff(BATS, EDITS_IT, { filePath: 'tests/checkout.bats' });

    expect(result.ok).toBe(true);
    expect(result.code).toContain('sleep 1');
    expect(result.review).toMatch(/assertion count could not be read/);
    expect(result.review).toContain('tests/checkout.bats');
  });

  it('says which is missing when the caller supplied no path at all', () => {
    const result = applyHealDiff(BATS, EDITS_IT);

    expect(result.ok).toBe(true);
    expect(result.review).toMatch(/no file path was supplied/);
  });
});

// ─── Post-check parity: the gates, on the patched file ───────────────────────

/**
 * The second defect this module answers.
 *
 * `applyHealDiff` above is strict about ONE thing — never weaken an assertion —
 * and said nothing about everything else a model reaches for when it is asked
 * to make a red test green: a fixed sleep, a `div:nth-child(3)` locator, an
 * `@qaai/` import, a brace it forgot to close. The Generator ran twelve gates
 * over its output. This path ran one. And the one path that writes the file with
 * NO HUMAN IN THE LOOP was one of the two that skipped them.
 *
 * The cases below are about the three decisions in `postCheckCode` that are not
 * obvious, and each one is a decision somebody could reasonably disagree with:
 *
 *   1. which failures REFUSE a heal (exactly one: the file does not parse),
 *   2. which notion of never-weaken is the AUTHORITY (the applier's, because it
 *      is the only one that can see the file as it was before),
 *   3. what the UNATTENDED path does that the reviewed ones do not (decline on
 *      anything short of a clean pass, including "nobody checked").
 *
 * Nothing here calls a model, and nothing here needs an API key: the only live
 * toolchain gate on this path is an in-process TypeScript parse.
 */

const CLEAN_SPEC = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test('checkout charges the right total', async ({ page }) => {",
  "  await page.goto('/checkout');",
  "  await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
  '});',
].join('\n');

/** The heal a model writes when the element is slow: wait for the clock. */
const ADDS_A_FIXED_SLEEP = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -4,1 +4,2 @@',
  "   await page.goto('/checkout');",
  '+  await page.waitForTimeout(500);',
].join('\n');

/** The heal a model writes when it stops using the locators it was handed. */
const ADDS_A_BRITTLE_LOCATOR = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -5,1 +5,1 @@',
  "-  await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
  "+  await expect(page.locator('div.sc-x7f2 > span:nth-child(3)')).toHaveText('$42.00');",
].join('\n');

/** …and the one that cannot run where it is going to live. */
const ADDS_A_QAAI_IMPORT = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -1,1 +1,2 @@',
  "+import { waitForTotal } from '@qaai/helpers';",
  " import { test, expect } from '@playwright/test';",
].join('\n');

/** A brace the model lost. The runner's answer to this is "no report at all". */
const BREAKS_THE_FILE = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -6,1 +6,1 @@',
  '-});',
  '+}',
].join('\n');

/** Applies the patch, asserts it applied, and hands the result to the gates. */
async function healAndCheck(original: string, diff: string, filePath: string) {
  const applied = applyHealDiff(original, diff, { filePath });
  expect(applied.ok, applied.reason).toBe(true);
  return postCheckCode({ code: applied.code!, filePath, testType: 'E2E' });
}

describe('the rules the heal path used to skip', () => {
  it('flags a heal that introduces a fixed sleep, and refuses to auto-apply it', async () => {
    /*
     * The headline case. A fixed sleep is both the slowest possible wait and
     * the least reliable one, the rule against it is in UNIVERSAL_RULES, and
     * until now a heal could add one and nothing looked.
     *
     * It is a WARN, so the two reviewed paths take the fix and tell the human —
     * leaving a test red over a sleep would be a worse trade. The unattended
     * path declines, because a flag is a message to a human and there is no
     * human there to read it.
     */
    const check = await healAndCheck(CLEAN_SPEC, ADDS_A_FIXED_SLEEP, 'tests/checkout.spec.ts');

    expect(check.allowed).toBe(true);
    expect(check.flags.join(' ')).toMatch(/sleeps for a fixed duration/);
    expect(check.autoApplyAllowed).toBe(false);
    expect(check.autoApplyDeclined).toMatch(/no fixed sleep/);
  });

  it('flags a heal that swaps a test id for a generated class and a sibling position', async () => {
    const check = await healAndCheck(CLEAN_SPEC, ADDS_A_BRITTLE_LOCATOR, 'tests/checkout.spec.ts');

    expect(check.allowed).toBe(true);
    expect(check.flags.join(' ')).toMatch(/coupled to things that are not the behaviour/);
    expect(check.autoApplyAllowed).toBe(false);
  });

  it('flags a heal that imports from QAAI — a file that cannot run where it lives', async () => {
    const check = await healAndCheck(CLEAN_SPEC, ADDS_A_QAAI_IMPORT, 'tests/checkout.spec.ts');

    // NOT a refusal. It is one import line, the most mechanically fixable
    // failure there is, and the test is still about the right thing — so a
    // human takes the fix and deletes the line. Unattended, nobody would.
    expect(check.allowed).toBe(true);
    expect(check.flags.join(' ')).toMatch(/depends on QAAI/);
    expect(check.autoApplyAllowed).toBe(false);
    expect(check.autoApplyDeclined).toMatch(/no QAAI dependency/);
  });
});

describe('a heal that does not parse', () => {
  it('is refused outright, on every path, when the parse is reachable', async () => {
    /*
     * The one refusal, and the reasoning is a comparison rather than a
     * principle: a heal replaces a test that is CURRENTLY RED, so refusing it
     * has to be better than taking it. For a file that does not parse it is,
     * and by a distance — the red test fails with an assertion error naming a
     * line, while the unparseable one fails with "the runner produced no
     * report" and takes every sibling test in the file down with it. The
     * customer keeps the red test they already had and the proposal stays on
     * record, so the refusal costs them nothing.
     */
    const check = await healAndCheck(CLEAN_SPEC, BREAKS_THE_FILE, 'tests/checkout.spec.ts');

    expect(check.allowed).toBe(false);
    expect(check.refusal).toMatch(/does not parse/);
    // The line number comes along: a refusal a human cannot act on is a dead end.
    expect(check.refusal).toMatch(/line 6/);
    expect(check.autoApplyAllowed).toBe(false);
  });

  it('reports the parse as NOT CHECKED, rather than passed, when it is unreachable', async () => {
    /*
     * There is no checkout on this path, so there is no `go build` to run — and
     * faking a PASS is the original defect wearing a new hat. The honest answer
     * is in `checks`, which says "parses" is among the things nobody checked,
     * and the gates that CAN read a Go file still do their job.
     *
     * This deliberately does NOT block auto-apply. A Go or pytest shop that
     * opted into auto-apply would otherwise find it silently switched off by a
     * check that can never run for them — a feature quietly disabled is as
     * dishonest as a gate that lies. They lose nothing they had and gain the
     * sleep, locator and lock-in checks they never had.
     */
    const brokenGo = ['func TestCheckoutTotal(t *testing.T) {', '\tif got != "$42.00" {', '\t\tt.Fatalf("x")'].join(
      '\n',
    );
    const check = await postCheckCode({
      code: brokenGo,
      filePath: 'internal/checkout_test.go',
      testType: 'E2E',
    });

    expect(check.checks).toMatch(/Not checked: parses/);
    expect(check.checks).not.toMatch(/Checked after patching:[^.]*parses/);
    expect(check.allowed).toBe(true);
    expect(check.autoApplyAllowed).toBe(true);
    // And the dialect-based gates genuinely ran on it.
    expect(check.checks).toMatch(/Checked after patching: asserts something/);
  });

  it('declines the unattended path when a reachable parse came back unanswered', async () => {
    /*
     * The other side of the same judgement. A toolchain the caller supplied is
     * a claim of real coverage, so an UNAVAILABLE from it is a fact about THIS
     * file — the parser was there and did not answer — and the unattended path
     * has lost its premise. A human still gets the fix.
     */
    const silent: ToolchainGates = {
      syntax: async () => ({
        gate: 'SYNTAX',
        status: 'UNAVAILABLE',
        why: 'the parser crashed',
        detail: [],
        line: null,
      }),
      typecheck: async () => ({
        gate: 'TYPECHECK',
        status: 'UNAVAILABLE',
        why: 'not wired',
        detail: [],
        line: null,
      }),
      format: async () => ({
        gate: 'FORMAT',
        status: 'UNAVAILABLE',
        why: 'not wired',
        detail: [],
        line: null,
      }),
      lint: async () => ({
        gate: 'LINT',
        status: 'UNAVAILABLE',
        why: 'not wired',
        detail: [],
        line: null,
      }),
    };

    const check = await postCheckCode({
      code: CLEAN_SPEC,
      filePath: 'tests/checkout.spec.ts',
      testType: 'E2E',
      toolchain: silent,
    });

    expect(check.allowed).toBe(true);
    expect(check.autoApplyAllowed).toBe(false);
    expect(check.autoApplyDeclined).toMatch(/"parses" came back UNAVAILABLE/);
  });
});

describe('never-weaken has exactly one authority', () => {
  /*
   * Two things in this codebase could claim to enforce "a heal may not leave
   * the test asserting less than it did", and two authorities on the same rule
   * is how they start disagreeing about the same patch.
   *
   * The applier wins, and the reason is structural rather than a preference:
   * never-weaken is a RELATIVE question — fewer assertions than BEFORE — and
   * `admit` has no "before". `AdmissionInput` carries one file. The ASSERTIONS
   * gate answers a different, absolute question: does the result assert
   * anything worth anything. So the applier REFUSES and the gate FLAGS, and
   * the two tests below pin exactly that.
   */

  it('refuses in the applier, which never reaches the gates', () => {
    const applied = applyHealDiff(JS_TEST, JS_DROPS_THE_ASSERTION, {
      filePath: 'tests/checkout.spec.ts',
    });

    // `ok: false` and no `code`, so there is nothing for `postCheckCode` to be
    // asked about: the refusal happened before the gates could have an opinion.
    expect(applied.ok).toBe(false);
    expect(applied.code).toBeUndefined();
    expect(applied.reason).toMatch(/removes 1 assertion/);
  });

  it('flags but does not refuse in the gates, so the two can never disagree', async () => {
    /*
     * The overlap case, and the one that shows why the gate must not refuse.
     * This test asserted nothing BEFORE the heal and asserts nothing after, so
     * never-weaken correctly permits it (0 is not fewer than 0) while the
     * ASSERTIONS gate correctly dislikes it. Refusing here would not buy the
     * customer a single assertion — the file was already assertion-free — and
     * it WOULD leave them with a broken test and no proposal.
     */
    const noAssertions = [
      "import { test } from '@playwright/test';",
      '',
      "test('checkout', async ({ page }) => {",
      "  await page.goto('/checkout');",
      '});',
    ].join('\n');
    const retargets = [
      '--- a/tests/checkout.spec.ts',
      '+++ b/tests/checkout.spec.ts',
      '@@ -4,1 +4,1 @@',
      "-  await page.goto('/checkout');",
      "+  await page.goto('/cart/checkout');",
    ].join('\n');

    const applied = applyHealDiff(noAssertions, retargets, { filePath: 'tests/checkout.spec.ts' });
    expect(applied.ok).toBe(true);

    const check = await postCheckCode({
      code: applied.code!,
      filePath: 'tests/checkout.spec.ts',
      testType: 'E2E',
    });

    expect(check.allowed).toBe(true);
    expect(check.flags.join(' ')).toMatch(/makes no assertion anywhere/);
    // Unattended, though, "the test asserts nothing" is not something to write
    // into a customer's repository with nobody told.
    expect(check.autoApplyAllowed).toBe(false);
  });
});

describe('the record of what was checked', () => {
  it('names the checks that ran AND the checks that did not, even on a clean heal', async () => {
    /*
     * "No flags" has to be distinguishable from "nothing looked", which is the
     * whole reason this string exists. A heal that passes everything still
     * carries the list, because four of the twelve gates cannot run on a path
     * with no repository checkout and a human deciding whether to trust this
     * needs to know which four.
     */
    const check = await healAndCheck(JS_TEST, JS_FIXES_THE_SELECTOR, 'tests/checkout.spec.ts');

    expect(check.flags).toEqual([]);
    expect(check.checks).toContain('Checked after patching: parses, asserts something');
    expect(check.checks).toContain('no fixed sleep');
    // The four that need the customer's own tooling, named rather than implied.
    expect(check.checks).toMatch(/Not checked:[^.]*typecheck/);
    expect(check.checks).toMatch(/Not checked:[^.]*lint/);
    // And the ones that are meaningless for a heal rather than merely missing.
    expect(check.checks).toMatch(/Not checked:[^.]*plan fidelity/);
    expect(check.checks).toMatch(/Not checked:[^.]*file path/);
  });

  it('does not pad the flags with the gates that can never run here', async () => {
    /*
     * `admit` puts every UNAVAILABLE into `reviewFlags`, which is right for the
     * Generator and wrong here: six permanent flags on every heal ever proposed
     * is a flag nobody reads, the exact failure `admission.ts` warns about for
     * the mutation gate. They belong in `checks`, which is what a human reads
     * when asking what was skipped — not in the list of things wrong with THIS
     * patch.
     */
    const check = await healAndCheck(JS_TEST, JS_FIXES_THE_SELECTOR, 'tests/checkout.spec.ts');

    expect(check.flags).toEqual([]);
    // The report underneath still carries every one of them, unredacted.
    expect(check.report.reviewFlags.length).toBeGreaterThan(0);
    expect(check.report.gates.map((g) => g.gate)).toContain('MUTATION');
  });

  it('never asks a model to revise, because a heal has nothing to revise with', async () => {
    /*
     * The Healer produced a DIFF, not a file, so there is nothing to hand a
     * `revisePrompt` to and no second attempt to make. Asking `admit` for the
     * terminal attempt keeps the verdict from ever being REVISE, which would be
     * a verdict this path cannot act on.
     */
    const check = await healAndCheck(CLEAN_SPEC, ADDS_A_FIXED_SLEEP, 'tests/checkout.spec.ts');

    expect(check.report.verdict).not.toBe('REVISE');
    expect(check.report.revisePrompt).toBeNull();
  });
});

describe('the partial toolchain', () => {
  it('runs the parse in process for JavaScript and TypeScript, and only those', () => {
    for (const path of ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs']) {
      expect(syntaxIsReachableWithoutACheckout(path), path).toBe(true);
    }
    // Each of these needs a compiler run from the customer's checkout.
    for (const path of ['a_test.go', 'test_a.py', 'a_spec.rb', 'A.java', 'a.bats', 'a']) {
      expect(syntaxIsReachableWithoutACheckout(path), path).toBe(false);
    }
  });

  it('reports the three checkout gates as unavailable rather than passed', async () => {
    /*
     * The temptation is to let a gate with nothing to run return PASS, and that
     * is how "applied" comes to silently mean "unchecked". Each of these says
     * what it could not do and why.
     */
    const gates = postCheckToolchain();
    const input = { code: CLEAN_SPEC, filePath: 'tests/checkout.spec.ts' };

    expect((await gates.typecheck(input)).status).toBe('UNAVAILABLE');
    expect((await gates.typecheck(input)).why).toMatch(/tsconfig and node_modules/);
    expect((await gates.format(input)).status).toBe('UNAVAILABLE');
    expect((await gates.lint(input)).status).toBe('UNAVAILABLE');
    expect((await gates.lint(input)).why).toMatch(/eslint config/);

    // …and the one that does work, works.
    expect((await gates.syntax(input)).status).toBe('PASS');
    expect((await gates.syntax({ ...input, code: '}{' })).status).toBe('FAIL');
  });

  it('spawns nothing for a language whose parser lives in the customer repo', async () => {
    /*
     * `toolchainFor().syntax` resolves a real parser binary for Python, Ruby,
     * PHP and Go out of the repository or PATH, and the heals LIST endpoint
     * computes a preview per row — so delegating blindly would spawn `python3`
     * fifty times to answer one page. It is refused before it gets there, with
     * the file type named.
     */
    const outcome = await postCheckToolchain().syntax({
      code: 'def test_x():\n    assert 1 == 1\n',
      filePath: 'tests/test_checkout.py',
    });

    expect(outcome.status).toBe('UNAVAILABLE');
    expect(outcome.why).toMatch(/\.py/);
    expect(outcome.why).toMatch(/does not have/);
  });
});
