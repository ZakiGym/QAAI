/**
 * SARIF 2.1.0 — the one format a security team's tooling already ingests.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * Before it, QAAI's findings existed in exactly two places: a `Finding[]` on a
 * `TestResult` row, and a list in QAAI's own UI. Every accessibility violation,
 * auth-wall bypass, IDOR and weak-cookie finding the plugins produce reached
 * GitHub code scanning, Defect Dojo, SonarQube and every other tool a security
 * team actually watches: never. A finding nobody is paged about is a finding
 * nobody fixes, and a QA product whose results only live in its own dashboard
 * is a second dashboard.
 *
 * ── The constraint that shapes every decision below ──────────────────────────
 *
 * **An invalid SARIF file is dropped SILENTLY.** GitHub's upload endpoint
 * rejects the whole run, Defect Dojo imports zero findings, and nothing in
 * either UI says why — the team sees a green badge and believes a scan ran.
 * That is strictly worse than emitting nothing, because nothing is visible and
 * a silent drop is reassuring. So this reporter is paranoid in one direction
 * only: where the schema has a required property we cannot honestly fill, the
 * CONTAINING OBJECT IS OMITTED rather than filled with a placeholder.
 *
 * Three places that bites, each of which was a real trap:
 *
 *  - `versionControlDetails` REQUIRES `repositoryUri`. A run knows its commit
 *    and branch but not its repository URL, so emitting provenance from
 *    `commitSha` alone produces a file that fails validation over a field
 *    nobody asked for. Without `repositoryUri` the whole
 *    `versionControlProvenance` block is omitted and the commit is carried in
 *    `run.properties` instead, where no schema rule applies to it.
 *  - `invocation` REQUIRES `executionSuccessful`, and it does NOT mean "no
 *    findings". It means "trust the absence of results". See
 *    {@link executionSucceeded}: a run that was handed no findings at all
 *    reports `false`, because zero results from a tool that never looked is the
 *    exact pass-means-we-did-not-check lie this product cannot afford.
 *  - `message` REQUIRES `text`, and a `Finding` with an empty message is
 *    possible (a plugin interpolating an empty string). The code is substituted
 *    and the substitution is counted in `warnings`.
 *
 * ── What is deliberately NOT invented ───────────────────────────────────────
 *
 *  - `driver.informationUri` is omitted unless the caller supplies one. It is
 *    the tool's home page, this reporter does not know it, and an invented URI
 *    is a link an auditor clicks.
 *  - CWE/OWASP taxa. QAAI's plugins do not record a CWE, and a mapping guessed
 *    from a rule id would be a security claim with nothing behind it.
 *  - A rule description. The plugins produce a per-FINDING message (which
 *    interpolates the route) and no per-RULE prose, so `shortDescription` names
 *    the check and the count of rules in that state is reported. A rule
 *    description copied from the first finding would read as documentation and
 *    be about one route.
 *  - A physical location for a finding whose location is a CSS selector. See
 *    {@link locationsFor}.
 *
 * ── Fingerprints, which decide whether a team keeps using this ───────────────
 *
 * `partialFingerprints` is how a consumer decides "same alert" versus "new
 * alert". Put anything volatile in it and every run re-alarms on everything,
 * which is how a SARIF integration gets switched off in week two. So the
 * fingerprint covers kind + code + location and deliberately EXCLUDES the
 * message (reworded prose is not a new finding), the line number (inserting an
 * import above a violation is not a new finding), the run id and every
 * timestamp. See {@link fingerprintOf}.
 *
 * ── Clock ────────────────────────────────────────────────────────────────────
 *
 * A suppression can expire, and evaluating that needs a clock. This file never
 * calls `Date.now()`: the clock is injected, and when there is none an expiry
 * CANNOT be evaluated — so the suppression is not applied and the finding is
 * emitted live. Failing toward visible is the only safe direction for a
 * mechanism whose job is to hide things.
 */

import { createHash } from 'node:crypto';
import type { Finding, FindingSeverity } from '@qaai/shared';
import type { Reporter, ReporterDocument, ReporterFile, RunReport } from './types.js';

// ─── The clock, as a surface ─────────────────────────────────────────────────

/**
 * Epoch milliseconds, injected.
 *
 * An interface rather than a bare number because `evidence-pack.ts` takes the
 * same surface and the two must not drift into two notions of "now". `null`
 * from {@link clockOf} means genuinely unavailable, which is a different fact
 * from zero and is handled as one everywhere below.
 */
