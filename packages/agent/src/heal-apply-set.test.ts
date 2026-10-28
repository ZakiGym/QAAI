/**
 * The post-check over a multi-file change, and the one place it is STRICTER
 * than the single-file one.
 *
 * `postCheckCode`'s rule is that SYNTAX is the only refusal, because a heal is a
 * fix for a test that is already red and refusing it leaves the customer worse
 * off. A SET adds two refusals that a human approving a diff cannot make safe:
 *
 *   • a structural problem — two artifacts at one path, a write to a file QAAI
 *     does not own, or a base hash the ledger has moved past. Approving the last
 *     of those DISCARDS whatever moved it, which is the work this whole model
 *     exists to protect.
 *   • a SYNTAX failure on ANY artifact, because a spec applied without its page
 *     object fails its first run on an import error.
 *
 * And it preserves what the single-file path decided: a page object that asserts
 * nothing is not a defect, an UNAVAILABLE that is structural does not block the
 * unattended path, and a missing ledger declines the unattended path without
 * blocking the reviewed one.
 */

import { describe, expect, it } from 'vitest';

import { postCheckSet } from './heal-apply.js';
import type { ArtifactSet, GeneratedArtifact } from '@qaai/shared';

const SPEC = `import { test, expect } from '@playwright/test';
import { CartPage } from '../pages/cart.page';

test('cart shows the total', async ({ page }) => {
  const cart = new CartPage(page);
  await cart.open();
  await expect(page.getByTestId('order-total')).toHaveText('$42.00');
});
`;

const PAGE_OBJECT = `import type { Page } from '@playwright/test';

export class CartPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await this.page.goto('/cart');
  }
}
`;

function artifact(over: Partial<GeneratedArtifact>): GeneratedArtifact {
  return {
    role: 'SPEC',
    path: 'tests/cart.spec.ts',
    content: SPEC,
    disposition: 'UPDATE_OWNED',
    ownership: 'QAAI_OWNED',
    imports: [],
    basedOnHash: 'h-spec',
    why: 'the spec',
    ...over,
  };
}

/** A set as the apply path sees it: both files already QAAI's, both updated. */
function ownedSet(): ArtifactSet {
  return {
    dialect: 'JS_EXPECT',
    artifacts: [
      artifact({
        role: 'PAGE_OBJECT',
        path: 'pages/cart.page.ts',
        content: PAGE_OBJECT,
        basedOnHash: 'h-page',
        why: 'the page object',
      }),
      artifact({ imports: ['pages/cart.page.ts'] }),
    ],
  };
}

const LEDGER = [
  {
    path: 'pages/cart.page.ts',
    role: 'PAGE_OBJECT' as const,
    ownership: 'QAAI_OWNED' as const,
    contentHash: 'h-page',
    imports: [] as string[],
  },
  {
    path: 'tests/cart.spec.ts',
    role: 'SPEC' as const,
    ownership: 'QAAI_OWNED' as const,
    contentHash: 'h-spec',
    imports: ['pages/cart.page.ts'],
  },
];

const CONTEXT = { ledger: LEDGER, priorContent: () => PAGE_OBJECT };

describe('a set QAAI owns, whose files all parse', () => {
  it('is allowed', async () => {
    const check = await postCheckSet({
      set: ownedSet(),
      testType: 'E2E',
      language: 'TYPESCRIPT',
      ecosystemId: 'PLAYWRIGHT_TS',
      context: CONTEXT,
    });

    expect(check.allowed).toBe(true);
    expect(check.refusal).toBeUndefined();
  });

  /*
   * A page object asserts nothing BY DEFINITION, and ASSERTIONS is a hard fail.
   * Without `GATES_NOT_ABOUT_ROLE` every heal that touched one would be flagged
   * for a defect it cannot not have — and a flag that is always there is a flag
   * nobody reads.
   */
  it('does not treat its page object asserting nothing as a defect', async () => {
    const check = await postCheckSet({
      set: ownedSet(),
      testType: 'E2E',
      language: 'TYPESCRIPT',
      ecosystemId: 'PLAYWRIGHT_TS',
      context: CONTEXT,
    });

    const failures = check.flags.filter((flag) => /fails a check/.test(flag));
    expect(failures.filter((flag) => flag.startsWith('pages/cart.page.ts'))).toEqual([]);
    // It IS said out loud, as a set-aside finding rather than a failure.
    expect(check.flags.join(' ')).toMatch(/only the spec in a set asserts/);
  });

  it('names, per file, what ran and what did not', async () => {
    const check = await postCheckSet({
      set: ownedSet(),
      testType: 'E2E',
      language: 'TYPESCRIPT',
      ecosystemId: 'PLAYWRIGHT_TS',
      context: CONTEXT,
    });

    expect(check.checks).toMatch(/pages\/cart\.page\.ts \(PAGE_OBJECT\): checked/);
    expect(check.checks).toMatch(/tests\/cart\.spec\.ts \(SPEC\): checked/);
    // "no flags" has to be distinguishable from "nothing looked".
    expect(check.checks).toMatch(/not checked/);
  });
});

