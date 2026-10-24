/**
 * The generation gate, WIRED. What this file is actually for.
 *
 * `admission.ts` was landed with 200 tests over its verdict table and was
 * called by nothing: correct code connected to nothing, which is this
 * codebase's signature defect. So these tests are not about the gates — they
 * are about the WIRING, and every one of them is written so that unwiring the
 * thing it covers turns it red:
 *
 *   • admission runs at all, and the code/path/flags that come back are the
 *     report's rather than the model's;
 *   • a REVISE costs exactly one more model call, and that call carries
 *     `report.revisePrompt` VERBATIM (paraphrase it and the model gets a
 *     summary instead of instructions quoting its own lines);
 *   • a second failure REFUSES, by throwing, so no caller can store it;
 *   • a duplicate refuses on the FIRST attempt — re-prompting cannot fix "you
 *     already have this test", and a retry would be money for nothing;
 *   • every gate that could not run reaches `reviewFlags`, so "admitted" never
 *     silently means "unchecked" — EXCEPT MUTATION, whose UNAVAILABLE is
 *     deliberately not flagged because it can never run in this configuration
 *     and a flag on every test is a flag nobody reads;
 *   • the three post-checks this wiring deleted (`@qaai/` imports, fixed
 *     sleeps, the path convention) still reach the human, now from the gate
 *     named after each one.
 *
 * There is no ANTHROPIC_API_KEY here and there must never need to be: the model
 * is a fake that returns a canned file and records the prompt it was given,
 * which is also the only way to assert what the second call was told.
 */

import { describe, expect, it } from 'vitest';
import type { FlowMap, PlanItem } from '@qaai/shared';
import { GenerationRefused, generateTest } from './generator.js';
import type { GateOutcome, ToolchainGates } from './admission.js';
import { FINAL_ATTEMPT } from './admission.js';
import type { CallContext, LlmService, StructuredOptions } from './llm.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ctx: CallContext = {
  orgId: 'org1',
  projectId: 'proj1',
  agent: 'GENERATOR',
  subjectId: 'item-1',
};

function node(route: string): FlowMap['nodes'][number] {
  return {
    id: `node:${route}`,
    route,
    url: `https://shop.example${route}`,
    title: route,
    stateKey: 'default',
    requiresRoles: [],
    behindAuth: false,
    forms: [],
    affordances: [],
    screenshotKey: null,
    a11yViolationCount: 0,
  };
}

const flowMap: FlowMap = {
  projectId: 'proj1',
  environmentId: 'env1',
  version: 1,
  baseUrl: 'https://shop.example',
  nodes: [node('/'), node('/cart'), node('/checkout')],
  edges: [],
  journeys: [],
  features: [],
  exploredAt: '2026-10-01T00:00:00.000Z',
  truncatedReason: null,
};

/** An approved item whose assertion a correct test can demonstrably trace to. */
const item: PlanItem = {
  id: 'item-1',
  title: 'Checkout shows the order total',
  rationale: 'The survey said the total was wrong at checkout.',
  feature: 'checkout',
  priority: 'IMPORTANT',
  testType: 'E2E',
  steps: ['Open the cart page', 'Press the checkout button'],
  assertions: ['The order total reads $42.00'],
  journeyId: null,
  authProfileId: null,
};

const GOOD_PATH = 'checkout/checkout-shows-the-order-total.spec.ts';

const GOOD_CODE = `import { test, expect } from '@playwright/test';

test('Checkout shows the order total', async ({ page }) => {
  await page.goto('/cart');
  await page.getByRole('button', { name: 'Checkout' }).click();
  await expect(page.getByTestId('order-total')).toHaveText('$42.00');
});
`;

/** The same journey with the assertion removed: reaching a page is not a check. */
const NO_ASSERTION_CODE = `import { test, expect } from '@playwright/test';

test('Checkout shows the order total', async ({ page }) => {
  await page.goto('/cart');
  await page.getByRole('button', { name: 'Checkout' }).click();
  await page.getByTestId('order-total').textContent();
});
`;

interface ModelFile {
  name?: string;
  filePath?: string;
  code: string;
  reviewFlags?: string[];
  spec?: unknown;
}

/**
 * A model that answers with the files it was given, in order, and keeps every
 * prompt. The prompts are the only evidence of what the second call was told.
 */
function fakeLlm(...replies: ModelFile[]): {
  llm: LlmService;
  prompts: string[];
} {
  const prompts: string[] = [];
  const llm = {
    configured: true,
    structured: async (_ctx: CallContext, opts: StructuredOptions<never>) => {
      prompts.push(opts.prompt);
      const reply = replies[Math.min(prompts.length - 1, replies.length - 1)]!;
      return {
        name: reply.name ?? item.title,
        filePath: reply.filePath ?? GOOD_PATH,
        code: reply.code,
        reviewFlags: reply.reviewFlags ?? [],
        ...(reply.spec === undefined ? {} : { spec: reply.spec }),
      };
    },
  } as unknown as LlmService;
  return { llm, prompts };
}

