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
 *   GET    /surface/:projectId/rollups      the same denominator, cut by feature
 *                                           and by owning team
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
import {
  COVERED_STATUSES,
  EXCLUDED_STATUSES,
  SURFACE_KINDS,
  SURFACE_STATUSES,
  parseSurfaceKey,
} from '@qaai/shared';
import type { FlowMap, SurfaceItemCoverage, SurfaceKind, SurfaceStatus } from '@qaai/shared';
import { canonicalRoute } from '@qaai/agent';
import {
  computeCoverage,
  ensureInventory,
  latestSnapshot,
  snapshotTrend,
} from '../lib/coverage-store.js';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import {
  OWNERSHIP_RULE_SELECT,
  assignOwner,
  ownableSurface,
  ownerKey,
  ownerLabel,
} from '../lib/ownership.js';
import type {
  OwnerAssignment,
  OwnerDirectory,
  OwnerRef,
  OwnershipRuleInput,
  OwnershipState,
} from '../lib/ownership.js';
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

/**
 * How many already-filed coverage tickets the rollups response lists.
 *
 * Its own constant rather than a bare `take: 100`, because the number has to
 * appear in the response beside the list (`filedLimit`) — a cap a caller
 * cannot see is a cap a caller will mistake for the whole set.
 */
const MAX_FILED_LISTED = 100;

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

// ─── Rollups: the same denominator, cut by feature and by owning team ────────

/**
 * "Payments is at 31%, and Team Billing owns it."
 *
 * THE SENTENCE THAT COULD NOT BE SAID
 *
 * The report above is global. It can say the project is at 61% and it can name
 * every gap, but it cannot answer the two questions that get a gap closed:
 * which PART of the application is thin, and WHOSE it is. A global percentage
 * is a number for a slide; a percentage with an owner's name on it is a piece
 * of work somebody has accepted.
 *
 * NEITHER AXIS IS A NEW FACT — BOTH ARE JOINS THIS FILE REFUSED TO MAKE
 *
 *   FEATURE comes from the crawl's own feature grouping (FlowMap.features, the
 *           Explorer's) and, where that has nothing to say, from the `feature`
 *           column on the tests matched to the item.
 *   OWNER   comes from OwnershipRule, through the SAME resolver the digest and
 *           GET /team/ownership/resolve use. An untested route is routed by the
 *           same rules as a failing test — a team that wrote
 *           `app/checkout/** → @payments` has already said who owns checkout,
 *           and asking them to say it twice is how the two answers diverge.
 *
 * WHY THE CRAWL'S NAME WINS OVER THE TEST'S
 *
 * Because a percentage is only comparable inside one vocabulary. The crawl
 * names features across the whole surface — the covered rows and the gaps
 * alike — while `Test.feature` can only ever name the covered ones, so
 * preferring it would attribute the numerator from one dictionary and the
 * denominator from another and produce "Orders: 100%" beside "Order
 * management: 0%" for the same part of the app. When both exist and disagree
 * the group says so in `sources`, rather than hiding it.
 *
 * AND WHERE NEITHER KNOWS, IT SAYS SO
 *
 * An item with no feature lands in a group whose `attributed` is false, and an
 * item nobody owns lands in one whose `owner` is null — each with its own
 * count, never folded into another group and never scored 0. A gap attributed
 * to the wrong team is worse than a gap attributed to nobody: the wrong team
 * closes the ticket.
 */

/** The counts, with the same arithmetic the snapshot's per-axis totals use. */
export interface CoverageTotals {
  /** Items excluding waived — `EXCLUDED_STATUSES`, so this cannot drift. */
  denominator: number;
  covered: number;
  assertedNotRun: number;
  uncovered: number;
  unknown: number;
  waived: number;
  /**
   * `covered / denominator`, one decimal, or null when the denominator is zero.
   * Null is not 0% and not 100%: a group with nothing measurable in it means
   * our extractor found nothing, and either number would be a claim about the
   * customer's application made out of our own silence.
   */
  percent: number | null;
}

export type FeatureSource = 'CRAWL' | 'TESTS';

