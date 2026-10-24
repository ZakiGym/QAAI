/**
 * Tests (§5) — one test's story across every run it has ever appeared in.
 *
 * A test is only reachable through a run today, so "has this always been flaky?"
 * and "when did this start failing?" — the first two questions anyone asks about
 * an unreliable test — have no answer anywhere in the product. `flakeRate` is a
 * single number the run finaliser maintains: it says a test is unstable, not
 * when it became unstable, and those are different problems with different fixes.
 *
 * ── The mutation trend rides on the same read ───────────────────────────────
 *
 * This handler already walks one test's results newest-first out of
 * `TestResult(testId, createdAt)`, which is exactly the shape a mutation-score
 * trend needs — so the five `mutation*` columns are selected here rather than
 * behind a second endpoint, and "is this suite's mutation score going up?" costs
 * nothing beyond five more scalars per row. That question had no answer at all
 * before those columns existed: the score lived inside a Step title and could
 * only be recovered by regex.
 *
 * The surviving mutants are one extra query, made only when the newest measured
 * result says it HAS survivors — so a healthy suite pays nothing for the
 * feature.
 */

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';

export const testsRouter: Router = Router();

testsRouter.use(requireAuth);

const DEFAULT_WINDOW = 50;
/**
 * The history strip is meant to be read at a glance. Past a couple of hundred
 * marks it stops being a shape and becomes noise, so the cap is a product
 * decision as much as a query-cost one.
 */
const MAX_WINDOW = 200;

function windowSize(raw: unknown): number {
  if (raw === undefined) return DEFAULT_WINDOW;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) throw badRequest('limit must be a positive number');
  return Math.min(MAX_WINDOW, Math.floor(parsed));
}

/**
 * How many surviving mutants the detail block names.
 *
 * The list is a work queue, not an archive: past a couple of hundred entries
 * nobody reads further, and the count on the result row (`undetected` below) is
 * the number that must be complete. The worker stores up to 500 per result
 * (`MAX_PERSISTED_SURVIVORS`), so this cap is the narrower of the two and says
 * so in the response rather than silently truncating.
 */
const MAX_SURVIVORS_SHOWN = 200;

/** The mutation columns, as this handler reads one result row. */
interface MutationRow {
  id: string;
  createdAt: Date;
  mutationScore: number | null;
  mutationDetected: number | null;
  mutationUndetected: number | null;
  mutationExcluded: number | null;
  mutationMinScore: number | null;
  run: { id: string; commitSha: string | null; branch?: string | null };
}

/** One point on the trend: a run, and what it measured. */
export interface MutationPoint {
  testResultId: string;
  runId: string;
  at: Date;
  commitSha: string | null;
  /**
   * Percent killed, or null when the run produced no VALID mutant and so had no
   * denominator. Null here is NOT "no data" — the point only exists because the
   * run measured something — and it is not 0 either, because 0 means every
   * mutant survived.
   */
  score: number | null;
  detected: number;
  undetected: number;
  excluded: number;
  /** The denominator: detected + undetected. Derived, never stored. */
  valid: number;
  /** The bar this run was judged against, as it stood at the time. */
  minScore: number | null;
}

export interface MutationSummary {
  /** Results in this window that actually measured mutation. 0 = never run. */
  measured: number;
  /** The newest measured point, or null when this test has never measured one. */
  latest: MutationPoint | null;
  /**
   * Newest-first, one per measured result. The trend, in the order the rest of
   * this API returns lists.
   */
  points: MutationPoint[];
  /**
   * Latest scored point minus the one before it, in percentage points — the
   * answer to "is this getting better?".
   *
   * Null whenever it cannot be computed honestly: fewer than two SCORED points
   * in the window, or either of them unscored. A zero delta is a real finding
   * ("unchanged"), so it must not double as "unknown".
   */
  deltaFromPrevious: number | null;
}

/**
 * Turns result rows into the mutation trend. Pure, and exported so the
 * null-versus-zero rule is testable without a database.
 *
 * ── A result is a POINT only if it MEASURED something ──────────────────────
 *
 * The test is `mutationDetected !== null`, not `mutationScore !== null` and
 * certainly not a truthiness check. Three states arrive in these columns and
 * conflating any two of them loses the signal the columns exist for:
 *
 *   · all five null         → mutation testing did not run. NOT a point: a
 *                             trend that plots these as 0 invents a collapse
 *                             that never happened, which is the exact inversion
 *                             the nullable columns were added to prevent.
 *   · counts set, score null → it ran and produced no valid mutant. A point,
 *                             with `score: null`, because "we tried and there
 *                             was nothing to judge" is a fact about the run.
 *   · score 0               → it ran and killed nothing. A point at 0, and the
 *                             worst result a suite can report.
 */
export function mutationTrend(rows: readonly MutationRow[]): MutationSummary {
  const points: MutationPoint[] = [];
  for (const row of rows) {
    // `detected` is the measurement marker: a run that reported anything
    // reported all three counts, and a `?? 0` here would manufacture a point
    // for every result in the window.
    if (row.mutationDetected === null) continue;
    const detected = row.mutationDetected;
    const undetected = row.mutationUndetected ?? 0;
    points.push({
      testResultId: row.id,
      runId: row.run.id,
      at: row.createdAt,
      commitSha: row.run.commitSha,
      score: row.mutationScore,
      detected,
      undetected,
      excluded: row.mutationExcluded ?? 0,
      valid: detected + undetected,
      minScore: row.mutationMinScore,
    });
  }

  const scored = points.filter((p): p is MutationPoint & { score: number } => p.score !== null);
  const [newest, previous] = scored;
  return {
    measured: points.length,
    latest: points[0] ?? null,
    points,
    deltaFromPrevious:
      newest === undefined || previous === undefined ? null : newest.score - previous.score,
  };
}

