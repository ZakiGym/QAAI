/**
 * Evidence pack tests. What each section is here to catch:
 *
 *  1. **A pack that implies completeness.** The scope statement is MANDATORY
 *     content, so it is asserted present — with its three mandatory sections —
 *     for every framework, for an empty input, and for an input with no
 *     snapshot at all. There must be no code path that drops it.
 *
 *  2. **A null that became 0.** Not measured, not supplied and zero are three
 *     different facts and this document is the one place turning any of them
 *     into another is unrecoverable. Asserted on the findings list, every
 *     not-tested count, the per-axis percentages, the artifact sizes and the
 *     test durations.
 *
 *  3. **A signature or a date that is not there.** A pack with no key must say
 *     UNSIGNED in a file that exists, and a pack with no clock must say
 *     UNDATED — not fall back to the wall clock, which would also make the
 *     output unassertable.
 *
 *  4. **Two denominators added together.** The pack must carry no combined
 *     percentage, and the oracle for that is "the snapshot's own summed figure
 *     appears nowhere in the bytes".
 *
 *  5. **An unmeasured axis reported as 0%.** The axes QAAI has no extractor for
 *     must be named as unmeasured in prose, and a reader must never see 0%
 *     against one.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { SurfaceKindTotals, SurfaceSnapshot } from '@qaai/shared';
import {
  AGGREGATE_WITHHELD,
  DENOMINATOR_DEFINITION,
  EVIDENCE_FRAMEWORKS,
  EVIDENCE_FRAMEWORK_PROFILES,
  buildEvidencePack,
  evidencePackReporter,
  sha256Digester,
  unmeasuredAxesOf,
  type EvidenceArtifactSource,
  type EvidenceDeps,
  type EvidenceManifest,
  type EvidencePackInput,
  type EvidenceSignatureFile,
  type EvidenceSigner,
} from './evidence-pack.js';
import type { ReportedFinding } from './sarif.js';
import type { ReporterFile, RunReport } from './types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A distinctive combined figure. It must appear in NO file in the pack. */
const SUMMED_PERCENT = 11.7;

function axis(over: Partial<SurfaceKindTotals> & Pick<SurfaceKindTotals, 'kind'>): SurfaceKindTotals {
  return {
    denominator: 10,
    covered: 4,
    assertedNotRun: 1,
    uncovered: 5,
    unknown: 0,
    waived: 2,
    percent: 40,
    measured: true,
    ...over,
  };
}

function snapshot(over: Partial<SurfaceSnapshot> = {}): SurfaceSnapshot {
  return {
    id: 'snap_1',
    projectId: 'proj_1',
    createdAtIso: '2026-10-25T00:00:00.000Z',
    commitSha: 'abc1234',
    totals: {
      percent: SUMMED_PERCENT,
      denominator: 40,
      covered: 8,
      assertedNotRun: 2,
      uncovered: 30,
      unknown: 4,
      waived: 3,
      unexercisable: 6,
      refused: 1,
      declaredNeverReached: 7,
      reachedNeverDeclared: 2,
      byKind: [
        axis({ kind: 'ROUTE', percent: 40 }),
        axis({ kind: 'ENDPOINT', denominator: 0, covered: 0, uncovered: 0, waived: 0, percent: null }),
        axis({ kind: 'FORM', covered: 0, percent: 0 }),
        axis({ kind: 'ROLE_CELL', measured: false, denominator: 0, covered: 0, percent: null }),
        axis({ kind: 'DATA_VARIANT', measured: false, denominator: 0, covered: 0, percent: null }),
      ],
    },
    inputs: { analysisId: 'an_1', flowMapVersion: 3, testCount: 12, runId: 'run_abc' },
    caveats: ['The crawl stopped at the page cap.'],
    fingerprint: 'fp_deadbeef',
    ...over,
  };
}

function finding(over: Partial<ReportedFinding> = {}): ReportedFinding {
  return {
    kind: 'ACCESSIBILITY',
    severity: 'SERIOUS',
    code: 'color-contrast',
    message: 'Elements must have sufficient colour contrast',
    location: 'div.hero > span.price',
    helpUrl: null,
    ...over,
  };
}

