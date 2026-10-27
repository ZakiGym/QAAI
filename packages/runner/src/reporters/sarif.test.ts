/**
 * SARIF reporter tests. What each section is here to catch:
 *
 *  1. **A file the consumer drops silently.** `schemaErrors` below is an
 *     INDEPENDENT transcription of SARIF 2.1.0's required properties and
 *     constrained values — written from the schema, not from the reporter — and
 *     every fixture is run through it. An assertion built from the reporter's
 *     own types would prove nothing; this one fails the moment the reporter
 *     emits an object that would be rejected at upload, which is the failure
 *     mode nobody sees because GitHub reports it as "0 alerts".
 *
 *  2. **Re-alarming.** A fingerprint that moves when a message is reworded or a
 *     line shifts makes every run look like a fresh batch of problems, which is
 *     how a SARIF integration gets switched off. Asserted directly.
 *
 *  3. **The pass that means we did not check.** `findings` absent must not
 *     produce a successful invocation with zero results.
 *
 *  4. **Suppressions that outlive their reason.** An expired or unevaluable
 *     acceptance must report the finding LIVE, with the reason attached.
 *
 *  5. **Invented data.** No zero line numbers, no 1970 timestamps, no
 *     placeholder repository URI, no security severity on an a11y rule.
 */

import { describe, expect, it } from 'vitest';
import { FINDING_SEVERITIES, type FindingSeverity } from '@qaai/shared';
import {
  MAX_SARIF_RESULTS,
  SARIF_LEVEL,
  SARIF_SCHEMA,
  SARIF_VERSION,
  SECURITY_SEVERITY,
  clockOf,
  fingerprintOf,
  locationsFor,
  regionOf,
  renderSarifLog,
  sarifReporter,
  suppressionState,
  type ReportedFinding,
  type SarifLog,
  type SarifRunReport,
} from './sarif.js';
import type { RunReport } from './types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function finding(over: Partial<ReportedFinding> = {}): ReportedFinding {
  return {
    kind: 'ACCESSIBILITY',
    severity: 'SERIOUS',
    code: 'color-contrast',
    message: 'Elements must have sufficient colour contrast (on /pricing)',
    location: 'div.hero > span.price',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.12/color-contrast',
    ...over,
  };
}

function report(over: Partial<SarifRunReport> = {}): SarifRunReport {
  return {
    id: 'run_abc',
    name: 'qaai',
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_060_000,
    commitSha: 'abc1234',
    branch: 'main',
    environment: 'staging',
    tests: [{ name: 'a11y scan', status: 'passed', durationMs: 1200 }],
    findings: [finding()],
    ...over,
  };
}

function parse(input: SarifRunReport): SarifLog {
  const [file] = sarifReporter.render(input).files;
  return JSON.parse(file!.contents) as SarifLog;
}

// ─── The independent schema oracle ───────────────────────────────────────────

const LEVELS = new Set(['none', 'note', 'warning', 'error']);
const SUPPRESSION_KINDS = new Set(['inSource', 'external']);
const SUPPRESSION_STATUSES = new Set(['accepted', 'underReview', 'rejected']);
/** SARIF's fingerprint keys are a stable `name/vN` pair. */
const FINGERPRINT_KEY = /^[A-Za-z][A-Za-z0-9]*\/v[0-9]+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** Membership for an `unknown` the schema says must be one of a fixed set. */
const oneOf = (set: ReadonlySet<string>, value: unknown): boolean =>
  typeof value === 'string' && set.has(value);

/**
 * Required properties and constrained values of SARIF 2.1.0, transcribed from
 * the schema. Keep it a transcription: "fix" it only when the schema changes.
 *
 *   sarifLog          required: version, runs
 *   run               required: tool
 *   toolComponent     required: name
 *   reportingDescriptor required: id
 *   result            required: message
 *   message           anyOf: text | id
 *   invocation        required: executionSuccessful
 *   notification      required: message
 *   physicalLocation  anyOf: address | artifactLocation
 *   versionControlDetails required: repositoryUri
 *   region            startLine/startColumn/endLine/endColumn minimum 1
 *   result.level      enum none|note|warning|error
 *   suppression       required: kind; kind enum; status enum
 */
