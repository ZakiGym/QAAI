/**
 * Database testing (§4 DATABASE).
 *
 * The layer nothing tests until it corrupts something. Four things this asserts
 * that a normal suite never does:
 *
 *  1. A migration applied FORWARD and then BACK, with the schema compared either
 *     side. The rollback half of a migration set is written once and exercised
 *     for the first time during an incident.
 *  2. A named constraint must REJECT the row that violates it. A unique index
 *     dropped by a migration and never recreated is invisible until the day the
 *     duplicate matters.
 *  3. Arbitrary SQL assertions — expected rowcount, expected value.
 *  4. Everything above inside ONE transaction that is always rolled back, so a
 *     test cannot leave residue in the database it was pointed at.
 *
 * ENGINES: Postgres only. `pg` is already in the tree via Prisma, and a plugin
 * that advertised MySQL/SQLite without a driver behind it would fail at run time
 * instead of at validation time. `engine` exists in the spec so adding one later
 * is additive rather than a breaking change.
 *
 * The connection string is resolved from a VAULT SECRET NAME. A spec is
 * org-authored data that lives in a git repo; a DSN carries a password.
 */

import { createMasker, databaseTestSpecSchema } from '@qaai/shared';
import type {
  DatabaseStep,
  DatabaseTestSpec,
  ExecutableTest,
  RunContext,
  RunnerPlugin,
  StepResult,
  TestExecution,
} from '@qaai/shared';

// ─── The slice of node-postgres this plugin uses ─────────────────────────────
//
// Declared locally and loaded with a dynamic import so the driver is a RUNTIME
// dependency only: on a worker image built without it the test reports SKIPPED
// with the install command instead of taking the whole runner down at import.

interface PgQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
  fields: Array<{ name: string }>;
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

/** How long to wait for the TCP/auth handshake before calling the database down. */
const CONNECT_TIMEOUT_MS = 10_000;

// ─── Production safety ───────────────────────────────────────────────────────

/**
 * A database whose name or host looks like production.
 *
 * "prod", "production", "prd" and "live" as whole words — `myproduct` and
 * `reproduce` deliberately do not match.
 */
const PRODUCTION_WORD = /(^|[^a-z0-9])(prod|production|prd|live)([^a-z0-9]|$)/i;

/** Best-effort read of the database name and host out of either DSN form. */
export function describeConnection(dsn: string): { database: string | null; host: string | null } {
  try {
    const url = new URL(dsn);
    const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || null;
    return { database, host: url.hostname || null };
  } catch {
    // `host=db.internal dbname=app user=…` — libpq's key/value form.
    const database = /(?:^|\s)(?:dbname|database)=([^\s]+)/i.exec(dsn)?.[1] ?? null;
    const host = /(?:^|\s)host=([^\s]+)/i.exec(dsn)?.[1] ?? null;
    return { database, host };
  }
}

/**
 * Why this connection must not be written to without an explicit opt-in, or null
 * when it looks safe.
 *
 * THE RULE: destructive steps (seed, migrations, constraint probes, any
 * non-SELECT statement) are refused when the database name or host looks like
 * production, unless the spec sets `allowProductionDatabase: true`.
 *
 * Everything here runs inside a rolled-back transaction, so why refuse at all?
 * Because a rollback is not a safety net on a live system. DDL takes ACCESS
 * EXCLUSIVE locks that stall production traffic for as long as the test holds
 * them; sequences, advisory locks and anything a trigger writes over dblink do
 * not roll back; and a worker killed mid-test leaves the transaction open until
 * the idle timeout fires. The blast radius of a wrong DSN is the whole product,
 * so this fails CLOSED — a DSN we cannot parse is treated as production too.
 */
export function productionRefusal(dsn: string): string | null {
  const { database, host } = describeConnection(dsn);

  if (!database) {
    return 'the database name could not be read from the connection string, so it cannot be shown to be non-production';
  }
  if (PRODUCTION_WORD.test(database)) {
    return `the database is named "${database}", which looks like production`;
  }
  if (host && PRODUCTION_WORD.test(host)) {
    return `the database host "${host}" looks like production`;
  }
  return null;
}

