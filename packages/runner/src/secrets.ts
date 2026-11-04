/**
 * WHICH OF AN ENVIRONMENT'S SECRETS THIS ONE TEST MAY RECEIVE.
 *
 * ─── THE DEFECT ─────────────────────────────────────────────────────────────
 *
 * There is no per-test scoping anywhere in the product. `secretsFor(orgId,
 * environmentId)` in apps/worker/src/vault.ts decrypts EVERY secret in the
 * environment into one `Record<string, string>`, the run processor puts that
 * object on `RunContext.secrets`, and every plugin for every test reads from
 * it. So a test that needs a payment provider's test key also receives the
 * production database password, the S3 credentials and whatever else the
 * environment holds — and the vault's RBAC, which decides who may READ a
 * secret in the cockpit, is cosmetic the moment a MEMBER can author a test.
 *
 * One compromised or careless generated test reads the lot. `plugins/cli.ts`,
 * `plugins/external.ts` and `plugins/mutation.ts` do narrow what they INJECT to
 * `spec.secretNames` — but the narrowing is the TEST's own choice of what to
 * ask for, and a test asking for everything is not a refusal. The vault has no
 * opinion at all.
 *
 * ─── WHY THE DEFAULT IS DENY, AND WHY THAT IS STRUCTURAL RATHER THAN POLITE ─
 *
 * `SECRET_SCOPE_KINDS` / `SECRET_SCOPE_RULES` in @qaai/shared (and the
 * `SecretScope` table behind them) make the ABSENCE OF A ROW the denial. A
 * secret with no scope row reaches nothing. To widen one you write a row, and
 * the row carries an author, a timestamp and — for the three broad kinds — a
 * reason. There is deliberately no `scopeEverything` boolean, because a boolean
 * would make the permissive answer the cheap one, which is how the current
 * state happened.
 *
 * This file is the half that DECIDES, and it is built so that the permissive
 * answer is not reachable by accident:
 *
 *   - {@link ScopedSecrets} carries a module-private brand symbol, so
 *     {@link resolveScopedSecrets} is the only function in the repository that
 *     can produce one. A caller cannot assemble its own `{ values: ctx.secrets }`
 *     and pass it off as a resolved set; that is a compile error, and the
 *     typecheck is the proof.
 *   - admission is a `Record<SecretScopeKind, …>` of matchers with NO
 *     fall-through branch. A scope kind nobody wrote a matcher for is a type
 *     error here rather than a secret that leaks through a `default:`.
 *   - a row whose `kind` this build does not recognise — a row written by a
 *     newer deployment against the same database — does not admit. Unknown and
 *     refused land in the same place, which is the only safe reading.
 *   - `values` is written in exactly ONE loop, and the same statement that
 *     writes it increments `injected`. There is no path that adds a secret
 *     without counting it, and `resolveScopedSecrets` asserts the arithmetic
 *     before it returns.
 *
 * ─── THE BRAKE, AND WHY THIS IS THE DANGEROUS ONE ───────────────────────────
 *
 * `SECURITY_CONTROL_BRAKES.SECRET_TEST_SCOPING` defaults to **OBSERVE**, and it
 * is one of only three controls in the round that do. Enforcing default-DENY
 * today would take the credentials away from every test in every existing
 * install at once, because no `SecretScope` row exists anywhere yet. So in
 * OBSERVE the injection still happens and {@link ScopedSecrets.wouldWithhold}
 * counts it — which is not a consolation prize, it is the worklist: the number
 * says how many scope rows have to be written before anyone can arm this.
 *
 * `withheld` and `wouldWithhold` are TWO FIELDS on purpose. One field reading
 * "3" would be true in both modes and would mean something different in each,
 * and this repository has already shipped a `verified` flag that was defensibly
 * true while the test it described was red. `withheld` is what actually did not
 * reach the test. `wouldWithhold` is what default-DENY denies, whatever the
 * mode. In ENFORCE they are equal; in OBSERVE `withheld` is zero.
 *
 * ─── NO ORACLE, AND NO SECRET IN A MESSAGE ──────────────────────────────────
 *
 * {@link withheldNote} is what a failing test's author reads, and it carries
 * COUNTS ONLY. Not the names of the secrets that were scoped away — a name is
 * itself a disclosure ("so there IS a PROD_DATABASE_URL in this environment"),
 * and the author's actual question is "did the platform take something away
 * from me, or did I typo the name", which a count answers. The per-cause
 * breakdown on {@link ScopedSecrets.withheldByCause} is for the OPERATOR
 * looking at their own tenant, and it too names nothing. Values never appear in
 * either; `values` is the injection map and goes to `childEnv` and nowhere
 * else.
 *
 * ─── NO NETWORK, NO DATABASE, NO CLOCK ─────────────────────────────────────
 *
 * Every input arrives as an argument, including the scope rows and the mode, so
 * the whole control is deterministic and testable with a fake. The caller does
 * the reading; apps/worker/src/vault.ts gets the exact `select` it needs in this
 * round's hand-off notes.
 */