function input(over: Partial<EvidencePackInput> = {}): EvidencePackInput {
  return {
    id: 'run_abc',
    startedAt: Date.parse('2026-10-25T09:00:00.000Z'),
    finishedAt: Date.parse('2026-10-25T09:04:00.000Z'),
    commitSha: 'abc1234',
    branch: 'main',
    environment: 'staging',
    subject: 'Acme Inc',
    preparedBy: 'QAAI, for Acme Inc',
    repositoryUri: 'https://github.com/acme/app',
    tests: [{ name: 'a11y scan', suite: 'accessibility', status: 'passed', durationMs: 1200 }],
    findings: [finding()],
    snapshot: snapshot(),
    ...over,
  };
}

/** A clock that cannot drift, so the pack is byte-assertable. */
const FROZEN = { nowMs: () => Date.parse('2026-10-25T12:00:00.000Z') };

function recordingSigner(): EvidenceSigner & { readonly signed: string[] } {
  const signed: string[] = [];
  return {
    algorithm: 'ed25519',
    keyId: 'key_1',
    signed,
    sign(payload: string) {
      signed.push(payload);
      return `sig(${createHash('sha256').update(payload).digest('hex').slice(0, 16)})`;
    },
  };
}

function deps(over: EvidenceDeps = {}): EvidenceDeps {
  return { clock: FROZEN, digester: sha256Digester(), signer: null, artifacts: null, ...over };
}

function at(files: readonly ReporterFile[], path: string): ReporterFile {
  const file = files.find((f) => f.path === path);
  expect(file, `pack is missing ${path}`).toBeDefined();
  return file!;
}

function readJson<T>(files: readonly ReporterFile[], path: string): T {
  return JSON.parse(at(files, path).contents) as T;
}

// ─── The vocabulary ──────────────────────────────────────────────────────────

describe('evidence-pack — the framework vocabulary', () => {
  it('has a profile for every framework, and no profile for anything else', () => {
    // The run-time half of this codebase's pattern for a vocabulary with a
    // write path. The compiler enforces the Record's keys; it cannot see a
    // Record that has drifted from the array it was keyed on, which is how
    // eight gate kinds shipped unsaveable.
    expect(Object.keys(EVIDENCE_FRAMEWORK_PROFILES).sort()).toEqual([...EVIDENCE_FRAMEWORKS].sort());
    for (const framework of EVIDENCE_FRAMEWORKS) {
      const profile = EVIDENCE_FRAMEWORK_PROFILES[framework];
      expect(profile.label.length).toBeGreaterThan(0);
      // Every framework must state what it cannot establish. A profile with an
      // empty list is a pack that makes an unqualified claim.
      expect(profile.cannotEstablish.length).toBeGreaterThan(0);
      for (const limit of profile.cannotEstablish) expect(limit.length).toBeGreaterThan(20);
    }
  });
});

// ─── The scope statement ─────────────────────────────────────────────────────

