#!/usr/bin/env node
/**
 * `qaai backup` — the answer to the two questions every self-hosting buyer asks:
 * *how do I back it up*, and *have you ever restored from one*.
 *
 * ── The four rules this file is built around ────────────────────────────────
 *
 * 1. **A backup that looks complete and is not is worse than no backup.**
 *    Every one of these commands writes down what it did NOT capture, in the
 *    manifest, in words, next to what it did. The vault is the headline case
 *    (rule 3) but artifacts, Redis and the .env file are the same class of
 *    problem: an operator who thinks they have a full copy will not take a
 *    second one.
 *
 * 2. **Nothing here destroys data by default.** `create` refuses to overwrite an
 *    existing dump. `restore` refuses a non-empty target, refuses a backup from
 *    a newer schema, and refuses to write over the database the backup came
 *    from. Every refusal names the flag that would allow it, and every
 *    destructive restore is recorded in `restores.jsonl` beside the dump WITH
 *    the row counts it destroyed — because "we restored the wrong backup over
 *    prod" is a sentence that needs evidence attached to it afterwards.
 *
 * 3. **THE VAULT IS THE TRAP.** `Secret.valueEnc` and every other `*Enc` column
 *    are AES-256-GCM under `VAULT_MASTER_KEY`, and that key is NOT in the
 *    database. A `pg_dump` therefore captures every secret ROW and not one
 *    usable secret VALUE. Restore it without the key and the platform comes up
 *    looking healthy — projects, runs, history, all of it — and every test that
 *    needs a credential fails, forever, with no way to recover the plaintext
 *    from anything in the backup. The manifest records the key's FINGERPRINT
 *    and the per-column key VERSIONS. It never records the key.
 *
 * 4. **No secret in argv, ever.** libpq credentials go to the child through the
 *    environment (`PGPASSWORD`), never as a command-line argument, because argv
 *    is world-readable in `ps` on a shared host. Every connection string that
 *    reaches a log line, an error, or the manifest goes through
 *    `describeConnection()` first, which cannot emit a password because it
 *    never receives one.
 *
 * Spawns are `shell: false` with args as an array — no string this program
 * builds is ever parsed by a shell.
 *
 * No dependencies beyond Node built-ins: this runs on a customer's database
 * host, which is the machine least likely to have an npm tree on it.
 *
 * ── Exit codes ──────────────────────────────────────────────────────────────
 *   0  did the thing
 *   1  REFUSED for a safety reason — the message says which flag would allow it
 *   2  unexpected error (a bug)
 *   3  SKIPPED: a required tool is not installed. Not a failure — nothing was
 *      attempted, and the message names exactly what to install. A CI step that
 *      treats 3 as red is reporting a missing package as a broken backup.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { argv, env, exit, stderr, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

// ─── Errors ──────────────────────────────────────────────────────────────────

/** A message already fit to print. Anything else is a bug and prints a stack. */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/**
 * A required binary is not installed.
 *
 * Separate from BackupError because it is NOT a failure of the backup — it is a
 * backup that never started, and the operator needs a package name rather than
 * a stack trace. Exits 3 so a pipeline can tell "install postgresql-client"
 * apart from "your database is unreachable".
 */
export class MissingToolError extends BackupError {
  constructor(message: string) {
    super(message);
    this.name = 'MissingToolError';
  }
}

/** A safety rule said no. Always names the flag that would say yes. */
export class RefusedError extends BackupError {
  constructor(message: string) {
    super(message);
    this.name = 'RefusedError';
  }
}

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_BUG = 2;
export const EXIT_SKIPPED = 3;

// ─── Connections: credentials never touch argv ───────────────────────────────

export interface PgConnection {
  host: string;
  port: string;
  /**
   * Empty when the URL did not name one. NOT defaulted to "postgres": libpq
   * already defaults PGUSER to the OS account, and a peer-authenticated socket
   * connection relies on that. Substituting a guess here would set PGUSER
   * explicitly and connect as the wrong role — or fail to connect at all — on
   * exactly the setups that omit the user because they do not need one.
   */
  user: string;
  password: string;
  database: string;
  sslmode: string | null;
}

/**
 * Split a libpq/Prisma URL into parts.
 *
 * The password is separated here and put nowhere except `libpqEnv()`. Prisma's
 * `?schema=public` is not a libpq parameter and is deliberately ignored rather
 * than rejected — every DATABASE_URL in this repo carries it.
 */
export function parseDatabaseUrl(raw: string): PgConnection {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BackupError(
      'DATABASE_URL is not a URL. Expected postgresql://user:password@host:5432/dbname',
    );
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new BackupError(
      `Unsupported database URL scheme "${url.protocol.replace(':', '')}". This tool backs up PostgreSQL only.`,
    );
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) {
    throw new BackupError(
      'DATABASE_URL has no database name. Expected postgresql://user:password@host:5432/dbname',
    );
  }

  // A unix-socket connection is expressed as `?host=/var/run/postgresql`, in
  // which case the URL's own hostname is empty and meaningless.
  const socketHost = url.searchParams.get('host');

  return {
    // libpq's `host` parameter wins over the URL's authority when both are
    // present, which is how a socket path is expressed at all.
    host: socketHost ?? (url.hostname ? decodeURIComponent(url.hostname) : 'localhost'),
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    sslmode: url.searchParams.get('sslmode'),
  };
}

/**
 * The environment libpq reads credentials from.
 *
 * This is the ONLY place the password is used. pg_dump/pg_restore/psql all
 * accept a full connection URI on the command line, and every one of those
 * calls would publish the password to `ps` for the duration of the dump. On a
 * database host that is a shared machine by definition.
 */
export function libpqEnv(conn: PgConnection): Record<string, string> {
  const out: Record<string, string> = {
    PGHOST: conn.host,
    PGPORT: conn.port,
    PGDATABASE: conn.database,
    // Never prompt. A backup cron that blocks on a password prompt is a backup
    // that silently stops running.
    PGCONNECT_TIMEOUT: '10',
  };
  // Each of these is set only when we actually have one, so libpq's own
  // defaults survive. Setting PGUSER='' or PGPASSWORD='' is not a no-op.
  if (conn.user) out.PGUSER = conn.user;
  if (conn.password) out.PGPASSWORD = conn.password;
  if (conn.sslmode) out.PGSSLMODE = conn.sslmode;
  return out;
}

/** Safe to print, safe to store in the manifest: everything except the password. */
export function describeConnection(conn: PgConnection): string {
  return `${conn.user || '(default user)'}@${conn.host}:${conn.port}/${conn.database}`;
}

/**
 * Last-resort redaction for a URL that reached an error message.
 *
 * `describeConnection` is the right answer everywhere we have already parsed;
 * this exists for the paths that failed BEFORE parsing, where the raw string is
 * all we have and printing it verbatim would leak the password.
 */
export function redactDatabaseUrl(raw: string): string {
  return raw.replace(/(:\/\/[^:@/]*:)[^@/]*@/, '$1***@');
}

/** True when both sides name the same physical database. */
export function isSameDatabase(a: PgConnection, b: PgConnection): boolean {
  return a.host === b.host && a.port === b.port && a.database === b.database;
}

