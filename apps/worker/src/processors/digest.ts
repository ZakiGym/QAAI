/**
 * The nightly digest (§7) — "here is what your suite did overnight".
 *
 * Schedules already decide when to run and integrations already decide where to
 * send, and between them there was nothing that summarised. A team with a
 * nightly suite therefore got one chat message per failing run, at 3am, with a
 * count in it — which is either ignored or, worse, skimmed. The thing a person
 * actually needs at 9am is one message that answers three questions in order:
 *
 *   what broke that was not broken yesterday   (new failures)
 *   what is unreliable                          (flakes)
 *   what got better                             (fixed)
 *
 * That order is the whole design. New failures first because they are the only
 * part that is news; fixed last because it is the part that is nice to know.
 *
 * ── A digest with nothing to say is not sent ────────────────────────────────
 *
 * A daily "all clear" is the fastest way to teach people that this channel can
 * be ignored, and once that is learned the message that matters is ignored too.
 * So silence is a feature — but silence is also how a broken pipeline hides, so
 * it is bounded very deliberately:
 *
 *   • Every decision to stay quiet is logged with the counts that produced it.
 *     A suppression nobody can audit is a suppression nobody should trust.
 *   • "No runs at all" is NOT nothing to say. If a schedule was due and the
 *     window contains no run, the digest says so — a suite that silently stopped
 *     running is the single most dangerous state this product has, because the
 *     dashboard stays green while nothing is being tested.
 *   • Anything unknown is reported rather than dropped. Where the history needed
 *     to call a failure "new" is missing, it is reported as new: the failure
 *     mode of this file must be saying too much, never too little.
 *
 * ── Delivery ────────────────────────────────────────────────────────────────
 *
 * Same destinations as `notify.ts`: the org's enabled chat integrations, one
 * POST each, one WebhookDelivery row per attempt so "why didn't I get the
 * digest" has an answer. Two deliberate differences from that processor, both
 * narrowing:
 *
 *   1. Every provider's host is PINNED (see `webhookHost`). An integration whose
 *      URL points somewhere else is skipped with a sentence saying so, rather
 *      than posting a summary of a customer's test suite to whatever host was in
 *      the config row.
 *   2. Generic WEBHOOK integrations are skipped, not signed and sent. Signing
 *      means unsealing a secret and posting to a host that cannot be pinned, and
 *      that is a security decision worth making on purpose rather than
 *      inheriting. The skip says what to do instead.
 */

import { CronExpressionParser } from 'cron-parser';
import { logger, prisma } from '../context.js';
// Pure modules from the API workspace — types and functions, no Prisma and no
// Express — imported rather than copied for the same reason bisect.ts is. The
// alternative is a second implementation of "is this a real failure", and two
// answers to that question is how the gate and the digest come to disagree.
import { isRealFailure } from '../../../api/src/lib/run-selection.js';
import { resolveOwnershipFor } from '../../../api/src/lib/ownership.js';
import type { OwnershipRuleInput } from '../../../api/src/lib/ownership.js';

/** How far back a first-ever digest looks, and the ceiling on catching up. */
const DEFAULT_WINDOW_MS = 24 * 60 * 60_000;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * Result rows read per digest.
 *
 * A cap rather than a full scan because one project's 4000-test nightly must not
 * hold the tick open for everyone else's. Hitting it is reported in the message
 * itself — a truncated digest that does not say it was truncated is a digest
 * that lies about a quiet suite.
 */
const MAX_RESULTS = 5_000;

/** Lines per section in the message. Past this it stops being readable. */
const MAX_LISTED = 8;

/** Chat platforms cap a message; stay well under the smallest of them. */
const MAX_MESSAGE_CHARS = 3_500;

const REQUEST_TIMEOUT_MS = 15_000;

// ─── What a digest contains ──────────────────────────────────────────────────

export interface DigestItem {
  testId: string;
  name: string;
  filePath: string;
  /** The run this was last seen in, so the message can link to the evidence. */
  runId: string;
  /** Triage's call, when triage has spoken. Null is normal and says so. */
  verdict: string | null;
  /** "@payments", "Dana Klein", or null — an unowned test is a normal state. */
  owner: string | null;
  /** Flakes only: how many times it needed a retry inside the window. */
  retries?: number;
}

