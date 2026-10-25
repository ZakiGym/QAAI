/**
 * Agent-facing routes (§3): kick off exploration, read the proposed plan,
 * approve items into generated tests, review verdicts, act on heals, chat.
 *
 * These endpoints only ever enqueue work and read results. The agents
 * themselves run in the worker, where a long crawl or a slow generation cannot
 * hold an HTTP connection open.
 */

import { Router } from 'express';
import { FIXTURE_PREFIX, QUEUE_NAMES, approvePlanSchema } from '@qaai/shared';
import type { FlowMap, TestType } from '@qaai/shared';
import {
  applyHealDiff,
  auditTestsAgainstCrawl,
  canScaffoldWithoutModel,
  driftCheck,
  healKindOf,
  planSupersede,
  postCheckCode,
  verificationRunTag,
  HEAL_VERIFY_STATES,
} from '@qaai/agent';
import type { OpenHeal, PostCheck } from '@qaai/agent';
/*
 * The one import still reached by path, and a narrower reason than before:
 * `obsolete.js` is in the package barrel now, but `suite-health.js` is not
 * exported from it. This is TYPE-ONLY, so it is erased at build time and
 * reaches no runtime code across the workspace boundary.
 */
import type { SuiteHealthTestInput } from '../../../../packages/agent/src/suite-health.js';
import { startRun } from '../lib/start-run.js';
import { prisma, unscoped } from '../lib/prisma.js';
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
 * What is known about whether an applied heal actually worked.
 *
 * `state: null` is the honest encoding of "nothing to say": nobody applied this
 * proposal, so nothing was verified. The field a reader must not be able to
 * misread is `claimsFixed` — true ONLY when a run executed the test after the
 * patch was written and it passed. Everything else, including an applied heal
 * nobody could check, is false, which is the whole point of this feature: a heal
 * recorded APPLIED while still red tells a human the problem is handled.
 */
function verificationOf(heal: {
  state: string;
  verifyState: string | null;
  verifyNote: string | null;
  verifyRunId: string | null;
  verifiedAt: Date | null;
}): {
  state: string | null;
  claimsFixed: boolean;
  note: string | null;
  runId: string | null;
  at: Date | null;
} {
  const applied = heal.state === 'APPLIED' || heal.state === 'AUTO_APPLIED';
  /*
   * `verifyState` is a TEXT column whose domain is enforced at the producer (see
   * the migration), so the read end has to cope with a value it does not know —
   * a row written by a newer deployment, or by hand. An unrecognised value is
   * reported as unrecognised rather than falling through `=== 'VERIFIED'` into
   * "not verified", which would read as a measured failure instead of a value
   * nobody can interpret.
   */
  const known = (HEAL_VERIFY_STATES as readonly string[]).includes(heal.verifyState ?? '');
  return {
    state: heal.verifyState,
    claimsFixed: heal.verifyState === 'VERIFIED',
    note:
      heal.verifyState !== null && !known
        ? `This heal records a verification state QAAI does not recognise ("${heal.verifyState}"), so nothing can be concluded from it. ${heal.verifyNote ?? ''}`.trim()
        : (heal.verifyNote ??
          (applied
            ? 'This heal was applied and no verification was recorded, so nobody has confirmed the test passes.'
            : null)),
    runId: heal.verifyRunId,
    at: heal.verifiedAt,
  };
}

/**
 * Start the run that checks an applied heal, and say what to record about it.
 *
 * ── WHY `advisory` AND NOT `enforce` ────────────────────────────────────────
 *
 * A person has just approved a fix for a red test. Throwing 402 at them because
 * the org is at its monthly run cap would refuse the APPROVAL over the
 * VERIFICATION — the heal would not be applied at all, and the customer would be
 * left with the broken test and a billing error message. So the toll is
 * advisory: the heal applies, and a refused verification is recorded as
 * UNVERIFIABLE with the quota as its stated reason. "Applied, nobody checked,
 * here is why" is a true sentence; "we could not apply your fix because of your
 * plan" is a worse product.
 *
 * ── WHY IT CAN COME BACK UNVERIFIABLE BEFORE IT EVEN RUNS ───────────────────
 *
 * A test that has never run has no environment to re-run it in, and guessing one
 * would be running the customer's test against a URL nobody chose. That is an
 * honest "nobody checked", recorded as such, rather than a silently skipped
 * verification — which is the defect this whole path exists to close.
 */