function schemaErrors(log: unknown): string[] {
  const errors: string[] = [];
  const bad = (why: string): void => void errors.push(why);
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  if (!isObject(log)) return ['sarifLog is not an object'];
  if (log.version !== '2.1.0') bad('sarifLog.version must be the string "2.1.0"');
  if (!Array.isArray(log.runs)) return [...errors, 'sarifLog.runs is required and must be an array'];

  const message = (value: unknown, where: string): void => {
    if (!isObject(value)) return bad(`${where}.message is required`);
    const text = value.text;
    if (typeof value.id !== 'string' && (typeof text !== 'string' || text.length === 0)) {
      bad(`${where}.message needs a non-empty text or an id`);
    }
  };

  log.runs.forEach((run, r) => {
    const at = `runs[${r}]`;
    if (!isObject(run)) return bad(`${at} is not an object`);
    const tool = run.tool;
    if (!isObject(tool)) return bad(`${at}.tool is required`);
    const driver = tool.driver;
    if (!isObject(driver)) return bad(`${at}.tool.driver is required`);
    if (typeof driver.name !== 'string' || driver.name.length === 0) {
      bad(`${at}.tool.driver.name is required`);
    }
    if ('informationUri' in driver && typeof driver.informationUri !== 'string') {
      bad(`${at}.tool.driver.informationUri must be a string when present`);
    }

    const rules = driver.rules;
    const ruleIds: string[] = [];
    if (rules !== undefined) {
      if (!Array.isArray(rules)) bad(`${at}.tool.driver.rules must be an array`);
      else
        rules.forEach((rule, i) => {
          if (!isObject(rule)) return bad(`${at}.tool.driver.rules[${i}] is not an object`);
          if (typeof rule.id !== 'string' || rule.id.length === 0) {
            bad(`${at}.tool.driver.rules[${i}].id is required`);
          } else ruleIds.push(rule.id);
          if (rule.shortDescription !== undefined) {
            message(rule.shortDescription, `${at}.tool.driver.rules[${i}].shortDescription`);
          }
          const config = rule.defaultConfiguration;
          if (isObject(config) && config.level !== undefined && !oneOf(LEVELS, config.level)) {
            bad(`${at}.tool.driver.rules[${i}].defaultConfiguration.level is not a SARIF level`);
          }
        });
    }

    if (run.invocations !== undefined) {
      if (!Array.isArray(run.invocations)) bad(`${at}.invocations must be an array`);
      else
        run.invocations.forEach((invocation, i) => {
          const iAt = `${at}.invocations[${i}]`;
          if (!isObject(invocation)) return bad(`${iAt} is not an object`);
          if (typeof invocation.executionSuccessful !== 'boolean') {
            bad(`${iAt}.executionSuccessful is required and must be a boolean`);
          }
          for (const key of ['startTimeUtc', 'endTimeUtc'] as const) {
            const value = invocation[key];
            if (value !== undefined && (typeof value !== 'string' || !ISO_UTC.test(value))) {
              bad(`${iAt}.${key} must be an ISO 8601 UTC date-time`);
            }
          }
          const notifications = invocation.toolExecutionNotifications;
          if (notifications !== undefined) {
            if (!Array.isArray(notifications)) bad(`${iAt}.toolExecutionNotifications must be an array`);
            else
              notifications.forEach((notification, n) => {
                message(
                  isObject(notification) ? notification.message : undefined,
                  `${iAt}.toolExecutionNotifications[${n}]`,
                );
                if (
                  isObject(notification) &&
                  notification.level !== undefined &&
                  !oneOf(LEVELS, notification.level)
                ) {
                  bad(`${iAt}.toolExecutionNotifications[${n}].level is not a SARIF level`);
                }
              });
          }
        });
    }

    const provenance = run.versionControlProvenance;
    if (provenance !== undefined) {
      if (!Array.isArray(provenance)) bad(`${at}.versionControlProvenance must be an array`);
      else
        provenance.forEach((details, i) => {
          if (!isObject(details) || typeof details.repositoryUri !== 'string') {
            bad(`${at}.versionControlProvenance[${i}].repositoryUri is required`);
          }
        });
    }

    const results = run.results;
    if (results === undefined) return;
    if (!Array.isArray(results)) return bad(`${at}.results must be an array`);
    results.forEach((result, i) => {
      const rAt = `${at}.results[${i}]`;
      if (!isObject(result)) return bad(`${rAt} is not an object`);
      message(result.message, rAt);
      if (result.level !== undefined && !oneOf(LEVELS, result.level)) {
        bad(`${rAt}.level is not a SARIF level`);
      }
      if (typeof result.ruleId === 'string' && ruleIds.length > 0) {
        if (!ruleIds.includes(result.ruleId)) bad(`${rAt}.ruleId has no matching rule`);
        if (typeof result.ruleIndex === 'number' && ruleIds[result.ruleIndex] !== result.ruleId) {
          bad(`${rAt}.ruleIndex points at the wrong rule`);
        }
      }
      const fingerprints = result.partialFingerprints;
      if (fingerprints !== undefined) {
        if (!isObject(fingerprints)) bad(`${rAt}.partialFingerprints must be an object`);
        else
          for (const [key, value] of Object.entries(fingerprints)) {
            if (!FINGERPRINT_KEY.test(key)) bad(`${rAt}.partialFingerprints key "${key}" is not name/vN`);
            if (typeof value !== 'string' || value.length === 0) {
              bad(`${rAt}.partialFingerprints["${key}"] must be a non-empty string`);
            }
          }
      }
      const locations = result.locations;
      if (locations !== undefined) {
        if (!Array.isArray(locations)) bad(`${rAt}.locations must be an array`);
        else
          locations.forEach((location, l) => {
            const lAt = `${rAt}.locations[${l}]`;
            if (!isObject(location)) return bad(`${lAt} is not an object`);
            if (Object.keys(location).length === 0) bad(`${lAt} is empty`);
            const physical = location.physicalLocation;
            if (physical !== undefined) {
              if (!isObject(physical)) return bad(`${lAt}.physicalLocation is not an object`);
              const artifact = physical.artifactLocation;
              if (physical.address === undefined && !isObject(artifact)) {
                bad(`${lAt}.physicalLocation needs an address or an artifactLocation`);
              }
              if (isObject(artifact) && typeof artifact.uri !== 'string') {
                bad(`${lAt}.physicalLocation.artifactLocation.uri must be a string when present`);
              }
              const region = physical.region;
              if (region !== undefined) {
                if (!isObject(region)) return bad(`${lAt}.physicalLocation.region is not an object`);
                for (const key of ['startLine', 'startColumn', 'endLine', 'endColumn'] as const) {
                  const value = region[key];
                  if (value === undefined) continue;
                  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
                    bad(`${lAt}.physicalLocation.region.${key} must be an integer >= 1`);
                  }
                }
                const start = region.startLine;
                const end = region.endLine;
                if (typeof start === 'number' && typeof end === 'number' && end < start) {
                  bad(`${lAt}.physicalLocation.region.endLine precedes startLine`);
                }
              }
            }
          });
      }
      const suppressions = result.suppressions;
      if (suppressions !== undefined) {
        if (!Array.isArray(suppressions)) bad(`${rAt}.suppressions must be an array`);
        else
          suppressions.forEach((suppression, s) => {
            const sAt = `${rAt}.suppressions[${s}]`;
            if (!isObject(suppression)) return bad(`${sAt} is not an object`);
            if (!oneOf(SUPPRESSION_KINDS, suppression.kind)) bad(`${sAt}.kind is required and must be inSource|external`);
            if (suppression.status !== undefined && !oneOf(SUPPRESSION_STATUSES, suppression.status)) {
              bad(`${sAt}.status is not a SARIF suppression status`);
            }
          });
      }
    });
  });

  return errors;
}

