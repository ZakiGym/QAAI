/**
 * Does the SARIF file VALIDATE, and does it re-alarm?
 *
 * Separate from sarif.test.ts, which asserts the reporter's own decisions. This
 * file refuses to take those assertions at face value and checks the two things
 * a consumer actually does with the document:
 *
 *  1. IT VALIDATES IT, AND DROPS IT SILENTLY IF IT FAILS. GitHub's upload
 *     endpoint rejects the whole run, Defect Dojo imports zero findings, and
 *     neither UI says why — the team sees a green badge and believes a scan
 *     ran. So the required-property set of SARIF 2.1.0 is restated HERE,
 *     independently of the reporter's own types, and walked over a real
 *     rendered file. A test that asserts the reporter agrees with itself proves
 *     nothing about the consumer.
 *  2. IT DIFFS THE FINGERPRINTS AGAINST THE LAST RUN. Anything volatile in
 *     `partialFingerprints` makes every run re-alarm on everything, which is
 *     how a SARIF integration gets switched off in week two.
 *
 * Both were REFUTED — the file validates and the fingerprints are stable across
 * runs, run ids and timestamps. The checks stay because the cost of either one
 * regressing is a silent zero.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_SARIF_RESULTS,
  SARIF_VERSION,
  fingerprintOf,
  sarifReporter,
  type ReportedFinding,
} from './sarif.js';
import type { RunReport } from './types.js';

/**
 * SARIF 2.1.0's required properties, for every object this reporter emits.
 *
 * Copied from the schema's own `required` keywords, NOT derived from this
 * package's interfaces — the whole value of this list is that it is a second
 * opinion. `anyOf` cases (a `message` needs `text` OR `id`) are spelled out as
 * a predicate rather than a key list.
 */
const REQUIRED: Record<string, readonly string[]> = {
  sarifLog: ['version', 'runs'],
  run: ['tool'],
  tool: ['driver'],
  toolComponent: ['name'],
  reportingDescriptor: ['id'],
  invocation: ['executionSuccessful'],
  suppression: ['kind'],
  versionControlDetails: ['repositoryUri'],
  notification: ['message'],
};

/** Prints an unknown safely: a validator may not stringify an object by accident. */
function show(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value);
}

function requireKeys(
  value: Record<string, unknown>,
  shape: keyof typeof REQUIRED,
  where: string,
  problems: string[],
): void {
  for (const key of REQUIRED[shape] ?? []) {
    if (!(key in value)) problems.push(`${where}: ${shape} is missing required "${key}"`);
  }
}

