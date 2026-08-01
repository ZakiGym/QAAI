/**
 * The trace endpoints (§8) — the evidence, served as JSON instead of a zip.
 *
 * MOUNT (apps/api/src/index.ts, alongside the other routers):
 *
 *     import { traceRouter } from './routes/trace.js';
 *     app.use('/trace', traceRouter);
 *
 * Everything here is scoped by `requireAuth` exactly like `/runs`, because a
 * trace is the most sensitive artifact QAAI holds: it contains the customer's
 * own DOM, their request headers and their response bodies. It is never handed
 * out as a bucket URL and never served as `text/html` from this origin — the
 * rebuilt markup travels inside a JSON string so that a stray navigation to an
 * API URL can never render somebody's application in our own origin.
 *
 * The shape is deliberately paginated rather than one fat document:
 *
 *   GET /trace/:runId/:resultId                   timeline + meta, no payloads
 *   GET /trace/:runId/:resultId/actions/:actionId log, network, console, frame
 *   GET /trace/:runId/:resultId/snapshot?name=…   one rebuilt DOM snapshot
 *   GET /trace/:runId/:resultId/resource/:sha1    screencast frame / attachment
 *
 * A 200MB trace does not become a 200MB response: you fetch the one action you
 * are looking at. Anything that could not be parsed comes back as an
 * `unavailable` reason with words in it, never as a 500 and never as a blank.
 */

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { storage } from '../lib/storage.js';
import { logger } from '../lib/logger.js';
import {
  MAX_TRACE_BYTES,
  actionDetail,
  cachedTrace,
  renderSnapshot,
  resourceBody,
} from '../lib/trace.js';
import type { ParsedTrace, TraceUnavailableReason } from '../lib/trace.js';

export const traceRouter: Router = Router();

traceRouter.use(requireAuth);

/**
 * Why a viewer has nothing to show, in the words the empty state prints.
 *
 * `retain-on-failure` is the runner's setting, so "there is no trace" is the
 * normal state of a green test rather than a fault — saying so is the difference
 * between a user filing a bug and a user moving on.
 */
const UNAVAILABLE_COPY: Record<TraceUnavailableReason, string> = {
  NOT_RECORDED:
    'This test kept no trace. Two reasons account for almost every case: tracing runs as ' +
    'retain-on-failure, so a test that passed on its first attempt discards it — and API, load, ' +
    'contract, database and security-smoke tests never drive a browser, so there is no DOM, ' +
    'no network panel and no trace to record for them.',
  MISSING:
    'The trace for this test was recorded but is no longer in storage — artifact retention on ' +
    'this plan has already swept it. Re-run the test to capture a fresh one.',
  TOO_LARGE:
    `This trace is larger than ${Math.round(MAX_TRACE_BYTES / (1024 * 1024))}MB, which is more ` +
    'than the viewer will unpack. Download it and open it in the Playwright trace viewer, or ' +
    'shorten the test so it records less.',
  UNREADABLE:
    'This trace could not be unpacked — the file is truncated or corrupt, which usually means the ' +
    'run was killed while Playwright was still writing it. Re-run the test to capture a new one.',
  EMPTY:
    'This trace unpacked cleanly but holds no recorded actions. That happens when tracing was ' +
    'turned on after the test had already finished its work.',
};

interface ResolvedResult {
  runId: string;
  resultId: string;
  testName: string;
  status: string;
  errorMessage: string | null;
  traceKey: string | null;
  videoKey: string | null;
}

/** The test result, its trace key, and the tenancy check, in one place. */
async function resolveResult(runId: string, resultId: string): Promise<ResolvedResult> {
  const result = await prisma.testResult.findUnique({
    where: { id: resultId },
    select: {
      id: true,
      runId: true,
      status: true,
      errorMessage: true,
      traceKey: true,
      videoKey: true,
      test: { select: { name: true } },
    },
  });
  // Same message for "no such result" and "not in this run": the endpoint must
  // not tell a caller which of the two it got wrong.
  if (!result || result.runId !== runId) throw notFound('Test result');

  return {
    runId: result.runId,
    resultId: result.id,
    testName: result.test.name,
    status: result.status,
    errorMessage: result.errorMessage,
    traceKey: result.traceKey,
    videoKey: result.videoKey,
  };
}