/** Every fixture the oracle is run over. One per failure mode seen in the wild. */
const FIXTURES: Array<[string, SarifRunReport]> = [
  ['a plain accessibility finding', report()],
  ['no findings supplied at all', report({ findings: undefined })],
  ['an empty findings list', report({ findings: [] })],
  ['zero tests', report({ tests: [], findings: [] })],
  [
    'a security finding with a file and a region',
    report({
      findings: [
        finding({
          kind: 'SECURITY',
          severity: 'CRITICAL',
          code: 'idor',
          location: '/api/orders/42',
          uri: 'apps/api/src/routes/orders.ts',
          region: { startLine: 88, startColumn: 5, endLine: 92, endColumn: 2 },
          helpUrl: null,
        }),
      ],
    }),
  ],
  [
    'a finding whose location is a URL',
    report({ findings: [finding({ location: 'https://staging.example.com/pricing' })] }),
  ],
  [
    'junk regions and an empty message',
    report({
      findings: [
        finding({ code: 'a', message: '   ', region: { startLine: 0 } }),
        finding({ code: 'b', region: { startLine: 10, endLine: 2 } }),
        finding({ code: 'c', region: { startLine: 4, startColumn: 9, endLine: 4, endColumn: 1 } }),
      ],
    }),
  ],
  [
    'every severity and every kind',
    report({
      findings: FINDING_SEVERITIES.flatMap((severity, i) =>
        (['ACCESSIBILITY', 'SECURITY', 'PERFORMANCE', 'LOCALIZATION', 'VISUAL'] as const).map(
          (kind) => finding({ kind, severity, code: `${kind.toLowerCase()}-${i}` }),
        ),
      ),
    }),
  ],
  [
    'a live, an expired and an unparseable acceptance',
    report({
      findings: [
        finding({
          code: 'live',
          suppression: { justification: 'tracked', owner: 'a@b.c', expiresAtIso: '2099-01-01T00:00:00Z' },
        }),
        finding({ code: 'lapsed', suppression: { expiresAtIso: '2000-01-01T00:00:00Z' } }),
        finding({ code: 'garbled', suppression: { expiresAtIso: 'next tuesday' } }),
        finding({ code: 'forever', suppression: { owner: 'a@b.c' } }),
      ],
    }),
  ],
  ['no timestamps anywhere', report({ startedAt: undefined, finishedAt: undefined })],
  ['a repository uri', report({ repositoryUri: 'https://github.com/acme/app' })],
  ['no run id', report({ id: undefined })],
];

