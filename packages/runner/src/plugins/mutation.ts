/**
 * Mutation testing (§4 MUTATION).
 *
 * Every other plugin here tests the application. This one tests the TESTS: it
 * deliberately breaks the source — flips `>` to `>=`, drops a `!`, returns null
 * — and checks that the suite notices. It is the only honest answer to "is our
 * 90% coverage real?", because coverage counts lines executed, not assertions
 * that would fail. A line can be covered by a test that asserts nothing about
 * it, and mutation testing is the thing that says so out loud.
 *
 * QAAI drives the ecosystem's own mutation tool rather than implementing a
 * mutation engine — the same build-vs-buy call as k6 for load and Playwright
 * for E2E. Mutating source correctly is language-specific work these projects
 * have already done, and mutants from a home-grown engine are ones no reviewer
 * trusts.
 *
 * The headline is the mutation score. The actionable finding is the surviving
 * mutant: "we changed `>` to `>=` on line 42 and every test still passed" names
 * one missing assertion, so every survivor becomes its own step. Steps rather
 * than `findings`: a Finding is about the application (a11y, security), and a
 * surviving mutant is about the test suite. Filing it as a Finding would put
 * "your code is broken" next to something that says the opposite.
 *
 * Three deliberate choices about the numbers:
 *
 *  - The score is computed here from the tool's report, not scraped from the
 *    tool's own gate. Every one of these tools exits non-zero on a threshold
 *    breach, which is indistinguishable from the tool failing to start; QAAI
 *    asserts the threshold itself so those two cases report differently. Same
 *    reasoning as `load.ts` and its k6 thresholds.
 *
 *  - Mutants the tool could not build or run (compile errors, non-viable
 *    mutations, "suspicious" runs) are excluded from the denominator, never
 *    counted as killed. An inflated mutation score is worse than no score.
 *
 *  - An uncovered mutant counts against the score exactly like a survivor. It
 *    is the same defect — no test would have noticed — and hiding it behind a
 *    separate category is how a 90%-coverage suite scores well while asserting
 *    nothing.
 *
 * Security: the command is spawned WITHOUT a shell and args are passed as an
 * array, because a spec is org-authored data. `npx` is deliberately never used
 * to launch a tool — it would fetch and execute a package from the network
 * mid-run, and it would also hide a missing tool behind an install.
 */

import { spawn } from 'node:child_process';
import { constants as FS } from 'node:fs';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { maskSecrets, mutationTestSpecSchema } from '@qaai/shared';
import type {
  ConsoleEntry,
  ExecutableTest,
  MutationTestSpec,
  MutationTool,
  RunContext,
  RunnerPlugin,
  StepResult,
  TestExecution,
} from '@qaai/shared';
import { safeReportPath } from './external.js';

/** Captured output is kept as a TAIL: every stdout-parsed tool prints its summary last. */
const OUTPUT_LIMIT = 200_000;

/** How much tool output travels back with a failure message. */
const TAIL_LIMIT = 3_000;

/** Directories never worth walking when hunting for a timestamped report. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'obj', 'bin', 'vendor']);

// ─── The shape every tool's report is normalised into ────────────────────────

/** A mutant the suite did not catch — the actionable half of a mutation run. */
export interface SurvivingMutant {
  file: string;
  line: number | null;
  /** The mutation operator: `ArithmeticOperator`, `ConditionalsBoundary`, … */
  mutator: string;
  /** What the tool says it changed, when it says. */
  detail: string | null;
  /** `no-coverage` is a survivor no test even executed. */
  reason: 'survived' | 'no-coverage';
}

export interface MutationReport {
  /** Mutants the suite killed, including ones it killed by timing out. */
  detected: number;
  /** Mutants that lived: survived outright, or were never covered. */
  undetected: number;
  /** Mutants that never ran — compile errors, non-viable mutations. Not scored. */
  excluded: number;
  survivors: SurvivingMutant[];
}

function emptyReport(): MutationReport {
  return { detected: 0, undetected: 0, excluded: 0, survivors: [] };
}

/**
 * Killed / valid. Null when the tool produced no valid mutant to judge.
 *
 * Exported, like the readers below, because the score arithmetic is the part of
 * this plugin that must not be wrong: a mutation score that silently counts a
 * compile error as a kill reads as a healthy suite. Same reason external.ts
 * exports `parseJUnit`.
 */
export function mutationScore(report: MutationReport): number | null {
  const valid = report.detected + report.undetected;
  return valid === 0 ? null : (report.detected / valid) * 100;
}

