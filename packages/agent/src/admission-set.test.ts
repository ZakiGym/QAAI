/**
 * The gate over a SET, which is the shape generation now produces.
 *
 * A spec admitted without its page object does not run, so the question this
 * file answers is "is every file in this change admissible", not "is this file
 * admissible". Two properties carry the weight:
 *
 *   1. A CORRECT PAGE OBJECT DOES NOT REFUSE THE SET IT BELONGS TO. A page
 *      object is DEFINED as locators and actions with no assertions, and
 *      ASSERTIONS is a HARD fail — so without `GATES_NOT_ABOUT_ROLE` every set
 *      containing one is refused for ever, which is the feature switched off by
 *      its own gate.
 *   2. NOTHING IS SUPPRESSED TO ACHIEVE THAT. The full twelve-gate report comes
 *      back per artifact, and every finding not counted is NAMED in `setAside`.
 *
 * In a separate file from admission.test.ts deliberately: that file pins the
 * twelve-gate table for ONE file and is the authority on it, and a set-level
 * assertion that happened to break a single-file expectation would be hard to
 * attribute. Nothing here re-asserts a single-file semantic; it asserts that
 * `admitSet` did not change one.
 */

import { describe, expect, it } from 'vitest';

import { ARTIFACT_ROLES } from '@qaai/shared';
import type {
  ArtifactLedgerEntry,
  ArtifactRole,
  ArtifactSet,
  GeneratedArtifact,
} from '@qaai/shared';
import { GATES_NOT_ABOUT_ROLE, PROBLEM_NEEDS_LEDGER, admitSet } from './admission.js';
import type { GateId } from './admission.js';

const ITEM = {
  id: 'item_1',
  title: 'Checkout shows the order total',
  rationale: 'The total is the number a customer disputes.',
  feature: 'checkout',
  priority: 'CRITICAL_PATH' as const,
  testType: 'E2E' as const,
  steps: ['Add a product to the cart', 'Go to checkout'],
  assertions: ['the order confirmation shows a total of $42.00'],
  journeyId: null,
  authProfileId: null,
};

/** A spec that satisfies ASSERTIONS and FIDELITY against ITEM. */
const SPEC_CODE = `import { test, expect } from '@playwright/test';
import { CartPage } from '../pages/cart.page';

test('order confirmation shows a total of $42.00', async ({ page }) => {
  const cart = new CartPage(page);
  await cart.addFirstProduct();
  await page.getByRole('link', { name: 'Checkout' }).click();
  await expect(page.getByText('Order confirmed')).toBeVisible();
  await expect(page.getByTestId('order-total')).toHaveText('$42.00');
});
`;

/** A page object: locators and actions, and — correctly — no assertions at all. */
const PAGE_OBJECT_CODE = `import type { Page } from '@playwright/test';

export class CartPage {
  constructor(private readonly page: Page) {}

  async addFirstProduct(): Promise<void> {
    await this.page.getByRole('button', { name: 'Add to cart' }).first().click();
  }
}
`;

function artifact(
  role: ArtifactRole,
  path: string,
  content: string,
  imports: readonly string[] = [],
): GeneratedArtifact {
  return {
    role,
    path,
    content,
    disposition: 'NEW',
    ownership: 'QAAI_OWNED',
    imports,
    basedOnHash: null,
    why: `the ${role}`,
  };
}

/** The shape `declaredArtifactSet` produces: a spec and the page object it imports. */
function declaredSet(): ArtifactSet {
  return {
    dialect: 'JS_EXPECT',
    artifacts: [
      artifact('PAGE_OBJECT', 'pages/cart.page.ts', PAGE_OBJECT_CODE),
      artifact('SPEC', 'tests/checkout.spec.ts', SPEC_CODE, ['pages/cart.page.ts']),
    ],
  };
}

const BASE = {
  testType: 'E2E' as const,
  item: ITEM,
  language: 'TYPESCRIPT' as const,
  ecosystemId: 'PLAYWRIGHT_TS',
  attempt: 2,
};

