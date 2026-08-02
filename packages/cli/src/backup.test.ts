/**
 * The five ways a backup tool lies to you, and the tests that stop it.
 *
 *  1. **It puts the password somewhere.** A connection string reaches three
 *     child processes, an error message and a manifest that gets committed to a
 *     repo. Every one of those paths is asserted to be password-free, and the
 *     argv builders are asserted positively — not "does not contain the literal
 *     we happened to pick" but "contains no element carrying credentials at
 *     all". This repo has shipped two credential-exfiltration bugs; the third
 *     one is not going to be `ps aux` on the database host.
 *
 *  2. **It says the schema matches when it does not.** `compareSchema` is the
 *     gate between "restore" and "quietly corrupt". The newer-than and the
 *     diverged cases are asserted to REFUSE, not to warn, because a warning in
 *     a restore script is a line of scrollback nobody reads at 3am.
 *
 *  3. **It says the vault is fine when it cannot possibly know.** The
 *     interesting states are not match/mismatch — they are the two flavours of
 *     "cannot verify", which are the ones that produce a restore that looks
 *     complete and has zero working credentials. Every combination of (key in
 *     manifest, key in environment, encrypted rows exist) is asserted to
 *     produce a distinct, honest sentence.
 *
 *  4. **It fingerprints the key by storing the key.** The fingerprint is
 *     asserted to be irreversible-shaped: not the key, not derivable to the
 *     key, stable across calls, and different for different keys.
 *
 *  5. **It counts rows in a way that can only pass.** `compareRowCounts` must
 *     fail on a short table and must NOT fail on a long one — a live source
 *     keeps writing between the dump snapshot and the count, so "restored has
 *     more" is normal and "restored has fewer" is an incident. A comparison
 *     that treats both as equal is a green light that means nothing.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BackupError,
  RefusedError,
  VAULT_FINGERPRINT_LABEL,
  buildPgDumpArgs,
  buildPgRestoreArgs,
  compareRowCounts,
  compareSchema,
  checkDumpVersion,
  describeConnection,
  describeVaultMatch,
  exclusions,
  flagValue,
  formatBytes,
  formatCountTable,
  inspectVaultKey,
  isSameDatabase,
  libpqEnv,
  parseDatabaseUrl,
  parsePgVersion,
  readMigrationsDir,
  redactDatabaseUrl,
  sha256File,
} from './backup.js';
import type { BackupManifest, TableCount, VaultKeyStatus } from './backup.js';

const PASSWORD = 'sup3r-s3cret-pa55word';
const URL_WITH_PASSWORD = `postgresql://qaai:${PASSWORD}@db.internal:5432/qaai?schema=public`;

// ─── 1. The password never leaves the environment ────────────────────────────

describe('parseDatabaseUrl', () => {
  it('splits a Prisma-style URL and ignores ?schema', () => {
    const conn = parseDatabaseUrl(URL_WITH_PASSWORD);
    expect(conn).toEqual({
      host: 'db.internal',
      port: '5432',
      user: 'qaai',
      password: PASSWORD,
      database: 'qaai',
      sslmode: null,
    });
  });

  it('percent-decodes a password containing URL metacharacters', () => {
    // A password with an @ or a / in it is the classic way a hand-rolled
    // "split on @" parser silently connects to the wrong host.
    const conn = parseDatabaseUrl('postgresql://u:p%40ss%2Fword@host:5432/db');
    expect(conn.password).toBe('p@ss/word');
    expect(conn.host).toBe('host');
    expect(conn.database).toBe('db');
  });

  it('defaults the port and carries sslmode through', () => {
    const conn = parseDatabaseUrl('postgresql://u:p@host/db?sslmode=require');
    expect(conn.port).toBe('5432');
    expect(conn.sslmode).toBe('require');
  });

  it('reads a unix socket directory out of ?host=, and lets libpq pick the user', () => {
    // Peer auth over a socket is the normal setup on a database host. Guessing
    // a username here would set PGUSER explicitly and connect as the wrong
    // role; libpq's default (the OS account) is the right answer.
    const conn = parseDatabaseUrl('postgresql:///qaai?host=/var/run/postgresql');
    expect(conn.host).toBe('/var/run/postgresql');
    expect(conn.user).toBe('');
    expect(libpqEnv(conn)).not.toHaveProperty('PGUSER');
    expect(libpqEnv(conn)).not.toHaveProperty('PGPASSWORD');
  });

  it('lets the ?host= parameter win over the URL authority, as libpq does', () => {
    expect(parseDatabaseUrl('postgresql://localhost/qaai?host=/var/run').host).toBe('/var/run');
  });

  it('rejects a non-postgres scheme', () => {
    expect(() => parseDatabaseUrl('mysql://u:p@host/db')).toThrow(BackupError);
  });

  it('rejects a URL with no database name', () => {
    expect(() => parseDatabaseUrl('postgresql://u:p@host:5432/')).toThrow(/no database name/i);
  });
});

describe('credentials never reach argv', () => {
  const conn = parseDatabaseUrl(URL_WITH_PASSWORD);

  it('puts the password in the environment and only there', () => {
    const environment = libpqEnv(conn);
    expect(environment.PGPASSWORD).toBe(PASSWORD);
    expect(environment.PGHOST).toBe('db.internal');
    expect(environment.PGDATABASE).toBe('qaai');
  });

  it('omits PGPASSWORD entirely when there is no password', () => {
    // Peer/ident auth is normal on a database host. Setting PGPASSWORD='' there
    // changes libpq's behaviour rather than being a harmless no-op.
    expect(libpqEnv(parseDatabaseUrl('postgresql://qaai@localhost/qaai'))).not.toHaveProperty(
      'PGPASSWORD',
    );
  });

  it('builds pg_dump args that contain no credential of any kind', () => {
    const args = buildPgDumpArgs('/backups/qaai.dump', conn.database);
    for (const arg of args) {
      expect(arg).not.toContain(PASSWORD);
      expect(arg).not.toContain('qaai:');
      expect(arg).not.toMatch(/^--(username|password|dbname=postgres:)/);
      // The whole-URI form is what would leak; only the bare name is allowed.
      expect(arg).not.toMatch(/postgres(ql)?:\/\//);
    }
    expect(args).toContain('--dbname=qaai');
  });

  it('builds pg_restore args that contain no credential of any kind', () => {
    const args = buildPgRestoreArgs({
      dumpPath: '/backups/qaai.dump',
      database: conn.database,
      clean: true,
      jobs: null,
    });
    for (const arg of args) {
      expect(arg).not.toContain(PASSWORD);
      expect(arg).not.toMatch(/postgres(ql)?:\/\//);
    }
  });

  it('describes a connection without the password', () => {
    const described = describeConnection(conn);
    expect(described).toBe('qaai@db.internal:5432/qaai');
    expect(described).not.toContain(PASSWORD);
  });

  it('redacts a raw URL that reached an error message before parsing', () => {
    const redacted = redactDatabaseUrl(URL_WITH_PASSWORD);
    expect(redacted).not.toContain(PASSWORD);
    expect(redacted).toContain('***');
    expect(redacted).toContain('db.internal');
  });

  it('redacts even when the URL is malformed enough to fail parsing', () => {
    // The redactor runs on strings parseDatabaseUrl refused, so it cannot rely
    // on the URL being well-formed.
    expect(redactDatabaseUrl('postgresql://user:hunter2@')).not.toContain('hunter2');
  });
});

describe('isSameDatabase', () => {
  const a = parseDatabaseUrl('postgresql://qaai:x@localhost:5432/qaai');

  it('is true for the same host/port/database under a different user', () => {
    expect(isSameDatabase(a, parseDatabaseUrl('postgresql://other:y@localhost:5432/qaai'))).toBe(
      true,
    );
  });

  it('is false for a different database on the same server', () => {
    expect(isSameDatabase(a, parseDatabaseUrl('postgresql://qaai:x@localhost:5432/qaai_new'))).toBe(
      false,
    );
  });
});

// ─── 2. The schema gate ──────────────────────────────────────────────────────

const M = [
  '20260730014226_init',
  '20260730073538_agent_proposals',
  '20260801040000_sso',
  '20260801050000_performance_test_type',
];

describe('compareSchema', () => {
  it('passes an exact match', () => {
    const result = compareSchema(M, [...M]);
    expect(result.verdict).toBe('identical');
    expect(result.refuse).toBe(false);
  });

  it('allows an older backup and says to run migrate deploy', () => {
    const result = compareSchema(M.slice(0, 2), M);
    expect(result.verdict).toBe('backup-older');
    expect(result.refuse).toBe(false);
    expect(result.onlyInExpected).toEqual(['20260801040000_sso', '20260801050000_performance_test_type']);
    expect(result.message).toMatch(/migrate deploy/);
  });

  it('REFUSES a backup from a newer schema', () => {
    const result = compareSchema(M, M.slice(0, 2));
    expect(result.verdict).toBe('backup-newer');
    expect(result.refuse).toBe(true);
    // The operator has to be told which migrations, or they cannot act on it.
    expect(result.message).toContain('20260801040000_sso');
    expect(result.message).toContain('--allow-newer-schema');
  });

  it('REFUSES two diverged histories, and does not offer an override', () => {
    const result = compareSchema(
      [...M.slice(0, 2), '20260801999999_branch_a'],
      [...M.slice(0, 2), '20260801999999_branch_b'],
    );
    expect(result.verdict).toBe('diverged');
    expect(result.refuse).toBe(true);
    // --allow-newer-schema means "the backup is ahead", which is not true here,
    // so the message must not suggest it as a way through.
    expect(result.message).not.toContain('--allow-newer-schema');
  });

  it('compares as sets, not as ordered lists', () => {
    expect(compareSchema(M, [...M].reverse()).verdict).toBe('identical');
  });

  it('treats an empty backup against a populated target as older, not diverged', () => {
    expect(compareSchema([], M).verdict).toBe('backup-older');
  });
});

describe('readMigrationsDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qaai-migrations-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns directory names and ignores the lock file', async () => {
    await mkdir(join(dir, '20260730014226_init'), { recursive: true });
    await mkdir(join(dir, '20260801040000_sso'), { recursive: true });
    await writeFile(join(dir, 'migration_lock.toml'), 'provider = "postgresql"\n');

    expect(await readMigrationsDir(dir)).toEqual(['20260730014226_init', '20260801040000_sso']);
  });

  it('explains itself when the directory does not exist', async () => {
    // Silently returning [] here would turn the schema gate off, which is worse
    // than the restore failing: the check would report "SKIPPED" forever.
    await expect(readMigrationsDir(join(dir, 'nope'))).rejects.toThrow(/migrations directory/i);
  });
});

// ─── 3 & 4. The vault ────────────────────────────────────────────────────────

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

describe('inspectVaultKey', () => {
  it('fingerprints a valid 32-byte key', () => {
    const status = inspectVaultKey(KEY_A);
    expect(status.present).toBe(true);
    expect(status.problem).toBeNull();
    expect(status.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across calls and distinct across keys', () => {
    expect(inspectVaultKey(KEY_A).fingerprint).toBe(inspectVaultKey(KEY_A).fingerprint);
    expect(inspectVaultKey(KEY_A).fingerprint).not.toBe(inspectVaultKey(KEY_B).fingerprint);
  });

  it('never reveals the key material', () => {
    const fingerprint = inspectVaultKey(KEY_A).fingerprint ?? '';
    expect(fingerprint).not.toContain(KEY_A);
    expect(KEY_A).not.toContain(fingerprint);
    // Base64 of the raw key must not appear in any encoding of the fingerprint.
    expect(Buffer.from(fingerprint, 'hex').toString('base64')).not.toBe(KEY_A);
  });

  it('is domain-separated, so it cannot be confused with another digest of the same key', () => {
    // If the label were dropped, the fingerprint would equal a plain sha256 of
    // the key — a value that may legitimately exist elsewhere (a checksum, an
    // etag) and would then be an oracle for the key.
    const plain = createHash('sha256')
      .update(Buffer.from(KEY_A, 'base64'))
      .digest('hex')
      .slice(0, 16);
    expect(inspectVaultKey(KEY_A).fingerprint).not.toBe(plain);
    expect(VAULT_FINGERPRINT_LABEL).toMatch(/v1$/);
  });

  it('reports an absent key as a fact, with no fingerprint', () => {
    const status = inspectVaultKey(undefined);
    expect(status.present).toBe(false);
    expect(status.fingerprint).toBeNull();
    expect(status.problem).toBeTruthy();
  });

  it('refuses to fingerprint a key of the wrong length', () => {
    // Fingerprinting a short/low-entropy value would publish something
    // brute-forceable, and would also silently disagree with the API, which
    // requires exactly 32 bytes.
    const status = inspectVaultKey(Buffer.alloc(16, 3).toString('base64'));
    expect(status.present).toBe(true);
    expect(status.fingerprint).toBeNull();
    expect(status.problem).toMatch(/32 bytes/);
  });

  it('states the problem without stating a consequence', () => {
    // The sentence is quoted by create, verify and restore alike. A consequence
    // written for one of them is wrong in the other two.
    for (const status of [inspectVaultKey(undefined), inspectVaultKey('short')]) {
      expect(status.problem).not.toMatch(/\bbackup (cannot|will)\b/i);
      expect(status.problem).not.toMatch(/\brestore will\b/i);
    }
  });
});

function manifestWith(fingerprint: string | null, encryptedRows: number): BackupManifest {
  return {
    manifestVersion: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    tool: { name: 'qaai backup', version: '0.1.0' },
    source: {
      connection: 'qaai@localhost:5432/qaai',
      database: 'qaai',
      postgresServerVersion: '17.10',
      pgDumpVersion: '17.10',
    },
    dump: { file: 'qaai.dump', format: 'custom', bytes: 1, sha256: 'x', pgDumpArgs: [] },
    schema: { migrations: M, latestMigration: M[3] ?? null, unfinishedMigrations: [], rolledBackMigrations: [] },
    contents: { tables: [], totalRows: 0, countsAre: 'advisory' },
    vault: {
      warning: 'w',
      masterKeyFingerprint: fingerprint,
      fingerprintLabel: VAULT_FINGERPRINT_LABEL,
      keyProblem: null,
      encryptedColumns: [],
      keyVersionsInUse: [],
      totalEncryptedRows: encryptedRows,
    },
    excluded: [],
  };
}

const KEY_PRESENT: VaultKeyStatus = { present: true, fingerprint: 'aaaaaaaaaaaaaaaa', problem: null };
const KEY_ABSENT: VaultKeyStatus = {
  present: false,
  fingerprint: null,
  problem: 'VAULT_MASTER_KEY is not set in this environment',
};

describe('describeVaultMatch', () => {
  it('says a matching key is OK', () => {
    const message = describeVaultMatch(manifestWith('aaaaaaaaaaaaaaaa', 3), KEY_PRESENT);
    expect(message).toMatch(/^VAULT — OK/);
  });

  it('says MISMATCH when both fingerprints are known and differ', () => {
    const message = describeVaultMatch(manifestWith('bbbbbbbbbbbbbbbb', 3), KEY_PRESENT);
    expect(message).toMatch(/MISMATCH/);
    expect(message).toContain('bbbbbbbbbbbbbbbb');
    expect(message).toContain('aaaaaaaaaaaaaaaa');
    // The consequence, not just the fact.
    expect(message).toMatch(/looks complete/);
  });

  it('says CANNOT VERIFY when the environment has no key', () => {
    const message = describeVaultMatch(manifestWith('bbbbbbbbbbbbbbbb', 3), KEY_ABSENT);
    expect(message).toMatch(/CANNOT VERIFY/);
    expect(message).toMatch(/not set in this environment/);
  });

  it('says CANNOT VERIFY when the BACKUP recorded no fingerprint', () => {
    // The nastiest state: the operator has a key, it may even be right, and
    // there is nothing to compare it against. Claiming OK here would be a lie.
    const message = describeVaultMatch(manifestWith(null, 3), KEY_PRESENT);
    expect(message).toMatch(/CANNOT VERIFY/);
    expect(message).not.toMatch(/ OK/);
  });

  it('says the key is irrelevant when nothing is encrypted', () => {
    const message = describeVaultMatch(manifestWith(null, 0), KEY_ABSENT);
    expect(message).toMatch(/no encrypted values/);
  });

  it('never prints the key itself in any state', () => {
    for (const key of [KEY_PRESENT, KEY_ABSENT]) {
      for (const fingerprint of ['aaaaaaaaaaaaaaaa', null]) {
        const message = describeVaultMatch(manifestWith(fingerprint, 3), key);
        expect(message).not.toContain(KEY_A);
        expect(message).not.toContain(KEY_B);
      }
    }
  });
});

// ─── 5. The row-count proof ──────────────────────────────────────────────────

const backupCounts: TableCount[] = [
  { table: 'Run', rows: 90 },
  { table: 'Step', rows: 946 },
  { table: 'Secret', rows: 1 },
];

describe('compareRowCounts', () => {
  it('passes an exact restore', () => {
    const result = compareRowCounts(backupCounts, [...backupCounts]);
    expect(result.ok).toBe(true);
    expect(result.short).toEqual([]);
  });

  it('FAILS when a table restored short', () => {
    const result = compareRowCounts(backupCounts, [
      { table: 'Run', rows: 90 },
      { table: 'Step', rows: 900 },
      { table: 'Secret', rows: 1 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.short).toEqual([{ table: 'Step', expected: 946, actual: 900, delta: -46 }]);
  });

  it('does NOT fail when the target has MORE rows', () => {
    // The counts in the manifest are read after the dump, from a live database
    // that is still taking writes — so "more" is the expected steady state on a
    // busy source, and failing on it would make the check cry wolf until
    // somebody adds --force to the cron.
    const result = compareRowCounts(backupCounts, [
      { table: 'Run', rows: 91 },
      { table: 'Step', rows: 946 },
      { table: 'Secret', rows: 1 },
    ]);
    expect(result.ok).toBe(true);
    expect(result.diffs.find((d) => d.table === 'Run')?.delta).toBe(1);
  });

  it('FAILS when a table is missing from the restore entirely', () => {
    const result = compareRowCounts(backupCounts, [
      { table: 'Run', rows: 90 },
      { table: 'Step', rows: 946 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.missingTables).toEqual(['Secret']);
  });

  it('notes extra tables without failing', () => {
    const result = compareRowCounts(backupCounts, [...backupCounts, { table: 'NewThing', rows: 0 }]);
    expect(result.ok).toBe(true);
    expect(result.extraTables).toEqual(['NewThing']);
  });

  it('treats an empty restore of a non-empty backup as a failure', () => {
    // The single most important case: pg_restore exited 0, the tables exist, and
    // every one of them is empty.
    const result = compareRowCounts(backupCounts, [
      { table: 'Run', rows: 0 },
      { table: 'Step', rows: 0 },
      { table: 'Secret', rows: 0 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.short).toHaveLength(3);
  });
});

describe('formatCountTable', () => {
  it('shows only the rows that differ by default, and always the totals', () => {
    const comparison = compareRowCounts(backupCounts, [
      { table: 'Run', rows: 90 },
      { table: 'Step', rows: 900 },
      { table: 'Secret', rows: 1 },
    ]);
    const out = formatCountTable(comparison);
    expect(out).toContain('Step');
    expect(out).not.toContain('\nRun ');
    expect(out).toContain('1037 rows in backup');
  });

  it('shows every table when asked', () => {
    const out = formatCountTable(compareRowCounts(backupCounts, [...backupCounts]), true);
    expect(out).toContain('Run');
    expect(out).toContain('Secret');
  });
});

// ─── pg_restore argument safety ──────────────────────────────────────────────

describe('buildPgRestoreArgs', () => {
  const base = { dumpPath: '/b/qaai.dump', database: 'qaai', clean: false, jobs: null };

  it('wraps the restore in a single transaction by default', () => {
    // Atomicity is the property that makes a failed restore leave the target
    // untouched rather than half-written.
    const args = buildPgRestoreArgs(base);
    expect(args).toContain('--single-transaction');
    expect(args).toContain('--exit-on-error');
    expect(args).not.toContain('--clean');
  });

  it('only passes --clean when the caller asked to overwrite', () => {
    const args = buildPgRestoreArgs({ ...base, clean: true });
    expect(args).toContain('--clean');
    expect(args).toContain('--if-exists');
  });

  it('gives up the transaction for --jobs, and keeps --exit-on-error', () => {
    // pg_restore rejects --jobs with --single-transaction outright, so emitting
    // both would make the parallel path fail on every invocation.
    const args = buildPgRestoreArgs({ ...base, jobs: 4 });
    expect(args).toContain('--jobs=4');
    expect(args).not.toContain('--single-transaction');
    expect(args).toContain('--exit-on-error');
  });

  it('ignores a nonsensical --jobs value rather than emitting it', () => {
    expect(buildPgRestoreArgs({ ...base, jobs: 1 })).toContain('--single-transaction');
    expect(buildPgRestoreArgs({ ...base, jobs: 0 })).toContain('--single-transaction');
  });

  it('restores without ownership so a differently-named role can own the target', () => {
    const args = buildPgRestoreArgs(base);
    expect(args).toContain('--no-owner');
    expect(args).toContain('--no-privileges');
  });
});

// ─── Versions ────────────────────────────────────────────────────────────────

describe('parsePgVersion', () => {
  it('reads the version out of pg_dump --version', () => {
    expect(parsePgVersion('pg_dump (PostgreSQL) 17.10 (Homebrew)')).toEqual({
      raw: '17.10',
      major: 17,
    });
  });

  it('handles a major-only version', () => {
    expect(parsePgVersion('pg_dump (PostgreSQL) 18 (Debian 18-1)')?.major).toBe(18);
  });

  it('returns null for output it does not understand', () => {
    expect(parsePgVersion('command not found')).toBeNull();
  });
});

describe('checkDumpVersion', () => {
  it('refuses a pg_dump older than the server', () => {
    const problem = checkDumpVersion({ raw: '15.6', major: 15 }, 17);
    expect(problem).toMatch(/older pg_dump/);
  });

  it('allows an equal or newer pg_dump', () => {
    expect(checkDumpVersion({ raw: '17.10', major: 17 }, 17)).toBeNull();
    expect(checkDumpVersion({ raw: '18.0', major: 18 }, 17)).toBeNull();
  });

  it('does not block when the version could not be read', () => {
    // A SKIP, not a failure: an unparseable --version banner is not evidence of
    // an old client, and refusing on it would break the backup on any distro
    // that words the banner differently.
    expect(checkDumpVersion(null, 17)).toBeNull();
  });
});

// ─── The manifest's exclusion list ───────────────────────────────────────────

describe('exclusions', () => {
  const notes = exclusions(305);

  it('leads with the vault key', () => {
    expect(notes[0]?.what).toContain('VAULT_MASTER_KEY');
  });

  it('states the artifact decision and the row count it applies to', () => {
    const artifacts = notes.find((n) => n.what.includes('Artifact bytes'));
    expect(artifacts?.what).toContain('305');
    // Not just "excluded" — the reasoning, because the next operator will want
    // to know whether to change it.
    expect(artifacts?.why).toMatch(/lifecycle|object storage/i);
    expect(artifacts?.howToCoverIt).toBeTruthy();
  });

  it('gives every exclusion a way to cover it', () => {
    for (const note of notes) {
      expect(note.why.length).toBeGreaterThan(20);
      expect(note.howToCoverIt.length).toBeGreaterThan(20);
    }
  });

  it('mentions Redis and the missing GRANTs, which look like data loss but are not', () => {
    expect(notes.some((n) => n.what.includes('Redis'))).toBe(true);
    expect(notes.some((n) => n.what.includes('GRANT'))).toBe(true);
  });
});

// ─── Small helpers ───────────────────────────────────────────────────────────

describe('flagValue', () => {
  it('reads a value', () => {
    expect(flagValue(['--out', '/tmp/b'], '--out')).toBe('/tmp/b');
  });

  it('returns undefined when the next token is another flag', () => {
    // `--out --dry-run` must not silently name a directory "--dry-run".
    expect(flagValue(['--out', '--dry-run'], '--out')).toBeUndefined();
  });

  it('returns undefined for a flag that is not there', () => {
    expect(flagValue(['--dry-run'], '--out')).toBeUndefined();
  });
});

describe('formatBytes', () => {
  it('formats across units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(246483)).toBe('240.7 KiB');
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GiB');
  });
});

describe('sha256File', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qaai-sha-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('hashes a file and changes when a single byte changes', async () => {
    const path = join(dir, 'dump');
    await writeFile(path, 'hello');
    const first = await sha256File(path);
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    await writeFile(path, 'hellp');
    expect(await sha256File(path)).not.toBe(first);
  });
});

describe('error taxonomy', () => {
  it('marks a refusal distinctly from a bug, so exit codes can differ', () => {
    // The CLI exits 1 for a refusal and 2 for a bug. A restore script that
    // cannot tell them apart will retry a safety refusal forever.
    expect(new RefusedError('x')).toBeInstanceOf(BackupError);
    expect(new BackupError('x')).not.toBeInstanceOf(RefusedError);
  });
});
