/**
 * Does the pack read as a complete audit when it is not one?
 *
 * Separate from evidence-pack.test.ts, which asserts the builder's decisions.
 * This file reads the pack the way its only real reader does: as a DIRECTORY of
 * files, with no access to the `warnings` the reporter hands back to its
 * caller. Everything an auditor is entitled to know has to be inside a file, or
 * it is not in the document.
 *
 * ── The defect this found ───────────────────────────────────────────────────
 *
 * With no coverage snapshot and no explicit list, the scope statement opened
 * its "Axes with no extractor at all" section with "No axis is reported as
 * unmeasured" and then referred the reader to "the warnings printed with this
 * pack" — which are returned to the CALLER and appear in no file. An auditor
 * holding the directory read a reassurance whose correction was not in the
 * document. The same null reached `scope-statement.json` as `[]`, so a gate
 * diffing the out-of-scope list read "nothing is unmeasured" for "we do not
 * know".
 *
 * Both are the same mistake: a null became a clean bill of health, in the one
 * artifact this product emits that somebody else signs their name under.
 */

import { describe, expect, it } from 'vitest';
import type { SurfaceKind, SurfaceSnapshot } from '@qaai/shared';
import {
  buildEvidencePack,
  evidencePackReporter,
  sha256Digester,
  type EvidencePackInput,
  type EvidenceScopeStatement,
} from './evidence-pack.js';
import type { ReporterFile, RunReport } from './types.js';

/** A snapshot with three axes QAAI has no extractor for and a truncated crawl. */
function snapshot(): SurfaceSnapshot {
  const axis = (
    kind: SurfaceKind,
    measured: boolean,
    over: Partial<{ denominator: number; covered: number; percent: number | null }> = {},
  ) => ({
    kind,
    measured,
    denominator: 0,
    covered: 0,
    assertedNotRun: 0,
    uncovered: 0,
    unknown: 0,
    waived: 0,
    percent: null,
    ...over,
  });

  return {
    id: 'snap_1',
    createdAtIso: '2026-10-25T00:00:00.000Z',
    fingerprint: 'crawl_abc',
    inputs: { analysisId: 'an_1', flowMapVersion: 3 },
    caveats: [
      'The crawl stopped at its page cap of 200 URLs and did not reach every route the ' +
        'route manifest lists.',
    ],
    totals: {
      byKind: [
        axis('ROUTE', true, { denominator: 100, covered: 40, percent: 40 }),
        axis('BACKGROUND_JOB', false),
        axis('NOTIFICATION', false),
        axis('ERROR_STATE', false),
      ],
      denominator: 100,
      covered: 40,
      assertedNotRun: 5,
      uncovered: 50,
      unknown: 5,
      waived: 0,
      unexercisable: 2,
      refused: 1,
      percent: 40,
    },
  } as unknown as SurfaceSnapshot;
}

function input(over: Partial<EvidencePackInput> = {}): EvidencePackInput {
  return {
    id: 'run_9',
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_060_000,
    tests: [{ name: 'checkout', status: 'passed' }],
    findings: [],
    ...over,
  } as unknown as EvidencePackInput;
}

const deps = () => ({ clock: { nowMs: () => 1_700_000_060_000 }, digester: sha256Digester() });

const contentsOf = (files: readonly ReporterFile[], path: string): string => {
  const file = files.find((entry) => entry.path === path);
  expect(file, `the pack has no ${path}`).toBeDefined();
  return file?.contents ?? '';
};

describe('a pack over an incomplete measurement says so, inside the pack', () => {
  const pack = () =>
    buildEvidencePack(
      input({
        snapshot: snapshot(),
        caps: [
          {
            name: 'crawl page cap',
            limit: 200,
            applied: 38,
            reason: '38 enumerated routes were never loaded because the crawl stopped at 200 pages',
          },
        ],
      }),
      deps(),
    );

  it('names all three unmeasured axes, and never as 0%', () => {
    const scope = contentsOf(pack().files, 'scope-statement.md');
    for (const kind of ['BACKGROUND_JOB', 'NOTIFICATION', 'ERROR_STATE']) {
      expect(scope).toContain(kind);
      expect(scope).toContain(`${kind}: UNMEASURED — QAAI has no extractor for this axis`);
    }
    expect(scope).toContain('It is NOT 0% covered');
  });

  it('states the truncation as a count and a reason', () => {
    const scope = contentsOf(pack().files, 'scope-statement.md');
    expect(scope).toContain('crawl page cap: limit 200, removed 38 item(s)');
    // And the snapshot's own caveat, which is the other half of the same fact.
    expect(scope).toContain('page cap of 200 URLs');
  });

  it('refuses a single headline percentage while giving every count behind one', () => {
    const scope = contentsOf(pack().files, 'scope-statement.md');
    expect(scope).toContain('No single coverage percentage is reported');
    expect(scope).toContain('ROUTE: 40% (40 of 100)');
    // The summed figure the snapshot itself carries is not printed anywhere.
    expect(scope).not.toMatch(/\b40%\s*\(40 of 0\)/);
  });

  it('says it is unsigned, in a file, rather than omitting the signature', () => {
    const files = pack().files;
    expect(contentsOf(files, 'signature.json')).toContain('THIS PACK IS NOT SIGNED');
    expect(contentsOf(files, 'signature.json')).toContain('not as evidence');
  });
});

