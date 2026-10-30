/**
 * Re-measurement, tested with no database, no queue and no network.
 *
 * Every port is an interface this module defines, so the fakes below are small
 * and none of them has a `select` to be blind to. The two properties most of
 * these tests are about are COUNTS — "was a run started", "was the patch put
 * back" — so the fakes count rather than merely returning.
 */

import { describe, expect, it } from 'vitest';
import { HEAL_VERIFY_STATES, verificationRunTag } from '@qaai/agent';
import {
  admitRetriage,
  healClaim,
  HEAL_CLAIMS,
  MAX_REVISIONS,
  needsVerificationStart,
  processVerifyHeal,
  reportFor,
  RETRIAGE_PER_WINDOW,
  RETRIAGE_WINDOW_MINUTES,
  startHealVerification,
  VERIFICATION_REPORT,
  VERIFY_START_GRACE_MINUTES,
  verifyHealJobOptions,
  type RunEnqueuer,
  type RunStarter,
  type VerificationRecorder,
  type VerifyHealStore,
  type VerifyLog,
} from './verify-heal.js';

const NOW = new Date('2026-10-29T12:00:00.000Z');
const LONG_AGO = new Date(NOW.getTime() - 60 * 60_000);

function silentLog(): VerifyLog & { errors: number } {
  const log = {
    errors: 0,
    info() {},
    error() {
      log.errors += 1;
    },
  };
  return log;
}

// ─── 1. Three outcomes, and the column that says "measured" ─────────────────

describe('a verification reports three different things', () => {
  it('names every state the column may hold', () => {
    // The compiler enforces it through `satisfies Record<HealVerifyState, …>`.
    // This is the run-time half, so a fifth member added to the array without a
    // report here cannot reach a surface as `undefined`.
    expect(Object.keys(VERIFICATION_REPORT).sort()).toEqual([...HEAL_VERIFY_STATES].sort());
  });

  it('maps the register three names onto the vocabulary this codebase already has', () => {
    expect(VERIFICATION_REPORT.VERIFIED.reported).toBe('VERIFIED_GREEN');
    expect(VERIFICATION_REPORT.STILL_FAILING.reported).toBe('VERIFIED_STILL_RED');
    expect(VERIFICATION_REPORT.UNVERIFIABLE.reported).toBe('VERIFICATION_FAILED_TO_RUN');
    // Four states, four distinct reports: no two collapse.
    const reported = Object.values(VERIFICATION_REPORT).map((r) => r.reported);
    expect(new Set(reported).size).toBe(reported.length);
  });

  it('counts only the two states where the test was actually executed', () => {
    expect(VERIFICATION_REPORT.VERIFIED.measured).toBe(true);
    expect(VERIFICATION_REPORT.STILL_FAILING.measured).toBe(true);
    expect(VERIFICATION_REPORT.PENDING.measured).toBe(false);
    expect(VERIFICATION_REPORT.UNVERIFIABLE.measured).toBe(false);
  });

  it('never turns "we could not look" into a boolean', () => {
    // THE LIE THIS PINS: a null that became 0, or an UNAVAILABLE that became
    // FAIL. `green` is null for every unmeasured state, in both directions.
    for (const state of HEAL_VERIFY_STATES) {
      const report = VERIFICATION_REPORT[state];
      if (!report.measured) expect(report.green).toBeNull();
      else expect(typeof report.green).toBe('boolean');
    }
  });

  it('says a pass only where a pass was measured', () => {
    const green = HEAL_VERIFY_STATES.filter((s) => VERIFICATION_REPORT[s].green === true);
    expect(green).toEqual(['VERIFIED']);
  });
});

describe('a stored verification state is read defensively', () => {
  it('reads null as "nothing was claimed", not as a failure', () => {
    expect(reportFor(null)).toBeNull();
  });

  it('reports an unrecognised value as unrecognised rather than as unverifiable', () => {
    const read = reportFor('NOT_VERIFIED');
    expect(read).toEqual({ known: false, state: 'NOT_VERIFIED' });
  });

  it('reads every known state', () => {
    for (const state of HEAL_VERIFY_STATES) {
      expect(reportFor(state)).toEqual({ known: true, report: VERIFICATION_REPORT[state] });
    }
  });
});