// ─── Spawning ────────────────────────────────────────────────────────────────

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a binary. `shell: false` (Node's default, stated explicitly because it is
 * a security property and not a preference) and args as an array, so nothing
 * this program assembles is ever parsed by a shell.
 */
async function run(
  bin: string,
  args: string[],
  extraEnv: Record<string, string>,
  installHint: string,
): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, {
      shell: false,
      env: { ...env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8');
    });

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        rejectPromise(new MissingToolError(installHint));
        return;
      }
      rejectPromise(new BackupError(`Could not run ${bin}: ${e.message}`));
    });

    child.on('close', (code) => {
      resolvePromise({ code: code ?? -1, stdout: out, stderr: err });
    });
  });
}

const CLIENT_INSTALL_HINT =
  'Install the PostgreSQL 17 client tools and re-run:\n' +
  '  macOS   brew install postgresql@17\n' +
  '  Debian  apt-get install postgresql-client-17\n' +
  '  RHEL    dnf install postgresql17';

function missingTool(bin: string): string {
  return `${bin} is not on PATH, so nothing was attempted.\n${CLIENT_INSTALL_HINT}`;
}

// ─── psql: reading facts out of the database ─────────────────────────────────

/** Field separator for psql's unaligned output. Never appears in our data. */
const FS = '\x1f';

/**
 * Run one query and return its rows as string cells.
 *
 * `--no-psqlrc` matters: an operator's ~/.psqlrc that sets a pager or turns on
 * aligned output would turn every parse below into garbage, and the failure
 * would look like a corrupt database rather than a dotfile.
 */
async function psqlRows(conn: PgConnection, sql: string): Promise<string[][]> {
  const result = await run(
    'psql',
    ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-F', FS, '-c', sql],
    libpqEnv(conn),
    missingTool('psql'),
  );

  if (result.code !== 0) {
    throw new BackupError(
      `Query against ${describeConnection(conn)} failed:\n${result.stderr.trim() || `psql exited ${result.code}`}`,
    );
  }

  return result.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split(FS));
}

/**
 * Exact row counts for every table, computed entirely server-side.
 *
 * `format('%I')` inside `query_to_xml` means the table identifiers come from the
 * catalog and are quoted by Postgres itself — this client never concatenates an
 * identifier into SQL. Exact counts, not `pg_stat_user_tables.n_live_tup`:
 * the estimates are what the autovacuum daemon last saw, and a verification
 * step that compares two estimates proves nothing.
 */
const COUNT_TABLES_SQL = `
SELECT t.table_name,
       (xpath('/row/c/text()', query_to_xml(
          format('select count(*) as c from public.%I', t.table_name),
          false, true, '')))[1]::text::bigint AS n
FROM information_schema.tables t
WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
ORDER BY 1`;

/**
 * The vault census: how many rows hold ciphertext, per column.
 *
 * Driven by the catalog (`column_name LIKE '%Enc'`) rather than a hard-coded
 * list, so a `*Enc` column added to the schema next month appears in the
 * manifest without anyone remembering to update this tool. A backup tool whose
 * idea of "what is encrypted" drifts from the schema is how the vault warning
 * quietly stops covering half the secrets.
 */
const ENCRYPTED_COLUMNS_SQL = `
SELECT c.table_name, c.column_name,
       (xpath('/row/c/text()', query_to_xml(
          format('select count(*) as c from public.%I where %I is not null', c.table_name, c.column_name),
          false, true, '')))[1]::text::bigint AS n
FROM information_schema.columns c
WHERE c.table_schema = 'public' AND c.column_name LIKE '%Enc'
ORDER BY 1, 2`;

/** Which key versions are actually in use, so a restore knows which keys it needs. */
const KEY_VERSIONS_SQL = `
SELECT c.table_name, c.column_name,
       coalesce((xpath('/row/c/text()', query_to_xml(
          format('select coalesce(string_agg(distinct %I::text, '','' order by %I::text), '''') as c from public.%I where %I is not null',
                 c.column_name, c.column_name, c.table_name, c.column_name),
          false, true, '')))[1]::text, '') AS versions
FROM information_schema.columns c
WHERE c.table_schema = 'public' AND lower(c.column_name) LIKE '%keyversion%'
ORDER BY 1, 2`;

const MIGRATIONS_SQL = `
SELECT migration_name,
       (finished_at IS NOT NULL)::text,
       (rolled_back_at IS NOT NULL)::text
FROM _prisma_migrations
ORDER BY started_at`;

export interface TableCount {
  table: string;
  rows: number;
}

export interface MigrationRow {
  name: string;
  finished: boolean;
  rolledBack: boolean;
}

function toCount(cell: string | undefined): number {
  const n = Number.parseInt(cell ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Postgres has two spellings for a true boolean and psql picks between them
 * depending on whether the value was cast: `SELECT true` prints `t`, while
 * `SELECT true::text` prints `true`. Accepting only one of them is how every
 * migration in the first run of this tool was reported as unfinished, and the
 * manifest recorded schema "(none)" for a fully migrated database — a wrong
 * answer that looked like a plausible one. Accept both.
 */
function toBool(cell: string | undefined): boolean {
  return cell === 't' || cell === 'true';
}

async function readTableCounts(conn: PgConnection): Promise<TableCount[]> {
  const rows = await psqlRows(conn, COUNT_TABLES_SQL);
  return rows.map((r) => ({ table: r[0] ?? '', rows: toCount(r[1]) }));
}

async function readMigrations(conn: PgConnection): Promise<MigrationRow[]> {
  // A database that has never had Prisma pointed at it has no _prisma_migrations
  // table. That is a legitimate state (a fresh restore target), not an error.
  const exists = await psqlRows(
    conn,
    `SELECT to_regclass('public._prisma_migrations') IS NOT NULL`,
  );
  if (!toBool(exists[0]?.[0])) return [];

  const rows = await psqlRows(conn, MIGRATIONS_SQL);
  return rows.map((r) => ({
    name: r[0] ?? '',
    finished: toBool(r[1]),
    rolledBack: toBool(r[2]),
  }));
}

// ─── Versions ────────────────────────────────────────────────────────────────

export interface ToolVersion {
  raw: string;
  major: number;
}

/** "pg_dump (PostgreSQL) 17.10 (Homebrew)" → { raw: "17.10", major: 17 }. */
export function parsePgVersion(output: string): ToolVersion | null {
  const match = /(\d+)(?:\.(\d+))?/.exec(output.replace(/^[^)]*\)\s*/, ''));
  if (!match) return null;
  const major = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(major)) return null;
  return { raw: match[2] ? `${match[1]}.${match[2]}` : `${match[1]}`, major };
}

/**
 * pg_dump older than the server produces a dump that is missing whatever the
 * newer server added, and says so only in a warning nobody reads. Refuse.
 */
export function checkDumpVersion(client: ToolVersion | null, serverMajor: number): string | null {
  if (!client) return null;
  if (client.major < serverMajor) {
    return (
      `pg_dump is version ${client.raw} but the server is ${serverMajor}. ` +
      `A dump taken by an older pg_dump can silently omit newer server features. ` +
      `Install the ${serverMajor} client tools and re-run.`
    );
  }
  return null;
}

