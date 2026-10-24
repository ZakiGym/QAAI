/**
 * Agent-facing routes (§3): kick off exploration, read the proposed plan,
 * approve items into generated tests, review verdicts, act on heals, chat.
 *
 * These endpoints only ever enqueue work and read results. The agents
 * themselves run in the worker, where a long crawl or a slow generation cannot
 * hold an HTTP connection open.
 */

import { Router } from 'express';
import { QUEUE_NAMES, approvePlanSchema } from '@qaai/shared';
import type { TestType } from '@qaai/shared';
import { applyHealDiff, canScaffoldWithoutModel, postCheckCode } from '@qaai/agent';
import type { PostCheck } from '@qaai/agent';
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { audit } from '../lib/audit.js';
import { subscribe } from '../lib/events.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const agentRouter: Router = Router();

agentRouter.use(requireAuth);

// ─── Explorer ────────────────────────────────────────────────────────────────

agentRouter.post('/projects/:projectId/explore', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const { projectId } = req.params;
  const environmentId = String(req.body?.environmentId ?? '');
  if (!environmentId) throw badRequest('environmentId is required');

  const environment = await prisma.environment.findUnique({
    where: { id: environmentId },
    select: { id: true, projectId: true, baseUrl: true },
  });
  if (!environment || environment.projectId !== projectId) throw notFound('Environment');

  const jobId = await enqueue(QUEUE_NAMES.explore, {
    orgId: actor.orgId,
    projectId,
    environmentId,
    requestedBy: actor.userId,
    maxPages: Math.min(60, Number(req.body?.maxPages ?? 25)),
    maxDepth: Math.min(6, Number(req.body?.maxDepth ?? 3)),
    autoApprove: req.body?.autoApprove === true,
  },
  // One attempt. A crawl is expensive and NOT idempotent — it writes a new
  // FlowMap version every run — so the default 3 retries silently re-crawled
  // the customer's site three times whenever the plan step failed.
  { attempts: 1 });

  await audit({
    actor,
    action: 'explorer.start',
    targetType: 'Project',
    targetId: projectId,
    metadata: { environmentId, baseUrl: environment.baseUrl },
  });

  res.status(202).json({ jobId, status: 'queued' });
});

/**
 * Live crawl progress. The Explorer publishes under a synthetic run id because
 * a crawl is not a run and has no Run row to hang events off — reusing the
 * /runs events route would 404 on the missing run.
 */
agentRouter.get('/projects/:projectId/explore/events', async (req, res) => {
  const actor = actorOf(req);
  const projectId = String(req.params.projectId);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const unsubscribe = subscribe(actor.orgId, `explore:${projectId}`, res);
  req.on('close', unsubscribe);
});

/** The most recent plan, with its items — what the approval screen renders. */
agentRouter.get('/projects/:projectId/plan', async (req, res) => {
  const plan = await prisma.testPlan.findFirst({
    where: { projectId: String(req.params.projectId) },
    orderBy: { createdAt: 'desc' },
    include: { items: { orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] } },
  });
  if (!plan) throw notFound('Test plan');
  res.json({ plan });
});

