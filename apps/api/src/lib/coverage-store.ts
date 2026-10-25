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
 *
 * 4. A PARTIAL READ MAY NOT RETIRE ANYTHING. The retirement sweep at the bottom
 *    of `persist` says "every item this computation did not see is gone", and
 *    that sentence is only true when the computation consulted every declarer
 *    that ever wrote a row. It no longer does: traffic, recorded sessions,
 *    OpenAPI documents and requirement imports all write `CoverageItem` rows
 *    now, and a recompute that read only the repo and the crawl would retire
 *    every one of them — raising the coverage percentage with nothing tested,
 *    which is the worst sentence this product could be caught saying. So the
 *    sweep is GATED: it runs only when the union was complete, and when it does
 *    not run the snapshot says so.
 */

import { FIXTURE_PREFIX, SURFACE_SOURCES } from '@qaai/shared';
import type {
  CodebaseAnalysis,
  ComponentStateKind,
  FlowMap,
  SourceComponent,
  SurfaceExercisability,
  SurfaceItem,
  SurfaceItemCoverage,
  SurfaceKind,
  SurfaceSnapshot,
  SurfaceSource,
  SurfaceWaiver,
  UnexercisableReason,
} from '@qaai/shared';
import { NON_HAPPY_PATH_STATES, componentHasOwnAxis, surfaceKey } from '@qaai/shared';
import {
  RECONCILE_AXES,
  analyseSurfaceCoverage,
  buildSurfaceInventory,
  componentStateIdentity,
  missingAxes,
  rankUncovered,
  reconcileSurface,
  type ReconcileAxis,
  type ReconcileEntry,
  type ReconcileSourceInput,
  type ReconciliationReport,
  type SurfaceInventory,
  type SurfaceSourceAsked,
  type TestExecutionFact,
} from '@qaai/agent';
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from './prisma.js';
import { toCoverageInputs } from '../routes/coverage.js';

/**
 * The declarers this computation reads for itself.
 *
 * SOURCE comes from the newest `CodebaseSnapshot` and CRAWL from the newest
 * `FlowMap`. Everything else writes `CoverageItem` rows directly and is read
 * back through `loadObservedItems` — which is why the list exists: it is the
 * gate on the retirement sweep, and a declarer missing from both halves must
 * never have its rows retired by a pass that never looked for them.
 */
const DECLARERS_COMPUTED_HERE: readonly SurfaceSource[] = ['SOURCE', 'CRAWL'];

/**
 * Observed `CoverageItem` rows read back per computation.
 *
 * A cap, because a long-lived project's registry is unbounded and this read
 * happens on every recompute. It is disclosed where it bites AND it disables
 * the retirement sweep, because a partial read of the rows that decide what is
 * still alive is exactly the input that must not be allowed to kill anything.
 */
const MAX_OBSERVED_ITEMS = 20_000;

/** Component rows written per computation. Disclosed when it bites. */
const MAX_COMPONENTS = 5_000;

/**
 * Whether this computation is entitled to retire anything.
 *
 * Pulled out as a function with two named arguments rather than left inline,
 * because it is the single most dangerous boolean in this file and the second
 * arm of it is otherwise untestable: `observed.truncated` needs
 * MAX_OBSERVED_ITEMS + 1 stored rows to become true, which no unit test should
 * have to build.
 *
 * Both arms are the same rule. Retirement means "every item this computation
 * did not see is gone", and that sentence is a catastrophe over a partial
 * union: a FAILED declarer means its surfaces are missing rather than retired,
 * and a capped registry read means some live rows were never re-seen. Either
 * way the sweep would retire surfaces that exist and the coverage percentage
 * would RISE with nothing tested.
 *
 * Skipping is the safe failure. A stale row that should have been retired
 * lowers the percentage and stays visible; a retired row that should not have
 * been raises it and vanishes.
 */
