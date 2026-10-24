/**
 * The surface vocabulary, asserted as an invariant rather than as a check run.
 *
 * WHY THIS FILE EXISTS
 *
 * `checkSurfaceVocabulary` in check-wiring.ts compares the four declarations of
 * the coverage vocabulary — the Prisma enums, the shared lists,
 * MEASURED_SURFACE_KINDS and the MATCHERS map — and fails when any pair has
 * drifted. That check only runs when somebody runs `npm run check:wiring`.
 * These cases put the same invariant in `npm test`, which runs on every change,
 * so a kind added to one list and not the other is caught by the fast command
 * and not only by the slow one.
 *
 * It is a SECOND, INDEPENDENT derivation on purpose. check-wiring reads all
 * four declarations out of source text; this file imports the real exported
 * values from @qaai/shared and compares them against the two files that are not
 * importable (the Prisma schema, and a module-private MATCHERS map). Two
 * mechanisms agreeing is worth more than one mechanism repeated, because the
 * failure mode that matters here is a regex that quietly stops matching: a
 * check that parses nothing reports agreement it never verified, which is a
 * green light for the exact drift it was added to stop. The first case below
 * exists only to make that impossible, and every later case depends on it.
 *
 * WHY IT DOES NOT IMPORT check-wiring.ts
 *
 * That file is a script, not a module: it ends in `void main()`, and main()
 * probes a live API, imports the Playwright-backed runner registry and finishes
 * with process.exit(). Importing it from a test runs the whole check and then
 * kills the vitest worker. So the last case here reads it as TEXT, to assert
 * the one thing about it that nothing else can: that the drift guard it defines
 * is actually called from main(). A check function nobody calls is this repo's
 * signature defect, and check-wiring has no check for itself.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MEASURED_SURFACE_KINDS,
  SURFACE_KINDS,
  SURFACE_ORIGINS,
  SURFACE_STATUSES,
  unmeasuredKinds,
} from '@qaai/shared';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (relPath: string): string => readFileSync(join(ROOT, relPath), 'utf8');

const SCHEMA = 'apps/api/prisma/schema.prisma';
const COVERAGE = 'packages/agent/src/surface-coverage.ts';
const INVENTORY = 'packages/agent/src/surface-inventory.ts';
const WIRING = 'scripts/check-wiring.ts';

/** Members of a Prisma `enum X { … }`, in declaration order, doc comments out. */
function prismaEnum(name: string): string[] {
  const block = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(read(SCHEMA));
  if (!block) throw new Error(`${SCHEMA} declares no enum ${name}`);
  return block[1]!
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => /^[A-Z_][A-Z0-9_]*$/.test(line));
}

/**
 * The kinds MATCHERS has an entry for. Read as text because MATCHERS is
 * module-private and should stay that way — a test is not a reason to widen a
 * package's public surface.
 */
function matcherKinds(): string[] {
  const map = /\bconst MATCHERS\b[\s\S]*?=\s*\{([^}]*)\}/.exec(read(COVERAGE));
  if (!map) throw new Error(`Could not find the MATCHERS map in ${COVERAGE}`);
  return [...map[1]!.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)].map((m) => m[1]!);
}

/**
 * The axis list hand-written inside `missingAxes()`.
 *
 * The first bracketed block containing a quoted member, because the return type
 * annotation `SurfaceKind[]` is a bracketed block too and matching it reads the
 * function as naming no axes at all.
 */
function missingAxesBody(): string {
  const body = /\bfunction missingAxes\b([\s\S]*?)\n\}/.exec(read(INVENTORY));
  if (!body) throw new Error(`Could not find missingAxes() in ${INVENTORY}`);
  return body[1]!;
}

/**
 * True when missingAxes() delegates to the derived list rather than restating
 * it. That is the state these cases want: a delegation IS the subtraction
 * SURFACE_KINDS minus MEASURED_SURFACE_KINDS, so it cannot drift from it, and
 * there is no literal left to compare.
 */
function missingAxesIsDerived(): boolean {
  return /\breturn\s+unmeasuredKinds\(\s*\)/.test(missingAxesBody());
}

