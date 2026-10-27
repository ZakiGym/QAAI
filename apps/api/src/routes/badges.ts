/**
 * The shell's badge counts, in one request (§8).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The sidebar is mounted on every signed-in screen, and it was keeping two
 * badges alive by re-fetching two LISTS every ten seconds, forever, in every
 * open tab: `/runs?limit=25`, which returns twenty-five whole Run rows so the
 * shell can count how many are in flight and read one status; and
 * `/verdicts?state=PENDING`, which returns up to a hundred triage verdicts —
 * each with its test result, its test, and its evidence — so the shell can call
 * `.length` on the array. Six thousand rows an hour, per tab, to render two
 * integers.
 *
 * A count is a count. `count()` never leaves the database with more than a
 * number in hand, the indexes it needs already exist, and one request replaces
 * two.
 *
 * ── Why the counts and the list endpoints cannot disagree ───────────────────
 * Every filter here is written to match its list endpoint exactly — PENDING
 * verdicts, PROPOSED heals, QUEUED-or-RUNNING runs — and all of it runs through
 * the tenant-scoped client, so `orgId` is applied without being written. There
 * is no cache and no snapshot: each call is a fresh count of the same rows the
 * screen behind the badge would show.
 *
 * `heals` is here even though the sidebar does not draw it, because the heals
 * badge on the runs page polls the whole `/heals` payload for the same reason
 * the sidebar used to — and that payload carries every proposal's test source
 * TWICE, once as `test.code` and once as the patched `preview.code`. That screen
 * lives outside this change; this is the count it should be asking for.
 */

import { Router } from 'express';
import { HEADLINE_SCOPE_KEY, deltaIsMeaningful } from '@qaai/shared';
import type { SnapshotComparability } from '@qaai/shared';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';

export const badgesRouter: Router = Router();

badgesRouter.use(requireAuth);

/**
 * `projectId` scopes the run numbers only, and matches what the sidebar asked
 * `/runs` for. It is never trusted: it goes into a `where` on the tenant-scoped
 * client, so another org's project id counts that org's rows — of which this
 * caller can see none — and comes back as zero rather than as anything.
 */
badgesRouter.get('/', async (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : null;
  const runScope = projectId ? { projectId } : {};

  const [liveRuns, lastRun, verdicts, heals] = await Promise.all([
    prisma.run.count({ where: { ...runScope, status: { in: ['QUEUED', 'RUNNING'] } } }),
    // The health dot. One row, off the (projectId, queuedAt) index — the reason
    // the sidebar was pulling twenty-five runs was that it wanted this and a
    // count from the same payload.
    prisma.run.findFirst({
      where: runScope,
      orderBy: { queuedAt: 'desc' },
      select: { status: true },
    }),
    prisma.triageVerdict.count({ where: { reviewState: 'PENDING' } }),
    prisma.healProposal.count({ where: { state: 'PROPOSED' } }),
  ]);

  res.json({
    liveRuns,
    lastRunStatus: lastRun?.status ?? null,
    verdicts,
    heals,
  });
});

// ─── The coverage badge ──────────────────────────────────────────────────────

/**
 * ════════════════════════════════════════════════════════════════════════════
 * THE COVERAGE BADGE, AND THE ONE THING IT MUST BE ABLE TO SAY
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `grep -n coverage` in this file returned nothing: the number never left one
 * authenticated screen, so a team could not put it in their README, and the one
 * sentence this company has was invisible to everybody who had not logged in.
 *
 * ── A BADGE THAT RENDERS 0% FOR "NOT MEASURED YET" IS THE PRODUCT'S OWN LIE
 *    IN AN IMAGE ───────────────────────────────────────────────────────────
 *
 * It is worse than the same lie on a screen, for three reasons: an image has no
 * room for a caveat, a README outlives the conversation that produced it, and
 * nobody re-reads a badge they have already believed. So `state` is a FIRST-
 * CLASS value with four members and `percent` is NULL in three of them —
 * `UNKNOWN` is not a styling variant of `MEASURED`, it is a different answer,
 * and a renderer has to branch rather than round.
 *
 * ── SVG IS NOT SERVED FROM HERE, DELIBERATELY ──────────────────────────────
 *
 * This router is behind `requireAuth`, and a badge in a public README is
 * fetched by a markdown renderer with no session. Serving the IMAGE from an
 * authenticated route would produce a broken-image icon in every README that
 * used it; serving it from an unauthenticated one is a PUBLIC surface and needs
 * the whole share-token apparatus — a revocable credential, an expiry, and a
 * payload that cannot become an oracle for which internal routes exist. That is
 * `routes/share.ts`'s job and it is named in this round's handover rather than
 * half-built here. What this endpoint is for is the cockpit's own badge and the
 * CLI's `--min` gate, both of which are authenticated.
 */

/** The four things a coverage badge can say. Three of them have no percentage. */
export const COVERAGE_BADGE_STATES = [
  /** A snapshot exists, its denominator was non-zero, and the figure is real. */
  'MEASURED',
  /**
   * Nothing has ever been measured for this project. NOT 0%.
   *
   * The state a badge is in on the day it is added to a README, and the one a
   * careless renderer paints green at 0% or red at 0% — both of which are
   * claims about the customer's application assembled out of our own silence.
   */
  'NOT_MEASURED',
  /**
   * A snapshot exists and its denominator was ZERO, so there is nothing to
   * divide.
   *
   * Distinct from NOT_MEASURED because the remedy is different: this project
   * was measured and nothing was found to count, which means the enumerator
   * reached nothing — a crawl to fix, not a measurement to run.
   */
  'EMPTY_DENOMINATOR',
  /**
   * This deployment cannot answer: the stored breakdown could not be read.
   *
   * Our own fault, named as ours, and never shown as a figure. Same contract as
   * `coverageProvenance` returning null.
   */
  'UNAVAILABLE',
] as const;
export type CoverageBadgeState = (typeof COVERAGE_BADGE_STATES)[number];

