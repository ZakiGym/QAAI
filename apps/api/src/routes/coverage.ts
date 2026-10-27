/**
 * Coverage gap analysis — the tests you never wrote.
 *
 * Every other reporting endpoint in this API describes tests that exist. This
 * one describes their absence, by putting the two halves we already hold side by
 * side: the FlowMap (what the crawler proved the application can do) and the
 * Test rows (what is actually asserted). The difference is the answer.
 *
 * This file is only the wiring. All of the judgement lives in
 * packages/agent/src/coverage.ts, and none of it calls a model — a gap is a
 * claim about somebody's work, so it has to be arguable from evidence rather
 * than asserted by a language model. The model is invited exactly once, at
 * POST /propose, to WRITE the missing test, and it gets there through the
 * Generator that every other test in this product came from.
 *
 *   GET  /coverage/:projectId          ranked gaps, each with its evidence
 *   POST /coverage/:projectId/propose  turn selected gaps into plan items and
 *                                      queue the Generator on them
 *
 * TWO WIRING DECISIONS WORTH THE COMMENT.
 *
 * First: route extraction is NOT re-derived here. `../lib/impact.js` already
 * pulls route literals out of Test.code and Test.spec — string-level, cap-
 * guarded, with the template and toHaveURL handling that took real bugs to get
 * right — so this file lifts those functions rather than writing a second,
 * worse copy. packages/agent cannot import from an app, which is why the
 * analysis takes routes as an input and this is the one place that seam exists.
 *
 * Second: `indexTests` from that module is deliberately NOT used, even though
 * it is right there and returns almost the same shape. It folds a test's
 * *feature name* into its route set via the flow map, which is correct for
 * impact analysis ("a checkout test answers for a checkout change") and
 * circular for this one. A test labelled Checkout would be credited with
 * covering every checkout route without asserting a thing, and coverage the
 * suite does not have is the single claim this feature must never make.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { FIXTURE_PREFIX, QUEUE_NAMES } from '@qaai/shared';
import type { Priority, SnapshotComparability, TestType } from '@qaai/shared';
/*
 * The dimension vocabulary, the attestation envelope and the ONE comparability
 * predicate.
 *
 * `deltaIsMeaningful` is imported rather than spelled as
 * `comparability === 'COMPARABLE'` here, and that is not fastidiousness: five
 * surfaces print this delta (this payload, the PR comment, the check-run
 * summary, the badge and the digest), and the first one that decides for itself
 * what counts as comparable is the one that shows a team a regression nobody
 * caused.
 */
import {
  CELL_KIND_DIMENSION,
  COVERAGE_CELL_KINDS,
  COVERAGE_DIMENSIONS,
  HEADLINE_SCOPE_KEY,
  attest,
  attestationPayload,
  attestationScopeLines,
  cellKindsFor,
  deltaIsMeaningful,
  dimensionPercentAt,
  dimensionWasMeasured,
} from '@qaai/shared';
import { dimensionUnmeasuredDisclosures } from '@qaai/agent';
import type {
  CoverageAttestation,
  CoverageDimensionKind,
  DimensionMeasurement,
} from '@qaai/shared';
import { quarantineSuppresses } from '@qaai/runner';
import {
  GAP_KINDS,
  analyzeCoverage,
  gapProvenance,
  planItemForGap,
  type CoverageExecutionFact,
  type CoverageGap,
  type CoverageReport,
  type CoverageTestInput,
  type GapProvenance,
} from '@qaai/agent';
import {
  routeLiteralsFromCode,
  routesFromSpec,
  type CoverageTruncation,
} from '../lib/impact.js';
import {
  CRAWL_VERSION,
  computeCoverage,
  coverageProvenance,
  dimensionBreakdown,
  storeAttestation,
  storedAttestations,
  type ComputedCoverage,
} from '../lib/coverage-store.js';
import { prisma } from '../lib/prisma.js';
import { ApiError, badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { audit } from '../lib/audit.js';
import { env } from '../env.js';
import { actorOf, requireAuth, requireRole, requireScope } from '../middleware/auth.js';

export const coverageRouter: Router = Router();

coverageRouter.use(requireAuth);

/** At most this many gaps become plan items in one request. */
const MAX_PROPOSALS = 25;

/**
 * The runnable set, mirroring POST /runs and /impact/analyze: disabled tests and
 * `fixtures/` rows are not tests, and counting them as coverage would mean
 * telling a team a route is tested by a spec that never executes.
 */
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
   * The role each test runs as. Read here because the analysis cannot see it
   * any other way: a test bound to an auth profile has NO sign-in anywhere in
   * its source — the runner injects the profile's storageState before the first
   * navigation — so the heuristic that reads the code for a login finds nothing
   * and reports the test as a signed-out visitor.
   *
   * Leaving these two columns out of this select is what made the
   * UNREACHED_AUTH_ROUTE gap a loop: the gap asked for an authenticated test,
   * the test was written and bound and passed, and the next analysis reported
   * the same gap because the only evidence that the test signs in was a column
   * nobody selected.
   */
  authProfileId: true,
  authProfileRequired: true,
} as const;

type TestRow = {
  id: string;
  name: string;
  filePath: string;
  code: string | null;
  spec: unknown;
  tags: string[];
  feature: string | null;
  priority: string;
  type: string;
  authProfileId: string | null;
  authProfileRequired: boolean;
};

/**
 * Test rows → the analysis's input, with impact.ts doing the extraction.
 *
 * `coverageTruncated` is the load-bearing field. When either extractor hits a
 * cap it means we read only part of what this test declares, and the part we
 * did not read is exactly where the missing coverage might be. Passing that
 * through is what keeps such a test in the UNKNOWN bucket instead of letting
 * its silence be counted as a gap somewhere else.
 */
export function toCoverageInputs(tests: TestRow[]): CoverageTestInput[] {
  return tests.map((test) => {
    const truncation: CoverageTruncation = { truncated: false };
    const routes = new Set<string>();
    for (const route of routeLiteralsFromCode(test.code ?? '', truncation)) routes.add(route);
    for (const route of routesFromSpec(test.spec, 0, new Set<string>(), truncation)) {
      routes.add(route);
    }

    return {
      id: test.id,
      name: test.name,
      filePath: test.filePath,
      feature: test.feature,
      priority: test.priority as Priority,
      testType: test.type as TestType,
      tags: test.tags,
      routes: [...routes],
      code: test.code,
      coverageTruncated: truncation.truncated,
      authProfileId: test.authProfileId,
      authProfileRequired: test.authProfileRequired,
    };
  });
}

/**
 * The latest result per test, plus whether its quarantine is in force.
 *
 * ── WHY THE QUARANTINE COLUMN IS NOT OPTIONAL HERE ──────────────────────────
 *
 * `Test.quarantined` and `Test.quarantineExpiresAt` live on Test, not on
 * TestResult, so a query over results alone cannot tell whether the result it
 * just read is one any gate will look at. Reading them is what stopped a
 * quarantined test from closing a gap in this report while
 * `packages/runner/src/gates.ts` excluded it from every rule — two surfaces of
 * one product giving opposite answers about one test.
 *
 * `quarantineSuppresses` and not the boolean: an EXPIRED quarantine gates
 * again, and withholding coverage from a test whose suppression ran out is
 * wrong in the pessimistic direction, which is still wrong.
 *
 * A quarantined test with NO result at all is still reported, as SKIPPED with
 * no run id: "its only test is suppressed" and "its only test has never run"
 * are different findings and the analysis can only tell them apart if both
 * facts reach it.
 */
async function loadExecutions(projectId: string): Promise<CoverageExecutionFact[]> {
  const [results, quarantined] = await Promise.all([
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
      // Bounded, newest-first, so the cap only ever drops history. The
      // analysis wants the LATEST result per test and nothing older.
      take: MAX_RESULTS_READ,
    }),
    prisma.test.findMany({
      where: { projectId, quarantined: true },
      select: { id: true, quarantined: true, quarantineExpiresAt: true },
    }),
  ]);

  const now = new Date();
  const suppressed = new Set(
    quarantined.filter((test) => quarantineSuppresses(test, now)).map((test) => test.id),
  );

  const latest = new Map<string, CoverageExecutionFact>();
  for (const result of results) {
    if (!result.testId || latest.has(result.testId)) continue;
    // Newest first, so the first sighting of a test IS its latest result.
    latest.set(result.testId, {
      testId: result.testId,
      runId: result.runId,
      status: result.status,
      atIso: result.createdAt.toISOString(),
      retriedAndPassed: result.retriedAndPassed,
      quarantined: suppressed.has(result.testId),
    });
  }
  for (const id of suppressed) {
    if (latest.has(id)) continue;
    latest.set(id, {
      testId: id,
      runId: '',
      status: 'SKIPPED',
      atIso: new Date(0).toISOString(),
      quarantined: true,
    });
  }
  return [...latest.values()];
}

/** Bounded for the reason above. The cap only ever drops older history. */
const MAX_RESULTS_READ = 20_000;

interface ProjectCoverage {
  report: CoverageReport;
  /** The crawl the report was computed against; the plan is pinned to it. */
  flowMapId: string | null;
  flowMapVersion: number | null;
}

/**
 * Both endpoints compute the report the same way, from the same latest crawl.
 * Sharing it is what makes the fingerprint check on /propose mean anything: the
 * two calls are comparing the same computation, not two similar ones.
 */
async function coverageFor(projectId: string, limit?: number): Promise<ProjectCoverage> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const [tests, flowMap, executions] = await Promise.all([
    prisma.test.findMany({
      where: {
        projectId: project.id,
        disabledAt: null,
        filePath: { not: { startsWith: FIXTURE_PREFIX } },
      },
      select: TEST_SELECT,
    }),
    // Latest crawl only. An older version describes an app that no longer
    // exists, and a "gap" on a route that was deleted last month is noise that
    // costs this report its credibility.
    prisma.flowMap.findFirst({
      where: { projectId: project.id },
      orderBy: { version: 'desc' },
      select: { id: true, graph: true, version: true, environmentId: true },
    }),
    loadExecutions(project.id),
  ]);

  /*
   * The roles a generated test could assume, read from THE ENVIRONMENT THIS
   * CRAWL CAME FROM and not from the project.
   *
   * That distinction is the whole correctness of it: an auth profile holds a
   * session minted against one environment's base URL, and a test proposed from
   * a staging crawl must be offered staging's profiles. Taking every profile in
   * the project would let a gap found in staging propose a test signed in with
   * production's session.
   *
   * An empty list is an ordinary input, not a failure: the analysis then reports
   * each auth gap as unclosable and names the missing setup, which is a true
   * statement the customer can act on. Nothing is invented to fill it.
   */
  const authProfiles = flowMap
    ? await prisma.authProfile.findMany({
        where: { environmentId: flowMap.environmentId },
        orderBy: { name: 'asc' },
        // Id and name only. Choosing which role a test assumes needs neither
        // the config nor the live storageState, and both of those are
        // secret-adjacent values that would end up inside gap evidence.
        select: { id: true, name: true, kind: true },
      })
    : [];

  const report = analyzeCoverage({
    flowMapGraph: flowMap?.graph ?? null,
    tests: toCoverageInputs(tests),
    authProfiles,
    /*
     * THE RUN REPORT, JOINED. Without it this analysis had no way to tell a
     * test that ran green an hour ago from one that has never executed, one
     * that always fails, and one the gates suppress entirely — all four closed
     * a gap identically. See `CoverageExecutionFact` in packages/agent.
     */
    executions,
    ...(limit === undefined ? {} : { limit }),
  });

  return {
    report,
    flowMapId: flowMap?.id ?? null,
    // The row's version is authoritative; the serialised graph's copy can lag.
    flowMapVersion: flowMap?.version ?? report.flowMapVersion,
  };
}