/**
 * Does this statement only read?
 *
 * Used solely to decide whether the production guard applies — the transaction
 * itself is opened READ ONLY when nothing writes, which is what actually
 * enforces it. Conservative on purpose: multi-statement text, and anything
 * containing a write keyword anywhere (including inside a string literal),
 * counts as a write. A read misclassified as a write asks for an opt-in; a
 * write misclassified as a read would run against production.
 */
export function isReadOnlyStatement(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim()
    .replace(/;\s*$/, '');

  if (stripped.includes(';')) return false;
  if (!/^(select|with|explain|show|table|values)\b/i.test(stripped)) return false;
  return !/\b(insert|update|delete|merge|drop|create|alter|truncate|grant|revoke|call|do|copy|vacuum|refresh)\b/i.test(
    stripped,
  );
}

function stepWrites(step: DatabaseStep): boolean {
  if (step.kind === 'migration') return true;
  // A constraint probe attempts the violating write. It is expected to be
  // rejected, but it is still a write attempt.
  if (step.kind === 'constraint') return true;
  return !isReadOnlyStatement(step.sql);
}

// ─── Schema fingerprint ──────────────────────────────────────────────────────

/**
 * The comparison behind "the rollback actually restored the prior schema".
 *
 * Four queries, each producing one sorted text line per object, so a mismatch
 * can be reported as named objects rather than "the schemas differ". This is a
 * fingerprint, not a pg_dump: columns, constraints, indexes and enum labels are
 * covered; functions, triggers, grants, sequence positions and row data are not.
 *
 * Postgres auto-names the NOT NULL check constraints it generates after table
 * OIDs (`2200_16389_3_not_null`), which change when a table is dropped and
 * recreated even though the schema is identical. They are filtered out — column
 * nullability is already covered by the columns query.
 */
const FINGERPRINT_QUERIES: readonly string[] = [
  `select table_schema || '.' || table_name || '.' || column_name
        || ' type=' || data_type
        || coalesce('(' || character_maximum_length || ')', '')
        || ' null=' || is_nullable
        || ' default=' || coalesce(column_default, '-') as line
     from information_schema.columns
    where table_schema = any($1::text[])`,

  `select n.nspname
        || '.' || case when c.conrelid = 0 then '-' else c.conrelid::regclass::text end
        || ' ' || c.conname
        || ' ' || pg_get_constraintdef(c.oid) as line
     from pg_constraint c
     join pg_namespace n on n.oid = c.connamespace
    where n.nspname = any($1::text[])
      and c.conname !~ '^[0-9]+_[0-9]+_[0-9]+_not_null$'`,

  `select schemaname || '.' || tablename || ' ' || indexname || ' ' || indexdef as line
     from pg_indexes
    where schemaname = any($1::text[])`,

  `select n.nspname || '.' || t.typname || ' = '
        || string_agg(e.enumlabel, ',' order by e.enumsortorder) as line
     from pg_type t
     join pg_namespace n on n.oid = t.typnamespace
     join pg_enum e on e.enumtypid = t.oid
    where n.nspname = any($1::text[])
    group by n.nspname, t.typname`,
];

async function fingerprint(client: PgClient, schemas: string[]): Promise<string[]> {
  const lines: string[] = [];
  for (const sql of FINGERPRINT_QUERIES) {
    const result = await client.query(sql, [schemas]);
    for (const row of result.rows) {
      const line = row.line;
      if (typeof line === 'string') lines.push(line);
    }
  }
  return lines.sort();
}

