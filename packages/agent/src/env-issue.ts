/**
 * ENV_ISSUE — the fourth verdict, which led nowhere.
 *
 * ─── THE DEFECT THIS CLOSES ─────────────────────────────────────────────────
 *
 * Triage classifies a failure into four kinds and three of them go somewhere: a
 * REAL_BUG gates, an INTENDED_CHANGE goes to the Healer, a FLAKE goes to the
 * flake radar. ENV_ISSUE went NOWHERE (apps/worker/src/processors/triage.ts).
 * So a board red because a credential expired at 02:00 looked EXACTLY like a
 * board red because checkout broke — same colour, same gate, same page — and
 * that is precisely how a team learns to ignore the board.
 *
 * What was missing is not the classification. It is the four things that have to
 * follow it: a way to tell a broken environment from a broken product without
 * asking a model; a retry for the transient case; suppression of the GATE for a
 * genuine environment failure; and an ALERT to the owner, because an expired
 * credential is real work for a human — just not the work a regression implies.
 *
 * ─── THE ATTACK ON THIS FEATURE, AND THE DEFENCE ───────────────────────────
 *
 * ENV_ISSUE must be IMPOSSIBLE to use as a way to make real failures disappear.
 * That is not a malicious-insider scenario; it is the easy mistake. A model
 * returns ENV_ISSUE with 0.9 confidence for a 500 that is genuinely the
 * application's fault, and if the model's word were enough, the whole run's
 * gate would come off and the suite would go quiet while the product was
 * broken.
 *
 * So the model's word is NOT enough, structurally rather than by convention:
 *
 *   {@link envIssueSuppression} cannot be called without an
 *   {@link EnvironmentEvidence}, and the only way to obtain one is
 *   {@link classifyEnvironment} returning BROKEN from checks. There is no
 *   object literal path to the type — it carries a private witness symbol, the
 *   same device `FencedBlock` uses in packages/agent/src/untrusted.ts. A
 *   healthy environment therefore cannot produce an ENV_ISSUE suppression: not
 *   because a function declines to, but because the value the function needs
 *   does not exist.
 *
 * And the suppression it produces is RUN-SCOPED by the keystone's own rule
 * (`SUPPRESSION_KIND_RULES.ENV_ISSUE`), so it cannot silence a second run. The
 * environment failing today is not a licence to be quiet tomorrow.
 *
 * ─── THE HONESTY RULES ──────────────────────────────────────────────────────
 *
 *  · COUNTED AND VISIBLE. Every ENV_ISSUE suppression produces a
 *    `SuppressionEvent` and a tally that `summariseSuppressions` turns into the
 *    sentence. ENV_ISSUE is the one kind nobody clicks, which makes it the one
 *    kind that would otherwise have no owner, no expiry and no count — the
 *    exact combination the keystone's file exists to prevent.
 *  · THE COVERAGE NUMBER IS NULL, NOT ZERO. A run whose environment never came
 *    up measured NOTHING. Reporting 0% would be a drop a team would chase, and
 *    it would be a measurement nobody took. {@link coverageForEnvIssueRun}
 *    returns null and says why.
 *  · UNKNOWN IS A VERDICT. "We could not tell whether the environment was the
 *    problem" is a third answer, and it does not suppress. A pass that means
 *    "we did not check" is the lie this product cannot afford.
 *
 * ─── NO CREDENTIAL REACHES ANY OUTPUT ──────────────────────────────────────
 *
 * This module touches the one subject where a leak is likely: auth probes. So
 * every string it emits is either its own prose, a closed vocabulary member, or
 * a bounded `detail` that {@link safeDetail} has already refused if it carries a
 * location or a named secret. `probeBaseUrl` in packages/runner/src/preflight.ts
 * promises "failure class, never the URL — a base URL can carry a token in a
 * query"; this is the guard that holds callers who are not that careful to the
 * same promise, and it REFUSES rather than truncating, because a truncated
 * token is still a token.
 *
 * ─── NO MODEL, NO NETWORK ───────────────────────────────────────────────────
 *
 * {@link classifyEnvironment} is a fold over a list. {@link probeEnvironment}
 * takes its probes as an INJECTED narrow interface it defines — never a
 * top-level `fetch` — so the whole path is unit-testable with no network and no
 * key. `packages/runner/src/preflight.ts` (which the MEASURE round DID land,
 * and which this module deliberately does not import: `@qaai/agent` has no
 * dependency on `@qaai/runner`) produces `PreflightCheck` values whose shape
 * {@link EnvCheck} mirrors field for field, so the worker adapts rather than
 * re-probes.
 */

