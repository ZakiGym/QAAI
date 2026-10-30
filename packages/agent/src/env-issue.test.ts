/**
 * Tests for ENV_ISSUE handling.
 *
 * THE ATTACK ON THIS FEATURE IS THE SUBJECT OF THIS FILE, and it is an easy
 * mistake rather than a malicious one: ENV_ISSUE takes a gate off, so anything
 * that can be talked into producing one can make a real failure disappear. A
 * model returns ENV_ISSUE for a 500 that is the application's own fault, and if
 * the model's word were enough the suite would go quiet while the product was
 * broken.
 *
 * So the first block proves a healthy environment CANNOT produce a suppression,
 * at run time and at compile time, and everything after it is the ordinary
 * behaviour. The second-most-dangerous failure is a quiet one — a gate that
 * comes off and tells nobody — so the alert and the count are asserted as
 * hard as the refusals.
 */

import { describe, expect, it } from 'vitest';
import {
  DETAIL_REFUSED,
  ENVIRONMENT_VERDICTS,
  ENV_CHECK_NAMES,
  ENV_CHECK_RULES,
  ENV_DETAIL_MAX_CHARS,
  ENV_ISSUE_REFUSALS,
  ENV_RETRY_DELAY_MS,
  ENV_RETRY_MAX_ATTEMPTS,
  classifyEnvironment,
  coverageForEnvIssueRun,
  envIssueSuppression,
  envRetryDecision,
  environmentAlert,
  probeEnvironment,
  safeDetail,
} from './env-issue.js';
import type { EnvCheck, EnvCheckName, EnvironmentEvidence, EnvProbeIo } from './env-issue.js';

const NOW = new Date('2026-10-29T12:00:00.000Z');
const RUN = 'run-7';

const ok = (name: EnvCheckName): EnvCheck => ({ name, outcome: 'OK', detail: `${name} answered` });
const down = (name: EnvCheckName): EnvCheck => ({
  name,
  outcome: 'UNAVAILABLE',
  detail: `${name} did not answer`,
});
const unknown = (name: EnvCheckName): EnvCheck => ({
  name,
  outcome: 'UNKNOWN',
  detail: `${name} was not probed`,
});

const HUMAN = { kind: 'USER', userId: 'user-dana' } as const;

function suppress(evidence: EnvironmentEvidence, classification = classifyEnvironment([])) {
  return envIssueSuppression({
    evidence,
    classification,
    runId: RUN,
    failures: 40,
    owner: HUMAN,
    ownerProvenance: 'EXPLICIT_ASSIGNMENT',
    now: NOW,
  });
}

/** The only legal way to get evidence: measure a broken environment. */
function brokenEvidence(checks: readonly EnvCheck[] = [down('BASE_URL'), ok('TOOLING')]) {
  const classification = classifyEnvironment(checks);
  expect(classification.verdict).toBe('BROKEN');
  return { classification, evidence: classification.evidence! };
}

// ─── 1. A healthy environment cannot produce an ENV_ISSUE suppression ────────

