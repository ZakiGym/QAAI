/**
 * Determinism kit tests.
 *
 * The claim this feature makes is narrow and falsifiable: "your suite fails in
 * THIS order, here is the seed". So the suite is built around proving exactly
 * that, end to end, with a real order-dependent pair of tests and the real
 * Playwright runner — a shuffle demonstrated only through unit tests would tell
 * us the permutation is correct while saying nothing about whether a customer
 * can actually reproduce the red run.
 *
 * The rest guards the two ways this feature could do harm:
 *   - mangling a spec it did not fully understand (so the scanner is tested on
 *     the things that hide a brace: strings, comments, regexes, templates), and
 *   - turning itself on when nobody asked (so "off" is asserted to be byte-for-
 *     byte the behaviour that shipped before this file existed).
 */

import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { ExecutableTest, RunContext, TestExecution } from '@qaai/shared';
import {
  SEED_ENV,
  buildInitScript,
  determinismRecord,
  findTestBlocks,
  mulberry32,
  normalizeSeed,
  planDeterminism,
  renderDeterminismHeader,
  reproduceHint,
  resolveDeterminism,
  seededShuffle,
  shuffleSpecOrder,
  usesBrowserFixtures,
  type DeterminismOptions,
} from './determinism.js';
import { runPlaywrightSpec } from './playwright-harness.js';

/** With two blocks a Fisher–Yates draw either swaps or does not; these pick. */
const SEED_THAT_REVERSES_A_PAIR = 7;
const SEED_THAT_KEEPS_A_PAIR = 1;

const RUN = { freezeClockAt: null, randomSeed: 1234 } as const;

function resolve(options?: DeterminismOptions, env: NodeJS.ProcessEnv = {}) {
  return resolveDeterminism(RUN, options, env);
}

// ─── Seeded randomness ───────────────────────────────────────────────────────

describe('seeded randomness', () => {
  it('produces the same stream for the same seed and a different one otherwise', () => {
    const a = Array.from({ length: 5 }, mulberry32(42));
    const b = Array.from({ length: 5 }, mulberry32(42));
    const c = Array.from({ length: 5 }, mulberry32(43));

    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('shuffles to the same permutation for the same seed, and permutes nothing away', () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7];
    expect(seededShuffle(items, 99)).toEqual(seededShuffle(items, 99));
    expect(seededShuffle(items, 99).slice().sort((x, y) => x - y)).toEqual(items);
    // The input array is the caller's; a shuffle that mutated it would silently
    // change the "declared order" we are about to record as the baseline.
    const original = items.slice();
    seededShuffle(items, 99);
    expect(items).toEqual(original);
  });

  it('normalises whatever arrives as a seed into a usable uint32', () => {
    expect(normalizeSeed('7')).toBe(7);
    expect(normalizeSeed(-7)).toBe(7);
    expect(normalizeSeed(7.9)).toBe(7);
    expect(normalizeSeed('nope')).toBeNull();
    expect(normalizeSeed(undefined)).toBeNull();
    // Zero is a legal uint32 but a useless seed; it must not silently produce a
    // constant stream that looks like "randomness is off".
    expect(normalizeSeed(0)).not.toBe(0);
  });
});

// ─── Resolution ──────────────────────────────────────────────────────────────

