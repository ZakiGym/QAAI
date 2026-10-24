/**
 * Persists the surface inventory and the snapshots computed from it.
 *
 * This is the file that makes a coverage number defensible rather than merely
 * printable. The previous implementation derived its answer on every request
 * and threw it away, which meant there was no trend, nothing for a CI gate to
 * compare against, and no way to name a single item in a waiver. A denominator
 * has to be addressable to be argued about, and arguing about it is the point.
 *
 * THREE DECISIONS WORTH THE COMMENT
 *
 * 1. ITEMS ARE RETIRED, NOT DELETED. When the extractor stops finding a route,
 *    the row gets `retiredAt` and stays. A denominator that shrinks silently is
 *    indistinguishable from one that improved, and "your coverage went up 4
 *    points because we stopped seeing 30 of your routes" is the single worst
 *    sentence this product could ever be caught saying. Retirement leaves the
 *    audit trail that makes the difference visible.
 *
 * 2. A SNAPSHOT RECORDS ITS INPUTS. The commit, the analysis id, the flow-map
 *    version, the test count and every caveat live on the row beside the
 *    number. A percentage without its inputs cannot be defended in a meeting,
 *    and if the crawl stopped at 60 pages that belongs next to the figure it
 *    produced rather than in a tooltip nobody opens.
 *
 * 3. NOTHING HERE DECIDES ANYTHING. All the judgement is in
 *    packages/agent/src/surface-{inventory,coverage}.ts, which call no model.
 *    This file reads rows, hands them over, and writes the result back.
 */

import { FIXTURE_PREFIX } from '@qaai/shared';
import type {
  CodebaseAnalysis,
  FlowMap,
  SurfaceItemCoverage,
  SurfaceKind,
  SurfaceSnapshot,
  SurfaceWaiver,
} from '@qaai/shared';
import {
  analyseSurfaceCoverage,
  buildSurfaceInventory,
  missingAxes,
  rankUncovered,
  type TestExecutionFact,
} from '@qaai/agent';
import { prisma } from './prisma.js';
import { toCoverageInputs } from '../routes/coverage.js';

/** Mirrors the runnable set used by POST /runs, /impact and /coverage. */
const TEST_SELECT = {
  id: true,
  name: true,
  filePath: true,
  code: true,
  spec: true,
  tags: true,
  feature: true,
  priority: true,
  type: true,
  /*
   * The role each test runs as. Required by `toCoverageInputs`, which is shared
   * with routes/coverage.ts on purpose — the denominator and the gap report must
   * read a test the same way or they will disagree about the same suite.
   *
   * A test bound to an auth profile carries no sign-in in its source (the runner
   * injects the session), so without these two columns every signed-in test in
   * the install looks like a signed-out visitor to both analyses.
   */
  authProfileId: true,
  authProfileRequired: true,
} as const;

export interface ComputeOptions {
  orgId: string;
  projectId: string;
  /** Recorded on the snapshot so a release can be audited months later. */
  commitSha?: string | null;
  /** The run that triggered this, when one did. */
  runId?: string | null;
  /** Persist the result. False computes without writing, for a dry-run gate. */
  persist?: boolean;
}

/**
 * Ensures the inventory exists as rows, so an item can be addressed.
 *
 * A GET deliberately never persists, which left waivers unreachable: the waiver
 * endpoint needs a CoverageItem row to hang off, and on a project nobody had
 * explicitly recomputed there were none — so every gap the screen legitimately
 * showed was impossible to waive. Materialising on first write is the fix that
 * does not make reads start writing.
 */
export async function ensureInventory(options: {
  orgId: string;
  projectId: string;
}): Promise<void> {
  const existing = await prisma.coverageItem.count({
    where: { projectId: options.projectId, retiredAt: null },
  });
  if (existing > 0) return;
  await computeCoverage({ ...options, persist: true });
}

export interface ComputedCoverage {
  entries: SurfaceItemCoverage[];
  uncovered: SurfaceItemCoverage[];
  snapshot: SurfaceSnapshot;
  unmeasuredKinds: SurfaceKind[];
  /** Set when `persist` was true. */
  snapshotId: string | null;
}

// ─── Loading the inputs ──────────────────────────────────────────────────────

/**
 * The most recent source read.
 *
 * Null is a real answer and the caller must handle it: a project whose repo was
 * never ingested has only a crawl to go on, which is exactly the weaker
 * denominator this feature exists to replace. The inventory says so in a
 * caveat rather than quietly reporting a smaller number.
 */
async function loadAnalysis(
  projectId: string,
): Promise<{ analysis: CodebaseAnalysis | null; analysisId: string | null }> {
  const snapshot = await prisma.codebaseSnapshot.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, analysis: true },
  });
  if (!snapshot) return { analysis: null, analysisId: null };
  // The column is Json written by an older shape than the types describe, so
  // it is read defensively — the same rule coverage.ts applies to flow maps.
  const analysis = snapshot.analysis as unknown;
  if (!analysis || typeof analysis !== 'object' || !('routes' in analysis)) {
    return { analysis: null, analysisId: snapshot.id };
  }
  return { analysis: analysis as CodebaseAnalysis, analysisId: snapshot.id };
}