/** The hand-written list, when there still is one. */
function hardcodedMissingAxes(): string[] {
  const list = /\[([^\]]*'[^\]]*)\]/.exec(missingAxesBody());
  if (!list) throw new Error(`missingAxes() in ${INVENTORY} holds no quoted axis list`);
  return [...list[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('the readers these cases depend on', () => {
  /*
   * Every assertion below compares a parsed list with an imported one. A parse
   * that returns [] makes "nothing is missing from it" trivially true, so the
   * suite would go green precisely when it had stopped being able to see.
   */
  it('finds non-empty declarations, so no later case can pass vacuously', () => {
    expect(prismaEnum('SurfaceKind').length).toBeGreaterThan(0);
    expect(prismaEnum('SurfaceStatus').length).toBeGreaterThan(0);
    expect(prismaEnum('SurfaceOrigin').length).toBeGreaterThan(0);
    expect(matcherKinds().length).toBeGreaterThan(0);
    // Either there is a literal to read, or there is no literal because the
    // function derives the list — both are non-vacuous states.
    if (missingAxesIsDerived()) expect(missingAxesIsDerived()).toBe(true);
    else expect(hardcodedMissingAxes().length).toBeGreaterThan(0);

    // And the imported side, which a bad barrel export could empty.
    expect(SURFACE_KINDS.length).toBeGreaterThan(0);
    expect(MEASURED_SURFACE_KINDS.length).toBeGreaterThan(0);
  });
});

describe('the surface vocabulary is declared once', () => {
  /*
   * Order, not just membership: these two are kept in step by being read side
   * by side, and a diverged order is the cheapest signal that one was edited
   * alone. A member in only one of them is the real damage — a kind the
   * database rejects, or a row no code can name.
   */
  it('gives SurfaceKind the same members in Prisma and in the shared package', () => {
    expect(prismaEnum('SurfaceKind')).toEqual([...SURFACE_KINDS]);
  });

  it('gives SurfaceStatus the same members in both', () => {
    expect(prismaEnum('SurfaceStatus')).toEqual([...SURFACE_STATUSES]);
  });

  it('gives SurfaceOrigin the same members in both', () => {
    expect(prismaEnum('SurfaceOrigin')).toEqual([...SURFACE_ORIGINS]);
  });

  it('measures only kinds the vocabulary actually has', () => {
    // A measured kind that is not a SurfaceKind can never be emitted, so the
    // claim that the axis is measured is unfalsifiable rather than wrong.
    expect(SURFACE_KINDS).toEqual(expect.arrayContaining([...MEASURED_SURFACE_KINDS]));
  });
});

describe('measured means there is something doing the measuring', () => {
  /*
   * The pair that produces a wrong number instead of an error, which is why it
   * is the one worth a test. analyseSurfaceCoverage looks each item's kind up
   * in MATCHERS; a miss yields no matches, and no matches yields UNCOVERED. A
   * measured axis with no matcher therefore reports the customer's entire axis
   * as gaps, with the same confidence as a real gap and no error anywhere.
   */
  it('has a matcher for every measured kind', () => {
    const matchers = matcherKinds();
    const unmatched = MEASURED_SURFACE_KINDS.filter((kind) => !matchers.includes(kind));
    expect(unmatched).toEqual([]);
  });

  /*
   * The reverse costs nothing visible and is therefore easier to ship: the
   * matcher runs on every recompute, and totalsForItems sums only measured
   * axes, so nothing it finds is ever divided by anything.
   */
  it('counts every kind it has a matcher for', () => {
    const unused = matcherKinds().filter(
      (kind) => !MEASURED_SURFACE_KINDS.includes(kind as (typeof MEASURED_SURFACE_KINDS)[number]),
    );
    expect(unused).toEqual([]);
  });
});

describe('the unmeasured axes are named', () => {
  /*
   * Rule 4: an axis with no extractor is reported as unmeasured, never as 0%.
   * "We do not measure component states" is a fact about QAAI; "0% of your
   * component states are covered" is a lie about the customer's application.
   * The list that makes the difference is hand-written in missingAxes(), while
   * unmeasuredKinds() in @qaai/shared derives the same thing from the
   * vocabulary — so the hand-written one can fall behind a new kind and the
   * axis then goes unmentioned instead of unmeasured.
   *
   * Membership, not order: which order the axes are named in is cosmetic, and
   * failing a build over that would be crying wolf.
   */
  it('names exactly the axes with no extractor', () => {
    const derived = unmeasuredKinds();
    if (missingAxesIsDerived()) {
      // Derived from the vocabulary, so it names exactly those axes by
      // construction and there is nothing left for this case to check.
      expect(missingAxesIsDerived()).toBe(true);
      return;
    }
    const listed = hardcodedMissingAxes();
    expect([...listed].sort()).toEqual([...derived].sort());
  });

  it('leaves no measured axis in the unmeasured list', () => {
    if (missingAxesIsDerived()) {
      expect(missingAxesIsDerived()).toBe(true);
      return;
    }
    expect(hardcodedMissingAxes()).not.toEqual(expect.arrayContaining([...MEASURED_SURFACE_KINDS]));
  });
});

describe('check-wiring runs the guard it defines', () => {
  /*
   * The defect class check-wiring exists for, applied to check-wiring: a check
   * function that main() never calls is correct code connected to nothing, and
   * it would leave the vocabulary unguarded while the summary still said zero
   * disconnected. Read as text — see the file header for why this cannot be an
   * import.
   */
  const wiring = read(WIRING);
  const mainBody = /async function main\(\): Promise<void> \{([\s\S]*?)\n\}/.exec(wiring)?.[1];

  it('has a main() this test can read', () => {
    expect(mainBody).toBeTypeOf('string');
  });

  it.each(['checkSurfaceVocabulary', 'checkUnmeasuredAxes'])('defines and calls %s', (fn) => {
    expect(wiring).toContain(`function ${fn}(): void {`);
    expect(mainBody).toContain(`${fn}();`);
  });
});
