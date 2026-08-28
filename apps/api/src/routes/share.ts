/**
 * Public share links for a single run (§5) — sending a failure to a developer
 * who has no QAAI login.
 *
 * Until this existed the only way to show somebody a failure was to add them to
 * the organisation, which is a permanent grant of everything for a five-minute
 * conversation about one broken test. This is the narrow version of that: one
 * URL, one run, read-only, revocable.
 *
 * ── A public URL is a credential, and is treated as one ──────────────────────
 *
 * The token is 256 bits from `generateToken` and the database stores only
 * `hashToken(raw)` — the HMAC keyed on SESSION_SECRET that sessions, API keys,
 * invites and runner tokens already use. There is no second scheme here and no
 * way to recover a link: it is shown exactly once, at mint.
 *
 * The public reader below never opens a tenant scope, never reads `req.actor`,
 * and resolves exactly one row from the token — the run. It cannot be made to
 * answer a question about the project, the suite, the environment's URL, the
 * other runs, or the org, because it never learns their ids in a form it hands
 * back.
 *
 * ── What a public viewer sees, and what is held back ─────────────────────────
 *
 * A run contains more than a failure. It contains screenshots of the app under
 * test, the browser console, and a network log whose bodies and query strings
 * routinely carry bearer tokens, session cookies and customer data. Handing all
 * of that to whoever holds a URL is not sharing a bug report, it is exporting a
 * session recording.
 *
 * The line drawn here is STRUCTURE. Anything the runner recorded as fields —
 * step titles, statuses, assertions, error messages, findings, and the shape of
 * a network call — can be redacted with confidence, because we know what each
 * part is. Anything recorded as free text — console output, response bodies —
 * cannot: a JWT logged by the application under test is indistinguishable from
 * a stack trace to any rule we could write. So the structured evidence is
 * published, redacted; the unstructured evidence is withheld whole.
 *
 * Withholding it silently would be its own bug — a report that hides half the
 * evidence and does not say so sends the reader looking for a cause that is
 * sitting in the part they cannot see. So every payload carries a `withheld`
 * list, the page renders it, and the counts are real: "48 network requests
 * summarised, 112 console lines withheld" is a sentence the viewer can act on
 * by asking a colleague with a login.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────
 *
 * Artifact keys. `artifactKey()` builds `org/<orgId>/run/<runId>/<name>`, so a
 * key is an org id in a trench coat. Screenshots are therefore proxied through
 * this router by their step, never handed out as a key and never as a signed
 * bucket URL — which would leak the same string and outlive a revocation by an
 * hour on top of it.
 */

import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { prisma, unscoped } from '../lib/prisma.js';
import type { Prisma } from '../generated/prisma/client.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import { ApiError, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { storage } from '../lib/storage.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { actorOf, requireAuth, requireRole, requireScope } from '../middleware/auth.js';

export const shareRouter: Router = Router();

/** `sh_` + eight characters of the token: nameable, not usable. */
const SHARE_PREFIX = 'sh_';

/**
 * Ceiling on an explicit expiry, and the default when none is asked for.
 *
 * Thirty days is the default rather than "never" because the common case is a
 * link pasted into a pull request that is merged the same week, and a link that
 * outlives its reason is a credential nobody remembers holding. "Never" stays
 * available — it is a legitimate choice for a link in a long-lived incident
 * doc — but it has to be chosen, and the screen says which one is in force.
 */
const DEFAULT_EXPIRY_DAYS = 30;
const MAX_EXPIRY_DAYS = 365;

/**
 * Caps on the public payload. A red build with 128 failures is exactly the run
 * somebody shares, and an uncapped report of it is a multi-megabyte document
 * rendered by a browser that arrived from a chat message.
 */
const MAX_PUBLIC_RESULTS = 200;
const MAX_PUBLIC_STEPS = 200;
const MAX_PUBLIC_NETWORK = 60;
const MAX_PUBLIC_FINDINGS = 100;
/** Assertion values and error text are evidence, not documents. */
const MAX_TEXT = 4000;
const MAX_PATH = 200;

