/**
 * Tests (§5) — one test's story across every run it has ever appeared in.
 *
 * A test is only reachable through a run today, so "has this always been flaky?"
 * and "when did this start failing?" — the first two questions anyone asks about
 * an unreliable test — have no answer anywhere in the product. `flakeRate` is a
 * single number the run finaliser maintains: it says a test is unstable, not
 * when it became unstable, and those are different problems with different fixes.
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

  res.json({
    test,
    results,
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
