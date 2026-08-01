/**
 * Leak detection — "did this test leave anything behind?"
 *
 * A test that leaks rows, files, storage or processes is why the 400th run of a
 * suite behaves differently from the 4th, and it is invisible until it is
 * expensive. The DATABASE plugin already proves one instance of this: every
 * statement runs inside a transaction that is always rolled back, and the schema
 * is fingerprinted either side so "the rollback restored everything" is asserted
 * rather than assumed. This module generalises that idea to tests that have no
 * transaction to hide behind.
 *
 * Four surfaces, each a before/after snapshot around the test:
 *
 *  1. DATABASE rows — a per-table exact count, Postgres only (see ENGINES).
 *  2. FILES — everything under the workspace and any configured temp directory.
 *  3. Browser STORAGE — cookies written for a domain that is not under test, and
 *     service workers still registered, either of which silently changes what
 *     the NEXT test sees.
 *  4. Open handles — a process the test spawned and never reaped.
 *
 * ── Three rules this module is built around ─────────────────────────────────
 *
 * A LEAK IS A FINDING, NOT A FAILURE. Leaks are reported as Findings attached to
 * the test; the test's own status is never touched. A leak is a real problem and
 * a different kind of problem from an assertion failure, and shipping a version
 * that turned every leaky test red would get the whole feature switched off
 * within an hour — which is worse than not shipping it. The severity is honest
 * (see SEVERITY, below) so a quality gate can decide what blocks; see
 * `leakGateSummary`.
 *
 * IT FAILS OPEN. Detection that cannot run must say so, loudly, rather than
 * report "clean". Every surface that errors, times out, hits a cap, or is
 * refused emits a `leak.*.inconclusive` finding saying exactly what was not
 * checked and how to fix it. `finish()` never throws and never returns a silent
 * empty array after an error — a detector that swallows its own failure is a
 * detector that hides leaks.
 *
 * IT IS OFF BY DEFAULT. `parseLeakConfig` returns null unless a spec carries a
 * `leakCheck` block with `enabled: true`. Counting every row in a schema is not
 * something to do to a customer's database because they upgraded.
 *
 * ENGINES: the database surface supports POSTGRES ONLY. `pg` is the only driver
 * in this tree, and advertising MySQL/SQLite without one behind it would turn a
 * config question into a run-time error. Everything else here is engine- and
 * framework-agnostic.
 *
 * The connection string is resolved from a VAULT SECRET NAME, never taken inline
 * from the spec — a spec lives in the customer's git repo and a DSN carries a
 * password.
 */

