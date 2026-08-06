/**
 * The team workflow layer (§8) — the parts of QAAI that only matter once more
 * than one person reads the answers.
 *
 * Four features, one router, because they are one workflow: a failure belongs to
 * somebody (ownership), forty failures with one cause are one decision (bulk
 * triage), what happened overnight is one message (the digest), and a build that
 * is already broken should stop burning CI (fail-fast).
 *
 *   GET/POST/DELETE  /team/teams…            who exists
 *   GET/POST/DELETE  /team/ownership…        who owns what
 *   GET             /team/ownership/resolve  who owns THIS, and why
 *   POST            /team/triage/bulk        one verdict, N failures
 *   POST            /team/triage/batches/:id/undo
 *   GET/PUT         /team/digest             when to summarise
 *   POST            /team/runs/:id/stop      stop a run that is already red
 *
 * ── Two rules this file is built around ─────────────────────────────────────
 *
 * 1. A bulk decision is audited as N decisions, never as one. The audit log is
 *    the record of what a human actually reviewed, and a single row saying
 *    "reviewed 40" would be a claim nobody made. The `TriageBatch` row carries
 *    the fact that it was one act; the N audit rows carry the decisions.
 *
 * 2. Nothing here decides on a human's behalf. Ownership routes a notification;
 *    it never auto-assigns, auto-mutes or auto-closes. Bulk triage applies the
 *    verdict a person picked, to the rows that person selected, and is
 *    reversible.
 */

import { Router } from 'express';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { VERDICTS } from '@qaai/shared';
import type { Verdict } from '@qaai/shared';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import { clusterFailures } from '../lib/cluster.js';
import type { FailureInput, FailureNetworkInput } from '../lib/cluster.js';
import { notifyPrefsOf } from '../lib/chat-integrations.js';
import {
  MAX_OWNERSHIP_RULES_PER_PROJECT,
  OwnershipRuleError,
  normaliseRuleDraft,
  resolveOwnershipFor,
} from '../lib/ownership.js';
import type { OwnershipResolution, OwnershipRuleInput } from '../lib/ownership.js';

export const teamRouter: Router = Router();

teamRouter.use(requireAuth);

/**
 * The whole router sits above VIEWER, reads included.
 *
 * Ownership rules name people, and the resolve endpoint answers "who gets paged
 * for this" — that is org staffing, not test results. VIEWER exists for someone
 * who should see whether the build is green.
 */
teamRouter.use(requireRole('MEMBER'));

// ─── Teams ───────────────────────────────────────────────────────────────────

/** Handle length. Long enough for "platform-infrastructure", short enough to read in a digest. */
const MAX_SLUG = 40;

/**
 * A string query parameter, or ''.
 *
 * Not `String(req.query.x)`: Express parses `?projectId[oops]=1` into an object,
 * and stringifying one of those yields "[object Object]" — an id that matches
 * nothing, from a request that deserved a 400.
 */
function queryString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG);
}

const teamSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().max(MAX_SLUG).optional(),
});

teamRouter.get('/teams', async (_req, res) => {
  const teams = await prisma.team.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      members: { select: { userId: true } },
      _count: { select: { rules: true } },
    },
  });

  const userIds = [...new Set(teams.flatMap((team) => team.members.map((m) => m.userId)))];
  const users = await usersById(userIds);

  res.json({
    teams: teams.map((team) => ({
      id: team.id,
      name: team.name,
      slug: team.slug,
      createdAt: team.createdAt,
      ruleCount: team._count.rules,
      members: team.members.map((m) => users.get(m.userId) ?? { id: m.userId, name: null, email: null }),
    })),
  });
});

/**
 * Users are global, so this read is deliberately unscoped by id list rather than
 * by org — the ids themselves came from org-scoped rows, which is what keeps it
 * from becoming a directory of everyone.
 */
async function usersById(
  ids: string[],
): Promise<Map<string, { id: string; name: string | null; email: string | null }>> {
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, email: true },
  });
  return new Map(users.map((user) => [user.id, user]));
}

teamRouter.post('/teams', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = teamSchema.parse(req.body);

  const slug = slugify(input.slug ?? input.name);
  if (!slug) {
    throw badRequest('That name has no letters or digits in it — a team needs a readable handle.');
  }

  const existing = await prisma.team.findFirst({ where: { slug }, select: { id: true } });
  if (existing) throw conflict(`A team with the handle "${slug}" already exists.`);

  const team = await prisma.team.create({
    data: { orgId: actor.orgId, name: input.name, slug },
    select: { id: true, name: true, slug: true, createdAt: true },
  });

  await audit({ actor, action: 'team.create', targetType: 'Team', targetId: team.id, metadata: { slug } });
  res.status(201).json({ team });
});

