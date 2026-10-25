import { describe, expect, it } from 'vitest';
import {
  AUTH_PROFILE_KINDS,
  AUTO_QUARANTINE_REASON_PREFIX,
  ENVIRONMENT_UNAVAILABLE_PREFIX,
  FLAKE_AUDIT_ACTIONS,
  FLAKE_RUN_PREFIX,
  HEAL_AUDIT_ACTIONS,
  HEAL_VERIFY_RUN_PREFIX,
  NOT_RUN_KINDS,
  RE_ENUMERATION_RUN_STATES,
  RE_ENUMERATION_TRIGGER_KINDS,
  SURFACE_DRIFT_COMPARABILITIES,
  driftCountsAreMeaningful,
  environmentUnavailableMessage,
  environmentUnavailableReason,
  isFlakeConfirmationRun,
  isNotRunKind,
  newSurfaceWithoutTests,
  notRunMessage,
  parseNotRun,
  triggerHasRun,
} from './constants';

/**
 * The parsers in constants.ts, and why they are worth a file of their own.
 *
 * Four facts in this product ride as a PREFIX or a TAG on a free-text column,
 * each for a reason the constant itself argues at length: a flake-confirmation
 * run and a heal-verification run are both marked on `Run.triggeredBy`, an
 * un-runnable run is marked on `Run.errorMessage`, and the reason a result did
 * not run is tagged at the head of `TestResult.errorMessage`.
 *
 * That design is only safe while the readers are ANCHORED. `startsWith` says
 * "this row is one of ours"; `includes` says "somebody's error message
 * mentioned our prefix" — and the second one is reachable from customer data,
 * because every one of these columns holds text QAAI did not write. A test
 * message reading `expected "ENVIRONMENT_UNAVAILABLE: down" but got …` would,
 * under `includes`, be read as a run nothing was attempted in: the run would be
 * excluded from the pass rate and reported as the environment's fault, which is
 * a failure suppressed and miscounted in one step.
 *
 * Nothing exercised any of these before this file existed. Every assertion
 * below is therefore written to go RED under a specific, plausible weakening of
 * the code it covers, and the weakening is named next to it.
 */

describe('environmentUnavailableReason', () => {
  it('returns the sentence after the prefix, trimmed', () => {
    const message = environmentUnavailableMessage('the base URL did not answer');
    expect(environmentUnavailableReason(message)).toBe('the base URL did not answer');
  });

  it('is ANCHORED: a prefix in the middle is not a match', () => {
    // Goes red if `startsWith` becomes `includes`. This is a real message
    // shape: an assertion failure quoting a run's own error text, stored on a
    // DIFFERENT run, would be classified as un-runnable.
    const quoted = `expected "${ENVIRONMENT_UNAVAILABLE_PREFIX} staging is down" but got a 200`;
    expect(environmentUnavailableReason(quoted)).toBeNull();
  });

  it('is case-sensitive and exact, not a fuzzy contains', () => {
    expect(environmentUnavailableReason('environment_unavailable: down')).toBeNull();
    expect(environmentUnavailableReason('ENVIRONMENT UNAVAILABLE: down')).toBeNull();
    expect(environmentUnavailableReason('XENVIRONMENT_UNAVAILABLE: down')).toBeNull();
  });

  it('returns null rather than throwing for a null or absent message', () => {
    // Goes red if the `typeof` guard is dropped: `null.startsWith` throws, and
    // this is called over every result row of a finished run.
    expect(environmentUnavailableReason(null)).toBeNull();
    expect(environmentUnavailableReason(undefined)).toBeNull();
    expect(environmentUnavailableReason('')).toBeNull();
  });

  it('distinguishes an empty reason from no prefix at all', () => {
    // Both are falsy strings to a careless caller, and they are different
    // facts: one is a tagged run with nothing said, the other is not tagged.
    expect(environmentUnavailableReason(ENVIRONMENT_UNAVAILABLE_PREFIX)).toBe('');
    expect(environmentUnavailableReason('something else entirely')).toBeNull();
  });
});

