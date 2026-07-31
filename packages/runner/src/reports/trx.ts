/**
 * TRX — Visual Studio's test result format, what `dotnet test --logger trx`
 * writes for NUnit, xUnit and MSTest alike.
 *
 * The two things that go wrong here are units and rollups.
 *
 *  - `duration="00:00:01.2345678"` is a .NET `TimeSpan`, and the fraction is
 *    100-nanosecond ticks — SEVEN digits, not three. Read as milliseconds it is
 *    off by four orders of magnitude, which is how a 1.2 second test ends up
 *    reported as three and a half hours.
 *
 *  - xUnit `[Theory]` and MSTest `[DataRow]` cases arrive as `<InnerResults>`
 *    inside a parent `<UnitTestResult>`. The parent is a summary of its rows;
 *    counting both reports every parameterised test twice.
 *
 * `testName` is fully qualified, but the class name lives in `<TestDefinitions>`
 * where it is stated rather than guessed at, so that is where the suite comes
 * from when it is available.
 */

import {
  attr,
  child,
  children,
  clip,
  deepText,
  descendants,
  nonEmpty,
  parseXml,
  timeSpanToMs,
  toNumber,
} from './common.js';
import type { XmlNode } from './common.js';
import { finaliseReport, makeTest, unreadableReport } from './types.js';
import type { ParsedReport, ReportTest, ReportTestStatus } from './types.js';

const FORMAT = 'trx' as const;

/**
 * TRX outcomes, mapped conservatively: anything that is not an explicit pass
 * and not an explicit "did not run" is a failure. `Inconclusive` is the only
 * judgement call — MSTest uses it for `Assert.Inconclusive`, which means "no
 * verdict", so it lands on skipped rather than on a pass.
 */
const OUTCOMES: Record<string, ReportTestStatus> = {
  passed: 'passed',
  passedbutrunaborted: 'passed',
  notexecuted: 'skipped',
  pending: 'skipped',
  inprogress: 'skipped',
  blocked: 'skipped',
  notrunnable: 'skipped',
  inconclusive: 'skipped',
  disconnected: 'skipped',
  warning: 'passed',
  failed: 'failed',
  error: 'failed',
  timeout: 'failed',
  aborted: 'failed',
};

export function parseTrx(text: string): ParsedReport {
  const doc = parseXml(text);
  const diagnostics = [...doc.diagnostics];
  let truncated = doc.truncated;

  const run = doc.roots.find((r) => r.name.toLowerCase() === 'testrun');
  if (!run) {
    return unreadableReport(FORMAT, 'No <TestRun> root element — this file is not a TRX report.', {
      truncated,
      diagnostics,
    });
  }

  // executionId → the class the method belongs to, straight from the run's own
  // definitions rather than inferred by splitting a dotted name.
  const classByExecution = new Map<string, string>();
  const definitions = child(run, 'TestDefinitions');
  if (definitions) {
    for (const unit of children(definitions, 'UnitTest')) {
      const execId = attr(child(unit, 'Execution') ?? unit, 'id');
      const className = nonEmpty(attr(child(unit, 'TestMethod') ?? unit, 'className'));
      if (execId && className) classByExecution.set(execId, className);
    }
  }

  const results = child(run, 'Results');
  const tests: ReportTest[] = [];
  if (results) {
    for (const node of children(results, 'UnitTestResult')) collect(node, classByExecution, tests);
    // Web-test and ordered-test results use different element names; take any
    // element that carries an outcome so an unusual test type is not dropped.
    for (const node of results.children) {
      if (node.name.toLowerCase() === 'unittestresult') continue;
      if (attr(node, 'outcome') === null) continue;
      collect(node, classByExecution, tests);
    }
  }

  const summary = child(run, 'ResultSummary');
  const counters = summary ? child(summary, 'Counters') : null;
  if (counters) {
    const declared = toNumber(attr(counters, 'total'));
    if (declared !== null && declared > tests.length) {
      truncated = true;
      diagnostics.push(
        `<Counters total="${declared}"> but the file contains ${tests.length} results.`,
      );
    }
    const declaredFailed = toNumber(attr(counters, 'failed'));
    const found = tests.filter((t) => t.status === 'failed').length;
    if (declaredFailed !== null && declaredFailed !== found) {
      diagnostics.push(
        `<Counters failed="${declaredFailed}"> but ${found} result(s) are failures.`,
      );
    }
  }

  if (tests.length === 0 && !results) {
    return unreadableReport(
      FORMAT,
      '<TestRun> has no <Results> element — the file is a TRX stub with no results.',
      {
        truncated,
        diagnostics,
      },
    );
  }

  const times = child(run, 'Times');
  let durationMs: number | null = null;
  if (times) {
    const start = Date.parse(attr(times, 'start') ?? '');
    const finish = Date.parse(attr(times, 'finish') ?? '');
    if (Number.isFinite(start) && Number.isFinite(finish) && finish >= start)
      durationMs = finish - start;
  }

  return finaliseReport(FORMAT, {
    suiteName: nonEmpty(attr(run, 'name')),
    tests,
    durationMs,
    truncated,
    diagnostics,
  });
}

