/**
 * Tests for the mutation plugin.
 *
 * Two things here are worth more than the rest of the file:
 *
 *  1. **The score arithmetic.** A mutation score is a number people put in a
 *     merge gate. If a compile-error mutant were counted as killed, or an
 *     uncovered one dropped from the denominator, the number goes UP as the
 *     suite gets worse — the one failure mode of this plugin that looks like
 *     good news.
 *
 *  2. **A missing tool is SKIPPED, never FAILED.** Reporting an absent binary
 *     as a failure blames the application under test for the worker's setup.
 *     That bug has been fixed twice in this repo, so it is pinned here.
 *
 * The `execute` cases drive the real code path — spawn, parse, gate — using
 * `node -e` as a stand-in tool, so no mutation tool needs to be installed for
 * the suite to run.
 *
 *  3. **WHERE it runs.** This plugin resolved its workspace from
 *     `process.cwd()`, so on the worker it mutated QAAI's own checkout and
 *     filed the score as the customer's. Every context below now carries a real
 *     materialised workspace, one case proves the tool actually ran inside it,
 *     and two more pin the refusals: no repository is SKIPPED (a configuration
 *     gap), a path that escapes is FAILED (a broken test — a skip does not block
 *     a gate).
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArtifactSink, ExecutableTest, RunContext, StepStatus } from '@qaai/shared';
import { attachRunWorkspace } from '../run-workspace.js';
import {
  applyMutantToText,
  mutationPlugin,
  mutationRunData,
  mutationScore,
  parseElementsJson,
  parseGoMutestingStdout,
  parseInfectionJson,
  parseMutantStdout,
  parseMutmutResults,
  parseMutmutStdout,
  parsePitXml,
  runFocusedMutantTrial,
  runSingleTest,
  trialDidNotRun,
} from './mutation.js';
import type { MutantEdit } from './mutation.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

const artifacts: ArtifactSink = {
  put: async () => 'key',
  putFile: async () => 'key',
  get: async () => null,
  putPersistent: async () => 'key',
};

/**
 * The run's materialised repository, fresh per test.
 *
 * A real directory rather than a string: the plugin spawns its tool with this
 * as the cwd, so a fake root would turn every `execute` case into a spawn
 * failure and hide whatever it was testing.
 */
let repoWorkspace = '';

beforeEach(async () => {
  repoWorkspace = await mkdtemp(join(tmpdir(), 'qaai-mutation-repo-'));
});

afterEach(async () => {
  await rm(repoWorkspace, { recursive: true, force: true });
});

function makeContext(
  workspaceRoot: string | null = repoWorkspace,
): RunContext & { logged: Array<{ title: string; status: StepStatus }> } {
  const logged: Array<{ title: string; status: StepStatus }> = [];
  const ctx: RunContext & { logged: Array<{ title: string; status: StepStatus }> } = {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl: 'http://localhost:3000',
    secrets: {},
    storageState: null,
    artifacts,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      step: (event) => logged.push({ title: event.title, status: event.status }),
    },
    signal: new AbortController().signal,
    determinism: {
      freezeClockAt: null,
      randomSeed: 1,
      waitForNetworkIdle: false,
      retryOnce: false,
    },
    logged,
  };
  return attachRunWorkspace(
    ctx,
    workspaceRoot === null
      ? null
      : { root: workspaceRoot, source: 'acme/pricing@main', fileCount: 12 },
  );
}

function makeTest(spec: unknown): ExecutableTest {
  return {
    id: 'test_1',
    name: 'Mutation score of the pricing module',
    type: 'MUTATION',
    code: '',
    filePath: 'mutation/pricing.json',
    spec,
    timeoutMs: 60_000,
    quarantined: false,
    tags: [],
  };
}

/** A fake mutation tool: runs `js` under node. Kept short — spec args cap at 500 chars. */
function fakeScript(js: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ['-e', js] };
}

/** A fake mutation tool: prints the lines we give it, exits with `code`. */
function fakeTool(lines: string[], code = 0): { command: string; args: string[] } {
  return fakeScript(
    `${lines.map((l) => `console.log(${JSON.stringify(l)});`).join('')}process.exit(${code});`,
  );
}

// ─── Score arithmetic ────────────────────────────────────────────────────────