// ─── Redaction ───────────────────────────────────────────────────────────────

export interface PublicNetworkEntry {
  method: string;
  /** Path only. No origin, no query string, and no id-shaped path segment. */
  path: string;
  status: number | null;
  durationMs: number;
  /** True when the call did not go to the app under test. */
  thirdParty: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this path segment an identifier rather than a route?
 *
 * `/api/orders/8461/items` tells a developer which endpoint broke; the `8461`
 * tells them which customer, which is not theirs to know. The rule is
 * deliberately conservative in the direction of replacing too much: an all-digit
 * segment, a UUID, or any segment of eight or more characters that contains a
 * digit — which catches cuids, hashes, slugs with an id glued on, and dates.
 * A false positive costs a `:id` in place of a version number; a false negative
 * costs a customer's order id in a link anyone can open.
 */
function opaqueSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  if (/^\d+$/.test(segment)) return true;
  if (UUID.test(segment)) return true;
  return segment.length >= 8 && /\d/.test(segment);
}

/**
 * Reduce a recorded request URL to the part that is about the application and
 * not about the data.
 *
 * The origin is dropped entirely rather than kept for first-party calls. It has
 * to be: `Environment.baseUrl` is withheld from this payload, and on a preview
 * deploy that URL IS a credential — an unguessable hostname is the whole access
 * control on a Vercel or Netlify preview. Publishing it inside a network log
 * while withholding it from the header would be theatre.
 *
 * `thirdParty` survives instead, because "the failing call was to somebody
 * else's API" is the single most useful bit in a network log and it costs
 * nothing to say.
 */
export function publicPath(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Not a URL at all. Keeping it would publish an unparsed string of unknown
    // provenance; a placeholder says an entry was there without guessing.
    return '/…';
  }
  const path = url.pathname
    .split('/')
    .map((segment) => (opaqueSegment(segment) ? ':id' : segment))
    .join('/');
  return path.slice(0, MAX_PATH) || '/';
}

function originOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * The network log, reduced to its shape.
 *
 * `responseBodySnippet` is dropped and never sampled: it is captured for
 * non-2xx responses, which is precisely where an API puts the error object with
 * the request echoed back into it. The rest is four fields the runner recorded
 * as fields, so each one is redacted knowing what it is.
 */
export function redactNetwork(value: unknown, baseOrigin: string | null): PublicNetworkEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PublicNetworkEntry[] = [];
  for (const raw of value.slice(0, MAX_PUBLIC_NETWORK)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const url = typeof entry.url === 'string' ? entry.url : '';
    const entryOrigin = originOf(url);
    out.push({
      method: (typeof entry.method === 'string' ? entry.method : '').slice(0, 12).toUpperCase(),
      path: publicPath(url),
      status: typeof entry.status === 'number' ? entry.status : null,
      durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : 0,
      // Unknown origin is reported as first-party rather than third: the label
      // is used to draw attention, and drawing it at every unparsed row would
      // make it mean nothing.
      thirdParty: entryOrigin !== null && baseOrigin !== null && entryOrigin !== baseOrigin,
    });
  }
  return out;
}

