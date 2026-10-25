/**
 * Triage feedback loops (§3.3) — the half of triage that was write-only.
 *
 * Triage produced verdicts and nothing read what humans did to them. Six
 * register defects, one shape: every loop that would have made the verdict
 * better was missing a door.
 *
 *  · `TriageVerdict.overriddenTo` carries a comment saying the override "is
 *    what gates and what trains prompts". No prompt read it. It is read now
 *    (apps/worker/src/processors/triage.ts → `summariseCorrections`), and
 *    `GET /triage/accuracy` is how a human sees the same thing: how often they
 *    overrule each kind of verdict.
 *  · `VerdictReviewState.MUTED` was set by two endpoints and read by nothing,
 *    so the next run of a known issue minted a fresh verdict and paged somebody
 *    again. `POST /triage/signatures/:clusterKey/mute` makes the mute durable,
 *    keyed on the CAUSE rather than on a test, and bounded — see MUTE_MAX_DAYS.
 *  · The cockpit told people to "re-run triage to get a fresh proposal"
 *    (packages/agent/src/heal-apply.ts) and no mechanism existed.
 *    `POST /triage/verdicts/:verdictId/retriage` is it, and it SUPERSEDES:
 *    the old verdict's contents, including the human's correction, are copied
 *    into `TriageVerdictRevision` before the new answer lands on top.
 *  · `signatureOf()` produced a stable cause key that was stored nowhere, so
 *    "is this the same cause as yesterday" could not be asked.
 *    `GET /triage/signatures` answers it, and `newInThisBuild` is an equality
 *    against `FailureSignature.firstSeenRunId` rather than a window search.
 *
 * ─── Why a re-triage is a REQUEST and not a synchronous call ────────────────
 *
 * The verdict comes from a model call that can take tens of seconds and
 * escalate to a second, stronger call. That belongs in the worker, which is
 * where every other agent runs and where a slow call cannot hold an HTTP
 * connection open. So this endpoint stamps `retriageRequestedAt` — a COLUMN,
 * because a flag living only in a queue payload is lost when the worker is
 * cycled — and enqueues the existing triage job. The worker honours the request
 * once and clears it.
 *
 * The job id carries the revision (`triage-<result>-r2`). `enqueueTriage` in
 * the worker uses a bare `triage-<testResultId>`, deliberately, so a redelivered
 * run job cannot double-triage; reusing that id here would mean the second
 * re-triage of a result is silently swallowed by BullMQ's completed set, which
 * is the original defect wearing a different hat.
 */

import { Router } from 'express';
import { QUEUE_NAMES, VERDICTS } from '@qaai/shared';
import type { Verdict } from '@qaai/shared';
import {
  MUTE_MAX_DAYS,
  muteExpiryFrom,
  muteInForce,
  triageAccuracy,
  CORRECTION_HISTORY_DAYS,
} from '@qaai/agent';
import type { VerdictCorrectionTally, VerdictStateTally } from '@qaai/agent';
import { prisma } from '../lib/prisma.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { audit } from '../lib/audit.js';
import { actorOf, requireAuth, requireRole, requireScope } from '../middleware/auth.js';

export const triageRouter: Router = Router();

triageRouter.use(requireAuth);

/**
 * How many members of one cause a single re-triage may cover.
 *
 * The same ceiling as the bulk-review endpoint's MAX_BULK (routes/team.ts), for
 * the same reason: past a couple of hundred, a decision stops being a decision
 * and becomes a migration. Unlike bulk review, each member here costs a model
 * call, so the cap is also a spending limit.
 */
export const MAX_RETRIAGE_FANOUT = 200;

/**
 * How far back the accuracy scorecard counts, and the ceiling a caller may ask
 * for. 30 days matches CORRECTION_HISTORY_DAYS — the scorecard and the prompt's
 * prior must describe the same window, or a reader checking one against the
 * other is comparing two different projects. 365 as the ceiling because a
 * year-over-year read is a legitimate question and an unbounded one is a table
 * scan somebody can ask for over HTTP.
 */
export const ACCURACY_MAX_DAYS = 365;

/**
 * How many runs and how many verdicts the cause-detail endpoint returns.
 *
 * A cause that took out 200 tests has 200 verdicts, so this cap bites on
 * exactly the causes worth reading about — which is why the response states it.
 * Both lists are read with `take: limit + 1` and sliced back, so `more` is an
 * observed fact rather than the "returned === limit" guess the cause LIST has to
 * make: a cause with exactly 50 runs and a cause with 51 are different answers
 * and this endpoint can tell them apart for the price of one extra row.
 */
