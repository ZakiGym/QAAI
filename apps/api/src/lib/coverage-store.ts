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
  ComparabilityInput,
  ComponentStateKind,
  CoverageAttestation,
  CoverageDimensionKind,
  CoverageLadder,
  DialectId,
  DimensionCapBite,
  DimensionUnmeasuredReason,
  FlowMap,
  FormField,
  SourceComponent,
  SourceFormField,
  SurfaceExercisability,
  SurfaceItem,
  SurfaceItemCoverage,
  SurfaceKind,
  SurfaceSnapshot,
  SurfaceSource,
  SurfaceWaiver,
  TestType,
  TypeObligationPolicy,
  UnexercisableReason,
} from '@qaai/shared';
import type { DeploymentCapabilityStatus } from '@qaai/shared';
import { NON_HAPPY_PATH_STATES, componentHasOwnAxis, surfaceKey } from '@qaai/shared';
/*
 * The dimension vocabulary, the comparability decision and the write-path
 * schemas.
 *
 * Every one of these is imported rather than restated, and the two that matter
 * most are `snapshotDelta` and the three cell schemas. `snapshotDelta` is the
 * ONE place two snapshots are allowed to be subtracted — a delta across two
 * crawl fingerprints is refused, because subtracting two percentages always
 * succeeds and "coverage fell 9 points" over two different crawls is an
 * artefact of our own enumeration that everybody reads as a regression. The
 * schemas are run against every row BEFORE its upsert, so a reading the
 * database would refuse is refused here with the field named rather than
 * arriving as a constraint violation nobody can read.
 */
import {
  CELL_KIND_DIMENSION,
  COVERAGE_DIMENSIONS,
  HEADLINE_SCOPE_KEY,
  SELF_DEPLOYMENT,
  TEST_TYPES,
  capabilityCounts,
  attestationPayload,
  coverageFormFieldSchema,
  coverageItemStateSchema,
  coverageRollupSchema,
  coverageTypeObligationSchema,
  dimensionWasMeasured,
  resolveDialect,
  snapshotDelta,
  typeObligationPolicySchema,
} from '@qaai/shared';
import {
  DIMENSION_REGISTRY,
  MAX_ROLLUP_ROWS,
  RECONCILE_AXES,
  analyseFieldCoverage,
  analyseSurfaceCoverage,
  buildSurfaceInventory,
  buildTypeObligationMatrix,
  canonicalRoute,
  componentStateIdentity,
  coverageDimensionReport,
  fieldCoverageCellKinds,
  formIdentity,
  missingAxes,
  rankUncovered,
  reconcileSurface,
  resolveTypeObligations,
  rollupCoverage,
  routeFeatureName,
  type ComponentCoverageItem,
  type CoverageDimensionReport,
  type CoverageRollupRow,
  type CoverageTestInput,
  type DeploymentCapabilityFact,
  type DimensionRegistryEntry,
  type FieldCoverageField,
  type FieldCoverageForm,
  type FormFieldCellRow,
  type ItemStateCellRow,
  type ReconcileAxis,
  type ReconcileEntry,
  type ReconcileSourceInput,
  type ReconciliationReport,
  type RollupItem,
  type SurfaceInventory,
  type SurfaceSourceAsked,
  type TestExecutionFact,
  type TypeObligationCell,
  type TypeObligationTotals,
} from '@qaai/agent';
/*
 * THE ONE QUESTION EVERY GATE, COUNTER AND CHECK MUST ASK, imported rather than
 * reimplemented. A null expiry is a quarantine written before expiry existed
 * and is honoured; an expired one gates again. Reading `Test.quarantined`
 * directly here would have made this file the fourth place in the product with
 * its own opinion about whether a suppression is in force.
 */
import { quarantineSuppresses } from '@qaai/runner';
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from './prisma.js';
import { toCoverageInputs } from '../routes/coverage.js';
/*
 * THE ONE OWNERSHIP MATCHER. Imported rather than reimplemented for the same
 * reason `quarantineSuppresses` is: `assignOwner` is what the notify processor,
 * the morning digest and the ticket filer all route through, so the team a
 * rollup bucket names is the team a page would actually reach. A second
 * matcher here would be a second answer to "who owns /checkout", which is the
 * question an unattributed-surface finding exists to make answerable.
 */
import { OWNERSHIP_RULE_SELECT, assignOwner, type OwnershipRuleInput } from './ownership.js';

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
 * THE VERSION OF THE ENUMERATOR THAT PRODUCED THE INVENTORY.
 *
 * Not the application's version and not the crawl's `FlowMap.version` — this is
 * the version of the CODE that decided what counts as a surface. It is required
 * on an attestation because two attestations from different enumerator versions
 * are not comparable even when they agree: a release that starts counting
 * background jobs moves the denominator for reasons that have nothing to do
 * with the customer's application, and a document that does not say which
 * enumerator produced it cannot be checked against a later one.
 *
 * A CONSTANT in this file, and BUMPED BY HAND when the enumeration rules
 * change. Derived alternatives were considered and are all worse: the package
 * version moves on every release including ones that touch nothing here, and a
 * hash of the enumerator's source would change on a comment and make every
 * stored snapshot uncomparable with every other. Bumping it is a reviewed
 * decision, which is what it should be — it invalidates every delta in the
 * product.
 *
 * `enumerate.4` is the fourth enumeration round: the crawl frontier, the five
 * non-crawl declarers, the per-role matrix, and this round's per-cell
 * dimensions. Its natural home is beside `buildSurfaceInventory` in
 * packages/agent, and that move is named in this round's handover rather than
 * done by reaching into a file this slice does not own.
 */
export const CRAWL_VERSION = 'enumerate.4';

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
  /**
   * THE BREAKDOWN BENEATH THE HEADLINE: all thirteen axes, each with its own
   * denominator and NO combined figure.
   *
   * Optional for the same reason as `inventory` above — this is the contract
   * `ComputeCoverageFn` in apps/worker names, and the implementation answering
   * may be an older build. Absent is "the implementation that answered did not
   * report this", which is true and checkable; required would make this field a
   * claim about an implementation we do not control.
   */
  dimensions?: MeasuredDimensions;
  /** The per-scope rollups this computation produced. Headline first. */
  rollups?: CoverageRollupRow[];
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
/**
 * The project's declared type-obligation policy, and nothing inferred.
 *
 * NULLABLE WITH NO DEFAULT, which is the whole design: "this project never
 * thought about which test types its surfaces owe" and "this project chose E2E
 * only" stay distinguishable, and `DEFAULT_TYPE_OBLIGATIONS` owes NOTHING. A
 * default here would mint an obligation per axis per item on the day of the
 * migration — 824 fabricated gaps on a 412-route project — and report QAAI's
 * opinion about what a team should test as the team's debt.
 *
 * A stored shape that does not parse is read as NO POLICY and the failure is
 * disclosed, rather than being partially honoured: half a policy is a
 * denominator the customer did not configure.
 */
/*
 * EXPORTED so there is ONE reader of `Project.typeObligationPolicy` in this
 * app. `GET/PUT /coverage/:projectId/obligations` adjudicates that column and
 * needs exactly this function's two-field answer — a second copy in the route
 * would be a second opinion about what an unparseable policy means, and the
 * whole correctness of that endpoint is that `unreadable` is NOT `null`.
 */
export async function loadTypeObligationPolicy(
  projectId: string,
): Promise<{ policy: TypeObligationPolicy | null; unreadable: boolean }> {
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: { typeObligationPolicy: true },
  });
  const raw = row?.typeObligationPolicy ?? null;
  if (raw === null) return { policy: null, unreadable: false };
  const parsed = typeObligationPolicySchema.safeParse(raw);
  if (!parsed.success) return { policy: null, unreadable: true };
  return { policy: parsed.data, unreadable: false };
}

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
/**
 * The executions, plus whether the quarantine half of them could be read.
 *
 * TWO FIELDS AND NOT ONE, for the usual reason: "no test is quarantined" and
 * "we could not find out which tests are quarantined" produce the same empty
 * set and have opposite consequences. The second one means a suppressed test
 * may be counted as coverage, which moves the number in the FLATTERING
 * direction — so it is reported as a caveat beside the figure rather than
 * being allowed to look like the first.
 */
interface LoadedExecutions {
  facts: TestExecutionFact[];
  /** Null when the read succeeded. The error's message when it did not. */
  quarantineUnavailable: string | null;
  /**
   * The test ids whose quarantine is IN FORCE, as `quarantineSuppresses`
   * answered it.
   *
   * Returned rather than kept local, because the dimension pass needs the same
   * answer and `CoverageTestInput` carries no quarantine column. Re-deriving it
   * there from `Test.quarantined` would be the fourth place in this product
   * with its own opinion about whether a suppression is in force — and an
   * EXPIRED quarantine gates again, which is exactly the case a second
   * implementation gets wrong.
   *
   * EMPTY WHEN THE READ FAILED, which is why `quarantineUnavailable` travels
   * beside it: an empty set means "nothing is suppressed" and that is the
   * flattering answer, so the two fields are read together or not at all.
   */
  suppressed: ReadonlySet<string>;
}

