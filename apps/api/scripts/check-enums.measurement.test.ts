import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { METRIC_DIRECTIONS, METRIC_UNITS } from '@qaai/shared';
import { describe, expect, it } from 'vitest';

/**
 * The drift guard's own guard for the four enums the MEASUREMENT round added,
 * and the hand-written migration that creates them.
 *
 * ── Why a third file beside the other two ──────────────────────────────────
 *
 * `check-enums.pairs.test.ts` pins the requirements round and
 * `check-enums.auth-and-access.test.ts` pins the auth round; each names its own
 * migration directory and asserts facts about that SQL. Adding a third round's
 * assertions to either would make one file responsible for two migrations and
 * leave no obvious place for the fourth. The durable, round-independent
 * assertion both files carry — "pair every enum the new models store" — is
 * repeated here against THIS round's models for the same reason: it is the one
 * that catches the next person rather than this change.
 *
 * ── What is asserted HERE and what is asserted elsewhere ───────────────────
 *
 * `CoverageTier` and `CoverageEdgeSource` are mirrored in
 * packages/shared/src/coverage-tiers.ts, which the package barrel does not
 * re-export yet — so from this workspace they are reachable only by
 * deep-importing another workspace's source, which this repo does not do. They
 * are compared VALUE FOR VALUE in `packages/shared/src/coverage-tiers.test.ts`,
 * which can import them relatively, and their SQL is still checked against
 * schema.prisma below. `MetricUnit` and `MetricDirection` live in types.ts,
 * which IS on the barrel, so those two are compared here directly. Once the
 * barrel exports coverage-tiers.ts, the first two can be folded in.
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
const MIGRATION_DIR = '20261025100000_coverage_tiers_provenance_variants_and_metrics';
const PREVIOUS_NEWEST = '20261024100000_auth_kinds_role_access_and_reenumeration';
const migration = readFileSync(`${MIGRATIONS}/${MIGRATION_DIR}/migration.sql`, 'utf8');

/**
 * The executable half of the migration: every comment line removed, not merely
 * the revert section.
 *
 * Doubly load-bearing, and the previous round paid a test failure to find the
 * second reason. The revert instructions at the bottom are a commented-out
 * mirror image of everything above, so a search of the whole file can be
 * satisfied by the rollback. And the HEADER quotes its own DDL in prose — the
 * paragraph naming `ALTER TABLE "Test" ADD COLUMN "covers"` as one of the two
 * exceptions would make an "exactly two columns" assertion count four.
 * Stripping every `--` line is the only reading of "executable" that is true.
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
  // The deliberate-omission notes quote the shape of a PAIRS entry inside a
  // block comment, so the live list has to be read from the array itself rather
  // than from the whole file — otherwise `HealState` and `AuthProfileKind`
  // would both appear to be guarded.
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

/** The four Prisma enums this round introduced. */
const NEW_PAIRS: ReadonlyArray<{ prismaEnum: string }> = [
  { prismaEnum: 'CoverageTier' },
  { prismaEnum: 'CoverageEdgeSource' },
  { prismaEnum: 'MetricUnit' },
  { prismaEnum: 'MetricDirection' },
];

/** The two whose TypeScript mirror this workspace can import. See the header. */
const MIRRORED: ReadonlyArray<{ prismaEnum: string; members: readonly string[] }> = [
  { prismaEnum: 'MetricUnit', members: METRIC_UNITS },
  { prismaEnum: 'MetricDirection', members: METRIC_DIRECTIONS },
];

/** The models this round introduced. */
const NEW_MODELS = [
  'TestCoverageEdge',
  'TestResultVariant',
  'TestMetricSample',
  'SuiteHealthSnapshot',
] as const;