describe('ENV_ISSUE cannot be used to make a real failure disappear', () => {
  it('REFUSES when every check passed', () => {
    // The evidence is real — borrowed from a genuinely broken classification —
    // and the classification handed in says HEALTHY. That is the shape of the
    // mistake: a stale or borrowed proof against a live healthy reading.
    const { evidence } = brokenEvidence();
    const healthy = classifyEnvironment(ENV_CHECK_NAMES.map(ok));
    expect(healthy.verdict).toBe('HEALTHY');

    const decision = suppress(evidence, healthy);
    expect(decision.suppressed).toBe(false);
    expect(decision).toMatchObject({
      refusal: 'ENVIRONMENT_HEALTHY',
      path: 'classification.verdict',
    });
  });

  it('REFUSES when the environment could not be measured at all', () => {
    const { evidence } = brokenEvidence();
    for (const classification of [
      classifyEnvironment([]),
      classifyEnvironment([ok('BASE_URL'), unknown('LOGIN')]),
    ]) {
      expect(classification.verdict).toBe('UNKNOWN');
      const decision = suppress(evidence, classification);
      expect(decision.suppressed).toBe(false);
      expect(decision).toMatchObject({ refusal: 'ENVIRONMENT_UNKNOWN' });
    }
  });

  it('has no object-literal path to the evidence, so the rule is the type system’s', () => {
    // THE STRUCTURAL HALF. `EnvironmentEvidence` carries a private witness
    // symbol, so "a model said ENV_ISSUE, therefore the gate comes off" is not
    // a path that exists — the value the function needs cannot be written.
    // @ts-expect-error — the witness symbol is not exported; only classifyEnvironment mints one.
    const forged: EnvironmentEvidence = {
      verdict: 'BROKEN',
      failed: [down('BASE_URL')],
      considered: [down('BASE_URL')],
      retryable: true,
    };
    void forged;
  });

  it('refuses to record a suppression of nothing', () => {
    const { classification, evidence } = brokenEvidence();
    const decision = envIssueSuppression({
      evidence,
      classification,
      runId: RUN,
      failures: 0,
      owner: HUMAN,
      ownerProvenance: 'EXPLICIT_ASSIGNMENT',
      now: NOW,
    });
    expect(decision).toMatchObject({ refusal: 'NOTHING_TO_SUPPRESS', path: 'failures' });
  });

  it('names every refusal in its own vocabulary', () => {
    expect([...ENV_ISSUE_REFUSALS]).toEqual([
      'ENVIRONMENT_HEALTHY',
      'ENVIRONMENT_UNKNOWN',
      'NOTHING_TO_SUPPRESS',
      'SUPPRESSION_REFUSED',
    ]);
  });
});

// ─── 2. UNKNOWN is a verdict, and it is not a soft BROKEN ────────────────────

describe('"we could not tell" is an answer, and it suppresses nothing', () => {
  it('names every verdict', () => {
    expect([...ENVIRONMENT_VERDICTS]).toEqual(['HEALTHY', 'BROKEN', 'UNKNOWN']);
  });

  it('is UNKNOWN when nothing was checked', () => {
    const result = classifyEnvironment([]);
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.evidence).toBeNull();
    expect(result.disclosure).toContain('was not checked');
  });

  it('is UNKNOWN when three checks pass and the fourth could not answer', () => {
    // Not HEALTHY. The fourth check is the one that would have told us, and a
    // clean bill of health from the three that did answer is a pass that means
    // nobody checked.
    const result = classifyEnvironment([ok('BASE_URL'), ok('LOGIN'), unknown('TOOLING')]);
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.unknown.map((c) => c.name)).toEqual(['TOOLING']);
  });

  it('is HEALTHY only when every check answered OK', () => {
    expect(classifyEnvironment(ENV_CHECK_NAMES.map(ok)).verdict).toBe('HEALTHY');
  });

  it('is BROKEN on one environmental failure, and mints the evidence', () => {
    const result = classifyEnvironment([down('LOGIN'), ok('BASE_URL')]);
    expect(result.verdict).toBe('BROKEN');
    expect(result.evidence?.failed.map((c) => c.name)).toEqual(['LOGIN']);
    // Every check considered, so a reader can see what was NOT the problem.
    expect(result.evidence?.considered).toHaveLength(2);
  });

  it('every check name has a rule saying whether it is environmental and retryable', () => {
    const named = Object.keys(ENV_CHECK_RULES).sort();
    expect(named).toEqual([...ENV_CHECK_NAMES].sort());
    // LOGIN is the one that must not be retried: retrying a rejected login is
    // how an account gets locked out.
    expect(ENV_CHECK_RULES.LOGIN.retryable).toBe(false);
    expect(ENV_CHECK_RULES.BASE_URL.retryable).toBe(true);
  });
});

// ─── 3. The retry policy ─────────────────────────────────────────────────────

