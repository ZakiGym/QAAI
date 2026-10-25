/**
 * Healer (§3.4) — proposes the exact fix when Triage says INTENDED_CHANGE, and
 * owns the LIFECYCLE of every proposal: which one is open, whether the fix
 * actually worked, and what happens when it did not.
 *
 * The Healer only ever proposes. Applying is a human click, except for the one
 * narrow case the spec allows an org to opt into: a selector-only change with
 * high confidence. Anything that touches an assertion stays human-approved no
 * matter what the org setting says, because changing an assertion is how a
 * self-healing test suite quietly stops testing anything.
 *
 * ── The three lifecycle defects this file now answers ───────────────────────
 *
 * 1. APPLIED WAS A CLAIM NOBODY CHECKED. Both apply paths wrote the patch, wrote
 *    a TestVersion, flipped the state to APPLIED, and never ran the test again.
 *    A heal that applies cleanly, parses, keeps every assertion and fixes
 *    NOTHING was recorded as applied — and a human reading the queue saw a
 *    handled problem where there was a red test. That is worse than no healing:
 *    an unhealed failure at least stays on the board. `decideVerification`
 *    below is the verdict, and `HEAL_VERIFY_RUN_PREFIX` tags the run that
 *    produces it.
 *
 * 2. THE IDEMPOTENCE GUARD WAS PER TEST RESULT. One permanently broken test
 *    minted a fresh strong-model proposal every single run. `shouldProposeHeal`
 *    moves the guard to the TEST, and uses the applier as its staleness oracle
 *    — an open proposal whose diff STILL APPLIES is still a valid fix, and
 *    paying for a second one would buy a near-duplicate row.
 *
 * 3. NOTHING SUPERSEDED ANYTHING. `planSupersede` keeps the review queue at one
 *    open proposal per test per kind, without rewriting the history of what was
 *    proposed.
 */

/*
 * `HEAL_VERIFY_RUN_PREFIX` now lives beside `FLAKE_RUN_PREFIX` in
 * packages/shared/src/constants.ts, where a marker written by the worker's sweep
 * and read by the API's approval route belongs. It used to be declared here,
 * which meant the API imported an agent module to borrow one string.
 */
import { healProposalSchema, HEAL_VERIFY_RUN_PREFIX } from '@qaai/shared';
import type { HealProposal, HealState, StepResult, TriageVerdict } from '@qaai/shared';
import { applyHealDiff } from './heal-apply.js';
import type { CallContext, LlmService } from './llm.js';

const SYSTEM = `You are the Healer agent inside QAAI, an AI QA engineer.

A test is failing because the application changed on purpose. Your job is to
update the test so it tests the same thing against the new application — not to
make the test pass.

Non-negotiable:
- Change the smallest thing that can work. A renamed button means one locator
  changes, not a rewritten test.
- Never weaken an assertion to make a failure go away. Do not replace a value
  check with a presence check, do not delete an assertion, do not add a
  try/catch or an optional wait around a failing step. If the only way to make
  the test pass is to stop testing something, say so in the explanation and
  propose the assertion update the change actually implies.
- That rule holds for INSTABILITY too, not only for a changed application. If
  the test is intermittent, the fix is a wait on the condition the test is
  actually about — an element state, a response, a computed value — never a
  looser assertion, never a retry wrapper, and never a sleep. "Make it pass more
  often" is not a goal; "make it fail only when the product is broken" is.
- Never add a fixed sleep.

Classify the risk of your own diff honestly:
  SELECTOR_ONLY     only locator strings changed; every assertion is untouched
  ASSERTION_CHANGE  an expected value or an assertion changed
  STRUCTURAL        steps were added, removed, or reordered

Output a unified diff against the file as given, with correct line context.`;

export interface HealInput {
  testName: string;
  filePath: string;
  currentCode: string;
  verdict: TriageVerdict;
  failingStep: StepResult | null;
  /** Locators the most recent crawl found, so the fix targets something real. */
  availableLocators?: string[];
}