/** A readable "what the rollback left behind" summary, capped so it stays legible. */
function describeSchemaDrift(before: string[], after: string[]): string {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const leftBehind = after.filter((l) => !beforeSet.has(l));
  const notRestored = before.filter((l) => !afterSet.has(l));

  const cap = (lines: string[]): string =>
    lines
      .slice(0, 6)
      .map((l) => `  • ${l}`)
      .concat(lines.length > 6 ? [`  • …and ${lines.length - 6} more`] : [])
      .join('\n');

  const parts: string[] = [];
  if (leftBehind.length > 0) parts.push(`Left behind by the rollback:\n${cap(leftBehind)}`);
  if (notRestored.length > 0) parts.push(`Not restored by the rollback:\n${cap(notRestored)}`);
  return parts.join('\n');
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** node-postgres puts SQLSTATE on `code` and the offending constraint on `constraint`. */
interface DbErrorFields {
  message: string;
  code: string | null;
  constraint: string | null;
  detail: string | null;
}

function asDbError(err: unknown): DbErrorFields {
  const e = (err ?? {}) as Record<string, unknown>;
  let message = err instanceof Error ? err.message : String(err);
  // Node's happy-eyeballs connect failures arrive as an AggregateError whose own
  // message is empty; without this the user gets "Could not connect to db: ".
  if (!message && Array.isArray(e.errors)) {
    message = e.errors
      .map((inner) => (inner instanceof Error ? inner.message : String(inner)))
      .filter(Boolean)
      .join('; ');
  }
  if (!message) message = typeof e.code === 'string' ? e.code : 'unknown error';

  return {
    message,
    code: typeof e.code === 'string' ? e.code : null,
    constraint: typeof e.constraint === 'string' ? e.constraint : null,
    detail: typeof e.detail === 'string' ? e.detail : null,
  };
}

/** SQLSTATE class 23 is integrity_constraint_violation — unique, FK, check, not-null. */
function isIntegrityViolation(code: string | null): boolean {
  return code !== null && code.startsWith('23');
}

/**
 * Postgres puts the useful half of an error in DETAIL — "Key (name)=(alpha)
 * already exists" — so a message without it reads as if nothing was learned.
 */
function fullMessage(err: DbErrorFields): string {
  return err.detail ? `${err.message} — ${err.detail}` : err.message;
}

// ─── Value comparison ────────────────────────────────────────────────────────

/**
 * Loose on purpose. Postgres returns `count(*)` and every bigint as a STRING,
 * and timestamps as Date objects. `value: 3` is what the author meant even when
 * the driver hands back `"3"`, and a strict comparison here would make the
 * commonest assertion in the product fail for a reason nobody could see.
 */
export function valueMatches(got: unknown, want: unknown): boolean {
  const norm = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v);
  const a = norm(got);
  const b = norm(want);
  if (JSON.stringify(a) === JSON.stringify(b)) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'object' || typeof b === 'object') return false;
  return String(a) === String(b);
}

