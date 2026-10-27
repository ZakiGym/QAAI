/**
 * Compliance evidence packs — the bundle an auditor will actually accept.
 *
 * ── Why an enterprise buys a QA product at all ───────────────────────────────
 *
 * Not for the test runner. For the moment somebody asks "show me that you test
 * your accessibility" and there is a dated, scoped, verifiable answer. Before
 * this file QAAI could produce a screenshot of a dashboard, which is not
 * evidence: it has no date that cannot be changed, no statement of what was
 * out of scope, and no way to recompute the number it shows.
 *
 * ── The one thing that makes this document DANGEROUS ─────────────────────────
 *
 * An evidence pack is read as a claim of completeness whether or not it makes
 * one. Hand an auditor a WCAG pack listing 400 passing accessibility checks and
 * they will conclude the product conforms — even though automated scanning
 * cannot establish conformance for most of WCAG, even though eight of QAAI's
 * twelve surface axes have no extractor, and even though the crawl that found
 * those 400 checks may have stopped at a page cap.
 *
 * So the SCOPE STATEMENT is mandatory content and not an appendix. It is its
 * own file, it is listed first in the manifest, and {@link buildEvidencePack}
 * cannot produce a pack without one: there is no code path here that omits it,
 * and `evidence-pack.test.ts` asserts that for every framework and for an empty
 * input. The three things it must always say are
 *
 *   1. what was NOT tested, by name and with the reason;
 *   2. which axes of the denominator QAAI has no extractor for at all, so an
 *      absence of findings on them is an absence of LOOKING;
 *   3. what this method structurally cannot establish, per framework.
 *
 * ── No single headline percentage ────────────────────────────────────────────
 *
 * The pack reports a percentage PER AXIS and refuses to print one combined
 * figure. Routes, endpoints, forms and auth surfaces are different units, and a
 * ratio whose denominator is their sum is not a measurement of anything — it
 * moves when a code comment adds four labels. An auditor's document is the last
 * place that figure belongs, so `perAxis` is the only coverage arithmetic here
 * and {@link AGGREGATE_WITHHELD} says why in the pack itself. The per-axis
 * counts are all present, so nothing is hidden from a reader who wants to sum
 * them knowing what they are summing.
 *
 * ── Recomputability ──────────────────────────────────────────────────────────
 *
 * `recompute` carries the denominator definition, the crawl fingerprint, the
 * snapshot id, the commit and the environment. A number in an audit document
 * that cannot be recomputed is a number that gets argued about once and then
 * ignored.
 *
 * ── Injected surfaces, and why every one of them can be UNAVAILABLE ──────────
 *
 * The clock, the digester, the signer and the artifact store are all injected
 * narrow interfaces. A reporter that called `Date.now()` would produce a
 * different pack every render and could not be tested at all; one that opened
 * the artifact store would need a filesystem to be tested. Each of the four may
 * be absent, and absence is reported as a named status — `UNSIGNED`, `UNDATED`,
 * `ARTIFACT_DIGESTS_UNAVAILABLE` — never as a zero, an empty list or a pass.
 * A pack that implies it was signed when no key was present is the single worst
 * artifact this product could emit.
 */

import { createHash } from 'node:crypto';
import type { SurfaceKind, SurfaceKindTotals, SurfaceSnapshot } from '@qaai/shared';
import type { ReportedFinding, ReportClock } from './sarif.js';
import { clockOf, fingerprintOf, suppressionState } from './sarif.js';
import type {
  ReportedTest,
  Reporter,
  ReporterDocument,
  ReporterFile,
  ReporterStatus,
  RunReport,
} from './types.js';
import { durationOf, fullNameOf, totalsOf } from './types.js';

// ─── Frameworks ──────────────────────────────────────────────────────────────

/**
 * The three shapes a buyer asks for by name.
 *
 * An `as const` tuple with the union derived from it, which is this repo's
 * idiom, and the `Record` below is the compiler-enforced presence half of the
 * pattern this codebase uses for every vocabulary with a write path. The
 * run-time parity half — that every member here has a profile and the profile
 * record has no key this array does not — is in `evidence-pack.test.ts`,
 * because the compiler cannot see a `Record` that drifted from the array it was
 * keyed on and eight unsaveable gate kinds shipped for two slices behind
 * exactly that gap.
 */
export const EVIDENCE_FRAMEWORKS = ['WCAG_2_1_AA', 'SOC2', 'VPAT'] as const;
export type EvidenceFramework = (typeof EVIDENCE_FRAMEWORKS)[number];

export interface EvidenceFrameworkProfile {
  /** What the pack is called, in the words the requester used. */
  label: string;
  /**
   * The `FindingKind`s this framework draws on. EMPTY means every kind.
   *
   * Read by the scope statement, which says how many of the pack's findings
   * are of those kinds. Without that line a WCAG pack containing 40 findings
   * reads as 40 accessibility findings even when 38 of them are performance
   * budget breaches, and the reader has no way to tell.
   */
  relevantKinds: readonly string[];
  /**
   * What this METHOD cannot establish, whatever the results say.
   *
   * Not a disclaimer and not legal cover: each line is a true statement about
   * what an automated run can and cannot determine, and leaving them out is
   * what turns a test report into an implied conformance claim.
   */
  cannotEstablish: readonly string[];
}