// ─── Report readers ──────────────────────────────────────────────────────────
//
// A reader returns everything it could make sense of and skips what it could
// not; it never guesses. Truly malformed input (JSON that does not parse) is
// allowed to throw, because `execute` catches it and reports a reporting
// problem — which is very different from returning an empty report, since an
// empty report would read as "no mutants" and quietly hide a corrupt file.
// What must never happen is a reporting problem losing the run.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clip(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * The mutation-testing-elements JSON schema. Stryker and Stryker.NET both emit
 * it, and it is the closest thing this space has to a standard — so a tool that
 * adopts it later needs no new reader here.
 */
const ELEMENTS_DETECTED = new Set(['Killed', 'Timeout']);
const ELEMENTS_UNDETECTED = new Set(['Survived', 'NoCoverage']);

export function parseElementsJson(text: string): MutationReport {
  const report = emptyReport();
  const doc: unknown = JSON.parse(text);
  const files = isRecord(doc) && isRecord(doc.files) ? doc.files : {};

  for (const [path, entry] of Object.entries(files)) {
    if (!isRecord(entry)) continue;
    for (const raw of asArray(entry.mutants)) {
      if (!isRecord(raw)) continue;
      const status = typeof raw.status === 'string' ? raw.status : '';

      if (ELEMENTS_DETECTED.has(status)) {
        report.detected += 1;
        continue;
      }
      if (!ELEMENTS_UNDETECTED.has(status)) {
        report.excluded += 1;
        continue;
      }

      report.undetected += 1;
      const start =
        isRecord(raw.location) && isRecord(raw.location.start) ? raw.location.start : null;
      const replacement = typeof raw.replacement === 'string' ? raw.replacement : null;
      report.survivors.push({
        file: path,
        line: start && typeof start.line === 'number' ? start.line : null,
        mutator: typeof raw.mutatorName === 'string' ? raw.mutatorName : 'mutant',
        detail: replacement ? `replaced with ${clip(replacement)}` : null,
        reason: status === 'NoCoverage' ? 'no-coverage' : 'survived',
      });
    }
  }
  return report;
}

/**
 * PIT's `mutations.xml`.
 *
 * A regex pass rather than an XML parser, for the same reason `parseJUnit` in
 * external.ts is one: the surface is one element with one attribute and a
 * handful of text children, and adding an XML dependency to the runner for it
 * would be more risk than the parsing is worth.
 */
const PIT_DETECTED = new Set(['KILLED', 'TIMED_OUT', 'MEMORY_ERROR']);
const PIT_UNDETECTED = new Set(['SURVIVED', 'NO_COVERAGE']);

function pitChild(body: string, name: string): string {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim() ?? '';
}

export function parsePitXml(xml: string): MutationReport {
  const report = emptyReport();

  for (const match of xml.matchAll(/<mutation\b([^>]*)>([\s\S]*?)<\/mutation>/g)) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    const status = (/\bstatus=["']([A-Z_]+)["']/.exec(attrs)?.[1] ?? '').toUpperCase();

    if (PIT_DETECTED.has(status)) {
      report.detected += 1;
      continue;
    }
    if (!PIT_UNDETECTED.has(status)) {
      // NON_VIABLE and RUN_ERROR mutants never really ran. Not scored.
      report.excluded += 1;
      continue;
    }

    report.undetected += 1;
    const line = Number(pitChild(body, 'lineNumber'));
    const method = pitChild(body, 'mutatedMethod');
    const description = pitChild(body, 'description');
    report.survivors.push({
      file: pitChild(body, 'mutatedClass') || pitChild(body, 'sourceFile') || 'unknown',
      line: Number.isFinite(line) && line > 0 ? line : null,
      mutator: pitChild(body, 'mutator').split('.').pop() || 'mutant',
      detail: [description, method ? `in ${method}()` : ''].filter(Boolean).join(' ') || null,
      reason: status === 'NO_COVERAGE' ? 'no-coverage' : 'survived',
    });
  }
  return report;
}

/** Infection's `--logger-json` file. Its `stats.msi` is the score; the arrays are the detail. */
export function parseInfectionJson(text: string): MutationReport {
  const report = emptyReport();
  const doc: unknown = JSON.parse(text);
  if (!isRecord(doc)) return report;

  const escaped = asArray(doc.escaped);
  const notCovered = asArray(isRecord(doc) && 'notCovered' in doc ? doc.notCovered : doc.uncovered);

  for (const [list, reason] of [
    [escaped, 'survived'],
    [notCovered, 'no-coverage'],
  ] as const) {
    for (const raw of list) {
      if (!isRecord(raw)) continue;
      const m = isRecord(raw.mutator) ? raw.mutator : {};
      report.survivors.push({
        file: typeof m.originalFilePath === 'string' ? m.originalFilePath : 'unknown',
        line: typeof m.originalStartLine === 'number' ? m.originalStartLine : null,
        mutator: typeof m.mutatorName === 'string' ? m.mutatorName : 'mutant',
        detail: typeof m.mutatedSourceCode === 'string' ? clip(m.mutatedSourceCode) : null,
        reason,
      });
    }
  }

  const stats = isRecord(doc.stats) ? doc.stats : {};
  report.detected = num(stats.killedCount) + num(stats.timeOutCount);
  report.undetected = num(stats.escapedCount) + num(stats.notCoveredCount);
  report.excluded =
    num(stats.errorCount) +
    num(stats.syntaxErrorCount) +
    num(stats.skippedCount) +
    num(stats.ignoredCount);

  // Older logs omit `stats`; the arrays are then the only truth available.
  if (report.detected + report.undetected === 0) {
    report.detected = asArray(doc.killed).length + asArray(doc.timeouted).length;
    report.undetected = escaped.length + notCovered.length;
    report.excluded = asArray(doc.errored).length + asArray(doc.syntaxErrors).length;
  }
  return report;
}

/** Last match of a repeated counter — progress lines reprint the legend each tick. */
function lastCount(text: string, pattern: RegExp): number | null {
  let found: number | null = null;
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) found = value;
  }
  return found;
}