/*
 * The keystone's suppression vocabulary. `applySuppression` is the ONLY
 * constructor of a Suppression and this module asks it rather than building
 * one, so an ENV_ISSUE suppression is checked by the same code as every other
 * kind — including the owner and expiry it must have to exist at all.
 */
import { applySuppression, SUPPRESSION_KIND_RULES } from '@qaai/shared';
import type {
  DenominatorEffect,
  SuppressionDecision,
} from '@qaai/shared';
import { mayPage } from '@qaai/shared';
import type { OwnerProvenance } from '@qaai/shared';
import type { OwnerRef } from '@qaai/shared';

// ─── What a check is ─────────────────────────────────────────────────────────

/**
 * The checks that can say "the environment, not the product".
 *
 * Deliberately the same four names as `PreflightCheckName` in
 * packages/runner/src/preflight.ts. Two vocabularies for one idea is two
 * chances to disagree about what a dead base URL means, and the worker's
 * adapter is a rename away from being a cast.
 */
export const ENV_CHECK_NAMES = ['BASE_URL', 'LOGIN', 'REPO_WORKSPACE', 'TOOLING'] as const;
export type EnvCheckName = (typeof ENV_CHECK_NAMES)[number];

/**
 * Mirrors `PreflightOutcome`.
 *
 * UNKNOWN is the member that carries the weight. It is NOT a soft UNAVAILABLE:
 * an unknown answer blocks nothing and suppresses nothing, by rule, because
 * "the probe could not run" and "the target is down" are opposite facts about
 * who has work to do.
 */
export const ENV_CHECK_OUTCOMES = ['OK', 'UNAVAILABLE', 'UNKNOWN'] as const;
export type EnvCheckOutcome = (typeof ENV_CHECK_OUTCOMES)[number];

/** Whether a check's failure is the environment's fault, and whether it is transient. */
export interface EnvCheckRule {
  /**
   * Does UNAVAILABLE on this check mean the environment is broken?
   *
   * TRUE for all four, and the reasoning differs per check rather than being a
   * blanket yes: a dead base URL, an invalid login and a missing toolchain all
   * mean the run proved nothing about the application. REPO_WORKSPACE is the
   * one worth questioning — a missing checkout is QAAI's own plumbing — and it
   * is in for the same reason: the tests did not run, so the product was not
   * measured.
   */
  readonly environmental: boolean;
  /**
   * May a retry fix it?
   *
   * BASE_URL yes — a deploy mid-rollout answers 502 for thirty seconds. LOGIN
   * no: an expired credential is still expired in four seconds, and retrying a
   * rejected login is how an account gets locked. TOOLING and REPO_WORKSPACE no
   * — a missing python3 does not arrive on its own.
   */
  readonly retryable: boolean;
  readonly why: string;
}

/**
 * The compiler-enforced presence record. A fifth check name is a type error
 * here, where the decision about whether it is environmental has to be made,
 * rather than a check whose failure silently gates nothing.
 */
export const ENV_CHECK_RULES = {
  BASE_URL: {
    environmental: true,
    retryable: true,
    why: 'The application under test did not answer, so the run observed nothing about it. A deploy mid-rollout answers this way for seconds, so a retry is worth one attempt.',
  },
  LOGIN: {
    environmental: true,
    retryable: false,
    why: 'Authentication failed, so every test that needed an identity failed for the same reason. NOT retried: an expired credential is still expired in four seconds, and retrying a rejected login is how an account gets locked out.',
  },
  REPO_WORKSPACE: {
    environmental: true,
    retryable: false,
    why: "QAAI's own checkout was missing, so the tests were never materialised. Nothing about the product was measured.",
  },
  TOOLING: {
    environmental: true,
    retryable: false,
    why: 'A required toolchain was absent, so the tests of that type could not be compiled or executed. A missing interpreter does not arrive on its own.',
  },
} as const satisfies Record<EnvCheckName, EnvCheckRule>;

export interface EnvCheck {
  name: EnvCheckName;
  outcome: EnvCheckOutcome;
  /**
   * One sentence, a failure CLASS and never a location.
   *
   * Passed through {@link safeDetail} before it reaches any output. See the
   * module header: a base URL can carry a token in a query string.
   */
  detail: string;
}

// ─── Refusing a detail that carries a secret ─────────────────────────────────

/** What this module puts in place of a detail it refused. A constant. */
export const DETAIL_REFUSED =
  'withheld: this detail named a location or a credential, which a failure class must not';

/** The ceiling on a detail. An unbounded detail is a body, and a body hides things. */
export const ENV_DETAIL_MAX_CHARS = 300;

