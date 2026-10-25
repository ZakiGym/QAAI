/**
 * Outbound notifications (§7) — pull-request comments, chat, and webhooks.
 *
 * One processor decides who hears about a finished run: a PR-triggered run gets
 * a comment on the pull request, a run that FAILED OR WAS BLOCKED BY A QUALITY
 * GATE reaches the chat integrations that asked for failures (the default), and
 * a monitor crossing its failure threshold pages chat directly. A run that is
 * green and unblocked reaches only an integration whose notification preference
 * says `runFinished: 'all'` — by default it stays quiet, because nobody wants
 * that notification.
 *
 * The PR comment deliberately reports triage verdicts rather than raw pass/fail.
 * "3 failed" makes a reviewer open QAAI; "2 look like real bugs, 1 is an
 * intended change with a fix proposed" lets them act without leaving GitHub.
 *
 * The chat MESSAGE is held to the same bar as the PR comment, for the same
 * reason: the person reading it is on a phone, at night, deciding whether to
 * get up. "3 test(s) failed. Run cmx…" — which was this file's chat text — asks
 * them to open a laptop to learn what broke and where, so the alert renderers
 * below name the project and the environment, count what happened, name the
 * first few tests that failed, and always end in a LINK.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { describeWebhookFailure } from '@qaai/shared';
import type { GateResult, NotifyJob } from '@qaai/shared';
import { logger, prisma } from '../context.js';
import { open as openSecret } from '../vault.js';
import { enqueueDelivery, type DeliveryJob } from '../queues.js';
/*
 * Pure helpers shared with the API's integrations surface — imported the way
 * digest.ts imports run-selection.js (types and functions; no Prisma, no
 * Express, no env). Both sides must agree on the sealed-credential envelope,
 * the AAD, the destination rules and the preference semantics, and two
 * implementations of any of those is how a URL accepted at the door gets
 * refused at delivery — or a page goes to a channel that opted out.
 */
import {
  chatPayload,
  checkChatDestination,
  decodeChatCredentials,
  integrationAad,
  notifyPrefsOf,
  wantsRunFinished,
} from '../../../api/src/lib/chat-integrations.js';
import type { ChatCredentials, NotifyPrefs } from '../../../api/src/lib/chat-integrations.js';
/*
 * The ownership resolver, imported the way digest.ts imports it — same
 * function, same precedence, no Prisma inside it. Three answers to "whose
 * failure is this" would be three answers, and the one on the page at 3am is
 * the one that has to agree with the one on the ticket.
 */
import {
  OWNERSHIP_RULE_SELECT,
  assignOwner,
  ownerLabel,
  verdictOwnerColumns,
} from '../../../api/src/lib/ownership.js';
import type {
  OwnerDirectory,
  OwnershipRuleInput,
} from '../../../api/src/lib/ownership.js';

/*
 * `VERDICT_LABEL` and `MAX_FAILURES_LISTED` lived here for the PR comment this
 * file used to build. That moved to processors/checks.ts, which owns the one
 * comment it edits in place; these went with it rather than staying as two
 * constants nothing reads.
 */


// ─── The chat alert itself ───────────────────────────────────────────────────

/**
 * Where a chat alert points.
 *
 * The app URL, because it is the only link this repo can mint today. A public,
 * unauthenticated share link would be the better destination for a page that
 * reaches a phone at 3am — the on-call person may not be signed in, and may not
 * even have an account — and when one exists it belongs HERE, in the one
 * function every alert routes through, rather than sprinkled through the
 * renderers. Until then an app link that asks for a login still beats a bare
 * run id, which asks for a login AND a search.
 */
function runLink(runId: string): string {
  return `${process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000'}/runs/${runId}`;
}

/** How many failing tests a chat message names before it starts summarising. */
const MAX_FAILURES_IN_CHAT = 5;

/**
 * Statuses that are somebody's problem. FLAKY is: a retry that passes is not a
 * pass.
 *
 * ONE definition, declared above every reader in this file, and that is the
 * repair rather than a tidy-up. There were two: the routing below used this
 * list while the run alert's own failure list was `FAILED || TIMED_OUT`
 * inline — so a FLAKY failure got `assigneeUserId`, `ownerState` and
 * `assignedAt` written onto its verdict and its owner was never named in the
 * chat message, which is the entire point of writing them. A reader deciding
 * "is this mine?" never saw the row that said it was.
 */
export const FAILING_STATUSES = ['FAILED', 'TIMED_OUT', 'FLAKY'] as const;

/** The predicate form, so no caller re-spells the list. */
export function isFailing(status: string): boolean {
  return (FAILING_STATUSES as readonly string[]).includes(status);
}

/**
 * How many of a run's failures are routed. Same ceiling as the filing path.
 * A suite that failed wholesale is one cause, not five thousand assignments.
 *
 * Declared up here because the ALERT has to be able to name it: past this many
 * failures the un-routed remainder is reported as "not routed", not as
 * unowned, and the message says the cap was hit. See `renderRunAlert`.
 */
const MAX_FAILURES_ROUTED = 500;

