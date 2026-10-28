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

import { GenerationRefused, generateTest, summariseCorpus } from '@qaai/agent';
import type { AdmissionInput, CorrectionSignal } from '@qaai/agent';
import { MAX_CORPUS_ROWS } from '@qaai/agent';
import { z } from 'zod';
import { principalSchema, styleProfileSchema } from '@qaai/shared';
import type { FlowMap, GenerateJob, Priority, TestType } from '@qaai/shared';
/*
 * Reached by a RELATIVE PATH ACROSS THE WORKSPACE BOUNDARY, which is a defect
 * and is recorded as one — `routes/agent.ts` carries the same note for
 * `suite-health.js`. `packages/shared/src/index.ts` has no
 * `export * from './artifact-set'`, and the obvious one-line fix does NOT
 * compile: `artifact-set.ts` and `requirements.ts` both export a type named
 * `ContentDigest` and `requirements` is already in that barrel, so a star
 * export is TS2308 on it. The working edit is in this round's handover.
 */
import {
  SHARED_ROLES,
  corpusScope,
  corpusWhere,
} from '../../../../packages/shared/src/artifact-set.js';
import type { ArtifactRole, ArtifactSet } from '../../../../packages/shared/src/artifact-set.js';
import type { StyleProfile } from '../../../../packages/shared/src/style-profile.js';
import { createHash } from 'node:crypto';
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

/**
 * Artifact roles that belong to no single test, so their ledger row carries
 * `testId: null`.
 *
 * Derived from `SHARED_ROLES` in packages/shared/src/artifact-set.ts rather than
 * listed again, so a role whose sharedness changes there cannot keep its old
 * meaning here. Attaching a shared page object to the first spec that imported
 * it would make deleting that test look like permission to delete the page
 * object.
 */
export const SHARED_ARTIFACT_ROLES: ReadonlySet<ArtifactRole> = new Set(
  (Object.entries(SHARED_ROLES) as Array<[ArtifactRole, boolean]>)
    .filter(([, shared]) => shared)
    .map(([role]) => role),
);

/** One validated actor, as `principalSchema` defines it. */
export type PlanItemPrincipal = z.infer<typeof principalSchema>;

/**
 * THE ACTORS, CARRIED FROM THE PLAN ITEM ONTO THE TEST.
 *
 * `PlanItem.principals` and `Test.principals` both exist, and the schema comment
 * on the first says in so many words that "the Generator copies this across when
 * it turns the item into a test". THIS IS THAT COPY, and without it the column
 * is written by a producer and read by nothing: a multi-actor scenario's two
 * actors are lost between the plan and the test, the runner resolves one
 * session, and an invite-and-accept test runs as one identity pretending to be
 * two — which passes, because one actor can always see its own invite.
 *
 * ── THE THREE STATES, PRESERVED ────────────────────────────────────────────
 *
 *   null  "this item predates principals". The single-identity case, which is
 *         every test in the product today.
 *   []    "it declares none". ALSO the single-identity case, and deliberately
 *         not merged with null — one says nobody asked and the other says
 *         somebody asked and the answer was none.
 *   rows  the actors, each validated.
 *
 * ── WHY A PARSE FAILURE IS A REVIEW FLAG AND NOT A THROW ───────────────────
 *
 * The column is Json, so it can hold anything a previous writer put there.
 * Refusing the whole generation over an unreadable actor list would lose a test
 * that is otherwise fine; copying the list through unvalidated would put
 * whatever is in that column in front of the runner, and `principalSchema` is
 * `.strict()` precisely because it must have no field a credential could sit
 * in. So an unreadable list becomes NO list plus a flag that SAYS the actors
 * were dropped — the test runs single-identity and the human is told, rather
 * than the test running single-identity while claiming two.
 */
