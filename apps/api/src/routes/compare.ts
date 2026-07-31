/**
 * Run comparison (§5) — "is this failure new?"
 *
 * Triage's first question has had no answer in the product. Re-running moves
 * you to a fresh run id with no link back to the one you were looking at, so
 * deciding whether a red test is a regression or the same red test as an hour
 * ago meant opening two cockpits in two tabs and reading names off the screen.
 *
 * This endpoint answers it directly: two runs in, one classification per test
 * out, with NEWLY_FAILING as the category everything else exists to contrast
 * against.
 */

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';

export const compareRouter: Router = Router();

compareRouter.use(requireAuth);

/** The six answers. NEWLY_FAILING is the one the user came for. */
type Category = 'NEWLY_FAILING' | 'FIXED' | 'STILL_FAILING' | 'STILL_PASSING' | 'ADDED' | 'REMOVED';

type ResultStatus = 'PASSED' | 'FAILED' | 'SKIPPED' | 'FLAKY' | 'TIMED_OUT';

/**
 * Is this side of the comparison red?
 *
 * FLAKY counts as failing on purpose. §5's rule is that a retry which passes is
 * not a pass, and the gate already treats it that way — a comparison that
 * quietly disagreed would put a test the gate is blocking on into the "still
 * passing" pile. The row carries the raw status either way, so the UI can show
 * that a new failure is a flake rather than a hard break.
 *
 * SKIPPED is not failing. It is also not really passing, but the six categories
 * have no bucket for "did not run" and calling a skip a failure would fill the
 * NEWLY_FAILING list — the one list that has to stay trustworthy — with tests
 * that nobody executed.
 */
function isFailing(status: ResultStatus): boolean {
  return status === 'FAILED' || status === 'TIMED_OUT' || status === 'FLAKY';
}

function classify(here: boolean | null, there: boolean | null): Category {
  if (here === null) return 'REMOVED';
  if (there === null) return 'ADDED';
  if (here && !there) return 'NEWLY_FAILING';
  if (!here && there) return 'FIXED';
  return here ? 'STILL_FAILING' : 'STILL_PASSING';
}

/** Triage order: worst first inside every group. */
const PRIORITY_RANK: Record<string, number> = {
  CRITICAL_PATH: 0,
  IMPORTANT: 1,
  NICE_TO_HAVE: 2,
};

interface Side {
  runId: string;
  status: ResultStatus;
  durationMs: number;
  errorMessage: string | null;
}

interface Row {
  testId: string;
  category: Category;
  name: string;
  filePath: string;
  type: string;
  priority: string;
  here: Side | null;
  there: Side | null;
  /** Signed ms: positive means this run was slower. Null unless both sides ran. */
  durationDeltaMs: number | null;
}

const RESULT_SELECT = {
  testId: true,
  status: true,
  durationMs: true,
  errorMessage: true,
  test: { select: { name: true, filePath: true, type: true, priority: true } },
} as const;

const RUN_SELECT = {
  id: true,
  projectId: true,
  environmentId: true,
  status: true,
  queuedAt: true,
  finishedAt: true,
  commitSha: true,
  branch: true,
  environment: { select: { name: true, kind: true } },
} as const;

/**
 * Statuses whose results describe a real execution.
 *
 * QUEUED and RUNNING runs are made of placeholder rows — the POST /runs handler
 * creates every result up front as SKIPPED — and CANCELLED/ERRORED runs stopped
 * partway, so their greens mean "never got there", not "passed". Auto-selecting
 * one of those as the baseline would invent regressions out of tests that
 * simply had not run yet, so the search only considers runs that finished on
 * their own terms. An explicitly requested `against` is still honoured; the
 * caller asked for that specific run and the response reports its status.
 */
const COMPARABLE_STATUSES = ['PASSED', 'FAILED'] as const;