export const CAUSE_PAGE_LIMIT = 50;

const DAY_MS = 86_400_000;

function param(value: unknown): string {
  return String(value ?? '');
}

/** The project, verified against the caller's tenant scope. */
async function requireProject(projectId: string): Promise<{ id: string }> {
  if (!projectId) throw badRequest('projectId is required');
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  // The tenancy extension makes another org's project read as absent, which is
  // exactly the behaviour notFound() gives — never an existence oracle.
  if (!project) throw notFound('Project');
  return project;
}

// ─── The cause list ──────────────────────────────────────────────────────────

/**
 * The shape of a cause, as every endpoint in this file reports it.
 *
 * `muted` is computed through `muteInForce` rather than read off `mutedUntil`
 * directly, so an expired mute can never read as a live one at one endpoint and
 * as expired at another. The expiry is still returned when it has passed —
 * "muted until last Tuesday" is the thing somebody has to decide about, and
 * hiding it would make a lapsed mute invisible.
 */
function causeView(
  row: {
    clusterKey: string;
    signature: string;
    label: string;
    firstSeenAt: Date;
    firstSeenRunId: string;
    lastSeenAt: Date;
    lastSeenRunId: string;
    runCount: number;
    occurrenceCount: number;
    mutedUntil: Date | null;
    mutedAt: Date | null;
    mutedBy: string | null;
    mutedReason: string | null;
    suppressedCount: number;
  },
  now: Date,
  runId?: string,
): Record<string, unknown> {
  const muted = muteInForce(row, now);
  return {
    clusterKey: row.clusterKey,
    signature: row.signature,
    label: row.label,
    firstSeenAt: row.firstSeenAt,
    firstSeenRunId: row.firstSeenRunId,
    lastSeenAt: row.lastSeenAt,
    lastSeenRunId: row.lastSeenRunId,
    runsSeen: row.runCount,
    occurrences: row.occurrenceCount,
    /*
     * Only answerable against a run, and null — not false — when no run was
     * named. "Not new" and "nobody asked about a build" are different facts and
     * a default of false would quietly assert the first.
     */
    newInThisBuild: runId ? row.firstSeenRunId === runId : null,
    mute: row.mutedUntil
      ? {
          inForce: muted,
          until: row.mutedUntil,
          at: row.mutedAt,
          by: row.mutedBy,
          reason: row.mutedReason,
          /** Failures swallowed while the mute was live — see the schema. */
          suppressed: row.suppressedCount,
        }
      : null,
  };
}

const causeSelection = {
  clusterKey: true,
  signature: true,
  label: true,
  firstSeenAt: true,
  firstSeenRunId: true,
  lastSeenAt: true,
  lastSeenRunId: true,
  runCount: true,
  occurrenceCount: true,
  mutedUntil: true,
  mutedAt: true,
  mutedBy: true,
  mutedReason: true,
  suppressedCount: true,
} as const;

/**
 * Every cause this project has an identity for, most recently seen first.
 *
 * `?runId=` turns on `newInThisBuild`, and `?muted=true` narrows to live mutes —
 * the mute roster, which is the screen that makes a suppression visible instead
 * of being a silence nobody inherits.
 *
 * `?newInRun=<runId>` narrows to the causes this project had never produced
 * before that run — "what did this build break that nothing had broken
 * before", which is the question `FailureSignature.firstSeenRunId` exists to
 * answer by equality. It is the sole consumer of
 * `@@index([orgId, projectId, firstSeenRunId])`, so the filter and the index
 * live or die together.
 *
 * It is a FILTER and `?runId=` is a FLAG, and they are deliberately separate:
 * asking for `newInRun=R` alone returns those causes with `newInThisBuild:
 * null`, because nothing asked about a build. Pass the same id as both to get
 * the rows and the flag; defaulting one from the other would mean a caller
 * paging the whole cause list could never ask "which of these is new in R"
 * without also throwing away every cause that is not.
 */