// ─── 2. Applied is not fixed ────────────────────────────────────────────────

describe('an applied heal is not a fixed test', () => {
  it('distinguishes applied-and-unverified from verified', () => {
    const unverified = healClaim({ state: 'APPLIED', verifyState: null });
    expect(unverified.kind).toBe('APPLIED_NOT_VERIFIED');
    expect(unverified.applied).toBe(true);
    expect(unverified.verified).toBe(false);
    expect(unverified.green).toBeNull();
    expect(unverified.fixed).toBe(false);

    const verified = healClaim({ state: 'APPLIED', verifyState: 'VERIFIED' });
    expect(verified.kind).toBe('APPLIED_VERIFIED_GREEN');
    expect(verified.fixed).toBe(true);
  });

  it('distinguishes still-red from could-not-check, which is the pair that must never collapse', () => {
    const red = healClaim({ state: 'AUTO_APPLIED', verifyState: 'STILL_FAILING' });
    const unknown = healClaim({ state: 'AUTO_APPLIED', verifyState: 'UNVERIFIABLE' });
    expect(red.green).toBe(false);
    expect(unknown.green).toBeNull();
    expect(red.kind).not.toBe(unknown.kind);
    expect(red.fixed).toBe(false);
    expect(unknown.fixed).toBe(false);
  });

  it('claims nothing about a proposal nobody applied', () => {
    for (const state of ['PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED']) {
      const claim = healClaim({ state, verifyState: 'VERIFIED' });
      expect(claim.kind).toBe('NOT_APPLIED');
      expect(claim.applied).toBe(false);
      // Even with VERIFIED stored against it: a verification of a proposal that
      // is not applied is a verification of code that is not in the repository.
      expect(claim.fixed).toBe(false);
    }
  });

  it('sets `fixed` for exactly one kind', () => {
    const kinds = new Set<string>();
    for (const state of ['PROPOSED', 'APPLIED', 'AUTO_APPLIED']) {
      for (const verify of [null, ...HEAL_VERIFY_STATES, 'SOMETHING_NEWER']) {
        const claim = healClaim({ state, verifyState: verify });
        expect(HEAL_CLAIMS).toContain(claim.kind);
        if (claim.fixed) kinds.add(claim.kind);
      }
    }
    expect([...kinds]).toEqual(['APPLIED_VERIFIED_GREEN']);
  });

  it('says so when the stored state is one this build cannot interpret', () => {
    const claim = healClaim({ state: 'APPLIED', verifyState: 'SOMETHING_NEWER' });
    expect(claim.kind).toBe('APPLIED_UNINTERPRETABLE');
    expect(claim.fixed).toBe(false);
    expect(claim.sentence).toContain('SOMETHING_NEWER');
  });
});

// ─── 3. One start ───────────────────────────────────────────────────────────

interface StartFakes {
  store: VerifyHealStore;
  runs: RunStarter & { started: number; lastTriggeredBy: string | null; lastTestId: string | null };
  queue: RunEnqueuer & { enqueued: number };
  recordStarts: Array<{
    verifyState: string;
    verifyRunId: string | null;
    verifiedAt: Date | null;
    verifyNote: string;
  }>;
  abandoned: string[];
}

function startFakes(options: {
  environmentId?: string | null;
  start?: { created: true; runId: string } | { created: false; reason: string | null };
  enqueueThrows?: boolean;
  heal?: Awaited<ReturnType<VerifyHealStore['loadHeal']>>;
}): StartFakes {
  const recordStarts: StartFakes['recordStarts'] = [];
  const abandoned: string[] = [];

  const runs = {
    started: 0,
    lastTriggeredBy: null as string | null,
    lastTestId: null as string | null,
    async start(args: {
      orgId: string;
      projectId: string;
      environmentId: string;
      testId: string;
      triggeredBy: string;
    }) {
      runs.started += 1;
      runs.lastTriggeredBy = args.triggeredBy;
      runs.lastTestId = args.testId;
      return options.start ?? ({ created: true, runId: 'run_1' } as const);
    },
  };

  const queue = {
    enqueued: 0,
    async enqueue() {
      queue.enqueued += 1;
      if (options.enqueueThrows) throw new Error('redis is down');
    },
  };

  const store: VerifyHealStore = {
    async loadHeal() {
      return options.heal ?? null;
    },
    async lastEnvironmentFor() {
      /*
       * `in` and not `??`: an explicit `environmentId: null` is the case under
       * test, and `null ?? 'env_1'` quietly hands it an environment. The first
       * draft of this fake did exactly that and the "test has never run" arm
       * passed by never being reached.
       */
      return {
        environmentId: 'environmentId' in options ? (options.environmentId ?? null) : 'env_1',
      };
    },
    async abandonRun(args) {
      abandoned.push(args.runId);
    },
    async recordStart(args) {
      recordStarts.push({
        verifyState: args.verifyState,
        verifyRunId: args.verifyRunId,
        verifiedAt: args.verifiedAt,
        verifyNote: args.verifyNote,
      });
    },
  };

  return { store, runs, queue, recordStarts, abandoned };
}