teamRouter.delete('/teams/:teamId', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const team = await prisma.team.findUnique({
    where: { id: String(req.params.teamId) },
    select: { id: true, slug: true, _count: { select: { rules: true } } },
  });
  if (!team) throw notFound('Team');

  await prisma.team.delete({ where: { id: team.id } });

  // The rule count goes in the audit row because deleting a team unroutes every
  // rule that pointed at it, and six months later this is the only record that
  // those failures stopped reaching anyone.
  await audit({
    actor,
    action: 'team.delete',
    targetType: 'Team',
    targetId: team.id,
    metadata: { slug: team.slug, rulesRemoved: team._count.rules },
  });

  res.json({ deleted: true, rulesRemoved: team._count.rules });
});

teamRouter.post('/teams/:teamId/members', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const userId = z.object({ userId: z.string().trim().min(1) }).parse(req.body).userId;

  const team = await prisma.team.findUnique({
    where: { id: String(req.params.teamId) },
    select: { id: true, slug: true },
  });
  if (!team) throw notFound('Team');

  // Membership of the ORG is the gate. Adding someone who cannot see the org to
  // a team that receives its failures is a leak with a friendly name.
  const membership = await prisma.membership.findFirst({
    where: { orgId: actor.orgId, userId },
    select: { userId: true },
  });
  if (!membership) throw notFound('User');

  const member = await prisma.teamMember.upsert({
    where: { teamId_userId: { teamId: team.id, userId } },
    create: { orgId: actor.orgId, teamId: team.id, userId },
    update: {},
    select: { id: true, userId: true, createdAt: true },
  });

  await audit({
    actor,
    action: 'team.member.add',
    targetType: 'Team',
    targetId: team.id,
    metadata: { userId, slug: team.slug },
  });

  res.status(201).json({ member });
});

teamRouter.delete('/teams/:teamId/members/:userId', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const teamId = String(req.params.teamId);
  const userId = String(req.params.userId);

  const removed = await prisma.teamMember.deleteMany({ where: { teamId, userId } });
  if (removed.count === 0) throw notFound('Team member');

  await audit({
    actor,
    action: 'team.member.remove',
    targetType: 'Team',
    targetId: teamId,
    metadata: { userId },
  });

  res.json({ removed: true });
});

// ─── Ownership rules ─────────────────────────────────────────────────────────

const ruleSchema = z.object({
  projectId: z.string().trim().min(1),
  pathPattern: z.string().optional(),
  testId: z.string().optional(),
  suiteId: z.string().optional(),
  feature: z.string().max(120).optional(),
  ownerUserId: z.string().optional(),
  ownerTeamId: z.string().optional(),
  /** Where the rule sits among the path patterns. Defaults to last, so a new rule wins. */
  position: z.number().int().min(0).max(100_000).optional(),
});

/** Turns an OwnershipRuleError into the API's own 400 without losing the sentence. */
function asBadRequest(err: unknown): never {
  if (err instanceof OwnershipRuleError) throw badRequest(err.message);
  throw err;
}

teamRouter.get('/ownership', async (req, res) => {
  const projectId = queryString(req.query.projectId);
  if (!projectId) throw badRequest('projectId is required');

  const rules = await prisma.ownershipRule.findMany({
    where: { projectId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      position: true,
      pathPattern: true,
      testId: true,
      suiteId: true,
      feature: true,
      ownerUserId: true,
      ownerTeamId: true,
      createdAt: true,
      test: { select: { name: true, filePath: true } },
      suite: { select: { name: true } },
      ownerTeam: { select: { id: true, name: true, slug: true } },
    },
  });

  const users = await usersById(
    rules.map((rule) => rule.ownerUserId).filter((id): id is string => Boolean(id)),
  );

  res.json({
    rules: rules.map((rule) => ({
      ...rule,
      ownerUser: rule.ownerUserId ? (users.get(rule.ownerUserId) ?? null) : null,
    })),
    limits: { maxPerProject: MAX_OWNERSHIP_RULES_PER_PROJECT },
  });
});