agentRouter.post('/plans/:planId/approve', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const input = approvePlanSchema.parse(req.body);

  const plan = await prisma.testPlan.findUnique({
    where: { id: String(req.params.planId) },
    include: { items: { select: { id: true, state: true, testType: true } } },
  });
  if (!plan) throw notFound('Test plan');

  const known = new Set(plan.items.map((i) => i.id));
  const unknown = input.approvedItemIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw badRequest('Some approved ids do not belong to this plan', { unknown });
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.planItem.updateMany({
      where: { id: { in: input.approvedItemIds } },
      data: { state: 'APPROVED', decidedBy: actor.userId, decidedAt: now },
    }),
    // Everything not ticked is explicitly rejected rather than left PROPOSED,
    // so a re-opened plan does not silently re-offer declined items.
    prisma.planItem.updateMany({
      where: { testPlanId: plan.id, id: { notIn: input.approvedItemIds }, state: 'PROPOSED' },
      data: { state: 'REJECTED', decidedBy: actor.userId, decidedAt: now },
    }),
  ]);

  for (const [itemId, edit] of Object.entries(input.edits)) {
    if (!known.has(itemId)) continue;
    await prisma.planItem.update({
      where: { id: itemId },
      data: {
        ...(edit.title ? { title: edit.title } : {}),
        ...(edit.priority ? { priority: edit.priority } : {}),
      },
    });
  }

  /*
   * Test CODE needs a model, but the spec-driven types do not — the Generator
   * scaffolds those deterministically from the crawl (@qaai/agent's
   * spec-strategies), each carrying review flags naming its TODO fields. So a
   * missing key narrows the queue to the scaffoldable subset instead of
   * refusing outright; only when NOTHING in the batch can be scaffolded does
   * this fall back to the old "approved, not queued, here is what to set".
   *
   * The history that shaped this: the endpoint used to answer 202 with no key,
   * the cockpit read that as success, and the job died in the worker with
   * nothing anywhere to say why. `generation.reason` is always present when a
   * key is missing so the person is told exactly which half happened.
   */
  const canGenerate = Boolean(env.ANTHROPIC_API_KEY);
  const typeOf = new Map(plan.items.map((i) => [i.id, i.testType]));
  const queueableIds = canGenerate
    ? input.approvedItemIds
    : input.approvedItemIds.filter((id) => canScaffoldWithoutModel(typeOf.get(id) as TestType));
  const jobId =
    queueableIds.length > 0
      ? await enqueue(QUEUE_NAMES.generate, {
          orgId: actor.orgId,
          projectId: plan.projectId,
          testPlanId: plan.id,
          planItemIds: queueableIds,
          requestedBy: actor.userId,
        })
      : null;

  await audit({
    actor,
    action: 'plan.approve',
    targetType: 'TestPlan',
    targetId: plan.id,
    metadata: {
      approved: input.approvedItemIds.length,
      rejected: known.size - input.approvedItemIds.length,
      queued: jobId !== null,
      ...(canGenerate ? {} : { scaffolded: queueableIds.length, reason: 'no ANTHROPIC_API_KEY' }),
    },
  });

  const needModel = input.approvedItemIds.length - queueableIds.length;
  res.status(202).json({
    jobId,
    approved: input.approvedItemIds.length,
    generation: canGenerate
      ? { queued: true }
      : {
          queued: jobId !== null,
          scaffolded: queueableIds.length,
          reason:
            queueableIds.length > 0
              ? `${queueableIds.length} of ${input.approvedItemIds.length} approved item(s) are spec-driven and were scaffolded from the crawl without a model — each carries review flags naming what to fill in. ` +
                (needModel > 0
                  ? `The other ${needModel} need a model: ANTHROPIC_API_KEY is not set on this deployment — set it and approve the plan again.`
                  : `Set ANTHROPIC_API_KEY to have a model write them outright.`)
              : 'ANTHROPIC_API_KEY is not set on this deployment, so the Generator cannot be run and no ' +
                'test code was written. Your approval was saved — these items are APPROVED and will ' +
                'generate as soon as the key is set and you approve the plan again.',
        },
  });
});

// ─── Verdicts (§3.3) ─────────────────────────────────────────────────────────

agentRouter.get('/verdicts', async (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : undefined;
  const verdicts = await prisma.triageVerdict.findMany({
    where: {
      ...(state ? { reviewState: state as never } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      testResult: {
        select: {
          id: true,
          runId: true,
          status: true,
          test: { select: { id: true, name: true, filePath: true, priority: true } },
        },
      },
    },
  });
  res.json({ verdicts });
});

/**
 * The keyboard-first review action (§8). A human can accept the verdict,
 * override it, or mute it — and the override is what gates, not the model's
 * original call.
 */
agentRouter.post('/verdicts/:verdictId/review', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const action = String(req.body?.action ?? '');
  const overrideTo = req.body?.overrideTo as string | undefined;

  const verdict = await prisma.triageVerdict.findUnique({
    where: { id: String(req.params.verdictId) },
  });
  if (!verdict) throw notFound('Verdict');
  if (verdict.reviewState !== 'PENDING') {
    throw conflict(`This verdict was already reviewed (${verdict.reviewState})`);
  }

  const reviewState =
    action === 'accept'
      ? 'ACCEPTED'
      : action === 'override'
        ? 'OVERRIDDEN'
        : action === 'mute'
          ? 'MUTED'
          : null;
  if (!reviewState) throw badRequest('action must be one of: accept, override, mute');
  if (reviewState === 'OVERRIDDEN' && !overrideTo) {
    throw badRequest('overrideTo is required when overriding a verdict');
  }

  const updated = await prisma.triageVerdict.update({
    where: { id: verdict.id },
    data: {
      reviewState,
      reviewedBy: actor.userId,
      reviewedAt: new Date(),
      overriddenTo: reviewState === 'OVERRIDDEN' ? (overrideTo as never) : null,
    },
  });

  await audit({
    actor,
    action: `verdict.${action}`,
    targetType: 'TriageVerdict',
    targetId: verdict.id,
    metadata: { from: verdict.verdict, to: overrideTo ?? verdict.verdict },
  });

  res.json({ verdict: updated });
});