function args(over: Partial<Parameters<typeof generateTest>[2]> = {}) {
  return {
    item,
    flowMap,
    language: 'TYPESCRIPT' as const,
    framework: 'PLAYWRIGHT' as const,
    ...over,
  };
}

/** A toolchain stand-in: the four gates `toolchainFor` would supply from a repo. */
function toolchain(over: {
  format?: string;
  syntax?: GateOutcome['status'];
}): ToolchainGates {
  const outcome = (gate: GateOutcome['gate'], status: GateOutcome['status']): GateOutcome => ({
    gate,
    status,
    why: `${gate} ran in the test toolchain`,
    detail: [],
    line: null,
  });
  return {
    syntax: async () => outcome('SYNTAX', over.syntax ?? 'PASS'),
    typecheck: async () => outcome('TYPECHECK', 'PASS'),
    format: async ({ code }) => ({
      ...outcome('FORMAT', 'PASS'),
      code: over.format ?? code,
    }),
    lint: async () => outcome('LINT', 'PASS'),
  };
}

const flagsAbout = (flags: string[], needle: RegExp): string[] =>
  flags.filter((flag) => needle.test(flag));

// ─── 1. A clean test is admitted unchanged ───────────────────────────────────

describe('generateTest runs the generation gate', () => {
  it('admits a clean test unchanged, after exactly one model call', async () => {
    const { llm, prompts } = fakeLlm({ code: GOOD_CODE });

    const generated = await generateTest(llm, ctx, args({ existing: [] }));

    expect(prompts).toHaveLength(1);
    expect(generated.attempts).toBe(1);
    expect(generated.code).toBe(GOOD_CODE);
    expect(generated.filePath).toBe(GOOD_PATH);
    expect(generated.admission?.verdict).toBe('ADMIT');
    // The gate ran and the report travels with the test, so a caller can log
    // what was checked rather than guess.
    expect(generated.admission?.gates.map((gate) => gate.gate)).toContain('ASSERTIONS');
    expect(
      generated.admission?.gates.find((gate) => gate.gate === 'ASSERTIONS')?.status,
    ).toBe('PASS');
    expect(generated.admission?.gates.find((gate) => gate.gate === 'FIDELITY')?.status).toBe(
      'PASS',
    );
  });

  it('passes the suite in, so DUPLICATE is answered rather than skipped', async () => {
    const { llm } = fakeLlm({ code: GOOD_CODE });

    const generated = await generateTest(llm, ctx, args({ existing: [] }));

    const duplicate = generated.admission?.gates.find((gate) => gate.gate === 'DUPLICATE');
    expect(duplicate?.status).toBe('PASS');
    // …and nothing about duplication is on the row, because it was checked.
    expect(flagsAbout(generated.reviewFlags, /already has this test/)).toHaveLength(0);
  });

  it('keeps the model\'s own review flags alongside the gate\'s', async () => {
    const { llm } = fakeLlm({
      code: GOOD_CODE,
      reviewFlags: ['The order total locator was inferred; the crawl never saw it.'],
    });

    const generated = await generateTest(llm, ctx, args({ existing: [] }));

    expect(generated.reviewFlags[0]).toContain('locator was inferred');
    expect(generated.reviewFlags.length).toBeGreaterThan(1);
  });
});

// ─── 2. The retry, and what it is told ───────────────────────────────────────

