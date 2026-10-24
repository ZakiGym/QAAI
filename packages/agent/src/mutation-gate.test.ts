/**
 * Tests for the mutation admission gate.
 *
 * Four things here are worth more than the rest of the file:
 *
 *  1. **UNAVAILABLE is never PASS.** Every "we could not check this" path is
 *     asserted to be UNAVAILABLE *and* asserted not to be PASS, explicitly and
 *     separately. A regression that turns one of them into a pass would hand a
 *     never-checked test the same certificate as a verified one, which is the
 *     only way this module can do active harm.
 *
 *  2. **The early stop really stops.** The caps are asserted by counting the
 *     trials the fake capability saw. A cap that is documented and not enforced
 *     is worse than no cap, because the cost is invisible until the bill.
 *
 *  3. **The survivor text is the product.** A FAIL must name each change the
 *     test failed to notice in words a developer can act on, so the assertions
 *     check the sentences, not just the status.
 *
 *  4. **The polarity experiment.** `mutation-gate.polarity.md` does not exist;
 *     the experiment is run by hand (documented in the task report): invert the
 *     KILLED/SURVIVED interpretation in `mutationGate` and these tests go red.
 *     If they did not, the gate would be theatre — a thing that reports a
 *     verdict unconnected to what the trials said.
 */

import { describe, expect, it } from 'vitest';
import {
  DECISIVE_OPERATORS,
  MUTATION_GATE_MAX_INCONCLUSIVE,
  MUTATION_GATE_MAX_TRIALS,
  MUTATION_GATE_SETTLE_KILLS,
  MUTATION_GATE_SETTLE_SURVIVORS,
  extractClaims,
  isDecisive,
  isSupportedSource,
  maskNonCode,
  mutationGate,
  orderTrials,
  proposeMutants,
} from './mutation-gate.js';
import type {
  GateOutcome,
  Mutant,
  MutantTrial,
  MutationCapability,
  MutationGateInput,
  MutationOperator,
} from './mutation-gate.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** The source under test: a guard, a boundary, a computation and a validation. */
const CART_SOURCE = `export function applyDiscount(total: number, code: string): number {
  // A comment with a > in it, which must never be mutated.
  const label = 'total >= limit';
  if (code === 'SAVE10') {
    return total - 10;
  }
  if (total > 100) {
    throw new Error('Order total is too large');
  }
  return total;
}
`;

/** A generated test that really does assert the behaviour above. */
const CART_TEST = `import { expect, test } from '@playwright/test';

test('shows the discounted total for SAVE10', async ({ page }) => {
  await page.goto('/cart');
  await page.getByLabel('Discount code').fill('SAVE10');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('total')).toHaveText('90');
  await expect(page.getByText('Order total is too large')).toHaveCount(0);
});
`;

const CART = { filePath: 'src/cart.ts', code: CART_SOURCE };

function baseInput(over: Partial<MutationGateInput> = {}): MutationGateInput {
  return {
    test: {
      name: 'shows the discounted total for SAVE10',
      filePath: 'e2e/cart.spec.ts',
      code: CART_TEST,
    },
    sources: [CART],
    baseline: 'PASSING',
    ...over,
  };
}

/**
 * A fake capability. `script` answers trial N; anything past the end repeats the
 * last entry, so a test that does not care about length does not have to count.
 */
function fake(script: Array<MutantTrial['outcome'] | 'THROW'>): {
  capability: MutationCapability;
  seen: Array<{ mutant: Mutant; filePath: string; code: string }>;
} {
  const seen: Array<{ mutant: Mutant; filePath: string; code: string }> = [];
  const capability: MutationCapability = {
    async trial({ mutant, code, filePath }) {
      seen.push({ mutant, code, filePath });
      const step = script[Math.min(seen.length - 1, script.length - 1)] ?? 'SURVIVED';
      if (step === 'THROW') throw new Error('the worker lost the browser');
      if (step === 'INCONCLUSIVE') return { outcome: 'INCONCLUSIVE', why: 'the trial timed out' };
      return { outcome: step };
    },
  };
  return { capability, seen };
}