/**
 * Names that make a `key=value` fragment a credential rather than a fact.
 *
 * A closed, short list on purpose. A general secret detector is a heuristic
 * that produces false confidence in both directions; these five are the ones
 * that actually appear in a base URL or an auth header, and `http=503` — which
 * the clusterer's own signatures contain — is deliberately not among them.
 */
const SECRET_NAMES = /\b(?:authorization|bearer|token|password|secret|api[_-]?key)\b/i;

/** A location. `://` is the shape that carries a query string, and a query carries tokens. */
const CARRIES_LOCATION = /:\/\//;

/**
 * A detail that is safe to render, and the fact that it was changed.
 *
 * REFUSES rather than redacting the offending span. A redaction implies the
 * rest of the string was examined and found clean, and a truncated token is
 * still a token; replacing the whole detail with a constant is the only
 * statement this function can make honestly. Both the refusal and the
 * truncation are REPORTED — a cap that bit without being disclosed is the
 * dishonesty this file's siblings are full of comments about.
 */
export function safeDetail(detail: string): {
  detail: string;
  refused: boolean;
  truncated: boolean;
} {
  if (CARRIES_LOCATION.test(detail) || SECRET_NAMES.test(detail)) {
    return { detail: DETAIL_REFUSED, refused: true, truncated: false };
  }
  if (detail.length > ENV_DETAIL_MAX_CHARS) {
    return {
      detail: `${detail.slice(0, ENV_DETAIL_MAX_CHARS)}… (${detail.length - ENV_DETAIL_MAX_CHARS} more characters not shown)`,
      refused: false,
      truncated: true,
    };
  }
  return { detail, refused: false, truncated: false };
}

// ─── The verdict ─────────────────────────────────────────────────────────────

/**
 * Was it the environment?
 *
 * Three members, and UNKNOWN is not a lesser BROKEN. It is the answer when
 * nothing was checked, or when every check that could have told us returned
 * UNKNOWN itself, and it suppresses NOTHING — see the module header.
 */
export const ENVIRONMENT_VERDICTS = ['HEALTHY', 'BROKEN', 'UNKNOWN'] as const;
export type EnvironmentVerdict = (typeof ENVIRONMENT_VERDICTS)[number];

/**
 * The witness for {@link EnvironmentEvidence}. Module-private and never
 * exported, so it exists at RUN TIME as well as at compile time: the property
 * is genuinely on the object, no other module can name the key, and a cast
 * cannot manufacture one that `classifyEnvironment` did not make. Same device
 * and same reasoning as `FENCED_WITNESS` in untrusted.ts — a declare-only
 * symbol would have been a compile-time rule with nothing behind it.
 */
const ENV_EVIDENCE_WITNESS: unique symbol = Symbol('qaai.env-issue.measured-broken');

/**
 * Proof that the environment was MEASURED to be broken.
 *
 * THE WITNESS IS THE WHOLE POINT. `envIssueSuppression` takes this type, and
 * the private symbol means no caller can write one as an object literal — the
 * only producer is {@link classifyEnvironment}, and it only produces one when
 * the checks say BROKEN. So "a model said ENV_ISSUE, therefore the gate comes
 * off" is not a path that exists, and a healthy environment cannot be made to
 * yield a suppression by any argument a caller can construct.
 *
 * Same device as `FencedBlock` in untrusted.ts, for the same reason: a rule
 * that a type system enforces cannot be forgotten by the next caller.
 */
export interface EnvironmentEvidence {
  readonly [ENV_EVIDENCE_WITNESS]: true;
  /** BROKEN, always. The type exists only for that case. */
  readonly verdict: 'BROKEN';
  /** The checks that were UNAVAILABLE and environmental. At least one. */
  readonly failed: readonly EnvCheck[];
  /** Every check considered, so a reader can see what was NOT the problem. */
  readonly considered: readonly EnvCheck[];
  /** May a retry fix this? True only when every failed check is retryable. */
  readonly retryable: boolean;
}

export interface EnvironmentClassification {
  verdict: EnvironmentVerdict;
  /** Present only when `verdict` is BROKEN. The key to the suppression path. */
  evidence: EnvironmentEvidence | null;
  /** Checks that came back UNAVAILABLE and environmental. */
  failed: readonly EnvCheck[];
  /** Checks that could not answer. Counted, because they are the UNKNOWN case. */
  unknown: readonly EnvCheck[];
  /** Details this module refused because they named a location or a credential. */
  detailsRefused: number;
  /** Details this module truncated, with the cap disclosed. */
  detailsTruncated: number;
  disclosure: string;
}