async function startHealVerification(args: {
  orgId: string;
  healId: string;
  testId: string;
  projectId: string;
}): Promise<{ runId: string | null; state: 'PENDING' | 'UNVERIFIABLE'; note: string }> {
  // The environment the test last ran in — the one a re-run must reproduce.
  // Same rule the flake radar's confirmation runs use.
  const last = await prisma.testResult.findFirst({
    where: { testId: args.testId, orgId: args.orgId },
    orderBy: { createdAt: 'desc' },
    select: { run: { select: { environmentId: true } } },
  });
  const environmentId = last?.run.environmentId;
  if (!environmentId) {
    return {
      runId: null,
      state: 'UNVERIFIABLE',
      note: 'The heal was applied and nobody has checked it: this test has never run, so there is no environment to re-run it in. Run it yourself to find out whether the fix works.',
    };
  }

  const started = await startRun({
    db: prisma,
    orgId: args.orgId,
    mode: 'advisory',
    unscope: unscoped,
    data: {
      orgId: args.orgId,
      projectId: args.projectId,
      environmentId,
      trigger: 'MANUAL',
      triggeredBy: verificationRunTag(args.healId),
      totalCount: 1,
      // One placeholder result: the run processor executes exactly the tests its
      // result rows name, which is how a single-test run is expressed here.
      results: { create: [{ orgId: args.orgId, testId: args.testId, status: 'SKIPPED' as const }] },
    },
  });

  if (!started.created) {
    return {
      runId: null,
      state: 'UNVERIFIABLE',
      note: `The heal was applied and nobody has checked it: the verifying run could not be started. ${started.quota.reason ?? 'This org is at its monthly run limit.'}`,
    };
  }

  try {
    await enqueue(
      QUEUE_NAMES.run,
      { orgId: args.orgId, runId: started.run.id },
      // Idempotent on run id, like POST /runs: a retried approval cannot
      // double-execute the verification.
      { jobId: `run-${started.run.id}` },
    );
  } catch {
    /*
     * A run row with no job would sit PENDING until the sweep's deadline and
     * then report itself unverifiable for the wrong reason. Mark it dead now and
     * say the true reason.
     */
    await prisma.run
      .update({
        where: { id: started.run.id },
        data: {
          status: 'ERRORED',
          finishedAt: new Date(),
          errorMessage: 'The heal verification run could not be queued.',
        },
      })
      .catch(() => {});
    return {
      runId: null,
      state: 'UNVERIFIABLE',
      note: 'The heal was applied and nobody has checked it: the verifying run could not be queued. Run the test yourself to find out whether the fix works.',
    };
  }

  return {
    runId: started.run.id,
    state: 'PENDING',
    note: `Applied, and now being checked: run ${started.run.id} re-runs this test on its own. Until it lands, nobody has confirmed the fix works.`,
  };
}

/** Open proposals for one test, in the shape the lifecycle rules want. */
async function openHealsFor(orgId: string, testId: string): Promise<OpenHeal[]> {
  return await prisma.healProposal.findMany({
    where: { orgId, testId, state: { in: ['PROPOSED', 'APPROVED'] } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, state: true, riskLevel: true, diff: true, createdAt: true },
  });
}

/**
 * Heal proposals for the review screen. Defaults to what needs a decision;
 * `?state=all` includes decided ones so the screen can show what happened.
 * The test's current code ships alongside each diff so the client can render a
 * real before/after without a second round-trip per row.
 */