async function loadExecutions(projectId: string): Promise<LoadedExecutions> {
  /*
   * ── THE JOIN THAT WAS MISSING, AND WHAT IT COSTS TO LEAVE IT OUT ──────────
   *
   * `quarantined` and `quarantineExpiresAt` live on Test, not on TestResult, so
   * a query over results alone cannot tell whether the result it just read is
   * one any gate will ever look at. Without them a quarantined test closed a
   * gap here while `packages/runner/src/gates.ts` excluded it from every rule —
   * two screens in one product giving opposite answers about one test.
   *
   * `retriedAndPassed` is on the result and is read for the same round: §5 says
   * a retry pass is not a pass, and it is carried to the ledger rather than used
   * to withhold coverage, because covered-and-flaky are two facts.
   */
  const [results, quarantineRead] = await Promise.all([
    prisma.testResult.findMany({
      where: { test: { projectId } },
      orderBy: { createdAt: 'desc' },
      select: {
        testId: true,
        runId: true,
        status: true,
        createdAt: true,
        retriedAndPassed: true,
      },
      // Bounded: a long-lived project has more results than anyone needs read
      // here, and the newest-first order means the cap only ever drops history.
      take: 20_000,
    }),
    /*
     * FAULT-ISOLATED, because this is a NEW query on an old path.
     *
     * `computeCoverage` is called by the surface route, the gate, the worker
     * and this file's own recompute. A query that one of those callers'
     * environments cannot answer must not take the measurement down — and it
     * must not quietly succeed as an empty set either, because empty means
     * "nothing is suppressed" and that is the flattering answer.
     */
    prisma.test
      .findMany({
        where: { projectId, quarantined: true },
        select: { id: true, quarantined: true, quarantineExpiresAt: true },
      })
      .then((rows) => ({ rows, error: null as string | null }))
      .catch((error: unknown) => ({
        rows: [] as Array<{ id: string; quarantined: boolean; quarantineExpiresAt: Date | null }>,
        error: error instanceof Error ? error.message : String(error),
      })),
  ]);
  const quarantines = quarantineRead.rows;

  /*
   * `quarantineSuppresses`, not `quarantined`. An EXPIRED quarantine gates
   * again, so reading the boolean would keep withholding coverage from a test
   * whose suppression ran out — the number would then be wrong in the
   * pessimistic direction, which is still wrong.
   */
  const now = new Date();
  const suppressed = new Set(
    quarantines.filter((test) => quarantineSuppresses(test, now)).map((test) => test.id),
  );

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
        quarantined: suppressed.has(result.testId),
        retriedAndPassed: result.retriedAndPassed,
      });
      continue;
    }
    // Older rows contribute nothing but history. They may not touch `status`.
    if (result.status === 'PASSED') existing.everPassed = true;
  }

  /*
   * A quarantined test with NO result at all still has to be reported, because
   * "its only test is suppressed" and "its only test has never run" are
   * different findings and the matcher can only tell them apart if the fact
   * reaches it. SKIPPED with no run id is the honest shape: nothing was
   * observed, and the quarantine is why nothing will be.
   */
  for (const id of suppressed) {
    if (latest.has(id)) continue;
    latest.set(id, {
      testId: id,
      runId: '',
      status: 'SKIPPED',
      atIso: new Date(0).toISOString(),
      everPassed: false,
      quarantined: true,
    });
  }
  return {
    facts: [...latest.values()],
    quarantineUnavailable: quarantineRead.error,
    suppressed,
  };
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
    obligationPolicy,
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
    loadTypeObligationPolicy(projectId),
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
    executions: executions.facts,
    waivers,
  });

  // Both sets of caveats, inventory first: what the denominator is made of
  // comes before what the division could not see.
  const caveats = [...inventory.caveats, ...result.caveats];

  if (executions.quarantineUnavailable !== null) {
    /*
     * A CAP THAT BIT, AND IT BIT IN THE FLATTERING DIRECTION.
     *
     * Without the quarantine read, a test whose result every gate suppresses
     * is counted here as ordinary coverage — which is exactly the state this
     * round set out to fix. An empty quarantine set and an unreadable one are
     * the same shape and opposite facts, so the second one says so beside the
     * number rather than looking like the first.
     */
    caveats.push(
      `Quarantine could not be read for this project (${executions.quarantineUnavailable}), so any test whose result the gates suppress has been counted here as ordinary coverage. That makes this percentage a CEILING rather than a measurement: a quarantined test gates nothing, so coverage attributed to it is coverage nothing will ever check.`,
    );
  }

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

  /*
   * ── THE DIMENSIONS, MEASURED BESIDE THE HEADLINE AND NEVER INTO IT ────────
   *
   * The figure above is `result.totals.percent`, and it does not move. This is
   * the breakdown BENEATH it: thirteen axes, each dividing by its own cells.
   * Folding any of them into that denominator would let a project with 40 form
   * fields and 14 routes have its number decided by its forms.
   *
   * WHAT `result.totals.percent` IS NOT: a weighted mean. An earlier version of
   * this comment called it "a weighted mean over ITEMS" and that was false.
   * `totalsForItems` (packages/shared/src/surface.ts) computes it as
   * `coveragePercent(sum(covered), sum(denominator))` over the four
   * MEASURED_SURFACE_KINDS — there is no weight table on that path. It is a
   * ratio of summed incommensurable denominators, which
   * `summedKindPercent`'s doc comment in packages/agent/src/surface-coverage.ts
   * sets out at length, measured: holding ROUTE at 5/10, adding uncovered
   * ENDPOINT rows moves it 50% → 0.5% without the suite changing.
   * `CoverageHeadline` in packages/agent/src/coverage.ts is the figure that has
   * published weights, and it is a DIFFERENT number from this one. Keeping the
   * two straight is the point of this note: the dimensions below are honest
   * about their own denominators, and that is not the same as this field being
   * honest about its.
   *
   * Computed even when `persist` is false, because a dry-run gate needs the
   * same breakdown the stored snapshot carries — a gate that compares a figure
   * computed one way against a stored figure computed another way is a gate
   * that fails for reasons nobody can reproduce.
   */
  /*
   * The capability set, read BEFORE the dimensions, because the TEST_TYPE
   * denominator subtracts from it. A null set supplies no facts at all, which
   * leaves every type NOT_CHECKED and IN the denominator — the conservative
   * direction, and the one that stops a deployment with no preflight shedding
   * obligations it never proved it could run.
   */
  const capabilities = await deploymentCapabilityFacts();
  const dimensions = await measureDimensions({
    projectId,
    analysis,
    flowMap,
    ...(capabilities ? { capabilities: capabilities.facts } : {}),
    items: inventory.items,
    tests: coverageInputs,
    waivers,
    typeObligationPolicy: obligationPolicy.policy,
    quarantined: executions.suppressed,
    /*
     * The dialect, resolved from the FIRST test's path, and NULL when there are
     * no tests. Null is not "assume Playwright": it makes every claim that
     * depends on finding an assertion UNMEASURED rather than absent, which is
     * the conservative direction — a suite we cannot read assertions in must
     * not have its cells scored as covered on no evidence.
     */
    dialect: tests[0] ? resolveDialect({ filePath: tests[0].filePath }) : null,
    nowIso: new Date().toISOString(),
  });
  caveats.push(...dimensions.caveats);
  caveats.push(
    capabilities === null
      ? 'What this deployment can EXECUTE could not be read (the migration that mints DeploymentCapability is not applied here), so every one of the 19 test types is treated as NOT_CHECKED and stays in the coverage denominator. That is the conservative direction: an unprobed type must not be able to shed an obligation it never proved it could run. It must NOT be read as "every type is available".'
      : capabilities.sentence,
  );
  if (obligationPolicy.unreadable) {
    caveats.push(
      "This project's stored type-obligation policy could not be read, so it was treated as NO " +
        'POLICY and the TEST_TYPE denominator is empty rather than partial. Half a policy is a ' +
        'denominator the customer did not configure, and an empty one at least says so.',
    );
  }

  /*
   * ── THE ROLLUPS ──────────────────────────────────────────────────────────
   *
   * Per feature and per team, over the ITEM axis rather than over the cells,
   * and at ONE named rung. The rung is required with no default: a rollup that
   * does not say which bar it cleared is comparable to no other rollup, and two
   * rows silently taken at NAVIGATED and PASSING look identical on screen.
   *
   * ASSERTED is the rung, because it is the weakest one that means a test says
   * something about the item rather than merely reaching it — which is the
   * sentence a team acts on in a PR comment.
   */
  const ownership = await attributeOwnership({ orgId, projectId, entries: result.entries });
  const rollups = rollupCoverage({
    dimension: null,
    tier: 'ASSERTED',
    items: result.entries.map((entry) =>
      rollupItemFor(entry, waivers, ownership.teamByKey.get(entry.item.key) ?? null),
    ),
  });
  caveats.push(...ownership.caveats, rollups.attribution.sentence, rollups.reconciliation.detail);

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
      dimensions,
      rollups: rollups.rows,
      crawlFingerprint: inventory.fingerprint,
      denominatorDefinition: denominatorDefinitionOf(inventory, result.totals.denominator, waivers),
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
    dimensions,
    rollups: rollups.rows,
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
  /** The per-axis breakdown, whose cells go into the three cell tables. */
  dimensions: MeasuredDimensions;
  /** The per-scope rollups. Headline first. */
  rollups: readonly CoverageRollupRow[];
  /** The crawl identity this measurement was taken against. */
  crawlFingerprint: string;
  /** The sentence that says what was divided by. Half of comparability. */
  denominatorDefinition: string;
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
   * ── THE PROVENANCE EDGES ──────────────────────────────────────────────────
   *
   * `CoverageItem.matches` is a JSON blob that is replaced wholesale on every
   * recompute, so it can say WHICH tests cover an item and nothing else: no
   * identity, no history, no record of HOW the link was established, and — the
   * expensive part — no way for a link to be retired with an audit trail
   * instead of simply vanishing. `TestCoverageEdge` is the addressable version
   * of the same fact, and this is its write path.
   *
   * EVERY EDGE THIS FUNCTION WRITES IS `source: 'STATIC'`, TIER `DECLARED`.
   * That is not a placeholder, it is the ceiling: the matcher upstream is a
   * regex over test source, which can prove a string appears in a spec and
   * cannot prove the spec is reachable, enabled, wired into a suite or ever
   * executed. `COVERAGE_EDGE_SOURCE_CEILING` in @qaai/shared's coverage-tiers
   * pins STATIC at DECLARED for exactly that reason, and a writer here that
   * promoted its own edges past it would be the one lie this table exists to
   * prevent. NAVIGATED and above need an instrumentation producer that does not
   * exist anywhere in this product yet.
   *
   * ONE EDGE PER (item, test, STATIC). A RUNTIME or SPEC edge for the same pair
   * is a different row by the unique index and is never touched here —
   * `upsert` and a scoped `retiredAt` sweep, never `deleteMany`, so a producer
   * this function knows nothing about cannot have its rows removed by a
   * recompute of the static ones.
   */
  /*
   * ── FAULT-ISOLATED, AND THE FAILURE IS DISCLOSED ──────────────────────────
   *
   * The migration that mints `TestCoverageEdge` is written and UNAPPLIED in
   * this tree, so the delegate exists on the generated client and the TABLE
   * does not: every statement below throws until somebody deploys. The
   * inventory and the snapshot are the deliverable and are already written, so
   * an unavailable provenance table must cost the AUDIT TRAIL and not the
   * measurement.
   *
   * What it must never do is fail quietly. The reason goes onto the snapshot's
   * own caveats, beside the number, because "we recorded no provenance for this
   * figure" is a fact about how defensible the figure is.
   */
  const edgeWrite = await persistCoverageEdges({ orgId, projectId, entries, seenKeys });
  if (edgeWrite.failed > 0) {
    /*
     * A COUNT AND A REASON, both. A provenance write that quietly missed rows
     * is a provenance table that will later report fewer links than the
     * measurement was built from — and because retirement is skipped on a
     * partial write (see below), it is also a table whose stale rows nobody
     * swept. Neither is something to discover from a dashboard.
     */
    snapshot.caveats.push(
      `Coverage provenance was NOT fully recorded for this snapshot: ${edgeWrite.failed} of ${edgeWrite.attempted} test-to-surface link(s) could not be written (${edgeWrite.firstError ?? 'no error reported'}). The percentage above is unaffected — what is missing is the per-link audit trail that says HOW each test came to be matched to each item, and the history that lets a link be retired rather than silently vanish. Retirement of stale links was skipped for this run, because a partial write followed by "retire everything I did not write" is how an audit trail deletes itself.`,
    );
  }

  /*
   * ── THE CELL TABLES ──────────────────────────────────────────────────────
   *
   * Written AFTER the items, because every cell hangs off a `CoverageItem.id`
   * that the upserts above had to produce first. Fault-isolated and counted for
   * the same reason `persistCoverageEdges` is: the inventory and the snapshot
   * are the deliverable, and an unavailable cell table must cost the BREAKDOWN
   * rather than the measurement.
   */
  const cellWrite = await persistDimensionCells({
    orgId,
    projectId,
    measured: input.dimensions,
  });
  if (cellWrite.failed > 0) {
    snapshot.caveats.push(
      `The per-cell breakdown was NOT fully recorded for this snapshot: ${cellWrite.failed} of ` +
        `${cellWrite.attempted} dimension cell(s) could not be written ` +
        `(${cellWrite.firstError ?? 'no error reported'}). The percentages above are unaffected — ` +
        'they were computed before any of this was stored — and what is missing is the per-cell ' +
        'detail that lets a reader name WHICH form field or WHICH typed obligation is uncovered. ' +
        'Retirement of stale cells was skipped for this run, because a partial write followed by ' +
        '"retire everything I did not write" is how a breakdown deletes itself.',
    );
  }
  if (cellWrite.truncated) {
    snapshot.caveats.push(
      `The dimension cell write stopped at ${MAX_DIMENSION_CELL_WRITES} row(s), so at least one ` +
        'more cell exists than is stored. The MEASUREMENT is over everything the dimension ' +
        'modules measured and is not truncated; what is cut is the stored row list, so the ' +
        'per-cell screens are a lower bound while the percentages are not. Retirement was ' +
        'skipped: sweeping after a cut list would retire exactly the cells this cap hid, and the ' +
        'figure would rise because our own budget bit.',
    );
  }

  const snapshotId = await finishSnapshot({
    orgId,
    projectId,
    snapshot,
    seenKeys,
    mayRetire,
    crawlFingerprint: input.crawlFingerprint,
    denominatorDefinition: input.denominatorDefinition,
  });

  /*
   * ── THE ROLLUPS AND THE HISTORY ROW ──────────────────────────────────────
   *
   * Written LAST, because both hang off the snapshot id, and `previous` is read
   * here rather than passed in so that the comparison is against whatever
   * snapshot was second-newest at the moment this one landed. Reading it
   * earlier would compare against a snapshot a concurrent recompute may
   * already have superseded — and the lane is serialised at concurrency 1 for
   * exactly that reason, so this is a belt to that brace.
   */
  const previous = await prisma.coverageSnapshot.findFirst({
    where: { projectId, id: { not: snapshotId } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      percent: true,
      crawlFingerprint: true,
      denominatorDefinition: true,
    },
  });
  const rollupWrite = await persistRollups({
    orgId,
    projectId,
    snapshotId,
    rows: input.rollups,
    current: {
      crawlFingerprint: input.crawlFingerprint,
      denominatorDefinition: input.denominatorDefinition,
    },
    previous,
  });
  if (rollupWrite.failed > 0) {
    snapshot.caveats.push(
      `${rollupWrite.failed} of ${rollupWrite.attempted} rollup row(s) could not be written ` +
        `(${rollupWrite.firstError ?? 'no error reported'}), so the per-feature and per-team ` +
        'breakdown for this snapshot is incomplete. The headline is unaffected. A rollup that is ' +
        'missing buckets must not be read as a rollup whose buckets are empty.',
    );
  }
  if (rollupWrite.truncated) {
    snapshot.caveats.push(
      `More than ${MAX_ROLLUP_ROWS} rollup buckets exist and only the largest ${MAX_ROLLUP_ROWS} ` +
        'were stored. The headline bucket is never one of the dropped ones, and the dropped count ' +
        'is reported by the rollup itself — "the maths is wrong" and "we only showed you the ' +
        'biggest 500" are different sentences with different remedies.',
    );
  }

  return snapshotId;
}