export const EVIDENCE_FRAMEWORK_PROFILES: Record<EvidenceFramework, EvidenceFrameworkProfile> = {
  WCAG_2_1_AA: {
    label: 'WCAG 2.1 Level AA',
    relevantKinds: ['ACCESSIBILITY'],
    cannotEstablish: [
      'Conformance. Automated checks can detect a subset of WCAG 2.1 failures; many success ' +
        'criteria (meaningful alternative text, logical focus order, understandable instructions, ' +
        'captions, sensible headings) require human evaluation and are NOT evaluated here.',
      'That a page with zero findings conforms. Zero automated findings means zero findings of the ' +
        'kinds these checks look for, on the pages that were reached, in the states they were ' +
        'reached in.',
      'Which success criteria were tested. QAAI records the axe rule tags it requested ' +
        '(wcag2a, wcag2aa, wcag21a, wcag21aa); it does not maintain a rule-to-success-criterion ' +
        'map, so no per-criterion claim is made here rather than a guessed one.',
    ],
  },
  SOC2: {
    label: 'SOC 2',
    relevantKinds: [],
    cannotEstablish: [
      'An audit opinion. This pack is evidence that testing activity occurred, produced by the ' +
        'system under test’s own tooling. It is not an independent assessment and no part of it ' +
        'is attested by a third party.',
      'That the controls in scope for your report are the ones exercised here. The mapping from a ' +
        'QAAI test to a trust services criterion is the customer’s to make; QAAI does not record ' +
        'one and does not infer one.',
      'Operating effectiveness over a period. Each run is one point in time; the dates in this ' +
        'pack are the dates of the runs it contains and nothing more.',
    ],
  },
  VPAT: {
    label: 'VPAT / Accessibility Conformance Report',
    relevantKinds: ['ACCESSIBILITY'],
    cannotEstablish: [
      'A conformance level for any criterion. A VPAT requires a Supports / Partially Supports / ' +
        'Does Not Support judgement per criterion, which is a human determination. This pack ' +
        'supplies the automated evidence that judgement can be made FROM; it does not make it.',
      'That the product was evaluated with assistive technology. No screen reader, magnifier or ' +
        'switch device was used in producing this pack.',
      'Coverage of criteria no automated rule exists for. Those criteria are untested here and ' +
        'their absence from the findings list is not a pass.',
    ],
  },
};

export const AGGREGATE_WITHHELD =
  'No single coverage percentage is reported. The axes below (routes, API endpoints, forms, auth ' +
  'surfaces) are counted in different units, and a ratio taken over their combined total is not a ' +
  'measurement of anything — it moves when one axis gains items for reasons unrelated to ' +
  'testing. Per-axis figures and the raw counts behind them are given instead, so any aggregate a ' +
  'reader chooses to compute is one they have chosen the denominator for.';

// ─── Injected surfaces ───────────────────────────────────────────────────────

/** Content addressing for the pack. Injected so a test can assert exact bytes. */
export interface EvidenceDigester {
  readonly algorithm: string;
  hex(input: string): string;
}

/**
 * Whatever actually holds the key. Deliberately NOT a key, a path or a secret.
 *
 * The same reasoning as `ReporterUpload` carrying no credential: a signer
 * interface keeps a private key out of every fixture in this directory, and the
 * caller attaches it at the point it already has one.
 */
export interface EvidenceSigner {
  readonly algorithm: string;
  /** Which key, so a verifier can find it. Never the key itself. */
  readonly keyId: string;
  sign(payload: string): string;
}

/**
 * The artifact store, as one synchronous question.
 *
 * `null` for an artifact it cannot describe. That is a different fact from
 * `{ bytes: 0 }` — the first means the store did not answer, the second means
 * an empty file — and the pack reports them differently because an auditor
 * asking "was the screenshot kept" needs the difference.
 */
export interface EvidenceArtifactSource {
  describe(key: string): { bytes: number; digestHex: string } | null;
}

export interface EvidenceDeps {
  clock?: ReportClock | null;
  digester?: EvidenceDigester | null;
  signer?: EvidenceSigner | null;
  artifacts?: EvidenceArtifactSource | null;
}

/** sha256 over UTF-8. The default digester; pure, so it stays testable. */
export function sha256Digester(): EvidenceDigester {
  return {
    algorithm: 'sha256',
    hex: (input: string) => createHash('sha256').update(input, 'utf8').digest('hex'),
  };
}

// ─── Input ───────────────────────────────────────────────────────────────────

/**
 * A limit that was in force, and how much of the answer it removed.
 *
 * `applied: 0` is a cap that was declared and did not bite, which is worth
 * saying — and a cap that DID bite is reported with both its count and its
 * reason, because a page cap nobody mentioned is the difference between "we
 * found nothing on those 40 pages" and "we never opened them".
 */
export interface EvidenceCap {
  name: string;
  limit: number;
  /** How many items this cap removed from the answer. */
  applied: number;
  reason: string;
}