teamRouter.post('/ownership', async (req, res) => {
  const actor = actorOf(req);
  const input = ruleSchema.parse(req.body);

  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const normalised = (() => {
    try {
      return normaliseRuleDraft(input);
    } catch (err) {
      return asBadRequest(err);
    }
  })();

  // The owner has to exist and has to be in this org, checked before the row is
  // written rather than at resolve time: a rule pointing at nobody looks like a
  // working rule right up until the failure it was supposed to route goes
  // nowhere.
  if (normalised.owner.kind === 'USER') {
    const membership = await prisma.membership.findFirst({
      where: { orgId: actor.orgId, userId: normalised.owner.userId },
      select: { userId: true },
    });
    if (!membership) throw notFound('User');
  } else {
    const team = await prisma.team.findUnique({
      where: { id: normalised.owner.teamId },
      select: { id: true },
    });
    if (!team) throw notFound('Team');
  }

  if (normalised.testId) {
    const test = await prisma.test.findUnique({
      where: { id: normalised.testId },
      select: { id: true, projectId: true },
    });
    if (!test || test.projectId !== project.id) throw notFound('Test');
  }
  if (normalised.suiteId) {
    const suite = await prisma.suite.findUnique({
      where: { id: normalised.suiteId },
      select: { id: true, projectId: true },
    });
    if (!suite || suite.projectId !== project.id) throw notFound('Suite');
  }

  const count = await prisma.ownershipRule.count({ where: { projectId: project.id } });
  if (count >= MAX_OWNERSHIP_RULES_PER_PROJECT) {
    throw conflict(
      `This project already has ${count} ownership rules, which is the maximum. Replace several explicit assignments with one path pattern.`,
    );
  }

  // Default to last, because CODEOWNERS is last-match-wins and someone adding a
  // rule today means it to beat the catch-all they wrote in January.
  const last = await prisma.ownershipRule.findFirst({
    where: { projectId: project.id },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  const position = input.position ?? (last ? last.position + 1 : 0);

  const rule = await prisma.ownershipRule.create({
    data: {
      orgId: actor.orgId,
      projectId: project.id,
      pathPattern: normalised.pathPattern,
      testId: normalised.testId,
      suiteId: normalised.suiteId,
      feature: normalised.feature,
      ownerUserId: normalised.owner.kind === 'USER' ? normalised.owner.userId : null,
      ownerTeamId: normalised.owner.kind === 'TEAM' ? normalised.owner.teamId : null,
      position,
      createdBy: actor.userId || null,
    },
  });

  await audit({
    actor,
    action: 'ownership.create',
    targetType: 'OwnershipRule',
    targetId: rule.id,
    metadata: { projectId: project.id, subject: normalised.subject, owner: normalised.owner },
  });

  res.status(201).json({ rule });
});

teamRouter.delete('/ownership/:ruleId', async (req, res) => {
  const actor = actorOf(req);
  const rule = await prisma.ownershipRule.findUnique({
    where: { id: String(req.params.ruleId) },
    select: { id: true, projectId: true, pathPattern: true, testId: true, suiteId: true, feature: true },
  });
  if (!rule) throw notFound('Ownership rule');

  await prisma.ownershipRule.delete({ where: { id: rule.id } });
  await audit({
    actor,
    action: 'ownership.delete',
    targetType: 'OwnershipRule',
    targetId: rule.id,
    metadata: { projectId: rule.projectId },
  });

  res.json({ deleted: true });
});

/**
 * Who owns these tests, and why.
 *
 * `?runId=` answers it for everything that failed in a run, which is the
 * question the run page and the digest both ask. `?testIds=` answers it for an
 * explicit list. Either way the reply carries the matched rules and the skipped
 * ones, because ownership is only trusted if it can be argued with.
 */
teamRouter.get('/ownership/resolve', async (req, res) => {
  const projectId = queryString(req.query.projectId);
  if (!projectId) throw badRequest('projectId is required');

  const runId = typeof req.query.runId === 'string' ? req.query.runId : null;
  const explicitIds =
    typeof req.query.testIds === 'string'
      ? req.query.testIds.split(',').map((id) => id.trim()).filter(Boolean).slice(0, 500)
      : [];

  let testIds = explicitIds;
  if (runId) {
    const results = await prisma.testResult.findMany({
      where: { runId, status: { in: ['FAILED', 'TIMED_OUT', 'FLAKY'] } },
      select: { testId: true },
      take: 500,
    });
    testIds = [...new Set([...testIds, ...results.map((r) => r.testId)])];
  }
  if (testIds.length === 0) {
    res.json({ tests: [], unowned: 0 });
    return;
  }

  const tests = await prisma.test.findMany({
    where: { id: { in: testIds }, projectId },
    select: { id: true, name: true, filePath: true, suiteId: true, feature: true },
  });

  const resolved = resolveOwnershipFor(tests, await ownershipRulesFor(projectId));
  const labelled = await labelOwners(resolved);

  res.json({
    tests: tests.map((test) => {
      const resolution = resolved.get(test.id)!;
      return {
        testId: test.id,
        name: test.name,
        filePath: test.filePath,
        owner: resolution.owner ? labelled.get(resolution.owner.ruleId) : null,
        reason: resolution.owner?.reason ?? null,
        matchedRules: resolution.matched.map((m) => ({ ruleId: m.ruleId, subject: m.subject })),
        // Surfaced, not swallowed: a rule that cannot be evaluated is a rule
        // that has silently stopped routing, and it looks exactly like a test
        // nobody has assigned yet.
        skippedRules: resolution.skipped,
      };
    }),
    unowned: tests.filter((test) => !resolved.get(test.id)?.owner).length,
  });
});

/** The project's rules in the shape the matcher wants. */
async function ownershipRulesFor(projectId: string): Promise<OwnershipRuleInput[]> {
  return prisma.ownershipRule.findMany({
    where: { projectId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    take: MAX_OWNERSHIP_RULES_PER_PROJECT,
    select: {
      id: true,
      position: true,
      pathPattern: true,
      testId: true,
      suiteId: true,
      feature: true,
      ownerUserId: true,
      ownerTeamId: true,
    },
  });
}

interface OwnerLabel {
  kind: 'USER' | 'TEAM';
  id: string;
  label: string;
}

/** Names for the winning owners, in two queries rather than one per test. */
async function labelOwners(
  resolutions: Map<string, OwnershipResolution>,
): Promise<Map<string, OwnerLabel>> {
  const winners = [...resolutions.values()].map((r) => r.owner).filter((m) => m !== null);

  const userIds: string[] = [];
  const teamIds: string[] = [];
  for (const match of winners) {
    if (match.owner.kind === 'USER') userIds.push(match.owner.userId);
    else teamIds.push(match.owner.teamId);
  }

  const [users, teams] = await Promise.all([
    usersById([...new Set(userIds)]),
    teamIds.length
      ? prisma.team.findMany({
          where: { id: { in: [...new Set(teamIds)] } },
          select: { id: true, name: true, slug: true },
        })
      : Promise.resolve([]),
  ]);
  const teamById = new Map(teams.map((team) => [team.id, team]));

  const byRule = new Map<string, OwnerLabel>();
  for (const match of winners) {
    if (match.owner.kind === 'USER') {
      const user = users.get(match.owner.userId);
      byRule.set(match.ruleId, {
        kind: 'USER',
        id: match.owner.userId,
        // A deleted user cascades its rules away, so this fallback should be
        // unreachable — it says "deleted" rather than nothing so that if it ever
        // is reached, the screen says something true.
        label: user?.name || user?.email || 'a deleted user',
      });
    } else {
      const team = teamById.get(match.owner.teamId);
      byRule.set(match.ruleId, {
        kind: 'TEAM',
        id: match.owner.teamId,
        label: team ? `@${team.slug}` : 'a deleted team',
      });
    }
  }
  return byRule;
}

// ─── Bulk triage ─────────────────────────────────────────────────────────────

/**
 * How many failures one decision may cover.
 *
 * Two hundred is well past the biggest cluster anyone has seen and still small
 * enough that the transaction, the audit fan-out and the undo stay ordinary.
 * A selection larger than this is not a triage decision, it is a migration.
 */
const MAX_BULK = 200;

const bulkSchema = z
  .object({
    action: z.enum(['accept', 'override', 'mute']),
    overrideTo: z.enum(VERDICTS).optional(),
    /** Why one verdict is right for all of them. Stored on the batch, shown in the audit row. */
    note: z.string().trim().max(500).optional(),
    verdictIds: z.array(z.string().trim().min(1)).max(MAX_BULK).optional(),
    /** The other way to select: everything in one failure cluster of one run. */
    runId: z.string().trim().min(1).optional(),
    clusterId: z.string().trim().min(1).optional(),
  })
  .refine((input) => input.action !== 'override' || Boolean(input.overrideTo), {
    message: 'overrideTo is required when the action is override',
    path: ['overrideTo'],
  })
  .refine((input) => Boolean(input.verdictIds?.length) || Boolean(input.runId && input.clusterId), {
    message: 'Send verdictIds, or a runId and clusterId to apply this to a whole failure cluster',
    path: ['verdictIds'],
  });

const REVIEW_STATE = {
  accept: 'ACCEPTED',
  override: 'OVERRIDDEN',
  mute: 'MUTED',
} as const;

/** The one project every member belongs to, or null when the batch spans more. */
function singleProjectOf(
  rows: Array<{ id: string }>,
  projectOf: Map<string, string>,
): string | null {
  const projects = new Set(rows.map((row) => projectOf.get(row.id)).filter(Boolean));
  return projects.size === 1 ? [...projects][0]! : null;
}

/**
 * Everything the batch needs about a verdict: what it says, what state it is in,
 * and enough of the result to name the test in a skip message and to file the
 * batch under the right project.
 */
const verdictSelection = {
  id: true,
  verdict: true,
  reviewState: true,
  overriddenTo: true,
  reviewedBy: true,
  reviewedAt: true,
  testResult: {
    select: {
      id: true,
      test: { select: { name: true } },
      run: { select: { projectId: true } },
    },
  },
} as const;

/**
 * `TestResult.network` is a Json column the worker writes. Trusted, but still
 * schemaless from Prisma's side, so it is read defensively — the same treatment
 * routes/clusters.ts gives it, for the same reason: a malformed row should cost
 * one cluster, not the whole request.
 */
function readFailedRequests(value: unknown): FailureNetworkInput[] {
  if (!Array.isArray(value)) return [];
  const failed: FailureNetworkInput[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.url !== 'string') continue;
    const status = typeof record.status === 'number' ? record.status : null;
    if (status !== null && status < 400) continue;
    failed.push({
      method: typeof record.method === 'string' ? record.method : 'GET',
      url: record.url,
      status,
    });
    if (failed.length >= 25) break;
  }
  return failed;
}

/**
 * Expand "this cluster of this run" into the results it contains.
 *
 * Recomputed from the run rather than taken from the client, because a cluster
 * id is a hash of a signature and not a stored key: accepting a list of ids from
 * the browser would mean the server never verifies that those forty failures
 * really do share a cause. This way the claim in the audit row — one decision,
 * one cause — is one the server checked.
 */
async function resultIdsInCluster(runId: string, clusterId: string): Promise<string[]> {
  const results = await prisma.testResult.findMany({
    where: { runId, status: { in: ['FAILED', 'TIMED_OUT', 'FLAKY'] } },
    select: {
      id: true,
      testId: true,
      status: true,
      errorMessage: true,
      retriedAndPassed: true,
      network: true,
      test: { select: { name: true, filePath: true } },
      steps: {
        where: { status: 'FAILED' },
        orderBy: { index: 'asc' },
        select: {
          index: true,
          status: true,
          title: true,
          errorMessage: true,
          errorStack: true,
          selector: true,
          expected: true,
          actual: true,
        },
      },
      verdict: { select: { verdict: true, overriddenTo: true, reviewState: true } },
    },
  });

  const failures: FailureInput[] = results
    .filter((r) => Boolean(r.errorMessage) || r.steps.length > 0)
    .map((r) => ({
      testResultId: r.id,
      testId: r.testId,
      testName: r.test.name,
      filePath: r.test.filePath,
      status: r.status,
      errorMessage: r.errorMessage,
      retriedAndPassed: r.retriedAndPassed,
      steps: r.steps,
      network: readFailedRequests(r.network),
      verdict: r.verdict,
    }));

  const report = clusterFailures(failures);
  const cluster = report.clusters.find((c) => c.id === clusterId);
  if (!cluster) {
    throw notFound(
      'That failure cluster',
    );
  }
  return cluster.members.map((member) => member.testResultId);
}

teamRouter.post('/triage/bulk', async (req, res) => {
  const actor = actorOf(req);
  const input = bulkSchema.parse(req.body);
  const reviewState = REVIEW_STATE[input.action];
  const overriddenTo = input.action === 'override' ? (input.overrideTo as Verdict) : null;

  const fromCluster = Boolean(input.runId && input.clusterId);
  const verdicts = fromCluster
    ? await prisma.triageVerdict.findMany({
        where: { testResultId: { in: await resultIdsInCluster(input.runId!, input.clusterId!) } },
        select: verdictSelection,
        take: MAX_BULK,
      })
    : await prisma.triageVerdict.findMany({
        where: { id: { in: input.verdictIds ?? [] } },
        select: verdictSelection,
      });

  if (verdicts.length === 0) {
    throw notFound('Those verdicts');
  }

  const eligible = verdicts.filter((v) => v.reviewState === 'PENDING');
  const skipped = verdicts
    .filter((v) => v.reviewState !== 'PENDING')
    .map((v) => ({
      verdictId: v.id,
      test: v.testResult.test.name,
      reason: `Already reviewed (${v.reviewState.toLowerCase()}) — left as it was.`,
    }));

  if (eligible.length === 0) {
    // Not an error. Somebody else got there first, which is a normal thing to
    // happen on a shared queue; no batch row is written because there is
    // nothing to undo.
    res.json({ batch: null, applied: 0, skipped });
    return;
  }

  /*
   * One timestamp, chosen here and written to both the batch and every verdict.
   *
   * It is the join between them. `updateMany` cannot report WHICH rows it wrote,
   * and a verdict that a colleague reviewed a millisecond earlier must not end
   * up in this batch — undoing it later would revert their decision, not ours.
   * Stamping our own instant and reading back exactly the rows carrying it gives
   * the true set in two statements instead of two hundred.
   */
  const stamp = new Date();
  const eligibleIds = eligible.map((v) => v.id);
  const projectOfVerdict = new Map(eligible.map((v) => [v.id, v.testResult.run.projectId]));

  const applied = await prisma.$transaction(async (tx) => {
    await tx.triageVerdict.updateMany({
      where: { id: { in: eligibleIds }, reviewState: 'PENDING' },
      data: { reviewState, reviewedBy: actor.userId || null, reviewedAt: stamp, overriddenTo },
    });

    const written = await tx.triageVerdict.findMany({
      where: { id: { in: eligibleIds }, reviewedAt: stamp, reviewState },
      select: { id: true, verdict: true, testResultId: true },
    });
    if (written.length === 0) return null;

    const previous = new Map(eligible.map((v) => [v.id, v]));

    const batch = await tx.triageBatch.create({
      data: {
        orgId: actor.orgId,
        // Only when the whole selection is one project's. The triage queue is
        // org-wide, so a hand-picked selection can legitimately span two — and
        // filing that batch under whichever project happened to be first would
        // put a row in the audit trail that says something untrue.
        projectId: singleProjectOf(written, projectOfVerdict),
        runId: fromCluster ? input.runId! : null,
        clusterId: fromCluster ? input.clusterId! : null,
        action: input.action,
        overriddenTo,
        note: input.note ?? null,
        appliedBy: actor.userId || '',
        createdAt: stamp,
        items: {
          create: written.map((row) => {
            const before = previous.get(row.id)!;
            return {
              orgId: actor.orgId,
              verdictId: row.id,
              testResultId: row.testResultId,
              previousReviewState: before.reviewState,
              previousOverriddenTo: before.overriddenTo,
              previousReviewedBy: before.reviewedBy,
              previousReviewedAt: before.reviewedAt,
            };
          }),
        },
      },
      select: { id: true, createdAt: true },
    });

    return { batch, written };
  });

  if (!applied) {
    // Every eligible row was taken between the read and the write.
    res.json({ batch: null, applied: 0, skipped });
    return;
  }

  /*
   * N audit rows, one per verdict — never one row saying "reviewed 40".
   *
   * This is the rule the whole feature is built around. A reviewer looked at one
   * cause and made one judgement, and the batch row records exactly that; but
   * forty verdicts changed, and forty things changing is what the audit log is
   * for. `batchId` and `batchSize` on every row are what let a reader see it was
   * one act without the log having to pretend it was one decision.
   */
  await Promise.all(
    applied.written.map((row) =>
      audit({
        actor,
        action: `verdict.${input.action}`,
        targetType: 'TriageVerdict',
        targetId: row.id,
        metadata: {
          from: row.verdict,
          to: overriddenTo ?? row.verdict,
          bulk: true,
          batchId: applied.batch.id,
          batchSize: applied.written.length,
          ...(fromCluster ? { clusterId: input.clusterId } : {}),
          ...(input.note ? { note: input.note } : {}),
        },
      }),
    ),
  );

  res.json({
    batch: { id: applied.batch.id, action: input.action, overriddenTo, createdAt: applied.batch.createdAt },
    applied: applied.written.length,
    skipped,
    undo: `/team/triage/batches/${applied.batch.id}/undo`,
  });
});

teamRouter.get('/triage/batches', async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 10) || 10));
  const batches = await prisma.triageBatch.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      action: true,
      overriddenTo: true,
      note: true,
      runId: true,
      clusterId: true,
      appliedBy: true,
      createdAt: true,
      undoneAt: true,
      undoneBy: true,
      _count: { select: { items: true } },
    },
  });

  res.json({
    batches: batches.map(({ _count, ...batch }) => ({ ...batch, size: _count.items })),
  });
});