/**
 * The write path for `TestCoverageEdge` — see the call site for why it is
 * fault-isolated, and the comment there for why every edge it writes is
 * STATIC/DECLARED.
 */
/** What the edge write managed, so a partial one can be disclosed. */
interface CoverageEdgeWriteResult {
  attempted: number;
  written: number;
  failed: number;
  /**
   * The first error's message, which is how a table that does not exist at all
   * is told apart from one row failing a foreign key. The two have the same
   * shape in the counts and completely different remedies.
   */
  firstError: string | null;
}

async function persistCoverageEdges(input: {
  orgId: string;
  projectId: string;
  entries: SurfaceItemCoverage[];
  seenKeys: string[];
}): Promise<CoverageEdgeWriteResult> {
  const { orgId, projectId, entries, seenKeys } = input;
  const edgeRows = await prisma.coverageItem.findMany({
    where: { projectId, key: { in: seenKeys } },
    select: { id: true, key: true },
  });
  const itemIdByKey = new Map(edgeRows.map((row) => [row.key, row.id]));
  const liveTestIds = new Set(
    entries.flatMap((entry) => entry.matches.map((match) => match.testId)),
  );
  const writtenEdgeIds: string[] = [];
  let failed = 0;
  let firstError: string | null = null;

  for (const entry of entries) {
    const itemId = itemIdByKey.get(entry.item.key);
    // An item whose upsert did not land this round (a chunk that failed) has
    // no id to hang an edge off. Skipping is correct: the next recompute
    // writes both, and a half-written edge pointing at nothing is worse.
    if (itemId === undefined) continue;
    for (const match of entry.matches) {
      if (!liveTestIds.has(match.testId)) continue;
      const data = {
        orgId,
        projectId,
        tier: 'DECLARED' as const,
        /*
         * The reason the tier is not higher, in the row, so a reader does not
         * have to know the ceiling table to interpret a wall of DECLARED.
         */
        cappedBy: 'STATIC_EVIDENCE_ONLY',
        /*
         * Confidence BY HOW THE MATCH WAS MADE, under STATIC's 0.8 ceiling
         * which `testCoverageEdgeSchema` enforces. A route literal read
         * verbatim out of a spec and a four-character field name found
         * somewhere in a file are not the same evidence, and collapsing them
         * to one number is what makes a generous matcher indistinguishable
         * from a strict one.
         */
        confidence: match.basis === 'LITERAL' ? 0.8 : match.basis === 'NORMALISED' ? 0.6 : 0.4,
        evidence: match.evidence,
        // NULL, not a run id. There is no run behind a static match, and
        // `testCoverageEdgeSchema` refuses a tier above DECLARED without one.
        lastConfirmedRunId: null,
        lastConfirmedAt: null,
        // Re-seeing a retired edge un-retires it, exactly as an item does.
        retiredAt: null,
      };
      try {
        const edge = await prisma.testCoverageEdge.upsert({
          where: {
            itemId_testId_source: { itemId, testId: match.testId, source: 'STATIC' },
          },
          create: { ...data, itemId, testId: match.testId, source: 'STATIC' },
          update: data,
          select: { id: true },
        });
        writtenEdgeIds.push(edge.id);
      } catch (error) {
        /*
         * Per edge, and COUNTED rather than swallowed.
         *
         * The inventory and the snapshot are the deliverable and are already
         * written; a test deleted between the match and this write fails its
         * foreign key, and taking the whole recompute down for a provenance row
         * would cost the measurement to save the audit trail of it.
         *
         * But the first version of this block caught and discarded, and that
         * made the one case that matters invisible: the TABLE NOT EXISTING at
         * all — which is the state of every deployment until this round's
         * migration is applied — failed every edge silently and reported a
         * clean snapshot. A failure nothing reports is a failure nobody fixes,
         * so the count and the first message both travel out of here.
         */
        failed += 1;
        firstError ??= error instanceof Error ? error.message : String(error);
      }
    }
  }

  /*
   * RETIRE the static edges this computation did not produce, and ONLY those.
   *
   * Scoped three ways: to this project, to `source: 'STATIC'` (this function's
   * own rows), and — the load-bearing one — skipped entirely unless every edge
   * it tried to write landed. A partial write followed by "retire everything I
   * did not write" is the edge-level version of the retirement catastrophe
   * decision 4 in this file's header describes.
   */
  const attemptedEdges = entries.reduce(
    (count, entry) =>
      count + entry.matches.filter((match) => liveTestIds.has(match.testId)).length,
    0,
  );
  if (writtenEdgeIds.length === attemptedEdges) {
    try {
      await prisma.testCoverageEdge.updateMany({
        where: {
          projectId,
          source: 'STATIC',
          retiredAt: null,
          ...(writtenEdgeIds.length > 0 ? { id: { notIn: writtenEdgeIds } } : {}),
        },
        data: { retiredAt: new Date() },
      });
    } catch (error) {
      // Counted as a failure of the whole write, because a sweep that did not
      // run leaves links claiming to be live that this computation did not
      // find — which is the direction that OVERSTATES coverage provenance.
      failed += 1;
      firstError ??= error instanceof Error ? error.message : String(error);
    }
  }

  return { attempted: attemptedEdges, written: writtenEdgeIds.length, failed, firstError };

}

/**
 * Retirement and the snapshot row — the tail of `persist`, lifted out whole so
 * that the edge writer above could be fault-isolated without putting a second
 * copy of this in the file. Not reordered: retirement still runs after the
 * upserts and before the snapshot, which is what makes the snapshot's counts
 * agree with the rows it was computed from.
 */
async function finishSnapshot(input: {
  orgId: string;
  projectId: string;
  snapshot: SurfaceSnapshot;
  seenKeys: string[];
  mayRetire: boolean;
  /**
   * The crawl identity and the denominator definition, STORED, because they are
   * the two halves of comparability.
   *
   * Every snapshot written before these columns existed has them NULL, and
   * `snapshotDelta` reads that as `UNCOMPARABLE_FINGERPRINT_MISSING` rather
   * than as comparable — "we cannot establish comparability" and "we
   * established they are not comparable" are different claims, and a confident
   * delta across an unknown boundary is the one this product cannot afford.
   */
  crawlFingerprint: string;
  denominatorDefinition: string;
}): Promise<string> {
  const { orgId, projectId, snapshot, seenKeys, mayRetire } = input;
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
      /*
       * `crawlVersion` is the ENUMERATOR's version and `crawlFingerprint` is
       * the identity of the inventory it produced. Two different facts: the
       * first says which code measured, the second says which application was
       * measured, and an attestation needs both to be checkable against a later
       * one.
       */
      crawlVersion: CRAWL_VERSION,
      crawlFingerprint: input.crawlFingerprint,
      denominatorDefinition: input.denominatorDefinition,
    },
    select: { id: true },
  });
  return row.id;
}

// ─── Reading back ────────────────────────────────────────────────────────────

/** The stored snapshot trend, newest first. What makes a gate's delta meaningful. */
/**
 * ── THE READ SIDE OF `TestCoverageEdge` ─────────────────────────────────────
 *
 * Provenance, aggregated: how many (test → item) links this project holds, by
 * what kind of evidence, at what rung, and how many have been retired.
 *
 * WHY AN AGGREGATE AND NOT A LIST. The per-item list is already on the item —
 * `CoverageItem.matches` — and a second per-item list would be a second answer.
 * What no surface in the product could state before this is the SHAPE of the
 * evidence behind a coverage figure: "every one of your 1,240 links is a regex
 * over test source and none has been confirmed by a run" is the sentence that
 * tells a buyer what the percentage beside it is worth, and it is a sentence
 * about the whole project rather than about any one route.
 *
 * `retired` is reported and NOT filtered out. An edge that stopped being found
 * is how coverage falls with an audit trail; hiding it would make the table
 * look like it only ever grows.
 *
 * RETURNS `null` WHEN THE TABLE IS NOT THERE. The migration that mints it is
 * written and unapplied in this tree, and `null` is "this deployment cannot
 * answer", which must not render as "no provenance exists" — an empty
 * aggregate would read as a project with no evidence behind its number, which
 * is the opposite of the truth and is the worse of the two wrong answers.
 */
export interface CoverageProvenance {
  /** One row per (source, tier) pair that exists. Zero pairs are absent, not 0. */
  byEvidence: Array<{ source: string; tier: string; live: number }>;
  live: number;
  retired: number;
  /**
   * Links whose evidence is a regex over test source and nothing else. Equal to
   * `live` until an instrumentation producer exists, which is the honest
   * reading and not a bug.
   */
  staticOnly: number;
  /** Links a run confirmed. 0 today, everywhere, and that is the finding. */
  runConfirmed: number;
  why: string;
}

