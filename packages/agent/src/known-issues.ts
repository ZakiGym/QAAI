/**
 * Known issues, and the heal that must not be bought twice.
 *
 * ─── THE DEFECT THIS CLOSES ─────────────────────────────────────────────────
 *
 * `VerdictReviewState.MUTED` was written by two endpoints
 * (apps/api/src/routes/agent.ts, apps/api/src/routes/team.ts) and READ BY
 * NOTHING. So a reviewer who muted a failure changed one column and nothing
 * else: the next run minted a fresh verdict for the same cause and — when the
 * verdict was INTENDED_CHANGE — a fresh STRONG-MODEL heal for the same test.
 * Noise and cost, forever, for a question somebody had already answered.
 *
 * The keystone built the durable form (`KnownIssue`, and
 * `packages/shared/src/suppression.ts`'s one suppression vocabulary). This
 * module is the half that decides, per failing cause, WHETHER THE MODEL CALL
 * HAPPENS — which is where the saving actually is. `reviewStateSuppresses`
 * already encodes the rule that MUTED on its own suppresses nothing; what was
 * missing is the thing that finds the live `KnownIssue` behind it and counts
 * the match.
 *
 * ─── WHY HEAL SUPERSESSION LIVES IN THE SAME FILE ───────────────────────────
 *
 * Because it is the same sentence: stop paying a strong model to re-answer a
 * question someone already answered. A mute stops the triage call; supersession
 * stops the HEALER call, which is the expensive one. `shouldProposeHeal`
 * (packages/agent/src/healer.ts) already asks "does an open proposal's diff
 * still apply", and that guard is good and is not enough:
 *
 *   IT HAS NO NOTION OF THE CAUSE. Two different causes on one test — a
 *   renamed locator and a changed total — both land in the PATCH lane, and
 *   whichever proposal happens to still apply answers for both. A reviewer is
 *   then handed a selector fix as the answer to an arithmetic bug, and the
 *   second cause never gets a proposal at all.
 *
 *   IT IS UNBOUNDED. A test whose file keeps changing makes every open
 *   proposal stale, so a fresh strong-tier call is "worth making" on every run
 *   forever. Fifty superseded rows that nobody ever opened is not a review
 *   queue, it is a bill — and the fact worth reporting is not proposal
 *   fifty-one, it is "we keep proposing this and nobody is reviewing".
 *
 * ─── EVERY SUPPRESSION IS COUNTED, AND AN EXPIRED ONE DOES NOT SUPPRESS ─────
 *
 * {@link suppressionEventsFor} is not optional decoration. A failure silenced
 * without being counted makes "it went quiet" and "it stopped happening" the
 * same fact, which is the one defect that would make this product worse than
 * nothing. And the row that matters most is the BORING one: `inForce: false`
 * with `suppressed: 0` is the ledger entry that PROVES an expiry worked.
 *
 * An expired or revoked known issue suppresses NOTHING ({@link isInForce} is
 * asked, never re-implemented). The failure comes back red on its own with no
 * human action, and the issue is reported as expired WITH ITS OWNER — because
 * the owner is the person who has to renew it or let the board go loud.
 *
 * ─── A NEAR MATCH PROPOSES, IT DOES NOT SUPPRESS ────────────────────────────
 *
 * The broader match is real and it is needed: a signature built from a message
 * that carries a line number stops matching after any edit to the file, so a
 * mute somebody set on Monday silently lapses on Tuesday while the cause is
 * unchanged. So this module computes it, scores it, and then REFUSES TO
 * SUPPRESS ON IT — see {@link KNOWN_ISSUE_TIER_RULES}. "Same test and same
 * error class" is broad enough to swallow a genuinely new failure on a test
 * that already has one muted cause, and a mute that swallows a failure nobody
 * inspected is a quarantine wearing a mute's name.
 *
 * What a near match produces instead is a {@link SignatureAdoption}: the exact
 * 12-hex key to add to the issue, for the owner to approve once. That costs one
 * click and then the EXACT tier handles it forever, which is a better answer
 * than widening the match silently.
 *
 * ─── NO MODEL, NO NETWORK, NO CLOCK ────────────────────────────────────────
 *
 * Set membership, a parse of a legible signature string, and date comparison.
 * `now` is injected everywhere for the reason the keystone gives: a module that
 * reads the clock cannot be asked what it would have decided yesterday. This is
 * the path that must work with no model key at all, and nothing here enriches
 * it with one.
 */

/*
 * The keystone's suppression vocabulary, through the package barrel.
 *
 * Nothing is re-implemented here: `isInForce`, `forceStateOf` and
 * `matchKnownIssue` are ASKED, so an expired known issue cannot behave like a
 * live one at one call site and a dead one at another. That is the whole reason
 * those functions live in one file.
 */
import { forceStateOf, isInForce, matchKnownIssue } from '@qaai/shared';
import type {
  KnownIssueMatcher,
  SuppressionKind,
  SuppressionTally,
  SuppressionTargetScope,
} from '@qaai/shared';
import type { OwnerProvenance } from '@qaai/shared';
import type { OwnerRef } from '@qaai/shared';

// ─── The tiers ───────────────────────────────────────────────────────────────

