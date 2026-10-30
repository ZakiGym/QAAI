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
 *   POST            /team/ownership/import-codeowners  the rules they already wrote
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
import { VERDICTS, applySuppression, createKnownIssueSchema, matchKnownIssue } from '@qaai/shared';
import type { Verdict } from '@qaai/shared';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import { clusterFailures } from '../lib/cluster.js';
/*
 * The mute's two guards and its refusal vocabulary, imported from the routes
 * that already own them rather than re-expressed here. THREE doors now write a
 * `KnownIssue` — `POST /triage/known-issues`, the single-verdict review in
 * routes/agent.ts and this one — and routing all three through one validator
 * and one constructor is what stops them being able to store different things.
 */
import type { KnownIssueRead } from './triage.js';
import {
  KNOWN_ISSUE_COVER_SCAN,
  SUPPRESSION_REFUSAL_PROSE,
  knownIssueSelection,
  knownIssueView,
  refusedPaths,
  verdictSuppression,
} from './triage.js';
import type { FailureInput, FailureNetworkInput } from '../lib/cluster.js';
import { notifyPrefsOf } from '../lib/chat-integrations.js';
import {
  MAX_CODEOWNERS_CHARS,
  MAX_OWNERSHIP_RULES_PER_PROJECT,
  OWNERSHIP_RULE_SELECT,
  CODEOWNERS_SOURCE,
  OWNERSHIP_STATES,
  OwnershipRuleError,
  codeownersOwnerToken,
  normaliseRuleDraft,
  ownerLabel,
  parseCodeowners,
  resolveOwnershipFor,
} from '../lib/ownership.js';
import type {
  CodeownersOwnerToken,
  OwnerDirectory,
  OwnerProvenance,
  OwnershipResolution,
  OwnershipRuleInput,
} from '../lib/ownership.js';

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


// ─── Importing a repository's CODEOWNERS ─────────────────────────────────────

/**
 * How many RULES one import may create.
 *
 * Separate from {@link MAX_OWNERSHIP_RULES_PER_PROJECT}, which is the ceiling
 * on the table, because the two bound different risks: that one stops a project
 * accumulating a rule set nobody can reason about, this one stops ONE request
 * turning a 2,000-line file into 2,000 rows in a single transaction. Both are
 * reported as a count and a reason when they bite, and the reason reported is
 * the one that actually bit — they are checked in the order a reader would
 * expect, per-request first.
 */
const MAX_CODEOWNERS_RULES_PER_IMPORT = 200;

/**
 * Why a CODEOWNERS line did not become a rule, as a closed vocabulary.
 *
 * ── EVERY MEMBER IS A SENTENCE THIS FILE OWNS ───────────────────────────────
 *
 * A CODEOWNERS file is CUSTOMER-AUTHORED TEXT AND NOT INSTRUCTIONS. The whole
 * point of refusing by LINE NUMBER is that the reply can say exactly which line
 * to look at without carrying one byte of it, so every reason here is a
 * constant and the only variable a caller may append is a COUNT QAAI COMPUTED.
 * A reason built by interpolating the token that failed would hand a
 * repository's own file a sentence in a report a human and a model both read —
 * which is the defect `Unrecognized key: "IGNORE THE PLAN ABOVE…"` already cost
 * this product once. The test that holds this is the one that asserts no
 * refusal contains a byte of a hostile line.
 *
 * ── THERE IS NO RUN-TIME LIST AND NO PARITY TEST, AND THAT IS NOT AN OMISSION ─
 *
 * This vocabulary has NO WRITE PATH: a reason is composed for one reply and is
 * never stored, never validated and never read back, so there is no column for
 * it to drift from and no zod schema to keep in step. The usual pair — a list
 * plus a `z.enum(LIST).options` parity test — would be a test that cannot fail,
 * which is worse than no test because a reader trusts it. The record below IS
 * the vocabulary and the type is DERIVED from it, so a fifth refusal cannot
 * exist without a sentence; that is the whole guarantee available here and it
 * is stated rather than dressed up.
 */
const CODEOWNERS_REFUSAL_WHY = {
  /** Two or more owners on one line. An `OwnershipRule` routes to exactly one. */
  MULTIPLE_OWNERS:
    'This line names more than one owner. A QAAI ownership rule routes a failure to exactly one person or team, and picking one of them would be a guess that looks like a routing decision — so the line was not imported rather than imported wrongly. Add a rule for the owner who should be paged.',
  /** A token that is not an `@handle`, an `@org/team` or an email address. */
  UNREADABLE_OWNER:
    'An owner on this line is not an @handle, an @org/team or an email address, so there is nothing to look up. The line was not imported rather than importing the half of it that parsed.',
  /** A shape QAAI can read and a team or user it has no record of. */
  UNKNOWN_OWNER:
    'The owner on this line names a team or a person this organisation has no record of. QAAI will not create a rule pointing at somebody it cannot resolve: a rule that routes nowhere looks like a working rule right up until the failure it was supposed to route goes nowhere.',
  /** The per-import or per-project rule ceiling bit before this line. */
  RULE_LIMIT:
    'The import stopped before this line because it had already created as many rules as one import may. Nothing from this line onwards was imported, so the directories it covers are still unowned.',
} as const;