describe('a revisable failure costs exactly one more call', () => {
  it('re-prompts once with the revise prompt verbatim, and admits the fix', async () => {
    const { llm, prompts } = fakeLlm({ code: NO_ASSERTION_CODE }, { code: GOOD_CODE });

    const generated = await generateTest(llm, ctx, args({ existing: [] }));

    expect(prompts).toHaveLength(2);
    expect(generated.attempts).toBe(FINAL_ATTEMPT);
    expect(generated.code).toBe(GOOD_CODE);
    expect(generated.admission?.verdict).toBe('ADMIT');

    /*
     * The second prompt is the thing being proven. It must carry the gate's own
     * instructions — which quote the offending lines and name the dialect's
     * assertion form — and the file being repaired, because `llm.structured`
     * is single-shot and "return the COMPLETE file again" otherwise has
     * nothing to return.
     */
    const second = prompts[1]!;
    expect(second).toContain('The test you produced was not accepted.');
    expect(second).toContain('Add assertions that prove the behaviour under test actually happened');
    expect(second).toContain('Implement the approved assertions listed below');
    expect(second).toContain('The order total reads $42.00');
    expect(second).toContain(NO_ASSERTION_CODE);
    // And it is still the original brief, not a bare repair order.
    expect(second).toContain('TEST PLAN ITEM');
  });

  it('refuses when the second attempt fails the same way, and stores nothing', async () => {
    const { llm, prompts } = fakeLlm({ code: NO_ASSERTION_CODE });

    const refusal = await generateTest(llm, ctx, args({ existing: [] })).then(
      () => null,
      (err: unknown) => err,
    );

    expect(refusal).toBeInstanceOf(GenerationRefused);
    const thrown = refusal as GenerationRefused;
    // One retry, not a loop: two calls, never three.
    expect(prompts).toHaveLength(2);
    expect(thrown.attempts).toBe(FINAL_ATTEMPT);
    expect(thrown.report.verdict).toBe('REFUSE');
    expect(thrown.failedGates).toContain('ASSERTIONS');
    expect(thrown.planItemId).toBe('item-1');
    expect(thrown.planItemTitle).toBe('Checkout shows the order total');
    // The message is what the repro route shows a human and what the worker
    // writes into the audit row, so it has to say what happened in one read.
    expect(thrown.message).toContain('Checkout shows the order total');
    expect(thrown.message).toContain('makes no assertion anywhere');
  });

  it('is a throw, not a union, so nothing can store a refused test by accident', async () => {
    const { llm } = fakeLlm({ code: NO_ASSERTION_CODE });
    await expect(generateTest(llm, ctx, args({ existing: [] }))).rejects.toThrow(
      GenerationRefused,
    );
  });
});

// ─── 3. A duplicate is refused without a retry ───────────────────────────────

