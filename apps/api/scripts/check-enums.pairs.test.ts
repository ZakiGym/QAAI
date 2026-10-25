import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ACCEPTANCE_CRITERION_FORMATS,
  API_AUTH_DECLARATIONS,
  API_OPERATION_VERIFICATIONS,
  COMPONENT_ITEM_KINDS,
  COMPONENT_STATE_KINDS,
  MANUAL_TEST_AUTOMATION_STATUSES,
  REQUIREMENT_LINK_METHODS,
  REQUIREMENT_LINK_STATES,
  REQUIREMENT_STATUSES,
  SPEC_SOURCE_SYSTEMS,
} from '@qaai/shared';
import { describe, expect, it } from 'vitest';

/**
 * The drift guard's own guard, for the ten enums the non-crawl enumeration
 * sources added — and for the hand-written migration that creates them.
 *
 * ── Why this file exists next to check-enums.test.ts ───────────────────────
 *
 * `scripts/check-enums.ts` compares three sources: schema.prisma, the
 * TypeScript mirror, and the live database. It is the right home for the
 * comparison and it now holds all ten pairs. What it cannot check is ITSELF: a
 * new Prisma enum with no PAIRS entry is an enum with no drift guard, and the
 * script passes happily — it reports agreement on the pairs it was given and
 * says nothing about the enum nobody listed. That is how five TestType members
 * once sat un-migrated and invisible until an insert failed at run time, and it
 * is the exact failure mode a ten-enum change can reintroduce ten times over.
 *
 * ── And why it also checks the migration ───────────────────────────────────
 *
 * Because the migration for these enums was written BY HAND. Prisma's schema
 * engine is not usable in this environment — `prisma migrate diff` errors out —
 * so no tool compared the SQL against the schema, and a mistyped or omitted
 * enum member in a `CREATE TYPE` is a value the Prisma client will generate
 * queries for and the database will reject. It fails at run time, on an insert,
 * in production, which is the latest and most expensive place to find out.
 *
 * The script is not imported, for the reason check-enums.test.ts already
 * records: it is a top-level-await program that calls `process.exit(1)`, so
 * importing it would end the test run. The extraction below is independent of
 * its regexes on purpose — a test that reused them would be asserting that its
 * regexes match its regexes.
 */

const SCHEMA = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
const SCRIPT = fileURLToPath(new URL('./check-enums.ts', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

const schema = readFileSync(SCHEMA, 'utf8');
const script = readFileSync(SCRIPT, 'utf8');

/** This round's migration directory, and the enum DDL it holds. */
const MIGRATION_DIR = '20261024090000_requirements_api_and_component_surface';
const migration = readFileSync(`${MIGRATIONS}/${MIGRATION_DIR}/migration.sql`, 'utf8');

/**
 * The executable half of the migration.
 *
 * Load-bearing: the revert instructions at the bottom are a commented-out
 * mirror image of everything above, so a test that searched the whole file
 * would find `DROP TABLE "Requirement"` and `CREATE TABLE` alike and could be
 * satisfied by the comments alone.
 */
const executable = migration.split('-- REVERSING THIS')[0] ?? '';

/** Members of a Prisma enum block, with `///` docs and `//` comments stripped. */
function prismaEnumMembers(name: string): string[] {
  const block = new RegExp(`\\benum\\s+${name}\\s*\\{([^}]*)\\}`).exec(schema);
  if (!block) throw new Error(`enum ${name} is not declared in schema.prisma`);
  return block[1]!
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line));
}

