import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HEAL_STATES, NOT_RUN_KINDS } from '@qaai/shared';
import { describe, expect, it } from 'vitest';

/**
 * Prisma-enum parity for the two mirrors `check:enums` does not currently
 * cover, plus the one column property that is the whole point of the newest
 * migration.
 *
 * ── Why this is a test and not two more PAIRS entries ───────────────────────
 *
 * `scripts/check-enums.ts` is the right home for a drift guard and it is where
 * `NotRunKind` now lives. `HealState` is NOT in its PAIRS list, deliberately,
 * and the reason is written out there: the static halves agree today, but
 * `HealState.SUPERSEDED` was added by migration
 * 20261024050000_heal_lifecycle_enum_values and that migration has not been
 * deployed, so the script's third check — the live database — fails for a
 * reason no code change can fix. A red check with no available remedy is a
 * check people start skipping.
 *
 * That left `HEAL_STATES` with no guard of any kind, which is worse than the
 * noise. This file is the half that CAN run anywhere: schema.prisma and the
 * TypeScript mirror, compared with no database in the loop. It is additive to
 * `check:enums` rather than a replacement — it cannot see the live enum, and
 * the live enum is the one that broke last time.
 *
 * The script is not imported here. It is a top-level-await program that calls
 * `process.exit(1)`, so importing it would end the test run; and a test that
 * reused its regexes would be asserting that its regexes match its regexes.
 * The extraction below is deliberately independent.
 */

const SCHEMA = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
const schema = readFileSync(SCHEMA, 'utf8');

/** Members of a Prisma enum block, with `///` docs and `//` comments stripped. */
function prismaEnumMembers(name: string): string[] {
  const block = new RegExp(`\\benum\\s+${name}\\s*\\{([^}]*)\\}`).exec(schema);
  if (!block) throw new Error(`enum ${name} is not declared in schema.prisma`);
  return block[1]!
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line));
}

/** One model's body, so a field can be asserted on without matching the file. */
function prismaModel(name: string): string {
  const block = new RegExp(`\\bmodel\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!block) throw new Error(`model ${name} is not declared in schema.prisma`);
  return block[1]!;
}

/** The declaration line for one field, comments excluded. */
function prismaField(model: string, field: string): string {
  const line = prismaModel(model)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => new RegExp(`^${field}\\s+`).test(l));
  if (!line) throw new Error(`${model}.${field} is not declared in schema.prisma`);
  return line;
}

describe('NotRunKind', () => {
  it('matches NOT_RUN_KINDS exactly, in order', () => {
    // Order is asserted as well as membership: `NOT_RUN_KINDS` is the array the
    // migration's CREATE TYPE was written from, and a reordering would make the
    // two agree as sets while the SQL and the schema disagreed.
    expect(prismaEnumMembers('NotRunKind')).toEqual([...NOT_RUN_KINDS]);
  });

  it('is four members — not a fifth for "not recorded"', () => {
    // NULL is the fifth state and it must stay OUT of the enum. A member named
    // UNKNOWN or NOT_RECORDED would be a value a writer could choose, and
    // "nothing was recorded" is not a choice anybody makes.
    expect(prismaEnumMembers('NotRunKind')).toHaveLength(4);
  });
});

describe('TestResult.notRunKind', () => {
  const field = prismaField('TestResult', 'notRunKind');

  it('is the enum type and is OPTIONAL', () => {
    expect(field).toMatch(/^notRunKind\s+NotRunKind\?/);
  });

  it('carries NO default', () => {
    // The load-bearing property, twice over. A `@default(NOT_RUN)` would write
    // a claim — "nothing was attempted" — onto every historical row in one
    // statement, and it would rewrite the largest table in the product to do
    // it. Nullable-with-no-default is a catalogue-only change.
    expect(field).not.toContain('@default');
  });

  it('is not indexed yet, so the migration and the schema agree', () => {
    // The migration says no index is added and says why (it would be a
    // 99%-dead btree built under ACCESS EXCLUSIVE). If one is added here
    // without a migration, Prisma's drift detection will complain at deploy
    // time rather than at review time, which is later and more expensive.
    expect(prismaModel('TestResult')).not.toMatch(/@@index\(\[[^\]]*notRunKind/);
  });
});

describe('HealState', () => {
  it('matches HEAL_STATES exactly, in order', () => {
    expect(prismaEnumMembers('HealState')).toEqual([...HEAL_STATES]);
  });

  it('includes SUPERSEDED, which the supersede planner writes', () => {
    // Spelled out because this is the member an omission would hide: every
    // other state is also written by a route that a route test covers, while
    // SUPERSEDED is written by `planSupersede` in packages/agent/src/healer.ts
    // and compared against `OPEN_HEAL_STATES`, which was `readonly string[]`.
    expect(HEAL_STATES).toContain('SUPERSEDED');
    expect(prismaEnumMembers('HealState')).toContain('SUPERSEDED');
  });
});

describe('HealRisk', () => {
  it('has RETIRE, which HealProposal.riskLevel now names', () => {
    // `HealProposal.riskLevel` in @qaai/shared gained 'RETIRE' because the
    // Prisma enum had it and the union did not — so the one risk level that is
    // not a patch at all was a value the database accepted and TypeScript
    // could not name. This asserts the direction that was wrong.
    expect(prismaEnumMembers('HealRisk')).toContain('RETIRE');
  });
});