export async function proposeHeal(
  llm: LlmService,
  ctx: CallContext,
  input: HealInput,
): Promise<HealProposal & { testId?: string }> {
  const prompt = `TEST: ${input.testName}
FILE: ${input.filePath}

TRIAGE VERDICT: ${input.verdict.verdict} (confidence ${input.verdict.confidence.toFixed(2)})
${input.verdict.explanation}

FAILING STEP
${
  input.failingStep
    ? [
        `  [${input.failingStep.index}] ${input.failingStep.title}`,
        `  error:    ${input.failingStep.error?.message ?? 'unknown'}`,
        input.failingStep.error?.expected
          ? `  expected: ${input.failingStep.error.expected}`
          : null,
        input.failingStep.error?.actual ? `  actual:   ${input.failingStep.error.actual}` : null,
        input.failingStep.error?.selector
          ? `  locator:  ${input.failingStep.error.selector}`
          : null,
      ]
        .filter(Boolean)
        .join('\n')
    : '  (the failure was not attributed to a step)'
}

${
  input.availableLocators?.length
    ? `LOCATORS PRESENT ON THE PAGE RIGHT NOW\n${input.availableLocators
        .map((l) => `  ${l}`)
        .join('\n')}\n`
    : ''
}
CURRENT FILE
${input.currentCode}

Propose the fix as a unified diff.`;

  const proposal = await llm.structured(ctx, {
    tier: 'strong',
    effort: 'high',
    system: SYSTEM,
    prompt,
    schema: healProposalSchema,
    schemaName: 'HealProposal',
    maxTokens: 8000,
    cacheSystem: true,
  });

  return { ...proposal, testId: '' };
}

/**
 * Whether a proposal may be applied without a human, given the org setting.
 *
 * The model self-reports risk, and self-reports are not a safety boundary — so
 * we re-derive it from the diff. A diff that touches an `expect(` line is an
 * assertion change regardless of what the model called it.
 */