/**
 * The environment's verdict from its checks. The deterministic, model-free path
 * — and the only producer of {@link EnvironmentEvidence}.
 *
 * THE THREE ARMS, and why the boundaries are where they are:
 *
 *  · BROKEN needs at least one UNAVAILABLE check whose rule is environmental.
 *    One is enough: a dead base URL alone means nothing about the application
 *    was observed.
 *  · UNKNOWN when nothing was checked, or when nothing is UNAVAILABLE and at
 *    least one check is UNKNOWN. An OK on three checks and an UNKNOWN on the
 *    fourth is NOT a clean bill of health — the fourth is the one that would
 *    have told us.
 *  · HEALTHY only when every check answered and every answer was OK. That is
 *    the strictest of the three readings and it is the right one: HEALTHY is
 *    the arm that lets a failure gate, so it must be the arm that is hardest to
 *    reach by accident.
 *
 * Details are passed through {@link safeDetail} HERE rather than at the output,
 * so no path can render an unchecked one — a guard at the render site is a
 * guard the second render site forgets.
 */
export function classifyEnvironment(checks: readonly EnvCheck[]): EnvironmentClassification {
  let detailsRefused = 0;
  let detailsTruncated = 0;
  const safe = checks.map((check) => {
    const cleaned = safeDetail(check.detail);
    if (cleaned.refused) detailsRefused += 1;
    if (cleaned.truncated) detailsTruncated += 1;
    return { ...check, detail: cleaned.detail };
  });

  const failed = safe.filter(
    (check) => check.outcome === 'UNAVAILABLE' && ENV_CHECK_RULES[check.name].environmental,
  );
  const unknown = safe.filter((check) => check.outcome === 'UNKNOWN');

  const counts = { detailsRefused, detailsTruncated };

  if (failed.length > 0) {
    const retryable = failed.every((check) => ENV_CHECK_RULES[check.name].retryable);
    const evidence: EnvironmentEvidence = {
      [ENV_EVIDENCE_WITNESS]: true,
      verdict: 'BROKEN',
      failed,
      considered: safe,
      retryable,
    };
    return {
      verdict: 'BROKEN',
      evidence,
      failed,
      unknown,
      ...counts,
      disclosure:
        `The environment failed ${failed.length} of ${safe.length} check(s) ` +
        `(${failed.map((c) => c.name).join(', ')}), so this run proved nothing about the application. ` +
        (retryable
          ? 'A retry may fix it.'
          : 'A retry will not fix it — this needs a person.') +
        disclosureTail(counts),
    };
  }

  if (safe.length === 0 || unknown.length > 0) {
    return {
      verdict: 'UNKNOWN',
      evidence: null,
      failed,
      unknown,
      ...counts,
      disclosure:
        (safe.length === 0
          ? 'The environment was not checked, so whether it was the cause is unknown.'
          : `${unknown.length} of ${safe.length} environment check(s) could not answer (${unknown
              .map((c) => c.name)
              .join(', ')}), so whether the environment was the cause is unknown.`) +
        ' Nothing is suppressed on an unknown: a gate that came off because a probe failed would be a pass that means nobody checked.' +
        disclosureTail(counts),
    };
  }

  return {
    verdict: 'HEALTHY',
    evidence: null,
    failed,
    unknown,
    ...counts,
    disclosure:
      `All ${safe.length} environment check(s) passed, so a failure in this run is about the ` +
      'application and gates normally.' +
      disclosureTail(counts),
  };
}

function disclosureTail(counts: { detailsRefused: number; detailsTruncated: number }): string {
  const parts: string[] = [];
  if (counts.detailsRefused > 0) {
    parts.push(
      `${counts.detailsRefused} check detail(s) were withheld for naming a location or a credential`,
    );
  }
  if (counts.detailsTruncated > 0) {
    parts.push(
      `${counts.detailsTruncated} check detail(s) were cut to ${ENV_DETAIL_MAX_CHARS} characters`,
    );
  }
  return parts.length === 0 ? '' : ` ${parts.join('; ')}.`;
}

// ─── Probing ─────────────────────────────────────────────────────────────────

/**
 * How this module reaches the world. INJECTED, and narrow.
 *
 * No top-level `fetch`, no `child_process`: 629 lines of crawler.ts had almost
 * no tests for exactly that reason. Each method answers ONE of the three
 * questions the register names — is the target reachable, is auth valid, is the
 * dependency up — and each returns a classified answer rather than a response,
 * so an implementation cannot hand this module a body to parse.
 *
 * Every method is OPTIONAL and an absent one produces an UNKNOWN check, not an
 * OK. That is the shape that makes "we did not look" impossible to confuse with
 * "it was fine".
 */