describe('resolveDeterminism', () => {
  it('is entirely off when nothing was asked for', () => {
    const d = resolve();
    expect(d.enabled).toBe(false);
    expect(d.shuffleOrder).toBe(false);
    expect(d.seedRandom).toBe(false);
    expect(d.clockMode).toBe('off');
    expect(d.timezoneId).toBeNull();
    expect(d.locale).toBeNull();
    expect(d.warnings).toEqual([]);
  });

  it('takes the seed from the run, then options, then the environment', () => {
    expect(resolve().seed).toBe(1234);
    expect(resolve().seedSource).toBe('run');

    expect(resolve({ seed: 55 }).seed).toBe(55);
    expect(resolve({ seed: 55 }).seedSource).toBe('option');

    // The env var wins so a failure can be replayed from outside the code that
    // produced it — that is the entire point of recording it.
    const replayed = resolve({ seed: 55 }, { [SEED_ENV]: '999' });
    expect(replayed.seed).toBe(999);
    expect(replayed.seedSource).toBe('env');
  });

  it('says so when a seed or a clock cannot be read, instead of dropping it', () => {
    const badSeed = resolve({}, { [SEED_ENV]: 'banana' });
    expect(badSeed.seed).toBe(1234);
    expect(badSeed.warnings.join(' ')).toContain('banana');

    const badClock = resolve({ freezeClockAt: 'yesterday' });
    expect(badClock.clockMode).toBe('off');
    expect(badClock.warnings.join(' ')).toContain('yesterday');
  });

  it('freezes rather than composing when both clock modes are set', () => {
    const d = resolve({ freezeClockAt: '2031-03-01T00:00:00.000Z', clockOffsetMs: 5000 });
    expect(d.clockMode).toBe('frozen');
    expect(d.clockAtIso).toBe('2031-03-01T00:00:00.000Z');
    expect(d.clockOffsetMs).toBeNull();
    expect(d.warnings.join(' ')).toContain('freeze took precedence');
  });

  it('inherits the run’s freezeClockAt, and lets an explicit null override it', () => {
    const run = { freezeClockAt: '2030-01-01T00:00:00.000Z', randomSeed: 2 };
    expect(resolveDeterminism(run, undefined, {}).clockMode).toBe('frozen');
    expect(resolveDeterminism(run, { freezeClockAt: null }, {}).clockMode).toBe('off');
  });
});

// ─── Scanning ────────────────────────────────────────────────────────────────

const TRICKY_SPEC = `import { test, expect } from '@playwright/test';

// A comment mentioning test('not a real block', () => {}) to fool a regex.
const label = 'test(also not a block)';
const braceRe = /\\{|\\}/g;
const tpl = \`a \${label.replace(braceRe, '')} b\`;

test.beforeEach(async () => {
  await Promise.resolve();
});

/** Doc comment that belongs to the first test. */
test('first', async () => {
  expect(tpl).toContain('a');
});

test.describe('a suite', () => {
  test('nested one', async () => { expect(1).toBe(1); });
  test('nested two', async () => { expect(2).toBe(2); });
});

test.skip('third', async () => {
  expect(label).toBeTruthy();
});

test.describe.configure({ mode: 'serial' });
`;

describe('findTestBlocks', () => {
  it('finds only the top-level tests, past every construct that hides a brace', () => {
    const { blocks, ok } = findTestBlocks(TRICKY_SPEC);
    expect(ok).toBe(true);
    expect(blocks.map((b) => b.title)).toEqual(['first', 'a suite', 'third']);
    expect(blocks.map((b) => b.callee)).toEqual(['test', 'test.describe', 'test.skip']);
  });

  it('keeps a doc comment attached to the test it documents', () => {
    const first = findTestBlocks(TRICKY_SPEC).blocks[0]!;
    expect(TRICKY_SPEC.slice(first.start, first.end)).toContain('Doc comment that belongs');
  });

  it('does not mistake a hook, a lookalike identifier, or a member call for a test', () => {
    const src = `import { test } from '@playwright/test';
test.beforeAll(async () => {});
test.afterEach(async () => {});
test.use({ locale: 'en-GB' });
const mytest = (n: string) => n;
mytest('nope');
helper.test('also nope');
test('the only one', async () => {});
`;
    expect(findTestBlocks(src).blocks.map((b) => b.title)).toEqual(['the only one']);
  });

  it('refuses to report blocks from a file it could not parse', () => {
    // An unterminated template literal: every offset after it is guesswork.
    const { blocks, ok } = findTestBlocks("const broken = `oops;\ntest('a', () => {});\n");
    expect(ok).toBe(false);
    expect(blocks).toEqual([]);
  });
});

// ─── Reordering ──────────────────────────────────────────────────────────────