// ─── Heals (§3.4) ────────────────────────────────────────────────────────────

/**
 * The version-history message for an applied heal.
 *
 * Capped, because this is a database column and three long gate sentences plus
 * a model explanation will overrun any sensible display. The ORDER is the
 * point: what the heal claims to do, then anything nobody could verify, then
 * what the gates found, then which gates ran at all. A reader scanning history
 * after a suite quietly stopped asserting anything needs the last two most, and
 * they are the two that did not exist before.
 */
function healVersionMessage(
  explanation: string,
  unverified: string | undefined,
  check: PostCheck,
): string {
  return [
    `Applied heal: ${explanation.slice(0, 200)}`,
    unverified ? `unverified: ${unverified}` : null,
    ...check.flags,
    check.checks,
  ]
    .filter((part): part is string => part !== null)
    .join(' — ')
    .slice(0, 2_000);
}

/**
 * Heal proposals for the review screen. Defaults to what needs a decision;
 * `?state=all` includes decided ones so the screen can show what happened.
 * The test's current code ships alongside each diff so the client can render a
 * real before/after without a second round-trip per row.
 */
agentRouter.get('/heals', async (req, res) => {
  const all = String(req.query.state ?? '') === 'all';
  const rows = await prisma.healProposal.findMany({
    where: all ? {} : { state: 'PROPOSED' },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      // `type` and `spec` are here for the post-check gates: a spec-driven test
      // keeps its assertions in the spec and its `code` is an inert pointer
      // comment, so a gate handed the code alone would report a perfectly good
      // API test as asserting nothing.
      test: { select: { id: true, name: true, filePath: true, code: true, type: true, spec: true } },
    },
  });

  /**
   * The patched result is computed here, with the same applier approval uses, so
   * the reviewer sees the real before/after and is told up front when a proposal
   * has gone stale — rather than finding out by clicking Approve.
   *
   * And then the SAME gates a generated test passes through are run over the
   * patched file, because a heal writes code into the customer's repository
   * exactly as the Generator does. `await Promise.all` rather than the plain
   * `.map` this used to be: the gates are async. They are also cheap — the one
   * live toolchain gate is an in-process TypeScript parse (single-digit
   * milliseconds), and the rest are pure string analysis — so a page of 50
   * heals is not materially slower than it was.
   */
  const heals = await Promise.all(
    rows.map(async (heal) => {
      // The file path is what resolves the assertion dialect, and the dialect is
      // what makes the never-weaken guard bite outside JavaScript. Called without
      // it, the guard falls back to a JS-only count — 0 before and 0 after in a Go
      // or pytest repo, which is a guard that passes everything.
      const applied = applyHealDiff(heal.test.code, heal.diff, { filePath: heal.test.filePath });
      const check =
        applied.ok && applied.code !== undefined
          ? await postCheckCode({
              code: applied.code,
              filePath: heal.test.filePath,
              testType: heal.test.type,
              spec: heal.test.spec,
            })
          : null;

      return {
        ...heal,
        preview: {
          /*
           * `applies` drives the Approve button, so a heal the gates refuse has
           * to read as not-applicable here rather than as applicable-with-a-note.
           * The only gate that refuses is SYNTAX: a patched file that does not
           * parse would replace a test failing with a readable error by a file
           * the runner cannot load, taking its siblings down with it. The decide
           * route re-runs this check and 422s, so a client that ignores the flag
           * still cannot apply it.
           */
          applies: applied.ok && (check === null || check.allowed),
          code: applied.code ?? null,
          reason: (check !== null && !check.allowed ? check.refusal : applied.reason) ?? null,
          fuzz: applied.fuzz ?? null,
          /**
           * Present when the guard could not verify that the heal keeps the
           * assertions — an unreadable file type. It is not a refusal, so the
           * reviewer is the check; dropping it here would be the one case where
           * "this heal applies cleanly" is shown to a human with no mention that
           * nothing checked whether it still asserts anything.
           */
          review: applied.review ?? null,
          /**
           * What the gates found in the patched file: a fixed sleep, a brittle
           * locator, a QAAI import, a test that now asserts nothing. These are
           * flags and not refusals because a heal fixes a test that is currently
           * red — and this reviewer is the human the flag is addressed to.
           */
          flags: check?.flags ?? [],
          /**
           * …and which checks ran, so the screen can never imply a check that
           * did not happen. This path has no repository checkout, so typecheck,
           * formatting and lint are among the ones that did not.
           */
          checks: check?.checks ?? null,
        },
      };
    }),
  );

  res.json({ heals });
});