export interface EvidencePackInput extends RunReport {
  /** Which packs to shape. Defaults to every framework. */
  frameworks?: readonly EvidenceFramework[];
  /**
   * ABSENT means the caller supplied none, which is not the same as none
   * existing. An empty array is a genuine clean result. The two produce
   * different scope statements.
   */
  findings?: readonly ReportedFinding[];
  /** The coverage measurement this pack is evidence about. */
  snapshot?: SurfaceSnapshot | null;
  /** Axes with no extractor, named. Falls back to the snapshot's own flags. */
  unmeasuredKinds?: readonly SurfaceKind[];
  /** Artifact keys this run produced. Digested through `deps.artifacts`. */
  artifactKeys?: readonly string[];
  caps?: readonly EvidenceCap[];
  /** The organisation the pack is for, as it should read on the document. */
  subject?: string;
  repositoryUri?: string;
  /** Who assembled it. A pack with no author is a pack nobody stands behind. */
  preparedBy?: string;
}

// ─── Pack shapes ─────────────────────────────────────────────────────────────

export type SignatureStatus = 'SIGNED' | 'UNSIGNED';
export type DateStatus = 'DATED' | 'UNDATED';
export type ArtifactStatus = 'DESCRIBED' | 'ARTIFACT_DIGESTS_UNAVAILABLE' | 'NONE_PRODUCED';

export interface EvidenceAxis {
  kind: SurfaceKind;
  measured: boolean;
  denominator: number;
  covered: number;
  assertedNotRun: number;
  uncovered: number;
  unknown: number;
  waived: number;
  /** Null when the denominator is zero. Never 0 and never 100. */
  percent: number | null;
}

export interface EvidenceScopeStatement {
  /** Mandatory. Every list below may be empty; none may be absent. */
  tested: {
    environment: string | null;
    commitSha: string | null;
    runId: string | null;
    windowStartIso: string | null;
    windowEndIso: string | null;
    testCount: number;
    findingCount: number | null;
    perAxis: EvidenceAxis[];
  };
  notTested: {
    /**
     * Axes QAAI has NO extractor for. An absence of findings here is an absence
     * of looking.
     *
     * NULL means the question could not be answered — no snapshot and no
     * explicit list — and it is null rather than `[]` because `[]` is the
     * answer "every axis is measured". A gate or a diff asking "did the
     * out-of-scope list grow" reads this field, and an empty array handed to it
     * for an unknown is a null that became a clean bill of health.
     */
    unmeasuredAxes: SurfaceKind[] | null;
    uncovered: number | null;
    /** Items static extraction could not resolve. Not gaps, not covered. */
    cannotTell: number | null;
    waived: number | null;
    unexercisable: number | null;
    refused: number | null;
    caps: EvidenceCap[];
    /** Suppressed findings, each with the owner and expiry that must exist. */
    acceptedFindings: Array<{
      code: string;
      location: string;
      owner: string | null;
      expiresAtIso: string | null;
      justification: string | null;
    }>;
  };
  /** Per framework, what it draws on and what it structurally cannot establish. */
  cannotEstablish: Array<{
    framework: EvidenceFramework;
    label: string;
    /** The finding kinds it draws on. Empty means every kind. */
    relevantKinds: string[];
    /**
     * How many of this pack's findings are of those kinds.
     *
     * Null when no findings were supplied — which is not zero, and is the one
     * number in this document that must not be allowed to become zero.
     */
    relevantFindingCount: number | null;
    limits: string[];
  }>;
  /** The snapshot's own caveats, carried verbatim. */
  measurementCaveats: string[];
  aggregateWithheld: string;
}

export interface EvidenceManifest {
  packVersion: 1;
  frameworks: Array<{ framework: EvidenceFramework; label: string }>;
  subject: string | null;
  preparedBy: string | null;
  generatedAtIso: string | null;
  dateStatus: DateStatus;
  signatureStatus: SignatureStatus;
  artifactStatus: ArtifactStatus;
  recompute: {
    denominatorDefinition: string;
    crawlFingerprint: string | null;
    snapshotId: string | null;
    snapshotCreatedAtIso: string | null;
    commitSha: string | null;
    repositoryUri: string | null;
    environment: string | null;
    runId: string | null;
    analysisId: string | null;
    flowMapVersion: number | null;
  };
  /** Digest of every other file in the pack, so tampering with one shows. */
  files: Array<{ path: string; bytes: number; digest: string | null }>;
  digestAlgorithm: string | null;
}

export interface EvidenceSignatureFile {
  status: SignatureStatus;
  /** Which bytes were signed. Always `manifest.json`. */
  over: string;
  algorithm: string | null;
  keyId: string | null;
  manifestDigest: string | null;
  signature: string | null;
  /** Present and explicit when unsigned, so a missing file cannot be assumed. */
  note: string;
}

// ─── Denominator definition ──────────────────────────────────────────────────

/**
 * What the numbers in this pack are a ratio OF, in one paragraph.
 *
 * A constant and not prose generated per pack, because two packs of the same
 * product that define their denominator differently are two packs that cannot
 * be compared, and because the definition is the part an auditor quotes.
 */