describe('a set whose files are all admissible', () => {
  it('admits the spec and its page object together', async () => {
    const report = await admitSet({ ...BASE, set: declaredSet() });

    expect(report.verdict).not.toBe('REFUSE');
    expect(report.verdict).not.toBe('REVISE');
    expect(report.setProblems).toEqual([]);
    expect(report.artifacts.map((a) => a.path)).toEqual([
      'pages/cart.page.ts',
      'tests/checkout.spec.ts',
    ]);
  });

  /*
   * THE PROPERTY THE WHOLE RECORD EXISTS FOR. Without `GATES_NOT_ABOUT_ROLE`
   * the page object's ASSERTIONS FAIL is a HARD fail, so this set is REVISE at
   * attempt 1 and REFUSE at attempt 2 — for ever, because a correct page object
   * will never assert anything.
   */
  it('does not refuse the set because its page object asserts nothing', async () => {
    const report = await admitSet({ ...BASE, set: declaredSet() });

    const pageObject = report.artifacts.find((a) => a.role === 'PAGE_OBJECT');
    /*
     * ADMIT and not ADMIT_WITH_FLAGS: `verdictFor` keys on FAIL and WARN, and
     * an UNAVAILABLE gate rides out in `reviewFlags` instead of changing the
     * verdict. That is its existing arithmetic, reached through the same
     * function, and this assertion pins that `admitSet` did not re-decide it.
     */
    expect(pageObject?.verdict).toBe('ADMIT');
    // The gate DID run and DID fail; it simply is not about this role.
    const assertions = pageObject?.report.gates.find((g) => g.gate === 'ASSERTIONS');
    expect(assertions?.status).toBe('FAIL');
    expect(pageObject?.judged).not.toContain('ASSERTIONS');
  });

  it('names every finding it did not count, rather than hiding it', async () => {
    const report = await admitSet({ ...BASE, set: declaredSet() });

    const aside = report.setAside.filter((entry) => entry.path === 'pages/cart.page.ts');
    expect(aside.map((entry) => entry.gate)).toContain('ASSERTIONS');
    expect(aside.find((entry) => entry.gate === 'ASSERTIONS')?.why).toMatch(
      /only the spec in a set asserts/,
    );
    // Nothing is set aside for a SPEC: it is judged on all twelve.
    expect(report.setAside.filter((entry) => entry.role === 'SPEC')).toEqual([]);
    expect(report.artifacts.find((a) => a.role === 'SPEC')?.judged).toContain('ASSERTIONS');
  });

  /*
   * A page object at a SPEC path would be collected by the runner and executed
   * as a test with no tests in it. "Correcting" a page object onto a spec path
   * is therefore the defect, not the fix, which is why PATH_CONVENTION is set
   * aside — and the report must still carry whatever it said.
   */
  /*
   * The plan item travels with the SPEC alone, and the page object's FIDELITY
   * gate must say UNAVAILABLE — "there was nothing to trace" — rather than
   * FAIL. A FAIL claims a measurement was made and came out wrong, over a file
   * of locators compared against an English sentence about an order total.
   */
  it('does not trace the approved plan item into a page object', async () => {
    const report = await admitSet({ ...BASE, set: declaredSet() });

    const pageObject = report.artifacts.find((a) => a.role === 'PAGE_OBJECT');
    const fidelity = pageObject?.report.gates.find((g) => g.gate === 'FIDELITY');
    expect(fidelity?.status).toBe('UNAVAILABLE');
    // And the SPEC's IS traced, so this is not "FIDELITY never runs".
    const spec = report.artifacts.find((a) => a.role === 'SPEC');
    expect(spec?.report.gates.find((g) => g.gate === 'FIDELITY')?.status).not.toBe('UNAVAILABLE');
  });

  /*
   * The flags are recomputed over the JUDGED gates and NOT copied out of the
   * per-artifact report, whose own verdict was computed over all twelve. A page
   * object's report says REFUSE (no assertions) while its judged verdict says
   * ADMIT — so copying its flags would put "admitted despite failing a check"
   * on a file about a check that is not about it, which is a flag that trains
   * people to ignore flags.
   */
  it('never flags a page object for failing a check that is not about it', async () => {
    const report = await admitSet({ ...BASE, set: declaredSet() });

    const pageObject = report.artifacts.find((a) => a.role === 'PAGE_OBJECT');
    const aboutPageObject = report.reviewFlags
      .filter((flag) => flag.startsWith('pages/cart.page.ts: '))
      .map((flag) => flag.slice('pages/cart.page.ts: '.length));

    /*
     * THE STRUCTURAL INVARIANT, not a string match on four sentences: EVERY
     * flag about this file must be traceable to a gate that JUDGED it. A flag
     * sourced from a set-aside gate — "the plan item was not traced", "whether
     * you already have this test was not checked" — is a sentence about a
     * question this file was never asked, and a flag like that on every page
     * object in the product trains people to ignore flags.
     */
    const judgedWhys = new Set(
      (pageObject?.report.gates ?? [])
        .filter((gate) => pageObject?.judged.includes(gate.gate))
        .map((gate) => gate.why),
    );
    expect(aboutPageObject.length).toBeGreaterThan(0);
    for (const flag of aboutPageObject) expect(judgedWhys.has(flag)).toBe(true);
    expect(aboutPageObject.filter((flag) => /Admitted despite failing/.test(flag))).toEqual([]);
  });

  it('does not move a page object onto a spec path', async () => {
    const report = await admitSet({ ...BASE, set: declaredSet() });

    const pageObject = report.artifacts.find((a) => a.role === 'PAGE_OBJECT');
    expect(pageObject?.judged).not.toContain('PATH_CONVENTION');
    expect(report.set.artifacts.find((a) => a.role === 'PAGE_OBJECT')?.path).toBe(
      'pages/cart.page.ts',
    );
  });
});