import { execFile } from 'node:child_process';
import { readdir, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { parse as parsePath, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createMasker } from '@qaai/shared';
import type { Finding } from '@qaai/shared';
// One definition of "this DSN looks like production", not two. The database
// plugin owns the heuristic; duplicating it here is how the two copies drift and
// the weaker one ends up guarding the sweep that touches every table.
import { describeConnection, productionRefusal } from './plugins/database.js';

const execFileAsync = promisify(execFile);

// ─── What a leak finding looks like ──────────────────────────────────────────

/**
 * Leaks are reported under the PERFORMANCE kind.
 *
 * There is no LEAK value in `FindingKind` (packages/shared/src/types.ts and the
 * Prisma enum), and adding one is a schema migration this module cannot make on
 * its own. PERFORMANCE is the closest existing bucket — resource residue that
 * compounds over runs — and no other plugin emits it today, so leaks do not
 * crowd out anything. Every code starts with `leak.` so a mute rule, a gate rule
 * or a dashboard filter can select exactly this family and nothing else.
 */
export const LEAK_FINDING_KIND: Finding['kind'] = 'PERFORMANCE';

/** Prefix on every code this module emits. Match on it, not on the kind. */
export const LEAK_CODE_PREFIX = 'leak.';

export function isLeakFinding(finding: Finding): boolean {
  return finding.code.startsWith(LEAK_CODE_PREFIX);
}

/** A leak we could not rule out because the check itself did not complete. */
export function isInconclusiveLeakFinding(finding: Finding): boolean {
  return isLeakFinding(finding) && finding.code.endsWith('.inconclusive');
}

/**
 * SEVERITY — the honest version.
 *
 * The scale has to mean something for a gate rule to be able to act on it, so
 * these are graded by how the leak actually bites, not by how alarming it
 * sounds:
 *
 *  SERIOUS  the leak destroys or reshapes state the test did not own (deleted
 *           rows, dropped/created tables), crosses a trust boundary (a cookie on
 *           a domain that is not under test), or holds an OS resource that the
 *           next run needs (an unreaped process, a context still open).
 *  MODERATE the leak accumulates: rows and files that pile up until a suite
 *           behaves differently late in its life than early. This is the common
 *           case and it is deliberately not SERIOUS — if the first day of this
 *           feature is a wall of SERIOUS findings, the feature gets muted.
 *  MINOR    residue in a directory whose whole purpose is to be disposable, and
 *           every `inconclusive` result. Inconclusive is MINOR because it is not
 *           evidence of a leak; it is evidence that we did not look.
 */
const SEVERITY = {
  accumulates: 'MODERATE',
  destructive: 'SERIOUS',
  crossesBoundary: 'SERIOUS',
  holdsResource: 'SERIOUS',
  disposable: 'MINOR',
  inconclusive: 'MINOR',
} as const satisfies Record<string, Finding['severity']>;

/**
 * A single table gaining this many rows is no longer "the test forgot one row";
 * it is a loop that leaks per iteration, which is the shape that makes run 400
 * a different animal from run 4.
 */
const SERIOUS_ROW_GROWTH = 100;

// Findings are persisted with `message` truncated at 2000 chars and `location`
// at 1000 (apps/worker/src/processors/run.ts). Cut them here instead, so the
// text ends in an ellipsis rather than mid-word.
const MESSAGE_LIMIT = 1800;
const LOCATION_LIMIT = 900;

// ─── Configuration (off by default) ──────────────────────────────────────────

const databaseLeakConfigSchema = z.object({
  /**
   * The VAULT SECRET NAME holding a Postgres connection string. Never the DSN
   * itself: a spec is org-authored data that lives in a git repo.
   */
  connectionSecretName: z.string().min(1),
  /** Schemas to count. `public` is what an application's own tables live in. */
  schemas: z.array(z.string().min(1)).min(1).default(['public']),
  /** `schema.table` or bare `table` names whose residue is expected (job queues, audit logs). */
  ignoreTables: z.array(z.string().min(1)).default([]),
  /**
   * A hard ceiling on how many tables get a `count(*)`. A sweep is O(rows), so
   * a 4000-table warehouse would turn a 200ms API test into a minute.
   */
  maxTables: z.number().int().positive().max(5000).default(300),
  /** Milliseconds any single counting statement may take before the surface goes inconclusive. */
  statementTimeoutMs: z.number().int().positive().default(15_000),
  /**
   * Counting is read-only, but a full sweep on a live database is still load the
   * customer did not ask for, so a production-looking DSN is refused unless this
   * says otherwise.
   */
  allowProductionDatabase: z.boolean().default(false),
});

const filesLeakConfigSchema = z.object({
  /**
   * Directories a test must leave as it found them. Relative paths resolve
   * against the worker's cwd; when the list is empty the watch falls back to the
   * run workspace, if the caller passed one.
   */
  directories: z.array(z.string().min(1)).default([]),
  /** Directories whose residue is MINOR rather than MODERATE — scratch space, by design. */
  temporaryDirectories: z.array(z.string().min(1)).default([]),
  /** Path segments never walked or reported. */
  ignore: z.array(z.string().min(1)).default(['.git', 'node_modules', '.DS_Store']),
  /** Above this many entries the walk stops and the surface reports inconclusive. */
  maxEntries: z.number().int().positive().max(1_000_000).default(20_000),
});

const storageLeakConfigSchema = z.object({
  /**
   * Cookie domains that are legitimate for this test. Empty means "derive it
   * from the environment's base URL", which is what a test against one app wants.
   * A leading dot matches subdomains, the way Set-Cookie does.
   */
  allowedCookieDomains: z.array(z.string().min(1)).default([]),
  /**
   * The caller asserts this browser context should be gone by the time the watch
   * finishes. A context that still answers is itself the leak.
   */
  expectDisposed: z.boolean().default(false),
});

const processesLeakConfigSchema = z.object({
  /** Substrings of a command line that is expected to outlive the test (a shared browser, a sidecar). */
  ignoreCommands: z.array(z.string().min(1)).default([]),
});

export const leakConfigSchema = z.object({
  /** OFF BY DEFAULT. A `leakCheck` block with no `enabled: true` does nothing. */
  enabled: z.boolean().default(false),
  database: databaseLeakConfigSchema.optional(),
  files: filesLeakConfigSchema.optional(),
  storage: storageLeakConfigSchema.optional(),
  processes: processesLeakConfigSchema.optional(),
});

export type LeakConfig = z.infer<typeof leakConfigSchema>;
export type DatabaseLeakConfig = z.infer<typeof databaseLeakConfigSchema>;
export type FilesLeakConfig = z.infer<typeof filesLeakConfigSchema>;

/**
 * Reads the `leakCheck` block off a raw spec.
 *
 * Deliberately reads the RAW spec rather than a plugin's parsed one: the plugin
 * spec schemas live in `@qaai/shared` and strip keys they do not know about, so
 * by the time a plugin has its typed spec the leak config is already gone.
 *
 * Returns null when leak checking is off — which is the default, and also what a
 * spec with no `leakCheck` at all gets.
 *
 * A MALFORMED block is not silently ignored: it comes back as `enabled: true`
 * with a `configError`, so the watch can emit an inconclusive finding. Silently
 * treating a typo'd config as "off" is exactly the suppression this module is
 * supposed to make impossible.
 */
export function parseLeakConfig(rawSpec: unknown): (LeakConfig & { configError?: string }) | null {
  if (rawSpec === null || typeof rawSpec !== 'object') return null;
  const block = (rawSpec as Record<string, unknown>).leakCheck;
  if (block === undefined || block === null) return null;

  const parsed = leakConfigSchema.safeParse(block);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return {
      ...leakConfigSchema.parse({}),
      enabled: true,
      configError: `The leakCheck block is invalid, so nothing was checked — ${issues}`,
    };
  }

  return parsed.data.enabled ? parsed.data : null;
}