describe('a pack with no measurement behind it cannot read as a clean one', () => {
  it('says the unmeasured-axis list is UNKNOWN, not that nothing is unmeasured', () => {
    const scope = contentsOf(buildEvidencePack(input({ snapshot: null }), deps()).files, 'scope-statement.md');

    expect(scope).toContain('UNKNOWN for this pack');
    expect(scope).toContain('this is NOT "no axis is unmeasured"');
    // The sentence that was there before, and the dangling pointer that went
    // with it. The warnings are NOT in the pack, so nothing may refer to them.
    expect(scope).not.toContain('No axis is reported as unmeasured');
    expect(scope).not.toContain('see the warnings printed with this pack');
  });

  it('carries null in the JSON, because [] is the answer "every axis is measured"', () => {
    const unknown = JSON.parse(
      contentsOf(buildEvidencePack(input({ snapshot: null }), deps()).files, 'scope-statement.json'),
    ) as EvidenceScopeStatement;
    expect(unknown.notTested.unmeasuredAxes).toBeNull();

    // And a real empty list still means what it says.
    const measured = JSON.parse(
      contentsOf(
        buildEvidencePack(input({ snapshot: null, unmeasuredKinds: [] }), deps()).files,
        'scope-statement.json',
      ),
    ) as EvidenceScopeStatement;
    expect(measured.notTested.unmeasuredAxes).toEqual([]);
  });

  it('distinguishes "no findings were supplied" from "there were no findings"', () => {
    const notSupplied = buildEvidencePack(input({ findings: undefined }), deps());
    const clean = buildEvidencePack(input({ findings: [] }), deps());

    expect(contentsOf(notSupplied.files, 'findings.json')).toContain('NOT_SUPPLIED');
    expect(contentsOf(notSupplied.files, 'scope-statement.md')).toContain(
      'Findings: NOT SUPPLIED to this pack',
    );
    expect(contentsOf(clean.files, 'findings.json')).toContain('SUPPLIED');
    expect(contentsOf(clean.files, 'scope-statement.md')).toContain('Findings: 0');
  });

  it('calls a quarantined failure a suppressed failure, not a pass', () => {
    const pack = buildEvidencePack(
      input({ tests: [{ name: 'flaky checkout', status: 'quarantined' }] }),
      deps(),
    );
    expect(contentsOf(pack.files, 'tests.json')).toContain('QUARANTINED FAILURE');
    expect(contentsOf(pack.files, 'tests.json')).toContain('coverage by a FAILING test');
  });
});

describe('the pack a registry call produces', () => {
  it('is dated from the run and is byte-identical rendered twice', () => {
    // A pack rendered twice from one run must match, or its signature means
    // nothing — which is why the clock is the run's own stamp and not the wall.
    const report = input() as unknown as RunReport;
    const first = evidencePackReporter.render(report);
    const second = evidencePackReporter.render(report);
    expect(first.files.map((file) => file.contents)).toEqual(
      second.files.map((file) => file.contents),
    );
  });

  it('digests every other file, so editing one after assembly shows', () => {
    const files = evidencePackReporter.render(input()).files;
    const manifest = JSON.parse(contentsOf(files, 'manifest.json')) as {
      files: Array<{ path: string; digest: string | null }>;
      digestAlgorithm: string | null;
    };

    expect(manifest.digestAlgorithm).toBe('sha256');
    for (const entry of manifest.files) {
      expect(entry.digest, `${entry.path} has no digest`).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    // The scope statement is digested, which is what makes it non-removable.
    expect(manifest.files.map((entry) => entry.path)).toContain('scope-statement.md');
  });
});