/**
 * Undo a batch.
 *
 * Per-row conditional, and that is the whole design: a verdict is restored only
 * while it still holds exactly what this batch wrote (same state, same stamp).
 * Anything a colleague has re-reviewed since is left alone and reported back,
 * because silently reverting someone else's decision is not an undo — it is a
 * second bulk edit wearing an undo's clothes.
 */
teamRouter.post('/triage/batches/:batchId/undo', async (req, res) => {
  const actor = actorOf(req);
  const batch = await prisma.triageBatch.findUnique({
    where: { id: String(req.params.batchId) },
    select: {
      id: true,
      action: true,
      overriddenTo: true,
      createdAt: true,
      undoneAt: true,
      items: {
        select: {
          verdictId: true,
          previousReviewState: true,
          previousOverriddenTo: true,
          previousReviewedBy: true,
          previousReviewedAt: true,
        },
      },
    },
  });
  if (!batch) throw notFound('Triage batch');
  if (batch.undoneAt) throw conflict('That batch has already been undone.');

  const appliedState = REVIEW_STATE[batch.action as keyof typeof REVIEW_STATE];
  if (!appliedState) {
    throw conflict(`That batch recorded an action this version does not know how to undo (${batch.action}).`);
  }

  const restored = await prisma.$transaction(
    batch.items.map((item) =>
      prisma.triageVerdict.updateMany({
        where: { id: item.verdictId, reviewState: appliedState, reviewedAt: batch.createdAt },
        data: {
          reviewState: item.previousReviewState,
          overriddenTo: item.previousOverriddenTo,
          reviewedBy: item.previousReviewedBy,
          reviewedAt: item.previousReviewedAt,
        },
      }),
    ),
  );

  const restoredIds = batch.items
    .filter((_, index) => (restored[index]?.count ?? 0) > 0)
    .map((item) => item.verdictId);
  const keptIds = batch.items
    .map((item) => item.verdictId)
    .filter((id) => !restoredIds.includes(id));

  await prisma.triageBatch.update({
    where: { id: batch.id },
    data: { undoneAt: new Date(), undoneBy: actor.userId || null },
  });

  // An undo is N decisions too — reversing forty reviews is forty things that
  // changed, and a single row would be the same lie in the other direction.
  await Promise.all(
    restoredIds.map((verdictId) =>
      audit({
        actor,
        action: 'verdict.undo',
        targetType: 'TriageVerdict',
        targetId: verdictId,
        metadata: { batchId: batch.id, batchSize: restoredIds.length, undoneAction: batch.action },
      }),
    ),
  );

  res.json({
    restored: restoredIds.length,
    // Named, not just counted: "3 were left alone" is only actionable if you can
    // see which three and go look at them.
    keptIds,
  });
});

