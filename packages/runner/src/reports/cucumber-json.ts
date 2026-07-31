/**
 * Cucumber JSON — one array of features, and two dialects that share it.
 *
 * The unit of a test here is the **scenario**, not the step. Steps are the
 * scenario's implementation, so a report of steps counts the same test three or
 * ten times and hides which scenario is red.
 *
 * The dialect split matters because it is a unit difference, not a naming one:
 *
 *  - Cucumber (JS, JVM, Ruby) writes `result.duration` in NANOSECONDS.
 *  - Behave writes `result.duration` in SECONDS, as a float, and its
 *    `error_message` is an array of lines rather than a string.
 *
 * Reading behave's seconds as nanoseconds reports every scenario as 0 ms;
 * reading cucumber's nanoseconds as seconds reports a 12 ms step as four
 * months. The dialect is detected from behave's own tells before any duration
 * is converted.
 *
 * Other traps handled here:
 *  - `type: "background"` elements are not scenarios and must not be counted.
 *  - A failing `before`/`after` hook fails a scenario in which every step
 *    passed or was skipped, and lives outside the `steps` array entirely.
 *  - `undefined` steps (no matching step definition) are treated as failures.
 *    A scenario whose steps are not implemented has not been verified, and
 *    reporting it green is worse than reporting it red.
 */

import {
  asArray,
  asString,
  clip,
  isRecord,
  nanosToMs,
  nonEmpty,
  parseJsonLoose,
  secondsToMs,
  toNumber,
} from './common.js';
import { finaliseReport, makeTest, unreadableReport } from './types.js';
import type { ParsedReport, ReportTest, ReportTestStatus } from './types.js';

const FORMAT = 'cucumber-json' as const;

/** Worst-first: a scenario takes the most severe status among its steps. */
const SEVERITY: Record<string, number> = {
  passed: 0,
  skipped: 1,
  untested: 1,
  pending: 2,
  undefined: 3,
  ambiguous: 4,
  failed: 5,
  error: 6,
};

const STEP_STATUS: Record<string, ReportTestStatus> = {
  passed: 'passed',
  skipped: 'skipped',
  // behave marks steps after a failure "untested" — they did not run.
  untested: 'skipped',
  pending: 'skipped',
  undefined: 'failed',
  ambiguous: 'failed',
  failed: 'failed',
  // behave's scenario-level status when a hook or step raised rather than
  // asserted. Never a pass.
  error: 'failed',
};

export function parseCucumberJson(text: string): ParsedReport {
  const parsed = parseJsonLoose(text);
  const diagnostics = [...parsed.diagnostics];
  const truncated = parsed.truncated;

  if (!parsed.ok || !Array.isArray(parsed.value)) {
    return unreadableReport(
      FORMAT,
      'The report is not a JSON array of features — this is not Cucumber JSON.',
      {
        truncated,
        diagnostics,
      },
    );
  }

  const features = parsed.value;
  const behave = looksLikeBehave(features);
  if (behave) diagnostics.push('Read as Behave JSON: step durations are seconds, not nanoseconds.');

  const tests: ReportTest[] = [];
  let sawFeature = false;

  for (const feature of features) {
    if (!isRecord(feature)) continue;
    sawFeature = true;
    const featureName =
      asString(feature['name']) ?? asString(feature['uri']) ?? asString(feature['location']) ?? '';

    for (const element of asArray(feature['elements'])) {
      if (!isRecord(element)) continue;
      const type = (asString(element['type']) ?? 'scenario').toLowerCase();
      // Background steps are re-run for each scenario and are already reflected
      // in that scenario's result.
      if (type === 'background') continue;

      tests.push(toScenario(element, featureName, behave));
    }
  }

  if (!sawFeature && features.length > 0) {
    return unreadableReport(
      FORMAT,
      'The JSON array contains no feature objects — this is not Cucumber JSON.',
      {
        truncated,
        diagnostics,
      },
    );
  }

  return finaliseReport(FORMAT, {
    suiteName:
      features.length === 1 && isRecord(features[0]) ? asString(features[0]['name']) : null,
    tests,
    truncated,
    diagnostics,
  });
}

