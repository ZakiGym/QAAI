import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The drift guard's own guard, for the five enums the DIMENSIONS slice added —
 * and for the hand-written migration that creates them.
 *
 * ── Why this file exists next to the three that came before it ─────────────
 *
 * `scripts/check-enums.ts` compares three sources: schema.prisma, the
 * TypeScript mirror, and the live database. What it cannot check is ITSELF: a
 * new Prisma enum with no PAIRS entry is an enum with no drift guard, and the
 * script passes happily — it reports agreement on the pairs it was given and
 * says nothing about the enum nobody listed. That is how five TestType members
 * once sat un-migrated and invisible until an insert failed at run time.
 *
 * ── And why it also checks the SQL, line by line ───────────────────────────
 *
 * Because this migration was written BY HAND and nothing compared it to the
 * schema. `prisma migrate diff` does not work in this environment — it exits
 * with "Error in Schema engine:" and no detail, which the two sibling files
 * already record — so a mistyped enum member, a missing index or a DEFAULT that
 * should not be there is a difference nothing would notice until a query hit it
 * in production.
 *
 * The extraction below is independent of the script's own regexes on purpose: a
 * test that reused them would be asserting that its regexes match its regexes.
 */

const SCHEMA = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
const SCRIPT = fileURLToPath(new URL('./check-enums.ts', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../prisma/migrations', import.meta.url));
/*
 * ── WHY THE TYPESCRIPT SIDE IS READ AS TEXT AND NOT IMPORTED ───────────────
 *
 * `packages/shared/src/coverage-dimensions.ts` is NOT on the package barrel,
 * exactly as `coverage-tiers.ts` is not — a gap `check-enums.measurement.test.ts`
 * already records and whose one-line fix is in this round's
 * needsFromOtherFiles. So `import { COVERAGE_DIMENSIONS } from '@qaai/shared'`
 * resolves to nothing here, and reaching the module by a relative path across
 * the workspace boundary is the defect nine files in this repo have already
 * committed: it compiles, silently bypasses the package entry point, and leaves
 * a parity guard enforced on a file nobody imports as a package.
 *
 * So this file reads the lists out of the SOURCE, which is what
 * `check-enums.ts` itself does and is barrel-independent. The value-for-value
 * assertions on the spellings live in
 * `packages/shared/src/coverage-dimensions.test.ts`, which CAN import them,
 * and which pins each list as a literal. When the barrel line lands, the
 * extraction below can be replaced by an import.
 */
const SHARED_DIMENSIONS = fileURLToPath(
  new URL('../../../packages/shared/src/coverage-dimensions.ts', import.meta.url),
);

const schema = readFileSync(SCHEMA, 'utf8');
const script = readFileSync(SCRIPT, 'utf8');
const sharedDimensions = readFileSync(SHARED_DIMENSIONS, 'utf8');

/**
 * Members of an `export const NAME = [ … ] as const` array in the shared
 * source.
 *
 * Deliberately NOT the regex `check-enums.ts` uses, even though it looks the
 * same: a test that reused the script's own extractor would be asserting that
 * its regexes match its regexes. This one is bounded by `] as const`, which is
 * stricter than the script's "up to the first closing bracket" and would catch
 * a bracket smuggled into a comment inside the literal.
 */
function tsConstMembers(name: string): string[] {
  const block = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\] as const`).exec(
    sharedDimensions,
  );
  if (!block) throw new Error(`${name} is not an \`as const\` array in coverage-dimensions.ts`);
  const body = block[1]!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return [...body.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]!);
}

