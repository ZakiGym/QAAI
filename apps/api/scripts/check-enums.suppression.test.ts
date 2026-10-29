import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The drift guard's own guard for the four enums this round added, the three
 * columns it put on existing tables, and the hand-written migration that
 * creates them.
 *
 * ── Why a sixth file beside the other five ─────────────────────────────────
 *
 * `check-enums.pairs.test.ts` pins the requirements round,
 * `check-enums.auth-and-access.test.ts` the auth round,
 * `check-enums.measurement.test.ts` the measurement round,
 * `check-enums.dimensions.test.ts` the dimension round and
 * `check-enums.craft.test.ts` the craft round; each names its own migration
 * directory and asserts facts about that SQL. Adding a sixth round's assertions
 * to any of them would make one file responsible for two migrations and leave
 * no obvious place for the seventh. The durable, round-independent assertion
 * all of them carry — "pair every enum the new models store" — is repeated here
 * against THIS round's models for the same reason: it is the one that catches
 * the next person rather than this change, and it is how `TestResultStatus` and
 * `AuthProfileKind` were both found.
 *
 * ── The one pair whose parity is LIVE rather than derived ──────────────────
 *
 * `healVerifyStateSchema` in packages/shared/src/schemas.ts is a hand-written
 * `z.enum(['PENDING', …])` and not `z.enum(HEAL_VERIFY_STATES)`, because
 * `@qaai/shared` cannot import `@qaai/agent` where that list is declared. So
 * those two CAN disagree, and nothing but this file would notice: a fifth
 * verify state added in healer.ts with no line in schemas.ts is a state no API
 * call can store — the `GateRule` defect, where eight kinds shipped unsaveable
 * for two slices. Checked below by reading both files.
 *
 * Everything else in this round is `z.enum(SAME_ARRAY)`, so its `.options` is
 * DERIVED and the two cannot disagree. Said plainly rather than dressed up as a
 * guard; the parity that is real for those lists is schema.prisma ⇄ TypeScript,
 * which `check-enums.ts` performs and which this file proves it NAMES.
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
const SUPPRESSION = fileURLToPath(
  new URL('../../../packages/shared/src/suppression.ts', import.meta.url),
);
const OWNERSHIP = fileURLToPath(
  new URL('../../../packages/shared/src/ownership.ts', import.meta.url),
);
const SCHEMAS = fileURLToPath(new URL('../../../packages/shared/src/schemas.ts', import.meta.url));
const CONSTANTS = fileURLToPath(
  new URL('../../../packages/shared/src/constants.ts', import.meta.url),
);
const HEALER = fileURLToPath(new URL('../../../packages/agent/src/healer.ts', import.meta.url));

const schema = readFileSync(SCHEMA, 'utf8');
const script = readFileSync(SCRIPT, 'utf8');
const suppressionSrc = readFileSync(SUPPRESSION, 'utf8');
const ownershipSrc = readFileSync(OWNERSHIP, 'utf8');
const schemasSrc = readFileSync(SCHEMAS, 'utf8');
const constantsSrc = readFileSync(CONSTANTS, 'utf8');
const healerSrc = readFileSync(HEALER, 'utf8');

/**
 * This round's migration directory, and the newest one that PRECEDED it.
 *
 * `PREVIOUS_NEWEST` is pinned by NAME and not by "the second newest directory",
 * for the reason every file in this series records: a test asserting "this is
 * the newest migration" breaks on the next round's migration, which makes the
 * next person delete the assertion instead of reading it.
 */
const MIGRATION_DIR =
  '20261029120000_known_issues_ownership_provenance_obsolescence_and_outward_writes';
const PREVIOUS_NEWEST = '20261027150000_artifact_sets_corrections_proposals_and_style';
const migration = readFileSync(`${MIGRATIONS}/${MIGRATION_DIR}/migration.sql`, 'utf8');