export async function coverageProvenance(projectId: string): Promise<CoverageProvenance | null> {
  let rows: Array<{ source: string; tier: string; retiredAt: Date | null; lastConfirmedRunId: string | null }>;
  try {
    rows = await prisma.testCoverageEdge.findMany({
      where: { projectId },
      // Named, so dropping one from this select is a type error at every use
      // below rather than a field that quietly reads as undefined.
      select: { source: true, tier: true, retiredAt: true, lastConfirmedRunId: true },
      // Bounded for the same reason as the result read above. The aggregate is
      // over what fitted, and `why` says so when the cap bit.
      take: MAX_PROVENANCE_EDGES,
    });
  } catch {
    // The table does not exist on this deployment (the migration is written
    // and unapplied). Not an empty answer — no answer.
    return null;
  }

  const live = rows.filter((row) => row.retiredAt === null);
  const pairs = new Map<string, number>();
  for (const row of live) {
    const key = `${row.source}\u0000${row.tier}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }

  const capped = rows.length === MAX_PROVENANCE_EDGES;
  return {
    byEvidence: [...pairs.entries()]
      .map(([key, count]) => {
        const [source = '', tier = ''] = key.split('\u0000');
        return { source, tier, live: count };
      })
      .sort((left, right) => right.live - left.live || left.source.localeCompare(right.source)),
    live: live.length,
    retired: rows.length - live.length,
    staticOnly: live.filter((row) => row.source === 'STATIC').length,
    runConfirmed: live.filter((row) => row.lastConfirmedRunId !== null).length,
    why:
      `${live.length} live link(s); ${live.filter((row) => row.lastConfirmedRunId !== null).length} confirmed by a run. ` +
      'A link with no run behind it proves a test NAMES this item, not that anything executed it.' +
      (capped
        ? ` The read was capped at MAX_PROVENANCE_EDGES (${MAX_PROVENANCE_EDGES}), so at least one more exists and these counts are a lower bound.`
        : ''),
  };
}

/** Bounded for the same reason the result read is. A cap that bites is reported. */
const MAX_PROVENANCE_EDGES = 50_000;

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

// ─── Attribution: which feature, and whose team ──────────────────────────────

/**
 * WHOSE TEAM OWNS EACH SURFACE, through the one matcher this product has.
 *
 * `assignOwner` in apps/api/src/lib/ownership.ts is the function that refuses to
 * return a bare null, and it is the same one the notify processor, the digest
 * and the ticket filer route through — so the team a rollup bucket names and
 * the team a page gets routed to are the same team. A second matcher here would
 * be a second answer to "who owns /checkout", which is the question an
 * unattributed-surface finding exists to make answerable.
 *
 * ── THE LIMIT, STATED RATHER THAN DISCOVERED ───────────────────────────────
 *
 * `OwnableTest` is a TEST: a file path, a suite id and a feature. A
 * `CoverageItem` has a file path (for a source-declared surface) and a feature,
 * and NO suite — so `testId` and `suiteId` rules can never match a surface.
 * That is a real shortfall and it is disclosed as a count, because a project
 * that routes entirely by `testId` would see every surface land in UNOWNED and
 * the honest reading of that is "QAAI cannot attribute this", not "nobody owns
 * your application".
 *
 * A surface with NO file path cannot be matched at all — a crawled route has no
 * source location — and those are counted separately for the same reason.
 */
async function attributeOwnership(input: {
  orgId: string;
  projectId: string;
  entries: readonly SurfaceItemCoverage[];
}): Promise<{ teamByKey: Map<string, string | null>; caveats: string[] }> {
  const teamByKey = new Map<string, string | null>();
  const caveats: string[] = [];

  const rules = (await prisma.ownershipRule.findMany({
    where: { orgId: input.orgId, projectId: input.projectId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    // The SHARED select. A copy that forgot `position` would resolve
    // last-match-wins against a column that is always 0.
    select: OWNERSHIP_RULE_SELECT,
  })) as OwnershipRuleInput[];

  if (rules.length === 0) {
    /*
     * NO RULES is not "nobody owns it" — it is "nobody has said". Every item
     * goes to UNOWNED and the sentence says which of the two this is, because
     * the remedy for the first is a conversation and the remedy for the second
     * is three lines of configuration.
     */
    caveats.push(
      'No ownership rule exists for this project, so every surface is bucketed under UNOWNED in ' +
        'the rollup. Read that as "nobody has said who owns this", NOT as "nobody owns it": QAAI ' +
        'invents no default owner, because the first time a default pages the wrong person the ' +
        'feature gets switched off.',
    );
    for (const entry of input.entries) teamByKey.set(entry.item.key, null);
    return { teamByKey, caveats };
  }

  const identityOnly = rules.filter(
    (rule) => rule.pathPattern === null && rule.feature === null,
  ).length;
  let unmatchable = 0;

  for (const entry of input.entries) {
    const filePath = entry.item.file;
    if (filePath === null) {
      unmatchable += 1;
      teamByKey.set(entry.item.key, null);
      continue;
    }
    const assignment = assignOwner(
      {
        /*
         * An EMPTY id and a NULL suite, deliberately. A surface is not a test:
         * it has no test id and belongs to no suite, so a `testId` or `suiteId`
         * rule must not match it by accident. Passing the item key as the id
         * would risk exactly that the first time somebody wrote a rule whose
         * `testId` happened to equal a surface key.
         */
        id: '',
        filePath,
        suiteId: null,
        feature: featureOfItem(entry.item),
      },
      rules,
    );
    const owner = assignment.owner;
    teamByKey.set(entry.item.key, owner?.kind === 'TEAM' ? owner.teamId : null);
  }

  if (identityOnly > 0) {
    caveats.push(
      `${identityOnly} of ${rules.length} ownership rule(s) route by test id or suite id, which ` +
        'cannot match a SURFACE — a coverage item has a file path and a feature and belongs to no ' +
        'suite. Surfaces those rules would have covered are bucketed under UNOWNED. That is a ' +
        'limit of QAAI\u2019s attribution, not a statement about your org chart.',
    );
  }
  if (unmatchable > 0) {
    caveats.push(
      `${unmatchable} surface(s) carry no source location — a crawled route has none — so no ` +
        'path-pattern rule can be evaluated against them and they are bucketed under UNOWNED.',
    );
  }

  return { teamByKey, caveats };
}

/**
 * THE FEATURE A SURFACE BELONGS TO, or null for "nobody attributed it".
 *
 * Null is bucketed under `UNATTRIBUTED_FEATURE` by the rollup rather than
 * guessed at, and "31% of the surface has no feature" is a finding worth
 * reporting rather than noise worth hiding.
 *
 * Read off `item.meta.feature` when a declarer wrote one, and otherwise derived
 * from the first path segment of the item's route — which is the same rule
 * `routeFeatureName` in packages/agent/src/coverage.ts already applies to gaps,
 * so a gap and its rollup bucket agree about which feature they are about. Two
 * spellings of "payments" is two different 31%.
 */
function featureOfItem(item: SurfaceItem): string | null {
  const meta = item.meta as Record<string, unknown> | undefined;
  const declared = meta?.feature;
  if (typeof declared === 'string' && declared.length > 0) return declared;
  const route = typeof meta?.route === 'string' ? meta.route : typeof meta?.path === 'string' ? meta.path : null;
  return routeFeatureName(route);
}

/**
 * One coverage entry as a rollup row's input.
 *
 * `tier` here is the rung the ENTRY reached, and the mapping from
 * `SurfaceStatus` is deliberately conservative at both ends:
 *
 *   COVERED            → ASSERTED. A test asserts something about it and a run
 *                        executed it. PASSING would need the run's verdict,
 *                        which `SurfaceVerification` carries and which the
 *                        rollup is not taking a position on.
 *   ASSERTED_NOT_RUN   → DECLARED. Written is not run: a static match proves a
 *                        test NAMES this item, not that anything executed it.
 *   UNCOVERED, UNKNOWN → null, which is MEASURED AND UNCLAIMED and stays in the
 *                        denominator. UNKNOWN in particular is a hole in OUR
 *                        knowledge, and taking it out would let the number rise
 *                        every time our extractor got worse.
 *   WAIVED             → excluded, with the waiver's own reason and owner.
 *   UNEXERCISABLE /    → excluded, with the rule that refused it named.
 *   REFUSED
 */
function rollupItemFor(
  entry: SurfaceItemCoverage,
  waivers: Readonly<Record<string, SurfaceWaiver>>,
  teamId: string | null,
): RollupItem {
  const waiver = waivers[entry.item.key];
  const exercise = entry.item.exercise ?? null;
  const excluded: RollupItem['excluded'] =
    entry.status === 'WAIVED' || waiver !== undefined
      ? {
          reason: 'HELD_OUT',
          detail:
            `waived by ${waiver?.byEmail ?? waiver?.byUserId ?? 'an unrecorded owner'}: ` +
            `${waiver?.reason ?? 'no reason recorded'}` +
            (waiver?.expiresAtIso ? `, expiring ${waiver.expiresAtIso}` : ', with NO expiry'),
        }
      : exercise !== null && (exercise.state === 'UNEXERCISABLE' || exercise.state === 'REFUSED')
        ? {
            reason: 'HELD_OUT',
            detail:
              `${exercise.state}: ${exercise.detail}` +
              (exercise.rule ? ` (refused by ${exercise.rule})` : ''),
          }
        : null;

  return {
    key: entry.item.key,
    // Null: this is an AXIS-level rollup over CoverageItems themselves rather
    // than over the cells beneath them, which is what the rollup module's
    // `dimension: null` means.
    dimension: null,
    tier:
      excluded !== null
        ? null
        : entry.status === 'COVERED'
          ? 'ASSERTED'
          : entry.status === 'ASSERTED_NOT_RUN'
            ? 'DECLARED'
            : null,
    feature: featureOfItem(entry.item),
    teamId,
    excluded,
  };
}

/**
 * THE SENTENCE THAT SAYS WHAT WAS DIVIDED BY.
 *
 * Without it the percentage on an attestation is a number with no units, and
 * `attest` refuses an empty one. It is also one half of the comparability
 * decision: two snapshots whose denominator DEFINITIONS differ are not
 * comparable however close their percentages are, so this string is compared
 * verbatim by `snapshotDelta` and must be derived from the inventory rather
 * than hand-written per call site — a sentence that varies by caller would make
 * every snapshot uncomparable with every other.
 */
function denominatorDefinitionOf(
  inventory: SurfaceInventory,
  denominator: number,
  waivers: Readonly<Record<string, SurfaceWaiver>>,
): string {
  const axes = [...new Set(inventory.items.map((item) => item.kind))].sort();
  const heldOut = inventory.heldOut;
  /*
   * ── THE WAIVER CLAUSE IS MEASURED, NOT ASSERTED ───────────────────────────
   *
   * This sentence read "waived items leave the denominator with an owner and
   * an expiry" unconditionally, which was a claim the write path did not
   * enforce: the waiver door accepted a null expiry, and line 2299 of this
   * same file prints ", with NO expiry" for exactly those items. This string is
   * stored on every CoverageSnapshot, compared VERBATIM by `snapshotDelta` to
   * decide comparability, and refused-if-empty by `attest` — so it is the
   * sentence a customer signs, and a cap disclosed as bounded when it is not is
   * the one lie this product cannot afford.
   *
   * The door now requires an expiry (`applySuppression`, routes/surface.ts), so
   * on a project with no legacy rows the clause reads exactly as it always did.
   * Where unbounded rows remain, it names how many.
   */
  const unbounded = Object.values(waivers).filter((w) => w.expiresAtIso === null).length;
  const waiverClause =
    unbounded === 0
      ? 'waived items leave the denominator with an owner and an expiry.'
      : `waived items leave the denominator with an owner, and ${unbounded} of ` +
        `${Object.keys(waivers).length} of them have NO expiry — those were written before an ` +
        'expiry was required and nothing will lapse them.';
  return (
    `${denominator} CoverageItem(s) across ${axes.length} axis/axes (${axes.join(', ')}), ` +
    `declared by ${inventory.participation.filter((p) => p.participation === 'LOADED').length} of ` +
    `${inventory.participation.length} declarer(s); union ` +
    `${inventory.complete === null ? 'completeness UNKNOWN' : inventory.complete ? 'complete' : 'PARTIAL'}; ` +
    `${heldOut.unexercisable} unexercisable and ${heldOut.refused} refused item(s) held out of the ` +
    `division with a reason; ${waiverClause}`
  );
}

// ─── The dimensions: adapters, a write path and a read path ──────────────────

/**
 * ════════════════════════════════════════════════════════════════════════════
 * THE DIMENSION ADAPTERS, AND WHY THEY ARE HERE AND NOT IN packages/agent
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Every dimension module in packages/agent takes its facts as a narrow injected
 * record — a list of forms, a list of components, a list of tests — and nothing
 * else, because rule 8 of this codebase says so and because 629 lines of
 * `crawler.ts` had almost no tests for want of that. The price is that somebody
 * has to translate stored artefacts into those records, and this file is the
 * only one in the repo that holds all four inputs at once: the source analysis,
 * the latest crawl, the Test rows and the run report.
 *
 * ── A TASK THAT MINTS A TABLE OWES IT A WRITE PATH AND A READ PATH ──────────
 *
 * Two consecutive keystones shipped models with no door, `check:wiring` called
 * them DISCONNECTED, and neither slice could ship. "The next round will read
 * it" is not a door. So all three of the cell tables get both halves here:
 * `persistDimensionCells` writes `CoverageFormField`, `CoverageItemState` and
 * `CoverageTypeObligation`, and `dimensionBreakdown` reads them back.
 *
 * ── WHAT IS ADAPTED AND WHAT IS HONESTLY NOT ────────────────────────────────
 *
 * Five of the twelve measured axes have an adapter here, because their facts
 * are in artefacts this file already loads:
 *
 *   FORM_FIELD, VALIDATION_RULE  the crawl's `FormModel.fields` (which carry
 *                                maxlength, min, max, step and pattern) and the
 *                                source analysis's `SourceForm.fields` (which
 *                                carry none of them — hence `constraintsRead:
 *                                false`, which is a disclosure and not a bug)
 *   COMPONENT, COMPONENT_STATE   the stored `ComponentItem` / `ComponentState`
 *                                rows the component pass above writes
 *   TEST_TYPE                    `Project.typeObligationPolicy` plus the Test
 *                                rows, plus the deployment's capability set
 *
 * The other seven axes have a producer in `DIMENSION_REGISTRY` and NO adapter
 * in this build, and that is reported as `NOT_ENUMERATED` by
 * `coverageDimensionReport` — the extractor exists and was given no facts,
 * which is a different finding from "we have no extractor" and has a different
 * remedy. Neither is 0%. The adapters each need an artefact this file does not
 * load (`FlowNode.structure` for the state axes, `VariantAttribution` for the
 * device and flag axes, `analysis.backgroundSurfaces` for the async axes, the
 * stored `AccessMatrixCell` rows for roles), and each is a thin field-for-field
 * translation named in this round's handover rather than half-built here.
 */

/**
 * WHAT THIS DEPLOYMENT CAN EXECUTE, read from `DeploymentCapability`.
 *
 * ── WHY THE API READS THE ROWS AND DOES NOT CALL THE PROBER ────────────────
 *
 * The prober lives in `apps/worker/src/processors/preflight.ts` — it `stat`s
 * PATH and shells out for `--version`, which is the worker's job and not a
 * thing to do on an API thread while somebody is waiting for a page. So the
 * worker writes the rows and this reads them, and the read is deliberately
 * dumber than the prober: it takes whatever was last written and reports when.
 *
 * ── EVERY TYPE APPEARS, AND AN UNPROBED ONE IS NOT_CHECKED ─────────────────
 *
 * The loop is over `TEST_TYPES` and not over the rows that happen to exist,
 * which is the whole correctness of it: a loop over the table can only report
 * types somebody already wrote a row for, so a half-probed deployment would
 * look complete and the nineteen in "4 of 19" would be however many rows there
 * were.
 *
 * NOT_CHECKED COUNTS. `capabilityCounts` keeps it in the denominator, and the
 * reason is the one that decides whether this whole feature is honest: dropping
 * an unprobed type would let a deployment that never ran a preflight silently
 * shed every obligation it could not prove it could run, and the percentage
 * would RISE for a preflight nobody executed.
 *
 * ── NULL IS "CANNOT ANSWER" ────────────────────────────────────────────────
 *
 * The migration that mints the table is written and unapplied in this tree. On
 * a deployment where it has not landed this returns null, and
 * `measureDimensions` then supplies NO capability facts — which leaves every
 * type NOT_CHECKED and in the denominator, the conservative direction. It must
 * never be read as "every type is available".
 */
export async function deploymentCapabilityFacts(): Promise<{
  facts: DeploymentCapabilityFact[];
  /** The oldest `checkedAt` in the set, or NULL when nothing was ever probed. */
  measuredAt: Date | null;
  /** Types whose obligations leave the denominator, each with its reason. */
  nonExecutable: Array<{ testType: TestType; status: string; reason: string }>;
  /** Probed and inconclusive, or never probed. Reported, still in the denominator. */
  notChecked: TestType[];
  sentence: string;
} | null> {
  let rows: Array<{
    testType: TestType;
    status: DeploymentCapabilityStatus;
    detail: string;
    checkedAt: Date | null;
  }>;
  try {
    rows = await prisma.deploymentCapability.findMany({
      where: { deploymentKey: SELF_DEPLOYMENT },
      select: { testType: true, status: true, detail: true, checkedAt: true },
    });
  } catch {
    return null;
  }

  const byType = new Map(rows.map((row) => [row.testType, row]));
  const facts: DeploymentCapabilityFact[] = [];
  const nonExecutable: Array<{ testType: TestType; status: string; reason: string }> = [];
  const notChecked: TestType[] = [];

  for (const testType of TEST_TYPES) {
    const row = byType.get(testType);
    const status = row?.status ?? 'NOT_CHECKED';
    const detail =
      row?.detail ??
      'No capability probe has ever run for this type on this deployment, so whether it can be executed here is NOT MEASURED. It stays in the coverage denominator.';
    facts.push({ testType, status, detail });
    if (!capabilityCounts(status)) {
      nonExecutable.push({ testType, status, reason: detail });
      continue;
    }
    if (status === 'NOT_CHECKED') notChecked.push(testType);
  }

  const measuredAt = rows.reduce<Date | null>(
    (oldest, row) =>
      row.checkedAt === null ? oldest : oldest === null || row.checkedAt < oldest ? row.checkedAt : oldest,
    null,
  );

  /*
   * THREE FACTS, NEVER FOLDED INTO ONE: how many types cannot execute here, how
   * many are unresolved, and when (or whether) any of it was measured. A reader
   * given only the first would read silence on the other two as "everything
   * else is fine".
   */
  const total = TEST_TYPES.length;
  const sentence =
    measuredAt === null
      ? `None of the ${total} test types has been probed on this deployment, so which of them it can execute is NOT MEASURED. Every type stays in the coverage denominator: an unprobed type must not be able to shed an obligation it never proved it could run.`
      : `${
          nonExecutable.length === 0
            ? `All ${total} test types are executable on this deployment.`
            : `${nonExecutable.length} of ${total} test types are not executable here: ${nonExecutable
                .map((entry) => `${entry.testType} (${entry.status})`)
                .join(', ')}. Their obligations leave the coverage denominator with this reason — they are not counted as covered, and they are not silently dropped.`
        }${
          notChecked.length === 0
            ? ''
            : ` ${notChecked.length} type(s) could not be established either way: NOT_CHECKED is not a verdict about this image, and those stay IN the denominator.`
        } Measured at ${measuredAt.toISOString()}.`;

  return { facts, measuredAt, nonExecutable, notChecked, sentence };
}

/** The axes this file can currently supply facts for. The rest are NOT_ENUMERATED. */
export const ADAPTED_DIMENSIONS: readonly CoverageDimensionKind[] = [
  'FORM_FIELD',
  'VALIDATION_RULE',
  'COMPONENT',
  'COMPONENT_STATE',
  'TEST_TYPE',
];

/**
 * How many cells one dimension write will store.
 *
 * A cap, therefore disclosed: when it bites it is reported as a COUNT and a
 * REASON on the snapshot's caveats, so a reader can see "at least 1,400 more
 * form-field cells existed" rather than reading a truncated denominator as the
 * whole application. The limit is on the WRITE and not on the measurement — the
 * percentage is computed over everything the modules measured, and only the
 * stored row list is cut — which is why the two numbers can differ and why the
 * caveat says which is which.
 */
const MAX_DIMENSION_CELL_WRITES = 20_000;

/**
 * Turn a crawled form's field into the narrow record `coverage-fields.ts` takes.
 *
 * ── THE THREE-STATE ATTRIBUTES ARE PRESERVED, NOT FLATTENED ────────────────
 *
 * `FormField.maxLength` and friends are OPTIONAL and distinguish three states:
 * absent means this crawl predates the capture, null means the crawl looked and
 * the page declares nothing, a value means the page declares it. Collapsing
 * absent onto null here would re-import exactly the lie those optionals exist
 * to prevent — a field nobody read would be reported as a field with no
 * constraints, which is a measurement we never took.
 *
 * So `constraintsRead` is true only when the crawl actually captured the
 * attributes (any of the six is present, even as null), and `min`/`max`/`step`
 * are passed through `numericBound`, which names the ones the numeric column
 * cannot hold rather than coercing them to NaN or dropping them.
 */
function fieldFromCrawl(field: FormField): FieldCoverageField {
  const captured =
    field.maxLength !== undefined ||
    field.minLength !== undefined ||
    field.min !== undefined ||
    field.max !== undefined ||
    field.step !== undefined ||
    field.pattern !== undefined;

  /*
   * The slug type is MODULE-PRIVATE in coverage-fields.ts — `type
   * ConstraintSlug` with no `export` — while the interface field that uses it
   * is public. So it is derived from the interface rather than named, which
   * keeps the compiler checking the slugs against the module's own list
   * instead of against a copy of it here. The missing export line is in this
   * round's handover.
   */
  type Slug = NonNullable<FieldCoverageField['unreadableConstraints']>[number];
  const unreadable: Slug[] = [];
  /*
   * `min`, `max` and `step` are STRINGS on the wire, because the attributes are
   * not numbers: `min` is "2024-01-01" on a date input and "08:00" on a time
   * input. `FormFieldConstraintReading` types them as numbers, so a date bound
   * cannot be stored — and both alternatives are lies. Dropping it reports a
   * field with nothing to test; `Number("2024-01-01")` is NaN and would report
   * a bound of NaN. So the slug is NAMED, the cell is unmeasured with
   * `EXTRACTOR_RETURNED_UNKNOWN`, and the detail says which attribute we could
   * not keep.
   */
  const numericBound = (raw: string | null | undefined, slug: Slug): number | null => {
    if (raw === undefined || raw === null || raw === '') return null;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
    unreadable.push(slug);
    return null;
  };

  return {
    name: field.name,
    label: field.label,
    inputType: field.inputType,
    required: field.required,
    semantic: field.semantic,
    constraintsRead: captured,
    constraint: captured
      ? {
          maxLength: field.maxLength ?? null,
          minLength: field.minLength ?? null,
          min: numericBound(field.min, 'min'),
          max: numericBound(field.max, 'max'),
          step: numericBound(field.step, 'step'),
          pattern: field.pattern ?? null,
        }
      : null,
    ...(unreadable.length > 0 ? { unreadableConstraints: unreadable } : {}),
  };
}

/**
 * The same, for a form read out of the SOURCE.
 *
 * `constraintsRead: false` is not an oversight and must not be "fixed" by
 * passing an all-null constraint object: `detectForms` in
 * packages/shared/src/codebase.ts reads no `maxlength`, `minlength`, `min`,
 * `max`, `step` or `pattern` at all, so six constraint classes are unreachable
 * from this declarer. False with a null constraint means "nobody looked", which
 * owes one unmeasured cell per class; true with an all-null constraint would
 * mean "we looked and the page declares nothing", which owes no cells. The
 * second is the flattering answer and it is not true.
 */
function fieldFromSource(field: SourceFormField): FieldCoverageField {
  return {
    name: field.name,
    label: field.label,
    inputType: field.inputType,
    required: field.required,
    semantic: field.semantic,
    constraint: null,
    constraintsRead: false,
  };
}

/**
 * Every form whose `CoverageItem` row exists, with its fields.
 *
 * ── THE DROP THAT IS COUNTED RATHER THAN SILENT ────────────────────────────
 *
 * `FieldCoverageForm.itemKey` is required, because a field cell with no
 * registry row to hang on cannot be written and a denominator of rows nothing
 * can store is not a denominator. The inventory does not necessarily hold both
 * declarers' forms: when a source analysis exists, `buildSurfaceInventory`
 * takes the FORM axis from the source list ONLY, so the crawl's forms have no
 * item of their own. Emitting them anyway would mint cells against keys that
 * name nothing, which is the dangling reference `ComponentState.coverageItemKey`
 * already has to report rather than enforce.
 *
 * So a form whose key is not in the inventory is DROPPED and COUNTED, and the
 * count becomes a caveat. Dropped-and-counted is a disclosure; dropped-and-
 * silent is a smaller denominator with no explanation, which is the direction
 * that flatters the number.
 */
function formsForFieldCoverage(input: {
  analysis: CodebaseAnalysis | null;
  flowMap: FlowMap | null;
  /** Every live `CoverageItem.key`, so a form with no row is dropped and counted. */
  itemKeys: ReadonlySet<string>;
}): { forms: FieldCoverageForm[]; droppedNoItem: number } {
  const forms: FieldCoverageForm[] = [];
  let droppedNoItem = 0;

  const push = (form: FieldCoverageForm): void => {
    if (!input.itemKeys.has(form.itemKey)) {
      droppedNoItem += 1;
      return;
    }
    forms.push(form);
  };

  for (const form of input.analysis?.forms ?? []) {
    push({
      itemKey: surfaceKey('FORM', formIdentity(form)),
      name: form.name,
      /*
       * NULL, and it WIDENS the match rather than narrowing it. A source form
       * has no route attached, so there is nothing to scope a test's mention by
       * — and `analyseFieldCoverage` discloses that as a caveat rather than
       * silently treating the mention as a match on every page.
       */
      route: null,
      source: 'SOURCE',
      fields: form.fields.map(fieldFromSource),
    });
  }

  for (const node of input.flowMap?.nodes ?? []) {
    for (const form of node.forms) {
      push({
        itemKey: surfaceKey('FORM', `${canonicalRoute(node.route)}#${form.id}`),
        name: form.name,
        route: canonicalRoute(node.route),
        source: 'CRAWL',
        fields: form.fields.map(fieldFromCrawl),
      });
    }
  }

  return { forms, droppedNoItem };
}