import { controlEnforces } from '@qaai/shared';
import type { ControlMode, SecretScopeKind, TestType } from '@qaai/shared';

// ─── What the caller supplies ────────────────────────────────────────────────

/**
 * One decrypted secret, with the identity its scope rows point at.
 *
 * `id` is load-bearing and is why this cannot be driven off
 * `RunContext.secrets`: that map is keyed by NAME, and `SecretScope.secretId`
 * references the row. Matching on name would mean a secret renamed in the
 * cockpit silently keeps — or silently loses — its scopes.
 */
export interface ScopableSecret {
  /** `Secret.id`. What `SecretScope.secretId` references. */
  readonly id: string;
  /** `Secret.name` — the environment variable the test sees. */
  readonly name: string;
  /** The decrypted plaintext. Goes to `childEnv`; never to a log, a note or a metric. */
  readonly value: string;
}

/** One `SecretScope` row, as the resolver needs it. */
export interface SecretScopeRow {
  readonly secretId: string;
  readonly kind: SecretScopeKind;
  /**
   * What the kind names. NULL EXACTLY FOR ENVIRONMENT_WIDE — the other four
   * kinds name a test, a suite, a test type or an auth profile, and a null
   * there is a malformed row rather than a wildcard. See {@link SCOPE_MATCHERS}.
   */
  readonly value: string | null;
}

/**
 * WHO IS ASKING. Every fact a scope kind can match on, and `null` where the
 * caller does not know.
 *
 * `suiteId` is nullable because it is a property of the RUN rather than of the
 * test (`RunSummary.suiteId`; `ExecutableTest` has no suite), and
 * `RunContext` does not carry it yet. A null is not treated as "matches
 * anything" — it produces TARGET_FACT_MISSING and the secret is withheld,
 * because a control that admits on a fact it does not have is not a control.
 */
export interface SecretTarget {
  readonly testId: string;
  readonly testType: TestType;
  readonly suiteId: string | null;
  readonly authProfileId: string | null;
}

export interface ResolveSecretsInput {
  /** The environment's decrypted secrets. */
  readonly secrets: readonly ScopableSecret[];
  /**
   * The scope rows for those secrets, or the literal `'UNAVAILABLE'` when the
   * caller could not load them.
   *
   * UNAVAILABLE IS NOT AN EMPTY ARRAY, and conflating the two is the lie this
   * union exists to prevent: an empty array means "we looked and there are no
   * rows", which makes NO_SCOPE_ROW the honest cause; `'UNAVAILABLE'` means "we
   * did not look, or the read failed", which must be reported as what it is.
   * Both withhold in ENFORCE. Only one of them is a measurement.
   */
  readonly scopes: readonly SecretScopeRow[] | 'UNAVAILABLE';
  readonly target: SecretTarget;
  /** `controlMode('SECRET_TEST_SCOPING', org.securityControlModes)`. */
  readonly mode: ControlMode;
  /**
   * The names the test asked for (`spec.secretNames`), or null for "every
   * secret in the environment" — which is what the harness and the plugins that
   * do not take a name list pass today.
   *
   * Narrowing to the request happens BEFORE scoping so the counts are about
   * secrets the test actually wanted. A test that asks for one secret and is
   * told "11 were withheld" learns nothing it can act on.
   */
  readonly requested?: readonly string[] | null;
}

// ─── Why one secret did not reach this test ──────────────────────────────────

