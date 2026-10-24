/**
 * Generate processor (§3.2): turns approved plan items into real test files.
 *
 * Each item is generated independently so one bad item cannot take the batch
 * down — a plan of ten where one fails should produce nine tests and one
 * recorded error, not zero tests.
 *
 * ── THE TWO WAYS THIS USED TO INFLATE COVERAGE ──────────────────────────────
 *
 *  1. IT STORED WHATEVER CAME BACK. A `Test` row was written, counted towards
 *     coverage and shown in the cockpit with nothing checked: no parse, no
 *     assertion count, no comparison against the plan item a human approved.
 *     `generateTest` now runs the generation gate (`@qaai/agent`'s `admit`) and
 *     THROWS {@link GenerationRefused} rather than returning a test that failed
 *     it. This processor's job is to make that refusal visible — see
 *     {@link recordRefusal} — instead of dropping the work silently.
 *
 *  2. IT NEVER ASKED WHETHER THE TEST ALREADY EXISTED. Approving the same plan
 *     twice ran generation twice and minted two rows for one plan item, each
 *     counted separately; approving a plan over an imported suite minted a test
 *     the suite already had. Both are numerator inflation with no new coverage,
 *     and both are closed here: a plan item that already has a test is not
 *     generated again, and every other item is handed the bounded candidate set
 *     in {@link duplicateCandidates} for the gate's DUPLICATE check.
 *
 * Everything else is unchanged on purpose: the per-item isolation, the audit
 * trail (`TestVersion` v1 with `source: 'GENERATOR'`), the plan-item state
 * transition to GENERATED, the "Generated" suite upsert, and the job-level
 * throw when a batch produced nothing at all.
 */

import { GenerationRefused, generateTest } from '@qaai/agent';
import type { AdmissionInput } from '@qaai/agent';
import type { FlowMap, GenerateJob, Priority, TestType } from '@qaai/shared';
import { llm, logger, prisma } from '../context.js';
import { secretsFor } from '../vault.js';

/**
 * The append-only record a refusal leaves behind.
 *
 * `AuditLog` is this product's existing human-visible, org-scoped, append-only
 * trail (Settings → Audit log, with CSV export), and it is the only place a
 * refusal can be written today without a schema change: `PlanItemState` has no
 * REFUSED member, and REJECTED means "a human declined this item", which a
 * generation refusal is not. So the row carries the reason and the row's
 * `userId` is whoever approved the plan.
 */
export const GENERATE_AUDIT_ACTIONS = { refused: 'generate.refused' } as const;

/**
 * How many existing tests are read and compared per plan item.
 *
 * TWO HUNDRED, and the cap is about COST rather than taste. Every candidate's
 * source has to be loaded out of Postgres and scanned by `extractBehavior`
 * before the gate can compare anything; a 5,000-test project would mean tens of
 * megabytes per plan item and a batch of ten would read it ten times. The rule
 * below is written so the failure mode is A MISSED DUPLICATE — one extra test
 * in a suite, visible in the duplicate report that `suite-health.ts` already
 * produces — and never a generation that times out or exhausts the worker.
 */
export const DUPLICATE_CANDIDATE_CAP = 200;

type ExistingTests = NonNullable<AdmissionInput['existing']>;

const CANDIDATE_COLUMNS = {
  id: true,
  name: true,
  filePath: true,
  code: true,
  spec: true,
  type: true,
} as const;