// ─── The cache, and why its age is in the payload ────────────────────────────

/**
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * This report was recomputed synchronously, on the API thread, on every single
 * request — measured at 3.6s with 2,000 controls and 36.7s at 20,000 — and the
 * coverage screen fired it with `?proposals=true` on EVERY page load. Node is
 * single-threaded: for those 36 seconds every other request in the process,
 * including health checks, waited behind one person opening a tab.
 *
 * ── WHY A VALIDITY KEY AND NOT A TTL ────────────────────────────────────────
 *
 * A TTL alone means a team that adds a test sees the old number for however
 * long the window is, and the one thing this screen is for is watching that
 * number move when you write a test. So the cache is keyed on the INPUTS: the
 * test count, the newest `Test.updatedAt`, the flow map's identity and version,
 * and the result count. Adding, editing, disabling, quarantining or deleting a
 * test moves one of those, so the entry is invalid immediately and no clock is
 * involved. The TTL is only the backstop for an input this key does not watch
 * (an auth profile renamed, a waiver expiring).
 *
 * Two cheap aggregates replace a 3.6-second recompute; when they agree with the
 * stored key, the stored report is returned.
 *
 * ── AND WHY THE AGE IS IN THE RESPONSE ──────────────────────────────────────
 *
 * A cached number that does not say how old it is is a number nobody can
 * defend in the meeting it was brought to. `cache.computedAtIso` and
 * `cache.ageMs` are on every response, hit or miss, so "38%" is always "38% as
 * of 40 seconds ago" — and a reader who needs it as of now can pass
 * `?cache=false`. A silently stale figure is a cap that bit without being
 * disclosed, which is one of the lies this product cannot afford.
 */
interface CachedCoverage extends ProjectCoverage {
  key: string;
  computedAt: number;
}

/** In-process, per worker, and bounded. See `evictOldest`. */
const coverageCache = new Map<string, CachedCoverage>();
const COVERAGE_CACHE_TTL_MS = 5 * 60_000;
const COVERAGE_CACHE_MAX_PROJECTS = 50;

/** What a caller is told about the number's age. Present on hit AND on miss. */
export interface CoverageCacheState {
  hit: boolean;
  computedAtIso: string;
  ageMs: number;
  ttlMs: number;
  /** The inputs the entry is keyed on, so a reader can see what invalidates it. */
  keyedOn: string;
  why: string;
}

/**
 * The inputs this report depends on, as one string.
 *
 * `_max.updatedAt` rather than a hash of every row: it moves on any write to
 * any test in the project, which is the whole set of changes that can alter the
 * numerator, and it costs one indexed aggregate.
 */
async function validityKey(projectId: string): Promise<string> {
  const [tests, flowMap, results] = await Promise.all([
    prisma.test.aggregate({
      where: { projectId, disabledAt: null, filePath: { not: { startsWith: FIXTURE_PREFIX } } },
      _count: { id: true },
      _max: { updatedAt: true },
    }),
    prisma.flowMap.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
      select: { id: true, version: true },
    }),
    // Results change the ladder without touching a Test row: a run finishing
    // is exactly the event that should move this number.
    prisma.testResult.count({ where: { test: { projectId } } }),
  ]);
  return [
    tests._count.id,
    tests._max.updatedAt?.toISOString() ?? 'none',
    flowMap?.id ?? 'none',
    flowMap?.version ?? 0,
    results,
  ].join('|');
}

const KEYED_ON =
  'enabled test count, newest Test.updatedAt, latest FlowMap id and version, TestResult count';

/**
 * Drop every cached report.
 *
 * Exported because an in-process cache that nothing can clear is untestable:
 * the entry is keyed on the project's inputs, so two tests that seed the same
 * shape would have the second served the first's report, and the suite would
 * pass or fail depending on the order vitest happened to run them in.
 *
 * It is NOT a correctness escape hatch for production. The validity key covers
 * every input that can move the numerator (see `validityKey`); the TTL covers
 * the ones it does not watch, and `?cache=false` is the per-request answer.
 */
export function resetCoverageCache(): void {
  coverageCache.clear();
}

/** Oldest-first, so one busy install cannot pin fifty projects in memory. */
function evictOldest(): void {
  while (coverageCache.size > COVERAGE_CACHE_MAX_PROJECTS) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, entry] of coverageCache) {
      if (entry.computedAt < oldestAt) {
        oldestAt = entry.computedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) return;
    coverageCache.delete(oldestKey);
  }
}

async function cachedCoverageFor(
  projectId: string,
  useCache: boolean,
): Promise<ProjectCoverage & { cache: CoverageCacheState }> {
  const now = Date.now();
  const key = await validityKey(projectId);
  const entry = coverageCache.get(projectId);

  if (
    useCache &&
    entry !== undefined &&
    entry.key === key &&
    now - entry.computedAt < COVERAGE_CACHE_TTL_MS
  ) {
    return {
      report: entry.report,
      flowMapId: entry.flowMapId,
      flowMapVersion: entry.flowMapVersion,
      cache: {
        hit: true,
        computedAtIso: new Date(entry.computedAt).toISOString(),
        ageMs: now - entry.computedAt,
        ttlMs: COVERAGE_CACHE_TTL_MS,
        keyedOn: KEYED_ON,
        why: `Served from cache, computed ${Math.round((now - entry.computedAt) / 1000)}s ago. It is invalidated by any change to ${KEYED_ON}, so it cannot be stale with respect to a test you just added. Pass ?cache=false to recompute.`,
      },
    };
  }

  const fresh = await coverageFor(projectId);
  const computedAt = Date.now();
  coverageCache.set(projectId, { ...fresh, key, computedAt });
  evictOldest();
  return {
    ...fresh,
    cache: {
      hit: false,
      computedAtIso: new Date(computedAt).toISOString(),
      ageMs: 0,
      ttlMs: COVERAGE_CACHE_TTL_MS,
      keyedOn: KEYED_ON,
      why: useCache
        ? entry === undefined
          ? 'Computed now: nothing was cached for this project.'
          : 'Computed now: the cached entry was keyed on inputs that have since changed, or it expired.'
        : 'Computed now: the caller passed ?cache=false.',
    },
  };
}

// ─── GET /coverage/:projectId ────────────────────────────────────────────────

const DEFAULT_PAGE = 50;
const MAX_PAGE = 300;

const listQuery = z.object({
  /**
   * PAGE SIZE, not a ceiling on the analysis.
   *
   * It used to be both, and that is register item 8: `limit` was passed
   * straight into `analyzeCoverage`, which sliced the ranked list BEFORE this
   * handler applied `kind` and `minScore`. So a project with 800 untested
   * controls could never name more than 300 of them, and a reader filtering for
   * UNSUBMITTED_FORM got whichever forms happened to fall inside the top 300 by
   * score with no indication that others existed — the list was short AND
   * wrong, which is the worse of the two.
   */
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
  /**
   * The id of the last gap on the previous page. Resumes AFTER it in the
   * filtered, ranked order, so the whole uncovered list is walkable — "name the
   * uncovered 38%" is the product's core promise and it was impossible.
   *
   * An id that is not in the filtered list is a 409, not an empty page: it
   * means the report moved under the caller (a test landed, the app was
   * re-crawled), and silently answering `[]` reads exactly like "you have
   * reached the end".
   */
  cursor: z.string().min(1).max(64).optional(),
  /** Comma-separated GapKind values. Unknown names are a 400, not a silent empty list. */
  kind: z.string().optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  /**
   * Include the deterministic plan item each gap would become. Needs no API key
   * — this is the proposal BEFORE the model writes code — so it is the honest
   * way to see what /propose would do before committing to it.
   */
  proposals: z.enum(['true', '1']).optional(),
  /**
   * `false` recomputes rather than reading the cache. The cached answer always
   * reports its own age, so this exists for a caller that needs the number as
   * of now and not for one that distrusts the age field.
   */
  cache: z.enum(['false', '0']).optional(),
});

