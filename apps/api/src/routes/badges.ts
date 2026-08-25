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