const HEAL_ARGS = { orgId: 'org_1', healId: 'heal_1', testId: 'test_1', projectId: 'proj_1' };

describe('starting the run that checks a heal', () => {
  it('re-runs exactly the one test, tagged so the sweep can find the run', async () => {
    const f = startFakes({});
    const out = await startHealVerification(
      { store: f.store, runs: f.runs, queue: f.queue, log: silentLog() },
      HEAL_ARGS,
    );

    expect(out.state).toBe('PENDING');
    expect(out.runId).toBe('run_1');
    expect(f.runs.started).toBe(1);
    expect(f.runs.lastTestId).toBe('test_1');
    expect(f.runs.lastTriggeredBy).toBe(verificationRunTag('heal_1'));
    expect(f.queue.enqueued).toBe(1);
    // PENDING is not an outcome, so it does not stamp a verification time.
    expect(f.recordStarts).toEqual([
      expect.objectContaining({ verifyState: 'PENDING', verifiedAt: null }),
    ]);
  });

  it('says UNVERIFIABLE and starts nothing when the test has never run', async () => {
    const f = startFakes({ environmentId: null });
    const out = await startHealVerification(
      { store: f.store, runs: f.runs, queue: f.queue, log: silentLog() },
      HEAL_ARGS,
    );

    expect(out.state).toBe('UNVERIFIABLE');
    expect(out.runId).toBeNull();
    expect(f.runs.started).toBe(0);
    expect(f.recordStarts[0]!.verifiedAt).toBeInstanceOf(Date);
    expect(out.note).toContain('nobody has checked it');
  });

  it('names the plan limit that bit, rather than reporting a check that did not happen', async () => {
    const f = startFakes({
      start: { created: false, reason: 'This org used 500 of 500 runs this month.' },
    });
    const out = await startHealVerification(
      { store: f.store, runs: f.runs, queue: f.queue, log: silentLog() },
      HEAL_ARGS,
    );

    expect(out.state).toBe('UNVERIFIABLE');
    expect(out.note).toContain('500 of 500');
    expect(f.queue.enqueued).toBe(0);
  });

  it('never leaves a row claiming PENDING on a run with no job', async () => {
    /*
     * A run row with no job would sit PENDING until the sweep's deadline and then
     * report itself unverifiable for the WRONG reason — "the run did not finish"
     * rather than "the run was never queued".
     */
    const f = startFakes({ enqueueThrows: true });
    const log = silentLog();
    const out = await startHealVerification(
      { store: f.store, runs: f.runs, queue: f.queue, log },
      HEAL_ARGS,
    );

    expect(out.state).toBe('UNVERIFIABLE');
    expect(out.runId).toBeNull();
    expect(f.abandoned).toEqual(['run_1']);
    expect(f.recordStarts[0]!.verifyState).toBe('UNVERIFIABLE');
    expect(log.errors).toBe(1);
  });

  it('never returns VERIFIED, on any arm', async () => {
    for (const options of [
      {},
      { environmentId: null },
      { start: { created: false as const, reason: null } },
      { enqueueThrows: true },
    ]) {
      const f = startFakes(options);
      const out = await startHealVerification(
        { store: f.store, runs: f.runs, queue: f.queue, log: silentLog() },
        HEAL_ARGS,
      );
      expect(['PENDING', 'UNVERIFIABLE']).toContain(out.state);
    }
  });
});