/**
 * The tests this plan item's test is compared against, and the stated rule.
 *
 * THE RULE, in order:
 *   1. Same project. A duplicate across projects is not a duplicate.
 *   2. Same test TYPE. An API test and an E2E test over the same route are two
 *      different tests of it, not one test twice — and `type` is half of the
 *      `@@index([projectId, type])` the schema already carries, so this is the
 *      one narrowing that is free.
 *   3. SAME FEATURE FIRST, then other features, each newest first. A plan item
 *      names its feature, and the duplicate that actually happens — the same
 *      plan approved twice, or a plan approved over an imported suite — lands
 *      on the same feature with a near-identical title. Filling the remaining
 *      budget from other features (including tests with no feature at all,
 *      which is how most imports arrive) is what catches the case where the
 *      feature strings disagree about the same journey.
 *   4. Disabled tests are INCLUDED. "You already have this test" is true of a
 *      disabled one, and re-minting it is how a test someone switched off comes
 *      back under a new id.
 *
 * WHAT IT CAN MISS, said plainly:
 *   • A duplicate of a DIFFERENT type — an E2E test duplicating a SMOKE test
 *     of the same journey. By design: those are different runners with
 *     different criteria.
 *   • Anything beyond the {@link DUPLICATE_CANDIDATE_CAP} most recent tests of
 *     this type. In a project with more, an OLD duplicate goes unfound. The
 *     caller is told — `truncated` becomes a review flag on the test that was
 *     stored, so the one test whose comparison was partial says so, rather than
 *     every test in the product carrying a permanent caveat.
 *   • A test whose source the gate could not read completely: `findDuplicates`
 *     refuses to compare a partial reading (a subset of a test's behaviour can
 *     only make two tests look MORE alike), and names each one it skipped in
 *     the DUPLICATE gate's detail lines.
 */
export async function duplicateCandidates(args: {
  orgId: string;
  projectId: string;
  type: TestType;
  feature: string | null;
  cap?: number;
}): Promise<{ existing: ExistingTests; truncated: boolean }> {
  const { orgId, projectId, type, feature } = args;
  const cap = args.cap ?? DUPLICATE_CANDIDATE_CAP;

  const sameFeature = await prisma.test.findMany({
    where: { orgId, projectId, type, feature },
    orderBy: { createdAt: 'desc' },
    // One more than the cap, so "there are more of these" is a fact rather
    // than an inference from a full page.
    take: cap + 1,
    select: CANDIDATE_COLUMNS,
  });

  const rows = sameFeature.slice(0, cap);
  let truncated = sameFeature.length > cap;
  const remaining = cap - rows.length;

  if (remaining > 0) {
    const otherFeatures = await prisma.test.findMany({
      where: {
        orgId,
        projectId,
        type,
        /*
         * Spelled as an explicit OR rather than a bare `not`. In SQL,
         * `NOT (feature = 'checkout')` is NULL for a row whose feature is NULL
         * and the row is dropped — and a test with no feature is the commonest
         * shape an imported suite has, which is exactly the suite a plan gets
         * approved over. Naming the NULL branch makes the set correct whatever
         * the query builder does with `not` on a nullable column.
         */
        ...(feature === null
          ? { feature: { not: null } }
          : { OR: [{ feature: null }, { feature: { not: feature } }] }),
      },
      orderBy: { createdAt: 'desc' },
      take: remaining + 1,
      select: CANDIDATE_COLUMNS,
    });
    truncated = truncated || otherFeatures.length > remaining;
    rows.push(...otherFeatures.slice(0, remaining));
  }

  return {
    existing: rows.map((row) => ({
      id: row.id,
      name: row.name,
      filePath: row.filePath,
      code: row.code,
      spec: row.spec,
      type: row.type,
    })),
    truncated,
  };
}

/**
 * A refusal, made visible to the human who approved the plan item.
 *
 * Three channels, because the thing being prevented is a refusal that looks
 * like nothing happening:
 *
 *   1. An `AuditLog` row against the PLAN ITEM, attributed to whoever approved
 *      the plan (`job.requestedBy`), carrying the failing gates, their reasons
 *      and their evidence lines. That is the record someone can find later.
 *   2. An error-level log line naming the item and the reason, for whoever is
 *      watching the worker.
 *   3. The plan item's STATE, by omission: it stays APPROVED with no
 *      `generatedTestId`, so the approval screen shows it as approved and not
 *      generated, and re-approving the plan tries again. It is never marked
 *      GENERATED, which was the thing that made a refusal invisible, and never
 *      marked REJECTED, which would put words in a human's mouth.
 *
 * The refused SOURCE is deliberately not kept. The gate's evidence lines quote
 * the offending lines, which is what a reader needs; copying the whole file
 * into an append-only table would be storing the broken test after all, one
 * table over.
 *
 * Best-effort, in the shape apps/api's `audit()` already uses: a failed audit
 * write must not take the rest of the batch down, and it is logged at error so
 * it cannot pass unnoticed.
 */