let nextId = 0;

/** An explicit mutant, for tests that need to control the plan exactly. */
function mutant(operator: MutationOperator, line: number, score = 9): Mutant {
  nextId += 1;
  return {
    id: `${operator}#${nextId}`,
    operator,
    filePath: 'src/cart.ts',
    line,
    start: line * 10,
    end: line * 10 + 3,
    original: 'xxx',
    replacement: 'yyy',
    describes: `the ${operator} change at line ${line} is applied`,
    wouldBeCaughtBy: 'an assertion on the behaviour it changes',
    relevance: { score, because: ['the test names `total`'] },
  };
}

function detailText(outcome: GateOutcome): string {
  return outcome.detail.join('\n');
}

// ─── Masking: never mutate what is not code ──────────────────────────────────

describe('maskNonCode', () => {
  it('blanks comments, string bodies and regex bodies while preserving offsets', () => {
    const code = [
      'const re = /a > b/;',
      "const s = 'x >= y';",
      '// a > b in a comment',
      '/* a > b in a block */',
      'if (a > b) return 1;',
    ].join('\n');
    const { masked } = maskNonCode(code);

    expect(masked).toHaveLength(code.length);
    // Exactly one ` > ` survives: the real comparison on the last line.
    expect(masked.match(/\s>\s/g)).toHaveLength(1);
    expect(masked.split('\n')).toHaveLength(code.split('\n').length);
  });

  it('records string literals with the offsets of their quotes', () => {
    const code = "const message = 'Order total is too large';";
    const { strings } = maskNonCode(code);
    expect(strings).toHaveLength(1);
    expect(strings[0]?.value).toBe('Order total is too large');
    expect(code.slice(strings[0]?.start ?? 0, strings[0]?.end ?? 0)).toBe(
      "'Order total is too large'",
    );
  });

  it('does not let an unterminated quote swallow the rest of the file', () => {
    const code = "const broken = 'oops\nif (a > b) return 1;";
    const { masked } = maskNonCode(code);
    expect(masked).toHaveLength(code.length);
    expect(masked.match(/\s>\s/g)).toHaveLength(1);
  });
});

// ─── What the test claims ────────────────────────────────────────────────────

describe('extractClaims', () => {
  const claims = extractClaims({ name: 'shows the discounted total', code: CART_TEST });

  it('treats literals on assertion lines as claims and the rest as context', () => {
    expect(claims.assertedStrings).toContain('Order total is too large');
    expect(claims.assertedStrings).toContain('90');
    // 'SAVE10' is typed into a field, not asserted — it is context, not a claim.
    expect(claims.assertedStrings).not.toContain('SAVE10');
  });

  it('notices a numeric claim, which is what licenses arithmetic mutants', () => {
    expect(claims.assertsNumber).toBe(true);
    expect(
      extractClaims({ code: "test('x', async () => { await page.goto('/a'); });" }).assertsNumber,
    ).toBe(false);
  });
});

// ─── Candidate generation and relevance ──────────────────────────────────────