export interface Digest {
  projectId: string;
  projectName: string;
  since: Date;
  until: Date;
  runs: { total: number; red: number };
  newFailures: DigestItem[];
  flakes: DigestItem[];
  fixed: DigestItem[];
  /** Failing before the window and still failing. A count, not a list — not news. */
  stillFailing: number;
  /** Schedules that were due inside the window and produced no run at all. */
  silentSchedules: string[];
  /** How many of the new failures reached nobody. */
  unowned: number;
  truncated: boolean;
}

/**
 * The suppression rule, in one function so it can be read and argued with.
 *
 * Note what is NOT here: the number of runs, and whether they were green. A
 * window full of passing runs is exactly the case that must stay quiet.
 */
export function hasSomethingToSay(digest: Digest): boolean {
  return (
    digest.newFailures.length > 0 ||
    digest.flakes.length > 0 ||
    digest.fixed.length > 0 ||
    digest.silentSchedules.length > 0
  );
}

// ─── Building one ────────────────────────────────────────────────────────────

interface ResultRow {
  runId: string;
  testId: string;
  status: string;
  retriedAndPassed: boolean;
  createdAt: Date;
  test: {
    id: string;
    name: string;
    filePath: string;
    suiteId: string | null;
    feature: string | null;
    quarantined: boolean;
  };
  verdict: { verdict: string; overriddenTo: string | null } | null;
}

function failed(row: ResultRow): boolean {
  return isRealFailure({
    status: row.status,
    retriedAndPassed: row.retriedAndPassed,
    quarantined: row.test.quarantined,
  });
}

function flaked(row: ResultRow): boolean {
  return row.status === 'FLAKY' || row.retriedAndPassed;
}

/** A clean pass: not a retry that happened to succeed (§5). */
function passed(row: ResultRow): boolean {
  return row.status === 'PASSED' && !row.retriedAndPassed;
}

export async function collectDigest(
  subscription: { orgId: string; projectId: string },
  since: Date,
  until: Date,
): Promise<Digest | null> {
  const { orgId, projectId } = subscription;

  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId },
    select: { id: true, name: true, archivedAt: true },
  });
  // An archived project has no news by definition, and a deleted one has no
  // subscription to honour.
  if (!project || project.archivedAt) return null;

  const runs = await prisma.run.findMany({
    where: { orgId, projectId, finishedAt: { gt: since, lte: until } },
    select: { id: true, status: true, finishedAt: true },
  });

  const results = (await prisma.testResult.findMany({
    where: { orgId, runId: { in: runs.map((run) => run.id) } },
    orderBy: { createdAt: 'asc' },
    take: MAX_RESULTS,
    select: {
      runId: true,
      testId: true,
      status: true,
      retriedAndPassed: true,
      createdAt: true,
      test: {
        select: {
          id: true,
          name: true,
          filePath: true,
          suiteId: true,
          feature: true,
          quarantined: true,
        },
      },
      verdict: { select: { verdict: true, overriddenTo: true } },
    },
  })) as ResultRow[];

  // The last thing each test did in the window. Ordered ascending above, so the
  // last write wins — which is what "how did it end up" means.
  const latest = new Map<string, ResultRow>();
  const retriesByTest = new Map<string, number>();
  for (const row of results) {
    if (row.status !== 'SKIPPED') latest.set(row.testId, row);
    if (flaked(row)) retriesByTest.set(row.testId, (retriesByTest.get(row.testId) ?? 0) + 1);
  }

  const failingNow = [...latest.values()].filter(failed);
  const passingNow = [...latest.values()].filter(passed);

  const priors = await priorOutcomes(
    orgId,
    [...failingNow, ...passingNow].map((row) => row.testId),
    since,
  );

  /*
   * Was this failing before the window?
   *
   * `undefined` means the lookup could not see far enough back (see
   * `priorOutcomes`), and it is deliberately treated as "was not failing", which
   * files the test under NEW. That is the direction this whole file errs in: a
   * failure reported as newer than it is costs someone a second look, while one
   * quietly folded into a count nobody reads costs a release.
   */
  const wasFailing = (testId: string): boolean => priors.get(testId) === 'FAILED';

  const newFailures = failingNow.filter((row) => !wasFailing(row.testId));
  const stillFailing = failingNow.length - newFailures.length;
  const fixed = passingNow.filter((row) => wasFailing(row.testId));
  const flakes = [...latest.values()].filter(
    (row) => (retriesByTest.get(row.testId) ?? 0) > 0 && !failed(row),
  );

  const owners = await ownersFor(
    orgId,
    projectId,
    // Only what gets listed needs an owner; resolving for the whole suite would
    // be work nobody reads.
    [...newFailures, ...flakes].map((row) => row.test),
  );

  const item = (row: ResultRow): DigestItem => ({
    testId: row.testId,
    name: row.test.name,
    filePath: row.test.filePath,
    runId: row.runId,
    verdict: row.verdict?.overriddenTo ?? row.verdict?.verdict ?? null,
    owner: owners.get(row.testId) ?? null,
  });

  return {
    projectId: project.id,
    projectName: project.name,
    since,
    until,
    runs: { total: runs.length, red: runs.filter((run) => run.status !== 'PASSED').length },
    // Real bugs before environment noise, then alphabetical so two consecutive
    // digests list the same failure in the same place.
    newFailures: newFailures.sort(byVerdictThenName).map(item),
    flakes: flakes
      .sort((a, b) => (retriesByTest.get(b.testId) ?? 0) - (retriesByTest.get(a.testId) ?? 0))
      .map((row) => ({ ...item(row), retries: retriesByTest.get(row.testId) ?? 0 })),
    fixed: fixed.sort((a, b) => a.test.name.localeCompare(b.test.name)).map(item),
    stillFailing,
    silentSchedules: await silentSchedules(orgId, projectId, runs.length, until),
    unowned: newFailures.filter((row) => !owners.get(row.testId)).length,
    truncated: results.length >= MAX_RESULTS,
  };
}