/** One surface item with a feature and an owner attached — or honestly without. */
export interface AttributedItem {
  entry: SurfaceItemCoverage;
  feature: string | null;
  /** Null exactly when `feature` is null. */
  featureSource: FeatureSource | null;
  owner: OwnerRef | null;
  ownerState: OwnershipState;
  /** `@payments`, a person's name — null when nobody owns it. */
  ownerName: string | null;
  /** The resolver's own sentence, so "why is this ours?" has an answer. */
  ownerNote: string;
}

export interface CoverageGroup {
  /** Grouping key: a lower-cased feature name, or `TEAM:…`/`USER:…`. */
  key: string;
  /** What to print: the feature's first-seen spelling, or the owner's name. */
  label: string;
  /** False for the "no feature attributed" / "nobody owns this" bucket. */
  attributed: boolean;
  totals: CoverageTotals;
  /** Where the feature name came from. Both, when the two sources disagreed. */
  sources: FeatureSource[];
  /** On a feature group: who owns the items in it. Absent on an owner group. */
  owners?: Array<{ key: string | null; label: string; totals: CoverageTotals }>;
}

export interface CoverageAttribution {
  items: number;
  featureFromCrawl: number;
  featureFromTests: number;
  /** Named, never scored. These are the items no group can truthfully claim. */
  featureUnattributed: number;
  ownedItems: number;
  unownedItems: number;
  rulesEvaluated: number;
  /**
   * Rules that could not be evaluated. Surfaced because a rule that has
   * silently stopped routing looks exactly like a surface nobody has assigned.
   */
  rulesUnusable: Array<{ ruleId: string; reason: string }>;
}

const EMPTY_TOTALS = (): CoverageTotals => ({
  denominator: 0,
  covered: 0,
  assertedNotRun: 0,
  uncovered: 0,
  unknown: 0,
  waived: 0,
  percent: null,
});

function tally(totals: CoverageTotals, status: SurfaceStatus): void {
  // `COVERED_STATUSES` rather than the literal: the numerator of a cut and the
  // numerator of the headline have to be the same claim. If ASSERTED_NOT_RUN
  // ever counts as covered, it counts here too, in the same change.
  if (COVERED_STATUSES.includes(status)) totals.covered += 1;
  if (status === 'ASSERTED_NOT_RUN') totals.assertedNotRun += 1;
  else if (status === 'UNCOVERED') totals.uncovered += 1;
  else if (status === 'UNKNOWN') totals.unknown += 1;
  else if (status === 'WAIVED') totals.waived += 1;
  // WAIVED is the only status out of the denominator, read from the shared
  // constant rather than spelled here — the headline number and this one must
  // divide by the same thing or the cockpit shows two different truths.
  if (!EXCLUDED_STATUSES.includes(status)) totals.denominator += 1;
}

function finish(totals: CoverageTotals): CoverageTotals {
  totals.percent =
    totals.denominator === 0
      ? null
      : Math.round((totals.covered / totals.denominator) * 1000) / 10;
  return totals;
}

/** A group bucket, keyed, so the first spelling seen is the one printed. */
interface Bucket {
  key: string;
  label: string;
  attributed: boolean;
  totals: CoverageTotals;
  sources: Set<FeatureSource>;
  owners: Map<string, { key: string | null; label: string; totals: CoverageTotals }>;
}

function bucketFor(
  buckets: Map<string, Bucket>,
  key: string,
  label: string,
  attributed: boolean,
): Bucket {
  const existing = buckets.get(key);
  if (existing) return existing;
  const bucket: Bucket = {
    key,
    label,
    attributed,
    totals: EMPTY_TOTALS(),
    sources: new Set(),
    owners: new Map(),
  };
  buckets.set(key, bucket);
  return bucket;
}

/**
 * The arithmetic, pure and separate from every query above it.
 *
 * Sorted worst-first by uncovered count rather than by percentage: a feature
 * with 400 untested endpoints at 70% is more work than one with 3 at 0%, and
 * the list exists to be worked down. The unattributed bucket sorts last
 * whatever its size — it is a statement about our knowledge, not a work item.
 */