/** Members of a `CREATE TYPE "X" AS ENUM (...)` in the migration, in order. */
function sqlEnumMembers(name: string): string[] {
  const block = new RegExp(`CREATE TYPE "${name}" AS ENUM \\(([^)]*)\\)`).exec(executable);
  if (!block) throw new Error(`the migration has no CREATE TYPE for ${name}`);
  return [...block[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

/** Every `prismaEnum:` the script's PAIRS list names. */
function pairedEnums(): string[] {
  return [...script.matchAll(/prismaEnum:\s*'(\w+)'/g)].map((match) => match[1]!);
}

/** The Prisma enums this round introduced, paired with their TypeScript mirror. */
const NEW_PAIRS: ReadonlyArray<{ prismaEnum: string; members: readonly string[] }> = [
  { prismaEnum: 'SpecSourceSystem', members: SPEC_SOURCE_SYSTEMS },
  { prismaEnum: 'RequirementStatus', members: REQUIREMENT_STATUSES },
  { prismaEnum: 'AcceptanceCriterionFormat', members: ACCEPTANCE_CRITERION_FORMATS },
  { prismaEnum: 'RequirementLinkMethod', members: REQUIREMENT_LINK_METHODS },
  { prismaEnum: 'RequirementLinkState', members: REQUIREMENT_LINK_STATES },
  { prismaEnum: 'ManualTestAutomationStatus', members: MANUAL_TEST_AUTOMATION_STATUSES },
  { prismaEnum: 'ApiAuthDeclaration', members: API_AUTH_DECLARATIONS },
  { prismaEnum: 'ApiOperationVerification', members: API_OPERATION_VERIFICATIONS },
  { prismaEnum: 'ComponentItemKind', members: COMPONENT_ITEM_KINDS },
  { prismaEnum: 'ComponentStateKind', members: COMPONENT_STATE_KINDS },
];

/** The models this round introduced. */
const NEW_MODELS = [
  'Requirement',
  'AcceptanceCriterion',
  'RequirementLink',
  'ManualTestCase',
  'ApiOperation',
  'ApiOperationProbe',
  'ComponentItem',
  'ComponentState',
  'TrafficIngest',
  'ObservedJourney',
] as const;

describe('the PAIRS list grew', () => {
  it('names all ten new enums', () => {
    const paired = pairedEnums();
    for (const { prismaEnum } of NEW_PAIRS) expect(paired).toContain(prismaEnum);
  });

  it('still names the thirteen that were there before', () => {
    // Named rather than counted. A count would be satisfied by swapping one of
    // these out for one of the ten, and the whole value of a drift guard is
    // that nothing silently leaves it.
    const paired = pairedEnums();
    for (const before of [
      'TestType',
      'Verdict',
      'Language',
      'RunShardStatus',
      'BillingState',
      'WebhookDeliveryStatus',
      'SsoProtocol',
      'RunnerJobStatus',
      'NotRunKind',
      'SurfaceSource',
      'SurfaceExercisability',
      'SurfaceDimensionKind',
      'CrawlAcceptanceState',
    ]) {
      expect(paired).toContain(before);
    }
  });

  it('lists each enum exactly once', () => {
    const paired = pairedEnums();
    expect(paired).toEqual([...new Set(paired)]);
  });

  it('pairs every enum the ten new models store', () => {
    /*
     * THE DURABLE HALF, and the one that catches the next person rather than
     * this change. It reads the enum-typed columns out of the new models and
     * demands a PAIRS entry for each, so an eleventh enum added to any of these
     * tables fails here instead of shipping with no guard at all. The ten
     * assertions above pin this round; this one pins the rule.
     */
    const declared = new Set(
      [...schema.matchAll(/\benum\s+(\w+)\s*\{/g)].map((match) => match[1]!),
    );
    const paired = new Set(pairedEnums());
    const unguarded: string[] = [];

    for (const model of NEW_MODELS) {
      const block = new RegExp(`\\bmodel\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(schema);
      expect(block, `model ${model} is not declared in schema.prisma`).not.toBeNull();
      for (const raw of block![1]!.split('\n')) {
        const line = raw.replace(/\/\/.*$/, '').trim();
        const field = /^(\w+)\s+(\w+)(\[\])?\??/.exec(line);
        if (!field) continue;
        const type = field[2]!;
        if (field[3] === '[]') continue; // a relation list is not a column
        if (!declared.has(type) || paired.has(type)) continue;
        unguarded.push(`${model}.${field[1]!} is ${type}`);
      }
    }

    expect(unguarded).toEqual([]);
  });
});

describe('schema.prisma ⇄ the TypeScript mirrors', () => {
  for (const { prismaEnum, members } of NEW_PAIRS) {
    it(`${prismaEnum} matches its mirror exactly, in order`, () => {
      // Order as well as membership. The migration's CREATE TYPE was written
      // from these arrays, and a reordering would leave the two agreeing as
      // sets while the SQL and the schema disagreed — which PostgreSQL happily
      // accepts, and which makes every ORDER BY on the enum silently different.
      expect(prismaEnumMembers(prismaEnum)).toEqual([...members]);
    });
  }
});

describe('the hand-written migration', () => {
  it('carries a timestamp later than every existing migration', () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs.at(-1)).toBe(MIGRATION_DIR);
  });

  for (const { prismaEnum } of NEW_PAIRS) {
    it(`creates ${prismaEnum} with exactly the schema's members, in order`, () => {
      // The check no tool made. `prisma migrate diff` cannot run here, so a
      // member mistyped or omitted in the SQL would be a value the generated
      // client inserts and the database rejects — at run time, on an insert.
      expect(sqlEnumMembers(prismaEnum)).toEqual(prismaEnumMembers(prismaEnum));
    });
  }

  it('creates a table for every new model, and no table without a model', () => {
    const created = [...executable.matchAll(/CREATE TABLE "(\w+)"/g)].map((match) => match[1]!);
    expect(created.slice().sort()).toEqual([...NEW_MODELS].sort());
  });

  it('names the five-column unique on RequirementLink explicitly', () => {
    /*
     * Prisma's generated name would be
     * `RequirementLink_requirementId_criterionId_testId_coverageItemId_method_key`,
     * which is 74 bytes. PostgreSQL silently TRUNCATES identifiers at 63, so
     * the hand-written DDL and Prisma's introspection would disagree about the
     * constraint's name for ever and every later `migrate dev` would report
     * drift it could not fix. Both halves are asserted — the `map:` and the
     * SQL — because either one alone is a name that agrees with nothing.
     */
    const generated =
      'RequirementLink_requirementId_criterionId_testId_coverageItemId_method_key';
    expect(generated.length).toBeGreaterThan(63);
    expect(schema).toContain('map: "RequirementLink_claim_key"');
    expect(executable).toContain('CREATE UNIQUE INDEX "RequirementLink_claim_key"');
  });

  it('adds no column to any pre-existing table', () => {
    // The migration's own "APPLYING THIS ON A LIVE DATABASE" section claims it
    // is catalogue-only: ten CREATE TYPEs and ten CREATE TABLEs on empty
    // relations, with no rewrite anywhere. An ALTER TABLE … ADD COLUMN that
    // crept in later would make that paragraph false, and a doc comment that
    // contradicts the code under it is one of the lies this product cannot
    // afford.
    expect(executable).not.toMatch(/ALTER TABLE "\w+" ADD COLUMN/);
  });
});
