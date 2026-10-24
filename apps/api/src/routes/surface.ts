/**
 * The dark-surface report — "which parts of your application has nothing ever
 * tested, by name?"
 *
 * This is the endpoint the product is sold on, so it is worth being precise
 * about what makes it different from `/coverage/:projectId`, which already
 * exists and is not being replaced.
 *
 *   /coverage  compares the FlowMap against the Test rows. Its denominator is
 *              what a crawl reached, so it answers "of the pages we got to,
 *              which are untested?" Every vendor in this market can answer
 *              that, because the denominator comes from the same process as
 *              the numerator.
 *   /surface   compares the SOURCE-declared surface against the Test rows, and
 *              reconciles it with the crawl. Its denominator is what the code
 *              declares, independently of whether anything ever reached it, so
 *              it answers "which parts of your application has nothing ever
 *              touched?" — including the ones a crawl cannot see at all.
 *
 *   GET    /surface/:projectId              the report: percentage + named list
 *   GET    /surface/:projectId/trend        stored snapshots, newest first
 *   POST   /surface/:projectId/recompute    measure now, and store it
 *   POST   /surface/:projectId/waivers      record a decision not to test
 *   DELETE /surface/:projectId/waivers/:key withdraw one
 *
 * THE PERCENTAGE IS NOT THE POINT, AND THE SHAPE REFLECTS THAT
 *
 * A percentage gets argued about; a list of 43 named routes with the file each
 * is declared in gets forwarded to someone who can act on it. So `uncovered` is
 * the body of the response and `snapshot.totals.percent` is a field on it. The
 * ranking is deliberate too — auth surfaces before endpoints before routes
 * before forms, and within a kind, declared-but-never-reached first, because
 * those are the rows no competing tool can produce.
 *
 * WHY THE READ PATH DOES NOT WRITE
 *
 * GET recomputes without persisting. A snapshot is a claim about a point in
 * time, and minting one every time somebody opens a dashboard would fill the
 * trend with duplicates and make the CI gate's delta meaningless. Writing is
 * POST /recompute, and the worker calls it after an analysis, a crawl or a run.
 */

import { Router } from 'express';
import { z } from 'zod';
import { SURFACE_KINDS, SURFACE_STATUSES, parseSurfaceKey } from '@qaai/shared';
import type { SurfaceItemCoverage, SurfaceKind, SurfaceStatus } from '@qaai/shared';
import {
  computeCoverage,
  ensureInventory,
  latestSnapshot,
  snapshotTrend,
} from '../lib/coverage-store.js';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { actorOf, requireAuth, requireRole, requireScope } from '../middleware/auth.js';

export const surfaceRouter: Router = Router();

surfaceRouter.use(requireAuth);

/**
 * How many items one response carries.
 *
 * Capped, and the cap is REPORTED rather than silently applied: a report that
 * says "43 uncovered routes" while holding back 200 more is the kind of quiet
 * truncation that makes a number untrustworthy. `truncated` and the totals are
 * always the full picture even when the list is a page of it.
 */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

async function projectOr404(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, orgId: true, name: true },
  });
  if (!project) throw notFound('Project');
  return project;
}

/** Parses a comma-separated enum list, 400ing on an unknown name. */
function parseList<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  field: string,
): T[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
  const bad = parts.filter((part) => !allowed.includes(part as T));
  // An unknown filter value returning an empty list reads as "you have no
  // uncovered endpoints", which is the opposite of the truth.
  if (bad.length > 0) {
    throw badRequest(
      `Unknown ${field}: ${bad.join(', ')}. Valid values are ${allowed.join(', ')}.`,
    );
  }
  return parts as T[];
}

// ─── GET /surface/:projectId ─────────────────────────────────────────────────

const reportQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  /** Comma-separated SurfaceKind values. */
  kind: z.string().optional(),
  /** Comma-separated SurfaceStatus values. Defaults to UNCOVERED. */
  status: z.string().optional(),
  /** `source-only` narrows to the rows no runtime-only tool can see. */
  origin: z.enum(['SOURCE_ONLY', 'CRAWL_ONLY', 'BOTH']).optional(),
});

