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
 *  · `KnownIssue` — the DURABLE mute, with an owner, an expiry and a count —
 *    HAD NO WRITER AT ALL. Table, matcher, GIN index, match ledger, worker read
 *    and roster all landed; nothing could create a row. See "The durable mute"
 *    below: three doors, and the expiry sweep's report finally has one too.
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
import {
  QUEUE_NAMES,
  SUPPRESSION_KIND_RULES,
  VERDICTS,
  VERDICT_REVIEW_STATES,
  createKnownIssueSchema,
  forceStateOf,
  knownIssueExpiryWithin,
  revokeKnownIssueSchema,
  reviewStateSuppresses,
} from '@qaai/shared';
import type {
  KnownIssueMatcher,
  SuppressionForceState,
  SuppressionRefusal,
  Verdict,
  VerdictReviewStateName,
} from '@qaai/shared';
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
      /*
       * WHICH KNOWN ISSUE SILENCED THIS, when `reviewState` is MUTED.
       *
       * Selected because this list is where a human reads a verdict's state,
       * and MUTED on its own is not a suppression: it suppresses only while an
       * issue that is IN FORCE backs it. Without this column the cause page
       * rendered MUTED beside a failure that was paging somebody, which is the
       * original defect showing through a read instead of a write.
       */
      knownIssueId: true,
      testResult: { select: { id: true, runId: true, test: { select: { name: true } } } },
    },
  });

  const occurrences = occurrenceRows.slice(0, CAUSE_PAGE_LIMIT);
  const verdicts = verdictRows.slice(0, CAUSE_PAGE_LIMIT);
  /*
   * The issues behind this page's mutes, so every MUTED row below is reported
   * with whether it still suppresses rather than with the bare state. One read
   * for the page; no read at all when nothing on it is muted.
   */
  const issues = await knownIssuesByIdFor(verdicts);

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
      /**
       * Whether this verdict's state actually silences anything, and what is
       * behind it. `reviewState` alone is not the answer: a MUTED verdict whose
       * known issue expired is a failure that is red again.
       */
      suppression: verdictSuppression(
        v.reviewState,
        v.knownIssueId === null ? null : issues.get(v.knownIssueId) ?? null,
        now,
      ),
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

// ─── The durable mute (§8) ───────────────────────────────────────────────────

/**
 * `KnownIssue` HAD NO WRITER. That is the defect this section closes, and it is
 * the worst shape a defect takes in this repository: everything else about the
 * durable mute was finished and correct.
 *
 * The table, the exact-key matcher (`matchKnownIssue`), the expiry rule
 * (`isInForce`), the GIN index over `signatures`, the `KnownIssueMatch` ledger,
 * the roster in routes/agent.ts and — the part that pays for the feature — the
 * worker read that skips the verdict AND the strong-model call for a cause
 * somebody has already judged (`processTriage`,
 * apps/worker/src/processors/triage.ts). All of it reachable, none of it
 * reachable FROM A CUSTOMER, because no endpoint could insert a row.
 *
 * The only mute door that existed was `POST /verdicts/:verdictId/review` with
 * action `mute`, which wrote `VerdictReviewState.MUTED` and nothing else. So
 * `reviewStateSuppresses(state, liveKnownIssue)` was being asked about a mute
 * with no issue behind it, and correctly suppressed NOTHING — a human pressed
 * mute, the board said MUTED, and the next run paged them again.
 *
 * Three doors here, and the third is not a convenience:
 *
 *  · POST /triage/known-issues            mint one, for one cause or several.
 *  · POST /triage/known-issues/:id/revoke take it back NOW, before its expiry.
 *  · GET  /triage/known-issues            the roster, INCLUDING the dead rows.
 *
 * WHY THE ROSTER SHOWS THE EXPIRED AND THE REVOKED ONES. An expired mute that
 * silenced nothing is a row its owner needs to see: hiding it is how a team
 * learns the board is lying to them, and how the next mute gets set for a year.
 * `forceStateOf` is the ONE function that says which of the three states a row
 * is in, asked here and by the roster in routes/agent.ts, so the two surfaces
 * cannot disagree about whether a suppression is live.
 *
 * WHY THESE SIT BESIDE THE SIGNATURE MUTE RATHER THAN REPLACING IT.
 * `FailureSignature.mutedUntil` is a per-cause timer with no owner, no tracker
 * link and no durable count, and it can only express one mute per cause; a
 * `KnownIssue` is a row a named human owns, which may cover three causes and
 * which records what it silenced. The worker takes the same branch for both and
 * its log line says which fired. Retiring the older one is a migration, not a
 * round's work.
 */