export function mayRetireItems(input: {
  /**
   * Whether every declarer that feeds this sweep's input was read.
   *
   * `SurfaceInventory.complete` for the registry. For the component inventory
   * it is `true` by construction — the source reader is that table's only
   * declarer — so there the second argument is the whole question.
   *
   * Three-valued: NULL means nobody accounted for the declarers, which is not
   * the same as "all of them loaded".
   */
  unionComplete: boolean | null;
  /** True when the read that produced the seen-set hit its cap. */
  readTruncated: boolean;
}): boolean {
  // `=== true` and not truthiness: NULL means the union did not account for
  // which declarers were asked, which is not permission.
  return input.unionComplete === true && !input.readTruncated;
}

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
  /**
   * The union's own accounting: which declarers were asked, whether it is
   * complete, what was held out of the division, and what the suite knows that
   * no declarer did.
   *
   * On the result rather than only in the snapshot's caveats, so a screen can
   * render "declared by 3 of 8 declarers; 1 failed" as structure instead of
   * matching prose.
   *
   * OPTIONAL, and absent means something specific rather than nothing.
   * `ComputedCoverage` is not only this function's return type — it is the
   * contract `ComputeCoverageFn` in apps/worker names, and the worker loads
   * `computeCoverage` by dynamic import ACROSS a package boundary, so the
   * implementation answering may be an older build of the API or a test's
   * stand-in. Absent is therefore "the implementation that answered did not
   * report this", which is true and checkable; required would have made this
   * field a claim about an implementation we do not control. `computeCoverage`
   * itself always sets it.
   */
  inventory?: {
    participation: ReturnType<typeof buildSurfaceInventory>['participation'];
    complete: boolean | null;
    partialBecause: string[];
    heldOut: { unexercisable: number; refused: number };
    reverse: ReturnType<typeof buildSurfaceInventory>['reverse'];
  };
  /**
   * One `ReconciliationReport` per axis in `RECONCILE_AXES`, carrying the
   * product's headline sentence, the crawl's recall as a ratio, and the
   * population estimate (usually UNPROVEN, on purpose).
   *
   * Optional for the same reason as `inventory` above.
   */
  reconciliation?: ReconciliationReport[];
  /**
   * The component inventory this computation wrote and read back. Optional for
   * the same reason as `inventory` above.
   */
  components?: ComponentInventory;
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
async function loadAnalysis(projectId: string): Promise<{
  analysis: CodebaseAnalysis | null;
  analysisId: string | null;
  /**
   * What happened when the repo was asked. Three answers and not two.
   *
   * NOT_CONFIGURED is "no snapshot exists": the customer never connected a
   * repository, and the union is entitled to nothing from it. FAILED is "a
   * snapshot exists and its Json could not be read", which is a hole with a
   * known shape and an unknown size — every route that analysis declared is
   * now missing, and reading it as "declared nothing" would shrink the
   * denominator and raise the percentage. The old return conflated them into
   * one null.
   */
  asked: SurfaceSourceAsked;
}> {
  const snapshot = await prisma.codebaseSnapshot.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, analysis: true },
  });
  if (!snapshot) {
    return {
      analysis: null,
      analysisId: null,
      asked: {
        source: 'SOURCE',
        participation: 'NOT_CONFIGURED',
        detail: 'no codebase snapshot exists for this project — the repository was never ingested',
      },
    };
  }
  // The column is Json written by an older shape than the types describe, so
  // it is read defensively — the same rule coverage.ts applies to flow maps.
  const analysis = snapshot.analysis as unknown;
  if (!analysis || typeof analysis !== 'object' || !('routes' in analysis)) {
    return {
      analysis: null,
      analysisId: snapshot.id,
      asked: {
        source: 'SOURCE',
        participation: 'FAILED',
        detail: `codebase snapshot ${snapshot.id} exists but its stored analysis has no readable \`routes\`, so every surface it declared is missing from this denominator`,
      },
    };
  }
  const read = analysis as CodebaseAnalysis;
  return {
    analysis: read,
    analysisId: snapshot.id,
    asked: {
      source: 'SOURCE',
      participation: 'LOADED',
      detail: `codebase snapshot ${snapshot.id}: ${read.routes.length} route(s), ${read.endpoints.length} endpoint(s), ${read.forms.length} form(s), ${read.authSurfaces.length} auth surface(s)`,
    },
  };
}

/** Latest crawl only: an older version describes an app that no longer exists. */
async function loadFlowMap(projectId: string): Promise<{
  flowMap: FlowMap | null;
  version: number | null;
  /** Same three answers as `loadAnalysis`, for the same reason. */
  asked: SurfaceSourceAsked;
}> {
  const row = await prisma.flowMap.findFirst({
    where: { projectId },
    orderBy: { version: 'desc' },
    select: { graph: true, version: true },
  });
  if (!row) {
    return {
      flowMap: null,
      version: null,
      asked: {
        source: 'CRAWL',
        participation: 'NOT_CONFIGURED',
        detail: 'nothing has crawled this application, so no item is confirmed reachable',
      },
    };
  }
  const graph = row.graph as unknown;
  if (!graph || typeof graph !== 'object' || !('nodes' in graph)) {
    return {
      flowMap: null,
      version: row.version,
      asked: {
        source: 'CRAWL',
        participation: 'FAILED',
        detail: `flow map v${row.version} exists but its stored graph has no readable \`nodes\`, so every route it reached is missing from this denominator`,
      },
    };
  }
  const read = graph as FlowMap;
  return {
    flowMap: read,
    version: row.version,
    asked: {
      source: 'CRAWL',
      participation: 'LOADED',
      detail: `flow map v${row.version}: ${read.nodes.length} node(s) reached${read.truncatedReason ? `, stopped early (${read.truncatedReason})` : ''}`,
    },
  };
}

