import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AUTH_PROFILE_KINDS,
  RE_ENUMERATION_RUN_STATES,
  RE_ENUMERATION_TRIGGER_KINDS,
  SURFACE_DRIFT_COMPARABILITIES,
} from '@qaai/shared';
import { describe, expect, it } from 'vitest';

/**
 * The drift guard's own guard, for the nine enums the auth-gated enumeration
 * round added — plus the one it found MISSING, and the hand-written migration
 * that creates them all.
 *
 * ── Why a second file next to check-enums.pairs.test.ts ────────────────────
 *
 * Because that file pins its own round: it names
 * `20261024090000_requirements_api_and_component_surface` as "this round's
 * migration directory" and asserts facts about that SQL. Adding this round's
 * assertions to it would make one file responsible for two migrations and leave
 * no obvious place for the third. The durable, round-independent assertion in
 * that file — "pair every enum the new models store" — is repeated here against
 * THIS round's models for the same reason: it is the one that catches the next
 * person rather than this change.
 *
 * ── The finding this file records ──────────────────────────────────────────
 *
 * `AuthProfileKind` has existed since the beginning, has always had a mirror in
 * `AUTH_PROFILE_KINDS`, and was never in the script's PAIRS list. The one enum
 * that decides whether a customer's application can be logged into at all had
 * no drift guard for the life of the repo. It still cannot go in the list — the
 * migration that adds its three new labels is written and not deployed, so the
 * script's LIVE check would report three labels missing from the database,
 * truthfully, with no code change able to fix it, and a red check with no
 * remedy is a check people start skipping. That is the same judgement the
 * script already records for `HealState`.
 *
 * So the two STATIC halves are asserted here directly instead, and the
 * deliberate omission is asserted to still be documented. Both clear together
 * on `prisma migrate deploy`.
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
const MIGRATION_DIR = '20261024100000_auth_kinds_role_access_and_reenumeration';
const PREVIOUS_NEWEST = '20261024090000_requirements_api_and_component_surface';
const migration = readFileSync(`${MIGRATIONS}/${MIGRATION_DIR}/migration.sql`, 'utf8');

/**
 * The executable half of the migration: comment lines removed, not merely the
 * revert section.
 *
 * Doubly load-bearing here, and the second reason cost a test failure to find.
 * The revert instructions at the bottom are a commented-out mirror image of
 * everything above — including a full `CREATE TYPE "AuthProfileKind"` with the
 * OLD five labels — so a search of the whole file could be satisfied by the
 * comments and would read the rollback's five-label type as this migration's
 * eight-label one. And the HEADER quotes its own DDL in prose: the sentence
 * naming `ALTER TABLE "AuthProfile" ADD COLUMN "role" TEXT` as the one
 * exception made the "exactly one column" assertion count two. Stripping every
 * `--` line is the only reading of "executable" that is actually true.
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

/** The nine Prisma enums this round introduced. */
const NEW_PAIRS: ReadonlyArray<{ prismaEnum: string }> = [
  { prismaEnum: 'RouteAccessOutcome' },
  { prismaEnum: 'RouteAccessBasis' },
  { prismaEnum: 'RoleCrawlOutcome' },
  { prismaEnum: 'BotProtectionProvider' },
  { prismaEnum: 'BotBypassMode' },
  { prismaEnum: 'EnvironmentReachability' },
  { prismaEnum: 'ReEnumerationTriggerKind' },
  { prismaEnum: 'ReEnumerationRunState' },
  { prismaEnum: 'SurfaceDriftComparability' },
];

/**
 * The four whose TypeScript mirror this workspace can actually import, and
 * therefore compare VALUE for value.
 *
 * The other six live in `packages/shared/src/auth-profiles.ts`, which the
 * package barrel does not re-export yet — so from here they are reachable only
 * by deep-importing another workspace's source, which this repo does not do.
 * They are compared value-for-value in `packages/shared/src/auth-profiles.test
 * .ts`, which can import them relatively, and their SQL is still checked
 * against schema.prisma below like the other three. Once the barrel exports the
 * module, these can be folded back together.
 */