// ─── 4. The heal nothing will ever check ────────────────────────────────────

describe('an applied heal with no verification state is a hole, not a resting place', () => {
  const applied = {
    state: 'AUTO_APPLIED',
    verifyState: null,
    decidedAt: LONG_AGO,
  };

  it('finds the row the PENDING-only sweep cannot see', () => {
    expect(needsVerificationStart(applied, NOW)).toEqual({ start: true });
  });

  it('leaves the apply path own start alone inside the grace period', () => {
    const justNow = new Date(NOW.getTime() - (VERIFY_START_GRACE_MINUTES - 1) * 60_000);
    expect(needsVerificationStart({ ...applied, decidedAt: justNow }, NOW)).toEqual({
      start: false,
      refusal: 'WITHIN_GRACE',
    });
  });

  it('refuses with a reason rather than a bare false', () => {
    expect(needsVerificationStart({ ...applied, verifyState: 'PENDING' }, NOW)).toEqual({
      start: false,
      refusal: 'ALREADY_HAS_STATE',
    });
    expect(needsVerificationStart({ ...applied, state: 'PROPOSED' }, NOW)).toEqual({
      start: false,
      refusal: 'NOT_APPLIED',
    });
    expect(needsVerificationStart({ ...applied, decidedAt: null }, NOW)).toEqual({
      start: false,
      refusal: 'NO_APPLY_TIME',
    });
  });

  it('does NOT apply the grace period to the apply path own start', () => {
    /*
     * THE DEFECT: the grace period exists to stop a SWEEP racing the apply
     * path's own start. An `APPLY` job IS that start — it is what replaced the
     * three module-local copies of `startHealVerification` — so applying a
     * grace period to it refuses the only start this heal is ever going to get
     * and leaves `verifyState` NULL until the hole sweep notices minutes later.
     * A verification delayed by exactly the window meant to protect it.
     */
    const justApplied = new Date(NOW.getTime() - 1_000);
    expect(needsVerificationStart({ ...applied, decidedAt: justApplied }, NOW, false)).toEqual({
      start: true,
    });
    // And it still refuses for every reason that is not about timing: a heal
    // nobody applied, and one that already has a state, are not holes.
    expect(needsVerificationStart({ ...applied, state: 'PROPOSED' }, NOW, false)).toEqual({
      start: false,
      refusal: 'NOT_APPLIED',
    });
    expect(
      needsVerificationStart({ ...applied, verifyState: 'UNVERIFIABLE' }, NOW, false),
    ).toEqual({ start: false, refusal: 'ALREADY_HAS_STATE' });
  });

  it('starts a heal with no apply time when the caller IS the apply path', () => {
    // `NO_APPLY_TIME` only exists because the grace period needs a clock to
    // measure. With no grace period to measure there is nothing to refuse, and
    // refusing here would mean a heal whose `decidedAt` write lost a race is
    // never verified at all.
    expect(needsVerificationStart({ ...applied, decidedAt: null }, NOW, false)).toEqual({
      start: true,
    });
  });
});

// ─── 5. Re-triage, bounded ──────────────────────────────────────────────────

const VERDICT = { revision: 1, retriageRequestedAt: null, overriddenTo: null };

