/**
 * TAP 13 / 14 — a line protocol, not a document, which is why it needs more
 * care than the XML formats rather than less.
 *
 * Three things drive the shape of this parser:
 *
 *  - **Subtests double-count.** node:test, tap, and TAP14 emit a subtest's
 *    points indented, then a rollup point for the subtest itself at the parent
 *    indent. Counting both reports 2 tests for 1 and reports one failure twice.
 *    Indentation is the only structure TAP has, so it is what the tree is built
 *    from; a point with children becomes a suite name, not a test.
 *
 *  - **The plan is a truncation detector.** `1..40` followed by 37 points means
 *    three tests never reached disk. No other format hands us that for free.
 *
 *  - **Directives invert the verdict.** `not ok 3 - … # TODO` is an expected
 *    failure and is not a failing test; `ok 4 - … # SKIP` did not run. Reading
 *    only the `ok`/`not ok` prefix gets both backwards.
 */

import { clip, msValue, nonEmpty } from './common.js';
import { finaliseReport, makeTest, unreadableReport } from './types.js';
import type { ParsedReport, ReportTest } from './types.js';

const FORMAT = 'tap' as const;

interface TapPoint {
  indent: number;
  ok: boolean;
  name: string;
  directive: 'skip' | 'todo' | null;
  directiveReason: string;
  yaml: Record<string, string>;
  children: TapPoint[];
}

