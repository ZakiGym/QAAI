/**
 * Suite health — "is this suite still worth what it costs to run?"
 *
 * Every other read endpoint in this API answers a question about a run. This
 * one answers a question about the SUITE: how much of it is the same test
 * written twice, how much of it would fail to notice a regression, and what
 * that adds up to as a number somebody can put on a dashboard.
 *
 * Read-only and derived. Nothing here writes a row, quarantines a test, or
 * proposes a deletion — and the analysis module is built so it cannot: every
 * duplicate pair it returns carries `safeToDelete: false`, because a
 * "duplicate" that differs in one assertion is regularly the only test that
 * catches a regression and deleting it is unrecoverable.
 *
 *   curl -s "$QAAI_API_URL/suite-health/$PROJECT?minSimilarity=0.7" \
 *     -H "authorization: Bearer $QAAI_API_KEY" | jq '.score, .components'
 *
 * The score is returned decomposed on purpose. A single number nobody can take
 * apart is a number nobody trusts, and the first question anyone asks about a
 * 62 is "which part is bad?" — so `components` carries per-component scores,
 * the weight each one actually got, its contribution in points, and a sentence
 * of evidence, plus `formula`, which is the arithmetic written out.
 *
 * WHY THE IMPORT BELOW IS A RELATIVE PATH: @qaai/agent exports only its barrel
 * (`"exports": { ".": "./src/index.ts" }`), and adding `suite-health.js` to
 * that barrel is a change to a file this work is not permitted to touch. The
 * relative specifier resolves identically under tsc and tsx. See
 * `needsOwnerDecision` — one line in packages/agent/src/index.ts turns this
 * back into a `@qaai/agent` import.
 */

import { Router } from 'express';
import { z } from 'zod';
import { FIXTURE_PREFIX } from '@qaai/shared';
import { prisma } from '../lib/prisma.js';
import { notFound } from '../lib/errors.js';
import { requireAuth, requireScope } from '../middleware/auth.js';
import {
  analyzeSuiteHealth,
  extractBehavior,
} from '../../../../packages/agent/src/suite-health.js';

export const suiteHealthRouter: Router = Router();

suiteHealthRouter.use(requireAuth);

/**
 * How many tests one request will read. This is a memory guard — the analysis
 * needs every test's `code` in hand at once — not an opinion about suite size.
 *
 * Hitting it does NOT silently produce a score over a sample. `limits.partial`
 * goes true and `limits.note` says what was left out, because a health score
 * computed over an unstated subset is worse than no score: it is a number that
 * looks authoritative and is not.
 */
const MAX_TESTS = 2000;

const querySchema = z.object({
  /**
   * Pairs scoring below this are not reported. Lowering it surfaces looser
   * overlaps and costs precision; the default is the module's own.
   */
  minSimilarity: z.coerce.number().min(0).max(1).optional(),
  maxReportedPairs: z.coerce.number().int().min(1).max(500).optional(),
});

