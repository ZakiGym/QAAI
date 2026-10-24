/**
 * The mutation admission gate — "prove this test would fail if the behaviour
 * broke, or you are not admitted".
 *
 * THE DEFECT THIS FILE EXISTS TO PREVENT
 *
 * A generated test that runs, passes, and asserts nothing. It is the single
 * most common failure of every AI test generator on the market, and it is
 * invisible to every check we had before this file: it compiles, it is green in
 * CI, it adds a line to the coverage number, and it will stay green through the
 * exact regression it was written to catch. "AI-written tests assert nothing"
 * is the objection that decides these deals, and the only answer to it that
 * cannot be argued with is a demonstration: we broke the behaviour this test
 * claims to check, and the test went red.
 *
 * So this gate does not read the test. It does not ask a model whether the
 * assertions look strong — a model's opinion about its own output is the thing
 * under suspicion. It mutates the source the test exercises and watches what
 * the test does. A test that notices is admitted. A test that notices nothing
 * is refused, and the mutation it failed to notice is handed back as the input
 * to the next generation attempt.
 *
 * WHY THE EXECUTION IS INJECTED
 *
 * `@qaai/agent` does not depend on `@qaai/runner` and must not: the agent runs
 * in the API process (and in unit tests with no browser, no workspace and no
 * test harness), while running a test means spawning a process inside a
 * materialised workspace. So the gate owns the JUDGEMENT — which mutations are
 * relevant, how many to try, what the result means, how to describe a survivor
 * — and takes the EXECUTION as a {@link MutationCapability} the worker
 * supplies. `packages/runner/src/plugins/mutation.ts` exports the focused
 * single-test trial that satisfies it.
 *
 * WHY UNAVAILABLE IS A FIRST-CLASS STATUS
 *
 * The failure mode that would destroy the value of this gate is a test that was
 * never checked looking like a test that passed. No capability, no source file,
 * a language whose operators are not implemented, a test that was already
 * failing before we touched anything, every trial timing out: all of those are
 * UNAVAILABLE with a `why` that names the reason. None of them is PASS.
 *
 * No model is called from this file. The gate must work with no API key,
 * because it is the thing that decides whether the model's output is worth
 * keeping.
 */

import type { GateOutcome } from './admission.js';

// ─── Tunables ────────────────────────────────────────────────────────────────
//
// Exported constants rather than environment variables: `scripts/check-wiring.ts`
// refuses an undocumented env var, and a bar that can be lowered per deployment
// is a bar that gets lowered the first time it is inconvenient. Changing one of
// these is a code change with a reviewer.

/**
 * Trials per test. Each trial is a FULL test execution — for an E2E test that
 * is a browser launch, a login and a navigation, so 5 trials is roughly 2-3
 * minutes of worker time for one generated test. That is the ceiling a
 * generation loop can absorb; past it, admission costs more than generation.
 */
export const MUTATION_GATE_MAX_TRIALS = 5;

/**
 * The bar, as killed / conclusive-trials. 0.5 and not higher, deliberately: a
 * test that notices half of the relevant ways its behaviour can break is
 * already better than most hand-written tests, and a bar that refuses those
 * would make the gate the reason nothing ever ships. The asymmetry is the whole
 * point — see {@link mutationGate} for why zero kills is categorically
 * different from a low ratio.
 */
export const MUTATION_GATE_PASS_RATIO = 0.5;

/**
 * Stop trialling once this many mutants have been killed.
 *
 * Not 1. One kill can be an accident: a mutant that makes the page 500 kills
 * every test that loads the page, including one that asserts nothing beyond
 * "the response was 200". Two independent kills is a much harder thing to do by
 * accident, and the second trial costs 20% of the budget.
 */
export const MUTATION_GATE_SETTLE_KILLS = 2;

/**
 * Stop trialling once this many DECISIVE mutants have survived with no kill.
 *
 * Three changes to the behaviour the test claims to check, none of them
 * noticed, is enough to refuse admission. This early stop is not free of
 * meaning — two further trials might have produced a kill and turned FAIL into
 * WARN — so the outcome says out loud that it stopped early and how many
 * candidates went untried. A silent cap would read as "we checked everything".
 */
export const MUTATION_GATE_SETTLE_SURVIVORS = 3;

/**
 * Stop after this many trials that produced no verdict (threw, timed out, could
 * not be applied). A capability that is broken will not become less broken on
 * the fourth attempt, and burning the budget on it would turn an environment
 * problem into a FAIL against the test.
 */
export const MUTATION_GATE_MAX_INCONCLUSIVE = 2;

/**
 * The relevance floor a candidate mutant must clear to be worth a trial.
 *
 * This is the number that keeps the gate honest. Mutating code the test never
 * reaches produces a survivor that proves nothing about the test — and reported
 * as a survivor it is a FALSE ACCUSATION, which is how a gate becomes a liar
 * and then gets switched off. A candidate needs a real connection to what the
 * test asserts: a literal the test checks, an identifier it names, or an error
 * path it claims to exercise. Operator weight alone never reaches 3.
 */
export const MUTATION_GATE_MIN_RELEVANCE = 3;

/** Candidates generated before ranking. Beyond this the file is a bundle, not a module. */
export const MUTATION_GATE_MAX_CANDIDATES = 200;

/** Per-file scan ceiling. A larger "source file" is a build artifact. */
export const MUTATION_GATE_MAX_SOURCE_CHARS = 200_000;

/** Source files considered for one test. More than this is not a code path, it is a package. */
export const MUTATION_GATE_MAX_SOURCE_FILES = 10;

/**
 * Languages whose operators are implemented below.
 *
 * Deliberately narrow. Python's `not`/`and`/`or`, Ruby's `unless` and Go's
 * `:=` are not the same grammar, and a mutation generated with the wrong
 * grammar does not compile — which, if the runner mistook it for a test
 * failure, would be a FALSE KILL and a worthless test admitted with a
 * certificate. Anything not in this list is UNAVAILABLE, never PASS.
 */