type LoadOutcome = { ok: true; trace: ParsedTrace } | { ok: false; reason: TraceUnavailableReason };

/**
 * Fetch and parse, or explain why not.
 *
 * Storage failures are downgraded to MISSING rather than thrown: a swept
 * artifact is an expected state of the world, and a 500 in the evidence pane is
 * exactly the failure mode this whole feature exists to remove.
 */
async function loadTrace(result: ResolvedResult): Promise<LoadOutcome> {
  if (!result.traceKey) return { ok: false, reason: 'NOT_RECORDED' };

  const artifact = await prisma.artifact.findUnique({
    where: { key: result.traceKey },
    select: { runId: true, sizeBytes: true },
  });
  if (!artifact || artifact.runId !== result.runId) return { ok: false, reason: 'MISSING' };
  // sizeBytes is only stamped by newer uploads, so a zero means "unknown", not
  // "empty" — the real check happens against the downloaded buffer below.
  if (artifact.sizeBytes > MAX_TRACE_BYTES) return { ok: false, reason: 'TOO_LARGE' };

  try {
    const trace = await cachedTrace(result.traceKey, async () => {
      const bytes = await storage.get(result.traceKey!);
      if (bytes.length > MAX_TRACE_BYTES) {
        throw new TooLarge();
      }
      return bytes;
    });
    if (trace.actions.length === 0) return { ok: false, reason: 'EMPTY' };
    return { ok: true, trace };
  } catch (err) {
    if (err instanceof TooLarge) return { ok: false, reason: 'TOO_LARGE' };
    // Distinguishing "gone" from "corrupt" matters: one tells you to re-run, the
    // other tells you the run died mid-write.
    const message = err instanceof Error ? err.message : String(err);
    const missing = /not ?found|no such file|ENOENT|NoSuchKey/i.test(message);
    if (!missing) logger.warn({ err: message, key: result.traceKey }, 'trace parse failed');
    return { ok: false, reason: missing ? 'MISSING' : 'UNREADABLE' };
  }
}

class TooLarge extends Error {}

function unavailable(reason: TraceUnavailableReason) {
  return {
    trace: {
      available: false as const,
      reason,
      message: UNAVAILABLE_COPY[reason],
    },
  };
}

// ─── The timeline ────────────────────────────────────────────────────────────

traceRouter.get('/:runId/:resultId', async (req, res) => {
  const result = await resolveResult(String(req.params.runId), String(req.params.resultId));
  const outcome = await loadTrace(result);

  const test = {
    resultId: result.resultId,
    name: result.testName,
    status: result.status,
    errorMessage: result.errorMessage,
    /** The escape hatch stays: some people really do want the zip. */
    traceKey: result.traceKey,
    videoKey: result.videoKey,
  };

  if (!outcome.ok) {
    res.json({ test, ...unavailable(outcome.reason) });
    return;
  }

  const { trace } = outcome;
  res.json({
    test,
    trace: {
      available: true as const,
      meta: trace.meta,
      // Payload-free: every action carries counts, and the caller fetches the
      // one it is looking at. This is what keeps a huge trace out of the tab.
      actions: trace.actions,
      attachments: trace.attachments,
      counts: {
        actions: trace.actions.length,
        network: trace.network.length,
        console: trace.console.length,
      },
      limits: trace.limits,
    },
  });
});

// ─── One action ──────────────────────────────────────────────────────────────

traceRouter.get('/:runId/:resultId/actions/:actionId', async (req, res) => {
  const result = await resolveResult(String(req.params.runId), String(req.params.resultId));
  const outcome = await loadTrace(result);
  if (!outcome.ok) {
    res.json(unavailable(outcome.reason));
    return;
  }

  const actionId = String(req.params.actionId);
  const action = outcome.trace.actions.find((candidate) => candidate.id === actionId);
  if (!action) throw notFound('Action');

  res.json({ action, detail: actionDetail(outcome.trace, action) });
});