export function readPlanItemPrincipals(raw: unknown): {
  /*
   * The PARSED rows, not `unknown[]`. Typed deliberately: `unknown[]` is not
   * assignable to Prisma's Json input (no index signature), and the compiler
   * refusing it is the right outcome — it means nothing can reach that column
   * without having been through `principalSchema`, which is the whole point of
   * this function.
   */
  principals: PlanItemPrincipal[] | null;
  flag: string | null;
} {
  if (raw === null || raw === undefined) return { principals: null, flag: null };
  if (!Array.isArray(raw)) {
    return {
      principals: null,
      flag:
        'This plan item\u2019s `principals` column is not a list, so the actors it named could not be read and this test will run as a single identity. A two-actor scenario executed as one actor passes trivially \u2014 one actor can always see its own invite \u2014 so do not trust a pass here until the column is fixed.',
    };
  }
  if (raw.length === 0) return { principals: [], flag: null };

  const parsed = principalSchema.array().max(16).safeParse(raw);
  if (!parsed.success) {
    return {
      principals: null,
      flag: `This plan item named ${raw.length} actor(s) and the list did not validate (${parsed.error.issues[0]?.message ?? 'unknown reason'}), so none of them was copied onto the test and it will run as a single identity. Nothing from that column was passed through unchecked.`,
    };
  }
  return { principals: parsed.data, flag: null };
}

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
 * THIS REPOSITORY'S OWN CONVENTIONS, READ OUT OF THE CACHE.
 *
 * `Project.styleProfile` is a cached `StyleProfile` and `styleProfileComputedAt`
 * is NULL exactly when it is. Nothing computed it before this round, so the
 * commonest answer here is "none", and that answer travels as `null` — which
 * `generateTest` turns into a REVIEW FLAG rather than into silence.
 *
 * ── A STORED BLOB IS NOT A PROFILE UNTIL IT PARSES ─────────────────────────
 *
 * The column is Json, so it holds whatever a previous writer put there — and
 * `styleProfileSchema` does not merely shape-check: it re-derives every
 * confidence from the evidence counts beside it and refuses a mismatch. A
 * profile that failed that check is a profile whose confidences somebody chose
 * rather than computed, and feeding it to the prompt would state a HIGH-
 * confidence convention over one file.
 *
 * So an unparseable blob becomes NO profile plus a flag that SAYS so, exactly
 * as {@link readPlanItemPrincipals} handles an unreadable actor list, and for
 * the same reason: the alternative is either losing the whole generation or
 * putting an unchecked value in front of the model.
 */
export function readStyleProfile(
  raw: unknown,
  computedAt: Date | null,
): { profile: StyleProfile | null; flag: string | null } {
  if (raw === null || raw === undefined) return { profile: null, flag: null };

  const parsed = styleProfileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      profile: null,
      flag: `This project has a stored house-style profile and it did not validate (${
        parsed.error.issues[0]?.message ?? 'unknown reason'
      }), so none of it was stated to the generator and this test was written to the ecosystem defaults. Nothing from that column was passed through unchecked.`,
    };
  }
  /*
   * The pair is checked, not assumed. The schema comment on the column says
   * `styleProfileComputedAt` is NULL exactly when `styleProfile` is NULL, and a
   * profile with no date is a profile of unknown age — which is the one fact
   * that decides whether it is worth stating at all.
   */
  if (computedAt === null) {
    return {
      profile: null,
      flag:
        'This project has a stored house-style profile with no computed-at date, so how old it is ' +
        'cannot be answered. A profile computed before a repository’s last fifty commits makes ' +
        'every generated test wrong in the same way, so it was not used.',
    };
  }
  return { profile: parsed.data as StyleProfile, flag: null };
}

/**
 * WHAT REVIEWERS IN THIS PROJECT KEEP CHANGING.
 *
 * ── THE PROJECT BOUNDARY, AND WHY IT IS THREE THINGS AND NOT A COMMENT ─────
 *
 * This corpus is customer test code. `corpusScope` is the only constructor for
 * the branded scope and requires BOTH ids, `corpusWhere` is the only way to get
 * a where-clause out of it, and `summariseCorpus` re-checks every row against
 * the scope at RUN TIME and reports `rowsRejected`. The compile-time half is
 * defeated by any caller that builds a raw query; the run-time half catches it
 * and COUNTS it rather than averaging it in.
 *
 * ── THE WINDOW, DISCLOSED ──────────────────────────────────────────────────
 *
 * `MAX_CORPUS_ROWS` newest-first. Reviewer behaviour changes, so a four-year-old
 * correction is not evidence about this quarter's reviewers — and the opposite
 * rule applies to exemplars, which are chosen by SIMILARITY and never by
 * recency. Both are deliberate and both are stated in their own modules.
 * `signal.rowsOmitted` carries how many older rows were not read.
 */