/**
 * Operator-facing causes. Each one has a different remedy, which is the whole
 * reason they are not collapsed into a single number:
 *
 *  SCOPES_UNAVAILABLE       nobody measured anything — fix the read, do not
 *                           write scope rows.
 *  NO_SCOPE_ROW             measured: this secret is scoped to nothing. Write
 *                           the row. This is the expected cause on day one and
 *                           is the entire OBSERVE worklist.
 *  SCOPE_NAMES_SOMETHING_ELSE  measured: rows exist and name other tests. The
 *                           control is working as designed.
 *  TARGET_FACT_MISSING      the row names a suite or a profile and the caller
 *                           did not say which this run is. A gap in the CALLER,
 *                           not in the customer's configuration.
 *  SCOPE_ROW_MALFORMED      a row this build cannot act on — a null value on a
 *                           kind that must name something, a value on
 *                           ENVIRONMENT_WIDE which names nothing, or a `kind`
 *                           from a newer deployment.
 */
export const WITHHOLD_CAUSES = [
  'SCOPES_UNAVAILABLE',
  'NO_SCOPE_ROW',
  'SCOPE_NAMES_SOMETHING_ELSE',
  'TARGET_FACT_MISSING',
  'SCOPE_ROW_MALFORMED',
] as const;
export type WithholdCause = (typeof WITHHOLD_CAUSES)[number];

/** Compile-time presence; the run-time half is the parity test on the list. */
const WITHHOLD_CAUSE_PRESENT: Record<WithholdCause, true> = {
  SCOPES_UNAVAILABLE: true,
  NO_SCOPE_ROW: true,
  SCOPE_NAMES_SOMETHING_ELSE: true,
  TARGET_FACT_MISSING: true,
  SCOPE_ROW_MALFORMED: true,
};

/** Derived, never hand-listed. */
export const WITHHOLD_CAUSE_LIST = Object.keys(
  WITHHOLD_CAUSE_PRESENT,
) as ReadonlyArray<WithholdCause>;

/**
 * When several rows all fail, the cause reported is the most ACTIONABLE one
 * rather than the first one seen — otherwise the answer depends on row order,
 * which is a property of the query and not of the configuration.
 */
const CAUSE_PRECEDENCE: Record<WithholdCause, number> = {
  SCOPE_ROW_MALFORMED: 0,
  TARGET_FACT_MISSING: 1,
  SCOPE_NAMES_SOMETHING_ELSE: 2,
  NO_SCOPE_ROW: 3,
  SCOPES_UNAVAILABLE: 4,
};

// ─── Admission ───────────────────────────────────────────────────────────────

type ScopeVerdict = 'ADMIT' | 'NAMES_SOMETHING_ELSE' | 'TARGET_FACT_MISSING' | 'MALFORMED';

/**
 * One matcher per scope kind, as a `Record<SecretScopeKind, …>` so a sixth kind
 * is a COMPILE ERROR here and not a secret that falls through.
 *
 * There is no `default:` and no `return true` anywhere below. Every branch
 * returns one of four verdicts and only `'ADMIT'` admits, which is the shape
 * rule 10 of this round asks for: an exception handler or a default arm that
 * reaches "allow" is the defect pattern, so there is no arm to reach.
 *
 * The null rules mirror `SECRET_SCOPE_RULES[kind].names` exactly, and
 * `secrets.test.ts` cross-checks the two rather than restating the mapping —
 * `ENVIRONMENT_WIDE` names NOTHING so its row's value must be null, and the
 * other four name something so a null is a malformed row. A null read as a
 * wildcard would turn the single broadest kind into four of them.
 */
const SCOPE_MATCHERS: Record<
  SecretScopeKind,
  (row: SecretScopeRow, target: SecretTarget) => ScopeVerdict