agentRouter.get('/heals', async (req, res) => {
  // `typeof`, not `String(...)`: Express 5 types a query value as string, an
  // array of strings, or an object (`?state[x]=all`), and stringifying the last
  // of those yields "[object Object]" — a comparison that can never match but
  // reads as though it could.
  const all = typeof req.query.state === 'string' && req.query.state === 'all';
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
      /*
       * A RETIREMENT is not a patch and must never be run through the applier.
       *
       * It carries no diff at all (see the column's own doc comment), so
       * `applyHealDiff` would refuse it for having no diff and the row would
       * render as "this heal is broken" — which is both wrong and the opposite
       * of actionable. Its preview is its EVIDENCE: the routes that are gone,
       * and the caveat saying what accepting it does.
       */
      if (healKindOf(heal.riskLevel) === 'RETIREMENT') {
        return {
          ...heal,
          preview: {
            kind: 'RETIREMENT' as const,
            /*
             * Applicable, and deliberately so: there is nothing that could fail
             * to apply. Accepting it DISABLES the test — the code stays in the
             * repository and in its version history — so the destructive
             * reading of this button is wrong and the note says why.
             */
            applies: true,
            code: null,
            reason: null,
            fuzz: null,
            review:
              'Accepting this disables the test. Its code and history stay in your repository and you can switch it back on. Read the evidence first: a test whose page QAAI could not REACH looks very like a test whose page is GONE, and only the second is worth retiring.',
            flags: [],
            checks:
              'No code check applies: a retirement changes no code. The evidence is the comparison against the newest crawl, recorded on the proposal.',
          },
          verification: verificationOf(heal),
        };
      }

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
          kind: 'PATCH' as const,
        },
        verification: verificationOf(heal),
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
    // `name` and `projectId` for the retirement record and the verifying run.
    include: {
      test: {
        select: {
          id: true,
          name: true,
          code: true,
          filePath: true,
          type: true,
          spec: true,
          projectId: true,
        },
      },
    },
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

  /*
   * ── Accepting a RETIREMENT ─────────────────────────────────────────────────
   *
   * It applies by DISABLING the test, never by deleting it. `disabledAt` stops
   * the test running and stops it gating; the code and every version of it stay
   * in the repository, and the owner can switch it back on. The reversible
   * operation is the one offered, because the mistake this feature can make —
   * retiring a test whose page QAAI merely could not reach — is otherwise
   * unrecoverable, and `obsolete.ts` works hard to make that mistake rare
   * rather than impossible.
   *
   * No diff is applied and no post-check runs: there is no code change to check.
   * `verifyState` stays NULL — there is nothing to re-run, and claiming a
   * verification here would be the same lie this work exists to remove — while
   * `verifyNote` says so in words, because the screen reads that field.
   */
  if (healKindOf(heal.riskLevel) === 'RETIREMENT') {
    const now = new Date();
    const openPatches = (await openHealsFor(heal.orgId, heal.testId)).filter(
      (open) => open.id !== heal.id,
    );

    const [, retired] = await prisma.$transaction([
      prisma.test.update({ where: { id: heal.testId }, data: { disabledAt: now } }),
      prisma.healProposal.update({
        where: { id: heal.id },
        data: {
          state: 'APPLIED',
          decidedBy: actor.userId,
          decidedAt: now,
          verifyNote:
            'A retirement changes no code, so there is nothing to re-run and nothing was verified. The test is disabled: it stops running and stops gating from now on, and its code and history are untouched.',
        },
      }),
      /*
       * Every other open proposal for this test is closed with it.
       *
       * `planSupersede` deliberately refuses to supersede ACROSS kinds when a
       * proposal is MADE — a reviewer looking at both a retirement and a patch
       * is facing a real choice. Applying the retirement is that choice being
       * made: the test no longer runs, so a patch for it is moot, and leaving
       * the row open would leave an Approve button that silently re-enables
       * nothing. If the test is switched back on, triage proposes afresh.
       */
      prisma.healProposal.updateMany({
        where: { id: { in: openPatches.map((open) => open.id) } },
        data: { state: 'SUPERSEDED', supersededById: heal.id, decidedAt: now },
      }),
    ]);

    await audit({
      actor,
      action: 'heal.retire',
      targetType: 'HealProposal',
      targetId: heal.id,
      metadata: {
        testId: heal.testId,
        testName: heal.test.name,
        confidence: heal.confidence,
        supersededPatches: openPatches.map((open) => open.id),
        evidence: heal.evidence,
      },
    });

    res.json({
      heal: retired,
      note:
        `"${heal.test.name}" is disabled: it stops running and stops gating. Its code and history ` +
        `are untouched — un-disable it from the test page if this was wrong.` +
        (openPatches.length > 0
          ? ` ${openPatches.length} open fix proposal(s) for the same test were closed with it.`
          : ''),
    });
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
  const appliedVersion = (latest?.version ?? 0) + 1;

  /*
   * Everything else open for this test is superseded by the decision being made
   * here, so the queue does not keep offering alternatives to a fix that is
   * already in the code. Computed BEFORE the transaction and written inside it:
   * the state of the queue and the state of the test move together or not at
   * all. Same-kind only — a retirement proposal is a different question and
   * stays open for its own answer (see `planSupersede`).
   */
  const supersede = planSupersede({
    incomingId: heal.id,
    incomingRiskLevel: heal.riskLevel,
    openHeals: await openHealsFor(heal.orgId, heal.testId),
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
      data: {
        state: 'APPLIED',
        decidedBy: actor.userId,
        decidedAt: new Date(),
        /*
         * Which version this heal wrote. The revert path in the worker's
         * verification sweep has no other way back: without it, an unattended
         * heal that failed verification could only be undone by guessing which
         * version came before it, and guessing would write a version of the
         * test the heal never replaced.
         */
        appliedVersion,
      },
    }),
    prisma.healProposal.updateMany({
      where: { id: { in: supersede.ids } },
      data: { state: 'SUPERSEDED', supersededById: heal.id, decidedAt: new Date() },
    }),
  ]);

  /*
   * ── The verification, started AFTER the code is written ────────────────────
   *
   * Order is load-bearing: a run queued before the transaction could execute the
   * OLD code and report a failure about a heal that had not been applied yet.
   *
   * It is also outside the transaction, which means a crash between the two
   * leaves `verifyState` NULL rather than PENDING — "nobody checked", which is
   * exactly what would have happened, rather than a row waiting forever on a run
   * that was never created. The sweep only ever chases PENDING.
   */
  const verification = await startHealVerification({
    orgId: heal.orgId,
    healId: heal.id,
    testId: heal.testId,
    projectId: heal.test.projectId,
  });
  await prisma.healProposal.update({
    where: { id: heal.id },
    data: {
      verifyState: verification.state,
      verifyRunId: verification.runId,
      verifyNote: verification.note,
      // Only an outcome stamps this. PENDING is not an outcome.
      verifiedAt: verification.state === 'UNVERIFIABLE' ? new Date() : null,
    },
  });

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
      appliedVersion,
      superseded: supersede.ids,
      // Whether anything is going to check this, on the record next to the
      // apply. "Applied" and "verified" are different claims.
      verification: { state: verification.state, runId: verification.runId },
    },
  });

  res.json({
    heal: { ...updatedHeal, verifyState: verification.state, verifyRunId: verification.runId },
    note: [
      applied.fuzz && applied.fuzz > 0
        ? `Applied, but the patch needed ${applied.fuzz} line(s) of fuzz — worth a glance in the editor.`
        : 'Applied to the test. Push it from Source control when you are ready.',
      // Before the gate prose, because "is this actually fixed" is the first
      // question and used to have no answer at all.
      verification.note,
      ...(supersede.ids.length > 0
        ? [`${supersede.ids.length} other open proposal(s) for this test were superseded.`]
        : []),
      ...check.flags,
      check.checks,
    ].join(' '),
  });
});