/**
 * mutmut has no machine-readable report, so its progress legend is the report:
 * `🎉 20  🫥 0  ⏰ 0  🤔 0  🙁 4  🔇 0`. Surviving mutant IDs come from a
 * follow-up `mutmut results`, which re-reads the cache and runs nothing.
 */
export function parseMutmutStdout(out: string): MutationReport | null {
  const killed = lastCount(out, /🎉\s*(\d+)/g);
  const timeout = lastCount(out, /⏰\s*(\d+)/g);
  const survived = lastCount(out, /🙁\s*(\d+)/g);
  const noTests = lastCount(out, /🫥\s*(\d+)/g);
  const suspicious = lastCount(out, /🤔\s*(\d+)/g);
  const skipped = lastCount(out, /🔇\s*(\d+)/g);

  if (killed === null && survived === null) return null;

  return {
    // A timeout means the suite reacted to the mutant, so mutmut counts it killed.
    detected: (killed ?? 0) + (timeout ?? 0),
    // "no tests" is an uncovered mutant, which is a survivor by another name.
    undetected: (survived ?? 0) + (noTests ?? 0),
    // "suspicious" means the run itself misbehaved — no verdict either way.
    excluded: (suspicious ?? 0) + (skipped ?? 0),
    survivors: [],
  };
}

/**
 * mutmut 3 names each mutant `<module>.x_<function>__mutmut_<n>`. Splitting it
 * back into a file and a function makes the step point somewhere a person can
 * open; the full name stays in the detail because it is the argument
 * `mutmut show` wants.
 */
function parseMutmutName(name: string): { file: string; func: string } {
  const parts = name.split('.');
  const last = parts.at(-1) ?? name;
  return {
    file: parts.length < 2 ? name : `${parts.slice(0, -1).join('/')}.py`,
    func: /^x_(.+?)__mutmut_\d+$/.exec(last)?.[1] ?? 'mutmut',
  };
}

/**
 * `mutmut results`, in both shapes the tool has shipped.
 *
 * mutmut 2 groups ids by file under a section header:
 *
 *     Survived 🙁 (3)
 *     ---- src/cart.py (3) ----
 *     3, 7, 12
 *
 * mutmut 3 (verified against 3.3.1) prints one line per mutant instead:
 *
 *     calc.x_is_big__mutmut_1: no tests
 *     calc.x_add__mutmut_1: survived
 *
 * Only survivors are collected. "killed", "timeout" and "suspicious" mutants
 * are not holes in the suite, and listing them would cost the reader a hunt for
 * nothing. "no tests" IS a hole — it is an uncovered mutant by another name.
 */
export function parseMutmutResults(out: string): SurvivingMutant[] {
  const survivors: SurvivingMutant[] = [];
  let inSurvived = false;
  let file = 'unknown';

  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    // mutmut 3: "<mutant name>: <status>".
    const entry = /^(\S+):\s*(survived|no tests)$/i.exec(line);
    if (entry?.[1]) {
      const name = entry[1];
      const { file: named, func } = parseMutmutName(name);
      survivors.push({
        file: named,
        line: null,
        mutator: func,
        detail: `mutant ${name}`,
        reason: /no tests/i.test(entry[2] ?? '') ? 'no-coverage' : 'survived',
      });
      continue;
    }

    // mutmut 2: a section header — "Survived 🙁 (3)", "Timeout ⏰ (0)".
    const section = /^([A-Za-z][A-Za-z ]*?)\s*\S*\s*\(\d+\)$/.exec(line);
    if (section && !line.startsWith('-')) {
      inSurvived = /^survived/i.test(section[1] ?? '');
      continue;
    }
    if (!inSurvived) continue;

    const header = /^-+\s*(.+?)\s*(?:\(\d+\))?\s*-+$/.exec(line);
    if (header?.[1]) {
      file = header[1];
      continue;
    }

    for (const id of line.split(',')) {
      const trimmed = id.trim();
      if (!trimmed) continue;
      survivors.push({
        file,
        line: null,
        mutator: 'mutmut',
        detail: `mutant ${trimmed}`,
        reason: 'survived',
      });
    }
  }
  return survivors;
}