/**
 * Items written by a declarer this computation does not compute.
 *
 * THE SEAM THAT WOULD HAVE CORRUPTED THE NUMBER. Traffic ingest and recorded
 * sessions write `CoverageItem` rows with TRAFFIC and MANUAL in `sources`, and
 * an OpenAPI ingest will write OPENAPI. None of those is derivable from a
 * `CodebaseSnapshot` or a `FlowMap`, so `buildSurfaceInventory` cannot produce
 * them — and the retirement sweep would then declare every one of them gone on
 * the next recompute. Reading them back as `observed` is what makes the union
 * eight declarers wide instead of two.
 *
 * Rows whose declarers are ONLY the two this computation derives itself are
 * skipped: re-feeding a SOURCE-declared row would make the inventory's own
 * extraction unfalsifiable, because a route the repo stopped declaring would be
 * kept alive for ever by its own stored copy.
 */
async function loadObservedItems(projectId: string): Promise<{
  items: SurfaceItem[];
  /** Declarers found on those rows, for the participation report. */
  declarers: SurfaceSource[];
  /** True when MAX_OBSERVED_ITEMS bit. Disables the retirement sweep. */
  truncated: boolean;
  /** Rows read, so the cap's cost is a count and not an adjective. */
  read: number;
}> {
  const rows = await prisma.coverageItem.findMany({
    /*
     * `Prisma.DbNull` and not `null`. The column is `Json?`, so SQL NULL (the
     * declarer list was never written) and JSON `null` (it was written as the
     * literal null) are different stored values — `api-surface.ts` argues the
     * same distinction on the write side. Filtering on `null` is a type error
     * precisely because Prisma refuses to guess which one was meant.
     */
    where: { projectId, retiredAt: null, sources: { not: Prisma.DbNull } },
    orderBy: { key: 'asc' },
    take: MAX_OBSERVED_ITEMS + 1,
    select: {
      kind: true,
      key: true,
      label: true,
      file: true,
      line: true,
      origin: true,
      evidence: true,
      detector: true,
      meta: true,
      sources: true,
      exercisability: true,
      unexercisableReason: true,
      refusedByRule: true,
      exerciseDetail: true,
      environmentId: true,
      coordinates: true,
    },
  });

  const truncated = rows.length > MAX_OBSERVED_ITEMS;
  const page = truncated ? rows.slice(0, MAX_OBSERVED_ITEMS) : rows;
  const items: SurfaceItem[] = [];
  const declarers = new Set<SurfaceSource>();

  for (const row of page) {
    // ABSENT must stay absent rather than becoming []. `sources: { not: null }`
    // above filters most of it out, but a row holding a non-array Json is a
    // row whose declarers were never recorded, and `[]` would make
    // `originFromSources` return null for an item that has a stored origin.
    const stored = Array.isArray(row.sources) ? (row.sources as SurfaceSource[]) : undefined;
    if (!stored) continue;
    const valid = stored.filter((source): source is SurfaceSource =>
      SURFACE_SOURCES.includes(source),
    );
    if (valid.length === 0) continue;
    // Nothing but the two we derive: skip, or the extractor can never retract.
    if (valid.every((source) => DECLARERS_COMPUTED_HERE.includes(source))) continue;

    for (const source of valid) declarers.add(source);
    items.push({
      kind: row.kind as SurfaceKind,
      key: row.key,
      label: row.label,
      file: row.file,
      line: row.line,
      origin: row.origin as SurfaceItem['origin'],
      evidence: row.evidence,
      detector: row.detector,
      ...(row.meta && typeof row.meta === 'object'
        ? { meta: row.meta as Record<string, unknown> }
        : {}),
      sources: valid,
      /*
       * Absent when nothing classified it, so `exercisabilityCounts` keeps the
       * row IN the denominator. A null read as REFUSED would drop it, and
       * dropping rows raises the percentage.
       */
      ...(row.exercisability
        ? {
            exercise: {
              state: row.exercisability as SurfaceExercisability,
              // The column is TEXT with the domain enforced at the producer —
              // the established house pattern. Null stays null: "UNEXERCISABLE
              // with no reason recorded" is a real stored state and inventing
              // DESTRUCTIVE for it would be a motive we made up.
              reason: row.unexercisableReason as UnexercisableReason | null,
              rule: row.refusedByRule,
              detail: row.exerciseDetail ?? 'recorded with no detail',
            },
          }
        : {}),
      environmentId: row.environmentId,
      ...(Array.isArray(row.coordinates)
        ? { coordinates: row.coordinates as unknown as SurfaceItem['coordinates'] }
        : {}),
    });
  }

  return { items, declarers: [...declarers], truncated, read: page.length };
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

// ─── The sentence the whole product is sold on ───────────────────────────────

/**
 * "SOURCE declare 412 routes; CRAWL reached 25 of them (6%), and reached 1 more
 * that no source declares."
 *
 * `reconcileSurface` assembles that sentence and the arithmetic under it, and
 * until this call site existed it was a pure function reachable from nothing
 * but its own test — which is this codebase's signature defect and the reason
 * step 7 of this round exists. The union above already holds both sides, so the
 * only work here is projecting the items back into per-declarer entry lists.
 *
 * PER AXIS, ONE CALL EACH. `reconcileSurface` takes one axis per call because
 * an endpoint's identity includes a verb and a route's does not; mixing them
 * means either endpoints lose their method (so `GET /users` and `DELETE /users`
 * become one surface) or routes gain a fake one. That is its own header's
 * argument and this caller obeys it rather than flattening.
 *
 * THE PROJECTION IS LOSSY IN ONE DIRECTION AND THAT IS STATED. The union stores
 * the declarer SET per item, not each declarer's own verbatim spelling — so the
 * `spelling` handed back is the canonical identity, and `reconcileSurface`'s
 * `declaredAs`/`reachedAs` audit rows will show our canonical form rather than
 * the string each reader actually read. The readers that keep their verbatim
 * spelling (`RouteManifest.declaredAs`) should be passed to `reconcileSurface`
 * directly by the enumerate orchestrator when it exists; this call is the
 * registry-derived version, which is strictly weaker on audit and strictly
 * correct on arithmetic.
 */
function reconcileFromInventory(input: {
  projectId: string;
  environmentId: string;
  inventory: SurfaceInventory;
}): { reports: ReconciliationReport[]; caveats: string[] } {
  const { projectId, environmentId, inventory } = input;
  const caveats: string[] = [];
  let droppedForEnvironment = 0;

  const reports = RECONCILE_AXES.map((axis: ReconcileAxis) => {
    const kind: SurfaceKind = axis === 'ROUTE' ? 'ROUTE' : 'ENDPOINT';
    const mine = inventory.items.filter((item) => {
      if (item.kind !== kind) return false;
      /*
       * THE ENVIRONMENT GATE, APPLIED PER ITEM.
       *
       * `ReconcileSourceInput` carries one environment per declarer, so a
       * declarer holding items from two environments cannot be expressed there
       * — and handing the request's environment to all of them would smuggle a
       * staging observation into a production reconciliation, where it turns
       * staging-only routes into uncovered production gaps. That is the defect
       * `selectFlowMap` exists to prevent for flow maps.
       *
       * Null passes: a declaration is environment-independent, and a row
       * written before the column existed states no environment rather than
       * stating the wrong one.
       */
      if (item.environmentId && item.environmentId !== environmentId) {
        droppedForEnvironment += 1;
        return false;
      }
      return true;
    });

    /** Entries per declarer, from the set each item carries. */
    const byDeclarer = new Map<SurfaceSource, ReconcileEntry[]>();
    for (const item of mine) {
      const identity = item.key.slice(`${kind}:`.length);
      const entry: ReconcileEntry =
        axis === 'ROUTE'
          ? { spelling: identity }
          : {
              /*
               * On the ENDPOINT axis `spelling` is the PATH ALONE and the verb
               * rides on `method` — splitting it here rather than handing over
               * `"GET /users"`, because `normaliseEntry` would otherwise have
               * to parse a verb out of a path and would guess for every path
               * whose first segment happens to be a word like `post`.
               */
              spelling: identity.slice(identity.indexOf(' ') + 1),
              method: identity.slice(0, identity.indexOf(' ')) || null,
            };
      for (const source of item.sources ?? []) {
        const list = byDeclarer.get(source) ?? [];
        list.push(entry);
        byDeclarer.set(source, list);
      }
    }

    const sources: ReconcileSourceInput[] = inventory.participation.map((contribution) => ({
      source: contribution.source,
      participation: contribution.participation,
      detail: contribution.detail,
      entries: byDeclarer.get(contribution.source) ?? [],
      /*
       * The entries above are already filtered to THIS environment, so every
       * observed source is declared as being of it. `reconcileSurface` applies
       * its own gate on top, which is now a no-op here by construction rather
       * than by coincidence — and a declaration passes null, because it is
       * environment-independent.
       */
      environmentId:
        contribution.source === 'CRAWL' || contribution.source === 'TRAFFIC'
          ? environmentId
          : null,
    }));

    return reconcileSurface({ projectId, environmentId, axis, sources });
  });

  if (droppedForEnvironment > 0) {
    caveats.push(
      `${droppedForEnvironment} observed item${droppedForEnvironment === 1 ? ' was' : 's were'} recorded in a different environment from the one reconciled (${environmentId}) and were excluded from the comparison rather than merged into it. A staging observation is not a weaker observation of production; merging it would turn staging-only surfaces into uncovered production gaps.`,
    );
  }

  return { reports, caveats };
}

// ─── The component inventory ─────────────────────────────────────────────────

/**
 * What this computation knows about the application's components.
 *
 * THE DENOMINATOR THAT HAD NO HOME. `analysis.components` is produced by the
 * source reader and was stored nowhere, so "your repo declares 148 components,
 * 37 of which render a loading, empty or error state nothing covers" could not
 * be said — and `check:wiring` correctly reported `ComponentItem` and
 * `ComponentState` as schema entries for a feature that did not exist.
 *
 * `measured` is the field that keeps this honest. `analysis.components` is
 * OPTIONAL: absent means the snapshot predates the component reader and `[]`
 * means the reader ran and the application declares none. Reading absent as
 * `[]` would report "this project has no components" about a project nobody
 * looked at, AND would retire the whole stored inventory on the first recompute
 * after a deploy. So absent writes nothing and says so.
 */
export interface ComponentInventory {
  /** False when the analysis predates the component reader. Then every count is null. */
  measured: boolean;
  /** Components stored, excluding the kinds already counted on another axis. */
  own: number | null;
  /**
   * Components whose kind is ALREADY counted on another axis — a PAGE or a
   * LAYOUT, which are on ROUTE.
   *
   * Counted apart rather than added, because adding them to a denominator that
   * already holds their route counts one surface twice, which is the defect
   * `componentHasOwnAxis` exists to prevent.
   */
  onAnotherAxis: number | null;
  /** States stored across all of them. */
  states: number | null;
  /** States that are not the happy path — the ones worth a test. */
  nonHappyPathStates: number | null;
  /**
   * State rows whose `coverageItemKey` names no registry row.
   *
   * The dangling reference that model's own doc comment asks for: the key is
   * TEXT and not a foreign key precisely so the two passes can run in either
   * order, and the price of that is that a key with no row has to be REPORTED
   * rather than enforced. Null when nothing was measured.
   */
  danglingRegistryKeys: number | null;
  /** True when MAX_COMPONENTS bit. The counts above are then a floor. */
  truncated: boolean;
  caveats: string[];
}

const NOT_MEASURED: Omit<ComponentInventory, 'caveats'> = {
  measured: false,
  own: null,
  onAnotherAxis: null,
  states: null,
  nonHappyPathStates: null,
  danglingRegistryKeys: null,
  truncated: false,
};

async function persistComponents(input: {
  orgId: string;
  projectId: string;
  components: readonly SourceComponent[] | undefined;
  /** False for a dry-run gate: compute the counts, write nothing. */
  persist: boolean;
}): Promise<ComponentInventory> {
  const { orgId, projectId, components, persist: write } = input;

  if (components === undefined) {
    return {
      ...NOT_MEASURED,
      caveats: [
        'This project’s source analysis predates the component reader, so nothing is known about its components or their loading, empty and error states. That is not a finding that it has none — re-ingest the repository to find out.',
      ],
    };
  }

  const caveats: string[] = [];
  const truncated = components.length > MAX_COMPONENTS;
  const page = truncated ? components.slice(0, MAX_COMPONENTS) : components;
  if (truncated) {
    caveats.push(
      `The source analysis declared ${components.length} components and the first ${MAX_COMPONENTS} were stored, so at least ${components.length - MAX_COMPONENTS} more exist. Every count below is a floor.`,
    );
  }

  /*
   * PAGE and LAYOUT are stored like every other component — they are real
   * exports with real states — but they are counted apart, because their own
   * existence is already in the denominator on the ROUTE axis.
   * `componentHasOwnAxis` is the single place that decision lives.
   */
  const onAnotherAxis = page.filter(
    (component) => componentHasOwnAxis(component.kind) !== null,
  ).length;

  const stateRows = page.flatMap((component) =>
    component.states.map((state) => ({ component, state })),
  );
  const nonHappyPathStates = stateRows.filter(({ state }) =>
    NON_HAPPY_PATH_STATES.includes(state.kind),
  ).length;

  if (!write) {
    caveats.push(
      'This was a dry-run computation, so the component inventory was counted from the analysis and not stored. The dangling-registry-key count is therefore unknown rather than zero.',
    );
    return {
      measured: true,
      own: page.length - onAnotherAxis,
      onAnotherAxis,
      states: stateRows.length,
      nonHappyPathStates,
      danglingRegistryKeys: null,
      truncated,
      caveats,
    };
  }

  // Upserted in chunks for the same reason the registry is: a few thousand
  // independent rows must not hold one write transaction open, and a partial
  // write leaves a consistent inventory the next computation completes.
  const CHUNK = 100;
  const seenComponentIds: string[] = [];
  const stateKeys: string[] = [];

  for (let offset = 0; offset < page.length; offset += CHUNK) {
    const chunk = page.slice(offset, offset + CHUNK);
    const written = await prisma.$transaction(
      chunk.map((component) => {
        const data = {
          orgId,
          projectId,
          kind: component.kind,
          propsSummary: component.propsSummary,
          /*
           * THREE STATES, PRESERVED. `hasCatalogueEntry` is `boolean | null`
           * and the null is load-bearing: null means NO CATALOGUE WAS READ,
           * false means one was and this component is not in it. `?? false`
           * here would claim "nothing is in Storybook" about a project whose
           * Storybook we never looked for.
           */
          hasCatalogueEntry: component.hasCatalogueEntry,
          catalogueRef: component.catalogueRef,
          evidence: component.evidence,
          detector: 'source-components',
          // Re-seeing a retired component un-retires the SAME row, so its
          // history survives. Same rule as the registry.
          retiredAt: null,
        };
        return prisma.componentItem.upsert({
          where: {
            projectId_modulePath_exportName: {
              projectId,
              modulePath: component.modulePath,
              exportName: component.exportName,
            },
          },
          create: {
            ...data,
            modulePath: component.modulePath,
            exportName: component.exportName,
          },
          update: data,
          select: { id: true, modulePath: true, exportName: true },
        });
      }),
    );

    const states = written.flatMap((row) => {
      const component = chunk.find(
        (candidate) =>
          candidate.modulePath === row.modulePath && candidate.exportName === row.exportName,
      );
      seenComponentIds.push(row.id);
      return (component?.states ?? []).map((state) => {
        const key = surfaceKey(
          'COMPONENT_STATE',
          componentStateIdentity(row.modulePath, row.exportName, state.kind),
        );
        stateKeys.push(key);
        return prisma.componentState.upsert({
          where: {
            componentId_kind: { componentId: row.id, kind: state.kind as ComponentStateKind },
          },
          create: {
            orgId,
            componentId: row.id,
            kind: state.kind as ComponentStateKind,
            source: state.source,
            evidence: state.evidence,
            // Written even though no registry row exists yet: the column is
            // TEXT and not an FK precisely so the order of the two passes is
            // not load-bearing, and the price is that a key with no row has to
            // be reported. It is, below.
            coverageItemKey: key,
            retiredAt: null,
          },
          update: {
            source: state.source,
            evidence: state.evidence,
            coverageItemKey: key,
            retiredAt: null,
          },
        });
      });
    });
    if (states.length > 0) await prisma.$transaction(states);
  }

  /*
   * Retire what the reader stopped finding — never delete, and only over a
   * complete read.
   *
   * THE SAME GATE AS THE REGISTRY, through the same function, because it is the
   * same rule: a sweep means "everything not seen is gone", and over a capped
   * read that retires components the cap simply hid. `unionComplete` is true
   * here and not a variable: the source reader is this table's only declarer,
   * and if it ran at all (`components !== undefined`, checked above) it saw
   * everything it was going to see.
   */
  if (mayRetireItems({ unionComplete: true, readTruncated: truncated })) {
    await prisma.componentItem.updateMany({
      where: { projectId, id: { notIn: seenComponentIds }, retiredAt: null },
      data: { retiredAt: new Date() },
    });
  }

  /*
   * READ BACK FROM STORAGE, not counted from the input.
   *
   * The product sentence is "your repository declares 148 components and 37
   * non-happy-path states, here they are" — a claim about rows a customer can
   * query. Counting the in-memory analysis instead would answer "what we
   * intended to store", which is the same number right up to the first write
   * that silently did nothing, and then it is the one number nobody can check.
   *
   * It is also what makes the dangling-reference count real.
   * `ComponentState.coverageItemKey` is TEXT and not a foreign key, on purpose,
   * so the order of the registry pass and the component pass is not
   * load-bearing — and the price of that choice is that a key with no row must
   * be REPORTED. Today that is every key, because nothing mints a
   * `COMPONENT_STATE` registry item: `MEASURED_SURFACE_KINDS` does not list the
   * axis, and widening it before rows exist would enter the headline as 0/0,
   * make `coveragePercent` return null, and have the report claim to measure
   * component states while showing nothing. The count is the honest statement
   * of that gap rather than a silence.
   */
  const stored = await prisma.componentItem.findMany({
    where: { projectId, retiredAt: null },
    select: {
      kind: true,
      states: { select: { kind: true, coverageItemKey: true } },
    },
  });

  const storedOnAnotherAxis = stored.filter(
    (row) => componentHasOwnAxis(row.kind) !== null,
  ).length;
  const storedStates = stored.flatMap((row) => row.states);
  const storedNonHappyPath = storedStates.filter((state) =>
    NON_HAPPY_PATH_STATES.includes(state.kind),
  ).length;

  const wanted = storedStates
    .map((state) => state.coverageItemKey)
    .filter((key): key is string => typeof key === 'string' && key.length > 0);
  const present = wanted.length
    ? await prisma.coverageItem.findMany({
        where: { projectId, key: { in: wanted } },
        select: { key: true },
      })
    : [];
  const presentKeys = new Set(present.map((row) => row.key));
  const dangling = wanted.filter((key) => !presentKeys.has(key)).length;

  const own = stored.length - storedOnAnotherAxis;
  if (storedStates.length > 0) {
    caveats.push(
      `The source declares ${own} component${own === 1 ? '' : 's'} on their own axis${storedOnAnotherAxis > 0 ? ` (plus ${storedOnAnotherAxis} page${storedOnAnotherAxis === 1 ? '' : 's'} or layout${storedOnAnotherAxis === 1 ? '' : 's'} already counted as routes)` : ''} with ${storedStates.length} named state${storedStates.length === 1 ? '' : 's'}, ${storedNonHappyPath} of which ${storedNonHappyPath === 1 ? 'is' : 'are'} not the happy path. They are stored and queryable; they are NOT in the coverage denominator, because COMPONENT_STATE is not a measured axis yet — so this is an enumeration, not a percentage.`,
    );
  }
  if (dangling > 0) {
    caveats.push(
      `${dangling} component state${dangling === 1 ? '' : 's'} name a registry key that has no row, because nothing mints COMPONENT_STATE items yet. That is a dangling reference in our own data and it is counted rather than hidden.`,
    );
  }

  return {
    measured: true,
    own,
    onAnotherAxis: storedOnAnotherAxis,
    states: storedStates.length,
    nonHappyPathStates: storedNonHappyPath,
    danglingRegistryKeys: dangling,
    truncated,
    caveats,
  };
}

// ─── Computing ───────────────────────────────────────────────────────────────

export async function computeCoverage(options: ComputeOptions): Promise<ComputedCoverage> {
  const { orgId, projectId } = options;

  const [
    { analysis, analysisId, asked: sourceAsked },
    { flowMap, version, asked: crawlAsked },
    observed,
    tests,
    executions,
    waivers,
  ] = await Promise.all([
    loadAnalysis(projectId),
    loadFlowMap(projectId),
    loadObservedItems(projectId),
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

  const coverageInputs = toCoverageInputs(tests);

  /*
   * Every declarer, and what happened when it was asked.
   *
   * The two this file computes carry their real answer from the loaders above.
   * The six that write rows directly are reported LOADED when their rows came
   * back and NOT_CONFIGURED otherwise — and `NOT_CONFIGURED`'s detail says
   * plainly that it is a statement about this computation's bookkeeping rather
   * than a reading of the customer's application, because a traffic connector
   * that failed to sync and one that was never set up both leave no rows and
   * only the first is a hole. Closing that gap needs the ingest to record its
   * own participation, which is named in the open problems rather than guessed
   * at here.
   */
  const participation: SurfaceSourceAsked[] = [
    sourceAsked,
    crawlAsked,
    ...SURFACE_SOURCES.filter((source) => !DECLARERS_COMPUTED_HERE.includes(source)).map(
      (source): SurfaceSourceAsked =>
        observed.declarers.includes(source)
          ? {
              source,
              participation: 'LOADED',
              detail: `${observed.items.filter((item) => (item.sources ?? []).includes(source)).length} stored registry row(s) name it as a declarer`,
            }
          : {
              source,
              participation: 'NOT_CONFIGURED',
              detail:
                'no stored registry row names this declarer. This computation cannot tell "never set up" from "ran and failed" — the ingest that writes the rows is the only thing that knows',
            },
    ),
  ];

  const inventory = buildSurfaceInventory({
    analysis,
    flowMap,
    observed: observed.items,
    participation,
    tests: coverageInputs,
  });
  const result = analyseSurfaceCoverage({
    items: inventory.items,
    tests: coverageInputs,
    executions,
    waivers,
  });

  // Both sets of caveats, inventory first: what the denominator is made of
  // comes before what the division could not see.
  const caveats = [...inventory.caveats, ...result.caveats];

  /*
   * The component inventory, written and read back.
   *
   * `analysis.components` is the UNIT_GEN denominator — "your repo declares 148
   * components, 37 of which render a non-happy-path state nothing covers" — and
   * it is OPTIONAL on `CodebaseAnalysis`: absent means this snapshot predates
   * the component reader, and `[]` means the reader ran and found none. The two
   * are reported differently, and absent writes nothing at all rather than
   * retiring an install's whole component inventory on the first recompute
   * after a deploy.
   */
  const components = await persistComponents({
    orgId,
    projectId,
    components: analysis?.components,
    persist: options.persist !== false,
  });
  caveats.push(...components.caveats);

  /*
   * The reconciliation, per axis, and its headline.
   *
   * The environment is the flow map's, because that is the only environment
   * this computation has an observation FROM. With no crawl there is nothing
   * observed to reconcile against, so the environment is irrelevant and the
   * report says plainly that no reach can be reported — not 0% reached, which
   * would be a measurement.
   */
  const { reports: reconciliation, caveats: reconcileCaveats } = reconcileFromInventory({
    projectId,
    environmentId: flowMap?.environmentId ?? 'unknown',
    inventory,
  });
  caveats.push(...reconcileCaveats);
  for (const report of reconciliation) {
    // The headline is the product's own sentence and belongs beside the number
    // it describes, not in a tooltip. One per axis, each naming its axis.
    caveats.push(`${report.axis}: ${report.headline}`);
    caveats.push(...report.caveats);
  }

  if (observed.truncated) {
    caveats.push(
      `The registry read for declarers this computation does not derive was capped at ${MAX_OBSERVED_ITEMS} rows, so at least one more exists. Retirement was skipped for this run: a partial read of the rows that decide what is still alive must not be allowed to retire anything.`,
    );
  }

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
    snapshotId = await persist({
      orgId,
      projectId,
      entries: result.entries,
      snapshot,
      /*
       * THE GATE ON THE SWEEP. Retirement means "every item this computation
       * did not see is gone", and that is only true when the union saw
       * everything. A FAILED declarer or a capped registry read both mean it
       * did not, and sweeping anyway would retire live surfaces and raise the
       * percentage — see decision 4 in this file's header.
       */
      mayRetire: mayRetireItems({
        unionComplete: inventory.complete,
        readTruncated: observed.truncated,
      }),
    });
    snapshot.id = snapshotId;
  }

  return {
    entries: result.entries,
    uncovered: rankUncovered(result.entries),
    snapshot,
    unmeasuredKinds: missingAxes(),
    snapshotId,
    inventory: {
      participation: inventory.participation,
      complete: inventory.complete,
      partialBecause: inventory.partialBecause,
      heldOut: inventory.heldOut,
      reverse: inventory.reverse,
    },
    reconciliation,
    components,
  };
}

// ─── Writing ─────────────────────────────────────────────────────────────────

async function persist(input: {
  orgId: string;
  projectId: string;
  entries: SurfaceItemCoverage[];
  snapshot: SurfaceSnapshot;
  /** False when the union was partial. See decision 4 in the header. */
  mayRetire: boolean;
}): Promise<string> {
  const { orgId, projectId, entries, snapshot, mayRetire } = input;
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
        /*
         * `sources` and the four exercise columns, which this write used to
         * drop on the floor.
         *
         * The inconsistency that caused: for a route declared in source AND
         * seen in traffic, the inventory produced `sources: ['SOURCE','TRAFFIC']`
         * and `origin: 'BOTH'`, this upsert wrote the origin and not the
         * sources, and the next recompute read the row back with no declarers
         * and re-derived SOURCE_ONLY. One row, two answers, and only one of
         * them on screen. `origin` stays derived — `buildSurfaceInventory`
         * computes it from `sources` with `originFromSources` and this file
         * does not get a second opinion.
         *
         * `exercisability` absent stays absent (Prisma `undefined` leaves the
         * column alone, `null` clears it): an item nobody classified must read
         * back as unclassified, which `exercisabilityCounts` deliberately
         * COUNTS. Writing null for absent would be the same lie in a different
         * column.
         */
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
          sources: (item.sources ?? []) as unknown as Prisma.InputJsonValue,
          exercisability: item.exercise?.state ?? null,
          unexercisableReason: item.exercise?.reason ?? null,
          refusedByRule: item.exercise?.rule ?? null,
          exerciseDetail: item.exercise?.detail ?? null,
          environmentId: item.environmentId ?? null,
          coordinates: (item.coordinates ?? []) as unknown as Prisma.InputJsonValue,
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

  /*
   * Retire, never delete — and only when the union was complete.
   *
   * See decision 4 in the header. `notIn: seenKeys` is "everything this
   * computation did not see", and that is the right sweep over a complete
   * union and a catastrophe over a partial one: a failed source read or a
   * capped registry read would retire every live surface the missing declarer
   * owned, and the coverage percentage would rise with nothing tested.
   *
   * Skipping is the safe failure. A stale row that should have been retired
   * lowers the percentage and stays visible; a retired row that should not have
   * been raises it and vanishes.
   */
  if (mayRetire) {
    await prisma.coverageItem.updateMany({
      where: { projectId, key: { notIn: seenKeys }, retiredAt: null },
      data: { retiredAt: new Date() },
    });
  }

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