// ─── Drift against the newest crawl (§3.1/§3.4) ──────────────────────────────

/**
 * Tests compared per read. Matches `DRIFT_TEST_SCAN_LIMIT` in the worker's
 * sweep, so the screen and the queue judge the same tests.
 */
const DRIFT_TEST_SCAN_LIMIT = 500;

/**
 * Route items read per request — the SOURCE side of a retirement, and the cap
 * that has to be disclosed.
 *
 * The declared-route list is one of the two independent negatives behind an
 * OBSOLETE verdict. Beyond this many route items a route the source genuinely
 * declares does not come back, and a route that IS declared reading as
 * `declared: false` is exactly the evidence a retirement rests on — so past the
 * cap the source side is declared truncated and `obsolete.ts` withholds every
 * proposal, the same way it does for a truncated crawl. Kept equal to
 * `DRIFT_ROUTE_ITEM_SCAN_LIMIT` in the worker's sweep for the same reason the
 * crawl ordering is kept equal: two readers of one table that disagree about
 * the subset disagree about the verdict.
 */
const DRIFT_ROUTE_ITEM_SCAN_LIMIT = 2_000;

/**
 * Which tests the newest crawl says are about to break, and which ones drive a
 * page that is gone.
 *
 * READ-ONLY. The worker's `driftSweep` runs the same analysis once per crawl and
 * is the thing that mints retirement proposals; this endpoint is how a person
 * looks at the answer, including between crawls. The DECISION is shared —
 * `auditTestsAgainstCrawl` and `driftCheck` in packages/agent — so the screen
 * and the queue cannot disagree about a test. What is duplicated is the five
 * queries that load the inputs, and that is deliberate: the two live in
 * different workspaces with different Prisma clients, and the alternative
 * (another cross-workspace loader module) buys less than it costs. If a third
 * caller ever appears, that is the moment to extract it.
 */