describe('isFlakeConfirmationRun', () => {
  it('recognises the radar’s own runs', () => {
    expect(isFlakeConfirmationRun(`${FLAKE_RUN_PREFIX}test_1:inv_1`)).toBe(true);
  });

  it('is ANCHORED: the prefix elsewhere in the string is not a match', () => {
    // Goes red if `startsWith` becomes `includes`. `triggeredBy` holds a user
    // id or a free-form marker, so a value merely CONTAINING the prefix is
    // reachable — and a run misread as a confirmation run is measured into a
    // flake rate that can auto-quarantine a test that was catching a real bug.
    expect(isFlakeConfirmationRun(`user_${FLAKE_RUN_PREFIX}abc`)).toBe(false);
    expect(isFlakeConfirmationRun(`re-run of ${FLAKE_RUN_PREFIX}test_1`)).toBe(false);
  });

  it('does not confuse the two run markers on the same column', () => {
    // `Run.triggeredBy` carries both. A heal verification counted as a flake
    // sample would feed the radar a measurement it did not take.
    expect(isFlakeConfirmationRun(`${HEAL_VERIFY_RUN_PREFIX}heal_1`)).toBe(false);
    expect(HEAL_VERIFY_RUN_PREFIX.startsWith(FLAKE_RUN_PREFIX)).toBe(false);
    expect(FLAKE_RUN_PREFIX.startsWith(HEAL_VERIFY_RUN_PREFIX)).toBe(false);
  });

  it('is false for null, undefined and a plain user id', () => {
    expect(isFlakeConfirmationRun(null)).toBe(false);
    expect(isFlakeConfirmationRun(undefined)).toBe(false);
    expect(isFlakeConfirmationRun('usr_9')).toBe(false);
  });
});

describe('parseNotRun', () => {
  it('round-trips what notRunMessage writes', () => {
    const message = notRunMessage('BLOCKED_BY_ENV', 'the base URL did not answer');
    expect(parseNotRun(message)).toEqual({
      kind: 'BLOCKED_BY_ENV',
      why: 'the base URL did not answer',
    });
  });

  it.each(NOT_RUN_KINDS)('round-trips %s', (kind) => {
    expect(parseNotRun(notRunMessage(kind, 'because'))).toEqual({ kind, why: 'because' });
  });

  it('is ANCHORED: a tag that is not at the head is not a tag', () => {
    // Goes red if the `^` is removed from the regex. The message column holds
    // the application's own failure text, so `[UNSUPPORTED]` appearing inside
    // an assertion diff is reachable — and reading it as a tag turns a real
    // FAILED result into "we never attempted this", which is a failure
    // suppressed without being counted.
    expect(parseNotRun('expected [UNSUPPORTED] but the page rendered it')).toBeNull();
    expect(parseNotRun('  [CANCELLED] leading whitespace is not the head')).toBeNull();
  });

  it('refuses a tag that is not one of the four kinds', () => {
    // Goes red if the `isNotRunKind(match[1])` guard is dropped: the function
    // would return `{ kind: 'WONTFIX' }`, a value the enum column cannot hold
    // and every consumer switches on.
    expect(parseNotRun('[WONTFIX] somebody invented a reason')).toBeNull();
    expect(parseNotRun('[SKIPPED] the old spelling')).toBeNull();
    expect(parseNotRun('[not_run] lower case is a different string')).toBeNull();
  });

  it('returns null — "not recorded" — for an untagged sentence', () => {
    // THE FIFTH STATE. A plugin that reports SKIPPED with a plain sentence has
    // made no claim about which of the four applies, and null must not be read
    // as NOT_RUN, which IS a claim.
    expect(parseNotRun('k6 is not installed on this image')).toBeNull();
    expect(parseNotRun(null)).toBeNull();
    expect(parseNotRun(undefined)).toBeNull();
    expect(parseNotRun('')).toBeNull();
  });

  it('keeps a multi-line reason whole', () => {
    // `[\s\S]` and not `.`: a reason carrying a stack would otherwise come back
    // truncated at the first newline, silently.
    const why = 'the login failed\n  at signIn (auth.ts:12)';
    expect(parseNotRun(notRunMessage('BLOCKED_BY_ENV', why))?.why).toBe(why);
  });

  it('survives a tag with no reason after it', () => {
    expect(parseNotRun('[CANCELLED]')).toEqual({ kind: 'CANCELLED', why: '' });
  });
});