// ─── The shapes each surface snapshots ───────────────────────────────────────

/** `schema.table` → exact row count. */
export type RowCounts = Map<string, number>;

export interface RowCounter {
  counts(): Promise<RowCounts>;
  close(): Promise<void>;
}

export interface FileStamp {
  size: number;
  mtimeMs: number;
}

/** Relative path (POSIX-ish, as walked) → stamp. */
export type FileStamps = Map<string, FileStamp>;

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface CookieLike {
  name: string;
  domain: string;
  path?: string;
}

/**
 * The slice of a Playwright BrowserContext this module probes, declared
 * structurally so a caller passes its context straight in and a test passes a
 * fake. `serviceWorkers()` is accepted in both shapes Playwright has used
 * (objects with a `url()` method, or plain `{ url }`).
 */
export interface StorageProbe {
  cookies(): Promise<CookieLike[]>;
  serviceWorkers?: () =>
    Array<{ url: string | (() => string) }> | Promise<Array<{ url: string | (() => string) }>>;
}

// ─── Pure diffs (everything above this line is I/O, everything below is not) ──

export interface RowDelta {
  table: string;
  before: number;
  after: number;
}

export interface RowDiff {
  grew: RowDelta[];
  shrank: RowDelta[];
  appeared: string[];
  disappeared: string[];
}

/** `ignoreTables` accepts `schema.table` or a bare table name. */
function tableIgnored(qualified: string, ignore: readonly string[]): boolean {
  if (ignore.length === 0) return false;
  const bare = qualified.slice(qualified.indexOf('.') + 1);
  return ignore.some((entry) => entry === qualified || entry === bare);
}

export function diffRowCounts(
  before: RowCounts,
  after: RowCounts,
  ignore: readonly string[] = [],
): RowDiff {
  const diff: RowDiff = { grew: [], shrank: [], appeared: [], disappeared: [] };

  for (const [table, afterCount] of after) {
    if (tableIgnored(table, ignore)) continue;
    const beforeCount = before.get(table);
    if (beforeCount === undefined) {
      diff.appeared.push(table);
      continue;
    }
    if (afterCount > beforeCount) diff.grew.push({ table, before: beforeCount, after: afterCount });
    else if (afterCount < beforeCount)
      diff.shrank.push({ table, before: beforeCount, after: afterCount });
  }

  for (const table of before.keys()) {
    if (tableIgnored(table, ignore)) continue;
    if (!after.has(table)) diff.disappeared.push(table);
  }

  return diff;
}

export interface FileDiff {
  created: string[];
  deleted: string[];
}

export function diffFiles(before: FileStamps, after: FileStamps): FileDiff {
  const created: string[] = [];
  const deleted: string[] = [];
  for (const path of after.keys()) if (!before.has(path)) created.push(path);
  for (const path of before.keys()) if (!after.has(path)) deleted.push(path);
  return { created: created.sort(), deleted: deleted.sort() };
}

/**
 * Does a cookie's domain belong to something under test?
 *
 * Set-Cookie semantics: a leading dot means "and every subdomain". `example.com`
 * in the allow-list therefore also permits `.example.com` and `app.example.com`,
 * because that is what a cookie set by the app itself looks like. Anything else
 * — an analytics vendor, a stray `localhost` from a fixture, a sibling
 * environment — is a cookie the test wrote somewhere it does not own.
 */
export function cookieDomainAllowed(domain: string, allowed: readonly string[]): boolean {
  const cookieDomain = domain.replace(/^\./, '').toLowerCase();
  return allowed.some((raw) => {
    const base = raw.replace(/^\./, '').toLowerCase();
    if (base.length === 0) return false;
    return cookieDomain === base || cookieDomain.endsWith(`.${base}`);
  });
}

export function diffCookies(
  before: CookieLike[],
  after: CookieLike[],
  allowedDomains: readonly string[],
): CookieLike[] {
  const key = (c: CookieLike): string => `${c.name} ${c.domain} ${c.path ?? '/'}`;
  const seen = new Set(before.map(key));
  return after.filter((c) => !seen.has(key(c)) && !cookieDomainAllowed(c.domain, allowedDomains));
}