describe('sarif — the file a consumer will actually accept', () => {
  for (const [label, fixture] of FIXTURES) {
    it(`emits schema-valid SARIF 2.1.0 for ${label}`, () => {
      expect(schemaErrors(parse(fixture))).toEqual([]);
    });
  }

  it('declares the version and the schema', () => {
    const log = parse(report());
    expect(log.version).toBe(SARIF_VERSION);
    expect(log.version).toBe('2.1.0');
    expect(log.$schema).toBe(SARIF_SCHEMA);
  });

  it('writes one file, with the SARIF media type', () => {
    const document = sarifReporter.render(report());
    expect(document.files).toHaveLength(1);
    expect(document.files[0]!.path).toBe('qaai.sarif');
    expect(document.files[0]!.contentType).toBe('application/sarif+json');
    expect(document.files[0]!.contents.endsWith('\n')).toBe(true);
    expect(sarifReporter.directory).toBe(false);
    expect(sarifReporter.name).toBe('sarif');
  });

  it('is byte-identical when the same run is rendered twice', () => {
    const input = report();
    expect(sarifReporter.render(input).files[0]!.contents).toBe(
      sarifReporter.render(input).files[0]!.contents,
    );
  });

  it('never invents a provenance block it cannot make valid', () => {
    const without = parse(report());
    expect(without.runs[0]!.versionControlProvenance).toBeUndefined();
    // The commit is not lost — it moves somewhere no schema rule applies.
    expect(without.runs[0]!.properties.qaaiCommitSha).toBe('abc1234');

    const with_ = parse(report({ repositoryUri: 'https://github.com/acme/app' }));
    expect(with_.runs[0]!.versionControlProvenance).toEqual([
      { repositoryUri: 'https://github.com/acme/app', revisionId: 'abc1234', branch: 'main' },
    ]);
  });

  it('omits timestamps rather than writing 1970', () => {
    const log = parse(report({ startedAt: undefined, finishedAt: undefined }));
    const invocation = log.runs[0]!.invocations[0]!;
    expect(invocation.startTimeUtc).toBeUndefined();
    expect(invocation.endTimeUtc).toBeUndefined();
    expect(JSON.stringify(log)).not.toContain('1970');
  });

  it('omits informationUri and version rather than guessing them', () => {
    const driver = parse(report()).runs[0]!.tool.driver;
    expect(driver.informationUri).toBeUndefined();
    expect(driver.version).toBeUndefined();
    expect(parse(report({ toolVersion: '1.2.3' })).runs[0]!.tool.driver.version).toBe('1.2.3');
  });
});

describe('sarif — executionSuccessful is not "no findings"', () => {
  it('reports false, and says why, when no findings were supplied', () => {
    const document = sarifReporter.render(report({ findings: undefined }));
    const log = JSON.parse(document.files[0]!.contents) as SarifLog;
    const invocation = log.runs[0]!.invocations[0]!;
    expect(invocation.executionSuccessful).toBe(false);
    expect(invocation.toolExecutionNotifications?.[0]?.level).toBe('error');
    expect(invocation.toolExecutionNotifications?.[0]?.message.text).toContain(
      'because nothing was looked at',
    );
    expect(log.runs[0]!.properties.qaaiFindingsSupplied).toBe(false);
    expect(document.warnings.join(' ')).toContain('not the same as a clean scan');
  });

  it('reports true for a genuinely clean run', () => {
    const log = parse(report({ findings: [] }));
    expect(log.runs[0]!.invocations[0]!.executionSuccessful).toBe(true);
    expect(log.runs[0]!.invocations[0]!.toolExecutionNotifications).toBeUndefined();
    expect(log.runs[0]!.properties.qaaiFindingsSupplied).toBe(true);
  });

  it('reports false when nothing executed', () => {
    const log = parse(report({ tests: [], findings: [] }));
    expect(log.runs[0]!.invocations[0]!.executionSuccessful).toBe(false);
    expect(log.runs[0]!.invocations[0]!.toolExecutionNotifications?.[0]?.message.text).toContain(
      'evidence of nothing',
    );
  });
});