describe('a set with one unparseable file', () => {
  /*
   * A spec applied without its page object fails its first run on an import
   * error, which reads to a human as a broken test rather than as an interrupted
   * write. So a SYNTAX failure on ANY artifact refuses the whole set.
   */
  it('is refused as a whole, naming the file', async () => {
    const broken: ArtifactSet = {
      dialect: 'JS_EXPECT',
      artifacts: [
        artifact({
          role: 'PAGE_OBJECT',
          path: 'pages/cart.page.ts',
          content: 'export class CartPage { async open( {',
          basedOnHash: 'h-page',
        }),
        artifact({ imports: ['pages/cart.page.ts'] }),
      ],
    };

    const check = await postCheckSet({
      set: broken,
      testType: 'E2E',
      language: 'TYPESCRIPT',
      ecosystemId: 'PLAYWRIGHT_TS',
      context: { ...CONTEXT, priorContent: () => 'export class CartPage {}' },
    });

    expect(check.allowed).toBe(false);
    expect(check.refusal).toMatch(/"pages\/cart\.page\.ts" does not parse/);
    expect(check.autoApplyAllowed).toBe(false);
  });
});

describe('a set that would write a file QAAI does not own', () => {
  /*
   * THE REFUSAL THAT HAS NO EQUIVALENT ON THE SINGLE-FILE PATH, and the reason
   * is that a human cannot make it safe: approving a change computed against
   * bytes somebody has since replaced DISCARDS whatever replaced them.
   */
  it('is refused even on the reviewed path', async () => {
    const theirs: ArtifactSet = {
      dialect: 'JS_EXPECT',
      artifacts: [
        artifact({
          role: 'PAGE_OBJECT',
          path: 'pages/cart.page.ts',
          content: PAGE_OBJECT,
          ownership: 'HUMAN_EDITED',
          disposition: 'UPDATE_OWNED',
          basedOnHash: 'h-page',
        }),
      ],
    };

    const check = await postCheckSet({
      set: theirs,
      testType: 'E2E',
      language: 'TYPESCRIPT',
      ecosystemId: 'PLAYWRIGHT_TS',
      context: {
        ledger: [{ ...LEDGER[0]!, ownership: 'HUMAN_EDITED' }],
        priorContent: () => PAGE_OBJECT,
      },
    });

    expect(check.allowed).toBe(false);
    expect(check.refusal).toMatch(/WRITE_TO_UNOWNED/);
  });

  it('is refused when the ledger has moved past the base hash', async () => {
    const check = await postCheckSet({
      set: ownedSet(),
      testType: 'E2E',
      language: 'TYPESCRIPT',
      ecosystemId: 'PLAYWRIGHT_TS',
      context: {
        ledger: LEDGER.map((row) => ({ ...row, contentHash: 'somebody-else-wrote-this' })),
        priorContent: () => PAGE_OBJECT,
      },
    });

    expect(check.allowed).toBe(false);
    expect(check.refusal).toMatch(/STALE_BASE/);
  });
});

