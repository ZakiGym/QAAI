import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The drift guard's own guard for the six enums the security round added, the
 * eight tables, the twenty-four columns, and the hand-written migration that
 * creates them.
 *
 * ── Why a seventh file beside the other six ─────────────────────────────────
 *
 * `check-enums.pairs.test.ts` pins the requirements round,
 * `check-enums.auth-and-access.test.ts` the auth round,
 * `check-enums.measurement.test.ts` the measurement round,
 * `check-enums.dimensions.test.ts` the dimension round,
 * `check-enums.craft.test.ts` the craft round and
 * `check-enums.suppression.test.ts` the suppression round; each names its own
 * migration directory and asserts facts about that SQL. Adding a seventh
 * round's assertions to any of them would make one file responsible for two
 * migrations and leave no obvious place for the eighth. The durable,
 * round-independent assertion all of them carry — "pair every enum the new
 * models store" — is repeated here against THIS round's models for the same
 * reason: it is the one that catches the next person rather than this change,
 * and it is how `TestResultStatus` and `AuthProfileKind` were both found.
 *
 * ── The assertions that are NOT about drift ────────────────────────────────
 *
 * Three groups below are about the migration's BEHAVIOUR rather than its
 * parity, and they are here because there is nowhere else they can live: SQL is
 * not typechecked and not imported, so a statement that silently stopped being
 * in the file would be caught by nothing. They are:
 *
 *   · the plaintext sessions are DESTROYED and both columns are nulled together
 *     (the one destructive thing this migration does);
 *   · every NOT NULL column added to a populated table carries a DEFAULT;
 *   · no column on `LoginAttempt` or `LoginThrottle` could hold a credential.
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
const SEALED = fileURLToPath(new URL('../../../packages/shared/src/sealed.ts', import.meta.url));
const EGRESS = fileURLToPath(new URL('../../../packages/shared/src/egress.ts', import.meta.url));
const CONSTANTS = fileURLToPath(
  new URL('../../../packages/shared/src/constants.ts', import.meta.url),
);

const schema = readFileSync(SCHEMA, 'utf8');
const script = readFileSync(SCRIPT, 'utf8');
const sealedSrc = readFileSync(SEALED, 'utf8');
const egressSrc = readFileSync(EGRESS, 'utf8');
const constantsSrc = readFileSync(CONSTANTS, 'utf8');

/**
 * This round's migration directory, and the newest one that PRECEDED it.
 *
 * `PREVIOUS_NEWEST` is pinned by NAME and not by "the second newest directory",
 * for the reason every file in this series records: a test asserting "this is
 * the newest migration" breaks on the next round's migration, which makes the
 * next person delete the assertion instead of reading it.
 */
const MIGRATION_DIR =
  '20261029200000_vault_key_rotation_sealed_sessions_secret_scoping_egress_policy_and_auth_platform';
const PREVIOUS_NEWEST =
  '20261029160000_run_selection_source_preflight_evidence_and_ownership_rule_source';
const migration = readFileSync(`${MIGRATIONS}/${MIGRATION_DIR}/migration.sql`, 'utf8');

/**
 * The executable half of the migration: every comment line removed.
 *
 * Doubly load-bearing, as the measurement round paid a failure to learn. The
 * revert instructions at the bottom are a commented-out mirror image of
 * everything above, so a search of the whole file can be satisfied by the
 * rollback — and this migration's header quotes its own UPDATE statements in
 * prose, so an assertion over the raw text would be satisfied by the paragraph
 * that describes them.
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

/** The six Prisma enums this round introduced. */
const NEW_PAIRS = [
  'VaultKeyState',
  'VaultKeyProvider',
  'KeyRotationState',
  'SecretScopeKind',
  'EgressOutcome',
  'LoginAttemptOutcome',
] as const;

/** The models this round introduced. */
const NEW_MODELS = [
  'VaultKey',
  'KeyRotationSweep',
  'SecretScope',
  'EgressAllowlistEntry',
  'EgressDecisionTally',
  'TotpRecoveryCode',
  'LoginThrottle',
  'LoginAttempt',
] as const;