coverageRouter.get('/:projectId', requireScope('tests:read'), async (req, res) => {
  const query = listQuery.parse(req.query);
  const projectId = String(req.params.projectId);
  /*
   * NO `limit` IS PASSED INTO THE ANALYSIS. See `listQuery.limit`: the cap has
   * to run after the filters or the filtered list is wrong as well as short.
   * The analysis has its own hard ceiling (MAX_GAPS) and names it in a caveat
   * when it bites.
   */
  const { report, flowMapId, flowMapVersion, cache } = await cachedCoverageFor(
    projectId,
    query.cache === undefined,
  );

  let gaps = report.gaps;
  if (query.kind) {
    const wanted = new Set(
      query.kind
        .split(',')
        .map((k) => k.trim().toUpperCase())
        .filter(Boolean),
    );
    const known = new Set(report.gaps.map((g) => g.kind as string));
    // A typo'd filter that silently returns nothing reads exactly like "you have
    // no gaps of that kind", which is the one wrong answer this endpoint can
    // give. Only reject names that are not in the vocabulary at all.
    const unknownNames = [...wanted].filter((k) => !GAP_KIND_NAMES.has(k));
    if (unknownNames.length > 0) {
      throw badRequest(`Unknown gap kind(s): ${unknownNames.join(', ')}`, {
        known: [...GAP_KIND_NAMES],
        presentInThisProject: [...known],
      });
    }
    gaps = gaps.filter((g) => wanted.has(g.kind));
  }
  if (query.minScore !== undefined) gaps = gaps.filter((g) => g.score >= query.minScore!);

  /*
   * ── THE PAGE, CUT AFTER THE FILTERS ──────────────────────────────────────
   *
   * `matched` is the count of gaps that passed the filters and is EXACT. The
   * page is a window on that list, `nextCursor` is how to ask for the rest, and
   * `hasMore` is stated rather than inferred from a short page — a page the
   * same length as `limit` with nothing after it and a page that is short
   * because the list ended are different, and a client that guesses gets one of
   * them wrong every time.
   */
  const matched = gaps.length;
  let page = gaps;
  if (query.cursor !== undefined) {
    const at = gaps.findIndex((gap) => gap.id === query.cursor);
    if (at === -1) {
      throw conflict(
        'That cursor is not in the current filtered report — a test was added, or the app was re-crawled, so the list moved under you. Re-read the first page.',
        { cursor: query.cursor, fingerprint: report.fingerprint, matched },
      );
    }
    page = gaps.slice(at + 1);
  }
  const size = query.limit ?? DEFAULT_PAGE;
  const hasMore = page.length > size;
  page = page.slice(0, size);

  const wantProposals = query.proposals === 'true' || query.proposals === '1';

  res.json({
    ...report,
    flowMapId,
    flowMapVersion,
    /*
     * Proposals are built for THE PAGE and not for the whole list, which is
     * most of why `?proposals=true` on every screen load stopped mattering:
     * `planItemForGap` is the expensive half of this endpoint and it now runs
     * at most `limit` times instead of once per gap in the project.
     */
    gaps: wantProposals ? page.map((gap) => ({ ...gap, proposal: safeProposal(gap) })) : page,
    filtered: matched !== report.gaps.length,
    page: {
      /** Gaps that passed the filters. EXACT. Do not measure `gaps.length`. */
      matched,
      returned: page.length,
      limit: size,
      hasMore,
      /** Pass as `?cursor=` to continue. Null at the end of the list. */
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      /*
       * ── A WALKABILITY CLAIM THAT WAS TRUE OF THIS HANDLER AND FALSE OF THE
       *    REPORT IT PAGES ──────────────────────────────────────────────────
       *
       * This sentence used to end "and the whole of it is walkable with
       * `nextCursor`", full stop. The paging is correct — the filters do run
       * before the slice, `matched` is exact, and the cursor does reach the end
       * of `report.gaps`. What is NOT true is that `report.gaps` holds every
       * uncovered item: `analyzeCoverage` applies PER-AXIS caps of its own
       * before this handler ever sees the list. MAX_AFFORDANCE_GAPS is 40.
       * Measured on a fixture with 830 uncovered controls and no tests:
       * `totals.gaps` is 66, exactly 40 of those are control gaps, and 790
       * controls are unreachable at any `limit` and through any chain of
       * cursors. The analysis discloses it honestly in `caveats` ("830 controls
       * are never mentioned by any test; the 40 highest-scoring are listed") —
       * and then this payload told the reader the list was complete.
       *
       * Two claims in one sentence, one of them this handler's and one of them
       * not, so the sentence now separates them and names where the other half
       * is answered. `caveats` is spread into this response from the report, so
       * the pointer resolves without a second request.
       */
      rule:
        'The filters run BEFORE this page is cut, so `matched` is the true size of the filtered list and the whole of THAT list is walkable with `nextCursor`. `totals.gaps` is the unfiltered count of the same list. Neither is the count of uncovered items: the analysis applies per-axis caps before this endpoint sees the gaps — MAX_AFFORDANCE_GAPS lists only the 40 highest-scoring control gaps — and every cap that bit is named with its full count in `caveats`. Read `caveats` before concluding this list is complete.',
    },
    cache,
    /*
     * The provenance aggregate, from `TestCoverageEdge`. NULL means this
     * deployment cannot answer — the migration that mints the table is written
     * and unapplied — and must not be read as "no evidence exists".
     */
    provenance: await coverageProvenance(projectId),
    limits: { maxProposalsPerRequest: MAX_PROPOSALS, maxPageSize: MAX_PAGE },
  });
});

/**
 * The vocabulary the `kind` filter is checked against — DERIVED FROM
 * `GAP_KINDS`, not retyped.
 *
 * It used to be a hand-written list of six names, and it had already drifted:
 * `UNEXERCISABLE_SURFACE` was added to `GAP_KINDS` and not here, so a caller
 * filtering for the one gap class whose members are selected FOR being
 * destructive — logout, delete account, cancel subscription — got a 400 saying
 * it was not a known gap kind, while the report it was filtering contained
 * them. A duplicated vocabulary with no guard is how that happens, and the
 * original comment's reason for duplicating it ("so the validator does not
 * depend on the analysis module's export shape") was already false: this file
 * imports five other values from the same module.
 */
const GAP_KIND_NAMES: ReadonlySet<string> = new Set<string>(GAP_KINDS);

/**
 * Record, in the closure ledger, that a human proposed a test for these gaps.
 *
 * ── Why the HUMAN path needs this at all ────────────────────────────────────
 *
 * The ledger (`GapClosure`) is written by the closure campaign on every tick,
 * so a gap the AUTOPILOT worked on has a row with a state, a plan item, a test
 * and a `reopenCount`. A gap a person ticked on the coverage screen had none of
 * that: the plan item existed, the test eventually existed, and the one table
 * that answers "did the test we wrote actually close it?" had never heard of
 * either. The loop the product is sold on had memory for one of its two doors.
 *
 * `campaignId` stays null, and that is the field that keeps the two apart: the
 * column is documented as "the campaign that last worked on it. Null for a gap
 * recorded by a human clicking propose rather than by the autopilot."
 *
 * ── Why it is best-effort, and counted ──────────────────────────────────────
 *
 * The plan is already written by the time this runs, and it is the deliverable:
 * the gaps, the steps read off the crawl and the assertions are all complete
 * and worth having. Throwing here would 500 a request whose plan exists, and a
 * retry would mint a second plan for the same gaps. So a failure costs the
 * MEMORY and not the work — and it is returned to the caller as a number
 * rather than swallowed, because a ledger that quietly missed three rows is a
 * ledger that will later report three gaps nobody ever proposed anything for.
 */
async function recordProposedClosures(args: {
  orgId: string;
  projectId: string;
  items: ReadonlyArray<{ provenance: GapProvenance; rowId: string }>;
  now: Date;
}): Promise<{ recorded: number; failed: number }> {
  let recorded = 0;
  let failed = 0;
  for (const { provenance, rowId } of args.items) {
    try {
      /*
       * Upsert, keyed on (projectId, gapId). A gap seen before — OPEN, or
       * UNVERIFIABLE from a tick with no readable crawl — keeps its history and
       * its `reopenCount`; minting a second row would reset exactly the counter
       * that says "your generator keeps producing a test that does not close
       * this". Same write the close-loop tick makes, deliberately.
       */
      await prisma.gapClosure.upsert({
        where: { projectId_gapId: { projectId: args.projectId, gapId: provenance.gapId } },
        create: {
          orgId: args.orgId,
          projectId: args.projectId,
          gapId: provenance.gapId,
          gapKind: provenance.gapKind,
          gapTitle: provenance.gapTitle,
          planItemId: rowId,
          state: 'PROPOSED',
          why: `Proposed by hand from the coverage screen at rank score ${provenance.gapScore}. Plan item ${rowId}.`,
          proposedAt: args.now,
          lastCheckedAt: args.now,
        },
        update: {
          planItemId: rowId,
          gapKind: provenance.gapKind,
          gapTitle: provenance.gapTitle,
          state: 'PROPOSED',
          why: `Re-proposed by hand from the coverage screen at rank score ${provenance.gapScore}. Plan item ${rowId}.`,
          proposedAt: args.now,
          lastCheckedAt: args.now,
          /*
           * `testId` is deliberately NOT cleared, and neither is
           * `reopenCount`: proposing a gap again does not undo the test that
           * was written for it last time, and it certainly does not undo the
           * record of how often this gap has come back.
           */
        },
      });
      recorded += 1;
    } catch {
      // Per gap, so one unwritable row does not cost the others theirs.
      failed += 1;
    }
  }
  return { recorded, failed };
}

/**
 * A proposal is a preview, and a preview must never be able to lose the report.
 * If one gap has a shape `planItemForGap` cannot express, the reader still gets
 * every other gap and an explicit null for this one.
 */
function safeProposal(gap: CoverageGap): ReturnType<typeof planItemForGap> | null {
  try {
    return planItemForGap(gap);
  } catch {
    return null;
  }
}

// ─── POST /coverage/:projectId/propose ───────────────────────────────────────

const proposeSchema = z.object({
  gapIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_PROPOSALS),
  /**
   * The fingerprint from the GET that produced these ids. Optional, and checked
   * when supplied: a human ticking gaps on a screen that went stale ten minutes
   * ago should be told, not quietly handed a test for a gap somebody already
   * closed.
   */
  fingerprint: z.string().max(64).optional(),
});