> = {
  TEST: (row, target) =>
    row.value === null
      ? 'MALFORMED'
      : row.value === target.testId
        ? 'ADMIT'
        : 'NAMES_SOMETHING_ELSE',

  SUITE: (row, target) =>
    row.value === null
      ? 'MALFORMED'
      : target.suiteId === null
        ? 'TARGET_FACT_MISSING'
        : row.value === target.suiteId
          ? 'ADMIT'
          : 'NAMES_SOMETHING_ELSE',

  TEST_TYPE: (row, target) =>
    row.value === null
      ? 'MALFORMED'
      : row.value === target.testType
        ? 'ADMIT'
        : 'NAMES_SOMETHING_ELSE',

  AUTH_PROFILE: (row, target) =>
    row.value === null
      ? 'MALFORMED'
      : target.authProfileId === null
        ? 'TARGET_FACT_MISSING'
        : row.value === target.authProfileId
          ? 'ADMIT'
          : 'NAMES_SOMETHING_ELSE',

  // The broadest and most uncomfortable member, and the one that re-creates
  // today's behaviour for ONE secret at a time with somebody's name on it.
  // It names nothing, so a row carrying a value is not an ENVIRONMENT_WIDE row
  // somebody annotated — it is a row whose author meant something else.
  ENVIRONMENT_WIDE: (row) => (row.value === null ? 'ADMIT' : 'MALFORMED'),
};

/** Derived from the matchers, so the two can never disagree about the list. */
export const SCOPE_MATCHER_KINDS = Object.keys(
  SCOPE_MATCHERS,
) as ReadonlyArray<SecretScopeKind>;

function verdictCause(verdict: Exclude<ScopeVerdict, 'ADMIT'>): WithholdCause {
  switch (verdict) {
    case 'NAMES_SOMETHING_ELSE':
      return 'SCOPE_NAMES_SOMETHING_ELSE';
    case 'TARGET_FACT_MISSING':
      return 'TARGET_FACT_MISSING';
    case 'MALFORMED':
      return 'SCOPE_ROW_MALFORMED';
  }
}

/**
 * `null` when this secret may reach this test; otherwise WHY it may not.
 *
 * Exported for the test suite because it is the whole decision and deserves to
 * be exercised directly, one kind at a time, rather than only through the
 * arithmetic of {@link resolveScopedSecrets}.
 */
export function withholdCauseFor(
  secret: ScopableSecret,
  scopes: readonly SecretScopeRow[] | 'UNAVAILABLE',
  target: SecretTarget,
): WithholdCause | null {
  if (scopes === 'UNAVAILABLE') return 'SCOPES_UNAVAILABLE';

  const rows = scopes.filter((row) => row.secretId === secret.id);
  if (rows.length === 0) return 'NO_SCOPE_ROW';

  let cause: WithholdCause = 'NO_SCOPE_ROW';
  for (const row of rows) {
    const matcher = SCOPE_MATCHERS[row.kind];
    // A `kind` this build has never heard of, from a newer deployment sharing
    // the database. Unknown and refused must land in the same place.
    if (!matcher) {
      cause = 'SCOPE_ROW_MALFORMED';
      continue;
    }
    const verdict = matcher(row, target);
    if (verdict === 'ADMIT') return null;
    const next = verdictCause(verdict);
    if (CAUSE_PRECEDENCE[next] < CAUSE_PRECEDENCE[cause]) cause = next;
  }
  return cause;
}

// ─── The resolved set ────────────────────────────────────────────────────────

/*
 * The brand. A module-private `const` symbol is a `unique symbol` to the
 * compiler, and nothing outside this file can name it — so `ScopedSecrets` is
 * not assignable from any object literal written anywhere else, and
 * `resolveScopedSecrets` is structurally the only producer. That is what makes
 * the default-deny a property of the TYPE rather than of every caller's
 * diligence: a plugin cannot shrug and pass `{ values: ctx.secrets, … }` into a
 * function that wants a resolved set.
 */
const RESOLVED = Symbol('qaai.runner.scopedSecrets');

/**
 * The answer: what this test gets, and the arithmetic behind it.
 *
 * `injected + withheld === considered` always, and `resolveScopedSecrets`
 * refuses to return a set where it does not hold.
 */