triageRouter.get('/signatures', async (req, res) => {
  const now = new Date();
  const projectId = param(req.query.projectId);
  await requireProject(projectId);

  const runId = req.query.runId ? param(req.query.runId) : undefined;
  const mutedOnly = param(req.query.muted) === 'true';
  const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);

  const rows = await prisma.failureSignature.findMany({
    where: {
      projectId,
      ...(mutedOnly ? { mutedUntil: { gt: now } } : {}),
      ...(param(req.query.newInRun) ? { firstSeenRunId: param(req.query.newInRun) } : {}),
    },
    orderBy: { lastSeenAt: 'desc' },
    take: limit,
    select: causeSelection,
  });

  res.json({
    causes: rows.map((row) => causeView(row, now, runId)),
    /*
     * Returned so a reader is never surprised by a truncated list. `limit` and
     * `returned` being equal means there may be more, which is a different
     * statement from "that is all of them".
     */
    returned: rows.length,
    limit,
  });
});

/**
 * One cause: its identity, the runs it appeared in, and the verdicts reached
 * about it.
 *
 * "The runs it appeared in" is `RunFailureCluster` filtered by clusterKey —
 * which exists anyway because it is the claim that makes one model call per
 * cause possible. No separate join table, and no scan of TestResult.
 */
triageRouter.get('/signatures/:clusterKey', async (req, res) => {
  const now = new Date();
  const projectId = param(req.query.projectId);
  await requireProject(projectId);
  const clusterKey = param(req.params.clusterKey);

  const row = await prisma.failureSignature.findUnique({
    where: { orgId_projectId_clusterKey: { orgId: actorOf(req).orgId, projectId, clusterKey } },
    select: causeSelection,
  });
  if (!row) throw notFound('Failure cause');

  const occurrenceRows = await prisma.runFailureCluster.findMany({
    where: { clusterKey, projectId },
    orderBy: { createdAt: 'desc' },
    take: CAUSE_PAGE_LIMIT + 1,
    select: {
      runId: true,
      members: true,
      modelCalls: true,
      attachments: true,
      suppressed: true,
      firstSeenInProject: true,
      createdAt: true,
      /*
       * ── The three columns that had no reader ──────────────────────────────
       *
       * Written by the worker on every cause and selected by no query anywhere,
       * which in this repo is the signature defect: a column that is correct,
       * queryable and dead. check-wiring.ts is model-level, so it cannot see
       * them. They are reported here because each one answers a question the
       * numbers above raise and cannot settle:
       *
       *  · `ownerResultId` — which failing result's triage job won the claim
       *    and made the call. When it names a result other than the one holding
       *    `verdictId`, the first owner never answered and a later member was
       *    elected in its place; that divergence is the only record of it.
       *  · `verdictId` — the cause's answer for this run. NULL means no member
       *    has published one yet (or none ever did, for a suppressed cause),
       *    which is a different state from "the cause had no verdict".
       *  · `resolvedAt` — when that answer landed. NULL for as long as
       *    `verdictId` is.
       */
      ownerResultId: true,
      verdictId: true,
      resolvedAt: true,
      /*
       * And the cause's description AS RECORDED when this run claimed it. The
       * identity row above carries the label it was minted with; these carry
       * the label this run computed, so a normaliser rule that changed between
       * the two shows up as drift instead of silently restating today's wording
       * as though it were last month's.
       */
      label: true,
      signature: true,
    },
  });

  const verdictRows = await prisma.triageVerdict.findMany({
    /*
     * SCOPED TO THE PROJECT, like the occurrence read above it.
     *
     * `clusterKey` is sha1(signature) and `FailureSignature` is unique on
     * (orgId, projectId, clusterKey), so one org holding two projects that hit
     * the same failure holds the same clusterKey twice. Keyed on the cluster
     * alone, this list answered with BOTH projects' verdicts under the identity
     * of the one that was asked about — and `limits.verdicts.returned` counted
     * them, so the disclosure described a set the caller never named. The
     * relation hop is the same one the accuracy endpoint scopes with; the
     * (orgId, clusterKey) index still serves the equality.
     */
    where: { clusterKey, testResult: { run: { projectId } } },
    orderBy: { createdAt: 'desc' },
    take: CAUSE_PAGE_LIMIT + 1,
    select: {
      id: true,
      verdict: true,
      confidence: true,
      reviewState: true,
      overriddenTo: true,
      model: true,
      derivedFromId: true,
      revision: true,
      createdAt: true,
      testResult: { select: { id: true, runId: true, test: { select: { name: true } } } },
    },
  });

  const occurrences = occurrenceRows.slice(0, CAUSE_PAGE_LIMIT);
  const verdicts = verdictRows.slice(0, CAUSE_PAGE_LIMIT);

  res.json({
    cause: causeView(row, now, param(req.query.runId) || undefined),
    runs: occurrences.map((o) => ({
      ...o,
      /**
       * True when this run recorded a different wording for the same cause than
       * the identity row holds — the clusterer's label rules moved, not the
       * failure.
       */
      labelDrift: o.label !== row.label,
      /**
       * And the same question about the signature itself, which is the evidence
       * the grouping was made from. Separate from `labelDrift` because the
       * label is derived from the signature: one can move without the other,
       * and reporting them under one name would hide whichever moved second.
       */
      signatureDrift: o.signature !== row.signature,
    })),
    verdicts: verdicts.map((v) => ({
      ...v,
      /** True when this row is a copy of the cause's one model call. */
      derived: v.derivedFromId !== null,
    })),
    /*
     * BOTH LISTS ARE CAPPED AND BOTH SAY SO. The sibling endpoint's own rule —
     * a reader must never be surprised by a truncated list — applied just as
     * much here, and this is the endpoint where truncation is likeliest: a
     * 200-member outage has 200 verdicts. `more` is observed (one row past the
     * cap is read and dropped), so it is a fact and not an inference from
     * `returned === limit`.
     */
    limits: {
      runs: {
        returned: occurrences.length,
        limit: CAUSE_PAGE_LIMIT,
        more: occurrenceRows.length > CAUSE_PAGE_LIMIT,
      },
      verdicts: {
        returned: verdicts.length,
        limit: CAUSE_PAGE_LIMIT,
        more: verdictRows.length > CAUSE_PAGE_LIMIT,
      },
    },
  });
});