const VERDICT_ORDER: Record<string, number> = {
  REAL_BUG: 0,
  INTENDED_CHANGE: 1,
  FLAKE: 2,
  ENV_ISSUE: 3,
};

function byVerdictThenName(a: ResultRow, b: ResultRow): number {
  const rank = (row: ResultRow): number => {
    const verdict = row.verdict?.overriddenTo ?? row.verdict?.verdict;
    // An untriaged failure sorts with the real bugs, not after them. Nobody has
    // ruled it out yet, and burying it under four triaged ones is how the one
    // failure that needed a human ends up below the fold.
    return verdict ? (VERDICT_ORDER[verdict] ?? 4) : 0;
  };
  return rank(a) - rank(b) || a.test.name.localeCompare(b.test.name);
}

/**
 * What each test last did BEFORE the window.
 *
 * One query with a window of `tests × 4` rows rather than one query per test.
 * Results are written a whole run at a time, so walking back by `createdAt desc`
 * moves run by run and the window lands on roughly the last four runs — the same
 * approximation the shard packer makes, for the same reason (Prisma cannot limit
 * per group without raw SQL).
 *
 * Its failure mode is the reason it is safe: a test that has not run in those
 * four runs comes back `undefined`, and the caller reads `undefined` as "was not
 * failing", which lists the test as a NEW failure. The approximation can
 * therefore make the digest say more, never less.
 */
async function priorOutcomes(
  orgId: string,
  testIds: string[],
  before: Date,
): Promise<Map<string, 'FAILED' | 'PASSED'>> {
  const outcomes = new Map<string, 'FAILED' | 'PASSED'>();
  if (testIds.length === 0) return outcomes;

  const rows = (await prisma.testResult.findMany({
    where: {
      orgId,
      testId: { in: testIds },
      createdAt: { lt: before },
      // A placeholder row for a test that never executed says nothing about
      // whether it was passing.
      status: { not: 'SKIPPED' },
    },
    orderBy: { createdAt: 'desc' },
    take: testIds.length * 4,
    select: {
      testId: true,
      status: true,
      retriedAndPassed: true,
      test: { select: { quarantined: true } },
    },
  })) as Array<{
    testId: string;
    status: string;
    retriedAndPassed: boolean;
    test: { quarantined: boolean };
  }>;

  for (const row of rows) {
    // Descending, so the first row seen for a test is its most recent.
    if (outcomes.has(row.testId)) continue;
    outcomes.set(
      row.testId,
      isRealFailure({
        status: row.status,
        retriedAndPassed: row.retriedAndPassed,
        quarantined: row.test.quarantined,
      })
        ? 'FAILED'
        : 'PASSED',
    );
  }
  return outcomes;
}

/**
 * Which schedules were due in this window and produced nothing.
 *
 * This is the section that justifies waking people up. Everything else in the
 * digest is about tests failing; this one is about tests not running, which no
 * screen in the product shows and no alert fires on — a disabled worker, an
 * unparseable cron, a suite emptied by a bad selector all look like a quiet
 * night from every other angle.
 */