coverageRouter.post(
  '/:projectId/propose',
  requireRole('MEMBER'),
  requireScope('tests:write'),
  async (req, res) => {
    const actor = actorOf(req);
    const projectId = String(req.params.projectId);
    const input = proposeSchema.parse(req.body);

    const { report, flowMapId, flowMapVersion } = await coverageFor(projectId);

    if (!report.crawled) {
      throw unprocessable(
        'This project has no readable crawl, so there are no gaps to propose tests for. Run the Explorer first.',
      );
    }
    if (input.fingerprint && input.fingerprint !== report.fingerprint) {
      throw conflict(
        'The coverage report has changed since you looked at it — tests were added, or the app was re-crawled. Re-read GET /coverage/:projectId and choose again.',
        { yours: input.fingerprint, current: report.fingerprint },
      );
    }

    const byId = new Map(report.gaps.map((gap) => [gap.id, gap]));
    /*
     * Deduplicate the request before doing anything with it.
     *
     * The same gap id arriving twice is a "select all" over a list that used to
     * show the same finding more than once. Honouring both would mint two
     * identical PlanItems and hand the Generator the same work twice, which is
     * the opposite of what a coverage report is for. Fixed at the source in
     * coverage.ts too; this is the belt to that pair of braces, because a stale
     * client can still send repeats.
     */
    const requestedIds = [...new Set(input.gapIds)];
    const selected = requestedIds.map((id) => byId.get(id)).filter((g): g is CoverageGap => Boolean(g));
    const missing = requestedIds.filter((id) => !byId.has(id));
    if (selected.length === 0) {
      throw conflict(
        'None of those gaps is in the current report. They were probably closed by a test that has since been added, or the app was re-crawled.',
        { missing },
      );
    }

    /*
     * Built before the write, so a proposal this endpoint cannot express fails
     * the request outright rather than committing half a plan.
     *
     * The row ids are minted here rather than by the database, because the
     * caller needs to know which plan item closes which gap and Prisma makes no
     * promise that a nested `create` array comes back in the order it went in.
     * Reading the mapping off the returned order would be right in testing and
     * wrong, silently, in production.
     */
    const items = selected.map((gap) => ({
      gap,
      rowId: randomUUID(),
      // The three fields the ledger and the plan item both need, taken off the
      // gap itself rather than re-derived on either side of the write.
      provenance: gapProvenance(gap),
      item: planItemForGap(gap),
    }));

    const plan = await prisma.testPlan.create({
      data: {
        orgId: actor.orgId,
        projectId,
        flowMapId,
        summary: `Coverage gaps selected from flow map v${flowMapVersion ?? '?'}: ${selected.length} of ${report.totals.gaps} found. Each item's rationale is the evidence for the gap it closes.`,
        // The plan records what was NOT chosen, the same way the Explorer's does.
        // Without it, a plan of two items looks like a report of two gaps.
        skipped: report.gaps
          .filter((gap) => !selected.includes(gap))
          .slice(0, 50)
          .map((gap) => ({ what: gap.title, why: 'not selected in this request' })),
        items: {
          create: items.map(({ item, provenance, rowId }) => ({
            id: rowId,
            orgId: actor.orgId,
            title: item.title,
            rationale: item.rationale,
            feature: item.feature,
            priority: item.priority,
            testType: item.testType,
            steps: item.steps,
            assertions: item.assertions,
            journeyId: item.journeyId,
            authProfileId: item.authProfileId,
            /*
             * THE PROVENANCE, which this endpoint computed and threw away.
             *
             * It minted the row ids itself and returned
             * `mapping: [{ gapId, planItemId }]` in the response — so the
             * answer existed for the length of one request and then nowhere.
             * QAAI could never afterwards say "this gap is closed by this
             * test", and, much worse, could never notice that it is NOT: a gap
             * whose test was written, bound and passed, and which the next
             * analysis reports again, was indistinguishable from a gap nobody
             * had ever looked at.
             *
             * `gapKind` rides along because `gapId` is a hash of (kind,
             * subject) and tells a human reading the row nothing.
             */
            gapId: provenance.gapId,
            gapKind: provenance.gapKind,
            /*
             * APPROVED, not PROPOSED. The Explorer proposes cold and a human
             * ticks them on the approval screen; here the ticking already
             * happened — that is what this request IS — and leaving them
             * PROPOSED would strand them waiting for an approval nobody is
             * going to give twice.
             */
            state: 'APPROVED' as const,
            decidedBy: actor.userId,
            decidedAt: new Date(),
          })),
        },
      },
      include: { items: { select: { id: true, title: true, priority: true, testType: true } } },
    });

    /*
     * The ledger, written for the human door exactly as the campaign writes it
     * for the autopilot's. Before the response, so the caller is told how many
     * rows the memory actually holds.
     */
    const ledger = await recordProposedClosures({
      orgId: actor.orgId,
      projectId,
      items,
      now: new Date(),
    });

    /*
     * Generation needs a key. Missing one is a MISSING TOOL, not a failure: the
     * deterministic half of this request — the gaps, the steps read off the
     * crawl, the assertions — is already done and already worth having. So the
     * plan is kept, the job is not queued, and the caller is told exactly what
     * to set. Queueing anyway would burn three BullMQ attempts to arrive at the
     * same sentence an hour later, in a log nobody is reading.
     */
    if (!env.ANTHROPIC_API_KEY) {
      await audit({
        actor,
        action: 'coverage.propose',
        targetType: 'TestPlan',
        targetId: plan.id,
        metadata: {
          gaps: selected.length,
          queued: false,
          reason: 'no ANTHROPIC_API_KEY',
          closuresRecorded: ledger.recorded,
          closuresFailed: ledger.failed,
        },
      });
      res.status(200).json({
        testPlanId: plan.id,
        items: plan.items,
        mapping: items.map(({ gap, rowId }) => ({ gapId: gap.id, planItemId: rowId })),
        /*
         * The mapping is now STORED as well as returned — on the plan items and
         * in the closure ledger. It stays on the response because a caller
         * driving this from CI wants it in the same breath, and because
         * `closureLedger` says how much of it was durably recorded.
         */
        closureLedger: ledger,
        skippedGapIds: missing,
        generation: {
          queued: false,
          reason:
            'ANTHROPIC_API_KEY is not set on this deployment, so the Generator cannot be run. The plan items above are complete and were written from the crawl, not by a model — set the key and approve the plan (POST /plans/:planId/approve) to turn them into code.',
        },
        fingerprint: report.fingerprint,
      });
      return;
    }

    const jobId = await enqueue(QUEUE_NAMES.generate, {
      orgId: actor.orgId,
      projectId,
      testPlanId: plan.id,
      planItemIds: items.map(({ rowId }) => rowId),
      requestedBy: actor.userId,
    });

    await audit({
      actor,
      action: 'coverage.propose',
      targetType: 'TestPlan',
      targetId: plan.id,
      metadata: {
        gaps: selected.length,
        kinds: [...new Set(selected.map((gap) => gap.kind))],
        flowMapVersion,
        queued: true,
        // How much of the provenance was durably recorded. A proposal whose
        // ledger rows did not land is still a proposal, and the audit row is
        // where somebody later finds out why the gap had no history.
        closuresRecorded: ledger.recorded,
        closuresFailed: ledger.failed,
      },
    });

    res.status(202).json({
      jobId,
      testPlanId: plan.id,
      items: plan.items,
      mapping: items.map(({ gap, rowId }) => ({ gapId: gap.id, planItemId: rowId })),
      closureLedger: ledger,
      skippedGapIds: missing,
      generation: { queued: true },
      fingerprint: report.fingerprint,
    });
  },
);

// ─── The dimensions: GET /coverage/:projectId/dimensions ─────────────────────

/**
 * ════════════════════════════════════════════════════════════════════════════
 * THE BREAKDOWN, AND THE THREE THINGS THIS PAYLOAD MAY NOT DO
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 1. IT MAY NOT PRODUCE A COMBINED FIGURE. Thirteen axes, thirteen
 *    denominators, and `rule` printed where a total would go. The previous
 *    headline summed routes + journeys + forms + controls, which made controls
 *    roughly 80% of the quoted number; nine new axes is nine new chances.
 * 2. IT MAY NOT RENDER AN UNMEASURED AXIS AS 0%. Every measurement carries
 *    `wasMeasured`, and a figure is only ever read off one measurement's own
 *    ladder — where an empty denominator gives NULL by arithmetic rather than
 *    by a renderer remembering a flag.
 * 3. IT MAY NOT CLAIM A DELTA IT CANNOT JUSTIFY. The delta comes from the
 *    stored `CoverageHistory` row, whose `comparability` was decided by
 *    `snapshotDelta` at write time. Two snapshots from different crawl
 *    fingerprints produce "not comparable" and a NULL delta, never a number.
 */
/*
 * ── THERE IS NO `?cache=` ON THIS ENDPOINT, AND THAT IS DELIBERATE ──────────
 *
 * The gap list has one, because `cachedCoverageFor` memoises
 * `analyzeCoverage` — a 36-second computation at 20,000 controls. This
 * endpoint does not go through that cache at all: the breakdown comes from
 * `computeCoverage`, which reads the stored inventory rather than re-deriving
 * a crawl diff. An option that was parsed and then ignored would be worse than
 * no option: a caller passing `?cache=false` to get a fresh number would get
 * whatever it was going to get anyway, and believe otherwise.
 *
 * If this endpoint ever needs a cache, the option arrives WITH the cache and
 * with an `ageMs` beside it, the way the gap list reports its own.
 */
coverageRouter.get(
  '/:projectId/dimensions',
  requireScope('tests:read'),
  async (req, res) => {
    const projectId = String(req.params.projectId);
    const actor = actorOf(req);

    /*
     * The dimensions come from `computeCoverage`, not from `analyzeCoverage`:
     * the cells are properties of the stored INVENTORY (a form's fields, a
     * component's states, a surface's typed obligations) and not of the gap
     * report, which is a crawl-versus-tests diff. Two sources for one
     * breakdown is two answers.
     *
     * `persist: false`, so a read never writes. The rows the breakdown counts
     * are written by the recompute lane (apps/worker's
     * RECOMPUTE_COVERAGE_QUEUE), which is serialised at concurrency 1 because
     * two recomputes interleaving their upserts is the one way a denominator
     * can end up describing neither commit.
     */
    const computed = await computeCoverage({
      orgId: actor.orgId,
      projectId,
      persist: false,
    });
    const dimensions = computed.dimensions;
    if (dimensions === undefined) {
      /*
       * The implementation that answered did not report the breakdown. A 501
       * naming the reason, and NOT an empty list: an empty breakdown reads as
       * "this project has no dimensions to report", which is the opposite of
       * "this build did not measure them".
       */
      throw new ApiError(
        501,
        'DIMENSIONS_NOT_REPORTED',
        'This deployment computed coverage without the per-dimension breakdown, so there is nothing to report here. That is a statement about this build, not about your application — read it as "not measured", never as 0%.',
      );
    }

    const breakdown = await dimensionBreakdown({ projectId, measured: dimensions });
    const [history, rollups] = await Promise.all([
      latestCoverageHistory(projectId),
      latestRollups(projectId),
    ]);

    res.json({
      headline: {
        /*
         * The figure this round did not change, and NULL when the denominator
         * is zero.
         *
         * NOT "a weighted mean over ITEMS", which this comment claimed until a
         * verifier checked it against `totalsForItems`
         * (packages/shared/src/surface.ts): that function returns
         * `coveragePercent(sum(covered), sum(denominator))` over the four
         * MEASURED_SURFACE_KINDS and there is no weight table anywhere on the
         * path. `summedKindPercent` in packages/agent/src/surface-coverage.ts
         * documents the same field as a ratio of summed incommensurable
         * denominators and says not to put it in front of a customer; this
         * payload is one of the surfaces that now does. That is a known OPEN
         * defect, recorded here rather than papered over, and it is NOT what
         * the dimensions below do — each of those divides by its own cells.
         */
        percent: computed.snapshot.totals.percent,
        denominator: computed.snapshot.totals.denominator,
        covered: computed.snapshot.totals.covered,
        /** The rung the headline is taken at, so it is comparable to anything. */
        tier: 'ASSERTED',
      },
      /** The delta WITH its comparability. Never a bare number. */
      delta: history,
      dimensions: breakdown.dimensions,
      storedCells: breakdown.storedCells,
      rollups,
      caps: breakdown.caps,
      rule: breakdown.rule,
      why: breakdown.why,
      caveats: computed.snapshot.caveats,
    });
  },
);

// ─── The uncovered cell list: paged, filtered BEFORE the cap ─────────────────

/** Page size for a cell list. The same ceiling the gap list uses. */
const DEFAULT_CELL_PAGE = 50;
const MAX_CELL_PAGE = 300;