describe('with no ownership ledger', () => {
  /*
   * NOT A PASS AND NOT A REFUSAL. A human approving the diff is the premise
   * auto-apply lacks, so the reviewed path stays open and the unattended one
   * declines with the reason — an unattended write to a path nobody checked the
   * ownership of is the `pushRepo` defect with a different caller.
   */
  it('allows the reviewed path and declines the unattended one', async () => {
    const check = await postCheckSet({
      set: ownedSet(),
      testType: 'E2E',
      language: 'TYPESCRIPT',
      ecosystemId: 'PLAYWRIGHT_TS',
    });

    expect(check.allowed).toBe(true);
    expect(check.autoApplyAllowed).toBe(false);
    expect(check.autoApplyDeclined).toMatch(/No ownership ledger was supplied/);
    expect(check.report.ledgerChecked).toBe(false);
  });
});

describe('the unattended path', () => {
  it('declines when any check that could run came back anything but PASS', async () => {
    const sleepy: ArtifactSet = {
      dialect: 'JS_EXPECT',
      artifacts: [
        artifact({
          content: SPEC.replace(
            "await cart.open();",
            "await cart.open();\n  await page.waitForTimeout(3000);",
          ),
        }),
      ],
    };

    const check = await postCheckSet({
      set: sleepy,
      testType: 'E2E',
      language: 'TYPESCRIPT',
      ecosystemId: 'PLAYWRIGHT_TS',
      context: { ledger: [LEDGER[1]!], priorContent: () => SPEC },
    });

    // A fixed sleep is worth a human's eye and is not worth leaving a test
    // broken over — so it is allowed, flagged, and not applied unattended.
    expect(check.allowed).toBe(true);
    expect(check.autoApplyAllowed).toBe(false);
    expect(check.flags.join(' ')).toMatch(/tests\/cart\.spec\.ts/);
  });
});

describe('a set that is not JavaScript', () => {
  /*
   * SYNTAX REACHABILITY IS A QUESTION ABOUT EACH FILE'S OWN EXTENSION, not
   * about the set. A `.ts` file's parse is reachable in process; a `.py`
   * file's is not without the customer's own interpreter, which needs a
   * checkout. Treating the set's answer as one of these would either block the
   * unattended path on every polyglot set — a feature silently switched off —
   * or claim a parse that never ran.
   *
   * So a Python set with every reachable gate passing IS applyable unattended,
   * and the line that says so is the per-file reachability check.
   */
  const PY_SPEC = `import pytest


def test_cart_shows_the_total(page):
    page.goto("/cart")
    assert page.get_by_test_id("order-total").inner_text() == "$42.00"
`;
  const CONFTEST = `import pytest


@pytest.fixture
def signed_in_page(page):
    page.goto("/login")
    return page
`;

  it('reports an unreachable parse as structural rather than as a fact about the file', async () => {
    const set: ArtifactSet = {
      dialect: 'PY_ASSERT',
      artifacts: [
        artifact({
          role: 'FIXTURE',
          path: 'tests/conftest.py',
          content: CONFTEST,
          basedOnHash: 'h-conftest',
          why: 'the fixture',
        }),
        artifact({
          path: 'tests/test_cart.py',
          content: PY_SPEC,
          basedOnHash: 'h-pyspec',
          imports: ['tests/conftest.py'],
        }),
      ],
    };

    const check = await postCheckSet({
      set,
      testType: 'E2E',
      language: 'PYTHON',
      context: {
        ledger: [
          {
            path: 'tests/conftest.py',
            role: 'FIXTURE',
            ownership: 'QAAI_OWNED',
            contentHash: 'h-conftest',
            imports: [],
          },
          {
            path: 'tests/test_cart.py',
            role: 'SPEC',
            ownership: 'QAAI_OWNED',
            contentHash: 'h-pyspec',
            imports: ['tests/conftest.py'],
          },
        ],
        priorContent: () => CONFTEST,
      },
    });

    expect(check.allowed).toBe(true);
    // Not checked, and SAID to be not checked — never claimed as a pass.
    expect(check.checks).toMatch(/tests\/test_cart\.py \(SPEC\): checked .*not checked.*parses/);
    /*
     * And the unattended path is NOT blocked by it: a parse that could never
     * have run on this file type is structural, and the dialect-based gates
     * that CAN read a Python file still decide.
     */
    expect(check.autoApplyAllowed).toBe(true);
    expect(check.autoApplyDeclined).toBeUndefined();
  });
});