export function isAutoApprovable(
  proposal: HealProposal | { diff: string; riskLevel: string; confidence: number },
  orgAllowsSelectorAutoApproval: boolean,
): { allowed: boolean; reason: string } {
  /*
   * RETIRE first, before the org setting is even consulted.
   *
   * A retirement is not a patch — it disables one of the customer's tests — and
   * the mistake it can make is unrecoverable in the way that matters: a test
   * whose route is merely UNREACHED by the latest crawl looks exactly like a
   * test whose route is gone, and switching off the first one removes coverage
   * nobody will notice is missing. `obsolete.ts` works hard to keep those two
   * apart; this is the backstop in case it ever gets it wrong. The risk-level
   * check further down would also refuse this, but a rule this important must
   * not depend on the ORDER of two unrelated conditions.
   */
  if (proposal.riskLevel === 'RETIRE') {
    return {
      allowed: false,
      reason:
        'A retirement proposal is never applied without a person. Switching off a test that was only unreached, rather than genuinely obsolete, silently removes coverage.',
    };
  }

  if (!orgAllowsSelectorAutoApproval) {
    return { allowed: false, reason: 'Auto-approval is disabled for this project' };
  }

  if (!proposal.diff.trim()) {
    return {
      allowed: false,
      reason: 'The proposal carries no diff, so there is nothing an unattended path could apply',
    };
  }

  const changedLines = proposal.diff
    .split('\n')
    .filter(
      (line) =>
        (line.startsWith('+') || line.startsWith('-')) &&
        !line.startsWith('+++') &&
        !line.startsWith('---'),
    );

  const touchesAssertion = changedLines.some((line) =>
    /\bexpect\s*\(|\bassert|toBe|toEqual|toHaveText|toHaveValue|toContain/.test(line),
  );
  if (touchesAssertion) {
    return { allowed: false, reason: 'The diff changes an assertion, which always needs a human' };
  }

  if (proposal.riskLevel !== 'SELECTOR_ONLY') {
    return { allowed: false, reason: `Risk level is ${proposal.riskLevel}, not SELECTOR_ONLY` };
  }
  if (proposal.confidence < 0.85) {
    return { allowed: false, reason: `Confidence ${proposal.confidence.toFixed(2)} is below 0.85` };
  }
  if (changedLines.length > 6) {
    return {
      allowed: false,
      reason: `${changedLines.length} lines changed — too broad to auto-apply`,
    };
  }

  return { allowed: true, reason: 'Selector-only, high confidence, narrow diff' };
}

// ─── The lifecycle: one open proposal per test, and a verified apply ─────────

export function verificationRunTag(healId: string): string {
  return `${HEAL_VERIFY_RUN_PREFIX}${healId}`;
}

export function parseVerificationRunTag(triggeredBy: string | null | undefined): string | null {
  if (typeof triggeredBy !== 'string' || !triggeredBy.startsWith(HEAL_VERIFY_RUN_PREFIX)) {
    return null;
  }
  const healId = triggeredBy.slice(HEAL_VERIFY_RUN_PREFIX.length).trim();
  return healId.length > 0 ? healId : null;
}

/**
 * The domain of `HealProposal.verifyState`, enforced here because the column is
 * TEXT — see the migration for why it is not a Prisma enum.
 *
 * There is no `NOT_VERIFIED` member and no default. A proposal nobody applied
 * has the column NULL, which says "no claim" in a way no member of this list
 * could; the whole point of this feature is that "nothing checked" and "the
 * check passed" must never be the same value.
 */
export const HEAL_VERIFY_STATES = [
  /** Applied; the verifying run has not produced a terminal result yet. */
  'PENDING',
  /** The verifying run executed the test and it passed. The fix is real. */
  'VERIFIED',
  /** The verifying run executed the test and it still fails. The fix is not. */
  'STILL_FAILING',
  /**
   * Applied, and nobody checked — no environment to run in, the org is at its
   * run cap, the run errored or was cancelled. This is the member that must
   * exist: without it, "we could not look" collapses into one of the two
   * answers above, and whichever one it collapses into is a lie.
   */
  'UNVERIFIABLE',
] as const;
export type HealVerifyState = (typeof HEAL_VERIFY_STATES)[number];

/**
 * The `HealState` values that mean "a human still has to decide".
 *
 * Typed against the mirror in `@qaai/shared` rather than as bare strings, so a
 * sixth state or a typo is a compile error here instead of a list of magic
 * strings compared against another list of magic strings.
 */
export const OPEN_HEAL_STATES: readonly HealState[] = ['PROPOSED', 'APPROVED'];

/**
 * What KIND of recommendation a proposal is.
 *
 * Load-bearing for superseding. A retirement ("this test should stop existing")
 * and a patch ("this test should point at the renamed button") are not two
 * drafts of one answer — they are two different answers, and a reviewer facing
 * both is facing a real choice. Letting one supersede the other would silently
 * throw away an option a person was entitled to see, which is the opposite of
 * what superseding is for.
 */
export type HealKind = 'PATCH' | 'RETIREMENT';

export function healKindOf(riskLevel: string): HealKind {
  return riskLevel === 'RETIRE' ? 'RETIREMENT' : 'PATCH';
}

export interface OpenHeal {
  id: string;
  /**
   * Narrowed to the shared mirror of the Prisma enum, which is what lets
   * `OPEN_HEAL_STATES.includes(heal.state)` be checked rather than merely
   * spelled. Both producers select this column straight out of Prisma, so the
   * enum they hand over is this type.
   */
  state: HealState;
  riskLevel: string;
  diff: string;
  createdAt: Date;
}

export interface SupersedePlan {
  /** Proposals to mark SUPERSEDED, oldest first. */
  ids: string[];
  /** Written onto each superseded row and into the audit metadata. */
  reason: string;
}

/**
 * Which open proposals a new one replaces.
 *
 * Only the OPEN ones, and only of the same kind. Specifically NOT:
 *
 *  - APPLIED / AUTO_APPLIED — that is history. A superseded label on a proposal
 *    whose code is already in the repository would make the version history
 *    unreadable.
 *  - REJECTED — a person decided. Re-labelling their decision is a way of
 *    quietly undoing it.
 *  - the incoming proposal itself, when the caller passes it in the list.
 *  - the other kind — see `HealKind`.
 */
export function planSupersede(args: {
  incomingId: string;
  incomingRiskLevel: string;
  openHeals: readonly OpenHeal[];
}): SupersedePlan {
  const kind = healKindOf(args.incomingRiskLevel);
  const ids = args.openHeals
    .filter(
      (heal) =>
        heal.id !== args.incomingId &&
        OPEN_HEAL_STATES.includes(heal.state) &&
        healKindOf(heal.riskLevel) === kind,
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((heal) => heal.id);

  return {
    ids,
    reason:
      ids.length === 0
        ? 'Nothing open to supersede.'
        : `Replaced by proposal ${args.incomingId}, which was made against the test as it stands now. ` +
          `This row keeps its diff and its reasoning — the record of what was proposed is not rewritten — ` +
          `but it is no longer awaiting a decision.`,
  };
}

export interface ProposeDecision {
  propose: boolean;
  /** Always says why, in words a cockpit can show. */
  reason: string;
  /** The open proposal that makes a new one unnecessary, when there is one. */
  reuseId: string | null;
  /** Open proposals the caller should supersede if it does propose. */
  staleIds: string[];
}

/**
 * Whether this test needs a NEW proposal, or already has a usable one.
 *
 * THE DEFECT: the only idempotence guard on healing was "does this TestResult
 * already have a verdict", which is per RESULT. A test that fails on every run
 * produced a new result every run, so it produced a new strong-tier Healer call
 * every run, and fifty rows in the review queue describing one broken test —
 * forty-nine of them patches against code that had already moved on.
 *
 * THE ORACLE: the applier. An open proposal whose diff STILL APPLIES to the
 * current code is still a valid fix for a test that is still broken in the same
 * way; another model call would buy a near-duplicate. A proposal whose diff no
 * longer applies is stale by definition — the file changed underneath it — so a
 * new proposal is worth paying for and the stale ones should be superseded.
 *
 * This is deliberately NOT a timestamp comparison. "Was the proposal made after
 * the last edit" needs two clocks to agree and is wrong whenever a test is
 * edited and reverted; "does the patch fit the bytes in front of me" needs
 * neither clock and is the actual question.
 *
 * Verification state matters here too: a proposal that was applied and came back
 * STILL_FAILING must not be reused as though it were a pending fix — it is a
 * fix we have EVIDENCE does not work, and offering it again is how a product
 * recommends the same wrong answer forever. Those rows are not open, so they are
 * not candidates for reuse at all; the caller re-proposes.
 */
export function shouldProposeHeal(args: {
  openHeals: readonly OpenHeal[];
  /** The test's code as it stands right now. */
  currentCode: string;
  /** For the applier's dialect resolution; see `HealApplyHints`. */
  filePath?: string | null;
  ecosystemId?: string | null;
  /** RETIRE proposals are a different lane; defaults to the patch lane. */
  kind?: HealKind;
}): ProposeDecision {
  const kind = args.kind ?? 'PATCH';
  const open = args.openHeals.filter(
    (heal) => OPEN_HEAL_STATES.includes(heal.state) && healKindOf(heal.riskLevel) === kind,
  );
  if (open.length === 0) {
    return {
      propose: true,
      reason: 'No open proposal for this test.',
      reuseId: null,
      staleIds: [],
    };
  }

  /*
   * A retirement carries no diff, so there is nothing to apply and nothing to
   * go stale. One open retirement is the whole answer: proposing a second one
   * would put two identical "delete this test" rows in front of the same
   * person.
   */
  if (kind === 'RETIREMENT') {
    const newest = [...open].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
    return {
      propose: false,
      reason: `A retirement proposal for this test is already waiting for a decision (${newest.id}).`,
      reuseId: newest.id,
      staleIds: [],
    };
  }

  const stale: string[] = [];
  let usable: OpenHeal | null = null;
  // Newest first: if two open proposals both still apply, the newest is the one
  // to keep and the older ones are the queue clutter this guard exists to stop.
  for (const heal of [...open].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    const applies =
      heal.diff.trim().length > 0 &&
      applyHealDiff(args.currentCode, heal.diff, {
        filePath: args.filePath ?? null,
        ecosystemId: args.ecosystemId ?? null,
      }).ok;
    if (applies && usable === null) usable = heal;
    else stale.push(heal.id);
  }

  if (usable) {
    return {
      propose: false,
      reason:
        `Proposal ${usable.id} is still open and its diff still applies to this test exactly as it ` +
        `stands, so it is still a valid fix. Minting another one would spend a strong-model call to ` +
        `put a near-duplicate row in the same review queue.`,
      reuseId: usable.id,
      staleIds: stale,
    };
  }

  return {
    propose: true,
    reason:
      `${open.length} open proposal(s) for this test no longer apply — the file changed after they ` +
      `were made — so they are stale and a fresh one is worth making.`,
    reuseId: null,
    staleIds: stale,
  };
}

export interface VerificationInput {
  /** The state the proposal is in. APPLIED means a person approved it. */
  healState: string;
  /** Terminal status of the verifying run, or null while it is still running. */
  runStatus: string | null;
  /** The result recorded for the healed test in that run, when there was one. */
  resultStatus: string | null;
  retriedAndPassed: boolean;
  /** The TestVersion the heal wrote. Without it a revert cannot be performed. */
  appliedVersion: number | null;
}

export interface VerificationOutcome {
  state: HealVerifyState;
  /**
   * Whether to put the test's code back the way it was.
   *
   * TRUE ONLY for an unattended apply that verification proved did not work.
   * Never for a heal a person approved — see below.
   */
  revert: boolean;
  /** The sentence a human reads. Never empty, and never implies a check that did not happen. */
  note: string;
  /** Stated separately so a caller can badge it; it rides in `note` as well. */
  passedOnRetry: boolean;
}

/**
 * What the verifying run means, and what to do about it.
 *
 * ── WHEN VERIFICATION FAILS ─────────────────────────────────────────────────
 *
 * The two apply paths are treated DIFFERENTLY here, and the asymmetry is the
 * whole design rather than an inconsistency:
 *
 *   AUTO_APPLIED — nobody chose this. A model wrote a patch into the customer's
 *     repository because an org setting said selector-only fixes could go
 *     through unattended, and the premise of that setting is that the fix WORKS.
 *     Verification has just shown it does not. Leaving it in place would mean an
 *     unattended write that failed its own check stays in the customer's code
 *     with nobody informed, and the next human to look at the test is debugging
 *     a model's guess instead of their own failure. So it is reverted to the
 *     version it replaced — and the proposal KEEPS its AUTO_APPLIED state. It
 *     is not put back in the review queue: offering a person a fix we now have
 *     evidence does not work is how a product recommends the same wrong answer
 *     for ever. The row keeps the diff, the state and the verification note, so
 *     the history is readable; triage proposes afresh. (The writer is
 *     `recordVerification` in apps/worker/src/processors/flake.ts, which says
 *     the same thing on the `state` column it deliberately does not touch, and
 *     the note this function returns says it to the customer.)
 *
 *   APPLIED — a person read the diff and clicked Approve. Reverting that is its
 *     own surprise: they may have approved it as the first of two changes, they
 *     may know something about the environment the verifying run does not, and
 *     a tool that silently rolls back decisions while nobody is looking is a
 *     tool nobody can reason about. So the code STAYS, the proposal keeps its
 *     APPLIED state, and the only thing that changes is that it now says
 *     STILL_FAILING instead of saying nothing. Nothing is suppressed: the test
 *     is still red and still gating, which is exactly the state that gets
 *     noticed.
 *
 * ── WHEN VERIFICATION CANNOT RUN ────────────────────────────────────────────
 *
 * UNVERIFIABLE, and never a revert. A run that errored, was cancelled, or never
 * executed the test tells us nothing about the heal, and undoing a change on no
 * information is the same error as claiming it worked on no information. It is
 * the honest answer and it is a visible one — the cockpit shows the note.
 */
export function decideVerification(input: VerificationInput): VerificationOutcome {
  const unattended = input.healState === 'AUTO_APPLIED';
  const executed = input.resultStatus !== null && input.resultStatus !== 'SKIPPED';
  const runUsable = input.runStatus === 'PASSED' || input.runStatus === 'FAILED';

  if (input.runStatus === null) {
    return {
      state: 'PENDING',
      revert: false,
      note: 'The run that checks this heal has not finished yet, so nobody has confirmed the test is green.',
      passedOnRetry: false,
    };
  }

  if (!runUsable || !executed) {
    return {
      state: 'UNVERIFIABLE',
      revert: false,
      note:
        `The heal was applied, and nobody has confirmed it works: the verifying run ended ` +
        `${String(input.runStatus).toLowerCase()}${executed ? '' : ' without executing the test'}, ` +
        `which says nothing about the fix. The test has NOT been shown to pass. ` +
        `Re-run it to find out — this heal is not being reverted on no information.`,
      passedOnRetry: false,
    };
  }

  if (input.resultStatus === 'PASSED') {
    /*
     * A pass that only happened on retry is still a pass: the heal did fix the
     * failure it was proposed for. What it did not do is make the test STABLE,
     * and that is a different defect with a different lane (the flake radar,
     * which will suspect this test on exactly this signal). Saying so in the
     * note is the honest middle: the fix is verified, the test is not trusted.
     */
    return {
      state: 'VERIFIED',
      revert: false,
      note: input.retriedAndPassed
        ? 'The heal works: the test passed in the verifying run — but only on retry, so it is also unstable. The flake radar will pick that up separately; this heal is not the cause and not the cure.'
        : 'The heal works: the test passed in the verifying run.',
      passedOnRetry: input.retriedAndPassed,
    };
  }

  const base =
    `The heal was applied and the test STILL FAILS: the verifying run recorded ` +
    `${String(input.resultStatus).toLowerCase()}.`;

  if (!unattended) {
    return {
      state: 'STILL_FAILING',
      revert: false,
      note:
        `${base} It has been left in place, because a person approved it and silently rolling back ` +
        `an approved change is its own surprise. The test is still red and still gating, so nothing ` +
        `is suppressed — but this fix is not the answer, and the next proposal should not start from it.`,
      passedOnRetry: false,
    };
  }

  if (input.appliedVersion === null || input.appliedVersion <= 1) {
    /*
     * An unattended write we cannot undo. Reverting blindly — to "whatever came
     * before", guessed — risks writing a version of the test the heal never
     * replaced, which is a worse outcome than leaving the patch in place and
     * saying so loudly.
     */
    return {
      state: 'STILL_FAILING',
      revert: false,
      note:
        `${base} It was applied with no human in the loop and could not be reverted automatically: ` +
        `the version it replaced is not recorded, so there is nothing to put back that we are sure ` +
        `about. Read the diff and revert it by hand from the test's history.`,
      passedOnRetry: false,
    };
  }

  return {
    state: 'STILL_FAILING',
    revert: true,
    note:
      `${base} It was applied with no human in the loop, so it has been REVERTED to version ` +
      `${input.appliedVersion - 1} — an unattended patch that failed its own check must not stay in ` +
      `your repository. The proposal keeps this evidence and is NOT put back in the review queue: ` +
      `triage will propose afresh rather than re-offering a fix we now know does not work.`,
    passedOnRetry: false,
  };
}