/**
 * The filters, and the ORDER they run in relative to the cap.
 *
 * ── THE DEFECT, APPLIED TO EVERY NEW DIMENSION ─────────────────────────────
 *
 * On the gap list, `limit` was passed straight into the analysis, which sliced
 * the ranked list BEFORE the handler applied `kind` and `minScore` — so a
 * project with 800 untested controls could never name more than 300 of them,
 * and a reader filtering for one kind got whichever members happened to fall
 * inside the top 300 with no indication that others existed. The list was short
 * AND wrong, which is the worse of the two.
 *
 * Nine more axes is nine more chances to rebuild it, so the order here is
 * fixed: FILTER, then COUNT, then CUT, then report the cap that bit. `matched`
 * is the true size of the filtered list and the whole of THAT list is walkable
 * with `nextCursor`.
 */
const cellQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_CELL_PAGE).optional(),
  /**
   * The key of the last cell on the previous page. Resumes AFTER it.
   *
   * A key that is not in the filtered list is a 409, not an empty page: it
   * means the breakdown moved under the caller (a test landed, the app was
   * re-crawled), and silently answering `[]` reads exactly like "you have
   * reached the end".
   */
  cursor: z.string().min(1).max(500).optional(),
  /** Comma-separated `CoverageCellKind` values. Unknown names are a 400. */
  kind: z.string().optional(),
  /**
   * `uncovered` is the default and is the product's core promise: NAME the
   * cells nothing claims. `unmeasured` lists the cells we could not measure,
   * which is a different list with a different remedy, and `all` is both.
   */
  state: z.enum(['uncovered', 'unmeasured', 'all']).optional(),
});

/**
 * One cell of one dimension, as the list serves it.
 *
 * `tier: null` is MEASURED AND UNCLAIMED — the gap this product exists to
 * shrink — and `unmeasuredReason` non-null is a cell we could not measure.
 * Two different findings, never merged, which is why both fields travel.
 */
interface UncoveredCell {
  cellKey: string;
  kind: string;
  label: string;
  itemKey: string;
  tier: string | null;
  tierCappedBy: string | null;
  unmeasuredReason: string | null;
  unmeasuredDetail: string | null;
  evidence: string;
}

coverageRouter.get(
  '/:projectId/dimensions/:dimension/cells',
  requireScope('tests:read'),
  async (req, res) => {
    const query = cellQuery.parse(req.query);
    const projectId = String(req.params.projectId);
    const actor = actorOf(req);
    const dimension = String(req.params.dimension).toUpperCase();

    if (!(COVERAGE_DIMENSIONS as readonly string[]).includes(dimension)) {
      throw badRequest(`Unknown dimension: ${dimension}`, {
        known: [...COVERAGE_DIMENSIONS],
      });
    }
    const axis = dimension as CoverageDimensionKind;

    const computed = await computeCoverage({ orgId: actor.orgId, projectId, persist: false });
    const dimensions = computed.dimensions;
    if (dimensions === undefined) {
      throw new ApiError(
        501,
        'DIMENSIONS_NOT_REPORTED',
        'This deployment computed coverage without the per-dimension breakdown, so there are no cells to list. Not measured, and not zero.',
      );
    }

    const measurement = dimensions.report.measurements.find((m) => m.dimension === axis);
    /*
     * An axis with no extractor, or one nobody enumerated, has NO CELL LIST —
     * and that is a 200 with a named reason rather than an empty array. An
     * empty array reads as "this axis is fully covered", which is the single
     * most expensive wrong answer this endpoint can give.
     */
    if (measurement === undefined || measurement.measured === 0) {
      res.json({
        dimension: axis,
        cells: [],
        measured: false,
        reason: measurement?.unmeasuredReason ?? 'NO_EXTRACTOR',
        detail:
          measurement?.unmeasuredDetail ??
          `${axis} was not measured by this computation, so it has no cell list.`,
        page: {
          matched: 0,
          returned: 0,
          limit: query.limit ?? DEFAULT_CELL_PAGE,
          hasMore: false,
          nextCursor: null,
          rule: 'An EMPTY list here is not "nothing is uncovered" — this axis was not measured. `measured: false` is the field to branch on, and `reason` says whether that is our missing extractor, a crawl nobody ran, or a cap that bit.',
        },
      });
      return;
    }

    const all = cellsOfDimension(axis, dimensions);

    // ── FILTER FIRST ────────────────────────────────────────────────────────
    let cells = all;
    if (query.kind) {
      const wanted = new Set(
        query.kind.split(',').map((k) => k.trim().toUpperCase()).filter(Boolean),
      );
      const unknown = [...wanted].filter(
        (k) => !(COVERAGE_CELL_KINDS as readonly string[]).includes(k),
      );
      // A typo'd filter that silently returns nothing reads exactly like "you
      // have no cells of that kind", which is the one wrong answer this
      // endpoint may not give.
      if (unknown.length > 0) {
        throw badRequest(`Unknown cell kind(s): ${unknown.join(', ')}`, {
          knownForThisDimension: [...cellKindsFor(axis)],
        });
      }
      cells = cells.filter((cell) => wanted.has(cell.kind));
    }
    const state = query.state ?? 'uncovered';
    if (state === 'uncovered') {
      // Measured, in the denominator, and claimed by nothing. The list the
      // product promises it can name.
      cells = cells.filter((cell) => cell.tier === null && cell.unmeasuredReason === null);
    } else if (state === 'unmeasured') {
      cells = cells.filter((cell) => cell.unmeasuredReason !== null);
    }

    // ── THEN COUNT, THEN CUT ────────────────────────────────────────────────
    const matched = cells.length;
    let page = cells;
    if (query.cursor !== undefined) {
      const at = cells.findIndex((cell) => cell.cellKey === query.cursor);
      if (at === -1) {
        throw conflict(
          'That cursor is not in the current filtered breakdown — a test was added, or the app was re-crawled, so the list moved under you. Re-read the first page.',
          { cursor: query.cursor, matched },
        );
      }
      page = cells.slice(at + 1);
    }
    const size = query.limit ?? DEFAULT_CELL_PAGE;
    const hasMore = page.length > size;
    page = page.slice(0, size);

    res.json({
      dimension: axis,
      measured: true,
      cells: page,
      /** The axis's own reading, so a caller needs one request and not two. */
      measurement,
      page: {
        /** Cells that passed the filters. EXACT. Do not measure `cells.length`. */
        matched,
        returned: page.length,
        limit: size,
        hasMore,
        nextCursor: hasMore ? (page[page.length - 1]?.cellKey ?? null) : null,
        /*
         * ── THE WALKABILITY CLAIM, AND ITS HONEST LIMIT ────────────────────
         *
         * The paging is correct: the filters run before the slice, `matched` is
         * exact, and the cursor reaches the end of the filtered list. What is
         * NOT this handler's to promise is that the BREAKDOWN holds every cell:
         * the dimension modules apply caps of their own
         * (MAX_CELLS_PER_DIMENSION, MAX_COMPONENTS) and the write path applies
         * MAX_DIMENSION_CELL_WRITES, and every cap that bit is named with its
         * count in `measurement.caps`. Two claims in one sentence, one of them
         * this handler's and one of them not, so the sentence separates them
         * and says where the other half is answered.
         */
        rule:
          'The filters run BEFORE this page is cut, so `matched` is the true size of the filtered ' +
          'list and the whole of THAT list is walkable with `nextCursor`. It is not necessarily ' +
          'every cell of this dimension: the measurement applies caps of its own, and every cap ' +
          'that bit is reported as a count AND a reason in `measurement.caps`. Read those before ' +
          'concluding this list is complete.',
      },
      caps: measurement.caps,
    });
  },
);

/**
 * Every cell of one dimension, from the rows the dimension pass produced.
 *
 * ── WHY FROM THE PASS AND NOT FROM THE THREE TABLES ────────────────────────
 *
 * Because the stored rows are a SUBSET: `MAX_DIMENSION_CELL_WRITES` cuts the
 * write and the migration that mints the tables may not be applied at all. A
 * list read from the tables would be silently shorter than the percentage it
 * sits beside, and the reader would have no way to tell. Reading from the pass
 * means the list and the figure are over the same population, and the caps that
 * cut the WRITE are disclosed separately — "we measured 1,400 and stored 300"
 * is two facts and one of them is about our budget.
 */
function cellsOfDimension(
  dimension: CoverageDimensionKind,
  measured: NonNullable<ComputedCoverage['dimensions']>,
): UncoveredCell[] {
  const out: UncoveredCell[] = [];
  for (const row of measured.formFieldRows) {
    if (CELL_KIND_DIMENSION[row.kind] !== dimension) continue;
    out.push({
      cellKey: row.fieldKey,
      kind: row.kind,
      label: row.label,
      itemKey: row.itemKey,
      tier: row.tier,
      tierCappedBy: row.tierCappedBy,
      unmeasuredReason: row.unmeasuredReason,
      unmeasuredDetail: row.unmeasuredDetail,
      evidence: row.evidence,
    });
  }
  for (const row of measured.itemStateRows) {
    if (CELL_KIND_DIMENSION[row.kind] !== dimension) continue;
    out.push({
      cellKey: row.stateKey,
      kind: row.kind,
      label: row.label,
      itemKey: row.itemKey,
      tier: row.tier,
      tierCappedBy: row.tierCappedBy,
      unmeasuredReason: row.unmeasuredReason,
      unmeasuredDetail: row.unmeasuredDetail,
      evidence: row.evidence,
    });
  }
  if (dimension === 'TEST_TYPE') {
    for (const cell of measured.obligationCells) {
      out.push({
        cellKey: `${cell.itemKey}|TYPE=${cell.testType}`,
        kind: 'TEST_TYPE',
        label: `${cell.itemKey} owes a ${cell.testType} test`,
        itemKey: cell.itemKey,
        tier: cell.tier,
        tierCappedBy: cell.tierCappedBy,
        unmeasuredReason: cell.unmeasuredReason,
        unmeasuredDetail: cell.unmeasuredDetail,
        evidence: cell.evidence,
      });
    }
  }
  /*
   * A STABLE ORDER, so a cursor means the same thing on two requests. By cell
   * key, which is `dimensionCellIdentity`'s format and therefore already
   * canonical — ordering by label would reshuffle the list the first time
   * somebody renamed a field, and every cursor in flight would land in the
   * wrong place.
   */
  return out.sort((left, right) => left.cellKey.localeCompare(right.cellKey));
}

// ─── The rollups and the history: the read half of two stored tables ─────────

/** Rollup buckets served in one payload. The headline is never dropped. */
const MAX_SERVED_ROLLUPS = 200;

