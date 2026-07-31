/**
 * NUnit 3 XML (`nunit3-console --result=…`, and the NUnit3 result writer used
 * by `dotnet test`).
 *
 * Nothing exotic, but three details are easy to get wrong:
 *
 *  - `duration="0.002153"` is SECONDS as a float, unlike the TRX report the
 *    same test project can also produce, where it is a `TimeSpan` string.
 *  - `result="Skipped"` carries the interesting part in `label` — `Ignored`,
 *    `Explicit` — and the reason in `<reason><message>`, not in `<failure>`.
 *  - Suites nest arbitrarily (Assembly → Namespace → TestFixture → ParameterizedMethod),
 *    so the class a test belongs to is the nearest enclosing fixture, and a
 *    `<test-suite result="Failed">` with no `<test-case>` under it is a
 *    OneTimeSetUp explosion that must not vanish.
 *
 * NUnit **2** used a completely different root (`<test-results>`), and its
 * files are still in circulation. It is detected and named rather than silently
 * returning nothing.
 */

import {
  attr,
  child,
  clip,
  deepText,
  nonEmpty,
  parseXml,
  secondsToMs,
  toNumber,
} from './common.js';
import type { XmlNode } from './common.js';
import { finaliseReport, makeTest, unreadableReport } from './types.js';
import type { ParsedReport, ReportTest, ReportTestStatus } from './types.js';

const FORMAT = 'nunit3' as const;

const RESULTS: Record<string, ReportTestStatus> = {
  passed: 'passed',
  failed: 'failed',
  error: 'failed',
  skipped: 'skipped',
  ignored: 'skipped',
  inconclusive: 'skipped',
  notrunnable: 'skipped',
  // A warning is an assertion the author chose not to fail on.
  warning: 'passed',
};

export function parseNUnit3(text: string): ParsedReport {
  const doc = parseXml(text);
  const diagnostics = [...doc.diagnostics];
  let truncated = doc.truncated;

  const run = doc.roots.find((r) => r.name.toLowerCase() === 'test-run');
  if (!run) {
    const v2 = doc.roots.find((r) => r.name.toLowerCase() === 'test-results');
    if (v2) {
      return unreadableReport(
        FORMAT,
        'This is an NUnit 2 result file (<test-results>), not NUnit 3 (<test-run>). Re-run with the NUnit3 result format.',
        { truncated, diagnostics },
      );
    }
    return unreadableReport(
      FORMAT,
      'No <test-run> root element — this file is not an NUnit 3 report.',
      {
        truncated,
        diagnostics,
      },
    );
  }

  const tests: ReportTest[] = [];
  walk(run, null, tests);

  // `total` is what the run reported; `testcasecount` is what it discovered,
  // and the two legitimately differ when a fixture's OneTimeSetUp explodes. A
  // mismatch is worth saying out loud but is not, on its own, evidence of a
  // half-written file — `parseXml` reports that directly.
  const declared = toNumber(attr(run, 'total')) ?? toNumber(attr(run, 'testcasecount'));
  if (declared !== null && declared !== tests.length) {
    diagnostics.push(
      `<test-run total="${declared}"> but the file yielded ${tests.length} result(s).`,
    );
  }

  const duration = toNumber(attr(run, 'duration'));

  return finaliseReport(FORMAT, {
    suiteName: nonEmpty(attr(run, 'fullname')) ?? nonEmpty(attr(run, 'name')),
    tests,
    durationMs: duration === null ? null : Math.round(duration * 1000),
    truncated,
    diagnostics,
  });
}

function walk(node: XmlNode, fixture: string | null, out: ReportTest[]): void {
  for (const c of node.children) {
    const name = c.name.toLowerCase();

    if (name === 'test-case') {
      out.push(toTest(c, fixture ?? ''));
      continue;
    }

    if (name !== 'test-suite') continue;

    const classname = nonEmpty(attr(c, 'classname'));
    const fullname = nonEmpty(attr(c, 'fullname'));
    const suiteType = (attr(c, 'type') ?? '').toLowerCase();
    // Assembly and Namespace suites are directories, not classes; only a
    // fixture (or a parameterised method) names something a person recognises.
    const nextFixture =
      classname ??
      (suiteType === 'assembly' || suiteType === 'namespace'
        ? fixture
        : (fullname ?? nonEmpty(attr(c, 'name')) ?? fixture));

    // A suite that failed on its own — OneTimeSetUp threw — has a <failure>
    // child and no case beneath it to carry the message. Without this, the
    // fixture that never ran reports as nothing at all.
    const failure = child(c, 'failure');
    if (failure && countCases(c) === 0) {
      const described = describeFailure(failure);
      out.push(
        makeTest({
          suite: nextFixture ?? '',
          name: `${nonEmpty(attr(c, 'name')) ?? 'suite'} (suite-level failure)`,
          status: 'failed',
          durationMs: secondsToMs(attr(c, 'duration')),
          failureMessage: described.message,
          stack: described.stack,
        }),
      );
    }

    walk(c, nextFixture, out);
  }
}

function countCases(node: XmlNode): number {
  let n = 0;
  for (const c of node.children) {
    if (c.name.toLowerCase() === 'test-case') n += 1;
    else n += countCases(c);
  }
  return n;
}

function toTest(node: XmlNode, fixture: string): ReportTest {
  const result = (attr(node, 'result') ?? '').toLowerCase();
  const status = RESULTS[result] ?? 'failed';
  const durationMs = secondsToMs(attr(node, 'duration'));
  const name = nonEmpty(attr(node, 'name')) ?? nonEmpty(attr(node, 'fullname')) ?? 'unnamed test';
  const suite = nonEmpty(attr(node, 'classname')) ?? fixture;

  if (status === 'failed') {
    const failure = child(node, 'failure');
    const described = failure
      ? describeFailure(failure)
      : { message: `result="${attr(node, 'result') ?? 'unknown'}"`, stack: null };
    return makeTest({
      suite,
      name,
      status,
      durationMs,
      failureMessage: described.message,
      stack: described.stack,
    });
  }

  return makeTest({ suite, name, status, durationMs });
}

function describeFailure(failure: XmlNode): { message: string; stack: string | null } {
  const message = nonEmpty(deepText(child(failure, 'message') ?? failure));
  const stack = nonEmpty(
    deepText(child(failure, 'stack-trace') ?? { name: '', attrs: {}, children: [], text: '' }),
  );
  return { message: clip(message ?? 'failed'), stack: stack ? clip(stack) : null };
}