/** Service workers registered during the window and still registered at the end. */
export function diffServiceWorkers(before: string[], after: string[]): string[] {
  const seen = new Set(before);
  return [...new Set(after.filter((url) => !seen.has(url)))].sort();
}

/**
 * Processes that appeared during the window and are still running.
 *
 * Only NEW pids count. A worker legitimately keeps long-lived children — a
 * browser the harness launched for the whole run, a sidecar — and reporting
 * those on every test would be a false positive per test, which is the fastest
 * possible route to this whole feature being ignored.
 */
export function diffProcesses(
  before: ProcessRow[],
  after: ProcessRow[],
  ignoreCommands: readonly string[] = [],
): ProcessRow[] {
  const seen = new Set(before.map((p) => p.pid));
  return after.filter(
    (p) => !seen.has(p.pid) && !ignoreCommands.some((needle) => p.command.includes(needle)),
  );
}

/** Descendants of `rootPid`, however deep, from a flat process list. */
export function descendantsOf(rows: ProcessRow[], rootPid: number): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else byParent.set(row.ppid, [row]);
  }

  const out: ProcessRow[] = [];
  const queue = [rootPid];
  const visited = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of byParent.get(pid) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/** `  1234  5678 node` — pid, ppid, then the command, which may contain spaces. */
export function parseProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? '' });
  }
  return rows;
}

/**
 * Signal 0 asks "does this pid exist" without delivering anything. EPERM means
 * it exists and belongs to someone else — which still counts as alive, and
 * treating it as dead would be the detector hiding a leak from itself.
 */
export function pidIsAlive(
  pid: number,
  // Wrapped rather than passed as `process.kill`, which loses its `this`.
  kill: (p: number, sig: number) => void = (p, sig) => {
    process.kill(p, sig);
  },
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

// ─── Real snapshots ──────────────────────────────────────────────────────────

interface PgQueryResult {
  rows: Array<Record<string, unknown>>;
}

interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}

type PgClientCtor = new (config: {
  connectionString: string;
  application_name?: string;
  connectionTimeoutMillis?: number;
}) => PgClient;

/**
 * `pg` is a RUNTIME dependency, loaded dynamically: on a worker image built
 * without it the surface goes inconclusive with an install hint rather than
 * taking the runner down at import time. A missing tool is our environment's
 * problem, never the application-under-test's.
 */
async function loadPgClient(): Promise<PgClientCtor | null> {
  try {
    const mod = (await import('pg')) as unknown as {
      Client?: PgClientCtor;
      default?: { Client?: PgClientCtor };
    };
    return mod.Client ?? mod.default?.Client ?? null;
  } catch {
    return null;
  }
}

/**
 * Exact per-table counts in ONE round trip.
 *
 * `query_to_xml` runs a `count(*)` per table server-side and `format('%I')`
 * quotes each identifier there too, so a table named `"; drop table users; --`
 * is counted rather than executed. An estimate from `pg_class.reltuples` would
 * be cheaper and useless: it is only as fresh as the last ANALYZE, and the
 * question here is "are there three more rows than there were 200ms ago".
 */
const COUNT_TABLES_SQL = `
  select t.table_schema || '.' || t.table_name as name,
         (xpath(
            '/row/c/text()',
            query_to_xml(
              format('select count(*) as c from %I.%I', t.table_schema, t.table_name),
              false, true, ''
            )
          ))[1]::text::bigint as rows
    from information_schema.tables t
   where t.table_schema = any($1::text[])
     and t.table_type = 'BASE TABLE'
   order by 1
   limit $2`;