surfaceRouter.get('/surface/:projectId', requireScope('tests:read'), async (req, res) => {
  const parsed = reportQuery.safeParse(req.query);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query');
  const query = parsed.data;

  const project = await projectOr404(String(req.params.projectId));
  const kinds = parseList<SurfaceKind>(query.kind, SURFACE_KINDS, 'kind');
  const statuses =
    parseList<SurfaceStatus>(query.status, SURFACE_STATUSES, 'status') ?? (['UNCOVERED'] as const);

  const computed = await computeCoverage({
    orgId: project.orgId,
    projectId: project.id,
    // A read never writes a snapshot. See the header.
    persist: false,
  });

  const matches = (entry: SurfaceItemCoverage) =>
    statuses.includes(entry.status) &&
    (!kinds || kinds.includes(entry.item.kind)) &&
    (!query.origin || entry.item.origin === query.origin);

  // `uncovered` is already ranked worst-first; filtering preserves that order.
  const ranked = (
    statuses.length === 1 && statuses[0] === 'UNCOVERED' ? computed.uncovered : computed.entries
  ).filter(matches);

  const limit = query.limit ?? DEFAULT_LIMIT;
  const offset = query.offset ?? 0;
  const page = ranked.slice(offset, offset + limit);

  res.json({
    projectId: project.id,
    snapshot: computed.snapshot,
    items: page,
    /** Always the full count, whatever the page holds. */
    total: ranked.length,
    offset,
    limit,
    truncated: offset + page.length < ranked.length,
    unmeasuredKinds: computed.unmeasuredKinds,
    /**
     * The last PERSISTED snapshot, so a caller can see whether the number they
     * are reading differs from the one a gate last acted on.
     */
    lastStored: await latestSnapshot(project.id),
  });
});

// ─── GET /surface/:projectId/trend ───────────────────────────────────────────

const trendQuery = z.object({
  limit: z.coerce.number().int().min(1).max(365).optional(),
});

surfaceRouter.get('/surface/:projectId/trend', requireScope('tests:read'), async (req, res) => {
  const parsed = trendQuery.safeParse(req.query);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query');
  const project = await projectOr404(String(req.params.projectId));
  res.json({
    projectId: project.id,
    snapshots: await snapshotTrend(project.id, parsed.data.limit ?? 30),
  });
});

// ─── POST /surface/:projectId/recompute ──────────────────────────────────────

const recomputeBody = z.object({
  /** Recorded on the snapshot so a release can be audited later. */
  commitSha: z.string().trim().min(7).max(64).optional(),
  runId: z.string().trim().min(1).max(64).optional(),
});

surfaceRouter.post(
  '/surface/:projectId/recompute',
  requireRole('MEMBER'),
  requireScope('tests:write'),
  async (req, res) => {
    const parsed = recomputeBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
    const project = await projectOr404(String(req.params.projectId));

    const computed = await computeCoverage({
      orgId: project.orgId,
      projectId: project.id,
      commitSha: parsed.data.commitSha ?? null,
      runId: parsed.data.runId ?? null,
      persist: true,
    });

    const actor = actorOf(req);
    await audit({
      actor,
      action: 'coverage.recompute',
      targetType: 'Project',
      targetId: project.id,
      metadata: {
        snapshotId: computed.snapshotId,
        percent: computed.snapshot.totals.percent,
        denominator: computed.snapshot.totals.denominator,
      },
    });

    res.status(201).json({
      snapshotId: computed.snapshotId,
      snapshot: computed.snapshot,
      unmeasuredKinds: computed.unmeasuredKinds,
    });
  },
);

// ─── Waivers ─────────────────────────────────────────────────────────────────

const waiverBody = z.object({
  /** The surface key, e.g. `ROUTE:/admin/legacy`. */
  key: z.string().trim().min(3).max(500),
  /**
   * Required, and not allowed to be a shrug. A waiver is a decision that
   * removes something from the denominator, and one with no stated reason is
   * indistinguishable from a number being gamed.
   */
  reason: z.string().trim().min(10).max(1000),
  /**
   * Optional, but the UI proposes one. A waiver with no expiry is how a
   * denominator quietly shrinks forever.
   */
  expiresAt: z.coerce.date().optional(),
});