export interface EnvProbeIo {
  /** Did the application answer? A 500 answers; a refused connection does not. */
  reachTarget?: () => Promise<{ reached: boolean; detail: string }>;
  /** Is the stored session still usable? */
  checkAuth?: () => Promise<{ valid: boolean; detail: string }>;
  /** Named dependencies and whether each is up. */
  checkDependencies?: () => Promise<ReadonlyArray<{ name: string; up: boolean; detail: string }>>;
}

/**
 * Probe, then classify.
 *
 * A thin adapter on purpose: all the judgement is in
 * {@link classifyEnvironment}, which is a fold over data, so the probes can be
 * swapped for the worker's real preflight output without changing a decision.
 *
 * A THROWING PROBE PRODUCES UNKNOWN, NOT UNAVAILABLE. A probe that blew up told
 * us about the probe, not about the environment — and treating it as a failure
 * would be a path from "our code crashed" to "the gate comes off", which is the
 * attack this module is built against arriving by accident.
 */
export async function probeEnvironment(io: EnvProbeIo): Promise<EnvironmentClassification> {
  const checks: EnvCheck[] = [];

  checks.push(
    await oneCheck('BASE_URL', io.reachTarget, (r) => ({
      outcome: r.reached ? 'OK' : 'UNAVAILABLE',
      detail: r.detail,
    })),
  );
  checks.push(
    await oneCheck('LOGIN', io.checkAuth, (r) => ({
      outcome: r.valid ? 'OK' : 'UNAVAILABLE',
      detail: r.detail,
    })),
  );
  checks.push(
    await oneCheck('TOOLING', io.checkDependencies, (rows) => {
      const down = rows.filter((row) => !row.up);
      return {
        outcome: down.length === 0 ? 'OK' : 'UNAVAILABLE',
        detail:
          down.length === 0
            ? `${rows.length} dependency(ies) up`
            : // The NAMES only. A dependency's own detail is its implementer's
              // text and `safeDetail` will see it, but a list of names is all
              // this sentence needs and the narrowest thing it can carry.
              `${down.length} of ${rows.length} dependency(ies) down: ${down.map((d) => d.name).join(', ')}`,
      };
    }),
  );

  return classifyEnvironment(checks);
}

async function oneCheck<T>(
  name: EnvCheckName,
  probe: (() => Promise<T>) | undefined,
  read: (value: T) => { outcome: EnvCheckOutcome; detail: string },
): Promise<EnvCheck> {
  if (!probe) {
    return {
      name,
      outcome: 'UNKNOWN',
      detail: 'no probe was supplied for this check, so it was not performed',
    };
  }
  try {
    const value = await probe();
    const { outcome, detail } = read(value);
    return { name, outcome, detail };
  } catch {
    /*
     * The error object is deliberately NOT read. An exception from a network
     * client carries the URL it was opening, and a base URL can carry a token
     * in a query string — `safeDetail` would refuse it, and not quoting it in
     * the first place is better than relying on a guard to catch it.
     */
    return {
      name,
      outcome: 'UNKNOWN',
      detail: 'the probe threw, so this check did not answer',
    };
  }
}

// ─── Retrying the transient case ─────────────────────────────────────────────

/**
 * How many times a retryable environment failure is retried.
 *
 * Two, which is one retry. A deploy answering 502 is over in seconds; an
 * environment that is still down on the second look is down, and a third
 * attempt buys a worker slot's time to learn nothing. The same number as
 * `PREFLIGHT_PROBE_ATTEMPTS`'s intent, chosen here for the retry rather than
 * for the probe.
 */
export const ENV_RETRY_MAX_ATTEMPTS = 2;

/** How long to wait before the retry. Fixed, not exponential: there is one. */
export const ENV_RETRY_DELAY_MS = 5_000;

export interface EnvRetryDecision {
  retry: boolean;
  delayMs: number;
  /** Attempts left after this decision. Reported so the cap is never a mystery. */
  attemptsRemaining: number;
  reason: string;
}

/**
 * Retry, or stop and say why.
 *
 * Takes the CLASSIFICATION and not a verdict string, so a caller cannot ask for
 * a retry on a healthy environment by naming one — and the two non-BROKEN arms
 * both refuse, for different reasons that are both reported.
 *
 * `attempt` is 1-based and is what the caller has already done. The cap is
 * reported as a count AND a reason whenever it bites, because a retry budget
 * that runs out silently looks exactly like a decision not to retry.
 */