/** Known issues per read. Disclosed on every response that applies it. */
export const KNOWN_ISSUE_PAGE_LIMIT = 100;

/**
 * The default window for "which mutes stop suppressing soon", in days.
 *
 * A week, because that is the question a person actually asks on a Monday. The
 * CEILING is the kind's own `maxDays` rather than a second number: a mute
 * cannot be stamped further out than fourteen days, so a wider window cannot
 * contain a row this one misses, and a caller asking for ninety is told the
 * clamp rather than handed the same list under a wrong label.
 */
export const EXPIRING_WINDOW_DEFAULT_DAYS = 7;
export const EXPIRING_WINDOW_MAX_DAYS = SUPPRESSION_KIND_RULES.MUTE.maxDays;

/**
 * Our prose for every refusal in `SUPPRESSION_REFUSALS`.
 *
 * A `Record<SuppressionRefusal, string>` cannot be written without naming every
 * member, so a tenth refusal is a compile error here rather than an endpoint
 * answering `undefined` to a caller. Both doors use it — this file's writer and
 * the review door in routes/agent.ts — so one refusal reads the same wherever a
 * customer meets it.
 *
 * NO VALUE IS INTERPOLATED INTO ANY OF THESE SENTENCES, and that is the rule
 * rather than a coincidence: the refusal travels with a PATH
 * (`SuppressionRefused.path`, or `refusedPaths` below) and never with the
 * offending input. A zod message quotes the value it rejected, and one stored
 * row with an extra key once produced a literal customer-facing flag carrying
 * that row's own text.
 */
/**
 * How many of a project's known issues a mute door reads looking for one that
 * already covers the cause.
 *
 * Bounded because it is a GIN lookup a customer can trigger over HTTP, and 50
 * rows naming one 12-hex key is already a project that has muted the same cause
 * fifty separate times. When it bites, the response and the audit row SAY SO:
 * an unseen cover means a second `KnownIssue` for one cause, which splits the
 * match count across two rows, and a split count is a number nobody can audit.
 *
 * It lives HERE rather than in either door because BOTH doors scan — the
 * single-verdict review in routes/agent.ts and the bulk mute in routes/team.ts
 * — and two caps that look like a copy of each other are two caps that drift.
 */
export const KNOWN_ISSUE_COVER_SCAN = 50;

export const SUPPRESSION_REFUSAL_PROSE: Record<SuppressionRefusal, string> = {
  NO_OWNER: 'A suppression needs an owner. "Somebody muted this" is not an owner.',
  OWNER_NOT_HUMAN_SET:
    'A suppression may only be owned by an owner a human set. A pattern may route a failure to a team; it may not decide that the failure stops counting.',
  NO_REASON:
    'A suppression needs a stated reason. An unexplained silence is one somebody else inherits with no way to evaluate it.',
  NO_EXPIRY:
    'A suppression needs an expiry. There is no "forever" here: a mute nobody re-makes is a deletion nobody signed.',
  EXPIRY_IN_PAST:
    'That expiry has already passed, so the suppression would read as expired the instant it was written.',
  EXPIRY_BEYOND_MAX:
    'That expiry is past the ceiling for this kind of suppression. It is refused rather than clamped: a caller who asked for ninety days and silently got fourteen would believe the silence outlasts the sprint it was meant for.',
  SCOPE_MISMATCH:
    'This kind of suppression does not take a date — it expires with the run that justified it.',
  WRONG_TARGET_SCOPE:
    'That target is not in the key space this kind of suppression may name. A mute names a 12-hex cause key and nothing else.',
  DENOMINATOR_WOULD_SHRINK:
    'That suppression would take a surface out of the coverage denominator, which this kind is not allowed to do.',
};