/**
 * ENUMS A NEW MODEL STORES THAT THE DRIFT GUARD STILL CANNOT SEE.
 *
 * EMPTY, and the mechanism stays. The set is kept rather than deleted and the
 * test below asserts it is EMPTY, because an exception list that only exists
 * while it has a member is an exception list somebody has to re-invent — and
 * re-inventing it is how the next unpaired enum gets quietly skipped instead of
 * recorded.
 */
const KNOWN_UNPAIRED = new Set<string>();

describe('the PAIRS list grew', () => {
  it('names all six new enums', () => {
    const paired = pairedEnums();
    for (const prismaEnum of NEW_PAIRS) expect(paired).toContain(prismaEnum);
  });

  it('still names the ones that were there before', () => {
    // Named rather than counted. A count would be satisfied by swapping one of
    // these out for one of the six, and the whole value of a drift guard is
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
      'SuppressionKind',
      'OwnerProvenance',
    ]) {
      expect(paired).toContain(before);
    }
  });

  it('reads the two new vocabularies from the files that hold them', () => {
    // A pair whose `source` is wrong fails at run time with "declaration not
    // found", which `check-enums.ts` reports as drift — but only if the source
    // entry exists at all. These two lines are what make that possible.
    expect(script).toContain("sealed: { text: sealed, label: 'shared/sealed.ts' }");
    expect(script).toContain("egress: { text: egress, label: 'shared/egress.ts' }");
  });

  it('pairs every enum the new models store', () => {
    // THE DURABLE ASSERTION. This is how `TestResultStatus` (the enum the whole
    // product's pass/fail arithmetic rests on) and `AuthProfileKind` were both
    // found with no drift guard. It catches the NEXT round, not this one.
    const paired = pairedEnums();
    const declared = [...schema.matchAll(/\benum\s+(\w+)\s*\{/g)].map((m) => m[1]!);
    for (const model of NEW_MODELS) {
      const body = modelBody(model);
      for (const enumName of declared) {
        if (KNOWN_UNPAIRED.has(enumName)) continue;
        if (!new RegExp(`^\\s+\\w+\\s+${enumName}[?\\[]?\\s`, 'm').test(body)) continue;
        expect(paired, `${model} stores ${enumName}`).toContain(enumName);
      }
    }
  });

  it('has no unpaired-enum exceptions left', () => {
    expect([...KNOWN_UNPAIRED]).toEqual([]);
  });
});