export function envRetryDecision(
  classification: EnvironmentClassification,
  attempt: number,
): EnvRetryDecision {
  const remaining = Math.max(0, ENV_RETRY_MAX_ATTEMPTS - attempt);

  if (classification.verdict === 'HEALTHY') {
    return {
      retry: false,
      delayMs: 0,
      attemptsRemaining: remaining,
      reason:
        'The environment is healthy, so the failure is about the application. Re-running it would be a retry of a real failure, which is how a regression gets mistaken for a flake.',
    };
  }
  if (classification.verdict === 'UNKNOWN' || classification.evidence === null) {
    return {
      retry: false,
      delayMs: 0,
      attemptsRemaining: remaining,
      reason:
        'Whether the environment was the cause is unknown, and an unknown is not grounds for spending another run. The checks that could not answer are named.',
    };
  }
  if (!classification.evidence.retryable) {
    const names = classification.evidence.failed.map((c) => c.name).join(', ');
    return {
      retry: false,
      delayMs: 0,
      attemptsRemaining: remaining,
      reason: `${names} does not fix itself — a retry would fail the same way. This needs a person.`,
    };
  }
  if (remaining <= 0) {
    return {
      retry: false,
      delayMs: 0,
      attemptsRemaining: 0,
      reason: `The retry budget of ${ENV_RETRY_MAX_ATTEMPTS} attempt(s) is spent and the environment is still failing, so this is reported as an environment failure rather than retried again.`,
    };
  }
  return {
    retry: true,
    delayMs: ENV_RETRY_DELAY_MS,
    attemptsRemaining: remaining,
    reason: `Attempt ${attempt} of ${ENV_RETRY_MAX_ATTEMPTS}: the failed check(s) can pass on a retry, and a deploy mid-rollout answers this way for seconds.`,
  };
}

// ─── Suppressing the gate ────────────────────────────────────────────────────

/**
 * Why an ENV_ISSUE suppression was refused.
 *
 * A closed vocabulary rather than prose, matching `SUPPRESSION_REFUSALS`: the
 * API returns these and a test can assert on them, where a sentence assembled
 * at the refusal site is a refusal no test can pin.
 */
export const ENV_ISSUE_REFUSALS = [
  /** The checks say the environment is fine. The attack this feature must survive. */
  'ENVIRONMENT_HEALTHY',
  /** Nothing could be measured, so nothing is suppressed. */
  'ENVIRONMENT_UNKNOWN',
  /** No failures to suppress. A suppression of nothing is a row that overstates itself. */
  'NOTHING_TO_SUPPRESS',
  /** The keystone's own constructor refused it; its refusal is carried verbatim. */
  'SUPPRESSION_REFUSED',
] as const;
export type EnvIssueRefusal = (typeof ENV_ISSUE_REFUSALS)[number];

export interface EnvIssueSuppressed {
  suppressed: true;
  /** The keystone's value — run-scoped, counted, with an expiry it cannot outlive. */
  decision: SuppressionDecision;
  /** Failures whose gate came off. The number the ledger records. */
  failures: number;
  /**
   * What this does to the coverage denominator: STAYS_COUNTED, derived from the
   * kind by the keystone and never stored beside the row.
   *
   * Carried so a caller cannot accidentally treat an environment failure as a
   * reason a surface left the measurement. The run measured nothing; the
   * application still has every surface it had.
   */
  denominator: DenominatorEffect;
  alert: EnvironmentAlert;
  disclosure: string;
}

export interface EnvIssueRefused {
  suppressed: false;
  refusal: EnvIssueRefusal;
  /** The PATH of the offending field, never a message built from its value. */
  path: string;
  reason: string;
}

export type EnvIssueDecision = EnvIssueSuppressed | EnvIssueRefused;

/**
 * Take the gate off a run whose environment failed, and tell the owner.
 *
 * THE SIGNATURE IS THE SECURITY PROPERTY. `evidence` is an
 * {@link EnvironmentEvidence}, which only {@link classifyEnvironment} can mint
 * and only for a BROKEN verdict — so there is no argument list a caller can
 * assemble that suppresses a healthy environment's failures. The three refusals
 * below are the belt to that braces: they catch a caller who has an old
 * evidence value, or none.
 *
 * The suppression itself is built by `applySuppression`, never by hand. That is
 * what makes it RUN-SCOPED (so it cannot silence a second run), stamped with an
 * expiry it cannot outlive, and counted — the three things the one kind nobody
 * clicks would otherwise lack.
 */