surfaceRouter.post(
  '/surface/:projectId/waivers',
  requireRole('MEMBER'),
  requireScope('tests:write'),
  async (req, res) => {
    const parsed = waiverBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
    const { key, reason, expiresAt } = parsed.data;

    if (!parseSurfaceKey(key)) {
      throw badRequest(
        `"${key}" is not a surface key. They look like ROUTE:/orders/:param or ENDPOINT:POST /api/refunds.`,
      );
    }
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw badRequest('A waiver that has already expired would have no effect.');
    }

    const project = await projectOr404(String(req.params.projectId));
    // A GET never persists, so on a project nobody has explicitly recomputed
    // there are no rows and every visible gap would be unwaivable. This is a
    // write endpoint, so materialising here is appropriate; reads stay reads.
    await ensureInventory({ orgId: project.orgId, projectId: project.id });
    const item = await prisma.coverageItem.findUnique({
      where: { projectId_key: { projectId: project.id, key } },
      select: { id: true, label: true },
    });
    // Waiving something that is not in the inventory would create an exclusion
    // for an item nobody can see, which is worse than refusing.
    if (!item) {
      throw notFound(
        'Coverage item — run POST /surface/:projectId/recompute first, or check the key',
      );
    }

    const actor = actorOf(req);
    // The waiver's owner has to be readable by a human reviewing exclusions
    // months later, and ActorContext carries only an id.
    const owner = await prisma.user.findUnique({
      where: { id: actor.userId },
      select: { email: true },
    });
    const waiver = await prisma.coverageWaiver.upsert({
      where: { itemId: item.id },
      create: {
        orgId: project.orgId,
        projectId: project.id,
        itemId: item.id,
        reason,
        byUserId: actor.userId,
        byEmail: owner?.email ?? null,
        expiresAt: expiresAt ?? null,
      },
      update: {
        reason,
        byUserId: actor.userId,
        byEmail: owner?.email ?? null,
        expiresAt: expiresAt ?? null,
      },
      select: { id: true, createdAt: true, expiresAt: true },
    });

    // The item's own status is stale until the next computation, so it is
    // written here rather than left to drift.
    await prisma.coverageItem.update({
      where: { id: item.id },
      data: { status: 'WAIVED' },
    });

    await audit({
      actor,
      action: 'coverage.waiver.create',
      targetType: 'CoverageItem',
      targetId: item.id,
      metadata: { key, reason, expiresAt: waiver.expiresAt?.toISOString() ?? null },
    });

    res.status(201).json({ waiverId: waiver.id, key, label: item.label, ...waiver });
  },
);

surfaceRouter.delete(
  '/surface/:projectId/waivers/:key',
  requireRole('MEMBER'),
  requireScope('tests:write'),
  async (req, res) => {
    const project = await projectOr404(String(req.params.projectId));
    // The key contains a colon and slashes, so callers send it encoded. Express
    // has already decoded the param once; nothing further is needed.
    const key = String(req.params.key);

    const item = await prisma.coverageItem.findUnique({
      where: { projectId_key: { projectId: project.id, key } },
      select: { id: true, waiver: { select: { id: true } } },
    });
    if (!item?.waiver) throw notFound('Waiver');

    await prisma.coverageWaiver.delete({ where: { id: item.waiver.id } });
    // Back into the denominator as UNCOVERED until the next computation says
    // otherwise. Leaving it WAIVED would keep it excluded with no waiver row.
    await prisma.coverageItem.update({
      where: { id: item.id },
      data: { status: 'UNCOVERED' },
    });

    await audit({
      actor: actorOf(req),
      action: 'coverage.waiver.delete',
      targetType: 'CoverageItem',
      targetId: item.id,
      metadata: { key },
    });

    res.status(204).end();
  },
);