export const DENOMINATOR_DEFINITION =
  'Each per-axis denominator is the number of items QAAI enumerated on that axis, minus items the ' +
  'team formally waived. Items static analysis could not resolve are COUNTED IN the denominator ' +
  'and never as covered, so the figure cannot rise by QAAI’s own extraction getting worse. ' +
  '"Covered" means at least one test is matched to the item AND that test has been observed to ' +
  'run; a test that exists and has never run is reported separately as asserted-not-run and does ' +
  'NOT count as covered. Whether a covering test passed is a separate fact reported in the run ' +
  'results: a failing test still covers the item it exercises. Axes QAAI has no extractor for are ' +
  'named as unmeasured and are not reported as 0%.';

// ─── Building ────────────────────────────────────────────────────────────────

function iso(stamp: number | undefined | null): string | null {
  if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return null;
  return new Date(stamp).toISOString();
}

function trimmed(value: string | undefined | null): string | null {
  const out = value?.trim();
  return out !== undefined && out.length > 0 ? out : null;
}

function axisFrom(totals: SurfaceKindTotals): EvidenceAxis {
  return {
    kind: totals.kind,
    measured: totals.measured,
    denominator: totals.denominator,
    covered: totals.covered,
    assertedNotRun: totals.assertedNotRun,
    uncovered: totals.uncovered,
    unknown: totals.unknown,
    waived: totals.waived,
    // Carried, not recomputed: the one rounding rule lives in
    // @qaai/shared's `coveragePercent` and a second one here would be a second
    // coverage number. Null stays null.
    percent: totals.percent,
  };
}

/**
 * Axes with no extractor.
 *
 * Prefers what the caller passed, falls back to the snapshot's own `measured`
 * flags, and returns an EMPTY list only when there is a snapshot to read them
 * from. With no snapshot and no explicit list the answer is unknown, and the
 * scope statement says so rather than printing an empty list that reads as
 * "every axis is measured".
 */
export function unmeasuredAxesOf(input: EvidencePackInput): SurfaceKind[] | null {
  if (input.unmeasuredKinds !== undefined) return [...input.unmeasuredKinds];
  const byKind = input.snapshot?.totals.byKind;
  if (byKind === undefined) return null;
  return byKind.filter((totals) => !totals.measured).map((totals) => totals.kind);
}

const QUARANTINE_STATUSES: readonly ReporterStatus[] = ['quarantined'];

function testRow(test: ReportedTest): Record<string, unknown> {
  const row: Record<string, unknown> = { name: fullNameOf(test), status: test.status };
  if (test.id !== undefined) row.id = test.id;
  const ms = durationOf(test);
  // Absent, never zero. A column of 0 ms in an audit document is a column of
  // measurements that were never taken.
  if (ms !== undefined) row.durationMs = ms;
  const started = iso(test.startedAt);
  if (started !== null) row.startedAtIso = started;
  const finished = iso(test.finishedAt);
  if (finished !== null) row.finishedAtIso = finished;
  if (test.message !== undefined) row.message = test.message;
  if (QUARANTINE_STATUSES.includes(test.status)) {
    row.note =
      'QUARANTINED FAILURE — this test failed and its failure is suppressed. It is not a pass ' +
      'and it is not a skip. Any coverage it provides is coverage by a FAILING test.';
  }
  return row;
}

export interface EvidencePack {
  manifest: EvidenceManifest;
  scope: EvidenceScopeStatement;
  files: ReporterFile[];
  warnings: string[];
}