describe('mutationScore', () => {
  it('is killed over valid, and ignores mutants that never ran', () => {
    expect(mutationScore({ detected: 8, undetected: 2, excluded: 0, survivors: [] })).toBe(80);
    // The excluded ones must not pad the numerator OR the denominator.
    expect(mutationScore({ detected: 8, undetected: 2, excluded: 90, survivors: [] })).toBe(80);
  });

  it('is null rather than 0 or 100 when nothing valid ran', () => {
    expect(mutationScore({ detected: 0, undetected: 0, excluded: 5, survivors: [] })).toBeNull();
  });
});

// ─── Readers ─────────────────────────────────────────────────────────────────

describe('parseElementsJson (Stryker, Stryker.NET)', () => {
  const report = parseElementsJson(
    JSON.stringify({
      files: {
        'src/price.ts': {
          mutants: [
            { id: '1', status: 'Killed', mutatorName: 'ArithmeticOperator' },
            // A timeout means the suite reacted, so it counts as a kill.
            { id: '2', status: 'Timeout', mutatorName: 'BlockStatement' },
            {
              id: '3',
              status: 'Survived',
              mutatorName: 'EqualityOperator',
              replacement: 'total >= 100',
              location: { start: { line: 42, column: 5 }, end: { line: 42, column: 20 } },
            },
            {
              id: '4',
              status: 'NoCoverage',
              mutatorName: 'ConditionalExpression',
              location: { start: { line: 7, column: 1 } },
            },
            // Never ran: excluded from the score entirely.
            { id: '5', status: 'CompileError', mutatorName: 'StringLiteral' },
            { id: '6', status: 'Ignored', mutatorName: 'StringLiteral' },
          ],
        },
      },
    }),
  );

  it('counts killed and timed-out mutants as detected', () => {
    expect(report.detected).toBe(2);
  });

  it('counts survived AND uncovered mutants against the score', () => {
    expect(report.undetected).toBe(2);
    expect(mutationScore(report)).toBe(50);
  });

  it('excludes mutants the tool could not run', () => {
    expect(report.excluded).toBe(2);
  });

  it('locates each survivor so the step names a line', () => {
    expect(report.survivors).toContainEqual({
      file: 'src/price.ts',
      line: 42,
      mutator: 'EqualityOperator',
      detail: 'replaced with total >= 100',
      reason: 'survived',
    });
    expect(report.survivors.find((s) => s.line === 7)?.reason).toBe('no-coverage');
  });

  it('reads a report with no mutants without inventing any', () => {
    expect(parseElementsJson('{"files":{}}')).toEqual({
      detected: 0,
      undetected: 0,
      excluded: 0,
      survivors: [],
    });
  });
});