/**
 * THE PER-FEATURE AND PER-TEAM BREAKDOWN, read back from `CoverageRollup`.
 *
 * ── WHY THIS READ EXISTS IN THE SAME ROUND AS THE WRITE ────────────────────
 *
 * Because a table with only one of the two is what `check:wiring` calls
 * DISCONNECTED, and two consecutive keystones shipped models that way. "The
 * next round will read it" is not a door. More to the point, one global
 * percentage can be assigned to NOBODY — a rollup nobody can read is a number
 * with no owner, which is the register item this whole round exists to close.
 *
 * ── NULL IS "CANNOT ANSWER", NEVER "NO BUCKETS" ────────────────────────────
 *
 * Same contract as `coverageProvenance`: the migration that mints the table is
 * written and unapplied in this tree, so the delegate exists and the table does
 * not. An empty array would read as a project whose surface is attributed to no
 * feature and owned by no team, which is a FINDING — and publishing our own
 * unapplied migration as that finding is the worst available wrong answer.
 */
async function latestRollups(projectId: string): Promise<{
  scopes: Array<{
    scopeKey: string;
    dimension: string | null;
    feature: string | null;
    teamId: string | null;
    numerator: number;
    denominator: number;
    percent: number | null;
    tier: string;
    unmeasured: number;
    unmeasuredReason: string | null;
    unmeasuredDetail: string | null;
  }>;
  truncated: boolean;
  why: string;
} | null> {
  try {
    const snapshot = await prisma.coverageSnapshot.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (snapshot === null) {
      return {
        scopes: [],
        truncated: false,
        why: 'No coverage snapshot has been stored for this project yet, so there are no rollups. Nothing has been measured — this is not a project whose surface is unattributed.',
      };
    }
    const rows = await prisma.coverageRollup.findMany({
      where: { snapshotId: snapshot.id },
      /*
       * BIGGEST DENOMINATOR FIRST, and the headline sorts first within that
       * because its denominator is the whole. A bucket list ordered by
       * PERCENTAGE would put every empty bucket (percent null) at one end and
       * read as a ranking, which it is not.
       */
      orderBy: [{ denominator: 'desc' }, { scopeKey: 'asc' }],
      take: MAX_SERVED_ROLLUPS + 1,
      select: {
        scopeKey: true,
        dimension: true,
        feature: true,
        teamId: true,
        numerator: true,
        denominator: true,
        percent: true,
        tier: true,
        unmeasured: true,
        unmeasuredReason: true,
        unmeasuredDetail: true,
      },
    });
    const truncated = rows.length > MAX_SERVED_ROLLUPS;
    return {
      scopes: rows.slice(0, MAX_SERVED_ROLLUPS),
      truncated,
      why:
        'Every bucket divides by ITS OWN denominator and no two are added together. `percent` is ' +
        'NULL when a bucket has nothing in scope — never 0 and never 100. A bucket under ' +
        `UNATTRIBUTED or UNOWNED is a FINDING, not a default owner.${
          truncated
            ? ` More than ${MAX_SERVED_ROLLUPS} buckets exist and the largest ${MAX_SERVED_ROLLUPS} are served, so this list is a lower bound.`
            : ''
        }`,
    };
  } catch {
    // The table does not exist on this deployment. NO answer, not an empty one.
    return null;
  }
}

/**
 * THE DELTA, WITH ITS COMPARABILITY, read back from `CoverageHistory`.
 *
 * ── WHY THE DELTA IS STORED AND NOT COMPUTED HERE ──────────────────────────
 *
 * Because comparability was decided at WRITE time, by `snapshotDelta`, against
 * the two snapshots' crawl fingerprints and denominator definitions — and those
 * are facts about the moment the measurement was taken. Recomputing it here
 * would mean subtracting whatever two percentages are closest to hand, which
 * always succeeds and is the easiest number in this product to get wrong: two
 * snapshots taken against different crawls measured different applications, and
 * "coverage fell 9 points" across them is an artefact of our own enumeration
 * that everybody reads as a regression.
 *
 * So the stored `comparability` travels with the delta, `deltaPercent` is NULL
 * whenever it is anything but COMPARABLE, and every surface that prints a delta
 * — the PR comment, the check-run summary, the badge, the digest — reads this
 * one row.
 */
async function latestCoverageHistory(projectId: string): Promise<{
  percent: number | null;
  previousPercent: number | null;
  deltaPercent: number | null;
  comparability: string;
  comparabilityDetail: string | null;
  crawlFingerprint: string | null;
  firstSeenAt: Date;
  /** Whether the delta above means anything. Read this, not the number. */
  meaningful: boolean;
} | null> {
  try {
    const row = await prisma.coverageHistory.findFirst({
      where: { projectId, scopeKey: HEADLINE_SCOPE_KEY },
      orderBy: { createdAt: 'desc' },
      select: {
        percent: true,
        previousPercent: true,
        deltaPercent: true,
        comparability: true,
        comparabilityDetail: true,
        crawlFingerprint: true,
        firstSeenAt: true,
      },
    });
    if (row === null) return null;
    return {
      ...row,
      /*
       * Derived through the shared predicate rather than by comparing the
       * string here, so that no surface in the product decides for itself what
       * counts as comparable. `deltaIsMeaningful` is the one answer.
       */
      meaningful: deltaIsMeaningful(row.comparability as SnapshotComparability),
    };
  } catch {
    return null;
  }
}

/**
 * The trend, for a surface that draws one.
 *
 * Newest first, and every point carries its own comparability — so a chart can
 * BREAK THE LINE where the crawl changed rather than drawing a cliff. A trend
 * line through two incomparable snapshots is a regression nobody caused,
 * rendered as a picture, which is harder to argue with than a number.
 */
const historyQuery = z.object({
  /**
   * Trend points, newest first.
   *
   * Through zod rather than `Number.parseInt(String(req.query.limit))`, and the
   * difference is not style: Express parses `?limit=1&limit=2` into an ARRAY,
   * `String()` of that is `"1,2"`, and `parseInt` of that is 1 — so a repeated
   * parameter would silently return one point instead of thirty. `z.coerce`
   * refuses it with a 400 that names the field.
   */
  limit: z.coerce.number().int().min(1).max(200).default(30),
});

coverageRouter.get('/:projectId/history', requireScope('tests:read'), async (req, res) => {
  const projectId = String(req.params.projectId);
  const { limit } = historyQuery.parse(req.query);

  let points: Array<{
    snapshotId: string;
    percent: number | null;
    denominator: number;
    deltaPercent: number | null;
    comparability: string;
    comparabilityDetail: string | null;
    crawlFingerprint: string | null;
    createdAt: Date;
  }> | null = null;
  try {
    points = await prisma.coverageHistory.findMany({
      where: { projectId, scopeKey: HEADLINE_SCOPE_KEY },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        snapshotId: true,
        percent: true,
        denominator: true,
        deltaPercent: true,
        comparability: true,
        comparabilityDetail: true,
        crawlFingerprint: true,
        createdAt: true,
      },
    });
  } catch {
    // NULL is "this deployment cannot answer", never "there is no history".
    points = null;
  }

  res.json({
    points,
    rule:
      'Each point carries its OWN comparability. A point whose `comparability` is not COMPARABLE ' +
      'has a NULL `deltaPercent` and must break the line rather than be drawn as a change: the ' +
      'two snapshots either side of it measured different applications. `points: null` means this ' +
      'deployment cannot answer — read it as "cannot answer", never as "no history exists".',
  });
});

// ─── The attestation export: the artifact a buyer is handed ──────────────────

/**
 * ════════════════════════════════════════════════════════════════════════════
 * THE COVERAGE ATTESTATION
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The number never left one authenticated screen. This is the door: a dated,
 * scoped, fingerprinted statement a customer can hand to a buyer, an auditor or
 * their own board.
 *
 * ── WHY THE ENVELOPE IS NOMINAL AND `attest` IS THE ONLY DOOR ──────────────
 *
 * Because the shape a writer in a hurry produces — the percentage, the
 * denominator, and no disclosures — COMPILES, and it is a document that claims
 * nothing was unmeasured. `CoverageAttestation` is branded with a module-private
 * symbol, so this route cannot assemble one by hand: it must go through
 * `attest`, which throws on an empty scope statement, an empty denominator
 * definition, a numerator above its denominator, a percentage on an empty
 * denominator, an unmeasured entry with no sentence and a cap with no sentence.
 *
 * ── THREE FORMATS, NO PDF BINARY ───────────────────────────────────────────
 *
 * CSV for a spreadsheet, JSON for a machine, and a PRINT-READY HTML page the
 * browser turns into a PDF with Cmd-P. Adding a PDF renderer would be a
 * headless-Chromium dependency in the API process to produce a document the
 * browser can already make, and the browser's output is the one the customer
 * can check against the screen.
 *
 * ── WHAT EVERY FORMAT MUST STATE ───────────────────────────────────────────
 *
 * The crawl version, the denominator definition, the fingerprint, the caps that
 * bit and the axes that were NOT measured. All five come off the envelope, and
 * `attestationScopeLines` renders the scope section for all three formats from
 * one function — because a scope section worded differently in each is three
 * documents making three different disclosures about one measurement.
 */
const attestationQuery = z.object({
  format: z.enum(['json', 'csv', 'html']).optional(),
  /**
   * `true` records the attestation in `CoverageAttestation`.
   *
   * Off by default, and that is deliberate: a GET that writes is a GET that
   * cannot be retried, and the common case is a person looking at the document
   * before deciding to send it. Recording is a POST.
   */
  record: z.enum(['true', '1']).optional(),
});

/**
 * THE SCOPE STATEMENT, in the customer's terms, built from the measurement.
 *
 * A function and not a constant, so the sentence is assembled from the figures
 * it describes every time it is printed. A hand-written scope paragraph is
 * prose that silently contradicts the code under it the moment somebody changes
 * what is measured — the easiest of this product's forbidden lies to commit by
 * accident, and the worst place to commit it is the one document a buyer reads.
 */
/**
 * THE AXES A REPORT ACTUALLY MEASURED — not the axes a module COULD measure.
 *
 * `report.measured` is `measuredDimensionKinds()`, which reads
 * `DIMENSION_REGISTRY[d].measured`: a CAPABILITY claim ("a module in
 * packages/agent can measure this axis"), NOT an outcome ("this computation
 * did"). Seven of those twelve have a producer and no adapter in this build, so
 * `coverageDimensionReport` returns them as NOT_ENUMERATED with a null
 * percentage — and `dimensionUnmeasuredDisclosures` then lists them, by name,
 * in the attestation's `unmeasured`.
 *
 * Reading the capability list as the outcome put both claims in one paragraph
 * of the one document a buyer keeps: "across 12 measured axis/axes ... 8
 * axis/axes were not measured at all", over a THIRTEEN-axis vocabulary, with
 * seven axes counted in both halves and 12 + 8 = 20. A scope section that
 * contradicts itself is worse than a smaller number, because the reader cannot
 * tell which half to believe — and the honest summary the store does produce
 * ("7 of 12 measurable dimension(s) were NOT enumerated") lives in the internal
 * caveats, which the public share document deliberately withholds. So the
 * buyer saw only the inflated count.
 *
 * `dimensionWasMeasured` is the SAME predicate `dimensionUnmeasuredDisclosures`
 * uses to decide the other half of the sentence. One predicate, so the two
 * halves cannot disagree again: every reading falls in exactly one of them.
 *
 * Exported so the invariant is testable without standing up the whole
 * computation — the route was the one caller of `buildAttestation` and nothing
 * drove it, which is how this shipped.
 */
