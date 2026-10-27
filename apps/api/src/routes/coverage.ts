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

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { FIXTURE_PREFIX, QUEUE_NAMES } from '@qaai/shared';
import type { Priority, TestType } from '@qaai/shared';
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
import { coverageProvenance } from '../lib/coverage-store.js';
import { prisma } from '../lib/prisma.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
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
