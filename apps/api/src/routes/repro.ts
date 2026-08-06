/**
 * Test-from-bug-report — paste a ticket, get a test that reproduces it.
 *
 * POST /repro/:projectId  { text?, issueUrl? }
 *
 * The endpoint's promise is narrow and the ordering that delivers it is the
 * whole design:
 *
 *   fetch (optionally) → EXTRACT → MATCH against the flow map → DEDUPE →
 *   generate → run → judge
 *
 * Everything before "generate" is deterministic, and every one of those steps
 * can end the request early with something more useful than a test: a ticket
 * whose bug is already covered comes back as the covering test, not a second
 * one; a ticket with no route the crawl recognises comes back with the warning
 * attached rather than a test that starts somewhere that 404s.
 *
 * The last step is the one that matters. A generated reproduction is RUN, and a
 * run that PASSES is reported as NOT_REPRODUCED in those words. A test that
 * goes green against the application the reporter says is broken has reproduced
 * nothing, and the response says so instead of implying the bug is captured.
 * Such a test is also left disabled, so a reproduction nobody has seen fail can
 * never quietly join the suite that gates a merge.
 *
 * SECURITY — fetching an issue means sending a vault-unsealed customer token to
 * a tracker, with the destination influenced by a URL that arrived in a request
 * body. That is a worse starting position than the one apps/api/src/lib/issues.ts
 * already deals with (where the destination comes from admin-edited config), so
 * this route reuses that module's validators rather than writing its own:
 *
 *  - `parseIssueUrl` (packages/agent) reduces the pasted URL to a provider and
 *    an anchored identifier. It returns the hostname it saw as DATA, never as a
 *    destination.
 *  - `parseIssueConfig` / `githubRepoSlug` / `jiraSite` from issues.ts decide
 *    where the request may go. GitHub and Linear are host-pinned constants;
 *    Jira uses the site already validated on the integration, and the pasted
 *    URL's host must MATCH it or nothing is sent.
 *  - The destination is settled before the token is unsealed, so a mismatch
 *    fails while the credential is still ciphertext.
 *  - `redirect: 'manual'`. A 3xx is an error, never a hop — following one
 *    re-sends the Authorization header to whatever Location names, which is
 *    exactly how a PAT walks out of the building.
 *
 * A fetched issue body is UNTRUSTED third-party text. It never reaches the
 * Generator directly: only the bounded fields the extractor produced — steps,
 * expected, actual — travel into a prompt, and any test built from a fetched
 * ticket carries a review flag saying where its instructions came from.
 */

import { Router } from 'express';
import { z } from 'zod';
import { QUEUE_NAMES, TERMINAL_RUN_STATUSES } from '@qaai/shared';
import type { AgentCallRecord, FlowMap, RunStatus, TestResultStatus } from '@qaai/shared';
import { createLlmService, generateTest } from '@qaai/agent';
/*
 * Reached by path rather than through the package barrel.
 *
 * `packages/agent/src/index.ts` is owned by another change in flight and this
 * one may not edit it, so `export * from './repro.js'` is not there yet. Once
 * it is, this import collapses into the `@qaai/agent` line above and nothing
 * else about this file changes.
 */
import {
  MAX_REPORT_CHARS,
  ReproInputError,
  buildReproPlanItem,
  extractBugReport,
  findCoveringTests,
  matchFlowMap,
  parseIssueUrl,
  reproVerdict,
} from '../../../../packages/agent/src/repro.js';
import type {
  CoveringTest,
  IssueRef,
  ReproSource,
} from '../../../../packages/agent/src/repro.js';
import { prisma, unscoped } from '../lib/prisma.js';
import { badRequest, notFound, planLimit, unprocessable } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { enqueue } from '../lib/queues.js';
import { canStartRun, planFor } from '../lib/plan.js';
import { openToken } from '../lib/integrations.js';
import { logger, registerRequestSecrets } from '../lib/logger.js';
import {
  IssueFilingError,
  TRACKER_LABEL,
  githubRepoSlug,
  isIssueTrackerKind,
  parseIssueConfig,
  redactSecrets,
} from '../lib/issues.js';
import type { IssueTrackerConfig, IssueTrackerKind } from '../lib/issues.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import { env } from '../env.js';