export function buildEvidencePack(input: EvidencePackInput, deps: EvidenceDeps): EvidencePack {
  const warnings: string[] = [];
  const frameworks = input.frameworks ?? EVIDENCE_FRAMEWORKS;
  const digester = deps.digester ?? null;
  const signer = deps.signer ?? null;
  const clock = deps.clock ?? null;
  const artifacts = deps.artifacts ?? null;

  const snapshot = input.snapshot ?? null;
  const snapshotTotals = snapshot?.totals ?? null;
  const perAxis = (snapshotTotals?.byKind ?? []).map(axisFrom);
  const unmeasuredAxes = unmeasuredAxesOf(input);

  const findings = input.findings;
  const accepted: EvidenceScopeStatement['notTested']['acceptedFindings'] = [];
  for (const finding of findings ?? []) {
    const suppression = finding.suppression;
    if (suppression === undefined) continue;
    // Only an acceptance that is actually IN FORCE belongs on the not-tested
    // list. A lapsed or unevaluable one is reported live by the SARIF reporter
    // and is not an exclusion, so listing it here would exclude it twice.
    if (!suppressionState(suppression, clock).applied) continue;
    accepted.push({
      code: finding.code,
      location: finding.location,
      owner: trimmed(suppression.owner),
      expiresAtIso: trimmed(suppression.expiresAtIso),
      justification: trimmed(suppression.justification),
    });
  }

  const scope: EvidenceScopeStatement = {
    tested: {
      environment: trimmed(input.environment),
      commitSha: trimmed(input.commitSha),
      runId: trimmed(input.id),
      windowStartIso: iso(input.startedAt),
      windowEndIso: iso(input.finishedAt),
      testCount: input.tests.length,
      // Null, not 0: "the caller supplied no findings" and "there were no
      // findings" are the difference between a clean scan and no scan.
      findingCount: findings === undefined ? null : findings.length,
      perAxis,
    },
    notTested: {
      // Carried as null when unknown. See the field's own note.
      unmeasuredAxes,
      uncovered: snapshotTotals?.uncovered ?? null,
      cannotTell: snapshotTotals?.unknown ?? null,
      waived: snapshotTotals?.waived ?? null,
      unexercisable: snapshotTotals?.unexercisable ?? null,
      refused: snapshotTotals?.refused ?? null,
      caps: [...(input.caps ?? [])],
      acceptedFindings: accepted,
    },
    cannotEstablish: frameworks.map((framework) => {
      const profile = EVIDENCE_FRAMEWORK_PROFILES[framework];
      return {
        framework,
        label: profile.label,
        relevantKinds: [...profile.relevantKinds],
        relevantFindingCount:
          findings === undefined
            ? null
            : profile.relevantKinds.length === 0
              ? findings.length
              : findings.filter((f) => profile.relevantKinds.includes(f.kind)).length,
        limits: [...profile.cannotEstablish],
      };
    }),
    measurementCaveats: [...(snapshot?.caveats ?? [])],
    aggregateWithheld: AGGREGATE_WITHHELD,
  };

  // ─ Content files, before the manifest that digests them ─
  const contentFiles: ReporterFile[] = [
    /*
     * The scope statement goes out TWICE, as prose and as data, and both are
     * digested. The prose is what an auditor reads and what makes the pack
     * acceptable at all; the JSON is what a gate or a diff reads, because a
     * reviewer asking "did the out-of-scope list grow" cannot ask that of
     * Markdown. They are generated from the one `scope` object, so they cannot
     * disagree.
     */
    {
      path: 'scope-statement.md',
      contents: renderScopeStatement(input, scope, frameworks),
      contentType: 'text/markdown',
    },
    {
      path: 'scope-statement.json',
      contents: json(scope),
      contentType: 'application/json',
    },
    {
      path: 'findings.json',
      contents: json(
        findings === undefined
          ? {
              status: 'NOT_SUPPLIED',
              note:
                'No findings were supplied to this pack. That is not an empty findings list: ' +
                'nothing was looked at, so the absence of findings here is evidence of nothing.',
              findings: [],
            }
          : {
              status: 'SUPPLIED',
              count: findings.length,
              findings: findings.map((finding) => ({
                fingerprint: fingerprintOf(finding),
                kind: finding.kind,
                severity: finding.severity,
                code: finding.code,
                message: finding.message,
                location: finding.location,
                ...(finding.uri === undefined ? {} : { uri: finding.uri }),
                ...(finding.testName === undefined ? {} : { test: finding.testName }),
                helpUrl: finding.helpUrl,
                accepted: finding.suppression !== undefined
                  ? suppressionState(finding.suppression, clock).applied
                  : false,
              })),
            },
      ),
      contentType: 'application/json',
    },
    {
      path: 'tests.json',
      contents: json({
        totals: totalsOf(input),
        tests: input.tests.map(testRow),
      }),
      contentType: 'application/json',
    },
    {
      path: 'artifacts.json',
      contents: json(describeArtifacts(input.artifactKeys ?? [], artifacts)),
      contentType: 'application/json',
    },
  ];

  const generatedAtIso = clock === null ? null : iso(clock.nowMs());
  const dateStatus: DateStatus = generatedAtIso === null ? 'UNDATED' : 'DATED';

  const manifest: EvidenceManifest = {
    packVersion: 1,
    frameworks: frameworks.map((framework) => ({
      framework,
      label: EVIDENCE_FRAMEWORK_PROFILES[framework].label,
    })),
    subject: trimmed(input.subject),
    preparedBy: trimmed(input.preparedBy),
    generatedAtIso,
    dateStatus,
    signatureStatus: signer === null ? 'UNSIGNED' : 'SIGNED',
    artifactStatus: artifactStatus(input.artifactKeys ?? [], artifacts),
    recompute: {
      denominatorDefinition: DENOMINATOR_DEFINITION,
      crawlFingerprint: trimmed(snapshot?.fingerprint),
      snapshotId: trimmed(snapshot?.id),
      snapshotCreatedAtIso: trimmed(snapshot?.createdAtIso),
      commitSha: trimmed(input.commitSha),
      repositoryUri: trimmed(input.repositoryUri),
      environment: trimmed(input.environment),
      runId: trimmed(input.id),
      analysisId: trimmed(snapshot?.inputs.analysisId),
      flowMapVersion: snapshot?.inputs.flowMapVersion ?? null,
    },
    files: contentFiles.map((file) => ({
      path: file.path,
      bytes: Buffer.byteLength(file.contents, 'utf8'),
      // Null, never a placeholder: a digest field holding a made-up string is
      // a tamper check that always passes.
      digest: digester === null ? null : `${digester.algorithm}:${digester.hex(file.contents)}`,
    })),
    digestAlgorithm: digester?.algorithm ?? null,
  };

  const manifestContents = json(manifest);
  const manifestDigest =
    digester === null ? null : `${digester.algorithm}:${digester.hex(manifestContents)}`;

  const signature: EvidenceSignatureFile =
    signer === null
      ? {
          status: 'UNSIGNED',
          over: 'manifest.json',
          algorithm: null,
          keyId: null,
          manifestDigest,
          signature: null,
          note:
            'THIS PACK IS NOT SIGNED. No signing key was supplied, so nothing here is attested and ' +
            'the contents could have been edited after assembly. Treat it as a working document, ' +
            'not as evidence.',
        }
      : {
          status: 'SIGNED',
          over: 'manifest.json',
          algorithm: signer.algorithm,
          keyId: signer.keyId,
          manifestDigest,
          signature: signer.sign(manifestContents),
          note:
            'The signature covers the exact bytes of manifest.json, which carries a digest of every ' +
            'other file in this pack. Verify the manifest first, then each file against its digest.',
        };

  const files: ReporterFile[] = [
    ...contentFiles,
    { path: 'manifest.json', contents: manifestContents, contentType: 'application/json' },
    { path: 'signature.json', contents: json(signature), contentType: 'application/json' },
  ];

  // ─ Warnings: every absence this pack is carrying, named ─
  if (signer === null) {
    warnings.push(
      'The pack is UNSIGNED: no signing key was supplied. signature.json says so explicitly rather than being omitted, because a missing signature file reads as an oversight and an explicit UNSIGNED does not.',
    );
  }
  if (digester === null) {
    warnings.push(
      'No digester was supplied, so no file in the pack carries a content digest and nothing in it can be checked for tampering. The digest fields are null rather than placeholder strings.',
    );
  }
  if (dateStatus === 'UNDATED') {
    warnings.push(
      'The pack is UNDATED: no clock was supplied and the run carries no timestamp, so it cannot evidence WHEN anything was tested — which is most of what an auditor is asking. generatedAtIso is null.',
    );
  }
  if (unmeasuredAxes === null) {
    warnings.push(
      'Which surface axes QAAI has no extractor for is UNKNOWN for this pack: no coverage snapshot and no explicit list were supplied. The scope statement says the list is unavailable rather than printing an empty one, which would read as "every axis is measured".',
    );
  } else if (unmeasuredAxes.length > 0) {
    warnings.push(
      `${unmeasuredAxes.length} surface axis/axes have no extractor (${unmeasuredAxes.join(', ')}) and are named as unmeasured in the scope statement. They are NOT reported as 0% — an absence of findings on them is an absence of looking.`,
    );
  }
  if (snapshot === null) {
    warnings.push(
      'No coverage snapshot was supplied, so the pack carries no denominator, no per-axis figures and no crawl fingerprint — it evidences that tests ran, not what proportion of the product they reach. The scope statement says so.',
    );
  }
  if (findings === undefined) {
    warnings.push(
      'No findings were supplied. findings.json records status NOT_SUPPLIED rather than an empty list, so the pack cannot be read as a clean scan.',
    );
  }
  const bitingCaps = (input.caps ?? []).filter((cap) => cap.applied > 0);
  if (bitingCaps.length > 0) {
    warnings.push(
      `${bitingCaps.length} cap(s) BIT and removed items from this pack’s answer: ` +
        `${bitingCaps.map((cap) => `${cap.name} (limit ${cap.limit}, removed ${cap.applied}: ${cap.reason})`).join('; ')}.`,
    );
  }
  const unowned = accepted.filter((entry) => entry.owner === null).length;
  if (unowned > 0) {
    warnings.push(
      `${unowned} accepted finding(s) in this pack carry no owner. An exclusion nobody owns cannot be reviewed, and it is listed in the scope statement with a null owner rather than quietly dropped.`,
    );
  }
  const unexpiring = accepted.filter((entry) => entry.expiresAtIso === null).length;
  if (unexpiring > 0) {
    warnings.push(
      `${unexpiring} accepted finding(s) in this pack have no expiry, so the exclusion is open-ended.`,
    );
  }
  const quarantined = input.tests.filter((t) => t.status === 'quarantined').length;
  if (quarantined > 0) {
    warnings.push(
      `${quarantined} test(s) in this pack FAILED and had their failure suppressed by quarantine. tests.json says so per test; they are not pass evidence.`,
    );
  }
  if (trimmed(input.preparedBy) === null) {
    warnings.push(
      'The pack names nobody as its preparer. An evidence document with no author is one no reviewer can question.',
    );
  }

  return { manifest, scope, files, warnings };
}