describe('isNotRunKind', () => {
  it.each(NOT_RUN_KINDS)('accepts %s', (kind) => {
    expect(isNotRunKind(kind)).toBe(true);
  });

  it('rejects anything else, including non-strings', () => {
    for (const value of ['SKIPPED', 'not_run', '', null, undefined, 0, {}, ['NOT_RUN']]) {
      expect(isNotRunKind(value)).toBe(false);
    }
  });

  it('is the exact domain of the Prisma enum — four members, no more', () => {
    // `check:enums` diffs this array against `enum NotRunKind` in
    // schema.prisma. Pinned here too so a fifth member cannot be added in a
    // change that does not run that script.
    expect([...NOT_RUN_KINDS]).toEqual(['NOT_RUN', 'BLOCKED_BY_ENV', 'UNSUPPORTED', 'CANCELLED']);
  });
});

/**
 * The markers are the whole mechanism — each one is a fact stored without a
 * column — so the strings themselves are part of the contract. A silent edit to
 * any of them orphans every row already written with the old spelling.
 */
describe('the run and quarantine markers', () => {
  it('keeps the spellings every stored row was written with', () => {
    expect(FLAKE_RUN_PREFIX).toBe('flake-radar:');
    expect(HEAL_VERIFY_RUN_PREFIX).toBe('heal-verify:');
    expect(ENVIRONMENT_UNAVAILABLE_PREFIX).toBe('ENVIRONMENT_UNAVAILABLE:');
    expect(AUTO_QUARANTINE_REASON_PREFIX).toBe('Auto-quarantined');
  });

  it('gives the heal lane a distinct action for "nobody could check"', () => {
    // `unverifiable` is not a flavour of `verificationFailed`. Applied-and-
    // unchecked must never read as either a pass or a failure, and the audit
    // row is the only record the sweep leaves.
    expect(HEAL_AUDIT_ACTIONS.unverifiable).not.toBe(HEAL_AUDIT_ACTIONS.verified);
    expect(HEAL_AUDIT_ACTIONS.unverifiable).not.toBe(HEAL_AUDIT_ACTIONS.verificationFailed);
  });

  it('keeps every audit action distinct and namespaced', () => {
    const actions = [...Object.values(HEAL_AUDIT_ACTIONS), ...Object.values(FLAKE_AUDIT_ACTIONS)];
    expect(new Set(actions).size).toBe(actions.length);
    for (const action of actions) {
      expect(action).toMatch(/^[a-z]+(\.[a-z]+)+$/);
    }
  });
});

/**
 * The re-enumeration lifecycle, and the two numbers it must refuse to invent.
 *
 * Both vocabularies below describe a measurement that has never been taken in
 * this product: nothing re-enumerates on its own, and no code diffs two crawl
 * versions even though the schema and the cockpit both imply it does. So every
 * assertion here is about the state a reader sees BEFORE the feature works —
 * which is the state most installs will be in for a while, and the state in
 * which a flattering default would do the most damage.
 */