function countEntries(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function text(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}\n… truncated` : value;
}

// ─── The public report ───────────────────────────────────────────────────────

interface WithheldNote {
  what: string;
  detail: string;
}

/**
 * `select` for the run behind a share link, written out rather than `include`d.
 *
 * Every column of Run, TestResult, Test and Step that this does NOT list is a
 * column a public viewer does not get, and a `select` makes that a decision
 * somebody wrote down instead of the residue of what happened to be in the
 * model. `orgId`, `projectId`, `suiteId`, `environmentId`, `runnerPool`,
 * `baseUrlOverride`, the test ids and the trace and video keys are all absent
 * on purpose.
 *
 * `environment.baseUrl` is selected and never published: it is needed to decide
 * which network calls were third-party, and dropped on the way out.
 */
const PUBLIC_RUN_SELECT = {
  id: true,
  status: true,
  trigger: true,
  queuedAt: true,
  startedAt: true,
  finishedAt: true,
  totalCount: true,
  passedCount: true,
  failedCount: true,
  flakyCount: true,
  skippedCount: true,
  errorMessage: true,
  stopReason: true,
  branch: true,
  commitSha: true,
  prNumber: true,
  environment: { select: { name: true, kind: true, baseUrl: true } },
  results: {
    /*
     * By id, which for a cuid is by creation time — and, unlike `createdAt`,
     * cannot tie. Results are written a whole run at a time, so `createdAt`
     * carries the same timestamp for a hundred rows and the order they come
     * back in would be whatever the planner felt like. A report whose failures
     * are in a different order on every refresh is one nobody trusts.
     */
    orderBy: { id: 'asc' },
    take: MAX_PUBLIC_RESULTS,
    select: {
      status: true,
      durationMs: true,
      errorMessage: true,
      retriedAndPassed: true,
      network: true,
      consoleLog: true,
      videoKey: true,
      traceKey: true,
      test: { select: { name: true, type: true, priority: true, filePath: true } },
      steps: {
        orderBy: { index: 'asc' },
        take: MAX_PUBLIC_STEPS,
        select: {
          id: true,
          index: true,
          title: true,
          status: true,
          durationMs: true,
          errorMessage: true,
          errorStack: true,
          selector: true,
          expected: true,
          actual: true,
          screenshotKey: true,
        },
      },
      findings: {
        take: MAX_PUBLIC_FINDINGS,
        select: {
          id: true,
          kind: true,
          severity: true,
          code: true,
          message: true,
          location: true,
          helpUrl: true,
        },
      },
    },
  },
} as const;

type SharedRun = Prisma.RunGetPayload<{ select: typeof PUBLIC_RUN_SELECT }>;

/**
 * Turn the run into the document a stranger reads.
 *
 * Nothing is passed through: every field on the way out is named here, so a
 * column added to Run or Step next year is private until somebody adds it to
 * this function on purpose.
 */
function buildReport(run: SharedRun, share: { expiresAt: Date | null }) {
  const baseOrigin = originOf(run.environment.baseUrl);

  let networkSummarised = 0;
  let consoleWithheld = 0;
  let traces = 0;
  let videos = 0;

  const results = run.results.map((result) => {
    const network = redactNetwork(result.network, baseOrigin);
    const networkTotal = countEntries(result.network);
    const consoleTotal = countEntries(result.consoleLog);
    networkSummarised += networkTotal;
    consoleWithheld += consoleTotal;
    if (result.traceKey) traces += 1;
    if (result.videoKey) videos += 1;

    return {
      name: result.test.name,
      type: result.test.type,
      priority: result.test.priority,
      filePath: result.test.filePath,
      status: result.status,
      durationMs: result.durationMs,
      errorMessage: text(result.errorMessage),
      retriedAndPassed: result.retriedAndPassed,
      steps: result.steps.map((step) => ({
        index: step.index,
        title: step.title,
        status: step.status,
        durationMs: step.durationMs,
        errorMessage: text(step.errorMessage),
        errorStack: text(step.errorStack),
        selector: text(step.selector),
        expected: text(step.expected),
        actual: text(step.actual),
        /*
         * The address of the screenshot, and the reason it is a step id rather
         * than an ordinal: a run that is still executing gains results between
         * two requests, and an ordinal into a recomputed list would silently
         * shift under the reader — the picture under "step 4" would become
         * somebody else's. A step id addresses a row INSIDE this run and is
         * re-checked against the link's run on every fetch, so it grants
         * nothing an ordinal would not have.
         */
        screenshot: step.screenshotKey ? step.id : null,
      })),
      findings: result.findings.map((finding) => ({
        id: finding.id,
        kind: finding.kind,
        severity: finding.severity,
        code: finding.code,
        message: text(finding.message),
        location: finding.location,
        helpUrl: finding.helpUrl,
      })),
      network,
      networkTotal,
      consoleTotal,
    };
  });

  const withheld: WithheldNote[] = [];
  if (networkSummarised > 0) {
    withheld.push({
      what: `${networkSummarised} network request${networkSummarised === 1 ? '' : 's'}, summarised`,
      detail:
        'Method, path, status and duration are shown. Request and response bodies, query strings, headers and hostnames are not — they routinely carry access tokens and customer data. Id-shaped path segments are replaced with :id.',
    });
  }
  if (consoleWithheld > 0) {
    withheld.push({
      what: `${consoleWithheld} console line${consoleWithheld === 1 ? '' : 's'}, withheld`,
      detail:
        'Browser console output is free text written by the application under test. There is no rule that reliably tells a stack trace from a logged access token, so none of it is published here.',
    });
  }
  if (traces > 0 || videos > 0) {
    withheld.push({
      what: `${traces + videos} recording${traces + videos === 1 ? '' : 's'}, withheld`,
      detail:
        'A trace is a full replay of the browser session — every DOM snapshot, request and response. It is available to anyone signed in to the workspace.',
    });
  }
  withheld.push({
    what: 'The workspace around this run',
    detail:
      'This link resolves one run. The project, the suite, the other runs, the environment URL and everything else in the workspace are not reachable from it.',
  });

  return {
    /*
     * The last eight characters of the run id, and not the id. It is what the
     * cockpit already prints on the run header, so a viewer quoting it in a
     * message is quoting something a colleague can find — while the id itself,
     * which addresses the run through the authenticated API, stays inside.
     */
    reference: run.id.slice(-8),
    status: run.status,
    trigger: run.trigger,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    totals: {
      total: run.totalCount,
      passed: run.passedCount,
      failed: run.failedCount,
      flaky: run.flakyCount,
      skipped: run.skippedCount,
    },
    errorMessage: text(run.errorMessage),
    stopReason: text(run.stopReason),
    // The CI context is on the run and is what makes the report actionable for
    // the person receiving it — it is their branch and their commit.
    branch: run.branch,
    commitSha: run.commitSha ? run.commitSha.slice(0, 12) : null,
    prNumber: run.prNumber,
    // Name and kind only. `baseUrl` was selected to classify the network log
    // and is dropped here; see the note on PUBLIC_RUN_SELECT.
    environment: { name: run.environment.name, kind: run.environment.kind },
    results,
    truncatedResults: Math.max(0, run.totalCount - results.length),
    withheld,
    expiresAt: share.expiresAt,
  };
}

// ─── Resolving a link ────────────────────────────────────────────────────────

/**
 * Revoked and expired are 410, not 404.
 *
 * They are distinguishable only to somebody already holding the token, so the
 * distinction leaks nothing — and it is the difference between a developer
 * asking for a fresh link and a developer concluding the tool is broken.
 */
const revoked = () =>
  new ApiError(410, 'LINK_REVOKED', 'This share link was turned off by the team that created it.');
const expired = () => new ApiError(410, 'LINK_EXPIRED', 'This share link has expired.');

interface ResolvedShare {
  id: string;
  orgId: string;
  runId: string;
  expiresAt: Date | null;
}

/**
 * Token → share row, with no session involved and no tenant scope open.
 *
 * `unscoped` is mandatory here rather than convenient: there is no org in scope
 * on an anonymous request, so a scoped read would throw before it read
 * anything. The scope is replaced by the token itself — every query downstream
 * is keyed on `share.runId`, which came from a row found by the HMAC of a
 * secret the caller presented.
 */
async function resolveShare(rawToken: string): Promise<ResolvedShare> {
  if (typeof rawToken !== 'string' || rawToken.length < 16 || rawToken.length > 200) {
    throw notFound('Share link');
  }

  const share = await unscoped(() =>
    prisma.runShare.findUnique({
      where: { tokenHash: hashToken(rawToken) },
      select: { id: true, orgId: true, runId: true, expiresAt: true, revokedAt: true },
    }),
  );

  if (!share) throw notFound('Share link');
  if (share.revokedAt) throw revoked();
  if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) throw expired();

  return { id: share.id, orgId: share.orgId, runId: share.runId, expiresAt: share.expiresAt };
}

/**
 * A public page must never be indexed. The URL is the credential, and a search
 * engine that finds one has published it. The `<meta>` on the page says the
 * same thing; this covers the JSON and the images, which have no head.
 */
function publicHeaders(res: Response): void {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

// ─── The public endpoints — no session, ever ─────────────────────────────────

/**
 * The report.
 *
 * `req.actor` is never read in this handler, and that is a property worth
 * stating: a link that quietly behaved differently for a signed-in viewer would
 * be a link nobody could test, because the person testing it is signed in.
 */
shareRouter.get('/share/:token', async (req, res) => {
  publicHeaders(res);
  const share = await resolveShare(String(req.params.token));

  const run = await unscoped(() =>
    prisma.run.findUnique({ where: { id: share.runId }, select: PUBLIC_RUN_SELECT }),
  );

  // The run is gone — swept by retention, or its project deleted. The share row
  // cascades with it, so this is close to unreachable; if it happens, the link
  // is dead rather than broken.
  if (!run) throw notFound('Share link');

  /*
   * "Has anyone actually opened it?" is the first thing the minter wants to
   * know, and an anonymous read produces no audit row to answer it from. The
   * counter is the record. Fire-and-forget: a viewer must never see a failed
   * counter update as a failed report.
   */
  void unscoped(() =>
    prisma.runShare.update({
      where: { id: share.id },
      data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
    }),
  ).catch((err: unknown) => logger.warn({ err }, 'share view counter update failed'));

  res.json({ report: buildReport(run, share) });
});

/**
 * One screenshot, proxied.
 *
 * Not a redirect to a signed bucket URL, which is what the authenticated
 * artifact route does: that URL contains the object key, the key contains the
 * org id and the run id, and it keeps working for an hour after the link is
 * revoked. Proxying costs us the bytes and buys revocation that is actually
 * immediate.
 */
shareRouter.get('/share/:token/screenshot/:stepId', async (req, res) => {
  publicHeaders(res);
  const share = await resolveShare(String(req.params.token));

  const step = await unscoped(() =>
    prisma.step.findUnique({
      where: { id: String(req.params.stepId) },
      select: { screenshotKey: true, testResult: { select: { runId: true } } },
    }),
  );

  // The step must be under THIS link's run. Without this line a step id from
  // any run in the install would resolve — which is exactly the shape of leak
  // this whole file exists to prevent.
  if (!step?.screenshotKey || step.testResult.runId !== share.runId) throw notFound('Screenshot');

  const artifact = await unscoped(() =>
    prisma.artifact.findUnique({
      where: { key: step.screenshotKey! },
      select: { runId: true, contentType: true },
    }),
  );

  /*
   * Two more checks that look redundant and are not. The runId check catches a
   * screenshotKey that points outside its own run; the content-type check means
   * that even if one did, this endpoint can only ever emit an image — it can
   * never be turned into a reader for the trace zip or the video, which are the
   * two artifacts deliberately withheld from the report above.
   */
  if (!artifact || artifact.runId !== share.runId) throw notFound('Screenshot');
  if (!artifact.contentType.startsWith('image/')) throw notFound('Screenshot');

  const body = await storage.get(step.screenshotKey);
  res.setHeader('Content-Type', artifact.contentType);
  // `private`, so no shared cache holds a copy a revocation cannot reach, and
  // short, so a revoked link stops showing pictures within minutes rather than
  // for as long as the tab is open.
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(body);
});

// ─── The authenticated half — mint, read, revoke ─────────────────────────────

const mintSchema = z.object({
  /**
   * Absent means the default; explicit `null` means no expiry at all. The two
   * have to be distinguishable, because "the user did not say" and "the user
   * chose forever" are different decisions and only one of them should produce
   * a link with no deadline.
   */
  expiresInDays: z.number().int().min(1).max(MAX_EXPIRY_DAYS).nullable().optional(),
});

/** Never the token, and never the hash. */
const SHARE_STATE_SELECT = {
  id: true,
  tokenPrefix: true,
  expiresAt: true,
  createdAt: true,
  createdBy: true,
  viewCount: true,
  lastViewedAt: true,
} as const;

/**
 * The live link on a run, if there is one.
 *
 * Scoped: `prisma` here is the tenant-scoped client and the request is inside
 * `withTenant`, so another org's runId finds that org's rows — of which this
 * caller can see none — and comes back as "no link", never as an error that
 * confirms the run exists.
 */
async function liveShare(runId: string) {
  const share = await prisma.runShare.findFirst({
    where: { runId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: SHARE_STATE_SELECT,
  });
  if (!share) return null;
  // An expired link is not live. Reporting it as live would put "shared" on the
  // run page for a URL that answers 410.
  if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) return null;
  return share;
}

/**
 * The run must exist, in THIS org, before anything is minted for it.
 *
 * The lookup is what enforces tenancy: the id comes off the URL, and the scoped
 * client turns another org's run into `null` — which becomes the same 404 a
 * made-up id gets, so the endpoint is not an existence oracle for other
 * people's runs.
 */
async function ownedRun(runId: string): Promise<{ id: string }> {
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { id: true } });
  if (!run) throw notFound('Run');
  return run;
}

shareRouter.get('/runs/:runId/share', requireAuth, async (req, res) => {
  const run = await ownedRun(String(req.params.runId));
  res.json({ share: await liveShare(run.id) });
});

/**
 * Mint a link.
 *
 * Minting REPLACES whatever live link the run had. The alternative — refusing
 * with a conflict — reads as safer and is worse in practice: the old token
 * cannot be shown again by construction, so a person who lost the link and
 * pressed the button would be told "there is already a link" and handed no way
 * to get one. Replacing gives them a working URL and turns the lost one off,
 * which is the outcome they wanted from a button labelled "replace".
 */
shareRouter.post(
  '/runs/:runId/share',
  requireAuth,
  requireRole('MEMBER'),
  requireScope('runs:write'),
  async (req, res) => {
    const actor = actorOf(req);
    const run = await ownedRun(String(req.params.runId));
    const input = mintSchema.parse(req.body ?? {});

    const days = input.expiresInDays === undefined ? DEFAULT_EXPIRY_DAYS : input.expiresInDays;
    const expiresAt = days === null ? null : new Date(Date.now() + days * 86_400_000);

    const { count: replaced } = await prisma.runShare.updateMany({
      where: { runId: run.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const raw = generateToken();
    const share = await prisma.runShare.create({
      data: {
        orgId: actor.orgId,
        runId: run.id,
        tokenHash: hashToken(raw),
        tokenPrefix: `${SHARE_PREFIX}${raw.slice(0, 8)}`,
        expiresAt,
        createdBy: actor.userId || null,
      },
      select: SHARE_STATE_SELECT,
    });

    await audit({
      actor,
      action: 'run.share.create',
      targetType: 'Run',
      targetId: run.id,
      // The prefix, never the token. An audit log that records credentials is a
      // credential store with worse access control.
      metadata: {
        shareId: share.id,
        tokenPrefix: share.tokenPrefix,
        expiresAt,
        // Named because "why did the link I sent stop working" is answered by
        // this number and by nothing else in the row.
        replacedLinks: replaced,
      },
    });

    res.status(201).json({
      share,
      // Shown exactly once. There is no endpoint that can return it again.
      url: `${env.WEB_PUBLIC_URL}/share/${raw}`,
      replacedLinks: replaced,
    });
  },
);

/** Revoke. Idempotent — a second press is not an error. */
shareRouter.delete(
  '/runs/:runId/share',
  requireAuth,
  requireRole('MEMBER'),
  requireScope('runs:write'),
  async (req, res) => {
    const actor = actorOf(req);
    const run = await ownedRun(String(req.params.runId));

    const { count } = await prisma.runShare.updateMany({
      where: { runId: run.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Audited even at zero: "somebody tried to turn this link off and there was
    // nothing to turn off" is a fact worth having in the trail, and skipping it
    // would make the log depend on a race.
    await audit({
      actor,
      action: 'run.share.revoke',
      targetType: 'Run',
      targetId: run.id,
      metadata: { revokedLinks: count },
    });

    res.json({ revokedLinks: count });
  },
);
