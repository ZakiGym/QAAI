/**
 * Test impact analysis — "which of my tests does this PR actually need?"
 *
 * Read-only by design: nothing here queues a run or writes a row. It answers the
 * question and hands back `testIds`, which is exactly the field POST /runs
 * already accepts. That is what makes this usable today without touching the run
 * endpoint — a CI step calls /impact/analyze with the PR's changed files and
 * posts the returned ids as the run's `testIds`:
 *
 *   changed=$(git diff --name-only --no-renames origin/main...HEAD | jq -Rsc 'split("\n")-[""]')
 *   ids=$(curl -s $QAAI_API_URL/impact/analyze -H "authorization: Bearer $QAAI_API_KEY" \
 *          -d "{\"projectId\":\"$PROJECT\",\"changedPaths\":$changed}" | jq -c .testIds)
 *   curl -s $QAAI_API_URL/runs -d "{\"environmentId\":\"$ENV\",\"testIds\":$ids,...}"
 *
 * `--no-renames` is load-bearing, not tidiness. Git detects renames by default
 * and `--name-only` then prints the postimage alone, so renaming
 * `app/checkout/page.tsx` to `app/basket/page.tsx` reports one added file and
 * never says that /checkout is gone — and every checkout test gets parked on the
 * exact commit that 404s them. `--no-renames` reports the rename as a delete
 * plus an add, which is what the analysis needs to see. (`-M0` does NOT do this:
 * it sets a 0% similarity threshold, which detects MORE renames, not fewer.)
 * `git diff --name-status origin/main...HEAD` and passing both of an `R` line's
 * paths works too, at the cost of parsing.
 *
 * The selection this returns is drawn from the same candidate set POST /runs
 * builds — enabled, non-fixture tests in the project — so every id it hands back
 * is one that endpoint will accept.
 */

import { Router } from 'express';
import { z } from 'zod';
import { FIXTURE_PREFIX } from '@qaai/shared';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound } from '../lib/errors.js';
import { MAX_CHANGED_PATHS, analyzeImpact, indexTests } from '../lib/impact.js';
import { requireAuth, requireScope } from '../middleware/auth.js';

export const impactRouter: Router = Router();

impactRouter.use(requireAuth);

const analyzeSchema = z.object({
  projectId: z.string().min(1),
  /**
   * Repo-relative paths exactly as the diff reports them (`git diff --name-only
   * --no-renames`, GitHub's files API). Deleted files count: removing a page is
   * a change to it.
   *
   * BOTH SIDES OF A RENAME MUST BE SENT. The analysis reasons about the routes a
   * path serves, so a rename it only hears the new half of reads as "a new page
   * appeared" instead of "the old page is gone", and the tests that still visit
   * the old URL look unaffected right up until they 404. Rename detection is on
   * by default in git and hides the old path — hence `--no-renames` above, or
   * `--name-status` with both paths of each `R` line.
   *
   * The cap is a request-size guard, not the analysis limit — anything past
   * MAX_CHANGED_PATHS is answered with "run everything" rather than a 400, since
   * a caller with a huge diff wants a safe answer, not an error.
   */
  changedPaths: z.array(z.string().min(1).max(1024)).max(10_000),
});

impactRouter.post('/analyze', requireScope('tests:read'), async (req, res) => {
  const input = analyzeSchema.parse(req.body);

  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  /*
   * Mirrors the runnable set in POST /runs: disabled tests and `fixtures/` rows
   * are not tests you can run, so listing them as "skipped" would inflate the
   * saving with rows that were never going to execute.
   */
  const tests = await prisma.test.findMany({
    where: {
      projectId: project.id,
      disabledAt: null,
      filePath: { not: { startsWith: FIXTURE_PREFIX } },
    },
    select: {
      id: true,
      name: true,
      filePath: true,
      code: true,
      spec: true,
      tags: true,
      feature: true,
      priority: true,
    },
  });

  // Latest crawl only. Older versions describe an app that no longer exists, and
  // stale routes would attach tests to features that have since moved.
  const flowMap = await prisma.flowMap.findFirst({
    where: { projectId: project.id },
    orderBy: { version: 'desc' },
    select: { graph: true, version: true },
  });

  const analysis = analyzeImpact({
    changedPaths: input.changedPaths,
    tests,
    flowMapGraph: flowMap?.graph ?? null,
  });

  res.json({
    ...analysis,
    /*
     * Surfaced because it changes how much to trust the answer: with no flow map
     * the analysis has only the tests' own route literals to work from, so it
     * cannot connect a changed route to a test that reaches it indirectly.
     */
    flowMapVersion: flowMap?.version ?? null,
    limits: { maxChangedPaths: MAX_CHANGED_PATHS },
  });
});

/**
 * What the analysis believes each test covers.
 *
 * Selection is only trustworthy if "why was my test skipped?" has an answer, and
 * that answer is almost always "it declares no route we could match". This shows
 * the extracted routes and tokens per test so that is visible before a skip
 * decision surprises someone, not after.
 */
impactRouter.get('/signals', requireScope('tests:read'), async (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) throw badRequest('projectId is required');

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const tests = await prisma.test.findMany({
    where: {
      projectId: project.id,
      disabledAt: null,
      filePath: { not: { startsWith: FIXTURE_PREFIX } },
    },
    select: {
      id: true,
      name: true,
      filePath: true,
      code: true,
      spec: true,
      tags: true,
      feature: true,
      priority: true,
    },
  });

  const flowMap = await prisma.flowMap.findFirst({
    where: { projectId: project.id },
    orderBy: { version: 'desc' },
    select: { graph: true, version: true },
  });

  const signals = indexTests(tests, flowMap?.graph ?? null).map((entry) => ({
    ...entry,
    // Tokens are a long tail of filename noise; the first few are the useful ones.
    tokens: entry.tokens.slice(0, 12),
  }));

  res.json({
    signals,
    flowMapVersion: flowMap?.version ?? null,
    /**
     * Tests declaring no route we can check a diff against: these can never be
     * skipped. Tags and a feature name do not count — only a feature the flow
     * map resolves into routes does.
     */
    unknownCount: signals.filter((s) => !s.known).length,
  });
});