export function rollUpCoverage(items: readonly AttributedItem[]): {
  byFeature: CoverageGroup[];
  byOwner: CoverageGroup[];
} {
  const features = new Map<string, Bucket>();
  const owners = new Map<string, Bucket>();

  for (const item of items) {
    const status = item.entry.status;

    const featureKey = item.feature ? `FEATURE:${item.feature.trim().toLowerCase()}` : 'FEATURE:—';
    const feature = bucketFor(
      features,
      featureKey,
      item.feature ?? 'No feature attributed',
      item.feature !== null,
    );
    tally(feature.totals, status);
    if (item.featureSource) feature.sources.add(item.featureSource);

    const ownerId = item.owner ? ownerKey(item.owner) : null;
    const ownerName = item.ownerName ?? 'Nobody owns this';

    // The cross-tab — the only shape that can say "Payments, owned by @billing".
    const cell = feature.owners.get(ownerId ?? 'UNOWNED') ?? {
      key: ownerId,
      label: ownerName,
      totals: EMPTY_TOTALS(),
    };
    tally(cell.totals, status);
    feature.owners.set(ownerId ?? 'UNOWNED', cell);

    const owner = bucketFor(owners, ownerId ?? 'UNOWNED', ownerName, ownerId !== null);
    tally(owner.totals, status);
  }

  const shape = (bucket: Bucket, withOwners: boolean): CoverageGroup => ({
    key: bucket.key,
    label: bucket.label,
    attributed: bucket.attributed,
    totals: finish(bucket.totals),
    sources: [...bucket.sources],
    ...(withOwners
      ? {
          owners: [...bucket.owners.values()]
            .map((cell) => ({ ...cell, totals: finish(cell.totals) }))
            .sort((a, b) => b.totals.uncovered - a.totals.uncovered),
        }
      : {}),
  });

  const worstFirst = (a: CoverageGroup, b: CoverageGroup): number =>
    Number(b.attributed) - Number(a.attributed) ||
    b.totals.uncovered - a.totals.uncovered ||
    a.label.localeCompare(b.label);

  return {
    byFeature: [...features.values()].map((b) => shape(b, true)).sort(worstFirst),
    byOwner: [...owners.values()].map((b) => shape(b, false)).sort(worstFirst),
  };
}

/**
 * A feature name, or null — and the reason this is a function.
 *
 * `Test.feature` and a crawl's `features[].name` are both free text, so both
 * can arrive as a string that is only whitespace. Trimmed-to-empty is NOT a
 * feature: it used to survive as `''`, which is truthy on the way in (so it
 * passed the "did any test name a feature?" check) and falsy everywhere after
 * (so `featureSource` came out null while `feature` was not, contradicting
 * `AttributedItem`'s own documented invariant, and `rollUpCoverage` then
 * labelled the no-feature bucket with an empty string and marked it
 * ATTRIBUTED). One blank name in one test row was enough to make the
 * unattributed count read as a named feature nobody can look up.
 */