describe('sarif — fingerprints that do not re-alarm', () => {
  it('is unchanged by a reworded message, a moved line, a new run and a new timestamp', () => {
    const base = finding();
    const moved = finding({
      message: 'Contrast too low',
      region: { startLine: 400 },
      uri: 'src/Hero.tsx',
    });
    expect(fingerprintOf(moved)).toBe(fingerprintOf(base));

    const first = parse(report({ id: 'run_1', startedAt: 1, finishedAt: 2 }));
    const second = parse(report({ id: 'run_2', startedAt: 9, finishedAt: 10 }));
    expect(second.runs[0]!.results[0]!.partialFingerprints).toEqual(
      first.runs[0]!.results[0]!.partialFingerprints,
    );
  });

  it('changes when the code, the kind or the location changes', () => {
    const base = fingerprintOf(finding());
    expect(fingerprintOf(finding({ code: 'other' }))).not.toBe(base);
    expect(fingerprintOf(finding({ kind: 'SECURITY' }))).not.toBe(base);
    expect(fingerprintOf(finding({ location: 'div.footer' }))).not.toBe(base);
  });

  it('carries no run id and no timestamp inside the fingerprint value', () => {
    const value = parse(report()).runs[0]!.results[0]!.partialFingerprints['qaaiFinding/v1']!;
    expect(value).toMatch(/^[0-9a-f]{32}$/);
    expect(value).not.toContain('run_abc');
  });
});

describe('sarif — locations, and the file it refuses to invent', () => {
  it('pins a file-and-region finding precisely, under SRCROOT', () => {
    const [location] = locationsFor(
      finding({ uri: 'apps/api/src/routes/orders.ts', region: { startLine: 88, startColumn: 5 } }),
    );
    expect(location!.physicalLocation).toEqual({
      artifactLocation: { uri: 'apps/api/src/routes/orders.ts', uriBaseId: 'SRCROOT' },
      region: { startLine: 88, startColumn: 5 },
    });
    // The selector survives alongside the file: it is the only thing that says
    // which of forty elements on the page failed.
    expect(location!.logicalLocations?.[0]?.fullyQualifiedName).toBe('div.hero > span.price');
  });

  it('uses an absolute URL as the artifact, with no base id', () => {
    const [location] = locationsFor(finding({ location: 'https://staging.example.com/pricing' }));
    expect(location!.physicalLocation?.artifactLocation).toEqual({
      uri: 'https://staging.example.com/pricing',
    });
    // Not repeated as a logical location — it already IS the artifact.
    expect(location!.logicalLocations).toBeUndefined();
  });

  it('gives a selector a logical location and no invented file', () => {
    const [location] = locationsFor(finding());
    expect(location!.physicalLocation).toBeUndefined();
    expect(location!.logicalLocations).toEqual([
      { fullyQualifiedName: 'div.hero > span.price', kind: 'member' },
    ]);
  });

  it('counts the findings GitHub will not display, and says why', () => {
    const warnings = sarifReporter.render(report()).warnings.join(' ');
    expect(warnings).toContain('1 finding(s) carry no file or URL');
    expect(warnings).toContain('does not display a result without a physical location');
  });

  it('always carries the raw location on properties, whatever became of it', () => {
    for (const fixture of [finding(), finding({ uri: 'a.ts' }), finding({ location: 'https://x/y' })]) {
      const log = parse(report({ findings: [fixture] }));
      expect(log.runs[0]!.results[0]!.properties.qaaiLocation).toBe(fixture.location);
    }
  });
});

describe('sarif — regions are dropped, never clamped', () => {
  it('drops a region with no usable start line', () => {
    expect(regionOf(undefined)).toBeNull();
    expect(regionOf({})).toBeNull();
    expect(regionOf({ startLine: 0 })).toBeNull();
    expect(regionOf({ startLine: -3 })).toBeNull();
    expect(regionOf({ startLine: 1.5 })).toBeNull();
  });

  it('drops an inverted end line and an impossible end column', () => {
    expect(regionOf({ startLine: 10, endLine: 2 })).toEqual({ startLine: 10 });
    expect(regionOf({ startLine: 4, startColumn: 9, endLine: 4, endColumn: 1 })).toEqual({
      startLine: 4,
      startColumn: 9,
      endLine: 4,
    });
    expect(regionOf({ startLine: 4, startColumn: 9, endLine: 5, endColumn: 1 })).toEqual({
      startLine: 4,
      startColumn: 9,
      endLine: 5,
      endColumn: 1,
    });
  });

  it('counts the dropped regions rather than pinning the finding to line 1', () => {
    const document = sarifReporter.render(
      report({ findings: [finding({ uri: 'a.ts', region: { startLine: 0 } })] }),
    );
    const log = JSON.parse(document.files[0]!.contents) as SarifLog;
    expect(log.runs[0]!.results[0]!.locations?.[0]?.physicalLocation?.region).toBeUndefined();
    expect(document.warnings.join(' ')).toContain('1 finding(s) supplied a region SARIF cannot');
    expect(document.warnings.join(' ')).toContain('dropped rather than clamped');
  });
});