/**
 * The blocking half of a gate result, as sentences.
 *
 * Only BLOCK evaluations: a WARN is by definition the thing the team decided
 * not to be woken for, and folding warnings into a page is how a page gets
 * muted. Reads through `unknown` because `Run.gateResult` is a Json column —
 * a run finalised by an older worker, or one still in flight, has whatever it
 * has, and an alert must not throw on the way to being sent.
 */
export function blockingGateRules(gateResult: unknown): string[] {
  const gate = (gateResult ?? null) as Partial<GateResult> | null;
  if (!gate || !Array.isArray(gate.evaluations)) return [];
  return gate.evaluations
    .filter((evaluation) => evaluation?.action === 'BLOCK')
    .map((evaluation) => String(evaluation.detail ?? 'a quality gate rule'));
}

export interface RunAlertInput {
  id: string;
  passedCount: number;
  failedCount: number;
  flakyCount: number;
  gateResult: unknown;
  project: { name: string } | null;
  environment: { name: string } | null;
  results: Array<{
    status: string;
    test: { name: string; filePath: string };
  }>;
  /**
   * Who owns each named failure, keyed by `test.filePath` + `test.name`.
   *
   * Passed in rather than resolved here so the renderer stays pure. Absent (or
   * empty) means the project has no ownership rules at all, and the alert then
   * says nothing about ownership: ownership is opt-in, and a line reading
   * "unowned" under every failure in an install that never asked for the
   * feature is how an alert gets muted. When rules DO exist, a failure none of
   * them match is marked unowned explicitly — visibly unowned is the whole
   * point, since an unowned failure that looks owned is the one nobody picks up.
   *
   * A KEY THAT IS ABSENT IS NOT A KEY MAPPED TO NULL. Present-and-null means
   * the rules were evaluated and none matched: unowned, a measured fact.
   * Absent means this failure was never looked at — it fell outside
   * `MAX_FAILURES_ROUTED`. The renderer tells those two apart, because
   * printing the word "unowned" under a failure nobody tried to route is a cap
   * being reported as a fact about ownership.
   */
  owners?: ReadonlyMap<string, string | null>;
  /**
   * True when the run had more failures than `MAX_FAILURES_ROUTED`, so the
   * routing covered a page of them. Stated in the message: a reader who cannot
   * see the cap reads "not routed" as a bug in QAAI rather than as a ceiling.
   */
  ownersCapped?: boolean;
  /**
   * Causes muted for this run — `RunFailureCluster.suppressed`.
   *
   * NULL MEANS NOT READ, and 0 means nothing was muted; both render as
   * silence, because the line this feeds only ever appears as a positive
   * statement ("3 causes were muted"). The alert therefore never asserts a
   * suppression number it did not measure, and the absence of the line is not
   * a claim that nothing was suppressed. The read that produces this logs its
   * own failure — see `suppressedCauseCount`.
   */
  suppressedCauses?: number | null;
}

/** The key `owners` is read with. Two tests can share a name across files. */
export function failureOwnerKey(test: { name: string; filePath: string }): string {
  return `${test.filePath}::${test.name}`;
}

/**
 * What a finished run says in chat.
 *
 * Four questions in the order they get asked — what happened, where, what
 * broke, and where do I look — and the last line is always the link. A gate
 * that blocked is stated in its own line even when tests also failed: a run
 * can be red because of the gate alone (a flake rate or a p95 rule crossing
 * its threshold with every test green), and that run used to announce itself
 * as "✅ all 41 passed" while the deploy it blocked sat waiting.
 */