compareRouter.get('/:runId', async (req, res) => {
  const here = await prisma.run.findUnique({
    where: { id: String(req.params.runId) },
    select: RUN_SELECT,
  });
  if (!here) throw notFound('Run');

  const requested = typeof req.query.against === 'string' ? req.query.against.trim() : '';

  let there: typeof here | null = null;
  /** How the baseline was picked. Shown verbatim in the UI's summary line. */
  let basisReason: string;
  let basisMode: 'explicit' | 'auto' | 'none';

  if (requested) {
    if (requested === here.id) {
      throw badRequest('A run cannot be compared with itself');
    }
    there = await prisma.run.findUnique({ where: { id: requested }, select: RUN_SELECT });
    if (!there) throw notFound('Run');

    /*
     * Two runs from different projects share no test ids, so every row would
     * come back ADDED or REMOVED and the answer would be noise dressed up as
     * data. Refusing is more useful than rendering that.
     */
    if (there.projectId !== here.projectId) {
      throw badRequest('Those two runs are from different projects, so they share no tests');
    }

    basisMode = 'explicit';
    basisReason =
      there.environmentId === here.environmentId
        ? `You picked this run explicitly. Both ran on ${here.environment.name}.`
        : `You picked this run explicitly. It ran on ${there.environment.name}, not ` +
          `${here.environment.name} — differences may be the environment, not the code.`;
  } else {
    /*
     * Default baseline: the run immediately before this one on the SAME
     * environment. Same environment is what makes the comparison mean anything —
     * staging vs production differ for reasons that have nothing to do with the
     * change you are triaging.
     *
     * "Earlier" is (queuedAt, id) lexicographically, not queuedAt alone. Two
     * runs queued inside the same millisecond are common — CI opens a PR and
     * fans out — and ordering on the timestamp by itself would let the report
     * pick a *later* run as the baseline and invert every category in it.
     */
    there = await prisma.run.findFirst({
      where: {
        environmentId: here.environmentId,
        status: { in: [...COMPARABLE_STATUSES] },
        OR: [{ queuedAt: { lt: here.queuedAt } }, { queuedAt: here.queuedAt, id: { lt: here.id } }],
      },
      orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      select: RUN_SELECT,
    });

    if (there) {
      basisMode = 'auto';
      basisReason =
        `No baseline was given, so this is the most recent completed run before ` +
        `it on ${here.environment.name}.`;
    } else {
      basisMode = 'none';
      basisReason =
        `Nothing to compare against: this is the first completed run on ` +
        `${here.environment.name}. Runs that are still going, or that were ` +
        `cancelled or errored, are skipped because their results are partial.`;
    }
  }

  const [hereResults, thereResults] = await Promise.all([
    prisma.testResult.findMany({ where: { runId: here.id }, select: RESULT_SELECT }),
    there
      ? prisma.testResult.findMany({ where: { runId: there.id }, select: RESULT_SELECT })
      : Promise.resolve([]),
  ]);

  const thereByTest = new Map(thereResults.map((r) => [r.testId, r]));
  const hereTestIds = new Set(hereResults.map((r) => r.testId));
  const rows: Row[] = [];

  for (const result of hereResults) {
    const other = thereByTest.get(result.testId);
    const hereFailing = isFailing(result.status as ResultStatus);
    // With no baseline at all, everything is ADDED — which is honest, but it is
    // not a comparison. The page renders the empty state off `basis.mode`.
    const thereFailing = other ? isFailing(other.status as ResultStatus) : null;

    rows.push({
      testId: result.testId,
      category: classify(hereFailing, thereFailing),
      name: result.test.name,
      filePath: result.test.filePath,
      type: result.test.type,
      priority: result.test.priority,
      here: {
        runId: here.id,
        status: result.status as ResultStatus,
        durationMs: result.durationMs,
        errorMessage: result.errorMessage,
      },
      there: other
        ? {
            runId: there!.id,
            status: other.status as ResultStatus,
            durationMs: other.durationMs,
            errorMessage: other.errorMessage,
          }
        : null,
      durationDeltaMs: other ? result.durationMs - other.durationMs : null,
    });
  }

  // Tests the baseline ran and this run did not. A test that disappeared is not
  // a pass, and silently dropping it is how a deleted-by-accident test goes
  // unnoticed for a month.
  for (const other of thereResults) {
    if (hereTestIds.has(other.testId)) continue;
    rows.push({
      testId: other.testId,
      category: 'REMOVED',
      name: other.test.name,
      filePath: other.test.filePath,
      type: other.test.type,
      priority: other.test.priority,
      here: null,
      there: {
        runId: there!.id,
        status: other.status as ResultStatus,
        durationMs: other.durationMs,
        errorMessage: other.errorMessage,
      },
      durationDeltaMs: null,
    });
  }

  rows.sort(
    (a, b) =>
      (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
      a.name.localeCompare(b.name),
  );

  const counts: Record<Category, number> = {
    NEWLY_FAILING: 0,
    FIXED: 0,
    STILL_FAILING: 0,
    STILL_PASSING: 0,
    ADDED: 0,
    REMOVED: 0,
  };
  for (const row of rows) counts[row.category] += 1;

  res.json({
    here,
    there,
    basis: { mode: basisMode, reason: basisReason },
    /*
     * A run that has not finished is made partly of placeholder rows, so the
     * comparison is a snapshot of an incomplete thing. Flagged rather than
     * refused — watching regressions appear as a run progresses is useful, as
     * long as the page says that is what you are looking at.
     */
    partial: {
      here: here.status === 'QUEUED' || here.status === 'RUNNING',
      there: there ? there.status === 'QUEUED' || there.status === 'RUNNING' : false,
    },
    counts,
    total: rows.length,
    rows,
  });
});