export interface ScopedSecrets {
  /** The brand. See the comment above {@link RESOLVED}. */
  readonly [RESOLVED]: true;
  /**
   * The injection map, by secret name. Hand it to `childEnv({ secrets })`.
   *
   * It holds PLAINTEXT. It must not be logged, spread into a progress event,
   * put in an error message or stringified into an artifact — the masking
   * helpers (`createMasker`, `maskDeep`) exist for the places a value might
   * otherwise surface, and this object is the thing they are protecting against.
   */
  readonly values: Readonly<Record<string, string>>;
  /** Which mode produced this. OBSERVE means `values` is wider than the scopes. */
  readonly mode: ControlMode;
  /** Whether the scope rows were a measurement at all. */
  readonly source: 'SCOPE_ROWS' | 'UNAVAILABLE';
  /** Secrets the test asked for AND the environment has. The denominator. */
  readonly considered: number;
  /** `Object.keys(values).length`, by construction. */
  readonly injected: number;
  /** What actually did not reach the test. Zero in OBSERVE. */
  readonly withheld: number;
  /** What default-DENY denies, in either mode. Equals `withheld` in ENFORCE. */
  readonly wouldWithhold: number;
  /**
   * Names the test asked for that no secret in the environment matches.
   *
   * A THIRD number, and not folded into `withheld`: "your test asked for a
   * secret that does not exist" and "the platform took a secret away from you"
   * have different remedies, and reporting a typo as a scoping refusal sends
   * the reader to an owner to widen a scope that was never the problem.
   */
  readonly absent: number;
  /** Per-cause counts for the operator. Counts only; see the module header. */
  readonly withheldByCause: Readonly<Record<WithholdCause, number>>;
}

function zeroCauses(): Record<WithholdCause, number> {
  // Built from the derived list so a sixth cause cannot be missed here.
  const out = {} as Record<WithholdCause, number>;
  for (const cause of WITHHOLD_CAUSE_LIST) out[cause] = 0;
  return out;
}

/**
 * THE RESOLVER. The only producer of a {@link ScopedSecrets}.
 *
 * In ENFORCE, a secret reaches `values` only when {@link withholdCauseFor}
 * returned null for it. In OBSERVE it reaches `values` either way and the
 * would-be refusal is counted — never a silent behaviour change in either
 * direction.
 */
export function resolveScopedSecrets(input: ResolveSecretsInput): ScopedSecrets {
  const enforcing = controlEnforces(input.mode);
  const byName = new Map(input.secrets.map((secret) => [secret.name, secret]));

  // Narrow to the request first; see `ResolveSecretsInput.requested`.
  let candidates: readonly ScopableSecret[];
  let absent = 0;
  if (input.requested) {
    const picked: ScopableSecret[] = [];
    // Deduplicated: a spec may legitimately list a name twice, and counting it
    // twice would make `considered` a property of the spec's tidiness.
    for (const name of new Set(input.requested)) {
      const secret = byName.get(name);
      if (secret) picked.push(secret);
      else absent += 1;
    }
    candidates = picked;
  } else {
    candidates = input.secrets;
  }

  const values: Record<string, string> = {};
  const withheldByCause = zeroCauses();
  let injected = 0;
  let withheld = 0;
  let wouldWithhold = 0;

  for (const secret of candidates) {
    const cause = withholdCauseFor(secret, input.scopes, input.target);

    if (cause === null) {
      values[secret.name] = secret.value;
      injected += 1;
      continue;
    }

    wouldWithhold += 1;
    withheldByCause[cause] += 1;

    if (enforcing) {
      withheld += 1;
      continue;
    }

    /*
     * OBSERVE. The injection happens, exactly as it does today, and the line
     * above has already counted it. This is the mode `SECURITY_CONTROL_BRAKES`
     * defaults to, and the reason is written there: no `SecretScope` row exists
     * in any install yet, so ENFORCE on day one takes the credentials away from
     * every test everywhere. The count is the worklist for arming it.
     */
    values[secret.name] = secret.value;
    injected += 1;
  }

  /*
   * The invariant, checked rather than claimed. The one loop above is the only
   * writer of `values` and increments `injected` in the same breath, so this
   * can only fire if somebody adds a second writer — which is exactly when a
   * secret would start reaching a test uncounted.
   */
  if (injected !== Object.keys(values).length || injected + withheld !== candidates.length) {
    throw new Error('secret scoping arithmetic does not add up; refusing to inject');
  }

  return Object.freeze({
    [RESOLVED]: true as const,
    values: Object.freeze(values),
    mode: input.mode,
    source: input.scopes === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'SCOPE_ROWS',
    considered: candidates.length,
    injected,
    withheld,
    wouldWithhold,
    absent,
    withheldByCause: Object.freeze(withheldByCause),
  });
}