export async function openPostgresRowCounter(
  dsn: string,
  config: DatabaseLeakConfig,
): Promise<RowCounter> {
  const Client = await loadPgClient();
  if (!Client) {
    throw new Error(
      'the `pg` driver is not installed on this worker. Install it (npm install pg) and re-run',
    );
  }

  const client = new Client({
    connectionString: dsn,
    application_name: 'qaai-leak-check',
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();

  try {
    // Belt and braces. The detector only ever runs SELECTs, but a session that
    // physically cannot write is a much easier promise to keep than a review
    // that has to notice a future INSERT. The timeout keeps a sweep over a table
    // that is locked or enormous from hanging the run instead of the test.
    await client.query(`set statement_timeout = ${config.statementTimeoutMs}`);
    await client.query('set session characteristics as transaction read only');
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }

  return {
    async counts(): Promise<RowCounts> {
      const result = await client.query(COUNT_TABLES_SQL, [config.schemas, config.maxTables]);
      const counts: RowCounts = new Map();
      for (const row of result.rows) {
        const name = row.name;
        if (typeof name !== 'string') continue;
        // bigint arrives as a string from node-postgres.
        counts.set(name, Number(row.rows ?? 0));
      }
      return counts;
    },
    async close(): Promise<void> {
      await client.end().catch(() => undefined);
    },
  };
}

/**
 * Every file under `root`, keyed by its path relative to `root`.
 *
 * Symlinks are recorded but never followed — a link into `/` would turn a leak
 * check into a filesystem crawl. `maxEntries` is a hard stop rather than a
 * truncation: past it the caller reports inconclusive, because a partial walk
 * that claims to be complete is a leak we would have promised did not exist.
 */
export async function walkFiles(
  root: string,
  config: Pick<FilesLeakConfig, 'ignore' | 'maxEntries'>,
): Promise<{ stamps: FileStamps; truncated: boolean }> {
  const stamps: FileStamps = new Map();
  const ignore = new Set(config.ignore);
  let truncated = false;

  const walk = async (dir: string, prefix: string): Promise<void> => {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // A directory that does not exist yet is an empty snapshot, not an error:
      // that is precisely how "the test created this whole directory" is caught.
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw err;
    }

    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      if (stamps.size >= config.maxEntries) {
        truncated = true;
        return;
      }

      const absolute = `${dir}${sep}${entry.name}`;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await walk(absolute, relative);
        if (truncated) return;
        continue;
      }

      try {
        const info = await lstat(absolute);
        stamps.set(relative, { size: info.size, mtimeMs: info.mtimeMs });
      } catch (err) {
        // Vanished between readdir and lstat — a race with the app under test,
        // not something to fail the check over.
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      }
    }
  };

  await walk(root, '');
  return { stamps, truncated };
}

/** `ps` with args as an ARRAY and no shell — a command line is never assembled from data. */
export async function listProcesses(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,comm='], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 10_000,
  });
  return parseProcessTable(stdout);
}

async function readServiceWorkerUrls(probe: StorageProbe): Promise<string[]> {
  if (!probe.serviceWorkers) return [];
  const workers = await probe.serviceWorkers();
  return workers.map((w) => (typeof w.url === 'function' ? w.url() : w.url));
}

// ─── The watch ───────────────────────────────────────────────────────────────

export interface LeakWatchDeps {
  /** Vault secrets for the environment. The DSN is looked up here by name. */
  secrets: Readonly<Record<string, string>>;
  /** Falls back for the files surface when the config names no directory. */
  workspaceDir?: string | null;
  /** The environment's base URL — the default answer to "which cookie domains are ours". */
  baseUrl?: string | null;
  /** A browser context to probe. Omit it and the storage surface is skipped. */
  storage?: StorageProbe | null;
  logger?: { warn(msg: string, meta?: Record<string, unknown>): void } | null;
  /** Seams, so the surfaces can be exercised without a database or a process table. */
  openRowCounter?: (dsn: string, config: DatabaseLeakConfig) => Promise<RowCounter>;
  listProcesses?: () => Promise<ProcessRow[]>;
  rootPid?: number;
}

export interface LeakWatch {
  /**
   * Register a pid the test spawned. Belt and braces alongside the process-table
   * scan: a child that daemonises is reparented to init and stops being our
   * descendant, but it is still ours to reap.
   */
  track(pid: number): void;
  /** Never throws. An empty array means "we looked, and it was clean". */
  finish(): Promise<Finding[]>;
}

interface DirectorySnapshot {
  label: string;
  root: string;
  temporary: boolean;
  stamps: FileStamps;
}

/**
 * Takes the "before" snapshot and hands back something to call when the test is
 * done. Never throws: a surface that cannot be snapshotted records why and
 * reports it as inconclusive at the end, so leak checking can never be the
 * reason a run loses its result.
 */