agentRouter.post('/heals/:healId/decide', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const approve = req.body?.approve === true;

  const heal = await prisma.healProposal.findUnique({
    where: { id: String(req.params.healId) },
    // `type` and `spec` for the post-check gates; see the list route above.
    include: { test: { select: { id: true, code: true, filePath: true, type: true, spec: true } } },
  });
  if (!heal) throw notFound('Heal proposal');
  if (heal.state !== 'PROPOSED') throw conflict(`This heal was already ${heal.state}`);

  if (!approve) {
    const rejected = await prisma.healProposal.update({
      where: { id: heal.id },
      data: { state: 'REJECTED', decidedBy: actor.userId, decidedAt: new Date() },
    });
    await audit({ actor, action: 'heal.reject', targetType: 'HealProposal', targetId: heal.id });
    res.json({ heal: rejected });
    return;
  }

  /**
   * Approving applies the diff to the test and records a version, so the fix is
   * real the moment a human accepts it. The test lives in the database, so this
   * is the working copy — Source control then pushes it like any other change.
   *
   * A patch that no longer applies (the test was edited after the proposal) is
   * refused with a 422 rather than force-fitted; the proposal stays PROPOSED so
   * it can be re-run.
   */
  // With the path, so the never-weaken guard runs in the test's own dialect
  // rather than a JavaScript one. See the list route above.
  const applied = applyHealDiff(heal.test.code, heal.diff, { filePath: heal.test.filePath });
  if (!applied.ok || !applied.code) {
    throw unprocessable(applied.reason ?? 'The diff could not be applied');
  }

  /*
   * The same gates a generated test passes through, over the patched file.
   *
   * Only one of them refuses: a file that does not parse. A human clicking
   * Approve is a check on whether the FIX is right, not on whether the file
   * loads — nobody reads a diff and notices a missing brace — so this is not a
   * decision to defer to them. Everything else (a fixed sleep, a brittle
   * locator, a QAAI import, a test that now asserts nothing) is recorded and
   * applied, because a heal fixes a test that is currently red and refusing it
   * would leave the customer with a broken test and no proposal.
   */
  const check = await postCheckCode({
    code: applied.code,
    filePath: heal.test.filePath,
    testType: heal.test.type,
    spec: heal.test.spec,
  });
  if (!check.allowed) {
    throw unprocessable(check.refusal ?? 'The patched file did not pass the post-heal checks');
  }

  const latest = await prisma.testVersion.findFirst({
    where: { testId: heal.testId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  const [, updatedHeal] = await prisma.$transaction([
    prisma.test.update({
      where: { id: heal.testId },
      data: {
        code: applied.code,
        /*
         * The Generator's review flags described the code this heal just
         * replaced, so they are stale — but clearing them to `[]` would also
         * erase what the gates just found in the NEW code, and the badge would
         * say "nothing to review" about a test that now contains a fixed sleep.
         * So the row carries the current findings instead of none.
         */
        reviewFlags: check.flags,
        versions: {
          create: {
            orgId: actor.orgId,
            version: (latest?.version ?? 0) + 1,
            code: applied.code,
            source: 'HEALER',
            authorId: actor.userId,
            /**
             * The review note rides along when the guard could not verify the
             * assertion count, and so does the list of checks that ran. A human
             * approved this, so neither is a refusal — but the version history
             * is the only place those facts survive, and "who approved a heal
             * nobody could check" is exactly the question asked after a suite
             * quietly stops asserting anything.
             */
            message: healVersionMessage(heal.explanation, applied.review, check),
          },
        },
      },
    }),
    prisma.healProposal.update({
      where: { id: heal.id },
      data: { state: 'APPLIED', decidedBy: actor.userId, decidedAt: new Date() },
    }),
  ]);

  await audit({
    actor,
    action: 'heal.apply',
    targetType: 'HealProposal',
    targetId: heal.id,
    metadata: {
      riskLevel: heal.riskLevel,
      testId: heal.testId,
      fuzz: applied.fuzz,
      // Which gates ran and what they found, on the record. An audit row saying
      // only "heal.apply" cannot answer "was this checked".
      checks: check.checks,
      flags: check.flags,
    },
  });

  res.json({
    heal: updatedHeal,
    note: [
      applied.fuzz && applied.fuzz > 0
        ? `Applied, but the patch needed ${applied.fuzz} line(s) of fuzz — worth a glance in the editor.`
        : 'Applied to the test. Push it from Source control when you are ready.',
      ...check.flags,
      check.checks,
    ].join(' '),
  });
});

// Chat lives in routes/copilot.ts — it outgrew this file the moment it
// gained tools and an approval gate.