function collect(node: XmlNode, classByExecution: Map<string, string>, out: ReportTest[]): void {
  const inner = child(node, 'InnerResults');
  const innerResults = inner ? children(inner, 'UnitTestResult') : [];

  if (innerResults.length > 0) {
    // The parent is the theory; the rows are the tests.
    for (const row of innerResults) collect(row, classByExecution, out);
    return;
  }

  const fullName = nonEmpty(attr(node, 'testName')) ?? 'unnamed test';
  const executionId = attr(node, 'executionId') ?? '';
  const declaredClass = classByExecution.get(executionId) ?? null;

  const { suite, name } = splitName(fullName, declaredClass);
  const outcome = (attr(node, 'outcome') ?? '').toLowerCase();
  const status = OUTCOMES[outcome] ?? 'failed';

  const errorInfo = findErrorInfo(node);
  const message = errorInfo ? nonEmpty(deepText(child(errorInfo, 'Message') ?? emptyNode())) : null;
  const stack = errorInfo
    ? nonEmpty(deepText(child(errorInfo, 'StackTrace') ?? emptyNode()))
    : null;

  out.push(
    makeTest({
      suite,
      name,
      status,
      durationMs: timeSpanToMs(attr(node, 'duration')),
      failureMessage:
        status === 'failed'
          ? clip(message ?? `outcome="${attr(node, 'outcome') ?? 'unknown'}"`)
          : null,
      stack: status === 'failed' && stack ? clip(stack) : null,
    }),
  );
}

function findErrorInfo(node: XmlNode): XmlNode | null {
  const output = child(node, 'Output');
  if (output) {
    const info = child(output, 'ErrorInfo');
    if (info) return info;
  }
  return descendants(node, 'ErrorInfo')[0] ?? null;
}

function emptyNode(): XmlNode {
  return { name: '', attrs: {}, children: [], text: '' };
}

/**
 * `Namespace.Class.Method(arg: 1)` → suite `Namespace.Class`, name
 * `Method(arg: 1)`. Splitting on the last dot is wrong when the arguments
 * contain one, so the split point is found before the parameter list.
 */
function splitName(
  fullName: string,
  declaredClass: string | null,
): { suite: string; name: string } {
  if (declaredClass && fullName.startsWith(`${declaredClass}.`)) {
    return { suite: declaredClass, name: fullName.slice(declaredClass.length + 1) };
  }
  if (declaredClass) return { suite: declaredClass, name: fullName };

  const paren = fullName.indexOf('(');
  const head = paren >= 0 ? fullName.slice(0, paren) : fullName;
  const dot = head.lastIndexOf('.');
  if (dot < 0) return { suite: '', name: fullName };
  return { suite: head.slice(0, dot), name: fullName.slice(dot + 1) };
}