/** Every rule the schema states that this reporter could plausibly break. */
function validateSarif(log: unknown): string[] {
  const problems: string[] = [];
  if (typeof log !== 'object' || log === null) return ['the document is not an object'];
  const root = log as Record<string, unknown>;

  requireKeys(root, 'sarifLog', '$', problems);
  if (root['version'] !== SARIF_VERSION) problems.push(`$: version is not ${SARIF_VERSION}`);
  if (!Array.isArray(root['runs'])) return [...problems, '$: runs is not an array'];

  for (const [runIndex, rawRun] of (root['runs'] as unknown[]).entries()) {
    const at = `$.runs[${runIndex}]`;
    if (typeof rawRun !== 'object' || rawRun === null) {
      problems.push(`${at}: not an object`);
      continue;
    }
    const run = rawRun as Record<string, unknown>;
    requireKeys(run, 'run', at, problems);

    const tool = run['tool'] as Record<string, unknown> | undefined;
    if (tool === undefined) continue;
    requireKeys(tool, 'tool', `${at}.tool`, problems);
    const driver = tool['driver'] as Record<string, unknown> | undefined;
    if (driver === undefined) continue;
    requireKeys(driver, 'toolComponent', `${at}.tool.driver`, problems);

    const rules = Array.isArray(driver['rules']) ? (driver['rules'] as unknown[]) : [];
    for (const [ruleIndex, rawRule] of rules.entries()) {
      const rule = rawRule as Record<string, unknown>;
      requireKeys(rule, 'reportingDescriptor', `${at}.tool.driver.rules[${ruleIndex}]`, problems);
      const short = rule['shortDescription'] as Record<string, unknown> | undefined;
      // `message` requires text or id; a description with neither is invalid.
      if (short !== undefined && typeof short['text'] !== 'string' && typeof short['id'] !== 'string')
        problems.push(`${at}.tool.driver.rules[${ruleIndex}].shortDescription: no text and no id`);
    }

    const invocations = Array.isArray(run['invocations']) ? (run['invocations'] as unknown[]) : [];
    for (const [i, rawInvocation] of invocations.entries()) {
      const invocation = rawInvocation as Record<string, unknown>;
      requireKeys(invocation, 'invocation', `${at}.invocations[${i}]`, problems);
      if (typeof invocation['executionSuccessful'] !== 'boolean')
        problems.push(`${at}.invocations[${i}]: executionSuccessful is not a boolean`);
      for (const [n, rawNote] of (
        Array.isArray(invocation['toolExecutionNotifications'])
          ? (invocation['toolExecutionNotifications'] as unknown[])
          : []
      ).entries()) {
        const note = rawNote as Record<string, unknown>;
        requireKeys(note, 'notification', `${at}.invocations[${i}].notifications[${n}]`, problems);
      }
      for (const key of ['startTimeUtc', 'endTimeUtc'] as const) {
        const stamp = invocation[key];
        // The schema's `date-time` format. A stamp no consumer can parse is the
        // same silent drop as a missing one.
        if (stamp !== undefined && (typeof stamp !== 'string' || !/Z$/.test(stamp)))
          problems.push(`${at}.invocations[${i}].${key}: not an ISO 8601 UTC stamp`);
      }
    }

    for (const [p, rawProvenance] of (
      Array.isArray(run['versionControlProvenance'])
        ? (run['versionControlProvenance'] as unknown[])
        : []
    ).entries()) {
      requireKeys(
        rawProvenance as Record<string, unknown>,
        'versionControlDetails',
        `${at}.versionControlProvenance[${p}]`,
        problems,
      );
    }

    const results = Array.isArray(run['results']) ? (run['results'] as unknown[]) : [];
    for (const [r, rawResult] of results.entries()) {
      const result = rawResult as Record<string, unknown>;
      const resultAt = `${at}.results[${r}]`;
      const message = result['message'] as Record<string, unknown> | undefined;
      if (message === undefined) problems.push(`${resultAt}: missing required "message"`);
      else if (typeof message['text'] !== 'string' && typeof message['id'] !== 'string')
        problems.push(`${resultAt}.message: no text and no id`);
      else if (typeof message['text'] === 'string' && message['text'].length === 0)
        problems.push(`${resultAt}.message.text: empty, which the schema's minLength forbids`);

      const level = result['level'];
      if (level !== undefined && !['none', 'note', 'warning', 'error'].includes(show(level)))
        problems.push(`${resultAt}.level: "${show(level)}" is not a SARIF level`);

      // `ruleIndex` must index into theRun.tool.driver.rules, or the consumer
      // renders the wrong rule against the finding.
      const ruleIndex = result['ruleIndex'];
      if (typeof ruleIndex === 'number') {
        if (!Number.isInteger(ruleIndex) || ruleIndex < 0 || ruleIndex >= rules.length)
          problems.push(`${resultAt}.ruleIndex: ${ruleIndex} is not an index into driver.rules`);
        else {
          const rule = rules[ruleIndex] as Record<string, unknown>;
          if (rule['id'] !== result['ruleId'])
            problems.push(`${resultAt}: ruleIndex points at a rule with a different id`);
        }
      }

      const fingerprints = result['partialFingerprints'];
      if (fingerprints !== undefined) {
        if (typeof fingerprints !== 'object' || fingerprints === null)
          problems.push(`${resultAt}.partialFingerprints: not an object`);
        else
          for (const [key, raw] of Object.entries(fingerprints as Record<string, unknown>))
            if (typeof raw !== 'string')
              problems.push(`${resultAt}.partialFingerprints["${key}"]: not a string`);
      }

      for (const [s, rawSuppression] of (
        Array.isArray(result['suppressions']) ? (result['suppressions'] as unknown[]) : []
      ).entries()) {
        const suppression = rawSuppression as Record<string, unknown>;
        requireKeys(suppression, 'suppression', `${resultAt}.suppressions[${s}]`, problems);
        if (!['external', 'inSource'].includes(show(suppression['kind'])))
          problems.push(`${resultAt}.suppressions[${s}].kind: not a SARIF suppression kind`);
        const status = suppression['status'];
        if (
          status !== undefined &&
          !['accepted', 'underReview', 'rejected'].includes(show(status))
        )
          problems.push(`${resultAt}.suppressions[${s}].status: not a SARIF suppression status`);
      }

      for (const [l, rawLocation] of (
        Array.isArray(result['locations']) ? (result['locations'] as unknown[]) : []
      ).entries()) {
        const location = rawLocation as Record<string, unknown>;
        const physical = location['physicalLocation'] as Record<string, unknown> | undefined;
        if (physical !== undefined) {
          const artifact = physical['artifactLocation'] as Record<string, unknown> | undefined;
          if (artifact === undefined || typeof artifact['uri'] !== 'string')
            problems.push(`${resultAt}.locations[${l}].physicalLocation: no artifactLocation.uri`);
          const region = physical['region'] as Record<string, unknown> | undefined;
          if (region !== undefined) {
            // Every bound is 1-based and `endLine` may not precede `startLine`.
            for (const key of ['startLine', 'startColumn', 'endLine', 'endColumn'] as const) {
              const bound = region[key];
              if (bound !== undefined && (typeof bound !== 'number' || bound < 1))
                problems.push(`${resultAt}.locations[${l}].region.${key}: ${show(bound)} < 1`);
            }
            const start = region['startLine'];
            const end = region['endLine'];
            if (typeof start === 'number' && typeof end === 'number' && end < start)
              problems.push(`${resultAt}.locations[${l}].region: endLine precedes startLine`);
          }
        }
      }
    }
  }
  return problems;
}