// ─── Digest configuration ────────────────────────────────────────────────────

/**
 * Where a digest can actually be delivered.
 *
 * Mirrors `partitionDestinations` in apps/worker/src/processors/digest.ts, which
 * only posts to providers whose webhook host can be pinned. A generic WEBHOOK
 * means unsealing a signing secret and posting to a host chosen by config, and
 * that is a decision to make deliberately rather than inherit. Stated here as
 * well so the refusal happens where someone is looking at the setting, instead
 * of silently at 8am.
 */
const DIGEST_CAPABLE = new Set(['SLACK', 'MSTEAMS', 'DISCORD']);
const GENERIC_WEBHOOK_REASON =
  'The digest is delivered to Slack, Teams and Discord only — a generic webhook cannot receive it yet.';

const digestSchema = z.object({
  projectId: z.string().trim().min(1),
  cron: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  notifyVia: z.array(z.string().trim().min(1)).max(20).optional(),
});

/** Next fire time, or a 400 naming which of the two fields is wrong. */
function nextFireTime(cron: string, timezone: string): Date {
  try {
    // Throws a RangeError on an unknown zone, which is a better error than
    // silently resolving to UTC and firing the digest at the wrong hour.
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw badRequest(`"${timezone}" is not a time zone. Use an IANA name such as Europe/Berlin.`);
  }

  try {
    return CronExpressionParser.parse(cron, { currentDate: new Date(), tz: timezone })
      .next()
      .toDate();
  } catch {
    throw badRequest(`"${cron}" is not a cron expression. A daily 08:00 digest is "0 8 * * *".`);
  }
}