describe('shuffleSpecOrder', () => {
  it('reorders the tests and leaves everything between them where it was', () => {
    const result = shuffleSpecOrder(TRICKY_SPEC, SEED_THAT_REVERSES_A_PAIR);
    expect(result.applied).toBe(true);
    expect(result.declaredOrder).toEqual(['first', 'a suite', 'third']);

    // Imports, helpers and hooks must not move: a shuffle that relocated
    // `beforeEach` would change what runs before what, which is a different
    // (and wrong) experiment from changing the order of the tests.
    const before = TRICKY_SPEC.slice(0, TRICKY_SPEC.indexOf('/** Doc comment'));
    expect(result.code.startsWith(before)).toBe(true);
    expect(result.code).toContain("test.describe.configure({ mode: 'serial' });");

    // Every block survives exactly once, whatever the order.
    for (const title of ['first', 'a suite', 'third', 'nested one', 'nested two']) {
      expect(result.code.split(`'${title}'`).length - 1).toBe(1);
    }
  });

  it('is reproducible from the seed and varies with it', () => {
    const a = shuffleSpecOrder(TRICKY_SPEC, 21);
    const b = shuffleSpecOrder(TRICKY_SPEC, 21);
    expect(a.code).toBe(b.code);
    expect(a.executionOrder).toEqual(b.executionOrder);

    const orders = new Set(
      Array.from({ length: 40 }, (_, s) => shuffleSpecOrder(TRICKY_SPEC, s + 1).executionOrder.join()),
    );
    expect(orders.size).toBeGreaterThan(1);
  });

  it('never loses a block, for any seed', () => {
    const declared = findTestBlocks(TRICKY_SPEC).blocks;
    for (let seed = 1; seed <= 50; seed++) {
      const result = shuffleSpecOrder(TRICKY_SPEC, seed);
      expect(result.code).toHaveLength(TRICKY_SPEC.length);
      expect([...result.executionOrder].sort()).toEqual(declared.map((_, i) => i));
      const reparsed = findTestBlocks(result.code);
      expect(reparsed.ok).toBe(true);
      expect(reparsed.blocks.map((b) => b.title).sort()).toEqual(
        declared.map((b) => b.title).sort(),
      );
    }
  });

  it('declines with a reason rather than guessing, and returns the source untouched', () => {
    const single = "import { test } from '@playwright/test';\ntest('only', async () => {});\n";
    const declinedFew = shuffleSpecOrder(single, 7);
    expect(declinedFew.applied).toBe(false);
    expect(declinedFew.code).toBe(single);
    expect(declinedFew.reason).toContain('at least two');

    const unparsable = "const broken = `oops;\ntest('a', () => {});\ntest('b', () => {});\n";
    const declinedParse = shuffleSpecOrder(unparsable, 7);
    expect(declinedParse.applied).toBe(false);
    expect(declinedParse.code).toBe(unparsable);
    expect(declinedParse.reason).toContain('could not parse');
  });
});

// ─── In-page determinism ─────────────────────────────────────────────────────

/** Runs a generated init script in a fresh realm and reports what it changed. */
function evaluateInitScript(script: string): {
  random: number[];
  now: number;
  iso: string;
  perf: number;
} {
  const sandbox = createContext({ performance: { now: () => 5_000 } });
  runInContext(script, sandbox);
  // Serialised on the way out: the values come from another realm, and the
  // assertion should be about what the page would see, not about realm identity.
  return JSON.parse(
    runInContext(
      `JSON.stringify({ random: [Math.random(), Math.random(), Math.random()],
        now: Date.now(),
        iso: new Date().toISOString(),
        perf: performance.now() })`,
      sandbox,
    ) as string,
  ) as { random: number[]; now: number; iso: string; perf: number };
}