const finding = (over: Partial<ReportedFinding> = {}): ReportedFinding => ({
  kind: 'SECURITY',
  severity: 'SERIOUS',
  code: 'runtime.http-5xx',
  message: 'responded 500',
  location: 'POST /api/pay',
  helpUrl: null,
  ...over,
});

function report(over: Partial<RunReport> & { findings?: readonly ReportedFinding[] } = {}): RunReport {
  return {
    id: 'run_1',
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_060_000,
    tests: [{ name: 'checkout', status: 'passed' }],
    ...over,
  } as unknown as RunReport;
}

const logOf = (input: RunReport): unknown => {
  const document = sarifReporter.render(input);
  const file = document.files[0];
  expect(file?.path).toBe('qaai.sarif');
  return JSON.parse(file?.contents ?? 'null');
};

describe('the emitted file satisfies SARIF 2.1.0', () => {
  it('validates with a full set of findings, locations, regions and suppressions', () => {
    const log = logOf(
      report({
        repositoryUri: 'https://github.test/acme/app',
        commitSha: 'abc123',
        branch: 'main',
        toolVersion: '1.2.3',
        informationUri: 'https://qaai.test',
        findings: [
          finding(),
          finding({ code: 'a11y.contrast', kind: 'ACCESSIBILITY', severity: 'MINOR', location: 'button.submit > span' }),
          finding({ code: 'a11y.alt', kind: 'ACCESSIBILITY', severity: 'MODERATE', uri: 'src/App.tsx', region: { startLine: 10, startColumn: 4, endLine: 12 } }),
          finding({ code: 'sec.cookie', location: 'https://app.test/login', severity: 'CRITICAL' }),
          finding({
            code: 'sec.waived',
            location: 'https://app.test/legacy',
            suppression: { justification: 'legacy', owner: 'sec@acme.test', expiresAtIso: '2099-01-01T00:00:00.000Z' },
          }),
          // An empty message: `message.text` is required and may not be empty.
          finding({ code: 'runtime.console-error', message: '   ' }),
          // A region a producer could not fix: must be DROPPED, not clamped.
          finding({ code: 'runtime.page-error', uri: 'src/x.ts', region: { startLine: 0, endLine: -4 } }),
        ],
      } as never),
    );

    expect(validateSarif(log)).toEqual([]);
  });

  it('validates the two shapes that carry no findings at all', () => {
    // `findings` ABSENT — nobody looked — and `findings: []`, a genuine clean
    // run. Both must still be valid documents, because an invalid one is
    // dropped and a dropped one reads as a pass.
    expect(validateSarif(logOf(report()))).toEqual([]);
    expect(validateSarif(logOf(report({ findings: [] })))).toEqual([]);
    expect(validateSarif(logOf(report({ findings: [], tests: [] })))).toEqual([]);
  });

  it('refuses to trust the absence of results when nobody looked', () => {
    const absent = logOf(report()) as { runs: Array<{ invocations: Array<{ executionSuccessful: boolean }> }> };
    const clean = logOf(report({ findings: [] })) as typeof absent;

    expect(absent.runs[0]?.invocations[0]?.executionSuccessful).toBe(false);
    expect(clean.runs[0]?.invocations[0]?.executionSuccessful).toBe(true);
  });

  it('stays valid when the 5000-result cap bites, and says so IN the file', () => {
    const many = Array.from({ length: MAX_SARIF_RESULTS + 7 }, (_, index) =>
      finding({ code: `bulk.${index}`, location: `GET /r/${index}` }),
    );
    const log = logOf(report({ findings: many })) as {
      runs: Array<{
        results: unknown[];
        invocations: Array<{ toolExecutionNotifications?: Array<{ message: { text: string } }> }>;
      }>;
    };

    expect(validateSarif(log)).toEqual([]);
    expect(log.runs[0]?.results).toHaveLength(MAX_SARIF_RESULTS);
    // The consumer never sees our warnings, only the file.
    const notes = log.runs[0]?.invocations[0]?.toolExecutionNotifications ?? [];
    expect(notes.map((note) => note.message.text).join('\n')).toMatch(/7 of 5007 finding\(s\) were omitted/);
  });

  it('omits the provenance block entirely rather than emitting an invalid one', () => {
    // `versionControlDetails` REQUIRES `repositoryUri`. A run knows its commit
    // and not its repository, and a provenance block missing a required field
    // fails validation and takes the whole upload with it.
    const log = logOf(report({ commitSha: 'abc123', branch: 'main', findings: [finding()] })) as {
      runs: Array<{ versionControlProvenance?: unknown; properties: Record<string, unknown> }>;
    };

    expect(log.runs[0]?.versionControlProvenance).toBeUndefined();
    expect(log.runs[0]?.properties['qaaiCommitSha']).toBe('abc123');
    expect(validateSarif(log)).toEqual([]);
  });
});

