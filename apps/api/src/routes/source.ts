/**
 * Application source ingestion (§7) — "here is my app; learn it".
 *
 * The product had exactly one way in until now, and it assumed a running URL:
 * point the Explorer at an environment and it crawls. That is the right answer
 * when there is something to crawl, and no answer at all before there is —
 * which is the situation of every user who has just written the thing and wants
 * tests for it, and of every user whose staging box is behind a VPN we cannot
 * reach.
 *
 * The other way in was `/import`, and its subject is a TEST SUITE: upload your
 * Cypress specs, we convert them. Nothing in this codebase accepted an
 * APPLICATION and read it.
 *
 * So this route does two things to one upload, and they are two different
 * questions that were both already answered in `@qaai/shared`:
 *
 *   detectProject()   how would you RUN this repo's tests? — languages, package
 *                     managers, runners, invocations, workspaces. Roughly 1300
 *                     lines, fully tested, and until this route existed it was
 *                     called by nothing outside its own test file. Wiring it is
 *                     most of what this endpoint is.
 *   analyseCodebase() what does this application EXPOSE? — routes, endpoints,
 *                     forms and auth surfaces, with the file and the observation
 *                     behind each one.
 *
 * Both are pure functions of the upload, both are fast, and both run inside the
 * request for the same reason detection does in import.ts: the user is looking
 * at a spinner and the answer is cheap. Nothing here calls a model, so this
 * endpoint behaves identically on a deployment with no ANTHROPIC_API_KEY.
 *
 * The honesty rule this file inherits and must not break: a static read cannot
 * know what the application does at runtime. The response says so at the top
 * level, in `limits`, rather than leaving a caller to infer it from an
 * unexpectedly short list — and it says which detectors ran and which found
 * nothing, because "no endpoints" and "nothing looked for endpoints" are
 * different answers that an empty array cannot tell apart.
 */

import { Router } from 'express';
import { analyseCodebase, detectProject, summariseAnalysis } from '@qaai/shared';
import type { RepoFile } from '@qaai/shared';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { enqueue } from '../lib/queues.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const sourceRouter: Router = Router();

sourceRouter.use(requireAuth);

/**
 * The same guards import.ts uses, for the same reason — a browser posting a repo
 * is a real denial-of-service surface — with one difference that follows from
 * the input rather than from taste.
 *
 * `RepoFile.content` is OPTIONAL (detect.ts:70, "a listing is often cheap (a git
 * tree) while contents are not"), and both analyses genuinely work on paths
 * alone for the file-convention half of their answer. So the FILE COUNT ceiling
 * is higher than import.ts's 200 — an application is not a suite, and 200 files
 * does not describe one — while the BYTE ceiling is import.ts's exactly. Bytes
 * are what costs; a path is forty characters.
 *
 * Note which of these actually binds first: `express.json({ limit: '2mb' })` in
 * index.ts rejects the request body before any handler sees it, so the 5MB check
 * below is a second line of defence and not the real limit. It is kept because
 * the parser limit is a global that could change, and because a guard that
 * states the intended ceiling next to the code it protects is worth its two
 * lines.
 */
const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
/** One file cannot be the whole budget; a minified bundle teaches us nothing. */
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Read the upload into `RepoFile[]`.
 *
 * `content` is preserved as UNDEFINED when absent rather than coerced to `''`.
 * import.ts does coerce (`String(file.content ?? '')`) and is right to, because
 * every file it receives is a test it must convert. Here the difference is
 * load-bearing in both directions: an empty string means "this file is empty",
 * an absent one means "we were not shown this file", and the analysis reports
 * the second as a gap in its input. Flattening them would turn "we could not
 * read your route handler" into "your route handler declares nothing".
 */
function readFiles(raw: unknown): { files: RepoFile[]; totalBytes: number; withContent: number } {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw badRequest('Upload at least one file: { files: [{ path, content? }] }');
  }
  if (raw.length > MAX_FILES) {
    throw badRequest(
      `Too many files (max ${MAX_FILES}). Exclude vendored directories, or send one workspace at a time.`,
    );
  }

  const files: RepoFile[] = [];
  let totalBytes = 0;
  let withContent = 0;

  for (const entry of raw) {
    const file = entry as { path?: unknown; content?: unknown };
    const path = typeof file.path === 'string' ? file.path : '';
    if (!path) continue;
    totalBytes += path.length;

    if (typeof file.content !== 'string') {
      files.push({ path });
      continue;
    }
    // Truncate rather than reject: one generated bundle in an otherwise normal
    // upload should not fail the whole ingest, and the analysis already reports
    // truncation as a warning the user can read.
    const content = file.content.slice(0, MAX_FILE_BYTES);
    totalBytes += content.length;
    withContent++;
    files.push({ path, content });
  }

  if (files.length === 0) {
    throw badRequest('No file had a usable path: { files: [{ path, content? }] }');
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw badRequest(
      'Uploaded source is too large (max 5MB). Send file paths without contents for the parts you ' +
        'do not need read — routes are still derived from the layout.',
    );
  }

  return { files, totalBytes, withContent };
}