export function axesWithAReading(report: {
  measurements: readonly DimensionMeasurement[];
}): CoverageDimensionKind[] {
  return report.measurements
    .filter((measurement) => dimensionWasMeasured(measurement))
    .map((measurement) => measurement.dimension);
}

function scopeStatementFor(input: {
  measuredAxes: readonly string[];
  unmeasuredAxes: readonly string[];
  denominator: number;
}): string {
  return (
    `This document states what QAAI MEASURED about one application at one moment. It covers ` +
    `${input.denominator} surface item(s) across ${input.measuredAxes.length} measured axis/axes, ` +
    `and it does NOT claim completeness: ${input.unmeasuredAxes.length} axis/axes were not ` +
    `measured at all and are listed below by name with the reason for each. ` +
    `A surface QAAI never enumerated is absent from the denominator rather than counted as ` +
    `uncovered, so the percentage below is an upper bound on what is known and not a statement ` +
    `about everything that exists. "Covered" means a test was observed to execute against the ` +
    `item; a test that merely NAMES an item is reported at a lower rung and is not counted as ` +
    `covered. A failing test still counts as coverage — covered and passing are two different ` +
    `facts and this document reports the first. Nothing here is an assertion about the ` +
    `application's quality, its security or its fitness for any purpose.`
  );
}

/**
 * Build the envelope for a project's latest measurement.
 *
 * `itemKeys` is hashed into the fingerprint and DISCARDED: a document carrying
 * 412 route keys is not a document anybody reads, and the fingerprint is what
 * makes the item set checkable without publishing it. That also matters for a
 * SHARE link — see the note on the public report below: the item keys are the
 * one part of this measurement that would turn a public document into an oracle
 * for which internal routes exist.
 */
async function buildAttestation(input: {
  orgId: string;
  projectId: string;
  issuedByUserId: string | null;
}): Promise<{
  attestation: CoverageAttestation;
  dimensions: NonNullable<ComputedCoverage['dimensions']>;
}> {
  const computed = await computeCoverage({
    orgId: input.orgId,
    projectId: input.projectId,
    persist: false,
  });
  const dimensions = computed.dimensions;
  if (dimensions === undefined) {
    throw new ApiError(
      501,
      'DIMENSIONS_NOT_REPORTED',
      'This deployment computed coverage without the per-dimension breakdown, so an attestation cannot state which axes were not measured — and an attestation that cannot state its own scope is worse than no attestation.',
    );
  }

  const unmeasured = [
    ...dimensionUnmeasuredDisclosures(dimensions.report),
    /*
     * The INVENTORY axes, on the other vocabulary. `SURFACE_KINDS` is "we do
     * not enumerate background jobs" and `COVERAGE_DIMENSIONS` is "we do not
     * measure validation rules", and an attestation has to be able to disclose
     * either — which is why `AttestationUnmeasured` has both fields and
     * requires at least one. Forcing one would have meant silently dropping
     * half the disclosures.
     */
    ...computed.unmeasuredKinds.map((kind) => ({
      dimension: null,
      kind,
      reason: 'NO_EXTRACTOR' as const,
      detail: `QAAI does not enumerate the ${kind} axis in this build, so no ${kind} is in the denominator below. Absent is not uncovered: an axis nothing enumerated raises the percentage rather than lowering it, which is why it is named here.`,
      cells: null,
    })),
  ];

  const measuredAxes = axesWithAReading(dimensions.report);
  const attestation = attest(
    {
      projectId: input.projectId,
      snapshotId: computed.snapshotId,
      // Passed in, never read from a clock inside the envelope: two exports of
      // one measurement are one claim, which is why the time is OUT of the
      // fingerprint and IN the document.
      issuedAtIso: new Date().toISOString(),
      issuedByUserId: input.issuedByUserId,
      crawlVersion: CRAWL_VERSION,
      crawlFingerprint: computed.snapshot.fingerprint,
      denominatorDefinition: denominatorDefinitionForExport(computed),
      percent: computed.snapshot.totals.percent,
      denominator: computed.snapshot.totals.denominator,
      covered: computed.snapshot.totals.covered,
      scopeStatement: scopeStatementFor({
        measuredAxes,
        unmeasuredAxes: unmeasured.map((entry) => String(entry.dimension ?? entry.kind)),
        denominator: computed.snapshot.totals.denominator,
      }),
      unmeasured,
      caps: dimensions.report.caps,
    },
    computed.entries.map((entry) => entry.item.key),
    sha256Hex,
  );

  return { attestation, dimensions };
}

/**
 * The denominator definition on the EXPORT, which must match the one stored on
 * the snapshot.
 *
 * It is rebuilt from the computation rather than read off the snapshot row,
 * because an export may run against a `persist: false` computation that has no
 * row — and a definition that differs between the stored snapshot and the
 * exported document would make every delta across them read
 * UNCOMPARABLE_DENOMINATOR_CHANGED for no reason connected to the customer's
 * application. The two are compared VERBATIM by `snapshotDelta`, so they are
 * built by one expression and the handover names moving it into a single shared
 * function.
 */
function denominatorDefinitionForExport(computed: ComputedCoverage): string {
  const axes = [...new Set(computed.entries.map((entry) => entry.item.kind))].sort();
  const participation = computed.inventory?.participation ?? [];
  const heldOut = computed.inventory?.heldOut ?? { unexercisable: 0, refused: 0 };
  const complete = computed.inventory?.complete ?? null;
  return (
    `${computed.snapshot.totals.denominator} CoverageItem(s) across ${axes.length} axis/axes ` +
    `(${axes.join(', ')}), declared by ` +
    `${participation.filter((entry) => entry.participation === 'LOADED').length} of ` +
    `${participation.length} declarer(s); union ` +
    `${complete === null ? 'completeness UNKNOWN' : complete ? 'complete' : 'PARTIAL'}; ` +
    `${heldOut.unexercisable} unexercisable and ${heldOut.refused} refused item(s) held out of ` +
    'the division with a reason; waived items leave the denominator with an owner and an expiry.'
  );
}

/**
 * The digest the attestation fingerprint is taken under.
 *
 * `attestationFingerprint` takes it as an INJECTED `ContentDigest` rather than
 * importing one, because packages/shared is consumed by the web app's bundler
 * and a `node:crypto` import anywhere in that barrel's graph 500s every page
 * that reads a value from it. This is the adapter, and it lives in the app that
 * has a Node runtime.
 *
 * SHA-256 and not the HMAC in lib/crypto.ts: the fingerprint is an identity a
 * CUSTOMER must be able to recompute to check our arithmetic, and an HMAC keyed
 * on SESSION_SECRET is only recomputable by us. Nothing secret goes into it —
 * the canonical text is the denominator definition, the enumerator version, the
 * counts, the scope statement, the disclosures and the sorted item keys.
 */