export const reproRouter: Router = Router();

reproRouter.use(requireAuth);

/**
 * Pinned API hosts, duplicated from lib/issues.ts on purpose.
 *
 * They are constants in source, not values from config or from a request, so
 * the property that matters — a pasted URL can choose a path and never a host —
 * still holds. The duplication exists only because issues.ts does not export
 * its HTTP client or its host table, and this route may not edit that file. The
 * right end state is one `fetchIssue()` beside `createIssue()`; see the note in
 * the handover for this change.
 */
const API_HOST = { GITHUB: 'api.github.com', LINEAR: 'api.linear.app' } as const;

/** A tracker that has not answered in this long is not going to. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Tests whose source is read to answer "is this bug already covered?". */
const MAX_DUPLICATE_CANDIDATES = 1_000;

/** How long the endpoint will hold the connection waiting for the run. */
const DEFAULT_WAIT_MS = 90_000;
const MAX_WAIT_MS = 240_000;
const POLL_MS = 750;

const reproRequestSchema = z
  .object({
    /** A pasted ticket. */
    text: z.string().max(MAX_REPORT_CHARS).optional(),
    /** A Jira / Linear / GitHub issue URL, fetched through the stored token. */
    issueUrl: z.string().max(2_000).optional(),
    environmentId: z.string().min(1).optional(),
    /** Which tracker to fetch through, when more than one is connected. */
    integrationId: z.string().min(1).optional(),
    /** Write the test even if an existing one already covers this bug. */
    force: z.boolean().default(false),
    /** Off only for a caller that wants the proposal without executing it. */
    run: z.boolean().default(true),
    waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
  })
  .refine((body) => Boolean(body.text?.trim() || body.issueUrl?.trim()), {
    message: 'Provide `text` (a pasted bug report) or `issueUrl` (a Jira, Linear or GitHub issue).',
  });

// ─── Fetching the ticket ─────────────────────────────────────────────────────

/**
 * One GET, with the two rules that matter applied in one place: never follow a
 * redirect, and never let a hung provider hold the request open. Mirrors
 * `postJson` in lib/issues.ts, which is the canonical copy — the response is
 * parsed defensively and neither it nor the token is ever logged.
 */