// ─── The vault key: fingerprint it, never store it ───────────────────────────

/**
 * Domain separation label. Changing it invalidates every stored fingerprint, so
 * it is versioned and must never be edited in place.
 */
export const VAULT_FINGERPRINT_LABEL = 'qaai-backup-manifest/vault-key-fingerprint/v1';

export interface VaultKeyStatus {
  present: boolean;
  /** Non-reversible. Safe to commit, safe to email, safe in a public repo. */
  fingerprint: string | null;
  /** An actionable sentence when the key is present but unusable. */
  problem: string | null;
}

/**
 * Fingerprint VAULT_MASTER_KEY so a restore can answer "is this the same key
 * that encrypted these rows?" without either side ever handling the key.
 *
 * Safe to publish: the input is 32 bytes of CSPRNG output, so a truncated
 * SHA-256 over it has no shorter preimage than brute-forcing 2^256. This would
 * NOT be safe over a low-entropy secret like a password, which is why the
 * function insists on the same 32-byte rule `apps/api/src/lib/vault.ts` does
 * rather than fingerprinting whatever string it was handed.
 */
export function inspectVaultKey(raw: string | undefined): VaultKeyStatus {
  /*
   * These sentences state the FACT and stop there — no "so the backup cannot…"
   * or "so the restore will…". This function is called from create, verify and
   * restore, and a consequence written for one of them is wrong in the other
   * two: the first version explained a missing key as a backup-time problem,
   * which is what a restore then printed at the operator while they were
   * restoring. Each caller adds its own consequence.
   */
  if (!raw) {
    return {
      present: false,
      fingerprint: null,
      problem: 'VAULT_MASTER_KEY is not set in this environment',
    };
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    return {
      present: true,
      fingerprint: null,
      problem:
        'VAULT_MASTER_KEY is set but does not decode to 32 bytes of base64, so it is not the key ' +
        'the API is running with',
    };
  }

  const digest = createHash('sha256')
    .update(VAULT_FINGERPRINT_LABEL)
    .update('\n')
    .update(key)
    .digest('hex');

  return { present: true, fingerprint: digest.slice(0, 16), problem: null };
}

// ─── The manifest ────────────────────────────────────────────────────────────

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILE = 'manifest.json';
export const DUMP_FILE = 'qaai.dump';
export const RESTORE_LOG_FILE = 'restores.jsonl';

export interface ExclusionNote {
  what: string;
  why: string;
  howToCoverIt: string;
}

export interface BackupManifest {
  manifestVersion: number;
  createdAt: string;
  tool: { name: string; version: string };
  source: {
    /** Never a password: this string is built by describeConnection(). */
    connection: string;
    database: string;
    postgresServerVersion: string;
    pgDumpVersion: string | null;
  };
  dump: {
    file: string;
    format: 'custom';
    bytes: number;
    sha256: string;
    pgDumpArgs: string[];
  };
  schema: {
    /** Applied, finished, not-rolled-back migrations, in order. */
    migrations: string[];
    latestMigration: string | null;
    /** Started but never finished — a dump taken mid-migration. */
    unfinishedMigrations: string[];
    rolledBackMigrations: string[];
  };
  contents: {
    tables: TableCount[];
    totalRows: number;
    /**
     * Counts are read AFTER pg_dump returns, in a separate transaction, so on a
     * database that is still taking writes they are close but not identical to
     * what the dump's snapshot captured. Treat a small delta on a live source as
     * "expected"; treat a table that restores at zero as an incident.
     */
    countsAre: 'advisory';
  };
  vault: {
    /** THE headline. Present in every manifest, worded for a human. */
    warning: string;
    masterKeyFingerprint: string | null;
    fingerprintLabel: string;
    keyProblem: string | null;
    encryptedColumns: Array<{ table: string; column: string; rows: number }>;
    keyVersionsInUse: Array<{ table: string; column: string; versions: string[] }>;
    totalEncryptedRows: number;
  };
  excluded: ExclusionNote[];
}

/**
 * What a `pg_dump` of this platform does NOT contain.
 *
 * This list is the whole point of the manifest. Each entry is something an
 * operator would reasonably assume is covered, and is not.
 */
export function exclusions(artifactRows: number): ExclusionNote[] {
  return [
    {
      what: 'VAULT_MASTER_KEY (and SESSION_SECRET, and the rest of .env)',
      why:
        'Deliberate. The key that decrypts every *Enc column is not in the database, which is the ' +
        'entire security value of the vault: whoever steals this dump gets ciphertext. It also ' +
        'means this dump ALONE cannot bring the platform back.',
      howToCoverIt:
        'Store VAULT_MASTER_KEY in your own secret manager, in a different blast radius from ' +
        'these dumps, and test that you can retrieve it. The manifest records its fingerprint so ' +
        'you can prove you have the right one before you need it.',
    },
    {
      what: `Artifact bytes — screenshots, videos, traces, HAR files (${artifactRows} rows reference them)`,
      why:
        'Deliberate, and the reasoning is worth stating because it is a real trade. The bytes live ' +
        'in object storage, are immutable once written, are typically 100-1000x the size of the ' +
        'database, and already have a lifecycle policy on the bucket. Copying them into every ' +
        'nightly dump would make a 30-second backup a multi-hour one, and would give the same ' +
        'bytes two different retention clocks — the bucket policy and this dump — which is how ' +
        'artifacts outlive the retention promise made to a customer. The Artifact ROWS are in the ' +
        'dump, so the restored database knows exactly which object keys it expects.',
      howToCoverIt:
        'Back the bucket up as a bucket: versioning plus cross-region replication, or a scheduled ' +
        'sync. After a restore, expect artifacts older than the bucket lifecycle to 404 — the run ' +
        'history is intact, the screenshots for expired runs are not.',
    },
    {
      what: 'Redis: queued jobs, in-flight run state, rate-limit counters',
      why:
        'Not durable state and not worth restoring. A job that was mid-flight when the database ' +
        'was dumped refers to a run whose row may be in an earlier state; replaying it would ' +
        'produce a duplicate or a job for a run that no longer exists.',
      howToCoverIt:
        'Nothing to do. After a restore, runs left in RUNNING/QUEUED are stale — reconcile them ' +
        'to CANCELLED and let users re-run.',
    },
    {
      what: 'Roles, GRANTs and ownership',
      why:
        'The dump is taken with --no-owner --no-privileges so it can be restored into a database ' +
        'owned by a differently-named role, which is what actually happens in a recovery (prod ' +
        'user, staging box). The cost is that the restored database has no GRANTs.',
      howToCoverIt:
        'Create the target database owned by the role your API connects as, before restoring. ' +
        'Roles themselves are cluster-level: capture them separately with `pg_dumpall --roles-only`.',
    },
    {
      what: 'Other databases in the cluster, and cluster-level settings',
      why: 'This is a single-database dump, by design — it is the unit you restore.',
      howToCoverIt: 'Run this command once per database, or take a cluster-level base backup.',
    },
  ];
}