export interface ReportClock {
  nowMs(): number;
}

/**
 * The clock a registry call has, which is the run's own finish stamp.
 *
 * Not `Date.now()`, and not a fallback to it: the question a suppression expiry
 * asks is "was this waiver live when the run happened", and answering it with
 * the wall clock at render time gives a different answer for the same run
 * depending on when somebody exported it. A report rendered twice must say the
 * same thing.
 */
export function clockOf(report: RunReport): ReportClock | null {
  const stamp = report.finishedAt ?? report.startedAt;
  if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return null;
  return { nowMs: () => stamp };
}

// ─── Findings, as a reporter sees them ───────────────────────────────────────

/** A 1-based source region. Every field optional because producers differ. */
export interface FindingRegion {
  /** 1-based. A region with no usable `startLine` is dropped, never zeroed. */
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

/**
 * A finding the team has accepted, with the two things an acceptance needs.
 *
 * `owner` and `expiresAtIso` are not decoration: an accepted finding with
 * neither is a finding that has been switched off forever by nobody, which is
 * how a suppression list becomes the place findings go to die. Both are
 * OPTIONAL in the type because a producer may genuinely not have them, and
 * their absence is reported rather than tolerated silently — see the warnings
 * at the bottom of `render`.
 */
export interface FindingSuppression {
  /** Why it was accepted. SARIF's `justification`. */
  justification?: string;
  /** Who accepted it. */
  owner?: string;
  /** When the acceptance lapses, ISO 8601. An expired one does not suppress. */
  expiresAtIso?: string;
}

/**
 * The platform's `Finding`, plus the things SARIF needs and a `Finding` lacks.
 *
 * It EXTENDS `@qaai/shared`'s `Finding` rather than restating it, so a new
 * `FindingKind` or severity reaches this reporter as a type error rather than as
 * a silently unmapped value.
 *
 * Every added field is optional, and every one of them is a thing a plugin may
 * genuinely not know. `uri` is the one that matters most: see
 * {@link locationsFor}.
 */
export interface ReportedFinding extends Finding {
  /**
   * The artifact the finding is IN: a repo-relative file path, or the absolute
   * URL of the page it was found on.
   *
   * Distinct from `Finding.location`, which the plugins fill with whatever they
   * have — a CSS selector (accessibility), a route (security), a URL. A
   * selector is not an artifact, so it cannot become `artifactLocation.uri`.
   */
  uri?: string;
  region?: FindingRegion;
  /** The test that produced it, for `result.properties`. */
  testId?: string;
  testName?: string;
  /** SARIF's opaque rule `name`. Omitted when the producer has none. */
  ruleName?: string;
  /** Rule tags, merged across findings sharing a code. */
  tags?: readonly string[];
  suppression?: FindingSuppression;
}

/** A `RunReport` carrying findings. See the note in `index.ts` about the field. */
export interface SarifRunReport extends RunReport {
  findings?: readonly ReportedFinding[];
  /** The tool version written into `driver`. Omitted, never guessed. */
  toolVersion?: string;
  /** Required before any provenance block can be emitted at all. */
  repositoryUri?: string;
  /** The tool's home page. Omitted rather than invented. */
  informationUri?: string;
}

// ─── SARIF 2.1.0, only the parts this reporter writes ────────────────────────

export const SARIF_VERSION = '2.1.0';
export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';

export type SarifLevel = 'none' | 'note' | 'warning' | 'error';

export interface SarifMessage {
  text: string;
}

export interface SarifRegion {
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

export interface SarifLocation {
  physicalLocation?: {
    artifactLocation: { uri: string; uriBaseId?: string };
    region?: SarifRegion;
  };
  logicalLocations?: Array<{ fullyQualifiedName: string; kind: string }>;
}

export interface SarifSuppression {
  /** `external` — the acceptance lives in QAAI, not in a source comment. */
  kind: 'external' | 'inSource';
  status: 'accepted' | 'underReview' | 'rejected';
  justification?: string;
  properties?: Record<string, unknown>;
}

export interface SarifReportingDescriptor {
  id: string;
  name?: string;
  shortDescription: SarifMessage;
  helpUri?: string;
  defaultConfiguration: { level: SarifLevel };
  properties: { tags: string[]; qaaiKind: string; 'security-severity'?: string };
}

export interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: SarifLevel;
  message: SarifMessage;
  locations?: SarifLocation[];
  partialFingerprints: Record<string, string>;
  suppressions?: SarifSuppression[];
  properties: Record<string, unknown>;
}

export interface SarifNotification {
  level: SarifLevel;
  message: SarifMessage;
}

export interface SarifInvocation {
  /** NOT "no findings". See the header. */
  executionSuccessful: boolean;
  startTimeUtc?: string;
  endTimeUtc?: string;
  toolExecutionNotifications?: SarifNotification[];
}

export interface SarifRun {
  tool: {
    driver: {
      name: string;
      version?: string;
      informationUri?: string;
      rules: SarifReportingDescriptor[];
    };
  };
  automationDetails?: { id: string };
  versionControlProvenance?: Array<{
    repositoryUri: string;
    revisionId?: string;
    branch?: string;
  }>;
  invocations: SarifInvocation[];
  results: SarifResult[];
  properties: Record<string, unknown>;
}

export interface SarifLog {
  $schema: string;
  version: typeof SARIF_VERSION;
  runs: SarifRun[];
}

// ─── Severity ────────────────────────────────────────────────────────────────

/**
 * Four platform severities into SARIF's three usable levels.
 *
 * A compiler-enforced `Record` over `FindingSeverity`, not a lookup with a
 * fallback: a fifth severity must break the build here rather than arrive as
 * `undefined` and render as a missing `level` that fails validation. The
 * run-time parity test in `sarif.test.ts` covers the other half — that every
 * member of `FINDING_SEVERITIES` has an entry and nothing else does — because
 * the compiler cannot see a `Record` that has drifted from the array it was
 * derived from.
 *
 * CRITICAL and SERIOUS both become `error`, which LOSES a distinction. SARIF
 * has no fifth level and `none` means "not a problem", so the choice is to
 * collapse at the top or to file a SERIOUS finding as a warning somebody
 * filters out. The exact severity survives in `result.properties.qaaiSeverity`
 * and in `security-severity` below, so nothing is thrown away — only the
 * one-level summary a consumer sorts by is approximate, and it is approximate
 * in the safe direction.
 */
export const SARIF_LEVEL: Record<FindingSeverity, SarifLevel> = {
  CRITICAL: 'error',
  SERIOUS: 'error',
  MODERATE: 'warning',
  MINOR: 'note',
};

/**
 * GitHub code scanning's `security-severity`, which is the only way a security
 * alert gets a severity there at all.
 *
 * This is a RE-ENCODING of our own four levels onto GitHub's documented 0–10
 * scale and carries no information the finding did not already have. It is not
 * a CVSS score, it was not calculated from anything, and it is emitted only on
 * SECURITY rules — putting it on an accessibility rule would make GitHub file
 * a colour-contrast violation as a vulnerability.
 */
export const SECURITY_SEVERITY: Record<FindingSeverity, string> = {
  CRITICAL: '9.0',
  SERIOUS: '7.0',
  MODERATE: '5.0',
  MINOR: '3.0',
};

// ─── Caps ────────────────────────────────────────────────────────────────────

/**
 * GitHub code scanning rejects an upload with more than 5000 results in a run.
 *
 * A cap that is hit SILENTLY is the same lie as a missing scan, so when it
 * bites the count and the reason go into `warnings` AND into
 * `toolExecutionNotifications` — the second one because the consumer never sees
 * our warnings, only the file.
 */
export const MAX_SARIF_RESULTS = 5000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Stable identity for a finding across runs.
 *
 * Covers kind + code + location. Excludes the message (a reworded help string
 * is not a new finding), the region (an inserted import above a violation is
 * not a new finding), the run id and every timestamp — put any of those in and
 * the consumer re-alarms on everything every run, which is how a SARIF
 * integration gets turned off.
 *
 * sha256 truncated to 32 hex characters: an identifier, not a security
 * boundary, and short enough to read in a diff of two uploads.
 */
export function fingerprintOf(finding: ReportedFinding): string {
  return createHash('sha256')
    .update([finding.kind, finding.code, finding.location].join('\u0000'))
    .digest('hex')
    .slice(0, 32);
}

/**
 * A region only when it is one SARIF will accept.
 *
 * Every bound in SARIF is 1-based and `endLine` may not precede `startLine`. A
 * producer handing over `startLine: 0` means "I do not know", and writing it
 * through fails validation and drops the whole file. So an unusable region is
 * dropped and counted, never clamped to 1 — a finding pinned to line 1 of the
 * wrong file is worse than a finding with no line.
 */
export function regionOf(region: FindingRegion | undefined): SarifRegion | null {
  if (!region) return null;
  const startLine = region.startLine;
  if (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1) return null;

  const out: SarifRegion = { startLine };
  const positive = (n: number | undefined): number | undefined =>
    typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : undefined;

  const startColumn = positive(region.startColumn);
  if (startColumn !== undefined) out.startColumn = startColumn;

  const endLine = positive(region.endLine);
  if (endLine !== undefined && endLine >= startLine) out.endLine = endLine;

  const endColumn = positive(region.endColumn);
  // An end column only means anything once an end line is fixed, and on a
  // single-line region it may not precede the start column.
  if (endColumn !== undefined && out.endLine !== undefined) {
    if (out.endLine > startLine || startColumn === undefined || endColumn >= startColumn) {
      out.endColumn = endColumn;
    }
  }
  return out;
}

/** An absolute http(s) URI, which SARIF accepts as an artifact location. */
function isHttpUri(value: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(value);
}

/**
 * Where the finding is, in the two vocabularies SARIF has for it.
 *
 * The split matters because of how consumers behave, not because of the schema:
 * GitHub code scanning renders a result inline only when it has a
 * `physicalLocation` with a repo-relative `uri`, and IGNORES a result whose
 * only location is logical. So:
 *
 *  - `uri` present → a physical location, with `SRCROOT` as the base id for a
 *    relative path (a repo-relative path with no base id is resolved against
 *    nothing) and no base id for an absolute URL.
 *  - `Finding.location` that is itself an http(s) URL → a physical location at
 *    that URL. This is what the accessibility and security plugins have for a
 *    page-level finding, and it is a real artifact.
 *  - anything else (a CSS selector, a route) → a LOGICAL location only.
 *    Inventing a file for `button.submit > span` would pin a finding to a file
 *    chosen by a guess, and a wrong line number in a security report is a
 *    developer's afternoon. The count of findings in this state is reported, so
 *    "why does GitHub show fewer alerts than QAAI" has an answer.
 *
 * `Finding.location` is ALWAYS carried as a logical location as well, even
 * alongside a file, because the selector is the only thing that says which of
 * forty buttons on the page failed.
 */
export function locationsFor(finding: ReportedFinding): SarifLocation[] {
  const location: SarifLocation = {};
  const uri = finding.uri?.trim();
  const raw = finding.location.trim();

  const artifactUri = uri && uri.length > 0 ? uri : isHttpUri(raw) ? raw : null;
  if (artifactUri !== null) {
    const artifactLocation: { uri: string; uriBaseId?: string } = { uri: artifactUri };
    if (!isHttpUri(artifactUri)) artifactLocation.uriBaseId = 'SRCROOT';
    const region = regionOf(finding.region);
    location.physicalLocation = region === null
      ? { artifactLocation }
      : { artifactLocation, region };
  }

  if (raw.length > 0 && raw !== artifactUri) {
    location.logicalLocations = [{ fullyQualifiedName: raw, kind: 'member' }];
  }

  return Object.keys(location).length > 0 ? [location] : [];
}

/** ISO 8601 with a `Z`, which is what SARIF's date-time format requires. */
function utc(stamp: number | undefined): string | undefined {
  if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return undefined;
  const iso = new Date(stamp).toISOString();
  // `toISOString` throws on a non-finite date but happily accepts an epoch far
  // outside anything a run can have produced; a date no consumer can parse is
  // the same silent drop as a missing field.
  return Number.isNaN(new Date(iso).getTime()) ? undefined : iso;
}

/**
 * Whether the suppression is in force, and the reason when it is not.
 *
 * Three answers, and the middle one is the point: an acceptance whose expiry
 * has passed does NOT suppress, so a waiver somebody set for two weeks in March
 * stops hiding a finding in April without anybody remembering to revisit it.
 * An expiry that cannot be EVALUATED (no clock) also does not suppress, for the
 * same reason in the other direction — a mechanism for hiding things must fail
 * toward visible.
 */
export function suppressionState(
  suppression: FindingSuppression,
  clock: ReportClock | null,
): { applied: true } | { applied: false; why: 'expired' | 'unevaluable' } {
  const expiry = suppression.expiresAtIso?.trim();
  if (expiry === undefined || expiry.length === 0) return { applied: true };

  const at = Date.parse(expiry);
  // An unparseable expiry is not "no expiry": somebody wrote a date and it did
  // not survive, and treating that as an open-ended acceptance is the generous
  // reading of a typo.
  if (Number.isNaN(at)) return { applied: false, why: 'unevaluable' };
  if (clock === null) return { applied: false, why: 'unevaluable' };
  return at > clock.nowMs() ? { applied: true } : { applied: false, why: 'expired' };
}

/**
 * Whether a consumer may trust the ABSENCE of results.
 *
 * `invocation.executionSuccessful` is read by every SARIF consumer as "the scan
 * completed", and a tool that reports success with zero results is reporting a
 * clean bill of health. So the one case that must report `false` is the one
 * where nobody looked: `findings` ABSENT (not `[]`) means the caller never
 * supplied them, and an empty `results` array under a successful invocation
 * would be a pass that means we did not check.
 *
 * `findings: []` with tests in the run is a genuine clean result and reports
 * `true`. A run with no tests at all also reports `false` — nothing executed.
 */
export function executionSucceeded(report: SarifRunReport): boolean {
  if (report.findings === undefined) return false;
  return report.tests.length > 0;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

// ─── Rules ───────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  CRITICAL: 0,
  SERIOUS: 1,
  MODERATE: 2,
  MINOR: 3,
};

/**
 * One `reportingDescriptor` per `code`, in first-seen order.
 *
 * First-seen rather than sorted so a reader can line the rules up against the
 * results; the order is deterministic either way because the findings are.
 *
 * `defaultConfiguration.level` is the level of the WORST severity seen for that
 * code in this run. It is a property of this run's data and not a policy — a
 * consumer that re-levels results per rule would otherwise quietly downgrade a
 * CRITICAL instance of a rule that is usually MINOR.
 */
export function rulesFor(findings: readonly ReportedFinding[]): SarifReportingDescriptor[] {
  const byCode = new Map<string, SarifReportingDescriptor>();
  const worst = new Map<string, FindingSeverity>();

  for (const finding of findings) {
    const id = finding.code;
    const previous = worst.get(id);
    if (previous === undefined || SEVERITY_RANK[finding.severity] < SEVERITY_RANK[previous]) {
      worst.set(id, finding.severity);
    }

    const existing = byCode.get(id);
    if (existing === undefined) {
      const rule: SarifReportingDescriptor = {
        id,
        // A per-rule description does not exist in the platform: the plugins
        // write a per-FINDING message that interpolates the route. So this
        // names the check and says who reported it, and the count of rules in
        // that state is reported in `warnings` rather than papered over with
        // the first finding's prose.
        shortDescription: { text: `QAAI ${finding.kind} check \`${id}\`` },
        defaultConfiguration: { level: SARIF_LEVEL[finding.severity] },
        properties: { tags: [], qaaiKind: finding.kind },
      };
      const name = finding.ruleName?.trim();
      if (name) rule.name = name;
      const help = finding.helpUrl?.trim();
      if (help) rule.helpUri = help;
      byCode.set(id, rule);
    } else {
      // A later finding may be the one that carries the help URL.
      if (existing.helpUri === undefined) {
        const help = finding.helpUrl?.trim();
        if (help) existing.helpUri = help;
      }
      if (existing.name === undefined) {
        const name = finding.ruleName?.trim();
        if (name) existing.name = name;
      }
    }

    const rule = byCode.get(id)!;
    const tags = new Set(rule.properties.tags);
    tags.add(`qaai:${finding.kind.toLowerCase()}`);
    for (const tag of finding.tags ?? []) {
      const trimmed = tag.trim();
      if (trimmed.length > 0) tags.add(trimmed);
    }
    // `security` is the tag GitHub filters its Security tab on; applying it to
    // anything else would file an a11y violation as a vulnerability.
    if (finding.kind === 'SECURITY') tags.add('security');
    rule.properties.tags = [...tags].sort();
  }

  for (const [id, rule] of byCode) {
    const severity = worst.get(id)!;
    rule.defaultConfiguration.level = SARIF_LEVEL[severity];
    if (rule.properties.qaaiKind === 'SECURITY') {
      rule.properties['security-severity'] = SECURITY_SEVERITY[severity];
    }
  }

  return [...byCode.values()];
}

// ─── The log ─────────────────────────────────────────────────────────────────

interface BuildNotes {
  emptyMessages: number;
  noPhysicalLocation: number;
  droppedRegions: number;
  expiredSuppressions: string[];
  unevaluableSuppressions: string[];
  unjustifiedSuppressions: number;
  unownedSuppressions: number;
  neverExpiringSuppressions: number;
  cappedResults: number;
}

function emptyNotes(): BuildNotes {
  return {
    emptyMessages: 0,
    noPhysicalLocation: 0,
    droppedRegions: 0,
    expiredSuppressions: [],
    unevaluableSuppressions: [],
    unjustifiedSuppressions: 0,
    unownedSuppressions: 0,
    neverExpiringSuppressions: 0,
    cappedResults: 0,
  };
}

function resultFor(
  finding: ReportedFinding,
  ruleIndex: number,
  clock: ReportClock | null,
  notes: BuildNotes,
): SarifResult {
  const text = finding.message.trim();
  if (text.length === 0) notes.emptyMessages += 1;

  const locations = locationsFor(finding);
  const physical = locations[0]?.physicalLocation;
  if (physical === undefined) notes.noPhysicalLocation += 1;
  if (finding.region !== undefined && physical?.region === undefined) notes.droppedRegions += 1;

  const result: SarifResult = {
    ruleId: finding.code,
    ruleIndex,
    level: SARIF_LEVEL[finding.severity],
    // `message.text` is REQUIRED and may not be empty; the code is the only
    // other thing that identifies the finding, so it stands in and the
    // substitution is counted.
    message: { text: text.length > 0 ? text : `${finding.kind} finding \`${finding.code}\`` },
    partialFingerprints: { 'qaaiFinding/v1': fingerprintOf(finding) },
    properties: {
      // The exact severity SARIF's four levels cannot express. See SARIF_LEVEL.
      qaaiSeverity: finding.severity,
      qaaiKind: finding.kind,
      // Always carried, even when it also became an artifact or a logical
      // location, so a consumer that renders neither still has the string the
      // plugin actually produced.
      qaaiLocation: finding.location,
    },
  };
  if (locations.length > 0) result.locations = locations;

  if (finding.testName !== undefined || finding.testId !== undefined) {
    // Which test found it, so a fix has something to re-run. Named here rather
    // than left to the reader because `Finding` has no link back to its test.
    if (finding.testName !== undefined) result.properties.qaaiTest = finding.testName;
    if (finding.testId !== undefined) result.properties.qaaiTestId = finding.testId;
  }

  const suppression = finding.suppression;
  if (suppression !== undefined) {
    const state = suppressionState(suppression, clock);
    if (state.applied) {
      const justification = suppression.justification?.trim();
      if (justification === undefined || justification.length === 0) {
        notes.unjustifiedSuppressions += 1;
      }
      const owner = suppression.owner?.trim();
      if (owner === undefined || owner.length === 0) notes.unownedSuppressions += 1;
      const expiry = suppression.expiresAtIso?.trim();
      if (expiry === undefined || expiry.length === 0) notes.neverExpiringSuppressions += 1;

      const entry: SarifSuppression = {
        // `external`: the acceptance lives in QAAI's own records, not in a
        // comment in the customer's source. `inSource` would send a reader
        // looking for a suppression pragma that is not there.
        kind: 'external',
        status: 'accepted',
      };
      if (justification) entry.justification = justification;
      // Owner and expiry have no home in SARIF's suppression object, and an
      // acceptance nobody owns is the failure mode this records, so they ride
      // in `properties` where they are at least present and auditable.
      const properties: Record<string, unknown> = {};
      if (owner) properties.qaaiOwner = owner;
      if (expiry) properties.qaaiExpiresAt = expiry;
      if (Object.keys(properties).length > 0) entry.properties = properties;
      result.suppressions = [entry];
    } else {
      // NOT suppressed, and the reason is on the result so a reader can see
      // that an acceptance was present and was not honoured.
      result.properties.qaaiSuppressionNotApplied = state.why;
      const label = `${finding.code} @ ${finding.location}`;
      if (state.why === 'expired') notes.expiredSuppressions.push(label);
      else notes.unevaluableSuppressions.push(label);
    }
  }

  return result;
}

/**
 * The log, for a caller that wants the object rather than the document.
 *
 * Drops the `warnings` the reporter produces, which is why `sarifReporter`
 * exists at all — the counts of what could not be represented belong next to
 * the file, not inside it.
 */
export function renderSarifLog(report: SarifRunReport, clock: ReportClock | null): SarifLog {
  return buildSarif(report, clock, emptyNotes());
}

function buildSarif(
  report: SarifRunReport,
  clock: ReportClock | null,
  notes: BuildNotes,
): SarifLog {
  const all = report.findings ?? [];
  const kept = all.slice(0, MAX_SARIF_RESULTS);
  notes.cappedResults = all.length - kept.length;

  // Rules are built from the KEPT findings only: a rule with no result is a
  // rule a consumer shows as "0 alerts", which reads as a check that passed.
  const rules = rulesFor(kept);
  const indexOf = new Map(rules.map((rule, index) => [rule.id, index]));
  const results = kept.map((finding) => resultFor(finding, indexOf.get(finding.code)!, clock, notes));

  const notifications: SarifNotification[] = [];
  if (report.findings === undefined) {
    notifications.push({
      level: 'error',
      message: {
        text:
          'No findings were supplied to the SARIF reporter, so this run reports zero results ' +
          'because nothing was looked at — not because nothing was found. executionSuccessful ' +
          'is false for exactly this reason: do not read an empty result set as a clean scan.',
      },
    });
  } else if (report.tests.length === 0) {
    notifications.push({
      level: 'error',
      message: {
        text:
          'The run executed zero tests, so an empty result set is evidence of nothing. ' +
          'executionSuccessful is false.',
      },
    });
  }
  if (notes.cappedResults > 0) {
    // In the FILE, not only in our warnings: the consumer never sees warnings,
    // and a truncation it cannot see is a finding count it believes.
    notifications.push({
      level: 'warning',
      message: {
        text:
          `${notes.cappedResults} of ${all.length} finding(s) were omitted: this file is capped at ` +
          `${MAX_SARIF_RESULTS} results because GitHub code scanning rejects an upload above that ` +
          'and a rejected upload reports nothing at all.',
      },
    });
  }

  const invocation: SarifInvocation = { executionSuccessful: executionSucceeded(report) };
  const start = utc(report.startedAt);
  const end = utc(report.finishedAt);
  // Absent, never zero: `1970-01-01` on every scan is a date a dashboard sorts by.
  if (start !== undefined) invocation.startTimeUtc = start;
  if (end !== undefined) invocation.endTimeUtc = end;
  if (notifications.length > 0) invocation.toolExecutionNotifications = notifications;

  const driver: SarifRun['tool']['driver'] = { name: 'QAAI', rules };
  const version = report.toolVersion?.trim();
  if (version) driver.version = version;
  const informationUri = report.informationUri?.trim();
  if (informationUri) driver.informationUri = informationUri;

  const properties: Record<string, unknown> = {};
  // The commit and branch live here whenever there is no repositoryUri to hang
  // a conformant provenance block on. See the header.
  if (report.commitSha?.trim()) properties.qaaiCommitSha = report.commitSha.trim();
  if (report.branch?.trim()) properties.qaaiBranch = report.branch.trim();
  if (report.environment?.trim()) properties.qaaiEnvironment = report.environment.trim();
  if (report.id?.trim()) properties.qaaiRunId = report.id.trim();
  if (report.url?.trim()) properties.qaaiRunUrl = report.url.trim();
  properties.qaaiFindingsSupplied = report.findings !== undefined;

  const run: SarifRun = { tool: { driver }, invocations: [invocation], results, properties };

  const runId = report.id?.trim();
  // `automationDetails.id` is how GitHub groups runs of the same analysis so a
  // fixed alert closes instead of accumulating. Omitted without a run id
  // rather than defaulted to a constant, which would merge every project.
  if (runId) run.automationDetails = { id: `qaai/${runId}` };

  const repositoryUri = report.repositoryUri?.trim();
  if (repositoryUri) {
    const provenance: { repositoryUri: string; revisionId?: string; branch?: string } = {
      repositoryUri,
    };
    if (report.commitSha?.trim()) provenance.revisionId = report.commitSha.trim();
    if (report.branch?.trim()) provenance.branch = report.branch.trim();
    run.versionControlProvenance = [provenance];
  }

  return { $schema: SARIF_SCHEMA, version: SARIF_VERSION, runs: [run] };
}

export const sarifReporter: Reporter = {
  name: 'sarif',
  description: 'SARIF 2.1.0 — findings for GitHub code scanning, Defect Dojo and SonarQube',
  defaultOut: 'qaai.sarif',
  directory: false,

  render(report: RunReport): ReporterDocument {
    /*
     * No cast: every field `SarifRunReport` adds is optional, so a plain
     * `RunReport` is assignable to it. That matters — a cast here would
     * silently accept a shape change on `RunReport` that this reporter then
     * read as findings.
     */
    const input: SarifRunReport = report;
    const clock = clockOf(report);
    const notes = emptyNotes();
    const log = buildSarif(input, clock, notes);
    const warnings: string[] = [];

    if (input.findings === undefined) {
      warnings.push(
        'No findings were supplied, so this SARIF file reports zero results — which is not the same as a clean scan. ' +
          'invocations[0].executionSuccessful is false and a toolExecutionNotification says so, so a consumer cannot read it as a pass.',
      );
    } else if (input.findings.length === 0) {
      warnings.push(
        'Zero findings in this run. The file is written anyway so the consumer sees an empty scan rather than a missing one.',
      );
    }
    if (notes.cappedResults > 0) {
      warnings.push(
        `${notes.cappedResults} finding(s) were omitted by the ${MAX_SARIF_RESULTS}-result cap ` +
          '(GitHub code scanning rejects an upload above it, and a rejected upload reports nothing). ' +
          'The omission is also recorded in the file itself.',
      );
    }
    if (notes.noPhysicalLocation > 0) {
      warnings.push(
        `${notes.noPhysicalLocation} finding(s) carry no file or URL, only a selector or a route, so they have a logical location and no physical one. ` +
          'GitHub code scanning does not display a result without a physical location, so its alert count will be lower than QAAI’s. ' +
          'Set `uri` on the finding to fix that; no file was invented for them.',
      );
    }
    if (notes.droppedRegions > 0) {
      warnings.push(
        `${notes.droppedRegions} finding(s) supplied a region SARIF cannot represent (a non-positive or inverted line/column) and it was dropped rather than clamped — a finding pinned to line 1 is worse than one with no line.`,
      );
    }
    if (notes.emptyMessages > 0) {
      warnings.push(
        `${notes.emptyMessages} finding(s) had an empty message; SARIF requires message.text, so the finding code was used instead.`,
      );
    }
    if (notes.expiredSuppressions.length > 0) {
      warnings.push(
        `${notes.expiredSuppressions.length} accepted finding(s) have a LAPSED acceptance and are reported live: ` +
          `${truncate(notes.expiredSuppressions.slice(0, 5).join(', '), 300)}${notes.expiredSuppressions.length > 5 ? `, and ${notes.expiredSuppressions.length - 5} more` : ''}.`,
      );
    }
    if (notes.unevaluableSuppressions.length > 0) {
      warnings.push(
        `${notes.unevaluableSuppressions.length} accepted finding(s) could not have their expiry evaluated (unparseable date, or the run carries no timestamp to evaluate it against) and are reported live rather than hidden: ` +
          `${truncate(notes.unevaluableSuppressions.slice(0, 5).join(', '), 300)}${notes.unevaluableSuppressions.length > 5 ? `, and ${notes.unevaluableSuppressions.length - 5} more` : ''}.`,
      );
    }
    if (notes.unjustifiedSuppressions > 0) {
      warnings.push(
        `${notes.unjustifiedSuppressions} suppressed finding(s) carry no justification — a hidden finding with no stated reason cannot be reviewed.`,
      );
    }
    if (notes.unownedSuppressions > 0) {
      warnings.push(
        `${notes.unownedSuppressions} suppressed finding(s) carry no owner, so there is nobody to ask about them.`,
      );
    }
    if (notes.neverExpiringSuppressions > 0) {
      warnings.push(
        `${notes.neverExpiringSuppressions} suppressed finding(s) have no expiry and will stay hidden forever unless somebody remembers them.`,
      );
    }

    const describedRules = log.runs[0]?.tool.driver.rules.length ?? 0;
    if (describedRules > 0) {
      warnings.push(
        `${describedRules} rule(s) carry only a generated shortDescription naming the check: QAAI’s plugins record a per-finding message and no per-rule description, and copying one finding’s prose onto the rule would document one route as if it were the rule.`,
      );
    }
    if (!input.repositoryUri?.trim()) {
      warnings.push(
        'No versionControlProvenance: SARIF requires repositoryUri on it and the run does not carry one. ' +
          'The commit and branch are in run.properties instead, because a provenance block missing a required field fails validation and the whole upload is dropped silently.',
      );
    }

    const file: ReporterFile = {
      path: 'qaai.sarif',
      contents: JSON.stringify(log, null, 2) + '\n',
      contentType: 'application/sarif+json',
    };
    return { files: [file], warnings };
  },
};