// ─── Mute ────────────────────────────────────────────────────────────────────

/**
 * Mute a cause: stop minting verdicts for it, keep counting it.
 *
 * MEMBER, and audited, because this is the switch that makes a failure stop
 * paging. Three properties the endpoint enforces rather than hopes for:
 *
 *  1. A REASON IS REQUIRED. An unexplained silence is the thing somebody
 *     inherits in six weeks with no way to tell whether it still applies.
 *  2. AN EXPIRY IS STAMPED, clamped to MUTE_MAX_DAYS. Muting forever is the
 *     quarantine mistake and `muteExpiryFrom` is where that clamp lives, shared
 *     with nothing else because nothing else is allowed to mint one.
 *  3. RE-MUTING A LIVE MUTE IS ALLOWED, and extends it. Refusing would hide the
 *     state instead of changing it — the same decision
 *     routes/projects.ts's quarantine door reached for the same reason.
 */
triageRouter.post(
  '/signatures/:clusterKey/mute',
  requireRole('MEMBER'),
  requireScope('runs:write'),
  async (req, res) => {
    const actor = actorOf(req);
    const now = new Date();
    const projectId = param(req.body?.projectId);
    await requireProject(projectId);
    const clusterKey = param(req.params.clusterKey);

    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) {
      throw badRequest(
        'reason is required: a mute with no stated reason is a silence the next person cannot evaluate',
      );
    }
    if (reason.length > 500) throw badRequest('reason must be 500 characters or fewer');

    const asked = req.body?.days === undefined ? MUTE_MAX_DAYS : Number(req.body.days);
    const until = muteExpiryFrom(now, asked);
    if (!until) throw badRequest('days must be a positive number');

    const key = { orgId: actor.orgId, projectId, clusterKey };
    const existing = await prisma.failureSignature.findUnique({
      where: { orgId_projectId_clusterKey: key },
      select: { id: true, label: true, mutedUntil: true },
    });
    /*
     * A cause with no identity row has never been observed, so there is nothing
     * to mute. Minting one here would create a cause out of an HTTP request and
     * put a first-seen date on a failure nobody has ever had.
     */
    if (!existing) throw notFound('Failure cause');

    /*
     * Read BEFORE the write, not after. "Was a mute already running?" is a fact
     * about the state this request replaced, and computing it from a row the
     * update has already touched makes the audit describe the outcome instead
     * of the decision — which is the one thing an audit row must not do.
     */
    const extendedExistingMute = muteInForce(existing, now);

    const updated = await prisma.failureSignature.update({
      where: { orgId_projectId_clusterKey: key },
      data: { mutedUntil: until, mutedAt: now, mutedBy: actor.userId, mutedReason: reason },
      select: causeSelection,
    });

    await audit({
      actor,
      action: 'triage.cause.mute',
      targetType: 'FailureSignature',
      targetId: existing.id,
      metadata: {
        projectId,
        clusterKey,
        label: existing.label,
        reason,
        daysAsked: asked,
        daysGranted: Math.min(asked, MUTE_MAX_DAYS),
        until: until.toISOString(),
        extendedExistingMute,
      },
    });

    res.json({
      cause: causeView(updated, now),
      /*
       * Said out loud when the request was trimmed. A caller who asked for 90
       * days and silently got 14 would believe the suppression outlasts the
       * sprint it was meant for.
       */
      note:
        asked > MUTE_MAX_DAYS
          ? `Clamped to ${MUTE_MAX_DAYS} days: a mute re-states a decision, and a decision nobody re-makes is a deletion.`
          : null,
    });
  },
);