const VAULT_WARNING =
  'THIS DUMP CONTAINS EVERY SECRET ROW AND NOT ONE USABLE SECRET VALUE. Every *Enc column is ' +
  'AES-256-GCM under VAULT_MASTER_KEY, which is NOT in the database and NOT in this backup. ' +
  'Restore this without that exact key and the platform will come back looking completely ' +
  'healthy — orgs, projects, runs, history, all of it — while every test that needs a ' +
  'credential fails permanently, and no amount of work on the restored database can recover the ' +
  'plaintext. Back up VAULT_MASTER_KEY separately, and verify it against masterKeyFingerprint ' +
  'below BEFORE you need it.';

// ─── Schema version comparison ───────────────────────────────────────────────

export type SchemaVerdict = 'identical' | 'backup-older' | 'backup-newer' | 'diverged';

export interface SchemaComparison {
  verdict: SchemaVerdict;
  onlyInBackup: string[];
  onlyInExpected: string[];
  /** True when the restore must not proceed. */
  refuse: boolean;
  message: string;
}

/**
 * Compare the schema the backup was taken from against the schema the code that
 * will run on the restored database expects.
 *
 * The dangerous direction is `backup-newer`: a dump from a build ahead of the
 * deployment being restored into. pg_restore will happily recreate the newer
 * tables, the older application will not know about them, and Prisma's next
 * `migrate deploy` sees migrations in the database it has no files for. What
 * follows is drift resolved by hand, under time pressure, on the only copy of
 * the data. Refuse instead.
 *
 * `backup-older` is the ordinary case — restore, then `prisma migrate deploy`.
 */
export function compareSchema(backup: string[], expected: string[]): SchemaComparison {
  const backupSet = new Set(backup);
  const expectedSet = new Set(expected);
  const onlyInBackup = backup.filter((m) => !expectedSet.has(m));
  const onlyInExpected = expected.filter((m) => !backupSet.has(m));

  if (onlyInBackup.length === 0 && onlyInExpected.length === 0) {
    return {
      verdict: 'identical',
      onlyInBackup,
      onlyInExpected,
      refuse: false,
      message: `Schema matches exactly (${backup.length} migrations).`,
    };
  }

  if (onlyInBackup.length > 0 && onlyInExpected.length > 0) {
    return {
      verdict: 'diverged',
      onlyInBackup,
      onlyInExpected,
      refuse: true,
      message:
        'The backup and the target expect DIFFERENT migration histories, not one ahead ' +
        `of the other. Only in the backup: ${onlyInBackup.join(', ')}. Only expected here: ` +
        `${onlyInExpected.join(', ')}. These are two different branches of the schema; restoring ` +
        'either into the other corrupts it. Restore onto a deployment built from the same commit.',
    };
  }

  if (onlyInBackup.length > 0) {
    return {
      verdict: 'backup-newer',
      onlyInBackup,
      onlyInExpected,
      refuse: true,
      message:
        'This backup is from a NEWER schema than the code you are restoring into. It ' +
        `contains ${onlyInBackup.length} migration(s) this deployment does not have: ` +
        `${onlyInBackup.join(', ')}. Restoring it would put newer data under older code and leave ` +
        'Prisma with migration rows it has no files for. Deploy the matching (or newer) build ' +
        'first, then restore. Pass --allow-newer-schema only if you are certain, and take a dump ' +
        'of the target first.',
    };
  }

  return {
    verdict: 'backup-older',
    onlyInBackup,
    onlyInExpected,
    refuse: false,
    message:
      `This backup predates the current schema by ${onlyInExpected.length} migration(s): ` +
      `${onlyInExpected.join(', ')}. That is the normal case. Run \`prisma migrate deploy\` ` +
      'against the restored database before starting the API.',
  };
}

// ─── Row-count comparison: the proof ─────────────────────────────────────────

export interface CountDiff {
  table: string;
  expected: number;
  actual: number;
  delta: number;
}

export interface CountComparison {
  diffs: CountDiff[];
  /** Tables in the backup that the restored database does not have at all. */
  missingTables: string[];
  /** Tables the restored database has that the backup did not. */
  extraTables: string[];
  /** Restored with FEWER rows than the backup recorded. The failure that matters. */
  short: CountDiff[];
  ok: boolean;
}

export function compareRowCounts(expected: TableCount[], actual: TableCount[]): CountComparison {
  const actualByTable = new Map(actual.map((t) => [t.table, t.rows]));
  const expectedByTable = new Map(expected.map((t) => [t.table, t.rows]));

  const diffs: CountDiff[] = [];
  const missingTables: string[] = [];

  for (const row of expected) {
    const got = actualByTable.get(row.table);
    if (got === undefined) {
      missingTables.push(row.table);
      continue;
    }
    diffs.push({ table: row.table, expected: row.rows, actual: got, delta: got - row.rows });
  }

  const extraTables = actual.filter((t) => !expectedByTable.has(t.table)).map((t) => t.table);
  const short = diffs.filter((d) => d.delta < 0);

  return {
    diffs,
    missingTables,
    extraTables,
    short,
    ok: short.length === 0 && missingTables.length === 0,
  };
}

/** Fixed-width report. Only tables that differ, plus the totals, unless `all`. */
export function formatCountTable(comparison: CountComparison, all = false): string {
  const rows = all ? comparison.diffs : comparison.diffs.filter((d) => d.delta !== 0);
  const totalExpected = comparison.diffs.reduce((n, d) => n + d.expected, 0);
  const totalActual = comparison.diffs.reduce((n, d) => n + d.actual, 0);

  const lines: string[] = [];
  const width = Math.max(20, ...rows.map((r) => r.table.length));
  if (rows.length > 0) {
    lines.push(`${'table'.padEnd(width)}  ${'backup'.padStart(9)}  ${'restored'.padStart(9)}  delta`);
    for (const r of rows) {
      lines.push(
        `${r.table.padEnd(width)}  ${String(r.expected).padStart(9)}  ${String(r.actual).padStart(9)}  ` +
          `${r.delta > 0 ? '+' : ''}${r.delta}`,
      );
    }
  }
  lines.push(
    `${comparison.diffs.length} tables compared · ${totalExpected} rows in backup · ${totalActual} rows restored`,
  );
  for (const t of comparison.missingTables) lines.push(`  MISSING TABLE: ${t}`);
  for (const t of comparison.extraTables) lines.push(`  extra table not in backup: ${t}`);
  return lines.join('\n');
}

// ─── pg_dump / pg_restore argument construction ──────────────────────────────

/**
 * Custom format, because it is the only one pg_restore can be selective about
 * and the only one that compresses. No credentials here by construction — the
 * caller supplies them through the environment.
 */
export function buildPgDumpArgs(dumpPath: string, database: string): string[] {
  return [
    '--format=custom',
    // Restorable into a database owned by a differently-named role, which is
    // what a real recovery looks like. See exclusions() for the cost.
    '--no-owner',
    '--no-privileges',
    // Belt and braces against a half-written dump being mistaken for a good one:
    // pg_dump exits nonzero and we also verify the checksum on restore.
    `--dbname=${database}`,
    `--file=${dumpPath}`,
  ];
}