async function silentSchedules(
  orgId: string,
  projectId: string,
  runsInWindow: number,
  until: Date,
): Promise<string[]> {
  if (runsInWindow > 0) return [];

  const schedules = await prisma.schedule.findMany({
    where: { orgId, projectId, enabled: true },
    select: { name: true, nextRunAt: true, lastRunAt: true },
  });

  /*
   * `nextRunAt` in the past is the tell.
   *
   * The scheduler advances `nextRunAt` BEFORE it enqueues, so a schedule that
   * fired always points at a future time. One still pointing at a past time was
   * due and nothing picked it up — which, together with a window that contains
   * no runs at all, is a scheduler that has stopped. A schedule armed but not
   * yet due (future `nextRunAt`) is not silent, and is excluded.
   */
  return schedules
    .filter((schedule) => schedule.nextRunAt !== null && schedule.nextRunAt <= until)
    .map((schedule) => schedule.name);
}

/** Owner labels per test, or nothing. Two queries, never one per test. */
async function ownersFor(
  orgId: string,
  projectId: string,
  tests: Array<{ id: string; filePath: string; suiteId: string | null; feature: string | null }>,
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (tests.length === 0) return labels;

  const rules = (await prisma.ownershipRule.findMany({
    where: { orgId, projectId },
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
    },
  })) as OwnershipRuleInput[];
  if (rules.length === 0) return labels;

  const resolved = resolveOwnershipFor(tests, rules);

  const userIds: string[] = [];
  const teamIds: string[] = [];
  for (const resolution of resolved.values()) {
    const owner = resolution.owner?.owner;
    if (!owner) continue;
    if (owner.kind === 'USER') userIds.push(owner.userId);
    else teamIds.push(owner.teamId);
  }

  const [users, teams] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({
          where: { id: { in: [...new Set(userIds)] } },
          select: { id: true, name: true, email: true },
        })
      : Promise.resolve([]),
    teamIds.length
      ? prisma.team.findMany({
          where: { orgId, id: { in: [...new Set(teamIds)] } },
          select: { id: true, slug: true },
        })
      : Promise.resolve([]),
  ]);
  const userById = new Map(users.map((user) => [user.id, user]));
  const teamById = new Map(teams.map((team) => [team.id, team]));

  for (const [testId, resolution] of resolved) {
    const owner = resolution.owner?.owner;
    if (!owner) continue;
    if (owner.kind === 'USER') {
      const user = userById.get(owner.userId);
      if (user) labels.set(testId, user.name || user.email);
    } else {
      const team = teamById.get(owner.teamId);
      if (team) labels.set(testId, `@${team.slug}`);
    }
  }

  // Rules that could not be evaluated are logged rather than dropped: routing
  // that has silently stopped looks exactly like a suite nobody has assigned.
  const broken = [...resolved.values()].flatMap((resolution) => resolution.skipped);
  if (broken.length > 0) {
    logger.warn(
      { projectId, rules: [...new Set(broken.map((s) => s.ruleId))] },
      'ownership rules could not be evaluated; those failures are being reported unowned',
    );
  }

  return labels;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * Plain text, and deliberately no bold.
 *
 * Slack wants `*bold*`, Discord and Teams want `**bold**`, and one message goes
 * to all three — so any emphasis syntax is guaranteed to render as literal
 * asterisks somewhere. Emoji, indentation and blank lines survive everywhere,
 * so those carry the structure instead.
 */