teamRouter.get('/digest', async (req, res) => {
  const projectId = queryString(req.query.projectId);
  if (!projectId) throw badRequest('projectId is required');

  const digest = await prisma.digestSubscription.findUnique({ where: { projectId } });
  const destinations = await prisma.integration.findMany({
    where: { enabled: true, kind: { in: ['SLACK', 'MSTEAMS', 'DISCORD', 'WEBHOOK'] } },
    select: { id: true, kind: true, name: true, config: true },
  });

  res.json({
    digest,
    // Returned alongside so the settings screen can offer the real list rather
    // than asking someone to paste an integration id — and each one says whether
    // the digest can actually use it, because a picker that offers a
    // destination the worker will skip is how a team concludes the feature is
    // broken. `optedOut` is the integration's own notify.digest preference —
    // the second reason the worker skips a destination, surfaced for the same
    // reason `supported` is.
    destinations: destinations.map((destination) => ({
      id: destination.id,
      kind: destination.kind,
      name: destination.name,
      supported: DIGEST_CAPABLE.has(destination.kind),
      optedOut: !notifyPrefsOf(destination.config).digest,
      ...(DIGEST_CAPABLE.has(destination.kind)
        ? {}
        : { unsupportedReason: GENERIC_WEBHOOK_REASON }),
    })),
  });
});

