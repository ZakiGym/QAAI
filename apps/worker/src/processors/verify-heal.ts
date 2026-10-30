/**
 * Re-measuring the thing the loop just changed.
 *
 * ─── WHERE THIS SITS, AND WHAT IT DELIBERATELY DOES NOT DO ──────────────────
 *
 * Verification itself already exists and is not re-implemented here. The rules
 * are `decideVerification` (packages/agent/src/healer.ts), the start is in each
 * apply path, and the WRITE — the state, the audit row and the revert, in one
 * transaction — is `recordVerification` in processors/flake.ts. A second writer
 * of `HealProposal.verifyState` would be two implementations of one decision,
 * which is how `ASSERTION_KEY` and `specAssertions` became two vocabularies for
 * one question. So the writer is INJECTED here ({@link VerificationRecorder})
 * and flake.ts's is the implementation.
 *
 * What this module adds is the four things that were missing:
 *
 *  1. THE REPORT VOCABULARY. The register asked for VERIFIED_GREEN,
 *     VERIFIED_STILL_RED and VERIFICATION_FAILED_TO_RUN as three different
 *     things. They already have names in this codebase — VERIFIED,
 *     STILL_FAILING and UNVERIFIABLE in `HEAL_VERIFY_STATES` — and minting a
 *     second three-member vocabulary for one fact is the drift defect, not the
 *     fix. {@link VERIFICATION_REPORT} is the mapping, and the column it adds is
 *     the one nothing had: `measured`. PENDING and UNVERIFIABLE are NOT
 *     measurements, and `green` is `null` for both rather than `false`, because
 *     a null that became a boolean is a lie this product cannot afford.
 *
 *  2. THE DISTINGUISHER. "An APPLIED-BUT-UNVERIFIED heal is not a fixed test,
 *     and it must be visually and programmatically distinguishable from a
 *     verified one everywhere." {@link healClaim} is the programmatic half, and
 *     it reports ONE FACT PER FIELD — `applied`, `verified` and `green` are
 *     three questions, and `houseStyle.planned` is what happens when two of
 *     them share a column.
 *
 *  3. ONE START, NOT THREE. `startHealVerification` existed three times: here,
 *     a module-local copy in apps/api/src/routes/agent.ts and a near-copy in
 *     processors/triage.ts, whose own doc comment asks for this promotion by
 *     name. {@link startHealVerification} below is the one implementation, over
 *     interfaces narrow enough that every caller can satisfy them and a test
 *     needs no database and no network. The production ports are
 *     `healVerificationPorts` in processors/flake.ts — that file already
 *     imports `prisma`, `startRun` and `enqueueRun`, which is what keeps this
 *     module free of all three. The two deletions are named in this round's
 *     handover, with the exact replacement for each.
 *
 *  4. THE HEAL NOTHING WILL EVER CHECK. `verifyAppliedHeals` in flake.ts scans
 *     `where: { verifyState: 'PENDING' }`. A heal whose apply committed and
 *     whose verification start then failed — the process died between the
 *     transaction and the update, which both apply paths document as leaving the
 *     column NULL — is APPLIED with `verifyState: null` FOR EVER, and the sweep
 *     cannot see it. That is an applied patch in a customer's test that nothing
 *     will re-measure. {@link needsVerificationStart} is the predicate that
 *     finds those, and {@link processVerifyHeal} is what starts one.
 *
 * ─── AND THE OTHER RE-MEASUREMENT: RE-TRIAGE ────────────────────────────────
 *
 * A heal that verifies STILL_RED means the verdict behind it was wrong, and the
 * answer to a wrong verdict is a re-triage. The endpoint and the supersede
 * machinery exist (`POST /triage/verdicts/:id/retriage`, `supersedeVerdict`),
 * bounded per request by `MAX_RETRIAGE_FANOUT`. What has no bound is the RATE:
 * nothing stops a hundred requests, or an automatic path like this one, from
 * spending a strong model call per failure per minute. {@link admitRetriage} is
 * that bound, and it is deterministic — no model, no clock of its own, a reason
 * for every refusal.
 */

import { HEAL_VERIFY_STATES, verificationRunTag } from '@qaai/agent';
import type { HealVerifyState } from '@qaai/agent';