/**
 * `skip` is its own outcome, not a third kind of failure.
 *
 * POST /runs creates every result upfront as SKIPPED so the cockpit can render
 * the whole suite immediately, which means any queued or in-flight run puts a
 * SKIPPED row in this history for a test that has not run yet. Counting those
 * as failures would drop the pass rate the instant someone queues a run; letting
 * them break the streak would reset it just as fast. They are excluded from both.
 */
type Outcome = 'pass' | 'fail' | 'skip';

/**
 * A retry that passes is not a pass (§5) — the same rule the gate and the flake
 * radar already apply. Both FLAKY and a PASSED result carrying
 * `retriedAndPassed` mean the test failed at least once in that run, so neither
 * counts toward the pass rate. Scoring them as passes would make this page
 * flatter exactly the tests it exists to expose.
 */
function outcomeOf(result: { status: string; retriedAndPassed: boolean }): Outcome {
  if (result.status === 'SKIPPED') return 'skip';
  if (result.status === 'PASSED') return result.retriedAndPassed ? 'fail' : 'pass';
  return 'fail';
}

/** How many times in a row, most recent first, the test has done the same thing. */
function currentStreak(outcomes: Outcome[]): { outcome: 'pass' | 'fail'; count: number } | null {
  const ran = outcomes.filter((o): o is 'pass' | 'fail' => o !== 'skip');
  const head = ran[0];
  if (!head) return null;

  let count = 0;
  for (const outcome of ran) {
    if (outcome !== head) break;
    count += 1;
  }
  return { outcome: head, count };
}

/**
 * GET /tests/:testId/history?limit=50
 *
 * Results come back newest-first, like every other list in this API. The strip
 * on the detail page reverses them — reading left-to-right as time moving
 * forward is what makes a run of failures look like a run of failures.
 */
testsRouter.get('/:testId/history', async (req, res) => {
  const limit = windowSize(req.query.limit);
  const testId = String(req.params.testId);

  const test = await prisma.test.findUnique({
    where: { id: testId },
    select: {
      id: true,
      projectId: true,
      name: true,
      filePath: true,
      type: true,
      priority: true,
      tags: true,
      quarantined: true,
      quarantinedAt: true,
      quarantineReason: true,
      flakeRate: true,
      consecutiveFailures: true,
      lastRunAt: true,
      reviewFlags: true,
    },
  });
  if (!test) throw notFound('Test');

  const [results, total] = await Promise.all([
    prisma.testResult.findMany({
      where: { testId },
      // `id` only breaks ties: cuids are time-ordered, so two results written in
      // the same millisecond still come back in a stable order rather than
      // shuffling the strip between refreshes.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        id: true,
        status: true,
        durationMs: true,
        errorMessage: true,
        retriedAndPassed: true,
        createdAt: true,
        /*
         * The mutation metric channel. Five scalars on a read that was already
         * paging this test's results in time order, which is what makes the
         * trend free — and what makes these columns READ rather than merely
         * written (`scripts/check-wiring.ts` flags stored-but-never-read data,
         * and a column nothing reads is this codebase's signature defect).
         */
        mutationScore: true,
        mutationDetected: true,
        mutationUndetected: true,
        mutationExcluded: true,
        mutationMinScore: true,
        run: {
          select: {
            id: true,
            queuedAt: true,
            trigger: true,
            branch: true,
            commitSha: true,
            environment: { select: { name: true, kind: true } },
          },
        },
      },
    }),
    prisma.testResult.count({ where: { testId } }),
  ]);

  const outcomes = results.map(outcomeOf);
  const passed = outcomes.filter((o) => o === 'pass').length;
  const failed = outcomes.filter((o) => o === 'fail').length;
  const ran = passed + failed;

  const mutation = mutationTrend(results);
  /*
   * The survivor detail, for the newest measured result only, and only when
   * that result says it HAS survivors. Two consequences worth being explicit
   * about: a suite that kills every mutant pays nothing for this feature, and
   * `undetected > 0` with an empty list is a real state — the tool reported a
   * count without naming them, or the detail is past
   * MUTATION_SURVIVOR_RETENTION_DAYS and was pruned while the score stayed. So
   * the list is never read as a count; `latest.undetected` is the count.
   */
  const survivors =
    mutation.latest && mutation.latest.undetected > 0
      ? await prisma.mutationSurvivor.findMany({
          where: { testResultId: mutation.latest.testResultId },
          orderBy: [{ file: 'asc' }, { line: 'asc' }],
          take: MAX_SURVIVORS_SHOWN + 1,
          select: { id: true, file: true, line: true, mutator: true, detail: true, reason: true },
        })
      : [];

  res.json({
    test,
    results,
    mutation: {
      ...mutation,
      /** Surviving mutants of `latest`, as a work queue. Never a count. */
      survivors: survivors.slice(0, MAX_SURVIVORS_SHOWN),
      /** True when more rows exist than this response names. */
      survivorsTruncated: survivors.length > MAX_SURVIVORS_SHOWN,
    },
    window: {
      limit,
      /** Results ever recorded for this test, so the page can say "last 50 of 312". */
      total,
      returned: results.length,
      passed,
      failed,
      skipped: results.length - ran,
      // Percent, to match Test.flakeRate — the two sit next to each other in the
      // UI and one of them being a fraction would be a trap. Null rather than
      // zero when nothing has run: "0%" is a claim, and we do not have the data
      // to make it.
      passRate: ran === 0 ? null : (passed / ran) * 100,
      streak: currentStreak(outcomes),
    },
  });
});