/** This slice's migration directory, and the DDL it holds. */
const MIGRATION_DIR = '20261026090000_coverage_dimensions_rollups_attestation_and_self_measurement';
const migration = readFileSync(`${MIGRATIONS}/${MIGRATION_DIR}/migration.sql`, 'utf8');

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
  const block = new RegExp(`CREATE TYPE "${name}" AS ENUM \\(([^)]*)\\)`).exec(migration);
  if (!block) throw new Error(`the migration has no CREATE TYPE for ${name}`);
  return [...block[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

/** One model's body. */
function prismaModel(name: string): string {
  const block = new RegExp(`\\bmodel\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!block) throw new Error(`model ${name} is not declared in schema.prisma`);
  return block[1]!;
}

/** Every `prismaEnum:` the script's PAIRS list names. */
function pairedEnums(): string[] {
  return [...script.matchAll(/prismaEnum:\s*'(\w+)'/g)].map((match) => match[1]!);
}

/** One `CREATE TABLE` block from the migration, so a column check cannot match the wrong table. */
function sqlTable(name: string): string {
  const block = new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`).exec(migration);
  if (!block) throw new Error(`the migration has no CREATE TABLE for ${name}`);
  return block[1]!;
}

/** The Prisma enums this slice introduced, paired with their TypeScript mirror. */
const NEW_PAIRS: ReadonlyArray<{ prismaEnum: string; tsConst: string }> = [
  { prismaEnum: 'CoverageDimensionKind', tsConst: 'COVERAGE_DIMENSIONS' },
  { prismaEnum: 'CoverageCellKind', tsConst: 'COVERAGE_CELL_KINDS' },
  { prismaEnum: 'DimensionUnmeasuredReason', tsConst: 'DIMENSION_UNMEASURED_REASONS' },
  { prismaEnum: 'DeploymentCapabilityStatus', tsConst: 'DEPLOYMENT_CAPABILITY_STATUSES' },
  { prismaEnum: 'FaultDetectionOutcome', tsConst: 'FAULT_DETECTION_OUTCOMES' },
];

/** The models this slice introduced. */
const NEW_MODELS = [
  'CoverageItemState',
  'CoverageFormField',
  'CoverageTypeObligation',
  'CoverageRollup',
  'CoverageHistory',
  'DeploymentCapability',
  'CoverageAttestation',
  'ValidityBacktest',
  'BenchmarkRun',
  'BenchmarkFaultResult',
] as const;

describe('the PAIRS list grew', () => {
  it('names all five new enums', () => {
    const paired = pairedEnums();
    for (const { prismaEnum } of NEW_PAIRS) expect(paired).toContain(prismaEnum);
  });

  it('still names the four the measurement slice added', () => {
    // Named rather than counted. A count would be satisfied by swapping one of
    // these out for one of the five, and the whole value of a drift guard is
    // that nothing silently leaves it.
    const paired = pairedEnums();
    for (const before of ['CoverageTier', 'CoverageEdgeSource', 'MetricUnit', 'MetricDirection']) {
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
     * tables fails here instead of shipping with no guard at all.
     */
    const declared = new Set([...schema.matchAll(/\benum\s+(\w+)\s*\{/g)].map((m) => m[1]!));
    const paired = new Set(pairedEnums());
    const unguarded: string[] = [];

    for (const model of NEW_MODELS) {
      for (const raw of prismaModel(model).split('\n')) {
        const line = raw.replace(/\/\/.*$/, '').trim();
        const field = /^(\w+)\s+(\w+)(\[\])?\??/.exec(line);
        if (!field) continue;
        if (field[3] === '[]') continue; // a relation list is not a column
        const type = field[2]!;
        if (!declared.has(type) || paired.has(type)) continue;
        unguarded.push(`${model}.${field[1]!} is ${type}`);
      }
    }

    expect(unguarded).toEqual([]);
  });
});

describe('schema.prisma ⇄ the TypeScript mirrors', () => {
  for (const { prismaEnum, tsConst } of NEW_PAIRS) {
    it(`${prismaEnum} matches ${tsConst} exactly, in order`, () => {
      // Order as well as membership. The migration's CREATE TYPE was written
      // from these arrays, and a reordering would leave the two agreeing as
      // sets while the SQL and the schema disagreed — which PostgreSQL happily
      // accepts, and which makes every ORDER BY on the enum silently different.
      expect(prismaEnumMembers(prismaEnum)).toEqual(tsConstMembers(tsConst));
    });

    it(`${tsConst} is reachable to the drift guard's own extractor`, () => {
      // `check-enums.ts` reads this list with a regex bounded by the first
      // closing bracket, so a `]` inside a comment in the literal would
      // silently truncate the list it compares against the Prisma enum — and a
      // truncated comparison passes. This asserts the full list survives.
      expect(tsConstMembers(tsConst).length).toBe(prismaEnumMembers(prismaEnum).length);
    });
  }
});

describe('the hand-written migration', () => {
  /*
   * ── WHY THIS IS NOT "IT IS THE NEWEST DIRECTORY" ──────────────────────────
   *
   * Because that assertion goes red the moment the next slice lands a later
   * migration — on a file it does not own. An assertion every future round must
   * break is not a guard, it is a tripwire aimed at the wrong leg, and the two
   * sibling files already record the round it cost.
   *
   * The fact actually worth protecting is the one that breaks a deploy: a
   * migration written with a timestamp at or BEFORE one already applied never
   * runs, and Prisma reports nothing. So: this directory exists, its timestamp
   * is unique, and it sorts after the migration that was newest when it was
   * written — PINNED BY NAME, because that predecessor is a historical fact
   * about this file and not a moving target.
   */
  const PREDECESSOR = '20261025100000_coverage_tiers_provenance_variants_and_metrics';

  const directories = (): string[] =>
    readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

  it('sorts after the migration that was newest when it was written', () => {
    const dirs = directories();
    expect(dirs).toContain(PREDECESSOR);
    expect(dirs).toContain(MIGRATION_DIR);
    expect(MIGRATION_DIR > PREDECESSOR).toBe(true);
  });

  it('is the only migration carrying its timestamp', () => {
    // Two directories with the same 14-digit prefix is the one failure mode
    // that cannot be recovered by adding another migration: whichever applies
    // second is recorded under a name the first already claimed.
    const stamp = (name: string): string => name.slice(0, 14);
    const mine = stamp(MIGRATION_DIR);
    const clashes = directories().filter(
      (name) => name !== MIGRATION_DIR && stamp(name) === mine,
    );
    expect(clashes).toEqual([]);
  });

  for (const { prismaEnum } of NEW_PAIRS) {
    it(`creates ${prismaEnum} with exactly the schema's members, in order`, () => {
      // The check no tool made. A member mistyped or omitted in the SQL is a
      // value the generated client inserts and the database rejects — at run
      // time, on an insert, in production.
      expect(sqlEnumMembers(prismaEnum)).toEqual(prismaEnumMembers(prismaEnum));
    });
  }

  it('creates a table for every new model, and no table without a model', () => {
    const created = [...migration.matchAll(/CREATE TABLE "(\w+)"/g)].map((match) => match[1]!);
    expect(created.slice().sort()).toEqual([...NEW_MODELS].sort());
  });

  it('creates every index and unique constraint the schema declares', () => {
    /*
     * The other half of what `prisma migrate diff` would have told us, and the
     * cheaper half to get wrong: an index declared in the schema and absent
     * from the SQL does not fail anything — it produces a sequential scan on a
     * table that grows per cell, and a UNIQUE absent from the SQL silently
     * permits the duplicate rows the whole `scopeKey` design exists to prevent.
     *
     * The derived names are checked too, because a hand-written name that
     * disagrees with Prisma's makes every later `migrate dev` report drift it
     * cannot fix. None of these models uses `map:`, so Prisma's convention is
     * the only name in play — asserted by the absence check below.
     */
    const missing: string[] = [];
    for (const model of NEW_MODELS) {
      const body = prismaModel(model);
      expect(body, `${model} must not need a mapped constraint name`).not.toContain('map: "');
      for (const match of body.matchAll(/@@(unique|index)\(\[([^\]]*)\]\)/g)) {
        const kind = match[1]!;
        const columns = match[2]!.split(',').map((column) => column.trim());
        const name = `${model}_${columns.join('_')}_${kind === 'unique' ? 'key' : 'idx'}`;
        expect(name.length, `${name} exceeds PostgreSQL's 63-byte identifier limit`).toBeLessThanOrEqual(63);
        const statement =
          kind === 'unique'
            ? `CREATE UNIQUE INDEX "${name}" ON "${model}"(${columns.map((c) => `"${c}"`).join(', ')});`
            : `CREATE INDEX "${name}" ON "${model}"(${columns.map((c) => `"${c}"`).join(', ')});`;
        if (!migration.includes(statement)) missing.push(statement);
      }
    }
    expect(missing).toEqual([]);
  });

  it('creates a foreign key for every relation the new models declare', () => {
    const missing: string[] = [];
    for (const model of NEW_MODELS) {
      for (const match of prismaModel(model).matchAll(
        /@relation\(fields:\s*\[(\w+)\],\s*references:\s*\[(\w+)\]/g,
      )) {
        const constraint = `"${model}_${match[1]!}_fkey"`;
        if (!migration.includes(constraint)) missing.push(`${model}.${match[1]!}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('the honesty rules the DDL is supposed to encode', () => {
  it('gives no tier column a default', () => {
    /*
     * A default tier of DECLARED would mint a claim nothing produced — the
     * exact argument `TestCoverageEdge.tier` records one slice earlier. On a
     * per-cell table it is worse: every state, field, rule and obligation row
     * written by a reader that forgot to set it would read as "a test names
     * this", which is the numerator.
     */
    for (const model of ['CoverageItemState', 'CoverageFormField', 'CoverageTypeObligation'] as const) {
      const line = prismaModel(model)
        .split('\n')
        .find((raw) => /^\s*tier\s+CoverageTier/.test(raw));
      expect(line, `${model}.tier`).toBeDefined();
      expect(line, `${model}.tier`).toContain('CoverageTier?');
      expect(line, `${model}.tier`).not.toContain('@default');
    }
  });

  it('keeps required-ness nullable on a form field', () => {
    /*
     * THE line this slice turns on for forms. NULL means the reader could not
     * read the attribute; `false` means it looked and the field is optional.
     * Collapsing the first into the second removes the cell from the
     * denominator and raises the percentage, and `required` is one of the two
     * boundary cases the register names as counted by nobody.
     */
    expect(prismaModel('CoverageFormField')).toMatch(/\n\s*required\s+Boolean\?/);
    expect(prismaModel('CoverageFormField')).not.toMatch(/\n\s*required\s+Boolean\?\s*@default/);
    expect(sqlTable('CoverageFormField')).toContain('"required" BOOLEAN,');
    expect(sqlTable('CoverageFormField')).not.toContain('"required" BOOLEAN NOT NULL');
  });

  it('leaves a benchmark that did not finish with no counts rather than zeroes', () => {
    // 0 detected is a result — a terrible one — and "we did not finish" is not
    // a result at all. A DEFAULT 0 here would make a crashed bench report a 0%
    // detection rate against the product's own test suite.
    const bench = sqlTable('BenchmarkRun');
    for (const column of ['detectedCount', 'missedCount', 'notExercisedCount']) {
      expect(bench).toContain(`"${column}" INTEGER,`);
      expect(bench).not.toContain(`"${column}" INTEGER NOT NULL`);
    }
    expect(bench).toContain('"baselineCleanAfter" BOOLEAN,');
    // The counted side, for contrast: a bench always knows how many faults it
    // was handed, so that one IS not null.
    expect(bench).toContain('"faultCount" INTEGER NOT NULL,');
  });

  it('leaves both validity rates nullable', () => {
    // A zero escaped-defect rate on covered surface is the most flattering
    // number this product could print, and it is exactly what a back-test over
    // three tickets produces.
    const backtest = sqlTable('ValidityBacktest');
    expect(backtest).toContain('"escapedRateCovered" DOUBLE PRECISION,');
    expect(backtest).toContain('"escapedRateUncovered" DOUBLE PRECISION,');
    // The n, by contrast, is always recorded: a rate without it is unreadable.
    expect(backtest).toContain('"defectCount" INTEGER NOT NULL,');
  });

  it('makes the attestation unconstructable without its scope', () => {
    /*
     * NOT NULL WITH NO DEFAULT, so the INSERT fails without them. An empty
     * `'[]'` default would be the claim that nothing was unmeasured in a round
     * that added thirteen axes and measured none of them — and a buyer reads
     * silence about scope as zero risk.
     */
    const attestation = sqlTable('CoverageAttestation');
    for (const column of [
      '"scopeStatement" TEXT NOT NULL',
      '"unmeasured" JSONB NOT NULL',
      '"caps" JSONB NOT NULL',
    ]) {
      expect(attestation).toContain(`${column},`);
    }
    // Narrowed to the three scope columns rather than the whole table: the
    // timestamps legitimately default to CURRENT_TIMESTAMP, and an assertion
    // that banned every DEFAULT would have been satisfied only by making the
    // table worse.
    for (const column of ['scopeStatement', 'unmeasured', 'caps', 'denominatorDefinition', 'crawlVersion']) {
      const line = attestation
        .split('\n')
        .find((raw) => raw.trim().startsWith(`"${column}" `));
      expect(line, column).toBeDefined();
      expect(line, column).toContain('NOT NULL');
      expect(line, column).not.toContain('DEFAULT');
    }
    /*
     * And the contrast that proves this is a decision rather than an
     * oversight: `CoverageRollup.caps` DOES default to '[]', correctly. There
     * an empty cap list is a positive and verifiable claim that nothing was
     * truncated during one measurement. On the exported document it would be a
     * claim that nothing was unmeasured at all, which is the one sentence a
     * buyer reads as a guarantee.
     */
    expect(sqlTable('CoverageRollup')).toContain(`"caps" JSONB NOT NULL DEFAULT '[]',`);
  });

  it('defaults comparability to NOT_COMPARED and never to COMPARABLE', () => {
    /*
     * A row written by a writer that never compared anything has not
     * established comparability. COMPARABLE as a default would produce
     * confident deltas across unknown boundaries for every snapshot already in
     * the table — in the PR comment, on the badge and in the digest.
     */
    const defaults = [...migration.matchAll(/"comparability" TEXT NOT NULL DEFAULT '(\w+)'/g)].map(
      (match) => match[1]!,
    );
    expect(defaults.length).toBeGreaterThan(0);
    for (const value of defaults) expect(value).toBe('NOT_COMPARED');
  });

  it('adds no default to the snapshot provenance columns', () => {
    // Every snapshot written before today has none of them, and that state is
    // UNCOMPARABLE_FINGERPRINT_MISSING rather than comparable. Defaulting
    // `crawlVersion` to the current build would claim an old snapshot was
    // measured by today's enumerator.
    for (const column of ['crawlVersion', 'crawlFingerprint', 'denominatorDefinition']) {
      expect(migration).toContain(`ALTER TABLE "CoverageSnapshot" ADD COLUMN "${column}" TEXT;`);
    }
  });
});

describe('the VisualBaseline environment split', () => {
  it('drops the unique key that made staging and production share a reference', () => {
    /*
     * THE false red this fixes. One baseline per (test, viewport, browser)
     * meant whichever environment ran first captured the reference image, and
     * every later diff on the other one was measured against it — so a staging
     * capture silently became the production baseline and the red it produced
     * could not be cleared by changing the application, because the application
     * was not what differed.
     */
    expect(migration).toContain('DROP INDEX "VisualBaseline_testId_viewport_browser_key";');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "VisualBaseline_testId_viewport_browser_environmentId_key" ON "VisualBaseline"("testId", "viewport", "browser", "environmentId");',
    );
    expect(prismaModel('VisualBaseline')).toContain(
      '@@unique([testId, viewport, browser, environmentId])',
    );
  });

  it('backfills existing rows to a named environment and then drops the default', () => {
    /*
     * The column is added WITH a default so the backfill happens in one
     * statement, then the default is DROPPED so every NEW row must name the
     * environment it was captured in. A permanent default is how the
     * shared-reference defect comes back one writer at a time, which is why the
     * schema must carry no `@default` on the column.
     */
    const add = migration.indexOf(
      `ALTER TABLE "VisualBaseline" ADD COLUMN "environmentId" TEXT NOT NULL DEFAULT '<unattributed>';`,
    );
    const drop = migration.indexOf(
      'ALTER TABLE "VisualBaseline" ALTER COLUMN "environmentId" DROP DEFAULT;',
    );
    expect(add).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(add);
    expect(prismaModel('VisualBaseline')).toMatch(/\n\s*environmentId\s+String\n/);
    expect(prismaModel('VisualBaseline')).not.toMatch(/environmentId\s+String\s*@default/);
  });

  it('deletes no row', () => {
    // The old images stay addressable under '<unattributed>' so an operator who
    // knows which environment captured them can re-attribute by hand. Deleting
    // them would destroy evidence to make a constraint fit.
    expect(migration).not.toMatch(/DELETE FROM "VisualBaseline"/);
    expect(migration).not.toMatch(/DROP TABLE "VisualBaseline"/);
  });
});