async function recordRefusal(job: GenerateJob, refusal: GenerationRefused): Promise<void> {
  const failed = refusal.report.gates.filter((gate) => gate.status === 'FAIL');
  try {
    await prisma.auditLog.create({
      data: {
        orgId: job.orgId,
        // Empty for an API-key actor, and the column is a nullable FK.
        userId: job.requestedBy || null,
        action: GENERATE_AUDIT_ACTIONS.refused,
        targetType: 'PlanItem',
        targetId: refusal.planItemId,
        metadata: {
          testPlanId: job.testPlanId,
          projectId: job.projectId,
          planItemTitle: refusal.planItemTitle,
          verdict: refusal.report.verdict,
          attempts: refusal.attempts,
          wouldHaveBeenStoredAt: refusal.filePath,
          failedGates: refusal.failedGates,
          reasons: failed.map((gate) => ({
            gate: gate.gate,
            why: gate.why,
            line: gate.line,
            detail: gate.detail,
          })),
          // Every gate that could not run, so the row cannot be read as "the
          // rest was checked and fine".
          notChecked: refusal.report.gates
            .filter((gate) => gate.status === 'UNAVAILABLE')
            .map((gate) => gate.gate),
          reviewFlags: refusal.report.reviewFlags,
        },
      },
    });
  } catch (err) {
    logger.error(
      { err, itemId: refusal.planItemId, action: GENERATE_AUDIT_ACTIONS.refused },
      'could not write the audit row for a refused generation',
    );
  }
}