function render(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ─── Steps ───────────────────────────────────────────────────────────────────

/** The cockpit rows a spec step will produce, named up front so a skip path can reuse them. */
function titlesFor(step: DatabaseStep): string[] {
  if (step.kind === 'migration') {
    return [
      `${step.name} — apply migration`,
      `${step.name} — apply rollback`,
      `${step.name} — rollback restored the previous schema`,
    ];
  }
  if (step.kind === 'constraint') {
    return [`${step.name} — ${step.constraint} rejects the violating row`];
  }
  return [step.name];
}

export const databasePlugin: RunnerPlugin = {
  type: 'DATABASE',

  validate(test: ExecutableTest): void {
    const parsed = databaseTestSpecSchema.safeParse(test.spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`Database test "${test.name}" has an invalid spec — ${issues}`);
    }
  },

  async execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const spec: DatabaseTestSpec = databaseTestSpecSchema.parse(test.spec);
    const startedAt = Date.now();
    const mask = createMasker(Object.values(ctx.secrets));

    const base: Omit<TestExecution, 'status' | 'steps' | 'errorMessage'> = {
      testId: test.id,
      durationMs: 0,
      network: [],
      console: [],
      videoKey: null,
      traceKey: null,
      retriedAndPassed: false,
      findings: [],
    };

    const finish = (
      status: TestExecution['status'],
      steps: StepResult[],
      errorMessage: string | null,
    ): TestExecution => ({
      ...base,
      status,
      durationMs: Date.now() - startedAt,
      steps,
      errorMessage: errorMessage === null ? null : mask(errorMessage),
    });

    const connectionString = ctx.secrets[spec.connectionSecretName];
    if (!connectionString) {
      // A missing secret is a configuration gap, not a failing database.
      return finish(
        'SKIPPED',
        [],
        `The secret ${spec.connectionSecretName} is not set on this environment, so the test was not evaluated. Add it under Environment → Secrets as a Postgres connection string.`,
      );
    }

    const writes = spec.seed.length > 0 || spec.steps.some(stepWrites);
    const refusal = productionRefusal(connectionString);
    if (writes && refusal && !spec.allowProductionDatabase) {
      return finish(
        'SKIPPED',
        [],
        `Refused to run write steps because ${refusal}. Nothing was executed. Point ${spec.connectionSecretName} at a disposable database, or set "allowProductionDatabase": true in the spec if this really is intended.`,
      );
    }

    const Client = await loadPgClient();
    if (!Client) {
      // A missing driver is a worker-image gap. Reporting it as FAILED would
      // blame the customer's database for something QAAI did not install.
      return finish(
        'SKIPPED',
        [],
        'The `pg` driver is not installed on this worker, so the test was not evaluated. Install it (npm install pg) and re-run.',
      );
    }

    const client = new Client({
      connectionString,
      application_name: 'qaai-database-test',
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });

    try {
      await client.connect();
    } catch (err) {
      // Unreachable is NOT a configuration gap in the same sense: the database
      // under test is down or unreachable, which is a real result.
      const { message } = asDbError(err);
      const { database, host } = describeConnection(connectionString);
      return finish(
        'FAILED',
        [],
        `Could not connect to ${database ?? 'the database'}${host ? ` on ${host}` : ''}: ${message}`,
      );
    }

    const steps: StepResult[] = [];
    const push = (
      title: string,
      status: StepResult['status'],
      durationMs: number,
      error: StepResult['error'],
    ): void => {
      const index = steps.length;
      steps.push({
        index,
        title,
        status,
        startedAt: new Date().toISOString(),
        durationMs,
        screenshotKey: null,
        error: error
          ? {
              ...error,
              message: mask(error.message),
              expected: error.expected === null ? null : mask(error.expected),
              actual: error.actual === null ? null : mask(error.actual),
            }
          : null,
      });
      ctx.logger.step({ testId: test.id, index, title, status });
    };

    const fail = (message: string, expected: string | null = null, actual: string | null = null) => ({
      message,
      stack: null,
      selector: null,
      expected,
      actual,
    });

    const skipFrom = (index: number): void => {
      for (const step of spec.steps.slice(index)) {
        for (const title of titlesFor(step)) push(title, 'SKIPPED', 0, null);
      }
    };

    let savepointCounter = 0;

    try {
      // READ ONLY when nothing in the spec writes: Postgres itself then enforces
      // what the guard above only inferred.
      await client.query(writes ? 'BEGIN READ WRITE' : 'BEGIN READ ONLY');
      // SET LOCAL: both revert with the transaction. The idle timeout matters as
      // much as the statement one — a worker killed mid-test must not leave a
      // transaction holding locks on a shared database.
      await client.query(`SET LOCAL statement_timeout = ${spec.statementTimeoutMs}`);
      await client.query(
        `SET LOCAL idle_in_transaction_session_timeout = ${Math.max(spec.statementTimeoutMs * 2, 30_000)}`,
      );

      if (spec.seed.length > 0) {
        const t0 = Date.now();
        try {
          for (const sql of spec.seed) await client.query(sql);
          push('Seed data (rolled back at the end)', 'PASSED', Date.now() - t0, null);
        } catch (err) {
          const message = fullMessage(asDbError(err));
          push('Seed data (rolled back at the end)', 'FAILED', Date.now() - t0, fail(`Seed failed: ${message}`));
          // Every assertion below was written against seeded state; running them
          // now would produce failures that say nothing about the database.
          skipFrom(0);
          return finish('FAILED', steps, `Seed failed: ${message}`);
        }
      }

      for (const [specIndex, step] of spec.steps.entries()) {
        if (ctx.signal.aborted) {
          skipFrom(specIndex);
          break;
        }

        const savepoint = `qaai_sp_${(savepointCounter += 1)}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        let releaseSavepoint = true;
        const t0 = Date.now();

        try {
          if (step.kind === 'sql') {
            const result = await client.query(step.sql, step.params.length ? step.params : undefined);
            const problems: string[] = [];
            let expected: string | null = null;
            let actual: string | null = null;
            const rows = result.rowCount ?? result.rows.length;
            const e = step.expect;

            if (e.rowCount !== undefined && rows !== e.rowCount) {
              problems.push(`Expected ${e.rowCount} row(s), got ${rows}`);
              expected = `${e.rowCount} row(s)`;
              actual = `${rows} row(s)`;
            }
            if (e.minRowCount !== undefined && rows < e.minRowCount) {
              problems.push(`Expected at least ${e.minRowCount} row(s), got ${rows}`);
            }
            if (e.maxRowCount !== undefined && rows > e.maxRowCount) {
              problems.push(`Expected at most ${e.maxRowCount} row(s), got ${rows}`);
            }

            if (e.value !== undefined) {
              const first = result.rows[0];
              const column = e.column ?? result.fields[0]?.name;
              if (!first) {
                problems.push(`Expected a value of ${render(e.value)} but the query returned no rows`);
                expected ??= render(e.value);
                actual ??= 'no rows';
              } else if (!column || !(column in first)) {
                problems.push(
                  `Column "${e.column ?? '(first)'}" is not in the result (columns: ${result.fields.map((f) => f.name).join(', ')})`,
                );
              } else {
                const got = first[column];
                if (!valueMatches(got, e.value)) {
                  problems.push(`${column} was ${render(got)}, expected ${render(e.value)}`);
                  expected ??= render(e.value);
                  actual ??= render(got);
                }
              }
            }

            if (problems.length > 0) {
              releaseSavepoint = false;
              push(step.name, 'FAILED', Date.now() - t0, fail(problems.join('; '), expected, actual));
            } else {
              push(step.name, 'PASSED', Date.now() - t0, null);
            }
          } else if (step.kind === 'constraint') {
            const title = titlesFor(step)[0] ?? step.name;
            let rejected: DbErrorFields | null = null;
            try {
              await client.query(step.sql, step.params.length ? step.params : undefined);
            } catch (err) {
              rejected = asDbError(err);
            }
            // The statement either failed (good) or left the transaction dirty
            // (bad); either way this step's write must not survive.
            releaseSavepoint = false;

            if (!rejected) {
              push(
                title,
                'FAILED',
                Date.now() - t0,
                fail(
                  `The statement SUCCEEDED — constraint ${step.constraint} did not reject it, so it is no longer being enforced.`,
                  `rejected by ${step.constraint}`,
                  'accepted',
                ),
              );
            } else if (
              step.expectSqlState
                ? rejected.code !== step.expectSqlState
                : !isIntegrityViolation(rejected.code)
            ) {
              push(
                title,
                'FAILED',
                Date.now() - t0,
                fail(
                  `The statement failed, but not on a constraint: ${fullMessage(rejected)}`,
                  step.expectSqlState ? `SQLSTATE ${step.expectSqlState}` : 'SQLSTATE 23xxx',
                  `SQLSTATE ${rejected.code ?? 'unknown'}`,
                ),
              );
            } else if (rejected.constraint !== null && rejected.constraint !== step.constraint) {
              // A different constraint fired first, so the one under test was
              // never exercised — reporting a pass here would be a lie.
              push(
                title,
                'FAILED',
                Date.now() - t0,
                fail(
                  `Rejected by ${rejected.constraint}, not ${step.constraint}, so ${step.constraint} was never exercised.`,
                  step.constraint,
                  rejected.constraint,
                ),
              );
            } else {
              push(title, 'PASSED', Date.now() - t0, null);
            }
          } else {
            // A migration step is a round-trip experiment: it always ends with
            // the savepoint rolled back, so a later step never runs against a
            // half-migrated schema.
            releaseSavepoint = false;
            const [upTitle, downTitle, restoreTitle] = titlesFor(step) as [string, string, string];

            const before = await fingerprint(client, spec.schemas);

            try {
              for (const sql of step.up) await client.query(sql);
            } catch (err) {
              const message = fullMessage(asDbError(err));
              push(upTitle, 'FAILED', Date.now() - t0, fail(`Migration failed: ${message}`));
              push(downTitle, 'SKIPPED', 0, null);
              push(restoreTitle, 'SKIPPED', 0, null);
              continue;
            }

            const afterUp = await fingerprint(client, spec.schemas);
            const changed = describeSchemaDrift(before, afterUp) !== '';
            if (step.expectSchemaChange && !changed) {
              push(
                upTitle,
                'FAILED',
                Date.now() - t0,
                fail(
                  'The migration ran but changed nothing in the schema — it is either a no-op or it did not apply. Set "expectSchemaChange": false if this is a data-only migration.',
                  'a schema change',
                  'no schema change',
                ),
              );
            } else {
              push(upTitle, 'PASSED', Date.now() - t0, null);
            }

            const downStarted = Date.now();
            try {
              for (const sql of step.down) await client.query(sql);
            } catch (err) {
              const message = fullMessage(asDbError(err));
              push(downTitle, 'FAILED', Date.now() - downStarted, fail(`Rollback failed: ${message}`));
              push(restoreTitle, 'SKIPPED', 0, null);
              continue;
            }
            push(downTitle, 'PASSED', Date.now() - downStarted, null);

            const restoreStarted = Date.now();
            const afterDown = await fingerprint(client, spec.schemas);
            const drift = describeSchemaDrift(before, afterDown);
            if (drift === '') {
              push(restoreTitle, 'PASSED', Date.now() - restoreStarted, null);
            } else {
              push(
                restoreTitle,
                'FAILED',
                Date.now() - restoreStarted,
                fail(
                  `The rollback did not restore the schema.\n${drift}`,
                  'the schema as it was before the migration',
                  'a different schema',
                ),
              );
            }
          }
        } catch (err) {
          // An unexpected driver/SQL error in a step is that step's failure, not
          // the run's — the remaining steps still have something to say.
          releaseSavepoint = false;
          const message = fullMessage(asDbError(err));
          const titles = titlesFor(step);
          push(titles[0] ?? step.name, 'FAILED', Date.now() - t0, fail(message));
          for (const extra of titles.slice(1)) push(extra, 'SKIPPED', 0, null);
        } finally {
          // ROLLBACK TO is also how the transaction is made usable again after an
          // expected constraint violation aborted it.
          if (!releaseSavepoint) {
            await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => undefined);
          }
          await client.query(`RELEASE SAVEPOINT ${savepoint}`).catch(() => undefined);
        }
      }

      const failed = steps.filter((s) => s.status === 'FAILED');
      const status: TestExecution['status'] =
        failed.length > 0 ? 'FAILED' : steps.every((s) => s.status === 'SKIPPED') ? 'SKIPPED' : 'PASSED';

      return finish(
        status,
        steps,
        failed.length > 0
          ? `${failed.length} of ${steps.length} checks failed. First: ${failed[0]?.error?.message ?? ''}`
          : status === 'SKIPPED'
            ? 'The run was cancelled before any check ran.'
            : null,
      );
    } catch (err) {
      // Never let a reporting or transport problem lose the steps already proven.
      const { message } = asDbError(err);
      return finish('FAILED', steps, `Database test could not complete: ${message}`);
    } finally {
      // The whole point: nothing this test did is left in the database. Best
      // effort — if ROLLBACK itself fails the connection is going away anyway,
      // which ends the transaction the same way.
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  },
};