// ─── One rebuilt DOM snapshot ────────────────────────────────────────────────

traceRouter.get('/:runId/:resultId/snapshot', async (req, res) => {
  const result = await resolveResult(String(req.params.runId), String(req.params.resultId));
  const name = typeof req.query.name === 'string' ? req.query.name : '';
  if (!name) throw badRequest('A snapshot name is required');

  const outcome = await loadTrace(result);
  if (!outcome.ok) {
    res.json(unavailable(outcome.reason));
    return;
  }

  const snapshot = renderSnapshot(outcome.trace, name);
  if (!snapshot) throw notFound('Snapshot');

  /*
   * JSON, not text/html, and it matters. The body is the customer's own markup;
   * returning it with an HTML content type would make this URL a page that
   * renders their application inside our API origin. Wrapped in JSON it can only
   * ever be put into the sandboxed iframe the viewer builds for it.
   */
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.json({ snapshot });
});

// ─── Screencast frames and attachments ───────────────────────────────────────

/** Names come out of the trace itself, so they are checked, not trusted. */
const SAFE_SHA1 = /^[A-Za-z0-9@._-]{1,200}$/;

const MAGIC: Array<{ prefix: number[]; type: string }> = [
  { prefix: [0xff, 0xd8, 0xff], type: 'image/jpeg' },
  { prefix: [0x89, 0x50, 0x4e, 0x47], type: 'image/png' },
  { prefix: [0x47, 0x49, 0x46, 0x38], type: 'image/gif' },
];

/**
 * Content type from the bytes, not from the name.
 *
 * The alternative is trusting a string that came out of a customer's trace file
 * and using it to label a response, which is how a `.jpeg` full of markup gets
 * served as HTML.
 */
function sniff(body: Buffer): string {
  for (const { prefix, type } of MAGIC) {
    if (prefix.every((byte, index) => body[index] === byte)) return type;
  }
  if (body.subarray(0, 64).includes(Buffer.from('<svg'))) return 'image/svg+xml';
  return 'application/octet-stream';
}

traceRouter.get('/:runId/:resultId/resource/:sha1', async (req, res) => {
  const result = await resolveResult(String(req.params.runId), String(req.params.resultId));
  const sha1 = String(req.params.sha1);
  if (!SAFE_SHA1.test(sha1)) throw badRequest('Invalid resource name');

  const outcome = await loadTrace(result);
  if (!outcome.ok) throw notFound('Resource');

  const body = resourceBody(outcome.trace, sha1);
  if (!body) throw notFound('Resource');

  const type = sniff(body);
  res
    .setHeader('X-Content-Type-Options', 'nosniff')
    .setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    // Never inline: an attachment could be anything, and a bucket of customer
    // bytes rendered in our origin is the one thing this router must not do.
    .setHeader('Content-Disposition', 'attachment')
    .setHeader('Cache-Control', 'private, max-age=3600')
    .type(type)
    .send(body);
});

/**
 * Text attachments — Playwright's `error-context` markdown in particular, which
 * is the accessibility tree of the page at the moment it failed. It is the most
 * directly useful thing in the whole zip and it is unreadable as a download.
 */
traceRouter.get('/:runId/:resultId/text/:sha1', async (req, res) => {
  const result = await resolveResult(String(req.params.runId), String(req.params.resultId));
  const sha1 = String(req.params.sha1);
  if (!SAFE_SHA1.test(sha1)) throw badRequest('Invalid resource name');

  const outcome = await loadTrace(result);
  if (!outcome.ok) throw notFound('Resource');

  const body = resourceBody(outcome.trace, sha1);
  if (!body) throw notFound('Resource');

  const MAX_TEXT = 512 * 1024;
  const truncated = body.length > MAX_TEXT;
  res.json({ text: body.subarray(0, MAX_TEXT).toString('utf8'), truncated });
});
