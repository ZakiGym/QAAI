import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

/**
 * Direct Postgres access, for the one thing the API cannot give this suite.
 *
 * Triage is the screen where a human agrees or disagrees with the machine, and
 * a verdict is only ever written by the triage pipeline, which needs a model.
 * There is no ANTHROPIC_API_KEY on this deployment, so on a real stack that
 * table is empty and the whole screen is an empty state — which is exactly the
 * situation the house rule covers: a missing credential is SKIPPED with an
 * actionable sentence, never faked and never failed.
 *
 * So the triage spec seeds one verdict of its own, drives the UI against it,
 * and deletes it again. The seeding is setup, not the thing under test; every
 * assertion is still about what a person sees and does on the screen.
 */

export type VerdictKind = 'REAL_BUG' | 'INTENDED_CHANGE' | 'FLAKE' | 'ENV_ISSUE';

export interface SeededVerdict {
  id: string;
  testName: string;
  verdict: VerdictKind;
  explanation: string;
  evidenceDetail: string;
}

/**
 * Where the database is.
 *
 * Falls back to the repo's own .env because that is where `npm run dev` reads
 * it from — a suite that demanded the variable be exported by hand would be
 * skipped on every machine that runs the stack the normal way.
 */
export function databaseUrl(): string | null {
  const fromEnv = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;

  const dotenv = path.join(__dirname, '..', '..', '.env');
  try {
    const line = fs
      .readFileSync(dotenv, 'utf8')
      .split('\n')
      .find((row) => row.startsWith('DATABASE_URL='));
    if (!line) return null;
    return line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '') || null;
  } catch {
    return null;
  }
}

export const NO_DATABASE =
  'No DATABASE_URL — the triage spec seeds a verdict directly, because verdicts are only written ' +
  'by the triage pipeline and that needs ANTHROPIC_API_KEY. Export DATABASE_URL (or E2E_DATABASE_URL) ' +
  'and re-run, or run the triage journey by hand.';

/** Ids the way the app makes them: opaque, sortable enough, and obviously ours. */
function scratchId(): string {
  return `e2edog${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

interface Seeded {
  verdicts: SeededVerdict[];
  cleanup: () => Promise<void>;
}

/**
 * Put `count` PENDING verdicts on failed results that do not already have one.
 *
 * Returns null when the database is unreachable or there is nothing to attach
 * to, so the caller can skip with a sentence rather than fail with a stack.
 */
export async function seedPendingVerdicts(count: number): Promise<Seeded | null> {
  const url = databaseUrl();
  if (!url) return null;

  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch {
    return null;
  }

  try {
    const candidates = await client.query<{ id: string; orgId: string; name: string }>(
      `SELECT tr.id, tr."orgId", t.name
         FROM "TestResult" tr
         JOIN "Test" t ON t.id = tr."testId"
    LEFT JOIN "TriageVerdict" v ON v."testResultId" = tr.id
        WHERE tr.status = 'FAILED' AND v.id IS NULL
     ORDER BY tr."createdAt" DESC
        LIMIT $1`,
      [count],
    );
    if (candidates.rows.length < count) return null;

    const verdicts: SeededVerdict[] = [];
    for (const [index, row] of candidates.rows.entries()) {
      const id = scratchId();
      const explanation = `Dogfood fixture ${index + 1}: the run failed on an assertion the app has never satisfied on this environment.`;
      const evidenceDetail = `Dogfood evidence ${index + 1} — the step that failed, quoted back.`;
      await client.query(
        `INSERT INTO "TriageVerdict"
           (id, "orgId", "testResultId", verdict, confidence, explanation, evidence, model, "reviewState")
         VALUES ($1, $2, $3, 'REAL_BUG', 0.91, $4, $5::jsonb, 'e2e-dogfood-fixture', 'PENDING')`,
        [
          id,
          row.orgId,
          row.id,
          explanation,
          JSON.stringify([{ kind: 'step', ref: `result:${row.id}`, detail: evidenceDetail }]),
        ],
      );
      verdicts.push({
        id,
        testName: row.name,
        verdict: 'REAL_BUG',
        explanation,
        evidenceDetail,
      });
    }

    return {
      verdicts,
      cleanup: async () => {
        try {
          // The batch rows a bulk review creates cascade from the verdict, so
          // deleting these takes the whole fixture back out.
          await client.query(`DELETE FROM "TriageVerdict" WHERE id = ANY($1::text[])`, [
            verdicts.map((v) => v.id),
          ]);
        } finally {
          await client.end();
        }
      },
    };
  } catch {
    await client.end().catch(() => {});
    return null;
  }
}

/** Read a verdict's review state back, to prove the click reached the database. */
export async function reviewStateOf(verdictId: string): Promise<string | null> {
  const url = databaseUrl();
  if (!url) return null;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ reviewState: string; overriddenTo: string | null }>(
      `SELECT "reviewState", "overriddenTo" FROM "TriageVerdict" WHERE id = $1`,
      [verdictId],
    );
    if (rows.length === 0) return null;
    return rows[0]!.overriddenTo
      ? `${rows[0]!.reviewState}:${rows[0]!.overriddenTo}`
      : rows[0]!.reviewState;
  } finally {
    await client.end();
  }
}