agentRouter.get('/projects/:projectId/drift', async (req, res) => {
  const projectId = String(req.params.projectId);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  /*
   * `createdAt`, not `version` — the same ordering `driftSweep` uses, and the
   * difference is not cosmetic. `FlowMap.version` is sequenced per (project,
   * ENVIRONMENT) in processors/explore.ts, so a project with two environments
   * has two independent counters: ordering by version picks the crawl from
   * whichever environment has been crawled most often, which on a project whose
   * staging is crawled nightly and whose production is crawled weekly is a
   * months-old staging crawl beating this morning's production one. The worker
   * reads newest-by-createdAt and mints the retirement proposals from it, so
   * this screen has to read the same crawl or the two disagree about a test —
   * which is exactly what sharing `auditTestsAgainstCrawl` is supposed to make
   * impossible.
   */
  const crawl = await prisma.flowMap.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, version: true, graph: true, truncatedReason: true, createdAt: true },
  });

  const testRows = await prisma.test.findMany({
    where: { projectId, disabledAt: null },
    orderBy: { createdAt: 'asc' },
    // One over the cap, so the response can say that more exist instead of
    // handing the screen a row count it will render as the whole suite.
    take: DRIFT_TEST_SCAN_LIMIT + 1,
    select: {
      id: true,
      name: true,
      filePath: true,
      type: true,
      priority: true,
      feature: true,
      tags: true,
      code: true,
      spec: true,
      flakeRate: true,
      quarantined: true,
      consecutiveFailures: true,
    },
  });
  const testsTruncated = testRows.length > DRIFT_TEST_SCAN_LIMIT;
  const tests = testRows.slice(0, DRIFT_TEST_SCAN_LIMIT);

  /*
   * `declaredRoutes` is NULL when no source analysis has run, and null is not an
   * empty list: with nothing having read the code, "the source does not declare
   * this route" is the absence of a detector rather than a fact — and a
   * retirement is never proposed on that basis. See obsolete.ts.
   */
  const sourceItems = await prisma.coverageItem.count({
    where: { projectId, origin: { in: ['SOURCE_ONLY', 'BOTH'] } },
  });
  const routeItemRows = await prisma.coverageItem.findMany({
    where: { projectId, kind: 'ROUTE' },
    // Ordered and read one over the cap, both deliberately. The worker's
    // `driftSweep` reads the same table the same way: without an ORDER BY the
    // two can be handed different subsets and reach different verdicts about
    // the same test, which is exactly what sharing the analysis is supposed to
    // make impossible.
    orderBy: { key: 'asc' },
    take: DRIFT_ROUTE_ITEM_SCAN_LIMIT + 1,
    select: { key: true, origin: true, retiredAt: true },
  });
  const routeItemsTruncated = routeItemRows.length > DRIFT_ROUTE_ITEM_SCAN_LIMIT;
  const routeItems = routeItemRows.slice(0, DRIFT_ROUTE_ITEM_SCAN_LIMIT);
  const routeOf = (key: string): string => key.replace(/^ROUTE:/, '');

  const graph = crawl?.graph as Partial<FlowMap> | null;
  const flowMap: FlowMap | null =
    graph && typeof graph === 'object' && Array.isArray(graph.nodes) && crawl
      ? ({
          ...graph,
          // The row is the authority on these two; a graph written by an older
          // crawler may carry neither, and a missing `truncatedReason` read as
          // "complete" is what would let a truncated crawl retire a test.
          version: crawl.version,
          truncatedReason: crawl.truncatedReason,
        } as FlowMap)
      : null;

  const report = auditTestsAgainstCrawl({
    tests: tests
      // Fixtures are test data, not tests — they never run and never gate, and
      // `driftSweep` refuses to judge them. Judged here and not there, the
      // screen would show a verdict for a file the queue will never act on.
      .filter((test) => !test.filePath.startsWith(FIXTURE_PREFIX))
      .map((test) => test as unknown as SuiteHealthTestInput),
    flowMap,
    declaredRoutes:
      sourceItems > 0
        ? routeItems.filter((item) => item.origin !== 'CRAWL_ONLY').map((item) => routeOf(item.key))
        : null,
    /*
     * The source-side fence, and the same string the worker passes. Beyond the
     * cap the declared list is a PAGE of this project's route items, so a route
     * the code does declare can arrive at the comparison missing — which is
     * precisely the negative a retirement needs. `obsolete.ts` withholds every
     * proposal on it, exactly as it does for a truncated crawl.
     */
    declaredRoutesTruncatedReason: routeItemsTruncated
      ? `QAAI read the first ${DRIFT_ROUTE_ITEM_SCAN_LIMIT} route items of this project and there are more`
      : null,
    retiredRoutes: routeItems
      .filter((item) => item.retiredAt !== null)
      .map((item) => routeOf(item.key)),
  });

  res.json({
    crawledAt: crawl?.createdAt ?? null,
    crawlVersion: crawl?.version ?? null,
    sourceAnalysed: report.sourceAnalysed,
    /*
     * Both caps, on the response rather than only in a server log. A screen
     * showing "12 tests compared" with no sign that there are 900 is a screen
     * that cannot be acted on, and `routesCompared` is the authority behind
     * every OBSOLETE row on it.
     */
    testsCompared: report.tests.length,
    testsTruncated,
    testScanLimit: DRIFT_TEST_SCAN_LIMIT,
    routesCompared: routeItems.length,
    routeItemsTruncated,
    routeItemScanLimit: DRIFT_ROUTE_ITEM_SCAN_LIMIT,
    declaredRoutesTruncatedReason: report.declaredRoutesTruncatedReason,
    drift: driftCheck(report),
    /*
     * Every verdict, not only the warnings. A screen that shows six drifted
     * tests out of an unstated total is a screen that cannot be acted on, and
     * the UNREACHED and UNMEASURED rows are the ones a reader has to see in
     * order to trust the OBSOLETE ones.
     */
    tests: report.tests,
  });
});

// Chat lives in routes/copilot.ts — it outgrew this file the moment it
// gained tools and an approval gate.