describe('the DUPLICATE gate', () => {
  it('refuses a test the suite already has, on the first attempt', async () => {
    const { llm, prompts } = fakeLlm({ code: GOOD_CODE });

    const refusal = await generateTest(
      llm,
      ctx,
      args({
        existing: [
          {
            id: 'test-1',
            name: 'Checkout shows the order total',
            filePath: GOOD_PATH,
            code: GOOD_CODE,
            type: 'E2E',
          },
        ],
      }),
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(refusal).toBeInstanceOf(GenerationRefused);
    const thrown = refusal as GenerationRefused;
    expect(thrown.failedGates).toContain('DUPLICATE');
    // Re-prompting cannot fix "you already have this test", so it does not pay
    // for a second strong-tier call to find that out.
    expect(prompts).toHaveLength(1);
    expect(thrown.attempts).toBe(1);
    expect(thrown.message).toContain('The suite already has this test');
  });

  it('admits a test that overlaps an existing one but checks something new', async () => {
    const other = GOOD_CODE.replace(
      "await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
      "await expect(page.getByTestId('delivery-date')).toHaveText('Tomorrow');",
    );
    const { llm } = fakeLlm({ code: GOOD_CODE });

    const generated = await generateTest(
      llm,
      ctx,
      args({
        existing: [
          {
            id: 'test-1',
            name: 'Checkout shows the delivery date',
            filePath: 'checkout/checkout-shows-the-delivery-date.spec.ts',
            code: other,
            type: 'E2E',
          },
        ],
      }),
    );

    expect(generated.admission?.verdict).not.toBe('REFUSE');
    expect(generated.code).toBe(GOOD_CODE);
  });
});

// ─── 4. What the report, not the model, decides ──────────────────────────────

describe('the admitted test is the report\'s, not the model\'s', () => {
  it('stores the FORMATTED code when a formatter ran', async () => {
    const formatted = GOOD_CODE.replace(/'/g, '"');
    const { llm } = fakeLlm({ code: GOOD_CODE });

    const generated = await generateTest(
      llm,
      ctx,
      args({ existing: [], toolchain: toolchain({ format: formatted }) }),
    );

    expect(generated.code).toBe(formatted);
    expect(generated.code).not.toBe(GOOD_CODE);
    // A formatter that ran is a gate that ran: no "not formatted" flag.
    expect(flagsAbout(generated.reviewFlags, /no formatter was wired in/)).toHaveLength(0);
  });

  it('stores the CORRECTED path when the runner would not collect the model\'s', async () => {
    const { llm } = fakeLlm({ code: GOOD_CODE, filePath: 'checkout/total.txt' });

    const generated = await generateTest(llm, ctx, args({ existing: [] }));

    expect(generated.filePath).toBe(GOOD_PATH);
    expect(generated.admission?.correctedFilePath).toBe(GOOD_PATH);
    // The old hand-rolled check said this out loud; the gate still does.
    expect(flagsAbout(generated.reviewFlags, /checkout\/total\.txt/)).not.toHaveLength(0);
    expect(generated.reviewFlags.join(' ')).toContain('would never have run');
  });
});

// ─── 5. Unchecked is never silently admitted ─────────────────────────────────

describe('gates that could not run', () => {
  it('puts every unavailable gate on the row — except MUTATION', async () => {
    const { llm } = fakeLlm({ code: GOOD_CODE });

    const generated = await generateTest(llm, ctx, args({ existing: [] }));

    const unavailable = (generated.admission?.gates ?? [])
      .filter((gate) => gate.status === 'UNAVAILABLE')
      .map((gate) => gate.gate);
    // No toolchain is wired into generation, and no mutation gate can be.
    expect(unavailable.sort()).toEqual(
      ['FORMAT', 'LINT', 'MUTATION', 'SYNTAX', 'TYPECHECK'].sort(),
    );

    const flags = generated.reviewFlags.join('\n');
    expect(flags).toContain('no syntax checker was wired in');
    expect(flags).toContain('no typechecker was wired in');
    expect(flags).toContain('no formatter was wired in');
    expect(flags).toContain('no linter was wired in');

    /*
     * The deliberate asymmetry, and it is deliberate: a gate that can NEVER run
     * in this configuration would flag every test ever generated, so MUTATION's
     * UNAVAILABLE is reported in the gates and kept off the row.
     * `admission.test.ts` owns this rule; this test is here so the wiring
     * cannot quietly start copying that flag onto every row.
     */
    expect(flagsAbout(generated.reviewFlags, /mutated build/)).toHaveLength(0);
    expect(flagsAbout(generated.reviewFlags, /behaviour it covers broke/)).toHaveLength(0);
  });

  it('says so when no suite was supplied to compare against', async () => {
    const { llm } = fakeLlm({ code: GOOD_CODE });

    // `existing` omitted entirely: the repro route generates this way.
    const generated = await generateTest(llm, ctx, args());

    expect(generated.admission?.gates.find((gate) => gate.gate === 'DUPLICATE')?.status).toBe(
      'UNAVAILABLE',
    );
    expect(generated.reviewFlags.join(' ')).toContain('no existing tests were supplied');
  });
});

// ─── 6. The three deleted post-checks still reach a human ────────────────────

describe('the post-checks this wiring collapsed', () => {
  it('still reports a fixed sleep, from the gate named after it', async () => {
    const slept = GOOD_CODE.replace(
      "await page.getByRole('button', { name: 'Checkout' }).click();",
      "await page.waitForTimeout(3000);\n  await page.getByRole('button', { name: 'Checkout' }).click();",
    );
    const { llm, prompts } = fakeLlm({ code: slept });

    const generated = await generateTest(llm, ctx, args({ existing: [] }));

    // A WARN, exactly as the old check was: a flake source in a test that is
    // otherwise about the right thing is worth an eye, not a refusal.
    expect(prompts).toHaveLength(1);
    expect(generated.admission?.verdict).toBe('ADMIT_WITH_FLAGS');
    expect(generated.reviewFlags.join(' ')).toContain('sleeps for a fixed duration');
  });

  it('still reports an @qaai import — now by sending it back once first', async () => {
    const locked = `import { login } from '@qaai/helpers';\n${GOOD_CODE}`;
    const { llm, prompts } = fakeLlm({ code: locked });

    const generated = await generateTest(llm, ctx, args({ existing: [] }));

    /*
     * The old code flagged this and stored it. The gate puts it in the SOFT
     * class: one re-prompt (it is a single import line, the most mechanically
     * fixable failure there is), and then admitted with a loud flag, because a
     * refused test covers nothing at all. Both calls here return the same
     * locked-in file, so this is the worst case.
     */
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Remove every reference to QAAI from this file');
    expect(generated.admission?.verdict).toBe('ADMIT_WITH_FLAGS');
    const flag = generated.reviewFlags.find((f) => /cannot run in the customer/.test(f));
    expect(flag).toBeDefined();
    expect(flag).toContain('Admitted despite failing a check');
  });

  it('still reports a brittle locator rather than refusing the test', async () => {
    const brittle = GOOD_CODE.replace(
      "page.getByTestId('order-total')",
      "page.locator('div.sc-x7f2 > span:nth-child(3)')",
    );
    const { llm } = fakeLlm({ code: brittle }, { code: brittle });

    const generated = await generateTest(llm, ctx, args({ existing: [] }));

    expect(generated.admission?.verdict).toBe('ADMIT_WITH_FLAGS');
    expect(generated.reviewFlags.join(' ')).toContain(
      'coupled to things that are not the behaviour',
    );
    // The locator itself is named in the gate's evidence, which the worker logs
    // and the audit row keeps — a flag a human cannot act on is half a flag.
    const locators = generated.admission?.gates.find((gate) => gate.gate === 'LOCATORS');
    expect(locators?.detail.join(' ')).toContain('div.sc-x7f2 > span:nth-child(3)');
    expect(locators?.detail.join(' ')).toContain('generated at build time');
  });
});