describe('a re-triage is bounded, rate-limited and deterministic', () => {
  it('admits a first re-triage', () => {
    const out = admitRetriage(
      { verdict: VERDICT, requestedInWindow: 0, modelAvailable: true },
      NOW,
    );
    expect(out.admit).toBe(true);
    expect(out.refusal).toBeNull();
  });

  it('refuses when a re-triage is already pending', () => {
    const out = admitRetriage(
      {
        verdict: { ...VERDICT, retriageRequestedAt: NOW },
        requestedInWindow: 0,
        modelAvailable: true,
      },
      NOW,
    );
    expect(out.admit).toBe(false);
    expect(out.refusal).toBe('ALREADY_PENDING');
  });

  it('refuses past the revision ceiling and names both numbers', () => {
    const out = admitRetriage(
      {
        verdict: { ...VERDICT, revision: MAX_REVISIONS },
        requestedInWindow: 0,
        modelAvailable: true,
      },
      NOW,
    );
    expect(out.refusal).toBe('REVISION_CEILING');
    expect(out.reason).toContain(String(MAX_REVISIONS));
  });

  it('rate-limits, and DISCLOSES the cap and the window', () => {
    // A budget that bit and was not reported is a cap applied without being
    // disclosed, which is one of the lies this product cannot afford.
    const out = admitRetriage(
      { verdict: VERDICT, requestedInWindow: RETRIAGE_PER_WINDOW, modelAvailable: true },
      NOW,
    );
    expect(out.refusal).toBe('RATE_LIMITED');
    expect(out.reason).toContain(String(RETRIAGE_PER_WINDOW));
    expect(out.reason).toContain(String(RETRIAGE_WINDOW_MINUTES));
    expect(out.reason).toContain('Nothing was spent');
  });

  it('refuses when there is no verdict to supersede', () => {
    expect(admitRetriage({ verdict: null, requestedInWindow: 0, modelAvailable: true }, NOW).refusal).toBe(
      'NO_VERDICT',
    );
    expect(
      admitRetriage(
        { verdict: { ...VERDICT, revision: null }, requestedInWindow: 0, modelAvailable: true },
        NOW,
      ).refusal,
    ).toBe('NO_VERDICT');
  });

  it('carries the human override out, rather than discarding it', () => {
    // `overriddenTo` is documented as "what gates and what trains prompts", and
    // nothing read it into a re-triage prompt. A Verdict member — a closed
    // vocabulary — and never the human's free-text reason.
    const out = admitRetriage(
      {
        verdict: { ...VERDICT, overriddenTo: 'INTENDED_CHANGE' },
        requestedInWindow: 0,
        modelAvailable: true,
      },
      NOW,
    );
    expect(out.carriedOverride).toBe('INTENDED_CHANGE');
  });

  it('still admits with no model, and says what it cannot re-answer', () => {
    // No crash and no silent no-op: the deterministic classification re-runs.
    const out = admitRetriage(
      { verdict: VERDICT, requestedInWindow: 0, modelAvailable: false },
      NOW,
    );
    expect(out.admit).toBe(true);
    expect(out.deterministicOnly).toBe(true);
    expect(out.reason).toContain('deterministic');
  });

  it('decides the same way twice for the same inputs', () => {
    // Deterministic: the clock is a parameter, so the answer does not move.
    const args = { verdict: VERDICT, requestedInWindow: 3, modelAvailable: true };
    expect(admitRetriage(args, NOW)).toEqual(admitRetriage(args, new Date(0)));
  });
});

// ─── 6. The processor ───────────────────────────────────────────────────────

type Recorded = Awaited<ReturnType<VerificationRecorder['record']>>;

function processFakes(
  heal: Awaited<ReturnType<VerifyHealStore['loadHeal']>>,
  recorded: Recorded = { wrote: true, state: 'VERIFIED', reverted: false, revertedToVersion: null },
) {
  const f = startFakes({ heal });
  const recorder: VerificationRecorder & {
    calls: number;
    lastHealState: string | null;
    /** The deadline inputs, so dropping one from the call is visible. */
    lastClock: { decidedAt: Date | null; createdAt: Date; now: Date } | null;
  } = {
    calls: 0,
    lastHealState: null,
    lastClock: null,
    async record(args) {
      recorder.calls += 1;
      recorder.lastHealState = args.healState;
      recorder.lastClock = { decidedAt: args.decidedAt, createdAt: args.createdAt, now: args.now };
      return recorded;
    },
  };
  return { ...f, recorder };
}

const APPLIED_HEAL = {
  id: 'heal_1',
  orgId: 'org_1',
  testId: 'test_1',
  projectId: 'proj_1',
  state: 'AUTO_APPLIED',
  verifyState: 'PENDING' as string | null,
  verifyRunId: 'run_1' as string | null,
  appliedVersion: 4 as number | null,
  decidedAt: LONG_AGO as Date | null,
  /** The deadline's fallback when `decidedAt` is missing. Never null. */
  createdAt: new Date(LONG_AGO.getTime() - 60_000),
};

const JOB = { orgId: 'org_1', healId: 'heal_1', reason: 'SWEEP_FOUND_NO_START' as const };