/**
 * The compile-time half of the two-mechanism guard this codebase requires. A
 * fifth state breaks this line until somebody decides what it is called, and
 * the labels below are keyed on the union for the same reason.
 */
const COVERAGE_BADGE_STATE_PRESENT: Record<CoverageBadgeState, true> = {
  MEASURED: true,
  NOT_MEASURED: true,
  EMPTY_DENOMINATOR: true,
  UNAVAILABLE: true,
};

export const COVERAGE_BADGE_STATE_KINDS = Object.keys(
  COVERAGE_BADGE_STATE_PRESENT,
) as ReadonlyArray<CoverageBadgeState>;

/**
 * THE TEXT A BADGE RENDERS, per state, so no renderer invents one.
 *
 * Three of the four say "unknown" or "not measured" IN WORDS. None of them is
 * a number, and that is the point: a renderer that falls back to
 * `${percent}%` on a null gets `null%` at worst and `0%` at the cost of a
 * single `??`, and the second is the one that ships.
 */
export const COVERAGE_BADGE_LABELS: Record<CoverageBadgeState, string> = {
  MEASURED: 'coverage',
  NOT_MEASURED: 'not measured',
  EMPTY_DENOMINATOR: 'nothing to measure',
  UNAVAILABLE: 'unknown',
};

/**
 * The coverage badge's facts.
 *
 * `projectId` is required and is never trusted: it goes into a `where` on the
 * tenant-scoped client, so another org's project id counts that org's rows — of
 * which this caller can see none — and comes back as NOT_MEASURED rather than
 * as anything at all. Exactly the contract the run badge above states.
 */
badgesRouter.get('/coverage/:projectId', async (req, res) => {
  const projectId = String(req.params.projectId);

  let snapshot:
    | { percent: number | null; denominator: number; covered: number; createdAt: Date }
    | null
    | undefined;
  try {
    snapshot = await prisma.coverageSnapshot.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { percent: true, denominator: true, covered: true, createdAt: true },
    });
  } catch {
    // `undefined` is "the read failed", which is UNAVAILABLE. `null` is "the
    // read worked and there is no snapshot", which is NOT_MEASURED. Two
    // different answers, and collapsing them would report our outage as the
    // customer's unmeasured project.
    snapshot = undefined;
  }

  const state: CoverageBadgeState =
    snapshot === undefined
      ? 'UNAVAILABLE'
      : snapshot === null
        ? 'NOT_MEASURED'
        : snapshot.denominator === 0 || snapshot.percent === null
          ? 'EMPTY_DENOMINATOR'
          : 'MEASURED';

  /*
   * The delta, from the stored history row, WITH its comparability. Read and
   * not computed: comparability was decided at write time against the two
   * snapshots' crawl fingerprints, and recomputing it here would mean
   * subtracting whichever two percentages are closest to hand — which always
   * succeeds and is the easiest number in this product to get wrong.
   */
  let history:
    | { deltaPercent: number | null; comparability: string; comparabilityDetail: string | null }
    | null = null;
  try {
    history = await prisma.coverageHistory.findFirst({
      where: { projectId, scopeKey: HEADLINE_SCOPE_KEY },
      orderBy: { createdAt: 'desc' },
      select: { deltaPercent: true, comparability: true, comparabilityDetail: true },
    });
  } catch {
    history = null;
  }

  const meaningful =
    history !== null && deltaIsMeaningful(history.comparability as SnapshotComparability);

  res.json({
    state,
    label: COVERAGE_BADGE_LABELS[state],
    /*
     * NULL IN EVERY STATE BUT ONE. A renderer must branch on `state`; there is
     * deliberately no field here it could `?? 0` its way out of.
     */
    percent: state === 'MEASURED' ? (snapshot?.percent ?? null) : null,
    denominator: snapshot?.denominator ?? null,
    covered: snapshot?.covered ?? null,
    measuredAt: snapshot?.createdAt ?? null,
    /** NULL unless the two snapshots are comparable. Never a bare number. */
    deltaPercent: meaningful ? (history?.deltaPercent ?? null) : null,
    comparability: history?.comparability ?? 'NOT_COMPARED',
    comparabilityDetail: meaningful ? null : (history?.comparabilityDetail ?? null),
    /** The sentence a renderer shows instead of a figure. Always present. */
    why:
      state === 'MEASURED'
        ? 'A stored snapshot, at the ASSERTED rung. A delta is reported only when the two snapshots share a crawl fingerprint and a denominator definition.'
        : state === 'NOT_MEASURED'
          ? 'Nothing has been measured for this project yet. This is NOT 0% — render the words, never a number.'
          : state === 'EMPTY_DENOMINATOR'
            ? 'This project was measured and its denominator was zero, so there is no percentage. Nothing was enumerated to count — that is a crawl to run, not a figure to improve.'
            : 'This deployment could not read the stored coverage. The figure is UNKNOWN, which is our fault and not a statement about your application.',
  });
});