teamRouter.put('/digest', async (req, res) => {
  const actor = actorOf(req);
  const input = digestSchema.parse(req.body);

  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const existing = await prisma.digestSubscription.findUnique({
    where: { projectId: project.id },
    select: { cron: true, timezone: true },
  });

  const cron = input.cron ?? existing?.cron ?? '0 8 * * *';
  const timezone = input.timezone ?? existing?.timezone ?? 'UTC';
  const nextRunAt = nextFireTime(cron, timezone);

  if (input.notifyVia?.length) {
    const known = await prisma.integration.findMany({
      where: { id: { in: input.notifyVia } },
      select: { id: true, kind: true, config: true },
    });
    const missing = input.notifyVia.filter((id) => !known.some((k) => k.id === id));
    if (missing.length > 0) {
      throw badRequest(`No integration in this org with the id ${missing.join(', ')}.`);
    }
    // Refused here rather than skipped at 8am. A digest pointed exclusively at
    // destinations the worker cannot use — or that have opted out of the digest
    // in their own notification preference — is a digest that will never
    // arrive, and finding that out from an empty channel is the worst possible
    // way to learn it. A mix is allowed — the usable ones still get it.
    const usable = known.filter(
      (integration) =>
        DIGEST_CAPABLE.has(integration.kind) && notifyPrefsOf(integration.config).digest,
    );
    if (usable.length === 0) {
      throw badRequest(
        known.some((integration) => DIGEST_CAPABLE.has(integration.kind))
          ? 'Every selected integration has opted out of the digest in its notification preference. Turn the digest back on for one of them, or pick another destination.'
          : GENERIC_WEBHOOK_REASON,
      );
    }
  }

  const digest = await prisma.digestSubscription.upsert({
    where: { projectId: project.id },
    create: {
      orgId: actor.orgId,
      projectId: project.id,
      cron,
      timezone,
      enabled: input.enabled ?? true,
      notifyVia: input.notifyVia ?? [],
      nextRunAt,
    },
    update: {
      cron,
      timezone,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.notifyVia === undefined ? {} : { notifyVia: input.notifyVia }),
      nextRunAt,
    },
  });

  await audit({
    actor,
    action: 'digest.configure',
    targetType: 'DigestSubscription',
    targetId: digest.id,
    metadata: { projectId: project.id, cron, timezone, enabled: digest.enabled },
  });

  res.json({ digest });
});