describe('parsePitXml', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mutations partial="false">
  <mutation detected='true' status='KILLED' numberOfTestsRun='3'><sourceFile>Price.java</sourceFile><mutatedClass>com.shop.Price</mutatedClass><mutatedMethod>total</mutatedMethod><lineNumber>18</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.MathMutator</mutator><description>Replaced integer addition with subtraction</description></mutation>
  <mutation detected='true' status='TIMED_OUT'><sourceFile>Price.java</sourceFile><mutatedClass>com.shop.Price</mutatedClass><lineNumber>20</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.VoidMethodCallMutator</mutator><description>removed call</description></mutation>
  <mutation detected='false' status='SURVIVED'><sourceFile>Price.java</sourceFile><mutatedClass>com.shop.Price</mutatedClass><mutatedMethod>discount</mutatedMethod><lineNumber>42</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.ConditionalsBoundaryMutator</mutator><description>changed conditional boundary</description></mutation>
  <mutation detected='false' status='NO_COVERAGE'><sourceFile>Price.java</sourceFile><mutatedClass>com.shop.Price</mutatedClass><lineNumber>51</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.NegateConditionalsMutator</mutator><description>negated conditional</description></mutation>
  <mutation detected='false' status='NON_VIABLE'><sourceFile>Price.java</sourceFile><mutatedClass>com.shop.Price</mutatedClass><lineNumber>60</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.MathMutator</mutator><description>non viable</description></mutation>
</mutations>`;

  it('scores killed and timed-out as detected, non-viable as excluded', () => {
    const report = parsePitXml(xml);
    expect(report.detected).toBe(2);
    expect(report.undetected).toBe(2);
    expect(report.excluded).toBe(1);
    expect(mutationScore(report)).toBe(50);
  });

  it('shortens the mutator class to the operator name', () => {
    const survivor = parsePitXml(xml).survivors.find((s) => s.line === 42);
    expect(survivor?.mutator).toBe('ConditionalsBoundaryMutator');
    expect(survivor?.file).toBe('com.shop.Price');
    expect(survivor?.detail).toContain('changed conditional boundary');
  });

  it('returns an empty report for XML that holds no mutations', () => {
    expect(parsePitXml('<mutations></mutations>').detected).toBe(0);
    expect(parsePitXml('not xml at all').survivors).toEqual([]);
  });
});

describe('parseInfectionJson', () => {
  const report = parseInfectionJson(
    JSON.stringify({
      stats: {
        totalMutantsCount: 10,
        killedCount: 6,
        timeOutCount: 1,
        escapedCount: 2,
        notCoveredCount: 1,
        errorCount: 0,
        syntaxErrorCount: 0,
        skippedCount: 0,
        ignoredCount: 0,
        msi: 70,
      },
      escaped: [
        {
          mutator: {
            mutatorName: 'GreaterThan',
            originalFilePath: 'src/Cart.php',
            originalStartLine: 31,
            mutatedSourceCode: 'if ($qty >= 1) {',
          },
        },
      ],
      notCovered: [
        {
          mutator: {
            mutatorName: 'PublicVisibility',
            originalFilePath: 'src/Cart.php',
            originalStartLine: 88,
          },
        },
      ],
    }),
  );

  it('takes its counts from the tool stats', () => {
    expect(report.detected).toBe(7);
    expect(report.undetected).toBe(3);
    expect(mutationScore(report)).toBe(70);
  });

  it('keeps escaped and uncovered mutants apart in the survivor list', () => {
    expect(report.survivors.map((s) => s.reason)).toEqual(['survived', 'no-coverage']);
    expect(report.survivors[0]?.line).toBe(31);
  });
});

describe('parseMutmutStdout', () => {
  it('reads the progress legend, counting timeouts as kills', () => {
    const report = parseMutmutStdout('⠹ 12/12  🎉 8  ⏰ 1  🤔 1  🙁 2  🔇 0');
    expect(report).not.toBeNull();
    expect(report?.detected).toBe(9);
    expect(report?.undetected).toBe(2);
    // "suspicious" is not a verdict either way.
    expect(report?.excluded).toBe(1);
  });

  it('counts mutmut 3 "no tests" as undetected, not as excluded', () => {
    const report = parseMutmutStdout('12/12  🎉 8  🫥 3  ⏰ 0  🤔 0  🙁 1  🔇 0');
    expect(report?.undetected).toBe(4);
  });

  it('takes the last legend, not the first progress tick', () => {
    const report = parseMutmutStdout('⠋ 1/9  🎉 1  🙁 0\n⠙ 5/9  🎉 4  🙁 1\n⠸ 9/9  🎉 7  🙁 2');
    expect(report?.detected).toBe(7);
    expect(report?.undetected).toBe(2);
  });

  it('is null when the output has no legend, so the caller can say so', () => {
    expect(parseMutmutStdout('Traceback (most recent call last):')).toBeNull();
  });
});

describe('parseMutmutResults', () => {
  // Captured from mutmut 3.3.1.
  it('reads the mutmut 3 per-mutant listing, keeping the id `mutmut show` wants', () => {
    const survivors = parseMutmutResults(
      [
        '    calc.x_add__mutmut_1: killed',
        '    calc.x_is_big__mutmut_1: no tests',
        '    calc.x_is_big__mutmut_2: survived',
        '    calc.x_add__mutmut_2: not checked',
      ].join('\n'),
    );

    expect(survivors).toHaveLength(2);
    expect(survivors[0]).toEqual({
      file: 'calc.py',
      line: null,
      mutator: 'is_big',
      detail: 'mutant calc.x_is_big__mutmut_1',
      reason: 'no-coverage',
    });
    expect(survivors[1]?.reason).toBe('survived');
  });

  it('groups surviving mutant ids under their file', () => {
    const survivors = parseMutmutResults(
      [
        'To apply a mutant on disk:',
        '',
        'Survived 🙁 (3)',
        '',
        '---- src/cart.py (3) ----',
        '',
        '3, 7, 12',
      ].join('\n'),
    );
    expect(survivors).toHaveLength(3);
    expect(survivors[0]?.file).toBe('src/cart.py');
    expect(survivors.map((s) => s.detail)).toEqual(['mutant 3', 'mutant 7', 'mutant 12']);
  });
});

describe('parseMutantStdout', () => {
  it('reads the summary block and lists the alive subjects', () => {
    const report = parseMutantStdout(
      [
        'evil:Cart#total:a1b2c',
        '@@ -1 +1 @@',
        'Subjects:        4',
        'Mutations:       120',
        'Results:         120',
        'Kills:           110',
        'Alive:           10',
        'Coverage:        91.67%',
      ].join('\n'),
    );
    expect(report?.detected).toBe(110);
    expect(report?.undetected).toBe(10);
    expect(report?.survivors[0]?.file).toBe('Cart#total:a1b2c');
  });

  it('is null when mutant never printed a summary', () => {
    expect(parseMutantStdout('Mutant environment: ...')).toBeNull();
  });
});

describe('parseGoMutestingStdout', () => {
  it('maps go-mutesting PASS to killed and FAIL to survived', () => {
    const report = parseGoMutestingStdout(
      [
        'PASS "/tmp/go-mutesting-1/price.go.0" with checksum aaa',
        'FAIL "/tmp/go-mutesting-1/price.go.1" with checksum bbb',
        'The mutation score is 0.500000 (1 passed, 1 failed, 0 duplicated, 0 skipped, total is 2)',
      ].join('\n'),
    );
    expect(report?.detected).toBe(1);
    expect(report?.undetected).toBe(1);
    expect(report?.survivors[0]?.file).toBe('/tmp/go-mutesting-1/price.go');
    expect(report?.survivors[0]?.detail).toBe('mutant #1');
  });

  it('is null without a score line', () => {
    expect(parseGoMutestingStdout('go: cannot find main module')).toBeNull();
  });
});

// ─── validate() ──────────────────────────────────────────────────────────────

describe('validate', () => {
  it('accepts a spec that is only a tool name', () => {
    expect(() => mutationPlugin.validate(makeTest({ tool: 'stryker' }))).not.toThrow();
  });

  it('names the bad field in a sentence', () => {
    expect(() => mutationPlugin.validate(makeTest({ tool: 'stryker', minScore: 500 }))).toThrow(
      /minScore/,
    );
    expect(() => mutationPlugin.validate(makeTest({ tool: 'not-a-tool' }))).toThrow(/tool/);
    expect(() => mutationPlugin.validate(makeTest({ reportPath: '../../etc/passwd' }))).toThrow(
      /reportPath.*relative/,
    );
  });

  it('explains the args/command mix-up rather than silently ignoring args', () => {
    expect(() => mutationPlugin.validate(makeTest({ args: ['--dry-run'] }))).toThrow(
      /args: only applies together with command/,
    );
  });
});

// ─── execute() ───────────────────────────────────────────────────────────────

describe('execute', () => {
  it('reports a missing tool as SKIPPED with the install command', async () => {
    const execution = await mutationPlugin.execute(
      makeContext(),
      makeTest({ tool: 'stryker', command: 'qaai-no-such-mutation-tool', args: ['run'] }),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('npm install --save-dev @stryker-mutator/core');
    expect(execution.steps).toEqual([]);
  });

  it('fails when the score is under the threshold, and names the survivor', async () => {
    const ctx = makeContext();
    const execution = await mutationPlugin.execute(
      ctx,
      makeTest({
        tool: 'go-mutesting',
        minScore: 60,
        ...fakeTool([
          'PASS "/w/price.go.0" with checksum aaa',
          'FAIL "/w/price.go.1" with checksum bbb',
          'The mutation score is 0.500000 (1 passed, 1 failed, 0 duplicated, 0 skipped, total is 2)',
        ]),
      }),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.steps[0]?.title).toBe(
      'Mutation score 50.0% — 1 of 2 mutants killed (minimum 60%)',
    );
    expect(execution.steps[0]?.status).toBe('FAILED');
    expect(execution.steps[1]?.title).toContain('/w/price.go');
    expect(execution.steps[1]?.error?.actual).toBe('all tests passed');
    expect(execution.errorMessage).toContain('below the 60% minimum');
    // Steps are what the cockpit renders live, so they must reach the logger.
    expect(ctx.logged.length).toBe(execution.steps.length);
  });

  it('passes when the score clears the threshold, still listing survivors', async () => {
    const execution = await mutationPlugin.execute(
      makeContext(),
      makeTest({
        tool: 'go-mutesting',
        minScore: 60,
        ...fakeTool([
          'FAIL "/w/price.go.3" with checksum bbb',
          'The mutation score is 0.750000 (3 passed, 1 failed, 0 duplicated, 0 skipped, total is 4)',
        ]),
      }),
    );

    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage).toBeNull();
    expect(execution.steps[0]?.status).toBe('PASSED');
    expect(execution.steps).toHaveLength(2);
  });

  it('truncates the survivor list instead of writing thousands of steps', async () => {
    const execution = await mutationPlugin.execute(
      makeContext(),
      makeTest({
        tool: 'go-mutesting',
        minScore: 0,
        maxSurvivorsReported: 3,
        ...fakeScript(
          `for(let i=0;i<8;i++)console.log('FAIL "/w/p.go.'+i+'" x');` +
            `console.log('The mutation score is 0.2 (2 passed, 8 failed, 0 duplicated, 0 skipped, total is 10)')`,
        ),
      }),
    );

    // headline + 3 survivors + the "and 5 more" note
    expect(execution.steps).toHaveLength(5);
    expect(execution.steps.at(-1)?.title).toContain('and 5 more surviving mutants');
    expect(execution.steps.at(-1)?.status).toBe('SKIPPED');
  });

  it('skips rather than passes when the tool generated no mutants', async () => {
    const execution = await mutationPlugin.execute(
      makeContext(),
      makeTest({
        tool: 'go-mutesting',
        ...fakeTool([
          'The mutation score is 0.000000 (0 passed, 0 failed, 0 duplicated, 0 skipped, total is 0)',
        ]),
      }),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('no runnable mutants');
  });

  it('does not invent a verdict when the tool wrote no report it could read', async () => {
    const execution = await mutationPlugin.execute(
      makeContext(),
      makeTest({ tool: 'go-mutesting', ...fakeTool(['panic: something went wrong'], 2) }),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toContain('no readable report');
    expect(execution.errorMessage).toContain('panic: something went wrong');
  });

  it('reports a count-only tool honestly instead of implying it listed everything', async () => {
    const execution = await mutationPlugin.execute(
      makeContext(),
      makeTest({
        tool: 'go-mutesting',
        minScore: 0,
        ...fakeTool([
          'The mutation score is 0.500000 (1 passed, 1 failed, 0 duplicated, 0 skipped, total is 2)',
        ]),
      }),
    );

    expect(execution.status).toBe('PASSED');
    expect(execution.steps.at(-1)?.title).toContain('reported the count without naming them');
  });

  /*
   * ── Where the tool ran ─────────────────────────────────────────────────────
   *
   * The marker file is written by the fake tool into its own cwd, so finding it
   * in the materialised workspace — and not in the worker's directory — is
   * proof of where the run happened. Before the fix it landed in QAAI's own
   * checkout.
   */
  it('runs the tool inside the materialised repository, not the worker directory', async () => {
    const execution = await mutationPlugin.execute(
      makeContext(),
      makeTest({
        tool: 'go-mutesting',
        minScore: 0,
        ...fakeScript(
          `require("fs").writeFileSync("qaai-cwd-marker","");` +
            `console.log('The mutation score is 0.500000 (1 passed, 1 failed, 0 duplicated, 0 skipped, total is 2)')`,
        ),
      }),
    );

    expect(execution.status).toBe('PASSED');
    expect(existsSync(join(repoWorkspace, 'qaai-cwd-marker'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'qaai-cwd-marker'))).toBe(false);
  });

  it('is not evaluated when the run has no checkout of the repository', async () => {
    const execution = await mutationPlugin.execute(
      makeContext(null),
      makeTest({ tool: 'go-mutesting', minScore: 0, ...fakeTool(['anything']) }),
    );

    // SKIPPED: a missing repository is a configuration gap, and a FAILED here
    // would read as a verdict on the customer's suite.
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toMatch(/no checkout of your repository/);
    expect(execution.errorMessage).toMatch(/Connect the project to its repository/);
    expect(execution.steps).toEqual([]);
  });

  /*
   * `cwd` is schema-bounded against `..` and a leading `/`, which is why this
   * uses a drive letter: the schema lets `C:\…` through (it splits on
   * separators and finds no `..`), and on POSIX it is a plain relative name. The
   * runtime guard is what refuses it, and this is the case that proves the
   * guard is not just restating the schema.
   */
  it('fails, rather than skips, on a cwd the workspace guard refuses', async () => {
    const execution = await mutationPlugin.execute(
      makeContext(),
      makeTest({ tool: 'go-mutesting', cwd: 'C:\\Windows', ...fakeTool(['anything']) }),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toMatch(/not inside the repository/);
    expect(execution.errorMessage).toContain('acme/pricing@main');
  });
});

// ─── mutationRunData ─────────────────────────────────────────────────────────

describe('mutationRunData', () => {
  it('reports the score as data, with the denominator it was computed over', () => {
    const data = mutationRunData({ detected: 8, undetected: 2, excluded: 90, survivors: [] }, 60);
    expect(data).toMatchObject({ score: 80, valid: 10, excluded: 90, minScore: 60, passed: true });
  });

  it('does not report an unevaluated suite as passing', () => {
    const data = mutationRunData({ detected: 0, undetected: 0, excluded: 3, survivors: [] }, 0);
    expect(data.score).toBeNull();
    // minScore 0 and score null: a suite nothing ran against has not cleared
    // any bar, and `score >= 0` would have said it had.
    expect(data.passed).toBe(false);
  });
});

// ─── The focused single-test trial ───────────────────────────────────────────

describe('applyMutantToText', () => {
  const code = 'if (total > 100) {\n  throw new Error("too big");\n}\n';
  const edit: MutantEdit = {
    id: 'SWAP_BOUNDARY#1',
    operator: 'SWAP_BOUNDARY',
    filePath: 'src/calc.ts',
    line: 1,
    start: code.indexOf('>'),
    end: code.indexOf('>') + 1,
    original: '>',
    replacement: '>=',
  };

  it('replaces exactly the span it was given', () => {
    expect(applyMutantToText(code, edit)).toContain('if (total >= 100)');
  });

  /**
   * The offsets come from a different process, computed against a copy of the
   * file. If they have drifted, applying the edit anyway writes a corrupted
   * file into a tree a human owns — the one failure here that loses work rather
   * than merely reporting wrongly.
   */
  it('refuses when the expected text is not at the offsets', () => {
    expect(() => applyMutantToText(code, { ...edit, original: '<' })).toThrow(/expected/);
    expect(() => applyMutantToText('tiny', edit)).toThrow(/outside the source/);
    expect(() => applyMutantToText(code, { ...edit, start: -1 })).toThrow(/outside the source/);
  });
});

describe('trialDidNotRun', () => {
  it.each([
    'src/calc.ts(7,5): error TS2345: Argument of type string is not assignable',
    'SyntaxError: Unexpected token )',
    "Error: Cannot find module './calc.js'",
    'Error: No tests found',
    'ERROR: error during collection',
  ])('spots that the test never executed: %s', (line) => {
    expect(trialDidNotRun(`running\n${line}\ndone`)).not.toBeNull();
  });

  /**
   * The other direction is the one that matters: a real assertion failure must
   * NOT be mistaken for "never ran", or every genuine kill would be discarded.
   */
  it.each([
    'Expected: "90"\nReceived: "100"',
    '1) cart.spec.ts:8 › shows the discounted total ─ expect(locator).toHaveText',
    'AssertionError: expected 100 to be 90',
    'FAIL src/cart.test.ts > applies the discount',
  ])('does not mistake a real failure for a load error: %s', (output) => {
    expect(trialDidNotRun(output)).toBeNull();
  });
});

describe('runSingleTest', () => {
  it('reports a pass on exit 0 and a failure on anything else', async () => {
    const pass = await runSingleTest({
      test: { command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 },
      workspace: repoWorkspace,
    });
    expect(pass.passed).toBe(true);
    expect(pass.didNotRun).toBeNull();

    const fail = await runSingleTest({
      test: {
        command: process.execPath,
        args: ['-e', 'console.error("AssertionError: expected 100 to be 90");process.exit(1)'],
        timeoutSeconds: 30,
      },
      workspace: repoWorkspace,
    });
    expect(fail.passed).toBe(false);
    expect(fail.exitCode).toBe(1);
    expect(fail.didNotRun).toBeNull();
  });

  it('separates "the test failed" from "the test never ran"', async () => {
    const run = await runSingleTest({
      test: {
        command: process.execPath,
        args: ['-e', 'console.error("x.ts(1,1): error TS2322: nope");process.exit(1)'],
        timeoutSeconds: 30,
      },
      workspace: repoWorkspace,
    });
    expect(run.passed).toBe(false);
    expect(run.didNotRun).toContain('TS2322');
  });

  it('reports a missing binary rather than a failing test', async () => {
    const run = await runSingleTest({
      test: { command: 'qaai-no-such-test-runner', args: [], timeoutSeconds: 30 },
      workspace: repoWorkspace,
    });
    expect(run.spawnError).toBe('ENOENT');
    expect(run.passed).toBe(false);
  });

  it('passes the tenant their own secret and masks it out of the report', async () => {
    const run = await runSingleTest({
      test: {
        command: process.execPath,
        args: ['-e', 'console.log("token=" + process.env.APP_PASSWORD)'],
        secretNames: ['APP_PASSWORD'],
        timeoutSeconds: 30,
      },
      workspace: repoWorkspace,
      secrets: { APP_PASSWORD: 'hunter2-tenant-password' },
    });
    expect(run.passed).toBe(true);
    expect(run.output).toContain('token=');
    expect(run.output).not.toContain('hunter2-tenant-password');
  });

  it('runs in the workspace it was given', async () => {
    const run = await runSingleTest({
      test: {
        command: process.execPath,
        args: ['-e', 'require("fs").writeFileSync("qaai-single-marker","")'],
        timeoutSeconds: 30,
      },
      workspace: repoWorkspace,
    });

    expect(run.passed).toBe(true);
    expect(existsSync(join(repoWorkspace, 'qaai-single-marker'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'qaai-single-marker'))).toBe(false);
  });

  /*
   * `SingleTestCommand.cwd` has no schema behind it — it arrives from the
   * agent — so `join(workspace, cwd)` was the whole guard, and `../..` ran the
   * command outside the workspace. A refusal must never read as a pass: a
   * mutation gate takes a pass here as "the suite asserts this behaviour".
   */
  it('refuses a cwd that escapes the workspace, and spawns nothing', async () => {
    const run = await runSingleTest({
      test: {
        command: process.execPath,
        args: ['-e', 'require("fs").writeFileSync("qaai-escaped-marker","")'],
        cwd: '../..',
        timeoutSeconds: 30,
      },
      workspace: repoWorkspace,
    });

    expect(run.passed).toBe(false);
    expect(run.didNotRun).toMatch(/not inside the run workspace/);
    expect(run.exitCode).toBeNull();
    expect(existsSync(join(repoWorkspace, '..', '..', 'qaai-escaped-marker'))).toBe(false);
  });
});

describe('runFocusedMutantTrial', () => {
  const SOURCE = `export function total(items: Array<{ price: number }>): number {
  let sum = 0;
  for (const item of items) {
    sum = sum + item.price;
  }
  return sum;
}
`;

  let workspace = '';
  const REL = join('src', 'calc.ts');
  let file = '';

  /** The arithmetic swap: `sum + item.price` becomes `sum - item.price`. */
  function edit(over: Partial<MutantEdit> = {}): MutantEdit {
    const at = SOURCE.indexOf('sum + item.price') + 4;
    return {
      id: 'SWAP_ARITHMETIC#1',
      operator: 'SWAP_ARITHMETIC',
      filePath: REL,
      line: 4,
      start: at,
      end: at + 1,
      original: '+',
      replacement: '-',
      ...over,
    };
  }

  /** A "test" that fails when the source no longer adds — i.e. one that asserts. */
  const asserting = {
    command: process.execPath,
    args: [
      '-e',
      'const s=require("fs").readFileSync(process.argv[1],"utf8");' +
        'if(!s.includes("sum + item.price")){console.error("AssertionError: expected 30 to be 10");process.exit(1)}',
    ],
    timeoutSeconds: 30,
  };

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'qaai-mutation-trial-'));
    await mkdir(join(workspace, 'src'), { recursive: true });
    file = join(workspace, REL);
    await writeFile(file, SOURCE, 'utf8');
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('kills a mutant the test notices, and always puts the file back', async () => {
    const result = await runFocusedMutantTrial({
      mutant: edit(),
      code: SOURCE,
      test: { ...asserting, args: [...asserting.args, file] },
      workspace,
    });

    expect(result.outcome).toBe('KILLED');
    expect(result.reverted).toBe(true);
    // The revert is the part that touches a human's working tree.
    expect(await readFile(file, 'utf8')).toBe(SOURCE);
  });

  it('reports a survivor when the test passes with the behaviour broken', async () => {
    const result = await runFocusedMutantTrial({
      mutant: edit(),
      code: SOURCE,
      test: { command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutSeconds: 30 },
      workspace,
    });

    expect(result.outcome).toBe('SURVIVED');
    expect(result.why).toContain('still passed');
    expect(await readFile(file, 'utf8')).toBe(SOURCE);
  });

  /**
   * The false kill, which is the defect this whole section exists to prevent: a
   * mutant that does not compile makes the command exit non-zero, and reading
   * that as a kill would certify a test that asserts nothing.
   */
  it('does not call a compile error a kill', async () => {
    const result = await runFocusedMutantTrial({
      mutant: edit(),
      code: SOURCE,
      test: {
        command: process.execPath,
        args: [
          '-e',
          'console.error("src/calc.ts(4,11): error TS2365: operator - cannot be applied");process.exit(2)',
        ],
        timeoutSeconds: 30,
      },
      workspace,
    });

    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(result.outcome).not.toBe('KILLED');
    expect(result.why).toContain('never ran');
    expect(await readFile(file, 'utf8')).toBe(SOURCE);
  });

  it('is inconclusive and writes nothing when the expected text has moved', async () => {
    const result = await runFocusedMutantTrial({
      mutant: edit({ original: '*' }),
      code: SOURCE,
      test: asserting,
      workspace,
    });

    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(result.why).toContain('expected');
    expect(await readFile(file, 'utf8')).toBe(SOURCE);
  });

  it('is inconclusive when the file on disk is not the source the mutant came from', async () => {
    await writeFile(file, `// someone edited this file\n${SOURCE}`, 'utf8');
    const result = await runFocusedMutantTrial({
      mutant: edit(),
      code: SOURCE,
      test: asserting,
      workspace,
    });

    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(result.why).toContain('no longer matches');
  });

  it('refuses a path that escapes the workspace', async () => {
    const result = await runFocusedMutantTrial({
      mutant: edit({ filePath: join('..', 'outside.ts') }),
      code: SOURCE,
      test: asserting,
      workspace,
    });

    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(result.why).toContain('inside the workspace');
  });

  it('treats a hang as no evidence, and still reverts', async () => {
    const result = await runFocusedMutantTrial({
      mutant: edit(),
      code: SOURCE,
      test: {
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 30000)'],
        timeoutSeconds: 1,
      },
      workspace,
    });

    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(result.timedOut).toBe(true);
    expect(result.reverted).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(SOURCE);
  });

  it('does not run anything once the run has been cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runFocusedMutantTrial({
      mutant: edit(),
      code: SOURCE,
      test: asserting,
      workspace,
      signal: controller.signal,
    });

    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(result.why).toContain('cancelled');
    expect(await readFile(file, 'utf8')).toBe(SOURCE);
  });

  it('refuses a mutant that changes nothing instead of calling it a survivor', async () => {
    const result = await runFocusedMutantTrial({
      mutant: edit({ replacement: '+' }),
      code: SOURCE,
      test: asserting,
      workspace,
    });

    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(result.why).toContain('changes nothing');
  });
});