describe('a set with one bad file', () => {
  /*
   * The register item: a set is admitted only if EVERY artifact clears. A spec
   * whose page object does not parse imports a file the runner cannot load.
   */
  it('is refused as a whole when its page object does not parse', async () => {
    const broken = {
      ...declaredSet(),
      artifacts: [
        artifact('PAGE_OBJECT', 'pages/cart.page.ts', 'export class CartPage { async go( {'),
        artifact('SPEC', 'tests/checkout.spec.ts', SPEC_CODE, ['pages/cart.page.ts']),
      ],
    };

    /*
     * A real toolchain is needed for SYNTAX to be anything but UNAVAILABLE, and
     * injecting one is the honest way to test the verdict: the injected gate is
     * a literal, so the test runs with no child process and no API key.
     */
    const report = await admitSet({
      ...broken ? BASE : BASE,
      set: broken,
      toolchain: {
        syntax: async (input) => ({
          gate: 'SYNTAX' as const,
          status: input.code.includes('async go( {') ? ('FAIL' as const) : ('PASS' as const),
          why: 'the parser rejected this file',
          detail: ["1:35 '{' expected"],
          line: 1,
        }),
        typecheck: async () => ({
          gate: 'TYPECHECK' as const,
          status: 'PASS' as const,
          why: 'no type errors',
          detail: [],
          line: null,
        }),
        format: async () => ({
          gate: 'FORMAT' as const,
          status: 'PASS' as const,
          why: 'already formatted',
          detail: [],
          line: null,
        }),
        lint: async () => ({
          gate: 'LINT' as const,
          status: 'PASS' as const,
          why: 'no lint errors',
          detail: [],
          line: null,
        }),
      },
    });

    expect(report.verdict).toBe('REFUSE');
    expect(report.artifacts.find((a) => a.role === 'PAGE_OBJECT')?.verdict).toBe('REFUSE');
    // And the spec itself was fine, which is exactly why the SET verdict matters.
    expect(report.artifacts.find((a) => a.role === 'SPEC')?.verdict).not.toBe('REFUSE');
  });

  it('asks for one more attempt when the spec is revisable, naming the file', async () => {
    const weak = {
      ...declaredSet(),
      artifacts: [
        artifact('PAGE_OBJECT', 'pages/cart.page.ts', PAGE_OBJECT_CODE),
        artifact(
          'SPEC',
          'tests/checkout.spec.ts',
          `import { test } from '@playwright/test';\ntest('reaches checkout', async ({ page }) => {\n  await page.goto('/checkout');\n});\n`,
          ['pages/cart.page.ts'],
        ),
      ],
    };

    const report = await admitSet({ ...BASE, attempt: 1, set: weak });

    expect(report.verdict).toBe('REVISE');
    expect(report.revisePrompt).toContain('tests/checkout.spec.ts');
    // The page object is not in the revise prompt: nothing is wrong with it.
    expect(report.revisePrompt).not.toContain('pages/cart.page.ts (PAGE_OBJECT)');
  });

  it('collapses REVISE to a verdict nobody has to loop on when nothing can act on it', async () => {
    const weak = {
      ...declaredSet(),
      artifacts: [
        artifact(
          'SPEC',
          'tests/checkout.spec.ts',
          `import { test } from '@playwright/test';\ntest('reaches checkout', async ({ page }) => {\n  await page.goto('/checkout');\n});\n`,
        ),
      ],
    };

    const report = await admitSet({ ...BASE, attempt: 1, revisable: false, set: weak });

    // `revisable: false` is `verdictFor`'s own collapse, reached through the
    // same function rather than re-decided here.
    expect(report.verdict).toBe('REFUSE');
    expect(report.revisePrompt).toBeNull();
  });
});

