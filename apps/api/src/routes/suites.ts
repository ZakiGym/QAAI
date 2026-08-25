/**
 * Suites (§5) — the saved selection of tests that a schedule, a monitor or a
 * run is pointed at.
 *
 * `Suite` has been a full model since the schema was written: tests carry
 * `suiteId`, `createRunSchema` accepts a `suiteId`, and Schedule and Monitor
 * both hang off one with a NOT NULL column. What it never had was a way in.
 * There is no endpoint anywhere in this API that creates a suite, so every
 * feature that depends on one — scheduled runs, synthetic monitoring, running a
 * named subset instead of the whole project — is unreachable in a running
 * deployment. This file is that way in, and nothing more: it does not change
 * what a suite MEANS to the runner, only who can make, name and fill one.
 *
 * It is written as a sibling of the batch endpoints in projects.ts and follows
 * them deliberately, because assignment has the same shape as a batch move: the
 * tree drops forty files onto a suite in one gesture, and forty separate writes
 * that can stop on the thirty-ninth leave a suite matching neither what the user
 * dragged nor what they had before. So the whole set is validated before the
 * transaction opens, each write is a compare-and-set against the world it was
 * planned against, and a batch either lands completely or not at all.
 *
 * ── WHAT DELETING A SUITE DOES, AND WHAT IT REFUSES ─────────────────────────
 *
 * Four things point at a suite, and the FK behaviour differs for each, so the
 * endpoint decides rather than letting the database decide silently:
 *
 *   Test.suiteId       SetNull  — the tests survive, unassigned. Done here as an
 *                                 explicit write inside the transaction so the
 *                                 count is something the response and the audit
 *                                 row can state.
 *   Run.suiteId        SetNull  — history survives with no suite. Left to the FK:
 *                                 a past run is a record of what happened, and
 *                                 rewriting it is the one thing deletion must not
 *                                 do.
 *   Schedule.suiteId   Cascade  — REFUSED. The column is NOT NULL, so the only
 *                                 thing the database can do is delete the
 *                                 schedule, and deleting somebody's nightly run
 *                                 as a side effect of tidying up a suite is not
 *                                 a decision an API should make on its own.
 *   Monitor.suiteId    Cascade  — REFUSED, same reasoning. A monitor is what
 *                                 pages a human; it must not vanish quietly.
 *   OwnershipRule      Cascade  — deleted, explicitly, and counted. A rule whose
 *                                 subject is this suite has nothing left to
 *                                 point at once it is gone — the model allows a
 *                                 test, a suite, a feature or a path and no
 *                                 fifth option — so refusing would be a dead end
 *                                 rather than a decision. The rules and their
 *                                 owners go into the audit metadata, which is
 *                                 what keeps the loss recoverable by hand.
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { conflict, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const suitesRouter: Router = Router();

suitesRouter.use(requireAuth);

/**
 * Suites per project.
 *
 * A suite is a saved selection somebody made by hand, and nobody hand-makes two
 * hundred of them; past this the list has stopped being navigable and the
 * creation loop is a script, not a person. The cap is checked on create rather
 * than trusted to the UI, exactly like the plan limits in projects.ts.
 */
const MAX_SUITES_PER_PROJECT = 200;

/**
 * Tests one assignment may carry. The same number as `BATCH_MAX_FILES` in
 * projects.ts and for the same reasons: every test in the batch costs a
 * statement inside an open transaction, so the cap bounds how long that
 * transaction holds its row locks — and it bounds the audit row, which records
 * every test id because "40 tests assigned" without saying which is not a record
 * of anything.
 */
const BATCH_MAX_TESTS = 200;

/** Long enough for "Checkout smoke — EU", short enough to render in a tree row. */
const suiteName = z.string().trim().min(1).max(80);

/**
 * Tags are matched against `Test.tags`, so the shape here is the shape a tag
 * has: short, and few. The cap is not a guess about how people label things — it
 * is what stops a stored array from growing without bound through an endpoint
 * that has no other reason to be large.
 */
const tagFilter = z.array(z.string().trim().min(1).max(50)).max(50);