describe('schema.prisma, the TypeScript mirror and the SQL agree', () => {
  it('matches member for member, in order, for all six', () => {
    const mirrors: Record<(typeof NEW_PAIRS)[number], string[]> = {
      VaultKeyState: tsConstMembers(sealedSrc, 'VAULT_KEY_STATES'),
      VaultKeyProvider: tsConstMembers(sealedSrc, 'VAULT_KEY_PROVIDERS'),
      KeyRotationState: tsConstMembers(sealedSrc, 'KEY_ROTATION_STATES'),
      SecretScopeKind: tsConstMembers(constantsSrc, 'SECRET_SCOPE_KINDS'),
      EgressOutcome: tsConstMembers(egressSrc, 'EGRESS_OUTCOMES'),
      LoginAttemptOutcome: tsConstMembers(constantsSrc, 'LOGIN_ATTEMPT_OUTCOMES'),
    };
    for (const name of NEW_PAIRS) {
      expect(prismaEnumMembers(name), name).toEqual(mirrors[name]);
      // Order too, not just membership. Postgres enum order is the sort order,
      // so a type created with its members shuffled sorts a cockpit list
      // differently from the one the schema describes.
      expect(sqlEnumMembers(name), name).toEqual(mirrors[name]);
    }
  });

  it('keeps ACTIVE the only writable key state, in every spelling of the list', () => {
    // A fifth state, or a reordering that put READABLE first, would change
    // which key `selectSealingKey` finds — and sealing under a key that is
    // about to be retired is how a rotation ends by losing data.
    expect(prismaEnumMembers('VaultKeyState')).toEqual([
      'ACTIVE',
      'READABLE',
      'RETIRED',
      'COMPROMISED',
    ]);
  });

  it('keeps WOULD_REFUSE in the outcome enum', () => {
    // Without it an observed refusal has nowhere to be recorded but ALLOWED,
    // which is a refusal applied-or-not without being counted.
    expect(prismaEnumMembers('EgressOutcome')).toContain('WOULD_REFUSE');
  });

  it('keeps BAD_TOTP in the login outcome enum', () => {
    // The member this round exists for. It has never been reachable, because
    // auth.ts checks that a code was supplied and never looks at its value.
    expect(prismaEnumMembers('LoginAttemptOutcome')).toContain('BAD_TOTP');
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

  it('adds every column the schema added to an existing table', () => {
    const added = [
      ['User', 'totpSecretKeyVersion'],
      ['User', 'totpConfirmedAt'],
      ['Organization', 'enforceSso'],
      ['Organization', 'securityControlModes'],
      ['Organization', 'loginThrottlePolicy'],
      ['Session', 'deviceLabel'],
      ['Session', 'lastSeenAt'],
      ['Session', 'revokedReason'],
      ['Session', 'revokedBy'],
      ['ApiKey', 'rotatedAt'],
      ['ApiKey', 'replacesKeyId'],
      ['ApiKey', 'rotationGraceUntil'],
      ['Environment', 'egressPolicy'],
      ['AuthProfile', 'storageStateSealed'],
      ['AuthProfile', 'storageStateKeyVersion'],
      ['AuthProfile', 'storageStateSealedAt'],
      ['AuthProfile', 'storageStateNeedsReseal'],
      ['AuthProfile', 'storageStateRefreshedAt'],
      ['AuthProfile', 'storageStateRefreshAttemptedAt'],
      ['AuthProfile', 'storageStateRefreshFailures'],
    ] as const;
    for (const [table, column] of added) {
      expect(executable, `${table}.${column}`).toContain(
        `ALTER TABLE "${table}" ADD COLUMN "${column}"`,
      );
      // And the other direction: the schema declares it too, so a column in the
      // SQL that Prisma does not know about cannot hide here.
      expect(modelBody(table), `${table}.${column}`).toContain(column);
    }
  });

  it('gives every NOT NULL column added to a populated table a DEFAULT', () => {
    // NOT NULL without a default fails outright on a non-empty table. The three
    // that are NOT NULL here all carry a default, and each default is the state
    // the existing rows are genuinely in: no org enforces SSO today, no new
    // profile needs a re-seal, and no refresh has failed because none has ever
    // been attempted.
    let notNullColumns = 0;
    for (const line of executable.split('\n')) {
      if (!line.startsWith('ALTER TABLE') || !line.includes('ADD COLUMN')) continue;
      if (!line.includes('NOT NULL')) continue;
      notNullColumns += 1;
      expect(line).toContain('DEFAULT');
    }
    expect(notNullColumns).toBe(3);
  });

  it('does not back-fill totpConfirmedAt from totpEnabledAt', () => {
    // Doing so would assert that a code verified for every user who ever opened
    // the enrolment screen, and the whole reason the column exists is that no
    // code was ever checked.
    expect(executable).not.toMatch(/"totpConfirmedAt"\s*=\s*"?totpEnabledAt/i);
    expect(executable).not.toMatch(/UPDATE "User"/);
  });

  it('does not back-fill ApiKey.scopes, and says why in the file', () => {
    // Back-filling the empty arrays would be a DDL script making a privilege
    // decision about keys nobody has looked at, with no audit entry.
    expect(executable).not.toMatch(/UPDATE "ApiKey"/);
    expect(migration).toContain('left EXACTLY AS IT IS');
  });

  it('seeds no VaultKey row', () => {
    // A seeded row would be this migration asserting, about a database it
    // cannot read, that VAULT_MASTER_KEY is the key that sealed the existing
    // secrets.
    expect(executable).not.toMatch(/INSERT INTO/i);
  });
});

describe('the plaintext sessions are actually destroyed', () => {
  it('nulls storageState AND storageStateExpiresAt in the same statement', () => {
    // Nulling the state and leaving the expiry would make the check in
    // apps/api/src/routes/projects.ts report a VALID session for a profile that
    // has none — two facts in one field, which is a defect even when both
    // values are individually defensible.
    const update = /UPDATE "AuthProfile"\s+SET "storageState" = NULL,\s+"storageStateExpiresAt" = NULL\s+WHERE "storageState" IS NOT NULL;/.exec(
      executable,
    );
    expect(update).not.toBeNull();
  });

  it('marks the row for re-seal BEFORE destroying the plaintext', () => {
    // If the destroy fails the row is marked and still has its plaintext, which
    // is recoverable. Reversed, a failed marking leaves a row with no session
    // and nothing saying so — which reads exactly like a profile nobody has
    // ever signed in as, and sends the next reader looking for a bug in the
    // sign-in path.
    const mark = executable.indexOf('"storageStateNeedsReseal" = true');
    const destroy = executable.indexOf('SET "storageState" = NULL');
    expect(mark).toBeGreaterThan(-1);
    expect(destroy).toBeGreaterThan(-1);
    expect(mark).toBeLessThan(destroy);
  });

  it('does NOT drop the legacy column in the same migration', () => {
    // apps/worker/src/processors/explore.ts and apps/api/src/routes/projects.ts
    // still name it, so dropping it here would be a deploy that fails on the
    // old image.
    expect(executable).not.toContain('DROP COLUMN "storageState"');
  });

  it('says in the schema that the column must never be written again', () => {
    // A doc comment that contradicts the code under it is the worst kind in a
    // security file, so the claim and the SQL are asserted together.
    expect(modelBody('AuthProfile')).toContain('WRITE NOTHING HERE EVER AGAIN');
    expect(migration).toContain('IT DELETES THEM');
  });

  it('states what a revert costs rather than leaving it to be discovered', () => {
    expect(migration).toContain('REVERT');
    expect(migration).toContain('THE DELETED SESSIONS DO NOT COME BACK');
    expect(migration).toContain('PERMANENTLY UNREADABLE');
  });
});

describe('no new table could hold a credential', () => {
  it('keeps the login tables to an outcome, a hash, an IP and a user agent', () => {
    // NEVER THE PASSWORD, NEVER THE CODE, NEVER A TOKEN. Asserted as the
    // absence of a column that could hold one, because a reviewer reading the
    // model will believe the doc comment.
    for (const model of ['LoginAttempt', 'LoginThrottle'] as const) {
      const body = modelBody(model);
      for (const forbidden of ['password', 'totp', 'code', 'token', 'secret', 'cookie']) {
        expect(body.toLowerCase().replace(/\/\/\/[^\n]*/g, ''), `${model}.${forbidden}`).not.toMatch(
          new RegExp(`^\\s+\\w*${forbidden}\\w*\\s+`, 'mi'),
        );
      }
    }
  });

  it('stores a recovery code only as a hash, with a per-code usedAt', () => {
    const body = modelBody('TotpRecoveryCode');
    expect(body).toContain('codeHash String @unique');
    // A code that works twice is a code that is not single-use.
    expect(body).toContain('usedAt');
    expect(body).not.toMatch(/^\s+code\s+String/m);
  });

  it('keeps key MATERIAL out of the VaultKey row', () => {
    const body = modelBody('VaultKey');
    expect(body).toContain('providerRef');
    for (const forbidden of ['material', 'keyBytes', 'secret', 'privateKey']) {
      expect(body, forbidden).not.toMatch(new RegExp(`^\\s+${forbidden}\\s+`, 'mi'));
    }
  });

  it('keeps a URL PATH out of the egress tally', () => {
    // For a webhook the path IS the bearer credential.
    const body = modelBody('EgressDecisionTally');
    expect(body).toContain('host');
    expect(body).not.toMatch(/^\s+(path|url|target)\s+String/m);
  });
});

describe('the sealed field vocabulary reaches the sweep', () => {
  it('names AuthProfile.storageState, so a rotation can visit it', () => {
    // A minted column owes a reader. A sealed field with no entry in
    // SEALED_FIELDS is a row no sweep will ever re-seal, which is a row that
    // stays readable under a compromised key for ever.
    expect(sealedSrc).toContain("'AuthProfile.storageState'");
    expect(modelBody('KeyRotationSweep')).toContain('fieldKey');
  });

  it('indexes the two reads a sweep makes on AuthProfile', () => {
    const body = modelBody('AuthProfile');
    expect(body).toContain('@@index([storageStateKeyVersion])');
    expect(body).toContain('@@index([storageStateNeedsReseal])');
  });
});