export function renderDigest(digest: Digest, webUrl: string): string {
  const hours = Math.round((digest.until.getTime() - digest.since.getTime()) / 3_600_000);
  const lines: string[] = [
    `📋 QAAI digest — ${digest.projectName}`,
    `Last ${hours}h · ${digest.runs.total} run${digest.runs.total === 1 ? '' : 's'}, ${digest.runs.red} red`,
  ];

  if (digest.silentSchedules.length > 0) {
    lines.push(
      '',
      `⚠️ No runs at all in this window, and ${digest.silentSchedules.length} schedule(s) were due: ${digest.silentSchedules.join(', ')}.`,
      'Nothing has been tested since the last digest — the dashboard is green because it is empty.',
    );
  }

  const section = (icon: string, title: string, items: DigestItem[], detail: (i: DigestItem) => string) => {
    if (items.length === 0) return;
    lines.push('', `${icon} ${title} (${items.length})`);
    for (const item of items.slice(0, MAX_LISTED)) {
      lines.push(`  • ${item.name}${item.owner ? ` — ${item.owner}` : ''}`);
      lines.push(`    ${detail(item)}`);
    }
    if (items.length > MAX_LISTED) lines.push(`  …and ${items.length - MAX_LISTED} more`);
  };

  section('🔴', 'New failures', digest.newFailures, (item) =>
    [item.verdict ? VERDICT_PHRASE[item.verdict] ?? item.verdict : 'not triaged yet', item.filePath]
      .filter(Boolean)
      .join(' · '),
  );

  section('🎲', 'Flaky', digest.flakes, (item) =>
    `passed only on retry${item.retries && item.retries > 1 ? ` ×${item.retries}` : ''} · ${item.filePath}`,
  );

  section('✅', 'Fixed', digest.fixed, (item) => item.filePath);

  const footnotes: string[] = [];
  if (digest.stillFailing > 0) {
    footnotes.push(
      `${digest.stillFailing} test(s) were already failing before this window and still are.`,
    );
  }
  if (digest.unowned > 0 && digest.newFailures.length > 0) {
    // Said plainly, because an unowned failure is the one that sits for a week.
    footnotes.push(`${digest.unowned} of the new failures have no owner.`);
  }
  if (digest.truncated) {
    footnotes.push(
      `This window held more than ${MAX_RESULTS} results, so the digest read only the first ${MAX_RESULTS}.`,
    );
  }
  if (footnotes.length > 0) lines.push('', ...footnotes);

  lines.push('', `${webUrl}/projects/${digest.projectId}`);

  const text = lines.join('\n');
  return text.length <= MAX_MESSAGE_CHARS
    ? text
    : `${text.slice(0, MAX_MESSAGE_CHARS - 40)}\n…truncated by QAAI.`;
}

const VERDICT_PHRASE: Record<string, string> = {
  REAL_BUG: '🐞 likely a real bug',
  INTENDED_CHANGE: '🔁 an intended change',
  FLAKE: '🎲 a flake',
  ENV_ISSUE: '🌐 an environment issue',
};

// ─── Delivery ────────────────────────────────────────────────────────────────

/**
 * The host each provider's incoming webhooks actually live on.
 *
 * Pinned per provider, never read from the config row. The URL on an Integration
 * is editable by an org admin, and the body being posted here is a summary of a
 * customer's test suite — what broke, in which files. A config row must be able
 * to choose the PATH (that is the webhook token) and never the host.
 */
function isPinnedHost(kind: string, hostname: string): boolean {
  // A fully-qualified name may end in a dot and DNS resolves it identically, so
  // strip it BEFORE comparing. One character defeating a hostname guard is not
  // hypothetical here — see the trailing-dot note in apps/api/src/lib/issues.ts.
  const host = hostname.toLowerCase().replace(/\.+$/, '');

  if (kind === 'SLACK') return host === 'hooks.slack.com';
  if (kind === 'DISCORD') return host === 'discord.com' || host === 'discordapp.com';
  if (kind === 'MSTEAMS') {
    return (
      host === 'outlook.office.com' ||
      host === 'outlook.office365.com' ||
      host.endsWith('.webhook.office.com') ||
      // Power Automate, which is what "Workflows" in Teams creates now that the
      // Office connectors are being retired.
      host.endsWith('.logic.azure.com')
    );
  }
  return false;
}

interface Destination {
  id: string;
  kind: string;
  url: string;
}

/** A destination that will not be used, and the sentence explaining why. */
interface SkippedDestination {
  id: string;
  kind: string;
  reason: string;
}