triageRouter.post(
  '/signatures/:clusterKey/unmute',
  requireRole('MEMBER'),
  requireScope('runs:write'),
  async (req, res) => {
    const actor = actorOf(req);
    const now = new Date();
    const projectId = param(req.body?.projectId);
    await requireProject(projectId);
    const clusterKey = param(req.params.clusterKey);

    const key = { orgId: actor.orgId, projectId, clusterKey };
    const existing = await prisma.failureSignature.findUnique({
      where: { orgId_projectId_clusterKey: key },
      select: { id: true, mutedUntil: true, suppressedCount: true },
    });
    if (!existing) throw notFound('Failure cause');

    // Read before the write, for the same reason as the mute door above.
    const wasInForce = muteInForce(existing, now);
    const suppressedWhileMuted = existing.suppressedCount;

    /*
     * The expiry AND the reason both go. A stale reason on an un-muted cause is
     * a row that contradicts itself, and the next reader would take it as a
     * live justification. `suppressedCount` stays: it is the record of what the
     * mute actually cost, and clearing it would erase the evidence that decides
     * whether muting this was a good idea.
     */
    const updated = await prisma.failureSignature.update({
      where: { orgId_projectId_clusterKey: key },
      data: { mutedUntil: null, mutedAt: null, mutedBy: null, mutedReason: null },
      select: causeSelection,
    });

    await audit({
      actor,
      action: 'triage.cause.unmute',
      targetType: 'FailureSignature',
      targetId: existing.id,
      metadata: {
        projectId,
        clusterKey,
        wasInForce,
        suppressedWhileMuted,
      },
    });

    res.json({ cause: causeView(updated, now) });
  },
);

// ─── Re-triage ───────────────────────────────────────────────────────────────

const verdictForRetriage = {
  id: true,
  revision: true,
  verdict: true,
  reviewState: true,
  clusterKey: true,
  runId: true,
  retriageRequestedAt: true,
  testResult: {
    select: {
      id: true,
      runId: true,
      run: { select: { projectId: true } },
      test: { select: { name: true } },
    },
  },
} as const;

/**
 * Ask for a fresh verdict.
 *
 * `scope` is the cluster-disagreement control, and the two values mean opposite
 * things on purpose:
 *
 *  · `member` (default) re-triages this result alone. With `split: true` it
 *    also stamps `splitFromClusterKey`, which tells the worker to withhold the
 *    cluster context — the reviewer has said the cluster's answer is wrong for
 *    THIS test, so the cluster size is exactly the evidence that misled the
 *    previous call. A split result is never re-attached to the cause, because
 *    attachment only ever writes a verdict where there is none.
 *  · `cluster` re-triages every member of the cause in this run, and COSTS ONE
 *    MODEL CALL PER MEMBER. The collapse the worker applies to a fresh run does
 *    NOT apply here: `processTriage` gates its attach path on `!retriage`,
 *    deliberately, because handing back a copy of the answer the reviewer just
 *    rejected is the "re-run triage" button doing nothing. So a cause-wide
 *    re-triage of a 200-member cause buys 200 calls, which is why
 *    MAX_RETRIAGE_FANOUT is a spending limit and not only a sanity bound. A
 *    cause bigger than the cap is covered a cap at a time, and the 202 says how
 *    many members it left alone (`notRequested`) rather than reporting the cap
 *    as if it were the whole cause.
 *
 * Both paths supersede rather than replace: the worker copies the current
 * contents, INCLUDING the human's `reviewState` and `overriddenTo`, into
 * `TriageVerdictRevision` before overwriting. That history is what the prompt
 * reads back as a prior, so a re-triage that destroyed it would make the model
 * worse every time somebody asked it to do better.
 */