/**
 * How well a known issue matches a cause.
 *
 * NONE is a member rather than a null tier so a caller switching on this cannot
 * forget the no-match case, and so "we looked and found nothing" is a value
 * rather than the absence of one.
 */
export const KNOWN_ISSUE_MATCH_TIERS = ['EXACT', 'NEAR', 'NONE'] as const;
export type KnownIssueMatchTier = (typeof KNOWN_ISSUE_MATCH_TIERS)[number];

/** What each tier is worth, and what it is allowed to do. */
export interface KnownIssueTierRule {
  /**
   * How much to believe it. NULL for NONE — not 0.
   *
   * "We are 0% confident there is a match" and "there is no match to be
   * confident about" are different facts, and a 0 here would be a measurement
   * nobody took. Same rule as `overrideRatePercent` in triage.ts.
   */
  readonly confidence: number | null;
  /**
   * May a match at this tier stop a failure counting?
   *
   * TRUE for EXACT only, and that is the safety property of a mute: the cluster
   * key changes when the cause changes, so an exact match is a statement about
   * the cause somebody actually inspected. NEAR is "same test, same error
   * class", which is also what a genuinely new failure on an already-muted test
   * looks like.
   */
  readonly maySuppress: boolean;
  /** One sentence, for the person asking why their mute did or did not fire. */
  readonly why: string;
}

/**
 * The compiler-enforced presence record. A `Record<KnownIssueMatchTier, …>`
 * cannot be written without naming every tier, so a fourth tier is a type error
 * here — where the decision about whether it may suppress has to be made —
 * rather than a tier that silently suppresses as hard as an exact key.
 */
export const KNOWN_ISSUE_TIER_RULES = {
  EXACT: {
    confidence: 1,
    maySuppress: true,
    why: 'The cause key is one this known issue names. The key changes when the cause changes, so this is the cause somebody triaged.',
  },
  NEAR: {
    confidence: 0.6,
    maySuppress: false,
    why: 'Same test and same error class as a cause this issue covers, but a different key — the signature moved. Not enough to suppress on: a new failure on an already-muted test looks exactly like this. It proposes adding the new key instead.',
  },
  NONE: {
    confidence: null,
    maySuppress: false,
    why: 'No known issue covers this cause.',
  },
} as const satisfies Record<KnownIssueMatchTier, KnownIssueTierRule>;

/**
 * How confident a near match must be before it is worth asking a human to adopt
 * the new key.
 *
 * At or below this, the near match is reported and no adoption is proposed: a
 * roster full of "is this the same thing?" prompts is a roster nobody reads,
 * and the cost of being wrong here is a human minute, not a silenced failure.
 */
export const KNOWN_ISSUE_ADOPTION_MIN_CONFIDENCE = 0.5;

// ─── What is being matched ───────────────────────────────────────────────────

/**
 * A failing cause's identity, exactly as the caller's clusterer already
 * computed it.
 *
 * All three fields come from one place (`causeOf` in
 * apps/worker/src/processors/triage.ts), so this module never re-derives a key
 * and cannot disagree with the cockpit about which cause a failure is.
 */
export interface FailureIdentity {
  /** 12 lowercase hex — `failureClusterKey`'s output. */
  clusterKey: string;
  /** `signatureOf`'s legible string, verbatim. The near tier parses this. */
  signature: string;
  /** The test this failure is on. The other half of the near tier. */
  testId: string;
}

/**
 * A cause a known issue already covers, with the facts the caller joined in.
 *
 * `KnownIssue.signatures` holds only HASHES, so the near tier cannot be
 * computed from the issue row alone. The caller joins `FailureSignature` (which
 * stores the full legible `signature`) and the tests that cause has been seen
 * on. Both are allowed to be absent, and when they are the near tier reports
 * itself UNEVALUABLE rather than returning NONE — "we did not check" must never
 * read as "there is nothing there".
 */
export interface CoveredCause {
  clusterKey: string;
  /** `FailureSignature.signature`. Null when the caller did not join it. */
  signature: string | null;
  /** Tests this cause has been seen on. Empty when the caller did not join them. */
  testIds: readonly string[];
}

/**
 * A known issue as this module needs it.
 *
 * Extends the keystone's {@link KnownIssueMatcher} rather than restating its
 * fields, so `isInForce` and `matchKnownIssue` accept this value directly and
 * there is no second idea of what a mute's expiry is.
 *
 * `owner` and `ownerProvenance` are REQUIRED. They are not decoration: the
 * owner is who gets told when the mute expires, and the provenance is the
 * record that a human — not a glob — decided this failure stops counting.
 * `applySuppression` refuses anything weaker and `createKnownIssueSchema`
 * refuses it at the wire; carrying them here means a reader of a match does not
 * have to go and find out.
 */
export interface KnownIssueRow extends KnownIssueMatcher {
  /** Human-written. NEVER composed from failure output — see the schema. */
  title: string;
  /** Human-written. Copied verbatim onto the ledger row. */
  reason: string;
  owner: OwnerRef;
  ownerProvenance: OwnerProvenance;
  /** Matches over this issue's whole life, for the roster. */
  matchCount: number;
  /** The joined facts for `signatures`. Empty makes the near tier unevaluable. */
  covered: readonly CoveredCause[];
}