export async function beginLeakWatch(
  config: LeakConfig & { configError?: string },
  deps: LeakWatchDeps,
): Promise<LeakWatch> {
  const mask = createMasker(Object.values(deps.secrets ?? {}));
  const inconclusive: Array<{ surface: string; reason: string }> = [];
  const note = (surface: string, reason: string): void => {
    inconclusive.push({ surface, reason });
    deps.logger?.warn(`leak check: ${surface} could not be checked`, { reason: mask(reason) });
  };

  const tracked = new Set<number>();

  // A config we could not read is reported, not obeyed. Nothing else runs,
  // because we do not know what was asked for.
  if (config.configError) {
    note('config', config.configError);
    return {
      track: (pid) => tracked.add(pid),
      finish: async () => toFindings([], inconclusive, mask),
    };
  }

  // ── database ──
  let counter: RowCounter | null = null;
  let rowsBefore: RowCounts | null = null;
  if (config.database) {
    const dbConfig = config.database;
    const dsn = deps.secrets?.[dbConfig.connectionSecretName];
    if (!dsn) {
      note(
        'database',
        `the secret ${dbConfig.connectionSecretName} is not set on this environment. Add it under Environment → Secrets as a Postgres connection string`,
      );
    } else {
      const refusal = productionRefusal(dsn);
      if (refusal && !dbConfig.allowProductionDatabase) {
        note(
          'database',
          `refused to count rows because ${refusal}. A sweep runs count(*) on every table, which is load a live system did not ask for. Point ${dbConfig.connectionSecretName} at a disposable database, or set leakCheck.database.allowProductionDatabase`,
        );
      } else {
        try {
          const open = deps.openRowCounter ?? openPostgresRowCounter;
          counter = await open(dsn, dbConfig);
          rowsBefore = await counter.counts();
          if (rowsBefore.size >= dbConfig.maxTables) {
            note(
              'database',
              `only the first ${dbConfig.maxTables} tables in ${dbConfig.schemas.join(', ')} were counted, so a leak in a later table would not be seen. Raise leakCheck.database.maxTables or narrow the schemas`,
            );
          }
        } catch (err) {
          const { database, host } = describeConnection(dsn);
          await counter?.close().catch(() => undefined);
          counter = null;
          rowsBefore = null;
          note(
            'database',
            `could not count rows in ${database ?? 'the database'}${host ? ` on ${host}` : ''}: ${errText(err)}`,
          );
        }
      }
    }
  }

  // ── files ──
  const directories: DirectorySnapshot[] = [];
  if (config.files) {
    const filesConfig = config.files;
    const configured =
      filesConfig.directories.length > 0
        ? filesConfig.directories
        : deps.workspaceDir
          ? [deps.workspaceDir]
          : [];

    if (configured.length === 0) {
      note(
        'files',
        'no directory to watch: leakCheck.files.directories is empty and this test has no run workspace',
      );
    }

    for (const label of configured) {
      const root = resolve(label);
      const tooBroad = walkRefusal(root);
      if (tooBroad) {
        note('files', `refused to walk ${label} — ${tooBroad}`);
        continue;
      }
      try {
        const { stamps, truncated } = await walkFiles(root, filesConfig);
        if (truncated) {
          note(
            'files',
            `${label} has more than ${filesConfig.maxEntries} entries, so it was not fully walked. Raise leakCheck.files.maxEntries or watch a narrower directory`,
          );
          continue;
        }
        directories.push({
          label,
          root,
          temporary: filesConfig.temporaryDirectories.includes(label),
          stamps,
        });
      } catch (err) {
        note('files', `could not read ${label}: ${errText(err)}`);
      }
    }
  }

  // ── storage ──
  let cookiesBefore: CookieLike[] | null = null;
  let workersBefore: string[] | null = null;
  if (config.storage) {
    if (!deps.storage) {
      note(
        'storage',
        'leakCheck.storage is configured but this test type has no browser context to probe',
      );
    } else {
      try {
        cookiesBefore = await deps.storage.cookies();
        workersBefore = await readServiceWorkerUrls(deps.storage);
      } catch (err) {
        cookiesBefore = null;
        workersBefore = null;
        note('storage', `could not read the browser context: ${errText(err)}`);
      }
    }
  }

  // ── processes ──
  let processesBefore: ProcessRow[] | null = null;
  const rootPid = deps.rootPid ?? process.pid;
  if (config.processes) {
    try {
      const list = deps.listProcesses ?? listProcesses;
      processesBefore = descendantsOf(await list(), rootPid);
    } catch (err) {
      processesBefore = null;
      note(
        'processes',
        `could not read the process table (${errText(err)}), so an unreaped child would not be seen`,
      );
    }
  }

  return {
    track: (pid: number) => tracked.add(pid),

    async finish(): Promise<Finding[]> {
      const leaks: LeakRecord[] = [];

      // ── database ──
      if (counter && rowsBefore) {
        try {
          const rowsAfter = await counter.counts();
          const diff = diffRowCounts(rowsBefore, rowsAfter, config.database?.ignoreTables ?? []);
          for (const delta of diff.grew) {
            const added = delta.after - delta.before;
            leaks.push({
              code: 'leak.database.rows',
              severity: added >= SERIOUS_ROW_GROWTH ? SEVERITY.destructive : SEVERITY.accumulates,
              location: delta.table,
              message: `${added} row(s) were left in ${delta.table} (${delta.before} → ${delta.after}). The test created them and did not clean them up, so every run of it adds ${added} more. Delete what the test creates in teardown, or run the work inside a transaction the test rolls back.`,
            });
          }
          for (const delta of diff.shrank) {
            leaks.push({
              code: 'leak.database.rows-deleted',
              severity: SEVERITY.destructive,
              location: delta.table,
              message: `${delta.before - delta.after} row(s) disappeared from ${delta.table} (${delta.before} → ${delta.after}). The test destroyed data it did not create; whatever ran before it will not find that data again.`,
            });
          }
          for (const table of diff.appeared) {
            leaks.push({
              code: 'leak.database.tables',
              severity: SEVERITY.destructive,
              location: table,
              message: `The table ${table} exists now and did not before. Structural residue outlives every later test in this database.`,
            });
          }
          for (const table of diff.disappeared) {
            leaks.push({
              code: 'leak.database.tables',
              severity: SEVERITY.destructive,
              location: table,
              message: `The table ${table} existed before this test and is gone now.`,
            });
          }
        } catch (err) {
          note('database', `could not re-count rows after the test: ${errText(err)}`);
        } finally {
          await counter.close().catch(() => undefined);
        }
      } else if (counter) {
        await counter.close().catch(() => undefined);
      }

      // ── files ──
      for (const dir of directories) {
        try {
          const { stamps, truncated } = await walkFiles(dir.root, config.files!);
          if (truncated) {
            note(
              'files',
              `${dir.label} grew past ${config.files!.maxEntries} entries during the test`,
            );
            continue;
          }
          const diff = diffFiles(dir.stamps, stamps);
          if (diff.created.length > 0) {
            leaks.push({
              code: dir.temporary ? 'leak.files.temp' : 'leak.files.workspace',
              severity: dir.temporary ? SEVERITY.disposable : SEVERITY.accumulates,
              location: `${dir.label}/${diff.created[0]}`,
              message: `${diff.created.length} file(s) were left in ${dir.label}: ${list(diff.created)}. A file left in a workspace is picked up by whatever globs that directory next — the next run's test collection, a build, or a coverage report.`,
            });
          }
          if (diff.deleted.length > 0) {
            leaks.push({
              code: 'leak.files.deleted',
              severity: SEVERITY.destructive,
              location: `${dir.label}/${diff.deleted[0]}`,
              message: `${diff.deleted.length} file(s) that existed before the test are gone from ${dir.label}: ${list(diff.deleted)}.`,
            });
          }
        } catch (err) {
          note('files', `could not re-read ${dir.label}: ${errText(err)}`);
        }
      }

      // ── storage ──
      if (deps.storage && config.storage && cookiesBefore && workersBefore) {
        const storageConfig = config.storage;
        try {
          const cookiesAfter = await deps.storage.cookies();

          if (storageConfig.expectDisposed) {
            // The probe answered, so the context is still alive. That is the
            // leak, and there is no point diffing what is inside it.
            leaks.push({
              code: 'leak.storage.context-open',
              severity: SEVERITY.holdsResource,
              location: deps.baseUrl ?? 'browser context',
              message:
                'The browser context was still open when the test finished. It holds its cookies, its storage and its share of the browser process, and the next test that reuses this browser inherits all of it. Close the context in teardown.',
            });
          }

          const allowed =
            storageConfig.allowedCookieDomains.length > 0
              ? storageConfig.allowedCookieDomains
              : defaultCookieDomains(deps.baseUrl ?? null);

          if (allowed.length === 0) {
            note(
              'storage',
              'no cookie domain could be derived from the base URL, so a cookie on the wrong domain would not be recognised. Set leakCheck.storage.allowedCookieDomains',
            );
          } else {
            for (const cookie of diffCookies(cookiesBefore, cookiesAfter, allowed)) {
              leaks.push({
                code: 'leak.storage.cookie-domain',
                severity: SEVERITY.crossesBoundary,
                location: cookie.domain,
                message: `The test left a cookie "${cookie.name}" on ${cookie.domain}, which is not a domain under test (${allowed.join(', ')}). A cookie written outside the application's own domain outlives the context in any shared or persisted profile and is sent to a host this test does not own.`,
              });
            }
          }

          for (const url of diffServiceWorkers(
            workersBefore,
            await readServiceWorkerUrls(deps.storage),
          )) {
            leaks.push({
              code: 'leak.storage.service-worker',
              severity: SEVERITY.accumulates,
              location: url,
              message: `A service worker registered during this test is still registered: ${url}. A registered worker intercepts the requests of whatever runs next in this profile, which is how one test starts serving another test's responses from cache.`,
            });
          }
        } catch (err) {
          // A context closed by the test is the good outcome, not an error —
          // unless the caller said it should still be open.
          if (storageConfig.expectDisposed) {
            deps.logger?.warn('leak check: browser context was already disposed, as expected');
          } else {
            note('storage', `could not re-read the browser context: ${errText(err)}`);
          }
        }
      }

      // ── processes ──
      if (config.processes) {
        const ignore = config.processes.ignoreCommands;
        const survivors = new Map<number, ProcessRow>();

        if (processesBefore) {
          try {
            const list = deps.listProcesses ?? listProcesses;
            const after = descendantsOf(await list(), rootPid);
            for (const row of diffProcesses(processesBefore, after, ignore)) {
              survivors.set(row.pid, row);
            }
          } catch (err) {
            note('processes', `could not re-read the process table: ${errText(err)}`);
          }
        }

        for (const pid of tracked) {
          if (survivors.has(pid)) continue;
          if (pidIsAlive(pid)) survivors.set(pid, { pid, ppid: rootPid, command: `pid ${pid}` });
        }

        for (const row of [...survivors.values()].sort((a, b) => a.pid - b.pid)) {
          leaks.push({
            code: 'leak.process.unreaped',
            severity: SEVERITY.holdsResource,
            location: `pid ${row.pid}`,
            message: `The test spawned ${row.command} (pid ${row.pid}) and it is still running. It holds whatever it opened — a port, a device, a database connection — and on a long-lived worker these accumulate until the next run cannot get the resource it needs.`,
          });
        }
      }

      return toFindings(leaks, inconclusive, mask);
    },
  };
}