export interface RestoreArgOptions {
  dumpPath: string;
  database: string;
  /** DROP each object before recreating it. Only ever set with --overwrite. */
  clean: boolean;
  /**
   * Parallel restore. Mutually exclusive with the single-transaction wrapper,
   * so choosing it trades atomicity for speed — deliberately, and out loud.
   */
  jobs: number | null;
}

export function buildPgRestoreArgs(opts: RestoreArgOptions): string[] {
  const args = ['--format=custom', '--no-owner', '--no-privileges', `--dbname=${opts.database}`];

  if (opts.clean) {
    args.push('--clean', '--if-exists');
  }

  if (opts.jobs && opts.jobs > 1) {
    // --jobs cannot run inside one transaction; without it a failure halfway
    // leaves a partially restored database, so --exit-on-error at minimum.
    args.push(`--jobs=${opts.jobs}`, '--exit-on-error');
  } else {
    // The default, and the safe one: the restore either lands completely or the
    // target is untouched. A half-restored database that reports success is the
    // exact failure this whole file exists to prevent.
    args.push('--single-transaction', '--exit-on-error');
  }

  args.push(opts.dumpPath);
  return args;
}

// ─── Checksums ───────────────────────────────────────────────────────────────

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', () => resolvePromise());
  });
  return hash.digest('hex');
}

// ─── Flags ───────────────────────────────────────────────────────────────────

export function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const next = args[index + 1];
  if (next === undefined || next.startsWith('--')) return undefined;
  return next;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function requireDatabaseUrl(args: string[], flag: string, envName: string): PgConnection {
  const raw = flagValue(args, flag) ?? env[envName];
  if (!raw) {
    throw new BackupError(
      `No database URL. Pass ${flag} <url> or set ${envName}.\n` +
        '  Example: postgresql://qaai:password@localhost:5432/qaai',
    );
  }
  try {
    return parseDatabaseUrl(raw);
  } catch (err) {
    throw new BackupError(
      `${err instanceof Error ? err.message : String(err)} (got ${redactDatabaseUrl(raw)})`,
    );
  }
}

/**
 * Read the version out of the package rather than restating it here, because a
 * hard-coded constant drifts and the manifest's whole job is to be believed.
 */
function toolVersion(): string {
  try {
    // Relative to this file: packages/cli/src/backup.ts → packages/cli/package.json
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
  }
}

// ─── Reading the migrations a deployment expects ─────────────────────────────

/**
 * The migration names a Prisma migrations directory contains.
 *
 * This is "what the code expects" — the other half of the version check. Sorted
 * because Prisma's own ordering is lexicographic on the timestamped directory
 * name, and comparing sets is order-independent anyway.
 */
export async function readMigrationsDir(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new BackupError(
      `No Prisma migrations directory at ${dir}. Point --migrations at apps/api/prisma/migrations ` +
        'from the build you are restoring into, or omit it to compare against the target ' +
        "database's own _prisma_migrations table instead.",
    );
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== 'migration_lock.toml')
    .map((e) => e.name)
    .sort();
}

// ─── qaai backup create ──────────────────────────────────────────────────────