/** Latest crawl only: an older version describes an app that no longer exists. */
async function loadFlowMap(
  projectId: string,
): Promise<{ flowMap: FlowMap | null; version: number | null }> {
  const row = await prisma.flowMap.findFirst({
    where: { projectId },
    orderBy: { version: 'desc' },
    select: { graph: true, version: true },
  });
  if (!row) return { flowMap: null, version: null };
  const graph = row.graph as unknown;
  if (!graph || typeof graph !== 'object' || !('nodes' in graph)) {
    return { flowMap: null, version: row.version };
  }
  return { flowMap: graph as FlowMap, version: row.version };
}

/**
 * Each test's genuinely latest execution, plus whether it has ever passed.
 *
 * TWO FACTS, NOT ONE — AND THE BUG THAT CAME FROM MERGING THEM
 *
 * This used to let a PASSED result "upgrade" an entry a later failure had
 * already written, on the reasoning that `executed` asked whether the test had
 * ever worked. The effect was that `lastStatus` stopped being the last status:
 * a test whose newest run failed reported PASSED from an older one, and the
 * surface it covered displayed "last run: PASSED" while its only test was red.
 *
 * So the two questions are answered separately. The newest result wins
 * `status`/`runId`/`atIso` unconditionally; `everPassed` is its own flag. The
 * matcher then decides what each one means for coverage, which is its job and
 * not this function's.
 */
async function loadExecutions(projectId: string): Promise<TestExecutionFact[]> {
  const results = await prisma.testResult.findMany({
    where: { test: { projectId } },
    orderBy: { createdAt: 'desc' },
    select: { testId: true, runId: true, status: true, createdAt: true },
    // Bounded: a long-lived project has more results than anyone needs read
    // here, and the newest-first order means the cap only ever drops history.
    take: 20_000,
  });

  const latest = new Map<string, TestExecutionFact>();
  for (const result of results) {
    if (!result.testId) continue;
    const existing = latest.get(result.testId);
    if (!existing) {
      // Newest first, so the first sighting of a test IS its latest result.
      latest.set(result.testId, {
        testId: result.testId,
        runId: result.runId,
        status: result.status,
        atIso: result.createdAt.toISOString(),
        everPassed: result.status === 'PASSED',
      });
      continue;
    }
    // Older rows contribute nothing but history. They may not touch `status`.
    if (result.status === 'PASSED') existing.everPassed = true;
  }
  return [...latest.values()];
}