const MIRRORED: ReadonlyArray<{ prismaEnum: string; members: readonly string[] }> = [
  { prismaEnum: 'ReEnumerationTriggerKind', members: RE_ENUMERATION_TRIGGER_KINDS },
  { prismaEnum: 'ReEnumerationRunState', members: RE_ENUMERATION_RUN_STATES },
  { prismaEnum: 'SurfaceDriftComparability', members: SURFACE_DRIFT_COMPARABILITIES },
  { prismaEnum: 'AuthProfileKind', members: AUTH_PROFILE_KINDS },
];

/** The models this round introduced. */
const NEW_MODELS = [
  'RouteAccessCell',
  'RoleCrawlAttempt',
  'EnvironmentAccess',
  'ReEnumerationTrigger',
  'SurfaceDriftRecord',
] as const;

/** The labels this round appends to an EXISTING enum rather than creating. */
const NEW_AUTH_PROFILE_KINDS = ['PASSKEY', 'PHONE_OTP', 'MOCK_IDP'] as const;

describe('the PAIRS list grew', () => {
  it('names all nine new enums', () => {
    const paired = pairedEnums();
    for (const { prismaEnum } of NEW_PAIRS) expect(paired).toContain(prismaEnum);
  });

  it('still names the twenty-three that were there before', () => {
    // Named rather than counted. A count would be satisfied by swapping one of
    // these out for one of the nine, and the whole value of a drift guard is
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
    ]) {
      expect(paired).toContain(before);
    }
  });

  it('lists each enum exactly once', () => {
    const paired = pairedEnums();
    expect(paired).toEqual([...new Set(paired)]);
  });

  it('pairs every enum the five new models store', () => {
    /*
     * THE DURABLE HALF, and the one that catches the next person rather than
     * this change. It reads the enum-typed columns out of the new models and
     * demands a PAIRS entry for each, so a tenth enum added to any of these
     * tables fails here instead of shipping with no guard at all.
     *
     * `AuthProfileKind` is exempted by name and ONLY by name, with the reason
     * asserted separately below: it is the one enum these models touch whose
     * guard is blocked on a deploy rather than on a code change.
     */
    const declared = new Set(
      [...schema.matchAll(/\benum\s+(\w+)\s*\{/g)].map((match) => match[1]!),
    );
    const paired = new Set([...pairedEnums(), 'AuthProfileKind']);
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

  it('keeps AuthProfileKind out of the list, and says why in the script', () => {
    /*
     * The omission is deliberate and it must stay EXPLAINED, because an
     * undocumented gap in a drift guard is indistinguishable from an oversight
     * — which is exactly what AuthProfileKind's absence was until this round.
     * The script's note has to name the enum, the mirror, and the remedy.
     */
    expect(pairedEnums()).not.toContain('AuthProfileKind');
    expect(script).toContain("{ prismaEnum: 'AuthProfileKind', tsConst: 'AUTH_PROFILE_KINDS' }");
    expect(script).toContain('prisma migrate deploy');
  });
});

describe('schema.prisma ⇄ the TypeScript mirrors', () => {
  for (const { prismaEnum, members } of MIRRORED) {
    it(`${prismaEnum} matches its mirror exactly, in order`, () => {
      // Order as well as membership. The migration's CREATE TYPE was written
      // from these arrays, and a reordering would leave the two agreeing as
      // sets while the SQL and the schema disagreed — which PostgreSQL happily
      // accepts, and which makes every ORDER BY on the enum silently different.
      //
      // AuthProfileKind is in this list rather than in the script's PAIRS for
      // the reason recorded above: this is the static half of a guard whose
      // live half is blocked on a deploy, and it is the half that catches a
      // kind added on one side only.
      expect(prismaEnumMembers(prismaEnum)).toEqual([...members]);
    });
  }

  it('keeps TOTP_MFA and MAGIC_LINK spelled as the stored rows spell them', () => {
    // The round that added the three new kinds was asked for "TOTP", and
    // renaming a stored enum member is a data migration over every profile row.
    // Goes red if somebody later "tidies" the spelling without one.
    expect(prismaEnumMembers('AuthProfileKind')).toContain('TOTP_MFA');
    expect(prismaEnumMembers('AuthProfileKind')).toContain('MAGIC_LINK');
    expect(prismaEnumMembers('AuthProfileKind')).not.toContain('TOTP');
  });
});

describe('the hand-written migration', () => {
  it('carries a timestamp later than every migration that existed before it', () => {
    /*
     * Phrased against the PREVIOUS newest rather than `dirs.at(-1)`, and that
     * is not a stylistic preference: the equivalent assertion in
     * check-enums.pairs.test.ts WAS `expect(dirs.at(-1)).toBe(MIGRATION_DIR)`,
     * and it went red the moment this round's migration landed — a later one
     * being added is the next correct change, not a regression. It has since
     * been rewritten to this shape. An assertion that breaks when the next
     * correct change lands is a trap, not a guard. What actually needs proving
     * is the ordering, so that is what is proved.
     */
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs).toContain(MIGRATION_DIR);
    expect(dirs).toContain(PREVIOUS_NEWEST);
    expect(dirs.indexOf(MIGRATION_DIR)).toBeGreaterThan(dirs.indexOf(PREVIOUS_NEWEST));
    for (const dir of dirs) {
      if (dir === MIGRATION_DIR) continue;
      if (dir > MIGRATION_DIR) continue; // a later round, which is fine
      expect(dir < MIGRATION_DIR, `${dir} must sort before ${MIGRATION_DIR}`).toBe(true);
    }
  });

  for (const { prismaEnum } of NEW_PAIRS) {
    it(`creates ${prismaEnum} with exactly the schema's members, in order`, () => {
      // The check no tool made. `prisma migrate diff` cannot run here, so a
      // member mistyped or omitted in the SQL would be a value the generated
      // client inserts and the database rejects — at run time, on an insert.
      expect(sqlEnumMembers(prismaEnum)).toEqual(prismaEnumMembers(prismaEnum));
    });
  }

  it('appends the three new auth kinds instead of recreating the type', () => {
    /*
     * The difference matters enormously. `CREATE TYPE` for an enum that already
     * exists fails; recreating it properly means a swap and a TABLE REWRITE of
     * "AuthProfile" under ACCESS EXCLUSIVE. `ALTER TYPE … ADD VALUE` is a
     * catalogue update that takes no lock on the table at all, which is what
     * the migration's "APPLYING THIS ON A LIVE DATABASE" section claims — and a
     * doc comment that contradicts the code under it is one of the lies this
     * product cannot afford.
     */
    for (const label of NEW_AUTH_PROFILE_KINDS) {
      expect(executable).toContain(`ALTER TYPE "AuthProfileKind" ADD VALUE '${label}';`);
    }
    expect(executable).not.toContain('CREATE TYPE "AuthProfileKind"');
  });

  it('never USES one of the three new labels, which would fail on every deploy', () => {
    /*
     * PostgreSQL 12+ permits `ALTER TYPE … ADD VALUE` inside a transaction —
     * which `prisma migrate deploy` always provides — only while the new label
     * is not USED in the same transaction. A DEFAULT, a cast or an INSERT
     * naming one would fail with "unsafe use of new value of enum type", on
     * every deploy, with a message nobody connects to this file. The header
     * says so; this is the assertion that keeps it true.
     */
    const withoutAlters = executable
      .split('\n')
      .filter((line) => !line.startsWith('ALTER TYPE "AuthProfileKind" ADD VALUE'))
      .join('\n');
    for (const label of NEW_AUTH_PROFILE_KINDS) {
      expect(withoutAlters, `${label} must not be used in this migration`).not.toContain(
        `'${label}'`,
      );
    }
  });

  it('creates a table for every new model, and no table without a model', () => {
    const created = [...executable.matchAll(/CREATE TABLE "(\w+)"/g)].map((match) => match[1]!);
    expect(created.slice().sort()).toEqual([...NEW_MODELS].sort());
  });

  it('adds exactly one column to one pre-existing table: AuthProfile.role', () => {
    /*
     * The migration's header claims it is catalogue-only with ONE exception,
     * and names it. A second `ADD COLUMN` that crept in later would make that
     * paragraph false — and, if it carried a NOT NULL with a volatile default,
     * would turn a lock-free deploy into a table rewrite on a customer's
     * database.
     */
    const added = [...executable.matchAll(/ALTER TABLE "(\w+)" ADD COLUMN "(\w+)"/g)].map(
      (match) => `${match[1]!}.${match[2]!}`,
    );
    expect(added).toEqual(['AuthProfile.role']);
    // Nullable with no default is what makes it catalogue-only, and is also the
    // semantics: null means "nobody said what this profile is", which must not
    // be read as anonymous.
    expect(executable).toContain('ALTER TABLE "AuthProfile" ADD COLUMN "role" TEXT;');
    expect(executable).not.toMatch(/ADD COLUMN "role" TEXT NOT NULL/);
  });

  it('keeps every identifier inside PostgreSQL\'s 63-byte limit', () => {
    /*
     * PostgreSQL TRUNCATES identifiers at 63 bytes SILENTLY. The previous round
     * paid for this with a five-column unique whose generated name was 74
     * bytes: the hand-written DDL and Prisma's introspection disagreed about
     * the name for ever, and every later `migrate dev` reported drift it could
     * not fix. This round's longest is 52, and this assertion is what keeps the
     * next index from quietly going over.
     */
    const identifiers = [
      ...executable.matchAll(/(?:CONSTRAINT|INDEX) "([^"]+)"/g),
      ...executable.matchAll(/ADD CONSTRAINT "([^"]+)"/g),
    ].map((match) => match[1]!);
    expect(identifiers.length).toBeGreaterThan(20);
    const tooLong = identifiers.filter((name) => Buffer.byteLength(name, 'utf8') > 63);
    expect(tooLong).toEqual([]);
  });

  it('says what is not wired yet, rather than leaving it to be discovered', () => {
    /*
     * All five tables are minted with no reader and no writer, because the
     * crawl-side writers and API-side readers land beside this change in files
     * it does not own. The round before this one paid an entire extra repair
     * pass for shipping two such tables without saying so, and
     * `scripts/check-wiring.ts` will report five disconnected models until the
     * doors land. The header has to state it — a migration whose disconnection
     * is a surprise is the specific mistake being avoided.
     */
    expect(migration).toContain('FIVE DISCONNECTED MODELS');
    expect(migration).toContain('check-wiring');
  });

  it('states both directions of the revert, including the irreversible part', () => {
    // PostgreSQL has no `ALTER TYPE … DROP VALUE`, so the three new labels
    // cannot be removed without a table rewrite that fails outright if any row
    // uses one. A revert plan that omits the hard part is not a revert plan.
    const revert = migration.slice(migration.indexOf('-- REVERSING THIS'));
    expect(revert.length).toBeGreaterThan(0);
    expect(revert).toContain('NO `ALTER TYPE … DROP VALUE`');
    expect(revert).toContain('ALTER TABLE "AuthProfile" DROP COLUMN "role"');
    for (const model of NEW_MODELS) {
      expect(revert, `the revert must drop ${model}`).toContain(`DROP TABLE "${model}";`);
    }
    for (const { prismaEnum } of NEW_PAIRS) {
      expect(revert, `the revert must drop ${prismaEnum}`).toContain(`DROP TYPE "${prismaEnum}";`);
    }
  });
});