/** mutant (Ruby) prints a summary block; alive mutants are the `evil:` lines. */
export function parseMutantStdout(out: string): MutationReport | null {
  const read = (pattern: RegExp): number | null => {
    const raw = pattern.exec(out)?.[1];
    return raw === undefined ? null : Number(raw);
  };
  const mutations = read(/^\s*Mutations:\s+(\d+)\s*$/m);
  const alive = read(/^\s*Alive:\s+(\d+)\s*$/m);
  if (mutations === null || alive === null) return null;

  const kills = read(/^\s*Kills:\s+(\d+)\s*$/m);
  const detected = kills ?? Math.max(0, mutations - alive);

  const survivors: SurvivingMutant[] = [];
  const seen = new Set<string>();
  for (const match of out.matchAll(/^evil:(\S+)/gm)) {
    const subject = match[1];
    if (!subject || seen.has(subject)) continue;
    seen.add(subject);
    survivors.push({
      file: subject,
      line: null,
      mutator: 'mutant',
      detail: null,
      reason: 'survived',
    });
  }

  return {
    detected,
    undetected: alive,
    excluded: Math.max(0, mutations - alive - detected),
    survivors: survivors.slice(0, alive || survivors.length),
  };
}

/**
 * go-mutesting prints one line per mutant and a score line at the end. Its
 * "passed" means the mutant was caught, so passed → killed and failed → alive.
 */
export function parseGoMutestingStdout(out: string): MutationReport | null {
  const summary =
    /mutation score is\s+[0-9.]+\s*\((\d+)\s+passed,\s*(\d+)\s+failed(?:,\s*(\d+)\s+duplicated)?(?:,\s*(\d+)\s+skipped)?/i.exec(
      out,
    );
  if (!summary) return null;

  const survivors: SurvivingMutant[] = [];
  for (const match of out.matchAll(/^FAIL\s+"?([^"\n]+)"?/gm)) {
    const path = (match[1] ?? '').trim();
    if (!path) continue;
    const index = /\.(\d+)$/.exec(path)?.[1] ?? null;
    survivors.push({
      file: path.replace(/\.\d+$/, ''),
      line: null,
      mutator: 'go-mutesting',
      detail: index ? `mutant #${index}` : null,
      reason: 'survived',
    });
  }

  return {
    detected: Number(summary[1] ?? 0),
    undetected: Number(summary[2] ?? 0),
    excluded: Number(summary[3] ?? 0) + Number(summary[4] ?? 0),
    survivors,
  };
}

// ─── Per-tool adapters ───────────────────────────────────────────────────────

interface ToolAdapter {
  /** The executable, resolved on PATH when no local binary is found. */
  bin: string;
  /**
   * Project-local binaries that beat PATH. Deliberately not `npx`/`bundle exec`:
   * both can install or resolve a *different* tool at run time, and a missing
   * tool must surface as SKIPPED rather than as a surprise download.
   */
  localBins: string[];
  argv: (spec: MutationTestSpec, reportPath: string | null) => string[];
  /** Where the tool writes its report, relative to `cwd`. Null = stdout only. */
  reportPath: string | null;
  /** Set when the tool writes into a timestamped directory rather than a file. */
  reportFile?: string;
  /** Shown when the tool is missing. Always a command the user can paste. */
  install: string;
  /**
   * Output that means "this tool is not installed" even though the process
   * started. `mvn` exists but has never heard of PIT; `dotnet` exists but the
   * Stryker global tool is not installed. Both are configuration gaps, and
   * reporting them as failures would blame the application under test.
   */
  missingSignals: RegExp[];
  parseReport?: (text: string) => MutationReport;
  parseStdout?: (out: string) => MutationReport | null;
  /**
   * Turns `scope` into flags when the right flag depends on which version of
   * the tool is installed. `probe` runs the tool with the given args — help
   * output, no tests — so the CLI itself answers instead of a guess from a
   * version string. Returning `skip` refuses the run: silently dropping the
   * scope would mutate the whole repository instead of one module, which is
   * hours of worker time nobody asked for.
   */
  scopeArgs?: (
    probe: (args: string[]) => Promise<CommandResult>,
    scope: string[],
  ) => Promise<{ args: string[] } | { skip: string }>;
}