/**
 * The distinct field PATHS a validator refused, de-duplicated.
 *
 * THE PATHS AND NEVER THE MESSAGES. zod composes several of its own messages
 * out of the offending input, so a message is a channel through which a stored
 * row's text reaches a customer-facing error body — and from there whatever
 * reads it. Our prose says what was wrong; this says where.
 *
 * Typed structurally rather than as `ZodError` so this file does not import zod
 * for one signature; `path` is `PropertyKey[]` in zod 4.
 */
export function refusedPaths(
  issues: readonly { readonly path: readonly PropertyKey[] }[],
): string[] {
  return [...new Set(issues.map((issue) => issue.path.map(String).join('.') || '(root)'))];
}

/**
 * Every column the three doors and the expiry read hand back.
 *
 * Exported because the review door in routes/agent.ts writes a `KnownIssue`
 * too, and the row it returns has to be the same shape a reader just saw on the
 * roster. Two selects for one model is two chances for one of them to drop a
 * column and report it as absent.
 */
export const knownIssueSelection = {
  id: true,
  projectId: true,
  title: true,
  reason: true,
  signatures: true,
  ownerUserId: true,
  ownerTeamId: true,
  ownerProvenance: true,
  expiresAt: true,
  trackerIssueId: true,
  matchCount: true,
  firstMatchedAt: true,
  lastMatchedAt: true,
  revokedAt: true,
  revokedBy: true,
  revokedReason: true,
  createdBy: true,
  createdAt: true,
} as const;

/**
 * EXPORTED so a third writer can hold a row of this shape without inventing a
 * second name for it — `POST /team/triage/bulk` keeps one per muted cause so
 * the reply can render the issue it minted through `knownIssueView`.
 */
export type KnownIssueRead = {
  [K in keyof typeof knownIssueSelection]: K extends 'signatures'
    ? string[]
    : K extends 'expiresAt' | 'createdAt'
      ? Date
      : K extends 'firstMatchedAt' | 'lastMatchedAt' | 'revokedAt'
        ? Date | null
        : K extends 'matchCount'
          ? number
          : K extends 'ownerUserId' | 'ownerTeamId' | 'trackerIssueId' | 'revokedBy' | 'revokedReason'
            ? string | null
            : string;
};

/**
 * One known issue, as every endpoint in this file reports it.
 *
 * Field-for-field the shape `GET /projects/:projectId/known-issues` already
 * returns (routes/agent.ts), deliberately: that roster adds the per-issue match
 * EVIDENCE and this one is the writer's read-back, and a customer reading both
 * must not have to work out whether `forceState` means the same thing in each.
 * It does, because both ask `forceStateOf`.
 *
 * There is no `suppressing` boolean beside `forceState`. Two fields that can
 * disagree about one fact is the defect `healVerificationDisplay` shipped:
 * IN_FORCE is the suppressing state and the other two are not.
 */
export function knownIssueView(row: KnownIssueRead, now: Date): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    reason: row.reason,
    signatures: row.signatures,
    owner: row.ownerUserId
      ? { kind: 'USER' as const, userId: row.ownerUserId }
      : row.ownerTeamId
        ? { kind: 'TEAM' as const, teamId: row.ownerTeamId }
        : null,
    ownerProvenance: row.ownerProvenance,
    forceState: forceStateOf(row, now),
    expiresAt: row.expiresAt,
    /** Failures this mute has silenced over its whole life. The headline. */
    matchCount: row.matchCount,
    firstMatchedAt: row.firstMatchedAt,
    lastMatchedAt: row.lastMatchedAt,
    trackerIssueId: row.trackerIssueId,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
    revokedReason: row.revokedReason,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/** How many of a page are live, expired and revoked. Over the PAGE, which is why it says so. */