/**
 * The paragraph a user reads first.
 *
 * Assembled from the two analyses rather than written as copy, so it cannot
 * describe a result the code did not produce — and it states the limitation
 * before the findings, not after them.
 */
function honestSummary(
  detection: ReturnType<typeof detectProject>,
  analysis: ReturnType<typeof analyseCodebase>,
): string {
  const parts: string[] = [summariseAnalysis(analysis)];

  if (detection.candidates.length > 0) {
    const top = detection.candidates[0]!;
    parts.push(
      `Its tests appear to run with ${top.label}${
        detection.candidates.length > 1 ? ` (${detection.candidates.length} runners found)` : ''
      }.`,
    );
  } else {
    parts.push('No test runner was detected, so QAAI is not guessing a framework for this repo.');
  }

  parts.push(
    'What this cannot tell you: whether any of it works, what happens after a form is submitted, ' +
      'which pages need a login, or anything that only exists at runtime. Crawling a running ' +
      'environment is what establishes those.',
  );

  return parts.join(' ');
}

/**
 * Ingest an application's source and analyse it.
 *
 * Both analyses run synchronously — they are pure, in-memory, and take
 * milliseconds on a real repo — so the client gets the whole answer in the
 * response rather than a batch id to poll. Nothing is enqueued because nothing
 * needs a worker: there is no model call anywhere in this path.
 */
sourceRouter.post('/projects/:projectId/source', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const projectId = String(req.params.projectId);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const { files, totalBytes, withContent } = readFiles(req.body?.files);

  const detection = detectProject(files);
  const analysis = analyseCodebase(files);

  // Paths only. The bodies were needed to produce the analysis above and are of
  // no use to anything afterwards — see the schema comment on CodebaseSnapshot.
  const paths = files.map((file) => file.path);

  const snapshot = await prisma.codebaseSnapshot.create({
    data: {
      orgId: actor.orgId,
      projectId,
      paths: paths as unknown as object,
      fileCount: files.length,
      withContent,
      totalBytes,
      detection: detection as unknown as object,
      analysis: analysis as unknown as object,
      requestedBy: actor.userId,
    },
    select: { id: true, createdAt: true },
  });

  // Every mutation audits. The counts are the interesting part of this one: an
  // ingest is how an application's source enters the system, and "who uploaded
  // how much of what, when" is the question an incident asks first. Never the
  // paths themselves — a file tree is customer data and an audit row is not the
  // place for it.
  await audit({
    actor,
    action: 'source.ingest',
    targetType: 'CodebaseSnapshot',
    targetId: snapshot.id,
    metadata: {
      projectId,
      fileCount: files.length,
      withContent,
      totalBytes,
      routes: analysis.routes.length,
      endpoints: analysis.endpoints.length,
      forms: analysis.forms.length,
      authSurfaces: analysis.authSurfaces.length,
      runners: detection.candidates.map((c) => c.runner),
    },
  });

  res.status(201).json(present(snapshot.id, snapshot.createdAt, detection, analysis, {
    fileCount: files.length,
    withContent,
    totalBytes,
  }));
});

/**
 * What was learned, for the UI.
 *
 * Returns the most recent snapshot. A 200 with `snapshot: null` rather than a
 * 404: "this project has never had its source read" is a normal state for a
 * project, not a missing resource, and the screen that asks this question needs
 * to render an empty state rather than an error.
 */
sourceRouter.get('/projects/:projectId/source', async (req, res) => {
  const projectId = String(req.params.projectId);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const snapshot = await prisma.codebaseSnapshot.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });

  if (!snapshot) {
    res.json({
      snapshot: null,
      message:
        'No source has been ingested for this project yet. POST the application’s files to this ' +
        'same path to have QAAI read them.',
    });
    return;
  }

  res.json({
    ...present(
      snapshot.id,
      snapshot.createdAt,
      snapshot.detection as unknown as ReturnType<typeof detectProject>,
      snapshot.analysis as unknown as ReturnType<typeof analyseCodebase>,
      {
        fileCount: snapshot.fileCount,
        withContent: snapshot.withContent,
        totalBytes: snapshot.totalBytes,
      },
    ),
    paths: snapshot.paths,
  });
});

/**
 * One response shape for both verbs, so the screen that renders an ingest and
 * the screen that reloads it cannot drift.
 *
 * `limits` is not boilerplate and is not optional. It is the part of this
 * payload that stops a caller — human or agent — from reading a list of nine
 * routes as "this application has nine routes". It says what kind of claim
 * everything above it is.
 */
