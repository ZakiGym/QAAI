/**
 * The registry's own tests: every reporter in this directory is REACHABLE.
 *
 * `reporters.test.ts` next door proves the three original formats render
 * correctly. This file proves something narrower and, on the evidence, more
 * expensive to get wrong: that a reporter which exists can be ASKED FOR.
 *
 * `sarif.ts` (900 lines) and `evidence-pack.ts` (1,021 lines) shipped finished,
 * tested, typechecked and documented, and were missing from `REPORTERS`. So
 * `resolveReporter('sarif')` returned null, `--reporter sarif` could not
 * resolve, and `scripts/check-wiring.ts` caught only half of it — it reported
 * evidence-pack as disconnected and said nothing about sarif, because
 * evidence-pack imports sarif and one importer was enough to look like a
 * reader.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. REGISTRY PARITY, BY ENUMERATING THE DIRECTORY. Every module here that
 *      exports a `Reporter` is in `REPORTERS` or on an explicit allow-list with
 *      a reason. Deliberately NOT "the newest file is registered": the defect
 *      this closes is a file nobody remembered, so the test must not depend on
 *      anybody remembering it either.
 *   2. BOTH NEW NAMES RESOLVE, and the test names them, so removing either from
 *      the array goes red here rather than at a customer's `--reporter`.
 *   3. THE FILE-OR-DIRECTORY ANSWER IS CARRIED. An evidence pack is seven files
 *      and a `.sarif` is one; a caller that writes a directory as a file
 *      silently produces one of the seven. `directory` is the field that
 *      prevents it, and it is asserted per reporter rather than assumed.
 *   4. NEITHER EMITS AN EMPTY DOCUMENT THAT READS AS "NO FINDINGS". Reached
 *      THROUGH the registry, which is the path that did not exist before: a
 *      SARIF file with zero results and no warning is a clean bill of health
 *      manufactured out of a run that supplied no findings at all.
 *
 * No network, no browser, no filesystem writes — `readdir` on this directory is
 * the only I/O, and it is the point of test 1.
 */

import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  REPORTERS,
  REPORTER_NAMES,
  evidencePackReporter,
  renderReport,
  resolveReporter,
  sarifReporter,
} from './index.js';
import type { Reporter, RunReport } from './types.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/**
 * Modules in this directory that are NOT expected to export a reporter, each
 * with the reason it is exempt.
 *
 * An allow-list and not a pattern match: "the file is called types.ts" is a
 * naming convention, and the next finished reporter could be called anything.
 * A new module here fails test 1 until somebody either registers its reporter
 * or writes down why it has none, which is the whole mechanism.
 */
const NOT_REPORTERS: Record<string, string> = {
  'index.ts': 'the registry itself',
  'types.ts': 'the Reporter interface and the pure helpers every format shares',
};

/** A finished run with no findings and real timings. */
const report: RunReport = {
  id: 'run_registry',
  name: 'nightly',
  startedAt: Date.UTC(2026, 0, 1, 0, 0, 0),
  finishedAt: Date.UTC(2026, 0, 1, 0, 1, 0),
  commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  branch: 'main',
  tests: [
    {
      name: 'checkout with a saved card',
      suite: 'checkout.spec.ts',
      status: 'passed',
      durationMs: 1200,
    },
    {
      name: 'checkout with an expired card',
      suite: 'checkout.spec.ts',
      status: 'failed',
      durationMs: 900,
      message: 'expected the error banner',
    },
  ],
};

/** Duck-typed, because the point is to catch a module the TYPES never saw. */
function reportersExportedBy(module: Record<string, unknown>): Reporter[] {
  return Object.values(module).filter((value): value is Reporter => {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<Reporter>;
    return (
      typeof candidate.name === 'string' &&
      typeof candidate.description === 'string' &&
      typeof candidate.defaultOut === 'string' &&
      typeof candidate.directory === 'boolean' &&
      typeof candidate.render === 'function'
    );
  });
}

// ─── 1. Registry parity ──────────────────────────────────────────────────────

