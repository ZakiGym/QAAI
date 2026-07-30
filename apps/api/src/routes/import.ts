/**
 * Suite import (§7) — the migration wedge, API side.
 *
 * Detection is instant and runs in the request, so the user sees "this is a
 * Cypress suite, 14 tests" immediately and can correct the guess before paying
 * for a conversion. Conversion is enqueued because it calls the model and can
 * take a while — the worker owns it, the client polls.
 */

import { Router } from 'express';
import { QUEUE_NAMES } from '@qaai/shared';
import { SOURCE_FRAMEWORKS, detectFramework, type SourceFile } from '@qaai/agent';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { audit } from '../lib/audit.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const importRouter: Router = Router();

importRouter.use(requireAuth);

/** Guard against someone pasting a whole repo — this is a test suite, not a monorepo. */
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

/**
 * Upload a suite. Detects the framework synchronously and returns it with the
 * batch id; the client confirms (or overrides) the framework, then POSTs to
 * /convert. Detection is cheap enough to just do here.
 */
importRouter.post('/projects/:projectId/import', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const projectId = String(req.params.projectId);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const rawFiles = req.body?.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw badRequest('Upload at least one file: { files: [{ path, content }] }');
  }
  if (rawFiles.length > MAX_FILES) {
    throw badRequest(`Too many files (max ${MAX_FILES})`);
  }

  const files: SourceFile[] = rawFiles.map((f: unknown) => {
    const file = f as { path?: unknown; content?: unknown };
    return { path: String(file.path ?? ''), content: String(file.content ?? '') };
  });

  const totalBytes = files.reduce((sum, f) => sum + f.content.length, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw badRequest('Uploaded suite is too large (max 5MB)');
  }

  const detection = detectFramework(files);

  const batch = await prisma.importBatch.create({
    data: {
      orgId: actor.orgId,
      projectId,
      framework: detection.framework,
      detectionConfidence: detection.confidence,
      files: files as unknown as object,
      state: 'DETECTED',
      requestedBy: actor.userId,
    },
    select: { id: true, framework: true, detectionConfidence: true, state: true },
  });

  await audit({
    actor,
    action: 'import.detect',
    targetType: 'ImportBatch',
    targetId: batch.id,
    metadata: { framework: detection.framework, files: files.length },
  });

  res.status(201).json({
    batch,
    detection: {
      framework: detection.framework,
      confidence: detection.confidence,
      alternatives: detection.alternatives,
      evidence: detection.evidence,
      fileCount: files.length,
    },
  });
});

/**
 * Start the conversion. An optional `framework` overrides the detection — the
 * user might know better than the heuristic, so the guess is never binding.
 */
importRouter.post('/import/:batchId/convert', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const batch = await prisma.importBatch.findUnique({ where: { id: String(req.params.batchId) } });
  if (!batch) throw notFound('Import batch');

  // A finished import must not be re-run — it would insert the tests a second
  // time. Return the existing result instead of re-enqueuing.
  if (batch.state === 'DONE') {
    res
      .status(200)
      .json({ batch: { id: batch.id, framework: batch.framework, state: batch.state } });
    return;
  }

  // The override is user input; only a real framework is honoured, so a junk
  // value cannot flow through to tags, review flags, and the model prompt.
  const requested = typeof req.body?.framework === 'string' ? req.body.framework : null;
  const override =
    requested && (SOURCE_FRAMEWORKS as readonly string[]).includes(requested) ? requested : null;

  // Atomically claim the batch: only a DETECTED or ERRORED batch transitions to
  // CONVERTING. A concurrent second submit (a double-click) sees count 0 and
  // does not enqueue a second job — so the conversion runs once. Re-convert
  // after a failure still works because ERRORED is an allowed starting state.
  const claimed = await prisma.importBatch.updateMany({
    where: { id: batch.id, state: { in: ['DETECTED', 'ERRORED'] } },
    data: { state: 'CONVERTING', ...(override ? { framework: override } : {}) },
  });

  if (claimed.count === 0) {
    res
      .status(202)
      .json({
        batch: { id: batch.id, framework: override ?? batch.framework, state: 'CONVERTING' },
      });
    return;
  }

  await enqueue(
    QUEUE_NAMES.import,
    {
      orgId: actor.orgId,
      projectId: batch.projectId,
      importBatchId: batch.id,
      requestedBy: actor.userId,
    },
    // Non-idempotent: it inserts tests. One attempt only, so a transient failure
    // reports honestly instead of silently re-inserting on retry.
    { attempts: 1 },
  );

  await audit({
    actor,
    action: 'import.convert',
    targetType: 'ImportBatch',
    targetId: batch.id,
    metadata: { framework: override ?? batch.framework },
  });

  res.status(202).json({
    batch: { id: batch.id, framework: override ?? batch.framework, state: 'CONVERTING' },
  });
});

/** Poll the batch: state, summary, and how many tests it produced. */
importRouter.get('/import/:batchId', async (req, res) => {
  const batch = await prisma.importBatch.findUnique({
    where: { id: String(req.params.batchId) },
    select: {
      id: true,
      framework: true,
      detectionConfidence: true,
      state: true,
      summary: true,
      convertedCount: true,
      error: true,
      createdAt: true,
    },
  });
  if (!batch) throw notFound('Import batch');
  res.json({ batch });
});

/** Live conversion progress for the import screen. */
importRouter.get('/import/:batchId/events', async (req, res) => {
  const actor = actorOf(req);
  const batchId = String(req.params.batchId);
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { id: true },
  });
  if (!batch) throw notFound('Import batch');

  const { subscribe } = await import('../lib/events.js');
  const unsubscribe = subscribe(actor.orgId, `import:${batchId}`, res);
  req.on('close', unsubscribe);
});