/**
 * The stored component inventory, as the narrow records the module takes.
 *
 * Read back from `ComponentItem` / `ComponentState` rather than from
 * `analysis.components`, and the difference matters: `persistComponents` above
 * is what decides which components are live and which are retired, and it is
 * what wrote the `coverageItemKey` each state cell has to be stored against.
 * Measuring from the analysis instead would measure a set the database does not
 * hold, and the two would disagree the first time a component was retired.
 *
 * ── `states: null` IS NOT `states: []` ─────────────────────────────────────
 *
 * A component with no state ROWS has `states: null` here, meaning NOBODY
 * ENUMERATED ITS STATES, which owes one unmeasured cell on the COMPONENT_STATE
 * axis. `[]` would mean a reader looked and the component declares none, which
 * owes nothing. We cannot tell the two apart from the rows alone — a component
 * row exists either way — so the conservative reading is taken: null, which
 * LOWERS the measured share rather than flattering it.
 */
async function componentsForFieldCoverage(input: {
  projectId: string;
  itemKeys: ReadonlySet<string>;
}): Promise<{ components: ComponentCoverageItem[]; truncated: boolean }> {
  const rows = await prisma.componentItem.findMany({
    where: { projectId: input.projectId, retiredAt: null },
    orderBy: [{ modulePath: 'asc' }, { exportName: 'asc' }],
    take: MAX_COMPONENTS,
    select: {
      modulePath: true,
      exportName: true,
      kind: true,
      hasCatalogueEntry: true,
      evidence: true,
      states: {
        where: { retiredAt: null },
        select: { kind: true, source: true, evidence: true, coverageItemKey: true },
      },
    },
  });

  const components = rows.map((row): ComponentCoverageItem => {
    /*
     * The component's own cell hangs off the COMPONENT_STATE item of its
     * DEFAULT state, because that is the only registry key a component row
     * carries — `componentStateIdentity` keys on (module, export, KIND) and
     * there is no COMPONENT item kind. A component none of whose states has a
     * stored key reaches the module with `itemKey: null`, which it reports as
     * NOT_ENUMERATED with the dangling reference named, rather than minting
     * cells nothing can store.
     */
    const keyed = row.states.find(
      (state) => state.coverageItemKey !== null && input.itemKeys.has(state.coverageItemKey),
    );
    return {
      itemKey: keyed?.coverageItemKey ?? null,
      modulePath: row.modulePath,
      exportName: row.exportName,
      kind: row.kind,
      source: 'SOURCE',
      hasCatalogueEntry: row.hasCatalogueEntry,
      states:
        row.states.length === 0
          ? null
          : row.states.map((state) => ({
              kind: state.kind,
              source: state.source,
              evidence: state.evidence,
            })),
    };
  });

  return { components, truncated: rows.length === MAX_COMPONENTS };
}