triageRouter.post(
  '/verdicts/:verdictId/retriage',
  requireRole('MEMBER'),
  requireScope('runs:write'),
  async (req, res) => {
    const actor = actorOf(req);
    const now = new Date();

    const verdict = await prisma.triageVerdict.findUnique({
      where: { id: param(req.params.verdictId) },
      select: verdictForRetriage,
    });
    if (!verdict) throw notFound('Verdict');

    /*
     * REFUSED, not truncated. This used to `.slice(0, 500)`, which silently
     * shortened the one sentence explaining why a human overruled the model —
     * into the audit row, into `TriageVerdictRevision.reason`, and into the
     * prior the next prompt reads back. The mute door one screen up already
     * refuses an over-long reason; a caller whose reason is too long gets told
     * so and keeps their words, which is the same cap stated out loud.
     */
    const reason = String(req.body?.reason ?? '').trim() || null;
    if (reason && reason.length > 500) throw badRequest('reason must be 500 characters or fewer');
    const split = req.body?.split === true;
    const scope = param(req.body?.scope) || 'member';
    if (scope !== 'member' && scope !== 'cluster') {
      throw badRequest('scope must be "member" or "cluster"');
    }
    if (split && scope === 'cluster') {
      throw badRequest(
        'A split takes one member out of its cause; re-triaging the whole cause is the opposite request',
      );
    }
    if (verdict.retriageRequestedAt) {
      throw conflict(
        'A re-triage is already pending for this verdict. It is honoured the next time the worker picks it up.',
      );
    }

    const runId = verdict.testResult.runId;
    const projectId = verdict.testResult.run.projectId;

    /*
     * `cluster` scope reaches the siblings through (runId, clusterKey) — the
     * index that exists for the worker's own attach read. A verdict with no
     * clusterKey predates this feature, so it has no siblings to find and the
     * request degrades to `member` with that said out loud rather than silently
     * covering one row while the caller believes it covered forty.
     */
    const causeWide = scope === 'cluster' && verdict.clusterKey !== null;
    const siblingWhere = {
      runId,
      clusterKey: verdict.clusterKey,
      retriageRequestedAt: null,
      // A member somebody deliberately split out is not part of the cause any
      // more, so a cause-wide re-triage must not drag it back.
      splitFromClusterKey: null,
    } as const;

    const siblings = causeWide
      ? await prisma.triageVerdict.findMany({
          where: siblingWhere,
          take: MAX_RETRIAGE_FANOUT,
          select: verdictForRetriage,
        })
      : [verdict];

    const includesSelf = siblings.some((s) => s.id === verdict.id);
    const targets = includesSelf ? siblings : [verdict, ...siblings].slice(0, MAX_RETRIAGE_FANOUT);

    /*
     * ── HOW MANY MEMBERS THERE ACTUALLY ARE ────────────────────────────────
     *
     * `take: MAX_RETRIAGE_FANOUT` on its own truncated in silence: ask for a
     * 500-member cause and 200 were stamped, 300 kept their stale verdicts, and
     * the 202 reported 200 as though that had been the whole cause. A cap
     * nobody is told about is the same defect as a number nobody measured.
     *
     * One extra COUNT, which is cheap on the (runId, clusterKey) index the
     * read above already uses, and exact — a `take: n + 1` probe would say
     * "more exist" without saying how many, and "300 tests still hold the
     * verdict you rejected" is the number somebody has to act on.
     *
     * The caller's own verdict is added when the filter excluded it (it was
     * split out of this cause earlier, and asking for a cause-wide re-triage
     * FROM it still re-triages it), so this count and `targets` are counting
     * the same set.
     */
    const eligible = causeWide
      ? (await prisma.triageVerdict.count({ where: siblingWhere })) + (includesSelf ? 0 : 1)
      : 1;
    const notRequested = Math.max(eligible - targets.length, 0);

    await prisma.triageVerdict.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: {
        retriageRequestedAt: now,
        retriageRequestedBy: actor.userId,
        retriageReason: reason,
        ...(split ? { splitFromClusterKey: verdict.clusterKey } : {}),
      },
    });

    /*
     * One job per target, with the revision in the job id. `enqueueTriage` in
     * the worker uses a bare `triage-<testResultId>` so a redelivered run job
     * cannot double-triage; reusing that id here would let BullMQ's completed
     * set swallow every re-triage after the first, which is the defect this
     * endpoint exists to fix.
     */
    const enqueued: string[] = [];
    for (const target of targets) {
      enqueued.push(
        await enqueue(
          QUEUE_NAMES.triage,
          { orgId: actor.orgId, runId: target.testResult.runId, testResultId: target.testResult.id },
          { jobId: `triage-${target.testResult.id}-r${target.revision + 1}`, attempts: 2 },
        ),
      );
    }

    await audit({
      actor,
      action: 'triage.retriage',
      targetType: 'TriageVerdict',
      targetId: verdict.id,
      metadata: {
        projectId,
        runId,
        scope,
        split,
        reason,
        clusterKey: verdict.clusterKey,
        covered: targets.length,
        /*
         * What the request could NOT cover, on the record beside what it did.
         * An audit row saying "covered 200" of a 500-member cause describes a
         * decision nobody made.
         */
        eligible,
        notRequested,
        /** The reviewState being superseded — the thing the revision row keeps. */
        supersedingReviewState: verdict.reviewState,
      },
    });

    res.status(202).json({
      requested: targets.length,
      scope,
      split,
      jobs: enqueued,
      /** Members of this cause a cause-wide re-triage covers, cap aside. */
      eligible,
      /** Of those, how many this request left with the verdict they have. */
      notRequested,
      cap: MAX_RETRIAGE_FANOUT,
      truncatedNote:
        notRequested > 0
          ? `This cause has ${eligible} members awaiting a re-triage and ${MAX_RETRIAGE_FANOUT} is the per-request cap, so ${notRequested} of them keep the verdict they have. Send the same request again to take the next ${MAX_RETRIAGE_FANOUT}: the members already requested are skipped.`
          : null,
      /*
       * WHAT THIS WILL SPEND, said before it is spent. The whole thesis of
       * per-cause triage is that one outage costs one model call — and this is
       * the door that opts out of it, deliberately (`processTriage` never
       * attaches a copy to a re-triage, because handing back the answer the
       * reviewer just rejected is the button doing nothing). A caller asking
       * for 200 should be told it is 200 calls and not one.
       *
       * AT MOST, not exactly: a target whose result row has gone, or whose
       * request a second caller consumed first, spends nothing.
       */
      cost: {
        modelCallsAtMost: targets.length,
        note:
          targets.length > 1
            ? `A cause-wide re-triage does not share one answer: each of the ${targets.length} members buys its own model call.`
            : 'One fresh model call for this result.',
      },
      degradedToMember:
        scope === 'cluster' && !verdict.clusterKey
          ? 'This verdict predates cause clustering, so it has no siblings to re-triage. Only this result was requested.'
          : null,
      note: 'The current verdict is kept in its revision history, including any override, before the new one lands.',
    });
  },
);