// ─── Finding assembly ────────────────────────────────────────────────────────

interface LeakRecord {
  code: string;
  severity: Finding['severity'];
  location: string;
  message: string;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** Names in a message, capped so a thousand-file leak stays one readable line. */
function list(items: string[], max = 8): string {
  const head = items.slice(0, max).join(', ');
  return items.length > max ? `${head}, …and ${items.length - max} more` : head;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toFindings(
  leaks: LeakRecord[],
  inconclusive: Array<{ surface: string; reason: string }>,
  mask: (input: string) => string,
): Finding[] {
  const findings: Finding[] = leaks.map((leak) => ({
    kind: LEAK_FINDING_KIND,
    severity: leak.severity,
    code: leak.code,
    // Everything is masked on the way out: a DSN error message carries a
    // password, and a leaked filename can carry a token.
    message: truncate(mask(leak.message), MESSAGE_LIMIT),
    location: truncate(mask(leak.location), LOCATION_LIMIT),
    helpUrl: null,
  }));

  for (const gap of inconclusive) {
    findings.push({
      kind: LEAK_FINDING_KIND,
      severity: SEVERITY.inconclusive,
      code: `leak.${gap.surface}.inconclusive`,
      message: truncate(
        mask(
          `Leak checking did not cover ${gap.surface} for this test, so a leak there would not have been reported: ${gap.reason}.`,
        ),
        MESSAGE_LIMIT,
      ),
      location: gap.surface,
      helpUrl: null,
    });
  }

  return findings;
}

/**
 * Directories too broad to walk for a leak check.
 *
 * `directories` is org-authored spec data, and the names of files under whatever
 * it points at end up in a finding. Walking `/` or a home directory would put
 * the worker's own filesystem into a customer's report, and would take minutes
 * doing it.
 */
function walkRefusal(root: string): string | null {
  if (root === parsePath(root).root) return 'the filesystem root is not a workspace';
  if (root === resolve(homedir())) return 'a home directory is not a workspace';
  return null;
}

/** The cookie domains an app under test legitimately owns, from its base URL. */
export function defaultCookieDomains(baseUrl: string | null): string[] {
  if (!baseUrl) return [];
  try {
    return [new URL(baseUrl).hostname.toLowerCase()];
  } catch {
    return [];
  }
}

// ─── Gate support ────────────────────────────────────────────────────────────

/**
 * What a gate rule needs to know about a test's leaks.
 *
 * `packages/runner/src/gates.ts` evaluates its rules over statuses and verdicts,
 * not findings, so this is the seam rather than the wiring: it turns a test's
 * findings into the two numbers and one severity a rule would key on, without
 * this module reaching into the gate evaluator (which it must not edit) or
 * inventing a rule kind that the shared GateRule union does not have.
 *
 * `inconclusive` is reported SEPARATELY and never folded into `worstSeverity`.
 * A rule that blocked on inconclusive results would punish a team for a missing
 * driver on our worker; a rule that counted them as clean would let a broken
 * detector wave leaks through. Both numbers, honestly, and the rule decides.
 */
export interface LeakGateSummary {
  leakCount: number;
  inconclusiveCount: number;
  worstSeverity: Finding['severity'] | null;
  codes: string[];
}

const SEVERITY_ORDER: Record<Finding['severity'], number> = {
  MINOR: 0,
  MODERATE: 1,
  SERIOUS: 2,
  CRITICAL: 3,
};

export function leakGateSummary(findings: readonly Finding[]): LeakGateSummary {
  const leaks = findings.filter((f) => isLeakFinding(f) && !isInconclusiveLeakFinding(f));
  const inconclusiveCount = findings.filter(isInconclusiveLeakFinding).length;

  let worstSeverity: Finding['severity'] | null = null;
  for (const finding of leaks) {
    if (
      worstSeverity === null ||
      SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[worstSeverity]
    ) {
      worstSeverity = finding.severity;
    }
  }

  return {
    leakCount: leaks.length,
    inconclusiveCount,
    worstSeverity,
    codes: [...new Set(leaks.map((f) => f.code))].sort(),
  };
}