export const MUTATION_GATE_SUPPORTED_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
] as const;

// ─── Contract ────────────────────────────────────────────────────────────────

/**
 * The mutation operators this gate generates, and the two classes they fall
 * into.
 *
 * DECISIVE operators change what the code DOES on the path the test walks. A
 * decisive mutant that survives is a hole in the test: the behaviour changed
 * and the test did not care.
 *
 * BOUNDARY operators change an edge the test may legitimately not exercise.
 * `price > 100` becoming `price >= 100` is invisible to a test whose fixture
 * price is 250 — and that test is not wrong, it is merely not a boundary test.
 * Reporting that as "your test asserts nothing" is the false accusation that
 * gets a gate disabled, so a boundary survivor is reported as a missing edge
 * case and cannot by itself produce a FAIL.
 */
export type MutationOperator =
  /** `if (cond)` → `if (!(cond))`. The guard runs when it should not. */
  | 'NEGATE_CONDITIONAL'
  /** `===` → `!==`. The comparison answers the opposite question. */
  | 'INVERT_EQUALITY'
  /** `throw new Error(...)` removed. The validation stops rejecting. */
  | 'REMOVE_VALIDATION'
  /** `true` → `false` on a literal the behaviour hinges on. */
  | 'FLIP_BOOLEAN'
  /** A constant the test's own assertion depends on. */
  | 'CHANGE_CONSTANT'
  /** `>` → `>=`. An off-by-one at the boundary. */
  | 'SWAP_BOUNDARY'
  /** `&&` → `||`. One condition stops being required. */
  | 'FLIP_LOGICAL'
  /** `+` → `-` in a computation the test asserts a number from. */
  | 'SWAP_ARITHMETIC';

export const DECISIVE_OPERATORS: readonly MutationOperator[] = [
  'NEGATE_CONDITIONAL',
  'INVERT_EQUALITY',
  'REMOVE_VALIDATION',
  'FLIP_BOOLEAN',
  'CHANGE_CONSTANT',
];

export function isDecisive(operator: MutationOperator): boolean {
  return DECISIVE_OPERATORS.includes(operator);
}

/**
 * One mutation, described precisely enough to apply without a parser.
 *
 * `start`/`end` are character offsets into the exact `code` the mutant was
 * generated from, and `original` is the text that must still be at those
 * offsets. The runner refuses to apply a mutant whose `original` no longer
 * matches rather than writing a corrupted file — a stale offset editing
 * someone's source is the one bug in this design that could lose work.
 */
export interface Mutant {
  id: string;
  operator: MutationOperator;
  /** Workspace-relative path of the source file. */
  filePath: string;
  /** 1-based line, for the report. */
  line: number;
  start: number;
  end: number;
  original: string;
  replacement: string;
  /** What this change does, in a developer's words: "computes the total with `-` instead of `+`". */
  describes: string;
  /** The assertion that would have noticed. The actionable half of a survivor. */
  wouldBeCaughtBy: string;
  /** Why this mutation was considered relevant to this test, and how strongly. */
  relevance: { score: number; because: string[] };
}

/** What one trial concluded. */
export interface MutantTrial {
  /**
   * KILLED  — the test FAILED with the mutant applied. The behaviour is really asserted.
   * SURVIVED — the test still passed. It did not notice.
   * INCONCLUSIVE — no verdict: the mutant did not compile, the harness never ran
   *   the test, the run timed out, the file had changed. Deliberately not folded
   *   into either side: a non-zero exit from a compile error is a FALSE KILL, and
   *   a false kill admits a worthless test with a certificate.
   */
  outcome: 'KILLED' | 'SURVIVED' | 'INCONCLUSIVE';
  /** Required for INCONCLUSIVE: what stopped the trial from answering. */
  why?: string | null;
  durationMs?: number | null;
}

/** What the gate needs the runner to be able to do. The worker supplies it. */
export interface MutationCapability {
  /**
   * Apply one mutation to the source under test, run ONLY this test against it,
   * and report whether the test failed (the mutant was killed).
   */
  trial(input: { mutant: Mutant; code: string; filePath: string }): Promise<MutantTrial>;
}

export interface MutationGateSource {
  /** Workspace-relative path. */
  filePath: string;
  code: string;
}

export interface MutationGateInput {
  /** The generated test under admission. `code` is what it claims; we test the claim. */
  test: { name?: string | null; filePath?: string | null; code: string };
  /**
   * The source files the test exercises, most likely first. Identifying these is
   * the caller's job (the generator knows which plan item and which route it
   * wrote the test for); the gate will not guess, because mutating a file the
   * test never reaches is how this gate would start producing survivors that
   * prove nothing.
   */
  sources: MutationGateSource[];
  /** Absent or null means UNAVAILABLE. It never means PASS. */
  capability?: MutationCapability | null;
  /**
   * Whether the test passes against UNMUTATED source.
   *
   * This matters more than it looks. If the test already fails, every mutant
   * "kills" it and the gate certifies a broken test as rigorously asserted —
   * the single worst output this module could produce. So anything other than
   * PASSING is UNAVAILABLE. The worker establishes this with one run before the
   * first trial (`runSingleTest` in the runner's mutation plugin).
   */
  baseline?: 'PASSING' | 'FAILING' | 'UNKNOWN' | null;
  /** Candidates from a real mutation engine, if the caller has one. Otherwise generated here. */
  mutants?: Mutant[] | null;
  /** Lower only. Capped at {@link MUTATION_GATE_MAX_TRIALS}. */
  maxTrials?: number | null;
}

/**
 * The admission report's own gate shape, imported rather than restated.
 *
 * `admission.ts` already owns this contract (`gate: GateId`, one of which is
 * `'MUTATION'`), and a second declaration of the same name in the same package
 * is how two gates end up with two subtly different ideas of what WARN means.
 * Type-only import: no runtime coupling, and `admission.ts` does not import
 * this module, so there is no cycle.
 */