export function envIssueSuppression(args: {
  evidence: EnvironmentEvidence;
  classification: EnvironmentClassification;
  /** The run. ENV_ISSUE is keyed on it: this cannot reach a second run. */
  runId: string;
  /** Failures in this run whose gate comes off. */
  failures: number;
  /**
   * Who to tell. ENV_ISSUE is the one kind that does not require a human owner
   * (`SUPPRESSION_KIND_RULES.ENV_ISSUE.requiresHumanOwner` is false) because
   * nobody signs it — it is bounded by its RUN scope instead. An owner is still
   * taken when one is known, because an expired credential is work for a
   * person.
   */
  owner: OwnerRef | null;
  ownerProvenance: OwnerProvenance;
  now: Date;
}): EnvIssueDecision {
  if (args.classification.verdict === 'HEALTHY') {
    return {
      suppressed: false,
      refusal: 'ENVIRONMENT_HEALTHY',
      path: 'classification.verdict',
      reason:
        'The environment checks all passed, so these failures are about the application and they gate. ENV_ISSUE cannot be used to make a real failure disappear.',
    };
  }
  if (args.classification.verdict === 'UNKNOWN' || args.classification.evidence === null) {
    return {
      suppressed: false,
      refusal: 'ENVIRONMENT_UNKNOWN',
      path: 'classification.verdict',
      reason:
        'Whether the environment was the cause could not be measured, and an unmeasured environment does not take a gate off. The failures stay red.',
    };
  }
  if (args.failures <= 0) {
    return {
      suppressed: false,
      refusal: 'NOTHING_TO_SUPPRESS',
      path: 'failures',
      reason:
        'The environment failed and no failure was suppressed, so there is nothing to record. A suppression row claiming zero would overstate what happened.',
    };
  }

  const decision = applySuppression(
    {
      kind: 'ENV_ISSUE',
      target: { scope: 'RUN', key: args.runId },
      /*
       * OUR OWN PROSE plus check NAMES from a closed vocabulary. The checks'
       * `detail` strings are not interpolated: they have been through
       * `safeDetail`, and a reason column is still the wrong place for text
       * whose author is somebody else's error handler.
       */
      reason:
        `The environment failed ${args.evidence.failed.length} check(s) ` +
        `(${args.evidence.failed.map((c) => c.name).join(', ')}), so this run observed nothing about ` +
        'the application. The failures are recorded and counted; they do not gate.',
      owner: args.owner,
      ownerProvenance: args.ownerProvenance,
      // Run-scoped: `applySuppression` REFUSES a date here and stamps a bound
      // the run cannot outlive. Passing one would be a caller that has
      // misunderstood the kind, which is exactly what it refuses.
      expiresAt: null,
      // Checked against the kind's own rule rather than trusted. An environment
      // failure must never remove a surface from the measurement.
      expectedDenominator: 'STAYS_COUNTED',
    },
    args.now,
  );

  if (!decision.applied) {
    return {
      suppressed: false,
      refusal: 'SUPPRESSION_REFUSED',
      path: decision.path,
      reason: `The suppression was refused: ${decision.refusal}.`,
    };
  }

  return {
    suppressed: true,
    decision,
    failures: args.failures,
    denominator: SUPPRESSION_KIND_RULES.ENV_ISSUE.denominator,
    alert: environmentAlert({
      classification: args.classification,
      evidence: args.evidence,
      runId: args.runId,
      failures: args.failures,
      owner: args.owner,
      ownerProvenance: args.ownerProvenance,
    }),
    disclosure:
      `${args.failures} failure(s) did not gate because the environment failed: ` +
      `${args.evidence.failed.map((c) => c.name).join(', ')}. They are still failures that happened, ` +
      'this suppression expires with the run, and the coverage number for this run is UNAVAILABLE ' +
      'rather than zero.',
  };
}

// ─── Telling the owner ───────────────────────────────────────────────────────

/**
 * The alert for an environment failure.
 *
 * It exists because of what an ENV_ISSUE actually is: real work for a human,
 * just not the work a regression implies. A board that silently stops gating
 * and tells nobody has turned a loud wrong signal into a quiet wrong signal,
 * which is worse.
 *
 * `subject` IS COMPOSED FROM QAAI'S OWN RECORDS ONLY — the run id and check
 * names from a closed vocabulary. Nothing a test's output, a page's text or a
 * model wrote can change what it says or who it reaches, which is the rule for
 * anything that leaves this product.
 */