const createSuiteSchema = z.object({
  name: suiteName,
  description: z.string().trim().max(500).optional(),
  tagFilter: tagFilter.optional(),
});

/**
 * Every field optional, and at least one of them required.
 *
 * A PATCH with an empty body is not a no-op worth writing a row and an audit
 * line for — it is a caller that meant something and sent nothing, and the
 * honest answer is to say so. `description: null` is a real instruction
 * (clear it) and is therefore distinct from the field being absent.
 */
const updateSuiteSchema = z
  .object({
    name: suiteName.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    tagFilter: tagFilter.optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined || input.description !== undefined || input.tagFilter !== undefined,
    { message: 'Nothing to change — send a name, a description or a tagFilter' },
  );

const assignTestsSchema = z.object({
  testIds: z.array(z.string().min(1)).min(1).max(BATCH_MAX_TESTS),
});

/**
 * The project, or a 404.
 *
 * `prisma` is the tenant-scoped client, so this `where` is joined by an implicit
 * orgId — there is deliberately no orgId here. Another organisation's project id
 * simply does not come back, and that becomes the same 404 as an id that never
 * existed: confirming that an id exists but is not yours is an existence oracle
 * (lib/errors.ts).
 */
async function projectOr404(projectId: string): Promise<{ id: string }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, archivedAt: true },
  });
  if (!project || project.archivedAt) throw notFound('Project');
  return { id: project.id };
}

/** The suite, or a 404 — including when it belongs to another project of yours. */
async function suiteOr404(
  projectId: string,
  suiteId: string,
): Promise<{ id: string; name: string; description: string | null; tagFilter: string[] }> {
  /*
   * The PROJECT is checked first, not just the suite's parentage.
   *
   * `suiteOr404` guards every mutating route, and it used to confirm only that
   * the suite belonged to the project named in the URL — which is true of an
   * ARCHIVED project too. So a project taken out of service stayed fully
   * writable through its suites: tests could be assigned inside it, suites
   * renamed and deleted, all of it audited as live work on something the rest
   * of the product treats as gone. List and create already went through
   * `projectOr404`; the four that actually change data did not.
   */
  await projectOr404(projectId);

  const suite = await prisma.suite.findUnique({
    where: { id: suiteId },
    select: { id: true, projectId: true, name: true, description: true, tagFilter: true },
  });
  if (!suite || suite.projectId !== projectId) throw notFound('Suite');
  return {
    id: suite.id,
    name: suite.name,
    description: suite.description,
    tagFilter: suite.tagFilter,
  };
}

/**
 * Every suite in the project, each with the number of tests in it.
 *
 * The count comes from ONE `groupBy` rather than a count per suite: this list is
 * what the tree's suite grouping is built from, it is fetched on every reload of
 * the panel, and a query per row is a round trip per row. Disabled tests are
 * excluded, because a soft-deleted file is not in the suite in any sense the
 * runner would agree with — it is not going to run.
 */