const ADAPTERS: Record<MutationTool, ToolAdapter> = {
  stryker: {
    bin: 'stryker',
    localBins: ['node_modules/.bin/stryker'],
    argv: (spec) => [
      'run',
      '--reporters',
      'json,progress',
      ...(spec.scope.length ? ['--mutate', spec.scope.join(',')] : []),
    ],
    reportPath: 'reports/mutation/mutation.json',
    install: 'npm install --save-dev @stryker-mutator/core',
    missingSignals: [],
    parseReport: parseElementsJson,
  },

  'stryker-net': {
    bin: 'dotnet',
    localBins: [],
    argv: (spec) => [
      'stryker',
      '--reporter',
      'json',
      ...spec.scope.flatMap((s) => ['--mutate', s]),
    ],
    // Stryker.NET writes StrykerOutput/<timestamp>/reports/mutation-report.json.
    reportPath: 'StrykerOutput',
    reportFile: 'mutation-report.json',
    install: 'dotnet tool install --global dotnet-stryker',
    missingSignals: [
      /Could not execute because the specified command or file was not found/i,
      /No executable found matching command ["']?dotnet-stryker/i,
    ],
    parseReport: parseElementsJson,
  },

  pit: {
    bin: 'mvn',
    localBins: ['mvnw'],
    argv: (spec) => [
      '-B',
      'org.pitest:pitest-maven:mutationCoverage',
      '-DoutputFormats=XML',
      // Without this PIT writes target/pit-reports/<timestamp>/, and the report
      // path stops being predictable.
      '-DtimestampedReports=false',
      ...(spec.scope.length ? [`-DtargetClasses=${spec.scope.join(',')}`] : []),
    ],
    reportPath: 'target/pit-reports/mutations.xml',
    install: 'brew install maven (PIT itself is fetched by Maven as org.pitest:pitest-maven)',
    missingSignals: [
      /Cannot resolve plugin org\.pitest/i,
      /Plugin org\.pitest:pitest-maven[^\n]*could not be resolved/i,
      /No plugin found for prefix ['"]?pitest/i,
    ],
    parseReport: parsePitXml,
  },

  mutmut: {
    bin: 'mutmut',
    localBins: [],
    argv: () => ['run'],
    reportPath: null,
    install: 'pip install mutmut',
    missingSignals: [],
    parseStdout: parseMutmutStdout,
    /**
     * mutmut 2 narrows with `--paths-to-mutate`. mutmut 3 removed the flag and
     * reads `paths_to_mutate` from setup.cfg instead — verified against 3.3.1,
     * which exits immediately with "No such option". Passing the flag blind
     * turns a scoped run into an error, and dropping it turns a scoped run into
     * a whole-repo one, so the CLI is asked which one it is.
     */
    scopeArgs: async (probe, scope) => {
      const help = await probe(['run', '--help']);
      if (help.spawnError !== null) return { args: [] }; // the real run reports the missing tool
      if (`${help.stdout}${help.stderr}`.includes('--paths-to-mutate')) {
        return { args: ['--paths-to-mutate', scope.join(',')] };
      }
      return {
        skip: `This mutmut has no --paths-to-mutate flag (mutmut 3 moved it into config), so \`scope\` could not be applied and QAAI did not mutate the whole project instead. Set paths_to_mutate=${scope.join(',')} under [mutmut] in setup.cfg, then clear \`scope\`.`,
      };
    },
  },

  mutant: {
    bin: 'mutant',
    localBins: ['bin/mutant'],
    argv: (spec) => ['run', ...(spec.scope.length ? ['--', ...spec.scope] : [])],
    reportPath: null,
    install: 'gem install mutant mutant-rspec',
    missingSignals: [],
    parseStdout: parseMutantStdout,
  },

  'go-mutesting': {
    bin: 'go-mutesting',
    localBins: [],
    argv: (spec) => (spec.scope.length ? [...spec.scope] : ['./...']),
    reportPath: null,
    install: 'go install github.com/zimmski/go-mutesting/cmd/go-mutesting@latest',
    missingSignals: [],
    parseStdout: parseGoMutestingStdout,
  },

  infection: {
    bin: 'infection',
    localBins: ['vendor/bin/infection'],
    argv: (spec, reportPath) => [
      '--no-progress',
      '--no-interaction',
      '--threads=max',
      `--logger-json=${reportPath ?? 'infection.json'}`,
      ...(spec.scope.length ? [`--filter=${spec.scope.join(',')}`] : []),
    ],
    reportPath: 'infection.json',
    install: 'composer require --dev infection/infection',
    missingSignals: [],
    parseReport: parseInfectionJson,
  },
};

// ─── Process plumbing ────────────────────────────────────────────────────────

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError: string | null;
  timedOut: boolean;
}

/** Keeps the newest output, because every stdout-parsed tool summarises last. */
function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > OUTPUT_LIMIT ? next.slice(next.length - OUTPUT_LIMIT) : next;
}

