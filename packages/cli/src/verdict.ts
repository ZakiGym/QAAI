/**
 * The CLI's exit code, and the one thing it is not allowed to decide for itself.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * `cmdRun` computed red/green from the run's counters:
 *
 *     view.failedCount > 0 || view.status === 'FAILED' ||
 *     view.status === 'ERRORED' || gateBlocked
 *
 * and four other places in the product computed the same thing their own way —
 * the worker's finaliser, the on-prem finaliser, the GitHub check, the JUnit
 * XML. Exactly one of the five honoured quarantine (the quality gate), so a
 * quarantined test's failure went on failing builds through `failedCount` while
 * having already vanished from every gate rule. Quarantine suppressed the
 * signal and left the gate standing: the team stopped seeing the failure and
 * still could not merge.
 *
 * Five implementations of one rule is why a fix in any of them was invisible to
 * the rest. So the rule now lives in ONE place — `runOutcome` in
 * `packages/runner/src/gates.ts` — the API applies it and returns the answer on
 * the run (`run.verdict`), and this module's job is to READ it.
 *
 * ── Why this is not simply an import ────────────────────────────────────────
 *
 * The CLI ships zero dependencies, and that is a hard constraint rather than a
 * preference: `tsconfig.build.json` compiles `src/` with `rootDir: src` and the
 * package publishes only `dist/`, so any import reaching outside this directory
 * — even a type-only one — fails the build with TS6059 and would be absent from
 * the tarball a customer installs anyway. `npx @qaai/cli` in a CI step that has
 * just exported an API key is what that constraint buys. So the CLI gets the
 * answer over HTTP instead of linking the function, and the fallback below is
 * what it does when the server is older than the answer.
 *
 * Its own module, rather than a function inside `index.ts`, for one reason:
 * `index.ts` is the published `bin` and self-invokes on import, so nothing can
 * import it to test it. `runner.ts` guards its entry point with an
 * `invokedDirectly` check; `index.ts` deliberately does not, because `argv[1]`
 * is the `node_modules/.bin/qaai` SYMLINK while `import.meta.url` is the
 * resolved path, the two would not match, and the shipped binary would exit 0
 * having done nothing. A testable module beside it costs nothing and risks
 * nothing.
 */

/** What `GET /runs/:runId` returns, as far as the exit code is concerned. */
export interface RunVerdictView {
  status: string;
  failedCount: number;
  /**
   * Failures a quarantine suppressed. Absent on a server older than this
   * field, which is exactly the case `verdictOf` has to degrade for.
   */
  quarantinedFailedCount?: number;
  gateResult: { passed: boolean } | null;
  /** The server's own answer. Preferred over anything computed here. */
  verdict?: {
    passed: boolean;
    status?: string;
    suppressedFailures?: number;
    reason?: string;
  } | null;
}

export interface CliVerdict {
  /** False means exit nonzero: the build goes red. */
  passed: boolean;
  /** How many failures quarantine suppressed, as far as this CLI can tell. */
  suppressedFailures: number;
  /** One printable sentence. Always says what happened to suppressed failures. */
  reason: string;
  /**
   * Where the answer came from. Printed in `--json` so a CI step that is
   * getting a surprising exit code can tell whether its server is too old to
   * answer, rather than guessing.
   */
  source: 'server' | 'counters';
}

/**
 * Did this run pass?
 *
 * Prefers the server's verdict, and falls back to the counters only when the
 * server did not send one — a QAAI older than this field, which a customer's CI
 * will absolutely be pointed at for a while after the CLI updates.
 *
 * The fallback is HONEST about its limit rather than quietly approximating. On
 * an old server `failedCount` still includes quarantined failures and
 * `quarantinedFailedCount` is absent, so there is nothing to subtract and the
 * old behaviour is the only behaviour available: a quarantined failure fails
 * the build. That is stated in the reason, because a customer wondering why
 * their quarantine is not working deserves to be told it is their server and
 * not their quarantine.
 */
export function verdictOf(view: RunVerdictView): CliVerdict {
  const suppressed =
    typeof view.verdict?.suppressedFailures === 'number'
      ? view.verdict.suppressedFailures
      : typeof view.quarantinedFailedCount === 'number'
        ? view.quarantinedFailedCount
        : 0;

  if (view.verdict && typeof view.verdict.passed === 'boolean') {
    return {
      passed: view.verdict.passed,
      suppressedFailures: suppressed,
      reason: view.verdict.reason ?? (view.verdict.passed ? 'The run passed.' : 'The run failed.'),
      source: 'server',
    };
  }

  const gateBlocked = view.gateResult ? !view.gateResult.passed : false;
  /*
   * `quarantinedFailedCount` is subtracted when the server sent it. A server
   * new enough to have the column but old enough not to send `verdict` does
   * not exist today, and if it ever does, honouring the column is the right
   * answer and costs one expression.
   */
  const gatingFailures = Math.max(
    0,
    view.failedCount -
      (typeof view.quarantinedFailedCount === 'number' ? view.quarantinedFailedCount : 0),
  );
  const passed =
    gatingFailures === 0 &&
    view.status !== 'FAILED' &&
    view.status !== 'ERRORED' &&
    view.status !== 'CANCELLED' &&
    !gateBlocked;

  const note =
    typeof view.quarantinedFailedCount === 'number'
      ? ''
      : ' This server did not report a verdict, so the exit code was computed from the run ' +
        'counters and a quarantined test that failed WILL have failed this build. Upgrade QAAI ' +
        'to make quarantine stop the gate as well as the signal.';

  return {
    passed,
    suppressedFailures: suppressed,
    reason:
      (passed
        ? `${view.status}: nothing that gates failed.`
        : `${view.status}: ${gatingFailures} test(s) failed${gateBlocked ? ' and a quality gate blocked the run' : ''}.`) +
      (suppressed > 0
        ? ` ${suppressed} failing test(s) were quarantined and did not fail the build — they are still failing.`
        : '') +
      note,
    source: 'counters',
  };
}

/**
 * The one-line summary the CLI prints.
 *
 * Suppressed failures are a COLUMN of their own, never folded into `skipped`.
 * A deliberate skip and a failure somebody switched off are different facts,
 * and a build log that prints them as one number is how a team ships against a
 * suite where a quarter of the checks are off.
 */
export function summaryLine(
  view: {
    status: string;
    passedCount: number;
    failedCount: number;
    flakyCount: number;
    skippedCount: number;
    quarantinedFailedCount?: number;
  },
  verdict: CliVerdict,
): string {
  const parts = [
    `${view.passedCount} passed`,
    `${view.failedCount} failed`,
    `${view.flakyCount} flaky`,
    `${view.skippedCount} skipped`,
  ];
  if (verdict.suppressedFailures > 0) {
    parts.push(`${verdict.suppressedFailures} quarantined and failing`);
  }
  return `${verdict.passed ? '✓' : '✗'} ${view.status}  ${parts.join(' · ')}`;
}