// ─── Fail-fast ───────────────────────────────────────────────────────────────

/**
 * Ask a run to stop.
 *
 * This is the API half of enforcing `failFast` (§5). The flag has always been
 * accepted by POST /runs and honestly reported as doing nothing, because there
 * was nowhere to put the request: stopping a run is the worker's act, and the
 * worker's only durable channel is the run row it already polls between tests.
 * `Run.stopRequestedAt` is that channel, and this endpoint is a human writing to
 * it directly — the same column the worker will write when a fail-fast run hits
 * its first real failure.
 *
 * Deliberately not `status = CANCELLED`. Cancelled means nobody wanted the
 * answer; a fail-fast stop means the answer arrived early and was bad. Filing
 * the second as the first is how a broken build ends up in the same bucket as an
 * abandoned one.
 */
teamRouter.post('/runs/:runId/stop', async (req, res) => {
  const actor = actorOf(req);
  const reason = z
    .object({ reason: z.string().trim().max(200).optional() })
    .parse(req.body ?? {}).reason;

  const run = await prisma.run.findUnique({
    where: { id: String(req.params.runId) },
    select: { id: true, status: true, stopRequestedAt: true, stopReason: true, failFast: true },
  });
  if (!run) throw notFound('Run');

  if (run.status !== 'QUEUED' && run.status !== 'RUNNING') {
    throw conflict(`That run has already finished (${run.status.toLowerCase()}).`);
  }
  if (run.stopRequestedAt) {
    // Idempotent: pressing stop twice is a person wondering whether the first
    // press worked, not an error.
    res.json({
      stopRequestedAt: run.stopRequestedAt,
      stopReason: run.stopReason,
      alreadyRequested: true,
    });
    return;
  }

  const stopReason = reason
    ? `Stopped by a reviewer: ${reason}`
    : 'Stopped by a reviewer from the cockpit.';

  /*
   * Conditional, so the first writer wins and the reason on the row names
   * whoever actually stopped it. A fail-fast trip from the worker and a person
   * pressing stop can race, and the run must end up with one story.
   */
  const claimed = await prisma.run.updateMany({
    where: { id: run.id, stopRequestedAt: null, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { stopRequestedAt: new Date(), stopReason },
  });

  if (claimed.count === 0) {
    const current = await prisma.run.findUnique({
      where: { id: run.id },
      select: { stopRequestedAt: true, stopReason: true },
    });
    res.json({ ...current, alreadyRequested: true });
    return;
  }

  await audit({
    actor,
    action: 'run.stop',
    targetType: 'Run',
    targetId: run.id,
    metadata: { reason: stopReason, failFast: run.failFast },
  });

  logger.info({ runId: run.id }, 'stop requested');

  res.json({
    stopRequestedAt: new Date(),
    stopReason,
    alreadyRequested: false,
    /*
     * Said out loud, because the difference between "requested" and "stopped" is
     * a whole test. The worker checks between tests — never mid-test, since a
     * half-executed test recorded as a failure is exactly the false signal this
     * product exists to remove.
     */
    note: 'The run stops after the test that is currently executing finishes. Tests that never ran are recorded as skipped.',
  });
});