function namedFeature(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** Route → feature, from the crawl's own grouping. */
function crawlFeatures(graph: unknown): Map<string, string> {
  const byRoute = new Map<string, string>();
  // The column is Json written by whatever worker was deployed at the time, so
  // it is read defensively — the same rule coverage-store.ts applies.
  if (!graph || typeof graph !== 'object' || !('nodes' in graph)) return byRoute;
  const map = graph as Partial<FlowMap>;
  if (!Array.isArray(map.nodes) || !Array.isArray(map.features)) return byRoute;

  const routeById = new Map<string, string>();
  for (const node of map.nodes) {
    if (node && typeof node.id === 'string' && typeof node.route === 'string') {
      routeById.set(node.id, canonicalRoute(node.route));
    }
  }
  for (const group of map.features) {
    if (!group || typeof group.name !== 'string' || !Array.isArray(group.nodeIds)) continue;
    // Through `namedFeature` for the same reason the test-side names are: a
    // crawl that grouped nodes under a blank name has not attributed them.
    const name = namedFeature(group.name);
    if (!name) continue;
    for (const id of group.nodeIds) {
      const route = routeById.get(String(id));
      // First group wins: a node in two feature groups is the Explorer
      // disagreeing with itself, and picking the later one silently would make
      // the attribution depend on array order.
      if (route && !byRoute.has(route)) byRoute.set(route, name);
    }
  }
  return byRoute;
}

/**
 * The route a surface item is about, for the crawl join.
 *
 * ROUTE's identity IS the canonical route. An AUTH_SURFACE's is
 * `LOGIN@/login`, so the path is read from `meta.path`, which the inventory
 * already canonicalised. Endpoints and forms have no route and are attributed
 * from their tests or not at all — guessing that `POST /api/refunds` belongs to
 * whatever feature owns `/refunds` is the kind of inference that puts a gap on
 * the wrong team's board.
 */
function routeOfItem(entry: SurfaceItemCoverage): string | null {
  const { item } = entry;
  if (item.kind === 'ROUTE') return parseSurfaceKey(item.key)?.identity ?? null;
  if (item.kind === 'AUTH_SURFACE') {
    const path = item.meta?.path;
    return typeof path === 'string' ? path : null;
  }
  return null;
}

/** The feature the matched tests agree on, or null when they do not. */
function featureFromTests(
  entry: SurfaceItemCoverage,
  featureByTestId: ReadonlyMap<string, string | null>,
): string | null {
  const named = new Set<string>();
  for (const match of entry.matches) {
    const feature = namedFeature(featureByTestId.get(match.testId));
    if (feature) named.add(feature);
  }
  // Unanimity or nothing. Two tests that disagree about which feature a route
  // belongs to are evidence that nobody has decided, and inventing a winner
  // would move a whole group's percentage on the strength of a coin toss.
  return named.size === 1 ? [...named][0]! : null;
}

export interface AttributedCoverage {
  items: AttributedItem[];
  rollup: { byFeature: CoverageGroup[]; byOwner: CoverageGroup[] };
  attribution: CoverageAttribution;
  snapshot: Awaited<ReturnType<typeof computeCoverage>>['snapshot'];
  unmeasuredKinds: SurfaceKind[];
}

/**
 * The whole join: compute the coverage, attach a feature and an owner to every
 * item, and roll it up.
 *
 * Shared with the filing endpoint (routes/issues.ts) rather than copied into
 * it: a ticket that says "12 untested surfaces in Payments, owned by
 * @billing" and a dashboard that says Payments is at 31% have to be reading
 * the same attribution, or one of them is lying and nobody can tell which.
 */
export async function attributedCoverage(project: {
  id: string;
  orgId: string;
}): Promise<AttributedCoverage> {
  const [computed, flowMap, tests, rules] = await Promise.all([
    computeCoverage({ orgId: project.orgId, projectId: project.id, persist: false }),
    prisma.flowMap.findFirst({
      where: { projectId: project.id },
      orderBy: { version: 'desc' },
      select: { graph: true },
    }),
    prisma.test.findMany({
      where: { projectId: project.id },
      select: { id: true, feature: true },
    }),
    prisma.ownershipRule.findMany({
      where: { projectId: project.id },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: OWNERSHIP_RULE_SELECT,
    }) as Promise<OwnershipRuleInput[]>,
  ]);

  const byRoute = crawlFeatures(flowMap?.graph ?? null);
  const featureByTestId = new Map(tests.map((test) => [test.id, test.feature]));

  // Resolve first, label second: the labels need two more queries and there is
  // no point making them for owners nobody matched.
  const resolved = computed.entries.map((entry) => {
    const route = routeOfItem(entry);
    const fromCrawl = route ? (byRoute.get(route) ?? null) : null;
    const feature = fromCrawl ?? featureFromTests(entry, featureByTestId);
    const assignment = assignOwner(
      ownableSurface({ key: entry.item.key, file: entry.item.file, feature }),
      rules,
    );
    return {
      entry,
      feature,
      featureSource: (fromCrawl ? 'CRAWL' : feature ? 'TESTS' : null) as FeatureSource | null,
      assignment,
    };
  });

  const directory = await loadOwnerDirectory(resolved.map((row) => row.assignment));

  const items: AttributedItem[] = resolved.map((row) => ({
    entry: row.entry,
    feature: row.feature,
    featureSource: row.featureSource,
    owner: row.assignment.owner,
    ownerState: row.assignment.state,
    ownerName: row.assignment.owner ? ownerLabel(row.assignment.owner, directory) : null,
    ownerNote: row.assignment.note,
  }));

  const unusable = new Map<string, { ruleId: string; reason: string }>();
  for (const row of resolved) {
    for (const skipped of row.assignment.unusable) unusable.set(skipped.ruleId, skipped);
  }

  return {
    items,
    rollup: rollUpCoverage(items),
    attribution: {
      items: items.length,
      featureFromCrawl: items.filter((item) => item.featureSource === 'CRAWL').length,
      featureFromTests: items.filter((item) => item.featureSource === 'TESTS').length,
      featureUnattributed: items.filter((item) => item.feature === null).length,
      ownedItems: items.filter((item) => item.owner !== null).length,
      unownedItems: items.filter((item) => item.owner === null).length,
      rulesEvaluated: rules.length,
      rulesUnusable: [...unusable.values()],
    },
    snapshot: computed.snapshot,
    unmeasuredKinds: computed.unmeasuredKinds,
  };
}

/**
 * Names for the owners that actually matched, in two queries rather than one
 * per item. Exported because the filing endpoint needs the same two.
 */
export async function loadOwnerDirectory(
  assignments: readonly OwnerAssignment[],
): Promise<OwnerDirectory> {
  const userIds = new Set<string>();
  const teamIds = new Set<string>();
  for (const assignment of assignments) {
    const owner = assignment.owner;
    if (!owner) continue;
    if (owner.kind === 'USER') userIds.add(owner.userId);
    else teamIds.add(owner.teamId);
  }

  const [users, teams] = await Promise.all([
    userIds.size
      ? prisma.user.findMany({
          where: { id: { in: [...userIds] } },
          select: { id: true, name: true, email: true },
        })
      : Promise.resolve([]),
    teamIds.size
      ? prisma.team.findMany({
          where: { id: { in: [...teamIds] } },
          select: { id: true, slug: true },
        })
      : Promise.resolve([]),
  ]);

  return {
    users: new Map(users.map((user) => [user.id, user])),
    teams: new Map(teams.map((team) => [team.id, team])),
  };
}

// ─── GET /surface/:projectId/rollups ─────────────────────────────────────────

const rollupQuery = z.object({
  by: z.enum(['feature', 'owner', 'both']).optional(),
});

surfaceRouter.get('/surface/:projectId/rollups', requireScope('tests:read'), async (req, res) => {
  const parsed = rollupQuery.safeParse(req.query);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query');
  const by = parsed.data.by ?? 'both';

  const project = await projectOr404(String(req.params.projectId));
  const attributed = await attributedCoverage(project);

  /*
   * Which of these groups is already on somebody's board. Without it a cockpit
   * offering a "file this" button beside every group has no way to know it has
   * already been pressed, which is the forty-tickets defect wearing different
   * clothes.
   */
  const [filed, filedTotal] = await Promise.all([
    prisma.trackerIssue.findMany({
      where: { projectId: project.id, subject: 'COVERAGE_GAP' },
      orderBy: { updatedAt: 'desc' },
      take: MAX_FILED_LISTED,
      select: {
        causeKey: true,
        cause: true,
        url: true,
        key: true,
        title: true,
        ownerState: true,
        affectedCount: true,
        updatedAt: true,
      },
    }),
    /*
     * The COUNT, separately, because the list is a page of it.
     *
     * Without this the response said, flatly, that a project past
     * MAX_FILED_LISTED coverage tickets had only MAX_FILED_LISTED — and the
     * cockpit's "file this" button is driven off exactly this list, so a
     * truncated page is not a cosmetic problem: it re-offers filing for a gap
     * that is already on somebody's board, which is the forty-tickets defect
     * wearing different clothes. One extra COUNT per rollups read is cheaper
     * than that.
     */
    prisma.trackerIssue.count({
      where: { projectId: project.id, subject: 'COVERAGE_GAP' },
    }),
  ]);

  res.json({
    projectId: project.id,
    // The headline stays on the response: a cut of a number is only meaningful
    // next to the number it is a cut of.
    snapshot: attributed.snapshot,
    byFeature: by === 'owner' ? undefined : attributed.rollup.byFeature,
    byOwner: by === 'feature' ? undefined : attributed.rollup.byOwner,
    attribution: attributed.attribution,
    unmeasuredKinds: attributed.unmeasuredKinds,
    filed,
    /**
     * How many coverage tickets this project has, which is NOT `filed.length`
     * whenever the list was capped. `filedTruncated` is the flag a caller has
     * to read before it treats a cause's absence from `filed` as "not filed
     * yet".
     */
    filedTotal,
    filedTruncated: filedTotal > filed.length,
    filedLimit: MAX_FILED_LISTED,
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