describe('the transient case is retried, once, and the budget is disclosed', () => {
  it('retries a dead base URL on the first attempt', () => {
    const { classification } = brokenEvidence([down('BASE_URL')]);
    const decision = envRetryDecision(classification, 1);
    expect(decision).toMatchObject({ retry: true, delayMs: ENV_RETRY_DELAY_MS });
    expect(decision.attemptsRemaining).toBe(ENV_RETRY_MAX_ATTEMPTS - 1);
  });

  it('reports the budget as a count AND a reason when it bites', () => {
    const { classification } = brokenEvidence([down('BASE_URL')]);
    const decision = envRetryDecision(classification, ENV_RETRY_MAX_ATTEMPTS);
    expect(decision.retry).toBe(false);
    expect(decision.attemptsRemaining).toBe(0);
    expect(decision.reason).toContain(`budget of ${ENV_RETRY_MAX_ATTEMPTS}`);
  });

  it('never retries an expired credential', () => {
    const { classification } = brokenEvidence([down('LOGIN')]);
    const decision = envRetryDecision(classification, 1);
    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain('needs a person');
  });

  it('refuses to retry a healthy environment, which would be retrying a real failure', () => {
    const decision = envRetryDecision(classifyEnvironment(ENV_CHECK_NAMES.map(ok)), 1);
    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain('mistaken for a flake');
  });

  it('refuses to retry on an unknown, because an unknown is not grounds for a run', () => {
    expect(envRetryDecision(classifyEnvironment([]), 1).retry).toBe(false);
  });

  it('retries a mixed failure only when EVERY failed check is retryable', () => {
    const { classification } = brokenEvidence([down('BASE_URL'), down('LOGIN')]);
    expect(classification.evidence?.retryable).toBe(false);
    expect(envRetryDecision(classification, 1).retry).toBe(false);
  });
});

// ─── 4. The suppression itself: counted, run-scoped, denominator-safe ────────

describe('a genuine environment failure takes the gate off, out loud', () => {
  it('suppresses, counts, and keeps the surfaces in the denominator', () => {
    const { classification, evidence } = brokenEvidence();
    const decision = envIssueSuppression({
      evidence,
      classification,
      runId: RUN,
      failures: 40,
      owner: HUMAN,
      ownerProvenance: 'EXPLICIT_ASSIGNMENT',
      now: NOW,
    });
    expect(decision.suppressed).toBe(true);
    if (!decision.suppressed) return;

    expect(decision.failures).toBe(40);
    // An environment failure never removes a surface from the measurement: the
    // application still has every surface it had.
    expect(decision.denominator).toBe('STAYS_COUNTED');
    expect(decision.disclosure).toContain('40 failure(s) did not gate');
    expect(decision.disclosure).toContain('still failures that happened');
  });

  it('is RUN-scoped, so it cannot silence a second run', () => {
    const { classification, evidence } = brokenEvidence();
    const decision = suppress(evidence, classification);
    expect(decision.suppressed).toBe(true);
    if (!decision.suppressed || !decision.decision.applied) return;

    expect(decision.decision.suppression.target).toEqual({ scope: 'RUN', key: RUN });
    // The keystone stamps a bound the run cannot outlive — an hour, which is
    // longer than any run and shorter than any shift.
    expect(decision.decision.suppression.expiresAt.getTime()).toBe(NOW.getTime() + 3_600_000);
    expect(decision.decision.suppression.matchCount).toBe(0);
    expect(decision.decision.suppression.revokedAt).toBeNull();
  });

  it('is allowed to have no human owner, because nobody signs it', () => {
    // ENV_ISSUE is the one kind `requiresHumanOwner` is false for. It is
    // bounded by its RUN scope instead, and a weak owner is still better than
    // none for telling somebody.
    const { classification, evidence } = brokenEvidence();
    const decision = envIssueSuppression({
      evidence,
      classification,
      runId: RUN,
      failures: 1,
      owner: { kind: 'TEAM', teamId: 'team-platform' },
      ownerProvenance: 'RULE_PATH',
      now: NOW,
    });
    expect(decision.suppressed).toBe(true);
  });

  it('carries the keystone’s own refusal rather than inventing one', () => {
    const { classification, evidence } = brokenEvidence();
    const decision = envIssueSuppression({
      evidence,
      classification,
      runId: '   ',
      failures: 1,
      owner: HUMAN,
      ownerProvenance: 'EXPLICIT_ASSIGNMENT',
      now: NOW,
    });
    expect(decision).toMatchObject({
      suppressed: false,
      refusal: 'SUPPRESSION_REFUSED',
      path: 'target.key',
    });
  });

});

// ─── 5. The coverage number for a run that measured nothing ──────────────────