describe('the re-enumeration triggers', () => {
  it('names the four ways a surface can be enumerated again', () => {
    // DEPLOY is the one that fires at the moment the surface changes, and MANUAL
    // is kept explicit so "nothing is scheduled" and "a person ran it in March"
    // are different rows rather than the same absence.
    expect([...RE_ENUMERATION_TRIGGER_KINDS].sort()).toEqual([
      'CI',
      'DEPLOY',
      'MANUAL',
      'SCHEDULE',
    ]);
  });

  it('separates "never fired" from "ran and found nothing"', () => {
    // THE assertion. A trigger that has never run must not read as a clean bill
    // of health, which is what a null `lastRunAt` renders as. Goes red if
    // `triggerHasRun` is ever written as a truthiness check on a timestamp.
    expect(triggerHasRun('NEVER_RUN')).toBe(false);
    for (const state of RE_ENUMERATION_RUN_STATES) {
      if (state === 'NEVER_RUN') continue;
      expect(triggerHasRun(state), `${state} has run`).toBe(true);
    }
  });

  it('keeps SKIPPED out of SUCCEEDED', () => {
    // A run the policy or a lock declined enumerated nothing. Folding it into
    // SUCCEEDED would make a permanently-skipped trigger look healthy.
    expect(RE_ENUMERATION_RUN_STATES).toContain('SKIPPED');
    expect(RE_ENUMERATION_RUN_STATES).toContain('SUCCEEDED');
  });

  it('has no duplicate member in either vocabulary', () => {
    for (const vocabulary of [
      RE_ENUMERATION_TRIGGER_KINDS,
      RE_ENUMERATION_RUN_STATES,
      SURFACE_DRIFT_COMPARABILITIES,
      AUTH_PROFILE_KINDS,
    ]) {
      expect(new Set(vocabulary).size).toBe(vocabulary.length);
    }
  });
});

describe('the drift record refuses to turn a non-comparison into a zero', () => {
  it('names three distinct ways for "no drift" to be unsayable', () => {
    expect([...SURFACE_DRIFT_COMPARABILITIES].sort()).toEqual([
      'COMPARABLE',
      'NOT_COMPARED',
      'UNCOMPARABLE_BASELINE_NOT_ACCEPTED',
      'UNCOMPARABLE_NO_BASELINE',
    ]);
  });

  it('calls the counts meaningful only for a real comparison', () => {
    expect(driftCountsAreMeaningful('COMPARABLE')).toBe(true);
    for (const state of SURFACE_DRIFT_COMPARABILITIES) {
      if (state === 'COMPARABLE') continue;
      expect(driftCountsAreMeaningful(state), `${state} is not a comparison`).toBe(false);
    }
  });

  it('returns the number when, and only when, it was measured', () => {
    expect(
      newSurfaceWithoutTests({ comparability: 'COMPARABLE', newSurfaceWithoutTests: 4 }),
    ).toBe(4);
    // Zero is a real measurement here and must survive: "we compared and nothing
    // new is untested" is the answer this feature exists to be able to give.
    expect(
      newSurfaceWithoutTests({ comparability: 'COMPARABLE', newSurfaceWithoutTests: 0 }),
    ).toBe(0);
  });

  it('refuses to report 0 for a comparison that could not happen', () => {
    /*
     * The lie this function exists to prevent. Zero means "nothing new is
     * untested", it renders as a green tick, and once written to a column it is
     * indistinguishable from "we never looked". Each of these three is a
     * different reason there is no number, and every one of them must come back
     * null even when the column holds a 0 a writer left behind.
     */
    for (const comparability of [
      'NOT_COMPARED',
      'UNCOMPARABLE_NO_BASELINE',
      'UNCOMPARABLE_BASELINE_NOT_ACCEPTED',
    ] as const) {
      expect(newSurfaceWithoutTests({ comparability, newSurfaceWithoutTests: 0 })).toBeNull();
      expect(newSurfaceWithoutTests({ comparability, newSurfaceWithoutTests: 7 })).toBeNull();
    }
  });

  it('refuses to invent a 0 for a COMPARABLE row that carries no count', () => {
    // That row is a bug in the writer. Reporting it as 0 would hide the bug
    // behind a green tick, which is strictly worse than reporting nothing.
    expect(
      newSurfaceWithoutTests({ comparability: 'COMPARABLE', newSurfaceWithoutTests: null }),
    ).toBeNull();
  });
});