/**
 * What a verdict used to say.
 *
 * Read path for `TriageVerdictRevision`, and the reason the table is not
 * write-only: a reviewer looking at a fresh verdict needs to see that the last
 * one was overruled, or the re-triage has hidden the correction instead of
 * building on it.
 */
triageRouter.get('/verdicts/:verdictId/history', async (req, res) => {
  const verdict = await prisma.triageVerdict.findUnique({
    where: { id: param(req.params.verdictId) },
    select: {
      id: true,
      revision: true,
      verdict: true,
      confidence: true,
      reviewState: true,
      overriddenTo: true,
      model: true,
      clusterKey: true,
      derivedFromId: true,
      splitFromClusterKey: true,
      createdAt: true,
    },
  });
  if (!verdict) throw notFound('Verdict');

  const revisions = await prisma.triageVerdictRevision.findMany({
    where: { verdictId: verdict.id },
    orderBy: { revision: 'desc' },
    select: {
      revision: true,
      verdict: true,
      confidence: true,
      explanation: true,
      model: true,
      reviewState: true,
      overriddenTo: true,
      reviewedBy: true,
      reviewedAt: true,
      supersededAt: true,
      supersededBy: true,
      reason: true,
    },
  });

  res.json({
    current: { ...verdict, derived: verdict.derivedFromId !== null },
    revisions,
  });
});

// ─── The accuracy scorecard ──────────────────────────────────────────────────

/**
 * How often humans overrule the model, per verdict kind, per project.
 *
 * Two groupBy reads and no sampling: the arithmetic is exact, and the only
 * numbers that are null are the ones nobody can compute. `triageAccuracy`
 * (packages/agent/src/triage.ts) owns the honesty rules — chiefly that a rate
 * over zero reviews is NULL and not 0%, because "this verdict has never been
 * wrong" and "nobody has ever checked it" are opposite facts and printing 0%
 * for the second reads as a pass.
 *
 * Superseded corrections are counted too, out of `TriageVerdictRevision`. A
 * correction a human made is evidence whether or not a later re-triage replaced
 * it, and reading the live rows only would under-count exactly the projects
 * that use the re-triage endpoint most.
 */