const importCodeownersSchema = z
  .object({
    projectId: z.string().min(1),
    /**
     * THE FILE, AS TEXT. Bounded at the request boundary rather than inside the
     * parser: `MAX_CODEOWNERS_LINES` bounds the lines READ and discloses what
     * it did not read, which is the right answer for a long file and the wrong
     * one for a single three-megabyte line.
     */
    content: z.string().min(1).max(MAX_CODEOWNERS_CHARS),
  })
  .strict();

/**
 * Import a repository's CODEOWNERS file as ownership rules.
 *
 * ── WHY THIS ENDPOINT EXISTS ────────────────────────────────────────────────
 *
 * `parseCodeowners` has been in lib/ownership.ts for two rounds with no
 * production caller: 110 lines that read a file, refuse what they cannot
 * express, and report the line cap — reachable only from its own tests. The
 * header of that module says a repo with a CODEOWNERS file "has already written
 * these rules once, and they paste straight in", and there was no door to paste
 * them through.
 *
 * It is also the only writer of `OwnershipRule.source`, which is what finally
 * lets `provenanceOfMatch` answer CODEOWNERS_IMPORT — deliberately WEAKER than
 * RULE_PATH, so an imported catch-all glob shows as a SUGGESTION and does not
 * page anybody at 3am. Without this writer the column has no values and that
 * distinction can never be reported.
 *
 * ── A CODEOWNERS FILE IS DATA, NEVER INSTRUCTIONS ───────────────────────────
 *
 * Which is why:
 *
 *   · the body is LENGTH-BOUNDED before anything reads it, and the parser
 *     bounds the lines again and says what it skipped;
 *   · the rule count is bounded per import and per project, and a cap that BIT
 *     is reported as a count AND the reason that actually bit;
 *   · a refusal names a LINE NUMBER and never quotes the line. Every sentence
 *     in {@link CODEOWNERS_REFUSAL_WHY} is a constant this file owns;
 *   · an owner is resolved against QAAI's OWN RECORDS — a Team in this org, or
 *     a User with a Membership in it — and a token that resolves to neither
 *     refuses the line. Nothing in the file can name a principal into existence;
 *   · nothing in the file decides a path, a command, a branch or whether
 *     anything passes. It decides which of two rows this org already has gets
 *     written onto a rule.
 *
 * ── RE-IMPORT REPLACES THE IMPORT AND ONLY THE IMPORT ───────────────────────
 *
 * The rules this endpoint wrote before are deleted and written again, so running
 * it twice does not double the table and a line removed from the file stops
 * routing. THE SCOPE OF THAT DELETE IS `source = 'CODEOWNERS'`, WHICH IS A
 * RECORDED FACT ABOUT THE ROW AND NEVER AN INFERENCE FROM ITS CONTENTS — a rule
 * somebody typed by hand that happens to look exactly like a CODEOWNERS line is
 * NOT touched, and neither is a rule whose `source` is NULL. Null is "nobody
 * recorded where this came from", which is not the same fact as 'CODEOWNERS',
 * and deleting on it would be this product destroying human work on the
 * strength of a guess.
 *
 * ── AND THE IMPORT LOSES EVERY TIE ──────────────────────────────────────────
 *
 * Imported rules are written BELOW every rule that is kept — the lowest
 * positions in the project, possibly negative — because path precedence is
 * last-match-wins by `position` and an imported `*` appended at the top would
 * outrank every hand-typed rule in the project while being the weakest evidence
 * in it. Among themselves the file's own order is preserved, so CODEOWNERS'
 * last-match-wins still holds inside the import.
 */