/** Why the near tier could not be evaluated. A reason, never a silent NONE. */
export const NEAR_UNEVALUABLE_REASONS = [
  /** No live issue had any joined `covered` facts to compare against. */
  'NO_JOINED_CAUSES',
  /** The failing signature carries no `class=` facet, so there is nothing to compare. */
  'NO_ERROR_CLASS',
  /** Causes were joined and none of them recorded which tests they fired on. */
  'NO_TEST_IDS',
] as const;
export type NearUnevaluableReason = (typeof NEAR_UNEVALUABLE_REASONS)[number];

/**
 * A known issue that WOULD have suppressed this cause and did not, because it
 * is over.
 *
 * Reported with its owner, which is the whole point: an expiring mute roster is
 * the early warning that a board is about to go loud, and an expiry that
 * arrives as a surprise outage teaches a team to set the next one for a year.
 */
export interface ExpiredKnownIssue {
  id: string;
  title: string;
  owner: OwnerRef;
  ownerProvenance: OwnerProvenance;
  /** EXPIRED ran out; REVOKED was judged wrong. Only the second says anything about the decision. */
  forceState: 'EXPIRED' | 'REVOKED';
  expiresAt: Date;
  /** The tier it would have matched at, had it been live. Never NONE. */
  wouldHaveMatched: 'EXACT' | 'NEAR';
}

export interface KnownIssueMatchResult {
  tier: KnownIssueMatchTier;
  /** The matching issue, or null. Null at tier NONE, and only there. */
  issue: KnownIssueRow | null;
  /** {@link KNOWN_ISSUE_TIER_RULES}' confidence for `tier`. Null at NONE. */
  confidence: number | null;
  /** Live issues this answer was computed over — the denominator of "no match". */
  considered: number;
  /** Issues that are over. See {@link ExpiredKnownIssue}. */
  expired: readonly ExpiredKnownIssue[];
  /** Null when the near tier WAS evaluated (whether or not it matched). */
  nearUnevaluable: NearUnevaluableReason | null;
  /** One sentence. Composed from this module's own words and closed vocabularies. */
  disclosure: string;
}

// ─── Reading a signature ─────────────────────────────────────────────────────

/**
 * The `class=` facet of a signature string, or null.
 *
 * `signatureOf` (apps/api/src/lib/cluster.ts) joins facets as
 * `class=X | call=Y | assert=Z | …` in a fixed order, deliberately legible
 * because the cockpit shows it. This reads the one facet the near tier needs
 * and nothing else — a parser that understood all seven would be a second
 * implementation of the clusterer, drifting the day somebody adds a facet.
 *
 * Returns null rather than an empty string for an absent class, so the caller's
 * comparison cannot accidentally match two signatures that both have no class.
 * Two failures with no error class at all are not evidence of a shared cause.
 */