suitesRouter.get('/projects/:projectId/suites', async (req, res) => {
  const projectId = String(req.params.projectId);
  await projectOr404(projectId);

  const suites = await prisma.suite.findMany({
    where: { projectId },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      description: true,
      tagFilter: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const counts =
    suites.length === 0
      ? []
      : await prisma.test.groupBy({
          by: ['suiteId'],
          where: {
            projectId,
            disabledAt: null,
            suiteId: { in: suites.map((suite) => suite.id) },
          },
          _count: { _all: true },
        });

  const bySuite = new Map(counts.map((row) => [row.suiteId, row._count._all]));

  res.json({
    suites: suites.map((suite) => ({ ...suite, testCount: bySuite.get(suite.id) ?? 0 })),
  });
});

suitesRouter.post(
  '/projects/:projectId/suites',
  requireRole('MEMBER'),
  async (req, res) => {
    const actor = actorOf(req);
    const input = createSuiteSchema.parse(req.body);
    const projectId = String(req.params.projectId);
    await projectOr404(projectId);

    const existing = await prisma.suite.count({ where: { projectId } });
    if (existing >= MAX_SUITES_PER_PROJECT) {
      throw conflict(
        `This project already has ${MAX_SUITES_PER_PROJECT} suites — delete one before adding another`,
      );
    }

    /*
     * The name is unique per project in the schema. Checked here first so the
     * caller gets a sentence naming the suite it collided with rather than a
     * driver error, in the same shape projects.ts checks a slug.
     */
    if (await prisma.suite.findFirst({ where: { projectId, name: input.name } })) {
      throw conflict(`A suite called "${input.name}" already exists in this project`);
    }

    const suite = await prisma.suite.create({
      data: {
        orgId: actor.orgId,
        projectId,
        name: input.name,
        description: input.description ?? null,
        tagFilter: input.tagFilter ?? [],
      },
      select: {
        id: true,
        name: true,
        description: true,
        tagFilter: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await audit({
      actor,
      action: 'suite.create',
      targetType: 'Suite',
      targetId: suite.id,
      metadata: { name: suite.name, projectId },
    });

    res.status(201).json({ suite: { ...suite, testCount: 0 } });
  },
);

/**
 * Rename a suite, or change what it says about itself.
 *
 * The audit row carries the BEFORE values as well as the after. A suite's name
 * is what a schedule, a monitor and every past run report are read by, so a
 * rename with no record of the old name makes "why did the nightly run change?"
 * a question with no answer in the log.
 */
suitesRouter.patch(
  '/projects/:projectId/suites/:suiteId',
  requireRole('MEMBER'),
  async (req, res) => {
    const actor = actorOf(req);
    const input = updateSuiteSchema.parse(req.body);
    const projectId = String(req.params.projectId);
    const suite = await suiteOr404(projectId, String(req.params.suiteId));

    if (input.name !== undefined && input.name !== suite.name) {
      const clash = await prisma.suite.findFirst({
        where: { projectId, name: input.name, id: { not: suite.id } },
        select: { id: true },
      });
      if (clash) throw conflict(`A suite called "${input.name}" already exists in this project`);
    }

    const updated = await prisma.suite.update({
      where: { id: suite.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.tagFilter !== undefined ? { tagFilter: input.tagFilter } : {}),
      },
      select: {
        id: true,
        name: true,
        description: true,
        tagFilter: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await audit({
      actor,
      action: 'suite.update',
      targetType: 'Suite',
      targetId: suite.id,
      metadata: {
        before: { name: suite.name, description: suite.description, tagFilter: suite.tagFilter },
        after: {
          name: updated.name,
          description: updated.description,
          tagFilter: updated.tagFilter,
        },
      },
    });

    res.json({ suite: updated });
  },
);

/**
 * Delete a suite. The tests it held are NOT deleted — they are unassigned.
 *
 * The refusals and the cascades are laid out at the top of this file. What is
 * worth repeating here is why the unassignment is written out rather than left
 * to `onDelete: SetNull`: the FK would do it, but silently, and the number of
 * tests that just lost their suite is the single most useful thing this response
 * and this audit row can say. Doing it inside the transaction also means the
 * count is the count that was actually applied, not one read a moment earlier.
 */
suitesRouter.delete(
  '/projects/:projectId/suites/:suiteId',
  requireRole('MEMBER'),
  async (req, res) => {
    const actor = actorOf(req);
    const projectId = String(req.params.projectId);
    const suite = await suiteOr404(projectId, String(req.params.suiteId));

    const [schedules, monitors] = await Promise.all([
      prisma.schedule.findMany({ where: { suiteId: suite.id }, select: { id: true, name: true } }),
      prisma.monitor.findMany({ where: { suiteId: suite.id }, select: { id: true, name: true } }),
    ]);

    /*
     * Refused BEFORE the transaction opens, and named. Both columns are NOT NULL
     * with `onDelete: Cascade`, so proceeding would delete the automation
     * outright — and a person who deleted a suite to tidy up would find out that
     * their nightly run is gone the next morning, from its absence.
     */
    if (schedules.length > 0 || monitors.length > 0) {
      const pointing = [
        ...schedules.map((row) => `schedule "${row.name}"`),
        ...monitors.map((row) => `monitor "${row.name}"`),
      ];
      throw conflict(
        `${pointing.join(', ')} ${pointing.length === 1 ? 'runs' : 'run'} this suite — ` +
          'delete or re-point it first. Deleting the suite would delete it too.',
      );
    }

    const rules = await prisma.ownershipRule.findMany({
      where: { suiteId: suite.id },
      select: { id: true, ownerUserId: true, ownerTeamId: true },
    });

    const unassigned = await prisma.$transaction(async (tx) => {
      const cleared = await tx.test.updateMany({
        where: { projectId, suiteId: suite.id },
        data: { suiteId: null },
      });
      /*
       * Deleted here rather than left to the cascade, so the write is inside the
       * same transaction as the count that was just audited. A rule whose suite
       * is gone cannot be re-pointed — the model has four subjects and none of
       * them is "the suite that used to be here".
       */
      if (rules.length > 0) {
        await tx.ownershipRule.deleteMany({ where: { suiteId: suite.id } });
      }
      await tx.suite.delete({ where: { id: suite.id } });
      return cleared.count;
    });

    await audit({
      actor,
      action: 'suite.delete',
      targetType: 'Suite',
      targetId: suite.id,
      metadata: {
        name: suite.name,
        projectId,
        testsUnassigned: unassigned,
        // The rules cannot be restored from anywhere else. This is the record.
        ownershipRulesDeleted: rules.map((rule) => ({
          id: rule.id,
          ownerUserId: rule.ownerUserId,
          ownerTeamId: rule.ownerTeamId,
        })),
      },
    });

    res.json({ ok: true, testsUnassigned: unassigned, ownershipRulesDeleted: rules.length });
  },
);

/** One validated assignment: the row to write, and the suite it is coming out of. */
interface PlannedAssignment {
  id: string;
  filePath: string;
  name: string;
  /** The suite this test is in right now; null when it is in none. */
  from: string | null;
}

/**
 * Validate a whole set of assignments against the project, and hand back the
 * writes. THROWS BEFORE IT RETURNS if any of them is bad.
 *
 * That ordering is the entire point, and it is the same one `planMoves` in
 * projects.ts is built around: the caller opens its transaction knowing every
 * row has already been checked, so the failure this endpoint exists to prevent —
 * a forty-file drop that assigns thirty-nine and then discovers the fortieth is
 * deleted — cannot happen.
 *
 * `into` is the suite tests are being moved INTO, or null for the unassignment
 * route. Both directions go through here so "which tests may be written" cannot
 * come to mean one thing in one direction and something else in the other.
 */
async function planAssignments(
  projectId: string,
  testIds: readonly string[],
  into: { id: string; name: string } | null,
): Promise<PlannedAssignment[]> {
  /*
   * Deduplicated rather than rejected, which is what `tests/batch/delete` does
   * with a repeated id and for the same reason: two assignments of one test to
   * one suite are the same instruction said twice, and the answer is obvious.
   * (A batch MOVE rejects repeats, because two destinations for one file is a
   * contradiction with no right answer. This is not that.)
   */
  const ids = [...new Set(testIds)];

  /*
   * The scoped client again: another org's test id, another project's test id
   * and a made-up id all fail to come back, and the size check turns all three
   * into the same 404.
   */
  const rows = await prisma.test.findMany({
    where: { projectId, id: { in: ids } },
    select: { id: true, name: true, filePath: true, suiteId: true, disabledAt: true },
  });
  if (rows.length !== ids.length) throw notFound('Test');

  for (const row of rows) {
    if (row.disabledAt) {
      throw conflict(`${row.filePath} is deleted — restore it before putting it in a suite`);
    }
    if (into === null) {
      // Unassignment names the suite it expected, because "not in a suite" and
      // "in a different suite" are different mistakes with different fixes.
      if (row.suiteId === null) throw conflict(`${row.filePath} is not in a suite`);
    } else if (row.suiteId === into.id) {
      throw conflict(`${row.filePath} is already in "${into.name}"`);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    filePath: row.filePath,
    name: row.name,
    from: row.suiteId,
  }));
}

/**
 * Apply a planned set in one transaction, or apply none of it.
 *
 * Each write is a COMPARE-AND-SET on the suite the plan was made against, not an
 * update by id. Validation ran before the transaction opened, so in between some
 * other request may have moved one of these tests into a different suite; naming
 * `suiteId: plan.from` in the `where` makes each write assert the world it was
 * planned against. A row that moved matches nothing, the count comes back 0, and
 * throwing rolls the whole batch back rather than applying a plan to a project
 * that has changed underneath it.
 *
 * `updateMany` rather than `update` for the reason projects.ts gives: it reports
 * a count instead of throwing a Prisma error we would have to translate, and it
 * is filterable, so the tenancy extension merges the orgId into this `where` too.
 */
async function applyAssignments(
  projectId: string,
  planned: readonly PlannedAssignment[],
  into: string | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const assignment of planned) {
      const applied = await tx.test.updateMany({
        where: { id: assignment.id, projectId, suiteId: assignment.from },
        data: { suiteId: into },
      });
      if (applied.count !== 1) {
        throw conflict(
          `${assignment.filePath} changed suite while this batch was being applied — nothing was changed`,
        );
      }
    }
  });
}

/**
 * Put many tests into one suite — the tree's drag onto a suite row (feature 31).
 *
 * A test belongs to at most one suite, so assigning one that is already in
 * another suite MOVES it, and the audit records where each test came from. That
 * is the difference between a log that can answer "who took the payment tests
 * out of the smoke suite" and one that cannot.
 */
suitesRouter.post(
  '/projects/:projectId/suites/:suiteId/tests/assign',
  requireRole('MEMBER'),
  async (req, res) => {
    const actor = actorOf(req);
    const input = assignTestsSchema.parse(req.body);
    const projectId = String(req.params.projectId);
    const suite = await suiteOr404(projectId, String(req.params.suiteId));

    const planned = await planAssignments(projectId, input.testIds, suite);
    await applyAssignments(projectId, planned, suite.id);

    await audit({
      actor,
      action: 'suite.assign-tests',
      targetType: 'Suite',
      targetId: suite.id,
      metadata: {
        name: suite.name,
        tests: planned.length,
        assigned: planned.map((row) => ({ id: row.id, filePath: row.filePath, from: row.from })),
      },
    });

    res.json({
      assigned: planned.length,
      suiteId: suite.id,
      tests: planned.map((row) => ({ id: row.id, name: row.name, filePath: row.filePath })),
    });
  },
);

/**
 * Take many tests out of one suite. The tests are untouched otherwise — this
 * clears a column, it does not delete anything.
 *
 * Addressed through the suite rather than as "set suiteId to null on these
 * tests", so the request says which suite the caller believed it was emptying.
 * A test that has since been moved elsewhere is refused by name instead of being
 * quietly pulled out of a suite nobody asked about.
 */
suitesRouter.post(
  '/projects/:projectId/suites/:suiteId/tests/unassign',
  requireRole('MEMBER'),
  async (req, res) => {
    const actor = actorOf(req);
    const input = assignTestsSchema.parse(req.body);
    const projectId = String(req.params.projectId);
    const suite = await suiteOr404(projectId, String(req.params.suiteId));

    const planned = await planAssignments(projectId, input.testIds, null);

    const elsewhere = planned.find((row) => row.from !== suite.id);
    if (elsewhere) {
      throw conflict(`${elsewhere.filePath} is not in "${suite.name}"`);
    }

    await applyAssignments(projectId, planned, null);

    await audit({
      actor,
      action: 'suite.unassign-tests',
      targetType: 'Suite',
      targetId: suite.id,
      metadata: {
        name: suite.name,
        tests: planned.length,
        unassigned: planned.map((row) => ({ id: row.id, filePath: row.filePath })),
      },
    });

    res.json({
      unassigned: planned.length,
      suiteId: suite.id,
      tests: planned.map((row) => ({ id: row.id, name: row.name, filePath: row.filePath })),
    });
  },
);