const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** One CSV field, quoted so a comma or a newline in a disclosure cannot forge a column. */
export function csvField(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  /*
   * ALWAYS quoted and never conditionally, and the leading-character guard is
   * the part that matters: a disclosure beginning `=`, `+`, `-` or `@` is
   * executed as a FORMULA by Excel and Sheets when the file is opened. Our own
   * sentences never start that way, but a customer's feature name can, and a
   * coverage document that runs code when a buyer opens it is not a document we
   * can send. The apostrophe forces it to text.
   */
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * The attestation as CSV.
 *
 * ── A SPREADSHEET IS NOT A TABLE, AND THIS DOCUMENT IS TWO THINGS ──────────
 *
 * The figures are one row and the disclosures are a list, so a single header
 * row would either drop the disclosures or repeat every figure once per
 * disclosure. Both are worse than two sections: the second repeats the
 * percentage beside each limitation, which is how a reader comes to quote "61%"
 * from a row whose other columns say it was measured over three of thirteen
 * axes.
 *
 * So the file is SECTIONED, each section with its own header, which every
 * spreadsheet imports and every reader can see the shape of.
 */
export function attestationCsv(attestation: CoverageAttestation): string {
  const lines: string[] = [];
  lines.push('SECTION,FIELD,VALUE');
  const field = (name: string, value: string | number | null): void => {
    lines.push(`${csvField('MEASUREMENT')},${csvField(name)},${csvField(value)}`);
  };
  field('projectId', attestation.projectId);
  field('issuedAt', attestation.issuedAtIso);
  field('fingerprint', attestation.fingerprint);
  field('crawlVersion', attestation.crawlVersion);
  field('crawlFingerprint', attestation.crawlFingerprint);
  field('denominatorDefinition', attestation.denominatorDefinition);
  /*
   * EMPTY, not 0, when there is no percentage. A zero in a spreadsheet cell is
   * a number somebody will average, chart and quote; an empty cell is a visible
   * absence, and the row below says why.
   */
  field('percent', attestation.percent);
  field(
    'percentIsNull',
    attestation.percent === null
      ? 'YES — the denominator was zero, so there is no percentage. This is NOT 0% and NOT 100%.'
      : 'no',
  );
  field('denominator', attestation.denominator);
  field('covered', attestation.covered);

  lines.push('');
  lines.push(`${csvField('SCOPE')},${csvField('STATEMENT')},`);
  for (const line of attestationScopeLines(attestation)) {
    lines.push(`${csvField('SCOPE')},${csvField(line)},`);
  }

  lines.push('');
  lines.push('SECTION,AXIS,REASON,DETAIL,CELLS_NOT_MEASURED');
  for (const entry of attestation.unmeasured) {
    lines.push(
      [
        csvField('NOT_MEASURED'),
        csvField(entry.dimension ?? entry.kind),
        csvField(entry.reason),
        csvField(entry.detail),
        // Empty when the count is unknown. 0 would claim no cells exist.
        csvField(entry.cells),
      ].join(','),
    );
  }

  lines.push('');
  lines.push('SECTION,CAP,LIMIT,AT_LEAST_MORE,DETAIL');
  for (const cap of attestation.caps) {
    lines.push(
      [
        csvField('CAP_THAT_BIT'),
        csvField(cap.cap),
        csvField(cap.limit),
        // Empty when the cap could not say how much it hid. 0 would be the
        // claim that nothing was hidden, which is the opposite.
        csvField(cap.atLeastMore),
        csvField(cap.detail),
      ].join(','),
    );
  }

  return `${lines.join('\n')}\n`;
}

/** HTML-escape. Every interpolation below goes through it. */
function esc(value: string | number | null): string {
  if (value === null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The attestation as a print-ready page.
 *
 * ── NO PDF BINARY, AND THAT IS THE DECISION ────────────────────────────────
 *
 * `@page` plus `print-color-adjust: exact` is what makes Cmd-P produce a
 * document with the same disclosures the screen shows. A headless-Chromium
 * dependency in the API process would be a second renderer whose output nobody
 * compares against the first, and the browser's PDF is the one the customer can
 * check against what they were looking at.
 *
 * ── THE FIGURE AND ITS SCOPE ARE ON THE SAME PAGE, DELIBERATELY ────────────
 *
 * `page-break-inside: avoid` on the scope block, and the scope section comes
 * BEFORE the breakdown. A document whose percentage is on page 1 and whose
 * "three of thirteen axes were measured" is on page 3 is a document that gets
 * screenshotted at page 1.
 */
export function attestationHtml(input: {
  attestation: CoverageAttestation;
  dimensions: NonNullable<ComputedCoverage['dimensions']>;
}): string {
  const { attestation } = input;
  const figure =
    attestation.percent === null
      ? 'NOT MEASURED'
      : `${attestation.percent.toFixed(1)}%`;

  const dimensionRows = input.dimensions.report.measurements
    .map((measurement) => {
      const measured = measurement.measured > 0;
      /*
       * "not measured" AS WORDS, never as a number, and visually distinct from
       * a real zero. A badge or a cell that renders 0% for "not measured yet"
       * is this product's own lie in a document somebody files.
       */
      /*
       * `?? 0` USED TO SIT ON THIS LINE AND IT WAS THE WRONG SHAPE.
       *
       * `measured > 0` is not quite enough to guarantee a figure:
       * `dimensionPercentAt` also returns null when the ladder has no rung for
       * the tier asked for. Today `coverageLadder` emits every member of
       * COVERAGE_TIERS so that cannot happen, which is exactly why the `?? 0`
       * was invisible — it was a null-becomes-0 one rung rename away from
       * printing "0.0%" in a procurement document where the truth is "there is
       * no such rung". The figure is read ONCE and branched on, the way
       * Dimensions.tsx's `figureOf` already does it, so the words and the
       * number stay one branch apart rather than one coalesce apart.
       */
      const figureAt = measured ? dimensionPercentAt(measurement, 'ASSERTED') : null;
      const cell =
        figureAt === null
          ? '<span class="unmeasured">not measured</span>'
          : `${figureAt.toFixed(1)}% of ${measurement.measured}`;
      return `<tr>
        <td><code>${esc(measurement.dimension)}</code></td>
        <td class="num">${cell}</td>
        <td class="num">${esc(measurement.cells)}</td>
        <td class="num">${esc(measurement.unmeasured)}</td>
        <td>${esc(measurement.unmeasuredReason)}${
          measurement.unmeasuredDetail ? `<div class="note">${esc(measurement.unmeasuredDetail)}</div>` : ''
        }</td>
      </tr>`;
    })
    .join('\n');

  const scopeItems = attestationScopeLines(attestation)
    .map((line) => `<li>${esc(line)}</li>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- A coverage attestation is a private document about a customer's own
     application. It must never be indexed, whether it was fetched with a
     session or through a share link. -->
<meta name="robots" content="noindex, nofollow">
<title>Coverage attestation — ${esc(attestation.fingerprint.slice(0, 12))}</title>
<style>
  @page { margin: 18mm 16mm; }
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 32px 16px; max-width: 860px;
    font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #15181d; background: #fff;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  h1 { font-size: 21px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.07em;
       color: #5b6472; margin: 30px 0 10px; }
  .meta { color: #5b6472; font-size: 12.5px; margin: 0 0 24px; }
  .figure { font-size: 40px; font-weight: 650; letter-spacing: -0.02em; margin: 0; }
  .figure.null { font-size: 21px; color: #8a4b00; }
  .figure-note { color: #5b6472; font-size: 12.5px; margin: 4px 0 0; }
  .scope { page-break-inside: avoid; break-inside: avoid;
           border: 1px solid #d8dde4; border-radius: 6px; padding: 14px 18px; background: #fbfcfd; }
  .scope ul { margin: 0; padding-left: 18px; }
  .scope li { margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #e6e9ee; vertical-align: top; }
  th { color: #5b6472; font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .unmeasured { color: #8a4b00; font-weight: 600; font-style: normal; }
  .note { color: #5b6472; font-size: 11.5px; margin-top: 3px; }
  footer { margin-top: 34px; padding-top: 14px; border-top: 1px solid #e6e9ee;
           color: #5b6472; font-size: 11.5px; }
</style>
</head>
<body>
<h1>Coverage attestation</h1>
<p class="meta">
  Issued ${esc(attestation.issuedAtIso)} &middot;
  enumerator <code>${esc(attestation.crawlVersion)}</code> &middot;
  fingerprint <code>${esc(attestation.fingerprint)}</code>
</p>

<p class="figure${attestation.percent === null ? ' null' : ''}">${esc(figure)}</p>
<p class="figure-note">
  ${
    attestation.percent === null
      ? 'There was nothing to divide: the denominator was zero. This is NOT 0% and NOT 100%.'
      : `${esc(attestation.covered)} of ${esc(attestation.denominator)} surface item(s), at the ASSERTED rung.`
  }
</p>
<p class="figure-note">What was divided by: ${esc(attestation.denominatorDefinition)}</p>

<h2>Scope &mdash; read this before quoting the figure</h2>
<div class="scope"><ul>
${scopeItems}
</ul></div>

<h2>Breakdown by dimension</h2>
<p class="figure-note">${esc(input.dimensions.report.rule)}</p>
<table>
  <thead><tr>
    <th>Dimension</th><th class="num">Asserted</th><th class="num">Cells</th>
    <th class="num">Not measured</th><th>Why</th>
  </tr></thead>
  <tbody>
${dimensionRows}
  </tbody>
</table>

<footer>
  This document states what QAAI measured. It is not an assertion about the application's
  quality, its security or its fitness for any purpose, and it does not claim the measured
  surface is the whole surface. Re-run the export to verify the fingerprint: it is stable over
  the denominator definition, the enumerator version and the item set, and it deliberately
  excludes the issue time and the issuer, so two exports of one measurement are one claim.
</footer>
</body>
</html>
`;
}

coverageRouter.get(
  '/:projectId/attestation',
  requireScope('tests:read'),
  async (req, res) => {
    const query = attestationQuery.parse(req.query);
    const projectId = String(req.params.projectId);
    const actor = actorOf(req);
    const { attestation, dimensions } = await buildAttestation({
      orgId: actor.orgId,
      projectId,
      issuedByUserId: actor.userId || null,
    });

    let recorded: { id: string; created: boolean } | null = null;
    if (query.record === 'true' || query.record === '1') {
      recorded = await storeAttestation({ orgId: actor.orgId, projectId, attestation });
    }

    const format = query.format ?? 'json';
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        // The FINGERPRINT in the filename, not the date: two files with the
        // same name are the same claim, which is what makes "is this the one
        // you were sent?" answerable from a downloads folder.
        `attachment; filename="qaai-coverage-${attestation.fingerprint.slice(0, 12)}.csv"`,
      );
      res.send(attestationCsv(attestation));
      return;
    }
    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.send(attestationHtml({ attestation, dimensions }));
      return;
    }

    res.json({
      /*
       * `attestationPayload` and not the branded value: `JSON.stringify` drops
       * the symbol anyway, and a reader who did not know that would reasonably
       * assume the brand survived the round trip. It does not — which is why
       * `attest` is the only way back IN, and a stored attestation read from
       * the database is DATA that must be re-attested rather than asserted.
       */
      attestation: attestationPayload(attestation),
      scopeLines: attestationScopeLines(attestation),
      dimensions: dimensions.report.measurements,
      rule: dimensions.report.rule,
      recorded,
      formats: ['json', 'csv', 'html'],
      why:
        'The HTML format is print-ready: open it and print to PDF. There is deliberately no PDF ' +
        'endpoint — a headless browser in the API process would be a second renderer whose output ' +
        "nobody compares against the first, and the browser's PDF is the one you can check " +
        'against the screen. `recorded: null` means this deployment could not store the issue ' +
        'record; every claim in the document is still computed, and what is missing is only our ' +
        'own note that we issued it.',
    });
  },
);

/**
 * Record an attestation, and return the one that already says this if there is
 * one.
 *
 * A POST because it writes, and idempotent on the FINGERPRINT because
 * re-exporting an unchanged measurement is one claim: `@@unique([projectId,
 * fingerprint])` means the second request returns the first row's id with
 * `created: false` rather than minting a second document that says the same
 * thing. That is what makes "is this the PDF you were sent?" answerable.
 */
coverageRouter.post(
  '/:projectId/attestation',
  requireRole('MEMBER'),
  requireScope('tests:write'),
  async (req, res) => {
    const projectId = String(req.params.projectId);
    const actor = actorOf(req);
    const { attestation } = await buildAttestation({
      orgId: actor.orgId,
      projectId,
      issuedByUserId: actor.userId || null,
    });
    const recorded = await storeAttestation({ orgId: actor.orgId, projectId, attestation });
    if (recorded === null) {
      throw new ApiError(
        501,
        'ATTESTATION_STORE_UNAVAILABLE',
        'The attestation was computed and could not be recorded: the migration that mints CoverageAttestation is not applied on this deployment. GET /coverage/:projectId/attestation still serves the document — what is unavailable is the record that we issued it.',
      );
    }

    await audit({
      actor,
      action: 'coverage.attestation.issue',
      targetType: 'Project',
      targetId: projectId,
      metadata: {
        attestationId: recorded.id,
        fingerprint: attestation.fingerprint,
        // The FIGURE, in the audit row, because "what did we tell the customer
        // their coverage was on the day they signed" is the question an audit
        // trail of this exists to answer.
        percent: attestation.percent,
        denominator: attestation.denominator,
        reused: !recorded.created,
      },
    });

    res.status(recorded.created ? 201 : 200).json({
      attestation: attestationPayload(attestation),
      recorded,
      why: recorded.created
        ? 'Recorded.'
        : 'An attestation with this fingerprint already exists, so the existing record was returned rather than a second document that says the same thing with a different id.',
    });
  },
);

/** The attestations issued for this project. The read half of the table. */
coverageRouter.get(
  '/:projectId/attestations',
  requireScope('tests:read'),
  async (req, res) => {
    const rows = await storedAttestations(String(req.params.projectId));
    res.json({
      attestations: rows,
      why:
        'Newest first. `attestations: null` means this deployment cannot answer — the migration ' +
        'that mints CoverageAttestation is not applied — and must not be read as "none were ' +
        'issued". The scope section and the caps are NOT on these rows: they are the whole ' +
        'document, and this list exists so a reader can pick the fingerprint they want.',
    });
  },
);