/**
 * The executable half of the migration: every comment line removed.
 *
 * Doubly load-bearing, as the measurement round paid a failure to learn. The
 * revert instructions at the bottom are a commented-out mirror image of
 * everything above, so a search of the whole file can be satisfied by the
 * rollback — and the header quotes its own DDL in prose, so a counting
 * assertion would count the paragraph that names them.
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

/** Members of a `export const NAME = [...] as const` array in a TS source. */
function tsConstMembers(source: string, name: string): string[] {
  const block = new RegExp(`export const ${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!block) throw new Error(`${name} is not declared where this test expects it`);
  return [...block[1]!.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]!);
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

/** The four Prisma enums this round introduced. */
const NEW_PAIRS = [
  'SuppressionKind',
  'OwnerProvenance',
  'ObsolescenceSignalKind',
  'RetirementState',
] as const;

/** The models this round introduced. */
const NEW_MODELS = [
  'KnownIssue',
  'KnownIssueMatch',
  'SuppressionEvent',
  'ObsoleteTestSignal',
  'RetirementProposal',
  'PullRequestRecord',
  'RecordingPromotion',
] as const;

/**
 * ENUMS A NEW MODEL STORES THAT THE DRIFT GUARD STILL CANNOT SEE.
 *
 * EMPTY, and the mechanism stays. It held exactly one finding when this round
 * landed and that finding is closed: `IntegrationKind` — seventeen members,
 * stored by `Integration.kind`, `TrackerIssue.provider` and now
 * `PullRequestRecord.provider`, unpaired for the life of this repo because it
 * had no complete TypeScript mirror to pair against. constants.ts held four
 * CAPABILITY lists whose union was fifteen of the seventeen, so JIRA, LINEAR
 * and PAGERDUTY were values TypeScript could not name. `INTEGRATION_KINDS` is
 * now the storage mirror and the pair is in `check-enums.ts`.
 *
 * The set is kept rather than deleted, and the test below asserts it is EMPTY.
 * An exception list that only exists while it has a member is an exception list
 * somebody has to re-invent — and re-inventing it is how the next unpaired enum
 * gets quietly skipped instead of recorded.
 */
const KNOWN_UNPAIRED = new Set<string>();

describe('the PAIRS list grew', () => {
  it('names all four new enums', () => {
    const paired = pairedEnums();
    for (const prismaEnum of NEW_PAIRS) expect(paired).toContain(prismaEnum);
  });

  it('still names the ones that were there before', () => {
    // Named rather than counted. A count would be satisfied by swapping one of
    // these out for one of the four, and the whole value of a drift guard is
    // that nothing silently leaves it.
    const paired = pairedEnums();
    for (const before of [
      'TestType',
      'TestResultStatus',
      'Verdict',
      'ArtifactRole',
      'SuiteChangeState',
      'CoverageTier',
      'PrincipalKind',
    ]) {
      expect(paired).toContain(before);
    }
  });

  it('reads the two new vocabularies from the files that hold them', () => {
    // A pair whose `source` is wrong fails at run time with "declaration not
    // found", which `check-enums.ts` reports as drift — but only if the source
    // entry exists at all. These two lines are what make that possible.
    expect(script).toContain("suppression: { text: suppression, label: 'shared/suppression.ts' }");
    expect(script).toContain("ownership: { text: ownership, label: 'shared/ownership.ts' }");
  });

  it('pairs every enum the new models store', () => {
    // THE DURABLE ASSERTION. This is how `TestResultStatus` (the enum the whole
    // product's pass/fail arithmetic rests on) and `AuthProfileKind` were both
    // found with no drift guard. It catches the NEXT round, not this one — and
    // it caught something in THIS one. See `KNOWN_UNPAIRED`.
    const paired = pairedEnums();
    const declared = [...schema.matchAll(/\benum\s+(\w+)\s*\{/g)].map((m) => m[1]!);
    for (const model of NEW_MODELS) {
      const body = modelBody(model);
      for (const enumName of declared) {
        if (KNOWN_UNPAIRED.has(enumName)) continue;
        // A field whose type is this enum: `  name EnumName` or `EnumName?`.
        if (!new RegExp(`^\\s+\\w+\\s+${enumName}[?\\[]?\\s`, 'm').test(body)) continue;
        expect(paired, `${model} stores ${enumName}`).toContain(enumName);
      }
    }
  });

  it('has no unpaired-enum exceptions left', () => {
    // It had one when this round landed, and the exception was written so that
    // closing it would turn this test red rather than let it rot. It is red no
    // longer: `INTEGRATION_KINDS` exists and the pair is in check-enums.ts.
    // Asserted as EMPTY rather than deleted, so the next enum a new model
    // stores without a mirror has to be written down here to get past the test
    // above.
    expect([...KNOWN_UNPAIRED]).toEqual([]);
  });

  it('pairs IntegrationKind, and its mirror is the whole enum in order', () => {
    // The finding KNOWN_UNPAIRED recorded, now asserted from the other side.
    // Member for member and in order, because that is what `check-enums.ts`
    // compares — a mirror holding the right seventeen names in the wrong order
    // would fail the script and pass a set-equality test.
    expect(pairedEnums()).toContain('IntegrationKind');
    const mirror = tsConstMembers(constantsSrc, 'INTEGRATION_KINDS');
    expect(mirror).toEqual(prismaEnumMembers('IntegrationKind'));
    // The three members no capability list could name. Named, so that dropping
    // one from the mirror cannot be read as a tidy-up.
    for (const unnameable of ['JIRA', 'LINEAR', 'PAGERDUTY']) {
      expect(mirror).toContain(unnameable);
    }
    // And the capability lists keep their jobs: PAGERDUTY is deliberately not
    // a chat destination, because nothing in the worker can deliver to it.
    expect(tsConstMembers(constantsSrc, 'CHAT_INTEGRATION_KINDS')).not.toContain('PAGERDUTY');
  });
});

describe('schema.prisma, the TypeScript mirror and the SQL agree', () => {
  it('matches member for member, in order, for all four', () => {
    const mirrors: Record<(typeof NEW_PAIRS)[number], string[]> = {
      SuppressionKind: tsConstMembers(suppressionSrc, 'SUPPRESSION_KINDS'),
      ObsolescenceSignalKind: tsConstMembers(suppressionSrc, 'OBSOLESCENCE_SIGNAL_KINDS'),
      RetirementState: tsConstMembers(suppressionSrc, 'RETIREMENT_STATES'),
      OwnerProvenance: tsConstMembers(ownershipSrc, 'OWNER_PROVENANCES'),
    };
    for (const name of NEW_PAIRS) {
      expect(prismaEnumMembers(name), name).toEqual(mirrors[name]);
      // Order too, not just membership. Postgres enum order is the sort order,
      // and a type created with its members shuffled sorts a cockpit list
      // differently from the one the schema describes.
      expect(sqlEnumMembers(name), name).toEqual(mirrors[name]);
    }
  });

  it('keeps the five suppression kinds the register named', () => {
    expect(prismaEnumMembers('SuppressionKind')).toEqual([
      'QUARANTINE',
      'MUTE',
      'ENV_ISSUE',
      'COVERAGE_WAIVER',
      'RETIREMENT',
    ]);
  });
});

describe('the migration creates what the schema declares', () => {
  it('is newer than the migration that preceded it', () => {
    // Pinned by NAME. "Is this the newest?" breaks on the next round's
    // migration and teaches the next person to delete the assertion.
    const dirs = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d));
    expect(dirs).toContain(PREVIOUS_NEWEST);
    expect(dirs).toContain(MIGRATION_DIR);
    expect(MIGRATION_DIR > PREVIOUS_NEWEST).toBe(true);
  });

  it('creates every new table', () => {
    for (const model of NEW_MODELS) {
      expect(executable, model).toContain(`CREATE TABLE "${model}"`);
    }
  });

  it('creates every new type', () => {
    for (const name of NEW_PAIRS) {
      expect(executable, name).toContain(`CREATE TYPE "${name}"`);
    }
  });

  it('adds the three columns to existing tables', () => {
    expect(executable).toContain('ALTER TABLE "TriageVerdict" ADD COLUMN "ownerProvenance"');
    expect(executable).toContain('ALTER TABLE "TriageVerdict" ADD COLUMN "knownIssueId"');
    expect(executable).toContain('ALTER TABLE "HealProposal" ADD COLUMN "prRecordId"');
  });

  it('gives every new column on an existing table a nullable type and no default', () => {
    // The three are added to tables with rows in them. NOT NULL without a
    // default would fail on a non-empty table, and NOT NULL WITH a default
    // would invent a value — which for an ownership provenance means claiming
    // every historic verdict was routed by a rule nobody wrote.
    for (const line of executable.split('\n')) {
      if (!line.startsWith('ALTER TABLE') || !line.includes('ADD COLUMN')) continue;
      expect(line).not.toContain('NOT NULL');
      expect(line).not.toContain('DEFAULT');
    }
  });

  it('makes the expiry NOT NULL on the durable suppression', () => {
    // THE RULE THAT MATTERS MOST. Every previous suppression in this schema
    // made the expiry optional and every one of them then shipped rows without
    // it: `Test.quarantineExpiresAt` is null on every quarantine written before
    // that column existed, and `CoverageWaiver.expiresAt` is still nullable.
    const create = /CREATE TABLE "KnownIssue" \(([\s\S]*?)\n\);/.exec(executable);
    expect(create).not.toBeNull();
    expect(create![1]!).toMatch(/"expiresAt" TIMESTAMP\(3\) NOT NULL,/);
    // No default and no sentinel far-future value. A default would be a
    // migration deciding how long somebody else's mute lasts.
    expect(create![1]!).not.toMatch(/"expiresAt"[^\n]*DEFAULT/);
  });

  it('declares the expiry non-optional in schema.prisma too', () => {
    const body = modelBody('KnownIssue');
    expect(body).toMatch(/\n\s+expiresAt\s+DateTime\s*\n/);
    expect(body).not.toMatch(/expiresAt\s+DateTime\?/);
  });

  it('declares the retirement expiry non-optional as well', () => {
    expect(modelBody('RetirementProposal')).not.toMatch(/expiresAt\s+DateTime\?/);
  });

  it('writes the two CHECK constraints Prisma cannot express', () => {
    // "Exactly one owner" is not a convention. A KnownIssue with neither owner
    // is a silence with nobody's name on it, which is the single thing this
    // change exists to prevent; and the zod schema that also says so is not
    // reached by a backfill script, a support query or a psql session.
    expect(executable).toContain('CONSTRAINT "KnownIssue_one_owner"');
    expect(executable).toContain('CONSTRAINT "RetirementProposal_at_most_one_owner"');
  });

  it('makes idempotency a constraint and not a check, everywhere it matters', () => {
    // A check followed by an insert is two statements, and two CI runners
    // interleave them. Each of these is the CLAIM.
    for (const unique of [
      'KnownIssueMatch_knownIssueId_runId_clusterKey_key',
      'SuppressionEvent_runId_kind_targetKey_key',
      'ObsoleteTestSignal_testId_kind_reference_key',
      'PullRequestRecord_orgId_causeKey_key',
      'RecordingPromotion_projectId_recordingKey_key',
    ]) {
      expect(executable, unique).toContain(`CREATE UNIQUE INDEX "${unique}"`);
    }
  });

  it('indexes the mute lookup so it is not a scan', () => {
    // Asked once per failing cluster per run, which on a 200-test outage is the
    // read that decides whether a model call happens at all.
    expect(executable).toContain('USING GIN ("signatures")');
  });

  it('cascades every new table off the row that owns it', () => {
    for (const fk of [
      'KnownIssue_projectId_fkey',
      'KnownIssueMatch_knownIssueId_fkey',
      'ObsoleteTestSignal_testId_fkey',
      'RetirementProposal_testId_fkey',
      'PullRequestRecord_projectId_fkey',
      'RecordingPromotion_projectId_fkey',
    ]) {
      expect(executable, fk).toContain(`CONSTRAINT "${fk}"`);
    }
  });

  it('does NOT make the muted verdict a foreign key', () => {
    // `TriageVerdict.knownIssueId` is a plain id on purpose: the verdict's
    // record of having been muted must survive the mute being deleted, and a
    // cascade would erase the evidence along with the decision.
    expect(executable).not.toContain('TriageVerdict_knownIssueId_fkey');
  });

  it('says what a revert costs instead of only how to do it', () => {
    expect(migration).toContain('TO REVERT');
    expect(migration).toContain('DROPS EVERY MUTE');
    expect(migration).toContain('DROPS THE IDEMPOTENCE KEY');
  });

  it('drops every new table and type in the revert instructions', () => {
    for (const model of NEW_MODELS) expect(migration).toContain(`DROP TABLE "${model}"`);
    for (const name of NEW_PAIRS) expect(migration).toContain(`DROP TYPE "${name}"`);
  });
});

describe('the heal verify vocabulary has two homes and they must agree', () => {
  it('lists the same four states in healer.ts and in schemas.ts', () => {
    // THE ONE LIVE PARITY IN THIS ROUND. `healVerifyStateSchema` is a
    // hand-written literal because `@qaai/shared` cannot import `@qaai/agent`,
    // so these two CAN disagree and nothing else would notice: a fifth state
    // added in healer.ts with no line in schemas.ts is a state no API call can
    // store.
    const fromHealer = tsConstMembers(healerSrc, 'HEAL_VERIFY_STATES');
    const literal = /export const healVerifyStateSchema = z\.enum\(\[([\s\S]*?)\]\)/.exec(
      schemasSrc,
    );
    expect(literal, 'healVerifyStateSchema is not declared as a z.enum literal').not.toBeNull();
    const fromSchemas = [...literal![1]!.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]!);
    expect(fromSchemas).toEqual(fromHealer);
  });

  it('still has no NOT_VERIFIED member', () => {
    // "Nothing checked" is NULL, which says "no claim" in a way no member of
    // the list could. The whole point is that it and "the check passed" are
    // never the same value.
    expect(tsConstMembers(healerSrc, 'HEAL_VERIFY_STATES')).not.toContain('NOT_VERIFIED');
  });
});

describe('what was deliberately NOT made a Prisma enum is written down', () => {
  it('records why the denominator effect has no column', () => {
    // A doc comment that contradicts the code under it is one of the lies this
    // product cannot afford. The reason is in the script beside the pairs, so
    // the next person does not add a fifth type to "be consistent".
    expect(script).toContain('DENOMINATOR_EFFECTS');
    expect(script).toContain('denominatorEffectOf');
  });

  it('records why the ownership STATE stays TEXT', () => {
    expect(script).toContain('`OWNERSHIP_STATES` is not paired either');
  });
});