async function reviewerSignal(args: {
  orgId: string;
  projectId: string;
}): Promise<CorrectionSignal | null> {
  const scope = corpusScope(args.orgId, args.projectId);
  const rows = await prisma.testCorrection.findMany({
    where: corpusWhere(scope),
    orderBy: { createdAt: 'desc' },
    take: MAX_CORPUS_ROWS,
    /*
     * Narrowed deliberately, and `select` is what makes a Prisma fake able to
     * prove a field was dropped from this query. The row's `before`/`after`
     * quotes live inside `items`; nothing else on the table is read.
     */
    select: {
      orgId: true,
      projectId: true,
      testId: true,
      generatedVersion: true,
      humanVersion: true,
      generatedVersionId: true,
      humanVersionId: true,
      kinds: true,
      items: true,
      surface: true,
      addedLines: true,
      removedLines: true,
      unclassifiedCount: true,
      itemsOmitted: true,
      classifierVersion: true,
      createdAt: true,
    },
  });
  if (rows.length === 0) return null;

  return summariseCorpus(
    scope,
    /*
     * `items` is a Prisma `JsonValue` here and `CorrectionItem[]` on the other
     * side. The cast is on the WHOLE array argument rather than per row, so
     * there is ONE place where the Json column is asserted to be the shape the
     * classifier wrote — and `testCorrectionSchema` is what guarantees it,
     * because nothing reaches that column except through it.
     */
    rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) as never,
  );
}

/**
 * One row of the ownership ledger, as this processor writes it.
 *
 * NAMED rather than inlined on the return type, and the reason is narrow: the
 * two `.map()` calls below build object literals, and an inline return type
 * does not flow into them — `role` widens to `string` and the array stops being
 * assignable. The alternative was `'PAGE_OBJECT' as ArtifactRole` on one
 * literal, which eslint correctly reports as unnecessary at the point it is
 * written and which the compiler then needs anyway. A name satisfies both.
 */
interface LedgerRow {
  orgId: string;
  projectId: string;
  path: string;
  role: ArtifactRole;
  /**
   * The two states this processor may record. `HUMAN_EDITED` is NOT one of
   * them: it is a transition a human's own save earns, written where that save
   * is seen (see the corrections sync in apps/api/src/routes/agent.ts), and a
   * generation that could write it would be claiming somebody edited a file it
   * has just created.
   */
  ownership: 'QAAI_OWNED' | 'HUMAN_AUTHORED';
  testId: string | null;
  contentHash: string;
  bytes: number;
  imports: string[];
}

/**
 * THE OWNERSHIP LEDGER ROWS ONE GENERATED SET OWES.
 *
 * Written AFTER the `Test` row and NOT in the same transaction, and the
 * direction of the failure is why that is safe: a missing ledger row resolves
 * `UNRECORDED`, `UNRECORDED` is not writable, and the next sync therefore
 * REFUSES to touch the file rather than overwriting it. A failed ledger write
 * degrades into "QAAI will not claim this file", which is the fail-closed
 * direction.
 *
 * ── WHAT THIS FUNCTION CANNOT CHECK, AND WHAT CARRIES THE CLAIM INSTEAD ─────
 *
 * It has NO parameter through which the customer's repository could be
 * consulted, and the generate processor materialises no workspace, so at the
 * moment these rows are written NOTHING HAS LOOKED AT THESE PATHS. A path a
 * human has owned for months therefore earns a `QAAI_OWNED` row. An earlier
 * version of this comment claimed the reverse — that a row for a file nobody
 * created "would be a recorded permission to overwrite whatever lands at that
 * path, and that is the one failure this table exists to prevent" — which was
 * a description of the intent, not of this code.
 *
 * What makes the blind row harmless is the OTHER column. `contentHash` is the
 * digest of the bytes IN THE SET, so the row says "QAAI wrote exactly these
 * bytes here" and nothing weaker; `replaceDecision` in apps/api/src/lib/git.ts
 * — the one gate both of `pushRepo`'s passes go through — refuses any write or
 * delete whose branch bytes do not hash to it, with the reason BYTES_DIVERGED.
 * So the verdict alone authorises nothing, which is proved end to end over this
 * exact producer in generate.claim.verify.test.ts.
 *
 * `skipDuplicates`, because `@@unique([projectId, path])` is the invariant that
 * stops two rows answering "may QAAI write this": if a row is already there,
 * the EXISTING fact wins. A row saying HUMAN_EDITED must never be downgraded to
 * QAAI_OWNED by a later generation at the same path — which is exactly what an
 * upsert would do.
 */