function present(
  id: string,
  createdAt: Date,
  detection: ReturnType<typeof detectProject>,
  analysis: ReturnType<typeof analyseCodebase>,
  counts: { fileCount: number; withContent: number; totalBytes: number },
) {
  const idle = analysis.detectors.filter((d) => d.filesExamined === 0);
  const ranAndFoundNothing = analysis.detectors.filter(
    (d) => d.filesExamined > 0 && d.found === 0 && !d.blocked,
  );
  const starved = analysis.detectors.filter((d) => d.blocked);

  return {
    snapshot: { id, createdAt },
    summary: honestSummary(detection, analysis),

    // What the application exposes.
    analysis: {
      routes: analysis.routes,
      endpoints: analysis.endpoints,
      forms: analysis.forms,
      authSurfaces: analysis.authSurfaces,
      frameworks: analysis.frameworks,
      notes: analysis.notes,
      warnings: analysis.warnings,
      coverage: analysis.coverage,
    },

    // How its tests would be run. The dead function, finally called.
    detection: {
      candidates: detection.candidates,
      languages: detection.languages,
      packageManagers: detection.packageManagers,
      hasTests: detection.hasTests,
      monorepo: detection.monorepo,
      roots: detection.roots,
      notes: detection.notes,
      warnings: detection.warnings,
    },

    // Which detectors ran, split three ways, because an empty result list is
    // ambiguous and this is the disambiguation.
    detectors: {
      all: analysis.detectors,
      foundSomething: analysis.detectors.filter((d) => d.found > 0).map((d) => d.id),
      examinedFilesButFoundNothing: ranAndFoundNothing.map((d) => d.id),
      hadNoFilesToLookAt: idle.map((d) => d.id),
      blockedByMissingFileContents: starved.map((d) => ({ id: d.id, why: d.blocked })),
    },

    upload: counts,

    limits: {
      static: true,
      statement:
        'This analysis is STATIC. It reports what the source code declares, and it cannot know ' +
        'what the application does when it runs. A route registered behind a feature flag, a ' +
        'router mounted under a prefix computed at boot, a form rendered only for some roles, or ' +
        'any behaviour at all — none of that is visible here. Crawling a running environment is ' +
        'what establishes it, and the two are complementary rather than alternatives.',
      whatWasNotDetected: [
        ...idle.map(
          (d) => `${d.label}: no files of its kind were in the upload (it looks for ${d.looksFor}).`,
        ),
        ...ranAndFoundNothing.map(
          (d) => `${d.label}: examined ${d.filesExamined} file(s) and found nothing declared.`,
        ),
        ...starved.map((d) => `${d.label}: ${d.blocked}.`),
      ],
      runtimeOnly: [
        'Whether any route actually loads, or errors.',
        'Which routes require a session, and which roles can reach them.',
        'What a form does after submit — the redirect, the validation, the error copy.',
        'Anything rendered by data: list contents, empty states, permissions.',
        'Endpoints registered dynamically, from config, or behind a flag.',
      ],
    },
  };
}

/**
 * Turn the stored analysis into proposed scenarios.
 *
 * The ingest above computes the analysis synchronously — static parsing is
 * fast — but writing plan items from it is the worker's job, and the worker has
 * had a consumer registered for this queue with nothing on the producing side:
 * `apps/worker/src/index.ts` even names this endpoint in the comment explaining
 * why the registration exists. The analysis sat in the database and nothing
 * ever acted on it.
 *
 * Separate from the ingest rather than fired automatically by it, because they
 * answer different questions and fail differently: "read my repo" either parses
 * or does not, while "propose scenarios" depends on what the person wants
 * tested. Onboarding calls both in sequence; a returning user can re-run this
 * one alone after changing their mind about test types.
 */
sourceRouter.post(
  '/projects/:projectId/analyze-source',
  requireRole('MEMBER'),
  async (req, res) => {
    const actor = actorOf(req);
    const projectId = String(req.params.projectId);

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) throw notFound('Project');

    /*
     * Refused, not queued, when there is nothing to analyse. A job that starts,
     * finds no snapshot and exits leaves the person watching a spinner resolve
     * into an empty plan with no explanation — the failure this codebase keeps
     * producing. The sentence names the fix.
     */
    const snapshot = await prisma.codebaseSnapshot.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!snapshot) {
      throw badRequest(
        'This project has no codebase to analyse yet. Upload one first — Setup → Add app, or POST /projects/:id/source.',
      );
    }

    await enqueue('qaai.analyze-source', {
      orgId: actor.orgId,
      projectId,
      requestedBy: actor.userId,
      autoApprove: req.body?.autoApprove === true,
    });

    await audit({
      actor,
      action: 'source.analyze',
      targetType: 'CodebaseSnapshot',
      targetId: snapshot.id,
      metadata: { projectId, autoApprove: req.body?.autoApprove === true },
    });

    res.status(202).json({ queued: true, snapshotId: snapshot.id });
  },
);