/**
 * Everything one dimension pass produced: the report, the rows it wants stored,
 * and the disclosures it owes.
 */
export interface MeasuredDimensions {
  /** All thirteen axes, each with its own denominator and no combined figure. */
  report: CoverageDimensionReport;
  /** `CoverageFormField` rows: the FORM_FIELD and VALIDATION_RULE cells. */
  formFieldRows: FormFieldCellRow[];
  /** `CoverageItemState` rows: the COMPONENT and COMPONENT_STATE cells. */
  itemStateRows: ItemStateCellRow[];
  /** `CoverageTypeObligation` cells: one surface owing one typed test. */
  obligationCells: readonly TypeObligationCell[];
  /** The per-type ladders — "routes with an ACCESSIBILITY test: 3 of 14". */
  byTestType: readonly TypeObligationTotals[];
  /** Every sentence this pass owes the reader, caps that bit included. */
  caveats: string[];
}

/**
 * Measure every axis this file can supply facts for, and NAME the rest.
 *
 * `capabilities` is injected rather than read here, and that is the one wiring
 * decision in this function worth the comment: the prober lives in
 * apps/worker/src/processors/preflight.ts, which this app cannot import, and
 * the fallback when no caller supplies it is NOT "assume every type runs". An
 * absent capability set leaves every type `NOT_CHECKED`, which `capabilityCounts`
 * deliberately KEEPS in the denominator — dropping an unprobed type would let a
 * deployment that never ran a preflight shed every obligation it could not
 * prove it could run, and the percentage would rise for a preflight nobody
 * executed.
 */
export async function measureDimensions(input: {
  projectId: string;
  analysis: CodebaseAnalysis | null;
  flowMap: FlowMap | null;
  items: readonly SurfaceItem[];
  tests: readonly CoverageTestInput[];
  /**
   * The test ids whose quarantine is IN FORCE, as `quarantineSuppresses`
   * answered it.
   *
   * A SET and not a flag on the test, because `CoverageTestInput` deliberately
   * carries no quarantine column — the one question "is this suppression in
   * force" is answered by `quarantineSuppresses` in packages/runner, and a
   * fourth place in this product with its own opinion about it is how a
   * quarantined test came to close a gap.
   */
  quarantined: ReadonlySet<string>;
  waivers: Readonly<Record<string, SurfaceWaiver>>;
  /** The project's declared obligation policy. NULL means it never configured one. */
  typeObligationPolicy: TypeObligationPolicy | null;
  /** The dialect the suite is written in. NULL makes assertion claims unmeasured. */
  dialect: DialectId | null;
  /** What this deployment can execute. Absent leaves every type NOT_CHECKED. */
  capabilities?: readonly DeploymentCapabilityFact[];
  nowIso: string;
}): Promise<MeasuredDimensions> {
  const caveats: string[] = [];
  const itemKeys = new Set(input.items.map((item) => item.key));

  // ── FORM_FIELD, VALIDATION_RULE, COMPONENT, COMPONENT_STATE ──────────────
  const { forms, droppedNoItem } = formsForFieldCoverage({
    analysis: input.analysis,
    flowMap: input.flowMap,
    itemKeys,
  });
  if (droppedNoItem > 0) {
    caveats.push(
      `${droppedNoItem} form(s) were found by a declarer and have no CoverageItem row, so their ` +
        'fields are not in the FORM_FIELD or VALIDATION_RULE denominator. A field cell with no ' +
        'registry row cannot be stored, and minting one against a key that names nothing would ' +
        'be a dangling reference rather than a measurement. This happens by design when a ' +
        'source analysis exists: the inventory then takes the FORM axis from the source list ' +
        "only, so the crawl's forms have no item of their own.",
    );
  }

  const { components, truncated: componentsTruncated } = await componentsForFieldCoverage({
    projectId: input.projectId,
    itemKeys,
  });
  const fieldCaps: DimensionCapBite[] = [];
  if (componentsTruncated) {
    fieldCaps.push({
      cap: 'MAX_COMPONENTS',
      limit: MAX_COMPONENTS,
      /*
       * NULL, not 0. The read stopped at the limit and cannot say what was
       * behind it; 0 would be the claim that nothing was hidden, which is the
       * opposite of what a bitten cap means.
       */
      atLeastMore: null,
      detail:
        `the component read stopped at ${MAX_COMPONENTS} rows, so at least one more component ` +
        'exists and the COMPONENT and COMPONENT_STATE denominators are a lower bound',
    });
  }

  const fieldResult = analyseFieldCoverage({
    forms,
    components,
    tests: input.tests.map((test) => ({
      id: test.id,
      code: test.code ?? null,
      routes: test.routes,
      quarantined: input.quarantined.has(test.id),
    })),
    dialect: input.dialect,
    nowIso: input.nowIso,
    caps: fieldCaps,
  });
  caveats.push(...fieldResult.caveats);

  // ── TEST_TYPE ────────────────────────────────────────────────────────────
  const subjects = input.items.map((item) => ({
    key: item.key,
    kind: item.kind,
    exercise: item.exercise ?? null,
    waived: input.waivers[item.key] !== undefined,
  }));
  const typeMatrix = buildTypeObligationMatrix({
    items: subjects,
    obligations: resolveTypeObligations({
      items: subjects,
      policy: input.typeObligationPolicy,
    }),
    /*
     * NO EDGES ARE SUPPLIED, AND THAT IS A MEASURED STATE RATHER THAN A GAP IN
     * THIS WIRING. A `TypedCoverageEdge` needs the TYPE OF THE TEST on the
     * link, and `persistCoverageEdges` above writes `TestCoverageEdge` rows
     * with no test type on them — the column does not exist. So every declared
     * obligation reads as measured-and-unclaimed, which is the conservative
     * direction: the cells stay IN the denominator and nothing is scored as
     * covered on evidence we do not hold. The alternative — crediting an
     * untyped edge to every type — is the exact defect the TEST_TYPE axis was
     * built to remove, where a PERFORMANCE test marks /checkout fully visited
     * as an E2E does.
     */
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
  });
  if (typeMatrix.measurement.measured > 0) {
    caveats.push(
      `TEST_TYPE: ${typeMatrix.measurement.measured} typed obligation(s) are in the denominator ` +
        'and none is claimed by a test, because `TestCoverageEdge` carries no test type — the ' +
        'links exist and cannot say whether the test that made them was an E2E or a PERFORMANCE ' +
        'run. Crediting an untyped link to every type is the defect this axis exists to remove, ' +
        'so the obligations are counted and unclaimed rather than scored.',
    );
  }
  if (typeMatrix.refused.length > 0) {
    caveats.push(
      `TEST_TYPE: ${typeMatrix.refused.length} declared obligation(s) named an axis this ` +
        'dimension does not refine and were REFUSED rather than minted — an obligation on a ' +
        'cell rather than on a surface is how fabricated denominators get built out of a real one.',
    );
  }

  const report = coverageDimensionReport({
    supplied: {
      FORM_FIELD: fieldResult.measurements.FORM_FIELD,
      VALIDATION_RULE: fieldResult.measurements.VALIDATION_RULE,
      COMPONENT: fieldResult.measurements.COMPONENT,
      COMPONENT_STATE: fieldResult.measurements.COMPONENT_STATE,
      TEST_TYPE: typeMatrix.measurement,
    },
  });

  /*
   * THE AXES WITH A PRODUCER AND NO ADAPTER, NAMED ONCE, WITH THEIR MODULES.
   *
   * `coverageDimensionReport` already reports each of them as NOT_ENUMERATED
   * with its own sentence, so this caveat is not the disclosure — it is the
   * SUMMARY, on the snapshot, beside the number, so that a reader of the
   * headline sees how much of the breakdown is missing without walking
   * thirteen measurements. Silence about an axis reads as "nothing to report",
   * which is the direction that flatters a coverage product.
   */
  const unadapted = report.measured.filter(
    (dimension) => !ADAPTED_DIMENSIONS.includes(dimension),
  );
  if (unadapted.length > 0) {
    caveats.push(
      `${unadapted.length} of ${report.measured.length} measurable dimension(s) were NOT ` +
        `enumerated by this computation: ${unadapted.join(', ')}. A module in packages/agent can ` +
        'measure each of them and this deployment holds no adapter that supplies its facts — so ' +
        'their denominators are UNKNOWN rather than zero, and none of them has a percentage. ' +
        'This is a gap in QAAI, not in your test suite.',
    );
  }

  return {
    report,
    formFieldRows: fieldResult.formFieldRows,
    itemStateRows: fieldResult.itemStateRows,
    obligationCells: typeMatrix.cells,
    byTestType: typeMatrix.byType,
    caveats,
  };
}

/** What a dimension write managed, so a partial one can be disclosed. */
export interface DimensionWriteResult {
  attempted: number;
  written: number;
  failed: number;
  /**
   * The first error's message, which is how a table that does not exist at all
   * is told apart from one row failing a foreign key. The two have the same
   * shape in the counts and completely different remedies.
   */
  firstError: string | null;
  /** True when MAX_DIMENSION_CELL_WRITES cut the row list. Reported, never silent. */
  truncated: boolean;
}

