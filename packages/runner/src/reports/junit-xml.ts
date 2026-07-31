/**
 * JUnit XML — the common denominator, and the format everyone disagrees about.
 *
 * There is no JUnit XML specification. There is an Ant task from 2001 that
 * every runner copied differently, so "we parse JUnit" is only true if it means
 * all of these:
 *
 *  - Surefire writes a bare `<testsuite>` root with no `<testsuites>` wrapper,
 *    and on a rerun adds `<flakyFailure>` / `<rerunFailure>` children. A test
 *    carrying only `<flakyFailure>` PASSED — it failed once and passed on
 *    retry. Matching `<failure` loosely marks those runs red forever.
 *  - pytest wraps its suite in `<testsuites>`, puts the skip reason in a
 *    `message` attribute, uses a dotted module path for `classname`, and (via
 *    ElementTree) does not escape `>` inside attribute values.
 *  - jest-junit's default templates set `classname` and `name` to the SAME
 *    string, so joining them yields "adds numbers › adds numbers", and its
 *    `<failure>` element carries no `message` attribute at all — the assertion
 *    text is the element body.
 *
 * On top of that: nested `<testsuite>` elements, `<system-out>` blocks that can
 * contain anything a test printed (including XML that looks like more test
 * cases), and per-suite counters that disagree with the elements present when
 * the writer was killed.
 */

import {
  attr,
  children,
  deepText,
  firstLine,
  nonEmpty,
  parseXml,
  secondsToMs,
  toNumber,
} from './common.js';
import type { XmlNode } from './common.js';
import { finaliseReport, makeTest, unreadableReport } from './types.js';
import type { ParsedReport, ReportTest } from './types.js';

const FORMAT = 'junit-xml' as const;

export function parseJUnitXml(text: string): ParsedReport {
  const doc = parseXml(text);
  const diagnostics = [...doc.diagnostics];
  let truncated = doc.truncated;

  const suiteNodes: XmlNode[] = [];
  const rootSuites: XmlNode[] = [];
  let wrapperName: string | null = null;
  let wrapperTime: number | null = null;

  for (const root of doc.roots) {
    const name = root.name.toLowerCase();
    if (name === 'testsuites') {
      wrapperName = nonEmpty(attr(root, 'name'));
      const t = toNumber(attr(root, 'time'));
      if (t !== null) wrapperTime = Math.round(t * 1000);
      rootSuites.push(...collectSuites(root));
    } else if (name === 'testsuite') {
      rootSuites.push(root, ...collectSuites(root));
    }
  }
  suiteNodes.push(...rootSuites);

  if (suiteNodes.length === 0) {
    // No <testsuite> anywhere. Some emitters (rare) write bare <testcase>
    // elements; take them before declaring the file unreadable.
    const loose = doc.roots.flatMap((r) =>
      r.name.toLowerCase() === 'testcase' ? [r] : collectCases(r),
    );
    if (loose.length === 0) {
      return unreadableReport(
        FORMAT,
        'No <testsuite> or <testcase> elements — this file is not JUnit XML.',
        {
          truncated,
          diagnostics,
        },
      );
    }
    const tests = loose.map((c) => toTest(c, ''));
    return finaliseReport(FORMAT, { tests, truncated, diagnostics, suiteName: wrapperName });
  }

  const tests: ReportTest[] = [];
  for (const suite of suiteNodes) {
    const suiteName = nonEmpty(attr(suite, 'name')) ?? '';
    // Direct children only: a nested <testsuite>'s cases belong to that suite,
    // and are collected when the loop reaches it.
    const cases = children(suite, 'testcase');
    for (const c of cases) tests.push(toTest(c, suiteName));

    // A suite-level <failure>/<error> is a setup or collection failure with no
    // test to attach it to. Dropping it is how "the suite never ran" becomes a
    // clean bill of health.
    for (const f of [...children(suite, 'error'), ...children(suite, 'failure')]) {
      const { message, stack } = readFailure([f]);
      tests.push(
        makeTest({
          suite: suiteName,
          name: `${suiteName || 'suite'} (suite-level error)`,
          status: 'failed',
          durationMs: 0,
          failureMessage: message,
          stack,
        }),
      );
    }

    // Counters vs. reality. Only leaf suites: a parent's `tests` attribute is
    // the aggregate of its children and would always "disagree".
    //
    // Reported, never used to declare the file truncated. The `tests` attribute
    // is not the element count in every emitter — pytest counts phase reports,
    // so a test that passes and then errors in teardown makes `tests` exceed
    // the number of <testcase> elements in a file that is completely intact.
    // Structural truncation is detected by the XML reader instead, which cannot
    // be fooled by an emitter's accounting.
    if (children(suite, 'testsuite').length === 0) {
      const declared = toNumber(attr(suite, 'tests'));
      if (declared !== null && declared > cases.length) {
        diagnostics.push(
          `Suite "${suiteName || '(unnamed)'}" declares ${declared} tests but the file contains ${cases.length}.`,
        );
      }
    }
  }

  const flaky = suiteNodes.reduce(
    (n, s) =>
      n +
      children(s, 'testcase').reduce(
        (m, c) => m + children(c, 'flakyFailure').length + children(c, 'flakyError').length,
        0,
      ),
    0,
  );
  if (flaky > 0) {
    diagnostics.push(
      `${flaky} test(s) failed and passed on retry (Surefire <flakyFailure>) — counted as passed.`,
    );
  }

  const only = suiteNodes.length === 1 ? suiteNodes[0] : undefined;
  const suiteName = wrapperName ?? (only ? nonEmpty(attr(only, 'name')) : null);
  // Surefire has no <testsuites> wrapper, so a lone suite's `time` is the run's.
  const onlyTime = only ? toNumber(attr(only, 'time')) : null;

  return finaliseReport(FORMAT, {
    suiteName,
    tests,
    durationMs: wrapperTime ?? (onlyTime === null ? null : Math.round(onlyTime * 1000)),
    truncated,
    diagnostics,
  });
}