triageRouter.get('/accuracy', async (req, res) => {
  const projectId = param(req.query.projectId);
  await requireProject(projectId);

  const days = Math.min(
    Math.max(Number(req.query.days ?? CORRECTION_HISTORY_DAYS) || CORRECTION_HISTORY_DAYS, 1),
    ACCURACY_MAX_DAYS,
  );
  const since = new Date(Date.now() - days * DAY_MS);
  const scope = { createdAt: { gte: since }, testResult: { run: { projectId } } } as const;

  const [stateGroups, correctionGroups, revisionRows] = await Promise.all([
    prisma.triageVerdict.groupBy({
      by: ['verdict', 'reviewState'],
      where: scope,
      _count: { _all: true },
    }),
    prisma.triageVerdict.groupBy({
      by: ['verdict', 'overriddenTo'],
      where: { ...scope, reviewState: 'OVERRIDDEN' },
      _count: { _all: true },
    }),
    /*
     * The superseded half. Grouped in memory rather than by the database
     * because the filter has to reach through two relations
     * (revision → verdict → result → run) and the row count is bounded by how
     * often humans re-triage, which is small by construction.
     */
    prisma.triageVerdictRevision.findMany({
      where: {
        /*
         * BOTH reviewed states, not just OVERRIDDEN. Reading the overrides
         * alone is the same mistake `summariseCorrections` exists to avoid:
         * the override lands in the numerator and the acceptance that balanced
         * it is dropped, so a project that accepted five and overruled five —
         * and then re-triaged all ten — is told it was overruled 100% of the
         * time. The bias falls hardest on exactly the projects that use the
         * re-triage endpoint most, which is the group this arm was added for.
         */
        reviewState: { in: ['ACCEPTED', 'OVERRIDDEN'] },
        supersededAt: { gte: since },
        parent: { testResult: { run: { projectId } } },
      },
      take: MAX_RETRIAGE_FANOUT * 10,
      select: { verdict: true, overriddenTo: true, reviewState: true },
    }),
  ]);

  const states: VerdictStateTally[] = stateGroups.map((g) => ({
    verdict: g.verdict,
    reviewState: g.reviewState,
    count: g._count._all,
  }));

  const corrections: VerdictCorrectionTally[] = correctionGroups.map((g) => ({
    verdict: g.verdict,
    overriddenTo: g.overriddenTo,
    count: g._count._all,
  }));

  /*
   * Two tallies out of one read. `supersededStates` keeps the ACCEPTED and the
   * OVERRIDDEN halves apart so the rate has both a numerator and a denominator;
   * `superseded` is only the overrides, because an acceptance has no from→to.
   */
  const supersededStates = new Map<string, VerdictStateTally>();
  const superseded = new Map<string, VerdictCorrectionTally>();
  for (const row of revisionRows) {
    const stateKey = `${row.verdict}|${row.reviewState}`;
    const state = supersededStates.get(stateKey);
    if (state) state.count += 1;
    else
      supersededStates.set(stateKey, {
        verdict: row.verdict,
        reviewState: row.reviewState,
        count: 1,
      });

    if (row.reviewState !== 'OVERRIDDEN') continue;
    const key = `${row.verdict}->${String(row.overriddenTo)}`;
    const found = superseded.get(key);
    if (found) found.count += 1;
    else superseded.set(key, { verdict: row.verdict, overriddenTo: row.overriddenTo, count: 1 });
  }

  const accuracy = triageAccuracy(
    [
      ...states,
      /*
       * A superseded reviewed row was a verdict of that kind that a human
       * looked at, so it belongs in the state tally under the state they left
       * it in. Folding it in here rather than inside `triageAccuracy` keeps
       * that function pure arithmetic over whatever the caller counted.
       */
      ...supersededStates.values(),
    ],
    [...corrections, ...superseded.values()],
    { windowDays: days },
  );

  res.json({
    projectId,
    windowDays: days,
    ...accuracy,
    /** Every verdict kind is reported, including the ones with no rows. */
    kinds: VERDICTS as readonly Verdict[],
    /*
     * CORRECTIONS, not reviews. The read behind it now covers acceptances too
     * (see the `where` above), so counting every row would relabel acceptances
     * as corrections — `supersededReviews` is the row count and this stays the
     * number of overrides it found.
     */
    supersededCorrections: [...superseded.values()].reduce((sum, row) => sum + row.count, 0),
    supersededReviews: revisionRows.length,
  });
});