describe('sarif — severity', () => {
  it('maps every platform severity and nothing else', () => {
    // The run-time half of the pattern: the compiler cannot see a Record that
    // has drifted from the array it was keyed on.
    expect(Object.keys(SARIF_LEVEL).sort()).toEqual([...FINDING_SEVERITIES].sort());
    expect(Object.keys(SECURITY_SEVERITY).sort()).toEqual([...FINDING_SEVERITIES].sort());
    for (const severity of FINDING_SEVERITIES) {
      expect(LEVELS.has(SARIF_LEVEL[severity])).toBe(true);
    }
  });

  it('keeps the exact severity on the result, since SARIF has only four levels', () => {
    for (const severity of FINDING_SEVERITIES) {
      const log = parse(report({ findings: [finding({ severity })] }));
      const result = log.runs[0]!.results[0]!;
      expect(result.level).toBe(SARIF_LEVEL[severity]);
      expect(result.properties.qaaiSeverity).toBe(severity);
    }
    // The collapse this records: CRITICAL and SERIOUS share a level, and the
    // difference survives only on properties.
    expect(SARIF_LEVEL.CRITICAL).toBe(SARIF_LEVEL.SERIOUS);
  });

  it('levels a rule at the worst severity seen for it', () => {
    const log = parse(
      report({
        findings: [
          finding({ code: 'mixed', severity: 'MINOR' }),
          finding({ code: 'mixed', severity: 'CRITICAL', location: 'div.other' }),
        ],
      }),
    );
    expect(log.runs[0]!.tool.driver.rules).toHaveLength(1);
    expect(log.runs[0]!.tool.driver.rules[0]!.defaultConfiguration.level).toBe('error');
  });

  it('puts security-severity on security rules only', () => {
    const security = parse(report({ findings: [finding({ kind: 'SECURITY', severity: 'CRITICAL' })] }));
    const rule = security.runs[0]!.tool.driver.rules[0]!;
    expect(rule.properties['security-severity']).toBe(SECURITY_SEVERITY.CRITICAL);
    expect(rule.properties.tags).toContain('security');

    const a11y = parse(report()).runs[0]!.tool.driver.rules[0]!;
    expect(a11y.properties['security-severity']).toBeUndefined();
    expect(a11y.properties.tags).not.toContain('security');
    expect(a11y.properties.tags).toContain('qaai:accessibility');
  });
});

describe('sarif — rules', () => {
  it('emits one rule per code, in first-seen order, with the index that matches', () => {
    const log = parse(
      report({
        findings: [
          finding({ code: 'b' }),
          finding({ code: 'a', location: 'x' }),
          finding({ code: 'b', location: 'y' }),
        ],
      }),
    );
    expect(log.runs[0]!.tool.driver.rules.map((rule) => rule.id)).toEqual(['b', 'a']);
    expect(log.runs[0]!.results.map((result) => result.ruleIndex)).toEqual([0, 1, 0]);
  });

  it('picks up a help URL from whichever finding carries one', () => {
    const log = parse(
      report({
        findings: [
          finding({ code: 'late', helpUrl: null }),
          finding({ code: 'late', helpUrl: 'https://help/late', location: 'z' }),
        ],
      }),
    );
    expect(log.runs[0]!.tool.driver.rules[0]!.helpUri).toBe('https://help/late');
  });

  it('says that the rule descriptions are generated, rather than copying one finding onto the rule', () => {
    const document = sarifReporter.render(report());
    const log = JSON.parse(document.files[0]!.contents) as SarifLog;
    expect(log.runs[0]!.tool.driver.rules[0]!.shortDescription.text).toBe(
      'QAAI ACCESSIBILITY check `color-contrast`',
    );
    expect(document.warnings.join(' ')).toContain('generated shortDescription');
  });

  it('emits no rule for a finding the cap removed', () => {
    const findings = Array.from({ length: MAX_SARIF_RESULTS + 3 }, (_, i) =>
      finding({ code: `rule-${i}`, location: `sel-${i}` }),
    );
    const document = sarifReporter.render(report({ findings }));
    const log = JSON.parse(document.files[0]!.contents) as SarifLog;
    expect(log.runs[0]!.results).toHaveLength(MAX_SARIF_RESULTS);
    expect(log.runs[0]!.tool.driver.rules).toHaveLength(MAX_SARIF_RESULTS);
    expect(schemaErrors(log)).toEqual([]);
  });
});