/**
 * ── THE WRITE PATH FOR THE THREE CELL TABLES ────────────────────────────────
 *
 * `CoverageFormField`, `CoverageItemState` and `CoverageTypeObligation`, from
 * the rows the dimension modules produced. Every row is parsed through its own
 * zod schema BEFORE the upsert, so a reading the database would refuse is
 * refused here with the field named rather than failing as a constraint
 * violation nobody can read.
 *
 * ── FAULT-ISOLATED, AND THE FAILURE IS COUNTED ──────────────────────────────
 *
 * The migration that mints these three tables is written and UNAPPLIED in this
 * tree, so the delegates exist on the generated client and the TABLES do not:
 * every statement below throws until somebody deploys. The inventory and the
 * snapshot are the deliverable and are already written, so an unavailable cell
 * table must cost the BREAKDOWN and not the measurement — exactly the trade
 * `persistCoverageEdges` above makes, for the same reason and in the same
 * shape.
 *
 * What it must never do is fail quietly. The reason goes onto the snapshot's
 * own caveats, beside the number, because "we recorded none of the per-cell
 * detail behind this figure" is a fact about how defensible the figure is.
 *
 * ── RETIREMENT IS SCOPED BY `kind`, AND THAT IS LOAD-BEARING ────────────────
 *
 * `CoverageItemState` is written by MORE THAN ONE PRODUCER: this pass stores
 * the COMPONENT_* cells, and the page-state, error-state and data-variant
 * adapters store PAGE_*, ERROR_* and DATA_* cells into the same table. So the
 * sweep is scoped to the cell kinds THIS pass produces and sets `retiredAt`; an
 * unscoped `deleteMany` would remove another producer's cells on every
 * recompute, and the rows would come back on the next one — a table that
 * oscillates is worse than one that is stale, because the stale one is at least
 * reproducible.
 *
 * And the sweep is skipped entirely unless every row landed, for the reason
 * decision 4 in this file's header gives: a partial write followed by "retire
 * everything I did not write" is how an audit trail deletes itself.
 */
async function persistDimensionCells(input: {
  orgId: string;
  projectId: string;
  measured: MeasuredDimensions;
}): Promise<DimensionWriteResult> {
  const { orgId, projectId, measured } = input;

  const keys = [
    ...measured.formFieldRows.map((row) => row.itemKey),
    ...measured.itemStateRows.map((row) => row.itemKey),
    ...measured.obligationCells.map((cell) => cell.itemKey),
  ];
  const itemRows = await prisma.coverageItem.findMany({
    where: { projectId, key: { in: [...new Set(keys)] } },
    select: { id: true, key: true },
  });
  const itemIdByKey = new Map(itemRows.map((row) => [row.key, row.id]));

  let attempted = 0;
  let failed = 0;
  let firstError: string | null = null;
  const writtenFieldKeys: string[] = [];
  const writtenStateKeys: string[] = [];
  const writtenObligations: string[] = [];
  let budget = MAX_DIMENSION_CELL_WRITES;

  const attempt = async (what: () => Promise<void>): Promise<boolean> => {
    attempted += 1;
    try {
      await what();
      return true;
    } catch (error) {
      failed += 1;
      firstError ??= error instanceof Error ? error.message : String(error);
      return false;
    }
  };

  for (const row of measured.formFieldRows) {
    if (budget <= 0) break;
    const itemId = itemIdByKey.get(row.itemKey);
    // An item whose upsert did not land this round has no id to hang a cell
    // off. Skipping is correct: the next recompute writes both, and a cell
    // pointing at nothing is worse than a missing one.
    if (itemId === undefined) continue;
    budget -= 1;
    const ok = await attempt(async () => {
      const parsed = coverageFormFieldSchema.parse(row);
      const data = {
        orgId,
        projectId,
        kind: parsed.kind,
        label: parsed.label,
        parentFieldKey: parsed.parentFieldKey,
        inputType: parsed.inputType,
        /*
         * `required` and `constraint` are written as NULL when the reader could
         * not read them, and `constraintsRead` is what tells that apart from a
         * page that declares nothing. Writing `false` for an unread `required`
         * would report every unreadable field as optional, which removes a rule
         * cell per field and raises the measured share for a reader bug.
         */
        required: parsed.required,
        /*
         * `Prisma.DbNull` and not `null`. A nullable Json column distinguishes
         * SQL NULL from the JSON value `null`, and the client refuses a bare
         * `null`; `DbNull` is the column being empty, which here means the
         * constraints were never read. `constraintsRead` beside it is what
         * tells that apart from a page that declares none.
         */
        constraint:
          parsed.constraint === null
            ? Prisma.DbNull
            : (parsed.constraint as unknown as Prisma.InputJsonValue),
        constraintsRead: parsed.constraintsRead,
        semantic: parsed.semantic,
        origin: parsed.origin,
        evidence: parsed.evidence,
        exercisability: parsed.exercise?.state ?? null,
        unexercisableReason: parsed.exercise?.reason ?? null,
        refusedByRule: parsed.exercise?.rule ?? null,
        exerciseDetail: parsed.exercise?.detail ?? null,
        tier: parsed.tier,
        tierCappedBy: parsed.tierCappedBy,
        lastConfirmedRunId: parsed.lastConfirmedRunId,
        unmeasuredReason: parsed.unmeasuredReason,
        unmeasuredDetail: parsed.unmeasuredDetail,
        retiredAt: null,
      };
      await prisma.coverageFormField.upsert({
        where: { itemId_fieldKey: { itemId, fieldKey: parsed.fieldKey } },
        create: { ...data, itemId, fieldKey: parsed.fieldKey },
        update: data,
      });
    });
    if (ok) writtenFieldKeys.push(row.fieldKey);
  }

  for (const row of measured.itemStateRows) {
    if (budget <= 0) break;
    const itemId = itemIdByKey.get(row.itemKey);
    if (itemId === undefined) continue;
    budget -= 1;
    const ok = await attempt(async () => {
      const parsed = coverageItemStateSchema.parse(row);
      const data = {
        orgId,
        projectId,
        kind: parsed.kind,
        label: parsed.label,
        origin: parsed.origin,
        evidence: parsed.evidence,
        parentStateKey: parsed.parentStateKey,
        /*
         * NULL means DECLARED AND NEVER OBSERVED, and it is not the request
         * time. Stamping a declared state with `new Date()` would report a
         * state nobody drove as a state we watched happen, which is the
         * written-is-not-run rule broken in one column.
         */
        observedAt: parsed.observedAtIso === null ? null : new Date(parsed.observedAtIso),
        exercisability: parsed.exercise?.state ?? null,
        unexercisableReason: parsed.exercise?.reason ?? null,
        refusedByRule: parsed.exercise?.rule ?? null,
        exerciseDetail: parsed.exercise?.detail ?? null,
        tier: parsed.tier,
        tierCappedBy: parsed.tierCappedBy,
        lastConfirmedRunId: parsed.lastConfirmedRunId,
        unmeasuredReason: parsed.unmeasuredReason,
        unmeasuredDetail: parsed.unmeasuredDetail,
        retiredAt: null,
      };
      await prisma.coverageItemState.upsert({
        where: { itemId_stateKey: { itemId, stateKey: parsed.stateKey } },
        create: { ...data, itemId, stateKey: parsed.stateKey },
        update: data,
      });
    });
    if (ok) writtenStateKeys.push(row.stateKey);
  }

  for (const cell of measured.obligationCells) {
    if (budget <= 0) break;
    const itemId = itemIdByKey.get(cell.itemKey);
    if (itemId === undefined) continue;
    budget -= 1;
    const ok = await attempt(async () => {
      const parsed = coverageTypeObligationSchema.parse({
        itemKey: cell.itemKey,
        testType: cell.testType,
        declaredBy: cell.declaredBy,
        evidence: cell.evidence,
        tier: cell.tier,
        tierCappedBy: cell.tierCappedBy,
        lastConfirmedRunId: cell.lastConfirmedRunId,
        unmeasuredReason: cell.unmeasuredReason,
        unmeasuredDetail: cell.unmeasuredDetail,
      });
      const data = {
        orgId,
        projectId,
        declaredBy: parsed.declaredBy,
        evidence: parsed.evidence,
        tier: parsed.tier,
        tierCappedBy: parsed.tierCappedBy,
        lastConfirmedRunId: parsed.lastConfirmedRunId,
        unmeasuredReason: parsed.unmeasuredReason,
        unmeasuredDetail: parsed.unmeasuredDetail,
        retiredAt: null,
      };
      await prisma.coverageTypeObligation.upsert({
        where: { itemId_testType: { itemId, testType: parsed.testType } },
        create: { ...data, itemId, testType: parsed.testType },
        update: data,
      });
    });
    if (ok) writtenObligations.push(`${cell.itemKey}\u0000${cell.testType}`);
  }

  const truncated = budget <= 0;
  const written = writtenFieldKeys.length + writtenStateKeys.length + writtenObligations.length;

  /*
   * THE SWEEP. Only when nothing failed and nothing was truncated — a cut row
   * list followed by "retire everything I did not write" would retire the cells
   * the cap hid, and the figure would rise because our own budget bit.
   */
  if (failed === 0 && !truncated) {
    await attempt(async () => {
      await prisma.coverageFormField.updateMany({
        where: {
          projectId,
          retiredAt: null,
          ...(writtenFieldKeys.length > 0 ? { fieldKey: { notIn: writtenFieldKeys } } : {}),
        },
        data: { retiredAt: new Date() },
      });
    });
    await attempt(async () => {
      await prisma.coverageItemState.updateMany({
        where: {
          projectId,
          retiredAt: null,
          /*
           * SCOPED BY `kind` to the cells THIS pass produces. The page-state,
           * error-state and data-variant adapters write PAGE_*, ERROR_* and
           * DATA_* rows into this same table, and an unscoped sweep would
           * retire another producer's cells on every recompute.
           */
          kind: { in: [...fieldCoverageCellKinds()] },
          ...(writtenStateKeys.length > 0 ? { stateKey: { notIn: writtenStateKeys } } : {}),
        },
        data: { retiredAt: new Date() },
      });
    });
  }

  return { attempted, written, failed, firstError, truncated };
}

/**
 * ── THE ROLLUP WRITE PATH: `CoverageRollup` AND `CoverageHistory` ───────────
 *
 * One row per (snapshot, scope), where a scope is the headline, one dimension,
 * one feature, one team, or a combination. `rollupScopeKey` builds the identity
 * and it is NEVER spelled here — the schema's own refinement recomputes it from
 * the columns and refuses the row if the two disagree, which is the guard.
 *
 * ── WHY THE KEY IS ONE TEXT COLUMN AND NOT THREE NULLABLE ONES ─────────────
 *
 * PostgreSQL treats NULLs in a unique index as DISTINCT, so
 * `UNIQUE(snapshotId, dimension, feature, teamId)` would let the headline row —
 * all three null — be written an unbounded number of times, and this upsert
 * would silently stop being idempotent. Every duplicate is a second
 * denominator for the same subject, which is how one screen comes to disagree
 * with another about one percentage.
 *
 * ── THE HISTORY ROW CARRIES COMPARABILITY, NOT A DELTA WE WANTED ───────────
 *
 * `snapshotDelta` decides whether the two snapshots may be subtracted at all,
 * and a delta across two crawl fingerprints is NULL with the reason in its
 * place. Subtracting two percentages always succeeds, which is exactly why the
 * decision has to be a function and not a convention: "coverage fell 9 points"
 * over two different crawls is an artefact of our own enumeration changing, and
 * it will be read as a regression by everybody who sees it — in the PR comment,
 * on the badge, in the digest.
 */