export type { GateOutcome } from './admission.js';

/** This gate's outcome: an admission `GateOutcome` already narrowed to MUTATION. */
export type MutationGateOutcome = GateOutcome & { gate: 'MUTATION' };

// ─── Masking: never mutate a comment, a string's contents, or a regex ────────

interface StringLiteral {
  /** Offset of the opening quote. */
  start: number;
  /** Offset just past the closing quote. */
  end: number;
  /** The raw text between the quotes. */
  value: string;
  quote: string;
}

export interface MaskedSource {
  /**
   * `code` with every comment body, string body and regex body replaced by
   * spaces, offsets and newlines preserved. Every pattern below runs against
   * THIS, so an operator inside a comment, a message or a character class is
   * never mutated — mutating `/^[^>]+$/` or the `>` in a help string produces a
   * mutant that proves nothing and a survivor that insults the reader.
   */
  masked: string;
  strings: StringLiteral[];
}

/** True when a `/` at this offset starts a regex literal rather than a division. */
function regexStartsHere(masked: string, at: number): boolean {
  for (let i = at - 1; i >= 0; i -= 1) {
    const ch = masked[i];
    if (ch === undefined) return true;
    if (ch === ' ' || ch === '\t') continue;
    if (ch === '\n') return true;
    // After a value, `/` is division. After an operator or an opener, a regex.
    if (/[A-Za-z0-9_$)\]]/.test(ch)) {
      // `return /x/` and `typeof /x/` are the keyword exceptions.
      const before = masked.slice(Math.max(0, i - 10), i + 1);
      return /\b(return|typeof|case|in|of|delete|void)$/.test(before);
    }
    return true;
  }
  return true;
}

/**
 * Blanks out everything that is not executable code, preserving every offset.
 *
 * Offsets are preserved rather than stripped because a mutant is applied by
 * offset into the ORIGINAL text: a mask that shifted positions would hand the
 * runner an edit that lands in the wrong place, and the runner's `original`
 * check would then turn every mutant into an INCONCLUSIVE trial.
 */