export function partitionDestinations(
  integrations: Array<{ id: string; kind: string; config: unknown }>,
): { deliverable: Destination[]; skipped: SkippedDestination[] } {
  const deliverable: Destination[] = [];
  const skipped: SkippedDestination[] = [];

  for (const integration of integrations) {
    const config = (integration.config ?? {}) as { url?: unknown };
    const raw = typeof config.url === 'string' ? config.url.trim() : '';

    if (integration.kind === 'WEBHOOK') {
      /*
       * Deliberately not supported yet, and skipped loudly rather than silently.
       *
       * A generic webhook is signed with a secret from the vault and posted to a
       * host that by definition cannot be pinned. That is a security decision
       * worth making on purpose — with the SSRF guard in issues.ts around it —
       * rather than one this feature inherits by reusing a code path.
       */
      skipped.push({
        id: integration.id,
        kind: integration.kind,
        reason:
          'Generic webhooks do not receive the digest. Point the digest at a Slack, Teams or Discord integration.',
      });
      continue;
    }

    if (!raw) {
      skipped.push({
        id: integration.id,
        kind: integration.kind,
        reason: 'This integration has no webhook URL configured.',
      });
      continue;
    }

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      // Never echoes the URL: a webhook URL IS the credential, and this is
      // exactly where a malformed one carrying a token would be logged.
      skipped.push({
        id: integration.id,
        kind: integration.kind,
        reason: 'The webhook URL on this integration could not be parsed.',
      });
      continue;
    }

    if (url.protocol !== 'https:') {
      skipped.push({
        id: integration.id,
        kind: integration.kind,
        reason: 'The webhook URL must be https — the digest describes your test suite.',
      });
      continue;
    }
    if (!isPinnedHost(integration.kind, url.hostname)) {
      skipped.push({
        id: integration.id,
        kind: integration.kind,
        reason: `${url.hostname.replace(/\.+$/, '')} is not a ${integration.kind} webhook host, so nothing was sent to it. Re-copy the incoming-webhook URL from ${integration.kind}.`,
      });
      continue;
    }

    deliverable.push({ id: integration.id, kind: integration.kind, url: raw });
  }

  return { deliverable, skipped };
}

/**
 * POST the digest to every usable destination. Returns how many accepted it.
 *
 * Every attempt becomes a WebhookDelivery row, successful or not — a
 * notification that silently failed is indistinguishable from one that was never
 * sent, and "why didn't I get the digest" deserves an answer that is not a
 * shrug. The same contract notify.ts holds itself to.
 */
async function deliver(
  orgId: string,
  destinations: Destination[],
  text: string,
): Promise<number> {
  let delivered = 0;

  for (const destination of destinations) {
    // Teams wants `text`, Discord wants `content`, Slack accepts `text`.
    const body =
      destination.kind === 'DISCORD' ? JSON.stringify({ content: text }) : JSON.stringify({ text });

    let status: number | null = null;
    let error: string | null = null;

    try {
      const response = await fetch(destination.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'qaai' },
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
      } else {
        delivered += 1;
      }
    } catch (err) {
      error =
        err instanceof Error && err.name === 'TimeoutError'
          ? `no answer within ${REQUEST_TIMEOUT_MS / 1000}s`
          : 'delivery failed';
    }

    await prisma.webhookDelivery
      .create({
        data: {
          orgId,
          integrationId: destination.id,
          event: 'digest.daily',
          payload: { text },
          signature: '',
          responseStatus: status,
          attempts: 1,
          deliveredAt: error ? null : new Date(),
          lastError: error,
        },
      })
      // A failure to RECORD the attempt must not lose the attempt itself.
      .catch((err) => logger.warn({ err }, 'could not record the digest delivery'));

    if (error) {
      logger.warn({ integrationId: destination.id, kind: destination.kind, error }, 'digest delivery failed');
    }
  }

  return delivered;
}

// ─── The tick ────────────────────────────────────────────────────────────────

interface Subscription {
  id: string;
  orgId: string;
  projectId: string;
  cron: string;
  timezone: string;
  notifyVia: string[];
  nextRunAt: Date | null;
  lastCoveredAt: Date | null;
}

function nextFireTime(cron: string, timezone: string, after: Date): Date | null {
  try {
    return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone }).next().toDate();
  } catch {
    return null;
  }
}

/**
 * Build and send one project's digest.
 *
 * Exported so a future "send me one now" endpoint has something to call, and so
 * the tick below stays a loop over subscriptions rather than a loop with the
 * whole feature inlined in it.
 */