function forceStateCounts(
  rows: readonly KnownIssueRead[],
  now: Date,
): Record<SuppressionForceState, number> {
  const counts: Record<SuppressionForceState, number> = { IN_FORCE: 0, EXPIRED: 0, REVOKED: 0 };
  for (const row of rows) counts[forceStateOf(row, now)] += 1;
  return counts;
}

/**
 * Whether a verdict's review state actually suppresses anything, and what is
 * behind it.
 *
 * ── WHY THIS EXISTS AND WHY IT TAKES BOTH ──────────────────────────────────
 *
 * `reviewState: MUTED` is NOT a suppression and never was. It suppresses only
 * while a `KnownIssue` that is IN FORCE backs it, which is why
 * `reviewStateSuppresses` takes the state AND the issue — a function taking
 * only the state would be the original defect with a nicer name. Every surface
 * in this file and in routes/agent.ts that hands a reader a `reviewState`
 * reports this beside it, so "MUTED" can never be read as "handled".
 *
 * `knownIssueId: null` on a MUTED verdict is not an impossible state: it is
 * exactly what the old door wrote, every time, for as long as it existed. Those
 * rows say MUTED and silence nothing, and `note` says so rather than letting
 * the state speak for itself.
 *
 * `null` for a state this API does not recognise, and `suppresses: false` with
 * it. A review state is a Prisma enum, so an unknown value means the enum grew
 * and this file was not told — and falling through into "not suppressed" would
 * be a measured answer invented out of an unmeasured one.
 */
export interface VerdictSuppression {
  reviewState: VerdictReviewStateName | null;
  knownIssueId: string | null;
  forceState: SuppressionForceState | null;
  /** The only field a gate or a digest may act on. */
  suppresses: boolean;
  note: string | null;
}

export function verdictSuppression(
  reviewState: string,
  issue: KnownIssueMatcher | null,
  now: Date,
): VerdictSuppression {
  const state = (VERDICT_REVIEW_STATES as readonly string[]).includes(reviewState)
    ? (reviewState as VerdictReviewStateName)
    : null;
  if (state === null) {
    return {
      reviewState: null,
      knownIssueId: issue?.id ?? null,
      forceState: null,
      suppresses: false,
      note: 'This verdict carries a review state this API does not recognise, so nothing here claims it suppresses anything.',
    };
  }

  const forceState = issue === null ? null : forceStateOf(issue, now);
  // The live issue, or null — and `reviewStateSuppresses` gets the null, so the
  // expiry comparison that decides this lives in exactly one place.
  const live = issue !== null && forceState === 'IN_FORCE' ? issue : null;
  const suppresses = reviewStateSuppresses(state, live);

  return {
    reviewState: state,
    knownIssueId: issue?.id ?? null,
    forceState,
    suppresses,
    note:
      state !== 'MUTED' || suppresses
        ? null
        : issue === null
          ? 'This verdict says MUTED and no known issue is behind it, so it suppresses nothing: the failure still counts and still pages. Mute the cause again to make it durable.'
          : forceState === 'REVOKED'
            ? 'The known issue behind this mute was revoked, so it stopped suppressing the moment somebody took it back, before its expiry.'
            : 'The known issue behind this mute has expired, so this failure is red again and nobody had to do anything.',
  };
}

/** The matcher shape, which is all `reviewStateSuppresses` needs off an issue. */
const knownIssueMatcherSelection = {
  id: true,
  signatures: true,
  expiresAt: true,
  revokedAt: true,
} as const;

/**
 * The known issues named by a page of verdicts, keyed by id.
 *
 * ONE read for the whole page rather than one per verdict, and no `take`: the
 * key set is bounded by the page the caller already asked for, so a cap here
 * would be a cap on nothing that could also hide an issue and make a live mute
 * read as absent.
 */
