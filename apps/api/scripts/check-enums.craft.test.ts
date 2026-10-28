import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The drift guard's own guard for the five enums the CRAFT round added, the two
 * columns it put on `Project`, and the hand-written migration that creates
 * them.
 *
 * ── Why a fifth file beside the other four ─────────────────────────────────
 *
 * `check-enums.pairs.test.ts` pins the requirements round,
 * `check-enums.auth-and-access.test.ts` the auth round,
 * `check-enums.measurement.test.ts` the measurement round and
 * `check-enums.dimensions.test.ts` the dimension round; each names its own
 * migration directory and asserts facts about that SQL. Adding a fifth round's
 * assertions to any of them would make one file responsible for two migrations
 * and leave no obvious place for the sixth. The durable, round-independent
 * assertion all of them carry — "pair every enum the new models store" — is
 * repeated here against THIS round's models for the same reason: it is the one
 * that catches the next person rather than this change, and it is how
 * `TestResultStatus` and `AuthProfileKind` were both found.
 *
 * ── Why the TypeScript mirrors are not compared here ───────────────────────
 *
 * `ARTIFACT_ROLES` and the other four live in
 * packages/shared/src/artifact-set.ts, which the package barrel does not
 * re-export yet (that line belongs to a file this round's keystone does not
 * own) — so from this workspace they are reachable only by deep-importing
 * another workspace's source, which this repo does not do. The same situation
 * `coverage-tiers.ts` was in, with the same resolution: the static
 * schema.prisma ⇄ artifact-set.ts parity is enforced by `check-enums.ts`
 * itself, which this file proves NAMES all five; the value-for-value parity
 * against the zod schemas is in packages/shared/src/artifact-set.test.ts; and
 * the SQL is checked against schema.prisma below. Once the barrel exports
 * artifact-set.ts, the five can be folded in here directly.
 *
 * The script is not imported, for the reason check-enums.test.ts records: it is
 * a top-level-await program that calls `process.exit(1)`, so importing it would
 * end the test run. The extraction below is independent of its regexes on
 * purpose — a test that reused them would be asserting that its regexes match
 * its regexes.
 */

const SCHEMA = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
const SCRIPT = fileURLToPath(new URL('./check-enums.ts', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

const schema = readFileSync(SCHEMA, 'utf8');
const script = readFileSync(SCRIPT, 'utf8');

/** This round's migration directory, and the newest one that preceded it. */
const MIGRATION_DIR = '20261027150000_artifact_sets_corrections_proposals_and_style';
const PREVIOUS_NEWEST = '20261027120000_deployment_browser_capability';
const migration = readFileSync(`${MIGRATIONS}/${MIGRATION_DIR}/migration.sql`, 'utf8');

/**
 * The executable half of the migration: every comment line removed.
 *
 * Doubly load-bearing, as the measurement round paid a failure to learn. The
 * revert instructions at the bottom are a commented-out mirror image of
 * everything above, so a search of the whole file can be satisfied by the
 * rollback — and the HEADER quotes its own DDL in prose, so an "exactly two
 * columns" assertion would count the paragraph that names them.
 */
const executable = migration
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

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
  // Read from the array itself and not from the whole file: the
  // deliberate-omission notes quote the shape of a PAIRS entry inside a block
  // comment, so `HealState` and `AuthProfileKind` would both appear guarded.
  const list = /const PAIRS:[\s\S]*?\n\];/.exec(script);
  if (!list) throw new Error('the PAIRS array could not be located in check-enums.ts');
  return [...list[0].matchAll(/prismaEnum:\s*'(\w+)'/g)].map((match) => match[1]!);
}