teamRouter.post('/ownership/import-codeowners', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = importCodeownersSchema.parse(req.body);

  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const parsed = parseCodeowners(input.content);
  const refused: Array<{ line: number; reason: string }> = [...parsed.skipped];
  const caps: Array<{ what: string; count: number; reason: string }> = [];

  /*
   * THE LOOKUP SETS, built from the file and then resolved in TWO queries
   * rather than one per line. A 2,000-line file naming forty teams must not be
   * two thousand round trips, and the shape of the read is also the security
   * boundary: slugs and emails go IN, and only rows this org already has come
   * back out.
   */
  const wanted = new Map<number, CodeownersOwnerToken>();
  const slugs = new Set<string>();
  const emails = new Set<string>();

  for (const entry of parsed.entries) {
    if (entry.owners.length !== 1) {
      refused.push({
        line: entry.line,
        reason: `${CODEOWNERS_REFUSAL_WHY.MULTIPLE_OWNERS} It names ${entry.owners.length}.`,
      });
      continue;
    }
    const token = codeownersOwnerToken(entry.owners[0]!);
    if (!token) {
      refused.push({ line: entry.line, reason: CODEOWNERS_REFUSAL_WHY.UNREADABLE_OWNER });
      continue;
    }
    wanted.set(entry.line, token);
    if (token.kind === 'TEAM') slugs.add(token.slug);
    else emails.add(token.email);
  }

  const [teams, users] = await Promise.all([
    slugs.size
      ? prisma.team.findMany({
          where: { orgId: actor.orgId, slug: { in: [...slugs] } },
          select: { id: true, slug: true },
        })
      : Promise.resolve([]),
    emails.size
      ? prisma.user.findMany({
          where: { email: { in: [...emails] } },
          select: { id: true, email: true },
        })
      : Promise.resolve([]),
  ]);

  /*
   * A USER IS GLOBAL AND A MEMBERSHIP IS NOT, so the membership is the filter
   * that matters and it is a SECOND read rather than a relation hop on the
   * first. `prisma.user` is one of the GLOBAL_MODELS the tenancy extension does
   * not scope (lib/prisma.ts), so without this the file could point this org's
   * failures at an account in another one by naming its address.
   *
   * An address that is not a user and an address that is a user in a different
   * org are INDISTINGUISHABLE in the reply — both refuse the line with
   * UNKNOWN_OWNER — so this is not a way to ask whether a stranger has an
   * account here.
   */
  const memberships = users.length
    ? await prisma.membership.findMany({
        where: { orgId: actor.orgId, userId: { in: users.map((user) => user.id) } },
        select: { userId: true },
      })
    : [];
  const members = new Set(memberships.map((row) => row.userId));

  const teamBySlug = new Map(teams.map((team) => [team.slug, team.id]));
  const userByEmail = new Map(
    users.filter((user) => members.has(user.id)).map((user) => [user.email, user.id]),
  );

  /** One rule this import will write, in file order. */
  const drafts: Array<{
    line: number;
    pathPattern: string;
    ownerUserId: string | null;
    ownerTeamId: string | null;
  }> = [];

  for (const entry of parsed.entries) {
    const token = wanted.get(entry.line);
    if (!token) continue;

    const ownerTeamId = token.kind === 'TEAM' ? (teamBySlug.get(token.slug) ?? null) : null;
    const ownerUserId = token.kind === 'USER' ? (userByEmail.get(token.email) ?? null) : null;
    if (!ownerTeamId && !ownerUserId) {
      refused.push({ line: entry.line, reason: CODEOWNERS_REFUSAL_WHY.UNKNOWN_OWNER });
      continue;
    }
    drafts.push({ line: entry.line, pathPattern: entry.pathPattern, ownerTeamId, ownerUserId });
  }

  /*
   * THE RULES THAT SURVIVE THIS IMPORT, and the room left for it.
   *
   * `source: 'CODEOWNERS'` rows are replaced, so they do not count against the
   * project ceiling — otherwise a second import of the same file would refuse
   * itself. Everything else is kept and does count. `NOT: { source: … }` is
   * deliberately not used: it would be read by Postgres as a comparison against
   * NULL and silently exclude every pre-column row from the count, which would
   * let the ceiling be exceeded by exactly the rows nobody can check.
   */
  const existing = await prisma.ownershipRule.findMany({
    where: { projectId: project.id },
    select: { id: true, position: true, source: true },
  });
  const kept = existing.filter((rule) => rule.source !== CODEOWNERS_SOURCE);
  const replacing = existing.length - kept.length;

  const perProjectRoom = Math.max(0, MAX_OWNERSHIP_RULES_PER_PROJECT - kept.length);
  const room = Math.min(MAX_CODEOWNERS_RULES_PER_IMPORT, perProjectRoom);

  const admitted = drafts.slice(0, room);
  if (drafts.length > admitted.length) {
    /*
     * WHICH CAP BIT, not whichever is mentioned first. Reporting the per-import
     * ceiling for a project that is actually full would send somebody to split
     * the file into two imports, which cannot work.
     */
    const reason =
      perProjectRoom <= MAX_CODEOWNERS_RULES_PER_IMPORT
        ? `${CODEOWNERS_REFUSAL_WHY.RULE_LIMIT} This project already has ${kept.length} rules that were not imported, of a maximum of ${MAX_OWNERSHIP_RULES_PER_PROJECT}.`
        : `${CODEOWNERS_REFUSAL_WHY.RULE_LIMIT} One import may create ${MAX_CODEOWNERS_RULES_PER_IMPORT} rules.`;
    caps.push({ what: 'rules', count: drafts.length - admitted.length, reason });
    for (const draft of drafts.slice(admitted.length)) {
      refused.push({ line: draft.line, reason });
    }
  }

  /*
   * POSITIONS BELOW EVERYTHING KEPT. See the header: last-match-wins means the
   * HIGHEST position owns the file, so appending the import would make a pasted
   * catch-all outrank every rule somebody typed. `base + index` keeps the
   * file's own order inside the import, so `*` on line 1 still loses to
   * `tests/billing/**` on line 9.
   */
  const keptMin = kept.length > 0 ? Math.min(...kept.map((rule) => rule.position)) : null;
  const base = keptMin === null ? 0 : keptMin - admitted.length;

  /*
   * ONE TRANSACTION. A delete that landed without its inserts would leave a
   * project that had imported its CODEOWNERS file with NO imported rules and a
   * 500 — routing silently stopped for every directory the file covered, which
   * is `RULES_UNUSABLE` arriving by the one door that does not report it.
   */
  const created = await prisma.$transaction(async (tx) => {
    if (replacing > 0) {
      await tx.ownershipRule.deleteMany({
        where: { projectId: project.id, source: CODEOWNERS_SOURCE },
      });
    }
    const rows: Array<{ id: string; line: number }> = [];
    for (const [index, draft] of admitted.entries()) {
      const row = await tx.ownershipRule.create({
        data: {
          orgId: actor.orgId,
          projectId: project.id,
          pathPattern: draft.pathPattern,
          testId: null,
          suiteId: null,
          feature: null,
          ownerUserId: draft.ownerUserId,
          ownerTeamId: draft.ownerTeamId,
          position: base + index,
          source: CODEOWNERS_SOURCE,
          createdBy: actor.userId || null,
        },
        select: { id: true },
      });
      rows.push({ id: row.id, line: draft.line });
    }
    return rows;
  });

  await audit({
    actor,
    action: 'ownership.import_codeowners',
    targetType: 'Project',
    targetId: project.id,
    metadata: {
      /*
       * COUNTS AND LINE NUMBERS ONLY. Not the content, not a pattern, not a
       * token: an audit row is read by a human and exported, and the file this
       * came out of is a customer's.
       */
      imported: created.length,
      replaced: replacing,
      refusedLines: refused.length,
      cappedRules: caps.reduce((total, cap) => total + cap.count, 0),
      truncatedLines: parsed.truncated?.lines ?? 0,
    },
  });

  res.status(201).json({
    imported: created.length,
    /** The rules written, with the line each came from. No pattern echoed back. */
    rules: created,
    /** What this import DELETED, which is only ever its own previous rows. */
    replaced: replacing,
    /** Ascending by line, so a reader works down the file. Never quotes a line. */
    refused: refused.sort((a, b) => a.line - b.line),
    /** Every cap that BIT, with the reason that actually bit. Empty when none did. */
    caps,
    /** The parser's line ceiling, or null. Lines never read are not lines refused. */
    truncated: parsed.truncated,
    /**
     * WHAT THESE RULES ARE WORTH, said out loud at the moment they are created.
     *
     * An imported rule resolves to `CODEOWNERS_IMPORT`, which is WEAK, which
     * means `mayPage` is false for it: a failure it routes shows the owner as a
     * SUGGESTION and the digest will not claim that team is on the hook. A
     * customer who expected an import to start paging people has to be told
     * that here rather than discover it from a quiet digest.
     */
    provenance: 'CODEOWNERS_IMPORT' satisfies OwnerProvenance,
    pageable: false,
  });
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

/**
 * The project's rules in the shape the matcher wants.
 *
 * `OWNERSHIP_RULE_SELECT` rather than the field list that used to be written
 * out here. There were three hand-written copies of it in the repo and a copy
 * that forgets `position` does not fail — it resolves last-match-wins against a
 * column that is always 0, which routes every failure to the FIRST matching
 * rule instead of the last and silently inverts CODEOWNERS' own precedence.
 */
async function ownershipRulesFor(projectId: string): Promise<OwnershipRuleInput[]> {
  return prisma.ownershipRule.findMany({
    where: { projectId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    take: MAX_OWNERSHIP_RULES_PER_PROJECT,
    select: OWNERSHIP_RULE_SELECT,
  });
}

interface OwnerLabel {
  kind: 'USER' | 'TEAM';
  id: string;
  label: string;
}

/**
 * Names for the winning owners, in two queries rather than one per test.
 *
 * The LABEL itself comes from `ownerLabel`, which the digest, the chat alert and
 * every filed ticket also use. This function used to spell it out again — a
 * team that is `@payments` in the digest and `Payments` here reads as two
 * different owners to the person skimming both, and the deleted-row fallbacks
 * drifted apart too.
 */
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
  const directory: OwnerDirectory = {
    users,
    teams: new Map(teams.map((team) => [team.id, team])),
  };

  const byRule = new Map<string, OwnerLabel>();
  for (const match of winners) {
    byRule.set(match.ruleId, {
      kind: match.owner.kind,
      id: match.owner.kind === 'USER' ? match.owner.userId : match.owner.teamId,
      // Including the deleted-row fallbacks ("a deleted user" / "a deleted
      // team"), which should be unreachable — deleting either cascades its
      // rules away — and say something true rather than rendering as
      // `undefined` if they ever are reached.
      label: ownerLabel(match.owner, directory),
    });
  }
  return byRule;
}

// ─── GET /team/triage — the failures that are mine ───────────────────────────

/**
 * How many verdicts one page carries, and the ceiling a caller may ask for.
 *
 * Reported on the response beside `total`, never applied quietly: "show me the
 * failures that are mine" answered with a silently truncated list is the
 * question answered wrongly, because the number of items is the answer.
 */
const TRIAGE_PAGE = 50;
const TRIAGE_MAX_PAGE = 200;

/**
 * The sentinel for the state `ownerState` cannot otherwise be asked about.
 *
 * `TriageVerdict.ownerState` is a nullable TEXT column and its NULL is a FIFTH
 * state: nothing has tried to route this verdict yet. That is not NO_RULES (we
 * looked, nobody has written any) and not NO_MATCH (we looked, none matched) —
 * it is "we have not looked", and it is the state a verdict written before
 * routing existed, or written by a run whose routing read failed, is in.
 * Without a name for it the one query that would find those rows cannot be
 * expressed.
 */
const UNROUTED = 'UNROUTED';

/**
 * The columns a triage queue row needs, and no more.
 *
 * `ownerNote` is in here because it is the sentence that says WHICH KIND of
 * nobody owns an unowned failure, and a queue that shows the state without the
 * reason makes RULES_UNUSABLE — routing has silently stopped — look like
 * NO_MATCH.
 */
const TRIAGE_ROW_SELECT = {
  id: true,
  verdict: true,
  overriddenTo: true,
  confidence: true,
  reviewState: true,
  assigneeUserId: true,
  assigneeTeamId: true,
  ownerState: true,
  ownerNote: true,
  ownerRuleId: true,
  assignedAt: true,
  issueUrl: true,
  createdAt: true,
  testResult: {
    select: {
      id: true,
      status: true,
      runId: true,
      test: { select: { id: true, name: true, filePath: true } },
      run: { select: { id: true, projectId: true, branch: true, finishedAt: true } },
    },
  },
} as const;

/**
 * The failures assigned to one person or one team.
 *
 * THE READ THAT MAKES THE WRITE WORTH ANYTHING. The notify processor and the
 * filing endpoint both write `assigneeUserId` / `assigneeTeamId` / `ownerState`
 * onto a verdict the moment a run goes red, and until now nothing could ask the
 * obvious question back: which of these are mine? An assignment nobody can
 * query is a column, not a feature.
 *
 *   ?assigneeUserId=  ?assigneeTeamId=   whose queue. Opposite filters, so one.
 *   ?ownerState=                         OWNED / NO_RULES / NO_MATCH /
 *                                        RULES_UNUSABLE / UNROUTED (see above).
 *   ?projectId=                          one project's share of it.
 *
 * An unknown `ownerState` is a 400 and not an empty list, for the same reason
 * the surface report's filters are: "you have nothing assigned" and "you spelled
 * the filter wrongly" must not look identical, and the first is the reassuring
 * one.
 *
 * PERFORMANCE, stated rather than assumed: the filters this endpoint exists for
 * are `(orgId, assigneeUserId)` and `(orgId, assigneeTeamId)`, and neither pair
 * is indexed on `TriageVerdict` today. The query is correct without them and
 * the page is bounded, so it answers — on a large org it answers by scanning.
 * The two indexes are requested in this round's hand-off; nothing here depends
 * on them landing first.
 */
teamRouter.get('/triage', async (req, res) => {
  const assigneeUserId = queryString(req.query.assigneeUserId);
  const assigneeTeamId = queryString(req.query.assigneeTeamId);
  const ownerState = queryString(req.query.ownerState);
  const projectId = queryString(req.query.projectId);

  if (assigneeUserId && assigneeTeamId) {
    throw badRequest('Filter by assigneeUserId or assigneeTeamId, not both.');
  }

  // `readonly string[]`, so the membership test needs no cast — the same shape
  // `isFlakeConfirmationRun` and friends use for a vocabulary checked against
  // free text.
  const states: readonly string[] = [...OWNERSHIP_STATES, UNROUTED];
  if (ownerState && !states.includes(ownerState)) {
    throw badRequest(
      `ownerState must be one of ${states.join(', ')}. ${UNROUTED} means nothing has tried to route the verdict yet, which is not the same as nobody owning it.`,
    );
  }

  const limit = Math.min(
    TRIAGE_MAX_PAGE,
    Math.max(1, Number(req.query.limit ?? TRIAGE_PAGE) || TRIAGE_PAGE),
  );

  const where = {
    ...(assigneeUserId ? { assigneeUserId } : {}),
    ...(assigneeTeamId ? { assigneeTeamId } : {}),
    // The sentinel resolves to the column's NULL, which is the only way to ask
    // for the rows nothing has routed.
    ...(ownerState ? { ownerState: ownerState === UNROUTED ? null : ownerState } : {}),
    ...(projectId ? { testResult: { run: { projectId } } } : {}),
  };

  const [verdicts, total] = await Promise.all([
    prisma.triageVerdict.findMany({
      where,
      // Newest first, tie-broken by id: two verdicts minted in the same
      // millisecond by a parallel suite must not swap places between pages.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: TRIAGE_ROW_SELECT,
    }),
    // The count, separately, because the list is a page. Without it the caller
    // cannot tell a 50-row queue from a 4,000-row one.
    prisma.triageVerdict.count({ where }),
  ]);

  res.json({
    verdicts,
    returned: verdicts.length,
    limit,
    total,
    /** The flag a caller has to read before treating this page as the queue. */
    truncated: total > verdicts.length,
    /** Echoed so a caller can see which filter produced this, typos included. */
    filter: {
      assigneeUserId: assigneeUserId || null,
      assigneeTeamId: assigneeTeamId || null,
      ownerState: ownerState || null,
      projectId: projectId || null,
    },
  });
});

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
    /**
     * ── THE TWO A MUTE CANNOT BE STORED WITHOUT ──────────────────────────────
     *
     * Required only for `action: 'mute'`, enforced by the refinement below.
     * They are the same two `POST /triage/known-issues` and the single-verdict
     * door demand, and for the same reasons: a mute with no expiry is a
     * deletion nobody signed, and a mute with no stated reason is a silence the
     * next person cannot evaluate. NEITHER IS DEFAULTED — a silence that ends
     * on a date the caller did not choose is a cap applied without being
     * disclosed, and at MAX_BULK that is up to two hundred of them.
     *
     * `expiresAt` is NOT validated against the kind's ceiling here. That is
     * `applySuppression`'s job, measured against an injected `now`, and the
     * route calls it per cause — a zod refinement reading `new Date()` would
     * make one request validate at 09:00 and fail at 09:01 with nothing to say
     * why.
     */
    expiresAt: z.coerce.date().optional(),
    reason: z.string().trim().min(1).max(1_000).optional(),
    /**
     * Optional. QAAI composes one from its own cause hash when absent — never
     * from the test's name or the failure's error text, because a title
     * assembled from failure output is a title attacker-influenced text can
     * choose and it ends up on a tracker ticket.
     */
    title: z.string().trim().min(1).max(200).optional(),
  })
  .refine((input) => input.action !== 'override' || Boolean(input.overrideTo), {
    message: 'overrideTo is required when the action is override',
    path: ['overrideTo'],
  })
  .refine((input) => input.action !== 'mute' || input.expiresAt !== undefined, {
    message: 'expiresAt is required when the action is mute',
    path: ['expiresAt'],
  })
  .refine((input) => input.action !== 'mute' || Boolean(input.reason), {
    message: 'reason is required when the action is mute',
    path: ['reason'],
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
  /**
   * THE CAUSE, which a mute is keyed on. Nullable: a verdict written before
   * cause clustering has none, and such a verdict CANNOT be muted — a mute
   * keyed on the test instead of the cause would not un-mute itself when the
   * cause changed, which is a quarantine wearing a mute's name.
   */
  clusterKey: true,
  /**
   * WHICH mute is already behind this verdict, read so the reply can say
   * whether a `reviewState` means anything. `MUTED` with a null here is exactly
   * what this endpoint used to write, every time, for as long as it existed.
   */
  knownIssueId: true,
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
  const alreadyReviewed = verdicts.filter((v) => v.reviewState !== 'PENDING');

  /*
   * ── "ALREADY REVIEWED" IS NOT THE SAME FACT AS "HANDLED" ─────────────────
   *
   * The skip message said `Already reviewed (muted) — left as it was.` for a
   * verdict whose mute EXPIRED or was REVOKED, which reads as handled and is
   * the opposite: that failure is red again and nothing is silencing it.
   * `verdictSuppression` is the one predicate that knows the difference, so the
   * skip reason asks it rather than spelling the state out.
   *
   * ELIGIBILITY IS DELIBERATELY UNCHANGED. Letting an over-mute be re-reviewed
   * in bulk is coherent and is NOT done here, because `TriageBatchItem` has no
   * `previousKnownIssueId` — an undo could restore `previousReviewState: MUTED`
   * and would have nothing to restore the pointer from. That needs a column;
   * see the round's report.
   */
  const skippedIssues = await (async () => {
    const ids = [
      ...new Set(alreadyReviewed.map((v) => v.knownIssueId).filter((id): id is string => id !== null)),
    ];
    if (ids.length === 0) return new Map<string, KnownIssueRead>();
    // No `take`: the key set is bounded by the page the caller already asked
    // for, so a cap here would cap nothing and could hide a live mute.
    const rows = await prisma.knownIssue.findMany({
      where: { id: { in: ids } },
      select: knownIssueSelection,
    });
    return new Map(rows.map((row) => [row.id, row]));
  })();

  const skipped = alreadyReviewed.map((v) => {
    const suppression = verdictSuppression(
      v.reviewState,
      v.knownIssueId === null ? null : (skippedIssues.get(v.knownIssueId) ?? null),
      new Date(),
    );
    return {
      verdictId: v.id,
      test: v.testResult.test.name,
      reason: `Already reviewed (${v.reviewState.toLowerCase()}) — left as it was.${
        suppression.note === null ? '' : ` ${suppression.note}`
      }`,
      /** The ONLY field a surface may render as "handled". */
      suppression,
    };
  });

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
      select: { id: true, verdict: true, testResultId: true, clusterKey: true },
    });
    if (written.length === 0) return null;

    /*
     * ── THE DURABLE MUTE, WHICH THIS DOOR DID NOT WRITE ──────────────────────
     *
     * THE DEFECT, at two hundred times the scale of the one the single-verdict
     * door had: this route mapped `mute` to `VerdictReviewState.MUTED` and wrote
     * nothing else, so `reviewStateSuppresses(state, issue)` was asked about a
     * mute with no issue behind it and correctly suppressed NOTHING. A bulk mute
     * of up to MAX_BULK verdicts silenced none of them, and from the cockpit it
     * looked identical to the single-verdict door that works.
     *
     * ONE KNOWN ISSUE PER DISTINCT CAUSE, not one per verdict. A bulk mute is
     * one human judgement about a cause; minting two hundred rows for forty
     * verdicts of one cause would split `matchCount` across rows nobody can
     * add up. `updateMany` cannot set a per-row value, so the mute arm writes
     * once per cause group.
     *
     * EVERY CAUSE GOES THROUGH THE SAME TWO GUARDS the other two writers use —
     * `createKnownIssueSchema` for the wire shape and `applySuppression` for
     * whether the suppression may exist at all — so three doors cannot store
     * three different things. A refusal is reported per cause and is NOT fatal
     * to the batch: the review itself is a judgement the reviewer already made,
     * and rolling it back over one unmutable cause would discard it.
     */
    const issueByCause = new Map<string, KnownIssueRead>();
    /**
     * Causes whose cover already existed, so this mute EXTENDED a row rather
     * than minting one. Reported, because "we muted it" and "it was already
     * muted and now runs longer" are two different things to tell a reviewer.
     */
    const extendedCauses = new Set<string>();
    /**
     * Causes where more rows name the cause than the cover scan reads, so one
     * past the cap may already cover it and was not consulted. Disclosed rather
     * than inferred: an undisclosed cap is how two rows for one cause split a
     * match count nobody can audit.
     */
    const coverScanCapped = new Set<string>();
    const muteRefusals: Array<{ clusterKey: string | null; verdicts: number; paths: string[]; refusal: string | null; why: string }> = [];

    if (input.action === 'mute') {
      const byCause = new Map<string, string[]>();
      const noCause: string[] = [];
      for (const row of written) {
        if (!row.clusterKey) {
          noCause.push(row.id);
          continue;
        }
        byCause.set(row.clusterKey, [...(byCause.get(row.clusterKey) ?? []), row.id]);
      }
      if (noCause.length > 0) {
        muteRefusals.push({
          clusterKey: null,
          verdicts: noCause.length,
          paths: ['clusterKey'],
          refusal: null,
          why: 'These verdicts predate cause clustering, so there is no cause key to mute. A mute is keyed on the cause — never on the test — so that a change in the cause un-mutes it. They are reviewed as MUTED and suppress nothing.',
        });
      }

      for (const [clusterKey, ids] of byCause) {
        const candidate = createKnownIssueSchema.safeParse({
          projectId: projectOfVerdict.get(ids[0]!),
          title: input.title ?? `Muted cause ${clusterKey}`,
          reason: input.reason,
          signatures: [clusterKey],
          owner: { kind: 'USER', userId: actor.userId },
          ownerProvenance: 'EXPLICIT_ASSIGNMENT',
          expiresAt: input.expiresAt,
        });
        if (!candidate.success) {
          muteRefusals.push({
            clusterKey,
            verdicts: ids.length,
            // PATHS, never zod's messages: a zod message quotes the offending
            // value, and these values are a customer's own text.
            paths: refusedPaths(candidate.error.issues),
            refusal: null,
            why: 'That is not a mute this API can store: an expiry inside the ceiling and a stated reason are both required, and the cause key must be an exact 12-hex cluster key.',
          });
          continue;
        }

        const decision = applySuppression(
          {
            kind: 'MUTE',
            target: { scope: 'SIGNATURE', key: clusterKey },
            reason: candidate.data.reason,
            owner: candidate.data.owner,
            ownerProvenance: candidate.data.ownerProvenance,
            expiresAt: candidate.data.expiresAt,
            // A mute never changes the denominator: the failure stays counted
            // and stays measured, it just stops paging.
            expectedDenominator: 'STAYS_COUNTED',
          },
          stamp,
        );
        if (!decision.applied) {
          muteRefusals.push({
            clusterKey,
            verdicts: ids.length,
            paths: [decision.path],
            refusal: decision.refusal,
            why: SUPPRESSION_REFUSAL_PROSE[decision.refusal],
          });
          continue;
        }

        /*
         * ── CREATE OR EXTEND, THE SAME WAY THE SINGLE-VERDICT DOOR DOES ─────
         *
         * This used to `create` unconditionally, and a bulk mute of a cause
         * something already covers minted a SECOND KnownIssue. Both rows are
         * real and both look live, but `matchKnownIssue` returns the FIRST
         * in-force match and the worker reads mutes `createdAt: 'asc'` — so the
         * new row never matches anything, its `matchCount` stays 0 for ever
         * (the one fact the schema says decides renewal), and revoking the mute
         * the reviewer just created leaves the cause silenced by the older row.
         * A suppression its own author cannot revoke fails the only property
         * that makes a mute safe.
         *
         * `createdAt: 'asc'` is load-bearing for the same reason it is at
         * routes/agent.ts: the oldest cover wins, so a doubly-covered cause
         * attributes to one row stably instead of moving with iteration order.
         */
        const scanned = await tx.knownIssue.findMany({
          where: { projectId: candidate.data.projectId, signatures: { has: clusterKey } },
          orderBy: { createdAt: 'asc' },
          take: KNOWN_ISSUE_COVER_SCAN + 1,
          select: {
            id: true,
            signatures: true,
            expiresAt: true,
            revokedAt: true,
            matchCount: true,
          },
        });
        if (scanned.length > KNOWN_ISSUE_COVER_SCAN) coverScanCapped.add(clusterKey);
        const live = matchKnownIssue(
          scanned.slice(0, KNOWN_ISSUE_COVER_SCAN),
          clusterKey,
          stamp,
        );

        /*
         * EXTENDING NEVER SHORTENS. Re-muting a cause whose cover runs until
         * Friday with a request that ends on Wednesday would take two days off
         * a live suppression nobody asked to change.
         */
        const requested = decision.suppression.expiresAt;
        const expiresAt =
          live !== null && live.expiresAt.getTime() > requested.getTime()
            ? live.expiresAt
            : requested;
        if (live !== null) extendedCauses.add(clusterKey);

        const issue = live
          ? await tx.knownIssue.update({
              where: { id: live.id },
              data: { expiresAt },
              select: knownIssueSelection,
            })
          : await tx.knownIssue.create({
              data: {
                orgId: actor.orgId,
                projectId: candidate.data.projectId,
                title: candidate.data.title,
                reason: candidate.data.reason,
                signatures: candidate.data.signatures,
                // Exactly one of the two, which the migration's
                // `KnownIssue_one_owner` CHECK enforces for every other writer.
                ownerUserId: actor.userId,
                ownerTeamId: null,
                ownerProvenance: candidate.data.ownerProvenance,
                expiresAt,
                createdBy: actor.userId,
              },
              select: knownIssueSelection,
            });
        issueByCause.set(clusterKey, issue);

        /*
         * The per-row write `updateMany` could not do. Guarded on `reviewedAt:
         * stamp` rather than on the ids alone, which is the same join the batch
         * uses: a verdict a colleague re-reviewed a millisecond after our
         * update must not be pointed at our mute.
         */
        await tx.triageVerdict.updateMany({
          where: { id: { in: ids }, reviewedAt: stamp },
          data: { knownIssueId: issue.id },
        });
      }
    }

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

    return { batch, written, issueByCause, muteRefusals, extendedCauses, coverScanCapped };
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
          /*
           * WHICH mute silenced this one, or null. A mute audit row that cannot
           * name the issue behind it cannot answer "what stopped paging and on
           * whose authority", which is the only question an audit of a mute is
           * read for. Null is the honest value for a verdict whose cause could
           * not be muted — see `muteRefusals`.
           */
          ...(input.action === 'mute'
            ? {
                knownIssueId:
                  (row.clusterKey === null
                    ? null
                    : (applied.issueByCause.get(row.clusterKey)?.id ?? null)),
              }
            : {}),
          ...(fromCluster ? { clusterId: input.clusterId } : {}),
          ...(input.note ? { note: input.note } : {}),
        },
      }),
    ),
  );

  const now = new Date();
  const silenced = applied.written.filter(
    (row) => row.clusterKey !== null && applied.issueByCause.has(row.clusterKey),
  ).length;

  res.json({
    batch: { id: applied.batch.id, action: input.action, overriddenTo, createdAt: applied.batch.createdAt },
    applied: applied.written.length,
    skipped,
    /*
     * ── WHAT THE MUTE ACTUALLY DID, AS A COUNT AND A REASON ──────────────────
     *
     * Present only for a mute, and never a bare boolean. `reviewed` is how many
     * verdicts changed state; `silenced` is how many of those a live known
     * issue is now behind — and the two differ exactly when a cause was refused
     * or had no cause key, which `refusals` names with a PATH and QAAI's own
     * sentence. A failure suppressed without being counted is one of the lies
     * this product cannot afford, and so is a review reported as a suppression
     * when it silenced nothing.
     */
    ...(input.action === 'mute'
      ? {
          mute: {
            reviewed: applied.written.length,
            silenced,
            knownIssues: [...applied.issueByCause.entries()].map(([clusterKey, issue]) => ({
              clusterKey,
              verdicts: applied.written.filter((row) => row.clusterKey === clusterKey).length,
              knownIssue: knownIssueView(issue, now),
              /** True when this extended a cover that already existed rather than minting one. */
              extendedExistingIssue: applied.extendedCauses.has(clusterKey),
              /** The cover scan's cap bit, so a row past it may also cover this cause. */
              coverScanCapped: applied.coverScanCapped.has(clusterKey),
            })),
            refusals: applied.muteRefusals,
            note:
              silenced === applied.written.length
                ? `Every one of these ${silenced} failure(s) is now behind a durable mute: no verdict and no strong-model heal will be bought for its cause, every failure it silences is counted on the known issue, and it stops suppressing the moment it expires.`
                : `${silenced} of ${applied.written.length} reviewed failure(s) are behind a durable mute. The rest are marked MUTED and SUPPRESS NOTHING — they still count and still page. See refusals.`,
          },
        }
      : {}),
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