describe('sarif — the cap is disclosed in the file, not only in our warnings', () => {
  it('counts the omission and gives the reason, in both places', () => {
    const findings = Array.from({ length: MAX_SARIF_RESULTS + 7 }, (_, i) =>
      finding({ code: 'same', location: `sel-${i}` }),
    );
    const document = sarifReporter.render(report({ findings }));
    const log = JSON.parse(document.files[0]!.contents) as SarifLog;
    const notification = log.runs[0]!.invocations[0]!.toolExecutionNotifications?.[0];
    expect(notification?.message.text).toContain('7 of 5007 finding(s) were omitted');
    expect(notification?.message.text).toContain('rejects an upload above that');
    expect(document.warnings.join(' ')).toContain(`7 finding(s) were omitted by the ${MAX_SARIF_RESULTS}-result cap`);
  });

  it('says nothing about a cap that did not bite', () => {
    const document = sarifReporter.render(report());
    expect(document.warnings.join(' ')).not.toContain('omitted by the');
    expect(
      (JSON.parse(document.files[0]!.contents) as SarifLog).runs[0]!.invocations[0]!
        .toolExecutionNotifications,
    ).toBeUndefined();
  });
});

describe('sarif — suppressions fail toward visible', () => {
  const live = { justification: 'risk accepted', owner: 'sec@acme.test', expiresAtIso: '2099-01-01T00:00:00Z' };

  it('suppresses a live acceptance, and keeps the owner and expiry', () => {
    const log = parse(report({ findings: [finding({ suppression: live })] }));
    const result = log.runs[0]!.results[0]!;
    expect(result.suppressions).toEqual([
      {
        kind: 'external',
        status: 'accepted',
        justification: 'risk accepted',
        properties: { qaaiOwner: 'sec@acme.test', qaaiExpiresAt: '2099-01-01T00:00:00Z' },
      },
    ]);
    expect(result.properties.qaaiSuppressionNotApplied).toBeUndefined();
  });

  it('reports a LAPSED acceptance live, with the reason on the result', () => {
    const document = sarifReporter.render(
      report({ findings: [finding({ suppression: { ...live, expiresAtIso: '2000-01-01T00:00:00Z' } })] }),
    );
    const result = (JSON.parse(document.files[0]!.contents) as SarifLog).runs[0]!.results[0]!;
    expect(result.suppressions).toBeUndefined();
    expect(result.properties.qaaiSuppressionNotApplied).toBe('expired');
    expect(document.warnings.join(' ')).toContain('1 accepted finding(s) have a LAPSED acceptance');
  });

  it('reports an unparseable expiry live rather than reading it as open-ended', () => {
    const document = sarifReporter.render(
      report({ findings: [finding({ suppression: { expiresAtIso: 'next tuesday' } })] }),
    );
    const result = (JSON.parse(document.files[0]!.contents) as SarifLog).runs[0]!.results[0]!;
    expect(result.suppressions).toBeUndefined();
    expect(result.properties.qaaiSuppressionNotApplied).toBe('unevaluable');
    expect(document.warnings.join(' ')).toContain('could not have their expiry evaluated');
  });

  it('cannot hide anything when there is no clock to evaluate the expiry against', () => {
    const document = sarifReporter.render(
      report({ startedAt: undefined, finishedAt: undefined, findings: [finding({ suppression: live })] }),
    );
    const result = (JSON.parse(document.files[0]!.contents) as SarifLog).runs[0]!.results[0]!;
    expect(result.suppressions).toBeUndefined();
    expect(result.properties.qaaiSuppressionNotApplied).toBe('unevaluable');
  });

  it('honours an acceptance with no expiry, and names the problem with that', () => {
    const document = sarifReporter.render(
      report({ findings: [finding({ suppression: { justification: 'wontfix' } })] }),
    );
    const result = (JSON.parse(document.files[0]!.contents) as SarifLog).runs[0]!.results[0]!;
    expect(result.suppressions?.[0]?.status).toBe('accepted');
    const warnings = document.warnings.join(' ');
    expect(warnings).toContain('1 suppressed finding(s) have no expiry');
    expect(warnings).toContain('1 suppressed finding(s) carry no owner');
  });

  it('names an acceptance with no justification', () => {
    const document = sarifReporter.render(
      report({ findings: [finding({ suppression: { owner: 'a@b.c' } })] }),
    );
    expect(document.warnings.join(' ')).toContain('carry no justification');
  });

  it('answers the three states directly', () => {
    const at = (ms: number) => ({ nowMs: () => ms });
    expect(suppressionState({}, null)).toEqual({ applied: true });
    expect(suppressionState({ expiresAtIso: '2099-01-01T00:00:00Z' }, at(0))).toEqual({ applied: true });
    expect(suppressionState({ expiresAtIso: '1999-01-01T00:00:00Z' }, at(Date.parse('2020-01-01')))).toEqual({
      applied: false,
      why: 'expired',
    });
    expect(suppressionState({ expiresAtIso: 'nope' }, at(0))).toEqual({ applied: false, why: 'unevaluable' });
    expect(suppressionState({ expiresAtIso: '2099-01-01T00:00:00Z' }, null)).toEqual({
      applied: false,
      why: 'unevaluable',
    });
  });
});