async function persistRollups(input: {
  orgId: string;
  projectId: string;
  snapshotId: string;
  rows: readonly CoverageRollupRow[];
  /** The comparability inputs for THIS snapshot. */
  current: ComparabilityInput;
  /** The previous snapshot, when there is one. Null is the no-baseline case. */
  previous: {
    id: string;
    percent: number | null;
    crawlFingerprint: string | null;
    denominatorDefinition: string | null;
  } | null;
}): Promise<DimensionWriteResult> {
  const { orgId, projectId, snapshotId, rows } = input;
  let attempted = 0;
  let failed = 0;
  let written = 0;
  let firstError: string | null = null;

  for (const row of rows.slice(0, MAX_ROLLUP_ROWS)) {
    attempted += 1;
    try {
      const parsed = coverageRollupSchema.parse(row);
      const data = {
        orgId,
        projectId,
        dimension: parsed.dimension,
        feature: parsed.feature,
        teamId: parsed.teamId,
        numerator: parsed.numerator,
        denominator: parsed.denominator,
        percent: parsed.percent,
        tier: parsed.tier,
        unmeasured: parsed.unmeasured,
        unmeasuredReason: parsed.unmeasuredReason,
        unmeasuredDetail: parsed.unmeasuredDetail,
        /*
         * Spread into plain objects rather than cast: Prisma's Json input type
         * rejects a typed interface array, and a cast here would silence the
         * one check that notices if `DimensionCapBite` ever gains a
         * non-serialisable field.
         */
        caps: parsed.caps.map((cap) => ({ ...cap })),
        exclusions: [...parsed.exclusions],
      };
      await prisma.coverageRollup.upsert({
        where: { snapshotId_scopeKey: { snapshotId, scopeKey: parsed.scopeKey } },
        create: { ...data, snapshotId, scopeKey: parsed.scopeKey },
        update: data,
      });
      written += 1;
    } catch (error) {
      failed += 1;
      firstError ??= error instanceof Error ? error.message : String(error);
    }
  }

  /*
   * THE HISTORY ROW FOR THE HEADLINE SCOPE. One per (snapshot, scope), and only
   * for the headline today: a per-feature history needs the previous
   * snapshot's per-feature rollups read back, which is a second query per
   * bucket and buys nothing until a surface renders a per-feature trend. The
   * headline is what the PR comment, the badge and the digest all quote.
   */
  const headline = rows.find((row) => row.scopeKey === HEADLINE_SCOPE_KEY);
  if (headline !== undefined) {
    attempted += 1;
    try {
      const delta = snapshotDelta({
        current: { ...input.current, percent: headline.percent },
        previous:
          input.previous === null
            ? null
            : {
                crawlFingerprint: input.previous.crawlFingerprint,
                denominatorDefinition: input.previous.denominatorDefinition,
                percent: input.previous.percent,
              },
      });
      const data = {
        orgId,
        projectId,
        dimension: headline.dimension,
        feature: headline.feature,
        teamId: headline.teamId,
        numerator: headline.numerator,
        denominator: headline.denominator,
        percent: headline.percent,
        /*
         * The rung the figure was taken at, required with no default: a history
         * row that does not say which bar it cleared is comparable to no other
         * row, and two rows silently taken at NAVIGATED and PASSING look
         * identical on a trend line.
         */
        tier: headline.tier,
        previousSnapshotId: input.previous?.id ?? null,
        previousPercent: input.previous?.percent ?? null,
        /*
         * NULL unless COMPARABLE, by construction: `snapshotDelta` returns null
         * for every uncomparable pair and the reason travels in `comparability`
         * and `comparabilityDetail`. Nothing here recomputes a subtraction.
         */
        deltaPercent: delta.deltaPercent,
        crawlFingerprint: input.current.crawlFingerprint,
        comparability: delta.comparability,
        comparabilityDetail: delta.detail,
      };
      await prisma.coverageHistory.upsert({
        where: { snapshotId_scopeKey: { snapshotId, scopeKey: HEADLINE_SCOPE_KEY } },
        create: { ...data, snapshotId, scopeKey: HEADLINE_SCOPE_KEY, firstSeenAt: new Date() },
        update: data,
      });
      written += 1;
    } catch (error) {
      failed += 1;
      firstError ??= error instanceof Error ? error.message : String(error);
    }
  }

  return {
    attempted,
    written,
    failed,
    firstError,
    truncated: rows.length > MAX_ROLLUP_ROWS,
  };
}

// ─── Reading the dimensions back ─────────────────────────────────────────────

/** One axis as the API and the web app read it. No `percent` — see below. */
export interface StoredDimension {
  dimension: CoverageDimensionKind;
  cells: number;
  measured: number;
  unmeasured: number;
  unmeasuredReason: DimensionUnmeasuredReason | null;
  unmeasuredDetail: string | null;
  /** The ladder over the MEASURED cells only. Null percent at every empty rung. */
  tiers: CoverageLadder;
  caps: DimensionCapBite[];
  /**
   * TRUE when an extractor produced tiers for at least one cell. The predicate
   * every renderer asks before printing a figure, so that "not measured" and
   * "0%" are one BRANCH apart rather than one rounding apart.
   */
  wasMeasured: boolean;
  /** Which module answers for this axis, or why nothing does. */
  producer: DimensionRegistryEntry;
}

export interface StoredDimensionBreakdown {
  /** All thirteen axes, each with its own denominator. */
  dimensions: StoredDimension[];
  /** Printed where a combined figure would go. */
  rule: string;
  /** Every cap that bit, across every axis, as a count AND a reason. */
  caps: DimensionCapBite[];
  /**
   * How many stored cells back each axis, by axis, from the three cell tables.
   *
   * NULL means THIS DEPLOYMENT CANNOT ANSWER — the migration that mints the
   * tables is written and unapplied — and must never render as "no cells
   * exist". An empty aggregate would read as a project whose breakdown is
   * genuinely empty, which is the opposite of the truth and the worse of the
   * two wrong answers.
   */
  storedCells: Record<CoverageDimensionKind, number> | null;
  why: string;
}

/**
 * ── THE READ PATH FOR THE THREE CELL TABLES ─────────────────────────────────
 *
 * The counterpart of `persistDimensionCells`. It exists in the SAME round as
 * the write path because a table with only one of the two is what `check:wiring`
 * calls DISCONNECTED, and two consecutive keystones shipped models that way.
 *
 * ── WHY COUNTS AND NOT A LIST ───────────────────────────────────────────────
 *
 * The per-cell list is paged by `GET /coverage/:projectId/dimensions/:dimension`
 * — filters before the cap, a stable cursor, and the cap that bit reported in
 * the payload. A second un-paged list here would be a second answer to the same
 * question, and the one that is not walkable is the one that would get quoted.
 *
 * ── `storedCells: null` IS NOT AN EMPTY RECORD ──────────────────────────────
 *
 * Same contract as `coverageProvenance` above and for the same reason.
 */
export async function dimensionBreakdown(input: {
  projectId: string;
  measured: MeasuredDimensions;
}): Promise<StoredDimensionBreakdown> {
  const dimensions = input.measured.report.measurements.map(
    (measurement): StoredDimension => ({
      dimension: measurement.dimension,
      cells: measurement.cells,
      measured: measurement.measured,
      unmeasured: measurement.unmeasured,
      unmeasuredReason: measurement.unmeasuredReason,
      unmeasuredDetail: measurement.unmeasuredDetail,
      tiers: measurement.tiers,
      caps: measurement.caps,
      wasMeasured: dimensionWasMeasured(measurement),
      producer: DIMENSION_REGISTRY[measurement.dimension],
    }),
  );

  let storedCells: Record<CoverageDimensionKind, number> | null = null;
  let why =
    'Each figure is read off its own dimension ladder, over its own denominator. An axis with ' +
    '`wasMeasured: false` has NO percentage — it is not 0%, and the reason says whether that is ' +
    'our missing extractor, a crawl nobody ran, or a cap that bit.';
  try {
    const [fieldGroups, stateGroups, obligations] = await Promise.all([
      prisma.coverageFormField.groupBy({
        by: ['kind'],
        where: { projectId: input.projectId, retiredAt: null },
        _count: { _all: true },
      }),
      prisma.coverageItemState.groupBy({
        by: ['kind'],
        where: { projectId: input.projectId, retiredAt: null },
        _count: { _all: true },
      }),
      prisma.coverageTypeObligation.count({
        where: { projectId: input.projectId, retiredAt: null },
      }),
    ]);

    /*
     * The dimension is DERIVED from the cell kind through `CELL_KIND_DIMENSION`
     * and never stored twice. One cell vocabulary and one mapping, so a reader
     * cannot file a COMPONENT_LOADING row under COMPONENT_STATE here while a
     * writer files it under COMPONENT there.
     */
    const counts = Object.fromEntries(
      COVERAGE_DIMENSIONS.map((dimension) => [dimension, 0]),
    ) as Record<CoverageDimensionKind, number>;
    for (const group of [...fieldGroups, ...stateGroups]) {
      counts[CELL_KIND_DIMENSION[group.kind]] += group._count._all;
    }
    counts.TEST_TYPE += obligations;
    storedCells = counts;
  } catch {
    /*
     * The tables do not exist on this deployment (the migration is written and
     * unapplied). Not an empty answer — NO answer.
     */
    why +=
      ' The per-cell tables could not be read on this deployment, so `storedCells` is NULL rather ' +
      'than zero: the migration that mints CoverageFormField, CoverageItemState and ' +
      'CoverageTypeObligation is written and not yet applied here. Read NULL as "cannot answer", ' +
      'never as "no cells exist".';
  }

  return {
    dimensions,
    rule: input.measured.report.rule,
    caps: input.measured.report.caps,
    storedCells,
    why,
  };
}

// ─── The attestation: write, read, and the one claim per fingerprint ─────────

/**
 * Store an attestation, or return the one that already says this.
 *
 * `@@unique([projectId, fingerprint])` is what makes "is this the document you
 * were sent?" answerable: the fingerprint is stable over (denominator
 * definition, crawl version, item set), so re-exporting an unchanged
 * measurement returns the SAME row rather than minting a second document that
 * says the same thing with a different id. The clock and the issuer are
 * deliberately OUT of the fingerprint — two exports of one measurement are one
 * claim — which is why this is an upsert on the fingerprint and not a create.
 *
 * ── THE ENVELOPE CANNOT BE BUILT WITHOUT ITS SCOPE STATEMENT ────────────────
 *
 * `CoverageAttestation` (the type) is nominal: `attest` is the only door, and
 * it throws on an empty scope statement, an empty denominator definition, a
 * numerator above its denominator and a percentage on an empty denominator. So
 * this function takes the ATTESTED value and cannot be handed a hand-assembled
 * literal with no disclosures in it — which is the shape a writer in a hurry
 * produces, and it compiles.
 */
export async function storeAttestation(input: {
  orgId: string;
  projectId: string;
  attestation: CoverageAttestation;
}): Promise<{ id: string; created: boolean } | null> {
  const payload = attestationPayload(input.attestation);
  const data = {
    orgId: input.orgId,
    projectId: input.projectId,
    snapshotId: payload.snapshotId,
    crawlVersion: payload.crawlVersion,
    crawlFingerprint: payload.crawlFingerprint,
    denominatorDefinition: payload.denominatorDefinition,
    percent: payload.percent,
    denominator: payload.denominator,
    covered: payload.covered,
    scopeStatement: payload.scopeStatement,
    unmeasured: payload.unmeasured.map((entry) => ({ ...entry })),
    caps: payload.caps.map((cap) => ({ ...cap })),
    issuedByUserId: payload.issuedByUserId,
  };
  try {
    const existing = await prisma.coverageAttestation.findUnique({
      where: { projectId_fingerprint: { projectId: input.projectId, fingerprint: payload.fingerprint } },
      select: { id: true },
    });
    if (existing) return { id: existing.id, created: false };
    const row = await prisma.coverageAttestation.create({
      data: { ...data, fingerprint: payload.fingerprint },
      select: { id: true },
    });
    return { id: row.id, created: true };
  } catch {
    /*
     * The table does not exist on this deployment. NULL, and the caller
     * discloses it: an export that could not be RECORDED is still a valid
     * document — every claim in it was computed — and the thing that is missing
     * is the record that we issued it. Refusing to serve the document would
     * cost the customer the artifact to protect our own bookkeeping.
     */
    return null;
  }
}

/** The attestations issued for a project, newest first. The read half. */
export async function storedAttestations(
  projectId: string,
  limit = 20,
): Promise<Array<{
  id: string;
  fingerprint: string;
  percent: number | null;
  denominator: number;
  covered: number;
  crawlVersion: string;
  crawlFingerprint: string | null;
  issuedAt: Date;
  scopeStatement: string;
}> | null> {
  try {
    return await prisma.coverageAttestation.findMany({
      where: { projectId },
      orderBy: { issuedAt: 'desc' },
      take: limit,
      /*
       * `unmeasured` and `caps` are deliberately NOT selected. They are the
       * whole scope section of a document and this is a LIST — serving them on
       * every row would make a page of twenty attestations several hundred
       * kilobytes of repeated disclosure, and the list's job is to let a reader
       * pick the fingerprint they want.
       */
      select: {
        id: true,
        fingerprint: true,
        percent: true,
        denominator: true,
        covered: true,
        crawlVersion: true,
        crawlFingerprint: true,
        issuedAt: true,
        scopeStatement: true,
      },
    });
  } catch {
    // NULL is "this deployment cannot answer", never "none were issued".
    return null;
  }
}