export function maskNonCode(code: string): MaskedSource {
  const strings: StringLiteral[] = [];
  let out = '';
  let i = 0;
  const n = code.length;
  const blank = (text: string): string => text.replace(/[^\n]/g, ' ');

  while (i < n) {
    const ch = code[i] as string;
    const next = code[i + 1];

    if (ch === '/' && next === '/') {
      const nl = code.indexOf('\n', i);
      const stop = nl === -1 ? n : nl;
      out += blank(code.slice(i, stop));
      i = stop;
      continue;
    }

    if (ch === '/' && next === '*') {
      const close = code.indexOf('*/', i + 2);
      const stop = close === -1 ? n : close + 2;
      out += blank(code.slice(i, stop));
      i = stop;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const start = i;
      let value = '';
      i += 1;
      let closed = false;
      while (i < n) {
        const c = code[i] as string;
        if (c === '\\') {
          value += c + (code[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (c === ch) {
          i += 1;
          closed = true;
          break;
        }
        // An unterminated quote must not swallow the rest of the file.
        if (c === '\n' && ch !== '`') break;
        value += c;
        i += 1;
      }
      const end = i;
      // Quote characters survive the mask so a constant's bounds stay findable.
      out += ch + blank(code.slice(start + 1, closed ? end - 1 : end)) + (closed ? ch : '');
      if (closed) strings.push({ start, end, value, quote: ch });
      continue;
    }

    if (ch === '/' && regexStartsHere(out, out.length)) {
      // Scan to the closing `/`, respecting escapes and character classes.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const c = code[j] as string;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (closed) {
        out += '/' + blank(code.slice(i + 1, j - 1)) + '/';
        i = j;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return { masked: out, strings };
}

function lineOf(code: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < code.length; i += 1) {
    if (code[i] === '\n') line += 1;
  }
  return line;
}

function lineTextAt(code: string, offset: number): string {
  const from = code.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const to = code.indexOf('\n', offset);
  return code.slice(from, to === -1 ? code.length : to).trim();
}

function clip(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ─── What the test claims to assert ──────────────────────────────────────────

/**
 * Words too common to carry a connection between a test and a source file. A
 * relevance match on "page" or "data" is not a match.
 */
const STOPWORDS = new Set([
  'test',
  'tests',
  'expect',
  'await',
  'async',
  'const',
  'page',
  'data',
  'value',
  'result',
  'should',
  'with',
  'that',
  'this',
  'from',
  'then',
  'when',
  'true',
  'false',
  'null',
  'name',
  'type',
  'click',
  'goto',
  'fill',
  'visible',
  'text',
  'have',
  'toBe',
  'json',
  'http',
  'https',
  'localhost',
  'describe',
]);

const ASSERTION_LINE = /\bexpect\s*\(|\bassert\b|\.should\b|Assert\.|\bverify\s*\(|\btoHave[A-Z]/;

/** Phrases that mean "this test claims to exercise a rejection path". */
const ERROR_CLAIM =
  /(required|invalid|must\s|cannot|can't|not\s+found|unauthor|forbidden|denied|too\s+(short|long|many)|already\s+(exists|taken|used)|error|fail|reject|refus|duplicate|expired|missing)/i;

/** Words that mean "this test claims a computed number". */
const NUMBER_CLAIM =
  /(total|subtotal|sum|price|amount|count|quantity|tax|fee|discount|balance|score|points|credits|minutes|seats)/i;

export interface TestClaims {
  /** String literals the test ASSERTS on. The strongest relevance signal there is. */
  assertedStrings: string[];
  /** Numbers the test asserts on. */
  assertedNumbers: string[];
  /** Identifier-ish words anywhere in the test, plus its name. */
  words: Set<string>;
  assertsError: boolean;
  assertsNumber: boolean;
  /** 1-based line numbers of the test's assertions, with their text. */
  assertionLines: Array<{ line: number; text: string }>;
}

function words(text: string): string[] {
  return (text.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? [])
    .filter((w) => !STOPWORDS.has(w) && !STOPWORDS.has(w.toLowerCase()))
    .map((w) => w.toLowerCase());
}

/**
 * Reads what the test says it checks.
 *
 * String-and-offset level, not AST level, and for the same reason the rest of
 * this package is: `code` is whatever the generator, the importer or a human
 * last wrote, including files that do not parse, and a gate that throws on an
 * unparseable test would refuse admission for the wrong reason.
 */
export function extractClaims(test: MutationGateInput['test']): TestClaims {
  const { masked, strings } = maskNonCode(test.code);
  const assertedStrings: string[] = [];
  const assertedNumbers: string[] = [];
  const assertionLines: Array<{ line: number; text: string }> = [];

  // Detection reads the MASKED text, so an `expect(` inside a comment or a
  // string is not counted as an assertion. The text KEPT is the original line:
  // the assertion's literals are what connect it to a mutant, and a masked line
  // has none of them — which is why `blameLine` used to point at nothing.
  const maskedLines = masked.split('\n');
  const originalLines = test.code.split('\n');
  const assertingLineNumbers = new Set<number>();
  maskedLines.forEach((maskedText, index) => {
    if (!ASSERTION_LINE.test(maskedText)) return;
    assertingLineNumbers.add(index + 1);
    assertionLines.push({ line: index + 1, text: (originalLines[index] ?? maskedText).trim() });
    // Numbers from the masked line only: these are code literals, the kind a
    // source constant can be compared against. Numbers that are really text
    // (`toHaveText('90')`) arrive below, through the string literals.
    for (const raw of maskedText.match(/\b\d+(?:\.\d+)?\b/g) ?? []) assertedNumbers.push(raw);
  });

  for (const literal of strings) {
    const line = lineOf(test.code, literal.start);
    if (!assertingLineNumbers.has(line)) continue;
    const value = literal.value.trim();
    // A one-character literal is a separator, not a claim.
    if (value.length < 2) continue;
    assertedStrings.push(value);
    // `toHaveText('90')` asserts a number that happens to arrive as text.
    if (/^\d+(?:\.\d+)?$/.test(value)) assertedNumbers.push(value);
  }

  const all = `${test.name ?? ''} ${test.filePath ?? ''} ${test.code}`;
  const assertedText = [...assertedStrings, ...assertionLines.map((l) => l.text)].join(' ');

  return {
    assertedStrings,
    assertedNumbers,
    words: new Set([...words(all), ...strings.flatMap((s) => words(s.value))]),
    assertsError: ERROR_CLAIM.test(`${test.name ?? ''} ${assertedText}`),
    assertsNumber:
      assertedNumbers.length > 0 || NUMBER_CLAIM.test(`${test.name ?? ''} ${assertedText}`),
    assertionLines,
  };
}

// ─── Candidate generation ────────────────────────────────────────────────────

interface Candidate {
  operator: MutationOperator;
  start: number;
  end: number;
  replacement: string;
  describes: (original: string) => string;
  wouldBeCaughtBy: string;
}

/** The enclosing `function`/`const x = (` name above an offset, for relevance. */
function enclosingName(masked: string, offset: number): string | null {
  const before = masked.slice(0, offset);
  const patterns = [
    /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(/g,
    /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=\s*)?(?:async\s*)?\([^)]*\)\s*\{/g,
  ];
  let best: { name: string; at: number } | null = null;
  for (const pattern of patterns) {
    for (const match of before.matchAll(pattern)) {
      const name = match[1];
      if (name === undefined) continue;
      const at = match.index ?? 0;
      if (!best || at > best.at) best = { name, at };
    }
  }
  return best?.name ?? null;
}

/** Scans forward from `openParen` to its matching `)`. -1 when unbalanced. */
function matchParen(masked: string, openParen: number): number {
  let depth = 0;
  for (let i = openParen; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const EQUALITY_FLIP: Record<string, string> = {
  '===': '!==',
  '!==': '===',
  '==': '!=',
  '!=': '==',
};

const BOUNDARY_FLIP: Record<string, string> = {
  '>': '>=',
  '>=': '>',
  '<': '<=',
  '<=': '<',
};

const ARITHMETIC_FLIP: Record<string, string> = {
  '+': '-',
  '-': '+',
  '*': '/',
  '/': '*',
};

const LOGICAL_FLIP: Record<string, string> = {
  '&&': '||',
  '||': '&&',
};

/**
 * Every operator mutation requires WHITESPACE on both sides.
 *
 * That looks like a formatting dependency and is in fact a compile-error guard:
 * `Array<string>`, `<div>`, `a<b>(c)` and `=>` all contain `<` or `>` with no
 * surrounding spaces, and mutating one of them produces source that does not
 * parse. A mutant that does not compile makes the test fail for a reason that
 * has nothing to do with its assertions — a FALSE KILL, which is the one
 * outcome worse than no check at all. Spaced operators are what both Prettier
 * and every generator in this repo emit, so the cost is a handful of
 * unconventionally-formatted candidates skipped.
 */
function operatorCandidates(masked: string, claims: TestClaims): Candidate[] {
  const out: Candidate[] = [];

  for (const match of masked.matchAll(/(\S)\s(===|!==|==|!=|>=|<=|>|<)\s/g)) {
    const prev = match[1] ?? '';
    const op = match[2];
    if (op === undefined) continue;
    // `a => b`, `x <<= 1`: the char before the space is part of the operator.
    if (/[=!<>&|+\-*/%^~]/.test(prev)) continue;
    const start = (match.index ?? 0) + 2;

    const flipped = EQUALITY_FLIP[op];
    if (flipped !== undefined) {
      out.push({
        operator: 'INVERT_EQUALITY',
        start,
        end: start + op.length,
        replacement: flipped,
        describes: () => `the comparison \`${op}\` answers the opposite question (\`${flipped}\`)`,
        wouldBeCaughtBy: 'an assertion on the value or the outcome this comparison decides',
      });
      continue;
    }

    const bounded = BOUNDARY_FLIP[op];
    if (bounded !== undefined) {
      out.push({
        operator: 'SWAP_BOUNDARY',
        start,
        end: start + op.length,
        replacement: bounded,
        describes: () => `the boundary moves by one: \`${op}\` becomes \`${bounded}\``,
        wouldBeCaughtBy: 'a case AT the boundary value, where the two comparisons differ',
      });
    }
  }

  for (const match of masked.matchAll(/(\S)\s(&&|\|\|)\s/g)) {
    const op = match[2];
    if (op === undefined) continue;
    const flipped = LOGICAL_FLIP[op];
    if (flipped === undefined) continue;
    const start = (match.index ?? 0) + 2;
    out.push({
      operator: 'FLIP_LOGICAL',
      start,
      end: start + op.length,
      replacement: flipped,
      describes: () => `\`${op}\` becomes \`${flipped}\`, so one condition stops being required`,
      wouldBeCaughtBy: 'a case where only one of the two conditions holds',
    });
  }

  // Arithmetic only when the test claims a computed number. Without that claim
  // an arithmetic survivor says nothing about the test — it says the test was
  // never about arithmetic — and reporting it would be the gate lying.
  if (claims.assertsNumber) {
    for (const match of masked.matchAll(/(\S)\s([+\-*/])\s/g)) {
      const prev = match[1] ?? '';
      const op = match[2];
      if (op === undefined) continue;
      if (/[=+\-*/%<>!&|]/.test(prev)) continue;
      const start = (match.index ?? 0) + 2;
      const flipped = ARITHMETIC_FLIP[op];
      if (flipped === undefined) continue;
      out.push({
        operator: 'SWAP_ARITHMETIC',
        start,
        end: start + op.length,
        replacement: flipped,
        describes: () => `the value is computed with \`${flipped}\` instead of \`${op}\``,
        wouldBeCaughtBy: 'an assertion on the exact computed number, not just that it is present',
      });
    }
  }

  return out;
}

function conditionalCandidates(masked: string): Candidate[] {
  const out: Candidate[] = [];
  // `while` and `for` are deliberately excluded: inverting a loop guard usually
  // produces an infinite loop, the trial times out, and a timeout is not
  // evidence about an assertion.
  for (const match of masked.matchAll(/\bif\s*\(/g)) {
    const open = masked.indexOf('(', match.index ?? 0);
    if (open === -1) continue;
    const close = matchParen(masked, open);
    if (close === -1 || close - open < 2) continue;
    out.push({
      operator: 'NEGATE_CONDITIONAL',
      start: open + 1,
      end: close,
      replacement: '',
      describes: (original) => `the guard \`if (${clip(original, 60)})\` is inverted`,
      wouldBeCaughtBy: 'an assertion on what happens on each side of this branch',
    });
  }
  return out;
}

function validationCandidates(masked: string): Candidate[] {
  const out: Candidate[] = [];
  for (const match of masked.matchAll(/\bthrow\b[^;{}]*;/g)) {
    const start = match.index ?? 0;
    out.push({
      operator: 'REMOVE_VALIDATION',
      start,
      end: start + (match[0]?.length ?? 0),
      // `void 0;` keeps the statement position valid in every JS/TS context.
      replacement: 'void 0;',
      describes: () => 'the validation stops rejecting — the error is never thrown',
      wouldBeCaughtBy:
        'an assertion that the rejection happened (the message, the status, the refusal)',
    });
  }
  return out;
}

function booleanCandidates(masked: string): Candidate[] {
  const out: Candidate[] = [];
  for (const match of masked.matchAll(/(?<![.\w$])(true|false)(?![\w$])/g)) {
    const literal = match[1];
    if (literal === undefined) continue;
    const start = match.index ?? 0;
    const flipped = literal === 'true' ? 'false' : 'true';
    out.push({
      operator: 'FLIP_BOOLEAN',
      start,
      end: start + literal.length,
      replacement: flipped,
      describes: () => `the literal \`${literal}\` becomes \`${flipped}\``,
      wouldBeCaughtBy: 'an assertion on the behaviour this flag selects',
    });
  }
  return out;
}

/**
 * Constants the test's own assertions depend on.
 *
 * This is the highest-value operator in the set and the only one generated from
 * the TEST rather than from the source: when a source literal is a string the
 * test asserts on, changing it is guaranteed-relevant, cannot be an equivalent
 * mutant, and a survivor means the test's assertion is not actually reached.
 */
function constantCandidates(
  masked: string,
  strings: StringLiteral[],
  claims: TestClaims,
): Candidate[] {
  const out: Candidate[] = [];
  const asserted = claims.assertedStrings.map((s) => s.toLowerCase());

  for (const literal of strings) {
    const value = literal.value.trim();
    if (value.length < 3) continue;
    const lower = value.toLowerCase();
    /**
     * Equality, or containment of a phrase long enough to mean something.
     *
     * The 8-character floor is a defect fix, not a tuning knob. With a loose
     * substring rule, a test asserting `getByTestId('total')` made the source
     * literal `'total >= limit'` — a log label — the single highest-ranked
     * mutant in the file, purely because it contains the word "total". That
     * mutant survives every possible test, and a gate that reports it is
     * accusing a good test of asserting nothing.
     */
    const hit = asserted.find(
      (a) =>
        a === lower ||
        (a.length >= 8 && lower.includes(a)) ||
        (lower.length >= 8 && a.includes(lower)),
    );
    if (hit === undefined) continue;
    out.push({
      operator: 'CHANGE_CONSTANT',
      start: literal.start,
      end: literal.end,
      replacement: `${literal.quote}qaai-mutated${literal.quote}`,
      describes: () => `the text the test asserts on (\`${clip(value, 60)}\`) is changed`,
      wouldBeCaughtBy: 'the assertion on this text — reached, and comparing the real value',
    });
  }

  if (claims.assertedNumbers.length > 0) {
    const assertedNumbers = new Set(claims.assertedNumbers);
    for (const match of masked.matchAll(/(?<![\w$.])(\d+(?:\.\d+)?)(?![\w$.])/g)) {
      const raw = match[1];
      if (raw === undefined || !assertedNumbers.has(raw)) continue;
      const start = match.index ?? 0;
      const bumped = String(Number(raw) + 1);
      out.push({
        operator: 'CHANGE_CONSTANT',
        start,
        end: start + raw.length,
        replacement: bumped,
        describes: () => `the number the test asserts on (\`${raw}\`) becomes \`${bumped}\``,
        wouldBeCaughtBy: 'the assertion on this number',
      });
    }
  }

  return out;
}

const OPERATOR_WEIGHT: Record<MutationOperator, number> = {
  CHANGE_CONSTANT: 5,
  NEGATE_CONDITIONAL: 2,
  INVERT_EQUALITY: 2,
  REMOVE_VALIDATION: 1,
  FLIP_BOOLEAN: 1,
  SWAP_BOUNDARY: 1,
  FLIP_LOGICAL: 1,
  SWAP_ARITHMETIC: 1,
};

/** Trial order within the same score. Decisive and cheap-to-interpret first. */
const OPERATOR_PRIORITY: MutationOperator[] = [
  'CHANGE_CONSTANT',
  'NEGATE_CONDITIONAL',
  'INVERT_EQUALITY',
  'REMOVE_VALIDATION',
  'FLIP_BOOLEAN',
  'FLIP_LOGICAL',
  'SWAP_BOUNDARY',
  'SWAP_ARITHMETIC',
];

export function isSupportedSource(filePath: string): boolean {
  return MUTATION_GATE_SUPPORTED_EXTENSIONS.some((ext) => filePath.toLowerCase().endsWith(ext));
}

/**
 * Generates the relevant mutants for one test, ranked, with the irrelevant ones
 * dropped and the reason recorded on the ones that survive the filter.
 */
export function proposeMutants(sources: MutationGateSource[], claims: TestClaims): Mutant[] {
  const mutants: Mutant[] = [];

  for (const source of sources.slice(0, MUTATION_GATE_MAX_SOURCE_FILES)) {
    if (!isSupportedSource(source.filePath)) continue;
    if (source.code.length > MUTATION_GATE_MAX_SOURCE_CHARS) continue;

    const { masked, strings } = maskNonCode(source.code);
    const fileWords = new Set(words(source.filePath));
    const fileNameHit = [...fileWords].some((w) => claims.words.has(w));

    const candidates = [
      ...constantCandidates(masked, strings, claims),
      ...conditionalCandidates(masked),
      ...operatorCandidates(masked, claims),
      ...validationCandidates(masked),
      ...booleanCandidates(masked),
    ].slice(0, MUTATION_GATE_MAX_CANDIDATES);

    for (const candidate of candidates) {
      const original = source.code.slice(candidate.start, candidate.end);
      if (original.length === 0) continue;

      const because: string[] = [];
      let score = OPERATOR_WEIGHT[candidate.operator];

      if (candidate.operator === 'CHANGE_CONSTANT') {
        because.push("the test's own assertion depends on this constant");
      }

      // Relevance reads the ORIGINAL line, not the masked one. The masking
      // exists to stop a mutation landing inside a string — but a string is
      // exactly where the connection to the test usually lives: the validation
      // message the test asserts on is the strongest signal there is, and a
      // masked line would hide it and drop the most relevant mutant in the file.
      const lineText = lineTextAt(source.code, candidate.start);
      const shared = words(lineText).filter((w) => claims.words.has(w));
      if (shared.length > 0) {
        score += 3;
        because.push(`the test names \`${shared.slice(0, 3).join('`, `')}\``);
      }

      const owner = enclosingName(masked, candidate.start);
      if (owner !== null && claims.words.has(owner.toLowerCase())) {
        score += 3;
        because.push(`it is inside \`${owner}\`, which the test exercises by name`);
      }

      if (fileNameHit) {
        score += 1;
        because.push(`the test refers to \`${source.filePath}\``);
      }

      if (candidate.operator === 'REMOVE_VALIDATION' && claims.assertsError) {
        score += 3;
        because.push('the test claims to assert a rejection');
      }
      if (candidate.operator === 'NEGATE_CONDITIONAL' && claims.assertsError) {
        score += 2;
        because.push('the test claims to assert a rejection');
      }
      if (candidate.operator === 'SWAP_BOUNDARY' && claims.assertsNumber) {
        score += 1;
        because.push('the test claims a computed number');
      }
      if (candidate.operator === 'SWAP_ARITHMETIC' && claims.assertsNumber) {
        score += 2;
        because.push('the test claims a computed number');
      }

      if (score < MUTATION_GATE_MIN_RELEVANCE) continue;

      const replacement =
        candidate.operator === 'NEGATE_CONDITIONAL' ? `!(${original})` : candidate.replacement;

      const line = lineOf(source.code, candidate.start);
      mutants.push({
        id: `${candidate.operator}@${source.filePath}:${line}:${candidate.start}`,
        operator: candidate.operator,
        filePath: source.filePath,
        line,
        start: candidate.start,
        end: candidate.end,
        original,
        replacement,
        describes: candidate.describes(original),
        wouldBeCaughtBy: candidate.wouldBeCaughtBy,
        relevance: { score, because },
      });
    }
  }

  return mutants.sort(
    (a, b) =>
      b.relevance.score - a.relevance.score ||
      OPERATOR_PRIORITY.indexOf(a.operator) - OPERATOR_PRIORITY.indexOf(b.operator) ||
      a.filePath.localeCompare(b.filePath) ||
      a.start - b.start,
  );
}

/**
 * Picks the trial order under the budget.
 *
 * Two mutants on the same line test the same assertion twice, and five mutants
 * from one operator test one kind of blindness — either way the budget buys
 * less information than it could. So: at most one per line, at most two per
 * operator, most-relevant first, and a second relaxed pass only if that leaves
 * the budget unspent.
 */
export function orderTrials(mutants: Mutant[], budget: number): Mutant[] {
  const chosen: Mutant[] = [];
  const lines = new Set<string>();
  const perOperator = new Map<MutationOperator, number>();

  for (const mutant of mutants) {
    if (chosen.length >= budget) break;
    const lineKey = `${mutant.filePath}:${mutant.line}`;
    if (lines.has(lineKey)) continue;
    if ((perOperator.get(mutant.operator) ?? 0) >= 2) continue;
    chosen.push(mutant);
    lines.add(lineKey);
    perOperator.set(mutant.operator, (perOperator.get(mutant.operator) ?? 0) + 1);
  }

  for (const mutant of mutants) {
    if (chosen.length >= budget) break;
    if (chosen.some((c) => c.id === mutant.id)) continue;
    const lineKey = `${mutant.filePath}:${mutant.line}`;
    if (lines.has(lineKey)) continue;
    chosen.push(mutant);
    lines.add(lineKey);
  }

  return chosen;
}

// ─── The gate ────────────────────────────────────────────────────────────────

function unavailable(why: string, detail: string[] = []): MutationGateOutcome {
  return { gate: 'MUTATION', status: 'UNAVAILABLE', why, detail, line: null };
}

/**
 * The test line a developer should look at: the assertion closest to what the
 * survivor changed.
 *
 * Best match, not first match. A survivor that changed a specific literal
 * belongs to the assertion that mentions that literal, and returning the first
 * assertion that shares any word with it sends the reader to the wrong line —
 * which is worse than sending them nowhere, because they will trust it.
 */
function blameLine(claims: TestClaims, survivor: Mutant | undefined): number | null {
  if (survivor === undefined) return null;

  const literal = survivor.original
    .replace(/^['"`]/, '')
    .replace(/['"`]$/, '')
    .trim()
    .toLowerCase();
  if (literal.length >= 4) {
    for (const assertion of claims.assertionLines) {
      if (assertion.text.toLowerCase().includes(literal)) return assertion.line;
    }
  }

  const needles = [
    ...words(survivor.original),
    ...survivor.relevance.because.flatMap((reason) => words(reason)),
  ].filter((n) => n.length > 3);

  let best: { line: number; hits: number } | null = null;
  for (const assertion of claims.assertionLines) {
    const text = assertion.text.toLowerCase();
    const hits = needles.filter((n) => text.includes(n)).length;
    if (hits > 0 && (best === null || hits > best.hits)) best = { line: assertion.line, hits };
  }
  return best?.line ?? null;
}

function where(mutant: Mutant): string {
  return `${mutant.filePath}:${mutant.line}`;
}

/**
 * Admits a generated test only if it has been shown to FAIL when the behaviour
 * it claims to test is broken.
 *
 * THE BAR, AND WHY IT IS ASYMMETRIC
 *
 * Zero kills is categorically different from a low ratio. A test that notices
 * none of the decisive changes to the code path it walks is provably worthless:
 * it is green now and it will be green through the regression. There is no
 * reading of that result under which the test is worth keeping, so it is a FAIL
 * and it is not admitted.
 *
 * One kill is a different animal. It is proof the test is not vacuous — it does
 * fail when something real breaks. A test that kills one of four is weaker than
 * we would like and better than most of what is in production, so it is
 * admitted with a WARN and the survivors attached, because the survivor list is
 * the cleanest possible input to the next generation attempt: "add an assertion
 * that would notice THIS".
 *
 * Above {@link MUTATION_GATE_PASS_RATIO} it is a PASS, with any survivors still
 * listed. A gate that hides the remaining holes because the number cleared the
 * bar teaches people the number is the goal.
 *
 * The one place the asymmetry is softened: if nothing was killed but every
 * survivor is a BOUNDARY mutant, the verdict is WARN, not FAIL. `price > 100`
 * becoming `price >= 100` is invisible to a test whose fixture is 250, and that
 * test is not asserting nothing — it is merely not a boundary test. FAIL there
 * would be a false accusation, and a gate that makes those gets turned off.
 */
export async function mutationGate(input: MutationGateInput): Promise<MutationGateOutcome> {
  const capability = input.capability ?? null;
  if (capability === null) {
    return unavailable(
      'no mutation capability was supplied, so this test was admitted WITHOUT a mutation check',
      [
        "The worker injects the capability (`runFocusedMutantTrial` in the runner's mutation plugin).",
        'This is not a pass: nothing was mutated and nothing was proven about this test.',
      ],
    );
  }

  const sources = (input.sources ?? []).filter((s) => s.code.trim() !== '');
  if (sources.length === 0) {
    return unavailable('no source file under test was identified, so there was nothing to mutate', [
      'The caller supplies the files the test exercises; the gate will not guess, because mutating code the test never reaches produces survivors that prove nothing.',
    ]);
  }

  const unsupported = sources.filter((s) => !isSupportedSource(s.filePath));
  if (unsupported.length === sources.length) {
    return unavailable(
      `mutation operators are not implemented for ${unsupported
        .map((s) => s.filePath.slice(s.filePath.lastIndexOf('.')))
        .filter((ext, i, all) => all.indexOf(ext) === i)
        .join(', ')} — the test was not checked`,
      [
        `Supported here: ${MUTATION_GATE_SUPPORTED_EXTENSIONS.join(', ')}.`,
        'Mutating with the wrong grammar produces source that does not compile, and a test that fails to compile looks exactly like a test that caught something.',
      ],
    );
  }

  const baseline = input.baseline ?? 'UNKNOWN';
  if (baseline !== 'PASSING') {
    return unavailable(
      baseline === 'FAILING'
        ? 'the test does not pass against unmutated source, so a mutation result would be meaningless'
        : 'the test was not verified to pass against unmutated source, so a mutation result would be meaningless',
      [
        'Every mutant "kills" a test that was already failing, which would certify a broken test as rigorously asserted.',
        'Run the test once unmutated first (`runSingleTest`), then pass baseline: "PASSING".',
      ],
    );
  }

  const claims = extractClaims(input.test);
  const candidates = input.mutants ?? proposeMutants(sources, claims);
  const relevant = candidates.filter(
    (m) => (m.relevance?.score ?? MUTATION_GATE_MIN_RELEVANCE) >= MUTATION_GATE_MIN_RELEVANCE,
  );

  if (relevant.length === 0) {
    return unavailable(
      `no mutation relevant to what this test asserts could be found in ${sources
        .map((s) => s.filePath)
        .slice(0, 3)
        .join(', ')}`,
      [
        'Candidate mutations existed but none connected to a literal the test asserts, an identifier it names, or a rejection it claims — mutating them would produce a survivor that says nothing about this test.',
        'Either the wrong source file was supplied, or the test asserts nothing specific enough to mutate against. Both are worth a look; neither is a pass.',
      ],
    );
  }

  const budget = Math.max(
    1,
    Math.min(input.maxTrials ?? MUTATION_GATE_MAX_TRIALS, MUTATION_GATE_MAX_TRIALS),
  );
  const plan = orderTrials(relevant, budget);

  const killed: Mutant[] = [];
  const survived: Mutant[] = [];
  const inconclusive: Array<{ mutant: Mutant; why: string }> = [];
  let stopped: string | null = null;
  const codeByPath = new Map(sources.map((s) => [s.filePath, s.code] as const));

  for (const mutant of plan) {
    const code = codeByPath.get(mutant.filePath);
    if (code === undefined) {
      inconclusive.push({ mutant, why: 'the source text for this file was not supplied' });
      continue;
    }

    let trial: MutantTrial;
    try {
      trial = await capability.trial({ mutant, code, filePath: mutant.filePath });
    } catch (err) {
      // A capability that throws is an environment problem, never evidence
      // about the test. Swallowing it as a pass is the defect this catch exists
      // to prevent; rethrowing would lose the other trials' results.
      trial = {
        outcome: 'INCONCLUSIVE',
        why: err instanceof Error ? err.message : String(err),
      };
    }

    if (trial.outcome === 'KILLED') killed.push(mutant);
    else if (trial.outcome === 'SURVIVED') survived.push(mutant);
    else inconclusive.push({ mutant, why: trial.why?.trim() || 'the trial produced no verdict' });

    if (killed.length >= MUTATION_GATE_SETTLE_KILLS) {
      stopped = `stopped after ${killed.length} kills`;
      break;
    }
    const decisiveSurvivors = survived.filter((m) => isDecisive(m.operator));
    if (killed.length === 0 && decisiveSurvivors.length >= MUTATION_GATE_SETTLE_SURVIVORS) {
      stopped = `stopped after ${decisiveSurvivors.length} unnoticed changes with no kill`;
      break;
    }
    if (inconclusive.length >= MUTATION_GATE_MAX_INCONCLUSIVE) {
      stopped = `stopped after ${inconclusive.length} trials that produced no verdict`;
      break;
    }
  }

  const conclusive = killed.length + survived.length;
  const untried = plan.length - (conclusive + inconclusive.length);
  const notTrialled = relevant.length - plan.length;

  const detail: string[] = [];

  // The survivor is the product: what change went unnoticed, and the assertion
  // that would have caught it. Written to be pasted into the next generation
  // attempt, so it names the change in behaviour and never just the operator.
  for (const mutant of survived) {
    detail.push(
      `${where(mutant)} — the test still passes when ${mutant.describes}. Add: ${mutant.wouldBeCaughtBy}.`,
    );
  }
  for (const mutant of killed) {
    detail.push(`killed ${where(mutant)} — the test failed when ${mutant.describes}.`);
  }
  for (const entry of inconclusive) {
    detail.push(`no verdict at ${where(entry.mutant)} — ${entry.why}.`);
  }
  if (stopped !== null) {
    detail.push(
      `${stopped}; ${untried} planned ${untried === 1 ? 'trial was' : 'trials were'} not run (trial cap ${budget}).`,
    );
  }
  if (notTrialled > 0) {
    detail.push(
      `${notTrialled} further relevant ${notTrialled === 1 ? 'mutation was' : 'mutations were'} found and not tried — each trial is a full test execution, and the cap is ${budget}.`,
    );
  }

  if (conclusive === 0) {
    return unavailable(
      `no trial reached a verdict (${inconclusive.length} produced none), so this test was not checked`,
      detail,
    );
  }

  const ratio = killed.length / conclusive;
  const decisiveSurvivors = survived.filter((m) => isDecisive(m.operator));
  const line = blameLine(claims, survived[0]);
  const counted = `${killed.length} of ${conclusive} relevant ${
    conclusive === 1 ? 'mutation' : 'mutations'
  }`;

  if (killed.length === 0) {
    // Boundary-only survivors are a missing edge case, not an absent assertion.
    if (decisiveSurvivors.length === 0) {
      return {
        gate: 'MUTATION',
        status: 'WARN',
        why: `killed ${counted} — the survivors are all boundary cases the test never exercises, not missing assertions`,
        detail,
        line,
      };
    }
    return {
      gate: 'MUTATION',
      status: 'FAIL',
      why: `killed ${counted} — every change made to the behaviour this test claims to check still passed`,
      detail,
      line,
    };
  }

  if (ratio < MUTATION_GATE_PASS_RATIO) {
    return {
      gate: 'MUTATION',
      status: 'WARN',
      why: `killed ${counted} — it does fail when something real breaks, but missed ${survived.length}`,
      detail,
      line,
    };
  }

  return {
    gate: 'MUTATION',
    status: 'PASS',
    why:
      survived.length === 0
        ? `killed ${counted} — the test fails when the behaviour it asserts is broken`
        : `killed ${counted} — the test fails when the behaviour it asserts is broken (${survived.length} survivor${
            survived.length === 1 ? '' : 's'
          } listed)`,
    detail,
    line,
  };
}