describe('the processor re-measures one heal', () => {
  it('reports a missing heal rather than failing the job', async () => {
    const f = processFakes(null);
    const out = await processVerifyHeal(
      { store: f.store, runs: f.runs, queue: f.queue, recorder: f.recorder, log: silentLog() },
      JOB,
      NOW,
    );
    expect(out.outcome).toBe('NO_SUCH_HEAL');
    expect(f.recorder.calls).toBe(0);
  });

  it('starts the verification for an applied heal that never got one', async () => {
    const f = processFakes({ ...APPLIED_HEAL, verifyState: null, verifyRunId: null });
    const out = await processVerifyHeal(
      { store: f.store, runs: f.runs, queue: f.queue, recorder: f.recorder, log: silentLog() },
      JOB,
      NOW,
    );
    expect(out.outcome).toBe('STARTED');
    expect(out.verifyState).toBe('PENDING');
    expect(f.runs.started).toBe(1);
    expect(f.recorder.calls).toBe(0);
  });

  it('REVERTS an auto-applied heal that verification proved did not work', async () => {
    /*
     * THE ASYMMETRY IS THE DESIGN. Nobody chose an auto-apply, so a patch that
     * failed its own check must not stay in the customer's code with nobody
     * informed. The revert is COUNTED and REPORTED here — it is a
     * suppression-shaped act, and a suppression nobody can see is how a team
     * learns to ignore the board.
     */
    const f = processFakes(APPLIED_HEAL, {
      wrote: true,
      state: 'STILL_FAILING',
      reverted: true,
      revertedToVersion: 3,
    });
    const out = await processVerifyHeal(
      { store: f.store, runs: f.runs, queue: f.queue, recorder: f.recorder, log: silentLog() },
      JOB,
      NOW,
    );

    expect(out.outcome).toBe('RECORDED');
    expect(out.verifyState).toBe('STILL_FAILING');
    expect(out.reverted).toBe(true);
    // WHICH version. `reverted: true` cannot answer "to what", and that is the
    // first question asked when somebody notices their test changed.
    expect(out.revertedToVersion).toBe(3);
    expect(out.note).toContain('reverted to version 3');
    expect(out.note).toContain('appended');
    expect(f.recorder.lastHealState).toBe('AUTO_APPLIED');
    // Both deadline inputs reached the recorder. The deadline is
    // `decidedAt ?? createdAt`, so a processor that forwarded only one of them
    // would ask the implementation a different question about a heal with no
    // apply time.
    expect(f.recorder.lastClock).toEqual({
      decidedAt: APPLIED_HEAL.decidedAt,
      createdAt: APPLIED_HEAL.createdAt,
      now: NOW,
    });
  });

  it('leaves a heal a person approved in place, and says it is still red', async () => {
    const f = processFakes(
      { ...APPLIED_HEAL, state: 'APPLIED' },
      { wrote: true, state: 'STILL_FAILING', reverted: false, revertedToVersion: null },
    );
    const out = await processVerifyHeal(
      { store: f.store, runs: f.runs, queue: f.queue, recorder: f.recorder, log: silentLog() },
      JOB,
      NOW,
    );
    expect(out.reverted).toBe(false);
    expect(out.note).toBe(VERIFICATION_REPORT.STILL_FAILING.sentence);
    expect(out.note).not.toContain('reverted');
  });

  it('does nothing twice, and says which refusal applied', async () => {
    const justNow = new Date(NOW.getTime() - 60_000);
    const f = processFakes({ ...APPLIED_HEAL, verifyState: null, decidedAt: justNow });
    const out = await processVerifyHeal(
      { store: f.store, runs: f.runs, queue: f.queue, recorder: f.recorder, log: silentLog() },
      JOB,
      NOW,
    );
    expect(out.outcome).toBe('NOTHING_TO_DO');
    expect(out.startRefusal).toBe('WITHIN_GRACE');
    expect(f.runs.started).toBe(0);
  });

  it('never re-records a terminal state, and never calls it a pass', async () => {
    const f = processFakes({ ...APPLIED_HEAL, verifyState: 'UNVERIFIABLE' });
    const out = await processVerifyHeal(
      { store: f.store, runs: f.runs, queue: f.queue, recorder: f.recorder, log: silentLog() },
      JOB,
      NOW,
    );
    expect(out.outcome).toBe('NOTHING_TO_DO');
    expect(out.startRefusal).toBe('ALREADY_HAS_STATE');
    expect(f.recorder.calls).toBe(0);
    expect(out.note).toContain('NOT been shown to pass');
  });

  it('reports a run that has NOT finished as still in flight, not as recorded', async () => {
    /*
     * THE LIE THIS PINS: a thing reported as measured that was not measured.
     * The recorder returns `wrote: false` when the verifying run has no
     * terminal status and is still inside its deadline — nothing was written,
     * the row was already PENDING and stays PENDING. Reporting RECORDED here
     * would say a verification concluded while its run was still executing.
     */
    const f = processFakes(APPLIED_HEAL, {
      wrote: false,
      state: 'PENDING',
      reverted: false,
      revertedToVersion: null,
    });
    const out = await processVerifyHeal(
      { store: f.store, runs: f.runs, queue: f.queue, recorder: f.recorder, log: silentLog() },
      JOB,
      NOW,
    );

    expect(out.outcome).toBe('STILL_IN_FLIGHT');
    expect(out.verifyState).toBe('PENDING');
    expect(out.reverted).toBe(false);
    expect(out.revertedToVersion).toBeNull();
    // The AWAITING sentence, which says out loud that nobody has confirmed it.
    expect(out.note).toBe(VERIFICATION_REPORT.PENDING.sentence);
    expect(out.note).toContain('Nobody has confirmed');
    // And it is NOT one of the two outcomes a reader would act on.
    expect(out.outcome).not.toBe('RECORDED');
    expect(out.outcome).not.toBe('NOTHING_TO_DO');
  });

  it('starts the verification for an APPLY job that arrives inside the grace period', async () => {
    /*
     * THE DEFECT: the apply path now ENQUEUES its verification instead of
     * carrying its own copy of `startHealVerification`, so the job arrives
     * seconds after the apply — inside `VERIFY_START_GRACE_MINUTES`. With the
     * grace period applied unconditionally the only start this heal is ever
     * going to get is refused WITHIN_GRACE, and the row sits NULL until the
     * hole sweep finds it minutes later. A verification delayed by exactly the
     * window meant to protect it.
     */
    const justApplied = new Date(NOW.getTime() - 2_000);
    const f = processFakes({
      ...APPLIED_HEAL,
      verifyState: null,
      verifyRunId: null,
      decidedAt: justApplied,
    });
    const out = await processVerifyHeal(
      { store: f.store, runs: f.runs, queue: f.queue, recorder: f.recorder, log: silentLog() },
      { ...JOB, reason: 'APPLY' },
      NOW,
    );

    expect(out.outcome).toBe('STARTED');
    expect(out.verifyState).toBe('PENDING');
    expect(f.runs.started).toBe(1);
    expect(f.runs.lastTriggeredBy).toBe(verificationRunTag('heal_1'));

    // The SAME heal, the SAME clock, asked for by the SWEEP instead: refused,
    // because that caller really could be racing the apply path's own start.
    const g = processFakes({
      ...APPLIED_HEAL,
      verifyState: null,
      verifyRunId: null,
      decidedAt: justApplied,
    });
    const swept = await processVerifyHeal(
      { store: g.store, runs: g.runs, queue: g.queue, recorder: g.recorder, log: silentLog() },
      { ...JOB, reason: 'SWEEP_FOUND_NO_START' },
      NOW,
    );
    expect(swept.outcome).toBe('NOTHING_TO_DO');
    expect(swept.startRefusal).toBe('WITHIN_GRACE');
    expect(g.runs.started).toBe(0);
  });
});

describe('the job id is a redis key', () => {
  it('removes itself from BOTH the completed and the failed set', () => {
    // A per-entity job id with only `removeOnComplete` keeps its id in the
    // failed set, and the SECOND attempt for that heal is silently dropped for
    // ever — here, a heal nothing ever re-measures.
    expect(verifyHealJobOptions('heal_1')).toEqual({
      jobId: 'verify-heal-heal_1',
      removeOnComplete: true,
      removeOnFail: true,
    });
  });
});