describe('registry parity with the directory', () => {
  it('registers every reporter module in this directory, or says why not', async () => {
    const entries = await readdir(HERE);
    const modules = entries
      .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
      .filter((name) => !(name in NOT_REPORTERS))
      .sort();

    // A zero-length list would make this test vacuous — exactly the failure
    // mode a directory scan has when the glob stops matching.
    expect(modules.length).toBeGreaterThanOrEqual(5);

    const unregistered: string[] = [];
    const reporterless: string[] = [];

    for (const file of modules) {
      /*
       * `@vite-ignore` and a specifier in a variable, because Vite's
       * dynamic-import-vars plugin cannot analyse an import that names its own
       * directory and prints a warning on every run saying so. The import is
       * left to the runtime, which resolves it; a warning nobody can act on is
       * a warning people stop reading.
       */
      const specifier = `./${file.replace(/\.ts$/, '')}.js`;
      const loaded = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
      const found = reportersExportedBy(loaded);
      if (found.length === 0) {
        reporterless.push(file);
        continue;
      }
      for (const reporter of found) {
        // Identity, not name equality: a second object with the same name
        // would resolve to whichever one the array holds, and the module's own
        // export would still be unreachable.
        if (!REPORTERS.includes(reporter)) unregistered.push(`${file} → ${reporter.name}`);
      }
    }

    expect(unregistered).toEqual([]);
    /*
     * The other half, and the reason this is not just `includes`: a module with
     * no reporter at all has to be on NOT_REPORTERS with a reason, or a
     * reporter that was deleted down to a stub would pass the check above by
     * exporting nothing.
     */
    expect(reporterless).toEqual([]);
  });

  it('exposes one name per reporter, normalised so resolveReporter can match it', () => {
    expect(new Set(REPORTER_NAMES).size).toBe(REPORTER_NAMES.length);
    for (const name of REPORTER_NAMES) {
      expect(name).toBe(name.trim().toLowerCase());
      expect(resolveReporter(name)?.name).toBe(name);
    }
  });
});

// ─── 2. The two that were unreachable ────────────────────────────────────────

describe('sarif and evidence-pack are selectable by name', () => {
  it('resolves both, and names them so removing either from REPORTERS goes red', () => {
    expect(REPORTER_NAMES).toContain('sarif');
    expect(REPORTER_NAMES).toContain('evidence-pack');

    expect(resolveReporter('sarif')).not.toBeNull();
    expect(resolveReporter('sarif')).toBe(sarifReporter);
    expect(resolveReporter('evidence-pack')).not.toBeNull();
    expect(resolveReporter('evidence-pack')).toBe(evidencePackReporter);

    // The normalisation a CLI relies on: `--reporter SARIF` is the same ask.
    expect(resolveReporter('  SARIF ')?.name).toBe('sarif');
    expect(resolveReporter('Evidence-Pack')?.name).toBe('evidence-pack');

    // And the negative, so a pass here cannot come from a resolver that says
    // yes to everything.
    expect(resolveReporter('evidencepack')).toBeNull();
    expect(resolveReporter('sarif-2')).toBeNull();
  });

  it('carries whether the output is one file or a directory', () => {
    expect(resolveReporter('sarif')?.directory).toBe(false);
    expect(resolveReporter('sarif')?.defaultOut).toBe('qaai.sarif');
    /*
     * The pack is a DIRECTORY, and this is the assertion that matters for a
     * caller: writing seven files to one path keeps the last one and silently
     * discards the manifest and the signature that make the pack evidence.
     */
    expect(resolveReporter('evidence-pack')?.directory).toBe(true);
    expect(renderReport('evidence-pack', report)?.files.length).toBeGreaterThan(1);
  });

  it('describes itself for a --help screen', () => {
    for (const name of ['sarif', 'evidence-pack']) {
      const description = resolveReporter(name)?.description ?? '';
      expect(description.length).toBeGreaterThan(10);
    }
  });
});

// ─── 3. Nothing reads as "no findings" ───────────────────────────────────────

describe('reached through the registry, neither invents a clean result', () => {
  it('renders a document for both, through renderReport', () => {
    for (const name of ['sarif', 'evidence-pack']) {
      const document = renderReport(name, report);
      expect(document, name).not.toBeNull();
      expect(document?.files.length, name).toBeGreaterThan(0);
      for (const file of document?.files ?? []) {
        expect(file.path).not.toBe('');
        expect(file.path).not.toContain('..');
        expect(file.contentType).toMatch(/\//);
        expect(file.contents.length).toBeGreaterThan(0);
      }
    }
  });

  it('says out loud that a run supplying no findings is not a clean scan', () => {
    const sarif = renderReport('sarif', report);
    expect(sarif?.warnings.length).toBeGreaterThan(0);
    expect(sarif?.warnings.join('\n')).toContain('not the same as a clean scan');

    // The pack's equivalent: a pack with no key is UNSIGNED and says so rather
    // than omitting the file, which would read as "signing was not required".
    const pack = renderReport('evidence-pack', report);
    expect(pack?.warnings.length).toBeGreaterThan(0);
    expect(pack?.files.map((f) => f.path)).toContain('signature.json');
  });
});