function artifactStatus(
  keys: readonly string[],
  source: EvidenceArtifactSource | null,
): ArtifactStatus {
  if (keys.length === 0) return 'NONE_PRODUCED';
  return source === null ? 'ARTIFACT_DIGESTS_UNAVAILABLE' : 'DESCRIBED';
}

function describeArtifacts(
  keys: readonly string[],
  source: EvidenceArtifactSource | null,
): Record<string, unknown> {
  const status = artifactStatus(keys, source);
  if (status === 'NONE_PRODUCED') {
    return {
      status,
      note: 'This run produced no artifacts, or none were passed to the pack.',
      artifacts: [],
    };
  }
  if (source === null) {
    return {
      status,
      note:
        'The artifact store was not available to this pack, so the artifacts below are NAMED and ' +
        'not verified: no size and no digest was read for any of them. Their presence in this list ' +
        'is a claim by the run, not something this pack checked.',
      artifacts: keys.map((key) => ({ key, bytes: null, digest: null })),
    };
  }
  const described = keys.map((key) => {
    const info = source.describe(key);
    // Null from the store is "it did not answer", which is not a zero-byte
    // file; an auditor asking whether the screenshot was kept needs that
    // difference, so the two render differently.
    return info === null
      ? { key, bytes: null, digest: null, status: 'UNAVAILABLE' as const }
      : { key, bytes: info.bytes, digest: `sha256:${info.digestHex}`, status: 'PRESENT' as const };
  });
  const missing = described.filter((entry) => entry.status === 'UNAVAILABLE').length;
  return {
    status,
    ...(missing > 0
      ? {
          note: `${missing} of ${keys.length} artifact(s) could not be read from the store and are reported UNAVAILABLE, not as empty files.`,
        }
      : {}),
    artifacts: described,
  };
}