describe('buildInitScript', () => {
  it('is empty when nothing is enabled, so no script is ever injected for free', () => {
    expect(buildInitScript(resolve())).toBe('');
    expect(buildInitScript(resolve({ timezoneId: 'Europe/Berlin' }))).toBe('');
  });

  it('makes Math.random reproducible inside the page', () => {
    const d = resolve({ seedRandom: true, seed: 4242 });
    const first = evaluateInitScript(buildInitScript(d));
    const second = evaluateInitScript(buildInitScript(d));

    expect(first.random).toEqual(second.random);
    // The page's stream must be the SAME generator this process uses, or the
    // seed recorded with the run reproduces a different world.
    expect(first.random).toEqual(Array.from({ length: 3 }, mulberry32(4242)));
  });

  it('freezes the clock, including the monotonic one', () => {
    const d = resolve({ freezeClockAt: '2027-02-28T23:59:59.000Z' });
    const out = evaluateInitScript(buildInitScript(d));

    expect(out.now).toBe(Date.parse('2027-02-28T23:59:59.000Z'));
    expect(out.iso).toBe('2027-02-28T23:59:59.000Z');
    // Date standing still while performance.now() races ahead is a state no
    // real browser presents, and half of "flaky" is code that measures both.
    expect(out.perf).toBe(0);
  });

  it('offsets the clock without stopping it', () => {
    const d = resolve({ clockOffsetMs: 86_400_000 });
    const before = Date.now();
    const out = evaluateInitScript(buildInitScript(d));
    expect(out.now).toBeGreaterThanOrEqual(before + 86_400_000);
    expect(out.now).toBeLessThan(before + 86_400_000 + 60_000);
  });

  it('leaves the clock alone when Playwright’s own clock API will drive it', () => {
    const d = resolve({ freezeClockAt: '2027-02-28T23:59:59.000Z', seedRandom: true });
    const script = buildInitScript(d, { includeClock: false });
    expect(script).toContain('Math.random');
    expect(script).not.toContain('FakeDate');
  });
});

describe('renderDeterminismHeader', () => {
  it('emits nothing when there is nothing to install', () => {
    expect(renderDeterminismHeader(resolve(), { browser: true })).toBe('');
    expect(renderDeterminismHeader(resolve({ shuffleOrder: true }), { browser: true })).toBe('');
    // A clock knob on a spec that never opens a browser: injecting a
    // `beforeEach({ context })` there would launch a browser the test does not
    // use, and blame the app when it timed out.
    expect(renderDeterminismHeader(resolve({ freezeClockAt: '2030-01-01' }), { browser: false })).toBe(
      '',
    );
  });

  it('installs the clock and the seeded random in a browser spec, and says how to replay', () => {
    const header = renderDeterminismHeader(
      resolve({ freezeClockAt: '2030-01-01T00:00:00.000Z', seedRandom: true, seed: 77 }),
      { browser: true },
    );
    expect(header).toContain("import { test as __qaaiTest } from '@playwright/test'");
    expect(header).toContain('addInitScript');
    expect(header).toContain('clock.install');
    expect(header).toContain('clock.pauseAt');
    expect(header).toContain(`${SEED_ENV}=77`);
  });

  it('still seeds the test process when the spec never opens a browser', () => {
    const header = renderDeterminismHeader(resolve({ seedRandom: true, seed: 5 }), {
      browser: false,
    });
    expect(header).toContain('Math.random = __qaaiRng(5)');
    expect(header).not.toContain('addInitScript');
  });
});

describe('usesBrowserFixtures', () => {
  it('recognises a spec that asks for a browser', () => {
    expect(usesBrowserFixtures("test('a', async ({ page }) => {});")).toBe(true);
    expect(usesBrowserFixtures("test('a', async ({ context }) => {});")).toBe(true);
    expect(usesBrowserFixtures("test('a', async ({ page }, testInfo) => {});")).toBe(true);
  });

  it('does not invent one for an API or CLI spec', () => {
    expect(usesBrowserFixtures("test('a', async ({ request }) => {});")).toBe(false);
    expect(usesBrowserFixtures("test('a', async () => { const page = 1; });")).toBe(false);
  });
});

// ─── The plan ────────────────────────────────────────────────────────────────