export function renderRunAlert(run: RunAlertInput): string {
  const blocked = blockingGateRules(run.gateResult);
  // `isFailing`, not an inline `FAILED || TIMED_OUT`: the list this builds and
  // the set `routeFailuresToOwners` writes owners onto have to be the same set,
  // or the owner of a FLAKY failure is recorded and never told.
  const failures = run.results.filter((r) => isFailing(r.status));

  const counts = [
    run.failedCount > 0 ? `${run.failedCount} failed` : null,
    `${run.passedCount} passed`,
    run.flakyCount > 0 ? `${run.flakyCount} flaky` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const headline =
    run.failedCount > 0
      ? `❌ QAAI — ${counts}`
      : blocked.length > 0
        ? `⛔ QAAI — the quality gate blocked this run (${counts})`
        : `✅ QAAI — ${counts}`;

  const where = [run.project?.name, run.environment?.name].filter(Boolean).join(' · ');
  const lines = [headline];
  if (where) lines.push(where);

  // Named even when tests also failed: "which gate" is the difference between
  // "someone broke checkout" and "we are one flaky test over the threshold".
  for (const rule of blocked) lines.push(`⛔ ${rule}`);

  /*
   * The owner goes on the LINE, not in a footer. The person reading this is
   * deciding whether it is theirs, and a name three lines further down is a
   * name they have already scrolled past.
   */
  const routing = run.owners && run.owners.size > 0;
  for (const failure of failures.slice(0, MAX_FAILURES_IN_CHAT)) {
    const key = failureOwnerKey(failure.test);
    /*
     * Three answers, not two. `has` is the question "did anything look at
     * this?" — and only when the answer is yes may the message say "unowned",
     * which is a claim about the project's rules. A failure past the routing
     * cap says NOT ROUTED instead, because the alternative is a cap reported
     * as an ownership fact.
     */
    const who = !routing
      ? ''
      : run.owners!.has(key)
        ? ` — ${run.owners!.get(key) ?? 'unowned'}`
        : ' — not routed';
    // FLAKY is in `FAILING_STATUSES` and is tagged rather than listed bare:
    // the counts line reports flakes in their own column (`tallyResult` keeps
    // them out of `failedCount`), so an untagged bullet would look like a
    // failure the headline forgot to count.
    const flaky = failure.status === 'FLAKY' ? ' (flaky)' : '';
    lines.push(`• ${failure.test.name} — ${failure.test.filePath}${flaky}${who}`);
  }
  if (failures.length > MAX_FAILURES_IN_CHAT) {
    lines.push(`• …and ${failures.length - MAX_FAILURES_IN_CHAT} more`);
  }

  // Said out loud, once, under the list it explains.
  if (routing && run.ownersCapped) {
    lines.push(
      `⚠️ only the first ${MAX_FAILURES_ROUTED} failures were routed to an owner; the rest are marked “not routed”, which is not the same as unowned`,
    );
  }

  /*
   * A quiet run that is quiet BECAUSE it was muted says so. Only ever a
   * positive statement: null (not read) and 0 (nothing muted) are both
   * silence, so this line never reports a number that was not measured.
   */
  const suppressed = run.suppressedCauses;
  if (typeof suppressed === 'number' && suppressed > 0) {
    lines.push(
      `🔇 ${suppressed} cause${suppressed === 1 ? '' : 's'} muted — nothing was reported about ${suppressed === 1 ? 'it' : 'them'}`,
    );
  }

  lines.push(runLink(run.id));
  return lines.join('\n');
}

export interface MonitorAlertInput {
  name: string;
  streak: number;
  runId: string;
  /** The failing check itself. Null when the run could not be read — see below. */
  run: {
    failedCount: number;
    passedCount: number;
    environment: { name: string } | null;
    results: Array<{ status: string; test: { name: string; filePath: string } }>;
  } | null;
}

/**
 * What a monitor crossing its threshold says in chat.
 *
 * This is the message most likely to be read half-asleep, so it leads with the
 * monitor, the streak and the environment — "which of our things is down, and
 * where" — before it gets to which tests. `run` is nullable and the message
 * degrades rather than failing: the page is the point, and a run row that
 * cannot be read (retention swept it, the read failed) must cost detail, never
 * the alert.
 */
export function renderMonitorAlert(alert: MonitorAlertInput): string {
  const where = alert.run?.environment?.name;
  const lines = [
    `🔴 ${alert.name} is down — ${alert.streak} failed check${alert.streak === 1 ? '' : 's'} in a row`,
  ];

  if (alert.run) {
    const total = alert.run.failedCount + alert.run.passedCount;
    lines.push(
      `${where ? `${where} · ` : ''}${alert.run.failedCount} of ${total} test${total === 1 ? '' : 's'} failing`,
    );
    /*
     * HARD failures only, and the one place in this file that is deliberately
     * NOT `isFailing`. The line above it reports `run.failedCount`, which
     * `tallyResult` (packages/runner/src/gates.ts) counts FLAKY into its own
     * column out of — so a flaky test listed here would print one more bullet
     * than the number directly above it. Nothing is routed from a monitor page,
     * so no owner is lost by narrowing; the mismatch is the only thing at stake.
     */
    const failures = alert.run.results.filter(
      (r) => r.status === 'FAILED' || r.status === 'TIMED_OUT',
    );
    for (const failure of failures.slice(0, MAX_FAILURES_IN_CHAT)) {
      lines.push(`• ${failure.test.name} — ${failure.test.filePath}`);
    }
    if (failures.length > MAX_FAILURES_IN_CHAT) {
      lines.push(`• …and ${failures.length - MAX_FAILURES_IN_CHAT} more`);
    }
  }

  if (alert.runId) lines.push(runLink(alert.runId));
  return lines.join('\n');
}

/**
 * Chat and webhook delivery (§7).
 *
 * Slack, Teams and Discord all accept an incoming-webhook POST, so one sender
 * covers all three — the payload shape differs only in which key holds the
 * text. A generic WEBHOOK is signed with HMAC-SHA256 so the receiver can verify
 * it came from QAAI, the same contract QAAI itself demands of GitHub.
 *
 * This processor no longer POSTs inline. The fan-out writes one PENDING
 * WebhookDelivery row per destination and enqueues one delivery job per row
 * (enqueueDelivery in ../queues.ts); processDelivery below performs the POST
 * and records EVERY attempt on the row — attempts, response status, last
 * error. A failed send is retried by the queue with exponential backoff, and
 * the attempt that exhausts the retries leaves the row FAILED holding the
 * final error. That FAILED row is the dead letter — there is no separate
 * dead-letter store — and it is readable through the deliveries endpoint
 * (GET /integrations/:id/deliveries), because a notification that silently
 * failed is indistinguishable from one that was never sent, and a customer
 * asking "why didn't I get paged" deserves an answer.
 *
 * The transport itself carries digest.ts's delivery hardening, ported rather
 * than reinvented: a bounded request, 3xx treated as an error instead of a
 * hop, chat hosts pinned per provider, and error strings that never echo the
 * URL or what the runtime said — a webhook URL IS the credential.
 */

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Fan a message out: one WebhookDelivery row and one queued delivery job per
 * enabled destination that WANTS the event. Sends nothing itself.
 *
 * `wants` is the org-scoped notification preference (§7), read from the same
 * `Integration.config.notify` the API writes: which events reach which
 * integration. Filtered here at fan-out so an opted-out channel gets no row at
 * all — "you asked not to hear this" is a preference honoured, not a failed
 * delivery, and it does not belong in the delivery log.
 *
 * `jobKey` is the BullMQ id of the notify job, stable across that job's
 * retries. The row id is derived from it and the write is an upsert, so a
 * retried notify job (the PR-comment half below can throw) re-claims the same
 * rows and — via enqueueDelivery's jobId — the same delivery jobs, instead of
 * paging every channel a second time.
 */
async function fanOutToChat(
  orgId: string,
  event: string,
  text: string,
  jobKey: string,
  wants: (prefs: NotifyPrefs) => boolean = () => true,
): Promise<void> {
  const integrations = await prisma.integration.findMany({
    where: { orgId, enabled: true, kind: { in: ['SLACK', 'MSTEAMS', 'DISCORD', 'WEBHOOK'] } },
    select: { id: true, kind: true, config: true, configEnc: true },
  });

  for (const integration of integrations) {
    if (!wants(notifyPrefsOf(integration.config))) continue;

    /*
     * The URL is sealed in the vault (it IS the credential — see the API's
     * chat CRUD), so the only static check left at fan-out is that a
     * credential exists at all. Everything about the URL itself — parse,
     * https, pinned host — is checked by the delivery job after unsealing.
     */
    const problem = integration.configEnc
      ? null
      : 'This integration has no webhook URL stored.';

    const deliveryId = `wd-${jobKey}-${integration.id}`;
    try {
      await prisma.webhookDelivery.upsert({
        where: { id: deliveryId },
        create: {
          id: deliveryId,
          orgId,
          integrationId: integration.id,
          event,
          payload: { text } as object,
          signature: '',
          /*
           * An unusable destination dead-letters immediately, with the reason
           * and zero attempts — digest.ts only logs its skips, but this
           * processor's contract is that every destination that did not hear
           * about a red run has a row saying why. Retrying cannot help a URL
           * that fails static checks.
           */
          status: problem ? 'FAILED' : 'PENDING',
          attempts: 0,
          lastError: problem,
        },
        // A notify retry must not reset a row its delivery job is already
        // recording into.
        update: {},
      });
    } catch (err) {
      // A failure to RECORD one destination must not cost the others theirs.
      logger.error({ err, integrationId: integration.id }, 'could not record a delivery row');
      continue;
    }

    if (problem) {
      logger.warn({ integrationId: integration.id, kind: integration.kind }, problem);
      continue;
    }

    await enqueueDelivery({ orgId, deliveryId });
  }
}

// ─── Routing a failure to its owner ──────────────────────────────────────────

/**
 * Write the owner onto every failing verdict in this run, and return the labels
 * for the alert.
 *
 * WHY HERE
 *
 * Ownership resolved in exactly two places before this, and both were READS:
 * the digest's labels and GET /team/ownership/resolve. Nothing was ever
 * written onto the failure itself, so a red run arrived in a queue that belongs
 * to everybody — which in practice means nobody, until somebody who happens to
 * be looking recognises a test name. This is the moment the run becomes news,
 * so it is the moment the news gets an addressee.
 *
 * WHY IT CANNOT BE ALLOWED TO THROW
 *
 * Same rule as the monitor page's enrichment below: a page lost to a failed
 * JOIN is a far worse outcome than a terse one. Every failure in here degrades
 * to "no labels, nothing written" and the alert still goes out.
 *
 * WHY IT ONLY WRITES ONCE
 *
 * `ownerState IS NULL` means nothing has tried to route this verdict yet, and
 * that is the only state this function writes over. A notify job is retried,
 * and re-stamping `assignedAt` on every retry would make the column a record of
 * how many times the queue hiccuped rather than of when the failure was routed.
 */
export interface FailureRouting {
  /** Owner label per failure. A key is present only if it was ROUTED. */
  labels: Map<string, string | null>;
  /**
   * The run had more failing results than `MAX_FAILURES_ROUTED`, so `labels`
   * covers a page of them. Returned rather than logged: the alert has to say
   * it, or the un-routed remainder reads as unowned.
   */
  capped: boolean;
}

async function routeFailuresToOwners(
  orgId: string,
  run: { id: string; projectId: string },
): Promise<FailureRouting> {
  const labels = new Map<string, string | null>();

  const rules = (await prisma.ownershipRule.findMany({
    where: { orgId, projectId: run.projectId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    take: 500,
    select: OWNERSHIP_RULE_SELECT,
  })) as OwnershipRuleInput[];

  const results = await prisma.testResult.findMany({
    where: { orgId, runId: run.id, status: { in: [...FAILING_STATUSES] } },
    /*
     * ORDERED, and this is not cosmetic. With a bare `take` past the cap,
     * WHICH failures got an owner written onto their verdict was whatever
     * Postgres happened to return — different on a replica, different after a
     * VACUUM, different between the alert and the ticket. Oldest first, broken
     * by id because `createdAt` ties on a parallel suite, so the routed set is
     * the same set every time the job is retried.
     */
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_FAILURES_ROUTED,
    select: {
      id: true,
      test: { select: { id: true, name: true, filePath: true, suiteId: true, feature: true } },
      verdict: { select: { id: true, ownerState: true } },
    },
  });
  const capped = results.length >= MAX_FAILURES_ROUTED;
  if (results.length === 0) return { labels, capped };

  /*
   * No rules at all is still an answer, and it is written as one: NO_RULES on
   * every verdict in a single statement, so a reader can tell "we looked and
   * nobody has assigned anything" from "nothing has tried to route this". One
   * updateMany rather than N updates — the assignment is identical for every
   * row, and an install that never configured ownership is the common case.
   */
  if (rules.length === 0) {
    const assignment = assignOwner(
      { id: 'none', filePath: '', suiteId: null, feature: null },
      [],
    );
    const unrouted = results
      .filter((row) => row.verdict && row.verdict.ownerState === null)
      .map((row) => row.verdict!.id);
    if (unrouted.length > 0) {
      await prisma.triageVerdict.updateMany({
        where: { id: { in: unrouted } },
        data: verdictOwnerColumns(assignment),
      });
    }
    // Deliberately no labels: the alert says nothing about ownership when
    // nobody has opted in. See `RunAlertInput.owners`.
    return { labels, capped };
  }

  const assignments = results.map((row) => ({
    row,
    assignment: assignOwner(
      {
        id: row.test.id,
        filePath: row.test.filePath,
        suiteId: row.test.suiteId,
        feature: row.test.feature,
      },
      rules,
    ),
  }));

  const userIds = new Set<string>();
  const teamIds = new Set<string>();
  for (const { assignment } of assignments) {
    const owner = assignment.owner;
    if (!owner) continue;
    if (owner.kind === 'USER') userIds.add(owner.userId);
    else teamIds.add(owner.teamId);
  }

  const [users, teams] = await Promise.all([
    userIds.size
      ? prisma.user.findMany({
          where: { id: { in: [...userIds] } },
          select: { id: true, name: true, email: true },
        })
      : Promise.resolve([]),
    teamIds.size
      ? prisma.team.findMany({
          where: { orgId, id: { in: [...teamIds] } },
          select: { id: true, slug: true },
        })
      : Promise.resolve([]),
  ]);
  const directory: OwnerDirectory = {
    users: new Map(users.map((user) => [user.id, user])),
    teams: new Map(teams.map((team) => [team.id, team])),
  };

  const now = new Date();
  const writes: Array<{ id: string; data: ReturnType<typeof verdictOwnerColumns> }> = [];
  for (const { row, assignment } of assignments) {
    labels.set(
      failureOwnerKey(row.test),
      assignment.owner ? ownerLabel(assignment.owner, directory) : null,
    );
    if (row.verdict && row.verdict.ownerState === null) {
      writes.push({ id: row.verdict.id, data: verdictOwnerColumns(assignment, now) });
    }
  }

  // One statement per distinct assignment would be the clever version; this is
  // the honest one. A run's failures rarely number more than a handful, and the
  // cap above bounds the worst case.
  for (const write of writes) {
    await prisma.triageVerdict.update({ where: { id: write.id }, data: write.data });
  }

  const unusable = new Map<string, string>();
  for (const { assignment } of assignments) {
    for (const skipped of assignment.unusable) unusable.set(skipped.ruleId, skipped.reason);
  }
  if (unusable.size > 0) {
    // Logged rather than dropped: routing that has silently stopped looks
    // exactly like a suite nobody has assigned, and this is the only place that
    // notices.
    logger.warn(
      { runId: run.id, rules: [...unusable.keys()] },
      'ownership rules could not be evaluated; those failures are being routed as unowned',
    );
  }

  const unassignable = results.filter((row) => !row.verdict).length;
  if (unassignable > 0) {
    // Triage may still be in flight — the gates and this notification do not
    // wait for it. Said out loud, because "assigned" about a failure with no
    // verdict row to carry an assignee would be the reassuring lie.
    logger.info(
      { runId: run.id, unassignable },
      'some failures have no triage verdict yet, so nothing could carry their owner',
    );
  }

  if (capped) {
    logger.warn(
      { runId: run.id, routed: results.length, limit: MAX_FAILURES_ROUTED },
      'this run had more failures than the routing cap; the rest carry no owner and the alert says so',
    );
  }

  return { labels, capped };
}

/**
 * How many of this run's causes were MUTED, so nothing was said about them.
 *
 * A quiet run and a run that was silenced look identical in chat, and the
 * second one is the dangerous state: a mute set six weeks ago by somebody who
 * has left is still in force, and the page it suppresses is the page nobody
 * knows is missing. `RunFailureCluster.suppressed` is set in the run that
 * executed under the mute, so the fact is already recorded per run — it was
 * simply never on the way out.
 *
 * NULL, never 0, when the read fails. Zero is a measurement ("nothing was
 * muted") and this function must not be able to manufacture one.
 *
 * EXPORTED, and tested directly, because that distinction is invisible in the
 * chat message: the suppression line is a positive statement only, so null and
 * 0 both render as silence and a `return 0` in the catch below would go
 * unnoticed by every assertion on the rendered text. The next reader of this
 * number — a surface, a metric, a digest — will not render it the same way, and
 * the one that divides by it needs to know the difference between "none" and
 * "unknown".
 */
export async function suppressedCauseCount(
  orgId: string,
  runId: string,
): Promise<number | null> {
  try {
    return await prisma.runFailureCluster.count({ where: { orgId, runId, suppressed: true } });
  } catch (err) {
    logger.warn(
      { err, runId },
      'could not read how many causes were muted for this run; the alert will claim nothing about it',
    );
    return null;
  }
}

/** The attempt this call IS, as BullMQ frames it: 1-based, out of how many. */
export interface DeliveryAttempt {
  attempt: number;
  maxAttempts: number;
}

/**
 * One POST to one destination, recorded on its WebhookDelivery row.
 *
 * Reads everything fresh — the row for the payload, the Integration for the
 * URL and the secret — because the job may run minutes after it was enqueued
 * and an admin who fixed a broken webhook URL mid-retry should get the retry
 * delivered to the fixed URL (the same "carry ids, re-read state" rule every
 * queue payload in this repo follows).
 *
 * A failure with retries remaining records the attempt and re-throws, so the
 * QUEUE schedules the retry with backoff — no in-process sleeping, no worker
 * slot held through the wait, nothing lost to a restart. The LAST attempt
 * records status FAILED with the final error and returns instead of throwing:
 * the dead letter is the row itself — not BullMQ's failed set — kept where the
 * customer can read it, through GET /integrations/:id/deliveries.
 */
export async function processDelivery(job: DeliveryJob, meta: DeliveryAttempt): Promise<void> {
  const delivery = await prisma.webhookDelivery.findFirst({
    where: { id: job.deliveryId, orgId: job.orgId },
    select: { id: true, integrationId: true, status: true, payload: true, event: true },
  });

  // Gone — deleting an integration cascades its rows. Nothing to record into,
  // so nothing to retry for.
  if (!delivery) {
    logger.warn({ deliveryId: job.deliveryId }, 'delivery row is gone; dropping the job');
    return;
  }

  // A redelivered job after a landed POST must return, never re-send.
  if (delivery.status === 'SENT') return;

  const finalAttempt = meta.attempt >= meta.maxAttempts;

  /*
   * Every attempt lands on the row, success or failure. Non-final failures
   * stay PENDING — retries remain — and the final one flips the row to FAILED
   * with the error that killed it. Failing to RECORD a failed attempt is
   * logged rather than thrown: the real error is the delivery's, and it is
   * about to be re-thrown anyway.
   */
  const recordFailure = async (
    error: string,
    responseStatus: number | null,
    signature: string,
  ): Promise<void> => {
    await prisma.webhookDelivery
      .update({
        where: { id: delivery.id },
        data: {
          attempts: { increment: 1 },
          status: finalAttempt ? 'FAILED' : 'PENDING',
          responseStatus,
          lastError: error,
          signature,
        },
      })
      .catch((err) =>
        logger.error({ err, deliveryId: delivery.id }, 'could not record the failed attempt'),
      );
    if (finalAttempt) {
      logger.error(
        { deliveryId: delivery.id, integrationId: delivery.integrationId, error },
        'delivery dead-lettered after its last attempt',
      );
    }
  };

  const integration = await prisma.integration.findFirst({
    where: { id: delivery.integrationId, orgId: job.orgId },
    select: { id: true, kind: true, config: true, configEnc: true, enabled: true },
  });

  if (!integration || !integration.enabled) {
    // An admin switched it off (or deleted it) while retries were in flight.
    // More retries cannot be what they meant: dead-letter now, with the reason.
    await prisma.webhookDelivery
      .update({
        where: { id: delivery.id },
        data: {
          status: 'FAILED',
          lastError: 'the integration was disabled or removed before this delivery landed',
        },
      })
      .catch((err) =>
        logger.error({ err, deliveryId: delivery.id }, 'could not record the failed attempt'),
      );
    return;
  }

  const config = (integration.config ?? {}) as { keyVersion?: number };

  /*
   * Unseal the credential envelope: the URL, plus the WEBHOOK signing secret
   * when one exists. One envelope on purpose — the URL and the secret that
   * signs payloads to it can never rotate apart, and "URL readable but secret
   * not" is a state that cannot exist. An unreadable envelope must not send
   * anything; it IS retried rather than dead-lettered at once, because
   * re-saving the integration mints a fresh seal and the next attempt (which
   * re-reads everything) uses it.
   */
  let credentials: ChatCredentials;
  try {
    if (!integration.configEnc) throw new Error('no sealed credentials');
    credentials = decodeChatCredentials(
      openSecret(
        integration.configEnc,
        config.keyVersion ?? 1,
        job.orgId,
        integrationAad(integration.id),
      ),
    );
  } catch {
    const error = 'could not unseal the webhook credentials; nothing was sent';
    logger.error({ integrationId: integration.id }, error);
    await recordFailure(error, null, '');
    if (finalAttempt) return;
    throw new Error(error);
  }

  /*
   * Destination rules are digest.ts's, via the shared checkChatDestination,
   * with one deliberate difference: a generic WEBHOOK is delivered, not
   * skipped. Posting to a customer-chosen host is this processor's §7
   * contract, and the HMAC signature is what makes that contract honourable —
   * but it must be https on a public name, because a signature does not help
   * anyone who broadcasts the body in clear or aims it inside the cluster.
   * Chat providers stay pinned to their real webhook hosts: the text being
   * posted describes a customer's failing tests, so an integration may choose
   * its PATH (that is the webhook token) and never its host. Checked HERE, on
   * the just-unsealed URL, not only at write time — recorded and retried like
   * any failure, so a config fixed mid-retry still lands and one that stays
   * broken burns down to FAILED.
   */
  const destination = checkChatDestination(integration.kind, credentials.url);
  if (!destination.ok) {
    await recordFailure(destination.reason, null, '');
    if (finalAttempt) return;
    throw new Error(destination.reason);
  }

  const text = String((delivery.payload as { text?: unknown } | null)?.text ?? '');

  // Teams wants `text`, Discord wants `content`, Slack accepts `text`; a
  // generic WEBHOOK gets the event name alongside so a receiver can route
  // without parsing prose. Same helper the API's test endpoint uses, so a test
  // send proves the exact body shape a real one will have.
  const body = chatPayload(integration.kind, delivery.event, text);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'qaai',
  };

  // A generic webhook gets a signature so the receiver can trust it.
  let signature = '';
  if (integration.kind === 'WEBHOOK' && credentials.secret) {
    signature = `sha256=${createHmac('sha256', credentials.secret).update(body).digest('hex')}`;
    headers['x-qaai-signature-256'] = signature;
  }

  let status: number | null = null;
  let error: string | null = null;
  try {
    const response = await fetch(destination.url, {
      method: 'POST',
      headers,
      body,
      // A 3xx is an error, not a hop. Following one would re-post the body —
      // and the webhook token in the URL — to whatever Location named.
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = response.status;
    if (response.status >= 300 && response.status < 400) {
      error = 'redirected; not followed';
    } else if (!response.ok) {
      error = `HTTP ${response.status}`;
    }
  } catch (err) {
    // Deliberately not err.message: a fetch failure embeds the URL, and the
    // URL is the credential. The shared classifier names the failure CLASS
    // (refused / DNS / TLS / reset) from the wrapped syscall code instead —
    // debuggable without the echo.
    error = describeWebhookFailure(err, REQUEST_TIMEOUT_MS / 1000);
  }

  if (error) {
    logger.warn(
      {
        integrationId: integration.id,
        kind: integration.kind,
        error,
        attempt: meta.attempt,
        of: meta.maxAttempts,
      },
      'delivery attempt failed',
    );
    await recordFailure(error, status, signature);
    if (finalAttempt) return;
    throw new Error(error);
  }

  // Landed. If RECORDING that fails, do not throw: a retry would re-send a
  // message that was already delivered, and a duplicate page is worse than a
  // PENDING row about a delivery the log says landed.
  await prisma.webhookDelivery
    .update({
      where: { id: delivery.id },
      data: {
        attempts: { increment: 1 },
        status: 'SENT',
        responseStatus: status,
        deliveredAt: new Date(),
        lastError: null,
        signature,
      },
    })
    .catch((err) =>
      logger.error({ err, deliveryId: delivery.id }, 'delivered, but could not record it'),
    );
}

export async function processNotify(job: NotifyJob, jobKey?: string): Promise<void> {
  const { orgId, event, payload } = job;

  // The fan-out derives delivery-row ids from this, so it must be stable
  // across THIS job's retries — index.ts passes the BullMQ job id. Only a
  // direct call (tests) arrives without one.
  const key = jobKey || randomUUID();

  // A monitor crossing its threshold pages chat directly — there is no PR to
  // comment on, and this is the alert the on-call person actually needs. It
  // deliberately ignores the `runFinished` preference: that preference is
  // about run REPORTS, and a monitor page is not one. Every enabled chat
  // integration hears it.
  if (event === 'monitor.down') {
    const name = String(payload.name ?? 'A monitor');
    const streak = Number(payload.streak ?? 0);
    const runId = String(payload.runId ?? '');

    /*
     * Enrichment, not a precondition. The sweep hands over the monitor's name,
     * its streak and the run id; the environment, the counts and the tests
     * that failed live on the run. Reading them is what turns "a monitor is
     * down" into an alert someone can act on — but a page that failed to send
     * because a JOIN failed is a far worse outcome than a terse one, so this
     * read is allowed to come back empty and the renderer degrades.
     */
    let run: MonitorAlertInput['run'] = null;
    try {
      run = await prisma.run.findFirst({
        where: { id: runId, orgId },
        select: {
          failedCount: true,
          passedCount: true,
          environment: { select: { name: true } },
          results: { select: { status: true, test: { select: { name: true, filePath: true } } } },
        },
      });
    } catch (err) {
      logger.warn({ err, runId }, 'could not read the run behind a monitor page; paging anyway');
    }

    await fanOutToChat(orgId, event, renderMonitorAlert({ name, streak, runId, run }), key);
    return;
  }

  if (event !== 'run.finished') return;

  const runId = String(payload.runId ?? '');
  if (!runId) return;

  const run = await prisma.run.findFirst({
    where: { id: runId, orgId },
    select: {
      id: true,
      status: true,
      prNumber: true,
      passedCount: true,
      failedCount: true,
      flakyCount: true,
      gateResult: true,
      projectId: true,
      // For the chat alert: "3 failed" is a fact, "Storefront · staging, 3
      // failed" is an alert someone can triage without opening anything.
      project: { select: { name: true } },
      environment: { select: { name: true } },
      results: {
        select: {
          status: true,
          errorMessage: true,
          test: { select: { name: true, filePath: true } },
          verdict: { select: { verdict: true, confidence: true, explanation: true } },
        },
      },
    },
  });

  if (!run) return;

  /*
   * Chat gets told about any failing run, PR or not — that is the point of a
   * nightly schedule. Which integrations hear it is the org-scoped preference
   * (§7): `runFinished: 'failures'` (the default) and `'all'` both hear a red
   * run, only `'all'` hears a green one, and `'off'` hears neither. The
   * filter is per integration, inside the fan-out, so one org can keep a
   * loud #qa-firehose and a failures-only #eng in the same breath.
   *
   * What counts as "a red run" is deliberately NOT `failedCount > 0`.
   *
   * A quality gate can block a run whose tests all passed — MAX_FLAKE_RATE and
   * MAX_P95_LATENCY_MS are rules about the shape of the run, not about any one
   * test — and that run is exactly the one someone needs to hear about, because
   * it is the one holding up a merge. Counting only failures meant such a run
   * announced itself as "✅ all 41 passed" and reached only the channels that
   * asked for EVERY run; the blocked deploy was silent in the failures-only
   * channel that exists to catch it. `off` still hears nothing: that is a
   * channel saying it does not want run reports at all.
   */
  /*
   * Route before announcing. The alert then names the owner beside each
   * failure, and the verdict carries the assignee for whoever opens it later —
   * one resolution, two destinations, which is the only way the chat message
   * and the triage screen can agree about whose failure this is.
   *
   * Never allowed to cost the page: a resolution that throws degrades to an
   * alert with no owners on it, exactly as the monitor enrichment degrades.
   */
  const routing = await routeFailuresToOwners(orgId, run).catch((err) => {
    logger.warn({ err, runId: run.id }, 'could not route this run to owners; alerting anyway');
    // An empty map with `capped: false` is the honest degradation: no labels at
    // all, so the renderer says nothing about ownership rather than reporting
    // every failure as unowned on the strength of a read that failed.
    return { labels: new Map<string, string | null>(), capped: false } satisfies FailureRouting;
  });

  const gateBlocked = blockingGateRules(run.gateResult).length > 0;
  const newsworthy = run.failedCount > 0 || gateBlocked;

  /*
   * Only for a run anyone is being told about, and only because a suppressed
   * cause implies a failing result (a cause exists only where results failed),
   * so a run with `failedCount: 0` cannot have one to report. Left UNREAD
   * rather than read-and-zeroed for a green run: `undefined` and `null` both
   * render as silence, and neither claims a measurement this call did not make.
   *
   * Same rule as the routing above otherwise: allowed to come back empty, never
   * allowed to cost the page.
   */
  const suppressedCauses = newsworthy ? await suppressedCauseCount(orgId, run.id) : undefined;
  await fanOutToChat(
    orgId,
    event,
    renderRunAlert({
      ...run,
      owners: routing.labels,
      ownersCapped: routing.capped,
      suppressedCauses,
    }),
    key,
    (prefs) => wantsRunFinished(prefs, newsworthy),
  );

  /*
   * The PR comment used to be posted from here, and is not any more.
   *
   * This path POSTed a NEW comment on every finished run, so a branch with
   * eight pushes ended with eight QAAI comments and a reviewer scrolling past
   * seven of them — the reason people mute bots. `syncPrComment` in
   * processors/checks.ts now owns it: one comment per pull request, found by a
   * stable marker and EDITED in place, beside the check run it belongs with.
   *
   * Deleted rather than left behind a flag, because both were live at once and
   * every PR run was getting two comments — one that updated and one that did
   * not.
   */
}