describe('the structural refusals', () => {
  it('refuses two artifacts at one path, and applies nothing', async () => {
    const clash: ArtifactSet = {
      dialect: 'JS_EXPECT',
      artifacts: [
        artifact('PAGE_OBJECT', 'pages/cart.page.ts', PAGE_OBJECT_CODE),
        artifact('PAGE_OBJECT', 'pages/cart.page.ts', PAGE_OBJECT_CODE),
        artifact('SPEC', 'tests/checkout.spec.ts', SPEC_CODE, ['pages/cart.page.ts']),
      ],
    };

    const report = await admitSet({ ...BASE, set: clash });

    expect(report.verdict).toBe('REFUSE');
    expect(report.setProblems.map((p) => p.kind)).toContain('DUPLICATE_PATH');
    // Terminal, not revisable: a producer wrote two artifacts at one path.
    expect(report.revisePrompt).toBeNull();
  });

  /*
   * APPLY_ORDER can never be the reason a set is refused: a deterministic sort
   * is the fix, and refusing a correct set over the sequence a producer listed
   * it in would be a refusal nobody can act on.
   */
  it('sorts a set given in reading order rather than refusing it', async () => {
    const readingOrder: ArtifactSet = {
      dialect: 'JS_EXPECT',
      artifacts: [
        artifact('SPEC', 'tests/checkout.spec.ts', SPEC_CODE, ['pages/cart.page.ts']),
        artifact('PAGE_OBJECT', 'pages/cart.page.ts', PAGE_OBJECT_CODE),
      ],
    };

    const report = await admitSet({ ...BASE, set: readingOrder });

    expect(report.setProblems.map((p) => p.kind)).not.toContain('APPLY_ORDER');
    expect(report.set.artifacts.map((a) => a.role)).toEqual(['PAGE_OBJECT', 'SPEC']);
  });

  it('refuses a write to a file QAAI does not own, once a ledger is in hand', async () => {
    const ledger: readonly ArtifactLedgerEntry[] = [
      {
        path: 'pages/cart.page.ts',
        role: 'PAGE_OBJECT',
        ownership: 'HUMAN_AUTHORED',
        contentHash: 'theirs',
        imports: [],
      },
    ];

    const report = await admitSet({
      ...BASE,
      set: declaredSet(),
      context: { ledger, priorContent: () => PAGE_OBJECT_CODE },
    });

    expect(report.ledgerChecked).toBe(true);
    expect(report.verdict).toBe('REFUSE');
    const kinds = report.setProblems.map((p) => p.kind);
    expect(kinds).toContain('STALE_BASE');
    expect(report.reviewFlags.join(' ')).toMatch(/Nothing in this set was applied/);
  });
});