function runCommand(opts: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<CommandResult> {
  return new Promise<CommandResult>((done) => {
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      // Never a shell: the spec is data, and interpolation here would be RCE.
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout.on('data', (b: Buffer) => {
      stdout = appendTail(stdout, b.toString());
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr = appendTail(stderr, b.toString());
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Mutation runners spawn a test runner per mutant; a polite SIGTERM can
      // leave the parent waiting on children, so escalate rather than hang.
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, opts.timeoutMs);

    const onAbort = () => child.kill('SIGTERM');
    opts.signal.addEventListener('abort', onAbort, { once: true });

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      done(result);
    };

    child.on('error', (err) =>
      finish({
        code: null,
        stdout,
        stderr,
        spawnError: (err as NodeJS.ErrnoException).code ?? err.message,
        timedOut,
      }),
    );
    child.on('close', (code) => finish({ code, stdout, stderr, spawnError: null, timedOut }));
  });
}

/** A project-local binary if there is one, otherwise the bare name for PATH lookup. */
async function resolveCommand(cwd: string, adapter: ToolAdapter): Promise<string> {
  for (const rel of adapter.localBins) {
    const candidate = join(cwd, rel);
    try {
      await access(candidate, FS.X_OK);
      return candidate;
    } catch {
      /* try the next candidate, then PATH */
    }
  }
  return adapter.bin;
}

/** Newest file with this name under `root`. Stryker.NET nests reports by timestamp. */
async function findNewest(root: string, fileName: string, depth = 4): Promise<string | null> {
  if (depth < 0) return null;

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  let best: { path: string; at: number } | null = null;
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const nested = await findNewest(full, fileName, depth - 1);
      if (!nested) continue;
      const at = (await stat(nested).catch(() => null))?.mtimeMs ?? 0;
      if (!best || at > best.at) best = { path: nested, at };
    } else if (entry.name === fileName) {
      const at = (await stat(full).catch(() => null))?.mtimeMs ?? 0;
      if (!best || at > best.at) best = { path: full, at };
    }
  }
  return best?.path ?? null;
}

/** Reads the tool's report, following a directory to the newest matching file. */
async function readReport(
  cwd: string,
  relPath: string,
  fileName: string | undefined,
): Promise<string | null> {
  let full: string;
  try {
    full = safeReportPath(cwd, relPath);
  } catch {
    return null;
  }

  const info = await stat(full).catch(() => null);
  if (info?.isDirectory()) {
    if (!fileName) return null;
    const found = await findNewest(full, fileName);
    return found === null ? null : readFile(found, 'utf8').catch(() => null);
  }
  return readFile(full, 'utf8').catch(() => null);
}

// ─── Steps ───────────────────────────────────────────────────────────────────

function makeStep(
  index: number,
  title: string,
  status: StepResult['status'],
  error: StepResult['error'] = null,
): StepResult {
  return {
    index,
    title,
    status,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    screenshotKey: null,
    error,
  };
}