describe('a second run of the same finding does not re-alarm', () => {
  it('keeps the fingerprint stable across run ids, timestamps and reworded prose', () => {
    const first = logOf(report({ findings: [finding()] })) as {
      runs: Array<{ results: Array<{ partialFingerprints: Record<string, string> }> }>;
    };
    const second = logOf(
      report({
        id: 'run_2',
        startedAt: 1_800_000_000_000,
        finishedAt: 1_800_000_090_000,
        commitSha: 'deadbeef',
        // Reworded help text is not a new alert, and neither is a new line.
        findings: [finding({ message: 'The server responded 500 (Internal Server Error)' })],
      }),
    ) as typeof first;

    expect(first.runs[0]?.results[0]?.partialFingerprints).toEqual(
      second.runs[0]?.results[0]?.partialFingerprints,
    );
  });

  it('DOES move when the finding is somewhere else, so a new alert is a new alert', () => {
    expect(fingerprintOf(finding())).not.toBe(fingerprintOf(finding({ location: 'POST /api/refund' })));
    expect(fingerprintOf(finding())).not.toBe(fingerprintOf(finding({ code: 'runtime.http-4xx' })));
    expect(fingerprintOf(finding())).not.toBe(fingerprintOf(finding({ kind: 'PERFORMANCE' })));
  });

  it('renders byte-identical output twice from one run, which is what a signature needs', () => {
    const input = report({ findings: [finding(), finding({ code: 'a11y.alt', kind: 'ACCESSIBILITY' })] });
    expect(sarifReporter.render(input).files[0]?.contents).toBe(
      sarifReporter.render(input).files[0]?.contents,
    );
  });
});