/** The body of one model block in schema.prisma. */
function modelBody(model: string): string {
  const block = new RegExp(`\\bmodel\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!block) throw new Error(`model ${model} is not declared in schema.prisma`);
  return block[1]!;
}

/** The five Prisma enums this round introduced. */
const NEW_PAIRS = [
  'ArtifactRole',
  'ArtifactOwnership',
  'CorrectionKind',
  'SuiteChangeKind',
  'SuiteChangeState',
] as const;

/** The models this round introduced. */
const NEW_MODELS = ['GeneratedArtifact', 'TestCorrection', 'SuiteChangeProposal'] as const;

describe('the PAIRS list grew', () => {
  it('names all five new enums', () => {
    const paired = pairedEnums();
    for (const prismaEnum of NEW_PAIRS) expect(paired).toContain(prismaEnum);
  });

  it('still names the ones that were there before', () => {
    // Named rather than counted. A count would be satisfied by swapping one of
    // these out for one of the five, and the whole value of a drift guard is
    // that nothing silently leaves it.
    const paired = pairedEnums();
    for (const before of [
      'TestType',
      'TestResultStatus',
      'Verdict',
      'Language',
      'MatrixCellStatus',
      'UnassertedReason',
      'CoverageTier',
      'CoverageEdgeSource',
      'PrincipalKind',
      'PrincipalLifecycle',
      'DeploymentCapabilityStatus',
      'FaultDetectionOutcome',
    ]) {
      expect(paired).toContain(before);
    }
  });

  it('lists each enum exactly once', () => {
    const paired = pairedEnums();
    expect(paired).toEqual([...new Set(paired)]);
  });

  it('pairs every enum the three new models store', () => {
    /*
     * THE DURABLE HALF, and the one that catches the next person rather than
     * this change. It reads the enum-typed columns out of the new models and
     * demands a PAIRS entry for each, so a sixth enum added to any of these
     * tables fails here instead of shipping with no guard at all. That
     * mechanism is how `TestResultStatus` — the enum the whole product's
     * pass/fail arithmetic rests on — was found to have had no guard for the
     * life of the repo.
     *
     * `AuthProfileKind` is exempted by name for the reason the auth round
     * records: its guard is blocked on a deploy rather than on a code change.
     * Nothing in this round's models stores it, so the exemption is inert here
     * and is kept only so a future column cannot trip over it silently.
     */
    const declared = new Set(
      [...schema.matchAll(/\benum\s+(\w+)\s*\{/g)].map((match) => match[1]!),
    );
    const paired = new Set([...pairedEnums(), 'AuthProfileKind']);
    const unguarded: string[] = [];

    for (const model of NEW_MODELS) {
      for (const raw of modelBody(model).split('\n')) {
        const line = raw.replace(/\/\/.*$/, '').trim();
        const field = /^(\w+)\s+(\w+)(\[\])?\??/.exec(line);
        if (!field) continue;
        const type = field[2]!;
        // An enum ARRAY is still an enum column: `TestCorrection.kinds` is
        // `CorrectionKind[]`, and a value missing from the type cannot be
        // stored in the array any more than in a scalar.
        if (!declared.has(type) || paired.has(type)) continue;
        unguarded.push(`${model}.${field[1]!} is ${type}`);
      }
    }

    expect(unguarded).toEqual([]);
  });

  it('guards the enum stored in an ARRAY column, which a scalar-only reading would miss', () => {
    // `TestCorrection.kinds` is `CorrectionKind[]`. The assertion above would
    // pass if the loop skipped `[]` types — the measurement round's copy does
    // skip them, deliberately, because there a `[]` meant a relation list. Here
    // it does not, and this names the difference so nobody "fixes" it back.
    expect(modelBody('TestCorrection')).toMatch(/kinds\s+CorrectionKind\[\]/);
    expect(pairedEnums()).toContain('CorrectionKind');
  });
});

describe('schema.prisma ⇄ the migration SQL', () => {
  for (const prismaEnum of NEW_PAIRS) {
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

  it('adds exactly two nullable, default-free columns to "Project" and nothing else', () => {
    /*
     * THE ASSERTION THIS ROUND OWES BY NAME. "Project" is the table every other
     * row in this product hangs off, and a column WITH A DEFAULT forces a table
     * rewrite under ACCESS EXCLUSIVE on every customer's database.
     * `ADD COLUMN ... NULL` with no default is metadata-only in PostgreSQL 11+.
     *
     * The migration's header claims exactly that, and a doc comment that
     * contradicts the code under it is one of the lies this product cannot
     * afford — so it is checked rather than claimed.
     */
    const added = [
      ...executable.matchAll(/ALTER TABLE "Project" ADD COLUMN "(\w+)"([^;]*);/g),
    ];
    expect(added.map((m) => m[1]!).sort()).toEqual(['styleProfile', 'styleProfileComputedAt']);
    for (const match of added) {
      expect(match[2]!.toUpperCase()).not.toContain('DEFAULT');
      expect(match[2]!.toUpperCase()).not.toContain('NOT NULL');
    }
    expect(executable).not.toMatch(/ALTER TABLE "Project" DROP/);
    expect(executable).not.toMatch(/ALTER TABLE "Project" ALTER COLUMN/);
  });

  it('declares `revert` NOT NULL, so a proposal nobody can revert cannot be stored', () => {
    // The structural half of "a refactor nobody can revert will not be
    // approved". The schema-level refusals live in
    // `suiteChangeProposalSchema`; this is the one the database enforces even
    // against a writer that bypasses zod entirely.
    expect(executable).toMatch(/"revert" JSONB NOT NULL/);
    expect(modelBody('SuiteChangeProposal')).toMatch(/revert Json\b/);
    expect(modelBody('SuiteChangeProposal')).not.toMatch(/revert Json\?/);
  });

  it('declares `projectId` NOT NULL on the corpus, which is the privacy boundary', () => {
    // Nothing in the correction corpus may cross a project. An orphan row is a
    // row a cross-project query could pick up, so there must be no way to write
    // one.
    expect(executable).toMatch(/CREATE TABLE "TestCorrection"[\s\S]*?"projectId" TEXT NOT NULL/);
    expect(modelBody('TestCorrection')).toMatch(/projectId String\b/);
    expect(modelBody('TestCorrection')).not.toMatch(/projectId String\?/);
  });

  it('makes one ownership fact per path per project unique', () => {
    // Two rows for one path would be two answers to "may QAAI write this", and
    // the permissive one would win by whichever the query returned first.
    expect(executable).toMatch(
      /CREATE UNIQUE INDEX "GeneratedArtifact_projectId_path_key" ON "GeneratedArtifact"\("projectId", "path"\)/,
    );
  });

  it('declares no index on "imports", which the schema comment says it deliberately omits', () => {
    // schema.prisma cannot express a GIN index without an `ops` class this repo
    // has never used, so an index declared in SQL only would be drift
    // `prisma migrate diff` reports for ever. The comment says so; this checks
    // that the SQL agrees with the comment.
    expect(executable).not.toMatch(/USING GIN/i);
    expect(executable).not.toMatch(/INDEX[^;]*\("imports"\)/);
  });

  it('cascades every new table from its project, so a deleted project leaves nothing behind', () => {
    for (const model of NEW_MODELS) {
      expect(executable).toMatch(
        new RegExp(
          `ALTER TABLE "${model}" ADD CONSTRAINT "${model}_projectId_fkey"[\\s\\S]*?ON DELETE CASCADE`,
        ),
      );
    }
  });
});

describe('the hand-written migration', () => {
  /** Every migration directory, sorted. */
  function dirs(): string[] {
    return readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  it('carries a timestamp later than every migration that existed before it', () => {
    /*
     * Phrased against the PREVIOUS newest, pinned by NAME, and never against
     * `dirs.at(-1)`. The equivalent assertion in check-enums.pairs.test.ts was
     * once `expect(dirs.at(-1)).toBe(MIGRATION_DIR)` and it went red the moment
     * the next round's migration landed — a later one being added is the next
     * correct change, not a regression.
     */
    const all = dirs();
    expect(all).toContain(MIGRATION_DIR);
    expect(all).toContain(PREVIOUS_NEWEST);
    expect(all.indexOf(MIGRATION_DIR)).toBeGreaterThan(all.indexOf(PREVIOUS_NEWEST));
  });

  it('shares its timestamp with no other migration directory', () => {
    /*
     * Nastier than an out-of-order name. Prisma applies migrations in
     * lexicographic order and records them by full directory name, so two
     * directories with the SAME 14-digit prefix both apply — in an order
     * decided by the suffix — and `migrate diff` reports drift that no
     * reordering fixes. Two agents minting a migration in the same round is
     * exactly how it happens, and this round has four agents running in
     * parallel behind this one.
     */
    const stamps = dirs().map((dir) => dir.slice(0, 14));
    const duplicated = stamps.filter((stamp, index) => stamps.indexOf(stamp) !== index);
    expect(duplicated).toEqual([]);
    expect(stamps.every((stamp) => /^\d{14}$/.test(stamp))).toBe(true);
  });

  it('says out loud that it was hand-written and has not been applied', () => {
    // Every hand-authored migration in this repo carries that sentence. A
    // migration file that looks generated and was not is the thing the next
    // person trusts by mistake.
    expect(migration).toContain('WRITTEN BY HAND');
    expect(migration).toContain('has NOT been applied');
  });

  it('carries a revert section for everything it creates', () => {
    // A migration nobody can revert is this round's own rule applied to itself.
    for (const model of NEW_MODELS) expect(migration).toContain(`DROP TABLE "${model}"`);
    for (const prismaEnum of NEW_PAIRS) expect(migration).toContain(`DROP TYPE "${prismaEnum}"`);
    expect(migration).toContain('DROP COLUMN "styleProfile"');
    // And the DROPs are commented out, or applying this migration would undo it.
    for (const line of migration.split('\n')) {
      if (/DROP (TABLE|TYPE|COLUMN|CONSTRAINT)/.test(line)) {
        expect(line.trimStart().startsWith('--'), line).toBe(true);
      }
    }
  });
});