function survivorStep(index: number, mutant: SurvivingMutant): StepResult {
  const where = mutant.line === null ? mutant.file : `${mutant.file}:${mutant.line}`;
  const uncovered = mutant.reason === 'no-coverage';

  return makeStep(
    index,
    `${where} — ${mutant.mutator} ${uncovered ? 'never covered' : 'survived'}`,
    'FAILED',
    {
      message: uncovered
        ? `No test executes this code, so the ${mutant.mutator} mutation could not be caught.${
            mutant.detail ? ` ${mutant.detail}.` : ''
          }`
        : `The ${mutant.mutator} mutation was applied and every test still passed.${
            mutant.detail ? ` ${mutant.detail}.` : ''
          }`,
      stack: null,
      selector: null,
      expected: uncovered ? 'a test that executes this code' : 'at least one test to fail',
      actual: uncovered ? 'no test reaches it' : 'all tests passed',
    },
  );
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export const mutationPlugin: RunnerPlugin = {
  type: 'MUTATION',

  validate(test: ExecutableTest): void {
    const parsed = mutationTestSpecSchema.safeParse(test.spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`Mutation test "${test.name}" has an invalid spec — ${issues}`);
    }
  },

  async execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const spec = mutationTestSpecSchema.parse(test.spec);
    const adapter = ADAPTERS[spec.tool];
    const startedAt = Date.now();
    const workspace = process.cwd();
    const cwd = join(workspace, spec.cwd);
    const secretValues = Object.values(ctx.secrets);

    const base: Omit<TestExecution, 'status' | 'steps' | 'errorMessage'> = {
      testId: test.id,
      durationMs: 0,
      network: [],
      console: [],
      videoKey: null,
      traceKey: null,
      retriedAndPassed: false,
      findings: [],
    };
    const finish = (
      status: TestExecution['status'],
      steps: StepResult[],
      errorMessage: string | null,
      consoleLog: ConsoleEntry[] = [],
    ): TestExecution => ({
      ...base,
      status,
      durationMs: Date.now() - startedAt,
      steps,
      console: consoleLog,
      errorMessage:
        errorMessage === null ? null : maskSecrets(errorMessage, secretValues).slice(0, 2000),
    });

    // Only the secrets the spec asks for, so a test cannot vacuum the whole
    // vault into a third-party process's environment.
    const exposed: Record<string, string> = {};
    for (const name of spec.secretNames) {
      const value = ctx.secrets[name];
      if (value !== undefined) exposed[name] = value;
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...spec.env,
      ...exposed,
      QAAI_BASE_URL: ctx.baseUrl,
      CI: '1',
    };

    const relReport = spec.reportPath ?? adapter.reportPath;
    const command = spec.command ?? (await resolveCommand(cwd, adapter));

    // A scope flag that depends on the installed version is settled before the
    // run, by asking the tool. See `ToolAdapter.scopeArgs`.
    let scopeArgs: string[] = [];
    if (!spec.command && adapter.scopeArgs && spec.scope.length > 0) {
      const decided = await adapter.scopeArgs(
        (probeArgs) =>
          runCommand({ command, args: probeArgs, cwd, env, timeoutMs: 30_000, signal: ctx.signal }),
        spec.scope,
      );
      if ('skip' in decided) return finish('SKIPPED', [], decided.skip);
      scopeArgs = decided.args;
    }

    const args = spec.command
      ? spec.args
      : [...adapter.argv(spec, relReport), ...scopeArgs, ...spec.extraArgs];

    const result = await runCommand({
      command,
      args,
      cwd,
      env,
      timeoutMs: spec.timeoutSeconds * 1000,
      signal: ctx.signal,
    });

    const output = `${result.stdout}\n${result.stderr}`;
    const tail = maskSecrets(output.slice(-TAIL_LIMIT).trim(), secretValues);

    // A missing tool is a configuration gap, not a failing test. Reporting it as
    // FAILED would blame the application under test for the worker's setup.
    if (result.spawnError !== null) {
      const why =
        result.spawnError === 'ENOENT'
          ? `\`${command}\` is not installed on this worker`
          : `\`${command}\` could not be started (${result.spawnError})`;
      return finish(
        'SKIPPED',
        [],
        `${why}, so no mutants were run and the suite was not evaluated. Install it with: ${adapter.install}`,
      );
    }

    if (adapter.missingSignals.some((re) => re.test(output))) {
      return finish(
        'SKIPPED',
        [],
        `${spec.tool} is not available on this worker, so no mutants were run. Install it with: ${adapter.install}`,
      );
    }

    if (ctx.signal.aborted) {
      return finish('SKIPPED', [], 'The run was cancelled before the mutation run finished.');
    }

    // A partial report would be scored over whichever mutants happened to run
    // first, which is a number worth less than none — so a timeout reports a
    // timeout, and says how to make the run fit.
    if (result.timedOut) {
      return finish(
        'TIMED_OUT',
        [],
        `${spec.tool} exceeded ${spec.timeoutSeconds}s and was stopped. Mutation runs rerun the suite once per mutant — narrow \`scope\` to one module or raise \`timeoutSeconds\`.`,
      );
    }

    // Reading the report must never lose the run, so every parser call is
    // guarded: a reporting problem is reported, not thrown.
    let report: MutationReport | null = null;
    let reportProblem: string | null = null;
    try {
      if (relReport && adapter.parseReport) {
        const text = await readReport(cwd, relReport, adapter.reportFile);
        if (text !== null && text.trim() !== '') report = adapter.parseReport(text);
      }
      if (report === null && adapter.parseStdout) report = adapter.parseStdout(output);
    } catch (err) {
      reportProblem = err instanceof Error ? err.message : String(err);
    }

    if (report === null) {
      const where = relReport ? ` at ${relReport}` : ' in its output';
      const why = reportProblem
        ? `${spec.tool}'s report${where} could not be read: ${reportProblem}`
        : `${spec.tool} produced no readable report${where} — point \`reportPath\` at the file it writes`;
      // Exit 0 with no report means the tool ran and wrote nowhere we looked —
      // a configuration gap, not evidence about the suite. Same call external.ts
      // makes, and the same reason: never invent a pass or a failure.
      return finish(
        result.code === 0 ? 'SKIPPED' : 'FAILED',
        [],
        result.code === 0 ? `${why}.` : `${why}. The tool exited ${result.code}. ${tail}`,
      );
    }

    // mutmut keeps its results in a cache rather than a report file. `mutmut
    // results` re-reads that cache and runs nothing, so the survivor list costs
    // a process spawn and no test time. Best-effort: no detail is a worse
    // report, not a failed run.
    if (spec.tool === 'mutmut' && report.undetected > 0 && report.survivors.length === 0) {
      const listing = await runCommand({
        command,
        args: ['results'],
        cwd,
        env,
        timeoutMs: 60_000,
        signal: ctx.signal,
      }).catch(() => null);
      if (listing && listing.spawnError === null && !listing.timedOut) {
        try {
          report.survivors = parseMutmutResults(listing.stdout);
        } catch {
          /* the score still stands without the listing */
        }
      }
    }

    const score = mutationScore(report);

    if (score === null) {
      return finish(
        'SKIPPED',
        [],
        `${spec.tool} generated no runnable mutants${
          report.excluded > 0 ? ` (${report.excluded} could not be built or run)` : ''
        }, so the suite was not evaluated. Check \`scope\` — it may not match any source file.`,
      );
    }

    const valid = report.detected + report.undetected;
    const gatePassed = score >= spec.minScore;

    // The threshold decides the test's verdict; a surviving mutant is a FAILED
    // step regardless. A run at 85% against a 60% bar therefore passes with red
    // steps under it, and that is the honest rendering: the suite cleared the
    // bar you set, and here are the specific assertions it is still missing.
    const steps: StepResult[] = [
      makeStep(
        0,
        `Mutation score ${score.toFixed(1)}% — ${report.detected} of ${valid} mutants killed (minimum ${spec.minScore}%)`,
        gatePassed ? 'PASSED' : 'FAILED',
        gatePassed
          ? null
          : {
              message: `The suite killed ${report.detected} of ${valid} mutants. ${report.undetected} survived, which means changes to the source that no test objects to.`,
              stack: null,
              selector: null,
              expected: `at least ${spec.minScore}%`,
              actual: `${score.toFixed(1)}%`,
            },
      ),
    ];

    const shown = report.survivors.slice(0, spec.maxSurvivorsReported);
    for (const mutant of shown) steps.push(survivorStep(steps.length, mutant));

    if (report.survivors.length > shown.length) {
      steps.push(
        makeStep(
          steps.length,
          `… and ${report.survivors.length - shown.length} more surviving mutants (raise maxSurvivorsReported to list them)`,
          'SKIPPED',
        ),
      );
    }

    // The count comes from the score, the list from the report; when a tool
    // gives a number without the detail, say so rather than implying the
    // survivors were all listed above.
    if (report.undetected > 0 && report.survivors.length === 0) {
      steps.push(
        makeStep(
          steps.length,
          `${report.undetected} mutants survived — ${spec.tool} reported the count without naming them`,
          'FAILED',
          {
            message: `${spec.tool} did not list the surviving mutants in its output, so QAAI can only report the total. The score above is still the tool's own.`,
            stack: null,
            selector: null,
            expected: 'no surviving mutants',
            actual: `${report.undetected} survived`,
          },
        ),
      );
    }

    if (report.excluded > 0) {
      steps.push(
        makeStep(
          steps.length,
          `${report.excluded} mutants excluded from the score (not buildable or not runnable)`,
          'SKIPPED',
        ),
      );
    }

    for (const step of steps) {
      ctx.logger.step({
        testId: test.id,
        index: step.index,
        title: step.title,
        status: step.status,
      });
    }

    const worst = shown[0];
    return finish(
      gatePassed ? 'PASSED' : 'FAILED',
      steps,
      gatePassed
        ? null
        : `Mutation score ${score.toFixed(1)}% is below the ${spec.minScore}% minimum — ${report.undetected} of ${valid} mutants survived.${
            worst
              ? ` First: ${worst.file}${worst.line === null ? '' : `:${worst.line}`} (${worst.mutator}).`
              : ''
          }`,
      // The tool's own tail is worth keeping on a failure: it is where a
      // half-configured runner explains itself.
      gatePassed || tail === '' ? [] : [{ level: 'log', text: tail, at: new Date().toISOString() }],
    );
  },
};