describe('planDeterminism', () => {
  const spec = `import { test, expect } from '@playwright/test';
test('one', async () => { expect(1).toBe(1); });
test('two', async () => { expect(2).toBe(2); });
`;

  it('is a no-op when determinism is off — byte for byte', () => {
    const plan = planDeterminism(spec, resolve());
    expect(plan.code).toBe(spec);
    expect(plan.shuffle).toBeNull();
    expect(plan.notes).toEqual([]);
    expect(reproduceHint(plan)).toBeNull();
  });

  it('records the order it chose and how to replay it', () => {
    const plan = planDeterminism(spec, resolve({ shuffleOrder: true, seed: 7 }));
    expect(plan.shuffle?.applied).toBe(true);
    expect(plan.code).not.toBe(spec);

    const hint = reproduceHint(plan)!;
    expect(hint).toContain('seed 7');
    expect(hint).toContain(`${SEED_ENV}=7`);
    expect(hint).toContain('two → one');

    const record = determinismRecord(plan);
    expect(record.seed).toBe(7);
    expect(record.executionOrderTitles).toEqual(['two', 'one']);
    expect(record.reproduceWith).toBe(`${SEED_ENV}=7`);
  });

  it('surfaces a declined shuffle instead of pretending it happened', () => {
    const single = "import { test } from '@playwright/test';\ntest('only', async () => {});\n";
    const plan = planDeterminism(single, resolve({ shuffleOrder: true }));
    expect(plan.shuffle?.applied).toBe(false);
    expect(plan.notes.join(' ')).toContain('at least two');
    expect(determinismRecord(plan).orderApplied).toBe(false);
  });

  it('does not put a Playwright import into something that is not a Playwright spec', () => {
    const notASpec = "describe('unit', () => { it('works', () => {}); });\n";
    const plan = planDeterminism(notASpec, resolve({ seedRandom: true, freezeClockAt: '2030-01-01' }));
    expect(plan.code).toBe(notASpec);
    expect(plan.notes.join(' ')).toContain('not a Playwright spec');
  });
});

// ─── End to end, through the real runner ─────────────────────────────────────

/**
 * Two tests where the second only passes because the first ran first: the exact
 * bug this feature exists to expose, and one no current QAAI run can see.
 *
 * Deliberately browserless — the order dependency lives in module state, not in
 * a page, so the proof does not depend on which engines this worker installed.
 */
const ORDER_DEPENDENT_SPEC = `import { test, expect } from '@playwright/test';

const cart: string[] = [];

test('adds an item to the cart', async () => {
  cart.push('widget');
  expect(cart).toEqual(['widget']);
});

test('checkout sees the item already in the cart', async () => {
  expect(cart).toEqual(['widget']);
});
`;

interface HarnessOutcome {
  execution: TestExecution;
  /** Whatever the harness stored, keyed by artifact name. */
  stored: Map<string, string>;
}