/** Waivers, keyed by surface key, with their owner attached. */
async function loadWaivers(projectId: string): Promise<Record<string, SurfaceWaiver>> {
  const rows = await prisma.coverageWaiver.findMany({
    where: {
      projectId,
      // An expired waiver is not a waiver. Letting one linger would mean a
      // denominator that stays shrunk because nobody revisited a decision.
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: {
      reason: true,
      byUserId: true,
      byEmail: true,
      createdAt: true,
      expiresAt: true,
      item: { select: { key: true } },
    },
  });

  const waivers: Record<string, SurfaceWaiver> = {};
  for (const row of rows) {
    waivers[row.item.key] = {
      reason: row.reason,
      byUserId: row.byUserId,
      byEmail: row.byEmail,
      createdAtIso: row.createdAt.toISOString(),
      expiresAtIso: row.expiresAt?.toISOString() ?? null,
    };
  }
  return waivers;
}

// ─── Computing ───────────────────────────────────────────────────────────────

export async function computeCoverage(options: ComputeOptions): Promise<ComputedCoverage> {
  const { orgId, projectId } = options;

  const [{ analysis, analysisId }, { flowMap, version }, tests, executions, waivers] =
    await Promise.all([
      loadAnalysis(projectId),
      loadFlowMap(projectId),
      prisma.test.findMany({
        where: {
          projectId,
          disabledAt: null,
          filePath: { not: { startsWith: FIXTURE_PREFIX } },
        },
        select: TEST_SELECT,
      }),
      loadExecutions(projectId),
      loadWaivers(projectId),
    ]);

  const inventory = buildSurfaceInventory({ analysis, flowMap });
  const result = analyseSurfaceCoverage({
    items: inventory.items,
    tests: toCoverageInputs(tests),
    executions,
    waivers,
  });

  // Both sets of caveats, inventory first: what the denominator is made of
  // comes before what the division could not see.
  const caveats = [...inventory.caveats, ...result.caveats];

  const snapshot: SurfaceSnapshot = {
    // Null until persist() returns an id. A GET leaves it null on purpose.
    id: null,
    projectId,
    createdAtIso: new Date().toISOString(),
    commitSha: options.commitSha ?? null,
    totals: result.totals,
    inputs: {
      analysisId,
      flowMapVersion: version,
      testCount: tests.length,
      runId: options.runId ?? null,
    },
    caveats,
    // Both halves: the inventory could change without the division changing,
    // and a consumer caching on this needs to notice either.
    fingerprint: `${inventory.fingerprint}.${result.fingerprint}`,
  };

  let snapshotId: string | null = null;
  if (options.persist !== false) {
    snapshotId = await persist({ orgId, projectId, entries: result.entries, snapshot });
    snapshot.id = snapshotId;
  }

  return {
    entries: result.entries,
    uncovered: rankUncovered(result.entries),
    snapshot,
    unmeasuredKinds: missingAxes(),
    snapshotId,
  };
}

// ─── Writing ─────────────────────────────────────────────────────────────────

async function persist(input: {
  orgId: string;
  projectId: string;
  entries: SurfaceItemCoverage[];
  snapshot: SurfaceSnapshot;
}): Promise<string> {
  const { orgId, projectId, entries, snapshot } = input;
  const seenKeys = entries.map((entry) => entry.item.key);

  // Upserts in chunks rather than one transaction over everything: a project
  // with a few thousand items would hold a write transaction open long enough
  // to matter, and each item is independent, so a partial write leaves a
  // consistent inventory that the next computation completes.
  const CHUNK = 200;
  for (let offset = 0; offset < entries.length; offset += CHUNK) {
    const chunk = entries.slice(offset, offset + CHUNK);
    await prisma.$transaction(
      chunk.map((entry) => {
        const { item, status, matches, verification } = entry;
        const data = {
          orgId,
          projectId,
          kind: item.kind,
          label: item.label,
          file: item.file,
          line: item.line,
          origin: item.origin,
          evidence: item.evidence,
          detector: item.detector,
          meta: (item.meta ?? {}) as object,
          status,
          matches: matches as unknown as object,
          lastRunId: verification.lastRunId,
          lastStatus: verification.lastStatus,
          executed: verification.executed,
          mutationKilled: verification.mutationKilled,
          // Re-seeing a retired item un-retires it: a route that came back is
          // the same route, and minting a new row would reset its history.
          retiredAt: null,
        };
        return prisma.coverageItem.upsert({
          where: { projectId_key: { projectId, key: item.key } },
          create: { ...data, key: item.key },
          update: data,
        });
      }),
    );
  }

  // Retire, never delete. See the header.
  await prisma.coverageItem.updateMany({
    where: { projectId, key: { notIn: seenKeys }, retiredAt: null },
    data: { retiredAt: new Date() },
  });

  const row = await prisma.coverageSnapshot.create({
    data: {
      orgId,
      projectId,
      commitSha: snapshot.commitSha,
      percent: snapshot.totals.percent,
      denominator: snapshot.totals.denominator,
      covered: snapshot.totals.covered,
      assertedNotRun: snapshot.totals.assertedNotRun,
      uncovered: snapshot.totals.uncovered,
      unknown: snapshot.totals.unknown,
      waived: snapshot.totals.waived,
      declaredNeverReached: snapshot.totals.declaredNeverReached,
      reachedNeverDeclared: snapshot.totals.reachedNeverDeclared,
      // Spread into plain objects rather than cast: Prisma's Json input type
      // rejects a typed interface array, and a cast here would silence the one
      // check that notices if SurfaceKindTotals ever gains a non-serialisable
      // field.
      byKind: snapshot.totals.byKind.map((totals) => ({ ...totals })),
      analysisId: snapshot.inputs.analysisId,
      flowMapVersion: snapshot.inputs.flowMapVersion,
      testCount: snapshot.inputs.testCount,
      runId: snapshot.inputs.runId,
      caveats: snapshot.caveats,
      fingerprint: snapshot.fingerprint,
    },
    select: { id: true },
  });
  return row.id;
}

// ─── Reading back ────────────────────────────────────────────────────────────

/** The stored snapshot trend, newest first. What makes a gate's delta meaningful. */
export async function snapshotTrend(projectId: string, limit = 30) {
  return prisma.coverageSnapshot.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      createdAt: true,
      commitSha: true,
      percent: true,
      denominator: true,
      covered: true,
      uncovered: true,
      unknown: true,
      waived: true,
      assertedNotRun: true,
      declaredNeverReached: true,
      reachedNeverDeclared: true,
      byKind: true,
      caveats: true,
      fingerprint: true,
      testCount: true,
      flowMapVersion: true,
    },
  });
}

/** The latest stored snapshot, or null when nothing has been computed. */
export async function latestSnapshot(projectId: string) {
  const [snapshot] = await snapshotTrend(projectId, 1);
  return snapshot ?? null;
}