export function errorClassOf(signature: string): string | null {
  for (const part of signature.split('|')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith('class=')) continue;
    const value = trimmed.slice('class='.length).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

// ─── The matcher ─────────────────────────────────────────────────────────────

/**
 * Does this issue's FACETS cover this cause at the NEAR tier?
 *
 * EXPIRY-BLIND on purpose: `describeExpired` asks this the counterfactual
 * question — would this dead issue have matched — and a function that refused
 * expired issues could not answer it. The live path asks `isInForce` itself,
 * right beside its call.
 *
 * Both halves required, and `testIds` is the half that makes it safe: without
 * it, "same error class" alone would let one `TimeoutError` mute every timeout
 * in the project. Returns a reason when it could not be answered at all.
 */
function nearCoverage(
  issue: KnownIssueRow,
  failure: FailureIdentity,
  failingClass: string,
): { matched: boolean; sawJoinedCause: boolean; sawTestIds: boolean } {
  let sawJoinedCause = false;
  let sawTestIds = false;
  for (const cause of issue.covered) {
    // The exact tier already answered for this key; a "near" match to the key
    // we did not match exactly is a contradiction.
    if (cause.clusterKey === failure.clusterKey) continue;
    if (cause.signature === null) continue;
    sawJoinedCause = true;
    if (cause.testIds.length > 0) sawTestIds = true;
    if (errorClassOf(cause.signature) !== failingClass) continue;
    if (!cause.testIds.includes(failure.testId)) continue;
    return { matched: true, sawJoinedCause: true, sawTestIds: true };
  }
  return { matched: false, sawJoinedCause, sawTestIds };
}

/**
 * The known issue that covers this cause, at the best tier it matches.
 *
 * EXACT is delegated to the keystone's `matchKnownIssue` rather than
 * re-implemented, so there is exactly one place in the product that decides what
 * an exact mute match is — and that place filters expired and revoked issues
 * ITSELF rather than trusting a caller to have done it.
 *
 * ORDER IS LOAD-BEARING. Exact first, and a near match is only computed when no
 * exact one exists: a cause that one issue names outright and another merely
 * resembles belongs to the first, stably, whatever order the rows arrive in. A
 * match count that moves between two rows depending on iteration order is a
 * count nobody can audit.
 */
export function matchKnownIssues(
  issues: readonly KnownIssueRow[],
  failure: FailureIdentity,
  now: Date,
): KnownIssueMatchResult {
  const live = issues.filter((issue) => isInForce(issue, now));
  const dead = issues.filter((issue) => !isInForce(issue, now));
  const failingClass = errorClassOf(failure.signature);

  const describeExpired = (issue: KnownIssueRow): ExpiredKnownIssue | null => {
    const exact = issue.signatures.includes(failure.clusterKey);
    const near =
      !exact && failingClass !== null && nearCoverage(issue, failure, failingClass).matched;
    if (!exact && !near) return null;
    const state = forceStateOf(issue, now);
    // IN_FORCE is unreachable here — `dead` is the complement of `isInForce` —
    // and it is narrowed rather than asserted so a change to `forceStateOf`
    // becomes a compile error instead of a wrong label on an audit row.
    if (state === 'IN_FORCE') return null;
    return {
      id: issue.id,
      title: issue.title,
      owner: issue.owner,
      ownerProvenance: issue.ownerProvenance,
      forceState: state,
      expiresAt: issue.expiresAt,
      wouldHaveMatched: exact ? 'EXACT' : 'NEAR',
    };
  };

  const expired = dead
    .map(describeExpired)
    .filter((entry): entry is ExpiredKnownIssue => entry !== null);

  const exact = matchKnownIssue(live, failure.clusterKey, now);
  if (exact) {
    return {
      tier: 'EXACT',
      issue: exact,
      confidence: KNOWN_ISSUE_TIER_RULES.EXACT.confidence,
      considered: live.length,
      expired,
      // The near tier was never reached, which is a different fact from it
      // having been unevaluable. An exact match makes the question moot.
      nearUnevaluable: null,
      disclosure: disclose('EXACT', live.length, expired, null),
    };
  }

  if (failingClass === null) {
    return {
      tier: 'NONE',
      issue: null,
      confidence: KNOWN_ISSUE_TIER_RULES.NONE.confidence,
      considered: live.length,
      expired,
      nearUnevaluable: 'NO_ERROR_CLASS',
      disclosure: disclose('NONE', live.length, expired, 'NO_ERROR_CLASS'),
    };
  }

  let sawJoinedCause = false;
  let sawTestIds = false;
  for (const issue of live) {
    /*
     * THE EXPIRY IS ASKED AGAIN HERE, and the duplication with `live` above is
     * the point. `matchKnownIssue` filters expired issues ITSELF rather than
     * trusting the caller, with the keystone's reasoning beside it: "a caller
     * that forgot the filter would be a caller whose expired mutes still work,
     * and this is the one rule that must be impossible to get wrong." This loop
     * is the SECOND matcher in the product, so it owes the same property — and
     * the debt was not theoretical: with only the filter above, mutating it away
     * left this loop near-matching an EXPIRED mute, which minted an adoption
     * proposal for a dead issue and a ledger row claiming `inForce: true`.
     *
     * `nearCoverage` stays expiry-blind on purpose: `describeExpired` asks it
     * the COUNTERFACTUAL question — would this dead issue have matched — and a
     * coverage test that refused expired issues could not answer it.
     */
    if (!isInForce(issue, now)) continue;
    const near = nearCoverage(issue, failure, failingClass);
    sawJoinedCause = sawJoinedCause || near.sawJoinedCause;
    sawTestIds = sawTestIds || near.sawTestIds;
    if (!near.matched) continue;
    return {
      tier: 'NEAR',
      issue,
      confidence: KNOWN_ISSUE_TIER_RULES.NEAR.confidence,
      considered: live.length,
      expired,
      nearUnevaluable: null,
      disclosure: disclose('NEAR', live.length, expired, null),
    };
  }

  const unevaluable: NearUnevaluableReason | null = !sawJoinedCause
    ? 'NO_JOINED_CAUSES'
    : !sawTestIds
      ? 'NO_TEST_IDS'
      : null;

  return {
    tier: 'NONE',
    issue: null,
    confidence: KNOWN_ISSUE_TIER_RULES.NONE.confidence,
    considered: live.length,
    expired,
    nearUnevaluable: unevaluable,
    disclosure: disclose('NONE', live.length, expired, unevaluable),
  };
}

const NEAR_UNEVALUABLE_NOTES = {
  NO_JOINED_CAUSES:
    'The broader match was not evaluated: no live known issue had its causes joined, so a moved signature would not have been noticed.',
  NO_ERROR_CLASS:
    'The broader match was not evaluated: this failure carries no error class, and two failures with no class are not evidence of a shared cause.',
  NO_TEST_IDS:
    'The broader match was not evaluated: the joined causes do not record which tests they fired on, and error class alone would mute every failure of that class.',
} as const satisfies Record<NearUnevaluableReason, string>;

/**
 * The sentence, built from this module's own prose and closed vocabularies
 * only.
 *
 * NOTHING ATTACKER-INFLUENCED REACHES IT. No error text, no signature, no test
 * name, no issue title — the title is human-written but it is also what ends up
 * in a tracker ticket, and a disclosure string that quoted it would be one more
 * place a quoted value could change the meaning of a sentence. Counts and
 * vocabulary members are the whole alphabet here.
 */
function disclose(
  tier: KnownIssueMatchTier,
  considered: number,
  expired: readonly ExpiredKnownIssue[],
  unevaluable: NearUnevaluableReason | null,
): string {
  const head =
    tier === 'EXACT'
      ? 'A known issue names this cause, so no verdict and no heal were bought for it.'
      : tier === 'NEAR'
        ? 'A known issue covers the same error class on this test under a different key. It does not suppress: the new key is proposed for the owner to adopt.'
        : considered === 0
          ? 'No known issue was in force for this project, so nothing was suppressed.'
          : `None of the ${considered} known issue(s) in force names this cause.`;

  const expiredNote =
    expired.length > 0
      ? ` ${expired.length} known issue(s) would have suppressed it and ${expired.length === 1 ? 'is' : 'are'} over — the failure is red again and the owner(s) are named.`
      : '';

  const unevaluableNote = unevaluable === null ? '' : ` ${NEAR_UNEVALUABLE_NOTES[unevaluable]}`;

  return `${head}${expiredNote}${unevaluableNote}`;
}

// ─── The decision: does the model call happen? ───────────────────────────────

/**
 * The exact key to add to a known issue, so a cause whose signature has moved
 * stops costing a model call every run.
 *
 * Deterministic and model-free. The key is the one the caller's own clusterer
 * produced for the failure in front of it; nothing here invents or edits a key,
 * and `createKnownIssueSchema`'s `^[0-9a-f]{12}$` is what finally accepts it.
 */
export interface SignatureAdoption {
  knownIssueId: string;
  /** The 12-hex key to add. */
  clusterKey: string;
  /** Why, in words the owner can act on. No failure text. */
  why: string;
}

export interface KnownIssueSuppressionDecision {
  /** Does this failure stop counting? TRUE only at the EXACT tier. */
  suppress: boolean;
  /**
   * Was the model call genuinely NOT made?
   *
   * A separate field from `suppress` on purpose, and the lesson behind it is
   * `houseStyle.planned`: "a mute applied" and "a call avoided" are two facts,
   * they are equal today at every tier, and the moment a caller suppresses a
   * failure while still buying a verdict for the record, a single field would
   * have to mean one thing where it is written and the other where it is read.
   */
  modelCallSkipped: boolean;
  tier: KnownIssueMatchTier;
  /** The issue to count this against, or null. */
  issueId: string | null;
  /** The near tier's output. Null at every other tier, and below the threshold. */
  adoption: SignatureAdoption | null;
  reason: string;
}

/**
 * Whether a cause is suppressed by a known issue, and whether the call happens.
 *
 * NO POLICY ARGUMENT, deliberately. An earlier shape took
 * `{ nearSuppresses?: boolean }`, and a knob that widens a mute from "the cause
 * somebody triaged" to "anything on this test that throws the same class" is a
 * knob somebody turns on during an outage and nobody turns off. The tier table
 * decides, and it is a compile-enforced record rather than a parameter.
 */
export function knownIssueSuppression(
  result: KnownIssueMatchResult,
  failure: FailureIdentity,
): KnownIssueSuppressionDecision {
  const rule = KNOWN_ISSUE_TIER_RULES[result.tier];

  if (result.tier === 'EXACT' && result.issue) {
    return {
      suppress: true,
      modelCallSkipped: true,
      tier: 'EXACT',
      issueId: result.issue.id,
      adoption: null,
      reason: rule.why,
    };
  }

  if (result.tier === 'NEAR' && result.issue) {
    const confident =
      result.confidence !== null && result.confidence > KNOWN_ISSUE_ADOPTION_MIN_CONFIDENCE;
    return {
      suppress: false,
      modelCallSkipped: false,
      tier: 'NEAR',
      // Counted against the issue even though it did not suppress: "this mute
      // nearly fired four times this week" is the fact that tells the owner
      // their signature has moved. `suppressionEventsFor` records it with
      // `suppressed: 0`, which is the honest number.
      issueId: result.issue.id,
      adoption: confident
        ? {
            knownIssueId: result.issue.id,
            clusterKey: failure.clusterKey,
            why:
              'This cause has the same error class on the same test as one this known issue already ' +
              'covers, under a different key — the signature moved, which any edit to the file can do. ' +
              'Adopting the key makes the mute cover it exactly; until then every run buys a fresh ' +
              'verdict for a cause you have already triaged.',
          }
        : null,
      reason: rule.why,
    };
  }

  return {
    suppress: false,
    modelCallSkipped: false,
    tier: 'NONE',
    issueId: null,
    adoption: null,
    reason: rule.why,
  };
}

// ─── The count ───────────────────────────────────────────────────────────────

/** The `KnownIssueMatch` row, and the counter bump that must share its transaction. */
export interface KnownIssueMatchWrite {
  knownIssueId: string;
  runId: string;
  /** One of the issue's `signatures` at the EXACT tier; the NEW key at NEAR. */
  clusterKey: string;
  occurrences: number;
  /**
   * The delta for `KnownIssue.matchCount`, which is a denormalised SUM of the
   * match rows. Written in the SAME transaction as the row above, or the
   * headline and the evidence disagree — and the headline is what decides
   * whether a mute gets renewed.
   */
  matchCountDelta: number;
}

/**
 * One `SuppressionEvent`, in the shape `suppressionEventSchema` accepts.
 *
 * Typed structurally rather than as the schema's inferred output so this module
 * does not import a zod schema to describe a row; the schema is what VALIDATES
 * it, and `known-issues.test.ts` ends its assertions at that validator rather
 * than at the spelling of these fields — a test that asserts a value's spelling
 * does not assert the value can be stored.
 */
export interface SuppressionEventWrite {
  projectId: string;
  runId: string;
  kind: SuppressionKind;
  targetScope: SuppressionTargetScope;
  targetKey: string;
  sourceId: string;
  /** Red things this silenced in this run. ZERO is a real answer, not a gap. */
  suppressed: number;
  inForce: boolean;
  reason: string;
  owner: OwnerRef;
  ownerState: 'OWNED';
  ownerProvenance: OwnerProvenance;
  expiresAt: Date;
}

/**
 * The ledger rows for one cause in one run.
 *
 * ONE EVENT PER CAUSE, and that is forced rather than chosen:
 * `SuppressionEvent` has `@@unique([runId, kind, targetKey])`, so two MUTE
 * events for one cluster key in one run is a constraint violation and not a
 * richer audit. The live match wins the row when there is one; otherwise the
 * expired issue that would have suppressed takes it, with `inForce: false` and
 * `suppressed: 0` — the row that PROVES the expiry worked, and the reason this
 * function is called even when nothing was suppressed.
 *
 * `reason` is COPIED from the issue, never composed. The schema caps it at
 * 2,000 characters and `createKnownIssueSchema` already enforced that ceiling
 * on the way in, so appending a sentence of our own here could push a legal row
 * over the limit — and the sentence belongs in `result.disclosure` anyway,
 * where no column bounds it.
 */
export function suppressionEventsFor(
  result: KnownIssueMatchResult,
  /**
   * The cause, so `targetKey` is the key of the FAILURE in front of us and not
   * a key picked out of the issue's list. On a multi-cause mute those differ,
   * and the ledger's whole job is to say WHICH cause fired.
   */
  failure: FailureIdentity,
  context: {
    projectId: string;
    runId: string;
    /** Failures this cause accounts for in this run. The thing being counted. */
    failures: number;
  },
): { match: KnownIssueMatchWrite | null; events: readonly SuppressionEventWrite[] } {
  if (result.issue !== null && result.tier !== 'NONE') {
    const suppressing = KNOWN_ISSUE_TIER_RULES[result.tier].maySuppress;
    const issue = result.issue;
    return {
      match: {
        knownIssueId: issue.id,
        runId: context.runId,
        clusterKey: failure.clusterKey,
        occurrences: context.failures,
        matchCountDelta: context.failures,
      },
      events: [
        {
          projectId: context.projectId,
          runId: context.runId,
          kind: 'MUTE',
          targetScope: 'SIGNATURE',
          targetKey: failure.clusterKey,
          sourceId: issue.id,
          // A near match silenced NOTHING. Reporting `context.failures` here
          // would claim a suppression that did not happen, which is the same
          // lie as a suppression that happened and was not counted.
          suppressed: suppressing ? context.failures : 0,
          inForce: true,
          reason: issue.reason,
          owner: issue.owner,
          ownerState: 'OWNED',
          ownerProvenance: issue.ownerProvenance,
          expiresAt: issue.expiresAt,
        },
      ],
    };
  }

  const over = result.expired[0];
  if (over === undefined) return { match: null, events: [] };

  return {
    match: null,
    events: [
      {
        projectId: context.projectId,
        runId: context.runId,
        kind: 'MUTE',
        targetScope: 'SIGNATURE',
        targetKey: failure.clusterKey,
        sourceId: over.id,
        suppressed: 0,
        inForce: false,
        reason: EXPIRED_LEDGER_REASON,
        owner: over.owner,
        ownerState: 'OWNED',
        ownerProvenance: over.ownerProvenance,
        expiresAt: over.expiresAt,
      },
    ],
  };
}

/**
 * The reason stamped on the row that proves an expiry worked.
 *
 * A CONSTANT, and not the expired issue's own reason: that reason explains why
 * the cause was muted, and this row's subject is the fact that it no longer is.
 * Copying the mute's reason onto it would make a reader think the suppression
 * still applied.
 */
export const EXPIRED_LEDGER_REASON =
  'A known issue that names this cause has expired or been revoked, so it suppressed nothing and the failure is red again.';

/**
 * The ENV_ISSUE-free tally for this kind, for the keystone's
 * `summariseSuppressions`.
 *
 * Produced here rather than summarised here: one module in this product writes
 * the sentence "47 failures suppressed by 3 known issues", and it is
 * `summariseSuppressions`. A second summariser would be a second chance for a
 * surface to say it differently.
 */
export function knownIssueTally(args: {
  /** Live issues that silenced at least one failure. */
  suppressions: number;
  suppressed: number;
  /** Issues that were over and silenced nothing. */
  expired: number;
}): SuppressionTally {
  return { kind: 'MUTE', ...args };
}

// ─── Heal supersession ───────────────────────────────────────────────────────

/**
 * What to do about a heal for a failure that is still failing.
 *
 * PAUSE_FOR_CHURN is the member worth reading twice. It is a BUDGET and not a
 * suppression — the test still fails and still gates, nothing goes quiet — so
 * it does not take an owner and an expiry the way a mute does. What it does
 * take, by rule, is a count and a reason: a cap that bites without being
 * disclosed is the dishonesty this codebase spends most of its comments on.
 */
export const HEAL_SUPERSESSION_ACTIONS = [
  /** Nothing open for this cause. Buy the call. */
  'PROPOSE_FIRST',
  /** An open proposal for this cause still applies. Hand it back; buy nothing. */
  'REUSE_OPEN',
  /** Open proposals for this cause are stale. Buy one, mark them superseded. */
  'SUPERSEDE_AND_PROPOSE',
  /** We have proposed this repeatedly and nobody has looked. Report instead. */
  'PAUSE_FOR_CHURN',
] as const;
export type HealSupersessionAction = (typeof HEAL_SUPERSESSION_ACTIONS)[number];

/**
 * How many superseded proposals for one test, with no human ever looking at
 * one, make the churn the finding.
 *
 * Three. Two is a coincidence — a test edited twice while a proposal was open
 * produces it honestly. Three is a pattern, and the pattern is worth more than
 * proposal four: "this test has had four proposals and nobody has opened one"
 * tells a team something actionable, where a fourth row tells them nothing they
 * did not already decline to read.
 */
export const HEAL_CHURN_FINDING_THRESHOLD = 3;

/**
 * An open heal proposal, as the caller's query returns it.
 *
 * `stillApplies` is DATA and not a function. The oracle is the applier
 * (`applyHealDiff`, packages/agent/src/heal-apply.ts) and `shouldProposeHeal`
 * already runs it; asking for the answer rather than the applier keeps this
 * module free of diff parsing, keeps the two guards from disagreeing about what
 * "applies" means, and keeps `child_process` and the ecosystem dialects out of
 * a decision that is otherwise pure comparison.
 */
export interface OpenHealProposal {
  id: string;
  /**
   * The cause this proposal answers — `TriageVerdict.clusterKey` of the verdict
   * it was made for.
   *
   * NULL for a row written before that column existed. A null is left alone
   * rather than recomputed, for the reason processors/triage.ts records about
   * the same column: re-deriving it would answer with TODAY's normalisation
   * rules, and guessing which cause an old proposal belonged to is invented
   * measurement.
   */
  causeKey: string | null;
  /** Does its diff still apply to the code in front of us? */
  stillApplies: boolean;
  /** When a human reviewed it. Null means nobody has. */
  reviewedAt: Date | null;
  createdAt: Date;
}

/**
 * "We keep proposing this and nobody is reviewing."
 *
 * REVERSIBLE WITHOUT A CLOCK AND WITHOUT A COLUMN: it is derived from the rows
 * every time, so one human review of any proposal for this test clears it on
 * the next run. There is nothing to expire and nothing to forget to expire,
 * which is the shape the keystone's expiry rule exists to force on things that
 * cannot be derived. This one can.
 */
export interface HealChurnFinding {
  testId: string;
  /** Superseded proposals for this test that no human ever opened. */
  supersededWithoutReview: number;
  /** The threshold that bit, reported so the number is not a mystery. */
  threshold: number;
  /** How it stops. One sentence, and it is true. */
  clearedBy: string;
  disclosure: string;
}

/**
 * The finding, or null.
 *
 * Null rather than a finding with a zero count: a caller collecting findings
 * must not have to filter the healthy ones out, and a list containing
 * "supersededWithoutReview: 0" entries is a list somebody will render.
 *
 * ONE REVIEW IS ENOUGH TO CLEAR IT, and that asymmetry is deliberate. The
 * finding's claim is "nobody is reviewing", so a single review refutes it
 * outright — continuing to report churn at a team that has started looking is
 * how a finding becomes noise, and a noisy finding gets the feature turned off.
 */
export function healChurnFinding(args: {
  testId: string;
  supersededWithoutReview: number;
  /** Proposals for this test a human has reviewed, ever. */
  reviewedEver: number;
}): HealChurnFinding | null {
  if (args.reviewedEver > 0) return null;
  if (args.supersededWithoutReview < HEAL_CHURN_FINDING_THRESHOLD) return null;
  return {
    testId: args.testId,
    supersededWithoutReview: args.supersededWithoutReview,
    threshold: HEAL_CHURN_FINDING_THRESHOLD,
    clearedBy:
      'Reviewing any proposal for this test — accept, reject, or apply — clears this and resumes proposing.',
    disclosure:
      `${args.supersededWithoutReview} heal proposals for this test have been superseded and nobody has ` +
      `opened one. Proposing has PAUSED rather than buying a ${args.supersededWithoutReview + 1}th: the ` +
      'test is still failing and still gates, and the fact worth acting on is that the review queue is ' +
      'not being read.',
  };
}

export interface HealSupersessionPlan {
  action: HealSupersessionAction;
  /** The proposal to hand back instead of minting. Null unless REUSE_OPEN. */
  reuseId: string | null;
  /** Proposals to mark SUPERSEDED — never delete. Oldest first. */
  supersedeIds: readonly string[];
  /** Was the strong-model call avoided? The cost fact, reported either way. */
  modelCallSkipped: boolean;
  /**
   * TRUE when open proposals carry no `causeKey`, so this decision could not
   * consider the cause at all.
   *
   * Its own field rather than folded into `reason`, because a caller that wants
   * to know whether the cause was considered must not have to parse prose — and
   * because "no open proposal for this cause" and "could not tell which cause
   * the open proposals were for" are facts a reader acts on differently.
   */
  causeUnknown: boolean;
  churn: HealChurnFinding | null;
  reason: string;
}

/**
 * Which heal to buy, reuse or supersede for THIS CAUSE on this test.
 *
 * ─── WHAT THE EXISTING GUARD GETS RIGHT, AND WHAT IT MISSES ────────────────
 *
 * `shouldProposeHeal` asks the only question that answers staleness without a
 * clock — does the diff still fit the bytes in front of us — and that stays the
 * oracle here (`stillApplies`). What it cannot see is WHICH CAUSE a proposal
 * answers, so on a test with two live causes the first proposal that still
 * applies answers for both: a reviewer is handed a selector fix as the answer
 * to an arithmetic bug, and the second cause never gets a proposal.
 *
 * So the lane is (test, cause) and not (test). Proposals for a DIFFERENT cause
 * are neither reused nor superseded — superseding them would throw away an
 * answer a person is entitled to see, which is the same mistake `planSupersede`
 * avoids across kinds.
 *
 * ─── AND A NULL CAUSE IS NOT A WILDCARD ────────────────────────────────────
 *
 * A proposal with no `causeKey` predates the column. It is eligible for REUSE —
 * handing back an existing fix that still applies is free and safe — and it is
 * NEVER superseded by a cause it cannot be shown to share, because "we do not
 * know which cause this answered" is not grounds for closing somebody's open
 * review.
 */
export function planHealSupersession(args: {
  testId: string;
  /** The cause the new proposal would answer. */
  causeKey: string;
  /** Open proposals for this test, same kind. The caller filters the lane. */
  open: readonly OpenHealProposal[];
  /** Superseded proposals for this test that no human opened. For the churn bound. */
  supersededWithoutReview: number;
  /** Proposals for this test a human has reviewed, ever. For the churn bound. */
  reviewedEver: number;
}): HealSupersessionPlan {
  const churn = healChurnFinding({
    testId: args.testId,
    supersededWithoutReview: args.supersededWithoutReview,
    reviewedEver: args.reviewedEver,
  });

  const sameCause = args.open.filter((p) => p.causeKey === args.causeKey);
  const unknownCause = args.open.filter((p) => p.causeKey === null);
  const causeUnknown = sameCause.length === 0 && unknownCause.length > 0;

  /*
   * REUSE BEATS THE PAUSE. Handing back a proposal that already exists and
   * still applies costs nothing, and the churn finding's complaint is about
   * BUYING proposals nobody reads — not about answering a question with work
   * already done. Checking reuse first also keeps the pause from hiding a
   * perfectly good open fix behind a finding.
   */
  const usable = [...sameCause, ...unknownCause]
    .filter((p) => p.stillApplies)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  if (usable) {
    return {
      action: 'REUSE_OPEN',
      reuseId: usable.id,
      // Everything else in the same lane that no longer applies. Not the other
      // causes' proposals, and not this one.
      supersedeIds: staleIds(sameCause, usable.id),
      modelCallSkipped: true,
      causeUnknown: usable.causeKey === null,
      churn,
      reason:
        `Proposal ${usable.id} is open and its diff still applies, so it is still the fix for this ` +
        'cause. Minting another would spend a strong-model call to put a near-duplicate in the same queue.',
    };
  }

  if (churn) {
    return {
      action: 'PAUSE_FOR_CHURN',
      reuseId: null,
      // Nothing is closed while paused. A superseded row with no replacement
      // would be a review somebody lost for a proposal that was never made.
      supersedeIds: [],
      modelCallSkipped: true,
      causeUnknown,
      churn,
      reason: churn.disclosure,
    };
  }

  const stale = staleIds(sameCause, null);
  if (stale.length > 0) {
    return {
      action: 'SUPERSEDE_AND_PROPOSE',
      reuseId: null,
      supersedeIds: stale,
      modelCallSkipped: false,
      causeUnknown,
      churn: null,
      reason:
        `${stale.length} open proposal(s) for this cause no longer apply — the file changed after they ` +
        'were made — so a fresh one is worth making and they are marked superseded rather than deleted.',
    };
  }

  return {
    action: 'PROPOSE_FIRST',
    reuseId: null,
    supersedeIds: [],
    modelCallSkipped: false,
    causeUnknown,
    churn: null,
    reason: causeUnknown
      ? 'No open proposal names this cause. Open proposals exist whose cause was never recorded; they are left alone rather than closed by a cause they cannot be shown to share.'
      : 'No open proposal for this cause.',
  };
}

/** Open proposals in the lane that no longer apply, oldest first, minus the keeper. */
function staleIds(lane: readonly OpenHealProposal[], keepId: string | null): string[] {
  return lane
    .filter((p) => p.id !== keepId && !p.stillApplies)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((p) => p.id);
}
