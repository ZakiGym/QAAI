/**
 * The reporter registry: one name in, one document out.
 *
 * Kept deliberately thin. Everything a caller needs to offer `--reporter` in a
 * CLI, a dropdown in the app, or a new API route is here — the names, the human
 * description for a help screen, whether the output is a file or a directory —
 * so none of that has to be restated at each call site and drift.
 *
 * `resolveReporter` returns null rather than throwing on an unknown name. The
 * caller is always in a better position to say what to do about it (a CLI wants
 * an exit code and a list of valid names; an API wants a 400), and a reporting
 * layer that throws is how a finished run turns into no results at all.
 *
 * ── A REPORTER NOBODY CAN NAME IS A REPORTER NOBODY CAN RUN ─────────────────
 *
 * `sarif.ts` and `evidence-pack.ts` shipped finished, tested and typechecked
 * and were ABSENT from `REPORTERS` below, so `resolveReporter('sarif')`
 * returned null and `--reporter sarif` could not resolve from anywhere. 1,900
 * lines of correct code with no door. `scripts/check-wiring.ts` reported
 * evidence-pack as disconnected and missed sarif entirely, because
 * evidence-pack imports it and that was enough to look like a reader.
 *
 * Both are plain `Reporter`s and needed no cast: `evidencePackReporter` sets
 * `directory: true`, which is the field this registry already carries for
 * exactly that case, so a pack of files fits the same interface as a single
 * `.sarif` document. That is why there is no second registry here.
 *
 * `index.test.ts` enumerates this DIRECTORY and fails if a module in it exports
 * a `Reporter` that is not in the array below or on its allow-list. That is the
 * compiler-and-runtime parity pattern this repo already uses for its unions,
 * applied to the registry: it is what stops the next finished reporter from
 * shipping unreachable.
 */

import { allureReporter } from './allure.js';
import { evidencePackReporter } from './evidence-pack.js';
import { junitReporter } from './junit.js';
import { sarifReporter } from './sarif.js';
import { testrailReporter } from './testrail.js';
import type { Reporter, ReporterDocument, ReporterOptions, RunReport } from './types.js';

export type {
  Reporter,
  ReportedTest,
  ReporterDocument,
  ReporterFile,
  ReporterOptions,
  ReporterStatus,
  ReporterUpload,
  RunReport,
  RunTotals,
} from './types.js';
export {
  QUARANTINE_NOTE,
  derivedTotals,
  durationOf,
  fullNameOf,
  suiteNameOf,
  totalsOf,
} from './types.js';
export { escapeXml, junitReporter, renderJUnitXml } from './junit.js';
export { allureReporter, allureResultFor } from './allure.js';
export type { AllureResult, AllureStatus } from './allure.js';
export { caseIdsFor, elapsedFor, testrailReporter, TESTRAIL_STATUS } from './testrail.js';
export type { TestRailPayload, TestRailResult } from './testrail.js';
export {
  clockOf,
  executionSucceeded,
  fingerprintOf,
  locationsFor,
  MAX_SARIF_RESULTS,
  regionOf,
  renderSarifLog,
  rulesFor,
  sarifReporter,
  SARIF_LEVEL,
  SARIF_SCHEMA,
  SARIF_VERSION,
  SECURITY_SEVERITY,
  suppressionState,
} from './sarif.js';
export type {
  FindingRegion,
  FindingSuppression,
  ReportClock,
  ReportedFinding,
  SarifInvocation,
  SarifLevel,
  SarifLocation,
  SarifLog,
  SarifMessage,
  SarifNotification,
  SarifRegion,
  SarifReportingDescriptor,
  SarifResult,
  SarifRun,
  SarifRunReport,
  SarifSuppression,
} from './sarif.js';
export {
  AGGREGATE_WITHHELD,
  buildEvidencePack,
  DENOMINATOR_DEFINITION,
  EVIDENCE_FRAMEWORKS,
  EVIDENCE_FRAMEWORK_PROFILES,
  evidencePackReporter,
  renderScopeStatement,
  sha256Digester,
  unmeasuredAxesOf,
} from './evidence-pack.js';
export type {
  ArtifactStatus,
  DateStatus,
  EvidenceArtifactSource,
  EvidenceAxis,
  EvidenceCap,
  EvidenceDeps,
  EvidenceDigester,
  EvidenceFramework,
  EvidenceFrameworkProfile,
  EvidenceManifest,
  EvidencePack,
  EvidencePackInput,
  EvidenceScopeStatement,
  EvidenceSignatureFile,
  EvidenceSigner,
  SignatureStatus,
} from './evidence-pack.js';

export const REPORTERS: readonly Reporter[] = [
  junitReporter,
  allureReporter,
  testrailReporter,
  sarifReporter,
  evidencePackReporter,
];

export const REPORTER_NAMES: readonly string[] = REPORTERS.map((r) => r.name);

export function resolveReporter(name: string): Reporter | null {
  const wanted = name.trim().toLowerCase();
  return REPORTERS.find((r) => r.name === wanted) ?? null;
}

/** Render by name. Null when no such reporter — see the note above about throwing. */
export function renderReport(
  name: string,
  report: RunReport,
  options?: ReporterOptions,
): ReporterDocument | null {
  return resolveReporter(name)?.render(report, options) ?? null;
}