describe('a run that measured nothing reports NULL, not zero', () => {
  it('returns null', () => {
    const { evidence } = brokenEvidence();
    const coverage = coverageForEnvIssueRun(evidence);
    // "We could not look" and "nothing is covered" must never be the same
    // value: a team watching a trend would see a cliff and go hunting for
    // deleted tests.
    expect(coverage.percent).toBeNull();
    expect(coverage.percent).not.toBe(0);
    expect(coverage.reason).toContain('UNAVAILABLE, not 0%');
  });

  it('keeps the surfaces in the denominator', () => {
    const { evidence } = brokenEvidence();
    expect(coverageForEnvIssueRun(evidence).denominator).toBe('STAYS_COUNTED');
    expect(coverageForEnvIssueRun(evidence).reason).toContain('still');
  });
});

// ─── 6. The alert, and the credentials that must never reach it ──────────────

describe('somebody is told, and the alert cannot be composed from borrowed text', () => {
  it('names the run and the checks, and nothing else', () => {
    const { classification, evidence } = brokenEvidence([down('LOGIN')]);
    const alert = environmentAlert({
      classification,
      evidence,
      runId: RUN,
      failures: 12,
      owner: HUMAN,
      ownerProvenance: 'EXPLICIT_ASSIGNMENT',
    });
    expect(alert.subject).toBe(`Environment failure on run ${RUN}: LOGIN`);
    expect(alert.failedChecks).toEqual(['LOGIN']);
    expect(alert.body).toContain('not a regression');
    expect(alert.body).toContain('UNAVAILABLE rather than lower');
  });

  it('will not page on a glob’s guess', () => {
    const { classification, evidence } = brokenEvidence();
    const paged = (provenance: Parameters<typeof environmentAlert>[0]['ownerProvenance']) =>
      environmentAlert({
        classification,
        evidence,
        runId: RUN,
        failures: 1,
        owner: HUMAN,
        ownerProvenance: provenance,
      }).mayPage;
    expect(paged('EXPLICIT_ASSIGNMENT')).toBe(true);
    expect(paged('RULE_PATH')).toBe(true);
    // A catch-all glob bulk-copied out of a CODEOWNERS file does not get to
    // wake somebody at 3am.
    expect(paged('CODEOWNERS_IMPORT')).toBe(false);
    expect(paged('LAST_EDITOR')).toBe(false);
  });

  it('cannot page when there is nobody to page, whatever the provenance claims', () => {
    const { classification, evidence } = brokenEvidence();
    const alert = environmentAlert({
      classification,
      evidence,
      runId: RUN,
      failures: 1,
      owner: null,
      ownerProvenance: 'EXPLICIT_ASSIGNMENT',
    });
    expect(alert.mayPage).toBe(false);
  });

  it('REFUSES a detail that carries a location, because a base URL carries tokens', () => {
    const leaky = safeDetail('could not reach https://app.example.com/?access_token=abc123');
    expect(leaky.refused).toBe(true);
    expect(leaky.detail).toBe(DETAIL_REFUSED);
    expect(leaky.detail).not.toContain('abc123');
    expect(leaky.detail).not.toContain('example.com');
  });

  it('REFUSES a detail that names a credential, in any case', () => {
    for (const text of [
      'Authorization header rejected',
      'bad Bearer value',
      'TOKEN=zzz was stale',
      'password did not match',
      'the api_key is wrong',
      'SECRET rotated',
    ]) {
      expect(safeDetail(text).refused, text).toBe(true);
    }
  });

  it('keeps an ordinary failure class, including the http= facet the clusterer writes', () => {
    expect(safeDetail('http=503 from the health check').refused).toBe(false);
    expect(safeDetail('connection refused').detail).toBe('connection refused');
  });

  it('bounds a long detail and DISCLOSES that it did', () => {
    const long = 'x'.repeat(ENV_DETAIL_MAX_CHARS + 50);
    const bounded = safeDetail(long);
    expect(bounded.truncated).toBe(true);
    expect(bounded.detail).toContain('50 more characters not shown');
  });

  it('counts every refused and truncated detail in the classification', () => {
    const result = classifyEnvironment([
      { name: 'BASE_URL', outcome: 'UNAVAILABLE', detail: 'refused https://x.test/?token=t' },
      { name: 'LOGIN', outcome: 'UNAVAILABLE', detail: 'y'.repeat(ENV_DETAIL_MAX_CHARS + 1) },
    ]);
    expect(result.detailsRefused).toBe(1);
    expect(result.detailsTruncated).toBe(1);
    expect(result.disclosure).toContain('withheld for naming a location or a credential');
    expect(result.disclosure).toContain(`cut to ${ENV_DETAIL_MAX_CHARS} characters`);
    // And the guard ran BEFORE the evidence was minted, so no render site can
    // reach an unchecked detail.
    expect(result.evidence?.failed[0]?.detail).toBe(DETAIL_REFUSED);
  });

  it('never carries a refused detail into the alert', () => {
    const result = classifyEnvironment([
      { name: 'BASE_URL', outcome: 'UNAVAILABLE', detail: 'https://x.test/?token=sekret' },
    ]);
    const alert = environmentAlert({
      classification: result,
      evidence: result.evidence!,
      runId: RUN,
      failures: 1,
      owner: HUMAN,
      ownerProvenance: 'EXPLICIT_ASSIGNMENT',
    });
    expect(alert.evidence.join(' ')).not.toContain('sekret');
    expect(alert.evidence.join(' ')).toContain(DETAIL_REFUSED);
  });
});

