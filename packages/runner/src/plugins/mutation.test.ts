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
 */

import { describe, expect, it } from 'vitest';
import type { ArtifactSink, ExecutableTest, RunContext, StepStatus } from '@qaai/shared';
import {
  mutationPlugin,
  mutationScore,
  parseElementsJson,
  parseGoMutestingStdout,
  parseInfectionJson,
  parseMutantStdout,
  parseMutmutResults,
  parseMutmutStdout,
  parsePitXml,
} from './mutation.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

const artifacts: ArtifactSink = {
  put: async () => 'key',
  putFile: async () => 'key',
  get: async () => null,
  putPersistent: async () => 'key',
};

function makeContext(): RunContext & { logged: Array<{ title: string; status: StepStatus }> } {
  const logged: Array<{ title: string; status: StepStatus }> = [];
  return {
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
});