async function fetchJson(
  url: string,
  headers: Record<string, string>,
  provider: IssueTrackerKind,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        ...headers,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        'user-agent': 'qaai',
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'TimeoutError'
        ? `did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`
        : 'was unreachable';
    throw new IssueFilingError(
      `${TRACKER_LABEL[provider]} ${reason}. Nothing was read — try again.`,
      'PROVIDER',
    );
  }

  if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
    throw new IssueFilingError(
      `${TRACKER_LABEL[provider]} answered with a redirect, and QAAI will not follow one while holding your token. ` +
        'Check the site URL on that integration.',
      'PROVIDER',
    );
  }

  let json: unknown = null;
  try {
    const text = await response.text();
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

function pick(json: unknown, key: string): unknown {
  return json && typeof json === 'object' ? (json as Record<string, unknown>)[key] : undefined;
}

/**
 * A provider field as text, or nothing.
 *
 * Never `String(value)`. Jira's v3 API returns the description as an Atlassian
 * Document Format OBJECT, and a proxy or a future default can put one in front
 * of the v2 request below — `String()` would turn that into the literal text
 * "[object Object]", which then becomes the entire bug report and generates a
 * test from six characters of nonsense. An unreadable field is empty, and the
 * caller says so.
 */
function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function describeReadFailure(provider: IssueTrackerKind, status: number): string {
  const name = TRACKER_LABEL[provider];
  if (status === 401) {
    return `${name} rejected the stored token (401). Re-enter it on the integration in Settings → Integrations.`;
  }
  if (status === 403) {
    return `${name} refused the request (403) — the stored token cannot read that issue.`;
  }
  if (status === 404) {
    return `${name} returned 404 — that issue does not exist, or the stored token cannot see it.`;
  }
  if (status === 429) return `${name} is rate-limiting QAAI (429). Wait a minute and try again.`;
  if (status >= 500) return `${name} returned ${status} — their API is having trouble. Try again.`;
  return `${name} returned an unexpected ${status}. The issue was not read.`;
}

const LINEAR_QUERY = `query QaaiReadIssue($team: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }, first: 1) {
    nodes { identifier title description }
  }
}`;

/**
 * Read the issue behind `ref` using the token on `integration`.
 *
 * The destination is settled entirely from `cfg` (which came from the
 * integration row and went through issues.ts's validators) plus the pinned
 * constants above. `ref` contributes an identifier and nothing else — it has
 * already been checked against `cfg` by the caller.
 */
async function readIssue(
  ref: IssueRef,
  cfg: IssueTrackerConfig,
  token: string,
): Promise<{ title: string; body: string }> {
  if (cfg.kind === 'GITHUB') {
    const { status, json } = await fetchJson(
      `https://${API_HOST.GITHUB}/repos/${cfg.repo}/issues/${encodeURIComponent(ref.key)}`,
      {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      'GITHUB',
    );
    if (status !== 200) throw new IssueFilingError(describeReadFailure('GITHUB', status), 'PROVIDER');
    return {
      title: text(pick(json, 'title'), `Issue #${ref.key}`),
      body: text(pick(json, 'body')),
    };
  }

  if (cfg.kind === 'JIRA') {
    const { status, json } = await fetchJson(
      // v2, not v3: v3 returns Atlassian Document Format and v2 returns a plain
      // string description on both Cloud and Data Center. Same choice, and the
      // same reason, as the filing path.
      `${cfg.site}/rest/api/2/issue/${encodeURIComponent(ref.key)}?fields=summary,description`,
      {
        authorization: cfg.email
          ? `Basic ${Buffer.from(`${cfg.email}:${token}`).toString('base64')}`
          : `Bearer ${token}`,
        accept: 'application/json',
      },
      'JIRA',
    );
    if (status !== 200) throw new IssueFilingError(describeReadFailure('JIRA', status), 'PROVIDER');
    const fields = pick(json, 'fields');
    return {
      title: text(pick(fields, 'summary'), ref.key),
      body: text(pick(fields, 'description')),
    };
  }

  // Linear addresses issues by UUID; the human-readable ENG-42 is a team key
  // plus a number, so the lookup filters on those two rather than guessing an id.
  const [teamKey, numberPart] = ref.key.split('-');
  const { status, json } = await fetchJson(
    `https://${API_HOST.LINEAR}/graphql`,
    {
      authorization: token.startsWith('lin_oauth_') ? `Bearer ${token}` : token,
      accept: 'application/json',
    },
    'LINEAR',
    { method: 'POST', body: { query: LINEAR_QUERY, variables: { team: teamKey, number: Number(numberPart) } } },
  );
  if (status !== 200) throw new IssueFilingError(describeReadFailure('LINEAR', status), 'PROVIDER');

  // GraphQL reports failure inside a 200, so the status check above is not
  // enough — an unknown team looks exactly like success until this runs.
  const errors = pick(json, 'errors');
  if (Array.isArray(errors) && errors.length > 0) {
    const message = redactSecrets(text(pick(errors[0], 'message'), 'unknown error')).slice(0, 200);
    throw new IssueFilingError(`Linear rejected the request: ${message}`, 'PROVIDER');
  }

  const nodes = pick(pick(pick(json, 'data'), 'issues'), 'nodes');
  const issue = Array.isArray(nodes) ? nodes[0] : undefined;
  if (!issue) {
    throw new IssueFilingError(
      `Linear has no issue ${ref.key} that this token can see.`,
      'PROVIDER',
    );
  }
  return {
    title: text(pick(issue, 'title'), ref.key),
    body: text(pick(issue, 'description')),
  };
}

/**
 * Choose the integration this issue must be read through, and prove the pasted
 * URL points at it.
 *
 * The proof is the point. A GitHub URL may only name the repository the
 * integration is configured for, and a Jira URL may only name the site it is
 * configured for — otherwise a member could aim an org's stored credential at
 * any repo or any host it happens to reach and read the response body back out
 * of this endpoint. Both checks run before the token is unsealed.
 */
async function resolveTracker(
  ref: IssueRef,
  projectId: string,
  integrationId: string | null,
): Promise<{ id: string; name: string; kind: IssueTrackerKind; cfg: IssueTrackerConfig; configEnc: string }> {
  const candidates = await prisma.integration.findMany({
    where: {
      kind: ref.provider,
      enabled: true,
      OR: [{ projectId: null }, { projectId }],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, kind: true, name: true, projectId: true, config: true, configEnc: true },
  });

  // A tracker pinned to this project beats the org-wide one, exactly as the
  // filing route decides it.
  const scoped = candidates.filter((c) => c.projectId === projectId);
  const pool = scoped.length > 0 ? scoped : candidates;

  const integration = integrationId
    ? (pool.find((c) => c.id === integrationId) ?? null)
    : (pool[0] ?? null);

  if (integrationId && !integration) throw notFound('Integration');
  if (!integration) {
    throw badRequest(
      `No ${TRACKER_LABEL[ref.provider]} integration is connected, so that issue cannot be read. ` +
        'Connect one under Settings → Integrations, or paste the ticket text instead.',
    );
  }
  if (!isIssueTrackerKind(integration.kind)) throw notFound('Integration');
  if (!integration.configEnc) {
    throw badRequest(
      `"${integration.name}" has no ${TRACKER_LABEL[ref.provider]} token stored. Add one in Settings → Integrations.`,
    );
  }

  let cfg: IssueTrackerConfig;
  try {
    cfg = parseIssueConfig(integration.kind, integration.config);
  } catch (err) {
    if (err instanceof IssueFilingError) throw badRequest(err.message);
    throw err;
  }

  if (cfg.kind === 'GITHUB') {
    // Re-validated through issues.ts's own parser rather than trusted from the
    // URL: it is the function that rejects dot segments and off-host slugs.
    const fromUrl = githubRepoSlug(ref.repo);
    if (fromUrl.toLowerCase() !== cfg.repo.toLowerCase()) {
      throw badRequest(
        `That issue is on ${fromUrl}, but "${integration.name}" is connected to ${cfg.repo}. ` +
          'Connect an integration for that repository, or paste the ticket text instead.',
      );
    }
  }

  if (cfg.kind === 'JIRA') {
    // cfg.site went through jiraSite(): https, no credentials, no IP literal,
    // no internal name, trailing dot stripped. ref.host was normalised the same
    // way. The request below is built from cfg.site, so this comparison is a
    // second gate rather than the only one.
    const configured = new URL(cfg.site).hostname.replace(/\.+$/, '').toLowerCase();
    if (configured !== ref.host) {
      throw badRequest(
        `That issue is on ${ref.host}, but "${integration.name}" is connected to ${configured}. ` +
          'QAAI will not send a Jira token to a host that is not the one on the integration.',
      );
    }
  }

  return {
    id: integration.id,
    name: integration.name,
    kind: integration.kind,
    cfg,
    configEnc: integration.configEnc,
  };
}

// ─── Generation ──────────────────────────────────────────────────────────────

/**
 * One LLM client per process, built from the same env vars the worker uses.
 *
 * Generation runs inline here rather than on the generate queue because the
 * endpoint's whole value is answering "does this reproduce?" in one call, and a
 * queued job cannot return a verdict. Usage is metered exactly as the worker
 * meters it, so an inline call is not a call that escapes the §9 accounting.
 */
async function recordAgentCall(record: AgentCallRecord & { error?: string }): Promise<void> {
  try {
    await unscoped(() =>
      prisma.agentCall.create({
        data: {
          orgId: record.orgId,
          projectId: record.projectId,
          agent: record.agent,
          model: record.model,
          subjectId: record.subjectId,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cacheReadTokens: record.cacheReadTokens,
          cacheWriteTokens: record.cacheWriteTokens,
          costCents: record.costCents,
          durationMs: record.durationMs,
          error: record.error ?? null,
        },
      }),
    );

    const total = record.inputTokens + record.outputTokens;
    if (total > 0) {
      await unscoped(() =>
        prisma.usageRecord.upsert({
          where: {
            orgId_metric_period: { orgId: record.orgId, metric: 'agent_tokens', period: currentPeriod() },
          },
          create: {
            orgId: record.orgId,
            metric: 'agent_tokens',
            period: currentPeriod(),
            quantity: BigInt(total),
          },
          update: { quantity: { increment: BigInt(total) } },
        }),
      );
    }
  } catch (err) {
    // Accounting must never lose the work it is accounting for.
    logger.error({ err }, 'failed to record agent call');
  }
}

/**
 * Month-to-date tokens for the budget gate — the same row recordAgentCall
 * increments, read `unscoped` for the same reason that write is: the orgId
 * comes from the call context the service was handed, not from whichever
 * tenant scope happens to be live when the gate runs.
 */
async function monthTokens(orgId: string): Promise<number> {
  const row = await unscoped(() =>
    prisma.usageRecord.findUnique({
      where: { orgId_metric_period: { orgId, metric: 'agent_tokens', period: currentPeriod() } },
      select: { quantity: true },
    }),
  );
  return Number(row?.quantity ?? 0n);
}

let llmSingleton: ReturnType<typeof createLlmService> | null = null;
function llmService(): ReturnType<typeof createLlmService> {
  llmSingleton ??= createLlmService(
    {
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      QAAI_MODEL_CHEAP: env.QAAI_MODEL_CHEAP,
      QAAI_MODEL_STRONG: env.QAAI_MODEL_STRONG,
      QAAI_LLM_MAX_RETRIES: env.QAAI_LLM_MAX_RETRIES,
      QAAI_MONTHLY_TOKEN_BUDGET: env.QAAI_MONTHLY_TOKEN_BUDGET,
    },
    recordAgentCall,
    monthTokens,
  );
  return llmSingleton;
}

function currentPeriod(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** A path nobody else is using, so a second reproduction cannot overwrite the first. */
async function freeFilePath(projectId: string, wanted: string): Promise<string> {
  const taken = new Set(
    (
      await prisma.test.findMany({
        where: { projectId, filePath: { startsWith: wanted.replace(/(\.[^./]+)$/, '') } },
        select: { filePath: true },
      })
    ).map((t) => t.filePath),
  );
  if (!taken.has(wanted)) return wanted;

  const match = /^(.*?)(\.[^./]+)$/.exec(wanted);
  const stem = match?.[1] ?? wanted;
  const ext = match?.[2] ?? '';
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

// ─── Running it ──────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for the reproduction to execute, up to a budget.
 *
 * Polling rather than subscribing because a run is executed by the worker and
 * this is the API: there is no in-process completion to await. A budget that
 * expires is reported as PENDING with the run id, never as a result — "we did
 * not wait long enough" and "the test passed" must not look the same to a
 * caller, and only one of them means the bug was not reproduced.
 */
async function waitForRun(
  runId: string,
  testId: string,
  budgetMs: number,
): Promise<{
  runStatus: RunStatus;
  finished: boolean;
  result: { status: TestResultStatus; errorMessage: string | null; durationMs: number } | null;
  waitedMs: number;
}> {
  const startedAt = Date.now();
  let runStatus: RunStatus = 'QUEUED';

  while (Date.now() - startedAt < budgetMs) {
    const run = await prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
    runStatus = run?.status ?? 'QUEUED';
    if (TERMINAL_RUN_STATUSES.includes(runStatus)) {
      const result = await prisma.testResult.findUnique({
        where: { runId_testId: { runId, testId } },
        select: { status: true, errorMessage: true, durationMs: true },
      });
      return {
        runStatus,
        finished: true,
        result: result
          ? {
              status: result.status,
              errorMessage: result.errorMessage,
              durationMs: result.durationMs,
            }
          : null,
        waitedMs: Date.now() - startedAt,
      };
    }
    await sleep(POLL_MS);
  }

  return { runStatus, finished: false, result: null, waitedMs: Date.now() - startedAt };
}

// ─── The endpoint ────────────────────────────────────────────────────────────

reproRouter.post('/:projectId', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const projectId = String(req.params.projectId);
  const input = reproRequestSchema.parse(req.body ?? {});

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      primaryLanguage: true,
      primaryFramework: true,
      environments: { select: { id: true, name: true, baseUrl: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!project) throw notFound('Project');

  // ── 1. The ticket ──────────────────────────────────────────────────────────

  let source: ReproSource = { kind: 'TEXT' };
  let reportText = input.text?.trim() ?? '';
  let fetchedFrom: string | null = null;

  if (input.issueUrl?.trim()) {
    let ref: IssueRef;
    try {
      ref = parseIssueUrl(input.issueUrl);
    } catch (err) {
      if (err instanceof ReproInputError) throw badRequest(err.message);
      throw err;
    }

    let tracker;
    try {
      tracker = await resolveTracker(ref, project.id, input.integrationId ?? null);
    } catch (err) {
      if (err instanceof IssueFilingError) throw badRequest(err.message);
      throw err;
    }

    // Destination settled; only now is the credential produced in plaintext.
    let token: string;
    try {
      token = openToken(tracker.configEnc, tracker.cfg.keyVersion, actor.orgId, tracker.id);
    } catch {
      throw badRequest(
        `The stored ${TRACKER_LABEL[tracker.kind]} token could not be read. Re-enter it on "${tracker.name}" in Settings → Integrations.`,
      );
    }
    registerRequestSecrets([token]);

    let issue: { title: string; body: string };
    try {
      issue = await readIssue(ref, tracker.cfg, token);
    } catch (err) {
      const message =
        err instanceof IssueFilingError ? err.message : `Reading the issue from ${TRACKER_LABEL[tracker.kind]} failed.`;
      const safe = redactSecrets(message);
      await audit({
        actor,
        action: 'repro.fetch.failed',
        targetType: 'Project',
        targetId: project.id,
        metadata: { provider: ref.provider, key: ref.key, reason: safe.slice(0, 300) },
      });
      if (err instanceof IssueFilingError && err.kind === 'CONFIG') throw badRequest(safe);
      throw unprocessable(safe);
    }

    source = { kind: 'ISSUE', provider: ref.provider, key: ref.key, url: input.issueUrl.trim() };
    fetchedFrom = `${TRACKER_LABEL[ref.provider]} ${ref.key}`;
    // A pasted note is extra context, never a replacement for the ticket.
    reportText = [`# ${issue.title}`, issue.body, reportText].filter(Boolean).join('\n\n');
  }

  reportText = reportText.slice(0, MAX_REPORT_CHARS);
  if (!reportText.trim()) {
    throw badRequest('That issue has no description to build a test from. Paste the steps instead.');
  }

  // ── 2. Extract, match, dedupe — all deterministic ──────────────────────────

  const extracted = extractBugReport(reportText);

  const environment =
    (input.environmentId
      ? project.environments.find((e) => e.id === input.environmentId)
      : project.environments[0]) ?? null;
  if (input.environmentId && !environment) throw notFound('Environment');

  const flowMapRow = await prisma.flowMap.findFirst({
    where: { projectId: project.id, ...(environment ? { environmentId: environment.id } : {}) },
    orderBy: { version: 'desc' },
    select: { graph: true, version: true },
  });
  const flowMap = (flowMapRow?.graph as unknown as FlowMap | undefined) ?? null;

  const match = matchFlowMap(extracted, flowMap);

  /*
   * Disabled tests are excluded from the comparison on purpose. A test that has
   * been turned off does not cover anything, so letting one suppress generation
   * would answer "this bug already has a test" with a test that never runs.
   *
   * The cap is safe in the direction it fails. Reading every test's SOURCE on a
   * large suite is megabytes per request, and a duplicate this window misses
   * means QAAI writes a test that turns out to be redundant — which is the same
   * way the check already errs when it is unsure. Most-recently-touched first,
   * because a bug being reported now is most likely about work done lately.
   */
  const existing: CoveringTest[] = (
    await prisma.test.findMany({
      where: { projectId: project.id, disabledAt: null },
      orderBy: { updatedAt: 'desc' },
      take: MAX_DUPLICATE_CANDIDATES,
      select: { id: true, name: true, filePath: true, feature: true, code: true, tags: true },
    })
  ).map((t) => ({ ...t, code: t.code ?? '' }));

  const duplicates = findCoveringTests(extracted, match, existing);

  const planId = `repro-${Date.now()}`;
  const { item, notes } = buildReproPlanItem({ extracted, match, source, id: planId });

  if (duplicates.duplicateOf && !input.force) {
    await audit({
      actor,
      action: 'repro.duplicate',
      targetType: 'Project',
      targetId: project.id,
      metadata: { source: source.kind, duplicateOf: duplicates.duplicateOf.testId },
    });
    res.json({
      source,
      extracted,
      flowMatch: match,
      duplicate: duplicates.duplicateOf,
      duplicateCandidates: duplicates.candidates,
      planItem: item,
      notes: [
        `"${duplicates.duplicateOf.name}" already covers this — ${duplicates.duplicateOf.reasons.join('; ')}. ` +
          'No second test was written. Send force:true to write one anyway.',
        ...notes,
      ],
      test: null,
      run: null,
      reproduction: null,
    });
    return;
  }

  // ── 3. Generate ────────────────────────────────────────────────────────────

  const respond = (extra: Record<string, unknown>, status = 200) => {
    res.status(status).json({
      source,
      extracted,
      flowMatch: match,
      duplicate: null,
      duplicateCandidates: duplicates.candidates,
      planItem: item,
      notes,
      test: null,
      run: null,
      reproduction: null,
      ...extra,
    });
  };

  if (!flowMap) {
    // The Generator's locator context IS the flow map. Without one there is
    // nothing to generate against, and an empty map would be handed to the model
    // as a description of a site with no pages on it.
    notes.push(
      'No flow map exists for this project, so no test was written. Run the Explorer against this environment first.',
    );
    respond({ generation: { skipped: true, reason: 'no flow map' } });
    return;
  }

  if (!env.ANTHROPIC_API_KEY) {
    // A missing dependency is a SKIP with the hint, never a failure: the
    // extraction, the route match and the duplicate check are all still worth
    // having, and losing them because a key is unset helps nobody.
    notes.push(
      'No model is configured, so the structure above was extracted but no test was written. ' +
        'Set ANTHROPIC_API_KEY on the API to enable generation.',
    );
    respond({ generation: { skipped: true, reason: 'ANTHROPIC_API_KEY is not set' } });
    return;
  }

  let generated;
  try {
    generated = await generateTest(
      llmService(),
      { orgId: actor.orgId, projectId: project.id, agent: 'GENERATOR', subjectId: planId },
      {
        item,
        flowMap,
        language: project.primaryLanguage,
        framework: project.primaryFramework,
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, projectId: project.id }, 'repro generation failed');
    throw unprocessable(`The Generator could not write a test for that report: ${message}`);
  }

  const reviewFlags = [...generated.reviewFlags];
  if (fetchedFrom) {
    // Whoever reviews this needs to know the instructions behind it came from a
    // third party's text, not from someone in their own organisation.
    reviewFlags.push(
      `Written from ${fetchedFrom}, whose text QAAI did not author. Read the steps before running this against anything that matters.`,
    );
  }
  if (extracted.structureScore < 0.45) {
    reviewFlags.push(
      'The bug report gave up very little structure, so most of this test is inference rather than transcription.',
    );
  }
  reviewFlags.push(...notes);

  const suite = await prisma.suite.upsert({
    where: { projectId_name: { projectId: project.id, name: 'Reproductions' } },
    create: {
      orgId: actor.orgId,
      projectId: project.id,
      name: 'Reproductions',
      description: 'Tests written from bug reports',
    },
    update: {},
  });

  const filePath = await freeFilePath(project.id, generated.filePath);

  /*
   * Created DISABLED, and enabled only once the run has been seen to fail.
   *
   * A reproduction is a claim about the application, and until it has failed
   * the claim is unproven. Letting an unproven one into the suite means a green
   * test named after a bug sits in the gate forever, telling everyone who reads
   * the suite that the bug is covered.
   */
  const test = await prisma.test.create({
    data: {
      orgId: actor.orgId,
      projectId: project.id,
      suiteId: suite.id,
      name: generated.name,
      type: item.testType,
      feature: item.feature,
      priority: item.priority,
      code: generated.code,
      filePath,
      tags: ['repro', ...(source.kind === 'ISSUE' ? [source.provider.toLowerCase()] : [])],
      reviewFlags: reviewFlags.slice(0, 20),
      disabledAt: new Date(),
      versions: {
        create: {
          orgId: actor.orgId,
          version: 1,
          code: generated.code,
          source: 'GENERATOR',
          authorId: actor.userId || null,
          message: `Reproduction of ${source.kind === 'ISSUE' ? `${source.provider} ${source.key}` : 'a pasted bug report'}`,
        },
      },
    },
    select: { id: true, name: true, filePath: true, code: true, reviewFlags: true },
  });

  await audit({
    actor,
    action: 'repro.generate',
    targetType: 'Test',
    targetId: test.id,
    metadata: {
      source: source.kind,
      ...(source.kind === 'ISSUE' ? { provider: source.provider, key: source.key } : {}),
      structureScore: extracted.structureScore,
      startRoute: match.startRoute,
    },
  });

  const testPayload = { ...test, enabled: false };

  // ── 4. Run it, and judge the result honestly ───────────────────────────────

  if (!input.run || !environment) {
    if (!environment) {
      notes.push(
        'This project has no environment, so the reproduction was written but never executed. ' +
          'Until it has been seen to FAIL, nothing about the bug has been reproduced.',
      );
    }
    respond(
      {
        test: testPayload,
        reproduction: reproVerdict({ status: null, errorMessage: null, extracted }),
      },
      201,
    );
    return;
  }

  const verdict = await canStartRun(actor.orgId);
  if (!verdict.allowed) {
    const { plan } = await planFor(actor.orgId);
    // The test exists and is recorded; only the execution is blocked. Say which.
    throw planLimit(
      `${verdict.reason ?? 'Plan limit reached'} The reproduction was written (test ${test.id}) but not run.`,
      { limit: 'maxRunsPerMonth', plan },
    );
  }

  const run = await prisma.run.create({
    data: {
      orgId: actor.orgId,
      projectId: project.id,
      environmentId: environment.id,
      trigger: 'MANUAL',
      triggeredBy: actor.userId || null,
      totalCount: 1,
      results: { create: [{ orgId: actor.orgId, testId: test.id, status: 'SKIPPED' as const }] },
    },
    select: { id: true },
  });

  await prisma.usageRecord.upsert({
    where: { orgId_metric_period: { orgId: actor.orgId, metric: 'runs', period: currentPeriod() } },
    create: { orgId: actor.orgId, metric: 'runs', period: currentPeriod(), quantity: 1n },
    update: { quantity: { increment: 1n } },
  });

  await enqueue(
    QUEUE_NAMES.run,
    { orgId: actor.orgId, runId: run.id },
    { jobId: `run-${run.id}` },
  );

  const budget = input.waitMs ?? DEFAULT_WAIT_MS;
  const outcome = await waitForRun(run.id, test.id, budget);

  if (!outcome.finished) {
    // Not "it passed" and not "it failed". Anything else here would be a lie
    // about a run that is still going.
    respond(
      {
        test: testPayload,
        run: {
          id: run.id,
          status: outcome.runStatus,
          finished: false,
          waitedMs: outcome.waitedMs,
        },
        reproduction: reproVerdict({ status: null, errorMessage: null, extracted }),
        notes: [
          ...notes,
          `The run did not finish within ${Math.round(budget / 1000)}s. Poll GET /runs/${run.id} — until it finishes, nothing has been reproduced.`,
        ],
      },
      201,
    );
    return;
  }

  const reproduction = reproVerdict({
    status: outcome.result?.status ?? null,
    errorMessage: outcome.result?.errorMessage ?? null,
    extracted,
  });

  /*
   * Only a test that has been seen to fail is allowed into the suite. A green
   * reproduction stays disabled, and the response says so in the same breath as
   * it says the bug was not reproduced.
   */
  let enabled = false;
  if (reproduction.outcome === 'REPRODUCED') {
    await prisma.test.update({ where: { id: test.id }, data: { disabledAt: null } });
    enabled = true;
  }

  await audit({
    actor,
    action: 'repro.verdict',
    targetType: 'Test',
    targetId: test.id,
    metadata: {
      runId: run.id,
      outcome: reproduction.outcome,
      confirmed: reproduction.confirmed,
      resultStatus: outcome.result?.status ?? null,
      enabled,
    },
  });

  respond(
    {
      test: { ...testPayload, enabled },
      run: {
        id: run.id,
        status: outcome.runStatus,
        finished: true,
        waitedMs: outcome.waitedMs,
        result: outcome.result,
      },
      reproduction,
      notes:
        reproduction.outcome === 'REPRODUCED'
          ? notes
          : [
              `The test was left DISABLED because it did not fail. ${reproduction.headline}`,
              ...notes,
            ],
    },
    201,
  );
});