describe('the ledger half, and saying when it was not asked', () => {
  /*
   * A declared set claims QAAI_OWNED/NEW on every artifact, so with no ledger
   * every path is WRITE_TO_UNOWNED and STALE_BASE. Refusing on that basis would
   * mean a project could never receive its first test — so those refusals are
   * not asked, and the report says they were not.
   */
  it('reports that it did not ask, rather than passing', async () => {
    const report = await admitSet({ ...BASE, set: declaredSet() });

    expect(report.ledgerChecked).toBe(false);
    expect(report.reviewFlags.join(' ')).toMatch(/No ownership ledger was supplied/);
    expect(report.setProblems.map((p) => p.kind)).not.toContain('WRITE_TO_UNOWNED');
  });

  it('classifies every problem kind as needing a ledger or not', () => {
    /*
     * The run-time half of a compiler-enforced record. The compiler half proves
     * every key EXISTS; this proves the classification covers the vocabulary as
     * it actually stands, which is what breaks when a thirteenth kind is added
     * to `ARTIFACT_SET_PROBLEMS` and this record is updated by a merge rather
     * than by a decision.
     */
    expect(Object.keys(PROBLEM_NEEDS_LEDGER).sort()).toEqual(
      [
        'APPLY_ORDER',
        'ARTIFACT_SIZE',
        'BASE_HASH_ON_NEW',
        'DUPLICATE_PATH',
        'MISSING_BASE_HASH',
        'PATH_ESCAPE',
        'SET_SIZE',
        'SHARED_EXPORT_REMOVED',
        'SHARED_SURFACE_UNREADABLE',
        'STALE_BASE',
        'UNRESOLVED_IMPORT',
        'WRITE_TO_UNOWNED',
      ].sort(),
    );
  });
});

describe('the role record', () => {
  it('decides for every artifact role which gates judge it', () => {
    /*
     * The run-time parity the file header asks for: the compiler proves every
     * key is present, and this proves the keys are the vocabulary's own members
     * rather than a stale copy of it.
     */
    expect(Object.keys(GATES_NOT_ABOUT_ROLE).sort()).toEqual([...ARTIFACT_ROLES].sort());
  });

  it('sets nothing aside for the SPEC, which is the file that is the test', () => {
    expect(GATES_NOT_ABOUT_ROLE.SPEC).toEqual([]);
  });

  it('never sets aside a gate that is about the code rather than the role', () => {
    /*
     * The gates below are properties of a FILE, not of a role: a `@qaai/` import
     * in a fixture still means the file does not run in the customer's
     * repository, a fixed sleep in a helper is still a flake source, and a
     * brittle locator in a page object is the most consequential place to have
     * one. A future edit that quietened one of these for a role would be
     * switching a check off, so it is pinned here.
     */
    const alwaysJudged: readonly GateId[] = [
      'SYNTAX',
      'TYPECHECK',
      'FORMAT',
      'LINT',
      'LOCATORS',
      'NO_LOCK_IN',
      'NO_FIXED_SLEEP',
      'MUTATION',
    ];
    for (const role of ARTIFACT_ROLES) {
      for (const gate of alwaysJudged) {
        expect(GATES_NOT_ABOUT_ROLE[role]).not.toContain(gate);
      }
    }
  });
});