async function knownIssuesByIdFor(
  verdicts: readonly { knownIssueId?: string | null }[],
): Promise<Map<string, KnownIssueMatcher>> {
  const ids = [
    ...new Set(
      verdicts
        .map((verdict) => verdict.knownIssueId ?? null)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (ids.length === 0) return new Map();
  const rows = await prisma.knownIssue.findMany({
    where: { id: { in: ids } },
    select: knownIssueMatcherSelection,
  });
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Mint a known issue: the durable mute, keyed on the CAUSE.
 *
 * MEMBER and audited, like the signature mute one screen up, because this is
 * the switch that makes a failure stop paging. Every refusal below is a defect
 * the register named, and all of them are enforced by
 * `createKnownIssueSchema` — no owner, an owner a glob chose, no expiry, a
 * pattern instead of a key — except the one that needs a clock, which is asked
 * separately on purpose.
 *
 * ── THE CLOCK IS PASSED IN, NOT READ BY THE VALIDATOR ──────────────────────
 *
 * `knownIssueExpiryWithin('MUTE', expiresAt, now)` takes `now` because a zod
 * refinement that called `new Date()` would make the same request validate at
 * 09:00 and fail at 09:01 with nothing to say why, and no test could pin
 * either. The ceiling is REFUSED rather than clamped: `POST
 * /triage/signatures/:clusterKey/mute` clamps and says so, and that endpoint
 * takes a number of days where this one takes a date a caller chose — a
 * fourteen-day answer to a "mute until the 3rd" request is a different silence
 * from the one asked for.
 *
 * ── SIGNATURES ARE EXACT KEYS ──────────────────────────────────────────────
 *
 * `matchKnownIssue` is exact membership, never a prefix and never a pattern.
 * The safety property of a mute is that the key changes when the cause does, so
 * a pattern would turn this into a quarantine wearing a mute's name. The schema
 * is where `^[0-9a-f]{12}$` is enforced, and this endpoint is the last place
 * that could have let something else through.
 */
triageRouter.post(
  '/known-issues',
  requireRole('MEMBER'),
  requireScope('runs:write'),
  async (req, res) => {
    const actor = actorOf(req);
    const now = new Date();

    const parsed = createKnownIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'That is not a known issue this API can store: an owner a human set, a stated reason, an expiry and at least one exact 12-hex cause key are all required.',
        { paths: refusedPaths(parsed.error.issues) },
      );
    }
    const input = parsed.data;
    await requireProject(input.projectId);

    const within = knownIssueExpiryWithin('MUTE', input.expiresAt, now);
    if (!within.ok) {
      throw badRequest(SUPPRESSION_REFUSAL_PROSE[within.refusal], {
        refusal: within.refusal,
        paths: [within.path],
        /*
         * The ceiling AND the sentence that justifies it, because a refusal
         * that states a number without saying what the number is for is a
         * refusal a caller works around rather than reads.
         */
        ceilingDays: SUPPRESSION_KIND_RULES.MUTE.maxDays,
        why: SUPPRESSION_KIND_RULES.MUTE.why,
      });
    }

    const row = await prisma.knownIssue.create({
      data: {
        orgId: actor.orgId,
        projectId: input.projectId,
        title: input.title,
        reason: input.reason,
        signatures: input.signatures,
        /*
         * Exactly one of the two, which the schema's discriminated union
         * guarantees and the migration's `KnownIssue_one_owner` CHECK enforces
         * for every other writer there will ever be — a backfill script, a
         * support query, a psql session.
         */
        ownerUserId: input.owner.kind === 'USER' ? input.owner.userId : null,
        ownerTeamId: input.owner.kind === 'TEAM' ? input.owner.teamId : null,
        ownerProvenance: input.ownerProvenance,
        expiresAt: input.expiresAt,
        trackerIssueId: input.trackerIssueId ?? null,
        createdBy: actor.userId,
      },
      select: knownIssueSelection,
    });

    /*
     * A suppression that is not auditable is not reversible. The signatures go
     * in the row rather than a count of them: "which causes stopped counting"
     * is the question an audit of a mute is read for.
     */
    await audit({
      actor,
      action: 'triage.knownIssue.create',
      targetType: 'KnownIssue',
      targetId: row.id,
      metadata: {
        projectId: input.projectId,
        signatures: input.signatures,
        reason: input.reason,
        expiresAt: input.expiresAt.toISOString(),
        ownerProvenance: input.ownerProvenance,
        ownerUserId: row.ownerUserId,
        ownerTeamId: row.ownerTeamId,
        trackerIssueId: row.trackerIssueId,
      },
    });

    res.status(201).json({
      knownIssue: knownIssueView(row, now),
      /*
       * WHAT THIS DOES, in the response, because the thing a mute does is stop
       * other things happening and that is invisible by construction.
       */
      note: `${input.signatures.length} cause(s) are muted until ${input.expiresAt.toISOString()}: no verdict and no strong-model heal will be bought for them, and every failure they silence is counted on this row's matchCount. It stops suppressing the moment it expires — nobody has to do anything for the failures to go red again.`,
    });
  },
);

/**
 * Which mutes stop suppressing soon, and which already have.
 *
 * ── THE DEFECT: A REPORT WITH NOWHERE TO GO ────────────────────────────────
 *
 * `processSuppressionSweep` (apps/worker/src/processors/triage.ts) already
 * computes exactly this, correctly, every tick — and writes it as one `warn`
 * per expired mute into the WORKER'S LOG, which no customer reads. An expiry
 * nobody saw coming is the thing that teaches a team to stop setting them, so
 * the information needs a door and this is it. The read is the same read: the
 * `@@index([orgId, projectId, expiresAt])` exists precisely so "which mutes
 * stop suppressing this week" is cheap, and it is deliberately NOT partial on
 * "still live" because the rows that matter most are the ones already over.
 *
 * `revokedAt: null`, mirroring the sweep for the reason recorded there: a
 * revoked mute was judged wrong rather than running out, somebody already
 * knows, and reporting it here as a surprise expiry would train a reader to
 * ignore the line. The full roster above shows them.
 *
 * TWO WINDOWS, SAID OUT LOUD RATHER THAN RECONCILED HERE. The sweep's horizon
 * is `SUPPRESSION_EXPIRY_WARNING_MS` — three days, its PAGING distance — and
 * this one defaults to a week because the question a person asks is "what stops
 * suppressing this week". They are deliberately different questions, but they
 * are two numbers for one subject in two workspaces, and the API cannot import
 * the worker's constant. Moving it to packages/shared is the fix and it is not
 * this file's to make; until then neither number is the other's authority.
 *
 * TWO LISTS, NOT ONE SORTED LIST. "Already stopped suppressing" and "about to"
 * are different actions — the first is a board that is already loud, the second
 * is a decision somebody still has time to make — and merging them would hide
 * whichever was shorter.
 */
triageRouter.get('/known-issues/expiring', async (req, res) => {
  const now = new Date();
  const projectId = param(req.query.projectId);
  await requireProject(projectId);

  const asked = Number(req.query.days ?? EXPIRING_WINDOW_DEFAULT_DAYS);
  const days = Math.min(
    Math.max(Number.isFinite(asked) ? asked : EXPIRING_WINDOW_DEFAULT_DAYS, 1),
    EXPIRING_WINDOW_MAX_DAYS,
  );
  const horizon = new Date(now.getTime() + days * DAY_MS);

  const rows = await prisma.knownIssue.findMany({
    where: { projectId, revokedAt: null, expiresAt: { lte: horizon } },
    // Soonest first: the row about to stop suppressing is the one somebody has
    // to act on, and it is the one a long list buries.
    orderBy: { expiresAt: 'asc' },
    take: KNOWN_ISSUE_PAGE_LIMIT + 1,
    select: knownIssueSelection,
  });
  const more = rows.length > KNOWN_ISSUE_PAGE_LIMIT;
  const page = rows.slice(0, KNOWN_ISSUE_PAGE_LIMIT);

  /*
   * `forceStateOf` and not `expiresAt <= now` written out again. One
   * comparison, one place, and the boundary is `>` rather than `>=` — a mute
   * expiring exactly now is OVER. A second copy of that comparison here is a
   * second chance to get the boundary wrong.
   *
   * `over` is `!== 'IN_FORCE'` rather than `=== 'EXPIRED'` ON PURPOSE. The
   * `where` above excludes revoked rows, so in practice these are the expired
   * ones — but partitioning on two positive tests would drop a row that was
   * neither, and a suppression that vanishes from a report is strictly worse
   * than one shown under a heading that is slightly wrong. Every row carries
   * its own `forceState`, which is the authoritative answer; the two lists are
   * the convenience.
   */
  const over = page.filter((row) => forceStateOf(row, now) !== 'IN_FORCE');
  const soon = page.filter((row) => forceStateOf(row, now) === 'IN_FORCE');

  res.json({
    projectId,
    windowDays: days,
    horizon,
    /** Mutes that have already stopped suppressing. The failures are red again. */
    over: over.map((row) => knownIssueView(row, now)),
    /** Mutes still in force inside the window. Renew, revoke or fix. */
    expiringSoon: soon.map((row) => knownIssueView(row, now)),
    /*
     * What the expired ones silenced while they worked — the number that
     * decides whether renewing was ever the right call. Summed over the rows
     * RETURNED, which is why `more` travels with it.
     */
    silencedByExpired: over.reduce((sum, row) => sum + row.matchCount, 0),
    returned: page.length,
    limit: KNOWN_ISSUE_PAGE_LIMIT,
    more,
    /*
     * The clamp, said out loud when it bit, with the reason that actually bit
     * it. A mute cannot be stamped further out than the kind's ceiling, so a
     * wider window cannot contain a row this one missed — but a caller who
     * asked for ninety days and got fourteen must not be left believing they
     * have seen ninety days of expiries.
     */
    clampedNote:
      asked > EXPIRING_WINDOW_MAX_DAYS
        ? `Clamped to ${EXPIRING_WINDOW_MAX_DAYS} days, which is the ceiling on a mute's expiry: no mute can be stamped further out than that, so a wider window would return the same rows under a label that promised more.`
        : null,
  });
});

/**
 * This project's known issues, live and dead.
 *
 * NOTHING IS FILTERED OUT. An expired mute that silenced nothing is a row the
 * owner needs to see, and a roster that showed only the live ones would make an
 * expiry arrive as a surprise outage — which is how a team learns to set the
 * next one for a year.
 */
triageRouter.get('/known-issues', async (req, res) => {
  const now = new Date();
  const projectId = param(req.query.projectId);
  await requireProject(projectId);

  const rows = await prisma.knownIssue.findMany({
    where: { projectId },
    orderBy: { expiresAt: 'asc' },
    take: KNOWN_ISSUE_PAGE_LIMIT + 1,
    select: knownIssueSelection,
  });
  const more = rows.length > KNOWN_ISSUE_PAGE_LIMIT;
  const page = rows.slice(0, KNOWN_ISSUE_PAGE_LIMIT);

  res.json({
    projectId,
    knownIssues: page.map((row) => knownIssueView(row, now)),
    returned: page.length,
    limit: KNOWN_ISSUE_PAGE_LIMIT,
    /** Observed, not inferred from `returned === limit`: one row past the cap is read and dropped. */
    more,
    /*
     * NAMED FOR WHAT IT COUNTS. These are the states of the rows on THIS PAGE,
     * not the project's totals, and a truncated page labelled as a total is a
     * number nobody can audit. `more` says when the two differ.
     */
    forceStatesOnThisPage: forceStateCounts(page, now),
  });
});

/**
 * Revoke a known issue: stop suppressing NOW, before the expiry.
 *
 * A WRITE AND NOT A DELETE. An EXPIRED mute and a REVOKED one are different
 * facts — the first ran out, the second was judged wrong — and only the second
 * says anything about the decision. `forceStateOf` puts revocation ahead of
 * expiry for the same reason, so a revoked issue stops suppressing on the very
 * next read rather than at the date it was stamped with.
 *
 * REVOKING TWICE IS A CONFLICT. The second write would overwrite the first
 * reason and the first timestamp, which are the whole record of when somebody
 * decided the mute was wrong — and a caller re-sending a revoke has no way to
 * tell that it destroyed something unless this says so.
 *
 * REVOKING AN ALREADY-EXPIRED MUTE IS ALLOWED, because "this ran out" and "this
 * was a mistake" are both things somebody may want on the record. The response
 * and the audit row carry the force state FROM BEFORE the write, so nothing
 * here can be read as the revocation having been what stopped it.
 */
triageRouter.post(
  '/known-issues/:id/revoke',
  requireRole('MEMBER'),
  requireScope('runs:write'),
  async (req, res) => {
    const actor = actorOf(req);
    const now = new Date();

    /*
     * The id comes from the path and the reason from the body, assembled into
     * the shape the shared schema validates — so the API and any other caller
     * of `revokeKnownIssueSchema` refuse the same empty reason.
     */
    const parsed = revokeKnownIssueSchema.safeParse({
      knownIssueId: param(req.params.id),
      reason: req.body?.reason,
    });
    if (!parsed.success) {
      throw badRequest(
        'reason is required: a revocation with no stated reason leaves the next reader unable to tell whether the mute was wrong or merely finished.',
        { paths: refusedPaths(parsed.error.issues) },
      );
    }

    const existing = await prisma.knownIssue.findUnique({
      where: { id: parsed.data.knownIssueId },
      select: knownIssueSelection,
    });
    // The tenancy extension makes another org's row read as absent, which is
    // exactly what notFound() answers — never an existence oracle.
    if (!existing) throw notFound('Known issue');

    /*
     * Read BEFORE the write. "Was this suppressing anything when somebody
     * revoked it?" is a fact about the state the request replaced, and
     * computing it from the updated row would make the audit describe the
     * outcome instead of the decision.
     */
    const forceStateBefore = forceStateOf(existing, now);
    if (existing.revokedAt) {
      throw conflict(
        'This known issue was already revoked. Re-revoking it would overwrite the reason and the timestamp of the decision that is already on the record.',
        { revokedAt: existing.revokedAt, forceState: forceStateBefore },
      );
    }

    const updated = await prisma.knownIssue.update({
      where: { id: existing.id },
      data: { revokedAt: now, revokedBy: actor.userId, revokedReason: parsed.data.reason },
      select: knownIssueSelection,
    });

    await audit({
      actor,
      action: 'triage.knownIssue.revoke',
      targetType: 'KnownIssue',
      targetId: existing.id,
      metadata: {
        projectId: existing.projectId,
        signatures: existing.signatures,
        reason: parsed.data.reason,
        /** What it was before the write — live, already expired, and which. */
        forceStateBefore,
        /** What it silenced while it worked. The cost of the decision now reversed. */
        silenced: existing.matchCount,
        expiresAt: existing.expiresAt.toISOString(),
      },
    });

    res.json({
      knownIssue: knownIssueView(updated, now),
      forceStateBefore,
      note:
        forceStateBefore === 'IN_FORCE'
          ? `This mute stopped suppressing now, ${Math.max(Math.ceil((existing.expiresAt.getTime() - now.getTime()) / DAY_MS), 1)} day(s) before its expiry. The ${existing.signatures.length} cause(s) it named are red again on the next run, and the ${existing.matchCount} failure(s) it silenced stay on the row as the record of what it cost.`
          : `This mute was already ${forceStateBefore.toLowerCase()} and was suppressing nothing, so the revocation changed no behaviour — it put on the record that the decision was wrong rather than merely finished.`,
    });
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