/*
 * THE QUEUE NAME IS NOT DECLARED HERE, DELIBERATELY — AND IT NOW EXISTS.
 *
 * `VERIFY_HEAL_QUEUE`, its producer (`enqueueVerifyHeal`) and the Queue handle
 * live in ../queues.ts beside `ANALYZE_SOURCE_QUEUE` and `PREFLIGHT_QUEUE`, and
 * the consumer is registered in ../index.ts. A queue constant in a processor is
 * a name with no producer, and `scripts/check-wiring.ts` reports exactly that:
 * a declared queue nothing publishes to and nothing consumes.
 *
 * What changed since this comment was first written is that the registration
 * landed. Three producers reach this module now — the apply paths, the hole
 * sweep in processors/flake.ts, and an operator — so nothing here is reached
 * only by its own test any more.
 */

/*
 * THE PAYLOAD AND THE JOB OPTIONS MOVED TO packages/shared/src/jobs.ts, and
 * they are RE-EXPORTED here so this module's importers and its tests keep one
 * name for them.
 *
 * They were declared in this file, which apps/api cannot import, so the API's
 * apply path could not produce to this queue and kept a third copy of the
 * verification start instead. The same reasoning
 * `analyzeSourceJobOptions` records: two producers of one queue that cannot
 * share a definition each end up with half of one bug — here, a missing
 * `removeOnFail` on whichever side forgot it.
 */
import type { VerifyHealJob } from '@qaai/shared';
export type { VerifyHealJob };
export { verifyHealJobOptions } from '@qaai/shared';

// ─────────────────────────────────────────────────────────────────────────────
// 1. The report: three outcomes, and the one column that says "measured".
// ─────────────────────────────────────────────────────────────────────────────

/** What a surface reports, per `HealVerifyState`. */
export interface VerificationReport {
  /** The register's own name for this outcome. */
  readonly reported:
    | 'AWAITING'
    | 'VERIFIED_GREEN'
    | 'VERIFIED_STILL_RED'
    | 'VERIFICATION_FAILED_TO_RUN';
  /**
   * Whether the test was actually executed after the patch was written.
   *
   * FALSE for PENDING and UNVERIFIABLE. This is the column nothing had, and its
   * absence is how "we did not check" came to be renderable beside a fix: a
   * caller holding only the state has to know which two of four members are
   * measurements, and a caller that guesses wrong reports an unchecked patch as
   * a verified one.
   */
  readonly measured: boolean;
  /**
   * The measurement, or NULL when there was none.
   *
   * Never `false` for "we could not look". UNAVAILABLE is not FAIL, and a null
   * that became a boolean here would be a red test reported as handled or a
   * handled one reported as red, depending on which way the collapse went.
   */
  readonly green: boolean | null;
  /** Whether this state still owes an answer, so a sweep knows to come back. */
  readonly awaiting: boolean;
  /** The sentence a reviewer reads. Never implies a check that did not happen. */
  readonly sentence: string;
}

/**
 * The mapping, as a compile-enforced presence record.
 *
 * `satisfies Record<HealVerifyState, …>` means a fifth member of
 * `HEAL_VERIFY_STATES` breaks this line. The alternative — a lookup with a
 * fallback — is how a new state comes to render as whatever the fallback says,
 * and the fallback that would be chosen for a verification state is "not
 * verified", which is a different claim from "this build cannot interpret this".
 */
export const VERIFICATION_REPORT = {
  PENDING: {
    reported: 'AWAITING',
    measured: false,
    green: null,
    awaiting: true,
    sentence:
      'Applied, and the run that checks it has not finished. Nobody has confirmed the test passes.',
  },
  VERIFIED: {
    reported: 'VERIFIED_GREEN',
    measured: true,
    green: true,
    awaiting: false,
    sentence: 'Applied, re-run, and the test passed. The fix is real.',
  },
  STILL_FAILING: {
    reported: 'VERIFIED_STILL_RED',
    measured: true,
    green: false,
    awaiting: false,
    sentence: 'Applied, re-run, and the test still fails. The fix is not.',
  },
  UNVERIFIABLE: {
    reported: 'VERIFICATION_FAILED_TO_RUN',
    measured: false,
    green: null,
    awaiting: false,
    sentence:
      'Applied, and nobody could check it — there was no environment, no run, or the run never executed the test. The test has NOT been shown to pass.',
  },
} satisfies Record<HealVerifyState, VerificationReport>;

/**
 * The report for a stored value, which is TEXT and may have been written by a
 * newer deployment.
 *
 * `null` in, `null` out: nothing was applied, so nothing was claimed, and an
 * absent verification must not render as a failed one. An UNRECOGNISED value
 * gets its own answer rather than falling through to UNVERIFIABLE — "this build
 * cannot interpret this" and "we could not look" are different facts, and only
 * the second is about the heal.
 */