export function ledgerRowsFor(args: {
  set: ArtifactSet;
  /** Stamped explicitly: the worker's Prisma client carries no tenancy extension. */
  orgId: string;
  /** Repo-relative paths this set IMPORTS that are a human's, per `ArtifactPlan.recordAsTheirs`. */
  recordAsTheirs: readonly string[];
  projectId: string;
  testId: string;
  /** Roles that belong to exactly one spec. A shared file belongs to neither. */
  sharedRoles: ReadonlySet<ArtifactRole>;
}): LedgerRow[] {
  const digest = (input: string): string => createHash('sha256').update(input).digest('hex');
  const rows: LedgerRow[] = args.set.artifacts.map((artifact) => ({
    orgId: args.orgId,
    projectId: args.projectId,
    path: artifact.path,
    role: artifact.role,
    ownership: 'QAAI_OWNED' as const,
    /*
     * NULL for a shared role. A page object two specs import belongs to
     * neither, and attaching it to the first one would make deleting that test
     * look like permission to delete the page object.
     */
    testId: args.sharedRoles.has(artifact.role) ? null : args.testId,
    contentHash: digest(artifact.content),
    bytes: artifact.content.length,
    imports: [...artifact.imports],
  }));

  /*
   * THE HUMAN FILES THIS SET IMPORTS, recorded as HUMAN_AUTHORED.
   *
   * Two things go wrong without these rows and the first bites immediately:
   * `artifactSetProblems` resolves an import against the set or against the
   * LEDGER, so a spec importing a human's page object — a file that plainly
   * exists and is in neither — is refused with UNRESOLVED_IMPORT for ever. The
   * second is slower and worse: with no row at that path a later run resolves
   * it UNRECORDED, and UNRECORDED is the state a reservation may claim.
   *
   * `contentHash` is the EMPTY-STRING digest and the comment says so rather
   * than letting a reader think we hashed their file: we have not read it, and
   * the hash on a HUMAN_AUTHORED row is never compared against anything —
   * `WRITABLE_BY_OWNERSHIP` refuses the write before any hash is consulted.
   */
  const theirs: LedgerRow[] = args.recordAsTheirs.map((path) => ({
    orgId: args.orgId,
    projectId: args.projectId,
    path,
    role: 'PAGE_OBJECT',
    ownership: 'HUMAN_AUTHORED' as const,
    testId: null,
    contentHash: digest(''),
    bytes: 0,
    imports: [] as string[],
  }));

  return [...rows, ...theirs];
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
    select: {
      id: true,
      primaryLanguage: true,
      primaryFramework: true,
      // The two columns this round minted. See `readStyleProfile` for why the
      // date is read alongside the blob rather than trusted to agree with it.
      styleProfile: true,
      styleProfileComputedAt: true,
    },
  });
  if (!project) throw new Error(`Project ${projectId} not found for org ${orgId}`);

  /*
   * ── WHAT THIS PROJECT HAS TAUGHT US, READ ONCE PER BATCH ───────────────────
   *
   * Both are per-project facts, not per-item ones: the house style is a property
   * of the repository and the reviewer signal is a property of its reviewers. A
   * batch of ten items reading them ten times would be ten identical queries,
   * and — worse — ten chances for two items in one batch to be generated against
   * different answers.
   *
   * Every absence here is reported rather than silent. `generateTest` turns a
   * null profile and a null signal into review flags on each test it writes
   * (`houseStyleFlags`), because a test written with no knowledge of the
   * repository's conventions and a test that matched them perfectly are
   * indistinguishable in the output.
   */
  const style = readStyleProfile(project.styleProfile, project.styleProfileComputedAt);
  const correctionSignal = await reviewerSignal({ orgId, projectId });

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

  /*
   * APPROVED ITEMS ONLY, and the filter is defence in depth rather than
   * decoration.
   *
   * The producers are supposed to make it impossible — POST /plans/:id/approve
   * approves before it enqueues, POST /coverage/:id/propose mints its items
   * APPROVED because the ticking already happened, and the closure campaign
   * writes PROPOSED precisely when its project's policy is HUMAN_REVIEW. So
   * this filter is for the paths that are NOT those three: a re-delivered job
   * carrying ids a human has since REJECTED, a job enqueued by hand, and the
   * one that matters — a HUMAN_REVIEW campaign whose items are waiting on the
   * approval screen and whose ids reach here anyway. Generating those would
   * spend a strong-tier model call on work nobody approved and then store a
   * test under a plan item that says it was never agreed to, which is the
   * approval policy being silently switched off.
   *
   * GENERATED is admitted alongside APPROVED on purpose: that is a redelivered
   * job over work that already landed, and the duplicate guard below is what
   * answers it — honestly, by pointing the item at the test it already has
   * rather than minting a second one. REJECTED and PROPOSED are the two that
   * must not be generated, and leaving them out of the query (rather than
   * filtering in the loop) means they cost nothing and are reported as a
   * difference in the batch's own log line.
   */
  const items = await prisma.planItem.findMany({
    where: { id: { in: planItemIds }, orgId, testPlanId, state: { in: ['APPROVED', 'GENERATED'] } },
  });
  /*
   * Counted rather than shrugged off. A job asking for ten items and finding
   * two is a producer or an approval screen disagreeing with this processor,
   * and a batch that silently generates eight is how that disagreement stays
   * invisible. The number cannot say WHICH reason applies — not approved, since
   * rejected, not in this plan, or never existed — so the log line does not
   * claim to.
   */
  const notGenerable = planItemIds.length - items.length;
  if (notGenerable > 0) {
    logger.warn(
      { planId: testPlanId, requested: planItemIds.length, generating: items.length },
      'some plan items in this job are not approved (or not in this plan); they were not generated',
    );
  }

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
           * THE TWO LEARNED CHANNELS. Both may be null and neither is silently
           * so — see the batch-level read above.
           */
          styleProfile: style.profile,
          correctionSignal,
          /*
           * NO `repository`, AND NO MULTI-FILE PLAN, AND IT IS A DECISION.
           *
           * `planArtifacts` decides where a page object goes from THEIR
           * layout — the ledger and the style profile — and it reads the
           * repository for two things a generate job cannot answer:
           * `filesUnder`, to find a page object that already exists so a second
           * `CartPage` is never minted, and `diskStateAt`, to say what a shared
           * file's dependents would lose when it is replaced.
           *
           * An `ArtifactRepository` that answered `[]` and `ABSENT` for both
           * would be a pass that means "we did not check", with a file write at
           * the end of it: a repository with a hand-written `CartPage` would
           * get a second one, which this round's rule TWO says is worse than
           * having none. The honest answer is UNREADABLE, and a plan over
           * UNREADABLE bytes is refused with DISK_UNREADABLE — so passing one
           * buys a refusal rather than a plan.
           *
           * Note what is NOT the reason: a brand-new set's paths are never read
           * from disk at all. "A NEW path is already occupied by a human's
           * file" is caught by `resolveAgainstRepository`'s reservations on the
           * APPLY path, which is also where the ledger half of
           * `artifactSetProblems` is asked.
           *
           * So the plan is not computed, the set is a set of one, and
           * `houseStyle.planned` plus a review flag SAY the setup is inline and
           * why. The missing piece is the same one `GenerateTestArgs.toolchain`
           * names: `repo-materialise.ts` already does the hard part
           * (`materialiseRepoWorkspace`), and the exact wiring — one workspace
           * per BATCH rather than per item, `toolchainFor({ repoRoot })` for
           * the four checkout gates, a `diskStateAt` prefetched through
           * `nodeWorkspaceFileReader` so the synchronous interface can be
           * honoured, and a `filesUnder` with the same per-segment symlink
           * refusal — is in this round's handover. It costs a tarball per batch,
           * which is why it is a decision and not an oversight.
           */
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
       * A stored profile that did not validate is a flag, not a throw. Appended
       * HERE rather than at the batch level because a review flag lives on a
       * test row, and there is no batch-level place for a human to read one.
       */
      if (style.flag !== null) reviewFlags.push(style.flag);

      /*
       * The actors travel from the item onto the test. See
       * {@link readPlanItemPrincipals} for why an unreadable list becomes a
       * flag rather than a throw or a silent pass-through.
       */
      const actors = readPlanItemPrincipals(item.principals);
      if (actors.flag !== null) reviewFlags.push(actors.flag);
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
          /*
           * THE SECOND IDENTITY, WHICH `authProfileId` HAS NOWHERE TO PUT.
           *
           * `authProfileId` above names at most ONE identity, and one identity
           * is what made "user A reads user B's invoice" inexpressible: the
           * only available approximation was to ask anonymously, which every
           * application denies, so the check passed everywhere. This column is
           * what the runner reads to resolve a session PER ACTOR.
           *
           * Null is not written over an existing value: a null `principals`
           * means "this item predates principals" and the column's default is
           * already null, so the key is omitted entirely rather than set — the
           * same shape `spec` uses two fields up, and for the same reason.
           */
          ...(actors.principals !== null ? { principals: actors.principals } : {}),
          planItemId: item.id,
          /*
           * THE PROVENANCE, copied onto the test AT BIRTH.
           *
           * The closure loop stamps this column on its next tick, by walking
           * the plan item — which works for every test a campaign is tracking
           * and for no other. A test generated from a plan item nobody is
           * tracking (a human clicking POST /coverage/:id/propose, most of
           * them) landed with `gapId: null` and the ledger could then never
           * name the test written for that gap. Copying it here is the only
           * moment both facts are in hand, and it makes the provenance
           * independent of whether a campaign exists and of whether the plan
           * survives: a TestPlan is deletable, and `Test → PlanItem → gap`
           * evaporates with it exactly when the loop needs it.
           *
           * NULL stays NULL. The Explorer proposes a cold plan from a crawl
           * with no gap behind it; `item.gapId` is null for those and a
           * back-filled id would invent a provenance that never existed.
           */
          gapId: item.gapId,
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

      /*
       * ── THE OWNERSHIP LEDGER ───────────────────────────────────────────────
       *
       * The single fact `pushRepo` lacked. Without a row here, the next git
       * sync resolves this path `UNRECORDED`, refuses to write it and refuses to
       * delete it — which is safe and useless: a test QAAI generated would
       * never reach the customer's branch.
       *
       * BEST-EFFORT, AND THE DIRECTION OF THE FAILURE IS WHY THAT IS SAFE. A
       * missing row means QAAI will not claim the file. A row written for a path
       * nothing examined is NOT a permission to overwrite what lands there — the
       * verdict is half the fact and the `contentHash` beside it is the other
       * half, which `replaceDecision` compares against the branch's own bytes
       * before anything is written or deleted. So a failure is logged at error
       * and flagged on nothing — the test row is already correct, and the honest
       * consequence is that the file will not sync until the ledger catches up.
       *
       * `skipDuplicates` is the invariant, not a convenience: `@@unique([
       * projectId, path])` exists so there is ONE answer to "may QAAI write
       * this", and an existing row — including a HUMAN_EDITED one — must win
       * over a later generation at the same path. An upsert here would
       * downgrade a human's claim back to QAAI_OWNED, which is the worst
       * failure available in this schema.
       */
      try {
        const rows = ledgerRowsFor({
          set: generated.artifacts,
          recordAsTheirs: generated.artifactPlan?.recordAsTheirs ?? [],
          orgId,
          projectId,
          testId: test.id,
          sharedRoles: SHARED_ARTIFACT_ROLES,
        });
        const written = await prisma.generatedArtifact.createMany({
          data: rows,
          skipDuplicates: true,
        });
        if (written.count < rows.length) {
          /*
           * A path somebody already has a recorded fact about. Reported as a
           * count rather than swallowed: it means a previous row — possibly a
           * HUMAN_EDITED one — holds that path, so this generation's file will
           * not be synced to it, and that is a thing a human should be able to
           * find out from the log rather than from a file that never appears.
           */
          logger.warn(
            {
              testId: test.id,
              planned: rows.length,
              recorded: written.count,
              paths: rows.map((row) => row.path),
            },
            'some generated paths already had an ownership row; the existing fact was kept',
          );
        }
      } catch (err) {
        logger.error(
          { err, testId: test.id, filePath: generated.filePath },
          'could not record the ownership ledger rows for a generated test; it will not be written to the customer repository until they exist',
        );
      }

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
          /*
           * COUNT ONLY, never the actors themselves. A principal carries a
           * name and an auth-profile id and `principalSchema` is `.strict()`
           * with no field a credential could sit in — but a log line that
           * spreads a row is how that stops being true, so this one counts.
           */
          actors: actors.principals?.length ?? 0,
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
      // Not a failure and not a success: items this job named that it was not
      // allowed to generate. Reported so a batch of ten that produced two
      // cannot read as a batch of two.
      notGenerable,
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