export async function runDigest(subscription: Subscription, now: Date): Promise<void> {
  const since = new Date(
    Math.max(
      (subscription.lastCoveredAt ?? new Date(now.getTime() - DEFAULT_WINDOW_MS)).getTime(),
      now.getTime() - MAX_WINDOW_MS,
    ),
  );

  const digest = await collectDigest(subscription, since, now);
  if (!digest) return;

  if (!hasSomethingToSay(digest)) {
    /*
     * Silence, with the numbers that produced it.
     *
     * This is the one place the feature deliberately withholds a message, so it
     * is also the one place that must leave a trace: if someone later asks why
     * Tuesday's digest never arrived, this line answers it. The window closes,
     * because nothing was lost.
     */
    logger.info(
      {
        projectId: digest.projectId,
        since,
        until: now,
        runs: digest.runs.total,
        stillFailing: digest.stillFailing,
      },
      'digest had nothing to say; not sending',
    );
    await prisma.digestSubscription.update({
      where: { id: subscription.id },
      data: { lastCoveredAt: now },
    });
    return;
  }

  const integrations = await prisma.integration.findMany({
    where: {
      orgId: subscription.orgId,
      enabled: true,
      kind: { in: ['SLACK', 'MSTEAMS', 'DISCORD', 'WEBHOOK'] },
      // An empty notifyVia means "wherever the failures already go".
      ...(subscription.notifyVia.length > 0 ? { id: { in: subscription.notifyVia } } : {}),
    },
    select: { id: true, kind: true, config: true },
  });

  const { deliverable, skipped } = partitionDestinations(integrations);
  for (const destination of skipped) {
    // Every skip is actionable and says what to change. A destination that is
    // quietly dropped is how a team concludes the digest does not work.
    logger.warn(
      { projectId: digest.projectId, integrationId: destination.id, kind: destination.kind },
      destination.reason,
    );
  }

  if (deliverable.length === 0) {
    logger.error(
      { projectId: digest.projectId, considered: integrations.length },
      'digest has news but nowhere to send it; leaving the window open for the next one',
    );
    return;
  }

  const text = renderDigest(digest, process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000');
  const delivered = await deliver(subscription.orgId, deliverable, text);

  if (delivered === 0) {
    /*
     * Nothing got through. The window stays OPEN on purpose: tomorrow's digest
     * will cover today's news as well, because a reporting problem must never be
     * allowed to lose what it was reporting. `nextRunAt` has already advanced,
     * so this retries on the next cron slot rather than spinning.
     */
    logger.error(
      { projectId: digest.projectId, destinations: deliverable.length },
      'every digest delivery failed; the window stays open so nothing is lost',
    );
    return;
  }

  await prisma.digestSubscription.update({
    where: { id: subscription.id },
    data: { lastCoveredAt: now },
  });

  logger.info(
    {
      projectId: digest.projectId,
      delivered,
      newFailures: digest.newFailures.length,
      flakes: digest.flakes.length,
      fixed: digest.fixed.length,
    },
    'digest sent',
  );
}

/**
 * The sweep: every subscription that is due.
 *
 * Same shape as the scheduler tick, and idempotent for the same reason — the
 * next fire time is claimed BEFORE the digest is built, so a redelivered tick
 * cannot send the same summary twice. Losing one cycle is recoverable (the
 * window stays open); sending the same digest to a channel twice is not.
 */
export async function processDigestTick(): Promise<void> {
  const now = new Date();

  const due = await prisma.digestSubscription.findMany({
    where: { enabled: true, OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] },
    select: {
      id: true,
      orgId: true,
      projectId: true,
      cron: true,
      timezone: true,
      notifyVia: true,
      nextRunAt: true,
      lastCoveredAt: true,
    },
  });

  for (const subscription of due) {
    const next = nextFireTime(subscription.cron, subscription.timezone, now);
    if (!next) {
      // An unparseable cron would otherwise be retried on every tick forever.
      logger.warn(
        { digestId: subscription.id, cron: subscription.cron },
        'disabling a digest with an invalid cron expression',
      );
      await prisma.digestSubscription.update({
        where: { id: subscription.id },
        data: { enabled: false },
      });
      continue;
    }

    await prisma.digestSubscription.update({
      where: { id: subscription.id },
      data: { nextRunAt: next, lastRunAt: subscription.nextRunAt ? now : null },
    });

    // First sight only arms it. Creating a digest at 2pm must not immediately
    // send one covering an arbitrary window ending at 2pm.
    if (!subscription.nextRunAt) {
      logger.info({ digestId: subscription.id, next }, 'digest armed');
      continue;
    }

    // One project's digest failing must not cost every other project theirs.
    // The window stays open, so the next tick carries today's news too.
    await runDigest(subscription, now).catch((err) =>
      logger.error({ err, digestId: subscription.id }, 'could not build or send a digest'),
    );
  }
}