const POINT_RE = /^(\s*)(not\s+)?ok\b[ \t]*(\d+)?[ \t]*(?:-[ \t]*)?(.*)$/;
const PLAN_RE = /^(\s*)(\d+)\.\.(\d+)\s*(?:#\s*(.*))?$/;
const VERSION_RE = /^\s*TAP\s+version\s+(\d+)/i;
const BAIL_RE = /^\s*Bail out!\s*(.*)$/i;

export function parseTap(text: string): ParsedReport {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const diagnostics: string[] = [];
  let truncated = false;
  let sawVersion = false;
  let plan: { count: number; indent: number; directive: string | null } | null = null;

  // Points still waiting to be claimed by a parent at a shallower indent.
  const stack: { indent: number; points: TapPoint[] }[] = [];
  const roots: TapPoint[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    i += 1;
    if (line.trim() === '') continue;

    if (VERSION_RE.test(line)) {
      sawVersion = true;
      continue;
    }

    const bail = BAIL_RE.exec(line);
    if (bail) {
      // A bail-out means the runner stopped on purpose. Everything after the
      // point it stopped at simply does not exist.
      truncated = true;
      diagnostics.push(
        `Bail out! ${nonEmpty(bail[1]) ?? '(no reason given)'} — the run stopped early.`,
      );
      continue;
    }

    const planMatch = PLAN_RE.exec(line);
    if (planMatch) {
      const indent = (planMatch[1] ?? '').length;
      const count = Number(planMatch[3] ?? 0) - Number(planMatch[2] ?? 1) + 1;
      // Only the top-level plan describes the run; a subtest's plan describes
      // the subtest, and is checked implicitly by its own children.
      if (indent === 0)
        plan = { count: Math.max(0, count), indent, directive: nonEmpty(planMatch[4] ?? null) };
      continue;
    }

    const point = POINT_RE.exec(line);
    if (point) {
      const indent = (point[1] ?? '').length;
      const { name, directive, reason } = splitDirective(point[4] ?? '');
      const yamlBlock = takeYaml(lines, i, indent);
      i = yamlBlock.next;
      if (yamlBlock.unterminated) {
        truncated = true;
        diagnostics.push('A YAML diagnostic block was never closed — the report stops mid-write.');
      }

      pushPoint(stack, roots, {
        indent,
        ok: !point[2],
        name: nonEmpty(name) ?? `test ${point[3] ?? stackSize(stack, roots) + 1}`,
        directive,
        directiveReason: reason,
        yaml: yamlBlock.data,
        children: [],
      });
      continue;
    }

    // `# Subtest: name`, `# pragma`, and free comments carry no verdict. The
    // tree is built from indentation, so the Subtest header is not needed.
  }

  // Anything still unclaimed is top level.
  for (const level of stack) roots.push(...level.points);
  stack.length = 0;

  const tests: ReportTest[] = [];
  for (const p of roots) flatten(p, [], tests);

  if (tests.length === 0 && !sawVersion && plan === null) {
    return unreadableReport(
      FORMAT,
      'No TAP version line, plan, or test points — this file is not TAP.',
      {
        truncated,
        diagnostics,
      },
    );
  }

  if (plan) {
    if (plan.count > roots.length) {
      truncated = true;
      diagnostics.push(
        `The plan plans ${plan.count} tests but the report contains ${roots.length}.`,
      );
    } else if (plan.count < roots.length) {
      diagnostics.push(
        `The plan plans ${plan.count} tests but the report contains ${roots.length}.`,
      );
    }
    if (plan.count === 0 && plan.directive) {
      diagnostics.push(`The whole file was skipped: ${plan.directive}`);
    }
  } else if (tests.length > 0) {
    // Without a plan there is no way to know the stream finished.
    diagnostics.push(
      'No TAP plan line — an interrupted run is indistinguishable from a complete one.',
    );
  } else if (sawVersion) {
    truncated = true;
    diagnostics.push(
      'The TAP stream has a version header and nothing else — the runner wrote no results.',
    );
  }

  return finaliseReport(FORMAT, { tests, truncated, diagnostics });
}

function stackSize(stack: { points: TapPoint[] }[], roots: TapPoint[]): number {
  return roots.length + stack.reduce((n, l) => n + l.points.length, 0);
}

/**
 * Attach a point to the tree. Children are emitted before their parent, so any
 * unclaimed point at a deeper indent belongs to this one.
 */
function pushPoint(
  stack: { indent: number; points: TapPoint[] }[],
  roots: TapPoint[],
  point: TapPoint,
): void {
  for (;;) {
    const deepest = stack[stack.length - 1];
    if (!deepest || deepest.indent <= point.indent) break;
    stack.pop();
    point.children.unshift(...deepest.points);
  }

  const top = stack[stack.length - 1];
  if (top && top.indent === point.indent) {
    top.points.push(point);
  } else if (point.indent === 0) {
    roots.push(point);
  } else {
    stack.push({ indent: point.indent, points: [point] });
  }
}

function flatten(point: TapPoint, path: string[], out: ReportTest[]): void {
  if (point.children.length === 0) {
    out.push(toTest(point, path.join(' › ')));
    return;
  }

  const before = out.length;
  for (const c of point.children) flatten(c, [...path, point.name], out);

  // A failing rollup whose children all passed is a failure in the subtest's
  // own teardown or plan. Emitting it too is the only way not to lose it.
  const childFailed = out.slice(before).some((t) => t.status === 'failed');
  if (!point.ok && !childFailed && point.directive === null) {
    out.push(toTest(point, path.join(' › ')));
  }
}

function toTest(point: TapPoint, suite: string): ReportTest {
  // `# SKIP` did not run; `# TODO` is a known failure the author already
  // acknowledged — per the TAP spec neither counts against the run.
  const status = point.directive !== null ? 'skipped' : point.ok ? 'passed' : 'failed';
  const durationMs =
    point.yaml['duration_ms'] !== undefined ? msValue(point.yaml['duration_ms']) : 0;

  // `message` is the TAP spec's key; node:test uses `error`; tape supplies
  // neither and expects the reader to assemble one from operator/expected/actual.
  const message =
    nonEmpty(point.yaml['message']) ??
    nonEmpty(point.yaml['error']) ??
    nonEmpty(point.yaml['data.message']) ??
    buildExpectedActual(point.yaml) ??
    (status === 'failed' ? 'not ok' : null);
  const stack =
    nonEmpty(point.yaml['stack']) ??
    nonEmpty(point.yaml['data.stack']) ??
    nonEmpty(point.yaml['at']);

  return makeTest({
    suite,
    name: point.name,
    status,
    durationMs,
    failureMessage: status === 'failed' ? clip(message ?? 'not ok') : null,
    stack: status === 'failed' && stack ? clip(stack) : null,
  });
}

function buildExpectedActual(yaml: Record<string, string>): string | null {
  const expected =
    yaml['expected'] ?? yaml['expect'] ?? yaml['data.expected'] ?? yaml['data.expect'];
  const actual =
    yaml['actual'] ?? yaml['found'] ?? yaml['got'] ?? yaml['data.actual'] ?? yaml['data.got'];
  if (expected === undefined && actual === undefined) return null;
  const operator = yaml['operator'] ?? yaml['data.operator'];
  return [
    operator ? `operator: ${operator}` : null,
    `expected: ${expected ?? '(none)'}`,
    `actual: ${actual ?? '(none)'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** `description # SKIP reason` — `#` inside a description is escaped as `\#`. */
function splitDirective(rest: string): {
  name: string;
  directive: 'skip' | 'todo' | null;
  reason: string;
} {
  const m = /(?<!\\)#\s*(skip|todo)\b[ \t]*(.*)$/i.exec(rest);
  if (!m) return { name: unescapeHash(rest.trim()), directive: null, reason: '' };
  return {
    name: unescapeHash(rest.slice(0, m.index).trim()),
    directive: (m[1] ?? '').toLowerCase() === 'skip' ? 'skip' : 'todo',
    reason: (m[2] ?? '').trim(),
  };
}

function unescapeHash(text: string): string {
  return text.replace(/\\#/g, '#');
}

// ─── YAML diagnostics ────────────────────────────────────────────────────────

interface YamlBlock {
  data: Record<string, string>;
  next: number;
  unterminated: boolean;
}

/**
 * The `---` / `...` block that may follow a test point. This reads the subset
 * TAP producers actually emit — scalars, block scalars, and one level of
 * nesting — rather than pulling in a YAML engine for a diagnostics blob.
 */
function takeYaml(lines: string[], start: number, pointIndent: number): YamlBlock {
  const openLine = lines[start];
  if (openLine === undefined) return { data: {}, next: start, unterminated: false };
  const openIndent = leadingSpaces(openLine);
  if (openLine.trim() !== '---' || openIndent <= pointIndent) {
    return { data: {}, next: start, unterminated: false };
  }

  const body: string[] = [];
  let i = start + 1;
  let closed = false;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '...') {
      closed = true;
      i += 1;
      break;
    }
    body.push(line.slice(Math.min(openIndent, leadingSpaces(line))));
    i += 1;
  }

  // tape indents the block's keys past the `---`; node:test does not. Read the
  // body relative to its own left edge rather than assuming either.
  const base = body.reduce(
    (min, l) => (l.trim() === '' ? min : Math.min(min, leadingSpaces(l))),
    Number.MAX_SAFE_INTEGER,
  );

  return {
    data: readYamlMap(body, base === Number.MAX_SAFE_INTEGER ? 0 : base, ''),
    next: i,
    unterminated: !closed,
  };
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

function readYamlMap(lines: string[], baseIndent: number, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const indent = leadingSpaces(line);
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      i += 1;
      continue;
    }

    const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!m) {
      i += 1;
      continue;
    }
    const key = `${prefix}${(m[1] ?? '').trim()}`;
    const inline = (m[2] ?? '').trim();
    i += 1;

    // Gather the deeper-indented lines that belong to this key.
    const nested: string[] = [];
    while (i < lines.length) {
      const next = lines[i] ?? '';
      if (next.trim() !== '' && leadingSpaces(next) <= baseIndent) break;
      nested.push(next);
      i += 1;
    }

    if (/^[|>][-+]?$/.test(inline)) {
      // Block scalar: the value is the dedented body, newlines preserved.
      const strip = nested.reduce(
        (min, l) => (l.trim() === '' ? min : Math.min(min, leadingSpaces(l))),
        Number.MAX_SAFE_INTEGER,
      );
      const dedent = strip === Number.MAX_SAFE_INTEGER ? 0 : strip;
      out[key] = nested
        .map((l) => l.slice(dedent))
        .join('\n')
        .replace(/\n+$/, '');
      continue;
    }

    if (inline === '') {
      if (nested.length > 0) {
        const childIndent = nested.reduce(
          (min, l) => (l.trim() === '' ? min : Math.min(min, leadingSpaces(l))),
          Number.MAX_SAFE_INTEGER,
        );
        Object.assign(
          out,
          readYamlMap(nested, childIndent === Number.MAX_SAFE_INTEGER ? 0 : childIndent, `${key}.`),
        );
      } else {
        out[key] = '';
      }
      continue;
    }

    out[key] = unquote(inline);
  }

  return out;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}