describe('evidence-pack — the scope statement is mandatory content', () => {
  for (const framework of EVIDENCE_FRAMEWORKS) {
    it(`is present with all three mandatory sections for ${framework}`, () => {
      const pack = buildEvidencePack(input({ frameworks: [framework] }), deps());
      const prose = at(pack.files, 'scope-statement.md').contents;
      expect(prose).toContain('# Scope statement');
      expect(prose).toContain('## What was tested');
      expect(prose).toContain('## What was NOT tested, and why');
      expect(prose).toContain('## What this method cannot establish');
      expect(prose).toContain(EVIDENCE_FRAMEWORK_PROFILES[framework].label);
      for (const limit of EVIDENCE_FRAMEWORK_PROFILES[framework].cannotEstablish) {
        expect(prose).toContain(limit);
      }
    });
  }

  it('says which findings each framework draws on, and never prints 0 for none supplied', () => {
    const pack = buildEvidencePack(
      input({
        frameworks: ['WCAG_2_1_AA', 'SOC2'],
        findings: [finding(), finding({ kind: 'PERFORMANCE', code: 'lcp-budget' })],
      }),
      deps(),
    );
    const prose = at(pack.files, 'scope-statement.md').contents;
    // Only one of the two findings is accessibility, which is the whole point:
    // a WCAG pack holding two findings must not read as two a11y findings.
    expect(prose).toContain('Draws on ACCESSIBILITY findings: 1 of the findings in this pack.');
    expect(prose).toContain('Draws on findings of every kind: 2 of the findings in this pack.');

    const none = buildEvidencePack(input({ findings: undefined }), deps());
    expect(at(none.files, 'scope-statement.md').contents).toContain(
      'no findings were supplied to this pack, so none of them are evidence for this framework',
    );
    const scope = readJson<{ cannotEstablish: Array<{ relevantFindingCount: number | null }> }>(
      none.files,
      'scope-statement.json',
    );
    for (const entry of scope.cannotEstablish) expect(entry.relevantFindingCount).toBeNull();
  });

  it('returns the manifest and scope objects that match the files it wrote', () => {
    const pack = buildEvidencePack(input(), deps());
    // The richer entry point hands back the objects as well as the bytes; a
    // caller that reads one and ships the other would ship two answers.
    expect(pack.manifest).toEqual(readJson<EvidenceManifest>(pack.files, 'manifest.json'));
    expect(pack.scope).toEqual(readJson(pack.files, 'scope-statement.json'));
  });

  it('survives an input with nothing in it at all', () => {
    const pack = buildEvidencePack({ tests: [] }, {});
    const prose = at(pack.files, 'scope-statement.md').contents;
    expect(prose).toContain('## What was NOT tested, and why');
    expect(prose).toContain('## What this method cannot establish');
    // Every framework's limits, because no framework was named.
    for (const framework of EVIDENCE_FRAMEWORKS) {
      expect(prose).toContain(EVIDENCE_FRAMEWORK_PROFILES[framework].label);
    }
  });

  it('is listed first in the manifest and digested like every other file', () => {
    const pack = buildEvidencePack(input(), deps());
    const manifest = readJson<EvidenceManifest>(pack.files, 'manifest.json');
    expect(manifest.files[0]!.path).toBe('scope-statement.md');
    for (const entry of manifest.files) {
      expect(entry.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(entry.bytes).toBeGreaterThan(0);
    }
  });

  it('carries the denominator definition and the crawl fingerprint, so it can be recomputed', () => {
    const pack = buildEvidencePack(input(), deps());
    const manifest = readJson<EvidenceManifest>(pack.files, 'manifest.json');
    expect(manifest.recompute.denominatorDefinition).toBe(DENOMINATOR_DEFINITION);
    expect(manifest.recompute.crawlFingerprint).toBe('fp_deadbeef');
    expect(manifest.recompute.snapshotId).toBe('snap_1');
    expect(manifest.recompute.analysisId).toBe('an_1');
    expect(manifest.recompute.flowMapVersion).toBe(3);
    expect(manifest.recompute.commitSha).toBe('abc1234');
    expect(manifest.recompute.repositoryUri).toBe('https://github.com/acme/app');
    expect(at(pack.files, 'scope-statement.md').contents).toContain('fp_deadbeef');
  });

  it('states the rule that a failing test still covers, and that written is not run', () => {
    expect(DENOMINATOR_DEFINITION).toContain('observed to run');
    expect(DENOMINATOR_DEFINITION).toContain('a failing test still covers');
    expect(DENOMINATOR_DEFINITION).toContain('does NOT count as covered');
    expect(DENOMINATOR_DEFINITION).toContain('COUNTED IN the denominator');
    expect(DENOMINATOR_DEFINITION).toContain('named as unmeasured and are not reported as 0%');
  });
});

// ─── No combined percentage ──────────────────────────────────────────────────

describe('evidence-pack — two denominators are never added together', () => {
  it('reports no combined percentage anywhere in the pack', () => {
    const pack = buildEvidencePack(input(), deps());
    const bytes = pack.files.map((file) => file.contents).join('\n');
    // The snapshot's own summed figure is the thing being refused.
    expect(bytes).not.toContain(String(SUMMED_PERCENT));
    expect(bytes).toContain(AGGREGATE_WITHHELD);
    const scope = readJson<{ tested: { perAxis: unknown[] } }>(pack.files, 'scope-statement.json');
    expect(scope.tested.perAxis).toHaveLength(5);
  });

  it('gives the per-axis counts, so a reader can sum them knowing what they are', () => {
    const pack = buildEvidencePack(input(), deps());
    const scope = readJson<{ tested: { perAxis: Array<Record<string, unknown>> } }>(
      pack.files,
      'scope-statement.json',
    );
    expect(scope.tested.perAxis[0]).toEqual({
      kind: 'ROUTE',
      measured: true,
      denominator: 10,
      covered: 4,
      assertedNotRun: 1,
      uncovered: 5,
      unknown: 0,
      waived: 2,
      percent: 40,
    });
  });
});

// ─── Nulls that must not become zeroes ───────────────────────────────────────

describe('evidence-pack — not measured is null, never 0', () => {
  it('names an unmeasured axis as unmeasured and never prints 0% for it', () => {
    const pack = buildEvidencePack(input(), deps());
    const prose = at(pack.files, 'scope-statement.md').contents;
    expect(prose).toContain('ROLE_CELL: UNMEASURED — QAAI has no extractor for this axis');
    expect(prose).toContain('DATA_VARIANT: UNMEASURED');
    expect(prose).toContain(
      'ROLE_CELL — QAAI has no extractor for this axis. It is NOT 0% covered; it is unmeasured',
    );
    // The one line that must not exist: an unmeasured axis with a figure.
    expect(prose).not.toMatch(/ROLE_CELL: 0%/);
    expect(prose).not.toMatch(/DATA_VARIANT: 0%/);
  });

  it('distinguishes an empty axis from a 0% axis', () => {
    const prose = at(buildEvidencePack(input(), deps()).files, 'scope-statement.md').contents;
    // Denominator zero: no percentage at all.
    expect(prose).toContain('ENDPOINT: no items enumerated, so no percentage (not 0%, not 100%)');
    // Denominator ten, nothing covered: a real 0%.
    expect(prose).toContain('FORM: 0% (0 of 10)');
  });

  it('prints "not measured" rather than 0 for every not-tested count without a snapshot', () => {
    const pack = buildEvidencePack(input({ snapshot: null }), deps());
    const prose = at(pack.files, 'scope-statement.md').contents;
    expect(prose).toContain('Items with no test: not measured');
    expect(prose).toContain('Items the team formally waived (excluded from the denominator): not measured');
    const scope = readJson<{ notTested: Record<string, unknown> }>(pack.files, 'scope-statement.json');
    expect(scope.notTested.uncovered).toBeNull();
    expect(scope.notTested.cannotTell).toBeNull();
    expect(scope.notTested.waived).toBeNull();
    expect(scope.notTested.unexercisable).toBeNull();
    expect(scope.notTested.refused).toBeNull();
    expect(pack.warnings.join(' ')).toContain('No coverage snapshot was supplied');
  });

  it('distinguishes findings-not-supplied from zero findings', () => {
    const none = buildEvidencePack(input({ findings: undefined }), deps());
    const noneFile = readJson<{ status: string; note: string }>(none.files, 'findings.json');
    expect(noneFile.status).toBe('NOT_SUPPLIED');
    expect(noneFile.note).toContain('evidence of nothing');
    expect(
      readJson<{ tested: { findingCount: number | null } }>(none.files, 'scope-statement.json').tested
        .findingCount,
    ).toBeNull();
    expect(at(none.files, 'scope-statement.md').contents).toContain(
      'Findings: NOT SUPPLIED to this pack',
    );
    expect(none.warnings.join(' ')).toContain('findings.json records status NOT_SUPPLIED');

    const clean = buildEvidencePack(input({ findings: [] }), deps());
    const cleanFile = readJson<{ status: string; count: number }>(clean.files, 'findings.json');
    expect(cleanFile.status).toBe('SUPPLIED');
    expect(cleanFile.count).toBe(0);
    expect(at(clean.files, 'scope-statement.md').contents).toContain('Findings: 0');
  });

  it('omits a duration the run never took, rather than writing 0 ms', () => {
    const pack = buildEvidencePack(
      input({ tests: [{ name: 'untimed', status: 'passed' }] }),
      deps(),
    );
    const tests = readJson<{ tests: Array<Record<string, unknown>> }>(pack.files, 'tests.json');
    expect('durationMs' in tests.tests[0]!).toBe(false);
    expect(at(pack.files, 'tests.json').contents).not.toContain('1970');
  });

  it('says which axes are unmeasured is UNKNOWN rather than printing an empty list', () => {
    expect(unmeasuredAxesOf({ tests: [] })).toBeNull();
    expect(unmeasuredAxesOf({ tests: [], unmeasuredKinds: ['NOTIFICATION'] })).toEqual(['NOTIFICATION']);
    expect(unmeasuredAxesOf(input())).toEqual(['ROLE_CELL', 'DATA_VARIANT']);

    const pack = buildEvidencePack(input({ snapshot: null }), deps());
    expect(pack.warnings.join(' ')).toContain('is UNKNOWN for this pack');
    expect(at(pack.files, 'scope-statement.md').contents).toContain(
      'this list is unavailable rather than empty',
    );
  });
});

// ─── Dated and signed ────────────────────────────────────────────────────────

describe('evidence-pack — dated, or explicitly UNDATED', () => {
  it('dates the pack from the injected clock, not from the wall', () => {
    const manifest = readJson<EvidenceManifest>(
      buildEvidencePack(input(), deps()).files,
      'manifest.json',
    );
    expect(manifest.dateStatus).toBe('DATED');
    expect(manifest.generatedAtIso).toBe('2026-10-25T12:00:00.000Z');
  });

  it('reports UNDATED with a null date when there is no clock', () => {
    const pack = buildEvidencePack(input(), deps({ clock: null }));
    const manifest = readJson<EvidenceManifest>(pack.files, 'manifest.json');
    expect(manifest.dateStatus).toBe('UNDATED');
    expect(manifest.generatedAtIso).toBeNull();
    expect(pack.warnings.join(' ')).toContain('cannot evidence WHEN anything was tested');
  });

  it('keeps the tested window separate from the generation date', () => {
    const scope = readJson<{ tested: { windowStartIso: string | null; windowEndIso: string | null } }>(
      buildEvidencePack(input(), deps()).files,
      'scope-statement.json',
    );
    expect(scope.tested.windowStartIso).toBe('2026-10-25T09:00:00.000Z');
    expect(scope.tested.windowEndIso).toBe('2026-10-25T09:04:00.000Z');
  });

  it('reports a missing window as not recorded rather than as the epoch', () => {
    const pack = buildEvidencePack(
      input({ startedAt: undefined, finishedAt: undefined }),
      deps(),
    );
    expect(at(pack.files, 'scope-statement.md').contents).toContain(
      'Window: start not recorded to end not recorded',
    );
  });
});

describe('evidence-pack — signed, or explicitly UNSIGNED', () => {
  it('signs the exact bytes of manifest.json', () => {
    const signer = recordingSigner();
    const pack = buildEvidencePack(input(), deps({ signer }));
    const signature = readJson<EvidenceSignatureFile>(pack.files, 'signature.json');
    expect(signature.status).toBe('SIGNED');
    expect(signature.over).toBe('manifest.json');
    expect(signature.algorithm).toBe('ed25519');
    expect(signature.keyId).toBe('key_1');
    // The signature must cover the manifest BYTES, or verifying it proves
    // nothing about the pack.
    expect(signer.signed).toEqual([at(pack.files, 'manifest.json').contents]);
    expect(signature.manifestDigest).toBe(
      `sha256:${createHash('sha256').update(at(pack.files, 'manifest.json').contents, 'utf8').digest('hex')}`,
    );
    expect(signature.signature).toBe(
      `sig(${createHash('sha256').update(at(pack.files, 'manifest.json').contents).digest('hex').slice(0, 16)})`,
    );
    // Signed exactly once: a second call would mean two different payloads
    // could each claim to be "the" signature over this pack.
    expect(signer.signed).toHaveLength(1);
  });

  it('writes an explicit UNSIGNED file rather than omitting it', () => {
    const pack = buildEvidencePack(input(), deps());
    const signature = readJson<EvidenceSignatureFile>(pack.files, 'signature.json');
    expect(signature.status).toBe('UNSIGNED');
    expect(signature.signature).toBeNull();
    expect(signature.algorithm).toBeNull();
    expect(signature.keyId).toBeNull();
    expect(signature.note).toContain('THIS PACK IS NOT SIGNED');
    expect(readJson<EvidenceManifest>(pack.files, 'manifest.json').signatureStatus).toBe('UNSIGNED');
    expect(pack.warnings.join(' ')).toContain('The pack is UNSIGNED');
  });

  it('leaves every digest null rather than writing a placeholder, with no digester', () => {
    const pack = buildEvidencePack(input(), deps({ digester: null }));
    const manifest = readJson<EvidenceManifest>(pack.files, 'manifest.json');
    expect(manifest.digestAlgorithm).toBeNull();
    for (const entry of manifest.files) expect(entry.digest).toBeNull();
    expect(readJson<EvidenceSignatureFile>(pack.files, 'signature.json').manifestDigest).toBeNull();
    expect(pack.warnings.join(' ')).toContain('nothing in it can be checked for tampering');
  });

  it('changes a file digest when that file changes', () => {
    const before = readJson<EvidenceManifest>(
      buildEvidencePack(input(), deps()).files,
      'manifest.json',
    );
    const after = readJson<EvidenceManifest>(
      buildEvidencePack(input({ findings: [finding({ code: 'other' })] }), deps()).files,
      'manifest.json',
    );
    const digestOf = (manifest: EvidenceManifest, path: string) =>
      manifest.files.find((f) => f.path === path)!.digest;
    expect(digestOf(after, 'findings.json')).not.toBe(digestOf(before, 'findings.json'));
    expect(digestOf(after, 'tests.json')).toBe(digestOf(before, 'tests.json'));
  });
});

// ─── Artifacts ───────────────────────────────────────────────────────────────

describe('evidence-pack — artifacts, and the three things their absence can mean', () => {
  it('reports NONE_PRODUCED when the run made none', () => {
    const pack = buildEvidencePack(input(), deps());
    expect(readJson<{ status: string }>(pack.files, 'artifacts.json').status).toBe('NONE_PRODUCED');
    expect(readJson<EvidenceManifest>(pack.files, 'manifest.json').artifactStatus).toBe('NONE_PRODUCED');
  });

  it('reports the store being absent, and does not claim the artifacts were checked', () => {
    const pack = buildEvidencePack(input({ artifactKeys: ['shot.png'] }), deps());
    const file = readJson<{
      status: string;
      note: string;
      artifacts: Array<{ key: string; bytes: number | null; digest: string | null }>;
    }>(pack.files, 'artifacts.json');
    expect(file.status).toBe('ARTIFACT_DIGESTS_UNAVAILABLE');
    expect(file.note).toContain('a claim by the run, not something this pack checked');
    expect(file.artifacts).toEqual([{ key: 'shot.png', bytes: null, digest: null }]);
  });

  it('distinguishes an artifact the store could not read from an empty one', () => {
    const source: EvidenceArtifactSource = {
      describe: (key) => (key === 'gone.png' ? null : { bytes: 0, digestHex: 'e3b0' }),
    };
    const pack = buildEvidencePack(
      input({ artifactKeys: ['gone.png', 'empty.png'] }),
      deps({ artifacts: source }),
    );
    const file = readJson<{
      status: string;
      note?: string;
      artifacts: Array<{ key: string; bytes: number | null; status: string }>;
    }>(pack.files, 'artifacts.json');
    expect(file.status).toBe('DESCRIBED');
    expect(file.artifacts[0]).toEqual({ key: 'gone.png', bytes: null, digest: null, status: 'UNAVAILABLE' });
    expect(file.artifacts[1]).toEqual({
      key: 'empty.png',
      bytes: 0,
      digest: 'sha256:e3b0',
      status: 'PRESENT',
    });
    expect(file.note).toContain('reported UNAVAILABLE, not as empty files');
  });
});

// ─── Exclusions ──────────────────────────────────────────────────────────────

describe('evidence-pack — every exclusion is named', () => {
  it('reports a cap that bit with both its count and its reason', () => {
    const pack = buildEvidencePack(
      input({
        caps: [
          { name: 'crawl page cap', limit: 60, applied: 23, reason: 'the crawl budget ran out' },
          { name: 'finding cap', limit: 5000, applied: 0, reason: 'protects the SARIF upload' },
        ],
      }),
      deps(),
    );
    const prose = at(pack.files, 'scope-statement.md').contents;
    expect(prose).toContain('crawl page cap: limit 60, removed 23 item(s) — the crawl budget ran out');
    expect(prose).toContain('finding cap: limit 5000, did not bite — protects the SARIF upload');
    const warnings = pack.warnings.join(' ');
    expect(warnings).toContain('1 cap(s) BIT');
    expect(warnings).toContain('removed 23: the crawl budget ran out');
    // A cap that did not bite is not announced as if it had.
    expect(warnings).not.toContain('finding cap (limit 5000');
  });

  it('lists an accepted finding with its owner and expiry, and names the ones with neither', () => {
    const pack = buildEvidencePack(
      input({
        findings: [
          finding({
            code: 'owned',
            suppression: {
              owner: 'sec@acme.test',
              expiresAtIso: '2099-01-01T00:00:00Z',
              justification: 'compensating control',
            },
          }),
          finding({ code: 'orphan', location: 'div.footer', suppression: {} }),
        ],
      }),
      deps(),
    );
    const prose = at(pack.files, 'scope-statement.md').contents;
    expect(prose).toContain(
      'owned at div.hero > span.price — owner sec@acme.test, expires 2099-01-01T00:00:00Z: compensating control',
    );
    expect(prose).toContain(
      'orphan at div.footer — owner NOBODY RECORDED, expires NEVER (open-ended), no justification recorded',
    );
    const warnings = pack.warnings.join(' ');
    expect(warnings).toContain('1 accepted finding(s) in this pack carry no owner');
    expect(warnings).toContain('1 accepted finding(s) in this pack have no expiry');
  });

  it('does not list a LAPSED acceptance as an exclusion', () => {
    const pack = buildEvidencePack(
      input({
        findings: [finding({ code: 'lapsed', suppression: { expiresAtIso: '2000-01-01T00:00:00Z' } })],
      }),
      deps(),
    );
    const scope = readJson<{ notTested: { acceptedFindings: unknown[] } }>(
      pack.files,
      'scope-statement.json',
    );
    // It is reported LIVE by the SARIF reporter; excluding it here as well
    // would hide it twice.
    expect(scope.notTested.acceptedFindings).toEqual([]);
    expect(readJson<{ findings: Array<{ accepted: boolean }> }>(pack.files, 'findings.json').findings[0]!.accepted).toBe(false);
  });

  it('carries the snapshot caveats verbatim', () => {
    const pack = buildEvidencePack(input(), deps());
    expect(at(pack.files, 'scope-statement.md').contents).toContain('The crawl stopped at the page cap.');
  });

  it('says a quarantined test is a suppressed failure, not pass evidence', () => {
    const pack = buildEvidencePack(
      input({
        tests: [{ name: 'checkout', status: 'quarantined', message: 'expected 200, got 500' }],
      }),
      deps(),
    );
    const tests = readJson<{ tests: Array<{ note?: string; status: string }> }>(pack.files, 'tests.json');
    expect(tests.tests[0]!.status).toBe('quarantined');
    expect(tests.tests[0]!.note).toContain('QUARANTINED FAILURE');
    expect(tests.tests[0]!.note).toContain('coverage by a FAILING test');
    expect(pack.warnings.join(' ')).toContain('had their failure suppressed by quarantine');
  });

  it('names the absence of a preparer', () => {
    expect(buildEvidencePack(input({ preparedBy: undefined }), deps()).warnings.join(' ')).toContain(
      'names nobody as its preparer',
    );
    expect(buildEvidencePack(input(), deps()).warnings.join(' ')).not.toContain('names nobody as its preparer');
  });
});

// ─── The reporter contract ───────────────────────────────────────────────────

describe('evidence-pack — the reporter contract', () => {
  it('matches the registry shape the other reporters use', () => {
    expect(evidencePackReporter.name).toBe('evidence-pack');
    expect(evidencePackReporter.directory).toBe(true);
    expect(evidencePackReporter.defaultOut).toBe('qaai-evidence-pack');
    expect(evidencePackReporter.description.length).toBeGreaterThan(0);
  });

  it('writes every file with contents and a content type', () => {
    const document = evidencePackReporter.render(input());
    expect(document.files.map((f) => f.path).sort()).toEqual([
      'artifacts.json',
      'findings.json',
      'manifest.json',
      'scope-statement.json',
      'scope-statement.md',
      'signature.json',
      'tests.json',
    ]);
    for (const file of document.files) {
      expect(file.contents.length).toBeGreaterThan(0);
      expect(file.contents.endsWith('\n')).toBe(true);
      expect(file.contentType).toMatch(/^(application\/json|text\/markdown)$/);
    }
  });

  it('is byte-identical when one run is rendered twice', () => {
    const fixture = input();
    const first = evidencePackReporter.render(fixture).files;
    const second = evidencePackReporter.render(fixture).files;
    expect(second.map((f) => [f.path, f.contents])).toEqual(first.map((f) => [f.path, f.contents]));
  });

  it('dates the registry pack from the run, so the signature of a re-render still verifies', () => {
    const manifest = readJson<EvidenceManifest>(
      evidencePackReporter.render(input()).files,
      'manifest.json',
    );
    // The run's own finish stamp, NOT Date.now().
    expect(manifest.generatedAtIso).toBe('2026-10-25T09:04:00.000Z');
    expect(manifest.dateStatus).toBe('DATED');
    expect(manifest.signatureStatus).toBe('UNSIGNED');
  });

  it('still produces a pack, and a scope statement, for a run with nothing in it', () => {
    const document = evidencePackReporter.render({ tests: [] });
    expect(at(document.files, 'scope-statement.md').contents).toContain('## What was NOT tested, and why');
    expect(readJson<EvidenceManifest>(document.files, 'manifest.json').dateStatus).toBe('UNDATED');
    expect(document.warnings.length).toBeGreaterThan(3);
  });
});

/**
 * The four properties `reporters.test.ts` applies to every member of
 * `evidencePackReporterS`, asserted here against a reporter that is not on that list yet.
 *
 * This is deliberate duplication. The registry loop cannot see this reporter
 * until somebody adds it to `evidencePackReporterS` in `index.ts` (a file this round does
 * not own), and "it will pass once wired" is not a thing to find out during the
 * wiring. The untimed fixture is transcribed from that file.
 */
const PACK_FIXTURES: RunReport[] = [input(), input({ snapshot: null, findings: undefined }), { tests: [] }];

const UNTIMED: RunReport = {
  id: 'run_untimed',
  tests: [
    { name: 'C42 imported case with no timing', status: 'passed' },
    { name: 'C43 also untimed', status: 'failed', message: 'boom' },
  ],
};

describe('evidence-pack — the properties the registry applies to every reporter', () => {
  it('never throws, on any fixture', () => {
    for (const report of PACK_FIXTURES) {
      expect(() => evidencePackReporter.render(report, { testRailRunId: 1 })).not.toThrow();
    }
  });

  it('always produces named files with content types', () => {
    for (const report of PACK_FIXTURES) {
      for (const file of evidencePackReporter.render(report, { testRailRunId: 1 }).files) {
        expect(file.path).not.toBe('');
        expect(file.path).not.toContain('..');
        expect(file.contentType).toMatch(/\//);
      }
    }
  });

  it('never invents a timing for a test the run did not time', () => {
    const text = evidencePackReporter.render(UNTIMED, { testRailRunId: 1 })
      .files.map((f) => f.contents)
      .join('\n');
    expect(text).not.toContain('time="0.000"');
    expect(text).not.toContain('"elapsed"');
    expect(text).not.toContain('"start": 0');
    expect(text).not.toContain('"stop": 0');
    expect(text).not.toContain('"durationMs": 0');
  });

  it('says out loud when it left something out', () => {
    expect(evidencePackReporter.render(UNTIMED, { testRailRunId: 1 }).warnings.length).toBeGreaterThan(0);
  });
});
