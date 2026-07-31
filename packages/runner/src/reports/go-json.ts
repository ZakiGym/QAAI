/**
 * `go test -json` — newline-delimited build events, not a report.
 *
 * The stream is a log of what the toolchain did, so the result has to be
 * reconstructed, and three of its properties are traps:
 *
 *  - **Package events look exactly like test events.** `{"Action":"fail",
 *    "Package":"…"}` with no `Test` field is the package verdict, not a test.
 *    Counting them inflates every total and reports a package twice.
 *
 *  - **A package that fails to compile emits no test events at all.** Go says
 *    `FAIL  example.com/m/calc [build failed]` and moves on. Treating that as
 *    "0 tests, nothing failed" is the exact scenario where a broken build ships
 *    green, so a package-level failure with no tests becomes a failing test.
 *
 *  - **Subtests roll up.** `TestX` fails whenever `TestX/case_2` fails, so
 *    keeping both double-reports the same failure. Leaves win; a parent is kept
 *    only when it failed on its own.
 *
 * `Elapsed` is seconds — the only unit in the stream, and a float.
 */

import { asString, clip, isRecord, parseNdjson, secondsToMs, toNumber } from './common.js';
import { finaliseReport, makeTest, unreadableReport } from './types.js';
import type { ParsedReport, ReportTest } from './types.js';

const FORMAT = 'go-json' as const;

interface GoEvent {
  action: string;
  pkg: string;
  test: string | null;
  output: string | null;
  elapsed: number | null;
}

interface GoTest {
  pkg: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped' | null;
  durationMs: number;
  output: string[];
}

interface GoPackage {
  status: string | null;
  elapsed: number | null;
  output: string[];
}

export function parseGoJson(text: string): ParsedReport {
  const stream = parseNdjson(text);
  const diagnostics: string[] = [];
  let truncated = stream.truncated;

  if (truncated)
    diagnostics.push('The event stream stops mid-line — `go test` was killed while writing.');
  if (stream.skipped > 0) {
    diagnostics.push(
      `Ignored ${stream.skipped} non-JSON line(s) — run \`go test -json\` without extra stdout.`,
    );
  }

  const events: GoEvent[] = [];
  for (const row of stream.rows) {
    if (!isRecord(row)) continue;
    const action = asString(row['Action']);
    if (!action) continue;
    events.push({
      action,
      pkg: asString(row['Package']) ?? '',
      test: asString(row['Test']),
      output: asString(row['Output']),
      elapsed: toNumber(row['Elapsed']),
    });
  }

  if (events.length === 0) {
    return unreadableReport(
      FORMAT,
      'No `go test -json` events — this file is not a Go test event stream.',
      {
        truncated,
        diagnostics,
      },
    );
  }

  const tests = new Map<string, GoTest>();
  const packages = new Map<string, GoPackage>();

  for (const e of events) {
    const pkg = packages.get(e.pkg) ?? { status: null, elapsed: null, output: [] };
    packages.set(e.pkg, pkg);

    if (e.test === null) {
      // Package-scoped event.
      if (e.action === 'pass' || e.action === 'fail' || e.action === 'skip') {
        pkg.status = e.action;
        pkg.elapsed = e.elapsed;
      } else if (e.action === 'output' && e.output) {
        pkg.output.push(e.output);
      }
      continue;
    }

    const key = testKey(e.pkg, e.test);
    const test = tests.get(key) ?? {
      pkg: e.pkg,
      name: e.test,
      status: null,
      durationMs: 0,
      output: [],
    };
    tests.set(key, test);

    switch (e.action) {
      case 'pass':
      case 'fail':
      case 'skip':
        test.status = e.action === 'pass' ? 'passed' : e.action === 'fail' ? 'failed' : 'skipped';
        test.durationMs = secondsToMs(e.elapsed);
        break;
      case 'output':
        if (e.output) test.output.push(e.output);
        break;
      default:
        // run / pause / cont / bench / start — no verdict to record.
        break;
    }
  }

  const all = [...tests.values()];
  const failedByName = new Set(
    all.filter((t) => t.status === 'failed').map((t) => testKey(t.pkg, t.name)),
  );

  const out: ReportTest[] = [];
  for (const t of all) {
    if (t.status === null) {
      // `run` with no verdict: the process died while this test was running.
      truncated = true;
      out.push(
        makeTest({
          suite: t.pkg,
          name: t.name,
          status: 'failed',
          durationMs: 0,
          failureMessage:
            'The test started but never reported a result — `go test` exited while it was running.',
          stack: cleanOutput(t.output) || null,
        }),
      );
      continue;
    }

    const childPrefix = testKey(t.pkg, `${t.name}/`);
    const hasChildren = all.some((o) => testKey(o.pkg, o.name).startsWith(childPrefix));
    if (hasChildren) {
      // The parent is a rollup. Keep it only when it failed without any subtest
      // failing — a `t.Error` in the parent body after its subtests passed.
      const childFailed = [...failedByName].some((k) => k.startsWith(childPrefix));
      if (!(t.status === 'failed' && !childFailed)) continue;
    }

    out.push(
      makeTest({
        suite: t.pkg,
        name: t.name,
        status: t.status,
        durationMs: t.durationMs,
        failureMessage: t.status === 'failed' ? clip(cleanOutput(t.output)) || 'failed' : null,
        stack: null,
      }),
    );
  }

  // Packages that failed without producing a single test event: build errors,
  // vet errors, a panic in TestMain, a package with no test files that failed
  // to link. These are the ones that must never read as green.
  for (const [name, pkg] of packages) {
    if (name === '' || pkg.status !== 'fail') continue;
    const hasTests = all.some((t) => t.pkg === name);
    if (hasTests) continue;
    out.push(
      makeTest({
        suite: name,
        name: `${name} (package failed before any test ran)`,
        status: 'failed',
        durationMs: secondsToMs(pkg.elapsed),
        failureMessage: clip(cleanOutput(pkg.output)) || 'The package failed to build or run.',
        stack: null,
      }),
    );
  }

  const packageNames = [...packages.keys()].filter((n) => n !== '');
  const suiteName = packageNames.length === 1 ? (packageNames[0] ?? null) : null;
  const wall = [...packages.values()].reduce((n, p) => n + secondsToMs(p.elapsed), 0);

  return finaliseReport(FORMAT, {
    suiteName,
    tests: out,
    durationMs: wall > 0 ? wall : null,
    truncated,
    diagnostics,
  });
}

/**
 * Package + test as one map key. Separated by NUL rather than a space or a
 * slash: a slash is how Go names subtests, and both a space and a slash can
 * appear in the pair, so either would let two different tests collide on one
 * key. Nothing in an import path or a test name can be a NUL.
 */
function testKey(pkg: string, test: string): string {
  return `${pkg}\u0000${test}`;
}

/** Strip the framing `go test` prints around the part a human needs. */
function cleanOutput(lines: string[]): string {
  return lines
    .join('')
    .split('\n')
    .filter((l) => !/^\s*(=== (RUN|PAUSE|CONT|NAME)|--- (PASS|SKIP)\b|(ok|PASS)\s)/.test(l))
    .join('\n')
    .trim();
}