/**
 * Descendant `<testsuite>` elements, never descending into `<system-out>` or
 * `<system-err>`. Those hold whatever the test printed, and a suite that prints
 * a JUnit report (CI tooling does this constantly) would otherwise inject
 * phantom tests into its own results.
 */
function collectSuites(node: XmlNode): XmlNode[] {
  const out: XmlNode[] = [];
  for (const c of node.children) {
    if (isOutput(c)) continue;
    if (c.name.toLowerCase() === 'testsuite') out.push(c);
    out.push(...collectSuites(c));
  }
  return out;
}

function collectCases(node: XmlNode): XmlNode[] {
  const out: XmlNode[] = [];
  for (const c of node.children) {
    if (isOutput(c)) continue;
    if (c.name.toLowerCase() === 'testcase') out.push(c);
    out.push(...collectCases(c));
  }
  return out;
}

function isOutput(node: XmlNode): boolean {
  const n = node.name.toLowerCase();
  return n === 'system-out' || n === 'system-err';
}

function toTest(node: XmlNode, enclosingSuite: string): ReportTest {
  const name = nonEmpty(attr(node, 'name')) ?? 'unnamed test';
  const classname = nonEmpty(attr(node, 'classname'));

  // jest-junit's default templates put the same string in both attributes;
  // using it twice reads as a bug in QAAI, not in jest.
  const suite = classname && classname !== name ? classname : enclosingSuite;

  // `time` is seconds by convention. Some emitters omit it entirely.
  const durationMs = secondsToMs(attr(node, 'time'));

  const skipped = children(node, 'skipped');
  // <flakyFailure>/<rerunFailure> describe earlier attempts, never the verdict.
  const failures = [...children(node, 'failure'), ...children(node, 'error')];

  if (failures.length > 0) {
    const { message, stack } = readFailure(failures);
    return makeTest({ suite, name, status: 'failed', durationMs, failureMessage: message, stack });
  }
  if (skipped.length > 0) {
    return makeTest({ suite, name, status: 'skipped', durationMs });
  }
  return makeTest({ suite, name, status: 'passed', durationMs });
}

function readFailure(nodes: XmlNode[]): { message: string; stack: string | null } {
  const messages: string[] = [];
  const bodies: string[] = [];

  for (const n of nodes) {
    const messageAttr = nonEmpty(attr(n, 'message'));
    const typeAttr = nonEmpty(attr(n, 'type'));
    const body = deepText(n).trim();
    // jest-junit ships no `message` attribute; the assertion text is the body.
    const message = messageAttr ?? nonEmpty(firstLine(body)) ?? typeAttr;
    if (message) messages.push(message);
    if (body) bodies.push(body);
  }

  const message = messages.join('\n') || 'failed';
  const stack = bodies.join('\n\n');
  return { message, stack: stack && stack !== message ? stack : null };
}