// ─── 7. Probing, with no network anywhere ────────────────────────────────────

describe('the probes are injected, so this path has no network and no key', () => {
  it('builds OK checks from probes that answer', async () => {
    const io: EnvProbeIo = {
      reachTarget: async () => ({ reached: true, detail: 'answered 200' }),
      checkAuth: async () => ({ valid: true, detail: 'session valid' }),
      checkDependencies: async () => [{ name: 'postgres', up: true, detail: 'up' }],
    };
    expect((await probeEnvironment(io)).verdict).toBe('HEALTHY');
  });

  it('produces UNKNOWN for a probe that was not supplied, never OK', () => {
    // "We did not look" must not read as "it was fine": an absent probe is the
    // most likely way this path gets a free pass.
    return probeEnvironment({}).then((result) => {
      expect(result.verdict).toBe('UNKNOWN');
      expect(result.unknown.map((c) => c.name).sort()).toEqual(['BASE_URL', 'LOGIN', 'TOOLING']);
    });
  });

  it('produces UNKNOWN for a probe that THREW, not UNAVAILABLE', async () => {
    // A probe that blew up told us about the probe. Treating it as a failure
    // would be a path from "our code crashed" to "the gate comes off".
    const result = await probeEnvironment({
      reachTarget: async () => {
        throw new Error('connect ECONNRESET https://app.example.com/?token=leak');
      },
      checkAuth: async () => ({ valid: true, detail: 'session valid' }),
      checkDependencies: async () => [],
    });
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.failed).toEqual([]);
    // And the thrown error's text — which carried a URL and a token — is
    // nowhere in the output, because it is never read.
    expect(JSON.stringify(result)).not.toContain('leak');
    expect(JSON.stringify(result)).not.toContain('example.com');
  });

  it('reports a dependency that is down by NAME and reaches BROKEN', async () => {
    const result = await probeEnvironment({
      reachTarget: async () => ({ reached: true, detail: 'answered 200' }),
      checkAuth: async () => ({ valid: true, detail: 'session valid' }),
      checkDependencies: async () => [
        { name: 'postgres', up: true, detail: 'up' },
        { name: 'redis', up: false, detail: 'connection refused' },
      ],
    });
    expect(result.verdict).toBe('BROKEN');
    expect(result.failed.map((c) => c.name)).toEqual(['TOOLING']);
    expect(result.failed[0]?.detail).toContain('1 of 2 dependency(ies) down: redis');
  });

  it('turns an invalid session into a BROKEN environment that is not retried', async () => {
    const result = await probeEnvironment({
      reachTarget: async () => ({ reached: true, detail: 'answered 200' }),
      checkAuth: async () => ({ valid: false, detail: 'session expired' }),
      checkDependencies: async () => [],
    });
    expect(result.verdict).toBe('BROKEN');
    expect(envRetryDecision(result, 1).retry).toBe(false);
  });
});