describe('the PAIRS list grew', () => {
  it('names all four new enums', () => {
    const paired = pairedEnums();
    for (const { prismaEnum } of NEW_PAIRS) expect(paired).toContain(prismaEnum);
  });

  it('still names the thirty-two that were there before', () => {
    // Named rather than counted. A count would be satisfied by swapping one of
    // these out for one of the four, and the whole value of a drift guard is
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
      'SpecSourceSystem',
      'RequirementStatus',
      'AcceptanceCriterionFormat',
      'RequirementLinkMethod',
      'RequirementLinkState',
      'ManualTestAutomationStatus',
      'ApiAuthDeclaration',
      'ApiOperationVerification',
      'ComponentItemKind',
      'ComponentStateKind',
      'RouteAccessOutcome',
      'RouteAccessBasis',
      'RoleCrawlOutcome',
      'BotProtectionProvider',
      'BotBypassMode',
      'EnvironmentReachability',
      'ReEnumerationTriggerKind',
      'ReEnumerationRunState',
      'SurfaceDriftComparability',
    ]) {
      expect(paired).toContain(before);
    }
  });

  it('newly guards TestResultStatus, which had no guard for the life of the repo', () => {
    /*
     * A FINDING THIS ROUND MADE RATHER THAN A CHANGE IT NEEDED.
     *
     * `TestResultStatus` is the enum the entire product's pass/fail arithmetic
     * is built on. It has existed since the init migration, has always had a
     * mirror in `TEST_RESULT_STATUSES`, and was never in the PAIRS list — so
     * for the life of this repo the single most load-bearing enum in it had no
     * drift guard. It was found by the durable assertion below, which went red
     * because "TestResultVariant"."status" stores it. That is the same
     * mechanism, and the same class of finding, as `AuthProfileKind` one round
     * earlier, which is the evidence that the durable half earns its keep.
     *
     * Unlike `AuthProfileKind` it needed no exemption: its five labels are
     * deployed, this round adds none, so all three sources agree today and the
     * script reports it compared against the LIVE database rather than absent.
     */
    expect(pairedEnums()).toContain('TestResultStatus');
    expect(prismaEnumMembers('TestResultStatus')).toEqual([
      'PASSED',
      'FAILED',
      'SKIPPED',
      'FLAKY',
      'TIMED_OUT',
    ]);
    // And it is NOT one of this round's CREATE TYPEs — the type already exists,
    // so a `CREATE TYPE` for it here would fail on every deploy.
    expect(executable).not.toContain('CREATE TYPE "TestResultStatus"');
  });

  it('lists each enum exactly once', () => {
    const paired = pairedEnums();
    expect(paired).toEqual([...new Set(paired)]);
  });

  it('pairs every enum the four new models store', () => {
    /*
     * THE DURABLE HALF, and the one that catches the next person rather than
     * this change. It reads the enum-typed columns out of the new models and
     * demands a PAIRS entry for each, so a fifth enum added to any of these
     * tables fails here instead of shipping with no guard at all.
     *
     * `AuthProfileKind` is exempted by name for the reason the auth round
     * records — its guard is blocked on a deploy rather than on a code change.
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
        if (field[3] === '[]') continue; // a relation list is not a column
        if (!declared.has(type) || paired.has(type)) continue;
        unguarded.push(`${model}.${field[1]!} is ${type}`);
      }
    }

    expect(unguarded).toEqual([]);
  });
});

describe('schema.prisma ⇄ the TypeScript mirrors', () => {
  for (const { prismaEnum, members } of MIRRORED) {
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
     * correct change, not a regression. An assertion that breaks when the next
     * correct change lands is a trap, not a guard. What needs proving is the
     * ORDERING, so that is what is proved.
     */
    const all = dirs();
    expect(all).toContain(MIGRATION_DIR);
    expect(all).toContain(PREVIOUS_NEWEST);
    expect(all.indexOf(MIGRATION_DIR)).toBeGreaterThan(all.indexOf(PREVIOUS_NEWEST));
    for (const dir of all) {
      if (dir === MIGRATION_DIR) continue;
      if (dir > MIGRATION_DIR) continue; // a later round, which is fine
      expect(dir < MIGRATION_DIR, `${dir} must sort before ${MIGRATION_DIR}`).toBe(true);
    }
  });

  it('shares its timestamp with no other migration directory', () => {
    /*
     * The failure this catches is nastier than an out-of-order name. Prisma
     * applies migrations in lexicographic order and records them by full
     * directory name, so two directories with the SAME 14-digit prefix both
     * apply — in an order decided by the suffix — and `migrate diff` reports
     * drift that no reordering fixes. Two agents minting a migration in the
     * same round is exactly how it happens.
     */
    const stamps = dirs().map((dir) => dir.slice(0, 14));
    const duplicated = stamps.filter((stamp, index) => stamps.indexOf(stamp) !== index);
    expect(duplicated).toEqual([]);
    expect(stamps.every((stamp) => /^\d{14}$/.test(stamp))).toBe(true);
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

  it('adds no column to TestResult, and touches it only through two foreign keys', () => {
    /*
     * THE ASSERTION THIS ROUND WAS ASKED FOR BY NAME. "TestResult" is the
     * largest table in the product and a column with a DEFAULT on it forces a
     * table rewrite under ACCESS EXCLUSIVE on every customer's database. The
     * migration's header claims three things touch it — two AddForeignKey
     * statements and two Prisma relation fields that emit no SQL — and a doc
     * comment that contradicts the code under it is one of the lies this
     * product cannot afford.
     */
    expect(executable).not.toMatch(/ALTER TABLE "TestResult" ADD COLUMN/);
    expect(executable).not.toMatch(/ALTER TABLE "TestResult" ALTER COLUMN/);
    expect(executable).not.toMatch(/ALTER TABLE "TestResult" DROP/);

    const touching = executable
      .split('\n')
      .filter((line) => line.includes('"TestResult"') && line.startsWith('ALTER TABLE'));
    expect(touching).toHaveLength(2);
    for (const statement of touching) {
      expect(statement).toContain('ADD CONSTRAINT');
      expect(statement).toContain('REFERENCES "TestResult"("id")');
    }
    // Both are declared on the CHILD, which is what makes them a brief
    // SHARE ROW EXCLUSIVE rather than a scan of the parent.
    expect(touching[0]).toMatch(/^ALTER TABLE "TestResultVariant"/);
    expect(touching[1]).toMatch(/^ALTER TABLE "TestMetricSample"/);
  });

  it('adds exactly two columns to pre-existing tables, and names them', () => {
    const added = [...executable.matchAll(/ALTER TABLE "(\w+)" ADD COLUMN "(\w+)"/g)].map(
      (match) => `${match[1]!}.${match[2]!}`,
    );
    expect(added).toEqual(['Test.covers', 'Project.coverageConfig']);
  });

  it('keeps both added columns lock-free: a nullable JSONB and an immutable default', () => {
    /*
     * Since PostgreSQL 11 a DEFAULT that is NOT VOLATILE is stored once in
     * pg_attribute and materialised on read, so no heap page is touched.
     * `ARRAY[]::TEXT[]` qualifies; `now()` and `gen_random_uuid()` do NOT and
     * would rewrite the whole table. This assertion is what stops somebody
     * "improving" the default later and turning a catalogue update into an
     * outage.
     */
    expect(executable).toContain(
      'ALTER TABLE "Test" ADD COLUMN "covers" TEXT[] DEFAULT ARRAY[]::TEXT[];',
    );
    expect(executable).toContain('ALTER TABLE "Project" ADD COLUMN "coverageConfig" JSONB;');
    expect(executable).not.toMatch(/ADD COLUMN "coverageConfig" JSONB NOT NULL/);
    for (const volatile of ['now()', 'CURRENT_TIMESTAMP', 'gen_random_uuid()', 'random()']) {
      const addColumns = [...executable.matchAll(/ALTER TABLE "\w+" ADD COLUMN [^;]*;/g)].map(
        (match) => match[0],
      );
      for (const statement of addColumns) {
        expect(statement, `a volatile default would rewrite the table`).not.toContain(volatile);
      }
    }
  });

  it('gives every variant dimension NOT NULL and no database default', () => {
    /*
     * PostgreSQL treats every NULL as DISTINCT, so a nullable dimension in the
     * six-column unique index below would make the DEFAULT CELL — the one
     * almost every test runs in — re-insert on every run and be counted once
     * per run. That is the same defect "RouteAccessCell"."role" records.
     *
     * And no DEFAULT, deliberately: the sentinel is the PRODUCER's statement
     * that a dimension was not varied, and a database default would let a
     * writer that forgot a dimension look identical to one that considered it.
     * `testVariantKeySchema` is where the default belongs, because that is a
     * path where somebody is making a claim.
     */
    const table = /CREATE TABLE "TestResultVariant" \(([\s\S]*?)\n\);/.exec(executable);
    expect(table).not.toBeNull();
    for (const dimension of ['browser', 'viewport', 'locale', 'role', 'environment']) {
      expect(table![1]!).toContain(`"${dimension}" TEXT NOT NULL,`);
      expect(table![1]!).not.toContain(`"${dimension}" TEXT NOT NULL DEFAULT`);
    }
    expect(executable).toContain(
      'CREATE UNIQUE INDEX "TestResultVariant_cell_key" ON "TestResultVariant"("testResultId", "browser", "viewport", "locale", "role", "environment");',
    );
  });

  it('leaves every suite-health measurement nullable with no DEFAULT 0', () => {
    /*
     * The honesty rule the whole table turns on. 0 is the BEST POSSIBLE RESULT
     * for five of these ten, so a `DEFAULT 0` would make a project that has
     * never been scanned indistinguishable from one with a flawless suite. The
     * ONE defaulted column is ."caveats", because an empty caveat list is a
     * positive, verifiable claim rather than a measurement.
     */
    const table = /CREATE TABLE "SuiteHealthSnapshot" \(([\s\S]*?)\n\);/.exec(executable);
    expect(table).not.toBeNull();
    const body = table![1]!;
    for (const column of [
      'testCount',
      'quarantinedCount',
      'flakyCount',
      'weakAssertionCount',
      'duplicateCount',
      'obsoleteCount',
      'passRatePercent',
      'medianDurationMs',
      'p95DurationMs',
      'score',
    ]) {
      expect(body, `${column} must be nullable`).not.toMatch(
        new RegExp(`"${column}" (INTEGER|DOUBLE PRECISION) NOT NULL`),
      );
      expect(body, `${column} must not default to 0`).not.toMatch(
        new RegExp(`"${column}"[^,]*DEFAULT 0`),
      );
    }
    expect(body).toContain(`"caveats" JSONB NOT NULL DEFAULT '[]'`);
  });

  it('leaves a metric value nullable, because NULL is "not measured"', () => {
    // An LCP of 0 ms is a page that painted instantly; a p95 of 0 is a load
    // test that never ran. A NOT NULL here would force a writer to pick one.
    const table = /CREATE TABLE "TestMetricSample" \(([\s\S]*?)\n\);/.exec(executable);
    expect(table).not.toBeNull();
    expect(table![1]!).toContain('"value" DOUBLE PRECISION,');
    // `variantKey` is the opposite: NOT NULL, so the unique index constrains
    // the whole-test case instead of admitting one duplicate per run for ever.
    expect(table![1]!).toContain('"variantKey" TEXT NOT NULL,');
    expect(table![1]!).toContain('"variantId" TEXT,');
  });

  it('gives the edge no default tier and no default source', () => {
    // A defaulted tier mints a claim nothing produced; a defaulted source lets
    // a writer's bug read as a regex match. With neither, the INSERT fails and
    // somebody finds out — the argument "RouteAccessCell"."outcome" records.
    const table = /CREATE TABLE "TestCoverageEdge" \(([\s\S]*?)\n\);/.exec(executable);
    expect(table).not.toBeNull();
    expect(table![1]!).toContain('"source" "CoverageEdgeSource" NOT NULL,');
    expect(table![1]!).toContain('"tier" "CoverageTier" NOT NULL,');
    expect(table![1]!).not.toMatch(/"tier" "CoverageTier" NOT NULL DEFAULT/);
    expect(table![1]!).not.toMatch(/"source" "CoverageEdgeSource" NOT NULL DEFAULT/);
    // The coexistence rule, as a constraint: a STATIC edge and a RUNTIME edge
    // for the same (item, test) must be able to sit side by side and disagree.
    expect(executable).toContain(
      'CREATE UNIQUE INDEX "TestCoverageEdge_itemId_testId_source_key" ON "TestCoverageEdge"("itemId", "testId", "source");',
    );
  });

  it('adds no ALTER TYPE, so there is no PostgreSQL 12 floor and no irreversible half', () => {
    /*
     * The previous round needed `ALTER TYPE … ADD VALUE`, which is catalogue-only
     * but cannot be reverted (PostgreSQL has no DROP VALUE) and must not have its
     * new label USED in the same transaction. This round creates four fresh
     * types and appends to none, so neither constraint applies — and the header
     * says so. If somebody later adds an ALTER TYPE here, this goes red and the
     * header has to be rewritten with the transaction rule in it.
     */
    expect(executable).not.toContain('ALTER TYPE');
  });

  it("keeps every identifier inside PostgreSQL's 63-byte limit", () => {
    /*
     * PostgreSQL TRUNCATES identifiers at 63 bytes SILENTLY. An earlier round
     * paid for this with a five-column unique whose generated name was 74
     * bytes: the hand-written DDL and Prisma's introspection disagreed about
     * the name for ever, and every later `migrate dev` reported drift it could
     * not fix. This round's longest is 44 — and the six-column variant key
     * would have been 73, which is why schema.prisma names it with `map:`.
     */
    const identifiers = [
      ...executable.matchAll(/(?:CONSTRAINT|INDEX) "([^"]+)"/g),
      ...executable.matchAll(/ADD CONSTRAINT "([^"]+)"/g),
    ].map((match) => match[1]!);
    expect(identifiers.length).toBeGreaterThan(20);
    expect(identifiers.filter((name) => Buffer.byteLength(name, 'utf8') > 63)).toEqual([]);
    /*
     * The header states the count and the longest one by name and by length. A
     * doc comment that contradicts the code under it is one of the lies this
     * product cannot afford, and this is the assertion that keeps that
     * paragraph true as indexes are added or renamed.
     */
    const longest = identifiers.reduce((a, b) => (b.length > a.length ? b : a));
    expect(migration).toContain(`the 35\n-- identifiers here is "${longest}" at 49`);
    expect(Buffer.byteLength(longest, 'utf8')).toBe(49);
    expect(identifiers).toHaveLength(35);
  });

  it('names exactly one constraint explicitly — the only one that had to be', () => {
    /*
     * Prisma's derived name for the six-column variant cell key is
     * "TestResultVariant_testResultId_browser_viewport_locale_role_environment_key"
     * at 75 bytes, which PostgreSQL would silently cut to 63. That `map:` is
     * load-bearing.
     *
     * The assertion that NO OTHER model carries one is the other half, and it
     * is the half that keeps the first honest: a `map:` sprinkled where it was
     * not needed makes the required one read as a style preference, and the
     * next person removes it.
     */
    expect(modelBody('TestResultVariant')).toContain('map: "TestResultVariant_cell_key"');
    expect(
      Buffer.byteLength(
        'TestResultVariant_testResultId_browser_viewport_locale_role_environment_key',
        'utf8',
      ),
    ).toBeGreaterThan(63);
    for (const model of NEW_MODELS.filter((m) => m !== 'TestResultVariant')) {
      expect(modelBody(model), `${model} needs no map:`).not.toContain('map: "');
    }
    // And the two left to Prisma do fit, which is why they were left.
    for (const derived of [
      'TestCoverageEdge_itemId_testId_source_key',
      'TestMetricSample_testResultId_variantKey_name_key',
    ]) {
      expect(Buffer.byteLength(derived, 'utf8')).toBeLessThanOrEqual(63);
      expect(executable).toContain(`CREATE UNIQUE INDEX "${derived}"`);
    }
  });

  it('says what is not wired yet, rather than leaving it to be discovered', () => {
    /*
     * All four tables are minted with no reader and no writer: the write paths
     * and read paths live in files this change does not own and land beside it
     * in the same round. The round before the previous one paid an entire extra
     * repair pass for shipping two such tables WITHOUT saying so, and
     * `scripts/check-wiring.ts` will report four disconnected models until the
     * doors land. A migration whose disconnection is a surprise is the specific
     * mistake being avoided.
     */
    expect(migration).toContain('FOUR DISCONNECTED MODELS');
    expect(migration).toContain('check-wiring');
    for (const model of NEW_MODELS) {
      expect(migration, `the header must name ${model} as unwired`).toContain(`"${model}"`);
    }
  });

  it('states both directions of the revert, including what cannot be re-derived', () => {
    const revert = migration.slice(migration.indexOf('-- REVERSING THIS'));
    expect(revert.length).toBeGreaterThan(0);
    for (const model of NEW_MODELS) {
      expect(revert, `the revert must drop ${model}`).toContain(`DROP TABLE "${model}";`);
    }
    for (const { prismaEnum } of NEW_PAIRS) {
      expect(revert, `the revert must drop ${prismaEnum}`).toContain(`DROP TYPE "${prismaEnum}";`);
    }
    expect(revert).toContain('ALTER TABLE "Test" DROP COLUMN "covers"');
    expect(revert).toContain('ALTER TABLE "Project" DROP COLUMN "coverageConfig"');
    // A revert plan that omits what is lost is not a revert plan. The two
    // irrecoverable things are the trend and the two columns a person typed.
    expect(revert).toContain('NOT RE-DERIVABLE');
    expect(revert).toContain('EXPORT');
  });

  it('drops a child before its parent, rather than hiding it behind CASCADE', () => {
    // `DROP TABLE … CASCADE` would also work and is deliberately not used: it
    // hides exactly the dependency the ordering states.
    const revert = migration.slice(migration.indexOf('-- REVERSING THIS'));
    expect(revert.indexOf('DROP TABLE "TestMetricSample";')).toBeLessThan(
      revert.indexOf('DROP TABLE "TestResultVariant";'),
    );
    expect(revert).not.toContain('CASCADE;');
  });
});