export interface EnvironmentAlert {
  /** A one-line subject. No borrowed text. */
  subject: string;
  /** The checks that failed, by name. The closed vocabulary. */
  failedChecks: readonly EnvCheckName[];
  /** Already through {@link safeDetail}; render verbatim. */
  evidence: readonly string[];
  owner: OwnerRef | null;
  ownerProvenance: OwnerProvenance;
  /**
   * May this alert page somebody?
   *
   * `mayPage` from the keystone: a glob may route a failure, it may not wake
   * somebody at 3am. A WEAK provenance produces an alert that is DELIVERED and
   * not PAGED, and the difference is reported rather than being a silent
   * downgrade.
   */
  mayPage: boolean;
  /** Why this is not a regression, in words. */
  body: string;
}

export function environmentAlert(args: {
  classification: EnvironmentClassification;
  evidence: EnvironmentEvidence;
  runId: string;
  failures: number;
  owner: OwnerRef | null;
  ownerProvenance: OwnerProvenance;
}): EnvironmentAlert {
  const failedChecks = args.evidence.failed.map((c) => c.name);
  return {
    subject: `Environment failure on run ${args.runId}: ${failedChecks.join(', ')}`,
    failedChecks,
    evidence: args.evidence.failed.map((c) => `${c.name}: ${c.detail}`),
    owner: args.owner,
    ownerProvenance: args.ownerProvenance,
    // No owner means nobody to page, whatever the provenance claims.
    mayPage: args.owner !== null && mayPage(args.ownerProvenance),
    body:
      `${args.failures} test(s) failed in run ${args.runId} and none of them gates, because the ` +
      `environment did not come up: ${failedChecks
        .map((name) => `${name} — ${ENV_CHECK_RULES[name].why}`)
        .join(' ')} ` +
      'This is not a regression and the tests are not at fault. Nothing about the application was ' +
      'measured in this run, so its coverage number is UNAVAILABLE rather than lower.',
  };
}

// ─── The coverage number for a run that measured nothing ─────────────────────

export interface EnvIssueCoverage {
  /**
   * NULL. Never 0.
   *
   * A run whose environment never came up measured nothing, and 0% is a
   * measurement. A team watching a coverage trend would see a cliff and go
   * looking for deleted tests; the honest value is the absence of one. This is
   * the same rule `overrideRatePercent` follows in triage.ts and
   * `verifyState: UNVERIFIABLE` follows in healer.ts: "we could not look" and
   * "it was bad" must never be the same value.
   */
  percent: null;
  /**
   * The denominator effect, derived from the kind. STAYS_COUNTED: the
   * application still has every surface it had, and nothing left the
   * measurement.
   */
  denominator: DenominatorEffect;
  reason: string;
}

/**
 * The coverage a run suppressed by ENV_ISSUE reports.
 *
 * A function rather than a constant so the reason can name the checks, and so a
 * caller writing a coverage snapshot has something to CALL — a comment saying
 * "remember to write null here" is the shape of rule nobody follows.
 */
export function coverageForEnvIssueRun(evidence: EnvironmentEvidence): EnvIssueCoverage {
  return {
    percent: null,
    denominator: SUPPRESSION_KIND_RULES.ENV_ISSUE.denominator,
    reason:
      `UNAVAILABLE, not 0%: the environment failed ${evidence.failed
        .map((c) => c.name)
        .join(', ')}, so this run executed nothing and measured nothing. The surfaces are all still ` +
      'in the denominator — the application has not changed, only our ability to look at it.',
  };
}

// ─── The count, and why it is not computed here ──────────────────────────────

/*
 * ── THERE WAS AN `envIssueTally` HERE, AND IT IS GONE ─────────────────────────
 *
 * It built the ENV_ISSUE `SuppressionTally` for `summariseSuppressions` from
 * `{ runs, suppressed }`, so that "the board was quiet because the environment
 * was down nine times this week" could be a sentence rather than an
 * impression. That sentence is still produced — and it was never produced by
 * this function, which had no caller anywhere in the product. Its only
 * reference was its own test.
 *
 * The reason it was redundant is a deliberate choice made at the WRITER rather
 * than a coincidence: `envIssueEventRow` (apps/worker/src/processors/triage.ts)
 * sets `sourceId` to the RUN id, precisely because ENV_ISSUE has no owning row
 * to point at. So the generic ledger fold — which counts distinct live
 * `sourceId`s per kind, in apps/worker/src/processors/digest.ts and
 * apps/api/src/routes/runs.ts — already answers "nine runs" for nine
 * down-environment runs, with no kind-specific constructor at all.
 *
 * Deleted rather than wired, because the alternative was a SECOND place that
 * decides what an ENV_ISSUE count is, and two constructors for one number is
 * the duplication this vocabulary exists to remove. The fact it encoded is
 * pinned where the number is actually produced:
 * 'counts one ENV_ISSUE suppression per run, because the run IS the source'
 * in apps/worker/src/processors/digest.test.ts.
 */