export async function processGenerate(job: GenerateJob): Promise<void> {
  const { orgId, projectId, testPlanId, planItemIds } = job;

  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId },
    select: { id: true, primaryLanguage: true, primaryFramework: true },
  });
  if (!project) throw new Error(`Project ${projectId} not found for org ${orgId}`);

  const plan = await prisma.testPlan.findFirst({
    where: { id: testPlanId, orgId },
    select: { id: true, flowMapId: true },
  });
  if (!plan) throw new Error(`Test plan ${testPlanId} not found`);

  const flowMapRow = plan.flowMapId
    ? await prisma.flowMap.findUnique({ where: { id: plan.flowMapId } })
    : await prisma.flowMap.findFirst({ where: { orgId, projectId }, orderBy: { version: 'desc' } });
  if (!flowMapRow) throw new Error('No flow map to generate against — run the Explorer first');

  const flowMap = flowMapRow.graph as unknown as FlowMap;

  const environment = await prisma.environment.findFirst({
    where: { orgId, id: flowMapRow.environmentId },
    select: { id: true },
  });
  const secretNames = environment ? Object.keys(await secretsFor(orgId, environment.id)) : [];

  const items = await prisma.planItem.findMany({
    where: { id: { in: planItemIds }, orgId, testPlanId },
  });

  // One suite per generation batch keeps the cockpit's left pane meaningful
  // instead of a flat list that grows forever.
  const suite = await prisma.suite.upsert({
    where: { projectId_name: { projectId, name: 'Generated' } },
    create: { orgId, projectId, name: 'Generated', description: 'Tests written by the Generator' },
    update: {},
  });

  let created = 0;
  let alreadyGenerated = 0;
  const failures: Array<{ itemId: string; error: string }> = [];
  const refusals: Array<{ itemId: string; reason: string }> = [];

  for (const item of items) {
    try {
      /*
       * APPROVING A PLAN TWICE. The stated defect, and the cheapest possible
       * place to stop it: before a strong-tier model call, not after one.
       *
       * Disabled tests count — "you already have this test" is true of a test
       * someone switched off, and re-minting it would resurrect it under a new
       * id. The plan item's pointer is repaired on the way past, because an
       * item that HAS a test but is not marked GENERATED is drift that would
       * make this branch fire for ever.
       */
      const already = await prisma.test.findFirst({
        where: { orgId, projectId, planItemId: item.id },
        select: { id: true, name: true, filePath: true },
        orderBy: { createdAt: 'asc' },
      });
      if (already) {
        await prisma.planItem.update({
          where: { id: item.id },
          data: { state: 'GENERATED', generatedTestId: already.id },
        });
        alreadyGenerated += 1;
        logger.warn(
          { itemId: item.id, title: item.title, testId: already.id, filePath: already.filePath },
          'plan item already has a test; not generating a second one',
        );
        continue;
      }

      /*
       * Fetched per item rather than once per batch, deliberately: a test this
       * loop stored a moment ago is in the candidate set for the next item, so
       * two identical items in ONE approval cannot both be minted.
       */
      const candidates = await duplicateCandidates({
        orgId,
        projectId,
        type: item.testType,
        feature: item.feature,
      });

      const generated = await generateTest(
        llm,
        { orgId, projectId, agent: 'GENERATOR', subjectId: item.id },
        {
          item: {
            id: item.id,
            title: item.title,
            rationale: item.rationale,
            feature: item.feature,
            priority: item.priority as Priority,
            testType: item.testType as TestType,
            steps: item.steps as string[],
            assertions: item.assertions as string[],
            journeyId: item.journeyId,
            authProfileId: item.authProfileId,
          },
          flowMap,
          language: project.primaryLanguage,
          framework: project.primaryFramework,
          availableSecretNames: secretNames,
          existing: candidates.existing,
          /*
           * No `toolchain`. SYNTAX, TYPECHECK, FORMAT and LINT need the
           * customer's own prettier/eslint/tsc, which need their repository on
           * disk — and a generate job never materialises one. All four
           * therefore report UNAVAILABLE and all four land in `reviewFlags`
           * below, which is the honest outcome rather than a PASS from a tool
           * that never ran. `GenerateTestArgs.toolchain` in
           * packages/agent/src/generator.ts names exactly what wiring
           * `repo-materialise.ts` in here would involve.
           */
        },
      );

      const reviewFlags = [...generated.reviewFlags];
      /*
       * The role travels from the plan item onto the test, and this is the link
       * that makes the whole chain mean anything: the gap names a profile, the
       * plan item carries it, and if THIS line is missing the test arrives
       * anonymous, runs as a signed-out visitor, passes whatever that visitor
       * can see, and is counted as coverage of a page it never reached.
       *
       * `authProfileRequired` is the INTENT, stored apart from the binding, so
       * that a deleted profile (the FK is SetNull) leaves `(required: true,
       * id: null)` — a state nothing else can produce, which is how coverage
       * analysis tells "never needed a role" from "its role was deleted".
       */
      if (item.authProfileId === null) {
        /*
         * An item that asked for a role and did not get one. Today the ask is a
         * sentence the gap wrote into the steps rather than a field — PlanItem
         * carries only the id — so this reads those words. A flag is the point:
         * the test will run anonymously, and a human has to know that before
         * trusting a pass.
         */
        const wantedRole = /\bsign(?:ed)?\s*in\b|\bauth profile\b|\blog(?:ged)?\s*in\b/i.test(
          // Json columns; cast as the generator call above already does.
          `${(item.steps as string[]).join(' ')} ${(item.assertions as string[]).join(' ')}`,
        );
        if (wantedRole) {
          reviewFlags.push(
            'This test describes signing in but is bound to no auth profile, so the runner will execute it as a signed-out visitor. Bind an auth profile before trusting a pass here.',
          );
        }
      }
      if (candidates.truncated) {
        reviewFlags.push(
          `Only the ${candidates.existing.length} most recent ${item.testType} test(s) in this project were compared for duplication, and this project has more — an older test covering the same journey would not have been found.`,
        );
      }

      const test = await prisma.test.create({
        data: {
          orgId,
          projectId,
          suiteId: suite.id,
          name: generated.name,
          type: item.testType,
          feature: item.feature,
          priority: item.priority,
          // `generated.code` is the code AS ADMITTED: the FORMAT gate may have
          // rewritten it with the customer's own formatter, and every line
          // number in the review flags refers to this text.
          code: generated.code,
          // Spec-driven and hybrid types live or die on this column — their
          // plugin executes `spec` and never reads `code`. The generator has
          // already validated it against the plugin's own schema.
          ...(generated.spec !== null && generated.spec !== undefined
            ? { spec: generated.spec as object }
            : {}),
          // The admitted path, which PATH_CONVENTION may have corrected: a path
          // the runner cannot collect is a file nobody executes, under a suite
          // that goes green.
          filePath: generated.filePath,
          tags: item.priority === 'CRITICAL_PATH' ? ['smoke'] : [],
          reviewFlags,
          // See the comment above `reviewFlags`: without these two the plan
          // item's role is dropped on the floor here.
          authProfileId: item.authProfileId,
          authProfileRequired: item.authProfileId !== null,
          planItemId: item.id,
          versions: {
            create: {
              orgId,
              version: 1,
              code: generated.code,
              source: 'GENERATOR',
              message: `Generated from plan item "${item.title}"`,
            },
          },
        },
      });

      await prisma.planItem.update({
        where: { id: item.id },
        data: { state: 'GENERATED', generatedTestId: test.id },
      });

      created += 1;
      logger.info(
        {
          testId: test.id,
          name: test.name,
          flags: reviewFlags.length,
          // What the gate actually concluded, so a flagged test in the cockpit
          // can be traced back to a verdict in the log.
          verdict: generated.admission?.verdict ?? 'NOT_ADMITTED',
          attempts: generated.attempts,
          notChecked: (generated.admission?.gates ?? [])
            .filter((gate) => gate.status === 'UNAVAILABLE')
            .map((gate) => gate.gate),
          comparedAgainst: candidates.existing.length,
        },
        'test generated',
      );
    } catch (err) {
      /*
       * A REFUSAL IS NOT A CRASH. The pipeline worked: a test that would have
       * been counted as coverage without covering anything was not stored. It
       * is recorded, the plan item is left visibly un-generated, and the batch
       * carries on with the next item.
       */
      if (err instanceof GenerationRefused) {
        await recordRefusal(job, err);
        refusals.push({ itemId: item.id, reason: err.message });
        logger.error(
          {
            itemId: item.id,
            title: item.title,
            failedGates: err.failedGates,
            attempts: err.attempts,
            reason: err.message,
          },
          'generation refused: nothing was stored for this approved plan item',
        );
        continue;
      }

      const message = err instanceof Error ? err.message : String(err);
      failures.push({ itemId: item.id, error: message });
      logger.error({ err, itemId: item.id, title: item.title }, 'generation failed for plan item');
    }
  }

  logger.info(
    {
      created,
      refused: refusals.length,
      alreadyGenerated,
      failed: failures.length,
      planId: testPlanId,
    },
    'generation batch complete',
  );

  /*
   * Nothing was produced — surface it as a job failure so it shows up in the
   * admin panel instead of looking like a successful no-op. A batch where every
   * item was REFUSED counts: the audit rows explain each one, but a job that
   * reports success having written nothing is how a refusal becomes invisible.
   *
   * A batch where every item ALREADY had a test is not a failure. Nothing was
   * produced because nothing needed producing, and every one of those items now
   * points at the test it already had.
   */
  if (created === 0 && (failures.length > 0 || refusals.length > 0)) {
    const first = failures[0]?.error ?? refusals[0]!.reason;
    throw new Error(`Generation produced no tests. First error: ${first}`);
  }
}