function toScenario(
  element: Record<string, unknown>,
  featureName: string,
  behave: boolean,
): ReportTest {
  const name = asString(element['name']) ?? 'unnamed scenario';

  let worst = 'passed';
  // Accumulated in the report's own unit and converted once: rounding each step
  // to milliseconds first reports a scenario of ten sub-millisecond steps as 0.
  let rawDuration = 0;
  const failures: string[] = [];

  const record = (result: unknown, label: string): void => {
    if (!isRecord(result)) return;
    const status = (asString(result['status']) ?? 'passed').toLowerCase();
    if ((SEVERITY[status] ?? 5) > (SEVERITY[worst] ?? 0)) worst = status;
    rawDuration += toNumber(result['duration']) ?? 0;

    if (status === 'failed' || status === 'ambiguous') {
      const message = errorMessage(result['error_message']);
      failures.push(message ? `${label}\n${message}` : label);
    } else if (status === 'undefined') {
      failures.push(`${label}\n  No step definition matches this step.`);
    }
  };

  // Hooks first: a Before that throws is why every step is "skipped".
  for (const key of ['before', 'after'] as const) {
    for (const hook of asArray(element[key])) {
      if (isRecord(hook)) record(hook['result'], `${key === 'before' ? 'Before' : 'After'} hook`);
    }
  }

  for (const step of asArray(element['steps'])) {
    if (!isRecord(step)) continue;
    const keyword = (asString(step['keyword']) ?? '').trim();
    const stepName = asString(step['name']) ?? '';
    record(step['result'], `${keyword} ${stepName}`.trim());
  }

  // Behave states the scenario's own verdict; cucumber does not.
  const declared = behave ? (asString(element['status']) ?? '').toLowerCase() : '';
  const status = STEP_STATUS[declared] ?? STEP_STATUS[worst] ?? 'failed';

  return makeTest({
    suite: featureName,
    name,
    status,
    durationMs: behave ? secondsToMs(rawDuration) : nanosToMs(rawDuration),
    failureMessage: status === 'failed' ? clip(failures.join('\n\n')) || `scenario ${worst}` : null,
    stack: null,
  });
}

/**
 * `error_message` is a string in cucumber and in behave 1.3, and an array of
 * lines in behave 1.2.6 — which is still what most CI images ship.
 */
function errorMessage(value: unknown): string | null {
  if (typeof value === 'string') return nonEmpty(value);
  if (Array.isArray(value))
    return nonEmpty(value.filter((l): l is string => typeof l === 'string').join('\n'));
  return null;
}

/**
 * Behave's tells, checked before any duration is converted:
 *   - it writes `location` ("file.feature:9") where cucumber writes `uri` and
 *     `line` — the most reliable one, and true of every behave version;
 *   - it puts a `status` on the scenario element, which cucumber never does;
 *   - behave 1.2.6 writes `error_message` as an array.
 * A non-integer `duration` is the last resort: nanoseconds are always integers.
 */
function looksLikeBehave(features: unknown[]): boolean {
  for (const feature of features) {
    if (!isRecord(feature)) continue;
    if (typeof feature['location'] === 'string' && feature['uri'] === undefined) return true;

    for (const element of asArray(feature['elements'])) {
      if (!isRecord(element)) continue;
      if (typeof element['status'] === 'string') return true;
      for (const step of asArray(element['steps'])) {
        if (!isRecord(step)) continue;
        const result = step['result'];
        if (!isRecord(result)) continue;
        if (Array.isArray(result['error_message'])) return true;
        const duration = result['duration'];
        if (typeof duration === 'number' && !Number.isInteger(duration)) return true;
      }
    }
  }
  return false;
}