describe('proposeMutants', () => {
  const claims = extractClaims(baseInput().test);
  const mutants = proposeMutants([CART], claims);

  it('finds the constant the assertion depends on and ranks it first', () => {
    expect(mutants[0]?.operator).toBe('CHANGE_CONSTANT');
    expect(mutants[0]?.original).toBe("'Order total is too large'");
    expect(mutants[0]?.relevance.because.join(' ')).toContain('assertion depends on this constant');
  });

  it('never mutates a comment or a string body', () => {
    // `'total >= limit'` is a label and `// a > b` is prose. Mutating either
    // produces a survivor that proves nothing about any test.
    for (const m of mutants) {
      expect(m.original).not.toBe('>=');
      expect(CART_SOURCE.slice(0, m.start).split('\n').pop()?.trimStart().startsWith('//')).toBe(
        false,
      );
    }
  });

  it('covers the guard, the boundary and the validation', () => {
    const operators = new Set(mutants.map((m) => m.operator));
    expect(operators).toContain('NEGATE_CONDITIONAL');
    expect(operators).toContain('INVERT_EQUALITY');
    expect(operators).toContain('SWAP_BOUNDARY');
    expect(operators).toContain('REMOVE_VALIDATION');
  });

  it('withholds arithmetic mutants from a test that asserts no number', () => {
    const noNumber = extractClaims({
      name: 'opens the cart',
      code: "test('opens the cart', async ({ page }) => { await page.goto('/cart'); await expect(page.getByRole('heading')).toBeVisible(); });",
    });
    const operators = new Set(proposeMutants([CART], noNumber).map((m) => m.operator));
    expect(operators).not.toContain('SWAP_ARITHMETIC');
  });

  it('proposes nothing from a file the test has no connection to', () => {
    const unrelated = {
      filePath: 'src/telemetry.ts',
      code: `export function flush(buffer: string[], limit: number): boolean {
  if (buffer.length > limit) {
    return false;
  }
  return true;
}
`,
    };
    expect(proposeMutants([unrelated], claims)).toEqual([]);
  });

  it('refuses a language whose operators are not implemented', () => {
    expect(isSupportedSource('src/cart.py')).toBe(false);
    expect(proposeMutants([{ filePath: 'src/cart.py', code: CART_SOURCE }], claims)).toEqual([]);
  });
});

describe('orderTrials', () => {
  it('spends the budget on different lines and different operators', () => {
    const plan = orderTrials(
      [
        mutant('NEGATE_CONDITIONAL', 4),
        mutant('NEGATE_CONDITIONAL', 4),
        mutant('NEGATE_CONDITIONAL', 7),
        mutant('NEGATE_CONDITIONAL', 9),
        mutant('INVERT_EQUALITY', 11),
      ],
      5,
    );
    expect(plan).toHaveLength(4);
    expect(new Set(plan.map((m) => m.line)).size).toBe(4);
    expect(plan.filter((m) => m.operator === 'NEGATE_CONDITIONAL')).toHaveLength(3);
  });

  it('never exceeds the budget', () => {
    const many = Array.from({ length: 20 }, (_, i) => mutant('INVERT_EQUALITY', i + 1));
    expect(orderTrials(many, 2)).toHaveLength(2);
  });
});

describe('isDecisive', () => {
  it('separates a missing assertion from a missing edge case', () => {
    expect(DECISIVE_OPERATORS.every((op) => isDecisive(op))).toBe(true);
    expect(isDecisive('SWAP_BOUNDARY')).toBe(false);
    expect(isDecisive('SWAP_ARITHMETIC')).toBe(false);
  });
});

// ─── The verdicts ────────────────────────────────────────────────────────────