/**
 * The resolved set for a caller that has NO scope rows and no way to get them.
 *
 * Every existing plugin receives `RunContext.secrets` — a flat name→value map
 * with no ids — and the run processor does not read `SecretScope` yet. Rather
 * than let those call sites keep spreading the whole map with no record of it,
 * they go through here: the result is a real {@link ScopedSecrets} whose
 * `source` is UNAVAILABLE, so the count is reported as UNMEASURED rather than
 * as a clean zero. That distinction is the difference between "nothing was
 * withheld" and "nobody checked", and reporting the second as the first is one
 * of the lies this product cannot afford.
 *
 * It is NOT a bypass: in ENFORCE it withholds everything, because a control
 * that cannot determine a scope must not inject (rule 10). Which is also why
 * the control's default is OBSERVE until the hand-off edits land.
 */
export function unscopedSecrets(
  secrets: Readonly<Record<string, string>>,
  target: SecretTarget,
  mode: ControlMode,
  requested?: readonly string[] | null,
): ScopedSecrets {
  return resolveScopedSecrets({
    // No ids exist in this shape; the name stands in, and it cannot match a
    // scope row's `secretId`, which is correct — there are no rows to match.
    secrets: Object.entries(secrets).map(([name, value]) => ({ id: name, name, value })),
    scopes: 'UNAVAILABLE',
    target,
    mode,
    requested: requested ?? null,
  });
}

// ─── What a human is told ────────────────────────────────────────────────────

/**
 * ONE SENTENCE, whatever the cause.
 *
 * The same rule `EGRESS_REFUSAL_SENTENCE` states in packages/shared/src/egress.ts:
 * a refusal that varies with the reason is an oracle. Here the thing being
 * protected is smaller but the argument is identical — a message that said
 * "scoped to another test" where another said "no scope row" would tell the
 * author of one test about the configuration of another. The cause lives on
 * {@link ScopedSecrets.withheldByCause}, which is read inside the tenant by
 * somebody who can already see the whole environment.
 */
const WITHHELD_HEAD = 'secret(s) this test asked for are not in scope for it';

/**
 * What to put on a failing test's result, or null when there is nothing to say.
 *
 * Counts only — no secret name, no value, no cause. The author's question is
 * "did the platform take something away from me", and that is what this
 * answers; `absent` is reported separately because a typo and a refusal have
 * different remedies.
 */
export function withheldNote(scoped: ScopedSecrets): string | null {
  const parts: string[] = [];

  if (scoped.withheld > 0) {
    parts.push(
      `${scoped.withheld} of ${scoped.considered} ${WITHHELD_HEAD}, so they were not provided ` +
        'to it. Per-test secret scoping is being enforced for this organisation. Ask an owner ' +
        'to scope the secret this test needs to this test.',
    );
  } else if (scoped.wouldWithhold > 0) {
    parts.push(
      `${scoped.wouldWithhold} of ${scoped.considered} ${WITHHELD_HEAD}. They WERE provided, ` +
        'because per-test secret scoping is in observe mode for this organisation — this is a ' +
        'warning, not a failure. Scope them before it is enforced.',
    );
  }

  if (scoped.absent > 0) {
    parts.push(
      `${scoped.absent} name(s) this test asked for do not match any secret in the ` +
        'environment, which is a different problem from scoping: check the spelling.',
    );
  }

  if (scoped.source === 'UNAVAILABLE' && scoped.wouldWithhold > 0) {
    parts.push(
      'QAAI could not read this environment\'s secret scopes for this run, so the figure above ' +
        'is "not measured" rather than a finding about your configuration.',
    );
  }

  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * The operator's view: the arithmetic and the causes, with nothing that could
 * identify a secret.
 *
 * Returned as a plain object so a caller can log or persist it. There is no
 * `names` field and there is not going to be one — see the module header.
 */
export function scopeAudit(scoped: ScopedSecrets): {
  mode: ControlMode;
  source: 'SCOPE_ROWS' | 'UNAVAILABLE';
  considered: number;
  injected: number;
  withheld: number;
  wouldWithhold: number;
  absent: number;
  causes: Record<WithholdCause, number>;
} {
  return {
    mode: scoped.mode,
    source: scoped.source,
    considered: scoped.considered,
    injected: scoped.injected,
    withheld: scoped.withheld,
    wouldWithhold: scoped.wouldWithhold,
    absent: scoped.absent,
    causes: { ...scoped.withheldByCause },
  };
}