/** One serialisation, so two files cannot disagree about formatting. */
function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

// ─── The scope statement, as prose ───────────────────────────────────────────

function bullet(lines: readonly string[]): string {
  return lines.length === 0 ? '- (none)\n' : lines.map((line) => `- ${line}`).join('\n') + '\n';
}

function count(label: string, value: number | null): string {
  // "not measured" and "zero" are different sentences and this is the one place
  // the whole pack turns a null into prose. A null printed as 0 here would be
  // the lie in the only document an auditor reads.
  return value === null ? `${label}: not measured` : `${label}: ${value}`;
}

export function renderScopeStatement(
  input: EvidencePackInput,
  scope: EvidenceScopeStatement,
  frameworks: readonly EvidenceFramework[],
): string {
  const lines: string[] = [];
  lines.push('# Scope statement');
  lines.push('');
  lines.push(
    'Read this before any other file in this pack. It states what was tested, what was NOT ' +
      'tested, and what this method cannot establish at all. A findings list without it reads as ' +
      'a claim of completeness that nothing here supports.',
  );
  lines.push('');
  lines.push(`Packs: ${frameworks.map((f) => EVIDENCE_FRAMEWORK_PROFILES[f].label).join(', ')}`);
  lines.push(`Environment: ${scope.tested.environment ?? '(not recorded)'}`);
  lines.push(`Subject: ${trimmed(input.subject) ?? '(not recorded)'}`);
  lines.push(`Prepared by: ${trimmed(input.preparedBy) ?? '(not recorded)'}`);
  lines.push('');

  lines.push('## What was tested');
  lines.push('');
  lines.push(
    bullet([
      `Environment: ${scope.tested.environment ?? 'not recorded'}`,
      `Commit: ${scope.tested.commitSha ?? 'not recorded'}`,
      `Run: ${scope.tested.runId ?? 'not recorded'}`,
      `Window: ${scope.tested.windowStartIso ?? 'start not recorded'} to ${scope.tested.windowEndIso ?? 'end not recorded'}`,
      `Tests executed: ${scope.tested.testCount}`,
      scope.tested.findingCount === null
        ? 'Findings: NOT SUPPLIED to this pack. The absence of findings here is evidence of nothing.'
        : `Findings: ${scope.tested.findingCount}`,
    ]),
  );

  lines.push('### Coverage per axis');
  lines.push('');
  lines.push(AGGREGATE_WITHHELD);
  lines.push('');
  if (scope.tested.perAxis.length === 0) {
    lines.push(
      '- No coverage measurement was supplied with this pack, so it evidences that tests ran and ' +
        'not what proportion of the product they reach.',
    );
    lines.push('');
  } else {
    for (const axis of scope.tested.perAxis) {
      // An unmeasured axis is named as unmeasured and never printed as 0%.
      const figure = !axis.measured
        ? 'UNMEASURED — QAAI has no extractor for this axis'
        : axis.percent === null
          ? 'no items enumerated, so no percentage (not 0%, not 100%)'
          : `${axis.percent}% (${axis.covered} of ${axis.denominator})`;
      lines.push(
        `- ${axis.kind}: ${figure}; asserted-not-run ${axis.assertedNotRun}, no test ${axis.uncovered}, cannot tell ${axis.unknown}, waived ${axis.waived}`,
      );
    }
    lines.push('');
  }

  lines.push('## What was NOT tested, and why');
  lines.push('');
  lines.push('### Axes with no extractor at all');
  lines.push('');
  /*
   * THE MOST DANGEROUS LINE THIS DOCUMENT CAN CARRY.
   *
   * It used to open with "No axis is reported as unmeasured" for the UNKNOWN
   * case and then send the reader to "the warnings printed with this pack" —
   * which are returned to the CALLER and are in no file of the pack. An auditor
   * who receives the directory read a reassurance with the correction nowhere
   * in the document. The three states are now three different sentences, and
   * each one is complete without anything outside this file.
   */
  lines.push(
    scope.notTested.unmeasuredAxes === null
      ? bullet([
          'UNKNOWN for this pack — this is NOT "no axis is unmeasured". No coverage snapshot ' +
            'and no explicit list was supplied, so this list is unavailable rather than empty: ' +
            'which axes QAAI has no extractor for could not be determined here. Several of its ' +
            'surface axes have no extractor in any build, so an absence of findings on them may ' +
            'be an absence of looking, and nothing in this pack establishes otherwise.',
        ])
      : scope.notTested.unmeasuredAxes.length === 0
        ? bullet([
            'Every axis in the coverage snapshot behind this pack has an extractor, so none is ' +
              'reported as unmeasured. This says nothing about axes the snapshot does not ' +
              'contain.',
          ])
        : bullet(
            scope.notTested.unmeasuredAxes.map(
              (kind) =>
                `${kind} — QAAI has no extractor for this axis. It is NOT 0% covered; it is unmeasured, and no finding of any kind could have been produced for it.`,
            ),
          ),
  );
  lines.push('### Enumerated and not covered');
  lines.push('');
  lines.push(
    bullet([
      count('Items with no test', scope.notTested.uncovered),
      count(
        'Items static analysis could not resolve (counted in the denominator, never as covered)',
        scope.notTested.cannotTell,
      ),
      count('Items the team formally waived (excluded from the denominator)', scope.notTested.waived),
      count('Items this harness could not drive here', scope.notTested.unexercisable),
      count('Items a policy rule refused', scope.notTested.refused),
    ]),
  );
  lines.push('### Limits that were in force');
  lines.push('');
  lines.push(
    bullet(
      scope.notTested.caps.map(
        (cap) =>
          `${cap.name}: limit ${cap.limit}, ${cap.applied === 0 ? 'did not bite' : `removed ${cap.applied} item(s)`} — ${cap.reason}`,
      ),
    ),
  );
  lines.push('### Findings the team accepted');
  lines.push('');
  lines.push(
    bullet(
      scope.notTested.acceptedFindings.map(
        (entry) =>
          `${entry.code} at ${entry.location} — owner ${entry.owner ?? 'NOBODY RECORDED'}, expires ${entry.expiresAtIso ?? 'NEVER (open-ended)'}${entry.justification === null ? ', no justification recorded' : `: ${entry.justification}`}`,
      ),
    ),
  );

  lines.push('## What this method cannot establish');
  lines.push('');
  for (const entry of scope.cannotEstablish) {
    lines.push(`### ${entry.label}`);
    lines.push('');
    // Which of the pack's findings this framework actually draws on. Null is
    // "no findings were supplied", never 0 — see `relevantFindingCount`.
    const draws =
      entry.relevantKinds.length === 0
        ? 'Draws on findings of every kind'
        : `Draws on ${entry.relevantKinds.join(', ')} findings`;
    lines.push(
      `${draws}: ${
        entry.relevantFindingCount === null
          ? 'no findings were supplied to this pack, so none of them are evidence for this framework'
          : `${entry.relevantFindingCount} of the findings in this pack`
      }.`,
    );
    lines.push('');
    lines.push(bullet(entry.limits));
  }

  lines.push('## Caveats on the measurement itself');
  lines.push('');
  lines.push(bullet(scope.measurementCaveats));

  lines.push('## How to recompute this');
  lines.push('');
  lines.push(DENOMINATOR_DEFINITION);
  lines.push('');
  lines.push(
    bullet([
      `Crawl fingerprint: ${trimmed(input.snapshot?.fingerprint) ?? 'not recorded'}`,
      `Snapshot: ${trimmed(input.snapshot?.id) ?? 'computed and not stored'}`,
      `Repository: ${trimmed(input.repositoryUri) ?? 'not recorded'}`,
    ]),
  );

  return lines.join('\n');
}

// ─── The reporter ────────────────────────────────────────────────────────────

export const evidencePackReporter: Reporter = {
  name: 'evidence-pack',
  description: 'Signed compliance evidence pack (WCAG 2.1 AA, SOC 2, VPAT) with a scope statement',
  defaultOut: 'qaai-evidence-pack',
  directory: true,

  render(report: RunReport): ReporterDocument {
    // No cast, for the reason given in `sarifReporter.render`.
    const input: EvidencePackInput = report;
    /*
     * The registry path has no key, no digester and no artifact store, so the
     * pack it produces is honestly UNSIGNED — and says so in signature.json
     * rather than omitting the file. The digester is the one exception: sha256
     * over the pack's own bytes needs nothing from the caller, is pure, and
     * without it every tamper check in the pack is null.
     *
     * The clock is the run's own finish stamp, NOT `Date.now()`: a pack
     * rendered twice from one run must be byte-identical, or its signature
     * means nothing.
     */
    const pack = buildEvidencePack(input, {
      clock: clockOf(report),
      digester: sha256Digester(),
      signer: null,
      artifacts: null,
    });
    return { files: pack.files, warnings: pack.warnings };
  },
};