async function cmdCreate(args: string[]): Promise<number> {
  const conn = requireDatabaseUrl(args, '--database-url', 'DATABASE_URL');
  const outDir = resolve(flagValue(args, '--out') ?? `qaai-backup-${stamp()}`);
  const dumpPath = join(outDir, DUMP_FILE);

  // Never clobber a backup. The one command that must not be able to destroy an
  // earlier good copy is the one that runs unattended every night.
  if (await exists(dumpPath)) {
    throw new RefusedError(
      `${dumpPath} already exists. Refusing to overwrite an existing backup — pick a new --out ` +
        'directory (a timestamp is the usual answer) or move the old one aside yourself.',
    );
  }

  const dumpVersionOut = await run('pg_dump', ['--version'], {}, missingTool('pg_dump'));
  const dumpVersion = parsePgVersion(dumpVersionOut.stdout);

  const serverVersionRows = await psqlRows(conn, 'SHOW server_version');
  const serverVersion = serverVersionRows[0]?.[0] ?? 'unknown';
  const serverMajor = Number.parseInt(serverVersion, 10);

  const versionProblem = checkDumpVersion(dumpVersion, serverMajor);
  if (versionProblem) throw new RefusedError(versionProblem);

  await mkdir(outDir, { recursive: true });

  stderr.write(`Dumping ${describeConnection(conn)} → ${dumpPath}\n`);
  const dumpArgs = buildPgDumpArgs(dumpPath, conn.database);
  const dumped = await run('pg_dump', dumpArgs, libpqEnv(conn), missingTool('pg_dump'));
  if (dumped.code !== 0) {
    throw new BackupError(
      `pg_dump failed (exit ${dumped.code}):\n${dumped.stderr.trim() || '(no output)'}`,
    );
  }

  const [dumpStat, sha, tables, migrations, encrypted, keyVersions] = await Promise.all([
    stat(dumpPath),
    sha256File(dumpPath),
    readTableCounts(conn),
    readMigrations(conn),
    psqlRows(conn, ENCRYPTED_COLUMNS_SQL),
    psqlRows(conn, KEY_VERSIONS_SQL),
  ]);

  const vaultKey = inspectVaultKey(env.VAULT_MASTER_KEY);
  const encryptedColumns = encrypted.map((r) => ({
    table: r[0] ?? '',
    column: r[1] ?? '',
    rows: toCount(r[2]),
  }));
  const artifactRows = tables.find((t) => t.table === 'Artifact')?.rows ?? 0;

  const applied = migrations.filter((m) => m.finished && !m.rolledBack).map((m) => m.name);

  const manifest: BackupManifest = {
    manifestVersion: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    tool: { name: 'qaai backup', version: toolVersion() },
    source: {
      connection: describeConnection(conn),
      database: conn.database,
      postgresServerVersion: serverVersion,
      pgDumpVersion: dumpVersion?.raw ?? null,
    },
    dump: {
      file: DUMP_FILE,
      format: 'custom',
      bytes: dumpStat.size,
      sha256: sha,
      pgDumpArgs: dumpArgs,
    },
    schema: {
      migrations: applied,
      latestMigration: applied.length > 0 ? (applied[applied.length - 1] ?? null) : null,
      unfinishedMigrations: migrations.filter((m) => !m.finished && !m.rolledBack).map((m) => m.name),
      rolledBackMigrations: migrations.filter((m) => m.rolledBack).map((m) => m.name),
    },
    contents: {
      tables,
      totalRows: tables.reduce((n, t) => n + t.rows, 0),
      countsAre: 'advisory',
    },
    vault: {
      warning: VAULT_WARNING,
      masterKeyFingerprint: vaultKey.fingerprint,
      fingerprintLabel: VAULT_FINGERPRINT_LABEL,
      keyProblem: vaultKey.problem,
      encryptedColumns,
      keyVersionsInUse: keyVersions.map((r) => ({
        table: r[0] ?? '',
        column: r[1] ?? '',
        versions: (r[2] ?? '').split(',').filter((v) => v.length > 0),
      })),
      totalEncryptedRows: encryptedColumns.reduce((n, c) => n + c.rows, 0),
    },
    excluded: exclusions(artifactRows),
  };

  await writeFile(join(outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  stdout.write(
    `\nBackup written to ${outDir}\n` +
      `  ${DUMP_FILE}       ${formatBytes(dumpStat.size)}  sha256 ${sha.slice(0, 16)}…\n` +
      `  ${MANIFEST_FILE}   ${manifest.contents.tables.length} tables · ${manifest.contents.totalRows} rows · ` +
      `schema ${manifest.schema.latestMigration ?? '(none)'}\n\n`,
  );

  // The loud part. Printed last so it is the final thing on the operator's
  // screen, and printed on every single backup, not only the first one.
  stderr.write(`${'─'.repeat(78)}\nVAULT: ${VAULT_WARNING}\n`);
  if (vaultKey.fingerprint) {
    stderr.write(
      `  master key fingerprint: ${vaultKey.fingerprint}  (a digest, not the key — safe to store here)\n`,
    );
  }
  if (vaultKey.problem) {
    stderr.write(
      `  ${vaultKey.problem}, so this manifest records NO key fingerprint. The dump is still ` +
        'valid; a future restore simply will not be able to tell you in advance whether the key ' +
        'you have is the right one. Set it and re-run to get that check.\n',
    );
  }
  if (manifest.vault.totalEncryptedRows === 0) {
    stderr.write('  No encrypted rows exist yet, so nothing is at risk from a key mismatch today.\n');
  } else {
    stderr.write(
      `  ${manifest.vault.totalEncryptedRows} encrypted value(s) across ` +
        `${encryptedColumns.filter((c) => c.rows > 0).length} column(s) are unreadable without it.\n`,
    );
  }
  stderr.write(`${'─'.repeat(78)}\n`);

  if (manifest.schema.unfinishedMigrations.length > 0) {
    stderr.write(
      `WARNING: this dump was taken while ${manifest.schema.unfinishedMigrations.join(', ')} was ` +
        'mid-flight. The schema in it may be half-migrated. Prefer a dump taken when no migration ' +
        'is running.\n',
    );
  }

  return EXIT_OK;
}

// ─── qaai backup verify ──────────────────────────────────────────────────────

/** Everything `restore` checks, with nothing written anywhere. */
async function cmdVerify(args: string[]): Promise<number> {
  const dir = resolve(
    flagValue(args, '--from') ??
      (() => {
        throw new BackupError('Usage: qaai backup verify --from <backup-dir>');
      })(),
  );

  const manifest = await readManifest(dir);
  const dumpPath = join(dir, manifest.dump.file);

  stdout.write(`Backup    ${dir}\n`);
  stdout.write(`Taken     ${manifest.createdAt} from ${manifest.source.connection}\n`);
  stdout.write(
    `Schema    ${manifest.schema.latestMigration ?? '(none)'} (${manifest.schema.migrations.length} migrations)\n`,
  );
  stdout.write(
    `Contents  ${manifest.contents.tables.length} tables · ${manifest.contents.totalRows} rows\n`,
  );

  const info = await stat(dumpPath).catch(() => null);
  if (!info) {
    throw new RefusedError(
      `The manifest names ${manifest.dump.file} but that file is not in ${dir}. This backup is ` +
        'incomplete — do not rely on it.',
    );
  }
  if (info.size !== manifest.dump.bytes) {
    throw new RefusedError(
      `${manifest.dump.file} is ${info.size} bytes, the manifest says ${manifest.dump.bytes}. ` +
        'Truncated or replaced. Do not restore this.',
    );
  }

  const sha = await sha256File(dumpPath);
  if (sha !== manifest.dump.sha256) {
    throw new RefusedError(
      `Checksum mismatch on ${manifest.dump.file}.\n  expected ${manifest.dump.sha256}\n  actual   ${sha}\n` +
        'The dump has been corrupted or altered since it was written. Do not restore this.',
    );
  }
  stdout.write(`Checksum  OK (sha256 ${sha.slice(0, 16)}…)\n`);

  const vaultKey = inspectVaultKey(env.VAULT_MASTER_KEY);
  stdout.write(`\n${describeVaultMatch(manifest, vaultKey)}\n`);

  const migrationsDir = flagValue(args, '--migrations');
  if (migrationsDir) {
    const comparison = compareSchema(manifest.schema.migrations, await readMigrationsDir(migrationsDir));
    stdout.write(`\nSchema check: ${comparison.message}\n`);
    if (comparison.refuse) return EXIT_REFUSED;
  }

  stdout.write('\nExcluded from this backup:\n');
  for (const note of manifest.excluded) stdout.write(`  · ${note.what}\n`);
  stdout.write(
    `The reasoning for each, and how to cover it, is in ${join(dir, MANIFEST_FILE)} under "excluded".\n`,
  );

  return EXIT_OK;
}

// ─── qaai backup restore ─────────────────────────────────────────────────────

async function cmdRestore(args: string[]): Promise<number> {
  const dir = resolve(
    flagValue(args, '--from') ??
      (() => {
        throw new BackupError(
          'Usage: qaai backup restore --from <backup-dir> --to <postgresql://…> [--dry-run]',
        );
      })(),
  );
  const target = requireDatabaseUrl(args, '--to', 'QAAI_RESTORE_DATABASE_URL');
  const dryRun = hasFlag(args, '--dry-run');
  const overwrite = hasFlag(args, '--overwrite');
  const allowNewer = hasFlag(args, '--allow-newer-schema');
  const allowKeyMismatch = hasFlag(args, '--allow-key-mismatch');
  const jobsRaw = flagValue(args, '--jobs');
  const jobs = jobsRaw ? Number.parseInt(jobsRaw, 10) : null;

  const manifest = await readManifest(dir);
  const dumpPath = join(dir, manifest.dump.file);

  // ── 1. Is this dump the one the manifest describes? ───────────────────────
  const sha = await sha256File(dumpPath).catch(() => null);
  if (sha === null) {
    throw new RefusedError(`Cannot read ${dumpPath}. This backup is incomplete.`);
  }
  if (sha !== manifest.dump.sha256) {
    throw new RefusedError(
      `Checksum mismatch on ${manifest.dump.file} — the dump does not match its manifest. ` +
        'Refusing to restore a file that has been corrupted or swapped.',
    );
  }
  stderr.write(`Dump checksum OK.\n`);

  /*
   * Every remaining gate collects into `refusals` instead of throwing.
   *
   * Reporting one blocker at a time trains an operator to clear each with the
   * override flag the message helpfully names, one at a time, until the thing
   * goes through — which is precisely the behaviour these gates exist to
   * prevent. The first version of this file did exactly that: a restore into a
   * populated database hid the fact that the backup was ALSO from a newer
   * schema, so `--overwrite` would have been typed by someone who had not yet
   * been told the more important thing. All of it, at once, or nothing.
   *
   * The checksum above is the exception and still short-circuits: if the dump
   * is not the file the manifest describes, every check below is being run
   * against a fiction.
   */
  const refusals: string[] = [];

  // ── 2. Never restore over the database this came from, by accident ────────
  if (
    manifest.source.connection.endsWith(`${target.host}:${target.port}/${target.database}`) &&
    !overwrite
  ) {
    refusals.push(
      `--to names the database this backup was TAKEN FROM (${describeConnection(target)}). ` +
        'That is almost never what you meant, and it is the one mistake with no undo. Restore to ' +
        'a new database first and compare. If you really are rolling production back onto itself, ' +
        'pass --overwrite, and take a dump of the current state first.',
    );
  }

  // ── 3. Is the target empty? ───────────────────────────────────────────────
  const targetTables = await readTableCounts(target);
  const targetRows = targetTables.reduce((n, t) => n + t.rows, 0);

  if (targetTables.length > 0 && !overwrite) {
    refusals.push(
      `${describeConnection(target)} already has ${targetTables.length} table(s) and ${targetRows} ` +
        'row(s). Refusing to restore into a populated database.\n' +
        '    · To restore somewhere clean:  createdb qaai_restore   then  --to …/qaai_restore\n' +
        '    · To deliberately replace what is there, pass --overwrite. Every table above will be ' +
        'DROPPED and recreated. Take a dump of it first — this tool will record what it destroyed ' +
        `in ${join(dir, RESTORE_LOG_FILE)}, but it cannot give the rows back.`,
    );
  }

  // ── 4. Schema version gate ────────────────────────────────────────────────
  const migrationsDir = flagValue(args, '--migrations');
  const expected = migrationsDir
    ? await readMigrationsDir(migrationsDir)
    : (await readMigrations(target)).filter((m) => m.finished && !m.rolledBack).map((m) => m.name);

  let schemaMessage: string;
  if (expected.length === 0) {
    schemaMessage =
      'Schema check SKIPPED: the target has no _prisma_migrations table and no --migrations ' +
      'directory was given, so there is nothing to compare against. This is expected when ' +
      'restoring into a brand-new empty database. To get the check, pass ' +
      '--migrations apps/api/prisma/migrations from the build you will run against this data.';
    stderr.write(`${schemaMessage}\n`);
  } else {
    const comparison = compareSchema(manifest.schema.migrations, expected);
    schemaMessage = comparison.message;
    if (comparison.refuse && !(comparison.verdict === 'backup-newer' && allowNewer)) {
      refusals.push(comparison.message);
    } else if (comparison.refuse) {
      // `diverged` is deliberately NOT overridable: --allow-newer-schema means
      // "I know this backup is ahead", which is not a claim anyone can make
      // about two branches that each have migrations the other lacks.
      stderr.write(`OVERRIDDEN by --allow-newer-schema: ${comparison.message}\n`);
    } else {
      stderr.write(`Schema check: ${comparison.message}\n`);
    }
  }

  // ── 5. The vault gate ─────────────────────────────────────────────────────
  const vaultKey = inspectVaultKey(env.VAULT_MASTER_KEY);
  const vaultVerdict = describeVaultMatch(manifest, vaultKey);
  stderr.write(`\n${vaultVerdict}\n\n`);

  const mismatched =
    manifest.vault.masterKeyFingerprint !== null &&
    vaultKey.fingerprint !== null &&
    manifest.vault.masterKeyFingerprint !== vaultKey.fingerprint;

  if (mismatched && manifest.vault.totalEncryptedRows > 0 && !allowKeyMismatch) {
    refusals.push(
      `VAULT_MASTER_KEY in this environment is a DIFFERENT key from the one that encrypted the ` +
        `${manifest.vault.totalEncryptedRows} secret(s) in this backup ` +
        `(manifest ${manifest.vault.masterKeyFingerprint}, yours ${vaultKey.fingerprint}). ` +
        'The restore itself would succeed and every secret would be permanently unreadable. Find ' +
        'the matching key before you restore. If you genuinely intend to restore the data and ' +
        're-enter every secret by hand, pass --allow-key-mismatch.',
    );
  }

  // ── 6. Report every blocker at once, or none ──────────────────────────────
  if (refusals.length > 0) {
    throw new RefusedError(
      `REFUSING to restore — ${refusals.length} problem(s):\n\n` +
        refusals.map((r, i) => `  ${i + 1}. ${r}`).join('\n\n') +
        '\n\nNothing was written to the target.',
    );
  }

  if (dryRun) {
    stdout.write(
      'DRY RUN — every check passed and nothing was written.\n' +
        `  would restore ${manifest.contents.totalRows} rows across ${manifest.contents.tables.length} tables\n` +
        `  into          ${describeConnection(target)}\n` +
        `  ${overwrite ? `DROPPING the ${targetTables.length} table(s) already there` : 'target is empty'}\n`,
    );
    return EXIT_OK;
  }

  // ── 6. Restore ────────────────────────────────────────────────────────────
  const restoreArgs = buildPgRestoreArgs({
    dumpPath,
    database: target.database,
    clean: overwrite,
    jobs,
  });
  if (jobs && jobs > 1) {
    stderr.write(
      `--jobs=${jobs}: restoring in parallel, which cannot be wrapped in one transaction. A ` +
        'failure will leave this database partially restored; re-run into a fresh database if ' +
        'that happens.\n',
    );
  }

  const startedAt = new Date().toISOString();
  stderr.write(`Restoring into ${describeConnection(target)} …\n`);
  const restored = await run('pg_restore', restoreArgs, libpqEnv(target), missingTool('pg_restore'));

  // The destructive path is audited whether it worked or not — especially if it
  // did not, because "we ran a restore over it and it failed halfway" is the
  // state somebody will need to reconstruct later.
  await appendRestoreRecord(dir, {
    startedAt,
    finishedAt: new Date().toISOString(),
    target: describeConnection(target),
    overwrite,
    destroyed: overwrite ? { tables: targetTables.length, rows: targetRows } : null,
    pgRestoreExit: restored.code,
    schemaCheck: schemaMessage,
    vaultCheck: vaultVerdict,
    dumpSha256: manifest.dump.sha256,
  });

  if (restored.code !== 0) {
    throw new BackupError(
      `pg_restore failed (exit ${restored.code}):\n${restored.stderr.trim() || '(no output)'}\n` +
        (jobs && jobs > 1
          ? 'This was a parallel restore, so the target may be partially written. Drop it and start over.'
          : 'The restore ran in a single transaction, so the target is unchanged.'),
    );
  }
  if (restored.stderr.trim()) stderr.write(`${restored.stderr.trim()}\n`);

  // ── 7. Prove it ───────────────────────────────────────────────────────────
  const after = await readTableCounts(target);
  const comparison = compareRowCounts(manifest.contents.tables, after);

  stdout.write(`\n${formatCountTable(comparison, hasFlag(args, '--all-tables'))}\n`);

  if (!comparison.ok) {
    stderr.write(
      '\nRESTORE INCOMPLETE: the restored database has fewer rows than the backup recorded. Do not ' +
        'point production at it. Tables short: ' +
        comparison.short.map((d) => `${d.table} (${d.actual}/${d.expected})`).join(', ') +
        '\n',
    );
    return EXIT_REFUSED;
  }

  stdout.write('\nRestore verified: every table matched or exceeded the backup row counts.\n');
  if (manifest.vault.totalEncryptedRows > 0) {
    stdout.write(
      `Reminder: ${manifest.vault.totalEncryptedRows} secret value(s) restored as ciphertext. They ` +
        'are only usable if VAULT_MASTER_KEY here matches the one above.\n',
    );
  }
  if (expected.length > 0) stdout.write(`Next: ${schemaMessage}\n`);

  return EXIT_OK;
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

async function readManifest(dir: string): Promise<BackupManifest> {
  const path = join(dir, MANIFEST_FILE);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new BackupError(
      `No ${MANIFEST_FILE} in ${dir}. A bare .dump file can be restored with pg_restore by hand, ` +
        'but this tool will not do it: without the manifest there is no schema version to check, ' +
        'no checksum to verify and no record of which vault key those secrets need.',
    );
  }

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(raw) as BackupManifest;
  } catch {
    throw new BackupError(`${path} is not valid JSON.`);
  }

  if (manifest.manifestVersion > MANIFEST_VERSION) {
    throw new RefusedError(
      `This backup's manifest is version ${manifest.manifestVersion}; this tool understands ` +
        `${MANIFEST_VERSION}. It was written by a newer qaai. Upgrade the CLI rather than ` +
        'guessing at fields it does not know about.',
    );
  }

  return manifest;
}

/** One paragraph an operator can act on, for every combination of key state. */
export function describeVaultMatch(manifest: BackupManifest, key: VaultKeyStatus): string {
  const inBackup = manifest.vault.masterKeyFingerprint;
  const encrypted = manifest.vault.totalEncryptedRows;

  if (encrypted === 0) {
    return `VAULT: this backup contains no encrypted values, so no master key is needed to make it whole.`;
  }
  if (!inBackup) {
    return (
      `VAULT — CANNOT VERIFY: this backup holds ${encrypted} encrypted value(s) but its manifest ` +
      'records no key fingerprint (VAULT_MASTER_KEY was not set when the backup was taken). There ' +
      'is no way to tell in advance whether the key you have is the right one. The restore will ' +
      'succeed either way; the secrets will only work if the key happens to match.'
    );
  }
  if (!key.fingerprint) {
    return (
      `VAULT — CANNOT VERIFY: this backup holds ${encrypted} encrypted value(s) sealed under key ` +
      `fingerprint ${inBackup}, but ${key.problem ?? 'the key is not readable here'}. The restore ` +
      'will succeed either way; whether those secrets work afterwards is currently unknown. ' +
      'Supply the key and re-run to have it checked now rather than discovered later.'
    );
  }
  if (key.fingerprint === inBackup) {
    return `VAULT — OK: VAULT_MASTER_KEY here matches the key that sealed these ${encrypted} secret(s) (fingerprint ${inBackup}).`;
  }
  return (
    `VAULT — MISMATCH: these ${encrypted} secret(s) were sealed under key ${inBackup}; the key in ` +
    `this environment is ${key.fingerprint}. Restoring now produces a database that looks complete ` +
    'and has zero working credentials.'
  );
}

export interface RestoreRecord {
  startedAt: string;
  finishedAt: string;
  target: string;
  overwrite: boolean;
  destroyed: { tables: number; rows: number } | null;
  pgRestoreExit: number;
  schemaCheck: string;
  vaultCheck: string;
  dumpSha256: string;
}

/**
 * Append-only record beside the dump.
 *
 * Deliberately in the backup directory rather than a log file somewhere: the
 * question this answers is "was this backup ever restored, where, and did it
 * destroy anything", and the only artefact guaranteed to still exist when
 * somebody asks is the backup itself.
 */
async function appendRestoreRecord(dir: string, record: RestoreRecord): Promise<void> {
  try {
    await appendFile(join(dir, RESTORE_LOG_FILE), JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    // Best-effort, but loud — matching apps/api/src/lib/audit.ts. An audit
    // failure must not roll back the operator's restore.
    stderr.write(
      `WARNING: could not write the restore record to ${join(dir, RESTORE_LOG_FILE)}: ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        `  ${JSON.stringify(record)}\n`,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export const BACKUP_HELP = `qaai backup — dump, restore and prove it

Usage:
  qaai backup create  --out <dir> [--database-url <url>]
  qaai backup verify  --from <dir> [--migrations <dir>]
  qaai backup restore --from <dir> --to <url> [options]

create
  --out <dir>            Where to write ${DUMP_FILE} and ${MANIFEST_FILE}. Refuses to
                         overwrite an existing dump.
  --database-url <url>   Default: $DATABASE_URL

verify                   Every check restore does, writing nothing.
  --from <dir>           The backup directory
  --migrations <dir>     A prisma migrations directory to check the schema against

restore
  --from <dir>           The backup directory
  --to <url>             Target database. Default: $QAAI_RESTORE_DATABASE_URL
  --migrations <dir>     Compare the backup's schema against these migrations
                         instead of the target's own _prisma_migrations
  --dry-run              Run every check, restore nothing
  --overwrite            DROP and replace what is in the target. Required to
                         restore into a non-empty database. Records what it
                         destroyed in ${RESTORE_LOG_FILE}
  --allow-newer-schema   Restore a backup taken from a newer schema anyway
  --allow-key-mismatch   Restore even though VAULT_MASTER_KEY does not match the
                         key that sealed these secrets (they will be unreadable)
  --jobs <n>             Parallel restore; gives up the single-transaction
                         guarantee in exchange
  --all-tables           Print every table in the comparison, not just the
                         ones that differ

VAULT_MASTER_KEY is read from the environment to fingerprint it. It is never
written to the manifest, the dump, or any log line this tool produces.

Exit codes: 0 done · 1 refused for a safety reason · 2 bug · 3 skipped, a
required tool is not installed.`;

export async function backupMain(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'create':
      return cmdCreate(rest);
    case 'restore':
      return cmdRestore(rest);
    case 'verify':
      return cmdVerify(rest);
    case 'help':
    case '--help':
    case undefined:
      stdout.write(BACKUP_HELP + '\n');
      return EXIT_OK;
    default:
      stderr.write(`Unknown backup subcommand: ${sub}\n\n${BACKUP_HELP}\n`);
      return EXIT_BUG;
  }
}

/* c8 ignore start — the process entry point, exercised by running the binary. */
const invokedDirectly = argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;

if (invokedDirectly) {
  backupMain(argv.slice(2))
    .then((code) => exit(code))
    .catch((err: unknown) => {
      if (err instanceof MissingToolError) {
        stderr.write(`SKIPPED: ${err.message}\n`);
        exit(EXIT_SKIPPED);
      }
      if (err instanceof BackupError) {
        stderr.write(`${err.message}\n`);
        exit(err instanceof RefusedError ? EXIT_REFUSED : EXIT_BUG);
      }
      stderr.write(`Unexpected error: ${String(err)}\n`);
      exit(EXIT_BUG);
    });
}
/* c8 ignore stop */