/*
 * THE LAST HOP. The score used to exist only inside a step title — a string, so
 * nothing could trend it or gate on it. `TestResult` now has five scalar
 * columns and a survivor table waiting for `execution.mutation`, and a plugin
 * that computes the score without attaching it leaves all of them null for
 * ever. These two tests are what notices if that line is ever dropped.
 */
describe('the metric channel', () => {
  it('attaches the score, the counts and the survivors as DATA, not just prose', async () => {
    const execution = await mutationPlugin.execute(
      makeContext(),
      makeTest({
        tool: 'go-mutesting',
        minScore: 50,
        ...fakeScript(
          `for(let i=0;i<3;i++)console.log('FAIL "/w/p.go.'+i+'" x');` +
            `console.log('The mutation score is 0.7 (7 passed, 3 failed, 0 duplicated, 1 skipped, total is 11)')`,
        ),
      }),
    );

    expect(execution.mutation).toBeDefined();
    expect(execution.mutation?.score).toBeCloseTo(70, 5);
    expect(execution.mutation?.detected).toBe(7);
    expect(execution.mutation?.undetected).toBe(3);
    expect(execution.mutation?.valid).toBe(10);
    expect(execution.mutation?.minScore).toBe(50);
    expect(execution.mutation?.passed).toBe(true);
    expect(execution.mutation?.survivors).toHaveLength(3);

    // And the prose still agrees with the number, because both are read off the
    // same record — which is the whole reason `mutationRunData` exists.
    expect(execution.steps[0]?.title).toContain('70.0%');
  });

  it('leaves it absent when nothing was measured, so null never becomes 0', async () => {
    // No valid mutant to judge. A 0 here would read as "every mutant survived"
    // — the worst possible result — rather than the absence of a result.
    const execution = await mutationPlugin.execute(
      makeContext(),
      makeTest({
        tool: 'go-mutesting',
        ...fakeTool([
          'The mutation score is 0.000000 (0 passed, 0 failed, 0 duplicated, 0 skipped, total is 0)',
        ]),
      }),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.mutation).toBeUndefined();
  });
});
