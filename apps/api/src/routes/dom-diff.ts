/**
 * DOM diff endpoint (§5) — `GET /dom-diff/:resultId`.
 *
 * The design brief's own note on the cockpit is that there is "no way to
 * compare against the last passing run". This is that comparison, in the form
 * that answers a triage question rather than decorating one: the failing run's
 * DOM against the DOM from the last time this same test was green, reduced to
 * the accessibility-relevant differences, ranked by whether the test's own
 * locators touch them.
 *
 * The snapshots come out of the Playwright trace QAAI already records. A trace
 * carries a full serialised DOM per action, so no new capture, no new table and
 * no migration is involved — this endpoint only reads artifacts that exist.
 *
 * That has one consequence the response is explicit about, because it decides
 * whether the panel can say anything at all: the runner is configured
 * `trace: 'retain-on-failure'`, so **a passing run keeps no trace**. When the
 * last green run has no snapshot, the answer is not an error and not an empty
 * diff — it names the green run, says why it cannot be read, and offers the
 * most recent result that *does* have one so the user can ask for that
 * comparison explicitly. Silence would look like "nothing changed", which is
 * the one thing this endpoint must never imply.
 */

import { Router } from 'express';
import JSZip from 'jszip';
import { prisma } from '../lib/prisma.js';
import { storage } from '../lib/storage.js';
import { badRequest, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import {
  diffSnapshots,
  extractLocators,
  parseTraceSnapshots,
  pickAnchor,
  normaliseSnapshot,
  type DomSnapshot,
  type RawFrameSnapshot,
} from '../lib/dom-diff.js';

export const domDiffRouter: Router = Router();

domDiffRouter.use(requireAuth);

/**
 * Trace size ceiling.
 *
 * A trace on a long test can be tens of megabytes, and this endpoint reads two
 * of them into memory inside a request. Refusing with a reason the UI can print
 * beats holding a connection open while the process approaches its heap limit.
 */
const MAX_TRACE_BYTES = 48 * 1024 * 1024;

/** Statuses that mean the test genuinely passed, so its DOM is a valid baseline. */
const GREEN_STATUSES = ['PASSED'] as const;

const RESULT_SELECT = {
  id: true,
  runId: true,
  testId: true,
  status: true,
  durationMs: true,
  errorMessage: true,
  traceKey: true,
  createdAt: true,
  test: { select: { id: true, name: true, code: true, filePath: true } },
  run: {
    select: {
      id: true,
      status: true,
      commitSha: true,
      branch: true,
      queuedAt: true,
      finishedAt: true,
      environment: { select: { name: true } },
    },
  },
} as const;

type ResultRow = {
  id: string;
  runId: string;
  testId: string;
  status: string;
  traceKey: string | null;
  createdAt: Date;
  run: {
    id: string;
    status: string;
    commitSha: string | null;
    branch: string | null;
    queuedAt: Date;
    finishedAt: Date | null;
    environment: { name: string };
  };
};

/**
 * "Before this one" — by the run's queue time, not the result row's.
 *
 * `TestResult.createdAt` is when the row was written, and POST /runs writes
 * every result up front as SKIPPED, so two runs that overlap can interleave
 * their rows. Ordering on it picked a baseline that visibly *finished after*
 * the failure it was the baseline for.
 *
 * The tiebreak on id is the same one compare.ts needs and for the same reason:
 * CI opening a PR fans out several runs inside one millisecond, and ordering on
 * the timestamp alone can then select a later run as the earlier one.
 */
function ranBefore(subject: ResultRow) {
  return {
    OR: [
      { run: { queuedAt: { lt: subject.run.queuedAt } } },
      { run: { queuedAt: subject.run.queuedAt }, id: { lt: subject.id } },
    ],
  };
}

const NEWEST_FIRST = [{ run: { queuedAt: 'desc' } }, { id: 'desc' }] as const;

/** The subset of a result the UI prints when naming what it compared against. */
function summarise(result: ResultRow) {
  return {
    resultId: result.id,
    runId: result.runId,
    status: result.status,
    runStatus: result.run.status,
    environment: result.run.environment.name,
    commitSha: result.run.commitSha,
    branch: result.run.branch,
    /*
     * Both timestamps, not one "ranAt".
     *
     * Runs overlap — the seeded project alone has a green run that was queued
     * before a failure and finished after it. Collapsing the two into a single
     * time made the baseline look like it ran *later* than the failure it was
     * the baseline for, which reads as a bug in the comparison itself.
     */
    queuedAt: result.run.queuedAt.toISOString(),
    finishedAt: result.run.finishedAt?.toISOString() ?? null,
    hasSnapshot: Boolean(result.traceKey),
  };
}

/**
 * Frame snapshots out of a stored trace zip.
 *
 * A Playwright trace zip holds one `.trace` file per context plus the test
 * runner's own; only the context ones carry `frame-snapshot` events, but
 * reading all of them and filtering by event type is cheaper than encoding
 * Playwright's file-naming convention here and being wrong when it changes.
 *
 * Returns null — never throws — when the artifact is missing or unreadable. A
 * swept or corrupt artifact is an honest empty state, not a 500 in the middle
 * of triage.
 */
async function snapshotsFromTraceKey(key: string): Promise<RawFrameSnapshot[] | null> {
  let archive: Buffer;
  try {
    archive = await storage.get(key);
  } catch (error) {
    logger.warn({ key, err: String(error) }, 'dom-diff: trace artifact unreadable');
    return null;
  }

  if (archive.byteLength > MAX_TRACE_BYTES) {
    logger.warn({ key, bytes: archive.byteLength }, 'dom-diff: trace over the size ceiling');
    return null;
  }

  try {
    const zip = await JSZip.loadAsync(archive);
    const traceFiles = Object.keys(zip.files)
      .filter((name) => name.endsWith('.trace') && !zip.files[name]!.dir)
      .sort();

    const snapshots: RawFrameSnapshot[] = [];
    for (const name of traceFiles) {
      const body = await zip.files[name]!.async('string');
      snapshots.push(...parseTraceSnapshots(body));
    }
    return snapshots.length ? snapshots : null;
  } catch (error) {
    logger.warn({ key, err: String(error) }, 'dom-diff: trace zip could not be read');
    return null;
  }
}

/** Load a side of the comparison, aligned to `preferUrl` when one is known. */
async function loadSnapshot(traceKey: string, preferUrl?: string): Promise<DomSnapshot | null> {
  const snapshots = await snapshotsFromTraceKey(traceKey);
  if (!snapshots) return null;
  const anchor = pickAnchor(snapshots, preferUrl);
  if (!anchor) return null;
  return normaliseSnapshot(anchor.frame, anchor.index);
}

/**
 * The diff for one test result.
 *
 * `?against=<resultId>` overrides the baseline. The response always reports
 * which result it actually used and what its status was, so an explicitly
 * chosen red baseline can never be mistaken for "the last time this passed".
 */
domDiffRouter.get('/:resultId', async (req, res) => {
  const result = await prisma.testResult.findUnique({
    where: { id: String(req.params.resultId) },
    select: RESULT_SELECT,
  });
  if (!result) throw notFound('Test result');

  const requested = typeof req.query.against === 'string' ? req.query.against.trim() : '';
  if (requested && requested === result.id) {
    throw badRequest('A result cannot be compared with itself');
  }

  const subject = summarise(result);
  const test = {
    id: result.test.id,
    name: result.test.name,
    filePath: result.test.filePath,
  };

  /*
   * Two separate lookups, because "there is no green run" and "the green run
   * kept no DOM" are different answers and only the second one is fixable by
   * the person reading it.
   */
  const earlier = ranBefore(result);
  const [lastGreen, lastGreenWithSnapshot] = await Promise.all([
    prisma.testResult.findFirst({
      where: { testId: result.testId, status: { in: [...GREEN_STATUSES] }, ...earlier },
      orderBy: [...NEWEST_FIRST],
      select: RESULT_SELECT,
    }),
    prisma.testResult.findFirst({
      where: {
        testId: result.testId,
        status: { in: [...GREEN_STATUSES] },
        traceKey: { not: null },
        ...earlier,
      },
      orderBy: [...NEWEST_FIRST],
      select: RESULT_SELECT,
    }),
  ]);

  let baseline: ResultRow | null = null;
  let basis: 'explicit' | 'last-green' | 'none';
  let basisReason: string;

  if (requested) {
    const chosen = await prisma.testResult.findUnique({
      where: { id: requested },
      select: RESULT_SELECT,
    });
    if (!chosen) throw notFound('Test result');
    if (chosen.testId !== result.testId) {
      throw badRequest('Those two results are from different tests, so their pages are unrelated');
    }
    baseline = chosen;
    basis = 'explicit';
    basisReason =
      chosen.status === 'PASSED'
        ? 'You picked this baseline explicitly, and it is a passing run.'
        : `You picked this baseline explicitly. It ${chosen.status === 'SKIPPED' ? 'was skipped' : 'also failed'}, ` +
          'so a difference here is not necessarily a regression.';
  } else if (lastGreenWithSnapshot) {
    baseline = lastGreenWithSnapshot;
    basis = 'last-green';
    basisReason = 'The most recent run in which this test passed and a DOM snapshot was kept.';
  } else {
    basis = 'none';
    basisReason = lastGreen
      ? // The short handle, not the cuid: this string is prose in the UI, and a
        // 25-character id inside a sentence is unreadable. The full ids are in
        // `lastGreen` for anything that needs to link or query.
        `This test last passed in run ${lastGreen.run.commitSha?.slice(0, 7) ?? lastGreen.runId.slice(-6)}, ` +
        'but that run kept no DOM snapshot: the runner records a Playwright trace only when a ' +
        'test fails, so a green run leaves nothing to compare against.'
      : 'This test has never passed, so there is no green run to compare against. That is a ' +
        'normal state for a new test, not an error.';
  }

  /*
   * The most recent result of any status that does carry a snapshot. Offered
   * only as a labelled alternative — never silently substituted for the green
   * baseline, because "compared against the last time it passed" and "compared
   * against the last time it failed" support opposite conclusions.
   */
  const alternative =
    basis === 'none'
      ? await prisma.testResult.findFirst({
          where: {
            testId: result.testId,
            id: { not: result.id },
            traceKey: { not: null },
            ...earlier,
          },
          orderBy: [...NEWEST_FIRST],
          select: RESULT_SELECT,
        })
      : null;

  const base = {
    result: subject,
    test,
    basis,
    basisReason,
    lastGreen: lastGreen ? summarise(lastGreen) : null,
    alternative: alternative ? summarise(alternative) : null,
  };

  if (!result.traceKey) {
    res.json({
      ...base,
      diff: null,
      unavailable: {
        reason: 'NO_SNAPSHOT_ON_THIS_RESULT',
        detail:
          result.status === 'PASSED'
            ? 'This run passed, and the runner keeps a trace only for failures — so this side has no DOM to read.'
            : 'No Playwright trace was stored for this result, so there is no DOM to read. API, ' +
              'load and security tests do not drive a browser, and a trace can also have been ' +
              'removed by artifact retention.',
      },
    });
    return;
  }

  if (!baseline?.traceKey) {
    res.json({
      ...base,
      /*
       * Still named, when there is one. An explicitly requested baseline that
       * turns out to have no trace must not come back looking like "no baseline
       * exists" — the user picked that run, and the answer they need is that
       * *this particular* run kept no DOM, not a restatement of how baselines
       * are chosen.
       */
      ...(baseline ? { baseline: summarise(baseline) } : {}),
      diff: null,
      unavailable: {
        reason: 'NO_BASELINE_SNAPSHOT',
        detail: baseline
          ? 'That run kept no Playwright trace, so it has no DOM to compare against. The runner ' +
            'records one only when a test fails.'
          : basisReason,
      },
    });
    return;
  }

  const after = await loadSnapshot(result.traceKey);
  if (!after) {
    res.json({
      ...base,
      diff: null,
      unavailable: {
        reason: 'SNAPSHOT_UNREADABLE',
        detail:
          'The trace for this result exists but holds no readable page snapshot — it can be ' +
          'truncated, or the test failed before the browser rendered anything.',
      },
    });
    return;
  }

  // Aligned to the failing page, so a green run that carried on to a later
  // screen is compared on the screen the failure happened on.
  const before = await loadSnapshot(baseline.traceKey, after.frameUrl);
  if (!before) {
    res.json({
      ...base,
      baseline: summarise(baseline),
      diff: null,
      unavailable: {
        reason: 'SNAPSHOT_UNREADABLE',
        detail: 'The baseline trace exists but holds no readable page snapshot.',
      },
    });
    return;
  }

  const locators = extractLocators(result.test.code, result.errorMessage);
  const diff = diffSnapshots(before, after, { locators });

  res.json({
    ...base,
    baseline: summarise(baseline),
    unavailable: null,
    /** What the ranking had to work with — an empty list explains a flat ranking. */
    locators: locators.map((locator) => locator.expression),
    diff,
  });
});