async function runHarness(
  determinism?: DeterminismOptions,
  env?: Record<string, string>,
  code: string = ORDER_DEPENDENT_SPEC,
): Promise<HarnessOutcome> {
  const stored = new Map<string, string>();

  const ctx: RunContext = {
    runId: 'run_determinism',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl: 'http://127.0.0.1:1',
    secrets: {},
    grid: null,
    visualBaseline: null,
    storageState: null,
    artifacts: {
      put: async (name, body) => {
        stored.set(name, Buffer.from(body).toString('utf8'));
        return name;
      },
      putFile: async () => '',
      get: async () => null,
      putPersistent: async () => '',
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, step: () => {} },
    signal: new AbortController().signal,
    determinism: {
      freezeClockAt: null,
      randomSeed: 1234,
      waitForNetworkIdle: false,
      // One attempt: this suite is measuring order, and a retry runs in a fresh
      // worker with fresh module state, which is a different experiment.
      retryOnce: false,
    },
  };

  const test: ExecutableTest = {
    id: 'test_order',
    name: 'order-dependent pair',
    type: 'E2E',
    code,
    filePath: 'suite/order-dependent.spec.ts',
    spec: {},
    timeoutMs: 30_000,
    quarantined: false,
    tags: [],
  };

  const restore: Array<[string, string | undefined]> = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    restore.push([key, process.env[key]]);
    process.env[key] = value;
  }
  try {
    const execution = await runPlaywrightSpec(ctx, test, { determinism });
    return { execution, stored };
  } finally {
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('order randomisation, end to end', () => {
  it(
    'passes in declaration order and fails when the seed reverses it, reproducibly',
    async () => {
      // 1. Untouched: the order dependency is invisible, exactly as today.
      const asWritten = await runHarness();
      expect(asWritten.execution.status).toBe('PASSED');
      expect(asWritten.stored.size).toBe(0);

      // 2. A seed that happens to keep the declared order still passes — the
      //    shuffle is a real draw, not "always reverse".
      const keptOrder = await runHarness({
        shuffleOrder: true,
        seed: SEED_THAT_KEEPS_A_PAIR,
      });
      expect(keptOrder.execution.status).toBe('PASSED');
      expect(
        JSON.parse(keptOrder.stored.get('test_order_determinism.json')!).executionOrderTitles,
      ).toEqual(['adds an item to the cart', 'checkout sees the item already in the cart']);

      // 3. A seed that reverses it exposes the bug that was always there.
      const reversed = await runHarness({
        shuffleOrder: true,
        seed: SEED_THAT_REVERSES_A_PAIR,
      });
      expect(reversed.execution.status).toBe('FAILED');
      expect(reversed.execution.errorMessage).toContain(
        `${SEED_ENV}=${SEED_THAT_REVERSES_A_PAIR}`,
      );
      expect(reversed.execution.errorMessage).toContain(
        'checkout sees the item already in the cart → adds an item to the cart',
      );

      const record = JSON.parse(reversed.stored.get('test_order_determinism.json')!);
      expect(record.seed).toBe(SEED_THAT_REVERSES_A_PAIR);
      expect(record.executionOrder).toEqual([1, 0]);
      expect(record.reproduceWith).toBe(`${SEED_ENV}=${SEED_THAT_REVERSES_A_PAIR}`);

      // 4. The recorded seed, fed back through the documented replay path,
      //    reproduces the same order and the same failure. Without this, a
      //    shuffle is just noise.
      const replayed = await runHarness(
        { shuffleOrder: true, seed: SEED_THAT_KEEPS_A_PAIR },
        { [SEED_ENV]: String(SEED_THAT_REVERSES_A_PAIR) },
      );
      expect(replayed.execution.status).toBe('FAILED');
      const replayedRecord = JSON.parse(replayed.stored.get('test_order_determinism.json')!);
      expect(replayedRecord.seed).toBe(SEED_THAT_REVERSES_A_PAIR);
      expect(replayedRecord.seedSource).toBe('env');
      expect(replayedRecord.executionOrder).toEqual(record.executionOrder);
    },
    180_000,
  );

  /**
   * Order randomisation makes this case routine — it exists to move the failing
   * test off the end of the file — and the harness used to read the flattened
   * result list as retries of one test, so "first fails, second passes" came
   * back FLAKY. Downgrading a deterministic failure to a flake is the signal
   * §5 protects, so it is pinned here whether or not a shuffle is involved.
   */
  it(
    'reports a failing first test as FAILED, and shows that test’s failing step',
    async () => {
      const failsFirst = `import { test, expect } from '@playwright/test';

test('the one that breaks', async () => {
  await test.step('checking the total', async () => {
    expect(2 + 2).toBe(5);
  });
});

test('the one that is fine', async () => {
  await test.step('checking the sum', async () => {
    expect(2 + 2).toBe(4);
  });
});
`;
      const { execution } = await runHarness(undefined, undefined, failsFirst);

      expect(execution.status).toBe('FAILED');
      expect(execution.retriedAndPassed).toBe(false);
      // The cockpit must open on the thing that broke, not on whatever ran last.
      expect(execution.steps[0]?.title).toBe('checking the total');
      expect(execution.steps[0]?.status).toBe('FAILED');
    },
    180_000,
  );
});