describe('sarif — the clock is the run, not the wall', () => {
  it('reads the run stamp, so two renders of one run agree', () => {
    expect(clockOf(report())!.nowMs()).toBe(1_700_000_060_000);
    expect(clockOf(report({ finishedAt: undefined }))!.nowMs()).toBe(1_700_000_000_000);
    expect(clockOf(report({ startedAt: undefined, finishedAt: undefined }))).toBeNull();
  });

  it('renders the log through the exported entry point too', () => {
    const log = renderSarifLog(report(), clockOf(report()));
    expect(schemaErrors(log)).toEqual([]);
    expect(log.runs[0]!.automationDetails).toEqual({ id: 'qaai/run_abc' });
    expect(renderSarifLog(report({ id: undefined }), null).runs[0]!.automationDetails).toBeUndefined();
  });
});

describe('sarif — message.text is required and may not be empty', () => {
  it('substitutes the code and counts the substitution', () => {
    const document = sarifReporter.render(report({ findings: [finding({ message: '   ' })] }));
    const log = JSON.parse(document.files[0]!.contents) as SarifLog;
    expect(log.runs[0]!.results[0]!.message.text).toBe(
      'ACCESSIBILITY finding `color-contrast`',
    );
    expect(document.warnings.join(' ')).toContain('1 finding(s) had an empty message');
    expect(schemaErrors(log)).toEqual([]);
  });
});

describe('sarif — the test that found it', () => {
  it('names the test on the result when the finding carries one', () => {
    const log = parse(
      report({ findings: [finding({ testId: 't_1', testName: 'Pricing page a11y' })] }),
    );
    expect(log.runs[0]!.results[0]!.properties.qaaiTest).toBe('Pricing page a11y');
    expect(log.runs[0]!.results[0]!.properties.qaaiTestId).toBe('t_1');
  });

  it('omits them rather than writing a placeholder', () => {
    const properties = parse(report()).runs[0]!.results[0]!.properties;
    expect('qaaiTest' in properties).toBe(false);
    expect('qaaiTestId' in properties).toBe(false);
  });
});


/**
 * The four properties `reporters.test.ts` applies to every member of
 * `sarifReporterS`, asserted here against a reporter that is not on that list yet.
 *
 * This is deliberate duplication. The registry loop cannot see this reporter
 * until somebody adds it to `sarifReporterS` in `index.ts` (a file this round does
 * not own), and "it will pass once wired" is not a thing to find out during the
 * wiring. The untimed fixture is transcribed from that file.
 */
const UNTIMED: RunReport = {
  id: 'run_untimed',
  tests: [
    { name: 'C42 imported case with no timing', status: 'passed' },
    { name: 'C43 also untimed', status: 'failed', message: 'boom' },
  ],
};

describe('sarif — the properties the registry applies to every reporter', () => {
  it('never throws, on any fixture', () => {
    for (const report of FIXTURES.map(([, fixture]) => fixture)) {
      expect(() => sarifReporter.render(report, { testRailRunId: 1 })).not.toThrow();
    }
  });

  it('always produces named files with content types', () => {
    for (const report of FIXTURES.map(([, fixture]) => fixture)) {
      for (const file of sarifReporter.render(report, { testRailRunId: 1 }).files) {
        expect(file.path).not.toBe('');
        expect(file.path).not.toContain('..');
        expect(file.contentType).toMatch(/\//);
      }
    }
  });

  it('never invents a timing for a test the run did not time', () => {
    const text = sarifReporter.render(UNTIMED, { testRailRunId: 1 })
      .files.map((f) => f.contents)
      .join('\n');
    expect(text).not.toContain('time="0.000"');
    expect(text).not.toContain('"elapsed"');
    expect(text).not.toContain('"start": 0');
    expect(text).not.toContain('"stop": 0');
    expect(text).not.toContain('"durationMs": 0');
  });

  it('says out loud when it left something out', () => {
    expect(sarifReporter.render(UNTIMED, { testRailRunId: 1 }).warnings.length).toBeGreaterThan(0);
  });
});

// A severity the platform does not have must not compile into a level. Kept as
// a type-level assertion because the run-time parity test above cannot see it.
const _exhaustive: Record<FindingSeverity, true> = {
  CRITICAL: true,
  SERIOUS: true,
  MODERATE: true,
  MINOR: true,
};
void _exhaustive;