suiteHealthRouter.get('/:projectId', requireScope('tests:read'), async (req, res) => {
  const options = querySchema.parse(req.query);

  // Tenancy is enforced by the Prisma extension, so a project belonging to
  // another org reads as absent — which is exactly the behaviour notFound()
  // exists to give. This endpoint must not become an existence oracle.
  const project = await prisma.project.findUnique({
    where: { id: String(req.params.projectId) },
    select: { id: true, name: true },
  });
  if (!project) throw notFound('Project');

  /*
   * The same candidate set POST /runs builds: enabled, non-fixture tests.
   * Disabled rows and `fixtures/` helpers are not tests you can run, and
   * grading the suite on rows that never execute would mean a team could raise
   * its score by disabling the tests that were failing.
   *
   * Quarantined tests are deliberately kept IN. A quarantine is a signal
   * switched off, not a test that stopped existing, and it has to cost the
   * score something — see the `quarantine` component.
   */
  const where = {
    projectId: project.id,
    disabledAt: null,
    filePath: { not: { startsWith: FIXTURE_PREFIX } },
  } as const;

  const [tests, totalMatching] = await Promise.all([
    prisma.test.findMany({
      where,
      // Deterministic: two calls a second apart must analyse the same rows, or
      // the score moves for reasons nobody can trace back to a code change.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_TESTS,
      select: {
        id: true,
        name: true,
        filePath: true,
        type: true,
        priority: true,
        feature: true,
        tags: true,
        code: true,
        spec: true,
        flakeRate: true,
        quarantined: true,
        consecutiveFailures: true,
      },
    }),
    prisma.test.count({ where }),
  ]);

  /*
   * Latest crawl only. Older versions describe an app that no longer exists,
   * and stale journeys would report critical-path coverage against routes the
   * product has since moved. No flow map at all is fine: the coverage
   * component reports itself unmeasured and its weight is redistributed.
   */
  const flowMap = await prisma.flowMap.findFirst({
    where: { projectId: project.id },
    orderBy: { version: 'desc' },
    select: { graph: true, version: true },
  });

  const report = analyzeSuiteHealth({
    // No cast: the selected columns already satisfy SuiteHealthTestInput, and
    // `spec` is declared `unknown` there precisely so a Prisma JsonValue drops
    // straight in. If this ever stops compiling, the select drifted from the
    // analysis input — which is the compile error you want, not one to silence.
    tests,
    flowMapGraph: flowMap?.graph ?? null,
    // Absent query params arrive as undefined and the analysis falls back to
    // its own defaults, so there is nothing to branch on here.
    options: {
      minSimilarity: options.minSimilarity,
      maxReportedPairs: options.maxReportedPairs,
    },
  });

  const partial = totalMatching > tests.length;

  res.json({
    projectId: project.id,
    score: report.score,
    grade: report.grade,
    components: report.components,
    formula: report.formula,
    duplicates: report.duplicates,
    duplicateClusters: report.duplicateClusters,
    weakAssertions: report.weakAssertions,
    criticalPaths: report.criticalPaths,
    totals: report.totals,
    /**
     * Named, not counted. "3 tests were skipped" tells the reader nothing they
     * can act on; the test that could not be parsed is the one they need to
     * open, and a suite-health report that quietly drops rows is exactly the
     * kind of reporting problem this codebase has been bitten by before.
     */
    unanalyzed: report.unanalyzed,
    limits: {
      ...report.limits,
      /** True when the score covers only part of the suite. Read it first. */
      partial,
      maxTests: MAX_TESTS,
      testsAnalyzed: tests.length,
      testsMatching: totalMatching,
      note: partial
        ? `This project has ${totalMatching} runnable tests and this report covers the oldest ${tests.length}. The score describes that subset, not the suite.`
        : null,
      /**
       * Surfaced because it changes how much to trust critical-path coverage:
       * with no flow map there are no journeys to measure against, and that
       * component reports itself unmeasured rather than guessing.
       */
      flowMapVersion: flowMap?.version ?? null,
      /** Disabled tests and `fixtures/` rows are out of scope by construction. */
      scope: 'enabled, non-fixture tests; quarantined tests included',
    },
  });
});

/**
 * The behaviour the analysis extracted from one test, and nothing else.
 *
 * "Why is this called a duplicate of that?" and "why is my strong test flagged
 * weak?" both have the same answer — the routes, actions and assertions we
 * read out of it — and that answer has to be inspectable BEFORE somebody acts
 * on a finding, not after they have argued with it. Everything here is derived
 * from the row the caller already owns; nothing new is disclosed.
 */
suiteHealthRouter.get('/:projectId/tests/:testId', requireScope('tests:read'), async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: String(req.params.projectId) },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const test = await prisma.test.findFirst({
    where: { id: String(req.params.testId), projectId: project.id },
    select: {
      id: true,
      name: true,
      filePath: true,
      type: true,
      priority: true,
      feature: true,
      tags: true,
      code: true,
      spec: true,
      flakeRate: true,
      quarantined: true,
      consecutiveFailures: true,
    },
  });
  if (!test) throw notFound('Test');

  // The same extractor the project report runs, so what is shown here cannot
  // drift from what the score was computed from.
  const behavior = extractBehavior(test);
  const report = analyzeSuiteHealth({ tests: [test] });

  res.json({
    testId: test.id,
    name: test.name,
    /** The comparison keys. Two tests are duplicates iff these agree. */
    behavior: {
      routes: behavior.routes,
      actions: behavior.actions,
      assertions: behavior.assertions,
      data: behavior.data,
      assertionSites: behavior.assertionSites,
    },
    /**
     * NO_NEGATIVE_PATH is absent by construction, not by omission. It is a
     * judgement about a whole feature — "nothing here exercises an error path"
     * — and one test taken alone cannot support it. Reporting it from a
     * single-test view would accuse a test whose sibling already covers the
     * error case. Ask the project report for it.
     */
    weakAssertions: report.weakAssertions.filter((f) => f.kind !== 'NO_NEGATIVE_PATH'),
    incomplete: behavior.incomplete,
    incompleteReason: behavior.incompleteReason,
  });
});
