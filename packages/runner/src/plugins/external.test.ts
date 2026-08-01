/**
 * A missing dependency on the WORKER must never be recorded as a failing test.
 *
 * This repo has now made that mistake four times — a missing Firefox binary, a
 * missing mutation tool, a missing CLI, and finally a suite that could not
 * import its own dependencies. The first three were caught because the tool was
 * absent and produced no report. The fourth slipped through precisely because
 * the runner DID produce a well-formed report: every "failure" in it was one
 * collection error, and the suite was reported as the customer's application
 * being broken.
 *
 * The counter-test matters as much as the test: a real assertion failure must
 * still be a failure, or this classifier becomes a way to hide bugs.
 */

import { describe, expect, it } from 'vitest';
import { parseReport } from '../reports/index.js';
import { onlyLoadErrors } from './external.js';

function junit(cases: Array<[name: string, failure: string]>): string {
  return (
    `<?xml version="1.0"?><testsuites><testsuite name="s" tests="${cases.length}">` +
    cases
      .map(([name, failure]) =>
        failure
          ? `<testcase name="${name}"><failure message="${failure}"/></testcase>`
          : `<testcase name="${name}"/>`,
      )
      .join('') +
    `</testsuite></testsuites>`
  );
}

const classify = (xml: string): string | null => onlyLoadErrors(parseReport('junit-xml', xml));

describe('a suite that could not load is a config gap, not a failure', () => {
  it.each([
    ['pytest', "ModuleNotFoundError: No module named 'playwright'"],
    ['node', 'Cannot find module @playwright/test'],
    ['node esm', 'ERR_MODULE_NOT_FOUND'],
    ['java', 'java.lang.NoClassDefFoundError: org/junit/Test'],
    ['ruby', 'LoadError: cannot load such file -- capybara'],
    ['pytest collection', 'error during collection'],
  ])('detects a %s load error', (_label, message) => {
    expect(classify(junit([['setup', message]]))).not.toBeNull();
  });
});

describe('but a real failure stays a failure', () => {
  it('does not downgrade an assertion failure', () => {
    expect(classify(junit([['total', 'expected 10.8 to be 10.79']]))).toBeNull();
  });

  it('does not downgrade when only SOME failures are load errors', () => {
    // One bad import among forty real tests is a failing suite, not a gap.
    expect(
      classify(
        junit([
          ['a', "ModuleNotFoundError: No module named 'x'"],
          ['b', 'expected 1 to be 2'],
        ]),
      ),
    ).toBeNull();
  });

  it('does nothing when everything passed', () => {
    expect(classify(junit([['a', ''], ['b', '']]))).toBeNull();
  });

  it('matches on the failure message, never on a test name', () => {
    // A test legitimately named after the error it asserts on must not be swept up.
    expect(
      classify(junit([['reports a helpful ModuleNotFoundError', 'expected true to be false']])),
    ).toBeNull();
  });
});