export function reportFor(
  state: string | null,
): { known: true; report: VerificationReport } | { known: false; state: string } | null {
  if (state === null) return null;
  if ((HEAL_VERIFY_STATES as readonly string[]).includes(state)) {
    return { known: true, report: VERIFICATION_REPORT[state as HealVerifyState] };
  }
  return { known: false, state };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Applied is not fixed.
// ─────────────────────────────────────────────────────────────────────────────

export const HEAL_CLAIMS = [
  /** Nobody applied this proposal. Nothing is claimed about the test. */
  'NOT_APPLIED',
  /** The patch is in the customer's test and NOTHING has re-run it. */
  'APPLIED_NOT_VERIFIED',
  /** Applied, re-run, green. The only claim that means "fixed". */
  'APPLIED_VERIFIED_GREEN',
  /** Applied, re-run, still red. */
  'APPLIED_STILL_RED',
  /** Applied, and nobody could look. Distinct from both of the two above. */
  'APPLIED_UNVERIFIABLE',
  /** Applied, and the state stored is one this build does not recognise. */
  'APPLIED_UNINTERPRETABLE',
] as const;
export type HealClaimKind = (typeof HEAL_CLAIMS)[number];

export interface HealClaim {
  readonly kind: HealClaimKind;
  /** The patch is in the customer's code. */
  readonly applied: boolean;
  /** A run executed the test AFTER the patch was written. */
  readonly verified: boolean;
  /** The measurement, or null when there was none. Never false for "unknown". */
  readonly green: boolean | null;
  /**
   * TRUE for exactly one kind. The field a surface may colour green, and the
   * reason it is separate from `applied`: every list in this product rendered
   * an applied heal and a fixed test as the same pixel.
   */
  readonly fixed: boolean;
  readonly sentence: string;
}

/**
 * What this heal actually claims about the test.
 *
 * ONE FACT PER FIELD, and that is the lesson the last round paid for:
 * `houseStyle.planned` meant "a plan was computed" where it was written and
 * "the plan was used" where it was read, so a flag on a row and the disclosure
 * beside it were computed from different booleans. `applied`, `verified` and
 * `green` are three questions with three answers, and `fixed` is the one
 * conjunction a caller is allowed to colour.
 */
export function healClaim(heal: {
  state: string;
  verifyState: string | null;
}): HealClaim {
  const applied = heal.state === 'APPLIED' || heal.state === 'AUTO_APPLIED';
  if (!applied) {
    return {
      kind: 'NOT_APPLIED',
      applied: false,
      verified: false,
      green: null,
      fixed: false,
      sentence: 'Not applied, so nothing is claimed about this test.',
    };
  }

  const read = reportFor(heal.verifyState);
  if (read === null) {
    return {
      kind: 'APPLIED_NOT_VERIFIED',
      applied: true,
      verified: false,
      green: null,
      fixed: false,
      sentence:
        'Applied, and nothing has re-run this test. An applied heal is not a fixed test.',
    };
  }
  if (!read.known) {
    return {
      kind: 'APPLIED_UNINTERPRETABLE',
      applied: true,
      verified: false,
      green: null,
      fixed: false,
      sentence: `Applied, and the verification state stored against it (${read.state}) is one this build does not recognise.`,
    };
  }

  const { report } = read;
  const kind: HealClaimKind =
    report.reported === 'VERIFIED_GREEN'
      ? 'APPLIED_VERIFIED_GREEN'
      : report.reported === 'VERIFIED_STILL_RED'
        ? 'APPLIED_STILL_RED'
        : report.reported === 'AWAITING'
          ? 'APPLIED_NOT_VERIFIED'
          : 'APPLIED_UNVERIFIABLE';

  return {
    kind,
    applied: true,
    verified: report.measured,
    green: report.green,
    fixed: report.measured && report.green === true,
    sentence: report.sentence,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. One start, over injected ports.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the start needs from the database, as NARROW METHODS.
 *
 * Narrow methods and not a Prisma client, for the reason that cost this build
 * two slices: a fake that ignores `select` makes deleting a field from a query
 * undetectable. There is no `select` here for a fake to be blind to — the
 * projection is the return type, and dropping a field from it is a compile error
 * at every reader.
 */
export interface VerificationStore {
  /** The environment the test last ran in — the one a re-run must reproduce. */
  lastEnvironmentFor(args: {
    orgId: string;
    testId: string;
  }): Promise<{ environmentId: string | null } | null>;
  /** Mark a run dead when its job could not be queued. Best-effort by design. */
  abandonRun(args: { runId: string; reason: string }): Promise<void>;
  /** Write the start's outcome onto the proposal. */
  recordStart(args: {
    healId: string;
    verifyRunId: string | null;
    verifyState: 'PENDING' | 'UNVERIFIABLE';
    verifyNote: string;
    /** Only an OUTCOME stamps this; PENDING is not an outcome. */
    verifiedAt: Date | null;
  }): Promise<void>;
}

/**
 * The run toll, injected.
 *
 * It is `startRun` from apps/api/src/lib/start-run.ts in production — a
 * verification run is a Run, so it goes through the one gate that counts them
 * rather than inserting a row behind the plan's back. The shape is narrowed to
 * what this path needs so the worker and the API can both pass theirs and a test
 * can pass neither.
 */
export interface RunStarter {
  start(args: {
    orgId: string;
    projectId: string;
    environmentId: string;
    testId: string;
    /** `verificationRunTag(healId)`, which is how the sweep finds the run again. */
    triggeredBy: string;
  }): Promise<
    | { created: true; runId: string }
    | { created: false; reason: string | null }
  >;
}

export interface RunEnqueuer {
  enqueue(args: { orgId: string; runId: string }): Promise<void>;
}

/** Just enough logger to be satisfied by pino and by a two-line fake. */
export interface VerifyLog {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface StartVerificationOutcome {
  readonly runId: string | null;
  readonly state: 'PENDING' | 'UNVERIFIABLE';
  readonly note: string;
}

/**
 * Start the run that checks an applied heal, and say honestly when none could be
 * started.
 *
 * EVERY ARM THAT CANNOT RUN THE TEST RETURNS UNVERIFIABLE, never PENDING: the
 * sweep chases PENDING rows, so a row nothing is going to check must not claim
 * to be waiting. And never VERIFIED — "we could not look" and "it works" are
 * the two facts this whole path exists to keep apart.
 *
 * It WRITES the outcome itself, through {@link VerificationStore.recordStart},
 * rather than returning it for the caller to persist. The two existing copies
 * returned it and left each caller to write the same four columns, which is how
 * `verifiedAt` came to be stamped on one path and not the other; one writer, one
 * answer.
 */
export async function startHealVerification(
  deps: {
    store: VerificationStore;
    runs: RunStarter;
    queue: RunEnqueuer;
    log: VerifyLog;
  },
  args: { orgId: string; healId: string; testId: string; projectId: string },
): Promise<StartVerificationOutcome> {
  const settle = async (outcome: StartVerificationOutcome): Promise<StartVerificationOutcome> => {
    await deps.store.recordStart({
      healId: args.healId,
      verifyRunId: outcome.runId,
      verifyState: outcome.state,
      verifyNote: outcome.note,
      verifiedAt: outcome.state === 'UNVERIFIABLE' ? new Date() : null,
    });
    return outcome;
  };

  const last = await deps.store.lastEnvironmentFor({ orgId: args.orgId, testId: args.testId });
  const environmentId = last?.environmentId ?? null;
  if (!environmentId) {
    return await settle({
      runId: null,
      state: 'UNVERIFIABLE',
      note: 'The heal was applied and nobody has checked it: this test has never run, so there is no environment to re-run it in. Run it yourself to find out whether the fix works.',
    });
  }

  const started = await deps.runs.start({
    orgId: args.orgId,
    projectId: args.projectId,
    environmentId,
    testId: args.testId,
    /*
     * ONE test, and only one. Re-running five thousand tests to verify one heal
     * is why this has to be targeted — and the tag is what lets the sweep find
     * this run again without a column pointing at it.
     */
    triggeredBy: verificationRunTag(args.healId),
  });

  if (!started.created) {
    return await settle({
      runId: null,
      state: 'UNVERIFIABLE',
      // The plan limit that BIT, named. A cap applied without being disclosed is
      // the lie; `reason` is the toll's own sentence about the org's own plan.
      note: `The heal was applied and nobody has checked it: the verifying run could not be started. ${started.reason ?? 'This org is at its monthly run limit.'}`,
    });
  }

  try {
    await deps.queue.enqueue({ orgId: args.orgId, runId: started.runId });
  } catch (err) {
    /*
     * A run row with no job would sit PENDING until the sweep's deadline and
     * then report itself unverifiable for the WRONG reason. Mark it dead now and
     * say the true one.
     */
    await deps.store
      .abandonRun({
        runId: started.runId,
        reason: 'The heal verification run could not be queued.',
      })
      .catch(() => {});
    deps.log.error(
      { healId: args.healId, runId: started.runId, err },
      'could not queue a heal verification run',
    );
    return await settle({
      runId: null,
      state: 'UNVERIFIABLE',
      note: 'The heal was applied and nobody has checked it: the verifying run could not be queued. Run the test yourself to find out whether the fix works.',
    });
  }

  return await settle({
    runId: started.runId,
    state: 'PENDING',
    note: `Applied, and now being checked: run ${started.runId} re-runs this test on its own. Until it lands, nobody has confirmed the fix works.`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The heal nothing will ever check.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long after an apply a NULL `verifyState` stops being a race and becomes a
 * hole.
 *
 * The apply path writes the code in a transaction and starts the verification
 * after it, outside — so for a few seconds an applied heal legitimately has no
 * verification state, and a predicate with no grace period would start a second
 * run for every heal the moment it was applied. Five minutes is far longer than
 * the gap and far shorter than the sweep's 90-minute deadline, so a hole is
 * found on the next tick rather than at the end of the day.
 */
export const VERIFY_START_GRACE_MINUTES = 5;

export const START_REFUSALS = [
  /** Nobody applied it, so there is nothing to verify. */
  'NOT_APPLIED',
  /** A verification state is already recorded. */
  'ALREADY_HAS_STATE',
  /** Applied too recently — the apply path's own start may still be in flight. */
  'WITHIN_GRACE',
  /** The row has no apply timestamp, so the grace period cannot be measured. */
  'NO_APPLY_TIME',
] as const;
export type StartRefusal = (typeof START_REFUSALS)[number];

/**
 * Does this heal need a verification STARTED?
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * `verifyAppliedHeals` scans `where: { verifyState: 'PENDING' }`. Both apply
 * paths document that a crash between the code transaction and the start leaves
 * the column NULL — honest about what happened, and it means the heal is APPLIED
 * in the customer's test with NOTHING that will ever re-measure it, invisible to
 * the one sweep that looks. This predicate is what makes those rows findable.
 *
 * It returns a REASON and not a boolean, so a caller can report "14 applied
 * heals, 2 still inside the grace period, 1 with no apply time" rather than a
 * count with no explanation.
 */
export function needsVerificationStart(
  heal: { state: string; verifyState: string | null; decidedAt: Date | null },
  now: Date,
  /**
   * FALSE when the caller IS the apply path's own start, so there is nothing to
   * race.
   *
   * ── THE DEFECT THIS PARAMETER EXISTS TO FIX ──────────────────────────────
   *
   * The grace period exists to stop a SWEEP starting a second verification
   * while the apply path's own start is still in flight. An `APPLY` job IS
   * that start — it is enqueued by the apply path, after the code transaction,
   * instead of the three module-local copies this module replaced — so a grace
   * period applied to it refuses the only start the heal is ever going to get
   * and leaves the row NULL until the hole sweep notices five minutes later.
   * That was a verification delayed by exactly the window meant to protect it.
   *
   * Defaults to TRUE: a caller that does not say which it is gets the cautious
   * answer, because starting a duplicate run is a cost and refusing one is a
   * delay the hole sweep recovers from.
   */
  graceApplies = true,
): { start: true } | { start: false; refusal: StartRefusal } {
  if (heal.state !== 'APPLIED' && heal.state !== 'AUTO_APPLIED') {
    return { start: false, refusal: 'NOT_APPLIED' };
  }
  if (heal.verifyState !== null) return { start: false, refusal: 'ALREADY_HAS_STATE' };
  if (!graceApplies) return { start: true };
  if (heal.decidedAt === null) return { start: false, refusal: 'NO_APPLY_TIME' };
  const age = now.getTime() - heal.decidedAt.getTime();
  if (age < VERIFY_START_GRACE_MINUTES * 60_000) {
    return { start: false, refusal: 'WITHIN_GRACE' };
  }
  return { start: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Re-triage, bounded.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many re-triages one project may ask for in {@link RETRIAGE_WINDOW_MINUTES}.
 *
 * A re-triage spends a strong-model call on demand. `MAX_RETRIAGE_FANOUT` bounds
 * ONE request at 200 members; nothing bounds the number of requests, so an
 * automatic path — a verification that came back STILL_RED is one — can spend a
 * call per failure per tick for ever. This is the rate bound, per project rather
 * than per org, because one noisy project must not consume another's budget.
 */
export const RETRIAGE_PER_WINDOW = 20;
export const RETRIAGE_WINDOW_MINUTES = 60;

export const RETRIAGE_REFUSALS = [
  /** A re-triage is already pending on this verdict. */
  'ALREADY_PENDING',
  /** {@link RETRIAGE_PER_WINDOW} was reached. Reported with the count and the window. */
  'RATE_LIMITED',
  /** The verdict has already been re-triaged {@link MAX_REVISIONS} times. */
  'REVISION_CEILING',
  /** There is no verdict to supersede. */
  'NO_VERDICT',
] as const;
export type RetriageRefusal = (typeof RETRIAGE_REFUSALS)[number];

/**
 * How many times one verdict may be re-answered.
 *
 * A verdict on revision six is not a verdict, it is a disagreement with the
 * model that re-triage cannot settle — and every revision costs a strong-model
 * call and leaves a `TriageVerdictRevision` row. The ceiling is a spending limit
 * and a signal: past it, the answer is a human's.
 */
export const MAX_REVISIONS = 5;

export interface RetriageAdmission {
  readonly admit: boolean;
  readonly refusal: RetriageRefusal | null;
  /**
   * The sentence to show. On a refusal it names the CAP AND THE REASON, because
   * a budget that bit and was not reported is a cap applied without being
   * disclosed.
   */
  readonly reason: string;
  /** What the deterministic pass can re-answer with no model available. */
  readonly deterministicOnly: boolean;
  /** Carried into the new prompt. See below. */
  readonly carriedOverride: string | null;
}

/**
 * May this re-triage happen?
 *
 * DETERMINISTIC: no model, no clock of its own, and a reason for every refusal.
 * `now` is a parameter for the same argument `knownIssueExpiryWithin` makes —
 * a function that read the clock could not be asked what it would have decided a
 * minute ago, and a test could not pin either answer.
 *
 * ── THE OVERRIDE IS CARRIED, NOT DISCARDED ──────────────────────────────────
 *
 * `TriageVerdict.overriddenTo` is documented as "what gates and what trains
 * prompts", and nothing reads it into a re-triage prompt. A re-triage that threw
 * the human's correction away in order to produce a fresh guess is a product
 * asking the same question twice and ignoring the answer it was given. So the
 * override rides out on {@link RetriageAdmission.carriedOverride} and the caller
 * puts it in the prompt — a Verdict member, which is a closed vocabulary, and
 * NEVER the human's free-text reason, which is customer-typed text and belongs
 * behind a fence rather than in a prompt's instruction half.
 *
 * ── WITH NO MODEL AVAILABLE ─────────────────────────────────────────────────
 *
 * `deterministicOnly` is true, and it is an ADMISSION rather than a refusal: the
 * deterministic classification still re-runs and still supersedes, and the new
 * verdict says what it could not re-answer. Never a crash, never a silent no-op.
 */
export function admitRetriage(
  args: {
    verdict: {
      /** Null when nothing has been answered yet. */
      revision: number | null;
      retriageRequestedAt: Date | null;
      overriddenTo: string | null;
    } | null;
    /** Re-triages already requested for this project inside the window. */
    requestedInWindow: number;
    /** False when no strong model is reachable. */
    modelAvailable: boolean;
  },
  _now: Date,
): RetriageAdmission {
  const carriedOverride = args.verdict?.overriddenTo ?? null;
  const deterministicOnly = !args.modelAvailable;

  if (!args.verdict || args.verdict.revision === null) {
    return {
      admit: false,
      refusal: 'NO_VERDICT',
      reason: 'There is no verdict on this failure to supersede, so a re-triage has nothing to replace.',
      deterministicOnly,
      carriedOverride,
    };
  }
  if (args.verdict.retriageRequestedAt !== null) {
    return {
      admit: false,
      refusal: 'ALREADY_PENDING',
      reason:
        'A re-triage is already pending for this verdict. It is honoured the next time the worker picks it up.',
      deterministicOnly,
      carriedOverride,
    };
  }
  if (args.verdict.revision >= MAX_REVISIONS) {
    return {
      admit: false,
      refusal: 'REVISION_CEILING',
      reason: `This verdict has been re-answered ${args.verdict.revision} time(s), which is the ceiling of ${MAX_REVISIONS}. Past that the disagreement is not one a re-triage settles — decide it by hand.`,
      deterministicOnly,
      carriedOverride,
    };
  }
  if (args.requestedInWindow >= RETRIAGE_PER_WINDOW) {
    return {
      admit: false,
      refusal: 'RATE_LIMITED',
      reason: `This project has already asked for ${args.requestedInWindow} re-triage(s) in the last ${RETRIAGE_WINDOW_MINUTES} minutes, which is the limit of ${RETRIAGE_PER_WINDOW}. Nothing was spent; try again after the window.`,
      deterministicOnly,
      carriedOverride,
    };
  }

  return {
    admit: true,
    refusal: null,
    reason: deterministicOnly
      ? 'Admitted. No strong model is reachable, so the deterministic classification re-runs and the new verdict will say what it could not re-answer.'
      : 'Admitted.',
    deterministicOnly,
    carriedOverride,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. The processor.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The WRITE, injected.
 *
 * `recordVerification` in processors/flake.ts is the implementation: it writes
 * the state, the audit row and — for an auto-applied heal that verification
 * proved did not work — the REVERT, all in one transaction. A second copy here
 * would be a second answer to "what does a failed verification do to the
 * customer's code", and the two would drift the day somebody adds a rule to one.
 */
export interface VerificationRecorder {
  record(args: {
    healId: string;
    orgId: string;
    testId: string;
    /** The proposal's own state, which is what decides whether a revert happens. */
    healState: string;
    verifyRunId: string | null;
    appliedVersion: number | null;
    /**
     * Both timestamps, because the DEADLINE is `decidedAt ?? createdAt` and the
     * implementation must compute it from the same two fields the sweep does.
     * A recorder handed only one of them would answer a different question
     * about a heal whose apply time is missing.
     */
    decidedAt: Date | null;
    createdAt: Date;
    now: Date;
  }): Promise<{
    /**
     * FALSE when NOTHING WAS WRITTEN.
     *
     * The verifying run has not reached a terminal status and is still inside
     * its deadline, so there is no outcome yet. It is NOT an UNVERIFIABLE and
     * NOT a PENDING that was just recorded — the row was already PENDING and
     * stays that way. Without this field a caller logs a verification as
     * re-measured when nothing was measured, which is the first lie on the
     * list this product cannot afford.
     */
    wrote: boolean;
    state: HealVerifyState;
    reverted: boolean;
    /**
     * The version whose code was put back. NULL and never 0 when nothing was
     * restored: version 0 does not exist, and a zero would name a version to a
     * reader with confidence.
     */
    revertedToVersion: number | null;
  }>;
}

export interface VerifyHealStore extends VerificationStore {
  /** The proposal, in the projection this processor needs and no more. */
  loadHeal(args: { orgId: string; healId: string }): Promise<{
    id: string;
    orgId: string;
    testId: string;
    projectId: string;
    state: string;
    verifyState: string | null;
    verifyRunId: string | null;
    appliedVersion: number | null;
    decidedAt: Date | null;
    /** The fallback the verification deadline is measured from. Never null. */
    createdAt: Date;
  } | null>;
}

export const VERIFY_JOB_OUTCOMES = [
  /** A verification run was started for a heal that had none. */
  'STARTED',
  /** A terminal state was recorded. */
  'RECORDED',
  /**
   * The verifying run was read and HAS NOT FINISHED, so nothing was written.
   *
   * Its own member rather than folding into RECORDED or NOTHING_TO_DO. RECORDED
   * would report a measurement that did not happen; NOTHING_TO_DO would read as
   * "this heal needs nothing", when in fact it is still owed an answer and the
   * next tick will come back for it.
   */
  'STILL_IN_FLIGHT',
  /** Nothing to do, and {@link StartRefusal} says why. */
  'NOTHING_TO_DO',
  /** The heal is gone. Not an error: a project can be deleted mid-flight. */
  'NO_SUCH_HEAL',
] as const;
export type VerifyJobOutcome = (typeof VERIFY_JOB_OUTCOMES)[number];

export interface VerifyHealResult {
  readonly outcome: VerifyJobOutcome;
  readonly startRefusal: StartRefusal | null;
  readonly verifyState: HealVerifyState | null;
  /**
   * TRUE when an auto-applied heal that verification proved did not work was put
   * back.
   *
   * A SUPPRESSION-SHAPED ACT — it makes a red thing stop being a red thing in the
   * customer's code — so it is counted and reported here, never silent. It is
   * reversible by construction, because the revert is appended as a new
   * `TestVersion` rather than deleting the heal's.
   */
  readonly reverted: boolean;
  /**
   * WHICH version was put back. Null when nothing was.
   *
   * `reverted: true` cannot answer "to what", which is the first question
   * asked when somebody notices their test changed.
   */
  readonly revertedToVersion: number | null;
  readonly note: string;
}

/**
 * Re-measure one heal.
 *
 * Two jobs in one, chosen by the row rather than by the payload: a heal with no
 * verification state gets one STARTED, and a heal with a run gets its outcome
 * RECORDED. The payload cannot choose, deliberately — a job that said "record"
 * about a heal that never had a run would write a terminal state over a hole.
 */
export async function processVerifyHeal(
  deps: {
    store: VerifyHealStore;
    runs: RunStarter;
    queue: RunEnqueuer;
    recorder: VerificationRecorder;
    log: VerifyLog;
  },
  job: VerifyHealJob,
  now: Date = new Date(),
): Promise<VerifyHealResult> {
  const heal = await deps.store.loadHeal({ orgId: job.orgId, healId: job.healId });
  if (!heal) {
    return {
      outcome: 'NO_SUCH_HEAL',
      startRefusal: null,
      verifyState: null,
      reverted: false,
      revertedToVersion: null,
      note: 'That heal proposal no longer exists, so there was nothing to re-measure.',
    };
  }

  /*
   * An `APPLY` job IS the apply path's own start, so there is nothing for the
   * grace period to protect against — see `needsVerificationStart`. Every other
   * reason is a second opinion about a heal the apply path may still be working
   * on, and those wait.
   */
  const need = needsVerificationStart(heal, now, job.reason !== 'APPLY');
  if (need.start) {
    const started = await startHealVerification(
      { store: deps.store, runs: deps.runs, queue: deps.queue, log: deps.log },
      {
        orgId: heal.orgId,
        healId: heal.id,
        testId: heal.testId,
        projectId: heal.projectId,
      },
    );
    deps.log.info(
      { healId: heal.id, testId: heal.testId, verifyState: started.state, reason: job.reason },
      'started a verification for an applied heal that had none',
    );
    return {
      outcome: 'STARTED',
      startRefusal: null,
      // UNVERIFIABLE is a terminal state the start itself can reach, and saying
      // so here is what keeps "started" from reading as "being checked".
      verifyState: started.state === 'PENDING' ? 'PENDING' : 'UNVERIFIABLE',
      reverted: false,
      revertedToVersion: null,
      note: started.note,
    };
  }

  /*
   * ALREADY_HAS_STATE is the only refusal that still has work behind it: the
   * state may be PENDING, and a PENDING heal is one whose run may have landed.
   */
  if (need.refusal !== 'ALREADY_HAS_STATE' || heal.verifyState !== 'PENDING') {
    const read = reportFor(heal.verifyState);
    return {
      outcome: 'NOTHING_TO_DO',
      startRefusal: need.refusal,
      verifyState: read?.known === true ? (heal.verifyState as HealVerifyState) : null,
      reverted: false,
      revertedToVersion: null,
      note:
        read === null
          ? 'Nothing is claimed about this heal, and it is not in a state that needs re-measuring.'
          : read.known
            ? read.report.sentence
            : `The verification state stored against this heal (${read.state}) is one this build does not recognise.`,
    };
  }

  const recorded = await deps.recorder.record({
    healId: heal.id,
    orgId: heal.orgId,
    testId: heal.testId,
    healState: heal.state,
    verifyRunId: heal.verifyRunId,
    appliedVersion: heal.appliedVersion,
    decidedAt: heal.decidedAt,
    createdAt: heal.createdAt,
    now,
  });

  const report = VERIFICATION_REPORT[recorded.state];
  deps.log.info(
    {
      healId: heal.id,
      testId: heal.testId,
      /*
       * `wrote` FIRST, because every field after it is meaningless without it:
       * a reader who saw `verifyState: 'PENDING'` with no `wrote: false` beside
       * it would read a row that was left alone as a row that was just written.
       */
      wrote: recorded.wrote,
      verifyState: recorded.state,
      reported: report.reported,
      measured: report.measured,
      reverted: recorded.reverted,
      revertedToVersion: recorded.revertedToVersion,
    },
    recorded.wrote ? 'heal verification re-measured' : 'heal verification is still in flight',
  );

  /*
   * NOTHING WAS WRITTEN. The verifying run has not finished and is inside its
   * deadline, so this job did not re-measure anything — and saying RECORDED
   * here would be a thing reported as measured that was not measured.
   */
  if (!recorded.wrote) {
    return {
      outcome: 'STILL_IN_FLIGHT',
      startRefusal: null,
      verifyState: recorded.state,
      reverted: false,
      revertedToVersion: null,
      note: report.sentence,
    };
  }

  return {
    outcome: 'RECORDED',
    startRefusal: null,
    verifyState: recorded.state,
    reverted: recorded.reverted,
    revertedToVersion: recorded.revertedToVersion,
    note: recorded.reverted
      ? `${report.sentence} It was applied with nobody reviewing it, so the patch was reverted to version ${recorded.revertedToVersion ?? 'unknown'} — the previous version was appended, not restored in place, so the history of what QAAI wrote to this test is intact.`
      : report.sentence,
  };
}