describe('mutationGate', () => {
  it('admits a test that kills what it is given, and stops once that is settled', async () => {
    const { capability, seen } = fake(['KILLED']);
    const outcome = await mutationGate(baseInput({ capability }));

    expect(outcome.status).toBe('PASS');
    expect(outcome.why).toContain('fails when the behaviour it asserts is broken');
    // The early stop: two kills settle it, and the budget is not burnt.
    expect(seen).toHaveLength(MUTATION_GATE_SETTLE_KILLS);
    expect(detailText(outcome)).toContain('stopped after 2 kills');
    expect(detailText(outcome)).toMatch(/killed src\/cart\.ts:\d+/);
    // The capability is handed the source it is supposed to mutate, not a guess.
    expect(seen[0]?.filePath).toBe('src/cart.ts');
    expect(seen[0]?.code).toBe(CART_SOURCE);
  });

  it('refuses a test that notices nothing, and names every change it missed', async () => {
    const { capability, seen } = fake(['SURVIVED']);
    const outcome = await mutationGate(
      baseInput({
        capability,
        mutants: [
          mutant('CHANGE_CONSTANT', 8),
          mutant('NEGATE_CONDITIONAL', 4),
          mutant('INVERT_EQUALITY', 11),
          mutant('REMOVE_VALIDATION', 14),
          mutant('FLIP_BOOLEAN', 17),
        ],
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.why).toContain('every change made to the behaviour this test claims to check');
    // One actionable line per survivor, each naming the change AND the fix.
    for (const entry of seen) {
      expect(detailText(outcome)).toContain(entry.mutant.describes);
    }
    expect(detailText(outcome)).toContain('Add: an assertion on the behaviour it changes.');
    // The early stop: three unnoticed decisive changes settle it.
    expect(seen).toHaveLength(MUTATION_GATE_SETTLE_SURVIVORS);
    expect(detailText(outcome)).toContain('unnoticed changes with no kill');
    expect(detailText(outcome)).toContain('not run (trial cap');
  });

  it('passes at exactly the stated ratio and not below it', async () => {
    const plan = [
      mutant('NEGATE_CONDITIONAL', 4),
      mutant('INVERT_EQUALITY', 7),
      mutant('CHANGE_CONSTANT', 11),
      mutant('REMOVE_VALIDATION', 14),
    ];

    // 2 of 4 killed — exactly MUTATION_GATE_PASS_RATIO.
    const atBar = fake(['SURVIVED', 'SURVIVED', 'KILLED', 'KILLED']);
    const pass = await mutationGate(baseInput({ capability: atBar.capability, mutants: plan }));
    expect(atBar.seen).toHaveLength(4);
    expect(pass.status).toBe('PASS');
    expect(pass.why).toContain('killed 2 of 4');
    // A PASS still lists the holes. A gate that hides them teaches the number.
    expect(detailText(pass)).toContain('the test still passes when');

    // 1 of 4 killed — under the bar, but it is not a test that asserts nothing.
    const underBar = fake(['SURVIVED', 'SURVIVED', 'KILLED', 'SURVIVED']);
    const warn = await mutationGate(baseInput({ capability: underBar.capability, mutants: plan }));
    expect(warn.status).toBe('WARN');
    expect(warn.why).toContain('it does fail when something real breaks');
  });

  it('warns rather than accusing when every survivor is only a missing edge case', async () => {
    const { capability } = fake(['SURVIVED']);
    const outcome = await mutationGate(
      baseInput({
        capability,
        mutants: [mutant('SWAP_BOUNDARY', 7), mutant('SWAP_ARITHMETIC', 5)],
      }),
    );

    expect(outcome.status).toBe('WARN');
    expect(outcome.status).not.toBe('FAIL');
    expect(outcome.why).toContain('boundary cases the test never exercises');
  });

  it('points at the assertion in the test that should have caught the survivor', async () => {
    const { capability } = fake(['SURVIVED', 'KILLED']);
    const outcome = await mutationGate(baseInput({ capability }));
    // Line 8 of CART_TEST is the `Order total is too large` assertion — the one
    // that should have noticed the constant changing.
    expect(outcome.line).toBe(8);
    expect(CART_TEST.split('\n')[(outcome.line ?? 1) - 1]).toContain('Order total is too large');
  });

  // ─── UNAVAILABLE, which is never a pass ────────────────────────────────────

  async function expectUnavailable(input: MutationGateInput, why: RegExp): Promise<GateOutcome> {
    const outcome = await mutationGate(input);
    expect(outcome.status).toBe('UNAVAILABLE');
    // Asserted separately and deliberately: the defect this gate could cause is
    // an unchecked test looking like a checked one.
    expect(outcome.status).not.toBe('PASS');
    expect(outcome.status).not.toBe('WARN');
    expect(outcome.why).toMatch(why);
    return outcome;
  }

  it('is UNAVAILABLE, not PASS, with no capability injected', async () => {
    const outcome = await expectUnavailable(
      baseInput({ capability: null }),
      /no mutation capability/,
    );
    expect(detailText(outcome)).toContain('This is not a pass');
  });

  it('is UNAVAILABLE when no source under test was identified', async () => {
    await expectUnavailable(
      baseInput({ capability: fake(['KILLED']).capability, sources: [] }),
      /no source file/,
    );
  });

  it('is UNAVAILABLE for a language whose operators are not implemented', async () => {
    const { capability, seen } = fake(['KILLED']);
    await expectUnavailable(
      baseInput({ capability, sources: [{ filePath: 'src/cart.py', code: CART_SOURCE }] }),
      /not implemented for \.py/,
    );
    expect(seen).toHaveLength(0);
  });

  it('is UNAVAILABLE when the test was not shown to pass unmutated', async () => {
    const failing = fake(['KILLED']);
    await expectUnavailable(
      baseInput({ capability: failing.capability, baseline: 'FAILING' }),
      /does not pass against unmutated source/,
    );
    // Nothing was run: every mutant would have "killed" an already-red test.
    expect(failing.seen).toHaveLength(0);

    const unknown = fake(['KILLED']);
    await expectUnavailable(
      baseInput({ capability: unknown.capability, baseline: null }),
      /not verified to pass against unmutated source/,
    );
    expect(unknown.seen).toHaveLength(0);
  });

  it('is UNAVAILABLE when nothing relevant to the test could be mutated', async () => {
    const { capability, seen } = fake(['KILLED']);
    await expectUnavailable(
      baseInput({
        capability,
        sources: [
          {
            filePath: 'src/telemetry.ts',
            code: 'export const flush = (n: number): boolean => {\n  if (n > 10) {\n    return false;\n  }\n  return true;\n};\n',
          },
        ],
      }),
      /no mutation relevant to what this test asserts/,
    );
    expect(seen).toHaveLength(0);
  });

  it('is UNAVAILABLE when every trial throws, and stops throwing good money after bad', async () => {
    const { capability, seen } = fake(['THROW']);
    const outcome = await expectUnavailable(
      baseInput({ capability }),
      /no trial reached a verdict/,
    );

    expect(seen).toHaveLength(MUTATION_GATE_MAX_INCONCLUSIVE);
    expect(detailText(outcome)).toContain('the worker lost the browser');
  });

  it('is UNAVAILABLE when every trial times out', async () => {
    const { capability } = fake(['INCONCLUSIVE']);
    const outcome = await expectUnavailable(
      baseInput({ capability }),
      /no trial reached a verdict/,
    );
    expect(detailText(outcome)).toContain('the trial timed out');
  });

  it('still judges on the conclusive trials when only some produced no verdict', async () => {
    const { capability, seen } = fake(['INCONCLUSIVE', 'KILLED', 'KILLED']);
    const outcome = await mutationGate(baseInput({ capability }));

    expect(outcome.status).toBe('PASS');
    expect(outcome.why).toContain('killed 2 of 2');
    // The trial that answered nothing is still reported; it is not a pass and
    // not a failure, and hiding it would overstate what was checked.
    expect(detailText(outcome)).toContain('no verdict at');
    expect(seen).toHaveLength(3);
  });

  it('never runs more trials than the cap, however many candidates exist', async () => {
    const { capability, seen } = fake([
      'SURVIVED',
      'KILLED',
      'SURVIVED',
      'SURVIVED',
      'SURVIVED',
      'SURVIVED',
    ]);
    const outcome = await mutationGate(
      baseInput({
        capability,
        mutants: Array.from({ length: 30 }, (_, i) =>
          mutant(i % 2 === 0 ? 'SWAP_BOUNDARY' : 'FLIP_LOGICAL', i + 1),
        ),
      }),
    );

    expect(seen.length).toBeLessThanOrEqual(MUTATION_GATE_MAX_TRIALS);
    expect(detailText(outcome)).toMatch(/further relevant mutations were found and not tried/);
  });

  it('honours a lower trial budget from the caller', async () => {
    const { capability, seen } = fake(['SURVIVED']);
    await mutationGate(baseInput({ capability, maxTrials: 1 }));
    expect(seen).toHaveLength(1);
  });
});
