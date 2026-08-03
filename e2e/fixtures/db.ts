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
 * Put `count` PENDING verdicts on failures of the fixture's own making, each
 * guaranteed to render as its own "cause of one".
 *
 * This used to borrow the most recent verdict-less FAILED results — and that
 * was a full-suite-only flake with a two-step mechanism: runs.spec starts a
 * REAL run minutes earlier, its freshest failures are what this fixture picks
 * up, two of them can share an error signature, and the triage screen then
 * clusters the two seeded verdicts into ONE ×2 group. A group renders only its
 * surest member's explanation, so a test scoped to the other verdict's
 * explanation matched nothing and hung. The failure only existed when the whole
 * suite ran, which is the worst kind.
 *
 * Fresh results with WORD-distinct errors and no step rows cannot cluster.
 * "Distinct" has to mean distinct after normalisation: the clusterer strips
 * digits, ids and paths on purpose — `probe 0 …r0` and `probe 1 …r1` normalise
 * to the same signature and grouped anyway, which is how the first version of
 * this fix reintroduced the very flake it was written to kill. Each template
 * below differs in its MATCHER and its prose, which are facets the normaliser
 * keeps. Cleanup deletes the run; results and verdicts cascade.
 *
 * Returns null when the database is unreachable or there is nothing to build
 * on, so the caller can skip with a sentence rather than fail with a stack.
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
    const template = await client.query<{
      orgId: string;
      projectId: string;
      environmentId: string;
    }>(
      `SELECT "orgId", "projectId", "environmentId" FROM "Run"
        ORDER BY "startedAt" DESC NULLS LAST LIMIT 1`,
    );
    if (template.rows.length === 0) return null;
    const { orgId, projectId, environmentId } = template.rows[0]!;

    const tests = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM "Test"
        WHERE "projectId" = $1 AND "disabledAt" IS NULL
        ORDER BY "createdAt" ASC LIMIT $2`,
      [projectId, count],
    );
    if (tests.rows.length < count) return null;

    const runId = scratchId();
    await client.query(
      `INSERT INTO "Run" (id, "orgId", "projectId", "environmentId", status, trigger, "queuedAt", "startedAt", "finishedAt")
       VALUES ($1, $2, $3, $4, 'FAILED', 'MANUAL', now(), now(), now())`,
      [runId, orgId, projectId, environmentId],
    );

    /*
     * One template per result, distinct in matcher and prose — the parts the
     * normaliser keeps. Distinct digits are not distinct: they are exactly what
     * it erases.
     */
    const ERRORS = [
      'Error: expect(locator).toBeVisible() — dogfood fixture alpha: the banner never rendered',
      'Error: expect(locator).toContainText() — dogfood fixture bravo: the receipt said otherwise',
      'Error: expect(locator).toBeEnabled() — dogfood fixture charlie: the button stayed disabled',
      'Error: expect(locator).toHaveCount() — dogfood fixture delta: the list came back short',
    ];
    if (count > ERRORS.length) return null;

    const verdicts: SeededVerdict[] = [];
    for (const [index, test] of tests.rows.entries()) {
      const resultId = scratchId();
      const errorMessage = ERRORS[index]!;
      await client.query(
        `INSERT INTO "TestResult" (id, "orgId", "runId", "testId", status, "durationMs", "errorMessage")
         VALUES ($1, $2, $3, $4, 'FAILED', 900, $5)`,
        [resultId, orgId, runId, test.id, errorMessage],
      );

      const id = scratchId();
      const explanation = `Dogfood fixture ${index + 1}: the run failed on an assertion the app has never satisfied on this environment.`;
      const evidenceDetail = `Dogfood evidence ${index + 1} — the step that failed, quoted back.`;
      await client.query(
        `INSERT INTO "TriageVerdict"
           (id, "orgId", "testResultId", verdict, confidence, explanation, evidence, model, "reviewState")
         VALUES ($1, $2, $3, 'REAL_BUG', 0.91, $4, $5::jsonb, 'e2e-dogfood-fixture', 'PENDING')`,
        [
          id,
          orgId,
          resultId,
          explanation,
          JSON.stringify([{ kind: 'step', ref: `result:${resultId}`, detail: evidenceDetail }]),
        ],
      );
      verdicts.push({
        id,
        testName: test.name,
        verdict: 'REAL_BUG',
        explanation,
        evidenceDetail,
      });
    }

    return {
      verdicts,
      cleanup: async () => {
        try {
          // Results, verdicts and any batch rows cascade from the run.
          await client.query(`DELETE FROM "Run" WHERE id = $1`, [runId]);
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

/**
 * Like seedPendingVerdicts, but the verdicts are guaranteed to render as ONE
 * cause group.
 *
 * The triage screen groups by the clusterer's signature, and /clusters/run/:id
 * recomputes that signature from each failure's error message on demand — so
 * two failures cluster together exactly when their normalised errors match.
 * This picks two verdict-less failures from the SAME run and points their
 * errorMessage at one identical fixture string (originals restored in cleanup),
 * which makes the grouping deterministic instead of a property of whatever the
 * demo data happens to contain.
 *
 * It exists for the bulk test: "Agree all N", the batch row, and the undo strip
 * only exist for a real group, and a fixture that merely HOPES the clusterer
 * groups its rows is a flake with extra steps.
 */
export async function seedClusteredVerdicts(count: number): Promise<Seeded | null> {
  const url = databaseUrl();
  if (!url) return null;

  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch {
    return null;
  }

  try {
    /*
     * A run of the fixture's own, not borrowed failures.
     *
     * The first version of this rewrote existing results' errorMessage and
     * hoped: extractFacets prefers the FAILING STEP's error over the top-level
     * message, so any result that had step rows kept its own signature and the
     * group never formed. Fresh results with NO step rows leave errorMessage as
     * the only signal, which makes the identical-signature guarantee real —
     * and deleting the run afterwards takes everything with it by cascade,
     * touching none of the demo data.
     */
    const template = await client.query<{
      orgId: string;
      projectId: string;
      environmentId: string;
    }>(
      `SELECT "orgId", "projectId", "environmentId" FROM "Run"
        ORDER BY "startedAt" DESC NULLS LAST LIMIT 1`,
    );
    if (template.rows.length === 0) return null;
    const { orgId, projectId, environmentId } = template.rows[0]!;

    const tests = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM "Test"
        WHERE "projectId" = $1 AND "disabledAt" IS NULL
        ORDER BY "createdAt" ASC LIMIT $2`,
      [projectId, count],
    );
    if (tests.rows.length < count) return null;

    const runId = scratchId();
    await client.query(
      `INSERT INTO "Run" (id, "orgId", "projectId", "environmentId", status, trigger, "queuedAt", "startedAt", "finishedAt")
       VALUES ($1, $2, $3, $4, 'FAILED', 'MANUAL', now(), now(), now())`,
      [runId, orgId, projectId, environmentId],
    );

    const sharedError =
      'Error: expect(received).toBe(expected) — dogfood cluster fixture: shared upstream regression';

    const verdicts: SeededVerdict[] = [];
    for (const [index, test] of tests.rows.entries()) {
      const resultId = scratchId();
      await client.query(
        `INSERT INTO "TestResult" (id, "orgId", "runId", "testId", status, "durationMs", "errorMessage")
         VALUES ($1, $2, $3, $4, 'FAILED', 1200, $5)`,
        [resultId, orgId, runId, test.id, sharedError],
      );

      const id = scratchId();
      const explanation = `Dogfood cluster fixture ${index + 1}: one upstream regression, several tests.`;
      const evidenceDetail = `Dogfood cluster evidence ${index + 1}.`;
      await client.query(
        `INSERT INTO "TriageVerdict"
           (id, "orgId", "testResultId", verdict, confidence, explanation, evidence, model, "reviewState")
         VALUES ($1, $2, $3, 'REAL_BUG', 0.91, $4, $5::jsonb, 'e2e-dogfood-fixture', 'PENDING')`,
        [
          id,
          orgId,
          resultId,
          explanation,
          JSON.stringify([{ kind: 'step', ref: `result:${resultId}`, detail: evidenceDetail }]),
        ],
      );
      verdicts.push({ id, testName: test.name, verdict: 'REAL_BUG', explanation, evidenceDetail });
    }

    return {
      verdicts,
      cleanup: async () => {
        try {
          // Results and verdicts cascade from the run.
          await client.query(`DELETE FROM "Run" WHERE id = $1`, [runId]);
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
